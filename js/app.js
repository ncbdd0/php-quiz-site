/* ============================================================
 * app.js —— 页面交互（依赖 secure.js 密文经 core.js 解密出的 QUIZ_DATA / NOTES_DATA）
 * 两种模式：
 *   背题模式 recite：作答不判分，交卷后统一批改回显。
 *   答题模式 quiz  ：点击「下一题」立即判分并显示解析，已答锁定。
 * ============================================================ */
(function () {
  'use strict';

  const C = window.QuizCore;
  let D = null;                             // 解密后赋值（boot 时）
  const LS_KEY = 'phpquiz.settings.v1';
  const LS_KEYSTORE = 'phpquiz.key.v1';     // {key: 派生密钥hex, until} —— 记住期内免输密码
  const LS_FAILS = 'phpquiz.lockfails.v1';  // {fails: 累计失败, lockUntil: 锁定截止}
  const LS_WB = 'phpquiz.wrongbook.v1';     // {"pi:qi": {w:答错次数, a:手动加入, t:最后时间}}
  const LS_PICK = 'phpquiz.pick.v1';        // ["pi:qi", …] 自选题练习的手选题单

  /* 进站密码 = 数据密钥：密码派生 AES 密钥解开题库/知识库（js/secure.js 密文）。
   * 密码错误 → 解密失败 → 无法进入，也无法从仓库文件读到明文题库。
   * 纯静态部署下，这是不引入服务器时能做到的最强内容保护。 */
  const LOCK = {
    rememberDays: 7,     // 解锁后 7 天内免输入（本机缓存派生密钥）
    maxFails: 5,         // 连续失败 5 次
    baseLockSec: 60,     // 首次锁定 60s，之后翻倍
    maxLockSec: 900      // 锁定上限 15 分钟
  };

  const $ = function (s) { return document.querySelector(s); };
  const $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  /* ---------------- 全局状态 ---------------- */
  const S = {
    view: 'home',
    mode: 'recite',                 // recite | quiz
    scopes: new Set(),              // 多选题库（boot 时默认全选）
    types: new Set(['single', 'multiple', 'fill', 'code']),
    limit: 0,                       // 0 = 全部
    shuffle: false,                 // 打乱题目顺序
    optShuffle: false,              // 打乱选项顺序
    session: null,                  // {mode, items, idx, startTs, elapsed, finished}
    timer: null,
    reviewFilter: 'all',
    wbSel: new Set(),               // 错题本视图：勾选的 "pi:qi"
    wbMode: 'quiz',                 // 错题本练习模式
    pickSel: new Set(),             // 自选题练习：已选 "pi:qi"（localStorage 持久化）
    pickScopes: null,               // 选题页筛选：题库部分 Set，null = 全部
    pickTypes: null,                // 选题页筛选：题型 Set，null = 全部
    pickQuery: '',                  // 选题页筛选：题干关键词
    pickPage: 1,                    // 选题页分页
    notesTab: 'notes'               // 知识库 tab：notes=章节笔记 | hw=课后作业与实验
  };
  const PICK_PAGE_SIZE = 80;

  /* ---------------- 视图切换 ---------------- */
  function switchView(name) {
    S.view = name;
    document.body.dataset.view = name;
    $('#view-home').hidden = name !== 'home';
    $('#view-quiz').hidden = name !== 'quiz';
    $('#view-result').hidden = name !== 'result';
    $('#view-wrongbook').hidden = name !== 'wrongbook';
    $('#view-pick').hidden = name !== 'pick';
    $('#view-notes').hidden = name !== 'notes';
    $('#view-lock').hidden = name !== 'lock';
    window.scrollTo(0, 0);
  }

  /* ---------------- 首页 ---------------- */
  function allScopeIds() {
    return D.parts.map(function (p) { return p.id; });
  }

  function scopeParts() {
    if (!S.scopes || !S.scopes.size) return [];   // 未勾选任何题库
    return D.parts.filter(function (p) { return S.scopes.has(p.id); });
  }

  /* 练习范围复选框：根据题库部分动态生成（支持多选） */
  function buildScopeRow() {
    const row = $('#scope-row');
    row.innerHTML = '';
    const mk = function (val, text) {
      const lab = document.createElement('label');
      lab.className = 'check-pill';
      lab.innerHTML = '<input type="checkbox" data-scope="' + val + '"><span>' + C.escapeHtml(text) + '</span>';
      row.appendChild(lab);
    };
    mk('all', '全部题库');
    D.parts.forEach(function (p) { mk(p.id, p.title); });
  }

  /* 同步"全部题库"母复选框与各部分复选框的选中态 */
  function refreshScopeChecks() {
    const ids = allScopeIds();
    const allChecked = ids.every(function (id) { return S.scopes.has(id); });
    $$('#scope-row input[data-scope]').forEach(function (cb) {
      if (cb.dataset.scope === 'all') cb.checked = allChecked;
      else cb.checked = S.scopes.has(cb.dataset.scope);
    });
  }

  function typeCount(t) {
    return scopeParts().reduce(function (n, p) {
      return n + p.questions.filter(function (q) { return q.type === t; }).length;
    }, 0);
  }

  function updateCounts() {
    $('#cnt-single').textContent = '（' + typeCount('single') + '）';
    $('#cnt-multiple').textContent = '（' + typeCount('multiple') + '）';
    $('#cnt-fill').textContent = '（' + typeCount('fill') + '）';
    $('#cnt-code').textContent = '（' + typeCount('code') + '）';
  }

  function currentPlan() {
    return {
      scopes: Array.from(S.scopes),
      types: Array.from(S.types),
      limit: S.limit,
      shuffle: S.shuffle
    };
  }

  function updateStartHint() {
    const refs = C.buildSessionRefs(D, currentPlan());
    const modeName = S.mode === 'recite' ? '背题模式' : '答题模式';
    $('#start-hint').textContent = refs.length
      ? '本次将练习 ' + refs.length + ' 题 · ' + modeName
      : '请至少选择一个题库和一种题型';
    $('#btn-start').disabled = refs.length === 0;
  }

  function saveSettings() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        mode: S.mode,
        scopes: Array.from(S.scopes),
        types: Array.from(S.types), limit: S.limit,
        shuffle: S.shuffle, optShuffle: S.optShuffle
      }));
    } catch (e) { /* 忽略 */ }
  }

  function restoreSettings() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { /* 忽略 */ }
    if (!s) return;
    if (s.mode === 'recite' || s.mode === 'quiz') selectMode(s.mode, true);
    if (Array.isArray(s.scopes)) {
      const valid = allScopeIds();
      const picked = s.scopes.filter(function (id) { return valid.indexOf(id) !== -1; });
      if (picked.length) S.scopes = new Set(picked);
    } else if (typeof s.scope === 'string') {
      /* 兼容旧版单选范围设置 */
      if (s.scope === 'all') S.scopes = new Set(allScopeIds());
      else if (allScopeIds().indexOf(s.scope) !== -1) S.scopes = new Set([s.scope]);
    }
    if (Array.isArray(s.types)) {
      S.types = new Set(s.types.filter(function (t) {
        return ['single', 'multiple', 'fill', 'code'].indexOf(t) !== -1;
      }));
      if (!S.types.size) S.types.add('single');
      $$('#view-home input[data-type]').forEach(function (cb) {
        cb.checked = S.types.has(cb.dataset.type);
      });
    }
    if (typeof s.limit === 'number') {
      S.limit = s.limit;
      const sel = $('#limit');
      if (sel.querySelector('option[value="' + s.limit + '"]')) sel.value = String(s.limit);
    }
    if (typeof s.shuffle === 'boolean') {
      S.shuffle = s.shuffle;
      $('#shuffle').checked = s.shuffle;
    }
    if (typeof s.optShuffle === 'boolean') {
      S.optShuffle = s.optShuffle;
      $('#opt-shuffle').checked = s.optShuffle;
    }
  }

  /* ---------------- 进站密码门禁 ---------------- */

  function lockState() {
    try { return JSON.parse(localStorage.getItem(LS_FAILS) || '{}') || {}; } catch (e) { return {}; }
  }

  function lockRemainingSec() {
    const st = lockState();
    return st.lockUntil ? Math.max(0, Math.ceil((st.lockUntil - Date.now()) / 1000)) : 0;
  }

  let lockTimer = null;
  let unlockBusy = false;

  function refreshLockUI() {
    const remain = lockRemainingSec();
    const locked = remain > 0;
    $('#lock-pw').disabled = locked;
    $('#btn-unlock').disabled = locked;
    $('#lock-hint').textContent = locked
      ? ('失败次数过多，已临时锁定 ' + remain + ' 秒，请稍后再试')
      : ('连续输错 ' + LOCK.maxFails + ' 次将临时锁定，防止暴力破解');
    if (locked && !lockTimer) {
      lockTimer = setInterval(function () {
        const r = lockRemainingSec();
        if (r > 0) {
          $('#lock-hint').textContent = '失败次数过多，已临时锁定 ' + r + ' 秒，请稍后再试';
        } else {
          clearInterval(lockTimer); lockTimer = null;
          refreshLockUI();
        }
      }, 1000);
    }
  }

  /* 记住期：本机缓存派生密钥（仅本设备），期内免输密码直接解密 */
  function storedUnlockKey() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_KEYSTORE) || 'null');
      if (s && s.key && s.until > Date.now()) return C.hexToBytes(s.key);
    } catch (e) { /* 忽略 */ }
    return null;
  }

  function rememberKey(keyBytes) {
    try {
      localStorage.setItem(LS_KEYSTORE, JSON.stringify({
        key: Array.prototype.map.call(keyBytes, function (b) {
          return ('0' + b.toString(16)).slice(-2);
        }).join(''),
        until: Date.now() + LOCK.rememberDays * 86400000
      }));
      localStorage.removeItem(LS_FAILS);
    } catch (e) { /* 忽略 */ }
  }

  function tryUnlock() {
    if (unlockBusy || lockRemainingSec() > 0) return;
    const pw = $('#lock-pw').value;
    const msg = $('#lock-msg');
    if (!pw) { msg.textContent = '请输入密码'; return; }
    if (!window.SECURE_DATA) { msg.textContent = '加密数据未加载'; return; }
    unlockBusy = true;
    $('#btn-unlock').disabled = true;
    msg.textContent = '解密题库中…';
    /* 延迟一帧，让"解密中"先渲染出来（PBKDF2 + AES 解密约 0.2~0.5 秒） */
    setTimeout(function () {
      const r = C.secureDecrypt(window.SECURE_DATA, pw);
      unlockBusy = false;
      $('#btn-unlock').disabled = false;
      if (r) {
        $('#lock-pw').value = '';
        msg.textContent = '';
        bootApp(r.quiz, r.notes, r.homework);
        rememberKey(C.pbkdf2Sha256(pw, C.hexToBytes(window.SECURE_DATA.salt), window.SECURE_DATA.rounds, 32));
        enterApp();
      } else {
        const st = lockState();
        st.fails = (st.fails || 0) + 1;
        if (st.fails >= LOCK.maxFails) {
          const idx = Math.floor(st.fails / LOCK.maxFails);   // 第5/10/15…次失败时锁定
          const sec = Math.min(LOCK.baseLockSec * Math.pow(2, idx - 1), LOCK.maxLockSec);
          st.lockUntil = Date.now() + sec * 1000;
        }
        try { localStorage.setItem(LS_FAILS, JSON.stringify(st)); } catch (e) { /* 忽略 */ }
        msg.textContent = '密码不正确（已失败 ' + st.fails + ' 次）';
        $('#lock-pw').value = '';
        $('#lock-pw').focus();
        refreshLockUI();
      }
    }, 30);
  }

  function initLock() {
    $('#btn-unlock').addEventListener('click', tryUnlock);
    $('#lock-pw').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); tryUnlock(); }
    });
    $('#lock-pw').addEventListener('input', function () { $('#lock-msg').textContent = ''; });
    refreshLockUI();
  }

  function enterApp() {
    switchView('home');
    updateCounts();
    updateStartHint();
    updateWrongbookUI();
  }

  function selectMode(mode, silent) {
    S.mode = mode;
    $$('.mode-card').forEach(function (card) {
      const on = card.dataset.mode === mode;
      card.classList.toggle('selected', on);
      card.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (!silent) updateStartHint();
  }

  function initHome() {
    $('#home-stats').textContent = '共 ' + totalQuestions() + ' 题 · 单选 ' + typeCountAll('single') +
      ' / 多选 ' + typeCountAll('multiple') + ' / 填空 ' + typeCountAll('fill') +
      ' / 编程 ' + typeCountAll('code');

    buildScopeRow();
    $$('.mode-card').forEach(function (card) {
      card.addEventListener('click', function () { selectMode(card.dataset.mode); });
    });
    /* 练习范围：多选题库。data-scope="all" 为全选母开关 */
    $$('#scope-row input[data-scope]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        if (cb.dataset.scope === 'all') {
          const ids = allScopeIds();
          S.scopes = cb.checked ? new Set(ids) : new Set();
        } else {
          if (cb.checked) S.scopes.add(cb.dataset.scope);
          else S.scopes.delete(cb.dataset.scope);
        }
        refreshScopeChecks();
        updateCounts();
        updateStartHint();
      });
    });
    $$('#view-home input[data-type]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        if (cb.checked) S.types.add(cb.dataset.type); else S.types.delete(cb.dataset.type);
        updateStartHint();
      });
    });
    $('#limit').addEventListener('change', function () { S.limit = Number($('#limit').value) || 0; updateStartHint(); });
    $('#shuffle').addEventListener('change', function () { S.shuffle = $('#shuffle').checked; updateStartHint(); });
    $('#opt-shuffle').addEventListener('change', function () { S.optShuffle = $('#opt-shuffle').checked; });

    $('#btn-start').addEventListener('click', function () {
      const refs = C.buildSessionRefs(D, currentPlan());
      if (!refs.length) return;
      saveSettings();
      startSession(refs, S.mode);
    });

    $('#btn-wb-open').addEventListener('click', openWrongbook);

    restoreSettings();
    refreshScopeChecks();
    selectMode(S.mode, true);
    updateCounts();
    updateStartHint();
    updateWrongbookUI();
  }

  function totalQuestions() {
    return D.parts.reduce(function (n, p) { return n + p.questions.length; }, 0);
  }
  function typeCountAll(t) {
    return D.parts.reduce(function (n, p) {
      return n + p.questions.filter(function (q) { return q.type === t; }).length;
    }, 0);
  }

  /* ---------------- 错题本 ----------------
   * 记录每题答错次数；答错自动入本，也可手动添加/移除；
   * 支持在错题本内勾选题目单独练习。
   * ------------------------------------------ */
  function loadWB() {
    try {
      const o = JSON.parse(localStorage.getItem(LS_WB) || '{}');
      return (o && typeof o === 'object') ? o : {};
    } catch (e) { return {}; }
  }
  let WB = loadWB();

  function saveWB() {
    try { localStorage.setItem(LS_WB, JSON.stringify(WB)); } catch (e) { /* 忽略 */ }
  }
  function wbKey(pi, qi) { return pi + ':' + qi; }

  /* 答错自动记录：次数 +1，并确保入本 */
  function wbRecordWrong(pi, qi) {
    const k = wbKey(pi, qi);
    const e = WB[k] || { w: 0, a: false, t: 0 };
    e.w += 1;
    e.t = Date.now();
    WB[k] = e;
    saveWB();
    updateWrongbookUI();
  }

  /* 手动添加 */
  function wbAdd(pi, qi) {
    const k = wbKey(pi, qi);
    const e = WB[k] || { w: 0, a: false, t: 0 };
    e.a = true;
    WB[k] = e;
    saveWB();
    updateWrongbookUI();
  }

  /* 移除（连同答错记录一起删除） */
  function wbRemove(pi, qi) {
    delete WB[wbKey(pi, qi)];
    saveWB();
    updateWrongbookUI();
  }

  function wbHas(pi, qi) { return !!WB[wbKey(pi, qi)]; }

  function wbRefs() {
    return Object.keys(WB).map(function (k) {
      const seg = k.split(':');
      return { pi: Number(seg[0]), qi: Number(seg[1]) };
    }).filter(function (r) {
      return D.parts[r.pi] && D.parts[r.pi].questions[r.qi];
    }).sort(function (a, b) { return a.pi - b.pi || a.qi - b.qi; });
  }

  function wbCount() { return wbRefs().length; }

  function updateWrongbookUI() {
    const el = $('#wb-total');
    if (el) el.textContent = String(wbCount());
  }

  function updateBookmarkBtn(item) {
    const b = $('#btn-bookmark');
    if (!b || !item) return;
    const on = wbHas(item.pi, item.qi);
    b.textContent = on ? '✓ 错题本' : '＋ 错题本';
    b.classList.toggle('on', on);
  }

  function toggleBookmark(item) {
    if (!item) return;
    if (wbHas(item.pi, item.qi)) wbRemove(item.pi, item.qi);
    else wbAdd(item.pi, item.qi);
    updateBookmarkBtn(item);
  }

  function openWrongbook() {
    S.wbSel = new Set(Object.keys(WB));   // 默认全选
    renderWrongbook();
    switchView('wrongbook');
  }

  function renderWrongbook() {
    const list = $('#wb-list');
    list.innerHTML = '';
    const refs = wbRefs();
    $('#wb-count').textContent = String(refs.length);
    $('#wb-empty').hidden = refs.length > 0;
    $('#wb-panel').hidden = refs.length === 0;

    refs.forEach(function (r) {
      const q = D.parts[r.pi].questions[r.qi];
      const e = WB[wbKey(r.pi, r.qi)];
      const card = document.createElement('article');
      card.className = 'sheet wb-card';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'wb-check';
      cb.checked = S.wbSel.has(wbKey(r.pi, r.qi));
      cb.setAttribute('aria-label', '选择本题进行练习');
      cb.addEventListener('change', function () {
        if (cb.checked) S.wbSel.add(wbKey(r.pi, r.qi));
        else S.wbSel.delete(wbKey(r.pi, r.qi));
        updateWbStartBtn();
      });

      const main = document.createElement('div');
      main.className = 'wb-main';
      const head = document.createElement('div');
      head.className = 'q-head';
      const meta = [];
      if (e.w > 0) meta.push('累计答错 ' + e.w + ' 次');
      if (e.a) meta.push('手动加入');
      if (e.t) meta.push('最后记录 ' + fmtDate(e.t));
      head.innerHTML =
        '<span class="q-type t-' + q.type + '">' + C.TYPE_LABEL[q.type] + '</span>' +
        '<span class="q-src">' + srcLabel({ pi: r.pi, q: q }) + '</span>' +
        (meta.length ? '<span class="wb-meta">' + C.escapeHtml(meta.join(' · ')) + '</span>' : '');
      main.appendChild(head);

      const stem = document.createElement('div');
      stem.className = 'q-stem wb-stem';
      stem.innerHTML = C.renderStem(q.stem, null).html;
      main.appendChild(stem);
      card.appendChild(cb);
      card.appendChild(main);

      const cardBtns = document.createElement('div');
      cardBtns.className = 'wb-btns';
      const nb = makeNotesBtn({ pi: r.pi, q: q }, 'btn ghost sm notes-link');
      if (nb) cardBtns.appendChild(nb);

      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'btn danger sm';
      rm.textContent = '移除';
      rm.addEventListener('click', function () {
        wbRemove(r.pi, r.qi);
        S.wbSel.delete(wbKey(r.pi, r.qi));
        renderWrongbook();
      });
      cardBtns.appendChild(rm);
      card.appendChild(cardBtns);
      list.appendChild(card);
    });
    updateWbStartBtn();
  }

  function fmtDate(ts) {
    const d = new Date(ts);
    const p = function (n) { return (n < 10 ? '0' : '') + n; };
    return (d.getFullYear()) + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function updateWbStartBtn() {
    $('#btn-wb-start').textContent = '开始练习（' + S.wbSel.size + ' 题选中）';
    $('#btn-wb-start').disabled = S.wbSel.size === 0;
    $('#btn-wb-remove-sel').disabled = S.wbSel.size === 0;
  }

  function initWrongbook() {
    $('#btn-wb-back').addEventListener('click', function () { switchView('home'); });
    $('#wb-mode').addEventListener('change', function () { S.wbMode = $('#wb-mode').value; });
    $('#btn-wb-start').addEventListener('click', function () {
      const refs = wbRefs().filter(function (r) { return S.wbSel.has(wbKey(r.pi, r.qi)); });
      if (!refs.length) return;
      if ($('#wb-shuffle').checked) C.shuffle(refs);
      startSession(refs, S.wbMode);
    });
    $('#btn-wb-remove-sel').addEventListener('click', function () {
      if (!S.wbSel.size) return;
      if (!window.confirm('确定从错题本移除所选 ' + S.wbSel.size + ' 题吗？（答错记录一并删除）')) return;
      S.wbSel.forEach(function (k) {
        const seg = k.split(':');
        wbRemove(Number(seg[0]), Number(seg[1]));
      });
      S.wbSel.clear();
      renderWrongbook();
    });
    $('#btn-wb-clear').addEventListener('click', function () {
      if (!wbCount()) return;
      if (!window.confirm('确定清空整个错题本吗？所有答错记录将删除。')) return;
      WB = {};
      saveWB();
      S.wbSel.clear();
      renderWrongbook();
      updateWrongbookUI();
    });
  }

  /* ---------------- 自选题练习 ----------------
   * 浏览题库，按题库/题型/关键词筛选后逐题勾选，
   * 组成自选题目单（localStorage 持久化）再练习。
   * ------------------------------------------ */
  function loadPickSel() {
    try {
      const arr = JSON.parse(localStorage.getItem(LS_PICK) || '[]');
      const set = new Set(Array.isArray(arr) ? arr : []);
      /* 剔除不存在的键 */
      Array.from(set).forEach(function (k) {
        const seg = k.split(':').map(Number);
        if (!(D.parts[seg[0]] && D.parts[seg[0]].questions[seg[1]])) set.delete(k);
      });
      return set;
    } catch (e) { return new Set(); }
  }

  function savePickSel() {
    try { localStorage.setItem(LS_PICK, JSON.stringify(Array.from(S.pickSel))); } catch (e) { /* 忽略 */ }
  }

  function pickFilteredRefs() {
    const q = S.pickQuery.trim().toLowerCase();
    const scopes = S.pickScopes, types = S.pickTypes;
    const refs = [];
    D.parts.forEach(function (part, pi) {
      if (scopes && !scopes.has(part.id)) return;
      part.questions.forEach(function (qt, qi) {
        if (types && !types.has(qt.type)) return;
        if (q && qt.stem.toLowerCase().indexOf(q) === -1) return;
        refs.push({ pi: pi, qi: qi });
      });
    });
    return refs;
  }

  function updatePickUI() {
    const n = S.pickSel.size;
    $('#pick-total').textContent = String(n);
    $('#pick-sel-count').textContent = String(n);
    $('#btn-pick-start').textContent = '开始练习（' + n + ' 题已选）';
    $('#btn-pick-start').disabled = n === 0;
    $('#btn-pick-clear').disabled = n === 0;
  }

  function buildPickFilters() {
    /* 题库部分筛选 */
    const scopeRow = $('#pick-scope-row');
    scopeRow.innerHTML = '';
    const mkPill = function (row, val, text, attr, checked) {
      const lab = document.createElement('label');
      lab.className = 'check-pill';
      lab.innerHTML = '<input type="checkbox" ' + attr + '="' + val + '"' + (checked ? ' checked' : '') + '><span>' + C.escapeHtml(text) + '</span>';
      row.appendChild(lab);
      return lab.querySelector('input');
    };
    mkPill(scopeRow, 'all', '全部题库', 'data-pick-scope', true);
    D.parts.forEach(function (p) { mkPill(scopeRow, p.id, p.title, 'data-pick-scope', true); });
    S.pickScopes = new Set(allScopeIds());
    /* 题型筛选 */
    const typeRow = $('#pick-type-row');
    typeRow.innerHTML = '';
    mkPill(typeRow, 'all', '全部题型', 'data-pick-type', true);
    ['single', 'multiple', 'fill', 'code'].forEach(function (t) {
      mkPill(typeRow, t, C.TYPE_LABEL[t], 'data-pick-type', true);
    });
    S.pickTypes = new Set(['single', 'multiple', 'fill', 'code']);

    const syncScope = function () {
      const all = scopeRow.querySelector('input[data-pick-scope="all"]');
      all.checked = allScopeIds().every(function (id) { return S.pickScopes.has(id); });
    };
    const syncType = function () {
      const all = typeRow.querySelector('input[data-pick-type="all"]');
      all.checked = ['single', 'multiple', 'fill', 'code'].every(function (t) { return S.pickTypes.has(t); });
    };

    $$('#pick-scope-row input[data-pick-scope]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        if (cb.dataset.pickScope === 'all') {
          S.pickScopes = cb.checked ? new Set(allScopeIds()) : new Set();
        } else {
          if (cb.checked) S.pickScopes.add(cb.dataset.pickScope); else S.pickScopes.delete(cb.dataset.pickScope);
        }
        syncScope();
        S.pickPage = 1;
        renderPickList();
      });
    });
    $$('#pick-type-row input[data-pick-type]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        if (cb.dataset.pickType === 'all') {
          S.pickTypes = cb.checked ? new Set(['single', 'multiple', 'fill', 'code']) : new Set();
        } else {
          if (cb.checked) S.pickTypes.add(cb.dataset.pickType); else S.pickTypes.delete(cb.dataset.pickType);
        }
        syncType();
        S.pickPage = 1;
        renderPickList();
      });
    });
    syncScope();
    syncType();
  }

  function pickCardHTML(ref) {
    const q = D.parts[ref.pi].questions[ref.qi];
    const key = wbKey(ref.pi, ref.qi);
    const card = document.createElement('article');
    card.className = 'sheet wb-card pick-card' + (S.pickSel.has(key) ? ' picked' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'wb-check';
    cb.checked = S.pickSel.has(key);
    cb.setAttribute('aria-label', '勾选本题');
    cb.addEventListener('change', function () {
      if (cb.checked) S.pickSel.add(key); else S.pickSel.delete(key);
      savePickSel();
      card.classList.toggle('picked', cb.checked);
      updatePickUI();
    });

    const main = document.createElement('div');
    main.className = 'wb-main';
    const head = document.createElement('div');
    head.className = 'q-head';
    head.innerHTML =
      '<span class="q-type t-' + q.type + '">' + C.TYPE_LABEL[q.type] + '</span>' +
      '<span class="q-src">' + srcLabel({ pi: ref.pi, q: q }) + '</span>';
    main.appendChild(head);
    const stem = document.createElement('div');
    stem.className = 'q-stem wb-stem';
    stem.innerHTML = C.renderStem(q.stem, null).html;
    main.appendChild(stem);
    card.appendChild(cb);
    card.appendChild(main);
    return card;
  }

  function renderPickList() {
    const list = $('#pick-list');
    list.innerHTML = '';
    const refs = pickFilteredRefs();
    const shown = refs.slice(0, S.pickPage * PICK_PAGE_SIZE);
    $('#pick-count-tip').textContent = refs.length
      ? ('筛选出 ' + refs.length + ' 题 · 已选中其中 ' + refs.filter(function (r) { return S.pickSel.has(wbKey(r.pi, r.qi)); }).length + ' 题')
      : '';
    $('#pick-empty').hidden = refs.length > 0;
    shown.forEach(function (r) { list.appendChild(pickCardHTML(r)); });
    const more = $('#btn-pick-more');
    more.hidden = shown.length >= refs.length;
    more.textContent = '加载更多（还有 ' + (refs.length - shown.length) + ' 题）';
  }

  function openPick() {
    S.pickPage = 1;
    renderPickList();
    updatePickUI();
    switchView('pick');
  }

  function initPick() {
    S.pickSel = loadPickSel();
    buildPickFilters();
    $('#btn-pick-open').addEventListener('click', openPick);
    $('#btn-pick-back').addEventListener('click', function () { switchView('home'); });
    $('#pick-mode').addEventListener('change', function () { /* 读取于开始时 */ });
    let searchTimer = null;
    $('#pick-search').addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        S.pickQuery = $('#pick-search').value;
        S.pickPage = 1;
        renderPickList();
      }, 200);
    });
    $('#btn-pick-more').addEventListener('click', function () {
      S.pickPage += 1;
      renderPickList();
    });
    $('#btn-pick-sel-filtered').addEventListener('click', function () {
      pickFilteredRefs().forEach(function (r) { S.pickSel.add(wbKey(r.pi, r.qi)); });
      savePickSel();
      S.pickPage = 1;
      renderPickList();
      updatePickUI();
    });
    $('#btn-pick-desel-filtered').addEventListener('click', function () {
      pickFilteredRefs().forEach(function (r) { S.pickSel.delete(wbKey(r.pi, r.qi)); });
      savePickSel();
      S.pickPage = 1;
      renderPickList();
      updatePickUI();
    });
    $('#btn-pick-clear').addEventListener('click', function () {
      if (!S.pickSel.size) return;
      if (!window.confirm('确定清空全部已选题目吗？（共 ' + S.pickSel.size + ' 题）')) return;
      S.pickSel.clear();
      savePickSel();
      S.pickPage = 1;
      renderPickList();
      updatePickUI();
    });
    $('#btn-pick-start').addEventListener('click', function () {
      const refs = Array.from(S.pickSel).map(function (k) {
        const seg = k.split(':').map(Number);
        return { pi: seg[0], qi: seg[1] };
      }).sort(function (a, b) { return a.pi - b.pi || a.qi - b.qi; });
      if (!refs.length) return;
      if ($('#pick-shuffle').checked) C.shuffle(refs);
      startSession(refs, $('#pick-mode').value);
    });
  }

  /* ---------------- 知识库 ----------------
   * 《PHP期末精简学习笔记_按题库重排》按章节导入；
   * 题目 ↔ 章节映射来自各章"题库落点"，答错时一键跳转对应知识点。
   * ------------------------------------------ */
  let NOTES_MAP = null;   // { 'partIdx:type:no' → chapterId }

  function buildNotesMap() {
    NOTES_MAP = {};
    if (!window.NOTES_DATA) return;
    window.NOTES_DATA.chapters.forEach(function (ch) {
      const refs = ch.refs || {};
      /* 第1部分（no4）：单选+多选共用原卷题号 */
      (refs.p1 || []).forEach(function (no) {
        NOTES_MAP['0:single:' + no] = ch.id;
        NOTES_MAP['0:multiple:' + no] = ch.id;
      });
      (refs.p2single || []).forEach(function (no) { NOTES_MAP['1:single:' + no] = ch.id; });
      (refs.p2fill || []).forEach(function (no) { NOTES_MAP['1:fill:' + no] = ch.id; });
    });
  }

  function notesChapterOf(item) {
    if (!NOTES_MAP) return null;
    return NOTES_MAP[item.pi + ':' + item.q.type + ':' + item.q.no] || null;
  }

  /* 生成"📖 知识点"跳转按钮（无对应章节则返回 null） */
  function makeNotesBtn(item, styleClass) {
    const cid = notesChapterOf(item);
    if (!cid || !window.NOTES_DATA) return null;
    const ch = window.NOTES_DATA.chapters.find(function (c) { return c.id === cid; });
    if (!ch) return null;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = styleClass || 'btn ghost sm notes-link';
    btn.textContent = '📖 知识点：' + ch.title;
    btn.addEventListener('click', function () { openNotesChapter(cid); });
    return btn;
  }

  /* 在判评区/复盘卡/错题本卡追加知识点入口 */
  function appendNotesLink(box, item) {
    const btn = makeNotesBtn(item);
    if (btn) {
      const row = document.createElement('div');
      row.className = 'notes-link-row';
      row.appendChild(btn);
      box.appendChild(row);
    }
  }

  function openNotes() {
    if (!window.NOTES_DATA) return;
    if (!NOTES_MAP) buildNotesMap();
    S.notesFrom = S.view;               // 记录来源视图，返回时回到原处
    showNotesHome();
    switchView('notes');
  }

  /* 知识库首页（保留当前 tab：章节笔记 / 课后作业与实验） */
  function showNotesHome() {
    $('#notes-home').hidden = false;
    $('#notes-viewer').hidden = true;
    $('#btn-notes-dir').hidden = true;
    refreshNotesTab();
    renderNotesDirByTab();
  }

  function switchNotesTab(tab) {
    S.notesTab = tab === 'hw' ? 'hw' : 'notes';
    $('#notes-search').value = '';
    refreshNotesTab();
    renderNotesDirByTab();
  }

  function refreshNotesTab() {
    const hw = S.notesTab === 'hw' && window.HOMEWORK_DATA;
    $('#notes-tab-notes').classList.toggle('selected', !hw);
    $('#notes-tab-hw').classList.toggle('selected', !!hw);
    $('#notes-search').placeholder = hw ? '搜索作业/实验标题、题目或代码…' : '搜索章节标题或正文关键词…';
    $('#notes-sub').textContent = hw
      ? '课后作业与实验 · ' + window.HOMEWORK_DATA.items.length + ' 篇'
      : '章节笔记 · 共 ' + window.NOTES_DATA.chapters.length + ' 章';
    $('#notes-intro').hidden = !!hw;   // 作业 tab 下不显示笔记使用说明
  }

  function renderNotesDirByTab() {
    if (S.notesTab === 'hw' && window.HOMEWORK_DATA) renderHwDir();
    else renderNotesDir();
  }

  function openNotesChapter(cid) {
    if (!window.NOTES_DATA) return;
    if (!NOTES_MAP) buildNotesMap();
    if (S.view !== 'notes') S.notesFrom = S.view;
    renderNotesChapter(cid);
    $('#notes-home').hidden = true;
    $('#notes-viewer').hidden = false;
    $('#btn-notes-dir').hidden = false;
    switchView('notes');
  }

  function notesChapterTitle(id) {
    const ch = window.NOTES_DATA.chapters.find(function (c) { return c.id === id; });
    return ch ? ch.title : '';
  }

  function renderNotesDir() {
    const dir = $('#notes-dir');
    dir.innerHTML = '';
    const kw = ($('#notes-search').value || '').trim().toLowerCase();
    window.NOTES_DATA.chapters.forEach(function (ch, i) {
      /* 搜索：标题或正文命中 */
      let hit = !kw;
      if (kw) {
        if (ch.title.toLowerCase().indexOf(kw) !== -1) hit = true;
        else hit = ch.blocks.some(function (b) {
          const s = b.t === 'table' ? b.head.join('') + b.rows.join('') : (b.x || '');
          return s.toLowerCase().indexOf(kw) !== -1;
        }) || (ch.landingRaw || '').toLowerCase().indexOf(kw) !== -1
          || (ch.pitfallsRaw || '').toLowerCase().indexOf(kw) !== -1;
      }
      if (!hit) return;

      const n = (ch.refs.p1 || []).length + (ch.refs.p2single || []).length +
        (ch.refs.p2fill || []).length + (ch.refs.ext || []).length;
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'sheet note-card';
      const summary = (ch.blocks.find(function (b) { return b.t === 'p'; }) || {}).x || '';
      card.innerHTML =
        '<span class="nc-kind">' + (ch.kind === 'appendix' ? '附录' : '章') + '</span>' +
        '<span class="nc-name">' + C.escapeHtml(ch.title) + '</span>' +
        (n ? '<span class="nc-count">' + n + ' 题关联</span>' : '<span class="nc-count dim">阅读篇</span>') +
        (summary ? '<span class="nc-sum">' + C.escapeHtml(summary.slice(0, 68)) + '…</span>' : '');
      card.addEventListener('click', function () { openNotesChapter(ch.id); });
      dir.appendChild(card);
    });
    if (!dir.children.length) {
      dir.innerHTML = '<p class="review-empty">没有匹配的章节或内容，换个关键词试试。</p>';
    }
  }

  /* ---------------- 课后作业与实验 ---------------- */

  /* 统一代码块渲染：白天纸质主题 + 语言徽标 */
  function buildCodeBlock(lang, codeText) {
    const wrap = document.createElement('div');
    wrap.className = 'code-wrap';
    const tag = document.createElement('span');
    tag.className = 'code-lang';
    tag.textContent = (lang || 'code').toUpperCase();
    const c = document.createElement('div');
    c.className = 'code';
    String(codeText).split('\n').forEach(function (line) {
      const l = document.createElement('div');
      l.className = 'code-line';
      l.textContent = line;
      c.appendChild(l);
    });
    wrap.appendChild(tag);
    wrap.appendChild(c);
    return wrap;
  }

  function renderHwDir() {
    const dir = $('#notes-dir');
    dir.innerHTML = '';
    const kw = ($('#notes-search').value || '').trim().toLowerCase();
    window.HOMEWORK_DATA.items.forEach(function (it) {
      let hit = !kw;
      if (kw) {
        if (it.title.toLowerCase().indexOf(kw) !== -1 || (it.problem || '').toLowerCase().indexOf(kw) !== -1) hit = true;
        else hit = it.blocks.some(function (b) {
          const s = b.t === 'list' ? b.x.join('') : (b.x || '');
          return String(s).toLowerCase().indexOf(kw) !== -1;
        });
      }
      if (!hit) return;

      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'sheet note-card hw-card';
      card.innerHTML =
        '<span class="nc-kind ' + (it.kind === 'homework' ? 'k-hw' : 'k-lab') + '">' +
          (it.kind === 'homework' ? '作业' : '实验') + '</span>' +
        '<span class="nc-name">' + C.escapeHtml(it.title) + '</span>' +
        '<span class="nc-count">' + it.codes + ' 段答案代码</span>' +
        (it.problem ? '<span class="nc-sum">' + C.escapeHtml(it.problem.replace(/^题目[：:]/, '').slice(0, 72)) + '…</span>' : '');
      card.addEventListener('click', function () { openHomeworkDoc(it.id); });
      dir.appendChild(card);
    });
    if (!dir.children.length) {
      dir.innerHTML = '<p class="review-empty">没有匹配的作业或实验，换个关键词试试。</p>';
    }
  }

  function openHomeworkDoc(id) {
    if (!window.HOMEWORK_DATA) return;
    if (S.view !== 'notes') S.notesFrom = S.view;
    renderHomeworkDoc(id);
    $('#notes-home').hidden = true;
    $('#notes-viewer').hidden = false;
    $('#btn-notes-dir').hidden = false;
    switchView('notes');
  }

  function renderHomeworkDoc(id) {
    const items = window.HOMEWORK_DATA.items;
    const idx = items.findIndex(function (it) { return it.id === id; });
    const it = items[idx];
    if (!it) return;
    $('#notes-sub').textContent = it.title;
    $('#nc-title').textContent = it.title;

    const body = $('#nc-body');
    body.innerHTML = '';
    /* 题目卡（每篇必有：文档显式题目或按小节合成） */
    if (it.problem) {
      const pb = document.createElement('div');
      pb.className = 'hw-problem';
      pb.innerHTML = '<span class="nc-tag">题目</span>' + C.escapeHtml(it.problem.replace(/^题目[：:]/, ''));
      body.appendChild(pb);
    }
    it.blocks.forEach(function (b) {
      if (b.t === 'h2') {
        const h = document.createElement('h3');
        h.className = 'nb-h2';
        h.textContent = b.x;
        body.appendChild(h);
      } else if (b.t === 'p') {
        const p = document.createElement('p');
        p.className = 'nb-p';
        p.innerHTML = b.x;   // 解析端已转义并做受限 markdown 转换
        body.appendChild(p);
      } else if (b.t === 'list') {
        const ul = document.createElement('ul');
        ul.className = 'nb-list';
        b.x.forEach(function (li) {
          const el = document.createElement('li');
          el.innerHTML = li;
          ul.appendChild(el);
        });
        body.appendChild(ul);
      } else if (b.t === 'code') {
        body.appendChild(buildCodeBlock(b.lang, b.x));
      }
    });
    $('#nc-landing').hidden = true;
    $('#nc-pitfalls').hidden = true;

    /* 上/下一篇（按解析顺序：作业1→2→3，实验一→…→六） */
    const prev = items[idx - 1];
    const next = items[idx + 1];
    const bp = $('#btn-nc-prev');
    const bn = $('#btn-nc-next');
    bp.hidden = !prev;
    bn.hidden = !next;
    bp.textContent = prev ? '← ' + prev.title : '';
    bn.textContent = next ? next.title + ' →' : '';
    bp.onclick = prev ? function () { renderHomeworkDoc(prev.id); window.scrollTo(0, 0); } : null;
    bn.onclick = next ? function () { renderHomeworkDoc(next.id); window.scrollTo(0, 0); } : null;
    window.scrollTo(0, 0);
  }

  function renderNotesChapter(cid) {
    const ch = window.NOTES_DATA.chapters.find(function (c) { return c.id === cid; });
    if (!ch) return;
    $('#notes-sub').textContent = ch.title;
    $('#nc-title').textContent = ch.title;

    const body = $('#nc-body');
    body.innerHTML = '';
    ch.blocks.forEach(function (b) {
      if (b.t === 'h2') {
        const h = document.createElement('h3');
        h.className = 'nb-h2';
        h.textContent = b.x;
        body.appendChild(h);
      } else if (b.t === 'p') {
        const p = document.createElement('p');
        p.className = 'nb-p';
        p.innerHTML = C.renderStem(b.x, null).html;
        body.appendChild(p);
      } else if (b.t === 'code') {
        const c = document.createElement('div');
        c.className = 'code';
        String(b.x).split('\n').forEach(function (line) {
          const l = document.createElement('div');
          l.className = 'code-line';
          l.textContent = line;
          c.appendChild(l);
        });
        body.appendChild(c);
      } else if (b.t === 'table') {
        const tb = document.createElement('table');
        tb.className = 'nb-table';
        const thead = document.createElement('thead');
        const trh = document.createElement('tr');
        b.head.forEach(function (h) {
          const th = document.createElement('th');
          th.textContent = h;
          trh.appendChild(th);
        });
        thead.appendChild(trh);
        tb.appendChild(thead);
        const tbody = document.createElement('tbody');
        b.rows.forEach(function (r) {
          const tr = document.createElement('tr');
          r.forEach(function (cell) {
            const td = document.createElement('td');
            td.textContent = cell;
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
        tb.appendChild(tbody);
        body.appendChild(tb);
      }
    });

    /* 题库落点 / 易错点高亮卡 */
    const landing = $('#nc-landing');
    landing.innerHTML = '';
    landing.hidden = !ch.landingRaw;
    if (ch.landingRaw) {
      landing.innerHTML = '<span class="nc-tag">题库落点</span>' + C.escapeHtml(ch.landingRaw.replace(/^题库落点[：:]/, ''));
    }
    const pit = $('#nc-pitfalls');
    pit.innerHTML = '';
    pit.hidden = !ch.pitfallsRaw;
    if (ch.pitfallsRaw) {
      pit.innerHTML = '<span class="nc-tag warn">易错点</span>' + C.escapeHtml(ch.pitfallsRaw.replace(/^易错点[：:]/, ''));
    }

    /* 上/下一章 */
    const idx = window.NOTES_DATA.chapters.indexOf(ch);
    const prev = window.NOTES_DATA.chapters[idx - 1];
    const next = window.NOTES_DATA.chapters[idx + 1];
    const bp = $('#btn-nc-prev');
    const bn = $('#btn-nc-next');
    bp.hidden = !prev;
    bn.hidden = !next;
    bp.textContent = prev ? '← ' + prev.title : '';
    bn.textContent = next ? next.title + ' →' : '';
    bp.onclick = prev ? function () { renderNotesChapter(prev.id); window.scrollTo(0, 0); } : null;
    bn.onclick = next ? function () { renderNotesChapter(next.id); window.scrollTo(0, 0); } : null;
    window.scrollTo(0, 0);
  }

  function initNotes() {
    if (!window.NOTES_DATA) return;
    buildNotesMap();   // 启动即构建题目→章节映射，供判评/复盘/错题本使用
    $('#btn-notes-open').addEventListener('click', openNotes);
    $('#btn-notes-back').addEventListener('click', function () {
      /* 返回来源视图（答题页 / 成绩页 / 首页），会话不受影响 */
      switchView(S.notesFrom === 'notes' || !S.notesFrom ? 'home' : S.notesFrom);
    });
    $('#btn-notes-dir').addEventListener('click', showNotesHome);
    /* 两个 tab：章节笔记 / 课后作业与实验 */
    $$('.notes-tab').forEach(function (btn) {
      btn.addEventListener('click', function () { switchNotesTab(btn.dataset.tab); });
    });
    let t = null;
    $('#notes-search').addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(renderNotesDirByTab, 180);
    });
    /* 使用说明 */
    const usage = $('#notes-usage');
    (window.NOTES_DATA.intro.usage || []).forEach(function (p) {
      const el = document.createElement('p');
      el.className = 'nb-p';
      el.innerHTML = C.renderStem(p, null).html;
      usage.appendChild(el);
    });
  }

  /* ---------------- 组卷 ---------------- */
  function startSession(refs, mode) {
    const items = refs.map(function (r) {
      const q0 = D.parts[r.pi].questions[r.qi];
      /* 选项打乱：按会话一次性重排，回看时顺序保持稳定 */
      const q = S.optShuffle ? C.withShuffledOptions(q0) : q0;
      return {
        pi: r.pi, qi: r.qi,
        q: q,
        selected: [],        // 选择题已选字母
        inputs: [],          // 填空题各空输入
        committed: false,    // 答题模式：已判分锁定
        result: null
      };
    });
    S.session = { mode: mode, items: items, idx: 0, startTs: Date.now(), elapsed: 0, finished: false };
    $('#q-mode').textContent = mode === 'recite' ? '背题模式' : '答题模式';
    /* 背题模式：纯阅读背诵，无作答与交卷 */
    $('#btn-submit').hidden = mode === 'recite';
    $('#palette-box').open = false;
    switchView('quiz');
    startTimer();
    buildPalette();
    renderQuestion();
  }

  /* ---------------- 计时 ---------------- */
  function startTimer() {
    stopTimer();
    S.timer = setInterval(function () {
      if (S.session && !S.session.finished) {
        $('#q-timer').textContent = C.fmtTime(Date.now() - S.session.startTs);
      }
    }, 1000);
    $('#q-timer').textContent = '00:00';
  }
  function stopTimer() {
    if (S.timer) { clearInterval(S.timer); S.timer = null; }
  }
  function sessionElapsed() {
    return S.session.finished ? S.session.elapsed : (Date.now() - S.session.startTs);
  }

  /* ---------------- 答题卡 ---------------- */
  function buildPalette() {
    const box = $('#palette');
    box.innerHTML = '';
    S.session.items.forEach(function (item, i) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pal-btn';
      b.textContent = String(i + 1);
      b.dataset.idx = String(i);
      b.addEventListener('click', function () {
        S.session.idx = i;
        renderQuestion();
      });
      box.appendChild(b);
    });
    updatePalette();
  }

  function updatePalette() {
    const recite = S.session && S.session.mode === 'recite';
    $$('#palette .pal-btn').forEach(function (b) {
      const i = Number(b.dataset.idx);
      const item = S.session.items[i];
      b.classList.toggle('cur', i === S.session.idx);
      if (recite) {
        /* 背题模式：标记已浏览 */
        b.classList.toggle('done', !!item.seen);
      } else {
        /* 编程题无需作答，视为已处理 */
        b.classList.toggle('done', C.isAnswered(item) || item.committed || item.q.type === 'code');
      }
    });
  }

  /* ---------------- 题目渲染 ---------------- */
  function curItem() { return S.session.items[S.session.idx]; }

  function partShort(pi) {
    return (D.parts[pi] && D.parts[pi].label) || ('第' + (pi + 1) + '部分');
  }

  function srcLabel(item) {
    const q = item.q;
    return partShort(item.pi) + (q.set ? ' · 第' + q.set + '套' : '') + ' · 原卷第 ' + q.no + ' 题';
  }

  function renderQuestion() {
    const item = curItem();
    const q = item.q;
    const sess = S.session;
    const isQuiz = sess.mode === 'quiz';
    const recite = !isQuiz;              // 背题模式：直接显示答案，纯阅读背诵
    const revealed = isQuiz && item.committed;

    /* 顶栏 */
    $('#q-pos').textContent = '第 ' + (sess.idx + 1) + ' / ' + sess.items.length + ' 题';
    $('#q-bar').style.width = ((sess.idx + 1) / sess.items.length * 100).toFixed(1) + '%';

    /* 题头 */
    $('#q-type').textContent = C.TYPE_LABEL[q.type];
    $('#q-type').className = 'q-type t-' + q.type;
    $('#q-src').textContent = srcLabel(item);
    $('#q-score').textContent = q.score ? (q.score + ' 分') : '';
    updateBookmarkBtn(item);

    /* 题干 */
    /* 背题模式不生成输入框；答题模式仅当下划线数与空数一致时才内联输入框，
       若空落在代码块内，renderStem 会整体降级为“第N空”编号输入框 */
    const runs = q.type === 'fill' ? (q.stem.match(/_{2,}/g) || []).length : 0;
    const inlineBlanks = q.type === 'fill' && !recite && runs === q.answer.length ? q.answer.length : null;
    const stemRender = C.renderStem(q.stem, inlineBlanks);
    const stemEl = $('#q-stem');
    stemEl.innerHTML = stemRender.html;

    /* 作答区 */
    const body = $('#q-body');
    body.innerHTML = '';
    if (q.type === 'code') {
      /* 编程题：自评不计分 */
      const note = document.createElement('div');
      note.className = 'code-note';
      note.textContent = recite
        ? '编程题 · 自评不计分：参考答案已在下方，对照记忆。'
        : '编程题 · 自评不计分：先在本地或纸上完成编码，点击「下一题（查看答案）」对照参考答案自评。';
      body.appendChild(note);
    } else if (q.type === 'fill') {
      renderFillBody(body, item, stemRender, revealed, recite);
    } else {
      renderChoiceBody(body, item, revealed, recite);
    }
    if (recite && q.type === 'fill') inlineFillAnswers(stemEl, q);

    /* 判评区：答题模式已判分 → 判定回显；背题模式 → 参考答案 + 解析 */
    const v = $('#q-verdict');
    if (recite) {
      v.hidden = false;
      renderReciteAnswer(v, item);
    } else if (revealed) {
      v.hidden = false;
      renderVerdict(v, item);
    } else {
      v.hidden = true;
      v.innerHTML = '';
    }

    /* 导航按钮 */
    $('#btn-prev').disabled = sess.idx === 0;
    const next = $('#btn-next');
    if (isQuiz) {
      if (q.type === 'code' && !revealed) {
        next.textContent = '下一题（查看答案）→';
      } else {
        next.textContent = revealed ? (sess.idx === sess.items.length - 1 ? '查看成绩 →' : '下一题 →') : '下一题（判分）→';
      }
    } else {
      next.textContent = sess.idx === sess.items.length - 1 ? '完成背诵 ✓' : '下一题 →';
    }

    /* 提示语 */
    const hint = $('#q-hint');
    if (recite) hint.textContent = '答案已直接标注：正确选项打勾、填空已填入，结合解析记忆';
    else if (q.type === 'code' && !revealed) hint.textContent = '自评题：对照参考答案自行判断掌握程度';
    else if (q.type === 'multiple' && !revealed) hint.textContent = '多选：点击选中多项';
    else if (q.type === 'fill' && !revealed) hint.textContent = '在横线处填写答案';
    else if (isQuiz && !revealed) hint.textContent = '选择后点击「下一题」立即判分';
    else hint.textContent = '';

    if (recite) { item.seen = true; }   // 背诵进度：已浏览标记
    updatePalette();
  }

  /* 背题模式：把题干内联空位（若有）替换为静态参考答案 */
  function inlineFillAnswers(stemEl, q) {
    Array.prototype.slice.call(stemEl.querySelectorAll('input[data-blank]')).forEach(function (inp) {
      const i = Number(inp.dataset.blank);
      const span = document.createElement('span');
      span.className = 'ans-inline';
      span.title = '第' + (i + 1) + '空参考答案';
      span.textContent = q.answer[i] || '';
      inp.replaceWith(span);
    });
  }

  /* 背题模式答案区：参考答案 + 解析 + 知识点入口 */
  function renderReciteAnswer(box, item) {
    const q = item.q;
    box.innerHTML = '';

    const stamp = document.createElement('div');
    stamp.className = 'stamp stamp-ref';
    stamp.textContent = q.type === 'code' ? '参考答案' : '正确答案';
    box.appendChild(stamp);

    if (q.type === 'fill') {
      const list = document.createElement('div');
      list.className = 'v-blanks';
      q.answer.forEach(function (ans, i) {
        const row = document.createElement('div');
        row.className = 'v-blank ok';
        row.innerHTML =
          '<span class="vb-no">第' + (i + 1) + '空</span>' +
          '<span class="vb-item"><i>参考答案</i><b>' + C.escapeHtml(ans) + '</b></span>';
        list.appendChild(row);
      });
      box.appendChild(list);
    } else if (q.type === 'code') {
      const ref = document.createElement('div');
      ref.className = 'v-ans';
      ref.innerHTML = '<i class="v-self">自评题 · 不计分</i>' + C.renderStem((q.answer && q.answer[0]) || '略', null).html;
      box.appendChild(ref);
    } else {
      const line = document.createElement('div');
      line.className = 'v-ans ok';
      line.innerHTML = '正确答案：<b>' + q.answer.join('') + '</b>';
      box.appendChild(line);
    }

    if (q.analysis) {
      const ana = document.createElement('div');
      ana.className = 'v-analysis';
      ana.innerHTML = '<span class="va-tag">解析 · 仅供参考</span>' + C.renderStem(q.analysis, null).html;
      box.appendChild(ana);
    }
    appendNotesLink(box, item);
  }

  function renderChoiceBody(body, item, revealed, recite) {
    const q = item.q;
    const showAns = revealed || recite;      // 背题模式直接标注正确答案
    const wrap = document.createElement('div');
    wrap.className = 'opts' + (showAns ? ' locked' : '');
    q.options.forEach(function (opt) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'opt';
      btn.dataset.key = opt.key;

      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = opt.key;

      const txt = document.createElement('span');
      txt.className = 'opt-text';
      txt.innerHTML = C.renderStem(opt.text || '', null).html;

      const mark = document.createElement('span');
      mark.className = 'opt-mark';
      mark.textContent = (!recite && item.selected.indexOf(opt.key) !== -1) ? '✓' : '';

      btn.appendChild(key);
      btn.appendChild(txt);
      btn.appendChild(mark);
      applyOptionState(btn, item, showAns, recite);

      if (!showAns) {
        btn.addEventListener('click', function () {
          if (item.committed) return;
          if (q.type === 'multiple') {
            const i = item.selected.indexOf(opt.key);
            if (i === -1) item.selected.push(opt.key); else item.selected.splice(i, 1);
          } else {
            item.selected = [opt.key];
          }
          renderQuestion();
        });
      }
      wrap.appendChild(btn);
    });
    body.appendChild(wrap);
  }

  /* 选项状态样式：选中 / 正确 / 错误 / 淡化；recite 时仅标注正确项 */
  function applyOptionState(btn, item, revealed, recite) {
    const key = btn.dataset.key;
    const q = item.q;
    const picked = item.selected.indexOf(key) !== -1;
    btn.classList.toggle('selected', picked && !revealed);
    if (revealed) {
      const isAns = q.answer.indexOf(key) !== -1;
      btn.classList.toggle('correct', isAns);
      btn.classList.toggle('wrong', !recite && !isAns && picked);
      btn.classList.toggle('dim', !recite && !isAns && !picked);
      if (isAns) btn.querySelector('.opt-mark').textContent = '✓';
    }
  }

  function renderFillBody(body, item, stemRender, revealed, recite) {
    /* 题干中未能内联的空 → 下方编号行；
       背题模式显示参考答案，答题模式显示输入框（判分后锁定） */
    const blanks = item.q.answer.length;
    const missing = [];
    for (let i = stemRender.inline; i < blanks; i++) missing.push(i);

    if (missing.length) {
      const rows = document.createElement('div');
      rows.className = 'fill-rows' + (revealed || recite ? ' locked' : '');
      missing.forEach(function (i) {
        const row = document.createElement('label');
        row.className = 'fill-row';
        const tag = document.createElement('span');
        tag.className = 'fr-label';
        tag.textContent = '第' + (i + 1) + '空';
        row.appendChild(tag);
        if (recite) {
          const ans = document.createElement('span');
          ans.className = 'fr-ans';
          ans.textContent = item.q.answer[i] || '';
          row.appendChild(ans);
        } else {
          row.appendChild(makeFillInput(item, i, revealed));
        }
        rows.appendChild(row);
      });
      body.appendChild(rows);
    }
    if (!recite) {
      bindFillInputs(item, revealed);
      styleFillInputs(item, revealed);
    }
  }

  function makeFillInput(item, i, revealed) {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.dataset.blank = String(i);
    inp.value = item.inputs[i] || '';
    inp.autocomplete = 'off';
    inp.autocapitalize = 'off';
    inp.spellcheck = false;
    inp.setAttribute('aria-label', '第' + (i + 1) + '空');
    if (revealed) { inp.readOnly = true; inp.disabled = true; }
    return inp;
  }

  function bindFillInputs(item, revealed) {
    $$('#q-stem input[data-blank], #q-body input[data-blank]').forEach(function (inp) {
      const i = Number(inp.dataset.blank);
      inp.value = item.inputs[i] || '';   // 回看时恢复已输入内容
      if (revealed) { inp.readOnly = true; inp.disabled = true; }
      else {
        inp.addEventListener('input', function () {
          item.inputs[i] = inp.value;
          updatePalette();
        });
        inp.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); onNext(); }
        });
      }
    });
  }

  function styleFillInputs(item, revealed) {
    if (!revealed || !item.result || !item.result.per) return;
    $$('#q-stem input[data-blank], #q-body input[data-blank]').forEach(function (inp) {
      const i = Number(inp.dataset.blank);
      const r = item.result.per[i];
      if (!r) return;
      inp.classList.add(r.ok ? 'ok' : 'bad');
      inp.value = r.user;
      inp.title = '参考答案：' + r.ref;
    });
  }

  /* ---------------- 判评显示（答题模式逐题回显） ---------------- */
  function renderVerdict(box, item) {
    const q = item.q;
    const res = item.result;
    box.innerHTML = '';

    /* 编程题：只展示参考答案，无对错判定 */
    if (q.type === 'code') {
      const tag = document.createElement('div');
      tag.className = 'stamp stamp-ref';
      tag.textContent = '参考答案';
      box.appendChild(tag);
      const ref = document.createElement('div');
      ref.className = 'v-ans';
      ref.innerHTML = '<i class="v-self">自评题 · 不计分</i>参考答案：<b>' + C.escapeHtml((q.answer && q.answer[0]) || '略') + '</b>';
      box.appendChild(ref);
      return;
    }

    const stamp = document.createElement('div');
    stamp.className = 'stamp ' + (res.correct ? 'stamp-ok' : 'stamp-bad');
    stamp.textContent = res.correct ? '回答正确' : '回答错误';
    box.appendChild(stamp);

    if (q.type === 'fill' && res.per) {
      const list = document.createElement('div');
      list.className = 'v-blanks';
      res.per.forEach(function (r, i) {
        const row = document.createElement('div');
        row.className = 'v-blank ' + (r.ok ? 'ok' : 'bad');
        row.innerHTML =
          '<span class="vb-no">第' + (i + 1) + '空</span>' +
          '<span class="vb-item"><i>你的答案</i><b>' + (C.escapeHtml(r.user) || '（空）') + '</b></span>' +
          '<span class="vb-item"><i>参考答案</i><b>' + C.escapeHtml(r.ref) + '</b></span>' +
          '<span class="vb-mark">' + (r.ok ? '✓' : '✗') + '</span>';
        list.appendChild(row);
      });
      box.appendChild(list);
    } else {
      const line = document.createElement('div');
      line.className = 'v-ans ' + (res.correct ? 'ok' : 'bad');
      line.innerHTML = '正确答案：<b>' + q.answer.join('') + '</b>' +
        (res.correct ? '' : '　·　你的答案：<b class="u-ans">' + (item.selected.join('') || '（未选）') + '</b>');
      box.appendChild(line);
    }

    if (q.analysis) {
      const ana = document.createElement('div');
      ana.className = 'v-analysis';
      ana.innerHTML = '<span class="va-tag">解析 · 仅供参考</span>' + C.renderStem(q.analysis, null).html;
      box.appendChild(ana);
    }
    /* 答错 → 知识库对应章节入口 */
    if (!res.correct) appendNotesLink(box, item);
  }

  /* ---------------- 导航 ---------------- */
  function commitCurrent(item) {
    if (item.committed) return false;
    if (item.q.type === 'code') {
      /* 编程题：无自动判分，仅标记为“已对照参考答案” */
      item.committed = true;
      item.result = null;
      return true;
    }
    C.gradeItem(item);
    item.committed = true;
    if (item.result && !item.result.correct) wbRecordWrong(item.pi, item.qi);
    return true;
  }

  function onNext() {
    const sess = S.session;
    if (!sess || sess.finished) return;
    const item = curItem();
    const last = sess.idx === sess.items.length - 1;

    if (sess.mode === 'quiz') {
      const needCommit = !item.committed && (C.isAnswered(item) || item.q.type === 'code');
      if (needCommit) {
        commitCurrent(item);
        renderQuestion();
        $('#q-verdict').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
      }
      if (last) { finishSession(); return; }
      sess.idx += 1;
      renderQuestion();
    } else {
      /* 背题模式：下一题 = 前进；最后一题 = 完成背诵（直接结束，无批改） */
      if (last) { exitQuiz(); return; }
      sess.idx += 1;
      renderQuestion();
    }
  }

  function onPrev() {
    const sess = S.session;
    if (!sess || sess.finished || sess.idx === 0) return;
    sess.idx -= 1;
    renderQuestion();
  }

  function unansweredCount() {
    /* 编程题为自评题，无需作答，不计入未答提醒 */
    return S.session.items.filter(function (it) {
      return it.q.type !== 'code' && !C.isAnswered(it) && !it.committed;
    }).length;
  }

  function confirmIfUnanswered(msg) {
    const n = unansweredCount();
    if (n > 0) return window.confirm(msg.replace('{n}', String(n)));
    return true;
  }

  function tryFinish() {
    if (confirmIfUnanswered('还有 {n} 题未作答，确定交卷吗？未作答题目将按答错计入。')) {
      finishSession();
    }
  }

  function exitQuiz() {
    const anyProgress = S.session && S.session.items.some(function (it) { return C.isAnswered(it) || it.committed; });
    if (anyProgress && !window.confirm('退出后将丢弃本次作答记录，确定退出吗？')) return;
    stopTimer();
    S.session = null;
    switchView('home');
  }

  /* ---------------- 交卷与成绩 ---------------- */
  function finishSession() {
    const sess = S.session;
    if (!sess || sess.finished) return;
    sess.finished = true;
    sess.elapsed = Date.now() - sess.startTs;
    stopTimer();

    /* 未判分的已答题（背题模式全部 / 答题模式漏判的）统一在此批改 */
    sess.items.forEach(function (it) {
      if (it.q.type === 'code') {
        it.committed = true;          /* 编程题交卷后即展示参考答案 */
        return;
      }
      if (!it.result && C.isAnswered(it)) {
        C.gradeItem(it);
        if (it.result && !it.result.correct) wbRecordWrong(it.pi, it.qi);
      }
    });

    renderResult();
    switchView('result');
  }

  function renderResult() {
    const sess = S.session;
    const items = sess.items;
    /* 编程题为自评题，不计入正确率与对错统计 */
    const graded = items.filter(function (it) { return it.q.type !== 'code'; });
    const codeCount = items.length - graded.length;
    const total = graded.length;
    const correct = graded.filter(function (it) { return it.result && it.result.correct; }).length;
    const answered = graded.filter(function (it) { return it.result; }).length;
    const wrong = answered - correct;
    const unanswered = total - answered;
    const rate = total ? Math.round(correct / total * 100) : 0;

    $('#r-rate').textContent = rate + '%';
    $('#r-mode').textContent = (sess.mode === 'recite' ? '背题模式' : '答题模式') +
      ' · 共 ' + items.length + ' 题' +
      (codeCount ? '（含编程题 ' + codeCount + ' 题 · 自评不计分）' : '');
    $('#r-correct').textContent = String(correct);
    $('#r-wrong').textContent = String(wrong);
    $('#r-unanswered').textContent = String(unanswered);
    $('#r-time').textContent = C.fmtTime(sess.elapsed);

    const word = rate >= 85 ? '优秀' : rate >= 70 ? '良好' : rate >= 60 ? '及格' : '继续努力';
    $('#r-word').textContent = word;

    $('#tab-all').textContent = String(items.length);
    $('#tab-wrong').textContent = String(wrong);
    $('#tab-unanswered').textContent = String(unanswered);

    $('#btn-wrong').disabled = (wrong + unanswered) === 0;
    S.reviewFilter = 'all';
    $$('#review-tabs .rtab').forEach(function (t) { t.classList.toggle('active', t.dataset.filter === 'all'); });
    renderReview();
  }

  function renderReview() {
    const sess = S.session;
    const list = $('#review-list');
    list.innerHTML = '';

    const items = sess.items.map(function (it, i) { return { it: it, i: i }; }).filter(function (x) {
      const it = x.it;
      if (S.reviewFilter === 'wrong') return !!it.result && !it.result.correct;
      if (S.reviewFilter === 'unanswered') return !it.result && it.q.type !== 'code';
      return true;
    });

    $('#review-empty').hidden = items.length > 0;
    items.forEach(function (x) { list.appendChild(buildReviewCard(x.it, x.i)); });
  }

  function buildReviewCard(item, order) {
    const q = item.q;
    const card = document.createElement('article');
    card.className = 'sheet review-card' + (item.result ? (item.result.correct ? ' rc-ok' : ' rc-bad') : ' rc-skip');

    /* 头 */
    const head = document.createElement('header');
    head.className = 'q-head';
    const mark = q.type === 'code' ? '— 自评'
      : (item.result ? (item.result.correct ? '✓ 正确' : '✗ 答错') : '— 未答');
    head.innerHTML =
      '<span class="q-type t-' + q.type + '">' + C.TYPE_LABEL[q.type] + '</span>' +
      '<span class="q-src">' + srcLabel(item) + '</span>' +
      '<span class="r-mark ' + (item.result ? (item.result.correct ? 'ok' : 'bad') : 'skip') + '">' + mark + '</span>';
    card.appendChild(head);

    /* 题干（与 renderQuestion 相同的内联规则） */
    const runs = q.type === 'fill' ? (q.stem.match(/_{2,}/g) || []).length : 0;
    const inlineBlanks = q.type === 'fill' && runs === q.answer.length ? q.answer.length : null;
    const stemRender = C.renderStem(q.stem, inlineBlanks);
    const stem = document.createElement('div');
    stem.className = 'q-stem';
    stem.innerHTML = stemRender.html;
    card.appendChild(stem);

    /* 选项或填空或编程 */
    if (q.type === 'code') {
      /* 编程题：参考答案自评，无选项与对错 */
      const line = document.createElement('div');
      line.className = 'v-ans';
      line.innerHTML = '<i class="v-self">自评题 · 不计分</i>参考答案：<b>' + C.escapeHtml((q.answer && q.answer[0]) || '略') + '</b>';
      card.appendChild(line);
    } else if (q.type !== 'fill') {
      const wrap = document.createElement('div');
      wrap.className = 'opts locked';
      q.options.forEach(function (opt) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'opt';
        btn.dataset.key = opt.key;
        btn.innerHTML =
          '<span class="key">' + C.escapeHtml(opt.key) + '</span>' +
          '<span class="opt-text">' + C.renderStem(opt.text || '', null).html + '</span>' +
          '<span class="opt-mark">' + (item.selected.indexOf(opt.key) !== -1 ? '✓' : '') + '</span>';
        applyOptionState(btn, item, true);
        btn.disabled = true;
        wrap.appendChild(btn);
      });
      card.appendChild(wrap);
    } else {
      /* 填空：题干输入框回显 + 未内联的空列为表格 */
      if (item.result && item.result.per) styleFillInputsStatic(stem, item.result.per, stemRender.inline);
      if (stemRender.inline < q.answer.length) {
        const rows = document.createElement('div');
        rows.className = 'fill-rows locked';
        for (let i = stemRender.inline; i < q.answer.length; i++) {
          const r = item.result && item.result.per ? item.result.per[i] : null;
          const row = document.createElement('div');
          row.className = 'v-blank ' + (r && r.ok ? 'ok' : 'bad');
          row.innerHTML =
            '<span class="vb-no">第' + (i + 1) + '空</span>' +
            '<span class="vb-item"><i>你的答案</i><b>' + (C.escapeHtml(r ? r.user : '') || '（空）') + '</b></span>' +
            '<span class="vb-item"><i>参考答案</i><b>' + C.escapeHtml(q.answer[i]) + '</b></span>' +
            '<span class="vb-mark">' + (r && r.ok ? '✓' : '✗') + '</span>';
          rows.appendChild(row);
        }
        card.appendChild(rows);
      }
    }

    /* 答案与解析 */
    if (q.type === 'code') {
      /* 已在上方展示参考答案 */
    } else if (q.type !== 'fill') {
      const line = document.createElement('div');
      line.className = 'v-ans ' + (item.result && item.result.correct ? 'ok' : 'bad');
      line.innerHTML = '正确答案：<b>' + q.answer.join('') + '</b>' +
        '　·　你的答案：<b class="u-ans">' + (item.selected.join('') || '（未选）') + '</b>';
      card.appendChild(line);
    } else if (!item.result) {
      const line = document.createElement('div');
      line.className = 'v-ans bad';
      line.innerHTML = '参考答案：<b>' + q.answer.map(C.escapeHtml).join(' ／ ') + '</b>';
      card.appendChild(line);
    }

    if (q.analysis) {
      const ana = document.createElement('div');
      ana.className = 'v-analysis';
      ana.innerHTML = '<span class="va-tag">解析 · 仅供参考</span>' + C.renderStem(q.analysis, null).html;
      card.appendChild(ana);
    }

    /* 错题本 + 知识点操作 */
    const acts = document.createElement('div');
    acts.className = 'rc-actions';
    const nb = makeNotesBtn(item, 'btn ghost sm notes-link');
    if (nb) acts.appendChild(nb);
    const bk = document.createElement('button');
    bk.type = 'button';
    bk.className = 'btn ghost sm wb-toggle' + (wbHas(item.pi, item.qi) ? ' on' : '');
    bk.textContent = wbHas(item.pi, item.qi) ? '✓ 已在错题本' : '＋ 加入错题本';
    bk.addEventListener('click', function () {
      if (wbHas(item.pi, item.qi)) wbRemove(item.pi, item.qi);
      else wbAdd(item.pi, item.qi);
      bk.textContent = wbHas(item.pi, item.qi) ? '✓ 已在错题本' : '＋ 加入错题本';
      bk.classList.toggle('on', wbHas(item.pi, item.qi));
    });
    acts.appendChild(bk);
    card.appendChild(acts);
    return card;
  }

  /* 复盘页：静态回显题干内输入框（含判定配色），不做事件绑定 */
  function styleFillInputsStatic(stemEl, per, inlineCount) {
    Array.prototype.forEach.call(stemEl.querySelectorAll('input[data-blank]'), function (inp, order) {
      const r = per[order];
      inp.readOnly = true;
      inp.disabled = true;
      if (!r) return;
      inp.classList.add(r.ok ? 'ok' : 'bad');
      inp.value = r.user;
      inp.title = '参考答案：' + r.ref;
      void inlineCount;
    });
  }

  /* ---------------- 事件绑定 ---------------- */
  function initQuiz() {
    $('#btn-prev').addEventListener('click', onPrev);
    $('#btn-next').addEventListener('click', onNext);
    $('#btn-exit').addEventListener('click', exitQuiz);
    $('#btn-submit').addEventListener('click', tryFinish);
    $('#btn-bookmark').addEventListener('click', function () { toggleBookmark(curItem()); });
  }

  function initResult() {
    $('#btn-home').addEventListener('click', function () {
      S.session = null;
      switchView('home');
      updateStartHint();
    });
    $('#btn-again').addEventListener('click', function () {
      const sess = S.session;
      if (!sess) return;
      const refs = sess.items.map(function (it) { return { pi: it.pi, qi: it.qi }; });
      startSession(refs, sess.mode);
    });
    $('#btn-wrong').addEventListener('click', function () {
      const sess = S.session;
      if (!sess) return;
      const refs = sess.items
        .filter(function (it) { return it.q.type !== 'code' && (!it.result || !it.result.correct); })
        .map(function (it) { return { pi: it.pi, qi: it.qi }; });
      if (refs.length) startSession(refs, sess.mode);
    });
    $$('#review-tabs .rtab').forEach(function (t) {
      t.addEventListener('click', function () {
        S.reviewFilter = t.dataset.filter;
        $$('#review-tabs .rtab').forEach(function (x) { x.classList.toggle('active', x === t); });
        renderReview();
      });
    });
  }

  /* ---------------- 键盘快捷键 ---------------- */
  function initKeyboard() {
    document.addEventListener('keydown', function (e) {
      if (S.view !== 'quiz' || !S.session || S.session.finished) return;
      const tag = (e.target && e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
      const item = curItem();
      const editable = S.session.mode === 'quiz' && !item.committed;

      if (e.key === 'Enter' && !typing) { e.preventDefault(); onNext(); return; }
      if (e.key === 'ArrowLeft' && !typing) { onPrev(); return; }
      if (e.key === 'ArrowRight' && !typing) { onNext(); return; }
      if (!typing && editable && item.q.type !== 'fill' && /^[A-Ha-h]$/.test(e.key)) {
        const key = e.key.toUpperCase();
        const opt = item.q.options.find(function (o) { return o.key === key; });
        if (opt) {
          if (item.q.type === 'multiple') {
            const i = item.selected.indexOf(key);
            if (i === -1) item.selected.push(key); else item.selected.splice(i, 1);
          } else {
            item.selected = [key];
          }
          renderQuestion();
        }
      }
    });
  }

  /* ---------------- 启动 ---------------- */
  /* 应用启动：数据解密成功后执行（此前所有 DOM 初始化都未进行） */
  function bootApp(quiz, notes, homework) {
    window.QUIZ_DATA = quiz;
    window.NOTES_DATA = notes;
    if (homework) window.HOMEWORK_DATA = homework;
    D = quiz;
    S.scopes = new Set(allScopeIds());
    initHome();
    initQuiz();
    initResult();
    initWrongbook();
    initPick();
    initNotes();
    initKeyboard();
  }

  function init() {
    initLock();
    /* 记住期内：用本机缓存的派生密钥直接解密（免输密码） */
    const stored = storedUnlockKey();
    if (stored && window.SECURE_DATA) {
      const r = C.secureDecryptWithKey(stored, window.SECURE_DATA);
      if (r) {
        bootApp(r.quiz, r.notes, r.homework);
        enterApp();
        return;
      }
      try { localStorage.removeItem(LS_KEYSTORE); } catch (e) { /* 忽略 */ }
    }
    /* 未解锁：仅初始化锁屏，其余视图等解密成功后再初始化 */
    switchView('lock');
    setTimeout(function () { $('#lock-pw').focus(); }, 50);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
