'use strict';

// Google 일정 정보 팝오버 (DN.views.extEvent) — GOOGLE §9.2.
//
//  - 캘린더 주간·하루·월 화면, 오늘 일정 목록에서 Google 일정(ExtItem, M.externalItems 의 투영)을 누르면 연다.
//  - 읽기 전용이다: 제목, 날짜·시간, 캘린더(색 점·이름), 장소, 원래 시간대 안내, 그리고 [Google 캘린더에서 열기].
//  - 다른 기기의 Daynote 가 올린 일정(origin 'daynote_other')은 그 사실을 한 줄로 알린다.
//  - 색은 데이터 값이라 CSS 변수(--gc)로만 넣는다 (el.style.setProperty — style:{'--x'} 는 브라우저에서 무시된다).

(function () {
  var DN = window.Daynote;

  var CITY = {
    'Asia/Seoul': '서울', 'Asia/Tokyo': '도쿄', 'Asia/Shanghai': '상하이', 'Asia/Singapore': '싱가포르', 'Asia/Hong_Kong': '홍콩',
    'America/New_York': '뉴욕', 'America/Los_Angeles': '로스앤젤레스', 'America/Chicago': '시카고', 'America/Denver': '덴버',
    'Europe/London': '런던', 'Europe/Paris': '파리', 'Europe/Berlin': '베를린', 'Australia/Sydney': '시드니', 'UTC': 'UTC', 'Etc/UTC': 'UTC'
  };

  function h() { return DN.ui.h.apply(null, arguments); }
  function D() { return DN.dates; }
  function now() { return DN.app && DN.app.now ? DN.app.now() : new Date(); }

  function localTz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) { return null; }
  }
  function cityOf(tz) {
    if (CITY[tz]) return CITY[tz];
    var last = String(tz).split('/').pop();
    return last.replace(/_/g, ' ');
  }
  // 원래 시간대의 시각 'HH:MM' (Intl 이 그 시간대를 모르면 null)
  function hmIn(iso, tz) {
    try {
      var parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
      return parts.replace(/^24/, '00');
    } catch (e) { return null; }
  }

  function addYmd(ymd, n) { return D().ymd(D().addDays(D().parseYmd(ymd), n)); }

  // '오늘 10:00–11:00' · '내일 · 종일' · '10월 12일 (월) – 10월 14일 (수) · 종일' · 날을 넘기면 '오늘 23:00 – 내일 01:00'
  function whenText(item, t) {
    var dd = D();
    if (item.allDay) {
      var s = item.startDate || dd.ymd(new Date(item.start));
      var lastDay = item.endDate ? addYmd(item.endDate, -1) : s;
      if (lastDay <= s) return dd.relDay(s, t) + ' · 종일';
      return dd.relDay(s, t) + ' – ' + dd.relDay(lastDay, t) + ' · 종일';
    }
    var a = new Date(item.start), b = new Date(item.end);
    var sameDay = dd.ymd(a) === dd.ymd(b) || (b.getTime() - a.getTime() <= 86400000 && dd.hm(b) === '00:00' && dd.dayDiff(a, b) === 1);
    if (sameDay) return dd.relDay(dd.ymd(a), t) + ' ' + dd.hm(a) + '–' + (dd.hm(b) === '00:00' && dd.ymd(a) !== dd.ymd(b) ? '24:00' : dd.hm(b));
    return dd.relDay(dd.ymd(a), t) + ' ' + dd.hm(a) + ' – ' + dd.relDay(dd.ymd(b), t) + ' ' + dd.hm(b);
  }

  function tzNote(item) {
    if (!item.tz || item.allDay) return null;
    var here = localTz();
    if (!here || item.tz === here) return null;
    var t = hmIn(item.start, item.tz);
    if (!t) return null;
    return '원래 시간대: ' + cityOf(item.tz) + ' ' + t;
  }

  // 화면 낭독용 이름 (캘린더 블록의 aria-label 과 같은 꼴)
  function ariaLabel(item) {
    if (!item) return '';
    if (item.allDay) return 'Google 일정: ' + (item.title || '(제목 없음)') + ', 종일, 읽기 전용';
    var dd = D();
    return 'Google 일정: ' + (item.title || '(제목 없음)') + ', ' + dd.hm(new Date(item.start)) + '부터 ' + dd.hm(new Date(item.end)) + '까지, 읽기 전용';
  }

  function content(item, close) {
    var t = now();
    var dot = h('span.gcal-dot', { 'aria-hidden': 'true' });
    if (item.color) dot.style.setProperty('--gc', item.color);
    var other = item.origin === 'daynote_other';
    var calName = other ? (item.calendarName || 'Daynote') : (item.calendarName || 'Google 캘린더');
    var note = tzNote(item);
    var link = typeof item.htmlLink === 'string' && /^https:\/\//.test(item.htmlLink) ? item.htmlLink : null;

    var actions = h('div.ext-pop-actions',
      link ? h('button.ext-open', { type: 'button', onclick: function () { close(); window.open(link); } }, DN.ui.icon('link'), 'Google 캘린더에서 열기') : null,
      h('button.ext-close', { type: 'button', onclick: function () { close(); } }, '닫기'));

    return h('div.ext-pop-body',
      h('div.ext-pop-kicker', other ? '다른 기기의 Daynote' : 'Google 일정'),
      h('div.ext-pop-title', item.title || '(제목 없음)'),
      h('div.ext-pop-row', DN.ui.icon('clock'), h('span', whenText(item, t))),
      h('div.ext-pop-row', dot, h('span', calName)),
      item.location ? h('div.ext-pop-row', DN.ui.icon('flag'), h('span.ext-pop-loc', item.location)) : null,
      note ? h('div.ext-pop-row.is-muted', DN.ui.icon('clock'), h('span', note)) : null,
      item.tentative ? h('div.ext-pop-note', '참석 여부를 아직 정하지 않은 일정이에요.') : null,
      h('p.ext-pop-note', other ? '다른 기기의 Daynote가 올린 일정이에요. 그 기기에서 바꿀 수 있어요.' : 'Google 일정이라 Daynote에서는 바꿀 수 없어요.'),
      actions);
  }

  function open(item, anchorEl) {
    if (!item || !DN.ui || !DN.ui.popover) return null;
    var pop = null, temp = null;
    function close() { if (pop) { var p = pop; pop = null; p.close(true); } }
    var anchor = anchorEl && anchorEl.isConnected && anchorEl.getBoundingClientRect ? anchorEl : null;
    if (!anchor) {                        // 기준 요소가 없으면 화면 위쪽 가운데에 임시 기준점
      temp = h('span.ext-pop-anchor', { 'aria-hidden': 'true' });
      document.body.appendChild(temp);
      anchor = temp;
    }
    pop = DN.ui.popover(anchor, content(item, close), {
      label: 'Google 일정', className: 'ext-pop',
      onClose: function () { pop = null; if (temp) { temp.remove(); temp = null; } }
    });
    // 키보드로 열었을 때도 바로 Esc·Tab 이 되게 첫 버튼에 포커스
    var el = pop && pop.el;
    setTimeout(function () {
      var b = el && el.isConnected ? el.querySelector('button') : null;
      if (b) try { b.focus(); } catch (e) {}
    }, 0);
    return pop;
  }

  DN.views = DN.views || {};
  DN.views.extEvent = { open: open, ariaLabel: ariaLabel, whenText: whenText };
})();
