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
  function submit(text, projectId, onDone) {
    text = String(text || '').trim();
    if (!text) return null;
    var note = S.mutate('입력 저장', function (s) {
      return M.addNote(s, {
        title: '', body: text, projectId: projectId || null,
        captureRole: 'memo', capture: { status: 'pending', at: now().toISOString(), entryType: null, created: [] }
      }, now());
    }, { source: 'capture' });
    classify(note.id).then(function (r) { if (onDone) onDone(r, note.id); });
    return note;
  }

  function classify(noteId) {
    var note = M.byId(S.state.notes, noteId);
    if (!note || inflight[noteId]) return Promise.resolve(null);
    var st = DN.aiFlow.status();
    if (!st.configured) {
      setCapture(noteId, { status: 'no_ai', reason: st.reason || 'AI가 연결되어 있지 않습니다.' });
      notify();
      return Promise.resolve({ ok: false, reason: 'not_configured' });
    }
    var sent = JSON.parse(JSON.stringify(note));
    var input = C.buildInput(sent, DN.aiFlow.contextOpts(sent));
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
      var t = now();
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
      var cap;
      S.mutate('AI 분류', function (s) {
        var r = M.byId(s.aiRuns, run.id);
        Object.assign(r, { provider: res.provider || r.provider, model: res.model || r.model });
        P.finishRun(s, run.id, { status: 'succeeded', rawOutput: res.raw || JSON.stringify(res.output), usage: res.usage || null, dropped: v.dropped }, t);
        cap = P.applyCapture(s, { note: sent, run: r, validated: v, output: res.output }, t);
      }, { source: 'capture' });
      notify();
      return { ok: true, capture: cap };
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
