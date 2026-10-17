'use strict';

// AI 요청 처리 고침 (5) — 지운 할 일의 단계 나누기 결과, 줄 번호("2| ")를 옮겨 온 근거 인용,
// 개발용 제공자 설정 때문에 쓰지 않는 키를 저장했을 때의 안내.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('../src/core/model');
const D = require('../src/core/dates');
const V = require('../src/core/ai/validate');
const P = require('../src/core/ai/proposals');
const AS = require('../src/core/ai/assist');

const NOW = new Date(2026, 9, 5, 10);

// ---------------------------------------------------------------- 지운 할 일의 단계 나누기
test('단계 나누기: 지운 할 일에는 초안을 보관하지도 적용하지도 않는다', () => {
  const st = M.normalize(null);
  const t = M.addTask(st, { title: '분기 보고서 작성', estimateMinutes: 240 }, NOW);
  M.deleteTask(st, t.id, NOW);
  const steps = [{ title: '자료 모으기', minutes: 30 }, { title: '초안 쓰기', minutes: 60 }];
  assert.strictEqual(AS.storeBreakdown(st, t.id, { steps, reason: '' }, 'button', NOW), null);
  assert.strictEqual(AS.applyBreakdown(st, t.id, steps, NOW), null);
  const after = M.byId(st.tasks, t.id);
  assert.ok(!after.breakdown);
  assert.deepStrictEqual(after.steps || [], []);
});

function loadAssistant(reply) {
  const window = { Daynote: {} };
  const toasts = [];
  const sandbox = { window, console, JSON, Object, Array, Promise, Date, Math, String, Number, setTimeout, setInterval() {},
    document: { addEventListener() {} } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const DN = window.Daynote;
  let resolve = null;
  const S = {
    state: M.normalize(null),
    mutate(label, fn) { return fn(S.state); },
    whenReady() {},
    host: { ai: { organizeNote: () => new Promise((r) => { resolve = r; }) } }
  };
  Object.assign(DN, {
    model: M, dates: D, aiAssist: AS, store: S, recommend: {},
    aiFlow: { status: () => ({ configured: true }) },
    app: { now: () => new Date(NOW) },
    ui: { josa: (w, pair) => w + pair.split('/')[0], toast: (t) => toasts.push(t) }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'renderer/assistant.js'), 'utf8'), sandbox, { filename: 'renderer/assistant.js' });
  return { DN, S, toasts, answer: (out) => resolve(out) };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('단계 나누기: AI 가 생각하는 사이 할 일을 지우면 카드 대신 짧은 안내만 남고, 옛 카드의 적용도 막는다', async () => {
  const { DN, S, toasts, answer } = loadAssistant();
  const t = M.addTask(S.state, { title: '분기 보고서 작성', estimateMinutes: 240 }, NOW);
  DN.assistant.breakdown(t.id);
  M.deleteTask(S.state, t.id, NOW);
  answer({ ok: true, output: { is_large: true, reason: '단계가 여러 개라서요', steps: [
    { title: '자료 모으기', minutes: 30 }, { title: '초안 쓰기', minutes: 60 }, { title: '검토하기', minutes: 30 }] } });
  await tick();
  assert.deepStrictEqual(S.state.chat.map((m) => m.kind), ['text']);
  assert.strictEqual(S.state.chat[0].text, '할 일이 지워져서 나누지 않았어요.');
  assert.ok(!M.byId(S.state.tasks, t.id).breakdown);

  // 형식이 틀린 응답이어도 빈 칸 카드를 띄우지 않는다
  const b = loadAssistant();
  const t2 = M.addTask(b.S.state, { title: '발표 자료', estimateMinutes: 120 }, NOW);
  b.DN.assistant.breakdown(t2.id);
  M.deleteTask(b.S.state, t2.id, NOW);
  b.answer({ ok: true, output: { isLarge: true } });
  await tick();
  assert.deepStrictEqual(b.S.state.chat.map((m) => m.kind), ['text']);

  // 지운 뒤 옛 카드에서 '이렇게 나누기' — 적용하지 않고 성공이라고 하지 않는다
  const msg = DN.assistant.post({ kind: 'breakdown', taskId: t.id, draft: [{ title: '자료 모으기', minutes: 30 }] });
  assert.strictEqual(DN.assistant.applyBreakdown(msg.id, t.id, [{ title: '자료 모으기', minutes: 30 }]), false);
  assert.deepStrictEqual(M.byId(S.state.tasks, t.id).steps || [], []);
  assert.strictEqual(M.byId(S.state.chat, msg.id).resolved, 'deleted');
  assert.deepStrictEqual(toasts, []);

  // 지운 할 일을 골라 나누라고 하면 없다고 말한다
  DN.assistant.breakdown(t.id);
  assert.strictEqual(S.state.chat[S.state.chat.length - 1].text, '나눌 만한 할 일이 없어요.');
});

test('단계 나누기 카드: 지운 할 일에는 적용·나중에 버튼 없이 안내만 그린다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/views/chat.js'), 'utf8');
  const a = src.indexOf('  function breakdownCard(');
  const head = src.slice(a, src.indexOf('    if (m.resolved) {', a));
  assert.ok(/t\.deletedAt/.test(head) && /할 일이 지워져서 나누지 않았어요\./.test(head), head);
});

// ---------------------------------------------------------------- 줄 번호를 옮겨 온 근거
const NOTE = { id: 'n1', title: '회의 메모', body: '- [ ] 금요일까지 보고서 검토 부탁드립니다\n내일 오후 3시 팀 미팅', updatedAt: NOW.toISOString() };
function out(taskQuote, eventQuote, line) {
  return {
    summary: '', sections: [], open_questions: [],
    tasks: [{ title: '보고서 검토', evidence: { quote: taskQuote, line: line }, due: { text: '금요일까지', date: '2026-10-09', time: null }, project_hint: null }],
    events: [{ title: '팀 미팅', evidence: { quote: eventQuote, line: null }, start: { text: '내일 오후 3시', date: '2026-10-06', time: '15:00' }, duration_minutes: null, location: null }]
  };
}

test('근거 인용: 앱이 붙인 "N| " 줄 번호를 옮겨 와도 받아들이고, 항목에는 접두어를 뗀 인용을 남긴다', () => {
  const lines = V.noteLines(NOTE);
  assert.strictEqual(V.locate(lines, '1| - [ ] 금요일까지 보고서 검토 부탁드립니다', null), 1);
  assert.strictEqual(V.locate(lines, '2| 내일 오후 3시 팀 미팅', 2), 2);
  assert.deepStrictEqual(V.splitLinePrefix('2| 내일'), { text: '내일', line: 2 });

  const st = M.normalize(null);
  const plain = V.validateOrganizeNote(out('금요일까지 보고서 검토 부탁드립니다', '내일 오후 3시 팀 미팅', 1), { note: NOTE, state: st, now: NOW });
  const pref = V.validateOrganizeNote(out('1| - [ ] 금요일까지 보고서 검토 부탁드립니다', '2| 내일 오후 3시 팀 미팅', null), { note: NOTE, state: st, now: NOW });
  assert.strictEqual(pref.ok, true);
  assert.strictEqual(pref.dropped.length, 0, JSON.stringify(pref.dropped));
  assert.strictEqual(pref.items.length, 2);
  assert.strictEqual(pref.items[0].quote, '- [ ] 금요일까지 보고서 검토 부탁드립니다');
  assert.strictEqual(pref.items[1].quote, '내일 오후 3시 팀 미팅');
  assert.strictEqual(pref.items[1].line, 2);
  assert.strictEqual(plain.items[1].quote, pref.items[1].quote);   // 다시 정리해도 같은 key
});

test('근거 인용: 줄 번호를 붙여 지어낸 문장은 여전히 버리고, 원래 "N|" 로 시작하는 줄은 그대로 찾는다', () => {
  const st = M.normalize(null);
  const fake = V.validateOrganizeNote(out('1| 없는 문장 지어내기', '2| 모레 회식', null), { note: NOTE, state: st, now: NOW });
  assert.strictEqual(fake.items.length, 0);
  assert.strictEqual(fake.dropped.length, 2);
  const raw = { id: 'n2', title: '', body: '3| 견적서 금요일까지 보내기', updatedAt: NOW.toISOString() };
  const lines = V.noteLines(raw);
  assert.strictEqual(V.locate(lines, '3| 견적서 금요일까지 보내기', null), 1);
  const r = V.validateOrganizeNote({ summary: '', sections: [], open_questions: [], events: [],
    tasks: [{ title: '견적서 보내기', evidence: { quote: '3| 견적서 금요일까지 보내기', line: 1 }, due: { text: null, date: null, time: null }, project_hint: null }] },
  { note: raw, state: st, now: NOW });
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].quote, '3| 견적서 금요일까지 보내기');
});

test('근거 인용: 상태 보고(presence) 인용도 줄 번호를 떼고 찾는다', () => {
  const note = { id: 'n3', title: '', body: '지금 회의 들어가요', updatedAt: NOW.toISOString() };
  const role = V.PRESENCE_ROLES.filter((x) => x !== 'none')[0];
  const r = V.validateOrganizeNote({ summary: '', sections: [], open_questions: [], tasks: [], events: [],
    presence: { role, quote: '1| 지금 회의 들어가요' } }, { note, state: M.normalize(null), now: NOW });
  assert.ok(r.presence, JSON.stringify(r));
  assert.strictEqual(r.presence.quote, '지금 회의 들어가요');
  assert.strictEqual(r.presence.line, 1);
});

// ---------------------------------------------------------------- 설정: 쓰지 않는 키 저장
function nestedFn(src, name) {
  const start = src.indexOf('    function ' + name + '(');
  assert.ok(start >= 0, name + ' 없음');
  return src.slice(start, src.indexOf('\n    }\n', start) + 6);
}
function saveHarness(setKeyReply) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/views/settings.js'), 'utf8');
  const body = ['var lastCheck = null, checkSeq = 0;', 'function rerender() {}', nestedFn(src, 'save'), 'return save;'].join('\n');
  const toasts = [];
  const el = { textContent: '' };
  const input = { value: 'AIzaSyD' + 'x'.repeat(32), focus() {}, select() {} };
  const S = { host: { ai: { setKey: () => Promise.resolve(setKeyReply) } } };
  const ui = { toast: (t) => toasts.push(t) };
  const document = { getElementById: () => el };
  const save = new Function('S', 'ui', 'document', 'input', 'result', body)(S, ui, document, input, el);
  return { save, toasts };
}

test('설정: 키를 저장했지만 지금 쓰지 않으면(제공자 설정 등) 자동으로 나눠 준다고 하지 않는다', async () => {
  const off = saveHarness({ ok: true, status: { configured: false, provider: null, reason: 'ANTHROPIC_API_KEY 환경변수가 설정되어 있지 않아요.' } });
  off.save();
  await tick();
  assert.strictEqual(off.toasts.length, 1);
  assert.ok(!/자동으로 나눠 드려요/.test(off.toasts[0]), off.toasts[0]);
  assert.ok(/쓰지 않고 있어요/.test(off.toasts[0]) && /고급/.test(off.toasts[0]));
  assert.ok(!/ANTHROPIC|DAYNOTE_/.test(off.toasts[0]));   // 원문 사유는 고급에만

  const on = saveHarness({ ok: true, status: { configured: true, provider: 'gemini' } });
  on.save();
  await tick();
  assert.deepStrictEqual(on.toasts, ['AI 키를 저장했어요. 이제 적은 글을 자동으로 나눠 드려요.']);
  const bare = saveHarness({ ok: true });   // 상태를 돌려주지 않는 호스트는 그대로
  bare.save();
  await tick();
  assert.deepStrictEqual(bare.toasts, ['AI 키를 저장했어요. 이제 적은 글을 자동으로 나눠 드려요.']);
});

// ---------------------------------------------------------------- 끝냈다·날짜 바꾸기 보고의 인용
test('완료·날짜 바꾸기 보고: 줄 번호를 붙인 인용도 원문에서 찾는다', () => {
  const C = require('../src/core/ai/capture');
  const st = M.normalize(null);
  const at = new Date(2026, 9, 9, 22, 0);
  const a = M.addTask(st, { title: '샤워하기' }, at);
  const b = M.addTask(st, { title: '견적서 보내기', dueDate: '2026-10-09' }, at);
  const note = M.addNote(st, { title: '', body: '샤워 완료\n견적서는 내일 보낼게', capture: { status: 'pending', at: at.toISOString() } }, at);
  note.updatedAt = at.toISOString();
  const out = { summary: '', sections: [], tasks: [], events: [], open_questions: [], entry_type: 'done', note_title: '', note_project_hint: null, note_kind: 'memo',
    done_tasks: [{ title: '샤워하기', evidence: { quote: '1| 샤워 완료', line: 1 } }],
    updated_tasks: [{ title: '견적서 보내기', evidence: { quote: '2| 견적서는 내일 보낼게', line: 2 }, due: { text: '내일', date: '2026-10-10', time: null }, do_at: null }] };
  const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, at);
  P.applyCapture(st, { note, run, validated: V.validateOrganizeNote(out, { note, state: st, now: at }), output: out }, at);
  assert.strictEqual(a.status, 'done');
  assert.strictEqual(b.dueDate, '2026-10-10');
});
