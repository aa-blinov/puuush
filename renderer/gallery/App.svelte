<script>
  import { onMount } from 'svelte';
  import { Button, EmptyState, PageHeader } from '@monos/ui';
  import { lang, t } from '../shared/i18n.js';

  const bridge = window.puuush;
  let items = [];
  let loading = true;
  let error = '';
  let status = '';
  let filter = 'all';
  let preview = null;

  $: visibleItems = filter === 'all' ? items : items.filter((item) => item.kind === filter);

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

  async function act(item, action) {
    status = '';
    try {
      const result = await bridge.galleryAction(item.id, action);
      if (result && result.cancelled) return;
      if (!result || !result.ok) {
        if (result && result.reason === 'same-folder') {
          status = $t('ui.gallery.sameFolder');
          return;
        }
        status = $t(result && result.reason === 'clipboard'
          ? 'ui.gallery.copyFailed'
          : 'ui.gallery.unavailable');
        return;
      }
      status = $t(result.sourceRemains
        ? 'ui.gallery.sourceRemains'
        : action === 'copy-link' ? 'ui.gallery.linkCopied' : 'ui.gallery.actionDone');
      if (action === 'move-file') await load();
    } catch (e) {
      status = e && e.message ? e.message : $t('ui.gallery.actionFailed');
    }
  }

  function onKeydown(event) {
    if (event.key === 'Escape') preview = null;
  }

  function seekToVideoPreview(event) {
    const video = event.currentTarget;
    if (Number.isFinite(video.duration) && video.duration > 0) {
      // WebM often starts with a black frame; seek a fraction in so the card
      // shows the recording itself before the person presses play.
      video.currentTime = Math.min(0.25, video.duration / 2);
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="flex h-screen min-h-0 flex-col overflow-hidden bg-bg">
  <div class="page !max-w-6xl min-h-0 flex-1 overflow-y-auto">
  <PageHeader title={$t('ui.gallery.title')} description={$t('ui.gallery.description')}>
    <svelte:fragment slot="actions">
      <Button variant="secondary" loading={loading} on:click={load}>
        {$t('ui.gallery.refresh')}
      </Button>
    </svelte:fragment>
  </PageHeader>

  <main class="mt-roomy space-y-comfortable">
    <div class="flex flex-wrap items-center gap-3" role="group" aria-label={$t('ui.gallery.filter')}>
      {#each ['all', 'image', 'gif', 'video', 'file'] as option}
        <Button
          variant={filter === option ? 'primary' : 'secondary'}
          aria-pressed={filter === option}
          on:click={() => (filter = option)}
        >
          {$t(`ui.gallery.filter.${option}`)}
        </Button>
      {/each}
    </div>

    {#if status}
      <p class="text-xs text-ink-soft" role="status" aria-live="polite">{status}</p>
    {/if}

    {#if error}
      <EmptyState title={$t('ui.gallery.loadFailed')} description={error} />
    {:else if loading && !items.length}
      <p class="text-sm text-ink-soft" role="status">{$t('ui.gallery.loading')}</p>
    {:else if !visibleItems.length}
      <EmptyState
        title={$t(items.length ? 'ui.gallery.noMatches' : 'ui.gallery.emptyTitle')}
        description={$t(items.length ? 'ui.gallery.noMatchesDescription' : 'ui.gallery.emptyDescription')}
      />
    {:else}
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {#each visibleItems as item (item.id)}
          <article class="overflow-hidden rounded-ui border border-line bg-surface">
            <div class="gallery-preview flex aspect-video w-full items-center justify-center overflow-hidden bg-bg text-ink-soft">
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
              {:else if item.thumbnail}
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
              {:else}
                <span class="text-xs font-medium uppercase tracking-widest">{kindLabel(item.kind)}</span>
              {/if}
            </div>

            <div class="space-y-3 p-3">
              <div class="min-w-0">
                <p class="truncate text-sm font-medium text-ink" title={item.name}>{item.name}</p>
                <p class="mt-1 text-xs text-ink-soft">
                  {kindLabel(item.kind)}{item.at ? ` · ${dateLabel(item.at)}` : ''}
                  {item.host ? ` · ${item.host}` : ''}
                </p>
                {#if !item.exists && item.file}
                  <p class="mt-1 text-xs text-ink-faint">{$t('ui.gallery.fileMissing')}</p>
                {/if}
              </div>

              <div class="flex flex-wrap gap-x-3 gap-y-1">
                {#if item.exists}
                  <Button variant="text" size="sm" on:click={() => act(item, 'copy-file')}>
                    {$t(item.kind === 'image' ? 'ui.gallery.copyImage' : 'ui.gallery.copyFile')}
                  </Button>
                  <Button variant="text" size="sm" on:click={() => act(item, 'open-file')}>
                    {$t('ui.gallery.openFile')}
                  </Button>
                  <Button variant="text" size="sm" on:click={() => act(item, 'show-file')}>
                    {$t('ui.gallery.showFile')}
                  </Button>
                  <Button variant="text" size="sm" on:click={() => act(item, 'save-copy')}>
                    {$t('ui.gallery.saveCopy')}
                  </Button>
                  <Button variant="text" size="sm" on:click={() => act(item, 'move-file')}>
                    {$t('ui.gallery.moveFile')}
                  </Button>
                {/if}
                {#if item.url}
                  <Button variant="text" size="sm" on:click={() => act(item, 'copy-link')}>
                    {$t('ui.gallery.copyLink')}
                  </Button>
                  <Button variant="text" size="sm" on:click={() => act(item, 'open-link')}>
                    {$t('ui.gallery.openLink')}
                  </Button>
                {/if}
              </div>
              {#if bridge.platform !== 'win32' && item.exists && item.kind !== 'image' && item.kind !== 'gif'}
                <p class="text-xs leading-relaxed text-ink-faint">{$t('ui.gallery.copyFileHint')}</p>
              {/if}
            </div>
          </article>
        {/each}
      </div>
    {/if}
  </main>
  </div>
</div>

{#if preview}
  <dialog open aria-label={$t('ui.gallery.preview', { name: preview.name })} class="fixed inset-0 z-50 m-0 flex h-full max-h-full w-full max-w-none items-center justify-center border-0 p-6" style="background: var(--puuush-scrim)">
    <div class="max-h-full max-w-full space-y-3">
      <div class="flex justify-end">
        <Button variant="secondary" on:click={() => (preview = null)}>{$t('ui.gallery.closePreview')}</Button>
      </div>
      {#if preview.kind === 'video' && preview.mediaUrl}
        <!-- svelte-ignore a11y-media-has-caption -->
        <video
          class="max-h-[82vh] max-w-[88vw] rounded-ui border border-line bg-bg"
          src={preview.mediaUrl}
          controls
          playsinline
        ></video>
      {:else}
        <img
          class="max-h-[82vh] max-w-[88vw] rounded-ui border border-line bg-bg object-contain"
          src={preview.kind === 'gif' && preview.mediaUrl
            ? preview.mediaUrl
            : `data:image/jpeg;base64,${preview.thumbnail}`}
          alt={preview.name}
        />
      {/if}
    </div>
  </dialog>
{/if}
