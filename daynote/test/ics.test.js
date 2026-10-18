'use strict';
const test = require('node:test');
const assert = require('node:assert');
const ICS = require('../src/core/ics');

const CAL = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'X-WR-TIMEZONE:Asia/Seoul',
  'BEGIN:VEVENT',
  'UID:weekly-1',
  'SUMMARY:주간 회의\\, 팀 전체',
  'DTSTART;TZID=Asia/Seoul:20261019T100000',
  'DTEND;TZID=Asia/Seoul:20261019T110000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6',
  'EXDATE;TZID=Asia/Seoul:20261021T100000',
  'BEGIN:VALARM',
  'TRIGGER:-PT10M',
  'SUMMARY:알림 — 무시',
  'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:weekly-1',
  'RECURRENCE-ID;TZID=Asia/Seoul:20261026T100000',
  'SUMMARY:주간 회의 (시간 바뀜)',
  'DTSTART;TZID=Asia/Seoul:20261026T140000',
  'DTEND;TZID=Asia/Seoul:20261026T150000',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:utc-1',
  'SUMMARY:고객 통화',
  'LOCATION:Zoom',
  'DTSTART:20261020T050000Z',
  'DURATION:PT30M',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:allday-1',
  'SUMMARY:창립 기념일',
  'DTSTART;VALUE=DATE:20261023',
  'DTEND;VALUE=DATE:20261024',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:cancel-1',
  'SUMMARY:취소된 회의',
  'STATUS:CANCELLED',
  'DTSTART:20261020T010000Z',
  'DTEND:20261020T020000Z',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:long-1',
  'SUMMARY:아주 긴 제목이 다음 줄로',
  '  이어집니다',
  'DTSTART:20261022T000000Z',
  'DTEND:20261022T010000Z',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n');

test('ICS: 반복·빠진 날·바뀐 한 번·UTC·종일·취소·줄 이음을 읽는다', () => {
  const ev = ICS.parse(CAL, { from: '2026-10-18T00:00:00Z', to: '2026-11-30T00:00:00Z' });
  const titles = ev.map((e) => e.title);
  // 주간 회의 6회: 10/19 월, (10/21 수 빠짐), 10/26 월은 14시로 바뀜, 10/28, 11/2, 11/4
  const weekly = ev.filter((e) => e.uid.startsWith('weekly-1@') && e.title === '주간 회의, 팀 전체');
  assert.deepStrictEqual(weekly.map((e) => e.start), ['2026-10-19T01:00:00.000Z', '2026-10-28T01:00:00.000Z', '2026-11-02T01:00:00.000Z', '2026-11-04T01:00:00.000Z']);
  const moved = ev.find((e) => e.title === '주간 회의 (시간 바뀜)');
  assert.strictEqual(moved.start, '2026-10-26T05:00:00.000Z');
  const call = ev.find((e) => e.title === '고객 통화');
  assert.deepStrictEqual([call.start, call.end, call.location], ['2026-10-20T05:00:00.000Z', '2026-10-20T05:30:00.000Z', 'Zoom']);
  const allDay = ev.find((e) => e.title === '창립 기념일');
  assert.strictEqual(allDay.allDay, true);
  assert.ok(!titles.includes('취소된 회의'));
  assert.ok(!titles.includes('알림 — 무시'));
  assert.ok(titles.includes('아주 긴 제목이 다음 줄로 이어집니다'));
  // 기간 밖은 뺀다
  const narrow = ICS.parse(CAL, { from: '2026-10-27T00:00:00Z', to: '2026-10-29T00:00:00Z' });
  assert.deepStrictEqual(narrow.map((e) => e.title), ['주간 회의, 팀 전체']);
});

test('ICS: 매일 반복 UNTIL · 매달 31일은 없는 달을 건너뛴다', () => {
  const daily = ICS.expand(Date.UTC(2026, 9, 1, 0), 'FREQ=DAILY;INTERVAL=2;UNTIL=20261007T000000Z', -Infinity, Infinity, 100);
  assert.strictEqual(daily.length, 4);   // 1·3·5·7일
  const start = new Date(2026, 0, 31, 9).getTime();
  const monthly = ICS.expand(start, 'FREQ=MONTHLY;COUNT=3', -Infinity, Infinity, 100).map((ms) => new Date(ms).getMonth());
  assert.deepStrictEqual(monthly, [0, 2, 4]);   // 1월·3월·5월 (2월·4월은 31일이 없다)
  // 3년 전에 시작한 매일 회의도 지금 기간 것이 나온다
  const old = ICS.expand(Date.UTC(2023, 0, 2, 0), 'FREQ=DAILY', Date.UTC(2026, 9, 19), Date.UTC(2026, 9, 22), 1000);
  assert.strictEqual(old.length, 3);
});
