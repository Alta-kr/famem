'use strict';
// 3차 코드 리뷰 버그(BUG-V3-01 ~ 08) 회귀 테스트
const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/core/model');
const D = require('../src/core/dates');
const P = require('../src/core/ai/proposals');
const R = require('../src/core/recommend');
const W = require('../src/core/weekly');
const HZ = require('../src/core/horizon');

const NOW = new Date(2026, 9, 21, 10, 30);   // 수요일

function noteWith(st, task) {
  const n = M.addNote(st, { title: '', body: task.title }, NOW);
  n.capture = { status: 'done', created: [{ kind: 'task', id: task.id }] };
  task.sources = [{ type: 'note', refId: n.id }];
  return n;
}

test('BUG-V3-01: 할 날만 있는 할 일을 일정으로 → 그날 일정, 다시 할 일로 → 할 날 그대로', () => {
  const st = M.emptyState();
  const t = M.addTask(st, { title: '보고서 초안 작성', planDate: '2026-10-22' }, NOW);
  assert.strictEqual(M.normalizeTask({}).planDate, null);
  const n = noteWith(st, t);
  P.captureSetItemKind(st, n.id, n.capture.created[0], 'event', NOW);
  const b = st.blocks.find((x) => x.title === '보고서 초안 작성');
  assert.strictEqual(D.ymd(new Date(b.start)), '2026-10-22');
  P.captureSetItemKind(st, n.id, n.capture.created[0], 'task', NOW);
  const back = M.liveTasks(st).find((x) => x.title === '보고서 초안 작성');
  assert.deepStrictEqual([back.planDate, back.dueDate], ['2026-10-22', null]);
});

test('BUG-V3-02: 아래 단계를 체크하면 추천 지문이 바뀐다', () => {
  const st = M.emptyState();
  const t = M.addTask(st, { title: '세미나 준비', steps: [{ id: 's1', title: '발표 자료', done: false, steps: [{ id: 's2', title: '목차 초안', done: false }, { id: 's3', title: '디자인', done: false }] }] }, NOW);
  const a = R.signature(st, NOW);
  t.steps[0].steps[0].done = true;
  assert.notStrictEqual(R.signature(st, NOW), a);
});

test('BUG-V3-03: 앞날 마감·할 날은 오늘 추천에서 빠지고, 할 날로만 정한 일도 주간 보고에 들어간다', () => {
  const st = M.emptyState();
  const later = M.addTask(st, { title: '다음 주 발표 연습', planDate: '2026-10-28', estimateMinutes: 20 }, NOW);
  const now1 = M.addTask(st, { title: '오늘 할 일', estimateMinutes: 20 }, NOW);
  const r = R.recommend(st, { now: NOW, availableMinutes: 60 });
  assert.strictEqual(r.primary.taskId, now1.id);
  assert.ok(![r.primary].concat(r.alternatives || []).some((x) => x && x.taskId === later.id));
  assert.strictEqual(r.excluded.planned, 1);
  M.addTask(st, { title: '수요일 코드 리뷰', planDate: '2026-10-23' }, NOW);
  const s = W.summarize(st, '2026-10-19', NOW);
  assert.ok(s.unfinished.some((x) => x.title === '수요일 코드 리뷰'));
  assert.ok(s.nextWeek.some((x) => x.title === '다음 주 발표 연습'));
  assert.match(W.draftReport(s, st), /다음 주 발표 연습 \(10\/28 예정\)/);
});

test('BUG-V3-05: 토요일의 "이번 주 금요일" 은 다음 주 금요일이 아니다 (지났으면 안 보임)', () => {
  const sat = new Date(2026, 9, 17, 10);
  const c = HZ.planChoices(sat);
  assert.deepStrictEqual(c.map((x) => x[0]), ['오늘', '내일', '다음 주 월요일']);
  assert.strictEqual(c[2][1], '2026-10-19');
  const mon = HZ.planChoices(new Date(2026, 9, 19, 10));
  assert.deepStrictEqual(mon.find((x) => x[0] === '이번 주 금요일')[1], '2026-10-23');
});

test('BUG-V3-08: 오늘 마감인 일에 내일 작업 시간이 있어도 오늘 칸', () => {
  const st = M.emptyState();
  const t = M.addTask(st, { title: '오늘 마감', dueDate: '2026-10-21' }, NOW);
  M.addBlock(st, { taskId: t.id, start: new Date(2026, 9, 22, 10).toISOString(), end: new Date(2026, 9, 22, 11).toISOString() });
  assert.strictEqual(HZ.anchorDay(st, t, NOW), '2026-10-21');
  const u = M.addTask(st, { title: '금요일 마감', dueDate: '2026-10-23' }, NOW);
  M.addBlock(st, { taskId: u.id, start: new Date(2026, 9, 22, 10).toISOString(), end: new Date(2026, 9, 22, 11).toISOString() });
  assert.strictEqual(HZ.anchorDay(st, u, NOW), '2026-10-22');   // 작업 시간이 마감보다 앞이면 작업하는 날
});
