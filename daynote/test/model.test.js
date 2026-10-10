'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/core/model');

const NOW = new Date(2026, 9, 5, 10, 0);
const LATER = new Date(2026, 9, 6, 10, 0);
const at = (h, m) => new Date(2026, 9, 5, h, m || 0).toISOString();

test('completeTask → task_done 기록', () => {
  const s = M.emptyState();
  const t = M.addTask(s, { title: 'x' }, NOW);
  const res = M.completeTask(s, t.id, NOW);
  assert.equal(t.status, 'done');
  assert.equal(s.history.length, 1);
  assert.equal(s.history[0].type, 'task_done');
  assert.equal(s.history[0].id, res.historyId);
  assert.equal(M.completeTask(s, t.id, NOW), null); // 두 번 완료 안 됨
});

test('reopenTask undoOf → 기록 삭제, 이전 상태 복원', () => {
  const s = M.emptyState();
  const t = M.addTask(s, { title: 'x', status: 'in_progress' }, NOW);
  const res = M.completeTask(s, t.id, NOW);
  M.reopenTask(s, t.id, NOW, { undoOf: res.historyId, prevStatus: res.prevStatus });
  assert.equal(s.history.length, 0);
  assert.equal(t.status, 'in_progress');
  assert.equal(t.completedAt, null);
});

test('일반 reopen → revokedAt + task_reopened', () => {
  const s = M.emptyState();
  const t = M.addTask(s, { title: 'x' }, NOW);
  M.completeTask(s, t.id, NOW);
  M.reopenTask(s, t.id, LATER);
  assert.equal(t.status, 'todo');
  assert.equal(s.history.length, 2);
  assert.equal(s.history[0].revokedAt, LATER.toISOString());
  assert.equal(s.history[1].type, 'task_reopened');
});

test('deleteTask → 미래 블록만 삭제', () => {
  const s = M.emptyState();
  const t = M.addTask(s, { title: 'x' }, NOW);
  const past = M.addBlock(s, { taskId: t.id, start: at(8), end: at(9) });
  M.addBlock(s, { taskId: t.id, start: at(14), end: at(15) });
  const ev = M.addBlock(s, { title: 'ev', start: at(16), end: at(17) });
  M.deleteTask(s, t.id, NOW);
  assert.ok(t.deletedAt);
  assert.equal(s.tasks.length, 1);
  assert.deepEqual(s.blocks.map((b) => b.id), [past.id, ev.id]);
});

test('deleteBlock 은 task 유지', () => {
  const s = M.emptyState();
  const t = M.addTask(s, { title: 'x' }, NOW);
  const b = M.addBlock(s, { taskId: t.id, start: at(14), end: at(15) });
  M.deleteBlock(s, b.id);
  assert.equal(s.blocks.length, 0);
  assert.equal(s.tasks.length, 1);
  assert.equal(t.deletedAt, null);
});

test('mergeSuggestions 중복 key 무시 (상태 무관)', () => {
  const s = M.emptyState();
  const c = { key: 'note1:보고서', title: '보고서', sourceType: 'note', sourceId: 'n1' };
  assert.equal(M.mergeSuggestions(s, [c, Object.assign({}, c)], NOW).length, 1);
  M.dismissSuggestion(s, s.suggestions[0].id, NOW);
  assert.equal(M.mergeSuggestions(s, [c], NOW).length, 0);
  assert.equal(s.suggestions.length, 1);
});

test('acceptSuggestion 두 번 → Task 1개, duplicate:true', () => {
  const s = M.emptyState();
  const [sug] = M.mergeSuggestions(s, [{ key: 'k', title: 't', sourceType: 'note', sourceId: 'n1' }], NOW);
  const a = M.acceptSuggestion(s, sug.id, {}, NOW);
  const b = M.acceptSuggestion(s, sug.id, {}, NOW);
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(b.task.id, a.task.id);
  assert.equal(s.tasks.length, 1);
  assert.equal(a.task.sources[0].suggestionId, sug.id);
});

test('resolveRef: 삭제된 원본은 missing:true', () => {
  const s = M.emptyState();
  const t = M.addTask(s, { title: 'x' }, NOW);
  const n = M.addNote(s, { body: '# 회의록\n내용' }, NOW);
  assert.equal(M.resolveRef(s, { kind: 'task', id: t.id }).missing, false);
  assert.equal(M.resolveRef(s, { kind: 'note', id: n.id }).label, '회의록');
  M.deleteTask(s, t.id, NOW);
  M.deleteNote(s, n.id, NOW);
  assert.equal(M.resolveRef(s, { kind: 'task', id: t.id }).missing, true);
  assert.equal(M.resolveRef(s, { kind: 'note', id: n.id }).missing, true);
  const gone = M.resolveRef(s, { kind: 'email', id: 'nope', label: '옛 제목' });
  assert.equal(gone.missing, true);
  assert.equal(gone.label, '옛 제목');
});

// ───────────────────────────── 스키마 v4: presence · learned · gcal · 할 일 맥락 ─────────────────────────────
const D = require('../src/core/dates');

const E_PRESENCE = { v: 1, activatedAt: null, current: null, shown: [], parked: [], log: [],
  hints: { day: null, used: 0, overtimeDismiss: 0, presetSeen: {}, presetOffered: {} } };
const E_LEARNED = { v: 1, rules: [], metrics: { learned: 0, applied: 0, reverted: 0, hinted: 0 }, bootstrappedAt: null, compactedAt: null };
const E_GCAL = { v: 1, accountId: null, settings: { exportEnabled: true, exportWork: true, exportTitles: true },
  calendars: [], exportCalendarId: null, events: [], links: {}, gens: {}, outbox: [],
  backoffUntil: null, lastSyncAt: null, lastError: null };

// 가져온 Google 일정(GEvent) — gcal.normalizeEvent 결과와 같은 모양으로 손으로 만든다
function gev(calendarId, eventId, start, end, extra) {
  return Object.assign({
    key: 'g:' + calendarId + '|' + eventId, calendarId, eventId, recurringEventId: null,
    etag: '"e1"', updated: NOW.toISOString(), status: 'confirmed', title: 'G ' + eventId, location: '',
    htmlLink: 'https://www.google.com/calendar/event?eid=' + eventId, eventType: 'default',
    allDay: false, start, end, startDate: null, endDate: null, tz: 'Asia/Seoul',
    busy: true, response: null, origin: 'google', daynoteId: null
  }, extra || {});
}
function allDayEv(calendarId, eventId, ymdStart, ymdEnd, extra) {
  return gev(calendarId, eventId, D.parseYmd(ymdStart).toISOString(), D.parseYmd(ymdEnd).toISOString(),
    Object.assign({ allDay: true, startDate: ymdStart, endDate: ymdEnd, busy: false, tz: null }, extra || {}));
}
const CAL = { id: 'me@gmail.com', summary: '내 캘린더', primary: true, color: '#7986cb', accessRole: 'owner', timeZone: 'Asia/Seoul', selected: true, isExport: false };

test('SCHEMA_VERSION 은 4, emptyState 에 presence·learned·gcal 기본값 (계획 §2.1 그대로)', () => {
  assert.equal(M.SCHEMA_VERSION, 4);
  const s = M.emptyState();
  assert.equal(s.version, 4);
  assert.deepEqual(s.presence, E_PRESENCE);
  assert.deepEqual(s.learned, E_LEARNED);
  assert.deepEqual(s.gcal, E_GCAL);
  ['externalEvents', 'statusHistory', 'contextLearn'].forEach((k) => assert.equal(k in s, false, k));
  // 부를 때마다 새 객체 (공유하지 않음)
  const t = M.emptyState();
  assert.notEqual(t.presence, s.presence);
  assert.notEqual(t.presence.hints, s.presence.hints);
  assert.notEqual(t.gcal.settings, s.gcal.settings);
  assert.notEqual(t.learned.metrics, s.learned.metrics);
});

test('normalize: 옛 v3 파일 → v4 기본값 (presence·learned·gcal 과 안쪽까지)', () => {
  const v3 = { version: 3, notes: [], tasks: [{ id: 't1', title: '견적서 보내기' }], prefs: { sidebarCollapsed: true }, chat: [] };
  const s = M.normalize(JSON.parse(JSON.stringify(v3)));
  assert.equal(s.version, 4);
  assert.deepEqual(s.presence, E_PRESENCE);
  assert.deepEqual(s.learned, E_LEARNED);
  assert.deepEqual(s.gcal, E_GCAL);
  assert.equal(s.prefs.sidebarCollapsed, true);
  const t = s.tasks[0];
  assert.equal(t.context, null);
  assert.equal(t.contextSource, null);
  assert.equal(t.atMode, null);
  assert.equal(t.atModeSource, null);
});

test('normalize: 저장된 안쪽 값은 남기고 빠진 안쪽 기본값만 채운다 (gcal.settings exportWork:false 유지)', () => {
  const raw = {
    version: 4,
    gcal: { accountId: 'acc1', settings: { exportWork: false }, events: 'x', calendars: null, links: [], gens: { blk_1: 2 }, lastSyncAt: '2026-10-05T00:00:00.000Z' },
    learned: { rules: 'x', metrics: { applied: 3 }, compactedAt: '2026-10-01T00:00:00.000Z' },
    presence: { activatedAt: '2026-10-01T09:00:00.000Z', shown: null, log: [{ id: 'off' }], hints: { used: 1, presetSeen: { student: ['2026-10-01T00:00:00.000Z'] } } }
  };
  const s = M.normalize(raw);
  assert.deepEqual(s.gcal.settings, { exportEnabled: true, exportWork: false, exportTitles: true });
  assert.equal(s.gcal.accountId, 'acc1');
  assert.deepEqual(s.gcal.events, []);
  assert.deepEqual(s.gcal.calendars, []);
  assert.deepEqual(s.gcal.outbox, []);
  assert.deepEqual(s.gcal.links, {});            // 배열은 객체로
  assert.deepEqual(s.gcal.gens, { blk_1: 2 });
  assert.equal(s.gcal.lastSyncAt, '2026-10-05T00:00:00.000Z');
  assert.deepEqual(s.learned.rules, []);
  assert.deepEqual(s.learned.metrics, { learned: 0, applied: 3, reverted: 0, hinted: 0 });
  assert.equal(s.learned.compactedAt, '2026-10-01T00:00:00.000Z');
  assert.equal(s.learned.v, 1);
  assert.equal(s.presence.activatedAt, '2026-10-01T09:00:00.000Z');
  assert.deepEqual(s.presence.shown, []);
  assert.deepEqual(s.presence.parked, []);
  assert.deepEqual(s.presence.log, [{ id: 'off' }]);
  assert.deepEqual(s.presence.hints, { day: null, used: 1, overtimeDismiss: 0, presetSeen: { student: ['2026-10-01T00:00:00.000Z'] }, presetOffered: {} });
  // 객체가 아닌 값이 와도 기본값
  const bad = M.normalize({ presence: null, learned: null, gcal: null });
  assert.deepEqual(bad.presence, E_PRESENCE);
  assert.deepEqual(bad.learned, E_LEARNED);
  assert.deepEqual(bad.gcal, E_GCAL);
});

test('normalize: presence 는 다시 불러와도 남는다 (STATUS #63)', () => {
  const s = M.emptyState();
  s.presence.activatedAt = NOW.toISOString();
  s.presence.current = { id: 'off', label: '퇴근', role: 'work_end', since: NOW.toISOString(), source: 'text', until: null, returnTo: null };
  s.presence.parked = ['task_a'];
  s.presence.log.push({ at: NOW.toISOString(), id: 'off', label: '퇴근', from: null, fromLabel: null, source: 'text', text: '퇴근!' });
  s.presence.hints.used = 1;
  s.presence.hints.day = '2026-10-05';
  const once = M.normalize(JSON.parse(JSON.stringify(s)));
  const twice = M.normalize(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice.presence, s.presence);
  assert.equal(twice.presence.current.id, 'off');
  assert.equal(twice.version, M.SCHEMA_VERSION);
});

test('normalize: 저장된 배운 규칙·Google 일정·링크는 그대로 남는다 (ADAPT adapt-capture #18)', () => {
  const s = M.emptyState();
  s.learned.rules.push({ id: 'lr_1', type: 'kind', key: '장보기', role: 'exact', label: '장보기', to: 'task', w: 1, at: NOW.toISOString(), n: 1, neg: 0 });
  s.learned.metrics.learned = 1;
  s.learned.bootstrappedAt = NOW.toISOString();
  s.gcal.accountId = 'acc1';
  s.gcal.calendars.push(CAL);
  s.gcal.events.push(gev(CAL.id, 'ev1', at(10), at(11)));
  s.gcal.links.blk_1 = { eventId: 'dn1', calendarId: 'daynote@group', gen: 0 };
  s.gcal.outbox.push({ id: 'op:blk_2', op: 'insert', blockId: 'blk_2', eventId: null, calendarId: 'daynote@group', attempts: 0, nextAt: null, lastError: null, createdAt: NOW.toISOString() });
  const back = M.normalize(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(back.learned, s.learned);
  assert.deepEqual(back.gcal, s.gcal);
});

test('normalizeTask: 맥락 4개 필드 기본값 null, 저장된 값은 그대로', () => {
  const t = M.normalizeTask({ id: 't', title: 'x' });
  assert.equal(t.context, null);
  assert.equal(t.contextSource, null);
  assert.equal(t.atMode, null);
  assert.equal(t.atModeSource, null);
  const u = M.normalizeTask({ id: 'u', title: '우유 사기', context: 'errand', contextSource: 'user', atMode: 'out', atModeSource: 'rule' });
  assert.deepEqual([u.context, u.contextSource, u.atMode, u.atModeSource], ['errand', 'user', 'out', 'rule']);
  const added = M.addTask(M.emptyState(), { title: 'y' }, NOW);
  assert.deepEqual([added.context, added.contextSource, added.atMode, added.atModeSource], [null, null, null, null]);
});

test('updateTask: 제목이 바뀌면 AI 맥락만 지우고 사용자 맥락은 둔다 (STATUS #66)', () => {
  const s = M.emptyState();
  const ai = M.addTask(s, { title: '견적서 보내기', context: 'work', contextSource: 'ai', atMode: 'off', atModeSource: 'ai' }, NOW);
  const user = M.addTask(s, { title: '빨래', context: 'home', contextSource: 'user' }, NOW);
  const pinned = M.addTask(s, { title: '정리', context: null, contextSource: 'user' }, NOW);

  M.updateTask(s, ai.id, { title: '견적서 보내기' }, LATER);            // 같은 제목 → 그대로
  assert.deepEqual([ai.context, ai.contextSource], ['work', 'ai']);
  M.updateTask(s, ai.id, { memo: '메모' }, LATER);                       // 제목 아닌 패치 → 그대로
  assert.deepEqual([ai.context, ai.contextSource], ['work', 'ai']);
  M.updateTask(s, ai.id, { title: '견적서 다시 보내기' }, LATER);       // 제목 바뀜 → AI 맥락 지움
  assert.deepEqual([ai.context, ai.contextSource], [null, null]);
  assert.equal(ai.title, '견적서 다시 보내기');
  assert.equal(ai.atMode, 'off');                                        // 걸어 둔 상태는 맥락 규칙과 무관

  M.updateTask(s, user.id, { title: '빨래 개기' }, LATER);
  assert.deepEqual([user.context, user.contextSource], ['home', 'user']);
  M.updateTask(s, pinned.id, { title: '책상 정리' }, LATER);
  assert.deepEqual([pinned.context, pinned.contextSource], [null, 'user']);

  // 패치가 맥락 출처를 직접 정하면 그 값을 따른다
  const ai2 = M.addTask(s, { title: '회의록', context: 'work', contextSource: 'ai' }, NOW);
  M.updateTask(s, ai2.id, { title: '회의록 정리', context: 'work', contextSource: 'ai' }, LATER);
  assert.deepEqual([ai2.context, ai2.contextSource], ['work', 'ai']);
});

test('addProject: context 기본 null, 넘기면 그대로', () => {
  const s = M.emptyState();
  assert.equal(M.addProject(s, { name: 'a' }, NOW).context, null);
  assert.equal(M.addProject(s, undefined, NOW).context, null);
  assert.equal(M.addProject(s, { name: 'b', context: '' }, NOW).context, null);
  assert.equal(M.addProject(s, { name: 'c', context: 'work' }, NOW).context, 'work');
});

test('clearSample: presence·gcal 은 건드리지 않고 샘플 규칙만 지운다 (STATUS #64)', () => {
  const s = M.emptyState();
  M.addTask(s, { title: '샘플', sample: true }, NOW);
  const mine = M.addTask(s, { title: '내 것' }, NOW);
  s.presence.activatedAt = NOW.toISOString();
  s.presence.current = { id: 'off', label: '퇴근', role: null, since: NOW.toISOString(), source: 'chip', until: null, returnTo: null };
  s.presence.shown = [mine.id];
  s.gcal.calendars.push(CAL);
  s.gcal.events.push(gev(CAL.id, 'ev1', at(10), at(11)));
  s.gcal.links.blk_x = { eventId: 'x', calendarId: 'dn', gen: 0 };
  s.learned.rules.push({ id: 'lr_1', type: 'kind', key: '장보기', role: 'exact', to: 'task', w: 1, sample: true });
  s.learned.rules.push({ id: 'lr_2', type: 'kind', key: '견적서', role: 'head', to: 'task', w: 1 });
  const presence = s.presence, gcal = s.gcal;
  const presenceCopy = JSON.parse(JSON.stringify(s.presence)), gcalCopy = JSON.parse(JSON.stringify(s.gcal));
  M.clearSample(s);
  assert.deepEqual(s.tasks.map((t) => t.id), [mine.id]);
  assert.equal(s.presence, presence);
  assert.equal(s.gcal, gcal);
  assert.deepEqual(s.presence, presenceCopy);
  assert.deepEqual(s.gcal, gcalCopy);
  assert.deepEqual(s.learned.rules.map((r) => r.id), ['lr_2']);
  // learned 가 없는 옛 상태에서도 던지지 않는다
  const old = M.emptyState();
  delete old.learned;
  assert.doesNotThrow(() => M.clearSample(old));
});

test('externalItems: GEvent → ExtItem 투영 (필드·tentative·캘린더 색과 이름)', () => {
  const s = M.emptyState();
  s.gcal.calendars.push(CAL);
  s.gcal.events.push(
    gev(CAL.id, 'b', at(11), at(12), { status: 'tentative' }),
    gev(CAL.id, 'a', at(9), at(10), { location: '3층 회의실' }),
    gev(CAL.id, 'c', at(11), at(12), { response: 'needsAction' }),
    gev(CAL.id, 'd', at(13), at(14), { response: 'tentative' }),
    gev(CAL.id, 'e', at(15), at(16), { response: 'accepted', origin: 'daynote_other', daynoteId: 'blk_other' }),
    gev('other@group.calendar.google.com', 'f', at(17), at(18), { title: '' })
  );
  const items = M.externalItems(s);
  assert.deepEqual(items.map((x) => x.eventId), ['a', 'b', 'c', 'd', 'e', 'f']);   // 시작 순, 같으면 id 순
  assert.deepEqual(items[0], {
    id: 'g:me@gmail.com|a', kind: 'event', external: 'google', readOnly: true, taskId: null,
    title: 'G a', start: at(9), end: at(10), allDay: false, startDate: null, endDate: null, busy: true, tentative: false,
    calendarId: 'me@gmail.com', eventId: 'a', htmlLink: 'https://www.google.com/calendar/event?eid=a', location: '3층 회의실',
    color: '#7986cb', calendarName: '내 캘린더', origin: 'google', tz: 'Asia/Seoul'
  });
  assert.deepEqual(items.map((x) => x.tentative), [false, true, true, true, false, false]);
  assert.equal(items[4].origin, 'daynote_other');
  // 캘린더 목록에 없으면 색은 null, 이름은 빈 문자열. 제목이 비면 '(제목 없음)'
  assert.equal(items[5].color, null);
  assert.equal(items[5].calendarName, '');
  assert.equal(items[5].title, '(제목 없음)');
  // 블록에는 없는 id — 기존 편집 경로는 자연히 무시한다
  items.forEach((x) => { assert.equal(M.byId(s.blocks, x.id), null); assert.equal(M.isExternal(x), true); });
  const b = M.addBlock(s, { title: '회의', start: at(9), end: at(10) });
  assert.equal(M.isExternal(b), false);
  assert.equal(M.isExternal(null), false);
  // 저장하지 않는 투영 — 원본은 그대로
  assert.equal('external' in s.gcal.events[0], false);
});

test('externalItems: 구간 겹침(end > from && start < to), 경계 생략, gcal 없음', () => {
  const s = M.emptyState();
  s.gcal.events.push(gev(CAL.id, 'e9', at(9), at(10)), gev(CAL.id, 'e10', at(10), at(11)), gev(CAL.id, 'e11', at(11), at(12)),
    gev(CAL.id, 'bad', null, at(12)));
  assert.deepEqual(M.externalItems(s, at(10), at(11)).map((x) => x.eventId), ['e10']);       // 끝이 딱 맞닿은 것은 겹침 아님
  assert.deepEqual(M.externalItems(s, at(10, 30), at(11, 30)).map((x) => x.eventId), ['e10', 'e11']);
  assert.deepEqual(M.externalItems(s, null, at(11)).map((x) => x.eventId), ['e9', 'e10']);
  assert.deepEqual(M.externalItems(s, at(10, 30)).map((x) => x.eventId), ['e10', 'e11']);
  assert.deepEqual(M.externalItems(s).map((x) => x.eventId), ['e9', 'e10', 'e11']);        // 시각 없는 항목은 버린다
  const noG = M.emptyState();
  delete noG.gcal;
  assert.deepEqual(M.externalItems(noG, at(0), at(23)), []);
  assert.deepEqual(M.calendarItems(noG, at(0), at(23)), []);
  assert.deepEqual(M.conflictsFor(noG, at(0), at(23), null), []);
});

test('calendarItems: 블록과 Google 일정을 시작 순으로 합치고, 삭제된 할 일의 블록은 뺀다 (GOOGLE #16)', () => {
  const s = M.emptyState();
  s.gcal.calendars.push(CAL);
  const gone = M.addTask(s, { title: '지운 일' }, NOW);
  const live = M.addTask(s, { title: '살아 있는 일' }, NOW);
  const bDead = M.addBlock(s, { taskId: gone.id, title: gone.title, start: at(9), end: at(10) });
  const bEv = M.addBlock(s, { title: '1:1', start: at(10, 30), end: at(11) });
  const bWork = M.addBlock(s, { taskId: live.id, title: live.title, start: at(12), end: at(13) });
  M.addBlock(s, { title: '내일 회의', start: new Date(2026, 9, 6, 10).toISOString(), end: new Date(2026, 9, 6, 11).toISOString() });
  gone.deletedAt = NOW.toISOString();     // 과거 블록이 남은 채 할 일만 지워진 경우
  s.gcal.events.push(
    gev(CAL.id, 'meet', at(10), at(11)),
    gev(CAL.id, 'free', at(14), at(15), { busy: false }),
    allDayEv(CAL.id, 'vac', '2026-10-05', '2026-10-06', { title: '연차' })
  );
  const sod = D.startOfDay(NOW).toISOString(), eod = D.endOfDay(NOW).toISOString();
  const all = M.calendarItems(s, sod, eod);
  assert.deepEqual(all.map((x) => x.id), ['g:me@gmail.com|vac', 'g:me@gmail.com|meet', bEv.id, bWork.id, 'g:me@gmail.com|free']);
  assert.ok(!all.some((x) => x.id === bDead.id));
  assert.equal(all[2], bEv);              // 블록은 사본이 아니라 그 객체
  assert.deepEqual(M.calendarItems(s, sod, eod, { includeAllDay: false }).map((x) => x.id),
    ['g:me@gmail.com|meet', bEv.id, bWork.id, 'g:me@gmail.com|free']);
  assert.deepEqual(M.calendarItems(s, sod, eod, { busyOnly: true }).map((x) => x.id),
    ['g:me@gmail.com|meet', bEv.id, bWork.id]);
  // 종일 일정은 그날 하루와 겹친다 (다음 날 0시는 배타)
  const tomorrow = M.calendarItems(s, D.startOfDay(LATER).toISOString(), D.endOfDay(LATER).toISOString());
  assert.deepEqual(tomorrow.map((x) => x.title), ['내일 회의']);
});

test('conflictsFor: 바쁜 Google 일정 포함, 종일·한가함 제외, blocksOnly 는 예전과 같다 (GOOGLE #15)', () => {
  const s = M.emptyState();
  s.gcal.calendars.push(CAL);
  const blk = M.addBlock(s, { title: '팀 회의', start: at(10), end: at(11) });
  const gone = M.addTask(s, { title: '지운 일' }, NOW);
  M.addBlock(s, { taskId: gone.id, title: gone.title, start: at(10), end: at(10, 30) });
  gone.deletedAt = NOW.toISOString();
  s.gcal.events.push(
    gev(CAL.id, 'busy', at(10, 30), at(11, 30)),
    gev(CAL.id, 'tent', at(10, 45), at(11, 15), { status: 'tentative' }),
    gev(CAL.id, 'transparent', at(10), at(11), { busy: false }),
    allDayEv(CAL.id, 'vac', '2026-10-05', '2026-10-06'),
    gev(CAL.id, 'later', at(13), at(14))
  );
  const got = M.conflictsFor(s, at(10), at(11), null);
  assert.deepEqual(got.map((x) => x.id), [blk.id, 'g:me@gmail.com|busy', 'g:me@gmail.com|tent']);
  assert.ok(got.every((x) => x.title && x.start && x.end));   // 부르는 곳이 쓰는 필드
  // 자기 자신(ignoreId)은 뺀다 — 블록이든 Google 일정이든
  assert.deepEqual(M.conflictsFor(s, at(10), at(11), blk.id).map((x) => x.id), ['g:me@gmail.com|busy', 'g:me@gmail.com|tent']);
  assert.deepEqual(M.conflictsFor(s, at(10), at(11), 'g:me@gmail.com|busy').map((x) => x.id), [blk.id, 'g:me@gmail.com|tent']);
  // blocksOnly → 예전 규칙과 똑같은 결과
  const old = (st, a, b, ig) => st.blocks.filter((x) => {
    if (x.id === ig) return false;
    if (x.taskId) { const t = M.byId(st.tasks, x.taskId); if (t && t.deletedAt) return false; }
    return x.start < b && x.end > a;
  });
  assert.deepEqual(M.conflictsFor(s, at(10), at(11), null, { blocksOnly: true }), old(s, at(10), at(11), null));
  assert.deepEqual(M.conflictsFor(s, at(10), at(11), null, { blocksOnly: true }).map((x) => x.id), [blk.id]);
  assert.deepEqual(M.conflictsFor(s, at(12), at(13), null), []);
  // Google 일정이 없으면 예전과 같다
  s.gcal.events = [];
  assert.deepEqual(M.conflictsFor(s, at(9), at(12), null), old(s, at(9), at(12), null));
});

test('conflictsFor: 구간이 없거나 잘못되면 Google 일정을 돌려주지 않는다 (예전 블록 규칙과 같음)', () => {
  const s = M.emptyState();
  const blk = M.addBlock(s, { title: '팀 회의', start: at(10), end: at(11) });
  s.gcal.events.push(gev(CAL.id, 'busy', at(10), at(11)), gev(CAL.id, 'later', at(15), at(16)));
  [[null, null], [undefined, undefined], [at(10), null], [null, at(11)], ['', at(11)], ['abc', 'def']].forEach(([a, b]) => {
    const got = M.conflictsFor(s, a, b, null);
    assert.deepEqual(got, M.conflictsFor(s, a, b, null, { blocksOnly: true }), String(a) + '–' + String(b));
    assert.ok(!got.some((x) => M.isExternal(x)), String(a) + '–' + String(b));
  });
  // 정상 구간이면 그대로 들어간다
  assert.deepEqual(M.conflictsFor(s, at(10), at(11), blk.id).map((x) => x.id), ['g:me@gmail.com|busy']);
});

test('externalItems: 취소·묘비 항목은 투영하지 않는다', () => {
  const s = M.emptyState();
  s.gcal.events.push(
    gev(CAL.id, 'live', at(10), at(11)),
    gev(CAL.id, 'gone', at(10), at(11), { status: 'cancelled' }),
    { tombstone: true, calendarId: CAL.id, eventId: 'tomb', recurringEventId: null, start: at(10), end: at(11) },
    null, 'x'
  );
  assert.deepEqual(M.externalItems(s).map((x) => x.eventId), ['live']);
  assert.deepEqual(M.conflictsFor(s, at(10), at(11), null).map((x) => x.eventId), ['live']);
});

test('normalizeTask: 맥락 필드를 undefined 로 넘겨도 null 로 둔다', () => {
  const t = M.normalizeTask({ id: 't', title: 'x', context: undefined, contextSource: undefined, atMode: undefined, atModeSource: undefined });
  assert.deepEqual([t.context, t.contextSource, t.atMode, t.atModeSource], [null, null, null, null]);
  const s = M.emptyState();
  const added = M.addTask(s, { title: 'y', context: undefined, atMode: undefined }, NOW);
  assert.equal(added.context, null);
  assert.equal(added.atMode, null);
  // 저장했다 불러온 값과 같다
  assert.deepEqual(M.normalize(JSON.parse(JSON.stringify(s))).tasks[0], JSON.parse(JSON.stringify(added)));
});

test('normalize: presence·learned·gcal 자리에 객체가 아닌 값이 있으면 기본값 (글자 단위 키가 생기지 않음)', () => {
  const bad = M.normalize({ presence: 'off', learned: [1, 2], gcal: 'x' });
  assert.deepEqual(bad.presence, E_PRESENCE);
  assert.deepEqual(bad.learned, E_LEARNED);
  assert.deepEqual(bad.gcal, E_GCAL);
  // 안쪽 객체 자리에 배열이 와도 기본값과 합친다
  const inner = M.normalize({ presence: { hints: ['a'] }, learned: { metrics: [3] }, gcal: { settings: [false] } });
  assert.deepEqual(inner.presence.hints, E_PRESENCE.hints);
  assert.deepEqual(inner.learned.metrics, E_LEARNED.metrics);
  assert.deepEqual(inner.gcal.settings, E_GCAL.settings);
});
