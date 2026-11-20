const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const B58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export class ProbeError extends Error {}

const round2 = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
const usdInt = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : null);

export function isSolanaPubkey(s) {
  return typeof s === 'string' && B58_RE.test(s.trim());
}

async function fetchJsonSafe(url, init = {}, timeoutMs = 8500) {
  const host = new URL(url).host;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...init,
        headers: {
          accept: 'application/json',
          'user-agent': 'fennek-ears/1.0 (+https://fennek.fun)',
          ...(init.headers || {}),
        },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.ok) return await res.json();
      if ((res.status === 429 || res.status >= 500) && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      throw new ProbeError(`${host} returned HTTP ${res.status}`);
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof ProbeError) throw err;
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 900));
        continue;
      }
      throw new ProbeError(`${host} unreachable (${err?.name === 'AbortError' ? 'timeout' : err?.message || 'network error'})`);
    }
  }
}

async function cachedJson(env, key, ttlMs, loader) {
  const row = await env.DB.prepare('SELECT payload, cached_at FROM http_cache WHERE cache_key = ?').bind(key).first();
  if (row && Date.now() - Number(row.cached_at) < ttlMs) {
    return JSON.parse(row.payload);
  }
  const fresh = await loader();
  await env.DB.prepare(
    'INSERT INTO http_cache (cache_key, payload, cached_at) VALUES (?1, ?2, ?3) ON CONFLICT(cache_key) DO UPDATE SET payload = ?2, cached_at = ?3'
  )
    .bind(key, JSON.stringify(fresh), Date.now())
    .run();
  return fresh;
}

export async function solanaRpc(env, method, params) {
  const endpoints = Array.from(
    new Set(
      [
        env?.SOL_RPC_URL,
        'https://solana-rpc.publicnode.com',
        'https://api.mainnet-beta.solana.com',
      ].filter(Boolean)
    )
  );
  let lastErr = 'RPC unavailable';
  for (const ep of endpoints) {
    try {
      const data = await fetchJsonSafe(
        ep,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        },
        7500
      );
      if (data?.error) {
        lastErr = data.error.message || JSON.stringify(data.error);
        continue;
      }
      return data?.result;
    } catch (e) {
      lastErr = e?.message || String(e);
    }
  }
  throw new ProbeError(`Solana RPC ${method} failed: ${lastErr}`);
}

export async function checkReadOnlyBalance(env, wallet, mint) {
  if (!isSolanaPubkey(wallet) || !isSolanaPubkey(mint)) return 0;
  try {
    const [spl, t22] = await Promise.all([
      solanaRpc(env, 'getTokenAccountsByOwner', [wallet, { mint }, { encoding: 'jsonParsed' }]),
      solanaRpc(env, 'getTokenAccountsByOwner', [wallet, { programId: TOKEN_2022_PROGRAM }, { encoding: 'jsonParsed' }]),
    ]);
    let sum = 0;
    for (const a of spl?.value || []) {
      sum += Number(a?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0);
    }
    for (const a of t22?.value || []) {
      const info = a?.account?.data?.parsed?.info;
      if (info?.mint === mint) sum += Number(info?.tokenAmount?.uiAmount || 0);
    }
    return sum;
  } catch {
    return 0;
  }
}

const normalizeForCheck = (s) => String(s || '').toLowerCase().replace(/[\s"'`,$]/g, '');

export function checkVerbatimEvidence(stepRawJson, evidenceQuote) {
  const needle = normalizeForCheck(evidenceQuote);
  if (!stepRawJson) return { ok: false, note: 'cited step did not return tool output' };
  if (needle.length < 3) return { ok: false, note: 'evidence quote too short' };
  if (!/[0-9]/.test(needle) && needle.length < 8) {
    return { ok: false, note: 'evidence quote must contain an exact figure or field phrase' };
  }
  const hay = normalizeForCheck(stepRawJson);
  return hay.includes(needle)
    ? { ok: true, note: 'exact match in raw tool response' }
    : { ok: false, note: 'quote not present in cited tool output' };
}

export const SCOUT_TOOL_DEFS = [
  {
    name: 'burrow_search',
    description:
      'Search FENNEK shared memory (the Burrow) for verified findings from earlier digs by token ticker, address, protocol, or keyword.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword, ticker, protocol name, or Solana address.' },
        why: { type: 'string', description: 'Short plain note explaining why you are checking this.' },
      },
      required: ['query', 'why'],
    },
  },
  {
    name: 'token_lookup',
    description:
      'Cross-check a Solana token across BOTH Jupiter Token v2 AND DexScreener. Reports price, market cap, liquidity, holders, mint/freeze authorities, deployer mint count, and flags any cross-source mcap divergence (including native SOL vs Wrapped SOL wSOL).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Solana token mint address or ticker symbol.' },
        why: { type: 'string', description: 'Short plain note explaining why you are calling token_lookup.' },
      },
      required: ['query', 'why'],
    },
  },
  {
    name: 'chain_holders',
    description:
      'Read SPL / Token-2022 supply and top 10 largest token accounts directly from Solana JSON-RPC for a token mint.',
    parameters: {
      type: 'object',
      properties: {
        mint: { type: 'string', description: 'Base58 Solana token mint address.' },
        why: { type: 'string', description: 'Short plain note explaining why you are reading onchain holders.' },
      },
      required: ['mint', 'why'],
    },
  },
  {
    name: 'wallet_trace',
    description:
      'Read a Solana wallet or account directly from Solana JSON-RPC: SOL balance, owner program, recent transaction count, and recent signatures.',
    parameters: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Base58 Solana wallet or account address.' },
        why: { type: 'string', description: 'Short plain note explaining why you are tracing this address.' },
      },
      required: ['address', 'why'],
    },
  },
  {
    name: 'solana_defi',
    description:
      'Read Solana DeFi protocol TVL rankings, 24h DEX volume, or 24h protocol fees from DeFiLlama.',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['tvl', 'dex_volume', 'fees'],
          description: 'tvl for Solana protocol TVLs, dex_volume for 24h DEX volume, fees for 24h protocol fees.',
        },
        protocol_filter: {
          type: 'string',
          description: 'Optional protocol name/slug filter such as jito, kamino, jupiter, raydium, meteora.',
        },
        why: { type: 'string', description: 'Short plain note explaining why you are pulling Solana DeFi data.' },
      },
      required: ['mode', 'why'],
    },
  },
  {
    name: 'record_finding',
    description:
      'Save one verified Solana fact into the shared Burrow memory. evidence_quote MUST be copied verbatim from the JSON output of cited_step (e.g. `"dexscreener_mcap_usd":988412000` or `"dev_total_mints":7697`) so deterministic verification passes.',
    parameters: {
      type: 'object',
      properties: {
        claim: { type: 'string', description: 'One clear plain-English factual sentence with exact numbers and source.' },
        cited_step: { type: 'integer', description: 'Step number of the tool call whose output contains evidence_quote.' },
        evidence_quote: {
          type: 'string',
          description: 'Exact key-value or numeric substring copied verbatim from that step output.',
        },
        source_url: { type: 'string', description: 'Source URL returned by that tool step.' },
        entities: {
          type: 'array',
          items: { type: 'string' },
          description: '1 to 4 entity tags (mint addresses, tickers, or protocol slugs) for the memory graph.',
        },
      },
      required: ['claim', 'cited_step', 'evidence_quote'],
    },
  },
];

export async function executeScoutTool(env, name, args = {}) {
  if (name === 'burrow_search') {
    const q = String(args.query || '').trim().toLowerCase();
    let rows;
    if (!q) {
      rows = await env.DB.prepare(
        `SELECT id, dig_id, scout, claim, source_url, created_at FROM findings WHERE verified = 1 ORDER BY id DESC LIMIT 8`
      ).all();
    } else {
      rows = await env.DB.prepare(
        `SELECT id, dig_id, scout, claim, source_url, created_at FROM findings
         WHERE verified = 1 AND (LOWER(claim) LIKE ?1 OR LOWER(entities_json) LIKE ?1)
         ORDER BY id DESC LIMIT 8`
      )
        .bind(`%${q}%`)
        .all();
    }
    return {
      source: 'fennek://burrow',
      matches_count: (rows.results || []).length,
      findings: rows.results || [],
    };
  }

  if (name === 'token_lookup') {
    const q = String(args.query || '').trim();
    if (!q) throw new ProbeError('query is required');

    const jupUrl = `https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(q)}`;
    const jupArr = await fetchJsonSafe(jupUrl).catch(() => []);
    const tok =
      Array.isArray(jupArr) && jupArr.length
        ? jupArr.find((t) => t.id === q) ||
          jupArr.find((t) => String(t.symbol || '').toUpperCase() === q.replace(/^\$/, '').toUpperCase()) ||
          jupArr[0]
        : null;

    const targetMint = tok?.id || (isSolanaPubkey(q) ? q : '');
    const dexUrl = targetMint
      ? `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(targetMint)}`
      : `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`;

    const dexData = await fetchJsonSafe(dexUrl).catch(() => ({ pairs: [] }));
    const solPairs = (dexData?.pairs || [])
      .filter((p) => p.chainId === 'solana')
      .sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));

    if (!tok && solPairs.length === 0) {
      throw new ProbeError(`No Solana token or pair matched "${q}" on Jupiter or DexScreener`);
    }

    const topPoolPair = solPairs[0] || null;
    const mint = targetMint || topPoolPair?.baseToken?.address || q;
    const basePairs = solPairs.filter((p) => p.baseToken?.address === mint);
    const topPair = basePairs[0] || topPoolPair || null;
    const symbol = tok?.symbol || (topPair?.baseToken?.address === mint ? topPair?.baseToken?.symbol : null) || q;
    const jupMcap = usdInt(tok?.mcap);
    const dexMcap = topPair?.baseToken?.address === mint ? usdInt(topPair?.marketCap ?? topPair?.fdv) : null;

    // Special handling for Wrapped SOL (So1111...1112) & >25% cross-source divergence
    const isWrappedNativeSol = mint === WSOL_MINT;
    let crossSourceDivergence = false;
    let crossSourceNote = null;

    if (isWrappedNativeSol) {
      crossSourceDivergence = true;
      crossSourceNote =
        'So11111111111111111111111111111111111111112 is Wrapped SOL (wSOL). Jupiter reports native SOL chain market cap (~total SOL supply * price), whereas DexScreener reports only wrapped wSOL token FDV/marketCap inside SPL pools. Always distinguish both figures.';
    } else if (jupMcap && dexMcap && Math.max(jupMcap, dexMcap) / Math.max(1, Math.min(jupMcap, dexMcap)) > 1.25) {
      crossSourceDivergence = true;
      crossSourceNote = `Cross-source mcap divergence detected: Jupiter reports $${jupMcap} vs DexScreener $${dexMcap}. Cite both sources explicitly.`;
    }

    return {
      source_url: topPair?.url || `https://solscan.io/token/${mint}`,
      mint,
      name: tok?.name || topPair?.baseToken?.name || symbol,
      symbol,
      is_wrapped_native_sol: isWrappedNativeSol,
      price_usd: tok?.usdPrice ?? (topPair?.priceUsd ? Number(topPair.priceUsd) : null),
      ...(isWrappedNativeSol
        ? {
            native_sol_chain_mcap_usd: jupMcap,
            wrapped_wsol_spl_mcap_usd: dexMcap,
          }
        : {
            jupiter_mcap_usd: jupMcap,
            dexscreener_mcap_usd: dexMcap,
          }),
      cross_source_divergence: crossSourceDivergence,
      ...(crossSourceNote ? { cross_source_note: crossSourceNote } : {}),
      holders_count: tok?.holderCount ?? null,
      mint_authority_disabled: tok?.audit?.mintAuthorityDisabled ?? null,
      freeze_authority_disabled: tok?.audit?.freezeAuthorityDisabled ?? null,
      jupiter_top_holders_pct: round2(tok?.audit?.topHoldersPercentage),
      deployer_wallet: tok?.dev || null,
      dev_total_mints: tok?.audit?.devMints ?? null,
      dev_migrations: tok?.audit?.devMigrations ?? null,
      top_solana_pools: solPairs.slice(0, 3).map((p) => ({
        dex: p.dexId,
        pair_address: p.pairAddress,
        quote_symbol: p.quoteToken?.symbol,
        liquidity_usd: usdInt(p.liquidity?.usd),
        volume_24h_usd: usdInt(p.volume?.h24),
        buys_24h: p.txns?.h24?.buys ?? null,
        sells_24h: p.txns?.h24?.sells ?? null,
        price_change_1h_pct: round2(p.priceChange?.h1),
        price_change_24h_pct: round2(p.priceChange?.h24),
      })),
    };
  }

  if (name === 'chain_holders') {
    const mint = String(args.mint || '').trim();
    if (!isSolanaPubkey(mint)) throw new ProbeError('mint must be a valid base58 Solana address');

    if (mint === WSOL_MINT) {
      return {
        source_url: `https://solscan.io/token/${WSOL_MINT}`,
        mint: WSOL_MINT,
        is_wrapped_native_sol: true,
        note: 'Wrapped SOL (So111...1112) is the native SOL wrapper mint with millions of transient wrap accounts; Solana RPC getTokenLargestAccounts is intentionally skipped on native wSOL. Use token_lookup pool liquidity instead.',
      };
    }

    const [supplyRes, largestRes] = await Promise.all([
      solanaRpc(env, 'getTokenSupply', [mint]),
      solanaRpc(env, 'getTokenLargestAccounts', [mint]),
    ]);

    const totalUi = Number(supplyRes?.value?.uiAmount || 0);
    const accounts = largestRes?.value || [];
    const top1Ui = Number(accounts[0]?.uiAmount || 0);
    const top5Ui = accounts.slice(0, 5).reduce((s, a) => s + Number(a.uiAmount || 0), 0);
    const top10Ui = accounts.slice(0, 10).reduce((s, a) => s + Number(a.uiAmount || 0), 0);

    return {
      source_url: `https://solscan.io/token/${mint}#holders`,
      mint,
      slot: supplyRes?.context?.slot || null,
      decimals: supplyRes?.value?.decimals ?? null,
      total_supply_ui: round2(totalUi),
      top1_share_pct: totalUi > 0 ? round2((top1Ui / totalUi) * 100) : 0,
      top5_share_pct: totalUi > 0 ? round2((top5Ui / totalUi) * 100) : 0,
      top10_share_pct: totalUi > 0 ? round2((top10Ui / totalUi) * 100) : 0,
      largest_token_accounts: accounts.slice(0, 6).map((a) => ({
        token_account: a.address,
        ui_amount: round2(Number(a.uiAmount || 0)),
        share_pct: totalUi > 0 ? round2((Number(a.uiAmount || 0) / totalUi) * 100) : 0,
      })),
    };
  }

  if (name === 'wallet_trace') {
    const address = String(args.address || '').trim();
    if (!isSolanaPubkey(address)) throw new ProbeError('address must be a valid base58 Solana address');

    const [acctInfo, balRes, sigs] = await Promise.all([
      solanaRpc(env, 'getAccountInfo', [address, { encoding: 'jsonParsed' }]),
      solanaRpc(env, 'getBalance', [address]),
      solanaRpc(env, 'getSignaturesForAddress', [address, { limit: 20 }]),
    ]);

    const solBalance = Math.round((Number(balRes?.value || 0) / 1e9) * 10000) / 10000;
    const sigList = Array.isArray(sigs) ? sigs : [];
    const failedCount = sigList.filter((s) => s.err !== null).length;

    return {
      source_url: `https://solscan.io/account/${address}`,
      address,
      slot: balRes?.context?.slot || null,
      owner_program: acctInfo?.value?.owner || '11111111111111111111111111111111',
      sol_balance: solBalance,
      recent_tx_count: sigList.length,
      failed_recent_txs: failedCount,
      latest_tx_signature: sigList[0]?.signature || null,
      oldest_window_signature: sigList.at(-1)?.signature || null,
    };
  }

  if (name === 'solana_defi') {
    const mode = args.mode || 'tvl';
    const filter = String(args.protocol_filter || '').trim().toLowerCase();

    if (mode === 'dex_volume' || mode === 'fees') {
      const kind = mode === 'fees' ? 'fees' : 'dexs';
      const data = await cachedJson(env, `llama:${kind}:solana`, 15 * 60000, async () => {
        const raw = await fetchJsonSafe(
          `https://api.llama.fi/overview/${kind}/solana?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`
        );
        return {
          source_url: `https://defillama.com/${kind}/chains/solana`,
          total_24h_usd: usdInt(raw.total24h),
          total_7d_usd: usdInt(raw.total7d),
          change_1d_pct: round2(raw.change_1d),
          change_7d_pct: round2(raw.change_7d),
          leaders: (raw.protocols || [])
            .filter((p) => p.total24h > 0)
            .sort((a, b) => b.total24h - a.total24h)
            .slice(0, 15)
            .map((p) => ({
              name: p.displayName || p.name,
              category: p.category || kind,
              total_24h_usd: usdInt(p.total24h),
              total_7d_usd: usdInt(p.total7d),
              change_1d_pct: round2(p.change_1d),
            })),
        };
      });
      const filtered = filter
        ? data.leaders.filter((p) => p.name.toLowerCase().includes(filter))
        : data.leaders.slice(0, 10);
      return { ...data, leaders: filtered.length ? filtered : data.leaders.slice(0, 10) };
    }

    const tvlData = await cachedJson(env, 'llama:tvl:solana', 15 * 60000, async () => {
      const [chains, protocols] = await Promise.all([
        fetchJsonSafe('https://api.llama.fi/v2/chains'),
        fetchJsonSafe('https://api.llama.fi/protocols'),
      ]);
      const solChain = (chains || []).find((c) => String(c.name).toLowerCase() === 'solana');
      const solProtos = (protocols || [])
        .filter((p) => p.chainTvls?.Solana > 0 && p.category !== 'CEX')
        .map((p) => ({
          name: p.name,
          slug: p.slug,
          category: p.category,
          solana_tvl_usd: usdInt(p.chainTvls.Solana),
          change_1d_pct: round2(p.change_1d),
          change_7d_pct: round2(p.change_7d),
        }))
        .sort((a, b) => b.solana_tvl_usd - a.solana_tvl_usd);

      return {
        source_url: 'https://defillama.com/chain/Solana',
        solana_chain_tvl_usd: usdInt(solChain?.tvl),
        protocols_count: solProtos.length,
        top_protocols: solProtos.slice(0, 25),
      };
    });

    const list = filter
      ? tvlData.top_protocols.filter(
          (p) => p.name.toLowerCase().includes(filter) || p.slug.toLowerCase().includes(filter)
        )
      : tvlData.top_protocols.slice(0, 10);

    return {
      source_url: tvlData.source_url,
      solana_chain_tvl_usd: tvlData.solana_chain_tvl_usd,
      protocols_count: tvlData.protocols_count,
      protocols: list.length ? list : tvlData.top_protocols.slice(0, 10),
    };
  }

  throw new ProbeError(`Unknown tool: ${name}`);
}
