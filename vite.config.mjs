import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

/**
 * Сборка обоих окон интерфейса.
 *
 * Исходники ок лежат в renderer/, собранные файлы — в src/renderer/ рядом с
 * главным процессом: electron-builder берёт каталог src целиком, и в
 * приложение попадает ровно то, что здесь собрано.
 *
 * base: './' обязателен: окна открываются через loadFile, то есть по
 * file://, и абсолютные пути к сборке не разрешились бы.
 */
export default defineConfig({
  // Корень сборки — каталог исходников интерфейса. Благодаря этому
  // renderer/settings.html собирается в src/renderer/settings.html, а не в
  // src/renderer/renderer/settings.html.
  root: resolve(root, 'renderer'),
  base: './',
  plugins: [svelte()],
  build: {
    outDir: resolve(root, 'src/renderer'),
    emptyOutDir: true,
    assetsDir: 'assets',
    target: 'chrome120',
    // Ни один файл не встраивается в CSS как data:. Шрифты остаются
    // файлами, и политика безопасности окна может запрещать data: целиком.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        settings: resolve(root, 'renderer/settings.html'),
        overlay: resolve(root, 'renderer/overlay.html'),
      },
    },
  },
});
