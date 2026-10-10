'use strict';

// 슬래시 명령어 — 명령어 표 · parse · match(자동완성) · suggestFor (src/core/commands.js, FEATURES §6.1–6.2 · §7.2)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const CMD = require('../src/core/commands');

const plain = (text) => ({ command: null, kind: null, args: String(text).trim(), raw: text, token: null, unknown: null, escaped: false });
const names = (list) => list.map((x) => x.name);

// ---------------------------------------------------------------- parse

test('1. 일반 글 → 명령 아님, args 는 앞뒤 공백(줄바꿈 포함)을 뗀 원문', () => {
  assert.deepEqual(CMD.parse('  우유 사기  '), plain('  우유 사기  '));
  assert.deepEqual(CMD.parse('\n우유 사기\n계란\n'), plain('\n우유 사기\n계란\n'));
  assert.deepEqual(CMD.parse(''), plain(''));
  const p = CMD.parse(null);
  assert.equal(p.command, null);
  assert.equal(p.args, '');
  assert.equal(p.raw, '');
});

test('2. /todo 우유 사기 → 할 일 명령, 본문과 토큰', () => {
  assert.deepEqual(CMD.parse('/todo 우유 사기'),
    { command: 'todo', kind: 'task', args: '우유 사기', raw: '/todo 우유 사기', token: '/todo', unknown: null, escaped: false });
});

test('3. 한글 /할일 과 띄어 쓴 /할 일 도 할 일 명령', () => {
  const a = CMD.parse('/할일 내일까지 견적서');
  assert.equal(a.command, 'todo');
  assert.equal(a.kind, 'task');
  assert.equal(a.args, '내일까지 견적서');
  assert.equal(a.token, '/할일');
  const b = CMD.parse('/할 일 견적서');
  assert.equal(b.command, 'todo');
  assert.equal(b.args, '견적서');
  assert.equal(b.token, '/할 일');
});

test('4. /할 일이 많다 → 명령 아님, 없는 명령 ‘할’', () => {
  const p = CMD.parse('/할 일이 많다');
  assert.equal(p.command, null);
  assert.equal(p.kind, null);
  assert.equal(p.unknown, '할');
  assert.equal(p.args, '/할 일이 많다');
  assert.equal(p.token, null);
});

test('5. 라틴 글자는 대소문자를 가리지 않고, 토큰은 친 그대로', () => {
  const p = CMD.parse('/TODO x');
  assert.equal(p.command, 'todo');
  assert.equal(p.token, '/TODO');
  assert.equal(p.args, 'x');
  assert.equal(CMD.parse('/Memo 회의').command, 'memo');
});

test('6. 짧은 형태 /t /e /m /i /l /s /h /? → 각 명령', () => {
  const rows = [
    ['/t 우유 사기', 'todo', 'task', '우유 사기'],
    ['/e 금요일 치과', 'event', 'event', '금요일 치과'],
    ['/m 회의 분위기', 'memo', 'memo', '회의 분위기'],
    ['/i 퀴즈 넣기', 'idea', 'idea', '퀴즈 넣기'],
    ['/l https://example.com 나중에', 'link', 'link', 'https://example.com 나중에'],
    ['/s 회의 중', 'status', null, '회의 중'],
    ['/h', 'help', null, ''],
    ['/?', 'help', null, '']
  ];
  for (const [text, command, kind, args] of rows) {
    const p = CMD.parse(text);
    assert.equal(p.command, command, text);
    assert.equal(p.kind, kind, text);
    assert.equal(p.args, args, text);
    assert.equal(p.unknown, null, text);
  }
});

test('7. 영어 이름과 별칭: /task → todo, /note → memo', () => {
  assert.equal(CMD.parse('/task x').command, 'todo');
  assert.equal(CMD.parse('/task x').kind, 'task');
  assert.equal(CMD.parse('/note x').command, 'memo');
  const rows = [['/event x', 'event'], ['/memo x', 'memo'], ['/idea x', 'idea'], ['/link x', 'link'], ['/status x', 'status'], ['/help', 'help']];
  for (const [text, command] of rows) assert.equal(CMD.parse(text).command, command, text);
});

test('8. 경계: 이름 뒤에 공백·:·：·끝이 와야 명령 (/todox ✗, /todo: ✓)', () => {
  const x = CMD.parse('/todox 우유');
  assert.equal(x.command, null);
  assert.equal(x.unknown, 'todox');
  assert.equal(x.args, '/todox 우유');
  for (const t of ['/todo:우유', '/todo: 우유', '/todo：우유', '/할일: 우유']) {
    const p = CMD.parse(t);
    assert.equal(p.command, 'todo', t);
    assert.equal(p.args, '우유', t);
  }
  assert.equal(CMD.parse('/todo:').args, '');
});

test('9. 전각 슬래시 ／할일 우유 → todo, 토큰은 친 그대로', () => {
  const p = CMD.parse('／할일 우유');
  assert.equal(p.command, 'todo');
  assert.equal(p.args, '우유');
  assert.equal(p.token, '／할일');
});

test('10. 앞 공백(줄바꿈 포함)은 건너뛰고 명령을 본다', () => {
  for (const t of ['  /memo 회의', '\n\t/memo 회의']) {
    const p = CMD.parse(t);
    assert.equal(p.command, 'memo', JSON.stringify(t));
    assert.equal(p.args, '회의');
    assert.equal(p.token, '/memo');
    assert.equal(p.raw, t);
  }
});

test('11. 명령만 적으면 args 는 빈 글자', () => {
  for (const t of ['/memo', '/메모   ', '/할일\n']) {
    const p = CMD.parse(t);
    assert.ok(p.command, t);
    assert.equal(p.args, '', JSON.stringify(t));
  }
});

test('12. 여러 줄: 명령 뒤 줄바꿈은 떼고 안쪽 줄바꿈은 그대로', () => {
  assert.equal(CMD.parse('/todo\n우유 사기\n계란').args, '우유 사기\n계란');
  assert.equal(CMD.parse('/todo 우유\n계란').args, '우유\n계란');
  assert.equal(CMD.parse('/todo 우유\n계란\n\n').args, '우유\n계란');
});

test('13. 글 중간의 명령은 일반 글', () => {
  assert.deepEqual(CMD.parse('우유 /todo'), plain('우유 /todo'));
});

test('14. // 로 시작하면 이스케이프: / 하나를 뗀 일반 글', () => {
  const p = CMD.parse('//todo 글자');
  assert.equal(p.command, null);
  assert.equal(p.kind, null);
  assert.equal(p.escaped, true);
  assert.equal(p.args, '/todo 글자');
  assert.equal(p.unknown, null);
  assert.equal(CMD.parse('  //할일 x').args, '/할일 x');
});

test('15. 명령처럼 보이지 않는 슬래시 글(/usr/bin, /10 회의, /)은 안내 없는 일반 글', () => {
  for (const t of ['/usr/bin 정리', '/10 회의', '/', '/ 할일', '/abcdefghijklmnop 열여섯 글자']) {
    const p = CMD.parse(t);
    assert.equal(p.command, null, t);
    assert.equal(p.unknown, null, t);
    assert.equal(p.escaped, false, t);
    assert.equal(p.args, t.trim(), t);
  }
});

test('16. NFD 로 분해된 할일 도 todo (NFC 로 맞춘다)', () => {
  const nfd = '/' + '할일'.normalize('NFD') + ' 우유';
  assert.notEqual(nfd, '/할일 우유');
  const p = CMD.parse(nfd);
  assert.equal(p.command, 'todo');
  assert.equal(p.args, '우유');
  assert.equal(p.raw, nfd);
});

test('17. /도움말 할일 → help, /상태 회의 중 → status (kind 없음)', () => {
  const h = CMD.parse('/도움말 할일');
  assert.equal(h.command, 'help');
  assert.equal(h.kind, null);
  assert.equal(h.args, '할일');
  const s = CMD.parse('/상태 회의 중');
  assert.equal(s.command, 'status');
  assert.equal(s.kind, null);
  assert.equal(s.args, '회의 중');
  assert.equal(s.token, '/상태');
});

// ---------------------------------------------------------------- match (자동완성)

test('18. match(\'\') → 일곱 명령 전부 표 순서, 첫 토큰은 한글 /할일', () => {
  const list = CMD.match('');
  assert.deepEqual(names(list), ['todo', 'event', 'memo', 'idea', 'link', 'status', 'help']);
  assert.equal(list[0].token, '/할일');
  assert.deepEqual(list.map((x) => x.token), ['/할일', '/일정', '/메모', '/아이디어', '/링크', '/상태', '/도움말']);
  assert.ok(list.every((x) => x.exact === false));
  assert.deepEqual(Object.keys(list[0]).sort(), ['alt', 'desc', 'exact', 'example', 'icon', 'kind', 'name', 'noArgs', 'token']);
  assert.equal(list[0].kind, 'task');
  assert.equal(list[0].desc, '할 일로 적어요');
  assert.equal(list[0].example, '/할일 내일까지 견적서 보내기');
  assert.equal(list[0].icon, 'task');
  assert.equal(list[6].noArgs, true);
  assert.ok(list.slice(0, 6).every((x) => x.noArgs === false));
});

test('19. 자모 분해 앞부분 일치: 조합 중인 글자도 맞는다', () => {
  for (const q of ['ㅎ', '하', '할', '할ㅇ', '할이', '할일']) assert.deepEqual(names(CMD.match(q)), ['todo'], q);
  assert.deepEqual(names(CMD.match('멤')), ['memo']);
  assert.deepEqual(names(CMD.match('ㄷ')), ['help']);
  assert.deepEqual(names(CMD.match('도')), ['help']);
  assert.deepEqual(names(CMD.match('ㅅ')), ['status']);
  assert.equal(CMD.match('할')[0].token, '/할일');
  assert.equal(CMD._jamo('할일'), 'ㅎㅏㄹㅇㅣㄹ');
  assert.equal(CMD._jamo('값'), 'ㄱㅏㅂㅅ');     // 겹받침은 둘로
  assert.equal(CMD._jamo('갋'), 'ㄱㅏㄹㅂ');
  assert.equal(CMD._jamo('todo'), 'todo');
});

test('20. 라틴 질의: t → todo(/todo), m → memo(exact), ? → help, x → 없음', () => {
  const t = CMD.match('t');
  assert.equal(t[0].name, 'todo');
  assert.equal(t[0].token, '/todo');
  const m = CMD.match('m');
  assert.equal(m[0].name, 'memo');
  assert.equal(m[0].exact, true);
  assert.equal(m[0].token, '/memo');
  const q = CMD.match('?');
  assert.deepEqual(names(q), ['help']);
  assert.equal(q[0].token, '/help');               // 한 글자 짧은 형태로 맞으면 영어 이름을 보인다
  assert.deepEqual(CMD.match('x'), []);
  assert.equal(CMD.match('TA')[0].token, '/task');  // 대소문자 무시, 맞은 별칭 그대로
  // 정확히 같은 것이 먼저, 나머지는 표 순서
  assert.deepEqual(names(CMD.match('i')), ['idea']);
  assert.equal(CMD.match('일정')[0].exact, true);
});

test('21. alt 는 나머지 대표 형태만 (띄어 쓴 ‘할 일’·영어 별칭 없음)', () => {
  const all = CMD.match('');
  assert.deepEqual(all[0].alt, ['/todo', '/t']);
  assert.deepEqual(all[2].alt, ['/memo', '/m']);
  assert.deepEqual(all[6].alt, ['/help', '/h', '/?']);
  for (const x of all) {
    assert.ok(!x.alt.includes('/할 일'), x.name);
    assert.ok(!x.alt.includes(x.token), x.name);
    assert.ok(!x.alt.includes('/task') && !x.alt.includes('/note'), x.name);
  }
  assert.deepEqual(CMD.match('t')[0].alt, ['/할일', '/t']);
});

// ---------------------------------------------------------------- suggestFor

test('22. suggestFor: todos → todo, 할릴 → todo, xyz → null', () => {
  assert.equal(CMD.suggestFor('todos'), 'todo');
  assert.equal(CMD.suggestFor('할릴'), 'todo');
  assert.equal(CMD.suggestFor('xyz'), null);
  assert.equal(CMD.suggestFor('stat'), 'status');   // 앞부분
  assert.equal(CMD.suggestFor('/todos'), 'todo');   // 슬래시를 붙여 넘겨도 같다
  assert.equal(CMD.suggestFor(''), null);
  assert.equal(CMD.suggestFor(null), null);
});

// ---------------------------------------------------------------- 표 무결성 · 환경

test('23. 표 무결성: 모든 이름이 명령 사이에 겹치지 않고, kind 는 다섯 종류 또는 null', () => {
  assert.deepEqual(names(CMD.COMMANDS), ['todo', 'event', 'memo', 'idea', 'link', 'status', 'help']);
  const seen = new Map();
  for (const c of CMD.COMMANDS) {
    assert.equal(c.en[0], c.name, c.name);
    for (const n of c.ko.concat(c.en, c.short)) {
      const k = n.toLowerCase();
      assert.ok(!seen.has(k), `이름 ‘${n}’ 이 ${seen.get(k)} 와 ${c.name} 에 겹친다`);
      seen.set(k, c.name);
    }
    assert.ok([null, 'task', 'event', 'memo', 'idea', 'link'].includes(c.kind), c.name);
    assert.equal(typeof c.desc, 'string');
    assert.ok(c.example.indexOf('/') === 0, c.name);
    assert.equal(CMD.get(c.name), c);
    // 예시도 자기 명령으로 해석된다
    assert.equal(CMD.parse(c.example).command, c.name, c.example);
  }
  assert.deepEqual(CMD.COMMANDS.filter((c) => c.needsArgs).map((c) => c.name), ['todo', 'event', 'memo', 'idea', 'link']);
  assert.deepEqual(CMD.COMMANDS.filter((c) => c.noArgs).map((c) => c.name), ['help']);
  assert.equal(CMD.get('nope'), null);
});

test('24. require 만으로 동작(window 없음)하고, 빠른 메모 창(다른 전역 없음)에서도 등록되며, 입력·표를 바꾸지 않는다', () => {
  assert.equal(typeof window, 'undefined');
  assert.equal(typeof CMD.parse, 'function');
  // 빠른 메모 창: window 하나만 있는 빈 환경에서 스크립트로 불러도 window.Daynote.commands 가 생긴다
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'commands.js'), 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox, { filename: 'commands.js' });
  const Q = sandbox.window.Daynote.commands;
  assert.equal(Q.parse('/할일 우유').command, 'todo');
  assert.equal(Q.match('ㅎ')[0].name, 'todo');
  // 입력과 표를 바꾸지 않는다
  const before = JSON.stringify(CMD.COMMANDS);
  const input = '  /할일: 우유 사기  ';
  const copy = input.slice();
  CMD.parse(input); CMD.match('할'); CMD.match(''); CMD.suggestFor('todos');
  const list = CMD.match('');
  list[0].alt.push('/바뀜');
  assert.equal(input, copy);
  assert.equal(JSON.stringify(CMD.COMMANDS), before);
  assert.deepEqual(CMD.match('')[0].alt, ['/todo', '/t']);
});

// ---------------------------------------------------------------- 더 확인 (검증 단계에서 보탬)

test('25. 표 문구는 FEATURES §6.1 그대로 (도움말 카드·자동완성이 이 값을 그린다)', () => {
  const rows = [
    // name, kind, ko, en, short, icon, desc, example, needsArgs, noArgs
    ['todo', 'task', ['할일', '할 일'], ['todo', 'task'], ['t'], 'task', '할 일로 적어요', '/할일 내일까지 견적서 보내기', true, false],
    ['event', 'event', ['일정'], ['event'], ['e'], 'calendar', '일정으로 적어요', '/일정 금요일 오후 3시 치과', true, false],
    ['memo', 'memo', ['메모'], ['memo', 'note'], ['m'], 'note', '메모로만 남겨요 (할 일을 만들지 않아요)', '/메모 회의 분위기 좋았음', true, false],
    ['idea', 'idea', ['아이디어'], ['idea'], ['i'], 'idea', '아이디어로 남겨요', '/아이디어 온보딩에 퀴즈 넣기', true, false],
    ['link', 'link', ['링크'], ['link'], ['l'], 'link', '링크로 남겨요', '/링크 https://… 나중에 읽기', true, false],
    ['status', null, ['상태'], ['status'], ['s'], 'clock', '지금 상태를 바꿔요', '/상태 회의 중', false, false],
    ['help', null, ['도움말'], ['help'], ['h', '?'], 'command', '명령어 목록을 보여 줘요', '/도움말', false, true]
  ];
  assert.equal(CMD.COMMANDS.length, rows.length);
  rows.forEach(([name, kind, ko, en, short, icon, desc, example, needsArgs, noArgs], i) => {
    const c = CMD.COMMANDS[i];
    assert.deepEqual({ name: c.name, kind: c.kind, ko: c.ko, en: c.en, short: c.short, icon: c.icon, desc: c.desc, example: c.example, needsArgs: c.needsArgs, noArgs: c.noArgs },
      { name, kind, ko, en, short, icon, desc, example, needsArgs, noArgs }, name);
  });
});

test('26. 두벌식으로 치는 도중의 글자마다 그 명령이 후보에 든다', () => {
  const steps = {
    todo: ['ㅎ', '하', '할', '할ㅇ', '할이', '할일'],
    event: ['ㅇ', '이', '일', '일ㅈ', '일저', '일정'],
    memo: ['ㅁ', '메', '멤', '메모'],
    idea: ['ㅇ', '아', '앙', '아이', '아읻', '아이디', '아이딩', '아이디어'],
    link: ['ㄹ', '리', '링', '링ㅋ', '링크'],
    status: ['ㅅ', '사', '상', '상ㅌ', '상태'],
    help: ['ㄷ', '도', '동', '도우', '도움', '도움ㅁ', '도움마', '도움말']
  };
  for (const [name, qs] of Object.entries(steps)) {
    for (const q of qs) {
      const hit = CMD.match(q).find((x) => x.name === name);
      assert.ok(hit, `${q} → ${name}`);
      assert.equal(hit.token, '/' + CMD.get(name).ko[0], q);   // 한글로 맞으면 한글 토큰
    }
    // 다 친 이름은 exact 이고 맨 앞
    const full = CMD.match(qs[qs.length - 1]);
    assert.equal(full[0].name, name);
    assert.equal(full[0].exact, true);
  }
  // 여러 명령이 맞으면 표 순서
  assert.deepEqual(names(CMD.match('ㅇ')), ['event', 'idea']);
});

test('27. 자모 분해: NFD 입력도 같고, 겹모음도 둘로 풀며, 슬래시를 붙인 질의도 같은 결과', () => {
  assert.equal(CMD._jamo('할일'.normalize('NFD')), 'ㅎㅏㄹㅇㅣㄹ');
  assert.equal(CMD._jamo('과'), 'ㄱㅗㅏ');
  assert.equal(CMD._jamo('ㄺ'), 'ㄹㄱ');
  assert.equal(CMD._jamo(null), '');
  assert.deepEqual(CMD.match('/할'), CMD.match('할'));
  assert.deepEqual(CMD.match('할'.normalize('NFD')), CMD.match('할'));
  assert.deepEqual(CMD.match('ㄺ'), []);
  assert.deepEqual(names(CMD.match('NO')), ['memo']);       // 영어 별칭으로 맞으면 그 별칭이 토큰
  assert.equal(CMD.match('NO')[0].token, '/note');
  assert.deepEqual(CMD.match('NO')[0].alt, ['/메모', '/memo', '/m']);
});

test('28. suggestFor: 한 글자 짧은 형태로는 넘겨짚지 않고, 둘 이상 걸리면 null', () => {
  const rows = [
    ['tood', 'todo'], ['tdo', 'todo'], ['evnet', 'event'], ['stauts', 'status'], ['hlep', 'help'],
    ['memos', 'memo'], ['notes', 'memo'], ['links', 'link'], ['메모장', 'memo'], ['일정표', 'event'], ['할일이', 'todo'],
    ['sale', null], ['test', null], ['ai', null], ['hi', null],   // t·s·h 로 시작할 뿐인 글
    ['일', null],                                                  // 일정(앞부분)·할일(거리 1) 둘 다 걸림
    ['?', null], ['??', null]
  ];
  for (const [t, want] of rows) assert.equal(CMD.suggestFor(t), want, t);
});

test('29. parse 가장자리: // 하나만, 전각 이스케이프, 이름 뒤 슬래시, 줄 끝 \\r\\n', () => {
  const a = CMD.parse('//');
  assert.equal(a.escaped, true);
  assert.equal(a.args, '/');
  const b = CMD.parse('／／할일 x');
  assert.equal(b.escaped, true);
  assert.equal(b.args, '／할일 x');
  const c = CMD.parse('/todo/x');
  assert.equal(c.command, null);
  assert.equal(c.unknown, null);
  assert.equal(CMD.parse('/할일\r\n우유\r\n').args, '우유');
  // 이름 뒤 쌍점은 하나만 뗀다
  assert.equal(CMD.parse('/메모::)').args, ':)');
  // NFD 로 친 토큰은 NFC 로 돌려준다 (그리는 쪽이 같은 글자로 보이게)
  assert.equal(CMD.parse('/' + '할일'.normalize('NFD') + ' 우유').token, '/할일');
});
