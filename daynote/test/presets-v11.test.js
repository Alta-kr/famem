'use strict';
// 현재 상태 — v1.1 직업 프리셋 켜기 (학생 · 교대 근무 · 자영업 · 육아·살림) — STATUS §12
// 프리셋마다 표 하나(말 → 상태, 시간표 짐작, 정책 칸)를 데이터로 두고 돌린다.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/core/model');
const SW = require('../src/core/statusWords');
const ST = require('../src/core/status');

const at = (d, h, m) => new Date(2026, 9, d, h, m || 0);   // 2026-10-d (5 = 월, 10 = 토)
const MON = (h, m) => at(5, h, m);
const NEW = ['student', 'shift', 'shop', 'home'];

function prefsFor(preset, extra) {
  return { statusProfile: Object.assign({ preset }, extra || {}) };
}
// cur: undefined = 켜기 전 · 'guess' = 시간표대로 · 'id' / ['id', 'overlay'] = 그 순서로 명시
function mk(preset, cur, now, extra) {
  const prefs = prefsFor(preset, extra);
  const s = M.emptyState();
  Object.assign(s.prefs, prefs);
  const pf = ST.profile(s.prefs);
  if (cur === 'guess') ST.toGuess(s, new Date(now.getTime() - 60000), pf);
  else if (cur) {
    const list = [].concat(cur);
    list.forEach((id, i) => ST.setStatus(s, { id }, { source: 'chip' }, pf, new Date(now.getTime() - (list.length - i) * 60000)));
  }
  return { s, pf, ctx: { profile: pf, eff: ST.effective(s, pf, now), current: s.presence.current, now } };
}

test('v1.1 프리셋이 켜졌다: 학생·교대 근무·자영업·육아·살림은 v1, 크리에이터만 준비 중(v2)', () => {
  const list = ST.presetList();
  NEW.forEach((id) => assert.equal(list.find((p) => p.id === id).stage, 'v1', id));
  assert.equal(list.find((p) => p.id === 'creator').stage, 'v2');
  NEW.forEach((id) => {
    const pf = ST.profile(prefsFor(id));
    assert.equal(pf.preset, id);
    assert.ok(pf.menu.length >= 5 && pf.menu.length <= 8, id + ' 메뉴 수');
    pf.menu.forEach((sid) => assert.ok(pf.statuses[sid] && pf.statuses[sid].menu, id + ' 메뉴 ' + sid));
  });
});

// [프리셋, 메뉴 라벨]
const MENUS = [
  ['student', ['수업 중', '공부 중', '공강', '쉬는 시간', '이동 중', '알바 중', '집·자유', '잘 시간']],
  ['shift', ['근무 중', '휴게', '퇴근', '오프', '잘 시간']],
  ['shop', ['오픈 준비', '영업 중', '바쁜 시간', '브레이크', '마감 정리', '영업 끝', '휴무']],
  ['home', ['아이와 함께', '혼자 시간', '아기 낮잠', '장보기·외출', '쉬는 중', '내 시간', '잘 시간']]
];
test('칩 메뉴: 프리셋마다 §12.2 의 상태와 이름', () => {
  MENUS.forEach(([id, labels]) => {
    const pf = ST.profile(prefsFor(id));
    assert.deepEqual(pf.menu.map((sid) => pf.statuses[sid].label), labels, id);
  });
});

// [프리셋, 글, 기대 { id, label?, role?, tier?, minutes? } | null, 지금 상태(cur)]
const DETECT = [
  // 학생
  ['student', '공강', { id: 'free_period', role: 'break', minutes: 60 }],
  ['student', '도서관 도착', { id: 'study', role: 'work_start' }],
  ['student', '공부 시작', { id: 'study' }],
  ['student', '스터디카페 도착', { id: 'study' }],
  ['student', '알바 출근', { id: 'part_time', label: '알바' }],
  ['student', '출근', { id: 'part_time', label: '알바 중' }],
  ['student', '수업 들어감', { id: 'class', minutes: 50 }],
  ['student', '하교', { id: 'off', label: '하교' }],
  ['student', '알바 끝', { id: 'off', label: '알바 끝' }],
  ['student', '등교 중', { id: 'to_work', label: '이동 중' }],
  ['student', '수업 끝', { id: 'study' }, ['study', 'class']],
  ['student', '내일 공강', null],
  // 교대 근무
  ['shift', '데이', { id: 'work', label: '데이' }],
  ['shift', '이브 출근', { id: 'work', label: '이브닝' }],
  ['shift', '이브닝', { id: 'work', label: '이브닝' }],
  ['shift', '오늘 나이트', { id: 'work', label: '나이트' }],
  ['shift', '인계 끝', { id: 'off', role: 'work_end', label: '퇴근' }],
  ['shift', '나이트 끝', { id: 'off' }],
  ['shift', '오프', { id: 'day_off', label: '오프' }],
  ['shift', '비번', { id: 'day_off', label: '오프' }],
  ['shift', '퇴근', { id: 'off', label: '퇴근' }],
  ['shift', '휴게', { id: 'break', label: '휴게' }, 'work'],
  ['shift', '데이터 정리', null],
  // 자영업
  ['shop', '오픈', { id: 'shop_open', label: '영업 중' }],
  ['shop', '가게 오픈', { id: 'shop_open' }],
  ['shop', '문 열었어', { id: 'shop_open' }],
  ['shop', '출근', { id: 'shop_open' }],
  ['shop', '오픈 준비', { id: 'shop_prep', label: '오픈 준비' }],
  ['shop', '브레이크 타임', { id: 'break', label: '브레이크' }],
  ['shop', '마감 정리', { id: 'shop_close' }],
  ['shop', '마감 시작', { id: 'shop_close' }],
  ['shop', '문 닫았어', { id: 'off', label: '영업 끝' }],
  ['shop', '장사 끝', { id: 'off', label: '영업 끝' }],
  ['shop', '정기휴무', { id: 'day_off', label: '휴무' }],
  ['shop', '오늘 휴무', { id: 'day_off', label: '휴무' }],
  ['shop', '바빠', { id: 'busy', minutes: 30 }, 'shop_open'],
  ['shop', '손님 많아', { id: 'busy' }, 'shop_open'],
  ['shop', '손님 없음', { id: null, role: 'idle' }, 'shop_open'],
  ['shop', '한가해', { id: null, role: 'idle' }, 'shop_open'],
  ['shop', '오픈 준비물 사기', null],
  // 육아·살림
  ['home', '등원 완료', { id: 'me', label: '혼자 시간' }],
  ['home', '어린이집 보냄', { id: 'me' }],
  ['home', '하원', { id: 'kids', label: '아이와 함께' }],
  ['home', '애들 왔어', { id: 'kids' }],
  ['home', '아기 낮잠', { id: 'nap', minutes: 60 }, 'kids'],
  ['home', '낮잠 재웠어', { id: 'nap' }, 'kids'],
  ['home', '육퇴', { id: 'off', label: '내 시간' }],
  ['home', '애들 재웠어', { id: 'off', label: '내 시간' }],
  ['home', '하원 시간 확인', null],
  ['home', '애들 하원 시켜야 함', { id: 'kids', tier: 'maybe' }],
  // 다른 프리셋에서는 상태가 아니다 (신호로만 센다)
  ['office', '공강', null],
  ['office', '육퇴', null],
  ['office', '오픈 준비', null],
  ['office', '나이트 출근', null],
  ['student', '오프', null],
  ['shift', '공강', null],
  ['home', '마감했어', null]
];
test('말 → 상태: 프리셋마다 전용 말·공통 말이 그 프리셋의 상태로 (§12.3)', () => {
  DETECT.forEach(([preset, text, want, cur]) => {
    const now = MON(10);
    const { ctx } = mk(preset, cur || 'guess', now);
    const d = ST.detect(text, ctx);
    const tag = preset + ' ' + JSON.stringify(text);
    if (want === null) { assert.equal(d, null, tag + ' → null (' + JSON.stringify(d) + ')'); return; }
    assert.ok(d, tag + ' → 감지되어야 함');
    assert.equal(d.tier, want.tier || 'sure', tag + ' tier');
    Object.keys(want).forEach((k) => { if (k !== 'tier') assert.equal(d[k], want[k], tag + ' ' + k); });
  });
});

// [지금 프리셋, 글, 신호 프리셋]
const SIGNALS = [
  ['office', '공강', 'student'],
  ['office', '도서관 도착', 'student'],
  ['office', '육퇴', 'home'],
  ['office', '하원 완료', 'home'],
  ['office', '오픈 준비', 'shop'],
  ['office', '문 닫았어', 'shop'],
  ['office', '나이트', 'shift'],
  ['student', '비번', 'shift'],
  ['shift', '공강', 'student'],
  ['shop', '공강', 'student'],
  ['home', '오프', 'shift'],
  ['student', '공강', null],
  ['office', '퇴근', null]
];
test('presetSignal: 다른 프리셋의 전용 말은 그 프리셋 신호다', () => {
  SIGNALS.forEach(([preset, text, want]) => {
    assert.equal(ST.presetSignal(text, ST.profile(prefsFor(preset))), want, preset + ' ' + text);
  });
});

test('프리셋 제안: 학생·교대 근무·자영업·육아·살림도 14일 안 3번이면 제안한다 (크리에이터는 아직)', () => {
  NEW.concat(['creator']).forEach((pid) => {
    const { s, pf } = mk('office', undefined, MON(9));
    [1, 2, 3].forEach((h) => ST.notePresetSignal(s, pid, MON(h)));
    assert.equal(ST.presetOfferDue(s, pf, MON(10)), pid === 'creator' ? null : pid, pid);
    if (pid === 'creator') return;
    ST.markPresetOffered(s, pid, MON(10));
    assert.equal(ST.presetOfferDue(s, pf, at(7, 10)), null, pid + ' 평생 1번');
  });
  // 지금 쓰는 프리셋은 제안하지 않는다
  const { s, pf } = mk('shop', undefined, MON(9));
  [1, 2, 3].forEach((h) => ST.notePresetSignal(s, 'shop', MON(h)));
  assert.equal(ST.presetOfferDue(s, pf, MON(10)), null);
});

// 근무 시간 기본값 월–금 09:00–18:00. [프리셋, 시각, 추가 설정, 기대 { id, label, guessed } | 'none']
const GUESS = [
  ['student', MON(8), null, { id: 'off', label: '수업 전' }],
  ['student', MON(10), null, { id: 'study', label: '공부 시간' }],
  ['student', MON(19), null, { id: 'off', label: '수업 끝' }],
  ['student', at(10, 12), null, { id: 'day_off', label: '쉬는 날' }],
  ['shop', MON(8), null, { id: 'off', label: '오픈 전' }],
  ['shop', MON(13), null, { id: 'shop_open', label: '영업 시간' }],
  ['shop', MON(20), null, { id: 'off', label: '영업 끝' }],
  ['shop', at(10, 12), null, { id: 'day_off', label: '휴무' }],
  ['shift', MON(10), null, 'none'],
  ['shift', MON(10), { autoSchedule: { mode: 'guess' } }, 'none'],
  ['home', MON(10), null, 'none'],
  ['home', MON(8), { autoSchedule: { mode: 'guess' } }, { id: 'kids', label: '등원 전' }],
  ['home', MON(10), { autoSchedule: { mode: 'guess' } }, { id: 'me', label: '혼자 시간' }],
  ['home', MON(19), { autoSchedule: { mode: 'guess' } }, { id: 'kids', label: '하원 후' }],
  ['office', MON(10), null, { id: 'work', label: '업무 중' }],
  ['office', MON(8), null, { id: 'off', label: '출근 전' }]
];
test('시간표 짐작: 학생은 수업 시간, 자영업은 영업 시간, 육아·살림은 등원–하원(선택), 교대 근무는 짐작하지 않음', () => {
  GUESS.forEach(([preset, now, extra, want]) => {
    const { s, pf } = mk(preset, 'guess', now, extra);
    const eff = ST.effective(s, pf, now);
    const tag = preset + ' ' + now.toString().slice(0, 21);
    assert.ok(eff.guessed, tag + ' guessed');
    if (want === 'none') { assert.equal(eff.id, 'none', tag); return; }
    assert.equal(eff.id, want.id, tag + ' id');
    assert.equal(eff.label, want.label, tag + ' label');
  });
});

test('설정 화면이 읽는 프로필: 근무 시간 카드 이름 · 교대 근무 잠금 · 근무 끝 줄 · 퇴근 선택이 다루는 맥락', () => {
  const T = [
    ['office', '근무 시간', false, true, ['work']],
    ['freelance', '근무 시간', false, true, ['work']],
    ['student', '수업 시간', false, false, ['work']],
    ['shift', '근무 시간', true, false, ['work']],
    ['shop', '영업 시간', false, true, ['work']],
    ['home', '등원–하원', false, false, ['home', 'family']]
  ];
  T.forEach(([id, label, locked, overtime, afterCtx]) => {
    const pf = ST.profile(prefsFor(id));
    assert.equal(pf.schedule.label, label, id);
    assert.equal(pf.schedule.locked, locked, id + ' locked');
    assert.equal(pf.schedule.overtimeAllowed, overtime, id + ' overtime');
    assert.equal(pf.schedule.overtimeLine, overtime, id + ' overtimeLine');
    assert.deepEqual(pf.afterWorkCtx, afterCtx, id + ' afterWorkCtx');
  });
  // 학생의 '퇴근하면 알바 할 일은' 선택이 집·자유·쉬는 날의 알바 칸을 정한다
  const st = ST.profile(prefsFor('student', { afterWork: 'down' }));
  assert.equal(st.matrix.off.work, 'down');
  assert.equal(st.matrix.day_off.work, 'down');
  assert.equal(st.matrix.off.study, 'normal', '공부는 보통 그대로');
});

// 정책 표: [프리셋, 상태(cur), 할 일 제목, 기대 수준, 기대 맥락]
const POLICY = [
  // 학생: 공부 중 → 공부 띄움 · 알바 숨김 · 그 밖 내림
  ['student', 'study', '중간고사 공부', 'up', 'study'],
  ['student', 'study', '매장 재고 정리', 'hide', 'work'],
  ['student', 'study', '빨래 돌리기', 'down', 'home'],
  // 알바 중 → 알바 띄움 · 공부 내림
  ['student', 'part_time', '매장 재고 정리', 'up', 'work'],
  ['student', 'part_time', '중간고사 공부', 'down', 'study'],
  // 집·자유 → 공부 보통 · 알바 숨김
  ['student', 'off', '중간고사 공부', 'normal', 'study'],
  ['student', 'off', '매장 재고 정리', 'hide', 'work'],
  ['student', 'off', '빨래 돌리기', 'up', 'home'],
  // 공강(덧씌움) → 공부 띄움
  ['student', ['off', 'free_period'], '중간고사 공부', 'up', 'study'],
  ['student', ['part_time', 'free_period'], '중간고사 공부', 'up', 'study'],
  // 교대 근무
  ['shift', 'work', '인수인계 자료', 'up', 'work'],
  ['shift', 'off', '인수인계 자료', 'hide', 'work'],
  ['shift', 'day_off', '은행 가기', 'up', 'errand'],
  ['shift', 'day_off', '인수인계 자료', 'hide', 'work'],
  ['shift', 'sleep', '은행 가기', 'hide', 'errand'],
  // 자영업
  ['shop', 'shop_prep', '마트 장보기', 'up', 'errand'],
  ['shop', 'shop_open', '발주 넣기', 'up', 'work'],
  ['shop', 'shop_open', '배달앱 리뷰 답글', 'up', 'work'],
  ['shop', 'shop_open', '빨래 돌리기', 'down', 'home'],
  ['shop', 'off', '발주 넣기', 'hide', 'work'],
  ['shop', 'day_off', '발주 넣기', 'down', 'work'],
  ['shop', 'day_off', '마트 장보기', 'up', 'errand'],
  // 육아·살림
  ['home', 'kids', '어린이집 준비물 챙기기', 'up', 'family'],
  ['home', 'kids', '빨래 돌리기', 'normal', 'home'],
  ['home', 'kids', '보고서 쓰기', 'normal', 'work'],
  ['home', 'me', '빨래 돌리기', 'up', 'home'],
  ['home', 'me', '마트 장보기', 'up', 'errand'],
  ['home', 'me', '보고서 쓰기', 'normal', 'work'],
  ['home', 'off', '빨래 돌리기', 'down', 'home'],
  ['home', 'off', '요가 가기', 'up', 'personal'],
  ['home', ['kids', 'nap'], '빨래 돌리기', 'up', 'home'],
  ['home', ['kids', 'nap'], '요가 가기', 'up', 'personal']
];
test('정책: 프리셋마다 상태 × 맥락 수준 (§12.2 다른 점)', () => {
  POLICY.forEach(([preset, cur, title, level, ctx]) => {
    const now = MON(10);
    const { s, pf } = mk(preset, cur, now);
    const t = M.addTask(s, { title }, at(5, 9));
    const v = ST.view(s, pf, now);
    const tag = preset + ' ' + JSON.stringify(cur) + ' ' + title;
    assert.equal(v.levels[t.id].ctx, ctx, tag + ' 맥락');
    assert.equal(v.levels[t.id].level, level, tag + ' 수준');
  });
});

test('추천 시간: 아이와 함께·영업 중은 10분, 아기 낮잠은 40분 이하, 바쁜 시간·수업 중은 추천 없음', () => {
  const now = MON(10);
  const T = [
    ['home', 'kids', { rec: 'short', remain: 10, nudges: false }],
    ['home', ['kids', 'nap'], { rec: 'short', remain: 40 }],
    ['home', 'me', { rec: 'normal', remain: null, nudges: true }],
    ['shop', 'shop_open', { rec: 'short', remain: 10, nudges: false }],
    ['shop', ['shop_open', 'busy'], { rec: 'none', remain: null, busy: true }],
    ['shop', 'shop_prep', { rec: 'normal', remain: null }],
    ['student', ['study', 'class'], { rec: 'none', remain: null, busy: true }],
    ['student', ['study', 'free_period'], { rec: 'normal', remain: null }],
    ['shift', 'sleep', { rec: 'none', nudges: false }]
  ];
  T.forEach(([preset, cur, want]) => {
    const { s, pf } = mk(preset, cur, now);
    const v = ST.view(s, pf, now);
    const tag = preset + ' ' + JSON.stringify(cur);
    if ('rec' in want) assert.equal(v.rec, want.rec, tag + ' rec');
    if ('remain' in want) assert.equal(v.remainMinutes, want.remain, tag + ' remain');
    if ('nudges' in want) assert.equal(v.nudges, want.nudges, tag + ' nudges');
    if ('busy' in want) assert.equal(v.busy, want.busy, tag + ' busy');
  });
  // 낮잠이 40분보다 적게 남으면 남은 시간 (09:59 에 60분 낮잠 → 10:50 에 9분)
  const { s, pf } = mk('home', ['kids', 'nap'], now);
  assert.equal(ST.view(s, pf, new Date(now.getTime() + 50 * 60000)).remainMinutes, 9);
});

test('이유 문장: 공강은 덧씌움 이름으로, 교대 근무 평일 오프는 은행·관공서 (주말은 기본 문장)', () => {
  const st = mk('student', ['off', 'free_period'], MON(10));
  const t = M.addTask(st.s, { title: '중간고사 공부' }, MON(9));
  assert.equal(ST.view(st.s, st.pf, MON(10)).levels[t.id].sentence, '지금은 ‘공강’이라 ‘공부’ 일을 먼저 골랐어요.');
  const wd = mk('shift', 'day_off', MON(11));
  const t2 = M.addTask(wd.s, { title: '은행 가기' }, MON(9));
  assert.equal(ST.view(wd.s, wd.pf, MON(11)).levels[t2.id].sentence, '평일 오프라 은행·관공서 가기 좋은 날이에요.');
  const we = mk('shift', 'day_off', at(10, 11));
  const t3 = M.addTask(we.s, { title: '은행 가기' }, at(10, 9));
  assert.equal(ST.view(we.s, we.pf, at(10, 11)).levels[t3.id].sentence, '지금은 ‘오프’라 ‘밖 볼일’ 일을 먼저 골랐어요.');
  // 짐작 상태에서는 프리셋 문장을 쓰지 않는다
  const g = mk('shop', 'guess', MON(13));
  const t4 = M.addTask(g.s, { title: '발주 넣기' }, MON(9));
  assert.equal(ST.view(g.s, g.pf, MON(13)).levels[t4.id].level, 'normal', '짐작 영업 시간은 띄움 → 보통');
});

test('교대 근무: 나이트는 자정을 넘고 16시간 뒤에 낡는다. 근무 끝 줄은 띄우지 않는다', () => {
  const { s, pf } = mk('shift', undefined, MON(22));
  const d = ST.detect('나이트 출근', { profile: pf, eff: null, current: null, now: MON(22) });
  ST.setStatus(s, d, { source: 'text' }, pf, MON(22));
  const e1 = ST.effective(s, pf, at(6, 7));
  assert.equal(e1.id, 'work');
  assert.equal(e1.label, '나이트');
  assert.equal(e1.guessed, false);
  assert.equal(ST.overtimeDue(s, pf, at(6, 7)), false);
  assert.equal(ST.effective(s, pf, at(6, 13, 59)).id, 'work');
  assert.equal(ST.effective(s, pf, at(6, 14, 1)).id, 'none', '낡으면 짐작 없이 모두 보기');
  // 낮에 자는 동안: 알림 없음, 할 일은 숨김
  const w = mk('shift', 'sleep', at(6, 9));
  const v = ST.view(w.s, w.pf, at(6, 15));
  assert.equal(v.id, 'sleep');
  assert.equal(v.nudges, false);
});

test('자영업 맥락 단어: 발주·재고·도매·리뷰 답글·배달앱은 업무 강(3)', () => {
  const shop = ST.profile(prefsFor('shop'));
  const office = ST.profile({});
  [['도매 주문', 'work'], ['배달앱 정산', 'work'], ['재고 확인', 'work'], ['리뷰 답글 달기', 'work']].forEach(([title, ctx]) => {
    const r = ST.ruleContext(title, shop);
    assert.ok(r, title);
    assert.equal(r.ctx, ctx, title);
    assert.ok(r.score >= 3, title + ' 강');
  });
  assert.equal(ST.ruleContext('도매 주문', office), null, '직장인에서는 모르는 말');
  assert.equal(ST.ruleContext('재고 확인', office).score, 2, '직장인에서는 중(2)');
  // 끈 단어는 프리셋이 다시 켜지 않는다
  const off = ST.profile(prefsFor('shop', { contexts: [{ id: 'work', wordsOff: ['도매'] }] }));
  assert.equal(ST.ruleContext('도매 주문', off), null);
  assert.equal(shop.contexts.work.label, '가게 일');
});

test('걸어 둔 상태: 프리셋 상태도 범주로 맞춘다 (출근하면 → 알바 중·영업 중, 쉬는 시간에 → 공강·낮잠)', () => {
  const T = [
    ['student', 'part_time', 'work', true],
    ['student', 'study', 'work', false],
    ['shop', 'shop_open', 'work', true],
    ['home', 'me', 'off', true],
    ['home', 'kids', 'work', false],
    ['office', 'off', 'work', false]
  ];
  T.forEach(([preset, sid, mode, want]) => {
    assert.equal(ST.atModeMatches(mode, sid, ST.profile(prefsFor(preset))), want, preset + ' ' + sid + ' ' + mode);
  });
  [['student', ['off', 'free_period']], ['home', ['kids', 'nap']]].forEach(([preset, cur]) => {
    const { s, pf } = mk(preset, cur, MON(10));
    const t = M.addTask(s, { title: '쉬는 시간에 영양제 주문' }, MON(9));
    M.updateTask(s, t.id, { atMode: 'pause', atModeSource: 'user' }, MON(9));
    assert.deepEqual(ST.view(s, pf, MON(10)).anchored, [t.id], preset);
  });
});

test('프리셋 바꾸기: 지금 상태 id 가 새 프리셋에 없으면 낡은 것으로 보고 짐작으로 (영업 중 → 학생)', () => {
  const { s } = mk('shop', 'shop_open', MON(10));
  s.prefs.statusProfile.preset = 'student';
  const pf = ST.profile(s.prefs);
  const eff = ST.effective(s, pf, MON(10, 5));
  assert.equal(eff.guessed, true);
  assert.equal(eff.id, 'study');
});

test('무결성: 새 프리셋 필드(overlayMatrix · notes · contextWords · schedule)가 유효하다', () => {
  SW.PRESET_ORDER.forEach((id) => {
    const P = SW.PRESETS[id];
    const pf = ST.profile(prefsFor(id));
    Object.keys(P.overlayMatrix || {}).forEach((oid) => {
      assert.ok(pf.statuses[oid] && pf.statuses[oid].overlay, id + ' 덧씌움 ' + oid);
      Object.keys(P.overlayMatrix[oid]).forEach((c) => {
        assert.ok(pf.contexts[c], id + ' 덧씌움 칸 ' + c);
        assert.ok(SW.LEVELS.includes(P.overlayMatrix[oid][c]), id + ' 값');
        assert.equal(pf.overlayMatrix[oid][c], P.overlayMatrix[oid][c]);
      });
    });
    Object.keys(P.notes || {}).forEach((sid) => {
      assert.ok(pf.statuses[sid], id + ' notes ' + sid);
      Object.keys(P.notes[sid]).forEach((c) => assert.ok(pf.contexts[c] && P.notes[sid][c].text, id + ' notes 칸 ' + c));
    });
    Object.keys(P.contextWords || {}).forEach((c) => assert.ok(pf.contexts[c], id + ' contextWords ' + c));
    const sc = P.schedule || {};
    if (sc.work) assert.ok(pf.statuses[sc.work] && !pf.statuses[sc.work].overlay, id + ' schedule.work');
    if (sc.rest) assert.ok(pf.statuses[sc.rest] && !pf.statuses[sc.rest].overlay, id + ' schedule.rest');
    (P.afterWorkCtx || []).forEach((c) => assert.ok(pf.contexts[c], id + ' afterWorkCtx ' + c));
    pf.statusIds.forEach((sid) => {
      const d = pf.statuses[sid];
      if (d.recMax != null) assert.ok(d.recMax > 0 && d.rec !== 'none', id + ' recMax ' + sid);
    });
  });
});
