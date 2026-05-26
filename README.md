# Balance Change Tool

Browser-based tool for identifying which cards are candidates to be **buffed**, **nerfed**, or **reworked**. Replicates the calculation chain from the PVE ranked-data spreadsheet.

## Usage

1. Run a SQL query that returns **wins by card** and another that returns **losses by card**.
2. Paste each result into its respective box. Format is flexible — tab, comma, pipe, or multi-space separated, header rows OK:
   ```
   Air Attack    293
   Armory        152
   Cannon        2802
   ```
3. Click **Analyze**.
4. Sort by `Buff Rating` (descending) to find buff/rework candidates, or by `Ovr Rating` (descending) to find the strongest cards (nerf candidates). Filter by class, type, or cost to narrow your focus.

## What it computes

Per card, joined against the master list of 199 cards (`cards.json`):

| Column | Meaning |
|---|---|
| `Wins`, `Losses`, `Games` | From your pasted data |
| `Win %` | Raw win rate |
| `Norm WR` | Win rate normalized so `1.0` = overall average (`win_rate * 0.5 / overall_win_rate`) |
| `% Play` | This card's share of all games played |
| **`Buff Rating`** | Higher → stronger buff/rework candidate. Composite of two penalties: low play count vs. median (up to 7 pts) + low normalized win rate (up to 3 pts) |
| **`Ovr Rating`** | Higher → stronger card. Based on a sqrt-shrunk adjusted win rate, rescaled |

The **Buff Rating** and **Ovr Rating** formulas match those in the source spreadsheet (sheet "win rates in ranked since bruis", columns L and R).

### Decision guide

- **Buff candidates** — high `Buff Rating` driven mostly by *low win rate* (check `Norm WR < 0.5`)
- **Rework candidates** — high `Buff Rating` driven mostly by *low play count* (under-played, players aren't engaging)
- **Nerf candidates** — high `Ovr Rating` with meaningful sample size

## Running locally

`cards.json` is loaded via `fetch()` so the page needs a real HTTP server (won't work with `file://`):

```sh
cd Balance-Change-Tool
python3 -m http.server 8000
# open http://localhost:8000
```

## Updating the master card list

`cards.json` is an array of `{name, class, type, cost}`. Edit it directly to add new cards, change classes, etc.

Valid values:
- **class**: Boom, Cosmic, Cyber, Distortion, Energy, Floral, Magic, Moxie
- **type**: Friend, Power, Superpower
- **cost**: 1–6 (integer)

## Files

- `index.html` — page structure
- `style.css` — dark theme
- `script.js` — paste parsing, analysis, table rendering, filters, export
- `cards.json` — master list of 199 cards (extracted from the spreadsheet)
