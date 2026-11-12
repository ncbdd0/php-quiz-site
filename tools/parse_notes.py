#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
parse_notes.py — 解析《PHP期末精简学习笔记_按题库重排.docx》→ js/notes.js

输出结构：
window.NOTES_DATA = {
  title, subtitle,
  intro: { usage: [...], mainline: [...] },     // 前言两节
  chapters: [{
    id, title, kind: 'chapter'|'appendix',
    blocks: [ {t:'h2'|'p'|'code'|'table', ...} ],
    landingRaw: '题库落点…', pitfallsRaw: '易错点…',
    refs: { p1:[no...], p2single:[no...], p2fill:[no...], ext:[no...] }
  }]
}

题号映射规则：以各章正文“题库落点：”段落为准。
  no6 单选 → 第2部分 single 的原卷题号；no6 填空 → 第2部分 fill；no4 第X题 → 第1部分。
已知冲突仲裁（文档表1与正文均把 no6 单选 51–60 同时写给第0/6章）：
  按题目实际内容逐题拆分——HTML 表单属性题归第0章，PHP 侧（超全局变量/上传/编码函数）归第6章；
  填空 171–180 中仅 176（<select> 标签属性）归第0章，其余归第6章。
run 数 ≠ 空数等文档口径问题不影响此处（仅按原卷题号挂章节）。
"""
import json
import re
import sys

import docx
from docx.document import Document as _Doc
from docx.table import Table
from docx.text.paragraph import Paragraph
from docx.oxml.ns import qn

DOC_PATH = 'PHP期末精简学习笔记_按题库重排.docx'
OUT_PATH = 'php-quiz-site/js/notes.js'

# —— 51–60 / 171–180 冲突仲裁表（逐题人工判定，依据原卷题干内容）——
OVERRIDE = {
    'c0': {'p2single': [51, 52, 53, 55, 59, 60], 'p2fill': [176]},
    'c6': {'p2single': [54, 56, 57, 58],
           'p2fill': [171, 172, 173, 174, 175, 177, 178, 179, 180]},
    # 文档缝隙修补：第1章落点 1–10 与第2章 12–20 之间漏掉单选 11
    #（题干"PHP语句块需要使用( )符号包含"= 标记风格，第1章正文主题）
    'c1': {'p2single': [11]},
}
# 这两章落点行里与冲突相关的组不参与自动解析
SKIP_RANGES = {('c0', 'p2single'), ('c0', 'p2fill'), ('c6', 'p2single'), ('c6', 'p2fill')}


def iter_body(doc):
    """按文档顺序迭代段落与表格"""
    body = doc.element.body
    for child in body.iterchildren():
        if child.tag == qn('w:p'):
            yield Paragraph(child, doc)
        elif child.tag == qn('w:tbl'):
            yield Table(child, doc)


def expand_tokens(s):
    """'1–10' / '172、174–176' → [1..10, 172, 174, 175, 176]"""
    out = []
    for tok in re.split(r'[、，,]', s):
        tok = tok.strip()
        if not tok:
            continue
        m = re.match(r'^(\d+)\s*[–\-—~至]\s*(\d+)$', tok)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            out.extend(range(min(a, b), max(a, b) + 1))
        elif re.match(r'^\d+$', tok):
            out.append(int(tok))
    return out


def parse_landing(text):
    """解析 '题库落点：…' → refs dict"""
    refs = {'p1': [], 'p2single': [], 'p2fill': [], 'ext': []}
    cur = None  # 当前 noX 上下文
    # 逐段扫描：no6 单选 …、填空 …；no4 的第 …题
    pos = 0
    pattern = re.compile(r'no(\d+)|(单选)|(填空)|第\s*([\d、\s]+?)\s*题|([\d][\d、，,\s–\-—~]*[\d])')
    while pos < len(text):
        m = pattern.search(text, pos)
        if not m:
            break
        if m.group(1):            # noX —— 判断后接的是单选还是填空还是"的第..题"
            n = int(m.group(1))
            tail = text[m.end():m.end() + 12]
            if n == 4:
                cur = 'p1'
            elif n == 6:
                cur = 'p2'
            elif n == 3:
                cur = 'ext'
            else:
                cur = None
            pos = m.end()
        elif m.group(2):          # 单选
            if cur == 'p2':
                nxt = text[m.end():]
                mm = re.match(r'\s*([\d][\d、，,\s–\-—~]*[\d])', nxt)
                if mm:
                    refs['p2single'].extend(expand_tokens(mm.group(1)))
                    pos = m.end() + mm.end()
                    continue
            pos = m.end()
        elif m.group(3):          # 填空
            if cur == 'p2':
                nxt = text[m.end():]
                mm = re.match(r'\s*([\d][\d、，,\s–\-—~]*[\d])', nxt)
                if mm:
                    refs['p2fill'].extend(expand_tokens(mm.group(1)))
                    pos = m.end() + mm.end()
                    continue
            pos = m.end()
        elif m.group(4):          # 第 X、Y、Z 题（no4 上下文）
            if cur == 'p1':
                refs['p1'].extend(expand_tokens(m.group(4)))
            pos = m.end()
        else:                     # 裸数字组（延续上下文，如 no6 后再出现 "81–90"）
            if cur == 'p2':
                # 判断最近的题型关键词
                before = text[max(0, pos - 40):m.start()]
                if '单选' in before.split('填空')[-1]:
                    refs['p2single'].extend(expand_tokens(m.group(5)))
                elif '填空' in before:
                    refs['p2fill'].extend(expand_tokens(m.group(5)))
            pos = m.end()
    # 去重保序
    for k in refs:
        seen, dedup = set(), []
        for n in refs[k]:
            if n not in seen:
                seen.add(n)
                dedup.append(n)
        refs[k] = dedup
    return refs


def main():
    doc = docx.Document(DOC_PATH)
    data = {'title': '', 'subtitle': '', 'intro': {'usage': [], 'mainline': []}, 'chapters': []}

    chapter = None          # 当前章 dict
    mode = None             # None | 'usage' | 'mainline' | 'toc'
    chapter_index = 0
    appendix_index = 0

    for item in iter_body(doc):
        if isinstance(item, Paragraph):
            t = item.text.strip()
            if not t:
                continue
            style = item.style.name if item.style else ''
            if style == 'Heading 1':
                if t.startswith('第') and '章' in t[:8]:
                    cid = 'c%d' % chapter_index
                    chapter_index += 1
                    chapter = {'id': cid, 'title': t, 'kind': 'chapter',
                               'blocks': [], 'landingRaw': '', 'pitfallsRaw': '', 'refs': {}}
                    data['chapters'].append(chapter)
                    mode = None
                elif t.startswith('附录'):
                    cid = 'c%s' % chr(ord('a') + appendix_index)
                    appendix_index += 1
                    chapter = {'id': cid, 'title': t, 'kind': 'appendix',
                               'blocks': [], 'landingRaw': '', 'pitfallsRaw': '', 'refs': {}}
                    data['chapters'].append(chapter)
                    mode = None
                elif '怎么用' in t:
                    chapter, mode = None, 'usage'
                elif '全书主线' in t:
                    chapter, mode = None, 'mainline'
                elif '目录' in t:
                    chapter, mode = None, 'toc'
                continue
            if style == 'Heading 2':
                if chapter:
                    chapter['blocks'].append({'t': 'h2', 'x': t})
                continue
            # 普通段落
            if mode == 'usage':
                data['intro']['usage'].append(t)
            elif mode == 'mainline':
                data['intro']['mainline'].append(t)
            elif mode == 'toc':
                pass  # 目录表运行时自生成
            elif chapter is not None:
                if t.startswith('题库落点'):
                    chapter['landingRaw'] = t
                elif t.startswith('易错点'):
                    chapter['pitfallsRaw'] = t
                else:
                    chapter['blocks'].append({'t': 'p', 'x': t})
        else:  # Table
            rows = len(item.rows)
            cols = len(item.columns)
            if chapter is None or mode is not None:
                continue
            if rows == 1 and cols == 1:
                code = item.rows[0].cells[0].text
                if code.strip():
                    chapter['blocks'].append({'t': 'code', 'x': code.rstrip()})
            else:
                head = [c.text.strip() for c in item.rows[0].cells]
                body = [[c.text.strip() for c in r.cells] for r in item.rows[1:]]
                chapter['blocks'].append({'t': 'table', 'head': head, 'rows': body})

    if not data['title']:
        data['title'] = 'PHP 程序设计期末精简学习笔记'
        data['subtitle'] = '按作业题库重排的章节连贯版'

    # —— refs 解析与冲突仲裁 ——
    for ch in data['chapters']:
        if ch['kind'] != 'chapter' or not ch['landingRaw']:
            ch['refs'] = {'p1': [], 'p2single': [], 'p2fill': [], 'ext': []}
            continue
        refs = parse_landing(ch['landingRaw'])
        key = ch['id']
        if key in OVERRIDE:
            for grp, nos in OVERRIDE[key].items():
                if (key, grp) in SKIP_RANGES:
                    # 冲突组：文档把同一批题号写给两章，以人工仲裁结果直接替换
                    refs[grp] = nos
                else:
                    # 缝隙修补组：与自动解析结果合并去重
                    refs[grp] = list(dict.fromkeys(nos + refs[grp]))
        ch['refs'] = refs

    # —— 输出 ——
    js = '/* 由 tools/parse_notes.py 自动生成，请勿手改；源：《%s》 */\n' % DOC_PATH
    js += 'window.NOTES_DATA = ' + json.dumps(data, ensure_ascii=False, indent=1) + ';\n'
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        f.write(js)

    # —— 摘要 ——
    total_refs = 0
    print('章节数:', len(data['chapters']))
    for ch in data['chapters']:
        refs = ch['refs']
        n = len(refs.get('p1', [])) + len(refs.get('p2single', [])) + len(refs.get('p2fill', [])) + len(refs.get('ext', []))
        total_refs += n
        blocks = len(ch['blocks'])
        print('  %s %s | 块:%d | 关联题:%d (p1=%d 单选=%d 填空=%d)' % (
            ch['id'], ch['title'][:22], blocks, n,
            len(refs.get('p1', [])), len(refs.get('p2single', [])), len(refs.get('p2fill', []))))
    print('关联题总数(去重前):', total_refs)


if __name__ == '__main__':
    sys.exit(main())
