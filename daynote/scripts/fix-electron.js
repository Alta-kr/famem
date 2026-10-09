'use strict';

// Windows에서 Electron 설치 후처리가 조용히 실패하는 경우를 메꾼다.
//
// 증상: npm install 은 성공하는데 npm start 가
//       "Electron failed to install correctly" 로 죽는다.
// 원인: zip 내려받기까지는 되는데 node_modules/electron/dist 로 푸는 단계가 막힌다
//       (Downloads 폴더의 인터넷 파일 표시, 백신의 폴더 보호 등).
// 처리: 이미 받아둔 캐시 zip을 PowerShell 로 직접 풀고 path.txt 를 만든다.
//
// npm install 뒤에 자동으로 돌고, 필요하면 `npm run fix` 로 따로 돌릴 수도 있다.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const electronDir = path.join(root, 'node_modules', 'electron');
const distDir = path.join(electronDir, 'dist');
const distExe = path.join(distDir, 'electron.exe');

function log(msg) { console.log('[fix-electron] ' + msg); }

function findZip(dir, name, depth) {
  if (depth > 3) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findZip(full, name, depth + 1);
      if (found) return found;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

function main() {
  if (process.platform !== 'win32') return;              // 문제가 생기는 건 Windows뿐
  if (!fs.existsSync(electronDir)) return;               // electron 자체가 없으면 할 일 없음
  if (fs.existsSync(distExe)) return;                    // 정상 설치됨 — 조용히 종료

  let version;
  try {
    version = require(path.join(electronDir, 'package.json')).version;
  } catch (e) {
    return;
  }

  const zipName = 'electron-v' + version + '-win32-' + process.arch + '.zip';
  const cacheRoot = path.join(process.env.LOCALAPPDATA || '', 'electron', 'Cache');
  const zip = findZip(cacheRoot, zipName, 0);

  if (!zip) {
    log('Electron 실행 파일이 없고, 캐시에서 ' + zipName + ' 도 찾지 못했습니다.');
    log('인터넷 연결을 확인한 뒤 npm install 을 다시 실행하거나,');
    log('아래 주소에서 zip 을 직접 받아 node_modules\\electron\\dist 에 풀어주세요.');
    log('https://github.com/electron/electron/releases/tag/v' + version);
    return;
  }

  log('설치가 덜 끝났습니다. 캐시의 zip 을 직접 풉니다.');
  log('  ' + zip);

  try {
    fs.mkdirSync(distDir, { recursive: true });
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Unblock-File -LiteralPath ' + JSON.stringify(zip) + ' -ErrorAction SilentlyContinue; ' +
      'Expand-Archive -LiteralPath ' + JSON.stringify(zip) +
      ' -DestinationPath ' + JSON.stringify(distDir) + ' -Force'
    ], { stdio: 'inherit' });

    if (!fs.existsSync(distExe)) {
      log('압축은 풀렸는데 electron.exe 가 보이지 않습니다. 백신이 막고 있을 수 있어요.');
      return;
    }
    fs.writeFileSync(path.join(electronDir, 'path.txt'), 'electron.exe', 'utf8');
    log('완료했습니다. 이제 npm start 로 실행하세요.');
  } catch (e) {
    log('압축 해제에 실패했습니다: ' + e.message);
    log('프로젝트를 Downloads 밖(예: C:\\dev\\)으로 옮기고 다시 시도해보세요.');
  }
}

main();
