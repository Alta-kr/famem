'use strict';

// 슬래시 명령어 — 명령어 표(COMMANDS) · 해석(parse) · 자동완성(match) · 비슷한 명령 찾기(suggestFor).
// 의존성이 없다: 홈 입력창·빠른 메모 창·Ctrl+N 이 같은 규칙을 쓰고, 빠른 메모 창은 window.Daynote 말고는 아무 전역도 없이 이 파일을 불러 쓴다.
// 순수 함수만 둔다. 상태도 입력도 바꾸지 않는다.
// 불변 규칙:
//  - 명령은 글 맨 앞(앞 공백 제외)에서만 본다. `우유 /todo` 는 일반 글이다.
//  - 이름 뒤에 공백·`:`·`：`·끝이 와야만 명령이다(`/todox` ✗, `/todo:` ✓, `/할 일이` ✗).
//  - `//` 로 시작하면 이스케이프: `/` 하나를 떼고 일반 글로 둔다.
//  - 명령어는 "종류"를 정할 뿐이다. 본문을 어떻게 저장할지는 부르는 쪽(assistant·capture·quick)이 정한다.

(function (factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.commands = api; }
})(function () {
  // ------------------------------------------------------------------ 명령어 표 (이 순서 = 목록 순서)
  // ko: 한글 이름들(첫째가 대표), en: [영어 이름(= name), 영어 별칭…], short: 짧은 형태.
  // kind: 이 명령이 정하는 종류(상태·도움말은 null). needsArgs: 본문이 있어야 하는 명령. noArgs: 자동완성에서 Enter 로 바로 실행(도움말만).
  var COMMANDS = [
    { name: 'todo', kind: 'task', ko: ['할일', '할 일'], en: ['todo', 'task'], short: ['t'], icon: 'task',
      desc: '할 일로 적어요', example: '/할일 내일까지 견적서 보내기', needsArgs: true, noArgs: false },
    { name: 'event', kind: 'event', ko: ['일정'], en: ['event'], short: ['e'], icon: 'calendar',
      desc: '일정으로 적어요', example: '/일정 금요일 오후 3시 치과', needsArgs: true, noArgs: false },
    { name: 'memo', kind: 'memo', ko: ['메모'], en: ['memo', 'note'], short: ['m'], icon: 'note',
      desc: '메모로만 남겨요 (할 일을 만들지 않아요)', example: '/메모 회의 분위기 좋았음', needsArgs: true, noArgs: false },
    { name: 'idea', kind: 'idea', ko: ['아이디어'], en: ['idea'], short: ['i'], icon: 'idea',
      desc: '아이디어로 남겨요', example: '/아이디어 온보딩에 퀴즈 넣기', needsArgs: true, noArgs: false },
    { name: 'link', kind: 'link', ko: ['링크'], en: ['link'], short: ['l'], icon: 'link',
      desc: '링크로 남겨요', example: '/링크 https://… 나중에 읽기', needsArgs: true, noArgs: false },
    { name: 'status', kind: null, ko: ['상태'], en: ['status'], short: ['s'], icon: 'clock',
      desc: '지금 상태를 바꿔요', example: '/상태 회의 중', needsArgs: false, noArgs: false },
    { name: 'help', kind: null, ko: ['도움말'], en: ['help'], short: ['h', '?'], icon: 'command',
      desc: '명령어 목록을 보여 줘요', example: '/도움말', needsArgs: false, noArgs: true }
  ];

  // ------------------------------------------------------------------ 문자열 도우미
  function str(v) { return v == null ? '' : String(v); }
  function nfc(s) { return typeof s.normalize === 'function' ? s.normalize('NFC') : s; }
  function isSlash(ch) { return ch === '/' || ch === '／'; }
  function isBoundary(ch) { return ch === '' || ch === ':' || ch === '：' || /\s/.test(ch); }

  // 명령 하나의 모든 이름, 순서 = [한글들, 영어 이름, 영어 별칭, 짧은 형태] (자동완성 판정 순서)
  function namesOf(c) { return c.ko.concat(c.en, c.short); }
  // 대표 형태(목록·도움말에 보이는 것): 첫 한글 · 영어 이름 · 짧은 형태들. '할 일' 같은 띄어 쓴 별칭과 영어 별칭은 뺀다
  function repsOf(c) { return ['/' + c.ko[0], '/' + c.name].concat(c.short.map(function (s) { return '/' + s; })); }

  // ------------------------------------------------------------------ 한글 자모 분해 (자동완성 앞부분 비교용)
  // 조합 중인 '/ㅎ' '/하' '/할' '/할ㅇ' '/멤'(→메모) 이 모두 맞도록 음절을 초·중·종성 호환 자모로 풀고,
  // 겹받침(ㄳ ㄵ ㄶ ㄺ ㄻ ㄼ ㄽ ㄾ ㄿ ㅀ ㅄ)과 겹모음(ㅘ ㅙ ㅚ ㅝ ㅞ ㅟ ㅢ)도 둘로 푼다(조합 도중의 글자와도 맞게).
  var CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
  var JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
  var JONG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
  var SPLIT = {
    'ㄳ': 'ㄱㅅ', 'ㄵ': 'ㄴㅈ', 'ㄶ': 'ㄴㅎ', 'ㄺ': 'ㄹㄱ', 'ㄻ': 'ㄹㅁ', 'ㄼ': 'ㄹㅂ', 'ㄽ': 'ㄹㅅ', 'ㄾ': 'ㄹㅌ', 'ㄿ': 'ㄹㅍ', 'ㅀ': 'ㄹㅎ', 'ㅄ': 'ㅂㅅ',
    'ㅘ': 'ㅗㅏ', 'ㅙ': 'ㅗㅐ', 'ㅚ': 'ㅗㅣ', 'ㅝ': 'ㅜㅓ', 'ㅞ': 'ㅜㅔ', 'ㅟ': 'ㅜㅣ', 'ㅢ': 'ㅡㅣ'
  };
  function splitJamo(j) { return SPLIT[j] || j; }

  function _jamo(s) {
    s = nfc(str(s));
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i), code = s.charCodeAt(i);
      if (code >= 0xAC00 && code <= 0xD7A3) {
        var idx = code - 0xAC00;
        out += CHO.charAt(Math.floor(idx / 588)) + splitJamo(JUNG.charAt(Math.floor((idx % 588) / 28))) + splitJamo(JONG[idx % 28]);
      } else {
        out += splitJamo(ch);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ 미리 만든 표
  // 해석용: 모든 이름(소문자)을 긴 것부터. 길이가 같으면 표 순서.
  var BY_LENGTH = [];
  // 자동완성용: 명령마다 이름과 그 자모 열쇠
  var KEYS = [];
  COMMANDS.forEach(function (c, ci) {
    var names = namesOf(c);
    KEYS.push(names.map(function (n) { return { name: n, key: _jamo(n.toLowerCase()) }; }));
    names.forEach(function (n, ni) { BY_LENGTH.push({ name: n.toLowerCase(), cmd: c, order: ci * 100 + ni }); });
  });
  BY_LENGTH.sort(function (a, b) { return (b.name.length - a.name.length) || (a.order - b.order); });

  var UNKNOWN_RE = /^[A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ?]{1,15}(?=[\s:：]|$)/;

  function get(name) {
    var n = str(name).toLowerCase();
    for (var i = 0; i < COMMANDS.length; i++) if (COMMANDS[i].name === n) return COMMANDS[i];
    return null;
  }

  // ------------------------------------------------------------------ 해석
  // parse(text) → { command, kind, args, raw, token, unknown, escaped }
  //  args: 명령 뒤 본문(맨 앞 `:` 하나와 앞 공백을 떼고 끝 공백을 지움, 안쪽 줄바꿈은 그대로).
  //        명령이 없으면 원문(앞뒤 공백 제거), 이스케이프면 `/` 하나 뗀 원문.
  //  token: 사용자가 친 그대로의 명령 토큰('/TODO', '／할일'). unknown: 명령처럼 보이지만 없는 토큰('todos').
  function parse(text) {
    var raw = str(text);
    var s = nfc(raw).replace(/^\s+/, '');
    var out = { command: null, kind: null, args: s.trim(), raw: raw, token: null, unknown: null, escaped: false };
    if (!isSlash(s.charAt(0))) return out;
    if (isSlash(s.charAt(1))) { out.escaped = true; out.args = s.slice(1).trim(); return out; }
    var head = s.slice(1);
    for (var i = 0; i < BY_LENGTH.length; i++) {
      var n = BY_LENGTH[i].name;
      if (head.slice(0, n.length).toLowerCase() !== n) continue;
      if (!isBoundary(head.charAt(n.length))) continue;
      var c = BY_LENGTH[i].cmd;
      out.command = c.name;
      out.kind = c.kind;
      out.token = s.slice(0, 1 + n.length);
      out.args = head.slice(n.length).replace(/^[:：]/, '').replace(/^\s+/, '').replace(/\s+$/, '');
      return out;
    }
    var m = UNKNOWN_RE.exec(head);
    if (m) out.unknown = m[0];
    return out;
  }

  // ------------------------------------------------------------------ 자동완성
  // match(query) → [{ name, kind, token, alt, desc, example, icon, noArgs, exact }]
  //  query = '/' 뒤 글자. 자모 분해 앞부분 일치. 명령마다 [한글들, 영어 이름, 영어 별칭, 짧은 형태] 중 처음 맞는 이름으로 판정한다.
  //  exact(질의가 그 명령의 어떤 이름과 정확히 같음) 먼저, 나머지는 표 순서.
  function match(query) {
    var q = nfc(str(query)).toLowerCase();
    if (isSlash(q.charAt(0))) q = q.slice(1);              // '/할' 처럼 슬래시까지 넘겨도 같은 결과
    var qk = _jamo(q);
    var exact = [], rest = [];
    COMMANDS.forEach(function (c, ci) {
      var keys = KEYS[ci], hit = null, isExact = false;
      for (var i = 0; i < keys.length; i++) {
        if (hit === null && keys[i].key.indexOf(qk) === 0) hit = keys[i].name;
        if (qk && keys[i].key === qk) isExact = true;
      }
      if (hit === null) return;
      var token;
      if (!q) token = '/' + c.ko[0];                                                // 빈 질의 → 한글
      else if (hit.length === 1 && c.short.indexOf(hit) >= 0) token = '/' + c.name; // 한 글자 짧은 형태 → 영어 이름
      else token = '/' + hit;
      var item = {
        name: c.name, kind: c.kind, token: token,
        alt: repsOf(c).filter(function (r) { return r !== token; }),
        desc: c.desc, example: c.example, icon: c.icon, noArgs: c.noArgs, exact: isExact
      };
      (isExact ? exact : rest).push(item);
    });
    return exact.concat(rest);
  }

  // ------------------------------------------------------------------ 비슷한 명령 (없는 명령에 '혹시 …' 안내용)
  // 편집 거리(인접한 두 글자 바꿈도 한 번으로 센다). 1 을 넘으면 정확한 값 대신 2 를 돌려준다.
  function distance(a, b) {
    if (Math.abs(a.length - b.length) > 1) return 2;
    var d = [], i, j;
    for (i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (j = 1; j <= b.length; j++) d[0][j] = j;
    for (i = 1; i <= a.length; i++) {
      for (j = 1; j <= b.length; j++) {
        var v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
        if (i > 1 && j > 1 && a.charAt(i - 1) === b.charAt(j - 2) && a.charAt(i - 2) === b.charAt(j - 1)) v = Math.min(v, d[i - 2][j - 2] + 1);
        d[i][j] = v;
      }
    }
    return d[a.length][b.length];
  }

  // suggestFor(token) → name | null
  //  이름 중 편집 거리 1 이하이거나 한쪽이 다른 쪽의 앞부분인 것이 정확히 한 명령에만 있으면 그 name.
  //  한 글자 짧은 형태(t·e·m·i·l·s·h·?)는 비교하지 않는다 — 넣으면 그 글자로 시작하는 거의 모든 토큰이 걸린다.
  function suggestFor(token) {
    var t = nfc(str(token)).toLowerCase();
    if (isSlash(t.charAt(0))) t = t.slice(1);
    if (!t) return null;
    var found = [];
    COMMANDS.forEach(function (c) {
      var near = namesOf(c).some(function (name) {
        var n = name.toLowerCase();
        if (n.length < 2) return false;
        return n.indexOf(t) === 0 || t.indexOf(n) === 0 || distance(n, t) <= 1;
      });
      if (near) found.push(c.name);
    });
    return found.length === 1 ? found[0] : null;
  }

  return { COMMANDS: COMMANDS, get: get, parse: parse, match: match, suggestFor: suggestFor, _jamo: _jamo };
});
