# AGENTS.md

Run [Claude Code](https://docs.claude.com/en/docs/claude-code) against the OpenCode Free/Go/Zen plans by proxying through a local Anthropic-Messages↔OpenAI translation layer. Full docs: `README.md` (authoritative for behavior).

## Commands

- Test: `node test.mjs` — plain Node `assert` tests, no framework, no server. Imported functions come from `proxy.mjs`; add exports there for anything testable.
- Run the proxy standalone: `node proxy.mjs` (serves `127.0.0.1:3456`, `/health`, `/v1/models`, `/v1/messages`).
- No package.json, no dependencies, no build/lint/typecheck. Node 20+ only.

## Architecture

- `cli.mjs` — wrapper: reads key/plan from `%APPDATA%\opencodeclaude\config` (KEY=VALUE lines), starts/stops the proxy, sets Claude Code env vars, spawns `claude`.
- `proxy.mjs` — zero-dependency HTTP server. The hard part: streaming translation + routing. `translateStream()` (OpenAI SSE→Anthropic SSE) and `route()` are the most-tested, most-changed pieces.
- `test.mjs` — imports and unit-tests pure functions from `proxy.mjs` (route, toOpenAI/fromOpenAI, translateStream, countTokens, resolveSessionId, etc.).

## Routing rules (`route()` in proxy.mjs)

- `claude-*` and `qwen3*` → Zen `/zen/v1/messages` (native Anthropic, `x-api-key`, passthrough).
- `custom/<provider>/<model>` → the configured custom endpoint (`OPENCODE_CUSTOM_ENDPOINT` + `/chat/completions`), plain OpenAI headers, **no `x-opencode-*` masquerade**. Bare `custom/<model>` is accepted as an alias; a missing endpoint yields `url: ''` and the handler 400s.
- `*-free` → `/zen/v1/chat/completions` with dummy bearer `public` (no key, free plan).
- Everything else → Go `/zen/go/v1/...` or Zen `/zen/v1/...` per plan.
- Prefix `anthropic-go/` or `anthropic-zen/` overrides the plan (needed because Claude Code's model picker only lists ids starting `claude`/`anthropic`); old `opencode-go/`/`opencode-zen/` still accepted.

## Env vars

- `OPENCODE_PLAN` (`free|go|zen|custom`, default `go`), `OPENCODE_GO_KEY`/`OPENCODE_ZEN_KEY`/`OPENCODE_API_KEY`.
- Custom provider (all optional except the endpoint): `OPENCODE_CUSTOM_ENDPOINT` (OpenAI-compatible base URL; proxy appends `/chat/completions` and `/models`), `OPENCODE_CUSTOM_KEY` (omitted entirely — no Authorization header — when empty), `OPENCODE_CUSTOM_PROVIDER` (tags fetched models as `custom/<provider>/<model>`; default `custom`).
- Proxy-only: `OPENCODE_CONNECT_TIMEOUT_MS`, `OPENCODE_CONTEXT_LENGTH`, `OPENCODE_FORWARD_BETA` (off by default; Zen rejects most `anthropic-beta` headers — keep the allowlist in `filteredBeta()` narrow).

## Gotchas

- The proxy keeps conversation-stable session ids (`ses_*`) and `x-opencode-*` identity headers so opencode.ai treats requests as a real opencode client. Don't change these shapes casually — upstream validates against them. Custom-provider requests are the exception: no masquerade, plain `Bearer` auth (if a key is set).
- `reasoning_content` must be injected (`injectReasoning()`) for DeepSeek/Kimi or upstream rejects the payload.
- OpenAI requires tool messages immediately after assistant `tool_calls` and rejects a trailing assistant `tool_calls` with no following tool result — see the ordering logic in `toOpenAI()`.
- Proxy logs one JSON line per request to `%APPDATA%\opencodeclaude\proxy.log`; never log bodies/keys.
- `cli.mjs` kills any stale proxy on port 3456 at launch and on `uninstall`.

## Install/update file set

- Install copies only `cli.mjs` + `proxy.mjs`; `update` re-downloads `cli.mjs`, `proxy.mjs`, `test.mjs` from `https://raw.githubusercontent.com/dimassfeb-09/opencodeclaude/main`. New runtime files must be added to `install.ps1`/`install.sh` AND `UPDATE_FILES` in `cli.mjs`, or installed copies will miss them.
- Installed config/keys live in `%APPDATA%\opencodeclaude\config` (or `~/.config/opencodeclaude/`); `update` never touches it.
