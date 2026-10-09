// 라이브 프리뷰 마크다운 엔진
// createEditor(textarea) → { cm, decorate }
// 커서가 닿은 블록/토큰만 원문을 드러내고 나머지는 렌더링 상태로 유지한다.
window.createEditor = function (textarea) {
  var INDENT = '  ';
  var Pos = CodeMirror.Pos;

  var LIST_RE = /^(\s*)(>[> ]*|[*+-] \[[ xX]\] |[*+-] |(\d+)([.)]) )(\s*)/;

  // Ctrl+L 용. 머리표까지만 떼어 본다 (본문은 건드리지 않는다).
  var TASK_HEAD_RE = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)\[[ xX]\][ \t]?/;
  var LIST_HEAD_RE = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)/;

  function insideFence(cm, lineNo) {
    var count = 0;
    for (var i = 0; i < lineNo; i++) if (/^\s*```/.test(cm.getLine(i))) count++;
    return count % 2 === 1;
  }

  function continueList(cm) {
    if (cm.somethingSelected()) return CodeMirror.Pass;
    var cur = cm.getCursor();
    var line = cm.getLine(cur.line);
    var match = LIST_RE.exec(line);
    if (!match || insideFence(cm, cur.line)) return CodeMirror.Pass;

    var indent = match[1];
    var rest = line.slice(match[0].length);

    if (!rest.trim() && cur.ch >= match[0].length) {
      if (indent.length >= INDENT.length) {
        cm.replaceRange('', Pos(cur.line, 0), Pos(cur.line, INDENT.length));
      } else {
        cm.replaceRange('', Pos(cur.line, 0), Pos(cur.line, line.length));
      }
      return;
    }

    var bullet = match[3]
      ? (parseInt(match[3], 10) + 1) + match[4] + ' '
      : match[2].replace(/\[[xX]\]/, '[ ]');
    cm.replaceSelection('\n' + indent + bullet, 'end');
  }

  function indentLine(cm) {
    if (cm.somethingSelected()) { cm.indentSelection('add'); return; }
    var cur = cm.getCursor();
    var line = cm.getLine(cur.line);
    if (LIST_RE.test(line)) {
      cm.replaceRange(INDENT, Pos(cur.line, 0));
      cm.setCursor(Pos(cur.line, cur.ch + INDENT.length));
    } else {
      cm.replaceSelection(INDENT, 'end');
    }
  }

  function outdentLine(cm) {
    if (cm.somethingSelected()) { cm.indentSelection('subtract'); return; }
    var cur = cm.getCursor();
    var line = cm.getLine(cur.line);
    var m = line.match(/^(  |\t)/);
    if (!m) return;
    cm.replaceRange('', Pos(cur.line, 0), Pos(cur.line, m[0].length));
    cm.setCursor(Pos(cur.line, Math.max(0, cur.ch - m[0].length)));
  }

  function wrapWith(marker) {
    return function (cm) {
      var sel = cm.getSelection();
      if (sel) {
        var bare = marker + marker;
        if (sel.slice(0, marker.length) === marker && sel.slice(-marker.length) === marker && sel.length > bare.length - 1) {
          cm.replaceSelection(sel.slice(marker.length, sel.length - marker.length), 'around');
        } else {
          cm.replaceSelection(marker + sel + marker, 'around');
        }
      } else {
        var cur = cm.getCursor();
        cm.replaceRange(marker + marker, cur);
        cm.setCursor(Pos(cur.line, cur.ch + marker.length));
      }
    };
  }

  function insertLink(cm) {
    var sel = cm.getSelection();
    var cur = cm.getCursor('from');
    if (sel) {
      cm.replaceSelection('[' + sel + ']()');
      cm.setCursor(Pos(cur.line, cur.ch + sel.length + 3));
    } else {
      cm.replaceRange('[]()', cur);
      cm.setCursor(Pos(cur.line, cur.ch + 1));
    }
  }

  // 괄호·따옴표 자동 짝맞춤 (옵시디언 기본 동작)
  var PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };

  function autoPair(openCh) {
    return function (cm) {
      var closeCh = PAIRS[openCh];
      var sel = cm.getSelection();
      if (sel) { cm.replaceSelection(openCh + sel + closeCh, 'around'); return; }
      var cur = cm.getCursor();
      cm.replaceRange(openCh + closeCh, cur);
      cm.setCursor(Pos(cur.line, cur.ch + 1));
    };
  }

  // 닫는 기호를 직접 치면 이미 있는 짝 위로 건너뛴다
  function skipClose(closeCh) {
    return function (cm) {
      if (cm.somethingSelected()) return CodeMirror.Pass;
      var cur = cm.getCursor();
      if (cm.getLine(cur.line).charAt(cur.ch) === closeCh) { cm.setCursor(Pos(cur.line, cur.ch + 1)); return; }
      return CodeMirror.Pass;
    };
  }

  // `-[]` `-[x]` 처럼 공백 없이 적어도 표준 체크박스 문법으로 펴준다.
  // 파일에는 항상 `- [ ] ` 형태로 저장되므로 다른 마크다운 도구와 호환된다.
  var SHORT_TASK_RE = /^(\s*)([-*+]|\d+[.)])\s*\[([ xX]?)\]$/;

  function expandCheckbox(cm) {
    var cur = cm.getCursor();
    var before = cm.getLine(cur.line).slice(0, cur.ch);
    var m = SHORT_TASK_RE.exec(before);
    if (!m) return;
    var mark = m[3].trim() ? m[3] : ' ';
    var standard = m[1] + m[2] + ' [' + mark + ']';
    // 이미 표준 형태로 쳤다면 손대지 않는다 (뒤 공백을 두 번 넣지 않기 위해)
    if (before === standard) return;
    cm.replaceRange(standard + ' ', Pos(cur.line, 0), Pos(cur.line, cur.ch));
  }

  // 닫는 대괄호는 짝 건너뛰기와 체크박스 펴기를 함께 처리한다
  function closeBracket(cm) {
    if (cm.somethingSelected()) return CodeMirror.Pass;
    var cur = cm.getCursor();
    if (cm.getLine(cur.line).charAt(cur.ch) === ']') {
      cm.setCursor(Pos(cur.line, cur.ch + 1));
    } else {
      cm.replaceSelection(']', 'end');
    }
    expandCheckbox(cm);
  }

  // 목록 머리표 바로 뒤에서 Backspace를 누르면 머리표를 통째로 지운다
  function smartBackspace(cm) {
    if (cm.somethingSelected()) return CodeMirror.Pass;
    var cur = cm.getCursor();
    var line = cm.getLine(cur.line);
    var m = LIST_RE.exec(line);
    if (!m || cur.ch !== m[0].length) return CodeMirror.Pass;
    cm.replaceRange('', Pos(cur.line, m[1].length), Pos(cur.line, m[0].length));
  }

  // ----------------------------------------------------- 옵시디언식 편집 명령
  // 무엇을 바꿀지는 lineTimes.js 가 정하고, 여기서는 그대로 적용만 한다.
  // 규칙을 두 곳에 두면 안드로이드 앱과 맞출 기준이 흐려진다.
  function toggleCheckbox(cm) {
    var cur = cm.getCursor();
    var edit = window.rules.checkboxEdit(cm.getLine(cur.line));
    if (!edit) return;
    cm.replaceRange(edit.text, Pos(cur.line, edit.from), Pos(cur.line, edit.to));
  }

  // Ctrl+L — 지금 줄(또는 선택한 줄 전부)을 체크박스 항목으로 만든다.
  // 이미 전부 체크박스이면 체크 표시만 벗겨 보통 목록으로 되돌린다. 본문 글자는
  // 어떤 경우에도 건드리지 않는다. 체크 여부를 바꾸는 것은 Ctrl+Enter 쪽이다.
  function insertCheckbox(cm) {
    var from = cm.getCursor('from'), to = cm.getCursor('to');
    var first = from.line, last = to.line;
    var lines = [], i;
    for (i = first; i <= last; i++) lines.push(cm.getLine(i));

    var allTask = true;
    for (i = 0; i < lines.length; i++) {
      if (!TASK_HEAD_RE.test(lines[i])) { allTask = false; break; }
    }

    var grew = 0;   // 커서가 있는 줄에서 앞쪽이 몇 글자 늘었는지
    cm.operation(function () {
      for (var k = lines.length - 1; k >= 0; k--) {
        var lineNo = first + k, text = lines[k], m, delta;
        if (allTask) {
          m = TASK_HEAD_RE.exec(text);
          var headLen = m[1].length + m[2].length + m[3].length;
          cm.replaceRange('', Pos(lineNo, headLen), Pos(lineNo, m[0].length));
          delta = headLen - m[0].length;
        } else if ((m = LIST_HEAD_RE.exec(text))) {
          cm.replaceRange('[ ] ', Pos(lineNo, m[0].length), Pos(lineNo, m[0].length));
          delta = 4;
        } else {
          var indent = /^[ \t]*/.exec(text)[0];
          cm.replaceRange('- [ ] ', Pos(lineNo, indent.length), Pos(lineNo, indent.length));
          delta = 6;
        }
        if (lineNo === to.line) grew = delta;
      }
    });

    if (first === last && !cm.somethingSelected()) {
      cm.setCursor(Pos(to.line, Math.max(0, to.ch + grew)));
    }
  }

  function setHeading(level) {
    return function (cm) {
      var cur = cm.getCursor();
      var line = cm.getLine(cur.line);
      var m = /^(#{1,6})(\s+)/.exec(line);
      var oldLen = m ? m[0].length : 0;
      var prefix = level ? new Array(level + 1).join('#') + ' ' : '';
      cm.replaceRange(prefix, Pos(cur.line, 0), Pos(cur.line, oldLen));
      cm.setCursor(Pos(cur.line, Math.max(0, cur.ch - oldLen + prefix.length)));
    };
  }

  function moveLine(dir) {
    return function (cm) {
      var cur = cm.getCursor();
      var target = cur.line + dir;
      if (target < 0 || target >= cm.lineCount()) return;
      var here = cm.getLine(cur.line);
      var there = cm.getLine(target);
      cm.operation(function () {
        cm.replaceRange(there, Pos(cur.line, 0), Pos(cur.line, here.length));
        cm.replaceRange(here, Pos(target, 0), Pos(target, there.length));
      });
      cm.setCursor(Pos(target, cur.ch));
    };
  }

  function deleteLine(cm) {
    var cur = cm.getCursor();
    if (cm.lineCount() === 1) { cm.setValue(''); return; }
    if (cur.line === cm.lineCount() - 1) {
      cm.replaceRange('', Pos(cur.line - 1, cm.getLine(cur.line - 1).length), Pos(cur.line, cm.getLine(cur.line).length));
    } else {
      cm.replaceRange('', Pos(cur.line, 0), Pos(cur.line + 1, 0));
    }
  }

  function toggleQuote(cm) {
    var cur = cm.getCursor();
    var line = cm.getLine(cur.line);
    var m = /^(\s*)(>\s?)/.exec(line);
    if (m) {
      cm.replaceRange('', Pos(cur.line, m[1].length), Pos(cur.line, m[0].length));
    } else {
      var indent = /^\s*/.exec(line)[0];
      cm.replaceRange('> ', Pos(cur.line, indent.length), Pos(cur.line, indent.length));
    }
  }

  var cm = CodeMirror.fromTextArea(textarea, {
    mode: null,
    lineWrapping: true,
    lineNumbers: false,
    viewportMargin: Infinity,
    indentUnit: 2,
    indentWithTabs: false,
    extraKeys: {
      'Enter': continueList,
      'Tab': function (c) { var r = moveCell(1)(c); return r === CodeMirror.Pass ? indentLine(c) : r; },
      'Shift-Tab': function (c) { var r = moveCell(-1)(c); return r === CodeMirror.Pass ? outdentLine(c) : r; },
      'Shift-Ctrl-Right': columnEdit('add'),
      'Shift-Cmd-Right': columnEdit('add'),
      'Shift-Ctrl-Left': columnEdit('del'),
      'Shift-Cmd-Left': columnEdit('del'),
      'Backspace': smartBackspace,
      'Ctrl-B': wrapWith('**'),
      'Cmd-B': wrapWith('**'),
      'Ctrl-I': wrapWith('*'),
      'Cmd-I': wrapWith('*'),
      'Ctrl-K': insertLink,
      'Cmd-K': insertLink,
      'Shift-Ctrl-H': wrapWith('=='),
      'Shift-Cmd-H': wrapWith('=='),
      'Ctrl-Enter': toggleCheckbox,
      'Cmd-Enter': toggleCheckbox,
      'Ctrl-L': insertCheckbox,
      'Cmd-L': insertCheckbox,
      'Shift-Ctrl-Q': toggleQuote,
      'Shift-Cmd-Q': toggleQuote,
      'Shift-Ctrl-K': deleteLine,
      'Shift-Cmd-K': deleteLine,
      'Alt-Up': moveLine(-1),
      'Alt-Down': moveLine(1),
      'Ctrl-1': setHeading(1), 'Cmd-1': setHeading(1),
      'Ctrl-2': setHeading(2), 'Cmd-2': setHeading(2),
      'Ctrl-3': setHeading(3), 'Cmd-3': setHeading(3),
      'Ctrl-4': setHeading(4), 'Cmd-4': setHeading(4),
      'Ctrl-5': setHeading(5), 'Cmd-5': setHeading(5),
      'Ctrl-6': setHeading(6), 'Cmd-6': setHeading(6),
      'Ctrl-0': setHeading(0), 'Cmd-0': setHeading(0),
      "'('": autoPair('('),
      "'['": autoPair('['),
      "'{'": autoPair('{'),
      "'\"'": autoPair('"'),
      "'`'": autoPair('`'),
      "')'": skipClose(')'),
      "']'": closeBracket,
      "'}'": skipClose('}')
    }
  });

  // 선택한 글자 위에 URL을 붙여넣으면 마크다운 링크로 만든다
  cm.on('beforeChange', function (editor, change) {
    if (change.origin !== 'paste') return;
    var pasted = change.text.join('\n');
    if (!/^https?:\/\/\S+$/.test(pasted)) return;
    var selected = editor.getRange(change.from, change.to);
    if (!selected || selected.indexOf('\n') !== -1) return;
    change.update(change.from, change.to, ['[' + selected + '](' + pasted + ')']);
  });

  // -------------------------------------------------------------- selection
  function selectionInfo() {
    var fullRaw = {}, ranges = {};
    cm.listSelections().forEach(function (sel) {
      var a = sel.anchor, h = sel.head;
      var l1 = Math.min(a.line, h.line), l2 = Math.max(a.line, h.line);
      if (l1 !== l2) {
        for (var l = l1; l <= l2; l++) fullRaw[l] = true;
      } else {
        (ranges[l1] = ranges[l1] || []).push([Math.min(a.ch, h.ch), Math.max(a.ch, h.ch)]);
      }
    });
    return { fullRaw: fullRaw, ranges: ranges };
  }

  var readingMode = false;
  var lineMetaProvider = null;
  var hoverLine = -1;
  var blockCache = null;   // 코드펜스·콜아웃 판정 결과 (내용이 바뀔 때만 다시 계산)

  function lineFocused(sel, line) {
    if (readingMode) return false;
    return !!sel.fullRaw[line] || !!sel.ranges[line];
  }

  function spanRevealed(sel, line, s, e) {
    if (readingMode) return false;
    if (sel.fullRaw[line]) return true;
    var rs = sel.ranges[line];
    if (!rs) return false;
    for (var i = 0; i < rs.length; i++) if (rs[i][0] <= e && rs[i][1] >= s) return true;
    return false;
  }

  // ------------------------------------------------------------- decoration
  // 줄 단위로 무엇을 붙였는지 기억해 두고, 상태가 달라진 줄만 다시 그린다.
  var lineClassMap = {};   // 줄번호 -> { text: [], wrap: [], background: [] }
  var lineMarks = {};      // 줄번호 -> [mark]
  var drawnKey = {};       // 줄번호 -> 마지막으로 그렸을 때의 상태 문자열
  var lastCount = -1;

  function addLineClass(lineNo, where, cls) {
    cm.addLineClass(lineNo, where, cls);
    if (!lineClassMap[lineNo]) lineClassMap[lineNo] = { text: [], wrap: [], background: [] };
    lineClassMap[lineNo][where].push(cls);
  }

  function clearLine(i) {
    var ms = lineMarks[i];
    if (ms) {
      for (var k = 0; k < ms.length; k++) ms[k].clear();
      delete lineMarks[i];
    }
    var lc = lineClassMap[i];
    if (lc) {
      lc.text.forEach(function (c) { cm.removeLineClass(i, 'text', c); });
      lc.wrap.forEach(function (c) { cm.removeLineClass(i, 'wrap', c); });
      lc.background.forEach(function (c) { cm.removeLineClass(i, 'background', c); });
      delete lineClassMap[i];
    }
    delete drawnKey[i];
  }

  function clearAll() {
    clearTables();
    Object.keys(drawnKey).forEach(function (k) { clearLine(Number(k)); });
    lineClassMap = {};
    lineMarks = {};
    drawnKey = {};
  }

  function mark(line, s, e, opts) {
    if (e <= s) return;
    var m = cm.markText(Pos(line, s), Pos(line, e), opts);
    (lineMarks[line] || (lineMarks[line] = [])).push(m);
  }

  function bookmark(line, ch, opts) {
    var m = cm.setBookmark(Pos(line, ch), opts);
    (lineMarks[line] || (lineMarks[line] = [])).push(m);
  }

  // 이 줄을 어떻게 그려야 하는지를 한 문자열로 요약한다.
  // 값이 그대로면 다시 그릴 필요가 없다.
  function lineKey(blocks, sel, i) {
    var text = cm.getLine(i);
    if (text == null) return null;
    var b = (blocks.fence[i] || '') + '|' + (blocks.body[i] ? 'b' : '') + '|' +
            (blocks.front[i] || '') + '|' + (blocks.callout[i] || '') +
            (blocks.calloutHead[i] ? 'h' : '') + (blocks.callout[i + 1] ? 'n' : '') +
            '|' + (blocks.table && blocks.table[i] !== undefined ? 't' : '');
    var sk;
    if (readingMode) sk = 'R';
    else if (sel.fullRaw[i]) sk = 'F';
    else if (sel.ranges[i]) {
      sk = sel.ranges[i].map(function (r) { return r[0] + ':' + r[1]; }).join(',');
    } else sk = '';
    var meta = (sk && sk !== 'R' && lineMetaProvider) ? (lineMetaProvider(i) || '') : '';
    return text + '\u0001' + b + '\u0001' + sk + '\u0001' + meta;
  }

  function hideOrDim(line, s, e, revealed) {
    mark(line, s, e, revealed ? { className: 'md-syntax' } : { collapsed: true });
  }

  function inlineTokens(text) {
    var consumed = new Array(text.length).fill(false);
    var tokens = [];

    function free(s, e) { for (var k = s; k < e; k++) if (consumed[k]) return false; return true; }
    function claim(s, e) { for (var k = s; k < e; k++) consumed[k] = true; }
    function push(s, e, marks, cls) {
      if (!free(s, e)) return false;
      claim(s, e);
      tokens.push({
        s: s, e: e, marks: marks, cls: cls,
        cs: marks.length ? marks[0][1] : s,
        ce: marks.length ? marks[marks.length - 1][0] : e
      });
      return true;
    }
    // 겹쳐서 버려진 후보 때문에 뒤쪽의 유효한 토큰을 놓치지 않도록,
    // 실패한 매치는 시작 지점 바로 다음에서 다시 훑는다
    function scan(re, fn) {
      re.lastIndex = 0;
      var m;
      while ((m = re.exec(text))) {
        var taken = fn(m, m.index);
        if (!taken) re.lastIndex = m.index + 1;
        else if (!m[0].length) re.lastIndex++;
      }
    }

    scan(/`([^`]+)`/g, function (m, i) {
      var s = i, e = i + m[0].length;
      return push(s, e, [[s, s + 1], [e - 1, e]], 'md-inlinecode');
    });
    scan(/\[\[([^\]]+)\]\]/g, function (m, i) {
      var s = i, e = i + m[0].length;
      return push(s, e, [[s, s + 2], [e - 2, e]], 'md-wikilink');
    });
    scan(/(\*\*\*|___)([^*_]+?)\1/g, function (m, i) {
      var s = i, e = i + m[0].length, n = m[1].length;
      return push(s, e, [[s, s + n], [e - n, e]], 'md-strong md-em');
    });
    scan(/(\*\*|__)([^*_]+?)\1/g, function (m, i) {
      var s = i, e = i + m[0].length, n = m[1].length;
      return push(s, e, [[s, s + n], [e - n, e]], 'md-strong');
    });
    scan(/==([^=]+)==/g, function (m, i) {
      var s = i, e = i + m[0].length;
      return push(s, e, [[s, s + 2], [e - 2, e]], 'md-highlight');
    });
    scan(/~~([^~]+)~~/g, function (m, i) {
      var s = i, e = i + m[0].length;
      return push(s, e, [[s, s + 2], [e - 2, e]], 'md-strike');
    });
    scan(/(\*|_)([^*_]+?)\1/g, function (m, i) {
      var s = i, e = i + m[0].length;
      return push(s, e, [[s, s + 1], [e - 1, e]], 'md-em');
    });
    scan(/\[([^\]]+)\]\(([^)]*)\)/g, function (m, i) {
      var s = i, e = i + m[0].length;
      return push(s, e, [[s, s + 1], [s + 1 + m[1].length, e]], 'md-linktext');
    });
    scan(/(^|\s)(#[^\s#][^\s]*)/g, function (m, i) {
      var s = i + m[1].length, e = s + m[2].length;
      return push(s, e, [], 'md-tag');
    });

    return tokens;
  }

  function makeBullet() {
    var span = document.createElement('span');
    span.className = 'md-bullet';
    span.textContent = '•';
    return span;
  }

  function makeCheckbox(lineNo, startCh, endCh, checked) {
    var wrap = document.createElement('span');
    wrap.className = 'md-checkbox';
    var input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', function () {
      // 정규식으로 잘라 재조립하면 대괄호 뒤 여분 공백이 사라진다 (4.1 위반).
      // checkboxEdit 이 대괄호 안 한 글자만 바꾸도록 규칙을 따른다 (rules.js).
      var edit = window.rules.checkboxEdit(cm.getLine(lineNo));
      if (!edit) return;
      cm.replaceRange(edit.text, Pos(lineNo, edit.from), Pos(lineNo, edit.to));
    });
    wrap.appendChild(input);
    return wrap;
  }

  // 콜아웃 종류를 다섯 갈래 색으로 묶는다 (옵시디언의 기본 분류를 따름)
  var CALLOUT_GROUPS = {
    note: 'note', info: 'note', todo: 'note', abstract: 'note', summary: 'note',
    tip: 'tip', hint: 'tip', success: 'tip', check: 'tip', done: 'tip',
    warning: 'warning', caution: 'warning', attention: 'warning', question: 'warning', help: 'warning',
    danger: 'danger', error: 'danger', failure: 'danger', fail: 'danger', bug: 'danger',
    quote: 'quote', cite: 'quote', example: 'quote'
  };
  var CALLOUT_ICONS = {
    note: 'M12 16v-4M12 8h.01',
    tip: 'M12 3l1.9 5.8H20l-4.9 3.6 1.9 5.8-5-3.7-5 3.7 1.9-5.8L4 8.8h6.1z',
    warning: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
    danger: 'M15 9l-6 6M9 9l6 6',
    quote: 'M7 11H4v-1a3 3 0 0 1 3-3M17 11h-3v-1a3 3 0 0 1 3-3'
  };

  function makeCalloutLabel(group, label) {
    var span = document.createElement('span');
    span.className = 'md-callout-label';
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '15'); svg.setAttribute('height', '15');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    if (group === 'note' || group === 'danger') {
      var circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', '12'); circle.setAttribute('cy', '12'); circle.setAttribute('r', '9');
      svg.appendChild(circle);
    }
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', CALLOUT_ICONS[group] || CALLOUT_ICONS.note);
    svg.appendChild(path);
    span.appendChild(svg);
    if (label) span.appendChild(document.createTextNode(label));
    return span;
  }

  // 이 에디터는 높이가 auto라서 스크롤은 바깥 상자가 맡는다.
  // 그래서 CodeMirror가 아는 뷰포트는 문서 전체다 — 실제로 보이는 줄을 직접 계산한다.
  function visibleRange() {
    var count = cm.lineCount();
    try {
      var r = cm.getWrapperElement().getBoundingClientRect();
      var top = Math.max(r.top, 0);
      var bottom = Math.min(r.bottom, window.innerHeight || r.bottom);
      if (bottom - top < 1) {
        var vp0 = cm.getViewport();
        return { from: vp0.from, to: Math.min(vp0.to, vp0.from + 200) };
      }
      var from = cm.lineAtHeight(top, 'window');
      var to = cm.lineAtHeight(bottom, 'window') + 1;
      if (!(from >= 0)) from = 0;
      if (!(to > from)) to = Math.min(count, from + 100);
      return { from: from, to: Math.min(count, to) };
    } catch (e) {
      var vp = cm.getViewport();
      return { from: vp.from, to: vp.to };
    }
  }


  // ------------------------------------------------------------------- 접기
  // 하위 레벨이 있는 제목과 목록 항목에만 왼쪽 여백에 화살표를 둔다.
  // 평소에는 없다가 그 줄에 마우스를 올렸을 때만 만들어진다 (접혀 있으면 계속 보인다).
  //
  // 화살표의 **가로 위치가 곧 레벨**이다. 라이브 프리뷰에서는 `#` 가 접혀 있어서
  // 제목 1단계와 3단계의 글자 시작점이 같다. 그래서 위치로 구분하지 않으면
  // 어느 단계를 접는 단추인지 알 수가 없다. 제목은 1단계가 가장 왼쪽,
  // 목록은 자기 들여쓰기 바로 앞자리에 놓는다.

  var HEAD_FOLD_RE = /^(#{1,6})[ \t]+\S/;
  var LIST_FOLD_RE = /^([ \t]*)([-*+]|\d+[.)])[ \t]+\S/;

  var folds = [];            // [{ mark }] — 접어 둔 구역
  var curFoldRanges = [];    // 이번 그리기에서 쓰는 {from, to} 목록
  var lastFoldKey = '';
  var lastPaint = null;    // 마지막으로 그린 범위 (마우스만 움직였을 때 화살표만 새로 그리려고)

  // 화살표 층은 CodeMirror **바깥**(.page)에 둔다. CodeMirror 의 겉껍데기는
  // overflow:hidden 이라 (스크롤바를 숨기는 음수 여백 때문에 꼭 그래야 한다)
  // 그 안에 넣으면 왼쪽으로 삐져나온 화살표가 잘려서 눌리지 않는다.
  var foldLayer = document.createElement('div');
  foldLayer.className = 'md-fold-layer';
  (function () {
    var w = cm.getWrapperElement();
    (w.parentNode || w).appendChild(foldLayer);
  })();

  // 층이 .page 에 붙어 있으면 편집기 시작 위치만큼 더해 줘야 자리가 맞는다
  function layerOffset() {
    var w = cm.getWrapperElement();
    if (foldLayer.parentNode === w) return { x: 0, y: 0 };
    return { x: w.offsetLeft || 0, y: w.offsetTop || 0 };
  }

  function indentWidth(text) {
    var n = 0;
    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i);
      if (c === '\t') n += 4;
      else if (c === ' ') n += 1;
      else break;
    }
    return n;
  }

  // 문서를 한 번 훑어 "접을 수 있는 줄" 을 모은다. 블록 판정과 같은 자리에서
  // 계산해 blockCache 에 같이 실어 두므로, 커서만 움직일 때는 다시 돌지 않는다.
  function computeFoldables(fence, body) {
    var count = cm.lineCount();
    var lines = [], i;
    for (i = 0; i < count; i++) lines.push(cm.getLine(i) || '');

    function inCode(n) { return !!(fence && fence[n]) || !!(body && body[n]); }
    function blank(n) { return !lines[n] || !lines[n].trim(); }

    var out = {};

    // 제목 — 같거나 더 높은 단계의 제목이 나오기 직전까지가 그 제목의 구역
    for (i = 0; i < count; i++) {
      if (inCode(i)) continue;
      var h = HEAD_FOLD_RE.exec(lines[i]);
      if (!h) continue;
      var level = h[1].length;
      var end = i, j;
      for (j = i + 1; j < count; j++) {
        if (!inCode(j)) {
          var h2 = HEAD_FOLD_RE.exec(lines[j]);
          if (h2 && h2[1].length <= level) break;
        }
        end = j;
      }
      while (end > i && blank(end)) end--;   // 구역 끝의 빈 줄은 접지 않는다 (사이가 붙어 보이지 않도록)
      if (end > i) out[i] = { kind: 'head', level: level, end: end, indent: 0 };
    }

    // 목록 — 자기보다 더 들여쓴 줄들이 자식
    for (i = 0; i < count; i++) {
      if (inCode(i) || out[i]) continue;
      var m = LIST_FOLD_RE.exec(lines[i]);
      if (!m) continue;
      var width = indentWidth(m[1]);
      var e = i, sawChild = false, k;
      for (k = i + 1; k < count; k++) {
        if (blank(k)) { e = k; continue; }
        if (indentWidth(lines[k]) <= width) break;
        e = k;
        sawChild = true;
      }
      while (e > i && blank(e)) e--;
      if (sawChild && e > i) {
        out[i] = { kind: 'list', level: Math.min(6, Math.floor(width / 2) + 1), end: e, indent: m[1].length };
      }
    }

    return out;
  }

  // 접힌 구역 목록. 사용자가 그 줄을 지워서 마크가 사라졌으면 여기서 정리한다.
  function foldRanges() {
    var out = [];
    for (var i = folds.length - 1; i >= 0; i--) {
      var f = folds[i].mark.find();
      if (!f) { folds.splice(i, 1); continue; }
      out.push({ from: f.from.line, to: f.to.line });
    }
    return out;
  }

  function foldHidden(n) {
    for (var i = 0; i < curFoldRanges.length; i++) {
      if (n > curFoldRanges[i].from && n <= curFoldRanges[i].to) return true;
    }
    return false;
  }

  function foldedAt(n) {
    for (var i = 0; i < curFoldRanges.length; i++) if (curFoldRanges[i].from === n) return true;
    return false;
  }

  function toggleFold(lineNo) {
    var hit = null, i;
    for (i = 0; i < folds.length; i++) {
      var f = folds[i].mark.find();
      if (f && f.from.line === lineNo) { hit = i; break; }
    }
    if (hit !== null) {
      folds[hit].mark.clear();
      folds.splice(hit, 1);
    } else {
      var targets = (blockCache && blockCache.foldable) || computeFoldables(blockCache && blockCache.fence, blockCache && blockCache.body);
      var t = targets[lineNo];
      // 커서가 구역 한가운데 있으면 그 구역을 품은 가장 가까운(= 가장 안쪽) 줄을 접는다.
      // 팔레트에서 "이 구역 접기" 를 부를 때 쓰는 길이다.
      if (!t) {
        var best = -1;
        Object.keys(targets).forEach(function (k) {
          var n = Number(k);
          if (n < lineNo && targets[n].end >= lineNo && n > best) best = n;
        });
        if (best < 0) return;
        lineNo = best;
        t = targets[best];
        for (var q = 0; q < folds.length; q++) {
          var ff = folds[q].mark.find();
          if (ff && ff.from.line === lineNo) { folds[q].mark.clear(); folds.splice(q, 1); lastFoldKey = ''; clearAll(); decorate(); return; }
        }
      }
      var head = cm.getLine(lineNo);
      var tail = cm.getLine(t.end);
      if (head == null || tail == null) return;
      var widget = document.createElement('span');
      widget.className = 'md-fold-ellipsis';
      widget.textContent = '⋯';
      widget.title = '접혀 있습니다. 화살표를 눌러 펴세요.';
      var mk = cm.markText(Pos(lineNo, head.length), Pos(t.end, tail.length), {
        replacedWith: widget,
        // 위젯이 자기 클릭을 직접 받게 두면 커서가 접힌 안쪽으로 들어가지 않는다
        handleMouseEvents: false,
        inclusiveLeft: false,
        inclusiveRight: false
      });
      folds.push({ mark: mk });
    }
    lastFoldKey = '';
    clearAll();
    decorate();
  }

  function unfoldAll() {
    if (!folds.length) return false;
    folds.forEach(function (f) { try { f.mark.clear(); } catch (e) {} });
    folds = [];
    lastFoldKey = '';
    clearAll();
    decorate();
    return true;
  }

  function foldAllHeadings() {
    var targets = computeFoldables(blockCache && blockCache.fence, blockCache && blockCache.body);
    var lines = Object.keys(targets).map(Number).filter(function (n) { return targets[n].kind === 'head'; });
    // 안쪽부터 접으면 바깥 구역이 이미 접힌 마크와 겹친다. 바깥(작은 줄번호)부터 접고,
    // 이미 감춰진 줄은 건너뛴다.
    lines.sort(function (a, b) { return a - b; });
    var made = 0;
    lines.forEach(function (n) {
      curFoldRanges = foldRanges();
      if (foldHidden(n) || foldedAt(n)) return;
      var t = targets[n];
      var head = cm.getLine(n), tail = cm.getLine(t.end);
      if (head == null || tail == null) return;
      var widget = document.createElement('span');
      widget.className = 'md-fold-ellipsis';
      widget.textContent = '⋯';
      folds.push({
        mark: cm.markText(Pos(n, head.length), Pos(t.end, tail.length), {
          replacedWith: widget, handleMouseEvents: false, inclusiveLeft: false, inclusiveRight: false
        })
      });
      made++;
    });
    lastFoldKey = '';
    clearAll();
    decorate();
    return made;
  }

  function foldButton(lineNo, t, isFolded) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'md-fold-btn' + (isFolded ? ' is-folded' : '');
    b.setAttribute('data-line', String(lineNo));
    b.setAttribute('data-level', String(t.level));
    b.setAttribute('data-kind', t.kind);
    b.setAttribute('aria-label', isFolded ? '펴기' : '접기');
    b.title = (isFolded ? '펴기' : '접기') + ' — '
      + (t.kind === 'head' ? '제목 ' + t.level + '단계' : '목록 ' + t.level + '단계');

    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M9 5l7 7-7 7');   // › — 펼쳐져 있을 때는 CSS 로 90도 돌린다
    svg.appendChild(path);
    b.appendChild(svg);

    var cc = null;
    try { cc = cm.charCoords(Pos(lineNo, t.kind === 'list' ? t.indent : 0), 'local'); } catch (e) { cc = null; }
    var off = layerOffset();
    var top = cc ? ((cc.top + cc.bottom) / 2 - 8) : cm.heightAtLine(lineNo, 'local');
    b.style.top = Math.round(top + off.y) + 'px';
    b.style.left = Math.round(foldX(t, cc) + off.x) + 'px';

    // mousedown 을 막지 않으면 CodeMirror 가 먼저 커서를 옮겨서 화살표가 사라진다
    b.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggleFold(lineNo);
    });
    return b;
  }

  // 제목은 단계마다 4px 씩 들여서, 가로 위치만 보고도 몇 단계인지 알 수 있게 한다.
  // 목록은 자기 글머리표 바로 왼쪽 — 원래 들여쓰기가 곧 레벨이다.
  function foldX(t, cc) {
    if (t.kind === 'head') return -28 + (t.level - 1) * 4;
    var left = cc ? cc.left : 0;
    return Math.max(-28, left - 18);
  }

  function paintFolds(foldable, vpFrom, vpTo) {
    if (!foldable) { foldLayer.textContent = ''; lastFoldKey = ''; return; }
    var wanted = [], i;
    for (i = vpFrom; i < vpTo; i++) {
      var t = foldable[i];
      if (!t) continue;
      if (foldHidden(i)) continue;
      var isFolded = foldedAt(i);
      if (!isFolded && hoverLine !== i) continue;   // 평소에는 없다 — 올려야 생긴다
      wanted.push({ line: i, t: t, folded: isFolded });
    }

    var key = wanted.map(function (w) { return w.line + (w.folded ? 'F' : 'o'); }).join(',');
    if (key === lastFoldKey && foldLayer.childNodes.length === wanted.length) {
      // 그림이 늦게 뜨면 줄 높이가 바뀐다. 자리만 다시 맞춘다.
      var off2 = layerOffset();
      for (i = 0; i < wanted.length; i++) {
        var node = foldLayer.childNodes[i];
        var c = null;
        try { c = cm.charCoords(Pos(wanted[i].line, wanted[i].t.kind === 'list' ? wanted[i].t.indent : 0), 'local'); } catch (e) { c = null; }
        if (c) node.style.top = Math.round((c.top + c.bottom) / 2 - 8 + off2.y) + 'px';
      }
      return;
    }
    lastFoldKey = key;
    foldLayer.textContent = '';
    wanted.forEach(function (w) { foldLayer.appendChild(foldButton(w.line, w.t, w.folded)); });
  }

  function decorate() {
    // 표시를 지우고 다시 붙이는 일을 한 번의 갱신으로 묶는다 (긴 문서에서 결정적)
    cm.operation(decorateNow);
  }

  // ---------------------------------------------------------------- 이미지
  // ![alt](경로) 와 ![[파일.png|300]] 을 그림으로 바꾼다.
  // 원격 주소(http…)는 일부러 불러오지 않는다 — 노트를 여는 것만으로 바깥에
  // 신호가 나가면 안 되기 때문이다. 볼트 안 파일과 data: 만 그린다.
  var assetResolver = null;

  function imageTokens(text) {
    var out = [], m;

    var re1 = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
    while ((m = re1.exec(text)) !== null) {
      var alt = m[1], width = null;
      var bar = /\|(\d+)\s*$/.exec(alt);
      if (bar) { width = Number(bar[1]); alt = alt.slice(0, bar.index); }
      out.push({ s: m.index, e: m.index + m[0].length, alt: alt, src: m[2].trim(), width: width });
    }

    var re2 = /!\[\[([^\]|]+)(?:\|(\d+))?\]\]/g;
    while ((m = re2.exec(text)) !== null) {
      out.push({
        s: m.index, e: m.index + m[0].length,
        alt: m[1].trim(), src: m[1].trim(), width: m[2] ? Number(m[2]) : null
      });
    }

    out.sort(function (a, b) { return a.s - b.s; });
    return out;
  }

  // 후보를 순서대로 시도한다 — 노트 옆에 있는 경우가 가장 흔하고,
  // 없으면 볼트 뿌리에서 찾는다. 다 실패하면 원문 대신 짧은 안내를 남긴다.
  function makeImage(urls, alt, width) {
    var wrap = document.createElement('span');
    wrap.className = 'md-image';
    var img = document.createElement('img');
    var at = 0;

    img.alt = alt || '';
    if (width) img.style.width = width + 'px';
    img.addEventListener('error', function () {
      at += 1;
      if (at < urls.length) { img.src = urls[at]; return; }
      wrap.textContent = '';
      wrap.classList.add('is-missing');
      wrap.textContent = '이미지 없음: ' + (alt || '');
    });
    img.src = urls[0];
    wrap.appendChild(img);
    return wrap;
  }

  // ------------------------------------------------------------------- 표
  // 마크다운 표는 원문으로 보면 읽기 힘들다. 커서가 그 블록 밖에 있을 때만
  // 진짜 표로 바꿔 보여주고, 안으로 들어오면 원문으로 되돌린다.
  // 라이브 프리뷰의 다른 요소들과 같은 원칙 — 편집 중인 곳은 늘 원문이다.
  var TABLE_ROW_RE = /^\s{0,3}\|.*\|\s*$/;
  var TABLE_SEP_RE = /^\s{0,3}\|(?:\s*:?-{1,}:?\s*\|)+\s*$/;
  var MAX_RENDERED_TABLES = 60;

  var tableMarks = {};        // 시작 줄 -> { mark, sig }
  var renderedTables = {};    // 블록 번호 -> true (지금 표로 접혀 있는가)

  function clearTables() {
    Object.keys(tableMarks).forEach(function (k) {
      try { tableMarks[k].mark.clear(); } catch (e) {}
    });
    tableMarks = {};
    renderedTables = {};
  }

  // 이스케이프한 \| 는 칸 구분이 아니다
  function splitCells(line) {
    var body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    var out = [], cur = '';
    for (var i = 0; i < body.length; i++) {
      var c = body.charAt(i);
      if (c === '\\' && body.charAt(i + 1) === '|') { cur += '|'; i += 1; continue; }
      if (c === '|') { out.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    out.push(cur.trim());
    return out;
  }

  function alignOf(spec) {
    var t = spec.trim();
    var left = t.charAt(0) === ':';
    var right = t.charAt(t.length - 1) === ':';
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return '';
  }

  // 칸 안의 간단한 마크다운만 살린다. 여기서 본격적인 파서를 부르면
  // 표 하나 그리는 데 문서 전체 규칙이 딸려 들어온다.
  function fillCell(td, text) {
    var re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*|_[^_]+_)|(\[\[([^\]|]+)(?:\|([^\]]+))?\]\])|(\[([^\]]+)\]\([^)]*\))/g;
    var at = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > at) td.appendChild(document.createTextNode(text.slice(at, m.index)));
      var el;
      if (m[1]) { el = document.createElement('code'); el.textContent = m[1].slice(1, -1); }
      else if (m[2]) { el = document.createElement('strong'); el.textContent = m[2].slice(2, -2); }
      else if (m[3]) { el = document.createElement('em'); el.textContent = m[3].slice(1, -1); }
      else if (m[4]) { el = document.createElement('span'); el.className = 'md-link'; el.textContent = m[6] || m[5]; }
      else { el = document.createElement('span'); el.className = 'md-link'; el.textContent = m[8]; }
      td.appendChild(el);
      at = m.index + m[0].length;
    }
    if (at < text.length) td.appendChild(document.createTextNode(text.slice(at)));
  }

  function buildTable(t) {
    var header = splitCells(cm.getLine(t.start));
    var aligns = splitCells(cm.getLine(t.start + 1)).map(alignOf);
    var cols = header.length;

    var wrap = document.createElement('div');
    wrap.className = 'md-table-wrap';
    var table = document.createElement('table');
    table.className = 'md-table';

    function row(cells, tag, lineNo) {
      var tr = document.createElement('tr');
      for (var c = 0; c < cols; c++) {
        var cell = document.createElement(tag);
        if (aligns[c]) cell.style.textAlign = aligns[c];
        fillCell(cell, cells[c] === undefined ? '' : cells[c]);
        // 칸을 누르면 그 줄의 원문으로 커서를 옮긴다 — 바로 고칠 수 있게.
        // 누르는 순간이 아니라 뗄 때 펼친다. 눌리자마자 펼치면 표가 사라진 자리에
        // 뒤이은 클릭이 떨어져 엉뚱한 줄로 커서가 간다.
        cell.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
        cell.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          // 접힌 구간 안으로는 커서를 놓을 수 없어서 CodeMirror가 구간 끝으로 밀어낸다.
          // 먼저 펼치고 나서 옮겨야 누른 줄에 정확히 선다.
          var held = tableMarks[t.start];
          if (held) { try { held.mark.clear(); } catch (err) {} delete tableMarks[t.start]; }
          cm.setCursor({ line: lineNo, ch: 0 });
          cm.focus();
          decorate();
        });
        tr.appendChild(cell);
      }
      return tr;
    }

    var thead = document.createElement('thead');
    thead.appendChild(row(header, 'th', t.start));
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    for (var i = t.start + 2; i <= t.end; i++) {
      tbody.appendChild(row(splitCells(cm.getLine(i)), 'td', i));
    }
    if (tbody.childNodes.length) table.appendChild(tbody);

    wrap.appendChild(table);
    return wrap;
  }

  function tableSig(t, rendered) {
    var s = rendered ? 'R' : 'S';
    for (var i = t.start; i <= t.end; i++) s += '' + cm.getLine(i);
    return s;
  }

  function applyTables(blocks, sel, vpFrom, vpTo) {
    var list = (blocks && blocks.tables) || [];
    var seen = {};
    renderedTables = {};

    for (var n = 0; n < list.length; n++) {
      var t = list[n];
      // 화면 밖 표는 손대지 않는다. 스크롤하면 다시 그리므로 지금 만들 이유가 없고,
      // 문서에 표가 수백 개면 이 비용이 커서를 옮길 때마다 그대로 쌓인다.
      if (t.end < vpFrom || t.start >= vpTo) continue;
      // 접혀서 안 보이는 표는 위젯을 만들지 않는다 (접힘 마크끼리 겹친다)
      if (curFoldRanges.length && foldHidden(t.start)) {
        if (tableMarks[t.start]) { try { tableMarks[t.start].mark.clear(); } catch (e) {} delete tableMarks[t.start]; }
        continue;
      }
      var inside = false;
      for (var i = t.start; i <= t.end && !inside; i++) {
        if (sel.fullRaw[i] || sel.ranges[i]) inside = true;
      }
      var rendered = (readingMode || !inside) && n < MAX_RENDERED_TABLES;
      if (rendered) renderedTables[n] = true;

      var sig = tableSig(t, rendered);
      seen[t.start] = true;
      var cur = tableMarks[t.start];
      if (cur && cur.sig === sig) continue;
      if (cur) { try { cur.mark.clear(); } catch (e) {} delete tableMarks[t.start]; }
      if (!rendered) continue;

      var el = buildTable(t);
      var last = cm.getLine(t.end);
      var mk = cm.markText(Pos(t.start, 0), Pos(t.end, last == null ? 0 : last.length), {
        replacedWith: el,
        // false = 위젯이 자기 마우스 이벤트를 직접 받는다 (칸을 눌러 그 줄로 가기 위해)
        handleMouseEvents: false,
        inclusiveLeft: false,
        inclusiveRight: false
      });
      tableMarks[t.start] = { mark: mk, sig: sig };
    }

    // 화면 밖으로 나간 표의 위젯은 걷어낸다
    Object.keys(tableMarks).forEach(function (k) {
      if (!seen[k]) { try { tableMarks[k].mark.clear(); } catch (e) {} delete tableMarks[k]; }
    });
  }

  // ------------------------------------------------------------- 표 편집
  // 표 원문 안에 있을 때만 Tab 이 칸을 옮긴다. 표 밖에서는 예전처럼 들여쓰기다.
  // 표 판정이 틀리면 목록 들여쓰기가 망가지므로, blockCache 의 판정을 그대로 쓴다.
  function tableAt(line) {
    if (!blockCache || !blockCache.tables) return null;
    var id = blockCache.table[line];
    if (id === undefined) return null;
    return blockCache.tables[id];
  }

  // 줄에서 칸 경계를 찾는다. 이스케이프한 \| 는 경계가 아니다.
  // 돌려주는 것은 [칸 시작, 칸 끝] 목록 (파이프 사이의 내용 구간).
  function cellSpans(line) {
    var bars = [];
    for (var i = 0; i < line.length; i++) {
      var c = line.charAt(i);
      if (c === '\\') { i += 1; continue; }
      if (c === '|') bars.push(i);
    }
    var out = [];
    for (var k = 0; k + 1 < bars.length; k++) out.push([bars[k] + 1, bars[k + 1]]);
    return out;
  }

  function selectCell(line, span) {
    // 앞뒤 공백 한 칸은 남겨 두고 안쪽만 고른다 — 사용자가 쓴 공백을 지우지 않기 위해
    var text = cm.getLine(line);
    var s = span[0], e = span[1];
    while (s < e && text.charAt(s) === ' ') s += 1;
    while (e > s && text.charAt(e - 1) === ' ') e -= 1;
    cm.setSelection(Pos(line, s), Pos(line, e));
  }

  // 구분선 줄(| --- | --- |)은 건너뛴다. 거기에 커서를 보내도 할 일이 없다.
  function isSepLine(line) {
    return TABLE_SEP_RE.test(cm.getLine(line) || '');
  }

  function moveCell(dir) {
    return function (cmInstance) {
      if (cm.somethingSelected() && cm.listSelections().length > 1) return CodeMirror.Pass;
      var cur = cm.getCursor();
      var t = tableAt(cur.line);
      if (!t) return CodeMirror.Pass;

      var spans = cellSpans(cm.getLine(cur.line));
      if (!spans.length) return CodeMirror.Pass;

      var at = -1;
      for (var i = 0; i < spans.length; i++) {
        if (cur.ch >= spans[i][0] && cur.ch <= spans[i][1]) { at = i; break; }
      }
      if (at === -1) at = dir > 0 ? -1 : spans.length;

      var next = at + dir;
      if (next >= 0 && next < spans.length) { selectCell(cur.line, spans[next]); return; }

      // 줄을 넘어간다
      var line = cur.line + dir;
      while (line >= t.start && line <= t.end && isSepLine(line)) line += dir;

      if (line < t.start) return;                     // 첫 칸에서 더 뒤로는 안 간다
      if (line > t.end) {                             // 마지막 칸에서 Tab → 새 줄 추가
        if (dir < 0) return;
        var cols = cellSpans(cm.getLine(t.end)).length || 1;
        var blank = '|' + new Array(cols + 1).join('   |');
        cm.replaceRange('\n' + blank, Pos(t.end, cm.getLine(t.end).length));
        var added = t.end + 1;
        var made = cellSpans(cm.getLine(added));
        if (made.length) selectCell(added, made[0]);
        return;
      }

      var target = cellSpans(cm.getLine(line));
      if (!target.length) return;
      selectCell(line, dir > 0 ? target[0] : target[target.length - 1]);
    };
  }

  // 열 추가/삭제. 구분선 줄도 같이 늘리고 줄여야 표가 깨지지 않는다.
  function columnEdit(mode) {
    return function () {
      var cur = cm.getCursor();
      var t = tableAt(cur.line);
      if (!t) return CodeMirror.Pass;

      var here = cellSpans(cm.getLine(cur.line));
      var at = 0;
      for (var i = 0; i < here.length; i++) {
        if (cur.ch >= here[i][0] && cur.ch <= here[i][1]) { at = i; break; }
      }

      cm.operation(function () {
        for (var line = t.end; line >= t.start; line--) {
          var text = cm.getLine(line);
          var spans = cellSpans(text);
          if (!spans.length) continue;
          var sep = isSepLine(line);

          if (mode === 'add') {
            var idx = Math.min(at + 1, spans.length);
            var insertAt = idx < spans.length ? spans[idx][0] : spans[spans.length - 1][1];
            cm.replaceRange(sep ? ' --- |' : '   |', Pos(line, insertAt), Pos(line, insertAt));
          } else {
            if (spans.length <= 1) continue;
            var idx2 = Math.min(at, spans.length - 1);
            cm.replaceRange('', Pos(line, spans[idx2][0]), Pos(line, spans[idx2][1] + 1));
          }
        }
      });
    };
  }

  function decorateNow() {
    var sel = selectionInfo();
    var count = cm.lineCount();

    // 줄이 늘거나 줄면 줄번호로 잡아둔 기록이 어긋나므로 전부 다시 그린다
    if (count !== lastCount) { clearAll(); blockCache = null; lastCount = count; }

    var range = visibleRange();
    var vpFrom = Math.max(0, range.from - 30);
    var vpTo = Math.min(count, range.to + 30);

    // 블록 판정(코드펜스·프론트매터·콜아웃)은 문서 전체를 훑어야 정확하지만
    // 커서만 움직였을 때는 결과가 그대로다. 내용이 바뀔 때만 다시 계산한다.
    if (blockCache) { applyLines(blockCache, sel, vpFrom, vpTo); return; }
    var fence = {}, body = {}, open = false;
    var i, text;

    for (i = 0; i < count; i++) {
      text = cm.getLine(i);
      if (/^\s*```/.test(text)) { fence[i] = open ? 'close' : 'open'; open = !open; }
      else if (open) body[i] = true;
    }

    // YAML 프론트매터: 첫 줄이 --- 이고 뒤에 닫는 --- 이 있을 때
    var front = {};
    if (cm.getLine(0) === '---') {
      for (i = 1; i < count; i++) {
        if (cm.getLine(i) === '---') { front[0] = 'top'; front[i] = 'bottom'; for (var f = 1; f < i; f++) front[f] = 'body'; break; }
        if (i > 40) break;
      }
    }

    // 콜아웃: > [!note] 로 시작해 이어지는 인용 줄들이 하나의 블록
    var callout = {}, calloutHead = {}, active = null;
    for (i = 0; i < count; i++) {
      if (fence[i] || body[i]) { active = null; continue; }
      text = cm.getLine(i);
      var ch = /^>\s*\[!(\w+)\]/.exec(text);
      if (ch) {
        active = CALLOUT_GROUPS[ch[1].toLowerCase()] || 'note';
        callout[i] = active;
        calloutHead[i] = true;
      } else if (active && /^>/.test(text)) {
        callout[i] = active;
      } else {
        active = null;
      }
    }

    // 표: 파이프로 시작하는 줄이 이어지고, 두 번째 줄이 |---|---| 구분선일 때 하나의 블록
    var tables = [], table = {};
    for (i = 0; i < count; i++) {
      if (fence[i] || body[i] || front[i] || callout[i]) continue;
      if (!TABLE_ROW_RE.test(cm.getLine(i))) continue;
      var sep = cm.getLine(i + 1);
      if (sep == null || !TABLE_SEP_RE.test(sep)) continue;
      var end = i + 1;
      while (end + 1 < count && TABLE_ROW_RE.test(cm.getLine(end + 1)) && !fence[end + 1] && !callout[end + 1]) end += 1;
      var blockId = tables.length;
      tables.push({ start: i, end: end });
      for (var t = i; t <= end; t++) table[t] = blockId;
      i = end;
    }

    blockCache = { fence: fence, body: body, front: front, callout: callout, calloutHead: calloutHead,
                   table: table, tables: tables, foldable: computeFoldables(fence, body) };
    applyLines(blockCache, sel, vpFrom, vpTo);
  }

  function applyLines(blocks, sel, vpFrom, vpTo) {
    // 접힌 구역 안의 줄은 아예 건드리지 않는다. 그 안에 collapsed 마크를 하나라도
    // 더 넣으면 CodeMirror 가 "겹치는 접힘" 이라며 던진다.
    curFoldRanges = foldRanges();
    applyTables(blocks, sel, vpFrom, vpTo);
    // 화면 밖으로 나간 줄의 표시는 걷어낸다
    Object.keys(drawnKey).forEach(function (k) {
      var n = Number(k);
      if (n < vpFrom || n >= vpTo) clearLine(n);
    });
    // 상태가 달라진 줄만 다시 그린다 — 커서를 옮길 때 두어 줄이면 충분하다
    for (var i = vpFrom; i < vpTo; i++) {
      if (curFoldRanges.length && foldHidden(i)) { clearLine(i); continue; }
      // 표로 접혀 있는 줄은 위젯이 대신 그린다
      if (blocks.table && blocks.table[i] !== undefined && renderedTables[blocks.table[i]]) { clearLine(i); continue; }
      var key = lineKey(blocks, sel, i);
      if (key === null || drawnKey[i] === key) continue;
      clearLine(i);
      drawLine(blocks, sel, i);
      drawnKey[i] = key;
    }
    lastPaint = { foldable: blocks.foldable, from: vpFrom, to: vpTo };
    paintFolds(blocks.foldable, vpFrom, vpTo);
  }

  function drawLine(blocks, sel, i) {
    var fence = blocks.fence, body = blocks.body, front = blocks.front;
    var callout = blocks.callout, calloutHead = blocks.calloutHead;
    var text = cm.getLine(i);
    var focused = lineFocused(sel, i);

    // 커서가 놓인 줄에 줄 메타(수정 시각)를 오른쪽 끝에 띄운다
    if (focused && lineMetaProvider) {
      var metaText = lineMetaProvider(i);
      if (metaText) {
        var metaEl = document.createElement('span');
        metaEl.className = 'md-line-time';
        metaEl.textContent = metaText;
        bookmark(i, text.length, { widget: metaEl, insertLeft: true });
      }
    }

    if (front[i]) {
      addLineClass(i, 'text', 'md-frontmatter');
      addLineClass(i, 'background', 'md-frontmatter-bg');
      addLineClass(i, 'background', front[i] === 'top' ? 'md-cb-top' : (front[i] === 'bottom' ? 'md-cb-bottom' : 'md-frontmatter-bg'));
      return;
    }

    if (callout[i]) {
      var group = callout[i];
      addLineClass(i, 'text', 'md-callout-text');
      addLineClass(i, 'background', 'md-callout');
      addLineClass(i, 'background', 'md-callout-' + group);
      if (calloutHead[i]) addLineClass(i, 'background', 'md-callout-top');
      if (!callout[i + 1]) addLineClass(i, 'background', 'md-callout-bottom');

      if (calloutHead[i]) {
        var parts = /^(>\s*)(\[!(\w+)\][+-]?\s*)(.*)$/.exec(text);
        var prefixEnd = parts[1].length + parts[2].length;
        var title = parts[4];
        if (focused) {
          mark(i, 0, prefixEnd, { className: 'md-syntax' });
          if (title) mark(i, prefixEnd, text.length, { className: 'md-callout-title' });
        } else {
          mark(i, 0, prefixEnd, {
            replacedWith: makeCalloutLabel(group, title ? '' : parts[3].charAt(0).toUpperCase() + parts[3].slice(1))
          });
          if (title) mark(i, prefixEnd, text.length, { className: 'md-callout-title' });
        }
      } else {
        var bodyPrefix = /^(>\s?)/.exec(text);
        if (bodyPrefix) hideOrDim(i, 0, bodyPrefix[0].length, focused);
        inlineTokens(text).forEach(function (t) {
          var shown = spanRevealed(sel, i, t.s, t.e);
          if (t.cls) mark(i, t.cs, t.ce, { className: t.cls });
          t.marks.forEach(function (mk) { hideOrDim(i, mk[0], mk[1], shown); });
        });
      }
      return;
    }

    if (fence[i]) {
      addLineClass(i, 'text', 'md-fence');
      addLineClass(i, 'background', 'md-codeblock-bg');
      addLineClass(i, 'background', fence[i] === 'open' ? 'md-cb-top' : 'md-cb-bottom');
      if (focused) mark(i, 0, text.length, { className: 'md-syntax' });
      else mark(i, 0, text.length, { collapsed: true });
      return;
    }
    if (body[i]) {
      addLineClass(i, 'text', 'md-codeblock');
      addLineClass(i, 'background', 'md-codeblock-bg');
      return;
    }

    // horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(text)) {
      if (focused) mark(i, 0, text.length, { className: 'md-syntax' });
      else {
        addLineClass(i, 'wrap', 'md-hr');
        mark(i, 0, text.length, { collapsed: true });
      }
      return;
    }

    // heading
    var head = text.match(/^(#{1,6})(\s+)/);
    if (head) {
      addLineClass(i, 'text', 'md-h' + head[1].length);
      hideOrDim(i, 0, head[0].length, focused);
    }

    // blockquote
    var quote = text.match(/^(\s*)(>+\s?)/);
    if (quote) {
      addLineClass(i, 'text', 'md-quote');
      addLineClass(i, 'background', 'md-quote-bg');
      hideOrDim(i, 0, quote[0].length, focused);
    }

    // list item / task
    var list = text.match(/^(\s*)([-*+]|\d+[.)])(\s+)(\[([ xX])\]\s+)?/);
    if (list) {
      var level = Math.min(Math.floor(list[1].length / 2), 6);
      addLineClass(i, 'text', 'md-list');
      if (level > 0) addLineClass(i, 'text', 'md-indent-' + level);

      var markerStart = list[1].length;
      var markerEnd = markerStart + list[2].length;

      var isTask = !!list[4];
      if (/^[-*+]$/.test(list[2])) {
        if (focused) mark(i, markerStart, markerEnd, { className: 'md-syntax' });
        // 체크박스가 있는 줄은 체크박스만 남기고 불릿을 감춘다
        else if (isTask) mark(i, markerStart, markerEnd + list[3].length, { collapsed: true });
        else mark(i, markerStart, markerEnd, { replacedWith: makeBullet() });
      } else {
        mark(i, markerStart, markerEnd, { className: 'md-list-number' });
      }

      if (list[4]) {
        var boxStart = markerEnd + list[3].length;
        var boxEnd = boxStart + list[4].length;
        var done = /[xX]/.test(list[5]);
        if (focused) mark(i, boxStart, boxEnd, { className: 'md-syntax' });
        // false = 체크박스가 자기 클릭을 직접 받는다. true로 두면 에디터가 클릭을
        // 가로채 그 자리로 커서를 옮겨버려서, 체크는 안 되고 그 줄만 원문으로 바뀐다.
        else mark(i, boxStart, boxEnd, { replacedWith: makeCheckbox(i, boxStart, boxEnd, done), handleMouseEvents: false });
        if (done) mark(i, boxEnd, text.length, { className: 'md-task-done' });
      }
    }

    // 이미지 — 커서가 그 자리에 없을 때만 그림으로 바꾼다
    var imgSpans = [];
    // 느낌표가 없으면 이미지 문법도 없다. 줄마다 정규식 두 번을 아끼는 값싼 관문이다.
    if (assetResolver && text.indexOf('!') !== -1) {
      imageTokens(text).forEach(function (img) {
        if (spanRevealed(sel, i, img.s, img.e)) return;
        var urls = assetResolver(img.src);
        if (!urls || !urls.length) return;
        imgSpans.push([img.s, img.e]);
        mark(i, img.s, img.e, {
          replacedWith: makeImage(urls, img.alt, img.width),
          handleMouseEvents: false
        });
      });
    }

    // inline tokens — revealed only where the cursor actually touches them
    // 그림으로 바뀐 구간 안은 건너뛴다. 접힌 표시가 겹치면 CodeMirror가 거부한다.
    inlineTokens(text).forEach(function (t) {
      for (var q = 0; q < imgSpans.length; q++) {
        if (t.s >= imgSpans[q][0] && t.e <= imgSpans[q][1]) return;
      }
      var revealed = spanRevealed(sel, i, t.s, t.e);
      if (t.cls) mark(i, t.cs, t.ce, { className: t.cls });
      t.marks.forEach(function (mk) { hideOrDim(i, mk[0], mk[1], revealed); });
    });
  }

  var scheduledDecorate = false;
  function scheduleDecorate() {
    if (scheduledDecorate) return;
    scheduledDecorate = true;
    requestAnimationFrame(function () { scheduledDecorate = false; decorate(); paintHover(); paintAllTimes(); });
  }

  // 마우스를 올린 줄의 수정 시각은 문서를 다시 그리지 않고
  // 떠 있는 요소 하나를 옮겨서 보여준다 (호버가 즉시 따라오도록)
  var hoverEl = document.createElement('div');
  hoverEl.className = 'md-hover-time';
  hoverEl.style.display = 'none';
  cm.getWrapperElement().appendChild(hoverEl);

  // Ctrl(또는 Cmd)을 누르고 있는 동안 보이는 모든 줄의 시각을 한꺼번에 띄운다
  var allEl = document.createElement('div');
  allEl.className = 'md-all-times';
  cm.getWrapperElement().appendChild(allEl);
  var showAll = false;

  function paintAllTimes() {
    if (!showAll || !lineMetaProvider || readingMode) {
      if (allEl.firstChild) allEl.textContent = '';
      allEl.style.display = 'none';
      return;
    }
    allEl.textContent = '';
    var r = visibleRange();
    for (var i = r.from; i < r.to; i++) {
      var t = lineMetaProvider(i);
      if (!t) continue;
      var span = document.createElement('span');
      span.className = 'md-line-time-float';
      span.textContent = t;
      span.style.top = cm.heightAtLine(i, 'local') + 'px';
      allEl.appendChild(span);
    }
    allEl.style.display = '';
  }

  function paintHover() {
    if (showAll) { hoverEl.style.display = 'none'; return; }
    if (hoverLine < 0 || !lineMetaProvider || readingMode) { hoverEl.style.display = 'none'; return; }
    if (hoverLine >= cm.lineCount()) { hoverEl.style.display = 'none'; return; }
    // 커서가 이미 그 줄에 있으면 본문에 붙은 표시와 겹치므로 생략한다
    if (cm.hasFocus() && cm.getCursor().line === hoverLine) { hoverEl.style.display = 'none'; return; }
    var text = lineMetaProvider(hoverLine);
    if (!text) { hoverEl.style.display = 'none'; return; }
    hoverEl.textContent = text;
    hoverEl.style.top = (cm.heightAtLine(hoverLine, 'local') - cm.getScrollInfo().top) + 'px';
    hoverEl.style.display = '';
  }

  cm.on('changes', function () { blockCache = null; scheduleDecorate(); });
  cm.on('cursorActivity', scheduleDecorate);
  cm.on('viewportChange', scheduleDecorate);
  cm.on('scroll', function () { paintHover(); paintAllTimes(); });

  decorate();

  return {
    cm: cm,
    decorate: decorate,
    scheduleDecorate: scheduleDecorate,
    setLineMetaProvider: function (fn) { lineMetaProvider = fn; clearAll(); decorate(); },
    invalidateBlocks: function () { blockCache = null; },
    setAssetResolver: function (fn) { assetResolver = fn; clearAll(); blockCache = null; decorate(); },
    setHoverLine: function (n) {
      var next = (typeof n === 'number' && n >= 0) ? n : -1;
      if (next === hoverLine) return;
      hoverLine = next;
      paintHover();
      // 접기 화살표는 "지금 마우스가 얹힌 줄" 에만 생긴다. 문서를 다시 그릴 것 없이
      // 화살표 층만 새로 칠한다 — 마우스를 움직일 때마다 전체를 다시 그리면 무겁다.
      if (lastPaint) paintFolds(lastPaint.foldable, lastPaint.from, lastPaint.to);
    },
    refreshHover: function () { paintHover(); paintAllTimes(); },
    toggleFold: function (lineNo) { toggleFold(lineNo); },
    foldAll: function () { return foldAllHeadings(); },
    unfoldAll: function () { return unfoldAll(); },
    foldCount: function () { return foldRanges().length; },
    // 탭을 갈아 끼우기 직전에 부른다. 남은 마크가 새 문서에 붙는 일을 막는다.
    clearFolds: function () {
      folds.forEach(function (f) { try { f.mark.clear(); } catch (e) {} });
      folds = [];
      curFoldRanges = [];
      lastFoldKey = '';
      foldLayer.textContent = '';
    },
    setShowAllTimes: function (on) {
      on = !!on;
      if (on === showAll) return;
      showAll = on;
      paintAllTimes();
      paintHover();
    },
    setReadingMode: function (on) {
      readingMode = !!on;
      cm.setOption('readOnly', readingMode ? 'nocursor' : false);
      clearAll();
      decorate();
      paintHover();
      paintAllTimes();
    },
    isReadingMode: function () { return readingMode; },
    run: function (name) {
      var map = {
        bold: wrapWith('**'), italic: wrapWith('*'), highlight: wrapWith('=='),
        code: wrapWith('`'), strike: wrapWith('~~'), link: insertLink,
        checkbox: toggleCheckbox, makeCheckbox: insertCheckbox, quote: toggleQuote,
        h1: setHeading(1), h2: setHeading(2), h3: setHeading(3), h0: setHeading(0)
      };
      if (map[name]) { map[name](cm); cm.focus(); }
    }
  };
};
