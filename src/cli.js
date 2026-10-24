'use strict';
/**
 * Режим командной строки: puuush --cli файл.png
 * Печатает ссылку и выходит. Удобно из скриптов и для удалённых машин.
 */

const path = require('node:path');
const store = require('./store');
const { t, setLang } = require('./i18n');
const { publish } = require('./upload');

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

module.exports = { runCli };
