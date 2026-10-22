<script>
  /**
   * Текст с клавишами.
   *
   * Подсказка окна выбора области перечисляет клавиши, и клавиши должны
   * выглядеть клавишами: отдельной капсой, а не буквами в предложении. Поэтому
   * предложение лежит в словаре целиком, а на местах {confirm}, {cancel} и
   * {space} встаёт настоящая клавиша.
   */
  import { Kbd } from '@monos/ui';

  export let text = '';

  const KEYS = { confirm: 'Enter', cancel: 'Esc', space: 'Space' };

  $: parts = text.split(/(\{confirm\}|\{cancel\}|\{space\})/).filter(Boolean);
</script>

{#each parts as part}
  {#if KEYS[part.replace(/[{}]/g, '')]}
    <Kbd>{KEYS[part.replace(/[{}]/g, '')]}</Kbd>
  {:else}{part}{/if}
{/each}
