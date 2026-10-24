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
      recordUsage(res);
      recordExchange(input, res);
      var done = DN.app.now();
      if (!res.ok) {
        S.mutate(null, function (s) { P.finishRun(s, run.id, { status: 'failed', error: res.error, rawOutput: res.raw || null, attempts: res.attempts || 1 }, done); }, { source: 'ai' });
        notify();
        return { ok: false, reason: 'failed', error: res.error };
      }
      var runNow = M.byId(S.state.aiRuns, run.id);
      // 기다리는 사이 Ctrl+Z 로 정리 시작 전으로 돌아갔으면 늦게 온 결과는 버린다
      if (!runNow || runNow.status !== 'running' || !M.byId(S.state.notes, noteId)) { notify(); return { ok: false, reason: 'undone' }; }
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

  // ------------------------------------------------------------------ 쓴 토큰
  // AI 답이 올 때마다 오늘·이번 달 합계에 더한다 (meta.aiUsage — 되돌리기 대상 아님).
  //   설정에서 '쓴 토큰 보기' 를 켜면 답마다 "토큰 1,234 (입력 1,000 · 출력 234)" 가 보인다
  function addUsage(sum, u) {
    sum = sum || { input: 0, output: 0, thought: 0, calls: 0 };
    return { input: sum.input + (u.input_tokens || 0), output: sum.output + (u.output_tokens || 0), thought: sum.thought + (u.thought_tokens || 0), calls: sum.calls + 1 };
  }
  function recordUsage(res) {
    if (!res || !res.usage || res.provider === 'fake') return;
    var now = DN.app.now(), day = D.ymd(now), month = day.slice(0, 7);
    S.mutate(null, function (s) {
      var u = s.meta.aiUsage || {};
      s.meta.aiUsage = {
        day: day, month: month,
        today: addUsage(u.day === day ? u.today : null, res.usage),
        thisMonth: addUsage(u.month === month ? u.thisMonth : null, res.usage)
      };
    }, { source: 'ai', silent: true });
  }
  function totalTokens(u) { return u ? (u.input_tokens || u.input || 0) + (u.output_tokens || u.output || 0) + (u.thought_tokens || u.thought || 0) : 0; }
  function num(n) { return Number(n || 0).toLocaleString('ko-KR'); }
  // 답 하나의 토큰 한 줄 — 설정에서 껐거나 기록이 없으면 null. x: 이 답의 주고받은 기록 (있으면 '프롬프트 보기' 단추)
  function usageLine(usage, model, x) {
    if (!S.state.prefs.showTokens || !usage) return null;
    var parts = ['입력 ' + num(usage.input_tokens), '출력 ' + num(usage.output_tokens)];
    if (usage.thought_tokens) parts.push('생각 ' + num(usage.thought_tokens));
    return DN.ui.h('div.token-line', { title: '이 답을 만드는 데 쓴 토큰' + (model ? ' · ' + model : '') },
      '토큰 ' + num(totalTokens(usage)) + ' (' + parts.join(' · ') + ')' + (model ? ' · ' + model : ''), x ? ' · ' : null, promptButton(x));
  }

  // ------------------------------------------------------------------ AI 와 주고받은 내용 (설정에서 켜면)
  // 보낸 프롬프트(시스템 지시 + 보낸 글)와 받은 답을 이 기기에만 최근 20개 남긴다 — 데이터 파일·동기화에는 넣지 않는다.
  //   프롬프트는 AI 를 부르는 쪽(services/ai.js)과 같은 정의(src/core/ai/*)로 다시 만든다 — 실제로 보낸 글과 같다
  var LOG_KEY = 'daynote:aiLog', LOG_MAX = 20;
  var PURPOSE_LABEL = { capture: '적은 글 정리', breakdown: '작게 나누기', elaborate: '자세히 적기', organize: '메모 정리' };
  function requestDef(input) {
    var p = input && input.purpose;
    if (p === 'capture') return DN.aiCapture;
    if (p === 'breakdown') return DN.aiAssist.BREAKDOWN;
    if (p === 'elaborate') return DN.aiAssist.ELABORATE;
    return DN.aiOrganize;
  }
  function readLog() { try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch (e) { return []; } }
  function writeLog(list) {
    // 저장소가 꽉 차면 오래된 것부터 덜어 낸다
    for (var n = list.length; n > 0; n = Math.floor(n / 2)) {
      try { localStorage.setItem(LOG_KEY, JSON.stringify(list.slice(-n))); return; } catch (e) {}
    }
  }
  var logListeners = [];
  // 토큰 보기나 프롬프트 보기를 켰으면 남긴다 (토큰 줄 옆 '프롬프트 보기' 단추가 이것을 연다)
  function logging() { return !!(S.state.prefs.showPrompts || S.state.prefs.showTokens); }
  function recordExchange(input, res) {
    if (!logging() || !input) return null;
    var def = requestDef(input), sys = '', user = '';
    try { sys = def.SYSTEM; user = def.userText(input); } catch (e) { user = JSON.stringify(input, null, 2); }
    var out = res && (res.raw || (res.output ? JSON.stringify(res.output) : null));
    var list = readLog();
    list.push({
      id: M.uid('ai'), at: new Date().toISOString(), purpose: input.purpose || 'organize', promptVersion: input.promptVersion || null,
      noteId: input.noteId || null, model: res && res.model || null, provider: res && res.provider || null,
      system: sys, user: user, output: out, error: res && !res.ok ? res.error || null : null, usage: res && res.usage || null
    });
    writeLog(list.slice(-LOG_MAX));
    logListeners.forEach(function (fn) { try { fn(); } catch (e) {} });
    return list[list.length - 1].id;
  }
  function exchangeById(id) { return id ? readLog().filter(function (x) { return x.id === id; })[0] || null : null; }
  // 토큰 줄 옆의 '프롬프트 보기' 단추 — 이 기기에 기록이 있을 때만
  function promptButton(x) {
    if (!x || !logging()) return null;
    return DN.ui.h('button.link-btn.prompt-btn', { type: 'button', title: 'AI에 보낸 프롬프트와 받은 답', onclick: function () { openExchange(x); } }, '프롬프트 보기');
  }
  function exchanges() { return readLog().slice().reverse(); }
  function clearExchanges() { try { localStorage.removeItem(LOG_KEY); } catch (e) {} logListeners.forEach(function (fn) { try { fn(); } catch (e) {} }); }
  function pretty(text) { try { return JSON.stringify(JSON.parse(text), null, 2); } catch (e) { return text || ''; } }
  // 주고받은 내용 하나 — 펼쳐 보는 칸 세 개 (시스템 지시 · 보낸 글 · 받은 답), 각각 복사
  function exchangeView(x, open) {
    var ui = DN.ui, h = ui.h;
    function block(label, text, opened) {
      return h('details.ai-x-part', opened ? { open: true } : {},
        h('summary', label, h('span.meta', ' · ' + Number((text || '').length).toLocaleString('ko-KR') + '자'),
          h('button.link-btn.ai-x-copy', { type: 'button', onclick: function (e) { e.preventDefault(); S.host.copyText(text || '').then(function () { ui.toast(label + '을(를) 복사했어요.'); }); } }, '복사')),
        h('pre.ai-x-pre', text || '(없음)'));
    }
    var u = x.usage;
    return h('div.ai-x',
      h('div.ai-x-meta.meta', D.ymd(x.at) + ' ' + D.hm(x.at) + ' · ' + (PURPOSE_LABEL[x.purpose] || x.purpose) + (x.model ? ' · ' + x.model : '') +
        (x.promptVersion ? ' · ' + x.promptVersion : '') + (u ? ' · 토큰 ' + Number(totalTokens(u)).toLocaleString('ko-KR') : '') + (x.error ? ' · 실패: ' + (x.error.message || x.error.type) : '')),
      block('시스템 지시', x.system, false),
      block('보낸 글', x.user, open),
      block('받은 답', x.error && !x.output ? JSON.stringify(x.error, null, 2) : pretty(x.output), open));
  }
  function openExchange(x) {
    DN.ui.modal({ title: 'AI와 주고받은 내용', wide: true, body: exchangeView(x, true), actions: [{ label: '닫기', primary: true }] });
  }
  function exchangeForNote(noteId) { return readLog().filter(function (x) { return x.noteId === noteId; }).pop() || null; }

  DN.aiFlow = {
    recordExchange: recordExchange, exchangeById: exchangeById, promptButton: promptButton, exchanges: exchanges, clearExchanges: clearExchanges, exchangeView: exchangeView, openExchange: openExchange, exchangeForNote: exchangeForNote,
    onExchange: function (fn) { logListeners.push(fn); return function () { logListeners = logListeners.filter(function (f) { return f !== fn; }); }; },
    recordUsage: recordUsage, usageLine: usageLine, totalTokens: totalTokens,
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
