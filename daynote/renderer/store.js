'use strict';

// 화면 쪽 상태 저장소.
//  - 상태는 하나의 객체(state)이고, 변경은 반드시 store.mutate(label, fn) 로 한다.
//  - mutate 는 바꾸기 전 상태를 기억해 두어 "되돌리기" 를 제공한다.
//  - 저장은 잠깐 모아서(디바운스) 한 번에. 실패해도 메모리와 로컬 비상 사본에 남기고 재시도한다.
//  - 저장 장소: Electron 이면 앱 데이터 폴더의 JSON 파일, 브라우저면 localStorage.

(function () {
  var M = window.Daynote.model;
  var LS_KEY = 'daynote:data';
  var EMERGENCY_KEY = 'daynote:unsaved';
  var SAVE_DELAY = 400;

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
    notify: function (title, body) {
      try { if (window.Notification && Notification.permission === 'granted') new Notification(title, { body: body }); } catch (e) {}
      return Promise.resolve(true);
    },
    setStatus: function () { return Promise.resolve(true); },
    fetchCalendar: function () { return Promise.resolve({ ok: false, error: '브라우저 미리보기에서는 주소로 가져올 수 없어요 — ICS 파일로 가져오세요' }); },
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
        if (/[?&]fakeai\b/.test(location.search)) return Promise.resolve({ configured: true, provider: 'fake', model: '가짜 AI(테스트)' });
        return Promise.resolve({ configured: false, provider: null, reason: '브라우저 미리보기에서는 AI를 쓸 수 없습니다. 데스크톱 앱에서 GEMINI_API_KEY 또는 ANTHROPIC_API_KEY 를 설정해 주세요.' });
      },
      organizeNote: function (input) {
        if (!/[?&]fakeai\b/.test(location.search)) return Promise.resolve({ ok: false, error: { type: 'not_configured', message: '브라우저 미리보기에서는 AI를 쓸 수 없습니다.', retryable: false } });
        return new Promise(function (r) { setTimeout(function () {
          if (window.__daynoteAiFail) { r({ ok: false, error: { type: 'network', message: 'AI 서버에 연결하지 못했습니다. (시험)', retryable: true } }); return; }
          var out = window.Daynote.aiFake.organize(input);
          r(Object.assign({ raw: out.output ? JSON.stringify(out.output) : null, attempts: 1 }, out));
        }, 500); });
      },
      setKey: function () { return Promise.resolve({ ok: false, error: '브라우저 미리보기에서는 키를 저장할 수 없습니다.' }); },
      clearKey: function () { return Promise.resolve({ ok: true }); },
      check: function () { return Promise.resolve(/[?&]fakeai\b/.test(location.search) ? { ok: true, ms: 500, model: '가짜 AI(테스트)' } : { ok: false, error: { message: '브라우저 미리보기에서는 AI를 쓸 수 없습니다.' } }); }
    },
    onBeforeClose: function () {},
    flushed: function () {}
  };

  var state = M.emptyState();
  var listeners = [];
  var activeJoin = null;   // withJoin 이 도는 동안의 이름표
  var undoStack = [];
  var redoStack = [];   // 되돌린 것을 다시 실행 (새 작업을 하면 비운다)
  var saveTimer = null;
  var saveStatus = { phase: 'saved', at: null, error: null };   // saved | pending | saving | error
  var statusListeners = [];
  var dirty = false;
  var loaded = false;
  var readyQueue = [];

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

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

  // 쓰는 중인 저장 — 창을 닫을 때 flush() 가 이것이 끝날 때까지 기다리게 (쓰기 도중 종료 방지)
  var savingPromise = null;
  function flush() {
    clearTimeout(saveTimer);
    if (!dirty) return savingPromise || Promise.resolve(true);
    dirty = false;
    var json = JSON.stringify(state);
    setStatus({ phase: 'saving' });
    var p = host.save(json).then(function (res) {
      if (res && res.ok) {
        try { localStorage.removeItem(EMERGENCY_KEY); } catch (e) {}
        if (savingPromise === p) savingPromise = null;
        if (dirty) return flush();   // 쓰는 동안 또 바뀌었으면 이어서 한 번 더
        setStatus({ phase: 'saved', at: res.savedAt || new Date().toISOString(), error: null });
        return true;
      }
      throw new Error((res && res.error) || '알 수 없는 오류');
    }).catch(function (e) {
      if (savingPromise === p) savingPromise = null;
      dirty = true;   // 다음 시도에 다시 쓴다
      // 파일 저장이 안 되면 브라우저 저장소에 비상 사본을 둔다 — 작성한 내용을 잃지 않게
      try { localStorage.setItem(EMERGENCY_KEY, json); } catch (_) {}
      setStatus({ phase: 'error', error: e.message });
      return false;
    });
    savingPromise = p;
    return p;
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
    // 구독 해제 함수를 돌려준다 (화면을 다시 열 때마다 쌓이지 않게)
    onStatus: function (fn) {
      statusListeners.push(fn); fn(saveStatus);
      return function () { statusListeners = statusListeners.filter(function (f) { return f !== fn; }); };
    },
    status: function () { return saveStatus; },

    // label 이 있으면 되돌리기 대상이 된다. fn 의 반환값을 그대로 돌려준다.
    //   opts.key  : 이 되돌리기 칸에 이름표를 붙인다 (예: 채팅으로 보낸 글 하나)
    //   opts.join : 맨 위 칸의 이름표가 같으면 새 칸을 만들지 않고 그 칸에 합친다 — 보내기 → AI 정리 → 명령 실행을
    //               Ctrl+Z 한 번에 통째로 되돌리게 (중간 '정리 중' 에서 멈추지 않게). withJoin 안의 변경도 같다
    mutate: function (label, fn, opts) {
      opts = opts || {};
      var jk = opts.join || activeJoin;
      var top = undoStack[undoStack.length - 1];
      var merge = !!(label && jk && top && top.key === jk);
      var before = label && !merge ? clone(state) : null;
      var result = fn(state);
      if (merge) {
        redoStack = [];   // 칸 이름은 처음 것 그대로 (예: '보낸 글')
      } else if (label) {
        undoStack.push({ label: label, snapshot: before, at: Date.now(), key: opts.key || jk || null });
        if (undoStack.length > 30) undoStack.shift();
        redoStack = [];   // 새 작업을 하면 '다시 실행' 할 것이 없어진다
      }
      scheduleSave();
      if (!opts.silent) emit({ type: 'change', label: label, source: opts.source });
      return result;
    },

    // fn 안에서 일어나는 되돌리기 대상 변경을 key 칸에 합친다 (그 칸이 맨 위일 때만)
    withJoin: function (key, fn) {
      var prev = activeJoin; activeJoin = key || null;
      try { return fn(); } finally { activeJoin = prev; }
    },
    canUndo: function () { return undoStack.length > 0; },
    canRedo: function () { return redoStack.length > 0; },
    undo: function () {
      var last = undoStack.pop();
      if (!last) return null;
      redoStack.push({ label: last.label, snapshot: clone(state), at: Date.now(), key: last.key });
      // 화면 설정(prefs: 사이드바·모션 줄이기·홈 분할 비율 등)과 외부 캘린더에서 가져온 일정은 되돌리기 대상이 아니다 — 지금 값을 유지한다
      state = keepLive(state, last.snapshot);
      scheduleSave();
      emit({ type: 'undo', label: last.label });
      return last.label;
    },
    // 다시 실행 — 방금 되돌린 것을 다시 (되돌리기와 같은 규칙: 화면 설정은 지금 값 유지)
    redo: function () {
      var next = redoStack.pop();
      if (!next) return null;
      undoStack.push({ label: next.label, snapshot: clone(state), at: Date.now(), key: next.key });
      state = keepLive(state, next.snapshot);
      scheduleSave();
      emit({ type: 'redo', label: next.label });
      return next.label;
    },

    flush: flush,
    retrySave: function () { dirty = true; return flush(); },
    replaceAll: function (next) { state = M.normalize(next); undoStack = []; redoStack = []; scheduleSave(); emit({ type: 'load' }); }
  };

  function keepLive(cur, snap) {
    snap.prefs = cur.prefs;
    snap.blocks = snap.blocks.filter(function (b) { return b.origin !== 'ics'; }).concat(cur.blocks.filter(function (b) { return b.origin === 'ics'; }));
    if (snap.meta && cur.meta) snap.meta.extDays = cur.meta.extDays;
    return snap;
  }

  // 창을 닫기 전에 남은 저장을 끝낸다
  host.onBeforeClose(function () { flush().then(function () { host.flushed(); }); });
  // 트레이로 숨길 때·Windows 종료 때 — 저장 대기분을 바로 쓴다
  if (host.onFlush) host.onFlush(function () { flush(); });
  window.addEventListener('beforeunload', function () { if (dirty) { try { localStorage.setItem(EMERGENCY_KEY, JSON.stringify(state)); } catch (e) {} } });

  window.Daynote.store = store;
})();
