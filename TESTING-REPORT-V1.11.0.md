# Техническая проверка версии 1.11.0

## Выполнено

- `node --check server.js` — успешно.
- Извлечены inline-блоки JavaScript из `public/index.html`; оба блока прошли `node --check`.
- `package.json`, `app-settings.json`, `builtin-tests.json`, `admin-credentials.json` — корректный JSON.
- `public/ui.css`, `public/liquid-glass.css`, `public/responsive-v2.css`, `public/tailwind.css` разобраны PostCSS без синтаксических ошибок.
- Локальный smoke-тест: `/`, `/api/info`, `/responsive-v2.css?v=1.11.0` и `/liquid-glass.css?v=1.11.0` ответили HTTP 200.
- Проверены пороги динамического размера доски: 30 игроков получают поле 15×15; более крупные группы — поле до 19×19.

Полный ручной визуальный прогон на реальных устройствах не выполнялся; после развёртывания рекомендуется проверить игровой экран на широком мониторе и на телефоне.
