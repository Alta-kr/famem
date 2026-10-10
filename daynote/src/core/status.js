'use strict';

// 현재 상태 엔진 (DN.statusCore, 줄여 ST) — "지금 어떤 시간인가"(상태)와 "이 할 일은 어느 쪽 일인가"(맥락)를 만나게 해
// 할 일마다 띄움(up)·보통(normal)·내림(down)·숨김(hide)을 정한다.
//
// ── 지키는 것 ────────────────────────────────────────────────────
//   I1. presence.activatedAt 이 없거나 기능을 끄면 effective·view 가 null 이다 → 추천·오늘 목록이 지금과 같다.
//   I2. 상태 바꾸기(setStatus·revert·toGuess·wake·settle·confirmGuess …)는 state.presence 만 바꾼다.
//       tasks·blocks·notes 는 건드리지 않는다. 할 일 데이터를 바꾸는 것은 setTaskContext·setTaskAtMode 뿐이다(라벨 있는 mutate 안에서 부른다).
//   I4. 모든 함수는 now 를 받는다. 벽시계(Date.now·인자 없는 new Date)를 읽지 않는다.
//   · 시계는 숨기지 않는다: 짐작한 상태는 내리기만 한다(띄움 → 보통, 숨김 → 내림). 숨김은 사용자가 말하거나 고른 상태에서만.
//   · 모르면 숨기지 않는다: 맥락이 없거나 동점이거나 약한 힌트뿐이면 숨지 않는다.
//   · 약속은 상태보다 강하다: 마감 돌파, 지금 잡힌 작업 시간, 이 상태에서 시작한 일은 올라온다.
//
// ── 의존성 ───────────────────────────────────────────────────────
//   dates·model·statusWords. 선택: slots(근무 시간 정리 — 없으면 같은 규칙의 내부 함수), adapt(배운 맥락 — 없거나
//   prefs.learning === false 면 학습 단계를 건너뛴다). recommend 는 이 모듈을 모른다(평범한 statusView 데이터만 받는다).
//
// ── 저장하는 것 / 계산하는 것 ─────────────────────────────────────
//   저장: state.presence(현재 상태·기록·예산), task.context/contextSource(사용자·AI 값만), task.atMode/atModeSource.
//   계산: 유효 상태(짐작 포함), 규칙·학습·프로젝트·힌트 맥락, 보임 수준. 사전이 좋아지면 옛 할 일에도 바로 반영된다.
//
// ── 부르는 쪽이 알아 둘 것 ──────────────────────────────────────
//   · Detection 은 setStatus 의 target 으로 그대로 넘길 수 있다. id 가 null 이면 '시간표대로'(wake·바탕 없는 복귀).
//     단 role 'idle'(한가해)은 상태를 바꾸지 않는다 — setStatus 에 넘기지 말고 '다음 할 일'을 부른다.
//     낮잠(끝 시각이 있는 잠)에서 wake 하면 id 는 null 이 아니라 낮잠 전 상태다(ST.wake 와 같은 결과).
//   · budgetOk·useBudget·overtimeDue·dismissOvertime 은 (state, profile, now) 와 STATUS §13 의 (state, now) 를 둘 다 받는다.
//   · setStatus 에 같은 덧씌움 id 와 minutes 를 주면 '지금부터 N분'으로, until 을 주면 그 시각으로 연장한다([5분 더]는 until).
//   · view.id/label/category 는 바탕 상태다. 덧씌움은 view.overlay 에 따로 있다(목록은 바탕으로 나눈다).
//   · profile 의 statuses·contexts·matrix·rawMatrix 는 프로토타입 없는 객체다('constructor' 같은 이름이 걸리지 않게).
//     Object.keys·for…in 은 되지만 .hasOwnProperty 는 없다. 메모된 값이므로 고치지 않는다.
//   · rawMatrix = 공식 + 프리셋 + afterWork (사용자 칸 policy 전), matrix = 그 위에 policy 를 덮은 실제 표.

(function (factory) {
  var node = typeof module !== 'undefined' && module.exports;
  function optional(name) { try { return require('./' + name); } catch (e) { return null; } }
  var deps = node
    ? { dates: require('./dates'), model: require('./model'), words: require('./statusWords'), slots: optional('slots'), adapt: optional('adapt') }
    : { dates: window.Daynote.dates, model: window.Daynote.model, words: window.Daynote.statusWords,
        slots: window.Daynote.slots || null, adapt: window.Daynote.adapt || null };
  var api = factory(deps.dates, deps.model, deps.words, deps.slots, deps.adapt);
  if (node) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.statusCore = api; }
})(function (D, M, SW, SL, AD) {
  var MIN = 60000, HOUR = 3600000, DAY = 86400000;
  var DEFAULT_WORK_HOURS = { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] };
  var LEVEL_RANK = { up: 0, normal: 1, down: 2, hide: 3 };
  var LOG_MAX = 60, LOG_TEXT_MAX = 40, SHOWN_MAX = 50, STATUS_LINE_MAX = 80;
  var MAX_WHEN = 5, MAX_EXTRA = 5, BLOCK_SOON_MIN = 30, OVERTIME_MIN = 90, SIGNAL_DAYS = 14, SIGNAL_NEED = 3;
  var MAX_CUSTOM_STATUSES = 10, MAX_CUSTOM_CONTEXTS = 6, MAX_WORDS = 30;
  var AUTO_SOURCES = { until: true, expire: true, wake: true };
  var GUESS_LABEL = { before: '출근 전', after: '퇴근 후' };
  var OTHER_LABEL = '기타';
  var GONE_LABEL = '지운 맥락';

  // ------------------------------------------------------------------ 작은 도우미
  function toDate(v) { return v instanceof Date ? new Date(v.getTime()) : new Date(v); }
  function iso(v) { return toDate(v).toISOString(); }
  function ms(v) { return v instanceof Date ? v.getTime() : new Date(v).getTime(); }
  function has(list, x) { return !!list && list.indexOf(x) !== -1; }
  function tight(s) { return String(s == null ? '' : s).replace(/\s+/g, ''); }
  function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function wordRe(w) { return String(w).trim().split(/\s+/).map(escRe).join('\\s*'); }
  // 띄어쓰기를 가리지 않는 정규식 ('정시퇴근' 색인이 '정시 퇴근' 도 잡는다 — 색인은 공백 뺀 key 로 한 번만 둔다)
  function flexRe(key) { return String(key).replace(/\s+/g, '').split('').map(escRe).join('\\s*'); }
  function byLenDesc(a, b) { return tight(b).length - tight(a).length; }
  function alt(list) { return list.slice().sort(byLenDesc).map(wordRe).join('|'); }
  function nfc(s) { s = String(s == null ? '' : s); return s.normalize ? s.normalize('NFC') : s; }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function fnv(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36);
  }
  // 사용자 입력·저장값으로 객체를 찾을 때 ('constructor' 같은 이름이 Object.prototype 에 걸리지 않게)
  function own(o, k) { return o != null && k != null && Object.prototype.hasOwnProperty.call(o, k); }
  function dict() { return Object.create(null); }
  function hasBatchim(s) {
    var c = String(s || '').replace(/[\s’'")\]]+$/, '');
    if (!c) return false;
    var code = c.charCodeAt(c.length - 1);
    if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
    if (/[0-9]$/.test(c)) return /[013678]$/.test(c);
    return /[lmnr]$/i.test(c);
  }
  function iraJosa(label) { return hasBatchim(label) ? '이라' : '라'; }

  // ------------------------------------------------------------------ 근무 시간 (slots 가 없으면 같은 규칙의 내부 함수)
  function parseHm(s) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(s == null ? '' : s).trim());
    if (!m) return null;
    var h = Number(m[1]), mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }
  function fmtHm(min) { return D.pad(Math.floor(min / 60)) + ':' + D.pad(min % 60); }
  function normalizeWorkHoursLocal(wh) {
    wh = wh && typeof wh === 'object' ? wh : {};
    var s = parseHm(wh.start), e = parseHm(wh.end);
    var start = DEFAULT_WORK_HOURS.start, end = DEFAULT_WORK_HOURS.end;
    if (s != null && e != null && s < e) { start = fmtHm(s); end = fmtHm(e); }
    var days = [];
    if (Array.isArray(wh.days)) {
      wh.days.forEach(function (d) { if (typeof d === 'number' && d % 1 === 0 && d >= 0 && d <= 6 && days.indexOf(d) === -1) days.push(d); });
      days.sort(function (a, b) { return a - b; });
    }
    if (!days.length) days = DEFAULT_WORK_HOURS.days.slice();
    return { start: start, end: end, days: days };
  }
  function normalizeWorkHours(wh) {
    var out = SL && typeof SL.normalizeWorkHours === 'function' ? SL.normalizeWorkHours(wh) : null;
    if (!out || parseHm(out.start) == null || parseHm(out.end) == null || !Array.isArray(out.days)) out = normalizeWorkHoursLocal(wh);
    return { start: out.start, end: out.end, days: out.days.slice() };
  }
  // 그날 0시 + min 분 (min 은 하루를 넘지 않는다)
  function atMin(day, min) { var d = D.startOfDay(day); d.setHours(0, min, 0, 0); return d; }
  function workWindowOn(day, wh) {
    if (!has(wh.days, toDate(day).getDay())) return null;
    return { start: atMin(day, parseHm(wh.start)), end: atMin(day, parseHm(wh.end)) };
  }
  // '논리적 날짜' — 하루 시작(기본 04:00) 전이면 어제다 (토 01:25 는 금요일 밤)
  function logicalDay(now, pf) {
    var d = D.startOfDay(now);
    if (toDate(now).getTime() < atMin(d, pf.schedule.dayStartMin).getTime()) d = D.addDays(d, -1);
    return d;
  }
  function nextDayStart(t, pf) {
    var c = atMin(t, pf.schedule.dayStartMin);
    if (c.getTime() <= toDate(t).getTime()) c = atMin(D.addDays(D.startOfDay(t), 1), pf.schedule.dayStartMin);
    return c;
  }
  function dayKey(pf, now) { return D.ymd(logicalDay(now, pf)); }

  // ------------------------------------------------------------------ 감지 문법 (정규식은 한 번만 만든다)
  var FILLER_ALT = alt(SW.FILLERS);
  var TAIL_ALT = alt(SW.TAILS);
  var DR = SW.DURATION_RE;
  var DUR_ALT = [DR.clock, DR.hours, DR.half, DR.minutes].join('|');
  var RE_FILLERS_ONLY = new RegExp('^(?:(?:' + FILLER_ALT + ')\\s*)+$');
  var RE_LEAD_FILLERS = new RegExp('^(?:(?:' + FILLER_ALT + ')\\s*)+');
  var RE_FILLER_WORD = new RegExp('^(?:' + FILLER_ALT + ')+$');
  var RE_TAIL_TOKEN = new RegExp('^(?:' + TAIL_ALT + ')(?=\\s|$|' + DUR_ALT + ')');
  var RE_TAIL_START = new RegExp('^(?:' + TAIL_ALT + ')');
  var RE_DUR_START = new RegExp('^(?:' + DUR_ALT + ')');
  var RE_DUR_FULL = new RegExp('^(?:' + DUR_ALT + ')$');
  var RE_DUR_FIND = new RegExp('(?:' + DUR_ALT + ')');
  var RE_DUR_ALL = new RegExp('(?:' + DUR_ALT + ')', 'g');
  var RE_BLOCK_AFTER = new RegExp('^(?:' + alt(SW.BLOCK_AFTER) + ')');
  var RE_OTHERS_END = new RegExp('(?:' + SW.BLOCK_BEFORE_OTHERS + ')$');
  var RE_NOT_YET_OFF = new RegExp('^(?:' + SW.NOT_YET_OFF + ')$');
  var BLOCK_ANY_TIGHT = SW.BLOCK_ANYWHERE.filter(function (w) { return w !== '?' && w !== '？'; }).map(tight);
  var EMOJI_RE = /(?:[\uD800-\uDBFF][\uDC00-\uDFFF]|[←-⇿⌀-⏿☀-➿⬀-⯿]|[︎️‍⃣])/g;
  var GUESS_WORDS = ['자동', '시간표', '시간표대로', '시간표기준'];
  var REVERT_WORDS = ['이전', '되돌리기', '이전상태', '이전상태로', '이전으로'];

  // 정규화 (§5.2): NFC → 이모지 제거 → 라틴 소문자 → 끝의 문장부호·ㅋㅎㅠㅜ 제거 → '용$'→'요' → 공백 하나로
  function norm(s) {
    s = nfc(s).replace(EMOJI_RE, ' ').trim().toLowerCase();
    s = s.replace(/[\s.,!?~…·ㅋㅎㅠㅜ^;？！]+$/, '');
    s = s.replace(/용$/, '요');
    return s.replace(/\s+/g, ' ').trim();
  }
  // head = 첫 줄의 첫 문장(경계 문자는 head 에 남긴다), rest = 그 뒤 원문 전체
  function splitHead(text) {
    var t = String(text == null ? '' : text).replace(/^\s+/, '');
    var nl = t.indexOf('\n');
    var line = nl === -1 ? t : t.slice(0, nl);
    var m = /[.!?？！~…]+|,|\s·\s/.exec(line);
    var head = m ? line.slice(0, m.index + m[0].length) : line;
    return { head: head, rest: t.slice(head.length).trim() };
  }

  // 시간 표현 해석 → { minutes } | { until: Date|null }
  function parseDur(text, now) {
    if (!text) return null;
    var t = String(text).replace(/\s+/g, ' ').trim(), m;
    if ((m = /^(오전|오후)?\s*(\d{1,2})시(?:\s*(\d{1,2})분|\s*(반))?/.exec(t)) && /(?:까지|복귀)$/.test(t)) {
      if (!now) return { until: null };
      return { until: clockUntil(m[1] || null, Number(m[2]), m[4] ? 30 : (m[3] ? Number(m[3]) : 0), now) };
    }
    if ((m = /^(\d+|한|두|세)\s*시간(\s*반)?/.exec(t))) {
      var n = { '한': 1, '두': 2, '세': 3 }[m[1]] || Number(m[1]);
      return { minutes: n * 60 + (m[2] ? 30 : 0) };
    }
    if (/^반\s*시간/.test(t)) return { minutes: 30 };
    if ((m = /^(\d+)\s*분/.exec(t))) return { minutes: Number(m[1]) };
    return null;
  }
  // 'H시까지': 오전/오후가 없으면 H:00 과 (H+12):00 중 지금 뒤의 가장 이른 것. 8시간보다 멀면 until 없음
  function clockUntil(ampm, h, mi, now) {
    if (h > 23 || mi > 59) return null;
    var hours = ampm === '오전' ? [h % 12] : ampm === '오후' ? [(h % 12) + 12] : h > 12 ? [h] : [h % 12, (h % 12) + 12];
    var best = null, t0 = toDate(now).getTime();
    hours.forEach(function (H) {
      var d = toDate(now); d.setHours(H, mi, 0, 0);
      if (d.getTime() <= t0) d = D.addDays(d, 1);
      if (!best || d.getTime() < best.getTime()) best = d;
    });
    if (!best || best.getTime() - t0 > 8 * HOUR) return null;
    return best;
  }

  // ------------------------------------------------------------------ 프로필 (설정 + 프리셋 → 계산값, 메모)
  var profileCache = {}, profileKeys = [];
  function profile(prefs) {
    prefs = prefs && typeof prefs === 'object' ? prefs : {};
    var sp = prefs.statusProfile && typeof prefs.statusProfile === 'object' ? prefs.statusProfile : {};
    var key = JSON.stringify([sp, prefs.workHours || null]);
    if (profileCache[key]) return profileCache[key];
    var p = buildProfile(sp, prefs.workHours);
    p.hash = 'p:' + fnv(key);
    profileCache[key] = p;
    profileKeys.push(key);
    if (profileKeys.length > 12) delete profileCache[profileKeys.shift()];
    return p;
  }

  function cleanLabel(s, max) {
    if (typeof s !== 'string') return null;
    s = s.replace(/\s+/g, ' ').trim();
    return s && s.length <= (max || 20) ? s : null;
  }
  function cleanWords(list) {
    var out = [], seen = {};
    (Array.isArray(list) ? list : []).forEach(function (w) {
      if (typeof w !== 'string' || out.length >= MAX_WORDS) return;
      w = w.replace(/\s+/g, ' ').trim();
      var k = tight(w).toLowerCase();
      if (w.length < 2 || w.length > 20 || seen[k]) return;
      seen[k] = true; out.push(w);
    });
    return out;
  }
  function categoryStale(cat, place) {
    if (cat === 'work') return { h: 16 };
    if (cat === 'moving') return { h: 2 };
    if (cat === 'sleep') return { h: 10 };
    if (cat === 'overlay') return 'until';
    if (cat === 'life' && place === 'out') return { h: 4 };
    return 'dayStart';
  }
  function makeDef(id, src) {
    var cat = src.category || 'life';
    var overlay = cat === 'overlay';
    return {
      id: id, label: src.label || id, category: cat, place: src.place !== undefined ? src.place : null, overlay: overlay,
      minutes: overlay ? (src.minutes || 30) : null,
      rec: src.rec || 'normal', nudges: src.nudges !== undefined ? src.nudges : !overlay, busy: !!src.busy,
      icon: src.icon || null, stale: src.stale || categoryStale(cat, src.place), words: [], wordsOff: [], menu: false, custom: false
    };
  }

  function buildProfile(sp, whRaw) {
    var presetId = own(SW.PRESETS, sp.preset) ? sp.preset : 'office';
    var pre = SW.PRESETS[presetId];

    // ── 상태: 공통 정의 → 프리셋 정의·고침 → 사용자 고침·새 상태
    var statuses = dict(), statusIds = [];
    SW.STATUS_ORDER.forEach(function (id) { statuses[id] = makeDef(id, SW.STATUSES[id]); statusIds.push(id); });
    Object.keys(pre.statuses || {}).forEach(function (id) {
      var o = pre.statuses[id];
      if (statuses[id]) {
        if (o.label) statuses[id].label = o.label;
        if (o.minutes && statuses[id].overlay) statuses[id].minutes = o.minutes;
      } else { statuses[id] = makeDef(id, o); statusIds.push(id); }
    });
    var menuOverride = {}, customN = 0, taken = {};
    (Array.isArray(sp.statuses) ? sp.statuses : []).forEach(function (u) {
      if (!u || typeof u.id !== 'string') return;
      var d = statuses[u.id];
      if (!d) {
        if (!u.custom || !/^u_[a-z0-9_]{1,24}$/.test(u.id) || customN >= MAX_CUSTOM_STATUSES) return;
        var cat = has(['work', 'life', 'rest', 'moving', 'overlay'], u.category) ? u.category : 'life';
        var place = has(['office', 'home', 'out', 'moving'], u.place) ? u.place : null;
        var rec = has(['normal', 'short', 'none'], u.rec) ? u.rec : (cat === 'overlay' ? 'short' : 'normal');
        d = makeDef(u.id, { label: cleanLabel(u.label) || '내 상태', category: cat, place: place, rec: rec,
          minutes: cat === 'overlay' && u.minutes >= 5 && u.minutes <= 240 ? Math.round(u.minutes) : 30, busy: rec === 'none' });
        d.custom = true; customN++;
        statuses[u.id] = d; statusIds.push(u.id);
      } else {
        var lb = cleanLabel(u.label);
        if (lb) d.label = lb;
        if (d.overlay && typeof u.minutes === 'number' && u.minutes >= 5 && u.minutes <= 240) d.minutes = Math.round(u.minutes);
      }
      // 같은 말을 두 상태에 넣으면 먼저 넣은 쪽만 쓴다 (설정 화면이 그 자리에서 막는다)
      d.words = cleanWords(u.words).filter(function (w) { var k = tight(w).toLowerCase(); if (taken[k]) return false; taken[k] = true; return true; });
      d.wordsOff = cleanWords(u.wordsOff);
      if (typeof u.menu === 'boolean') menuOverride[u.id] = u.menu;
    });
    var menu = (pre.menu || []).filter(function (id) { return statuses[id] && menuOverride[id] !== false; });
    statusIds.forEach(function (id) { if (menuOverride[id] === true && menu.indexOf(id) === -1) menu.push(id); });
    menu = menu.slice(0, 10);
    menu.forEach(function (id) { statuses[id].menu = true; });

    // ── 맥락: 기본 6개(프리셋 라벨) → 사용자 고침·새 맥락
    var contexts = dict(), contextIds = [];
    var userCtx = dict();
    (Array.isArray(sp.contexts) ? sp.contexts : []).forEach(function (u) { if (u && typeof u.id === 'string') userCtx[u.id] = u; });
    SW.CONTEXTS.forEach(function (c) {
      var u = userCtx[c.id] || {};
      var off = cleanWords(u.wordsOff).map(function (w) { return tight(w).toLowerCase(); });
      var words = [];
      ['strong', 'mid', 'weak'].forEach(function (tier) {
        (SW.CONTEXT_WORDS[c.id][tier] || []).forEach(function (w) {
          if (!has(off, tight(w).toLowerCase())) words.push({ w: w, weight: SW.WORD_WEIGHT[tier] });
        });
      });
      cleanWords(u.words).forEach(function (w) {
        var k = tight(w).toLowerCase();
        words = words.filter(function (x) { return tight(x.w).toLowerCase() !== k; });
        words.push({ w: w, weight: SW.WORD_WEIGHT.user, user: true });
      });
      contexts[c.id] = { id: c.id, label: cleanLabel(u.label) || (pre.contextLabels && pre.contextLabels[c.id]) || c.label,
        desc: c.desc, icon: c.icon, aliases: c.aliases.slice(), words: words, custom: false };
      contextIds.push(c.id);
    });
    var ctxN = 0;
    (Array.isArray(sp.contexts) ? sp.contexts : []).forEach(function (u) {
      if (!u || !u.custom || typeof u.id !== 'string' || contexts[u.id] || !/^u_[a-z0-9_]{1,24}$/.test(u.id) || ctxN >= MAX_CUSTOM_CONTEXTS) return;
      var label = cleanLabel(u.label) || '내 맥락';
      contexts[u.id] = { id: u.id, label: label, desc: '', icon: null, aliases: [label], custom: true,
        words: cleanWords(u.words).map(function (w) { return { w: w, weight: SW.WORD_WEIGHT.user, user: true }; }) };
      contextIds.push(u.id); ctxN++;
    });

    // ── 시간표
    var as = sp.autoSchedule && typeof sp.autoSchedule === 'object' ? sp.autoSchedule : {};
    var lunch = ['12:00', '13:00'];
    if (as.lunch === null) lunch = null;
    else if (Array.isArray(as.lunch) && parseHm(as.lunch[0]) != null && parseHm(as.lunch[1]) != null && parseHm(as.lunch[0]) < parseHm(as.lunch[1])) lunch = [as.lunch[0], as.lunch[1]];
    var ds = parseHm(as.dayStart);
    if (ds == null || ds > 12 * 60) ds = 4 * 60;
    var schedule = {
      mode: as.mode === 'off' || as.mode === 'guess' ? as.mode : (pre.schedule && pre.schedule.mode) || 'guess',
      hideOnGuess: as.hideOnGuess === true,
      workHours: normalizeWorkHours(whRaw),
      lunch: lunch, dayStart: fmtHm(ds), dayStartMin: ds,
      overtimeLine: as.overtimeLine !== false
    };
    var afterWork = sp.afterWork === 'hide' || sp.afterWork === 'down' ? sp.afterWork : (pre.afterWork || 'hide');
    var urgentHours = typeof sp.urgentHours === 'number' && sp.urgentHours >= 0 && sp.urgentHours <= 48 ? sp.urgentHours : 3;
    var primary = (pre.primary || ['work']).filter(function (c) { return contexts[c]; });

    // ── 정책표: 공식(§7.3) → 프리셋 칸 → (= rawMatrix) → 사용자 칸(policy) (= matrix)
    var rawMatrix = dict(), matrix = dict();
    statusIds.forEach(function (id) {
      var d = statuses[id];
      if (d.overlay) return;
      var row = formulaRow(d, contextIds, contexts, primary, afterWork);
      var pm = pre.matrix && own(pre.matrix, id) ? pre.matrix[id] : null;
      if (pm) Object.keys(pm).forEach(function (c) {
        var v = pm[c] === 'after' ? afterWork : pm[c];
        if (own(row, c) && own(LEVEL_RANK, v)) row[c] = v;
      });
      rawMatrix[id] = row;
      matrix[id] = Object.assign({}, row);
    });
    var pol = sp.policy && typeof sp.policy === 'object' ? sp.policy : {};
    Object.keys(pol).forEach(function (sid) {
      if (!matrix[sid] || !pol[sid] || typeof pol[sid] !== 'object') return;
      Object.keys(pol[sid]).forEach(function (c) {
        if (own(matrix[sid], c) && own(LEVEL_RANK, pol[sid][c])) matrix[sid][c] = pol[sid][c];
      });
    });

    var roleMap = {};
    Object.keys(SW.ROLE_STATUS).forEach(function (r) { roleMap[r] = SW.ROLE_STATUS[r]; });
    Object.keys(pre.roleMap || {}).forEach(function (r) { if (statuses[pre.roleMap[r]]) roleMap[r] = pre.roleMap[r]; });

    var pf = {
      preset: presetId, presetLabel: pre.label, enabled: sp.enabled !== false,
      statuses: statuses, statusIds: statusIds, menu: menu, contexts: contexts, contextIds: contextIds,
      matrix: matrix, rawMatrix: rawMatrix, primary: primary, afterWork: afterWork, urgentHours: urgentHours,
      schedule: schedule, roleMap: roleMap
    };
    pf.words = buildWordIndex(pf, presetId);
    pf.otherWords = {};
    var ownKeys = {};
    pf.words.forEach(function (e) { ownKeys[e.key] = true; });
    SW.PRESET_ORDER.forEach(function (pid) {
      if (pid === presetId) return;
      var list = [];
      (SW.PRESET_WORDS[pid] || []).forEach(function (g) { addGroup(list, g, { preset: pid }); });
      list = list.filter(function (e) { return !ownKeys[e.key] && e.tier !== 'special'; });
      if (list.length) pf.otherWords[pid] = finishIndex(list);
    });
    pf.ctxWords = buildCtxIndex(pf);
    return pf;
  }

  // 범주·장소로 기본 행을 만든다 (§7.3). 정하지 않음(_none)은 잠을 빼면 늘 보통이다.
  function formulaRow(d, ids, contexts, primary, afterWork) {
    var row = {}, cat = d.category, place = d.place;
    ids.forEach(function (c) {
      var custom = contexts[c].custom, prim = has(primary, c), v = 'normal';
      if (cat === 'work') v = custom ? 'down' : prim ? 'up' : (place === 'out' && c === 'errand') ? 'normal' : 'down';
      else if (cat === 'moving') v = !custom && (c === 'home' || c === 'errand') && !prim ? 'down' : 'normal';
      else if (cat === 'life') {
        if (prim) v = place === 'out' ? 'down' : afterWork;
        else if (custom) v = 'normal';
        else if (place === 'home') v = has(['home', 'personal', 'family'], c) ? 'up' : 'normal';
        else if (place === 'out') v = c === 'errand' ? 'up' : c === 'home' ? 'down' : 'normal';
      } else if (cat === 'rest') {
        if (prim) v = afterWork;
        else if (!custom && has(['home', 'personal', 'family', 'errand'], c)) v = 'up';
      } else if (cat === 'sleep') v = 'hide';
      row[c] = v;
    });
    row._none = cat === 'sleep' ? 'hide' : 'normal';
    return row;
  }

  // ── 말 색인: 공통 사전 + 이 프리셋 전용 말 + 사용자 말(이긴다) − 끈 말
  function addGroup(list, g, src) {
    ['sure', 'tail', 'maybe', 'special'].forEach(function (tier) {
      (g[tier] || []).forEach(function (w) {
        list.push({ w: w, key: tight(w).toLowerCase(), tier: tier, role: g.role || null, id: g.id || null, label: g.label || null,
          gate: g.gate || null, nap: !!g.nap, half: g.half || null, home: !!g.home, lunch: !!g.lunch,
          user: !!src.user, preset: src.preset || null });
      });
    });
  }
  function buildWordIndex(pf, presetId) {
    var off = {};
    pf.statusIds.forEach(function (id) { pf.statuses[id].wordsOff.forEach(function (w) { off[tight(w).toLowerCase()] = true; }); });
    var list = [];
    SW.PHRASES.forEach(function (g) { addGroup(list, g, {}); });
    (SW.PRESET_WORDS[presetId] || []).forEach(function (g) { addGroup(list, g, { preset: presetId }); });
    var user = [];
    pf.statusIds.forEach(function (id) {
      var d = pf.statuses[id];
      d.words.forEach(function (w) { addGroup(user, { sure: [w], id: id }, { user: true }); });
      if (d.custom) addGroup(user, { sure: [d.label], id: id }, { user: true });
    });
    var byKey = {}, out = [];
    user.forEach(function (e) { if (!byKey[e.key]) { byKey[e.key] = e; out.push(e); } });
    list.forEach(function (e) { if (!byKey[e.key] && !off[e.key]) { byKey[e.key] = e; out.push(e); } });
    return finishIndex(out);
  }
  function finishIndex(list) {
    list.forEach(function (e, i) { e.order = i; e.re = new RegExp(flexRe(e.key), 'g'); e.grammar = null; });
    return list.sort(function (a, b) { return b.key.length - a.key.length || a.order - b.order; });
  }
  function grammarOf(e) {
    if (!e.grammar) {
      e.grammar = new RegExp('^(?:(?:' + FILLER_ALT + ')\\s*)*(?:(' + DUR_ALT + ')\\s*)?(?:' + flexRe(e.key) +
        ')\\s*(?:(' + TAIL_ALT + ')\\s*)?(?:(' + DUR_ALT + '))?$');
    }
    return e.grammar;
  }

  // ── 맥락 단어 색인
  function buildCtxIndex(pf) {
    var spaced = [], single = [];
    pf.contextIds.forEach(function (c) {
      pf.contexts[c].words.forEach(function (x) {
        var w = nfc(x.w).toLowerCase().trim();
        if (/\s/.test(w)) spaced.push({ w: x.w, t: tight(w), parts: w.split(/\s+/), ctx: c, weight: x.weight });
        else single.push({ w: x.w, k: w, ctx: c, weight: x.weight, latin: /^[a-z]+$/.test(w) });
      });
    });
    single.sort(function (a, b) { return b.k.length - a.k.length || b.weight - a.weight; });
    return { spaced: spaced, single: single,
      errandEnd: new RegExp('(?:' + SW.ERRAND_ENDINGS.map(wordRe).join('|') + ')$') };
  }

  function presetList() {
    return SW.PRESET_ORDER.map(function (id) { var p = SW.PRESETS[id]; return { id: id, label: p.label, desc: p.desc, stage: p.stage }; });
  }

  // ------------------------------------------------------------------ presence 저장소
  function defaultHints() { return { day: null, used: 0, overtimeDismiss: 0, presetSeen: {}, presetOffered: {} }; }
  function defaultPresence() { return { v: 1, activatedAt: null, current: null, shown: [], parked: [], log: [], hints: defaultHints() }; }
  function isObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
  // 없거나 모양이 틀리면 채운다 (변경 함수에서만 부른다)
  function ensure(state) {
    if (!isObj(state.presence)) state.presence = defaultPresence();
    var p = state.presence;
    if (p.v == null) p.v = 1;
    if (p.activatedAt === undefined) p.activatedAt = null;
    if (!isObj(p.current)) p.current = null;
    ['shown', 'parked', 'log'].forEach(function (k) { if (!Array.isArray(p[k])) p[k] = []; });
    if (!isObj(p.hints)) p.hints = {};
    var h = p.hints;
    if (h.day === undefined) h.day = null;
    if (typeof h.used !== 'number') h.used = 0;
    if (typeof h.overtimeDismiss !== 'number') h.overtimeDismiss = 0;
    if (!isObj(h.presetSeen)) h.presetSeen = {};
    if (!isObj(h.presetOffered)) h.presetOffered = {};
    return p;
  }
  // 읽기 전용: 모양이 맞으면 그대로, 아니면 붙이지 않은 사본을 고쳐서 돌려준다 (읽기에서 state 를 바꾸지 않는다)
  function pres(state) {
    var p = state && state.presence;
    if (isObj(p) && Array.isArray(p.shown) && Array.isArray(p.parked) && Array.isArray(p.log) && isObj(p.hints) &&
        isObj(p.hints.presetSeen) && isObj(p.hints.presetOffered)) return p;
    return ensure({ presence: isObj(p) ? clone(p) : null });
  }
  function isActive(state, pf) {
    pf = pf || profile(state && state.prefs);
    return !!(pf.enabled && pres(state).activatedAt);
  }

  // ------------------------------------------------------------------ 유효 상태 (§4)
  // 읽을 수 없는 시각은 NaN (저장값이 깨졌을 때)
  function timeOf(v) { return v == null || v === '' ? NaN : ms(v); }
  function staleAt(cur, pf) {
    var d = pf.statuses[cur.id];
    var u = cur.until ? timeOf(cur.until) : NaN;
    if (isFinite(u)) return new Date(u);
    var since = toDate(timeOf(cur.since));
    // 모르는 상태이거나 since 가 깨진 저장값은 이미 낡은 것으로 본다 (계산이 던지지 않게)
    if (!d || isNaN(since.getTime())) return new Date(0);
    if (d.stale === 'dayStart') return nextDayStart(since, pf);
    if (d.stale === 'until') return D.addMinutes(since, d.minutes || 60);
    return new Date(since.getTime() + (d.stale.h || 16) * HOUR);
  }
  function isStale(cur, pf, now) { return staleAt(cur, pf).getTime() <= toDate(now).getTime(); }
  function restoreRef(rt) {
    return { id: rt.id, label: rt.label, role: null, since: rt.since, source: rt.source || null, until: rt.until || null, returnTo: null };
  }
  function overlayLike(cur, pf) {
    var d = cur && pf.statuses[cur.id];
    return !!d && (d.overlay || (cur.id === 'sleep' && !!cur.until));
  }

  // 시간표 짐작 (§4.3) — 점심과 잠은 짐작하지 않는다
  function guess(pf, now) {
    now = toDate(now);
    var wh = pf.schedule.workHours, ds = pf.schedule.dayStartMin;
    var d = logicalDay(now, pf);
    var dStart = atMin(d, ds), nStart = atMin(D.addDays(d, 1), ds);
    var win = workWindowOn(d, wh);
    function seg(id, label, s, e) { return { id: id, label: label, segment: { start: iso(s), end: iso(e) } }; }
    if (!win) return seg('day_off', pf.statuses.day_off.label, dStart, nStart);
    if (now.getTime() < win.start.getTime()) return seg('off', GUESS_LABEL.before, dStart, win.start);
    if (now.getTime() < win.end.getTime()) return seg('work', pf.statuses.work.label, win.start, win.end);
    return seg('off', GUESS_LABEL.after, win.end, nStart);
  }
  function timeline(pf, from, days) {
    var out = [], t = toDate(from), end = t.getTime() + (days || 1) * DAY, guard = 0;
    while (t.getTime() < end && guard++ < (days || 1) * 6 + 6) {
      var g = guess(pf, t);
      out.push({ id: g.id, start: g.segment.start, end: g.segment.end });
      var next = toDate(g.segment.end);
      if (next.getTime() <= t.getTime()) break;
      t = next;
    }
    return out;
  }

  function effective(state, pf, now) {
    pf = pf || profile(state && state.prefs);
    now = toDate(now);
    var p = pres(state);
    if (!pf.enabled || !p.activatedAt) return null;
    var cur = p.current && pf.statuses[p.current.id] ? p.current : null;
    if (cur && cur.until && ms(cur.until) <= now.getTime()) cur = cur.returnTo && pf.statuses[cur.returnTo.id] ? restoreRef(cur.returnTo) : null;
    if (cur && isStale(cur, pf, now)) cur = null;
    var overlay = cur && pf.statuses[cur.id].overlay ? cur : null;
    var base = cur;
    if (overlay) {
      var rt = overlay.returnTo && pf.statuses[overlay.returnTo.id] ? restoreRef(overlay.returnTo) : null;
      base = rt && !isStale(rt, pf, now) ? rt : null;
    }
    var b;
    if (base) {
      var bd = pf.statuses[base.id];
      b = { id: base.id, label: base.label || bd.label, category: bd.category, place: bd.place, guessed: false,
        source: base.source || null, since: base.since || null, expiresAt: iso(staleAt(base, pf)) };
    } else if (pf.schedule.mode === 'guess') {
      var g = guess(pf, now), gd = pf.statuses[g.id];
      b = { id: g.id, label: g.label, category: gd.category, place: gd.place, guessed: true, source: 'guess',
        since: g.segment.start, expiresAt: g.segment.end };
    } else {
      b = { id: 'none', label: pf.statuses.none.label, category: 'none', place: null, guessed: true, source: 'none', since: null, expiresAt: null };
    }
    var src = overlay ? pf.statuses[overlay.id] : pf.statuses[b.id];
    b.overlay = overlay ? { id: overlay.id, label: overlay.label || src.label, until: isFinite(timeOf(overlay.until)) ? overlay.until : null, rec: src.rec } : null;
    b.rec = src.rec; b.busy = src.busy; b.nudges = src.nudges;
    return b;
  }
  function explicitIdOf(eff) { return !eff ? null : eff.overlay ? eff.overlay.id : eff.guessed ? null : eff.id; }

  // FEATURES_SPEC DN.status.current 의 본체
  function current(state, pf, now) {
    pf = pf || profile(state && state.prefs);
    var eff = effective(state, pf, now);
    if (!eff) return null;
    if (eff.overlay) return { id: eff.overlay.id, label: eff.overlay.label, busy: eff.busy, until: eff.overlay.until || null, guessed: false };
    var cur = pres(state).current;
    var until = !eff.guessed && cur && cur.id === eff.id && isFinite(timeOf(cur.until)) ? cur.until : null;
    return { id: eff.id, label: eff.label, busy: eff.busy, until: until, guessed: eff.guessed };
  }

  // ------------------------------------------------------------------ 감지 (§5)
  // 핵심어 자리가 다른 낱말의 일부가 아닌가 ('회의록' 안의 '회의', '운동화' 안의 '운동'은 핵심어가 아니다)
  function attachedOk(h, i, j) {
    var after = h.slice(j);
    if (after && !/^\s/.test(after) && !RE_TAIL_TOKEN.test(after) && !RE_DUR_START.test(after) && !RE_BLOCK_AFTER.test(after)) return false;
    var before = h.slice(0, i);
    if (before && !/\s$/.test(before)) {
      var lw = before.split(/\s+/).pop();
      if (!RE_FILLERS_ONLY.test(lw) && !RE_DUR_FULL.test(lw)) return false;
    }
    return true;
  }
  function findHits(index, h) {
    var hits = [];
    index.forEach(function (e) {
      if (e.tier === 'special') return;
      e.re.lastIndex = 0;
      var m;
      while ((m = e.re.exec(h))) {
        if (!m[0]) { e.re.lastIndex++; continue; }
        if (attachedOk(h, m.index, m.index + m[0].length)) { hits.push({ entry: e, i: m.index, j: m.index + m[0].length }); break; }
      }
      e.re.lastIndex = 0;
    });
    // 더 긴 핵심어 안에 든 짧은 핵심어는 뺀다 ('출근 중' 안의 '출근')
    hits.sort(function (a, b) { return (b.j - b.i) - (a.j - a.i) || a.entry.order - b.entry.order; });
    var kept = [];
    hits.forEach(function (x) { if (!kept.some(function (k) { return x.i >= k.i && x.j <= k.j; })) kept.push(x); });
    return kept;
  }
  function overlaps(a, b) { return a.i < b.j && b.i < a.j; }
  function stripTrailFillers(s) {
    var words = s.replace(/\s+$/, '').split(/\s+/);
    while (words.length && RE_FILLER_WORD.test(words[words.length - 1])) words.pop();
    return words.join(' ');
  }
  // 자리 막기 (§5.4): 핵심어 바로 뒤 · 바로 앞 · 다른 사람 · 할 일 꼴
  function blockedAround(h, hit) {
    var after = h.slice(hit.j).replace(/^\s+/, '');
    var after2 = after.replace(RE_DUR_START, '').replace(/^\s+/, '');
    if (RE_BLOCK_AFTER.test(after) || RE_BLOCK_AFTER.test(after2)) return true;
    if (after && /기$/.test(after)) return true;
    var beforeRaw = h.slice(0, hit.i).replace(/\s+$/, '');
    if (/(?:^|\s)(?:안|못)$/.test(beforeRaw)) return true;
    var before = stripTrailFillers(beforeRaw);
    if (before && RE_OTHERS_END.test(before)) return true;
    return false;
  }
  function blockedAnywhere(head, h) {
    if (/[?？]/.test(head)) return true;
    var t = tight(h);
    return BLOCK_ANY_TIGHT.some(function (w) { return t.indexOf(w) !== -1; });
  }
  function residual(h, hit) {
    var before = h.slice(0, hit.i).replace(RE_LEAD_FILLERS, '');
    var after = h.slice(hit.j).replace(/^\s+/, '').replace(RE_DUR_START, '').replace(/^\s+/, '');
    var tm = RE_TAIL_START.exec(after);
    if (tm) after = after.slice(tm[0].length);
    return (before + after).replace(RE_DUR_ALL, '').replace(/\s+/g, '').length;
  }
  // tier 정하기 (§5.5 8): 긴 핵심어부터 SURE 문법을 맞춰 보고, 안 되면 남는 글자 ≤ 6 이면 maybe
  function pickTier(h, hits) {
    var sorted = hits.slice().sort(function (a, b) { return (b.j - b.i) - (a.j - a.i) || a.entry.order - b.entry.order; });
    for (var k = 0; k < sorted.length; k++) {
      var g = grammarOf(sorted[k].entry).exec(h);
      if (g) {
        var e = sorted[k].entry;
        var tier = e.tier === 'maybe' ? 'maybe' : e.tier === 'tail' && !g[2] ? 'maybe' : 'sure';
        return { hit: sorted[k], tier: tier, dur: g[1] || g[3] || null };
      }
    }
    for (var n = 0; n < sorted.length; n++) {
      if (residual(h, sorted[n]) <= SW.MAX_RESIDUAL) {
        var dm = RE_DUR_FIND.exec(h);
        return { hit: sorted[n], tier: 'maybe', dur: dm ? dm[0] : null };
      }
    }
    return null;
  }
  // 이 글자들로 상태를 읽을 수 있나 (프리셋 신호에서도 쓴다)
  function readWith(index, h) {
    var hits = findHits(index, h);
    if (!hits.length) return null;
    if (hits.some(function (x) { return blockedAround(h, x); })) return null;
    return pickTier(h, hits);
  }
  function gateOk(gate, eff) {
    if (!gate) return true;
    if (gate === 'work') return !!eff && eff.category === 'work';
    if (gate === 'meal') return !!eff && (eff.category === 'work' || (!!eff.overlay && eff.overlay.id === 'focus'));
    if (gate === 'in_meal') return !!eff && !!eff.overlay && eff.overlay.id === 'meal';
    if (gate === 'in_meeting') return !!eff && !!eff.overlay && eff.overlay.id === 'meeting';
    if (gate === 'moving_or_out') return !!eff && !eff.guessed && (eff.category === 'moving' || eff.id === 'out');
    return true;
  }
  function findSpecial(index, h) {
    var a = tight(h), b = tight(h.replace(RE_LEAD_FILLERS, ''));
    for (var i = 0; i < index.length; i++) {
      var e = index[i];
      if (e.tier === 'special' && (e.key === a || e.key === b)) return e;
    }
    return null;
  }

  function detect(text, ctx) {
    ctx = ctx || {};
    var pf = ctx.profile || profile({});
    if (!pf.enabled) return null;
    var t = String(text == null ? '' : text).replace(/^\s+/, '');
    if (!t || t.charAt(0) === '/' || t.charAt(0) === '／') return null;
    var hr = splitHead(t), h = norm(hr.head);
    if (!h || h.length > SW.MAX_HEAD) return null;
    var eff = ctx.eff || null, cur = ctx.current || null, now = ctx.now ? toDate(ctx.now) : null;
    var rctx = { profile: pf, eff: eff, current: cur, now: now };
    function result(tier, e, r, matched) {
      return { tier: tier, role: e.role || null, id: r.id, label: r.label, until: r.until || null, minutes: r.minutes != null ? r.minutes : null,
        pure: tier === 'sure' && !hr.rest, statusLine: hr.head.trim().slice(0, STATUS_LINE_MAX), rest: hr.rest, matched: matched,
        same: !!r.same || (r.id != null && r.id === explicitIdOf(eff)) };
    }
    // 3. 특수어 (막기보다 먼저)
    var sp = findSpecial(pf.words, h);
    if (sp) {
      var rs = resolveRole(sp.role, { entry: sp }, rctx);
      return rs ? result('sure', sp, rs, sp.w) : null;
    }
    // 4. '퇴근 못 함' → maybe 야근 (지금 명시 업무면 바꿀 게 없다)
    if (RE_NOT_YET_OFF.test(h.replace(RE_LEAD_FILLERS, ''))) {
      if (eff && !eff.guessed && eff.category === 'work') return null;
      var wid = pf.roleMap.work_start || 'work';
      return result('maybe', { role: 'work_start' }, { id: wid, label: '야근' }, '퇴근 못 함');
    }
    // 5. 막기 (어디든)
    if (blockedAnywhere(hr.head, h)) return null;
    // 6. 핵심어 — 다른 프리셋 전용 말 안의 공통 핵심어는 빼고 (§12.3)
    var hits = findHits(pf.words, h);
    var other = [];
    Object.keys(pf.otherWords).forEach(function (pid) { other = other.concat(findHits(pf.otherWords[pid], h)); });
    hits = hits.filter(function (x) { return !other.some(function (o) { return overlaps(o, x); }); });
    if (!hits.length) return null;
    // 7. 자리 막기 · 다른 사람 · 할 일 꼴
    if (hits.some(function (x) { return blockedAround(h, x); })) return null;
    // 8. tier
    var pick = pickTier(h, hits);
    if (!pick) return null;
    var e = pick.hit.entry;
    // 9. 문
    if (!gateOk(e.gate, eff)) return null;
    // 10–11. 역할 → 상태, 시간
    var r = resolveRole(e.role, { entry: e, dur: pick.dur, matched: e.w }, rctx);
    if (!r) return null;
    return result(pick.tier, e, r, e.w);
  }

  // 역할 → 상태 (§4.4). info { entry?, dur?, matched? }, ctx { profile, eff, current, now }
  function resolveRole(role, info, ctx) {
    info = info || {}; ctx = ctx || {};
    var pf = ctx.profile || profile({}), eff = ctx.eff || null, cur = ctx.current || null, now = ctx.now ? toDate(ctx.now) : null;
    var e = info.entry || { role: role };
    function to(id, extra) {
      var d = pf.statuses[id];
      if (!d) return null;
      return Object.assign({ id: id, label: e.label || d.label }, extra || {});
    }
    function toGuessTarget() { return { id: null, label: now ? guess(pf, now).label : null, guess: true }; }
    function back() {
      if (!eff) return null;
      // 덧씌움 아래 바탕: 명시(낡지 않은 returnTo)면 그 상태로, 짐작이면 시간표대로. eff 만 보므로 current 가 없어도(/상태 복귀) 맞다
      if (eff.overlay) return eff.guessed ? toGuessTarget() : { id: eff.id, label: eff.label };
      if (!eff.guessed && (eff.id === 'out' || eff.id === 'field')) {
        if (!now) return null;
        return guess(pf, now).id === 'work' ? to(pf.roleMap.work_start || 'work', { label: pf.statuses[pf.roleMap.work_start || 'work'].label }) : to('off', { label: pf.statuses.off.label });
      }
      if (eff.category === 'work') return { id: eff.id, label: eff.label, same: true };
      return null;
    }
    var r;
    if (e.id && pf.statuses[e.id]) r = to(e.id);
    else if (role === 'work_start') r = to(pf.roleMap.work_start || 'work');
    else if (role === 'work_end') r = e.home && now && guess(pf, now).id === 'day_off' ? to('day_off') : to(pf.roleMap.work_end || 'off');
    else if (role === 'half_day') {
      r = to(pf.roleMap.half_day || 'off', { label: e.label || '반차' });
      if (r && now) {
        var half = e.half || (now.getHours() < 12 ? 'am' : 'pm');
        var u = half === 'am' ? atMin(now, 13 * 60) : atMin(now, parseHm(pf.schedule.workHours.end));
        if (u.getTime() > now.getTime()) { r.until = iso(u); r.minutes = Math.round((u.getTime() - now.getTime()) / MIN); }
      }
      return r;
    }
    else if (role === 'commute') r = to(eff && eff.category === 'work' ? 'to_home' : 'to_work');
    else if (role === 'back') r = back();
    else if (role === 'arrive') {
      if (!eff || eff.guessed) return null;
      r = eff.id === 'to_work' ? to(pf.roleMap.work_start || 'work', { label: pf.statuses[pf.roleMap.work_start || 'work'].label })
        : eff.id === 'to_home' ? to('off', { label: pf.statuses.off.label }) : eff.id === 'out' ? back() : null;
    }
    else if (role === 'wake') {
      if (!cur || cur.id !== 'sleep') return null;
      // 낮잠(끝 시각이 있는 잠)에서 깨면 그 아래 상태로 (ST.wake 와 같다). 밤잠은 시간표대로
      var rt = cur.until && cur.returnTo && pf.statuses[cur.returnTo.id] ? restoreRef(cur.returnTo) : null;
      return rt && now && !isStale(rt, pf, now) ? { id: rt.id, label: rt.label || pf.statuses[rt.id].label } : toGuessTarget();
    }
    else if (role === 'idle') return { id: null, label: null, idle: true };
    else if (role === 'reset') r = to('none', { label: pf.statuses.none.label });
    else r = pf.roleMap[role] ? to(pf.roleMap[role]) : null;
    if (!r || r.id == null) return r || null;
    return withTime(r, e, info.dur || null, pf, now);
  }

  // 덧씌움·외출·낮잠에만 시간을 붙인다 (§5.3). 다른 상태에서는 시간 표현을 무시한다
  function defaultUntil(d, pf, now, lunchWord) {
    if (d.id === 'meal') {
      var l = pf.schedule.lunch;
      if (l) {
        var ls = atMin(now, parseHm(l[0])), le = atMin(now, parseHm(l[1]));
        if (now.getTime() >= ls.getTime() && now.getTime() < le.getTime()) return le;
      }
      return D.addMinutes(now, lunchWord === false ? SW.MEAL_MINUTES.other : SW.MEAL_MINUTES.lunch);
    }
    return D.addMinutes(now, d.minutes || 30);
  }
  function withTime(r, e, durText, pf, now) {
    var d = pf.statuses[r.id];
    if (!d || !now) return r;
    if (!(d.overlay || r.id === 'out' || e.nap)) return r;
    var dur = durText ? parseDur(durText, now) : null, until = null;
    if (dur && dur.minutes) until = D.addMinutes(now, dur.minutes);
    else if (dur && 'until' in dur) until = dur.until;
    else if (e.nap) until = D.addMinutes(now, SW.NAP_MINUTES);
    else if (d.overlay) until = defaultUntil(d, pf, now, d.id === 'meal' ? !!e.lunch || !e.role : undefined);
    if (until) { r.until = iso(until); r.minutes = Math.round((until.getTime() - now.getTime()) / MIN); }
    return r;
  }

  // /상태 인자 (§5.10) — 막기는 쓰지 않고, 오타는 여기서만 편집 거리 1 로 맞춘다
  function editDistance(a, b) {
    if (Math.abs(a.length - b.length) > 1) return 2;
    var prev = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      var row = [i];
      for (j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      prev = row;
    }
    return prev[b.length];
  }
  function parseStatusArgs(args, pf, eff, now) {
    pf = pf || profile({});
    now = now ? toDate(now) : null;
    var raw = String(args == null ? '' : args).trim();
    var a = norm(raw);
    if (!a) return { cmd: 'picker' };
    var at = tight(a);
    if (has(GUESS_WORDS, at)) return { cmd: 'guess' };
    if (has(REVERT_WORDS, at)) return { cmd: 'revert' };
    var ctx = { profile: pf, eff: eff || null, current: null, now: now };
    var dm = RE_DUR_FIND.exec(a);
    var durText = dm ? dm[0] : null;
    var name = dm ? (a.slice(0, dm.index) + ' ' + a.slice(dm.index + dm[0].length)).replace(/\s+/g, ' ').trim() : a;
    var nt = tight(name);
    function done(r) {
      if (!r) return null;
      if (r.idle) return { cmd: 'unknown', label: raw };
      if (r.id == null) return { cmd: 'guess' };
      return { cmd: 'set', id: r.id, label: r.label, until: r.until || null, minutes: r.minutes != null ? r.minutes : null };
    }
    function statusById(id) { var d = pf.statuses[id]; return d ? withTime({ id: id, label: d.label }, { role: null }, durText, pf, now) : null; }
    // 1) id  2) 상태 이름
    if (pf.statuses[name]) return done(statusById(name));
    var ids = pf.statusIds.filter(function (id) { return tight(norm(pf.statuses[id].label)) === nt; });
    if (ids.length) return done(statusById(ids[0]));
    // 3) 사전의 말 (꼬리·시간 포함, 문·막기 없이)
    var sp = findSpecial(pf.words, a);
    if (sp && sp.role === 'wake') return { cmd: 'guess' };
    if (sp) { var rs = resolveRole(sp.role, { entry: sp }, ctx); if (rs) return done(rs); }
    for (var i = 0; i < pf.words.length; i++) {
      var e = pf.words[i];
      if (e.tier === 'special') continue;
      var g = grammarOf(e).exec(a);
      if (!g) continue;
      var r = resolveRole(e.role, { entry: e, dur: g[1] || g[3] || durText }, ctx);
      if (r) return done(r);
    }
    // 4) 오타: 편집 거리 1 이하로 맞는 말이 하나뿐일 때
    if (nt.length >= 2) {
      var found = {}, firstR = null;
      pf.words.forEach(function (w) {
        if (editDistance(nt, w.key) > 1) return;
        var rr = resolveRole(w.role, { entry: w, dur: durText }, ctx);
        if (rr && rr.id != null && !found[rr.id]) { found[rr.id] = true; firstR = firstR || rr; }
      });
      pf.statusIds.forEach(function (id) {
        if (editDistance(nt, tight(norm(pf.statuses[id].label))) > 1 || found[id]) return;
        found[id] = true; firstR = firstR || statusById(id);
      });
      if (Object.keys(found).length === 1) return done(firstR);
    }
    return { cmd: 'unknown', label: raw };
  }

  // ------------------------------------------------------------------ 걸어 둔 상태 (§5.9) · 폰 할 일 (§2.5)
  var ATMODE_LIST = [];
  SW.ATMODES.forEach(function (mode) {
    SW.ATMODE_PHRASES[mode].forEach(function (ph) {
      var re = wordRe(ph);
      ATMODE_LIST.push({ mode: mode, phrase: ph, re: re, start: new RegExp('^(?:' + re + ')'),
        any: new RegExp('(?:^|[\\s,(])(' + re + ')(?=$|[\\s,.!?)]|에(?:$|[\\s,]))') });
    });
  });
  ATMODE_LIST.sort(function (a, b) { return byLenDesc(a.phrase, b.phrase); });

  // 제목 맨 앞의 걸어 둔 상태 표현을 떼고 앞쪽 조사(에·엔)·쉼표를 다듬는다. 남은 제목이 2자 미만이면 떼지 않는다(null)
  function extractAtMode(title) {
    var t = nfc(title).trim();
    for (var i = 0; i < ATMODE_LIST.length; i++) {
      var m = ATMODE_LIST[i].start.exec(t);
      if (!m) continue;
      var rest = t.slice(m[0].length);
      if (rest && !/^[\s,]/.test(rest) && !/^(?:에|엔)(?=[\s,]|$)/.test(rest)) continue;
      rest = rest.replace(/^(?:에|엔)(?=[\s,]|$)/, '').replace(/^[\s,]+/, '').trim();
      if (rest.length < 2) return null;
      return { mode: ATMODE_LIST[i].mode, phrase: m[0].trim(), title: rest };
    }
    return null;
  }
  // 글 어디든 같은 표현이 있나 (AI 의 do_in 검증용) — 가장 앞에 나온 것
  function findAtMode(text) {
    var t = nfc(text), best = null;
    ATMODE_LIST.forEach(function (x) {
      var m = x.any.exec(t);
      if (!m) return;
      var idx = m.index + m[0].length - m[1].length;
      if (!best || idx < best.idx) best = { idx: idx, mode: x.mode };
    });
    return best ? best.mode : null;
  }
  function atModePhrase(mode) { return has(SW.ATMODES, mode) ? SW.ATMODE_LABEL[mode] : null; }
  function atModeMatches(mode, statusId, pf) {
    if (!has(SW.ATMODES, mode) || !statusId) return false;
    if (has(SW.ATMODE_STATUS[mode], statusId)) return true;
    var d = pf && pf.statuses[statusId];
    if (!d || !d.custom) return false;
    var c = d.category;
    if (mode === 'work') return c === 'work';
    if (mode === 'off') return (c === 'life' && d.place !== 'out') || c === 'rest';
    if (mode === 'out') return c === 'moving' || (c === 'life' && d.place === 'out');
    if (mode === 'rest') return c === 'rest';
    return false;
  }
  var TOKEN_SEP = /[\s,./·()\[\]!?~:;'"“”‘’]/;
  function tokensOf(text) { return nfc(text).toLowerCase().split(/[\s,./·()\[\]!?~:;'"“”‘’]+/).filter(Boolean); }
  // 공백을 뺀 글에서 낱말이 시작하는 자리 { index: true }
  function tokenStarts(t) {
    var starts = {}, ti = 0, prevSep = true;
    for (var i = 0; i < t.length; i++) {
      var ch = t.charAt(i);
      if (/\s/.test(ch)) { prevSep = true; continue; }
      var sep = TOKEN_SEP.test(ch);
      if (!sep && prevSep) starts[ti] = true;
      prevSep = sep;
      ti++;
    }
    return starts;
  }
  function onPhone(task) {
    var title = typeof task === 'string' ? task : (task && task.title) || '';
    return tokensOf(title).some(function (tok) { return SW.PHONE_WORDS.some(function (w) { return tok.indexOf(w) === 0; }); });
  }

  // ------------------------------------------------------------------ 맥락 (§6)
  function ruleContext(text, pf) {
    pf = pf || profile({});
    var t = nfc(text).replace(/(^|\s)#[^\s#]+/g, ' ').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!t) return null;
    var tt = t.replace(/\s+/g, ''), toks = tokensOf(t), starts = tokenStarts(t);
    var scores = {}, ev = {}, used = {};
    function add(c, w, word) {
      scores[c] = (scores[c] || 0) + w;
      if (!ev[c] || w > ev[c].w) ev[c] = { w: w, word: word };
    }
    // 띄어 쓴 키워드는 낱말 머리에서 시작할 때만 ('선물 주기' 안의 '물 주기', '바코드 리뷰' 안의 '코드 리뷰' 는 아니다)
    function spacedAt(k) {
      for (var i = tt.indexOf(k.t); i !== -1; i = tt.indexOf(k.t, i + 1)) if (starts[i]) return true;
      return false;
    }
    var idx = pf.ctxWords;
    idx.spaced.forEach(function (k) { if (spacedAt(k)) { add(k.ctx, k.weight, k.w); k.parts.forEach(function (p) { used[p] = true; }); } });
    toks.forEach(function (tok) {
      if (used[tok]) return;
      if (SW.CONTEXT_EXCLUDE.some(function (x) { return tok.indexOf(x) === 0; })) return;
      for (var i = 0; i < idx.single.length; i++) {
        var k = idx.single[i];
        if (k.latin ? tok === k.k : tok.indexOf(k.k) === 0) { add(k.ctx, k.weight, k.w); return; }
      }
    });
    var em = idx.errandEnd.exec(t);
    if (em && pf.contexts.errand) add('errand', SW.ERRAND_ENDING_WEIGHT, em[0]);
    var ranked = Object.keys(scores).sort(function (a, b) { return scores[b] - scores[a] || pf.contextIds.indexOf(a) - pf.contextIds.indexOf(b); });
    if (!ranked.length) return null;
    var best = scores[ranked[0]], second = ranked.length > 1 ? scores[ranked[1]] : 0;
    if (best < 2 || best - second < 1) return null;
    return { ctx: ranked[0], score: best, margin: best - second, evidence: ev[ranked[0]].word, scores: scores };
  }

  function adaptOn(state) {
    if (!AD || typeof AD.suggest !== 'function') return false;
    if (state && state.prefs && state.prefs.learning === false) return false;
    return typeof AD.enabled === 'function' ? !!AD.enabled(state) : true;
  }
  function learnedSuggest(state, text, pf, now) {
    if (!text || !adaptOn(state)) return null;
    return AD.suggest(state, 'context', text, now, { allowed: pf.contextIds.concat(['none']) }) || null;
  }

  var ctxMemo = {}, ctxMemoN = 0;
  function contextOf(state, task, pf, now) {
    pf = pf || profile(state && state.prefs);
    var proj = task.projectId ? M.byId(state.projects || [], task.projectId) : null;
    var projCtx = proj && !proj.deletedAt ? proj.context || null : null;
    var src0 = (task.sources || [])[0] || null;
    var email = (task.sources || []).some(function (s) { return s && s.type === 'email'; });
    var lr = state.learned, mt = lr && lr.metrics;
    var stamp = !adaptOn(state) ? 'off' : (mt ? [mt.learned, mt.applied, mt.reverted, mt.hinted].join(',') : '-') + ':' + (lr && Array.isArray(lr.rules) ? lr.rules.length : 0);
    // now 가 없으면 학습 단계를 건너뛰므로 키에 넣는다 (now 없이 부른 결과가 메모를 차지하지 않게)
    var key = [pf.hash, task.id, task.updatedAt, task.title, task.projectId, projCtx, task.context, task.contextSource,
      email ? 1 : 0, src0 && src0.excerpt, now ? stamp : 'no-now'].join('|');
    if (ctxMemo[key]) return ctxMemo[key];
    var r = computeContext(state, task, pf, now, projCtx, proj, email);
    if (ctxMemoN > 4000) { ctxMemo = {}; ctxMemoN = 0; }
    ctxMemo[key] = r; ctxMemoN++;
    return r;
  }
  function computeContext(state, task, pf, now, projCtx, proj, email) {
    function out(value, source, evidence, ruleIds) {
      var o = { value: value, source: source, evidence: evidence == null ? null : evidence };
      if (ruleIds) o.ruleIds = ruleIds;
      return o;
    }
    var known = function (c) { return !!c && !!pf.contexts[c]; };
    // 1. 사용자 (null = '정하지 않음'으로 고정). 지운 사용자 맥락이면 건너뛴다
    if (task.contextSource === 'user' && (task.context == null || known(task.context))) return out(task.context || null, 'user', null);
    // 2. 프로젝트
    if (known(projCtx)) return out(projCtx, 'project', proj.name || null);
    var text = (task.title || '').trim() || ((task.sources || [])[0] && (task.sources || [])[0].excerpt) || '';
    var sg = now ? learnedSuggest(state, text, pf, now) : null;
    function fromLearned() { return out(sg.to === 'none' ? null : sg.to, 'learned', sg.phrase || null, (sg.ruleIds || []).slice()); }
    // 3. 배운 제목 (정확 일치, 참고 이상)
    if (sg && sg.role === 'exact' && (sg.to === 'none' || known(sg.to))) return fromLearned();
    // 4. AI
    if (task.contextSource === 'ai' && known(task.context)) return out(task.context, 'ai', null);
    // 5. 배운 낱말 (확실)
    if (sg && sg.level === 'strong' && (sg.to === 'none' || known(sg.to))) return fromLearned();
    // 6. 단어 규칙
    var rc = ruleContext(text, pf);
    if (rc) return out(rc.ctx, 'rule', rc.evidence);
    // 7. 약한 힌트 — 메일에서 온 할 일은 업무 (내릴 수는 있어도 숨기지는 못한다)
    if (email && known('work')) return out('work', 'hint', null);
    return out(null, null, null);
  }
  function contextLabel(pf, ctxId) {
    pf = pf || profile({});
    if (ctxId == null || ctxId === 'none' || ctxId === '_none') return SW.NONE_LABEL;
    return pf.contexts[ctxId] ? pf.contexts[ctxId].label : GONE_LABEL;
  }
  function contextHintsForAi(pf) {
    pf = pf || profile({});
    return pf.contextIds.map(function (id) {
      var c = pf.contexts[id];
      var words = c.words.map(function (x, i) { return { w: x.w, weight: x.weight, i: i }; })
        .sort(function (a, b) { return b.weight - a.weight || a.i - b.i; }).slice(0, 6).map(function (x) { return x.w; });
      return { id: id, label: c.label, hint: words.join('·') };
    });
  }
  function ctxForTag(pf, word) {
    var k = tight(word).toLowerCase();
    for (var i = 0; i < pf.contextIds.length; i++) {
      var c = pf.contexts[pf.contextIds[i]];
      var names = [c.id, c.label].concat(c.aliases || []);
      if (names.some(function (n) { return tight(n).toLowerCase() === k; })) return c.id;
    }
    return null;
  }
  // '#집안일 빨래' → { ctx:'home', tag:'#집안일', text:'빨래' }. '# 회의록'(# 뒤 공백)은 태그가 아니다
  function extractContextTag(text, pf) {
    pf = pf || profile({});
    var s = String(text == null ? '' : text), re = /(^|\s)#([^\s#]+)/g, m;
    while ((m = re.exec(s))) {
      var word = m[2].replace(/[.,!?~…]+$/, '');
      var ctx = ctxForTag(pf, word);
      if (!ctx) continue;
      var start = m.index + m[1].length, end = start + 1 + m[2].length;
      return { ctx: ctx, tag: '#' + word, text: (s.slice(0, start) + s.slice(end)).replace(/[ \t]+/g, ' ').replace(/^\s+|\s+$/g, '') };
    }
    return null;
  }

  // 맥락 직접 정하기 (§6.5) — 라벨 있는 mutate('맥락 바꾸기') 안에서 부른다. 교정과 배우기가 함께 되돌아간다
  function strongParts(state, title, target, pf, now) {
    var out = {};
    if (!adaptOn(state) || typeof AD.phrases !== 'function') return out;
    AD.phrases(title || '', 'context').forEach(function (ph) {
      if (ph.role !== 'part') return;
      var sg = learnedSuggest(state, ph.label, pf, now);
      if (sg && sg.level === 'strong' && sg.to === target) out[ph.key] = ph.label;
    });
    return out;
  }
  function setTaskContext(state, taskId, ctxId, pf, now) {
    pf = pf || profile(state.prefs);
    var t = M.byId(state.tasks, taskId);
    if (!t) return null;
    var to = ctxId == null || ctxId === 'none' ? null : ctxId;
    if (to && !pf.contexts[to]) return null;
    var prev = contextOf(state, t, pf, now);
    var on = adaptOn(state) && typeof AD.learn === 'function';
    var target = to || 'none';
    var before = on ? strongParts(state, t.title, target, pf, now) : {};
    M.updateTask(state, taskId, { context: to, contextSource: 'user' }, now);
    var learned = 'none', phrase = null;
    if (on) {
      if (prev.source === 'learned' && prev.value !== to && prev.ruleIds && prev.ruleIds.length) {
        if (typeof AD.penalize === 'function') AD.penalize(state, prev.ruleIds, now, 1);
        if (typeof AD.count === 'function') AD.count(state, 'reverted');
      }
      var noteRef = (t.sources || []).filter(function (s) { return s && s.type === 'note'; })[0];
      AD.learn(state, { type: 'context', text: t.title, from: prev.value || null, to: target, ref: noteRef ? noteRef.refId : null,
        sample: !!t.sample, source: 'correction' }, now);
      var after = strongParts(state, t.title, target, pf, now);
      Object.keys(after).forEach(function (k) { if (!before[k] && !phrase) { learned = 'strong'; phrase = after[k]; } });
      if (learned === 'none') {
        var sg = learnedSuggest(state, t.title, pf, now);
        if (sg && sg.to === target) learned = 'hint';
      }
    }
    return { task: t, learned: learned, phrase: phrase };
  }
  // 언제 할까요 (§10.6) — 라벨 있는 mutate('언제 할지 바꾸기') 안에서. mode null = 상관없음
  function setTaskAtMode(state, taskId, mode, now) {
    if (mode != null && !has(SW.ATMODES, mode)) return null;
    return M.updateTask(state, taskId, { atMode: mode || null, atModeSource: 'user' }, now);
  }

  // ------------------------------------------------------------------ 정책 (§7)
  var nasMemo = {}, nasMemoN = 0;
  // 돌파 기준 시각 — 평소 리듬대로라면 이 맥락을 다음에 언제 보게 되나 (짐작 완화 전 표로 판단)
  function nextActiveStart(pf, ctxId, eff, now) {
    now = toDate(now);
    var wh = pf.schedule.workHours;
    if (pf.schedule.mode === 'off' || !wh.days.length) return new Date(now.getTime() + 12 * HOUR);
    var t0 = eff && !eff.guessed && eff.expiresAt ? toDate(eff.expiresAt) : now;
    if (t0.getTime() < now.getTime()) t0 = now;
    var key = pf.hash + '|' + (ctxId || '_none') + '|' + t0.toISOString();
    if (nasMemo[key]) return new Date(nasMemo[key]);
    var segs = timeline(pf, t0, 8), found = null;
    for (var i = 0; i < segs.length && !found; i++) {
      var row = pf.matrix[segs[i].id];
      var lv = row ? (own(row, ctxId) ? row[ctxId] : row._none) : 'normal';
      if (lv !== 'hide') found = Math.max(ms(segs[i].start), t0.getTime());
    }
    if (found == null) found = t0.getTime() + 8 * DAY;
    if (nasMemoN > 2000) { nasMemo = {}; nasMemoN = 0; }
    nasMemo[key] = found; nasMemoN++;
    return new Date(found);
  }
  // 작업 블록 색인 (view·applyStatusPolicy 한 번에 한 번 만든다)
  function blockIndex(state) {
    var idx = dict();
    (state.blocks || []).forEach(function (b) { if (b.taskId) (idx[b.taskId] = idx[b.taskId] || []).push(b); });
    return idx;
  }
  function blockSoon(state, task, now, idx) {
    var t0 = now.getTime(), lim = t0 + BLOCK_SOON_MIN * MIN;
    var list = idx ? (own(idx, task.id) ? idx[task.id] : []) : (state.blocks || []);
    return list.some(function (b) {
      return b.taskId === task.id && ms(b.start) <= lim && ms(b.end) > t0;
    });
  }
  // idx: (선택) blockIndex 결과 — 여러 할 일을 한꺼번에 볼 때
  function levelOf(state, task, ctxR, eff, pf, now, idx) {
    if (!eff) return { level: 'normal', reason: null, breakthrough: null };
    pf = pf || profile(state.prefs);
    now = toDate(now);
    ctxR = ctxR || contextOf(state, task, pf, now);
    var p = pres(state);
    var shown = has(p.shown, task.id);
    if (eff.category === 'sleep') return shown ? { level: 'normal', reason: 'shown', breakthrough: null } : { level: 'hide', reason: 'sleep', breakthrough: null };
    var row = pf.matrix[eff.id];
    var key = ctxR.value && own(row, ctxR.value) ? ctxR.value : '_none';
    var lvl = row ? row[key] : 'normal', reason = 'policy';
    if (eff.guessed) {
      if (lvl === 'up') lvl = 'normal';
      else if (lvl === 'hide' && !pf.schedule.hideOnGuess) lvl = 'down';
    }
    if (ctxR.source === 'hint' && lvl === 'hide') lvl = 'down';
    if (!eff.guessed && task.atMode && task.atMode !== 'pause' && atModeMatches(task.atMode, eff.id, pf)) { lvl = 'up'; reason = 'when'; }
    else if (eff.category === 'moving' && lvl !== 'hide' && onPhone(task)) { lvl = 'up'; reason = 'phone'; }
    var bt = null;
    if (lvl === 'hide' || lvl === 'down') {
      var best = null, dueAt = null;
      var raise = function (l, r) { if (!best || LEVEL_RANK[l] < LEVEL_RANK[best.level]) best = { level: l, reason: r }; };
      if (shown) raise('normal', 'shown');
      if (task.status === 'in_progress' && task.startedAt && eff.since && ms(task.startedAt) >= ms(eff.since)) raise('normal', 'started');
      if (blockSoon(state, task, now, idx)) raise('normal', 'block');
      if (task.dueDate) {
        dueAt = D.parseYmd(task.dueDate, task.dueTime || '23:59');
        var m = (dueAt.getTime() - now.getTime()) / MIN;
        if (lvl === 'hide' && (m < 0 || dueAt.getTime() < nextActiveStart(pf, ctxR.value, eff, now).getTime())) raise('down', 'due');
        if (pf.urgentHours > 0 && m >= 0 && m <= pf.urgentHours * 60) raise('normal', 'due_soon');
      }
      if (best && LEVEL_RANK[best.level] < LEVEL_RANK[lvl]) {
        lvl = best.level; reason = best.reason;
        if (reason === 'due' || reason === 'due_soon') bt = { dueAt: iso(dueAt), soon: reason === 'due_soon' };
      }
    }
    return { level: lvl, reason: reason, breakthrough: bt };
  }

  // 이유 문장 (C21) — recommend 는 이 문장을 그대로 맨 앞에 쓴다
  function sentenceFor(task, o, eff, now) {
    if (o.reason === 'when') return '‘' + atModePhrase(task.atMode) + '’ 하기로 한 일이에요.';
    if (o.reason === 'phone') return '이동 중에 폰으로 할 수 있는 일이에요.';
    if (o.breakthrough) {
      var due = toDate(o.breakthrough.dueAt);
      // 마감 시각이 없으면 '23:59' 대신 '오늘'
      if (o.breakthrough.soon) return '‘' + o.ctxLabel + '’ 할 일이지만 ' + (task.dueTime ? D.hm(due) : D.relDay(task.dueDate, now)) + ' 마감이라 골랐어요.';
      return '‘' + o.ctxLabel + '’ 할 일이지만 ' + D.relDay(task.dueDate, now) + (task.dueTime ? ' ' + task.dueTime : '') + ' 마감이라 남겨 뒀어요.';
    }
    if (o.level === 'up' && o.reason === 'policy' && !eff.guessed && o.ctx) {
      return '지금은 ‘' + eff.label + '’' + iraJosa(eff.label) + ' ‘' + o.ctxLabel + '’ 일을 먼저 골랐어요.';
    }
    return null;
  }
  function taskLevel(state, task, eff, pf, now, idx) {
    var ctxR = contextOf(state, task, pf, now);
    var lv = levelOf(state, task, ctxR, eff, pf, now, idx);
    var o = { level: lv.level, reason: lv.reason, ctx: ctxR.value, ctxSource: ctxR.source, ctxLabel: contextLabel(pf, ctxR.value),
      evidence: ctxR.evidence, breakthrough: lv.breakthrough, sentence: null };
    o.sentence = sentenceFor(task, o, eff, now);
    return o;
  }
  function applyStatusPolicy(state, tasks, eff, pf, now) {
    pf = pf || profile(state.prefs);
    now = toDate(now);
    var list = tasks || [];
    if (!eff) return { visible: list.map(function (t) { return t.id; }), demoted: [], hidden: [], levels: {}, reasons: {} };
    var up = [], normal = [], demoted = [], hidden = [], levels = {}, reasons = {}, idx = blockIndex(state);
    list.forEach(function (t) {
      var o = taskLevel(state, t, eff, pf, now, idx);
      levels[t.id] = o;
      if (o.sentence) reasons[t.id] = o.sentence;
      (o.level === 'up' ? up : o.level === 'normal' ? normal : o.level === 'down' ? demoted : hidden).push(t.id);
    });
    return { visible: up.concat(normal), demoted: demoted, hidden: hidden, levels: levels, reasons: reasons };
  }

  // 오늘 목록 조건 (renderer/views/today.js todayTaskList 와 같은 식) — 숨긴 수를 오늘 화면과 같게 센다
  // idx: (선택) blockIndex 결과 — 할 일마다 블록 전체를 훑지 않게
  function inTodayList(state, t, now, idx) {
    var today = D.ymd(now);
    if (t.status === 'in_progress') return true;
    if (t.dueDate && t.dueDate <= today) return true;
    if (t.createdAt && D.ymd(t.createdAt) === today) return true;
    var list = idx ? (own(idx, t.id) ? idx[t.id] : []) : (state.blocks || []);
    return list.some(function (b) { return b.taskId === t.id && b.start && D.ymd(b.start) === today; });
  }
  function excluded(state, t, now) {
    if (t.deletedAt || t.archivedAt || t.status === 'done' || t.status === 'waiting') return true;
    if (M.unmetBlockers(state, t).length) return true;
    return !!(t.snoozedUntil && ms(t.snoozedUntil) > now.getTime());
  }
  function isAnchored(t, eff, pf) {
    if (!t.atMode) return false;
    if (t.atMode === 'pause') return !!eff.overlay && has(SW.ATMODE_STATUS.pause, eff.overlay.id);
    return !eff.guessed && atModeMatches(t.atMode, eff.id, pf);
  }

  function view(state, pf, now) {
    pf = pf || profile(state && state.prefs);
    now = toDate(now);
    var eff = effective(state, pf, now);
    if (!eff) return null;
    var p = pres(state);
    var levels = {}, hiddenIds = [], anchored = [], summary = { hidden: 0, byCtx: {}, parked: 0 }, idx = blockIndex(state);
    M.liveTasks(state).forEach(function (t) {
      if (t.status === 'done') return;
      var o = taskLevel(state, t, eff, pf, now, idx);
      levels[t.id] = o;
      if (o.level === 'hide') {
        hiddenIds.push(t.id);
        if (inTodayList(state, t, now, idx)) {
          var k = o.ctx || '_none';
          summary.hidden++;
          summary.byCtx[k] = (summary.byCtx[k] || 0) + 1;
          if (has(p.parked, t.id)) summary.parked++;
        }
      }
      if (isAnchored(t, eff, pf)) anchored.push(t.id);
    });
    var win = workWindowOn(D.startOfDay(now), pf.schedule.workHours);
    var inWin = !!win && now.getTime() >= win.start.getTime() && now.getTime() < win.end.getTime();
    var remain = null;
    if (eff.overlay && eff.overlay.until && eff.rec === 'short') remain = Math.max(0, Math.floor((timeOf(eff.overlay.until) - now.getTime()) / MIN));
    return {
      active: true, id: eff.id, label: eff.label, category: eff.category, guessed: eff.guessed, since: eff.since,
      overlay: eff.overlay, rec: eff.rec, busy: eff.busy, nudges: eff.nudges,
      remainMinutes: remain,
      offHours: eff.guessed ? !inWin : eff.category !== 'work',
      workWindow: eff.category === 'work' && inWin ? { start: iso(win.start), end: iso(win.end) } : null,
      levels: levels, hiddenIds: hiddenIds, anchored: anchored, summary: summary, at: iso(now)
    };
  }
  function isHidden(v, taskId) { return !!(v && v.levels && v.levels[taskId] && v.levels[taskId].level === 'hide'); }

  // 오늘 화면 나누기 (§9.1). open = todayTaskList(st, now).open (할 일 객체 또는 id), opts { rankedIds, now }
  function partitionToday(state, open, v, opts) {
    opts = opts || {};
    var openIds = (open || []).map(function (x) { return typeof x === 'string' ? x : x.id; });
    if (!v) return { when: [], up: [], normal: openIds.slice(), extra: [], down: [], hidden: [], summary: null };
    var now = toDate(opts.now || v.at);
    var rank = {};
    (opts.rankedIds || []).forEach(function (id, i) { if (!(id in rank)) rank[id] = i; });
    var live = M.liveTasks(state), pos = {};
    live.forEach(function (t, i) { pos[t.id] = i; });
    function byRank(a, b) {
      var ra = a in rank ? rank[a] : Infinity, rb = b in rank ? rank[b] : Infinity;
      return ra !== rb ? (ra < rb ? -1 : 1) : pos[a] - pos[b];
    }
    var inOpen = {};
    openIds.forEach(function (id) { inOpen[id] = true; });
    var explicit = !v.guessed;
    var lv = function (id) { return v.levels[id] || null; };
    var whenIds = [];
    if (explicit) {
      live.forEach(function (t) {
        var l = lv(t.id);
        if (!l || l.reason !== 'when' || t.status === 'done') return;
        if (!inOpen[t.id] && excluded(state, t, now)) return;
        whenIds.push(t.id);
      });
      whenIds = whenIds.sort(byRank).slice(0, MAX_WHEN);
    }
    var inWhen = {};
    whenIds.forEach(function (id) { inWhen[id] = true; });
    var up = [], normal = [], down = [], hidden = [];
    openIds.forEach(function (id) {
      if (inWhen[id]) return;
      var t = M.byId(state.tasks, id);
      if (!t || t.status === 'done') return;
      var l = lv(id), level = l ? l.level : 'normal';
      (level === 'up' ? up : level === 'down' ? down : level === 'hide' ? hidden : normal).push(id);
    });
    var extra = [];
    if (explicit) {
      extra = live.filter(function (t) {
        var l = lv(t.id);
        return !inOpen[t.id] && !inWhen[t.id] && l && l.level === 'up' && !excluded(state, t, now);
      }).map(function (t) { return t.id; }).sort(byRank).slice(0, MAX_EXTRA);
    }
    var p = pres(state), byCtx = {}, parked = 0;
    hidden.forEach(function (id) {
      var k = (lv(id) && lv(id).ctx) || '_none';
      byCtx[k] = (byCtx[k] || 0) + 1;
      if (has(p.parked, id)) parked++;
    });
    return { when: whenIds, up: up, normal: normal, extra: extra, down: down, hidden: hidden,
      summary: { hidden: hidden.length, byCtx: byCtx, parked: parked, guessedDown: !!v.guessed && down.length > 0 } };
  }

  // 끌기 저장 (§9.3): [when, up+normal, down] 을 이은 전체 순서에서 끈 묶음만 새 순서로 바꾼다 → (i+1)*10 으로 매긴다
  function joinOrder(groups, key, newIds) {
    var out = [], seen = {};
    ['when', 'upNormal', 'down'].forEach(function (k) {
      ((k === key ? newIds : groups && groups[k]) || []).forEach(function (id) { if (!seen[id]) { seen[id] = true; out.push(id); } });
    });
    return out;
  }
  // '업무 할 일 5개 숨김' / '업무 할 일 4개 · 공부 1개 숨김' / '… (하던 일 1)'. opts.short → '업무 5 숨김'
  function hiddenSummaryText(summary, pf, opts) {
    if (!summary || !summary.hidden) return '';
    pf = pf || profile({});
    var by = summary.byCtx || {};
    var keys = Object.keys(by).filter(function (k) { return by[k] > 0; }).sort(function (a, b) {
      var ia = pf.contextIds.indexOf(a), ib = pf.contextIds.indexOf(b);
      return by[b] - by[a] || (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    var lab = function (k) { return k === '_none' ? OTHER_LABEL : contextLabel(pf, k); };
    if (!keys.length) { keys = ['_none']; by = { _none: summary.hidden }; }
    if (opts && opts.short) return keys.map(function (k) { return lab(k) + ' ' + by[k]; }).join(' · ') + ' 숨김';
    var s = keys.map(function (k, i) { return lab(k) + (i === 0 ? ' 할 일 ' : ' ') + by[k] + '개'; }).join(' · ') + ' 숨김';
    if (summary.parked) s += ' (하던 일 ' + summary.parked + ')';
    return s;
  }

  // ------------------------------------------------------------------ 상태 바꾸기 (§4.5) — presence 만 바꾼다 (I2)
  function pushLog(p, entry) {
    var e = { at: entry.at, id: entry.id, label: entry.label, from: entry.from, fromLabel: entry.fromLabel, source: entry.source };
    if (entry.text) e.text = String(entry.text).slice(0, LOG_TEXT_MAX);
    p.log.push(e);
    if (p.log.length > LOG_MAX) p.log.splice(0, p.log.length - LOG_MAX);
  }
  function baseRef(cur) {
    var r = { id: cur.id, label: cur.label, since: cur.since, source: cur.source || null };
    if (cur.until) r.until = cur.until;
    return r;
  }
  // 새 current 를 넣고, 범주가 바뀌면 이어하기 후보(parked)를 정리하고, 기록을 남긴다
  function commit(state, pf, now, eff0, newCur, opts) {
    var p = ensure(state), nowIso = iso(now);
    p.current = newCur;
    if (!p.activatedAt) {
      p.activatedAt = nowIso;
      var g = guessPreset(state);
      if (g && g !== pf.preset) notePresetSignal(state, g, now);
    }
    var eff1 = effective(state, pf, now);
    var newOverlay = !!newCur && overlayLike(newCur, pf) && pf.statuses[newCur.id].overlay;
    var parked = [], resume = [];
    // 바탕이 바뀌면 '펼쳐 본' 목록을 먼저 비운다 (옛 상태에서 펼친 할 일이 parked 계산에서 보통으로 보이지 않게)
    if (!newOverlay && (!eff0 || !eff1 || eff0.id !== eff1.id || eff0.guessed !== eff1.guessed)) p.shown = [];
    if (!newOverlay && eff1) {
      // 이어하기는 '명시한' 업무 상태가 될 때 돌려준다 (밤사이 퇴근이 낡아 짐작이 이미 '업무 중'이어도)
      var wasWork = !!eff0 && eff0.category === 'work', isWork = eff1.category === 'work';
      var wasExplicitWork = wasWork && !eff0.guessed;
      if (wasWork && !isWork) {
        M.liveTasks(state).forEach(function (t) {
          if (t.status !== 'in_progress') return;
          if (levelOf(state, t, contextOf(state, t, pf, now), eff1, pf, now).level === 'hide') parked.push(t.id);
        });
        parked.forEach(function (id) { if (!has(p.parked, id)) p.parked.push(id); });
      } else if (!wasExplicitWork && isWork && !eff1.guessed) {
        resume = p.parked.filter(function (id) { var t = M.byId(state.tasks, id); return t && !t.deletedAt && !t.archivedAt && t.status !== 'done'; });
        p.parked = [];
      }
    }
    var to = newCur ? { id: newCur.id, label: newCur.label } : { id: eff1 ? eff1.id : null, label: eff1 ? eff1.label : null, guessed: true };
    var from = eff0 ? { id: eff0.id, label: eff0.label, guessed: eff0.guessed } : null;
    pushLog(p, { at: nowIso, id: newCur ? newCur.id : null, label: to.label, from: eff0 && !eff0.guessed ? eff0.id : null,
      fromLabel: eff0 && !eff0.guessed ? eff0.label : null, source: (opts && opts.source) || 'menu', text: opts && opts.text });
    return { noop: false, from: from, to: to, parked: parked, resume: resume, at: nowIso };
  }

  // target { id|null(=시간표대로), label?, role?, until?, minutes? }, opts { source, text? }
  function setStatus(state, target, opts, pf, now) {
    pf = pf || profile(state.prefs);
    now = toDate(now);
    opts = opts || {};
    target = target || {};
    var p = ensure(state);
    settle(state, pf, now);
    var eff0 = effective(state, pf, now), nowIso = iso(now);
    var from = eff0 ? { id: eff0.id, label: eff0.label, guessed: eff0.guessed } : null;
    if (target.id == null) {
      if (!p.current && p.activatedAt) return { noop: true, from: from, to: { id: from && from.id, label: from && from.label, guessed: true }, parked: [], resume: [], at: nowIso };
      return commit(state, pf, now, eff0, null, opts);
    }
    var def = pf.statuses[target.id];
    if (!def) return null;
    var cur = p.current;
    if (cur && cur.id === target.id && !target.until && !target.minutes) {
      return { noop: true, from: from, to: { id: cur.id, label: cur.label }, parked: [], resume: [], at: nowIso, since: cur.since };
    }
    if (cur && cur.id === target.id && overlayLike(cur, pf)) {
      var u = target.until ? toDate(target.until) : D.addMinutes(now, target.minutes);
      cur.until = iso(u);
      return { noop: false, extended: true, from: from, to: { id: cur.id, label: cur.label }, parked: [], resume: [], at: nowIso, until: cur.until };
    }
    var until = target.until ? toDate(target.until) : target.minutes ? D.addMinutes(now, target.minutes) : def.overlay ? defaultUntil(def, pf, now) : null;
    var returnTo = null;
    if (def.overlay || (target.id === 'sleep' && until)) {
      if (cur && overlayLike(cur, pf)) returnTo = cur.returnTo || null;
      else if (cur) returnTo = baseRef(cur);
    }
    var newCur = { id: target.id, label: target.label || def.label, role: target.role || null, since: nowIso,
      source: opts.source || 'menu', until: until ? iso(until) : null, returnTo: returnTo };
    return commit(state, pf, now, eff0, newCur, opts);
  }
  function lastUserLog(p) {
    for (var i = p.log.length - 1; i >= 0; i--) if (p.log[i] && !AUTO_SOURCES[p.log[i].source]) return p.log[i];
    return null;
  }
  // 마지막 기록의 from 으로 (from 이 null 이면 시간표대로). 카드는 만들지 않는다
  function revert(state, pf, now) {
    pf = pf || profile(state.prefs);
    var p = ensure(state);
    var last = lastUserLog(p);
    if (!last) return null;
    if (last.from && pf.statuses[last.from]) return setStatus(state, { id: last.from, label: last.fromLabel }, { source: 'revert' }, pf, now);
    return setStatus(state, { id: null }, { source: 'revert' }, pf, now);
  }
  // 시간표대로 (current = null)
  function toGuess(state, now, pf) {
    return setStatus(state, { id: null }, { source: 'menu' }, pf || profile(state.prefs), now);
  }
  // 잘 시간에 글을 적으면 깨어 있는 것으로 본다 (낮잠이면 원래 상태로)
  function wake(state, now) {
    var p = ensure(state), cur = p.current;
    if (!cur || cur.id !== 'sleep') return false;
    p.current = cur.until && cur.returnTo ? restoreRef(cur.returnTo) : null;
    p.shown = [];
    pushLog(p, { at: iso(now), id: p.current ? p.current.id : null, label: p.current ? p.current.label : null, from: 'sleep', fromLabel: cur.label, source: 'wake' });
    return true;
  }
  // 지난 덧씌움·반차·낡은 상태를 저장한다. 바뀐 것이 없으면 false
  function settle(state, pf, now) {
    pf = pf || profile(state.prefs);
    now = toDate(now);
    var p = ensure(state), changed = false, guard = 0;
    while (p.current && guard++ < 4) {
      var cur = p.current, def = pf.statuses[cur.id], next, endAt, source;
      if (!def) { next = null; endAt = now; source = 'expire'; }
      else if (cur.until && ms(cur.until) <= now.getTime()) { next = cur.returnTo && pf.statuses[cur.returnTo.id] ? restoreRef(cur.returnTo) : null; endAt = toDate(cur.until); source = 'until'; }
      else if (isStale(cur, pf, now)) { next = null; endAt = staleAt(cur, pf); source = 'expire'; }
      else break;
      if (!def || !def.overlay) p.shown = [];
      pushLog(p, { at: iso(endAt), id: next ? next.id : null, label: next ? next.label : null, from: cur.id, fromLabel: cur.label, source: source });
      p.current = next;
      changed = true;
    }
    return changed;
  }
  function markShown(state, taskId) {
    var p = ensure(state);
    if (!taskId || has(p.shown, taskId)) return;
    p.shown.push(taskId);
    if (p.shown.length > SHOWN_MAX) p.shown.splice(0, p.shown.length - SHOWN_MAX);
  }
  // 지금 짐작 상태를 명시로 정한다 ('뒤로 미룬 일' 머리의 [퇴근으로 정하기])
  function confirmGuess(state, pf, now) {
    pf = pf || profile(state.prefs);
    var eff = effective(state, pf, now);
    if (!eff || !eff.guessed) return null;
    return setStatus(state, { id: eff.id, label: eff.label }, { source: 'confirm' }, pf, now);
  }

  // ------------------------------------------------------------------ 잔소리 예산 (§13) · 근무 끝 줄 · 프리셋 제안 (§12.4)
  // STATUS §13 은 (state, now) 로 적었고 계획 §3.6 은 (state, profile, now) 다 — 둘 다 받는다
  function isProfile(x) { return !!x && typeof x === 'object' && !(x instanceof Date) && !!x.schedule && !!x.statuses; }
  function budgetOk(state, pf, now) {
    if (now === undefined && !isProfile(pf)) { now = pf; pf = null; }
    pf = pf || profile(state && state.prefs);
    var h = pres(state).hints;
    return h.day !== dayKey(pf, now) || (h.used || 0) < 1;
  }
  function useBudget(state, pf, now) {
    if (now === undefined && !isProfile(pf)) { now = pf; pf = null; }
    pf = pf || profile(state.prefs);
    var h = ensure(state).hints, k = dayKey(pf, now);
    if (h.day !== k) { h.day = k; h.used = 0; }
    h.used = (h.used || 0) + 1;
  }
  function overtimeDue(state, pf, now) {
    if (now === undefined && !isProfile(pf)) { now = pf; pf = null; }
    pf = pf || profile(state && state.prefs);
    now = toDate(now);
    if (!pf.schedule.overtimeLine) return false;
    var eff = effective(state, pf, now);
    if (!eff || eff.guessed || eff.overlay || eff.category !== 'work') return false;
    var p = pres(state);
    if ((p.hints.overtimeDismiss || 0) >= 2 || !budgetOk(state, pf, now)) return false;
    if (guess(pf, now).id === 'work') return false;
    var win = workWindowOn(logicalDay(now, pf), pf.schedule.workHours);
    if (!win || now.getTime() - win.end.getTime() < OVERTIME_MIN * MIN) return false;
    var cur = p.current;
    return !(cur && cur.since && ms(cur.since) >= win.end.getTime());
  }
  function dismissOvertime(state, pf, now) {
    if (now === undefined && !isProfile(pf)) { now = pf; pf = null; }
    var p = ensure(state);
    p.hints.overtimeDismiss = (p.hints.overtimeDismiss || 0) + 1;
    useBudget(state, pf, now);
  }
  function notePresetSignal(state, presetId, now) {
    if (!own(SW.PRESETS, presetId)) return;
    var h = ensure(state).hints, t0 = toDate(now).getTime();
    var list = Array.isArray(h.presetSeen[presetId]) ? h.presetSeen[presetId] : [];
    list = list.filter(function (at) { var t = ms(at); return t <= t0 && t0 - t <= SIGNAL_DAYS * DAY; });
    list.push(iso(now));
    h.presetSeen[presetId] = list;
  }
  function presetOfferDue(state, pf, now) {
    pf = pf || profile(state && state.prefs);
    var h = pres(state).hints, t0 = toDate(now).getTime(), best = null;
    if (!budgetOk(state, pf, now)) return null;
    SW.PRESET_ORDER.forEach(function (id) {
      if (id === pf.preset || SW.PRESETS[id].stage !== 'v1' || h.presetOffered[id]) return;
      var n = (Array.isArray(h.presetSeen[id]) ? h.presetSeen[id] : []).filter(function (at) {
        var t = ms(at); return t <= t0 && t0 - t <= SIGNAL_DAYS * DAY;
      }).length;
      if (n >= SIGNAL_NEED && (!best || n > best.n)) best = { id: id, n: n };
    });
    return best ? best.id : null;
  }
  function markPresetOffered(state, presetId, now) {
    var h = ensure(state).hints;
    h.presetOffered[presetId] = iso(now);
    useBudget(state, profile(state.prefs), now);
  }
  // 다른 프리셋의 전용 말이면 그 프리셋 (§12.3) — 감지처럼 첫 문장만 본다
  function presetSignal(text, pf) {
    pf = pf || profile({});
    var t = String(text == null ? '' : text).replace(/^\s+/, '');
    if (!t || t.charAt(0) === '/') return null;
    var h = norm(splitHead(t).head);
    if (!h || h.length > SW.MAX_HEAD) return null;
    for (var i = 0; i < SW.PRESET_ORDER.length; i++) {
      var pid = SW.PRESET_ORDER[i];
      if (pid === pf.preset || !pf.otherWords[pid]) continue;
      if (readWith(pf.otherWords[pid], h)) return pid;
    }
    return null;
  }
  // 살아 있는 할 일·메모 제목에서 프리셋 신호를 센다. 1등이 3번 이상이고 2등보다 2 이상 많을 때만 (자동 적용은 하지 않는다)
  function guessPreset(state) {
    var titles = M.liveTasks(state).map(function (t) { return t.title || ''; })
      .concat(M.liveNotes(state).map(function (n) { return M.noteTitle(n); }));
    var counts = {}, unless = {};
    Object.keys(SW.PRESET_SIGNALS).forEach(function (pid) { counts[pid] = 0; });
    titles.forEach(function (title) {
      tokensOf(title).forEach(function (tok) {
        if (SW.SIGNAL_EXCLUDE.some(function (x) { return tok.indexOf(x) === 0; })) return;
        Object.keys(SW.PRESET_SIGNALS).forEach(function (pid) {
          var sig = SW.PRESET_SIGNALS[pid];
          sig.words.forEach(function (w) { if (tok.indexOf(w) === 0) counts[pid]++; });
          (sig.unless || []).forEach(function (w) { if (tok.indexOf(w) === 0) unless[pid] = true; });
        });
      });
    });
    Object.keys(unless).forEach(function (pid) { counts[pid] = 0; });
    var ranked = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || SW.PRESET_ORDER.indexOf(a) - SW.PRESET_ORDER.indexOf(b); });
    var top = counts[ranked[0]], second = ranked.length > 1 ? counts[ranked[1]] : 0;
    return top >= 3 && top - second >= 2 ? ranked[0] : null;
  }

  return {
    // 상태 저장소 · 프로필
    ensure: ensure, isActive: isActive, profile: profile, presetList: presetList, normalizeWorkHours: normalizeWorkHours,
    // 유효 상태
    effective: effective, guess: guess, timeline: timeline, view: view, current: current,
    // 말
    detect: detect, parseStatusArgs: parseStatusArgs, resolveRole: resolveRole,
    extractAtMode: extractAtMode, findAtMode: findAtMode, atModePhrase: atModePhrase, atModeMatches: atModeMatches,
    extractContextTag: extractContextTag, presetSignal: presetSignal, guessPreset: guessPreset, onPhone: onPhone,
    // 맥락
    ruleContext: ruleContext, contextOf: contextOf, contextLabel: contextLabel, contextHintsForAi: contextHintsForAi,
    setTaskContext: setTaskContext, setTaskAtMode: setTaskAtMode,
    // 정책 · 오늘 화면
    levelOf: levelOf, nextActiveStart: nextActiveStart, applyStatusPolicy: applyStatusPolicy, partitionToday: partitionToday,
    joinOrder: joinOrder, hiddenSummaryText: hiddenSummaryText, isHidden: isHidden,
    // 상태 바꾸기
    setStatus: setStatus, revert: revert, toGuess: toGuess, wake: wake, settle: settle, markShown: markShown, confirmGuess: confirmGuess,
    // 예산 · 근무 끝 줄 · 프리셋 제안
    budgetOk: budgetOk, useBudget: useBudget, overtimeDue: overtimeDue, dismissOvertime: dismissOvertime,
    notePresetSignal: notePresetSignal, presetOfferDue: presetOfferDue, markPresetOffered: markPresetOffered
  };
});
