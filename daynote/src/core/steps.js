'use strict';

// 세부 할 일 — 할 일 하나를 작게 나눈 단계. 단계도 아래에 단계를 가질 수 있다 (몇 단계든).
//   step = { id, title, done, estimateMinutes, steps?: [step…] }
//
//   parseOutline : 들여쓰기·번호로 적은 글을 나무 모양으로 ("인공조류 보드 디버깅\n 1. 전원 디버깅\n 2. 클럭 확인")
//   toggle       : 체크하면 아래 단계도 같이, 아래 단계를 모두 끝내면 위 단계도 끝 (아래를 하나라도 풀면 위도 풀림)
//   count        : 진행 막대·'단계 2/5' 에 쓰는 수 (모든 단계를 센다)

(function (factory) {
  var deps = (typeof module !== 'undefined' && module.exports)
    ? { model: require('./model') }
    : { model: window.Daynote.model };
  var api = factory(deps.model);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.steps = api; }
})(function (M) {
  var MAX_TITLE = 120;

  function clone(steps) { return JSON.parse(JSON.stringify(steps || [])); }
  function kids(s) { return Array.isArray(s.steps) ? s.steps : []; }

  // ---------------------------------------------------------------- 나무 다루기
  // fn(step, depth, parent) — 위에서 아래로, 적힌 순서대로
  function walk(steps, fn, depth, parent) {
    (steps || []).forEach(function (s) { fn(s, depth || 0, parent || null); walk(kids(s), fn, (depth || 0) + 1, s); });
  }
  function flat(steps) { var out = []; walk(steps, function (s, d) { out.push({ step: s, depth: d }); }); return out; }
  function count(steps) {
    var c = { done: 0, total: 0 };
    walk(steps, function (s) { c.total += 1; if (s.done) c.done += 1; });
    return c;
  }
  // 아래 단계가 없는 단계 (실제로 손대는 일) — 추천은 이것 중 안 끝낸 첫 번째
  function leaves(steps) { var out = []; walk(steps, function (s) { if (!kids(s).length) out.push(s); }); return out; }
  function find(steps, id) { var hit = null; walk(steps, function (s) { if (!hit && s.id === id) hit = s; }); return hit; }

  function setAll(s, done) { s.done = done; kids(s).forEach(function (k) { setAll(k, done); }); }
  // 아래 단계가 있는 단계는 '아래가 모두 끝났는가' 로 맞춘다 (아래에서 위로)
  function settle(steps) {
    (steps || []).forEach(function (s) {
      if (!kids(s).length) return;
      settle(s.steps);
      s.done = s.steps.every(function (k) { return k.done; });
    });
    return steps;
  }
  function toggle(steps, id) {
    var next = clone(steps);
    var s = find(next, id);
    if (!s) return next;
    setAll(s, !s.done);
    return settle(next);
  }
  function make(title, est) {
    return { id: M.uid('step'), title: String(title || '').trim().slice(0, MAX_TITLE), done: false, estimateMinutes: est > 0 ? est : null };
  }
  // parentId 가 없으면 맨 위 단계로. 아래에 새 일이 생기면 위 단계는 아직 안 끝난 것
  function add(steps, parentId, title, est) {
    var next = clone(steps);
    var item = make(title, est);
    if (!item.title) return next;
    var p = parentId ? find(next, parentId) : null;
    if (parentId && !p) return next;
    if (p) { p.steps = kids(p).concat(item); } else next.push(item);
    return settle(next);
  }
  function remove(steps, id) {
    function cut(list) {
      return list.filter(function (s) { return s.id !== id; }).map(function (s) {
        if (kids(s).length) s.steps = cut(s.steps);
        if (s.steps && !s.steps.length) delete s.steps;
        return s;
      });
    }
    return settle(cut(clone(steps)));
  }

  // ---------------------------------------------------------------- 들여쓰기·번호 목록 읽기
  // 줄마다 '깊이 열쇠' = 들여쓰기 × 2 + (목록 표시가 있으면 1). 바로 위의 더 얕은 줄이 부모.
  //   "헤더\n1. 가\n2. 나" — 들여쓰기 없이 번호만 달아도 헤더 아래로
  //   "헤더\n 1. 가\n   - 가-1" — 들여쓰기가 깊을수록 더 아래로
  var MARK_RE = /^((?:\d{1,3}|[a-zA-Z]|[가나다라마바사아자차카타파하])[.)]|\(\d{1,3}\)|[-*+•·▪◦‣–]|\[[ xX]\])\s+/;
  function indentOf(line) {
    var m = line.match(/^[ \t　]*/)[0];
    var n = 0;
    for (var i = 0; i < m.length; i++) n += m[i] === '\t' ? 4 : 1;
    return n;
  }
  // [{ text, line(0부터), done, children }] — 빈 줄은 건너뛴다
  function parseOutline(text) {
    var lines = String(text || '').split(/\r?\n/);
    var roots = [], stack = [];
    lines.forEach(function (raw, i) {
      if (!raw.trim()) return;
      var body = raw.replace(/^[ \t　]+/, '');
      var m = body.match(MARK_RE);
      var title = (m ? body.slice(m[0].length) : body).replace(/^\[[ xX]\]\s+/, '').trim();
      if (!title) return;
      var done = /\[[xX]\]/.test(m ? m[0] : '') || /^\[[xX]\]\s+/.test(m ? body.slice(m[0].length) : '');
      var node = { text: title, line: i, key: indentOf(raw) * 2 + (m ? 1 : 0), done: done, children: [] };
      while (stack.length && stack[stack.length - 1].key >= node.key) stack.pop();
      if (stack.length) stack[stack.length - 1].children.push(node); else roots.push(node);
      stack.push(node);
    });
    return roots;
  }
  function stepsFromNodes(nodes) {
    return settle(nodes.map(function (n) {
      var s = make(n.text);
      s.done = !!n.done;
      if (n.children.length) s.steps = stepsFromNodes(n.children);
      return s;
    }));
  }
  // 글 하나를 할 일 하나로: 첫 줄(맨 위 항목)이 제목, 그 아래 항목들이 세부 할 일
  //   맨 위 항목이 여러 개면 둘째부터도 세부 할 일로 (메모를 할 일로 끌어 놓을 때)
  function taskFromText(text) {
    var roots = parseOutline(text);
    if (!roots.length) return null;
    var head = roots[0];
    var rest = head.children.concat(roots.slice(1));
    return { title: head.text.slice(0, MAX_TITLE), steps: stepsFromNodes(rest) };
  }
  // 아래 항목이 있는 맨 위 항목들 — 정리할 때 "이 줄 아래는 세부 할 일" 로 묶는 데 쓴다
  function outlineGroups(text) {
    return parseOutline(text).filter(function (n) { return n.children.length; }).map(function (n) {
      var lines = [];
      (function collect(list) { list.forEach(function (c) { lines.push(c.line); collect(c.children); }); })(n.children);
      return { title: n.text, line: n.line, childLines: lines, steps: stepsFromNodes(n.children) };
    });
  }

  // 할 일 → 세부 할 일 (그 할 일의 세부 할 일은 아래 단계로 따라온다)
  function fromTask(t) {
    var node = { id: M.uid('step'), title: String(t.title || '').trim().slice(0, MAX_TITLE) || '(제목 없음)', done: t.status === 'done', estimateMinutes: t.estimateMinutes > 0 ? t.estimateMinutes : null };
    if (t.steps && t.steps.length) node.steps = clone(t.steps);
    return node;
  }
  // 세부 할 일 → 새 할 일의 값 (아래 단계는 그 할 일의 세부 할 일로)
  function toTaskFields(node) {
    return { title: node.title || '(제목 없음)', estimateMinutes: node.estimateMinutes > 0 ? node.estimateMinutes : null, steps: clone(kids(node)) };
  }
  // 다른 목록 맨 끝에 붙이기
  function append(steps, node) { return settle(clone(steps).concat([clone(node)])); }

  return {
    fromTask: fromTask, toTaskFields: toTaskFields, append: append,
    walk: walk, flat: flat, count: count, leaves: leaves, find: find, toggle: toggle, add: add, remove: remove, settle: settle,
    parseOutline: parseOutline, stepsFromNodes: stepsFromNodes, taskFromText: taskFromText, outlineGroups: outlineGroups
  };
});
