const state = {
  status: null,
  digs: [],
  traces: new Map(),
  wallet: localStorage.getItem('fennek_wallet') || '',
  apiKey: localStorage.getItem('fennek_api_key') || '',
  chat: [
    {
      role: 'fennek',
      content: 'Ears are up. Paste any Solana token or wallet on the left for an instant check, or ask me directly here.',
      listened: [],
    },
  ],
};

function headers() {
  const h = { 'content-type': 'application/json' };
  if (state.apiKey) h['x-fennek-key'] = state.apiKey;
  if (state.wallet) h['x-solana-wallet'] = state.wallet;
  return h;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtUsd(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toLocaleString('en-US')}`;
}

function relTime(ms) {
  if (!ms) return 'now';
  const s = Math.max(1, Math.round((Date.now() - Number(ms)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function looksLikeTokenOrTicker(q) {
  const clean = q.trim();
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(clean)) return true;
  if (/^\$?[A-Za-z0-9]{2,12}$/.test(clean) && !clean.includes(' ')) return true;
  return false;
}

function switchView(id) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === id));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${id}`));
  if (id === 'burrow') loadBurrow();
}

async function loadStatus() {
  const res = await fetch('/v1/status', { headers: headers() });
  const data = await res.json();
  state.status = data;

  document.getElementById('memCount').textContent = data.stats?.verifiedFindings ?? 0;

  // Pre-launch clean mode: only show $FENNEK pill & tier card AFTER token mint is live!
  const caBtn = document.getElementById('caCopyBtn');
  const tierCard = document.getElementById('tokenTierCard');
  const mcpLayout = document.getElementById('mcpLayout');
  if (data.tokenAddress) {
    document.getElementById('caShortText').textContent = `${data.tokenAddress.slice(0, 4)}…${data.tokenAddress.slice(-4)}`;
    caBtn.classList.remove('hidden');
    tierCard.classList.remove('hidden');
    mcpLayout.classList.add('two-col');
  } else {
    caBtn.classList.add('hidden');
    tierCard.classList.add('hidden');
    mcpLayout.classList.remove('two-col');
  }

  const xBtn = document.getElementById('xLinkBtn');
  if (data.xUrl) {
    xBtn.href = data.xUrl;
    xBtn.classList.remove('hidden');
  }

  const ghBtn = document.getElementById('ghLinkBtn');
  const fGh = document.getElementById('footerGhLink');
  if (data.githubUrl && data.githubUrl.startsWith('https://github.com/') && data.githubUrl.length > 20) {
    ghBtn.href = data.githubUrl;
    ghBtn.classList.remove('hidden');
    fGh.href = data.githubUrl;
    fGh.classList.remove('hidden');
  }

  const authLine = state.apiKey ? `,\n      "headers": { "Authorization": "Bearer ${state.apiKey}" }` : '';
  document.getElementById('mcpConfigPre').textContent = `{\n  "mcpServers": {\n    "fennek": {\n      "url": "${window.location.origin}/mcp"${authLine}\n    }\n  }\n}`;
}

async function runQuickScan(query) {
  const q = String(query || '').trim();
  if (!q) return;
  const box = document.getElementById('quickResultBox');
  const btn = document.getElementById('quickBtn');
  box.classList.remove('hidden');
  box.innerHTML = `<span class="sub-inline">Checking Solana RPC + Jupiter + DexScreener…</span>`;
  btn.disabled = true;

  try {
    const res = await fetch(`/v1/quick?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!res.ok) {
      box.innerHTML = `<span class="sub-inline">${esc(data.error || 'No token matched — click Deep Dig to run a full question.')}</span>`;
      return;
    }

    const t = data.token;
    const h = data.holders;
    const v = data.verdict;
    const pool = t.top_solana_pools?.[0];
    const top10 = h?.top10_share_pct ?? t.jupiter_top_holders_pct;

    const vClass = v.level === 'danger' ? 'v-danger' : v.level === 'warn' ? 'v-warn' : v.level === 'info' ? 'v-info' : 'v-safe';

    const capCells = t.is_wrapped_native_sol
      ? `<div class="qr-stat"><span>Native SOL Cap</span><strong>${fmtUsd(t.native_sol_chain_mcap_usd)}</strong></div>
         <div class="qr-stat"><span>Wrapped Pool Cap</span><strong>${fmtUsd(t.wrapped_wsol_spl_mcap_usd)}</strong></div>`
      : `<div class="qr-stat"><span>Market Cap</span><strong>${fmtUsd(t.dexscreener_mcap_usd ?? t.jupiter_mcap_usd)}</strong></div>`;

    box.innerHTML = `
      <div class="qr-top">
        <div class="qr-title">
          <span>${esc(t.symbol)}</span>
          <span class="qr-mint">${esc(t.mint.slice(0, 6))}…${esc(t.mint.slice(-4))}</span>
        </div>
        <div class="dig-tags">
          <span class="v-pill ${vClass}">${esc(v.badge)}</span>
          <span class="dig-age">${data.latencyMs}ms</span>
        </div>
      </div>
      <div class="qr-grid">
        ${capCells}
        <div class="qr-stat"><span>Top Pool Liq</span><strong>${fmtUsd(pool?.liquidity_usd)}</strong></div>
        <div class="qr-stat"><span>Top 10 Share</span><strong>${top10 != null ? `${top10}%` : 'native'}</strong></div>
        <div class="qr-stat"><span>Mint / Freeze</span><strong>${t.mint_authority_disabled ? 'Off' : 'ON'} / ${t.freeze_authority_disabled ? 'Off' : 'ON'}</strong></div>
        ${t.dev_total_mints != null ? `<div class="qr-stat"><span>Dev Mints</span><strong>${t.dev_total_mints}</strong></div>` : ''}
      </div>
      <div class="qr-flags">${v.flags.map((f) => `• ${esc(f)}`).join(' · ')}</div>
      <div class="qr-actions">
        <a href="${esc(t.source_url)}" target="_blank" rel="noopener" class="link-btn">View pool / Solscan ↗</a>
        <div class="dig-tags">
          <button type="button" class="link-btn" data-run-dig="Inspect ${esc(t.mint)} (${esc(t.symbol)}): cross-check liquidity, holders, and deployer history">+ Save to Public Stream</button>
          <span>·</span>
          <button type="button" class="link-btn" data-ask-fox="What stands out about ${esc(t.symbol)} (${esc(t.mint)})?">Ask Fennek →</button>
        </div>
      </div>
    `;
  } finally {
    btn.disabled = false;
  }
}

async function runDeepDig(question) {
  const q = String(question || '').trim();
  if (!q) return;
  const btn = document.getElementById('deepDigBtn');
  btn.disabled = true;
  btn.textContent = 'Digging…';
  try {
    const res = await fetch('/v1/digs', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ question: q, wallet: state.wallet }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Could not run dig');
      return;
    }
    document.getElementById('scanInput').value = '';
    if (data.dig) state.traces.set(data.dig.id, { detail: data.dig, open: false });
    await Promise.all([loadStatus(), loadStream()]);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Deep Dig';
  }
}

async function loadStream() {
  const res = await fetch('/v1/digs?limit=14');
  const data = await res.json();
  state.digs = data.digs || [];

  await Promise.all(
    state.digs.slice(0, 5).map(async (d) => {
      if (!state.traces.has(d.id)) {
        const r = await fetch(`/v1/digs/${d.id}`);
        const full = await r.json();
        if (full?.dig) state.traces.set(d.id, { detail: full.dig, open: false });
      }
    })
  );

  renderStream();
}

function renderStream() {
  const list = document.getElementById('digStreamList');
  if (!state.digs.length) {
    list.innerHTML = `<div class="empty-note">Warming up first Solana digs — click any chip above or Refresh in a few seconds.</div>`;
    return;
  }

  list.innerHTML = state.digs
    .map((d) => {
      const entry = state.traces.get(d.id);
      const detail = entry?.detail;
      const open = Boolean(entry?.open);
      const facts = (detail?.findings || []).filter((f) => f.verified === 1);
      const steps = detail?.steps || [];

      const qPill =
        d.status === 'running'
          ? `<span class="v-pill v-info">LISTENING</span>`
          : d.quality === 'verified'
          ? `<span class="v-pill v-safe">VERIFIED · ${d.matched_count}</span>`
          : `<span class="v-pill v-warn">${esc(d.quality.toUpperCase())}</span>`;

      const factsHtml = facts.length
        ? `<div class="fact-pills">
            ${facts
              .slice(0, 3)
              .map(
                (f) => `<div class="fact-row">
                  <span>${esc(f.claim)}</span>
                  ${f.source_url ? `<a href="${esc(f.source_url)}" target="_blank" rel="noopener">proof ↗</a>` : ''}
                </div>`
              )
              .join('')}
          </div>`
        : '';

      const traceHtml = open
        ? `<div class="trace-box">
            ${steps
              .map(
                (s) => `<div class="trace-step">
                  <div>#${s.step_no} ${esc(s.tool_name)} ${s.latency_ms ? `(${s.latency_ms}ms)` : ''}</div>
                  <pre>${esc(s.body.slice(0, 500))}</pre>
                </div>`
              )
              .join('')}
          </div>`
        : '';

      return `<article class="dig-item">
        <div class="dig-top">
          <div class="dig-tags">
            <span class="dig-num">#${d.id}</span>
            ${qPill}
          </div>
          <span class="dig-age">${relTime(d.finished_at || d.started_at)}</span>
        </div>
        <div class="dig-q">${esc(d.question)}</div>
        ${d.summary ? `<div class="dig-sum">${esc(d.summary)}</div>` : ''}
        ${factsHtml}
        <div class="dig-foot">
          <button type="button" class="link-btn" data-trace="${d.id}">${open ? 'Hide steps' : `Raw steps${steps.length ? ` (${steps.length})` : ''}`}</button>
          <button type="button" class="link-btn" data-ask-fox="${esc(d.question)}">Ask in chat →</button>
        </div>
        ${traceHtml}
      </article>`;
    })
    .join('');
}

function renderChat() {
  const box = document.getElementById('chatMessages');
  box.innerHTML = state.chat
    .map((m) => {
      if (m.role === 'user') return `<div class="bubble bubble-user">${esc(m.content)}</div>`;
      const ears = (m.listened || []).length
        ? `<div class="ear-row">${m.listened.map((l) => `<span class="ear-chip">ear: ${esc(l.tool)}</span>`).join('')}</div>`
        : '';
      return `<div class="bubble bubble-fox">${ears}<div>${esc(m.content)}</div></div>`;
    })
    .join('');
  box.scrollTop = box.scrollHeight;
}

async function sendChat(text) {
  const clean = String(text || '').trim();
  if (!clean) return;
  state.chat.push({ role: 'user', content: clean });
  renderChat();

  const input = document.getElementById('chatInput');
  const btn = document.getElementById('chatSendBtn');
  input.value = '';
  btn.disabled = true;

  try {
    const res = await fetch('/v1/chat', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        messages: state.chat.map((m) => ({ role: m.role, content: m.content })),
        wallet: state.wallet,
      }),
    });
    const data = await res.json();
    state.chat.push({
      role: 'fennek',
      content: res.ok ? data.reply : data.error || 'Static on the line — try again.',
      listened: data.listened || [],
    });
    renderChat();
  } finally {
    btn.disabled = false;
  }
}

async function loadBurrow(q = '') {
  const res = await fetch(q ? `/v1/findings?q=${encodeURIComponent(q)}` : '/v1/findings');
  const data = await res.json();
  const box = document.getElementById('burrowFindingsList');
  const rows = data.findings || [];
  if (!rows.length) {
    box.innerHTML = `<div class="empty-note">No verified findings match "${esc(q)}".</div>`;
    return;
  }
  box.innerHTML = rows
    .map(
      (f) => `<div class="fact-row" style="flex-direction:column;align-items:flex-start">
        <div>${esc(f.claim)}</div>
        <div style="display:flex;justify-content:space-between;width:100%;margin-top:4px;font-family:var(--mono);font-size:11px;color:var(--faint)">
          <span>${esc(f.evidence_quote)}</span>
          ${f.source_url ? `<a href="${esc(f.source_url)}" target="_blank" rel="noopener">source ↗</a>` : ''}
        </div>
      </div>`
    )
    .join('');
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));
document.getElementById('brandHomeLink').addEventListener('click', (e) => {
  e.preventDefault();
  switchView('live');
});

document.getElementById('scanForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const val = document.getElementById('scanInput').value.trim();
  if (!val) return;
  if (looksLikeTokenOrTicker(val)) runQuickScan(val);
  else runDeepDig(val);
});

document.getElementById('deepDigBtn').addEventListener('click', () => {
  const val = document.getElementById('scanInput').value.trim();
  if (val) runDeepDig(val);
});

document.querySelectorAll('[data-quick]').forEach((c) => c.addEventListener('click', () => runQuickScan(c.dataset.quick)));
document.querySelectorAll('[data-dig]').forEach((c) => c.addEventListener('click', () => runDeepDig(c.dataset.dig)));
document.querySelectorAll('[data-chat]').forEach((c) => c.addEventListener('click', () => sendChat(c.dataset.chat)));

document.addEventListener('click', async (e) => {
  const runDigEl = e.target.closest('[data-run-dig]');
  if (runDigEl) return runDeepDig(runDigEl.dataset.runDig);

  const askEl = e.target.closest('[data-ask-fox]');
  if (askEl) return sendChat(askEl.dataset.askFox);

  const trEl = e.target.closest('[data-trace]');
  if (trEl) {
    const id = Number(trEl.dataset.trace);
    let entry = state.traces.get(id);
    if (!entry) {
      const r = await fetch(`/v1/digs/${id}`);
      const d = await r.json();
      if (d?.dig) entry = { detail: d.dig, open: true };
    } else {
      entry.open = !entry.open;
    }
    if (entry) state.traces.set(id, entry);
    renderStream();
  }
});

document.getElementById('refreshBtn').addEventListener('click', () => {
  loadStatus();
  loadStream();
});

document.getElementById('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  sendChat(document.getElementById('chatInput').value);
});

document.getElementById('clearChatBtn').addEventListener('click', () => {
  state.chat = state.chat.slice(0, 1);
  renderChat();
});

document.getElementById('caCopyBtn').addEventListener('click', async () => {
  if (!state.status?.tokenAddress) return;
  await navigator.clipboard.writeText(state.status.tokenAddress);
  const code = document.getElementById('caShortText');
  const prev = code.textContent;
  code.textContent = 'COPIED';
  setTimeout(() => (code.textContent = prev), 1200);
});

let bTimer = null;
document.getElementById('burrowSearchInput').addEventListener('input', (e) => {
  clearTimeout(bTimer);
  bTimer = setTimeout(() => loadBurrow(e.target.value.trim()), 200);
});

document.getElementById('copyMcpBtn').addEventListener('click', async (e) => {
  await navigator.clipboard.writeText(document.getElementById('mcpConfigPre').textContent);
  e.target.textContent = 'Copied!';
  setTimeout(() => (e.target.textContent = 'Copy'), 1200);
});

document.getElementById('pingMcpBtn').addEventListener('click', async () => {
  const out = document.getElementById('mcpPingOut');
  out.classList.remove('hidden');
  out.textContent = 'Pinging /mcp…';
  const res = await fetch('/mcp', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'burrow_search', arguments: { limit: 3 } } }),
  });
  out.textContent = JSON.stringify(await res.json(), null, 2);
});

document.getElementById('walletTierForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const wallet = document.getElementById('publicWalletInput').value.trim();
  const res = await fetch('/v1/mcp-keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wallet, label: 'web' }),
  });
  const data = await res.json();
  if (data.apiKey) {
    state.wallet = data.wallet || '';
    state.apiKey = data.apiKey;
    localStorage.setItem('fennek_wallet', state.wallet);
    localStorage.setItem('fennek_api_key', state.apiKey);
    const box = document.getElementById('mintedKeyBox');
    box.classList.remove('hidden');
    box.textContent = `${data.limits?.label || data.tier} — Key: ${data.apiKey}`;
    loadStatus();
  }
});

renderChat();
await Promise.all([loadStatus(), loadStream()]);
