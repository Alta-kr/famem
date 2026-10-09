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
