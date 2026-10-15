import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
export const now = () => new Date().toISOString();
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const uid = prefix => `${prefix}-${crypto.randomUUID()}`;
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const inside = (root, file) => file === root || file.startsWith(root + path.sep);
// macOS 常见卷忽略大小写并归一化 Unicode；锁保守折叠，避免物理同文件被并发写入。
export const lockKey = p => p.normalize('NFC').toLowerCase();
export const inScope = (a, b) => inside(lockKey(a), lockKey(b));
export const overlaps = (a, b) => inScope(a, b) || inScope(b, a);
export const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export const mkdir = dir => fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
export function atomic(file, data) {
  mkdir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
}
export function textFile(file, text) {
  mkdir(path.dirname(file));
  fs.writeFileSync(file, text, { mode: 0o600 });
}
export function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('ABSOLUTE_PATH_REQUIRED', `${label} 必须为绝对路径`);
  return path.resolve(value);
}
export function workspace(value) {
  const p = fs.realpathSync(absolute(value, 'workspace'));
  if (!fs.statSync(p).isDirectory() || p === path.parse(p).root || p === os.homedir()) fail('INVALID_WORKSPACE', '必须指定具体项目目录');
  return p;
}
export function localPath(root, relative, { allowRoot = false } = {}) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..') || relative.includes('\0') || /[*?\[\]{}]/.test(relative)) fail('INVALID_SCOPE', `仅接受无通配符的相对路径: ${relative}`);
  const dest = path.resolve(root, relative);
  if (!inside(root, dest) || (!allowRoot && dest === root) || relative.split('/').includes('.git')) fail('INVALID_SCOPE', `不允许的路径: ${relative}`);
  let current = root;
  for (const part of path.relative(root, dest).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const st = fs.lstatSync(current);
      if (st.isSymbolicLink()) fail('SYMLINK_SCOPE', `写入范围经过符号链接: ${relative}`);
      if (st.isFile() && st.nlink > 1) fail('HARDLINK_SCOPE', `写入范围含硬链接: ${relative}`);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return dest;
}
export function validateTask(raw) {
  const t = structuredClone(raw);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(t.id || '')) fail('INVALID_TASK', 'id 仅允许字母、数字、点、下划线、短横线，最长 80 字符');
  if (!['claude', 'codex'].includes(t.leader)) fail('INVALID_TASK', 'leader 必须为 claude 或 codex');
  if (t.sensitive_override !== undefined) {
    if (typeof t.sensitive_override !== 'string' || !t.sensitive_override.trim()) fail('INVALID_TASK', 'sensitive_override 必须为非空字符串，说明误报原因');
    t.sensitive_override = t.sensitive_override.trim();
  }
  t.risk ??= 'mid';
  if (!['low', 'mid', 'high'].includes(t.risk)) fail('INVALID_TASK', 'risk 必须为 low/mid/high');
  t.workspace = workspace(t.workspace);
  if (typeof t.brief !== 'string' || !t.brief.trim()) fail('INVALID_TASK', 'brief 不能为空');
  if (!Array.isArray(t.write_scope) || !t.write_scope.length) fail('INVALID_TASK', 'write_scope 不能为空');
  t.write_scope = [...new Set(t.write_scope.map(p => path.relative(t.workspace, localPath(t.workspace, p, { allowRoot: true })) || '.'))].sort();
  t.depends_on ??= [];
  if (!Array.isArray(t.depends_on) || t.depends_on.some(x => typeof x !== 'string' || x === t.id)) fail('INVALID_TASK', 'depends_on 必须是其他任务 id 的数组');
  t.timeout_seconds ??= 1800;
  if (!Number.isInteger(t.timeout_seconds) || t.timeout_seconds < 1 || t.timeout_seconds > 43200) fail('INVALID_TASK', 'timeout_seconds 必须为 1～43200');
  if (!Array.isArray(t.acceptance) || !t.acceptance.length) fail('INVALID_TASK', '至少指定一项验收标准');
  uniqueIds(t.acceptance, 'acceptance');
  for (const a of t.acceptance) {
    if (typeof a.description !== 'string' || !a.description.trim()) fail('INVALID_TASK', '验收标准必须有 description');
    a.required ??= true;
    if (typeof a.required !== 'boolean') fail('INVALID_TASK', 'required 必须是布尔值');
  }
  const stringList = (value, name) => { if (!Array.isArray(value) || !value.length || value.some(x => typeof x !== 'string' || !x.trim())) fail('INVALID_TASK', `${name} 必须是非空字符串数组`); };
  if (t.not_done_if !== undefined) stringList(t.not_done_if, 'not_done_if');
  if (t.risk === 'high' || t.blocking_criteria !== undefined) stringList(t.blocking_criteria, 'blocking_criteria（risk=high 必填：交叉审查中哪些问题算阻塞）');
  t.checks ??= [];
  if (!Array.isArray(t.checks)) fail('INVALID_TASK', 'checks 必须为数组');
  uniqueIds(t.checks, 'checks');
  for (const c of t.checks) {
    if (!Array.isArray(c.argv) || !c.argv.length || c.argv.some(x => typeof x !== 'string' || !x || x.includes('\0'))) fail('INVALID_CHECK', '检查命令使用非空 argv 数组');
    c.cwd ??= '.';
    localPath(t.workspace, c.cwd, { allowRoot: true });
    c.timeout_seconds ??= 120;
    if (!Number.isInteger(c.timeout_seconds) || c.timeout_seconds < 1 || c.timeout_seconds > 1800) fail('INVALID_CHECK', '检查超时为 1～1800 秒');
    if (!['syntax', 'typecheck', 'compile', 'test', 'inspection'].includes(c.kind)) fail('INVALID_CHECK', '检查必须声明 kind');
    const executable = path.basename(c.argv[0]);
    if (['sh', 'bash', 'zsh'].includes(executable) && (!c.argv.includes('-n') || c.argv.includes('-c'))) fail('CHECK_POLICY', '本机 Shell 脚本仅允许 -n 语法检查');
    if (executable.endsWith('.sh')) fail('CHECK_POLICY', '不要执行 .sh；使用 bash -n <script>');
    if (executable === 'java') fail('CHECK_POLICY', '本机不启动 Java 应用');
    if (['mvn', 'mvnw', 'gradle', 'gradlew'].includes(executable) && (!['compile', 'typecheck'].includes(c.kind) || c.argv.some(x => /^(test|check|bootRun|run|spring-boot:run|integration-test)$/.test(x)))) fail('CHECK_POLICY', 'Java 仅允许编译或类型检查');
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(executable) && c.argv.slice(1).some(x => ['dev', 'start', 'serve', 'preview'].includes(x))) fail('CHECK_POLICY', '检查命令不能启动待开发应用');
  }
  return t;
}
const sensitiveKeywords = ['auth', 'login', 'password', 'passwd', 'token', 'secret', 'credential', 'crypt', 'signature', 'permission', 'oauth', 'jwt', 'payment', 'billing', '鉴权', '认证', '登录', '密码', '令牌', '密钥', '加密', '签名', '权限', '支付', '计费'];
export function taskSensitivity(task) {
  const descriptions = [task.brief, ...task.write_scope, ...task.acceptance.map(a => a.description)].map(text => text.toLowerCase());
  const keywords = sensitiveKeywords.filter(keyword => descriptions.some(text => text.includes(keyword)));
  const reasons = [...(task.risk === 'high' ? ['risk=high'] : []), ...keywords.map(keyword => `keyword=${keyword}`)];
  return { sensitive: reasons.length > 0, sensitive_reasons: reasons };
}
function uniqueIds(rows, name) {
  if (rows.some(r => !r || typeof r.id !== 'string' || !/^[a-zA-Z0-9][\w.-]{0,79}$/.test(r.id)) || new Set(rows.map(r => r.id)).size !== rows.length) fail('INVALID_TASK', `${name} 的 id 必须以字母/数字开头、最长 80 字符且唯一`);
}
export const taskKey = t => hash(lockKey(t.workspace)).slice(0, 16) + ':' + t.id;
export const scopes = t => t.write_scope.map(p => localPath(t.workspace, p, { allowRoot: true }));

export function processBirth(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000 });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}
export const identity = (pid = process.pid) => ({ pid, birth: processBirth(pid) });
export const alive = p => Boolean(p?.birth && processBirth(p.pid) === p.birth);

export class Store {
  constructor(root) {
    const requested = path.resolve(root || process.env.TEAM_DEV_STATE || path.join(os.homedir(), 'agent-hub/state/team-dev'));
    let ancestor = requested;
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    this.root = path.join(fs.realpathSync(ancestor), path.relative(ancestor, requested));
    if (this.root === path.parse(this.root).root || this.root === os.homedir()) fail('INVALID_STATE_ROOT', '状态目录必须是专用子目录，不能是系统根或用户主目录');
    this.file = path.join(this.root, 'registry.json');
  }
  load() { return fs.existsSync(this.file) ? readJSON(this.file) : { version: 1, tasks: {}, leases: {}, waves: {} }; }
  runDir(id) {
    if (!/^run-[a-f0-9-]{36}$/.test(id || '')) fail('INVALID_RUN_ID', 'run-id 无效');
    return path.join(this.root, 'runs', id);
  }
  getRun(id) { return readJSON(path.join(this.runDir(id), 'run.json')); }
  saveRun(r) { atomic(path.join(this.runDir(r.id), 'run.json'), r); }
  async transaction(fn) {
    mkdir(this.root);
    const lock = path.join(this.root, '.registry.lock');
    const token = crypto.randomUUID();
    const deadline = Date.now() + 15000;
    while (true) {
      try {
        fs.mkdirSync(lock, { mode: 0o700 });
        atomic(path.join(lock, 'owner.json'), { ...identity(), token });
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try {
          const old = readJSON(path.join(lock, 'owner.json'));
          if (!alive(old)) {
            // 串行化过期锁回收，防止两个回收者把刚取得的新活动锁一起移走。
            const recovery = path.join(this.root, '.registry.recovery');
            let owned = false;
            try {
              fs.mkdirSync(recovery, { mode: 0o700 }); owned = true;
              atomic(path.join(recovery, 'owner.json'), { ...identity(), token });
              const current = readJSON(path.join(lock, 'owner.json'));
              if (current.token === old.token && !alive(current)) {
                fs.renameSync(lock, `${lock}.stale-${token}`);
                fs.rmSync(`${lock}.stale-${token}`, { recursive: true });
              }
            } catch (err) { if (!['ENOENT', 'EEXIST'].includes(err.code)) throw err; }
            finally { if (owned) fs.rmSync(recovery, { recursive: true }); }
          }
        } catch (err) { if (!['ENOENT', 'EEXIST'].includes(err.code) && !(err instanceof SyntaxError)) throw err; }
        if (Date.now() > deadline) fail('REGISTRY_BUSY', '状态锁繁忙或初始化中断；检查锁持有进程后再恢复，不要删除活动锁');
        await sleep(100);
      }
    }
    try {
      const data = this.load();
      const result = fn(data);
      if (result instanceof Promise) fail('INTERNAL', '事务内禁止异步操作');
      atomic(this.file, data);
      return result;
    } finally {
      if (readJSON(path.join(lock, 'owner.json')).token === token) fs.rmSync(lock, { recursive: true });
    }
  }
}

const excluded = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.DS_Store']);
function walk(dir, out, root, limit = 30000) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (excluded.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out, root, limit);
    else out.push(path.relative(root, p));
    if (out.length > limit) fail('SNAPSHOT_LIMIT', '文件超过 30000 个，请指定更小的工作区或写入范围');
  }
}
export function inventory(ws) {
  let files;
  const git = spawnSync('git', ['-C', ws, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (git.status === 0) files = [...new Set(git.stdout.split('\0').filter(Boolean))];
  else { files = []; walk(ws, files, ws); }
  if (files.length > 30000) fail('SNAPSHOT_LIMIT', '工作区文件过多，请缩小范围');
  const map = {};
  for (const rel of files.sort()) {
    const p = path.resolve(ws, rel);
    if (!inside(ws, p)) continue;
    try {
      const s = fs.lstatSync(p);
      // ctime 会因 ACL/xattr 等元数据操作变化，不能据此判定代码越界修改。
      if (!s.isDirectory()) map[rel] = [s.size, s.mtimeMs, s.mode, s.isSymbolicLink() ? fs.readlinkSync(p) : ''].join(':');
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return map;
}
export function changed(a, b) { return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(p => a[p] !== b[p]).sort(); }
export function capture(t, dest) {
  const files = new Set();
  for (const scope of scopes(t)) {
    if (!fs.existsSync(scope)) continue;
    if (fs.lstatSync(scope).isDirectory()) { const rows = []; walk(scope, rows, t.workspace); rows.forEach(x => files.add(x)); }
    else files.add(path.relative(t.workspace, scope));
  }
  const manifest = {};
  let total = 0;
  if (dest) mkdir(dest);
  for (const rel of [...files].sort()) {
    const p = localPath(t.workspace, rel);
    const s = fs.lstatSync(p);
    if (!s.isFile()) fail('UNSUPPORTED_FILE', `写入范围含非常规文件: ${rel}`);
    total += s.size;
    if (s.size > 20 * 1024 * 1024 || total > 100 * 1024 * 1024) fail('SNAPSHOT_LIMIT', '任务快照上限为单文件 20 MiB、总计 100 MiB；请缩小范围');
    const content = fs.readFileSync(p);
    manifest[rel] = { sha256: hash(content), mode: s.mode & 0o777 };
    if (dest) {
      const target = path.join(dest, rel);
      mkdir(path.dirname(target));
      fs.writeFileSync(target, content, { mode: 0o600 });
    }
  }
  return { manifest, digest: hash(JSON.stringify(manifest)) };
}
export function changeList(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().filter(p => JSON.stringify(a[p]) !== JSON.stringify(b[p])).map(p => ({ path: p, kind: !a[p] ? 'added' : !b[p] ? 'deleted' : 'modified', before: a[p] || null, after: b[p] || null }));
}
export function reserve(data, lease, key, task, { verification = false } = {}) {
  for (const old of Object.values(data.leases)) {
    if (!alive(old.owner)) fail('ORPHAN_LEASE', `检测到中断的运行 ${old.run_id}；先用 stop 恢复并确认子进程退出`);
    if (lease.scopes.some(a => old.scopes.some(b => overlaps(a, b)))) fail('SCOPE_BUSY', `写入范围与 ${old.run_id} 重叠，请在其结束后派发`);
  }
  if (!verification) {
    if (Object.values(data.leases).filter(x => x.kind === 'deepseek').length >= 2 && lease.kind === 'deepseek') fail('CAPACITY_BUSY', '最多同时运行两个 DeepSeek 任务');
    for (const [k, other] of Object.entries(data.tasks)) {
      if (k !== key && other.reserved && lease.scopes.some(a => other.scopes.some(b => overlaps(a, b)))) fail('SCOPE_PENDING_REVIEW', `范围由待审任务 ${other.id} 保留`);
    }
    for (const dep of task.depends_on) {
      const other = data.tasks[taskKey({ ...task, id: dep })];
      if (other?.status !== 'ACCEPTED') fail('DEPENDENCY_NOT_ACCEPTED', `依赖 ${dep} 尚未验收`);
    }
  }
  const wave = data.waves[task.workspace];
  if (wave?.conflict?.length) fail('WORKSPACE_CONFLICT', `存在未核对的范围外改动: ${wave.conflict.join(', ')}`);
  data.leases[lease.id] = lease;
  if (!wave || !Object.values(data.leases).some(x => x.id !== lease.id && x.workspace === task.workspace)) {
    data.waves[task.workspace] = { baseline: inventory(task.workspace), scopes: [...lease.scopes], conflict: [] };
  } else wave.scopes = [...new Set([...wave.scopes, ...lease.scopes])];
}
export function checkWave(data, ws) {
  const wave = data.waves[ws];
  if (!wave) return [];
  const unexpected = changed(wave.baseline, inventory(ws)).filter(p => !wave.scopes.some(s => inScope(s, path.join(ws, p))));
  wave.conflict = [...new Set([...(wave.conflict || []), ...unexpected])];
  return wave.conflict;
}
