'use strict';

// "AI 정리" 실행 흐름 — 화면 쪽 조정자.
//   메모 → (바뀌지 않았으면 지난 결과 재사용) → 메인 프로세스 AI 호출 → 검증 → 초안 병합
// AI 결과는 proposals·noteDigests 에만 들어간다. 할 일·일정은 사용자가 검토 패널에서 고른 것만 만들어진다.

(function () {
  var DN = window.Daynote;
  var M = DN.model, D = DN.dates, S = DN.store;
  var O = DN.aiOrganize, V = DN.aiValidate, P = DN.aiProposals;

  var status = { configured: false, provider: null, model: null, reason: '확인 중…' };
  var inflight = {};
  var listeners = [];

  function notify() { listeners.forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } }); }

  function loadStatus() {
    var host = S.host;
    if (!host.ai) { status = { configured: false, reason: '이 환경에서는 AI를 쓸 수 없습니다.' }; notify(); return Promise.resolve(status); }
    return host.ai.status().then(function (s) { status = s; notify(); return s; });
  }

  function contextOpts(note) {
    var st = S.state, now = DN.app.now();
    return {
      noteHash: P.noteHash(note),
      today: D.ymd(now) + ' (' + D.WEEKDAYS[now.getDay()] + ')',
      timezone: (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'Asia/Seoul',
      projects: M.liveProjects(st).map(function (p) { return p.name; }),
      openTasks: M.liveTasks(st).filter(function (t) { return t.status !== 'done'; }).map(function (t) { return t.title; })
    };
  }
  function buildInput(note) { return O.buildInput(note, contextOpts(note)); }

  // 검증 + 병합. note 는 AI 에 보낸 시점의 메모(근거 확인 기준), 이후 지금 메모로 stale 를 맞춘다.
  function applyOutput(run, sentNote, output, now) {
    var v = V.validateOrganizeNote(output, { note: sentNote, state: S.state, now: now });
    if (!v.ok) return { ok: false, errors: v.errors };
    var stats;
    S.mutate(null, function (s) {
      stats = P.mergeOrganizeRun(s, { note: sentNote, run: run, validated: v }, now);
      var cur = M.byId(s.notes, sentNote.id);
      if (cur) P.refreshStale(s, cur);
      P.finishRun(s, run.id, {
        status: 'succeeded', error: null,
        stats: Object.assign({ tasks: v.items.filter(function (i) { return i.kind === 'task'; }).length, events: v.items.filter(function (i) { return i.kind === 'event'; }).length }, stats),
        dropped: v.dropped
      }, now);
    }, { source: 'ai' });
    return { ok: true, stats: stats };
  }

  // opts.force: 바뀌지 않은 메모라도 AI 를 다시 부른다
  function organize(noteId, opts) {
    opts = opts || {};
    var note = M.byId(S.state.notes, noteId);
    if (!note || note.deletedAt) return Promise.resolve({ ok: false, reason: 'no_note' });
    if (inflight[noteId]) return Promise.resolve({ ok: false, reason: 'busy' });
    if (!((note.title || '').trim() || (note.body || '').trim())) return Promise.resolve({ ok: false, reason: 'empty' });

    var snapshot = JSON.parse(JSON.stringify(note));
    var hash = P.noteHash(snapshot);
    var now = DN.app.now();

    // 같은 내용 + 같은 프롬프트로 성공한 결과가 있으면 다시 호출하지 않는다
    var reuse = !opts.force && P.reusableRun(S.state, noteId, hash, O.PROMPT_VERSION);
    if (reuse) {
      var out;
      try { out = JSON.parse(reuse.rawOutput); } catch (e) { out = null; }
      if (out) {
        var r = applyOutput(reuse, snapshot, out, now);
        if (r.ok) return Promise.resolve({ ok: true, reused: true, stats: r.stats });
      }
    }

    if (!status.configured) return Promise.resolve({ ok: false, reason: 'not_configured', message: status.reason });

    var input = buildInput(snapshot);
    var run = S.mutate(null, function (s) {
      return P.startRun(s, { noteId: noteId, noteHash: hash, promptVersion: O.PROMPT_VERSION, provider: status.provider, model: status.model }, now);
    }, { source: 'ai' });
    inflight[noteId] = run.id;
    notify();

    return S.host.ai.organizeNote(input).catch(function (e) {
      return { ok: false, error: { type: 'ipc', message: e && e.message ? e.message : String(e), retryable: true } };
    }).then(function (res) {
      delete inflight[noteId];
      var done = DN.app.now();
      if (!res.ok) {
        S.mutate(null, function (s) { P.finishRun(s, run.id, { status: 'failed', error: res.error, rawOutput: res.raw || null, attempts: res.attempts || 1 }, done); }, { source: 'ai' });
        notify();
        return { ok: false, reason: 'failed', error: res.error };
      }
      var runNow = M.byId(S.state.aiRuns, run.id);
      Object.assign(runNow, { model: res.model || runNow.model, provider: res.provider || runNow.provider });
      S.mutate(null, function (s) { P.finishRun(s, run.id, { rawOutput: res.raw || JSON.stringify(res.output), usage: res.usage || null, attempts: res.attempts || 1, status: 'running' }, done); }, { source: 'ai', silent: true });
      var r = applyOutput(M.byId(S.state.aiRuns, run.id), snapshot, res.output, done);
      if (!r.ok) {
        S.mutate(null, function (s) {
          P.finishRun(s, run.id, { status: 'invalid', error: { type: 'invalid_output', message: 'AI 응답이 정해진 형식과 달라 사용하지 않았습니다. (' + r.errors.slice(0, 3).join(', ') + ')', retryable: true } }, done);
        }, { source: 'ai' });
        notify();
        return { ok: false, reason: 'invalid', errors: r.errors };
      }
      notify();
      return { ok: true, reused: false, stats: r.stats };
    });
  }

  DN.aiFlow = {
    loadStatus: loadStatus, organize: organize, contextOpts: contextOpts,
    status: function () { return status; },
    isRunning: function (noteId) { return !!inflight[noteId]; },
    onChange: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; }
  };

  document.addEventListener('DOMContentLoaded', function () {
    // 앱이 꺼진 사이 '실행 중' 으로 남은 기록 정리는 데이터를 불러온 뒤에
    S.whenReady(function () { S.mutate(null, function (s) { P.recoverInterrupted(s, DN.app.now()); }, { silent: true }); });
    loadStatus();
  });
})();
