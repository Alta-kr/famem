'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/core/model');
const HZ = require('../src/core/horizon');

// 2026-10-21 수요일 10:00
const NOW = new Date(2026, 9, 21, 10, 0);

test('보기 → 날짜: 내일 · 이번 주(오늘~일) · 다음 주(월~일) · 하루', () => {
  assert.deepStrictEqual(HZ.days('today', NOW), ['2026-10-21']);
  assert.deepStrictEqual(HZ.days('tomorrow', NOW), ['2026-10-22']);
  assert.deepStrictEqual(HZ.days('week', NOW), ['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
  assert.deepStrictEqual(HZ.days('next', NOW), ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
  assert.deepStrictEqual(HZ.days('day:2026-10-28', NOW), ['2026-10-28']);
  // 토요일에 '이번 주' 는 다음 월요일까지 함께
  assert.deepStrictEqual(HZ.days('week', new Date(2026, 9, 24, 9)), ['2026-10-24', '2026-10-25', '2026-10-26']);
});

test('날짜별 묶음: 할 날 → 작업 시간 → 마감, 밀린 일은 오늘 칸, 일정도 함께', () => {
  const st = M.emptyState();
  const a = M.addTask(st, { title: '마감만', dueDate: '2026-10-23' }, NOW);
  const b = M.addTask(st, { title: '할 날 우선', dueDate: '2026-10-30', planDate: '2026-10-22' }, NOW);
  const c = M.addTask(st, { title: '작업 시간', dueDate: '2026-10-30' }, NOW);
  M.addBlock(st, { taskId: c.id, title: c.title, start: new Date(2026, 9, 24, 14).toISOString(), end: new Date(2026, 9, 24, 15).toISOString() });
  const d = M.addTask(st, { title: '밀린 일', dueDate: '2026-10-19' }, NOW);
  M.addBlock(st, { title: '팀 회의', start: new Date(2026, 9, 22, 11).toISOString(), end: new Date(2026, 9, 22, 12).toISOString() });
  const g = HZ.byDay(st, HZ.days('week', NOW), NOW);
  const at = (day) => g.find((x) => x.day === day);
  assert.deepStrictEqual(at('2026-10-21').tasks.map((t) => t.id), [d.id]);
  assert.deepStrictEqual(at('2026-10-22').tasks.map((t) => t.id), [b.id]);
  assert.deepStrictEqual(at('2026-10-22').events.map((x) => x.title), ['팀 회의']);
  assert.deepStrictEqual(at('2026-10-23').tasks.map((t) => t.id), [a.id]);
  assert.deepStrictEqual(at('2026-10-24').tasks.map((t) => t.id), [c.id]);
  const l = HZ.load(st, NOW, 14);
  assert.strictEqual(l.length, 14);
  assert.strictEqual(l[1].events, 1);
  assert.strictEqual(l[2].due, 1);
});

test('다가오는 마감: 며칠 후로, 늦어도 시작할 날이 온 일 먼저', () => {
  const st = M.emptyState();
  const near = M.addTask(st, { title: '가까운 마감', dueDate: '2026-10-23' }, NOW);
  const big = M.addTask(st, { title: '큰 보고서', dueDate: '2026-10-26', estimateMinutes: 900 }, NOW);   // 240분/일 → 4일 → 늦어도 10/23 시작
  M.addTask(st, { title: '먼 마감', dueDate: '2026-11-20' }, NOW);
  M.addTask(st, { title: '오늘로 가져옴', dueDate: '2026-10-25', planDate: '2026-10-21' }, NOW);
  const up = HZ.upcoming(st, NOW, 7, []);
  assert.deepStrictEqual(up.map((u) => u.task.title), ['가까운 마감', '큰 보고서']);
  assert.strictEqual(HZ.startBy(big), '2026-10-23');
  assert.strictEqual(HZ.upcoming(st, new Date(2026, 9, 23, 9), 7, [near.id])[0].prep, true);
  assert.strictEqual(HZ.leftText('2026-10-24', NOW), '3일 후');
  assert.strictEqual(HZ.leftText('2026-10-22', NOW), '내일');
  assert.deepStrictEqual(HZ.planChoices(NOW).map((c) => c[0]), ['오늘', '내일', '이번 주 금요일', '다음 주 월요일']);
});

test('AI 정리와 날짜: 마감 말이 있으면 마감, 날짜만 있으면 할 날 · 할 날만 있던 일을 "내일 할게" 로 옮기면 할 날', () => {
  const V = require('../src/core/ai/validate');
  const P = require('../src/core/ai/proposals');
  const C = require('../src/core/ai/capture');
  const fake = require('../src/core/ai/fake');
  assert.ok(V.isDeadlineText('내일까지 견적서'));
  assert.ok(V.isDeadlineText('금요일 보고서 제출'));
  assert.ok(!V.isDeadlineText('내일 견적서 보내기'));
  const at = new Date(2026, 9, 21, 10, 0);
  const st = M.emptyState();
  function send(body, out) {
    const note = M.addNote(st, { title: '', body, capture: { status: 'pending', at: at.toISOString() } }, at);
    note.updatedAt = at.toISOString();
    const input = C.buildInput(note, { today: '2026-10-21 (수)', projects: [], openTasks: M.liveTasks(st).filter((t) => t.status !== 'done').map((t) => t.title) });
    out = out || fake.organize(input).output;
    const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, at);
    P.applyCapture(st, { note, run, validated: V.validateOrganizeNote(out, { note, state: st, now: at }), output: out }, at);
    return note;
  }
  send('내일까지 견적서 보내기');
  const due = M.liveTasks(st).find((t) => /견적서/.test(t.title));
  assert.deepStrictEqual([due.dueDate, due.planDate || null], ['2026-10-22', null]);
  send('금요일 회의 자료 정리하기');
  const plan = M.liveTasks(st).find((t) => /회의 자료/.test(t.title));
  assert.deepStrictEqual([plan.dueDate, plan.planDate], [null, '2026-10-23']);
  // 할 날만 있던 일 — "회의 자료 정리는 내일 할게" → 할 날을 내일로 (마감을 만들지 않는다), × 로 되돌리면 원래 할 날
  const nul = { text: null, date: null, time: null };
  const base = { summary: '', sections: [], tasks: [], events: [], open_questions: [], entry_type: 'update', note_title: 'x', note_project_hint: null, note_kind: 'memo', done_tasks: [], bulk_updates: [], commands: [] };
  const q = '회의 자료 정리는 내일 할게';
  const note = send(q, Object.assign({}, base, { updated_tasks: [{ title: plan.title, evidence: { quote: q, line: 1 }, due: { text: '내일', date: '2026-10-22', time: null }, do_at: nul }] }));
  assert.deepStrictEqual([plan.dueDate, plan.planDate], [null, '2026-10-22']);
  P.captureRemoveItem(st, note.id, { kind: 'moved', id: plan.id }, at);
  assert.strictEqual(plan.planDate, '2026-10-23');
});
