'use strict';
/**
 * puuush — скриншот области, загрузка, ссылка в буфере.
 *
 * Приложение живёт в трее и не показывает главного окна: всё делается хоткеем
 * и меню. Окно настроек открывается отдельно и по умолчанию закрывается в трей.
 */

const path = require('node:path');
const { spawn } = require('node:child_process');
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
  screen,
  ipcMain,
} = require('electron');

const store = require('./store');
const { t, setLang, getLang } = require('./i18n');
const upload = require('./upload');
const { publish, HOSTS, request, MAX_VIDEO_UPLOAD } = upload;
const { captureTo, pickArea } = require('./capture');
const clip = require('./clipboard');
const { hasModifier } = require('./hotkey');
const { runCli } = require('./cli');
const { showToast } = require('./toast');
const { runSelfTest } = require('./selftest');
const { Recorder, canCaptureSystemAudio, registerRecorderIpc } = require('./recorder');
const { LocalServer } = require('./local-server');
const { RecordingChrome } = require('./recording-chrome');

const ASSETS = path.join(__dirname, '..', 'assets');
const APP_ID = 'com.blinov.puuush';

// Windows and notifications take the application name and identity from the
// process. Without these lines a development build shows up as Electron, even
// though every visible label already says puuush.
app.setName('puuush');
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

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
let galleryWin = null;
// IDs returned to the gallery resolve only to files discovered in its folder
// or history. The renderer never supplies an arbitrary filesystem path.
const galleryEntries = new Map();
let busy = false;

// Запись экрана. Живёт одна: две записи одновременно делили бы и звук, и
// файл, и человеку всё равно нужна одна.
//
// Два знака, а не один: recorder живёт и пока готовый файл уходит на
// сервер, а recording говорит, идёт ли запись сейчас. Хоткей должен
// останавливать запись, а не ждать конца загрузки.
let recorder = null;
let recording = false;
// Рамка и панель записи, пока она идёт.
let chrome = null;
let chromeTimer = null;
let trayBlink = null;
// Сколько файлов сейчас грузится: пока хоть один, иконка показывает работу.
let uploadsInFlight = 0;
// Запись на паузе: трей и панель должны показывать одно и то же.
let recordingPaused = false;
// Между нажатием хоткея и стартом идёт выбор области: второй хоткей в это
// время не должен считать, что запись уже идёт.
let recordingStarting = false;

// Локальная раздача свежих файлов: ссылка работает сразу, без ожидания
// загрузки на сервер.
let localServer = null;

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
  try {
    if (!Notification.isSupported()) return;
    new Notification({ title, body, silent: true }).show();
  } catch (e) {
    // Уведомление — вежливость, а не работа: его отказ не должен ломать
    // снимок или запись.
  }
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
  // Диалог может не открыться, если приложение уже закрывается: буфер и
  // уведомление к этому моменту своё дело сделали.
  Promise.resolve()
    .then(() =>
      dialog.showMessageBox({
        type: 'warning',
        message: t('clipboard.title'),
        detail: t('clipboard.detail', { url, why }),
        buttons: [t('clipboard.copy'), t('clipboard.close')],
        defaultId: 0,
        cancelId: 1,
      })
    )
    .catch(() => ({ response: 1 }))
    .then(async ({ response }) => {
      if (response !== 0) return;
      try {
        await clip.writeText(url);
      } catch (err) {
        /* второй отказ: ссылка уже на экране, её можно выделить руками */
      }
    });
  return false;
}

/**
 * Очереди загрузок.
 *
 * Две загрузки одновременно — это снимок во время записи встречи или
 * двойной клик по файлу. Раньше вторая просто отказывала с «предыдущая
 * загрузка ещё идёт», и ссылка на неё терялась. Теперь у снимков и записей
 * отдельные очереди: каждая рано или поздно получает свою ссылку, но
 * длинная запись не задерживает короткий снимок.
 */
let quickUploadChain = Promise.resolve();
let videoUploadChain = Promise.resolve();

/** Запись встречи не должна задерживать следующий снимок. */
function uploadLane(filePath) {
  return /\.(webm|mp4|mkv|mov|m4v|avi)$/i.test(filePath)
    ? videoUploadChain
    : quickUploadChain;
}

/**
 * Локальная ссылка на файл.
 *
 * Файл уже лежит на диске, и человек может открыть его прямо сейчас. Это
 * подстраховка к основной ссылке: если загрузка на сервер идёт долго или
 * сервер недоступен, короткая локальная ссылка всё равно работает.
 *
 * Возвращает null, если локальный сервер не поднят: тогда лишних слов нет.
 */
function localLink(filePath) {
  if (!localServer) return null;
  try {
    return localServer.add(filePath);
  } catch (e) {
    return null;
  }
}

function uploadAndDeliver(filePath, opts = {}) {
  // Снимки и записи идут в разных очередях. Иначе скриншот, снятый во время
  // загрузки часовой встречи, ждал бы сотни мегабайт и ссылка появлялась бы
  // через минуты — ровно то, чего горячая клавиша не должна делать.
  //
  // Внутри каждой очереди порядок сохраняется, а ошибка одной загрузки не
  // останавливает следующую. Две очереди — это не больше двух передач: своя
  // машина и облачные хостинги спокойно принимают их одновременно.
  const isVideo = /\.(webm|mp4|mkv|mov|m4v|avi)$/i.test(filePath);
  const task = uploadLane(filePath).then(() => doUploadAndDeliver(filePath, opts));
  const next = task.catch(() => {});
  if (isVideo) videoUploadChain = next;
  else quickUploadChain = next;
  return task;
}

async function doUploadAndDeliver(filePath, { source = t('ui.field.snapshot'), maxBytes = 0 } = {}) {
  let ownFailed = null;
  beginUpload();
  try {
    // Сначала читаем настройки, потом смотрим на ошибку. Порядок был наоборот,
    // и поломка, случившаяся уже после запуска, проходила мимо защиты: первый
    // запуск уходил на публичный хостинг, и только следующий был заблокирован.
    const s = store.getSettings();
    if (store.brokenReason()) {
      throw new Error(t('upload.settingsBroken'));
    }

    notify('puuush', t('note.uploading'));
    const r = await publish(filePath, {
      host: s.host,
      own: s.own,
      order: s.hostOrder,
      // Запись встречи весит сотни мегабайт, и потолок публичных хостингов
      // тут неприменим: свой сервер примет столько, сколько настроен.
      ...(maxBytes ? { maxBytes } : {}),
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
    // Локальная ссылка: файл уже на диске, и она работает прямо сейчас.
    // Если локальные копии не хранятся, файл скоро исчезнет, и ссылка будет
    // мёртвой: показывать её нельзя.
    const local = store.getSettings().keepLocalCopy ? localLink(filePath) : null;
    store.addHistory({
      url: r.url, host: r.host, temp: r.temp, file: filePath, source,
      expiresAt: r.expiresAt || null,
      localUrl: local ? local.url : null,
    });
    buildTrayMenu();
    // Лёгкое «лежит в буфере» вместо системного уведомления: его видно сразу.
    // Системное остаётся для случая, когда буфер занят и ссылку надо забрать.
    if (copied) showToast(t('toast.link'), r.url);
    else notify('puuush', `${t('note.linkReady', { source })}\n${r.url}`);
    broadcast('puuush:progress', {
      state: 'done',
      url: r.url,
      host: r.host,
      temp: r.temp,
      copied,
      privacyDowngraded: !!(ownFailed && r.host !== 'own'),
      localUrl: local ? local.url : null,
    });
    if (s.openAfterUpload) shell.openExternal(r.url);
    // Окно настроек читает copied и privacyDowngraded. Раньше наружу уходил
    // результат publish(), где этих полей нет, и окно писало «скопировано»
    // даже после системного диалога «буфер занят».
    return {
      url: r.url, host: r.host, temp: !!r.temp, size: r.size,
      copied, privacyDowngraded: !!(ownFailed && r.host !== 'own'),
      localUrl: local ? local.url : null,
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
    endUpload();
  }
}

/**
 * Иконка трея на время загрузки.
 *
 * Пока файл уходит на сервер, человек должен видеть, что работа идёт: у
 * записи встречи это минуты, и молчащая иконка читается как «ничего не
 * происходит». Запись при этом важнее: пока она идёт, иконка мигает красным.
 */
function beginUpload() {
  uploadsInFlight += 1;
  const alive = tray && !(typeof tray.isDestroyed === 'function' && tray.isDestroyed());
  if (alive && !recording && !trayBlink) tray.setImage(trayImage('busy'));
}

function endUpload() {
  uploadsInFlight = Math.max(0, uploadsInFlight - 1);
  if (uploadsInFlight) return;
  const alive = tray && !(typeof tray.isDestroyed === 'function' && tray.isDestroyed());
  if (alive && !recording && !trayBlink) tray.setImage(trayImage('idle'));
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    // Окно могло закрыться между getAllWindows и send: окно выбора живёт
    // секунды, и отправка в него — обычное дело. Без try/catch «Object has
    // been destroyed» уходило в необработанное исключение главного процесса.
    try {
      if (!w.isDestroyed() && w.webContents && !w.webContents.isDestroyed()) {
        w.webContents.send(channel, payload);
      }
    } catch (e) {
      /* окна уже нет, и отправлять в него некому */
    }
  }
}

/**
 * Снимок экрана -> область -> загрузка -> буфер. Режим 'image' ничего не
 * грузит и кладёт в буфер саму картинку: ссылки у него нет, истории тоже.
 */
async function shoot(mode = 'link') {
  // Человек выбрал в настройках, что делать со снимком. Основная горячая
  // клавиша ведёт себя так же, а вторая остаётся явным «картинку в буфер».
  if (mode === 'link' && store.getSettings().photoMode === 'clipboard') mode = 'image';
  if (busy) {
    // Занят только выбор области. Загрузка предыдущего снимка больше не
    // блокирует следующий: снимок встаёт в свою очередь, а окно выбора
    // можно открыть сразу.
    notify('puuush', t('note.shotStillPicking'));
    return;
  }
  busy = true;
  broadcast('puuush:progress', { state: 'capturing' });
  let shot = null;
  try {
    shot = await captureTo(store.shotsDir());
  } catch (e) {
    if (!(e && e.reported)) {
      const msg = String(e && e.message ? e.message : e);
      notify('puuush', t('note.shotFailed', { error: msg }));
      broadcast('puuush:progress', { state: 'error', message: msg });
    }
    return;
  } finally {
    // Флаг отпускается сразу после выбора области. Дальше снимок идёт на
    // сервер в фоне, иначе занятая сеть запирала бы саму возможность снять
    // следующий кадр.
    busy = false;
  }
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
      if (store.getSettings().keepLocalCopy) {
        try {
          store.addHistory({ file: shot.path, source: t('ui.field.snapshot'), host: 'disk' });
          buildTrayMenu();
        } catch (e) {
          /* запись снимка в буфер уже успешна; сбой индекса не должен её отменять */
        }
      }
      showToast(t('toast.image'), `${shot.width} × ${shot.height}`);
      broadcast('puuush:progress', { state: 'copied' });
    } else {
      await uploadAndDeliver(shot.path, { source: t('ui.field.snapshot') });
    }
  } catch (e) {
    if (!(e && e.reported)) {
      const msg = String(e && e.message ? e.message : e);
      notify('puuush', t('note.shotFailed', { error: msg }));
      broadcast('puuush:progress', { state: 'error', message: msg });
    }
  } finally {
    // Раньше копия удалялась только после успеха, и опция «хранить локальные
    // копии» обещала больше, чем делала. Теперь правило одно для обоих
    // случаев: выключена — удаляем всегда.
    if (!store.getSettings().keepLocalCopy) discard(shot.path);
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
// Запись экрана
// ---------------------------------------------------------------------------

/**
 * Запись встречи: экран, микрофон и, где умеем, системный звук.
 *
 * Запись идёт в файл, а не в буфер: файл переживает перезагрузку приложения
 * и кладётся в тот же каталог, что и снимки.
 */
async function startRecording() {
  if (recorder || recordingStarting) {
    notify('puuush', t('rec.alreadyRunning'));
    return { recording: true };
  }
  recordingStarting = true;
  const s = store.getSettings();
  const mine = new Recorder({
    dir: store.shotsDir(),
    onStep: (m) => broadcast('puuush:progress', { state: 'step', message: m }),
  });
  recorder = mine;
  recording = true;
  broadcast('puuush:progress', { state: 'recording' });
  // Меню трея показывает «остановить», а не «начать».
  buildTrayMenu();

  try {
    // Ждём только начала записи. Раньше здесь ждали её конца, и кнопка в
    // настройках оставалась занятой весь час, а второе нажатие хоткея не
    // могло остановить запись.
    const chosenScreen = s.recordScreen || (s.recordAllScreens === true ? 'all' : 'cursor');
    const area = s.recordArea || 'screen';
    // Область выбирается тем же окном, что и снимок: отдельного выбора для
    // записи человеку учить не нужно.
    let region = null;
    if (area === 'region') {
      region = await pickArea();
      if (!region) {
        // Esc в окне выбора: это отмена, а не ошибка.
        recordingStarting = false;
        if (recorder === mine) recorder = null;
        recording = false;
        stopChrome();
        stopTrayBlink();
        broadcast('puuush:progress', { state: 'idle' });
        buildTrayMenu();
        return { recording: false, cancelled: true };
      }
    }
    await mine.start({
      microphone: s.recordMicrophone !== false,
      systemAudio: s.recordSystemAudio !== false ? canCaptureSystemAudio() : false,
      maxSeconds: Number(s.recordMaxSeconds) || 0,
      allScreens: area === 'all' || chosenScreen === 'all',
      displayId: region
        ? region.displayId
        : (chosenScreen === 'cursor' || chosenScreen === 'all' ? null : chosenScreen),
      micGain: Number(s.recordMicGain) || 1,
      region: region ? region.rect : null,
      format: s.recordFormat === 'gif' ? 'gif' : 'video',
      fps: Number(s.recordFps) === 60 ? 60 : 30,
    });
  } catch (e) {
    const msg = String((e && e.message) || e);
    recordingStarting = false;
    if (recorder === mine) recorder = null;
    recording = false;
    noteError(t('rec.failed', { error: msg }));
    notify('puuush', t('rec.failed', { error: msg }));
    broadcast('puuush:progress', { state: 'error', message: msg });
    broadcast('puuush:progress', { state: 'idle' });
    buildTrayMenu();
    throw e;
  }

  recordingStarting = false;
  notify('puuush', t('rec.started'));
  // Рамка на записываемом экране и панель с таймером: иначе непонятно ни
  // что запись идёт, ни какой экран попал в кадр, ни как её остановить без
  // хоткея.
  startChrome(mine);
  startTrayBlink();

  // Кто держит обещание файла, тот его и загружает. Обещание одно:
  // остановка по хоткею и автоостановка по таймеру ведут к нему же, и
  // файл уходит на сервер ровно один раз.
  mine.whenDone()
    .then(async (r) => {
      if (!r) return;
      // Файл готов, запись больше не идёт: рамку, панель и мигание убираем
      // сразу. Ждать загрузки нельзя: встреча на гигабайт едет минутами, а
      // всё это время человек видел бы красную рамку вокруг экрана.
      if (recorder === mine) recorder = null;
      recording = false;
      recordingPaused = false;
      stopChrome();
      stopTrayBlink();
      broadcast('puuush:progress', { state: 'idle' });
      buildTrayMenu();
      await deliverRecording(r.path, s);
    })
    .catch((e) => {
      const msg = String((e && e.message) || e);
      noteError(t('rec.failed', { error: msg }));
      notify('puuush', t('rec.failed', { error: msg }));
    })
    .finally(() => {
      if (recorder === mine) recorder = null;
      recording = false;
      broadcast('puuush:progress', { state: 'idle' });
      buildTrayMenu();
    });

  return { recording: true };
}

/** Остановить запись. Файл забирает та же ветка, что и при автоостановке. */
async function stopRecording() {
  if (recordingStarting) return;
  if (!recording || !recorder) return;
  const mine = recorder;
  try {
    // Файл сохраняется и отдаётся дальше тем же обещанием, что и при
    // автоостановке по таймеру. Загрузка делается ровно один раз: тот, кто
    // ждёт обещание, и есть единственный загрузчик.
    await mine.stop();
  } catch (e) {
    const msg = String((e && e.message) || e);
    noteError(t('rec.failed', { error: msg }));
    notify('puuush', t('rec.failed', { error: msg }));
  } finally {
    // Запись закончилась: трей снова предлагает начать, а не остановить.
    // Файл всё ещё уходит на сервер в фоне, но это уже не запись, и
    // следующая запись не должна ждать чужую загрузку.
    if (recorder === mine) recorder = null;
    recording = false;
    recordingPaused = false;
    stopChrome();
    stopTrayBlink();
    buildTrayMenu();
  }
}

/**
 * Куда девать готовую запись.
 *
 * Настройка recordTarget говорит, что делать с файлом: загрузить и дать
 * ссылку, оставить файлом на диске или и то и другое. При 'disk' ссылки нет
 * вовсе, и человеку показывается путь: файл уже лежит в папке снимков.
 */
async function deliverRecording(filePath, s) {
  const mode = s.videoMode === 'disk' || s.videoMode === 'clipboard' ? s.videoMode : 'link';
  if (mode === 'disk' || mode === 'clipboard') {
    // Файл остаётся на диске: ссылки здесь нет вовсе.
    let copied = false;
    if (mode === 'clipboard') copied = await copyFileToClipboard(filePath);
    // Если файл в буфер положить не удалось (не Windows или система
    // отказала), копируем хотя бы путь: человек не останется без ничего.
    if (!copied) await deliverToClipboard(filePath);
    try {
      store.addHistory({ file: filePath, source: t('ui.field.recording'), host: 'disk' });
      buildTrayMenu();
    } catch (e) {
      /* запись уже сохранена; сбой индекса не должен её объявлять неудачной */
    }
    showToast(t('toast.recordSaved'), path.basename(filePath));
    notify('puuush', t('rec.savedToDisk', { file: filePath }));
    broadcast('puuush:progress', { state: 'done', file: filePath, host: 'disk', copied });
    buildTrayMenu();
    return null;
  }
  const res = await uploadAndDeliver(filePath, {
    source: t('ui.field.recording'),
    maxBytes: MAX_VIDEO_UPLOAD,
  });
  // Облако без локальной копии: запись встречи на гигабайт не должна лежать
  // на диске дважды, если человек не просил оставить копию.
  if (!s.keepLocalCopy) discard(filePath);
  return res;
}

/**
 * Положить файл в буфер обмена как файл, а не как текст.
 *
 * Electron так не умеет: clipboard.write() знает текст, картинку и разметку,
 * но не список файлов. В Windows это делает Set-Clipboard из PowerShell,
 * который запускается скрыто: окно консоли поверх встречи было бы хуже, чем
 * отсутствие функции.
 */
function copyFileToClipboard(filePath) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false);
    const quoted = String(filePath).split("'").join("''");
    try {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
          "Set-Clipboard -LiteralPath '" + quoted + "'"],
        { windowsHide: true }
      );
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    } catch (e) {
      resolve(false);
    }
  });
}

/** Рамка и панель записи: показать в начале и обновлять до конца. */
function startChrome(mine) {
  stopChrome();
  const displays = typeof mine.frameBounds === 'function'
    ? mine.frameBounds()
    : (typeof mine.recordedDisplays === 'function' ? mine.recordedDisplays().map((d) => d.bounds) : []);
  chrome = new RecordingChrome({
    lang: getLang(),
    onAction: (name) => {
      if (name === 'pause') pauseRecording();
      else if (name === 'resume') resumeRecording();
      else if (name === 'stop') stopRecording();
    },
  });
  chrome.show(displays.length ? displays : screen.getAllDisplays().slice(0, 1));
  chrome.update('recording', 0);
  chromeTimer = setInterval(() => {
    if (!chrome || !recorder) return;
    chrome.update(recordingPaused ? 'paused' : 'recording', recorder.elapsedMs());
  }, 1000);
}

function stopChrome() {
  if (chromeTimer) {
    clearInterval(chromeTimer);
    chromeTimer = null;
  }
  if (chrome) {
    chrome.hide();
    chrome = null;
  }
}

/** Иконка трея мигает, пока идёт запись. */
function startTrayBlink() {
  stopTrayBlink();
  if (!tray || (typeof tray.isDestroyed === 'function' && tray.isDestroyed())) return;
  let lit = true;
  tray.setImage(trayImage('recording'));
  trayBlink = setInterval(() => {
    if (!tray || (typeof tray.isDestroyed === 'function' && tray.isDestroyed())) return;
    lit = !lit;
    tray.setImage(trayImage(lit ? 'recording' : 'idle'));
  }, 700);
}

function stopTrayBlink() {
  if (trayBlink) {
    clearInterval(trayBlink);
    trayBlink = null;
  }
  if (tray && !(typeof tray.isDestroyed === 'function' && tray.isDestroyed())) {
    tray.setImage(trayImage(uploadsInFlight ? 'busy' : 'idle'));
  }
}

/** Пауза: запись открыта, но куски не пишутся и время не растёт. */
function pauseRecording() {
  if (!recorder || !recording || recordingPaused) return false;
  if (!recorder.pause()) return false;
  recordingPaused = true;
  if (chrome) chrome.update('paused', recorder.elapsedMs());
  broadcast('puuush:progress', { state: 'paused' });
  buildTrayMenu();
  return true;
}

function resumeRecording() {
  if (!recorder || !recording || !recordingPaused) return false;
  if (!recorder.resume()) return false;
  recordingPaused = false;
  if (chrome) chrome.update('recording', recorder.elapsedMs());
  broadcast('puuush:progress', { state: 'recording' });
  buildTrayMenu();
  return true;
}

// ---------------------------------------------------------------------------
// Трей
// ---------------------------------------------------------------------------

function trayImage(state = 'idle') {
  const mac = process.platform === 'darwin';
  const suffix = state === 'recording' ? '-rec' : state === 'busy' ? '-busy' : '';
  const file = mac ? 'trayTemplate' + suffix + '.png' : 'tray' + suffix + '.png';
  const p = path.join(ASSETS, file);
  if (fs.existsSync(p)) {
    const img = nativeImage.createFromPath(p);
    if (mac) img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createFromPath(path.join(ASSETS, 'icon.png'));
}

function historyMenu() {
  const items = store.getHistory().filter((item) => item.url).slice(0, 10);
  if (!items.length) return [{ label: t('tray.historyEmpty'), enabled: false }];
  const menu = items.map((h) => ({
    label: `${h.url.length > 58 ? h.url.slice(0, 58) + '…' : h.url}  (${h.host})`,
    toolTip: h.url,
    click: async () => {
      if (await deliverToClipboard(h.url, t('clipboard.what.history'))) {
        showToast(t('toast.link'), h.url);
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
  // Трей мог быть уничтожен системой (перезапуск оболочки, смена сессии).
  if (typeof tray.isDestroyed === 'function' && tray.isDestroyed()) {
    tray = null;
    return;
  }
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
      ...(recording
        ? [
            {
              label: recordingPaused ? t('tray.resumeRecord') : t('tray.pauseRecord'),
              click: () => (recordingPaused ? resumeRecording() : pauseRecording()),
            },
            { label: t('tray.stopRecord'), accelerator: s.recordHotkey, click: () => stopRecording() },
          ]
        : [{ label: t('tray.startRecord'), accelerator: s.recordHotkey, click: () => startRecording() }]),
      ...(status.length ? [{ type: 'separator' }, ...status] : []),
      { type: 'separator' },
      { label: t('tray.gallery'), click: openGallery },
      { label: t('tray.settings'), click: openSettings },
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
      { type: 'separator' },
      { label: t('tray.quit'), click: () => app.quit() },
    ])
  );
}

function startTray() {
  tray = new Tray(trayImage());
  // Левый клик по иконке раньше не делал ничего: меню открывалось только
  // правой кнопкой, и человек решал, что приложение зависло. В Windows у
  // трея нет отдельного левого меню, поэтому левый клик показывает то же.
  tray.on('click', () => {
    if (tray && !(typeof tray.isDestroyed === 'function' && tray.isDestroyed())) tray.popUpContextMenu();
  });
  buildTrayMenu();
}

/** Pick a Vite output page, never its source HTML with unresolved modules. */
function builtRendererPage(name) {
  const candidates = [
    path.join(__dirname, 'renderer', name),
    path.join(__dirname, 'src', 'renderer', name),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.readFileSync(candidate, 'utf8').includes('./assets/')) return candidate;
    } catch (e) {
      /* try the other app layout */
    }
  }
  return null;
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return settingsWin;
  }
  const page = builtRendererPage('settings.html');
  if (!page) throw new Error(t('ui.rendererNotBuilt'));
  const win = new BrowserWindow({
    width: 760,
    height: 760,
    minWidth: 620,
    minHeight: 520,
    title: t('tray.settingsTitle'),
    icon: path.join(ASSETS, 'icon.ico'),
    autoHideMenuBar: true,
    roundedCorners: true,
    thickFrame: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin = win;
  // У окна настроек нет меню Electron: команды приложения остаются в трее.
  win.setMenu(null);
  win.setMenuBarVisibility(false);
  // Файл, брошенный мимо зоны загрузки, иначе уводит окно на этот файл, и
  // интерфейс пропадает до перезапуска.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile(page);
  win.on('closed', () => {
    if (settingsWin === win) settingsWin = null;
  });
  return win;
}

/** Открывает историю файлов отдельным окном по запросу, не создавая main window. */
function openGallery() {
  if (galleryWin && !galleryWin.isDestroyed()) {
    galleryWin.show();
    galleryWin.focus();
    return galleryWin;
  }
  const page = builtRendererPage('gallery.html');
  if (!page) throw new Error(t('ui.rendererNotBuilt'));
  const win = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 700,
    minHeight: 520,
    title: `puuush — ${t('ui.gallery.title')}`,
    icon: path.join(ASSETS, 'icon.ico'),
    autoHideMenuBar: true,
    roundedCorners: true,
    thickFrame: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  galleryWin = win;
  win.setMenu(null);
  win.setMenuBarVisibility(false);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile(page);
  win.on('closed', () => {
    if (galleryWin === win) galleryWin = null;
  });
  return win;
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
  const { hotkey, imageHotkey, recordHotkey } = store.getSettings();
  globalShortcut.unregisterAll();
  const applied = {
    hotkey: takeHotkey(hotkey, () => shoot('link')),
    imageHotkey: takeHotkey(imageHotkey, () => shoot('image')),
    recordHotkey: takeHotkey(recordHotkey, () => {
      // Тот же хоткей и начинает, и заканчивает: человек не должен искать
      // вторую комбинацию, чтобы остановить запись.
      if (recording) stopRecording();
      else startRecording();
    }),
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
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return await fn(_e, ...args);
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
    // Три комбинации на одну клавишу не займутся. Проверка живёт в store,
    // потому что настройки пишутся ещё и из командной строки, и правило
    // должно быть одно.
    const keys = ['hotkey', 'imageHotkey', 'recordHotkey'];
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
    for (const k of keys) {
      if (!applied[k] && patch && patch[k] !== undefined && patch[k] !== before[k]) back[k] = before[k];
    }
    if (Object.keys(back).length) {
      next = store.setSettings(back);
      const again = applyHotkeys();
      applied = {};
      for (const k of keys) {
        // Откат означает, что новую комбинацию занять не вышло. Человеку
        // надо сказать об этом, а не «всё хорошо»: в поле стоит прежняя
        // комбинация, и без сообщения он подумает, что задал новую.
        applied[k] = back[k] === undefined ? !!again[k] : false;
      }
    }
    applyLogin(next);
    return {
      ...next,
      hotkeyApplied: applied.hotkey,
      imageHotkeyApplied: applied.imageHotkey,
      recordHotkeyApplied: applied.recordHotkey,
    };
  });
  handle('puuush:get-history', () => store.getHistory());
  handle('puuush:show-gallery', () => { openGallery(); return true; });
  const galleryId = (entry) => `${entry.at || 0}|${entry.url || ''}|${entry.file || ''}`;
  handle('puuush:get-gallery', () => {
    galleryEntries.clear();
    const history = store.getHistory().filter((entry) => entry && typeof entry === 'object');
    const byFile = new Map();
    for (const entry of history) {
      if (typeof entry.file !== 'string' || !entry.file) continue;
      const key = path.resolve(entry.file);
      if (!byFile.has(key)) byFile.set(key, entry);
    }

    const localFiles = [];
    try {
      for (const name of fs.readdirSync(store.shotsDir())) {
        const file = path.join(store.shotsDir(), name);
        const ext = path.extname(name).toLowerCase();
        if (!['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.webm', '.mp4', '.mov', '.mkv', '.m4v', '.avi'].includes(ext)) continue;
        try {
          const stat = fs.statSync(file);
          if (stat.isFile()) localFiles.push({ file, at: stat.mtimeMs });
        } catch (e) {
          /* файл мог уйти во время обновления галереи */
        }
      }
    } catch (e) {
      /* история ссылок всё ещё доступна, даже если папка снимков недоступна */
    }
    localFiles.sort((a, b) => b.at - a.at);

    const entries = [];
    const seenFiles = new Set();
    const addEntry = (entry, file, fallbackAt = 0) => {
      const resolved = file ? path.resolve(file) : '';
      const ext = path.extname(file || '').toLowerCase();
      const image = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'].includes(ext);
      const video = ['.webm', '.mp4', '.mov', '.mkv', '.m4v', '.avi'].includes(ext);
      const exists = !!resolved && fs.existsSync(resolved);
      const id = entry ? galleryId(entry) : `local:${Math.round(fallbackAt)}:${resolved}`;
      let thumbnail = '';
      if (exists && image && ext !== '.gif') {
        try {
          const preview = nativeImage.createFromPath(resolved);
          if (!preview.isEmpty()) thumbnail = preview.resize({ width: 480, height: 320, quality: 'good' }).toJPEG(78).toString('base64');
        } catch (e) {
          /* картинка остаётся доступна через файл или ссылку */
        }
      }
      galleryEntries.set(id, { entry, file: resolved, inHistory: !!entry });
      entries.push({
        id,
        at: entry && entry.at ? entry.at : fallbackAt,
        name: resolved ? path.basename(resolved) : (entry.source || entry.url || ''),
        kind: image ? (ext === '.gif' ? 'gif' : 'image') : video ? 'video' : 'file',
        url: entry && typeof entry.url === 'string' ? entry.url : '',
        file: resolved,
        exists,
        thumbnail,
        mediaUrl: '',
        host: entry && typeof entry.host === 'string' ? entry.host : '',
      });
      if (resolved) seenFiles.add(resolved);
    };

    for (const local of localFiles.slice(0, 50)) {
      const resolved = path.resolve(local.file);
      addEntry(byFile.get(resolved) || null, resolved, local.at);
    }
    for (const entry of history) {
      const file = typeof entry.file === 'string' ? path.resolve(entry.file) : '';
      if (file && seenFiles.has(file)) continue;
      addEntry(entry, file, entry.at || 0);
    }

    entries.sort((a, b) => b.at - a.at);
    const recent = entries.slice(0, 50);
    if (localServer) {
      for (const item of recent) {
        if (!item.exists || (item.kind !== 'video' && item.kind !== 'gif')) continue;
        const media = localServer.add(item.file);
        if (media) item.mediaUrl = media.url;
      }
    }
    return recent;
  });
  handle('puuush:gallery-action', async (event, id, action) => {
    const indexed = galleryEntries.get(String(id));
    if (!indexed) return { ok: false, reason: 'missing' };
    const entry = indexed.entry || {};
    const file = indexed.file && fs.existsSync(indexed.file) ? indexed.file : '';
    if (action === 'copy-link' && /^https?:\/\//.test(String(entry.url || ''))) {
      const copied = await deliverToClipboard(entry.url);
      return copied ? { ok: true } : { ok: false, reason: 'clipboard' };
    }
    if (action === 'open-link' && /^https?:\/\//.test(String(entry.url || ''))) {
      await shell.openExternal(entry.url);
      return { ok: true };
    }
    if (action === 'open-file' && file) {
      const reason = await shell.openPath(file);
      if (reason) throw new Error(reason);
      return { ok: true };
    }
    if (action === 'show-file' && file) {
      shell.showItemInFolder(file);
      return { ok: true };
    }
    if (action === 'copy-file' && file) {
      const ext = path.extname(file).toLowerCase();
      if (['.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(ext)) {
        const image = nativeImage.createFromPath(file);
        if (!image.isEmpty()) {
          if (await clip.writeImage(image.toPNG())) return { ok: true };
        }
      }
      if (await copyFileToClipboard(file)) return { ok: true };
      const copied = await deliverToClipboard(file);
      return copied ? { ok: true } : { ok: false, reason: 'clipboard' };
    }
    if (action === 'save-copy' && file) {
      const parent = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showSaveDialog(parent, { defaultPath: path.basename(file) });
      if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
      if (path.resolve(result.filePath) === path.resolve(file)) return { ok: false, reason: 'same-folder' };
      await fs.promises.copyFile(file, result.filePath);
      return { ok: true, path: result.filePath };
    }
    if (action === 'move-file' && file) {
      const parent = BrowserWindow.fromWebContents(event.sender);
      const choice = await dialog.showOpenDialog(parent, {
        properties: ['openDirectory', 'createDirectory'],
        title: t('ui.gallery.moveTitle'),
      });
      if (choice.canceled || !choice.filePaths[0]) return { ok: false, cancelled: true };
      const destinationDir = choice.filePaths[0];
      if (path.resolve(destinationDir) === path.dirname(path.resolve(file))) {
        return { ok: false, reason: 'same-folder' };
      }
      const base = path.basename(file);
      const ext = path.extname(base);
      const stem = base.slice(0, base.length - ext.length);
      let destination = path.join(destinationDir, base);
      for (let suffix = 2; fs.existsSync(destination); suffix += 1) {
        destination = path.join(destinationDir, `${stem} (${suffix})${ext}`);
      }
      await fs.promises.copyFile(file, destination);
      if (indexed.inHistory) {
        const local = entry.localUrl ? localLink(destination) : null;
        try {
          if (!store.updateHistoryEntry(id, {
            file: destination,
            localUrl: local ? local.url : null,
          })) throw new Error(t('ui.gallery.unavailable'));
        } catch (e) {
          try { await fs.promises.unlink(destination); } catch (ignored) { /* сохранить обе копии безопаснее */ }
          throw e;
        }
      }
      try {
        await fs.promises.unlink(file);
        return { ok: true, path: destination };
      } catch (e) {
        return { ok: true, path: destination, sourceRemains: true };
      }
    }
    return { ok: false, reason: 'unavailable' };
  });
  handle('puuush:clear-history', () => {
    store.clearHistory();
    buildTrayMenu();
    return true;
  });
  // Подписи хостингов переводит окно: список один, а язык в нём может
  // отличаться от языка главного процесса в тот самый момент.
  handle('puuush:hosts', () => HOSTS.map((h) => ({ name: h.name, temp: h.temp, max: h.max })));
  // Список экранов для окна настроек. Идентификатор строкой: IPC не обязан
  // сохранять тип, а сравнение с Electron всё равно идёт по String(id).
  handle('puuush:displays', () => {
    const primary = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d, i) => ({
      id: String(d.id),
      name: d.label || '',
      width: d.size.width,
      height: d.size.height,
      scaleFactor: d.scaleFactor || 1,
      primary: d.id === primary,
      index: i + 1,
    }));
  });
  // Проверка скорости: меряет загрузку с этой машины и сохраняет порядок.
  // Из разных регионов быстрее оказываются разные хостинги, и угадать это
  // заранее нельзя.
  handle('puuush:test-hosts', async () => {
    const s = store.getSettings();
    broadcast('puuush:progress', { state: 'step', message: t('speed.testing') });
    const results = await upload.speedTest({ own: s.own, order: s.hostOrder });
    const fast = results
      .filter((r) => r.ok && r.name !== 'own')
      .sort((a, b) => a.ms - b.ms)
      .map((r) => r.name);
    if (fast.length) {
      try {
        store.setSettings({ hostOrder: fast });
      } catch (e) {
        /* порядок — подсказка, а не обязательство: отказ не ломает проверку */
      }
    }
    // В окне быстрые должны быть сверху: человек выбирает глазами.
    const shown = results.slice().sort((a, b) => {
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      return a.ms - b.ms;
    });
    return { results: shown, order: fast };
  });
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
  // --- запись экрана ---
  // Каналы страницы записи: разметка, куски файла, команды. Вынесены в
  // recorder.js, потому что относятся к записи, а не к окну настроек.
  registerRecorderIpc(() => recorder, { t, ipcMain });
  handle('puuush:start-recording', () => startRecording());
  handle('puuush:stop-recording', () => stopRecording());
  handle('puuush:pause-recording', () => pauseRecording());
  handle('puuush:resume-recording', () => resumeRecording());

  handle('puuush:recording-state', () => ({
    recording,
    systemAudio: canCaptureSystemAudio(),
  }));
  // Локальная ссылка на последний файл: работает, пока открыто приложение.
  handle('puuush:last-local', () => {
    const last = store.getHistory()[0];
    return (last && last.localUrl) || null;
  });
  handle('puuush:close-self', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.close();
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

// Наружу — только для проверок: окно настроек и трей. Приложение от этого
// ничего не получает, но проверка может открыть окно само и убедиться, что
// оно не уходит на брошенный файл.
module.exports = { openSettings, startTray, applyHotkeys, runtimeState };

/**
 * Что происходит с записью: для проверок и для самодиагностики.
 *
 * Наружу отдаётся только чтение: ни один вызов отсюда ничего не меняет.
 */
function runtimeState() {
  return {
    recording,
    paused: recordingPaused,
    trayBlinking: Boolean(trayBlink),
    chromeWindows: chrome ? chrome.frames.length + (chrome.panel ? 1 : 0) : 0,
  };
}

const cliIdx = process.argv.indexOf('--cli');
const testIdx = process.argv.indexOf('--selftest');

// Приложение живёт в трее, поэтому закрытие последнего окна (настроек, выбора
// области, проверочного) не должно его убивать. Без этого обработчика Electron
// выходит сам, и вспомогательное окно не успевает отработать.
app.on('window-all-closed', () => {});

// Выход во время записи сначала сохраняет файл.
//
// Окно записи живёт до закрытия приложения. Если позволить ему исчезнуть
// молча, обработчик закрытия считает запись сорванной и удалит недописанный
// WebM. Пользователь нажал «выйти», а не «выбросить встречу», поэтому
// остановка идёт тем же путём, что и по хоткею.
let quittingAfterRecording = false;
let stoppingForQuit = false;
app.on('before-quit', (event) => {
  if (quittingAfterRecording) return;
  if (!recording || !recorder) return;
  event.preventDefault();
  if (stoppingForQuit) return;
  stoppingForQuit = true;
  stopRecording()
    .catch(() => {})
    .finally(() => {
      quittingAfterRecording = true;
      app.quit();
    });
});

app.on('will-quit', () => {
  stopChrome();
  stopTrayBlink();
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
  // Локальная раздача держит сокет и файлы: закрываем её явно, иначе порт
  // остаётся занятым до конца процесса, а карта файлов — в памяти.
  if (localServer) {
    localServer.close().catch(() => {});
    localServer = null;
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

// Отклонённое обещание без обработчика Electron показывает тем же модальным
// окном «A JavaScript error occurred in the main process». Приложение в трее
// не должно выкидывать такое окно поверх чужой работы из-за закрывшегося
// окна выбора: пишем причину в лог и говорим об ошибке в трее.
process.on('unhandledRejection', (e) => {
  process.stderr.write(`unhandled rejection: ${e && e.stack ? e.stack : e}\n`);
  try {
    noteError(t('note.internalError'));
  } catch (ignored) {
    /* трей мог быть уже уничтожен */
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

    app.whenReady().then(async () => {
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

      // Локальная раздача поднимается всегда: она ничего не стоит и даёт
      // ссылку, которая работает сразу, даже если сервер недоступен.
      try {
        localServer = new LocalServer({ dir: store.shotsDir() });
        await localServer.listen();
      } catch (e) {
        localServer = null;
        noteError(t('local.failed', { error: e.message }));
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
