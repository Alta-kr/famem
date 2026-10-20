'use strict';

// 채팅 명령 — "할 일 추천해줘", "작게 나눠줘", "쉬고 싶어", "캘린더 보여줘", "오늘 할 일 뭐야?" …
//
//   1) 자주 쓰는 짧은 명령은 AI 를 부르지 않고 바로 알아듣는다 (matchLocal — 기다림 없음)
//   2) 그 밖의 말은 빠른 입력 AI(capture)가 commands 로 돌려준다 (SCHEMA_PART · resolve 로 검증)
//   명령의 대상 할 일은 목록에 있는 할 일이어야 하고, 말하지 않았으면 작업 공간에 올려 둔 할 일이다.
//   실행(화면 이동·카드 띄우기)은 화면 쪽 assistant.runCommand 가 한다.

(function (factory) {
  var deps = (typeof module !== 'undefined' && module.exports)
    ? { dates: require('../dates'), model: require('../model') }
    : { dates: window.Daynote.dates, model: window.Daynote.model };
  var api = factory(deps.dates, deps.model);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') { window.Daynote = window.Daynote || {}; window.Daynote.aiCommands = api; }
})(function (D, M) {
  var ACTIONS = ['recommend', 'breakdown', 'start', 'pause', 'complete', 'return_todo', 'work', 'rest', 'list_today', 'open', 'search', 'schedule', 'delete', 'day_close'];
  var NEEDS_TASK = { start: 1, pause: 1, complete: 1, return_todo: 1, work: 1, schedule: 1, delete: 1 };   // breakdown 은 없으면 앱이 고른다
  var VIEWS = ['today', 'archive', 'tasks', 'calendar', 'projects', 'weekly', 'settings'];

  // AI 응답 스키마에 붙는 부분 (capture.js 가 쓴다)
  var SCHEMA_PART = { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['action', 'target', 'view', 'query', 'evidence'],
    properties: {
      action: { type: 'string', enum: ACTIONS },
      target: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      view: { anyOf: [{ type: 'string', enum: VIEWS }, { type: 'null' }] },
      query: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      evidence: { type: 'object', additionalProperties: false, required: ['quote', 'line'], properties: { quote: { type: 'string' }, line: { type: 'integer' } } }
    } } };

  var PROMPT = [
    'L. 명령: 글이 기록·할 일이 아니라 Daynote 에게 무엇을 해 달라는 요청이면 commands 에 넣습니다. (해당 없으면 빈 배열)',
    '   recommend(할 일 추천·뭐부터 할지·"30분 남는데 뭐 하지" 처럼 시간이 남았다는 말) · breakdown(작게 나누기) · start(시작) · pause(일시 정지·멈춤) · complete(완료 처리 요청) · return_todo(할 일로 되돌리기) · work(작업 공간·채팅에 올리기)',
    '   day_close(하루 마무리·퇴근·오늘은 여기까지) · rest(휴식·쉬기) · list_today(오늘 할 일·일정 알려 주기) · open(화면 열기: view 에 today/archive/tasks/calendar/projects/weekly/settings) · search(찾기: query 에 찾을 말) · schedule(일정에 배치) · delete(할 일 지우기)',
    '   target 은 대상 할 일 제목(목록 글자 그대로). 대상을 말하지 않았으면 null (앱이 작업 공간의 할 일을 쓴다). 명령만 있는 글이면 entry_type "command".',
    '   명령을 새 할 일로 만들지 마세요. 예) "할 일 추천해줘" → recommend / "견적서 작게 나눠줘" → breakdown, target "견적서 보내기" / "캘린더 보여줘" → open, view "calendar" / "회의록 메모 찾아줘" → search, query "회의록"',
    '   "완료했어", "끝났어" 처럼 끝냈다는 보고는 H(done_tasks)이고, "완료 처리해 줘" 처럼 요청하면 complete 입니다.'
  ].join('\n');

  // ---------------------------------------------------------------- 대상 할 일 찾기
  function nospace(s) { return String(s || '').replace(/\s+/g, '').toLowerCase(); }
  function findTask(state, title) {
    if (!title) return null;
    var open = M.liveTasks(state).filter(function (t) { return t.status !== 'done'; });
    var exact = open.filter(function (t) { return t.title === title; });
    if (exact.length) return exact[0];
    var k = nospace(title);
    if (k.length < 2) return null;
    var near = open.filter(function (t) { var n = nospace(t.title); return n === k || n.indexOf(k) !== -1 || k.indexOf(n) !== -1; });
    return near.length === 1 ? near[0] : null;
  }
  // 문장 속 낱말(2자 이상)과 겹치는 열린 할 일 — 하나일 때만
  function taskInText(state, text) {
    var words = String(text || '').split(/[\s,.!?~]+/).map(function (w) { return w.replace(/(을|를|은|는|이|가|도|좀|만|부터)$/, ''); }).filter(function (w) { return w.length >= 2; });
    if (!words.length) return null;
    var open = M.liveTasks(state).filter(function (t) { return t.status !== 'done'; });
    var hits = open.filter(function (t) { var n = nospace(t.title); return words.some(function (w) { return n.indexOf(nospace(w)) !== -1; }); });
    return hits.length === 1 ? hits[0] : null;
  }

  // ---------------------------------------------------------------- 바로 알아듣는 짧은 명령 (AI 없이)
  //   글이 짧고(40자 이하) 아래 꼴일 때만. 애매하면 null → AI 로
  var VIEW_WORDS = [[/캘린더|달력|일정표/, 'calendar'], [/보관함/, 'archive'], [/할\s*일\s*(목록|화면|전체)/, 'tasks'], [/주간\s*(정리|보고)|이번\s*주\s*정리/, 'weekly'],
    [/프로젝트/, 'projects'], [/설정/, 'settings'], [/^(홈|오늘\s*화면)/, 'today']];
  var VERB_DONE_RE = /(보여\s*줘|보여줄래|열어\s*줘|열어|켜\s*줘|띄워\s*줘|가자|보자|로\s*가)/;

  // 남는 시간 — "30분 남았어", "한 시간 비는데", "시간 좀 남네", "짬 났어" → 그 시간(분, 모르면 null)
  var KNUM = { '한': 1, '두': 2, '세': 3, '네': 4, '반': 0.5 };
  function freeMinutes(text) {
    var s = String(text || '');
    var m = s.match(/(\d+|한|두|세|네)\s*시간(\s*반)?|(\d+)\s*분|(반)\s*시간/);
    if (!m) return null;
    if (m[4]) return 30;
    if (m[3]) return Math.min(480, parseInt(m[3], 10)) || null;
    var h = /\d/.test(m[1]) ? parseInt(m[1], 10) : KNUM[m[1]];
    return Math.min(480, Math.round((h + (m[2] ? 0.5 : 0)) * 60)) || null;
  }
  var FREE_RE = /(시간|짬|틈|여유)\s*(이|가|좀|이\s*좀|가\s*좀)?\s*(남|났|나네|생겼|생김|있|비|되)|(\d+\s*분|(?:\d+|한|두|세|네|반)\s*시간(?:\s*반)?)\s*(정도|쯤|가량)?\s*(이|가|은|는|좀)?\s*(남|비|여유|떠|뜨|있)/;
  function freeTime(s) {
    if (!FREE_RE.test(s)) return null;
    // "마감 30분 남았어" 는 남는 시간이 아니다 · "회의 시간 있어?" 같은 질문·할 일은 AI 로
    if (/마감|남았(나|니|어\?)|있(나|니|어\?)|[가-힣]기$|까지\s*(해|하|보내|끝)/.test(s)) return null;
    return { action: 'recommend', free: true, minutes: freeMinutes(s) };
  }

  function matchLocal(state, text, focus) {
    var s = String(text || '').trim().replace(/[.!~]+$/, '');
    if (!s || s.length > 40 || /\n/.test(s)) return null;
    var m;
    // 남는 시간 — 그 시간 안에 할 일 (준비할 일 위주)
    var ft = freeTime(s);
    if (ft) return ft;
    // 추천
    if (/(할\s*일|할일|작업|일)\s*(좀\s*)?추천|추천\s*(좀\s*)?해\s*(줘|주세요|줄래)$|^(이제\s*|지금\s*)?(뭐|뭘|무엇)\s*(부터|먼저)?\s*(하지|할까|해야\s*(돼|해|할까|하지)|하면\s*(좋|돼))|다음\s*(에\s*)?(할\s*일|뭐\s*(하지|할까))/.test(s)) return { action: 'recommend' };
    // 하루 마무리 — "오늘 마무리", "퇴근할게", "오늘은 여기까지"
    if (/(하루\s*마무리|오늘\s*(은\s*)?마무리|퇴근|오늘은\s*여기까지|일\s*끝(낼게|내자)|마감\s*정리)/.test(s) && !/(하기|보기|가기|사기|내기|보내|까지\s)/.test(s)) return { action: 'day_close' };   // "퇴근하고 장보기" 같은 할 일은 아님
    // 휴식
    //   요청하는 말일 때만 ("금요일 휴식 시간에 은행 가기" 같은 할 일은 아님)
    if (/(쉬고\s*싶|쉬자|쉴래|쉴게|좀\s*쉬|지쳤|피곤해|휴식\s*(하자|할래|할게|할까|하고\s*싶|모드|시작|좀)?$|스트레칭\s*(하자|할래|할게)?$)/.test(s) &&
        !/(하기|가기|까지|일정|회의|시간에)/.test(s)) return { action: 'rest' };
    // 오늘 할 일 알려 주기
    if (/오늘\s*(할\s*일|할일|일정|해야\s*할\s*(일|거))\s*(이\s*)?(뭐|뭔|알려|보여|정리|있)|오늘\s*뭐\s*(해야|있)/.test(s)) return { action: 'list_today' };
    // 작게 나누기 — "견적서 작게 나눠줘" / "이거 쪼개줘"
    if ((m = s.match(/^(.*?)\s*(작게\s*나눠|잘게\s*나눠|쪼개|세분화|단계로\s*나눠|나눠\s*줘|나눠줘)/))) {
      var named = m[1].replace(/^(이거|이것|이|그거|저거|좀)\s*/, '').trim();
      var bt = (named && findTask(state, named)) || taskInText(state, m[1]);   // 이름 전체로 먼저, 안 되면 낱말로
      // 이름을 말했는데 못 찾으면 엉뚱한 일을 나누지 않고 되묻는다
      if (!bt && named.length >= 2) return { action: 'breakdown', missing: named };
      return { action: 'breakdown', taskId: bt ? bt.id : (focus ? focus.id : null) };
    }
    // 화면 열기 — "캘린더 보여줘"
    if (VERB_DONE_RE.test(s)) {
      var v = VIEW_WORDS.filter(function (x) { return x[0].test(s); })[0];
      if (v && s.replace(v[0], '').replace(VERB_DONE_RE, '').replace(/[\s을를좀]/g, '').length <= 4) return { action: 'open', view: v[1] };
    }
    // 찾기 — "회의록 찾아줘"
    if ((m = s.match(/^(.+?)\s*(관련\s*)?(메모|할\s*일)?\s*(좀\s*)?(찾아\s*(줘|봐|줄래)|검색\s*해\s*(줘|봐)|어디\s*(있|갔))/))) {
      // "지난번에 적은 세미나 관련" → "세미나" (때·꾸밈 말은 뺀다)
      var q = m[1].replace(/^(지난번에|지난번|예전에|아까|전에|어제|그때)\s*/, '').replace(/^(적은|쓴|만든|적어\s*둔|써\s*둔)\s*/, '')
        .replace(/\s*(관련|메모|할\s*일|거|것)$/, '').replace(/\s*(관련|메모)$/, '').trim();
      if (q) return { action: 'search', query: q };
    }
    // 작업 공간 할 일에 대한 짧은 지시 — "시작", "멈춰", "완료 처리해 줘"
    var t = focus;
    if (/^(이거\s*|이것\s*)?(시작|시작할게|시작하자|시작해\s*줘)$/.test(s)) return t ? { action: 'start', taskId: t.id } : null;
    if (/^(이거\s*|잠깐\s*)?(멈춰|멈출게|일시\s*정지|중지|스톱|잠깐\s*멈춰)(\s*해\s*줘)?$/.test(s)) return t ? { action: 'pause', taskId: t.id } : null;
    if (/^(이거\s*)?(완료\s*(처리)?\s*해\s*줘|완료로\s*(바꿔|해)\s*줘?)$/.test(s)) return t ? { action: 'complete', taskId: t.id } : null;
    return null;
  }

  // ---------------------------------------------------------------- AI 가 준 명령 검증
  //   근거 문장이 원문에 있어야 하고, 대상 할 일은 열린 할 일이어야 한다 (없으면 작업 공간의 할 일)
  function resolve(state, note, list, focus) {
    var body = nospace([note.title, note.body].join('\n'));
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (c) {
      if (!c || ACTIONS.indexOf(c.action) === -1) return;
      var q = c.evidence && c.evidence.quote;
      if (!q || body.indexOf(nospace(q)) === -1) return;
      var cmd = { action: c.action };
      if (c.target || NEEDS_TASK[c.action] || c.action === 'breakdown') {
        var t = c.target ? findTask(state, String(c.target)) : null;
        if (!t && !c.target && focus) t = focus;
        if (!t && (NEEDS_TASK[c.action] || (c.action === 'breakdown' && c.target))) { cmd.missing = c.target || true; }
        if (t) cmd.taskId = t.id;
      }
      if (c.action === 'open') { if (VIEWS.indexOf(c.view) === -1) return; cmd.view = c.view; }
      if (c.action === 'search') { var qq = String(c.query || '').trim().slice(0, 60); if (!qq) return; cmd.query = qq; }
      // "회의 전까지 40분 비는데 뭐 하면 좋을까" — 근거 문장에서 남는 시간을 앱이 읽는다
      if (c.action === 'recommend' && FREE_RE.test(q)) { cmd.free = true; cmd.minutes = freeMinutes(q); }
      if (out.some(function (o) { return o.action === cmd.action && o.taskId === cmd.taskId && o.view === cmd.view; })) return;
      out.push(cmd);
    });
    return out.slice(0, 5);
  }

  // 오늘 할 일 (오늘 화면 목록과 같은 기준): 진행 중·일시 정지, 오늘 작업 시간, 오늘까지 마감, 오늘 적은 것
  function todayTasks(state, now) {
    var today = D.ymd(now);
    var blockToday = {};
    state.blocks.forEach(function (b) { if (b.taskId && D.ymd(b.start) === today) blockToday[b.taskId] = true; });
    return M.liveTasks(state).filter(function (t) {
      if (t.status === 'done') return false;
      return t.status === 'in_progress' || t.status === 'paused' || blockToday[t.id] || (t.dueDate && t.dueDate <= today) || D.ymd(t.createdAt) === today;
    }).sort(function (a, b) {
      var sa = typeof a.sortOrder === 'number', sb = typeof b.sortOrder === 'number';
      if (sa && sb) return a.sortOrder - b.sortOrder;
      if (sa !== sb) return sa ? -1 : 1;
      return (a.dueDate || '9999') < (b.dueDate || '9999') ? -1 : 1;
    });
  }

  return { ACTIONS: ACTIONS, VIEWS: VIEWS, NEEDS_TASK: NEEDS_TASK, SCHEMA_PART: SCHEMA_PART, PROMPT: PROMPT,
    matchLocal: matchLocal, resolve: resolve, findTask: findTask, todayTasks: todayTasks, freeMinutes: freeMinutes };
});
