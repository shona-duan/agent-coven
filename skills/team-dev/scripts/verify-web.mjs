#!/usr/bin/env node
// 仅启动本地假 RPC 和假 Harness；不读取真实配置、不调用模型。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import { atomic, readJSON, Store } from './lib/core.mjs';
import { decodeSession, findSession, syncWeb } from './lib/web.mjs';

const root = path.resolve(process.argv[2] || `work/web-validation-${Date.now()}`);
const ws = path.join(root, 'workspace'), home = path.join(root, 'fake-home'), fake = path.join(root, 'fake-cli');
const state = path.join(root, 'state'), config = path.join(root, 'config.json'), log = path.join(root, 'startup.log');
for (const d of [root, ws, home, fake]) fs.mkdirSync(d, { recursive: true });
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const id = 'session-11111111-1111-4111-8111-111111111111';
const file = path.join(home, 'sessions/fixture', id, 'session.v3.jsonl.zstd');
let registered = [], failRename = false, webRunning = false, titles = [], calls = [];
const server = http.createServer(async (req, res) => {
  if (req.url === '/?token=fixture-token') { res.writeHead(303, { location: '/', 'set-cookie': 'test=fixture-cookie; HttpOnly' }); res.end(); return; }
  if (req.headers.cookie !== 'test=fixture-cookie') { res.writeHead(401); res.end(); return; }
  let raw = ''; for await (const b of req) raw += b;
  const body = JSON.parse(raw), args = body.payload.args;
  calls.push(body.method);
  let value, error;
  switch (body.method) {
    case 'session/list': value = { items: fs.existsSync(file) ? [{ sessionId: id, cwd: ws, running: webRunning }] : [] }; break;
    case 'workspace/create': value = { workspace: { workspaceId: 'fixture-workspace', path: args.request.path, sessionIds: registered }, created: false }; break;
    case 'session/create': assert.equal(args.request.sessionId, id); if (!registered.includes(id)) registered.push(id); value = { sessionId: id }; break;
    case 'session/rename':
      if (failRename) error = { code: 'fixture/temporary' };
      else { titles.push(args.request.title); value = { title: args.request.title, seq: 5 }; }
      break;
    default: error = { code: 'fixture/unexpected-model-or-method' };
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: error ? { ok: false, error } : { ok: true, value } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
write(log, `dsh web: ${origin}/?token=fixture-token\n`);
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dsh.mjs');
const call = args => new Promise(resolve => {
  const env = { ...process.env }; delete env.DEEPSEEK_API_KEY; delete env.DEEPSEEK_BASE_URL;
  for (const key of Object.keys(env)) if (key.startsWith('TEAM_DEV_') || ['DSH_BIN', 'DSH_HOME'].includes(key)) delete env[key];
  env.TEAM_DEV_CONFIG = path.join(root, 'empty-config.json');
  const p = spawn(process.execPath, [cli, ...args, '--state-root', state, '--web-config', config], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
  p.on('close', code => resolve({ code, out, err }));
});
atomic(path.join(root, 'empty-config.json'), {});
const results = [];
const pass = name => { results.push({ name, status: 'pass' }); console.log(`PASS ${name}`); };
try {
  const configured = await call(['web', '--configure', '--web-url', origin, '--web-log', log]);
  assert.equal(configured.code, 0, configured.err);
  assert(!fs.readFileSync(config, 'utf8').includes('fixture-token'));
  assert(!configured.out.includes('fixture-cookie'));
  const before = fs.readFileSync(config, 'utf8');
  const denied = await call(['web', '--configure', '--web-url', 'http://example.com', '--web-log', log]);
  assert.equal(denied.code, 2); assert.equal(fs.readFileSync(config, 'utf8'), before);
  pass('authentication-and-loopback-only-configuration');

  atomic(path.join(fake, 'package.json'), { name: '@deepseek-ai/dsh', version: 'fixture', type: 'module' });
  write(path.join(fake, 'node_modules/js-yaml/index.js'), 'exports.load=JSON.parse;');
  atomic(path.join(fake, 'node_modules/@deepseek-ai/dsh-headless/package.json'), { version: 'fixture' });
  write(path.join(fake, 'node_modules/@deepseek-ai/dsh-headless/lib/startup.js'), '// headless');
  atomic(path.join(home, 'settings.yaml'), { 'agent-default-model': { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' } });
  atomic(path.join(home, '.credentials.yaml'), { refs: { DEEPSEEK_API_KEY: 'sk-fixture-not-real' } });
  write(path.join(fake, 'bin.mjs'), `import fs from 'node:fs'; import path from 'node:path'; import {zstdCompressSync} from 'node:zlib';
const prompt=process.argv.at(-1), f=${JSON.stringify(file)};
fs.mkdirSync(path.dirname(f),{recursive:true});
fs.writeFileSync(f,Buffer.concat([{type:'session',id:${JSON.stringify(id)},cwd:process.cwd(),createdAt:Date.now()},{type:'user/message',data:{content:[{type:'text',text:prompt}]}},{type:'tool/result',data:{ok:true}}].map(e=>zstdCompressSync(JSON.stringify(e)+'\\n'))));
fs.writeFileSync('answer.mjs','export const answer=42;\\n'); console.log('DONE');`);
  const taskFile = path.join(root, 'task.json');
  atomic(taskFile, { leader: 'claude', id: 'web-visible', workspace: ws, brief: 'fixture only', write_scope: ['answer.mjs'], acceptance: [{id:'A',description:'answer exists'}], checks: [] });
  failRename = true;
  const first = await call(['run', '--task', taskFile, '--dsh-bin', path.join(fake, 'bin.mjs'), '--dsh-home', home]);
  assert.equal(first.code, 2, first.err);
  const store = new Store(state), runId = Object.values(store.load().tasks)[0].latest_run;
  let run = store.getRun(runId);
  assert.equal(run.status, 'REVIEW');
  assert.equal(readJSON(path.join(store.runDir(runId), 'web.json')).status, 'PENDING');
  assert.equal(decodeSession(file).length, 3);
  pass('automatic-run-hook-and-pending-sync-preserve-development');

  const nativeHash = fs.readFileSync(file).toString('base64');
  failRename = false;
  for (let i = 0; i < 2; i++) assert.equal((await call(['web', '--run-id', runId])).code, 0);
  assert.deepEqual(registered, [id]);
  assert.equal(fs.readFileSync(file).toString('base64'), nativeHash);
  assert.equal(store.getRun(runId).status, 'REVIEW');
  const collection = readJSON(path.join(store.runDir(runId), 'collection.json'));
  const review = path.join(root, 'review.json');
  atomic(review, { reviewer:'claude', run_id:runId, artifact_digest:collection.artifact_digest, decision:'accept', summary:'fixture inspected', spec:'pass', quality:'pass', blocking_findings:[], acceptance:[{id:'A',status:'pass',evidence:'fixture output inspected'}] });
  assert.equal((await call(['collect', '--run-id', runId, '--review', review])).code, 0);
  assert.equal(titles.at(-1), '[Claude] web-visible · 第1轮 · ACCEPTED');
  assert.equal(readJSON(path.join(store.runDir(runId), 'web.json')).task_status, 'ACCEPTED');
  webRunning = true;
  const active = await call(['web', '--run-id', runId]);
  assert.equal(active.code, 2); assert(active.err.includes('WEB_SESSION_ACTIVE'));
  assert.equal(store.getRun(runId).status, 'ACCEPTED');
  webRunning = false;
  assert.equal((await call(['web', '--run-id', runId])).code, 0);
  pass('idempotent-recovery-and-review-title-update');

  run = store.getRun(runId);
  const oldId='run-22222222-2222-4222-8222-222222222222';
  const events = [{type:'session',id,cwd:ws,createdAt:Date.now()},{type:'user/message',data:{text:`运行标识：${runId}。上一轮审查：运行标识：${oldId}。`}}];
  write(file,Buffer.concat(events.map(e=>zstdCompressSync(JSON.stringify(e)+'\n'))));
  const summaries=[{sessionId:id,cwd:ws}];
  const sibling = 'session-33333333-3333-4333-8333-333333333333';
  write(path.join(home,'sessions/fixture',sibling,'session.v3.jsonl.zstd'), Buffer.from('incomplete'));
  summaries.push({sessionId:sibling,cwd:ws});
  assert.equal(findSession(home,run,summaries).session_id,id);
  assert.throws(()=>findSession(home,{...run,id:oldId},summaries),/匹配数为 0/);
  write(file,fs.readFileSync(file).subarray(0,-1));
  assert.throws(()=>decodeSession(file),/未完成/);
  const n=calls.length;
  await assert.rejects(syncWeb(store,{...run,status:'RUNNING'}),/仍在运行/);
  assert.equal(calls.length,n);
  assert(!calls.some(c=>/prompt|selectModel|fork/.test(c)));
  pass('exact-run-association-truncated-log-and-active-writer-fence');
} finally {
  await new Promise(resolve => server.close(resolve));
  atomic(path.join(root, 'results.json'), { results, model_calls:0 });
}
