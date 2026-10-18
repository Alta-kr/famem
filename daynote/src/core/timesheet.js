'use strict';

// 쓴 시간 — 할 일의 작업 시간 기록(sessions: 시작 버튼 ~ 일시 정지·완료)을 날짜·프로젝트별로 모은다.
//   프리랜서의 청구·견적에 쓰는 숫자 (UX 점검 P-01·WK-01)
//   소프트웨어 작업은 평균 30~40% 초과된다 (Moløkken-Østvold & Jørgensen 2003) — 예상 대비 실제를 함께 보여 준다
//   기록(sessions)이 생기기 전에 쌓인 시간은 workedMs 에만 있어 '지금까지' 합계에만 들어간다

(function (factory) {
  var deps = (typeof module !== 'undefined' && module.exports)
    ? { dates: require('./dates'), model: require('./model') }
    : { dates: window.Daynote.dates, model: window.Daynote.model };
  var api = factory(deps.dates, deps.model);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.timesheet = api; }
})(function (D, M) {
  function ms(x) { return new Date(x).getTime(); }

  // 이 할 일의 작업 구간 [{ s, e }] — 지금 진행 중이면 지금까지
  function spans(t, now) {
    var out = (t.sessions || []).map(function (x) { return { s: ms(x.s), e: ms(x.e) }; });
    if (t.runningSince) out.push({ s: ms(t.runningSince), e: ms(now) });
    return out.filter(function (x) { return x.e > x.s; });
  }
  // [from, to) 안에 든 분
  function minutesBetween(t, from, to, now) {
    var a = ms(from), b = ms(to), sum = 0;
    spans(t, now).forEach(function (x) { var s = Math.max(a, x.s), e = Math.min(b, x.e); if (e > s) sum += e - s; });
    return Math.round(sum / 60000);
  }
  function weekRange(now) {
    var s = D.startOfWeek(now);
    return { from: s, to: D.addDays(s, 7) };
  }

  // 프로젝트 요약 — projectId 가 null 이면 '프로젝트 없음'
  function projectSummary(state, projectId, now) {
    var tasks = M.liveTasks(state).filter(function (t) { return (t.projectId || null) === (projectId || null); });
    var wk = weekRange(now);
    var total = 0, week = 0, remaining = 0, est = 0, act = 0;
    tasks.forEach(function (t) {
      var w = M.workedMinutes(t, now);
      total += w;
      week += minutesBetween(t, wk.from, wk.to, now);
      if (t.status !== 'done' && t.estimateMinutes > 0) remaining += Math.max(0, t.estimateMinutes - w);
      // 예상 대비 실제 — 예상이 있고 5분 넘게 기록된 끝낸 일만
      if (t.status === 'done' && t.estimateMinutes > 0 && w >= 5) { est += t.estimateMinutes; act += w; }
    });
    return { totalMin: total, weekMin: week, remainingMin: remaining, ratio: est ? Math.round(act / est * 10) / 10 : null };
  }

  // 한 주의 쓴 시간 — 프로젝트별, 그 안에서 할 일별 (많이 쓴 순)
  function weekByProject(state, weekStartYmd, now) {
    var from = D.parseYmd(weekStartYmd), to = D.addDays(from, 7);
    var by = {};
    M.liveTasks(state).forEach(function (t) {
      var m = minutesBetween(t, from, to, now);
      if (!m) return;
      var pid = t.projectId || '';
      var p = by[pid] = by[pid] || { projectId: t.projectId || null, minutes: 0, tasks: [] };
      p.minutes += m;
      p.tasks.push({ taskId: t.id, title: t.title, minutes: m });
    });
    return Object.keys(by).map(function (k) {
      var p = by[k];
      var proj = p.projectId && M.byId(state.projects, p.projectId);
      p.name = proj ? proj.name : '프로젝트 없음';
      p.tasks.sort(function (a, b) { return b.minutes - a.minutes; });
      return p;
    }).sort(function (a, b) { return b.minutes - a.minutes; });
  }

  // CSV — 날짜, 프로젝트, 할 일, 시작, 끝, 분 (구간이 자정을 넘으면 날짜별로 나눈다). Excel 한글을 위해 BOM 을 붙인다
  function csv(state, fromYmd, toYmd, now) {
    var from = ms(D.parseYmd(fromYmd)), to = ms(D.addDays(D.parseYmd(toYmd), 1));
    var rows = [];
    M.liveTasks(state).forEach(function (t) {
      var proj = t.projectId && M.byId(state.projects, t.projectId);
      spans(t, now).forEach(function (x) {
        var s = Math.max(x.s, from), e = Math.min(x.e, to);
        while (e > s) {
          var dayEnd = ms(D.addDays(D.startOfDay(new Date(s)), 1));
          var cut = Math.min(e, dayEnd);
          rows.push([D.ymd(new Date(s)), proj ? proj.name : '', t.title, D.hm(new Date(s)), D.hm(new Date(cut)), Math.round((cut - s) / 60000)]);
          s = cut;
        }
      });
    });
    rows.sort(function (a, b) { return (a[0] + a[3]).localeCompare(b[0] + b[3]); });
    function cell(v) { v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
    var lines = [['날짜', '프로젝트', '할 일', '시작', '끝', '분'].join(',')].concat(rows.map(function (r) { return r.map(cell).join(','); }));
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  return { spans: spans, minutesBetween: minutesBetween, projectSummary: projectSummary, weekByProject: weekByProject, csv: csv };
});
