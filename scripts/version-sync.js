#!/usr/bin/env node
'use strict';

// Единый источник версии приложения — package.json.
// Скрипт синхронизирует публичные места, где номер версии нужен пользователю
// или используется для сброса кэша браузера.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '').trim();

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Некорректная версия в package.json: ${version}`);
}

function update(relativePath, transform) {
  const file = path.join(root, relativePath);
  const before = fs.readFileSync(file, 'utf8');
  const after = transform(before);
  if (after !== before) {
    fs.writeFileSync(file, after, 'utf8');
    console.log(`Версия ${version}: обновлён ${relativePath}`);
  } else {
    console.log(`Версия ${version}: ${relativePath} уже актуален`);
  }
}

update('README.md', text =>
  text.replace(/^# Квиз-арена — версия .*$/m, `# Квиз-арена — версия ${version}`)
);

update('public/index.html', text => {
  let result = text;
  // Cache-busting для favicon и CSS, у которых версия задана в query string.
  result = result.replace(/([?&]v=)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g, `$1${version}`);
  // Версия, показываемая клиенту через /api/info, и резервное значение.
  result = result.replace(/(INFO\s*=\s*\{[^}]*?version\s*:\s*')[^']*(')/s, `$1${version}$2`);
  result = result.replace(/(INFO\.version\s*\|\|\s*')[^']*(')/g, `$1${version}$2`);
  // Keep developer-cabinet version fallbacks in sync as well.
  result = result.replace(/(DEVELOPER_INFO\s*=\s*\{[^}]*?version\s*:\s*')[^']*(')/s, `$1${version}$2`);
  result = result.replace(/(DEVELOPER_INFO\s*=\s*\{[^}]*?INFO\.version\s*\|\|\s*')[^']*(')/gs, `$1${version}$2`);
  return result;
});
