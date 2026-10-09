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

  function send() {
    var text = ta.value.trim();
    if (!text) { Q.hide(); return; }
    Q.submit(text).then(function (r) {
      if (!r || !r.ok) { document.getElementById('sent-text').textContent = '보내지 못했어요. Daynote 창에서 다시 시도해 주세요.'; }
      else { document.getElementById('sent-text').textContent = '보냈어요. 정리 결과는 Daynote 오늘 화면에 있어요.'; ta.value = ''; }
      document.body.classList.add('is-sent');
      Q.resize(Math.ceil(panel.getBoundingClientRect().height) + 44);
      clearTimeout(hideTimer);
      hideTimer = setTimeout(function () { Q.hide(); }, r && r.ok ? 700 : 2000);
    });
  }

  ta.addEventListener('input', fit);
  ta.addEventListener('keydown', function (e) {
    if (e.isComposing || e.keyCode === 229) return;   // 한글 조합 중 Enter 는 글자 확정
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    else if (e.key === 'Escape') { e.preventDefault(); Q.hide(); }
  });

  // 뜰 때마다: 보냄 표시를 지우고, 입력창에 커서, 적던 글은 전체 선택
  Q.onShown(function (status) {
    clearTimeout(hideTimer);
    document.body.classList.remove('is-sent');
    showAi(status);
    panel.style.animation = 'none'; void panel.offsetWidth; panel.style.animation = '';
    ta.focus();
    ta.select();
    fit();
  });
  fit();
})();
