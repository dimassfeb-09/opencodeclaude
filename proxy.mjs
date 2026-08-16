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
// How long to wait for upstream to send response headers before aborting.
const CONNECT_TIMEOUT = Number(process.env.OPENCODE_CONNECT_TIMEOUT_MS || 60000);
// Context window reported to Claude Code via /v1/models (drives compaction).
const CONTEXT_LENGTH = Number(process.env.OPENCODE_CONTEXT_LENGTH || 200000);
// Forward a filtered set of anthropic-beta headers on the Claude route (opt-in;
// defaults to the old behaviour since Zen sometimes rejects beta headers).
const FORWARD_BETA = process.env.OPENCODE_FORWARD_BETA === '1';

const goKey = () => process.env.OPENCODE_GO_KEY || KEY;
const zenKey = () => process.env.OPENCODE_ZEN_KEY || KEY;
export const keyFor = (url) => (url.includes('/zen/go/') ? goKey() : zenKey());

// --- custom provider config (read at call time so tests can set env after import) ---
// OPENCODE_CUSTOM_ENDPOINT is an OpenAI-compatible base URL (e.g. https://api.x/v1);
// the proxy appends /chat/completions and /models. The key is optional (local
// providers like Ollama need no auth). OPENCODE_CUSTOM_PROVIDER tags the models so
// they show up as custom/<provider>/<model> and are visibly distinct from go/zen.
export const customCfg = () => {
  const endpoint = (process.env.OPENCODE_CUSTOM_ENDPOINT || '').trim().replace(/\/+$/, '');
  const provider = (process.env.OPENCODE_CUSTOM_PROVIDER || '').trim() || 'custom';
  const key = process.env.OPENCODE_CUSTOM_KEY || '';
  return { endpoint, provider, key };
};
export function customChatUrl() { return customCfg().endpoint ? `${customCfg().endpoint}/chat/completions` : ''; }
export function customModelsUrl() { return customCfg().endpoint ? `${customCfg().endpoint}/models` : ''; }

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

// A deterministic per-(session, model) request key: same conversation + same model
// always produces the same msg_ id, so upstream request caching / dedup keys don't
// churn between turns (and identical retries reuse the same id). Falls back to a
// random id only when there is no session to anchor on.
export function requestKey(sessionId, model) {
  if (sessionId) return `msg_${crypto.createHash('sha1').update(`${sessionId}:${model || ''}`).digest('hex').slice(0, 24)}`;
  return `msg_${crypto.randomUUID().replace(/-/g, '')}`;
}

// Headers that make opencode.ai treat us as a real opencode client. The free /zen/v1
// endpoint accepts the dummy 'public' bearer; a stable session enables continuity.
// If the downstream client already identifies as opencode, forward its identity untouched.
export function buildOpencodeHeaders(req, sessionId, model, streaming) {
  const h = req?.headers || {};
  const downstreamUa = h['user-agent'] || '';
  const isOpencodeDownstream = downstreamUa.toLowerCase().includes('opencode');
  return {
    'x-opencode-client': h['x-opencode-client'] || 'desktop',
    'x-opencode-session': h['x-opencode-session'] || sessionId || `ses_${crypto.randomUUID().replace(/-/g, '')}`,
    'x-opencode-request': h['x-opencode-request'] || requestKey(sessionId, model),
    'x-opencode-project': h['x-opencode-project'] || 'global',
    'User-Agent': isOpencodeDownstream ? downstreamUa : OPENCODE_UA,
    Accept: streaming ? 'text/event-stream' : '*/*',
  };
}

// Plain OpenAI-compatible headers for the custom route. Unlike buildOpencodeHeaders,
// no x-opencode-* masquerade headers are sent (the custom endpoint is not opencode).
// The Authorization header is omitted when no key is configured (local providers).
export function buildCustomHeaders(req, model, streaming) {
  const key = customCfg().key;
  const h = {
    'content-type': 'application/json',
    Accept: streaming ? 'text/event-stream' : '*/*',
    'User-Agent': 'opencodeclaude',
  };
  if (key) h.authorization = `Bearer ${key}`;
  return h;
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

// anthropic-beta headers are forwarded only when opt-in (OPENCODE_FORWARD_BETA=1)
// and only for prefixes known to enable token-efficiency features. Zen sometimes
// rejects arbitrary beta headers, so keep the allowlist narrow.
const BETA_ALLOW_PREFIX = ['prompt-caching', 'cache-', 'context-'];
export function filteredBeta(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const kept = raw.split(',').map((s) => s.trim()).filter((s) => BETA_ALLOW_PREFIX.some((p) => s.startsWith(p)));
  return kept.length ? kept.join(', ') : null;
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
  const custom = new Set();
  const customPath = customModelsUrl();
  await Promise.all([
    { url: 'https://opencode.ai/zen/go/v1/models', out: go, key: goKey },
    { url: 'https://opencode.ai/zen/v1/models', out: zen, key: zenKey },
    ...(customPath ? [{ url: customPath, out: custom, key: () => customCfg().key }] : []),
  ].map(async (s) => {
    try {
      const r = await fetch(s.url, { headers: s.key() ? { authorization: `Bearer ${s.key()}` } : {} });
      if (!r.ok) return;
      const data = await r.json();
      for (const m of data?.data || []) { if (m?.id) s.out.add(m.id); }
    } catch {}
  }));
  // context_length lets Claude Code gate compaction on the real model window
  // (instead of relying on the disabled unknown-model enforcement).
  const win = { context_length: CONTEXT_LENGTH };
  const list = [
    ...[...go].map((id) => ({ id: `anthropic-go/${id}`, display_name: `${id} (go)`, object: 'model', owned_by: 'go', ...win })),
    ...[...zen].map((id) => ({ id: `anthropic-zen/${id}`, display_name: `${id} (zen)`, object: 'model', owned_by: 'zen', ...win })),
    ...[...custom].map((id) => ({ id: `custom/${customCfg().provider}/${id}`, display_name: `${id} (${customCfg().provider})`, object: 'model', owned_by: 'custom', ...win })),
  ];
  modelsCache = list.length ? list : MODELS.map((m) => ({ id: m, display_name: m, object: 'model', owned_by: 'opencode', ...win }));
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
  // Custom provider: custom/<provider>/<model> (the bare custom/<model> alias is
  // also accepted). Route is always OpenAI-format, no opencode masquerade.
  if (m.startsWith('custom/')) {
    const { provider } = customCfg();
    const rest = m.slice('custom/'.length);
    const model = rest.startsWith(provider + '/') ? rest.slice(provider.length + 1) : rest;
    return { kind: 'custom', url: customChatUrl(), model };
  }
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
      // OpenAI requires a content field on tool-calling assistants; some strict
      // providers reject the field being absent. null is the spec-compliant value.
      msg.content = text.length ? text.join('\n') : null;
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
      continue;
    }
    if (m.role === 'user') {
      const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content || '' }];
      const text = parts.filter((b) => b.type === 'text').map((b) => b.text || '').filter(Boolean);
      const tools = parts.filter((b) => b.type === 'tool_result');
      // OpenAI requires tool messages to immediately follow the assistant tool_calls;
      // user text must come AFTER the tool responses, never between them.
      for (const b of tools) messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: toolResultText(b.content) });
      if (text.length) messages.push({ role: 'user', content: text.join('\n') });
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
  // Default to streaming so a body without stream never trips the SSE reader.
  openai.stream = body.stream ?? true;
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
  const cached = data.usage?.prompt_tokens_details?.cached_tokens || 0;
  return {
    id: data.id, type: 'message', role: 'assistant', model: data.model, content,
    stop_reason: finishMap[choice.finish_reason] || 'end_turn', stop_sequence: null,
    usage: {
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0,
      ...(cached ? { cache_read_input_tokens: cached } : {}),
    },
  };
}

export async function translateStream(body, res, model, opts = {}) {
  const send = (e) => {
    if (res.destroyed || res.writableEnded) return;
    try { res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); } catch {}
  };
  let messageStarted = false;
  const open = [];
  let textIdx = null;
  const toolIdx = new Map();
  const usage = { input: opts.inputEstimate || 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let toolCalls = 0;
  let closed = false;
  let aborted = false;

  const usageEvent = () => ({
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_read_input_tokens: usage.cacheRead,
    cache_creation_input_tokens: usage.cacheWrite,
  });

  const ensureStarted = () => {
    if (messageStarted || closed) return;
    send({ type: 'message_start', message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: 0 } } });
    messageStarted = true;
  };

  const dec = new TextDecoder();
  const rd = body.getReader();
  let buf = '';
  while (!closed) {
    let value;
    try {
      const r = await rd.read();
      value = r.value;
      if (r.done) break;
    } catch {
      // Aborted (client disconnect / timeout) or upstream stream error:
      // stop forwarding, no more tokens are produced upstream after the abort.
      aborted = true;
      closed = true;
      break;
    }
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
      // Real usage arrives on the final chunk(s); cache read may be reported here too.
      if (d.usage) {
        if (typeof d.usage.prompt_tokens === 'number') usage.input = d.usage.prompt_tokens;
        if (typeof d.usage.completion_tokens === 'number') usage.output = d.usage.completion_tokens;
        const det = d.usage.prompt_tokens_details;
        if (det && typeof det.cached_tokens === 'number') usage.cacheRead = det.cached_tokens;
      }
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
            toolCalls++;
            send({ type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: tc.id || `toolu_${idx}`, name: tc.function?.name || '', input: {} } });
          }
          if (tc.function?.arguments) {
            send({ type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
          }
        }
      }
      if (choice.finish_reason) {
        closed = true;
        while (open.length) send({ type: 'content_block_stop', index: open.pop() });
        send({ type: 'message_delta', delta: { stop_reason: finishMap[choice.finish_reason] || 'end_turn', stop_sequence: null }, usage: usageEvent() });
        send({ type: 'message_stop' });
        messageStarted = false;
      }
    }
  }
  if (messageStarted && !aborted) {
    while (open.length) send({ type: 'content_block_stop', index: open.pop() });
    send({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: usageEvent() });
    send({ type: 'message_stop' });
  }
  res.end();
  return { usage, toolCalls, aborted };
}

// Rough estimate of input tokens (Anthropic-shaped body). Used only for the
// count_tokens endpoint and as a message_start placeholder when streaming.
export function countTokens(body) {
  const approx = (x) => {
    if (x == null) return 0;
    const s = typeof x === 'string' ? x : JSON.stringify(x);
    return s.length / 4;
  };
  let n = 0;
  if (body.system) n += approx(body.system);
  for (const m of body.messages || []) n += approx(typeof m.content === 'string' ? m.content : m.content || '');
  for (const t of body.tools || []) n += approx(t);
  return { input_tokens: Math.round(n) };
}

// Pull the last usage object + tool-use count out of an Anthropic response so we
// can log real (upstream-reported) token numbers on the Claude route.
export function extractUsage(text, contentType) {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let toolCalls = 0;
  if (/text\/event-stream/i.test(contentType || '')) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let d;
      try { d = JSON.parse(payload); } catch { continue; }
      if (d.type === 'content_block_start' && d.content_block?.type === 'tool_use') toolCalls++;
      if (d.type === 'message_start' && d.message?.usage) {
        usage.input = d.message.usage.input_tokens || 0;
        usage.output = d.message.usage.output_tokens || 0;
        usage.cacheRead = d.message.usage.cache_read_input_tokens || 0;
        usage.cacheWrite = d.message.usage.cache_creation_input_tokens || 0;
      }
      if (d.type === 'message_delta' && d.usage) {
        if (typeof d.usage.output_tokens === 'number') usage.output = d.usage.output_tokens;
      }
    }
  } else {
    try {
      const d = JSON.parse(text);
      const u = d.usage;
      if (u) {
        usage.input = u.input_tokens || 0;
        usage.output = u.output_tokens || 0;
        usage.cacheRead = u.cache_read_input_tokens || 0;
        usage.cacheWrite = u.cache_creation_input_tokens || 0;
      }
      for (const b of d.content || []) if (b.type === 'tool_use') toolCalls++;
    } catch {}
  }
  return { usage, toolCalls };
}

// Stream the Claude (native Anthropic) response through to the client. For SSE we
// pipe chunks straight through (real streaming, unlike buffering the whole body)
// while scraping usage/tool counts from the passing data; the forward headers are
// applied first. On abort or upstream failure the response is ended immediately.
async function forwardStreaming(upstream, res, headers) {
  const ct = upstream.headers.get('content-type') || 'application/json';
  const isSse = /text\/event-stream/i.test(ct);

  if (upstream.status >= 400) {
    const body = await upstream.text().catch(() => '');
    if (!res.headersSent && !res.destroyed) res.writeHead(upstream.status, { 'content-type': 'application/json' });
    try { res.end(errorToAnthropic(upstream.status, body)); } catch {}
    return { ...extractUsage(body, ct), status: upstream.status, aborted: false };
  }

  if (!isSse || !upstream.body) {
    // Non-streaming or empty body: buffer as before.
    let body;
    try {
      body = await upstream.text();
    } catch {
      if (!res.headersSent && !res.destroyed) res.writeHead(502, { 'content-type': 'application/json' });
      res.end();
      return { status: 502, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, toolCalls: 0, aborted: true };
    }
    if (!res.headersSent && !res.destroyed) res.writeHead(upstream.status, { 'content-type': ct, ...headers });
    try { res.end(body); } catch {}
    return { ...extractUsage(body, ct), status: upstream.status, aborted: false };
  }

  // Pipe SSE while accumulating usage/toolCalls from the byte stream.
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let toolCalls = 0;
  if (!res.headersSent && !res.destroyed) res.writeHead(upstream.status, { 'content-type': ct, ...headers });
  const rd = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let aborted = false;
  try {
    while (true) {
      const { done, value } = await rd.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      buf += chunk;
      // Scrape usage/tool events as they pass; also stop buffering the tail once
      // message_stop is seen (keeps buf small on long generations).
      let lineStart = 0;
      let nl;
      while ((nl = buf.indexOf('\n', lineStart)) >= 0) {
        const line = buf.slice(lineStart, nl);
        lineStart = nl + 1;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let d;
        try { d = JSON.parse(payload); } catch { continue; }
        if (d.type === 'content_block_start' && d.content_block?.type === 'tool_use') toolCalls++;
        if (d.type === 'message_start' && d.message?.usage) {
          usage.input = d.message.usage.input_tokens || 0;
          usage.output = d.message.usage.output_tokens || 0;
          usage.cacheRead = d.message.usage.cache_read_input_tokens || 0;
          usage.cacheWrite = d.message.usage.cache_creation_input_tokens || 0;
        }
        if (d.type === 'message_delta' && d.usage && typeof d.usage.output_tokens === 'number') usage.output = d.usage.output_tokens;
      }
      if (buf.indexOf('\n', lineStart) < 0) buf = buf.slice(lineStart); else buf = '';
      if (res.destroyed || res.writableEnded) { aborted = true; break; }
      try { res.write(chunk); } catch { aborted = true; break; }
    }
  } catch {
    aborted = true;
  }
  try { res.end(); } catch {}
  return { status: aborted ? 502 : upstream.status, usage, toolCalls, aborted };
}

// Normalize {input,output,cacheRead,cacheWrite} usage into the log record keys
// {in,out,cacheRead,cacheWrite} so every success path fills the same columns.
export const usagePatch = (u = {}) => ({
  in: u.input ?? u.in ?? 0,
  out: u.output ?? u.out ?? 0,
  cacheRead: u.cacheRead ?? 0,
  cacheWrite: u.cacheWrite ?? 0,
});

// Map an upstream non-2xx (OpenAI-shaped) body to the Anthropic error shape Claude
// Code expects, so it can parse retryable statuses like 429 instead of failing.
export function errorToAnthropic(status, body) {
  let err = { type: 'api_error', message: `upstream error ${status}` };
  try {
    const d = JSON.parse(body || '{}');
    if (d?.error) {
      if (typeof d.error === 'string') err = { type: 'api_error', message: d.error };
      else err = { type: d.error.type || (status === 429 ? 'rate_limit_error' : 'api_error'), message: String(d.error.message || d.error.code || err.message) };
    }
  } catch {}
  return JSON.stringify({ type: 'error', error: err });
}

// One JSON line per handled request. Never logs the body, Authorization, or keys.
export function logRequest(rec) {
  try { console.log(JSON.stringify(rec)); } catch {}
}

// Abort the upstream fetch when the client disconnects (stop / task switch / close)
// or when upstream never sends headers within CONNECT_TIMEOUT. Prevents wasted
// output tokens on cancelled generations and retry-loops from hung upstreams.
function abortGuard(req, res) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('connect timeout')), CONNECT_TIMEOUT);
  res.on('close', () => { if (!res.writableEnded) controller.abort(new Error('client disconnected')); });
  return { controller, clearTimer: () => clearTimeout(timer) };
}

// Provider label for the log. Distinguish free by the model suffix, not the URL
// (ZEN_OPENAI and ZEN_OPENAI_FREE share the same path).
const routeLabel = (r) => {
  if (r.kind === 'custom') return 'custom';
  if (r.kind === 'anthropic') return 'zen-messages';
  if (/-free$/.test(r.model)) return 'free';
  if (r.url.includes('/go/')) return 'go';
  return 'zen';
};

async function handleMessages(req, res) {
  const rec = { t: new Date().toISOString(), requestId: crypto.randomUUID(), model: req.headers?.['anthropic-model'] || null, sessionId: null, route: null, provider: null, status: null, ms: null, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, toolCalls: 0, error: null };
  const startedAt = Date.now();
  const finish = (patch) => {
    rec.ms = Date.now() - startedAt;
    Object.assign(rec, patch);
    logRequest(rec);
  };
  const guard = abortGuard(req, res);
  try {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || '{}');
    const r = route(body.model);
    body.model = r.model;
    rec.model = r.model;
    const sessionId = resolveSessionId(body, req.headers);
    rec.sessionId = sessionId;
    rec.route = r.kind;
    rec.provider = routeLabel(r);

    // Defensive: the custom endpoint should always be set (cli.mjs validates at
    // launch), but a stale config or rolled-back env shouldn't 500 the proxy.
    if (r.kind === 'custom' && !r.url) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'custom provider endpoint not configured' } }));
      finish({ status: 400, error: 'custom_endpoint_missing' });
      return;
    }

    if (r.kind === 'anthropic') {
      const streaming = body.stream !== false;
      const beta = FORWARD_BETA ? filteredBeta(req.headers['anthropic-beta']) : null;
      const upstream = await fetch(r.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
          ...(beta ? { 'anthropic-beta': beta } : {}),
          'x-api-key': zenKey(),
          ...buildOpencodeHeaders(req, sessionId, r.model, streaming),
        },
        body: JSON.stringify(body),
        signal: guard.controller.signal,
      });
      guard.clearTimer();
      const f = await forwardStreaming(upstream, res);
      finish({ status: f.status, ...usagePatch(f.usage), toolCalls: f.toolCalls, error: f.aborted ? 'aborted' : null });
      return;
    }

    const openaiBody = toOpenAI(body);
    openaiBody.messages = injectReasoning(openaiBody.messages, r.model);
    const isFree = r.url === ZEN_OPENAI_FREE;
    const token = isFree ? 'public' : keyFor(r.url); // free endpoint accepts the dummy 'public' bearer (no account)
    const streaming = openaiBody.stream !== false;
    // Custom providers get plain OpenAI headers (no opencode masquerade); go/zen
    // endpoints send the opencode identity headers and the plan's bearer token.
    const headers = r.kind === 'custom'
      ? buildCustomHeaders(req, r.model, streaming)
      : { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...buildOpencodeHeaders(req, sessionId, r.model, streaming) };
    const upstream = await fetch(r.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(openaiBody),
      signal: guard.controller.signal,
    });
    guard.clearTimer();

    if (streaming && upstream.status === 200) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const st = await translateStream(upstream.body, res, body.model, { inputEstimate: countTokens(body).input_tokens });
      finish({ status: 200, ...usagePatch(st.usage), toolCalls: st.toolCalls, error: st.aborted ? 'aborted' : null });
    } else {
      let data;
      try {
        data = await upstream.text();
      } catch {
        finish({ status: 502, error: 'aborted' });
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end();
        return;
      }
      const status = upstream.status;
      if (status === 200) {
        const parsed = JSON.parse(data);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(fromOpenAI(parsed)));
        const u = parsed?.usage || {};
        const det = u.prompt_tokens_details;
        finish({ status: 200, in: u.prompt_tokens || 0, out: u.completion_tokens || 0, cacheRead: det?.cached_tokens || 0, cacheWrite: 0, toolCalls: (parsed?.choices?.[0]?.message?.tool_calls || []).length });
      } else {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(errorToAnthropic(status, data));
        finish({ status, error: `upstream_${status}` });
      }
    }
  } catch (e) {
    guard.clearTimer();
    const isAbort = e?.name === 'AbortError';
    if (!res.headersSent && !res.destroyed) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: isAbort ? 'request aborted' : String(e?.message || e) } }));
    } else {
      try { res.end(); } catch {}
    }
    finish({ status: isAbort ? 'aborted' : 502, error: isAbort ? 'aborted' : String(e?.message || e) });
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
