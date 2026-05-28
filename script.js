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
  wins: $("#wins-input"),
  losses: $("#losses-input"),
  analyze: $("#analyze-btn"),
  sample: $("#sample-btn"),
  clear: $("#clear-btn"),
  status: $("#parse-status"),
  diagnostics: $("#diagnostics"),
  diagBody: $("#diagnostics-body"),
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
    setStatus(`Loaded ${MASTER_CARDS.length} cards from master list. Paste data to begin.`);
  } catch (e) {
    setStatus(`Failed to load master card list: ${e.message}. If opening as file://, run a local server instead (see README).`, "error");
  }
}
boot();
