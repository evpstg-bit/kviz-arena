(function () {
  'use strict';

  var activeMode = 'classic';
  var activeView = 'question';

  var modes = {
    classic: {
      name: 'Classic',
      short: 'Классическая викторина',
      description: 'Вопросы с таймером, быстрые ответы и рейтинг участников.',
      question: 'Что характеризует интенсивный тип экономического роста?',
      answers: ['Увеличение числа работников', 'Внедрение новых технологий', 'Расширение посевных площадей', 'Рост добычи сырья'],
      correct: 1,
      stat: 'Ответы и баллы каждого участника',
      phoneTitle: 'Вопрос 4 из 12',
      team: 'Общий рейтинг'
    },
    kingdoms: {
      name: 'Color Kingdoms',
      short: 'Командная стратегия',
      description: 'Команды отвечают на вопросы, получают флаги и захватывают клетки карты.',
      question: 'Какой фактор повышает производительность труда?',
      answers: ['Технологическое обновление', 'Сокращение квалификации', 'Простой оборудования', 'Увеличение потерь'],
      correct: 0,
      stat: 'Команды, территория, флаги и трофеи',
      phoneTitle: 'Арена королевств',
      team: 'Синие · команда'
    },
    submarine: {
      name: 'Submarine Squad',
      short: 'Совместная экспедиция',
      description: 'Экипаж заряжает двигатель, ускоряет субмарину и проходит командные этапы.',
      question: 'Что помогает экипажу пройти экспедицию быстрее?',
      answers: ['Слаженные действия команды', 'Один участник вместо всех', 'Пропуск заданий', 'Остановка двигателя'],
      correct: 0,
      stat: 'Прогресс миссии, этапы и экипаж',
      phoneTitle: 'Этап 1 · Вопросы',
      team: 'Экипаж · 8 участников'
    }
  };

  function answerCards(items, correctIndex, modeClass) {
    return items.map(function (answer, index) {
      return '<div class="demo-answer-card demo-answer-' + index + ' ' + (index === correctIndex ? 'is-key' : '') + '">' +
        '<span class="demo-answer-letter">' + ['▲', '◆', '●', '■'][index] + '</span>' +
        '<span>' + answer + '</span>' +
        (modeClass === 'result' && index === correctIndex ? '<b class="demo-answer-check">✓</b>' : '') +
        '</div>';
    }).join('');
  }

  function classicQuestion() {
    var m = modes.classic;
    return '<div class="demo-projector demo-classic-projector">' +
      '<header class="demo-projector-head"><span class="demo-live-label"><i></i> CLASSIC · ИГРОВОЙ ВОПРОС</span><span class="demo-question-number">ВОПРОС 04 / 12</span></header>' +
      '<div class="demo-projector-content"><span class="demo-topic-label">ЭКОНОМИКА · ПРОВЕРКА ЗНАНИЙ</span>' +
      '<h3>' + m.question + '</h3><div class="demo-answer-grid">' + answerCards(m.answers, m.correct, 'question') + '</div></div>' +
      '<footer class="demo-projector-foot"><span>Время на ответ</span><div class="demo-time-track"><i></i></div><b>18 сек</b><span class="demo-answered-count">Ответили 24 / 32</span></footer>' +
      '</div>';
  }

  function kingdomMap() {
    var cells = ['red','red','neutral','neutral','blue','blue','blue',
      'red','red','neutral','blue','blue','blue','neutral',
      'neutral','neutral','neutral','blue','blue','neutral','neutral',
      'neutral','red','neutral','blue','blue','neutral','neutral',
      'red','red','neutral','neutral','blue','blue','neutral'];
    return cells.map(function (type, index) {
      var mark = type === 'red' ? (index === 0 ? '♜' : '') : type === 'blue' ? (index === 6 ? '♞' : '') : '';
      return '<span class="demo-map-cell is-' + type + '">' + mark + '</span>';
    }).join('');
  }

  function kingdomsQuestion() {
    return '<div class="demo-projector demo-kingdom-projector">' +
      '<header class="demo-kingdom-head"><div class="demo-game-brand"><span class="demo-game-mark">♜</span><span><b>Color Kingdoms</b><small>АРЕНА КОРОЛЕВСТВ</small></span></div>' +
      '<div class="demo-round-pill"><small>РАУНД</small><b>04</b></div><div class="demo-round-clock"><small>ВРЕМЯ РАУНДА</small><b>02:18</b></div></header>' +
      '<div class="demo-team-score-strip"><div class="demo-team-score is-red"><span>♜</span><b>Красные</b><strong>12</strong><small>клеток</small></div><div class="demo-team-score is-blue"><span>♞</span><b>Синие</b><strong>16</strong><small>клеток</small></div></div>' +
      '<div class="demo-kingdom-board-wrap"><div class="demo-board-heading"><span>✦</span><div><b>Битва за территорию</b><small>Ставьте флаги рядом со своей территорией</small></div><i>В ИГРЕ</i></div>' +
      '<div class="demo-kingdom-board">' + kingdomMap() + '</div><div class="demo-board-legend"><span><i class="is-neutral"></i>Свободная территория</span><span><i class="is-red"></i>Красные</span><span><i class="is-blue"></i>Синие</span></div></div>' +
      '</div>';
  }

  function submarineQuestion() {
    return '<div class="demo-projector demo-submarine-projector">' +
      '<header class="demo-submarine-head"><div><span class="demo-submarine-eyebrow">СОВМЕСТНАЯ МИССИЯ</span><h3>Экспедиция в глубины океана</h3><small>Submarine Squad · Этап 1 из 3</small></div><span class="demo-submarine-ship">🚢</span></header>' +
      '<div class="demo-submarine-mission"><div class="demo-mission-icon">⚡</div><div class="demo-mission-copy"><span>ЗАДАЧА ЭТАПА</span><h4>Зарядите двигатель правильными ответами</h4><p>Каждый верный ответ участников добавляет общий заряд экипажа.</p></div></div>' +
      '<div class="demo-charge-panel"><div class="demo-charge-label"><b>Заряд двигателя</b><strong>68% <small>/ 100%</small></strong></div><div class="demo-charge-track"><i></i></div><div class="demo-charge-foot"><span>✓ 24 верных ответа</span><span>⏱ 03:42 осталось</span></div></div>' +
      '<div class="demo-crew-strip"><span>ЭКИПАЖ В ИГРЕ</span><div><b>А</b><b>М</b><b>И</b><b>С</b><b>Д</b><small>+3</small></div><strong>8 / 30</strong></div>' +
      '</div>';
  }

  function classicResults() {
    return '<div class="demo-results-screen"><header class="demo-results-head"><div><span class="demo-screen-kicker">CLASSIC · АНАЛИТИКА ВОПРОСА</span><h3>Результаты ответа</h3><p>Что характеризует интенсивный тип экономического роста?</p></div><span class="demo-result-badge">✓ Ответ принят</span></header>' +
      '<div class="demo-stat-row"><div><strong>32</strong><span>участника</span></div><div><strong>24</strong><span>ответили верно</span></div><div><strong>75%</strong><span>успешность</span></div></div>' +
      '<div class="demo-results-layout"><div class="demo-answer-distribution"><b>Распределение ответов</b><div class="demo-bars">' +
      '<div><span>▲</span><i style="height:22%"></i><small>4</small></div><div><span>◆</span><i class="is-correct" style="height:100%"></i><small>24</small></div><div><span>●</span><i style="height:13%"></i><small>3</small></div><div><span>■</span><i style="height:4%"></i><small>1</small></div></div>' +
      '<div class="demo-correct-note"><span>✓</span> Правильный ответ: внедрение новых технологий</div></div>' +
      '<div class="demo-mini-ranking"><b>Лучшие участники</b><ol><li><span>🥇</span><span>Александр</span><strong>3 420</strong></li><li><span>🥈</span><span>Мария</span><strong>3 180</strong></li><li><span>🥉</span><span>Илья</span><strong>2 940</strong></li></ol><small>Рейтинг обновляется в ходе игры</small></div></div></div>';
  }

  function kingdomsResults() {
    return '<div class="demo-results-screen demo-kingdom-results"><header class="demo-results-head"><div><span class="demo-screen-kicker">COLOR KINGDOMS · СТАТИСТИКА МАТЧА</span><h3>Баланс сил на арене</h3><p>Команды соревнуются за территорию и трофеи.</p></div><span class="demo-result-badge">● Матч идёт</span></header>' +
      '<div class="demo-kingdom-result-grid"><div class="demo-kingdom-result-card is-red"><span>♜</span><small>КРАСНЫЕ</small><strong>12</strong><em>захваченных клеток</em><b>🏆 8 трофеев</b></div>' +
      '<div class="demo-kingdom-result-card is-blue"><span>♞</span><small>СИНИЕ</small><strong>16</strong><em>захваченных клеток</em><b>🏆 11 трофеев</b></div></div>' +
      '<div class="demo-kingdom-result-bottom"><div><b>Активность команд</b><div class="demo-team-progress"><span>Красные</span><i><b style="width:43%"></b></i><strong>43%</strong></div><div class="demo-team-progress"><span>Синие</span><i><b style="width:57%"></b></i><strong>57%</strong></div></div>' +
      '<div class="demo-result-insight"><span>✦</span><b>Синие впереди</b><small>На 4 клетки больше и на 3 трофея</small></div></div></div>';
  }

  function submarineResults() {
    return '<div class="demo-results-screen demo-submarine-results"><header class="demo-results-head"><div><span class="demo-screen-kicker">SUBMARINE SQUAD · ОТЧЁТ ЭКСПЕДИЦИИ</span><h3>Командная работа экипажа</h3><p>Общий прогресс миссии и активность участников.</p></div><span class="demo-result-badge">🚢 Миссия продолжается</span></header>' +
      '<div class="demo-stat-row"><div><strong>2 / 3</strong><span>этапа пройдено</span></div><div><strong>86%</strong><span>заряд двигателя</span></div><div><strong>24</strong><span>верных ответа</span></div></div>' +
      '<div class="demo-submarine-progress-card"><div class="demo-submarine-art">🚢</div><div><b>Готовность к следующему этапу</b><p>Экипаж собрал достаточно энергии. Следующая задача — удержать ускорение.</p><div class="demo-charge-track"><i></i></div></div></div>' +
      '<div class="demo-crew-list"><b>Экипаж</b><span><i>А</i> Александр <strong>6 ответов</strong></span><span><i>М</i> Мария <strong>5 ответов</strong></span><span><i>И</i> Илья <strong>4 ответа</strong></span><span><i>+5</i> Ещё участники <strong>9 ответов</strong></span></div></div>';
  }

  function phoneScreen() {
    var m = modes[activeMode];
    var modeIntro = activeMode === 'kingdoms'
      ? '<div class="demo-phone-team"><span>♞</span><div><b>Синие</b><small>Ваша команда</small></div><strong>🚩 2</strong></div><div class="demo-phone-progress"><span>До нового флага</span><b>2 / 3 ответа</b><i><b></b></i></div>'
      : activeMode === 'submarine'
        ? '<div class="demo-phone-progress submarine"><span>Заряд двигателя</span><b>68 / 100</b><i><b></b></i></div>'
        : '<div class="demo-phone-score"><span>Ваш счёт</span><strong>1 240 <small>баллов</small></strong></div>';
    return '<div class="demo-phone"><div class="demo-phone-island"></div><div class="demo-phone-inner">' +
      '<header class="demo-phone-head"><span class="demo-phone-brand-mark">' + (activeMode === 'classic' ? 'Q' : activeMode === 'kingdoms' ? '♞' : '🚢') + '</span><div><b>' + m.name + '</b><small>' + m.phoneTitle + '</small></div><span class="demo-phone-clock">09:41</span></header>' +
      modeIntro +
      '<div class="demo-phone-question"><span>' + (activeMode === 'submarine' ? 'ВОПРОС ЭКИПАЖА' : activeMode === 'kingdoms' ? 'ВОПРОС КОМАНДЫ' : 'ВОПРОС 04 / 12') + '</span><h3>' + m.question + '</h3></div>' +
      '<div class="demo-phone-answers">' + answerCards(m.answers, m.correct, 'phone') + '</div>' +
      '<div class="demo-phone-hint">' + (activeMode === 'submarine' ? 'Правильный ответ помогает всей команде' : activeMode === 'kingdoms' ? 'Верные ответы помогают получить флаг' : 'Выберите один вариант ответа') + '</div>' +
      '<div class="demo-phone-homebar"></div></div></div>';
  }

  function screenContent() {
    if (activeView === 'question') {
      if (activeMode === 'classic') return classicQuestion();
      if (activeMode === 'kingdoms') return kingdomsQuestion();
      return submarineQuestion();
    }
    if (activeView === 'results') {
      if (activeMode === 'classic') return classicResults();
      if (activeMode === 'kingdoms') return kingdomsResults();
      return submarineResults();
    }
    return '<div class="demo-phone-stage">' + phoneScreen() + '<aside class="demo-phone-explainer"><span class="demo-explainer-icon">↗</span><b>Экран участника</b><p>Участник подключается по PIN-коду или QR-коду и отвечает со своего смартфона. Экран адаптирован под небольшую ширину и сенсорное управление.</p><div class="demo-explainer-points"><span>✓ Без регистрации</span><span>✓ Крупные кнопки ответов</span><span>✓ Личный счёт и командный прогресс</span></div></aside></div>';
  }

  function explanation() {
    var m = modes[activeMode];
    if (activeView === 'question') return '<div><b>' + m.short + '</b><p>' + m.description + '</p></div><span>Экран игры</span>';
    if (activeView === 'results') return '<div><b>Преподаватель видит ход игры</b><p>' + m.stat + '. Показатели в этом примере демонстрационные.</p></div><span>Панель преподавателя</span>';
    return '<div><b>Смартфон участника</b><p>Так выглядит экран ответа на мобильном устройстве в режиме ' + m.name + '.</p></div><span>Мобильный экран</span>';
  }

  window.homepageDemoHtml = function () {
    var modeTabs = Object.keys(modes).map(function (key) {
      var m = modes[key];
      return '<button type="button" class="demo-mode-tab ' + (key === activeMode ? 'is-active' : '') + '" aria-pressed="' + (key === activeMode ? 'true' : 'false') + '" onclick="homepageDemoSetMode(\'' + key + '\')">' +
        '<span class="demo-mode-tab-mark">' + (key === 'classic' ? 'Q' : key === 'kingdoms' ? '♜' : '🚢') + '</span><span><b>' + m.name + '</b><small>' + m.short + '</small></span></button>';
    }).join('');
    var views = [
      { key: 'question', label: 'Игровой экран', icon: '▣' },
      { key: 'results', label: 'Результаты преподавателя', icon: '▤' },
      { key: 'participant', label: 'Смартфон участника', icon: '▯' }
    ].map(function (item) {
      return '<button type="button" class="demo-view-tab ' + (item.key === activeView ? 'is-active' : '') + '" aria-pressed="' + (item.key === activeView ? 'true' : 'false') + '" onclick="homepageDemoSetView(\'' + item.key + '\')"><span>' + item.icon + '</span>' + item.label + '</button>';
    }).join('');

    return '<section class="homepage-product-demo" id="homepage-product-demo" aria-labelledby="homepage-demo-title">' +
      '<div class="homepage-demo-heading"><div><span class="section-kicker">ПОСМОТРИТЕ, КАК ЭТО РАБОТАЕТ</span><h2 id="homepage-demo-title">Не просто викторина. <span>Целая игровая среда.</span></h2><p>Переключайте режимы и экраны, чтобы увидеть, как проходит игра для преподавателя и участников.</p></div><span class="homepage-demo-badge"><i></i> Интерактивный просмотр</span></div>' +
      '<div class="homepage-demo-shell"><div class="homepage-demo-shell-head"><span><i></i> ДЕМОНСТРАЦИЯ ИНТЕРФЕЙСА</span><small>Пример игровых экранов «Квиз-арены»</small></div>' +
      '<div class="demo-mode-tabs" role="group" aria-label="Выбор игрового режима">' + modeTabs + '</div>' +
      '<div class="demo-view-tabs" role="group" aria-label="Выбор экрана">' + views + '</div>' +
      '<div class="demo-preview-area"><div class="demo-preview-content">' + screenContent() + '</div>' +
      '<div class="demo-preview-caption">' + explanation() + '<small>Данные примеров условные и приведены для демонстрации интерфейса.</small></div></div></div></section>';
  };

  window.homepageDemoSetMode = function (mode) {
    if (!modes[mode]) return;
    activeMode = mode;
    var root = document.getElementById('homepage-product-demo');
    if (root) root.outerHTML = window.homepageDemoHtml();
  };

  window.homepageDemoSetView = function (view) {
    if (['question', 'results', 'participant'].indexOf(view) < 0) return;
    activeView = view;
    var root = document.getElementById('homepage-product-demo');
    if (root) root.outerHTML = window.homepageDemoHtml();
  };
})();