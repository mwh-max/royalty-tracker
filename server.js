// Royalty Tracker: dependency-free server (Node 22+, built-in node:sqlite).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createServer } from './routes.js';

export { parseCsv, parseMoney, parseMoneyMicros, microsToString, detectDateOrder, normPeriod } from './parse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const db = openDb(process.env.DB_FILE || path.join(__dirname, 'royalties.db'));

export const server = createServer(db);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, '127.0.0.1', () => console.log(`Royalty Tracker running at http://localhost:${PORT}`));
}
