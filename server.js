// Royalty Tracker: dependency-free server (Node 22+, built-in node:sqlite).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createServer } from './routes.js';
import { relink } from './import.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Opens the database and starts listening. Importing this module does neither.
export function start() {
  const db = openDb(process.env.DB_FILE || path.join(__dirname, 'royalties.db'));
  relink(db); // fills match_reason on unmatched rows from before the column existed; a no-op otherwise
  const server = createServer(db);
  server.listen(PORT, '127.0.0.1', () => console.log(`Royalty Tracker running at http://localhost:${PORT}`));
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) start();
