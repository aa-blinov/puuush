<script>
  /**
   * Раздел окна настроек: заголовок, разделитель и содержимое.
   *
   * Линию рисует Separator из кита, поэтому она остаётся одной волосяной
   * линией темы, а не вторым видом границы. Отступы взяты из шкалы кита:
   * 32 точки до линии, 24 после неё и 16 до первого поля.
   */
  import { Separator } from '@monos/ui';

  export let title = '';
  /** Первый раздел страницы: над ним нет линии, она была бы пустой. */
  export let first = false;
</script>

<section class={first ? '' : 'mt-section'}>
  {#if !first}
    <Separator decorative={false} class="mb-roomy" />
  {/if}
  <h2 class="text-whisper font-medium uppercase tracking-widest text-ink-soft">{title}</h2>
  <div class="mt-comfortable space-y-comfortable">
    <slot />
  </div>
</section>
