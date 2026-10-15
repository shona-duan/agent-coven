#!/usr/bin/env python3
"""Dispatch one bounded task to Codex (codex exec); log under runs/."""
import argparse, datetime, json, os, shutil, subprocess, sys
from pathlib import Path
import jev_screen

root = Path(__file__).resolve().parent
p = argparse.ArgumentParser()
p.add_argument('task_file', type=Path, nargs='?')
p.add_argument('--list', action='store_true', help='不派发任务，只列出 runs/ 下最近 10 个 codex 运行')
p.add_argument('--cd', type=Path, default=Path.cwd(), help='工作目录')
p.add_argument('--sandbox', default='read-only',
               choices=['read-only', 'workspace-write'], help='默认只读；改文件需显式 workspace-write')
p.add_argument('--resume', help='继续某个 Codex 会话 id')
p.add_argument('--add-dir', action='append', default=[], help='额外可写目录（可多次）')
p.add_argument('--timeout', type=int, default=900)
a = p.parse_args()
if a.list:
    dirs = sorted((d for d in (root / 'runs').glob('codex-*') if d.is_dir()),
                  key=lambda d: d.name, reverse=True)[:10]
    for d in dirs:
        result = {}
        if (d / 'result.json').exists():
            try:
                result = json.loads((d / 'result.json').read_text())
            except json.JSONDecodeError:
                result = {}
        task_file = d / 'task.txt'
        first = '-'
        if task_file.exists():
            lines = task_file.read_text().splitlines()
            if lines:
                first = lines[0][:40]
        print(d.name, result.get('exit_code', '-'), result.get('thread_id') or '-', first, sep='\t')
    sys.exit(0)
if not a.task_file:
    p.error('需要 task_file（或使用 --list）')
task = a.task_file.resolve().read_text().strip()
if not task:
    raise SystemExit('任务不能为空。')
cwd = a.cd.resolve(strict=True)
run = root / 'runs' / ('codex-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
run.mkdir(parents=True)
(run / 'task.txt').write_text(task)
# 环境变量 > 本机配置 > PATH；说明键不参与配置。
config_file = root / 'config.json'
config = {k: v for k, v in json.loads(config_file.read_text()).items() if not k.startswith('_')} if config_file.exists() else {}
codex = os.path.expanduser(os.environ.get('AGENT_HUB_CODEX_BIN') or os.environ.get('CODEX_BIN') or config.get('codex_bin') or shutil.which('codex') or 'codex')
node = os.path.expanduser(os.environ.get('AGENT_HUB_NODE_BIN') or config.get('node_bin') or shutil.which('node') or str(Path(shutil.which(codex) or codex).parent / 'node'))
cmd = [codex, 'exec']
if a.resume:
    cmd += ['resume', a.resume]
for d in a.add_dir:
    cmd += ['--add-dir', str(Path(d).resolve(strict=True))]
cmd += ['--json', '--skip-git-repo-check', '-s', a.sandbox, '-C', str(cwd),
        '-o', str(run / 'last-message.md'), '-']
env = os.environ.copy()
if os.path.isabs(codex):  # 只前置真实目录，避免把 '.' 放进 PATH
    env['PATH'] = str(Path(codex).parent) + os.pathsep + env.get('PATH', '')
print(f'任务日志：{run}', flush=True)
# 派活自动记账，窗口=Codex 实际运行时间；记账失败不影响派活。
ledger = [node, str(root / 'ledger' / 'ledger.mjs'), 'task']
def record(*args):
    try: subprocess.run(ledger + list(args), capture_output=True, env=env, timeout=30)
    except Exception: pass
snap = jev_screen.snapshot(cwd) if a.sandbox != 'read-only' else None
record('start', run.name, '--mode', 'delegated', '--title', 'Codex：' + task.splitlines()[0].lstrip('# ')[:60])
try:
    r = subprocess.run(cmd, input=task, capture_output=True, text=True, env=env, timeout=a.timeout)
    code, out, err, timed_out = r.returncode, r.stdout, r.stderr, False
except subprocess.TimeoutExpired as e:
    code, out, err, timed_out = 124, e.stdout or '', e.stderr or '', True
    out = out.decode() if isinstance(out, bytes) else out
    err = err.decode() if isinstance(err, bytes) else err
record('end', run.name, '--force', '--note', f'exit={code}' + (' 超时' if timed_out else ''))
(run / 'events.jsonl').write_text(out)
(run / 'stderr.log').write_text(err)
thread = None
for line in out.splitlines():
    try:
        e = json.loads(line)
    except json.JSONDecodeError:
        continue
    thread = thread or e.get('thread_id') or e.get('session_id')
last = run / 'last-message.md'
summary = {'exit_code': code, 'timed_out': timed_out, 'cwd': str(cwd), 'sandbox': a.sandbox,
           'thread_id': thread, 'final': last.read_text() if last.exists() else ''}
summary['jev_screen'] = jev_screen.screen(cwd, snap, task, run, node)
(run / 'result.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
print(json.dumps(summary, ensure_ascii=False, indent=2))
if code and err:
    print(err[-3000:], file=sys.stderr)
sys.exit(code)
