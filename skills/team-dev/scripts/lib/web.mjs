import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as zlib from 'node:zlib';
import { fail, now, readJSON, atomic, textFile, alive } from './core.mjs';

import { webConfigPath } from './config.mjs';
import { displayName } from './runtime.mjs';
export function webConfig(options = {}) {
  const file = webConfigPath(options);
  if (!path.isAbsolute(file)) fail('WEB_CONFIG_INVALID', '--web-config 必须为绝对路径');
  if (!fs.existsSync(file)) fail('WEB_NOT_CONFIGURED', '先执行 web --configure --web-url <本地地址> --web-log <启动日志绝对路径>；不自动退回不可见的执行');
  return validateConfig(readJSON(file));
}
export function validateConfig(raw) {
  let url;
  try { url = new URL(raw.origin); } catch { fail('WEB_CONFIG_INVALID', 'Web 地址无效'); }
  // 凭据只交给用户授权的本机 Harness；拒绝重定向到其他主机。
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('WEB_CONFIG_INVALID', '仅接受无凭据、无查询参数的本机 HTTP origin');
  if (!path.isAbsolute(raw.log || '')) fail('WEB_CONFIG_INVALID', '启动日志必须为绝对路径');
  return { origin: url.origin, log: raw.log };
}
export async function configureWeb(options) {
  const config = validateConfig({ origin: options['web-url'], log: options['web-log'] });
  const client = await connectWeb(config);
  await client.list();
  const file = webConfigPath(options);
  if (!path.isAbsolute(file)) fail('WEB_CONFIG_INVALID', '--web-config 必须为绝对路径');
  atomic(file, config);
  return { configured: true, config_file: file, web_url: config.origin, authenticated: true, model_request_made: false };
}
export async function connectWeb(config) {
  config = validateConfig(config);
  if (typeof zlib.zstdDecompressSync !== 'function') fail('WEB_NODE_VERSION', 'Web 同步需要支持 Zstd 的 Node.js；本机已验证 Node 24');
  const stat = fs.statSync(config.log);
  if (!stat.isFile()) fail('WEB_LOGIN_MISSING', '启动日志不是普通文件');
  const fd = fs.openSync(config.log, 'r');
  let log;
  try { const buf = Buffer.alloc(Math.min(stat.size, 1024 * 1024)); fs.readSync(fd, buf, 0, buf.length, stat.size - buf.length); log = buf.toString(); }
  finally { fs.closeSync(fd); }
  const candidates = [...log.matchAll(/https?:\/\/[^\s<>"']+/g)].map(m => { try { return new URL(m[0]); } catch { return null; } })
    .filter(u => u?.origin === config.origin && u.pathname === '/' && /^[A-Za-z0-9_-]+$/.test(u.searchParams.get('token') || ''));
  const login = candidates.at(-1);
  if (!login) fail('WEB_LOGIN_MISSING', '启动日志中没有该 origin 的有效登录链接；使用本机 Harness 正常启动入口获取，不关闭鉴权');
  let response;
  try { response = await fetch(login, { redirect: 'manual', signal: AbortSignal.timeout(10000) }); }
  catch { fail('WEB_UNREACHABLE', '本地 Harness Web 无法连接；未派发模型任务'); }
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (response.status !== 303 || response.headers.get('location') !== '/' || !cookie) fail('WEB_LOGIN_FAILED', '启动链接已失效或响应不是 Harness 登录交换；检查当前进程启动日志');
  const rpc = async (method, args) => {
    const rpcId = crypto.randomUUID();
    let res;
    try { res = await fetch(config.origin + '/api/' + method, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }) }); }
    catch { fail('WEB_RPC_UNCERTAIN', `Web ${method} 响应未确认；仅重试登记/同步，不重跑开发`); }
    if (!res.ok) fail('WEB_RPC_FAILED', `Web ${method} HTTP ${res.status}`);
    let envelope;
    try { envelope = await res.json(); } catch { fail('WEB_PROTOCOL', 'Web 响应不是 JSON'); }
    if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId) fail('WEB_PROTOCOL', 'Web RPC 响应标识不匹配');
    if (!envelope.result?.ok) fail('WEB_RPC_FAILED', `${method}: ${envelope.result?.error?.code || 'unknown'}`);
    return envelope.result.value;
  };
  return {
    config, rpc,
    list: async () => (await rpc('session/list', { _request: {} })).items,
    workspace: async workspace => (await rpc('workspace/create', { request: { path: workspace } })).workspace,
  };
}

// JSONL 每次追加是一个独立 Zstd frame。Node 的单次解压只返回首帧，必须逐帧读取。
export function decodeSession(file) {
  if (fs.statSync(file).size > 64 * 1024 * 1024) fail('WEB_LOG_TOO_LARGE', '会话日志超过 64 MiB，暂停自动关联');
  const buf = fs.readFileSync(file), chunks = [];
  if (file.endsWith('.zstd')) {
    if (typeof zlib.zstdDecompressSync !== 'function') fail('WEB_NODE_VERSION', '读取本机 Harness 压缩日志需要支持 Zstd 的 Node.js（本机使用 Node 24）');
    let offset = 0, total = 0;
    while (offset < buf.length) {
      const start = offset;
      if (buf.length - offset < 5 || buf.readUInt32LE(offset) !== 0xfd2fb528) fail('WEB_LOG_INCOMPLETE', '会话日志存在未完成/无效 frame，保留记录稍后同步');
      const d = buf[offset + 4]; offset += 5;
      if (d & 24) fail('WEB_LOG_INVALID', '无效 Zstd header');
      const flag = d >>> 6, single = Boolean(d & 32), dict = d & 3;
      offset += (single ? 0 : 1) + (dict === 3 ? 4 : dict) + (flag === 0 ? (single ? 1 : 0) : 1 << flag);
      let last = false;
      while (!last) {
        if (offset + 3 > buf.length) fail('WEB_LOG_INCOMPLETE', '会话 frame 未完成');
        const block = buf.readUIntLE(offset, 3); offset += 3;
        last = Boolean(block & 1); const type = (block >>> 1) & 3;
        if (type === 3) fail('WEB_LOG_INVALID', '无效 Zstd block');
        offset += type === 1 ? 1 : block >>> 3;
      }
      if (d & 4) offset += 4;
      if (offset > buf.length) fail('WEB_LOG_INCOMPLETE', '会话 frame 未完成');
      const chunk = zlib.zstdDecompressSync(buf.subarray(start, offset), { maxOutputLength: 64 * 1024 * 1024 - total });
      total += chunk.length; chunks.push(chunk);
    }
  } else chunks.push(buf);
  return Buffer.concat(chunks).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
}

export function findSession(home, run, summaries) {
  const ids = new Set(summaries.filter(s => s.cwd === run.task.workspace).map(s => s.sessionId));
  const root = path.join(home, 'sessions');
  const matches = [];
  if (!fs.existsSync(root)) fail('WEB_SESSION_MISSING', '尚未找到 Harness 原生会话目录');
  for (const dir of fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory())) {
    for (const id of ids) {
      if (!/^session-[0-9a-f-]{36}$/.test(id)) continue;
      const folder = path.join(root, dir.name, id);
      const file = ['session.v3.jsonl.zstd', 'session.v3.jsonl'].map(n => path.join(folder, n)).find(f => fs.existsSync(f));
      if (!file) continue;
      let events;
      try { events = decodeSession(file); } catch { continue; } // 同工作区其他并行会话可能仍在追加；不能妨碍本轮关联。
      const header = events[0];
      if (header.id !== id || header.cwd !== run.task.workspace) continue;
      const first = events.find(e => e.type === 'user/message');
      // 仅匹配首条派发提示中的本轮标识，避免把返工引用的旧 run id 误当成本轮。
      const prompt = JSON.stringify(first?.data || {});
      if (prompt.match(/运行标识：(run-[0-9a-f-]{36})。/)?.[1] !== run.id) continue;
      matches.push({ session_id: id, session_file: file, created_at: new Date(header.createdAt).toISOString() });
    }
  }
  if (matches.length !== 1) fail('WEB_SESSION_AMBIGUOUS', `本轮原生会话匹配数为 ${matches.length}；不猜测或创建替代会话`);
  return matches[0];
}

export async function syncWeb(store, run, options = {}) {
  if (run.status === 'RUNNING' || alive(run.child) || alive(store.load().leases[run.id]?.owner)) fail('WEB_WRITER_ACTIVE', '执行进程仍在运行；结束后才能交给 Web，避免两个 Host 同时持有会话');
  const config = options['web-config'] ? webConfig(options) : run.web?.config || webConfig(options);
  const recordFile = path.join(store.runDir(run.id), 'web.json');
  try {
    const client = await connectWeb(config);
    const workspace = await client.workspace(run.task.workspace);
    let native;
    if (run.executor === 'deepseek') {
      const summaries = await client.list();
      native = findSession(run.preflight.dsh_home, run, summaries);
      if (summaries.find(s => s.sessionId === native.session_id)?.running) fail('WEB_SESSION_ACTIVE', '此原生会话已在 Web 中运行，暂停接管与改名');
      // create 的显式 sessionId 是官方幂等 adopt 接口；不调用 prompt，不发起推理。
      await client.rpc('session/create', { request: { workspaceId: workspace.workspaceId, sessionId: native.session_id } });
      const title = `[${displayName(run.task.leader)}] ${run.task.id} · 第${run.attempt}轮 · ${run.status}`;
      await client.rpc('session/rename', { request: { sessionId: native.session_id, title } });
      const registered = await client.workspace(run.task.workspace);
      if (!registered.sessionIds.includes(native.session_id)) fail('WEB_ATTACH_UNCONFIRMED', 'Web 未确认会话属于目标工作区');
      native.title = title;
    }
    const record = { status: 'SYNCED', synced_at: now(), web_url: config.origin, workspace_id: workspace.workspaceId, workspace: run.task.workspace, run_id: run.id, task_id: run.task.id, attempt: run.attempt, task_status: run.status, executor: run.executor, ...native, audit_file: path.join(store.runDir(run.id), 'web-audit.md'), model_request_made: false };
    atomic(recordFile, record);
    const review = run.review;
    textFile(record.audit_file, `# ${run.task.id} · 第 ${run.attempt} 轮\n\n- 状态：${run.status}\n- 组长：${displayName(run.task.leader)}\n- 风险：${run.task.risk}\n- 实现者：${run.executor}\n- Web：${config.origin}\n- 工作区：${run.task.workspace}\n- 原生会话：${native?.session_id || `无（${displayName(run.executor)} 受监督执行）`}\n- 运行：${run.id}\n- 上一轮：${run.previous_run || '无'}\n\n## ${displayName(review?.reviewer || run.task.leader)} 审查\n\n${review?.summary || '尚未提交审查'}\n\n详细证据：同目录 run.json、collection.json、checks.json、reviews/。Web 标题仅展示状态，不代替审查证据。\n`);
    return record;
  } catch (error) {
    atomic(recordFile, { status: 'PENDING', task_status: run.status, attempted_at: now(), web_url: config.origin, code: error.code || 'WEB_ERROR', recovery: '修复 Web 接入后运行 web --run-id；不得重新派发开发' });
    throw error;
  }
}

export function webStatus(store, run) {
  const file = path.join(store.runDir(run.id), 'web.json');
  return fs.existsSync(file) ? readJSON(file) : { status: run.web?.enabled ? 'PENDING' : 'NOT_LINKED' };
}
