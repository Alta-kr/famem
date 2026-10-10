'use strict';

// 오늘 화면 입력창 — 적은 글을 AI 가 메모/할 일로 나눠 바로 반영한다.
//
//   1) 적은 글은 AI 와 상관없이 먼저 메모로 저장한다 (원문 보존, 실패해도 잃지 않음)
//   2) AI 가 메모인지 할 일인지, 어느 프로젝트인지 판단 → 앱이 검증 → 바로 반영
//   3) 결과는 '방금 적은 것' 에 보이고, 한 번에 메모↔할 일, 프로젝트를 바꿀 수 있다
//   AI 가 없거나 실패하면 메모로 남기고 "할 일로 바꾸기 / 다시 시도" 를 준다.
//   명령어(/할일 …)로 적은 글은 저장하는 순간 그 종류로 바로 만들고, AI 는 제목·날짜만 다듬는다(ai/forced.js).
//   사용자가 고친 방식(adapt.js)은 AI 힌트로 보내고, 확실한 규칙은 정리가 끝난 뒤 배운 대로 적용한다.

(function () {
  var DN = window.Daynote;
  var M = DN.model, S = DN.store;
  var C = DN.aiCapture, V = DN.aiValidate, P = DN.aiProposals;
  var inflight = {};
  var listeners = [];

  function now() { return DN.app.now(); }
  function notify() { listeners.forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } }); }
  function forced() { var F = DN.aiForced; return F && typeof F.createForced === 'function' ? F : null; }

  function setCapture(noteId, patch, label) {
    S.mutate(label || null, function (s) {
      var n = M.byId(s.notes, noteId);
      if (n) n.capture = Object.assign({}, n.capture || {}, patch);
    }, { source: 'capture' });
  }

  // 입력 저장 + 분류 시작. 저장된 메모를 바로 돌려준다 (분류는 뒤에서 진행, 끝나면 onDone(result)).
  // opts = { command?: CMD.parse 결과(종류 명령), statusLine?: 상태 보고 줄, statusHint?: 상태 제안 }
  // submit 은 명령어를 해석하지 않는다 — 받은 본문을 그대로 저장한다.
  function submit(text, projectId, onDone, opts) {
    opts = opts || {};
    text = String(text || '').trim();
    if (!text) return null;
    var cmd = opts.command, F = forced();
    var note;
    if (cmd && cmd.kind && F) {
      var id = M.uid('note');
      if (DN.aiFlow.status().configured) inflight[id] = true;   // 첫 그림부터 '다듬는 중' 이 되게
      note = S.mutate('입력 저장', function (s) {
        var n = M.addNote(s, {
          id: id, title: '', body: text, projectId: projectId || null, captureRole: 'memo',
          capture: {
            status: 'pending', at: now().toISOString(), entryType: null, created: [],
            command: { name: cmd.command, kind: cmd.kind, token: cmd.token, raw: cmd.raw }
          }
        }, now());
        F.createForced(s, n, now());                          // 같은 되돌리기 단계 안에서 항목을 바로 만든다
        return n;
      }, { source: 'capture' });
      classify(note.id, { starting: true }).then(function (r) { if (onDone) onDone(r, note.id); });
      return note;
    }
    note = S.mutate('입력 저장', function (s) {
      return M.addNote(s, {
        title: '', body: text, projectId: projectId || null, captureRole: 'memo',
        capture: {
          status: 'pending', at: now().toISOString(), entryType: null, created: [],
          statusLine: opts.statusLine || null, statusHint: opts.statusHint || null
        }
      }, now());
    }, { source: 'capture' });
    classify(note.id).then(function (r) { if (onDone) onDone(r, note.id); });
    return note;
  }

  // AI 없이 배운 대로 — 확실한 규칙이 있으면 '배운 대로 정리' 한 단계로 적용한다 (명령어 글은 제외)
  function applyLearnedOffline(noteId) {
    if (!DN.adapt || typeof P.planLearned !== 'function' || typeof P.applyLearned !== 'function') return;
    var pl = P.planLearned(S.state, noteId, now(), { hinted: [] });
    if (pl && (pl.kind || pl.project || (pl.dates && pl.dates.length))) {
      S.mutate('배운 대로 정리', function (s) { P.applyLearned(s, noteId, now(), { hinted: [] }); }, { source: 'capture' });
    }
  }

  function classify(noteId, opts) {
    var note = M.byId(S.state.notes, noteId);
    if (!note || (inflight[noteId] && !(opts && opts.starting))) return Promise.resolve(null);
    var st = DN.aiFlow.status();
    var isCmd = !!(note.capture && note.capture.command);
    if (!st.configured) {
      delete inflight[noteId];
      setCapture(noteId, { status: 'no_ai', reason: st.reason || 'AI가 연결되어 있지 않아요.' });
      notify();
      if (isCmd) return Promise.resolve({ ok: false, reason: 'not_configured' });
      // '배운 대로 정리' 는 보낸 쪽이 결과 카드를 흐름에 올린 뒤(다음 마이크로태스크)에 한다 —
      // 같은 순간에 하면 되돌리기 스냅숏에 카드가 없어서 Ctrl+Z 가 카드까지 지운다
      return Promise.resolve().then(function () {
        try { applyLearnedOffline(noteId); } catch (e) { console.error(e); }
        notify();
        return { ok: false, reason: 'not_configured' };
      });
    }
    var sent = JSON.parse(JSON.stringify(note));
    var AD = DN.adapt, SU = DN.status, F = forced();
    isCmd = !!(sent.capture && sent.capture.command);
    var hints = (!isCmd && AD && AD.enabled && AD.hints && AD.enabled(S.state))
      ? AD.hints(S.state, sent.body, now(), { projects: M.liveProjects(S.state) }) : [];
    var copts = DN.aiFlow.contextOpts(sent);
    copts.learned = hints;
    copts.contexts = SU && SU.contextsForAi ? SU.contextsForAi() : [];
    copts.presenceNow = SU && SU.presenceForAi ? SU.presenceForAi() : null;
    copts.statusLine = (sent.capture && sent.capture.statusLine) || null;
    var input = C.buildInput(sent, copts);
    var hintIds = [].concat.apply([], hints.map(function (h) { return h.ruleIds || []; }));

    inflight[noteId] = true;
    var run = S.mutate(null, function (s) {
      var n = M.byId(s.notes, noteId);
      if (n) n.capture = Object.assign({}, n.capture, { status: 'pending', error: null });
      var r = P.startRun(s, {
        kind: 'capture', noteId: noteId, noteHash: P.noteHash(sent), promptVersion: C.PROMPT_VERSION,
        provider: st.provider, model: st.model, hints: hintIds
      }, now());
      if (hints.length && AD && AD.count) AD.count(s, 'hinted');
      return r;
    }, { source: 'capture' });
    notify();

    return S.host.ai.organizeNote(input).catch(function (e) {
      return { ok: false, error: { type: 'ipc', message: e && e.message ? e.message : String(e), retryable: true } };
    }).then(function (res) {
      delete inflight[noteId];
      var t = now();
      // 기다리는 사이 '입력 저장'을 되돌려 메모·실행 기록이 사라졌으면 아무것도 쓰지 않는다
      if (!M.byId(S.state.notes, noteId) || !M.byId(S.state.aiRuns || [], run.id)) { notify(); return { ok: false, reason: 'gone' }; }
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
      function finish(s) {
        var r = M.byId(s.aiRuns, run.id);
        Object.assign(r, { provider: res.provider || r.provider, model: res.model || r.model });
        P.finishRun(s, run.id, { status: 'succeeded', rawOutput: res.raw || JSON.stringify(res.output), usage: res.usage || null, dropped: v.dropped }, t);
        return r;
      }
      if (isCmd) {
        S.mutate('AI 다듬기', function (s) {
          var r = finish(s);
          if (F && typeof F.refineForced === 'function') cap = F.refineForced(s, { note: sent, run: r, validated: v, output: res.output }, t);
          else {   // 다듬기 모듈이 없으면 항목은 그대로 두고 끝난 것으로만 적는다
            var n = M.byId(s.notes, noteId);
            if (n) cap = n.capture = Object.assign({}, n.capture, { status: 'done', error: null, runId: r.id, doneAt: t.toISOString() });
          }
        }, { source: 'capture' });
      } else {
        S.mutate('AI 분류', function (s) {
          var r = finish(s);
          cap = P.applyCapture(s, { note: sent, run: r, validated: v, output: res.output }, t);
          if (typeof P.applyLearned === 'function') P.applyLearned(s, sent.id, t, { hinted: hintIds });
        }, { source: 'capture' });
      }
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
    S.mutate('프로젝트 바꾸기', function (s) { P.captureSetProject(s, noteId, projectId, now()); }, { source: 'capture' });
  }

  // 결과 카드의 날짜 칩 — ref: { kind:'task'|'block', id }. ymd: 'YYYY-MM-DD' | null(날짜 없음, 할 일만). time: 'HH:MM' | null
  function setDate(noteId, ref, ymd, time) {
    if (!ref) return;
    var label = ref.kind === 'task' ? (ymd ? '마감일 바꾸기' : '마감일 지우기') : '일정 옮기기';
    S.mutate(label, function (s) {
      if (typeof P.captureSetDate === 'function') { P.captureSetDate(s, noteId, ref, ymd, time, now()); return; }
      legacySetDate(s, ref, ymd, time, now());
    }, { source: 'capture' });
  }
  // captureSetDate 가 아직 없을 때(부분 병합) — 예전 chat.js 동작 그대로. 배우지는 않는다
  function legacySetDate(s, ref, ymd, time, t) {
    var D = DN.dates;
    if (ref.kind === 'task') { M.updateTask(s, ref.id, ymd ? { dueDate: ymd } : { dueDate: null, dueTime: null }, t); return; }
    var b = M.byId(s.blocks, ref.id);
    if (!b || !ymd) return;
    var start = new Date(b.start), end = new Date(b.end);
    var len = Math.max(15, Math.round((end - start) / 60000)) || 60;
    var ns = D.parseYmd(ymd, time || D.hm(start));
    var patch = { start: ns.toISOString(), end: D.addMinutes(ns, len).toISOString() };
    if (time) patch.timeUncertain = false;
    M.updateBlock(s, b.id, patch);
  }

  // 배운 규칙 하나 지우기 (결과 카드의 [왜?] · 설정의 ×)
  function forgetRule(ruleId, label) {
    if (!DN.adapt || !ruleId) return;
    S.mutate('배운 것 지우기', function (s) { DN.adapt.forget(s, ruleId); }, { source: 'learn' });
    DN.ui.undoToast('‘' + (label || '') + '’ 규칙을 지웠어요.');
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

  // 시작할 때 한 번 — 예전 교정에서 씨앗 뿌리기, 하루 한 번 규칙 정리 (저장만, 다시 그리지 않음)
  document.addEventListener('DOMContentLoaded', function () {
    S.whenReady(function () {
      var AD = DN.adapt;
      if (!AD || !AD.bootstrap || !AD.compact) return;
      try {
        S.mutate(null, function (s) {
          var t = now();
          AD.bootstrap(s, t);
          var L = s.learned || {};
          if (!L.compactedAt || t - new Date(L.compactedAt) > DN.dates.DAY) AD.compact(s, t);
        }, { silent: true });
      } catch (e) { console.error(e); }
    });
  });

  DN.capture = {
    submit: submit, classify: classify, toMemo: toMemo, toTask: toTask, setProject: setProject, today: today,
    setKind: setKind, setItemKind: setItemKind, removeItem: removeItem, items: items, KIND_LABEL: KIND_LABEL,
    setDate: setDate, forgetRule: forgetRule,
    isRunning: function (id) { return !!inflight[id]; },
    onChange: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; }
  };
})();
