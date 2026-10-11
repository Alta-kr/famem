'use strict';
// 백업 가져오기 — model.validateBackup(검사·정리) 과 store.importBackup(덮어쓰기 + 한 번에 되돌리기)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('../src/core/model');

const NOW = new Date(2026, 9, 9, 18, 42);

function sampleState() {
  const s = M.emptyState();
  const p = M.addProject(s, { name: '홈페이지' }, NOW);
  M.addNote(s, { title: '회의 메모', projectId: p && p.id }, NOW);
  M.addNote(s, { title: '두 번째' }, NOW);
  M.addTask(s, { title: '시안 보내기', projectId: p && p.id }, NOW);
  return s;
}

function loadStore() {
  const mem = {};
  const localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
  const window = { Daynote: { model: M }, addEventListener() {} };
  const ctx = vm.createContext({ window, localStorage, setTimeout() { return 0; }, clearTimeout() {}, console, JSON, Promise, Date });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/store.js'), 'utf8'), ctx);
  window.Daynote.store.__mem = mem;
  window.Daynote.store.__win = window;
  return window.Daynote.store;
}

// ───────────────────────────── validateBackup ─────────────────────────────

test('validateBackup: 내보낸 JSON 문자열을 그대로 받아 개수와 정리된 상태를 돌려준다', () => {
  const s = sampleState();
  const v = M.validateBackup(JSON.stringify(s, null, 2));
  assert.strictEqual(v.ok, true);
  assert.deepStrictEqual(v.counts, { memos: 2, tasks: 1, projects: 1 });
  assert.strictEqual(v.version, M.SCHEMA_VERSION);
  assert.strictEqual(v.state.version, M.SCHEMA_VERSION);
  assert.ok(v.state.notes.some((n) => n.title === '회의 메모'));
  assert.strictEqual(v.stripped, 0);
});

test('validateBackup: 이미 읽은 객체도 받고, 입력은 바꾸지 않는다 (깊은 복제)', () => {
  const s = sampleState();
  s.gcal.accessToken = 'ya29.secret';
  const before = JSON.stringify(s);
  const v = M.validateBackup(s);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(JSON.stringify(s), before);
  assert.notStrictEqual(v.state.notes, s.notes);
  assert.ok(!('accessToken' in v.state.gcal));
});

test('validateBackup: 개수는 지운 항목을 빼고 센다', () => {
  const s = sampleState();
  s.notes[1].deletedAt = NOW.toISOString();
  s.projects[0].deletedAt = NOW.toISOString();
  assert.deepStrictEqual(M.validateBackup(s).counts, { memos: 1, tasks: 1, projects: 0 });
});

test('validateBackup: UTF-8 BOM 이 붙은 파일도 읽는다', () => {
  assert.strictEqual(M.validateBackup('﻿' + JSON.stringify(M.emptyState())).ok, true);
});

test('validateBackup: JSON 이 아니면 parse', () => {
  const v = M.validateBackup('{ not json');
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.code, 'parse');
  assert.match(v.error, /JSON/);
  assert.strictEqual(M.validateBackup('').code, 'parse');
});

test('validateBackup: Daynote 모양이 아니면 shape', () => {
  for (const bad of ['[]', '"hi"', '42', 'null', '{}', JSON.stringify({ name: 'other app' })]) {
    const v = M.validateBackup(bad);
    assert.strictEqual(v.ok, false, bad);
    assert.strictEqual(v.code, 'shape', bad);
  }
  // 버전이 숫자가 아님 · 0 · 소수
  for (const ver of ['4', 0, 2.5, null]) {
    const s = M.emptyState(); s.version = ver;
    assert.strictEqual(M.validateBackup(s).code, 'shape', String(ver));
  }
});

test('validateBackup: 필수 목록(projects·notes·tasks)이 없거나 목록이 아니면 shape', () => {
  for (const k of ['projects', 'notes', 'tasks']) {
    const s = M.emptyState(); delete s[k];
    const v = M.validateBackup(s);
    assert.strictEqual(v.code, 'shape', k);
    assert.ok(v.error.includes({ projects: '프로젝트', notes: '메모', tasks: '할 일' }[k] + ' 목록이 없어요'), v.error);
    assert.ok(!v.error.includes(k), v.error);                 // 내부 키 이름은 보이지 않는다
    const s2 = M.emptyState(); s2[k] = { a: 1 };
    assert.strictEqual(M.validateBackup(s2).code, 'shape', k);
  }
});

test('validateBackup: 다른 목록 키가 목록이 아니면 망가진 파일로 알린다 (조용히 비우지 않는다)', () => {
  const s = M.emptyState(); s.blocks = 'oops';
  const v = M.validateBackup(s);
  assert.strictEqual(v.code, 'shape');
  assert.ok(v.error.includes('일정'), v.error);
  assert.ok(!v.error.includes('blocks'), v.error);
});

test('validateBackup: 다른 목록(기록·대화 등)에 객체가 아닌 항목이 있어도 items', () => {
  const s = sampleState(); s.history = [null];
  const v = M.validateBackup(s);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.code, 'items');
  assert.match(v.error, /기록 1번째/);
  for (const k of ['suggestions', 'emails', 'reports', 'aiRuns', 'proposals', 'noteDigests', 'chat']) {
    const s2 = sampleState(); s2[k] = [{ id: 'x' }, 'oops'];
    const v2 = M.validateBackup(s2);
    assert.strictEqual(v2.code, 'items', k);
    assert.match(v2.error, /2번째 항목/, k);
    assert.ok(!v2.error.includes(k), v2.error);
  }
  // id 가 없는 대화·기록 항목은 괜찮다 (객체이기만 하면 된다)
  const s3 = sampleState(); s3.chat = [{ role: 'user', text: 'hi' }];
  assert.strictEqual(M.validateBackup(s3).ok, true);
});

test('validateBackup: 할 일 안의 목록 칸(steps·sources·blockedBy)이 목록이 아니면 items', () => {
  for (const f of ['steps', 'sources', 'blockedBy']) {
    const s = sampleState(); s.tasks[0][f] = 'x';
    const v = M.validateBackup(s);
    assert.strictEqual(v.code, 'items', f);
    assert.match(v.error, /할 일 1번째/, f);
  }
  const ok = sampleState(); delete ok.tasks[0].steps;
  assert.strictEqual(M.validateBackup(ok).ok, true);
});

test('validateBackup: 더 새 스키마 버전이면 newer', () => {
  const s = M.emptyState(); s.version = M.SCHEMA_VERSION + 1;
  const v = M.validateBackup(s);
  assert.strictEqual(v.code, 'newer');
  assert.match(v.error, /업데이트/);
});

test('validateBackup: 옛 버전(1) 백업은 normalize 로 빠진 칸을 채워 받는다', () => {
  const old = { version: 1, projects: [], notes: [{ id: 'n1', title: '옛 메모', body: '', createdAt: NOW.toISOString() }], tasks: [{ id: 't1', title: '옛 할 일', status: 'todo' }] };
  const v = M.validateBackup(JSON.stringify(old));
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.state.version, M.SCHEMA_VERSION);
  assert.ok(Array.isArray(v.state.chat));
  assert.ok(v.state.gcal && Array.isArray(v.state.gcal.events));
  assert.ok(v.state.presence && Array.isArray(v.state.presence.log));
  assert.deepStrictEqual(v.counts, { memos: 1, tasks: 1, projects: 0 });
});

test('validateBackup: id 없는 항목·객체가 아닌 항목이 있으면 items (몇 번째인지 알린다)', () => {
  const s = sampleState(); s.tasks.push({ title: 'id 없음' });
  const v = M.validateBackup(s);
  assert.strictEqual(v.code, 'items');
  assert.match(v.error, /할 일 2번째/);
  const s2 = sampleState(); s2.notes.unshift('글자');
  assert.match(M.validateBackup(s2).error, /메모 1번째/);
  const s3 = sampleState(); s3.blocks = [null];
  assert.strictEqual(M.validateBackup(s3).code, 'items');
});

test('validateBackup: Google 로그인 토큰·비밀값은 어디에 있든 가져오지 않는다', () => {
  const s = sampleState();
  s.gcal.accountId = 'acct_1';
  s.gcal.tokens = { access_token: 'ya29.x', refresh_token: '1//y' };
  s.gcal.refreshToken = '1//z';
  s.gcal.calendars = [{ id: 'primary', syncToken: 'CPDAlvWDx8kCEPDAlvWDx8kCGAU=', idToken: 'eyJ' }];
  s.emailConnection.oauth = { code: 'abc' };
  s.prefs.clientSecret = 'GOCSPX-xxx';
  s.meta.apiKey = 'sk-ant-xxx';
  s.googleTokens = { refresh_token: 'top' };          // 모르는 최상위 키 — normalize 가 버린다
  const v = M.validateBackup(JSON.stringify(s));
  assert.strictEqual(v.ok, true);
  const out = JSON.stringify(v.state);
  for (const leak of ['ya29', '1//y', '1//z', 'eyJ', 'GOCSPX', 'sk-ant', 'top', '"oauth"']) assert.ok(!out.includes(leak), leak);
  assert.ok(v.stripped >= 6, String(v.stripped));
  // 로그인 정보가 아닌 값은 남는다 — 계정 표시(accountId)·동기화 위치(syncToken)
  assert.strictEqual(v.state.gcal.accountId, 'acct_1');
  assert.strictEqual(v.state.gcal.calendars[0].syncToken, 'CPDAlvWDx8kCEPDAlvWDx8kCGAU=');
});

test('validateBackup: 사용자 글 안의 token 이라는 키(명령 토큰 등)는 지우지 않는다', () => {
  const s = sampleState();
  s.chat = [{ id: 'c1', role: 'user', text: '/할일 a', command: { name: 'todo', token: '/할일' } }];
  const v = M.validateBackup(s);
  assert.strictEqual(v.state.chat[0].command.token, '/할일');
  assert.strictEqual(v.stripped, 0);
});

test('backupCounts: 상태가 아니면 0개', () => {
  assert.deepStrictEqual(M.backupCounts(null), { memos: 0, tasks: 0, projects: 0 });
  assert.deepStrictEqual(M.backupCounts(sampleState()), { memos: 2, tasks: 1, projects: 1 });
});

// ───────────────────────────── store.importBackup ─────────────────────────────

test('importBackup: 데이터를 통째로 바꾸고 load 를 알린다 · 현재 상태(presence)는 이 기기 값을 둔다', () => {
  const S = loadStore();
  S.mutate('메모 저장', (s) => { M.addNote(s, { title: '지금 메모' }, NOW); });
  S.mutate(null, (s) => { s.presence.activatedAt = NOW.toISOString(); s.prefs.theme = 'dark'; });
  const pres = S.state.presence;
  const events = [];
  S.subscribe((i) => events.push(i));
  const b = sampleState();
  b.prefs.theme = 'light';
  b.presence.activatedAt = '2020-01-01T00:00:00.000Z';
  const v = M.validateBackup(JSON.stringify(b));
  assert.strictEqual(S.importBackup(v.state), '백업 가져오기');
  assert.deepStrictEqual(S.state.notes.map((n) => n.title).sort(), ['두 번째', '회의 메모']);
  assert.strictEqual(S.state.prefs.theme, 'light');          // 백업의 설정을 가져온다
  assert.strictEqual(S.state.presence, pres);                // 현재 상태는 그대로
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].type, 'load');
  assert.strictEqual(events[0].source, 'import');
});

test('importBackup: 되돌리기 한 번으로 가져오기 전 상태 전체(prefs·gcal 포함)로 돌아가고, 옛 되돌리기는 지운다', () => {
  const S = loadStore();
  S.mutate('메모 저장', (s) => { M.addNote(s, { title: '원래 메모' }, NOW); });
  S.mutate('할 일 추가', (s) => { M.addTask(s, { title: '원래 할 일' }, NOW); });
  S.mutate(null, (s) => { s.prefs.theme = 'dark'; s.gcal.lastSyncAt = NOW.toISOString(); });
  const b = sampleState();
  b.gcal.lastSyncAt = '2020-01-01T00:00:00.000Z';
  S.importBackup(M.validateBackup(b).state);
  assert.strictEqual(S.peekUndo().label, '백업 가져오기');
  assert.strictEqual(S.state.gcal.lastSyncAt, '2020-01-01T00:00:00.000Z');
  const events = [];
  S.subscribe((i) => events.push(i));
  assert.strictEqual(S.undo(), '백업 가져오기');
  assert.deepStrictEqual(S.state.notes.map((n) => n.title), ['원래 메모']);
  assert.deepStrictEqual(S.state.tasks.map((t) => t.title), ['원래 할 일']);
  assert.strictEqual(S.state.prefs.theme, 'dark');
  assert.strictEqual(S.state.gcal.lastSyncAt, NOW.toISOString());
  assert.strictEqual(events[0].type, 'load');                // 캘린더 동기화가 전체 회차로 다시 맞추게
  assert.strictEqual(S.canUndo(), false);                    // 가져오기 전 되돌리기 항목은 남지 않는다
});

test('importBackup: 가져온 뒤 고친 것은 평소처럼 되돌리고, 그다음 되돌리기가 가져오기를 취소한다', () => {
  const S = loadStore();
  S.mutate('메모 저장', (s) => { M.addNote(s, { title: '원래' }, NOW); });
  S.importBackup(M.validateBackup(sampleState()).state);
  S.mutate('메모 저장', (s) => { M.addNote(s, { title: '가져온 뒤' }, NOW); });
  assert.strictEqual(S.state.notes.length, 3);
  assert.strictEqual(S.undo(), '메모 저장');
  assert.strictEqual(S.state.notes.length, 2);
  assert.strictEqual(S.undo(), '백업 가져오기');
  assert.deepStrictEqual(S.state.notes.map((n) => n.title), ['원래']);
});

test('importBackup: 저장소에 가져온 데이터가 쓰이고 토큰은 남지 않는다', async () => {
  const S = loadStore();
  const b = sampleState();
  b.gcal.refresh_token = 'secret-r';
  S.importBackup(M.validateBackup(JSON.stringify(b)).state);
  await S.flush();
  const saved = JSON.parse(S.__mem['daynote:data']);
  assert.strictEqual(saved.notes.length, 2);
  assert.ok(!JSON.stringify(saved).includes('secret-r'));
});

test('importBackup: Google 동기화 커서를 비우고 보낼 목록을 비운다 (옛 syncToken 의 삭제가 가져온 블록을 지우지 않게)', () => {
  const S = loadStore();
  const b = sampleState();
  b.gcal.calendars = [{ id: 'primary', syncToken: 'OLD', fullSyncAt: '2026-01-01T00:00:00.000Z', windowStart: 'a', windowEnd: 'b', nextPullAt: 'c' }, null];
  b.gcal.outbox = [{ id: 'op:blk_1', op: 'delete', blockId: 'blk_1' }];
  b.gcal.links = { blk_1: { eventId: 'e1', hash: 'h' } };
  S.importBackup(M.validateBackup(b).state);
  const c = S.state.gcal.calendars[0];
  assert.strictEqual(c.syncToken, null);
  assert.strictEqual(c.fullSyncAt, null);
  assert.strictEqual(c.windowEnd, null);
  assert.strictEqual(c.nextPullAt, null);
  assert.strictEqual(c.id, 'primary');
  assert.strictEqual(S.state.gcal.outbox.length, 0);
  assert.ok(S.state.gcal.links.blk_1);                        // 링크는 둔다 — 전체 회차가 다시 맞춘다
});

test('importBackup 되돌리기: 가져오기 전 링크는 돌아오고 커서는 비운다 (전체 회차로 다시 맞춘다)', () => {
  const S = loadStore();
  S.mutate(null, (s) => {
    s.gcal.calendars = [{ id: 'primary', syncToken: 'FRESH', fullSyncAt: NOW.toISOString() }];
    s.gcal.links = { blk_me: { eventId: 'e9', hash: 'h9' } };
  });
  S.importBackup(M.validateBackup(sampleState()).state);
  assert.strictEqual(S.undo(), '백업 가져오기');
  assert.ok(S.state.gcal.links.blk_me);
  assert.strictEqual(S.state.gcal.calendars[0].syncToken, null);
  assert.strictEqual(S.state.gcal.calendars[0].fullSyncAt, null);
});

test('importBackup: 브라우저 저장이 실패하면 flush 가 false — 되돌리면 옛 데이터가 저장된다', async () => {
  const S = loadStore();
  S.mutate('메모 저장', (s) => { M.addNote(s, { title: '원래' }, NOW); });
  await S.flush();
  const entry = (S.importBackup(M.validateBackup(sampleState()).state), S.peekUndo());
  S.__win.__daynoteFailSave = true;
  const ok = await S.flush();
  assert.strictEqual(ok, false);
  S.__win.__daynoteFailSave = false;
  assert.strictEqual(S.peekUndo(), entry);
  S.undo();
  assert.strictEqual(await S.flush(), true);
  const saved = JSON.parse(S.__mem['daynote:data']);
  assert.deepStrictEqual(saved.notes.map((n) => n.title), ['원래']);
  assert.ok(!('daynote:unsaved' in S.__mem));
});
