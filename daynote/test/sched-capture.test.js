'use strict';

// 배치 힌트(sched) × 빠른 입력 — CAL §8, §12.3 #67–74

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/core/model');
const V = require('../src/core/ai/validate');
const P = require('../src/core/ai/proposals');
const C = require('../src/core/ai/capture');
const F = require('../src/core/ai/forced');
const fake = require('../src/core/ai/fake');

const NOW = new Date(2026, 9, 5, 10, 0);
const NOWHEN = { text: null, date: null, time: null };
const NOSCHED = { focus: null, energy: null, prefer: null, splittable: null, minutes: null };

function out(patch) {
  return Object.assign({ summary: '', sections: [], tasks: [], events: [], open_questions: [], entry_type: 'task', note_title: '', note_project_hint: null,
    note_kind: 'memo', done_tasks: [], updated_tasks: [], presence: { role: 'none', quote: null } }, patch || {});
}
function aiTask(title, quote, extra) {
  return Object.assign({ title, evidence: { quote, line: 1 }, due: NOWHEN, project_hint: null, basis: 'explicit', size: 'small', breakdown: [],
    do_at: NOWHEN, context: null, do_in: 'none', sched: NOSCHED }, extra || {});
}
function addNote(st, body, capture) {
  const note = M.addNote(st, { title: '', body, capture: Object.assign({ status: 'pending', at: NOW.toISOString() }, capture || {}) }, NOW);
  note.updatedAt = NOW.toISOString();
  return note;
}
function validate(st, note, output) { return V.validateOrganizeNote(output, { note, state: st, now: NOW }); }
function apply(st, note, output) {
  const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, NOW);
  const v = validate(st, note, output);
  assert.ok(v.ok, v.errors.join());
  P.applyCapture(st, { note, run, validated: v, output }, NOW);
  return M.byId(st.tasks, note.capture.created[0].id);
}

test('#67 스키마: sched 다섯 속성이 required 이고 엄격성 검사를 통과한다', () => {
  const sched = C.SCHEMA.properties.tasks.items.properties.sched;
  assert.equal(sched.type, 'object');
  assert.equal(sched.additionalProperties, false);
  assert.deepEqual(sched.required.slice().sort(), ['energy', 'focus', 'minutes', 'prefer', 'splittable']);
  assert.ok(C.SCHEMA.properties.tasks.items.required.includes('sched'));
  assert.deepEqual(sched.properties.focus.anyOf[0].enum, ['deep', 'light']);
  assert.deepEqual(sched.properties.prefer.anyOf[0].enum, ['morning', 'afternoon', 'evening']);
  assert.equal(sched.properties.splittable.anyOf[0].type, 'boolean');
  assert.equal(sched.properties.minutes.anyOf[0].type, 'integer');
});

test('#68 검증: enum 밖 → null, 시각 정한 할 일의 prefer → null, 다섯 다 null 이면 sched === null', () => {
  const st = M.emptyState();
  const note = addNote(st, '보고서 쓰기\n3시에 운동하기');
  const v = validate(st, note, out({ tasks: [
    aiTask('보고서 쓰기', '보고서 쓰기', { sched: { focus: 'deep', energy: 'loud', prefer: 'night', splittable: 'yes', minutes: null } }),
    aiTask('운동하기', '3시에 운동하기', { do_at: { text: '3시에', date: '2026-10-05', time: '15:00' }, sched: { focus: null, energy: 'high', prefer: 'evening', splittable: true, minutes: null } }),
    aiTask('보고서 쓰기', '보고서 쓰기', { sched: { focus: 'huge', energy: null, prefer: null, splittable: null, minutes: null } })
  ] }));
  assert.deepEqual(v.items[0].sched, { focus: 'deep', energy: null, prefer: null, splittable: null, minutes: null });
  const ex = v.items.find((i) => i.title === '운동하기');
  assert.deepEqual(ex.sched, { focus: null, energy: 'high', prefer: null, splittable: true, minutes: null });
  assert.equal(v.items[2].sched, null);
});

test('#69 검증 minutes: 근거에 같은 길이 표현이 있을 때만 (‘1시간 반’ → 90)', () => {
  const st = M.emptyState();
  const note = addNote(st, '보고서 1시간 반 걸릴 듯\n메일 정리하기\n30분 후 샤워하기');
  const v = validate(st, note, out({ tasks: [
    aiTask('보고서 쓰기', '보고서 1시간 반 걸릴 듯', { evidence: { quote: '보고서 1시간 반 걸릴 듯', line: 1 }, sched: Object.assign({}, NOSCHED, { minutes: 90 }) }),
    aiTask('메일 정리하기', '메일 정리하기', { evidence: { quote: '메일 정리하기', line: 2 }, sched: Object.assign({}, NOSCHED, { minutes: 30 }) }),
    aiTask('보고서', '보고서 1시간 반 걸릴 듯', { evidence: { quote: '보고서 1시간 반 걸릴 듯', line: 1 }, sched: Object.assign({}, NOSCHED, { minutes: 700000 }) }),
    aiTask('샤워하기', '30분 후 샤워하기', { evidence: { quote: '30분 후 샤워하기', line: 3 }, sched: Object.assign({}, NOSCHED, { minutes: 30 }) })
  ] }));
  assert.equal(v.items[0].sched.minutes, 90);
  assert.equal(v.items[1].sched, null);
  assert.equal(v.items[2].sched, null);
  assert.equal(v.items[3].sched, null);           // '30분 후' 는 시각이지 걸리는 시간이 아니다
});

test('#70 proposals: 새 할 일에 schedHints(source ai), 사용자 힌트는 그대로, minutes 는 예상이 비었을 때만', () => {
  const st = M.emptyState();
  const t = apply(st, addNote(st, '분기 보고서 1시간 반 걸릴 듯'), out({ tasks: [aiTask('분기 보고서 쓰기', '분기 보고서 1시간 반 걸릴 듯',
    { sched: { focus: 'deep', energy: null, prefer: 'morning', splittable: true, minutes: 90 } })] }));
  assert.deepEqual(t.schedHints, { focus: 'deep', energy: null, prefer: 'morning', splittable: true, source: 'ai', at: NOW.toISOString() });
  assert.deepEqual([t.estimateMinutes, t.estimateSource], [90, 'ai']);
  // 힌트 칸이 모두 비면 schedHints 를 만들지 않는다 (minutes 만)
  const t2 = apply(st, addNote(st, '메일 답장 30분 걸림'), out({ tasks: [aiTask('메일 답장', '메일 답장 30분 걸림', { sched: Object.assign({}, NOSCHED, { minutes: 30 }) })] }));
  assert.equal(t2.schedHints, null);
  assert.equal(t2.estimateMinutes, 30);
  // 사용자 힌트·사용자 예상이 있는 할 일 (늦게 온 결과 — 다듬기 경로)
  const note = addNote(st, '분기 보고서 1시간 반 걸릴 듯', { entryType: null, created: [], command: { name: 'todo', kind: 'task', token: '/할일', raw: '/할일 분기 보고서 1시간 반 걸릴 듯' } });
  F.createForced(st, note, NOW);
  const ft = M.byId(st.tasks, note.capture.created[0].id);
  const userHints = { focus: 'light', energy: null, prefer: null, splittable: null, source: 'user', at: NOW.toISOString() };
  ft.schedHints = Object.assign({}, userHints);
  ft.estimateMinutes = 45; ft.estimateSource = 'user';
  const run = P.startRun(st, { noteId: note.id, kind: 'capture' }, NOW);
  const output = out({ tasks: [aiTask('분기 보고서', '분기 보고서 1시간 반 걸릴 듯', { sched: { focus: 'deep', energy: 'high', prefer: null, splittable: null, minutes: 90 } })] });
  F.refineForced(st, { note, run, validated: validate(st, note, output), output }, NOW);
  assert.deepEqual(ft.schedHints, userHints);
  assert.deepEqual([ft.estimateMinutes, ft.estimateSource], [45, 'user']);
});

test('#71 할 일 → 일정 → 할 일 왕복에도 schedHints 가 남는다 (TASK_KEEP)', () => {
  const st = M.emptyState();
  const note = addNote(st, '분기 보고서 1시간 반 걸릴 듯');
  const t0 = apply(st, note, out({ tasks: [aiTask('분기 보고서 쓰기', '분기 보고서 1시간 반 걸릴 듯', { sched: Object.assign({}, NOSCHED, { focus: 'deep' }) })] }));
  const want = JSON.parse(JSON.stringify(t0.schedHints));
  assert.ok(P.TASK_KEEP.includes('schedHints'));
  P.captureSetKind(st, note.id, 'event', NOW);
  P.captureSetKind(st, note.id, 'task', NOW);
  const t1 = M.byId(st.tasks, note.capture.created[0].id);
  assert.notEqual(t1.id, t0.id);
  assert.deepEqual(t1.schedHints, want);
});

test('#72 가짜 AI: capture 출력에 sched — ‘30분 걸리는 빨래 개기’ 는 minutes 30, 나머지는 null', () => {
  const st = M.emptyState();
  const note = addNote(st, '내일까지 30분 걸리는 빨래 개기');
  const input = C.buildInput(note, { today: '2026-10-05 (월)', projects: [], openTasks: [] });
  const o = fake.organize(input).output;
  assert.equal(o.tasks.length, 1);
  assert.deepEqual(o.tasks[0].sched, { focus: null, energy: null, prefer: null, splittable: null, minutes: 30 });
  const plain = fake.organize(C.buildInput(addNote(st, '내일까지 견적서 보내기'), { today: '2026-10-05 (월)', projects: [], openTasks: [] })).output;
  assert.deepEqual(plain.tasks[0].sched, NOSCHED);
  // 메모 정리(capture 가 아님)에는 sched 를 넣지 않는다
  const organize = fake.organize(Object.assign({}, input, { purpose: undefined })).output;
  assert.ok(organize.tasks.every((t) => !('sched' in t)));
  // 전체 경로: 예상 소요 시간 30분(ai)
  const t = apply(st, note, o);
  assert.deepEqual([t.estimateMinutes, t.estimateSource, t.schedHints], [30, 'ai', null]);
});

test('#73 refineForced: schedHints 가 비어 있을 때만 옮긴다', () => {
  const st = M.emptyState();
  const note = addNote(st, '분기 보고서 쓰기', { entryType: null, created: [], command: { name: 'todo', kind: 'task', token: '/할일', raw: '/할일 분기 보고서 쓰기' } });
  F.createForced(st, note, NOW);
  const t = M.byId(st.tasks, note.capture.created[0].id);
  assert.equal(t.schedHints, null);
  const output = out({ tasks: [aiTask('분기 보고서 쓰기', '분기 보고서 쓰기', { sched: Object.assign({}, NOSCHED, { focus: 'deep', splittable: true }) })] });
  const run = P.startRun(st, { noteId: note.id, kind: 'capture' }, NOW);
  F.refineForced(st, { note, run, validated: validate(st, note, output), output }, NOW);
  assert.deepEqual(t.schedHints, { focus: 'deep', energy: null, prefer: null, splittable: true, source: 'ai', at: NOW.toISOString() });
  // 이미 있으면(다시 다듬기) 덮지 않는다
  const output2 = out({ tasks: [aiTask('분기 보고서 쓰기', '분기 보고서 쓰기', { sched: Object.assign({}, NOSCHED, { focus: 'light' }) })] });
  F.refineForced(st, { note, run, validated: validate(st, note, output2), output: output2 }, new Date(NOW.getTime() + 60000));
  assert.equal(t.schedHints.focus, 'deep');
});

test('#74 프롬프트: SYSTEM 에 규칙 ‘N. 배치 힌트’, 버전 capture.v7', () => {
  assert.equal(C.PROMPT_VERSION, 'capture.v7');
  assert.match(C.SYSTEM, /^N\. 배치 힌트: tasks 마다 sched 를 채웁니다/m);
  assert.ok(C.SYSTEM.indexOf('N. 배치 힌트') > C.SYSTEM.indexOf('M. 걸어 둔 상태'));
});

test('가짜 AI 제목: 걸리는 시간이라고 말한 길이만 떼고(‘1시간 정도 걸리는’), 제목의 일부인 ‘5분 스피치’ 는 그대로', () => {
  const st = M.emptyState();
  const o1 = fake.organize(C.buildInput(addNote(st, '1시간 정도 걸리는 보고서 작성'), { today: '2026-10-05 (월)', projects: [], openTasks: [] })).output;
  assert.deepEqual([o1.tasks[0].title, o1.tasks[0].sched.minutes], ['보고서 작성', 60]);
  const o2 = fake.organize(C.buildInput(addNote(st, '5분 스피치 준비하기'), { today: '2026-10-05 (월)', projects: [], openTasks: [] })).output;
  assert.equal(o2.tasks[0].title, '5분 스피치 준비하기');
  // 날짜 없이 오늘 이미 지난 시각(10:00 기준 오전 9시)은 할 시각으로 두지 않는다
  const o3 = fake.organize(C.buildInput(addNote(st, '오전 9시에 운동하기'), { today: '2026-10-05 (월)', projects: [], openTasks: [] })).output;
  assert.deepEqual(o3.tasks[0].do_at, NOWHEN);
  const o4 = fake.organize(C.buildInput(addNote(st, '오후 3시에 보고서 작성'), { today: '2026-10-05 (월)', projects: [], openTasks: [] })).output;
  assert.equal(o4.tasks[0].do_at.time, '15:00');
});
