'use strict';

// 명령어로 정한 종류 — 규칙으로 바로 만들기(createForced) · AI 다듬기(refineForced) · 규칙 추출(rulesItem)
// FEATURES §6.5–6.7, §7.4 (+ #태그·걸어 둔 상태 앞말, 명령어 이름표 학습)

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/core/model');
const V = require('../src/core/ai/validate');
const P = require('../src/core/ai/proposals');
const C = require('../src/core/ai/capture');
const F = require('../src/core/ai/forced');
const AD = require('../src/core/adapt');
const fake = require('../src/core/ai/fake');

const NOW = new Date(2026, 9, 5, 10, 0);   // 월요일 10:00
const at = (b) => { const d = new Date(b.start); return [d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()]; };

function setup() {
  const st = M.emptyState();
  M.addProject(st, { id: 'p1', name: '신규 온보딩 개선' }, NOW);
  M.addProject(st, { id: 'p2', name: '3분기 리포트' }, NOW);
  return st;
}
const NAMES = { task: 'todo', event: 'event', memo: 'memo', idea: 'idea', link: 'link' };
function forced(st, body, kind, projectId) {
  const note = M.addNote(st, { title: '', body, projectId: projectId || null,
    capture: { status: 'pending', at: NOW.toISOString(), entryType: null, created: [],
      command: { name: NAMES[kind], kind, token: '/' + NAMES[kind], raw: '/' + NAMES[kind] + ' ' + body } } }, NOW);
  note.updatedAt = NOW.toISOString();
  F.createForced(st, note, NOW);
  return note;
}
function out(patch) {
  return Object.assign({ summary: '', sections: [], tasks: [], events: [], open_questions: [], entry_type: 'task', note_title: '', note_project_hint: null,
    note_kind: 'memo', done_tasks: [], updated_tasks: [], presence: { role: 'none', quote: null } }, patch || {});
}
const NOWHEN = { text: null, date: null, time: null };
function aiTask(title, quote, line, extra) {
  return Object.assign({ title, evidence: { quote, line }, due: NOWHEN, project_hint: null, basis: 'explicit', size: 'small', breakdown: [],
    do_at: NOWHEN, context: null, do_in: 'none', sched: null }, extra || {});
}
function aiEvent(title, quote, line, extra) {
  return Object.assign({ title, evidence: { quote, line }, start: NOWHEN, duration_minutes: null, location: null, basis: 'explicit' }, extra || {});
}
function refine(st, note, output) {
  const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, NOW);
  const v = V.validateOrganizeNote(output, { note, state: st, now: NOW });
  assert.ok(v.ok, v.errors.join());
  return F.refineForced(st, { note, run, validated: v, output }, NOW);
}
const taskOf = (st, note) => M.byId(st.tasks, note.capture.created[0].id);
const blockOf = (st, note) => M.byId(st.blocks, note.capture.created[0].id);

// ------------------------------------------------------------------ 규칙 추출
test('규칙 #1: 할 일 "내일까지 견적서 보내기" → 제목 견적서 보내기, 마감 10-06, 할 시각 없음', () => {
  const r = F.rulesItem('내일까지 견적서 보내기', 'task', NOW);
  assert.equal(r.title, '견적서 보내기');
  assert.equal(r.dueDate, '2026-10-06');
  assert.equal(r.at, null);
});

test('규칙 #2: "30분 후 샤워하기" → 할 시각 오늘 10:30, 마감 없음', () => {
  const r = F.rulesItem('30분 후 샤워하기', 'task', NOW);
  assert.equal(r.title, '샤워하기');
  assert.deepEqual(r.at, { date: '2026-10-05', time: '10:30' });
  assert.equal(r.dueDate, null);
});

test('규칙 #3: "오후 3시에 보고서 쓰기" → 할 시각 오늘 15:00', () => {
  const r = F.rulesItem('오후 3시에 보고서 쓰기', 'task', NOW);
  assert.deepEqual(r.at, { date: '2026-10-05', time: '15:00' });
  assert.equal(r.title, '보고서 쓰기');
});

test('규칙 #4: "오후 3시까지 보고서" → 마감 오늘 15:00, 할 시각 없음', () => {
  const r = F.rulesItem('오후 3시까지 보고서', 'task', NOW);
  assert.equal(r.dueDate, '2026-10-05');
  assert.equal(r.dueTime, '15:00');
  assert.equal(r.at, null);
  assert.equal(r.title, '보고서');
});

test('규칙 #5: 오전·오후를 모르는 "3시 보고서" 는 시각을 쓰지 않고 제목에 남긴다', () => {
  const r = F.rulesItem('3시 보고서', 'task', NOW);
  assert.equal(r.at, null);
  assert.equal(r.dueTime, null);
  assert.equal(r.title, '3시 보고서');
});

test('규칙 #6: 이미 지난 "오전 9시에 운동" → 할 시각 없이 마감만 오늘', () => {
  const r = F.rulesItem('오전 9시에 운동', 'task', NOW);
  assert.equal(r.at, null);
  assert.equal(r.dueDate, '2026-10-05');
});

test('규칙 #7: 일정 "다음 주 화요일 3시 치과" → 10-13 15:00, 시각 확인 필요, 30분 짐작', () => {
  const r = F.rulesItem('다음 주 화요일 3시 치과', 'event', NOW);
  assert.deepEqual([r.date, r.time, r.timeUncertain, r.title, r.durationMinutes, r.durationGuessed], ['2026-10-13', '15:00', true, '치과', 30, true]);
});

test('규칙 #8: 일정 "내일 오전 10시 팀 회의" → 10-06 10:00 확정', () => {
  const r = F.rulesItem('내일 오전 10시 팀 회의', 'event', NOW);
  assert.deepEqual([r.date, r.time, r.timeUncertain, r.title], ['2026-10-06', '10:00', false, '팀 회의']);
});

test('규칙 #9: 일정 "금요일 2시~4시 워크숍" → 10-09 14:00(오후로 짐작), 120분 확정', () => {
  const r = F.rulesItem('금요일 2시~4시 워크숍', 'event', NOW);
  assert.deepEqual([r.date, r.time, r.timeUncertain, r.durationMinutes, r.durationGuessed, r.title], ['2026-10-09', '14:00', true, 120, false, '워크숍']);
});

test('규칙 #10: 날짜·시각이 없는 일정 "팀 회식" → 다음 정시(11:00), 시각 확인 필요', () => {
  const r = F.rulesItem('팀 회식', 'event', NOW);
  assert.deepEqual([r.date, r.time, r.timeUncertain, r.title], ['2026-10-05', '11:00', true, '팀 회식']);
});

test('규칙 #11: 오늘은 지난 "9시 스탠드업" → 내일 09:00, 시각 확인 필요', () => {
  const r = F.rulesItem('9시 스탠드업', 'event', NOW);
  assert.deepEqual([r.date, r.time, r.timeUncertain, r.title], ['2026-10-06', '09:00', true, '스탠드업']);
});

test('규칙 #12: 일정 "30분 후 통화" → 오늘 10:30 확정', () => {
  const r = F.rulesItem('30분 후 통화', 'event', NOW);
  assert.deepEqual([r.date, r.time, r.timeUncertain, r.title], ['2026-10-05', '10:30', false, '통화']);
});

test('규칙 #13: 제목이 비면 첫 줄 원문 "내일 3시"', () => {
  assert.equal(F.rulesItem('내일 3시', 'event', NOW).title, '내일 3시');
});

test('규칙 #14: 여러 줄 → 첫 줄 제목·나머지 메모, 체크박스 머리 떼기, 121자 제목은 117자 + …', () => {
  const r = F.rulesItem('견적서 보내기\n  단가 표 첨부\n담당자 확인', 'task', NOW);
  assert.equal(r.title, '견적서 보내기');
  assert.equal(r.memo, '단가 표 첨부\n담당자 확인');
  assert.equal(F.rulesItem('- [ ] 우유 사기', 'task', NOW).title, '우유 사기');
  const long = F.rulesItem('가'.repeat(121), 'task', NOW).title;
  assert.equal(long.length, 118);
  assert.ok(long.endsWith('…'));
  assert.equal(long.slice(0, 117), '가'.repeat(117));
});

test('규칙: #태그와 맨 앞의 걸어 둔 상태 말을 떼어 맥락·atMode 로 돌려준다', () => {
  const r = F.rulesItem('퇴근하고 #집안일 빨래 돌리기', 'task', NOW);
  assert.equal(r.title, '빨래 돌리기');
  assert.deepEqual(r.atMode, { mode: 'off', phrase: '퇴근하고' });
  assert.deepEqual(r.context, { ctx: 'home', tag: '#집안일' });
  const g = F.rulesItem('가는 길에 우유 사기', 'task', NOW);
  assert.equal(g.title, '우유 사기');
  assert.equal(g.atMode.mode, 'out');
  assert.equal(F.rulesItem('# 회의록 정리', 'task', NOW).context, null);   // 마크다운 제목은 태그가 아니다
});

// ------------------------------------------------------------------ 만들기
test('만들기 #15: /할일 → 할 일 하나(origin user, 원문 연결), 원문은 출처로, base 기록, 초안 없음', () => {
  const st = setup();
  const note = forced(st, '내일까지 견적서 보내기', 'task');
  assert.equal(st.tasks.length, 1);
  const t = st.tasks[0];
  assert.equal(t.title, '견적서 보내기');
  assert.equal(t.origin, 'user');
  assert.equal(t.sources[0].refId, note.id);
  assert.equal(note.captureRole, 'task_source');
  assert.equal(note.capture.entryType, 'task');
  assert.deepEqual(note.capture.created, [{ kind: 'task', id: t.id }]);
  assert.equal(note.capture.command.base.title, '견적서 보내기');
  assert.equal(note.capture.command.base.dueDate, '2026-10-06');
  assert.deepEqual(note.capture.command.refined, []);
  assert.equal(st.proposals.length, 0);
});

test('만들기 #16: 할 시각이 있는 할 일은 30분 작업 블록(짐작), created 에는 할 일만', () => {
  const st = setup();
  const note = forced(st, '30분 후 샤워하기', 'task');
  assert.equal(st.blocks.length, 1);
  const b = st.blocks[0];
  assert.equal(b.taskId, st.tasks[0].id);
  assert.equal(b.durationGuessed, true);
  assert.equal(new Date(b.end) - new Date(b.start), 30 * 60000);
  assert.deepEqual(note.capture.created.map((c) => c.kind), ['task']);
  assert.equal(note.capture.command.base.workId, b.id);
});

test('만들기 #17: /일정 → 일정 블록 하나, 원문은 출처로', () => {
  const st = setup();
  const note = forced(st, '내일 오전 10시 팀 회의', 'event');
  assert.equal(st.tasks.length, 0);
  assert.equal(st.blocks.length, 1);
  assert.equal(st.blocks[0].kind, 'event');
  assert.equal(st.blocks[0].timeUncertain, false);
  assert.equal(note.captureRole, 'task_source');
  assert.deepEqual(note.capture.created, [{ kind: 'block', id: st.blocks[0].id }]);
});

test('만들기 #18: /메모·/아이디어·/링크 → 항목 없이 그 종류의 메모로', () => {
  for (const kind of ['memo', 'idea', 'link']) {
    const st = setup();
    const note = forced(st, '온보딩에 퀴즈 넣기', kind);
    assert.equal(st.tasks.length + st.blocks.length, 0);
    assert.equal(note.kind, kind);
    assert.equal(note.kindByUser, true);
    assert.equal(note.captureRole, 'memo');
    assert.equal(note.capture.entryType, 'memo');
  }
});

test('만들기 #19: 사용자가 고른 프로젝트가 항목에 들어간다', () => {
  const st = setup();
  forced(st, '견적서 보내기', 'task', 'p1');
  assert.equal(st.tasks[0].projectId, 'p1');
  forced(st, '내일 3시 회의', 'event', 'p2');
  assert.equal(st.blocks[0].projectId, 'p2');
});

test('만들기 #20: 같은 제목의 할 일이 있어도 새로 만든다 (중복 건너뛰기 없음)', () => {
  const st = setup();
  M.addTask(st, { title: '견적서 보내기' }, NOW);
  forced(st, '견적서 보내기', 'task');
  assert.equal(M.liveTasks(st).length, 2);
});

test('만들기: #태그는 사용자 맥락, 맨 앞 걸어 둔 상태 말은 규칙(rule)으로 싣는다', () => {
  const st = setup();
  forced(st, '퇴근하고 #집안일 빨래 돌리기', 'task');
  const t = st.tasks[0];
  assert.equal(t.title, '빨래 돌리기');
  assert.deepEqual([t.context, t.contextSource, t.atMode, t.atModeSource], ['home', 'user', 'off', 'rule']);
});

test('만들기: 명령어로 정한 종류는 이름표로 배운다 (src command, from 없음)', () => {
  const st = setup();
  forced(st, '장보기', 'task');
  const rules = st.learned.rules.filter((r) => r.type === 'kind');
  assert.ok(rules.length >= 1);
  assert.ok(rules.every((r) => r.to === 'task' && r.src === 'command' && r.from == null));
  // 끄면 배우지 않는다
  const st2 = setup();
  st2.prefs.learning = false;
  forced(st2, '장보기', 'task');
  assert.equal(AD.count(st2, 'learned', 0), 0);
  assert.equal(st2.learned.rules.length, 0);
});

// ------------------------------------------------------------------ AI 다듬기
test('다듬기 #21: AI 할 일 하나(제목·마감 ok) → 제목·마감이 바뀌고 refined 에 남는다', () => {
  const st = setup();
  const note = forced(st, '견적서 회신\n금요일까지 부탁드립니다', 'task');
  assert.equal(taskOf(st, note).dueDate, null);
  const cap = refine(st, note, out({ tasks: [aiTask('견적서 회신·발송', '금요일까지 부탁드립니다', 2, { due: { text: '금요일까지', date: '2026-10-09', time: null } })] }));
  const t = taskOf(st, note);
  assert.equal(t.title, '견적서 회신·발송');
  assert.equal(t.dueDate, '2026-10-09');
  assert.ok(cap.command.refined.includes('title'));
  assert.ok(cap.command.refined.includes('dueDate'));
  assert.equal(cap.status, 'done');
});

test('다듬기 #22: AI 의 일정·완료 보고·날짜 바꾸기는 쓰지 않는다 (다른 항목·완료·변경·초안 없음)', () => {
  const st = setup();
  const open = M.addTask(st, { title: '보고서 쓰기', dueDate: '2026-10-07' }, NOW);
  const note = forced(st, '견적서 보내기\n보고서 다 씀, 보고서는 내일로 미룸\n내일 오후 3시 회의', 'task');
  const before = st.blocks.length;
  refine(st, note, out({
    tasks: [aiTask('견적서 보내기', '견적서 보내기', 1)],
    events: [aiEvent('회의', '내일 오후 3시 회의', 3, { start: { text: '내일 오후 3시', date: '2026-10-06', time: '15:00' } })],
    done_tasks: [{ title: '보고서 쓰기', evidence: { quote: '보고서 다 씀', line: 2 } }],
    updated_tasks: [{ title: '보고서 쓰기', evidence: { quote: '보고서는 내일로 미룸', line: 2 }, due: { text: '내일', date: '2026-10-06', time: null }, do_at: NOWHEN }]
  }));
  assert.equal(M.liveTasks(st).length, 2);
  assert.equal(st.blocks.length, before);
  assert.equal(open.status, 'todo');
  assert.equal(open.dueDate, '2026-10-07');
  assert.equal(st.proposals.length, 0);
});

test('다듬기 #23: AI 할 일이 둘이면 항목은 그대로, 글 전체 프로젝트 힌트만 쓴다', () => {
  const st = setup();
  const note = forced(st, '온보딩 견적서 보내고 세금계산서 발행', 'task');
  const title = taskOf(st, note).title;
  const cap = refine(st, note, out({ note_project_hint: '신규 온보딩 개선', tasks: [
    aiTask('견적서 보내기', '온보딩 견적서 보내고 세금계산서 발행', 1),
    aiTask('세금계산서 발행', '온보딩 견적서 보내고 세금계산서 발행', 1)] }));
  assert.equal(taskOf(st, note).title, title);
  assert.equal(taskOf(st, note).projectId, 'p1');
  assert.equal(note.projectId, 'p1');
  assert.deepEqual(cap.command.refined, ['projectId']);
});

test('다듬기 #24: AI 항목이 없으면 그대로', () => {
  const st = setup();
  const note = forced(st, '견적서 보내기', 'task');
  const cap = refine(st, note, out({}));
  assert.equal(taskOf(st, note).title, '견적서 보내기');
  assert.deepEqual(cap.command.refined, []);
  assert.equal(cap.status, 'done');
});

test('다듬기 #25: 사용자가 고친 제목은 그대로, 마감은 다듬는다', () => {
  const st = setup();
  const note = forced(st, '견적서 회신\n금요일까지 부탁드립니다', 'task');
  M.updateTask(st, taskOf(st, note).id, { title: '거래처 견적 회신' }, NOW);
  const cap = refine(st, note, out({ tasks: [aiTask('견적서 회신·발송', '금요일까지 부탁드립니다', 2, { due: { text: '금요일까지', date: '2026-10-09', time: null } })] }));
  assert.equal(taskOf(st, note).title, '거래처 견적 회신');
  assert.equal(taskOf(st, note).dueDate, '2026-10-09');
  assert.ok(!cap.command.refined.includes('title'));
});

test('다듬기 #26: 사용자가 종류를 바꿨으면(changedByUser) 아무것도 바꾸지 않고 끝낸다', () => {
  const st = setup();
  const note = forced(st, '견적서 회신\n금요일까지 부탁드립니다', 'task');
  note.capture.changedByUser = true;
  const cap = refine(st, note, out({ tasks: [aiTask('견적서 회신·발송', '금요일까지 부탁드립니다', 2, { due: { text: '금요일까지', date: '2026-10-09', time: null } })] }));
  assert.equal(taskOf(st, note).title, '견적서 회신');
  assert.equal(taskOf(st, note).dueDate, null);
  assert.equal(cap.status, 'done');
});

test('다듬기 #27: /할일 + AI 일정(날짜·시각 ok) → 그 시각에 작업 블록, 제목 반영', () => {
  const st = setup();
  const note = forced(st, '디자인 리뷰\n내일 오후 3시', 'task');
  assert.equal(st.blocks.length, 0);
  const cap = refine(st, note, out({ events: [aiEvent('디자인 리뷰 회의', '내일 오후 3시', 2, { start: { text: '내일 오후 3시', date: '2026-10-06', time: '15:00' } })] }));
  const t = taskOf(st, note);
  assert.equal(t.title, '디자인 리뷰 회의');
  const w = M.blocksForTask(st, t.id);
  assert.equal(w.length, 1);
  assert.deepEqual(at(w[0]), [10, 6, 15, 0]);
  assert.equal(w[0].durationGuessed, true);
  assert.ok(cap.command.refined.includes('at'));
});

test('다듬기 #28: /일정 + AI 일정(시각·길이·장소 ok) → 시작·끝·장소, 시각 확정', () => {
  const st = setup();
  const note = forced(st, '팀 회의\n내일 오후 3시부터 1시간, 3층 회의실', 'event');
  assert.equal(blockOf(st, note).timeUncertain, true);
  const cap = refine(st, note, out({ events: [aiEvent('팀 회의', '내일 오후 3시부터 1시간, 3층 회의실', 2,
    { start: { text: '내일 오후 3시', date: '2026-10-06', time: '15:00' }, duration_minutes: 60, location: '3층 회의실' })] }));
  const b = blockOf(st, note);
  assert.deepEqual(at(b), [10, 6, 15, 0]);
  assert.equal(new Date(b.end) - new Date(b.start), 60 * 60000);
  assert.equal(b.location, '3층 회의실');
  assert.equal(b.timeUncertain, false);
  assert.equal(b.durationGuessed, false);
  for (const k of ['date', 'time', 'durationMinutes', 'location']) assert.ok(cap.command.refined.includes(k), k);
});

test('다듬기 #29: /일정 + AI 할 일(마감 ok) → 날짜만 바뀌고 시각은 그대로', () => {
  const st = setup();
  const note = forced(st, '치과\n금요일까지', 'event');
  const before = new Date(blockOf(st, note).start);
  refine(st, note, out({ tasks: [aiTask('치과', '금요일까지', 2, { due: { text: '금요일까지', date: '2026-10-09', time: null } })] }));
  const b = blockOf(st, note);
  assert.deepEqual(at(b), [10, 9, before.getHours(), before.getMinutes()]);
  assert.equal(b.timeUncertain, true);
});

test('다듬기 #30: 확인 필요(confirm) 칸은 쓰지 않는다 (오전·오후 모름)', () => {
  const st = setup();
  const note = forced(st, '고객 통화\n오늘 3시', 'event');
  const before = blockOf(st, note).start;
  const cap = refine(st, note, out({ events: [aiEvent('고객 통화', '오늘 3시', 2, { start: { text: '오늘 3시', date: '2026-10-05', time: null } })] }));
  assert.equal(blockOf(st, note).start, before);
  assert.ok(!cap.command.refined.includes('time'));
});

test('다듬기 #31: 메모류는 빈 제목에 note_title, 종류는 그대로, 할 일을 만들지 않는다', () => {
  const st = setup();
  const note = forced(st, '오늘 회의 분위기 좋았음. 다음 주에 디자인 다시 보기로', 'memo');
  refine(st, note, out({ note_title: '회의 분위기', note_kind: 'idea', entry_type: 'mixed',
    tasks: [aiTask('디자인 다시 보기', '오늘 회의 분위기 좋았음. 다음 주에 디자인 다시 보기로', 1)] }));
  assert.equal(note.title, '회의 분위기');
  assert.equal(note.kind, 'memo');
  assert.equal(st.tasks.length, 0);
});

test('다듬기 #32: 사용자가 고른 프로젝트가 AI 프로젝트보다 우선한다', () => {
  const st = setup();
  const note = forced(st, '3분기 리포트 초안 보내기', 'task', 'p1');
  refine(st, note, out({ note_project_hint: '3분기 리포트', tasks: [aiTask('리포트 초안 보내기', '3분기 리포트 초안 보내기', 1, { project_hint: '3분기 리포트' })] }));
  assert.equal(taskOf(st, note).projectId, 'p1');
  assert.equal(note.projectId, 'p1');
});

test('다듬기 #33: 큰 일(단계 2개 이상, 항목 하나) → 단계 초안 보관, largeTasks', () => {
  const st = setup();
  const note = forced(st, '분기 보고서 작성', 'task');
  const cap = refine(st, note, out({ tasks: [aiTask('분기 보고서 작성', '분기 보고서 작성', 1,
    { size: 'large', breakdown: [{ title: '자료 모으기', minutes: 15 }, { title: '초안 쓰기', minutes: 45 }] })] }));
  const t = taskOf(st, note);
  assert.equal(t.breakdown.status, 'pending');
  assert.equal(t.breakdown.steps.length, 2);
  assert.deepEqual(cap.largeTasks, [t.id]);
});

test('다듬기 #34: 만든 할 일을 × 로 지운 뒤 AI 가 와도 다시 만들지 않는다', () => {
  const st = setup();
  const note = forced(st, '견적서 회신\n금요일까지 부탁드립니다', 'task');
  P.captureRemoveItem(st, note.id, note.capture.created[0], NOW);
  refine(st, note, out({ tasks: [aiTask('견적서 회신·발송', '금요일까지 부탁드립니다', 2, { due: { text: '금요일까지', date: '2026-10-09', time: null } })] }));
  assert.equal(M.liveTasks(st).length, 0);
  assert.equal(st.blocks.length, 0);
});

test('다듬기 #35: 실패 뒤 다시 다듬기도 정상', () => {
  const st = setup();
  const note = forced(st, '견적서 회신\n금요일까지 부탁드립니다', 'task');
  note.capture = Object.assign({}, note.capture, { status: 'failed', error: { type: 'server' } });
  const cap = refine(st, note, out({ tasks: [aiTask('견적서 회신·발송', '금요일까지 부탁드립니다', 2, { due: { text: '금요일까지', date: '2026-10-09', time: null } })] }));
  assert.equal(cap.status, 'done');
  assert.equal(cap.error, null);
  assert.equal(taskOf(st, note).dueDate, '2026-10-09');
});

test('다듬기 #36: 가짜 AI 통합 — "금요일까지 분기 보고서 작성" 을 할 일로 강제', () => {
  const st = setup();
  const note = forced(st, '금요일까지 분기 보고서 작성', 'task');
  const input = C.buildInput(note, { today: '2026-10-05 (월)', projects: st.projects.map((p) => p.name), openTasks: [] });
  const output = fake.organize(input).output;
  const cap = refine(st, note, output);
  const t = taskOf(st, note);
  assert.equal(t.title, '분기 보고서 작성');
  assert.equal(t.dueDate, '2026-10-09');
  assert.equal(cap.largeTasks.length, 1);
  assert.equal(M.liveTasks(st).length, 1);
});

test('다듬기: AI 맥락·걸어 둔 상태는 빈칸일 때만, 사용자 #태그 맥락은 그대로 (C16)', () => {
  const st = setup();
  const note = forced(st, '퇴근하고 우유 사기', 'task');
  const t = taskOf(st, note);
  assert.deepEqual([t.atMode, t.atModeSource], ['off', 'rule']);
  refine(st, note, out({ tasks: [aiTask('우유 사기', '퇴근하고 우유 사기', 1, { context: 'errand', do_in: 'off' })] }));
  assert.deepEqual([t.context, t.contextSource, t.atMode, t.atModeSource], ['errand', 'ai', 'off', 'rule']);

  const note2 = forced(st, '#집안일 빨래 돌리기', 'task');
  const t2 = taskOf(st, note2);
  refine(st, note2, out({ tasks: [aiTask('빨래 돌리기', '#집안일 빨래 돌리기', 1, { context: 'personal' })] }));
  assert.deepEqual([t2.context, t2.contextSource], ['home', 'user']);
});

test('pickAiItem: 할 일·일정이 정확히 하나일 때만', () => {
  assert.equal(F.pickAiItem({ items: [] }), null);
  assert.equal(F.pickAiItem({ items: [{ kind: 'task' }, { kind: 'event' }] }), null);
  assert.equal(F.pickAiItem({ items: [{ kind: 'event', title: 'x' }] }).title, 'x');
  assert.equal(F.REFINED_LABEL.durationMinutes, '길이');
  assert.equal(F.REFINED_LABEL.at, '시각');
});

test('validate #37: relativeAt·relativeMinutes·timeMatch·durationSpan 을 내보내고 길이 검증 결과는 그대로', () => {
  assert.deepEqual(V.relativeMinutes('한 시간 반 뒤에'), { minutes: 90, text: '한 시간 반 뒤', index: 0 });
  assert.equal(V.relativeMinutes('그냥 메모'), null);
  const r = V.relativeAt('30분 후 샤워', NOW);
  assert.deepEqual([r.date, r.time, r.text, r.index], ['2026-10-05', '10:30', '30분 후', 0]);
  assert.deepEqual(V.timeMatch('내일 오후 3시 반 회의'), { text: '오후 3시 반', index: 3, candidates: ['15:30'] });
  assert.equal(V.timeMatch('1시간 뒤 운동'), null);
  assert.deepEqual(V.durationSpan('금요일 2시~4시 워크숍', '14:00'), { minutes: 120, text: '2시~4시', index: 4 });
  assert.deepEqual(V.durationSpan('회의 1시간 30분', null), { minutes: 90, text: '1시간 30분', index: 3 });
  assert.equal(V.durationSpan('회의', null), null);
  // 일정 길이 검증 (checkDuration 을 거치는 validateOrganizeNote)
  const st = setup();
  const note = M.addNote(st, { body: '금요일 2시~4시 워크숍', updatedAt: NOW.toISOString() }, NOW);
  const v = V.validateOrganizeNote(out({ events: [aiEvent('워크숍', '금요일 2시~4시 워크숍', 1,
    { start: { text: '금요일 2시', date: '2026-10-09', time: '14:00' }, duration_minutes: 120 })] }), { note, state: st, now: NOW });
  assert.deepEqual([v.items[0].fields.durationMinutes.value, v.items[0].fields.durationMinutes.status], [120, 'ok']);
});
