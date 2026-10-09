'use strict';

// 브라우저에서 렌더러 UI 를 확인하기 위한 정적 서버 (node 내장 모듈만 사용).
//   node scripts/serve.js [port]   → http://localhost:5178/
// 렌더러는 window.daynoteHost 가 없으면 localStorage 로 동작한다.

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || process.env.PORT || 5178);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json; charset=utf-8'
};

function send(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed');
  // DNS rebinding 막기: 이 컴퓨터 주소로 들어온 요청만
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return send(res, 403, 'Forbidden');

  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch (e) { return send(res, 400, 'Bad Request'); }

  if (pathname === '/') {
    res.writeHead(302, { Location: '/renderer/index.html' });
    return res.end();
  }
  if (pathname.includes('\0')) return send(res, 400, 'Bad Request');
  // 점으로 시작하는 파일·폴더(.env, .git …)는 내주지 않는다
  if (pathname.split('/').some((seg) => seg.startsWith('.'))) return send(res, 403, 'Forbidden');

  // 경로 탈출 방지: 해석한 경로가 ROOT 안에 있어야 한다
  const file = path.resolve(ROOT, '.' + pathname);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return send(res, 403, 'Forbidden');
  if (file.split(path.sep).includes('node_modules')) return send(res, 403, 'Forbidden');

  fs.stat(file, (err, st) => {
    if (err) return send(res, 404, 'Not Found');
    let target = file;
    if (st.isDirectory()) {
      if (!pathname.endsWith('/')) { res.writeHead(301, { Location: pathname + '/' }); return res.end(); }
      target = path.join(file, 'index.html');
    }
    fs.readFile(target, (err2, data) => {
      if (err2) return send(res, 404, 'Not Found');
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'no-store'
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Daynote 정적 서버: http://localhost:' + PORT + '/  (root: ' + ROOT + ')');
});
