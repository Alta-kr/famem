'use strict';

// AI 응답 검증 — 앱이 책임지는 쪽.
//
//  1. 형식: 정해진 구조가 아니면 실행 전체를 '형식 오류' 로 본다.
//  2. 근거: 인용 문장이 원문에 없으면 그 항목은 버린다 (지어낸 항목 차단).
//  3. 날짜·시각: 메모의 표현을 앱이 직접 다시 계산해 AI 값과 맞춰 본다.
//     근거가 없거나 서로 다르면 값을 채우지 않고 "확인 필요" 로 둔다 — 사용자가 고르기 전엔 확정하지 않는다.
//  4. 중복: 이미 있는 할 일·일정과 겹치면 표시하고 기본 선택에서 뺀다.
//
// 필드 하나의 모양: { value, status: 'ok'|'confirm', message, options: [{label, value}] }
//   status 'ok'      → 원문으로 검증된 값(또는 원문에 없어서 비어 있는 것이 맞는 값)
//   status 'confirm' → value 는 비워 두고, 근거 있는 후보만 options 로 보여준다

//  5. 맥락·걸어 둔 상태·상태 보고(capture.v7 K·L·M)와 배치 힌트(N): 목록에 없는 값, 원문에 근거가 없는 값은 버린다.

(function (factory) {
  var node = typeof module !== 'undefined' && module.exports;
  var deps = node
    ? { dates: require('../dates'), model: require('../model'), suggest: require('../suggest'), status: require('../status') }
    : { dates: window.Daynote.dates, model: window.Daynote.model, suggest: window.Daynote.suggest, status: window.Daynote.statusCore || null };
  var api = factory(deps.dates, deps.model, deps.suggest, deps.status);
  if (node) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.aiValidate = api; }
})(function (D, M, SG, ST) {
  var norm = SG.normalizeText;
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  var MAX_TITLE = 120;

  // ------------------------------------------------------------------ 형식
  function isStr(v) { return typeof v === 'string'; }
  function isNullStr(v) { return v === null || typeof v === 'string'; }
  function isNullInt(v) { return v === null || (typeof v === 'number' && Math.floor(v) === v); }

  function shapeErrors(out) {
    var errs = [];
    function need(cond, path) { if (!cond) errs.push(path); }
    if (!out || typeof out !== 'object') return ['응답이 객체가 아닙니다'];
    need(isStr(out.summary), 'summary');
    ['sections', 'tasks', 'events', 'open_questions'].forEach(function (k) { need(Array.isArray(out[k]), k); });
    if (errs.length) return errs;
    out.sections.forEach(function (s, i) {
      need(s && isStr(s.heading) && Array.isArray(s.bullets), 'sections[' + i + ']');
      (s && Array.isArray(s.bullets) ? s.bullets : []).forEach(function (b, j) { need(b && isStr(b.text) && isNullInt(b.line), 'sections[' + i + '].bullets[' + j + ']'); });
    });
    function when(w) { return w && isNullStr(w.text) && isNullStr(w.date) && isNullStr(w.time); }
    function ev(e) { return e && isStr(e.quote) && isNullInt(e.line); }
    out.tasks.forEach(function (t, i) { need(t && isStr(t.title) && ev(t.evidence) && when(t.due) && isNullStr(t.project_hint), 'tasks[' + i + ']'); });
    out.events.forEach(function (e, i) { need(e && isStr(e.title) && ev(e.evidence) && when(e.start) && isNullInt(e.duration_minutes) && isNullStr(e.location), 'events[' + i + ']'); });
    out.open_questions.forEach(function (q, i) { need(q && isStr(q.text), 'open_questions[' + i + ']'); });
    return errs;
  }

  // ------------------------------------------------------------------ 원문
  // 0번 줄은 제목, 1번부터 본문 (organizeNote.userText 와 같은 번호)
  function noteLines(note) { return [note.title || ''].concat((note.body || '').split('\n')); }

  // 인용 문장이 있는 줄을 찾는다. AI 가 준 줄 번호를 먼저 보고, 틀렸으면 전체에서 찾는다.
  function locate(lines, quote, hintLine) {
    var q = norm(quote);
    if (q.length < 2) return -1;
    if (hintLine != null && lines[hintLine] != null && norm(lines[hintLine]).indexOf(q) !== -1) return hintLine;
    for (var i = 0; i < lines.length; i++) if (norm(lines[i]).indexOf(q) !== -1) return i;
    return -1;
  }

  function inText(fullNorm, phrase) {
    var p = norm(phrase);
    return p.length > 0 && fullNorm.indexOf(p) !== -1;
  }

  // ------------------------------------------------------------------ 날짜·시각
  function field(value, status, message, options) {
    return { value: value === undefined ? null : value, status: status || 'ok', message: message || '', options: options || [] };
  }
  function opt(label, value) { return { label: label, value: value }; }

  // "오후 3시", "15:30", "3시 반" → ['15:00'] 처럼 후보를 돌려준다. 오전/오후가 없으면 두 가지가 다 후보다.
  function timeCandidates(text) {
    var s = String(text || '');
    if (/정오/.test(s)) return ['12:00'];
    if (/자정/.test(s)) return ['00:00'];
    var m = s.match(/(오전|오후|아침|저녁|밤)?\s*(\d{1,2})\s*(?::\s*(\d{2})|시\s*(?:(\d{1,2})\s*분|(반))?)/);
    if (!m) return [];
    var h = +m[2], min = m[3] != null ? +m[3] : m[4] != null ? +m[4] : m[5] ? 30 : 0;
    if (h > 24 || min > 59) return [];
    var pad = D.pad;
    if (m[3] != null && !m[1]) return [pad(h % 24) + ':' + pad(min)];   // 15:30 처럼 24시간 표기
    if (m[1] === '오후' || m[1] === '저녁' || m[1] === '밤') return [pad(h < 12 ? h + 12 : h) + ':' + pad(min)];
    if (m[1] === '오전' || m[1] === '아침') return [pad(h % 12) + ':' + pad(min)];
    var out = [pad(h % 24) + ':' + pad(min)];
    if (h >= 1 && h <= 11) out.push(pad(h + 12) + ':' + pad(min));
    return out;
  }

  // 시각 표현 하나와 그 위치 — "오후 3시", "15:30", "3시 반". '1시간' 의 '1시' 는 시각이 아니다.
  //   → { text, index, candidates } | null  (candidates 는 timeCandidates 와 같은 규칙)
  var TIME_AT_RE = /(오전|오후|아침|저녁|밤)?\s*(\d{1,2})\s*(?::\s*(\d{2})|시(?!간)(?:\s*(\d{1,2})\s*분|\s*(반))?)/;
  function timeMatch(text) {
    var s = String(text || '');
    var m = s.match(/정오|자정/);
    var t = s.match(TIME_AT_RE);
    if (m && (!t || m.index < t.index)) return { text: m[0], index: m.index, candidates: m[0] === '정오' ? ['12:00'] : ['00:00'] };
    if (!t) return null;
    var cands = timeCandidates(t[0]);
    if (!cands.length) return null;
    var lead = t[0].length - t[0].replace(/^\s+/, '').length;
    return { text: t[0].trim(), index: t.index + lead, candidates: cands };
  }

  // "30분 후", "1시간 뒤", "한 시간 반 후", "반 시간 있다가" 같은 상대 시각 → 기준 시각에서 몇 분 뒤인지
  //   → { minutes, text, index } | null
  var KNUM = { '한': 1, '두': 2, '세': 3, '네': 4, '다섯': 5, '여섯': 6 };
  function relativeMinutes(text) {
    var s = String(text || '');
    var m = s.match(/(\d+|한|두|세|네|다섯|여섯|반)\s*시간\s*(반)?\s*(?:(\d+)\s*분)?\s*(?:후|뒤|있다가|이따)/);
    if (m) {
      var h = m[1] === '반' ? 0.5 : (KNUM[m[1]] || +m[1]);
      return { minutes: Math.round(h * 60) + (m[2] ? 30 : 0) + (m[3] ? +m[3] : 0), text: m[0], index: m.index };
    }
    m = s.match(/(\d+)\s*분\s*(?:후|뒤|있다가|이따)/);
    if (m) return { minutes: +m[1], text: m[0], index: m.index };
    return null;
  }
  // 기준 시각 + 상대 시각 (5분 단위로 반올림) → { date, time, text, index } | null
  function relativeAt(text, ref) {
    var r = relativeMinutes(text);
    var mins = r ? r.minutes : null;
    if (mins == null || mins <= 0 || mins > 24 * 60) return null;
    var t = new Date(new Date(ref).getTime() + mins * 60000);
    t.setSeconds(0, 0);
    t.setMinutes(Math.round(t.getMinutes() / 5) * 5);
    return { date: D.ymd(t), time: D.pad(t.getHours()) + ':' + D.pad(t.getMinutes()), text: r.text, index: r.index };
  }

  // 길이 표현: "2시~4시"(시작 시각이 있을 때), "1시간", "1시간 30분", "30분간·30분 동안" → { minutes, text, index } | null
  function durationSpan(text, startTime) {
    var src = String(text || '');
    var range = src.match(/(\d{1,2})\s*(?:시|:\d{2})?\s*[~\-–]\s*(\d{1,2})\s*시/);
    if (range && startTime) {
      var sh = +startTime.slice(0, 2), eh = +range[2];
      if (eh <= 12 && sh >= 12) eh += 12;
      else if (eh <= sh && eh < 12 && eh + 12 > sh) eh += 12;      // 정오를 넘는 범위: "오전 11시~1시" → 13시
      if (eh > sh) {
        var span = (eh - sh) * 60 - +startTime.slice(3);
        if (span) return { minutes: span, text: range[0], index: range.index };
      }
    }
    var len = src.match(/(\d+)\s*시간(?:\s*(\d+)\s*분)?|(\d+)\s*분\s*(?:간|동안)/);
    if (len) {
      var mins = len[1] ? (+len[1]) * 60 + (+(len[2] || 0)) : +len[3];
      if (mins) return { minutes: mins, text: len[0], index: len.index };
    }
    return null;
  }

  // 글 안의 '걸리는 시간' 표현들 (배치 힌트 minutes 검증·가짜 AI 용) — dates.parseDuration 이 읽는 것만.
  //   "30분 후"(상대 시각), "3시 30분"(시각) 은 길이가 아니다. → [{ minutes, text, index }]
  var DUR_SCAN_RE = /(?:\d+(?:\.\d+)?|열한|열두|다섯|여섯|일곱|여덟|아홉|열|한|두|세|네)\s*시간(?:\s*반|\s*\d+\s*분)?|반\s*시간|\d+\s*분/g;
  function durationMentions(text) {
    var s = String(text || ''), out = [], m;
    DUR_SCAN_RE.lastIndex = 0;
    while ((m = DUR_SCAN_RE.exec(s))) {
      var after = s.slice(m.index + m[0].length);
      var before = s.slice(0, m.index);
      if (/^\s*(?:후|뒤|있다가|이따|전)/.test(after)) continue;
      if (/\d\s*시\s*$/.test(before) && /^\d/.test(m[0])) continue;
      var p = D.parseDuration ? D.parseDuration(m[0]) : null;
      if (p && p.ok) out.push({ minutes: p.minutes, text: m[0], index: m.index });
    }
    return out;
  }

  // 날짜 검증. required 이면(일정) 비어 있을 때도 확인 필요로 둔다.
  function checkDate(w, ctx, required) {
    var text = w.text && w.text.trim() ? w.text.trim() : null;
    var ai = w.date && DATE_RE.test(w.date) && D.ymd(D.parseYmd(w.date)) === w.date ? w.date : null;
    // 상대 시각이면 앱이 직접 계산한 날짜를 쓴다 (AI 가 기준 시각을 잘못 읽어도 바로잡힌다)
    var rel = text && inText(ctx.fullNorm, text) ? relativeAt(text, ctx.ref) : null;
    if (rel) return field(rel.date, 'ok');
    if (!text) {
      if (ai) return field(null, 'confirm', '메모에 날짜 표현이 없는데 AI가 날짜를 제안했습니다.', [opt('AI 제안', ai)]);
      return required ? field(null, 'confirm', '메모에 날짜가 없습니다. 날짜를 정해 주세요.') : field(null, 'ok');
    }
    if (!inText(ctx.fullNorm, text)) {
      return field(null, 'confirm', '날짜 표현 ‘' + text + '’을(를) 원문에서 찾지 못했습니다.', ai ? [opt('AI 제안', ai)] : []);
    }
    var parsed = SG.parseDueHint(text, ctx.ref);
    var app = parsed ? parsed.dueDate : null;
    var res;
    if (app && ai && app === ai) res = field(ai, 'ok');
    else if (app && ai) res = field(null, 'confirm', '‘' + text + '’ 해석이 다릅니다. 맞는 날짜를 골라 주세요.', [opt('AI 해석', ai), opt('앱 계산', app)]);
    else if (app) res = field(null, 'confirm', '‘' + text + '’을(를) 앱이 날짜로 계산했습니다. 확인해 주세요.', [opt('앱 계산', app)]);
    else if (ai) res = field(null, 'confirm', '‘' + text + '’은(는) 앱이 검증하지 못한 표현입니다. AI 해석을 확인해 주세요.', [opt('AI 해석', ai)]);
    else res = field(null, 'confirm', '‘' + text + '’을(를) 날짜로 정하지 못했습니다.');
    if (res.status === 'ok' && res.value < D.ymd(ctx.ref)) {
      res = field(null, 'confirm', '‘' + text + '’ → ' + res.value + ' 은(는) 메모 기준으로 이미 지난 날짜입니다.', [opt('그래도 사용', res.value)]);
    }
    return res;
  }

  function checkTime(w, quote, ctx, required) {
    var ai = w.time && TIME_RE.test(w.time) ? w.time : null;
    var src = [w.text || '', quote || ''].join(' ');
    var srcOk = !w.text || inText(ctx.fullNorm, w.text);
    // "30분 후" 같은 상대 시각은 앱이 기준 시각으로 계산한 값이 정답이다
    var rel = srcOk ? relativeAt(src, ctx.ref) : null;
    if (rel) return field(rel.time, 'ok');
    var cands = timeCandidates(src);
    if (!cands.length || !srcOk) {
      if (ai) return field(null, 'confirm', '메모에 시각이 없는데 AI가 시각을 제안했습니다.', [opt('AI 제안', ai)]);
      return required ? field(null, 'confirm', '메모에 시각이 없습니다. 시각을 정해 주세요.') : field(null, 'ok');
    }
    if (ai && cands.indexOf(ai) !== -1) return field(ai, 'ok');
    var options = cands.map(function (c) { return opt('메모 표현', c); });
    if (ai) options.unshift(opt('AI 해석', ai));
    return field(null, 'confirm', cands.length > 1 ? '오전인지 오후인지 메모에 없습니다.' : '시각 해석이 다릅니다.', options);
  }

  // 길이: 메모에 "2시~4시", "30분", "1시간" 이 있을 때만 검증된 값이다
  function checkDuration(ai, w, quote, startTime) {
    var src = [w.text || '', quote || ''].join(' ');
    var ds = durationSpan(src, startTime);
    var span = ds ? ds.minutes : null;
    var aiOk = typeof ai === 'number' && ai > 0 && ai <= 24 * 60 ? ai : null;
    if (span && aiOk === span) return field(span, 'ok');
    if (span) return field(null, 'confirm', '메모 기준 소요 시간과 AI 값이 다릅니다.', [opt('메모 기준', span)].concat(aiOk ? [opt('AI 제안', aiOk)] : []));
    if (aiOk) return field(null, 'confirm', '메모에 소요 시간이 없습니다. AI 제안을 확인해 주세요.', [opt('AI 제안', aiOk)]);
    return field(null, 'confirm', '메모에 소요 시간이 없습니다. 소요 시간을 정해 주세요.');
  }

  function checkProject(hint, ctx) {
    if (hint) {
      var h = norm(hint);
      var match = ctx.projects.filter(function (p) { var n = norm(p.name); return n && (n === h || n.indexOf(h) !== -1 || h.indexOf(n) !== -1); })[0];
      if (match) return field(match.id, 'ok');
    }
    return field(ctx.note.projectId || null, 'ok');
  }

  // ------------------------------------------------------------------ 중복
  function findDupTask(state, title, quote) {
    var t = norm(title), q = norm(quote);
    return M.liveTasks(state).filter(function (x) {
      if (x.status === 'done' && x.completedAt) { /* 끝난 일도 같은 일이면 중복이다 */ }
      if (t && norm(x.title) === t) return true;
      return (x.sources || []).some(function (s) { return s.excerpt && norm(s.excerpt) === q; });
    })[0] || null;
  }

  // 같은 날 비슷한 이름의 일정만 중복이다. 시간만 겹치는 다른 일정은 중복이 아니라 "충돌" 이며 검토 화면이 따로 보여준다.
  function findDupEvent(state, title, date) {
    if (!date) return null;
    var t = norm(title);
    if (!t) return null;
    return state.blocks.filter(function (b) {
      if (D.ymd(b.start) !== date) return false;
      var bt = norm(b.taskId ? (M.byId(state.tasks, b.taskId) || {}).title || '' : b.title || '');
      return bt && (bt === t || (Math.min(bt.length, t.length) >= 4 && (bt.indexOf(t) !== -1 || t.indexOf(bt) !== -1)));
    })[0] || null;
  }

  // 단계 초안 정리: 제목 1~80자, 소요 시간 1~480분(아니면 미정), 2~8개. 조건에 맞지 않으면 빈 배열.
  function sanitizeSteps(list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    list.forEach(function (s) {
      if (!s || typeof s.title !== 'string') return;
      var t = s.title.trim().replace(/\s+/g, ' ');
      if (!t) return;
      if (t.length > 80) t = t.slice(0, 79) + '…';
      var m = typeof s.minutes === 'number' && Math.floor(s.minutes) === s.minutes && s.minutes >= 1 && s.minutes <= 480 ? s.minutes : null;
      out.push({ title: t, minutes: m });
    });
    out = out.slice(0, 8);
    return out.length >= 2 ? out : [];
  }

  // ------------------------------------------------------------------ 맥락 · 걸어 둔 상태 · 상태 보고 · 배치 힌트 (capture.v7)
  var DO_IN = ['work', 'off', 'out', 'pause', 'rest'];
  var PRESENCE_ROLES = ['work_start', 'work_end', 'commute_in', 'commute_out', 'break', 'meal', 'out', 'field', 'meeting',
    'focus', 'class', 'drive', 'exercise', 'day_off', 'sleep', 'none'];
  var SCHED_ENUM = { focus: ['deep', 'light'], energy: ['high', 'low'], prefer: ['morning', 'afternoon', 'evening'] };

  // 맥락 id 는 지금 설정의 맥락 목록에 있을 때만 (모르면 null — 업무로 단정하지 않는다)
  function checkContext(v, contextIds) {
    return typeof v === 'string' && contextIds && contextIds.indexOf(v) !== -1 ? v : null;
  }
  // 걸어 둔 상태: 근거 문장에 그 표현이 실제로 있을 때만 (지어내지 않는다)
  function checkAtMode(doIn, quote) {
    if (!ST || DO_IN.indexOf(doIn) === -1) return null;
    if (ST.findAtMode(quote) !== doIn) return null;
    return { mode: doIn, phrase: ST.atModePhrase(doIn) };
  }
  // 배치 힌트: 형식이 틀린 칸만 null. minutes 는 근거 문장에 같은 길이 표현이 있을 때만. 다섯 칸이 모두 null 이면 null
  function checkSched(raw, quote, hasDoAt) {
    if (!raw || typeof raw !== 'object') return null;
    var out = { focus: null, energy: null, prefer: null, splittable: null, minutes: null };
    Object.keys(SCHED_ENUM).forEach(function (k) { if (SCHED_ENUM[k].indexOf(raw[k]) !== -1) out[k] = raw[k]; });
    if (hasDoAt) out.prefer = null;
    if (typeof raw.splittable === 'boolean') out.splittable = raw.splittable;
    var m = raw.minutes;
    if (typeof m === 'number' && Math.floor(m) === m && m >= (D.DURATION_MIN || 5) && m <= (D.DURATION_MAX || 720)) {
      var said = durationMentions(quote).some(function (x) { return x.minutes === m; });
      if (said) out.minutes = m;
    }
    var any = Object.keys(out).some(function (k) { return out[k] != null; });
    return any ? out : null;
  }
  // 상태 보고(presence): 역할이 목록에 있고 'none' 이 아니며 근거 문장이 원문에 있을 때만. 앱이 이미 상태 줄을 처리한 글은 버린다
  function checkPresence(raw, lines, note) {
    if (!raw || typeof raw !== 'object') return null;
    if (note && note.capture && note.capture.statusLine) return null;
    if (PRESENCE_ROLES.indexOf(raw.role) === -1 || raw.role === 'none') return null;
    if (typeof raw.quote !== 'string') return null;
    var quote = raw.quote.trim();
    var line = locate(lines, quote, null);
    if (line < 0) return null;
    return { role: raw.role, quote: quote, line: line };
  }

  // ------------------------------------------------------------------ 본체
  // ctx: { note, state, now }
  function validateOrganizeNote(out, ctx) {
    var errs = shapeErrors(out);
    if (errs.length) return { ok: false, errors: errs, items: [], dropped: [], digest: null };

    var note = ctx.note, state = ctx.state;
    var lines = noteLines(note);
    var c = {
      note: note, state: state,
      ref: new Date(note.updatedAt || ctx.now || Date.now()),
      fullNorm: norm(lines.join('\n')),
      projects: M.liveProjects(state),
      contextIds: ST ? ST.profile(state && state.prefs).contextIds : []
    };
    var items = [], dropped = [];
    var seenQuote = {};

    function base(kind, raw) {
      var quote = String(raw.evidence.quote || '').trim();
      var line = locate(lines, quote, raw.evidence.line);
      if (line < 0) { dropped.push({ kind: kind, title: raw.title, quote: quote, reason: '근거 문장이 원문에 없습니다' }); return null; }
      var title = String(raw.title || '').trim().replace(/\s+/g, ' ');
      if (!title) { dropped.push({ kind: kind, title: '', quote: quote, reason: '제목이 비어 있습니다' }); return null; }
      if (title.length > MAX_TITLE) title = title.slice(0, MAX_TITLE - 1) + '…';
      // 같은 문장에서 나온 항목이 여럿이면 순번으로 구분한다 (다시 정리해도 같은 key 가 되도록)
      var qk = kind + ':' + norm(quote);
      var ordinal = seenQuote[qk] || 0;
      seenQuote[qk] = ordinal + 1;
      var flags = [];
      if (raw.basis === 'inferred') flags.push('메모에 직접 적힌 것이 아니라 AI가 추론한 항목입니다.');
      return { kind: kind, quote: quote, line: line, ordinal: ordinal, basis: raw.basis === 'inferred' ? 'inferred' : 'explicit', flags: flags, title: title };
    }

    out.tasks.forEach(function (raw) {
      var b = base('task', raw);
      if (!b) return;
      var due = checkDate(raw.due, c, false);
      var time = raw.due.time || raw.due.text ? checkTime(raw.due, null, c, false) : field(null, 'ok');
      var dup = findDupTask(state, b.title, b.quote);
      var steps = raw.size === 'large' ? sanitizeSteps(raw.breakdown) : [];
      var fields = { title: field(b.title, 'ok'), dueDate: due, dueTime: time, projectId: checkProject(raw.project_hint, c) };
      // 시간 정한 할 일 (do_at: "30분 후 샤워하기") — 검증된 날짜·시각이 둘 다 있을 때만 작업 시간을 만든다
      var at = raw.do_at;
      if (at && (at.text || at.time)) {
        fields.atDate = checkDate(at, c, false);
        fields.atTime = checkTime(at, b.quote, c, false);
        // "3시에 쓰기" 처럼 날짜 표현이 없으면 오늘(메모 기준)
        if (fields.atDate.value == null && fields.atTime.value && (!at.text || !SG.parseDueHint(at.text, c.ref))) {
          var rel = relativeAt([at.text || '', b.quote || ''].join(' '), c.ref);
          fields.atDate = field(rel ? rel.date : D.ymd(c.ref), 'ok');
        }
      }
      var hasDoAt = !!(at && (at.text || at.time));
      items.push(Object.assign(b, {
        fields: fields,
        duplicateOf: dup ? { kind: 'task', id: dup.id, label: dup.title } : null,
        // 큰 할 일의 단계 초안 — 바로 적용하지 않고 할 일에 보관했다가 나중에 제안한다
        extra: steps.length ? { size: 'large', breakdown: steps } : null,
        context: checkContext(raw.context, c.contextIds),
        atMode: checkAtMode(raw.do_in, b.quote),
        sched: checkSched(raw.sched, b.quote, hasDoAt)
      }));
    });

    out.events.forEach(function (raw) {
      var b = base('event', raw);
      if (!b) return;
      var date = checkDate(raw.start, c, true);
      var time = checkTime(raw.start, b.quote, c, true);
      var dur = checkDuration(raw.duration_minutes, raw.start, b.quote, time.value || (time.options[0] && time.options[0].value));
      var loc = raw.location && inText(c.fullNorm, raw.location) ? field(raw.location.trim(), 'ok')
        : raw.location ? field(null, 'confirm', '장소 ‘' + raw.location + '’이(가) 메모에 없습니다.', [opt('AI 제안', raw.location)]) : field(null, 'ok');
      var dup = findDupEvent(state, b.title, date.value);
      items.push(Object.assign(b, {
        fields: { title: field(b.title, 'ok'), date: date, time: time, durationMinutes: dur, location: loc, projectId: checkProject(null, c) },
        duplicateOf: dup ? { kind: 'block', id: dup.id, label: dup.title || '기존 일정' } : null
      }));
    });

    items.forEach(function (it) {
      it.defaultChecked = !it.duplicateOf && it.basis === 'explicit';
    });

    var digest = {
      summary: out.summary.trim(),
      sections: out.sections.map(function (s) {
        return { heading: s.heading.trim(), bullets: s.bullets.map(function (b) {
          var ln = b.line != null && lines[b.line] != null ? b.line : null;
          return { text: b.text.trim(), line: ln };
        }).filter(function (b) { return b.text; }) };
      }).filter(function (s) { return s.heading || s.bullets.length; }),
      openQuestions: out.open_questions.map(function (q) { return { text: q.text.trim(), line: q.line != null && lines[q.line] != null ? q.line : null }; }).filter(function (q) { return q.text; })
    };

    return { ok: true, errors: [], items: items, dropped: dropped, digest: digest, presence: checkPresence(out.presence, lines, note) };
  }

  // 기존 할 일의 날짜·시각을 바꾸라는 보고("견적서는 내일 보낼게")에 쓴다 — 새 항목과 같은 검증을 거친다.
  // 날짜(·시각)가 원문 표현으로 확인될 때만 값을 준다. 시각만 있고 날짜 표현이 없으면 기준일(오늘).
  function verifyWhen(w, quote, note, now) {
    if (!w || !(w.text || w.date || w.time)) return null;
    var c = { ref: new Date(note.updatedAt || now || Date.now()), fullNorm: norm(noteLines(note).join('\n')) };
    var d = checkDate(w, c, false);
    var t = (w.time || w.text) ? checkTime(w, quote, c, false) : field(null, 'ok');
    var date = d.status === 'ok' ? d.value : null;
    var time = t.status === 'ok' ? t.value : null;
    if (!date && time && (!w.text || !SG.parseDueHint(w.text, c.ref))) {
      var rel = relativeAt([w.text || '', quote || ''].join(' '), c.ref);
      date = rel ? rel.date : D.ymd(c.ref);
    }
    if (!date) return null;
    if (date < D.ymd(c.ref)) return null;   // 지난 날짜로 옮기라는 건 받지 않는다
    return { date: date, time: time };
  }

  return {
    verifyWhen: verifyWhen,
    relativeAt: relativeAt, relativeMinutes: relativeMinutes, timeMatch: timeMatch, durationSpan: durationSpan, durationMentions: durationMentions,
    DO_IN: DO_IN, PRESENCE_ROLES: PRESENCE_ROLES,
    validateOrganizeNote: validateOrganizeNote, shapeErrors: shapeErrors, timeCandidates: timeCandidates, sanitizeSteps: sanitizeSteps,
    noteLines: noteLines, locate: locate, DATE_RE: DATE_RE, TIME_RE: TIME_RE
  };
});
