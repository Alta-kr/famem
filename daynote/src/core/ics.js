'use strict';

// 회사 캘린더(ICS) 읽기 — Google·Outlook 이 주는 "iCal 주소" 의 내용을 일정 목록으로 바꾼다 (UX 점검 C-09).
//   회의가 Daynote 에도 보여야 빈 시간 찾기·추천·2주 띠의 '바쁜 날' 이 맞는다 (Meyer 외 2017·2019, Rogelberg 외 2006)
//   읽기 전용 — Daynote 에서 고치지 않고, 원래 캘린더에서 고친다
//
//   지원: VEVENT · DTSTART/DTEND/DURATION (UTC 'Z' · TZID · 날짜만=종일) · RRULE(DAILY·WEEKLY+BYDAY·MONTHLY·YEARLY, INTERVAL·COUNT·UNTIL)
//         EXDATE · RECURRENCE-ID(바뀐 한 번) · STATUS:CANCELLED · 줄 이어 쓰기 · 이스케이프
//   기간: 반복 일정은 [from, to) 안에서만 펼친다

(function (factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.ics = api; }
})(function () {
  var DAY = 86400000;

  // ---------------------------------------------------------------- 줄 읽기
  function unfold(text) {
    return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  }
  function unescape(v) {
    return String(v || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
  }
  // "DTSTART;TZID=Asia/Seoul:20261021T110000" → { name, params, value }
  function parseLine(line) {
    var i = -1, q = false;
    for (var k = 0; k < line.length; k++) {
      var ch = line[k];
      if (ch === '"') q = !q;
      else if (ch === ':' && !q) { i = k; break; }
    }
    if (i < 0) return null;
    var head = line.slice(0, i).split(';');
    var params = {};
    head.slice(1).forEach(function (p) { var e = p.indexOf('='); if (e > 0) params[p.slice(0, e).toUpperCase()] = p.slice(e + 1).replace(/^"|"$/g, ''); });
    return { name: head[0].toUpperCase(), params: params, value: line.slice(i + 1) };
  }

  // ---------------------------------------------------------------- 시각
  // 그 시간대의 벽시계 시각 → UTC 밀리초 (Intl 로 시간대 차이를 구한다. 모르는 시간대면 이 컴퓨터 시간대)
  function tzOffset(utcMs, tz) {
    var f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    var p = {};
    f.formatToParts(new Date(utcMs)).forEach(function (x) { p[x.type] = x.value; });
    var asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return asUtc - utcMs;
  }
  function zoned(y, mo, d, h, mi, s, tz) {
    var guess = Date.UTC(y, mo, d, h, mi, s);
    try {
      var off = tzOffset(guess, tz);
      var t = guess - off;
      var off2 = tzOffset(t, tz);
      return off2 === off ? t : guess - off2;
    } catch (e) {
      return new Date(y, mo, d, h, mi, s).getTime();
    }
  }
  // 값 하나 → { ms, allDay }
  function parseTime(value, params, defaultTz) {
    var v = String(value || '').trim();
    var m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
    if (!m) return null;
    var y = +m[1], mo = +m[2] - 1, d = +m[3];
    if (!m[4] || (params && params.VALUE === 'DATE')) return { ms: new Date(y, mo, d).getTime(), allDay: true };
    var h = +m[4], mi = +m[5], s = +(m[6] || 0);
    if (m[7]) return { ms: Date.UTC(y, mo, d, h, mi, s), allDay: false };
    var tz = (params && params.TZID) || defaultTz;
    if (tz) return { ms: zoned(y, mo, d, h, mi, s, tz.replace(/^\//, '')), allDay: false };
    return { ms: new Date(y, mo, d, h, mi, s).getTime(), allDay: false };   // 떠 있는 시각 — 이 컴퓨터 시간
  }
  // "PT1H30M" · "P1D" → 밀리초
  function parseDuration(v) {
    var m = String(v || '').match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
    if (!m) return null;
    var ms = ((+m[2] || 0) * 7 * DAY) + ((+m[3] || 0) * DAY) + ((+m[4] || 0) * 3600000) + ((+m[5] || 0) * 60000) + ((+m[6] || 0) * 1000);
    return m[1] === '-' ? -ms : ms;
  }

  // ---------------------------------------------------------------- 반복
  var WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  function parseRule(v) {
    var r = {};
    String(v || '').split(';').forEach(function (p) { var e = p.indexOf('='); if (e > 0) r[p.slice(0, e).toUpperCase()] = p.slice(e + 1); });
    return r;
  }
  // 시작 시각들 (로컬 벽시계 기준으로 날짜를 더한다 — 서머타임이 있어도 회의 시각이 그대로)
  //   from 전의 회차는 COUNT 에만 세고 내보내지 않는다 (몇 년 전에 시작한 매일 회의도 지금 것이 나오게)
  function expand(startMs, rule, from, until, cap) {
    var r = parseRule(rule);
    var freq = r.FREQ, interval = Math.max(1, +r.INTERVAL || 1);
    var count = r.COUNT ? +r.COUNT : null;
    var untilMs = r.UNTIL ? (parseTime(r.UNTIL, {}) || {}).ms : null;
    var end = Math.min(until, untilMs != null ? untilMs + 1 : Infinity);
    var base = new Date(startMs);
    var out = [], n = 0, guard = 0;
    function push(d) {
      var ms = d.getTime();
      if (ms < startMs) return true;
      if (ms >= end) return false;
      if (count != null && n >= count) return false;
      n++;
      if (ms < from) return true;
      out.push(ms);
      return out.length < cap;
    }
    function at(y, mo, d) { return new Date(y, mo, d, base.getHours(), base.getMinutes(), base.getSeconds()); }
    if (freq === 'DAILY') {
      for (var i = 0; guard++ < 20000; i += interval) { if (!push(at(base.getFullYear(), base.getMonth(), base.getDate() + i))) break; }
    } else if (freq === 'WEEKLY') {
      var days = r.BYDAY ? r.BYDAY.split(',').map(function (x) { return WD[x.replace(/^[+-]?\d+/, '')]; }).filter(function (x) { return x != null; }) : [base.getDay()];
      days.sort();
      var weekStart = at(base.getFullYear(), base.getMonth(), base.getDate() - base.getDay());
      outer:
      for (var w = 0; guard++ < 2000; w += interval) {
        for (var k = 0; k < days.length; k++) {
          var d = at(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + w * 7 + days[k]);
          if (!push(d)) break outer;
        }
      }
    } else if (freq === 'MONTHLY') {
      for (var mth = 0; guard++ < 600; mth += interval) {
        var dm = at(base.getFullYear(), base.getMonth() + mth, base.getDate());
        if (dm.getDate() !== base.getDate()) continue;   // 31일이 없는 달은 건너뛴다
        if (!push(dm)) break;
      }
    } else if (freq === 'YEARLY') {
      for (var yr = 0; guard++ < 100; yr += interval) { if (!push(at(base.getFullYear() + yr, base.getMonth(), base.getDate()))) break; }
    } else {
      push(base);
    }
    return out;
  }

  // ---------------------------------------------------------------- 읽기
  // parse(text, { from, to, defaultTz }) → [{ uid, title, location, start, end, allDay }] (ISO 문자열, 시작 순)
  function parse(text, opts) {
    opts = opts || {};
    var from = opts.from != null ? new Date(opts.from).getTime() : -Infinity;
    var to = opts.to != null ? new Date(opts.to).getTime() : Infinity;
    var lines = unfold(text);
    var calTz = null, events = [], cur = null, depth = 0;
    lines.forEach(function (raw) {
      var L = parseLine(raw);
      if (!L) return;
      if (L.name === 'X-WR-TIMEZONE' && !cur) calTz = L.value.trim();
      if (L.name === 'BEGIN') { if (L.value === 'VEVENT') { cur = { exdates: [] }; depth = 0; } else if (cur) depth++; return; }
      if (L.name === 'END') { if (L.value === 'VEVENT' && cur) { events.push(cur); cur = null; } else if (cur && depth) depth--; return; }
      if (!cur || depth) return;   // VALARM 같은 안쪽 묶음은 건너뛴다
      if (L.name === 'UID') cur.uid = L.value.trim();
      else if (L.name === 'SUMMARY') cur.title = unescape(L.value).trim();
      else if (L.name === 'LOCATION') cur.location = unescape(L.value).trim();
      else if (L.name === 'STATUS') cur.status = L.value.trim().toUpperCase();
      else if (L.name === 'DTSTART') { cur.startP = L; }
      else if (L.name === 'DTEND') { cur.endP = L; }
      else if (L.name === 'DURATION') cur.duration = parseDuration(L.value.trim());
      else if (L.name === 'RRULE') cur.rrule = L.value.trim();
      else if (L.name === 'EXDATE') cur.exdates.push(L);
      else if (L.name === 'RECURRENCE-ID') cur.recurP = L;
    });
    var defTz = opts.defaultTz || calTz || null;
    // 바뀐 한 번(RECURRENCE-ID) — 원래 반복의 그 회차를 빼고 이것으로
    var overrides = {};
    events.forEach(function (e) {
      if (!e.recurP || !e.uid) return;
      var r = parseTime(e.recurP.value, e.recurP.params, defTz);
      if (r) (overrides[e.uid] = overrides[e.uid] || {})[r.ms] = true;
    });
    var out = [];
    events.forEach(function (e) {
      if (!e.startP) return;
      var s = parseTime(e.startP.value, e.startP.params, defTz);
      if (!s) return;
      var len;
      if (e.endP) { var en = parseTime(e.endP.value, e.endP.params, defTz); len = en ? en.ms - s.ms : null; }
      if (len == null && e.duration != null) len = e.duration;
      if (len == null || len < 0) len = s.allDay ? DAY : 0;
      var cancelled = e.status === 'CANCELLED';
      var starts;
      if (e.rrule && !e.recurP) {
        var ex = {};
        e.exdates.forEach(function (x) { x.value.split(',').forEach(function (v) { var t = parseTime(v, x.params, defTz); if (t) ex[t.ms] = true; }); });
        var ov = (e.uid && overrides[e.uid]) || {};
        starts = expand(s.ms, e.rrule, from - len, to, 1000).filter(function (ms) { return !ex[ms] && !ov[ms]; });
      } else starts = [s.ms];
      if (cancelled) return;
      starts.forEach(function (ms) {
        if (ms + len <= from || ms >= to) return;
        out.push({ uid: (e.uid || 'ics') + '@' + ms, title: e.title || '(제목 없음)', location: e.location || null,
          start: new Date(ms).toISOString(), end: new Date(ms + Math.max(len, s.allDay ? DAY : 15 * 60000)).toISOString(), allDay: s.allDay });
      });
    });
    return out.sort(function (a, b) { return a.start < b.start ? -1 : 1; });
  }

  return { parse: parse, parseTime: parseTime, expand: expand, zoned: zoned };
});
