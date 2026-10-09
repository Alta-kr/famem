'use strict';

// 폰·브라우저에서 둘러볼 수 있는 웹 데모를 dist-web/ 에 만든다 (node 내장 모듈만 사용).
//   node scripts/build-web.js
// - renderer/ 를 그대로 복사하고 src/ 를 옆에 둔다. index.html 의 ../src/ 경로를 맞춘다.
// - web-demo.js 로 가짜 AI(규칙 기반, 화면에 '데모 모드' 표시)를 켠다. 데이터는 그 브라우저의 localStorage 에만 남는다.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist-web');

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'renderer'), OUT, { recursive: true, filter: (src) => !/quick(\.html|\.js)$/.test(src) });
fs.cpSync(path.join(ROOT, 'src'), path.join(OUT, 'src'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'web-demo.js'), 'window.DAYNOTE_WEB_DEMO = true;\n');

const file = path.join(OUT, 'index.html');
let html = fs.readFileSync(file, 'utf8');
html = html
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/, '')
  .replace(/\.\.\/src\//g, 'src/')
  .replace(/(\s*)<script src="store\.js"><\/script>/, '$1<script src="web-demo.js"></script>$&');
if (!html.includes('web-demo.js')) throw new Error('store.js 스크립트 태그를 찾지 못했습니다');
fs.writeFileSync(file, html);

console.log('dist-web/ 완료');
