#!/usr/bin/env node
// 离线行为回归：只运行自建的假 Harness，不读真实凭据、不调用模型。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { identity, alive, readJSON, atomic, sleep, inventory, changed, validateTask, Store, capture, taskKey, scopes, uid, taskSensitivity } from './lib/core.mjs';
import { defaultStateRoot } from './lib/config.mjs';
import { resolveOptions } from './dsh.mjs';
import { doctor, childEnvironment, makePrompt } from './lib/runtime.mjs';

const base = path.resolve(process.argv[2] || path.join(process.cwd(), 'work', `dsh-validation-${Date.now()}`));
fs.mkdirSync(base, { recursive: true });
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dsh.mjs');
const fake = path.join(base, 'fake-dsh'), home = path.join(base, 'fake-home');
const write = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const json = (p, data) => write(p, JSON.stringify(data, null, 2));
json(path.join(fake, 'package.json'), { name: '@deepseek-ai/dsh', version: 'offline-fixture', type: 'module' });
write(path.join(fake, 'node_modules/js-yaml/index.js'), 'exports.load = JSON.parse;');
json(path.join(fake, 'node_modules/@deepseek-ai/dsh-headless/package.json'), { name: '@deepseek-ai/dsh-headless', version: 'offline-fixture' });
write(path.join(fake, 'node_modules/@deepseek-ai/dsh-headless/lib/startup.js'), '/* headless */');
json(path.join(home, 'settings.yaml'), { 'agent-default-model': { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' }, permission: { defaultPreset: 'danger-full-access' } });
json(path.join(home, '.credentials.yaml'), { refs: { DEEPSEEK_API_KEY: 'sk-offline-fixture-only' } });
const bin = path.join(fake, 'bin.mjs');
write(bin, `import fs from 'node:fs'; import path from 'node:path'; import {spawn} from 'node:child_process';
const prompt=process.argv.at(-1); const start=prompt.indexOf('任务契约：\\n')+'任务契约：\\n'.length;
const tail=prompt.slice(start);const end=tail.search(/\\n\\n(?:上一轮审查|完成后)/);const task=JSON.parse(tail.slice(0,end));
const f=task.fixture||{}; fs.appendFileSync(${JSON.stringify(path.join(base, 'fake-invocations.log'))},task.id+'\\n');
const target=task.write_scope[0];fs.mkdirSync(path.dirname(target),{recursive:true});
fs.writeFileSync(target,f.text||'export const value = 42;\\n');
if(f.mode==='escape')fs.writeFileSync('unexpected.txt','out of scope');
if(f.mode==='child'){const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('child.pid',String(c.pid));}
if(f.mode==='sleep')await new Promise(r=>setTimeout(r,f.ms||10000));
if(f.mode==='fail'){console.error('deliberate failure');process.exit(1);}
if(f.mode==='credential'){if(process.env.DEEPSEEK_API_KEY!=='tiny')process.exit(2);console.error(process.env.DEEPSEEK_API_KEY);}
if(f.mode!=='empty')console.log('DONE: '+target+(f.mode==='secret'?' sk-offline-fixture-only':''));
process.exit(0);
`);

json(path.join(base, 'empty-config.json'), {});
const results = [];
function setup(name) {
  const root = path.join(base, name), ws = path.join(root, 'workspace'), state = path.join(root, 'state');
  fs.mkdirSync(ws, { recursive: true });
  // scratch may be ignored by the enclosing agent-hub repository.
  assert.equal(spawnSync('git', ['init', '-q', ws]).status, 0);
  const common = ['--state-root', state, '--headless-only'];
  const active = new Set();
  function start(args) {
    const env = { ...process.env };
    delete env.DEEPSEEK_API_KEY; delete env.DEEPSEEK_BASE_URL;
    for (const key of Object.keys(env)) if (key.startsWith('TEAM_DEV_') || ['DSH_BIN', 'DSH_HOME'].includes(key)) delete env[key];
    env.TEAM_DEV_CONFIG = path.join(base, 'empty-config.json');
    const p = spawn(process.execPath, [cli, ...args, ...common], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    active.add(p); let out = '', err = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    const done = new Promise(resolve => p.on('close', (code, signal) => { active.delete(p); resolve({ code, signal, out, err }); }));
    return { p, done };
  }
  const call = async args => start(args).done;
  const task = (id, extra = {}) => ({ id, leader: 'codex', workspace: ws, brief: '离线验证 fixture', depends_on: [], write_scope: [`${id}.mjs`], timeout_seconds: 10, acceptance: [{ id: 'A1', description: '示例结果正确', required: true }], checks: [{ id: 'syntax', kind: 'syntax', argv: [process.execPath, '--check', `${id}.mjs`] }], ...extra });
  function saveTask(t) { const p = path.join(root, `${t.id}.task.json`); json(p, t); return p; }
  const run = (t, executor, flags = []) => start(['run', '--task', saveTask(t), '--dsh-bin', bin, '--dsh-home', home, ...(executor ? ['--executor', executor] : []), ...flags]);
  function stateOf(id) {
    const reg = readJSON(path.join(state, 'registry.json'));
    const t = Object.values(reg.tasks).find(x => x.id === id);
    return t && readJSON(path.join(state, 'runs', t.latest_run, 'run.json'));
  }
  async function waitRun(id, predicate = r => r.child) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try { const r = stateOf(id); if (r && predicate(r)) return r; } catch (e) { if (!['ENOENT'].includes(e.code)) throw e; }
      await sleep(30);
    }
    throw new Error(`等待 ${id} 超时`);
  }
  async function collect(id, flags = []) {
    const r = await call(['collect', '--run-id', id, ...flags]);
    assert.equal(r.code, 0, r.err); return JSON.parse(r.out);
  }
  async function review(r, decision, extras = {}, expectedCode = 0, flags = []) {
    const c = await collect(r.id);
    const file = path.join(root, `${r.id}.review.json`);
    json(file, { reviewer: r.task.leader, run_id: r.id, artifact_digest: c.artifact_digest, decision, summary: '离线状态门禁验证', spec: 'pass', quality: 'pass', blocking_findings: [], acceptance: [{ id: 'A1', status: 'pass', evidence: '离线 fixture 文件与实际检查日志' }], ...extras });
    const out = await call(['collect', '--run-id', r.id, '--review', file, ...flags]);
    assert.equal(out.code, expectedCode, out.err); return out;
  }
  async function close() {
    for (const p of active) p.kill('SIGTERM');
    const deadline = Date.now() + 5000;
    while (active.size && Date.now() < deadline) await sleep(50);
    for (const p of active) p.kill('SIGKILL');
  }
  return { root, ws, state, task, saveTask, start, call, run, stateOf, waitRun, collect, review, close };
}
async function scenario(name, fn) {
  const s = setup(name), start = Date.now();
  try { await fn(s); results.push({ name, status: 'pass', duration_ms: Date.now() - start }); }
  catch (e) { results.push({ name, status: 'fail', error: e.stack }); }
  finally { await s.close(); }
  console.log(`${results.at(-1).status.toUpperCase()} ${name}`);
}

await scenario('doctor-no-model-call', async s => {
  const before = fs.existsSync(path.join(base, 'fake-invocations.log'));
  const r = await s.call(['doctor', '--workspace', s.ws, '--dsh-bin', bin, '--dsh-home', home]);
  assert.equal(r.code, 0, r.err); assert.equal(JSON.parse(r.out).api_request_made, false);
  assert.equal(fs.existsSync(path.join(base, 'fake-invocations.log')), before);
  assert(!r.out.includes('sk-offline'));
  const badHome = path.join(s.root, 'bad-home'); fs.mkdirSync(badHome);
  json(path.join(badHome, 'settings.yaml'), { 'agent-default-model': { provider: 'deepseek-official', model: 'wrong', reasoningEffort: 'max' } });
  const modelConfig = path.join(s.root, 'model-config.json');
  json(modelConfig, {expected_model: {provider:'deepseek-official',model:'deepseek-v4-flash',reasoningEffort:'max'}});
  const bad = await s.call(['doctor', '--config', modelConfig, '--workspace', s.ws, '--dsh-bin', bin, '--dsh-home', badHome]);
  assert.equal(bad.code, 2); assert(bad.err.includes('MODEL_MISMATCH'));
});

await scenario('configuration-precedence-and-task-contract', async s => {
  const saved = {...process.env};
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith('TEAM_DEV_') || ['DSH_BIN','DSH_HOME','DEEPSEEK_API_KEY'].includes(key)) delete process.env[key];
    const config = path.join(s.root, 'local-config.json');
    const credential = path.join(s.root, 'credential.json'); json(credential, {DEEPSEEK_API_KEY:'tiny'});
    json(config, {dsh_bin:bin,dsh_home:home,credential_file:credential,web_mode:'required'});
    process.env.TEAM_DEV_CONFIG=config;
    process.env.DSH_BIN=path.join(s.root,'env-bin.mjs');
    process.env.TEAM_DEV_STATE=path.join(s.root,'env-state');
    let options=resolveOptions(); assert.equal(options['dsh-bin'],process.env.DSH_BIN); assert.equal(options['state-root'],process.env.TEAM_DEV_STATE);
    options=resolveOptions({'dsh-bin':bin,'state-root':s.state,'headless-only':true});
    assert.equal(options['dsh-bin'],bin); assert.equal(options['state-root'],s.state); assert.equal(options['web-mode'],'off');
    const report=doctor({...options,workspace:s.ws});
    assert.equal(childEnvironment(report.dsh_home,report.credential).DEEPSEEK_API_KEY,'tiny');
    assert(!JSON.stringify(report).includes('tiny'));
    process.env.DEEPSEEK_API_KEY='environment-key';
    assert.equal(doctor({...options,workspace:s.ws}).credential,'environment-key');
    const cliConfig=path.join(s.root,'cli-config.json');json(cliConfig,{});
    assert.equal(resolveOptions({config:cliConfig})['credential-file'],undefined);
    delete process.env.TEAM_DEV_STATE;
    assert.equal(new Store().root,defaultStateRoot());
    assert.equal(resolveOptions({config:cliConfig,'state-root':s.state})['web-mode'],'off');
    json(path.join(s.state,'web-config.json'),{});
    assert.equal(resolveOptions({config:cliConfig,'state-root':s.state})['web-mode'],'required');
    const t=validateTask(s.task('contract',{leader:'claude'}));assert.equal(t.risk,'mid');
    assert.throws(()=>validateTask({...t,leader:undefined}),/leader/);
    assert.throws(()=>validateTask({...t,risk:'unknown'}),/risk/);
    const prompt=makePrompt(t,{id:'fixture'},null);assert(prompt.includes('Claude'));assert(!prompt.includes('Codex'));
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env,saved);
  }
});

await scenario('deepseek-limit-configuration-precedence-and-validation', async s => {
  const saved = {...process.env};
  try {
    delete process.env.TEAM_DEV_DEEPSEEK_MAX_ATTEMPTS;
    const config = path.join(s.root, 'limit-config.json'); json(config, {deepseek_max_attempts:3});
    const input = {config, 'state-root':s.state};
    assert.equal(resolveOptions(input)['deepseek-max-attempts'], 3);
    process.env.TEAM_DEV_DEEPSEEK_MAX_ATTEMPTS = '1';
    assert.equal(resolveOptions(input)['deepseek-max-attempts'], 1);
    assert.equal(resolveOptions({...input, 'deepseek-max-attempts':'2'})['deepseek-max-attempts'], 2);
    delete process.env.TEAM_DEV_DEEPSEEK_MAX_ATTEMPTS;
    json(config, {}); assert.equal(resolveOptions(input)['deepseek-max-attempts'], 2);
    for (const value of [0, 4, 1.5, '', '2.5', '02', true, {}, []]) {
      assert.throws(() => resolveOptions({...input, 'deepseek-max-attempts':value}), {code:'INVALID_CONFIG'});
    }
    json(config, {deepseek_max_attempts:4}); assert.throws(() => resolveOptions(input), {code:'INVALID_CONFIG'});
    process.env.TEAM_DEV_DEEPSEEK_MAX_ATTEMPTS='bad'; assert.throws(() => resolveOptions(input), {code:'INVALID_CONFIG'});
    assert.equal(resolveOptions({...input, 'deepseek-max-attempts':3})['deepseek-max-attempts'], 3);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env,saved);
  }
});

await scenario('sensitive-risk-and-keywords-refuse-deepseek', async s => {
  for (const [id, extra, reason] of [
    ['highRisk', {risk:'high'}, 'risk=high'],
    ['english', {brief:'Update LOGIN form'}, 'keyword=login'],
    ['chinese', {acceptance:[{id:'A1',description:'权限校验正确'}]}, 'keyword=权限'],
    ['scoped', {write_scope:['oauth.mjs']}, 'keyword=oauth'],
  ]) {
    const before = fs.existsSync(path.join(base, 'fake-invocations.log')) ? fs.readFileSync(path.join(base, 'fake-invocations.log'), 'utf8') : '';
    const out = await s.run(s.task(id, extra), 'deepseek').done;
    assert.equal(out.code, 2); assert(out.err.includes('SENSITIVE_NOT_DELEGATABLE')); assert(out.err.includes(reason)); assert(out.err.includes('claude/codex'));
    assert(!fs.existsSync(path.join(s.state, 'registry.json')));
    assert.equal(fs.existsSync(path.join(base, 'fake-invocations.log')) ? fs.readFileSync(path.join(base, 'fake-invocations.log'), 'utf8') : '', before);
  }
  for (const sensitive_override of ['', ' ', true, 1, null]) {
    assert.throws(() => validateTask(s.task('invalidOverride', {sensitive_override})), {code:'INVALID_TASK'});
  }
  const both = taskSensitivity(validateTask(s.task('both', {risk:'high',brief:'PASSWORD 密钥'})));
  assert.deepEqual(both.sensitive_reasons, ['risk=high', 'keyword=password', 'keyword=密钥']);
  // Preparing a task makes no model call and remains allowed.
  assert.equal((await s.call(['run', '--task', s.saveTask(s.task('prepareHigh', {risk:'high'})), '--prepare'])).code, 0);
});

await scenario('sensitive-override-allows-and-records-reason', async s => {
  const reason = '离线假数据，仅验证字段存储';
  const t = s.task('override', {risk:'high', brief:'Fake TOKEN fixture', sensitive_override:reason});
  const out = await s.run(t).done; assert.equal(out.code, 0, out.err);
  const r = s.stateOf(t.id);
  assert.equal(r.sensitive, true); assert.deepEqual(r.sensitive_reasons, ['risk=high', 'keyword=token']);
  assert.equal(r.sensitive_override, reason); assert.equal(r.task.sensitive_override, reason);
  const outputs = out.out.trim().split(/\n(?=\{)/).map(text => JSON.parse(text));
  for (const output of outputs) {assert.equal(output.sensitive, true); assert.deepEqual(output.sensitive_reasons, r.sensitive_reasons); assert.equal(output.sensitive_override, reason);}
  const status = await s.call(['status','--run-id',r.id]); assert.equal(JSON.parse(status.out).sensitive, true);
});

await scenario('configured-three-attempts-and-last-chance-strategy', async s => {
  const config = path.join(s.root, 'limit-three.json'); json(config, {deepseek_max_attempts:3});
  const flags = ['--config',config]; const t = s.task('three', {leader:'codex'});
  for (let n = 0; n < 3; n++) {
    if (n === 2) {
      const denied = await s.run(t, 'deepseek', flags).done;
      assert.equal(denied.code, 2); assert(denied.err.includes('STRATEGY_CHANGE_REQUIRED'));
      await s.review(s.stateOf(t.id), 'rework', {strategy_change:'最后机会改用直接文件核对'}, 0, flags);
    }
    const out = await s.run(t, 'deepseek', flags).done; assert.equal(out.code, 0, out.err);
    assert.equal(s.stateOf(t.id).deepseek_max_attempts, 3);
    // Review uses the recorded limit even without repeating dispatch options.
    await s.review(s.stateOf(t.id), 'rework');
    assert.equal(s.stateOf(t.id).next_executor, n < 2 ? 'deepseek' : 'claude');
  }
  const fourth = await s.run(t, 'deepseek', flags).done;
  assert.equal(fourth.code, 2); assert(fourth.err.includes('TAKEOVER_REQUIRED')); assert(fourth.err.includes('--executor claude'));
});

await scenario('default-last-chance-strategy-and-takeover-by-priority', async s => {
  const t = s.task('strategy'); assert.equal((await s.run(t).done).code, 0);
  await s.review(s.stateOf(t.id), 'rework');
  const denied = await s.run(t).done; assert.equal(denied.code, 2); assert(denied.err.includes('STRATEGY_CHANGE_REQUIRED'));
  await s.review(s.stateOf(t.id), 'rework', {strategy_change:'换策略核对文件'});
  assert.equal((await s.run(t).done).code, 0);
  await s.review(s.stateOf(t.id), 'rework', {takeover_by:'codex'});
  assert.equal(s.stateOf(t.id).next_executor, 'codex');
  const exhausted = await s.run(t).done; assert(exhausted.err.includes('TAKEOVER_REQUIRED')); assert(exhausted.err.includes('--executor codex'));
  const manual = s.run(t, 'codex'); const r = await s.waitRun(t.id, x => x.status === 'RUNNING');
  await s.collect(r.id, ['--finish']); assert.equal((await manual.done).code, 0);
  // A manual executor is never forced through the DeepSeek strategy gate.
  await s.review(s.stateOf(t.id), 'takeover'); assert.equal(s.stateOf(t.id).next_executor, 'claude');
});

await scenario('one-attempt-immediate-takeover', async s => {
  const config = path.join(s.root, 'limit-one.json'); json(config, {deepseek_max_attempts:1});
  const t = s.task('one', {leader:'claude'});
  assert.equal((await s.run(t, 'deepseek', ['--config',config]).done).code, 0);
  await s.review(s.stateOf(t.id), 'rework'); assert.equal(s.stateOf(t.id).next_executor, 'codex');
  const denied = await s.run(t, 'deepseek', ['--config',config]).done;
  assert.equal(denied.code, 2); assert(denied.err.includes('TAKEOVER_REQUIRED'));
});

await scenario('metadata-only-change-is-not-code-change', async s => {
  const p = path.join(s.ws, 'note.txt'); write(p, 'keep user text');
  fs.chmodSync(p, 0o644);
  const before = inventory(s.ws); await sleep(20);
  fs.chmodSync(p, fs.statSync(p).mode & 0o777);
  assert.deepEqual(changed(before, inventory(s.ws)), []);
  fs.chmodSync(p, 0o600);
  assert.deepEqual(changed(before, inventory(s.ws)), ['note.txt']);
});

// Seed completed fixture executions to isolate review gates from subprocess lifecycle.
await scenario('completed-fixture-review-gates', async s => {
  const store = new Store(s.state);
  async function completed(id, extra = {}, executor = 'deepseek') {
    const task = validateTask(s.task(id, {leader:'claude',checks:[],...extra}));
    write(path.join(s.ws, `${id}.mjs`), 'export const value=42;\n');
    const run = {id:uid('run'), key:taskKey(task), task, executor, attempt:1, status:'REVIEW', baseline:capture(task), result:{exit_code:0,stdout:'fixture complete'}, web:{enabled:false}};
    atomic(path.join(store.runDir(run.id),'run.json'),run);
    await store.transaction(data => {data.tasks[run.key]={id,latest_run:run.id,status:'REVIEW',scopes:scopes(task),deepseek_attempts:1};});
    return run;
  }
  const r = await completed('cross', {risk:'high'});
  assert((await s.review(r,'accept',{reviewer:'codex'},2)).err.includes('INVALID_REVIEWER'));
  assert((await s.review(r,'accept',{},2)).err.includes('CROSS_REVIEW_REQUIRED'));
  for (const cross_review of [{reviewer:'claude',decision:'pass',summary:'same leader'}, {reviewer:'codex',decision:'fail',summary:'fail'}, {reviewer:'codex',decision:'pass',summary:' '}]) {
    assert((await s.review(r,'accept',{cross_review},2)).err.includes('CROSS_REVIEW_REQUIRED'));
  }
  await s.review(r,'accept',{cross_review:{reviewer:'codex',decision:'pass',summary:'reviewed current fixture'}});
  const manual = await completed('otherModel',{risk:'high'},'codex');
  await s.review(manual,'accept');assert.equal(s.stateOf('otherModel').status,'ACCEPTED');
  const self = await completed('selfModel',{risk:'high'},'claude');
  assert((await s.review(self,'accept',{},2)).err.includes('CROSS_REVIEW_REQUIRED'));
  await s.review(self,'accept',{cross_review:{reviewer:'codex',decision:'pass',summary:'reviewed leader implementation'}});
  const rework=await completed('reworkGate');await s.review(rework,'rework');
  assert((await s.review(rework,'accept',{},2)).err.includes('EXECUTION_NOT_REVIEWABLE'));
  const evidence=await completed('acceptanceGate');
  assert((await s.review(evidence,'accept',{acceptance:[]},2)).err.includes('ACCEPTANCE_FAILED'));
  assert((await s.review(evidence,'accept',{spec:'fail'},2)).err.includes('AUDIT_FAILED'));
  const scope=await completed('scopeGate');
  await store.transaction(data=>{data.waves[s.ws]={conflict:['unexpected.txt']};});
  assert((await s.review(scope,'accept',{},2)).err.includes('WORKSPACE_CONFLICT'));
  assert((await s.review(scope,'rework',{},2)).err.includes('SCOPE_RESOLUTION_REQUIRED'));
  await s.review(scope,'rework',{scope_resolution:'fixture source identified and retained'});
  assert.deepEqual(store.load().waves[s.ws].conflict,[]);
  const takeover=await completed('takeoverGate');
  await s.review(takeover,'takeover',{takeover_by:'codex'});
  assert.equal(s.stateOf(takeover.task.id).next_executor,'codex');
  const exhausted=await completed('exhaustedGate');
  await store.transaction(data=>{data.tasks[exhausted.key].deepseek_attempts=2;});
  await s.review(exhausted,'rework');assert.equal(s.stateOf(exhausted.task.id).next_executor,'codex');
});

await scenario('manual-flow-without-subprocess-checks', async s => {
  const t = s.task('manualOnly', {leader:'claude',risk:'high',checks:[]});
  const running=s.run(t,'codex'); const r=await s.waitRun(t.id,x=>x.status==='RUNNING');
  write(path.join(s.ws,'manualOnly.mjs'),'export const value=42;\n');
  await s.collect(r.id,['--finish']); assert.equal((await running.done).code,0);
  await s.collect(r.id,['--verify']); await s.review(s.stateOf(t.id),'accept');
  assert.equal(s.stateOf(t.id).status,'ACCEPTED');
  assert((await s.call(['collect','--run-id',r.id,'--finish'])).err.includes('NOT_MANUAL_EXECUTOR'));
  const next=s.task('manualRework',{leader:'claude',checks:[]});
  let writer=s.run(next,'claude'); let current=await s.waitRun(next.id,x=>x.status==='RUNNING');
  write(path.join(s.ws,'manualRework.mjs'),'export const value=1;\n');
  await s.collect(current.id,['--finish']);assert.equal((await writer.done).code,0);
  await s.review(s.stateOf(next.id),'takeover',{takeover_by:'codex'});
  assert((await s.run(next,'claude').done).err.includes('EXECUTOR_MISMATCH'));
  writer=s.run(next,'codex');current=await s.waitRun(next.id,x=>x.status==='RUNNING');
  await s.collect(current.id,['--finish']);assert.equal((await writer.done).code,0);
  await s.review(s.stateOf(next.id),'rework');assert.equal(s.stateOf(next.id).next_executor,'codex');
});

await scenario('ready-queue-and-concurrent-lock-recovery', async s => {
  const lock = path.join(s.state, '.registry.lock'); fs.mkdirSync(lock, { recursive: true });
  json(path.join(lock, 'owner.json'), { pid: 2147483647, birth: 'dead', token: 'abandoned' });
  const tasks = ['readyA', 'readyB', 'readyC'].map(id => s.task(id));
  const replies = await Promise.all(tasks.map(t => s.call(['run', '--task', s.saveTask(t), '--prepare'])));
  replies.forEach(r => assert.equal(r.code, 0, r.err));
  const reg = readJSON(path.join(s.state, 'registry.json'));
  assert.equal(Object.values(reg.tasks).filter(t => t.status === 'READY').length, 3);
  assert.equal(Object.keys(reg.leases).length, 0);
  assert.equal((await s.run(tasks[0]).done).code, 0); assert.equal(s.stateOf('readyA').status, 'REVIEW');
});

await scenario('successful-review-and-dirty-files', async s => {
  spawnSync('git', ['init', '-q', s.ws]);
  write(path.join(s.ws, 'user.txt'), 'staged user text'); spawnSync('git', ['-C', s.ws, 'add', 'user.txt']);
  write(path.join(s.ws, 'user.txt'), 'uncommitted user text');
  const t = s.task('success'); assert.equal((await s.run(t).done).code, 0);
  const r = s.stateOf(t.id); assert.equal(r.status, 'REVIEW');
  assert.equal(fs.readFileSync(path.join(s.ws, 'user.txt'), 'utf8'), 'uncommitted user text');
  await s.collect(r.id, ['--verify']); await s.review(r, 'accept');
  assert.equal(s.stateOf(t.id).status, 'ACCEPTED');
  const duplicate = await s.run(t).done; assert.equal(duplicate.code, 2); assert(duplicate.err.includes('ALREADY_ACCEPTED'));
  write(path.join(s.ws, 'success.mjs'), 'export const value = 43;');
  const dependent = await s.run(s.task('dependent', { depends_on: ['success'] })).done;
  assert.equal(dependent.code, 2); assert(dependent.err.includes('DEPENDENCY_STALE'));
});

await scenario('failed-check-and-stale-evidence', async s => {
  const t = s.task('checkfail', { checks: [{ id: 'fail', kind: 'test', argv: [process.execPath, '-e', 'process.exit(1)'] }] });
  await s.run(t).done; const r = s.stateOf(t.id); await s.collect(r.id, ['--verify']);
  const denied = await s.review(r, 'accept', {}, 2); assert(denied.err.includes('CHECKS_FAILED'));
  const c = await s.collect(r.id);
  write(path.join(s.ws, 'checkfail.mjs'), 'export const changed = true;');
  const stale = path.join(s.root, 'stale.json');
  json(stale, { reviewer: 'codex', run_id: r.id, artifact_digest: c.artifact_digest, decision: 'accept', summary: 'stale' });
  const out = await s.call(['collect', '--run-id', r.id, '--review', stale]);
  assert.equal(out.code, 2); assert(out.err.includes('STALE_REVIEW'));
});

await scenario('empty-and-failed-run-cannot-accept', async s => {
  const t = s.task('empty', { fixture: { mode: 'empty' }, checks: [] });
  assert.equal((await s.run(t).done).code, 1); const r = s.stateOf(t.id); assert.equal(r.status, 'BLOCKED');
  await s.review(r, 'rework');
  const out = await s.review(r, 'accept', {}, 2); assert(out.err.includes('EXECUTION_NOT_REVIEWABLE'));
  const f = s.task('failed', { fixture: { mode: 'fail' }, checks: [] });
  assert.equal((await s.run(f).done).code, 1); assert.equal(s.stateOf(f.id).result.exit_code, 1);
});

await scenario('parallel-conflicts-and-capacity', async s => {
  const a = s.run(s.task('Alpha', { fixture: { mode: 'sleep', ms: 1500 } })); await s.waitRun('Alpha');
  const alias = await s.run(s.task('alias', { write_scope: ['alpha.mjs'] })).done;
  assert.equal(alias.code, 2); assert(alias.err.includes('SCOPE_BUSY'));
  const b = s.run(s.task('Beta', { fixture: { mode: 'sleep', ms: 1500 } })); await s.waitRun('Beta');
  const third = await s.run(s.task('Third')).done; assert.equal(third.code, 2); assert(third.err.includes('CAPACITY_BUSY'));
  assert.equal((await a.done).code, 0); assert.equal((await b.done).code, 0);
});

await scenario('scope-violation-stops-other-writer', async s => {
  const b = s.run(s.task('waiting', { fixture: { mode: 'sleep', ms: 15000 }, timeout_seconds: 20 })); await s.waitRun('waiting');
  const a = await s.run(s.task('escape', { fixture: { mode: 'escape' } })).done;
  assert.equal(a.code, 1); assert.equal((await b.done).code, 1);
  assert.equal(s.stateOf('escape').error.code, 'OUT_OF_SCOPE');
  assert(fs.existsSync(path.join(s.ws, 'unexpected.txt')));
});

await scenario('timeout-and-secret-redaction', async s => {
  const t = s.task('timeout', { fixture: { mode: 'sleep', ms: 15000 }, timeout_seconds: 1 });
  assert.equal((await s.run(t).done).code, 1); const r = s.stateOf(t.id);
  assert.equal(r.result.stop_reason, 'timeout'); assert.equal(alive(r.child), false);
  const secret = s.task('redaction', { fixture: { mode: 'secret' } }); await s.run(secret).done;
  const rr = s.stateOf(secret.id); const log = fs.readFileSync(path.join(s.state, 'runs', rr.id, 'worker.stdout.log'), 'utf8');
  assert(!log.includes('sk-offline-fixture-only')); assert(log.includes('[REDACTED]'));
});

await scenario('stop-orphan-without-killing-unrelated', async s => {
  const victim = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  try {
    const v = identity(victim.pid);
    const running = s.run(s.task('orphan', { fixture: { mode: 'sleep', ms: 15000 }, timeout_seconds: 20 }));
    const r = await s.waitRun('orphan'); running.p.kill('SIGKILL'); await running.done;
    const stopped = await s.call(['stop', '--run-id', r.id]); assert.equal(stopped.code, 0, stopped.err);
    assert.equal(alive(r.child), false); assert(alive(v)); assert.equal(s.stateOf('orphan').status, 'BLOCKED');
  } finally { victim.kill('SIGTERM'); }
});

await scenario('recover-orphan-verification-lease', async s => {
  const t = s.task('verifyorphan', { checks: [{ id: 'slow', kind: 'test', argv: [process.execPath, '-e', 'setTimeout(()=>{},15000)'], timeout_seconds: 20 }] });
  await s.run(t).done; const r = s.stateOf(t.id);
  const checking = s.start(['collect', '--run-id', r.id, '--verify']);
  let lease;
  for (let n = 0; n < 300; n++) { lease = Object.values(readJSON(path.join(s.state, 'registry.json')).leases).find(l => l.kind === 'verify' && l.child); if (lease) break; await sleep(30); }
  assert(lease); checking.p.kill('SIGKILL'); await checking.done;
  const stopped = await s.call(['stop', '--run-id', r.id]); assert.equal(stopped.code, 0, stopped.err);
  assert.equal(Object.keys(readJSON(path.join(s.state, 'registry.json')).leases).length, 0); assert.equal(alive(lease.child), false);
});

await scenario('default-two-attempts-other-model-takeover', async s => {
  const t = s.task('takeover', {leader:'claude'});
  for (let n = 0; n < 2; n++) {
    assert.equal((await s.run(t).done).code, 0);
    await s.review(s.stateOf(t.id), 'rework', { strategy_change: '缩小实现并直接核对真实文件，演练接手门禁。' });
  }
  assert.equal(s.stateOf(t.id).next_executor, 'codex');
  const third = await s.run(t).done; assert.equal(third.code, 2); assert(third.err.includes('TAKEOVER_REQUIRED')); assert(third.err.includes('--executor codex'));
  const manual = s.run(t, 'codex'); const r = await s.waitRun(t.id, x => x.executor === 'codex' && x.status === 'RUNNING');
  write(path.join(s.ws, 'takeover.mjs'), 'export const value = 100;\n');
  await s.collect(r.id, ['--finish']); assert.equal((await manual.done).code, 0);
  await s.collect(r.id, ['--verify']); await s.review(s.stateOf(t.id), 'accept');
  assert.equal(s.stateOf(t.id).status, 'ACCEPTED'); assert.equal(s.stateOf(t.id).executor, 'codex');
});

await scenario('missing-lease-and-symlink-scope', async s => {
  const t = s.task('interrupted'); await s.run(t).done; const r = s.stateOf(t.id);
  r.status = 'RUNNING'; r.owner = { pid: 2147483647, birth: 'not-a-live-process' }; delete r.child;
  atomic(path.join(s.state, 'runs', r.id, 'run.json'), r);
  atomic(path.join(s.state, 'registry.json'), { version: 1, tasks: {}, leases: {}, waves: {} });
  assert.equal((await s.call(['stop', '--run-id', r.id])).code, 0); assert.equal(s.stateOf(t.id).status, 'BLOCKED');
  const outside = path.join(s.root, 'outside.txt'); write(outside, 'keep'); fs.symlinkSync(outside, path.join(s.ws, 'link.mjs'));
  const out = await s.run(s.task('symlink', { write_scope: ['link.mjs'] })).done;
  assert.equal(out.code, 2); assert(out.err.includes('SYMLINK_SCOPE')); assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
});


await scenario('leader-validation-and-high-risk-cross-review', async s => {
  const t = s.task('high', { leader: 'claude', risk: 'high', sensitive_override:'离线 fixture，仅验证高风险验收门禁' });
  await s.run(t).done; const r = s.stateOf(t.id); await s.collect(r.id, ['--verify']);
  assert.equal(r.task.risk, 'high');
  assert((await s.review(r, 'accept', { reviewer: 'codex' }, 2)).err.includes('INVALID_REVIEWER'));
  assert((await s.review(r, 'accept', {}, 2)).err.includes('CROSS_REVIEW_REQUIRED'));
  for (const cross_review of [{reviewer:'claude',decision:'pass',summary:'same leader'}, {reviewer:'codex',decision:'fail',summary:'fail'}, {reviewer:'codex',decision:'pass',summary:' '}]) {
    assert((await s.review(r, 'accept', {cross_review}, 2)).err.includes('CROSS_REVIEW_REQUIRED'));
  }
  await s.review(r, 'accept', { cross_review: { reviewer: 'codex', decision: 'pass', summary: '另一家已核对实现与证据' } });
  assert.equal(s.stateOf(t.id).status, 'ACCEPTED');
});

await scenario('first-manual-dispatch-high-risk-and-rework', async s => {
  const first = s.task('firstManual', { leader: 'claude', risk: 'high' });
  const initial = s.run(first, 'codex'); const initialRun = await s.waitRun(first.id, x => x.status === 'RUNNING');
  write(path.join(s.ws, 'firstManual.mjs'), 'export const value = 0;\n');
  await s.collect(initialRun.id, ['--finish']); assert.equal((await initial.done).code, 0);
  await s.collect(initialRun.id, ['--verify']); await s.review(s.stateOf(first.id), 'accept');
  assert.equal(s.stateOf(first.id).status, 'ACCEPTED');
  const t = s.task('manual', { leader: 'claude', risk: 'high' });
  let manual = s.run(t, 'codex'); let r = await s.waitRun(t.id, x => x.status === 'RUNNING');
  assert.equal(r.leader, 'claude'); assert.equal(r.risk, 'high');
  write(path.join(s.ws, 'manual.mjs'), 'export const value = 1;\n');
  await s.collect(r.id, ['--finish']); assert.equal((await manual.done).code, 0);
  await s.review(s.stateOf(t.id), 'rework'); assert.equal(s.stateOf(t.id).next_executor, 'codex');
  assert((await s.run(t, 'claude').done).err.includes('EXECUTOR_MISMATCH'));
  manual = s.run(t, 'codex'); r = await s.waitRun(t.id, x => x.status === 'RUNNING');
  write(path.join(s.ws, 'manual.mjs'), 'export const value = 2;\n');
  await s.collect(r.id, ['--finish']); assert.equal((await manual.done).code, 0);
  await s.collect(r.id, ['--verify']); await s.review(s.stateOf(t.id), 'accept');
  assert.equal(s.stateOf(t.id).status, 'ACCEPTED');
});

await scenario('explicit-takeover-and-leader-self-implementation', async s => {
  const t = s.task('explicit', { leader: 'claude', risk: 'high', sensitive_override:'离线 fixture，仅验证接手与交叉审查' });
  await s.run(t).done; await s.review(s.stateOf(t.id), 'takeover', {takeover_by:'codex'});
  assert((await s.run(t, 'claude').done).err.includes('EXECUTOR_MISMATCH'));
  let manual = s.run(t, 'codex'); let r = await s.waitRun(t.id, x => x.status === 'RUNNING');
  await s.collect(r.id, ['--finish']); assert.equal((await manual.done).code, 0);
  await s.review(s.stateOf(t.id), 'rework', {takeover_by:'claude'});
  assert.equal(s.stateOf(t.id).next_executor, 'claude');
  manual = s.run(t, 'claude'); r = await s.waitRun(t.id, x => x.status === 'RUNNING');
  await s.collect(r.id, ['--finish']); assert.equal((await manual.done).code, 0);
  await s.collect(r.id, ['--verify']);
  assert((await s.review(s.stateOf(t.id), 'accept', {}, 2)).err.includes('CROSS_REVIEW_REQUIRED'));
  await s.review(s.stateOf(t.id), 'accept', {cross_review:{reviewer:'codex',decision:'pass',summary:'independent review'}});
});

await scenario('config-missing-settings-credential-and-web-off', async s => {
  const cfgHome = path.join(s.root, 'config-home'); fs.mkdirSync(cfgHome);
  const credentials = path.join(s.root, 'credentials.json'); json(credentials, {DEEPSEEK_API_KEY:'tiny'});
  const config = path.join(s.root, 'config.json');
  json(config, {dsh_bin:bin,dsh_home:cfgHome,credential_file:credentials,web_mode:'off'});
  // Bypass scenario's --headless-only so web_mode itself is exercised.
  const configuredCall = args => new Promise(resolve => {
    const env = {...process.env};
    for (const key of Object.keys(env)) if (key.startsWith('TEAM_DEV_') || ['DSH_BIN','DSH_HOME','DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL'].includes(key)) delete env[key];
    const p = spawn(process.execPath, [cli,...args,'--config',config,'--state-root',s.state], {env,stdio:['ignore','pipe','pipe']});
    let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('close',code=>resolve({code,out,err}));
  });
  const doctor = await configuredCall(['doctor','--workspace',s.ws]); assert.equal(doctor.code,0,doctor.err);
  assert.equal(JSON.parse(doctor.out).configured_model,null); assert(!JSON.parse(doctor.out).web);
  const t=s.task('credential', {fixture:{mode:'credential'}, sensitive_override:'离线假凭据 fixture，验证脱敏'});
  const out=await configuredCall(['run','--task',s.saveTask(t)]); assert.equal(out.code,0,out.err);
  const r=s.stateOf(t.id); assert.equal(r.web.enabled,false);
  const visit = dir => {for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,ent.name);if(ent.isDirectory())visit(f);else assert(!fs.readFileSync(f,'utf8').includes('tiny'),f);}};
  visit(path.join(s.state,'runs',r.id));
  json(config,{dsh_bin:bin,dsh_home:cfgHome,credential_file:'relative.json',web_mode:'off'});
  assert((await configuredCall(['doctor','--workspace',s.ws])).err.includes('ABSOLUTE_PATH_REQUIRED'));
});

const report = { generated_at: new Date().toISOString(), mode: 'offline-fake-harness', real_api_calls: 0, fixtures: base, total: results.length, passed: results.filter(x => x.status === 'pass').length, results };
json(path.join(base, 'report.json'), report);
console.log(JSON.stringify(report, null, 2));
if (report.passed !== report.total) process.exitCode = 1;
