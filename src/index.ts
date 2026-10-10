import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createDatabase } from './database.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const port = Number(process.env.PORT ?? 3002);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}
const path = process.env.DATABASE_PATH ?? './data/video-review.sqlite';
if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
const db = createDatabase(path);
const app = createApp({ db });
const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, ({ port }) => {
  console.log(`Video review API listening on http://127.0.0.1:${port}`);
});

function shutdown() {
  server.close(() => {
    db.close();
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
