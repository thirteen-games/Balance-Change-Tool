"use strict";

// ---------- State ----------

const state = {
  rows: [],          // [{card, wins, losses, total, winRate, status, ...extras}]
  extraColumns: [],  // any non-core columns from the input
  sort: { key: "winRate", dir: "asc" },
  filters: {
    search: "",
    statuses: new Set(["Buff", "Nerf", "Rework", "OK"]),
  },
};

// ---------- DOM ----------

const $ = (sel) => document.querySelector(sel);
const els = {
  fileInput: $("#file-input"),
  loadSample: $("#load-sample-btn"),
  clear: $("#clear-btn"),
  dataInput: $("#data-input"),
  parse: $("#parse-btn"),
  parseStatus: $("#parse-status"),
  buffT: $("#buff-threshold"),
  nerfT: $("#nerf-threshold"),
  reworkT: $("#rework-threshold"),
  minGames: $("#min-games"),
  resultsPanel: $("#results-panel"),
  summary: $("#summary"),
  search: $("#search-input"),
  statusFilters: $("#status-filters"),
  export: $("#export-btn"),
  thead: document.querySelector("#results-table thead"),
  tbody: document.querySelector("#results-table tbody"),
};

// ---------- Sample data ----------

const SAMPLE_DATA = `card,wins,losses,rarity
Fireball,182,118,common
Healing Potion,45,255,common
Dragon Strike,310,90,rare
Stone Wall,140,160,common
Mystic Shield,8,4,epic
Lightning Bolt,210,190,common
Frost Nova,55,145,rare
Goblin Raider,7,3,common
Arcane Missile,205,195,common
Time Warp,40,260,legendary
Phoenix,290,110,legendary
Slime,160,140,common
Shadow Dagger,12,8,rare
Earthquake,320,80,epic
Whirlwind,180,220,common
Vampire Bat,148,152,common
Sun Priestess,275,125,rare
Iron Golem,95,205,rare
Wisp,4,2,common
Tidal Surge,205,195,epic`;

// ---------- Parsing ----------

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/)[0] || "";
  const counts = { ",": 0, "\t": 0, ";": 0 };
  for (const ch of firstLine) if (ch in counts) counts[ch]++;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] || ",";
}

function parseCSV(text) {
  const delim = detectDelimiter(text);
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) throw new Error("Need a header row and at least one data row.");

  const header = splitLine(lines[0], delim).map((h) => h.trim().toLowerCase());

  const cardIdx = header.findIndex((h) => h === "card" || h === "name" || h === "card name");
  const winsIdx = header.findIndex((h) => h === "wins" || h === "w");
  const lossesIdx = header.findIndex((h) => h === "losses" || h === "l");
  if (cardIdx === -1) throw new Error("Missing 'card' column.");
  if (winsIdx === -1) throw new Error("Missing 'wins' column.");
  if (lossesIdx === -1) throw new Error("Missing 'losses' column.");

  const extraIdxs = header
    .map((h, i) => (i === cardIdx || i === winsIdx || i === lossesIdx ? null : i))
    .filter((i) => i !== null);
  const extraColumns = extraIdxs.map((i) => header[i]);

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i], delim);
    const card = (cells[cardIdx] ?? "").trim();
    if (!card) continue;
    const wins = Number(cells[winsIdx]);
    const losses = Number(cells[lossesIdx]);
    if (!Number.isFinite(wins) || !Number.isFinite(losses)) {
      throw new Error(`Row ${i + 1}: wins/losses must be numbers.`);
    }
    const row = { card, wins, losses };
    extraIdxs.forEach((idx, k) => {
      row[extraColumns[k]] = (cells[idx] ?? "").trim();
    });
    rows.push(row);
  }
  return { rows, extraColumns };
}

function splitLine(line, delim) {
  // Simple split supporting quoted fields with embedded delimiters.
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === delim && !inQuotes) {
      out.push(cur); cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// ---------- Analysis ----------

function analyze(rows) {
  const buffT = Number(els.buffT.value);
  const nerfT = Number(els.nerfT.value);
  const reworkT = Number(els.reworkT.value);
  const minGames = Number(els.minGames.value);

  return rows.map((r) => {
    const total = r.wins + r.losses;
    const winRate = total > 0 ? (r.wins / total) * 100 : 0;
    let status = "OK";
    if (total < minGames) {
      status = "—"; // not enough data
    } else if (total < reworkT) {
      status = "Rework";
    } else if (winRate < buffT) {
      status = "Buff";
    } else if (winRate > nerfT) {
      status = "Nerf";
    }
    return { ...r, total, winRate, status };
  });
}

// ---------- Render ----------

const CORE_COLUMNS = [
  { key: "card", label: "Card", type: "string" },
  { key: "wins", label: "Wins", type: "number" },
  { key: "losses", label: "Losses", type: "number" },
  { key: "total", label: "Games", type: "number" },
  { key: "winRate", label: "Win Rate", type: "number", fmt: (v) => v.toFixed(1) + "%" },
  { key: "status", label: "Status", type: "string", fmt: renderStatusTag },
];

function renderStatusTag(s) {
  const cls = {
    Buff: "tag tag-buff",
    Nerf: "tag tag-nerf",
    Rework: "tag tag-rework",
    OK: "tag tag-ok",
    "—": "tag tag-ok",
  }[s] || "tag tag-ok";
  return `<span class="${cls}">${s}</span>`;
}

function getColumns() {
  return [
    ...CORE_COLUMNS,
    ...state.extraColumns.map((k) => ({ key: k, label: k, type: "string" })),
  ];
}

function renderTable() {
  const cols = getColumns();

  // Header
  els.thead.innerHTML = "";
  const tr = document.createElement("tr");
  cols.forEach((c) => {
    const th = document.createElement("th");
    th.textContent = c.label;
    th.dataset.key = c.key;
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
  const filtered = applyFilters(state.rows);
  const sorted = sortRows(filtered, state.sort.key, state.sort.dir);

  els.tbody.innerHTML = "";
  for (const row of sorted) {
    const tr = document.createElement("tr");
    cols.forEach((c) => {
      const td = document.createElement("td");
      const val = row[c.key];
      if (c.fmt) td.innerHTML = c.fmt(val);
      else td.textContent = val ?? "";
      tr.appendChild(td);
    });
    els.tbody.appendChild(tr);
  }

  renderSummary();
}

function applyFilters(rows) {
  const q = state.filters.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (!state.filters.statuses.has(r.status) && r.status !== "—") return false;
    if (r.status === "—" && !state.filters.statuses.has("OK")) return false;
    if (q && !String(r.card).toLowerCase().includes(q)) return false;
    return true;
  });
}

function sortRows(rows, key, dir) {
  const col = getColumns().find((c) => c.key === key);
  const isNum = col && col.type === "number";
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[key], bv = b[key];
    if (isNum) return ((Number(av) || 0) - (Number(bv) || 0)) * sign;
    return String(av ?? "").localeCompare(String(bv ?? "")) * sign;
  });
}

function renderSummary() {
  const counts = { Buff: 0, Nerf: 0, Rework: 0, OK: 0, "—": 0 };
  for (const r of state.rows) counts[r.status] = (counts[r.status] || 0) + 1;
  els.summary.innerHTML = `
    <div class="summary-card"><div class="label">Total cards</div><div class="value">${state.rows.length}</div></div>
    <div class="summary-card"><div class="label">Buff candidates</div><div class="value" style="color:var(--buff)">${counts.Buff}</div></div>
    <div class="summary-card"><div class="label">Nerf candidates</div><div class="value" style="color:var(--nerf)">${counts.Nerf}</div></div>
    <div class="summary-card"><div class="label">Rework candidates</div><div class="value" style="color:var(--rework)">${counts.Rework}</div></div>
    <div class="summary-card"><div class="label">Not enough data</div><div class="value" style="color:var(--muted)">${counts["—"]}</div></div>
  `;
}

// ---------- Export ----------

function exportCSV() {
  const cols = getColumns();
  const filtered = applyFilters(state.rows);
  const sorted = sortRows(filtered, state.sort.key, state.sort.dir);
  const header = cols.map((c) => c.label).join(",");
  const lines = sorted.map((r) =>
    cols.map((c) => {
      let v = r[c.key];
      if (c.key === "winRate" && typeof v === "number") v = v.toFixed(2);
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(",")
  );
  const blob = new Blob([header + "\n" + lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "balance-changes.csv";
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- Events ----------

function runAnalysis() {
  const text = els.dataInput.value;
  if (!text.trim()) {
    setStatus("Paste data or upload a file first.", "error");
    return;
  }
  try {
    const { rows, extraColumns } = parseCSV(text);
    state.extraColumns = extraColumns;
    state.rows = analyze(rows);
    setStatus(`Parsed ${rows.length} cards.`, "ok");
    els.resultsPanel.hidden = false;
    renderTable();
  } catch (e) {
    setStatus(e.message, "error");
  }
}

function setStatus(msg, kind) {
  els.parseStatus.textContent = msg;
  els.parseStatus.className = "status" + (kind ? " " + kind : "");
}

els.parse.addEventListener("click", runAnalysis);

els.loadSample.addEventListener("click", () => {
  els.dataInput.value = SAMPLE_DATA;
  runAnalysis();
});

els.clear.addEventListener("click", () => {
  els.dataInput.value = "";
  state.rows = [];
  state.extraColumns = [];
  els.resultsPanel.hidden = true;
  setStatus("", "");
});

els.fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    els.dataInput.value = ev.target.result;
    runAnalysis();
  };
  reader.readAsText(file);
});

[els.buffT, els.nerfT, els.reworkT, els.minGames].forEach((input) => {
  input.addEventListener("change", () => {
    if (state.rows.length > 0) {
      state.rows = analyze(state.rows.map(({ card, wins, losses, ...rest }) => {
        // strip computed fields and keep extras
        const extras = {};
        for (const k of state.extraColumns) extras[k] = rest[k];
        return { card, wins, losses, ...extras };
      }));
      renderTable();
    }
  });
});

els.search.addEventListener("input", (e) => {
  state.filters.search = e.target.value;
  renderTable();
});

els.statusFilters.addEventListener("change", (e) => {
  if (e.target.matches('input[type="checkbox"]')) {
    const v = e.target.value;
    if (e.target.checked) state.filters.statuses.add(v);
    else state.filters.statuses.delete(v);
    renderTable();
  }
});

els.export.addEventListener("click", exportCSV);
