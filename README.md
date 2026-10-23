# Royalty Tracker

Local web app for musicians to track royalties. No dependencies: needs Node 22.13+ (uses built-in `node:sqlite`).

```
npm start     # http://localhost:3000
npm test
```

The UI (`public/`) is plain HTML/JS with no build step. Data is stored in `royalties.db` next to `server.js`. Try `sample-statement.csv` on the Statements page.

- **Catalog & splits**: songs (title/ISRC), contributors, per-song split percentages (capped at 100%).
- **Statement import**: CSV with auto-detected columns; rows match songs by ISRC then title (a title or ISRC shared by several songs is left unmatched for you to assign); unmatched rows can be assigned or auto-link when you add the song.
- **Dashboard**: earnings by period, track, platform, territory; date filter; CSV export.
- **Payments**: expected vs. received (pending/overdue/short), advances with recoupment against same-named sources.
- **Payouts**: each contributor's gross share of earnings from their splits, plus any earnings not covered by splits or not matched to a song (`/api/payouts/summary`). Payments to contributors aren't tracked, so nothing is netted.

## API notes

- Requests must come from localhost (`Host`/`Origin` are checked), and `POST`/`PUT` bodies must be sent as `Content-Type: application/json`.
- Statement import detects day-first vs month-first dates from the file. If every date is ambiguous (e.g. `05/03/2025`), the import is rejected until you pass `dateOrder: "dmy"` or `"mdy"`. Re-importing an identical statement needs `force: true`.
