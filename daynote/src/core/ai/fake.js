'use strict';

// 가짜 AI — 실제 API 없이 검토 화면과 검증 흐름을 확인하기 위한 것.
// 화면에는 항상 '가짜 AI(테스트)' 로 표시된다. 결과는 규칙 추출(suggest.js)로 만든다.
// 실제 AI 처럼 "그럴듯하지만 틀린" 값도 섞어서 검증기가 걸러내는지 볼 수 있게 했다:
//   - 메모에 '[가짜:지어내기]' 가 있으면 원문에 없는 할 일 하나를 덧붙인다
//   - 메모에 '[가짜:실패]' 가 있으면 일시적 오류를 낸다
// 빠른 입력(capture.v7)에서는 데모가 실제 AI 처럼 보이게:
//   - 사용자가 고친 방식 힌트(input.learned)의 종류·프로젝트를 따른다 (ADAPT §7.6.3)
//   - 상태 보고 줄(input.statusLine)은 빼고 판단한다. 맨 앞 '퇴근하고·가는 길에' 는 걸어 둔 상태(do_in)로 뗀다 (STATUS §14)
//   - 맥락은 늘 null(읽을 때 규칙이 정한다), presence 는 늘 none, 배치 힌트는 원문에 적힌 걸리는 시간만 (CAL §8.5)

(function (factory) {
  var node = typeof module !== 'undefined' && module.exports;
  function optional(name) { try { return require(name); } catch (e) { return null; } }
  var deps = node
    ? { dates: require('../dates'), suggest: require('../suggest'), validate: require('./validate'), status: optional('../status') }
    : { dates: window.Daynote.dates, suggest: window.Daynote.suggest, validate: window.Daynote.aiValidate, status: window.Daynote.statusCore || null };
  var api = factory(deps.dates, deps.suggest, deps.validate, deps.status);
  if (node) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.aiFake = api; }
})(function (D, SG, V, ST) {
  var EVENT_RE = /(회의|미팅|면담|발표|리뷰|세미나|워크숍|약속|점심|저녁|통화|콜)/;

  // 데모용: 요청 문장 → 짧은 행동형 제목 (실제 AI 는 프롬프트 v2 규칙을 따른다)
  function actionTitle(s) {
    return String(s).replace(/\s*(까지|에)?\s*(부탁드립니다|부탁드려요|바랍니다|해\s*주세요|주세요)\.?$/, '').replace(/(을|를)\s*$/, '')
      .replace(/^(오늘|내일|모레|(이번|다음)\s*주\s*)?[월화수목금토일]요일(까지)?\s*/, '').replace(/^\d{1,2}\s*월\s*\d{1,2}\s*일(까지)?\s*/, '').replace(/^(오늘|내일|모레)(까지)?\s*/, '').replace(/\.$/, '').trim() || s;
  }

  // 데모: 큰 일로 보이는 할 일과 그 단계 초안 (실제 AI 는 capture.js·assist.js 지침으로 판단)
  var LARGE_RE = /(보고서|기획|발표|준비|자료|분석|문서|계획|제안서|정리해서|만들기|작성)/;
  function genericSteps(title, minutes) {
    var core = String(title || '').replace(/(하기|작성|준비|정리)$/, '').trim() || title;
    var steps = [
      { title: '‘' + core + '’ 관련 자료 한곳에 모으기', minutes: 15 },
      { title: '무엇을 담을지 목차·개요 잡기', minutes: 20 },
      { title: '초안 빠르게 써 보기', minutes: 45 },
      { title: '다시 읽고 다듬기', minutes: 20 }
    ];
    if (minutes && minutes < 60) steps = steps.slice(0, 2).concat([{ title: '마무리하기', minutes: 15 }]);
    return steps;
  }

  function demoAssist(input) {
    if (input.purpose === 'breakdown') {
      var t = input.task;
      var small = t.remaining_minutes != null && t.remaining_minutes <= 30;
      var steps = small ? [] : genericSteps(t.title, t.remaining_minutes).filter(function (s) { return (t.existing_steps || []).indexOf(s.title) === -1; });
      return { is_large: !small, reason: small ? '이미 충분히 작은 일이에요.' : '첫 단계만 해도 진행 중이 되도록 아주 작게 시작했어요.', steps: steps };
    }
    return {
      picks: (input.tasks || []).slice(0, 1).map(function (t) {
        return { task_id: t.id, why: '아직 제목만 있어서, 어디서부터 할지 정해 두면 좋아요.',
          question: '‘' + t.title + '’은(는) 무엇이 되면 끝난 건가요?', hints: ['끝났다고 볼 기준', '필요한 자료', '첫 번째 행동'] };
      })
    };
  }

  function organize(input) {
    if (input.purpose === 'breakdown' || input.purpose === 'elaborate') {
      return { ok: true, provider: 'fake', model: '가짜 AI(테스트)', output: demoAssist(input), usage: null };
    }
    if (input.lines.join('\n').indexOf('[가짜:실패]') !== -1) {
      return { ok: false, error: { type: 'server', message: '가짜 AI: 일시적 서버 오류(시험용)', retryable: true } };
    }
    // 앱이 이미 처리한 상태 보고 줄은 빼고 본다 (줄 번호는 그대로 — 남은 부분은 원문 줄 안에 있다)
    //   상태 문장은 글 머리의 한 곳뿐이다 — 처음 나온 줄에서 한 번만 뺀다('퇴근!\n퇴근하고 우유 사기' 의 둘째 줄은 그대로)
    if (input.purpose === 'capture' && input.statusLine) {
      var stripped = false;
      input = Object.assign({}, input, { lines: input.lines.map(function (l) {
        if (stripped) return l;
        var w = withoutStatus(l, input.statusLine);
        if (w !== null) { stripped = true; return w; }
        return l;
      }) });
    }
    var ref = new Date(input.referenceTime);
    var note = { id: input.noteId, title: input.title, body: input.lines.join('\n'), updatedAt: input.referenceTime };
    var tasks = [], events = [];
    SG.extractFromNote(note, ref).forEach(function (c) {
      var line = V.locate(V.noteLines(note), c.excerpt, null);
      var quote = c.excerpt.replace(/^\s*(?:[-*+]|\d+[.)])?\s*\[[ xX]\]\s*/, '').replace(/^\s*[-*+]\s+/, '').trim();
      var phrase = c.dueHint || null;
      var times = V.timeCandidates(quote);
      var item = {
        title: c.title, evidence: { quote: quote, line: line },
        when: { text: phrase, date: c.dueDate || null, time: times.length === 1 ? times[0] : times[1] || null },
        basis: 'explicit'
      };
      if (EVENT_RE.test(quote) && item.when.date) {
        events.push({ title: c.title, evidence: item.evidence, start: item.when, duration_minutes: null, location: null, basis: 'explicit' });
      } else {
        tasks.push({ title: actionTitle(c.title), evidence: item.evidence, due: { text: phrase, date: c.dueDate || null, time: null }, project_hint: null, basis: 'explicit' });
      }
    });
    // 요청 표현이 없어도 날짜가 붙은 회의·약속 줄은 일정으로
    input.lines.forEach(function (l, i) {
      var text = l.replace(/^\s*(?:[-*+]|\d+[.)])?\s*(\[[ xX]\]\s*)?/, '').trim();
      if (!EVENT_RE.test(text) || events.some(function (e) { return e.evidence.line === i + 1; })) return;
      var hint = SG.parseDueHint(text, ref);
      var times = V.timeCandidates(text);
      if (!hint || !times.length) return;   // 시각이 적힌 회의·약속만 일정으로
      var phrase = text.slice(text.indexOf(hint.phrase.split(/\s/)[0]));
      phrase = phrase.split(/\s+/).slice(0, times.length ? 3 : 1).join(' ');
      events.push({ title: text.replace(hint.phrase, '').replace(/^\s*(오전|오후)?\s*\d{1,2}\s*시\s*(반)?\s*/, '').trim() || text,
        evidence: { quote: text, line: i + 1 }, start: { text: phrase, date: hint.dueDate, time: times.length === 1 ? times[0] : null },
        duration_minutes: null, location: null, basis: 'explicit' });
    });
    if (input.lines.join('\n').indexOf('[가짜:지어내기]') !== -1) {
      tasks.push({ title: '원문에 없는 보고서 제출', evidence: { quote: '보고서를 금요일까지 제출', line: 1 },
        due: { text: '금요일까지', date: D.ymd(D.addDays(ref, 3)), time: null }, project_hint: null, basis: 'explicit' });
    }
    var body = input.lines.filter(function (l) { return l.trim(); });
    var extra = input.purpose === 'capture' ? classifyCapture(input, body, tasks, events, ref) : {};
    return {
      ok: true, provider: 'fake', model: '가짜 AI(테스트)',
      output: {
        summary: (input.title || body[0] || '메모') + ' — 가짜 AI가 규칙으로 만든 요약입니다.',
        sections: [{ heading: '메모 내용', bullets: body.slice(0, 6).map(function (l) {
          return { text: l.replace(/^\s*(?:[-*+]|\d+[.)])?\s*(\[[ xX]\]\s*)?/, '').replace(/^#+\s*/, ''), line: input.lines.indexOf(l) + 1 };
        }) }],
        tasks: tasks, events: events,
        open_questions: tasks.filter(function (t) { return !t.due.text; }).slice(0, 2).map(function (t) { return { text: '‘' + t.title + '’은(는) 언제까지인가요?', line: t.evidence.line }; }),
        entry_type: extra.entry_type, note_title: extra.note_title, note_project_hint: extra.note_project_hint, note_kind: extra.note_kind, done_tasks: extra.done_tasks, updated_tasks: extra.updated_tasks,
        presence: extra.presence
      },
      usage: null
    };
  }

  // 줄에서 상태 문장을 뺀 나머지. 그 줄에 상태 문장이 없으면 null.
  //   문장 부호 없이 적힌 경우('퇴근 가는 길에 …')는 낱말 경계일 때만 — '퇴근하고'·'퇴근길에' 의 '퇴근' 은 상태 문장이 아니다
  function withoutStatus(line, statusLine) {
    var sl = String(statusLine || '').trim();
    if (!sl) return null;
    var i = /[.!?~…]$/.test(sl) ? line.indexOf(sl) : -1;
    if (i === -1) {
      var bare = sl.replace(/[.!?~…]+$/, '');
      if (!bare) return null;
      var m = new RegExp('(^|[\\s,])(' + bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[.!?~…]*)(?=[\\s,.!?~…]|$)').exec(line);
      if (!m) return null;
      i = m.index + m[1].length;
      sl = m[2];
    }
    return (line.slice(0, i) + ' ' + line.slice(i + sl.length)).replace(/\s+/g, ' ').trim();
  }

  // 데모용 자동 분류 — 실제 AI 는 capture.js 지침으로 판단한다
  var TASK_END_RE = /(하기|보내기|정리|작성|확인|준비|연락|제출|예약|검토|회신|공유|등록|신청|구매|수정)$/;
  var GENERIC = { '신규': 1, '개선': 1, '프로젝트': 1 };
  var BULLET_RE = /^\s*(?:[-*+]|\d+[.)])?\s*(\[[ xX]\]\s*)?/;
  // 열린 할 일 중 이 줄과 핵심 낱말(2자 이상)이 겹치는 것
  function matchOpen(input, line, strip) {
    var words = line.replace(strip, ' ').split(/[\s,.!]+/).map(function (w) { return w.replace(/(을|를|은|는|이|가|도|로|으로)$/, ''); }).filter(function (w) { return w.length >= 2; });
    return (input.openTasks || []).filter(function (title) {
      var stem = title.replace(/(하기|보내기|기)$/, '');
      return words.some(function (w) { return stem.indexOf(w) !== -1 || w.indexOf(stem) !== -1; });
    });
  }

  var MEMO_KINDS = { memo: 1, idea: 1, link: 1 };

  // 빠른 입력 제목 다듬기 (데모가 실제 AI 처럼 짧은 제목을 주게): "2시~4시"·걸리는 시간 표현을 떼고,
  //   시각은 다른 칸(일정 start · 할 일 do_at)에 담은 때만(withTime) 뗀다 — 정보를 잃지 않게. 다 떼고 비면 원래 제목.
  function tidyTitle(title, withTime) {
    var s = String(title || '');
    s = s.replace(/(?:\d{1,2}\s*(?:시|:\d{2})?\s*)?[~\-–]\s*\d{1,2}\s*시(?!간)/, ' ');
    var tm = V.timeMatch ? V.timeMatch(s) : null;
    if (tm && withTime) {
      s = s.slice(0, tm.index) + ' ' + s.slice(tm.index + tm.text.length).replace(/^\s*(?:에|부터|까지)(?=[\s,.]|$)/, '');
    }
    //   걸리는 시간은 '걸리는·걸릴 듯·간·동안' 처럼 걸리는 시간이라고 말한 때만 뗀다 ('5분 스피치 준비' 의 '5분' 은 제목의 일부)
    var TAKES_RE = /^\s*(?:(?:간|동안)(?:\s*정도)?(?:\s*(?:걸리는|걸릴\s*듯|걸림|걸려요?|걸릴))?|(?:정도\s*)?(?:걸리는|걸릴\s*듯|걸림|걸려요?|걸릴))(?=[\s,.]|$)/;
    (V.durationMentions ? V.durationMentions(s) : []).reverse().forEach(function (d) {
      var after = s.slice(d.index + d.text.length);
      var m = after.match(TAKES_RE);
      if (!m) return;
      s = s.slice(0, d.index) + ' ' + after.slice(m[0].length);
    });
    s = s.replace(/\s+/g, ' ').replace(/^[\s,.]+|[\s,.]+$/g, '').replace(/^(?:에|까지|부터)(?:\s+|$)/, '').trim();
    return s || String(title || '');
  }
  function classifyCapture(input, body, tasks, events, ref) {
    // 사용자가 전에 고친 방식 (데모가 '한 번 고치면 다음엔 그쪽으로' 를 보이게)
    var learned = input.learned || [];
    var kh = learned.filter(function (x) { return x.type === 'kind'; })[0] || null;
    var pj = learned.filter(function (x) { return x.type === 'project'; })[0] || null;
    // 날짜 바꾸기: "견적서는 내일 보낼게", "보고서 월요일로 미룸" — 날짜 표현 + 미루기·약속 말 + 열린 할 일과 겹침
    var UPDATE_RE = /(할게|할께|보낼게|낼게|하기로|미룸|미뤘|미루|미뤄|옮김|옮겼|연기|변경)/;
    var updated = [];
    var used = {};
    body.forEach(function (l) {
      if (!UPDATE_RE.test(l)) return;
      var hint = SG.parseDueHint(l, ref);
      if (!hint) return;
      matchOpen(input, l.replace(hint.phrase, ' '), UPDATE_RE).forEach(function (title) {
        if (updated.some(function (u) { return u.title === title; })) return;
        updated.push({ title: title, evidence: { quote: l.trim(), line: input.lines.indexOf(l) + 1 },
          due: { text: hint.phrase, date: hint.dueDate, time: null }, do_at: { text: null, date: null, time: null } });
        used[l] = true;
      });
    });
    if (!tasks.length && !events.length && body.length === 1 && !used[body[0]]) {
      var t = body[0].replace(BULLET_RE, '').trim();
      var hint = SG.parseDueHint(t, ref);
      var am = ST ? ST.extractAtMode(t) : null;      // '퇴근하고 우유 사기' — 맨 앞의 걸어 둔 상태는 할 일이다
      // 단, 기록·생각처럼 보이는 글('점심 때 들은 아이디어: …')은 아니다
      if (am && (am.title.length > 40 || /[:：]|https?:\/\/|(어떨까|해 보면|하면 좋|아이디어|들은|했다|였다|좋았)/.test(am.title))) am = null;
      var make = hint || TASK_END_RE.test(t.replace(/[.!]+$/, '')) || !!am;
      if (kh && kh.to === 'task') make = true;
      if (kh && MEMO_KINDS[kh.to]) make = false;
      if (make) {
        tasks.push({ title: actionTitle(am ? am.title : t), evidence: { quote: t, line: input.lines.indexOf(body[0]) + 1 },
          due: { text: hint ? hint.phrase : null, date: hint ? hint.dueDate : null, time: null }, project_hint: null, basis: 'explicit',
          do_in: am ? am.mode : undefined });
      }
    }
    var full = input.lines.join(' ');
    var ph = (input.projects || []).filter(function (name) {
      return name.split(/\s+/).some(function (w) { return w.length >= 2 && !GENERIC[w] && full.indexOf(w) !== -1; });
    })[0] || null;
    if (pj) {
      if (pj.to === 'none') ph = null;
      else {
        var nm = String(pj.says || '').match(/‘([^’]+)’/);
        var named = nm ? (input.projects || []).filter(function (n) { return n === nm[1]; })[0] : null;
        if (named) ph = named;
      }
    }
    // "30분 후 샤워하기" 처럼 할 시각을 정한 할 일 (시각 계산은 앱 검증기가 한다)
    var REL = /(\d+\s*분|(?:\d+|한|두|세)\s*시간(?:\s*반)?)\s*(?:후|뒤|있다가)/;
    tasks.forEach(function (t) {
      var rm = (t.evidence && t.evidence.quote || '').match(REL);
      if (!t.do_at) t.do_at = rm ? { text: rm[0], date: null, time: null } : { text: null, date: null, time: null };
      if (rm) {
        // 시각 표현·"일정에" 는 제목에서 빼고, 마감으로 잘못 잡힌 "오늘" 도 지운다 (할 시각이지 마감이 아니다)
        t.title = t.title.replace(REL, ' ').replace(/^\s*(오늘|내일)?\s*(일정에|할 일에|캘린더에)?\s*/, '').replace(/\s+/g, ' ').trim() || t.title;
        t.due = { text: null, date: null, time: null };
      }
      // "내일 오후 3시 치과", "오후 3시에 보고서 쓰기" — 오전·오후가 분명한 시각이 (날짜 표현과 이어져) 있으면 할 시각으로 (규칙 G)
      //   "까지" 가 붙은 시각(마감)·오전 오후를 모르는 시각·날짜와 떨어진 시각은 그대로 둔다(제목에도 남는다)
      var timed = false;
      if (!rm) {
        var q = t.evidence && t.evidence.quote || '';
        var tq = V.timeMatch ? V.timeMatch(q) : null;
        if (tq && tq.candidates.length === 1 && !/^\s*까지/.test(q.slice(tq.index + tq.text.length))) {
          var dt = t.due && t.due.text ? t.due : null;
          var joined = dt ? dt.text + ' ' + tq.text : tq.text;
          // 날짜 표현 없이 오늘 이미 지난 시각('오전 9시에 운동', 지금 10시)은 할 시각으로 두지 않는다 (규칙 추출 rulesItem 과 같게)
          var past = !dt && D.parseYmd(D.ymd(ref), tq.candidates[0]) < ref;
          if (q.indexOf(joined) !== -1 && !past) {
            t.do_at = { text: joined, date: dt ? dt.date : null, time: tq.candidates[0] };
            t.due = { text: null, date: null, time: null };
            timed = true;
          }
        }
      }
      if (!t.project_hint) t.project_hint = ph;
      var large = LARGE_RE.test(t.title);
      t.size = large ? 'large' : 'small';
      t.breakdown = large ? genericSteps(t.title) : [];
      // 걸어 둔 상태: 제목 맨 앞의 표현을 뗀다 (근거 문장에 그대로 있으므로 검증을 통과한다)
      if (!t.do_in) {
        var ex = ST ? ST.extractAtMode(t.title) : null;
        if (ex) t.title = ex.title;
        t.do_in = ex ? ex.mode : 'none';
      }
      t.context = null;
      var dm = V.durationMentions ? V.durationMentions(t.evidence && t.evidence.quote || '') : [];
      t.sched = { focus: null, energy: null, prefer: null, splittable: null, minutes: dm.length ? dm[0].minutes : null };
      t.title = tidyTitle(t.title, timed);
    });
    events.forEach(function (e) { e.title = tidyTitle(e.title, true); });
    // 완료 보고: "샤워 완료", "견적서 보냈음" — 열린 할 일 제목과 핵심 낱말(2자 이상)이 겹치면 그 일
    var DONE_RE = /(완료|끝냈|끝났|끝남|다 했|다했|했음|마쳤|보냈음|보냈다|제출함)/;
    var done = [];
    body.forEach(function (l) {
      if (!DONE_RE.test(l) || used[l]) return;
      matchOpen(input, l, DONE_RE).forEach(function (title) {
        if (!done.some(function (d) { return d.title === title; })) done.push({ title: title, evidence: { quote: l.trim(), line: input.lines.indexOf(l) + 1 } });
      });
    });
    var items = tasks.length + events.length;
    var first = (body[0] || '메모').replace(BULLET_RE, '').replace(/^#+\s*/, '').trim();
    return {
      done_tasks: done,
      updated_tasks: updated,
      entry_type: (done.length || updated.length) && !items && body.length <= done.length + updated.length ? (done.length ? 'done' : 'update')
        : !items ? (done.length || updated.length ? 'mixed' : 'memo') : body.length <= items ? 'task' : 'mixed',
      note_title: first.length > 20 ? first.slice(0, 19) + '…' : first,
      note_project_hint: ph,
      note_kind: kh && (kh.to === 'idea' || kh.to === 'link') ? kh.to
        : /https?:\/\//.test(full) ? 'link' : /(어떨까|해 보면|하면 좋|아이디어)/.test(full) ? 'idea' : 'memo',
      presence: { role: 'none', quote: null }
    };
  }

  return { organize: organize };
});
