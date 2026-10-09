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
    post({ role: 'user', kind: 'text', text: text });
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

  function breakdown(taskId, intro) {
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
    rest: rest, startTimer: startTimer, tryNudge: tryNudge, update: update, post: post,
    quickKey: function () { return quickKey; }
  };
})();
