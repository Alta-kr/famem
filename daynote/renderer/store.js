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
  var KEEP_ON_UNDO = ['prefs', 'presence', 'gcal'];

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
    undo: function () {
      var last = undoStack.pop();
      if (!last) return null;
      // 화면 설정(prefs: 사이드바·모션 줄이기·홈 분할 비율 등), 현재 상태(presence), Google 동기화(gcal)는
      // 되돌리기 대상이 아니다 — 지금 값(같은 객체)을 그대로 유지한다
      var keep = {};
      KEEP_ON_UNDO.forEach(function (k) { if (state[k] !== undefined) keep[k] = state[k]; });
      state = last.snapshot;
      KEEP_ON_UNDO.forEach(function (k) {
        if (keep[k] !== undefined) state[k] = keep[k];
        else if (state[k] === null) delete state[k];   // 스냅숏에서 비워 둔 자리 — 지금도 없으면 없는 대로
      });
      scheduleSave();
      emit({ type: 'undo', label: last.label });
      return last.label;
    },

    flush: flush,
    retrySave: function () { dirty = true; return flush(); },
    replaceAll: function (next) { state = M.normalize(next); undoStack = []; scheduleSave(); emit({ type: 'load' }); }
  };

  // 창을 닫기 전에 남은 저장을 끝낸다
  host.onBeforeClose(function () { flush().then(function () { host.flushed(); }); });
  // 트레이로 숨길 때·Windows 종료 때 — 저장 대기분을 바로 쓴다
  if (host.onFlush) host.onFlush(function () { flush(); });
  window.addEventListener('beforeunload', function () { if (dirty) { try { localStorage.setItem(EMERGENCY_KEY, JSON.stringify(state)); } catch (e) {} } });

  window.Daynote.store = store;
})();
