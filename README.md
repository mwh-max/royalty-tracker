# Royalty Tracker

Local web app for musicians to track royalties. No dependencies: needs Node 22.13+ (uses built-in `node:sqlite`).

```
npm start     # http://localhost:3000
npm test
```

Data is stored in `royalties.db` next to `server.js`. Try `sample-statement.csv` on the Statements page.

- **Catalog & splits**: songs (title/ISRC), contributors, per-song split percentages (capped at 100%).
- **Statement import**: CSV with auto-detected columns; rows match songs by ISRC then title; unmatched rows can be assigned or auto-link when you add the song.
- **Dashboard**: earnings by period, track, platform, territory; date filter; CSV export.
- **Payments**: expected vs. received (pending/overdue/short), advances with recoupment against same-named sources.
- **Payouts**: each contributor's share of earnings from their splits.
