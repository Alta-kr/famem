'use strict';
// 현재 상태 — 추천·샘플과 함께 (STATUS §20.5 #117 · §20.8 #143·#144 · §20.4 #109 를 실제 추천 순서로)
// recommend 의 statusView 주입(W1-slots-recommend)과 v4 샘플(W1-model)이 합쳐지기 전에는 건너뛴다 (IMPLEMENTATION_PLAN §0.9).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const D = require('../src/core/dates');
const M = require('../src/core/model');
const R = require('../src/core/recommend');
const ST = require('../src/core/status');
const SAMPLE = require('../renderer/sample');

const has = (rel) => fs.existsSync(path.join(__dirname, '..', rel));
const V4 = require('../src/core/model').SCHEMA_VERSION >= 4;                        // W1-model
const R_SV = (() => { const R = require('../src/core/recommend'), M = require('../src/core/model');   // W1-slots-recommend (statusView)
  const r = R.recommend(M.emptyState(), { now: new Date(2026, 9, 5, 10, 0), statusView: { active: true, levels: {}, rec: 'normal', offHours: false, workWindow: null, remainMinutes: null, label: 'x', id: 'work', category: 'work', guessed: false, overlay: null } });
  return !!(r.excluded && 'hidden' in r.excluded); })();
const SKIP = (!R_SV || !V4) && 'W1-slots-recommend·W1-model 병합 전';
void has;

// renderer/views/today.js todayTaskList 의 open 과 같은 식 (테스트용 사본)
function todayOpen(st, now) {
  const today = D.ymd(now);
  const blockToday = {};
  st.blocks.forEach((b) => { if (b.taskId && D.ymd(b.start) === today) blockToday[b.taskId] = true; });
  const open = [];
  M.liveTasks(st).forEach((t) => {
    if (t.status === 'done') return;
    if (t.status === 'in_progress' || blockToday[t.id] || (t.dueDate && t.dueDate <= today) || D.ymd(t.createdAt) === today) open.push(t);
  });
  const rank = (t) => (t.status === 'in_progress' ? 0 : t.dueDate && t.dueDate < today ? 1 : t.dueDate === today ? 2 : 3);
  open.sort((a, b) => rank(a) - rank(b) || (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || (a.createdAt < b.createdAt ? -1 : 1));
  return open;
}
const byTitle = (s, title) => s.tasks.find((t) => t.title === title);

test('#117 기능을 안 씀 + 제목 "업무"·"20분 업무"·일정 "회의" → ST.view null, 추천이 상태 없는 결과와 같다 (I1)', { skip: SKIP }, () => {
  const now = new Date(2026, 9, 5, 10, 0);
  const s = M.emptyState();
  M.addTask(s, { title: '업무' }, now);
  M.addTask(s, { title: '20분 업무', estimateMinutes: 20 }, now);
  M.addBlock(s, { title: '회의', start: new Date(2026, 9, 5, 10, 30).toISOString(), end: new Date(2026, 9, 5, 11, 30).toISOString() });
  const pf = ST.profile(s.prefs);
  const sv = ST.view(s, pf, now);
  assert.equal(sv, null);
  assert.equal(ST.current(s, pf, now), null);
  assert.deepEqual(R.recommend(s, { now }), R.recommend(s, { now, statusView: sv }));
  assert.deepEqual(R.recommend(s, { now, workHours: s.prefs.workHours }),
    R.recommend(s, { now, workHours: s.prefs.workHours, statusView: sv, status: ST.current(s, pf, now) }));
});

test('#143 토 01:25 에 샘플을 불러도(기능을 안 씀) view null · partitionToday 그대로 · 추천이 상태 없는 결과와 같다', { skip: SKIP }, () => {
  const now = new Date(2026, 9, 10, 1, 25);
  const s = M.emptyState();
  SAMPLE.build(s, now);
  const pf = ST.profile(s.prefs);
  assert.equal(s.presence.activatedAt, null, '샘플은 기능을 켜지 않는다');
  assert.equal(ST.isActive(s, pf), false);
  const sv = ST.view(s, pf, now);
  assert.equal(sv, null);
  const open = todayOpen(s, now);
  assert.deepEqual(ST.partitionToday(s, open, sv, {}),
    { when: [], up: [], normal: open.map((t) => t.id), extra: [], down: [], hidden: [], summary: null });
  assert.deepEqual(R.recommend(s, { now }), R.recommend(s, { now, statusView: sv }));
  open.forEach((t) => assert.equal(ST.isHidden(sv, t.id), false));
});

test('#144 샘플 + 명시 퇴근(금 18:42): 빨래 돌리기가 extra, 업무는 숨긴 줄, 오늘 18:00 마감 지난 업무는 내림', { skip: SKIP }, () => {
  const now = new Date(2026, 9, 9, 18, 42);
  const s = M.emptyState();
  SAMPLE.build(s, now);
  const pf = ST.profile(s.prefs);
  ST.setStatus(s, { id: 'off' }, { source: 'text', text: '퇴근!' }, pf, now);
  const sv = ST.view(s, pf, now);
  const r = R.recommend(s, { now, workHours: s.prefs.workHours, statusView: sv });
  const ranked = r.ranked.map((x) => x.taskId);
  const part = ST.partitionToday(s, todayOpen(s, now), sv, { rankedIds: ranked });
  const laundry = byTitle(s, '빨래 돌리기'), mentor = byTitle(s, '멘토 배정 기준 초안 작성');
  assert.ok(part.extra.includes(laundry.id), '빨래 돌리기 → 지금 하기 좋은 일');
  assert.ok(part.hidden.length >= 1);
  part.hidden.forEach((id) => assert.equal(sv.levels[id].ctx, 'work'));
  assert.ok(part.down.includes(mentor.id));
  assert.equal(sv.levels[mentor.id].reason, 'due');
  assert.equal(sv.levels[mentor.id].ctxSource, 'project');
  assert.match(ST.hiddenSummaryText(part.summary, pf), /^업무 할 일 \d+개 숨김$/);
  assert.ok(part.up.includes(byTitle(s, '분리수거').id));
  // 숨긴 할 일은 추천 후보에서 빠진다
  ranked.forEach((id) => assert.equal(ST.isHidden(sv, id), false));
  // 대기·선행·미루기로 이미 빠진 할 일은 hidden 으로 세지 않는다
  assert.equal(r.excluded.hidden, sv.hiddenIds.filter((id) => R.checkStartable(s, id, now).ok).length);
  assert.ok(r.excluded.hidden >= 1);
});

test('#109 extra 는 실제 추천 순서(rankedIds)를 따른다', { skip: SKIP }, () => {
  const now = new Date(2026, 9, 9, 18, 42);
  const yesterday = new Date(2026, 9, 8, 18, 42);
  const s = M.emptyState();
  const low = M.addTask(s, { title: '다림질', priority: 'low' }, yesterday);
  const mid = M.addTask(s, { title: '빨래 돌리기' }, yesterday);
  const high = M.addTask(s, { title: '설거지', priority: 'high' }, yesterday);
  const pf = ST.profile(s.prefs);
  ST.setStatus(s, { id: 'off' }, { source: 'text' }, pf, now);
  const sv = ST.view(s, pf, now);
  const ranked = R.recommend(s, { now, workHours: s.prefs.workHours, statusView: sv }).ranked.map((x) => x.taskId);
  const part = ST.partitionToday(s, todayOpen(s, now), sv, { rankedIds: ranked });
  assert.deepEqual(part.extra, [high.id, mid.id, low.id]);
});
