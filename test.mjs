// opencodeclaude proxy self-check: node test.mjs
import assert from 'node:assert';
import { toOpenAI, fromOpenAI, translateStream, route, countTokens, keyFor, resolveSessionId, buildOpencodeHeaders, injectReasoning } from './proxy.mjs';

process.env.OPENCODE_GO_KEY = 'sk-go-test';
process.env.OPENCODE_ZEN_KEY = 'sk-zen-test';

assert.strictEqual(keyFor('https://opencode.ai/zen/go/v1/chat/completions'), 'sk-go-test');
assert.strictEqual(keyFor('https://opencode.ai/zen/go/v1/models'), 'sk-go-test');
assert.strictEqual(keyFor('https://opencode.ai/zen/v1/messages'), 'sk-zen-test');
assert.strictEqual(keyFor('https://opencode.ai/zen/v1/chat/completions'), 'sk-zen-test');

const enc = new TextEncoder();
function fakeBody(chunks) {
  let i = 0;
  return { getReader() { return { async read() { return i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true }; } }; } };
}
function fakeRes() {
  return { data: '', write(s) { this.data += s; }, end() { this.ended = true; } };
}

// route
assert.strictEqual(route('claude-sonnet-4-6').kind, 'anthropic');
assert.strictEqual(route('qwen3.6-plus').kind, 'anthropic');
assert.strictEqual(route('kimi-k3').kind, 'openai');
assert.strictEqual(route('deepseek-v4-flash-free').url, 'https://opencode.ai/zen/v1/chat/completions');
assert.strictEqual(route('anthropic-go/kimi-k3').url, 'https://opencode.ai/zen/go/v1/chat/completions');
assert.strictEqual(route('anthropic-go/kimi-k3').model, 'kimi-k3');
assert.strictEqual(route('anthropic-zen/kimi-k3').url, 'https://opencode.ai/zen/v1/chat/completions');
assert.strictEqual(route('anthropic-go/qwen3.6-plus').url, 'https://opencode.ai/zen/go/v1/chat/completions');
assert.strictEqual(route('anthropic-zen/claude-sonnet-4-6').kind, 'anthropic');
assert.strictEqual(route('anthropic-zen/claude-sonnet-4-6').model, 'claude-sonnet-4-6');
assert.strictEqual(route('opencode-go/kimi-k3').url, 'https://opencode.ai/zen/go/v1/chat/completions');

// toOpenAI: system + user text + assistant tool_use + user tool_result
const o = toOpenAI({
  system: 'be brief', model: 'kimi-k3',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.txt' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'xyz' }] },
  ],
});
assert.strictEqual(o.messages[0].role, 'system');
assert.deepStrictEqual(o.messages[1], { role: 'user', content: 'hi' });
assert.deepStrictEqual(o.messages[2].tool_calls[0], { id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } });
assert.deepStrictEqual(o.messages[3], { role: 'tool', tool_call_id: 't1', content: 'xyz' });

// toOpenAI: trailing assistant tool_use with no tool_result must not produce a dangling tool_calls message
const d = toOpenAI({
  model: 'kimi-k3',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't9', name: 'bash', input: { command: 'ls' } }] },
  ],
});
assert.strictEqual(d.messages.length, 1, 'dangling tool_calls message should be dropped');
assert.deepStrictEqual(d.messages[0], { role: 'user', content: 'go' });

// toOpenAI: user message with BOTH text and tool_result - tool messages must come
// BEFORE the user text so tool responses immediately follow the assistant tool_calls.
const c = toOpenAI({
  model: 'kimi-k3',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'run it' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't5', name: 'bash', input: { command: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't5', content: 'out' }, { type: 'text', text: 'now do more' }] },
  ],
});
assert.strictEqual(c.messages[2].role, 'tool');
assert.strictEqual(c.messages[3].role, 'user');
assert.deepStrictEqual(c.messages[2], { role: 'tool', tool_call_id: 't5', content: 'out' });
assert.deepStrictEqual(c.messages[3], { role: 'user', content: 'now do more' });

// fromOpenAI: non-stream completion with tool call
const an = fromOpenAI({
  id: 'x1', model: 'kimi-k3', usage: { prompt_tokens: 10, completion_tokens: 5 },
  choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ id: 't2', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] } }],
});
assert.strictEqual(an.stop_reason, 'tool_use');
assert.deepStrictEqual(an.content[0], { type: 'tool_use', id: 't2', name: 'bash', input: { command: 'ls' } });

// translateStream: text delta then tool call then finish
const res = fakeRes();
const sse = [
  'data: {"object":"chat.completion.chunk","id":"s1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}\n\n',
  'data: {"object":"chat.completion.chunk","id":"s1","choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n',
  'data: {"object":"chat.completion.chunk","id":"s1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"t3","function":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}]}}]}\n\n',
  'data: {"object":"chat.completion.chunk","id":"s1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"completion_tokens":9}}\n\n',
  'data: [DONE]\n\n',
];
await translateStream(fakeBody(sse), res, 'kimi-k3');
assert.ok(res.ended);
const events = res.data.split('\n\n').filter((s) => s.includes('"type":"')).map((s) => JSON.parse(s.match(/^data: (.*)$/m)[1]));
assert.strictEqual(events[0].type, 'message_start');
assert.deepStrictEqual(events[1].content_block, { type: 'text', text: '' });
assert.strictEqual(events[2].delta.type, 'text_delta');
assert.strictEqual(events[3].delta.text, 'lo');
assert.deepStrictEqual(events[4].content_block, { type: 'tool_use', id: 't3', name: 'bash', input: {} });
assert.strictEqual(events[5].delta.type, 'input_json_delta');
assert.strictEqual(events[6].type, 'content_block_stop');
assert.strictEqual(events[7].type, 'content_block_stop');
assert.strictEqual(events[8].delta.stop_reason, 'tool_use');
assert.strictEqual(events[9].type, 'message_stop');

// countTokens
assert.ok(countTokens({ messages: [{ content: 'abcd' }] }).input_tokens === 1);

// resolveSessionId: Claude Code _session_<uuid> → ses_<hex> (conversation-stable)
assert.strictEqual(
  resolveSessionId({ metadata: { user_id: '_session_1234abcd-efef' } }, {}),
  'ses_1234abcdefef'
);
// x-opencode-session header passthrough wins
assert.strictEqual(
  resolveSessionId({ metadata: { user_id: '_session_0000' } }, { 'x-opencode-session': 'ses_custom' }),
  'ses_custom'
);
// JSON metadata.session_id
assert.strictEqual(
  resolveSessionId({ metadata: { user_id: '{"session_id":"a1b2"}' } }, {}),
  'ses_a1b2'
);
// session headers fallback
assert.strictEqual(resolveSessionId({}, { 'x-session-id': 'abc-def' }), 'ses_abcdef');
assert.strictEqual(resolveSessionId({}, {}), null);

// buildOpencodeHeaders: opencode identity on every route, UA forwarded when downstream is opencode
const h = buildOpencodeHeaders({ headers: { 'user-agent': 'opencode/0.20.1', 'x-opencode-project': 'proj' } }, 'ses_abc', true);
assert.strictEqual(h['x-opencode-client'], 'desktop');
assert.strictEqual(h['x-opencode-session'], 'ses_abc');
assert.strictEqual(h['x-opencode-project'], 'proj');
assert.strictEqual(h['User-Agent'], 'opencode/0.20.1');
assert.strictEqual(h.Accept, 'text/event-stream');
// non-opencode downstream → masquerade as opencode
assert.strictEqual(buildOpencodeHeaders({}, null, false)['User-Agent'], 'opencode');
assert.strictEqual(buildOpencodeHeaders({}, null, false).Accept, '*/*');
// session generated when none resolvable
assert.match(buildOpencodeHeaders({}, null, true)['x-opencode-session'], /^ses_[0-9a-f]+$/);

// injectReasoning: deepseek → every assistant, kimi → only tool_calls assistants, others untouched
assert.deepStrictEqual(
  injectReasoning([{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }], 'deepseek-v4-flash-free'),
  [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y', reasoning_content: ' ' }]
);
assert.strictEqual(
  injectReasoning([{ role: 'assistant', content: 'y', tool_calls: [{ id: 't' }] }], 'kimi-k3')[0].reasoning_content,
  ' '
);
assert.strictEqual(
  injectReasoning([{ role: 'assistant', content: 'y' }], 'kimi-k3')[0].reasoning_content,
  undefined
);
assert.deepStrictEqual(injectReasoning([{ role: 'user', content: 'x' }], 'glm-5.2'), [{ role: 'user', content: 'x' }]);

console.log('all proxy tests passed');
