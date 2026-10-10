'use strict';

// 설정 › "Daynote가 배운 것" 카드 (ADAPT §7.7.2) — DN.settingsCards.learn
//
//  - 체크박스는 prefs.learning 을 조용히(S.mutate(null, …, {silent:true})) 저장하고 요약·안내를 그 자리에서 고친다.
//  - 규칙 지우기(×)·모두 지우기는 라벨 있는 mutate 라 설정 화면이 다시 그려진다 (규칙 목록이 바뀌므로).
//  - 규칙 목록은 AD.list(state, now) 로 만든다. 프로젝트 이름·맥락 이름은 그릴 때 찾는다.

(function () {
  var DN = window.Daynote;
  DN.settingsCards = DN.settingsCards || {};

  var GROUPS = [
    { type: 'kind', title: '종류' },
    { type: 'project', title: '프로젝트' },
    { type: 'date', title: '날짜 표현' },
    { type: 'context', title: '할 일 맥락' }
  ];
  var PAGE = 50;
  var LEVEL_TEXT = { strong: '확실', hint: '참고', weak: '약해지는 중' };
  var WEEK = ['일', '월', '화', '수', '목', '금', '토'];

  // 더 보기로 늘린 개수 (다시 그려도 남는 값)
  var mem = { shown: {} };

  function S() { return DN.store; }
  function ui() { return DN.ui; }
  function h() { return DN.ui.h.apply(null, arguments); }
  function now() { return DN.app && DN.app.now ? DN.app.now() : new Date(); }
  function q(w) { return '‘' + w + '’'; }

  function profile() {
    if (DN.status && DN.status.profile) { try { return DN.status.profile(); } catch (e) { /* 아래로 */ } }
    var ST = DN.statusCore;
    return ST && ST.profile ? ST.profile((S().state && S().state.prefs) || {}) : null;
  }

  // 규칙의 "무엇을 보고" 부분
  function keyText(r) {
    var k = r.label || r.key;
    if (r.role === 'tail') return q('…' + k) + '로 끝나는 글';
    if (r.role === 'head') return q(k + '…') + '로 시작하는 글';
    if (r.role === 'part') return q(k) + ui().josa(k, '가/이').slice(k.length) + ' 들어간 글';
    return q(k);
  }

  function dateText(to) {
    var m = /^d([0-6])$/.exec(to || '');
    if (m) return '가장 가까운 ' + WEEK[+m[1]] + '요일';
    if (to === 'm-1') return '그달 마지막 날';
    m = /^m([0-9]+)$/.exec(to || '');
    if (m) return '그달 ' + m[1] + '일';
    return String(to || '');
  }

  function dayText(iso) {
    var d = iso ? new Date(iso) : null;
    return d && !isNaN(d.getTime()) ? (d.getMonth() + 1) + '월 ' + d.getDate() + '일' : '';
  }

  function targetChip(r) {
    var M = DN.model, st = S().state;
    if (r.type === 'kind') return ui().kindChip(r.to);
    if (r.type === 'project') {
      if (r.to === 'none') return h('span.chip', '프로젝트 없음');
      var p = M && M.byId ? M.byId(st.projects, r.to) : null;
      return r.missing || !p ? h('span.chip.chip-missing', '지운 프로젝트') : h('span.chip.chip-project', p.name);
    }
    if (r.type === 'date') return h('span.chip', dateText(r.to));
    var ST = DN.statusCore, label = r.to === 'none' ? '맥락 없음' : r.to;
    if (ST && ST.contextLabel && r.to !== 'none') {
      try { label = ST.contextLabel(profile(), r.to) || r.to; } catch (e) { label = r.to; }
    }
    return h('span.chip', label);
  }

  function ruleRow(r) {
    var key = keyText(r);
    var meta = [r.n + '번 고침'];
    var day = dayText(r.last);
    if (day) meta.push(day);
    meta.push(LEVEL_TEXT[r.level] || '참고');
    var chip = targetChip(r);
    return h('li.learn-row',
      h('span.learn-key', key),
      h('span.learn-arrow', { 'aria-hidden': 'true' }, '→'),
      chip,
      h('span.meta', meta.join(' · ')),
      h('button.icon-btn', {
        type: 'button', 'aria-label': key + ' → ' + chip.textContent + ' 규칙 지우기', title: '지우기',
        onclick: function () {
          if (DN.capture && DN.capture.forgetRule) DN.capture.forgetRule(r.id, r.label || r.key);
        }
      }, ui().icon('x')));
  }

  function summary(st, rules) {
    var L = st.learned && st.learned.metrics ? st.learned.metrics : {};
    var s = '규칙 ' + rules.length + '개 · 배운 대로 정리 ' + (Number(L.applied) || 0) + '번';
    if (Number(L.reverted)) s += ' · 그중 직접 되돌림 ' + Number(L.reverted) + '번';
    return s;
  }

  function render(ctx) {
    var AD = DN.adapt;
    var section = h('section.card.settings-card#set-learn', { 'aria-labelledby': 'set-learn-h' });
    section.appendChild(h('h3#set-learn-h', { tabindex: '-1' }, 'Daynote가 배운 것'));
    if (!AD) {
      section.appendChild(h('p.help', '배우는 기능을 불러오지 못했어요.'));
      return section;
    }
    var st = S().state;
    var rules = AD.list(st, now());
    var on = AD.enabled(st);

    section.appendChild(h('p.help', { style: { lineHeight: 1.6 } },
      '결과 카드에서 직접 고친 종류·프로젝트·날짜 표현을 이 기기에만 기억해 두고 다음 정리에 써요. ',
      'AI에는 지금 적은 글에 들어 있는 표현과 그 뜻만 참고로 함께 보내요.'));

    var sum = h('div.help#set-learn-sum', { 'aria-live': 'polite' }, summary(st, rules));
    var offNote = h('div.help#set-learn-off', { hidden: on }, '끄면 새로 배우지도, 배운 것을 쓰지도 않아요. 지금까지 배운 것은 남아 있어요.');
    var box = h('input#set-learn-on', {
      type: 'checkbox', checked: on,
      onchange: function () {
        var v = box.checked;
        S().mutate(null, function (s) { if (v) delete s.prefs.learning; else s.prefs.learning = false; }, { silent: true, source: 'learn' });
        offNote.hidden = v;
        sum.textContent = summary(S().state, AD.list(S().state, now()));
      }
    });
    section.appendChild(h('label.check-row', { for: 'set-learn-on' }, box, '고친 것에서 배우기'));
    section.appendChild(sum);
    section.appendChild(offNote);

    if (!rules.length) {
      section.appendChild(h('p.help', { style: { marginTop: '12px' } }, '아직 배운 게 없어요. 결과 카드에서 종류나 프로젝트를 고치면 여기에 쌓여요.'));
    }
    GROUPS.forEach(function (g) {
      var rows = rules.filter(function (r) { return r.type === g.type; });
      if (!rows.length) return;
      var limit = mem.shown[g.type] || PAGE;
      var list = h('ul.learn-list');
      rows.slice(0, limit).forEach(function (r) { list.appendChild(ruleRow(r)); });
      section.appendChild(h('h4.learn-group', g.title + ' · ' + rows.length));
      section.appendChild(list);
      if (rows.length > limit) {
        section.appendChild(h('button.link-btn', {
          type: 'button',
          onclick: function () { mem.shown[g.type] = limit + PAGE; if (ctx && ctx.rerender) ctx.rerender(); }
        }, '더 보기 (' + (rows.length - limit) + '개)'));
      }
    });

    section.appendChild(h('details.settings-adv',
      h('summary', ui().icon('chevronDown'), '어떻게 배우나요?'),
      h('p.help', { style: { lineHeight: 1.6, marginTop: '6px' } },
        '한 번 고치면 AI에 참고로 알려 줘요. 같은 표현을 두 번 이상 같은 쪽으로 고치면 AI 결과도 그쪽으로 바꾸고 카드에 ‘배운 대로’라고 표시해요. ',
        '직접 정한 종류·프로젝트·날짜와 명령어로 적은 글은 바꾸지 않아요. 오래 쓰지 않은 규칙은 점점 약해지고, 300개까지 기억해요.')));

    section.appendChild(h('div.settings-actions',
      h('button.btn.btn-sm.btn-danger', {
        type: 'button', disabled: !rules.length,
        onclick: function () {
          var n = AD.list(S().state, now()).length;
          if (!n) return;
          ui().confirm('배운 것을 모두 지울까요?', '규칙 ' + n + '개를 지워요. 메모와 할 일은 그대로예요.', '모두 지우기').then(function (ok) {
            if (!ok) return;
            S().mutate('배운 것 모두 지우기', function (s) { AD.reset(s); }, { source: 'learn' });
            ui().undoToast('배운 것을 모두 지웠어요.');
          });
        }
      }, '모두 지우기')));
    return section;
  }

  DN.settingsCards.learn = {
    render: render,
    // 규칙이 바뀌는 쓰기(source 'learn')는 설정 전체를 다시 그리게 둔다
    onChange: function () { return false; },
    destroy: function () { }
  };
})();
