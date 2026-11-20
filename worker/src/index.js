import { SCOUTS, createAndRunDig, getDigById, chatWithFennek, runScheduledHouseDig } from './scouts.js';
import { checkReadOnlyBalance, executeScoutTool, isSolanaPubkey } from './tools.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, x-fennek-key, x-solana-wallet',
};

const TIERS = {
  free: { tier: 'free', label: 'Dune Visitor', minHold: 0, digsPerDay: 5, chatsPerDay: 25, mcpPerDay: 250, deep: false },
  scout: { tier: 'scout', label: 'Scout (>= 1M $FENNEK)', minHold: 1_000_000, digsPerDay: 20, chatsPerDay: 120, mcpPerDay: 5_000, deep: false },
  alpha: { tier: 'alpha', label: 'Alpha Ear (>= 5M $FENNEK)', minHold: 5_000_000, digsPerDay: 50, chatsPerDay: 400, mcpPerDay: 50_000, deep: true },
};

let bootPromise = null;
async function ensureWarmBurrow(env) {
  if (env.SKIP_BOOT_SEED === '1') return;
  const row = await env.DB.prepare(`SELECT COUNT(*) AS cnt FROM digs`).first();
  if (Number(row?.cnt || 0) > 0) return;
  if (bootPromise) return bootPromise;

  bootPromise = (async () => {
    try {
      await createAndRunDig(env, {
        scout: 'defi',
        question: 'Which Solana DeFi protocols lead by TVL today, and what is total Solana chain TVL?',
        sourceTag: 'house',
      });
      await createAndRunDig(env, {
        scout: 'pulse',
        question: 'Cross-check JUP (JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN) market cap, authorities, and top pool liquidity.',
        sourceTag: 'house',
      });
      await createAndRunDig(env, {
        scout: 'deployer',
        question: 'Inspect 7kGQp7UPiGVKapuFQrQn4e2EXKFgR6nrjWjETDxSpump: check authorities, deployer wallet SOL balance, and lifetime deployer mints.',
        sourceTag: 'house',
      });
    } catch (e) {
      console.error('Boot dig note:', e?.message || e);
    } finally {
      bootPromise = null;
    }
  })();
  return bootPromise;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
  });
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function resolveCaller(env, req, body = null) {
  const url = new URL(req.url);
  const auth = req.headers.get('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const apiKey = bearer || req.headers.get('x-fennek-key') || url.searchParams.get('key') || body?.apiKey || '';
  let wallet = req.headers.get('x-solana-wallet') || url.searchParams.get('wallet') || body?.wallet || '';
  wallet = isSolanaPubkey(wallet) ? wallet.trim() : '';

  let keyRow = null;
  if (apiKey.startsWith('fennek_')) {
    keyRow = await env.DB.prepare(`SELECT * FROM mcp_keys WHERE api_key = ?`).bind(apiKey).first();
    if (keyRow && !wallet && keyRow.wallet_address) wallet = keyRow.wallet_address;
  }

  const mint = (env.TOKEN_ADDRESS || '').trim();
  const tokenLive = isSolanaPubkey(mint);
  let balance = 0;
  let tierName = 'free';

  if (wallet && tokenLive) {
    if (keyRow && keyRow.wallet_address === wallet && Date.now() - Number(keyRow.checked_at || 0) < 300_000) {
      balance = Number(keyRow.cached_balance || 0);
    } else {
      balance = await checkReadOnlyBalance(env, wallet, mint);
      if (keyRow) {
        const t = balance >= Number(env.HOLD_ALPHA || 5_000_000) ? 'alpha' : balance >= Number(env.HOLD_SCOUT || 1_000_000) ? 'scout' : 'free';
        await env.DB.prepare(`UPDATE mcp_keys SET wallet_address = ?, cached_tier = ?, cached_balance = ?, checked_at = ? WHERE api_key = ?`)
          .bind(wallet, t, balance, Date.now(), apiKey)
          .run();
      }
    }
    if (balance >= Number(env.HOLD_ALPHA || 5_000_000)) tierName = 'alpha';
    else if (balance >= Number(env.HOLD_SCOUT || 1_000_000)) tierName = 'scout';
  }

  const ip = req.headers.get('cf-connecting-ip') || 'local';
  const actorKey = apiKey || wallet || `ip:${ip}`;
  const usage = await env.DB.prepare(`SELECT * FROM usage_counters WHERE actor_key = ? AND day_key = ?`)
    .bind(actorKey, todayKey())
    .first();

  const spec = TIERS[tierName];
  return {
    actorKey,
    wallet,
    balance,
    tokenLive,
    tokenMint: mint,
    tier: tierName,
    limits: spec,
    used: {
      digs: Number(usage?.digs_used || 0),
      chats: Number(usage?.chats_used || 0),
      mcp: Number(usage?.mcp_used || 0),
    },
  };
}

async function spendQuota(env, caller, field) {
  const col = field === 'mcp' ? 'mcp_used' : field === 'chats' ? 'chats_used' : 'digs_used';
  const cap = field === 'mcp' ? caller.limits.mcpPerDay : field === 'chats' ? caller.limits.chatsPerDay : caller.limits.digsPerDay;
  const cur = caller.used[field] || 0;
  if (cur >= cap) {
    return {
      ok: false,
      error: `Daily ${field} limit reached (${cap}/day on ${caller.tier} tier). Paste a public Solana address holding >= 1M $FENNEK (read-only, 0 signatures) for higher limits.`,
    };
  }
  await env.DB.prepare(
    `INSERT INTO usage_counters (actor_key, day_key, ${col}) VALUES (?, ?, 1)
     ON CONFLICT(actor_key, day_key) DO UPDATE SET ${col} = ${col} + 1`
  )
    .bind(caller.actorKey, todayKey())
    .run();
  return { ok: true };
}

const MCP_TOOLS = [
  {
    name: 'burrow_search',
    description: 'Search FENNEK shared Solana memory (the Burrow) for verified findings with verbatim upstream quotes and source links.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Token symbol, Solana mint/wallet address, or protocol keyword.' },
        limit: { type: 'number', description: 'Max findings to return (1-30, default 10).' },
      },
    },
  },
  {
    name: 'send_fennek_dig',
    description: 'Send a FENNEK scout out onto live Solana data (Jupiter, DexScreener, Solana RPC, DeFiLlama) and return verified findings.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Question, Solana token mint, or wallet address to investigate.' },
        scout: { type: 'string', enum: Object.keys(SCOUTS), description: 'Optional ear scout role.' },
      },
      required: ['question'],
    },
  },
  {
    name: 'ask_fennek',
    description: 'Ask FENNEK a direct question in fox chat; Fennek checks the Burrow and live Solana tools before replying.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Message or question for Fennek.' },
      },
      required: ['message'],
    },
  },
];

async function handleMcp(req, env) {
  if (req.method === 'GET') {
    return json({
      protocol: 'Model Context Protocol (JSON-RPC 2.0)',
      server: 'fennek-burrow-mcp',
      version: '1.0.0',
      endpoint: '/mcp',
      tools: MCP_TOOLS,
    });
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }
  const id = body?.id ?? null;
  const method = body?.method || '';
  const caller = await resolveCaller(env, req);

  if (method === 'initialize') {
    return json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'fennek-burrow-mcp', version: '1.0.0' },
        instructions: 'FENNEK listens underneath Solana. Query burrow_search for verified facts or call send_fennek_dig / ask_fennek for live Solana checks.',
      },
    });
  }
  if (method === 'notifications/initialized') return new Response(null, { status: 202, headers: CORS });
  if (method === 'ping') return json({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return json({ jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });

  if (method === 'tools/call') {
    const gate = await spendQuota(env, caller, 'mcp');
    if (!gate.ok) return json({ jsonrpc: '2.0', id, error: { code: -32029, message: gate.error } }, 429);

    const name = body?.params?.name || '';
    const args = body?.params?.arguments || {};
    try {
      let out;
      if (name === 'burrow_search') {
        const q = String(args.query || '').trim().toLowerCase();
        const lim = Math.min(30, Math.max(1, Number(args.limit || 10)));
        const rows = q
          ? await env.DB.prepare(
              `SELECT id, dig_id, scout, claim, evidence_quote, source_url, created_at FROM findings
               WHERE verified = 1 AND (LOWER(claim) LIKE ?1 OR LOWER(entities_json) LIKE ?1)
               ORDER BY id DESC LIMIT ?2`
            )
              .bind(`%${q}%`, lim)
              .all()
          : await env.DB.prepare(
              `SELECT id, dig_id, scout, claim, evidence_quote, source_url, created_at FROM findings WHERE verified = 1 ORDER BY id DESC LIMIT ?1`
            )
              .bind(lim)
              .all();
        out = { count: (rows.results || []).length, findings: rows.results || [] };
      } else if (name === 'send_fennek_dig') {
        const digGate = await spendQuota(env, caller, 'digs');
        if (!digGate.ok) throw new Error(digGate.error);
        const dig = await createAndRunDig(env, {
          question: String(args.question || ''),
          scout: args.scout || '',
          sourceTag: 'mcp',
          deep: caller.limits.deep,
        });
        out = {
          dig_id: dig.id,
          quality: dig.quality,
          summary: dig.summary,
          findings: dig.findings.filter((f) => f.verified === 1),
        };
      } else if (name === 'ask_fennek') {
        out = await chatWithFennek(env, [{ role: 'user', content: String(args.message || '') }]);
      } else {
        throw new Error(`Unknown MCP tool: ${name}`);
      }
      return json({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out, isError: false },
      });
    } catch (e) {
      return json({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `Error: ${e?.message || e}` }], isError: true },
      });
    }
  }

  return json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } }, 404);
}

export async function handle(req, env, ctx) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const { pathname } = url;

  if (pathname === '/llms.txt') {
    const mint = (env.TOKEN_ADDRESS || '').trim();
    const txt = `# FENNEK — Live Solana Scout Stream, Direct Fox Chat & Shared MCP Memory
> 90% ear, 10% fox. Listening underneath Solana.

- Live Studio & Chat: ${url.origin}
- Instant <1s Token Radar: ${url.origin}/v1/quick?q=JUP
- Streamable HTTP MCP (JSON-RPC 2.0): ${url.origin}/mcp
- Public Source Repository: ${env.GITHUB_URL || 'https://github.com/Fennek-Check/fennek'}
- Zero-Wallet Read-Only Tiering: Pass X-Solana-Wallet: <public_solana_address> or Bearer fennek_... key (verified via Solana RPC getTokenAccountsByOwner, zero signatures).
- Token ($${env.TOKEN_SYMBOL || 'FENNEK'}): ${mint || 'Not minted yet (pre-launch open mode)'}
`;
    return new Response(txt, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS } });
  }

  const warmBg = () => {
    const p = ensureWarmBurrow(env).catch(() => {});
    if (ctx?.waitUntil) ctx.waitUntil(p);
  };

  if (pathname === '/mcp' || pathname.startsWith('/mcp/')) {
    warmBg();
    return handleMcp(req, env);
  }

  if (pathname.startsWith('/v1/')) {
    warmBg();

    if (pathname === '/v1/quick' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return json({ error: 'Provide ?q=<mint_or_ticker>' }, 400);
      const t0 = Date.now();
      try {
        const directMint = isSolanaPubkey(q) ? q : '';
        const fastHolders = (m) =>
          Promise.race([
            executeScoutTool(env, 'chain_holders', { mint: m, why: 'RPC top-10 check' }).catch(() => null),
            new Promise((r) => setTimeout(() => r(null), 650)),
          ]);
        const [tok, preHolders] = await Promise.all([
          executeScoutTool(env, 'token_lookup', { query: q, why: 'Instant <1s radar check' }),
          directMint ? fastHolders(directMint) : Promise.resolve(null),
        ]);
        const holders = preHolders || (tok.mint && !directMint ? await fastHolders(tok.mint) : null);

        const topPool = tok.top_solana_pools?.[0] || null;
        const liq = topPool?.liquidity_usd ?? 0;
        const top10 = holders?.top10_share_pct ?? tok.jupiter_top_holders_pct ?? null;
        const flags = [];
        let level = 'safe';
        let badge = 'CLEAN SIGNAL';

        if (tok.is_wrapped_native_sol) {
          level = 'info';
          badge = 'NATIVE + WRAPPED';
          flags.push('Wrapped SOL (wSOL): Jupiter shows full SOL chain cap; DexScreener shows wrapped pool cap');
        } else {
          if (tok.mint_authority_disabled === false) {
            level = 'danger';
            badge = 'MINT ENABLED';
            flags.push('Mint authority is still active');
          }
          if (tok.freeze_authority_disabled === false) {
            if (level !== 'danger') {
              level = 'warn';
              badge = 'FREEZE ACTIVE';
            }
            flags.push('Freeze authority is active');
          }
          if (liq > 0 && liq < 12_000) {
            if (level === 'safe') {
              level = 'warn';
              badge = 'THIN POOL';
            }
            flags.push(`Thin top pool liquidity ($${liq.toLocaleString('en-US')})`);
          }
          if (top10 != null && top10 >= 50) {
            if (level === 'safe') {
              level = 'warn';
              badge = 'CONCENTRATED';
            }
            flags.push(`Top 10 accounts hold ${top10}% of supply`);
          }
          if (tok.dev_total_mints != null && tok.dev_total_mints >= 30) {
            level = 'danger';
            badge = 'SERIAL DEPLOYER';
            flags.push(`Deployer wallet minted ${tok.dev_total_mints} lifetime tokens`);
          }
          if (tok.cross_source_divergence) {
            flags.push('Cross-source mcap >25% divergence between Jupiter & DexScreener');
          }
          if (!flags.length) {
            flags.push('Mint & freeze disabled, cross-checked across Jupiter + DexScreener + Solana RPC');
          }
        }

        return json({
          latencyMs: Date.now() - t0,
          verdict: { level, badge, flags },
          token: tok,
          holders,
        });
      } catch (e) {
        return json({ error: e?.message || 'Token not found on Solana' }, 404);
      }
    }

    if (pathname === '/v1/status' && req.method === 'GET') {
      const [caller, stats] = await Promise.all([
        resolveCaller(env, req),
        env.DB.prepare(
          `SELECT
            (SELECT COUNT(*) FROM digs) AS total_digs,
            (SELECT COUNT(*) FROM findings WHERE verified = 1) AS verified_findings,
            (SELECT COUNT(*) FROM findings) AS all_findings`
        ).first(),
      ]);
      const ver = Number(stats?.verified_findings || 0);
      const all = Number(stats?.all_findings || 0);
      return json({
        brand: env.BRAND_NAME || 'FENNEK',
        symbol: env.TOKEN_SYMBOL || 'FENNEK',
        tokenAddress: (env.TOKEN_ADDRESS || '').trim(),
        tokenLive: caller.tokenLive,
        xUrl: env.X_URL || '',
        githubUrl: env.GITHUB_URL || '',
        stats: {
          totalDigs: Number(stats?.total_digs || 0),
          verifiedFindings: ver,
          matchRatePct: all > 0 ? Math.round((ver / all) * 1000) / 10 : 100,
        },
        scouts: Object.values(SCOUTS),
        tiers: TIERS,
        caller,
      });
    }

    if (pathname === '/v1/digs' && req.method === 'GET') {
      const scout = (url.searchParams.get('scout') || '').trim().toLowerCase();
      const limit = Math.min(40, Math.max(1, Number(url.searchParams.get('limit') || 20)));
      const rows = scout && SCOUTS[scout]
        ? await env.DB.prepare(`SELECT * FROM digs WHERE scout = ? ORDER BY id DESC LIMIT ?`).bind(scout, limit).all()
        : await env.DB.prepare(`SELECT * FROM digs ORDER BY id DESC LIMIT ?`).bind(limit).all();
      return json({ digs: rows.results || [] });
    }

    if (pathname.startsWith('/v1/digs/') && req.method === 'GET') {
      const id = Number(pathname.slice('/v1/digs/'.length));
      const dig = await getDigById(env, id);
      if (!dig) return json({ error: 'Dig not found' }, 404);
      return json({ dig });
    }

    if (pathname === '/v1/digs' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const question = String(body?.question || '').trim();
      if (question.length < 3) return json({ error: 'Ask a question or paste a Solana address.' }, 400);

      const caller = await resolveCaller(env, req, body);
      const gate = await spendQuota(env, caller, 'digs');
      if (!gate.ok) return json({ error: gate.error, caller }, 429);

      const dig = await createAndRunDig(env, {
        question,
        scout: body?.scout || '',
        sourceTag: caller.tier === 'free' ? 'visitor' : caller.tier,
        deep: caller.limits.deep,
      });
      return json({ dig, caller }, 201);
    }

    if (pathname === '/v1/chat' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const caller = await resolveCaller(env, req, body);
      const gate = await spendQuota(env, caller, 'chats');
      if (!gate.ok) return json({ error: gate.error, caller }, 429);

      const out = await chatWithFennek(env, body?.messages || []);
      return json({ ...out, caller });
    }

    if (pathname === '/v1/findings' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const verifiedOnly = url.searchParams.get('all') !== '1';
      let sql = `SELECT * FROM findings WHERE 1=1`;
      const binds = [];
      if (verifiedOnly) sql += ` AND verified = 1`;
      if (q) {
        sql += ` AND (LOWER(claim) LIKE ? OR LOWER(entities_json) LIKE ?)`;
        binds.push(`%${q}%`, `%${q}%`);
      }
      sql += ` ORDER BY id DESC LIMIT 50`;
      const rows = await env.DB.prepare(sql).bind(...binds).all();
      return json({ findings: rows.results || [] });
    }

    if (pathname === '/v1/graph' && req.method === 'GET') {
      const rows = await env.DB.prepare(`SELECT id, dig_id, scout, claim, entities_json FROM findings WHERE verified = 1 ORDER BY id DESC LIMIT 80`).all();
      const nodeCount = new Map();
      const edgeMap = new Map();

      for (const r of rows.results || []) {
        let ents = [];
        try {
          ents = JSON.parse(r.entities_json || '[]');
        } catch {}
        for (const e of ents) {
          nodeCount.set(e, (nodeCount.get(e) || 0) + 1);
        }
        for (let i = 0; i < ents.length; i++) {
          for (let j = i + 1; j < ents.length; j++) {
            const [a, b] = [ents[i], ents[j]].sort();
            const k = `${a}::${b}`;
            edgeMap.set(k, { source: a, target: b, weight: (edgeMap.get(k)?.weight || 0) + 1 });
          }
        }
      }

      const nodes = [...nodeCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 22)
        .map(([id, count]) => ({
          id,
          label: id.length > 16 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id.toUpperCase(),
          count,
        }));
      const keep = new Set(nodes.map((n) => n.id));
      const edges = [...edgeMap.values()].filter((e) => keep.has(e.source) && keep.has(e.target));
      return json({ nodes, edges });
    }

    if (pathname === '/v1/mcp-keys' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const wallet = isSolanaPubkey(body?.wallet) ? body.wallet.trim() : '';
      const label = String(body?.label || 'cursor-agent').slice(0, 40);
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      const apiKey = `fennek_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;

      await env.DB.prepare(
        `INSERT INTO mcp_keys (api_key, wallet_address, label, created_at) VALUES (?, ?, ?, ?)`
      )
        .bind(apiKey, wallet, label, Date.now())
        .run();

      const caller = await resolveCaller(env, new Request(req.url, { headers: { 'x-fennek-key': apiKey } }));
      return json({ apiKey, wallet, tier: caller.tier, limits: caller.limits }, 201);
    }

    if (pathname === '/v1/tier' && req.method === 'GET') {
      return json(await resolveCaller(env, req));
    }

    return json({ error: 'Not found' }, 404);
  }

  if (env.ASSETS) return env.ASSETS.fetch(req);
  return new Response('FENNEK Live', { status: 200 });
}

export default {
  fetch: handle,
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runScheduledHouseDig(env));
  },
};
