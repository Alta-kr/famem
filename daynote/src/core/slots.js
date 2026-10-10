'use strict';

// 근무 시간·바쁜 시간·빈 시간. 상태를 바꾸지 않는다. 시각은 밀리초로 비교한다. now 를 꼭 넘긴다.
//
// ── 근무 시간 ──────────────────────────────────────────────────────
//   prefs.workHours = { start:'HH:MM', end:'HH:MM', days:[0..6] }  (days 는 Date#getDay() 값)
//   없거나 잘못되면 월–금 09:00–18:00 (normalizeWorkHours — 읽는 곳은 모두 이 함수를 거친다).
//   설정 화면은 저장 전에 validateWorkHours 로 엄격하게 확인한다. 밤샘 근무(끝 < 시작)는 지원하지 않는다.
//
// ── 바쁜 시간 (collectBusy) ──────────────────────────────────────────
//   Daynote 블록 전부(작업·일정, 지난 것·끝낸 할 일의 것 포함, 지운 할 일의 블록은 제외)
//   + Google 일정(M.externalItems 중 바쁨이고 종일이 아닌 것) + opts.external(시험용 외부 일정).
//   M.conflictsFor 와 같은 기준이라 "겹침" 표시와 "다른 시간 찾기" 결과가 어긋나지 않는다.
//   외부 일정은 '+09:00' 같은 오프셋 ISO 일 수 있으므로 문자열이 아니라 밀리초로 비교한다.
//
// ── 빈 시간 찾기 (findSlot) ──────────────────────────────────────────
//   기준 시각이 근무 시간 안이면 근무 시간(근무 요일) 안, 밖이면 하루 07:00–23:00 안.
//   기준 시각부터 앞으로, 15분 칸, 최대 14일. 지금 이전은 내지 않는다.
//
// ── 지금 비어 있나 (freeNow) ─────────────────────────────────────────
//   진행 중인 것 → 15분 안에 시작하는 것 → 상태가 바쁨 순으로 본다. 하나라도 걸리면 비어 있지 않다.

(function (factory) {
  var deps = (typeof module !== 'undefined' && module.exports)
    ? { dates: require('./dates'), model: require('./model') }
    : { dates: window.Daynote.dates, model: window.Daynote.model };
  var api = factory(deps.dates, deps.model);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.slots = api; }
})(function (D, M) {
  // 내보내는 상수는 얼려 둔다 (읽는 쪽이 실수로 바꾸지 못하게 — 기본값이 필요하면 normalizeWorkHours() 의 사본을 쓴다)
  var DEFAULT_WORK_HOURS = Object.freeze({ start: '09:00', end: '18:00', days: Object.freeze([1, 2, 3, 4, 5]) });
  var DAY_WINDOW = Object.freeze({ start: '07:00', end: '23:00' });   // 근무 시간 밖에서 찾을 때의 하루
  var STEP_MIN = 15;
  var SEARCH_DAYS = 14;
  var IMMINENT_MIN = 15;
  var MIN_WORK_MIN = 30;                                // 설정에서 받는 가장 짧은 근무 시간
  var MINUTE = 60000;

  var DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];                // 요일은 월요일부터 본다
  var WORK_HOURS_MESSAGES = {
    invalid_time: '시각을 ‘09:00’처럼 골라 주세요.',
    end_before_start: '끝 시각은 시작보다 늦어야 해요. 밤샘 근무는 아직 지원하지 않아요.',
    too_short: '근무 시간은 30분 이상이어야 해요.',
    no_days: '근무 요일을 하루 이상 골라 주세요.'
  };

  // ------------------------------------------------------------------ 작은 도우미
  // Date | ISO | ms → ms (못 읽으면 NaN)
  function msOf(v) {
    if (v == null || v === '') return NaN;
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return v;
    return new Date(v).getTime();
  }

  function fmtHm(min) { return D.pad(Math.floor(min / 60)) + ':' + D.pad(min % 60); }

  function defaultWorkHours() {
    return { start: DEFAULT_WORK_HOURS.start, end: DEFAULT_WORK_HOURS.end, days: DEFAULT_WORK_HOURS.days.slice() };
  }

  // 0..6 정수만 남기고 중복 제거·오름차순
  function cleanDays(days) {
    var out = [];
    if (!Array.isArray(days)) return out;
    days.forEach(function (d) {
      if (typeof d === 'number' && d % 1 === 0 && d >= 0 && d <= 6 && out.indexOf(d) === -1) out.push(d);
    });
    return out.sort(function (a, b) { return a - b; });
  }

  // 그날(현지) 0시 + min 분
  function atMin(day, min) {
    var d = D.startOfDay(day);
    d.setHours(0, min, 0, 0);
    return d;
  }

  // ------------------------------------------------------------------ 근무 시간
  // 'H:MM'·'HH:MM' → 분(0..1439). '24:00'·'9:5'·'aa' → null
  function parseHm(s) {
    if (s == null) return null;
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
    if (!m) return null;
    var h = Number(m[1]), mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }

  // 관대한 정리(읽을 때): 시각 하나라도 못 읽거나 시작 ≥ 끝이면 시간 둘 다 기본값. 요일이 하나도 없으면 기본값.
  function normalizeWorkHours(wh) {
    var out = defaultWorkHours();
    if (!wh || typeof wh !== 'object') return out;
    var s = parseHm(wh.start), e = parseHm(wh.end);
    if (s != null && e != null && s < e) { out.start = fmtHm(s); out.end = fmtHm(e); }
    var days = cleanDays(wh.days);
    if (days.length) out.days = days;
    return out;
  }

  // 엄격한 확인(설정 화면 저장 전)
  function validateWorkHours(input) {
    input = input && typeof input === 'object' ? input : {};
    var s = parseHm(input.start), e = parseHm(input.end);
    var fail = function (error) { return { ok: false, error: error, message: WORK_HOURS_MESSAGES[error] }; };
    if (s == null || e == null) return fail('invalid_time');
    if (e <= s) return fail('end_before_start');
    if (e - s < MIN_WORK_MIN) return fail('too_short');
    var days = cleanDays(input.days);
    if (!days.length) return fail('no_days');
    return { ok: true, value: { start: fmtHm(s), end: fmtHm(e), days: days } };
  }

  // '월–금 09:00–18:00' · '매일 …' · '월·수·금 …' · '토·일 …' · '월–수·금 …'
  function describeDays(days) {
    if (days.length === 7) return '매일';
    var order = DAY_ORDER.filter(function (d) { return days.indexOf(d) !== -1; });
    var parts = [], i = 0;
    while (i < order.length) {
      var j = i;
      while (j + 1 < order.length && DAY_ORDER.indexOf(order[j + 1]) === DAY_ORDER.indexOf(order[j]) + 1) j++;
      if (j - i + 1 >= 3) parts.push(D.WEEKDAYS[order[i]] + '–' + D.WEEKDAYS[order[j]]);
      else for (var k = i; k <= j; k++) parts.push(D.WEEKDAYS[order[k]]);
      i = j + 1;
    }
    return parts.join('·');
  }

  function describeWorkHours(wh) {
    var n = normalizeWorkHours(wh);
    return describeDays(n.days) + ' ' + n.start + '–' + n.end;
  }

  function isWorkingDay(date, wh) {
    var t = msOf(date);
    if (isNaN(t)) return false;
    return normalizeWorkHours(wh).days.indexOf(new Date(t).getDay()) !== -1;
  }

  // 그날의 근무 창 (현지). 근무일이 아니면 null
  function workWindow(date, wh) {
    var t = msOf(date);
    if (isNaN(t)) return null;
    var n = normalizeWorkHours(wh);
    var d = new Date(t);
    if (n.days.indexOf(d.getDay()) === -1) return null;
    return { start: atMin(d, parseHm(n.start)), end: atMin(d, parseHm(n.end)) };
  }

  // start <= now < end (끝은 포함하지 않음)
  function isWorkingTime(now, wh) {
    var win = workWindow(now, wh);
    if (!win) return false;
    var t = msOf(now);
    return win.start.getTime() <= t && t < win.end.getTime();
  }

  // 다음 15분 칸으로 올림 (이미 칸 위면 그대로)
  function roundUp15(date) {
    var d = new Date(msOf(date));
    if (isNaN(d.getTime())) return d;
    var m = d.getMinutes();
    var extra = m % STEP_MIN ? STEP_MIN - m % STEP_MIN : 0;
    if (!extra && (d.getSeconds() || d.getMilliseconds())) extra = STEP_MIN;
    d.setSeconds(0, 0);
    if (extra) d.setMinutes(m + extra);
    return d;
  }

  // ------------------------------------------------------------------ 바쁜 시간
  //   Busy = { id, start: ms, end: ms, title, source:'block'|'external', kind:'work'|'event'|'external',
  //            taskId, done, provider?:'google' }
  //   opts: { ignoreId?, external?: ExternalEvent[], includeDoneWork?: true }
  //   ExternalEvent = { id, start, end, title, allDay?, busy?, transparency?, status?, source:'google' }

  // 시험·다른 출처용 외부 일정이 바쁜 시간인가 (FEATURES §2.3 규칙 2)
  function externalCounts(ev) {
    if (!ev || typeof ev !== 'object') return false;
    if (ev.status === 'cancelled') return false;
    if (ev.busy === false) return false;
    if (ev.transparency === 'transparent') return false;
    if (ev.allDay && ev.busy !== true) return false;   // Google 종일 일정은 기본이 ‘한가함’
    return true;
  }

  function byStart(a, b) {
    if (a.start !== b.start) return a.start - b.start;
    if (a.end !== b.end) return a.end - b.end;
    var ai = String(a.id), bi = String(b.id);
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  }

  function collectBusy(state, from, to, opts) {
    opts = opts || {};
    var lo = msOf(from), hi = msOf(to);
    if (isNaN(lo)) lo = -Infinity;
    if (isNaN(hi)) hi = Infinity;
    var ignoreId = opts.ignoreId == null ? null : opts.ignoreId;
    var includeDone = opts.includeDoneWork !== false;
    var out = [];
    var inRange = function (s, e) { return !isNaN(s) && !isNaN(e) && e > s && s < hi && e > lo; };

    // 1) Daynote 블록
    (state && Array.isArray(state.blocks) ? state.blocks : []).forEach(function (b) {
      if (!b || (ignoreId != null && b.id === ignoreId)) return;
      var t = null;
      if (b.taskId) {
        t = M.byId(state.tasks || [], b.taskId);
        if (!t || t.deletedAt) return;
      }
      var kind = b.kind === 'event' || b.kind === 'work' ? b.kind : (b.taskId ? 'work' : 'event');
      var done = !!(t && t.status === 'done');
      if (!includeDone && kind === 'work' && done) return;
      var s = msOf(b.start), e = msOf(b.end);
      if (!inRange(s, e)) return;
      out.push({
        id: b.id, start: s, end: e,
        title: kind === 'work' && t ? t.title : (b.title || ''),
        source: 'block', kind: kind, taskId: b.taskId || null, done: done
      });
    });

    // 2) 외부 일정 — Google(state.gcal.events 투영) + opts.external
    //    같은 id 가 두 번 들어오면 한 번만 센다. id 가 없는 일정은 서로 다른 일정으로 본다(하나로 합치지 않는다).
    var seen = {};
    var pushExt = function (id, s, e, title, provider) {
      var hasId = id != null && id !== '';
      if (ignoreId != null && id === ignoreId) return;
      if (hasId && Object.prototype.hasOwnProperty.call(seen, 'k' + id)) return;
      if (!inRange(s, e)) return;
      if (hasId) seen['k' + id] = true;
      out.push({ id: hasId ? id : null, start: s, end: e, title: title || '', source: 'external', kind: 'external', taskId: null, done: false, provider: provider });
    };
    if (state && typeof M.externalItems === 'function') {
      var fromIso = isFinite(lo) ? new Date(lo).toISOString() : undefined;
      var toIso = isFinite(hi) ? new Date(hi).toISOString() : undefined;
      M.externalItems(state, fromIso, toIso).forEach(function (x) {
        if (!x || !x.busy || x.allDay) return;
        pushExt(x.id, msOf(x.start), msOf(x.end), x.title, x.external || 'google');
      });
    }
    (Array.isArray(opts.external) ? opts.external : []).forEach(function (ev) {
      if (!externalCounts(ev)) return;
      pushExt(ev.id, msOf(ev.start), msOf(ev.end), ev.title, ev.source || ev.provider || 'google');
    });

    return out.sort(byStart);
  }

  // 반열린 구간 [start, end) 겹침: b.start < end && b.end > start
  function conflicts(busy, start, end) {
    var s = msOf(start), e = msOf(end);
    if (isNaN(s) || isNaN(e)) return [];
    return (busy || []).filter(function (b) { return b.start < e && b.end > s; });
  }

  // 시작순 정렬 후 겹치거나 맞닿은 구간을 합친다
  function merge(busy) {
    var list = (busy || []).map(function (b) { return { start: b.start, end: b.end }; })
      .filter(function (b) { return !isNaN(b.start) && !isNaN(b.end) && b.end > b.start; })
      .sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    var out = [];
    list.forEach(function (b) {
      var last = out[out.length - 1];
      if (last && b.start <= last.end) { if (b.end > last.end) last.end = b.end; }
      else out.push({ start: b.start, end: b.end });
    });
    return out;
  }

  // ------------------------------------------------------------------ 빈 시간 찾기
  // from 이 그날 근무 창 안(start <= from < end)이면 'work', 아니면 'day'
  function pickMode(from, wh) { return isWorkingTime(from, wh) ? 'work' : 'day'; }

  // 근무일이고 now 가 그날 근무 끝 전이면 'work' (출근 전이면 근무 시작부터), 아니면 'day'
  function defaultMode(now, wh) {
    var win = workWindow(now, wh);
    return win && msOf(now) < win.end.getTime() ? 'work' : 'day';
  }

  function dayWindow(day) {
    return { start: atMin(day, parseHm(DAY_WINDOW.start)), end: atMin(day, parseHm(DAY_WINDOW.end)) };
  }

  // findSlot(busy, { from, now, minutes, workHours, mode:'auto'|'work'|'day', days = 14 })
  //   → { found:true, start, end, mode, sameDay, dayOffset } | { found:false, reason:'too_long'|'no_slot'|'bad_input', mode }
  function findSlot(busy, opts) {
    opts = opts || {};
    var wh = normalizeWorkHours(opts.workHours);
    var explicit = opts.mode === 'work' || opts.mode === 'day' ? opts.mode : null;
    var fromMs = msOf(opts.from);
    var nowMs = opts.now == null ? fromMs : msOf(opts.now);
    var minutes = opts.minutes;
    if (typeof minutes !== 'number' || !(minutes >= 1) || minutes % 1 !== 0 || isNaN(fromMs) || isNaN(nowMs)) {
      return { found: false, reason: 'bad_input', mode: explicit || (isNaN(fromMs) ? null : pickMode(fromMs, wh)) };
    }
    var from = new Date(fromMs);
    var mode = explicit || pickMode(from, wh);
    var days = typeof opts.days === 'number' && opts.days >= 1 ? Math.floor(opts.days) : SEARCH_DAYS;

    var windowLen = mode === 'work' ? parseHm(wh.end) - parseHm(wh.start) : parseHm(DAY_WINDOW.end) - parseHm(DAY_WINDOW.start);
    if (minutes > windowLen) return { found: false, reason: 'too_long', mode: mode };
    if (mode === 'work' && !wh.days.length) return { found: false, reason: 'no_slot', mode: mode };

    var len = minutes * MINUTE;
    var merged = merge(busy);
    var t0 = roundUp15(new Date(Math.max(fromMs, nowMs)));
    var base = D.startOfDay(t0);
    for (var d = 0; d < days; d++) {
      var day = D.addDays(base, d);
      var win = mode === 'work' ? workWindow(day, wh) : dayWindow(day);
      if (!win) continue;
      var winEnd = win.end.getTime();
      var s = roundUp15(new Date(Math.max(win.start.getTime(), t0.getTime()))).getTime();
      while (s + len <= winEnd) {
        var hit = null;
        for (var i = 0; i < merged.length; i++) {
          if (merged[i].start < s + len && merged[i].end > s) { hit = merged[i]; break; }
        }
        if (!hit) {
          var start = new Date(s), end = new Date(s + len);
          return { found: true, start: start, end: end, mode: mode, sameDay: D.ymd(start) === D.ymd(from), dayOffset: D.dayDiff(from, start) };
        }
        s = roundUp15(new Date(hit.end)).getTime();
      }
    }
    return { found: false, reason: 'no_slot', mode: mode };
  }

  // ------------------------------------------------------------------ 지금 비어 있나
  // freeNow(state, now, { workHours, external, status, imminentMinutes = 15 })
  //   → { free, reason: null|'in_progress'|'imminent'|'status', current, next, freeMinutes, workTime }
  function freeNow(state, now, opts) {
    opts = opts || {};
    var t = msOf(now);
    var n = new Date(t);
    var imminent = typeof opts.imminentMinutes === 'number' && opts.imminentMinutes >= 0 ? opts.imminentMinutes : IMMINENT_MIN;
    var eod = D.endOfDay(n).getTime();
    var busy = collectBusy(state, t - D.DAY, eod + Math.max(imminent, IMMINENT_MIN) * MINUTE, { includeDoneWork: false, external: opts.external });

    var running = busy.filter(function (b) { return b.start <= t && t < b.end; });
    running.sort(function (a, b) { return a.end - b.end || byStart(a, b); });
    var current = running[0] || null;
    var next = busy.filter(function (b) { return b.start > t && b.start <= eod; })[0] || null;
    var soon = busy.some(function (b) { return b.start > t && b.start - t <= imminent * MINUTE; });

    var reason = null;
    if (current) reason = 'in_progress';
    else if (soon) reason = 'imminent';
    else if (opts.status && opts.status.busy === true) reason = 'status';

    return {
      free: reason === null,
      reason: reason,
      current: current,
      next: next,
      freeMinutes: next ? Math.floor(Math.floor((next.start - t) / MINUTE) / 5) * 5 : null,
      workTime: isWorkingTime(n, opts.workHours)
    };
  }

  return {
    DEFAULT_WORK_HOURS: DEFAULT_WORK_HOURS, DAY_WINDOW: DAY_WINDOW,
    STEP_MIN: STEP_MIN, SEARCH_DAYS: SEARCH_DAYS, IMMINENT_MIN: IMMINENT_MIN,
    parseHm: parseHm, normalizeWorkHours: normalizeWorkHours, validateWorkHours: validateWorkHours,
    describeWorkHours: describeWorkHours, isWorkingDay: isWorkingDay, workWindow: workWindow, isWorkingTime: isWorkingTime,
    roundUp15: roundUp15, collectBusy: collectBusy, conflicts: conflicts, merge: merge,
    findSlot: findSlot, pickMode: pickMode, defaultMode: defaultMode, freeNow: freeNow
  };
});
