// opencodeclaude proxy - Anthropic Messages <-> OpenAI Chat Completions.
// Routes Claude/Qwen models -> Zen /v1/messages (native pass-through, x-api-key auth)
// Routes everything else -> Go, Zen or free /v1/chat/completions (translated, Bearer auth)
// *-free models -> free endpoint with the dummy 'public' bearer (no account needed).
// Sends x-opencode-* identity headers + a conversation-stable session id (per 9router),
// and injects reasoning_content for reasoning models (Kimi/DeepSeek).
//
// Env: OPENCODE_API_KEY (fallback), OPENCODE_GO_KEY / OPENCODE_ZEN_KEY (optional per-plan),
//      OPENCODE_PLAN (free|go|zen, default go), PORT (default 3456)

import http from 'node:http';
import { URL, fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 3456);
const KEY = process.env.OPENCODE_API_KEY || '';
const PLAN = process.env.OPENCODE_PLAN === 'free' ? 'free' : (process.env.OPENCODE_PLAN === 'zen' ? 'zen' : 'go');

const goKey = () => process.env.OPENCODE_GO_KEY || KEY;
const zenKey = () => process.env.OPENCODE_ZEN_KEY || KEY;
export const keyFor = (url) => (url.includes('/zen/go/') ? goKey() : zenKey());

// --- opencode upstream identity (learned from 9router's opencode executor) ---
const OPENCODE_UA = 'opencode';
// Claude Code embeds its per-session id in metadata.user_id as _session_<uuid>
const CLAUDE_CODE_SESSION_RE = /_session_([a-f0-9-]+)$/i;

function headerValue(headers, ...keys) {
  if (!headers) return null;
  for (const k of keys) {
    const v = headers[k] ?? headers[k.toLowerCase()];
    if (v && typeof v === 'string') return v.trim();
  }
  return null;
}

// Resolve a conversation-stable opencode session id (ses_<hex>) from the inbound request.
// Priority: existing x-opencode-session → Claude Code _session_ → session headers → none.
// A stable session id tells opencode.ai the request is a continuation of one conversation
// (prompt caching / rate-limit friendliness), mirroring 9router's sessionManager.
export function resolveSessionId(body, headers) {
  const existing = headerValue(headers, 'x-opencode-session');
  if (existing) return existing;
  const userId = body?.metadata?.user_id;
  if (typeof userId === 'string' && userId) {
    const m = userId.match(CLAUDE_CODE_SESSION_RE);
    if (m) return `ses_${m[1].replace(/-/g, '')}`;
    if (userId.startsWith('{')) {
      try {
        const sid = JSON.parse(userId)?.session_id;
        if (sid) return `ses_${String(sid).replace(/[^a-zA-Z0-9]/g, '')}`;
      } catch {}
    }
  }
  const sid = headerValue(headers, 'x-session-id', 'session-id', 'session_id', 'x-client-request-id');
  if (sid) return `ses_${sid.replace(/[^a-zA-Z0-9]/g, '')}`;
  return null;
}

// Headers that make opencode.ai treat us as a real opencode client. The free /zen/v1
// endpoint accepts the dummy 'public' bearer; a stable session enables continuity.
// If the downstream client already identifies as opencode, forward its identity untouched.
export function buildOpencodeHeaders(req, sessionId, streaming) {
  const h = req?.headers || {};
  const downstreamUa = h['user-agent'] || '';
  const isOpencodeDownstream = downstreamUa.toLowerCase().includes('opencode');
  return {
    'x-opencode-client': h['x-opencode-client'] || 'desktop',
    'x-opencode-session': h['x-opencode-session'] || sessionId || `ses_${crypto.randomUUID().replace(/-/g, '')}`,
    'x-opencode-request': h['x-opencode-request'] || `msg_${crypto.randomUUID().replace(/-/g, '')}`,
    'x-opencode-project': h['x-opencode-project'] || 'global',
    'User-Agent': isOpencodeDownstream ? downstreamUa : OPENCODE_UA,
    Accept: streaming ? 'text/event-stream' : '*/*',
  };
}

// Some reasoning models (Kimi, DeepSeek, ...) require reasoning_content echoed back on
// assistant messages; Claude Code never sends it, so inject a placeholder to satisfy
// upstream validation (mirrors 9router's reasoningContentInjector).
export function injectReasoning(messages, model) {
  const rule = /^kimi-/i.test(model) ? 'toolCalls' : (/deepseek/i.test(model) ? 'all' : null);
  if (!rule || !Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (m?.role !== 'assistant') return m;
    if (typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0) return m;
    if (rule === 'toolCalls' && !(Array.isArray(m.tool_calls) && m.tool_calls.length)) return m;
    return { ...m, reasoning_content: ' ' };
  });
}

const ZEN_ANTHROPIC = 'https://opencode.ai/zen/v1/messages';
const ZEN_OPENAI_FREE = 'https://opencode.ai/zen/v1/chat/completions';
const GO_OPENAI = 'https://opencode.ai/zen/go/v1/chat/completions';
const ZEN_OPENAI = 'https://opencode.ai/zen/v1/chat/completions';
const OPENAI = PLAN === 'free' ? ZEN_OPENAI_FREE : (PLAN === 'go' ? GO_OPENAI : ZEN_OPENAI);

const MODELS = [
  'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-haiku-4-5',
  'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus', 'qwen3.5-plus',
  'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6', 'glm-5.2', 'glm-5.1',
  'minimax-m3', 'minimax-m2.7', 'deepseek-v4-pro', 'deepseek-v4-flash',
  'deepseek-v4-flash-free',
];

let modelsCache = null;
let modelsCacheAt = 0;
const MODEL_TTL = 5 * 60 * 1000;

export async function liveModels() {
  if (modelsCache && Date.now() - modelsCacheAt < MODEL_TTL) return modelsCache;
  const go = new Set();
  const zen = new Set();
  await Promise.all([
    { url: 'https://opencode.ai/zen/go/v1/models', out: go, key: goKey },
    { url: 'https://opencode.ai/zen/v1/models', out: zen, key: zenKey },
  ].map(async (s) => {
    try {
      const r = await fetch(s.url, { headers: { authorization: `Bearer ${s.key()}` } });
      if (!r.ok) return;
      const data = await r.json();
      for (const m of data?.data || []) { if (m?.id) s.out.add(m.id); }
    } catch {}
  }));
  const list = [
    ...[...go].map((id) => ({ id: `anthropic-go/${id}`, display_name: `${id} (go)`, object: 'model', owned_by: 'go' })),
    ...[...zen].map((id) => ({ id: `anthropic-zen/${id}`, display_name: `${id} (zen)`, object: 'model', owned_by: 'zen' })),
  ];
  modelsCache = list.length ? list : MODELS.map((m) => ({ id: m, display_name: m, object: 'model', owned_by: 'opencode' }));
  modelsCacheAt = Date.now();
  return modelsCache;
}

export function route(model) {
  let m = model || '';
  let forced = '';
  if (m.startsWith('anthropic-go/')) { forced = 'go'; m = m.slice('anthropic-go/'.length); }
  else if (m.startsWith('anthropic-zen/')) { forced = 'zen'; m = m.slice('anthropic-zen/'.length); }
  else if (m.startsWith('opencode-go/')) { forced = 'go'; m = m.slice('opencode-go/'.length); }
  else if (m.startsWith('opencode-zen/')) { forced = 'zen'; m = m.slice('opencode-zen/'.length); }

  if (/^claude-/.test(m)) return { kind: 'anthropic', url: ZEN_ANTHROPIC, model: m };
  if (/^qwen3/.test(m) && forced !== 'go') return { kind: 'anthropic', url: ZEN_ANTHROPIC, model: m };
  if (/-free$/.test(m)) return { kind: 'openai', url: ZEN_OPENAI_FREE, model: m };
  const url = forced === 'go' ? GO_OPENAI : forced === 'zen' ? ZEN_OPENAI : OPENAI;
  return { kind: 'openai', url, model: m };
}

function blocksText(x) {
  if (typeof x === 'string') return x;
  return (Array.isArray(x) ? x : []).map((b) => b.type === 'text' ? b.text : '').filter(Boolean).join('\n');
}

function toolResultText(x) {
  if (typeof x === 'string') return x;
  return (Array.isArray(x) ? x : []).map((b) => b.type === 'text' ? b.text : '').filter(Boolean).join('\n');
}

export function toOpenAI(body) {
  const messages = [];
  if (body.system) messages.push({ role: 'system', content: blocksText(body.system) });
  for (const m of body.messages || []) {
    if (m.role === 'system') { messages.push({ role: 'system', content: blocksText(m.content) }); continue; }
    if (m.role === 'assistant') {
      const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content || '' }];
      const toolCalls = [];
      const text = [];
      for (const b of parts) {
        if (b.type === 'tool_use') toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
        else if (b.type === 'text' && b.text) text.push(b.text);
      }
      const msg = { role: 'assistant' };
      if (text.length) msg.content = text.join('\n');
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
      continue;
    }
    if (m.role === 'user') {
      const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content || '' }];
      const text = parts.filter((b) => b.type === 'text').map((b) => b.text || '').filter(Boolean);
      const tools = parts.filter((b) => b.type === 'tool_result');
      if (text.length) messages.push({ role: 'user', content: text.join('\n') });
      for (const b of tools) messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: toolResultText(b.content) });
      if (!text.length && !tools.length) messages.push({ role: 'user', content: '' });
      continue;
    }
    messages.push(m);
  }
  // OpenAI rejects a trailing assistant tool_calls with no following tool results.
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant' && last.tool_calls) {
    delete last.tool_calls;
    if (!last.content) messages.pop();
  }
  const openai = { model: body.model, messages };
  if (body.max_tokens) openai.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') openai.temperature = body.temperature;
  if (body.stream !== undefined) openai.stream = body.stream;
  if (body.tools?.length) {
    openai.tools = body.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } },
    }));
  }
  return openai;
}

const finishMap = { stop: 'end_turn', tool_calls: 'tool_use', length: 'max_tokens' };

export function fromOpenAI(data) {
  const choice = data.choices?.[0] || {};
  const m = choice.message || {};
  const content = [];
  if (m.content) content.push({ type: 'text', text: m.content });
  for (const tc of m.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
    content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name || '', input });
  }
  return {
    id: data.id, type: 'message', role: 'assistant', model: data.model, content,
    stop_reason: finishMap[choice.finish_reason] || 'end_turn', stop_sequence: null,
    usage: { input_tokens: data.usage?.prompt_tokens || 0, output_tokens: data.usage?.completion_tokens || 0 },
  };
}

export async function translateStream(body, res, model) {
  const send = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  let messageStarted = false;
  const open = [];
  let textIdx = null;
  const toolIdx = new Map();
  let outputTokens = 0;
  let closed = false;

  const ensureStarted = () => {
    if (messageStarted || closed) return;
    send({ type: 'message_start', message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
    messageStarted = true;
  };

  const dec = new TextDecoder();
  const rd = body.getReader();
  let buf = '';
  while (!closed) {
    const { done, value } = await rd.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while (!closed && (i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') { closed = true; break; }
      let d;
      try { d = JSON.parse(payload); } catch { continue; }
      if (d.object !== 'chat.completion.chunk') continue;
      const choice = d.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (delta.content) {
        ensureStarted();
        if (textIdx === null) { textIdx = open.length; open.push(textIdx); send({ type: 'content_block_start', index: textIdx, content_block: { type: 'text', text: '' } }); }
        send({ type: 'content_block_delta', index: textIdx, delta: { type: 'text_delta', text: delta.content } });
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          let idx = toolIdx.get(tc.index);
          if (idx === undefined) {
            ensureStarted();
            idx = open.length;
            toolIdx.set(tc.index, idx);
            open.push(idx);
            send({ type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: tc.id || `toolu_${idx}`, name: tc.function?.name || '', input: {} } });
          }
          if (tc.function?.arguments) {
            send({ type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
          }
        }
      }
      if (d.usage?.completion_tokens) outputTokens = d.usage.completion_tokens;
      if (choice.finish_reason) {
        closed = true;
        while (open.length) send({ type: 'content_block_stop', index: open.pop() });
        send({ type: 'message_delta', delta: { stop_reason: finishMap[choice.finish_reason] || 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens } });
        send({ type: 'message_stop' });
        messageStarted = false;
      }
    }
  }
  if (messageStarted) {
    while (open.length) send({ type: 'content_block_stop', index: open.pop() });
    send({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens } });
    send({ type: 'message_stop' });
  }
  res.end();
}

export function countTokens(body) {
  let n = 0;
  for (const m of body.messages || []) {
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    n += c.length / 4;
  }
  return { input_tokens: Math.round(n) };
}

async function forward(upstream, res, headers) {
  const ct = upstream.headers.get('content-type') || 'application/json';
  const body = await upstream.text();
  if (upstream.status >= 400) {
    res.writeHead(upstream.status, { 'content-type': ct });
    res.end(body);
    return;
  }
  res.writeHead(upstream.status, { 'content-type': ct, ...headers });
  res.write(body, upstream.status !== 200 ? undefined : undefined);
  res.end();
}

async function handleMessages(req, res) {
  let raw = '';
  for await (const c of req) raw += c;
  const body = JSON.parse(raw || '{}');
  const r = route(body.model);
  body.model = r.model;

  // Conversation-stable session id for opencode continuity across turns.
  const sessionId = resolveSessionId(body, req.headers);

  if (r.kind === 'anthropic') {
    const streaming = body.stream !== false;
    const upstream = await fetch(r.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
        'x-api-key': zenKey(),
        ...buildOpencodeHeaders(req, sessionId, streaming),
      },
      body: JSON.stringify(body),
    });
    await forward(upstream, res);
    return;
  }

  const openaiBody = toOpenAI(body);
  openaiBody.messages = injectReasoning(openaiBody.messages, r.model);
  const isFree = r.url === ZEN_OPENAI_FREE;
  const token = isFree ? 'public' : keyFor(r.url); // free endpoint accepts the dummy 'public' bearer (no account)
  const streaming = openaiBody.stream !== false;
  const upstream = await fetch(r.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...buildOpencodeHeaders(req, sessionId, streaming),
    },
    body: JSON.stringify(openaiBody),
  });

  if (streaming && upstream.status === 200) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    await translateStream(upstream.body, res, body.model);
  } else {
    const data = await upstream.text();
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
    res.end(upstream.status === 200 ? JSON.stringify(fromOpenAI(JSON.parse(data))) : data);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true,"plan":"' + PLAN + '"}');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: await liveModels() }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
      let raw = '';
      for await (const c of req) raw += c;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(countTokens(JSON.parse(raw || '{}'))));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/messages') {
      await handleMessages(req, res);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(e?.message || e) } }));
    } else {
      res.end();
    }
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Never let one bad request kill the proxy (Node >=15 crashes on unhandled rejections).
  process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e?.message || e));
  process.on('uncaughtException', (e) => console.error('uncaught exception:', e?.message || e));
  server.listen(PORT, '127.0.0.1', () => console.log(`opencodeclaude proxy on http://127.0.0.1:${PORT} (plan=${PLAN})`));
}
