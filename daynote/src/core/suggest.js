'use strict';

// 새 할 일 제안 — 메모·이메일 본문에서 "할 일 같은 문장" 을 규칙으로 찾는다 (AI 없음).
//
// 이 모듈은 상태를 바꾸지 않는다. 후보(candidate) 배열만 돌려주고,
// 저장은 model.mergeSuggestions 가 key 기준으로 중복 없이 한다.
//
// 본문은 데이터일 뿐이다. 그 안에 무슨 지시문이 있어도 문자열로만 다룬다.
//
// ── 감지 규칙 ─────────────────────────────────────────────────────
//   1. 미완료 체크박스 줄  `- [ ] ...`        (완료 `[x]` 는 제외)
//   2. 요청·의무 표현 문장  부탁드립니다 / 해 주세요 / 해야 / 검토 / 회신 / 제출 / TODO …
//   문장은 줄, 그리고 줄 안의 마침표·물음표·느낌표 뒤 공백으로 나눈다.
//   4자 미만 · 헤딩(#) · 이메일 인용(>) · 서명(-- ) 이후 줄은 보지 않는다.
//
// ── key ─────────────────────────────────────────────────────────
//   sourceType:(messageId || id):정규화문장의 FNV-1a 해시 → 다시 스캔해도 같은 key.

(function (factory) {
  var deps = (typeof module !== 'undefined' && module.exports)
    ? { dates: require('./dates'), model: require('./model') }
    : { dates: window.Daynote.dates, model: window.Daynote.model };
  var api = factory(deps.dates, deps.model);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.suggest = api; }
})(function (D, M) {
  var MIN_LEN = 4;
  var TITLE_MAX = 60;
  var WD = { '일': 0, '월': 1, '화': 2, '수': 3, '목': 4, '금': 5, '토': 6 };

  // 앞에 있는 표현이 먼저 근거로 쓰인다 (구체적인 것 먼저)
  var REQUEST_PATTERNS = [
    { re: /검토\s*부탁/, label: '검토 부탁드립니다' },
    { re: /확인\s*(?:부탁|바랍니다|바람|요청)/, label: '확인 바랍니다' },
    { re: /회신\s*(?:부탁|바랍니다|주세요|요청)/, label: '회신 부탁드립니다' },
    { re: /부탁\s*드(?:립니다|려요|립니당)/, label: '부탁드립니다' },
    { re: /부탁해요|부탁합니다/, label: '부탁합니다' },
    { re: /요청\s*드(?:립니다|려요)|요청합니다/, label: '요청드립니다' },
    { re: /해\s*주세요|해\s*주시기|해\s*주실|해\s*줘/, label: '해 주세요' },
    { re: /주시기\s*바랍니다|주세요/, label: '주세요' },
    { re: /해야\s*(?:함|합니다|해요|한다|됨|돼|된다|겠)/, label: '해야 합니다' },
    { re: /필요합니다|필요함|필요해요/, label: '필요합니다' },
    { re: /제출/, label: '제출' },
    { re: /회신/, label: '회신' },
    { re: /검토/, label: '검토' },
    { re: /요청/, label: '요청' },
    { re: /\bTODO\b|\bto-?do\b/i, label: 'TODO' }
  ];

  // ------------------------------------------------------------------ 문자열 도우미
  // 비교용 정규화: 체크박스·머리표·공백·기호를 지우고 소문자로.
  function normalizeText(s) {
    return String(s || '')
      .replace(/^\s*(?:[-*+]|\d+[.)])?\s*\[[ xX]\]\s*/, '')
      .replace(/^\s*(?:[-*+•·]|\d+[.)])\s+/, '')
      .toLowerCase()
      .replace(/[\s ]+/g, '')
      .replace(/[^0-9a-z가-힣ㄱ-ㆎ]/g, '');
  }

  // FNV-1a 32비트 → 8자리 16진수
  function hash(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul ? Math.imul(h, 0x01000193) : (h * 0x01000193) | 0;
    }
    var hex = (h >>> 0).toString(16);
    while (hex.length < 8) hex = '0' + hex;
    return hex;
  }

  function cleanTitle(s) {
    var t = String(s || '')
      .replace(/^\s*(?:[-*+]|\d+[.)])?\s*\[[ xX]\]\s*/, '')
      .replace(/^\s*(?:[-*+•·]|\d+[.)])\s+/, '')
      .replace(/^\s*TODO\s*[:：-]?\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (t.length > TITLE_MAX) t = t.slice(0, TITLE_MAX - 1).trim() + '…';
    return t;
  }

  function senderName(from) {
    var f = String(from || '').trim();
    if (!f) return '';
    var m = f.match(/^"?([^"<]+?)"?\s*<[^>]*>$/);
    if (m) return m[1].trim();
    m = f.match(/^<?([^@<>\s]+)@/);
    return m ? m[1] : f;
  }

  // ------------------------------------------------------------------ 날짜 힌트
  function validMd(y, mo, d) {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    var dt = new Date(y, mo - 1, d);
    return dt.getMonth() === mo - 1 ? dt : null;
  }

  // 텍스트 속 마감 표현 → { dueDate, phrase } | null. 지난 날짜는 다음 해·다음 달·다음 주로 민다.
  function parseDueHint(text, now) {
    var s = String(text || '');
    now = now ? new Date(now) : new Date();
    var today = D.startOfDay(now);
    var y = today.getFullYear();
    var m, dt;

    // 10월 7일(까지)
    m = s.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일(?:\s*까지)?/);
    if (m) {
      dt = validMd(y, +m[1], +m[2]);
      if (dt) {
        if (dt < today) dt = validMd(y + 1, +m[1], +m[2]) || dt;
        return { dueDate: D.ymd(dt), phrase: m[0] };
      }
    }
    // 10/7(까지) — 분수·날짜 범위 오인을 줄이려 앞뒤에 숫자·슬래시가 없을 때만
    m = s.match(/(?:^|[^\d/])(\d{1,2})\/(\d{1,2})(?![\d/])(?:\s*까지)?/);
    if (m) {
      dt = validMd(y, +m[1], +m[2]);
      if (dt) {
        if (dt < today) dt = validMd(y + 1, +m[1], +m[2]) || dt;
        return { dueDate: D.ymd(dt), phrase: m[0].replace(/^[^\d]/, '') };
      }
    }
    // (이번 주|다음 주|차주) 금요일(까지)
    m = s.match(/(?:(이번\s*주|금주|다음\s*주|차주)\s*)?([월화수목금토일])요일(?:\s*까지)?/);
    if (m) {
      var idx = (WD[m[2]] + 6) % 7;                 // 월=0 … 일=6
      var base = D.startOfWeek(today);
      var next = m[1] && /다음|차주/.test(m[1]);
      dt = D.addDays(base, idx + (next ? 7 : 0));
      if (!next && dt < today) dt = D.addDays(dt, 7);
      return { dueDate: D.ymd(dt), phrase: m[0] };
    }
    // 오늘 / 내일 / 모레
    m = s.match(/(오늘|내일|모레)(?:\s*까지)?/);
    if (m) {
      var add = { '오늘': 0, '내일': 1, '모레': 2 }[m[1]];
      return { dueDate: D.ymd(D.addDays(today, add)), phrase: m[0] };
    }
    // 7일까지 — 지났으면 다음 달
    m = s.match(/(?:^|[^\d월])(\d{1,2})\s*일\s*까지/);
    if (m) {
      var day = +m[1];
      dt = validMd(y, today.getMonth() + 1, day);
      if (!dt || dt < today) {
        var nm = new Date(y, today.getMonth() + 1, 1);
        dt = validMd(nm.getFullYear(), nm.getMonth() + 1, day);
      }
      if (dt) return { dueDate: D.ymd(dt), phrase: m[0].replace(/^[^\d]/, '') };
    }
    return null;
  }

  // ------------------------------------------------------------------ 문장 찾기
  // 본문 → [{ text, kind:'checkbox'|'sentence' }]
  function sentencesOf(body, isEmail) {
    var out = [];
    var lines = String(body || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var trimmed = line.trim();
      if (isEmail) {
        if (/^--\s*$/.test(trimmed) || /^_{3,}$/.test(trimmed)) break;    // 서명 구분선
        if (/^-{2,}\s*(?:original message|원본 메시지|전달된 메시지)/i.test(trimmed)) break;
        if (/^On .+wrote:$/.test(trimmed) || /님이 작성:$/.test(trimmed)) break;
        if (/^>/.test(trimmed)) continue;
      }
      if (!trimmed || /^#{1,6}\s/.test(trimmed)) continue;
      if (/^\s*(?:[-*+]|\d+[.)])?\s*\[[xX]\]/.test(line)) continue;      // 완료 체크박스
      if (/^\s*(?:[-*+]|\d+[.)])?\s*\[ \]/.test(line)) {
        out.push({ text: trimmed, kind: 'checkbox' });
        continue;
      }
      trimmed.split(/(?<=[.?!。])\s+/).forEach(function (p) {
        if (p.trim()) out.push({ text: p.trim(), kind: 'sentence' });
      });
    }
    return out;
  }

  function requestLabel(text) {
    for (var i = 0; i < REQUEST_PATTERNS.length; i++) if (REQUEST_PATTERNS[i].re.test(text)) return REQUEST_PATTERNS[i].label;
    return null;
  }

  function build(sourceType, src, keyId, projectId, now, reasonFn, isEmail, body) {
    var out = [], seen = {};
    sentencesOf(body, isEmail).forEach(function (s) {
      var norm = normalizeText(s.text);
      if (norm.length < MIN_LEN || seen[norm]) return;
      var label = s.kind === 'checkbox' ? null : requestLabel(s.text);
      if (s.kind !== 'checkbox' && !label) return;
      var title = cleanTitle(s.text);
      if (title.replace(/\s/g, '').length < MIN_LEN) return;
      seen[norm] = true;
      var due = parseDueHint(s.text, now);
      out.push({
        key: sourceType + ':' + keyId + ':' + hash(norm),
        sourceType: sourceType,
        sourceId: src.id,
        excerpt: s.text,
        title: title,
        reason: reasonFn(s.kind, label),
        dueDate: due ? due.dueDate : null,
        dueEstimated: !!due,
        dueHint: due ? due.phrase : null,
        projectId: projectId || null,
        sample: !!src.sample
      });
    });
    return out;
  }

  function extractFromNote(note, now) {
    if (!note || note.deletedAt) return [];
    return build('note', note, note.id, note.projectId, now, function (kind, label) {
      return kind === 'checkbox' ? '미완료 체크박스로 적힌 항목입니다' : '‘' + label + '’라는 요청 표현이 있습니다';
    }, false, note.body);
  }

  function extractFromEmail(email, now) {
    if (!email || email.deletedAt) return [];
    var who = senderName(email.from);
    return build('email', email, email.messageId || email.id, email.projectId, now, function (kind, label) {
      var head = who ? who + '님이 보낸 메일' : '받은 메일';
      return kind === 'checkbox' ? head + '의 미완료 체크박스 항목입니다' : head + '의 요청 표현입니다 (‘' + label + '’)';
    }, true, email.body);
  }

  // 모든 살아 있는 메모·메일을 훑는다. 이미 할 일로 만들어진 문장(sources[].excerpt)은 뺀다.
  function scan(state, now) {
    var taken = {};
    M.liveTasks(state).forEach(function (t) {
      (t.sources || []).forEach(function (s) { if (s.excerpt) taken[normalizeText(s.excerpt)] = true; });
    });
    var all = [];
    M.liveNotes(state).forEach(function (n) { all = all.concat(extractFromNote(n, now)); });
    // 메일은 사용자가 연결했을 때만 읽는다 (연결을 끊으면 남은 메일로 새 제안을 만들지 않는다)
    var mailOn = state.emailConnection && state.emailConnection.status === 'connected';
    if (mailOn) (state.emails || []).forEach(function (e) { all = all.concat(extractFromEmail(e, now)); });
    return all.filter(function (c) { return !taken[normalizeText(c.excerpt)]; });
  }

  return {
    parseDueHint: parseDueHint, extractFromNote: extractFromNote, extractFromEmail: extractFromEmail,
    scan: scan, normalizeText: normalizeText, hash: hash
  };
});
