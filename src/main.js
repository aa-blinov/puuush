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
  shell,
  dialog,
  BrowserWindow,
  nativeImage,
  ipcMain,
} = require('electron');

const store = require('./store');
const { t, setLang, getLang } = require('./i18n');
const upload = require('./upload');
const { publish, HOSTS, request } = upload;
const { captureTo } = require('./capture');
const clip = require('./clipboard');
const { hasModifier } = require('./hotkey');
const { runCli } = require('./cli');
const { runSelfTest } = require('./selftest');

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
function trayAvailable() {
  if (process.platform !== 'linux') return true;
  return !!(process.env.DBUS_SESSION_BUS_ADDRESS && process.env.XDG_CURRENT_DESKTOP);
}

let settingsWin = null;
let busy = false;
let stage = 'capture'; // 'capture' или 'upload': для честного сообщения

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
async function deliverToClipboard(url, what = t('clipboard.what.link')) {
  let why = '';
  try {
    if (!(await clip.writeText(url))) why = t('clipboard.reason.accepted');
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
  }).then(async ({ response }) => {
    if (response === 0) {
      try {
        await clip.writeText(url);
      } catch (err) {
        /* второй отказ: ссылка уже на экране, её можно выделить руками */
      }
    }
  });
  return false;
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
      // Сбой своего сервера главный процесс узнаёт из результата publish(),
      // а не из текста шага: текст переводится, и совпадение перестало бы
      // работать. Здесь шаг только показывается человеку.
      onStep: (m) => broadcast('puuush:progress', { state: 'step', message: m }),
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

    const copied = await deliverToClipboard(r.url);
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
    broadcast('puuush:progress', { state: 'error', message: e.message });
    // Человек уже получил это сообщение: вызывающий, у которого свой
    // уведомитель (снимок по хоткею), не должен показывать его второй раз.
    e.reported = true;
    throw e;
  } finally {
    uploading = false;
  }
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

/**
 * Снимок экрана -> область -> загрузка -> буфер. Режим 'image' ничего не
 * грузит и кладёт в буфер саму картинку: ссылки у него нет, истории тоже.
 */
async function shoot(mode = 'link') {
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
      if (mode === 'image') {
        if (!(await clip.writeImage(fs.readFileSync(shot.path)))) {
          throw new Error(t('clipboard.imageRefused'));
        }
        notify('puuush', t('note.imageInClipboard'));
        broadcast('puuush:progress', { state: 'copied' });
      } else {
        await uploadAndDeliver(shot.path, { source: t('ui.field.snapshot') });
      }
    } finally {
      // Раньше копия удалялась только после успеха, и опция «хранить локальные
      // копии» обещала больше, чем делала. Теперь правило одно для обоих
      // случаев: выключена — удаляем всегда.
      if (!store.getSettings().keepLocalCopy) discard(shot.path);
    }
  } catch (e) {
    if (e && e.reported) return;
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
    click: async () => {
      if (await deliverToClipboard(h.url, t('clipboard.what.history'))) {
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
      { label: t('tray.shoot'), accelerator: s.hotkey, click: () => shoot('link') },
      { label: t('tray.shootImage'), accelerator: s.imageHotkey, click: () => shoot('image') },
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
          const img = await clip.readImage();
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

function startTray() {
  tray = new Tray(trayImage());
  buildTrayMenu();
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
  // Файл, брошенный мимо зоны загрузки, иначе уводит окно на этот файл, и
  // интерфейс пропадает до перезапуска.
  settingsWin.webContents.on('will-navigate', (e) => e.preventDefault());
  settingsWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
  return settingsWin;
}

// ---------------------------------------------------------------------------
// Хоткей
// ---------------------------------------------------------------------------

/** Автозапуск есть только в macOS и Windows; на Linux вызов Electron молчит. */
function applyLogin(s) {
  app.setLoginItemSettings({ openAtLogin: !!s.launchAtLogin });
}

/**
 * Занимает обе комбинации: со ссылкой и с одной картинкой. Возвращает, какая
 * из них заняла клавишу, чтобы окно настроек не показывало новую комбинацию
 * как работающую.
 */
function applyHotkeys() {
  const { hotkey, imageHotkey } = store.getSettings();
  globalShortcut.unregisterAll();
  const applied = {
    hotkey: takeHotkey(hotkey, () => shoot('link')),
    imageHotkey: takeHotkey(imageHotkey, () => shoot('image')),
  };
  buildTrayMenu();
  return applied;
}

/** Занимает одну комбинацию. Отказ не молчит: о нём знают окно и уведомление. */
function takeHotkey(hotkey, onPress) {
  // Хоткей без модификатора (просто «A» или «Enter») перехватывает клавишу у
  // всех приложений сразу. Такое легко записать в поле настроек и поверить в
  // это, поэтому отсекаем здесь, а не только в интерфейсе.
  if (!hasModifier(hotkey)) {
    notify('puuush', t('note.noModifier', { hotkey }));
    return false;
  }

  let ok = false;
  try {
    ok = globalShortcut.register(hotkey, onPress);
  } catch (e) {
    ok = false;
  }
  if (!ok) {
    // Не молчим: неработающий хоткей — это ровно то, из-за чего приходят потом.
    // Окно настроек сюда не открываем: приложение без главного окна не должно
    // выскакивать на экран само. Причина видна в трее, в уведомлении и в
    // открытом окне, если оно уже есть.
    noteError(t('note.hotkeyFailed', { hotkey }));
    notify('puuush', t('note.hotkeyTaken', { hotkey }));
    broadcast('puuush:progress', { state: 'error', message: t('note.hotkeyFailed', { hotkey }) });
  }
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
    // Две комбинации на одну клавишу не займутся обе. Отказ второй выглядел бы
    // как «занято другим приложением», хотя занято собой: отсекаем на входе.
    const merged = { ...store.getSettings(), ...(patch || {}) };
    if (merged.hotkey === merged.imageHotkey) throw new Error(t('note.sameHotkeys'));
    const before = store.getSettings();
    let next = store.setSettings(patch || {});
    // Язык поменяли: главный процесс переводит вслух, трей и меню должны
    // заговорить на нём же сразу, а не после перезапуска.
    if (next.lang !== getLang()) setLang(next.lang);
    // Файл снова читается и пишется, значит поломки больше нет: баннер в
    // окне и строка об ошибке в трее не должны жить вечно после первого же
    // сохранения. Функция была объявлена и нигде не вызывалась.
    store.clearBroken();
    // Если комбинацию держат другие, на диске лежит новая, а работает старая.
    // Окну обязательно нужно знать, что сохранённое значение не применено.
    let applied = applyHotkeys();
    // applyHotkeys снимает ВСЕ комбинации перед занятием, поэтому отказ новой
    // оставлял без хоткея и прежнюю рабочую. Откатываем на диске только то, что
    // занять не вышло, и занимаем прежнюю заново.
    const back = {};
    for (const k of ['hotkey', 'imageHotkey']) {
      if (!applied[k] && patch && patch[k] !== undefined && patch[k] !== before[k]) back[k] = before[k];
    }
    if (Object.keys(back).length) {
      next = store.setSettings(back);
      const again = applyHotkeys();
      applied = {
        hotkey: back.hotkey === undefined && again.hotkey,
        imageHotkey: back.imageHotkey === undefined && again.imageHotkey,
      };
    }
    applyLogin(next);
    return { ...next, hotkeyApplied: applied.hotkey, imageHotkeyApplied: applied.imageHotkey };
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
  handle('puuush:reapply-hotkey', () => applyHotkeys());
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
    const img = await clip.readImage();
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
    return runSelfTest({ registerIpc, startTray, trayImage, applyHotkeys, hostLabel });
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
        startTray();
        app.dock?.hide?.();
      }

      applyHotkeys();
      applyLogin(s);

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          if (tray) buildTrayMenu();
          else openSettings();
        }
      });
    });
  }
}
