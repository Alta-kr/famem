'use strict';
const test = require('node:test');
const assert = require('node:assert');
const SP = require('../src/core/split');

const near = (a, b) => a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) < 1e-9, a + ' vs ' + b));
const sum = (r) => r.reduce((s, x) => s + x, 0);

test('normalize: 합 1, 잘못된 값은 기본값', () => {
  near(SP.normalize([2, 1, 1]), [0.5, 0.25, 0.25]);
  near(SP.normalize(undefined), SP.DEFAULT);
  near(SP.normalize([1, 2]), SP.DEFAULT);
  near(SP.normalize([1, -1, 1]), SP.DEFAULT);
  near(SP.normalize([1, NaN, 1]), SP.DEFAULT);
  near(SP.normalize([1, '2', 1]), SP.DEFAULT);
  assert.notStrictEqual(SP.normalize(null), SP.DEFAULT);   // 사본을 돌려준다
});

test('minRatio: 72px 기준, 작은 패널은 1/3 로 묶음', () => {
  assert.strictEqual(SP.minRatio(720), 0.1);
  assert.strictEqual(SP.minRatio(150), 1 / 3);
  assert.strictEqual(SP.minRatio(0), 0);
});

test('moveEdge: 경계 하나만 움직이고 나머지 칸은 그대로', () => {
  const r = SP.moveEdge([0.4, 0.4, 0.2], 0, 0.1, 0.1);
  near(r, [0.5, 0.3, 0.2]);
  const r2 = SP.moveEdge([0.4, 0.4, 0.2], 1, -0.1, 0.1);
  near(r2, [0.4, 0.3, 0.3]);
  assert.ok(Math.abs(sum(r2) - 1) < 1e-9);
});

test('moveEdge: 최소 비율에서 멈춤', () => {
  near(SP.moveEdge([0.4, 0.4, 0.2], 0, 0.9, 0.1), [0.7, 0.1, 0.2]);
  near(SP.moveEdge([0.4, 0.4, 0.2], 1, 0.9, 0.1), [0.4, 0.5, 0.1]);
  near(SP.moveEdge([0.4, 0.4, 0.2], 0, -0.9, 0.1), [0.1, 0.7, 0.2]);
});

test('moveEdge: 두 칸 합이 최소의 두 배보다 작으면 그대로', () => {
  near(SP.moveEdge([0.9, 0.05, 0.05], 1, 0.03, 0.2), [0.9, 0.05, 0.05]);
});

test('isDefault', () => {
  assert.ok(SP.isDefault(SP.DEFAULT));
  assert.ok(!SP.isDefault([0.5, 0.3, 0.2]));
});

test('moveEdge: 최소보다 작은 칸도 누른 방향과 반대로 움직이지 않음', () => {
  // 메모 칸이 이미 min(0.2) 아래. 위로(-) 누르면 경계는 위로만, 아래로(+) 누르면 그대로이거나 아래로만
  const start = [0.7, 0.1, 0.2];
  const up = SP.moveEdge(start, 0, -0.05, 0.2);
  assert.ok(up[0] <= 0.7 + 1e-12, 'up: ' + up);
  const down = SP.moveEdge(start, 0, 0.05, 0.2);
  assert.ok(down[0] >= 0.7 - 1e-12, 'down: ' + down);
});

test('moveEdge: NaN delta 는 0', () => {
  near(SP.moveEdge([0.4, 0.4, 0.2], 0, NaN, 0.1), [0.4, 0.4, 0.2]);
});

test('moveEdge: 극단 delta ±10 은 최소에서 멈춤', () => {
  near(SP.moveEdge([0.4, 0.4, 0.2], 0, 10, 0.1), [0.7, 0.1, 0.2]);
  near(SP.moveEdge([0.4, 0.4, 0.2], 0, -10, 0.1), [0.1, 0.7, 0.2]);
  near(SP.moveEdge([0.4, 0.4, 0.2], 1, 10, 0.1), [0.4, 0.5, 0.1]);
});

test('moveEdge: edge 1 은 첫 칸을 바꾸지 않음', () => {
  for (const d of [-10, -0.3, -0.05, 0.05, 0.3, 10]) {
    assert.strictEqual(SP.moveEdge([0.45, 0.33, 0.22], 1, d, 0.1)[0], 0.45);
  }
});

test('clampAll: 세 칸 모두 min 이상, 합 1', () => {
  const r = SP.clampAll([0.9, 0.05, 0.05], 0.1);
  near(r, [0.8, 0.1, 0.1]);
  const r2 = SP.clampAll([0.6, 0.38, 0.02], 0.1);
  assert.ok(r2.every((x) => x >= 0.1 - 1e-12));
  assert.ok(Math.abs(sum(r2) - 1) < 1e-9);
  assert.ok(Math.abs(r2[0] / r2[1] - 0.6 / 0.38) < 1e-9);   // 나머지는 비율 유지
  near(SP.clampAll([0.5, 0.3, 0.2], 0.1), [0.5, 0.3, 0.2]);
  near(SP.clampAll([0.9, 0.05, 0.05], 0.5), [1 / 3, 1 / 3, 1 / 3]);
});

test('round 뒤 isDefault (허용 오차 1e-3)', () => {
  assert.ok(SP.isDefault(SP.round([0.45004, 0.32998, 0.21998])));
  assert.ok(SP.isDefault([0.4505, 0.3298, 0.2197]));
  assert.ok(!SP.isDefault(SP.round([0.46, 0.32, 0.22])));
});
