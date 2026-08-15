#!/usr/bin/env node
// opencodeclaude - run Claude Code against the OpenCode Zen (pay-as-you-go),
// Go (flat fee) and Free (no account) plans.
//
// Cross-platform Node wrapper (no pwsh required): reads the stored key/plan,
// manages the local proxy lifecycle, sets the env vars Claude Code expects and
// launches the `claude` CLI with all args passed through.
//
// Subcommands: key|config, plan, reset, uninstall. Everything else is forwarded
// to `claude` as-is.
import { spawn, spawnSync } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROXY_FILE = path.join(ROOT, 'proxy.mjs');
const PORT = 3456;
const PROXY_URL = `http://127.0.0.1:${PORT}`;
const isWin = process.platform === 'win32';

// --- paths ---------------------------------------------------------------
const configDir = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'opencodeclaude')
  : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencodeclaude');
const configFile = path.join(configDir, 'config');

// Default model tiers. Claude/Qwen models run on both paid plans via Zen's
// Anthropic endpoint; the free plan is a fixed *-free model.
const TIERS = {
  go:   { opus: 'deepseek-v4-flash',      sonnet: 'deepseek-v4-flash',      haiku: 'deepseek-v4-flash' },
  zen:  { opus: 'claude-opus-4-8',        sonnet: 'claude-sonnet-4-6',      haiku: 'claude-haiku-4-5' },
  free: { opus: 'deepseek-v4-flash-free', sonnet: 'deepseek-v4-flash-free', haiku: 'deepseek-v4-flash-free' },
};

// --- colors (ANSI; only when a TTY) --------------------------------------
const color = (code) => (s) => (process.stdout.isTTY ? `[${code}m${s}[0m` : s);
const Accent = color('36');
const Bold = color('1');
const Dim = color('90');
const Green = color('32');
const Yellow = color('33');
const Blue = color('34');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function banner(title) {
  const line = '─'.repeat(title.length + 4);
  console.log(`\n${Accent(Bold(`┌${line}┐`))}`);
  console.log(`${Accent(Bold(`│  ${title}  │`))}`);
  console.log(`${Accent(Bold(`└${line}┘`))}\n`);
}

// --- config --------------------------------------------------------------
function readConfig() {
  const cfg = {};
  if (fs.existsSync(configFile)) {
    for (const line of fs.readFileSync(configFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) cfg[m[1]] = m[2];
    }
  }
  return cfg;
}

function writeConfig(cfg) {
  fs.mkdirSync(configDir, { recursive: true });
  const lines = ['OPENCODE_GO_KEY', 'OPENCODE_ZEN_KEY', 'OPENCODE_PLAN', 'OPENCODE_API_KEY']
    .filter((k) => cfg[k])
    .map((k) => `${k}=${cfg[k]}`);
  fs.writeFileSync(configFile, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
  if (!isWin) fs.chmodSync(configFile, 0o600);
}

function getKeyFor(plan) {
  const cfg = readConfig();
  const name = `OPENCODE_${plan.toUpperCase()}_KEY`;
  if (cfg[name]) return cfg[name];
  if (cfg.OPENCODE_API_KEY) return cfg.OPENCODE_API_KEY;
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY.trim();
  return null;
}

function saveKeyFor(plan, key) {
  key = key.trim();
  if (!key) { console.log(`${Yellow('Refusing to save an empty key.')}`); return; }
  const cfg = readConfig();
  cfg[`OPENCODE_${plan.toUpperCase()}_KEY`] = key;
  cfg.OPENCODE_PLAN = plan;
  writeConfig(cfg);
  console.log(`Key saved for the '${plan}' plan to ${configFile}`);
}

function setPlan(plan) {
  plan = plan.trim().toLowerCase();
  if (!Object.hasOwn(TIERS, plan)) {
    console.log(`${Yellow("Plan must be 'go', 'zen' or 'free'.")}`);
    process.exit(1);
  }
  const cfg = readConfig();
  cfg.OPENCODE_PLAN = plan;
  writeConfig(cfg);
  console.log(`${Green(`Plan set to '${plan}'.`)}`);
}

function getPlan() {
  const p = readConfig().OPENCODE_PLAN;
  return Object.hasOwn(TIERS, p) ? p : 'go';
}

// --- prompts -------------------------------------------------------------
function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

// Ask for input with the typed characters hidden (API keys).
function hiddenPrompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (/\r|\n/.test(String(s))) process.stdout.write(s); };
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

async function planPrompt() {
  banner('Choose your OpenCode plan');
  console.log(`${Dim('  1)')} ${Green(Bold('go'))}${Dim('   - flat-fee Go subscription')}`);
  console.log(`${Dim('  2)')} ${Green(Bold('zen'))}${Dim('  - pay-as-you-go Zen')}`);
  console.log(`${Dim('  3)')} ${Green(Bold('free'))}${Dim(' - no account needed, free models only')}`);
  for (let i = 0; i < 3; i++) {
    const p = (await prompt(`${Accent(Bold(' Choose plan [1/2/3]'))} `)).trim().toLowerCase();
    if (p === '1' || p === 'go') return setPlan('go');
    if (p === '2' || p === 'zen') return setPlan('zen');
    if (p === '3' || p === 'free') return setPlan('free');
    console.log(`${Yellow("Pick 1, 2, 3, 'go', 'zen' or 'free'.")}`);
  }
  console.log(`${Yellow('Aborting after 3 invalid attempts.')}`);
  process.exit(1);
}

async function setupKey(plan) {
  banner(`opencodeclaude - API key (${plan})`);
  console.log(`${Dim('Get a key:')} ${Blue(Bold('https://opencode.ai/auth'))}\n`);
  for (let i = 0; i < 3; i++) {
    const key = (await hiddenPrompt(`${Accent(Bold(` OpenCode API key for ${plan}`))} `)).trim();
    if (key) { saveKeyFor(plan, key); return; }
    console.log(`${Yellow("Key can't be empty.")}`);
  }
  console.log(`${Yellow('Aborting after 3 empty attempts.')}`);
  process.exit(1);
}

// --- prerequisites -------------------------------------------------------
function have(cmd) {
  try {
    const r = spawnSync(isWin ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return r.status === 0;
  } catch { return false; }
}

// --- proxy lifecycle -----------------------------------------------------
async function findListenerPid() {
  if (isWin) {
    const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp']).catch(() => ({ stdout: '' }));
    for (const line of stdout.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5 && parts[3] === 'LISTENING' && parts[1].endsWith(`:${PORT}`)) return parts[4];
    }
    return null;
  }
  const { stdout } = await execFileAsync('lsof', ['-ti', `tcp:${PORT}`]).catch(() => ({ stdout: '' }));
  const pids = stdout.trim().split(/\r?\n/).filter(Boolean);
  return pids.length ? pids[pids.length - 1] : null;
}

async function healthOk() {
  try {
    const r = await fetch(`${PROXY_URL}/health`, { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch { return false; }
}

async function killPid(pid) {
  try {
    if (isWin) await execFileAsync('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true });
    else await execFileAsync('kill', [String(pid)]);
  } catch {}
}

const PROXY_LOG = path.join(configDir, 'proxy.log');
const REPO = 'https://raw.githubusercontent.com/dimassfeb-09/opencodeclaude/main';
const UPDATE_FILES = ['cli.mjs', 'proxy.mjs', 'test.mjs'];

function startProxy(env) {
  // Capture proxy logs (usage lines, errors) to proxy.log next to the config.
  fs.mkdirSync(configDir, { recursive: true });
  const fd = fs.openSync(PROXY_LOG, 'a'); // append; OS closes the fd when the process exits
  return spawn(process.execPath, [PROXY_FILE], { env, stdio: ['ignore', fd, fd], windowsHide: true });
}

// --- uninstall -----------------------------------------------------------
async function uninstall() {
  const pid = await findListenerPid();
  if (pid) await killPid(pid);

  if (isWin) {
    // Defer shim removal: the .cmd shim may be the very file running this
    // script, and deleting it while cmd.exe is executing it errors out.
    const shims = [
      path.join(process.env.APPDATA || '', 'npm', 'opencodeclaude.cmd'),
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'opencodeclaude.cmd'),
    ].filter((s) => fs.existsSync(s));
    if (shims.length) {
      const cmdline = 'ping -n 2 127.0.0.1 >nul & ' + shims.map((s) => `del /f /q "${s}"`).join(' & ');
      spawn('cmd', ['/c', cmdline], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
    const installRoot = process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs', 'opencodeclaude')
      : null;
    if (installRoot && samePath(ROOT, installRoot)) fs.rmSync(ROOT, { recursive: true, force: true });
  } else {
    const share = process.env.XDG_DATA_HOME
      ? path.join(process.env.XDG_DATA_HOME, 'opencodeclaude')
      : path.join(os.homedir(), '.local', 'share', 'opencodeclaude');
    if (samePath(ROOT, share)) fs.rmSync(ROOT, { recursive: true, force: true });
    const binDir = process.env.XDG_BIN_HOME || path.join(os.homedir(), '.local', 'bin');
    fs.rmSync(path.join(binDir, 'opencodeclaude'), { force: true });
  }
  fs.rmSync(configDir, { recursive: true, force: true });
  console.log('opencodeclaude uninstalled.');
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// --- main ----------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd && /^(key|config|set-key|change|change-key|--key|--config|--set-key|--change|--change-key)$/.test(cmd)) {
    let target = getPlan();
    let inline = null;
    if (args.length >= 2) {
      if (['go', 'zen'].includes(args[1])) { target = args[1]; if (args.length >= 3) inline = args[2]; }
      else inline = args[1];
    }
    if (inline) saveKeyFor(target, inline); else await setupKey(target);
    console.log("Done. Run 'opencodeclaude' to start.");
    process.exit(0);
  }
  if (cmd && /^(plan|--plan)$/.test(cmd)) {
    if (args.length >= 2) setPlan(args[1]);
    else console.log(`Current plan: ${getPlan()}`);
    process.exit(0);
  }
  if (cmd && /^(reset|--reset)$/.test(cmd)) {
    fs.rmSync(configFile, { force: true });
    console.log('Stored keys removed.');
    process.exit(0);
  }
  if (cmd && /^(uninstall|--uninstall)$/.test(cmd)) {
    await uninstall();
    process.exit(0);
  }
  if (cmd && /^(update|--update|upgrade|--upgrade)$/.test(cmd)) {
    // Update the program files but NEVER touch the config (key/plan live in configDir).
    const isGitRepo = fs.existsSync(path.join(ROOT, '.git'));
    if (isGitRepo) {
      banner('Updating opencodeclaude (git)');
      console.log(`${Dim(`Pulling latest into ${ROOT} ...`)}`);
      const r = spawnSync('git', ['pull', '--ff-only', 'origin', 'main'], { cwd: ROOT, stdio: 'inherit' });
      if (r.status !== 0) { console.log(`${Yellow('Update failed (non-fast-forward or network).')}`); process.exit(1); }
      console.log(`${Green('Updated.')}  Config/keys untouched: ${configDir}`);
      process.exit(0);
    }
    // Installed copy: re-download the program files from GitHub main.
    banner('Updating opencodeclaude (download)');
    fs.mkdirSync(ROOT, { recursive: true });
    for (const f of UPDATE_FILES) {
      const url = `${REPO}/${f}`;
      console.log(`${Dim(`Downloading ${f} ...`)}`);
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        fs.writeFileSync(path.join(ROOT, f), await r.text(), 'utf8');
      } catch (e) {
        console.log(`${Yellow(`Failed to download ${f}: ${e?.message || e}`)}`);
        console.log(`${Yellow('Aborted; config untouched, existing files intact.')}`);
        process.exit(1);
      }
    }
    console.log(`${Green('Updated.')}  Config/keys untouched: ${configDir}`);
    console.log(`${Dim('Restart the shim / open a new terminal if running an old session.')}`);
    process.exit(0);
  }
  if (cmd && /^(log|--log|tail)$/.test(cmd)) {
    const follow = args.includes('-f') || args.includes('--follow');
    if (!fs.existsSync(PROXY_LOG)) {
      console.log(`No proxy log yet: ${PROXY_LOG}`);
      console.log("Run 'opencodeclaude' once to generate it (one JSON line per request).");
      process.exit(0);
    }
    const lines = fs.readFileSync(PROXY_LOG, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const l of lines.slice(-100)) console.log(l);
    console.log(`${Dim(`\n${lines.length} lines in ${PROXY_LOG}`)}`);
    if (follow) {
      let size = fs.statSync(PROXY_LOG).size;
      fs.watch(PROXY_LOG, () => {
        try {
          const data = fs.readFileSync(PROXY_LOG, 'utf8');
          const chunk = data.slice(size);
          if (chunk) process.stdout.write(chunk);
          size = data.length;
        } catch {}
      });
      console.log(`${Dim('Following new requests... Ctrl+C to stop.')}`);
      process.on('SIGINT', () => process.exit(0));
    } else {
      process.exit(0);
    }
  }

  // First run: pick a plan (interactive only).
  if (!readConfig().OPENCODE_PLAN) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.log('No plan configured and stdin is not a terminal.\nRun: opencodeclaude plan go|zen|free');
      process.exit(1);
    }
    await planPrompt();
  }

  const plan = getPlan();
  const freeMode = plan === 'free';
  let key = null;

  if (!freeMode) {
    key = getKeyFor(plan);
    if (!key && process.env.OPENCODE_API_KEY) {
      key = process.env.OPENCODE_API_KEY.trim();
      console.log('Using OPENCODE_API_KEY from environment; saving for next time.');
      saveKeyFor(plan, key);
    }
    if (!key) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.log(`No API key available for the '${plan}' plan and stdin is not a terminal.\nRun: opencodeclaude key`);
        process.exit(1);
      }
      await setupKey(plan);
      key = getKeyFor(plan);
    }
    if (!key) {
      console.log(`No API key available for the '${plan}' plan. Run 'opencodeclaude key' to set one.`);
      process.exit(1);
    }
  }

  if (!have('claude')) {
    console.log('claude CLI not found on PATH.');
    console.log('Install Claude Code first: https://docs.claude.com/en/docs/claude-code');
    process.exit(127);
  }

  console.log(`${Accent(Bold(' ● opencodeclaude'))}  ${Dim('> using')} ${Green(Bold(plan))}${Dim(' plan')}${Dim('  (change: opencodeclaude plan go|zen|free, key: opencodeclaude key)')}`);
  console.log(`${Dim('   proxy log:')} ${Blue(PROXY_LOG)}`);

  const tiers = TIERS[plan];
  const commonEnv = {
    OPENCODE_GO_KEY: getKeyFor('go') || '',
    OPENCODE_ZEN_KEY: getKeyFor('zen') || '',
    OPENCODE_API_KEY: key || '',
    OPENCODE_PLAN: plan,
  };

  let proxyProc = null;
  try {
    // Kill a stale opencodeclaude proxy already on the port so we always run current code.
    if (await healthOk()) {
      const stale = await findListenerPid();
      if (stale) { await killPid(stale); await delay(500); }
    }

    proxyProc = startProxy({ ...process.env, ...commonEnv });
    let ok = false;
    for (let i = 0; i < 20; i++) {
      await delay(250);
      if (await healthOk()) { ok = true; break; }
    }
    if (!ok) {
      console.log('Proxy failed to start. Is port 3456 free?');
      if (proxyProc) proxyProc.kill();
      process.exit(1);
    }

    const claudeEnv = {
      ...process.env,
      ...commonEnv,
      ANTHROPIC_BASE_URL: PROXY_URL,
      ANTHROPIC_API_KEY: freeMode ? 'opencode-free' : key,
      ANTHROPIC_AUTH_TOKEN: freeMode ? 'opencode-free' : key,
      ANTHROPIC_MODEL: tiers.sonnet,
      ANTHROPIC_DEFAULT_OPUS_MODEL: tiers.opus,
      ANTHROPIC_DEFAULT_SONNET_MODEL: tiers.sonnet,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: tiers.haiku,
      CLAUDE_CODE_SUBAGENT_MODEL: tiers.haiku,
      // Window enforcement is ON by default now that /v1/models reports a real
      // context_length (drives compaction so long sessions don't blow up). Opt out
      // with OPENCODE_DISABLE_WINDOW_ENFORCEMENT=1 to restore the old behaviour.
      ...(process.env.OPENCODE_DISABLE_WINDOW_ENFORCEMENT === '1' ? { CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1' } : {}),
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
      // claude still pings its own telemetry/consent endpoints (statsig/anthropic.com)
      // even with a custom base URL; those can be firewall-blocked and cause the
      // "Connection refused ... Retrying in Ns" loop. Disable them.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };

    const child = spawn('claude', args, { env: claudeEnv, stdio: 'inherit', shell: isWin });
    const code = await new Promise((resolve) => child.on('close', (c, sig) => resolve(c ?? (sig ? 1 : 0))));
    proxyProc.kill();
    proxyProc = null;
    process.exit(code ?? 0);
  } finally {
    if (proxyProc) proxyProc.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
