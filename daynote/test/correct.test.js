'use strict';

// 고치는 말 — "내일 8시 기도회" 를 08:00 으로 잘못 넣었을 때 "아니 오후 8시야" 로 고친다 (새로 만들지 않고)

const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/core/model');
const D = require('../src/core/dates');
const V = require('../src/core/ai/validate');
const P = require('../src/core/ai/proposals');
const C = require('../src/core/ai/capture');
const fake = require('../src/core/ai/fake');

const NOW = new Date(2026, 9, 24, 10, 0);   // 토요일 오전 10시
const EMPTY = { text: null, date: null, time: null };

function send(st, text, out, at) {
  const t = at || NOW;
  const note = M.addNote(st, { title: '', body: text, capture: { status: 'pending', at: t.toISOString(), viaChat: true } }, t);
  note.updatedAt = t.toISOString();
  const input = C.buildInput(note, { today: D.ymd(t), projects: [], openTasks: [], recent: P.recentLines(st, t) });
  const base = fake.organize(input).output;
  const o = Object.assign(base, { tasks: [], events: [], done_tasks: [], updated_tasks: [], bulk_updates: [] }, out);
  const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, t);
  const v = V.validateOrganizeNote(o, { note, state: st, now: t });
  assert.ok(v.ok, v.errors.join());
  P.applyCapture(st, { note, run, validated: v, output: o }, t);
  return { note, input };
}
function ev(title, quote, date, time) {
  return { title, evidence: { quote, line: 1 }, start: { text: quote, date, time }, duration_minutes: null, location: null, basis: 'explicit', typical_minutes: 60 };
}
const hm = (b) => D.ymd(b.start) + ' ' + D.hm(b.start) + '–' + D.hm(b.end);

test('일정: "아니 오후 8시야" — 방금 만든 일정의 시각을 고친다 (길이는 그대로, 새 일정 없음)', () => {
  const st = M.emptyState();
  send(st, '내일 8시에 팀 회의', { events: [ev('팀 회의', '내일 8시에 팀 회의', '2026-10-25', '08:00')] });
  assert.strictEqual(st.blocks.length, 1);
  assert.strictEqual(hm(st.blocks[0]), '2026-10-25 08:00–09:00');
  const later = new Date(NOW.getTime() + 2 * 60000);
  const { note, input } = send(st, '아니 내일 오후 8시 팀 회의야', { entry_type: 'update', events: [ev('팀 회의', '아니 내일 오후 8시 팀 회의야', '2026-10-25', '20:00')] }, later);
  assert.ok(C.userText(input).indexOf('방금 정리한 것') !== -1 && input.recent[0].indexOf('팀 회의 (일정, 2026-10-25 08:00)') === 0, 'AI 에게 방금 만든 것을 알려 준다');
  assert.strictEqual(st.blocks.length, 1, '새 일정을 만들지 않는다');
  assert.strictEqual(hm(st.blocks[0]), '2026-10-25 20:00–21:00');
  assert.strictEqual(note.capture.updated[0].kind, 'block');
  assert.deepStrictEqual(note.capture.skipped, []);
  const items = P.captureItems(st, note);
  assert.ok(items.some((it) => it.kind === 'moved' && it.item.id === st.blocks[0].id), '결과 카드에 고친 줄');
  // 카드의 × 로 되돌리면 원래 시각
  P.captureRemoveItem(st, note.id, { kind: 'moved', id: st.blocks[0].id }, later);
  assert.strictEqual(hm(st.blocks[0]), '2026-10-25 08:00–09:00');
});

test('고치라고 했는데 이미 그 시각이면 — 메모로 남기지 않고 "이미 그 시각" 으로', () => {
  const st = M.emptyState();
  send(st, '내일 8시에 기도회', { events: [ev('기도회', '내일 8시에 기도회', '2026-10-25', '20:00')] });
  const { note } = send(st, '아니 내일 오후 8시 기도회야', { events: [ev('기도회', '아니 내일 오후 8시 기도회야', '2026-10-25', '20:00')] }, new Date(NOW.getTime() + 60000));
  assert.strictEqual(st.blocks.length, 1);
  assert.strictEqual(note.capture.entryType, 'unchanged');
  assert.deepStrictEqual(note.capture.unchanged, [{ title: '기도회', at: '2026-10-25 20:00' }]);
  assert.ok(note.deletedAt, '메모로 남기지 않는다');
  assert.deepStrictEqual(note.capture.skipped, []);
});

test('일정: 날짜를 고치는 말 ("아니 모레야") — 이름이 같은 방금 일정을 옮긴다', () => {
  const st = M.emptyState();
  send(st, '내일 저녁 7시 셀모임', { events: [ev('셀모임', '내일 저녁 7시 셀모임', '2026-10-25', '19:00')] });
  send(st, '아니 셀모임 모레야', { events: [ev('셀모임', '아니 셀모임 모레야', '2026-10-26', '19:00')] }, new Date(NOW.getTime() + 60000));
  assert.strictEqual(st.blocks.length, 1);
  assert.strictEqual(hm(st.blocks[0]), '2026-10-26 19:00–20:00');
});

test('고치는 말이 없고 오래전에 만든 같은 이름 일정이면 건드리지 않는다 (중복으로 건너뜀)', () => {
  const st = M.emptyState();
  const old = new Date(NOW.getTime() - 3 * 3600000);
  send(st, '내일 8시 팀 회의', { events: [ev('팀 회의', '내일 8시 팀 회의', '2026-10-25', '08:00')] }, old);
  const { note } = send(st, '내일 20시 팀 회의', { events: [ev('팀 회의', '내일 20시 팀 회의', '2026-10-25', '20:00')] });
  assert.strictEqual(hm(st.blocks[0]), '2026-10-25 08:00–09:00');
  assert.strictEqual(note.capture.skipped.length, 1);
});

test('시간 정한 할 일: "아니 오후 3시에" — 방금 할 일의 작업 시간을 옮긴다', () => {
  const st = M.emptyState();
  const task = (q, time) => ({ title: '보고서 쓰기', evidence: { quote: q, line: 1 }, due: EMPTY, project_hint: null, basis: 'explicit',
    size: 'small', breakdown: [], do_at: { text: q, date: '2026-10-24', time }, typical_minutes: null, prep_steps: [] });
  send(st, '9시에 보고서 쓰기', { tasks: [task('9시에 보고서 쓰기', '09:00')] });
  const t = M.liveTasks(st)[0];
  assert.strictEqual(D.hm(M.blocksForTask(st, t.id)[0].start), '09:00');
  send(st, '아니 오후 9시에 보고서 쓰기', { tasks: [task('아니 오후 9시에 보고서 쓰기', '21:00')] }, new Date(NOW.getTime() + 60000));
  assert.strictEqual(M.liveTasks(st).length, 1, '새 할 일 없음');
  const blocks = M.blocksForTask(st, t.id);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(D.hm(blocks[0].start), '21:00');
});

test('오전/오후를 말하지 않은 시각: 저녁 일·오후 1~6시는 앱이 오후로', () => {
  const at = (text, ai) => { const st = M.emptyState(); send(st, text, { events: [ev('일정', text, '2026-10-25', ai)] }); return D.hm(st.blocks[0].start); };
  assert.strictEqual(at('내일 8시에 기도회', '08:00'), '20:00');
  assert.strictEqual(at('내일 7시 셀모임', '07:00'), '19:00');
  assert.strictEqual(at('내일 3시 치과', '03:00'), '15:00');
  assert.strictEqual(at('내일 9시 팀 회의', '09:00'), '09:00', '7~11시 보통 일은 AI 판단대로');
  assert.strictEqual(at('내일 새벽 5시 공항', '05:00'), '05:00', '새벽이라고 말하면 그대로');
  assert.strictEqual(at('내일 오전 8시 기도회', '08:00'), '08:00', '오전이라고 말하면 그대로');
});

test('채팅: "아니 오후야" 는 앱이 바로 알아듣는다', () => {
  const CMD = require('../src/core/ai/commands');
  const st = M.emptyState();
  assert.deepStrictEqual(CMD.matchLocal(st, '아니 오후야', null), { action: 'fix_ampm', pm: true });
  assert.deepStrictEqual(CMD.matchLocal(st, '오전이야', null), { action: 'fix_ampm', pm: false });
  assert.deepStrictEqual(CMD.matchLocal(st, '저녁으로 바꿔줘', null), { action: 'fix_ampm', pm: true });
  assert.strictEqual(CMD.matchLocal(st, '오후 3시 회의', null), null);
});

test('프롬프트: 고치는 말·오전/오후 규칙', () => {
  assert.strictEqual(C.PROMPT_VERSION, 'capture.v14');
  assert.ok(C.SYSTEM.indexOf('방금 정리한 것 정정') !== -1 && C.SYSTEM.indexOf('오전/오후가 없으면') !== -1);
  // 예약: 하는 것은 할 일, 이미 잡힌 것은 일정
  assert.ok(C.SYSTEM.indexOf('예약됨') !== -1);
  const V = require('../src/core/ai/validate');
  const st = M.emptyState(), t0 = new Date(2026, 9, 24, 10, 0);
  const mk = (body, time) => {
    const note = M.addNote(st, { title: '', body }, t0); note.updatedAt = t0.toISOString();
    const task = { title: '정기 건강검진', evidence: { quote: body, line: 1 }, due: EMPTY, do_at: { text: '2027년 6월 15일 오전 10시', date: '2027-06-15', time }, size: 'small', basis: 'explicit' };
    return V.validateOrganizeNote({ entry_type: 'task', note_kind: 'memo', note_title: 'x', note_project_hint: null, tasks: [task], events: [], done_tasks: [], updated_tasks: [], bulk_updates: [], commands: [] }, { note, state: st, now: t0 }).items.map((i) => i.kind);
  };
  assert.deepStrictEqual(mk('2027년 6월 15일 오전 10시 정기 건강검진 예약', '10:00'), ['task']);
  assert.deepStrictEqual(mk('2027년 6월 15일 오전 10시에 정기 건강검진 예약됨', '10:00'), ['event']);
});

test('시각 없이 때만 말한 약속은 일정으로 — "점심식사" 12:00, "저녁 약속" 19:00 (AI 시각이 그 때 안이면 그대로)', () => {
  const at = (text, ai) => { const st = M.emptyState(); send(st, text, { events: [ev('약속', text, '2026-10-26', ai)] }); return st.blocks[0] ? D.hm(st.blocks[0].start) : '할 일로 감'; };
  assert.strictEqual(at('월요일 강남에서 점심식사', '12:00'), '12:00');
  assert.strictEqual(at('월요일 점심 약속', '12:30'), '12:30');
  assert.strictEqual(at('월요일 점심 약속', '19:00'), '12:00', '점심인데 저녁 시각이면 보통 시각으로');
  assert.strictEqual(at('월요일 저녁 약속', null), '19:00');
  assert.strictEqual(at('월요일 친구 만나기', '15:00'), '할 일로 감', '때를 말하지 않았으면 지금처럼 시각을 확정하지 않는다');
});
