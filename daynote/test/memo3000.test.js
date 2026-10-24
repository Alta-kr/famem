'use strict';

// 메모 3,000개 회귀 검사 — 저장해 둔 실제 AI 답(research/memo3000/results/raw.jsonl)을 지금 앱 코드에 넣어 채점한다.
//   AI 를 다시 부르지 않아 비용 0 · 몇 초. 날짜 해석·검증·적용 코드를 고치다 통과 수가 줄면 실패한다.
//   새 AI 답으로 다시 재려면: node research/memo3000/run.js → score.js, 그리고 아래 기준을 새 값으로.

const test = require('node:test');
const assert = require('node:assert');
const { scoreAll } = require('../research/memo3000/score');

const FLOOR = 2984;   // 2026-10-24 기준 2,984 / 3,000 (99.5%)

test('메모 3,000개: 저장한 AI 답을 앱에 넣은 결과가 기준 아래로 떨어지지 않는다', () => {
  const { summary, fails } = scoreAll();
  const msg = '통과 ' + summary.total.ok + '/' + summary.total.n + ' (기준 ' + FLOOR + ')\n' +
    fails.slice(0, 15).map((f) => '  ' + f.id + ' ' + f.intent + ' · ' + f.why.slice(0, 80) + ' · ' + f.memo.slice(0, 40)).join('\n');
  assert.ok(summary.total.ok >= FLOOR, msg);
  // 꼭 지켜야 하는 것 — 기록은 남기고, 명령은 확인 카드로
  assert.strictEqual(summary.per.update_slot_explicit_clear.ok, 143);
  assert.strictEqual(summary.per.command_delete_explicit.ok, 143);
  assert.strictEqual(summary.per.command_delete_implicit.ok, 143);
});
