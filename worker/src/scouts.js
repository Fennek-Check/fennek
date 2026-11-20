import { SCOUT_TOOL_DEFS, executeScoutTool, checkVerbatimEvidence, ProbeError, isSolanaPubkey } from './tools.js';
import { createAgentSession } from './llm.js';

export const SCOUTS = {
  pulse: {
    id: 'pulse',
    name: 'Pulse Ear',
    focus: 'Live prices, DEX liquidity, 24h volume, and cross-source market cap checks on Solana.',
    prompts: ['Cross-check JUP liquidity and market cap across Jupiter and DexScreener', 'Compare Wrapped SOL native cap vs wrapped SPL pool cap'],
  },
  deployer: {
    id: 'deployer',
    name: 'Track Ear',
    focus: 'Deployer wallets, lifetime token mint counts, migrations, and recent onchain activity.',
    prompts: ['Trace deployer history and mint count on 7kGQp7UPiGVKapuFQrQn4e2EXKFgR6nrjWjETDxSpump'],
  },
  holders: {
    id: 'holders',
    name: 'Pack Ear',
    focus: 'SPL and Token-2022 supply plus top-10 largest holder accounts straight from Solana RPC.',
    prompts: ['Read BONK top-10 holder share directly from Solana RPC'],
  },
  defi: {
    id: 'defi',
    name: 'Oasis Ear',
    focus: 'Solana DeFi protocol TVLs, 24h DEX volume leaders, and protocol fees via DeFiLlama.',
    prompts: ['Which Solana DeFi protocols lead by TVL right now and how did they shift over 24h?'],
  },
  launch: {
    id: 'launch',
    name: 'Dune Ear',
    focus: 'Small and new Solana tokens: mint/freeze authorities, liquidity depth, and buy/sell balance.',
    prompts: ['Check authorities, holders, and pool depth on POPCAT'],
  },
  burrow: {
    id: 'burrow',
    name: 'Memory Ear',
    focus: 'Connects earlier verified findings in the Burrow and checks what changed onchain since.',
    prompts: ['What does the Burrow already hold on Solana DeFi and JUP?'],
  },
};

export const HOUSE_ROTATION = [
  ['defi', 'Which Solana DeFi protocols lead by TVL today, and what is total Solana chain TVL?'],
  ['holders', 'Read the BONK mint (DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263): supply, authorities, and top-10 holder share on Solana RPC.'],
  ['pulse', 'Cross-check JUP (JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN) market cap, top DEX pool liquidity, and 24h volume.'],
  ['deployer', 'Inspect 7kGQp7UPiGVKapuFQrQn4e2EXKFgR6nrjWjETDxSpump: check authorities, deployer wallet SOL balance, and lifetime deployer mint count.'],
  ['defi', 'Which DEX protocols carry the most 24h trading volume on Solana right now?'],
];

export function routeScoutForQuestion(question, requested = '') {
  if (requested && SCOUTS[requested]) return requested;
  const q = String(question || '').toLowerCase();
  if (/(tvl|defi|lending|staking|protocol|jito|kamino|fees|dex volume)/.test(q)) return 'defi';
  if (/(deployer|creator|who minted|dev wallet|trace wallet)/.test(q)) return 'deployer';
  if (/(holder|top 10|concentration|supply|largest account)/.test(q)) return 'holders';
  if (/(pump|authority|mintable|freeze|new token)/.test(q)) return 'launch';
  return 'pulse';
}

function extractSolanaAddress(text) {
  const m = String(text || '').match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);
  if (!m) return '';
  return m.find((x) => x.endsWith('pump')) || m[0] || '';
}

const DIG_SYSTEM = (scout) => `You are the ${scout.name} of FENNEK, a desert fennec fox scout listening underneath the Solana blockchain.
Focus: ${scout.focus}

Rules:
1. Call 2 to 5 read-only tools (start with burrow_search or go straight to token_lookup / chain_holders / wallet_trace / solana_defi).
2. Every number you report MUST come directly from a tool output in this dig. Never invent or guess a figure.
3. If token_lookup flags cross_source_divergence or is_wrapped_native_sol (e.g. Wrapped SOL So1111...1112), explicitly report BOTH native_sol_chain_mcap_usd and wrapped_wsol_spl_mcap_usd so there is zero ambiguity.
4. Call record_finding 2 to 4 times with exact verbatim substrings copied from the tool step JSON (e.g. '"solana_chain_tvl_usd":8420000000').
5. Finish with a concise plain-text field note (first sentence answers the question directly, followed by 2-4 "- " bullet lines). No markdown bold, no emojis, no financial advice.`;

const CHAT_SYSTEM = `You are FENNEK — a small desert fennec fox (90% ear, 10% fox) listening underneath Solana on fennek.fun.
Voice: warm, sharp, observant first-person voice. Short crisp sentences (2 to 6 lines). Zero emojis, zero hashtags, zero markdown bold (**), zero hype, zero buy/sell financial advice.

How you work:
- Before stating any live figure about a Solana token, wallet, or DeFi protocol, call burrow_search or a live tool (token_lookup, chain_holders, wallet_trace, solana_defi).
- Only cite numbers returned by tools in this conversation and name the upstream source (Jupiter, DexScreener, Solana RPC, DeFiLlama, or the Burrow).
- If Wrapped SOL (So1111...1112) or any cross-source mcap divergence appears, state both numbers clearly (native SOL chain cap vs wrapped wSOL pool cap).
- You never ask for private keys or wallet connections.`;

function autoExtractDeterministicFindings(stepNo, toolName, toolOutput) {
  const out = [];
  if (!toolOutput || typeof toolOutput !== 'object') return out;
  const src = toolOutput.source_url || 'https://solscan.io';

  if (toolName === 'token_lookup') {
    const sym = toolOutput.symbol || 'Token';
    const ents = [toolOutput.mint, sym.toLowerCase()].filter(Boolean);
    if (toolOutput.is_wrapped_native_sol) {
      if (toolOutput.native_sol_chain_mcap_usd != null && toolOutput.wrapped_wsol_spl_mcap_usd != null) {
        out.push({
          claim: `Wrapped SOL (${sym}) shows $${toolOutput.native_sol_chain_mcap_usd.toLocaleString('en-US')} native SOL chain market cap on Jupiter versus $${toolOutput.wrapped_wsol_spl_mcap_usd.toLocaleString('en-US')} wrapped wSOL pool market cap on DexScreener.`,
          cited_step: stepNo,
          evidence_quote: `"wrapped_wsol_spl_mcap_usd":${toolOutput.wrapped_wsol_spl_mcap_usd}`,
          source_url: src,
          entities: ents,
        });
      } else if (toolOutput.native_sol_chain_mcap_usd != null) {
        out.push({
          claim: `Wrapped SOL (${sym}) reports $${toolOutput.native_sol_chain_mcap_usd.toLocaleString('en-US')} native SOL chain market cap on Jupiter (DexScreener pairs quote wrapped wSOL pool liquidity separately).`,
          cited_step: stepNo,
          evidence_quote: `"native_sol_chain_mcap_usd":${toolOutput.native_sol_chain_mcap_usd}`,
          source_url: src,
          entities: ents,
        });
      } else if (toolOutput.wrapped_wsol_spl_mcap_usd != null) {
        out.push({
          claim: `Wrapped SOL (${sym}) reports $${toolOutput.wrapped_wsol_spl_mcap_usd.toLocaleString('en-US')} wrapped wSOL SPL pool market cap on DexScreener (distinct from full native SOL chain supply).`,
          cited_step: stepNo,
          evidence_quote: `"wrapped_wsol_spl_mcap_usd":${toolOutput.wrapped_wsol_spl_mcap_usd}`,
          source_url: src,
          entities: ents,
        });
      }
    } else {
      const mc = toolOutput.dexscreener_mcap_usd ?? toolOutput.jupiter_mcap_usd;
      const mcKey = toolOutput.dexscreener_mcap_usd != null ? 'dexscreener_mcap_usd' : 'jupiter_mcap_usd';
      if (mc != null) {
        if (toolOutput.cross_source_divergence && toolOutput.jupiter_mcap_usd && toolOutput.dexscreener_mcap_usd) {
          out.push({
            claim: `${sym} reports $${toolOutput.dexscreener_mcap_usd.toLocaleString('en-US')} market cap on DexScreener vs $${toolOutput.jupiter_mcap_usd.toLocaleString('en-US')} on Jupiter (cross-source divergence flagged).`,
            cited_step: stepNo,
            evidence_quote: `"dexscreener_mcap_usd":${toolOutput.dexscreener_mcap_usd}`,
            source_url: src,
            entities: ents,
          });
        } else {
          out.push({
            claim: `${sym} market cap is $${mc.toLocaleString('en-US')}.`,
            cited_step: stepNo,
            evidence_quote: `"${mcKey}":${mc}`,
            source_url: src,
            entities: ents,
          });
        }
      }
    }
    if (toolOutput.mint_authority_disabled !== null && toolOutput.mint_authority_disabled !== undefined) {
      out.push({
        claim: `${sym} mint authority disabled is ${toolOutput.mint_authority_disabled}.`,
        cited_step: stepNo,
        evidence_quote: `"mint_authority_disabled":${toolOutput.mint_authority_disabled}`,
        source_url: src,
        entities: ents,
      });
    }
    if (toolOutput.dev_total_mints != null && toolOutput.deployer_wallet) {
      out.push({
        claim: `Deployer ${toolOutput.deployer_wallet.slice(0, 4)}…${toolOutput.deployer_wallet.slice(-4)} has minted ${toolOutput.dev_total_mints} lifetime token(s) on Solana.`,
        cited_step: stepNo,
        evidence_quote: `"dev_total_mints":${toolOutput.dev_total_mints}`,
        source_url: `https://solscan.io/account/${toolOutput.deployer_wallet}`,
        entities: [...ents, toolOutput.deployer_wallet],
      });
    }
    const topPool = toolOutput.top_solana_pools?.[0];
    if (topPool?.liquidity_usd != null) {
      out.push({
        claim: `Top ${sym} ${topPool.dex} pool holds $${topPool.liquidity_usd.toLocaleString('en-US')} in liquidity.`,
        cited_step: stepNo,
        evidence_quote: `"liquidity_usd":${topPool.liquidity_usd}`,
        source_url: src,
        entities: ents,
      });
    }
  } else if (toolName === 'chain_holders' && !toolOutput.is_wrapped_native_sol) {
    if (toolOutput.top10_share_pct != null) {
      out.push({
        claim: `Top 10 accounts hold ${toolOutput.top10_share_pct}% of ${toolOutput.mint.slice(0, 6)}… supply on Solana RPC.`,
        cited_step: stepNo,
        evidence_quote: `"top10_share_pct":${toolOutput.top10_share_pct}`,
        source_url: src,
        entities: [toolOutput.mint],
      });
    }
  } else if (toolName === 'wallet_trace') {
    if (toolOutput.sol_balance != null) {
      out.push({
        claim: `Wallet ${toolOutput.address.slice(0, 4)}…${toolOutput.address.slice(-4)} holds ${toolOutput.sol_balance} SOL across ${toolOutput.recent_tx_count} recent txs.`,
        cited_step: stepNo,
        evidence_quote: `"sol_balance":${toolOutput.sol_balance}`,
        source_url: src,
        entities: [toolOutput.address],
      });
    }
  } else if (toolName === 'solana_defi') {
    if (toolOutput.solana_chain_tvl_usd != null) {
      out.push({
        claim: `Total Solana DeFi TVL is $${toolOutput.solana_chain_tvl_usd.toLocaleString('en-US')} on DeFiLlama.`,
        cited_step: stepNo,
        evidence_quote: `"solana_chain_tvl_usd":${toolOutput.solana_chain_tvl_usd}`,
        source_url: src,
        entities: ['solana-defi'],
      });
      const lead = toolOutput.protocols?.[0];
      if (lead?.solana_tvl_usd != null) {
        out.push({
          claim: `${lead.name} leads with $${lead.solana_tvl_usd.toLocaleString('en-US')} Solana TVL (${lead.change_1d_pct}% 24h).`,
          cited_step: stepNo,
          evidence_quote: `"solana_tvl_usd":${lead.solana_tvl_usd}`,
          source_url: src,
          entities: ['solana-defi', lead.slug || lead.name.toLowerCase()],
        });
      }
    } else if (toolOutput.total_24h_usd != null) {
      out.push({
        claim: `Solana 24h DEX volume reached $${toolOutput.total_24h_usd.toLocaleString('en-US')} on DeFiLlama.`,
        cited_step: stepNo,
        evidence_quote: `"total_24h_usd":${toolOutput.total_24h_usd}`,
        source_url: src,
        entities: ['solana-dex'],
      });
    }
  }
  return out;
}

export async function createAndRunDig(env, { question, scout: requestedScout = '', sourceTag = 'visitor', deep = false }) {
  const db = env.DB;
  const cleanQ = String(question || '').trim();
  const scoutId = routeScoutForQuestion(cleanQ, requestedScout);
  const scout = SCOUTS[scoutId] || SCOUTS.pulse;
  const startedAt = Date.now();

  const ins = await db
    .prepare(`INSERT INTO digs (scout, question, status, quality, source_tag, started_at) VALUES (?, ?, 'running', 'pending', ?, ?)`)
    .bind(scoutId, cleanQ, sourceTag, startedAt)
    .run();
  const digId = Number(ins.meta?.last_row_id || 1);

  let stepNo = 0;
  const stepOutputs = new Map();
  const structuredSteps = [];
  let matchedCount = 0;
  let unmatchedCount = 0;
  let failedProbes = 0;
  let finalSummary = '';

  async function appendStep(kind, toolName, why, bodyObjOrStr, ok = true, latencyMs = 0) {
    stepNo += 1;
    const bodyStr = typeof bodyObjOrStr === 'string' ? bodyObjOrStr : JSON.stringify(bodyObjOrStr);
    await db
      .prepare(
        `INSERT INTO dig_steps (dig_id, step_no, kind, tool_name, why, body, ok, latency_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(digId, stepNo, kind, toolName, why, bodyStr.slice(0, 18000), ok ? 1 : 0, latencyMs, Date.now())
      .run();
    return { stepNo, bodyStr };
  }

  async function saveFindingCandidate({ claim, cited_step, evidence_quote, source_url = '', entities = [] }) {
    const rawStep = stepOutputs.get(Number(cited_step)) || '';
    const check = checkVerbatimEvidence(rawStep, evidence_quote);
    if (check.ok) matchedCount += 1;
    else unmatchedCount += 1;

    const cleanEnts = Array.isArray(entities)
      ? [...new Set(entities.map((e) => String(e || '').trim()).filter(Boolean))].slice(0, 5)
      : [];

    await db
      .prepare(
        `INSERT INTO findings (dig_id, scout, claim, evidence_quote, cited_step, source_url, entities_json, verified, verify_note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        digId,
        scoutId,
        String(claim || '').trim(),
        String(evidence_quote || '').trim(),
        Number(cited_step || 0),
        String(source_url || ''),
        JSON.stringify(cleanEnts),
        check.ok ? 1 : 0,
        check.note,
        Date.now()
      )
      .run();
  }

  async function runOneProbe(toolName, args) {
    const t0 = Date.now();
    try {
      const data = await executeScoutTool(env, toolName, args);
      const latency = Date.now() - t0;
      const logged = await appendStep('tool', toolName, String(args.why || ''), data, true, latency);
      stepOutputs.set(logged.stepNo, logged.bodyStr);
      structuredSteps.push({ stepNo: logged.stepNo, toolName, data });
      return { ok: true, stepNo: logged.stepNo, content: logged.bodyStr.slice(0, 9000) };
    } catch (err) {
      failedProbes += 1;
      const latency = Date.now() - t0;
      const msg = err instanceof ProbeError ? err.message : String(err?.message || err);
      await appendStep('error', toolName, String(args.why || ''), { error: msg }, false, latency);
      return { ok: false, stepNo, content: JSON.stringify({ error: msg }), isError: true };
    }
  }

  const session = createAgentSession(env, {
    system: DIG_SYSTEM(scout),
    tools: SCOUT_TOOL_DEFS,
    user: `Dig #${digId} (${new Date().toISOString().slice(0, 10)} UTC):\n${cleanQ}`,
  });

  if (session) {
    const maxTurns = deep ? 10 : 6;
    try {
      for (let turn = 1; turn <= maxTurns; turn++) {
        const { text, calls } = await session.nextTurn({ forceText: turn === maxTurns });
        if (!calls.length) {
          if (text) finalSummary = text;
          break;
        }
        const toolReplies = [];
        for (const call of calls) {
          if (call.name === 'record_finding') {
            await saveFindingCandidate(call.args || {});
            toolReplies.push({
              id: call.id,
              name: call.name,
              content: JSON.stringify({ recorded: true }),
            });
          } else {
            const r = await runOneProbe(call.name, call.args || {});
            toolReplies.push({
              id: call.id,
              name: call.name,
              content: r.content,
              isError: r.isError,
            });
          }
        }
        session.submitToolOutputs(
          toolReplies,
          turn === maxTurns - 1 ? 'Now write the concise plain-text summary of what matched.' : ''
        );
      }
    } catch (llmErr) {
      await appendStep('note', 'llm_fallback', 'Model turn interrupted; completing from live probes', String(llmErr?.message || llmErr), true, 0);
    }
  }

  // If no probes ran yet (e.g. offline test without AI binding, or LLM jumped straight to text), run grounded probes!
  if (structuredSteps.length === 0) {
    await runOneProbe('burrow_search', { query: extractSolanaAddress(cleanQ) || cleanQ.slice(0, 24), why: 'Check earlier Burrow memory first' });
    const addr = extractSolanaAddress(cleanQ);
    if (scoutId === 'defi' && !addr) {
      const mode = /volume|dex/i.test(cleanQ) ? 'dex_volume' : /fee/i.test(cleanQ) ? 'fees' : 'tvl';
      await runOneProbe('solana_defi', { mode, why: 'Pull live Solana DeFi metrics from DeFiLlama' });
    } else if (addr) {
      const tk = await runOneProbe('token_lookup', { query: addr, why: 'Cross-check token on Jupiter v2 and DexScreener' });
      const parsedTk = tk.ok ? JSON.parse(tk.content) : null;
      if (parsedTk?.mint) {
        await runOneProbe('chain_holders', { mint: parsedTk.mint, why: 'Read supply & top-10 accounts on Solana RPC' });
        if (parsedTk.deployer_wallet && isSolanaPubkey(parsedTk.deployer_wallet)) {
          await runOneProbe('wallet_trace', { address: parsedTk.deployer_wallet, why: 'Check deployer SOL balance and recent tx count' });
        }
      } else {
        await runOneProbe('wallet_trace', { address: addr, why: 'Inspect Solana wallet directly via RPC' });
      }
    } else {
      const tickerMatch = cleanQ.match(/\b(SOL|JUP|BONK|WIF|POPCAT|RAY|JTO|PYTH|ORCA)\b/i);
      if (tickerMatch) {
        const tk = await runOneProbe('token_lookup', { query: tickerMatch[1], why: `Lookup ${tickerMatch[1]} across Jupiter and DexScreener` });
        const parsedTk = tk.ok ? JSON.parse(tk.content) : null;
        if (parsedTk?.mint) {
          await runOneProbe('chain_holders', { mint: parsedTk.mint, why: 'Verify holder distribution on Solana RPC' });
        }
      } else {
        await runOneProbe('solana_defi', { mode: 'tvl', why: 'Pull live Solana DeFi overview' });
      }
    }
  }

  // Ensure findings exist if the LLM forgot to invoke record_finding after calling live probes
  if (matchedCount === 0 && structuredSteps.length > 0) {
    for (const st of structuredSteps) {
      const candidates = autoExtractDeterministicFindings(st.stepNo, st.toolName, st.data);
      for (const c of candidates) {
        await saveFindingCandidate(c);
      }
    }
  }

  // Build grounded summary if LLM didn't emit final prose
  if (!finalSummary) {
    const verifiedRows = await db
      .prepare(`SELECT claim FROM findings WHERE dig_id = ? AND verified = 1 ORDER BY id ASC`)
      .bind(digId)
      .all();
    const claims = (verifiedRows.results || []).map((r) => r.claim);
    if (claims.length > 0) {
      // Try one quick synthesis turn if session exists
      if (session) {
        try {
          session.submitToolOutputs([], `Summarize these verified findings in 3 short plain sentences (no markdown bold, no emojis): ${claims.join(' ')}`);
          const syn = await session.nextTurn({ forceText: true });
          if (syn.text) finalSummary = syn.text.replace(/\*\*/g, '');
        } catch {}
      }
      if (!finalSummary) {
        finalSummary = [claims[0], ...claims.slice(1, 5).map((c) => `- ${c}`)].join('\n');
      }
    } else {
      finalSummary =
        'No verifiable figures matched a live upstream response on this dig, so nothing was written into the Burrow.';
    }
  } else {
    finalSummary = finalSummary.replace(/\*\*/g, '').trim();
  }

  await appendStep('report', scoutId, 'Final field note', finalSummary, true, 0);

  // Honest quality grading (Larpcheck Rule #3: never stamp 'verified' if probes failed without matches!)
  let quality = 'verified';
  if (matchedCount === 0 && failedProbes > 0) quality = 'degraded';
  else if (matchedCount === 0) quality = 'empty';
  else if (failedProbes > 0) quality = 'partial';

  const finishedAt = Date.now();
  await db
    .prepare(
      `UPDATE digs
       SET status = 'done', quality = ?, summary = ?, matched_count = ?, unmatched_count = ?, failed_probes = ?, finished_at = ?
       WHERE id = ?`
    )
    .bind(quality, finalSummary, matchedCount, unmatchedCount, failedProbes, finishedAt, digId)
    .run();

  return getDigById(env, digId);
}

export async function getDigById(env, digId) {
  const dig = await env.DB.prepare(`SELECT * FROM digs WHERE id = ?`).bind(Number(digId)).first();
  if (!dig) return null;
  const [stepsRes, findingsRes] = await Promise.all([
    env.DB.prepare(`SELECT * FROM dig_steps WHERE dig_id = ? ORDER BY step_no ASC`).bind(dig.id).all(),
    env.DB.prepare(`SELECT * FROM findings WHERE dig_id = ? ORDER BY id ASC`).bind(dig.id).all(),
  ]);
  return {
    ...dig,
    steps: stepsRes.results || [],
    findings: findingsRes.results || [],
  };
}

export async function chatWithFennek(env, rawMessages = []) {
  const history = (Array.isArray(rawMessages) ? rawMessages : [])
    .filter((m) => m && ['user', 'fennek'].includes(m.role) && typeof m.content === 'string' && m.content.trim())
    .slice(-8)
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, 1000) }));

  if (!history.length || history.at(-1).role !== 'user') {
    throw Object.assign(new Error('Send a message to Fennek first.'), { status: 400 });
  }

  const lastMsg = history.at(-1).content;
  const transcript = history
    .slice(0, -1)
    .map((m) => `${m.role === 'user' ? 'Visitor' : 'Fennek'}: ${m.content}`)
    .join('\n');

  const chatTools = SCOUT_TOOL_DEFS.filter((t) => t.name !== 'record_finding');
  const listened = [];
  const session = createAgentSession(env, {
    system: CHAT_SYSTEM,
    tools: chatTools,
    user: `${transcript ? `Earlier chat:\n${transcript}\n\n` : ''}Today is ${new Date().toISOString().slice(0, 10)} UTC. Visitor says:\n${lastMsg}`,
  });

  if (session) {
    let reply = '';
    for (let turn = 1; turn <= 4; turn++) {
      const { text, calls } = await session.nextTurn({ forceText: turn === 4 });
      if (!calls.length || turn === 4) {
        reply = text;
        break;
      }
      const outs = [];
      for (const c of calls.slice(0, 4)) {
        listened.push({ tool: c.name, why: String(c.args?.why || c.args?.query || c.args?.mint || '').slice(0, 120) });
        try {
          const data = await executeScoutTool(env, c.name, c.args || {});
          outs.push({ id: c.id, name: c.name, content: JSON.stringify(data).slice(0, 7500) });
        } catch (e) {
          outs.push({ id: c.id, name: c.name, content: JSON.stringify({ error: e?.message || 'probe failed' }), isError: true });
        }
      }
      session.submitToolOutputs(outs, turn === 3 ? 'Answer the visitor concisely now.' : '');
    }

    if (reply) {
      return { reply: reply.replace(/\*\*/g, '').trim(), listened };
    }
  }

  // Grounded live lookup fallback when running in local unit test without AI binding
  const addr = extractSolanaAddress(lastMsg);
  if (addr) {
    listened.push({ tool: 'token_lookup', why: `Check ${addr.slice(0, 8)}…` });
    const data = await executeScoutTool(env, 'token_lookup', { query: addr, why: 'Direct fox chat lookup' }).catch(() => null);
    if (data) {
      if (data.is_wrapped_native_sol) {
        return {
          reply: `That address is Wrapped SOL (wSOL). Jupiter reports $${Number(data.native_sol_chain_mcap_usd || 0).toLocaleString('en-US')} for total native SOL chain cap, while DexScreener reports $${Number(data.wrapped_wsol_spl_mcap_usd || 0).toLocaleString('en-US')} for wrapped wSOL inside SPL pools.`,
          listened,
        };
      }
      const mc = data.dexscreener_mcap_usd ?? data.jupiter_mcap_usd;
      return {
        reply: `I listened in on ${data.symbol} (${data.mint.slice(0, 4)}…${data.mint.slice(-4)}). Market cap reads $${Number(mc || 0).toLocaleString('en-US')}, mint authority disabled is ${data.mint_authority_disabled}, and top pool liquidity is $${Number(data.top_solana_pools?.[0]?.liquidity_usd || 0).toLocaleString('en-US')} (Jupiter + DexScreener). Send it to the left stream if you want a full multi-step dig.`,
        listened,
      };
    }
  }

  listened.push({ tool: 'burrow_search', why: lastMsg.slice(0, 60) });
  const mem = await executeScoutTool(env, 'burrow_search', { query: lastMsg.slice(0, 32), why: 'Search Burrow memory' });
  if (mem.findings?.length) {
    return {
      reply: `Here is what my Burrow already holds: ${mem.findings
        .slice(0, 3)
        .map((f) => f.claim)
        .join(' ')}`,
      listened,
    };
  }
  const defi = await executeScoutTool(env, 'solana_defi', { mode: 'tvl', why: 'Check live Solana DeFi TVL' });
  listened.push({ tool: 'solana_defi', why: 'Solana TVL snapshot' });
  return {
    reply: `Ears are up. Solana DeFi currently holds $${Number(defi.solana_chain_tvl_usd || 0).toLocaleString('en-US')} in TVL on DeFiLlama, led by ${defi.protocols?.[0]?.name || 'Jito'}. Paste any Solana mint, wallet, or protocol and I will check it live.`,
    listened,
  };
}

export async function runScheduledHouseDig(env) {
  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS cnt FROM digs`).first();
  const idx = Number(countRow?.cnt || 0) % HOUSE_ROTATION.length;
  const [scout, question] = HOUSE_ROTATION[idx];
  return createAndRunDig(env, { question, scout, sourceTag: 'house' });
}
