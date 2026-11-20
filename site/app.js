const state = {
  status: null,
  selectedScout: '',
  streamFilter: '',
  digs: [],
  expandedTraces: new Map(),
  wallet: localStorage.getItem('fennek_wallet') || '',
  apiKey: localStorage.getItem('fennek_api_key') || '',
  chatHistory: [
    {
      role: 'fennek',
      content:
        'Ears are up. I listen underneath Solana — live DEX pools, RPC holder concentration, deployer tracks, and DeFi TVL.\nAsk me anything here, or send an ear scout on the left stream.',
      listened: [],
    },
  ],
};

const SCOUT_LABELS = {
  pulse: 'Pulse Ear',
  deployer: 'Track Ear',
  holders: 'Pack Ear',
  defi: 'Oasis Ear',
  launch: 'Dune Ear',
  burrow: 'Memory Ear',
};

function apiHeaders() {
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

function relTime(ms) {
  if (!ms) return 'just now';
  const sec = Math.max(1, Math.round((Date.now() - Number(ms)) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function switchView(viewId) {
  document.querySelectorAll('.nav-pill').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === viewId);
  });
  document.querySelectorAll('.view-pane').forEach((p) => {
    p.classList.toggle('active', p.id === `view-${viewId}`);
  });
  if (viewId === 'burrow') loadBurrowFindings();
  if (viewId === 'map') loadEntityGraph();
}

async function loadStatus() {
  const res = await fetch('/v1/status', { headers: apiHeaders() });
  const data = await res.json();
  state.status = data;

  document.getElementById('statDigs').textContent = data.stats?.totalDigs ?? 0;
  document.getElementById('statVerified').textContent = data.stats?.verifiedFindings ?? 0;
  document.getElementById('statMatchRate').textContent = `${data.stats?.matchRatePct ?? 100}%`;
  document.getElementById('navFindingsCount').textContent = data.stats?.verifiedFindings ?? 0;

  const caller = data.caller || {};
  const tierLbl = caller.tier === 'alpha' ? 'Alpha Ear' : caller.tier === 'scout' ? 'Scout Ear' : 'Visitor · 0-Wallet';
  document.getElementById('topTierLabel').textContent = tierLbl;

  const rem = Math.max(0, (caller.limits?.digsPerDay || 5) - (caller.used?.digs || 0));
  document.getElementById('digQuotaLabel').textContent = `${rem}/${caller.limits?.digsPerDay || 5} digs left today`;

  const caShort = document.getElementById('caShortText');
  if (data.tokenAddress) {
    caShort.textContent = `${data.tokenAddress.slice(0, 4)}…${data.tokenAddress.slice(-4)}`;
  } else {
    caShort.textContent = 'OPEN STUDIO';
  }

  const xBtn = document.getElementById('xLinkBtn');
  if (data.xUrl) {
    xBtn.href = data.xUrl;
    xBtn.classList.remove('hidden');
  }

  const ghBtn = document.getElementById('ghLinkBtn');
  const fGh = document.getElementById('footerGhLink');
  const fDot = document.getElementById('footerGhDot');
  if (data.githubUrl && data.githubUrl.startsWith('https://github.com/') && data.githubUrl.length > 20) {
    ghBtn.href = data.githubUrl;
    ghBtn.classList.remove('hidden');
    fGh.href = data.githubUrl;
    fGh.classList.remove('hidden');
    fDot.classList.remove('hidden');
  }

  renderMcpConfig();
}

function renderMcpConfig() {
  const origin = window.location.origin;
  const headersBlock = state.apiKey
    ? `,\n      "headers": {\n        "Authorization": "Bearer ${state.apiKey}"\n      }`
    : '';
  const cfg = `{
  "mcpServers": {
    "fennek": {
      "url": "${origin}/mcp"${headersBlock}
    }
  }
}`;
  document.getElementById('mcpConfigPre').textContent = cfg;
}

async function loadDigStream() {
  const q = state.streamFilter ? `?scout=${encodeURIComponent(state.streamFilter)}&limit=18` : '?limit=18';
  const res = await fetch(`/v1/digs${q}`);
  const data = await res.json();
  state.digs = data.digs || [];

  // Hydrate top 6 digs with full findings so verified quotes show immediately on the stream
  const topIds = state.digs.slice(0, 6).map((d) => d.id);
  await Promise.all(
    topIds.map(async (id) => {
      if (!state.expandedTraces.has(id)) {
        const r = await fetch(`/v1/digs/${id}`);
        const full = await r.json();
        if (full?.dig) state.expandedTraces.set(id, { detail: full.dig, open: false });
      }
    })
  );

  renderDigStream();
}

function renderDigStream() {
  const box = document.getElementById('digStreamList');
  if (!state.digs.length) {
    box.innerHTML = `<div class="skeleton-card">No digs match this ear filter yet — dispatch a scout above.</div>`;
    return;
  }

  box.innerHTML = state.digs
    .map((d) => {
      const cached = state.expandedTraces.get(d.id);
      const detail = cached?.detail;
      const traceOpen = Boolean(cached?.open);
      const verifiedFindings = (detail?.findings || []).filter((f) => f.verified === 1);
      const steps = detail?.steps || [];

      const qClass =
        d.status === 'running'
          ? 'quality-running'
          : d.quality === 'verified'
          ? 'quality-verified'
          : d.quality === 'partial'
          ? 'quality-partial'
          : 'quality-degraded';
      const qLabel =
        d.status === 'running'
          ? 'LISTENING…'
          : d.quality === 'verified'
          ? `VERIFIED (${d.matched_count})`
          : d.quality === 'partial'
          ? `PARTIAL (${d.matched_count} ok · ${d.failed_probes} probe warn)`
          : d.quality.toUpperCase();

      const findingsHtml = verifiedFindings.length
        ? `<div class="dig-findings-box">
            ${verifiedFindings
              .slice(0, 4)
              .map(
                (f) => `<div class="finding-line">
                  <div>${esc(f.claim)}</div>
                  <div class="finding-quote-row">
                    <span class="finding-quote">verbatim: ${esc(f.evidence_quote)}</span>
                    ${
                      f.source_url
                        ? `<a class="finding-src" href="${esc(f.source_url)}" target="_blank" rel="noopener">source ↗</a>`
                        : ''
                    }
                  </div>
                </div>`
              )
              .join('')}
          </div>`
        : '';

      const traceHtml = traceOpen
        ? `<div class="trace-drawer">
            ${steps
              .map(
                (s) => `<div class="step-item">
                  <div class="step-head ${s.ok ? '' : 'step-err'}">
                    <span>#${s.step_no} · ${esc(s.tool_name)} ${s.why ? `— ${esc(s.why)}` : ''}</span>
                    <span>${s.latency_ms ? `${s.latency_ms}ms` : ''}</span>
                  </div>
                  <pre class="step-pre">${esc(s.body.slice(0, 700))}</pre>
                </div>`
              )
              .join('')}
          </div>`
        : '';

      return `<article class="dig-card" data-dig-id="${d.id}">
        <div class="dig-meta-top">
          <div class="dig-badges">
            <span class="dig-id">#DIG-${String(d.id).padStart(3, '0')}</span>
            <span class="scout-badge">${esc(SCOUT_LABELS[d.scout] || d.scout)}</span>
            <span class="quality-badge ${qClass}">${esc(qLabel)}</span>
          </div>
          <span class="dig-time">${relTime(d.finished_at || d.started_at)}</span>
        </div>
        <h3 class="dig-question">${esc(d.question)}</h3>
        ${d.summary ? `<div class="dig-summary">${esc(d.summary)}</div>` : ''}
        ${findingsHtml}
        <div class="dig-actions-foot">
          <button type="button" class="trace-toggle-btn" data-toggle-trace="${d.id}">
            ${traceOpen ? '▾ Hide raw tool steps' : `▸ Inspect raw tool trace${steps.length ? ` (${steps.length} steps)` : ''}`}
          </button>
          <button type="button" class="ask-about-btn" data-ask-chat="${esc(d.question)}">
            Ask Fennek in chat →
          </button>
        </div>
        ${traceHtml}
      </article>`;
    })
    .join('');
}

async function toggleTrace(digId) {
  const id = Number(digId);
  let entry = state.expandedTraces.get(id);
  if (!entry) {
    const res = await fetch(`/v1/digs/${id}`);
    const data = await res.json();
    if (data?.dig) entry = { detail: data.dig, open: true };
  } else {
    entry.open = !entry.open;
  }
  if (entry) state.expandedTraces.set(id, entry);
  renderDigStream();
}

async function submitDig(question, scoutOverride = null) {
  const q = String(question || '').trim();
  if (!q) return;
  const btn = document.getElementById('digSubmitBtn');
  const input = document.getElementById('digInput');
  btn.disabled = true;
  btn.textContent = 'Listening…';

  try {
    const res = await fetch('/v1/digs', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        question: q,
        scout: scoutOverride !== null ? scoutOverride : state.selectedScout,
        wallet: state.wallet,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Could not start dig.');
      return;
    }
    input.value = '';
    if (data.dig) {
      state.expandedTraces.set(data.dig.id, { detail: data.dig, open: true });
    }
    await Promise.all([loadStatus(), loadDigStream()]);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send Scout';
  }
}

function renderChat() {
  const box = document.getElementById('chatMessages');
  box.innerHTML = state.chatHistory
    .map((m, idx) => {
      if (m.role === 'user') {
        return `<div class="msg-bubble msg-user">
          <div>${esc(m.content)}</div>
          <button type="button" class="promote-dig-btn" data-promote="${idx}">← Send to Public Dig Stream</button>
        </div>`;
      }
      const tags = (m.listened || []).length
        ? `<div class="listened-tags">
            ${m.listened.map((l) => `<span class="listened-pill">ear: ${esc(l.tool)}</span>`).join('')}
          </div>`
        : '';
      return `<div class="msg-bubble msg-fennek">
        ${tags}
        <div>${esc(m.content)}</div>
      </div>`;
    })
    .join('');
  box.scrollTop = box.scrollHeight;
}

async function sendChatMessage(text) {
  const clean = String(text || '').trim();
  if (!clean) return;

  state.chatHistory.push({ role: 'user', content: clean });
  renderChat();

  const input = document.getElementById('chatInput');
  const btn = document.getElementById('chatSendBtn');
  input.value = '';
  btn.disabled = true;
  btn.textContent = '…';

  try {
    const res = await fetch('/v1/chat', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        messages: state.chatHistory.map((m) => ({ role: m.role, content: m.content })),
        wallet: state.wallet,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      state.chatHistory.push({ role: 'fennek', content: data.error || 'My ears hit static — try again in a moment.', listened: [] });
    } else {
      state.chatHistory.push({
        role: 'fennek',
        content: data.reply || 'I checked the Burrow, nothing matched yet.',
        listened: data.listened || [],
      });
    }
    renderChat();
    loadStatus();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Ask';
  }
}

async function loadBurrowFindings(q = '') {
  const url = q ? `/v1/findings?q=${encodeURIComponent(q)}` : '/v1/findings';
  const res = await fetch(url);
  const data = await res.json();
  const list = document.getElementById('burrowFindingsList');
  const rows = data.findings || [];
  if (!rows.length) {
    list.innerHTML = `<div class="skeleton-card">No verified findings match "${esc(q)}".</div>`;
    return;
  }
  list.innerHTML = rows
    .map(
      (f) => `<div class="finding-line">
        <div class="dig-badges" style="margin-bottom:6px">
          <span class="scout-badge">${esc(SCOUT_LABELS[f.scout] || f.scout)}</span>
          <span class="dig-id">#DIG-${String(f.dig_id).padStart(3, '0')}</span>
        </div>
        <div>${esc(f.claim)}</div>
        <div class="finding-quote-row">
          <span class="finding-quote">${esc(f.evidence_quote)}</span>
          ${f.source_url ? `<a class="finding-src" href="${esc(f.source_url)}" target="_blank" rel="noopener">proof ↗</a>` : ''}
        </div>
      </div>`
    )
    .join('');
}

async function loadEntityGraph() {
  const res = await fetch('/v1/graph');
  const { nodes = [], edges = [] } = await res.json();
  const svg = document.getElementById('entityGraphSvg');
  if (!nodes.length) {
    svg.innerHTML = `<text x="430" y="220" text-anchor="middle" fill="#B5ADC4" font-size="14">Run a dig to populate the Solana entity map.</text>`;
    return;
  }

  const cx = 430;
  const cy = 220;
  const pos = new Map();
  nodes.forEach((n, idx) => {
    if (idx === 0) {
      pos.set(n.id, { x: cx, y: cy, ...n });
    } else {
      const ring = idx < 8 ? 125 : 185;
      const angle = (idx / Math.max(1, nodes.length - 1)) * Math.PI * 2;
      pos.set(n.id, { x: cx + Math.cos(angle) * ring * 1.45, y: cy + Math.sin(angle) * ring * 0.9, ...n });
    }
  });

  const edgeLines = edges
    .map((e) => {
      const a = pos.get(e.source);
      const b = pos.get(e.target);
      if (!a || !b) return '';
      return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="rgba(44,229,198,0.25)" stroke-width="${Math.min(3.5, e.weight)}" />`;
    })
    .join('');

  const nodeCircles = [...pos.values()]
    .map((n, i) => {
      const r = Math.min(24, 11 + n.count * 2.5);
      const fill = i === 0 ? '#FF732E' : '#0D5C59';
      const stroke = i === 0 ? '#F8F1E3' : '#2CE5C6';
      return `<g class="graph-node" data-entity="${esc(n.id)}" style="cursor:pointer">
        <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
        <text x="${n.x.toFixed(1)}" y="${(n.y + r + 15).toFixed(1)}" text-anchor="middle" fill="#F8F1E3" font-family="JetBrains Mono" font-size="11">${esc(n.label)}</text>
      </g>`;
    })
    .join('');

  svg.innerHTML = edgeLines + nodeCircles;
}

function wireEvents() {
  document.querySelectorAll('.nav-pill').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
  document.getElementById('openTierBtn').addEventListener('click', () => switchView('mcp'));

  document.getElementById('caCopyBtn').addEventListener('click', async () => {
    const mint = state.status?.tokenAddress;
    if (!mint) {
      switchView('mcp');
      return;
    }
    await navigator.clipboard.writeText(mint);
    const el = document.getElementById('caShortText');
    const prev = el.textContent;
    el.textContent = 'COPIED!';
    setTimeout(() => (el.textContent = prev), 1400);
  });

  document.getElementById('scoutSelector').addEventListener('click', (e) => {
    const chip = e.target.closest('.scout-chip');
    if (!chip) return;
    state.selectedScout = chip.dataset.scout || '';
    document.querySelectorAll('.scout-chip').forEach((c) => c.classList.toggle('active', c === chip));
  });

  document.getElementById('digForm').addEventListener('submit', (e) => {
    e.preventDefault();
    submitDig(document.getElementById('digInput').value);
  });

  document.querySelectorAll('.preset-pill').forEach((p) => {
    p.addEventListener('click', () => submitDig(p.dataset.q, p.dataset.scout || ''));
  });

  document.getElementById('streamFilterPills').addEventListener('click', (e) => {
    const pill = e.target.closest('.filter-pill');
    if (!pill) return;
    state.streamFilter = pill.dataset.filter || '';
    document.querySelectorAll('.filter-pill').forEach((p) => p.classList.toggle('active', p === pill));
    loadDigStream();
  });

  document.getElementById('refreshStreamBtn').addEventListener('click', () => {
    loadStatus();
    loadDigStream();
  });

  document.getElementById('digStreamList').addEventListener('click', (e) => {
    const tBtn = e.target.closest('[data-toggle-trace]');
    if (tBtn) {
      toggleTrace(tBtn.dataset.toggleTrace);
      return;
    }
    const askBtn = e.target.closest('[data-ask-chat]');
    if (askBtn) {
      sendChatMessage(`Tell me more about: ${askBtn.dataset.askChat}`);
    }
  });

  document.getElementById('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    sendChatMessage(document.getElementById('chatInput').value);
  });

  document.querySelectorAll('.chat-chip').forEach((c) => {
    c.addEventListener('click', () => sendChatMessage(c.dataset.chat));
  });

  document.getElementById('clearChatBtn').addEventListener('click', () => {
    state.chatHistory = state.chatHistory.slice(0, 1);
    renderChat();
  });

  document.getElementById('chatMessages').addEventListener('click', (e) => {
    const prom = e.target.closest('[data-promote]');
    if (!prom) return;
    const msg = state.chatHistory[Number(prom.dataset.promote)];
    if (msg?.content) submitDig(msg.content);
  });

  let searchTimer = null;
  document.getElementById('burrowSearchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadBurrowFindings(e.target.value.trim()), 220);
  });

  document.getElementById('entityGraphSvg').addEventListener('click', (e) => {
    const g = e.target.closest('.graph-node');
    if (!g) return;
    const ent = g.dataset.entity;
    switchView('burrow');
    document.getElementById('burrowSearchInput').value = ent;
    loadBurrowFindings(ent);
  });

  document.getElementById('copyMcpConfigBtn').addEventListener('click', async (e) => {
    await navigator.clipboard.writeText(document.getElementById('mcpConfigPre').textContent);
    e.target.textContent = 'Copied!';
    setTimeout(() => (e.target.textContent = 'Copy JSON'), 1400);
  });

  document.getElementById('runMcpTestBtn').addEventListener('click', async () => {
    const out = document.getElementById('mcpTestOutput');
    out.textContent = 'Calling POST /mcp (JSON-RPC 2.0 tools/call -> burrow_search)…';
    const res = await fetch('/mcp', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'burrow_search', arguments: { limit: 3 } },
      }),
    });
    const data = await res.json();
    out.textContent = JSON.stringify(data, null, 2);
  });

  const walletIn = document.getElementById('publicWalletInput');
  if (state.wallet) walletIn.value = state.wallet;

  document.getElementById('walletTierForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const w = walletIn.value.trim();
    const res = await fetch('/v1/mcp-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallet: w, label: 'web-studio' }),
    });
    const data = await res.json();
    if (data.apiKey) {
      state.wallet = data.wallet || '';
      state.apiKey = data.apiKey;
      localStorage.setItem('fennek_wallet', state.wallet);
      localStorage.setItem('fennek_api_key', state.apiKey);
      const box = document.getElementById('mintedKeyBox');
      box.classList.remove('hidden');
      box.innerHTML = `<strong>Active Tier: ${esc(data.limits?.label || data.tier)}</strong><br/>MCP Key: <code>${esc(data.apiKey)}</code>`;
      renderMcpConfig();
      loadStatus();
    }
  });
}

renderChat();
wireEvents();
await Promise.all([loadStatus(), loadDigStream()]);
