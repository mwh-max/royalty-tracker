# Royalty Tracker

Local web app for musicians to track royalties. No dependencies: needs Node 22.13+ (uses built-in `node:sqlite`).

```
npm start     # http://localhost:3000
npm test
```

The UI (`public/`) is plain HTML/JS with no build step. Data is stored in `royalties.db` next to `server.js`. Money is stored as integer micro-dollars (1e-6 USD), so sums are exact and per-stream amounts like `0.00456` survive; statement amounts with more than six decimals are rounded to six. The API still uses decimal dollars. Databases from earlier versions are converted automatically on first start, so copy `royalties.db` somewhere first if it holds real data. Try `sample-statement.csv` on the Statements page.

- **Catalog & splits**: songs (title/ISRC), contributors, per-song split percentages (capped at 100%). Splits come in two kinds: master (the recording; these drive payouts) and composition (the song; stored for MLC registration and not used in payouts). The Catalog page lists which songs have complete composition splits (100% within 0.06, no zero share); it checks shares only, since writer IPI numbers and publishers aren't stored.
- **Statement import**: CSV with auto-detected columns; rows match songs by ISRC then title (a title or ISRC shared by several songs is left unmatched for you to assign); unmatched rows can be assigned or auto-link when you add the song, and the Statements page says whether nothing matched or several songs did. Each unmatched group also lists likely songs (similar titles, ignoring tags like "(Radio Edit)" or "feat. X") as one-click assign buttons; nothing is linked until you click, and there is no unassign.
- **MLC bulk match**: store an MLC Song Code on each registered song and download a CSV in the MLC's bulk-match format (`ISRC`, `MLC Song Code`) from the Catalog page. The file downloads as `BulkMatchSuggestions_YYYYMMDD.csv`; rename it to `MemberName_BulkMatchSuggestions_YYYYMMDD.csv` (the app cannot know your member name) and email it to bulk.matching@themlc.com, following the MLC's [bulk match instructions](https://pages.themlc.com/bulk-match-submission-process) (last confirmed 2026-10-24). The MLC currently quotes 30 to 90 days for a response, and that can change. The app cannot see which recordings the MLC has left unmatched, and it does not submit anything for you.
- **Dashboard**: earnings by period, track, platform, territory; date filter; CSV export.
- **Payments**: expected vs. received (pending/overdue/short), advances with recoupment against same-named sources.
- **Payouts**: each contributor's gross share of earnings from their splits, plus any earnings not covered by splits or not matched to a song (`/api/payouts/summary`). Payments to contributors aren't tracked, so nothing is netted.

## API notes

- Requests must come from localhost (`Host`/`Origin` are checked), and `POST`/`PUT` bodies must be sent as `Content-Type: application/json`.
- Statement import detects day-first vs month-first dates from the file. If every date is ambiguous (e.g. `05/03/2025`), the import is rejected until you pass `dateOrder: "dmy"` or `"mdy"`. Re-importing an identical statement needs `force: true`.
