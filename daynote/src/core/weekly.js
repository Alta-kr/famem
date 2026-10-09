'use strict';

// 주간 정리 + 주간업무보고 초안.
//
// summarize 와 draftReport 는 상태를 바꾸지 않는다. 기록(히스토리·할 일)에 있는 것만 모은다.
// 보고서 초안은 기록에 없는 내용을 절대 만들어내지 않는다 — 빈 섹션은 '- 기록 없음'.
// carryOver 만 상태를 바꾼다 (사용자가 고른 미완료 할 일의 마감을 다음 주로 넘김).
//
// 주는 월요일 시작, 일요일 끝 (dates.startOfWeek 와 같다). 시각 비교는 모두 현지 시간 기준.

(function (factory) {
  var deps = (typeof module !== 'undefined' && module.exports)
    ? { dates: require('./dates'), model: require('./model') }
    : { dates: window.Daynote.dates, model: window.Daynote.model };
  var api = factory(deps.dates, deps.model);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.weekly = api; }
})(function (D, M) {
  var NO_PROJECT = '프로젝트 없음';
  var EMPTY = '- 기록 없음';

  function weekRange(weekStartYmd) {
    var start = D.startOfWeek(D.parseYmd(weekStartYmd));
    var nextStart = D.addDays(start, 7);
    return {
      start: start, nextStart: nextStart,
      weekStart: D.ymd(start), weekEnd: D.ymd(D.addDays(start, 6)),
      nextWeekEnd: D.ymd(D.addDays(start, 13))
    };
  }

  function inRange(at, r) {
    if (!at) return false;
    var t = new Date(at).getTime();
    return t >= r.start.getTime() && t < r.nextStart.getTime();
  }

  function projectName(state, id) {
    if (!id) return NO_PROJECT;
    var p = M.byId(state.projects, id);
    return p ? p.name : NO_PROJECT;
  }

  function byAt(a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; }

  // ------------------------------------------------------------------ 요약
  function summarize(state, weekStartYmd, now) {
    var r = weekRange(weekStartYmd);
    var weekHist = state.history.filter(function (h) { return !h.revokedAt && inRange(h.at, r); }).sort(byAt);

    // 이번 주 한 일 — 완료 기록을 프로젝트별로
    var groups = {}, order = [];
    weekHist.filter(function (h) { return h.type === 'task_done'; }).forEach(function (h) {
      var ref = (h.refs || []).filter(function (x) { return x.kind === 'task'; })[0] || { kind: 'task', id: null, label: h.title };
      var res = M.resolveRef(state, ref);
      var task = res.item;
      var pid = (task && !task.deletedAt ? task.projectId : h.projectId) || null;
      var gk = pid || '';
      if (!groups[gk]) { groups[gk] = { projectId: pid, projectName: projectName(state, pid), items: [] }; order.push(gk); }
      groups[gk].items.push({
        historyId: h.id, taskId: ref.id || null,
        title: res.missing ? (ref.label || h.title || '') : res.label,
        completedAt: h.at, missing: res.missing
      });
    });
    var completed = order.map(function (k) { return groups[k]; });
    // 프로젝트 없음은 맨 뒤
    completed.sort(function (a, b) { return (a.projectId ? 0 : 1) - (b.projectId ? 0 : 1); });

    var weekEndEod = D.endOfDay(D.parseYmd(r.weekEnd)).toISOString();
    var open = M.liveTasks(state).filter(function (t) { return t.status !== 'done'; });

    var unfinished = open.filter(function (t) {
      if (t.createdAt && t.createdAt > weekEndEod) return false;
      return (t.dueDate && t.dueDate <= r.weekEnd) || t.status === 'in_progress' || t.status === 'waiting';
    }).sort(function (a, b) {
      return (a.dueDate || '9999') < (b.dueDate || '9999') ? -1 : (a.dueDate || '9999') > (b.dueDate || '9999') ? 1 : 0;
    }).map(function (t) {
      return { taskId: t.id, title: t.title, projectId: t.projectId || null, dueDate: t.dueDate || null, status: t.status };
    });

    var nextWeek = open.filter(function (t) {
      return t.dueDate && t.dueDate > r.weekEnd && t.dueDate <= r.nextWeekEnd;
    }).sort(function (a, b) { return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0; })
      .map(function (t) { return { taskId: t.id, title: t.title, dueDate: t.dueDate, projectId: t.projectId || null }; });

    function ofType(type) { return weekHist.filter(function (h) { return h.type === type; }); }

    return {
      weekStart: r.weekStart, weekEnd: r.weekEnd,
      recordCount: weekHist.length,
      completed: completed,
      unfinished: unfinished,
      decisions: ofType('decision'),
      blockers: ofType('blocker'),
      achievements: ofType('achievement'),
      updates: ofType('update'),
      nextWeek: nextWeek
    };
  }

  // ------------------------------------------------------------------ 보고서 초안
  function md(ymdStr) {
    var d = D.parseYmd(ymdStr);
    return (d.getMonth() + 1) + '월 ' + d.getDate() + '일';
  }
  function shortMd(ymdStr) {
    var d = D.parseYmd(ymdStr);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }
  function oneLine(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

  function histLine(state, h) {
    var text = oneLine(h.title);
    var body = oneLine(h.body);
    if (body && body !== text) text = text ? text + ' — ' + body : body;
    if (h.projectId) {
      var p = M.byId(state.projects, h.projectId);
      if (p) text = '[' + p.name + '] ' + text;
    }
    return '- ' + text;
  }

  function list(lines) { return lines.length ? lines.join('\n') : EMPTY; }

  function draftReport(summary, state) {
    var s = summary;
    var out = [];
    out.push('# 주간업무보고 (' + md(s.weekStart) + ' – ' + md(s.weekEnd) + ')');

    out.push('', '## 이번 주 한 일');
    var doneParts = [];
    s.completed.forEach(function (g) {
      doneParts.push('', '### ' + g.projectName);
      g.items.forEach(function (it) { doneParts.push('- ' + oneLine(it.title) + (it.missing ? ' (원본 삭제됨)' : '')); });
    });
    var ach = s.achievements.map(function (h) { return histLine(state, h); });
    if (ach.length) doneParts.push('', '### 성과', ach.join('\n'));
    var upd = s.updates.map(function (h) { return histLine(state, h); });
    if (upd.length) doneParts.push('', '### 업데이트', upd.join('\n'));
    if (doneParts.length) out = out.concat(doneParts); else out.push(EMPTY);

    out.push('', '## 진행 중·남은 일');
    out.push(list(s.unfinished.map(function (t) {
      var meta = [];
      if (t.status && t.status !== 'todo' && M.TASK_STATUS[t.status]) meta.push(M.TASK_STATUS[t.status]);
      if (t.dueDate) meta.push('마감 ' + shortMd(t.dueDate));
      return '- ' + oneLine(t.title) + (meta.length ? ' (' + meta.join(', ') + ')' : '');
    })));

    out.push('', '## 결정 사항');
    out.push(list(s.decisions.map(function (h) { return histLine(state, h); })));

    out.push('', '## 이슈·장애물');
    out.push(list(s.blockers.map(function (h) { return histLine(state, h); })));

    out.push('', '## 다음 주 계획');
    out.push(list(s.nextWeek.map(function (t) {
      return '- ' + oneLine(t.title) + (t.dueDate ? ' (마감 ' + shortMd(t.dueDate) + ')' : '');
    })));

    return out.join('\n') + '\n';
  }

  // ------------------------------------------------------------------ 다음 주로 넘기기
  // 마감이 있으면 +7일, 없으면 다음 주 월요일. 끝났거나 지워진 할 일은 건드리지 않는다.
  function carryOver(state, taskIds, weekStartYmd, now) {
    var r = weekRange(weekStartYmd);
    var nextMonday = D.ymd(r.nextStart);
    var changed = [];
    (taskIds || []).forEach(function (id) {
      var t = M.byId(state.tasks, id);
      if (!t || t.deletedAt || t.archivedAt || t.status === 'done') return;
      var due = t.dueDate ? D.ymd(D.addDays(D.parseYmd(t.dueDate), 7)) : nextMonday;
      M.updateTask(state, id, { dueDate: due }, now);
      changed.push(t);
    });
    return changed;
  }

  return { summarize: summarize, draftReport: draftReport, carryOver: carryOver, weekRange: weekRange };
});
