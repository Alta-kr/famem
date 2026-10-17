'use strict';
// renderer/store.js 는 브라우저용 IIFE 라 window·localStorage 를 흉내 내고 vm 으로 불러온다.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('../src/core/model');

function loadStore() {
  const mem = {};
  const localStorage = {
    getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; }
  };
  const window = { Daynote: { model: M }, addEventListener() {} };
  const ctx = vm.createContext({ window, localStorage, setTimeout() { return 0; }, clearTimeout() {}, console, JSON, Promise, Date });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/store.js'), 'utf8'), ctx);
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

test('다시 실행: 되돌린 것을 다시, 새 작업을 하면 다시 실행할 것이 없어진다, 화면 설정은 그대로', () => {
  const S = loadStore();
  S.mutate('메모 1', (s) => { M.addNote(s, { title: 'a' }); });
  S.mutate('메모 2', (s) => { M.addNote(s, { title: 'b' }); });
  assert.strictEqual(S.canRedo(), false);
  assert.strictEqual(S.undo(), '메모 2');
  assert.strictEqual(S.undo(), '메모 1');
  assert.strictEqual(S.state.notes.length, 0);
  assert.strictEqual(S.canRedo(), true);
  S.mutate(null, (s) => { s.prefs.reduceMotion = true; }, { silent: true });
  assert.strictEqual(S.redo(), '메모 1');
  assert.deepStrictEqual(S.state.notes.map((n) => n.title), ['a']);
  assert.strictEqual(S.state.prefs.reduceMotion, true);                 // 화면 설정은 지금 값
  assert.strictEqual(S.redo(), '메모 2');
  assert.strictEqual(S.state.notes.length, 2);
  assert.strictEqual(S.redo(), null);
  // 되돌린 뒤 새 작업 → 다시 실행 목록 비움
  S.undo();
  S.mutate('메모 3', (s) => { M.addNote(s, { title: 'c' }); });
  assert.strictEqual(S.canRedo(), false);
  assert.strictEqual(S.undo(), '메모 3');
  assert.strictEqual(S.undo(), '메모 1');                              // '메모 2' 를 되돌린 기록 다음은 메모 1
});

test('되돌리기 묶기: 보낸 글 · 메모 저장 · AI 정리 · 명령이 Ctrl+Z 한 번에 통째로 (중간에서 멈추지 않게)', () => {
  const S = loadStore();
  S.mutate('할 일 추가', (s) => { M.addTask(s, { title: '이전 작업' }); });
  S.mutate('보낸 글', (s) => { s.chat = (s.chat || []).concat([{ id: 'u1', role: 'user', text: '사내 세미나 관련 할일은 마감 하루 미뤄줘' }]); }, { key: 'send1' });
  const note = S.mutate('입력 저장', (s) => M.addNote(s, { body: 'x', capture: { status: 'pending' } }), { key: 'send1', join: 'send1' });
  S.mutate(null, (s) => { s.chat.push({ id: 'c1', kind: 'capture', noteId: note.id }); });
  S.mutate('AI 분류', (s) => { M.byId(s.notes, note.id).capture.status = 'done'; M.addTask(s, { title: 'AI가 만든 일' }); }, { join: 'send1' });
  S.withJoin('send1', () => { S.mutate('삭제', (s) => { s.tasks[0].title = '명령으로 바뀜'; }); });
  assert.strictEqual(S.undo(), '보낸 글');
  assert.deepStrictEqual(S.state.tasks.map((t) => t.title), ['이전 작업']);
  assert.strictEqual(S.state.notes.length, 0);
  assert.strictEqual((S.state.chat || []).length, 0);
  assert.strictEqual(S.undo(), '할 일 추가');
  // 다시 실행도 통째로
  S.redo();
  assert.strictEqual(S.redo(), '보낸 글');
  assert.strictEqual(S.state.notes[0].capture.status, 'done');
  assert.strictEqual(S.state.tasks.length, 2);
});

test('되돌리기 묶기: 사이에 다른 작업이 끼면 합치지 않는다', () => {
  const S = loadStore();
  S.mutate('보낸 글', (s) => { M.addNote(s, { body: 'x', capture: { status: 'pending' } }); }, { key: 'k' });
  S.mutate('완료', (s) => { M.addTask(s, { title: '다른 일' }); });
  S.mutate('AI 분류', (s) => { s.notes[0].capture.status = 'done'; }, { join: 'k' });
  assert.strictEqual(S.undo(), 'AI 분류');
  assert.strictEqual(S.state.notes[0].capture.status, 'pending');   // 이 상태는 capture.settleOrphans 가 '다시 시도' 로 푼다
  assert.strictEqual(S.undo(), '완료');
  assert.strictEqual(S.undo(), '보낸 글');
});
