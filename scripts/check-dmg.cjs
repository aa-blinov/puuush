'use strict';
/**
 * Проверка собранных DMG.
 *
 *     node scripts/check-dmg.cjs dist
 *
 * macOS читает трейлер UDIF строго с конца файла: последние 512 байт должны
 * быть трейлером, и ни одного байта после него. Если после трейлера остался
 * хвост, образ не монтируется, и человек видит «не может быть извлечён на
 * этом устройстве» вместо приложения.
 *
 * Такое проходит мимо сборки: electron-builder пишет файл, и всё выглядит
 * хорошо, пока образ не откроют на настоящем Mac. Поэтому проверка живёт в
 * CI, а не в голове у того, кто собирает.
 */
const fs = require('node:fs');
const path = require('node:path');

const TRAILER = 512;
const MAGIC = 'koly';

/** Разбирает трейлер UDIF. */
function readTrailer(file) {
  const stat = fs.statSync(file);
  if (stat.size < TRAILER) return { error: 'файл меньше трейлера' };
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(TRAILER);
  fs.readSync(fd, buf, 0, TRAILER, stat.size - TRAILER);
  fs.closeSync(fd);

  if (buf.toString('latin1', 0, 4) !== MAGIC) {
    return { error: 'в конце файла нет трейлера UDIF' };
  }
  // Смещения внутри трейлера — большие числа с обратным порядком байт.
  // dataForkOffset: 24, dataForkLength: 32, xmlOffset: 216, xmlLength: 224.
  const dataForkOffset = Number(buf.readBigUInt64BE(24));
  const dataForkLength = Number(buf.readBigUInt64BE(32));
  const xmlOffset = Number(buf.readBigUInt64BE(216));
  const xmlLength = Number(buf.readBigUInt64BE(224));
  return { size: stat.size, dataForkOffset, dataForkLength, xmlOffset, xmlLength };
}

/** Проверяет один файл. Возвращает строку с проблемой или null. */
function checkDmg(file) {
  const t = readTrailer(file);
  if (t.error) return t.error;

  if (t.dataForkOffset !== 0) return `смещение данных не ноль: ${t.dataForkOffset}`;
  const plistEnd = t.xmlOffset + t.xmlLength;
  if (t.xmlOffset !== t.dataForkOffset + t.dataForkLength) {
    return `plist начинается не сразу после данных: ${t.xmlOffset} вместо ${t.dataForkOffset + t.dataForkLength}`;
  }
  if (plistEnd !== t.size - TRAILER) {
    return `после plist ${t.size - TRAILER - plistEnd} лишних байт: трейлер должен быть последним`;
  }

  // plist обязан быть читаемым: без него образ не покажет разделов.
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(Math.min(64, t.xmlLength));
  fs.readSync(fd, head, 0, head.length, t.xmlOffset);
  fs.closeSync(fd);
  const text = head.toString('utf8');
  if (!text.startsWith('<?xml') && !text.startsWith('bplist')) {
    return 'plist не похож на xml';
  }
  return null;
}

const target = process.argv[2];
if (!target) {
  process.stderr.write('usage: check-dmg.cjs <dir-or-file>\n');
  process.exit(2);
}

const files = fs.statSync(target).isDirectory()
  ? fs.readdirSync(target).filter((f) => f.endsWith('.dmg')).map((f) => path.join(target, f))
  : [target];

if (!files.length) {
  process.stderr.write('в каталоге нет ни одного .dmg\n');
  process.exit(1);
}

let bad = 0;
for (const file of files) {
  const problem = checkDmg(file);
  if (problem) {
    bad++;
    process.stdout.write(`  ПРОВАЛ ${path.basename(file)}: ${problem}\n`);
  } else {
    process.stdout.write(`  ОК    ${path.basename(file)}\n`);
  }
}
process.exit(bad ? 1 : 0);
