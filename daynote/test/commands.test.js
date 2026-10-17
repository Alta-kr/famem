'use strict';

// 채팅 명령 — 바로 알아듣는 짧은 명령(matchLocal)과 AI 가 준 명령 검증(resolve)

const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/core/model');
const CMD = require('../src/core/ai/commands');
const C = require('../src/core/ai/capture');

const NOW = new Date(2026, 9, 17, 15, 0);
function setup() {
  const st = M.emptyState();
  const a = M.addTask(st, { title: '견적서 보내기', dueDate: '2026-10-17' }, NOW);
  const b = M.addTask(st, { title: '세미나 장소 후보 알아보기' }, NOW);
  return { st, a, b };
}

test('바로 알아듣는 명령: 추천·휴식·오늘 할 일·화면·찾기', () => {
  const { st } = setup();
  const act = (s) => { const r = CMD.matchLocal(st, s, null); return r && r.action; };
  ['할 일 추천해줘', '할일 추천해줘', '추천해줘', '뭐부터 하지?', '지금 뭐 할까', '다음 할 일 뭐야', '이제 뭐 해야 돼?', '작업 추천 좀'].forEach((s) => assert.strictEqual(act(s), 'recommend', s));
  ['쉬고 싶어', '좀 쉬자', '휴식', '피곤해'].forEach((s) => assert.strictEqual(act(s), 'rest', s));
  ['오늘 할 일 뭐야?', '오늘 할일 알려줘', '오늘 뭐 해야 돼?', '오늘 일정 보여줘'].forEach((s) => assert.strictEqual(act(s), 'list_today', s));
  assert.deepStrictEqual(CMD.matchLocal(st, '캘린더 보여줘', null), { action: 'open', view: 'calendar' });
  assert.deepStrictEqual(CMD.matchLocal(st, '주간 정리 열어줘', null), { action: 'open', view: 'weekly' });
  assert.deepStrictEqual(CMD.matchLocal(st, '회의록 찾아줘', null), { action: 'search', query: '회의록' });
  // 기록·할 일은 명령이 아니다 → AI 로
  ['내일까지 견적서 보내기', '오늘 회의 분위기 좋았음', '다음 주 화요일 3시 치과', '금요일 휴식 시간에 은행 가기'].forEach((s) => assert.strictEqual(CMD.matchLocal(st, s, null), null, s));
});

test('작게 나누기: 이름으로 고르거나, 없으면 작업 공간의 할 일 / 시작·멈춤·완료는 작업 공간 할 일이 있어야', () => {
  const { st, a, b } = setup();
  assert.deepStrictEqual(CMD.matchLocal(st, '견적서 작게 나눠줘', null), { action: 'breakdown', taskId: a.id });
  assert.deepStrictEqual(CMD.matchLocal(st, '이거 쪼개줘', b), { action: 'breakdown', taskId: b.id });
  assert.deepStrictEqual(CMD.matchLocal(st, '시작', b), { action: 'start', taskId: b.id });
  assert.deepStrictEqual(CMD.matchLocal(st, '잠깐 멈춰', b), { action: 'pause', taskId: b.id });
  assert.deepStrictEqual(CMD.matchLocal(st, '완료 처리해줘', b), { action: 'complete', taskId: b.id });
  assert.strictEqual(CMD.matchLocal(st, '시작', null), null);       // 대상이 없으면 AI 로
});

test('AI 명령 검증: 근거가 원문에 있고, 대상은 열린 할 일 (없으면 작업 공간), 이상한 값은 버림', () => {
  const { st, a, b } = setup();
  const note = { title: '', body: '견적서 작업 시작할게. 그리고 캘린더 좀 보자' };
  const ev = (q) => ({ quote: q, line: 1 });
  const out = CMD.resolve(st, note, [
    { action: 'start', target: '견적서 보내기', view: null, query: null, evidence: ev('견적서 작업 시작할게') },
    { action: 'open', target: null, view: 'calendar', query: null, evidence: ev('캘린더 좀 보자') },
    { action: 'open', target: null, view: 'nowhere', query: null, evidence: ev('캘린더 좀 보자') },
    { action: 'delete', target: null, view: null, query: null, evidence: ev('원문에 없는 말') },
    { action: 'hack', target: null, view: null, query: null, evidence: ev('견적서 작업 시작할게') }
  ], b);
  assert.deepStrictEqual(out, [{ action: 'start', taskId: a.id }, { action: 'open', view: 'calendar' }]);
  // 대상 없으면 작업 공간 할 일, 목록에 없는 대상은 missing
  const out2 = CMD.resolve(st, { title: '', body: '이거 일시 정지해줘' }, [{ action: 'pause', target: null, view: null, query: null, evidence: ev('이거 일시 정지해줘') }], b);
  assert.deepStrictEqual(out2, [{ action: 'pause', taskId: b.id }]);
  const out3 = CMD.resolve(st, { title: '', body: '보고서 지워줘' }, [{ action: 'delete', target: '보고서', view: null, query: null, evidence: ev('보고서 지워줘') }], null);
  assert.deepStrictEqual(out3, [{ action: 'delete', missing: '보고서' }]);
});

test('스키마: commands 와 entry_type command 가 있고 프롬프트에 명령 규칙', () => {
  assert.ok(C.SCHEMA.properties.commands);
  assert.ok(C.SCHEMA.required.includes('commands'));
  assert.ok(C.ENTRY_TYPES.includes('command'));
  assert.match(C.SYSTEM, /recommend/);
});
