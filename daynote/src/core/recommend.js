'use strict';

// 지금 할 일 추천 — 이미 확정된 할 일 중 "지금" 하기 좋은 것을 고른다.
//
// 이 모듈은 새 Task 를 만들지 않고, 상태도 바꾸지 않는다. 입력을 읽고 결과만 돌려준다.
// 결과는 저장하지 않는 재계산 값이다 (같은 입력 → 같은 결과).
//
// ── 후보에서 빼는 것 ───────────────────────────────────────────────
//   완료 · 삭제 · 보관 · 대기(waiting) · 선행 업무 미완료 · 미루기 시각 전
//
// ── 쓸 수 있는 시간 T ─────────────────────────────────────────────
//   1) 사용자가 고른 시간(15분·30분·1시간·직접 입력)이 있으면 그것을 쓴다.
//   2) 없으면 앱 캘린더의 "다음 일정까지 남은 시간" 을 후보로 쓴다 (실제 여유를 보장하지 않음을 화면에 표시).
//   3) 지금 일정 중이거나 오늘 남은 일정이 없으면 T 를 모른다고 본다.
//
// ── 시간 적합도 ───────────────────────────────────────────────────
//   fits       : 남은 예상 시간 ≤ T
//   step_fits  : 전체는 길지만 미완료 단계 중 T 안에 들어가는 단계가 있다 (그 단계를 제안)
//   unknown    : 예상 시간이 미정 (0분으로 보지 않는다)
//   too_long   : T 보다 길고 들어가는 단계도 없다 → 추천 목록에서 빼고 따로 알려준다
//   T 를 모르면 모든 후보가 open 이다.
//
// ── 정렬 (앞 기준이 같을 때만 다음 기준을 본다) ──────────────────────
//   1. 시간 적합 그룹    : fits/step_fits → unknown          (T 를 알 때만)
//   2. 마감 긴급도       : 기한 초과 → 오늘 → 내일 → 7일 이내 → 이후·마감 없음
//   3. 이어하기          : 진행 중이거나 지금 작업 시간이 잡힌 업무 먼저
//   4. 사용자 순서        : 홈에서 끌어 놓아 정한 순서 (정하지 않은 건 뒤)
//   4b. 우선순위         : 높음 → 보통(미지정 포함) → 낮음
//   5. 마감 시각         : 이른 순, 마감 없음은 뒤
//   6. 시간 활용         : T 를 알면 남는 시간이 적은 순, 모르면 짧은 순 (미정은 뒤)
//   7. 동률              : 먼저 만든 업무 → id 사전순 (항상 같은 순서가 나오도록)

(function (factory) {
  var deps = (typeof module !== 'undefined' && module.exports)
    ? { dates: require('./dates'), model: require('./model') }
    : { dates: window.Daynote.dates, model: window.Daynote.model };
  var api = factory(deps.dates, deps.model);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.recommend = api; }
})(function (D, M) {
  var PRIORITY_RANK = { high: 0, normal: 1, low: 2 };
  var MAX_ALTERNATIVES = 2;

  function estLabel(min, source) {
    return '약 ' + D.duration(min) + (source === 'ai' ? '(추정)' : '');
  }

  function dueInfo(task, now) {
    if (!task.dueDate) return { bucket: 4, key: '9999-99-99T99:99', text: '' };
    var due = D.parseYmd(task.dueDate, task.dueTime || '23:59');
    var diff = D.dayDiff(now, D.parseYmd(task.dueDate));
    var bucket, text;
    var timeTxt = task.dueTime ? ' ' + task.dueTime : '';
    if (diff < 0 || due.getTime() < now.getTime()) {
      bucket = 0;
      text = diff < 0 ? '마감이 ' + (-diff) + '일 지났습니다.' : '오늘' + timeTxt + ' 마감이 지났습니다.';
    } else if (diff === 0) { bucket = 1; text = '오늘' + timeTxt + ' 마감입니다.'; }
    else if (diff === 1) { bucket = 2; text = '내일' + timeTxt + ' 마감입니다.'; }
    else if (diff <= 7) { bucket = 3; text = D.relDay(task.dueDate, now) + ' 마감입니다.'; }
    else { bucket = 4; text = ''; }
    return { bucket: bucket, key: task.dueDate + 'T' + (task.dueTime || '23:59'), text: text };
  }

  // 지금 시각 기준으로 캘린더가 말해 주는 것
  function calendarContext(state, now) {
    var nowIso = now.toISOString();
    var eod = D.endOfDay(now).toISOString();
    var live = state.blocks.filter(function (b) {
      if (b.taskId) {
        var t = M.byId(state.tasks, b.taskId);
        if (!t || t.deletedAt) return false;
      }
      return b.end > nowIso && b.start < eod;
    }).sort(function (a, b) { return a.start < b.start ? -1 : 1; });
    var current = live.filter(function (b) { return b.start <= nowIso; });
    var upcoming = live.filter(function (b) { return b.start > nowIso; });
    var busyEvent = current.filter(function (b) { return b.kind === 'event'; })[0] || null;
    var next = upcoming[0] || null;
    return {
      current: current, busyWith: busyEvent, next: next,
      minutesToNext: next ? D.minutesBetween(now, next.start) : null,
      workingNow: current.filter(function (b) { return b.kind === 'work' && b.taskId; }).map(function (b) { return b.taskId; })
    };
  }

  function blockTitle(state, b) {
    if (!b) return '';
    if (b.taskId) { var t = M.byId(state.tasks, b.taskId); return t ? t.title : b.title; }
    return b.title || '일정';
  }

  function exclusionOf(state, t, now) {
    if (t.deletedAt || t.archivedAt) return 'removed';
    if (t.status === 'done') return 'done';
    if (t.status === 'waiting') return 'waiting';
    if (M.unmetBlockers(state, t).length) return 'blocked';
    if (t.snoozedUntil && new Date(t.snoozedUntil).getTime() > now.getTime()) return 'snoozed';
    return null;
  }

  function fitOf(t, T) {
    var est = t.estimateMinutes;
    if (T == null) return { fit: 'open', used: est };
    if (est == null) return { fit: 'unknown', used: null };
    if (est <= T) return { fit: 'fits', used: est };
    var steps = (t.steps || []).filter(function (s) { return !s.done && s.estimateMinutes != null && s.estimateMinutes <= T; });
    if (steps.length) return { fit: 'step_fits', used: steps[0].estimateMinutes, step: steps[0] };
    return { fit: 'too_long', used: est };
  }

  // 실제 입력만으로 이유를 만든다 (백분율·점수 없음)
  function reasonsFor(state, t, fit, due, ctx, cal, now) {
    var r = [];
    var T = ctx.availableMinutes;
    var est = t.estimateMinutes;
    var nextName = cal.next ? '‘' + blockTitle(state, cal.next) + '’' : '';
    var timeLead = ctx.source === 'user'
      ? '지금 쓸 수 있는 시간이 ' + D.duration(T) + '이고'
      : ctx.source === 'calendar' && ctx.until === 'work_end' ? '근무 종료(' + ctx.workHours.end + ')까지 ' + D.duration(T) + '이 있고'
      : ctx.source === 'calendar' ? '다음 일정 ' + nextName + '까지 ' + D.duration(T) + '이 있고' : '';

    if (fit.fit === 'fits') {
      r.push(timeLead + ', 이 업무는 ' + estLabel(est, t.estimateSource) + '입니다.');
    } else if (fit.fit === 'step_fits') {
      r.push('전체는 ' + estLabel(est, t.estimateSource) + '이라 지금 끝내기 어렵지만, ‘' + fit.step.title + '’ 단계(' + estLabel(fit.step.estimateMinutes) + ')는 ' + D.duration(T) + ' 안에 할 수 있습니다.');
    } else if (fit.fit === 'unknown') {
      r.push('소요 시간이 정해지지 않아 ' + D.duration(T) + ' 안에 끝날지 알 수 없습니다. 확인해 주세요.');
    } else if (fit.fit === 'open' && est != null) {
      r.push('이 업무는 ' + estLabel(est, t.estimateSource) + '입니다.');
    } else if (fit.fit === 'open') {
      r.push('소요 시간 미정');
    }
    if (due.text) r.push(due.text);
    if (t.status === 'in_progress') r.push('이미 진행 중인 업무라 이어서 하기 좋습니다.');
    else if (cal.workingNow.indexOf(t.id) !== -1) r.push('지금 이 업무의 작업 시간이 잡혀 있습니다.');
    if (t.priority === 'high') r.push('우선순위가 높음입니다.');
    return r;
  }

  function compare(a, b) {
    // 홈에서 끌어 놓아 정한 순서(manual)는 우선순위 필드보다 앞선다 — 사용자가 직접 정한 것이므로
    var keys = ['fitGroup', 'urgency', 'cont', 'manual', 'prio'];
    for (var i = 0; i < keys.length; i++) if (a[keys[i]] !== b[keys[i]]) return a[keys[i]] - b[keys[i]];
    if (a.dueKey !== b.dueKey) return a.dueKey < b.dueKey ? -1 : 1;
    if (a.slack !== b.slack) return a.slack - b.slack;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
  }

  // opts: { now: Date, availableMinutes: number|null, skipIds: [taskId] }
  function recommend(state, opts) {
    opts = opts || {};
    var now = opts.now ? new Date(opts.now) : new Date();
    var cal = calendarContext(state, now);

    // 근무 시간 — 캘린더 빈 시간은 근무 시간 안에서만 "쓸 수 있는 시간 후보" 로 본다.
    // 근무 시간 밖(새벽·퇴근 뒤)에는 다음 일정까지가 비어 있어도 가용 시간으로 정하지 않고 사용자에게 묻는다.
    var wh = opts.workHours || { start: '09:00', end: '18:00' };
    var whStart = D.parseYmd(D.ymd(now), wh.start), whEnd = D.parseYmd(D.ymd(now), wh.end);
    var offHours = now < whStart || now >= whEnd;

    var userT = opts.availableMinutes;
    var ctx;
    if (userT != null && userT > 0) ctx = { availableMinutes: userT, source: 'user' };
    else if (!cal.busyWith && !offHours && cal.minutesToNext != null) {
      var toEnd = D.minutesBetween(now, whEnd);
      ctx = cal.minutesToNext > toEnd
        ? { availableMinutes: toEnd, source: 'calendar', until: 'work_end' }
        : { availableMinutes: cal.minutesToNext, source: 'calendar', until: 'next' };
    }
    else ctx = { availableMinutes: null, source: 'none' };
    ctx.offHours = offHours && ctx.source !== 'user';
    ctx.workHours = wh;
    ctx.busyWith = cal.busyWith ? { id: cal.busyWith.id, title: blockTitle(state, cal.busyWith), end: cal.busyWith.end } : null;
    ctx.next = cal.next ? { id: cal.next.id, title: blockTitle(state, cal.next), start: cal.next.start } : null;
    ctx.minutesToNext = cal.minutesToNext;

    var excluded = { done: 0, waiting: 0, blocked: 0, snoozed: 0 };
    var ranked = [], tooLong = [];
    var openCount = 0;

    state.tasks.forEach(function (t) {
      var ex = exclusionOf(state, t, now);
      if (ex === 'removed') return;
      if (ex) { excluded[ex]++; if (ex !== 'done') openCount++; return; }
      openCount++;
      var fit = fitOf(t, ctx.availableMinutes);
      var due = dueInfo(t, now);
      var item = {
        taskId: t.id, fit: fit.fit, step: fit.step || null,
        fitGroup: fit.fit === 'unknown' ? 1 : 0,
        urgency: due.bucket,
        cont: (t.status === 'in_progress' || cal.workingNow.indexOf(t.id) !== -1) ? 0 : 1,
        manual: typeof t.sortOrder === 'number' ? t.sortOrder : Number.MAX_SAFE_INTEGER,
        prio: PRIORITY_RANK[t.priority] != null ? PRIORITY_RANK[t.priority] : 1,
        dueKey: due.key,
        slack: ctx.availableMinutes != null
          ? (fit.used != null ? ctx.availableMinutes - fit.used : Infinity)
          : (fit.used != null ? fit.used : Infinity),
        createdAt: t.createdAt || '',
        estimateUnknown: t.estimateMinutes == null,
        estimateIsGuess: t.estimateSource === 'ai',
        reasons: reasonsFor(state, t, fit, due, ctx, cal, now)
      };
      if (fit.fit === 'too_long') tooLong.push(item); else ranked.push(item);
    });

    ranked.sort(compare);
    tooLong.sort(function (a, b) { return a.urgency - b.urgency || a.prio - b.prio || a.slack - b.slack; });

    var skip = opts.skipIds || [];
    var visible = ranked.filter(function (i) { return skip.indexOf(i.taskId) === -1; });

    var empty = null;
    if (!ranked.length) {
      if (openCount === 0) empty = 'no_tasks';
      else if (tooLong.length) empty = 'time_short';
      else empty = 'all_excluded';
    } else if (!visible.length) empty = 'all_skipped';

    return {
      evaluatedAt: now.toISOString(),
      context: ctx,
      primary: visible[0] || null,
      alternatives: visible.slice(1, 1 + MAX_ALTERNATIVES),
      ranked: ranked,
      tooLong: tooLong,
      excluded: excluded,
      empty: empty
    };
  }

  // 실행 직전 재확인 — 그사이 완료·대기·미루기 등으로 바뀌었으면 시작하지 않는다
  function checkStartable(state, taskId, now) {
    var t = M.byId(state.tasks, taskId);
    if (!t) return { ok: false, reason: '이 할 일을 찾을 수 없습니다.' };
    var ex = exclusionOf(state, t, now ? new Date(now) : new Date());
    var msg = {
      removed: '삭제되었거나 보관된 할 일입니다.', done: '이미 완료된 할 일입니다.',
      waiting: '대기 상태인 할 일입니다.', blocked: '선행 업무가 아직 끝나지 않았습니다.',
      snoozed: '미뤄 둔 할 일입니다.'
    };
    return ex ? { ok: false, reason: msg[ex] } : { ok: true, task: t };
  }

  // 추천 결과에 영향을 주는 데이터의 지문. 화면은 이 값이 바뀌면 "정보가 바뀌었습니다" 를 띄운다.
  function signature(state) {
    var parts = [];
    state.tasks.forEach(function (t) {
      parts.push([t.id, t.status, t.priority, t.dueDate, t.dueTime, t.estimateMinutes, (t.blockedBy || []).join('+'),
        t.snoozedUntil, t.deletedAt, t.archivedAt, (t.steps || []).map(function (s) { return s.done ? 1 : 0; }).join('')].join('|'));
    });
    state.blocks.forEach(function (b) { parts.push([b.id, b.start, b.end, b.taskId].join('|')); });
    return parts.sort().join('\n');
  }

  // 미루기 선택지 — 지금 시각에 맞춰 계산한다
  function snoozeOptions(now) {
    now = new Date(now || Date.now());
    var out = [{ label: '1시간 뒤', at: D.addMinutes(now, 60) }];
    var afternoon = new Date(now); afternoon.setHours(15, 0, 0, 0);
    if (afternoon.getTime() - now.getTime() > 60 * 60000) out.push({ label: '오늘 오후 3시', at: afternoon });
    var tomorrow = D.addDays(D.startOfDay(now), 1); tomorrow.setHours(9, 0, 0, 0);
    out.push({ label: '내일 오전 9시', at: tomorrow });
    var monday = D.addDays(D.startOfWeek(now), 7); monday.setHours(9, 0, 0, 0);
    out.push({ label: '다음 주 월요일', at: monday });
    return out;
  }

  return {
    recommend: recommend, checkStartable: checkStartable, signature: signature,
    calendarContext: calendarContext, snoozeOptions: snoozeOptions, MAX_ALTERNATIVES: MAX_ALTERNATIVES
  };
});
