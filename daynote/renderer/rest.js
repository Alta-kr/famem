'use strict';

// 휴식 화면 — 할 일을 하다가 "완전히" 쉬게 한다. 근거: ../../DAYNOTE_UX_RESEARCH.md (휴식)
//
//   쉬기 전  : 진행 중인 일은 일시 정지 · 돌아와서 할 첫 행동 한 줄 (Leroy & Glomb 2018, Altmann & Trafton 2002)
//              머리에 남은 생각은 '생각 내려놓기' 로 적어 두고 떠난다 (인지 부하 덜기 — Risko & Gilbert 2016)
//   쉬는 동안: 앱 전체를 가린다 — 할 일이 보이면 머리가 계속 일을 붙잡는다 (심리적 분리 — Sonnentag & Fritz 2007)
//              알림·제안은 멈춘다. 모드·시간은 사용자가 고른다 (통제감 — Sonnentag & Fritz 2007)
//     calm    숨 고르고 눈 감기 — 순환 한숨 5번(1분 휴식은 3번) → 눈 감고 쉬기, 끝은 종소리
//               (순환 한숨: Balban 외 2023 · 분당 6회 안팎의 느린 호흡: Zaccaro 외 2018 · 아무것도 요구하지 않는 시간: Sonnentag & Fritz 2007)
//     stretch 몸 풀기   — 스트레칭을 하나씩 크게 (Albulescu 외 2022)
//     walk    산책하기  — 화면은 두고 나가서 걷기, 끝나면 소리로 알림 (움직이는 휴식 — Albulescu 외 2022, 점심 산책 Sianoja 외 2018)
//              소리: 무음(기본) · 새소리 · 물소리 — 공개 녹음 (Alvarsson 외 2010 · Fan & Baharum 2024) · 끝날 때 부드러운 종소리 (눈을 감고 쉬어도 되게)
//   돌아올 때: "다시 시작할까요?" — 이어서 할 일 · 적어 둔 첫 행동 · 평가(모드 비교)

(function () {
  var DN = window.Daynote;
  var M = DN.model, S = DN.store, ui = DN.ui, h = ui.h;

  var MODES = [
    { id: 'calm', label: '숨 고르고 눈 감기', icon: 'spark', desc: '원을 따라 숨을 다섯 번(1분 휴식은 세 번) 고른 뒤, 눈을 감고 쉬어요. 끝나면 종소리로 알려 드려요.', why: '내쉬기를 길게 하는 호흡이 긴장을 낮추고 (Balban 외 2023), 아무것도 안 하는 시간이 마음을 일에서 떼어 준다 (Sonnentag & Fritz 2007)' },
    { id: 'stretch', label: '몸 풀기', icon: 'task', desc: '스트레칭을 하나씩 크게 보여 줘요.', why: '짧게 움직이는 휴식이 피로를 줄인다 (Albulescu 외 2022)' },
    { id: 'walk', label: '산책하기', icon: 'chevronRight', desc: '화면은 두고 나가서 걸어요. 끝나면 종소리로 알려 드려요.', why: '걷는 휴식이 활력을 가장 크게 되살리고, 점심 산책은 오후 집중을 높인다 (Albulescu 외 2022 · Sianoja 외 2018)' }
  ];
  var LABEL = {}; MODES.forEach(function (m) { LABEL[m.id] = m.label; });
  // 예전 모드 이름 — 완전 가림·숨 고르기는 합쳐졌고, 눈 쉬기는 없어졌다
  var LEGACY = { cover: 'calm', breathe: 'calm' };
  function normMode(id) { return LABEL[id] ? id : (LEGACY[id] || null); }
  // 순환 한숨 한 번: 코로 들이쉬고 → 한 번 더 짧게 채우고 → 입으로 길게 내쉬기 (약 10초, 분당 6회 안팎)
  var SIGH = [['in', '들이쉬어요', 2500], ['top', '한 번 더', 1000], ['out', '길게 내쉬어요', 6000]];
  function breathCount(minutes) { return minutes <= 1 ? 3 : 5; }
  var DURATIONS = [1, 3, 5, 10];
  var RATINGS = [['good', '좋았어요'], ['ok', '보통'], ['bad', '별로']];

  var cur = null;   // 열려 있는 휴식

  function now() { return DN.app.now(); }
  function prefs() { return S.state.prefs; }
  function reduced() { return !!prefs().reduceMotion || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function mmss(ms) { var s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }

  // ---------------------------------------------------------------- 소리
  //   종소리: 두 음이 천천히 사라지는 사인파 (파일 없이 만든다)
  var audio = null;
  function ctx() {
    if (!audio) { var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; audio = new AC(); }
    if (audio.state === 'suspended') audio.resume();
    return audio;
  }
  // 자연 소리 — 공개 녹음 (renderer/sounds/CREDITS.md). 자연 소리가 조용한 환경보다 회복 지표를 조금 더 낮췄다 (Fan & Baharum 2024 메타분석)
  //   기본은 꺼짐(무음): 짧은 휴식엔 조용함도 좋다. 시끄러운 곳이면 자연 소리로 주변 소음을 덮는다
  var SOUNDS = [
    { id: 'off', label: '무음' },
    { id: 'birds', label: '새소리', src: 'sounds/birds.ogg' },
    { id: 'water', label: '물소리', src: 'sounds/water.ogg' }
  ];
  var SOUND_SRC = {}; SOUNDS.forEach(function (x) { SOUND_SRC[x.id] = x.src; });
  var SOUND_VOL = 0.45;
  // 예전 설정(true = 합성 잡음)은 물소리로
  function soundPref(v) { return v === true ? 'water' : SOUND_SRC[v] ? v : 'off'; }
  function fadeTo(el, to, ms, done) {
    var from = el.volume, t0 = Date.now();
    clearInterval(el._fade);
    el._fade = setInterval(function () {
      var k = Math.min(1, (Date.now() - t0) / ms);
      el.volume = Math.max(0, Math.min(1, from + (to - from) * k));
      if (k >= 1) { clearInterval(el._fade); if (done) done(); }
    }, 50);
  }
  function startSound() {
    if (!cur) return;
    var id = cur.sound, src = SOUND_SRC[id];
    if (cur.audio && cur.audio.dataset.id === id) return;
    stopSound();
    if (!src) return;
    var el = new Audio(src);
    el.loop = true; el.volume = 0; el.dataset.id = id;
    cur.audio = el;
    var p = el.play();
    if (p && p.catch) p.catch(function () {});
    fadeTo(el, SOUND_VOL, 2000);
  }
  function stopSound() {
    if (!cur || !cur.audio) return;
    var el = cur.audio; cur.audio = null;
    fadeTo(el, 0, 800, function () { try { el.pause(); el.src = ''; } catch (e) {} });
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
  // opts.mode: 바로 이 모드로 (예: 집중 타이머 끝·명령) / 없으면 늘 쉬기 전 화면에서 고른다 — 쉬는 방법은 그때그때 스스로 고르게 (통제감)
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
    cur = { el: el, pausedIds: pausedIds, parked: [], minutes: DN.habits.REST_DEFAULT_MIN, prevFocus: document.activeElement, sound: soundPref(prefs().restSound) };
    el.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); if (cur && cur.onEndEscape) cur.onEndEscape(); else if (cur && cur.mode) finish(); else back(false); } });
    var mode = normMode(opts.mode);
    if (mode) start(mode, true); else prepare();
  }
  function clearTimers() { if (cur) { clearInterval(cur.timer); clearTimeout(cur.step); clearInterval(cur.step); cur.timer = null; cur.step = null; } }
  function close() {
    if (!cur) return;
    clearTimers(); stopSound();
    if (cur.mode && DN.assistant && DN.assistant.rested) DN.assistant.rested();   // 쉬었으니 일한 흐름은 새로
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
        var isDef = m.id === normMode(prefs().restMode);
        return h('button.rest-card' + (isDef ? '.is-default' : ''), { type: 'button', onclick: function () { start(m.id, true); } },
          h('span.rest-card-icon', ui.icon(m.icon)), h('b', m.label, isDef ? h('span.rest-card-tag', '기본') : null), h('span.rest-card-desc', m.desc), h('span.rest-card-why', m.why));
      })),
      durationRow(), soundRow(),
      h('div.rest-actions', h('button.btn.btn-ghost', { type: 'button', onclick: function () { back(false); } }, '쉬지 않고 돌아가기'))));
    var first = el.querySelector('.rest-card.is-default') || el.querySelector('.rest-card'); if (first) first.focus();
  }
  function durationRow() {
    return h('div.rest-durations', { role: 'group', 'aria-label': '쉬는 시간' }, h('span', '쉬는 시간'),
      DURATIONS.map(function (n) {
        return h('button.rest-dur' + (cur.minutes === n ? '.is-on' : ''), { type: 'button', 'aria-pressed': String(cur.minutes === n), onclick: function () {
          cur.minutes = n;   // 이번 휴식만 — 다음 휴식은 다시 기본 3분
          if (cur.mode) start(cur.mode, true); else prepare();
        } }, n + '분');
      }));
  }
  function soundRow() {
    var row = h('div.rest-durations', { role: 'group', 'aria-label': '소리' }, h('span', '소리'),
      SOUNDS.map(function (x) {
        return h('button.rest-dur' + (cur.sound === x.id ? '.is-on' : ''), { type: 'button', 'aria-pressed': String(cur.sound === x.id),
          title: x.id === 'off' ? '조용한 곳이면 무음으로 충분해요' : '공개 녹음 — 주변이 시끄러우면 자연 소리로 덮어요', onclick: function () {
          cur.sound = x.id;
          S.mutate(null, function (s) { s.prefs.restSound = x.id; }, { silent: true });
          Array.prototype.forEach.call(row.querySelectorAll('button'), function (b, i) {
            b.classList.toggle('is-on', SOUNDS[i].id === x.id); b.setAttribute('aria-pressed', String(SOUNDS[i].id === x.id));
          });
          if (cur.mode) startSound();
        } }, x.label);
      }));
    return row;
  }

  // ---------------------------------------------------------------- 쉬는 중
  // reset: 쉬는 시간을 처음부터 (시간 바꾸기·조금 더 쉬기). 모드만 바꾸면 남은 시간 그대로
  function start(mode, reset) {
    clearTimers();
    cur.mode = mode;
    cur.onEndEscape = null;
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
    startSound();
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
    // 숨 고르고 눈 감기 — ① 순환 한숨 N번 (원을 따라) ② 눈 감고 쉬기 (고리 타이머, 끝은 종소리)
    calm: function (stage, timeEl) {
      cur.onTick = null;
      var total = breathCount(cur.minutes);
      var circle = h('div.breath-circle', h('span.breath-word', '준비'));
      var word = circle.firstChild;
      var count = h('div.breath-count', '1 / ' + total);
      stage.appendChild(h('div.breath-wrap', circle));
      stage.appendChild(count);
      stage.appendChild(h('p.rest-line', '코로 들이쉬고, 한 번 더 짧게 채운 뒤, 입으로 길게 내쉬어요.'));
      stage.appendChild(h('div.rest-small-time', timeEl));
      stage.appendChild(h('button.link-btn.rest-skip', { type: 'button', onclick: closeEyes }, '바로 눈 감고 쉬기'));
      var n = 0, k = 0;
      function phase() {
        if (!cur || cur.mode !== 'calm') return;
        var p = SIGH[k];
        word.textContent = p[1];
        circle.style.transitionDuration = p[2] + 'ms';
        circle.className = 'breath-circle is-' + p[0];
        cur.step = setTimeout(function () {
          k += 1;
          if (k < SIGH.length) return phase();
          k = 0; n += 1;
          if (n >= total) return closeEyes();
          count.textContent = (n + 1) + ' / ' + total;
          phase();
        }, p[2]);
      }
      function closeEyes() {
        if (!cur || cur.mode !== 'calm') return;
        clearTimeout(cur.step); cur.step = null;
        stage.textContent = '';
        stage.appendChild(ring(timeEl));
        stage.appendChild(h('p.rest-line', '이제 눈을 감고 쉬어요.'));
        stage.appendChild(h('p.rest-hint', '아무것도 안 해도 돼요. 끝나면 종소리로 알려 드릴게요.'));
      }
      cur.step = setTimeout(phase, 600);
    },
    // 몸 풀기 — 운동마다 구간(오른쪽 15초 → 왼쪽 15초 …)을 하나씩: 지금 할 말과 남은 초가 늘 맞는다 (src/core/exercises.js)
    //   부위(골고루 · 손목·팔 · 목·어깨 · 허리·다리)를 고를 수 있고, 쉬는 시간에 맞춰 운동 수를 정한다
    stretch: function (stage, timeEl) {
      cur.onTick = null;
      var EX = DN.exercises;
      var focus = prefs().restStretchFocus || 'all';
      var list = EX.routine(focus, Math.max(60, Math.round((cur.endAt - Date.now()) / 1000)), Date.now() % 100000);
      var i = 0, p = 0, left = 0;
      var pos = h('div.stretch-pos'), title = h('h2.stretch-title'), why = h('p.stretch-why');
      var say = h('p.stretch-how', { 'aria-live': 'polite' }), count = h('div.stretch-count'), nextEl = h('div.stretch-next');
      var bar = h('div.stretch-phase-bar', h('span'));
      var focusRow = h('div.rest-durations.stretch-focus', { role: 'group', 'aria-label': '풀 부위' }, h('span', '부위'),
        EX.FOCUS.map(function (f) {
          return h('button.rest-dur' + (f.id === focus ? '.is-on' : ''), { type: 'button', 'aria-pressed': String(f.id === focus), onclick: function () {
            S.mutate(null, function (s) { s.prefs.restStretchFocus = f.id; }, { silent: true });
            start('stretch');   // 남은 쉬는 시간은 그대로, 운동만 새로
          } }, f.label);
        }));
      stage.appendChild(focusRow);
      stage.appendChild(h('div.stretch-card', pos, title, why, say, bar, count, nextEl,
        h('div.stretch-actions',
          h('button.btn.btn-ghost', { type: 'button', onclick: function () { showPhase(p + 1); } }, '이 구간 넘기기'),
          h('button.btn', { type: 'button', onclick: function () { show(i + 1); } }, '다음 동작'))));
      stage.appendChild(h('p.rest-hint', '아프거나 저리면 바로 멈추세요. 반동 없이 천천히.'));
      stage.appendChild(h('div.rest-small-time', timeEl));
      function show(k) {
        i = k % list.length;
        var ex = list[i];
        title.textContent = ex.title; why.textContent = ex.why;
        pos.textContent = (i + 1) + ' / ' + list.length + ' · 약 ' + ex.seconds + '초';
        var nx = list[(i + 1) % list.length];
        nextEl.textContent = list.length > 1 ? '다음: ' + nx.title : '';
        showPhase(0);
      }
      function showPhase(k) {
        var ex = list[i];
        if (k >= ex.phases.length) { show(i + 1); return; }
        p = k;
        var ph = ex.phases[p];
        say.textContent = ph.say;
        say.classList.toggle('is-rest', !!ph.rest);
        left = ph.sec;
        count.textContent = left + '초';
        bar.firstChild.style.width = Math.round(p / ex.phases.length * 100) + '%';
      }
      show(0);
      cur.step = setInterval(function () {
        if (!cur) return;
        left -= 1;
        if (left <= 0) { showPhase(p + 1); return; }
        count.textContent = left + '초';
      }, 1000);
    },
    // 산책하기 — 화면을 보지 않아도 되게 아주 단순하게, 끝은 소리로
    walk: function (stage, timeEl) {
      cur.onTick = null;
      stage.appendChild(ring(timeEl));
      stage.appendChild(h('p.rest-line', '일어나서 걷고 와요.'));
      stage.appendChild(h('ul.walk-ideas', ['밖에 나가 한 바퀴', '나무나 하늘 보며 걷기', '계단 오르내리기', '물 한 잔 마시고 오기'].map(function (x) { return h('li', x); })));
      stage.appendChild(h('p.rest-hint', '휴대폰은 두고 가요. 끝나면 종소리로 알려 드릴게요.'));
    }
  };

  // ---------------------------------------------------------------- 끝 — 다시 시작 · 평가
  function finish(timeUp) {
    if (!cur) return;
    clearTimers(); stopSound();
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
    // 끝 화면에서 Esc — 기록하고 돌아가기 (끝 화면을 다시 그리지 않는다)
    cur.onEndEscape = function () { save(mode, rated, spent); back(false); };
    el.appendChild(h('div.rest-end',
      h('h2.rest-title', timeUp ? '잘 쉬었어요.' : '휴식을 마칠까요?'),
      tasks.length ? h('div.rest-return', h('div.rest-label', '다시 시작할까요?'),
        tasks.map(function (t) { return h('div.rest-return-row', h('b', t.title), t.resumeNote ? h('span', '→ 첫 행동: ' + t.resumeNote) : null); }))
        : h('p.rest-sub', '다시 시작할까요?'),
      cur.parked.length ? h('p.rest-sub', '쉬기 전에 내려놓은 생각 ' + cur.parked.length + '개는 메모에 있어요.') : null,
      rateRow,
      h('div.rest-actions',
        h('button.btn.btn-primary', { type: 'button', onclick: function () { save(mode, rated, spent); back(true); } }, tasks.length ? '작업 공간으로 (이어서 하기)' : '돌아가기'),
        // 조금 더 쉬기 — 같은 휴식을 이어서 (기록은 끝날 때 한 번, 시간은 처음부터 합쳐서)
        h('button.btn', { type: 'button', onclick: function () { cur.minutes = 3; start(mode || 'calm', true); } }, '조금 더 쉬기 (3분)'),
        h('button.btn.btn-ghost', { type: 'button', onclick: function () { save(mode, rated, spent); cur.startedAt = null; cur.onEndEscape = null; prepare(); } }, '다른 방법으로 쉬기'))));
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
      var rows = log.filter(function (r) { return normMode(r.mode) === m.id; });
      var c = { mode: m.id, label: m.label, count: rows.length, good: 0, ok: 0, bad: 0 };
      rows.forEach(function (r) { if (c[r.rating] != null) c[r.rating] += 1; });
      var rated = c.good + c.ok + c.bad;
      c.score = rated ? Math.round((c.good * 2 + c.ok) / (rated * 2) * 100) : null;   // 좋았어요 100 · 보통 50 · 별로 0
      return c;
    });
  }

  DN.rest = { open: open, close: close, finish: finish, MODES: MODES, SOUNDS: SOUNDS, normMode: normMode, stats: stats, chime: chime, isOpen: function () { return !!cur; } };
})();
