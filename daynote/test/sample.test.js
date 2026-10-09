'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/core/model');
const R = require('../src/core/recommend');
const sample = require('../renderer/sample');

const NOW = new Date(2026, 9, 5, 10, 0);
const KINDS = ['projects', 'notes', 'tasks', 'blocks', 'history', 'emails'];

function built() { const s = M.emptyState(); sample.build(s, NOW); return s; }

test('모든 샘플 항목은 sample:true, sampleLoaded', () => {
  const s = built();
  assert.equal(s.meta.sampleLoaded, true);
  KINDS.forEach((k) => {
    assert.ok(s[k].length > 0, k + ' 비어 있음');
    s[k].forEach((x) => assert.equal(x.sample, true, k + ' ' + (x.title || x.name || x.subject || x.id)));
  });
  assert.equal(s.projects.length, 3);
  assert.equal(s.emails.length, 4);
  s.emails.forEach((e) => assert.match(e.from, /@example\.com>$/));
});

test('요구한 상태 구성이 들어 있음', () => {
  const s = built();
  const t = s.tasks;
  assert.ok(t.some((x) => x.status === 'waiting' && x.waitingFor));
  assert.ok(t.some((x) => M.unmetBlockers(s, x).length));
  assert.ok(t.some((x) => x.snoozedUntil && new Date(x.snoozedUntil) > NOW));
  assert.ok(t.some((x) => x.status === 'in_progress'));
  assert.ok(t.some((x) => x.estimateMinutes == null));
  assert.ok(t.some((x) => x.estimateSource === 'ai'));
  assert.ok(t.some((x) => x.steps.length === 3 && x.estimateMinutes === 120));
  assert.equal(t.filter((x) => x.status === 'done').length, 3);
  assert.equal(s.history.filter((h) => h.type === 'task_done').length, 3);
  assert.ok(t.some((x) => x.sources.some((src) => src.type === 'note')));
  // 출처 문장은 원본 메모 본문에 그대로 있어야 한다
  t.forEach((x) => x.sources.filter((src) => src.type === 'note').forEach((src) => {
    assert.ok(M.byId(s.notes, src.refId).body.includes(src.excerpt), src.excerpt);
  }));
  // 메모 제목은 title 에만, 본문은 제목 헤딩 없이 시작
  s.notes.forEach((n) => {
    assert.ok(n.title, '빈 제목');
    assert.ok(!/^#\s/.test(n.body), n.title + ' 본문이 헤딩으로 시작');
  });
  const overlaps = s.blocks.some((b) => M.conflictsFor(s, b.start, b.end, b.id).length);
  assert.ok(overlaps, '겹치는 블록 없음');
});

test('clearSample 후 사용자 항목만 남음', () => {
  const s = built();
  const mine = M.addTask(s, { title: '내 할 일' }, NOW);
  const note = M.addNote(s, { body: '내 메모' }, NOW);
  M.clearSample(s);
  assert.deepEqual(s.tasks.map((x) => x.id), [mine.id]);
  assert.deepEqual(s.notes.map((x) => x.id), [note.id]);
  ['projects', 'blocks', 'history', 'emails'].forEach((k) => assert.equal(s[k].length, 0, k));
  assert.equal(s.meta.sampleLoaded, false);
});

test('recommend 가 primary 를 낸다', () => {
  const s = built();
  const r = R.recommend(s, { now: NOW });
  assert.ok(r.primary);
  assert.equal(r.context.source, 'calendar');
  assert.equal(r.context.availableMinutes, 30);
  assert.equal(r.primary.fit, 'fits');
});

test('다른 시각에도 샘플이 동작 (하드코딩 날짜 없음)', () => {
  const s = M.emptyState();
  const later = new Date(2027, 2, 15, 9, 0);
  sample.build(s, later);
  assert.ok(R.recommend(s, { now: later }).primary);
});
