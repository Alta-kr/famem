'use strict';

// 아키텍처 점검 리포트(2026-10-17, 커밋 353cfff 에 있음 — 고친 뒤 저장소에서 뺌) 회귀 테스트 — BUG-NEW-01 ~ 10 중 코어에서 확인할 수 있는 것

const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/core/model');
const V = require('../src/core/ai/validate');
const P = require('../src/core/ai/proposals');
const C = require('../src/core/ai/capture');
const CMD = require('../src/core/ai/commands');
const W = require('../src/core/weekly');
const R = require('../src/core/recommend');

const NOW = new Date(2026, 9, 17, 15, 0);
const NUL = { text: null, date: null, time: null };
const BASE = { summary: '', sections: [], tasks: [], events: [], open_questions: [], note_title: 't', note_project_hint: null, note_kind: 'memo', done_tasks: [], updated_tasks: [], bulk_updates: [], commands: [] };

function apply(st, body, out, commands) {
  const note = M.addNote(st, { title: '', body, capture: { status: 'pending', at: NOW.toISOString() } }, NOW);
  note.updatedAt = NOW.toISOString();
  const o = Object.assign({}, BASE, out);
  const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, NOW);
  P.applyCapture(st, { note, run, validated: V.validateOrganizeNote(o, { note, state: st, now: NOW }), output: o, commands }, NOW);
  return note;
}

test('BUG-NEW-01: command 로 분류돼도 검증된 명령이 없으면(또는 채팅이 아니면) 원문을 메모로 지킨다', () => {
  const st = M.emptyState();
  const a = apply(st, '오늘 할 일 보여줘', { entry_type: 'command' }, []);
  assert.strictEqual(a.deletedAt, null);
  assert.strictEqual(a.captureRole, 'memo');
  assert.strictEqual(a.capture.entryType, 'memo');
  const b = apply(st, '오늘 할 일 보여줘', { entry_type: 'command' }, undefined);   // Ctrl+N 메모 창 경로 (명령 없음)
  assert.strictEqual(b.deletedAt, null);
  // 검증된 명령이 있을 때만 메모로 남기지 않는다
  const c = apply(st, '오늘 할 일 보여줘', { entry_type: 'command' }, [{ action: 'list_today' }]);
  assert.ok(c.deletedAt);
  assert.strictEqual(c.capture.entryType, 'command');
});

test('BUG-NEW-02: 제목에 후·뒤가 들어 있어도 "두 시간 미뤄줘" 는 마감 기준 미루기', () => {
  assert.strictEqual(V.shiftMinutes('세미나 장소 후보 알아보기 두 시간 미뤄줘'), 120);
  assert.strictEqual(V.shiftMinutes('오후 발표 준비 30분 더 늦춰'), 30);
  assert.strictEqual(V.shiftMinutes('뒤풀이 장소 예약 1시간 반 연장'), 90);
  assert.strictEqual(V.shiftMinutes('마감 두시간 후로 미뤄줘'), null);       // 지금부터는 relativeAt 이 맡는다
  assert.strictEqual(V.shiftMinutes('30분 뒤로 미뤄줘'), null);
  // 실제 반영
  const st = M.emptyState();
  const t = M.addTask(st, { title: '세미나 장소 후보 알아보기', dueDate: '2026-10-17', dueTime: '18:00' }, NOW);
  apply(st, '세미나 장소 후보 알아보기 두 시간 미뤄줘', { entry_type: 'update',
    updated_tasks: [{ title: t.title, evidence: { quote: '세미나 장소 후보 알아보기 두 시간 미뤄줘', line: 1 }, due: { text: '두 시간', date: null, time: null }, do_at: NUL }] });
  assert.deepStrictEqual([t.dueDate, t.dueTime], ['2026-10-17', '20:00']);
});

test('BUG-NEW-03: 소요 시간 — 12:00~12:30 은 30분, "오후 2시~오후 4시" 는 120분', () => {
  function dur(body, text, time, ai) {
    const note = { id: 'n', title: '', body, updatedAt: NOW.toISOString() };
    const out = { summary: '', sections: [], tasks: [], open_questions: [],
      events: [{ title: '회의', evidence: { quote: body, line: 1 }, start: { text, date: '2026-10-19', time }, duration_minutes: ai, location: null, basis: 'explicit' }] };
    const f = V.validateOrganizeNote(out, { note, state: M.emptyState(), now: NOW }).items[0].fields.durationMinutes;
    return [f.value, f.status];
  }
  assert.deepStrictEqual(dur('월요일 12:00~12:30 점심 회의', '월요일 12:00', '12:00', 30), [30, 'ok']);
  assert.deepStrictEqual(dur('월요일 오후 2시~오후 4시 회의', '월요일 오후 2시', '14:00', 120), [120, 'ok']);
  assert.deepStrictEqual(dur('월요일 오전 11시~오후 1시 회의', '월요일 오전 11시', '11:00', 120), [120, 'ok']);
  assert.deepStrictEqual(dur('월요일 11시~1시 회의', '월요일 11시', '11:00', 120), [120, 'ok']);   // 예전 것도 그대로
});

test('BUG-NEW-05: 진행 중을 떠나면 시계가 멈추고, 진행 중이 되면 돌고, 시계 없는 진행 중은 시작 시각부터', () => {
  const st = M.emptyState();
  const t = M.addTask(st, { title: 'a' }, NOW);
  M.startTask(st, t.id, NOW);
  M.updateTask(st, t.id, { status: 'waiting' }, new Date(NOW.getTime() + 20 * 60000));
  assert.strictEqual(t.runningSince, null);
  assert.strictEqual(M.workedMinutes(t, new Date(NOW.getTime() + 90 * 60000)), 20);
  M.updateTask(st, t.id, { status: 'in_progress' }, new Date(NOW.getTime() + 30 * 60000));
  assert.ok(t.runningSince);
  assert.strictEqual(M.workedMinutes(t, new Date(NOW.getTime() + 40 * 60000)), 30);
  // 샘플·예전 데이터: 진행 중인데 runningSince 가 없으면 startedAt 부터
  const old = M.normalizeTask({ title: 'b', status: 'in_progress', startedAt: new Date(NOW.getTime() - 90 * 60000).toISOString() });
  assert.strictEqual(M.workedMinutes(old, NOW), 90);
});

test('BUG-NEW-06: 할 일 → 일정 → 할 일 에서 한 시간·이어서 메모·주간 목표·샘플 표시를 지키고, 끝낸 일은 일정으로 바꾸지 않는다', () => {
  const st = M.emptyState();
  const note = apply(st, '내일까지 견적서 보내기', { entry_type: 'task',
    tasks: [{ title: '견적서 보내기', evidence: { quote: '내일까지 견적서 보내기', line: 1 }, due: { text: '내일까지', date: '2026-10-18', time: null }, do_at: NUL, project_hint: null, basis: 'explicit', size: 'small', breakdown: [] }] });
  let t = M.liveTasks(st)[0];
  M.startTask(st, t.id, new Date(NOW.getTime() - 25 * 60000));
  Object.assign(t, { resumeNote: '그래프부터', weekGoal: '2026-10-12', sample: true });
  P.captureSetKind(st, note.id, 'event', NOW);
  P.captureSetKind(st, note.id, 'task', NOW);
  t = M.liveTasks(st)[0];
  assert.strictEqual(t.status, 'in_progress');
  assert.ok(t.runningSince);
  assert.strictEqual(M.workedMinutes(t, NOW), 25);
  assert.deepStrictEqual([t.resumeNote, t.weekGoal, t.sample], ['그래프부터', '2026-10-12', true]);
  // 여러 줄 카드의 끝낸 할 일 줄 → 일정 은 하지 않음
  const st2 = M.emptyState();
  const two = apply(st2, '- [ ] 견적서 보내기\n- [ ] 설문 정리하기', { entry_type: 'task',
    tasks: ['견적서 보내기', '설문 정리하기'].map((x, i) => ({ title: x, evidence: { quote: '- [ ] ' + x, line: i + 1 }, due: NUL, do_at: NUL, project_hint: null, basis: 'explicit', size: 'small', breakdown: [] })) });
  const [r1] = two.capture.created;
  M.completeTask(st2, r1.id, NOW);
  P.captureSetItemKind(st2, two.id, r1, 'event', NOW);
  const done = M.byId(st2.tasks, r1.id);
  assert.strictEqual(done.deletedAt, null);
  assert.strictEqual(done.status, 'done');
  assert.strictEqual(st2.blocks.length, 0);
});

test('BUG-NEW-08: 일시 정지한 일은 주간 정리의 남은 일에, 수동 순서는 추천 지문에 들어간다', () => {
  const st = M.emptyState();
  const t = M.addTask(st, { title: '멈춘 일' }, NOW);
  M.startTask(st, t.id, NOW);
  M.pauseTask(st, t.id, NOW);
  const s = W.summarize(st, '2026-10-12', NOW);
  assert.ok(s.unfinished.some((x) => x.taskId === t.id));
  const before = R.signature(st);
  M.updateTask(st, t.id, { sortOrder: 3 }, NOW);
  assert.notStrictEqual(R.signature(st), before);
});

test('BUG-NEW-10: 샘플 지우면 채팅의 고아 카드도 정리 / 이름을 말했는데 없는 할 일 작게 나누기는 되묻기', () => {
  const st = M.emptyState();
  const s1 = M.addTask(st, { title: '샘플 일', sample: true }, NOW);
  const mine = M.addTask(st, { title: '내 일' }, NOW);
  st.chat = [{ id: 'm1', kind: 'work', taskId: s1.id }, { id: 'm2', kind: 'work', taskId: mine.id }, { id: 'm3', kind: 'overdue', taskIds: [s1.id] }, { id: 'm4', kind: 'text', text: 'hi' }];
  M.clearSample(st);
  assert.deepStrictEqual(st.chat.map((m) => m.id), ['m2', 'm4']);
  assert.deepStrictEqual(CMD.matchLocal(st, '없는할일 작게 나눠줘', null), { action: 'breakdown', missing: '없는할일' });
  assert.deepStrictEqual(CMD.matchLocal(st, '내 일 작게 나눠줘', null), { action: 'breakdown', taskId: mine.id });
  assert.deepStrictEqual(CMD.matchLocal(st, '이거 쪼개줘', mine), { action: 'breakdown', taskId: mine.id });
  const r = CMD.resolve(st, { title: '', body: '보고서 작게 나눠줘' }, [{ action: 'breakdown', target: '보고서', view: null, query: null, evidence: { quote: '보고서 작게 나눠줘', line: 1 } }], null);
  assert.deepStrictEqual(r, [{ action: 'breakdown', missing: '보고서', quote: '보고서 작게 나눠줘' }]);
});
