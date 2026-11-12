#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_final.py —— 生成「期末预测扩展」题库并追加到 js/data.js

依据老师通知的期末题型：单选、多选、填空、简答、程序设计题。
知识点来源：
  · homework4 = 原题库第一部分 no4.homework（82 题：单选50 + 多选32）
  · homework6 = 原题库第二部分 no6 homework（240 题：单选120 + 填空120）
    —— 提取这两个模块的全部题干考点（基础语法/函数/数组/字符串/文件/日期/正则/
       MySQL/表单/Cookie与Session/Ajax/面向对象），结合课程 PPT 扩展出题
  · 课程 PPT（第2章开发基础、第6章Web互动、第8章字符串、第10章MySQL、第11章会话控制、第13章Ajax）
出题要求：必含老师给定 4 道例题（AJAX GET / GET+isset+trim / Ajax交互步骤 / echo与print）。

简答(short)与程序设计(code)为自评题：不自动判分、不入错题本、不计正确率。
answer 约定：段落直接存字符串；以 "CODE::" 开头的段渲染为代码块。
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, 'js', 'data.js')

CODE = 'CODE::\n'

# ---------------- 题目数据 ----------------
# 题库明文不进入仓库：综合押题的 35 道题单独保存在 tools/final_comprehensive.json
# （已列入 .gitignore），此处仅负责读取与组装。
COMPREHENSIVE_JSON = os.path.join(HERE, 'final_comprehensive.json')


def load_comprehensive():
    if not os.path.exists(COMPREHENSIVE_JSON):
        raise SystemExit('缺少 tools/final_comprehensive.json（综合押题题目数据，本地明文，不入库）')
    d = json.load(open(COMPREHENSIVE_JSON, encoding='utf-8'))
    return d['single'], d['multiple'], d['fill'], d['short'], d['code']


def q(no, t, data):
    q = {'no': no, 'type': t, 'typeName': {'single': '单选题', 'multiple': '多选题', 'fill': '填空题', 'short': '简答题', 'code': '程序设计题'}[t]}
    q['stem'] = data['stem']
    if t in ('single', 'multiple'):
        letters = ['A', 'B', 'C', 'D']
        q['options'] = [{'key': letters[i], 'text': o} for i, o in enumerate(data['options'])]
    q['answer'] = data['answer']
    q['analysis'] = data['analysis']
    return q


def build_comprehensive_part():
    """期末综合押题（跨章综合 + 老师给定 4 道必含例题）"""
    singles, multiples, fills, shorts, codes = load_comprehensive()
    questions = []
    n = 1
    for t, group in (('single', singles), ('multiple', multiples), ('fill', fills), ('short', shorts), ('code', codes)):
        for d in group:
            questions.append(q(n, t, d))
            n += 1
    return {
        'id': 'final13',
        'title': '期末押题 · 综合（必含例题）',
        'label': '期末押题 · 综合',
        'count': len(questions),
        'questions': questions,
    }


def load_chapters():
    """读取 tools/final_chapters.json（由出题合并脚本生成）→ 各章 part 列表"""
    path = os.path.join(HERE, 'final_chapters.json')
    if not os.path.exists(path):
        print('!! 缺少 tools/final_chapters.json，仅生成综合押题部分', file=__import__('sys').stderr)
        return []
    chapters = json.load(open(path, encoding='utf-8'))
    parts = []
    for i, ch in enumerate(chapters):
        qs = []
        n = 1
        for d in ch['questions']:
            t = d['type']
            qq = {'no': n, 'type': t, 'typeName': {'single': '单选题', 'multiple': '多选题', 'fill': '填空题', 'short': '简答题', 'code': '程序设计题'}[t]}
            qq['stem'] = d['stem']
            if t in ('single', 'multiple'):
                letters = ['A', 'B', 'C', 'D', 'E']
                qq['options'] = [{'key': letters[j], 'text': o} for j, o in enumerate(d['options'])]
            qq['answer'] = d['answer']
            qq['analysis'] = d['analysis']
            qs.append(qq)
            n += 1
        parts.append({
            'id': 'final%d' % i,
            'title': ch['title'],
            'label': ch['title'],
            'count': len(qs),
            'questions': qs,
        })
    return parts


def main():
    src = open(DATA, encoding='utf-8').read()
    # 提取 QUIZ_DATA JSON
    m = __import__('re').search(r'(?:const\s+)?(?:window\.)?QUIZ_DATA\s*=\s*', src)
    start = src.index('{', m.end())
    depth = 0
    for i in range(start, len(src)):
        if src[i] == '{':
            depth += 1
        elif src[i] == '}':
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    data = json.loads(src[start:end])

    # 幂等：去掉旧的 final 部分（final / final0..final13）
    data['parts'] = [p for p in data['parts'] if not str(p.get('id', '')).startswith('final')]
    parts = load_chapters() + [build_comprehensive_part()]
    data['parts'].extend(parts)

    # 重新写回（保持 const QUIZ_DATA 头注释）
    head = src[:start]
    body = json.dumps(data, ensure_ascii=False, indent=1)
    tail = src[end:]
    with open(DATA, 'w', encoding='utf-8') as f:
        f.write(head + body + tail)

    total = 0
    counts = {}
    for part in parts:
        total += part['count']
        for qq in part['questions']:
            counts[qq['type']] = counts.get(qq['type'], 0) + 1
        print(f"  [{part['id']}] {part['title']}：{part['count']} 题")
    print(f"期末押题共 {len(parts)} 个模块 / {total} 题 → {js_data_summary(counts)}")


def js_data_summary(counts):
    m = {'single': '单选', 'multiple': '多选', 'fill': '填空', 'short': '简答', 'code': '程序设计'}
    return ' · '.join(f"{m[k]} {v}" for k, v in counts.items())


if __name__ == '__main__':
    main()
