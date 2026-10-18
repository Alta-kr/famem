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
  var DEFAULT = [0.58, 0.24, 0.18];   // 할 일이 화면의 주인공 — 일하는 사람이 가장 자주 보는 곳 (UX 점검 H-01)
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

  // ---------------------------------------------------------------- 홈 좌우 (채팅 | 오늘 패널)
  // 채팅 쪽 비율 하나만 둔다. 양쪽 모두 최소 폭(기본 320px)을 지킨다.
  var COL_DEFAULT = 0.5;
  var COL_MIN_PX = 320;
  function clampCol(r, totalPx, minPx) {
    var m = minPx == null ? COL_MIN_PX : minPx;
    if (typeof r !== 'number' || !isFinite(r)) r = COL_DEFAULT;
    if (!(totalPx > 0)) return Math.max(0.2, Math.min(0.8, r));
    var lo = Math.min(m / totalPx, 0.5);
    return Math.round(Math.max(lo, Math.min(1 - lo, r)) * 10000) / 10000;
  }

  // ---------------------------------------------------------------- 단계 시간 끌어 맞추기
  // 60분까지는 5분, 그 위로는 10분씩. 칸에 걸쳐 있으면(47분) 첫 칸은 가까운 눈금으로 (↑50 · ↓45)
  var MIN_STEP_MIN = 5, MAX_STEP_MIN = 480;
  function stepMinutes(v, dir) {
    v = typeof v === 'number' && isFinite(v) ? v : null;
    if (v == null) return dir > 0 ? 15 : 5;            // 비어 있으면 15분부터
    var step = function (x, up) { return up ? (x < 60 ? 5 : 10) : (x <= 60 ? 5 : 10); };
    var s = step(v, dir > 0);
    var snapped = dir > 0 ? Math.floor(v / s) * s + s : Math.ceil(v / s) * s - s;
    return Math.max(MIN_STEP_MIN, Math.min(MAX_STEP_MIN, snapped));
  }
  // 여러 칸 한 번에 (끄는 거리만큼)
  function stepMinutesBy(v, steps) {
    var x = v;
    for (var i = 0; i < Math.abs(steps); i++) x = stepMinutes(x, steps > 0 ? 1 : -1);
    return x;
  }

  return {
    COL_DEFAULT: COL_DEFAULT, COL_MIN_PX: COL_MIN_PX, clampCol: clampCol, stepMinutes: stepMinutes, stepMinutesBy: stepMinutesBy,
    DEFAULT: DEFAULT, MIN_PX: MIN_PX, KEY_STEP: KEY_STEP,
    normalize: normalize, minRatio: minRatio, clampAll: clampAll, moveEdge: moveEdge, round: round, isDefault: isDefault
  };
});
