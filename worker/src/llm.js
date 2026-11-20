/**
 * Multi-provider LLM tool-calling runner for FENNEK:
 *   1. OpenAI API (`env.OPENAI_API_KEY`)
 *   2. Anthropic API (`env.ANTHROPIC_API_KEY`)
 *   3. Cloudflare Workers AI (`env.AI` -> `@cf/meta/llama-3.3-70b-instruct-fp8-fast`) — built-in 70B GPU inference!
 */

const CF_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

function toOpenAiTools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function createAgentSession(env, { system, tools, user }) {
  if (env?.OPENAI_API_KEY) {
    return openAiChatSession(env, { system, tools, user });
  }
  if (env?.ANTHROPIC_API_KEY) {
    return anthropicSession(env, { system, tools, user });
  }
  if (env?.AI && typeof env.AI.run === 'function') {
    return workersAiSession(env, { system, tools, user });
  }
  return null;
}

function openAiChatSession(env, { system, tools, user }) {
  const model = env.OPENAI_MODEL || 'gpt-4o-mini';
  const oaTools = toOpenAiTools(tools);
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  return {
    provider: `openai:${model}`,
    async nextTurn({ forceText = false } = {}) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.OPENAI_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          temperature: 0.25,
          messages,
          ...(oaTools.length && !forceText ? { tools: oaTools, tool_choice: 'auto' } : {}),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`OpenAI ${res.status}: ${j?.error?.message || 'failed'}`);
      const msg = j.choices?.[0]?.message || {};
      messages.push(msg);

      const calls = (msg.tool_calls || []).map((tc) => {
        let args = {};
        try {
          args = JSON.parse(tc.function?.arguments || '{}');
        } catch {}
        return { id: tc.id, name: tc.function?.name, args };
      });
      return { text: (msg.content || '').trim(), calls };
    },
    submitToolOutputs(outputs, nudge = '') {
      for (const o of outputs) {
        messages.push({ role: 'tool', tool_call_id: o.id, content: o.content });
      }
      if (nudge) messages.push({ role: 'user', content: nudge });
    },
  };
}

function anthropicSession(env, { system, tools, user }) {
  const model = env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest';
  const antTools = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
  const messages = [{ role: 'user', content: user }];

  return {
    provider: `anthropic:${model}`,
    async nextTurn({ forceText = false } = {}) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1800,
          system,
          messages,
          ...(antTools.length && !forceText ? { tools: antTools } : {}),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Anthropic ${res.status}: ${j?.error?.message || 'failed'}`);
      messages.push({ role: 'assistant', content: j.content || [] });

      const text = (j.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      const calls = (j.content || [])
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, args: b.input || {} }));
      return { text, calls };
    },
    submitToolOutputs(outputs, nudge = '') {
      const blocks = outputs.map((o) => ({
        type: 'tool_result',
        tool_use_id: o.id,
        content: o.content,
        ...(o.isError ? { is_error: true } : {}),
      }));
      if (nudge) blocks.push({ type: 'text', text: nudge });
      messages.push({ role: 'user', content: blocks });
    },
  };
}

function workersAiSession(env, { system, tools, user }) {
  const oaTools = toOpenAiTools(tools);
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  return {
    provider: `workers-ai:${CF_MODEL}`,
    async nextTurn({ forceText = false } = {}) {
      const payload = {
        messages,
        max_tokens: 1200,
        temperature: 0.2,
        ...(oaTools.length && !forceText ? { tools: oaTools } : {}),
      };
      const out = await env.AI.run(CF_MODEL, payload);

      const rawText = typeof out?.response === 'string' ? out.response.trim() : '';
      const rawCalls = Array.isArray(out?.tool_calls) ? out.tool_calls : [];

      const calls = rawCalls.map((tc, idx) => {
        let args = tc.arguments ?? tc.function?.arguments ?? {};
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {
            args = {};
          }
        }
        return {
          id: tc.id || `cf_call_${Date.now()}_${idx}`,
          name: tc.name || tc.function?.name || '',
          args,
        };
      });

      messages.push({
        role: 'assistant',
        content: rawText || (calls.length ? `Calling ${calls.map((c) => c.name).join(', ')}` : ''),
      });

      return { text: rawText, calls: forceText ? [] : calls };
    },
    submitToolOutputs(outputs, nudge = '') {
      const lines = outputs.map((o) => `Tool result (${o.name}):\n${o.content}`);
      if (nudge) lines.push(nudge);
      messages.push({ role: 'user', content: lines.join('\n\n') });
    },
  };
}
