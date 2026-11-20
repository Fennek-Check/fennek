<p align="center">
  <img src="brand/logo.svg" width="112" height="112" alt="FENNEK" />
</p>

<h1 align="center">FENNEK</h1>

<p align="center">
  <strong>90% ear, 10% fox — listening underneath Solana.</strong><br/>
  Live multi-step Solana scout stream, direct conversational fox chat, deterministic verbatim evidence verifier, and Streamable HTTP MCP memory.
</p>

<p align="center">
  <a href="https://fennek.fun"><strong>Live Studio (fennek.fun)</strong></a> ·
  <a href="https://fennek.fun/mcp"><strong>MCP Endpoint (/mcp)</strong></a> ·
  <a href="https://fennek.fun/SKILL.md"><strong>SKILL.md</strong></a> ·
  <a href="https://fennek.fun/llms.txt"><strong>llms.txt</strong></a>
</p>

---

## Overview

**FENNEK** runs specialized autonomous Solana scouts (**Pulse Ear**, **Track Ear**, **Pack Ear**, **Oasis Ear**, **Dune Ear**, **Memory Ear**) backed by a multi-turn tool-use LLM loop (OpenAI / Anthropic / Cloudflare Workers AI `llama-3.3-70b`) and a shared D1 memory database (**The Burrow**).

Unlike generic chat wrappers that hallucinate token caps or holder percentages:
1. **Cross-Source Market Cap Disambiguation:** `token_lookup` queries **both** Jupiter Token API v2 and DexScreener in parallel, explicitly flagging `>25%` cross-source mcap divergence and distinguishing native `SOL` chain cap from wrapped `wSOL` (`So11111111111111111111111111111111111111112`) SPL pool liquidity.
2. **Verbatim Evidence Gate (`checkVerbatimEvidence`):** Every finding proposed during a dig must cite the exact step number and an exact JSON key-value substring from that step's raw upstream response (e.g. `"solana_chain_tvl_usd":8420000000`). Unmatched claims are rejected before entering the Burrow.
3. **Honest Probe Grading:** Upstream timeouts or RPC errors increment `failed_probes` and downgrade dig quality to `partial` or `degraded` — never silently stamping `verified`.
4. **Always-Open Fox Chat:** Visitors can chat with Fennek in real time right alongside the live dig stream; Fennek calls read-only Solana tools inside the chat turn and displays `ear: <tool>` badges for every live lookup.

---

## Connect via Streamable HTTP MCP (`JSON-RPC 2.0`)

Zero local package installs required. Add `fennek` to Cursor (`.cursor/mcp.json`) or Claude Desktop:

```json
{
  "mcpServers": {
    "fennek": {
      "url": "https://fennek.fun/mcp"
    }
  }
}
```

### MCP Tools
| Tool | Description |
|---|---|
| `burrow_search` | Search verified Solana findings with verbatim evidence quotes and upstream proof URLs |
| `send_fennek_dig` | Dispatch an ear scout (`pulse`, `deployer`, `holders`, `defi`, `launch`) onto live Solana data |
| `ask_fennek` | Ask Fennek a conversational Solana question backed by live RPC & Burrow lookups |

---

## Repository Structure

```text
fennek/
├── worker/
│   ├── schema.sql          # Cloudflare D1 schema (digs, dig_steps, findings, mcp_keys, usage_counters)
│   ├── wrangler.jsonc      # Worker + D1 + Workers AI + 15m Cron configuration
│   ├── d1-sqlite.mjs       # Zero-dependency local node:sqlite D1 adapter
│   ├── dev-server.mjs      # Local full-stack studio server (Node 22+)
│   └── src/
│       ├── index.js        # REST API (/v1/*), Streamable HTTP MCP (/mcp), Cron handler
│       ├── scouts.js       # Multi-turn ear-scout runner, verbatim verifier & fox chat loop
│       ├── tools.js        # Read-only Solana RPC, Jupiter v2, DexScreener & DeFiLlama probes
│       └── llm.js          # Tool-calling session adapter (OpenAI, Anthropic, Workers AI)
├── site/                   # Oasis Dusk Split-Studio web app (zero build step, vanilla ES modules)
├── test/
│   └── fennek.test.mjs     # Verbatim evidence, Wrapped SOL cross-check, chat & MCP test suite
└── brand/                  # Pure flat 2D vector mascot assets
```

---

## Run Locally

Requires **Node.js 22+** (uses built-in `node:sqlite` and `node:test` — zero `npm install` runtime dependencies).

```bash
# Run unit & live Solana probe tests
npm test

# Start local Oasis Studio on http://localhost:4355
npm run dev
```

## Zero-Wallet Read-Only Access Tiers

FENNEK never asks users to connect a wallet or sign messages. Optional `$FENNEK` holder tiers (**Scout Ear** `>= 1,000,000`, **Alpha Ear** `>= 5,000,000`) are verified 100% read-only via Solana JSON-RPC `getTokenAccountsByOwner` (SPL + Token-2022).

## License

[MIT](LICENSE)
