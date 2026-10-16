#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, fail, now, uid, hash, sleep, inside, readJSON, atomic, textFile, validateTask, taskSensitivity, taskKey, scopes, identity, alive, workspace, inventory, capture, changeList, reserve, checkWave, mkdir } from './lib/core.mjs';
import { doctor, execute, childEnvironment, makePrompt, workerPatch, terminateGroup, redact, displayName } from './lib/runtime.mjs';
import { webConfig, configureWeb, connectWeb, syncWeb, webStatus } from './lib/web.mjs';

import { resolveOptions as resolveRuntimeOptions, defaultStateRoot } from './lib/config.mjs';

// Keep the shared configuration precedence while limiting changes to this CLI.
export function resolveOptions(input = {}) {
  const options = resolveRuntimeOptions(input);
  const file = input.config || process.env.TEAM_DEV_CONFIG || path.join(defaultStateRoot(), 'config.json');
  const config = fs.existsSync(file) ? readJSON(file) : {};
  const value = input['deepseek-max-attempts'] ?? process.env.TEAM_DEV_DEEPSEEK_MAX_ATTEMPTS ?? config.deepseek_max_attempts ?? 2;
  const limit = typeof value === 'string' && /^[1-3]$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(limit) || limit < 1 || limit > 3) fail('INVALID_CONFIG', 'deepseek_max_attempts 必须为 1～3 的整数');
  options['deepseek-max-attempts'] = limit;
  return options;
}
const otherModel = leader => leader === 'claude' ? 'codex' : 'claude';

const HELP = `Claude/Codex 组长 → DeepSeek/Claude/Codex 三方协作（Node.js 22+，macOS/Linux）
  doctor --workspace /project [--dsh-bin /absolute/bin.js] [--dsh-home /home]
  run --task /task.json [--prepare | --executor deepseek|claude|codex] [--state-root /state]
  status [--workspace /project] [--run-id run-UUID] [--state-root /state]
  stop --run-id run-UUID [--state-root /state]
  collect --run-id run-UUID [--verify | --review /review.json | --finish] [--state-root /state]
  web --configure --web-url http://127.0.0.1:3080 --web-log /absolute/startup.log
  web --workspace /project | --run-id run-UUID [--state-root /state]
配置：--config > TEAM_DEV_CONFIG > ~/agent-hub/state/team-dev/config.json。
Web 按 web_mode=off|required；默认有 web-config.json 时 required，否则 off；--headless-only 优先关闭 Web。
可指定 --credential-file /absolute/credentials.json、--expected-model JSON、--web-mode off|required。
DeepSeek 上限：--deepseek-max-attempts > TEAM_DEV_DEEPSEEK_MAX_ATTEMPTS > deepseek_max_attempts；默认 2，范围 1～3。
run 使用 doctor 的相同 Harness 参数。运行记录中给出后续命令需要的 run_id。
collect --finish 结束 Claude 受监督写入；--verify 独立运行任务检查；--review 提交任务组长审查。
退出码：0=命令完成（不等于任务验收）；1=执行失败；2=前置条件/范围/验收门禁失败。
`;

export function parse(argv) {
  const command = argv.shift();
  const options = {};
  const bools = ['verify', 'finish', 'prepare', 'help', 'configure', 'headless-only'];
  const values = ['workspace', 'dsh-bin', 'dsh-home', 'state-root', 'task', 'run-id', 'executor', 'review', 'web-config', 'web-url', 'web-log', 'config', 'credential-file', 'expected-model', 'web-mode', 'deepseek-max-attempts'];
  while (argv.length) {
    const key = argv.shift();
    if (!key.startsWith('--')) fail('ARGUMENT_ERROR', `未知参数 ${key}`);
    const name = key.slice(2);
    if (name in options) fail('ARGUMENT_ERROR', `重复参数 ${key}`);
    if (bools.includes(name)) options[name] = true;
    else if (values.includes(name) && argv[0] && !argv[0].startsWith('--')) options[name] = argv.shift();
    else fail('ARGUMENT_ERROR', `未知参数或缺少参数值 ${key}`);
  }
  return { command, options };
}
const print = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
// 派活自动记账（agent-hub 账本存在时才记；失败不影响派活）。执行者=组长时算自己做。
const LEDGER = process.env.AGENT_HUB_LEDGER || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../ledger/ledger.mjs');
function ledger(...args) {
  if (!fs.existsSync(LEDGER)) return;
  try { spawnSync(process.execPath, [LEDGER, 'task', ...args], { stdio: 'ignore', timeout: 30000 }); } catch {}
}
const CODEX_TASK = process.env.AGENT_HUB_CODEX_TASK || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../codex_task.py');
const short = r => ({ run_id: r.id, task_id: r.task.id, workspace: r.task.workspace, status: r.status, executor: r.executor, leader: r.task.leader, risk: r.task.risk, ...taskSensitivity(r.task), sensitive_override: r.sensitive_override || null, deepseek_max_attempts: r.deepseek_max_attempts ?? 2, attempt: r.attempt, next_executor: r.next_executor || null, error: r.error || null });

async function updateWeb(store, run) {
  if (!run.web?.enabled) return webStatus(store, run);
  try { return await syncWeb(store, run); }
  catch (e) {
    // 开发已完成时，Web 故障不能触发再次开发，也不能覆盖真实验收状态。
    process.exitCode = 2;
    process.stderr.write(JSON.stringify({ code: e.code || 'WEB_SYNC_FAILED', run_id: run.id, message: redact(e.message), recovery: 'web --run-id 同步现有会话；不要重新 run' }) + '\n');
    return webStatus(store, run);
  }
}

async function collectFiles(store, run) {
  const dir = store.runDir(run.id);
  const temporary = path.join(dir, uid('collection'));
  const snap = capture(run.task, temporary);
  const snapshotDir = path.join(dir, 'snapshots', snap.digest);
  mkdir(path.dirname(snapshotDir));
  if (!fs.existsSync(snapshotDir)) fs.renameSync(temporary, snapshotDir);
  else fs.rmSync(temporary, { recursive: true });
  const changes = changeList(run.baseline.manifest, snap.manifest);
  const diff = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--binary', '--', path.join(dir, 'before'), snapshotDir], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (![0, 1].includes(diff.status)) fail('DIFF_FAILED', '不能生成审查 diff；请缩小任务范围后重试');
  textFile(path.join(dir, 'changes.patch'), redact(diff.stdout));
  const evidence = { run_id: run.id, previous_run: run.previous_run || null, task_start_run: run.task_start_run || run.id, collected_at: now(), artifact_digest: snap.digest, baseline_digest: run.baseline.digest, changes, no_changes: changes.length === 0, diff_file: path.join(dir, 'changes.patch'), snapshot_directory: snapshotDir };
  atomic(path.join(dir, 'collection.json'), evidence);
  return evidence;
}

async function haltWorkspace(store, ws, reason, exclude) {
  const leases = Object.values(store.load().leases).filter(l => l.workspace === ws && l.id !== exclude);
  for (const lease of leases) {
    if (alive(lease.owner)) process.kill(lease.owner.pid, 'SIGTERM');
  }
  return reason;
}

async function runTask(options, store) {
  if (!options.task || !path.isAbsolute(options.task)) fail('TASK_REQUIRED', '--task 必须是绝对路径');
  const task = validateTask(readJSON(options.task));
  const sensitivity = taskSensitivity(task);
  const maxAttempts = options['deepseek-max-attempts'];
  if (inside(task.workspace, store.root) || inside(store.root, task.workspace)) fail('STATE_WORKSPACE_OVERLAP', '状态目录与业务工作区必须互不包含');
  const executor = options.executor || 'deepseek';
  if (!['deepseek', 'claude', 'codex'].includes(executor)) fail('INVALID_EXECUTOR', 'executor 只能是 deepseek/claude/codex');
  if (options.prepare) {
    await store.transaction(data => {
      const key = taskKey(task), previous = data.tasks[key];
      if (previous && previous.status !== 'READY') fail('TASK_ALREADY_STARTED', '只能准备新任务或更新尚未开始的 READY 任务');
      const prepared = path.join(store.root, 'prepared', key.replace(':', '-') + '.json');
      atomic(prepared, task);
      data.tasks[key] = { id: task.id, workspace: task.workspace, status: 'READY', reserved: false, scopes: scopes(task), attempts: 0, deepseek_attempts: 0, contract_hash: hash(JSON.stringify(task)), prepared_task_file: prepared };
    });
    print({ task_id: task.id, workspace: task.workspace, status: 'READY', api_request_made: false });
    return;
  }
  if (executor === 'deepseek' && sensitivity.sensitive && !task.sensitive_override) fail('SENSITIVE_NOT_DELEGATABLE', `敏感任务不能下放给 DeepSeek：${sensitivity.sensitive_reasons.join(', ')}；请改用 --executor claude/codex，误报可用 sensitive_override 说明原因`);
  const preflight = executor === 'deepseek' ? doctor({ ...options, workspace: task.workspace }) : null;
  let web = { enabled: false, reason: options['headless-only'] ? 'explicit-headless-only' : 'web-mode-off' };
  if (options['web-mode'] === 'required') {
    const config = webConfig(options), client = await connectWeb(config);
    const registered = await client.workspace(task.workspace);
    web = { enabled: true, config, workspace_id: registered.workspaceId, web_url: config.origin };
  }
  const key = taskKey(task), id = uid('run'), dir = store.runDir(id);
  let previous, run, recorded = false;
  const control = new AbortController();
  const onSignal = () => control.abort();
  process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);
  try {
    await store.transaction(data => {
      const old = data.tasks[key];
      if (old && !['READY', 'REWORK'].includes(old.status)) fail(old.status === 'ACCEPTED' ? 'ALREADY_ACCEPTED' : 'REVIEW_REQUIRED', `任务当前为 ${old.status}；先 collect 并提交审查，不重复派发`);
      const count = old?.deepseek_attempts || 0;
      if (executor === 'deepseek' && count >= maxAttempts) fail('TAKEOVER_REQUIRED', `DeepSeek 已达到 ${maxAttempts} 次调用上限，请使用 --executor ${['claude', 'codex'].includes(old?.next_executor) ? old.next_executor : otherModel(task.leader)}`);
      if (old?.next_executor && executor !== old.next_executor) fail('EXECUTOR_MISMATCH', `审查指定下一轮 executor=${old.next_executor}，当前为 ${executor}`);
      if (old?.status === 'REWORK') {
        const oldRun = store.getRun(old.latest_run);
        previous = oldRun.review;
        if (capture(oldRun.task).digest !== previous.artifact_digest) fail('STALE_REVIEW', '上一轮审查后文件又发生变化，请重新 collect 并提交审查');
        if (hash(JSON.stringify(task)) !== old.contract_hash && !previous.plan_adjustment?.trim()) fail('CONTRACT_CHANGED', '任务契约变化需要在上一轮审查中说明 plan_adjustment');
        if (oldRun.task.write_scope.some(p => !scopes(task).some(s => inside(s, path.resolve(task.workspace, p))))) fail('SCOPE_SHRINK', '返工不能丢弃上一轮的写入范围；验收必须覆盖完整任务改动');
        if (executor === 'deepseek' && count >= maxAttempts - 1 && !previous.strategy_change?.trim()) fail('STRATEGY_CHANGE_REQUIRED', '最后一次 DeepSeek 机会前必须在审查中说明 strategy_change，不能重复同一路径');
      }
      const lease = { id, run_id: id, key, kind: executor, workspace: task.workspace, scopes: scopes(task), owner: identity(), started_at: now() };
      for (const dep of task.depends_on) {
        const item = data.tasks[taskKey({ ...task, id: dep })];
        if (item?.status === 'ACCEPTED') {
          const accepted = store.getRun(item.latest_run);
          if (capture(accepted.task).digest !== accepted.review?.artifact_digest) fail('DEPENDENCY_STALE', `依赖 ${dep} 验收后文件已变化，需组长重新核对并验收`);
        }
      }
      reserve(data, lease, key, task);
      mkdir(dir);
      const baseline = capture(task, path.join(dir, 'before'));
      const git = spawnSync('git', ['-C', task.workspace, 'status', '--porcelain=v1', '-uall', '--', '.'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      if (git.status === 0) textFile(path.join(dir, 'git-status-before.txt'), git.stdout);
      run = { id, key, task, previous_run: old?.latest_run || null, task_start_run: old?.task_start_run || id, executor, leader: task.leader, risk: task.risk, ...sensitivity, sensitive_override: task.sensitive_override || null, deepseek_max_attempts: maxAttempts, attempt: (old?.attempts || 0) + 1, status: 'RUNNING', owner: lease.owner, started_at: now(), baseline, preflight, web };
      store.saveRun(run);
      data.tasks[key] = { id: task.id, workspace: task.workspace, latest_run: id, task_start_run: run.task_start_run, status: 'RUNNING', scopes: lease.scopes, reserved: true, attempts: run.attempt, deepseek_attempts: count + (executor === 'deepseek' ? 1 : 0), contract_hash: hash(JSON.stringify(task)) };
    });
    print({ ...short(run), state_directory: dir, web });
    recorded = true; ledger('start', id, '--mode', executor === task.leader ? 'self' : 'delegated', '--title', `${displayName(executor)}：${task.id}（第 ${run.attempt} 次）`);
    if (executor === 'claude') {
      const deadline = Date.now() + task.timeout_seconds * 1000;
      while (store.getRun(id).status === 'RUNNING' && !control.signal.aborted && Date.now() < deadline) await sleep(250);
      const current = store.getRun(id);
      if (current.status !== 'RUNNING') { print(short(current)); return; }
      run.result = { exit_code: null, stop_reason: control.signal.aborted ? 'cancelled' : 'timeout', duration_ms: Date.now() - Date.parse(run.started_at), stdout: '' };
    } else {
      const patch = path.join(dir, 'worker.patch.yml');
      if (executor === 'deepseek') textFile(patch, workerPatch);
      const prompt = makePrompt(task, run, previous);
      textFile(path.join(dir, 'prompt.txt'), prompt);
      let lastCheck = 0;
      const argv = executor === 'codex'
        ? ['python3', CODEX_TASK, path.join(dir, 'prompt.txt'), '--cd', task.workspace, '--sandbox', 'workspace-write', '--timeout', String(task.timeout_seconds)]
        : [preflight.node, preflight.dsh_bin, '--profile', 'headless', '--patch', patch, prompt];
      const env = executor === 'codex' ? { ...process.env, AGENT_HUB_LEDGER_SKIP: '1' } : childEnvironment(preflight.dsh_home, preflight.credential);
      run.result = await execute(argv, {
        cwd: task.workspace, env, timeoutSeconds: task.timeout_seconds,
        logPrefix: path.join(dir, 'worker'), secrets: preflight?.secrets, signal: control.signal,
        onSpawn: async child => { run.child = child; await store.transaction(data => { store.saveRun(run); data.leases[id].child = child; }); },
        onHeartbeat: async () => {
          if (Date.now() - lastCheck < 30000) return;
          lastCheck = Date.now();
          const unexpected = await store.transaction(data => checkWave(data, task.workspace));
          if (unexpected.length) { await haltWorkspace(store, task.workspace, unexpected, id); control.abort(); fail('OUT_OF_SCOPE', `检测到无法归属的改动: ${unexpected.join(', ')}`); }
          process.stderr.write(JSON.stringify({ run_id: id, status: 'RUNNING', elapsed_seconds: Math.round((Date.now() - Date.parse(run.started_at)) / 1000) }) + '\n');
        },
      });
      if (executor === 'codex') {
        // execute 已将原始 stdout 存入 worker.stdout.log；报告仅使用最后的 summary。
        const raw = run.result.stdout;
        for (let start = raw.indexOf('{'); start !== -1; start = raw.indexOf('{', start + 1)) {
          let summary;
          try { summary = JSON.parse(raw.slice(start)); } catch { continue; }
          if (!summary || typeof summary !== 'object' || Array.isArray(summary)) continue;
          if (typeof summary.final === 'string') run.result.stdout = summary.final;
          if (summary.jev_screen !== undefined) run.jev_screen = summary.jev_screen;
          break;
        }
      }
    }
    await collectFiles(store, run);
    const unexpected = await store.transaction(data => {
      const bad = checkWave(data, task.workspace);
      run.status = run.result.exit_code === 0 && !run.result.stop_reason && !run.result.error && run.result.stdout.trim() && !bad.length ? 'REVIEW' : 'BLOCKED';
      run.error = bad.length ? { code: 'OUT_OF_SCOPE', paths: bad } : run.status === 'BLOCKED' ? { code: run.result.stop_reason || (run.result.stdout.trim() ? 'EXECUTION_FAILED' : 'EMPTY_REPORT'), detail: run.result.error || run.result.stderr_tail } : null;
      run.finished_at = now();
      delete data.leases[id];
      Object.assign(data.tasks[key], { status: run.status, reserved: run.status === 'REVIEW' });
      store.saveRun(run);
      return bad;
    });
    if (unexpected.length) await haltWorkspace(store, task.workspace, unexpected, id);
    const webResult = await updateWeb(store, run);
    print({ ...short(run), collection: path.join(dir, 'collection.json'), web: webResult });
    if (run.status === 'BLOCKED') process.exitCode = 1;
  } catch (e) {
    e.message = redact(e.message, preflight?.secrets);
    if (run) {
      // 只在确认所拥有的进程退出后释放锁，不能以脚本异常代替退出证据。
      let stopped = true;
      try { await terminateGroup(run.child, { orphan: true }); } catch { stopped = false; }
      await store.transaction(data => {
        run.status = 'BLOCKED'; run.error = { code: e.code || 'RUN_ERROR', detail: redact(e.message) }; run.finished_at = now();
        if (stopped) delete data.leases[id];
        Object.assign(data.tasks[key], { status: 'BLOCKED', reserved: !stopped });
        store.saveRun(run);
      });
      if (stopped) await updateWeb(store, run);
    }
    throw e;
  } finally {
    process.removeListener('SIGTERM', onSignal); process.removeListener('SIGINT', onSignal);
    if (recorded) { let st = run.status; try { st = store.getRun(id).status; } catch {} ledger('end', id, '--force', '--note', `status=${st}`); }
  }
}

async function stopRun(options, store) {
  const run = store.getRun(options['run-id']);
  const owned = Object.values(store.load().leases).filter(x => x.run_id === run.id);
  if (!owned.length && run.status === 'RUNNING') {
    if (alive(run.owner)) fail('OWNER_STILL_RUNNING', '运行文件与注册表暂不一致，但持有进程仍存活；不能清除');
    await terminateGroup(run.child, { orphan: true });
    await store.transaction(data => {
      if (Object.values(data.leases).some(x => x.run_id === run.id)) fail('OWNER_CHANGED', '运行正在恢复，请重试 status');
      run.status = 'BLOCKED'; run.finished_at = now(); run.error = { code: 'INTERRUPTED', detail: '恢复跨文件状态写入中断，未重跑任何业务动作' };
      const item = data.tasks[run.key] ||= { id: run.task.id, workspace: run.task.workspace, latest_run: run.id, task_start_run: run.task_start_run || run.id, scopes: scopes(run.task), attempts: run.attempt, deepseek_attempts: run.executor === 'deepseek' ? run.attempt : 0, contract_hash: hash(JSON.stringify(run.task)) };
      if (item.latest_run !== run.id) fail('STALE_RUN', '任务已有较新的运行，不能用旧记录覆盖');
      Object.assign(item, { status: 'BLOCKED', reserved: false }); store.saveRun(run);
    });
  }
  for (let lease of owned) {
  const leaseId = lease.id;
  if (alive(lease.owner)) {
    process.kill(lease.owner.pid, 'SIGTERM');
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline && store.load().leases[leaseId] && alive(lease.owner)) await sleep(100);
    if (store.load().leases[leaseId] && alive(lease.owner)) fail('SUPERVISOR_STILL_RUNNING', '监督进程尚未退出，保留锁，不扩大终止范围');
  }
  lease = store.load().leases[leaseId];
  if (lease) {
    await terminateGroup(lease.child, { orphan: true });
    await store.transaction(data => {
      if (alive(data.leases[leaseId]?.owner)) fail('OWNER_CHANGED', '运行持有者发生变化');
      const current = store.getRun(run.id);
      current.status = 'BLOCKED'; current.error = { code: 'INTERRUPTED', detail: '已恢复孤儿运行；保留文件，重新审查后再派发' }; current.finished_at = now();
      delete data.leases[leaseId];
      Object.assign(data.tasks[run.key], { status: 'BLOCKED', reserved: false });
      store.saveRun(current);
    });
  }
  }
  const stoppedRun = store.getRun(run.id);
  print({ ...short(stoppedRun), stopped: true, web: await updateWeb(store, stoppedRun) });
}

async function verify(store, run) {
  if (run.status === 'RUNNING') fail('WRITER_RUNNING', '先结束开发；Claude 受监督执行使用 collect --finish');
  const leaseId = uid('verify'), control = new AbortController();
  const sig = () => control.abort();
  await store.transaction(data => reserve(data, { id: leaseId, run_id: run.id, kind: 'verify', workspace: run.task.workspace, scopes: [run.task.workspace], owner: identity() }, run.key, run.task, { verification: true }));
  process.on('SIGINT', sig); process.on('SIGTERM', sig);
  const results = [];
  let before;
  let cleanupConfirmed = true;
  try {
    before = capture(run.task).digest;
    for (const check of run.task.checks) {
      if (control.signal.aborted) break;
      const prefix = path.join(store.runDir(run.id), 'checks', check.id);
      cleanupConfirmed = false;
      const outcome = await execute(check.argv, { cwd: path.resolve(run.task.workspace, check.cwd), env: childEnvironment(), timeoutSeconds: check.timeout_seconds, logPrefix: prefix, signal: control.signal,
        onSpawn: child => store.transaction(data => { data.leases[leaseId].child = child; }) });
      cleanupConfirmed = true;
      results.push({ id: check.id, argv: check.argv, cwd: check.cwd, kind: check.kind, exit_code: outcome.exit_code, stop_reason: outcome.stop_reason, error: outcome.error || null, status: outcome.exit_code === 0 && !outcome.stop_reason && !outcome.error ? 'pass' : 'fail', duration_ms: outcome.duration_ms, stdout_file: prefix + '.stdout.log', stderr_file: prefix + '.stderr.log' });
      if (outcome.stop_reason) break;
    }
    const after = capture(run.task).digest;
    const checks = { run_id: run.id, verified_at: now(), artifact_digest: after, source_unchanged: before === after, results };
    atomic(path.join(store.runDir(run.id), 'checks.json'), checks);
    return checks;
  } finally {
    if (cleanupConfirmed) await store.transaction(data => { delete data.leases[leaseId]; });
    process.removeListener('SIGINT', sig); process.removeListener('SIGTERM', sig);
  }
}

function validateReview(review, run, evidence, checks, data) {
  if (!['claude', 'codex'].includes(review.reviewer) || review.reviewer !== run.task.leader) fail('INVALID_REVIEWER', `reviewer 必须为任务组长 ${run.task.leader}`);
  if (review.takeover_by !== undefined && !['claude', 'codex'].includes(review.takeover_by)) fail('INVALID_REVIEW', 'takeover_by 必须为 claude 或 codex');
  if (review.run_id !== run.id || review.artifact_digest !== evidence.artifact_digest) fail('STALE_REVIEW', 'run_id/artifact_digest 不符，请针对当前快照提交组长审查');
  if (!['accept', 'rework', 'block', 'takeover'].includes(review.decision)) fail('INVALID_REVIEW', 'decision 必须为 accept/rework/block/takeover');
  if (typeof review.summary !== 'string' || !review.summary.trim()) fail('INVALID_REVIEW', '审查必须说明 summary');
  if (review.decision === 'accept') {
    if (run.task.risk === 'high' && !(['claude', 'codex'].includes(run.executor) && run.executor !== run.task.leader)) {
      const cross = review.cross_review;
      if (!cross || !['claude', 'codex'].includes(cross.reviewer) || cross.reviewer === run.task.leader || cross.decision !== 'pass' || typeof cross.summary !== 'string' || !cross.summary.trim()) fail('CROSS_REVIEW_REQUIRED', '高风险验收需要另一位 Claude/Codex 的 cross_review（decision=pass 且 summary 非空）');
    }
    if (run.status !== 'REVIEW' || run.result?.exit_code !== 0 || run.result?.stop_reason || run.result?.error || run.error || !run.result?.stdout?.trim()) fail('EXECUTION_NOT_REVIEWABLE', '仅允许验收成功执行且处于 REVIEW 的新一轮开发；REWORK/BLOCKED 不能直接接受');
    if (review.spec !== 'pass' || review.quality !== 'pass' || !Array.isArray(review.blocking_findings) || review.blocking_findings.length) fail('AUDIT_FAILED', '需求审查、质量审查均须通过，阻塞问题必须清零');
    if (run.task.not_done_if?.length && !review.not_done_review?.trim()) fail('NOT_DONE_REVIEW_REQUIRED', '任务声明了 not_done_if，审查需在 not_done_review 中逐条说明核对结论');
    if (!evidence.changes.length && !review.no_change_reason?.trim()) fail('NO_CHANGES', '本轮没有任何文件改动；确属无需改动时在 no_change_reason 说明原因');
    if (!Array.isArray(review.acceptance)) fail('INVALID_REVIEW', '缺少逐项验收证据');
    for (const a of run.task.acceptance.filter(x => x.required)) {
      const rows = review.acceptance.filter(x => x.id === a.id);
      if (rows.length !== 1 || rows[0].status !== 'pass' || !rows[0].evidence?.trim()) fail('ACCEPTANCE_FAILED', `验收项 ${a.id} 未通过或没有证据`);
    }
    if (run.task.checks.length && (!checks || !checks.source_unchanged || checks.artifact_digest !== evidence.artifact_digest || run.task.checks.some(c => checks.results.find(r => r.id === c.id)?.status !== 'pass'))) fail('CHECKS_FAILED', '缺少对当前代码实际执行且通过的检查；使用 collect --verify');
  }
  if (data.waves[run.task.workspace]?.conflict?.length) {
    if (review.decision === 'accept') fail('WORKSPACE_CONFLICT', '先核对范围外改动并返工，不得直接验收');
    if (!review.scope_resolution?.trim()) fail('SCOPE_RESOLUTION_REQUIRED', '审查需说明 scope_resolution：改动来源、保留/修复方案');
  }
}

async function collect(options, store) {
  let run = store.getRun(options['run-id']);
  if ([options.finish, options.verify, Boolean(options.review)].filter(Boolean).length > 1) fail('ARGUMENT_ERROR', '--finish/--verify/--review 分开执行');
  if (options.finish) {
    if (run.executor !== 'claude' || run.status !== 'RUNNING') fail('NOT_MANUAL_EXECUTOR', '--finish 仅用于正在运行的 Claude 受监督执行任务');
    await store.transaction(data => {
      const bad = checkWave(data, run.task.workspace);
      run.status = bad.length ? 'BLOCKED' : 'REVIEW'; run.finished_at = now();
      run.result = { exit_code: bad.length ? 1 : 0, stdout: `${displayName(run.executor)} 已结束写入，等待组长审查与验证。`, stop_reason: null };
      if (bad.length) run.error = { code: 'OUT_OF_SCOPE', paths: bad };
      delete data.leases[run.id]; Object.assign(data.tasks[run.key], { status: run.status, reserved: run.status === 'REVIEW' }); store.saveRun(run);
    });
  }
  if (run.status === 'RUNNING') fail('WRITER_RUNNING', '开发运行中，使用 status 查看状态');
  let checks;
  if (options.verify) checks = await verify(store, run);
  const evidence = await collectFiles(store, run);
  const checkPath = path.join(store.runDir(run.id), 'checks.json');
  checks ||= fs.existsSync(checkPath) ? readJSON(checkPath) : null;
  if (options.review) {
    const review = readJSON(options.review);
    await store.transaction(data => {
      const current = data.tasks[run.key];
      if (current.latest_run !== run.id || data.leases[run.id]) fail('STALE_RUN', '只允许审查该任务最新且已停止写入的运行');
      if (Object.values(data.leases).some(l => l.workspace === run.task.workspace)) fail('WORKSPACE_BUSY', '同一工作区仍有写入/检查进程，请等待后验收');
      if (capture(run.task).digest !== evidence.artifact_digest) fail('STALE_COLLECTION', '收集后文件又发生变化');
      validateReview(review, run, evidence, checks, data);
      if (data.waves[run.task.workspace]?.conflict?.length && review.scope_resolution) data.waves[run.task.workspace].conflict = [];
      run.review = review; run.reviewed_at = now();
      run.status = { accept: 'ACCEPTED', rework: 'REWORK', takeover: 'REWORK', block: 'BLOCKED' }[review.decision];
      run.next_executor = review.decision === 'takeover' ? review.takeover_by || otherModel(run.task.leader)
        : review.decision === 'rework' ? review.takeover_by || (run.executor !== 'deepseek' ? run.executor : current.deepseek_attempts >= (run.deepseek_max_attempts ?? options['deepseek-max-attempts']) ? otherModel(run.task.leader) : 'deepseek')
        : 'deepseek';
      Object.assign(current, { status: run.status, reserved: ['REVIEW', 'REWORK'].includes(run.status), next_executor: run.next_executor });
      const history = path.join(store.runDir(run.id), 'reviews', `${Date.now()}-${uid('review')}.json`);
      atomic(history, review); store.saveRun(run);
    });
  }
  const web = run.web?.enabled && (options.finish || options.review) ? await updateWeb(store, run) : webStatus(store, run);
  print({ ...short(run), ...evidence, checks, web });
}

function status(options, store) {
  const data = store.load();
  if (options['run-id']) {
    const r = store.getRun(options['run-id']);
    const current = capture(r.task);
    print({ ...short(r), owner_alive: alive(data.leases[r.id]?.owner), child_alive: alive(data.leases[r.id]?.child), artifact_digest: current.digest, accepted_snapshot_changed: r.status === 'ACCEPTED' && r.review.artifact_digest !== current.digest, state_directory: store.runDir(r.id), web: webStatus(store, r) });
  } else {
    print({ tasks: Object.values(data.tasks).filter(t => !options.workspace || path.resolve(options.workspace) === t.workspace), leases: Object.values(data.leases).map(l => ({ run_id: l.run_id, kind: l.kind, workspace: l.workspace, owner_alive: alive(l.owner) })), workspace_conflicts: Object.fromEntries(Object.entries(data.waves).filter(([, v]) => v.conflict?.length).map(([k, v]) => [k, v.conflict])) });
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options: input } = parse([...argv]);
  if (!command || command === '--help' || input.help) { process.stdout.write(HELP); return; }
  const options = resolveOptions(input);
  const store = new Store(options['state-root']);
  switch (command) {
    case 'doctor': {
      const report = doctor(options);
      if (options['web-mode'] === 'required') { const client = await connectWeb(webConfig(options)); await client.list(); report.web = { authenticated: true, web_url: client.config.origin, management_requests_made: true, workspace_registration_checked: false }; }
      print(report); break;
    }
    case 'web': {
      if (options.configure) { print(await configureWeb(options)); break; }
      if (options['run-id']) {
        const run = store.getRun(options['run-id']);
        const result = await syncWeb(store, run, input['web-config'] || process.env.TEAM_DEV_WEB_CONFIG ? options : {});
        await store.transaction(() => { const current = store.getRun(run.id); current.web = { enabled: true, config: input['web-config'] || process.env.TEAM_DEV_WEB_CONFIG ? webConfig(options) : run.web?.config || webConfig(options), workspace_id: result.workspace_id, web_url: result.web_url }; store.saveRun(current); });
        print(result);
      } else {
        if (!options.workspace) fail('WORKSPACE_REQUIRED', 'web 需要 --workspace 或 --run-id');
        const client = await connectWeb(webConfig(options));
        const directory = workspace(options.workspace);
        print({ web_url: client.config.origin, workspace: await client.workspace(directory), authenticated: true, model_request_made: false });
      }
      break;
    }
    case 'run': await runTask(options, store); break;
    case 'status': status(options, store); break;
    case 'stop': await stopRun(options, store); break;
    case 'collect': await collect(options, store); break;
    default: fail('ARGUMENT_ERROR', `未知命令 ${command}`);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { process.stderr.write(JSON.stringify({ ok: false, code: e.code || 'ERROR', message: redact(e.message) }) + '\n'); process.exitCode = 2; });
}
