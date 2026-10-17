'use strict';

// 쉬는 동안 하는 운동 — 근거는 ../../DAYNOTE_UX_RESEARCH.md (휴식 운동)
//
//   운동마다 '구간(phases)' 이 있고, 화면은 지금 구간의 말과 남은 초를 함께 보여 준다 — 설명과 숫자가 늘 맞게
//   (예전: "오른쪽 10초, 왼쪽 10초" 라고 적어 놓고 25초를 셌다)
//   area: neck(목) · shoulder(어깨) · wrist(손목·팔) · back(허리) · legs(다리)
//
//   고른 기준
//   - 목·어깨: 근력·지구력 운동이 사무직 목 통증을 가장 잘 줄였다 (Chen 외 2018 메타분석), 운동이 목 통증을 예방한다 (Teichert 외 2023)
//              하루 2분 어깨 근력 운동도 목·어깨 통증을 줄였다 (Andersen 외 2011) — 도구 없이 할 수 있는 날개뼈 모으기·턱 당기기로
//   - 손목·팔: 마우스를 오래 쓰면 손목 힘줄염·팔 아래쪽 질환과 관련 있다는 근거가 '제한적'으로 있다 (Wærsted 외 2010 리뷰).
//              손목 터널 증후군과 컴퓨터 작업의 관련은 근거가 부족하다 (Thomsen 외 2008 리뷰)
//              힘줄·신경 미끄러지기는 손목 터널 증후군 증상에 보조로 도움 (Kim 2015 · Ballestero-Pérez 외 2017). 예방 효과는 아직 근거가 없다
//   - 짧은 휴식 자체가 불편감을 줄인다 (Galinsky 외 2000·2007) — 운동은 그 휴식을 더 잘 쓰는 방법
//   아프거나 저리면 멈추게 한다 (특히 신경 미끄러지기)

(function (factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.exercises = api; }
})(function () {
  function reps(n, hold, holdSec, rest, restSec) {
    var out = [];
    for (var i = 1; i <= n; i++) {
      out.push({ say: hold + ' (' + i + '/' + n + ')', sec: holdSec });
      if (rest) out.push({ say: rest, sec: restSec, rest: true });
    }
    return out;
  }

  var LIST = [
    // 목
    { id: 'chin_tuck', area: 'neck', title: '턱 당기기', why: '목 깊은 근육을 깨워 고개가 앞으로 빠지는 자세를 줄여요',
      phases: reps(5, '턱을 뒤로 당겨 이중 턱 만들고 버티기', 5, '힘 풀기', 2) },
    { id: 'neck_side', area: 'neck', title: '목 옆 늘이기', why: '마우스 쪽 어깨·목 옆이 굳는 것을 풀어요',
      phases: [{ say: '오른손으로 머리를 오른쪽으로 살짝 당기기 — 왼쪽 목이 늘어나요', sec: 15 }, { say: '반대로 — 왼손으로 머리를 왼쪽으로', sec: 15 }] },
    // 어깨
    { id: 'scap_squeeze', area: 'shoulder', title: '날개뼈 모으기', why: '등 위쪽 근육을 써서 둥근 어깨를 펴요',
      phases: reps(6, '양쪽 날개뼈를 뒤로 모으고 버티기', 5, '힘 풀기', 2) },
    { id: 'shoulder_roll', area: 'shoulder', title: '어깨 뒤로 돌리기', why: '굳은 어깨에 피가 돌게 해요',
      phases: [{ say: '어깨를 크게 뒤로 천천히 돌리기', sec: 15 }, { say: '이번엔 앞으로 천천히', sec: 10 }] },
    { id: 'chest_open', area: 'shoulder', title: '가슴 열기', why: '앞으로 말린 가슴과 어깨 앞쪽을 늘여요',
      phases: [{ say: '양손을 등 뒤에서 깍지 끼고 가슴을 앞으로 내밀기', sec: 20 }] },
    // 손목·팔 (마우스·키보드)
    { id: 'wrist_flexor', area: 'wrist', title: '손목 안쪽 늘이기', why: '손가락·손목을 굽히는 팔 안쪽 근육을 늘여요',
      phases: [{ say: '오른팔을 앞으로 뻗어 손바닥이 앞을 보게 — 왼손으로 손가락을 몸 쪽으로 살짝 당기기', sec: 15 },
        { say: '왼팔 차례 — 손바닥이 앞, 오른손으로 살짝 당기기', sec: 15 }] },
    { id: 'wrist_extensor', area: 'wrist', title: '손등 쪽 늘이기', why: '마우스를 쥐는 팔 바깥쪽(테니스 엘보 부위)을 늘여요',
      phases: [{ say: '오른팔을 앞으로 뻗어 손등이 위로, 손을 아래로 꺾고 왼손으로 살짝 당기기', sec: 15 },
        { say: '왼팔 차례 — 손등 위, 오른손으로 살짝 당기기', sec: 15 }] },
    { id: 'tendon_glide', area: 'wrist', title: '힘줄 미끄러지기', why: '손가락 힘줄이 손목 통로 안에서 부드럽게 움직이게 해요',
      phases: [1, 2].reduce(function (acc, r) {
        return acc.concat([
          { say: '손가락 쭉 펴기 (' + r + '/2)', sec: 3 }, { say: '갈고리 — 손가락 끝 두 마디만 굽히기', sec: 3 },
          { say: '주먹 쥐기 — 꽉 말고 살짝', sec: 3 }, { say: '납작 주먹 — 손가락을 편 채 손바닥 쪽으로 직각', sec: 3 },
          { say: '곧은 주먹 — 손끝이 손바닥 아래쪽에 닿게', sec: 3 }]);
      }, []) },
    { id: 'nerve_glide', area: 'wrist', title: '손목 신경 미끄러지기', why: '손목 터널을 지나는 신경을 부드럽게 움직여요 — 저리면 바로 멈추기',
      phases: reps(5, '팔을 옆으로 뻗어 손바닥이 위로, 손목을 뒤로 젖히며 고개는 반대쪽으로', 4, '손목·고개 제자리로', 3) },
    { id: 'fist_open', area: 'wrist', title: '주먹 쥐었다 쫙 펴기', why: '굳은 손가락에 피가 돌게 해요',
      phases: reps(8, '꽉 쥐었다가 손가락을 쫙 펴기', 2) },
    // 허리
    { id: 'back_ext', area: 'back', title: '일어나서 허리 뒤로 젖히기', why: '오래 앉아 굽은 허리를 반대로 펴요',
      phases: reps(5, '일어나 손을 허리에 대고 천천히 뒤로 젖히기', 3, '바로 서기', 2) },
    { id: 'seated_twist', area: 'back', title: '앉아서 상체 비틀기', why: '허리·등 옆을 부드럽게 풀어요',
      phases: [{ say: '바르게 앉아 상체를 오른쪽으로 돌리기', sec: 15 }, { say: '왼쪽으로 돌리기', sec: 15 }] },
    // 다리
    { id: 'calf_raise', area: 'legs', title: '발뒤꿈치 들기', why: '오래 앉아 있으면 고이는 다리 혈액을 돌려요',
      phases: reps(12, '일어서서 발뒤꿈치 들었다 내리기', 2) },
    { id: 'calf_stretch', area: 'legs', title: '종아리 늘이기', why: '굳은 종아리를 늘여요',
      phases: [{ say: '벽을 짚고 오른발을 뒤로 뻗어 뒤꿈치를 바닥에 붙이기', sec: 15 }, { say: '왼발 차례', sec: 15 }] }
  ];
  LIST.forEach(function (x) { x.seconds = x.phases.reduce(function (a, p) { return a + p.sec; }, 0); });

  // 부위 고르기 — 휴식 화면의 선택지
  var FOCUS = [
    { id: 'all', label: '골고루', areas: ['shoulder', 'wrist', 'neck', 'back', 'wrist', 'legs'] },
    { id: 'wrist', label: '손목·팔', areas: ['wrist', 'wrist', 'shoulder'] },
    { id: 'neck', label: '목·어깨', areas: ['neck', 'shoulder'] },
    { id: 'back', label: '허리·다리', areas: ['back', 'legs'] }
  ];
  var FOCUS_BY = {}; FOCUS.forEach(function (f) { FOCUS_BY[f.id] = f; });

  function shuffle(list, seed) {
    var a = list.slice(), s = seed || 1;
    for (var i = a.length - 1; i > 0; i--) { s = (s * 9301 + 49297) % 233280; var j = Math.floor(s / 233280 * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  // 쉬는 시간(초)을 채우는 순서 — 부위를 돌아가며, 같은 운동은 한 번씩만 (모자라면 처음부터 다시)
  //   마지막 운동이 쉬는 시간을 30초 넘게 넘기지 않게 한다
  function routine(focus, seconds, seed) {
    var f = FOCUS_BY[focus] || FOCUS_BY.all;
    var areas = f.areas.concat(f.extra || []);
    var byArea = {};
    areas.forEach(function (a) { if (!byArea[a]) byArea[a] = shuffle(LIST.filter(function (x) { return x.area === a; }), (seed || 1) + a.length); });
    var order = [], used = {}, guard = 0;
    while (guard++ < 60) {
      var added = false;
      for (var i = 0; i < areas.length; i++) {
        var pool = byArea[areas[i]].filter(function (x) { return !used[x.id]; });
        if (!pool.length) continue;
        used[pool[0].id] = true; order.push(pool[0]); added = true;
      }
      if (!added) break;
    }
    var out = [], total = 0, k = 0;
    while (order.length && total < seconds && k < 40) {
      var ex = order[k % order.length]; k++;
      if (out.length && total + ex.seconds > seconds + 30) continue;
      out.push(ex); total += ex.seconds;
      if (k > order.length * 3) break;
    }
    return out.length ? out : order.slice(0, 1);
  }

  return { LIST: LIST, FOCUS: FOCUS, routine: routine };
});
