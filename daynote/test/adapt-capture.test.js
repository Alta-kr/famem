'use strict';

// 적응 × 빠른 입력 — 결과 카드에서 고친 것을 배우고(learnFrom), 확실한 규칙을 다음 글에 적용한다(applyLearned).
// ADAPT §7.5–7.6, §7.10 adapt-capture #1–19

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/core/model');
const V = require('../src/core/ai/validate');
const P = require('../src/core/ai/proposals');
const C = require('../src/core/ai/capture');
const AD = require('../src/core/adapt');
const fake = require('../src/core/ai/fake');

const NOW = new Date(2026, 9, 5, 10, 0);   // 월요일
const DAY = 86400000;

function setup() {
  const st = M.emptyState();
  M.addProject(st, { id: 'p1', name: 'B2B 영업' }, NOW);
  M.addProject(st, { id: 'p2', name: '3분기 리포트' }, NOW);
  return st;
}
// 화면과 같은 순서: 메모 저장 → (가짜) AI → 검증 → 반영
function submit(st, text, output, opts) {
  const note = M.addNote(st, { title: '', body: text, capture: { status: 'pending', at: NOW.toISOString() } }, NOW);
  note.updatedAt = NOW.toISOString();
  const input = C.buildInput(note, Object.assign({ today: '2026-10-05 (월)', projects: st.projects.map((p) => p.name), openTasks: [] }, opts || {}));
  const out = output || fake.organize(input).output;
  const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, NOW);
  const v = V.validateOrganizeNote(out, { note, state: st, now: NOW });
  assert.ok(v.ok, v.errors.join());
  P.applyCapture(st, { note, run, validated: v, output: out }, NOW);
  return note;
}
const rulesOf = (st, type) => st.learned.rules.filter((r) => r.type === type);
const live = (st) => M.liveTasks(st);
// '장보기' 를 메모 → 할 일로 n 번 고친다
function teachTask(st, n, text) {
  for (let i = 0; i < n; i++) {
    const note = submit(st, text || '장보기');
    assert.equal(note.capture.created.length, 0);
    P.captureSetKind(st, note.id, 'task', NOW);
  }
}

test('#1 captureSetKind 로 ‘장보기’ 를 메모 → 할 일: kind 규칙이 생기고 capture.taught', () => {
  const st = setup();
  const note = submit(st, '장보기');
  P.captureSetKind(st, note.id, 'task', NOW);
  const r = rulesOf(st, 'kind');
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].key, r[0].role, r[0].to, r[0].from, r[0].n, r[0].src, r[0].ref], ['장보기', 'exact', 'task', 'memo', 1, 'correction', note.id]);
  assert.equal(note.capture.taught, true);
  assert.equal(note.capture.changedByUser, true);
});

test('#2 captureSetItemKind: 여러 줄 카드의 한 줄을 바꾸면 그 줄의 근거 문장으로 배운다', () => {
  const st = setup();
  const note = submit(st, '오늘 회의 분위기 좋았음\n디자인 시안 금요일까지 공유 부탁드립니다');
  const ref = note.capture.created[0];
  assert.equal(ref.kind, 'task');
  const quote = M.byId(st.tasks, ref.id).sources[0].excerpt;
  P.captureSetItemKind(st, note.id, ref, 'event', NOW);
  const r = rulesOf(st, 'kind');
  assert.ok(r.length >= 1);
  assert.ok(r.every((x) => x.to === 'event' && x.from === 'task'));
  assert.ok(r.some((x) => x.role === 'exact' && x.key === AD.normKey(quote)));
});

test('#3 captureSetProject(…, NOW) → project 규칙(from none). now 가 없으면 배우지 않는다', () => {
  const st = setup();
  const n1 = submit(st, '삼성 견적서 보내기');
  P.captureSetProject(st, n1.id, 'p1', NOW);
  const r = rulesOf(st, 'project');
  assert.ok(r.length >= 1);
  assert.ok(r.every((x) => x.to === 'p1' && x.from === 'none'));
  assert.ok(r.some((x) => x.role === 'part' && x.key === '삼성'));
  const st2 = setup();
  const n2 = submit(st2, '삼성 견적서 보내기');
  P.captureSetProject(st2, n2.id, 'p1');
  assert.equal(n2.projectId, 'p1');
  assert.equal(st2.learned.rules.length, 0);
});

test('#4 captureRemoveItem × → 그 종류 규칙이 약해지고 새 규칙은 생기지 않는다', () => {
  const st = setup();
  const note = submit(st, '장보기');
  P.captureSetKind(st, note.id, 'task', NOW);
  const rule = rulesOf(st, 'kind')[0];
  assert.equal(rule.w, 1);
  const count = st.learned.rules.length;
  P.captureRemoveItem(st, note.id, note.capture.created[0], NOW);
  assert.equal(st.learned.rules.length, count);
  assert.ok(AD.get(st, rule.id).w < 1);
});

test('#5 captureSetDate: 앱이 계산 못 하는 ‘주말’ 만 배운다 (계산되는 말·날짜 없음은 배우지 않음)', () => {
  const st = setup();
  const n1 = submit(st, '주말에 장보기');
  const t1 = P.captureToTask(st, n1.id, NOW);
  P.captureSetDate(st, n1.id, { kind: 'task', id: t1.id }, '2026-10-11', null, NOW);
  assert.equal(t1.dueDate, '2026-10-11');
  const d = rulesOf(st, 'date');
  assert.equal(d.length, 1);
  assert.deepEqual([d[0].key, d[0].role, d[0].to], ['주말', 'lex', 'd6']);

  const n2 = submit(st, '내일 장보기');
  const t2 = P.captureToTask(st, n2.id, NOW);
  P.captureSetDate(st, n2.id, { kind: 'task', id: t2.id }, '2026-10-08', null, NOW);
  assert.equal(rulesOf(st, 'date').length, 1);

  P.captureSetDate(st, n1.id, { kind: 'task', id: t1.id }, null, null, NOW);
  assert.equal(t1.dueDate, null);
  assert.equal(rulesOf(st, 'date').length, 1);
});

test('captureSetDate: 일정은 길이를 지키며 옮기고, 시각을 고르면 확인 필요를 푼다', () => {
  const st = setup();
  const note = submit(st, '수요일 오후 3시 디자인 리뷰 회의');
  const ref = note.capture.created[0];
  const b = M.byId(st.blocks, ref.id);
  M.updateBlock(st, b.id, { timeUncertain: true });
  const len = new Date(b.end) - new Date(b.start);
  P.captureSetDate(st, note.id, ref, '2026-10-08', '16:00', NOW);
  assert.equal(new Date(b.start).getDate(), 8);
  assert.equal(new Date(b.start).getHours(), 16);
  assert.equal(new Date(b.end) - new Date(b.start), len);
  assert.equal(b.timeUncertain, false);
  assert.equal(rulesOf(st, 'date').length, 0);
});

test('#6 두 번 고친 뒤 새 ‘장보기’(AI 는 메모) → applyLearned 가 할 일로. learned 1개, changedByUser 아님, applied 1', () => {
  const st = setup();
  teachTask(st, 2);
  const note = submit(st, '장보기');
  assert.equal(note.capture.created.length, 0);
  const plan = P.planLearned(st, note.id, NOW, { hinted: [] });
  assert.equal(plan.kind.to, 'task');
  const entries = P.applyLearned(st, note.id, NOW, { hinted: [] });
  assert.equal(entries.length, 1);
  assert.equal(note.capture.created.length, 1);
  assert.equal(note.capture.created[0].kind, 'task');
  assert.equal(note.capture.learned.length, 1);
  assert.deepEqual([note.capture.learned[0].type, note.capture.learned[0].to, note.capture.learned[0].from], ['kind', 'task', 'memo']);
  assert.ok(!note.capture.changedByUser);
  assert.equal(st.learned.metrics.applied, 1);
  // 글마다 한 번
  assert.deepEqual(P.applyLearned(st, note.id, NOW, { hinted: [] }), []);
});

test('#7 한 번만 고쳤으면 바꾸지 않는다', () => {
  const st = setup();
  teachTask(st, 1);
  const note = submit(st, '장보기');
  assert.deepEqual(P.applyLearned(st, note.id, NOW, { hinted: [] }), []);
  assert.equal(note.capture.created.length, 0);
});

test('#8 사용자 결정(changedByUser·kindByUser·명령어·고른 프로젝트)이 있으면 계획이 비어 있다', () => {
  const st = setup();
  teachTask(st, 2);
  const empty = { kind: null, project: null, dates: [] };
  const a = submit(st, '장보기'); a.capture.changedByUser = true;
  assert.deepEqual(P.planLearned(st, a.id, NOW, {}), empty);
  const b = submit(st, '장보기'); b.kindByUser = true;
  assert.equal(P.planLearned(st, b.id, NOW, {}).kind, null);
  const c = submit(st, '장보기'); c.capture.command = { name: 'memo', kind: 'memo' };
  assert.deepEqual(P.planLearned(st, c.id, NOW, {}), empty);
  for (const text of ['삼성 견적서', '삼성 미팅 자료', '삼성 출장 일정']) { const n = submit(st, text); P.captureSetProject(st, n.id, 'p1', NOW); }
  const d = M.addNote(st, { body: '삼성 계약서 검토', projectId: 'p2', capture: { status: 'done', created: [], projectByAi: false } }, NOW);
  assert.equal(P.planLearned(st, d.id, NOW, {}).project, null);
});

test('#9 두 줄 글은 종류 계획이 없다', () => {
  const st = setup();
  teachTask(st, 2);
  const note = submit(st, '장보기\n우유랑 계란');
  assert.equal(P.planLearned(st, note.id, NOW, {}).kind, null);
});

test('#10 배운 대로 바꾼 글을 사용자가 다시 메모로 → 규칙 벌점, reverted 1, 메모 규칙이 생긴다', () => {
  const st = setup();
  teachTask(st, 2);
  const rule = rulesOf(st, 'kind').find((r) => r.to === 'task');
  const before = AD.get(st, rule.id).w;
  const note = submit(st, '장보기');
  P.applyLearned(st, note.id, NOW, { hinted: [] });
  P.captureSetKind(st, note.id, 'memo', NOW);
  const after = AD.get(st, rule.id);
  assert.ok(!after || after.w <= before - 1);
  assert.equal(st.learned.metrics.reverted, 1);
  assert.ok(rulesOf(st, 'kind').some((r) => r.to === 'memo' && r.from === 'task'));
  assert.equal(note.capture.learned.length, 0);
});

test('#11 AI 없는(no_ai) 글에도 확실한 규칙을 적용한다', () => {
  const st = setup();
  teachTask(st, 2);
  const note = M.addNote(st, { title: '', body: '장보기', capture: { status: 'no_ai', at: NOW.toISOString(), created: [] } }, NOW);
  const entries = P.applyLearned(st, note.id, NOW, { hinted: [] });
  assert.equal(entries.length, 1);
  assert.equal(live(st).filter((t) => t.title === '장보기').length, 3);
  assert.equal(note.capture.created.length, 1);
  // 실패한 글에는 적용하지 않는다
  const failed = M.addNote(st, { body: '장보기', capture: { status: 'failed', created: [] } }, NOW);
  assert.deepEqual(P.applyLearned(st, failed.id, NOW, { hinted: [] }), []);
});

test('#12 ‘삼성’ 3번 → 프로젝트를 못 붙인 새 글에 채운다. 사용자가 고른 글은 건드리지 않는다', () => {
  const st = setup();
  for (const text of ['삼성 견적서 보내기', '삼성 미팅 자료', '삼성 출장 일정']) { const n = submit(st, text); P.captureSetProject(st, n.id, 'p1', NOW); }
  const note = submit(st, '삼성 계약서 검토하기');
  assert.equal(note.projectId, null);
  const entries = P.applyLearned(st, note.id, NOW, { hinted: [] });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, 'project');
  assert.equal(note.projectId, 'p1');
  assert.ok(note.capture.created.every((c) => M.byId(st.tasks, c.id).projectId === 'p1'));
  assert.equal(note.capture.projectByAi, false);
  // 사용자가 고른 프로젝트
  const mine = M.addNote(st, { title: '', body: '삼성 계약서 검토하기', projectId: 'p2', capture: { status: 'pending' } }, NOW);
  mine.updatedAt = NOW.toISOString();
  const out = fake.organize(C.buildInput(mine, { today: '2026-10-05 (월)', projects: [], openTasks: [] })).output;
  const run = P.startRun(st, { noteId: mine.id, kind: 'capture' }, NOW);
  P.applyCapture(st, { note: mine, run, validated: V.validateOrganizeNote(out, { note: mine, state: st, now: NOW }), output: out }, NOW);
  assert.deepEqual(P.applyLearned(st, mine.id, NOW, { hinted: [] }), []);
  assert.equal(mine.projectId, 'p2');
});

test('#13 ‘주말’ 2번 → 새 ‘주말에 세차하기’ 의 빈 마감(확인 필요)을 채운다. 마감이 있는 할 일은 그대로', () => {
  const st = setup();
  for (const text of ['주말에 장보기', '주말에 청소']) {
    const n = submit(st, text);
    const t = P.captureToTask(st, n.id, NOW);
    P.captureSetDate(st, n.id, { kind: 'task', id: t.id }, '2026-10-11', null, NOW);
  }
  const out = { summary: '', sections: [], events: [], open_questions: [], entry_type: 'task', note_title: '세차', note_project_hint: null, note_kind: 'memo',
    done_tasks: [], updated_tasks: [], tasks: [{ title: '세차하기', evidence: { quote: '주말에 세차하기', line: 1 }, due: { text: '주말에', date: '2026-10-10', time: null },
      project_hint: null, basis: 'explicit', size: 'small', breakdown: [], do_at: { text: null, date: null, time: null } }] };
  const note = submit(st, '주말에 세차하기', out);
  const t = M.byId(st.tasks, note.capture.created[0].id);
  assert.equal(t.dueDate, null);
  const entries = P.applyLearned(st, note.id, NOW, { hinted: [] });
  assert.equal(entries.length, 1);
  assert.deepEqual([entries[0].type, entries[0].refId, entries[0].to], ['date', t.id, '2026-10-11']);
  assert.equal(t.dueDate, '2026-10-11');
  // 이미 마감이 있으면 그대로
  const n2 = submit(st, '주말에 세차하기 내일까지');
  const t2 = M.byId(st.tasks, n2.capture.created[0].id);
  assert.equal(t2.dueDate, '2026-10-06');
  P.applyLearned(st, n2.id, NOW, { hinted: [] });
  assert.equal(t2.dueDate, '2026-10-06');
});

test('#14 AI 가 힌트를 보고도 다르게 판단했고 확신도 < 0.8 이면 바꾸지 않는다', () => {
  const st = setup();
  teachTask(st, 2);
  const later = new Date(NOW.getTime() + 100 * DAY);       // 감쇠로 확신도 0.66–0.8
  const note = submit(st, '장보기');
  const s = AD.suggest(st, 'kind', '장보기', later);
  assert.equal(s.level, 'strong');
  assert.ok(s.confidence < 0.8);
  assert.equal(P.planLearned(st, note.id, later, { hinted: s.ruleIds }).kind, null);
  assert.equal(P.planLearned(st, note.id, later, { hinted: [] }).kind.to, 'task');
});

test('#15 buildInput·userText: 힌트가 있으면 input.learned 와 </context> 앞 블록, 없으면 블록 없음, capture.v7', () => {
  assert.equal(C.PROMPT_VERSION, 'capture.v7');
  const st = setup();
  teachTask(st, 1);
  const note = M.addNote(st, { body: '장보기', updatedAt: NOW.toISOString() }, NOW);
  const hints = AD.hints(st, note.body, NOW, { projects: M.liveProjects(st) });
  assert.equal(hints.length, 1);
  const input = C.buildInput(note, { today: '2026-10-05 (월)', projects: [], openTasks: [], learned: hints });
  assert.deepEqual(input.learned.map((x) => [x.type, x.to, x.phrase, x.says]), [['kind', 'task', '장보기', '할 일']]);
  const text = C.userText(input);
  const block = text.indexOf('사용자가 전에 직접 고친 방식');
  assert.ok(block > 0 && block < text.indexOf('</context>'));
  assert.match(text, /- ‘장보기’ → 할 일/);
  const plain = C.userText(C.buildInput(note, { today: '2026-10-05 (월)', projects: [], openTasks: [] }));
  assert.equal(plain.indexOf('사용자가 전에 직접 고친 방식'), -1);
  assert.match(C.SYSTEM, /^J\. <context> 에 "사용자가 전에 직접 고친 방식"/m);
});

test('#16 가짜 AI: 종류 힌트 task → ‘장보기’ 를 할 일로, 프로젝트 힌트 → note_project_hint', () => {
  const st = setup();
  const note = M.addNote(st, { body: '장보기', updatedAt: NOW.toISOString() }, NOW);
  const base = { today: '2026-10-05 (월)', projects: st.projects.map((p) => p.name), openTasks: [] };
  const plain = fake.organize(C.buildInput(note, base)).output;
  assert.equal(plain.tasks.length, 0);
  const o = fake.organize(C.buildInput(note, Object.assign({}, base, { learned: [{ type: 'kind', to: 'task', phrase: '장보기', says: '할 일', n: 2 }] }))).output;
  assert.equal(o.tasks.length, 1);
  assert.equal(o.tasks[0].title, '장보기');
  const memoHint = fake.organize(C.buildInput(M.addNote(st, { body: '견적서 보내기', updatedAt: NOW.toISOString() }, NOW),
    Object.assign({}, base, { learned: [{ type: 'kind', to: 'idea', phrase: '견적서', says: '아이디어', n: 2 }] }))).output;
  assert.equal(memoHint.tasks.length, 0);
  assert.equal(memoHint.note_kind, 'idea');
  const p = fake.organize(C.buildInput(note, Object.assign({}, base, { learned: [{ type: 'project', to: 'p2', phrase: '장보기', says: '프로젝트 ‘3분기 리포트’', n: 2 }] }))).output;
  assert.equal(p.note_project_hint, '3분기 리포트');
});

test('#17 배우기를 끄면: 고쳐도 규칙 없음, planLearned 비어 있음, hints 비어 있음', () => {
  const st = setup();
  st.prefs.learning = false;
  teachTask(st, 2);
  assert.equal(st.learned.rules.length, 0);
  const note = submit(st, '장보기');
  assert.deepEqual(P.planLearned(st, note.id, NOW, {}), { kind: null, project: null, dates: [] });
  assert.deepEqual(AD.hints(st, '장보기', NOW, {}), []);
});

test('#18 clearSample 은 샘플 규칙만 지우고, normalize 는 옛 파일에 learned 기본값을 넣으며 규칙을 지킨다', () => {
  const st = setup();
  const sampleNote = M.addNote(st, { body: '장보기', sample: true, capture: { status: 'done', created: [] } }, NOW);
  P.captureSetKind(st, sampleNote.id, 'task', NOW);
  teachTask(st, 1, '우유 사기');
  assert.ok(st.learned.rules.some((r) => r.sample));
  const kept = st.learned.rules.filter((r) => !r.sample).length;
  M.clearSample(st);
  assert.equal(st.learned.rules.length, kept);
  assert.ok(st.learned.rules.every((r) => !r.sample));
  const old = JSON.parse(JSON.stringify(st));
  old.version = 3;
  delete old.learned;
  const n1 = M.normalize(old);
  assert.deepEqual(n1.learned.rules, []);
  const n2 = M.normalize(JSON.parse(JSON.stringify(st)));
  assert.equal(n2.learned.rules.length, kept);
});

test('#19 보내는 요청: 힌트 블록은 있고 프로젝트 id·규칙 id 는 기기 밖으로 나가지 않는다', async () => {
  const saved = {};
  ['DAYNOTE_AI_FAKE', 'DAYNOTE_AI_PROVIDER', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY'].forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  process.env.GEMINI_API_KEY = 'g';
  try {
    delete require.cache[require.resolve('../services/ai')];
    const ai = require('../services/ai');
    const st = M.emptyState();
    const proj = M.addProject(st, { name: 'B2B 영업' }, NOW);
    assert.match(proj.id, /^proj_/);
    for (const text of ['장보기 삼성', '삼성 견적', '삼성 출장']) { const n = submit(st, text); P.captureSetProject(st, n.id, proj.id, NOW); }
    const note = M.addNote(st, { body: '삼성 미팅 장보기', updatedAt: NOW.toISOString() }, NOW);
    const hints = AD.hints(st, note.body, NOW, { projects: M.liveProjects(st) });
    assert.ok(hints.length >= 1);
    let sent = null;
    ai._setClients({ gemini: { interactions: { create: async (req) => {
      sent = req;
      return { status: 'completed', output_text: JSON.stringify({ summary: '', sections: [], tasks: [], events: [], open_questions: [] }) };
    } } } });
    await ai.organize(C.buildInput(note, { today: '2026-10-05 (월)', projects: ['B2B 영업'], openTasks: [], learned: hints }));
    assert.ok(sent);
    assert.match(sent.input, /사용자가 전에 직접 고친 방식/);
    assert.match(sent.input, /프로젝트 ‘B2B 영업’/);
    const all = JSON.stringify(sent);
    assert.equal(all.indexOf('proj_'), -1);
    assert.equal(all.indexOf('lr_'), -1);
  } finally {
    Object.keys(saved).forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
    delete require.cache[require.resolve('../services/ai')];
  }
});
