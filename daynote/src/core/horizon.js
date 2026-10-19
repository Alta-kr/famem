'use strict';

// 앞을 내다보기 — 오늘만이 아니라 내일 · 이번 주 · 다음 주를 보며 미리 준비하게. 근거: ../../DAYNOTE_UX_RESEARCH.md (4차)
//
//   할 날(planDate) : 마감과 다른 "이 날 하겠다" — 끌어서 정한다 (실행 의도 — Gollwitzer & Sheeran 2006)
//   기준 날         : 할 날 → 그 일의 작업 시간 → 마감 순으로, 그 일을 어느 날 칸에 보여 줄지
//   남은 날         : '며칠 후' 로 센다 — 날로 세면 미래가 가깝게 느껴져 더 일찍 시작한다 (Lewis & Oyserman 2015)
//   이번 주로 묶기  : 마감이 '지금과 같은 묶음'(이번 주)에 있으면 더 빨리 시작한다 (Tu & Soman 2014)
//   늦어도 시작할 날: 먼 일은 '왜' 만 생각하고 '어떻게·얼마나' 를 놓친다 (Liberman & Trope 1998) —
//                     예상 시간(평소 보정 포함)으로 거꾸로 세어 "늦어도 언제 시작" 을 보여 준다

(function (factory) {
  var deps = (typeof module !== 'undefined' && module.exports)
    ? { dates: require('./dates'), model: require('./model') }
    : { dates: window.Daynote.dates, model: window.Daynote.model };
  var api = factory(deps.dates, deps.model);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.horizon = api; }
})(function (D, M) {
  var WORK_MIN_PER_DAY = 240;   // 한 일에 하루에 쓸 수 있다고 보는 시간 (나머지는 회의·다른 일) — '늦어도 시작할 날' 계산용

  // [오늘] 은 오늘과 내일을 함께 보여 준다 (내일 탭을 따로 두지 않는다)
  var VIEWS = [
    { id: 'today', label: '오늘' },
    { id: 'week', label: '이번 주' },
    { id: 'next', label: '다음 주' }
  ];

  function ymd(d) { return D.ymd(d); }
  function plus(day, n) { return ymd(D.addDays(D.parseYmd(day), n)); }

  // 보기 → 날짜 목록. 주는 월요일에 시작한다. 'day:2026-10-21' 은 그 하루
  function days(view, now) {
    var today = ymd(now);
    if (view && view.indexOf('day:') === 0) return [view.slice(4)];
    if (view === 'tomorrow') return [plus(today, 1)];
    if (view === 'week') {
      var mon = ymd(D.startOfWeek(now)), out = [];
      for (var i = 0; i < 7; i++) { var d = plus(mon, i); if (d >= today) out.push(d); }
      // 주말이면 이번 주가 거의 끝났다 — 다음 월요일까지 함께 (월요일 준비)
      if (out.length <= 2) out.push(plus(mon, 7));
      return out;
    }
    if (view === 'next') {
      var nmon = plus(ymd(D.startOfWeek(now)), 7), list = [];
      for (var j = 0; j < 7; j++) list.push(plus(nmon, j));
      return list;
    }
    if (view === 'today+') return [today, plus(today, 1)];   // 홈 [오늘] — 오늘과 내일
    return [today];
  }

  // 이 할 일을 어느 날 칸에 보여 줄까 — 할 날 → 앞으로 잡힌 작업 시간 → 마감
  function anchorDay(state, t, now) {
    if (t.planDate) return t.planDate;
    var nowIso = new Date(now).toISOString();
    var b = state.blocks.filter(function (x) { return x.taskId === t.id && x.end > nowIso; })
      .sort(function (a, c) { return a.start < c.start ? -1 : 1; })[0];
    var work = b ? ymd(b.start) : null;
    // 작업 시간과 마감 중 이른 날 — 마감보다 늦게 잡힌 작업 시간이 마감 날을 가리지 않게
    if (work && t.dueDate) return work < t.dueDate ? work : t.dueDate;
    return work || t.dueDate || null;
  }

  function openTasks(state) {
    return M.liveTasks(state).filter(function (t) { return t.status !== 'done'; });
  }

  // 날짜별 묶음 — [{ day, tasks, events }]. 지난 기준 날(밀린 일)은 첫날 칸에 함께 (오늘이 첫날일 때만)
  function byDay(state, dayList, now) {
    var today = ymd(now);
    var map = {};
    dayList.forEach(function (d) { map[d] = { day: d, tasks: [], events: [] }; });
    openTasks(state).forEach(function (t) {
      var a = anchorDay(state, t, now);
      if (!a) return;
      if (a < today && dayList[0] === today) a = today;
      if (map[a]) map[a].tasks.push(t);
    });
    state.blocks.forEach(function (b) {
      if (b.kind !== 'event') return;
      var d = ymd(b.start);
      if (map[d]) map[d].events.push(b);
    });
    dayList.forEach(function (d) {
      map[d].tasks.sort(function (a, b) {
        var sa = typeof a.sortOrder === 'number', sb = typeof b.sortOrder === 'number';
        if (sa && sb) return a.sortOrder - b.sortOrder;
        if (sa !== sb) return sa ? -1 : 1;
        return (a.dueTime || a.dueDate || '~').localeCompare(b.dueTime || b.dueDate || '~') || (a.createdAt < b.createdAt ? -1 : 1);
      });
      map[d].events.sort(function (a, b) { return a.start < b.start ? -1 : 1; });
    });
    return dayList.map(function (d) { return map[d]; });
  }

  // 앞으로 n일의 짐 — 날짜 띠에 쓴다 [{ day, tasks, events, minutes, due }]
  function load(state, now, n) {
    var today = ymd(now), list = [];
    for (var i = 0; i < (n || 14); i++) list.push(plus(today, i));
    return byDay(state, list, now).map(function (g) {
      return {
        day: g.day, tasks: g.tasks.length, events: g.events.length,
        due: g.tasks.filter(function (t) { return t.dueDate === g.day; }).length,
        minutes: g.tasks.reduce(function (a, t) { return a + (t.estimateMinutes || 0); }, 0) +
          g.events.reduce(function (a, b) { return a + Math.max(0, Math.round((new Date(b.end) - new Date(b.start)) / 60000)); }, 0)
      };
    });
  }

  function daysLeft(day, now) { return D.dayDiff(now, D.parseYmd(day)); }
  // "오늘" · "내일" · "3일 후" — 날로 센다
  function leftText(day, now) {
    var n = daysLeft(day, now);
    return n === 0 ? '오늘' : n === 1 ? '내일' : n < 0 ? (-n) + '일 지남' : n + '일 후';
  }

  // 늦어도 시작할 날 — 마감에서 (현실적인 예상 시간 ÷ 하루 240분) 만큼 거꾸로. 예상이 없으면 null
  function startBy(t, ratio) {
    if (!t.dueDate || !(t.estimateMinutes > 0)) return null;
    var need = Math.ceil(t.estimateMinutes * (ratio || 1) / WORK_MIN_PER_DAY);
    return plus(t.dueDate, -Math.max(0, need - 1));
  }

  // 다가오는 마감 — 오늘 목록에 없는, 앞으로 n일 안의 마감 (가까운 순)
  //   prep: 늦어도 시작할 날이 이미 왔거나 지난 일 (지금 시작해야 하는 일)
  function upcoming(state, now, n, excludeIds, ratio) {
    var today = ymd(now), until = plus(today, n || 7);
    var ex = {};
    (excludeIds || []).forEach(function (id) { ex[id] = true; });
    return openTasks(state).filter(function (t) {
      return !ex[t.id] && t.dueDate && t.dueDate > today && t.dueDate <= until && !(t.planDate && t.planDate <= today);
    }).map(function (t) {
      var sb = startBy(t, ratio);
      // 하루 안에 끝날 일은 "늦어도 시작할 날" 이 마감날 그 자체라 따로 알리지 않는다
      return { task: t, left: daysLeft(t.dueDate, now), startBy: sb, prep: !!(sb && sb < t.dueDate && sb <= today) };
    }).sort(function (a, b) { return (b.prep ? 1 : 0) - (a.prep ? 1 : 0) || a.left - b.left; });
  }

  // 할 날 고르기 선택지 (오늘 · 내일 · 이번 주 금요일 · 다음 주 월요일)
  function planChoices(now) {
    var today = ymd(now), wd = new Date(now).getDay();
    var list = [['오늘', today], ['내일', plus(today, 1)]];
    var fri = plus(ymd(D.startOfWeek(now)), 4);
    if (fri > plus(today, 1)) list.push(['이번 주 금요일', fri]);
    list.push(['다음 주 월요일', plus(today, ((8 - wd) % 7) || 7)]);
    return list;
  }

  return { VIEWS: VIEWS, days: days, anchorDay: anchorDay, byDay: byDay, load: load, daysLeft: daysLeft, leftText: leftText,
    startBy: startBy, upcoming: upcoming, planChoices: planChoices, WORK_MIN_PER_DAY: WORK_MIN_PER_DAY };
});
