'use strict';

// 폰·브라우저에서 둘러볼 수 있는 웹 데모를 dist-web/ 에 만든다 (node 내장 모듈만 사용).
//   node scripts/build-web.js
// - renderer/ 를 그대로 복사하고 src/ 를 옆에 둔다. index.html 의 ../src/ 경로를 맞춘다.
// - web-demo.js 로 가짜 AI(규칙 기반, 화면에 '데모 모드' 표시)를 켠다. 데이터는 그 브라우저의 localStorage 에만 남는다.
// - 폰 홈 화면에 추가할 수 있게 웹 앱 매니페스트·아이콘(SVG, 256px PNG)·theme-color 를 넣는다. 서비스 워커는 두지 않는다
//   (오프라인 캐시가 없으니 새로 빌드하면 바로 반영된다). 색은 styles.css 의 토큰(--bg-app·--primary)에서 읽는다.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist-web');

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'renderer'), OUT, { recursive: true, filter: (src) => !/quick(\.html|\.js)$/.test(src) });
fs.cpSync(path.join(ROOT, 'src'), path.join(OUT, 'src'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'web-demo.js'), 'window.DAYNOTE_WEB_DEMO = true;\n');

// ---------------------------------------------------------------- 홈 화면에 추가 (매니페스트·아이콘)
// styles.css 에서 밝은 테마(:root 첫 블록)·어두운 테마(첫 [data-theme="dark"] 또는 prefers-color-scheme 블록)의 토큰을 읽는다
function tokens(css) {
  const pick = (block, name) => { const m = block && block.match(new RegExp('--' + name + ':\\s*(#[0-9A-Fa-f]{3,8})')); return m ? m[1] : null; };
  const light = (css.match(/:root\s*\{[\s\S]*?\n\}/) || [''])[0];
  const darkStart = css.search(/\[data-theme="dark"\]\s*\{|prefers-color-scheme:\s*dark\)\s*\{/);   // 주석 속 언급은 건너뛴다
  const dark = darkStart >= 0 ? css.slice(darkStart, darkStart + 8000) : '';
  return {
    bg: pick(light, 'bg-app') || '#F7F7F5',
    primary: pick(light, 'primary') || '#5B5BD6',
    bgDark: pick(dark, 'bg-app') || '#111113'
  };
}
const T = tokens(fs.readFileSync(path.join(ROOT, 'renderer', 'styles.css'), 'utf8'));

// 아이콘 — scripts/make-icons.js 와 같은 모양: 강조색 둥근 사각형 + 흰 메모 줄 세 개(마지막 줄은 짧게)
const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
  '<rect x="20" y="20" width="472" height="472" rx="123" fill="' + T.primary + '"/>' +
  '<g fill="#FFFFFF"><rect x="133" y="146" width="246" height="46" rx="23"/>' +
  '<rect x="133" y="233" width="246" height="46" rx="23"/>' +
  '<rect x="133" y="320" width="154" height="46" rx="23"/></g></svg>\n';
fs.writeFileSync(path.join(OUT, 'icon.svg'), ICON_SVG);
const PNG = path.join(ROOT, 'assets', 'icon-256.png');
const hasPng = fs.existsSync(PNG);
if (hasPng) fs.copyFileSync(PNG, path.join(OUT, 'icon-256.png'));

const manifest = {
  name: 'Daynote',
  short_name: 'Daynote',
  description: '던진 메모가 할 일과 일정으로 정리돼요.',
  lang: 'ko',
  start_url: './',
  scope: './',
  display: 'standalone',
  orientation: 'any',
  background_color: T.bg,
  theme_color: T.bg,
  icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }]
    .concat(hasPng ? [{ src: 'icon-256.png', sizes: '256x256', type: 'image/png', purpose: 'any' }] : [])
};
fs.writeFileSync(path.join(OUT, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2) + '\n');

const HEAD_EXTRA = [
  '<link rel="manifest" href="manifest.webmanifest">',
  '<meta name="theme-color" content="' + T.bg + '" media="(prefers-color-scheme: light)">',
  '<meta name="theme-color" content="' + T.bgDark + '" media="(prefers-color-scheme: dark)">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="default">',
  '<meta name="apple-mobile-web-app-title" content="Daynote">',
  '<link rel="icon" type="image/svg+xml" href="icon.svg">'
].concat(hasPng ? ['<link rel="apple-touch-icon" href="icon-256.png">'] : []);

const file = path.join(OUT, 'index.html');
let html = fs.readFileSync(file, 'utf8');
html = html
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/, '')
  .replace(/\.\.\/src\//g, 'src/')
  .replace(/(\s*)<script src="store\.js"><\/script>/, '$1<script src="web-demo.js"></script>$&')
  .replace(/\s*<link rel="icon" href="data:,">/, '')
  .replace(/(\n\s*)<title>/, (m, sp) => sp + HEAD_EXTRA.join(sp) + m);
if (!html.includes('web-demo.js')) throw new Error('store.js 스크립트 태그를 찾지 못했습니다');
if (!html.includes('manifest.webmanifest')) throw new Error('<title> 을 찾지 못해 매니페스트를 넣지 못했습니다');
fs.writeFileSync(file, html);

console.log('dist-web/ 완료');
