<script>
  /**
   * Раздел окна настроек: заголовок, линия и содержимое.
   *
   * Заголовок набирается как метка: капс и разрядка — так разделы читаются
   * как оглавление, а не как ещё один заголовок.
   */
  export let title = '';
  /** Первый раздел страницы: над ним нет линии, она была бы пустой. */
  export let first = false;
</script>

<section class={first ? '' : 'mt-8 border-t border-line pt-6'}>
  <h2 class="text-whisper font-medium uppercase tracking-widest text-ink-soft">{title}</h2>
  <div class="mt-4">
    <slot />
  </div>
</section>
