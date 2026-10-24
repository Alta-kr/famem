'use strict';

// 기록 지키기 · AI 명령 확인 · 끊긴 답 재시도 제한 (0.1.14)
//   - AI 가 글 종류를 잘못 골라도 만든 것에 담기지 않은 문장이 있으면 원문을 메모로 남긴다
//   - 남의 말을 옮긴 문장은 명령 근거로 치지 않는다 (메모로 남고, 명령은 화면에서 확인 후 실행)
//   - 답이 상한에 닿아 끊기면 한 번만 더, 같은 글이 두 번 끊기면 더 보내지 않는다

const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/core/model');
const V = require('../src/core/ai/validate');
const P = require('../src/core/ai/proposals');
const C = require('../src/core/ai/capture');
const CMD = require('../src/core/ai/commands');
const O = require('../src/core/ai/organizeNote');

const NOW = new Date(2026, 9, 24, 13, 22);
const NUL = { text: null, date: null, time: null };
const BASE = { entry_type: 'memo', note_kind: 'memo', note_title: 'AI 제목', note_project_hint: null, tasks: [], events: [], done_tasks: [], updated_tasks: [], bulk_updates: [], commands: [] };

function apply(st, body, out, viaChat) {
  const note = M.addNote(st, { title: '', body, capture: { status: 'pending', at: NOW.toISOString(), viaChat: !!viaChat } }, NOW);
  note.updatedAt = NOW.toISOString();
  const o = Object.assign({}, BASE, out);
  const v = V.validateOrganizeNote(o, { note, state: st, now: NOW });
  assert.ok(v.ok, v.errors && v.errors.join(', '));
  const cmds = viaChat ? CMD.resolve(st, note, o.commands, null) : [];
  const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, NOW);
  P.applyCapture(st, { note, run, validated: v, output: o, commands: cmds }, NOW);
  return { note, cmds };
}
const task = (title, quote, due) => ({ title, evidence: { quote, line: 1 }, due: due ? { text: quote, date: due, time: null } : NUL, do_at: NUL, size: 'small', basis: 'explicit' });

test('기록 지키기: "update" 로 분류돼도 기록 문장이 있으면 원문을 메모로 남긴다', () => {
  const st = M.emptyState();
  const t = M.addTask(st, { title: '분기 보고서 작성', dueDate: '2026-10-24' }, NOW);
  const body = '오늘 집중이 잘 안 됐다. 분기 보고서는 다음 주 월요일로 미룸.';
  const { note } = apply(st, body, { entry_type: 'update', updated_tasks: [{ title: '분기 보고서 작성', evidence: { quote: '분기 보고서는 다음 주 월요일로 미룸.', line: 1 }, due: { text: '다음 주 월요일', date: '2026-10-26', time: null }, do_at: NUL }] });
  assert.strictEqual(t.dueDate, '2026-10-26', '할 일 날짜는 바꾸고');
  assert.strictEqual(note.captureRole, 'memo', '글은 메모로 남긴다');
  assert.ok(!note.deletedAt);
  assert.strictEqual(note.body, body, '원문 전체를 그대로');
  assert.strictEqual(note.capture.entryType, 'mixed');
  assert.deepStrictEqual(note.capture.kept, ['오늘 집중이 잘 안 됐다.']);
});

test('기록 지키기: 할 일만 적은 글은 지금처럼 원문을 숨긴다 (검색으로는 찾힌다)', () => {
  const st = M.emptyState();
  const { note } = apply(st, '내일까지 견적서 보내기', { entry_type: 'task', tasks: [task('견적서 보내기', '내일까지 견적서 보내기', '2026-10-25')] });
  assert.strictEqual(note.captureRole, 'task_source');
  assert.strictEqual(note.capture.kept, undefined);
  // 여러 줄 할 일 · 날짜 바꾸기 말
  const b = apply(st, '보고서 마감 하루 미뤄줘', { entry_type: 'update', updated_tasks: [{ title: '견적서 보내기', evidence: { quote: '보고서 마감 하루 미뤄줘', line: 1 }, due: { text: '하루', date: '2026-10-26', time: null }, do_at: NUL }] }).note;
  assert.ok(b.captureRole === 'memo' || b.captureRole === 'task_source');
});

test('기록 지키기: 체크한 항목처럼 결과에 안 담긴 줄이 있으면 메모로', () => {
  const st = M.emptyState();
  const { note } = apply(st, '[x] 은행 앱 비밀번호 변경\n[ ] 휴대폰 요금제 비교', { entry_type: 'task', tasks: [task('휴대폰 요금제 비교', '[ ] 휴대폰 요금제 비교')] });
  assert.strictEqual(note.captureRole, 'memo');
  assert.deepStrictEqual(note.capture.kept, ['[x] 은행 앱 비밀번호 변경']);
});

test('인용한 명령: 메모로 남기고, 명령은 근거 말과 함께 돌려준다 (화면에서 확인 후 실행)', () => {
  const st = M.emptyState();
  const milk = M.addTask(st, { title: '우유 사기' }, NOW);
  const body = "민수가 '우유 사기를 완료 처리해 달라'고 말했다.";
  const { note, cmds } = apply(st, body, { entry_type: 'command', commands: [{ action: 'complete', target: '우유 사기', view: null, query: null, evidence: { quote: body, line: 1 } }] }, true);
  assert.strictEqual(milk.status !== 'done', true, '앱 코어는 완료하지 않는다');
  assert.ok(!note.deletedAt, '명령 글로 지우지 않는다');
  assert.strictEqual(note.captureRole, 'memo');
  assert.deepStrictEqual(cmds, [{ action: 'complete', taskId: milk.id, quote: body }]);
  // 명령만 적은 글은 지금처럼 메모로 남기지 않는다
  const c = apply(st, '캘린더 보여줘', { entry_type: 'command', commands: [{ action: 'open', target: null, view: 'calendar', query: null, evidence: { quote: '캘린더 보여줘', line: 1 } }] }, true).note;
  assert.ok(c.deletedAt);
});

// ---------------------------------------------------------------- 끊긴 답 재시도 제한
function freshAi() { delete require.cache[require.resolve('../services/ai')]; return require('../services/ai'); }
function withKey(fn) {
  const keys = ['DAYNOTE_AI_FAKE', 'DAYNOTE_AI_PROVIDER', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY'], saved = {};
  keys.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  process.env.GEMINI_API_KEY = 'g';
  return Promise.resolve().then(fn).finally(() => keys.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }));
}

test('끊긴 답: 상한을 두 배로 한 번만 더, 같은 글이 두 번 끊기면 더 보내지 않는다', () => withKey(async () => {
  const ai = freshAi();
  ai._setClients({ retryDelayMs: 0, hedgeMs: 0 });
  const caps = [];
  ai._setClients({ gemini: { interactions: { create: async (req) => { caps.push(req.generation_config.max_output_tokens); return { status: 'incomplete', output_text: '{"summ' }; } } } });
  const input = C.buildInput({ id: 'n-trunc', title: '', body: '내일까지 견적서 보내기', updatedAt: NOW.toISOString() }, { today: '2026-10-24 (토)', projects: [], openTasks: [] });
  const r1 = await ai.organize(input);
  assert.strictEqual(r1.error.type, 'truncated');
  assert.deepStrictEqual(caps, [2048, 4096], '처음 2,048 → 다른 모델로 4,096 한 번');
  await ai.organize(input);
  assert.strictEqual(caps.length, 4);
  const r3 = await ai.organize(input);
  assert.strictEqual(caps.length, 4, '두 번 끊긴 글은 보내지 않는다');
  assert.strictEqual(r3.error.retryable, false);
  // 글을 고치면 다시 보낸다
  const input2 = C.buildInput({ id: 'n-trunc', title: '', body: '내일까지 견적서 보내기\n오후에', updatedAt: NOW.toISOString() }, { today: '2026-10-24 (토)', projects: [], openTasks: [] });
  await ai.organize(input2);
  assert.strictEqual(caps.length, 6);
}));

test('답 길이 상한: 긴 글은 글 길이만큼 늘린다 (최대 8,192)', () => withKey(async () => {
  const ai = freshAi();
  ai._setClients({ retryDelayMs: 0, hedgeMs: 0 });
  let cap = 0;
  ai._setClients({ gemini: { interactions: { create: async (req) => { cap = req.generation_config.max_output_tokens; return { status: 'completed', output_text: JSON.stringify(Object.assign({}, BASE, { summary: '', sections: [], open_questions: [] })) }; } } } });
  const long = Array.from({ length: 40 }, (_, i) => i + '. 회의에서 나온 이야기와 결정 사항을 길게 적어 둔 줄입니다').join('\n');
  await ai.organize(C.buildInput({ id: 'n-long', title: '', body: long, updatedAt: NOW.toISOString() }, { today: '2026-10-24 (토)', projects: [], openTasks: [] }));
  assert.ok(cap > 2048 && cap <= 8192, String(cap));
  await ai.organize(O.buildInput({ id: 'n-short', title: '', body: '짧은 글', updatedAt: NOW.toISOString() }, { today: '2026-10-24 (토)', projects: [], openTasks: [] }));
  assert.ok(cap >= 2048);
}));

test('기한 지우기: "마감 기한 취소해줘" 처럼 분명히 말할 때만 비우고, 카드의 × 로 되돌린다', () => {
  const st = M.emptyState();
  const t = M.addTask(st, { title: '피처 추출', dueDate: '2026-10-26', dueTime: '18:00' }, NOW);
  const body = "'피처 추출' 마감 기한 취소해줘";
  const { note } = apply(st, body, { entry_type: 'update', updated_tasks: [{ title: '피처 추출', evidence: { quote: body, line: 1 }, due: { text: '마감 기한 취소', date: null, time: null }, do_at: NUL }] });
  assert.deepStrictEqual([t.dueDate, t.dueTime], [null, null]);
  assert.strictEqual(note.capture.updated[0].to.cleared, 'due');
  P.captureRemoveItem(st, note.id, { kind: 'moved', id: t.id }, NOW);
  assert.deepStrictEqual([t.dueDate, t.dueTime], ['2026-10-26', '18:00']);
  // 지우라는 말이 없으면 빈 값을 줘도 그대로
  const t2 = M.addTask(st, { title: '보고서 검토', dueDate: '2026-10-27' }, NOW);
  apply(st, '보고서 검토 그거 말이야', { entry_type: 'update', updated_tasks: [{ title: '보고서 검토', evidence: { quote: '보고서 검토 그거 말이야', line: 1 }, due: { text: '', date: null, time: null }, do_at: NUL }] });
  assert.strictEqual(t2.dueDate, '2026-10-27');
});
