'use strict';

// 준비할 일 — 그 일을 하기 전에 틈틈이 해 둘 세부 할 일. 할 일 날이 멀어도 남는 시간에 먼저 추천된다.

const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/core/model');
const ST = require('../src/core/steps');
const R = require('../src/core/recommend');
const A = require('../src/core/ai/assist');
const CMD = require('../src/core/ai/commands');
const V = require('../src/core/ai/validate');
const P = require('../src/core/ai/proposals');
const C = require('../src/core/ai/capture');
const fake = require('../src/core/ai/fake');
const MD = require('../src/core/mdexport');

const NOW = new Date(2026, 9, 21, 10, 0);   // 수요일 오전 10시
const NL = String.fromCharCode(10);
const titleOf = (st, i) => (i.prep ? '[준비] ' + i.step.title : M.byId(st.tasks, i.taskId).title);

function workshop(st, extra) {
  const t = M.addTask(st, Object.assign({ title: '워크숍 발표', planDate: '2026-10-30' }, extra || {}), NOW);
  let steps = ST.add([], null, '준비: 자료 조사');
  steps = ST.add(steps, null, '템플릿 받기', 15, { prep: true });
  steps = ST.add(steps, null, '발표하기');
  t.steps = steps;
  return t;
}

test('적을 때: 준비: 앞붙이기 · [준비] · 목록의 준비 머리 줄 아래 항목', () => {
  assert.deepStrictEqual(ST.parsePrep('준비: 자료 조사'), { prep: true, title: '자료 조사' });
  assert.deepStrictEqual(ST.parsePrep('[준비] 장소 확인'), { prep: true, title: '장소 확인' });
  assert.deepStrictEqual(ST.parsePrep('준비 운동하기'), { prep: false, title: '준비 운동하기' });
  assert.ok(ST.isPrepHead('준비할 것:') && ST.isPrepHead('미리 할 일') && ST.isPrepHead('준비물') && ST.isPrepHead('그 전에'));
  assert.ok(!ST.isPrepHead('준비 운동'));
  const t = ST.taskFromText(['워크숍 발표', ' - 준비할 것', '   - 자료 조사', '   - 템플릿 받기', ' - 리허설'].join(NL));
  // 머리 줄('준비할 것')은 단계로 남지 않고, 그 아래 항목이 준비
  assert.deepStrictEqual(t.steps.filter((s) => s.prep).map((s) => s.title), ['자료 조사', '템플릿 받기']);
  assert.ok(!t.steps.some((s) => s.title.indexOf('준비할') !== -1));
});

test('준비 표시 켜기·끄기, 위 단계에 붙이면 아래 단계도 준비', () => {
  let s = ST.add([], null, '자료');
  s = ST.add(s, s[0].id, '논문 찾기');
  s = ST.add(s, s[0].id, '통계 찾기');
  assert.strictEqual(ST.prepLeaves(s).length, 0);
  s = ST.setPrep(s, s[0].id, true);
  assert.deepStrictEqual(ST.prepLeaves(s).map((x) => x.step.title), ['논문 찾기', '통계 찾기']);
  assert.ok(ST.isPrep(s, s[0].steps[1].id));
  s = ST.toggle(s, s[0].steps[0].id);
  assert.deepStrictEqual(ST.prepLeaves(s).map((x) => x.step.title), ['통계 찾기'], '끝낸 준비는 빠진다');
  s = ST.setPrep(s, s[0].id, false);
  assert.strictEqual(ST.prepLeaves(s).length, 0);
});

test('추천: 앞날 할 일의 준비가 후보가 된다 — 오늘 마감·밀린 일 바로 다음, 다른 할 일보다 앞', () => {
  const st = M.emptyState();
  workshop(st);
  M.addTask(st, { title: '메일 보내기', estimateMinutes: 10 }, NOW);
  M.addTask(st, { title: '견적서', dueDate: '2026-10-21' }, NOW);
  const r = R.recommend(st, { now: NOW });
  assert.deepStrictEqual(r.ranked.map((i) => titleOf(st, i)), ['견적서', '[준비] 자료 조사', '[준비] 템플릿 받기', '메일 보내기']);
  assert.strictEqual(r.excluded.planned, 1, '할 일 자체(워크숍 발표)는 그날까지 추천하지 않는다');
  const p = r.ranked[1];
  assert.strictEqual(p.prepBy, '2026-10-30');
  assert.ok(p.reasons[0].indexOf('‘워크숍 발표’ 전에 미리 해 둘 준비') === 0);
  assert.ok(p.reasons.some((x) => x.indexOf('9일 남았습니다') !== -1));
  assert.strictEqual(r.prep.length, 2);
});

test('추천: 남는 시간 안에 드는 준비만, 넘기기는 그 준비 하나만', () => {
  const st = M.emptyState();
  const t = workshop(st);
  let r = R.recommend(st, { now: NOW, availableMinutes: 20 });
  // 템플릿 받기(15분)는 들어가고, 자료 조사(시간 미정)는 그 뒤
  assert.deepStrictEqual(r.prep.map((i) => i.step.title), ['템플릿 받기', '자료 조사']);
  assert.strictEqual(r.primary.fit, 'fits');
  r = R.recommend(st, { now: NOW, availableMinutes: 10 });
  assert.deepStrictEqual(r.prep.map((i) => i.step.title), ['자료 조사']);
  assert.ok(r.tooLong.some((i) => i.prep && i.step.title === '템플릿 받기'));
  r = R.recommend(st, { now: NOW, skipIds: [r.primary.key] });
  assert.strictEqual(r.primary.step.title, '템플릿 받기', '넘긴 준비만 빠진다');
  r = R.recommend(st, { now: NOW, skipIds: [t.id] });
  assert.strictEqual(r.primary, null, '할 일 id 로 넘기면 그 일의 준비도 모두');
});

test('추천: 끝냄·미루기·진행 중인 할 일의 준비는 빼고, 대기·선행 업무가 있어도 준비는 된다', () => {
  const st = M.emptyState();
  const t = workshop(st);
  t.status = 'waiting';
  assert.strictEqual(R.recommend(st, { now: NOW }).prep.length, 2);
  t.status = 'in_progress';
  assert.strictEqual(R.recommend(st, { now: NOW }).prep.length, 0);
  t.status = 'todo'; t.snoozedUntil = new Date(2026, 9, 22).toISOString();
  assert.strictEqual(R.recommend(st, { now: NOW }).prep.length, 0);
  t.snoozedUntil = null; t.status = 'done';
  assert.strictEqual(R.recommend(st, { now: NOW }).prep.length, 0);
});

test('추천: 날이 가까운 일의 준비 먼저, 준비가 바뀌면 지문도 바뀐다', () => {
  const st = M.emptyState();
  workshop(st);
  const soon = M.addTask(st, { title: '고객 미팅', dueDate: '2026-10-23' }, NOW);
  soon.steps = ST.add([], null, '준비: 질문 목록');
  const r = R.recommend(st, { now: NOW });
  assert.strictEqual(r.prep[0].step.title, '질문 목록');
  const before = R.signature(st);
  soon.steps = ST.setPrep(soon.steps, soon.steps[0].id, false);
  assert.notStrictEqual(R.signature(st), before);
});

test('자동 제안: 준비할 일이 있으면 먼저, 나눠 둔 단계와 번갈아', () => {
  const st = M.emptyState();
  workshop(st);
  const big = M.addTask(st, { title: '분기 보고서' }, NOW);
  big.breakdown = { status: 'pending', steps: [{ title: '목차', minutes: 10 }, { title: '초안', minutes: 60 }], createdAt: NOW.toISOString() };
  const n = A.nextNudge(st, { now: NOW, reason: 'idle' });
  assert.strictEqual(n.type, 'prep');
  assert.strictEqual(A.nextNudge(st, { now: NOW, reason: 'idle', lastNudgeType: 'prep' }).type, 'breakdown');
  // 방금 채팅에 띄운 준비는 또 권하지 않는다
  const keys = R.recommend(st, { now: NOW }).prep.map((i) => i.key);
  assert.strictEqual(A.nextNudge(st, { now: NOW, reason: 'idle', shownPrep: keys }).type, 'breakdown');
});

test('채팅: "30분 남았어" 같은 말은 남는 시간으로 추천', () => {
  const st = M.emptyState();
  const m = (t) => CMD.matchLocal(st, t, null);
  assert.deepStrictEqual(m('30분 남았어'), { action: 'recommend', free: true, minutes: 30 });
  assert.deepStrictEqual(m('한 시간 비는데'), { action: 'recommend', free: true, minutes: 60 });
  assert.deepStrictEqual(m('1시간 반 정도 여유 있어'), { action: 'recommend', free: true, minutes: 90 });
  assert.deepStrictEqual(m('시간 좀 남네'), { action: 'recommend', free: true, minutes: null });
  assert.deepStrictEqual(m('회의까지 40분 남았네'), { action: 'recommend', free: true, minutes: 40 });
  assert.strictEqual(m('마감 30분 남았어'), null);
  assert.strictEqual(m('여유 있게 보고서 쓰기'), null);
  assert.strictEqual(m('2시간 뒤에 회의'), null);
});

test('빠른 입력: "그 전에 …" 로 적은 준비는 따로 할 일이 아니라 준비 세부 할 일로', () => {
  const st = M.emptyState();
  const note = M.addNote(st, { title: '', body: '다음 주 금요일 워크숍 발표. 그 전에 자료 조사랑 슬라이드 템플릿 받아 두기', capture: { status: 'pending', at: NOW.toISOString() } }, NOW);
  note.updatedAt = NOW.toISOString();
  const input = C.buildInput(note, { today: '2026-10-21 (수)', projects: [], openTasks: [] });
  const out = fake.organize(input).output;
  // AI 가 준비할 일을 따로 할 일로도 만들었다고 해도 빠진다 · 글에 없는 준비는 버린다
  out.tasks.push({ title: '자료 조사', evidence: { quote: '자료 조사', line: 1 }, due: { text: null, date: null, time: null }, project_hint: null, basis: 'explicit',
    size: 'small', breakdown: [], do_at: { text: null, date: null, time: null }, typical_minutes: null, prep_steps: [] });
  out.tasks[0].prep_steps = out.tasks[0].prep_steps.concat('케이터링 주문');
  const run = P.startRun(st, { noteId: note.id, kind: 'capture', promptVersion: C.PROMPT_VERSION }, NOW);
  const v = V.validateOrganizeNote(out, { note, state: st, now: NOW });
  assert.ok(v.ok, v.errors.join());
  P.applyCapture(st, { note, run, validated: v, output: out }, NOW);
  const live = M.liveTasks(st);
  assert.deepStrictEqual(live.map((t) => t.title), ['워크숍 발표']);
  assert.deepStrictEqual(live[0].steps.map((s) => [s.title, !!s.prep]), [['자료 조사', true], ['슬라이드 템플릿 받기', true]]);
  assert.strictEqual(live[0].dueDate, '2026-10-30');
});

test('마크다운: 준비 세부 할 일은 (준비) 로', () => {
  const st = M.emptyState();
  workshop(st);
  const files = MD.layout(st, NOW);
  const k = Object.keys(files).find((p) => /할 일\.md$/.test(p));
  assert.ok(files[k].content.indexOf('- [ ] (준비) 자료 조사') !== -1);
});
