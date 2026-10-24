'use strict';

// Windows 실행 파일 만들기 — dist/ 에 설치 파일(Modib-Setup-버전.exe)과 휴대용(Modib-버전-portable.exe)
//   npm.cmd run dist
//   - electron-builder: 이 폴더 node_modules 에 있으면 그것, 없으면 ELECTRON_BUILDER_DIR (이 PC 에 이미 깔린 것) 를 쓴다
//   - Electron 런타임은 node_modules/electron/dist 의 것을 그대로 (새로 내려받지 않는다)
//   - .env (AI 키·구글 로그인 설정) 를 resources/app.env 로 넣는다 → dist/ 의 파일은 남에게 주지 말 것 (키가 들어 있다)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CANDIDATES = [
  path.join(ROOT, 'node_modules', 'electron-builder'),
  process.env.ELECTRON_BUILDER_DIR || '',
  'D:/MD_Reflo/live-preview-app/node_modules/electron-builder'
].filter(Boolean);
const ebDir = CANDIDATES.find((d) => fs.existsSync(path.join(d, 'package.json')));
if (!ebDir) {
  console.error('electron-builder 를 찾지 못했어요. npm.cmd install --save-dev electron-builder 후 다시 실행하거나 ELECTRON_BUILDER_DIR 을 지정하세요.');
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, '.env'))) {
  console.error('.env 가 없어요 — AI 키가 빠진 실행 파일이 됩니다. .env 를 만든 뒤 다시 실행하세요.');
  process.exit(1);
}
const electronDist = path.join(ROOT, 'node_modules', 'electron', 'dist');
const electronVersion = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version;
const pkg = require(path.join(ROOT, 'package.json'));

const builder = require(ebDir);
console.log('electron-builder ' + require(path.join(ebDir, 'package.json')).version + ' · Electron ' + electronVersion);
builder.build({
  projectDir: ROOT,
  targets: builder.Platform.WINDOWS.createTarget(process.argv.includes('--installer-only') ? ['nsis'] : ['nsis', 'portable'], builder.Arch.x64),
  config: Object.assign({}, pkg.build, { electronDist, electronVersion }),
  publish: 'never'
}).then((files) => {
  console.log('완료:');
  files.filter((f) => /\.exe$/i.test(f)).forEach((f) => console.log('  ' + path.relative(ROOT, f) + '  (' + Math.round(fs.statSync(f).size / 1048576) + 'MB)'));
}).catch((e) => { console.error('빌드 실패: ' + (e && e.message || e)); process.exit(1); });
