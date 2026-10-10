'use strict';
// 할 일을 어느 날 어느 시간에 둘지 고른다. 상태를 바꾸지 않는다. now 를 꼭 넘긴다.
// 하루를 띠(출근 전·업무·점심·퇴근 후·늦은 밤 / 쉬는 날)로 나누고, 할 일의 맥락·걸어 둔 상태·배치 힌트로
// 띠마다 띄움/보통/내림/숨김을 정한 뒤, 15분 칸 후보를 바쁜 시간(Daynote 블록 + Google)을 피해 만들고 점수를 매긴다.
//
// ── 지키는 것 ────────────────────────────────────────────────────
//   · 순수: state 를 바꾸지 않는다. 시계를 읽지 않는다(opts.now 필수). 같은 입력이면 같은 출력(블록 순서와 무관).
//   · 띠 경계는 모두 현지 시각(그날 0시 + 분), 비교는 밀리초. 밤샘 근무는 지원하지 않는다(07:00–23:00 안).
//   · 바쁜 시간은 SL.collectBusy(+opts.extraBusy)만 쓴다 — Google 바쁨 일정도 피한다.
//   · 현재 상태 기능이 켜져 있으면 사용자 정책표를 그대로 쓴다(짐작 완화 없음, 'hint' 맥락만 숨김→내림).
//     presence.current·덧씌움은 보지 않는다 — 앞날의 계획이므로 시간표(ST.timeline)만 본다.
//     꺼져 있거나 status 모듈이 없으면 고정 표를 쓰고, 이유 문장에 맥락 이름을 쓰지 않는다.
//   · 규칙으로 짐작한 배치 힌트는 저장하지 않는다(hintsOf 가 읽을 때 계산한다).
//
// ── 의존성 ───────────────────────────────────────────────────────
//   dates·model·slots 필수. status 선택(없으면 맥락 null, 고정 표). adapt 는 직접 쓰지 않는다
//   (배운 맥락은 ST.contextOf 를 거쳐 들어오고, "평소 이 시간대"는 지난 작업 블록 기록으로 계산한다).
(function (factory) {
  var node = typeof module !== 'undefined' && module.exports;
  var opt = function (name) { try { return require('./' + name); } catch (e) { return null; } };
  var deps = node
    ? { dates: require('./dates'), model: require('./model'), slots: require('./slots'), status: opt('status') }
    : { dates: window.Daynote.dates, model: window.Daynote.model, slots: window.Daynote.slots, status: window.Daynote.statusCore || null };
  var api = factory(deps.dates, deps.model, deps.slots, deps.status);
  if (node) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.planner = api; }
})(function (D, M, SL, ST) {
  var STEP_MIN = 15, MIN_CHUNK = 30, COMMUTE_MIN = 30, EVENING_END = '22:30', DAY_OFF_CORE = ['09:00', '21:00'];
  var MINUTE = 60000, HOUR = 3600000;
  var DEFAULT_LIMIT = 5, DEFAULT_HISTORY_DAYS = 28, DEFAULT_NEAREST_DAYS = 14, DEFAULT_MAX_TASKS = 6, DEFAULT_MAX_MINUTES = 480;
  var DIVERSITY_MIN = 60, EPS = 1e-9;

  var WEIGHTS = Object.freeze({
    level: Object.freeze({ up: 30, normal: 10, down: -20 }),
    comfort: Object.freeze({ morning: -6, late: -4, dayoff_edge: -4, lunch: -6 }),
    preferMatch: 15, preferMiss: -5,
    deepEarly: 8, deepBuffer: -10, bufferMin: 15, nearBusyHours: 3,
    lightGap: 4, lightGapSlack: 30,
    energyHigh: 6, energyHighLate: -8, energyLow: 4,
    urgency: 12, urgencyTiers: Object.freeze([Object.freeze([1, 1]), Object.freeze([3, 0.6]), Object.freeze([7, 0.3])]),
    dueTight: -6, dueTightMin: 60,
    priorityHigh: 8, priorityLow: 3,
    fragTight: 6, fragTightSlack: 15, alignStart: 3, alignEnd: 2, crumb: -4, crumbMin: 30,
    shortSmall: 4, shortMax: 30, smallGap: 60,
    project: 5, projectNear: 15,
    history: 4, historyNeed: 3, historyShare: 0.4, historyBucketHours: 2,
    today: 2
  });

  var LEVEL_RANK = { up: 0, normal: 1, down: 2, hide: 3 };
  var LEVEL_FIT = { up: 'good', normal: 'ok', down: 'poor' };
  var BAND_LABEL = { morning: '출근 전', work: '업무 중', lunch: '점심시간', evening: '퇴근 후', late: '늦은 밤', dayoff_edge: '쉬는 날', dayoff: '쉬는 날' };
  var BAND_STATUS = { morning: 'off', work: 'work', lunch: 'work', evening: 'off', late: 'off', dayoff_edge: 'day_off', dayoff: 'day_off' };
  // 상태 기능이 꺼져 있을 때의 고정 표 (맥락 work / 그 밖 / 모름)
  var FIXED = {
    work: { morning: 'hide', work: 'up', lunch: 'down', evening: 'hide', late: 'hide', dayoff_edge: 'hide', dayoff: 'hide' },
    other: { morning: 'down', work: 'hide', lunch: 'down', evening: 'up', late: 'normal', dayoff_edge: 'normal', dayoff: 'up' }
  };
  var ATMODE_BANDS = {
    work: ['work', 'lunch'],
    off: ['evening', 'late', 'dayoff', 'dayoff_edge'],
    out: ['morning', 'lunch', 'evening', 'dayoff'],
    pause: ['lunch'],
    rest: ['dayoff', 'dayoff_edge']
  };
  var ATMODE_PHRASE = { work: '출근하면', off: '퇴근하고', out: '나가는 김에', pause: '쉬는 시간에', rest: '쉬는 날에' };
  var PREFER_REASON = { morning: '오전에 하기 좋은 일이에요.', afternoon: '오후에 하기 좋은 일이에요.', evening: '저녁에 하기 좋은 일이에요.' };
  // 점수 표 순서 (이유 정렬의 동점 순서)
  var TERM_ORDER = ['level', 'atMode', 'comfort', 'prefer', 'deepEarly', 'deepBuffer', 'lightGap', 'energy', 'urgency', 'dueOk',
    'dueTight', 'priority', 'fragTight', 'fragAlign', 'fragCrumb', 'shortSmall', 'project', 'history', 'today'];

  // ------------------------------------------------------------------ 배치 힌트 사전 (§5.3)
  var HINT_WORDS = {
    focus: {
      deep: ['보고서', '기획', '설계', '공부', '발표', '제안서', '논문', '과제', '분석', '작성', '개발', '코딩', '리뷰', '검토', '계획', '기획서', '시험', '문서', '연구', '집필', '번역', '정리본'],
      light: ['전화', '통화', '메일', '문자', '카톡', '연락', '답장', '주문', '예약', '결제', '송금', '이체', '신청', '확인', '출력', '제출', '버리기', '분리수거', '사기', '구매', '반납', '등록', '정리']
    },
    energy: {
      high: ['운동', '헬스', '러닝', '달리기', '조깅', '청소', '대청소', '이사', '장보기', '등산', '수영', '산책', '빨래'],
      low: ['읽기', '독서', '듣기', '시청', '보기']
    },
    // 붙여 쓴 말과 띄어 쓴 말을 모두 받도록 띄어 쓴 꼴로 둔다 ('퇴근후'·'퇴근 후')
    prefer: {
      morning: ['아침', '오전', '출근 전'],
      afternoon: ['오후', '점심 후'],
      evening: ['저녁', '밤', '퇴근 후', '자기 전']
    },
    splittable: {
      yes: ['조금씩', '틈틈이', '나눠서', '나눠', '매일'],
      no: ['한 번에', '몰아서']
    }
  };
  var SEP_RE = /[\s,./·()\[\]!?~:;'"“”‘’]+/;
  var SEP_CHAR = /[\s,./·()\[\]!?~:;'"“”‘’]/;

  // ------------------------------------------------------------------ 작은 도우미
  function msOf(v) {
    if (v == null || v === '') return NaN;
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return v;
    return new Date(v).getTime();
  }
  function nfc(s) { s = String(s == null ? '' : s); return s.normalize ? s.normalize('NFC') : s; }
  function has(list, x) { return !!list && list.indexOf(x) !== -1; }
  function own(o, k) { return o != null && k != null && Object.prototype.hasOwnProperty.call(o, k); }
  function atMin(day, min) { var d = D.startOfDay(day); d.setHours(0, min, 0, 0); return d; }
  function hmMin(s) { return SL.parseHm(s); }
  function round1(x) { return Math.round(x * 10) / 10; }
  function hasBatchim(s) {
    var c = String(s || '').charCodeAt(String(s || '').length - 1);
    if (c >= 0xAC00 && c <= 0xD7A3) return (c - 0xAC00) % 28 !== 0;
    return /[0-9lmnr]$/i.test(String(s || '')) && !/[2459]$/.test(String(s || ''));
  }
  function ira(label) { return hasBatchim(label) ? '이라' : '라'; }
  function q(s) { return '‘' + s + '’'; }
  function isNum(n) { return typeof n === 'number' && isFinite(n); }

  function fmtDay(date, now) {
    var d = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? D.parseYmd(date) : new Date(msOf(date));
    var diff = D.dayDiff(now, d);
    if (diff === 0) return '오늘';
    if (diff === 1) return '내일';
    return (d.getMonth() + 1) + '/' + d.getDate() + '(' + D.WEEKDAYS[d.getDay()] + ')';
  }
  function fmtRange(start, end) { return D.hm(new Date(msOf(start))) + '–' + D.hm(new Date(msOf(end))); }

  function taskOf(state, taskId) {
    var t = M.byId((state && state.tasks) || [], taskId);
    return t && !t.deletedAt ? t : null;
  }
  function prefsOf(state) { return (state && state.prefs) || {}; }

  // ------------------------------------------------------------------ 배치 힌트 (§5.3)
  // 낱말: [{ tok, at }] — at = 공백을 뺀 글에서 그 낱말이 시작하는 자리
  function lexOf(title) {
    var t = nfc(title).toLowerCase();
    var tt = '', starts = {}, toks = [], prevSep = true, cur = null;
    for (var i = 0; i < t.length; i++) {
      var ch = t.charAt(i);
      if (/\s/.test(ch)) { prevSep = true; cur = null; continue; }
      var sep = SEP_CHAR.test(ch);
      if (!sep && prevSep) { starts[tt.length] = true; cur = { tok: '', at: tt.length }; toks.push(cur); }
      if (sep) cur = null;
      else if (cur) cur.tok += ch;
      prevSep = sep;
      tt += ch;
    }
    return { tt: tt, starts: starts, toks: toks };
  }
  // 키워드가 맞은 가장 뒤 자리 (없으면 −1). 띄어 쓴 키워드는 공백을 뺀 글에서 낱말 머리에 있을 때만
  function lastAt(lex, word) {
    var best = -1;
    if (/\s/.test(word)) {
      var k = word.replace(/\s+/g, '');
      for (var i = lex.tt.indexOf(k); i !== -1; i = lex.tt.indexOf(k, i + 1)) if (lex.starts[i] && i > best) best = i;
      return best;
    }
    lex.toks.forEach(function (x) { if (x.tok.indexOf(word) === 0 && x.at > best) best = x.at; });
    return best;
  }
  // 가장 뒤에 나온 키워드의 쪽 (같은 자리면 긴 키워드)
  function pickLast(lex, groups) {
    var best = null;
    Object.keys(groups).forEach(function (side) {
      groups[side].forEach(function (w) {
        var at = lastAt(lex, w);
        if (at < 0) return;
        var len = w.replace(/\s+/g, '').length;
        if (!best || at > best.at || (at === best.at && len > best.len)) best = { side: side, at: at, len: len };
      });
    });
    return best ? best.side : null;
  }
  function ruleHints(title) {
    var lex = lexOf(title);
    var sp = pickLast(lex, HINT_WORDS.splittable);
    return {
      focus: pickLast(lex, HINT_WORDS.focus),
      energy: pickLast(lex, HINT_WORDS.energy),
      prefer: pickLast(lex, HINT_WORDS.prefer),
      splittable: sp === 'yes' ? true : sp === 'no' ? false : null
    };
  }
  var HINT_KEYS = ['focus', 'energy', 'prefer', 'splittable'];
  function hintsOf(task) {
    var h = task && task.schedHints && typeof task.schedHints === 'object' ? task.schedHints : null;
    var out = { src: {} };
    if (h && h.source === 'user') {
      HINT_KEYS.forEach(function (k) { out[k] = h[k] == null ? null : h[k]; out.src[k] = 'user'; });
      return out;
    }
    var rule = ruleHints(task && task.title);
    HINT_KEYS.forEach(function (k) {
      if (h && h.source === 'ai' && h[k] != null) { out[k] = h[k]; out.src[k] = 'ai'; }
      else { out[k] = rule[k]; out.src[k] = rule[k] == null ? null : 'rule'; }
    });
    return out;
  }

  // ------------------------------------------------------------------ 남은 시간 · 길이
  function isWorkBlock(b) { return !!b && !!b.taskId && (b.kind === 'work' || !b.kind); }
  function remainingMinutes(state, task, now) {
    if (!task || task.estimateMinutes == null || !isNum(Number(task.estimateMinutes))) return null;
    var t = msOf(now), used = 0;
    ((state && state.blocks) || []).forEach(function (b) {
      if (!isWorkBlock(b) || b.taskId !== task.id) return;
      var s = msOf(b.start), e = msOf(b.end);
      if (isNaN(s) || isNaN(e) || e <= t || e <= s) return;
      used += (e - Math.max(s, t)) / MINUTE;
    });
    var r = Math.round(Number(task.estimateMinutes) - used);
    return r < 0 ? 0 : r;
  }
  function lengthOf(state, task, opts) {
    if (isNum(opts.minutes) && opts.minutes > 0) return Math.round(opts.minutes);
    var rem = remainingMinutes(state, task, opts.now);
    if (rem != null && rem > 0) return rem;
    var est = task.estimateMinutes;
    return isNum(est) && est > 0 ? Math.round(est) : null;
  }

  // ------------------------------------------------------------------ 맥락 · 프로필
  function ctxOf(state, opts) {
    if (opts.__ctx) return opts.__ctx;
    var noST = !ST || opts.noStatus === true;
    var prefs = prefsOf(state);
    var wh = SL.normalizeWorkHours(opts.workHours || prefs.workHours);
    var profile = null;
    if (!noST) {
      if (opts.profile) profile = opts.profile;
      else if (opts.workHours) profile = ST.profile(Object.assign({}, prefs, { workHours: opts.workHours }));
      else profile = ST.profile(prefs);
    }
    var active = false;
    if (profile) active = typeof opts.statusActive === 'boolean' ? opts.statusActive : !!ST.isActive(state, profile);
    return { wh: wh, profile: profile, active: active, noST: noST };
  }
  // opts 를 한 번만 정리해 아래로 넘긴다 (같은 호출 안에서 프로필을 다시 만들지 않게)
  function prep(state, opts) {
    opts = opts || {};
    if (opts.__ctx) return opts;
    var o = {};
    Object.keys(opts).forEach(function (k) { o[k] = opts[k]; });
    o.__ctx = ctxOf(state, opts);
    return o;
  }

  function taskMode(state, task, opts) {
    opts = prep(state, opts);
    var c = opts.__ctx;
    var ctx = null, ctxSource = null;
    if (!c.noST && task) {
      var r = ST.contextOf(state, task, c.profile, opts.now);
      ctx = r ? r.value : null;
      ctxSource = r ? r.source : null;
    }
    return { ctx: ctx, ctxSource: ctxSource, atMode: (task && task.atMode) || null, statusActive: c.active, profile: c.profile };
  }

  // ------------------------------------------------------------------ 하루의 띠 (§5.4)
  function dayBands(state, ymd, opts) {
    opts = prep(state, opts);
    var c = opts.__ctx, wh = c.wh, pf = c.profile;
    var day = D.parseYmd(ymd);
    var lunch = pf ? pf.schedule.lunch : ['12:00', '13:00'];
    var D0 = hmMin(SL.DAY_WINDOW.start), D1 = hmMin(SL.DAY_WINDOW.end);
    var raw = [];
    function add(band, s, e) {
      s = Math.max(s, D0); e = Math.min(e, D1);
      if (e - s <= 0) return;
      raw.push({ band: band, s: s, e: e });
    }
    if (SL.isWorkingDay(day, wh)) {
      var ws = hmMin(wh.start), we = hmMin(wh.end);
      if (ws - COMMUTE_MIN - D0 >= STEP_MIN) add('morning', D0, ws - COMMUTE_MIN);
      var ls = lunch ? hmMin(lunch[0]) : null, le = lunch ? hmMin(lunch[1]) : null;
      if (ls != null && le != null && ls < we && le > ws) {
        ls = Math.max(ls, ws); le = Math.min(le, we);
        add('work', ws, ls); add('lunch', ls, le); add('work', le, we);
      } else add('work', ws, we);
      var ee = hmMin(EVENING_END);
      if (we + COMMUTE_MIN < ee) add('evening', we + COMMUTE_MIN, ee);
      add('late', Math.max(ee, we + COMMUTE_MIN), D1);
    } else {
      var c0 = hmMin(DAY_OFF_CORE[0]), c1 = hmMin(DAY_OFF_CORE[1]);
      add('dayoff_edge', D0, c0); add('dayoff', c0, c1); add('dayoff_edge', c1, D1);
    }
    raw.sort(function (a, b) { return a.s - b.s; });
    var tl = null;
    if (!c.noST && pf) tl = ST.timeline(pf, D.startOfDay(day), 2);
    return raw.map(function (r) {
      var start = atMin(day, r.s), end = atMin(day, r.e);
      var sid = BAND_STATUS[r.band];
      if (tl) {
        var mid = (start.getTime() + end.getTime()) / 2;
        for (var i = 0; i < tl.length; i++) {
          if (msOf(tl[i].start) <= mid && mid < msOf(tl[i].end)) { sid = tl[i].id; break; }
        }
      }
      var label = BAND_LABEL[r.band];
      if (r.band === 'work' && pf && pf.statuses.work) label = pf.statuses.work.label;
      if (r.band === 'dayoff' && pf && pf.statuses.day_off) label = pf.statuses.day_off.label;
      return { band: r.band, start: start, end: end, statusId: sid, label: label };
    });
  }

  // ------------------------------------------------------------------ 띠의 수준 (§5.5)
  function bandLevel(band, mode, c) {
    var lvl;
    if (c.active && c.profile) {
      var row = c.profile.matrix[band.statusId];
      if (!row) lvl = 'normal';
      else {
        var key = mode.ctx && own(row, mode.ctx) ? mode.ctx : '_none';
        lvl = own(row, key) ? row[key] : 'normal';
      }
      if (mode.ctxSource === 'hint' && lvl === 'hide') lvl = 'down';
    } else if (mode.ctx == null) lvl = 'normal';
    else lvl = (mode.ctx === 'work' ? FIXED.work : FIXED.other)[band.band] || 'normal';
    if (mode.atMode && own(ATMODE_BANDS, mode.atMode)) {
      if (has(ATMODE_BANDS[mode.atMode], band.band)) lvl = 'up';
      else if (lvl !== 'hide') lvl = 'down';
    }
    return lvl;
  }
  // clip: false 면 지금 시각으로 자르지 않는다 (실패 이유를 고를 때)
  function windowsWith(state, task, ymd, opts, mode, clip) {
    var bands = dayBands(state, ymd, opts);
    var c = opts.__ctx;
    var wins = [];
    bands.forEach(function (b) {
      var lvl = bandLevel(b, mode, c);
      if (lvl === 'hide') return;
      var part = { band: b.band, start: b.start, end: b.end, level: lvl, statusId: b.statusId, label: b.label };
      var last = wins[wins.length - 1];
      if (last && last.end.getTime() === b.start.getTime()) { last.end = b.end; last.parts.push(part); }
      else wins.push({ start: b.start, end: b.end, parts: [part] });
    });
    if (clip === false) return wins;
    var floor = SL.roundUp15(opts.now).getTime();
    var out = [];
    wins.forEach(function (w) {
      if (w.end.getTime() <= floor) return;
      if (w.start.getTime() >= floor) { out.push(w); return; }
      var start = new Date(floor);
      var parts = w.parts.filter(function (p) { return p.end.getTime() > floor; }).map(function (p) {
        return p.start.getTime() < floor ? { band: p.band, start: start, end: p.end, level: p.level, statusId: p.statusId, label: p.label } : p;
      });
      out.push({ start: start, end: w.end, parts: parts });
    });
    return out;
  }
  function windowsFor(state, task, ymd, opts) {
    opts = prep(state, opts);
    if (typeof task === 'string') task = taskOf(state, task);
    var mode = taskMode(state, task, opts);
    return windowsWith(state, task, ymd, opts, mode, true);
  }

  // ------------------------------------------------------------------ 후보 · 점수 (§5.6–5.8)
  function busyFor(state, ymd, opts) {
    var day = D.parseYmd(ymd);
    var from = D.startOfDay(day).getTime() - HOUR, to = D.addDays(D.startOfDay(day), 1).getTime() + HOUR;
    var busy = SL.collectBusy(state, from, to, { ignoreId: opts.ignoreBlockId, external: opts.external });
    var list = busy.map(function (b) { return { start: b.start, end: b.end, taskId: b.taskId || null, kind: b.kind }; });
    (Array.isArray(opts.extraBusy) ? opts.extraBusy : []).forEach(function (x) {
      if (!x) return;
      var s = msOf(x.start), e = msOf(x.end);
      if (!isNaN(s) && !isNaN(e) && e > s) list.push({ start: s, end: e, taskId: x.taskId || null, kind: x.taskId ? 'work' : 'event' });
    });
    return { list: list, merged: SL.merge(list) };
  }

  function dueAtOf(task) { return task && task.dueDate ? D.parseYmd(task.dueDate, task.dueTime || '23:59') : null; }
  // 마감이 배치를 막는가: 마감이 있고, 아직 지나지 않았고, allowAfterDue 가 아니다.
  // 이미 지난 마감은 지킬 수 없으므로 막지 않는다(점수의 urgency 로 앞쪽에 둔다).
  function dueBinds(task, opts) {
    var d = dueAtOf(task);
    return !!d && opts.allowAfterDue !== true && d.getTime() > msOf(opts.now);
  }
  function dueLabel(task, now) { return fmtDay(task.dueDate, now) + (task.dueTime ? ' ' + task.dueTime : ''); }

  // 2시간 단위 시작 구간별, 같은 맥락 작업 블록 수 (prefs.learning === false 면 null)
  function historyCounts(state, task, mode, opts) {
    if (prefsOf(state).learning === false) return null;
    var c = opts.__ctx, now = msOf(opts.now);
    var days = isNum(opts.historyDays) && opts.historyDays > 0 ? opts.historyDays : DEFAULT_HISTORY_DAYS;
    var from = now - days * 24 * HOUR;
    var counts = {}, total = 0;
    ((state && state.blocks) || []).forEach(function (b) {
      if (!isWorkBlock(b)) return;
      var s = msOf(b.start), e = msOf(b.end);
      if (isNaN(s) || isNaN(e) || e > now || s < from) return;
      var t = taskOf(state, b.taskId);
      if (!t) return;
      var ctx = null;
      if (!c.noST) { var r = ST.contextOf(state, t, c.profile, opts.now); ctx = r ? r.value : null; }
      if (ctx !== mode.ctx) return;
      var k = Math.floor(new Date(s).getHours() / WEIGHTS.historyBucketHours);
      counts[k] = (counts[k] || 0) + 1;
      total++;
    });
    return { counts: counts, total: total };
  }

  function projectNeighbor(state, task, busyList, s, e) {
    if (!task.projectId) return null;
    var near = WEIGHTS.projectNear * MINUTE;
    for (var i = 0; i < busyList.length; i++) {
      var b = busyList[i];
      if (!b.taskId || b.kind !== 'work') continue;
      if (!(Math.abs(b.end - s) <= near || Math.abs(b.start - e) <= near)) continue;
      var t = taskOf(state, b.taskId);
      if (t && t.projectId === task.projectId) return M.byId(state.projects || [], task.projectId);
    }
    return null;
  }

  function atModeOk(mode, band) { return !!mode.atMode && own(ATMODE_BANDS, mode.atMode) && has(ATMODE_BANDS[mode.atMode], band); }
  function atModeText(mode) {
    var p = ST && typeof ST.atModePhrase === 'function' ? ST.atModePhrase(mode) : null;
    return p || ATMODE_PHRASE[mode] || mode;
  }

  // 후보를 만든다 (점수 없이). allowAfterDue: 마감을 보지 않는다
  function rawCandidates(wins, merged, len, dueAt, allowAfterDue) {
    var out = [], L = len * MINUTE, step = STEP_MIN * MINUTE;
    wins.forEach(function (w, wi) {
      var wEnd = w.end.getTime();
      for (var s = SL.roundUp15(w.start).getTime(); s + L <= wEnd; s += step) {
        var e = s + L, hit = false;
        for (var i = 0; i < merged.length; i++) if (merged[i].start < e && merged[i].end > s) { hit = true; break; }
        if (hit) continue;
        if (dueAt && !allowAfterDue && e > dueAt.getTime()) continue;
        out.push({ s: s, e: e, w: wi });
      }
    });
    return out;
  }

  function scoreAll(state, task, ymd, opts, mode, wins, busy, len, raws) {
    var c = opts.__ctx, now = opts.now;
    var hints = hintsOf(task);
    var dueAt = dueAtOf(task);
    var dayStart = D.parseYmd(ymd), dayEnd = D.addDays(dayStart, 1).getTime();
    var isToday = D.ymd(now) === ymd;
    var u = 0;
    if (dueAt) {
      var dm = dueAt.getTime();
      var tiers = WEIGHTS.urgencyTiers;
      for (var ti = 0; ti < tiers.length; ti++) if (dm <= dayEnd + tiers[ti][0] * 24 * HOUR) { u = tiers[ti][1]; break; }
      if (dm < msOf(now)) u = 1;
    }
    var hist = historyCounts(state, task, mode, opts);
    var first = Infinity, last = -Infinity;
    raws.forEach(function (r) { if (r.s < first) first = r.s; if (r.s > last) last = r.s; });
    var merged = busy.merged, L = len * MINUTE;
    var dueReasonOk = dueAt && (D.ymd(dueAt) === ymd || u >= 0.6);

    return raws.map(function (r) {
      var w = wins[r.w], s = r.s, e = r.e;
      var lvl = null, part = null;
      w.parts.forEach(function (p) {
        var ps = p.start.getTime(), pe = p.end.getTime();
        if (ps < e && pe > s && (lvl == null || LEVEL_RANK[p.level] > LEVEL_RANK[lvl])) lvl = p.level;
        if (ps <= s && s < pe) part = p;
      });
      part = part || w.parts[0];
      lvl = lvl || part.level;
      var startD = new Date(s), hour = startD.getHours() + startD.getMinutes() / 60;
      var earliness = last > first ? 1 - (s - first) / (last - first) : 1;
      // 품는 빈 구간 G
      var gs = w.start.getTime(), ge = w.end.getTime(), prevEnd = -Infinity, nextStart = Infinity;
      merged.forEach(function (b) {
        if (b.end <= s) { if (b.end > gs) gs = b.end; if (b.end > prevEnd) prevEnd = b.end; }
        if (b.start >= e) { if (b.start < ge) ge = b.start; if (b.start < nextStart) nextStart = b.start; }
      });
      var G = (ge - gs) / MINUTE, a = (s - gs) / MINUTE, bb = (ge - e) / MINUTE;
      var terms = {}, reasons = {};
      function put(k, v, why) { if (v) terms[k] = (terms[k] || 0) + v; if (why) reasons[k] = why; }

      put('level', WEIGHTS.level[lvl]);
      var atOk = atModeOk(mode, part.band);
      if (WEIGHTS.comfort[part.band] && !(part.band === 'lunch' && mode.atMode === 'pause')) put('comfort', WEIGHTS.comfort[part.band]);
      if (hints.prefer) {
        var tod = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
        if (tod === hints.prefer) put('prefer', WEIGHTS.preferMatch, PREFER_REASON[hints.prefer]);
        else put('prefer', WEIGHTS.preferMiss);
      }
      if (hints.focus === 'deep') {
        if (hour < 12 && part.band !== 'morning') put('deepEarly', WEIGHTS.deepEarly, '집중이 필요한 일이라 이른 시간에 두었어요.');
        var buf = WEIGHTS.bufferMin * MINUTE, pen = 0;
        if (prevEnd > s - buf) pen += WEIGHTS.deepBuffer;
        if (nextStart < e + buf) pen += WEIGHTS.deepBuffer;
        if (pen) put('deepBuffer', pen);
        else {
          var near = WEIGHTS.nearBusyHours * HOUR;
          if (prevEnd > s - near || nextStart < e + near) put('deepBuffer', 0, '앞뒤 일정과 15분 이상 떨어져 있어요.');
        }
      }
      if (hints.focus === 'light' && G <= len + WEIGHTS.lightGapSlack) put('lightGap', WEIGHTS.lightGap, '짧은 빈틈을 채워요.');
      if (hints.energy === 'high') {
        if ((hour >= 9 && hour < 12) || (hour >= 15 && hour < 19)) put('energy', WEIGHTS.energyHigh, '기운이 필요한 일이라 낮 시간에 두었어요.');
        else if (hour >= 21) put('energy', WEIGHTS.energyHighLate);
      } else if (hints.energy === 'low' && hour >= 19) put('energy', WEIGHTS.energyLow, '가볍게 할 수 있는 저녁 시간이에요.');
      if (dueAt) {
        var urg = WEIGHTS.urgency * u * earliness;
        if (urg > EPS) put('urgency', urg, '마감(' + dueLabel(task, now) + ')이 가까워 앞쪽 시간을 골랐어요.');
        if (e <= dueAt.getTime() && dueReasonOk) put('dueOk', 0, '마감 전에 끝나요.');
        if (e > dueAt.getTime() - WEIGHTS.dueTightMin * MINUTE) put('dueTight', WEIGHTS.dueTight);
      }
      if (task.priority === 'high') { var ph = WEIGHTS.priorityHigh * earliness; if (ph > EPS) put('priority', ph, '우선순위가 높아 앞쪽에 두었어요.'); }
      else if (task.priority === 'low') { var pl = WEIGHTS.priorityLow * (1 - earliness); if (pl > EPS) put('priority', pl); }
      if (G - len <= WEIGHTS.fragTightSlack) put('fragTight', WEIGHTS.fragTight, '빈 시간에 딱 맞아요.');
      if (a === 0) put('fragAlign', WEIGHTS.alignStart, '남은 빈 시간을 한 덩어리로 남겨요.');
      else if (bb === 0) put('fragAlign', WEIGHTS.alignEnd, '남은 빈 시간을 한 덩어리로 남겨요.');
      var crumb = 0;
      if (a > 0 && a < WEIGHTS.crumbMin) crumb += WEIGHTS.crumb;
      if (bb > 0 && bb < WEIGHTS.crumbMin) crumb += WEIGHTS.crumb;
      if (crumb) put('fragCrumb', crumb);
      if (len <= WEIGHTS.shortMax && G <= WEIGHTS.smallGap) put('shortSmall', WEIGHTS.shortSmall, '짧은 일이라 작은 빈틈에 넣었어요.');
      var proj = projectNeighbor(state, task, busy.list, s, e);
      if (proj) put('project', WEIGHTS.project, '같은 프로젝트 ' + q(proj.name || '') + ' 일과 이어져요.');
      if (hist && hist.total) {
        var k = Math.floor(startD.getHours() / WEIGHTS.historyBucketHours), n = hist.counts[k] || 0;
        if (n >= WEIGHTS.historyNeed && n / hist.total >= WEIGHTS.historyShare - EPS) put('history', WEIGHTS.history, '평소 이 시간대에 하던 일이에요.');
      }
      if (isToday) put('today', WEIGHTS.today * earliness);

      var score = 0;
      Object.keys(terms).forEach(function (key) { score += terms[key]; if (!terms[key]) delete terms[key]; });
      return {
        start: startD, end: new Date(e), startIso: startD.toISOString(), endIso: new Date(e).toISOString(),
        minutes: len, score: score, fit: LEVEL_FIT[lvl], level: lvl, band: part.band, statusId: part.statusId, label: part.label,
        reasons: null, terms: terms, _why: reasons, _atOk: atOk
      };
    });
  }

  function cmpCand(a, b) {
    if (Math.abs(a.score - b.score) > EPS) return b.score - a.score;
    return a.start.getTime() - b.start.getTime();
  }
  function diversify(sorted, limit) {
    var picked = [], skipped = [], gap = DIVERSITY_MIN * MINUTE;
    sorted.forEach(function (c) {
      if (picked.length >= limit) { skipped.push(c); return; }
      var close = picked.some(function (p) { return Math.abs(p.start.getTime() - c.start.getTime()) < gap; });
      (close ? skipped : picked).push(c);
    });
    for (var i = 0; picked.length < limit && i < skipped.length; i++) picked.push(skipped[i]);
    return picked.sort(cmpCand);
  }

  function finishReasons(c, rank, mode, opts) {
    var ctxI = opts.__ctx, out = [];
    function push(s) { if (s && out.indexOf(s) === -1 && out.length < 3) out.push(s); }
    if (c._atOk) push(q(atModeText(mode.atMode)) + ' 하기로 한 일이에요.');
    else if (c.level === 'up') {
      if (ctxI.active && ctxI.profile && mode.ctx) push(q(c.label) + ira(c.label) + ' ' + q(ST.contextLabel(ctxI.profile, mode.ctx)) + ' 하기 좋은 시간이에요.');
      else if (!ctxI.active && mode.ctx === 'work') push('근무 시간 안이에요.');
      else if (!ctxI.active && mode.ctx) push('근무 시간 밖이라 개인 일 하기 좋은 시간이에요.');
    } else if (c.level === 'down' && rank === 0) push(q(c.label) + ' 시간이라 알맞은 때는 아니지만 다른 빈 시간이 없어요.');
    var keys = Object.keys(c._why).filter(function (k) { return k !== 'level' && k !== 'atMode'; });
    keys.sort(function (a, b) {
      var va = c.terms[a] || 0, vb = c.terms[b] || 0;
      if (Math.abs(va - vb) > EPS) return vb - va;
      return TERM_ORDER.indexOf(a) - TERM_ORDER.indexOf(b);
    });
    keys.forEach(function (k) { if ((c.terms[k] || 0) >= 0) push(c._why[k]); });
    if (!out.length) out.push('비어 있는 시간이에요.');
    return out;
  }
  function publish(c, rank, mode, opts) {
    return {
      start: c.start, end: c.end, startIso: c.startIso, endIso: c.endIso, minutes: c.minutes, score: round1(c.score),
      fit: c.fit, level: c.level, band: c.band, statusId: c.statusId, label: c.label,
      reasons: finishReasons(c, rank, mode, opts), terms: c.terms
    };
  }

  // 한 날의 계산 묶음 (suggestSlots·placeOnDay 가 같이 쓴다)
  function analyze(state, task, ymd, opts, len) {
    var mode = taskMode(state, task, opts);
    var wins = windowsWith(state, task, ymd, opts, mode, true);
    var busy = busyFor(state, ymd, opts);
    var dueAt = dueAtOf(task);
    var raws = rawCandidates(wins, busy.merged, len, dueAt, !dueBinds(task, opts));
    var scored = scoreAll(state, task, ymd, opts, mode, wins, busy, len, raws).sort(cmpCand);
    return { mode: mode, wins: wins, busy: busy, dueAt: dueAt, scored: scored };
  }

  function suggestSlots(state, taskId, ymd, opts) {
    opts = prep(state, opts);
    var task = taskOf(state, taskId);
    if (!task || task.status === 'done') return [];
    var len = lengthOf(state, task, opts);
    if (!len) return [];
    var r = analyze(state, task, ymd, opts, len);
    var limit = isNum(opts.limit) && opts.limit >= 1 ? Math.floor(opts.limit) : DEFAULT_LIMIT;
    return diversify(r.scored, limit).map(function (c, i) { return publish(c, i, r.mode, opts); });
  }

  // ------------------------------------------------------------------ 가까운 날 · 나누기 (§5.10–5.11)
  function firstOn(state, taskId, ymd, opts) {
    var o = {};
    Object.keys(opts).forEach(function (k) { o[k] = opts[k]; });
    o.limit = 1;
    var list = suggestSlots(state, taskId, ymd, o);
    return list.length ? { ymd: ymd, candidate: list[0] } : null;
  }
  function nearestDay(state, taskId, fromYmd, opts) {
    opts = prep(state, opts);
    var task = taskOf(state, taskId);
    if (!task || task.status === 'done') return null;
    var today = D.ymd(opts.now);
    var dueYmd = dueBinds(task, opts) ? task.dueDate : null;
    var maxK = isNum(opts.days) && opts.days >= 1 ? Math.floor(opts.days) : DEFAULT_NEAREST_DAYS;
    var base = D.parseYmd(fromYmd);
    for (var k = 1; k <= maxK; k++) {
      var pair = [D.ymd(D.addDays(base, -k)), D.ymd(D.addDays(base, k))];
      for (var i = 0; i < pair.length; i++) {
        var y = pair[i];
        if (y < today) continue;
        if (dueYmd && y > dueYmd) continue;
        var hit = firstOn(state, taskId, y, opts);
        if (hit) return hit;
      }
    }
    return null;
  }
  // 마감일부터 거꾸로 오늘까지
  function backFromDue(state, task, opts) {
    var today = D.ymd(opts.now);
    for (var d = D.parseYmd(task.dueDate); D.ymd(d) >= today; d = D.addDays(d, -1)) {
      var hit = firstOn(state, task.id, D.ymd(d), opts);
      if (hit) return hit;
    }
    return null;
  }

  function longestWindow(wins) {
    var best = 0;
    wins.forEach(function (w) { var m = (w.end.getTime() - w.start.getTime()) / MINUTE; if (m > best) best = m; });
    return best;
  }

  function splitPlan(state, taskId, ymd, opts) {
    opts = prep(state, opts);
    var task = taskOf(state, taskId);
    if (!task || task.status === 'done') return null;
    var o = {};
    Object.keys(opts).forEach(function (k) { if (k !== 'minutes') o[k] = opts[k]; });
    var len = lengthOf(state, task, opts);
    if (!len) return null;
    var h = hintsOf(task);
    var ok = h.splittable === true || (h.splittable == null && len >= 120 && h.focus !== 'deep');
    if (!ok) return null;
    var wins = windowsFor(state, task, ymd, o);
    var L = Math.min(len - MIN_CHUNK, longestWindow(wins));
    L = Math.floor(L / STEP_MIN) * STEP_MIN;
    for (; L >= MIN_CHUNK; L -= STEP_MIN) {
      o.minutes = L; o.limit = 1;
      var list = suggestSlots(state, taskId, ymd, o);
      if (list.length) return { first: list[0], chunkMinutes: L, restMinutes: len - L };
    }
    return null;
  }

  // ------------------------------------------------------------------ 한 날에 넣기 (§5.9)
  function fail(reason, message, detail) {
    return { ok: false, reason: reason, message: message, detail: detail || null, alternatives: [], split: null };
  }
  function placeOnDay(state, taskId, ymd, opts) {
    opts = prep(state, opts);
    var now = opts.now;
    var task = taskOf(state, taskId);
    if (!task) return fail('missing', '할 일을 찾지 못했어요.');
    if (task.status === 'done') return fail('done', '이미 끝낸 일이에요.');
    var len = lengthOf(state, task, opts);
    if (!len) return fail('no_estimate', '소요 시간을 먼저 정해 주세요.');
    var withAlt = function (r) {
      var alt = r.reason === 'after_due' ? backFromDue(state, task, opts) : nearestDay(state, taskId, ymd, opts);
      if (alt) r.alternatives = [alt];
      if (r.reason === 'too_long' || r.reason === 'no_slot') r.split = splitPlan(state, taskId, ymd, opts);
      return r;
    };
    if (ymd < D.ymd(now)) return withAlt(fail('past', '지난 날짜에는 넣을 수 없어요.'));
    if (dueBinds(task, opts) && task.dueDate < ymd) {
      return withAlt(fail('after_due', '마감(' + fmtDay(task.dueDate, now) + ')보다 늦은 날이에요.'));
    }
    var r = analyze(state, task, ymd, opts, len);
    var c = opts.__ctx;
    if (!r.wins.length) {
      var all = windowsWith(state, task, ymd, opts, r.mode, false);
      var dayOff = !SL.isWorkingDay(D.parseYmd(ymd), c.wh);
      var msg;
      if (ymd === D.ymd(now) && all.length) msg = '오늘은 이 일을 할 시간대가 이미 지났어요.';
      else if (r.mode.ctx === 'work' && dayOff) {
        if (c.active && c.profile) {
          var offLabel = c.profile.statuses.day_off ? c.profile.statuses.day_off.label : '쉬는 날';
          msg = q(ST.contextLabel(c.profile, 'work')) + ' 일은 ' + q(offLabel) + '에는 넣지 않아요.';
        } else msg = '근무 시간에 할 일이라 쉬는 날에는 넣지 않았어요.';
      } else msg = '이 날에는 이 일을 할 시간대가 없어요.';
      return withAlt(fail('no_window', msg));
    }
    var longest = longestWindow(r.wins);
    if (len > longest) {
      return withAlt(fail('too_long', q(task.title) + '(' + D.duration(len) + ')은 이 날 넣을 수 있는 가장 긴 시간(' + D.duration(longest) + ')보다 길어요.'));
    }
    if (!r.scored.length) {
      var detail;
      var noDue = dueBinds(task, opts) ? rawCandidates(r.wins, r.busy.merged, len, null, true) : [];
      if (noDue.length) detail = '마감(' + D.hm(r.dueAt) + ') 전에는 빈 시간이 없어요.';
      else {
        var parts = [];
        r.wins.forEach(function (w) { w.parts.forEach(function (p) { parts.push(p); }); });
        parts.sort(function (a, b) {
          return LEVEL_RANK[a.level] - LEVEL_RANK[b.level] ||
            (b.end.getTime() - b.start.getTime()) - (a.end.getTime() - a.start.getTime()) || a.start.getTime() - b.start.getTime();
        });
        var p0 = parts[0];
        detail = p0 ? p0.label + '(' + fmtRange(p0.start, p0.end) + ')가 일정으로 차 있어요.' : null;
      }
      return withAlt(fail('no_slot', fmtDay(ymd, now) + '에는 ' + D.duration(len) + ' 빈 시간이 없어요.', detail));
    }
    var limit = 3;
    var list = diversify(r.scored, limit).map(function (x, i) { return publish(x, i, r.mode, opts); });
    var best = list[0];
    return {
      ok: true, candidate: best,
      block: { taskId: task.id, kind: 'work', start: best.startIso, end: best.endIso },
      reasons: best.reasons, alternatives: list.slice(1, 3)
    };
  }

  // ------------------------------------------------------------------ 이 날 자동 배치 (§5.12)
  function dueClass(task, ymd) {
    if (!task.dueDate) return 4;
    var base = D.parseYmd(ymd);
    if (task.dueDate <= ymd) return 0;
    if (task.dueDate <= D.ymd(D.addDays(base, 2))) return 1;
    if (task.dueDate <= D.ymd(D.addDays(base, 7))) return 2;
    return 3;
  }
  var PRIO_RANK = { high: 0, normal: 1, low: 2 };
  function arrangeDay(state, taskIds, ymd, opts) {
    opts = prep(state, opts);
    var base = {};
    Object.keys(opts).forEach(function (k) { if (k !== 'minutes' && k !== 'limit') base[k] = opts[k]; });
    var now = opts.now, today = D.ymd(now);
    var endOfDay = D.addDays(D.parseYmd(ymd), 1).getTime();
    var placements = [], skipped = [], seen = {}, items = [];
    (Array.isArray(taskIds) ? taskIds : []).forEach(function (id) {
      if (seen['k' + id]) return;
      seen['k' + id] = true;
      var t = taskOf(state, id);
      if (!t) { skipped.push({ taskId: id, reason: 'missing' }); return; }
      if (t.status === 'done') { skipped.push({ taskId: id, reason: 'done' }); return; }
      if (ymd < today) { skipped.push({ taskId: id, reason: 'past' }); return; }
      var len = lengthOf(state, t, base);
      if (!len) { skipped.push({ taskId: id, reason: 'no_estimate' }); return; }
      if (M.unmetBlockers(state, t).length) { skipped.push({ taskId: id, reason: 'blocked' }); return; }
      if (t.snoozedUntil && msOf(t.snoozedUntil) > endOfDay) { skipped.push({ taskId: id, reason: 'snoozed' }); return; }
      var wins = windowsFor(state, t, ymd, base);
      var lv = 3;
      wins.forEach(function (w) { w.parts.forEach(function (p) { if (LEVEL_RANK[p.level] < lv) lv = LEVEL_RANK[p.level]; }); });
      items.push({ t: t, len: len, due: dueClass(t, ymd), prio: own(PRIO_RANK, t.priority) ? PRIO_RANK[t.priority] : 1, lv: lv, wins: wins.length });
    });
    items.sort(function (a, b) {
      return a.due - b.due || a.prio - b.prio || a.lv - b.lv || b.len - a.len ||
        (String(a.t.createdAt || '') < String(b.t.createdAt || '') ? -1 : String(a.t.createdAt || '') > String(b.t.createdAt || '') ? 1 : 0) ||
        (a.t.id < b.t.id ? -1 : a.t.id > b.t.id ? 1 : 0);
    });
    var maxTasks = isNum(opts.maxTasks) && opts.maxTasks >= 0 ? Math.floor(opts.maxTasks) : DEFAULT_MAX_TASKS;
    var maxMinutes = isNum(opts.maxMinutes) && opts.maxMinutes >= 0 ? opts.maxMinutes : DEFAULT_MAX_MINUTES;
    var extra = (Array.isArray(opts.extraBusy) ? opts.extraBusy : []).slice();
    var total = 0;
    items.forEach(function (it) {
      if (placements.length >= maxTasks) { skipped.push({ taskId: it.t.id, reason: 'limit' }); return; }
      var o = {};
      Object.keys(base).forEach(function (k) { o[k] = base[k]; });
      o.extraBusy = extra; o.limit = 1;
      var list = suggestSlots(state, it.t.id, ymd, o);
      var c = list[0];
      if (!c) { skipped.push({ taskId: it.t.id, reason: it.wins ? 'no_slot' : 'no_window' }); return; }
      if (c.fit === 'poor' && opts.includePoor !== true) { skipped.push({ taskId: it.t.id, reason: 'poor_fit' }); return; }
      if (total + c.minutes > maxMinutes) { skipped.push({ taskId: it.t.id, reason: 'limit' }); return; }
      total += c.minutes;
      extra = extra.concat([{ start: c.start.getTime(), end: c.end.getTime(), taskId: it.t.id }]);
      placements.push({ taskId: it.t.id, candidate: c, block: { taskId: it.t.id, kind: 'work', start: c.startIso, end: c.endIso } });
    });
    return { placements: placements, skipped: skipped, minutes: total };
  }

  return {
    STEP_MIN: STEP_MIN, MIN_CHUNK: MIN_CHUNK, COMMUTE_MIN: COMMUTE_MIN, EVENING_END: EVENING_END,
    DAY_OFF_CORE: Object.freeze(DAY_OFF_CORE.slice()), WEIGHTS: WEIGHTS,
    ruleHints: ruleHints, hintsOf: hintsOf, remainingMinutes: remainingMinutes, taskMode: taskMode,
    dayBands: dayBands, windowsFor: windowsFor, suggestSlots: suggestSlots, placeOnDay: placeOnDay,
    nearestDay: nearestDay, arrangeDay: arrangeDay, splitPlan: splitPlan, fmtDay: fmtDay, fmtRange: fmtRange
  };
});
