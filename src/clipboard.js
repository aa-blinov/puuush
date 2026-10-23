'use strict';
/**
 * Буфер обмена: текст, картинка из буфера и картинка в буфер.
 *
 * В Electron 44 буфер асинхронный. writeText и readText возвращают промис, и
 * без await читать его нельзя: прежняя проверка сравнивала промис со ссылкой,
 * расходилась всегда и объявляла каждую ссылку непопавшей в буфер. Картинок
 * тоже нет ни clipboard.readImage, ни clipboard.writeImage: картинка читается
 * по MIME-типу, а пишется через ClipboardItem.
 */

const { clipboard, ClipboardItem, nativeImage } = require('electron');

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp'];

/**
 * Кладёт текст и читает его обратно. Возвращает false, если буфер принял
 * другое. Чтение нужно на X11 без менеджера буфера: writeText там проходит
 * без ошибки, а содержимое выделения тут же умирает.
 */
async function writeText(text) {
  await clipboard.writeText(text);
  return (await clipboard.readText()) === text;
}

/** Картинка из буфера или null, если картинки там нет. */
async function readImage() {
  const items = await clipboard.read();
  for (const type of IMAGE_TYPES) {
    const item = items.find((i) => i.types.includes(type));
    if (!item) continue;
    try {
      const blob = await item.getType(type);
      const img = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
      if (!img.isEmpty()) return img;
    } catch (e) {
      // формат не поддержан системой, пробуем следующий
    }
  }
  return null;
}

/** Кладёт PNG в буфер картинкой. Возвращает false, если буфер её не принял. */
async function writeImage(png) {
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
  return clipboard.has('image/png');
}

module.exports = { writeText, readImage, writeImage };
