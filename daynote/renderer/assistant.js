'use strict';

// 홈 채팅 도우미 — 채팅 기록과 버튼 동작, "잠깐 여유 있을 때" 제안.
//
//   보내기     : 적은 글을 메모로 저장하고 AI 가 메모/할 일로 나눈다(capture.js). 큰 일은 단계 초안을 보관만 한다.
//   다음 할 일 : 규칙 기반 추천(recommend.js) — AI·인터넷 없이 바로
//   작게 나누기: 나눠 둔 초안이 있으면 그걸, 없으면 AI 에게 나눠 달라고 한 뒤 고칠 수 있는 카드로
//   휴식       : 스트레칭 3가지 + 5분 타이머
//   자동 제안  : 할 일을 끝낸 직후 / 한동안 입력이 없을 때 / 앱을 열었을 때 — 20분에 한 번 이하
//
// 채팅 메시지는 state.chat 에 남고, 카드는 저장된 할 일·메모의 "현재 상태" 로 그린다(사본을 만들지 않음).

(function () {
  var DN = window.Daynote;
  var M = DN.model, D = DN.dates, S = DN.store, R = DN.recommend;
  var AS = DN.aiAssist;
  var MAX_MESSAGES = 200;
  var IDLE_MIN = 3;
  var lastActivity = Date.now();
  var pending = {};   // 요청 중인 AI 작업

  function now() { return DN.app.now(); }

  function post(msg) {
    var m = Object.assign({ id: M.uid('msg'), at: now().toISOString(), role: 'assistant' }, msg);
    S.mutate(null, function (s) {
      if (!s.chat) s.chat = [];
      s.chat.push(m);
      if (s.chat.length > MAX_MESSAGES) s.chat.splice(0, s.chat.length - MAX_MESSAGES);
    }, { source: 'chat' });
    return m;
  }

  function update(id, patch) {
    S.mutate(null, function (s) {
      var m = M.byId(s.chat || [], id);
      if (m) Object.assign(m, patch);
    }, { source: 'chat' });
  }

  function aiReady() { return DN.aiFlow.status().configured; }

  function call(input) {
    return S.host.ai.organizeNote(input).catch(function (e) {
      return { ok: false, error: { type: 'ipc', message: e && e.message ? e.message : String(e), retryable: true } };
    });
  }

  function todayStr() { var n = now(); return D.ymd(n) + ' (' + D.WEEKDAYS[n.getDay()] + ')'; }

  // ------------------------------------------------------------------ 보내기
  function send(text, projectId) {
    text = String(text || '').trim();
    if (!text) return null;
    post({ role: 'user', kind: 'text', text: text, pin: true });   // 보낸 글은 채팅 화면 맨 위로 올라가고 답이 그 아래에 붙는다
    // 자주 쓰는 짧은 명령("할 일 추천해줘", "쉬고 싶어", "캘린더 보여줘")은 AI 없이 바로 — 메모로 남기지 않는다
    var local = DN.aiCommands.matchLocal(S.state, text, focusTask());
    if (local) { runCommand(local); return null; }
    var note = DN.capture.submit(text, projectId, function (r, noteId) {
      if (!r || !r.ok || !r.capture) return;
      var large = (r.capture.largeTasks || []).map(function (id) { return M.byId(S.state.tasks, id); }).filter(Boolean);
      if (large.length) {
        post({ kind: 'text', text: '‘' + large[0].title + '’' + (large.length > 1 ? ' 외 ' + (large.length - 1) + '개' : '') +
          '는 꽤 큰 일 같아요. 작은 단계로 나눠 둘게요 — 잠깐 여유 있을 때 보여 드릴게요.' });
      }
    });
    if (note) post({ kind: 'capture', noteId: note.id });
    return note;
  }

  // ------------------------------------------------------------------ 다음 할 일
  function next(skip) {
    var r = R.recommend(S.state, { now: now(), skipIds: skip || [], workHours: S.state.prefs.workHours });
    if (r.primary) {
      post({ kind: 'next', taskId: r.primary.taskId, step: r.primary.step ? r.primary.step.title : null, reasons: r.primary.reasons, skip: skip || [] });
      return r;
    }
    if (r.empty === 'all_skipped') { post({ kind: 'text', text: '추천할 후보를 모두 보여 드렸어요. 넘긴 할 일도 그대로 남아 있어요.' }); return r; }
    if (r.empty === 'time_short') { post({ kind: 'text', text: '남은 시간 안에 끝낼 수 있는 할 일이 없어요. 큰 일을 작게 나눠 볼까요?' }); breakdown(); return r; }
    // 지금 할 만한 일이 없어 보이면 — 자세히 적어 두면 좋을 할 일을 찾는다
    post({ kind: 'text', text: r.empty === 'no_tasks' ? '아직 할 일이 없어요. 생각나는 걸 편하게 적어 주세요.' : '지금 바로 시작할 할 일이 없어 보여요.' });
    if (r.empty !== 'no_tasks') elaborate();
    return r;
  }

  // ------------------------------------------------------------------ 작게 나누기
  function pickTaskToBreak() {
    var pend = AS.pendingBreakdowns(S.state, now());
    if (pend.length) return pend[0];
    var open = M.liveTasks(S.state).filter(function (t) { return t.status !== 'done' && t.status !== 'waiting' && !(t.steps || []).length && !(t.breakdown && t.breakdown.status === 'dismissed'); });
    open.sort(function (a, b) { return (b.estimateMinutes || 0) - (a.estimateMinutes || 0) || (a.dueDate || '9999').localeCompare(b.dueDate || '9999'); });
    return open[0] || null;
  }

  // ------------------------------------------------------------------ 작업 공간 (할 일을 채팅으로 끌어 놓기)
  // 작업 카드: 지금 시작 · 일시 정지 · 완료 · 작업 작게 나누기 · 다른 추천. 같은 할 일의 이전 카드는 접는다.
  function work(taskId) {
    var t = M.byId(S.state.tasks, taskId);
    if (!t || t.deletedAt) return null;
    S.mutate(null, function (s) {
      (s.chat || []).forEach(function (m) { if (m.kind === 'work' && m.taskId === taskId && !m.closed) m.closed = 'moved'; });
    }, { source: 'chat', silent: true });
    return post({ kind: 'work', taskId: taskId, pin: true });
  }
  // ------------------------------------------------------------------ 채팅 명령 실행
  // commands.js 가 알아들은(또는 AI 가 돌려준) 명령을 실제로 한다. 대상 할 일이 없으면 묻는다.
  var VIEW_LABEL = { today: '오늘', archive: '보관함', tasks: '할 일', calendar: '캘린더', projects: '프로젝트', weekly: '주간 정리', settings: '설정' };
  function runCommand(c) {
    var A = DN.app;
    var t = c.taskId ? M.byId(S.state.tasks, c.taskId) : null;
    if ((DN.aiCommands.NEEDS_TASK[c.action] && !t) || c.missing) {
      post({ kind: 'text', text: typeof c.missing === 'string' ? '‘' + c.missing + '’라는 할 일을 찾지 못했어요. 할 일 목록에서 채팅으로 끌어 와 주시면 그 일로 할게요.'
        : '어떤 할 일인지 알려 주세요. 할 일을 채팅으로 끌어 와도 돼요.' });
      return;
    }
    switch (c.action) {
      case 'recommend': next(); break;
      case 'breakdown': breakdown(t ? t.id : null, null, { force: !!t }); break;
      case 'rest': rest(); break;
      case 'work': work(t.id); break;
      case 'start': A.startTask(t.id); work(t.id); break;
      case 'pause':
        if (t.status !== 'in_progress') post({ kind: 'text', text: '‘' + t.title + '’는 지금 진행 중이 아니에요.' });
        else { A.pauseTask(t.id); work(t.id); }   // 작업 카드에서 '이어서 할 첫 행동' 을 적을 수 있다
        break;
      case 'complete':
        if (t.status !== 'done') A.toggleDone(t.id);
        post({ kind: 'text', text: '‘' + t.title + '’ 완료했어요. 수고했어요!' });
        break;
      case 'return_todo': A.returnToTodo(t.id); post({ kind: 'text', text: '‘' + t.title + '’ 할 일로 돌려보냈어요.' }); break;
      case 'schedule': A.scheduleTask(t.id); break;
      case 'delete': A.deleteTask(t.id); post({ kind: 'text', text: '‘' + t.title + '’ 지웠어요. 알림의 되돌리기나 Ctrl+Z로 살릴 수 있어요.' }); break;
      case 'open':
        post({ kind: 'text', text: (VIEW_LABEL[c.view] || c.view) + ' 화면을 열었어요. 돌아오려면 사이드바의 ‘오늘’을 눌러 주세요.' });
        A.go(c.view);
        break;
      case 'search':
        if (DN.palette) DN.palette.open(c.query);
        break;
      case 'list_today': listToday(); break;
      case 'day_close': dayClose(); break;
    }
  }
  // "오늘 할 일 뭐야?" — 오늘 할 일을 채팅에 요약
  function listToday() {
    var n = now();
    var list = DN.aiCommands.todayTasks(S.state, n);
    var events = S.state.blocks.filter(function (b) { return b.kind === 'event' && DN.dates.ymd(b.start) === DN.dates.ymd(n) && new Date(b.end) > n; })
      .sort(function (a, b) { return a.start < b.start ? -1 : 1; });
    if (!list.length && !events.length) { post({ kind: 'text', text: '오늘은 남은 할 일도 일정도 없어요. 쉬어 가도 좋겠어요.' }); return; }
    var lines = [];
    if (list.length) {
      lines.push('오늘 할 일 ' + list.length + '개예요.');
      list.slice(0, 8).forEach(function (t) {
        var tag = t.status === 'in_progress' ? ' (진행 중)' : t.status === 'paused' ? ' (일시 정지)' : '';
        var due = t.dueDate ? ' · 마감 ' + DN.dates.relDay(t.dueDate, n) + (t.dueTime ? ' ' + t.dueTime : '') + ' · ' + DN.dates.remainText(DN.dates.dueAt(t.dueDate, t.dueTime), n) : '';
        lines.push('• ' + t.title + tag + due);
      });
      if (list.length > 8) lines.push('… 외 ' + (list.length - 8) + '개');
    }
    if (events.length) {
      lines.push('남은 일정: ' + events.map(function (b) { return DN.dates.hm(b.start) + ' ' + b.title; }).join(', '));
    }
    post({ kind: 'text', text: lines.join('\n'), actions: list.length ? ['next'] : [] });
  }

  // 지금 작업 공간에 올라 있는 할 일 — 가장 최근의 접히지 않은 작업 카드 (끝낸·지운 일은 빼고)
  function focusTask() {
    var chat = S.state.chat || [];
    for (var i = chat.length - 1; i >= 0; i--) {
      var m = chat[i];
      if (m.kind !== 'work' || m.closed) continue;
      var t = M.byId(S.state.tasks, m.taskId);
      if (t && !t.deletedAt && t.status !== 'done') return t;
    }
    return null;
  }
  // 작업 카드를 할 일 목록으로 끌어 놓으면 — 할 일로 돌려보내고 카드는 접는다
  function returnWork(msgId) {
    var m = M.byId(S.state.chat || [], msgId);
    if (!m || m.kind !== 'work') return;
    var t = M.byId(S.state.tasks, m.taskId);
    if (t && (t.status === 'in_progress' || t.status === 'paused')) DN.app.returnToTodo(t.id);
    update(msgId, { closed: 'returned' });
  }

  // opts.force: 사용자가 직접 '작업 작게 나누기' 를 눌렀다 — 작은 일이어도 AI 초안을 보여 준다 (고쳐서 쓰게)
  function breakdown(taskId, intro, opts) {
    var t = taskId ? M.byId(S.state.tasks, taskId) : pickTaskToBreak();
    if (!t) { post({ kind: 'text', text: '나눌 만한 할 일이 없어요.' }); return; }
    if (t.breakdown && (t.breakdown.status === 'pending' || t.breakdown.status === 'later') && t.breakdown.steps && t.breakdown.steps.length) {
      S.mutate(null, function (s) { AS.markShown(s, t.id, now()); }, { source: 'chat', silent: true });
      post({ kind: 'breakdown', taskId: t.id, intro: intro || null, draft: t.breakdown.steps.map(function (x) { return { title: x.title, minutes: x.minutes }; }) });
      return;
    }
    if (!aiReady()) {
      post({ kind: 'breakdown', taskId: t.id, intro: 'AI가 연결되어 있지 않아 직접 나눠 볼 수 있게 칸을 준비했어요.', draft: [{ title: '', minutes: 15 }, { title: '', minutes: null }, { title: '', minutes: null }] });
      return;
    }
    if (pending['bd:' + t.id]) return;
    pending['bd:' + t.id] = true;
    var wait = post({ kind: 'thinking', text: '‘' + t.title + '’를 작은 단계로 나눠 보는 중이에요…' });
    var proj = t.projectId && M.byId(S.state.projects, t.projectId);
    call(AS.BREAKDOWN.buildInput(t, { today: todayStr(), projectName: proj && proj.name })).then(function (res) {
      delete pending['bd:' + t.id];
      var v = res.ok ? AS.validateBreakdown(res.output) : null;
      if (!v || !v.ok) {
        update(wait.id, { kind: 'text', text: '단계를 나누지 못했어요. ' + (res.error ? res.error.message : '응답 형식이 맞지 않았어요.') + ' 직접 나눠 볼 수 있게 칸을 준비했어요.' });
        post({ kind: 'breakdown', taskId: t.id, draft: [{ title: '', minutes: 15 }, { title: '', minutes: null }] });
        return;
      }
      if (!v.isLarge && (opts && opts.force && v.steps.length)) v.isLarge = true;
      if (!v.isLarge) { update(wait.id, { kind: 'text', text: '‘' + t.title + '’는 이미 충분히 작은 일 같아요. 바로 시작해 봐도 좋겠어요.' }); return; }
      S.mutate(null, function (s) { AS.storeBreakdown(s, t.id, v, 'button', now()); AS.markShown(s, t.id, now()); }, { source: 'chat' });
      update(wait.id, { kind: 'breakdown', taskId: t.id, intro: intro || null, reason: v.reason, draft: v.steps });
    });
  }

  function applyBreakdown(msgId, taskId, steps) {
    var t = S.mutate('단계 나누기', function (s) { return AS.applyBreakdown(s, taskId, steps, now()); }, { source: 'chat' });
    if (!t) { DN.ui.toast('적을 단계가 없어요. 한 줄 이상 적어 주세요.'); return false; }
    update(msgId, { resolved: 'applied', resolvedCount: steps.filter(function (x) { return x.title && x.title.trim(); }).length });
    return true;
  }

  function deferBreakdown(msgId, taskId, mode) {
    S.mutate(mode === 'never' ? '단계 나누기 건너뜀' : null, function (s) { AS.deferBreakdown(s, taskId, mode, now()); }, { source: 'chat' });
    update(msgId, { resolved: mode === 'never' ? 'never' : 'later' });
  }

  // ------------------------------------------------------------------ 자세히 적기
  function elaborate(candidateIds, intro) {
    var cands = candidateIds ? candidateIds.map(function (id) { return M.byId(S.state.tasks, id); }).filter(Boolean) : AS.elaborateCandidates(S.state, now());
    if (!cands.length) { if (!candidateIds) post({ kind: 'text', text: '자세히 적어 둘 만한 할 일도 없어요. 잠깐 쉬어 가도 좋겠어요.', actions: ['rest'] }); return; }
    if (!aiReady()) { post({ kind: 'elaborate', intro: intro || null, picks: [AS.localElaboratePick(cands[0])] }); return; }
    if (pending.el) return;
    pending.el = true;
    var wait = post({ kind: 'thinking', text: '자세히 적어 두면 좋을 할 일을 찾는 중이에요…' });
    call(AS.ELABORATE.buildInput(cands, { today: todayStr() })).then(function (res) {
      delete pending.el;
      var v = res.ok ? AS.validateElaborate(res.output, cands.map(function (t) { return t.id; })) : null;
      var picks = v && v.ok && v.picks.length ? v.picks : [AS.localElaboratePick(cands[0])];
      update(wait.id, { kind: 'elaborate', intro: intro || null, picks: picks });
    });
  }

  function saveElaboration(msgId, taskId, text) {
    var t = S.mutate('할 일 자세히 적기', function (s) { return AS.saveElaboration(s, taskId, text, now()); }, { source: 'chat' });
    if (!t) return false;
    var m = M.byId(S.state.chat, msgId);
    var done = Object.assign({}, (m && m.done) || {}); done[taskId] = 'saved';
    update(msgId, { done: done });
    return true;
  }
  function skipElaboration(msgId, taskId) {
    S.mutate(null, function (s) { AS.skipElaboration(s, taskId, now()); }, { source: 'chat' });
    var m = M.byId(S.state.chat, msgId);
    var done = Object.assign({}, (m && m.done) || {}); done[taskId] = 'skipped';
    update(msgId, { done: done });
  }

  // ------------------------------------------------------------------ 휴식
  // ------------------------------------------------------------------ 연구 기반 도움들 (src/core/habits.js)
  // 하루 마무리 — 오늘 끝낸 일을 보여 주고(작은 성취), 남은 일마다 다음 시각을 정한다(계획이 잔상을 없앤다)
  function dayClose() {
    var HB = DN.habits;
    var r = HB.dayClose(S.state, now(), DN.aiCommands.todayTasks(S.state, now()));
    S.mutate(null, function (s) { s.meta.dayCloseOffered = DN.dates.ymd(now()); }, { source: 'chat', silent: true });
    post({ kind: 'dayclose', doneIds: r.done.map(function (t) { return t.id; }), taskIds: r.left.map(function (t) { return t.id; }), picked: {} });
  }
  // 밀린 일 — 탓하지 않고 한 번에 다시 정하기 (자기 용서가 다음 미루기를 줄인다)
  function overdueOffer() {
    var list = DN.habits.overdueTasks(S.state, now());
    if (!list.length) { post({ kind: 'text', text: '밀린 일이 없어요.' }); return; }
    post({ kind: 'overdue', taskIds: list.map(function (t) { return t.id; }) });
  }
  function replan(taskIds, intro) { post({ kind: 'dayclose', replan: true, intro: intro || null, doneIds: [], taskIds: taskIds, picked: {} }); }
  // 새 주 시작 — 이번 주 꼭 끝낼 일 3가지 (새 출발 효과)
  function weekStart() {
    var open = M.liveTasks(S.state).filter(function (t) { return t.status !== 'done'; })
      .sort(function (a, b) { return (a.dueDate || '9999') < (b.dueDate || '9999') ? -1 : 1; }).slice(0, 10);
    S.mutate(null, function (s) { s.meta.weekStartOffered = DN.habits.weekKey(now()); }, { source: 'chat', silent: true });
    if (open.length) post({ kind: 'weekstart', taskIds: open.map(function (t) { return t.id; }) });
  }
  // 할 일 하나를 정한 때에 놓는다 — 그때부터 빈 시간에 (예상 시간, 없으면 30분)
  function planAt(taskId, at) {
    var t = M.byId(S.state.tasks, taskId);
    if (!t) return null;
    var minutes = Math.max(15, Math.min(240, t.estimateMinutes || 30));
    var start = DN.views.schedule.findFreeSlot(S.state, at, minutes);
    S.mutate('다음 시각 정하기', function (s) {
      M.addBlock(s, { taskId: taskId, kind: 'work', start: start.toISOString(), end: DN.dates.addMinutes(start, minutes).toISOString(), origin: 'user' });
    });
    return start;
  }
  // 오래 집중했으면 쉬어 가기 권하기 (50분, 미세 휴식) — 쓰는 중·일정 중에는 묻지 않는다
  function checkLongFocus() {
    var t = DN.habits.longFocus(S.state, now());
    if (!t) return;
    var last = S.state.meta.lastRestNudgeAt;
    if (last && now() - new Date(last) < DN.habits.LONG_FOCUS_MIN * 60000) return;
    var input = document.querySelector('.chat-input textarea');
    if (input && document.activeElement === input && input.value.trim()) return;
    if (!DN.app || DN.app.current().view !== 'today') return;
    S.mutate(null, function (s) { s.meta.lastRestNudgeAt = now().toISOString(); }, { source: 'chat', silent: true });
    post({ kind: 'text', text: '‘' + t.title + '’에 ' + DN.habits.LONG_FOCUS_MIN + '분 넘게 집중했어요. 5분만 쉬어 가면 다음 집중이 더 잘 돼요.' });
    rest();
  }

  function rest() {
    post({ kind: 'rest', stretches: AS.pickStretches(3, Date.now()), timerEnd: null });
  }
  function startTimer(msgId, minutes) {
    var end = new Date(Date.now() + minutes * 60000).toISOString();
    update(msgId, { timerEnd: end, timerDone: false });
    setTimeout(function () { finishTimer(msgId); }, minutes * 60000 + 200);
  }
  function finishTimer(msgId) {
    var m = M.byId(S.state.chat || [], msgId);
    if (!m || m.timerDone || !m.timerEnd || new Date(m.timerEnd) > new Date(Date.now() + 1000)) return;
    update(msgId, { timerDone: true });
    post({ kind: 'text', text: '휴식 끝! 다시 시작해 볼까요?', actions: ['next'] });
    DN.ui.toast('5분 휴식이 끝났어요.');
  }

  // ------------------------------------------------------------------ 자동 제안 ("잠깐 여유 있을 때")
  function tryNudge(reason) {
    if (!DN.app || DN.app.current().view !== 'today') return;
    var input = document.querySelector('.chat-input textarea');
    if (input && document.activeElement === input && input.value.trim()) return;   // 쓰는 중에는 끼어들지 않는다
    var cal = R.calendarContext(S.state, now());
    if (cal.busyWith) return;                                                         // 일정 중에는 묻지 않는다
    var lastCaptureAt = S.state.notes.reduce(function (m, x) { return x.capture && x.capture.at && x.capture.at > m ? x.capture.at : m; }, '') || null;
    var nowD = now(), today = DN.dates.ymd(nowD), meta = S.state.meta;
    var recentCapture = lastCaptureAt && nowD - new Date(lastCaptureAt) < 10 * 60000;
    if (reason === 'open' && !recentCapture) {
      if (DN.habits.shouldOfferWeekStart(S.state, nowD) && nowD.getDay() >= 1 && nowD.getDay() <= 3) { weekStart(); return; }
      if (meta.overdueOffered !== today && DN.habits.overdueTasks(S.state, nowD).length >= 3) {
        S.mutate(null, function (s) { s.meta.overdueOffered = today; }, { source: 'chat', silent: true });
        overdueOffer(); return;
      }
    }
    // 저녁(17:30 이후) 여유 있을 때 하루에 한 번 — 하루 마무리
    if ((reason === 'idle' || reason === 'open') && !recentCapture && meta.dayCloseOffered !== today &&
        nowD.getHours() * 60 + nowD.getMinutes() >= 17 * 60 + 30 && DN.aiCommands.todayTasks(S.state, nowD).length) {
      post({ kind: 'text', text: '하루를 마무리할 시간이에요. 남은 일에 다음 시각을 정해 두면 마음 편히 쉴 수 있어요.' });
      dayClose(); return;
    }
    var n = AS.nextNudge(S.state, { now: now(), reason: reason, lastNudgeAt: S.state.meta.lastNudgeAt, lastCaptureAt: lastCaptureAt });
    if (!n) return;
    S.mutate(null, function (s) { s.meta.lastNudgeAt = now().toISOString(); }, { source: 'chat', silent: true });
    var intro = reason === 'completed' ? '하나 끝내셨네요. 한숨 돌리는 김에 —' : reason === 'idle' ? '잠깐 여유가 있어 보여서요 —' : '다시 오셨네요 —';
    if (n.type === 'breakdown') breakdown(n.taskId, intro + ' 아까 큰 일로 보여서 나눠 둔 단계가 있어요. 이렇게 세분화해 보면 어떨까요?');
    else elaborate(n.candidates, intro + ' 할 일 중에 조금 더 자세히 적어 두면 시작하기 쉬운 게 있어요.');
  }

  var watching = false;
  var quickKey = null;   // 빠른 메모 단축키 (데스크톱 앱에서 등록됐을 때만)
  function watch() {
    if (watching) return;
    watching = true;
    ['keydown', 'mousedown', 'wheel'].forEach(function (ev) { document.addEventListener(ev, function () { lastActivity = Date.now(); }, true); });
    S.subscribe(function (info) {
      if (info.label === '완료') setTimeout(function () { tryNudge('completed'); }, 1500);
    });
    setInterval(function () {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastActivity >= IDLE_MIN * 60000) { lastActivity = Date.now(); tryNudge('idle'); }
    }, 30000);
    setTimeout(function () { tryNudge('open'); }, 8000);
    setInterval(function () { if (document.visibilityState === 'visible') checkLongFocus(); }, 60000);
    // 빠른 메모 창(Ctrl+Shift+Space)에서 보낸 글 — 홈 입력과 똑같이 흐름에 올리고 분류한다
    var host = S.host;
    if (host.onQuickCapture) host.onQuickCapture(function (text) { if (text.trim()) send(text); });
    if (host.setCloseToTray) host.setCloseToTray(S.state.prefs.closeToTray !== false);
    if (host.ready) host.ready().then(function (r) { quickKey = r && r.quickKey; }).catch(function () {});
    // 꺼져 있는 동안 끝난 휴식 타이머 정리
    (S.state.chat || []).forEach(function (m) { if (m.kind === 'rest' && m.timerEnd && !m.timerDone) setTimeout(function () { finishTimer(m.id); }, Math.max(0, new Date(m.timerEnd) - Date.now()) + 200); });
  }

  document.addEventListener('DOMContentLoaded', function () {
    S.whenReady(watch);
  });

  DN.assistant = {
    send: send, next: next, breakdown: breakdown, applyBreakdown: applyBreakdown, deferBreakdown: deferBreakdown,
    elaborate: elaborate, saveElaboration: saveElaboration, skipElaboration: skipElaboration,
    rest: rest, startTimer: startTimer, tryNudge: tryNudge, update: update, post: post, work: work, returnWork: returnWork, focusTask: focusTask, runCommand: runCommand,
    dayClose: dayClose, overdueOffer: overdueOffer, replan: replan, weekStart: weekStart, planAt: planAt, checkLongFocus: checkLongFocus,
    quickKey: function () { return quickKey; }
  };
})();
