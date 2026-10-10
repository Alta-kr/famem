'use strict';

// 빠른 메모 창 — 적고 Enter 면 메인 창의 홈 입력과 똑같이 처리된다 (원문 먼저 저장 → AI 분류).
// 창은 숨기기만 하고 닫지 않으므로, Esc 로 닫아도 적던 글이 다음에 그대로 남아 있다.

(function () {
  var Q = window.daynoteQuick;
  var ta = document.getElementById('text');
  var panel = document.getElementById('panel');
  var hideTimer = null;

  function fit() {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 135) + 'px';
    Q.resize(Math.ceil(panel.getBoundingClientRect().height) + 44);
  }

  function showAi(s) {
    var el = document.getElementById('ai');
    el.firstChild.className = 'dot' + (s && s.configured ? '' : ' off');
    el.lastChild.textContent = s && s.configured ? 'AI가 자동으로 나눠요' : 'AI 미연결 · 메모로 저장';
  }

  var qhelp = document.getElementById('qhelp');
  var qnote = document.getElementById('qnote');
  var slash = null;

  function note(msg) {
    qnote.textContent = msg || '';
    qnote.classList.toggle('is-open', !!msg);
  }

  // /도움말 — 보내지 않고 창 안에 명령어 목록을 펼친다
  function showHelp() {
    var CMD = window.Daynote && window.Daynote.commands;
    qhelp.textContent = '';
    ((CMD && CMD.COMMANDS) || []).forEach(function (c) {
      var row = document.createElement('div');
      var b = document.createElement('b');
      b.textContent = '/' + c.ko[0];
      var d = document.createElement('span');
      d.textContent = c.desc;
      row.appendChild(b); row.appendChild(d);
      qhelp.appendChild(row);
    });
    qhelp.classList.add('is-open');
    ta.value = '';
    if (slash) slash.close();
    note('');
    fit();
  }
  function hideHelp() { qhelp.classList.remove('is-open'); fit(); }

  function done(msg, ok) {
    document.getElementById('sent-text').textContent = msg;
    if (ok) ta.value = '';
    document.body.classList.add('is-sent');
    Q.resize(Math.ceil(panel.getBoundingClientRect().height) + 44);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () { Q.hide(); }, ok ? 700 : 2000);
  }

  function send() {
    var text = ta.value.trim();
    if (!text) { Q.hide(); return; }
    var CMD = window.Daynote && window.Daynote.commands;
    var p = CMD && CMD.parse ? CMD.parse(text) : null;
    var okMsg = '보냈어요. 정리 결과는 Daynote 오늘 화면에 있어요.';
    if (p && p.command === 'help') { showHelp(); return; }
    if (p && p.kind && !p.args) { note('‘' + p.token + '’ 뒤에 적을 내용을 써 주세요.'); fit(); return; }
    if (p && p.kind) {
      var KL = { task: '할 일로', event: '일정으로', memo: '메모로', idea: '아이디어로', link: '링크로' };
      okMsg = (KL[p.kind] || '메모로') + ' 보냈어요. Daynote 오늘 화면에서 볼 수 있어요.';
    } else if (p && p.command === 'status') okMsg = '상태 바꾸기를 보냈어요.';
    else if (p && p.unknown) okMsg = '보냈어요 · ‘/' + p.unknown + '’는 없는 명령어라 글로 적었어요.';
    note('');
    Q.submit(text).then(function (r) {
      if (!r || !r.ok) done('보내지 못했어요. Daynote 창에서 다시 시도해 주세요.', false);
      else done(okMsg, true);
    });
  }

  // 명령어 자동완성은 keydown 리스너보다 먼저 붙인다
  slash = window.Daynote && window.Daynote.slash && window.Daynote.slash.attach
    ? window.Daynote.slash.attach(ta, { mount: document.getElementById('slash-mount') || panel, placement: 'below', idPrefix: 'slash', iconFor: function () { return null; }, onResize: fit, onExecute: showHelp })
    : null;

  ta.addEventListener('input', function () { note(''); if (qhelp.classList.contains('is-open')) qhelp.classList.remove('is-open'); fit(); });
  ta.addEventListener('keydown', function (e) {
    if (e.isComposing || e.keyCode === 229) return;   // 한글 조합 중 Enter 는 글자 확정
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    else if (e.key === 'Escape') {
      e.preventDefault();
      if (qhelp.classList.contains('is-open')) hideHelp(); else Q.hide();
    }
  });

  // 뜰 때마다: 보냄 표시를 지우고, 입력창에 커서, 적던 글은 전체 선택
  Q.onShown(function (status) {
    clearTimeout(hideTimer);
    document.body.classList.remove('is-sent');
    note(''); qhelp.classList.remove('is-open');
    showAi(status);
    panel.style.animation = 'none'; void panel.offsetWidth; panel.style.animation = '';
    ta.focus();
    ta.select();
    fit();
  });
  fit();
})();
