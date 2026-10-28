/**
 * Страница записи.
 *
 * Живёт в невидимом окне и делает три вещи: берёт потоки экранов, берёт
 * звук и кодирует всё в один файл.
 *
 * Почему страница, а не главный процесс: MediaRecorder есть в Chromium, и
 * микрофон с системным звуком достаются только оттуда. Главный процесс
 * получает готовые куски файла и пишет их на диск.
 *
 * Несколько экранов склеиваются на canvas. Если экранов больше одного,
 * картинка ужимается до разумной ширины: холст в 5760 точек кодировать
 * дорого, а прочитать на нём всё равно ничего нельзя.
 */

import { GifEncoder } from './gif.js';

const bridge = window.puuush;

/** Предельная ширина кадра записи: больше не нужно и стоит дорого. */
const MAX_FRAME_WIDTH = 2560;

/**
 * Предел ширины для GIF.
 *
 * На 30 кадрах кодировщик успевает с кадром 1600 точек, и рабочий стол на
 * нём остаётся читаемым. На 60 запас по времени вдвое меньше,
 * поэтому ширина снижается до 960: лучше плавный кадр без пропусков, чем
 * точная копия монитора, которую кодировщик не успевает отдавать.
 */
const MAX_GIF_WIDTH_30 = 1600;
const MAX_GIF_WIDTH_60 = 960;

/**
 * Как просить микрофон.
 *
 * Обработку выключаем по всем трём пунктам. Chromium иначе включает
 * эхоподавление и автоматическую регулировку усиления: они срезают тихие
 * места и выравнивают голос, а на записи встречи это слышно как «пережатый»
 * звук. Частота 48 кГц и моно: голосу хватает, Opus всё равно кодирует моно.
 */
const MIC_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
  sampleRate: 48000,
};

/**
 * Сколько бит в секунду давать видео.
 *
 * Для экрана и презентации этого хватает, а час записи укладывается в
 * примерно гигабайт. Считать от размера кадра, чтобы маленький кадр не
 * занимал лишнего, а большой не превращался в кашу.
 */
function videoBitrate(width, height, fps) {
  const bits = width * height * fps * 0.03;
  return Math.round(Math.min(6_000_000, Math.max(1_200_000, bits)));
}

/** Размер кадра записи после ужатия. Чётный: кодировщики любят чётные. */
function frameSize(canvas, maxWidth = MAX_FRAME_WIDTH) {
  const scale = Math.min(1, maxWidth / Math.max(1, canvas.width));
  return {
    scale,
    width: Math.max(2, Math.round((canvas.width * scale) / 2) * 2),
    height: Math.max(2, Math.round((canvas.height * scale) / 2) * 2),
  };
}

/**
 * Куски записи уходят в главный процесс по одному и в том же порядке, в
 * котором их отдал MediaRecorder.
 *
 * Это не только экономия памяти. Последний кусок приходит после вызова
 * stop(), и если отправить его вслед за сигналом «остановлено», главный
 * процесс успеет закрыть файл раньше. Тогда запись встречи останется без
 * последнего кластера: она открывается, но обрывается на середине.
 *
 * Цепочка обещаний держит порядок, а invoke ждёт, пока главный процесс
 * примет кусок, — это заодно не даёт IPC копить мегабайты в памяти.
 */
let chunkChain = Promise.resolve();
let chunkFailure = null;

function sendChunk(blob) {
  chunkChain = chunkChain.then(async () => {
    if (chunkFailure) return;
    const buf = await blob.arrayBuffer();
    if (buf.byteLength) await bridge.recChunk(new Uint8Array(buf));
  }).catch((e) => {
    chunkFailure = e;
  });
  return chunkChain;
}

async function main() {
  const cfg = await bridge.recLayout();
  const layout = cfg.layout;
  const streams = [];
  const videos = [];

  // Первый запрос забирает ещё и системный звук: loopback-устройство вывода
  // отдаётся вместе с экраном, и отдельно его не достать.
  for (let i = 0; i < layout.displays.length; i++) {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: cfg.fps },
      audio: i === 0 && cfg.systemAudio,
    });
    streams.push(stream);
    const v = document.createElement('video');
    v.srcObject = stream;
    v.muted = true;
    v.playsInline = true;
    await v.play().catch(() => {});
    videos.push(v);
  }

  // Микрофон: свой запрос, разрешение на него даёт главный процесс.
  let mic = null;
  if (cfg.microphone) {
    mic = await navigator.mediaDevices.getUserMedia({
      audio: MIC_CONSTRAINTS,
    });
  }

  const gifWidth = cfg.fps === 60 ? MAX_GIF_WIDTH_60 : MAX_GIF_WIDTH_30;
  const size = frameSize(layout.canvas, cfg.format === 'gif' ? gifWidth : MAX_FRAME_WIDTH);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  // willReadFrequently: GIF читает холст каждый кадр, и без этого признака
  // Chromium гоняет пиксели через видеопамять и предупреждает в консоли.
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: cfg.format === 'gif' });

  // Кадр рисуется тогда, когда меняется картинка на экране, но не чаще,
  // чем нужно кодировщику: лишние кадры — это лишняя работа процессора.
  let last = 0;
  const step = 1000 / cfg.fps;
  const draw = (now) => {
    requestAnimationFrame(draw);
    if (now - last < step - 1) return;
    last = now;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < videos.length; i++) {
      const d = layout.displays[i];
      const v = videos[i];
      if (!v.videoWidth) continue;
      ctx.drawImage(
        v,
        d.left * size.scale,
        d.top * size.scale,
        d.width * size.scale,
        d.height * size.scale
      );
    }
  };
  requestAnimationFrame(draw);

  // GIF: ни MediaRecorder, ни звука. Кадры снимаются с холста и кодируются
  // на месте, потому что браузер GIF не умеет кодировать вовсе.
  if (cfg.format === 'gif') {
    await runGif(canvas, ctx, cfg);
    return;
  }

  const out = canvas.captureStream(cfg.fps);

  // Звук сводится в одну дорожку.
  //
  // Микрофон и системный звук — это отдельные дорожки из разных потоков.
  // MediaRecorder умеет писать несколько дорожек, но плееры и сервисы
  // встреч такую запись понимают через раз, а иногда играют только первую.
  // Сведение в один поток даёт ровно то, что нужно: слышно и человека, и
  // то, что играет на машине, в одной дорожке.
  const audio = await mixAudio(streams, mic, cfg.micGain);

  if (audio) {
    if (audio.mixed) out.addTrack(audio.mixed);
    else for (const track of audio.tracks) out.addTrack(track);
  }

  const mime = pickMime();
  const options = { videoBitsPerSecond: videoBitrate(canvas.width, canvas.height, cfg.fps) };
  if (mime) options.mimeType = mime;
  // 160 кбит/с на дорожку Opus: на 128 голос местами звучит сдавленно,
  // а разница в размере файла за час записи невелика.
  if (out.getAudioTracks().length) options.audioBitsPerSecond = 160_000;

  const recorder = new MediaRecorder(out, options);
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) sendChunk(e.data);
  };
  recorder.onerror = (e) => {
    const detail = (e && e.error && e.error.message) || (e && e.message) || '';
    bridge.recError(detail || 'MediaRecorder остановился с ошибкой').catch(() => {});
  };
  recorder.start(1000);

  // Главный процесс получает не только «пошло», но и состав звука. Так
  // проверка может убедиться, что микрофон и системный звук действительно
  // свелись в одну дорожку, а не остались одним микрофоном.
  await bridge.recStarted({
    audioTracks: out.getAudioTracks().length,
    audioSources: audio ? audio.tracks.length : 0,
    mixed: !!(audio && audio.mixed),
    microphone: !!mic,
    micGain: Number(cfg.micGain) || 1,
    systemAudio: streams.some((stream) => stream.getAudioTracks().length > 0),
  });

  // Остановка приходит сообщением: главный процесс не может остановить
  // MediaRecorder из другого процесса напрямую.
  let stopping = false;
  const stopTracks = () => {
    for (const stream of streams) for (const t of stream.getTracks()) t.stop();
    if (mic) for (const t of mic.getAudioTracks()) t.stop();
    for (const t of out.getTracks()) t.stop();
    if (audio && audio.ctx) audio.ctx.close().catch(() => {});
  };

  // Пауза и продолжение: MediaRecorder умеет и то и другое сам, и на паузе
  // куски просто не появляются. Время записи считает главный процесс.
  bridge.onPause(() => {
    if (recorder.state === 'recording') recorder.pause();
  });
  bridge.onResume(() => {
    if (recorder.state === 'paused') recorder.resume();
  });

  bridge.onStop(async () => {
    if (stopping) return;
    stopping = true;
    try {
      // stop() только просит MediaRecorder закончить: последний dataavailable
      // и событие stop приходят асинхронно. Ждём именно stop, иначе главный
      // процесс закрывает файл до последнего куска.
      if (recorder.state !== 'inactive') {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('MediaRecorder не завершился')), 10000);
          recorder.addEventListener('stop', () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
          try {
            recorder.stop();
          } catch (e) {
            clearTimeout(timer);
            reject(e);
          }
        });
      }
      // Все куски, включая последний, уже ушли в главный процесс: invoke
      // выше ждёт подтверждения записи на диск.
      await chunkChain;
      if (chunkFailure) throw chunkFailure;
      stopTracks();
      await bridge.recStopped();
    } catch (e) {
      stopTracks();
      await bridge.recError(String((e && e.message) || e)).catch(() => {});
    }
  });
}

/**
 * Запись GIF: кадры снимаются с холста по таймеру и кодируются сразу.
 *
 * Таймер, а не requestAnimationFrame: частота кадров у GIF задаётся
 * настройкой, и она не обязана совпадать с частотой монитора. Если кодировщик
 * не успевает, кадр пропускается, а задержка следующего считается по
 * настоящему времени: плеер не растянет запись на лишние минуты.
 */
async function runGif(canvas, ctx, cfg) {
  const encoder = new GifEncoder(canvas.width, canvas.height, cfg.fps);
  await bridge.recStarted({
    audioTracks: 0,
    audioSources: 0,
    mixed: false,
    microphone: false,
    micGain: 1,
    systemAudio: false,
    format: 'gif',
  });

  let paused = false;
  let stopping = false;
  let busy = false;
  let last = 0;
  let chain = Promise.resolve();
  let failure = null;

  let timer = null;
  const interval = Math.max(8, Math.round(1000 / cfg.fps));
  const tick = async () => {
    if (stopping) return;
    const started = performance.now();
    if (!paused && !busy) {
      busy = true;
      try {
        const delay = last ? (started - last) / 10 : 100 / cfg.fps;
        last = started;
        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const bytes = encoder.addFrame(frame.data, delay);
        chain = chain.then(() => bridge.recChunk(bytes));
        await chain;
      } catch (e) {
        failure = e;
      } finally {
        busy = false;
      }
    }
    // Следующий кадр считается от начала текущего, а не от конца записи на
    // диск. Иначе время кодирования прибавляется к интервалу, и вместо 30
    // кадров выходит 20. Если кодировщик всё же отстал, следующий тик идёт
    // сразу и запись догоняет выбранную частоту.
    if (!stopping) {
      timer = setTimeout(tick, Math.max(1, interval - (performance.now() - started)));
    }
  };
  timer = setTimeout(tick, interval);

  bridge.onPause(() => { paused = true; });
  bridge.onResume(() => { paused = false; last = 0; });

  await new Promise((resolve) => {
    bridge.onStop(async () => {
      if (stopping) return;
      stopping = true;
      clearTimeout(timer);
      try {
        await chain;
        if (failure) throw failure;
        await bridge.recChunk(encoder.finish());
        await bridge.recStopped();
      } catch (e) {
        await bridge.recError(String((e && e.message) || e)).catch(() => {});
      }
      resolve();
    });
  });
}

/**
 * Сводит микрофон и системный звук в одну дорожку.
 *
 * Возвращает null, если звука нет вовсе: тогда запись идёт без звуковой
 * дорожки, а не падает. Если Web Audio не завёлся, дорожки добавляются
 * как есть — лучше две дорожки, чем ни одной.
 */
async function mixAudio(streams, mic, micGain = 1) {
  const tracks = [];
  // Микрофон идёт со своим усилением, системный звук — как есть: громкость
  // системы человек уже выставил, и поднимать её вместе с микрофоном значило
  // бы перегрузить дорожку.
  const inputs = [];
  for (const stream of streams) {
    for (const track of stream.getAudioTracks()) { tracks.push(track); inputs.push({ track, gain: 1 }); }
  }
  if (mic) {
    for (const track of mic.getAudioTracks()) {
      tracks.push(track);
      inputs.push({ track, gain: Number(micGain) > 0 ? Number(micGain) : 1 });
    }
  }
  if (!tracks.length) return null;

  try {
    const ctx = new AudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    const dest = ctx.createMediaStreamDestination();
    for (const input of inputs) {
      const src = ctx.createMediaStreamSource(new MediaStream([input.track]));
      if (input.gain === 1) {
        src.connect(dest);
      } else {
        const amp = ctx.createGain();
        amp.gain.value = input.gain;
        src.connect(amp);
        amp.connect(dest);
      }
    }
    const mixed = dest.stream.getAudioTracks()[0];
    if (mixed) return { mixed, tracks, ctx };
  } catch (e) {
    // Web Audio не завёлся: тогда пишем дорожки как есть. Лучше две
    // дорожки, которые понимают не все плееры, чем запись без звука.
  }
  return { mixed: null, tracks, ctx: null };
}

/**
 * Формат записи.
 *
 * VP9 и Opus дают хорошее качество и небольшой файл, но старые сборки
 * Chromium их не берут, поэтому есть запасные варианты, и последний — чистый
 * WebM, который понимает всё.
 */
function pickMime() {
  const list = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const m of list) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

main().catch((e) => {
  bridge.recError(String((e && e.message) || e));
});
