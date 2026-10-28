 'use strict';
/**
 * Запись экрана со звуком.
 *
 * Записывается не картинка и не звук по отдельности, а готовый файл: WebM с
 * дорожкой видео и дорожкой звука. Оба потока берутся в одном невидимом окне,
 * которое живёт всё время записи.
 *
 * Почему окно, а не съёмка кадра за кадром:
 * - MediaRecorder в Chromium кодирует видео аппаратно, и запись идёт сама,
 *   пока приложение не смотрит на кадры;
 * - звук микрофона и системный звук попадают в тот же поток, и синхронизация
 *   делается браузером, а не нашей склейкой;
 * - окно невидимо и не ворует фокус: запись встречи не должна отвлекать.
 *
 * Системный звук берётся только на Windows: там Chromium умеет отдавать
 * loopback-устройство вывода. На других системах доступен только микрофон,
 * и это сказано человеку, а не спрятано.
 */

const path = require('node:path');
const fs = require('node:fs');
const { BrowserWindow, screen } = require('electron');
const { t } = require('./i18n');

/** Можно ли на этой системе записать системный звук. */
function canCaptureSystemAudio() {
  return process.platform === 'win32';
}

/**
 * Раскладка экранов: один большой холст и место каждого экрана на нём.
 *
 * Холст размером с объединение экранов: два монитора рядом дают картинку
 * 3840x1080, и человек видит ровно то, что было на столе.
 */
function layoutFor(displays) {
  const minX = Math.min(...displays.map((d) => d.bounds.x));
  const minY = Math.min(...displays.map((d) => d.bounds.y));
  const maxX = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width));
  const maxY = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height));
  const items = displays.map((d) => ({
    id: d.id,
    left: d.bounds.x - minX,
    top: d.bounds.y - minY,
    width: d.bounds.width,
    height: d.bounds.height,
    scale: d.scaleFactor || 1,
  }));
  return {
    canvas: { width: maxX - minX, height: maxY - minY },
    displays: items,
  };
}

/**
 * Запись идёт, пока открыто окно: окно и есть источник потоков.
 *
 * Потоки раздаются по порядку экранов: первый запрос getDisplayMedia получает
 * первый экран, и так далее. Порядок важен, иначе звук и картинка разъедутся
 * по экранам.
 */
class Recorder {
  constructor({ dir, onStep = () => {} } = {}) {
    this.dir = dir;
    this.onStep = onStep;
    this.win = null;
    this.file = null;
    this.stream = null;
    this.state = 'idle'; // idle | starting | recording | paused | stopping
    // Учёт времени: пауза не должна попадать в длительность записи.
    this.startedAt = 0;
    this.pausedAt = 0;
    this.pausedTotal = 0;
    this.displays = [];
    this.region = null;
    this.sources = [];
    this.nextSource = 0;
    this.audioInfo = null;
    // Куски пишутся в файл по мере поступления, а не копятся в памяти:
    // запись встречи на час — это сотни мегабайт, и держать их в RAM
    // означало бы уронить машину.
    this.out = null;
    this.written = 0;
    this.flush = Promise.resolve();
    this.stopTimer = null;
    this.resolveDone = null;
    // Отдельные обещания: одно говорит «запись действительно началась»,
    // другое — «файл готов». Прежде они были одним, и вызов, начавший
    // запись, ждал её конца: кнопка в настройках висела занятой весь час.
    this.ready = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.done = null;
  }

  /** Экраны, которые записываем, и где каждый из них лежит. */
  layout(displays = screen.getAllDisplays()) {
    return layoutFor(displays);
  }

  /** Экраны, которые попадут в запись. */
  displaysFor(allScreens, displayId = null) {
    if (allScreens) return screen.getAllDisplays();
    if (displayId != null && displayId !== '') {
      const chosen = screen.getAllDisplays().find((d) => String(d.id) === String(displayId));
      if (chosen) return [chosen];
    }
    // Если конкретный экран не выбран, пишется тот, на котором человек
    // работает: запись встречи — это одно окно, а не три монитора в ряд.
    // Склеенные три монитора дают холст в 5760 точек, кодировать его дорого,
    // а текст на нём всё равно нечитаем.
    return [screen.getDisplayNearestPoint(screen.getCursorScreenPoint())];
  }

  /** Экраны, которые попали в запись: по ним рисуется рамка. */
  recordedDisplays() {
    return Array.isArray(this.displays) ? this.displays.slice() : [];
  }

  /** Прямоугольники рамки в координатах экрана: экран или выбранная область. */
  frameBounds() {
    const region = this.region;
    return (this.displays || []).map((d) => (region
      ? {
        x: Math.round(d.bounds.x + region.x),
        y: Math.round(d.bounds.y + region.y),
        width: Math.max(48, Math.round(region.width)),
        height: Math.max(48, Math.round(region.height)),
      }
      : { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height }));
  }

  /** То, что страница записи спрашивает перед началом. */
  describe() {
    // Раскладка берётся та же, что посчитана при старте: если экраны
    // поменялись между стартом и запросом страницы, картинка и звук
    // разъехались бы по разным мониторам.
    return {
      layout: this.config ? this.config.layout : this.layout(),
      microphone: this.config ? this.config.microphone : true,
      micGain: this.config ? this.config.micGain : 1,
      format: this.config ? this.config.format : 'video',
      fps: this.config ? this.config.fps : 30,
      systemAudio: this.config ? this.config.systemAudio : canCaptureSystemAudio(),
    };
  }

  /**
   * Начать запись.
   *
   * Возвращает промис, который завершится путём к файлу. Окно записи
   * невидимое: запись встречи не должна ничем выглядывать.
   */
  async start({ microphone = true, systemAudio = null, maxSeconds = 0, allScreens = false, displayId = null, micGain = 1, region = null, format = 'video', fps = 30 } = {}) {
    if (this.state !== 'idle') throw new Error(t('rec.alreadyRunning'));
    this.state = 'starting';

    // GIF пишется без звука: в этом формате его всё равно нет.
    const gif = format === 'gif';
    const withMic = gif ? false : microphone;
    const sys = gif ? false : (systemAudio === null ? canCaptureSystemAudio() : !!systemAudio);
    const displays = this.displaysFor(allScreens, displayId);
    // Запоминаем выбранные экраны: по ним рисуется рамка, и брать их
    // повторно нельзя — курсор к этому моменту мог уже уехать на другой.
    this.displays = displays;
    // Область в логических пикселях экрана: кадр рисуется сдвинутым так,
    // чтобы выбранный прямоугольник лёг в левый верхний угол холста.
    this.region = region || null;
    const layout = this.layout(displays);
    if (region && displays.length === 1) {
      layout.canvas = {
        width: Math.max(1, Math.round(region.width)),
        height: Math.max(1, Math.round(region.height)),
      };
      layout.displays = [{
        ...layout.displays[0],
        left: layout.displays[0].left - region.x,
        top: layout.displays[0].top - region.y,
      }];
    }

    // Файл записи: имя с миллисекундами, чтобы две записи подряд не
    // перезаписали друг друга.
    const name = 'record-' + new Date().toISOString().replace(/[:.]/g, '-') + '.' + (gif ? 'gif' : 'webm');
    this.file = path.join(this.dir, name);

    this.win = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      webPreferences: {
        preload: path.join(__dirname, 'preload-recorder.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // AudioContext в скрытом окне не должен ждать жеста пользователя:
        // без этого микрофон и loopback могли остаться двумя дорожками.
        autoplayPolicy: 'no-user-gesture-required',
        // getDisplayMedia в окне без картинки работает нормально, но
        // разрешение на микрофон Chromium спрашивает сам, если обработчика
        // разрешений нет. Обработчик ниже разрешает всё, что просит страница
        // записи: больше она всё равно ничего не просит.
        backgroundThrottling: false,
      },
    });
    this.win.webContents.on('will-navigate', (e) => e.preventDefault());
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    // Источники экранов выдаются по одному на запрос страницы. Берутся
    // только те, что принадлежат записываемым экранам: desktopCapturer
    // отдаёт все, а порядок у него не обязан совпадать с порядком экранов.
    const all = await require('electron').desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false,
    });
    this.sources = orderSources(all, displays);

    this.win.webContents.session.setDisplayMediaRequestHandler(
      (request, callback) => {
        const src = this.sources[this.nextSource];
        this.nextSource += 1;
        if (!src) return callback({ video: null });
        // Loopback отдаёт системный звук: на Windows это единственный путь
        // записать то, что играет на колонках.
        callback({
          video: src,
          audio: sys && this.nextSource === 1 ? 'loopback' : undefined,
        });
      },
      { useSystemPicker: false }
    );

    // Разрешения: микрофон и захват экрана разрешаем, всё прочее — нет.
    this.win.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(permission === 'media' || permission === 'audioCapture' || permission === 'display-capture');
    });
    this.win.webContents.session.setPermissionCheckHandler((_wc, permission) =>
      permission === 'media' || permission === 'audioCapture' || permission === 'display-capture'
    );

    this.config = {
      layout,
      microphone: withMic,
      systemAudio: sys,
      micGain: Number(micGain) || 1,
      format: gif ? 'gif' : 'video',
      fps: Number(fps) === 60 ? 60 : 30,
    };
    // Файл открывается сразу: куски пишутся в него по мере поступления.
    this.out = fs.createWriteStream(this.file);
    // Диск мог кончиться, файл мог оказаться на отсоединённом носителе.
    // Без обработчика EventEmitter бросает исключение в главный процесс.
    this.out.on('error', (e) => {
      if (this.state !== 'idle') {
        this.fail(t('rec.failed', { error: e.message }));
      }
    });
    this.written = 0;
    this.done = new Promise((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    // Страница пропала (упала, закрылась): запись не может продолжаться, и
    // ждать её конца бессмысленно. Без этого запись висела бы до таймера.
    this.win.webContents.on('render-process-gone', () => {
      this.fail(t('rec.windowGone'));
    });
    this.win.on('closed', () => {
      if (this.state === 'starting' || this.state === 'recording') {
        this.fail(t('rec.windowGone'));
      }
    });

    this.win.loadFile(path.join(__dirname, 'renderer', 'recorder', 'recorder.html')).catch((e) => {
      this.fail(t('rec.failed', { error: e.message }));
    });
    await new Promise((resolve, reject) => {
      this.win.webContents.once('did-finish-load', resolve);
      this.win.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(desc || code)));
    });

    // Ждём, пока страница правда начнёт запись. Только после этого вызов
    // возвращается, и человек может остановить запись тем же хоткеем.
    //
    // Страница может не ответить вовсе (зависший MediaRecorder, отказ в
    // разрешении без исключения). Без предела запись висела бы молча, а
    // приложение считало бы, что она идёт.
    const startGuard = setTimeout(() => {
      this.fail(t('rec.startTimeout'));
    }, 20000);
    if (startGuard.unref) startGuard.unref();
    try {
      await this.ready;
    } finally {
      clearTimeout(startGuard);
    }

    if (maxSeconds > 0) {
      this.stopTimer = setTimeout(() => this.stop(), maxSeconds * 1000);
      this.stopTimer.unref?.();
    }

    return { file: this.file, layout };
  }

  /** Обещание готового файла: разрешается, когда запись остановлена. */
  whenDone() {
    return this.done;
  }

  /**
   * Кусок файла от страницы записи.
   *
   * Куски пишутся в файл подряд, без ожидания: сначала первый, потом второй.
   * Порядок кусков важен — это поток одного файла, и переставлять их нельзя.
   */
  writeChunk(bytes) {
    // Последний кусок приходит уже после stop(): состояние в этот момент
    // «stopping», и отбрасывать его нельзя — файл останется без конца.
    if ((this.state !== 'recording' && this.state !== 'paused' && this.state !== 'stopping') || !bytes || !bytes.length) {
      return Promise.resolve(false);
    }
    const stream = this.out;
    if (!stream || stream.destroyed || stream.writableEnded) return Promise.resolve(false);

    const buf = Buffer.from(bytes);
    this.written += buf.length;
    const task = this.flush.then(() => new Promise((resolve, reject) => {
      try {
        stream.write(buf, (err) => {
          if (err) reject(err);
          else resolve(true);
        });
      } catch (e) {
        reject(e);
      }
    }));
    // Ошибку забирает тот, кто ждёт этот кусок. Очередь при этом обязана
    // остаться рабочей: reject в this.flush заклинил бы все следующие куски.
    this.flush = task.then(() => {}, () => {});
    return task;
  }

  /** Страница сообщила, что запись пошла, и какие звуковые источники взяла. */
  markStarted(info = null) {
    this.audioInfo = info && typeof info === 'object' ? info : null;
    this.state = 'recording';
    this.startedAt = Date.now();
    this.pausedTotal = 0;
    this.pausedAt = 0;
    if (this.readyResolve) {
      const r = this.readyResolve;
      this.readyResolve = null;
      this.readyReject = null;
      r(true);
    }
    this.onStep(t('rec.started'));
  }

  /**
   * Пауза и продолжение.
   *
   * MediaRecorder умеет и то и другое: во время паузы куски не появляются,
   * а время записи не растёт. Остановка из паузы сначала продолжает запись,
   * иначе MediaRecorder может не отдать последний кусок.
   */
  pause() {
    if (this.state !== 'recording') return false;
    this.state = 'paused';
    this.pausedAt = Date.now();
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('puuush:rec-pause');
    return true;
  }

  resume() {
    if (this.state !== 'paused') return false;
    this.state = 'recording';
    if (this.pausedAt) this.pausedTotal += Date.now() - this.pausedAt;
    this.pausedAt = 0;
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('puuush:rec-resume');
    return true;
  }

  /** Сколько миллисекунд уже пишется, без пауз. */
  elapsedMs() {
    if (!this.startedAt) return 0;
    const now = this.pausedAt || Date.now();
    return Math.max(0, now - this.startedAt - this.pausedTotal);
  }

  /** Страница сообщила об ошибке. */
  fail(message) {
    const err = new Error(message);
    const wasIdle = this.state === 'idle';
    this.state = 'idle';
    this.discardFile();
    this.cleanup();
    // Оба обещания получают отказ: одно ждёт начало записи, другое — файл.
    // Раньше отказ получало только второе, и начавший запись вызов висел.
    if (this.readyReject) {
      const r = this.readyReject;
      this.readyReject = null;
      this.readyResolve = null;
      r(err);
    }
    if (this.rejectDone) {
      const r = this.rejectDone;
      this.rejectDone = null;
      this.resolveDone = null;
      r(err);
    }
    if (!wasIdle) this.onStep(t('rec.failed', { error: message }));
  }

  /**
   * Остановить запись и сохранить файл.
   *
   * Сначала странице уходит команда «стоп», она дописывает последний кусок и
   * отвечает. Только после этого файл считается готовым.
   */
  async stop() {
    // Остановку могли нажать сразу после старта, пока страница ещё
    // поднимала потоки. Ждём начало записи, а не отвечаем «нечего
    // останавливать»: иначе первое нажатие терялось бы.
    if (this.state === 'starting' && this.ready) {
      await this.ready.catch(() => {});
    }
    if (this.state !== 'recording' && this.state !== 'paused') return null;
    if (this.state === 'paused') this.resume();
    this.state = 'stopping';
    if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = null; }

    const done = new Promise((resolve) => {
      this.onStopped = resolve;
    });
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('puuush:rec-stop');
    }
    // Страница может не ответить: окно закрылось, вкладка упала. Без
    // предельного времени запись висела бы вечно, и файл остался бы
    // незакрытым.
    const guard = setTimeout(() => {
      if (this.onStopped) this.markStopped();
    }, 10000);
    if (guard.unref) guard.unref();
    await done;
    clearTimeout(guard);

    const size = this.written;
    const file = this.file;
    // Файл закрывается до ответа: пока он не дописан, читатель по ссылке
    // получил бы обрезанную запись.
    await this.flush;
    await new Promise((resolve) => {
      if (!this.out) return resolve();
      this.out.end(resolve);
    });
    this.out = null;
    this.cleanup();
    if (!size) {
      if (this.rejectDone) this.rejectDone(new Error(t('rec.empty')));
      this.resolveDone = null;
      this.rejectDone = null;
      return null;
    }
    this.state = 'idle';
    // Файл готов. Обещание разрешается здесь, и только его держатель
    // загружает файл: загрузка делается ровно один раз.
    if (this.resolveDone) {
      const r = this.resolveDone;
      this.resolveDone = null;
      this.rejectDone = null;
      r({ path: file, size });
    }
    return { path: file, size };
  }

  /** Страница дописала последний кусок. */
  markStopped() {
    if (this.onStopped) {
      const r = this.onStopped;
      this.onStopped = null;
      r();
    }
  }

  /** Окно закрыли, страница пропала: запись без результата. */
  cleanup() {
    if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = null; }
    if (this.win && !this.win.isDestroyed()) {
      try { this.win.destroy(); } catch (e) { /* уже закрыто */ }
    }
    this.win = null;
    this.startedAt = 0;
    this.pausedAt = 0;
    this.pausedTotal = 0;
    this.sources = [];
    this.nextSource = 0;
  }

  /** Запись сорвалась: файл недописан, его надо убрать с диска. */
  discardFile() {
    if (this.out) {
      try { this.out.destroy(); } catch (e) { /* уже закрыт */ }
      this.out = null;
    }
    if (this.file) {
      try { fs.unlinkSync(this.file); } catch (e) { /* файла могло не быть */ }
    }
  }
}

/**
 * Источники экранов в порядке записываемых экранов.
 *
 * desktopCapturer отдаёт все экраны подряд, и порядок у него не обязан
 * совпадать с порядком из screen.getAllDisplays. Если перепутать, запись
 * начнётся с чужого монитора. Здесь источник подбирается к экрану теми же
 * признаками, что и при снимке: идентификатор, имя, пропорции.
 */
function orderSources(sources, displays) {
  const used = new Set();
  const out = [];
  for (const display of displays) {
    let src = sources.find((s) => !used.has(s) && String(s.display_id) === String(display.id));
    if (!src) {
      src = sources.find((s) => !used.has(s) && s.name && display.name && s.name === display.name);
    }
    if (!src && sources.length === displays.length) {
      const free = sources.filter((s) => !used.has(s));
      src = free[0];
    }
    if (src) {
      used.add(src);
      out.push(src);
    }
  }
  // Если сопоставить не удалось, лучше записать все источники по порядку,
  // чем не записать ничего.
  if (!out.length) return sources.slice();
  return out;
}

/**
 * Каналы IPC страницы записи.
 *
 * Вынесены сюда, а не в main.js, потому что относятся к записи: и главный
 * процесс, и проверка записи должны ставить их одинаково. Раньше страница
 * записи была бы мёртвой без главного процесса, и ошибка «нет обработчика»
 * вылезала бы только при запуске приложения.
 */
function registerRecorderIpc(getRecorder, { t, ipcMain }) {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (_e, arg) => {
      try {
        return await fn(_e, arg);
      } catch (err) {
        throw err;
      }
    });

  handle('puuush:rec-layout', () => {
    const rec = getRecorder();
    if (!rec) throw new Error(t('rec.notRunning'));
    return rec.describe();
  });
  handle('puuush:rec-started', (_e, info) => {
    const rec = getRecorder();
    if (rec) rec.markStarted(info);
    return true;
  });
  handle('puuush:rec-stopped', () => {
    const rec = getRecorder();
    if (rec) rec.markStopped();
    return true;
  });
  handle('puuush:rec-pause', () => {
    const rec = getRecorder();
    return rec ? rec.pause() : false;
  });
  handle('puuush:rec-resume', () => {
    const rec = getRecorder();
    return rec ? rec.resume() : false;
  });
  handle('puuush:rec-error', (message) => {
    const rec = getRecorder();
    if (rec) rec.fail(String(message || t('rec.failed', { error: '' })));
    return true;
  });
  // Кусок файла: invoke возвращается, когда кусок лёг в поток записи.
  // Раньше здесь стоял send без ответа, и последний кусок мог прийти после
  // закрытия файла — запись теряла конец.
  handle('puuush:rec-chunk', async (_e, bytes) => {
    const rec = getRecorder();
    if (!rec || !bytes) return false;
    return rec.writeChunk(Buffer.from(bytes));
  });
}

module.exports = {
  canCaptureSystemAudio, layoutFor, orderSources, Recorder, registerRecorderIpc,
};
