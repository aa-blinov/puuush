'use strict';
/**
 * Сборка образа macOS.
 *
 *     node scripts/dist-mac.cjs arm64 | x64 | both
 *
 * Подпись выбирается сама:
 *
 * - если в окружении есть сертификат (CSC_LINK), приложение подписывается им
 *   и нотифицируется, и человек не видит никаких вопросов от macOS;
 * - если сертификата нет, подпись ad-hoc: без неё приложение на Apple
 *   silicon не запускается вообще, и macOS называет это «приложение
 *   повреждено». Hardened runtime при ad-hoc выключен: он проверяет
 *   библиотеки и отвергает сам Electron.
 *
 * Значит, чтобы приложение открывалось без лишних вопросов, нужен
 * Developer ID: положи сертификат в секреты и больше ничего менять не
 * придётся.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BUILDER = path.join(ROOT, 'node_modules', '.bin', 'electron-builder');

const asked = process.argv[2] || 'arm64';
const arches = asked === 'both' ? ['arm64', 'x64'] : [asked];
const hasCertificate = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);

for (const arch of arches) {
  // Архитектура флагом, а не целью: `--mac arm64` electron-builder читает как
  // тип пакета и падает с «Unknown target: arm64».
  const args = [BUILDER, '--mac', `--${arch}`, '--publish', 'never'];
  if (!hasCertificate) {
    args.push('-c.mac.identity=-', '-c.mac.hardenedRuntime=false');
  }
  const result = spawnSync(args[0], args.slice(1), { stdio: 'inherit', cwd: ROOT });
  if (result.status !== 0) process.exit(result.status || 1);
}
