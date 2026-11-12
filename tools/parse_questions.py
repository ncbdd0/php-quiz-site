# -*- coding: utf-8 -*-
"""
解析《PHP作业题库.docx》与《PHP作业题库答案与解析.docx》，
生成静态网站使用的 js/data.js。

用法（在工作区根目录或本目录均可）:
    python3 tools/parse_questions.py

输出:
    ../js/data.js   —— 定义全局变量 QUIZ_DATA
    parsed_debug.json —— 解析原始数据（调试用，与本脚本同目录）
"""
import json
import os
import re
import sys
from datetime import date

from docx import Document

# ---------------------------------------------------------------- 路径
HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
ROOT = os.path.dirname(SITE)

BANK_PATH = os.path.join(ROOT, "PHP作业题库.docx")
ANS_PATH = os.path.join(ROOT, "PHP作业题库答案与解析.docx")
EXT_PATH = os.path.join(ROOT, "PHP同源练习题_3套150题(1).docx")
OUT_JS = os.path.join(SITE, "js", "data.js")
OUT_JSON = os.path.join(HERE, "parsed_debug.json")

# ---------------------------------------------------------------- 正则
Q_RE = re.compile(
    r"^(\d+)\s*[\.．]\s*（(单选题|多选题|填空题)[,，]?\s*(?:([\d.]+)\s*分)?）\s*(.*)$"
)
OPT_RE = re.compile(r"^([A-H])\s*[\.\、．]\s*(.*)$")
BLANKS_RE = re.compile(r"^（共\s*(\d+)\s*空）$")

TYPE_MAP = {"单选题": "single", "多选题": "multiple", "填空题": "fill"}

# 扩展题库（同源练习题）：题面无题型标注，题型由“一、单选题”小节决定
EXT_TYPE_MAP = {"单选题": "single", "多选题": "multiple", "填空题": "fill", "编程题": "code"}
EXT_TYPE_NAME = {"single": "单选题", "multiple": "多选题", "fill": "填空题", "code": "编程题"}
EXT_SET_RE = re.compile(r"^第\s*(\d+)\s*套$")
EXT_SEC_RE = re.compile(r"^([一二三四五六七八九十]+)\s*、\s*(.+)$")
EXT_Q_RE = re.compile(r"^(\d+)\s*[\.．]\s*(.*)$")
EXT_ANS_SET_RE = re.compile(r"^第\s*(\d+)\s*套答案$")
EXT_ANS_LINE_RE = re.compile(r"^(单选题|多选题|填空题|编程题)\s*[:：]\s*(.*)$")

warnings = []


def warn(msg):
    warnings.append(msg)
    print("  [警告]", msg)


# ================================================================ 题库解析
def parse_bank():
    doc = Document(BANK_PATH)
    parts = []          # [{title, section, questions:[...]}]  section: 当前题型名
    part = None
    section = None
    cur = None          # 当前题 dict
    in_options = False

    def flush():
        nonlocal cur, in_options
        if cur is not None:
            # 选择题必须有选项；填空题选项为空
            if cur["type"] != "fill" and not cur["options"]:
                warn(f"题库 第{part['index']+1}部分 {section} 第{cur['no']}题未解析到选项")
            part["questions"].append(cur)
        cur = None
        in_options = False

    for p in doc.paragraphs:
        style = p.style.name
        text = p.text.strip()
        if not text:
            continue

        if style == "Heading 1":
            flush()
            section = None
            part = {
                "title": re.sub(r"\s+", " ", text),
                "section": None,
                "questions": [],
                "index": len(parts),
            }
            parts.append(part)
            continue

        if style == "Heading 2":
            flush()
            m = re.search(r"(单选题|多选题|填空题)", text)
            section = m.group(1) if m else None
            part["section"] = section
            continue

        if part is None or section is None:
            continue

        m = Q_RE.match(text)
        if m:
            flush()
            no = int(m.group(1))
            qtype = TYPE_MAP[m.group(2)]
            score = float(m.group(3)) if m.group(3) else None
            cur = {
                "no": no,
                "type": qtype,
                "typeName": m.group(2),
                "score": score,
                "stem": m.group(4).strip(),
                "options": [],
                "blanks": 0,
                "analysis": "",
                "answer": [],
                "srcStem": m.group(4).strip(),
            }
            continue

        if cur is None:
            continue

        mb = BLANKS_RE.match(text)
        if mb and cur["type"] == "fill":
            cur["blanks"] = int(mb.group(1))
            continue

        mo = OPT_RE.match(text)
        if mo and cur["type"] != "fill":
            cur["options"].append({"key": mo.group(1), "text": mo.group(2).strip()})
            continue

        # 普通行：选项开始后归入最后一个选项，否则归入题干
        if cur["options"]:
            cur["options"][-1]["text"] += "\n" + text
        else:
            cur["stem"] += "\n" + text

    flush()
    return parts


# ================================================================ 答案解析
def parse_answers():
    doc = Document(ANS_PATH)
    answers = {}     # (part_index, no) -> {answer_raw, analysis, stem_head}
    part_idx = -1
    cur = None       # (no, type, stem_head)
    mode = None      # 'stem' | 'answer' | 'analysis'
    buf_ans, buf_ana = [], []

    def flush():
        if cur is not None:
            answers[(part_idx, cur[0])] = {
                "type": cur[1],
                "stem_head": cur[2],
                "answer_raw": "\n".join(buf_ans).strip(),
                "analysis": "\n".join(buf_ana).strip(),
            }

    for p in doc.paragraphs:
        style = p.style.name
        text = p.text.strip()
        if not text:
            continue

        if style == "Heading 1":
            if "作业一" in text:
                flush(); cur = None; part_idx = 0; mode = None
            elif "作业二" in text:
                flush(); cur = None; part_idx = 1; mode = None
            continue

        if style == "Heading 2":
            flush(); cur = None; mode = None
            continue

        if part_idx < 0:
            continue

        m = Q_RE.match(text)
        if m:
            flush()
            cur = (int(m.group(1)), TYPE_MAP[m.group(2)], m.group(4).strip())
            mode = "stem"
            buf_ans, buf_ana = [], []
            continue

        if cur is None:
            continue

        if text.startswith("【答案】"):
            flush()
            buf_ans = [text[len("【答案】"):].strip()]
            mode = "answer"
            continue
        if text.startswith("【解析】"):
            flush()
            buf_ana = [text[len("【解析】"):].strip()]
            mode = "analysis"
            continue

        if mode == "answer":
            buf_ans.append(text)
        elif mode == "analysis":
            buf_ana.append(text)

    flush()
    return answers


def split_fill_answer(raw):
    """按“第N空：”标记拆分多空答案；无标记时返回单空列表。"""
    segs = re.split(r"第\s*(\d+)\s*空\s*[：:]\s*", raw)
    if segs and segs[0] == "" and len(segs) >= 3:
        d = {}
        for i in range(1, len(segs), 2):
            d[int(segs[i])] = segs[i + 1].strip()
        n = max(d)
        return [d.get(i, "") for i in range(1, n + 1)]
    return [raw]


# ================================================================ 扩展题库解析
def parse_ext():
    """解析《PHP同源练习题_3套150题》：题目区 + 文末参考答案区，按（套，题号）匹配。"""
    doc = Document(EXT_PATH)
    ps = doc.paragraphs

    questions = {}   # (set, no) -> q
    order = []       # [(set, no)] 保持文档顺序
    cur_set = None
    section = None
    cur = None

    def flush_q():
        nonlocal cur
        if cur is not None and cur_set is not None:
            key = (cur_set, cur["no"])
            if key in questions:
                warn(f"扩展题库 第{cur_set}套 第{cur['no']}题 重复")
            questions[key] = cur
            order.append(key)
        cur = None

    for p in ps:
        text = p.text.strip()
        if not text:
            continue
        if text == "参考答案":
            flush_q()
            break
        m = EXT_SET_RE.match(text)
        if m:
            flush_q()
            cur_set = int(m.group(1))
            section = None
            continue
        ms = EXT_SEC_RE.match(text)
        if ms:
            flush_q()
            name = ms.group(2).strip()
            section = EXT_TYPE_MAP.get(name)
            if section is None:
                warn(f"扩展题库未知题型小节: {text!r}")
            continue
        if cur_set is None or section is None:
            continue
        mq = EXT_Q_RE.match(text)
        if mq:
            flush_q()
            cur = {"no": int(mq.group(1)), "type": section,
                   "stem": mq.group(2).strip(), "options": []}
            continue
        if cur is None:
            continue
        mo = OPT_RE.match(text)
        if mo and cur["type"] in ("single", "multiple"):
            cur["options"].append({"key": mo.group(1), "text": mo.group(2).strip()})
        else:
            cur["stem"] += "\n" + text
    flush_q()

    # ---- 文末答案区 ----
    answers = {}     # (set, no) -> {type, content}
    a_set = None
    for p in ps:
        text = p.text.strip()
        if not text:
            continue
        m = EXT_ANS_SET_RE.match(text)
        if m:
            a_set = int(m.group(1))
            continue
        if a_set is None:
            continue
        ma = EXT_ANS_LINE_RE.match(text)
        if not ma:
            continue
        ttype = EXT_TYPE_MAP[ma.group(1)]
        body = ma.group(2)
        # 在“；或 ， + 数字.”处切分条目，避免切断含标点的答案内容
        items = re.split(r"[；，]\s*(?=\d+\s*[\.．])", body)
        for it in items:
            mi = re.match(r"^(\d+)\s*[\.．]\s*(.*)$", it.strip(), re.S)
            if not mi:
                if it.strip():
                    warn(f"扩展题库答案条目无法解析: {it.strip()[:40]!r}")
                continue
            key = (a_set, int(mi.group(1)))
            if key in answers:
                warn(f"扩展题库答案重复: 第{key[0]}套 第{key[1]}题")
            answers[key] = {"type": ttype, "content": mi.group(2).strip()}

    # ---- 组装 ----
    qs = []
    for (s, no) in order:
        q = questions[(s, no)]
        ans = answers.get((s, no))
        if ans is None:
            warn(f"扩展题库 第{s}套 第{no}题 未找到答案")
            ans = {"type": q["type"], "content": ""}
        if ans["type"] != q["type"]:
            warn(f"扩展题库 第{s}套 第{no}题 题型不匹配: 题={q['type']} 答案={ans['type']}")

        if q["type"] == "fill":
            contents = [ans["content"]] if ans["content"] else [""]
            runs = len(re.findall(r"_{2,}", q["stem"]))
            blanks = max(len(contents), runs)
            while len(contents) < blanks:
                contents.append(contents[-1])
            answer = contents
        elif q["type"] == "code":
            # 编程题：无法自动判分，answer 仅存参考答案文本供展示
            answer = [ans["content"] or "略"]
        else:
            answer = parse_choice_answer(ans["content"])
            if not answer:
                warn(f"扩展题库 第{s}套 第{no}题 答案无法解析: {ans['content']!r}")

        qs.append({
            "no": no,
            "set": s,
            "type": q["type"],
            "typeName": EXT_TYPE_NAME[q["type"]],
            "score": None,
            "stem": q["stem"].strip(),
            "options": q["options"],
            "blanks": len(answer) if q["type"] == "fill" else 0,
            "answer": answer,
            "analysis": "",
        })
    return {
        "id": "ext",
        "title": "扩展题库 · 同源练习题",
        "label": "扩展题库",
        "count": len(qs),
        "questions": qs,
    }


def parse_choice_answer(raw):
    seen = []
    for ch in raw.upper():
        if "A" <= ch <= "H" and ch not in seen:
            seen.append(ch)
    return seen


# ================================================================ 合并
def norm_stem(s):
    return re.sub(r"\s+", "", s)


def merge(bank_parts, answers):
    """合并题库与答案。答案一律取自答案文档【答案】原文，不做任何人工改动。"""
    out_parts = []
    matched = 0
    stem_mismatch = 0
    for bi, part in enumerate(bank_parts):
        part_id = "p%d" % (bi + 1)
        part_label = "第%s部分" % ("一二"[bi] if bi < 2 else str(bi + 1))
        qs = []
        for q in part["questions"]:
            key = (bi, q["no"])
            ans = answers.get(key)
            if ans is None:
                warn(f"第{bi+1}部分 第{q['no']}题 未找到答案")
                ans = {"answer_raw": "", "analysis": "", "stem_head": ""}

            # 题干一致性抽查：题库题干 与 答案文档题干 前10字比对（防编号错位）
            a_head = norm_stem(ans.get("stem_head", ""))[:10]
            b_head = norm_stem(q["stem"])[:10]
            if a_head and b_head and a_head != b_head:
                stem_mismatch += 1
                warn(f"第{bi+1}部分 第{q['no']}题 题干前缀不一致: 题库{b_head!r} vs 答案{a_head!r}")
            q.pop("srcStem", None)

            if q["type"] == "fill":
                answer = split_fill_answer(ans["answer_raw"]) if ans["answer_raw"] else [""]
                # 填空题空格数以答案文档为准（第N空数量；单答案即1空）
                q["blanks"] = len(answer)
            else:
                answer = parse_choice_answer(ans["answer_raw"])
                if not answer:
                    warn(f"第{bi+1}部分 第{q['no']}题 答案无法解析: {ans['answer_raw']!r}")

            qs.append({
                "no": q["no"],
                "type": q["type"],
                "typeName": q["typeName"],
                "score": q["score"],
                "stem": q["stem"].strip(),
                "options": q["options"],
                "blanks": q["blanks"],
                "answer": answer,
                "analysis": ans["analysis"],
            })
            matched += 1
        out_parts.append({
            "id": part_id,
            "title": part["title"],
            "label": part_label,
            "count": len(qs),
            "questions": qs,
        })
    if stem_mismatch == 0:
        print("题干一致性抽查: 322 题全部与答案文档一致")
    return out_parts, matched


# ================================================================ 校验
def validate(parts):
    print("\n===== 数据校验 =====")
    total = 0
    expect = [("第一部分", {"single": 50, "multiple": 32}),
              ("第二部分", {"single": 120, "fill": 120}),
              ("扩展题库", {"single": 60, "multiple": 15, "fill": 45, "code": 30})]
    for i, part in enumerate(parts):
        types = {}
        for q in part["questions"]:
            types[q["type"]] = types.get(q["type"], 0) + 1
        total += len(part["questions"])
        print(f"{part['title']}: 共{len(part['questions'])}题  {types}")

        for q in part["questions"]:
            if q["type"] in ("single", "multiple"):
                if len(q["options"]) != 4:
                    warn(f"第{i+1}部分 第{q['no']}题 选项数={len(q['options'])}")
                if not q["answer"]:
                    warn(f"第{i+1}部分 第{q['no']}题 无答案")
                for a in q["answer"]:
                    if not any(o["key"] == a for o in q["options"]):
                        warn(f"第{i+1}部分 第{q['no']}题 答案{a}不在选项中")
                if q["type"] == "single" and len(q["answer"]) != 1:
                    warn(f"第{i+1}部分 第{q['no']}题 单选答案数={len(q['answer'])}")
            elif q["type"] == "code":
                if not q["answer"] or not q["answer"][0]:
                    warn(f"第{i+1}部分 第{q['no']}题 编程题缺少参考答案")
            else:  # fill
                runs = len(re.findall(r"_{2,}", q["stem"]))
                n = len(q["answer"])
                if runs and runs != n:
                    print(f"  [提示] 第{i+1}部分 第{q['no']}题 题干下划线{runs}处 与答案{n}空 不一致，作答界面将改用编号输入框")
                for a in q["answer"]:
                    if "或" in a:
                        print(f"  [提示] 填空答案含“或”，判分时按多答案匹配: 第{q['no']}题 {a!r}")
        exp = expect[i][1] if i < len(expect) else {}
        for t, c in exp.items():
            if types.get(t, 0) != c:
                warn(f"第{i+1}部分 {t} 数量 {types.get(t,0)} != 预期 {c}")
    print(f"总题数: {total} (预期 472)")
    if total != 472:
        warn("总题数不为 472")


# ================================================================ 主流程
def main():
    bank = parse_bank()
    print(f"题库解析: {len(bank)} 个部分")
    answers = parse_answers()
    print(f"答案解析: {len(answers)} 条")

    parts, matched = merge(bank, answers)
    print(f"主题库合并: {matched} 题")

    if os.path.exists(EXT_PATH):
        ext = parse_ext()
        print(f"扩展题库: {ext['count']} 题（{ext['title']}）")
        parts.append(ext)
    else:
        print("[提示] 未找到扩展题库文档，跳过")

    validate(parts)

    data = {
        "generatedAt": date.today().isoformat(),
        "source": ["PHP作业题库.docx", "PHP作业题库答案与解析.docx"],
        "parts": parts,
    }

    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)

    js = ("// 本文件由 tools/parse_questions.py 自动生成，请勿手工编辑\n"
          "// 生成日期: " + data["generatedAt"] + "\n"
          "const QUIZ_DATA = " + json.dumps(data, ensure_ascii=False, indent=1) + ";\n")
    with open(OUT_JS, "w", encoding="utf-8") as f:
        f.write(js)

    print(f"\n已生成: {OUT_JS}")
    print(f"警告总数: {len(warnings)}")


if __name__ == "__main__":
    main()
