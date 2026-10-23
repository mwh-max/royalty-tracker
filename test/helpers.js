// Test harness: each call builds its own in-memory database and HTTP server around it.
import http from 'node:http';
import { openDb } from '../db.js';
import { createServer } from '../routes.js';

export function createTestApp() {
  const db = openDb(':memory:');
  const server = createServer(db);
  const app = { db, server, base: '' };

  app.start = async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    app.base = `http://127.0.0.1:${server.address().port}`;
  };
  app.stop = () => server.close();

  app.call = async (method, path, body) => {
    const res = await fetch(app.base + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    return { status: res.status, data };
  };

  // bare http request, for tests that need to control headers (Host, Origin, Content-Type)
  app.raw = (method, path, { headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const port = server.address().port;
      const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.end(body);
    });

  return app;
}
