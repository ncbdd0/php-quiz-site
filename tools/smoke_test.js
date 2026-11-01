/* ============================================================
 * 冒烟测试：node tools/smoke_test.js
 * 校验 data.js 数据完整性 + core.js 判分/渲染逻辑 + 页面元素引用一致性
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let failed = 0;

function ok(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ ' + msg); }
}

/* ---------- 加载 data.js ---------- */
const dataSrc = fs.readFileSync(path.join(ROOT, 'js', 'data.js'), 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(dataSrc + '\nglobalThis.__Q = QUIZ_DATA;', sandbox);
const D = sandbox.__Q;
const C = require(path.join(ROOT, 'js', 'core.js'));

console.log('== 数据完整性 ==');
const allQ = [];
D.parts.forEach(p => p.questions.forEach(q => allQ.push(q)));
ok(D.parts.length === 3, '共 3 个题库部分');
ok(allQ.length === 472, '总题数 472（实际 ' + allQ.length + '）');
const byType = {};
allQ.forEach(q => byType[q.type] = (byType[q.type] || 0) + 1);
ok(byType.single === 230 && byType.multiple === 47 && byType.fill === 165 && byType.code === 30,
  '题型分布 单选230/多选47/填空165/编程30（实际 ' + byType.single + '/' + byType.multiple + '/' + byType.fill + '/' + byType.code + '）');
ok(D.parts[0].questions.length === 82 && D.parts[1].questions.length === 240 && D.parts[2].questions.length === 150,
  '各部分 82 / 240 / 150 题');
ok(D.parts[2].id === 'ext' && D.parts[0].id === 'p1' && D.parts[1].id === 'p2', '部分 id 正确');
ok(D.parts.every(p => p.label && p.title), '各部分都有 label 与 title');

/* 编号唯一且连续（主题库） */
[0, 1].forEach(i => {
  const nos = D.parts[i].questions.map(q => q.no);
  ok(new Set(nos).size === nos.length, '第' + (i + 1) + '部分编号无重复');
  ok(nos.every((n, idx) => n === idx + 1), '第' + (i + 1) + '部分编号连续 1..' + nos.length);
});
/* 扩展题库：每套内编号 1..50 连续且（套，题号）唯一 */
{
  const ext = D.parts[2];
  const keys = ext.questions.map(q => q.set + '-' + q.no);
  ok(new Set(keys).size === keys.length, '扩展题库（套，题号）无重复');
  ok(ext.questions.every(q => q.set >= 1 && q.set <= 3 && q.no >= 1 && q.no <= 50), '扩展题库题号在 1..50、套在 1..3');
  [1, 2, 3].forEach(s => {
    const cnt = ext.questions.filter(q => q.set === s).length;
    if (cnt !== 50) { failed++; console.error('  ✗ 扩展题库第' + s + '套题数 ' + cnt + ' != 50'); }
    else console.log('  ✓ 扩展题库第' + s + '套 50 题');
  });
}

/* 选择题答案合法 */
let badAns = 0, badOpt = 0, noAna = 0;
allQ.forEach(q => {
  if (typeof q.analysis !== 'string') noAna++;
  if (q.type === 'code') {
    if (!Array.isArray(q.answer) || !q.answer[0]) badAns++;      /* 编程题答案文本供展示 */
  } else if (q.type === 'fill') {
    if (!Array.isArray(q.answer) || q.answer.length < 1) badAns++;
    else q.answer.forEach(a => { if (typeof a !== 'string' || !a.trim()) badAns++; });
    if (q.blanks !== q.answer.length) badAns++;
  } else {
    if (!Array.isArray(q.answer) || q.answer.length < 1) { badAns++; return; }
    const keys = q.options.map(o => o.key);
    q.answer.forEach(a => { if (keys.indexOf(a) === -1) badOpt++; });
    if (q.type === 'single' && q.answer.length !== 1) badAns++;
  }
});
ok(badAns === 0, '所有答案非空且格式正确');
ok(badOpt === 0, '选择题答案均在选项键中');
ok(noAna === 0, '所有题目都带 analysis 字段');

/* 第28题（题库原文含空选项）原样保留 */
const q28 = D.parts[0].questions.find(q => q.no === 28);
ok(JSON.stringify(q28.options.map(o => o.key)) === '["A","B","C","A","D"]', '第28题选项按原文保留（含空选项）');
ok(q28.answer.join('') === 'B', '第28题答案为 B');

/* 填空题答案与“第N空”标记一致性抽查 */
const q123 = D.parts[1].questions.find(q => q.no === 123);
ok(q123.answer.length === 2 && q123.answer[0] === 'http://localhost' && q123.answer[1] === 'http://127.0.0.1',
  '填空123 双空答案正确');
const q180 = D.parts[1].questions.find(q => q.no === 180);
ok(q180.answer.length === 2 && q180.answer[1] === "$_POST['interest'][$i]",
  '填空180 答案与文档一致（未做人工改动）');

/* JSON 可序列化（无 undefined/NaN） */
ok(JSON.parse(JSON.stringify(D)).parts.length === 3, 'data 可完整 JSON 序列化');

console.log('== 题干渲染 renderStem ==');
let renderErr = 0, fillInlineOk = 0, choiceHasInput = 0, codeBlankDowngraded = 0, codeBlankMarked = 0;
allQ.forEach(q => {
  try {
    const r = C.renderStem(q.stem, q.type === 'fill' ? q.answer.length : null);
    if (/undefined|\[object Object\]/.test(r.html)) renderErr++;
    if (q.type === 'fill') {
      /* 与 app.js 一致：仅当下划线数 == 空数时才传入内联参数 */
      const runs = (q.stem.match(/_{2,}/g) || []).length;
      const passArg = runs === q.answer.length ? q.answer.length : null;
      const r2 = C.renderStem(q.stem, passArg);
      const n = (r2.html.match(/<input/g) || []).length;
      /* 新规则：若空落在代码块内，renderStem 必须整体降级（inline=0，不内联） */
      const expectInline = (passArg && !C.hasBlanksInCode(q.stem)) ? passArg : 0;
      if (n === expectInline && r2.inline === expectInline) {
        fillInlineOk++;
        if (expectInline === 0 && C.hasBlanksInCode(q.stem) && r2.html.indexOf('class="code"') !== -1) {
          codeBlankDowngraded++;
          /* run 数 == 空数时应在原位标注 ①②③（code-blank），数量与空数一致 */
          if (runs === q.answer.length) {
            const marks = (r2.html.match(/class="cb-no"/g) || []).length;
            if (r2.html.indexOf('code-blank') !== -1 && marks === q.answer.length) codeBlankMarked++;
          }
        }
      }
    } else if (r.html.indexOf('<input') !== -1) choiceHasInput++;
    q.options.forEach(o => { C.renderStem(o.text || '', null); });
    if (q.analysis) C.renderStem(q.analysis, null);
  } catch (e) { renderErr++; console.error('   渲染异常:', q.no, e.message); }
});
ok(renderErr === 0, '全部题干/选项/解析渲染无异常');
ok(fillInlineOk === 165, '填空题内联规则正确（165/165，代码块内空与不一致空位均降级为编号输入框）');
ok(codeBlankDowngraded === 24, '24 道代码块填空题全部降级为“第N空”编号输入框');
ok(codeBlankMarked === 21, '21 道线数=空数的代码填空题原位标注 ①②③（另 3 道文档线数≠空数不标注）');
ok(choiceHasInput === 0, '选择题题干不含输入框');

/* 代码块识别抽查 */
const q11 = D.parts[0].questions.find(q => q.no === 11);
ok(q11.stem.indexOf('<?php') !== -1 && C.renderStem(q11.stem, null).html.indexOf('class="code"') !== -1, 'PHP 代码块识别正常');

console.log('== 判分逻辑 ==');
const q1 = D.parts[0].questions.find(q => q.no === 1);
ok(C.gradeChoice(q1, ['A']).correct === true, '单选：选 A（答案A）→ 正确');
ok(C.gradeChoice(q1, ['B']).correct === false, '单选：选 B → 错误');
const q51 = D.parts[0].questions.find(q => q.no === 51);
ok(C.gradeChoice(q51, ['A', 'B', 'C']).correct === true, '多选：ABC（答案ABC）→ 正确');
ok(C.gradeChoice(q51, ['A', 'B']).correct === false, '多选：AB（少选）→ 错误');

/* 填空判分 */
ok(C.gradeFill(q123, ['http://localhost', 'HTTP://127.0.0.1']).correct === true, '填空：忽略大小写 → 正确');
ok(C.gradeFill(q123, ['localhost', 'x']).correct === false, '填空：错答 → 错误');
ok(C.normFill('ＰＨＰ。 ') === 'php', '全角/标点规范化');
const q131 = D.parts[1].questions.find(q => q.no === 131);
ok(C.gradeFill(q131, ['简短风格', 'ASP风格']).correct === true, '填空：尾部括注参考写法兼容');
const q134 = D.parts[1].questions.find(q => q.no === 134);
ok(C.gradeFill(q134, ['$a']).correct === true, '填空：代码答案 $a → 正确');

console.log('== 扩展题库专项 ==');
{
  const ext = D.parts[2];
  /* 每套题型分布 20/5/15/10 */
  let distOk = true;
  [1, 2, 3].forEach(s => {
    const c = {};
    ext.questions.filter(q => q.set === s).forEach(q => c[q.type] = (c[q.type] || 0) + 1);
    if (!(c.single === 20 && c.multiple === 5 && c.fill === 15 && c.code === 10)) distOk = false;
  });
  ok(distOk, '每套题型分布 单选20/多选5/填空15/编程10');

  /* 扩展单选答案合法（对照原文抽查：第1套第1题答案 B = 服务器端脚本语言） */
  const e1 = ext.questions.find(q => q.set === 1 && q.no === 1);
  const bOpt = e1.options.find(o => o.key === e1.answer[0]);
  ok(e1.answer[0] === 'B' && bOpt.text === '服务器端脚本语言', '第1套第1题答案 B（服务器端脚本语言）');
  /* 第1套第12题: echo 8 % (-2) → B（0，8 可被 -2 整除余 0） */
  const e12 = ext.questions.find(q => q.set === 1 && q.no === 12);
  const e12b = e12.options.find(o => o.key === e12.answer[0]);
  ok(e12.answer[0] === 'B' && e12b.text === '0', '第1套第12题答案 B（0）');

  /* 多选答案 */
  const e21 = ext.questions.find(q => q.set === 1 && q.no === 21);
  ok(e21.answer.join('') === 'ABC', '第1套第21题多选答案 ABC');
  ok(C.gradeChoice(e21, ['A', 'B', 'C']).correct === true, '扩展多选判分正确');

  /* 编程题：答案文本可展示、无自动判分依赖 */
  const e41 = ext.questions.find(q => q.set === 1 && q.no === 41);
  ok(e41.type === 'code' && e41.options.length === 0, '编程题无选项');
  ok(e41.answer.length === 1 && e41.answer[0].length > 0, '编程题答案文本非空（' + e41.answer[0].slice(0, 20) + '…）');
  const allCode = ext.questions.filter(q => q.type === 'code');
  ok(allCode.length === 30 && allCode.every(q => q.answer[0] && q.answer[0].trim()), '30 道编程题参考答案全部非空');

  /* 双空填空：第1套第35题 “// 或 #” */
  const e35 = ext.questions.find(q => q.set === 1 && q.no === 35);
  ok(e35.type === 'fill' && e35.answer.length === 2, '第1套第35题为双空填空（2空）');
  ok(C.gradeFill(e35, ['//', '#']).correct === true, '双空填空：// 与 # → 正确');
  ok(C.gradeFill(e35, ['#', '/*']).correct === false, '双空填空：第二空 /* → 错误');
  /* “或”多答案匹配：任一候选均可判对 */
  const refWithOr = e35.answer[0];
  ok(C.gradeFill({ type: 'fill', answer: [refWithOr] }, ['//']).per[0].ok === true, '“或”候选 1 判对');
  ok(C.gradeFill({ type: 'fill', answer: [refWithOr] }, ['#']).per[0].ok === true, '“或”候选 2 判对');
  ok(C.gradeFill({ type: 'fill', answer: [refWithOr] }, ['##']).per[0].ok === false, '非候选判错');
  /* 主题库不受“或”拆分影响 */
  ok(C.gradeFill(q134, ['$a']).correct === true, '主题库填空判分不受影响');
}

console.log('== 选项打乱 ==');
{
  const singles = D.parts[0].questions.filter(q => q.type === 'single')
    .concat(D.parts[2].questions.filter(q => q.type === 'single'));
  const multis = D.parts[0].questions.filter(q => q.type === 'multiple')
    .concat(D.parts[2].questions.filter(q => q.type === 'multiple'));
  const fills = D.parts[1].questions.filter(q => q.type === 'fill');
  const q28 = D.parts[0].questions.find(q => q.no === 28);
  let consistent = true;

  const snapshots = new Map();
  const snapshotOf = (q) => {
    if (!snapshots.has(q)) snapshots.set(q, JSON.stringify({ options: q.options, answer: q.answer }));
    return snapshots.get(q);
  };
  const checkOnce = (orig) => {
    const v = C.withShuffledOptions(orig);
    /* 选项内容多重集合不变 */
    if (v.options.map(o => o.text).sort().join('|') !== orig.options.map(o => o.text).sort().join('|')) consistent = false;
    /* 新编号必须从 A 连续排起 */
    if (v.options.some((o, i) => o.key !== 'ABCDEFGHIJ'[i])) consistent = false;
    /* 答案映射一致：原答案字母对应的内容 == 新答案字母对应的内容 */
    const oldTexts = orig.answer.map(k => orig.options.find(o => o.key === k).text).sort().join('|');
    const newTexts = v.answer.map(k => v.options.find(o => o.key === k).text).sort().join('|');
    if (oldTexts !== newTexts) consistent = false;
    /* 不修改原始数据（与首次快照比对） */
    if (JSON.stringify({ options: orig.options, answer: orig.answer }) !== snapshotOf(orig)) consistent = false;
  };

  for (let t = 0; t < 300; t++) {
    singles.forEach(checkOnce);
    multis.forEach(checkOnce);
  }
  ok(consistent, '全部选择题 300 轮随机打乱：内容/编号/答案映射/原数据均正确');

  /* 填空题原样返回（同一引用） */
  ok(C.withShuffledOptions(fills[0]) === fills[0], '填空题不受选项打乱影响');
  /* 原卷28题（含重复键与空选项）：答案 B 应始终指向原文内容 'AM' */
  let q28ok = true;
  for (let t = 0; t < 100; t++) {
    const v = C.withShuffledOptions(q28);
    const ansOpt = v.options.find(o => o.key === v.answer[0]);
    if (!ansOpt || ansOpt.text !== 'AM') q28ok = false;
  }
  ok(q28ok, '第28题（重复键）答案映射正确');

  /* 打乱前后选项顺序确实会变化（随机性抽查） */
  const q1 = singles.find(q => q.no === 1);
  let diff = 0;
  for (let t = 0; t < 50; t++) {
    const v = C.withShuffledOptions(q1);
    if (v.options.map(o => o.text).join('|') !== q1.options.map(o => o.text).join('|')) diff++;
  }
  ok(diff > 0, '选项顺序确实发生重排（50 轮中 ' + diff + ' 轮不同）');
}

console.log('== 组卷 ==');
ok(C.buildSessionRefs(D, { scope: 'p1', types: ['single'], limit: 0, shuffle: false }).length === 50, '第一部分单选 = 50（旧单值 scope 兼容）');
ok(C.buildSessionRefs(D, { scope: 'p2', types: ['single', 'fill'], limit: 0, shuffle: false }).length === 240, '第二部分全部 = 240');
ok(C.buildSessionRefs(D, { scope: 'all', types: ['single', 'multiple', 'fill'], limit: 30, shuffle: true }).length === 30, 'limit 截断 = 30');
ok(C.buildSessionRefs(D, { scope: 'all', types: [], limit: 0, shuffle: false }).length === 0, '不选题型 = 0');
ok(C.buildSessionRefs(D, { scope: 'ext', types: ['single', 'multiple', 'fill', 'code'], limit: 0, shuffle: false }).length === 150, '扩展题库全部 = 150');
ok(C.buildSessionRefs(D, { scope: 'ext', types: ['code'], limit: 0, shuffle: false }).length === 30, '扩展题库编程题 = 30');
ok(C.buildSessionRefs(D, { scope: 'ext', types: ['single'], limit: 0, shuffle: false }).length === 60, '扩展题库单选 = 60');
ok(C.buildSessionRefs(D, { scope: 'all', types: ['single', 'multiple', 'fill', 'code'], limit: 0, shuffle: false }).length === 472, '全部题库 = 472');
/* 多选题库 scopes（新） */
ok(C.buildSessionRefs(D, { scopes: ['p1', 'ext'], types: ['single'], limit: 0, shuffle: false }).length === 110, '多选题库 p1+ext 单选 = 110');
ok(C.buildSessionRefs(D, { scopes: ['p2', 'ext'], types: ['code'], limit: 0, shuffle: false }).length === 30, '多选 scopes 交叉 = 30');
ok(C.buildSessionRefs(D, { scopes: [], types: ['single'], limit: 0, shuffle: false }).length === 0, 'scopes 为空 = 0');
ok(C.buildSessionRefs(D, { scopes: ['p1', 'p2', 'ext'], types: ['single', 'multiple', 'fill', 'code'], limit: 0, shuffle: false }).length === 472, 'scopes 全选 = 472');
/* 扩展题库题目引用的 pi 指向第3部分 */
const extRefs = C.buildSessionRefs(D, { scope: 'ext', types: ['single'], limit: 0, shuffle: false });
ok(extRefs.every(r => r.pi === 2), '扩展题库引用指向第3部分');

console.log('== 加密分发（secure.js）==');
let NOTES = null;
{
  const securePath = path.join(ROOT, 'js', 'secure.js');
  ok(fs.existsSync(securePath), 'secure.js 存在');
  const secSrc = fs.readFileSync(securePath, 'utf8');
  const sandboxS = { window: {}, atob: s => Buffer.from(s, 'base64').toString('binary') };
  vm.createContext(sandboxS);
  vm.runInContext(secSrc, sandboxS);
  const enc = sandboxS.window.SECURE_DATA;
  ok(!!enc && enc.data && enc.notes, 'SECURE_DATA 结构完整');
  if (enc) {
    /* 密文里不应出现明文 JSON 特征（base64 字母表里个别 "PHP" 子串属正常） */
    ok(secSrc.indexOf('"parts"') === -1 && secSrc.indexOf('作业题库') === -1,
      '密文文件无明文题库特征');
    /* 密码从环境变量读取（QUIZ_PW），不写入仓库；缺失则跳过回环断言 */
    const PW = process.env.QUIZ_PW;
    if (PW) {
      const r = C.secureDecrypt(enc, PW);
      ok(!!r && r.quiz.parts.length === 3, '正确密码解密出完整题库');
      if (r) {
        ok(r.quiz.parts.reduce((s, p) => s + p.questions.length, 0) === 472, '解密题库 472 题');
        ok(r.notes.chapters.length === 16, '解密知识库 16 章');
        /* 与本地明文逐字节一致性（就地加载明文 notes，不依赖段落顺序） */
        const sameQuiz = JSON.stringify(r.quiz) === JSON.stringify(D);
        ok(sameQuiz, '解密结果与本地明文 data.js 完全一致');
        const sbN = { window: {} };
        vm.createContext(sbN);
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'notes.js'), 'utf8'), sbN);
        const sameNotes = JSON.stringify(r.notes) === JSON.stringify(sbN.window.NOTES_DATA);
        ok(sameNotes, '解密结果与本地明文 notes.js 完全一致');
        /* homework 回环 */
        const sbH = { window: {} };
        vm.createContext(sbH);
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'homework.js'), 'utf8'), sbH);
        const sameHw = JSON.stringify(r.homework) === JSON.stringify(sbH.window.HOMEWORK_DATA);
        ok(sameHw, '解密结果与本地明文 homework.js 完全一致');
      }
      ok(C.secureDecrypt(enc, PW + 'x') === null, '错误密码解密失败（返回 null）');
      /* AES-256 FIPS-197 标准向量 */
      const keyVec = C.hexToBytes('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
      const ptVec = C.hexToBytes('00112233445566778899aabbccddeeff');
      const outVec = Buffer.from(C.aesCtr256(keyVec, ptVec, new Array(16).fill(0))).toString('hex');
      ok(outVec === '8ea2b7ca516745bfeafc49904b496089', 'AES-256 通过 FIPS-197 C.3 标准向量');
      /* PBKDF2 与 Node 原生一致 */
      const k1 = Buffer.from(C.pbkdf2Sha256('pw', C.hexToBytes('aabb'), 1234, 32)).toString('hex');
      const k2 = require('crypto').pbkdf2Sync('pw', Buffer.from('aabb', 'hex'), 1234, 32, 'sha256').toString('hex');
      ok(k1 === k2, 'PBKDF2-HMAC-SHA256 与 Node crypto 一致');
    } else {
      console.log('  [i] 未设置 QUIZ_PW 环境变量，跳过解密回环断言');
    }
  }
}

console.log('== 知识库（notes.js）==');
{
  const notesSrc = fs.readFileSync(path.join(ROOT, 'js', 'notes.js'), 'utf8');
  const sandboxN = { window: {} };
  vm.createContext(sandboxN);
  vm.runInContext(notesSrc, sandboxN);
  const N = sandboxN.window.NOTES_DATA;
  NOTES = N;
  ok(!!N && Array.isArray(N.chapters), 'notes.js 加载且含章节数组');
  if (N) {
    ok(N.chapters.length === 16, '章节数 = 16（14 章 + 3 附录）');
    const chapters = N.chapters.filter(c => c.kind === 'chapter');
    ok(chapters.length === 13, '正文 13 个章节（第 9–10 章合并为一章）');
    /* refs 题号必须在题库中存在 */
    let badRefs = 0, totalMapped = 0;
    const noSets = { 0: { single: new Set(), multiple: new Set() }, 1: { single: new Set(), fill: new Set() } };
    D.parts[0].questions.forEach(q => noSets[0][q.type].add(q.no));
    D.parts[1].questions.forEach(q => noSets[1][q.type].add(q.no));
    chapters.forEach(c => {
      (c.refs.p1 || []).forEach(no => { totalMapped++; if (!noSets[0].single.has(no) && !noSets[0].multiple.has(no)) badRefs++; });
      (c.refs.p2single || []).forEach(no => { totalMapped++; if (!noSets[1].single.has(no)) badRefs++; });
      (c.refs.p2fill || []).forEach(no => { totalMapped++; if (!noSets[1].fill.has(no)) badRefs++; });
    });
    ok(badRefs === 0, '全部章节映射题号在题库中真实存在（共 ' + totalMapped + ' 个映射）');
    /* p2 单选/填空覆盖率（no6 120+120 中被笔记覆盖的比例） */
    const sCovered = new Set(chapters.flatMap(c => c.refs.p2single || [])).size;
    const fCovered = new Set(chapters.flatMap(c => c.refs.p2fill || [])).size;
    ok(sCovered === 120 && fCovered === 120, '第二部分单选/填空 240 题全部有章节归属（单选 ' + sCovered + ' 填空 ' + fCovered + '）');
    ok(N.intro.usage.length >= 2, '前言使用说明已导入');
    const codeBlocks = N.chapters.reduce((s, c) => s + c.blocks.filter(b => b.t === 'code').length, 0);
    ok(codeBlocks >= 45, '正文代码块已导入（' + codeBlocks + ' 个）');
  }
}

console.log('== 课后作业与实验（homework.js）==');
{
  const hwSrc = fs.readFileSync(path.join(ROOT, 'js', 'homework.js'), 'utf8');
  const sandboxH = { window: {} };
  vm.createContext(sandboxH);
  vm.runInContext(hwSrc, sandboxH);
  const H = sandboxH.window.HOMEWORK_DATA;
  ok(!!H && Array.isArray(H.items), 'homework.js 加载且含 items');
  if (H) {
    ok(H.items.length === 9, '共 9 篇（3 作业 + 6 实验，实际 ' + H.items.length + '）');
    ok(H.items.filter(i => i.kind === 'homework').length === 3, '作业 3 篇');
    ok(H.items.filter(i => i.kind === 'lab').length === 6, '实验 6 篇');
    const noCode = H.items.filter(i => !(i.blocks || []).some(b => b.t === 'code'));
    ok(noCode.length === 0, '每篇都包含答案代码块（' + H.items.map(i => i.codes).join('+') + ' = ' +
      H.items.reduce((s, i) => s + i.codes, 0) + ' 个代码块）');
    const noProblem = H.items.filter(i => !i.problem);
    ok(noProblem.length === 0, '每篇都有题目卡（文档显式题目或按小节合成）');
    const codeLangs = new Set(H.items.flatMap(i => i.blocks.filter(b => b.t === 'code').map(b => b.lang)));
    ok(codeLangs.has('php') && codeLangs.has('sql'), '代码块语言标注齐全（php/sql）');
    /* id 唯一（供 prev/next 与跳转） */
    ok(new Set(H.items.map(i => i.id)).size === H.items.length, 'item id 唯一');
  }
}

console.log('== 背题模式（直接显示答案）==');
{
  /* 背题模式渲染：recite 时选项正确项打勾、填空出答案、无任何输入框 */
  const sandbox2 = { window: { NOTES_DATA: NOTES }, document: null, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, confirm: () => true, alert: () => {}, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}, location: { reload: () => {} } };
  vm.createContext(sandbox2);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'core.js'), 'utf8'), sandbox2);
  /* 以第2部分单选第1题与填空第121题做渲染级断言 */
  const C2 = sandbox2.window.QuizCore;
  const s1 = D.parts[1].questions.find(q => q.type === 'single' && q.no === 1);
  const r1 = C2.renderStem(s1.stem, null);
  ok(r1.html.indexOf('<input') === -1, '背题模式题干无输入框（单选）');
  const f1 = D.parts[1].questions.find(q => q.type === 'fill' && q.no === 121);
  ok(f1 && f1.answer.length >= 1, '填空题存在且含参考答案');
  /* renderChoiceBody/renderReciteAnswer 属 app 层 DOM 逻辑，浏览器 E2E 覆盖 */
}

console.log('== 门禁与加密基建 ==');
{
  const nodeCrypto = require('crypto');
  /* sha256Hex 与 Node 原生一致（契约：仅 ASCII；UTF-8 由 deriveLockKey 内部转换） */
  let shaOk = true;
  ['hello', 'phpquiz-lock.v1:test', 'x'.repeat(200), 'x'.repeat(55), 'x'.repeat(64), 'abc def 123 !@#'].forEach(msg => {
    const ref = nodeCrypto.createHash('sha256').update(msg, 'utf8').digest('hex');
    if (C.sha256Hex(msg) !== ref) shaOk = false;
  });
  ok(shaOk, 'sha256Hex 与 Node crypto 多样本一致');
  /* deriveLockKey 回环与区分度（保留作通用工具函数） */
  const h1 = C.deriveLockKey('correct-horse', 'aabbccdd', 50);
  ok(h1 === C.deriveLockKey('correct-horse', 'aabbccdd', 50), 'deriveLockKey 同输入同输出');
  ok(h1 !== C.deriveLockKey('wrong-horse', 'aabbccdd', 50), 'deriveLockKey 错误密码可区分');
  /* app.js 已切换为"密码=数据密钥"模式（解密验证，无内嵌哈希） */
  const appSrc = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  ok(appSrc.indexOf('secureDecrypt') !== -1, 'app.js 使用密文解密门禁');
  ok(appSrc.indexOf("hash: '") === -1, 'app.js 无内嵌密码哈希（密码即密钥）');
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok(htmlSrc.indexOf('js/data.js') === -1 && htmlSrc.indexOf('js/notes.js') === -1,
    'index.html 不引用明文数据文件');
  ok(htmlSrc.indexOf('js/secure.js') !== -1, 'index.html 引用 secure.js 密文');
  /* 本地仓库工作区必须保留明文（供重新加密），但 git 不跟踪 */
  const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  ok(/js\/data\.js/.test(gitignore) && /js\/notes\.js/.test(gitignore), '.gitignore 排除明文数据');
}

console.log('== 页面元素引用一致性 ==');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
const usedIds = new Set([...appSrc.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]));
let missing = [...usedIds].filter(id => !htmlIds.has(id));
ok(missing.length === 0, 'app.js 引用的元素 id 都存在于 index.html' + (missing.length ? '（缺失: ' + missing.join(', ') + '）' : ''));

/* data.js 被 index.html 引用 */
ok(html.indexOf('js/secure.js') !== -1 && html.indexOf('js/core.js') !== -1 && html.indexOf('js/app.js') !== -1, 'index.html 正确引用三个脚本');

console.log('');
if (failed) { console.error('冒烟测试失败 ' + failed + ' 项'); process.exit(1); }
console.log('全部冒烟测试通过 ✔');
