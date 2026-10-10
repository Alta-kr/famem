'use strict';

// 쓸 수 있는 시간 읽기 — dates.parseDuration (FEATURES §5.5 · §7.3). 시계와 무관하다.

const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../src/core/dates');

function ok(text, minutes) {
  assert.deepEqual(D.parseDuration(text), { ok: true, minutes }, JSON.stringify(text));
}
function bad(text, error) {
  const r = D.parseDuration(text);
  assert.equal(r.ok, false, JSON.stringify(text));
  assert.equal(r.error, error, JSON.stringify(text));
  assert.equal(typeof r.message, 'string');
  assert.ok(r.message.length > 0);
  assert.equal(r.minutes, undefined);
}

test('1. 숫자만 적으면 분', () => {
  ok('45', 45);
  ok('120', 120);
});

test('2. 분: 45분 · 45 분 · 45m · 45min · 45 mins · 45minutes', () => {
  for (const t of ['45분', '45 분', '45m', '45min', '45 mins', '45minutes', '45 minute', '45M']) ok(t, 45);
});

test('3. 시간: 1시간 · 1 시간 · 1h · 1hr · 2 hours · 한 시간 · 두시간', () => {
  for (const t of ['1시간', '1 시간', '1h', '1hr', '1 hour', '한 시간', '한시간']) ok(t, 60);
  for (const t of ['2 hours', '2시간', '2hrs', '두시간', '두 시간']) ok(t, 120);
  ok('세 시간', 180);
  ok('열 시간', 600);
});

test('4. 시간 + 분: 1시간 30분 · 1시간30분 · 1시간 30 · 1h30m · 1h 30m · 1h30', () => {
  for (const t of ['1시간 30분', '1시간30분', '1시간 30', '1h30m', '1h 30m', '1h30', '1 hour 30 minutes', '한 시간 30분']) ok(t, 90);
  ok('2시간 5분', 125);
  ok('0시간 45분', 45);
});

test('5. 반: 1시간 반 · 한 시간 반 → 90, 반 시간 → 30', () => {
  ok('1시간 반', 90);
  ok('1시간반', 90);
  ok('한 시간 반', 90);
  ok('두 시간 반', 150);
  ok('반 시간', 30);
  ok('반시간', 30);
});

test('6. 소수 시간: 1.5시간 · 1.5h → 90, 0.5시간 → 30 (반올림)', () => {
  ok('1.5시간', 90);
  ok('1.5h', 90);
  ok('0.5시간', 30);
  ok('1.33시간', 80);
});

test('7. 시:분: 1:30 → 90, 0:45 → 45, 2:00 → 120, 01:05 → 65', () => {
  ok('1:30', 90);
  ok('0:45', 45);
  ok('2:00', 120);
  ok('01:05', 65);
  ok('1：30', 90);   // 전각 쌍점도 NFKC 로 맞춘다
});

test('8. 꾸밈말과 공백·전각 숫자: 약 30분 · 30분 정도 · 30분쯤 · ‘  30 분  ’ · ３０분', () => {
  for (const t of ['약 30분', '대략 30분', '30분 정도', '30분쯤', '30분 가량', '30분 내외', '  30 분  ', '３０분', '30　분']) ok(t, 30);
  ok('약 1시간 반 정도', 90);
});

test('9. 형태가 틀리면 invalid', () => {
  for (const t of ['abc', '1:5', '1:75', '1시간 70분', '1.5시간 10분', '30.5분', '-30', '30분 후', '삼십분', '1.5', '1시간 반 30분', '1.5시간 반', '약', '정도', '한 h', '반', '1,5시간']) bad(t, 'invalid');
});

test('10. 비어 있으면 empty', () => {
  for (const t of ['', '   ', null, undefined, '\n\t']) bad(t, 'empty');
});

test('11. 범위: 5분 미만 too_short, 720분 초과 too_long, 경계 5·720 은 통과', () => {
  bad('0', 'too_short');
  bad('3', 'too_short');
  bad('0:04', 'too_short');
  bad('13시간', 'too_long');
  bad('721', 'too_long');
  bad('12:01', 'too_long');
  ok('5', 5);
  ok('12시간', 720);
  ok('열두 시간', 720);
  assert.equal(D.DURATION_MIN, 5);
  assert.equal(D.DURATION_MAX, 720);
});

test('12. 결과는 정수이고, 오류마다 정해진 message', () => {
  for (const t of ['45', '1.5h', '1.33시간', '0.1h', '1:30', '한 시간 반']) {
    const r = D.parseDuration(t);
    assert.equal(r.ok, true, t);
    assert.ok(Number.isInteger(r.minutes), t);
  }
  assert.equal(D.parseDuration('').message, '시간을 적어 주세요.');
  assert.equal(D.parseDuration('abc').message, '‘45’, ‘1시간 30분’, ‘1:30’처럼 적어 주세요.');
  assert.equal(D.parseDuration('3').message, '5분 이상으로 적어 주세요.');
  assert.equal(D.parseDuration('13시간').message, '12시간 이하로 적어 주세요.');
});

test('13. duration 과 왕복: duration(parseDuration(‘1시간 30분’).minutes) === ‘1시간 30분’', () => {
  assert.equal(D.duration(D.parseDuration('1시간 30분').minutes), '1시간 30분');
  for (const t of ['45분', '1시간', '2시간 5분', '12시간']) assert.equal(D.duration(D.parseDuration(t).minutes), t);
});

test('14. 기존 내보내기는 그대로 있다', () => {
  for (const k of ['DAY', 'WEEKDAYS', 'pad', 'ymd', 'parseYmd', 'startOfDay', 'endOfDay', 'addDays', 'addMinutes', 'startOfWeek',
    'dayDiff', 'minutesBetween', 'hm', 'relDay', 'longDay', 'shortDay', 'duration', 'weekLabel']) {
    assert.ok(k in D, k);
  }
  assert.equal(D.duration(90), '1시간 30분');
  assert.equal(D.ymd(new Date(2026, 9, 5, 10, 0)), '2026-10-05');
});
