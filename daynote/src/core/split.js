'use strict';

// 홈 오른쪽 패널(할 일 · 메모 · 오늘 일정) 높이 비율 계산.
//
// 화면을 모르는 순수 함수만 둔다. 비율은 항상 길이 3, 합 1 인 배열이다.
// 드래그는 두 칸 사이의 경계 하나만 움직인다 — 나머지 한 칸은 그대로 둔다.

(function (factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.split = api; }
})(function () {
  var DEFAULT = [0.45, 0.33, 0.22];
  var MIN_PX = 72;           // 머리줄과 한두 줄이 보이는 정도
  var KEY_STEP = 0.05;
  var EPS = 1e-3;

  // 저장된 값이 이상하면(길이·숫자·음수) 기본값을 쓰고, 합이 1 이 되도록 맞춘다
  function normalize(r) {
    if (!Array.isArray(r) || r.length !== 3) return DEFAULT.slice();
    var sum = 0;
    for (var i = 0; i < 3; i++) {
      if (typeof r[i] !== 'number' || !isFinite(r[i]) || r[i] <= 0) return DEFAULT.slice();
      sum += r[i];
    }
    return r.map(function (x) { return x / sum; });
  }

  // 전체 높이(px)에서 한 칸의 최소 비율. 세 칸이 모두 최소를 지킬 수 없으면 1/3 로 묶는다.
  function minRatio(totalPx, minPx) {
    if (!(totalPx > 0)) return 0;
    return Math.min((minPx == null ? MIN_PX : minPx) / totalPx, 1 / 3);
  }

  // 세 칸 모두 min 이상이 되게 맞춘다. 모자란 칸을 min 으로 올리고, 남는 몫은 나머지 칸에 비율대로 나눈다.
  function clampAll(r, min) {
    r = normalize(r);
    min = min > 0 ? min : 0;
    if (min * 3 >= 1) return [1 / 3, 1 / 3, 1 / 3];
    var fixed = [false, false, false];
    for (var pass = 0; pass < 3; pass++) {
      var free = 0, fixedSum = 0, changed = false;
      for (var i = 0; i < 3; i++) { if (fixed[i]) fixedSum += min; else free += r[i]; }
      for (i = 0; i < 3; i++) {
        if (fixed[i]) { r[i] = min; continue; }
        r[i] = r[i] / free * (1 - fixedSum);
      }
      for (i = 0; i < 3; i++) if (!fixed[i] && r[i] < min - 1e-12) { fixed[i] = true; changed = true; }
      if (!changed) break;
    }
    for (var j = 0; j < 3; j++) if (fixed[j]) r[j] = min;
    return r;
  }

  // edge 0 = 할 일|메모 경계, 1 = 메모|일정 경계. delta 는 비율 단위(+ 면 아래로).
  // 이미 최소보다 작은 칸이 있어도 누른 방향으로만 움직인다 (반대로 튀지 않게).
  function moveEdge(ratios, edge, delta, min) {
    var r = normalize(ratios);
    min = min > 0 ? min : 0;
    delta = typeof delta === 'number' && !isNaN(delta) ? delta : 0;
    var a = edge, b = edge + 1;
    var pair = r[a] + r[b];
    if (pair < 2 * min) return r;
    var na = Math.max(min, Math.min(pair - min, r[a] + delta));
    if (delta > 0) na = Math.max(na, r[a]);
    else if (delta < 0) na = Math.min(na, r[a]);
    else na = r[a];
    r[a] = na;
    r[b] = pair - na;
    return r;
  }

  function round(r) { return normalize(r).map(function (x) { return Math.round(x * 10000) / 10000; }); }

  function isDefault(r) {
    var n = normalize(r);
    return n.every(function (x, i) { return Math.abs(x - DEFAULT[i]) < EPS; });
  }

  return {
    DEFAULT: DEFAULT, MIN_PX: MIN_PX, KEY_STEP: KEY_STEP,
    normalize: normalize, minRatio: minRatio, clampAll: clampAll, moveEdge: moveEdge, round: round, isDefault: isDefault
  };
});
