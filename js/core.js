/* ============================================================
 * QuizCore —— 纯逻辑模块（无 DOM 依赖）
 * 判分 / 题干渲染 / 组卷 / 工具函数
 * 可在浏览器与 Node（冒烟测试）中共同使用。
 * 判分原则：一切以《答案与解析》文档中的【答案】为准，解析仅供参考。
 * ============================================================ */
(function (global) {
  'use strict';

  const TYPE_LABEL = { single: '单选题', multiple: '多选题', fill: '填空题', code: '编程题' };

  /* ---------------- 基础工具 ---------------- */

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function hasCJK(s) {
    return /[\u3400-\u4dbf\u4e00-\u9fff]/.test(s);
  }

  /* 常见代码行起始特征（用于题干中代码块识别） */
  function startsCode(t) {
    return /^(\$|echo\b|print\b|if\s*\(|else\b|elseif|for\s*\(|foreach\s*\(|while\s*\(|do\s*\{|switch\s*\(|function\b|class\b|new\b|var\b|let\b|const\b|return\b|xmlHttp\.|document\.|window\.|<\?|<script|<\/script|\?>|\{|\})/i.test(t);
  }

  function fullWidthToHalf(s) {
    let out = '';
    for (const ch of String(s)) {
      const c = ch.codePointAt(0);
      if (c >= 0xFF01 && c <= 0xFF5E) out += String.fromCharCode(c - 0xFEE0);
      else if (c === 0x3000) out += ' ';
      else out += ch;
    }
    return out;
  }

  function fmtTime(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    return String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ---------------- 题干渲染 ----------------
   * 逐行识别代码块（<?php … ?>、<script> … </script>、纯 ASCII 行等），
   * 填空题将题干中前 N 处下划线（N=空格数）替换为输入框。
   * 返回 { html, inline }：inline 为已内联的输入框数量。
   * ------------------------------------------ */
  /* 圆圈序号 ①②③…（1–20），超出用 (n) */
  function circled(n) {
    return n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : '(' + n + ')';
  }

  function renderLineWithBlanks(escaped, blankCount, st, markerMode) {
    if (blankCount == null) return escaped;
    const parts = escaped.split(/(_{2,})/);
    let out = '';
    for (const part of parts) {
      if (/^_{2,}$/.test(part)) {
        if (markerMode) {
          /* 降级模式：不生成输入框，在原位标注 ①②③ 序号（与下方“第N空”一一对应） */
          const n = st.blankIdx + 1;
          if (n <= blankCount) {
            out += '<span class="code-blank" title="第' + n + '空">____<span class="cb-no">' + circled(n) + '</span></span>';
          } else {
            out += part;
          }
          st.blankIdx++;
        } else if (st.blankIdx < blankCount) {
          const n = st.blankIdx + 1;
          const ph = blankCount > 1 ? ('第' + n + '空') : '请输入';
          out += '<span class="blank"><input type="text" data-blank="' + st.blankIdx +
            '" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="第' + n + '空" placeholder="' + ph + '"></span>';
          st.blankIdx++; st.inline++;
        } else {
          out += part;
        }
      } else {
        out += part;
      }
    }
    return out;
  }

  /* 检测题干中是否有填空（____）位于代码块内（PHP 代码 / script / 无中文行等） */
  function hasBlanksInCode(text) {
    const lines = String(text).split('\n');
    let inPhp = false, inScript = false;
    for (const raw of lines) {
      const t = raw.trim();
      let isCode;
      if (inPhp) { isCode = true; if (/\?>/.test(t)) inPhp = false; }
      else if (inScript) { isCode = true; if (/<\/script>/i.test(t)) inScript = false; }
      else if (/^<\?php/i.test(t)) { isCode = true; inPhp = !/\?>/.test(t); }
      else if (/<script/i.test(t)) { isCode = true; inScript = !/<\/script>/i.test(t); }
      else if (!t) { isCode = null; }
      else { isCode = !hasCJK(t) || startsCode(t); }
      if (isCode && /_{2,}/.test(String(raw))) return true;
    }
    return false;
  }

  function renderStem(text, blankCount) {
    const lines = String(text).split('\n');
    /* 只要存在代码块内的空，整题降级为“第N空”编号输入框：
       不在代码块里内联输入框，保证可读性与输入体验。
       且当题干下划线数与空数一致时，在原代码块（及正文）中
       以 ①②③ 荧光标注各空位，与下方“第N空”一一对应 */
    let markerMode = false;
    if (blankCount && hasBlanksInCode(text)) {
      const runs = (String(text).match(/_{2,}/g) || []).length;
      markerMode = runs === blankCount;
      /* 保留 blankCount 供序号计数；renderLineWithBlanks 的 markerMode 分支
         只生成 ①②③ 标注、不生成输入框 */
    }
    let html = '';
    let codeBuf = [];
    let inPhp = false, inScript = false;
    const st = { blankIdx: 0, inline: 0 };

    function flushCode() {
      if (codeBuf.length) {
        html += '<div class="code">' + codeBuf.join('') + '</div>';
        codeBuf = [];
      }
    }

    for (const raw of lines) {
      const t = raw.trim();
      let isCode;
      if (inPhp) { isCode = true; if (/\?>/.test(t)) inPhp = false; }
      else if (inScript) { isCode = true; if (/<\/script>/i.test(t)) inScript = false; }
      else if (/^<\?php/i.test(t)) { isCode = true; inPhp = !/\?>/.test(t); }
      else if (/<script/i.test(t)) { isCode = true; inScript = !/<\/script>/i.test(t); }
      else if (!t) { isCode = null; }
      else { isCode = !hasCJK(t) || startsCode(t); }

      if (isCode === null) {
        flushCode();
        continue;
      }
      if (isCode) {
        codeBuf.push('<div class="code-line">' + renderLineWithBlanks(escapeHtml(raw), blankCount, st, markerMode) + '</div>');
      } else {
        flushCode();
        html += '<p class="tl">' + renderLineWithBlanks(escapeHtml(raw), blankCount, st, markerMode) + '</p>';
      }
    }
    flushCode();
    return { html: html, inline: st.inline };
  }

  /* ---------------- 判分 ----------------
   * 选择题：所选字母集合与【答案】完全一致才算对（多选少选均判错）。
   * 填空题：逐空规范化比对（全角→半角、忽略大小写与空白、去尾部标点）；
   *         额外允许与“去掉尾部括注”的参考写法匹配（如“简短风格（<? ?>）”可答“简短风格”）。
   * -------------------------------------- */

  function normFill(s) {
    return fullWidthToHalf(s == null ? '' : s)
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[.。,，;；!！?？、]+$/, '');
  }

  function stripTrailingParen(s) {
    /* 仅当尾部括注较短（≤12字符）时剔除，避免误伤代码类答案 */
    return String(s).replace(/[（(][^（()）]{1,12}[)）]\s*$/, '');
  }

  /* 参考答案的全部可接受写法：原文 + 按“或”拆分的候选 + 各自去尾部括注 */
  function fillCandidates(ref) {
    const base = String(ref == null ? '' : ref);
    const cands = [base];
    const alts = base.split(/\s*或\s*/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (alts.length > 1) {
      alts.forEach(function (a) {
        cands.push(a);
        cands.push(stripTrailingParen(a));
      });
    }
    cands.push(stripTrailingParen(base));
    return cands;
  }

  function gradeFill(q, inputs) {
    const per = [];
    let all = true;
    for (let i = 0; i < q.answer.length; i++) {
      const u = normFill(inputs && inputs[i]);
      const cands = fillCandidates(q.answer[i]).map(normFill);
      const ok = !!u && cands.indexOf(u) !== -1;
      per.push({ ok: ok, user: (inputs && inputs[i]) || '', ref: q.answer[i] });
      if (!ok) all = false;
    }
    return { correct: all, per: per };
  }

  function gradeChoice(q, selected) {
    const sel = (selected || []).slice().sort();
    const ans = q.answer.slice().sort();
    const correct = sel.length === ans.length && sel.every(function (v, i) { return v === ans[i]; });
    return { correct: correct };
  }

  function isAnswered(item) {
    if (item.q.type === 'fill') return (item.inputs || []).some(function (v) { return v && String(v).trim(); });
    return (item.selected || []).length > 0;
  }

  function gradeItem(item) {
    if (item.q.type === 'fill') item.result = gradeFill(item.q, item.inputs);
    else item.result = gradeChoice(item.q, item.selected);
    return item.result;
  }

  /* ---------------- 组卷 ---------------- */

  function collectRefs(data, opts) {
    const refs = [];
    data.parts.forEach(function (part, pi) {
      /* scopes: 题库部分 id 数组（多选）；兼容旧的单值 opts.scope（'all' 或 id） */
      if (Array.isArray(opts.scopes)) {
        if (opts.scopes.indexOf(part.id) === -1) return;
      } else if (opts.scope && opts.scope !== 'all' && opts.scope !== part.id) {
        return;
      }
      part.questions.forEach(function (q, qi) {
        if (opts.types.indexOf(q.type) !== -1) refs.push({ pi: pi, qi: qi });
      });
    });
    return refs;
  }

  function buildSessionRefs(data, opts) {
    let refs = collectRefs(data, opts);
    if (opts.shuffle) refs = shuffle(refs);
    if (opts.limit > 0) refs = refs.slice(0, opts.limit);
    return refs;
  }

  /* ---------------- 选项打乱 ----------------
   * 将选择题选项随机重排，并按新顺序重新编号 A、B、C…，
   * 同时把【答案】字母映射到打乱后的新编号（按原选项顺序优先分配，
   * 兼容原文中键重复的情况，如原卷第28题）。
   * 返回题目副本，绝不修改原始题库数据；填空题原样返回。
   * ------------------------------------------ */
  const OPT_LETTERS = 'ABCDEFGHIJ';

  function withShuffledOptions(q) {
    if (!q || q.type === 'fill' || !Array.isArray(q.options) || q.options.length < 2) return q;
    const n = q.options.length;
    const order = shuffle(q.options.map(function (_, i) { return i; }));
    const newLetterOfOldIndex = {};
    order.forEach(function (oldIdx, newIdx) { newLetterOfOldIndex[oldIdx] = OPT_LETTERS[newIdx]; });
    const options = order.map(function (oldIdx, newIdx) {
      return { key: OPT_LETTERS[newIdx], text: q.options[oldIdx].text };
    });
    const oldKeyToNew = {};
    q.options.forEach(function (opt, oldIdx) {
      if (!(opt.key in oldKeyToNew)) oldKeyToNew[opt.key] = newLetterOfOldIndex[oldIdx];
    });
    const answer = q.answer.map(function (k) { return oldKeyToNew[k] || k; });
    const copy = {};
    for (const k in q) copy[k] = q[k];
    copy.options = options;
    copy.answer = answer;
    return copy;
  }

  /* ---------------- 进站密码 ----------------
   * 纯 JS 实现 SHA-256 + 多轮拉伸（file:// 协议下不可用 Web Crypto，
   * 因此不依赖 crypto.subtle）。仅用于本地门禁校验，防暴力破解靠失败锁定。
   * ------------------------------------------ */
  function sha256Hex(ascii) {
    function rightRotate(v, a) { return (v >>> a) | (v << (32 - a)); }
    const maxWord = Math.pow(2, 32);
    let result = '';
    const words = [];
    const asciiBitLength = ascii.length * 8;
    let hash = sha256Hex.h = sha256Hex.h || [];
    const k = sha256Hex.k = sha256Hex.k || [];
    let primeCounter = k.length;
    const isComposite = {};
    for (let candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (let i = 0; i < 313; i += candidate) isComposite[i] = candidate;
        hash[primeCounter] = (Math.pow(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (Math.pow(candidate, 1 / 3) * maxWord) | 0;
      }
    }
    ascii += '\x80';
    while (ascii.length % 64 - 56) ascii += '\x00';
    for (let i = 0; i < ascii.length; i++) {
      const j = ascii.charCodeAt(i);
      if (j >> 8) return '';   // 仅支持 ASCII 输入（调用前先做 UTF-8 转换）
      words[i >> 2] |= j << ((3 - i) % 4) * 8;
    }
    words[words.length] = (asciiBitLength / maxWord) | 0;
    words[words.length] = asciiBitLength;
    for (let j = 0; j < words.length;) {
      const w = words.slice(j, j += 16);
      const oldHash = hash.slice(0, 8);
      for (let i = 0; i < 64; i++) {
        const w15 = w[i - 15], w2 = w[i - 2];
        const a = hash[0], e = hash[4];
        const temp1 = hash[7]
          + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
          + ((e & hash[5]) ^ ((~e) & hash[6]))
          + k[i]
          + (w[i] = (i < 16) ? w[i] : (
              w[i - 16]
              + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3))
              + w[i - 7]
              + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))
            ) | 0);
        const temp2 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22))
          + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(temp1 + temp2) | 0].concat(hash);
        hash[4] = (hash[4] + temp1) | 0;
        hash.pop();
      }
      for (let i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }
    for (let i = 0; i < 8; i++) {
      for (let j = 3; j + 1; j--) {
        const b = (hash[i] >> (j * 8)) & 255;
        result += ((b < 16) ? 0 : '') + b.toString(16);
      }
    }
    return result;
  }

  /* UTF-8 安全转 ASCII 序列 */
  function toUtf8Ascii(str) {
    return unescape(encodeURIComponent(String(str)));
  }

  /* 密钥拉伸：SHA-256 迭代 rounds 轮，返回 64 位 hex */
  function deriveLockKey(password, saltHex, rounds) {
    let h = sha256Hex(toUtf8Ascii('phpquiz-lock.v1:' + saltHex + ':' + password));
    for (let i = 0; i < rounds; i++) {
      h = sha256Hex(h + ':' + saltHex + ':' + i);
    }
    return h;
  }

  /* ---------------- 加密数据解密（题库/知识库以密文分发） ----------------
   * 纯 JS 实现，file:// 与 https 均可用，不依赖 Web Crypto：
   *   密钥 = PBKDF2-HMAC-SHA256(密码, salt, rounds, 32字节)
   *   数据 = AES-256-CTR(iv) 解密 → UTF-8 JSON
   * 解析成功本身即密码校验；明文数据不出现在任何静态文件中。
   * ---------------------------------------------------------------------- */

  /* 字节级 SHA-256（输入/输出均为 0–255 字节数组） */
  function sha256Bytes(msgBytes) {
    function rightRotate(v, a) { return (v >>> a) | (v << (32 - a)); }
    const maxWord = Math.pow(2, 32);
    const hh = sha256Bytes.h = sha256Bytes.h || [];
    const kk = sha256Bytes.k = sha256Bytes.k || [];
    let primeCounter = kk.length;
    const isComposite = {};
    for (let candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (let i = 0; i < 313; i += candidate) isComposite[i] = candidate;
        hh[primeCounter] = (Math.pow(candidate, 0.5) * maxWord) | 0;
        kk[primeCounter++] = (Math.pow(candidate, 1 / 3) * maxWord) | 0;
      }
    }
    const bitLen = msgBytes.length * 8;
    const withPad = msgBytes.slice();
    withPad.push(0x80);
    while (withPad.length % 64 !== 56) withPad.push(0);
    /* 长度字段（64位大端） */
    const hiLen = Math.floor(bitLen / maxWord);
    const loLen = bitLen >>> 0;
    [hiLen, loLen].forEach(function (v) {
      withPad.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
    });
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
               0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    for (let j = 0; j < withPad.length; j += 64) {
      const w = new Array(16);
      for (let i = 0; i < 16; i++) {
        w[i] = (withPad[j + i * 4] << 24) | (withPad[j + i * 4 + 1] << 16) |
               (withPad[j + i * 4 + 2] << 8) | withPad[j + i * 4 + 3];
      }
      for (let i = 16; i < 64; i++) {
        const w15 = w[i - 15], w2 = w[i - 2];
        const s0 = rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3);
        const s1 = rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      const a0 = H.slice();
      for (let i = 0; i < 64; i++) {
        const e = a0[4];
        const temp1 = (a0[7] + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
          + ((e & a0[5]) ^ ((~e) & a0[6])) + kk[i] + w[i]) | 0;
        const a = a0[0];
        const temp2 = ((rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22))
          + ((a & a0[1]) ^ (a & a0[2]) ^ (a0[1] & a0[2]))) | 0;
        a0[7] = a0[6]; a0[6] = a0[5]; a0[5] = a0[4];
        a0[4] = (a0[3] + temp1) | 0;
        a0[3] = a0[2]; a0[2] = a0[1]; a0[1] = a0[0];
        a0[0] = (temp1 + temp2) | 0;
      }
      for (let i = 0; i < 8; i++) H[i] = (H[i] + a0[i]) | 0;
    }
    const out = [];
    for (let i = 0; i < 8; i++) {
      out.push((H[i] >>> 24) & 255, (H[i] >>> 16) & 255, (H[i] >>> 8) & 255, H[i] & 255);
    }
    return out;
  }

  function hmacSha256(keyBytes, msgBytes) {
    let k = keyBytes.slice();
    if (k.length > 64) k = sha256Bytes(k);
    while (k.length < 64) k.push(0);
    const inner = [], outer = [];
    for (let i = 0; i < 64; i++) {
      inner.push(k[i] ^ 0x36);
      outer.push(k[i] ^ 0x5c);
    }
    return sha256Bytes(outer.concat(sha256Bytes(inner.concat(msgBytes))));
  }

  /* PBKDF2-HMAC-SHA256（密码为任意 Unicode 字符串，内部转 UTF-8 字节） */
  function pbkdf2Sha256(password, saltBytes, rounds, dkLen) {
    const pwBytes = toBytesUtf8(password);
    const out = [];
    let block = 1;
    while (out.length < dkLen) {
      let u = hmacSha256(pwBytes, saltBytes.concat([0, 0, (block >> 8) & 255, block & 255]));
      const t = u.slice();
      for (let i = 1; i < rounds; i++) {
        u = hmacSha256(pwBytes, u);
        for (let j = 0; j < t.length; j++) t[j] ^= u[j];
      }
      out.push.apply(out, t);
      block++;
    }
    return out.slice(0, dkLen);
  }

  function toBytesUtf8(str) {
    const out = [];
    const escaped = unescape(encodeURIComponent(String(str)));
    for (let i = 0; i < escaped.length; i++) out.push(escaped.charCodeAt(i));
    return out;
  }

  function bytesToUtf8(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(s));
  }

  function hexToBytes(hex) {
    const out = [];
    for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
    return out;
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = [];
    for (let i = 0; i < bin.length; i++) out.push(bin.charCodeAt(i));
    return out;
  }

  /* AES-256 块加密（CTR 模式解密复用加密方向） */
  const AES_SBOX = [
    0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
    0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
    0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
    0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
    0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
    0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
    0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
    0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
    0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
    0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
    0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
    0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
    0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
    0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
    0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
    0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
  ];
  const AES_RCON = [0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36,0x6c,0xd8,0xab,0x4d];

  function aesExpandKey256(keyBytes) {
    const Nk = 8, Nr = 14;
    const w = [];
    for (let i = 0; i < Nk * 4; i++) w.push(keyBytes[i]);
    for (let i = Nk; i < 4 * (Nr + 1); i++) {
      let t = [w[(i - 1) * 4], w[(i - 1) * 4 + 1], w[(i - 1) * 4 + 2], w[(i - 1) * 4 + 3]];
      if (i % Nk === 0) {
        t = [AES_SBOX[t[1]], AES_SBOX[t[2]], AES_SBOX[t[3]], AES_SBOX[t[0]]];
        t[0] ^= AES_RCON[i / Nk - 1];
      } else if (i % Nk === 4) {
        t = [AES_SBOX[t[0]], AES_SBOX[t[1]], AES_SBOX[t[2]], AES_SBOX[t[3]]];
      }
      for (let j = 0; j < 4; j++) w.push(w[(i - Nk) * 4 + j] ^ t[j]);
    }
    return w;   // 240 个 4 字节字平铺（每轮 16 字节，共 15 轮）
  }

  function aesEncryptBlock(w, block16) {
    const Nr = 14;
    const s = block16.slice();
    const xtime = function (b) { return ((b << 1) ^ ((b & 0x80) ? 0x1b : 0)) & 0xff; };
    const addRoundKey = function (round) {
      for (let i = 0; i < 16; i++) s[i] ^= w[round * 16 + i];
    };
    /* SubBytes + ShiftRows（state 按列主序：s[c*4+r]，行 r 左移 r） */
    const subShift = function () {
      for (let i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]];
      const o = s.slice();
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          s[c * 4 + r] = o[((c + r) % 4) * 4 + r];
        }
      }
    };
    const mixCols = function () {
      for (let c = 0; c < 4; c++) {
        const a = [s[c * 4], s[c * 4 + 1], s[c * 4 + 2], s[c * 4 + 3]];
        s[c * 4]     = xtime(a[0]) ^ (xtime(a[1]) ^ a[1]) ^ a[2] ^ a[3];
        s[c * 4 + 1] = a[0] ^ xtime(a[1]) ^ (xtime(a[2]) ^ a[2]) ^ a[3];
        s[c * 4 + 2] = a[0] ^ a[1] ^ xtime(a[2]) ^ (xtime(a[3]) ^ a[3]);
        s[c * 4 + 3] = (xtime(a[0]) ^ a[0]) ^ a[1] ^ a[2] ^ xtime(a[3]);
      }
    };
    addRoundKey(0);
    for (let round = 1; round < Nr; round++) {
      subShift();
      mixCols();
      addRoundKey(round);
    }
    subShift();
    addRoundKey(Nr);
    return s;
  }

  /* AES-256-CTR：加密/解密同一函数（只需块加密方向） */
  function aesCtr256(keyBytes, ivBytes, dataBytes) {
    const w = aesExpandKey256(keyBytes);
    const out = new Array(dataBytes.length);
    const counter = ivBytes.slice();
    for (let off = 0; off < dataBytes.length; off += 16) {
      const ks = aesEncryptBlock(w, counter);
      const n = Math.min(16, dataBytes.length - off);
      for (let i = 0; i < n; i++) out[off + i] = dataBytes[off + i] ^ ks[i];
      for (let i = 15; i >= 0; i--) {
        counter[i] = (counter[i] + 1) & 255;
        if (counter[i] !== 0) break;
      }
    }
    return out;
  }

  /* 主入口：enc = window.SECURE_DATA；密码正确返回 {quiz, notes, homework}，错误返回 null */
  function secureDecrypt(enc, password) {
    if (!enc || !enc.data || !enc.notes) return null;
    const key = pbkdf2Sha256(password, hexToBytes(enc.salt), enc.rounds, 32);
    return secureDecryptWithKey(key, enc);
  }

  function secureDecryptWithKey(keyBytes, enc) {
    try {
      const d = JSON.parse(bytesToUtf8(aesCtr256(keyBytes, hexToBytes(enc.data.iv), b64ToBytes(enc.data.ct))));
      const n = JSON.parse(bytesToUtf8(aesCtr256(keyBytes, hexToBytes(enc.notes.iv), b64ToBytes(enc.notes.ct))));
      if (!d || !d.parts || !n || !n.chapters) return null;
      let hw = null;
      if (enc.homework) {
        hw = JSON.parse(bytesToUtf8(aesCtr256(keyBytes, hexToBytes(enc.homework.iv), b64ToBytes(enc.homework.ct))));
        if (!hw || !hw.items) hw = null;
      }
      return { quiz: d, notes: n, homework: hw };
    } catch (e) {
      return null;   // 密码错误 / 数据损坏 → 统一返回 null
    }
  }

  /* ---------------- 导出 ---------------- */
  const api = {
    TYPE_LABEL: TYPE_LABEL,
    escapeHtml: escapeHtml,
    hasCJK: hasCJK,
    fullWidthToHalf: fullWidthToHalf,
    fmtTime: fmtTime,
    shuffle: shuffle,
    renderStem: renderStem,
    normFill: normFill,
    stripTrailingParen: stripTrailingParen,
    gradeFill: gradeFill,
    gradeChoice: gradeChoice,
    gradeItem: gradeItem,
    isAnswered: isAnswered,
    collectRefs: collectRefs,
    buildSessionRefs: buildSessionRefs,
    withShuffledOptions: withShuffledOptions,
    hasBlanksInCode: hasBlanksInCode,
    sha256Hex: sha256Hex,
    deriveLockKey: deriveLockKey,
    pbkdf2Sha256: pbkdf2Sha256,
    aesCtr256: aesCtr256,
    sha256Bytes: sha256Bytes,
    hexToBytes: hexToBytes,
    b64ToBytes: b64ToBytes,
    bytesToUtf8: bytesToUtf8,
    secureDecrypt: secureDecrypt,
    secureDecryptWithKey: secureDecryptWithKey
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.QuizCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
