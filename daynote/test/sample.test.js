'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/core/model');
const R = require('../src/core/recommend');
const sample = require('../renderer/sample');

const D = require('../src/core/dates');
const fs = require('fs'), path = require('path');
const has = (rel) => fs.existsSync(path.join(__dirname, '..', rel));
const ST = has('src/core/status.js') ? require('../src/core/status') : null;          // W1-status

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
  assert.equal(t.length, 20);                                   // 16 + 업무 밖 할 일 4개 (STATUS §17)
  assert.equal(t.filter((x) => x.status !== 'done').length, 17);
  assert.equal(t.filter((x) => x.status === 'done').length, 3);
  assert.equal(t.filter((x) => x.status === 'waiting').length, 1);
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

// ───────────────────────────── 현재 상태용 샘플 (STATUS §17) ─────────────────────────────
const byTitle = (s, title) => s.tasks.find((x) => x.title === title);

test('샘플: 프로젝트 3개는 업무 맥락, 업무 밖 할 일 4개가 들어 있다 (STATUS §17 · #142)', () => {
  const s = built();
  assert.deepEqual(s.projects.map((p) => p.context), ['work', 'work', 'work']);
  const today = D.ymd(NOW), tomorrow = D.ymd(D.addDays(NOW, 1)), yesterday = D.ymd(D.addDays(NOW, -1));

  const laundry = byTitle(s, '빨래 돌리기');
  assert.ok(laundry);
  assert.equal(laundry.dueDate, null);
  assert.equal(laundry.estimateMinutes, 15);
  assert.equal(D.ymd(laundry.createdAt), yesterday);            // 오늘 목록 밖

  const trash = byTitle(s, '분리수거');
  assert.equal(trash.dueDate, today);

  const gift = byTitle(s, '엄마 생신 선물 주문');
  assert.equal(gift.dueDate, tomorrow);

  const milk = byTitle(s, '우유 사기');
  assert.equal(milk.atMode, 'out');
  assert.equal(milk.atModeSource, 'rule');
  assert.equal(D.ymd(milk.createdAt), today);

  [laundry, trash, gift, milk].forEach((t) => {
    assert.equal(t.sample, true, t.title);
    assert.equal(t.projectId, null, t.title);
    assert.equal(t.status, 'todo', t.title);
    assert.equal(t.context, null, t.title);                      // 맥락은 저장하지 않고 읽을 때 계산
    assert.equal(t.contextSource, null, t.title);
  });
  // 업무 할 일은 걸어 둔 상태가 없다
  assert.deepEqual(s.tasks.filter((t) => t.atMode).map((t) => t.title), ['우유 사기']);
});

test('샘플을 불러도 현재 상태 기능은 켜지지 않는다 (presence·gcal 그대로)', () => {
  const sat = new Date(2026, 9, 10, 1, 25);
  const s = M.emptyState();
  const presence = JSON.parse(JSON.stringify(s.presence)), gcal = JSON.parse(JSON.stringify(s.gcal));
  sample.build(s, sat);
  assert.deepEqual(s.presence, presence);
  assert.equal(s.presence.activatedAt, null);
  assert.deepEqual(s.gcal, gcal);
  // 샘플을 지워도 presence 는 그대로
  s.presence.activatedAt = sat.toISOString();
  M.clearSample(s);
  assert.equal(s.presence.activatedAt, sat.toISOString());
  assert.equal(s.tasks.length, 0);
});

test('자정 직후에 불러도 ‘우유 사기’는 오늘 만든 일, ‘빨래 돌리기’는 어제 만든 일', () => {
  [new Date(2026, 9, 10, 0, 0), new Date(2026, 9, 10, 0, 10), new Date(2026, 9, 10, 1, 25), new Date(2026, 9, 9, 18, 42)].forEach((now) => {
    const s = M.emptyState();
    sample.build(s, now);
    assert.equal(D.ymd(byTitle(s, '우유 사기').createdAt), D.ymd(now), now.toString());
    assert.ok(new Date(byTitle(s, '우유 사기').createdAt) <= now);
    assert.equal(D.ymd(byTitle(s, '빨래 돌리기').createdAt), D.ymd(D.addDays(now, -1)), now.toString());
  });
});

test('샘플의 집안일·가족 할 일은 단어 규칙으로 맥락이 잡힌다 (STATUS #142)', { skip: !ST && 'W1-status 병합 전' }, () => {
  const s = built();
  const prof = ST.profile({});
  const ctxOf = (title) => { const r = ST.ruleContext(title, prof); return r ? r.ctx : null; };
  assert.equal(ctxOf('빨래 돌리기'), 'home');
  assert.equal(ctxOf('분리수거'), 'home');
  assert.equal(ctxOf('엄마 생신 선물 주문'), 'family');
  assert.ok(s.tasks.some((t) => ctxOf(t.title) === 'home'));
  assert.ok(s.tasks.some((t) => ctxOf(t.title) === 'family'));
});
