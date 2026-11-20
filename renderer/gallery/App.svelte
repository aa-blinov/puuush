<script>
  import { onMount } from 'svelte';
  import { Button, EmptyState, PageHeader, SearchField, SegmentedControl } from '@monos/ui';
  import { lang, t } from '../shared/i18n.js';

  const bridge = window.puuush;

  let items = [];
  let loading = true;
  let error = '';
  let status = '';
  let filter = 'all';
  let query = '';
  let preview = null;
  let dialogEl = null;
  let gridEl = null;
  /** Раскрытый хвост файловых действий: id карточки. */
  let openTail = null;
  /** Рoving tabindex: в потоке таба стоит только одна карточка. */
  let focusIndex = 0;
  let statusTimer = null;

  // Язык документа следует за языком строк: читалка иначе произносит
  // английские слова по русским правилам, а html несёт вшитое значение.
  $: document.documentElement.lang = $lang;
  $: document.title = `puuush — ${$t('ui.gallery.title')}`;

  // Призрак не занимает карточку: файл, исчезнувший с диска, показывается
  // строкой ниже сетки, и живая сетка не стоит на треть пустыми ящиками.
  $: present = items.filter((item) => !item.file || item.exists);
  $: missing = items.filter((item) => item.file && !item.exists);
  $: queryLower = query.trim().toLowerCase();
  $: matchesFilter = (item) => filter === 'all' || item.kind === filter;
  $: visibleItems = present.filter((item) => matchesFilter(item) && (!queryLower || item.name.toLowerCase().includes(queryLower)));
  $: visibleMissing = missing.filter((item) => matchesFilter(item) && (!queryLower || item.name.toLowerCase().includes(queryLower)));
  $: filterOptions = buildFilterOptions($t);

  onMount(() => {
    load();
    bridge.onProgress((progress) => {
      if (progress && ['done', 'copied'].includes(progress.state)) load();
    });
  });

  async function load() {
    loading = true;
    error = '';
    try {
      items = await bridge.getGallery();
    } catch (e) {
      error = e && e.message ? e.message : $t('ui.gallery.loadFailed');
    } finally {
      loading = false;
    }
  }

  function buildFilterOptions(tr) {
    return ['all', 'image', 'gif', 'video', 'file'].map((value) => ({
      value,
      label: tr(`ui.gallery.filter.${value}`),
    }));
  }

  function kindLabel(kind) {
    return $t(`ui.gallery.kind.${kind}`);
  }

  function dateLabel(at) {
    if (!at) return '';
    return new Date(at).toLocaleString($lang === 'ru' ? 'ru-RU' : 'en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }

  /** Хост в метаданных — слово из словаря, а не внутренний ключ. */
  function hostLabel(host) {
    if (!host) return '';
    if (host === 'disk') return $t('ui.gallery.hostDisk');
    const key = `host.${host}`;
    const label = $t(key);
    return label === key ? host : label;
  }

  /**
   * Строка результата стирается сама: «Link copied» не должен висеть над
   * сеткой до следующего действия, как постер, потерявший смысл.
   */
  function setStatusLine(text) {
    status = text;
    if (statusTimer) clearTimeout(statusTimer);
    if (text) statusTimer = setTimeout(() => (status = ''), 6000);
  }

  /** Главное действие карточки: ссылка важнее всего, файл — запасной путь. */
  function primaryOf(item) {
    if (item.url) return { action: 'copy-link', label: $t('ui.gallery.copyLink') };
    if (item.exists) {
      return {
        action: 'copy-file',
        label: $t(item.kind === 'image' ? 'ui.gallery.copyImage' : 'ui.gallery.copyFile'),
      };
    }
    return null;
  }

  async function act(item, action) {
    setStatusLine('');
    try {
      const result = await bridge.galleryAction(item.id, action);
      if (result && result.cancelled) return;
      if (!result || !result.ok) {
        if (result && result.reason === 'same-folder') {
          setStatusLine($t('ui.gallery.sameFolder'));
          return;
        }
        setStatusLine($t(result && result.reason === 'clipboard'
          ? 'ui.gallery.copyFailed'
          : 'ui.gallery.unavailable'));
        return;
      }
      setStatusLine($t(result.sourceRemains
        ? 'ui.gallery.sourceRemains'
        : action === 'copy-link' ? 'ui.gallery.linkCopied' : 'ui.gallery.actionDone'));
      if (action === 'move-file') await load();
    } catch (e) {
      setStatusLine(e && e.message ? e.message : $t('ui.gallery.actionFailed'));
    }
  }

  /** Enter или Space на карточке: предпросмотр, а без него — главное действие. */
  function activate(item) {
    if (previewable(item)) {
      preview = item;
      openTail = null;
    } else {
      const primary = primaryOf(item);
      if (primary) act(item, primary.action);
    }
  }

  function previewable(item) {
    return !!(item.thumbnail || item.mediaUrl);
  }

  function closePreview() {
    if (dialogEl && dialogEl.open) dialogEl.close();
  }

  /** Стрелки ходят по сетке; колонки считаются по фактической раскладке. */
  function onCardKeydown(event, index, total) {
    const cards = gridEl ? gridEl.querySelectorAll('article') : [];
    if (!cards.length) return;
    const first = cards[0];
    const cols = Array.prototype.filter.call(cards, (c) => c.offsetTop === first.offsetTop).length;
    const move = (delta) => {
      const next = Math.min(total - 1, Math.max(0, index + delta));
      event.preventDefault();
      focusIndex = next;
      cards[next].focus();
    };
    if (event.key === 'ArrowRight') return move(1);
    if (event.key === 'ArrowLeft') return move(-1);
    if (event.key === 'ArrowDown') return move(cols);
    if (event.key === 'ArrowUp') return move(-cols);
    if (event.key === 'Home') return move(-index);
    if (event.key === 'End') return move(total - 1 - index);
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate(visibleItems[index]);
    }
  }

  function seekToVideoPreview(event) {
    const video = event.currentTarget;
    if (Number.isFinite(video.duration) && video.duration > 0) {
      // WebM often starts with a black frame; seek a fraction in so the card
      // shows the recording itself before the person presses play.
      video.currentTime = Math.min(0.25, video.duration / 2);
    }
  }

  // Нативный диалог закрывается Esc сам; событие close гасит состояние.
  function onDialogClose() {
    preview = null;
  }

  $: if (preview && dialogEl && !dialogEl.open) {
    // Модальность — родная: showModal держит фокус внутри затемнения,
    // а не выпускает его на страницу под ним.
    dialogEl.showModal();
  }
</script>

<svelte:window on:keydown={(event) => event.key === 'Escape' && closePreview()} />

<div class="flex h-screen min-h-0 flex-col overflow-hidden bg-bg">
  <div class="min-h-0 flex-1 overflow-y-auto">
  <div class="page !max-w-6xl">
  <PageHeader
    class="[&>div:last-child]:ml-auto [&>div:last-child]:justify-end"
    title={$t('ui.gallery.title')}
    description={$t('ui.gallery.description')}
  >
    <svelte:fragment slot="actions">
      <Button variant="secondary" loading={loading} on:click={load}>
        {$t('ui.gallery.refresh')}
      </Button>
    </svelte:fragment>
  </PageHeader>

  <main class="mt-roomy space-y-comfortable">
    <div class="flex flex-wrap items-center gap-3">
      <div class="w-full min-w-[180px] flex-1 sm:max-w-[280px]">
        <SearchField
          bind:value={query}
          placeholder={$t('ui.gallery.searchPlaceholder')}
          label={$t('ui.gallery.search')}
          size="sm"
        />
      </div>
      <SegmentedControl
        options={filterOptions}
        bind:value={filter}
        label={$t('ui.gallery.filter')}
        size="sm"
      />
    </div>

    {#if status}
      <p class="text-xs text-ink-soft" role="status" aria-live="polite">{status}</p>
    {/if}

    {#if error}
      <EmptyState title={$t('ui.gallery.loadFailed')} description={error} />
    {:else if loading && !items.length}
      <p class="text-sm text-ink-soft" role="status">{$t('ui.gallery.loading')}</p>
    {:else if !visibleItems.length && !visibleMissing.length}
      <EmptyState
        title={$t(items.length ? 'ui.gallery.noMatches' : 'ui.gallery.emptyTitle')}
        description={$t(items.length ? 'ui.gallery.noMatchesDescription' : 'ui.gallery.emptyDescription')}
      />
    {:else}
      {#if visibleItems.length}
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" bind:this={gridEl}>
          {#each visibleItems as item, index (item.id)}
            <article
              tabindex={index === focusIndex ? 0 : -1}
              on:focus={() => (focusIndex = index)}
              on:keydown={(event) => onCardKeydown(event, index, visibleItems.length)}
              class="overflow-hidden rounded-ui border border-line bg-surface transition-colors duration-fast focus-visible:outline-2 focus-visible:outline-ink"
            >
              {#if previewable(item)}
                <div class="flex aspect-video w-full items-center justify-center overflow-hidden bg-canvas text-ink-soft">
                  {#if item.kind === 'video' && item.mediaUrl}
                    <!-- svelte-ignore a11y-media-has-caption -->
                    <video
                      class="h-full w-full object-contain"
                      src={item.mediaUrl}
                      controls
                      preload="metadata"
                      playsinline
                      on:loadedmetadata={seekToVideoPreview}
                      aria-label={$t('ui.gallery.preview', { name: item.name })}
                    ></video>
                  {:else if item.kind === 'gif' && item.mediaUrl}
                    <button
                      type="button"
                      class="h-full w-full"
                      aria-label={$t('ui.gallery.preview', { name: item.name })}
                      on:click={() => (preview = item)}
                    >
                      <img class="h-full w-full object-contain" src={item.mediaUrl} alt={item.name} />
                    </button>
                  {:else}
                    <button
                      type="button"
                      class="h-full w-full"
                      aria-label={$t('ui.gallery.preview', { name: item.name })}
                      on:click={() => (preview = item)}
                    >
                      <img
                        class="h-full w-full object-contain"
                        src={`data:image/jpeg;base64,${item.thumbnail}`}
                        alt={item.name}
                      />
                    </button>
                  {/if}
                </div>
              {:else}
                <!-- Без превью карточка не жжёт ящик ради одного слова. -->
                <div class="flex h-16 w-full items-center justify-center border-b border-line bg-canvas text-ink-soft">
                  <span class="text-xs font-medium uppercase tracking-widest">{kindLabel(item.kind)}</span>
                </div>
              {/if}

              <div class="space-y-3 p-3">
                <div class="min-w-0">
                  <p class="truncate text-sm font-medium text-ink" title={item.name}>{item.name}</p>
                  <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-soft">
                    <span>{kindLabel(item.kind)}</span>
                    {#if item.at}<span>{dateLabel(item.at)}</span>{/if}
                    {#if item.host}<span>{hostLabel(item.host)}</span>{/if}
                  </div>
                </div>

                {#if primaryOf(item)}
                  <div class="flex flex-wrap items-center gap-3">
                    <Button
                      variant="primary"
                      size="sm"
                      on:click={() => act(item, primaryOf(item).action)}
                    >
                      {primaryOf(item).label}
                    </Button>
                    {#if item.exists}
                      <Button
                        variant="quiet"
                        size="sm"
                        aria-expanded={openTail === item.id}
                        on:click={() => (openTail = openTail === item.id ? null : item.id)}
                      >
                        {$t('ui.gallery.more')}
                      </Button>
                    {:else if item.url}
                      <!-- Ссылка без файла: файловых действий нет, остаётся открыть. -->
                      <Button variant="quiet" size="sm" on:click={() => act(item, 'open-link')}>
                        {$t('ui.gallery.openLink')}
                      </Button>
                    {/if}
                  </div>

                  {#if openTail === item.id && item.exists}
                    <div class="space-y-1 border-t border-line pt-2">
                      <div class="flex flex-wrap gap-x-4 gap-y-1">
                        {#if item.url}
                          <Button variant="quiet" size="sm" on:click={() => act(item, 'open-link')}>
                            {$t('ui.gallery.openLink')}
                          </Button>
                          <Button variant="quiet" size="sm" on:click={() => act(item, 'copy-file')}>
                            {$t(item.kind === 'image' ? 'ui.gallery.copyImage' : 'ui.gallery.copyFile')}
                          </Button>
                        {/if}
                        <Button variant="quiet" size="sm" on:click={() => act(item, 'open-file')}>
                          {$t('ui.gallery.openFile')}
                        </Button>
                        <Button variant="quiet" size="sm" on:click={() => act(item, 'show-file')}>
                          {$t('ui.gallery.showFile')}
                        </Button>
                        <Button variant="quiet" size="sm" on:click={() => act(item, 'save-copy')}>
                          {$t('ui.gallery.saveCopy')}
                        </Button>
                        <Button variant="quiet" size="sm" on:click={() => act(item, 'move-file')}>
                          {$t('ui.gallery.moveFile')}
                        </Button>
                      </div>
                      {#if bridge.platform !== 'win32' && item.kind !== 'image' && item.kind !== 'gif'}
                        <p class="text-xs leading-relaxed text-ink-faint">{$t('ui.gallery.copyFileHint')}</p>
                      {/if}
                    </div>
                  {/if}
                {/if}
              </div>
            </article>
          {/each}
        </div>
      {/if}

      {#if visibleMissing.length}
        <div class="space-y-base">
          <p class="text-xs font-medium uppercase tracking-widest text-ink-soft">
            {$t('ui.gallery.missingTitle')}
          </p>
          {#each visibleMissing as item (item.id)}
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-2">
              <p class="min-w-0 flex-1 truncate text-sm text-ink" title={item.name}>{item.name}</p>
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
                {#if item.at}<span>{dateLabel(item.at)}</span>{/if}
                {#if item.host}<span>{hostLabel(item.host)}</span>{/if}
              </div>
              {#if item.url}
                <div class="flex flex-wrap gap-x-4">
                  <Button variant="quiet" size="sm" on:click={() => act(item, 'copy-link')}>
                    {$t('ui.gallery.copyLink')}
                  </Button>
                  <Button variant="quiet" size="sm" on:click={() => act(item, 'open-link')}>
                    {$t('ui.gallery.openLink')}
                  </Button>
                </div>
              {/if}
            </div>
          {/each}
          <!-- Подсказка о копиях — один раз над строками, а не в каждой. -->
          <p class="text-xs leading-relaxed text-ink-faint">{$t('ui.gallery.fileMissing')}</p>
        </div>
      {/if}
    {/if}
  </main>
  </div>
  </div>
</div>

<dialog
  bind:this={dialogEl}
  aria-label={preview ? $t('ui.gallery.preview', { name: preview.name }) : undefined}
  class="fixed inset-0 z-50 m-0 flex h-full max-h-full w-full max-w-none items-center justify-center border-0 p-6"
  style="background: var(--puuush-scrim)"
  on:close={onDialogClose}
>
  {#if preview}
    <div class="max-h-full max-w-full space-y-3">
      {#if preview.kind === 'video' && preview.mediaUrl}
        <!-- svelte-ignore a11y-media-has-caption -->
        <video
          class="max-h-[78vh] max-w-[88vw] rounded-ui border border-line bg-bg"
          src={preview.mediaUrl}
          controls
          playsinline
        ></video>
      {:else}
        <img
          class="max-h-[78vh] max-w-[88vw] rounded-ui border border-line bg-bg object-contain"
          src={preview.kind === 'gif' && preview.mediaUrl
            ? preview.mediaUrl
            : `data:image/jpeg;base64,${preview.thumbnail}`}
          alt={preview.name}
        />
      {/if}
      <!-- Закрытие стоит под медиа, а не над ним: кнопка не спорит с кадром. -->
      <div class="flex items-center justify-end">
        <Button variant="secondary" on:click={closePreview}>{$t('ui.gallery.closePreview')}</Button>
      </div>
    </div>
  {/if}
</dialog>

<style>
  /* Последнее слово абзаца не висит одно на четвёртой строке: детектор
     помечал этот перенос в каждой подсказке. */
  p {
    text-wrap: pretty;
  }
  /* Нативный транспорт Chromium на тёмной карточке кричит своим светлым
     градиентом. Красим панель в цвет поверхности кита: контролы остаются
     системными, но перестают спорить с окном. */
  video::-webkit-media-controls-panel {
    background-color: color-mix(in srgb, var(--ui-surface, #3c3836) 94%, transparent);
  }
</style>
