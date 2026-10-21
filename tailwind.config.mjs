import preset from '@monos/ui/tailwind-preset';

/**
 * Tailwind поверх пресета моноса.
 *
 * В content обязательно лежит каталог кита: его компоненты написаны на
 * утилитах Tailwind, и без сканирования их исходников в сборке не будет ни
 * bg-surface, ни text-ink-soft.
 */
export default {
  presets: [preset],
  content: [
    './renderer/**/*.{svelte,js,html}',
    './node_modules/@monos/ui/src/**/*.svelte',
  ],
};
