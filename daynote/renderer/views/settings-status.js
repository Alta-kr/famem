'use strict';

// 설정 › "현재 상태" 카드 (STATUS §11) — DN.settingsCards.status
//
//  - 값은 모두 prefs.statusProfile 에 조용히(S.mutate(null, …, {silent:true})) 저장하고, 화면은 그 자리에서 고친다.
//    입력 중인 시각 값과 포커스가 다른 저장(빠른 메모 등)으로 날아가지 않게 카드 전체를 다시 그리지 않는다.
//  - 구조가 바뀌는 일(프리셋 바꾸기, 상태·맥락 더하기·지우기)만 카드 안쪽을 다시 채우고 포커스를 같은 자리로 돌려준다.
//  - 덮어쓰기 모델: 프리셋 값 위에 사용자가 바꾼 것만 저장한다. 표 칸을 기본값으로 되돌리면 그 덮어쓰기를 지운다.

(function () {
  var DN = window.Daynote;
  DN.settingsCards = DN.settingsCards || {};

  var LEVELS = ['up', 'normal', 'down', 'hide'];
  var LEVEL_LABEL = { up: '띄움', normal: '보통', down: '내림', hide: '숨김' };
  var LEVEL_MARK = { up: '▲', normal: '●', down: '▼', hide: '✕' };
  var CATEGORY_CHOICES = [['work', '업무 시간'], ['life', '내 시간'], ['overlay', '잠깐 쉬기'], ['rest', '쉬는 날']];
  var PLACE_CHOICES = [['office', '직장'], ['home', '집'], ['out', '밖'], ['moving', '이동 중']];
  var MINUTE_CHOICES = [5, 10, 15, 30, 45, 60, 90];
  var MAX_CUSTOM_STATUSES = 10, MAX_CUSTOM_CONTEXTS = 6;

  // 다시 그려도 남는 값 (모듈 메모리)
  var mem = { advOpen: false, prevPreset: null, presetNote: null, phoneStatus: null, newStatus: false, newCtx: false };

  function S() { return DN.store; }
  function ST() { return DN.statusCore; }
  function ui() { return DN.ui; }
  function h() { return DN.ui.h.apply(null, arguments); }
  function q(w) { return '‘' + w + '’'; }
  function jo(w, pair) { w = String(w == null ? '' : w); return ui().josa(w, pair).slice(w.length); }
  function tight(s) { return String(s || '').replace(/\s+/g, '').toLowerCase(); }

  function prefs() { return (S().state && S().state.prefs) || {}; }
  function profile() { return DN.status && DN.status.profile ? DN.status.profile() : ST().profile(prefs()); }
  function sp() { var p = prefs().statusProfile; return p && typeof p === 'object' ? p : {}; }

  // 조용한 저장 — fn(statusProfile, state)
  function save(fn) {
    S().mutate(null, function (s) {
      var p = s.prefs.statusProfile;
      if (!p || typeof p !== 'object') p = s.prefs.statusProfile = { v: 1 };
      if (p.v == null) p.v = 1;
      fn(p, s);
    }, { silent: true, source: 'status' });
  }
  function entry(p, key, id, create) {
    if (!Array.isArray(p[key])) p[key] = [];
    for (var i = 0; i < p[key].length; i++) if (p[key][i] && p[key][i].id === id) return p[key][i];
    if (!create) return null;
    var e = { id: id };
    p[key].push(e);
    return e;
  }
  function readEntry(key, id) {
    var list = Array.isArray(sp()[key]) ? sp()[key] : [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }
  function newId() { return 'u_' + (Math.random().toString(36) + '000000').slice(2, 8).replace(/[^a-z0-9]/g, '0'); }
  function splitWords(text) {
    return String(text || '').split(/[,，、\n]/).map(function (w) { return w.replace(/\s+/g, ' ').trim(); })
      .filter(function (w) { return w.length >= 2 && w.length <= 20; });
  }

  // ------------------------------------------------------------------ 카드
  function render(ctx) {
    var section = h('section.card.settings-card.st-settings#set-status', { 'aria-labelledby': 'set-status-h' });
    var cells = [];    // 표 칸 (데스크톱·폰) — 그 자리에서 고친다
    var focusKey = null;

    function fill() {
      cells = [];
      section.textContent = '';
      var ST_ = ST();
      if (!ST_) { section.appendChild(h('h3#set-status-h', '현재 상태')); section.appendChild(h('p.help', '현재 상태 기능을 불러오지 못했어요.')); return; }
      var pf = profile(), p = sp();
      section.appendChild(h('h3#set-status-h', '현재 상태'));
      section.appendChild(h('p.help', '‘퇴근’, ‘점심’처럼 적거나 오늘 화면의 칩을 누르면, 할 일을 그 시간에 맞게 보여 줘요. 숨긴 할 일은 지우지 않아요.'));

      // 쓰기
      section.appendChild(checkRow('st-enabled', '현재 상태 쓰기', pf.enabled, function (on) {
        save(function (x) { x.enabled = !!on; });
        notify();
      }));

      // 프리셋
      var presetSel = h('select.select.st-preset', { 'aria-label': '어떤 하루를 보내세요?', 'data-key': 'st-preset' },
        ST_.presetList().map(function (pr) {
          var soon = pr.stage !== 'v1';
          return h('option', { value: pr.id, selected: pr.id === pf.preset, disabled: soon && pr.id !== pf.preset }, pr.label + (soon ? ' (준비 중)' : ''));
        }));
      presetSel.addEventListener('change', function () { changePreset(presetSel.value, pf); });
      var desc = ST_.presetList().filter(function (x) { return x.id === pf.preset; })[0];
      section.appendChild(h('div.settings-row', h('span.lbl', '어떤 하루를 보내세요?'), presetSel));
      section.appendChild(h('p.help.st-preset-desc', desc ? desc.desc : ''));
      if (mem.presetNote && mem.presetNote.to === pf.preset) {
        section.appendChild(h('div.st-preset-note', { role: 'status' },
          h('ul', mem.presetNote.lines.map(function (l) { return h('li', l); })),
          mem.prevPreset ? h('button.link-btn', { type: 'button', 'data-key': 'st-preset-back', onclick: function () { changePreset(mem.prevPreset, profile(), true); } },
            '이전 프리셋으로 (' + presetLabel(mem.prevPreset) + ')') : null));
      }

      // 시간표 짐작
      section.appendChild(checkRow('st-guess', '근무 시간으로 상태 짐작하기 (내리기만 해요)', pf.schedule.mode === 'guess', function (on) {
        save(function (x) { x.autoSchedule = Object.assign({}, x.autoSchedule || {}, { mode: on ? 'guess' : 'off' }); });
        notify();
      }));
      section.appendChild(h('p.help.st-indent', '근무 시간은 위 ‘근무 시간’ 카드를 따라요. 짐작한 상태는 칩에 점선으로 보이고, 할 일을 숨기지는 않아요.',
        h('br'), h('span.st-workhours', '근무 시간: ' + workHoursText()),
        ' ', h('button.link-btn', { type: 'button', onclick: function () { scrollToCard('set-work'); } }, '바꾸기')));

      // 퇴근하면
      var seg = h('div.seg', { role: 'group', 'aria-label': '퇴근하면 업무 할 일은' });
      [['hide', '숨기기'], ['down', '아래로 내리기']].forEach(function (o) {
        seg.appendChild(h('button', { type: 'button', 'data-key': 'st-after-' + o[0], 'aria-pressed': pf.afterWork === o[0] ? 'true' : 'false', onclick: function (e) {
          var me = e.currentTarget;
          save(function (x) { x.afterWork = o[0]; });
          Array.prototype.forEach.call(seg.children, function (b) { b.setAttribute('aria-pressed', b === me ? 'true' : 'false'); });
          updateCells();
          notify();
        } }, o[1]));
      });
      section.appendChild(h('div.settings-row', h('span.lbl', '퇴근하면 업무 할 일은'), seg));

      section.appendChild(checkRow('st-urgent', '마감이 3시간 안이면 숨기지 않고 보여 주기', pf.urgentHours > 0, function (on) {
        save(function (x) { x.urgentHours = on ? 3 : 0; });
        notify();
      }));
      section.appendChild(checkRow('st-overtime', '근무 시간이 한참 지나도 ‘업무 중’이면 한 번 알려 주기', pf.schedule.overtimeLine, function (on) {
        save(function (x) { x.autoSchedule = Object.assign({}, x.autoSchedule || {}, { overtimeLine: !!on }); });
      }));

      // 더 고치기
      var adv = h('details.settings-adv.st-adv', { open: mem.advOpen },
        h('summary', '더 고치기'),
        h('div.st-adv-body', timesBlock(pf), statusesBlock(pf), contextsBlock(pf), matrixBlock(pf),
          h('div.st-block', h('button.link-btn', { type: 'button', onclick: function () { scrollToCard('set-learn'); } }, '배운 맥락 보기'),
            h('span.help', ' ‘Daynote가 배운 것’ 카드의 ‘할 일 맥락’에 있어요.'))));
      adv.addEventListener('toggle', function () { mem.advOpen = adv.open; });
      section.appendChild(adv);
      updateCells();   // 표 칸은 cells 가 다 모인 뒤 한 번 채운다
    }

    // 구조가 바뀌면 안쪽만 다시 채우고 포커스를 같은 data-key 로 돌려준다
    function refill(key) {
      focusKey = key || (document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute('data-key') : null);
      fill();
      if (focusKey) {
        var el = section.querySelector('[data-key="' + focusKey + '"]');
        if (el && el.focus) try { el.focus(); } catch (e) {}
      }
    }

    function notify() {
      // 홈 칩·목록이 새 설정을 보게 (설정 카드 자신은 source 'status' 를 받아도 다시 그리지 않는다)
      S().mutate(null, function () {}, { source: 'status' });
    }

    function presetLabel(id) {
      var x = ST().presetList().filter(function (pr) { return pr.id === id; })[0];
      return x ? x.label : id;
    }
    function changePreset(id, oldPf, back) {
      if (!id || id === oldPf.preset) return;
      var before = oldPf;
      if (DN.status && DN.status.applyPreset) DN.status.applyPreset(id);
      else save(function (x) { x.preset = id; });
      var after = profile();
      var lines = [];
      var menuA = before.menu.map(function (m) { return before.statuses[m].label; }).join(' · ');
      var menuB = after.menu.map(function (m) { return after.statuses[m].label; }).join(' · ');
      if (menuA !== menuB) lines.push('칩 메뉴: ' + menuB);
      if (before.schedule.mode !== after.schedule.mode) lines.push('근무 시간으로 짐작하기: ' + (after.schedule.mode === 'guess' ? '켬' : '끔'));
      if (before.afterWork !== after.afterWork) lines.push('퇴근하면 업무 할 일: ' + (after.afterWork === 'hide' ? '숨기기' : '아래로 내리기'));
      if (!lines.length) lines.push('보이는 차이는 크지 않아요.');
      mem.prevPreset = back ? null : before.preset;
      mem.presetNote = { to: id, lines: lines.slice(0, 3) };
      refill('st-preset');
    }

    function workHoursText() {
      var SL = DN.slots, wh = prefs().workHours;
      if (SL && SL.describeWorkHours && SL.normalizeWorkHours) return SL.describeWorkHours(SL.normalizeWorkHours(wh));
      var n = ST().normalizeWorkHours(wh);
      return n.days.map(function (d) { return DN.dates.WEEKDAYS[d]; }).join('·') + ' ' + n.start + '–' + n.end;
    }

    // ── 점심 · 하루 시작 · 짐작으로도 숨기기
    function timesBlock(pf) {
      var lunch = pf.schedule.lunch;
      var l0 = h('input.input.st-time', { type: 'time', value: lunch ? lunch[0] : '', 'aria-label': '점심 시작', 'data-key': 'st-lunch-0' });
      var l1 = h('input.input.st-time', { type: 'time', value: lunch ? lunch[1] : '', 'aria-label': '점심 끝', 'data-key': 'st-lunch-1' });
      var ds = h('input.input.st-time', { type: 'time', value: pf.schedule.dayStart, 'aria-label': '하루가 바뀌는 시각', 'data-key': 'st-daystart' });
      var err = h('div.field-error.st-err', { role: 'alert' });
      function saveLunch() {
        err.textContent = '';
        var a = l0.value, b = l1.value;
        if (!a && !b) { save(function (x) { x.autoSchedule = Object.assign({}, x.autoSchedule || {}, { lunch: null }); }); notify(); return; }
        if (!a || !b) return;                         // 하나만 적은 중에는 기다린다
        if (a >= b) { err.textContent = '점심 시작이 끝보다 앞이어야 해요.'; return; }
        save(function (x) { x.autoSchedule = Object.assign({}, x.autoSchedule || {}, { lunch: [a, b] }); });
      }
      l0.addEventListener('change', saveLunch);
      l1.addEventListener('change', saveLunch);
      ds.addEventListener('change', function () {
        err.textContent = '';
        if (!ds.value) return;
        if (ds.value > '12:00') { err.textContent = '하루가 바뀌는 시각은 12:00 전이어야 해요.'; return; }
        save(function (x) { x.autoSchedule = Object.assign({}, x.autoSchedule || {}, { dayStart: ds.value }); });
        notify();
      });
      return h('div.st-block',
        h('div.settings-row.st-times', h('span.lbl', '점심 시간'), l0, h('span', { 'aria-hidden': 'true' }, '–'), l1, h('span.help', '비우면 없음')),
        h('div.settings-row.st-times', h('span.lbl', '하루가 바뀌는 시각'), ds),
        err,
        checkRow('st-hideguess', '시간표 짐작으로도 숨기기', pf.schedule.hideOnGuess, function (on) {
          save(function (x) { x.autoSchedule = Object.assign({}, x.autoSchedule || {}, { hideOnGuess: !!on }); });
          notify();
        }));
    }

    // ── 상태 편집
    function statusesBlock(pf) {
      var list = h('div.st-list', { role: 'list', 'aria-label': '상태' });
      pf.statusIds.forEach(function (id) {
        if (id === 'none') return;
        list.appendChild(statusRow(pf, id));
      });
      var customN = pf.statusIds.filter(function (id) { return pf.statuses[id].custom; }).length;
      var addBtn = h('button.btn.btn-sm', { type: 'button', 'data-key': 'st-new-status', disabled: customN >= MAX_CUSTOM_STATUSES,
        onclick: function () { mem.newStatus = !mem.newStatus; refill(mem.newStatus ? 'st-ns-name' : 'st-new-status'); } },
        ui().icon('plus'), customN >= MAX_CUSTOM_STATUSES ? '새 상태 (최대 10개)' : '새 상태');
      return h('div.st-block', h('h4', '상태'), h('p.help', '메뉴에 보일 것, 이름, 알아들을 말, 기본 시간을 바꿔요.'), list,
        addBtn, mem.newStatus ? newStatusForm() : null);
    }
    function statusRow(pf, id) {
      var d = pf.statuses[id];
      var e = readEntry('statuses', id) || {};
      var err = h('div.field-error.st-err', { role: 'alert' });
      var name = h('input.input.st-name', { value: d.label, maxlength: '20', 'aria-label': d.label + ' 이름', 'data-key': 'st-name-' + id });
      name.addEventListener('change', function () {
        var v = name.value.replace(/\s+/g, ' ').trim();
        if (!v) { name.value = profile().statuses[id].label; return; }
        save(function (x) { var en = entry(x, 'statuses', id, true); en.label = v; if (d.custom) en.custom = true; });
        notify();
      });
      var words = wordsEditor('st-w-' + id, (e.words || []).slice(), d.label + ' 알아들을 말', function (w) {
        var owner = wordOwner(w, id);
        if (owner) { err.textContent = q(w) + jo(w, '는/은') + ' 이미 ' + q(owner) + '에서 쓰고 있어요'; return false; }
        err.textContent = '';
        save(function (x) { var en = entry(x, 'statuses', id, true); en.words = (en.words || []).concat([w]); if (d.custom) en.custom = true; });
        return true;
      }, function (w) {
        save(function (x) { var en = entry(x, 'statuses', id, true); en.words = (en.words || []).filter(function (y) { return tight(y) !== tight(w); }); });
      });
      var mins = null;
      if (d.overlay) {
        mins = h('select.select.st-mins', { 'aria-label': d.label + ' 기본 시간', 'data-key': 'st-min-' + id },
          MINUTE_CHOICES.concat(MINUTE_CHOICES.indexOf(d.minutes) === -1 && d.minutes ? [d.minutes] : []).map(function (m) {
            return h('option', { value: String(m), selected: m === d.minutes }, m + '분');
          }));
        mins.addEventListener('change', function () { save(function (x) { entry(x, 'statuses', id, true).minutes = Number(mins.value); }); });
      }
      var menuCb = h('input', { type: 'checkbox', checked: d.menu, 'data-key': 'st-menu-' + id, 'aria-label': d.label + ' 메뉴에 보이기' });
      menuCb.addEventListener('change', function () { save(function (x) { entry(x, 'statuses', id, true).menu = menuCb.checked; }); notify(); });
      var del = d.custom ? h('button.icon-btn.st-del', { type: 'button', 'aria-label': d.label + ' 상태 지우기', title: '지우기', onclick: function () { removeStatus(id); } }, ui().icon('trash')) : null;
      return h('div.st-row', { role: 'listitem' },
        h('div.st-row-main', h('span.st-dot-sm.st-' + d.category, { 'aria-hidden': 'true' }), name,
          mins, h('label.check-row.st-menu-cb', menuCb, '메뉴에 보이기'), del),
        words, err);
    }
    function wordOwner(w, selfId) {
      var k = tight(w), pf = profile(), list = Array.isArray(sp().statuses) ? sp().statuses : [];
      for (var i = 0; i < list.length; i++) {
        var en = list[i];
        if (!en || !Array.isArray(en.words)) continue;
        for (var j = 0; j < en.words.length; j++) {
          if (tight(en.words[j]) === k) return en.id === selfId ? (pf.statuses[selfId] || {}).label || '이 상태' : ((pf.statuses[en.id] || {}).label || en.label || en.id);
        }
      }
      return null;
    }
    function removeStatus(id) {
      var label = (profile().statuses[id] || {}).label || '';
      ui().confirm('상태 지우기', q(label) + ' 상태를 지울까요? 지금 이 상태면 시간표대로 돌아가요.', '지우기').then(function (ok) {
        if (!ok) return;
        var cur = S().state.presence && S().state.presence.current;
        if (cur && cur.id === id && DN.status && DN.status.toGuess) DN.status.toGuess({ quiet: true });
        save(function (x) {
          x.statuses = (x.statuses || []).filter(function (en) { return en && en.id !== id; });
          if (x.policy) delete x.policy[id];
        });
        notify();
        refill('st-new-status');
      });
    }
    function newStatusForm() {
      var name = h('input.input', { maxlength: '20', placeholder: '예) 운동 중', 'aria-label': '새 상태 이름', 'data-key': 'st-ns-name' });
      var cat = h('select.select', { 'aria-label': '성격' }, CATEGORY_CHOICES.map(function (c) { return h('option', { value: c[0] }, c[1]); }));
      var place = h('select.select', { 'aria-label': '장소' }, PLACE_CHOICES.map(function (c) { return h('option', { value: c[0], selected: c[0] === 'home' }, c[1]); }));
      var words = h('input.input', { placeholder: '알아들을 말 (쉼표로 나눠요)', 'aria-label': '알아들을 말' });
      var err = h('div.field-error.st-err', { role: 'alert' });
      function create() {
        var label = name.value.replace(/\s+/g, ' ').trim();
        if (!label) { err.textContent = '이름을 적어 주세요.'; name.focus(); return; }
        var ws = splitWords(words.value);
        for (var i = 0; i < ws.length; i++) {
          var owner = wordOwner(ws[i], null);
          if (owner) { err.textContent = q(ws[i]) + jo(ws[i], '는/은') + ' 이미 ' + q(owner) + '에서 쓰고 있어요'; return; }
        }
        var c = cat.value;
        save(function (x) {
          (x.statuses = Array.isArray(x.statuses) ? x.statuses : []).push({ id: newId(), custom: true, label: label, category: c,
            place: c === 'overlay' ? null : place.value, minutes: c === 'overlay' ? 30 : null, rec: c === 'overlay' ? 'short' : 'normal', words: ws, menu: true });
        });
        mem.newStatus = false;
        notify();
        refill('st-new-status');
      }
      name.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); create(); } });
      return h('div.st-new', { role: 'group', 'aria-label': '새 상태' },
        h('div.st-new-grid',
          h('div.field', h('label', '이름'), name),
          h('div.field', h('label', '성격'), cat),
          h('div.field', h('label', '장소'), place),
          h('div.field', h('label', '알아들을 말'), words)),
        err,
        h('div.st-new-actions',
          h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: create }, '만들기'),
          h('button.btn.btn-sm', { type: 'button', onclick: function () { mem.newStatus = false; refill('st-new-status'); } }, '취소')));
    }

    // ── 맥락 편집
    function contextsBlock(pf) {
      var list = h('div.st-list', { role: 'list', 'aria-label': '맥락' });
      pf.contextIds.forEach(function (id) { list.appendChild(contextRow(pf, id)); });
      var customN = pf.contextIds.filter(function (id) { return pf.contexts[id].custom; }).length;
      var addBtn = h('button.btn.btn-sm', { type: 'button', 'data-key': 'st-new-ctx', disabled: customN >= MAX_CUSTOM_CONTEXTS,
        onclick: function () { mem.newCtx = !mem.newCtx; refill(mem.newCtx ? 'st-nc-name' : 'st-new-ctx'); } },
        ui().icon('plus'), customN >= MAX_CUSTOM_CONTEXTS ? '새 맥락 (최대 6개)' : '새 맥락');
      return h('div.st-block', h('h4', '맥락'), h('p.help', '할 일이 어느 쪽 일인지 알아보는 말이에요. 더한 단어는 강하게 봐요.'), list,
        addBtn, mem.newCtx ? newContextForm() : null);
    }
    function ctxCls(pf, id) { return pf.contexts[id] && pf.contexts[id].custom ? 'ctx-custom' : 'ctx-' + id; }
    function contextRow(pf, id) {
      var c = pf.contexts[id];
      var e = readEntry('contexts', id) || {};
      var name = h('input.input.st-name', { value: c.label, maxlength: '20', 'aria-label': c.label + ' 맥락 이름', 'data-key': 'st-cname-' + id });
      name.addEventListener('change', function () {
        var v = name.value.replace(/\s+/g, ' ').trim();
        if (!v) { name.value = profile().contexts[id].label; return; }
        save(function (x) { var en = entry(x, 'contexts', id, true); en.label = v; if (c.custom) en.custom = true; });
        notify();
      });
      var words = wordsEditor('st-cw-' + id, (e.words || []).slice(), c.label + ' 단어', function (w) {
        save(function (x) { var en = entry(x, 'contexts', id, true); en.words = (en.words || []).concat([w]); if (c.custom) en.custom = true; });
        return true;
      }, function (w) {
        save(function (x) { var en = entry(x, 'contexts', id, true); en.words = (en.words || []).filter(function (y) { return tight(y) !== tight(w); }); });
      });
      var defaults = null;
      if (!c.custom && DN.statusWords && DN.statusWords.CONTEXT_WORDS && DN.statusWords.CONTEXT_WORDS[id]) {
        var cw = DN.statusWords.CONTEXT_WORDS[id];
        var all = [].concat(cw.strong || [], cw.mid || [], cw.weak || []);
        var off = (e.wordsOff || []).map(tight);
        defaults = h('details.st-defaults', h('summary', '기본 단어 보기 (' + all.length + ')'),
          h('div.st-chips', { role: 'group', 'aria-label': c.label + ' 기본 단어' }, all.map(function (w) {
            var on = off.indexOf(tight(w)) === -1;
            var b = h('button.chip.st-word-toggle' + (on ? '' : '.is-off'), { type: 'button', 'aria-pressed': on ? 'true' : 'false',
              title: on ? '눌러서 이 단어 끄기' : '눌러서 다시 쓰기', onclick: function () {
                var nowOn = b.getAttribute('aria-pressed') !== 'true';
                b.setAttribute('aria-pressed', nowOn ? 'true' : 'false');
                b.classList.toggle('is-off', !nowOn);
                save(function (x) {
                  var en = entry(x, 'contexts', id, true);
                  var list = (en.wordsOff || []).filter(function (y) { return tight(y) !== tight(w); });
                  if (!nowOn) list.push(w);
                  en.wordsOff = list;
                });
              } }, w);
            return b;
          })));
      }
      var del = c.custom ? h('button.icon-btn.st-del', { type: 'button', 'aria-label': c.label + ' 맥락 지우기', title: '지우기', onclick: function () { removeContext(id); } }, ui().icon('trash')) : null;
      return h('div.st-row', { role: 'listitem' },
        h('div.st-row-main', h('span.kind-dot.' + ctxCls(pf, id), { 'aria-hidden': 'true' }), name, del),
        words, defaults);
    }
    function removeContext(id) {
      var pf = profile(), label = pf.contexts[id] ? pf.contexts[id].label : id;
      var tasks = (S().state.tasks || []).filter(function (t) { return !t.deletedAt && t.context === id; });
      var sel = h('select.select', { 'aria-label': '옮길 맥락' }, h('option', { value: '' }, '정하지 않음'),
        pf.contextIds.filter(function (x) { return x !== id; }).map(function (x) { return h('option', { value: x }, pf.contexts[x].label); }));
      ui().modal({
        title: '맥락 지우기',
        body: h('div', h('p', q(label) + ' 맥락을 지울까요?'),
          tasks.length ? h('div.field', h('label', '이 맥락의 할 일 ' + tasks.length + '개를 옮길 곳'), sel) : h('p.help', '이 맥락으로 정한 할 일은 없어요.')),
        actions: [{ label: '취소' }, { label: '지우기', danger: true, onClick: function () {
          var to = sel.value || null, ids = tasks.map(function (t) { return t.id; }), at = DN.app.now();
          if (ids.length) {
            S().mutate('맥락 바꾸기', function (s) {
              ids.forEach(function (tid) { DN.model.updateTask(s, tid, { context: to, contextSource: 'user' }, at); });
            }, { source: 'status' });
          }
          save(function (x) {
            x.contexts = (x.contexts || []).filter(function (en) { return en && en.id !== id; });
            if (x.policy) Object.keys(x.policy).forEach(function (sid) { if (x.policy[sid]) delete x.policy[sid][id]; });
          });
          notify();
          refill('st-new-ctx');
        } }]
      });
    }
    function newContextForm() {
      var name = h('input.input', { maxlength: '20', placeholder: '예) 부업', 'aria-label': '새 맥락 이름', 'data-key': 'st-nc-name' });
      var words = h('input.input', { placeholder: '단어 (쉼표로 나눠요)', 'aria-label': '새 맥락 단어' });
      var err = h('div.field-error.st-err', { role: 'alert' });
      function create() {
        var label = name.value.replace(/\s+/g, ' ').trim();
        if (!label) { err.textContent = '이름을 적어 주세요.'; name.focus(); return; }
        var ws = splitWords(words.value);
        save(function (x) { (x.contexts = Array.isArray(x.contexts) ? x.contexts : []).push({ id: newId(), custom: true, label: label, words: ws }); });
        mem.newCtx = false;
        notify();
        refill('st-new-ctx');
      }
      name.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); create(); } });
      return h('div.st-new', { role: 'group', 'aria-label': '새 맥락' },
        h('div.st-new-grid', h('div.field', h('label', '이름'), name), h('div.field', h('label', '단어'), words)),
        err,
        h('div.st-new-actions',
          h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: create }, '만들기'),
          h('button.btn.btn-sm', { type: 'button', onclick: function () { mem.newCtx = false; refill('st-new-ctx'); } }, '취소')));
    }

    // 말 칩 편집기 — 쉼표·Enter 로 더하고 × 로 뺀다. onAdd(w) → false 면 넣지 않는다
    function wordsEditor(key, words, label, onAdd, onRemove) {
      var chips = h('div.st-chips', { role: 'list', 'aria-label': label });
      function chipFor(w) {
        var c = h('span.chip.st-word', { role: 'listitem' }, w,
          h('button.st-word-x', { type: 'button', 'aria-label': q(w) + ' 빼기', onclick: function () { onRemove(w); c.remove(); input.focus(); } }, '×'));
        return c;
      }
      words.forEach(function (w) { chips.appendChild(chipFor(w)); });
      var input = h('input.input.st-word-in', { placeholder: '말 더하기 (쉼표로 나눠요)', 'aria-label': label + ' 더하기', 'data-key': key });
      function commit() {
        var ws = splitWords(input.value);
        if (!ws.length) return;
        var have = Array.prototype.map.call(chips.querySelectorAll('.st-word'), function (c) { return tight(c.firstChild.textContent); });
        var left = [];
        ws.forEach(function (w) {
          if (have.indexOf(tight(w)) !== -1) return;
          if (onAdd(w) === false) { left.push(w); return; }
          have.push(tight(w));
          chips.appendChild(chipFor(w));
        });
        input.value = left.join(', ');
      }
      input.addEventListener('keydown', function (e) {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
      });
      input.addEventListener('change', commit);
      return h('div.st-words', chips, input);
    }

    // ── 상태 × 맥락 표
    function matrixRows(pf) {
      return pf.statusIds.filter(function (id) { var d = pf.statuses[id]; return !d.overlay && d.menu; }).slice(0, 8);
    }
    function isUserCell(sid, cid) { var pol = sp().policy; return !!(pol && pol[sid] && pol[sid][cid]); }
    function setCell(sid, cid, level) {
      var pf = profile();
      var raw = pf.rawMatrix[sid] ? pf.rawMatrix[sid][cid] : null;
      save(function (x) {
        x.policy = x.policy && typeof x.policy === 'object' ? x.policy : {};
        var row = x.policy[sid] = Object.assign({}, x.policy[sid] || {});
        if (level === raw) delete row[cid]; else row[cid] = level;
        if (!Object.keys(row).length) delete x.policy[sid];
      });
      updateCells();
      notify();
    }
    function resetRow(sid) {
      save(function (x) { if (x.policy) delete x.policy[sid]; });
      updateCells(); notify();
    }
    function cellText(pf, sid, cid) {
      return pf.statuses[sid].label + ' · ' + pf.contexts[cid].label + ': ' + LEVEL_LABEL[pf.matrix[sid][cid]] + '. 눌러서 바꾸기';
    }
    function updateCells() {
      var pf = profile();
      cells.forEach(function (c) {
        if (!pf.matrix[c.sid] || !pf.contexts[c.cid]) return;
        var lv = pf.matrix[c.sid][c.cid], user = isUserCell(c.sid, c.cid);
        if (c.kind === 'grid') {
          c.el.className = 'st-cell lv-' + lv + (user ? ' is-user' : '');
          c.el.querySelector('.st-cell-mark').textContent = LEVEL_MARK[lv];
          c.el.setAttribute('aria-label', cellText(pf, c.sid, c.cid));
          if (user) c.el.setAttribute('title', '직접 바꿈'); else c.el.removeAttribute('title');
        } else {
          c.el.setAttribute('aria-pressed', c.level === lv ? 'true' : 'false');
        }
      });
    }
    function matrixBlock(pf) {
      var rows = matrixRows(pf), cols = pf.contextIds.slice(0, 12);
      // 데스크톱: 격자
      var grid = h('div.st-matrix', { role: 'grid', 'aria-label': '상태 × 맥락 표' });
      grid.style.setProperty('--st-cols', String(cols.length));
      grid.appendChild(h('div.st-mrow.st-mhead', { role: 'row' }, h('span.st-mcorner', { role: 'columnheader' }, ''),
        cols.map(function (cid) { return h('span.st-mcol', { role: 'columnheader' }, pf.contexts[cid].label); }), h('span', { role: 'columnheader' }, '')));
      rows.forEach(function (sid) {
        var r = h('div.st-mrow', { role: 'row' }, h('span.st-mlabel', { role: 'rowheader' }, pf.statuses[sid].label));
        cols.forEach(function (cid) {
          var b = h('button.st-cell', { type: 'button', role: 'gridcell', 'data-key': 'st-cell-' + sid + '-' + cid,
            onclick: function () {
              var cur = profile().matrix[sid][cid];
              setCell(sid, cid, LEVELS[(LEVELS.indexOf(cur) + 1) % LEVELS.length]);
            } }, h('span.st-cell-mark', { 'aria-hidden': 'true' }, ''), h('span.st-cell-user', { 'aria-hidden': 'true' }));
          cells.push({ kind: 'grid', sid: sid, cid: cid, el: b });
          r.appendChild(b);
        });
        r.appendChild(h('button.link-btn.st-mreset', { type: 'button', 'aria-label': pf.statuses[sid].label + ' 줄 기본값으로', onclick: function () { resetRow(sid); } }, '기본값으로'));
        grid.appendChild(r);
      });
      var legend = h('div.help.st-legend', LEVELS.map(function (l) { return LEVEL_MARK[l] + ' ' + LEVEL_LABEL[l]; }).join(' · ') + ' — 칸을 누를 때마다 바뀌어요');

      // 폰: 위에 상태 .seg, 아래 맥락마다 4칸 .seg
      if (!mem.phoneStatus || rows.indexOf(mem.phoneStatus) === -1) mem.phoneStatus = rows[0] || null;
      var phone = h('div.st-matrix-phone');
      var statusSeg = h('div.seg.st-phone-statuses', { role: 'group', 'aria-label': '상태 고르기' });
      var body = h('div.st-phone-body');
      function paintPhone() {
        cells = cells.filter(function (c) { return c.kind !== 'phone'; });
        body.textContent = '';
        var sid = mem.phoneStatus;
        if (!sid) return;
        var pf2 = profile();
        cols.forEach(function (cid) {
          if (!pf2.contexts[cid]) return;
          var seg = h('div.seg', { role: 'group', 'aria-label': pf2.statuses[sid].label + ' · ' + pf2.contexts[cid].label });
          LEVELS.forEach(function (l) {
            var b = h('button', { type: 'button', 'aria-pressed': pf2.matrix[sid][cid] === l ? 'true' : 'false', onclick: function () { setCell(sid, cid, l); } }, LEVEL_LABEL[l]);
            cells.push({ kind: 'phone', sid: sid, cid: cid, level: l, el: b });
            seg.appendChild(b);
          });
          body.appendChild(h('div.st-phone-row', h('span.st-phone-ctx', h('span.kind-dot.' + ctxCls(pf2, cid), { 'aria-hidden': 'true' }), pf2.contexts[cid].label), seg));
        });
      }
      rows.forEach(function (sid) {
        statusSeg.appendChild(h('button', { type: 'button', 'aria-pressed': mem.phoneStatus === sid ? 'true' : 'false', onclick: function (e) {
          mem.phoneStatus = sid;
          Array.prototype.forEach.call(statusSeg.children, function (b) { b.setAttribute('aria-pressed', b === e.currentTarget ? 'true' : 'false'); });
          paintPhone();
        } }, pf.statuses[sid].label));
      });
      phone.appendChild(statusSeg);
      phone.appendChild(body);
      paintPhone();
      return h('div.st-block', h('h4', '상태 × 맥락 표'),
        h('p.help', '상태마다 어느 쪽 일을 위로 올리고(띄움) 숨길지 정해요. ‘퇴근하면 업무 할 일은’ 선택도 이 표에 들어 있어요.'),
        grid, phone, legend,
        h('button.btn.btn-sm.st-mreset-all', { type: 'button', onclick: function () {
          save(function (x) { delete x.policy; });
          updateCells(); notify();
        } }, '모두 기본값으로'));
    }
    fill();
    watchWorkHours(section, workHoursText);
    return section;
  }

  // '근무 시간' 카드는 조용히(silent) 저장하고 그 자리에서 고친다 — 이 카드의 '근무 시간: …' 줄도 따라 고친다.
  // 설정 화면 안의 change·click 뒤에 글만 비교해 바꾼다. 카드가 문서에서 빠지면(다시 그리기·화면 이동) 듣기를 그만둔다.
  var whWatch = null;
  function unwatchWorkHours() {
    if (!whWatch) return;
    document.removeEventListener('change', whWatch, true);
    document.removeEventListener('click', whWatch, true);
    whWatch = null;
  }
  function watchWorkHours(section, textFn) {
    unwatchWorkHours();
    var fn = whWatch = function () {
      setTimeout(function () {
        if (whWatch !== fn) return;
        if (!section.isConnected) { if (document.getElementById('set-status') !== section) unwatchWorkHours(); return; }
        var el = section.querySelector('.st-workhours');
        var txt = '근무 시간: ' + textFn();
        if (el && el.textContent !== txt) el.textContent = txt;
      }, 0);
    };
    document.addEventListener('change', fn, true);
    document.addEventListener('click', fn, true);
  }

  function scrollToCard(id) {
    var el = document.getElementById(id);
    if (!el) return;
    try { el.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) { el.scrollIntoView(); }
    var hd = el.querySelector('h3');
    if (hd) { hd.setAttribute('tabindex', '-1'); try { hd.focus({ preventScroll: true }); } catch (e) {} }
  }

  function checkRow(key, label, checked, onChange) {
    var cb = h('input', { type: 'checkbox', checked: checked, 'data-key': key });
    cb.addEventListener('change', function () { onChange(cb.checked); });
    return h('label.check-row.st-check', cb, h('span', label));
  }

  DN.settingsCards.status = {
    render: render,
    // 상태·설정 쓰기(source 'status')로는 다시 그리지 않는다 — 입력 중인 칸과 포커스를 지킨다
    onChange: function (info) { return !!(info && info.source === 'status'); },
    destroy: function () { unwatchWorkHours(); }
  };
})();
