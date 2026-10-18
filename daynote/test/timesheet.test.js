'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/core/model');
const TS = require('../src/core/timesheet');

test('쓴 시간: 시작~일시 정지 구간을 남기고, 주·프로젝트별로 모으고, CSV 로 낸다', () => {
  const st = M.emptyState();
  const p = M.addProject(st, { name: '고객 A' }, new Date(2026, 9, 19, 9));
  const t = M.addTask(st, { title: '로그인 화면', projectId: p.id, estimateMinutes: 60 }, new Date(2026, 9, 19, 9));
  M.startTask(st, t.id, new Date(2026, 9, 19, 10, 0));
  M.pauseTask(st, t.id, new Date(2026, 9, 19, 11, 30));            // 90분
  M.startTask(st, t.id, new Date(2026, 9, 21, 23, 30));
  M.completeTask(st, t.id, new Date(2026, 9, 22, 0, 30));          // 60분 (자정을 넘김)
  const short = M.addTask(st, { title: '짧은 일' }, new Date(2026, 9, 19, 9));
  M.startTask(st, short.id, new Date(2026, 9, 19, 9, 0)); M.pauseTask(st, short.id, new Date(2026, 9, 19, 9, 0, 10));   // 10초 — 구간은 안 남김
  assert.strictEqual(t.sessions.length, 2);
  assert.strictEqual((short.sessions || []).length, 0);
  const now = new Date(2026, 9, 23, 12);
  const sum = TS.projectSummary(st, p.id, now);
  assert.deepStrictEqual([sum.totalMin, sum.weekMin, sum.ratio], [150, 150, 2.5]);
  const wk = TS.weekByProject(st, '2026-10-19', now);
  assert.strictEqual(wk[0].name, '고객 A');
  assert.strictEqual(wk[0].minutes, 150);
  const csv = TS.csv(st, '2026-10-19', '2026-10-25', now);
  const lines = csv.replace('\uFEFF', '').trim().split('\r\n');
  assert.strictEqual(lines[0], '날짜,프로젝트,할 일,시작,끝,분');
  assert.deepStrictEqual(lines.slice(1), ['2026-10-19,고객 A,로그인 화면,10:00,11:30,90', '2026-10-21,고객 A,로그인 화면,23:30,00:00,30', '2026-10-22,고객 A,로그인 화면,00:00,00:30,30']);
  // 진행 중이면 지금까지 포함
  const run = M.addTask(st, { title: '진행 중', projectId: p.id }, now);
  M.startTask(st, run.id, new Date(2026, 9, 23, 11));
  assert.strictEqual(TS.projectSummary(st, p.id, now).weekMin, 210);
});
