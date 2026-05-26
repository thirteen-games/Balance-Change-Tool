# Balance Change Tool

A browser-based tool for game balance analysis. Takes win/loss data for all cards as input and outputs a sortable, filterable table that identifies which cards are candidates to be **buffed**, **nerfed**, or **reworked**.

## How it works

1. **Paste or upload** win/loss data as CSV/TSV. Required columns:
   - `card` (or `name`) — card name
   - `wins` — number of wins
   - `losses` — number of losses
   - Any extra columns (e.g. `rarity`, `cost`) are preserved and shown as additional table columns.
2. **Adjust thresholds** to match your balance philosophy:
   - **Buff candidate** — win rate below X%
   - **Nerf candidate** — win rate above Y%
   - **Rework candidate** — total games below N (low play rate signals players aren't engaging with the card)
   - **Minimum games to evaluate** — cards with fewer games are flagged as insufficient data
3. **Sort & filter** the results table. Click any column header to sort. Use the search box to find a specific card, or toggle status checkboxes to focus on one category. Export filtered results to CSV.

## Running locally

It's a static site — no build step.

```sh
open index.html
```

Or serve it with any static server:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Files

- `index.html` — page structure
- `style.css` — styles (dark theme)
- `script.js` — parsing, analysis, table rendering, sort/filter/export
