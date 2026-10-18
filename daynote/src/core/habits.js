'use strict';

// 연구에 기반한 작은 도움들 — 근거는 ../../DAYNOTE_UX_RESEARCH.md
//
//   realistic   : 계획 오류(Buehler·Griffin·Ross 1994) — 내 예상 대비 실제 걸린 시간 비율로 현실적인 시간을 알려 준다
//   workRun     : 미세 휴식(Albulescu 외 2022) — 50분쯤 이어서 일한 뒤 할 일·단계를 끝내면 3분 쉬기를 권한다
//                 쉬기 권하기는 일이 끝나는 지점에서 (작업 경계의 방해가 비용이 적다 — Bailey & Konstan 2006)
//   longFocus   : 끝나는 지점이 오지 않아도 한 일에 90분 넘게 이어서 집중하면 쉬어 가기를 권한다 (안전망)
//   dayClose    : 계획 세우기가 미완료 목표의 잔상을 없앤다(Masicampo & Baumeister 2011) — 하루 마무리에 남은 일마다 다음 시각을 정한다
//   overdue     : 자기 용서(Wohl·Pychyl·Bennett 2010) — 밀린 일을 탓하지 않고 한 번에 다시 정하게 한다
//   weekStart   : 새 출발 효과(Dai·Milkman·Riis 2014) — 주의 첫날에 이번 주 꼭 끝낼 일 3가지를 고르게 한다
//   whenChoices : 실행 의도(Gollwitzer & Sheeran 2006) — "언제 할지" 를 바로 정하게 하는 선택지
//   (멈출 때 '이어서 할 첫 행동' 메모 — Leroy & Glomb 2018 — 는 model.pauseTask 의 resumeNote)

(function (factory) {
  var deps = (typeof module !== 'undefined' && module.exports)
    ? { dates: require('./dates'), model: require('./model') }
    : { dates: window.Daynote.dates, model: window.Daynote.model };
  var api = factory(deps.dates, deps.model);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.habits = api; }
})(function (D, M) {
  var LONG_FOCUS_MIN = 90;      // 끝나는 지점 없이 한 일에 이만큼 이어서 집중하면 쉬어 가기 권하기 (안전망)
  var REST_EVERY_MIN = 50;      // 이만큼 이어서 일한 뒤 일 하나를 끝내면 쉬기 권하기
  var AWAY_MIN = 30;            // 이만큼 아무 일도 안 했으면 쉬다 온 것으로 본다 (흐름을 새로)
  var REST_DEFAULT_MIN = 3;     // 쉬는 시간 기본값
  var MIN_SAMPLES = 3;          // 예상 대비 실제 비율은 끝낸 일이 이만큼 쌓여야 쓴다

  function round5(n) { return Math.max(5, Math.round(n / 5) * 5); }

  // ---------------------------------------------------------------- 계획 오류 보정
  // 끝낸 일 중 예상 시간과 실제 한 시간(5분 이상)이 둘 다 있는 것의 비율 중앙값 (0.5~3배로 묶음)
  function estimateRatio(state) {
    var rs = state.tasks.filter(function (t) {
      return t.status === 'done' && !t.deletedAt && t.estimateMinutes > 0 && (t.workedMs || 0) >= 5 * 60000;
    }).map(function (t) { return (t.workedMs / 60000) / t.estimateMinutes; }).sort(function (a, b) { return a - b; });
    if (rs.length < MIN_SAMPLES) return null;
    var mid = rs.length % 2 ? rs[(rs.length - 1) / 2] : (rs[rs.length / 2 - 1] + rs[rs.length / 2]) / 2;
    return { ratio: Math.round(Math.max(0.5, Math.min(3, mid)) * 10) / 10, n: rs.length };
  }
  // 이 일의 현실적인 시간 — 비율이 1.2배 이상 벗어날 때만 알려 준다
  function realistic(state, task) {
    if (!(task.estimateMinutes > 0)) return null;
    var r = estimateRatio(state);
    if (!r || (r.ratio > 0.85 && r.ratio < 1.2)) return null;
    return { minutes: round5(task.estimateMinutes * r.ratio), ratio: r.ratio, n: r.n };
  }
  // 끝낼 때 보여 줄 "예상 30분 · 실제 45분"
  function actualVsEstimate(task, now) {
    var worked = M.workedMinutes(task, now);
    if (!(task.estimateMinutes > 0) || worked < 5) return null;
    return { estimate: task.estimateMinutes, actual: worked };
  }

  // ---------------------------------------------------------------- 일한 흐름 — { since, last } (ISO)
  //   일한 흔적(시작·완료·단계 체크·진행 중)마다 touch. 날이 바뀌었거나 30분 넘게 비었으면 새 흐름
  function touchWork(run, now) {
    var n = new Date(now);
    if (!run || D.ymd(new Date(run.last)) !== D.ymd(n) || n - new Date(run.last) > AWAY_MIN * 60000) return { since: n.toISOString(), last: n.toISOString() };
    return { since: run.since, last: n.toISOString() };
  }
  function workRunMinutes(run, now) {
    if (!run) return 0;
    var n = new Date(now);
    if (n - new Date(run.last) > AWAY_MIN * 60000) return 0;
    return Math.floor((n - new Date(run.since)) / 60000);
  }
  // 일 하나를 끝낸 지금 쉬기를 권할까 — 50분쯤 이어서 일했고, 최근 20분 안에 권하지 않았으면
  function restDue(run, now, lastNudgeAt) {
    if (workRunMinutes(run, now) < REST_EVERY_MIN) return false;
    return !lastNudgeAt || new Date(now) - new Date(lastNudgeAt) >= 20 * 60000;
  }

  // ---------------------------------------------------------------- 오래 집중 (안전망)
  function longFocus(state, now) {
    var n = new Date(now).getTime();
    return M.liveTasks(state).filter(function (t) {
      return t.status === 'in_progress' && t.runningSince && n - new Date(t.runningSince).getTime() >= LONG_FOCUS_MIN * 60000;
    })[0] || null;
  }

  // ---------------------------------------------------------------- 하루 마무리
  // 오늘 끝낸 일(작은 성취 — Amabile & Kramer 2011) + 아직 남은 오늘 일
  //   남은 일은 '오늘 하려던 일' 만 — 앞날로 할 날·마감이 이미 정해진 일은 다시 묻지 않는다 (퇴근 직전 결정 수를 줄인다 — UX 점검 S-01)
  function dayClose(state, now, todayTasks) {
    var today = D.ymd(now);
    var nowIso = new Date(now).toISOString();
    var done = M.liveTasks(state).filter(function (t) { return t.status === 'done' && t.completedAt && D.ymd(t.completedAt) === today; });
    var blockToday = {};
    state.blocks.forEach(function (b) { if (b.taskId && D.ymd(b.start) === today) blockToday[b.taskId] = true; });
    var left = (todayTasks || []).filter(function (t) {
      if (t.status === 'done') return false;
      if (t.status === 'in_progress' || t.status === 'paused' || blockToday[t.id]) return true;
      if (t.planDate) return t.planDate <= today;
      if (t.dueDate) return t.dueDate <= today;
      // 앞으로 잡힌 작업 시간이 있으면 이미 정한 것
      if (state.blocks.some(function (b) { return b.taskId === t.id && b.start > nowIso; })) return false;
      return true;
    });
    return { done: done, left: left };
  }
  // "내일 오전" · "내일 오후" · "이번 주 나중에" — 남은 일의 다음 시각 (실행 의도)
  //   빈 시간 찾기는 화면 쪽(schedule.findFreeSlot)이 하므로 여기서는 기준 시각만 준다
  function whenChoices(now) {
    var n = new Date(now);
    var tomorrow = D.addDays(D.startOfDay(n), 1);
    var choices = [];
    if (n.getHours() < 13) choices.push({ id: 'today_pm', label: '오늘 오후', at: D.parseYmd(D.ymd(n), '14:00') });
    else if (n.getHours() < 19) choices.push({ id: 'today_eve', label: '오늘 저녁', at: D.parseYmd(D.ymd(n), '19:00') });
    choices.push({ id: 'tom_am', label: '내일 오전', at: D.parseYmd(D.ymd(tomorrow), '09:00') });
    choices.push({ id: 'tom_pm', label: '내일 오후', at: D.parseYmd(D.ymd(tomorrow), '14:00') });
    // 이번 주 금요일 (오늘이 금~일이면 다음 주 월요일)
    var dow = n.getDay();
    var later = dow >= 5 || dow === 0 ? D.addDays(D.startOfDay(n), dow === 0 ? 1 : 8 - dow) : D.addDays(D.startOfDay(n), 5 - dow);
    choices.push({ id: 'later', label: dow >= 5 || dow === 0 ? '다음 주 월요일' : '이번 주 금요일', at: D.parseYmd(D.ymd(later), '10:00') });
    return choices;
  }

  // ---------------------------------------------------------------- 밀린 일 한 번에 다시 정하기
  function overdueTasks(state, now) {
    var n = new Date(now);
    return M.liveTasks(state).filter(function (t) { return t.status !== 'done' && t.dueDate && D.dueAt(t.dueDate, t.dueTime) < n; })
      .sort(function (a, b) { return D.dueAt(a.dueDate, a.dueTime) - D.dueAt(b.dueDate, b.dueTime); });   // 오래 밀린 것부터
  }
  // 전부 내일로 (시각은 그대로) — 바꾼 할 일 목록을 돌려준다
  function postponeOverdueToTomorrow(state, now) {
    var tomorrow = D.ymd(D.addDays(D.startOfDay(new Date(now)), 1));
    return overdueTasks(state, now).map(function (t) { return M.updateTask(state, t.id, { dueDate: tomorrow, postponedCount: (t.postponedCount || 0) + 1 }, now); });
  }

  // ---------------------------------------------------------------- 새 주 시작
  function weekKey(now) { return D.ymd(D.startOfWeek(new Date(now))); }
  // 주가 바뀐 뒤 처음이고, 열린 할 일이 있을 때
  function shouldOfferWeekStart(state, now) {
    if ((state.meta && state.meta.weekStartOffered) === weekKey(now)) return false;
    return M.liveTasks(state).some(function (t) { return t.status !== 'done'; });
  }
  // 이번 주 꼭 끝낼 일 (최대 3개) — 고른 것만 표시, 나머지 표시는 지운다
  function setWeekGoals(state, ids, now) {
    var key = weekKey(now);
    var pick = (ids || []).slice(0, 3);
    M.liveTasks(state).forEach(function (t) {
      if (pick.indexOf(t.id) !== -1) t.weekGoal = key;
      else if (t.weekGoal === key) t.weekGoal = null;
    });
    state.meta.weekStartOffered = key;
    return pick.length;
  }
  function isWeekGoal(task, now) { return !!task.weekGoal && task.weekGoal === weekKey(now) && task.status !== 'done'; }

  return {
    LONG_FOCUS_MIN: LONG_FOCUS_MIN, REST_EVERY_MIN: REST_EVERY_MIN, REST_DEFAULT_MIN: REST_DEFAULT_MIN,
    touchWork: touchWork, workRunMinutes: workRunMinutes, restDue: restDue, estimateRatio: estimateRatio, realistic: realistic, actualVsEstimate: actualVsEstimate,
    longFocus: longFocus, dayClose: dayClose, whenChoices: whenChoices,
    overdueTasks: overdueTasks, postponeOverdueToTomorrow: postponeOverdueToTomorrow,
    weekKey: weekKey, shouldOfferWeekStart: shouldOfferWeekStart, setWeekGoals: setWeekGoals, isWeekGoal: isWeekGoal
  };
});
