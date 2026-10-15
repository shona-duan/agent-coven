"""派活结束后自动用 Jev 初筛本次改动（codex_task.py / run_task.py 共用）。

只当报警器：2026-10-15 实测 incomplete、out_of_brief 最准，作报警；removes_behavior、security、data_risk 只作提示。
任何失败（非 git 仓库、无改动、没 key、网络）都静默跳过，不影响派活结果。
"""
import difflib, json, subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ALARM = {'incomplete': '像没做完（TODO/空壳/缺块）', 'out_of_brief': '混进了任务没要求的改动'}
HINT = {'removes_behavior': '可能删了原有功能', 'security': '碰了鉴权/权限/密钥', 'data_risk': '有删改数据的操作'}


def _git(cwd, *args):
    return subprocess.run(['git', '-C', str(cwd), *args], capture_output=True, text=True, timeout=60)


def snapshot(workspace):
    """派活前记下工作区状态：已跟踪文件的快照提交 + 未跟踪文件列表。非 git 仓库返回 None。"""
    try:
        if _git(workspace, 'rev-parse', '--is-inside-work-tree').stdout.strip() != 'true':
            return None
        ref = _git(workspace, 'stash', 'create').stdout.strip() or _git(workspace, 'rev-parse', 'HEAD').stdout.strip()
        untracked = {}
        for f in set(_git(workspace, 'ls-files', '--others', '--exclude-standard').stdout.split('\n')) - {''}:
            p = Path(workspace) / f
            untracked[f] = p.read_text(errors='replace') if p.is_file() and p.stat().st_size < 200_000 else None
        return {'ref': ref, 'untracked': untracked}
    except Exception:
        return None


def screen(workspace, snap, brief, run_dir, node):
    """对比派活前后的改动交给 Jev，结果写 run_dir/jev-screen.json 并返回摘要；无改动或失败返回 None。"""
    if not snap:
        return None
    try:
        diff = _git(workspace, 'diff', snap['ref'], '--', '.').stdout
        now = set(_git(workspace, 'ls-files', '--others', '--exclude-standard').stdout.split('\n')) - {''}
        for f in sorted(now - snap['untracked'].keys()):
            diff += _git(workspace, 'diff', '--no-index', '--', '/dev/null', f).stdout
        for f in sorted(now & snap['untracked'].keys()):  # 派活前就存在的未跟踪文件，对比内存里的旧内容
            old, p = snap['untracked'][f], Path(workspace) / f
            if old is not None and p.is_file() and (cur := p.read_text(errors='replace')) != old:
                diff += ''.join(difflib.unified_diff(old.splitlines(True), cur.splitlines(True), 'a/' + f, 'b/' + f))
        if not diff.strip():
            return None
        patch, brief_file = Path(run_dir) / 'changes.patch', Path(run_dir) / 'brief.txt'
        patch.write_text(diff)
        brief_file.write_text(brief[:8000])
        r = subprocess.run([node, str(ROOT / 'skills/team-dev/scripts/jev.mjs'), 'screen', '--diff', str(patch),
                            '--brief', '@' + str(brief_file), '--id', Path(run_dir).name],
                           capture_output=True, text=True, timeout=120)
        flags = json.loads(r.stdout)['flags']
    except Exception:
        return None
    result = {
        'alarms': [msg for k, msg in ALARM.items() if flags.get(k, 0) >= 0.5],
        'hints': [msg for k, msg in HINT.items() if flags.get(k, 0) >= 0.5],
        'flags': flags,
        'note': 'Jev 只是报警器，不判断改得对不对；没报警也要照常看 diff。',
    }
    (Path(run_dir) / 'jev-screen.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    return result
