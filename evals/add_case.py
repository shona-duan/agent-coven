#!/usr/bin/env python3
"""将真实派活运行目录加入固定测试集。"""
import argparse
import json
from pathlib import Path
import shutil
import sys

from run_jev_screen import FLAGS, ROOT, SAFE_NAME, load_cases


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', type=Path, required=True, help='含 changes.patch、brief.txt 的运行目录')
    parser.add_argument('--expect', required=True, help='逗号分隔的 flag，或 none')
    parser.add_argument('--suite', required=True, help='evals/ 下现有套件名，如 jev-screen')
    args = parser.parse_args()
    try:
        if not SAFE_NAME.fullmatch(args.suite):
            raise ValueError('suite 必须是单个合法目录名')
        suite = ROOT / 'evals' / args.suite
        if not suite.resolve().is_relative_to((ROOT / 'evals').resolve()):
            raise ValueError('suite 必须位于 evals/ 内')
        cases = load_cases(suite, allow_empty=True)
        run = args.run.expanduser().resolve(strict=True)
        case_id = run.name
        if not SAFE_NAME.fullmatch(case_id):
            raise ValueError('运行目录名必须以英文字母或数字开头，且仅含字母、数字、下划线、点、连字符')
        if any(case['id'] == case_id for case in cases):
            raise ValueError(f'id 已存在：{case_id}')
        expect = [] if args.expect == 'none' else [flag.strip() for flag in args.expect.split(',')]
        if len(expect) != len(set(expect)) or any(flag not in FLAGS for flag in expect):
            raise ValueError(f'expect 必须是 none 或不重复的 flag：{", ".join(FLAGS)}')
        patch_source = run / 'changes.patch'
        brief = (run / 'brief.txt').read_text(encoding='utf-8').strip()
        if not brief or not patch_source.read_text(encoding='utf-8').strip():
            raise ValueError('brief.txt 和 changes.patch 均不能为空')
        patch = suite / 'patches' / (case_id + '.patch')
        case = {'id': case_id, 'brief': brief, 'patch': f'patches/{case_id}.patch',
                'expect': expect, 'source': '真实提交'}
        updated = json.dumps(cases + [case], ensure_ascii=False, indent=1) + '\n'
        # 排他创建，防止覆盖已有 patch；写 cases 失败则回滚本次复制。
        with patch.open('xb') as destination:
            try:
                with patch_source.open('rb') as source:
                    shutil.copyfileobj(source, destination)
            except Exception:
                patch.unlink()
                raise
        temporary = suite / 'cases.json.tmp'
        created_temporary = False
        try:
            with temporary.open('x', encoding='utf-8') as destination:
                created_temporary = True
                destination.write(updated)
            temporary.replace(suite / 'cases.json')
        except Exception:
            patch.unlink()
            # 仅清理本进程创建的临时文件，不删除已存在的文件。
            if created_temporary:
                temporary.unlink(missing_ok=True)
            raise
        print(f'已加入 {args.suite}：{case_id}；expect={",".join(expect) or "none"}')
    except (OSError, ValueError) as exc:
        print(f'错误：{exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
