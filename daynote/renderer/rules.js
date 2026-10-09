'use strict';

// 두 앱(데스크톱·안드로이드)이 똑같이 지켜야 하는 "규칙"만 모아 둔 곳.
// 파일 인코딩, 줄 시각 기록, 체크박스 토글.
//
// 여기 있는 함수들은 CodeMirror도 Electron도 모른다. 문자열과 배열만 다룬다.
// 그래야 브라우저 밖(Node)에서 그대로 돌려볼 수 있고, 안드로이드 앱이 같은
// 규칙을 구현했는지 같은 입력·출력 표로 검증할 수 있다.
//
// 이 파일의 동작을 바꾸면 conformance/ 의 기대값도 함께 바뀌어야 한다.
// 두 앱이 조용히 갈라지는 것을 막는 것이 이 파일의 존재 이유다.

(function (factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.rules = api;
})(function () {

  // FNV-1a 32비트. 자바스크립트의 charCodeAt(UTF-16 코드 유닛) 단위로 돈다.
  // 코드 포인트 단위로 돌면 이모지에서 값이 달라지므로 반드시 코드 유닛이어야 한다.
  function hashLine(text) {
    var h = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16);
  }

  // 저장해 둔 시각을 지금 문서의 줄에 다시 붙인다.
  //
  //   lines   : 현재 문서의 줄 문자열 배열
  //   entries : [[줄번호, 시각(ms), 줄해시], ...]
  //   반환    : [[줄번호, 시각], ...] — 줄번호 오름차순, 한 줄에 하나
  //
  // 2단계다. 먼저 저장된 자리의 내용이 그대로면 그 자리에 붙이고,
  // 어긋난 것만 모아 같은 해시를 가진 줄 중 원래 번호에 가장 가까운 곳에 붙인다.
  // 거리가 같으면 줄 번호가 작은 쪽이 이긴다(후보를 0번부터 훑고 동점일 때 갱신하지 않는다).
  function reattach(lines, entries) {
    var out = [];
    if (!entries || !entries.length) return out;

    var byHash = Object.create(null);
    var used = Object.create(null);
    for (var l = 0; l < lines.length; l++) {
      var key = hashLine(lines[l]);
      (byHash[key] || (byHash[key] = [])).push(l);
    }

    function claim(line, time) {
      if (used[line]) return;
      used[line] = true;
      out.push([line, time]);
    }

    var rest = [];
    entries.forEach(function (e) {
      if (e[0] < lines.length && !used[e[0]] && hashLine(lines[e[0]]) === e[2]) claim(e[0], e[1]);
      else rest.push(e);
    });

    rest.forEach(function (e) {
      var cands = byHash[e[2]];
      if (!cands) return;
      var best = -1, gap = Infinity;
      for (var k = 0; k < cands.length; k++) {
        if (used[cands[k]]) continue;
        var d = Math.abs(cands[k] - e[0]);
        if (d < gap) { gap = d; best = cands[k]; }
      }
      if (best >= 0) claim(best, e[1]);
    });

    out.sort(function (a, b) { return a[0] - b[0]; });
    return out;
  }

  // 체크박스 토글을 "이 줄의 몇 번째 글자부터 몇 번째 글자까지를 무엇으로 바꾼다"로 돌려준다.
  // 편집기는 이 지시대로만 고치고, 테스트는 applyEdit 으로 결과 문자열을 만든다.
  // 정규식으로 줄을 잘라 다시 조립하면 `-  [ ]   할일` 의 여분 공백이 사라진다.
  // 사용자가 쓴 공백을 앱이 정리하면 안 되므로 언제나 최소 구간만 바꾼다.
  function checkboxEdit(line) {
    if (/^\s*#{1,6}\s/.test(line)) return null;                       // 제목 줄은 건드리지 않는다

    var task = /^(\s*)([-*+]|\d+[.)])(\s+)\[([ xX])\]/.exec(line);
    if (task) {
      var at = task[1].length + task[2].length + task[3].length + 1;  // 여는 대괄호 다음 칸
      return { from: at, to: at + 1, text: /[xX]/.test(task[4]) ? ' ' : 'x' };
    }

    var list = /^(\s*)([-*+]|\d+[.)])(\s+)/.exec(line);
    if (list) return { from: list[0].length, to: list[0].length, text: '[ ] ' };

    var indent = /^\s*/.exec(line)[0];
    return { from: indent.length, to: indent.length, text: '- [ ] ' };
  }

  function applyEdit(line, edit) {
    if (!edit) return line;
    return line.slice(0, edit.from) + edit.text + line.slice(edit.to);
  }


  // ------------------------------------------------------------ 파일 인코딩
  // 사용자의 파일을 우리 취향대로 바꾸지 않는다.
  // 읽을 때 원래 모습(BOM, 줄바꿈 종류)을 따로 기억해 두고, 저장할 때 그대로 되돌린다.
  //
  // 편집기 안에서는 항상 \n 하나로 통일해서 다룬다. 섞여 있는 파일은 많은 쪽으로 모은다 —
  // 한 파일 안에 \r\n 과 \n 이 섞여 있으면 어차피 무언가는 바뀌어야 하고,
  // 그럴 땐 그 파일의 대세를 따르는 편이 놀라움이 적다.
  function decodeText(raw) {
    var bom = false;
    var text = String(raw == null ? '' : raw);
    if (text.charCodeAt(0) === 0xFEFF) { bom = true; text = text.slice(1); }

    var crlf = (text.match(/\r\n/g) || []).length;
    var lf = (text.match(/\n/g) || []).length - crlf;
    var cr = (text.match(/\r(?!\n)/g) || []).length;

    var eol = '\n';
    if (crlf > lf && crlf >= cr) eol = '\r\n';
    else if (cr > lf && cr > crlf) eol = '\r';

    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return { text: text, eol: eol, bom: bom };
  }

  function encodeText(text, meta) {
    var eol = (meta && meta.eol) || '\n';
    var out = String(text == null ? '' : text);
    if (eol !== '\n') out = out.replace(/\n/g, eol);
    if (meta && meta.bom) out = '\uFEFF' + out;
    return out;
  }


  // ---------------------------------------------------------------- 태그
  // 본문에 흩어져 있는 #태그. 제목(# 뒤 공백)과 코드 안은 태그가 아니다.
  // 데스크톱 메인 프로세스와 화면 양쪽이 같은 규칙을 써야 "패널에는 보이는데
  // 검색에는 안 잡히는 태그" 같은 어긋남이 안 생긴다.
  var TAG_RE = /(^|[\s(\[{,])#([\p{L}\p{N}_\/-]{1,60})/gu;

  function tagsIn(text) {
    var found = [];
    var lines = String(text == null ? '' : text).split(/\r\n|\r|\n/);
    var inFence = false;
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; continue; }
      if (inFence) continue;
      var line = raw.replace(/`[^`]*`/g, ' ');     // 인라인 코드 안은 제외
      var m;
      TAG_RE.lastIndex = 0;
      while ((m = TAG_RE.exec(line)) !== null) {
        if (/^\d+$/.test(m[2])) continue;          // #3 같은 숫자는 태그가 아니다
        if (found.indexOf(m[2]) === -1) found.push(m[2]);
      }
    }
    return found;
  }

  return {
    tagsIn: tagsIn,
    decodeText: decodeText,
    encodeText: encodeText,
    hashLine: hashLine,
    reattach: reattach,
    checkboxEdit: checkboxEdit,
    applyEdit: applyEdit
  };
});
