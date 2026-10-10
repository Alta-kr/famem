'use strict';

// 적응 — 사용자가 직접 고친 것에서 ‘표현 → 결과’ 규칙을 배우고 다음 글에 제안한다.
// state.learned 만 바꾼다. 화면·Electron·네트워크를 모른다. now 를 꼭 넘긴다(벽시계를 읽지 않는다).
// 증거는 사용자의 명시적 교정뿐이다(AI·규칙이 정한 값은 배우지 않는다).
//
//   규칙(Rule) 하나 = (type, key, role, to). 무게 w 는 at 시점 값이고 유형별 반감기로 감쇠한다.
//   type  kind(종류) · project(프로젝트) · date(날짜 어휘) · context(할 일 맥락 — 상태 기능이 쓴다. AI 에 보내지 않는다)
//   role  exact(전체) · tail(끝 낱말) · head(첫 낱말) · part(들어 있음) · lex(날짜 어휘)
//   수준  참고(hint) — AI 힌트로만 쓴다 · 확실(strong) — AI 결과 뒤에 바꿔도 된다. 정책은 부르는 쪽이 정한다.
//
// 전송 불변식: hints() 가 돌려주는 표현은 언제나 지금 글을 정규화한 문자열 안에 들어 있다.
// context 규칙은 hints() 에 절대 나오지 않는다(toAi:false).

(function (factory) {
  var deps = (typeof module !== 'undefined' && module.exports)
    ? { dates: require('./dates'), model: require('./model') }
    : { dates: window.Daynote.dates, model: window.Daynote.model };
  var api = factory(deps.dates, deps.model);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.adapt = api; }
})(function (D, M) {
  // ------------------------------------------------------------------ 상수
  var TYPES = {
    kind:    { halfLife: 120, roles: ['exact', 'tail', 'head'], strongN: 2, toAi: true,
               targets: ['task', 'event', 'memo', 'idea', 'link'] },
    project: { halfLife: 60,  roles: ['exact', 'part'], strongN: 2, strongNPart: 3, toAi: true },   // to: 프로젝트 id | 'none'
    date:    { halfLife: 120, roles: ['lex'], strongN: 2, toAi: true },                             // to: 'd0'…'d6' | 'm1'…'m31' | 'm-1'
    context: { halfLife: 60,  roles: ['exact', 'part'], strongN: 2, strongNPart: 2, toAi: false }   // 할 일 맥락: 맥락 id | 'none' (값은 상태 기능이 검사)
  };
  var LIMITS = { MAX_RULES: 300, MAX_TARGETS: 3, MAX_PARTS: 5, KEY_MIN: 2, KEY_MAX: 40, LABEL_MAX: 30,
                 KIND_TEXT_MAX: 80, PART_SCAN: 120, MIN_KEEP: 0.2, MAX_HINTS: 8 };
  var ROLE_W = { exact: 1.5, tail: 1.0, head: 0.6, part: 1.0, lex: 1.0 };
  var PRIOR = 0.5;                                  // "AI 자기 판단" 몫의 가상 무게
  var HINT = { support: 0.75, conf: 0.5 };
  var STRONG = { support: 1.5, conf: 0.66 };
  var FROM_DAMP = 0.5;                              // X → Y 로 고치면 같은 표현의 X 규칙 무게를 반으로
  var EXACT_TEXT_MAX = 40;                          // project·context 의 exact 는 한 줄 40자 이하 글만
  var TO_MAX = 40;
  var EPS = 1e-9;                                   // 문턱 비교의 부동소수 여유

  var TYPE_ORDER = ['kind', 'project', 'date', 'context'];
  var METRIC_KEYS = ['learned', 'applied', 'reverted', 'hinted'];
  var SOURCES = { correction: 1, command: 1, bootstrap: 1, manual: 1 };
  var KIND_SAYS = { task: '할 일', event: '일정', memo: '메모', idea: '아이디어', link: '링크' };
  var WEEKDAY_NAMES = ['월요일', '화요일', '수요일', '목요일', '금요일', '토요일', '일요일'];   // d0 = 월

  // 요일로 정하는 말 → to 'd0'(월)…'d6'(일)
  var DATE_WORDS = {
    '주말': 'near', '이번주말': 'near', '주중': 'near', '이번주중': 'near', '이번주안': 'near', '이번주내': 'near', '이번주': 'near', '주초': 'near',
    '다음주': 'next', '차주': 'next', '다음주말': 'next', '다음주중': 'next', '다음주초': 'next'
  };
  // 날짜(일)로 정하는 말 → to 'm1'…'m31' | 'm-1'(말일)
  var MONTH_WORDS = {
    '월말': 'this', '이달말': 'this', '이번달말': 'this', '월초': 'this', '이번달': 'this', '이달': 'this',
    '다음달': 'nextm', '다음달초': 'nextm', '다음달말': 'nextm'
  };
  // 긴 어휘부터 찾는다 ("다음주말" 안의 "주말"·"다음주"는 겹치므로 뺀다)
  var LEX_KEYS = Object.keys(DATE_WORDS).concat(Object.keys(MONTH_WORDS)).sort(function (a, b) {
    return b.length - a.length || (a < b ? -1 : a > b ? 1 : 0);
  });

  // 낱말 끝에서 떼는 조사 (긴 것부터). 이/가/의는 떼지 않는다(회의·고양이·휴가 …)
  var PARTICLES = ['에서', '에게', '으로', '까지', '부터', '처럼', '보다', '이랑',
                   '은', '는', '을', '를', '에', '로', '와', '과', '도', '만', '랑'];
  var STOP_COMMON = toSet([
    // 날짜·시간 말
    '오늘', '내일', '모레', '어제', '이번', '다음', '지난', '이번주', '다음주', '주말', '주중', '월말', '월초',
    '오전', '오후', '아침', '점심', '저녁', '밤', '새벽',
    '월요일', '화요일', '수요일', '목요일', '금요일', '토요일', '일요일',
    '시', '분', '시간', '전', '후', '뒤', '까지',
    // 대명사
    '나', '내', '저', '우리', '이거', '그거', '저거', '것', '거',
    // 군말
    '그리고', '좀', '꼭', '빨리', '일단', '나중', '같이', '다시', '먼저', '아마', '진짜', '너무'
  ]);
  // project·context 에서만 버린다 — 어느 프로젝트에나 나오는 말
  var STOP_VERB = toSet([
    '하기', '해야', '하자', '할것', '함', '했음', '하기로', '보내기', '정리', '확인', '작성', '준비', '검토',
    '공유', '요청', '연락', '수정', '회의', '미팅', '메일', '전화', '자료', '문서'
  ]);
  var SPLIT_RE = /[\s,.;:!?()\[\]{}"'“”‘’·…\/|~=+*#<>-]+/;
  var KEY_CHAR_RE = /[0-9a-z가-힣]/;
  var YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

  function toSet(list) { var o = {}; list.forEach(function (w) { o[w] = true; }); return o; }
  function has(obj, k) { return Object.prototype.hasOwnProperty.call(obj, k); }

  // ------------------------------------------------------------------ 시각
  function toMs(v) {
    if (v instanceof Date || Object.prototype.toString.call(v) === '[object Date]') return v.getTime();   // 다른 realm(vm·iframe)의 Date 도
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v) return Date.parse(v);
    return NaN;
  }
  function isoOf(ms) { return new Date(ms).toISOString(); }

  // ------------------------------------------------------------------ 저장소
  function freshLearned() {
    return { v: 1, rules: [], metrics: { learned: 0, applied: 0, reverted: 0, hinted: 0 }, bootstrappedAt: null, compactedAt: null };
  }

  // 없거나 모양이 틀리면 기본값으로 채운다 (옛 emptyState() 로 만든 상태에서도 돈다)
  function ensure(state) {
    if (!state || typeof state !== 'object') return freshLearned();
    var L = state.learned;
    if (!L || typeof L !== 'object' || Array.isArray(L)) L = state.learned = freshLearned();
    if (!L.v) L.v = 1;
    if (!Array.isArray(L.rules)) L.rules = [];
    if (!L.metrics || typeof L.metrics !== 'object' || Array.isArray(L.metrics)) L.metrics = {};
    METRIC_KEYS.forEach(function (k) { var v = Number(L.metrics[k]); L.metrics[k] = isFinite(v) ? v : 0; });
    if (L.bootstrappedAt === undefined) L.bootstrappedAt = null;
    if (L.compactedAt === undefined) L.compactedAt = null;
    return L;
  }

  // 읽기 전용 — 상태를 바꾸지 않는다
  function rulesOf(state) {
    var L = state && state.learned;
    return (L && Array.isArray(L.rules)) ? L.rules : [];
  }

  function enabled(state) { return !(state && state.prefs && state.prefs.learning === false); }

  // 규칙 항목은 normalize 가 정리하지 않으므로 방어적으로 읽는다. 모양이 틀린 규칙은 무시하고 compact 에서 버린다
  var DATE_TO_RE = /^(d[0-6]|m(-1|[1-9]|[12][0-9]|3[01]))$/;
  function validRule(r) {
    if (!r || typeof r !== 'object') return false;
    var cfg = TYPES[r.type];
    return !!cfg && cfg.roles.indexOf(r.role) !== -1 &&
      typeof r.id === 'string' && !!r.id &&
      typeof r.key === 'string' && !!r.key &&
      typeof r.to === 'string' && !!r.to && r.to.length <= TO_MAX &&
      (!cfg.targets || cfg.targets.indexOf(r.to) !== -1) &&
      (r.type !== 'date' || DATE_TO_RE.test(r.to)) &&
      typeof r.w === 'number' && isFinite(r.w) && isFinite(Date.parse(r.at));
  }

  // 실효 무게 = w · 2^(-(now-at)/반감기)
  function eff(r, nowMs) {
    var cfg = TYPES[r.type], w = Number(r.w);
    if (!cfg || !isFinite(w) || w <= 0) return 0;
    var at = Date.parse(r.at), age = isFinite(at) ? Math.max(0, nowMs - at) : 0;
    return w * Math.pow(2, -age / (cfg.halfLife * D.DAY));
  }
  function lastMs(r) { var t = Date.parse(r.last); return isFinite(t) ? t : (isFinite(Date.parse(r.at)) ? Date.parse(r.at) : 0); }
  function strongNOf(cfg, allPart) { return allPart ? (cfg.strongNPart || cfg.strongN) : cfg.strongN; }

  function liveProjectMap(state) {
    var live = {};
    ((state && Array.isArray(state.projects)) ? state.projects : []).forEach(function (p) {
      if (p && p.id && !p.deletedAt) live[p.id] = p;
    });
    return live;
  }

  // ------------------------------------------------------------------ 정규화와 표현 뽑기
  function nfc(s) {
    s = s == null ? '' : String(s);
    return typeof s.normalize === 'function' ? s.normalize('NFC') : s;
  }

  // NFC → 소문자 → [^0-9a-z가-힣] 제거 (띄어쓰기·문장부호·자모·전각 문자 제거). '장 보기!' → '장보기'
  function normKey(s) { return nfc(s).toLowerCase().replace(/[^0-9a-z가-힣]/g, ''); }

  // 한글이 들어 있으면 2–40자, 라틴만이면 3–40자
  function keyOk(key) {
    if (!key || key.length > LIMITS.KEY_MAX) return false;
    return key.length >= (/[가-힣]/.test(key) ? LIMITS.KEY_MIN : 3);
  }

  // 끝의 조사 하나만 뗀다. 가장 긴 조사가 맞았는데 뗀 뒤 2자 미만이면 떼지 않는다 ('경로' · '집으로')
  function stripParticle(w) {
    for (var i = 0; i < PARTICLES.length; i++) {
      var p = PARTICLES[i];
      if (w.length > p.length && w.slice(-p.length) === p) return (w.length - p.length >= 2) ? w.slice(0, -p.length) : w;
    }
    return w;
  }

  // 낱말 단위 표현 [{ key, label }] (등장 순서)
  function tokens(text, type) {
    var out = [], stopVerb = type === 'project' || type === 'context';
    nfc(text).split(/\s+/).forEach(function (chunk) {
      if (!chunk) return;
      var lc = chunk.toLowerCase();
      if (lc.indexOf('http') !== -1 || lc.indexOf('www.') !== -1 || chunk.indexOf('@') !== -1) return;   // URL·이메일
      chunk.split(SPLIT_RE).forEach(function (w) {
        if (!w || /[0-9０-９]/.test(w)) return;                    // 숫자가 들어간 낱말
        var stripped = stripParticle(w), key = normKey(stripped);
        if (!keyOk(key)) return;                                  // 너무 짧음(라틴 3자 미만 포함)·너무 김
        if (STOP_COMMON[key] || (stopVerb && STOP_VERB[key])) return;
        out.push({ key: key, label: stripped.slice(0, LIMITS.LABEL_MAX) });
      });
    });
    return out;
  }

  function oneLine(t) { return !!t && !/[\r\n]/.test(t); }
  function collapse(t) { return t.replace(/\s+/g, ' ').slice(0, LIMITS.LABEL_MAX); }

  // 정규화한 글(nk)과, nk 의 글자마다 원문(s)에서의 자리(idx)
  function normMap(text) {
    var s = nfc(text), chars = [], idx = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i).toLowerCase();
      for (var j = 0; j < c.length; j++) if (KEY_CHAR_RE.test(c.charAt(j))) { chars.push(c.charAt(j)); idx.push(i); }
    }
    return { s: s, nk: chars.join(''), idx: idx };
  }

  // 정규화한 key 가 지금 글에서 차지하는 원문 부분 ('다음주말' → '다음 주말'). 없으면 null
  function spanOf(text, key) {
    if (!key) return null;
    var m = normMap(text), at = m.nk.indexOf(key);
    return at === -1 ? null : m.s.slice(m.idx[at], m.idx[at + key.length - 1] + 1);
  }

  // 날짜 어휘 찾기 — 정규화한 글 위에서 긴 어휘부터, 이미 찾은 자리와 겹치는 짧은 어휘는 뺀다.
  // label 은 원문에서 그 자리의 모양 그대로('다음 주말')
  function lexFound(text) {
    var m = normMap(text), s = m.s, idx = m.idx;
    var nk = m.nk, used = [], found = [];
    LEX_KEYS.forEach(function (w) {
      var from = 0, at;
      while ((at = nk.indexOf(w, from)) !== -1) {
        var end = at + w.length;
        var clash = used.some(function (u) { return at < u[1] && end > u[0]; });
        if (!clash) {
          used.push([at, end]);
          found.push({ key: w, start: at, label: s.slice(idx[at], idx[end - 1] + 1) });
        }
        from = at + 1;
      }
    });
    return found.sort(function (a, b) { return a.start - b.start; });
  }

  // 배울 표현 [{ key, label, role }]
  function phrases(text, type) {
    var t = nfc(text).trim(), out = [], seen = {};
    function add(key, label, role) {
      if (seen[role + ':' + key]) return;
      seen[role + ':' + key] = true;
      out.push({ key: key, label: String(label).slice(0, LIMITS.LABEL_MAX), role: role });
    }
    if (!t) return out;
    if (type === 'kind') {
      if (!oneLine(t) || t.length > LIMITS.KIND_TEXT_MAX) return out;
      var nk = normKey(t), toks = tokens(t, type);
      if (nk.length >= LIMITS.KEY_MIN && nk.length <= LIMITS.KEY_MAX) add(nk, collapse(t), 'exact');
      if (toks.length >= 2) {
        var first = toks[0], last = toks[toks.length - 1];
        add(last.key, last.label, 'tail');
        if (first.key !== last.key) add(first.key, first.label, 'head');
      }
      return out;
    }
    if (type === 'project' || type === 'context') {
      var nk2 = normKey(t), exactKey = null;
      if (oneLine(t) && t.length <= EXACT_TEXT_MAX && nk2.length >= LIMITS.KEY_MIN && nk2.length <= LIMITS.KEY_MAX) {
        exactKey = nk2;
        add(nk2, collapse(t), 'exact');
      }
      var parts = 0;
      tokens(t.slice(0, LIMITS.PART_SCAN), type).forEach(function (p) {
        if (parts >= LIMITS.MAX_PARTS || p.key === exactKey || seen['part:' + p.key]) return;
        add(p.key, p.label, 'part');
        parts++;
      });
      return out;
    }
    if (type === 'date') {
      lexFound(t).forEach(function (f) { add(f.key, f.label, 'lex'); });
      return out;
    }
    return out;
  }

  // ------------------------------------------------------------------ 맞추기
  function matchCtx(text, type) {
    var t = nfc(text).trim(), single = oneLine(t) && t.length <= LIMITS.KIND_TEXT_MAX;
    return {
      nk: normKey(t),
      toks: single && type === 'kind' ? tokens(t, type) : [],      // tail·head 는 kind 의 한 줄 글에서만 본다
      single: single,
      lex: type === 'date' ? lexFound(t).map(function (f) { return f.key; }) : []
    };
  }

  function matches(r, c) {
    switch (r.role) {
      case 'exact': return c.nk === r.key;
      case 'tail': {
        if (!c.single || c.toks.length < 1) return false;
        var k = c.toks[c.toks.length - 1].key;
        return k.length >= r.key.length && k.slice(k.length - r.key.length) === r.key;   // '우유사기' 는 '사기' 와 맞는다
      }
      case 'head': return c.single && c.toks.length >= 2 && c.toks[0].key === r.key;
      case 'part': return c.nk.indexOf(r.key) !== -1;
      case 'lex': return c.lex.indexOf(r.key) !== -1;
    }
    return false;
  }

  function allowFn(allowed) {
    if (typeof allowed === 'function') return function (to) { return !!allowed(to); };
    if (Array.isArray(allowed)) return function (to) { return allowed.indexOf(to) !== -1; };
    return function () { return true; };
  }

  // ------------------------------------------------------------------ 배우기
  // ev = { type, text, to, from?, ref?, sample?, source?, weight?(0.1–1), refTime?(date 전용) }
  function learn(state, ev, now) {
    if (!state || !ev) return null;
    var cfg = TYPES[ev.type];
    if (!cfg) return null;
    var source = has(SOURCES, ev.source) ? ev.source : 'correction';
    if (source !== 'manual' && !enabled(state)) return null;
    var nowMs = toMs(now);
    if (!isFinite(nowMs)) return null;

    var from = (ev.from == null || ev.from === '') ? null : String(ev.from);
    var ph = phrases(ev.text, ev.type), to;
    if (ev.type === 'date') {
      var chosen = (ev.to && typeof ev.to === 'object') ? ev.to.date : ev.to;
      if (typeof chosen !== 'string' || !YMD_RE.test(chosen)) return null;
      if (from === chosen) return null;
      if (ph.length !== 1) return null;                          // 날짜 어휘가 정확히 하나일 때만
      var refMs = ev.refTime != null ? toMs(ev.refTime) : nowMs;
      to = encodeDate(ph[0].key, { date: chosen }, isFinite(refMs) ? refMs : nowMs);
      if (!to) return null;
    } else {
      to = ev.to == null ? (ev.type === 'project' ? 'none' : '') : String(ev.to);
      if (!to || to.length > TO_MAX) return null;
      if (cfg.targets && cfg.targets.indexOf(to) === -1) return null;
      if (from === to) return null;
    }
    if (!ph.length) return null;

    var weight = ev.weight == null ? 1 : Number(ev.weight);
    if (!isFinite(weight)) weight = 1;
    weight = Math.min(1, Math.max(0.1, weight));

    var L = ensure(state), nowIso = isoOf(nowMs), res = { added: [], updated: [], damped: [] };
    ph.forEach(function (p) {
      function sameGroup(r) { return r && r.type === ev.type && r.key === p.key && r.role === p.role; }
      var group = L.rules.filter(sameGroup);
      // ① X → Y 교정이면 같은 표현의 X 규칙을 반으로 (date 의 from 은 설명용 — 인코딩이 달라 감쇠에 쓰지 않는다)
      if (from != null && ev.type !== 'date') {
        group.forEach(function (r) {
          if (r.to !== from) return;
          r.w = eff(r, nowMs) * FROM_DAMP;
          r.at = nowIso;
          if (res.damped.indexOf(r.id) === -1) res.damped.push(r.id);
        });
      }
      var hit = group.filter(function (r) { return r.to === to; })[0];
      if (hit) {
        // ② 같은 대상 — 무게를 더하고 횟수를 올린다.
        //    씨앗(bootstrap)은 무게만 더하고 횟수는 올리지 않는다 — 씨앗만으로는 '참고' 수준까지만 간다(§4.2, 확실은 n ≥ strongN)
        hit.w = eff(hit, nowMs) + weight;
        hit.at = nowIso;
        hit.last = nowIso;
        if (source !== 'bootstrap') hit.n = (Number(hit.n) || 0) + 1;
        hit.from = from;
        hit.ref = ev.ref || null;
        if (source !== 'bootstrap' || !hit.src) hit.src = source;
        if (!ev.sample) delete hit.sample;
        res.updated.push(hit.id);
      } else {
        // ③ 새 규칙
        hit = {
          id: M.uid('lr'), type: ev.type, key: p.key, role: p.role, label: p.label, to: to,
          w: weight, at: nowIso, n: 1, neg: 0, from: from, first: nowIso, last: nowIso,
          ref: ev.ref || null, src: source
        };
        if (ev.sample) hit.sample = true;
        L.rules.push(hit);
        res.added.push(hit.id);
      }
      // ④ 같은 표현의 대상은 MAX_TARGETS 개까지 — 실효 무게가 가장 작은 것을 지운다(방금 배운 것은 남긴다)
      group = L.rules.filter(sameGroup);
      while (group.length > LIMITS.MAX_TARGETS) {
        var victim = group.filter(function (r) { return r !== hit; }).sort(function (a, b) {
          return eff(a, nowMs) - eff(b, nowMs) || lastMs(a) - lastMs(b);
        })[0];
        L.rules.splice(L.rules.indexOf(victim), 1);
        group.splice(group.indexOf(victim), 1);
      }
    });
    L.metrics.learned = (Number(L.metrics.learned) || 0) + 1;
    if (L.rules.length > LIMITS.MAX_RULES) compact(state, nowMs);
    // 상한(④·compact)으로 이미 지운 규칙의 id 는 돌려주지 않는다
    var alive = {};
    L.rules.forEach(function (r) { if (r && r.id) alive[r.id] = true; });
    ['added', 'updated', 'damped'].forEach(function (k) { res[k] = res[k].filter(function (id) { return alive[id]; }); });
    return res;
  }

  // ------------------------------------------------------------------ 제안
  // opts = { allowed?: string[] | function(to) → bool, refTime?: ISO }. 상태를 바꾸지 않는다.
  function suggest(state, type, text, now, opts) {
    var cfg = TYPES[type];
    if (!cfg || !state || !enabled(state)) return null;
    var nowMs = toMs(now);
    if (!isFinite(nowMs)) return null;
    var rules = rulesOf(state);
    if (!rules.length) return null;
    opts = opts || {};
    var allow = allowFn(opts.allowed), c = matchCtx(text, type);
    if (!c.nk) return null;

    var byTo = {}, groups = [];
    rules.forEach(function (r) {
      if (!r || r.type !== type || !validRule(r) || !allow(r.to) || !matches(r, c)) return;
      var contrib = eff(r, nowMs) * ROLE_W[r.role];
      var g = has(byTo, r.to) ? byTo[r.to] : null;               // to 는 부르는 쪽 값(맥락 id 등) — 'constructor' 같은 이름에도 안전하게
      if (!g) {
        g = byTo[r.to] = { to: r.to, support: 0, maxN: 0, newest: -Infinity, ids: [], allPart: true, top: null, topC: -1 };
        groups.push(g);
      }
      g.support += contrib;
      g.maxN = Math.max(g.maxN, Number(r.n) || 0);
      g.newest = Math.max(g.newest, lastMs(r));
      g.ids.push(r.id);
      if (r.role !== 'part') g.allPart = false;
      if (contrib > g.topC) { g.topC = contrib; g.top = r; }
    });
    if (!groups.length) return null;

    var total = groups.reduce(function (a, g) { return a + g.support; }, 0);
    // 가장 큰 support → 같으면 newest 가 늦은 쪽 → maxN 이 큰 쪽 → to 오름차순 (결정적)
    groups.sort(function (a, b) {
      if (Math.abs(a.support - b.support) > EPS) return b.support - a.support;
      if (a.newest !== b.newest) return b.newest - a.newest;
      if (a.maxN !== b.maxN) return b.maxN - a.maxN;
      return a.to < b.to ? -1 : a.to > b.to ? 1 : 0;
    });
    var best = groups[0], conf = best.support / (total + PRIOR);
    var othersNewer = groups.slice(1).some(function (g) { return g.newest > best.newest; });
    var level = null;
    if (best.maxN >= strongNOf(cfg, best.allPart) && best.support >= STRONG.support - EPS &&
        conf >= STRONG.conf - EPS && !othersNewer) level = 'strong';
    else if (best.support >= HINT.support - EPS && conf >= HINT.conf - EPS) level = 'hint';
    if (!level) return null;

    var out = {
      type: type, to: best.to, level: level, confidence: conf, support: best.support, n: best.maxN,
      phrase: best.top.label || best.top.key, role: best.top.role, ruleIds: best.ids.slice(),
      alternatives: groups.slice(1).map(function (g) { return { to: g.to, support: g.support }; })
    };
    if (type === 'date' && opts.refTime != null) {
      out.value = resolveDate(best.top.key, best.to, opts.refTime);
      if (!out.value) return null;                                // 기준 시각으로 날짜를 못 정하면 제안하지 않는다
    }
    return out;
  }

  // AI 프롬프트 힌트 — toAi 유형(kind·project·date)마다 suggest 하나씩, 수준 hint 이상, 최대 MAX_HINTS.
  // opts = { projects: [{ id, name }] } — project 는 살아 있는 id 와 'none' 만 허용하고 says 는 이름으로 만든다
  function hints(state, text, now, opts) {
    if (!state || !enabled(state)) return [];
    opts = opts || {};
    var nk = normKey(text);
    if (!nk) return [];
    var names = {};
    (Array.isArray(opts.projects) ? opts.projects : M.liveProjects({ projects: Array.isArray(state.projects) ? state.projects : [] }))
      .forEach(function (p) { if (p && p.id && !p.deletedAt && p.name) names[p.id] = String(p.name); });
    var out = [];
    TYPE_ORDER.forEach(function (type) {
      if (!TYPES[type].toAi || out.length >= LIMITS.MAX_HINTS) return;
      var sopts = type === 'project' ? { allowed: function (to) { return to === 'none' || has(names, to); } } : {};
      var s = suggest(state, type, text, now, sopts);
      if (!s) return;
      // 전송 불변식: 지금 글 안에 있는 표현만. 보내는 표현은 규칙 label(예전 글의 모양 — 이모지·한자·문장부호가
      // 섞일 수 있다)이 아니라 지금 글에서 그 자리를 그대로 잘라 쓴다
      var pk = normKey(s.phrase), span = pk && nk.indexOf(pk) !== -1 ? spanOf(text, pk) : null;
      if (!span) return;
      var said = type === 'project'
        ? (s.to === 'none' ? '프로젝트 없음' : '프로젝트 ‘' + names[s.to] + '’')
        : says(type, s.to, { key: pk });
      out.push({ type: type, phrase: collapse(span), to: s.to, says: said, n: s.n, ruleIds: s.ruleIds });
    });
    return out.slice(0, LIMITS.MAX_HINTS);
  }

  // ------------------------------------------------------------------ 벌점·약화·지우기
  // 배운 대로 바꾼 것을 사용자가 되돌렸을 때. w = max(0, eff - amount), neg++, MIN_KEEP 미만이면 삭제 → 지운 id
  function penalize(state, ruleIds, now, amount) {
    var nowMs = toMs(now);
    if (!state || !isFinite(nowMs)) return [];
    amount = amount == null ? 1 : Number(amount);
    if (!isFinite(amount)) amount = 1;
    var L = ensure(state), nowIso = isoOf(nowMs), gone = [], seen = {};
    [].concat(ruleIds || []).forEach(function (id) {
      if (!id || seen[id]) return;
      seen[id] = true;
      var r = get(state, id);
      if (!r) return;
      r.w = Math.max(0, eff(r, nowMs) - amount);
      r.at = nowIso;
      r.neg = (Number(r.neg) || 0) + 1;
      if (r.w < LIMITS.MIN_KEEP) gone.push(id);
    });
    if (gone.length) L.rules = L.rules.filter(function (r) { return !(r && gone.indexOf(r.id) !== -1); });
    return gone;
  }

  // 약한 반대 신호(× 빼기). text 에 맞는 규칙 중 대상이 to 인 것만 줄인다. 새로 만들지 않는다 → 영향 id
  function weaken(state, type, text, to, now, amount) {
    var nowMs = toMs(now);
    if (!state || !TYPES[type] || !enabled(state) || !isFinite(nowMs)) return [];
    amount = amount == null ? 0.5 : Number(amount);
    if (!isFinite(amount)) amount = 0.5;
    to = to == null ? (type === 'project' ? 'none' : '') : String(to);
    if (!to) return [];
    var c = matchCtx(text, type);
    if (!c.nk) return [];
    var L = ensure(state), nowIso = isoOf(nowMs), touched = [], gone = [];
    L.rules.forEach(function (r) {
      if (!r || r.type !== type || r.to !== to || !validRule(r) || !matches(r, c)) return;
      r.w = Math.max(0, eff(r, nowMs) - amount);
      r.at = nowIso;
      touched.push(r.id);
      if (r.w < LIMITS.MIN_KEEP) gone.push(r.id);
    });
    if (gone.length) L.rules = L.rules.filter(function (r) { return !(r && gone.indexOf(r.id) !== -1); });
    return touched;
  }

  function get(state, id) {
    if (!id) return null;
    var rules = rulesOf(state);
    for (var i = 0; i < rules.length; i++) if (rules[i] && rules[i].id === id) return rules[i];
    return null;
  }

  function removeWhere(state, pred) {
    var L = ensure(state), before = L.rules.length;
    L.rules = L.rules.filter(function (r) { return !pred(r); });
    return before - L.rules.length;
  }

  function forget(state, id) {
    if (!state || !id) return false;
    return removeWhere(state, function (r) { return !!r && r.id === id; }) > 0;
  }

  // 메모를 지울 때 — 그 글에서 한 번만 배운 규칙(n===1 && ref===noteId)을 지운다 → 지운 수
  function forgetRef(state, noteId) {
    if (!state || !noteId) return 0;
    return removeWhere(state, function (r) { return !!r && r.ref === noteId && Number(r.n) === 1; });
  }

  // 모두(또는 한 유형) 지우기 → 지운 수. metrics 는 그대로 둔다
  function reset(state, type) {
    if (!state) return 0;
    return removeWhere(state, function (r) { return type == null || !!(r && r.type === type); });
  }

  // 유지보수: 모양이 틀린 규칙 → MIN_KEEP 미만 → 대상 프로젝트가 없거나 지워진 project 규칙 삭제
  // → 그래도 MAX_RULES 를 넘으면 (eff 오름차순, last 오름차순)으로 삭제. compactedAt = now → 지운 수
  function compact(state, now) {
    var nowMs = toMs(now);
    if (!state || !isFinite(nowMs)) return 0;
    var L = ensure(state), before = L.rules.length, live = liveProjectMap(state);
    var keep = L.rules.filter(function (r) {
      if (!validRule(r)) return false;
      if (eff(r, nowMs) < LIMITS.MIN_KEEP) return false;
      if (r.type === 'project' && r.to !== 'none' && !live[r.to]) return false;
      return true;
    });
    if (keep.length > LIMITS.MAX_RULES) {
      var drop = {};
      keep.map(function (r, i) { return { r: r, e: eff(r, nowMs), l: lastMs(r), i: i }; })
        .sort(function (a, b) { return a.e - b.e || a.l - b.l || a.i - b.i; })
        .slice(0, keep.length - LIMITS.MAX_RULES)
        .forEach(function (x) { drop[x.r.id] = true; });
      keep = keep.filter(function (r) { return !drop[r.id]; });
    }
    L.rules = keep;
    L.compactedAt = isoOf(nowMs);
    return before - keep.length;
  }

  // 설정 화면용 목록. 정렬: 유형 순(kind, project, date, context) → eff 내림차순.
  // level 은 규칙 하나만 볼 때의 기준: strong(n≥strongN(part 는 strongNPart) && eff·ROLE_W≥1.5) / hint(eff·ROLE_W≥0.75) / weak
  function list(state, now, opts) {
    var nowMs = toMs(now);
    if (!state || !isFinite(nowMs)) return [];
    opts = opts || {};
    var live = liveProjectMap(state);
    var rows = rulesOf(state).filter(function (r) { return validRule(r) && (!opts.type || r.type === opts.type); }).map(function (r) {
      var cfg = TYPES[r.type], e = eff(r, nowMs), s = e * ROLE_W[r.role], n = Number(r.n) || 0;
      var level = (n >= strongNOf(cfg, r.role === 'part') && s >= STRONG.support - EPS) ? 'strong'
        : s >= HINT.support - EPS ? 'hint' : 'weak';
      return {
        id: r.id, type: r.type, role: r.role, key: r.key, label: r.label || r.key, to: r.to, n: n, eff: e, level: level,
        first: r.first || null, last: r.last || null, from: r.from == null ? null : r.from, src: r.src || 'correction',
        missing: r.type === 'project' && r.to !== 'none' && !live[r.to]
      };
    });
    rows.sort(function (a, b) {
      return TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || b.eff - a.eff ||
        (a.last < b.last ? 1 : a.last > b.last ? -1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
    return rows;
  }

  // metrics.learned | applied | reverted | hinted 를 더한다
  function count(state, key, n) {
    if (!state || METRIC_KEYS.indexOf(key) === -1) return null;
    n = n == null ? 1 : Number(n);
    if (!isFinite(n)) return null;
    var L = ensure(state);
    L.metrics[key] = (Number(L.metrics[key]) || 0) + n;
    return L.metrics[key];
  }

  // ------------------------------------------------------------------ 날짜 어휘와 해석
  function lexMode(lex) { return has(DATE_WORDS, lex) ? DATE_WORDS[lex] : has(MONTH_WORDS, lex) ? MONTH_WORDS[lex] : null; }
  function refDay(refTime) {
    var ms = refTime instanceof Date ? refTime.getTime() : toMs(refTime);
    return isFinite(ms) ? D.startOfDay(new Date(ms)) : null;
  }
  function lastDayOf(y, m) { return new Date(y, m + 1, 0).getDate(); }
  function dayIn(y, m, spec) {
    var first = new Date(y, m, 1), last = lastDayOf(first.getFullYear(), first.getMonth());
    return new Date(first.getFullYear(), first.getMonth(), spec === -1 ? last : Math.min(spec, last));
  }

  // (어휘, 대상) → 실제 날짜. ref = startOfDay(refTime)
  //   near: ref 부터 가장 가까운(오늘 포함) 그 요일 · next: startOfWeek(ref) + 7일 + d
  //   this: 이번 달 그날(없으면 말일), ref 보다 앞이면 다음 달 · nextm: 다음 달 그날
  function resolveDate(lex, to, refTime) {
    var mode = lexMode(lex), ref = refDay(refTime), m, d;
    if (!mode || !ref) return null;
    to = to == null ? '' : String(to);
    if (has(DATE_WORDS, lex)) {
      m = /^d([0-6])$/.exec(to);
      if (!m) return null;
      var wd = Number(m[1]);
      d = mode === 'near' ? D.addDays(ref, (wd - (ref.getDay() + 6) % 7 + 7) % 7) : D.addDays(D.startOfWeek(ref), 7 + wd);
    } else {
      m = /^m(-1|[1-9]|[12][0-9]|3[01])$/.exec(to);
      if (!m) return null;
      var spec = Number(m[1]);
      if (mode === 'this') {
        d = dayIn(ref.getFullYear(), ref.getMonth(), spec);
        if (d < ref) d = dayIn(ref.getFullYear(), ref.getMonth() + 1, spec);
      } else {
        d = dayIn(ref.getFullYear(), ref.getMonth() + 1, spec);
      }
    }
    return { date: D.ymd(d) };
  }

  // 고른 날짜 → 'd6' | 'm25' | 'm-1'. resolveDate 로 되돌려 같은 날짜가 나올 때만 (아니면 계획을 바꾼 것 → null)
  function encodeDate(lex, chosen, refTime) {
    if (!lexMode(lex)) return null;
    var date = (chosen && typeof chosen === 'object') ? chosen.date : chosen;
    if (typeof date !== 'string' || !YMD_RE.test(date)) return null;
    var ref = refDay(refTime), d = D.parseYmd(date);
    if (!ref || !d || isNaN(d.getTime()) || D.ymd(d) !== date) return null;
    if (d < ref) return null;
    var to = has(DATE_WORDS, lex) ? 'd' + ((d.getDay() + 6) % 7)
      : (d.getDate() === lastDayOf(d.getFullYear(), d.getMonth()) ? 'm-1' : 'm' + d.getDate());
    var back = resolveDate(lex, to, ref);
    return back && back.date === date ? to : null;
  }

  function projectName(ctx, id) {
    if (ctx.name) return String(ctx.name);
    var list = Array.isArray(ctx.projects) ? ctx.projects : (ctx.state && Array.isArray(ctx.state.projects) ? ctx.state.projects : []);
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id && !list[i].deletedAt) return String(list[i].name || '');
    return '';
  }

  // 대상을 사람 말로. ctx = { key|lex|phrase (date 어휘), projects|state|name (project 이름) }
  function says(type, to, ctx) {
    ctx = ctx || {};
    to = to == null ? '' : String(to);
    if (type === 'kind') return has(KIND_SAYS, to) ? KIND_SAYS[to] : to;
    if (type === 'project') {
      if (!to || to === 'none') return '프로젝트 없음';
      var name = projectName(ctx, to);
      return name ? '프로젝트 ‘' + name + '’' : to;
    }
    if (type === 'date') {
      var lex = ctx.key || ctx.lex || (ctx.phrase ? normKey(ctx.phrase) : null);
      var mode = lex ? lexMode(lex) : null, m;
      if ((m = /^d([0-6])$/.exec(to))) {
        var wd = WEEKDAY_NAMES[Number(m[1])];
        return mode === 'near' ? '가장 가까운 ' + wd : mode === 'next' ? '다음 주 ' + wd : wd;
      }
      if ((m = /^m(-1|\d{1,2})$/.exec(to))) {
        var day = m[1] === '-1' ? '말일' : Number(m[1]) + '일';
        return mode === 'this' ? '그달 ' + day : mode === 'nextm' ? '다음 달 ' + day : day;
      }
      return to;
    }
    return to;   // context — 상태 기능의 값 그대로 (라벨은 그쪽이 그린다)
  }

  // ------------------------------------------------------------------ 씨앗 뿌리기
  // learned.bootstrappedAt 이 없을 때 한 번만. 지우지 않은 최근 글 200개에서
  //  - capture.changedByUser 인 한 줄(80자 이하) 글 → kind 를 무게 0.5 로
  //  - capture.status 'done' + projectId + projectByAi === false 인 글 → project 를 무게 0.5 로 배운다 → 배운 수
  // 같은 표현이 여러 글에 있어도 씨앗은 횟수(n)를 올리지 않는다 — 씨앗만으로는 '참고' 수준까지만 간다(§4.2)
  // 배우기를 껐으면 아무것도 하지 않고 표시도 남기지 않는다(켜면 그때 뿌린다)
  function bootstrap(state, now) {
    var nowMs = toMs(now);
    if (!state || !isFinite(nowMs) || !enabled(state)) return 0;
    var L = ensure(state);
    if (L.bootstrappedAt) return 0;
    var live = liveProjectMap(state), learnedN = 0;
    var notes = (Array.isArray(state.notes) ? state.notes : []).filter(function (n) { return n && !n.deletedAt; })
      .map(function (n, i) { return { n: n, t: Date.parse(n.createdAt) || 0, i: i }; })
      .sort(function (a, b) { return b.t - a.t || a.i - b.i; })   // 최근 것부터
      .slice(0, 200)
      .reverse();                                                // 오래된 것부터 배워 최근 글이 last·ref 가 되게
    notes.forEach(function (x) {
      var note = x.n, cap = note.capture || {}, body = nfc(note.body).trim();
      if (cap.changedByUser && oneLine(body) && body.length <= LIMITS.KIND_TEXT_MAX) {
        var created = M.liveCreated(state, note);
        var kind = created.length === 1 ? (created[0].kind === 'task' ? 'task' : 'event')
          : created.length ? null : (note.kind || 'memo');
        if (kind && learn(state, { type: 'kind', text: body, to: kind, from: null, ref: note.id, sample: !!note.sample,
          source: 'bootstrap', weight: 0.5 }, nowMs)) learnedN++;
      }
      if (cap.status === 'done' && note.projectId && cap.projectByAi === false && live[note.projectId]) {
        if (learn(state, { type: 'project', text: note.body, to: note.projectId, ref: note.id, sample: !!note.sample,
          source: 'bootstrap', weight: 0.5 }, nowMs)) learnedN++;
      }
    });
    L.bootstrappedAt = isoOf(nowMs);
    return learnedN;
  }

  return {
    TYPES: TYPES, LIMITS: LIMITS, DATE_WORDS: DATE_WORDS, MONTH_WORDS: MONTH_WORDS,
    ensure: ensure, enabled: enabled, normKey: normKey, tokens: tokens, phrases: phrases,
    learn: learn, suggest: suggest, hints: hints, penalize: penalize, weaken: weaken,
    get: get, forget: forget, forgetRef: forgetRef, reset: reset, compact: compact, list: list, count: count,
    encodeDate: encodeDate, resolveDate: resolveDate, says: says, bootstrap: bootstrap
  };
});
