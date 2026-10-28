'use strict';
/**
 * Проверка живого окна настроек.
 *
 * Окно открывается настоящее, с настоящим preload и настоящим store: файл
 * настроек пишется в временный каталог, и проверка смотрит, что после
 * действия человека в файле лежит именно то, что он выбрал.
 *
 * Раньше логика окна жила в settings.js и проверялась только чтением кода.
 * После переезда интерфейса на Svelte поведение стало состоянием компонента,
 * и его нужно проверять по-настоящему: значение в поле, значение на диске и
 * надпись на экране — три разные вещи, и они обязаны совпадать.
 *
 *     npm run test:electron
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const SRC = path.join(__dirname, '..', '..', 'src');
const VERSION = require('../../package.json').version;

const results = [];
const step = (ok, name, note) => {
  results.push({ ok, name, note: note || '' });
  console.log(`  ${ok ? 'ОК  ' : 'ПРОВАЛ'} ${name}${note ? ': ' + note : ''}`);
};

app.on('window-all-closed', () => {});
/**
 * Проверка, которая висит, хуже проверки, которая падает: падение видно
 * сразу, а ожидание не видно никогда. Поэтому необработанная ошибка и
 * истечение времени ведут к ненулевому коду выхода.
 */
process.on('unhandledRejection', (e) => {
  console.error('  ПРОВАЛ необработанная ошибка: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
setTimeout(() => {
  console.error('  ПРОВАЛ: проверка не уложилась в две минуты');
  process.exit(1);
}, 120000).unref?.();


app.whenReady().then(async () => {
  // Свой каталог данных: проверка не должна трогать настройки человека.
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'puuush-settings-'));
  app.setPath('userData', ud);

  const store = require(path.join(SRC, 'store.js'));
  const { HOSTS } = require(path.join(SRC, 'upload.js'));

  // Те же каналы, что и в главном процессе: тест проверяет окно, а не IPC.
  ipcMain.handle('puuush:get-settings', () => store.getSettings());
  ipcMain.handle('puuush:broken-settings', () => store.brokenReason());
  // Занятая комбинация: главный процесс откатывает поле и сообщает, что не применено.
  ipcMain.handle('puuush:save-settings', (_e, patch) => {
    if (patch && patch.hotkey === 'Control+Alt+Q') {
      return { ...store.getSettings(), hotkeyApplied: false, imageHotkeyApplied: true };
    }
    return store.setSettings(patch || {});
  });
  ipcMain.handle('puuush:get-history', () => store.getHistory());
  ipcMain.handle('puuush:clear-history', () => store.clearHistory());
  ipcMain.handle('puuush:hosts', () => HOSTS.map((h) => ({ name: h.name, temp: h.temp })));
  ipcMain.handle('puuush:displays', () => [
    { id: '1', name: 'Built-in', width: 1920, height: 1080, scaleFactor: 1, primary: true, index: 1 },
    { id: '2', name: 'External', width: 2560, height: 1440, scaleFactor: 1, primary: false, index: 2 },
  ]);
  // Порядок из проверки скорости должен попасть в подпись «авто», а не
  // остаться только в невидимой настройке.
  store.setSettings({ hostOrder: ['uguu', 'x0'] });
  // Синхронный ответ на язык: окно спрашивает его до первой отрисовки.
  ipcMain.on('puuush:lang', (e) => { e.returnValue = store.getSettings().lang; });

  const win = new BrowserWindow({
    width: 720,
    height: 700,
    show: false,
    title: 'puuush',
    icon: path.join(SRC, '..', 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(SRC, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (...args) => {
    const ev = args[0];
    const modern = args.length === 1 && ev && typeof ev === 'object' && 'message' in ev;
    if ((modern ? ev.level : args[1]) >= 2) {
      const message = String(modern ? ev.message : args[2]);
      errors.push(message);
      console.log('  консоль окна: ' + message);
    }
  });
  win.webContents.on('preload-error', (_e, p, e) => errors.push('preload ' + e.message));

  await win.loadFile(path.join(SRC, 'renderer', 'settings.html'));
  await new Promise((r) => setTimeout(r, 1200));

  /** Выполняет код в окне и возвращает результат. */
  const run = (code) => win.webContents.executeJavaScript(code, true);

  const pageChrome = await run(`(function () {
    var title = document.querySelector('header h1');
    var header = document.querySelector('header');
    var headerActions = header && header.querySelector(':scope > div:last-child');
    var actions = Array.from(document.querySelectorAll('.settings-action'));
    var headerRect = header && header.getBoundingClientRect();
    var actionsRect = headerActions && headerActions.getBoundingClientRect();
    return {
      title: title ? title.textContent.trim() : '',
      documentTitle: document.title,
      version: (document.querySelector('.app-version')?.textContent || '').trim(),
      galleryRight: !!(headerRect && actionsRect && actionsRect.right >= headerRect.right - 1),
      gallery: Array.from(document.querySelectorAll('button')).some(function (button) {
        return /gallery|галере/i.test(button.textContent || '');
      }),
      historySection: Array.from(document.querySelectorAll('main > section h2')).some(function (heading) {
        return /history|история/i.test(heading.textContent || '');
      }),
      actionsRight: actions.length > 0 && actions.every(function (row) {
        return getComputedStyle(row).justifyContent === 'flex-end';
      }),
      dots: document.querySelectorAll('.rounded-full').length +
        (document.body.innerText.includes('·') ? 1 : 0)
    };
  })()`);
  step(pageChrome.title === 'Settings', 'заголовок страницы переведён', pageChrome.title);
  step(pageChrome.documentTitle === 'puuush — settings',
    'системный заголовок окна содержит название раздела', pageChrome.documentTitle);
  step(pageChrome.version === `v${VERSION}`, 'номер версии виден в настройках', pageChrome.version);
  step(pageChrome.galleryRight, 'версия и галерея выровнены вправо', String(pageChrome.galleryRight));
  step(pageChrome.gallery && !pageChrome.historySection,
    'галерея доступна из настроек без второго блока истории', String(pageChrome.gallery));
  step(pageChrome.actionsRight, 'кнопки действий стоят справа', String(pageChrome.actionsRight));
  step(pageChrome.dots === 0, 'в настройках нет декоративных точек', String(pageChrome.dots));

  // --- нативная рамка окна и ритм разделов ----------------------------
  const chrome = await run(`(function () {
    var sections = Array.from(document.querySelectorAll('main > section'));
    var second = sections[1] || null;
    var separator = second ? second.querySelector('[role="separator"]') : null;
    var content = second ? second.querySelector('h2 + div') : null;
    return {
      sections: sections.length,
      separators: document.querySelectorAll('main > section [role="separator"]').length,
      sectionGap: second ? parseFloat(getComputedStyle(second).marginTop) : -1,
      separatorGap: separator ? parseFloat(getComputedStyle(separator).marginBottom) : -1,
      contentGap: content ? parseFloat(getComputedStyle(content).marginTop) : -1
    };
  })()`);
  step(win.getBounds().height > win.getContentBounds().height,
    'окно использует системную рамку и кнопки Windows', `${win.getBounds().height}/${win.getContentBounds().height}`);
  step(win.getTitle() === 'puuush — settings' && win.isMenuBarVisible() === false,
    'переведённый заголовок окна и отсутствие строки меню', win.getTitle());
  step(chrome.separators === chrome.sections - 1, 'между разделами одна линия', chrome.separators + '/' + chrome.sections);
  step(chrome.sectionGap === 32 && chrome.separatorGap === 24 && chrome.contentGap === 16,
    'вертикальный ритм разделов по шкале кита',
    [chrome.sectionGap, chrome.separatorGap, chrome.contentGap].join('/'));

  // --- поле хоткея и список хостингов -------------------------------
  const start = await run(`(function () {
    var hotkey = document.getElementById('hotkey');
    var imageHotkey = document.getElementById('imageHotkey');
    var recordHotkey = document.getElementById('recordHotkey');
    var host = document.getElementById('host');
    return {
      hotkey: hotkey ? hotkey.value : null,
      imageHotkey: imageHotkey ? imageHotkey.value : null,
      recordHotkey: recordHotkey ? recordHotkey.value : null,
      hosts: host ? host.options.length : 0,
      autoLabel: host && host.options[0] ? host.options[0].textContent : '',
      ownVisible: document.getElementById('ownBox') ? document.getElementById('ownBox').style.display : null,
      speedButton: !!Array.from(document.querySelectorAll('button')).find(function (b) {
        return /speed|скорост/i.test(b.textContent || '');
      }),
      micBox: !!document.getElementById('recordMicrophone'),
      recordButton: !!Array.from(document.querySelectorAll('button')).find(function (b) {
        return /Record|Записать/i.test(b.textContent || '');
      }),
      recordScreen: document.getElementById('recordScreen') ? document.getElementById('recordScreen').value : null,
      screenOptions: document.getElementById('recordScreen') ? document.getElementById('recordScreen').options.length : 0,
      externalLabel: document.getElementById('recordScreen')
        ? Array.from(document.getElementById('recordScreen').options).map(function (o) { return o.textContent; }).find(function (t) { return /External/.test(t); })
        : '',
    };
  })()`);

  // На macOS комбинации показываются значками, на других системах словами.
  const mac = process.platform === 'darwin';
  step(start.hotkey === (mac ? '⌘⇧S' : 'Ctrl+Shift+S'), 'хоткей подставился', start.hotkey);
  step(start.imageHotkey === (mac ? '⌘⌥S' : 'Ctrl+Alt+S'), 'хоткей картинки в буфер подставился', start.imageHotkey);
  step(start.recordHotkey === (mac ? '⌘⇧R' : 'Ctrl+Shift+R'), 'хоткей записи подставился', start.recordHotkey);
  step(start.micBox, 'галочка микрофона на месте', String(start.micBox));
  step(start.recordButton, 'кнопка записи на месте', String(start.recordButton));
  step(start.recordScreen === 'cursor', 'по умолчанию запись берёт экран под курсором', start.recordScreen);
  step(start.screenOptions >= 4, 'экраны есть в выборе записи', String(start.screenOptions));
  step(/External/.test(start.externalLabel || '') && /2560×1440/.test(start.externalLabel || ''),
    'конкретный экран виден с разрешением', start.externalLabel);
  step(start.hosts >= 6, 'вариантов хостинга', String(start.hosts));
  step(
    /uguu,\s*x0/.test(start.autoLabel),
    'подпись авто начинается с измеренного порядка',
    start.autoLabel
  );
  step(start.speedButton, 'кнопка проверки скорости на месте', String(start.speedButton));
  step(start.ownVisible === 'block', 'блок своего сервера виден в режиме авто', start.ownVisible);

  // --- выбор конкретного экрана ---------------------------------------
  await run(`(function () {
    var screen = document.getElementById('recordScreen');
    screen.value = '2';
    screen.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 600));
  step(store.getSettings().recordScreen === '2', 'конкретный экран записан на диск', store.getSettings().recordScreen);
  step(store.getSettings().recordAllScreens === false, 'старый «все экраны» выключен для одного монитора', String(store.getSettings().recordAllScreens));

  // --- смена хостинга -----------------------------------------------
  await run(`(function () {
    var host = document.getElementById('host');
    host.value = 'catbox';
    host.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 600));

  const afterHost = await run(`(function () {
    return {
      value: document.getElementById('host').value,
      ownVisible: document.getElementById('ownBox').style.display,
      text: document.body.innerText,
    };
  })()`);

  step(afterHost.value === 'catbox', 'хостинг переключился', afterHost.value);
  step(afterHost.ownVisible === 'none', 'свой сервер спрятан в публичном режиме', afterHost.ownVisible);
  step(
    afterHost.text.includes('public host'),
    'предупреждение о публичном хостинге',
    ''
  );
  step(store.getSettings().host === 'catbox', 'хостинг записан на диск', store.getSettings().host);

  // --- адрес и ключ своего сервера -----------------------------------
  await run(`(function () {
    var url = document.getElementById('ownUrl');
    url.value = 'https://media.example.com';
    url.dispatchEvent(new Event('input', { bubbles: true }));
    url.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 600));

  const saved = store.getSettings();
  step(
    saved.own.base_url === 'https://media.example.com',
    'адрес своего сервера записан',
    saved.own.base_url
  );

  // В режиме «авто» с адресом, но без ключа, приложение обязано сказать,
  // что снимок уйдёт наружу. Это ровно то место, где продукт обещает
  // человеку приватность.
  const warn = await run(`(function () {
    var host = document.getElementById('host');
    host.value = 'auto';
    host.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 600));

  const afterAuto = await run(`document.body.innerText`);
  step(
    afterAuto.includes('public host'),
    'без ключа приложение предупреждает про внешний хостинг',
    ''
  );

  // Подсказка под ключом зависит от режима: в «только свой сервер» внешний
  // хостинг не обещается, потому что туда ничего не уходит.
  await run(`(function () {
    var host = document.getElementById('host');
    host.value = 'own';
    host.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 600));
  const ownText = await run(`document.body.textContent`);
  step(ownText.includes('the upload fails') && !ownText.includes('goes to a public host'),
    'в режиме own подсказка ключа не обещает внешний хостинг', '');
  await run(`(function () {
    var host = document.getElementById('host');
    host.value = 'auto';
    host.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 600));

  // --- запись хоткея: клавиша по физическому коду, занятая комбинация -----
  // Окно скрыто и без фокуса: настоящий focus() событие не пошлёт.
  await run(`document.getElementById('hotkey').dispatchEvent(new FocusEvent('focus'))`);
  await new Promise((r) => setTimeout(r, 200));
  // Русская раскладка: key даёт «й», code остаётся KeyQ.
  await run(`window.dispatchEvent(new KeyboardEvent('keydown',
    { key: 'й', code: 'KeyQ', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }))`);
  await new Promise((r) => setTimeout(r, 600));
  const afterTaken = await run(`({
    value: document.getElementById('hotkey').value,
    text: document.body.textContent })`);
  step(afterTaken.value === (mac ? '⌘⇧S' : 'Ctrl+Shift+S'),
    'занятая комбинация: в поле прежняя', afterTaken.value);
  step(afterTaken.text.includes('another application is holding it'),
    'занятая комбинация: сообщение «занята»', '');
  await run(`document.getElementById('hotkey').dispatchEvent(new FocusEvent('blur'))`);

  // --- перетаскивание файла ------------------------------------------
  const drops = await run(`(function () {
    var over = new Event('dragover', { bubbles: true, cancelable: true });
    var drop = new Event('drop', { bubbles: true, cancelable: true });
    document.body.dispatchEvent(over);
    document.body.dispatchEvent(drop);
    return { over: over.defaultPrevented, drop: drop.defaultPrevented };
  })()`);
  step(drops.over && drops.drop, 'drop мимо зоны отменён: окно не уйдёт на файл', JSON.stringify(drops));

  // Зона загрузки получает drop: у синтетического File нет пути, и окно
  // отвечает именно этим, а значит обработчик зоны дошёл до onFilesPicked.
  await run(`(function () {
    var zone = document.querySelector('[role="button"][tabindex]');
    var dt = new DataTransfer();
    dt.items.add(new File(['x'], 'a.png'));
    zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 600));
  step((await run(`document.body.textContent`)).includes('could not work out the path'),
    'зона загрузки получает drop', '');

  // --- автозапуск: чекбокс только там, где Electron его умеет ----------
  const hasLogin = await run(`!!document.getElementById('launchAtLogin')`);
  step(hasLogin === (process.platform !== 'linux'), 'чекбокс автозапуска по платформе', String(hasLogin));
  if (hasLogin) {
    await run(`(function () {
      var box = document.getElementById('launchAtLogin');
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await new Promise((r) => setTimeout(r, 600));
    step(store.getSettings().launchAtLogin === true, 'автозапуск записан на диск', '');
  }

  // --- язык -----------------------------------------------------------
  // По умолчанию английский: окно открывается на нём, даже если в системе
  // русская локаль. Русский включается человеком.
  // textContent, а не innerText: innerText отдаёт текст так, как он нарисован,
  // то есть с капителью, а заголовки разделов набраны капсом.
  const defaultLang = await run(`document.body.textContent`);
  step(
    defaultLang.includes('Settings.') && !defaultLang.includes('Настройки.'),
    'по умолчанию английский',
    ''
  );

  const buttons = await run(
    `Array.from(document.querySelectorAll('[role="group"] button')).map((b) => b.textContent.trim())`
  );
  step(buttons.length === 2, 'переключатель языка на месте', JSON.stringify(buttons));

  await run(`(function () {
    var b = Array.from(document.querySelectorAll('[role="group"] button'))
      .find((x) => x.textContent.trim() === 'Русский');
    if (b) b.click();
  })()`);
  await new Promise((r) => setTimeout(r, 700));

  const afterLang = await run(`document.body.textContent`);
  step(
    afterLang.includes('Настройки.') && afterLang.includes('Горячая клавиша'),
    'русский включается на лету',
    ''
  );
  step(await run(`document.querySelector('header h1').textContent.trim()`) === 'Настройки',
    'заголовок настроек переводится без ключа словаря', 'Настройки');
  step(await run(`document.title`) === 'puuush — настройки',
    'заголовок системной рамки переводится вместе с окном', await run(`document.title`));
  step(store.getSettings().lang === 'ru', 'язык записан на диск', store.getSettings().lang);

  // Обратно на английский: окно не должно остаться в прошлом языке.
  await run(`(function () {
    var b = Array.from(document.querySelectorAll('[role="group"] button'))
      .find((x) => x.textContent.trim() === 'English');
    if (b) b.click();
  })()`);
  await new Promise((r) => setTimeout(r, 700));
  const back = await run(`document.body.textContent`);
  step(back.includes('Settings.') && store.getSettings().lang === 'en',
    'обратно на английский', store.getSettings().lang);

  // --- галочки -------------------------------------------------------
  await run(`(function () {
    var box = document.getElementById('keepLocalCopy');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 600));

  const afterBox = store.getSettings();
  step(afterBox.keepLocalCopy === false, 'галочка «хранить снимки» записана', String(afterBox.keepLocalCopy));

  // --- поле папки ----------------------------------------------------
  await run(`(function () {
    var dir = document.getElementById('saveDir');
    dir.value = '/tmp/puuush-shots';
    dir.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 600));

  step(store.getSettings().saveDir === '/tmp/puuush-shots', 'папка для скринов записана', store.getSettings().saveDir);

  // Папка внутри обычного файла не годится: настройки на неё не встают, и поле
  // возвращается к той, что на диске. Путь строим от временного файла, а не от
  // /etc/passwd: в Windows такой путь становится C:\etc\passwd и создаётся.
  const notADir = path.join(ud, 'not-a-dir');
  fs.writeFileSync(notADir, 'x');
  await run(`(function () {
    var dir = document.getElementById('saveDir');
    dir.value = ${JSON.stringify(path.join(notADir, 'shots'))};
    dir.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 600));

  step(store.getSettings().saveDir === '/tmp/puuush-shots', 'плохая папка не записана', store.getSettings().saveDir);

  // Вложенную папку окно создаёт само, и снимки уходят именно туда.
  const nested = path.join(ud, 'shots', 'deep', 'er');
  await run(`(function () {
    var dir = document.getElementById('saveDir');
    dir.value = ${JSON.stringify(nested)};
    dir.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 600));

  const dirNow = store.shotsDir();
  step(dirNow === path.resolve(nested) && fs.existsSync(dirNow), 'вложенная папка создана для снимков', dirNow);

  // --- ошибки в консоли ----------------------------------------------
  step(errors.length === 0, 'в консоли нет ошибок', errors.join(' | '));

  win.destroy();
  // Windows держит кэш Chromium открытым до выхода из приложения, поэтому
  // временную папку здесь могут не удалить. Это не провал проверки: папку
  // уберёт сама система.
  try {
    fs.rmSync(ud, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (e) {
    /* временная папка, её уберёт система */
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `  провалено: ${failed}` : '  все проверки пройдены');
  app.exit(failed ? 1 : 0);
});
