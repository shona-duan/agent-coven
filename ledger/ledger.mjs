#!/usr/bin/env node
// 协作 token 账本：自动按会话汇总用量；小活不记，手动只记派活窗口和预估≥4轮仍自己做的理由。
//   node ledger.mjs task start <id> [--mode self|delegated] [--estimate 自己做预估轮数] [--title 文本]
//   node ledger.mjs task end <id> [--note 文本]
//   node ledger.mjs task note <id> --estimate N --actual N [--mode self|delegated] [--why 文本] [--title 文本]
//   node ledger.mjs task list
//   node ledger.mjs build [--days 14]
//   LEDGER_STATE 覆盖状态目录，默认 ~/agent-hub/state/ledger。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { decodeSession } from '../skills/team-dev/scripts/lib/web.mjs';

const HOME = os.homedir();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = process.env.LEDGER_STATE || path.join(HOME, 'agent-hub/state/ledger');
const TASKS = path.join(STATE, 'tasks.jsonl');
const PRICES = JSON.parse(fs.readFileSync(path.join(HERE, 'prices.json'), 'utf8'));
const CONFIG_FILE = path.join(HERE, '../config.json');
const CONFIG = fs.existsSync(CONFIG_FILE) ? Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))).filter(([k]) => !k.startsWith('_'))) : {};
const expandHome = h => h.replace(/^(?:~|\$HOME)(?=\/|$)/, () => HOME);
const escapeRE = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const repoPaths = root => {
  const absolute = path.resolve(expandHome(root));
  return { absolute, pattern: absolute === HOME || absolute.startsWith(HOME + '/')
    ? `(?:${escapeRE(HOME)}|~|\\$HOME)${escapeRE(absolute.slice(HOME.length))}` : escapeRE(absolute) };
};
const REPO_ROOTS = (CONFIG.repo_roots ?? ['~/Desktop', '~/code', '~/projects', '~/src']).map(repoPaths);
const HUB_PATTERN = new RegExp(`${repoPaths('~/agent-hub').pattern}(?=$|[/\\s"'\x60<>;|)&])`, 'g');
const M = 1e6;

function args(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
    else pos.push(argv[i]);
  }
  return { pos, opt };
}

function* jsonl(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { yield JSON.parse(line); } catch { /* 跳过半行 */ }
  }
}

function walk(dir, test, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, test, out);
    else if (test(p)) out.push(p);
  }
  return out;
}

const recent = (file, since) => { try { return fs.statSync(file).mtimeMs >= since; } catch { return false; } };

// 工具参数里可能嵌套 command/file_path 等字符串，按配置的父目录识别仓库。
function reposFrom(value, repos = new Set()) {
  if (typeof value === 'string') {
    for (const root of REPO_ROOTS) {
      const re = new RegExp(`${root.pattern}/([\\w.-]+)`, 'g');
      for (const m of value.matchAll(re)) {
        // 父目录下也会有散放的文档，不能把文件名当仓库。
        try { if (fs.statSync(path.join(root.absolute, m[1])).isFile()) continue; } catch { /* 已移走的目录仍保留 */ }
        repos.add(m[1]);
      }
    }
    if ([...value.matchAll(HUB_PATTERN)].length) repos.add('agent-hub');
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) reposFrom(v, repos);
  }
  return repos;
}

// ---- Claude：~/.claude/projects/**/*.jsonl，同一 message.id 的多行只计一次 ----
function claude(since) {
  const p = PRICES.claude, events = [], sessions = {}, starts = {}, repos = {};
  for (const file of walk(path.join(HOME, '.claude/projects'), f => f.endsWith('.jsonl') && recent(f, since))) {
    const seen = new Set(), firstTs = {};
    for (const r of jsonl(file)) {
      const id = r.sessionId || path.basename(file, '.jsonl');
      if (r.type === 'assistant') for (const c of r.message?.content || []) {
        if (c.type === 'tool_use') reposFrom(c.input, repos[id] ||= new Set());
      }
      const u = r.message?.usage;
      if (r.type !== 'assistant' || !u || !r.timestamp) continue;
      const key = r.message.id || r.requestId || r.uuid;
      firstTs[key] ??= Date.parse(r.timestamp);
      // 发出 task start 的那次调用本身属于任务：记下它的时间，窗口从这里开始
      for (const c of r.message.content || []) {
        const m = c.type === 'tool_use' && JSON.stringify(c.input || {}).match(/ledger\.mjs task start ([\w.-]+)/);
        if (m) starts[m[1]] = Math.min(starts[m[1]] ?? Infinity, firstTs[key] - 1);
      }
      if (seen.has(key)) continue;
      seen.add(key);
      const ts = Date.parse(r.timestamp);
      if (ts < since) continue;
      const cw1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      const cw = u.cache_creation_input_tokens || 0, cw5m = Math.max(cw - cw1h, 0);
      const e = { who: 'claude', ts, session: id, cwd: r.cwd, input: u.input_tokens || 0, cache_write: cw, cache_read: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 };
      e.usd = (e.input * p.input + cw5m * p.cache_write_5m + cw1h * p.cache_write_1h + e.cache_read * p.cache_read + e.output * p.output) / M;
      events.push(e);
      const s = sessions[id] ||= { who: 'claude', id, cwd: r.cwd, start: ts, end: ts, title: '' };
      s.start = Math.min(s.start, ts); s.end = Math.max(s.end, ts);
    }
    // 会话标题：第一条用户文字
    for (const r of jsonl(file)) {
      const id = r.sessionId || path.basename(file, '.jsonl');
      if (r.type !== 'user' || !sessions[id] || sessions[id].title) continue;
      const c = r.message?.content;
      const t = typeof c === 'string' ? c : Array.isArray(c) ? c.find(x => x.type === 'text')?.text : '';
      if (t && !/^\s*(<|Base directory for this skill)/.test(t)) sessions[id].title = t.trim().slice(0, 80);
    }
  }
  return { events, sessions: Object.values(sessions).map(s => ({ ...s, repos: [...(repos[s.id] || [])].sort() })), starts };
}

// ---- Codex：~/.codex/sessions/**/rollout-*.jsonl，用累计值做差得到每次调用的增量 ----
function codex(since) {
  const p = PRICES.codex, events = [], sessions = [], limits = [];
  for (const file of walk(path.join(HOME, '.codex/sessions'), f => /rollout-.*\.jsonl$/.test(f) && recent(f, since))) {
    let meta = {}, title = '', prev = null, first = null, last = null;
    const repos = new Set();
    for (const r of jsonl(file)) {
      const pl = r.payload || {};
      if (r.type === 'session_meta') meta = pl;
      if (r.type === 'response_item' && /call$/.test(pl.type || '')) reposFrom([pl.arguments, pl.input, pl.action], repos);
      if (!title && r.type === 'response_item' && pl.role === 'user') {
        const t = (pl.content || []).map(c => c.text || '').join('');
        if (t && !/^\s*(<|# AGENTS\.md)/.test(t)) title = t.trim().slice(0, 80);
      }
      if (pl.type !== 'token_count') continue;
      const ts = Date.parse(r.timestamp);
      const rl = pl.rate_limits;
      if (rl?.primary) limits.push({ ts, primary: rl.primary.used_percent, secondary: rl.secondary?.used_percent ?? null, plan: rl.plan_type });
      const t = pl.info?.total_token_usage;
      if (!t || (prev && t.total_tokens <= prev.total_tokens)) continue;
      const d = k => (t[k] || 0) - (prev?.[k] || 0);
      const cached = d('cached_input_tokens'), input = d('input_tokens') - cached;
      const e = { who: 'codex', ts, session: meta.id || path.basename(file), input, cache_read: cached, cache_write: d('cache_write_input_tokens'), output: d('output_tokens') };
      prev = t;
      if (ts < since) continue;
      e.usd = (e.input * p.input + e.cache_read * p.cache_read + e.output * p.output) / M;
      events.push(e);
      first ??= ts; last = ts;
    }
    if (first) {
      const src = typeof meta.source === 'string' ? meta.source : Object.keys(meta.source || {})[0] || '';
      sessions.push({ who: 'codex', id: meta.id || path.basename(file), cwd: meta.cwd, start: first, end: last, title, source: src, originator: meta.originator, repos: [...reposFrom(meta.cwd, repos)].sort() });
    }
  }
  limits.sort((a, b) => a.ts - b.ts);
  return { events, sessions, limits };
}

// ---- DeepSeek：DSH_HOME/sessions/**/session.v4.jsonl.zstd，每步 assistant/message 带 usage ----
function deepseek(since) {
  const p = PRICES.deepseek, events = [], sessions = [];
  // 兼容旧 prices.json；展开后去重，避免同一个数据目录重复计费。
  const homes = [...new Set([...(CONFIG.dsh_homes ?? []), ...(PRICES.dsh_homes ?? [])].map(expandHome))];
  for (const home of homes) {
    for (const file of walk(path.join(home, 'sessions'), f => f.endsWith('.jsonl.zstd') && recent(f, since))) {
      let rows;
      try { rows = decodeSession(file); } catch { continue; }
      const id = path.basename(path.dirname(file));
      let first = null, last = null, title = '', cwd = '';
      for (const r of rows) {
        if (r.type === 'session') cwd = r.cwd || r.data?.cwd || cwd;
        if (r.type === 'session/title') title = r.data?.title || title;
        const u = r.data?.usage;
        if (r.type !== 'assistant/message' || !u || r.time < since) continue;
        const e = { who: 'deepseek', ts: r.time, session: id, input: u.inputTokens || 0, cache_read: u.cacheReadTokens || 0, cache_write: u.cacheWriteTokens || 0, output: u.outputTokens || 0 };
        e.usd = (e.input * p.input + e.cache_read * p.cache_read + e.output * p.output) / M;
        events.push(e);
        first ??= r.time; last = r.time;
      }
      if (first) sessions.push({ who: 'deepseek', id, cwd: cwd || path.basename(path.dirname(path.dirname(file))), start: first, end: last, title });
    }
  }
  return { events, sessions };
}

// ---- Jev：jev.mjs 每次调用追加一行到 state/ledger/jev.jsonl（只按输入计费） ----
function jev(since) {
  const p = PRICES.jev, events = [];
  for (const r of jsonl(path.join(STATE, 'jev.jsonl'))) {
    if (r.ts < since) continue;
    events.push({ who: 'jev', ts: r.ts, session: r.purpose, input: r.input_tokens || 0, cache_read: 0, cache_write: 0, output: r.output_tokens || 0, usd: (r.input_tokens || 0) * p.input / M });
  }
  return { events };
}

function readTasks() {
  const tasks = {};
  for (const e of jsonl(TASKS)) {
    const t = tasks[e.id] ||= { id: e.id, mode: 'self', title: e.id, ts: e.ts, start: null, end: null };
    if (e.event === 'start') Object.assign(t, { mode: e.mode || 'self', title: e.title || t.title, estimate: e.estimate ?? null, start: e.ts, end: null });
    if (e.event === 'end') Object.assign(t, { end: e.ts, note: e.note || t.note });
    if (e.event === 'note') Object.assign(t, { mode: e.mode || 'self', title: e.title || t.title, estimate: e.estimate, actual: e.actual, why: e.why || '', ts: e.ts, start: null, end: null });
  }
  return Object.values(tasks);
}

const sum = (events, who) => {
  const s = { input: 0, cache_read: 0, cache_write: 0, output: 0, usd: 0, calls: 0 };
  for (const e of events) if (!who || e.who === who) { s.input += e.input; s.cache_read += e.cache_read; s.cache_write += e.cache_write; s.output += e.output; s.usd += e.usd; s.calls++; }
  s.total = s.input + s.cache_read + s.cache_write + s.output;
  return s;
};

// 窗口前最后一次 / 窗口内最后一次额度快照之差
function quotaDelta(limits, start, end) {
  const before = limits.filter(l => l.ts <= start).at(-1), after = limits.filter(l => l.ts <= end).at(-1);
  if (!before || !after || after === before) return null;
  const dp = after.primary - before.primary;
  return { primary: dp >= 0 ? dp : null, secondary: after.secondary != null && before.secondary != null ? after.secondary - before.secondary : null };
}

function build(opt) {
  const days = Number(opt.days || 14), since = Date.now() - days * 864e5;
  const c = claude(since), x = codex(since), d = deepseek(since), j = jev(since);
  const events = [...c.events, ...x.events, ...d.events, ...j.events].sort((a, b) => a.ts - b.ts);
  const tasks = readTasks().map(t => {
    const start = t.start == null ? null : Math.min(t.start, c.starts[t.id] ?? Infinity), end = t.end || Date.now();
    const inWin = start == null ? [] : events.filter(e => e.ts >= start && e.ts <= end);
    return { ...t, start, open: start != null && !t.end, by: { claude: sum(inWin, 'claude'), codex: sum(inWin, 'codex'), deepseek: sum(inWin, 'deepseek'), jev: sum(inWin, 'jev') }, all: sum(inWin), codex_quota: start == null ? null : quotaDelta(x.limits, t.start, end) };
  });
  const sessionTotals = new Map();
  for (const e of events) {
    const key = `${e.who}:${e.session}`, s = sessionTotals.get(key) || { calls: 0, usd: 0, tokens: 0 };
    s.calls++; s.usd += e.usd; s.tokens += e.input + e.cache_read + e.cache_write + e.output;
    sessionTotals.set(key, s);
  }
  const daily = {};
  for (const e of events) {
    const day = new Date(e.ts).toLocaleDateString('sv-SE');
    const row = daily[day] ||= { claude: 0, codex: 0, deepseek: 0, jev: 0, claude_tok: 0, codex_tok: 0, deepseek_tok: 0, jev_tok: 0 };
    row[e.who] += e.usd; row[e.who + '_tok'] += e.input + e.cache_read + e.cache_write + e.output;
  }
  const data = {
    generated_at: Date.now(), days, prices: PRICES,
    totals: { claude: sum(events, 'claude'), codex: sum(events, 'codex'), deepseek: sum(events, 'deepseek'), jev: sum(events, 'jev') },
    daily, tasks, codex_limits: x.limits.slice(-400),
    sessions: [...c.sessions, ...x.sessions, ...d.sessions].map(s => ({ ...s, ...sessionTotals.get(`${s.who}:${s.id}`), repos: s.repos || [...reposFrom(s.cwd)].sort() })).sort((a, b) => b.usd - a.usd || b.start - a.start).slice(0, 200),
  };
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(path.join(STATE, 'data.json'), JSON.stringify(data, null, 1));
  const html = fs.readFileSync(path.join(HERE, 'dashboard.template.html'), 'utf8').replace('/*__DATA__*/null', JSON.stringify(data).replace(/</g, '\\u003c'));
  const out = path.join(STATE, 'dashboard.html');
  fs.writeFileSync(out, html);
  console.log(JSON.stringify({ dashboard: out, events: events.length, tasks: tasks.length, totals_usd: Object.fromEntries(Object.entries(data.totals).map(([k, v]) => [k, +v.usd.toFixed(4)])) }, null, 2));
}

const { pos, opt } = args(process.argv.slice(2));
if (pos[0] === 'task' && ['start', 'end', 'note'].includes(pos[1]) && pos[2]) {
  fs.mkdirSync(STATE, { recursive: true });
  if (pos[1] === 'end' && !opt.force) {
    // 事后补记的窗口几乎为零，记了也不准：拦下来，改用 task note。
    const t = readTasks().find(x => x.id === pos[2]);
    if (!t || t.start == null) { console.error(`没有 ${pos[2]} 的 start 记录；事后补记请用 task note（或 --force）`); process.exit(2); }
    if (Date.now() - t.start < 120000) { console.error('窗口不足 2 分钟，像是事后补记；改用 task note 记轮数（或 --force）'); process.exit(2); }
  }
  if (pos[1] !== 'end') opt.mode ??= 'self';
  if (opt.mode && !['self', 'delegated'].includes(opt.mode)) { console.error('--mode 必须是 self 或 delegated（默认 self）'); process.exit(2); }
  if (pos[1] === 'note' && ['estimate', 'actual'].some(k => opt[k] == null || opt[k] === true || !Number.isFinite(Number(opt[k])) || Number(opt[k]) < 0)) { console.error('task note 必须提供 --estimate N --actual N（非负轮数）'); process.exit(2); }
  const e = { event: pos[1], id: pos[2], ts: Date.now(), ...(opt.mode && { mode: opt.mode }), ...(opt.estimate != null && { estimate: Number(opt.estimate) }), ...(opt.actual != null && { actual: Number(opt.actual) }), ...(opt.why && { why: opt.why }), ...(opt.title && { title: opt.title }), ...(opt.note && { note: opt.note }) };
  fs.appendFileSync(TASKS, JSON.stringify(e) + '\n');
  console.log(JSON.stringify(e));
} else if (pos[0] === 'task' && pos[1] === 'list') {
  for (const t of readTasks().sort((a, b) => (a.start ?? a.end ?? a.ts) - (b.start ?? b.end ?? b.ts))) {
    const mins = Math.round(((t.end || Date.now()) - t.start) / 60000);
    console.log([t.id.padEnd(16), (t.mode === 'self' ? '自己做' : '派出去').padEnd(4), new Date(t.start ?? t.end ?? t.ts).toLocaleString('zh-CN'), t.start == null ? '无窗口' : t.end ? `${mins} 分钟` : '进行中', t.title, t.estimate != null ? `预估 ${t.estimate} / 实际 ${t.actual ?? '—'} 轮 ${t.why || ''}` : ''].join('  '));
  }
} else if (pos[0] === 'build') build(opt);
else { console.error('用法: task start <id> [--mode self|delegated] [--estimate N] [--title 文本]; task end <id> [--note 文本]; task note <id> --estimate N --actual N [--mode self|delegated] [--why 文本] [--title 文本]; task list; build [--days 14]\n小活不记；派活用 start/end，预估≥4轮仍自己做用 note。会话自动统计；LEDGER_STATE 可覆盖状态目录。'); process.exit(2); }
