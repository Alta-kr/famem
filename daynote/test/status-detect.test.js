'use strict';
// 현재 상태 — 말로 바꾸기 감지 (ST.detect · parseStatusArgs · extractAtMode · findAtMode · onPhone) — STATUS §20.1 #1–38
// 감지 테스트는 표 하나(ROWS)를 데이터로 두고 돌린다.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/core/model');
const ST = require('../src/core/status');

const MON = (h, m) => new Date(2026, 9, 5, h, m || 0);           // 2026-10-05 (월)
const NOW = MON(10, 0);

// cur: undefined = 기능 켜기 전(eff null) · 'guess' = 켰지만 시간표 짐작 · 'off' / ['work','break'] = 그 순서로 명시
function mk(cur, now, prefs) {
  const pf = ST.profile(prefs || {});
  const s = M.emptyState();
  Object.assign(s.prefs, prefs || {});
  if (cur === 'guess') ST.toGuess(s, new Date(now.getTime() - 60000), pf);
  else if (cur) {
    const list = [].concat(cur);
    list.forEach((id, i) => ST.setStatus(s, { id }, { source: 'chip' }, pf, new Date(now.getTime() - (list.length - i) * 60000)));
  }
  return { s, pf, ctx: { profile: pf, eff: ST.effective(s, pf, now), current: s.presence.current, now } };
}

const SURE = (id, extra) => Object.assign({ tier: 'sure', id }, extra || {});
const MAYBE = (id, extra) => Object.assign({ tier: 'maybe', id }, extra || {});
const OFFICE_USER = { statusProfile: { statuses: [
  { id: 'off', words: ['집 감'], wordsOff: ['칼퇴'] },
  { id: 'u_gym', custom: true, label: '운동 중', category: 'overlay', minutes: 60, rec: 'none', words: ['헬스장 도착'], menu: true }
] } };

// [#, 글, 기대(null = 상태 아님), 옵션 { cur, now, prefs }]
const ROWS = [
  ['1', '출근', SURE('work', { role: 'work_start', pure: true })],
  ['1', '출근했어', SURE('work', { pure: true })],
  ['1', '출근 완료!', SURE('work', { pure: true })],
  ['1', 'ㅊㄱ', SURE('work', { pure: true })],
  ['1', '회사 도착', SURE('work', { pure: true })],
  ['1', '이제 출근함ㅋㅋ', SURE('work', { pure: true })],
  ['2', '퇴근', SURE('off', { role: 'work_end', pure: true, label: '퇴근 · 내 시간' })],
  ['2', '퇴근했어요~', SURE('off', { pure: true })],
  ['2', '칼퇴 ㅎㅎ', SURE('off')],
  ['2', 'ㅌㄱ', SURE('off')],
  ['2', '드디어 퇴근ㅠㅠ', SURE('off')],
  ['2', '오늘 일 끝!', SURE('off')],
  ['2', '퇴근 🎉', SURE('off')],
  ['2', '퇴근!!!', SURE('off', { pure: true })],
  ['2', '정시 퇴근', SURE('off', { pure: true })],          // '정시퇴근' 과 띄어쓰기만 다른 말
  ['2', '정시퇴근', SURE('off')],
  ['3', '퇴근할게', SURE('off')],
  ['4', '출근 중', SURE('to_work', { role: 'commute_in' })],
  ['4', '출근길', SURE('to_work')],
  ['4', '퇴근길', SURE('to_home', { role: 'commute_out' })],
  ['4', '집 가는 중', SURE('to_home')],
  ['5', '퇴근하고 싶다', null],
  ['5', '퇴근 언제 하지', null],
  ['5', '아직 퇴근 전', null],
  ['5', '퇴근 시간 바꾸기', null],
  ['5', '퇴사', null],
  ['5', '퇴근했나?', null],
  ['5', '내일 퇴근하고 장보기', null],
  ['5', '퇴근 15분 전', null],
  ['5', '퇴근하고', null],
  ['5', '퇴근 안 해', null],                                 // 부정은 '못' 처럼 막는다 (퇴근 제안이 되면 뜻이 거꾸로)
  ['5', '오늘 출근 안 함', null],
  ['5', '회의 안건 정리', null],
  ['6', '퇴근 못 함', MAYBE('work', { role: 'work_start', label: '야근', pure: false })],
  ['6', '퇴근 못해', MAYBE('work', { label: '야근' })],
  ['7', '팀장님 퇴근하심', null],
  ['7', '남편 퇴근 7시', null],
  ['7', '엄마 퇴근했대', null],
  ['8', '운동 가기', null],
  ['8', '장보기', null],
  ['9', '퇴근! 가는 길에 우유 사기', SURE('off', { pure: false, statusLine: '퇴근!', rest: '가는 길에 우유 사기' })],
  ['10', '출근함\n9시 회의 자료 출력', SURE('work', { pure: false, statusLine: '출근함', rest: '9시 회의 자료 출력' })],
  ['11', '퇴근하고 우유 사기', null],
  ['12', '10분만 쉴게', SURE('break', { role: 'break', untilMin: 10, minutes: 10 })],
  ['12', '15분 쉼', SURE('break', { untilMin: 15 })],
  ['12', '휴식', SURE('break', { untilMin: 15 })],
  ['12', '30분 휴식', SURE('break', { untilMin: 30 })],
  ['12', '브레이크 타임', SURE('break', { untilMin: 15 })],  // 뜻이 하나라 공통 사전 (자영업 전용 말이 아니다)
  ['13', '1시까지 점심', SURE('meal', { until: MON(13, 0), label: '점심' }), { cur: 'guess', now: MON(12, 20) }],
  ['13', '점심', SURE('meal', { until: MON(13, 0) }), { cur: 'guess', now: MON(12, 5) }],
  ['13', '점심 시간', SURE('meal', { until: MON(13, 0) }), { cur: 'guess', now: MON(12, 5) }],   // '점심시간' 과 띄어쓰기만 다름 ('시간' 막기에 걸리지 않는다)
  ['13', '저녁 먹으러', SURE('meal', { untilMin: 40, label: '저녁' }), { cur: 'work', now: MON(15, 0) }],
  ['14', '6시까지 외출', SURE('out', { until: MON(18, 0) }), { now: MON(14, 0) }],
  ['14', '6시까지 외출', SURE('out', { until: null }), { now: MON(19, 0) }],
  ['15', '밥 먹는 중', null, { cur: 'off', now: MON(19, 0) }],
  ['15', '점심', null],
  ['16', '커피 한잔', MAYBE('break', { label: '커피' }), { cur: 'work' }],
  ['16', '커피 한잔', null, { cur: 'off' }],
  ['17', '점심 먹었어', SURE('work', { role: 'back' }), { cur: ['work', 'meal'] }],
  ['17', '점심 먹었어', null, { cur: 'work' }],
  ['18', '도착', SURE('off', { role: 'arrive' }), { cur: 'to_home' }],
  ['18', '도착', SURE('work'), { cur: 'to_work' }],
  ['18', '도착', null, { cur: 'work' }],
  ['19', '복귀', SURE('work', { role: 'back' }), { cur: ['work', 'break'] }],
  ['19', '복귀', SURE('work'), { cur: 'out', now: MON(10, 0) }],
  ['19', '복귀', SURE('off'), { cur: 'out', now: MON(20, 0) }],
  ['19', '복귀', SURE('work', { same: true }), { cur: 'work' }],
  ['20', '오늘 연차', SURE('day_off', { label: '연차' })],
  ['20', '휴가', SURE('day_off', { label: '휴가' })],
  ['20', '쉬는 날', SURE('day_off', { label: '쉬는 날' })],
  ['20', '오프', null],
  ['21', '반차', SURE('off', { role: 'half_day', label: '반차', until: MON(13, 0) }), { now: MON(8, 30) }],
  ['21', '반차', SURE('off', { label: '반차', until: MON(18, 0) }), { now: MON(14, 0) }],
  ['21', '오후 반차', SURE('off', { label: '반차', until: MON(18, 0) }), { now: MON(10, 0) }],
  ['22', '잘게', SURE('sleep', { role: 'sleep' })],
  ['22', '굿나잇', SURE('sleep')],
  ['22', '이제 자야지', SURE('sleep')],
  ['22', '낮잠', MAYBE('sleep')],
  ['22', '낮잠 잘게', SURE('sleep', { untilMin: 60, label: '낮잠' })],
  ['23', '일어났어', SURE(null, { role: 'wake', pure: true }), { cur: 'sleep' }],
  ['23', '일어났어', null, { cur: 'work' }],
  ['24', '한가해', SURE(null, { role: 'idle', pure: true })],
  ['24', '뭐 하지', SURE(null, { role: 'idle' })],
  ['24', '뭐 할까', SURE(null, { role: 'idle' })],
  ['25', '모두 보기', SURE('none', { role: 'reset', pure: true })],
  ['25', '상태 해제', SURE('none', { role: 'reset' })],
  ['26', '오늘 퇴근길에 본 노을 정말 예뻤다', null],
  ['26', '어제 회의에서 나온 이야기를 정리해 보면 퇴근 시간 문제가 제일 컸다', null],
  ['27', '운동', MAYBE('exercise', { role: 'exercise' })],
  ['27', '운동 중', SURE('exercise')],
  ['27', '지하철 탐', MAYBE('to_home'), { cur: 'work' }],
  ['27', '지하철 탐', MAYBE('to_work'), { cur: 'off' }],
  ['27', '지하철 탐 오늘 사람 엄청 많음', null, { cur: 'work' }],
  ['28', '야근', SURE('work', { label: '야근' })],
  ['28', '오늘 야근이라 퇴근 늦음', null],
  ['29', '재택 시작', SURE('wfh', { label: '재택' })],
  ['30', '마감했어', null],
  ['30', '나이트 출근', null],
  ['30', '마감했어', SURE('off', { role: 'work_end', label: '영업 끝' }), { prefs: { statusProfile: { preset: 'shop' } } }],
  ['30', '나이트 출근', SURE('work', { role: 'work_start', label: '나이트' }), { prefs: { statusProfile: { preset: 'shift' } } }],
  ['31', '집 감', SURE('off'), { prefs: OFFICE_USER }],
  ['31', '칼퇴', null, { prefs: OFFICE_USER }],
  ['31', '헬스장 도착', SURE('u_gym', { label: '운동 중' }), { prefs: OFFICE_USER }],
  ['31', '운동 중', SURE('u_gym'), { prefs: OFFICE_USER }],
  ['32', '/퇴근', null],
  ['32', '／퇴근', null],
  ['34', '퇴큰', null]
];

function check(row, d, now) {
  const [n, text, want] = row;
  const tag = '#' + n + ' ' + JSON.stringify(text);
  if (want === null) { assert.equal(d, null, tag + ' → null 이어야 함 (' + JSON.stringify(d) + ')'); return; }
  assert.ok(d, tag + ' → 감지되어야 함');
  Object.keys(want).forEach((k) => {
    if (k === 'untilMin') assert.equal(Math.round((new Date(d.until).getTime() - now.getTime()) / 60000), want.untilMin, tag + ' untilMin');
    else if (k === 'until') assert.equal(d.until, want.until ? want.until.toISOString() : null, tag + ' until');
    else assert.equal(d[k], want[k], tag + ' ' + k);
  });
}

test('#1–32·34 감지 표: 상태 보고·막기·시간·문·특수어·프리셋 전용 말·사용자 말', () => {
  ROWS.forEach((row) => {
    const opt = row[3] || {};
    const now = opt.now || NOW;
    const { ctx } = mk(opt.cur, now, opt.prefs);
    check(row, ST.detect(row[1], ctx), now);
  });
});

test('사전 전체: §5.6 공통 말·§12.3 프리셋 전용 말이 모두 그 역할·등급으로 잡힌다', () => {
  const SW = require('../src/core/statusWords');
  // 문(gate)이 열리는 지금 상태를 고른다
  const curFor = (g) => (g.gate === 'in_meal' ? ['work', 'meal'] : g.gate === 'in_meeting' ? ['work', 'meeting']
    : g.gate === 'moving_or_out' ? 'to_home' : g.role === 'wake' ? 'sleep' : g.role === 'back' ? ['work', 'break']
    : g.gate ? 'work' : 'guess');
  const run = (groups, prefs) => groups.forEach((g) => ['sure', 'tail', 'maybe', 'special'].forEach((tier) => (g[tier] || []).forEach((w) => {
    const { ctx } = mk(curFor(g), NOW, prefs);
    const d = ST.detect(w, ctx);
    const tag = (prefs ? prefs.statusProfile.preset + ' ' : '') + JSON.stringify(w);
    assert.ok(d, tag + ' → 감지되어야 함');
    assert.equal(d.tier, tier === 'tail' || tier === 'maybe' ? 'maybe' : 'sure', tag + ' 등급');
    assert.equal(d.role, g.role, tag + ' 역할');
    if (g.id) assert.equal(d.id, g.id, tag + ' 상태');
    if (tier === 'sure' && g.role !== 'idle' && g.role !== 'wake') assert.equal(d.pure, true, tag + ' pure');
    if (tier === 'tail') assert.equal(ST.detect(w + ' 중', ctx).tier, 'sure', tag + ' + 꼬리 → sure');
  })));
  run(SW.PHRASES);
  Object.keys(SW.PRESET_WORDS).forEach((pid) => run(SW.PRESET_WORDS[pid], { statusProfile: { preset: pid } }));
});

test('#9·#10 섞인 글: 상태 문장만 statusLine, 나머지는 rest 로 남는다 (원문은 지우지 않는다)', () => {
  const { ctx } = mk(undefined, NOW);
  const d = ST.detect('퇴근! 가는 길에 우유 사기', ctx);
  assert.equal(d.statusLine, '퇴근!');
  assert.equal(d.pure, false);
  assert.equal(ST.detect('퇴근', ctx).rest, '');
});

test('#11 걸어 둔 상태: "퇴근하고 우유 사기" 는 상태가 아니고, 맨 앞 표현을 뗀다', () => {
  assert.deepEqual(ST.extractAtMode('퇴근하고 우유 사기'), { mode: 'off', phrase: '퇴근하고', title: '우유 사기' });
});

test('#20·#30 다른 프리셋 전용 말은 상태가 아니고 프리셋 신호로만 센다', () => {
  const pf = ST.profile({});
  assert.equal(ST.presetSignal('오프', pf), 'shift');
  assert.equal(ST.presetSignal('나이트 출근', pf), 'shift');
  assert.equal(ST.presetSignal('마감했어', pf), 'shop');
  assert.equal(ST.presetSignal('퇴근', pf), null);
  assert.equal(ST.presetSignal('오프라인 회의 자료', pf), null);
  // 지금 프리셋의 말은 신호가 아니다
  assert.equal(ST.presetSignal('오프', ST.profile({ statusProfile: { preset: 'shift' } })), null);
});

test('#22 "낮잠 잘게" → 잘 시간 +60분, 끝나면 지금 바탕으로 돌아간다', () => {
  const { s, pf, ctx } = mk('work', NOW);
  const d = ST.detect('낮잠 잘게', ctx);
  ST.setStatus(s, d, { source: 'text', text: '낮잠 잘게' }, pf, NOW);
  assert.equal(s.presence.current.id, 'sleep');
  assert.equal(s.presence.current.returnTo.id, 'work');
  const after = ST.effective(s, pf, MON(11, 1));
  assert.equal(after.id, 'work');
  assert.equal(after.guessed, false);
});

test('#23 "일어났어"는 잘 시간일 때만 wake (시간표대로)', () => {
  const { ctx } = mk('sleep', MON(7, 0));
  const d = ST.detect('일어났어', ctx);
  assert.equal(d.role, 'wake');
  assert.equal(d.id, null);
  assert.equal(d.label, '출근 전');   // 깨면 시간표 짐작으로 (월 07:00 = 출근 전)
});

test('#22·#23 낮잠에서 "일어났어" → 낮잠 전 명시 상태로 (밤잠만 시간표대로) — ST.wake 와 같은 결과', () => {
  const { s, pf } = mk('work', MON(13));
  const ctxAt = (now) => ({ profile: pf, eff: ST.effective(s, pf, now), current: s.presence.current, now });
  ST.setStatus(s, ST.detect('낮잠 잘게', ctxAt(MON(13))), { source: 'text' }, pf, MON(13));
  const d = ST.detect('일어났어', ctxAt(MON(13, 30)));
  assert.deepEqual([d.role, d.id, d.label, d.same], ['wake', 'work', '업무 중', false]);
  ST.setStatus(s, d, { source: 'text' }, pf, MON(13, 30));
  const e = ST.effective(s, pf, MON(20));
  assert.deepEqual([e.id, e.guessed], ['work', false], '20:00 에도 명시 업무 (시간표 짐작 퇴근 후가 아님)');
});

test('#33 /상태 인자: 고르기·이름·오타(편집 거리 1)·시간·자동·이전·모르는 이름', () => {
  const pf = ST.profile({});
  const eff = null;
  const P = (a) => ST.parseStatusArgs(a, pf, eff, NOW);
  assert.deepEqual(P(''), { cmd: 'picker' });
  assert.deepEqual(P('   '), { cmd: 'picker' });
  assert.equal(P('퇴근').cmd, 'set');
  assert.equal(P('퇴근').id, 'off');
  assert.equal(P('퇴근 · 내 시간').id, 'off');
  assert.equal(P('off').id, 'off');
  assert.equal(P('퇴큰').id, 'off');
  const b = P('휴식 10분');
  assert.equal(b.cmd, 'set');
  assert.equal(b.id, 'break');
  assert.equal(b.minutes, 10);
  assert.equal(b.until, new Date(NOW.getTime() + 10 * 60000).toISOString());
  const o = ST.parseStatusArgs('외출 6시까지', pf, eff, MON(14, 0));
  assert.equal(o.id, 'out');
  assert.equal(o.until, MON(18, 0).toISOString());
  assert.deepEqual(P('자동'), { cmd: 'guess' });
  assert.deepEqual(P('시간표대로'), { cmd: 'guess' });
  assert.deepEqual(P('이전'), { cmd: 'revert' });
  assert.deepEqual(P('되돌리기'), { cmd: 'revert' });
  assert.deepEqual(P('가게 오픈 준비'), { cmd: 'unknown', label: '가게 오픈 준비' });
  // 명령은 막기·문을 쓰지 않는다: 켜기 전에도 '점심'은 식사 덧씌움
  assert.equal(P('점심').id, 'meal');
  assert.equal(P('모두 보기').id, 'none');
  assert.equal(P('정시 퇴근').id, 'off');
});

test('#19·#33 /상태 복귀: 덧씌움 아래 명시 바탕으로 (current 없이 eff 만으로), 바탕이 짐작이면 시간표대로', () => {
  const pf = ST.profile({});
  const a = mk(['work', 'meeting'], MON(20));     // 19:58 출근(야근) · 19:59 회의
  assert.deepEqual(ST.parseStatusArgs('복귀', pf, a.ctx.eff, MON(20)), { cmd: 'set', id: 'work', label: '업무 중', until: null, minutes: null });
  assert.equal(ST.detect('복귀', a.ctx).id, 'work');
  const s = M.emptyState();
  ST.toGuess(s, MON(19, 58), pf);
  ST.setStatus(s, { id: 'meeting' }, { source: 'chip' }, pf, MON(19, 59));
  assert.deepEqual(ST.parseStatusArgs('복귀', pf, ST.effective(s, pf, MON(20)), MON(20)), { cmd: 'guess' });
});

test('#34 일반 글에서는 오타를 고치지 않는다', () => {
  const { ctx } = mk('work', NOW);
  assert.equal(ST.detect('퇴큰', ctx), null);
  assert.equal(ST.detect('퇴큰했어', ctx), null);
});

// Date.now 와 인자 없는 new Date()·Date() 를 막은 채 fn 을 돌린다 (벽시계를 읽으면 던진다)
function withoutWallClock(fn) {
  const Orig = Date;
  function Guard(...a) {
    if (!new.target) throw new Error('Date() — 벽시계를 읽었다');
    if (a.length === 0) throw new Error('new Date() — 벽시계를 읽었다');
    return new Orig(...a);
  }
  Guard.prototype = Orig.prototype;
  Guard.now = () => { throw new Error('Date.now — 벽시계를 읽었다'); };
  Guard.UTC = Orig.UTC;
  Guard.parse = Orig.parse;
  global.Date = Guard;
  try { return fn(); } finally { global.Date = Orig; }
}

test('#35 같은 입력·같은 now → 같은 결과. 감지는 벽시계를 읽지 않는다 (Date.now·인자 없는 new Date 를 막아도 통과)', () => {
  const prepared = ROWS.map((row) => { const opt = row[3] || {}; const now = opt.now || NOW; return { row, now, ctx: mk(opt.cur, now, opt.prefs).ctx }; });
  withoutWallClock(() => {
    const a = prepared.map((p) => ST.detect(p.row[1], p.ctx));
    const b = prepared.map((p) => ST.detect(p.row[1], p.ctx));
    assert.deepEqual(a, b);
    prepared.forEach((p) => ST.parseStatusArgs(p.row[1], p.ctx.profile, p.ctx.eff, p.now));
    prepared.forEach((p) => { ST.presetSignal(p.row[1], p.ctx.profile); ST.extractAtMode(p.row[1]); ST.findAtMode(p.row[1]); });
  });
});

test('#36 extractAtMode 표 (맨 앞 표현만, 남는 제목이 2자 미만이면 떼지 않음)', () => {
  const T = [
    ['퇴근 후에 우유 사기', 'off', '우유 사기'],
    ['퇴근 후 빨래 개기', 'off', '빨래 개기'],
    ['집에 가서 화분 물 주기', 'off', '화분 물 주기'],
    ['퇴근하고 나서 운동', 'off', '운동'],
    ['출근하면 메일 확인', 'work', '메일 확인'],
    ['회사 가서 서류 출력', 'work', '서류 출력'],
    ['점심 때 은행 들르기', 'pause', '은행 들르기'],
    ['쉬는 시간에 스트레칭', 'pause', '스트레칭'],
    ['나가는 김에 우체국 들르기', 'out', '우체국 들르기'],
    ['가는 길에, 우유 사기', 'out', '우유 사기'],
    ['쉬는 날에 대청소', 'rest', '대청소']
  ];
  T.forEach(([title, mode, rest]) => {
    const r = ST.extractAtMode(title);
    assert.ok(r, title);
    assert.equal(r.mode, mode, title);
    assert.equal(r.title, rest, title);
  });
  assert.equal(ST.extractAtMode('주말에 세차하기'), null);
  assert.equal(ST.extractAtMode('퇴근하고 밥'), null);
  assert.equal(ST.extractAtMode('퇴근하고 A'), null);
  assert.equal(ST.extractAtMode('집에서도 할 수 있는 일'), null);
  assert.equal(ST.atModePhrase('off'), '퇴근하고');
  assert.equal(ST.atModePhrase('work'), '출근하면');
  assert.equal(ST.atModePhrase('out'), '나가는 김에');
  assert.equal(ST.atModePhrase('pause'), '쉬는 시간에');
  assert.equal(ST.atModePhrase('rest'), '쉬는 날에');
});

test('#37 findAtMode 는 글 가운데에서도 찾는다', () => {
  assert.equal(ST.findAtMode('오늘 퇴근하고 빨래 돌리기'), 'off');
  assert.equal(ST.findAtMode('내일 출근하면 바로 메일'), 'work');
  assert.equal(ST.findAtMode('우리집에서 파티'), null);
  assert.equal(ST.findAtMode('보고서 쓰기'), null);
});

test('#38 onPhone: 전화·이체·예약처럼 폰으로 할 수 있는 일', () => {
  assert.equal(ST.onPhone({ title: '엄마한테 전화' }), true);
  assert.equal(ST.onPhone({ title: '카드값 이체' }), true);
  assert.equal(ST.onPhone({ title: '치과 예약' }), true);
  assert.equal(ST.onPhone({ title: '빨래 돌리기' }), false);
});

test('기능을 끄면(enabled:false) 감지하지 않는다 — 지금과 같아진다', () => {
  const { ctx } = mk(undefined, NOW, { statusProfile: { enabled: false } });
  assert.equal(ST.detect('퇴근', ctx), null);
});
