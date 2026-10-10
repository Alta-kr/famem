'use strict';

// 현재 상태 × 빠른 입력 (capture.v7 K·L·M) — STATUS §14, §20.7 #132–141

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/core/model');
const V = require('../src/core/ai/validate');
const P = require('../src/core/ai/proposals');
const C = require('../src/core/ai/capture');
const ST = require('../src/core/status');
const fake = require('../src/core/ai/fake');

const NOW = new Date(2026, 9, 9, 18, 42);   // 금요일 18:42
const NOWHEN = { text: null, date: null, time: null };

function out(patch) {
  return Object.assign({ summary: '', sections: [], tasks: [], events: [], open_questions: [], entry_type: 'task', note_title: '', note_project_hint: null,
    note_kind: 'memo', done_tasks: [], updated_tasks: [], presence: { role: 'none', quote: null } }, patch || {});
}
function aiTask(title, quote, extra) {
  return Object.assign({ title, evidence: { quote, line: 1 }, due: NOWHEN, project_hint: null, basis: 'explicit', size: 'small', breakdown: [],
    do_at: NOWHEN, context: null, do_in: 'none', sched: null }, extra || {});
}
function addNote(st, body, capture) {
  const note = M.addNote(st, { title: '', body, capture: Object.assign({ status: 'pending', at: NOW.toISOString() }, capture || {}) }, NOW);
  note.updatedAt = NOW.toISOString();
  return note;
}
function apply(st, note, output) {
  const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, NOW);
  const v = V.validateOrganizeNote(output, { note, state: st, now: NOW });
  assert.ok(v.ok, v.errors.join());
  return { v, cap: P.applyCapture(st, { note, run, validated: v, output }, NOW) };
}
// 화면 흐름 그대로: buildInput(contexts·statusLine) → 가짜 AI → 검증 → 반영
function viaFake(st, note, opts) {
  const input = C.buildInput(note, Object.assign({ today: '2026-10-09 (금)', projects: [], openTasks: [], contexts: ST.contextHintsForAi(ST.profile(st.prefs)) }, opts || {}));
  const output = fake.organize(input).output;
  return Object.assign({ output, input }, apply(st, note, output));
}
function activate(st) { ST.ensure(st).activatedAt = NOW.toISOString(); }

test('#132 버전 v7 · 스키마: tasks[].context·do_in, presence{role,quote} 가 required 이고 엄격하다', () => {
  assert.equal(C.PROMPT_VERSION, 'capture.v7');
  const item = C.SCHEMA.properties.tasks.items;
  for (const k of ['context', 'do_in', 'sched']) assert.ok(item.required.includes(k), k);
  assert.deepEqual(item.properties.do_in.enum, ['work', 'off', 'out', 'pause', 'rest', 'none']);
  assert.ok(C.SCHEMA.required.includes('presence'));
  assert.deepEqual(C.SCHEMA.properties.presence.required.slice().sort(), ['quote', 'role']);
  assert.equal(C.SCHEMA.properties.presence.additionalProperties, false);
  assert.ok(C.SCHEMA.properties.presence.properties.role.enum.includes('work_end'));
  assert.ok(C.SCHEMA.properties.presence.properties.role.enum.includes('none'));
  (function walk(s) {
    if (s && s.type === 'object') {
      assert.equal(s.additionalProperties, false);
      assert.deepEqual(s.required.slice().sort(), Object.keys(s.properties).sort());
      Object.values(s.properties).forEach(walk);
    }
    if (s && s.items) walk(s.items);
    if (s && s.anyOf) s.anyOf.forEach(walk);
  })(C.SCHEMA);
  for (const r of ['K. 상태 보고', 'L. 맥락', 'M. 걸어 둔 상태']) assert.ok(C.SYSTEM.includes(r), r);
});

test('#133 buildInput: contexts·presenceNow·statusLine. userText 에 상태 보고 줄, presence.log 글은 없다', () => {
  const st = M.emptyState();
  ST.ensure(st).log.push({ id: 'off', label: '비밀 로그 문장', at: NOW.toISOString() });
  const note = addNote(st, '퇴근! 가는 길에 우유 사기', { statusLine: '퇴근!' });
  const contexts = ST.contextHintsForAi(ST.profile(st.prefs));
  const input = C.buildInput(note, { today: '2026-10-09 (금)', projects: [], openTasks: [], contexts, presenceNow: '퇴근 · 내 시간' });
  assert.equal(input.contexts.length, 6);
  assert.deepEqual(Object.keys(input.contexts[0]).sort(), ['hint', 'id', 'label']);
  assert.equal(input.presenceNow, '퇴근 · 내 시간');
  assert.equal(input.statusLine, '퇴근!');            // note.capture.statusLine 에서
  const text = C.userText(input);
  const ctxEnd = text.indexOf('</context>');
  const lines = ['맥락 목록: work=업무(', '지금 상태: 퇴근 · 내 시간', '상태 보고 줄(앱이 이미 처리함 — 할 일로 만들지 말 것): ‘퇴근!’'];
  let prev = -1;
  for (const l of lines) { const i = text.indexOf(l); assert.ok(i > prev && i < ctxEnd, l); prev = i; }
  assert.equal(text.indexOf('비밀 로그 문장'), -1);
  assert.equal(text.indexOf('"log"'), -1);
  // 켜기 전: 지금 상태 없음, 맥락 목록은 늘 보낸다
  const before = C.userText(C.buildInput(addNote(st, '우유 사기'), { today: 'x', projects: [], openTasks: [], contexts }));
  assert.ok(before.includes('맥락 목록:'));
  assert.ok(!before.includes('지금 상태:'));
});

test('#134 검증: 모르는 맥락 → null, do_in 은 근거에 표현이 있을 때만, presence 는 원문·역할·statusLine 조건', () => {
  const st = M.emptyState();
  const note = addNote(st, '퇴근하고 우유 사기\n이제 퇴근함');
  const ok = (o) => V.validateOrganizeNote(o, { note, state: st, now: NOW });
  let v = ok(out({ tasks: [aiTask('우유 사기', '퇴근하고 우유 사기', { context: 'galaxy', do_in: 'off' })], presence: { role: 'work_end', quote: '이제 퇴근함' } }));
  assert.equal(v.items[0].context, null);
  assert.deepEqual(v.items[0].atMode, { mode: 'off', phrase: '퇴근하고' });
  assert.deepEqual(v.presence, { role: 'work_end', quote: '이제 퇴근함', line: 2 });
  v = ok(out({ tasks: [aiTask('우유 사기', '퇴근하고 우유 사기', { context: 'errand', do_in: 'out' })] }));
  assert.equal(v.items[0].context, 'errand');
  assert.equal(v.items[0].atMode, null);                      // quote 에는 '퇴근하고'(off) 뿐
  assert.equal(ok(out({ presence: { role: 'work_end', quote: '집에 도착' } })).presence, null);     // 원문에 없음
  assert.equal(ok(out({ presence: { role: 'dance', quote: '이제 퇴근함' } })).presence, null);      // 역할 밖
  assert.equal(ok(out({ presence: { role: 'none', quote: null } })).presence, null);
  const withLine = addNote(st, '퇴근! 이제 퇴근함', { statusLine: '퇴근!' });
  assert.equal(V.validateOrganizeNote(out({ presence: { role: 'work_end', quote: '이제 퇴근함' } }), { note: withLine, state: st, now: NOW }).presence, null);
});

test('#135 applySelections: AI 맥락은 ai, #태그는 사용자가 이기고 제목에서 뗀다. ‘# 회의록’ 은 태그가 아니다', () => {
  const st = M.emptyState();
  const n1 = addNote(st, '세제 사 오기');
  apply(st, n1, out({ tasks: [aiTask('세제 사 오기', '세제 사 오기', { context: 'errand' })] }));
  const t1 = M.byId(st.tasks, n1.capture.created[0].id);
  assert.deepEqual([t1.context, t1.contextSource], ['errand', 'ai']);

  const n2 = addNote(st, '#집안일 빨래 돌리기');
  apply(st, n2, out({ tasks: [aiTask('#집안일 빨래 돌리기', '#집안일 빨래 돌리기', { context: 'personal' })] }));
  const t2 = M.byId(st.tasks, n2.capture.created[0].id);
  assert.deepEqual([t2.title, t2.context, t2.contextSource], ['빨래 돌리기', 'home', 'user']);

  const n3 = addNote(st, '# 회의록 정리하기');
  apply(st, n3, out({ tasks: [aiTask('# 회의록 정리하기', '# 회의록 정리하기')] }));
  const t3 = M.byId(st.tasks, n3.capture.created[0].id);
  assert.deepEqual([t3.title, t3.context, t3.contextSource], ['# 회의록 정리하기', null, null]);
});

test('#136 applySelections: AI 가 제목에 ‘퇴근하고’ 를 남겨도 떼고 atMode off', () => {
  const st = M.emptyState();
  const n = addNote(st, '퇴근하고 우유 사기');
  apply(st, n, out({ tasks: [aiTask('퇴근하고 우유 사기', '퇴근하고 우유 사기', { do_in: 'off' })] }));
  const t = M.byId(st.tasks, n.capture.created[0].id);
  assert.deepEqual([t.title, t.atMode, t.atModeSource], ['우유 사기', 'off', 'ai']);
  // AI 값이 없으면 규칙(rule)
  const n2 = addNote(st, '퇴근하고 세탁소 들르기');
  apply(st, n2, out({ tasks: [aiTask('퇴근하고 세탁소 들르기', '퇴근하고 세탁소 들르기')] }));
  const t2 = M.byId(st.tasks, n2.capture.created[0].id);
  assert.deepEqual([t2.title, t2.atMode, t2.atModeSource], ['세탁소 들르기', 'off', 'rule']);
});

test('#137 가짜 AI: ‘퇴근하고 우유 사기’ → 할 일 ‘우유 사기’, do_in off, context null, presence none', () => {
  const st = M.emptyState();
  const r = viaFake(st, addNote(st, '퇴근하고 우유 사기'));
  assert.equal(r.output.tasks.length, 1);
  assert.deepEqual([r.output.tasks[0].title, r.output.tasks[0].do_in, r.output.tasks[0].context], ['우유 사기', 'off', null]);
  assert.deepEqual(r.output.presence, { role: 'none', quote: null });
  const t = M.liveTasks(st)[0];
  assert.deepEqual([t.title, t.atMode, t.atModeSource], ['우유 사기', 'off', 'ai']);
});

test('#138 섞인 글: ‘퇴근! 가는 길에 우유 사기’(statusLine 퇴근!) → 본문 그대로, 퇴근 할 일 없음, 우유 사기(out)', () => {
  const st = M.emptyState();
  const note = addNote(st, '퇴근! 가는 길에 우유 사기', { statusLine: '퇴근!' });
  viaFake(st, note);
  assert.equal(note.body, '퇴근! 가는 길에 우유 사기');
  const tasks = M.liveTasks(st);
  assert.equal(tasks.length, 1);
  assert.ok(!tasks.some((t) => /퇴근/.test(t.title)));
  assert.deepEqual([tasks[0].title, tasks[0].atMode], ['우유 사기', 'out']);
  assert.equal(note.capture.statusLine, '퇴근!');
});

test('#139 다시 시도해도 statusLine 이 남아 같은 결과', () => {
  const st = M.emptyState();
  const note = addNote(st, '퇴근! 가는 길에 우유 사기', { statusLine: '퇴근!' });
  viaFake(st, note);
  const first = M.liveTasks(st).map((t) => [t.title, t.atMode]);
  // 다시 시도: 화면이 note 를 다시 보낸다 (opts.statusLine 없이도 note.capture 에서 읽는다)
  note.capture = Object.assign({}, note.capture, { status: 'pending' });
  const again = viaFake(st, note);
  assert.equal(again.input.statusLine, '퇴근!');
  assert.equal(note.capture.statusLine, '퇴근!');
  assert.deepEqual(M.liveTasks(st).map((t) => [t.title, t.atMode]), first);
});

test('#140 AI presence + 기능 켜짐 + 예산 → statusHint 만 저장, presence.current 그대로. 예산 없음·켜기 전이면 없음', () => {
  const st = M.emptyState();
  activate(st);
  const cur = ST.ensure(st).current;
  const n = addNote(st, '이제 퇴근함');
  apply(st, n, out({ entry_type: 'memo', presence: { role: 'work_end', quote: '이제 퇴근함' } }));
  assert.equal(n.capture.statusHint.from, 'ai');
  assert.equal(n.capture.statusHint.role, 'work_end');
  assert.equal(n.capture.statusHint.id, 'off');
  assert.ok(n.capture.statusHint.label);
  assert.equal(n.capture.statusHint.quote, '이제 퇴근함');
  assert.equal(ST.ensure(st).current, cur);                  // 상태는 바꾸지 않는다
  assert.equal(ST.budgetOk(st, ST.profile(st.prefs), NOW), false);
  // 예산을 다 쓴 뒤
  const n2 = addNote(st, '이제 퇴근함');
  apply(st, n2, out({ entry_type: 'memo', presence: { role: 'work_end', quote: '이제 퇴근함' } }));
  assert.equal(n2.capture.statusHint, undefined);
  // 켜기 전
  const st2 = M.emptyState();
  const n3 = addNote(st2, '이제 퇴근함');
  apply(st2, n3, out({ entry_type: 'memo', presence: { role: 'work_end', quote: '이제 퇴근함' } }));
  assert.equal(n3.capture.statusHint, undefined);
  // 앱이 이미 상태 줄을 처리했으면 없음
  const st3 = M.emptyState();
  activate(st3);
  const n4 = addNote(st3, '퇴근! 이제 퇴근함', { statusLine: '퇴근!' });
  apply(st3, n4, out({ entry_type: 'memo', presence: { role: 'work_end', quote: '이제 퇴근함' } }));
  assert.equal(n4.capture.statusHint, undefined);
});

test('#141 할 일 → 일정 → 할 일 왕복 뒤에도 context·contextSource·atMode·atModeSource 가 남는다', () => {
  const st = M.emptyState();
  const n = addNote(st, '퇴근하고 #집안일 빨래 돌리기');
  apply(st, n, out({ tasks: [aiTask('퇴근하고 #집안일 빨래 돌리기', '퇴근하고 #집안일 빨래 돌리기', { do_in: 'off' })] }));
  const t0 = M.byId(st.tasks, n.capture.created[0].id);
  const want = [t0.context, t0.contextSource, t0.atMode, t0.atModeSource];
  assert.deepEqual(want, ['home', 'user', 'off', 'ai']);
  P.captureSetKind(st, n.id, 'event', NOW);
  assert.equal(n.capture.created[0].kind, 'block');
  P.captureSetKind(st, n.id, 'task', NOW);
  const t1 = M.byId(st.tasks, n.capture.created[0].id);
  assert.notEqual(t1.id, t0.id);
  assert.deepEqual([t1.context, t1.contextSource, t1.atMode, t1.atModeSource], want);
});

test('가짜 AI: 상태 문장은 글 머리 한 곳에서만 뺀다 — 다음 줄의 ‘퇴근하고·퇴근길에’ 는 그대로 걸어 둔 상태', () => {
  const st = M.emptyState();
  viaFake(st, addNote(st, '퇴근!\n퇴근하고 우유 사기', { statusLine: '퇴근!' }));
  assert.deepEqual(M.liveTasks(st).map((t) => [t.title, t.atMode]), [['우유 사기', 'off']]);
  const st2 = M.emptyState();
  viaFake(st2, addNote(st2, '퇴근\n퇴근길에 우유 사기', { statusLine: '퇴근' }));
  assert.deepEqual(M.liveTasks(st2).map((t) => [t.title, t.atMode]), [['우유 사기', 'out']]);
});
