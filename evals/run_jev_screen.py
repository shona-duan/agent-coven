#!/usr/bin/env python3
"""运行固定 Jev screen 测试集，或从已保存的分数离线评分。"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
SUITE = ROOT / 'evals' / 'jev-screen'
FLAGS = ('out_of_brief', 'removes_behavior', 'security', 'data_risk', 'incomplete')
SAFE_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]*\Z')


def read_json(path):
    with Path(path).open(encoding='utf-8') as stream:
        return json.load(stream)


def validate_labels(value, context):
    if not isinstance(value, list) or any(not isinstance(x, str) or x not in FLAGS for x in value):
        raise ValueError(f'{context} 必须是已知 flag 的数组：{", ".join(FLAGS)}')
    if len(set(value)) != len(value):
        raise ValueError(f'{context} 含重复 flag')


def load_cases(suite, allow_empty=False):
    cases = read_json(suite / 'cases.json')
    if not isinstance(cases, list) or not (cases or allow_empty):
        raise ValueError('cases.json 为空：先用 evals/add_case.py 从真实派活里加样本' if cases == [] else 'cases.json 必须是数组')
    seen = set()
    for case in cases:
        if not isinstance(case, dict):
            raise ValueError('每条 case 必须是对象')
        case_id = case.get('id')
        if not isinstance(case_id, str) or not SAFE_NAME.fullmatch(case_id) or case_id in seen:
            raise ValueError(f'非法或重复 id：{case_id!r}')
        seen.add(case_id)
        for key in ('brief', 'source', 'patch'):
            if not isinstance(case.get(key), str) or not case[key].strip():
                raise ValueError(f'{case_id}: {key} 必须是非空文字')
        validate_labels(case.get('expect'), f'{case_id}.expect')
        validate_labels(case.get('expect_hint', []), f'{case_id}.expect_hint')
        patch = (suite / case['patch']).resolve()
        if not patch.is_relative_to((suite / 'patches').resolve()) or not patch.is_file():
            raise ValueError(f'{case_id}: patch 必须是 patches/ 内存在的文件')
    return cases


def validate_scores(scores, cases):
    ids = {case['id'] for case in cases}
    if not isinstance(scores, dict) or set(scores) != ids:
        actual = set(scores) if isinstance(scores, dict) else set()
        raise ValueError(f'分数与测试集 id 不一致；缺失：{sorted(ids - actual)}；多余：{sorted(actual - ids)}')
    for case_id, flags in scores.items():
        if not isinstance(flags, dict) or set(flags) != set(FLAGS):
            raise ValueError(f'{case_id}: 必须包含且仅包含五个 flag')
        for flag, value in flags.items():
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1:
                raise ValueError(f'{case_id}.{flag}: 分数必须是 0~1 的有限数字')
    return scores


def summarize(cases, scores, threshold):
    clean = [case for case in cases if case['source'] == '真实提交' and not case['expect']]
    result = {}
    for metric in ('detection', 'false_positive'):
        result[metric] = {}
        for flag in FLAGS:
            eligible = [case for case in cases if flag in case['expect']] if metric == 'detection' else clean
            numerator = sum(scores[case['id']][flag] >= threshold and
                            (metric == 'detection' or flag not in case.get('expect_hint', []))
                            for case in eligible)
            total = len(eligible)
            result[metric][flag] = {'count': numerator, 'total': total,
                                     'rate': numerator / total if total else None}
    return result


def threshold_value(raw):
    value = float(raw)
    if not math.isfinite(value) or not 0 <= value <= 1:
        raise argparse.ArgumentTypeError('阈值必须是 0~1 的有限数字')
    return value


def load_baseline(path, cases):
    baseline = read_json(path)
    if not isinstance(baseline, dict):
        raise ValueError('基线必须是 JSON 对象')
    validate_scores(baseline.get('flags'), cases)
    threshold = threshold_value(baseline.get('threshold', float('nan')))
    expected = summarize(cases, baseline['flags'], threshold)
    if baseline.get('metrics') != expected:
        raise ValueError('基线汇总与分数/当前标签不一致，请检查测试集或重新保存基线')
    return baseline


def run_live(cases):
    config_path = ROOT / 'config.json'
    config = read_json(config_path) if config_path.exists() else {}
    node = os.path.expanduser(config.get('node_bin') or shutil.which('node') or 'node')
    script = ROOT / 'skills' / 'team-dev' / 'scripts' / 'jev.mjs'

    def run(case):
        command = [node, str(script), 'screen', '--diff', str((SUITE / case['patch']).resolve()),
                   '--brief', case['brief'], '--id', 'eval-' + case['id']]
        try:
            proc = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', timeout=180)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RuntimeError(f'{case["id"]}: 调用 Jev 失败：{exc}') from exc
        if proc.returncode:
            raise RuntimeError(f'{case["id"]}: Jev 退出码 {proc.returncode}：{proc.stderr.strip() or proc.stdout.strip()}')
        try:
            data = json.loads(proc.stdout)
            flags = validate_scores({case['id']: data['flags']}, [case])[case['id']]
        except (KeyError, TypeError, ValueError) as exc:
            raise RuntimeError(f'{case["id"]}: Jev 输出无效：{exc}') from exc
        return flags

    scores = {}
    with ThreadPoolExecutor(max_workers=6) as pool:
        pending = {pool.submit(run, case): case for case in cases}
        for future in as_completed(pending):
            case = pending[future]
            try:
                scores[case['id']] = future.result()
            except Exception:
                for task in pending:
                    task.cancel()
                raise
            print(f'Jev 完成 {len(scores)}/{len(cases)}：{case["id"]}', file=sys.stderr)
    return {case['id']: scores[case['id']] for case in cases}


def display(metrics, threshold, baseline, scores, cases):
    print(f'测试集 jev-screen：{len(cases)} 条；阈值 {threshold:g}')
    if baseline:
        print(f'基线：{baseline.get("created_at", "未知日期")}；阈值 {baseline["threshold"]:g}')
    print(f'{"指标":<12} {"flag":<19} {"本次（比例）":<21}' + (' 基线（比例）               变化' if baseline else ''))
    for metric, label in (('detection', '抓到率'), ('false_positive', '真实提交误报率')):
        for flag in FLAGS:
            item = metrics[metric][flag]
            rate = 'N/A' if item['rate'] is None else f'{item["rate"]:.1%}'
            line = f'{label:<12} {flag:<19} {str(item["count"]) + "/" + str(item["total"]) + " (" + rate + ")":<21}'
            if baseline:
                old = baseline['metrics'][metric][flag]
                old_rate = 'N/A' if old['rate'] is None else f'{old["rate"]:.1%}'
                delta = 'N/A' if old['rate'] is None or item['rate'] is None else f'{(item["rate"] - old["rate"]) * 100:+.1f} 百分点'
                line += f' {old["count"]}/{old["total"]} ({old_rate})  {delta}'
            print(line)
    if baseline:
        print('判断翻转（所有条目、所有 flag；标记表示分数达到对应阈值）：')
        flipped = 0
        for case in cases:
            for flag in FLAGS:
                old, new = baseline['flags'][case['id']][flag], scores[case['id']][flag]
                before, after = old >= baseline['threshold'], new >= threshold
                if before != after:
                    flipped += 1
                    print(f'  {case["id"]} {flag}: {old:g} → {new:g}（{"标记" if before else "未标记"} → {"标记" if after else "未标记"}）')
        if not flipped:
            print('  无')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--threshold', type=threshold_value, default=0.5, help='标记阈值，默认 0.5')
    parser.add_argument('--from-file', type=Path, help='从 JSON 的 flags 字段读取分数，不调 Jev')
    parser.add_argument('--save-baseline', action='store_true', help='将本次分数与汇总保存为基线')
    args = parser.parse_args()
    try:
        cases = load_cases(SUITE)
        baseline_path = SUITE / 'baseline.json'
        # 保存新基线时允许覆盖旧测试集的基线；普通评分严格校验完整性。
        baseline = load_baseline(baseline_path, cases) if baseline_path.exists() and not args.save_baseline else None
        scores = validate_scores(read_json(args.from_file).get('flags'), cases) if args.from_file else run_live(cases)
        metrics = summarize(cases, scores, args.threshold)
        display(metrics, args.threshold, baseline, scores, cases)
        if args.save_baseline:
            output = {'created_at': datetime.now(timezone.utc).isoformat(), 'threshold': args.threshold,
                      'flags': scores, 'metrics': metrics}
            temporary = baseline_path.with_suffix('.json.tmp')
            temporary.write_text(json.dumps(output, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            temporary.replace(baseline_path)
            print(f'已保存基线：{baseline_path}')
        elif not baseline:
            print('尚无 baseline.json；使用 --save-baseline 保存基线。')
    except (OSError, ValueError, TypeError, AttributeError, RuntimeError) as exc:
        print(f'错误：{exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
