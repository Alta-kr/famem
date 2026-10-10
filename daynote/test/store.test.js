'use strict';
// renderer/store.js 는 브라우저용 IIFE 라 window·localStorage 를 흉내 내고 vm 으로 불러온다.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('../src/core/model');

// extra: vm 전역에 더할 것 (예: { location: { search: '' } }). 기본은 document·location 없이 — 불러올 때 DOM 을 건드리지 않는지 확인
function loadStore(extra) {
  const mem = {};
  const localStorage = {
    getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; }
  };
  const window = { Daynote: { model: M }, addEventListener() {} };
  const ctx = vm.createContext(Object.assign({ window, localStorage, setTimeout() { return 0; }, clearTimeout() {}, console, JSON, Promise, Date }, extra || {}));
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/store.js'), 'utf8'), ctx);
  window.Daynote.store.__mem = mem;
  return window.Daynote.store;
}

test('undo: 데이터는 되돌리고 prefs(화면 설정)는 지금 값을 유지', () => {
  const S = loadStore();
  S.mutate('메모 저장', (s) => { M.addNote(s, { title: 'a' }); });
  S.mutate(null, (s) => { s.prefs.homeSplit = [0.6, 0.2, 0.2]; s.prefs.sidebarCollapsed = true; s.prefs.reduceMotion = true; }, { silent: true });
  assert.strictEqual(S.undo(), '메모 저장');
  assert.strictEqual(S.state.notes.length, 0);
  assert.deepStrictEqual(S.state.prefs.homeSplit, [0.6, 0.2, 0.2]);
  assert.strictEqual(S.state.prefs.sidebarCollapsed, true);
  assert.strictEqual(S.state.prefs.reduceMotion, true);
});

// ───────────────────────────── 되돌리기에서 빼는 키: prefs · presence · gcal (계획 §2.8) ─────────────────────────────
const NOW = new Date(2026, 9, 9, 18, 42);

test('undo: presence·gcal 은 되돌리지 않고 지금 객체를 그대로 둔다 (STATUS #65, GOOGLE §12.5)', () => {
  const S = loadStore();
  S.mutate('메모 저장', (s) => { M.addNote(s, { title: 'a' }, NOW); });
  // 라벨 없는 변경 — 동기화 엔진·상태 칩이 하는 것처럼 (ST 없이 직접 대입)
  S.mutate(null, (s) => {
    s.gcal.links.blk_1 = { eventId: 'dn1', calendarId: 'daynote@group', gen: 0, etag: '"1"', hash: 'abc', end: NOW.toISOString(), pushedAt: NOW.toISOString() };
    s.gcal.lastSyncAt = NOW.toISOString();
    s.presence.activatedAt = NOW.toISOString();
    s.presence.current = { id: 'off', label: '퇴근', role: 'work_end', since: NOW.toISOString(), source: 'text', until: null, returnTo: null };
  }, { source: 'status' });
  const gcal = S.state.gcal, presence = S.state.presence, prefs = S.state.prefs;
  assert.strictEqual(S.undo(), '메모 저장');
  assert.strictEqual(S.state.notes.length, 0);             // 데이터는 되돌아간다
  assert.strictEqual(S.state.gcal, gcal);                  // 같은 객체
  assert.strictEqual(S.state.presence, presence);
  assert.strictEqual(S.state.prefs, prefs);
  assert.strictEqual(S.state.presence.current.id, 'off');
  assert.strictEqual(S.state.gcal.links.blk_1.eventId, 'dn1');
  assert.strictEqual(S.canUndo(), false);
});

const has = (rel) => fs.existsSync(path.join(__dirname, '..', rel));
const ST = has('src/core/status.js') ? require('../src/core/status') : null;        // W1-status

test('undo: ST.setStatus 로 바꾼 현재 상태도 남는다 (STATUS #65)', { skip: !ST && 'W1-status 병합 전' }, () => {
  const S = loadStore();
  S.mutate('메모 저장', (s) => { M.addNote(s, { title: 'a' }, NOW); });
  S.mutate(null, (s) => { ST.setStatus(s, { id: 'off' }, { source: 'chip' }, ST.profile(s.prefs), NOW); }, { source: 'status' });
  assert.strictEqual(S.state.presence.current.id, 'off');
  assert.strictEqual(S.undo(), '메모 저장');
  assert.strictEqual(S.state.notes.length, 0);
  assert.strictEqual(S.state.presence.current.id, 'off');
  assert.ok(S.state.presence.activatedAt);
});

test('undo: 라벨 mutate 안에서 바꾼 gcal·presence 도 지금 값으로 남고, learned 는 교정과 함께 되돌아간다', () => {
  const S = loadStore();
  S.mutate('입력 저장', (s) => {
    M.addNote(s, { title: '장보기' }, NOW);
    s.gcal.gens.blk_9 = 1;
    s.presence.hints.used = 1;
    s.learned.rules.push({ id: 'lr_1', type: 'kind', key: '장보기', role: 'exact', to: 'task', w: 1 });
    s.learned.metrics.learned = 1;
  });
  assert.strictEqual(S.undo(), '입력 저장');
  assert.strictEqual(S.state.notes.length, 0);
  assert.strictEqual(S.state.gcal.gens.blk_9, 1);
  assert.strictEqual(S.state.presence.hints.used, 1);
  assert.strictEqual(S.state.learned.rules.length, 0);
  assert.strictEqual(S.state.learned.metrics.learned, 0);
});

test('mutate: 라벨 스냅숏을 뜬 뒤에도 prefs·presence·gcal 이 비지 않고 같은 객체다', async () => {
  const S = loadStore();
  const gcal = S.state.gcal, presence = S.state.presence, prefs = S.state.prefs;
  let seen = null;
  S.mutate('할 일 추가', (s) => { seen = { gcal: s.gcal, presence: s.presence, prefs: s.prefs }; M.addTask(s, { title: 'x' }, NOW); });
  assert.strictEqual(seen.gcal, gcal);
  assert.strictEqual(seen.presence, presence);
  assert.strictEqual(seen.prefs, prefs);
  assert.strictEqual(S.state.gcal, gcal);
  // 되돌린 뒤 저장한 파일에도 세 키가 온전히 들어 있다 (스냅숏의 빈자리가 새지 않음)
  S.undo();
  assert.strictEqual(await S.flush(), true);
  const saved = JSON.parse(S.__mem['daynote:data']);
  assert.strictEqual(saved.tasks.length, 0);
  assert.deepStrictEqual(saved.gcal, M.emptyState().gcal);
  assert.deepStrictEqual(saved.presence, M.emptyState().presence);
  assert.ok(saved.prefs && typeof saved.prefs === 'object');
  assert.ok(saved.learned && Array.isArray(saved.learned.rules));
});

test('브라우저 host: Google 은 데스크톱 앱에서만 — status available:false, gcal 은 unavailable', async () => {
  const S = loadStore();
  assert.strictEqual(S.host.kind, 'browser');
  const st = await S.host.google.status();
  assert.strictEqual(st.available, false);
  assert.strictEqual(st.state, 'unavailable');
  assert.strictEqual(st.signedIn, false);
  assert.strictEqual(st.email, null);
  assert.strictEqual(st.reason, 'Google 캘린더 연결은 데스크톱 앱에서만 쓸 수 있어요.');
  const list = await S.host.gcal.list({ calendarId: 'primary' });
  assert.strictEqual(list.ok, false);
  assert.strictEqual(list.error.type, 'unavailable');
  assert.strictEqual(list.error.retryable, false);
  assert.strictEqual(list.error.message, st.reason);
  assert.strictEqual(list.status.available, false);
  for (const fn of ['calendars', 'ensureExportCalendar', 'instances', 'push']) {
    const r = await S.host.gcal[fn]({});
    assert.strictEqual(r.ok, false, fn);
    assert.strictEqual(r.error.type, 'unavailable', fn);
  }
  for (const fn of ['setClient', 'clearClient', 'signIn', 'signOut']) {
    const r = await S.host.google[fn]({});
    assert.strictEqual(r.ok, false, fn);
    assert.strictEqual(r.status.available, false, fn);
  }
  assert.strictEqual((await S.host.google.cancelSignIn()).ok, true);
  assert.doesNotThrow(() => S.host.google.onChanged(() => {}));
  // 돌려준 상태를 고쳐도 다음 응답은 그대로
  st.available = true;
  assert.strictEqual((await S.host.google.status()).available, false);
});

test('브라우저 host: ai.status 사유는 환경변수 이름 없이 데스크톱 앱 안내 (FEATURES §4.2)', async () => {
  const S = loadStore({ location: { search: '' } });
  const st = await S.host.ai.status();
  assert.strictEqual(st.configured, false);
  assert.strictEqual(st.reason, '브라우저 미리보기에서는 AI를 연결할 수 없어요. 데스크톱 앱에서 키를 넣어 주세요.');
  assert.ok(!/GEMINI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY/.test(st.reason));
  // ?fakeai 이면 가짜 AI 로 연결된 것처럼
  const F = loadStore({ location: { search: '?fakeai' } });
  assert.strictEqual((await F.host.ai.status()).provider, 'fake');
});

test('undo 두 번: 라벨 변경만 차례로 되돌리고 그사이의 presence·gcal 변경은 끝까지 남는다', () => {
  const S = loadStore();
  S.mutate('메모 저장', (s) => { M.addNote(s, { title: 'a' }, NOW); });
  S.mutate(null, (s) => { s.presence.current = { id: 'off', label: '퇴근', role: null, since: NOW.toISOString(), source: 'chip', until: null, returnTo: null }; }, { source: 'status' });
  S.mutate('할 일 추가', (s) => { M.addTask(s, { title: 'x' }, NOW); });
  S.mutate(null, (s) => { s.gcal.lastSyncAt = NOW.toISOString(); s.presence.log.push({ id: 'off' }); }, { source: 'gcal', silent: true });
  const gcal = S.state.gcal, presence = S.state.presence;
  assert.strictEqual(S.undo(), '할 일 추가');
  assert.strictEqual(S.state.tasks.length, 0);
  assert.strictEqual(S.state.notes.length, 1);
  assert.strictEqual(S.undo(), '메모 저장');
  assert.strictEqual(S.state.notes.length, 0);
  assert.strictEqual(S.state.gcal, gcal);
  assert.strictEqual(S.state.presence, presence);
  assert.strictEqual(S.state.presence.current.id, 'off');
  assert.strictEqual(S.state.presence.log.length, 1);
  assert.strictEqual(S.state.gcal.lastSyncAt, NOW.toISOString());
  assert.strictEqual(S.undo(), null);
});

test('undo: 지금 상태에 없는 보존 키는 null 로 남기지 않는다', () => {
  const S = loadStore();
  S.mutate('메모 저장', (s) => { M.addNote(s, { title: 'a' }, NOW); });
  S.mutate(null, (s) => { delete s.gcal; }, { silent: true });
  S.undo();
  assert.strictEqual('gcal' in S.state, false);
  assert.ok(S.state.presence && S.state.prefs);
});
