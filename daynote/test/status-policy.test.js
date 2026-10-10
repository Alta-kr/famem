'use strict';
// 현재 상태 — 정책표·돌파·오늘 화면 나누기 (STATUS §20.4 #88–114)
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../src/core/dates');
const M = require('../src/core/model');
const ST = require('../src/core/status');

const at = (d, h, m) => new Date(2026, 9, d, h, m || 0);   // 10월 d일 — 5 월 · 7 수 · 8 목 · 9 금 · 10 토 · 12 월
const ymd = (d) => D.ymd(at(d, 12));

function world(prefs) {
  const s = M.emptyState();
  Object.assign(s.prefs, prefs || {});
  return { s, pf: ST.profile(s.prefs) };
}
function set(s, pf, id, when, extra) { return ST.setStatus(s, Object.assign({ id }, extra || {}), { source: 'chip' }, pf, when); }
function lv(s, pf, t, now) {
  const eff = ST.effective(s, pf, now);
  return ST.levelOf(s, t, ST.contextOf(s, t, pf, now), eff, pf, now);
}
const L = (s, pf, t, now) => lv(s, pf, t, now).level;
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

test('#88 eff null → applyStatusPolicy 가 입력 순서 그대로 visible, 나머지는 빈 값', () => {
  const { s, pf } = world();
  const a = M.addTask(s, { title: '보고서 쓰기' }, at(5, 9));
  const b = M.addTask(s, { title: '빨래 돌리기' }, at(5, 9));
  assert.deepEqual(ST.applyStatusPolicy(s, [a, b], null, pf, at(5, 10)), { visible: [a.id, b.id], demoted: [], hidden: [], levels: {}, reasons: {} });
  assert.deepEqual(ST.levelOf(s, a, null, null, pf, at(5, 10)), { level: 'normal', reason: null, breakthrough: null });
});

test('#89 명시 업무: 업무 띄움, 빨래 내림, 맥락 없음 보통', () => {
  const { s, pf } = world();
  const w = M.addTask(s, { title: '견적서 보내기' }, at(5, 9));
  const h = M.addTask(s, { title: '빨래 돌리기' }, at(5, 9));
  const n = M.addTask(s, { title: '정리하기' }, at(5, 9));
  set(s, pf, 'work', at(5, 9));
  const r = ST.applyStatusPolicy(s, [h, n, w], ST.effective(s, pf, at(5, 10)), pf, at(5, 10));
  assert.deepEqual(r.visible, [w.id, n.id]);
  assert.deepEqual(r.demoted, [h.id]);
  assert.deepEqual(r.hidden, []);
  assert.equal(r.levels[w.id].level, 'up');
  assert.equal(r.reasons[w.id], '지금은 ‘업무 중’이라 ‘업무’ 일을 먼저 골랐어요.');
});

test('#90 명시 퇴근: 업무 숨김, 집안일·개인·가족 띄움, 밖 볼일·공부 보통', () => {
  const { s, pf } = world();
  const T = (title) => M.addTask(s, { title }, at(5, 9));
  const w = T('견적서 보내기'), h = T('빨래 돌리기'), p = T('헬스 등록 알아보기'), f = T('어린이집 준비물'), e = T('우체국 택배 보내기'), st = T('과제 제출');
  set(s, pf, 'off', at(5, 18, 40));
  const now = at(5, 19);
  assert.deepEqual([w, h, p, f, e, st].map((t) => L(s, pf, t, now)), ['hide', 'up', 'up', 'up', 'normal', 'normal']);
  assert.equal(lv(s, pf, h, now).reason, 'policy');
});

test('#91 짐작 퇴근 후: 업무는 내림(숨김 아님), 집안일은 보통(띄움 아님). hideOnGuess 면 숨김', () => {
  const { s, pf } = world();
  const w = M.addTask(s, { title: '견적서 보내기' }, at(5, 9));
  const h = M.addTask(s, { title: '빨래 돌리기' }, at(5, 9));
  ST.toGuess(s, at(5, 9), pf);
  const now = at(5, 20);
  assert.equal(ST.effective(s, pf, now).guessed, true);
  assert.equal(L(s, pf, w, now), 'down');
  assert.equal(L(s, pf, h, now), 'normal');
  const g = world({ statusProfile: { autoSchedule: { hideOnGuess: true } } });
  const w2 = M.addTask(g.s, { title: '견적서 보내기' }, at(5, 9));
  ST.toGuess(g.s, at(5, 9), g.pf);
  assert.equal(L(g.s, g.pf, w2, now), 'hide');
});

test('#92 afterWork:down → 명시 퇴근에서 업무 내림', () => {
  const { s, pf } = world({ statusProfile: { afterWork: 'down' } });
  const w = M.addTask(s, { title: '견적서 보내기' }, at(5, 9));
  set(s, pf, 'off', at(5, 18, 40));
  assert.equal(L(s, pf, w, at(5, 19)), 'down');
});

test('#93 덧씌움 식사(바탕 업무) → 업무 중과 같은 수준', () => {
  const { s, pf } = world();
  const ts = ['견적서 보내기', '빨래 돌리기', '정리하기', '우유 사기'].map((title) => M.addTask(s, { title }, at(5, 9)));
  set(s, pf, 'work', at(5, 9));
  const base = ts.map((t) => L(s, pf, t, at(5, 12, 10)));
  set(s, pf, 'meal', at(5, 12, 5));
  assert.equal(ST.effective(s, pf, at(5, 12, 10)).overlay.id, 'meal');
  assert.deepEqual(ts.map((t) => L(s, pf, t, at(5, 12, 10))), base);
  assert.deepEqual(base, ['up', 'down', 'normal', 'down']);
});

test('#94 명시 외출: 업무 내림, 밖 볼일 띄움', () => {
  const { s, pf } = world();
  const w = M.addTask(s, { title: '견적서 보내기' }, at(5, 9));
  const e = M.addTask(s, { title: '우체국 택배 보내기' }, at(5, 9));
  set(s, pf, 'out', at(5, 14));
  assert.equal(L(s, pf, w, at(5, 14, 30)), 'down');
  assert.equal(L(s, pf, e, at(5, 14, 30)), 'up');
});

test('#95 걸어 둔 상태(퇴근하고) 업무 할 일: 명시 퇴근·쉬는 날에서 띄움(숨지 않음), 업무에서는 정책대로, 짐작에서는 띄우지 않음', () => {
  const { s, pf } = world();
  const t = M.addTask(s, { title: '보고서 출력', atMode: 'off', atModeSource: 'rule' }, at(5, 9));
  set(s, pf, 'off', at(5, 18, 40));
  assert.deepEqual([L(s, pf, t, at(5, 19)), lv(s, pf, t, at(5, 19)).reason], ['up', 'when']);
  set(s, pf, 'day_off', at(5, 19, 30));
  assert.equal(L(s, pf, t, at(5, 20)), 'up');
  set(s, pf, 'work', at(6, 9));
  assert.deepEqual([L(s, pf, t, at(6, 10)), lv(s, pf, t, at(6, 10)).reason], ['up', 'policy']);
  const g = world();
  const t2 = M.addTask(g.s, { title: '보고서 출력', atMode: 'off' }, at(5, 9));
  ST.toGuess(g.s, at(5, 9), g.pf);
  assert.equal(L(g.s, g.pf, t2, at(5, 20)), 'down');
  // 이유 문장
  set(s, pf, 'off', at(6, 18, 40));
  const v = ST.view(s, pf, at(6, 19));
  assert.equal(v.levels[t.id].sentence, '‘퇴근하고’ 하기로 한 일이에요.');
});

test('#96 atMode pause → 식사 덧씌움에서 목록 수준은 바탕 그대로, view.anchored 에 든다', () => {
  const { s, pf } = world();
  const t = M.addTask(s, { title: '은행 들르기', atMode: 'pause' }, at(5, 9));
  set(s, pf, 'work', at(5, 9));
  const base = L(s, pf, t, at(5, 12));
  set(s, pf, 'meal', at(5, 12, 5));
  const v = ST.view(s, pf, at(5, 12, 10));
  assert.equal(v.levels[t.id].level, base);
  assert.equal(base, 'down');
  assert.ok(v.anchored.includes(t.id));
  assert.equal(ST.view(s, pf, at(5, 14)).anchored.includes(t.id), false);
});

test('#97 shown 에 든 숨김 할 일 → 보통. 바탕이 바뀌면 다시 숨김', () => {
  const { s, pf } = world();
  const w = M.addTask(s, { title: '견적서 보내기' }, at(5, 9));
  set(s, pf, 'off', at(5, 18, 40));
  assert.equal(L(s, pf, w, at(5, 19)), 'hide');
  ST.markShown(s, w.id);
  assert.deepEqual([L(s, pf, w, at(5, 19)), lv(s, pf, w, at(5, 19)).reason], ['normal', 'shown']);
  set(s, pf, 'day_off', at(5, 19, 30));
  assert.equal(L(s, pf, w, at(5, 20)), 'hide');
});

test('#98 진행 중: 이 상태에서 시작했으면 보통, 그 전부터면 숨김', () => {
  const { s, pf } = world();
  set(s, pf, 'off', at(5, 18, 40));
  const a = M.addTask(s, { title: '견적서 보내기', status: 'in_progress', startedAt: at(5, 19).toISOString() }, at(5, 9));
  const b = M.addTask(s, { title: '보고서 쓰기', status: 'in_progress', startedAt: at(5, 17).toISOString() }, at(5, 9));
  assert.deepEqual([L(s, pf, a, at(5, 19, 30)), lv(s, pf, a, at(5, 19, 30)).reason], ['normal', 'started']);
  assert.equal(L(s, pf, b, at(5, 19, 30)), 'hide');
});

test('#99 작업 블록이 지금 또는 30분 안 → 보통(block). 31분 뒤면 그대로', () => {
  const { s, pf } = world();
  set(s, pf, 'off', at(5, 18, 40));
  const a = M.addTask(s, { title: '견적서 보내기' }, at(5, 9));
  const b = M.addTask(s, { title: '보고서 쓰기' }, at(5, 9));
  M.addBlock(s, { taskId: a.id, title: a.title, start: at(5, 20).toISOString(), end: at(5, 21).toISOString() });
  M.addBlock(s, { taskId: b.id, title: b.title, start: at(5, 20, 1).toISOString(), end: at(5, 21).toISOString() });
  assert.deepEqual([L(s, pf, a, at(5, 19, 30)), lv(s, pf, a, at(5, 19, 30)).reason], ['normal', 'block']);
  assert.equal(L(s, pf, b, at(5, 19, 30)), 'hide');
  assert.equal(L(s, pf, a, at(5, 20, 30)), 'normal');
});

test('#100 돌파 경계(금 19:00 명시 퇴근): 토 23:59 마감 내림 · 월 10:00 숨김 · 3일 지남 내림 · 오늘 21:00 보통 · 22:30 내림', () => {
  const { s, pf } = world();
  const T = (dueDate, dueTime) => M.addTask(s, { title: '견적서 보내기', dueDate, dueTime: dueTime || null }, at(9, 9));
  const sat = T(ymd(10)), mon = T(ymd(12), '10:00'), late = T(ymd(6)), soon = T(ymd(9), '21:00'), later = T(ymd(9), '22:30');
  set(s, pf, 'off', at(9, 19));
  const now = at(9, 19);
  assert.deepEqual([sat, mon, late, soon, later].map((t) => L(s, pf, t, now)), ['down', 'hide', 'down', 'normal', 'down']);
  const x = lv(s, pf, soon, now);
  assert.deepEqual([x.reason, x.breakthrough.soon, x.breakthrough.dueAt], ['due_soon', true, at(9, 21).toISOString()]);
  assert.equal(lv(s, pf, sat, now).reason, 'due');
  const v = ST.view(s, pf, now);
  assert.equal(v.levels[soon.id].sentence, '‘업무’ 할 일이지만 21:00 마감이라 골랐어요.');
  assert.equal(v.levels[sat.id].sentence, '‘업무’ 할 일이지만 내일 마감이라 남겨 뒀어요.');
  assert.equal(v.levels[mon.id].sentence, null);
  // 마감 시각이 없는 오늘 마감 → '23:59' 가 아니라 '오늘'
  const today = T(ymd(9));
  const v2 = ST.view(s, pf, at(9, 21, 30));
  assert.equal(v2.levels[today.id].reason, 'due_soon');
  assert.equal(v2.levels[today.id].sentence, '‘업무’ 할 일이지만 오늘 마감이라 골랐어요.');
});

test('#101 nextActiveStart: 금 19:00 퇴근 → 월 09:00, 수 15:00 퇴근 → 목 09:00, 짐작 끔 → now + 12시간', () => {
  const { s, pf } = world();
  set(s, pf, 'off', at(9, 19));
  assert.equal(ST.nextActiveStart(pf, 'work', ST.effective(s, pf, at(9, 19)), at(9, 19)).toISOString(), at(12, 9).toISOString());
  // 명시 상태는 그 상태가 끝나는 때(토 04:00)부터 본다
  assert.equal(ST.nextActiveStart(pf, 'home', ST.effective(s, pf, at(9, 19)), at(9, 19)).toISOString(), at(10, 4).toISOString());
  const w = world();
  set(w.s, w.pf, 'off', at(7, 15));
  assert.equal(ST.nextActiveStart(w.pf, 'work', ST.effective(w.s, w.pf, at(7, 15)), at(7, 15)).toISOString(), at(8, 9).toISOString());
  const o = world({ statusProfile: { autoSchedule: { mode: 'off' } } });
  const eleven = M.addTask(o.s, { title: '견적서 보내기', dueDate: ymd(10), dueTime: '06:00' }, at(9, 9));
  const thirteen = M.addTask(o.s, { title: '견적서 보내기', dueDate: ymd(10), dueTime: '08:00' }, at(9, 9));
  set(o.s, o.pf, 'off', at(9, 19));
  assert.equal(ST.nextActiveStart(o.pf, 'work', ST.effective(o.s, o.pf, at(9, 19)), at(9, 19)).toISOString(), at(10, 7).toISOString());
  assert.equal(L(o.s, o.pf, eleven, at(9, 19)), 'down');
  assert.equal(L(o.s, o.pf, thirteen, at(9, 19)), 'hide');
});

test('#102 urgentHours 0 → 3시간 안 마감도 보통으로 올리지 않는다(다음 활동 전이면 내림까지만)', () => {
  const { s, pf } = world({ statusProfile: { urgentHours: 0 } });
  const t = M.addTask(s, { title: '견적서 보내기', dueDate: ymd(9), dueTime: '21:00' }, at(9, 9));
  set(s, pf, 'off', at(9, 19));
  assert.equal(L(s, pf, t, at(9, 19)), 'down');
});

test('#103 약한 힌트(메일) 업무 + 명시 퇴근 → 숨김이 아니라 내림', () => {
  const { s, pf } = world();
  const t = M.addTask(s, { title: '확인 부탁', sources: [{ type: 'email', refId: 'mail_1', excerpt: '확인 부탁' }] }, at(5, 9));
  set(s, pf, 'off', at(5, 18, 40));
  assert.equal(ST.contextOf(s, t, pf, at(5, 19)).source, 'hint');
  assert.equal(L(s, pf, t, at(5, 19)), 'down');
});

test('#104 이동 중 + 폰으로 할 일 → 띄움. 퇴근길 + 업무 폰 할 일(숨김)은 숨김 그대로', () => {
  const { s, pf } = world();
  const p = M.addTask(s, { title: '치과 예약' }, at(5, 9));
  const w = M.addTask(s, { title: '거래처 전화' }, at(5, 9));
  set(s, pf, 'to_home', at(5, 18, 30));
  assert.deepEqual([L(s, pf, p, at(5, 18, 40)), lv(s, pf, p, at(5, 18, 40)).reason], ['up', 'phone']);
  assert.equal(L(s, pf, w, at(5, 18, 40)), 'hide');
  assert.equal(ST.view(s, pf, at(5, 18, 40)).levels[p.id].sentence, '이동 중에 폰으로 할 수 있는 일이에요.');
});

test('#105 잘 시간 → 모두 숨김, shown 만 예외', () => {
  const { s, pf } = world();
  const a = M.addTask(s, { title: '빨래 돌리기' }, at(5, 9));
  const b = M.addTask(s, { title: '정리하기' }, at(5, 9));
  set(s, pf, 'sleep', at(5, 23));
  assert.deepEqual([L(s, pf, a, at(5, 23, 10)), L(s, pf, b, at(5, 23, 10))], ['hide', 'hide']);
  ST.markShown(s, b.id);
  assert.equal(L(s, pf, b, at(5, 23, 10)), 'normal');
});

test('#106 명시 모두 보기(none) → 모두 보통', () => {
  const { s, pf } = world();
  const ts = ['견적서 보내기', '빨래 돌리기', '과제 제출'].map((title) => M.addTask(s, { title }, at(5, 9)));
  set(s, pf, 'none', at(5, 19));
  assert.deepEqual(ts.map((t) => L(s, pf, t, at(5, 19, 5))), ['normal', 'normal', 'normal']);
});

test('#107 프리랜서 프리셋: 명시 일 끝(off)에서 업무는 내림', () => {
  const { s, pf } = world({ statusProfile: { preset: 'freelance' } });
  const w = M.addTask(s, { title: '견적서 보내기' }, at(5, 9));
  set(s, pf, 'off', at(5, 19));
  assert.equal(pf.statuses.off.label, '일 끝');
  assert.equal(L(s, pf, w, at(5, 19, 5)), 'down');
});

test('#108 partitionToday: when/up/normal/extra/down/hidden — 묶음 안 순서는 입력 순서, done 은 없다, summary', () => {
  const { s, pf } = world();
  const now = at(5, 19);
  const T = (title, extra) => M.addTask(s, Object.assign({ title }, extra || {}), at(5, 9));
  const work = T('견적서 보내기');
  const home = T('빨래 돌리기');
  const errand = T('우체국 택배 보내기');
  const late = T('보고서 정리', { dueDate: ymd(4) });
  const none = T('정리하기');
  const fam = T('엄마 생신 선물 주문');
  const done = T('설거지');
  M.completeTask(s, done.id, at(5, 12));
  set(s, pf, 'off', at(5, 18, 40));
  const v = ST.view(s, pf, now);
  const open = [work, home, errand, late, none, fam, done];
  const part = ST.partitionToday(s, open, v, {});
  assert.deepEqual(part.up, [home.id, fam.id]);
  assert.deepEqual(part.normal, [errand.id, none.id]);
  assert.deepEqual(part.down, [late.id]);
  assert.deepEqual(part.hidden, [work.id]);
  assert.deepEqual(part.when, []);
  assert.deepEqual(part.summary, { hidden: 1, byCtx: { work: 1 }, parked: 0, guessedDown: false });
  assert.deepEqual(ST.partitionToday(s, open.map((t) => t.id), v, {}).hidden, [work.id], 'id 배열도 받는다');
  assert.equal(ST.hiddenSummaryText(part.summary, pf), '업무 할 일 1개 숨김');
});

test('#109 extra: 날짜 없이 어제 만든 빨래 → 명시 퇴근에서 extra. 짐작에서는 빈다. 대기·선행·미루기는 빠진다. 5개 상한, rankedIds 순서', () => {
  const now = at(9, 18, 42);
  const yesterday = at(8, 18, 42);
  const { s, pf } = world();
  const laundry = M.addTask(s, { title: '빨래 돌리기', estimateMinutes: 15 }, yesterday);
  const waiting = M.addTask(s, { title: '세탁기 수리 기사 방문', status: 'waiting' }, yesterday);
  const blocker = M.addTask(s, { title: '보고서 쓰기' }, yesterday);
  const blocked = M.addTask(s, { title: '설거지', blockedBy: [blocker.id] }, yesterday);
  const snoozed = M.addTask(s, { title: '분리수거', snoozedUntil: at(10, 9).toISOString() }, yesterday);
  set(s, pf, 'off', at(9, 18, 40));
  const open = todayOpen(s, now);
  assert.equal(open.some((t) => t.id === laundry.id), false, '오늘 목록 밖');
  const part = ST.partitionToday(s, open, ST.view(s, pf, now), {});
  assert.deepEqual(part.extra, [laundry.id]);
  [waiting, blocked, snoozed].forEach((t) => assert.equal(part.extra.includes(t.id), false));
  // 짐작에서는 extra 가 빈다
  const g = world();
  M.addTask(g.s, { title: '빨래 돌리기' }, yesterday);
  ST.toGuess(g.s, at(9, 9), g.pf);
  assert.deepEqual(ST.partitionToday(g.s, todayOpen(g.s, now), ST.view(g.s, g.pf, now), {}).extra, []);
  // 5개 상한 + rankedIds 순서
  const many = world();
  const ids = ['빨래 개기', '설거지', '분리수거', '청소기 돌리기', '이불 빨래', '다림질', '화분 물 주기']
    .map((title) => M.addTask(many.s, { title }, yesterday).id);
  set(many.s, many.pf, 'off', at(9, 18, 40));
  const ranked = ids.slice().reverse();
  const p2 = ST.partitionToday(many.s, todayOpen(many.s, now), ST.view(many.s, many.pf, now), { rankedIds: ranked });
  assert.deepEqual(p2.extra, ranked.slice(0, 5));
});

test('#110 when: 오늘 목록 밖의 "우유 사기"(atMode out)가 퇴근길에서 when 에 든다. 5개 상한', () => {
  const now = at(9, 18, 42);
  const yesterday = at(8, 12);
  const { s, pf } = world();
  const milk = M.addTask(s, { title: '우유 사기', atMode: 'out', atModeSource: 'rule' }, yesterday);
  const other = M.addTask(s, { title: '세탁소 맡기기' }, yesterday);
  set(s, pf, 'to_home', at(9, 18, 40));
  const part = ST.partitionToday(s, todayOpen(s, now), ST.view(s, pf, now), {});
  assert.deepEqual(part.when, [milk.id]);
  assert.deepEqual(part.extra, [other.id]);
  const many = world();
  for (let i = 0; i < 7; i++) M.addTask(many.s, { title: '우체국 들르기 ' + i, atMode: 'out' }, yesterday);
  set(many.s, many.pf, 'to_home', at(9, 18, 40));
  assert.equal(ST.partitionToday(many.s, todayOpen(many.s, now), ST.view(many.s, many.pf, now), {}).when.length, 5);
});

test('#111 view null → { normal: open, 나머지 빈 배열, summary: null }', () => {
  const { s, pf } = world();
  const a = M.addTask(s, { title: '견적서 보내기' }, at(5, 9));
  const b = M.addTask(s, { title: '빨래 돌리기' }, at(5, 9));
  assert.equal(ST.view(s, pf, at(5, 19)), null);
  assert.deepEqual(ST.partitionToday(s, [a, b], null, {}), { when: [], up: [], normal: [a.id, b.id], extra: [], down: [], hidden: [], summary: null });
});

test('#112 joinOrder: 묶음 하나를 끌어도 이은 전체 순서가 (i+1)*10 으로 겹치지 않게 매겨진다', () => {
  const groups = { when: ['a'], upNormal: ['b', 'c'], down: ['d', 'e'] };
  const order = ST.joinOrder(groups, 'down', ['e', 'd']);
  assert.deepEqual(order, ['a', 'b', 'c', 'e', 'd']);
  const s = M.emptyState();
  ['a', 'b', 'c', 'd', 'e'].forEach((id) => M.addTask(s, { id, title: id }, at(5, 9)));
  order.forEach((id, i) => { M.byId(s.tasks, id).sortOrder = (i + 1) * 10; });
  const sorts = s.tasks.map((t) => t.sortOrder);
  assert.equal(new Set(sorts).size, 5);
  assert.deepEqual(ST.joinOrder(groups, 'upNormal', ['c', 'b']), ['a', 'c', 'b', 'd', 'e']);
});

test('#113 숨긴 줄 문구', () => {
  const pf = ST.profile({});
  assert.equal(ST.hiddenSummaryText({ hidden: 5, byCtx: { work: 5 }, parked: 0 }, pf), '업무 할 일 5개 숨김');
  assert.equal(ST.hiddenSummaryText({ hidden: 5, byCtx: { study: 1, work: 4 }, parked: 0 }, pf), '업무 할 일 4개 · 공부 1개 숨김');
  assert.equal(ST.hiddenSummaryText({ hidden: 5, byCtx: { work: 5 }, parked: 1 }, pf), '업무 할 일 5개 숨김 (하던 일 1)');
  assert.equal(ST.hiddenSummaryText({ hidden: 5, byCtx: { work: 5 }, parked: 1 }, pf, { short: true }), '업무 5 숨김');
  assert.equal(ST.hiddenSummaryText({ hidden: 0, byCtx: {}, parked: 0 }, pf), '');
  assert.equal(ST.hiddenSummaryText(null, pf), '');
});

test('#114 사이드바 숫자 도우미: 오늘(마감 ≤ 오늘) 숫자에서 숨김을 뺀다', () => {
  // 시간표 짐작을 끄면 돌파 기준이 now + 12시간이라 오늘 밤 마감 업무도 숨는다 (10:05 → 23:59 는 13시간 뒤)
  const { s, pf } = world({ statusProfile: { autoSchedule: { mode: 'off' } } });
  const today = ymd(5);
  const w = M.addTask(s, { title: '견적서 보내기', dueDate: today }, at(5, 9));
  M.addTask(s, { title: '빨래 돌리기', dueDate: today }, at(5, 9));
  M.addTask(s, { title: '정리하기', dueDate: today }, at(5, 9));
  const count = (sv) => M.liveTasks(s).filter((t) => t.status !== 'done' && t.dueDate && t.dueDate <= today && !ST.isHidden(sv, t.id)).length;
  assert.equal(count(ST.view(s, pf, at(5, 10, 5))), 3, '켜기 전에는 그대로');
  set(s, pf, 'off', at(5, 10));
  const sv = ST.view(s, pf, at(5, 10, 5));
  assert.equal(ST.isHidden(sv, w.id), true);
  assert.equal(count(sv), 2);
  assert.equal(ST.isHidden(null, 'x'), false);
});

test('view: 남은 시간·근무 시간 밖·근무 창·요약 (recommend 에 넘기는 평범한 데이터)', () => {
  const { s, pf } = world();
  M.addTask(s, { title: '견적서 보내기' }, at(5, 9));
  set(s, pf, 'work', at(5, 9));
  set(s, pf, 'break', at(5, 15, 30), { minutes: 15 });
  const v = ST.view(s, pf, at(5, 15, 33));
  assert.equal(v.active, true);
  assert.deepEqual([v.id, v.label, v.category, v.guessed], ['work', '업무 중', 'work', false]);
  assert.equal(v.overlay.id, 'break');
  assert.equal(v.rec, 'short');
  assert.equal(v.remainMinutes, 12);
  assert.equal(v.offHours, false);
  assert.deepEqual(v.workWindow, { start: at(5, 9).toISOString(), end: at(5, 18).toISOString() });
  const night = ST.view(s, pf, at(5, 20));
  assert.deepEqual([night.offHours, night.workWindow, night.remainMinutes], [false, null, null], '명시 업무는 야근이어도 근무 시간 밖이 아니다');
  set(s, pf, 'off', at(5, 20));
  const off = ST.view(s, pf, at(5, 20, 5));
  assert.deepEqual([off.offHours, off.workWindow, off.nudges, off.busy], [true, null, true, false]);
  assert.deepEqual(off.summary, { hidden: 1, byCtx: { work: 1 }, parked: 0 });
  set(s, pf, 'meeting', at(5, 20, 10));
  const mt = ST.view(s, pf, at(5, 20, 15));
  assert.deepEqual([mt.rec, mt.busy, mt.nudges, mt.remainMinutes], ['none', true, false, null]);
});
