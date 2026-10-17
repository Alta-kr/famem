'use strict';

// 휴식 화면 — 할 일을 하다가 "완전히" 쉬게 한다. 근거: ../../DAYNOTE_UX_RESEARCH.md (휴식)
//
//   쉬기 전  : 진행 중인 일은 일시 정지 · 돌아와서 할 첫 행동 한 줄 (Leroy & Glomb 2018, Altmann & Trafton 2002)
//              머리에 남은 생각은 '생각 내려놓기' 로 적어 두고 떠난다 (인지 부하 덜기 — Risko & Gilbert 2016)
//   쉬는 동안: 앱 전체를 가린다 — 할 일이 보이면 머리가 계속 일을 붙잡는다 (심리적 분리 — Sonnentag & Fritz 2007)
//              알림·제안은 멈춘다. 모드·시간은 사용자가 고른다 (통제감 — Sonnentag & Fritz 2007)
//     cover   완전 가림   — 타이머와 한 줄만
//     breathe 숨 고르기   — 들이쉬기 4초 · 내쉬기 6초 (Balban 외 2023, 내쉬기를 길게 하는 호흡)
//     eyes    눈 쉬기     — 먼 풍경, 20초마다 먼 곳 보기 (20-20-20 · Lee 외 2015)
//     stretch 몸 풀기     — 스트레칭을 하나씩 크게 (Albulescu 외 2022)
//     walk    자리 떠나기 — 화면을 보지 말고 일어나 걷기, 끝나면 소리로 알림 (움직이는 휴식)
//              소리: 빗소리 같은 잔잔한 소리(선택, Alvarsson 외 2010) · 끝날 때 부드러운 종소리 (눈을 감고 쉬어도 되게)
//   돌아올 때: "다시 시작할까요?" — 이어서 할 일 · 적어 둔 첫 행동 · 평가(모드 비교)

(function () {
  var DN = window.Daynote;
  var M = DN.model, S = DN.store, ui = DN.ui, h = ui.h;

  var MODES = [
    { id: 'cover', label: '완전 가림', icon: 'clock', desc: '화면을 모두 가리고 타이머만. 아무것도 안 해도 되는 시간이에요.', why: '일에서 마음이 떨어져야 회복된다 (Sonnentag & Fritz 2007)' },
    { id: 'breathe', label: '숨 고르기', icon: 'spark', desc: '원을 따라 들이쉬고, 더 길게 내쉬어요.', why: '내쉬기를 길게 하는 호흡이 긴장을 낮춘다 (Balban 외 2023)' },
    { id: 'eyes', label: '눈 쉬기', icon: 'theme', desc: '먼 풍경을 보며 20초씩 먼 곳에 초점을 둬요.', why: '자연을 잠깐 보는 것만으로 다음 집중이 나아진다 (Lee 외 2015)' },
    { id: 'stretch', label: '몸 풀기', icon: 'task', desc: '스트레칭을 하나씩 크게 보여 줘요.', why: '짧게 움직이는 휴식이 피로를 줄인다 (Albulescu 외 2022)' },
    { id: 'walk', label: '자리 떠나기', icon: 'chevronRight', desc: '화면은 두고 일어나 걸어요. 끝나면 종소리로 알려 드려요.', why: '몸을 움직이는 휴식이 활력을 가장 크게 되살린다 (Albulescu 외 2022)' }
  ];
  var LABEL = {}; MODES.forEach(function (m) { LABEL[m.id] = m.label; });
  var DURATIONS = [1, 3, 5, 10];
  var RATINGS = [['good', '좋았어요'], ['ok', '보통'], ['bad', '별로']];

  var cur = null;   // 열려 있는 휴식

  function now() { return DN.app.now(); }
  function prefs() { return S.state.prefs; }
  function reduced() { return !!prefs().reduceMotion || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function mmss(ms) { var s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }

  // ---------------------------------------------------------------- 소리 (파일 없이 만든다)
  //   잔잔한 소리: 갈색 잡음(브라운 노이즈)을 낮은 주파수로 걸러 빗소리처럼 / 종소리: 두 음이 천천히 사라지는 사인파
  var audio = null;
  function ctx() {
    if (!audio) { var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; audio = new AC(); }
    if (audio.state === 'suspended') audio.resume();
    return audio;
  }
  function startNoise() {
    var a = ctx(); if (!a || cur.noise) return;
    var len = a.sampleRate * 4, buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0), last = 0;
    for (var i = 0; i < len; i++) { var w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.2; }
    var src = a.createBufferSource(); src.buffer = buf; src.loop = true;
    var lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
    var g = a.createGain(); g.gain.value = 0; g.gain.linearRampToValueAtTime(0.18, a.currentTime + 2);
    src.connect(lp); lp.connect(g); g.connect(a.destination); src.start();
    cur.noise = { src: src, gain: g };
  }
  function stopNoise() {
    if (!cur || !cur.noise || !audio) return;
    var n = cur.noise; cur.noise = null;
    n.gain.gain.cancelScheduledValues(audio.currentTime);
    n.gain.gain.linearRampToValueAtTime(0, audio.currentTime + 1);
    setTimeout(function () { try { n.src.stop(); } catch (e) {} }, 1100);
  }
  function chime() {
    var a = ctx(); if (!a) return;
    [[660, 0], [880, 0.35]].forEach(function (p) {
      var o = a.createOscillator(), g = a.createGain();
      o.type = 'sine'; o.frequency.value = p[0];
      var t = a.currentTime + p[1];
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.18, t + 0.05); g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
      o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + 2.3);
    });
  }

  // ---------------------------------------------------------------- 열기·닫기
  // opts.mode: 바로 이 모드로 / 없으면 설정의 기본 모드 (기본 '고르기' 면 쉬기 전 화면부터)
  function open(opts) {
    opts = opts || {};
    if (cur) return;
    var pausedIds = [];
    S.mutate(null, function (s) {
      M.liveTasks(s).forEach(function (t) { if (t.status === 'in_progress') { M.pauseTask(s, t.id, now()); pausedIds.push(t.id); } });
    }, { source: 'rest' });
    var el = h('div.rest-overlay', { role: 'dialog', 'aria-modal': 'true', 'aria-label': '휴식' });
    document.body.appendChild(el);
    document.documentElement.classList.add('is-resting');
    cur = { el: el, pausedIds: pausedIds, parked: [], minutes: prefs().restMinutes || 3, prevFocus: document.activeElement, sound: !!prefs().restSound };
    el.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); if (cur && cur.mode) finish(); else back(false); } });
    var mode = opts.mode || prefs().restMode;
    if (mode && LABEL[mode]) start(mode, true); else prepare();
  }
  function clearTimers() { if (cur) { clearInterval(cur.timer); clearTimeout(cur.step); clearInterval(cur.step); cur.timer = null; cur.step = null; } }
  function close() {
    if (!cur) return;
    clearTimers(); stopNoise();
    cur.el.remove();
    document.documentElement.classList.remove('is-resting');
    var f = cur.prevFocus; cur = null;
    if (f && f.focus) try { f.focus(); } catch (e) {}
  }

  // ---------------------------------------------------------------- 쉬기 전 — 내려놓고, 첫 행동 적고, 모드 고르기
  function parkBox(compact) {
    var ta = h('textarea.rest-park', { rows: compact ? 1 : 2, placeholder: '머리에 남은 생각이 있으면 여기 두고 가세요 (메모로 저장돼요)', 'aria-label': '생각 내려놓기' });
    var saved = h('span.rest-park-saved', { 'aria-live': 'polite' });
    function park() {
      var v = ta.value.trim();
      if (!v) return;
      // AI 정리는 하지 않는다 — 쉬는 동안 무언가 바뀌지 않게. 돌아와서 보관함·메모에서 볼 수 있다
      S.mutate('생각 내려놓기', function (s) {
        var n = M.addNote(s, { title: '', body: v, kind: 'memo', captureRole: 'memo', parkedAt: now().toISOString(),
          capture: { status: 'done', at: now().toISOString(), entryType: 'memo', created: [], parked: true } }, now());
        cur.parked.push(n.id);
      }, { source: 'rest' });
      ta.value = '';
      saved.textContent = '내려놓았어요 (' + cur.parked.length + ')';
    }
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); park(); } });
    return h('div.rest-park-row', ta, h('button.btn', { type: 'button', onclick: park }, '내려놓기'), saved);
  }
  function resumeBoxes() {
    var tasks = cur.pausedIds.map(function (id) { return M.byId(S.state.tasks, id); }).filter(Boolean);
    if (!tasks.length) return null;
    return h('div.rest-resume', h('div.rest-label', '돌아와서 할 첫 행동 — 적어 두면 다시 시작이 쉬워요'),
      tasks.map(function (t) {
        var inp = h('input.rest-input', { value: t.resumeNote || '', placeholder: '예: 3번 슬라이드 그래프부터', 'aria-label': '‘' + t.title + '’ 이어서 할 첫 행동' });
        inp.addEventListener('change', function () {
          var v = inp.value.trim();
          S.mutate(null, function (s) { M.updateTask(s, t.id, { resumeNote: v || null }, now()); }, { source: 'rest' });
        });
        return h('label.rest-resume-row', h('span', t.title), inp);
      }));
  }
  function prepare() {
    clearTimers();
    cur.mode = null; cur.endAt = null;
    var el = cur.el; el.textContent = ''; el.className = 'rest-overlay mode-prepare';
    el.appendChild(h('div.rest-picker',
      h('h2.rest-title', '잠깐 쉬어 가요'),
      h('p.rest-sub', cur.pausedIds.length ? '하던 일은 일시 정지했어요. 쉬는 동안 할 일은 보이지 않아요.' : '쉬는 동안 할 일은 보이지 않아요.'),
      resumeBoxes(),
      h('div.rest-label', '생각 내려놓기'),
      parkBox(false),
      h('div.rest-label', '어떻게 쉴까요?'),
      h('div.rest-cards', MODES.map(function (m) {
        return h('button.rest-card', { type: 'button', onclick: function () { start(m.id, true); } },
          h('span.rest-card-icon', ui.icon(m.icon)), h('b', m.label), h('span.rest-card-desc', m.desc), h('span.rest-card-why', m.why));
      })),
      durationRow(), soundRow(),
      h('div.rest-actions', h('button.btn.btn-ghost', { type: 'button', onclick: function () { back(false); } }, '쉬지 않고 돌아가기'))));
    var first = el.querySelector('.rest-card'); if (first) first.focus();
  }
  function durationRow() {
    return h('div.rest-durations', { role: 'group', 'aria-label': '쉬는 시간' }, h('span', '쉬는 시간'),
      DURATIONS.map(function (n) {
        return h('button.rest-dur' + (cur.minutes === n ? '.is-on' : ''), { type: 'button', 'aria-pressed': String(cur.minutes === n), onclick: function () {
          cur.minutes = n;
          S.mutate(null, function (s) { s.prefs.restMinutes = n; }, { silent: true });
          if (cur.mode) start(cur.mode, true); else prepare();
        } }, n + '분');
      }));
  }
  function soundRow() {
    return h('div.rest-durations', { role: 'group', 'aria-label': '소리' }, h('span', '잔잔한 소리'),
      h('button.rest-dur' + (cur.sound ? '.is-on' : ''), { type: 'button', 'aria-pressed': String(cur.sound), onclick: function (e) {
        cur.sound = !cur.sound;
        S.mutate(null, function (s) { s.prefs.restSound = cur.sound; }, { silent: true });
        e.currentTarget.classList.toggle('is-on', cur.sound);
        e.currentTarget.setAttribute('aria-pressed', String(cur.sound));
        e.currentTarget.textContent = cur.sound ? '켜짐' : '꺼짐';
        if (cur.mode) { if (cur.sound) startNoise(); else stopNoise(); }
      } }, cur.sound ? '켜짐' : '꺼짐'));
  }

  // ---------------------------------------------------------------- 쉬는 중
  // reset: 쉬는 시간을 처음부터 (시간 바꾸기·조금 더 쉬기). 모드만 바꾸면 남은 시간 그대로
  function start(mode, reset) {
    clearTimers();
    cur.mode = mode;
    if (reset || !cur.endAt) { cur.endAt = Date.now() + cur.minutes * 60000; cur.total = cur.minutes * 60000; }
    cur.startedAt = cur.startedAt || Date.now();
    var el = cur.el; el.textContent = '';
    el.className = 'rest-overlay mode-' + mode + (reduced() ? ' is-reduced' : '');
    var stage = h('div.rest-stage');
    var timeEl = h('div.rest-time', { 'aria-live': 'off' }, mmss(cur.endAt - Date.now()));
    var parkWrap = h('div.rest-park-mini');
    var top = h('div.rest-top',
      h('div.rest-modes', { role: 'group', 'aria-label': '휴식 모드' }, MODES.map(function (m) {
        return h('button.rest-mode' + (m.id === mode ? '.is-on' : ''), { type: 'button', 'aria-pressed': String(m.id === mode), onclick: function () { start(m.id); } }, m.label);
      })),
      h('div.rest-top-row', durationRow(), soundRow(),
        h('button.rest-dur', { type: 'button', title: '떠오른 생각을 적어 두고 다시 쉬어요', onclick: function () {
          if (parkWrap.firstChild) { parkWrap.textContent = ''; return; }
          parkWrap.appendChild(parkBox(true)); var t = parkWrap.querySelector('textarea'); if (t) t.focus();
        } }, '+ 생각 내려놓기')),
      parkWrap);
    var bottom = h('div.rest-bottom', h('button.btn.rest-stop', { type: 'button', onclick: function () { finish(); } }, '그만 쉬기'));
    el.appendChild(top); el.appendChild(stage); el.appendChild(bottom);
    RENDER[mode](stage, timeEl);
    ctx();   // 누른 김에 소리 장치를 깨워 둔다 — 끝날 때 종소리가 나도록 (브라우저는 사용자 동작 없이 소리를 막는다)
    if (cur.sound) startNoise(); else stopNoise();
    cur.timer = setInterval(function () {
      var left = cur.endAt - Date.now();
      timeEl.textContent = mmss(left);
      if (cur.onTick) cur.onTick(left);
      if (left <= 0) finish(true);
    }, 250);
    bottom.querySelector('button').focus();
  }

  // 남은 시간 고리 (SVG)
  function ring(timeEl) {
    var R = 92, C = 2 * Math.PI * R, svgNS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 220 220'); svg.setAttribute('class', 'rest-ring'); svg.setAttribute('aria-hidden', 'true');
    var bg = document.createElementNS(svgNS, 'circle'), fg = document.createElementNS(svgNS, 'circle');
    [bg, fg].forEach(function (c) { c.setAttribute('cx', '110'); c.setAttribute('cy', '110'); c.setAttribute('r', String(R)); svg.appendChild(c); });
    bg.setAttribute('class', 'ring-bg'); fg.setAttribute('class', 'ring-fg'); fg.setAttribute('stroke-dasharray', String(C));
    var total = cur.total || cur.minutes * 60000;
    cur.onTick = function (left) { fg.setAttribute('stroke-dashoffset', String(C * (1 - Math.max(0, left) / total))); };
    cur.onTick(cur.endAt - Date.now());
    return h('div.rest-ring-wrap', svg, timeEl);
  }

  var RENDER = {
    cover: function (stage, timeEl) {
      cur.onTick = null;
      stage.appendChild(ring(timeEl));
      stage.appendChild(h('p.rest-line', '지금은 아무것도 안 해도 돼요.'));
      stage.appendChild(h('p.rest-hint', '눈을 감아도 좋아요. 끝나면 종소리로 알려 드릴게요.'));
    },
    breathe: function (stage, timeEl) {
      cur.onTick = null;
      var circle = h('div.breath-circle', h('span.breath-word', '들이쉬어요'));
      var word = circle.firstChild;
      stage.appendChild(h('div.breath-wrap', circle));
      stage.appendChild(h('p.rest-line', '코로 천천히 들이쉬고, 입으로 더 길게 내쉬어요.'));
      stage.appendChild(h('div.rest-small-time', timeEl));
      var IN = 4000, OUT = 6000;
      function cycle(inhale) {
        if (!cur || cur.mode !== 'breathe') return;
        word.textContent = inhale ? '들이쉬어요' : '내쉬어요';
        circle.style.transitionDuration = (inhale ? IN : OUT) + 'ms';
        circle.classList.toggle('is-in', inhale);
        circle.classList.toggle('is-out', !inhale);
        cur.step = setTimeout(function () { cycle(!inhale); }, inhale ? IN : OUT);
      }
      cur.step = setTimeout(function () { cycle(true); }, 50);
    },
    eyes: function (stage, timeEl) {
      cur.onTick = null;
      stage.appendChild(h('div.eye-scene', { 'aria-hidden': 'true' },
        h('div.eye-sun'), h('div.eye-cloud.c1'), h('div.eye-cloud.c2'), h('div.eye-hill.h1'), h('div.eye-hill.h2'), h('div.eye-hill.h3')));
      var prompt = h('p.rest-line.eye-prompt', '창밖 먼 곳(6m 이상)을 바라봐요');
      var count = h('div.eye-count', '20');
      stage.appendChild(h('div.eye-panel', prompt, count, h('div.rest-small-time', timeEl)));
      var far = true, n = 20;
      cur.step = setInterval(function () {
        if (!cur) return;
        n -= 1;
        if (n <= 0) { far = !far; n = 20; prompt.textContent = far ? '창밖 먼 곳(6m 이상)을 바라봐요' : '눈을 감고, 천천히 깜빡여요'; }
        count.textContent = String(n);
      }, 1000);
    },
    stretch: function (stage, timeEl) {
      cur.onTick = null;
      var list = DN.aiAssist ? DN.aiAssist.pickStretches(5, Date.now()) : [];
      var i = 0, left = 0;
      var title = h('h2.stretch-title'), how = h('p.stretch-how'), count = h('div.stretch-count'), pos = h('div.stretch-pos');
      stage.appendChild(h('div.stretch-card', pos, title, how, count, h('button.btn', { type: 'button', onclick: function () { show(i + 1); } }, '다음 동작')));
      stage.appendChild(h('div.rest-small-time', timeEl));
      function show(k) {
        i = k % list.length;
        var s = list[i];
        title.textContent = s.title; how.textContent = s.how;
        pos.textContent = (i + 1) + ' / ' + list.length;
        left = s.seconds || 30; count.textContent = left + '초';
      }
      show(0);
      cur.step = setInterval(function () { if (!cur) return; left -= 1; count.textContent = Math.max(0, left) + '초'; if (left <= 0) show(i + 1); }, 1000);
    },
    // 자리 떠나기 — 화면을 보지 않아도 되게 아주 단순하게, 끝은 소리로
    walk: function (stage, timeEl) {
      cur.onTick = null;
      stage.appendChild(ring(timeEl));
      stage.appendChild(h('p.rest-line', '일어나서 잠깐 걸어요.'));
      stage.appendChild(h('ul.walk-ideas', ['물 한 잔 마시기', '창가까지 걸어가 먼 곳 보기', '계단 한 층 오르내리기', '어깨를 크게 돌리며 걷기'].map(function (x) { return h('li', x); })));
      stage.appendChild(h('p.rest-hint', '휴대폰은 두고 가요. 끝나면 종소리로 알려 드릴게요.'));
    }
  };

  // ---------------------------------------------------------------- 끝 — 다시 시작 · 평가
  function finish(timeUp) {
    if (!cur) return;
    clearTimers(); stopNoise();
    if (timeUp) chime();
    var mode = cur.mode;
    var spent = cur.startedAt ? Math.round((Date.now() - cur.startedAt) / 60000) : 0;
    var el = cur.el; el.textContent = ''; el.className = 'rest-overlay mode-end';
    var rated = null;
    var rateRow = mode ? h('div.rest-rate', { role: 'group', 'aria-label': '이번 휴식 평가' }, h('span', '이번 휴식(' + LABEL[mode] + ') 어땠어요?'),
      RATINGS.map(function (r) {
        return h('button.rest-dur', { type: 'button', onclick: function (e) {
          rated = r[0];
          Array.prototype.forEach.call(rateRow.querySelectorAll('button'), function (b) { b.classList.toggle('is-on', b === e.currentTarget); });
        } }, r[1]);
      })) : null;
    var tasks = cur.pausedIds.map(function (id) { return M.byId(S.state.tasks, id); }).filter(Boolean);
    el.appendChild(h('div.rest-end',
      h('h2.rest-title', timeUp ? '잘 쉬었어요.' : '휴식을 마칠까요?'),
      tasks.length ? h('div.rest-return', h('div.rest-label', '다시 시작할까요?'),
        tasks.map(function (t) { return h('div.rest-return-row', h('b', t.title), t.resumeNote ? h('span', '→ 첫 행동: ' + t.resumeNote) : null); }))
        : h('p.rest-sub', '다시 시작할까요?'),
      cur.parked.length ? h('p.rest-sub', '쉬기 전에 내려놓은 생각 ' + cur.parked.length + '개는 메모에 있어요.') : null,
      rateRow,
      h('div.rest-actions',
        h('button.btn.btn-primary', { type: 'button', onclick: function () { save(mode, rated, spent); back(true); } }, tasks.length ? '작업 공간으로 (이어서 하기)' : '돌아가기'),
        h('button.btn', { type: 'button', onclick: function () { save(mode, rated, spent); cur.minutes = 3; cur.startedAt = Date.now(); start(mode || 'cover', true); } }, '조금 더 쉬기 (3분)'),
        h('button.btn.btn-ghost', { type: 'button', onclick: function () { save(mode, rated, spent); prepare(); } }, '다른 방법으로 쉬기'))));
    var b = el.querySelector('.rest-actions .btn-primary'); if (b) b.focus();
  }
  function save(mode, rating, minutes) {
    if (!mode) return;
    S.mutate(null, function (s) {
      var log = s.meta.restLog = s.meta.restLog || [];
      log.push({ mode: mode, rating: rating, minutes: minutes, at: now().toISOString() });
      if (log.length > 200) log.splice(0, log.length - 200);
    }, { silent: true });
  }
  // 돌아가기 — 쉬기 전에 진행 중이던 일을 다시 시작 (resume 이면 작업 카드로 이어서)
  function back(resume) {
    if (!cur) return;
    var ids = cur.pausedIds.slice(), parked = cur.parked.length;
    close();
    ids.forEach(function (id) { DN.app.startTask(id); });
    if (resume && ids.length) {
      if (DN.app.current().view !== 'today') DN.app.go('today');
      if (DN.assistant && DN.assistant.work) DN.assistant.work(ids[0]);
    }
    if (resume && parked && DN.assistant) DN.assistant.post({ kind: 'text', text: '쉬기 전에 내려놓은 생각 ' + parked + '개를 메모에 남겨 뒀어요. 보관함에서 볼 수 있어요.' });
  }

  // 모드별 기록 요약 — [{ mode, label, count, good, ok, bad, score }]
  function stats(state) {
    var log = (state.meta && state.meta.restLog) || [];
    return MODES.map(function (m) {
      var rows = log.filter(function (r) { return r.mode === m.id; });
      var c = { mode: m.id, label: m.label, count: rows.length, good: 0, ok: 0, bad: 0 };
      rows.forEach(function (r) { if (c[r.rating] != null) c[r.rating] += 1; });
      var rated = c.good + c.ok + c.bad;
      c.score = rated ? Math.round((c.good * 2 + c.ok) / (rated * 2) * 100) : null;   // 좋았어요 100 · 보통 50 · 별로 0
      return c;
    });
  }

  DN.rest = { open: open, close: close, finish: finish, MODES: MODES, stats: stats, chime: chime, isOpen: function () { return !!cur; } };
})();
