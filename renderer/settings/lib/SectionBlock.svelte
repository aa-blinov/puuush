<script>
  /**
   * Раздел окна настроек: карточка с заголовком и содержимым.
   *
   * Разделы рисуются карточками поверхности с волосяной границей темы и
   * мягкой тенью покоя — линия-разделитель между ними не нужна, карточка
   * уже отделяет блок. Отступы взяты из шкалы кита: roomy внутри карточки,
   * comfortable между заголовком и первым полем.
   */
  export let title = '';
  /** Первый раздел страницы: над ним и так отступ шапки, карточка одна. */
  export let first = false;
</script>

<section class={first ? '' : 'mt-section'}>
  <div class="rounded-ui border border-line bg-surface p-roomy shadow-rest">
    <h2 class="text-whisper font-medium uppercase tracking-widest text-ink-soft">{title}</h2>
    <div class="mt-comfortable space-y-comfortable">
      <slot />
    </div>
  </div>
</section>
