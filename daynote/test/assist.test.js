'use strict';

// 홈 채팅 도우미 — 작게 나누기·자세히 적기·제안 시점·반영

const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/core/model');
const V = require('../src/core/ai/validate');
const P = require('../src/core/ai/proposals');
const C = require('../src/core/ai/capture');
const A = require('../src/core/ai/assist');
const fake = require('../src/core/ai/fake');

const NOW = new Date(2026, 9, 5, 10, 0);

function capture(st, text) {
  const note = M.addNote(st, { title: '', body: text, capture: { status: 'pending' } }, NOW);
  note.updatedAt = NOW.toISOString();
  const out = fake.organize(C.buildInput(note, { today: 'x', projects: [], openTasks: [] })).output;
  const run = P.startRun(st, { noteId: note.id }, NOW);
  const v = V.validateOrganizeNote(out, { note, state: st, now: NOW });
  return P.applyCapture(st, { note, run, validated: v, output: out }, NOW);
}

test('큰 할 일은 단계 초안을 보관만 하고 바로 적용하지 않는다', () => {
  const st = M.emptyState();
  const cap = capture(st, '금요일까지 분기 보고서 작성');
  const t = st.tasks[0];
  assert.deepStrictEqual(cap.largeTasks, [t.id]);
  assert.strictEqual(t.breakdown.status, 'pending');
  assert.ok(t.breakdown.steps.length >= 3);
  assert.deepStrictEqual(t.steps, []);                    // 아직 적용 안 됨
  const small = M.emptyState();
  capture(small, '내일까지 견적서 보내기');
  assert.strictEqual(small.tasks[0].breakdown, null);
});

test('단계 초안 검증: 2~8개, 제목·시간 정리, 형식이 틀리면 거부', () => {
  const r = A.validateBreakdown({ is_large: true, reason: '작게', steps: [{ title: '  자료 찾기 ', minutes: 15 }, { title: '초안', minutes: 9999 }, { title: '', minutes: 5 }] });
  assert.ok(r.ok && r.isLarge);
  assert.deepStrictEqual(r.steps, [{ title: '자료 찾기', minutes: 15 }, { title: '초안', minutes: null }]);
  assert.strictEqual(A.validateBreakdown({ is_large: true, reason: '', steps: [{ title: '하나', minutes: 5 }] }).isLarge, false);
  assert.strictEqual(A.validateBreakdown({ steps: 'x' }).ok, false);
});

test('자세히 적기 검증: 후보에 없는 할 일 id 는 버린다 (지어낸 할 일 차단)', () => {
  const r = A.validateElaborate({ picks: [
    { task_id: 't1', why: 'w', question: '무엇이 되면 끝인가요?', hints: ['a', 'b', 'c', 'd'] },
    { task_id: 'ghost', why: 'w', question: 'q', hints: [] },
    { task_id: 't1', why: 'dup', question: 'q', hints: [] }
  ] }, ['t1', 't2']);
  assert.strictEqual(r.picks.length, 1);
  assert.strictEqual(r.picks[0].hints.length, 3);
});

test('제안 시점: 나눠 둔 초안이 먼저, 할 일이 없어 보이면 자세히 적기, 너무 자주 묻지 않기', () => {
  const st = M.emptyState();
  M.addTask(st, { title: '정리', estimateMinutes: null, createdAt: new Date(NOW - 2 * 3600000).toISOString() }, NOW);   // 막연한 할 일 (두 시간 전에 적음)
  // 진행 중인 일도, 바로 할 일도 없는 건 아니므로(추천 후보 있음) 자동 'open' 에서는 자세히 적기 안 함
  assert.strictEqual(A.nextNudge(st, { now: NOW, reason: 'open' }), null);
  // 한동안 입력이 없으면 자세히 적기 제안
  assert.strictEqual(A.nextNudge(st, { now: NOW, reason: 'idle' }).type, 'elaborate');
  // 나눠 둔 초안이 있으면 그게 먼저
  capture(st, '금요일까지 분기 보고서 작성');
  const n = A.nextNudge(st, { now: NOW, reason: 'completed' });
  assert.strictEqual(n.type, 'breakdown');
  // 20분 안에는 다시 묻지 않음 (버튼은 예외)
  assert.strictEqual(A.nextNudge(st, { now: NOW, reason: 'idle', lastNudgeAt: new Date(NOW - 5 * 60000) }), null);
  assert.ok(A.nextNudge(st, { now: NOW, reason: 'button', lastNudgeAt: new Date(NOW - 5 * 60000) }));
});

test('적용: 고친 단계만 추가되고, 시간이 다 있으면 남은 시간을 추정값으로 채운다. 나중에·필요 없음', () => {
  const st = M.emptyState();
  capture(st, '금요일까지 분기 보고서 작성');
  const t = st.tasks[0];
  A.applyBreakdown(st, t.id, [{ title: '자료 모으기', minutes: 15 }, { title: '  ', minutes: 5 }, { title: '초안', minutes: 30 }], NOW);
  assert.deepStrictEqual(t.steps.map((s) => s.title), ['자료 모으기', '초안']);
  assert.strictEqual(t.estimateMinutes, 45);
  assert.strictEqual(t.estimateSource, 'ai');
  assert.strictEqual(t.breakdown.status, 'accepted');
  assert.strictEqual(A.pendingBreakdowns(st, NOW).length, 0);

  const st2 = M.emptyState();
  capture(st2, '금요일까지 분기 보고서 작성');
  const t2 = st2.tasks[0];
  A.deferBreakdown(st2, t2.id, 'later', NOW);
  assert.strictEqual(A.pendingBreakdowns(st2, NOW).length, 0);
  assert.strictEqual(A.pendingBreakdowns(st2, new Date(NOW.getTime() + 3 * 3600000)).length, 1);   // 2시간 뒤 다시
  A.deferBreakdown(st2, t2.id, 'never', NOW);
  assert.strictEqual(A.pendingBreakdowns(st2, new Date(NOW.getTime() + 9 * 3600000)).length, 0);
});

test('자세히 적기 후보: 단계·메모가 없고 막연한 할 일, 적은 뒤엔 다시 묻지 않음', () => {
  const st = M.emptyState();
  const vague = M.addTask(st, { title: '보고서', createdAt: new Date(NOW - 2 * 3600000).toISOString() }, NOW);
  M.addTask(st, { title: '프로젝트 회의록을 팀 채널에 공유하기', estimateMinutes: 10 }, NOW);
  assert.deepStrictEqual(A.elaborateCandidates(st, NOW).map((t) => t.id), [vague.id]);
  A.saveElaboration(st, vague.id, '3분기 매출 요약을 팀장님께 보내면 끝', NOW);
  assert.match(vague.memo, /팀장님/);
  assert.strictEqual(A.elaborateCandidates(st, NOW).length, 0);
});

test('휴식: 스트레칭은 겹치지 않게 고른다', () => {
  const s = A.pickStretches(3, 42);
  assert.strictEqual(s.length, 3);
  assert.strictEqual(new Set(s.map((x) => x.title)).size, 3);
});

test('요청 정의: 작게 나누기·자세히 적기 스키마가 구조화 출력 조건을 지킨다', () => {
  [A.BREAKDOWN.SCHEMA, A.ELABORATE.SCHEMA, C.SCHEMA].forEach(function walk(s) {
    if (s && s.type === 'object') {
      assert.strictEqual(s.additionalProperties, false);
      assert.deepStrictEqual(s.required.slice().sort(), Object.keys(s.properties).sort());
      Object.values(s.properties).forEach(walk);
    }
    if (s && s.items) walk(s.items);
    if (s && s.anyOf) s.anyOf.forEach(walk);
  });
  const inp = A.BREAKDOWN.buildInput({ id: 't', title: '보고서', steps: [], sources: [] }, { today: '2026-10-05' });
  assert.match(A.BREAKDOWN.userText(inp), /<task>/);
});

test('자세히 적기: "샤워하기" 같은 분명한 행동·시간 정한 일·방금 적은 일은 묻지 않는다', () => {
  const st = M.emptyState();
  const old = new Date(NOW - 3 * 3600000).toISOString();
  M.addTask(st, { title: '샤워하기', createdAt: old }, NOW);
  M.addTask(st, { title: '견적서 보내기', createdAt: old }, NOW);
  const timed = M.addTask(st, { title: '분기 보고서 작성', createdAt: old }, NOW);
  M.addBlock(st, { taskId: timed.id, title: timed.title, start: new Date(NOW.getTime() + 30 * 60000).toISOString(), end: new Date(NOW.getTime() + 60 * 60000).toISOString() });
  M.addTask(st, { title: '발표 준비' }, NOW);                                  // 방금 적음
  assert.deepStrictEqual(A.elaborateCandidates(st, NOW), []);
  // 오래된 막연한 일은 후보 — 하지만 방금(10분 안) 무언가 적었으면 먼저 묻지 않는다
  const v = M.addTask(st, { title: '온보딩 설문 정리', createdAt: old }, NOW);
  assert.deepStrictEqual(A.elaborateCandidates(st, NOW).map((t) => t.id), [v.id]);
  assert.strictEqual(A.nextNudge(st, { now: NOW, reason: 'idle', lastCaptureAt: new Date(NOW - 2 * 60000).toISOString() }), null);
  assert.strictEqual(A.nextNudge(st, { now: NOW, reason: 'idle', lastCaptureAt: new Date(NOW - 30 * 60000).toISOString() }).type, 'elaborate');
  assert.ok(A.nextNudge(st, { now: NOW, reason: 'button', lastCaptureAt: new Date(NOW - 60000).toISOString() }));
});
