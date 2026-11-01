#!/usr/bin/env node
'use strict';

// Единый источник версии приложения — package.json.
// Синхронизирует номер версии в документации и публичных файлах.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '').trim();
const versionParts = version.split('.');
const validVersion = versionParts.length === 3 &&
  versionParts.every(part => part.length > 0 && Array.from(part).every(ch => ch >= '0' && ch <= '9'));
if (!validVersion) {
  throw new Error('Некорректная версия в package.json: ' + version);
}

function update(relativePath, transform) {
  const file = path.join(root, relativePath);
  const before = fs.readFileSync(file, 'utf8');
  const after = transform(before);
  if (after !== before) {
    fs.writeFileSync(file, after, 'utf8');
    console.log('Версия ' + version + ': обновлён ' + relativePath);
  } else {
    console.log('Версия ' + version + ': ' + relativePath + ' уже актуален');
  }
}

update('README.md', text =>
  text.replace(/^# Квиз-арена — версия .*$/m, function () {
    return '# Квиз-арена — версия ' + version;
  })
);

update('public/index.html', text => {
  let result = text;
  result = result.replace(/([?&]v=)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g,
    function (_match, prefix) { return prefix + version; });
  result = result.replace(/(version\s*:\s*')[^']*(')/g,
    function (_match, prefix, suffix) { return prefix + version + suffix; });
  result = result.replace(/(INFO\.version\s*\|\|\s*')[^']*(')/g,
    function (_match, prefix, suffix) { return prefix + version + suffix; });
  return result;
});
