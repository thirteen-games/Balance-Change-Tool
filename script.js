"use strict";

// ============================================================
// Balance Change Tool — replicates the calculations from
// "PVE 600 ranked April26.xlsx" / sheet "win rates in ranked since bruis"
//
// Formula chain (per card, when wins W and losses L are pasted):
//   total       = W + L
//   winRate     = W / total
//   F1          = sum(W) / sum(total)                                 // overall win rate
//   winRate2    = winRate * 0.5 / F1                                  // normalized so 1.0 = average
//   pctPlayed   = total / sum(total)
//   H1          = median(total across all cards w/ data)
//   buffRating  = (total < H1 ? sqrt(H1-total) * 7 / sqrt(H1) : 0)
//                  + (winRate2 < 0.5 ? sqrt(0.5-winRate2) * 3 / sqrt(0.5) : 0)
//   S1          = max(total)
//   adjPlayed   = sqrt(total / S1) * S1            // sqrt shrinkage
//   adjWins     = W + (adjPlayed - total) * 0.5    // pull toward 50% win rate
//   R1          = sum(adjWins) / sum(adjPlayed)    // overall adjusted win rate
//   ovrRating   = ((adjWins/adjPlayed) * 0.5 / R1 - 0.4) / 0.02
// ============================================================

const CARDS_URL = "cards.json?v=" + (window.__CACHE_BUST || Date.now());

// ------------------------------------------------------------
// BigQuery / OAuth config
// ------------------------------------------------------------
const BQ_PROJECT_ID = "market-party-289715";
const BQ_DATASET = "nova_island_analytics_prod";
const BQ_TABLE = "match";
const OAUTH_CLIENT_ID = "193027998680-51vij006s136fds9fla21cada2pf181d.apps.googleusercontent.com";
const OAUTH_SCOPE = "https://www.googleapis.com/auth/bigquery.readonly";

let bqTokenClient = null;       // GIS token client
let bqAccessToken = null;       // current access token
let bqTokenExpiresAt = 0;       // ms epoch when token expires
let MASTER_CARDS = []; // [{name, class, type, cost}]
let MASTER_INDEX = new Map(); // lowercased name -> master card

const state = {
  results: [],            // analyzed rows
  unmatchedWins: [],      // names in wins paste not in master
  unmatchedLosses: [],    // names in losses paste not in master
  unpastedCards: [],      // master cards with zero wins+losses
  sort: { key: "buffRating", dir: "desc" },
  filters: {
    search: "",
    classes: new Set(),
    types: new Set(),
    costs: new Set(),
    hideZero: false,
  },
};

// ------------------------------------------------------------
// DOM
// ------------------------------------------------------------
const $ = (s) => document.querySelector(s);
const els = {
  // BigQuery panel
  bqStart: $("#bq-start"),
  bqEnd: $("#bq-end"),
  bqMinRating: $("#bq-min-rating"),
  bqHumanOnly: $("#bq-human-only"),
  bqSignin: $("#bq-signin-btn"),
  bqSignout: $("#bq-signout-btn"),
  bqRun: $("#bq-run-btn"),
  bqUser: $("#bq-user"),
  bqStatus: $("#bq-status"),
  bqSqlWins: $("#bq-sql-wins"),
  bqSqlLosses: $("#bq-sql-losses"),
  // Manual paste
  wins: $("#wins-input"),
  losses: $("#losses-input"),
  analyze: $("#analyze-btn"),
  sample: $("#sample-btn"),
  clear: $("#clear-btn"),
  status: $("#parse-status"),
  diagnostics: $("#diagnostics"),
  diagBody: $("#diagnostics-body"),
  // Results
  results: $("#results-panel"),
  summary: $("#summary"),
  aggregatesBody: $("#aggregates-body"),
  search: $("#search-input"),
  classFilters: $("#class-filters"),
  typeFilters: $("#type-filters"),
  costFilters: $("#cost-filters"),
  hideZero: $("#hide-zero-plays"),
  export: $("#export-btn"),
  thead: document.querySelector("#results-table thead"),
  tbody: document.querySelector("#results-table tbody"),
  rowCount: $("#row-count"),
};

// ------------------------------------------------------------
// Parsing pasted SQL output
// ------------------------------------------------------------

/**
 * Parse a paste block into [{name, count}, ...].
 * Each line: card name + numeric count, separated by tab, comma, pipe,
 * or 2+ spaces. Header lines (no number found) are skipped.
 */
function parsePaste(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // strip SQL client divider rows like "----+----"
    if (/^[-+=|\s]+$/.test(line)) continue;

    // Try splitting on tab, then pipe, then comma, then 2+ spaces.
    let parts;
    if (line.includes("\t")) parts = line.split("\t");
    else if (line.includes("|")) parts = line.split("|");
    else if (line.includes(",")) parts = line.split(",");
    else parts = line.split(/\s{2,}/);

    parts = parts.map((p) => p.trim()).filter((p) => p !== "");
    if (parts.length < 2) {
      // fall back to "last whitespace token" split
      const m = line.match(/^(.+?)\s+(\d[\d,]*)$/);
      if (m) parts = [m[1].trim(), m[2]];
      else continue;
    }

    // Identify the numeric column (usually last)
    const last = parts[parts.length - 1].replace(/,/g, "");
    const n = Number(last);
    if (!Number.isFinite(n)) continue; // skip header rows etc.

    const name = parts.slice(0, -1).join(" ").trim();
    if (!name) continue;
    out.push({ name, count: n });
  }
  return out;
}

function buildCountMap(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = r.name.toLowerCase();
    m.set(k, (m.get(k) || 0) + r.count);
  }
  return m;
}

// ------------------------------------------------------------
// Analysis (replicates the spreadsheet formulas)
// ------------------------------------------------------------

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function analyze(winsMap, lossesMap) {
  // 1. Join pasted counts to master list
  const joined = MASTER_CARDS.map((card) => {
    const k = card.name.toLowerCase();
    const wins = winsMap.get(k) || 0;
    const losses = lossesMap.get(k) || 0;
    const total = wins + losses;
    return { ...card, wins, losses, total };
  });

  // 2. Constants — only consider cards with any plays for medians/sums
  const withPlays = joined.filter((r) => r.total > 0);
  const sumWins = withPlays.reduce((a, r) => a + r.wins, 0);
  const sumTotal = withPlays.reduce((a, r) => a + r.total, 0);
  const overallWinRate = sumTotal > 0 ? sumWins / sumTotal : 0.5;      // F1
  const medianTotal = median(withPlays.map((r) => r.total));           // H1
  const maxTotal = withPlays.reduce((a, r) => Math.max(a, r.total), 0);// S1

  // 3. First pass: per-card win rate, normalized, % played, buff rating, adj wins/played
  const pass1 = joined.map((r) => {
    const winRate = r.total > 0 ? r.wins / r.total : 0;
    const winRate2 = overallWinRate > 0 ? (winRate * 0.5) / overallWinRate : 0;
    const pctPlayed = sumTotal > 0 ? r.total / sumTotal : 0;

    let buffRating = 0;
    if (medianTotal > r.total) {
      buffRating += (Math.sqrt(medianTotal - r.total) * 7) / Math.sqrt(medianTotal);
    }
    if (winRate2 < 0.5) {
      buffRating += (Math.sqrt(0.5 - winRate2) * 3) / Math.sqrt(0.5);
    }

    const adjPlayed = maxTotal > 0 ? Math.sqrt(r.total / maxTotal) * maxTotal : 0;
    const adjWins = r.wins + (adjPlayed - r.total) * 0.5;

    return { ...r, winRate, winRate2, pctPlayed, buffRating, adjPlayed, adjWins };
  });

  // 4. Overall adjusted win rate (R1) uses adj sums across all cards
  const sumAdjWins = pass1.reduce((a, r) => a + r.adjWins, 0);
  const sumAdjPlayed = pass1.reduce((a, r) => a + r.adjPlayed, 0);
  const overallAdjWR = sumAdjPlayed > 0 ? sumAdjWins / sumAdjPlayed : 0.5;

  // 5. Second pass: overall rating
  const final = pass1.map((r) => {
    const adjWinRate = r.adjPlayed > 0 ? r.adjWins / r.adjPlayed : 0;
    const ovrRating = overallAdjWR > 0
      ? (adjWinRate * 0.5 / overallAdjWR - 0.4) / 0.02
      : 0;
    return { ...r, adjWinRate, ovrRating };
  });

  return {
    rows: final,
    constants: { overallWinRate, medianTotal, maxTotal, overallAdjWR, sumWins, sumTotal, sumLosses: sumTotal - sumWins },
  };
}

// ------------------------------------------------------------
// Aggregate breakdowns (replicates the Sheet2-style summary tables)
// Adj Win Rate = win_rate * 0.5 / overall_win_rate  (matches AR3 formula)
// ------------------------------------------------------------

function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

function aggregate(rows, overallWinRate, scopeTotal) {
  const wins = rows.reduce((a, r) => a + r.wins, 0);
  const losses = rows.reduce((a, r) => a + r.losses, 0);
  const total = wins + losses;
  const winRate = total > 0 ? wins / total : 0;
  const adjWinRate = overallWinRate > 0 ? (winRate * 0.5) / overallWinRate : 0;
  const playRate = scopeTotal > 0 ? total / scopeTotal : 0;
  return { wins, losses, total, winRate, adjWinRate, playRate };
}

function computeAggregates(rows, constants) {
  const owr = constants.overallWinRate;
  const totalGames = rows.reduce((a, r) => a + r.total, 0);

  // By class (uses ALL games as denominator for play rate, like the spreadsheet)
  const byClass = [...groupBy(rows, (r) => r.class).entries()]
    .map(([cls, list]) => ({ label: cls, ...aggregate(list, owr, totalGames) }))
    .sort((a, b) => b.total - a.total);

  // By type
  const byType = [...groupBy(rows, (r) => r.type).entries()]
    .map(([typ, list]) => ({ label: typ, ...aggregate(list, owr, totalGames) }))
    .sort((a, b) => {
      const order = { Friend: 0, Power: 1, Superpower: 2 };
      return (order[a.label] ?? 99) - (order[b.label] ?? 99);
    });

  // By cost (overall — play rate vs total games)
  const byCost = [...groupBy(rows, (r) => r.cost).entries()]
    .map(([cost, list]) => ({ label: String(cost), cost, ...aggregate(list, owr, totalGames) }))
    .sort((a, b) => a.cost - b.cost);

  // By cost × type — play rate scoped to that type's total
  const byTypeCost = {};
  const types = ["Friend", "Power", "Superpower"];
  for (const t of types) {
    const tRows = rows.filter((r) => r.type === t);
    const tTotal = tRows.reduce((a, r) => a + r.total, 0);
    byTypeCost[t] = [...groupBy(tRows, (r) => r.cost).entries()]
      .map(([cost, list]) => ({ label: String(cost), cost, ...aggregate(list, owr, tTotal) }))
      .sort((a, b) => a.cost - b.cost);
    // Pad with empty rows for missing costs (so each type table has rows 1-6)
    for (let c = 1; c <= 6; c++) {
      if (!byTypeCost[t].find((r) => r.cost === c)) {
        byTypeCost[t].push({ label: String(c), cost: c, wins: 0, losses: 0, total: 0, winRate: 0, adjWinRate: 0, playRate: 0 });
      }
    }
    byTypeCost[t].sort((a, b) => a.cost - b.cost);
  }

  return { byClass, byType, byCost, byTypeCost };
}

const pct  = (v, dec = 1) => (v == null) ? "—" : (v * 100).toFixed(dec) + "%";
const num  = (v) => (v == null ? 0 : v).toLocaleString();

function renderAggTable(title, rows, columns) {
  const ths = columns.map((c) => `<th>${c.label}</th>`).join("");
  const trs = rows.map((r) => {
    const tds = columns.map((c) => `<td>${c.cell(r)}</td>`).join("");
    return `<tr>${tds}</tr>`;
  }).join("");
  return `
    <div class="agg-table">
      <h3>${esc(title)}</h3>
      <table>
        <thead><tr>${ths}</tr></thead>
        <tbody>${trs}</tbody>
      </table>
    </div>
  `;
}

function renderAggregates(agg) {
  const groupCol = (label) => ({
    label,
    cell: (r) => `<span class="group-label">${esc(r.label)}</span>`,
  });
  const standardCols = (label) => [
    groupCol(label),
    { label: "Play %",  cell: (r) => pct(r.playRate, 1) },
    { label: "Played",  cell: (r) => num(r.total) },
    { label: "Wins",    cell: (r) => num(r.wins) },
    { label: "Losses",  cell: (r) => num(r.losses) },
    { label: "WR",      cell: (r) => pct(r.winRate, 1) },
    { label: "Adj WR",  cell: (r) => pct(r.adjWinRate, 1) },
  ];
  const noAdjCols = (label) => standardCols(label).slice(0, -1); // drop Adj WR

  const parts = [
    renderAggTable("By Class",       agg.byClass, standardCols("Class")),
    renderAggTable("By Type",        agg.byType,  standardCols("Type")),
    renderAggTable("By Cost (all)",  agg.byCost,  noAdjCols("Cost")),
    renderAggTable("Friend × Cost",      agg.byTypeCost.Friend,     noAdjCols("Cost")),
    renderAggTable("Power × Cost",       agg.byTypeCost.Power,      noAdjCols("Cost")),
    renderAggTable("Superpower × Cost",  agg.byTypeCost.Superpower, noAdjCols("Cost")),
  ];
  els.aggregatesBody.innerHTML = parts.join("");
}

// ------------------------------------------------------------
// Rendering
// ------------------------------------------------------------

const COLS = [
  { key: "name",       label: "Card",        type: "string", render: (r) => `<span class="card-name">${esc(r.name)}</span>` },
  { key: "class",      label: "Class",       type: "string", render: (r) => `<span class="class-pill class-${r.class}">${r.class}</span>` },
  { key: "type",       label: "Type",        type: "string", render: (r) => `<span class="type-${r.type}">${r.type}</span>` },
  { key: "cost",       label: "Cost",        type: "number", numeric: true, render: (r) => r.cost ?? "" },
  { key: "wins",       label: "Wins",        type: "number", numeric: true },
  { key: "losses",     label: "Losses",      type: "number", numeric: true },
  { key: "total",      label: "Total Played", type: "number", numeric: true },
  { key: "winRate",    label: "Win %",       type: "number", numeric: true, fmt: (v) => v ? (v * 100).toFixed(1) + "%" : "—" },
  { key: "winRate2",   label: "Norm WR",     type: "number", numeric: true, fmt: (v) => v ? (v * 100).toFixed(1) + "%" : "—" },
  { key: "pctPlayed",  label: "% Play",      type: "number", numeric: true, fmt: (v) => v ? (v * 100).toFixed(2) + "%" : "—" },
  { key: "buffRating", label: "Buff Rating", type: "number", numeric: true, bar: "buff",   fmt: (v) => v.toFixed(2), max: 10 },
  { key: "ovrRating",  label: "Ovr Rating",  type: "number", numeric: true, bar: "nerf",   fmt: (v) => v.toFixed(2), max: 20 },
];

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}

function renderTable() {
  // Header
  els.thead.innerHTML = "";
  const tr = document.createElement("tr");
  COLS.forEach((c) => {
    const th = document.createElement("th");
    th.textContent = c.label;
    th.dataset.key = c.key;
    if (c.numeric) th.classList.add("numeric");
    if (state.sort.key === c.key) {
      th.classList.add(state.sort.dir === "asc" ? "sort-asc" : "sort-desc");
    }
    th.addEventListener("click", () => {
      if (state.sort.key === c.key) {
        state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
      } else {
        state.sort.key = c.key;
        state.sort.dir = c.type === "number" ? "desc" : "asc";
      }
      renderTable();
    });
    tr.appendChild(th);
  });
  els.thead.appendChild(tr);

  // Body
  const rows = sortRows(applyFilters(state.results));
  els.tbody.innerHTML = "";
  for (const r of rows) {
    const tr = document.createElement("tr");
    for (const c of COLS) {
      const td = document.createElement("td");
      if (c.numeric) td.classList.add("numeric");
      const v = r[c.key];
      const display = c.render ? c.render(r) : (c.fmt ? c.fmt(v) : (v ?? ""));
      if (c.bar && typeof v === "number" && v > 0) {
        const pct = Math.min(100, (v / c.max) * 100);
        td.classList.add("bar-cell");
        td.innerHTML = `<span class="bar ${c.bar}" style="width:${pct}%"></span><span class="val">${display}</span>`;
      } else {
        td.innerHTML = display;
      }
      tr.appendChild(td);
    }
    els.tbody.appendChild(tr);
  }
  els.rowCount.textContent = `Showing ${rows.length} of ${state.results.length} cards`;

  renderSummary();
}

function applyFilters(rows) {
  const q = state.filters.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (q && !r.name.toLowerCase().includes(q)) return false;
    if (state.filters.classes.size && !state.filters.classes.has(r.class)) return false;
    if (state.filters.types.size && !state.filters.types.has(r.type)) return false;
    if (state.filters.costs.size && !state.filters.costs.has(String(r.cost))) return false;
    if (state.filters.hideZero && r.total === 0) return false;
    return true;
  });
}

function sortRows(rows) {
  const col = COLS.find((c) => c.key === state.sort.key);
  const isNum = col && col.type === "number";
  const sign = state.sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[state.sort.key], bv = b[state.sort.key];
    if (isNum) return ((Number(av) || 0) - (Number(bv) || 0)) * sign;
    return String(av ?? "").localeCompare(String(bv ?? "")) * sign;
  });
}

function renderSummary() {
  const visible = applyFilters(state.results);
  const totalCards = state.results.filter((r) => r.total > 0).length;
  const totalGames = state.results.reduce((a, r) => a + r.total, 0);
  const wr = totalGames ? state.results.reduce((a, r) => a + r.wins, 0) / totalGames : 0;

  // Heuristic buckets (purely visual — user picks via sort/filter)
  const strongBuff = state.results.filter((r) => r.total > 0 && r.buffRating >= 5).length;
  const lowSample = state.results.filter((r) => r.total > 0 && r.total < 30).length;
  const strongOvr = state.results.filter((r) => r.ovrRating >= 8).length;
  const noData = state.results.filter((r) => r.total === 0).length;

  els.summary.innerHTML = `
    <div class="summary-card"><div class="label">Cards w/ data</div><div class="value">${totalCards}</div></div>
    <div class="summary-card"><div class="label">Total played</div><div class="value">${totalGames.toLocaleString()}</div></div>
    <div class="summary-card"><div class="label">Overall win rate</div><div class="value">${(wr*100).toFixed(1)}%</div></div>
    <div class="summary-card"><div class="label">Buff rating ≥ 5</div><div class="value" style="color:var(--buff)">${strongBuff}</div></div>
    <div class="summary-card"><div class="label">Ovr rating ≥ 8</div><div class="value" style="color:var(--nerf)">${strongOvr}</div></div>
    <div class="summary-card"><div class="label">Low sample (&lt;30)</div><div class="value" style="color:var(--rework)">${lowSample}</div></div>
    <div class="summary-card"><div class="label">No data</div><div class="value" style="color:var(--muted)">${noData}</div></div>
  `;
}

// ------------------------------------------------------------
// Filter chips
// ------------------------------------------------------------

function buildFilterChips() {
  const classes = [...new Set(MASTER_CARDS.map((c) => c.class))].sort();
  const types   = [...new Set(MASTER_CARDS.map((c) => c.type))].sort();
  const costs   = [...new Set(MASTER_CARDS.map((c) => c.cost))].sort((a,b)=>a-b);

  fillChips(els.classFilters, classes, state.filters.classes, (v) => `chip class-${v}`);
  fillChips(els.typeFilters,  types,   state.filters.types,   () => `chip`);
  fillChips(els.costFilters,  costs.map(String), state.filters.costs, () => `chip`);
}

function fillChips(container, values, set, classFn) {
  container.innerHTML = "";
  for (const v of values) {
    const chip = document.createElement("span");
    chip.className = classFn(v);
    chip.textContent = v;
    chip.dataset.value = v;
    chip.addEventListener("click", () => {
      if (set.has(v)) set.delete(v);
      else set.add(v);
      chip.classList.toggle("active");
      renderTable();
    });
    container.appendChild(chip);
  }
}

// ------------------------------------------------------------
// Diagnostics
// ------------------------------------------------------------

function renderDiagnostics() {
  const parts = [];
  if (state.unmatchedWins.length || state.unmatchedLosses.length) {
    parts.push(`<p><strong>Names not in master list</strong> (typo or new card?):</p>`);
    if (state.unmatchedWins.length) {
      parts.push(`<p>From wins:</p><ul>${state.unmatchedWins.map((n) => `<li><code>${esc(n)}</code></li>`).join("")}</ul>`);
    }
    if (state.unmatchedLosses.length) {
      parts.push(`<p>From losses:</p><ul>${state.unmatchedLosses.map((n) => `<li><code>${esc(n)}</code></li>`).join("")}</ul>`);
    }
  }
  if (state.unpastedCards.length) {
    parts.push(`<p><strong>${state.unpastedCards.length} master cards with no plays in pasted data.</strong> First 10: ${state.unpastedCards.slice(0,10).map((n) => `<code>${esc(n)}</code>`).join(", ")}${state.unpastedCards.length > 10 ? ", ..." : ""}</p>`);
  }
  if (parts.length === 0) {
    parts.push(`<p>All pasted names matched the master list. Every card has play data.</p>`);
  }
  els.diagBody.innerHTML = parts.join("");
  els.diagnostics.hidden = false;
}

// ------------------------------------------------------------
// Export
// ------------------------------------------------------------

function exportCSV() {
  const rows = sortRows(applyFilters(state.results));
  const header = COLS.map((c) => c.label).join(",");
  const body = rows.map((r) =>
    COLS.map((c) => {
      let v = r[c.key];
      if (typeof v === "number") {
        if (c.key === "winRate" || c.key === "pctPlayed" || c.key === "winRate2") v = (v * 100).toFixed(3);
        else if (c.key === "buffRating" || c.key === "ovrRating") v = v.toFixed(4);
      }
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(",")
  );
  const blob = new Blob([header + "\n" + body.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "balance-changes.csv";
  a.click();
  URL.revokeObjectURL(url);
}

// ------------------------------------------------------------
// BigQuery integration
// ------------------------------------------------------------

/** Format a datetime-local value (YYYY-MM-DDTHH:MM) as BQ TIMESTAMP literal. */
function fmtBQTimestamp(dtLocal) {
  if (!dtLocal) return "";
  // datetime-local has form 2026-04-01T18:00 (no seconds)
  return dtLocal.replace("T", " ") + ":00";
}

/** Build the SQL query for either 'winner' or 'loser' results. */
function buildBQQuery({ startTime, endTime, minRating, humanOnly, resultType }) {
  const alias = resultType === "winner" ? "RankedWins" : "RankedLosses";
  const start = fmtBQTimestamp(startTime);
  const end   = fmtBQTimestamp(endTime);
  const botLine = humanOnly
    ? `\n    AND JSON_VALUE(mWin.metadata, '$.bot_match') = 'false'`
    : "";
  const tbl = `\`${BQ_PROJECT_ID}.${BQ_DATASET}.${BQ_TABLE}\``;

  return `SELECT
    JSON_VALUE(m.metadata, '$.card.name') AS CardName
    , COUNT(mWin.time) AS ${alias}
FROM ${tbl} AS m
LEFT JOIN ${tbl} AS mWin ON (
    mWin.match_id = m.match_id
    AND mWin.event = "match_end"
    AND mWin.time >= "${start}"
    AND mWin.time <= "${end}"
    AND mWin.player_id NOT LIKE '%Bot_%'
    AND mWin.player_id NOT LIKE '%bot_%'
    AND mWin.player_id NOT LIKE '%pponent%'${botLine}
    AND JSON_VALUE(mWin.metadata, '$.match_result') = '${resultType}'
    AND JSON_VALUE(mWin.metadata, '$.ranked') = 'true'
    AND JSON_VALUE(mWin.metadata, '$.map') <> 'Rookie 100/50'
    AND m.player_id = mWin.player_id
)
WHERE
    m.event = 'card_played'
    AND m.match_id = mWin.match_id
    AND m.time >= "${start}"
    AND m.time <= "${end}"
    AND mWin.player_id NOT LIKE '%Bot_%'
    AND mWin.player_id NOT LIKE '%bot_%'
    AND mWin.player_id NOT LIKE '%pponent%'
    AND CAST(JSON_VALUE(m.metadata, '$.player.rating') AS INT64) > ${minRating}
GROUP BY CardName
ORDER BY CardName`;
}

function getBQParams() {
  return {
    startTime: els.bqStart.value,
    endTime: els.bqEnd.value,
    minRating: Number(els.bqMinRating.value) || 0,
    humanOnly: els.bqHumanOnly.checked,
  };
}

function refreshSQLPreview() {
  const p = getBQParams();
  if (!p.startTime || !p.endTime) {
    els.bqSqlWins.textContent = "(set start and end times to preview the query)";
    els.bqSqlLosses.textContent = "";
    return;
  }
  els.bqSqlWins.textContent   = buildBQQuery({ ...p, resultType: "winner" });
  els.bqSqlLosses.textContent = buildBQQuery({ ...p, resultType: "loser" });
}

/** Run a SQL query against BigQuery REST API; returns array of row objects. */
async function runBQQuery(sql) {
  if (!bqAccessToken || Date.now() > bqTokenExpiresAt) {
    throw new Error("Not signed in (token expired). Click Sign in again.");
  }
  const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${BQ_PROJECT_ID}/queries`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${bqAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: sql,
      useLegacySql: false,
      timeoutMs: 60000,
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    const msg = json.error?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  if (json.jobComplete === false) {
    throw new Error("Query didn't complete within 60s — try a smaller date range.");
  }
  const fields = (json.schema?.fields || []).map((f) => f.name);
  const rows = (json.rows || []).map((r) => {
    const o = {};
    fields.forEach((name, i) => { o[name] = r.f[i].v; });
    return o;
  });
  return rows;
}

/** Convert query rows -> textarea string "CardName\tcount" lines. */
function rowsToPasteFormat(rows, countField) {
  return rows
    .filter((r) => r.CardName !== null && r.CardName !== "")
    .map((r) => `${r.CardName}\t${r[countField] ?? 0}`)
    .join("\n");
}

async function runBQAndAnalyze() {
  const p = getBQParams();
  if (!p.startTime || !p.endTime) {
    setBQStatus("Set both start and end times first.", "error");
    return;
  }
  if (p.minRating < 0) {
    setBQStatus("Min rating must be ≥ 0.", "error");
    return;
  }

  els.bqRun.disabled = true;
  setBQStatus("Running queries...", "");
  refreshSQLPreview();

  try {
    const sqlW = buildBQQuery({ ...p, resultType: "winner" });
    const sqlL = buildBQQuery({ ...p, resultType: "loser" });
    const t0 = performance.now();
    const [winRows, lossRows] = await Promise.all([runBQQuery(sqlW), runBQQuery(sqlL)]);
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

    els.wins.value   = rowsToPasteFormat(winRows, "RankedWins");
    els.losses.value = rowsToPasteFormat(lossRows, "RankedLosses");

    setBQStatus(`Fetched ${winRows.length} wins rows and ${lossRows.length} losses rows in ${elapsed}s.`, "ok");
    runAnalysis();
  } catch (e) {
    setBQStatus(`Query failed: ${e.message}`, "error");
  } finally {
    els.bqRun.disabled = false;
  }
}

function setBQStatus(msg, kind) {
  els.bqStatus.textContent = msg;
  els.bqStatus.className = "status" + (kind ? " " + kind : "");
}

/** Try to extract email from an ID-token-ish access response; falls back gracefully. */
function showSignedIn(email) {
  els.bqSignin.hidden = true;
  els.bqRun.hidden = false;
  els.bqSignout.hidden = false;
  els.bqUser.textContent = email ? `Signed in as ${email}` : "Signed in";
  els.bqUser.className = "status ok";
}

function showSignedOut() {
  els.bqSignin.hidden = false;
  els.bqRun.hidden = true;
  els.bqSignout.hidden = true;
  els.bqUser.textContent = "";
  els.bqUser.className = "status";
}

/** Initialize the GIS token client once the library has loaded. */
function initBQAuth() {
  if (typeof google === "undefined" || !google.accounts?.oauth2) {
    // Library hasn't loaded yet — retry shortly
    setTimeout(initBQAuth, 200);
    return;
  }
  bqTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: OAUTH_CLIENT_ID,
    scope: OAUTH_SCOPE,
    callback: (resp) => {
      if (resp.error) {
        setBQStatus(`Sign-in failed: ${resp.error}`, "error");
        return;
      }
      bqAccessToken = resp.access_token;
      // GIS returns expires_in (seconds, typically 3600).
      bqTokenExpiresAt = Date.now() + ((resp.expires_in || 3600) - 60) * 1000;
      // Fetch the user's email for display (best-effort).
      fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${bqAccessToken}` },
      })
        .then((r) => r.ok ? r.json() : null)
        .then((u) => showSignedIn(u?.email))
        .catch(() => showSignedIn(null));
      setBQStatus("", "");
    },
  });
  els.bqSignin.disabled = false;
}

function signInToBQ() {
  if (!bqTokenClient) {
    setBQStatus("Google auth library not loaded yet — try again in a moment.", "error");
    return;
  }
  bqTokenClient.requestAccessToken({ prompt: "" });
}

function signOutFromBQ() {
  if (bqAccessToken && google?.accounts?.oauth2?.revoke) {
    google.accounts.oauth2.revoke(bqAccessToken, () => {});
  }
  bqAccessToken = null;
  bqTokenExpiresAt = 0;
  showSignedOut();
}

/** Restore saved parameters from localStorage, or set sane defaults. */
function loadBQPrefs() {
  const saved = JSON.parse(localStorage.getItem("bqPrefs") || "{}");
  // Default to last 30 days at 00:00
  const now = new Date();
  const monthAgo = new Date(now.getTime() - 30 * 86400 * 1000);
  const toLocal = (d) => {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  els.bqStart.value      = saved.startTime || toLocal(monthAgo);
  els.bqEnd.value        = saved.endTime   || toLocal(now);
  els.bqMinRating.value  = saved.minRating ?? 600;
  els.bqHumanOnly.checked = !!saved.humanOnly;
  refreshSQLPreview();
}

function saveBQPrefs() {
  localStorage.setItem("bqPrefs", JSON.stringify({
    startTime: els.bqStart.value,
    endTime: els.bqEnd.value,
    minRating: els.bqMinRating.value,
    humanOnly: els.bqHumanOnly.checked,
  }));
}

// ------------------------------------------------------------
// Wire up
// ------------------------------------------------------------

function runAnalysis() {
  const winsRows = parsePaste(els.wins.value);
  const lossesRows = parsePaste(els.losses.value);
  if (winsRows.length === 0 && lossesRows.length === 0) {
    setStatus("Paste some wins or losses data first.", "error");
    return;
  }

  const winsMap = buildCountMap(winsRows);
  const lossesMap = buildCountMap(lossesRows);

  // Track unmatched names
  state.unmatchedWins = winsRows.map((r) => r.name).filter((n) => !MASTER_INDEX.has(n.toLowerCase()));
  state.unmatchedLosses = lossesRows.map((r) => r.name).filter((n) => !MASTER_INDEX.has(n.toLowerCase()));
  // Dedupe (case-insensitive)
  state.unmatchedWins = [...new Set(state.unmatchedWins.map((s) => s.toLowerCase()))].map((lc) =>
    winsRows.find((r) => r.name.toLowerCase() === lc).name
  );
  state.unmatchedLosses = [...new Set(state.unmatchedLosses.map((s) => s.toLowerCase()))].map((lc) =>
    lossesRows.find((r) => r.name.toLowerCase() === lc).name
  );

  const { rows, constants } = analyze(winsMap, lossesMap);
  state.results = rows;
  state.constants = constants;
  state.unpastedCards = rows.filter((r) => r.total === 0).map((r) => r.name);

  setStatus(
    `Parsed ${winsRows.length} win rows, ${lossesRows.length} loss rows. ` +
    `Overall WR: ${(constants.overallWinRate*100).toFixed(1)}%, median total played: ${constants.medianTotal}.`,
    "ok"
  );

  els.results.hidden = false;
  renderDiagnostics();
  renderAggregates(computeAggregates(rows, constants));
  renderTable();
}

function setStatus(msg, kind) {
  els.status.textContent = msg;
  els.status.className = "status" + (kind ? " " + kind : "");
}

// Sample data for quick testing
const SAMPLE_WINS = `Air Attack\t293
Armory\t152
Cannon\t2802
Cannonball\t2628
Rerun\t2579
Slicer\t2669
Papercut\t2370
Trasher\t1402
Ocean's Fury\t22
Harmonize\t44
Crossbow\t66
Contamination\t1840
Flash\t12
Flutter\t8
Superposition\t180
Singularity\t140
Hyperdrive\t195`;

const SAMPLE_LOSSES = `Air Attack\t129
Armory\t84
Cannon\t781
Cannonball\t738
Rerun\t441
Slicer\t1030
Papercut\t562
Trasher\t235
Ocean's Fury\t13
Harmonize\t23
Crossbow\t40
Contamination\t540
Flash\t68
Flutter\t52
Superposition\t27
Singularity\t60
Hyperdrive\t40`;

els.analyze.addEventListener("click", runAnalysis);
els.sample.addEventListener("click", () => {
  els.wins.value = SAMPLE_WINS;
  els.losses.value = SAMPLE_LOSSES;
  runAnalysis();
});
els.clear.addEventListener("click", () => {
  els.wins.value = "";
  els.losses.value = "";
  state.results = [];
  state.unmatchedWins = [];
  state.unmatchedLosses = [];
  state.unpastedCards = [];
  els.results.hidden = true;
  els.diagnostics.hidden = true;
  setStatus("", "");
});

els.search.addEventListener("input", (e) => {
  state.filters.search = e.target.value;
  renderTable();
});
els.hideZero.addEventListener("change", (e) => {
  state.filters.hideZero = e.target.checked;
  renderTable();
});
els.export.addEventListener("click", exportCSV);

// BigQuery wiring
els.bqSignin.addEventListener("click", signInToBQ);
els.bqSignout.addEventListener("click", signOutFromBQ);
els.bqRun.addEventListener("click", runBQAndAnalyze);
[els.bqStart, els.bqEnd, els.bqMinRating, els.bqHumanOnly].forEach((el) => {
  el.addEventListener("change", () => {
    saveBQPrefs();
    refreshSQLPreview();
  });
});

// ------------------------------------------------------------
// Boot
// ------------------------------------------------------------
async function boot() {
  try {
    const res = await fetch(CARDS_URL);
    if (!res.ok) throw new Error(`Could not load ${CARDS_URL} (${res.status})`);
    MASTER_CARDS = await res.json();
    MASTER_INDEX = new Map(MASTER_CARDS.map((c) => [c.name.toLowerCase(), c]));
    buildFilterChips();
    setStatus(`Loaded ${MASTER_CARDS.length} cards from master list.`);
  } catch (e) {
    setStatus(`Failed to load master card list: ${e.message}. If opening as file://, run a local server instead (see README).`, "error");
  }
  // Initialize BigQuery panel
  loadBQPrefs();
  initBQAuth();
}
boot();
