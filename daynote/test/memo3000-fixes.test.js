'use strict';

// 메모 3,000개 실측(research/memo3000)에서 찾은 앱 쪽 문제 — AI 답은 맞는데 앱이 덮거나 버리던 것

const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/core/model');
const V = require('../src/core/ai/validate');
const P = require('../src/core/ai/proposals');
const C = require('../src/core/ai/capture');
const CMD = require('../src/core/ai/commands');
const SG = require('../src/core/suggest');

const NOW = new Date(2026, 9, 31, 19, 30);   // 토요일 저녁
const NUL = { text: null, date: null, time: null };
const BASE = { entry_type: 'task', note_kind: 'memo', note_title: 't', note_project_hint: null, tasks: [], events: [], done_tasks: [], updated_tasks: [], bulk_updates: [], commands: [] };

function apply(st, body, out, focus) {
  const note = M.addNote(st, { title: '', body, capture: { status: 'pending', at: NOW.toISOString(), viaChat: true } }, NOW);
  note.updatedAt = NOW.toISOString();
  const o = Object.assign({}, BASE, out);
  const v = V.validateOrganizeNote(o, { note, state: st, now: NOW });
  assert.ok(v.ok, v.errors && v.errors.join(', '));
  const cmds = CMD.resolve(st, note, o.commands, focus || null);
  const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, NOW);
  P.applyCapture(st, { note, run, validated: v, output: o, commands: cmds }, NOW);
  return { note, cmds, v };
}
const ymd = (d) => SG.parseDueHint(d, NOW) && SG.parseDueHint(d, NOW).dueDate;

test('날짜 말: 명일·금일·익일·내일모레·글피·금욜·담주·다다음 주', () => {
  assert.strictEqual(ymd('명일'), '2026-11-01');
  assert.strictEqual(ymd('금일'), '2026-10-31');
  assert.strictEqual(ymd('익일'), '2026-11-01');
  assert.strictEqual(ymd('내일모레까지'), '2026-11-02');
  assert.strictEqual(ymd('글피'), '2026-11-03');
  assert.strictEqual(ymd('금욜까지'), '2026-11-06');
  assert.strictEqual(ymd('담주 월욜'), '2026-11-02');
  assert.strictEqual(ymd('다다음 주 수요일'), '2026-11-11');
  assert.strictEqual(V.shiftMinutes('기존 마감에서 하루만 뒤로 빼줘'), 1440);
});

test('근거에 줄 번호("1| …")를 붙여 옮겨도, 따옴표를 빼고 옮겨도 받는다', () => {
  const st = M.emptyState();
  const t = M.addTask(st, { title: '판금 브라켓 수정' }, NOW);
  const body = "'판금 브라켓 수정' 작업 삭제해줘.";
  const a = apply(st, body, { entry_type: 'command', commands: [{ action: 'delete', target: '판금 브라켓 수정', view: null, query: null, evidence: { quote: '1| ' + body, line: 1 } }] });
  assert.deepStrictEqual(a.cmds.map((c) => [c.action, c.taskId]), [['delete', t.id]]);
  const b = apply(st, body, { entry_type: 'command', commands: [{ action: 'delete', target: '판금 브라켓 수정', view: null, query: null, evidence: { quote: '판금 브라켓 수정 작업 삭제해줘.', line: 1 } }] });
  assert.strictEqual(b.cmds.length, 1);
});

test('시각만 말한 마감: 오늘(또는 이미 지났으면 내일)이면 받는다 · "12:00:00" 도', () => {
  const st = M.emptyState();
  apply(st, '15:00까지 보고서 마무리하기', { tasks: [{ title: '보고서 마무리', evidence: { quote: '15:00까지 보고서 마무리하기', line: 1 }, due: { text: '15:00까지', date: '2026-11-01', time: '15:00:00' }, do_at: NUL, size: 'small', basis: 'explicit' }] });
  const t = M.liveTasks(st)[0];
  assert.deepStrictEqual([t.dueDate, t.dueTime], ['2026-11-01', '15:00']);
});

test('날짜 칸 글에 날짜 말이 빠져도 근거 문장의 날짜와 같으면 받는다 ("글피 점심 먹고 1시 반까지")', () => {
  const st = M.emptyState();
  const q = '글피 점심 먹고 1시 반까지 파형 캡처 완료해서 넘기기';
  apply(st, q, { tasks: [{ title: '파형 캡처', evidence: { quote: q, line: 1 }, due: { text: '1시 반까지', date: '2026-11-03', time: '13:30' }, do_at: { text: '점심 먹고', date: '2026-11-03', time: '12:00' }, size: 'small', basis: 'explicit' }] });
  const t = M.liveTasks(st)[0];
  assert.ok(t, '할 일이 생긴다 (확인 못 한 할 시각 때문에 막히지 않는다)');
  assert.deepStrictEqual([t.dueDate, t.dueTime], ['2026-11-03', '13:30']);
});

test('시각만 바꾸기: "일정을 낮 12시로" 는 원래 날짜 그대로 · 이름 속 "마감" 은 마감 말이 아니다', () => {
  const st = M.emptyState();
  const t = M.addTask(st, { title: 'PRD 마감', dueDate: '2026-11-04' }, NOW);
  const body = "'PRD 마감' 일정을 낮 12시로 변경해줘";
  apply(st, body, { entry_type: 'update', updated_tasks: [{ title: 'PRD 마감', evidence: { quote: body, line: 1 }, due: NUL, do_at: { text: '낮 12시', date: '2026-10-31', time: '12:00' } }] });
  const w = M.blocksForTask(st, t.id)[0];
  assert.ok(w, '작업 시간');
  assert.strictEqual(new Date(w.start).getDate(), 4);
  assert.strictEqual(t.dueDate, '2026-11-04');
});

test('기한 지우기: 근거가 이름뿐이어도 날짜 칸 글("마감 기한 취소")이 원문에 있으면', () => {
  const st = M.emptyState();
  const t = M.addTask(st, { title: '피처 추출', dueDate: '2026-11-04' }, NOW);
  apply(st, "'피처 추출' 마감 기한 취소해주고, 캘린더 뷰 열어줘.", { entry_type: 'update', updated_tasks: [{ title: '피처 추출', evidence: { quote: '피처 추출', line: 1 }, due: { text: '마감 기한 취소', date: null, time: null }, do_at: NUL }] });
  assert.strictEqual(t.dueDate, null);
});

test('목록에 없는 할 일을 "날짜 바꾸기" 로 주면 새 할 일로', () => {
  const st = M.emptyState();
  M.addTask(st, { title: '전혀 다른 일' }, NOW);
  const q = '오늘 오후 9시까지 커넥션 풀 튜닝 완료해서 넘기기';
  const { note } = apply(st, q, { entry_type: 'update', updated_tasks: [{ title: '커넥션 풀 튜닝', evidence: { quote: q, line: 1 }, due: { text: '오늘 오후 9시까지', date: '2026-10-31', time: '21:00' }, do_at: NUL }] });
  const t = M.liveTasks(st).find((x) => x.title === '커넥션 풀 튜닝');
  assert.ok(t);
  assert.deepStrictEqual([t.dueDate, t.dueTime], ['2026-10-31', '21:00']);
  assert.strictEqual(note.capture.entryType, 'task');
});

test('목록 머리말("[회의/현황 기록] … 가능.")은 할 일 이름이 되지 않는다', () => {
  const st = M.emptyState();
  const body = '[회의/현황 기록] 세액공제 가능.\n\n- 후속 조치: 금욜까지 세금계산서 발행 처리 진행할 것';
  const { note } = apply(st, body, { entry_type: 'mixed', tasks: [{ title: '세금계산서 발행 처리', evidence: { quote: '- 후속 조치: 금욜까지 세금계산서 발행 처리 진행할 것', line: 3 }, due: { text: '금욜까지', date: '2026-11-06', time: null }, do_at: NUL, size: 'small', basis: 'explicit' }] });
  const t = M.liveTasks(st)[0];
  assert.strictEqual(t.title, '세금계산서 발행 처리');
  assert.strictEqual(t.dueDate, '2026-11-06');
  assert.strictEqual(note.captureRole, 'memo', '기록 문장은 메모로');
});

test('AI 없이 알아듣는 말: "오늘 할 일 화면" 은 오늘 화면 · 따옴표 안 이름으로 나누기', () => {
  const st = M.emptyState();
  const t = M.addTask(st, { title: '견적서 보내기' }, NOW);
  assert.deepStrictEqual(CMD.matchLocal(st, '오늘 할 일 화면 좀 열어줘', null), { action: 'open', view: 'today' });
  assert.deepStrictEqual(CMD.matchLocal(st, "'견적서 보내기' 쪼개줘", null), { action: 'breakdown', taskId: t.id });
});

test('정책: 마감 없던 할 일 "하루 미뤄줘" → 오늘 기준 내일 + 날짜 고르기 표시', () => {
  const st = M.emptyState();
  const t = M.addTask(st, { title: '단어장 업데이트' }, NOW);
  const body = "'단어장 업데이트' 일정 하루 미뤄줘";
  const { note } = apply(st, body, { entry_type: 'update', updated_tasks: [{ title: '단어장 업데이트', evidence: { quote: body, line: 1 }, due: { text: '하루 미뤄', date: null, time: null }, do_at: NUL }] });
  assert.strictEqual(t.dueDate, '2026-11-01');
  assert.strictEqual(note.capture.updated[0].pickDate, true);
  // 마감이 있던 일은 그 마감에서 미루고 고르기 표시는 없다
  const t2 = M.addTask(st, { title: '견적서 회신', dueDate: '2026-11-05' }, NOW);
  const b2 = "'견적서 회신' 하루 미뤄줘";
  const r2 = apply(st, b2, { entry_type: 'update', updated_tasks: [{ title: '견적서 회신', evidence: { quote: b2, line: 1 }, due: { text: '하루 미뤄', date: null, time: null }, do_at: NUL }] }).note;
  assert.strictEqual(t2.dueDate, '2026-11-06');
  assert.ok(!r2.capture.updated[0].pickDate);
});

test('엉뚱한 기존 할 일로 연결하지 않는다 · 이름 오타는 가까운 것 하나로', () => {
  const st = M.emptyState();
  const other = M.addTask(st, { title: '방수 공사 후 담수 테스트 누수 확인', dueDate: '2026-11-03' }, NOW);
  const q = '금일 밤 11시까지 도장 공정 퍼티 평탄도 검수 제출 마감임';
  apply(st, q, { entry_type: 'update', updated_tasks: [{ title: other.title, evidence: { quote: q, line: 1 }, due: { text: '금일 밤 11시까지', date: '2026-10-31', time: '23:00' }, do_at: NUL }] });
  assert.strictEqual(other.dueDate, '2026-11-03', '무관한 할 일은 그대로');
  const t = M.addTask(st, { title: '장기 미전환 잠재고객 팔로업 전화 돌리기' }, NOW);
  assert.strictEqual(CMD.findTask(st, '장기 미전환 잠재고セミ 고객 팔로업 전화 돌리기'), t);
});

test('"주간 일정표" 는 캘린더 주간 보기', () => {
  const st = M.emptyState();
  assert.deepStrictEqual(CMD.matchLocal(st, '주간 일정표 좀 열어줘', null), { action: 'open', view: 'calendar', mode: 'week' });
  assert.deepStrictEqual(CMD.matchLocal(st, '주간 정리 보여줘', null), { action: 'open', view: 'weekly' });
});

test('"…사용 가능." 같은 사실 기록은 바로 만들지 않고 제안으로 — [넣기] 로 만든다', () => {
  const st = M.emptyState();
  const q = '다음 주 수요일 오후에만 전자현미경 사용 가능.';
  const { note } = apply(st, q, { entry_type: 'mixed', tasks: [{ title: '전자현미경 사용', evidence: { quote: q, line: 1 }, due: { text: '다음 주 수요일', date: '2026-11-04', time: null }, do_at: NUL, size: 'small', basis: 'explicit' }] });
  assert.strictEqual(M.liveTasks(st).length, 0);
  assert.strictEqual(note.captureRole, 'memo');
  const s = note.capture.skipped.find((x) => x.reason === 'record');
  assert.ok(s);
  P.captureApplySkipped(st, note.id, s.id, NOW);
  assert.strictEqual(M.liveTasks(st).length, 1);
  assert.ok(!note.capture.skipped.some((x) => x.id === s.id));
});

test('[할 일로 만들기] — 글의 날짜도 함께 (까지면 마감, 아니면 할 날)', () => {
  const st = M.emptyState();
  const note = M.addNote(st, { title: '', body: '내일 11:00에 서류 관세사 전달 진행 예정' }, NOW);
  const t = P.captureToTask(st, note.id, NOW, { withDate: true });
  assert.deepStrictEqual([t.planDate, t.dueDate], ['2026-11-01', null]);
});

test('기간 물어보기: 내일 아침 · 이번 주 남은 일 · 다음 주 정리 — 그 기간의 할 일·일정', () => {
  const now = new Date(2026, 9, 21, 15, 0);   // 수요일
  const st = M.emptyState();
  const a = M.addTask(st, { title: '보고서 마감', dueDate: '2026-10-22' }, now);
  const b = M.addTask(st, { title: '서버 점검' }, now);
  M.addBlock(st, { taskId: b.id, title: b.title, start: new Date(2026, 9, 22, 9, 0).toISOString(), end: new Date(2026, 9, 22, 10, 0).toISOString() });
  M.addBlock(st, { title: '팀 회의', start: new Date(2026, 9, 22, 15, 0).toISOString(), end: new Date(2026, 9, 22, 16, 0).toISOString() });
  M.addTask(st, { title: '다음 주 발표', dueDate: '2026-10-27' }, now);
  const q = (s) => CMD.matchLocal(st, s, null, now);
  const morning = q('내일 아침에 뭐해야돼?');
  assert.deepStrictEqual([morning.action, morning.period.from, morning.period.part.label], ['list_today', '2026-10-22', '아침']);
  const am = CMD.agenda(st, morning.period, now)[0].items.map((x) => (x.task || x.block).title);
  assert.deepStrictEqual(am, ['서버 점검', '보고서 마감'], '아침 작업 시간 + 그날 마감 (오후 회의는 빼고)');
  const week = q('이번주 남은일 알려줘').period;
  assert.deepStrictEqual([week.from, week.to], ['2026-10-21', '2026-10-25']);
  assert.strictEqual(CMD.agenda(st, week, now).reduce((n, d) => n + d.items.length, 0), 3);
  const next = q('다음주 해야할일 정리해줘').period;
  assert.deepStrictEqual([next.from, next.to], ['2026-10-26', '2026-11-01']);
  assert.deepStrictEqual(CMD.agenda(st, next, now).map((d) => [d.ymd, d.items[0].task.title]), [['2026-10-27', '다음 주 발표']]);
  // 할 일로 적은 글은 질문이 아니다
  assert.strictEqual(q('내일까지 보고서 정리해줘'), null);
  assert.strictEqual(q('내일 아침 운동하기'), null);
  void a;
});
