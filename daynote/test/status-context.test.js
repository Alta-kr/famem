'use strict';
// 현재 상태 — 할 일 맥락 (단어 규칙·우선순위·직접 정하기·배우기) — STATUS §20.3 #67–87
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const D = require('../src/core/dates');
const M = require('../src/core/model');
const SW = require('../src/core/statusWords');
const ST = require('../src/core/status');

// 다른 wave-1 패키지가 아직 합쳐지지 않았으면 그 테스트만 건너뛴다 (IMPLEMENTATION_PLAN §0.9)
const has = (rel) => fs.existsSync(path.join(__dirname, '..', rel));
const AD = has('src/core/adapt.js') ? require('../src/core/adapt') : null;          // W1-adapt
const V4 = require('../src/core/model').SCHEMA_VERSION >= 4;                        // W1-model

const NOW = new Date(2026, 9, 5, 10, 0);
const P0 = ST.profile({});
const rc = (t, pf) => { const r = ST.ruleContext(t, pf || P0); return r ? r.ctx : null; };

function world(prefs) {
  const s = M.emptyState();
  Object.assign(s.prefs, prefs || {});
  if (AD) AD.ensure(s);
  return { s, pf: ST.profile(s.prefs) };
}

// status.js 를 브라우저처럼(window.Daynote) 불러온다 — adapt 대역을 넣거나 빼려고
function loadStatusVm(adapt) {
  const window = { Daynote: { dates: D, model: M, statusWords: SW } };
  if (adapt) window.Daynote.adapt = adapt;
  const ctx = vm.createContext({ window, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/core/status.js'), 'utf8'), ctx);
  return window.Daynote.statusCore;
}

test('#67 단어 규칙: 집안일·업무·밖 볼일·개인·가족·공부', () => {
  const T = {
    home: ['빨래 돌리기', '설거지', '분리수거'],
    work: ['견적서 보내기', '회의록 정리'],
    errand: ['우체국 택배 보내기', '장보기', '우유 사기'],
    personal: ['헬스 등록 알아보기', '카드값 이체'],
    family: ['어린이집 준비물', '엄마 생신 선물 주문'],
    study: ['과제 제출', '인강 듣기']
  };
  Object.keys(T).forEach((ctx) => T[ctx].forEach((title) => assert.equal(rc(title), ctx, title)));
  const r = ST.ruleContext('빨래 돌리기', P0);
  assert.deepEqual([r.ctx, r.score, r.evidence], ['home', 3, '빨래']);
});

test('#68 조사가 붙어도 잡는다', () => {
  assert.equal(rc('빨래를 개기'), 'home');
  assert.equal(rc('보고서를 끝내기'), 'work');
});

test('#69 낱말마다 가장 긴 키워드 하나만 센다', () => {
  assert.equal(rc('빨래방 가기'), 'errand');
  assert.equal(rc('세탁소 맡기기'), 'errand');
  assert.equal(ST.ruleContext('회의록 정리', P0).score, 3);
});

test('#70 제외어로 시작하는 낱말은 건너뛴다', () => {
  assert.equal(rc('청소년 지원사업 보고서'), 'work');
  assert.equal(rc('은행나무 사진 찍기'), null);
  assert.equal(rc('아이디어 정리'), null);
});

test('#71 문턱: 점수 2 미만이면 맥락 없음', () => {
  assert.equal(rc('정리하기'), null);
  assert.equal(rc('메일 확인'), null);
});

test('#72 동점 → 맥락 없음. 그래서 명시한 퇴근에서도 숨지 않는다', () => {
  assert.equal(rc('엄마 선물 사기'), null);
  const { s, pf } = world();
  const t = M.addTask(s, { title: '엄마 선물 사기' }, NOW);
  const at1840 = new Date(2026, 9, 5, 18, 40);
  ST.setStatus(s, { id: 'off' }, { source: 'chip' }, pf, at1840);
  const c = ST.contextOf(s, t, pf, at1840);
  assert.deepEqual([c.value, c.source], [null, null]);
  assert.equal(ST.levelOf(s, t, c, ST.effective(s, pf, at1840), pf, at1840).level, 'normal');
});

test('#73 라틴 키워드는 낱말 전체가 같을 때만', () => {
  assert.equal(rc('PR 리뷰'), 'work');
  assert.notEqual(rc('PRINT 수리'), 'work');
  assert.equal(rc('kpi 정리'), 'work');
});

test('#74 사용자 단어: 맥락에 더한 말은 3점, 끈 기본 단어는 세지 않는다, 사용자 맥락은 그 단어로만', () => {
  const pf = ST.profile({ statusProfile: { contexts: [
    { id: 'home', words: ['식물 물주기'], wordsOff: ['빨래'] },
    { id: 'u_church', custom: true, label: '교회', words: ['예배'] }
  ] } });
  assert.equal(rc('식물 물주기', pf), 'home');
  assert.equal(rc('빨래 돌리기', pf), null);
  assert.equal(rc('설거지', pf), 'home');
  assert.equal(rc('수요 예배', pf), 'u_church');
  assert.equal(ST.contextLabel(pf, 'u_church'), '교회');
});

test('#75 우선순위(학습 제외): 사용자 > 프로젝트 > AI > 단어 규칙 > 약한 힌트', () => {
  const { s, pf } = world();
  const p = M.addProject(s, { id: 'p1', name: '온보딩 개선', context: 'family' }, NOW);
  const C = (fields) => { const t = M.addTask(s, fields, NOW); const c = ST.contextOf(s, t, pf, NOW); return [c.value, c.source]; };
  assert.deepEqual(C({ title: '보고서 쓰기', projectId: p.id, context: 'home', contextSource: 'user' }), ['home', 'user']);
  assert.deepEqual(C({ title: '보고서 쓰기', projectId: p.id, context: 'home', contextSource: 'ai' }), ['family', 'project']);
  assert.equal(ST.contextOf(s, M.byId(s.tasks, s.tasks[0].id), pf, NOW).evidence, '온보딩 개선');
  assert.deepEqual(C({ title: '보고서 쓰기', context: 'home', contextSource: 'ai' }), ['home', 'ai']);
  assert.deepEqual(C({ title: '보고서 쓰기' }), ['work', 'rule']);
  assert.deepEqual(C({ title: '확인 부탁', sources: [{ type: 'email', refId: 'm1', excerpt: '확인 부탁드립니다' }] }), ['work', 'hint']);
  assert.deepEqual(C({ title: '확인 부탁' }), [null, null]);
});

test('#75 우선순위(학습 포함): 프로젝트 > 배운 제목 > AI > 배운 낱말(확실) > 규칙', { skip: !AD && 'W1-adapt 병합 전' }, () => {
  const { s, pf } = world();
  // 배운 제목(정확 일치, 1번이면 참고) — AI 보다 앞
  AD.learn(s, { type: 'context', text: '보고서 쓰기', from: 'work', to: 'home', source: 'correction' }, NOW);
  const a = M.addTask(s, { title: '보고서 쓰기', context: 'study', contextSource: 'ai' }, NOW);
  assert.deepEqual([ST.contextOf(s, a, pf, NOW).value, ST.contextOf(s, a, pf, NOW).source], ['home', 'learned']);
  // 프로젝트는 배운 제목보다 앞
  M.addProject(s, { id: 'p1', name: '집 정리', context: 'family' }, NOW);
  const b = M.addTask(s, { title: '보고서 쓰기', projectId: 'p1' }, NOW);
  assert.equal(ST.contextOf(s, b, pf, NOW).source, 'project');
  // 배운 낱말(2번 · 확실)은 AI 뒤, 규칙 앞
  AD.learn(s, { type: 'context', text: '견적서 보내기', from: 'work', to: 'personal', source: 'correction' }, NOW);
  AD.learn(s, { type: 'context', text: '견적서 수정', from: 'work', to: 'personal', source: 'correction' }, NOW);
  const c = M.addTask(s, { title: '견적서 회신' }, NOW);
  const cr = ST.contextOf(s, c, pf, NOW);
  assert.deepEqual([cr.value, cr.source], ['personal', 'learned']);
  assert.ok(cr.ruleIds.length >= 1);
  const d = M.addTask(s, { title: '견적서 회신 준비', context: 'study', contextSource: 'ai' }, NOW);
  assert.deepEqual([ST.contextOf(s, d, pf, NOW).value, ST.contextOf(s, d, pf, NOW).source], ['study', 'ai']);
});

test('#76 사용자가 정한 "정하지 않음"(context null, source user)은 규칙이 덮지 않는다', () => {
  const { s, pf } = world();
  const t = M.addTask(s, { title: '보고서 쓰기', context: null, contextSource: 'user' }, NOW);
  const c = ST.contextOf(s, t, pf, NOW);
  assert.deepEqual([c.value, c.source], [null, 'user']);
  assert.equal(ST.contextLabel(pf, null), '정하지 않음');
  assert.equal(ST.contextLabel(pf, 'none'), '정하지 않음');
});

test('#77 배운 "none" → { value:null, source:learned } — 규칙보다 앞선다', { skip: !AD && 'W1-adapt 병합 전' }, () => {
  const { s, pf } = world();
  const t = M.addTask(s, { title: '보고서 쓰기' }, NOW);
  ST.setTaskContext(s, t.id, null, pf, NOW);
  const u = M.addTask(s, { title: '보고서 쓰기' }, NOW);
  const c = ST.contextOf(s, u, pf, NOW);
  assert.deepEqual([c.value, c.source], [null, 'learned']);
});

test('#78 메일에서 온 할 일 + 키워드 없음 → 업무(약한 힌트)', () => {
  const { s, pf } = world();
  const t = M.addTask(s, { title: '회신 부탁 건', sources: [{ type: 'email', refId: 'mail_1', excerpt: '회신 부탁' }] }, NOW);
  // '회신'은 업무 중간(2) 단어라 규칙이 먼저 잡는다 — 키워드가 없는 제목으로 본다
  const u = M.addTask(s, { title: '확인 부탁', sources: [{ type: 'email', refId: 'mail_1', excerpt: '확인 부탁' }] }, NOW);
  assert.equal(ST.contextOf(s, t, pf, NOW).source, 'rule');
  assert.deepEqual([ST.contextOf(s, u, pf, NOW).value, ST.contextOf(s, u, pf, NOW).source], ['work', 'hint']);
});

test('#79 지운 사용자 맥락 id 가 저장돼 있으면 건너뛰고 규칙으로', () => {
  const { s, pf } = world();
  const t = M.addTask(s, { title: '빨래 돌리기', context: 'u_gone', contextSource: 'user' }, NOW);
  const c = ST.contextOf(s, t, pf, NOW);
  assert.deepEqual([c.value, c.source], ['home', 'rule']);
  assert.equal(ST.contextLabel(pf, 'u_gone'), '지운 맥락');
});

test('#80 제목이 비면 sources[0].excerpt 로 계산한다', () => {
  const { s, pf } = world();
  const t = M.addTask(s, { title: '', sources: [{ type: 'note', refId: 'n1', excerpt: '- [ ] 빨래 돌리기' }] }, NOW);
  assert.equal(ST.contextOf(s, t, pf, NOW).value, 'home');
});

test('#81 메모: 같은 할 일을 두 번 부르면 같은 객체. 제목·updatedAt·profile 이 바뀌면 다시 계산', () => {
  const { s, pf } = world();
  const t = M.addTask(s, { title: '빨래 돌리기' }, NOW);
  const a = ST.contextOf(s, t, pf, NOW);
  assert.equal(ST.contextOf(s, t, pf, NOW), a);
  M.updateTask(s, t.id, { title: '보고서 쓰기' }, new Date(NOW.getTime() + 60000));
  const b = ST.contextOf(s, t, pf, NOW);
  assert.notEqual(b, a);
  assert.equal(b.value, 'work');
  const pf2 = ST.profile({ statusProfile: { contexts: [{ id: 'work', wordsOff: ['보고서'] }] } });
  assert.equal(ST.contextOf(s, t, pf2, NOW).value, null);
  // 프로젝트 맥락이 바뀌어도 다시 계산한다 (할 일의 updatedAt 은 그대로)
  const p = M.addProject(s, { id: 'p9', name: '집' }, NOW);
  M.updateTask(s, t.id, { projectId: p.id }, new Date(NOW.getTime() + 120000));
  assert.equal(ST.contextOf(s, t, pf, NOW).source, 'rule');
  p.context = 'home';
  assert.equal(ST.contextOf(s, t, pf, NOW).source, 'project');
});

test('#81 메모: 배운 것이 바뀌면 다시 계산한다', { skip: !AD && 'W1-adapt 병합 전' }, () => {
  const { s, pf } = world();
  const t = M.addTask(s, { title: '빨래 돌리기' }, NOW);
  assert.equal(ST.contextOf(s, t, pf, NOW).source, 'rule');
  AD.learn(s, { type: 'context', text: '빨래 돌리기', from: 'home', to: 'family', source: 'correction' }, NOW);
  assert.deepEqual([ST.contextOf(s, t, pf, NOW).value, ST.contextOf(s, t, pf, NOW).source], ['family', 'learned']);
});

test('#82 setTaskContext: contextSource user 로 저장하고 AD.learn 을 { type:context, text:제목, from:이전 계산값, to } 로 부른다 (adapt 대역)', () => {
  const calls = [];
  let suggestion = null;
  const stub = {
    enabled: () => true,
    suggest: () => suggestion,
    phrases: () => [],
    learn: (s, ev) => { calls.push(['learn', ev]); return { added: ['lr_x'], updated: [], damped: [] }; },
    penalize: (s, ids, now, amount) => { calls.push(['penalize', ids, amount]); return []; },
    count: (s, key) => { calls.push(['count', key]); }
  };
  const VST = loadStatusVm(stub);
  const pf = VST.profile({});
  const s = M.emptyState();
  const t = M.addTask(s, { id: 't1', title: '견적서 보내기', sources: [{ type: 'note', refId: 'note_1', excerpt: '견적서 보내기' }] }, NOW);
  const r = VST.setTaskContext(s, 't1', 'home', pf, NOW);
  assert.equal(r.task.context, 'home');
  assert.equal(r.task.contextSource, 'user');
  assert.equal(r.learned, 'none');
  const learn = calls.filter((c) => c[0] === 'learn');
  assert.equal(learn.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(learn[0][1])),
    { type: 'context', text: '견적서 보내기', from: 'work', to: 'home', ref: 'note_1', sample: false, source: 'correction' });
  assert.equal(calls.some((c) => c[0] === 'penalize'), false);
  // 학습으로 정해진 맥락(learned)을 다른 값으로 고치면 벌점 + reverted
  calls.length = 0;
  suggestion = { to: 'personal', level: 'hint', role: 'exact', phrase: '세차', ruleIds: ['lr_a'], confidence: 0.8, support: 1.5, n: 1 };
  const u = M.addTask(s, { id: 't2', title: '세차' }, NOW);
  VST.setTaskContext(s, 't2', 'errand', pf, NOW);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find((c) => c[0] === 'penalize'))), ['penalize', ['lr_a'], 1]);
  assert.ok(calls.some((c) => c[0] === 'count' && c[1] === 'reverted'));
  assert.equal(calls.find((c) => c[0] === 'learn')[1].from, 'personal');
  // '정하지 않음'은 to:'none'
  calls.length = 0;
  suggestion = null;
  VST.setTaskContext(s, 't2', null, pf, NOW);
  assert.equal(u.context, null);
  assert.equal(calls.find((c) => c[0] === 'learn')[1].to, 'none');
  // 모르는 맥락 id 는 거절
  assert.equal(VST.setTaskContext(s, 't2', 'nope', pf, NOW), null);
});

test('#83 학습 문턱(실제 adapt): 같은 제목 1번 → learned, 비슷한 제목은 2번부터(strongNPart 2)', { skip: (!AD || !V4) && 'W1-adapt·W1-model 병합 전' }, () => {
  const { s, pf } = world();
  const a = M.addTask(s, { title: '견적서 보내기' }, NOW);
  const r1 = ST.setTaskContext(s, a.id, 'personal', pf, NOW);
  assert.equal(r1.learned, 'hint');
  const same = M.addTask(s, { title: '견적서 보내기' }, NOW);
  assert.deepEqual([ST.contextOf(s, same, pf, NOW).value, ST.contextOf(s, same, pf, NOW).source], ['personal', 'learned']);
  const other = M.addTask(s, { title: '견적서 회신' }, NOW);
  assert.deepEqual([ST.contextOf(s, other, pf, NOW).value, ST.contextOf(s, other, pf, NOW).source], ['work', 'rule']);
  const b = M.addTask(s, { title: '견적서 수정' }, NOW);
  const r2 = ST.setTaskContext(s, b.id, 'personal', pf, NOW);
  assert.equal(r2.learned, 'strong');
  assert.equal(r2.phrase, '견적서');
  const later = M.addTask(s, { title: '견적서 회신' }, NOW);
  const c = ST.contextOf(s, later, pf, NOW);
  assert.deepEqual([c.value, c.source], ['personal', 'learned']);
});

test('#84 학습으로 정해진 맥락을 다른 값으로 고치면 penalize + count(reverted)', { skip: (!AD || !V4) && 'W1-adapt·W1-model 병합 전' }, () => {
  const { s, pf } = world();
  const a = M.addTask(s, { title: '세차하기' }, NOW);
  ST.setTaskContext(s, a.id, 'personal', pf, NOW);
  const rulesBefore = s.learned.rules.map((r) => ({ id: r.id, w: r.w, to: r.to }));
  const b = M.addTask(s, { title: '세차하기' }, NOW);
  assert.equal(ST.contextOf(s, b, pf, NOW).source, 'learned');
  ST.setTaskContext(s, b.id, 'errand', pf, NOW);
  assert.equal(s.learned.metrics.reverted, 1);
  const personal = s.learned.rules.filter((r) => r.to === 'personal');
  const before = rulesBefore.filter((r) => r.to === 'personal');
  assert.ok(personal.length < before.length || personal.some((r) => r.neg >= 1), '벌점을 받았다');
});

test('#85 prefs.learning === false → 학습 단계 없음, 사용자 값은 저장한다', { skip: !AD && 'W1-adapt 병합 전' }, () => {
  const { s, pf } = world({ learning: false });
  const a = M.addTask(s, { title: '세차하기' }, NOW);
  const r = ST.setTaskContext(s, a.id, 'errand', pf, NOW);
  assert.equal(r.learned, 'none');
  assert.equal(a.context, 'errand');
  assert.equal(a.contextSource, 'user');
  assert.equal(s.learned.rules.length, 0);
  const b = M.addTask(s, { title: '세차하기' }, NOW);
  assert.notEqual(ST.contextOf(s, b, pf, NOW).source, 'learned');
});

test('#86 DN.adapt 가 없어도 setTaskContext·contextOf 가 던지지 않는다', () => {
  const VST = loadStatusVm(null);
  const pf = VST.profile({});
  const s = M.emptyState();
  const t = M.addTask(s, { id: 't1', title: '빨래 돌리기' }, NOW);
  assert.equal(VST.contextOf(s, t, pf, NOW).value, 'home');
  const r = VST.setTaskContext(s, 't1', 'family', pf, NOW);
  assert.equal(r.learned, 'none');
  assert.equal(t.context, 'family');
  assert.equal(VST.contextOf(s, t, pf, NOW).source, 'user');
});

test('#87 (store vm) 맥락 바꾸기 뒤 undo → 맥락과 state.learned 가 함께 되돌아간다', { skip: (!AD || !V4) && 'W1-adapt·W1-model 병합 전' }, () => {
  function loadStore() {
    const mem = {};
    const localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
    const window = { Daynote: { model: M }, addEventListener() {} };
    const ctx = vm.createContext({ window, localStorage, setTimeout() { return 0; }, clearTimeout() {}, console, JSON, Promise, Date });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/store.js'), 'utf8'), ctx);
    return window.Daynote.store;
  }
  const S = loadStore();
  S.mutate('입력 저장', (s) => { M.addTask(s, { id: 't1', title: '세차하기' }, NOW); });
  const rulesBefore = S.state.learned.rules.length;
  S.mutate('맥락 바꾸기', (s) => ST.setTaskContext(s, 't1', 'personal', ST.profile(s.prefs), NOW), { source: 'today' });
  assert.equal(M.byId(S.state.tasks, 't1').context, 'personal');
  assert.ok(S.state.learned.rules.length > rulesBefore);
  assert.equal(S.undo(), '맥락 바꾸기');
  const t = M.byId(S.state.tasks, 't1');
  assert.equal(t.context == null, true);
  assert.notEqual(t.contextSource, 'user');
  assert.equal(S.state.learned.rules.length, rulesBefore);
});

test('#tag: "#집안일 빨래" → 사용자 맥락 home, 태그를 뗀 글. "# 회의록"은 태그가 아니다', () => {
  assert.deepEqual(ST.extractContextTag('#집안일 빨래', P0), { ctx: 'home', tag: '#집안일', text: '빨래' });
  assert.deepEqual(ST.extractContextTag('빨래 #집', P0), { ctx: 'home', tag: '#집', text: '빨래' });
  assert.deepEqual(ST.extractContextTag('견적서 보내기 #업무', P0), { ctx: 'work', tag: '#업무', text: '견적서 보내기' });
  assert.equal(ST.extractContextTag('# 회의록', P0), null);
  assert.equal(ST.extractContextTag('#없는태그 빨래', P0), null);
  const pf = ST.profile({ statusProfile: { contexts: [{ id: 'u_church', custom: true, label: '교회', words: ['예배'] }] } });
  assert.equal(ST.extractContextTag('주보 접기 #교회', pf).ctx, 'u_church');
});

test('contextHintsForAi: 맥락마다 대표 단어 6개를 · 로 잇는다', () => {
  const h = ST.contextHintsForAi(P0);
  assert.deepEqual(h.map((x) => x.id), ['work', 'home', 'errand', 'personal', 'family', 'study']);
  assert.equal(h[0].label, '업무');
  assert.equal(h[0].hint.split('·').length, 6);
  assert.ok(h[1].hint.startsWith('빨래'));
});

test('setTaskAtMode: 사용자 값으로 저장, null = 상관없음, 모르는 값은 거절', () => {
  const s = M.emptyState();
  const t = M.addTask(s, { title: '우유 사기' }, NOW);
  ST.setTaskAtMode(s, t.id, 'out', NOW);
  assert.deepEqual([t.atMode, t.atModeSource], ['out', 'user']);
  ST.setTaskAtMode(s, t.id, null, NOW);
  assert.deepEqual([t.atMode, t.atModeSource], [null, 'user']);
  assert.equal(ST.setTaskAtMode(s, t.id, 'weekend', NOW), null);
  assert.equal(t.atMode, null);
});
