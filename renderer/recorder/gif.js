/**
 * Кодировщик GIF: кадры приходят пикселями, наружу уходит готовый поток.
 *
 * Зачем свой: браузер умеет проигрывать GIF, но не умеет его кодировать.
 * MediaRecorder отдаёт WebM, а перегнать WebM в GIF нечем: декодера в
 * приложении нет, и тащить ради этого ffmpeg в сотню мегабайт не хочется.
 *
 * Палитра у каждого кадра своя: у GIF всего 256 цветов, и одна палитра на
 * всю запись рабочего стола с текстом и картинками сразу даёт кашу. Сетка
 * 6×7×6 даёт 252 ячейки и позволяет получить индекс цвета двумя сдвигами.
 * Перебор 256 оттенков для каждого пикселя или для всех 32768 ячеек LUT
 * стоил дороже самой записи и не давал держать 30 кадров в секунду.
 */

const HEADER_MIN_CODE_SIZE = 8;
const MAX_COLORS = 256;
// Индекс пары «префикс, следующий цвет» лежит в одном миллионе ячеек:
// 4096 * 256. Прямой массив быстрее Map на каждом пикселе кадра.
const DICT_SIZE = 1 << 20;
const RED_LEVELS = 6;
const GREEN_LEVELS = 7;
const BLUE_LEVELS = 6;
const PALETTE_COLORS = RED_LEVELS * GREEN_LEVELS * BLUE_LEVELS;

/**
 * Палитра кадра: средний цвет попавших в ячейку пикселей.
 *
 * В отличие от поиска ближайшего цвета по топ-256 гистограммы, здесь индекс
 * известен сразу при чтении пикселя. Пустые ячейки заполняются центром
 * своего диапазона, чтобы таблица всегда была полной.
 */
function buildPalette(rgba) {
  const counts = new Uint32Array(PALETTE_COLORS);
  const sums = new Uint32Array(PALETTE_COLORS * 3);
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    const key = paletteIndex(r, g, b);
    counts[key] += 1;
    sums[key * 3] += r;
    sums[key * 3 + 1] += g;
    sums[key * 3 + 2] += b;
  }

  const palette = new Uint8Array(MAX_COLORS * 3);
  for (let key = 0; key < PALETTE_COLORS; key++) {
    const n = counts[key];
    if (n) {
      palette[key * 3] = Math.round(sums[key * 3] / n);
      palette[key * 3 + 1] = Math.round(sums[key * 3 + 1] / n);
      palette[key * 3 + 2] = Math.round(sums[key * 3 + 2] / n);
    } else {
      const ri = Math.floor(key / (GREEN_LEVELS * BLUE_LEVELS));
      const gi = Math.floor(key / BLUE_LEVELS) % GREEN_LEVELS;
      const bi = key % BLUE_LEVELS;
      palette[key * 3] = Math.round(((ri + 0.5) * 255) / RED_LEVELS);
      palette[key * 3 + 1] = Math.round(((gi + 0.5) * 255) / GREEN_LEVELS);
      palette[key * 3 + 2] = Math.round(((bi + 0.5) * 255) / BLUE_LEVELS);
    }
  }
  // Остальные четыре места палитры не используются, но таблица GIF должна
  // быть длиной 256 цветов: индексов на чёрный хвост не будет.
  return { palette, colors: PALETTE_COLORS };
}

/** Индекс цвета в палитре: по три бита на красный и синий, семь градаций зелёного. */
function paletteIndex(r, g, b) {
  const ri = Math.min(RED_LEVELS - 1, (r * RED_LEVELS) >> 8);
  const gi = Math.min(GREEN_LEVELS - 1, (g * GREEN_LEVELS) >> 8);
  const bi = Math.min(BLUE_LEVELS - 1, (b * BLUE_LEVELS) >> 8);
  return (ri * GREEN_LEVELS + gi) * BLUE_LEVELS + bi;
}
/** Индексы цветов для кадра: по одному байту на пиксель. */
function indexFrame(rgba) {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    out[j] = paletteIndex(rgba[i], rgba[i + 1], rgba[i + 2]);
  }
  return out;
}

/** Упаковка LZW: словарь по индексам, коды переменной длины. */
function lzwEncode(indices, minCodeSize, dictionary, output) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let nextCode = endCode + 1;
  let codeSize = minCodeSize + 1;
  const dict = dictionary;
  dict.fill(-1);
  const bytes = output;
  let length = 0;
  let cur = 0;
  let curBits = 0;

  const emit = (code) => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) {
      bytes[length++] = cur & 0xff;
      cur >>= 8;
      curBits -= 8;
    }
  };

  emit(clearCode);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const known = dict[key];
    if (known >= 0) {
      prefix = known;
      continue;
    }
    emit(prefix);
    if (nextCode < 4096) {
      dict[key] = nextCode;
      nextCode += 1;
      if (nextCode > 1 << codeSize && codeSize < 12) codeSize += 1;
    } else {
      emit(clearCode);
      dict.fill(-1);
      nextCode = endCode + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(endCode);
  if (curBits > 0) bytes[length++] = cur & 0xff;
  return bytes.subarray(0, length);
}

/** Кусок LZW в подблоках GIF: не больше 255 байт в каждом. */
function subBlocks(bytes) {
  const chunks = Math.ceil(bytes.length / 255);
  const out = new Uint8Array(bytes.length + chunks + 1);
  let p = 0;
  for (let i = 0; i < bytes.length; i += 255) {
    const n = Math.min(255, bytes.length - i);
    out[p++] = n;
    out.set(bytes.subarray ? bytes.subarray(i, i + n) : bytes.slice(i, i + n), p);
    p += n;
  }
  out[p] = 0;
  return out;
}

export class GifEncoder {
  /**
   * @param {number} width
   * @param {number} height
   * @param {number} fps частота, с которой сняты кадры
   */
  constructor(width, height, fps) {
    this.width = width;
    this.height = height;
    // GIF хранит задержку в сотых долях секунды.
    this.delay = Math.max(1, Math.round(100 / fps));
    this.delayCarry = 0;
    this.first = true;
    this.frames = 0;
    this.dict = new Int16Array(DICT_SIZE);
    this.scratch = new Uint8Array(Math.max(4096, width * height * 2 + 1024));
  }

  header() {
    const head = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]; // GIF89a
    // Логический экран: глобальной палитры нет, она у каждого кадра своя.
    head.push(this.width & 0xff, (this.width >> 8) & 0xff);
    head.push(this.height & 0xff, (this.height >> 8) & 0xff);
    head.push(0x70, 0, 0);
    if (this.first) {
      // Зацикливание: без этого GIF проиграется один раз и замрёт.
      head.push(
        0x21, 0xff, 0x0b,
        // NETSCAPE2.0 без Buffer: страница живёт без Node, и Buffer там нет.
        0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30,
        0x03, 0x01, 0x00, 0x00, 0x00
      );
    }
    return head;
  }

  /**
   * Кадр. Возвращает готовые байты: их можно сразу отдать на диск, не
   * дожидаясь конца записи.
   */
  addFrame(rgba, delayCs = null) {
    const { palette } = buildPalette(rgba);
    const indices = indexFrame(rgba);
    // Заголовок пишется один раз, в первый кадр: иначе файл после первого
    // кадра становится нечитаемым, потому что посреди данных снова идёт
    // «GIF89a» и описание экрана.
    const head = this.first ? this.header() : [];
    // Задержку можно задать на кадр: если кодировщик не успевает за выбранной
    // частотой, плеер должен идти с той же скоростью, что и запись, а не
    // растягивать редкие кадры на исходный шаг.
    let delay = this.delay;
    if (delayCs) {
      // В 60 кадрах секунда даёт 1,67 сотой на кадр. Округление каждого
      // кадра до двух дало бы 50 кадров, поэтому дробная часть переносится
      // на следующий: задержки идут 2, 1, 2 и в среднем совпадают с записью.
      const exact = Math.max(1, Math.min(65535, delayCs)) + this.delayCarry;
      delay = Math.max(1, Math.round(exact));
      this.delayCarry = exact - delay;
    }
    this.first = false;
    const blocks = subBlocks(lzwEncode(indices, HEADER_MIN_CODE_SIZE, this.dict, this.scratch));

    // Собираем кадр в один буфер: разворачивать мегабайты через push(...)
    // нельзя, на большом кадре это переполняет стек вызовов.
    const size = head.length + 8 + 10 + MAX_COLORS * 3 + 1 + blocks.length;
    const out = new Uint8Array(size);
    let p = 0;
    out.set(head, p); p += head.length;
    // Графический контроль: задержка и «оставить как есть» (disposal 1).
    out.set([0x21, 0xf9, 0x04, 0x04, delay & 0xff, (delay >> 8) & 0xff, 0x00, 0x00], p);
    p += 8;
    // Дескриптор кадра с локальной палитрой на 256 цветов.
    out.set([0x2c, 0, 0, 0, 0, this.width & 0xff, (this.width >> 8) & 0xff,
      this.height & 0xff, (this.height >> 8) & 0xff, 0x87], p);
    p += 10;
    out.set(palette, p); p += MAX_COLORS * 3;
    out[p] = HEADER_MIN_CODE_SIZE;
    p += 1;
    out.set(blocks, p);
    this.frames += 1;
    return out;
  }

  /** Конец файла: один байт. */
  finish() {
    return Uint8Array.from([0x3b]);
  }
}
