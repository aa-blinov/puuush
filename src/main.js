'use strict';
/**
 * puuush — скриншот области, загрузка, ссылка в буфере.
 *
 * Приложение живёт в трее и не показывает главного окна: всё делается хоткеем
 * и меню. Окно настроек открывается отдельно и по умолчанию закрывается в трей.
 */

const path = require('node:path');
const fs = require('node:fs');
const {
  app,
  Tray,
  Menu,
  globalShortcut,
  Notification,
  clipboard,
  shell,
  dialog,
  BrowserWindow,
  nativeImage,
  ipcMain,
} = require('electron');

const store = require('./store');
const { t, setLang, getLang } = require('./i18n');
const upload = require('./upload');
const { publish, HOSTS, request, validateOwn } = upload;
const { captureTo } = require('./capture');

const ASSETS = path.join(__dirname, '..', 'assets');

let tray = null;

/**
 * Есть ли в системе трей, который реально что-то покажет.
 *
 * Конструктор `new Tray()` без системного трея не бросает исключение: он
 * молча создаёт объект, который ничего не рисует. Если ориентироваться на
 * него, приложение останется невидимым, и выйти из него будет нечем.
 * На Linux иконка трея живёт через StatusNotifier поверх сессионной шины
 * DBus, поэтому проверяем её наличие.
 *
 * Слепой случай, который честно не закрывается кодом: GNOME без расширения
 * AppIndicator. Шина DBus там есть, трея нет, проверка скажет «есть».
 */
// Модификаторы в синтаксисе Electron. Проверка идёт по разбору строки, а не
// регуляркой по началу: иначе «CommandOrControl+Shift+S» отсекается как
// беспризнаковый, хотя модификатор там есть.
const HOTKEY_MODIFIERS = new Set([
  'command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl',
  'alt', 'option', 'altgr', 'shift', 'super', 'meta',
]);

function hasModifier(combo) {
  const parts = String(combo || '').split('+').map((p) => p.trim().toLowerCase());
  if (parts.length < 2) return false;
  // Всё, кроме последнего элемента, обязано быть модификатором.
  const last = parts[parts.length - 1];
  if (!last) return false;
  return parts.slice(0, -1).every((p) => HOTKEY_MODIFIERS.has(p));
}

function trayAvailable() {
  if (process.platform !== 'linux') return true;
  return !!(process.env.DBUS_SESSION_BUS_ADDRESS && process.env.XDG_CURRENT_DESKTOP);
}
let settingsWin = null;
let busy = false;
let stage = 'capture'; // 'capture' или 'upload': для честного сообщения

// ---------------------------------------------------------------------------
// Режим командной строки: puuush --cli файл.png
// Печатает ссылку и выходит. Удобно из скриптов и для удалённых машин.
// ---------------------------------------------------------------------------
function runCli(argv) {
  const files = argv.filter((a) => !a.startsWith('--'));
  if (!files.length) {
    process.stderr.write(t('cli.usage'));
    process.exit(2);
  }
  const s = store.getSettings();
  // Язык CLI — тот же, что и у окна: человек выбрал его в настройках.
  setLang(s.lang);
  (async () => {
    let code = 0;
    // CLI шёл мимо защиты: при поломке настроек он отправлял файл публичному
    // хостингу, тогда как окно в той же ситуации отказывало.
    if (store.brokenReason()) {
      process.stderr.write(t('cli.broken'));
      process.exit(2);
    }
    for (const f of files) {
      try {
        const r = await publish(path.resolve(f), {
          host: s.host,
          own: s.own,
          onStep: (m) => process.stderr.write(`  ${m}\n`),
        });
        process.stdout.write(r.url + '\n');
      } catch (e) {
        process.stderr.write(`puuush: ${e.message}\n`);
        code = 1;
      }
    }
    process.exit(code);
  })();
  return true;
}

// ---------------------------------------------------------------------------
// Загрузка
// ---------------------------------------------------------------------------

// Последняя ошибка и последняя ссылка. Уведомления на голом Linux без
// notification-daemon не показываются вообще, поэтому статус должен быть виден
// ещё и в трее: иначе пользователь не узнает ни о сбое, ни о том, куда ушёл
// скриншот.
let lastError = null;
let lastUpload = null;

function noteError(msg) {
  lastError = String(msg);
  buildTrayMenu();
}

function clearError() {
  lastError = null;
  buildTrayMenu();
}

/** Уведомление, молча пропускаемое там, где его показывать нечем. */
function notify(title, body) {
  if (!Notification.isSupported()) return;
  new Notification({ title, body, silent: true }).show();
}

/**
 * Кладёт ссылку в буфер, но никогда не теряет её из-за буфера.
 *
 * Проверять приходится не по факту исключения, а по чтению обратно. На X11 без
 * менеджера буфера `writeText` отрабатывает без ошибки, а содержимое выделения
 * тут же умирает: приложение сообщает «ссылка в буфере», а вставить нечего.
 * На macOS и Windows такого нет, но проверка дешёвая и снимает целый класс
 * «молча сломалось».
 */
function deliverToClipboard(url, what = t('clipboard.what.link')) {
  let why = '';
  try {
    clipboard.writeText(url);
    const back = clipboard.readText();
    if (back !== url) why = t('clipboard.reason.accepted');
  } catch (e) {
    why = e.message;
  }

  if (!why) return true;

  noteError(t('note.clipboardFailed', { what }));
  notify('puuush', `${t('note.clipboardFailed', { what })}\n${url}`);
  dialog.showMessageBox({
    type: 'warning',
    message: t('clipboard.title'),
    detail: t('clipboard.detail', { url, why }),
    buttons: [t('clipboard.copy'), t('clipboard.close')],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) {
      try {
        clipboard.writeText(url);
      } catch (err) {
        /* второй отказ: ссылка уже на экране, её можно выделить руками */
      }
    }
  });
  return false;
}

/**
 * Картинка из буфера обмена.
 *
 * В Electron 44 нет ни nativeImage.readClipboardImage, ни clipboard.readImage:
 * есть has() и read() по имени формата. Прежний вызов падал с «is not a
 * function», то есть кнопка «Картинка из буфера» не работала вообще.
 */
function clipboardImage() {
  for (const format of ['image/png', 'image/jpeg', 'image/webp', 'image/bmp']) {
    try {
      if (!clipboard.has(format)) continue;
      const buf = clipboard.read(format);
      if (buf && buf.length) return nativeImage.createFromBuffer(buf);
    } catch (e) {
      // формат не поддержан системой, пробуем следующий
    }
  }
  return null;
}

let uploading = false;

async function uploadAndDeliver(filePath, { source = t('ui.field.snapshot') } = {}) {
  // Раньше флаг защищал только снимок по хоткею: двойной клик «Выбрать файл…»
  // запускал две загрузки, обе писали в одну строку статуса и обе дёргали
  // перерисовку истории.
  if (uploading) throw new Error(t('upload.busy'));

  // Всё после установки флага обязано быть внутри try: отказ из-за
  // непрочитанных настроек стоял между флагом и try, и сброс в catch был
  // недостижим. Загрузка залипала навсегда даже после починки настроек.
  uploading = true;
  let ownFailed = null;
  try {
    // Сначала читаем настройки, потом смотрим на ошибку. Порядок был наоборот,
    // и поломка, случившаяся уже после запуска, проходила мимо защиты: первый
    // запуск уходил на публичный хостинг, и только следующий был заблокирован.
    const s = store.getSettings();
    if (store.brokenReason()) {
      throw new Error(t('upload.settingsBroken'));
    }

    notify('puuush', t('note.uploading'));
    stage = 'upload';
    const r = await publish(filePath, {
      host: s.host,
      own: s.own,
      onStep: (m) => {
        broadcast('puuush:progress', { state: 'step', message: m });
        // Причина отказа своего сервера всплывает в этом шаге, и её уже
        // нельзя потерять.
        // Сбой своего сервера главный процесс узнаёт из результата publish(),
        // а не из текста шага: текст переводится, и совпадение перестало бы
        // работать. Здесь только показываем шаг человеку.
        void m;
      },
    });

    // Свой сервер мог отказать: publish() знает это по факту, а не по тексту.
    ownFailed = r.ownFailed || null;

    // Понижение приватности должно быть заметно. Иначе режим «авто» тихо
    // отправляет скриншот в публичный интернет, и человек об этом не знает.
    if (ownFailed && r.host !== 'own') {
      const msg = t('note.privacyDowngraded', { reason: ownFailed, host: r.host });
      noteError(msg);
      notify('puuush', msg);
    } else {
      clearError();
    }

    const copied = deliverToClipboard(r.url);
    lastUpload = { url: r.url, host: r.host, at: Date.now() };
    store.addHistory({
      url: r.url, host: r.host, temp: r.temp, file: filePath, source,
      expiresAt: r.expiresAt || null,
    });
    buildTrayMenu();
    notify('puuush', copied
      ? `${t('note.linkInClipboard', { source })}\n${r.url}`
      : `${t('note.linkReady', { source })}\n${r.url}`);
    broadcast('puuush:progress', {
      state: 'done',
      url: r.url,
      host: r.host,
      temp: r.temp,
      copied,
      privacyDowngraded: !!(ownFailed && r.host !== 'own'),
    });
    if (s.openAfterUpload) shell.openExternal(r.url);
    uploading = false;
    // Окно настроек читает copied и privacyDowngraded. Раньше наружу уходил
    // результат publish(), где этих полей нет, и окно писало «скопировано»
    // даже после системного диалога «буфер занят».
    return {
      url: r.url, host: r.host, temp: !!r.temp, size: r.size,
      copied, privacyDowngraded: !!(ownFailed && r.host !== 'own'),
    };
  } catch (e) {
    noteError(e.message);
    notify('puuush', t('note.failed', { error: e.message }));
    uploading = false;
    broadcast('puuush:progress', { state: 'error', message: e.message });
    throw e;
  }
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

/** Снимок экрана -> область -> загрузка -> буфер. */
async function shoot() {
  if (busy) {
    // Раньше нажатие просто игнорировалось, и это выглядело как сломанный
    // хоткей. Флаг держится и на время загрузки, поэтому говорим точно, что
    // происходит, а не всегда «выбирается».
    notify('puuush', stage === 'upload'
      ? t('note.shotStillUploading')
      : t('note.shotStillPicking'));
    return;
  }
  busy = true;
  stage = 'capture';
  broadcast('puuush:progress', { state: 'capturing' });
  try {
    const dir = store.shotsDir();
    const shot = await captureTo(dir);
    if (!shot) return; // Esc
    broadcast('puuush:progress', {
      state: 'captured',
      width: shot.width,
      height: shot.height,
    });
    try {
      await uploadAndDeliver(shot.path, { source: t('ui.field.snapshot') });
    } finally {
      // Раньше копия удалялась только после успеха, и опция «хранить локальные
      // копии» обещала больше, чем делала. Теперь правило одно для обоих
      // случаев: выключена — удаляем всегда.
      if (!store.getSettings().keepLocalCopy) discard(shot.path);
    }
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    notify('puuush', t('note.shotFailed', { error: msg }));
    broadcast('puuush:progress', { state: 'error', message: msg });
  } finally {
    busy = false;
    stage = 'capture';
  }
}

/** Удаляет локальный снимок, не давая сбою затереть результат. */
function discard(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (e) {
    /* файла уже нет, это не ошибка */
  }
}

// ---------------------------------------------------------------------------
// Трей
// ---------------------------------------------------------------------------

function trayImage() {
  const file = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  const p = path.join(ASSETS, file);
  if (fs.existsSync(p)) {
    const img = nativeImage.createFromPath(p);
    if (process.platform === 'darwin') img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createFromPath(path.join(ASSETS, 'icon.png'));
}

function historyMenu() {
  const items = store.getHistory().slice(0, 10);
  if (!items.length) return [{ label: t('tray.historyEmpty'), enabled: false }];
  const menu = items.map((h) => ({
    label: `${h.url.length > 58 ? h.url.slice(0, 58) + '…' : h.url}  (${h.host})`,
    toolTip: h.url,
    click: () => {
      if (deliverToClipboard(h.url, t('clipboard.what.history'))) {
        notify('puuush', t('note.copied'));
      }
    },
  }));
  menu.push({ type: 'separator' });
  menu.push({ label: t('tray.historyClear'), click: () => { store.clearHistory(); buildTrayMenu(); } });
  return menu;
}

/**
 * Подпись хостинга для человека.
 *
 * Внутренние имена хостингов не переводятся, но человек их видит: в трее, в
 * истории и в сообщении о понижении приватности.
 */
function hostLabel(name) {
  const key = `host.${name}`;
  const label = t(key);
  return label === key ? name : label;
}

function buildTrayMenu() {
  if (!tray) return;
  const s = store.getSettings();
  tray.setToolTip(t('tray.tooltip', { hotkey: s.hotkey }));

  const status = [];
  if (lastError) status.push({ label: t('tray.error', { error: lastError }), enabled: false });
  if (lastUpload) {
    const when = new Date(lastUpload.at).toLocaleTimeString(getLang() === 'ru' ? 'ru-RU' : 'en-GB', {
      hour: '2-digit', minute: '2-digit',
    });
    status.push({
      label: t('tray.lastUpload', { host: hostLabel(lastUpload.host), when }),
      enabled: false,
    });
  }

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t('tray.shoot'), accelerator: s.hotkey, click: shoot },
      ...(status.length ? [{ type: 'separator' }, ...status] : []),
      { type: 'separator' },
      {
        label: t('tray.uploadFile'),
        click: async () => {
          const r = await dialog.showOpenDialog({
            properties: ['openFile', 'multiSelections'],
            title: t('tray.uploadDialogTitle'),
          });
          if (r.canceled) return;
          for (const f of r.filePaths) {
            await uploadAndDeliver(f, { source: path.basename(f) }).catch(() => {});
          }
        },
      },
      {
        label: t('tray.fromClipboard'),
        click: async () => {
          const img = clipboardImage();
          if (!img) return notify('puuush', t('tray.noImageInClipboard'));
          const f = path.join(store.shotsDir(), `clip-${Date.now()}.png`);
          fs.writeFileSync(f, img.toPNG());
          try {
            await uploadAndDeliver(f, { source: t('upload.fromClipboard') });
          } catch (e) {
            /* ссылка не вышла, но снимок пользователю ещё пригодится */
          } finally {
            if (!store.getSettings().keepLocalCopy) discard(f);
          }
        },
      },
      { type: 'separator' },
      { label: t('tray.history'), submenu: historyMenu() },
      { label: t('tray.settings'), click: openSettings },
      { type: 'separator' },
      { label: t('tray.quit'), click: () => app.quit() },
    ])
  );
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return settingsWin;
  }
  settingsWin = new BrowserWindow({
    width: 720,
    height: 700,
    title: t('tray.settingsTitle'),
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
  return settingsWin;
}

// ---------------------------------------------------------------------------
// Хоткей
// ---------------------------------------------------------------------------

function applyHotkey() {
  const { hotkey } = store.getSettings();
  globalShortcut.unregisterAll();

  // Хоткей без модификатора (просто «A» или «Enter») перехватывает клавишу у
  // всех приложений сразу. Такое легко записать в поле настроек и поверить в
  // это, поэтому отсекаем здесь, а не только в интерфейсе.
  if (!hasModifier(hotkey)) {
    notify('puuush', t('note.noModifier', { hotkey }));
    return false;
  }

  let ok = false;
  try {
    ok = globalShortcut.register(hotkey, shoot);
  } catch (e) {
    ok = false;
  }
  if (!ok) {
    // Не молчим: неработающий хоткей — это ровно то, из-за чего приходят потом.
    const win = openSettings();
    setTimeout(() => {
      win.webContents.send('puuush:progress', {
        state: 'error',
        message: t('note.hotkeyFailed', { hotkey }),
      });
    }, 800);
    notify('puuush', t('note.hotkeyTaken', { hotkey }));
  }
  buildTrayMenu();
  return ok;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (_e, arg) => {
      try {
        return await fn(_e, arg);
      } catch (err) {
        // Уведомляем и пробрасываем дальше, чтобы рендерер увидел отказ.
        // Раньше здесь возвращался null: проверка сервера показывала зелёный
        // ответ на любую ошибку, а сбой сохранения настроек выглядел как
        // успех и ломал окно до перезапуска.
        notify('puuush', String(err && err.message ? err.message : err));
        throw err;
      }
    });
  // Синхронный ответ: язык нужен окну до первой отрисовки.
  ipcMain.on('puuush:lang', (e) => { e.returnValue = getLang(); });
  handle('puuush:get-settings', () => store.getSettings());
  handle('puuush:broken-settings', () => store.brokenReason());
  handle('puuush:save-settings', (_e, patch) => {
    const next = store.setSettings(patch || {});
    // Язык поменяли: главный процесс переводит вслух, трей и меню должны
    // заговорить на нём же сразу, а не после перезапуска.
    if (next.lang !== getLang()) setLang(next.lang);
    // Файл снова читается и пишется, значит поломки больше нет: баннер в
    // окне и строка об ошибке в трее не должны жить вечно после первого же
    // сохранения. Функция была объявлена и нигде не вызывалась.
    store.clearBroken();
    // Если комбинацию держат другие, на диске лежит новая, а работает старая.
    // Окну обязательно нужно знать, что сохранённое значение не применено.
    const hotkeyApplied = applyHotkey();
    buildTrayMenu();
    return hotkeyApplied ? next : { ...next, hotkeyApplied: false };
  });
  handle('puuush:get-history', () => store.getHistory());
  handle('puuush:clear-history', () => {
    store.clearHistory();
    buildTrayMenu();
    return true;
  });
  // Подписи хостингов переводит окно: список один, а язык в нём может
  // отличаться от языка главного процесса в тот самый момент.
  handle('puuush:hosts', () => HOSTS.map((h) => ({ name: h.name, temp: h.temp })));
  handle('puuush:reapply-hotkey', () => applyHotkey());
  handle('puuush:verify-server', async (_e, cfg) => {
    // Берём то, что человек видит в полях прямо сейчас. Поля сохраняются по
    // уходу фокуса, поэтому клик по «Проверить» успевал проверить старый адрес.
    const own = (cfg && cfg.base_url !== undefined) ? cfg : (store.getSettings().own || {});
    if (!own.base_url || !own.write_key) {
      throw new Error(t('verify.notFilled'));
    }
    // Те же проверки, что и в настоящей загрузке. Без них кнопка показывала бы
    // зелёный ответ там, где загрузка упала бы с «Invalid character in header
    // content» или с требованием https.
    const why = upload.validateOwn(own);
    if (why) throw new Error(why);
    let res;
    try {
      res = await request(`${own.base_url.replace(/\/+$/, '')}/v1/ping`, {
        headers: { Authorization: 'Bearer ' + own.write_key },
        timeout: 10000,
      });
    } catch (e) {
      // Причины отказа переводим в человеческие: человеку нужно знать, что
      // делать, а не код сетевой ошибки.
      if (e.code === 'ENOTFOUND') throw new Error(t('verify.domainNotFound'));
      if (e.code === 'ECONNREFUSED') throw new Error(t('verify.noResponse'));
      if (e.code === 'CERT_HAS_EXPIRED') throw new Error(t('verify.certExpired'));
      throw new Error(t('verify.unreachable', { error: e.message }));
    }
    if (res.status === 401) throw new Error(t('verify.rejectedKey'));
    if (res.status !== 200) throw new Error(t('verify.status', { status: res.status }));

    // Любой 200 раньше считался успехом, включая HTML-заглушку прокси и
    // чужой ответ с {ok:false}. Требуем ровно наш протокол.
    let info;
    try {
      info = JSON.parse(res.body.toString('utf8'));
    } catch (e) {
      throw new Error(t('verify.notPuuush'));
    }
    if (!info || info.service !== 'puuush-server' || info.ok !== true) {
      throw new Error(t('verify.notPuuush'));
    }
    return info;
  });
  handle('puuush:choose-dir', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('puuush:upload-file', async (_e, p) => {
    if (!p) return null;
    return uploadAndDeliver(p, { source: path.basename(p) });
  });
  handle('puuush:upload-clipboard-image', async () => {
    // Тот же путь, что и пункт меню трея, но доступный из окна: продукт
    // обещает три равноправных способа, а в настройках были видны два.
    const img = clipboardImage();
    if (!img) throw new Error(t('upload.noImageInClipboard'));
    const file = path.join(store.shotsDir(), `clip-${Date.now()}.png`);
    fs.writeFileSync(file, img.toPNG());
    try {
      return await uploadAndDeliver(file, { source: t('upload.fromClipboard') });
    } catch (e) {
      discard(file);
      throw e;
    } finally {
      // То же правило, что и у снимка с хоткея: выключил «Хранить снимки» —
      // файл не остаётся, независимо от исхода.
      if (!store.getSettings().keepLocalCopy) discard(file);
    }
  });
  handle('puuush:close-self', () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
    return true;
  });
  handle('puuush:open-external', (_e, url) => {
    if (/^https?:\/\//.test(String(url))) shell.openExternal(url);
    return true;
  });
}

function ipcRegisterRemoved() {}

/**
 * Открывает окно скрытно и собирает ошибки renderer'а.
 * Ошибки в preload/разметке иначе видны только пользователю — в виде молча
 * неработающей кнопки, и диагностировать их приходится вслепую.
 */
function checkRenderer(file, checkExpr) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const errors = [];
    let done = false;

    const finish = (extra) => {
      if (done) return;
      done = true;
      if (!win.isDestroyed()) win.destroy();
      resolve(extra ? errors.concat([extra]) : errors);
    };

    // Electron <35 передаёт позиционные аргументы, >=35 — объект события.
    win.webContents.on('console-message', (...args) => {
      const ev = args[0];
      const modern = args.length === 1 && ev && typeof ev === 'object' && 'message' in ev;
      const level = modern ? ev.level : args[1];
      const msg = modern ? ev.message : args[2];
      const line = modern ? ev.lineNumber : args[3];
      const src = modern ? ev.sourceId : args[4];
      if (level >= 2) errors.push(`${msg} (${path.basename(src || '')}:${line})`);
    });
    win.webContents.on('preload-error', (_e, p, err) =>
      errors.push(`preload ${path.basename(p)}: ${err}`)
    );
    win.webContents.once('did-finish-load', () => {
      // Даём renderer'у отработать инициализацию, затем спрашиваем результат.
      // Промис прямо в executeJavaScript не проходит: ожидание уходит в
      // renderer и main-процесс теряет управление до его разрешения.
      setTimeout(async () => {
        let problem = '';
        try {
          problem = await win.webContents.executeJavaScript(checkExpr, true);
        } catch (e) {
          problem = t('selftest.checkFailed', { error: e.message });
        }
        finish(typeof problem === 'string' ? problem : '');
      }, 1500);
    });

    win.loadFile(path.join(__dirname, file)).catch((e) =>
      finish(t('selftest.fileNotLoaded', { error: e.message }))
    );
    setTimeout(() => finish(t('selftest.windowTimeout')), 10000);
  });
}

// ---------------------------------------------------------------------------
// Диагностика: puuush --selftest
//
// Прогоняет на себе всё, что нельзя проверить чтением кода: берёт экран,
// режет область, создаёт трей, занимает хоткей и заливает файл. Нужен на
// сервере без монитора и после обновления Electron.
// ---------------------------------------------------------------------------
/** Крошечный настоящий PNG 1x1: проверяем загрузку без настоящего снимка экрана. */
function png1px() {
  return Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd4' +
    '0000000049454e44ae426082',
    'hex'
  );
}

async function runSelfTest() {
  const rows = [];
  const step = (ok, name, note) => rows.push({ ok, name, note });
  const s = store.getSettings();
  setLang(s.lang);
  registerIpc(); // окно настроек ходит в IPC, без них оно не инициализируется

  try {
    const { grabDisplay, displayUnderCursor } = require('./capture');
    const display = displayUnderCursor();
    const { image, ratio } = await grabDisplay(display);
    const size = image.getSize();
    // Пишем и запрошенный масштаб, и фактическое отношение: расхождение между
    // ними — признак дробного масштабирования на Linux, и его полезно видеть.
    const wanted = (display.scaleFactor || 1);
    step(true, t('selftest.capture'),
      `${size.width}x${size.height} px, ` +
      t('selftest.frameNote', { ratio: ratio.x.toFixed(2) }) +
      (Math.abs(ratio.x - wanted) > 0.01
        ? t('selftest.scaleNote', { scale: wanted })
        : ''));

    const cut = image.crop({
      x: Math.round(size.width * 0.1),
      y: Math.round(size.height * 0.1),
      width: Math.max(1, Math.round(size.width * 0.25)),
      height: Math.max(1, Math.round(size.height * 0.25)),
    });
    // Режем кусок экрана, чтобы проверить сам механизм нарезки, но наружу
    // его не отправляем: selftest обычно запускают в cron, и настоящий снимок
    // экрана, улетающий на публичный хостинг по расписанию, это утечка, о
    // которой README не говорит ни слова.
    const file = path.join(store.shotsDir(), 'selftest.png');
    fs.writeFileSync(file, cut.toPNG());
    step(fs.statSync(file).size > 0, t('selftest.crop'),
      `${cut.getSize().width}x${cut.getSize().height} -> ${file}`);

    // Трея в системе может не быть вовсе. Падение трея считается ошибкой
    // намеренно: без трея приложением нечем управлять, и cron-проверка
    // должна показать это красным, а не тихо пройти.
    try {
      tray = new Tray(trayImage());
      buildTrayMenu();
      step(true, t('selftest.tray'),
        t('selftest.trayIcon', { state: trayImage().isEmpty() ? t('selftest.not') : '' }));
    } catch (e) {
      step(false, t('selftest.tray'), t('selftest.noTray', { error: e.message }));
    }

    const okHot = applyHotkey();
    step(okHot, t('selftest.hotkey'),
      okHot
        ? t('selftest.hotkeyOk', { hotkey: s.hotkey })
        : t('selftest.hotkeyFail', { hotkey: s.hotkey }));

    // Наружу уходит сгенерированная картинка 1x1, а не кусок экрана. Свой
    // сервер настроен не всегда, а откат на catbox с настоящим снимком экрана
    // внутри противоречит тому, ради чего приложение писалось.
    const probeFile = path.join(store.shotsDir(), 'selftest-upload.png');
    fs.writeFileSync(probeFile, png1px());
    try {
      const r = await publish(probeFile, { host: s.host, own: s.own, onStep: () => {} });
      step(true, t('selftest.upload'), `${r.url} (${hostLabel(r.host)})`);
    } finally {
      try { fs.unlinkSync(probeFile); } catch (e) { /* не мешает */ }
      try { fs.unlinkSync(file); } catch (e) { /* не мешает */ }
    }

    const setErr = await checkRenderer('renderer/settings.html', `
      (function () {
        var h = document.getElementById('hotkey');
        var sel = document.getElementById('host');
        if (!h || !sel) return ${JSON.stringify(t('selftest.noHotkeyOrHost'))};
        if (!h.value) return ${JSON.stringify(t('selftest.noHotkeyValue'))};
        if (sel.options.length < 4) return ${JSON.stringify(t('selftest.hostOptions', { count: '' }))} + sel.options.length;
        if (document.getElementById('ownBox').style.display === 'none')
          return ${JSON.stringify(t('selftest.ownBoxHidden', { mode: '' }))} + sel.value;
        return '';
      })()
    `);
    step(setErr.length === 0, t('selftest.settingsWindow'),
      setErr.length ? setErr.join(' | ') : t('selftest.loadsOk'));

    const ovErr = await checkRenderer('renderer/overlay.html',
      `typeof window.puuush.submitRegion === 'function' ? '' : ${JSON.stringify(t('selftest.noBridge'))}`);
    step(ovErr.length === 0, t('selftest.overlayWindow'),
      ovErr.length ? ovErr.join(' | ') : t('selftest.loadsOk'));
  } catch (e) {
    step(false, t('selftest.failure'), e.message);
  }

  const w = Math.max(...rows.map((r) => r.name.length));
  for (const r of rows) {
    process.stdout.write(
      `${r.ok ? '  OK  ' : ' FAIL '}  ${r.name.padEnd(w)}  ${r.note || ''}\n`
    );
  }
  const failed = rows.filter((r) => !r.ok).length;
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Запуск
// ---------------------------------------------------------------------------

const cliIdx = process.argv.indexOf('--cli');
const testIdx = process.argv.indexOf('--selftest');

// Приложение живёт в трее, поэтому закрытие последнего окна (настроек, выбора
// области, проверочного) не должно его убивать. Без этого обработчика Electron
// выходит сам, и вспомогательное окно не успевает отработать.
app.on('window-all-closed', () => {});
app.on('will-quit', () => {
  // Второй запуск приложения проходит через app.quit() до готовности, и
  // вызов globalShortcut на этом этапе бросает необработанное исключение:
  // «globalShortcut cannot be used before the app is ready». Воспроизведено
  // двойным запуском. Проверяем готовность перед обращением к API.
  if (app.isReady()) {
    try {
      globalShortcut.unregisterAll();
    } catch (e) {
      /* снимать нечего, если ничего не занимали */
    }
  }
});

// Фоновая утилита в трее: упасть из-за чужого обработчика хуже, чем пережить
// ошибку. Исключение из обработчика пункта меню приходит сюда при нативной
// диспетчеризации, и без этого перехвата приложение просто исчезает: иконки
// нет, окна нет, хоткей мёртв, и понять почему нельзя.
process.on('uncaughtException', (e) => {
  process.stderr.write(`uncaught exception: ${e && e.stack ? e.stack : e}\n`);
  try {
    noteError(t('note.internalError'));
    notify('puuush', t('note.failed', { error: e && e.message ? e.message : e }));
  } catch (ignored) {
    /* даже сообщить об ошибке не получилось, молча продолжаем жить */
  }
});

if (cliIdx !== -1 || testIdx !== -1) {
  // Служебные режимы не берут single-instance lock: иначе запуск из скрипта,
  // когда трей уже висит, молча вышел бы.
  //
  // Без дисплея Electron умирает на инициализации Ozone ещё до whenReady(),
  // и пользователь видит стек ошибок вместо внятного объяснения. Проверяем
  // сами и говорим человеческим языком, чем запускать в таком окружении.
  const headless = process.platform === 'linux' &&
    !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  if (headless && cliIdx !== -1) {
    process.stderr.write(t('cli.headless'));
    process.exit(2);
  }

  app.whenReady().then(() => {
    if (cliIdx !== -1) return runCli(process.argv.slice(cliIdx + 1));
    return runSelfTest();
  });
} else {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (tray) tray.popUpContextMenu();
    });

    app.whenReady().then(() => {
      registerIpc();

      // Настройки читаем первыми: ошибка появляется именно при чтении файла,
      // и запрос до него всегда давал пустоту.
      const s = store.getSettings();
      // Язык включаем до первой строки, которую человек прочитает: трей,
      // меню и уведомления.
      setLang(s.lang);
      const broken = store.brokenReason();
      if (broken) {
        noteError(broken);
        notify('puuush', t('note.brokenSettings', { reason: broken }));
      }

      // Приложение живёт в трее. Трея в системе может не быть, и тогда ни
      // значка, ни меню, ни способа выйти. В таком случае держим окно настроек
      // на экране.
      //
      // `new Tray()` без системного трея НЕ бросает исключение, он молча
      // создаёт объект, который ничего не показывает. Ориентироваться на
      // конструктор бессмысленно. На Linux иконка живёт через StatusNotifier
      // поверх сессионной шины DBus: нет адреса шины, нет и трея.
      //
      // Слепой случай остаётся: GNOME без расширения AppIndicator. Шина DBus
      // есть, трея нет, проверка скажет «есть». Приложение вытащит горячей
      // клавишей, но до настроек не добраться.
      const noTray = !trayAvailable();
      if (noTray) {
        app.dock?.show?.();
        const w = openSettings();
        w.setAlwaysOnTop(true);
      } else {
        tray = new Tray(trayImage());
        buildTrayMenu();
        app.dock?.hide?.();
      }

      applyHotkey();

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          if (tray) buildTrayMenu();
          else openSettings();
        }
      });
    });
  }
}
