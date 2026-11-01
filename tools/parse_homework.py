#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""parse_homework.py —— 课后作业与实验 markdown → js/homework.js

输入：仓库上一级目录 作业实验代码答案md/*.md（9 篇：3 份作业 + 6 份实验）
输出：php-quiz-site/js/homework.js（明文，仅本地；由 encrypt_data.py 加密后入库）

数据模型（与 notes.js 块结构兼容）：
  window.HOMEWORK_DATA = {
    groups: [{id, name, kind}],
    items: [{
      id, kind, group, title, problem, codes,
      blocks: [{t:'h2'|'p'|'code'|'list', x, ...}]
    }]
  }
每篇 item 必须含答案代码（codes ≥ 1），解析时强制校验。
"""
import glob
import html
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC_DIR = os.path.join(os.path.dirname(ROOT), '作业实验代码答案md')
OUT_PATH = os.path.join(ROOT, 'js', 'homework.js')

# 文件名 → (组, 排序号, 展示标题可覆盖)
FILE_ORDER = [
    'homework1_环境安装与第一个PHP程序.md',
    'homework2_二维数组购物车.md',
    'no3_homework_批量删除数据库记录.md',
    '实验一_PHP数组操作.md',
    '实验二_嵌入PHP与预定义变量.md',
    '实验三_表单读取与函数调用.md',
    '实验四_数据库分页查询ex5.md',
    '实验4补充_正则_文件投票_日期计算.md',
    '实验六_Ajax用户名校验.md',
]

GROUPS = [
    {'id': 'hw', 'name': '课后作业', 'kind': 'homework'},
    {'id': 'lab', 'name': '实验', 'kind': 'lab'},
]

# 个别文档没有"> 题目："引用行，按其小节标题合成题目卡（正文原样完整呈现）
PROBLEM_FALLBACK = {
    '实验二_嵌入PHP与预定义变量.md':
        '共 3 个小题：① 在表单文本框中嵌入 PHP 变量（ex2_1.php）；② 判断随机年份是否闰年（ex2_2.php）；③ 输出 $_SERVER 预定义变量表格（ex2_3.php）。',
    '实验4补充_正则_文件投票_日期计算.md':
        '共 3 个小题：① 正则表达式校验邮箱；② 文件投票统计（voteresult.txt 读写）；③ 日期计算年龄。',
}


def md_inline(s: str) -> str:
    """markdown 行内格式 → 受限 HTML（先转义再转换，安全）"""
    s = html.escape(s, quote=False)
    s = re.sub(r'`([^`]+)`', r'<code>\1</code>', s)
    s = re.sub(r'\*\*([^*]+)\*\*', r'<b>\1</b>', s)
    return s


def parse_md(path: str):
    """解析一篇 md → (title, problem, blocks)"""
    lines = open(path, encoding='utf-8').read().split('\n')
    title = ''
    problem = ''
    blocks = []
    para = []       # 连续普通行
    listing = []    # 连续列表行

    def flush_para():
        nonlocal para
        if para:
            blocks.append({'t': 'p', 'x': md_inline('\n'.join(para)).strip()})
            para = []

    def flush_list():
        nonlocal listing
        if listing:
            blocks.append({'t': 'list', 'x': [md_inline(re.sub(r'^(\s*[-*]|\s*\d+[.、])\s*', '', l)).strip() for l in listing]})
            listing = []

    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        # 代码围栏
        m = re.match(r'^```\s*(\w*)\s*$', stripped)
        if m:
            flush_para(); flush_list()
            lang = m.group(1) or 'text'
            code = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith('```'):
                code.append(lines[i])
                i += 1
            blocks.append({'t': 'code', 'lang': lang.lower(), 'x': '\n'.join(code)})
            i += 1
            continue
        if not stripped:
            flush_para(); flush_list()
            i += 1
            continue
        if stripped.startswith('# '):
            flush_para(); flush_list()
            title = stripped[2:].strip()
            i += 1
            continue
        if stripped.startswith('## ') or stripped.startswith('### '):
            flush_para(); flush_list()
            blocks.append({'t': 'h2', 'x': re.sub(r'^#+\s*', '', stripped)})
            i += 1
            continue
        if stripped.startswith('>'):
            flush_para(); flush_list()
            quote = stripped.lstrip('>').strip()
            if not problem:
                problem = quote   # 首个引用行 = 题目/说明
            else:
                blocks.append({'t': 'p', 'x': '<i>' + md_inline(quote) + '</i>'})
            i += 1
            continue
        if re.match(r'^\s*([-*]|\d+[.、])\s+', line):
            flush_para()
            listing.append(line)
            i += 1
            continue
        flush_list()
        para.append(stripped)
        i += 1
    flush_para(); flush_list()
    return title, problem, blocks


def classify(fname: str):
    """文件名 → (group_id, kind, sort_key)"""
    if 'homework' in fname.lower():
        return 'hw', 'homework'
    return 'lab', 'lab'


def main():
    items = []
    for idx, fname in enumerate(FILE_ORDER):
        path = os.path.join(SRC_DIR, fname)
        if not os.path.exists(path):
            print(f'!! 缺少 {fname}', file=sys.stderr)
            continue
        title, problem, blocks = parse_md(path)
        gid, kind = classify(fname)
        problem = problem or PROBLEM_FALLBACK.get(fname, '')
        codes = sum(1 for b in blocks if b['t'] == 'code')
        if codes < 1:
            raise SystemExit(f'{fname} 不含答案代码块，违反"每篇必须含答案代码"要求')
        items.append({
            'id': f'{"hw" if kind == "homework" else "lab"}{idx + 1}',
            'kind': kind,
            'group': gid,
            'title': title,
            'problem': problem,
            'codes': codes,
            'blocks': blocks,
        })

    data = {
        'generatedAt': '2026-11-01',
        'source': '作业实验代码答案md（课后作业与实验文档）',
        'groups': GROUPS,
        'items': items,
    }

    banner = ('/* 由 tools/parse_homework.py 自动生成，勿手改；源：课后作业与实验文档（9 篇） */\n')
    payload = 'window.HOMEWORK_DATA = ' + json.dumps(data, ensure_ascii=False, indent=1) + ';\n'
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        f.write(banner + payload)

    print(f'已生成 {OUT_PATH}')
    for it in items:
        print(f"  [{it['kind']:8s}] {it['title']} | 题目:{'√' if it['problem'] else '—'} | 代码块:{it['codes']} | 块:{len(it['blocks'])}")
    n_hw = sum(1 for it in items if it['kind'] == 'homework')
    n_lab = sum(1 for it in items if it['kind'] == 'lab')
    print(f'共 {len(items)} 篇（作业 {n_hw} + 实验 {n_lab}），答案代码块 {sum(i["codes"] for i in items)} 个')


if __name__ == '__main__':
    main()
