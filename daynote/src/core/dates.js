'use strict';

// 날짜 계산은 모두 "사용자 컴퓨터의 현지 시간" 기준이다.
// 마감일(dueDate)은 'YYYY-MM-DD' 문자열, 실제 작업 시간(블록)은 ISO 시각으로 따로 다룬다.

(function (factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.dates = api; }
})(function () {
  var DAY = 24 * 60 * 60 * 1000;
  var WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function toDate(v) { return v instanceof Date ? new Date(v.getTime()) : new Date(v); }

  // Date → 'YYYY-MM-DD' (현지)
  function ymd(d) {
    d = toDate(d);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  // 'YYYY-MM-DD' (+ 'HH:MM') → 현지 Date
  function parseYmd(s, hm) {
    if (!s) return null;
    var p = String(s).split('-');
    var h = 0, m = 0;
    if (hm) { var t = String(hm).split(':'); h = Number(t[0]) || 0; m = Number(t[1]) || 0; }
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), h, m, 0, 0);
  }

  function startOfDay(d) { d = toDate(d); d.setHours(0, 0, 0, 0); return d; }
  function endOfDay(d) { d = toDate(d); d.setHours(23, 59, 59, 999); return d; }
  function addDays(d, n) { d = toDate(d); d.setDate(d.getDate() + n); return d; }
  function addMinutes(d, n) { return new Date(toDate(d).getTime() + n * 60000); }

  // 주는 월요일에 시작한다 (한국 직장의 주간보고 관행)
  function startOfWeek(d) {
    d = startOfDay(d);
    var wd = (d.getDay() + 6) % 7;
    return addDays(d, -wd);
  }

  // 두 날짜(일 단위) 차이: b - a
  function dayDiff(a, b) {
    return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY);
  }

  function minutesBetween(a, b) { return Math.round((toDate(b).getTime() - toDate(a).getTime()) / 60000); }

  function hm(d) { d = toDate(d); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  // 화면용 짧은 날짜: 오늘 / 내일 / 어제 / 10월 6일 (월)
  function relDay(dateStr, now) {
    if (!dateStr) return '';
    var d = parseYmd(dateStr);
    var diff = dayDiff(now || new Date(), d);
    if (diff === 0) return '오늘';
    if (diff === 1) return '내일';
    if (diff === -1) return '어제';
    return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 (' + WEEKDAYS[d.getDay()] + ')';
  }

  function longDay(d) {
    d = toDate(d);
    return d.getFullYear() + '년 ' + (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + WEEKDAYS[d.getDay()] + '요일';
  }

  function shortDay(d) {
    d = toDate(d);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' (' + WEEKDAYS[d.getDay()] + ')';
  }

  function duration(min) {
    if (min == null) return '';
    if (min < 60) return min + '분';
    var h = Math.floor(min / 60), m = min % 60;
    return m ? h + '시간 ' + m + '분' : h + '시간';
  }

  function weekLabel(weekStart) {
    var s = toDate(weekStart), e = addDays(s, 6);
    return (s.getMonth() + 1) + '월 ' + s.getDate() + '일 – ' + (e.getMonth() + 1) + '월 ' + e.getDate() + '일';
  }

  // ------------------------------------------------------------------ 쓸 수 있는 시간 읽기 (duration 의 역함수)
  // '45', '45분', '1시간 30분', '1h30m', '한 시간 반', '1.5시간', '1:30' → 분(정수).
  // 글 전체가 한 형태와 맞아야 한다. 상대 시각('30분 후')·한자어 수('삼십분')·소수 분은 받지 않는다.
  var DURATION_MIN = 5;
  var DURATION_MAX = 720;
  var DURATION_MESSAGES = {
    empty: '시간을 적어 주세요.',
    invalid: '‘45’, ‘1시간 30분’, ‘1:30’처럼 적어 주세요.',
    too_short: '5분 이상으로 적어 주세요.',
    too_long: '12시간 이하로 적어 주세요.'
  };
  // 시간에만 쓰는 한글 수 (한 시간 · 두시간 · 열두 시간)
  var KO_HOURS = { '한': 1, '두': 2, '세': 3, '네': 4, '다섯': 5, '여섯': 6, '일곱': 7, '여덟': 8, '아홉': 9, '열': 10, '열한': 11, '열두': 12 };
  var DUR_MIN_UNIT = '(?:분|minutes?|mins?|m)';
  var DUR_MINUTES_RE = new RegExp('^(\\d+) ?' + DUR_MIN_UNIT + '?$');
  var DUR_CLOCK_RE = /^(\d+):(\d{2})$/;
  var DUR_HOURS_RE = new RegExp('^(\\d+(?:\\.\\d+)?|열한|열두|다섯|여섯|일곱|여덟|아홉|열|한|두|세|네) ?(시간|hours?|hrs?|h)' +
    '(?: ?(반)| ?(\\d+) ?' + DUR_MIN_UNIT + '?)?$');
  var DUR_HALF_RE = /^반 ?시간$/;

  function durationFail(error) { return { ok: false, error: error, message: DURATION_MESSAGES[error] }; }

  function durationMinutesOf(t) {
    var m = DUR_MINUTES_RE.exec(t);
    if (m) return Number(m[1]);
    m = DUR_CLOCK_RE.exec(t);
    if (m) { var mm = Number(m[2]); return mm > 59 ? null : Number(m[1]) * 60 + mm; }
    if (DUR_HALF_RE.test(t)) return 30;
    m = DUR_HOURS_RE.exec(t);
    if (!m) return null;
    var ko = Object.prototype.hasOwnProperty.call(KO_HOURS, m[1]);
    if (ko && m[2] !== '시간') return null;                       // '한 h' 같은 섞어 쓰기는 받지 않는다
    var hours = ko ? KO_HOURS[m[1]] : Number(m[1]);
    var decimal = !ko && m[1].indexOf('.') >= 0;
    if (m[3]) return decimal ? null : hours * 60 + 30;            // '1시간 반'
    if (m[4] != null) {                                           // '1시간 30분' — 분은 0–59, 소수 시간과는 함께 쓰지 않는다
      var min = Number(m[4]);
      return (decimal || min > 59) ? null : hours * 60 + min;
    }
    return Math.round(hours * 60);
  }

  // parseDuration(text) → { ok:true, minutes } | { ok:false, error:'empty'|'invalid'|'too_short'|'too_long', message }
  function parseDuration(text) {
    var s = text == null ? '' : String(text);
    if (typeof s.normalize === 'function') s = s.normalize('NFKC');   // 전각 숫자 → 반각
    s = s.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!s) return durationFail('empty');
    s = s.replace(/^(?:약|대략) ?/, '').replace(/ ?(?:정도|쯤|가량|내외)$/, '');
    var minutes = s ? durationMinutesOf(s) : null;
    if (minutes == null) return durationFail('invalid');
    if (minutes < DURATION_MIN) return durationFail('too_short');
    if (minutes > DURATION_MAX) return durationFail('too_long');
    return { ok: true, minutes: minutes };
  }

  return {
    DAY: DAY, WEEKDAYS: WEEKDAYS, pad: pad, ymd: ymd, parseYmd: parseYmd,
    startOfDay: startOfDay, endOfDay: endOfDay, addDays: addDays, addMinutes: addMinutes,
    startOfWeek: startOfWeek, dayDiff: dayDiff, minutesBetween: minutesBetween,
    hm: hm, relDay: relDay, longDay: longDay, shortDay: shortDay, duration: duration, weekLabel: weekLabel,
    DURATION_MIN: DURATION_MIN, DURATION_MAX: DURATION_MAX, parseDuration: parseDuration
  };
});
