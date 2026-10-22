# Card Checklist (PWA)

A static, offline phone app for tracking sports card sets and every parallel. No backend. Data is stored on the device: sets and ownership in localStorage, your photos in IndexedDB. Use Backup in the ⋯ menu to export/restore JSON.

Run locally: `python3 -m http.server 8765` in this folder, then open http://localhost:8765

## Set import format
JSON: see sample-set.json. Fields: name, year, brand, sport, baseName (default "Base"),
parallels[] {name, printRun (number|null, 1 = 1/1), color, appliesTo [subset names; empty = all cards]},
cards[] {number, player, team, subset (default baseName), rookie (bool), image (URL)}.
Optional ids. If you leave them out, ids come from the name and the subset+number, so re-importing an updated checklist keeps what you own.

CSV, simple: one row per card, with the columns number, player, team, subset, rookie, image. You enter the set name and parallels on the review screen.
CSV, full: add a `type` column (set | parallel | card) plus name, print_run, color, applies_to (use | between subsets), year, brand, sport. See sample-set.csv.
Parallels text (on the review screen and in Edit set): one per line, `Name /run #color [Subset|Subset]`.

Optional per-card fields (format version 2, used by the bundled Phillies sets in data/):
- `parallels`: an exact list of the parallel ids (or names) this card comes in. This overrides `appliesTo`.
- `noBase: true`: the checklist lists no plain/base version for the card.
- `featured: true`: pins the card to the home screen as a featured rainbow chase.
- `images`: `{parallelId: "img/..."}`, a reference photo for each parallel.
- `notes`, `ref` (source link) and `players` (subjects of a multi-player card).
In a CSV file, `parallels` and `noBase` can be columns, with the parallels separated by `|`.

Bundled data: data/index.json lists the sets that load on first run (2026 Topps Series 1, Series 2, Update and Chrome, Phillies only).
Raise `dataVersion` in a set file to refresh that checklist on phones that already have it. What the user owns is kept.

sample-set.json / sample-set.csv contain fictional EXAMPLE DATA (⋯ → Load example demo set).
