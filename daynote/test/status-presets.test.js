'use strict';
// 현재 상태 — 직업 프리셋·프리셋 제안·잔소리 예산·근무 끝 줄 (STATUS §20.8 #145–149)
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/core/model');
const SW = require('../src/core/statusWords');
const ST = require('../src/core/status');

const at = (d, h, m) => new Date(2026, 9, d, h, m || 0);   // 10월 d일 — 5 월
const tight = (w) => w.replace(/\s+/g, '').toLowerCase();

function world(prefs) {
  const s = M.emptyState();
  Object.assign(s.prefs, prefs || {});
  return { s, pf: ST.profile(s.prefs) };
}

test('#145 PRESETS 무결성: 메뉴 id 정의 · 정책표가 모든 맥락을 덮음 · roleMap 유효 · 프리셋 전용 말은 공통 사전과 겹치지 않음', () => {
  const common = {};
  SW.PHRASES.forEach((g) => ['sure', 'tail', 'maybe', 'special'].forEach((k) => (g[k] || []).forEach((w) => { common[tight(w)] = true; })));
  assert.deepEqual(Object.keys(SW.PRESETS).sort(), SW.PRESET_ORDER.slice().sort());
  SW.PRESET_ORDER.forEach((id) => {
    const P = SW.PRESETS[id];
    assert.ok(P.label && P.desc && ['v1', 'v1.1', 'v2'].includes(P.stage), id);
    const pf = ST.profile({ statusProfile: { preset: id } });
    assert.equal(pf.preset, id);
    assert.ok(pf.menu.length >= 5 && pf.menu.length <= 8, id + ' 메뉴 수');
    P.menu.forEach((sid) => assert.ok(pf.statuses[sid], id + ' 메뉴 ' + sid));
    pf.statusIds.forEach((sid) => {
      if (pf.statuses[sid].overlay) return;
      pf.contextIds.concat(['_none']).forEach((c) => assert.ok(SW.LEVELS.includes(pf.matrix[sid][c]), id + ' ' + sid + '×' + c));
    });
    Object.keys(P.matrix || {}).forEach((sid) => {
      assert.ok(pf.statuses[sid] && !pf.statuses[sid].overlay, id + ' 정책표 행 ' + sid);
      Object.keys(P.matrix[sid]).forEach((c) => {
        assert.ok(pf.contextIds.includes(c) || c === '_none', id + ' 정책표 열 ' + c);
        assert.ok(SW.LEVELS.includes(P.matrix[sid][c]) || P.matrix[sid][c] === 'after', id + ' 값');
      });
    });
    Object.keys(P.roleMap || {}).forEach((role) => {
      assert.ok(SW.ROLES.includes(role), id + ' 역할 ' + role);
      assert.ok(pf.statuses[P.roleMap[role]], id + ' roleMap → ' + P.roleMap[role]);
    });
    (SW.PRESET_WORDS[id] || []).forEach((g) => {
      assert.ok(SW.ROLES.includes(g.role), id + ' 말의 역할 ' + g.role);
      if (g.id) assert.ok(pf.statuses[g.id], id + ' 말의 상태 ' + g.id);
      ['sure', 'tail', 'maybe', 'special'].forEach((k) => (g[k] || []).forEach((w) => assert.equal(common[tight(w)], undefined, id + ' 전용 말이 공통 사전과 겹침: ' + w)));
    });
    pf.primary.forEach((c) => assert.ok(pf.contexts[c], id + ' 주 맥락 ' + c));
  });
  // 공통 상태 사전도 정의돼 있다
  SW.PHRASES.forEach((g) => assert.ok(SW.ROLES.includes(g.role), g.role));
  SW.STATUS_ORDER.forEach((id) => assert.ok(SW.CATEGORIES.includes(SW.STATUSES[id].category), id));
  // v1 은 직장인·프리랜서만
  assert.deepEqual(ST.presetList().filter((p) => p.stage === 'v1').map((p) => p.id), ['office', 'freelance']);
  assert.deepEqual(Object.keys(ST.presetList()[0]).sort(), ['desc', 'id', 'label', 'stage']);
});

test('#145 v1.1 프리셋 데이터: 학생 공부 중은 공부 띄움·알바 숨김, 자영업 휴무는 가게 일 내림, 교대 근무 라벨', () => {
  const st = ST.profile({ statusProfile: { preset: 'student' } });
  assert.equal(st.contexts.work.label, '알바');
  assert.equal(st.matrix.study.study, 'up');
  assert.equal(st.matrix.study.work, 'hide');
  assert.equal(st.matrix.off.study, 'normal');
  assert.equal(st.matrix.off.work, 'hide');
  const shop = ST.profile({ statusProfile: { preset: 'shop' } });
  assert.equal(shop.matrix.day_off.work, 'down');
  assert.equal(shop.matrix.shop_prep.errand, 'up');
  assert.equal(shop.statuses.busy.overlay, true);
  const shift = ST.profile({ statusProfile: { preset: 'shift' } });
  assert.equal(shift.statuses.work.label, '근무 중');
  assert.equal(shift.schedule.mode, 'off');
});

test('#146 guessPreset: 과제·시험·강의 → 학생, 등원·하원 → 육아·살림, 신호가 부족하면 null', () => {
  const now = at(5, 10);
  const mk = (titles) => { const s = M.emptyState(); titles.forEach((title) => M.addTask(s, { title }, now)); return s; };
  assert.equal(ST.guessPreset(mk(['과제 제출', '중간고사 준비', '강의 복습', '레포트 쓰기'])), 'student');
  assert.equal(ST.guessPreset(mk(['등원 준비물', '하원 픽업', '어린이집 알림장 확인', '이유식 만들기'])), 'home');
  assert.equal(ST.guessPreset(mk(['과제 제출', '보고서 쓰기'])), null);
  assert.equal(ST.guessPreset(mk(['클라이언트 미팅', '견적 보내기', '인보이스 발행'])), 'freelance');
  assert.equal(ST.guessPreset(mk(['클라이언트 미팅', '견적 보내기', '인보이스 발행', '팀장 보고'])), null, '회사·팀장 단어가 있으면 프리랜서가 아니다');
  assert.equal(ST.guessPreset(mk(['데이터 정리', '데이터 백업', '데이터 이관'])), null, '데이터 ≠ 데이');
  // 메모 제목도 센다
  const s = M.emptyState();
  ['발주 넣기', '재고 확인'].forEach((title) => M.addTask(s, { title }, now));
  M.addNote(s, { title: '매장 손님 응대 메모', body: '' }, now);
  assert.equal(ST.guessPreset(s), 'shop');
});

test('#147 프리셋 제안: 14일 안 3번이면 제안. 프리셋마다 평생 1번. 켤 때 guessPreset 이 씨앗(1번). 15일 전 신호는 버린다', () => {
  const { s, pf } = world();
  ST.notePresetSignal(s, 'freelance', at(1, 10));
  ST.notePresetSignal(s, 'freelance', at(3, 10));
  assert.equal(ST.presetOfferDue(s, pf, at(5, 10)), null);
  ST.notePresetSignal(s, 'freelance', at(5, 10));
  assert.equal(ST.presetOfferDue(s, pf, at(5, 10)), 'freelance');
  ST.markPresetOffered(s, 'freelance', at(5, 10));
  assert.equal(s.presence.hints.presetOffered.freelance, at(5, 10).toISOString());
  ['freelance', 'freelance', 'freelance'].forEach((p, i) => ST.notePresetSignal(s, p, at(20, 10 + i)));
  assert.equal(ST.presetOfferDue(s, pf, at(20, 15)), null, '평생 1번');
  // 15일 전 신호는 버린다
  const w = world();
  ST.notePresetSignal(w.s, 'freelance', at(1, 9));
  ST.notePresetSignal(w.s, 'freelance', at(14, 10));
  ST.notePresetSignal(w.s, 'freelance', at(16, 10));
  assert.equal(w.s.presence.hints.presetSeen.freelance.length, 2);
  assert.equal(ST.presetOfferDue(w.s, w.pf, at(16, 10)), null);
  // v1.1 프리셋(학생)은 세어 두기만 하고 아직 제안하지 않는다
  const x = world();
  [1, 2, 3].forEach((h) => ST.notePresetSignal(x.s, 'student', at(5, h)));
  assert.equal(x.s.presence.hints.presetSeen.student.length, 3);
  assert.equal(ST.presetOfferDue(x.s, x.pf, at(5, 10)), null);
  // 씨앗: 처음 켜는 순간 guessPreset 결과를 1번 센다
  const y = world();
  ['클라이언트 미팅', '견적 보내기', '인보이스 발행'].forEach((title) => M.addTask(y.s, { title }, at(5, 9)));
  ST.setStatus(y.s, { id: 'work' }, { source: 'text' }, y.pf, at(5, 9, 30));
  assert.deepEqual(y.s.presence.hints.presetSeen.freelance, [at(5, 9, 30).toISOString()]);
  ST.setStatus(y.s, { id: 'off' }, { source: 'text' }, y.pf, at(5, 18));
  assert.equal(y.s.presence.hints.presetSeen.freelance.length, 1, '처음 켤 때만');
});

test('#148 잔소리 예산: 하루 1번, 하루 시작(04:00)이 지나면 다시 1번. 근무 끝 줄을 2번 닫으면 다시 띄우지 않는다', () => {
  const { s, pf } = world();
  assert.equal(ST.budgetOk(s, pf, at(5, 10)), true);
  ST.useBudget(s, pf, at(5, 10));
  assert.equal(ST.budgetOk(s, pf, at(5, 23)), false);
  assert.equal(ST.budgetOk(s, pf, at(6, 3, 59)), false, '04:00 전은 같은 하루');
  assert.equal(ST.budgetOk(s, pf, at(6, 4)), true);
  ST.useBudget(s, pf, at(6, 4));
  assert.equal(s.presence.hints.day, '2026-10-06');
  assert.equal(s.presence.hints.used, 1);
  // STATUS §13 의 (state, now) 꼴로 불러도 같다 (계획 §3.6 은 (state, profile, now))
  assert.equal(ST.budgetOk(s, at(6, 10)), false);
  assert.equal(ST.budgetOk(s, at(7, 10)), true);
  ST.useBudget(s, at(7, 10));
  assert.equal(ST.budgetOk(s, at(7, 11)), false);
  assert.equal(s.presence.hints.day, '2026-10-07');
  // 근무 끝 줄: 닫으면 그날 끝, 2번 닫으면 영영 끝
  const w = world();
  ST.setStatus(w.s, { id: 'work' }, { source: 'text' }, w.pf, at(5, 9));
  assert.equal(ST.overtimeDue(w.s, w.pf, at(5, 19, 30)), true);
  ST.dismissOvertime(w.s, w.pf, at(5, 19, 30));
  assert.equal(ST.overtimeDue(w.s, w.pf, at(5, 20)), false);
  ST.setStatus(w.s, { id: 'work' }, { source: 'text' }, w.pf, at(6, 9));
  assert.equal(ST.overtimeDue(w.s, w.pf, at(6, 19, 30)), true);
  ST.dismissOvertime(w.s, w.pf, at(6, 19, 30));
  ST.setStatus(w.s, { id: 'work' }, { source: 'text' }, w.pf, at(7, 9));
  assert.equal(ST.overtimeDue(w.s, w.pf, at(7, 19, 30)), false);
  assert.equal(w.s.presence.hints.overtimeDismiss, 2);
});

test('#149 근무 끝 줄 조건: 명시 업무 + 근무 끝 + 90분 → 참, 89분 → 거짓, 짐작 업무 → 거짓, overtimeLine:false → 거짓', () => {
  const { s, pf } = world();
  ST.setStatus(s, { id: 'work' }, { source: 'text' }, pf, at(5, 9));
  assert.equal(ST.overtimeDue(s, pf, at(5, 19, 30)), true);
  assert.equal(ST.overtimeDue(s, pf, at(5, 19, 29)), false);
  const g = world();
  ST.toGuess(g.s, at(5, 9), g.pf);
  assert.equal(ST.overtimeDue(g.s, g.pf, at(5, 10)), false);
  assert.equal(ST.overtimeDue(g.s, g.pf, at(5, 19, 30)), false);
  const o = world({ statusProfile: { autoSchedule: { overtimeLine: false } } });
  ST.setStatus(o.s, { id: 'work' }, { source: 'text' }, o.pf, at(5, 9));
  assert.equal(ST.overtimeDue(o.s, o.pf, at(5, 19, 30)), false);
  // 덧씌움 중·근무 끝 뒤에 시작한 근무(야간 출근)에는 띄우지 않는다
  ST.setStatus(s, { id: 'meeting' }, { source: 'menu' }, pf, at(5, 19, 40));
  assert.equal(ST.overtimeDue(s, pf, at(5, 19, 50)), false);
  const n = world();
  ST.setStatus(n.s, { id: 'work' }, { source: 'text' }, n.pf, at(5, 22));
  assert.equal(ST.overtimeDue(n.s, n.pf, at(5, 23)), false);
});
