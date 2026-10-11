'use strict';

// 화면 쪽 상태 저장소.
//  - 상태는 하나의 객체(state)이고, 변경은 반드시 store.mutate(label, fn) 로 한다.
//  - mutate 는 바꾸기 전 상태를 기억해 두어 "되돌리기" 를 제공한다.
//    단 prefs(화면 설정)·presence(현재 상태)·gcal(Google 동기화)는 되돌리지 않는다 — 스냅숏에도 넣지 않는다.
//  - 저장은 잠깐 모아서(디바운스) 한 번에. 실패해도 메모리와 로컬 비상 사본에 남기고 재시도한다.
//  - 저장 장소: Electron 이면 앱 데이터 폴더의 JSON 파일, 브라우저면 localStorage.

(function () {
  var M = window.Daynote.model;
  var LS_KEY = 'daynote:data';
  var EMERGENCY_KEY = 'daynote:unsaved';
  var SAVE_DELAY = 400;
  // 되돌리기가 건드리지 않는 최상위 키 — undo 뒤에도 '지금 값' 을 유지한다
  var KEEP_ON_UNDO = ['prefs', 'presence', 'gcal', 'quickDraft', 'homeDraft'];   // 초안은 되돌리지 않는다

  // 브라우저 미리보기에는 메인 프로세스가 없어서 Google 로그인·캘린더를 쓸 수 없다 — 같은 모양의 '쓸 수 없음' 응답을 준다
  var G_UNAVAILABLE = { available: false, state: 'unavailable', signedIn: false, email: null, name: null, picture: null,
    reason: 'Google 캘린더 연결은 데스크톱 앱에서만 쓸 수 있어요.' };
  function gStatus() { return Object.assign({}, G_UNAVAILABLE); }
  function gNo() { return Promise.resolve({ ok: false, error: { type: 'unavailable', message: G_UNAVAILABLE.reason, retryable: false }, status: gStatus() }); }

  var host = window.daynoteHost || {
    kind: 'browser',
    load: function () {
      try {
        var raw = localStorage.getItem(LS_KEY);
        return Promise.resolve({ ok: true, data: raw ? JSON.parse(raw) : null, path: 'localStorage' });
      } catch (e) { return Promise.resolve({ ok: true, data: null, path: 'localStorage' }); }
    },
    save: function (json) {
      try {
        if (window.__daynoteFailSave) throw new Error('저장 실패 시험');
        localStorage.setItem(LS_KEY, json);
        return Promise.resolve({ ok: true, savedAt: new Date().toISOString() });
      } catch (e) { return Promise.resolve({ ok: false, error: e.message }); }
    },
    dataPath: function () { return Promise.resolve('브라우저 localStorage'); },
    revealData: function () { return Promise.resolve(); },
    copyText: function (text) {
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(function () { return true; });
      var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } finally { ta.remove(); }
      return Promise.resolve(true);
    },
    exportFile: function (name, content) {
      var blob = new Blob([content], { type: name.endsWith('.json') ? 'application/json' : 'text/markdown' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      return Promise.resolve({ ok: true, path: name });
    },
    // 백업 가져오기 — 숨긴 파일 입력으로 고르게 하고 글자로 읽어 돌려준다 (폰 브라우저에서도 동작)
    //   → { ok:true, name, content } | { ok:false, canceled:true } | { ok:false, error }
    importFile: function () {
      return new Promise(function (resolve) {
        var done = false;
        function finish(r) { if (done) return; done = true; try { input.remove(); } catch (e) {} resolve(r); }
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.style.display = 'none';
        input.addEventListener('cancel', function () { finish({ ok: false, canceled: true }); });
        input.addEventListener('change', function () {
          var f = input.files && input.files[0];
          if (!f) { finish({ ok: false, canceled: true }); return; }
          // 브라우저 저장 공간(localStorage)은 몇 MB 뿐이다 — 크게 넘는 파일은 읽기 전에 막는다 (실제로 써지는지는 가져온 뒤 바로 확인)
          if (f.size > 10 * 1024 * 1024) { finish({ ok: false, error: '파일이 너무 커요. 브라우저에서는 10MB까지 가져올 수 있어요.' }); return; }
          var rd = new FileReader();
          rd.onload = function () { finish({ ok: true, name: f.name, content: String(rd.result || '') }); };
          rd.onerror = function () { finish({ ok: false, error: '파일을 읽지 못했어요.' }); };
          rd.readAsText(f, 'utf-8');
        });
        document.body.appendChild(input);
        input.click();
      });
    },
    // 브라우저 미리보기에는 메인 프로세스가 없으므로 실제 AI 를 부를 수 없다.
    // 주소에 ?fakeai 를 붙이면 가짜 AI(규칙 기반, 화면에 표시됨)로 흐름만 확인할 수 있다.
    ai: {
      status: function () {
        if ((window.DAYNOTE_WEB_DEMO || /[?&]fakeai\b/.test(location.search))) return Promise.resolve({ configured: true, provider: 'fake', model: '가짜 AI(테스트)' });
        return Promise.resolve({ configured: false, provider: null, reason: '브라우저 미리보기에서는 AI를 연결할 수 없어요. 데스크톱 앱에서 키를 넣어 주세요.' });
      },
      organizeNote: function (input) {
        if (!(window.DAYNOTE_WEB_DEMO || /[?&]fakeai\b/.test(location.search))) return Promise.resolve({ ok: false, error: { type: 'not_configured', message: '브라우저 미리보기에서는 AI를 쓸 수 없습니다.', retryable: false } });
        return new Promise(function (r) { setTimeout(function () {
          if (window.__daynoteAiFail) { r({ ok: false, error: { type: 'network', message: 'AI 서버에 연결하지 못했습니다. (시험)', retryable: true } }); return; }
          var out = window.Daynote.aiFake.organize(input);
          r(Object.assign({ raw: out.output ? JSON.stringify(out.output) : null, attempts: 1 }, out));
        }, 500); });
      },
      setKey: function () { return Promise.resolve({ ok: false, error: '브라우저 미리보기에서는 키를 저장할 수 없습니다.' }); },
      clearKey: function () { return Promise.resolve({ ok: true }); },
      check: function () { return Promise.resolve((window.DAYNOTE_WEB_DEMO || /[?&]fakeai\b/.test(location.search)) ? { ok: true, ms: 500, model: '가짜 AI(테스트)' } : { ok: false, error: { message: '브라우저 미리보기에서는 AI를 쓸 수 없습니다.' } }); }
    },
    google: {
      status: function () { return Promise.resolve(gStatus()); },
      setClient: gNo, clearClient: gNo, signIn: gNo,
      cancelSignIn: function () { return Promise.resolve({ ok: true }); },
      signOut: gNo,
      onChanged: function () {}
    },
    gcal: { calendars: gNo, ensureExportCalendar: gNo, list: gNo, instances: gNo, push: gNo },
    onBeforeClose: function () {},
    flushed: function () {}
  };

  var state = M.emptyState();
  var listeners = [];
  var undoStack = [];
  var saveTimer = null;
  var saveStatus = { phase: 'saved', at: null, error: null };   // saved | pending | saving | error
  var statusListeners = [];
  var dirty = false;
  var loaded = false;
  var readyQueue = [];

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // 되돌리기용 스냅숏 — KEEP_ON_UNDO 키는 빼고(null) 복제한다 (되돌리지 않는 값이고, gcal 은 커서 메모리도 아낀다)
  function snapshot() {
    var keep = {};
    KEEP_ON_UNDO.forEach(function (k) { if (k in state) { keep[k] = state[k]; state[k] = null; } });
    try { return clone(state); }
    finally { Object.keys(keep).forEach(function (k) { state[k] = keep[k]; }); }
  }

  function emit(info) { listeners.forEach(function (fn) { try { fn(info || {}); } catch (e) { console.error(e); } }); }
  function setStatus(p) {
    saveStatus = Object.assign({}, saveStatus, p);
    statusListeners.forEach(function (fn) { fn(saveStatus); });
  }

  function scheduleSave() {
    dirty = true;
    setStatus({ phase: 'pending' });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_DELAY);
  }

  function flush() {
    clearTimeout(saveTimer);
    if (!dirty) return Promise.resolve(true);
    dirty = false;
    var json = JSON.stringify(state);
    setStatus({ phase: 'saving' });
    return host.save(json).then(function (res) {
      if (res && res.ok) {
        try { localStorage.removeItem(EMERGENCY_KEY); } catch (e) {}
        setStatus({ phase: dirty ? 'pending' : 'saved', at: res.savedAt || new Date().toISOString(), error: null });
        return true;
      }
      throw new Error((res && res.error) || '알 수 없는 오류');
    }).catch(function (e) {
      dirty = true;   // 다음 시도에 다시 쓴다
      // 파일 저장이 안 되면 브라우저 저장소에 비상 사본을 둔다 — 작성한 내용을 잃지 않게
      try { localStorage.setItem(EMERGENCY_KEY, json); } catch (_) {}
      setStatus({ phase: 'error', error: e.message });
      return false;
    });
  }

  // 백업 가져오기·그 되돌리기 뒤 — Google 캘린더 커서(syncToken)를 비워 다음 동기화를 전체 회차로 만든다.
  //   옛 커서로 증분 pull 을 하면 그 뒤에 지운 일정이 'cancelled' 로 돌아와, 링크가 살아 있는 블록을 지워 버린다.
  //   전체 목록에는 지운 일정이 오지 않으므로 Google 에 없는 링크 블록은 지우지 않고 다시 올린다.
  function resetSyncCursors(st) {
    var g = st && st.gcal;
    if (!g || !Array.isArray(g.calendars)) return;
    g.calendars.forEach(function (c) {
      if (c && typeof c === 'object') { c.syncToken = null; c.windowStart = null; c.windowEnd = null; c.fullSyncAt = null; c.nextPullAt = null; }
    });
  }

  function carryChat(curChat) {
    if (!Array.isArray(state.chat)) state.chat = [];
    var have = {}, notes = {}, tasks = {};
    state.chat.forEach(function (m) { have[m.id] = 1; });
    (state.notes || []).forEach(function (n) { notes[n.id] = 1; });
    (state.tasks || []).forEach(function (t) { tasks[t.id] = 1; });
    curChat.forEach(function (m) {
      if (!m || have[m.id]) return;
      if (m.noteId && !notes[m.noteId]) return;
      if (m.taskId && !tasks[m.taskId]) return;
      state.chat.push(m);
    });
  }

  var store = {
    host: host,
    get state() { return state; },

    load: function () {
      return host.load().then(function (res) {
        var data = res && res.data;
        var recovered = !!(res && res.recovered);
        // 지난번 저장에 실패하고 꺼졌으면 비상 사본이 더 최신이다
        try {
          var em = localStorage.getItem(EMERGENCY_KEY);
          if (em) { data = JSON.parse(em); recovered = true; dirty = true; }
        } catch (e) {}
        state = M.normalize(data);
        if (dirty) scheduleSave(); else setStatus({ phase: 'saved', at: null });
        loaded = true;
        emit({ type: 'load' });
        var q = readyQueue; readyQueue = [];
        q.forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } });
        return { recovered: recovered, fresh: !data };
      });
    },

    // 데이터를 처음 불러온 뒤 한 번 실행 — 이미 불러왔으면 바로 (구독 순서와 상관없이 안전)
    whenReady: function (fn) { if (loaded) setTimeout(fn, 0); else readyQueue.push(fn); },

    subscribe: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; },
    onStatus: function (fn) { statusListeners.push(fn); fn(saveStatus); },
    status: function () { return saveStatus; },

    // label 이 있으면 되돌리기 대상이 된다. fn 의 반환값을 그대로 돌려준다.
    mutate: function (label, fn, opts) {
      opts = opts || {};
      var before = label ? snapshot() : null;
      var result = fn(state);
      if (label) {
        undoStack.push({ label: label, snapshot: before, at: Date.now() });
        if (undoStack.length > 30) undoStack.shift();
      }
      scheduleSave();
      if (!opts.silent) emit({ type: 'change', label: label, source: opts.source });
      return result;
    },

    canUndo: function () { return undoStack.length > 0; },
    // 지금 맨 위 되돌리기 항목(같은 객체) — 알림의 [되돌리기]가 제 변경이 아직 맨 위인지 확인할 때 쓴다
    peekUndo: function () { return undoStack[undoStack.length - 1] || null; },
    undo: function () {
      var last = undoStack.pop();
      if (!last) return null;
      // 백업 가져오기 — 가져오기 전 상태 전체(prefs·gcal 포함)로 통째로 돌아간다. 현재 상태(presence)만 지금 값을 둔다
      if (last.full) {
        var pres = state.presence;
        state = last.snapshot;
        if (pres !== undefined) state.presence = pres;
        resetSyncCursors(state);
        scheduleSave();
        emit({ type: 'load', label: last.label, source: 'import-undo' });
        return last.label;
      }
      // 화면 설정(prefs: 사이드바·모션 줄이기·홈 분할 비율 등), 현재 상태(presence), Google 동기화(gcal)는
      // 되돌리기 대상이 아니다 — 지금 값(같은 객체)을 그대로 유지한다
      var keep = {};
      KEEP_ON_UNDO.forEach(function (k) { if (state[k] !== undefined) keep[k] = state[k]; });
      var curChat = state.chat || [];
      state = last.snapshot;
      KEEP_ON_UNDO.forEach(function (k) {
        if (keep[k] !== undefined) state[k] = keep[k];
        else if (state[k] === null) delete state[k];   // 스냅숏에서 비워 둔 자리 — 지금도 없으면 없는 대로
      });
      // 흐름(chat)은 되돌린 단계 뒤에 올라온 글도 남긴다 — 상태 보고·도움말·휴식 카드처럼 데이터와 상관없는 글이
      // 사라지지 않게. 되돌리기로 없어진 메모·할 일에 묶인 카드만 뺀다
      carryChat(curChat);
      scheduleSave();
      emit({ type: 'undo', label: last.label });
      return last.label;
    },

    flush: flush,
    retrySave: function () { dirty = true; return flush(); },
    replaceAll: function (next) { state = M.normalize(next); undoStack = []; scheduleSave(); emit({ type: 'load' }); },

    // 백업 가져오기 — next 는 M.validateBackup 을 거친 상태. 지금 데이터를 통째로 바꾸되,
    // 가져오기 전 상태 전체를 되돌리기 항목 하나로 남긴다 (Ctrl+Z·알림의 [되돌리기] 한 번으로 돌아간다).
    // 그 전 되돌리기 항목은 지운다 — 가져온 데이터 위에 옛 스냅숏을 덮으면 섞인다.
    // 현재 상태(presence)는 이 기기에서만 사는 값이라 가져오지 않고 지금 값을 둔다.
    importBackup: function (next, label) {
      label = label || '백업 가져오기';
      var before = clone(state);
      var pres = state.presence;
      state = M.normalize(next);
      if (pres !== undefined) state.presence = pres;
      resetSyncCursors(state);
      // 백업 때 보내려던 목록은 지금과 맞지 않는다 — 비우면 동기화가 블록과 링크를 비교해 새로 만든다
      if (state.gcal) state.gcal.outbox = [];
      undoStack = [{ label: label, snapshot: before, at: Date.now(), full: true }];
      scheduleSave();
      emit({ type: 'load', label: label, source: 'import' });
      return label;
    }
  };

  // 창을 닫기 전에 남은 저장을 끝낸다
  host.onBeforeClose(function () { flush().then(function () { host.flushed(); }); });
  // 트레이로 숨길 때·Windows 종료 때 — 저장 대기분을 바로 쓴다
  if (host.onFlush) host.onFlush(function () { flush(); });
  window.addEventListener('beforeunload', function () { if (dirty) { try { localStorage.setItem(EMERGENCY_KEY, JSON.stringify(state)); } catch (e) {} } });

  window.Daynote.store = store;
})();
