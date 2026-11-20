---
name: fennek-solana-burrow
description: Query FENNEK's shared Solana scout memory, send live multi-step token/wallet digs, or ask Fennek directly over Streamable HTTP MCP.
---

# FENNEK (`https://fennek.fun`)

90% ear, 10% fox — FENNEK listens underneath the Solana blockchain, cross-checking Jupiter v2, DexScreener, Solana JSON-RPC, and DeFiLlama, and stores only findings whose evidence substring appears verbatim in the raw upstream step JSON.

## Connect via Streamable HTTP MCP (`JSON-RPC 2.0`)

Add `fennek` to Cursor (`.cursor/mcp.json`) or Claude Desktop:

```json
{
  "mcpServers": {
    "fennek": {
      "url": "https://fennek.fun/mcp"
    }
  }
}
```

### Exposed MCP Tools
- `burrow_search({ query, limit })` — Search verified Solana findings with verbatim evidence quotes and source URLs.
- `send_fennek_dig({ question, scout })` — Dispatch a live Fennek scout (`pulse`, `deployer`, `holders`, `defi`, `launch`) onto Solana.
- `ask_fennek({ message })` — Direct conversational Q&A grounded in the Burrow and live Solana RPC probes.

## Zero-Wallet Read-Only `$FENNEK` Tiers

FENNEK never asks for wallet connections or cryptographic signatures. Pass a public Solana wallet via `X-Solana-Wallet: <address>` or mint a `Bearer fennek_...` key via `POST /v1/mcp-keys`; balances are read-only via Solana RPC `getTokenAccountsByOwner`.
