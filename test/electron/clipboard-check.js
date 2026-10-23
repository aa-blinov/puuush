/**
 * Проверка буфера обмена на настоящем Electron: текст уходит и читается
 * обратно, картинка уходит и читается как картинка.
 *
 * Существует потому, что Electron 44 перевёл буфер на промисы, и прежний код
 * сравнивал промис со ссылкой. Ни одна проверка этого не ловила: буфер
 * трогают только окна, а они не проверяли результат.
 *
 * Запуск: npm run test:electron
 */
const path = require('path');
const { app } = require('electron');

const clip = require(path.join(__dirname, '..', '..', 'src', 'clipboard.js'));

// Картинка 1x1, PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

/** Проверка, которая висит, хуже проверки, которая падает. */
setTimeout(() => {
  console.error('  ПРОВАЛ: проверка не уложилась в минуту');
  app.exit(1);
}, 60000).unref?.();

app.whenReady().then(async () => {
  const results = [];
  const step = async (name, fn) => {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail: detail ?? '' });
    } catch (e) {
      results.push({ name, ok: false, detail: e.message });
    }
  };

  await step('текст принят и читается обратно', async () => {
    if (!(await clip.writeText('puuush-clipboard-check'))) throw new Error('буфер вернул другой текст');
  });

  await step('картинка принята буфером', async () => {
    if (!(await clip.writeImage(PNG))) throw new Error('буфер не принял картинку');
  });

  await step('картинка читается обратно', async () => {
    const img = await clip.readImage();
    if (!img || img.isEmpty()) throw new Error('картинки в буфере нет');
    const { width, height } = img.getSize();
    if (width !== 1 || height !== 1) throw new Error(`размер ${width}x${height}, ожидали 1x1`);
  });

  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`  ${r.ok ? 'ОК   ' : 'ПРОВАЛ'} ${r.name}${r.detail ? ': ' + r.detail : ''}`);
  }
  console.log(failed ? `провалено: ${failed}` : 'все проверки пройдены');
  app.exit(failed ? 1 : 0);
});
