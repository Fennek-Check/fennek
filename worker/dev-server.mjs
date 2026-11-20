import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sqliteD1 } from './d1-sqlite.mjs';
import { handle } from './src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '..', 'site');
const PORT = Number(process.env.PORT || 4355);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const env = {
  DB: sqliteD1(':memory:'),
  BRAND_NAME: 'FENNEK',
  TOKEN_SYMBOL: 'FENNEK',
  TOKEN_ADDRESS: process.env.TOKEN_ADDRESS || '',
  SOL_RPC_URL: process.env.SOL_RPC_URL || 'https://solana-rpc.publicnode.com',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  ASSETS: {
    async fetch(req) {
      let rel = decodeURIComponent(new URL(req.url).pathname);
      if (rel === '/') rel = '/index.html';
      let fp = path.join(SITE, rel);
      if (!fs.existsSync(fp) && fs.existsSync(fp + '.html')) fp += '.html';
      if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) return new Response('Not Found', { status: 404 });
      return new Response(fs.readFileSync(fp), {
        status: 200,
        headers: { 'content-type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' },
      });
    },
  },
};

http
  .createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const webRes = await handle(
      new Request(`http://localhost:${PORT}${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      }),
      env
    );
    res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
    res.end(Buffer.from(await webRes.arrayBuffer()));
  })
  .listen(PORT, () => console.log(`FENNEK Oasis Studio running at http://localhost:${PORT}`));
