#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""merge_final.py —— 合并各 subagent 出的章节押题 JSON → tools/final_chapters.json

输入：tools/_final_raw/*.json（每个文件是一个章节数组）
输出：tools/final_chapters.json（按章节顺序排列、已校验）
校验：题型配额、选项结构、填空单空、答案非空、章节唯一。
"""
import glob
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, '_final_raw')
OUT = os.path.join(HERE, 'final_chapters.json')

# 章节顺序（按课程教材）
ORDER = ['第0章', '第1章', '第2章', '第3章', '第4章', '第5章', '第6章',
         '第7章', '第8章', '第9-10章', '第11章', '第12章', '第13章']

EXPECT = {
    '第0章': {'single': 8, 'multiple': 4, 'fill': 4, 'short': 2, 'code': 2},
    '第1章': {'single': 8, 'multiple': 4, 'fill': 4, 'short': 2, 'code': 2},
    '第2章': {'single': 8, 'multiple': 4, 'fill': 4, 'short': 2, 'code': 2},
    '第3章': {'single': 8, 'multiple': 4, 'fill': 4, 'short': 2, 'code': 2},
    '第4章': {'single': 8, 'multiple': 4, 'fill': 4, 'short': 2, 'code': 2},
    '第5章': {'single': 8, 'multiple': 4, 'fill': 4, 'short': 2, 'code': 2},
    '第6章': {'single': 8, 'multiple': 4, 'fill': 4, 'short': 2, 'code': 2},
    '第7章': {'single': 8, 'multiple': 4, 'fill': 4, 'short': 2, 'code': 2},
    '第8章': {'single': 8, 'multiple': 4, 'fill': 4, 'short': 2, 'code': 2},
    '第9-10章': {'single': 10, 'multiple': 4, 'fill': 4, 'short': 2, 'code': 2},
    '第11章': {'single': 10, 'multiple': 4, 'fill': 4, 'short': 2, 'code': 2},
    '第12章': {'single': 10, 'multiple': 4, 'fill': 4, 'short': 2, 'code': 2},
    '第13章': {'single': 10, 'multiple': 4, 'fill': 4, 'short': 2, 'code': 2},
}


def load_json(path):
    txt = open(path, encoding='utf-8').read().strip()
    # 去掉可能的 ```json 围栏
    m = re.search(r'```(?:json)?\s*([\s\S]*?)```', txt)
    if m:
        txt = m.group(1).strip()
    return json.loads(txt)


def norm_chapter_name(name):
    name = str(name).strip()
    m = re.match(r'(第[0-9\-—]+章)', name)
    return m.group(1).replace('—', '-') if m else name


def validate(ch):
    errs = []
    name = norm_chapter_name(ch.get('chapter', ''))
    qs = ch.get('questions', [])
    cnt = {}
    for i, q in enumerate(qs):
        tag = f"{name} 第{i+1}题"
        t = q.get('type')
        cnt[t] = cnt.get(t, 0) + 1
        if t not in ('single', 'multiple', 'fill', 'short', 'code'):
            errs.append(f'{tag}: 未知题型 {t}')
            continue
        stem = q.get('stem', '')
        if not stem.strip():
            errs.append(f'{tag}: 题干为空')
        if not q.get('analysis'):
            errs.append(f'{tag}: 缺解析')
        ans = q.get('answer')
        if not isinstance(ans, list) or not ans or not all(isinstance(a, str) and a.strip() for a in ans):
            errs.append(f'{tag}: 答案为空或格式错误')
            continue
        if t == 'single':
            opts = q.get('options') or []
            if len(opts) != 4:
                errs.append(f'{tag}: 单选题选项数 {len(opts)}≠4')
            if len(ans) != 1 or ans[0] not in 'ABCD':
                errs.append(f'{tag}: 单选题答案 {ans}')
        elif t == 'multiple':
            opts = q.get('options') or []
            if not (4 <= len(opts) <= 5):
                errs.append(f'{tag}: 多选题选项数 {len(opts)} 不在 4-5')
            if not (2 <= len(ans) <= 4) or any(a not in 'ABCDE' for a in ans):
                errs.append(f'{tag}: 多选题答案 {ans}')
            if len(set(ans)) != len(ans):
                errs.append(f'{tag}: 多选答案重复 {ans}')
        elif t == 'fill':
            if len(re.findall(r'_{4,}', stem)) != 1:
                errs.append(f'{tag}: 填空下划线不是恰好一个')
            if len(ans) != 1:
                errs.append(f'{tag}: 填空答案应为 1 项，实际 {len(ans)}')
        # short / code：答案段已校验非空
        for a in ans:
            if len(a) > 4000:
                errs.append(f'{tag}: 答案段过长')
    exp = EXPECT.get(name)
    if exp:
        got = {k: cnt.get(k, 0) for k in exp}
        if got != exp:
            errs.append(f'{name}: 题型配额不符，期望 {exp}，实际 {got}')
    return errs


def main():
    files = sorted(glob.glob(os.path.join(RAW, '*.json')))
    if not files:
        sys.exit('没有找到 tools/_final_raw/*.json')
    chapters = {}
    for f in files:
        data = load_json(f)
        if isinstance(data, dict):
            data = [data]
        for ch in data:
            name = norm_chapter_name(ch.get('chapter', ''))
            if name in chapters:
                sys.exit(f'章节重复：{name}（{f}）')
            chapters[name] = ch

    missing = [n for n in ORDER if n not in chapters]
    extra = [n for n in chapters if n not in ORDER]
    if missing:
        sys.exit(f'缺少章节：{missing}')
    if extra:
        sys.exit(f'多余章节：{extra}')

    all_errs = []
    for name in ORDER:
        all_errs += validate(chapters[name])

    if all_errs:
        print(f'校验失败 {len(all_errs)} 项：', file=sys.stderr)
        for e in all_errs[:60]:
            print('  ✗', e, file=sys.stderr)
        sys.exit(1)

    out = []
    for name in ORDER:
        ch = chapters[name]
        ch['chapter'] = name
        out.append({
            'chapter': name,
            'title': ch.get('title') or name,
            'questions': ch['questions'],
        })
    json.dump(out, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

    total = sum(len(c['questions']) for c in out)
    print(f'已合并 {len(out)} 章 / {total} 题 → {OUT}')
    for c in out:
        cnt = {}
        for q in c['questions']:
            cnt[q['type']] = cnt.get(q['type'], 0) + 1
        print(f"  {c['chapter']}: {len(c['questions'])} 题 ({cnt})")


if __name__ == '__main__':
    main()
