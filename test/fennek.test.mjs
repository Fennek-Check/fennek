import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sqliteD1 } from '../worker/d1-sqlite.mjs';
import { handle } from '../worker/src/index.js';
import { checkVerbatimEvidence } from '../worker/src/tools.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '..', 'site');

function makeTestEnv() {
  return {
    DB: sqliteD1(':memory:'),
    BRAND_NAME: 'FENNEK',
    TOKEN_SYMBOL: 'FENNEK',
    TOKEN_ADDRESS: '',
    SKIP_BOOT_SEED: '1',
    SOL_RPC_URL: 'https://solana-rpc.publicnode.com',
  };
}

test('checkVerbatimEvidence accepts exact JSON figures and rejects fabricated numbers', () => {
  const raw = JSON.stringify({ symbol: 'JUP', dexscreener_mcap_usd: 812345678, mint_authority_disabled: true });
  assert.equal(checkVerbatimEvidence(raw, '"dexscreener_mcap_usd":812345678').ok, true);
  assert.equal(checkVerbatimEvidence(raw, '"dexscreener_mcap_usd":999999999').ok, false);
});

test('Wrapped SOL (So1111...1112) Larpcheck trap reports BOTH native SOL cap and wrapped wSOL pool cap with 0 failed probes', async () => {
  const env = makeTestEnv();
  const res = await handle(
    new Request('http://localhost/v1/digs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'So11111111111111111111111111111111111111112' }),
    }),
    env
  );
  assert.equal(res.status, 201);
  const { dig } = await res.json();
  assert.equal(dig.status, 'done');
  assert.equal(dig.failed_probes, 0, `Expected 0 failed probes on Wrapped SOL, got ${dig.failed_probes}`);
  assert.equal(dig.quality, 'verified');
  assert.ok(dig.matched_count >= 1, 'Expected at least 1 verbatim-verified finding on Wrapped SOL');
  assert.match(dig.summary, /Wrapped SOL/i);
  assert.match(dig.summary, /DexScreener/i);
});

test('Live Fox Chat (/v1/chat) answers Wrapped SOL accurately and logs listened tools', async () => {
  const env = makeTestEnv();
  const res = await handle(
    new Request('http://localhost/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Check So11111111111111111111111111111111111111112' }],
      }),
    }),
    env
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.reply.includes('Wrapped SOL'), `Unexpected chat reply: ${body.reply}`);
  assert.ok(Array.isArray(body.listened) && body.listened.length >= 1);
});

test('Streamable HTTP MCP (/mcp) responds to JSON-RPC 2.0 initialize, tools/list, and burrow_search', async () => {
  const env = makeTestEnv();
  // Create one dig first
  await handle(
    new Request('http://localhost/v1/digs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'Which Solana DeFi protocols lead by TVL right now?', scout: 'defi' }),
    }),
    env
  );

  const listRes = await handle(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }),
    env
  );
  const listJson = await listRes.json();
  assert.equal(listJson.result.tools.length, 3);

  const callRes = await handle(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'burrow_search', arguments: { limit: 5 } },
      }),
    }),
    env
  );
  const callJson = await callRes.json();
  assert.equal(callJson.result.isError, false);
  assert.ok(callJson.result.structuredContent.count >= 1);
});

test('Instant <1s radar (/v1/quick) returns CLEAN SIGNAL on JUP and NATIVE + WRAPPED on wSOL', async () => {
  const env = makeTestEnv();
  const r1 = await handle(new Request('http://localhost/v1/quick?q=So11111111111111111111111111111111111111112'), env);
  assert.equal(r1.status, 200);
  const d1 = await r1.json();
  assert.equal(d1.verdict.badge, 'NATIVE + WRAPPED');
  assert.equal(d1.token.is_wrapped_native_sol, true);

  const r2 = await handle(new Request('http://localhost/v1/quick?q=JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'), env);
  assert.equal(r2.status, 200);
  const d2 = await r2.json();
  assert.equal(d2.token.symbol, 'JUP');
});

test('Static site passes Larpcheck anti-red-flag audit (no bare github.com, no fake buyback promises, no fake npx)', () => {
  const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(SITE, 'app.js'), 'utf8');
  const combined = `${html}\n${js}`;

  assert.doesNotMatch(combined, /href=["']https?:\/\/github\.com\/?["']/i);
  assert.doesNotMatch(combined, /buyback\s*(and|&)\s*burn/i);
  assert.doesNotMatch(combined, /npx\s+-y\s+@?fennek/i);
});
