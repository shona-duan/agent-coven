#!/usr/bin/env node
// Jev 判断员：派活前分诊（triage）与审查前初筛（screen）。
// Jev 只给概率化判断，派给谁、要不要升级风险由下面的代码规则决定，调阈值不必重问模型。
//   node jev.mjs triage --task /abs/task.json [--leader claude|codex]
//   node jev.mjs screen --run-id run-UUID [--state-root /state]
//   node jev.mjs screen --diff /abs/x.patch --brief '说明'|@/abs/brief.txt [--scope a,b] [--risk low|mid|high] [--id 名称]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 本机配置可省略，说明键不参与配置。
let config = {};
try { config = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(new URL('../../../config.json', import.meta.url), 'utf8'))).filter(([key]) => !key.startsWith('_'))); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || (process.env.AGENT_HUB_PROXY ?? process.env.TEAM_DEV_JEV_PROXY ?? config.proxy ?? '');
if (proxy) process.env.HTTPS_PROXY = proxy;

// 未启用 Node 环境代理时带上所选代理变量重启自身。
if (!process.env.NODE_USE_ENV_PROXY) {
  const env = { ...process.env, NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' };
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', env });
  process.exit(r.status ?? 1);
}

const MODEL = process.env.TEAM_DEV_JEV_MODEL || 'jev-latest';
const PRICE_PER_MTOK = 0.042; // 仅输入计费，输出免费
const LEDGER = path.join(os.homedir(), 'agent-hub/state/ledger/jev.jsonl');
const fail = (code, message) => { process.stderr.write(JSON.stringify({ ok: false, code, message }) + '\n'); process.exit(2); };

async function ask(state, questions, purpose) {
  if (!process.env.TYPESAFE_API_KEY) fail('JEV_KEY_MISSING', '未设置 TYPESAFE_API_KEY');
  const res = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, state, questions }),
  });
  const body = await res.text();
  if (!res.ok) fail('JEV_HTTP_' + res.status, body.slice(0, 500));
  const data = JSON.parse(body);
  // 记账：ledger.mjs 读取这个文件
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.appendFileSync(LEDGER, JSON.stringify({ ts: Date.now(), purpose, model: data.model, input_tokens: data.usage?.input_tokens || 0, output_tokens: data.usage?.output_tokens || 0 }) + '\n');
  return data;
}

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
  return o;
}

// ---------- triage ----------
const TRIAGE = {
  size: {
    type: 'score',
    instructions: 'How much implementation work does `task` require for a skilled engineer who already knows the codebase? Judge only the work described in `task.brief`, `task.write_scope` and `task.acceptance`.',
    criteria: [
      'A tiny edit: one file, roughly 20 changed lines or fewer, no investigation needed.',
      'A small change: one or two files, under about 100 changed lines, straightforward.',
      'A moderate change: several files, or some reading and exploration of existing code is needed.',
      'A large change: many files, multiple design decisions, or debugging an unknown cause.',
    ],
  },
  spec_clear: {
    type: 'noul',
    instructions: 'Could a competent engineer start implementing `task` right away? Routine implementation choices (naming, helper structure, which existing utility to call) do not count against it.',
    criteria: { true: 'The goal, scope and expected behavior are stated; an engineer can begin coding now.', false: 'The goal or expected behavior is genuinely ambiguous, or a significant product or architecture decision has to be made before coding can start.' },
  },
  kind: {
    type: 'choice',
    instructions: 'What kind of work is `task` mainly?',
    criteria: {
      chinese_text: 'Writing or rewriting prose: documentation, comments, UI copy, i18n strings, especially in Chinese.',
      mechanical: 'Repetitive or mechanical edits that follow an explicit pattern: renames, boilerplate, bulk changes, adding tests for specified behavior.',
      feature: 'New or changed program logic with a clear specification.',
      design: 'Deciding requirements, architecture, interfaces or approach before code can be written.',
      debug: 'Finding the cause of a bug or failure whose cause is not yet known.',
    },
  },
  risk: {
    type: 'choice',
    instructions: 'How risky would a mistake in completing `task` be?',
    criteria: {
      low: 'Text, comments, docs, isolated helper code or tooling; a mistake is obvious and harmless.',
      mid: 'Ordinary product features or refactors spanning a few files; a mistake causes a normal bug.',
      high: 'Core business logic, security, authentication, permissions, payments, data migration or deletion, or a wide refactor; a mistake could lose data, leak access or break many users.',
    },
  },
};

// 与 dsh.mjs 的 SENSITIVE_NOT_DELEGATABLE 硬规则一致：命中即不交给 DeepSeek、风险按 high。
const SENSITIVE = /auth|login|password|passwd|token|secret|credential|crypt|signature|permission|oauth|jwt|payment|billing|鉴权|认证|登录|密码|令牌|密钥|加密|签名|权限|支付|计费/gi;
const sensitiveHits = task => [...new Set((JSON.stringify([task.brief, task.write_scope, (task.acceptance || []).map(x => x.description)]).match(SENSITIVE) || []).map(x => x.toLowerCase()))];

// 规则来自 2026-10-09 实测：组长 1–2 次调用能做完的活自己做更省。
function route(a, leader, hits = []) {
  const size = a.size.score, clear = a.spec_clear.noul, kind = a.kind.choice;
  const other = leader === 'claude' ? 'codex' : 'claude';
  let plan = null, executor, reason;
  if (size < 0.75) { executor = leader; reason = '活很小：组长自己做通常比写说明+审查更省'; }
  else if (kind === 'design' || clear < 0.4) {
    plan = 'claude';
    executor = size >= 1.5 ? 'codex' : 'deepseek';
    reason = '需求或方案未定：先由 Claude 出方案写进任务说明，再按方案派执行';
  }
  else if (['chinese_text', 'mechanical'].includes(kind)) { executor = 'deepseek'; reason = '文字/机械类活：交给最便宜的 DeepSeek'; }
  else if (size >= 2.25 || kind === 'debug') { executor = 'codex'; reason = '较大或需要调试：交给 Codex 在仓库内连续实现和测试'; }
  else { executor = 'deepseek'; reason = '中小型、说明清楚的功能：先给 DeepSeek，组长审查'; }
  // 风险：Choice 给出主判断；high 概率 ≥0.35 即升级，宁严勿松。高风险不交给 DeepSeek 首写。
  const pr = a.risk.probabilities;
  const risk = pr.high >= 0.35 || hits.length ? 'high' : a.risk.choice;
  if (hits.length && executor === 'deepseek') reason += `；命中敏感词 ${hits.join('/')}，硬规则禁止下放 DeepSeek`;
  if (risk === 'high' && executor === 'deepseek') { executor = 'codex'; reason += '；高风险改由 Codex 实现'; }
  const lowConfidence = a.size.confidence < 0.5 || a.kind.confidence < 0.5;
  return { plan, executor, self: executor === leader && !plan, reason, risk, low_confidence: lowConfidence };
}

async function triage(o) {
  if (!o.task) fail('ARGUMENT_ERROR', '需要 --task /abs/task.json');
  const task = JSON.parse(fs.readFileSync(o.task, 'utf8'));
  const leader = o.leader || task.leader || 'claude';
  const state = { task: { brief: task.brief, write_scope: task.write_scope, acceptance: (task.acceptance || []).map(x => x.description), constraints: task.constraints || [] } };
  const res = await ask(state, TRIAGE, 'triage:' + (task.id || path.basename(o.task)));
  const a = res.answers;
  const hits = sensitiveHits(task);
  const decision = { ...route(a, leader, hits), sensitive_hits: hits };
  console.log(JSON.stringify({
    task_id: task.id, leader, ...decision,
    signals: {
      size: +a.size.score.toFixed(2), size_confidence: +a.size.confidence.toFixed(2),
      spec_clear: +a.spec_clear.noul.toFixed(2),
      kind: a.kind.choice, kind_probabilities: a.kind.probabilities,
      risk: a.risk.choice, risk_probabilities: a.risk.probabilities,
    },
    jev: { model: res.model, input_tokens: res.usage.input_tokens, usd: +(res.usage.input_tokens * PRICE_PER_MTOK / 1e6).toFixed(6) },
  }, null, 2));
}

// ---------- screen ----------
const SCREEN = {
  out_of_brief: { type: 'noul', instructions: 'Does `diff` contain changes that `brief` did not ask for (unrelated files, refactors, or features beyond the request)?' },
  removes_behavior: { type: 'noul', instructions: 'Does `diff` remove or break existing functionality, exports, options or documented behavior that `brief` did not ask to change?' },
  security: { type: 'noul', instructions: 'Does `diff` touch security-sensitive code: authentication, authorization, permissions, credentials, secrets, cryptography, or input that reaches a shell or database?' },
  data_risk: { type: 'noul', instructions: 'Does `diff` add or change operations that delete, migrate or irreversibly modify persistent data or user files?' },
  incomplete: { type: 'noul', instructions: 'Does `diff` look unfinished: placeholders, TODOs added for required parts, stubbed functions, or obviously missing pieces of what `brief` asked for?' },
};
const DIFF_LIMIT = 60000; // 约 2 万 token，留出 32k 的 state 预算

async function screen(o) {
  let run, diff;
  if (o.diff) {
    // 日常派活没有 team-dev 运行记录：直接给 diff 文件和任务说明。
    if (!o.brief) fail('ARGUMENT_ERROR', '--diff 需要同时给 --brief（文字，或 @文件路径）');
    const brief = o.brief.startsWith('@') ? fs.readFileSync(o.brief.slice(1), 'utf8') : o.brief;
    run = { id: null, task: { id: o.id || path.basename(o.diff), brief, write_scope: o.scope ? o.scope.split(',') : [], risk: o.risk || 'mid' } };
    diff = fs.readFileSync(o.diff, 'utf8');
  } else {
    if (!o['run-id']) fail('ARGUMENT_ERROR', '需要 --run-id，或 --diff 文件 --brief 说明');
    const root = o['state-root'] || process.env.TEAM_DEV_STATE || path.join(os.homedir(), 'agent-hub/state/team-dev');
    const dir = path.join(root, 'runs', o['run-id']);
    run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
    diff = fs.existsSync(path.join(dir, 'changes.patch')) ? fs.readFileSync(path.join(dir, 'changes.patch'), 'utf8') : '';
  }
  if (!diff.trim()) fail('NO_DIFF', '先运行 collect 生成 changes.patch');
  const truncated = diff.length > DIFF_LIMIT;
  if (truncated) diff = diff.slice(0, DIFF_LIMIT);
  const res = await ask({ brief: run.task.brief, write_scope: run.task.write_scope, diff }, SCREEN, 'screen:' + run.task.id);
  const flags = Object.fromEntries(Object.entries(res.answers).map(([k, v]) => [k, +v.noul.toFixed(2)]));
  const attention = Object.entries(flags).filter(([, p]) => p >= 0.5).map(([k]) => k);
  const escalate = run.task.risk !== 'high' && (flags.security >= 0.5 || flags.data_risk >= 0.5);
  console.log(JSON.stringify({
    run_id: run.id, task_id: run.task.id, risk: run.task.risk,
    attention, escalate_to_high: escalate, flags, diff_truncated: truncated,
    note: '初筛只提示审查重点，不代替组长审查；escalate_to_high 时请把任务 risk 改为 high 并按高风险验收。',
    jev: { model: res.model, input_tokens: res.usage.input_tokens, usd: +(res.usage.input_tokens * PRICE_PER_MTOK / 1e6).toFixed(6) },
  }, null, 2));
}

const [cmd, ...rest] = process.argv.slice(2);
const o = args(rest);
if (cmd === 'triage') await triage(o);
else if (cmd === 'screen') await screen(o);
else fail('ARGUMENT_ERROR', '用法: triage --task /abs/task.json [--leader claude|codex] | screen --run-id run-UUID [--state-root /state] | screen --diff 文件 --brief 说明');
