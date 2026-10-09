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

  return {
    DAY: DAY, WEEKDAYS: WEEKDAYS, pad: pad, ymd: ymd, parseYmd: parseYmd,
    startOfDay: startOfDay, endOfDay: endOfDay, addDays: addDays, addMinutes: addMinutes,
    startOfWeek: startOfWeek, dayDiff: dayDiff, minutesBetween: minutesBetween,
    hm: hm, relDay: relDay, longDay: longDay, shortDay: shortDay, duration: duration, weekLabel: weekLabel
  };
});
