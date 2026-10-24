'use strict';

// 오늘 화면 입력창 — 적은 글을 AI 가 메모/할 일로 나눠 바로 반영한다.
//
//   1) 적은 글은 AI 와 상관없이 먼저 메모로 저장한다 (원문 보존, 실패해도 잃지 않음)
//   2) AI 가 메모인지 할 일인지, 어느 프로젝트인지 판단 → 앱이 검증 → 바로 반영
//   3) 결과는 '방금 적은 것' 에 보이고, 한 번에 메모↔할 일, 프로젝트를 바꿀 수 있다
//   AI 가 없거나 실패하면 메모로 남기고 "할 일로 바꾸기 / 다시 시도" 를 준다.

(function () {
  var DN = window.Daynote;
  var M = DN.model, S = DN.store;
  var C = DN.aiCapture, V = DN.aiValidate, P = DN.aiProposals;
  var inflight = {};
  var listeners = [];

  function now() { return DN.app.now(); }
  function notify() { listeners.forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } }); }

  function setCapture(noteId, patch, label) {
    S.mutate(label || null, function (s) {
      var n = M.byId(s.notes, noteId);
      if (n) n.capture = Object.assign({}, n.capture || {}, patch);
    }, { source: 'capture' });
  }

  // 입력 저장 + 분류 시작. 저장된 메모를 바로 돌려준다 (분류는 뒤에서 진행, 끝나면 onDone(result)).
  //   저장·AI 정리는 되돌리기 칸을 만들지 않는다. opts.join: AI 가 실행한 명령을 묶을 이름표 (명령만 되돌릴 수 있다)
  var joinKey = {};
  function submit(text, projectId, onDone, opts) {
    text = String(text || '').trim();
    if (!text) return null;
    var key = (opts && opts.join) || M.uid('cap');
    var note = S.mutate(null, function (s) {
      return M.addNote(s, {
        title: '', body: text, projectId: projectId || null,
        captureRole: 'memo', capture: { status: 'pending', at: now().toISOString(), entryType: null, created: [] }
      }, now());
    }, { source: 'capture' });
    joinKey[note.id] = key;
    // 채팅(홈 입력·빠른 메모 창)에서 보낸 글만 명령으로 실행한다. Ctrl+N 메모 창은 늘 메모로 지킨다
    if (onDone) S.mutate(null, function (s) { var n = M.byId(s.notes, note.id); if (n) n.capture.viaChat = true; }, { source: 'capture', silent: true });
    classify(note.id).then(function (r) { if (onDone) onDone(r, note.id); });
    return note;
  }

  // 기다리는 사람이 없는 '정리 중' 풀기 — 되돌리기·다시 실행으로 정리 도중 상태가 돌아왔거나 앱이 정리 중에 닫혔을 때.
  //   다시 정리하지는 않는다 (되돌린 것을 다시 하지 않게) — '메모로 남겨 뒀어요 · [다시 시도]' 로
  function settleOrphans(why) {
    var msg = why === 'load' ? '앱이 닫혀 정리가 끝나지 않았어요.' : '되돌리기로 정리를 멈췄어요.';
    var stuck = S.state.notes.filter(function (n) { return n.capture && n.capture.status === 'pending' && !inflight[n.id]; });
    var runs = (S.state.aiRuns || []).filter(function (r) {
      return r.status === 'running' && !(r.kind === 'capture' ? inflight[r.noteId] : DN.aiFlow && DN.aiFlow.isRunning(r.noteId));
    });
    if (!stuck.length && !runs.length) return;
    S.mutate(null, function (s) {
      stuck.forEach(function (x) {
        var n = M.byId(s.notes, x.id);
        if (n) n.capture = Object.assign({}, n.capture, { status: 'failed', error: { type: 'interrupted', message: msg, retryable: true } });
      });
      runs.forEach(function (x) { P.finishRun(s, x.id, { status: 'failed', error: { type: 'interrupted', message: msg, retryable: true } }, now()); });
    }, { source: 'capture' });
  }
  S.subscribe(function (info) { if (info.type === 'undo' || info.type === 'redo' || info.type === 'load') settleOrphans(info.type); });

  // copts.moveToTask: 할 일 목록으로 끌어 놓은 메모 · copts.join: 이 정리를 합칠 되돌리기 칸
  function classify(noteId, copts) {
    copts = copts || {};
    if (copts.join) joinKey[noteId] = copts.join;
    var note = M.byId(S.state.notes, noteId);
    if (!note || inflight[noteId]) return Promise.resolve(null);
    var st = DN.aiFlow.status();
    if (!st.configured) {
      setCapture(noteId, { status: 'no_ai', reason: st.reason || 'AI가 연결되어 있지 않습니다.' });
      notify();
      return Promise.resolve({ ok: false, reason: 'not_configured' });
    }
    var sent = JSON.parse(JSON.stringify(note));
    var opts = DN.aiFlow.contextOpts(sent);
    // 작업 공간(채팅)에 올려 둔 할 일이 있으면 "마감 두 시간 후로 미뤄줘" 의 대상이 된다
    var focus = DN.assistant && DN.assistant.focusTask && DN.assistant.focusTask();
    if (focus) { opts.focusTask = focus.title; opts.focusInfo = DN.aiFlow.taskInfo(S.state, focus); }
    if (copts.moveToTask) opts.moveToTask = true;
    // 방금 정리한 것 — "아니 오후 8시야" 처럼 고치는 말의 대상
    opts.recent = P.recentLines(S.state, now()).filter(function (l) { return l; });
    var input = C.buildInput(sent, opts);
    var run = S.mutate(null, function (s) {
      var n = M.byId(s.notes, noteId);
      if (n) n.capture = Object.assign({}, n.capture, { status: 'pending', error: null });
      return P.startRun(s, { kind: 'capture', noteId: noteId, noteHash: P.noteHash(sent), promptVersion: C.PROMPT_VERSION, provider: st.provider, model: st.model }, now());
    }, { source: 'capture' });
    inflight[noteId] = true;
    notify();

    return S.host.ai.organizeNote(input).catch(function (e) {
      return { ok: false, error: { type: 'ipc', message: e && e.message ? e.message : String(e), retryable: true } };
    }).then(function (res) {
      delete inflight[noteId];
      DN.aiFlow.recordUsage(res);
      DN.aiFlow.recordExchange(input, res);
      var t = now();
      var key = joinKey[noteId]; delete joinKey[noteId];
      // 기다리는 사이 Ctrl+Z 로 보낸 글을 되돌렸으면 늦게 온 결과는 버린다 (지운 글에 할 일이 생기지 않게)
      var live = M.byId(S.state.notes, noteId);
      if (!live || live.deletedAt || !live.capture || live.capture.status !== 'pending' || !M.byId(S.state.aiRuns || [], run.id)) {
        notify();
        return { ok: false, reason: 'undone' };
      }
      if (!res.ok) {
        S.mutate(null, function (s) {
          P.finishRun(s, run.id, { status: 'failed', error: res.error, rawOutput: res.raw || null }, t);
          var n = M.byId(s.notes, noteId);
          if (n) n.capture = Object.assign({}, n.capture, { status: 'failed', error: res.error });
        }, { source: 'capture' });
        notify();
        return { ok: false, reason: 'failed', error: res.error };
      }
      var v = V.validateOrganizeNote(res.output, { note: sent, state: S.state, now: t });
      if (!v.ok) {
        S.mutate(null, function (s) {
          var err = { type: 'invalid_output', message: 'AI 응답 형식이 맞지 않아 쓰지 않았어요.', retryable: true };
          P.finishRun(s, run.id, { status: 'invalid', error: err, rawOutput: res.raw || null }, t);
          var n = M.byId(s.notes, noteId);
          if (n) n.capture = Object.assign({}, n.capture, { status: 'failed', error: err });
        }, { source: 'capture' });
        notify();
        return { ok: false, reason: 'invalid' };
      }
      var cap, cmds = [];
      S.mutate(null, function (s) {
        var r = M.byId(s.aiRuns, run.id);
        Object.assign(r, { provider: res.provider || r.provider, model: res.model || r.model });
        P.finishRun(s, run.id, { status: 'succeeded', rawOutput: res.raw || JSON.stringify(res.output), usage: res.usage || null, dropped: v.dropped }, t);
        // 채팅 명령 — 근거·대상을 확인한 것만, 채팅에서 보낸 글일 때만 (실행은 아래에서)
        cmds = sent.capture && sent.capture.viaChat ? DN.aiCommands.resolve(s, sent, res.output.commands, focus) : [];
        cap = P.applyCapture(s, { note: sent, run: r, validated: v, output: res.output, commands: cmds }, t);
      }, { source: 'capture' });
      notify();
      if (cmds.length && DN.assistant && DN.assistant.runCommand) S.withJoin(key, function () {
        // 할 일 상태를 바꾸는 명령(완료·삭제 …)은 바로 하지 않고 대상과 바뀌는 내용을 보여 주고 묻는다
        cmds.forEach(function (c) { if (DN.assistant.needsConfirm(c)) DN.assistant.askCommand(c); else DN.assistant.runCommand(c); });
      });
      return { ok: true, capture: cap, commands: cmds };
    });
  }

  function toMemo(noteId) {
    S.mutate('메모로 바꾸기', function (s) { P.captureToMemo(s, noteId, now()); }, { source: 'capture' });
  }
  function toTask(noteId) {
    return S.mutate('할 일로 바꾸기', function (s) { return P.captureToTask(s, noteId, now()); }, { source: 'capture' });
  }
  function setProject(noteId, projectId) {
    S.mutate('프로젝트 바꾸기', function (s) { P.captureSetProject(s, noteId, projectId); }, { source: 'capture' });
  }

  // 결과 카드에서 고치기 — 종류 바꾸기(할 일/일정/메모/아이디어/링크), 한 줄 빼기
  var KIND_LABEL = { task: '할 일', event: '일정', memo: '메모', idea: '아이디어', link: '링크' };
  function setKind(noteId, kind) {
    S.mutate(KIND_LABEL[kind] ? KIND_LABEL[kind] + '(으)로 바꾸기' : '종류 바꾸기', function (s) { P.captureSetKind(s, noteId, kind, now()); }, { source: 'capture' });
  }
  function setItemKind(noteId, ref, kind) {
    S.mutate(KIND_LABEL[kind] ? KIND_LABEL[kind] + '(으)로 바꾸기' : '종류 바꾸기', function (s) { P.captureSetItemKind(s, noteId, ref, kind, now()); }, { source: 'capture' });
  }
  function removeItem(noteId, ref) {
    S.mutate('정리 결과에서 빼기', function (s) { P.captureRemoveItem(s, noteId, ref, now()); }, { source: 'capture' });
  }
  function items(note) { return P.captureItems(S.state, note); }

  // 오늘 적은 것 (최근 순)
  function today() {
    var d = DN.dates.ymd(now());
    return S.state.notes.filter(function (n) {
      return !n.deletedAt && n.capture && n.capture.at && DN.dates.ymd(n.capture.at) === d;
    }).sort(function (a, b) { return a.capture.at < b.capture.at ? 1 : -1; });
  }

  DN.capture = {
    submit: submit, classify: classify, toMemo: toMemo, toTask: toTask, setProject: setProject, today: today,
    setKind: setKind, setItemKind: setItemKind, removeItem: removeItem, items: items, KIND_LABEL: KIND_LABEL,
    isRunning: function (id) { return !!inflight[id]; },
    onChange: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; }
  };
})();
