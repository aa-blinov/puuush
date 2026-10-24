<script>
  /**
   * Окно настроек.
   *
   * Три правила, которые это окно обязано соблюдать:
   * 1. Окно не имеет права сказать «готово», когда операция не удалась.
   * 2. Любой отказ IPC обязан вернуть интерфейс в исходное состояние, а не
   *    оставить его в вечном ожидании.
   * 3. Всё, что можно сделать мышью, должно делаться с клавиатуры.
   *
   * Разметка собрана на ките @monos/ui: значения цветов не названы ни разу,
   * всё поведение живёт в состоянии, а разметка только показывает его.
   *
   * Слова приходят из словаря: $t('ui.close'). Язык по умолчанию английский,
   * русский включается здесь же, в первом разделе.
   */
  import {
    Badge,
    Button,
    Checkbox,
    EmptyState,
    FileUpload,
    Notice,
    PageHeader,
    SegmentedControl,
    SelectField,
    TextField,
  } from '@monos/ui';
  import SectionBlock from './lib/SectionBlock.svelte';
  import { fieldValue } from './lib/dom.js';
  import { keyFromEvent, prettyCombo } from './lib/hotkey.js';
  import { LANGS, lang, setLang, t } from '../shared/i18n.js';

  const bridge = window.puuush;
  const isMac = bridge.platform === 'darwin';
  // Автозапуск Electron умеет только на macOS и Windows: на Linux чекбокс
  // обещал бы то, чего не будет.
  const canLaunchAtLogin = isMac || bridge.platform === 'win32';

  /** Настройки целиком: то, что сервер вернул на последний запрос. */
  let settings = {};

  /** Список хостингов и варианты выпадающего списка. */
  let hosts = [];
  let hostOptions = [];

  /** Почему файл настроек не прочитан. Пусто — значит, всё в порядке. */
  let brokenReason = '';

  /** Строка состояния операции: что делаем и чем кончилось. */
  let status = { kind: '', text: '', url: '' };

  /** Ответ на проверку своего сервера. */
  let serverState = { kind: '', text: '' };

  /** История ссылок. */
  let historyItems = [];

  /** Поля формы. Тексты двух комбинаций: сама комбинация или подсказка про запись. */
  let hotkeyTexts = { hotkey: '', imageHotkey: '' };
  /** Поле, которое ждёт новую комбинацию, либо null. */
  let listening = null;
  let host = 'auto';
  let ownUrl = '';
  let ownKey = '';
  let keyVisible = false;
  let saveDir = '';
  let openAfterUpload = false;
  let keepLocalCopy = true;
  let launchAtLogin = false;

  /** Служебное. */
  let ownUrlInvalid = false;
  let verifying = false;
  let historyError = '';
  /** Файл, взятый перетаскиванием или диалогом. */
  let picked = [];

  // -------------------------------------------------------------------------
  // Производные значения
  // -------------------------------------------------------------------------

  $: ownVisible = host === 'own' || host === 'auto';
  $: ownReady = Boolean(ownUrl.trim() && ownKey.trim());
  $: nextTarget = describeNextTarget(host, ownReady, hosts, $t);
  $: stateTag = describeStateTag(status.kind, $t);
  $: hostOptions = buildHostOptions(hosts, $t);

  /**
   * Подпись хостинга для человека.
   *
   * Внутри приложения хостинг зовется коротким именем, а человек видит
   * понятное: свой сервер, catbox, uguu.
   */
  function hostLabel(name) {
    // Старая история хранила «свой box» до того, как у своего сервера
    // появилось внутреннее имя. Старые строки не должны выглядеть по-русски
    // в английском окне.
    const id = name === 'свой box' ? 'own' : name;
    const key = `host.${id}`;
    const label = $t(key);
    return label === key ? id : label;
  }

  function buildHostOptions(list, tr) {
    return [
      { value: 'auto', label: tr('ui.hostAuto', { hosts: list.map((h) => h.name).join(', ') }) },
      ...list.map((h) => ({ value: h.name, label: tr(`host.${h.name}`) })),
      { value: 'own', label: tr('ui.hostOwnOnly') },
    ];
  }

  /**
   * Куда уйдёт следующий снимок.
   *
   * Свою приватность обещать можно только когда сервер реально настроен.
   * В режиме «авто» пустой сервер молча пропускается, и файл уходит на
   * публичный хостинг — раньше здесь стояло «уйдёт на свой сервер», и на
   * чистой установке это была ложь ровно в том месте, где продукт обещает
   * человеку приватность.
   */
  function describeNextTarget(currentHost, ready, list, tr) {
    if (currentHost === 'own') {
      return {
        text: ready ? tr('ui.next.ownReady') : tr('ui.next.ownMissing'),
        warn: false,
      };
    }
    if (currentHost === 'auto') {
      return {
        text: ready ? tr('ui.next.autoReady') : tr('ui.next.autoMissing'),
        warn: !ready,
      };
    }
    const option = list.find((item) => item.name === currentHost);
    const name = option ? tr(`host.${option.name}`) : tr('ui.status.host');
    return { text: tr('ui.next.public', { host: name }), warn: true };
  }

  /** Слово состояния операции: цвет несёт точка, слово остаётся читаемым. */
  function describeStateTag(kind, tr) {
    if (kind === 'bad') return { label: tr('ui.state.bad'), tone: 'danger' };
    if (kind === 'ok') return { label: tr('ui.state.ok'), tone: 'success' };
    if (kind === 'busy') return { label: tr('ui.state.busy'), tone: 'accent' };
    return { label: tr('ui.state.ready'), tone: 'neutral' };
  }

  // -------------------------------------------------------------------------
  // Статус
  // -------------------------------------------------------------------------

  function setStatus(text, kind = '', url = '') {
    status = { kind, text, url };
  }

  function clearStatus() {
    setStatus('');
  }

  function fail(message) {
    setStatus(message, 'bad');
  }

  // -------------------------------------------------------------------------
  // Сохранение
  // -------------------------------------------------------------------------

  /** Раскладывает настройки по полям формы. */
  function applySettings(next) {
    settings = next;
    hotkeyTexts = {
      hotkey: prettyCombo(next.hotkey, isMac),
      imageHotkey: prettyCombo(next.imageHotkey, isMac),
    };
    host = next.host;
    ownUrl = (next.own && next.own.base_url) || '';
    ownKey = (next.own && next.own.write_key) || '';
    openAfterUpload = !!next.openAfterUpload;
    keepLocalCopy = next.keepLocalCopy !== false;
    launchAtLogin = !!next.launchAtLogin;
    saveDir = next.saveDir || '';
    // Язык меняем вместе с настройками: окно перерисовывается само, а
    // главный процесс узнаёт о новом языке из сохранения.
    if (next.lang) setLang(next.lang);
  }

  /**
   * Сохраняет правку.
   *
   * При отказе поля возвращаются к тому, что действительно лежит на диске:
   * показывать несохранённое значение нельзя, после перезапуска всё откатится.
   */
  async function save(patch) {
    try {
      settings = await bridge.saveSettings(patch);
      return true;
    } catch (e) {
      fail(e && e.message ? e.message : $t('ui.saveFailed'));
      try {
        applySettings(await bridge.getSettings());
      } catch (ignored) {
        /* файл настроек недоступен целиком, баннер об этом уже показан */
      }
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Язык
  // -------------------------------------------------------------------------

  /**
   * Переключение языка.
   *
   * Язык сохраняется тем же запросом, что и остальные настройки: отдельный
   * канал означал бы, что язык может разойтись с остальным файлом.
   */
  async function onLangChange(event) {
    const next = event && event.detail ? event.detail.value : $lang;
    setLang(next);
    if (!(await save({ lang: next }))) {
      // Сохранение не вышло: язык возвращается к тому, что на диске.
      applySettings(settings);
      return;
    }
    // Список хостингов приходит с подписями главного процесса, а значит
    // тоже должен быть перечитан на новом языке.
    await initHosts();
  }

  // -------------------------------------------------------------------------
  // Хоткей
  // -------------------------------------------------------------------------

  function startListening(field) {
    listening = field;
    hotkeyTexts = { ...hotkeyTexts, [field]: $t('ui.hotkey.listening') };
  }

  function stopListening() {
    if (!listening) return;
    const field = listening;
    listening = null;
    hotkeyTexts = { ...hotkeyTexts, [field]: prettyCombo(settings[field], isMac) };
  }

  async function onWindowKeydown(event) {
    if (listening) {
      // Tab должен уводить с поля. Раньше preventDefault срабатывал на любую
      // клавишу, и из режима прослушивания нельзя было выйти с клавиатуры.
      if (event.key === 'Tab') return stopListening();
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') return stopListening();
      if (event.key === 'Backspace' || event.key === 'Delete') return stopListening();
      const combo = keyFromEvent(event);
      // Обязателен хотя бы один модификатор. Без него globalShortcut забирает
      // клавишу у всех приложений сразу: Enter перестаёт работать везде,
      // включая это окно, из которого его только что выбрали.
      // Shift один не считается: Shift+A отнял бы заглавную A у всех программ.
      if (!combo || !combo.split('+').slice(0, -1).some((p) => p !== 'Shift')) return;
      const field = listening;
      stopListening();
      const ok = await save({ [field]: combo });
      // Флаг применения называется по полю: hotkeyApplied, imageHotkeyApplied.
      const taken = ok && settings && settings[`${field}Applied`] === false;
      if (taken) {
        // Главный процесс откатил поле на прежнюю комбинацию и занял её заново:
        // в поле остаётся она, а не та, что занята.
        fail($t('ui.hotkeyTaken', { hotkey: prettyCombo(combo, isMac) }));
      }
      if (!ok || taken) {
        // save() при отказе перечитал настоящие настройки, но оптимистично
        // присвоенное значение комбинации затирало их обратно: поле показывало
        // комбинацию, которой на самом деле нет.
        hotkeyTexts = { ...hotkeyTexts, [field]: prettyCombo(settings[field], isMac) };
        return;
      }
      hotkeyTexts = { ...hotkeyTexts, [field]: prettyCombo(combo, isMac) };
      return;
    }
    // Escape занят записью хоткея и закрывать не должен.
    if (event.key === 'w' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      bridge.closeSelf();
    }
  }

  async function testHotkey() {
    try {
      const applied = await bridge.reapplyHotkey();
      const fields = ['hotkey', 'imageHotkey'];
      const shown = fields.map((f) => prettyCombo(settings[f], isMac));
      const taken = fields.filter((f) => !applied[f]).map((f) => prettyCombo(settings[f], isMac));
      setStatus(
        taken.length
          ? $t('ui.hotkeyTaken', { hotkey: taken.join(', ') })
          : $t('ui.hotkeyOk', { hotkey: shown.join(', ') }),
        taken.length ? 'bad' : 'ok'
      );
    } catch (e) {
      fail(e && e.message ? e.message : $t('ui.hotkeyCheckFailed'));
    }
  }

  // -------------------------------------------------------------------------
  // Хостинг
  // -------------------------------------------------------------------------

  async function onHostChange(event) {
    await save({ host: fieldValue(event, host) });
  }

  async function onOwnUrlChange(event) {
    serverState = { kind: '', text: '' };
    ownUrlInvalid = false;
    const value = fieldValue(event, ownUrl.trim());
    await save({ own: { base_url: value } });
  }

  async function onOwnKeyChange(event) {
    serverState = { kind: '', text: '' };
    const value = fieldValue(event, ownKey.trim());
    await save({ own: { write_key: value } });
  }

  function toggleKeyVisibility() {
    keyVisible = !keyVisible;
  }

  /**
   * Склонение числительного: 1 файл, 2 файла, 5 файлов.
   *
   * Правило разное: в русском после 1 идёт один, после 2-4 — два, после
   * остальных — много; в английском после 1 один, после остальных много.
   */
  function plural(n) {
    const one = $t('ui.files.one');
    const few = $t('ui.files.few');
    const many = $t('ui.files.many');
    if ($lang === 'ru') {
      const m10 = n % 10;
      const m100 = n % 100;
      if (m10 === 1 && m100 !== 11) return one;
      if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
      return many;
    }
    return n === 1 ? one : many;
  }

  /** Размер для человека: килобайты до мегабайта, потом мегабайты. */
  function humanSize(bytes) {
    if (bytes < 1048576) {
      return `${Math.max(1, Math.round(bytes / 1024))} ${$t('ui.size.kb')}`;
    }
    return `${Math.round(bytes / 1048576)} ${$t('ui.size.mb')}`;
  }

  async function checkServer() {
    ownUrlInvalid = false;
    serverState = { kind: '', text: $t('ui.server.checking') };
    verifying = true;
    const own = { base_url: ownUrl.trim(), write_key: ownKey.trim() };
    try {
      // Сохраняем раньше проверки: поля пишутся по уходу фокуса, и без этого
      // проверка ушла бы на старый адрес. Отказ сохранения проверку отменяет,
      // иначе рядом встанут зелёная и красная строки о разных вещах.
      if (!(await save({ own }))) {
        serverState = { kind: 'bad', text: $t('ui.server.saveFailed') };
        return;
      }
      try {
        const r = await bridge.verifyServer(own);
        const files = r && r.files != null ? r.files : null;
        const size = r && r.bytes != null ? humanSize(r.bytes) : null;
        serverState = {
          kind: 'ok',
          text:
            files == null
              ? $t('ui.server.ok')
              : $t('ui.server.okFiles', {
                  count: files,
                  word: plural(files),
                  size,
                }),
        };
        brokenReason = '';
      } catch (e) {
        // Поле адреса помечается, когда проверка провалилась: красный контур видно
        // без чтения строки.
        ownUrlInvalid = true;
        // Electron добавляет к ошибке IPC служебный префикс: пользователю он не нужен.
        const raw = e && e.message ? e.message : String(e);
        const detail = raw.replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
        serverState = { kind: 'bad', text: $t('ui.server.bad', { detail }) };
      }
    } finally {
      // Пока проверка идёт, кнопка заблокирована: повторный клик слал бы второй запрос.
      verifying = false;
    }
  }

  // -------------------------------------------------------------------------
  // Поведение
  // -------------------------------------------------------------------------

  async function onOpenAfterUploadChange() {
    await save({ openAfterUpload });
  }

  async function onKeepLocalCopyChange() {
    await save({ keepLocalCopy });
  }

  async function onLaunchAtLoginChange() {
    await save({ launchAtLogin });
  }

  async function onSaveDirChange(event) {
    const value = fieldValue(event, saveDir.trim());
    await save({ saveDir: value });
  }

  async function pickDir() {
    try {
      const dir = await bridge.chooseDir();
      if (!dir) return;
      saveDir = dir;
      await save({ saveDir: dir });
    } catch (e) {
      fail(e && e.message ? e.message : $t('ui.chooseFailed'));
    }
  }

  // -------------------------------------------------------------------------
  // Загрузка: три равноправных пути
  // -------------------------------------------------------------------------

  async function runUpload(label, run) {
    clearStatus();
    setStatus(label, 'busy');
    try {
      const r = await run();
      if (!r || !r.url) {
        fail($t('ui.status.noUrl', { label }));
        return null;
      }
      // Тот же разбор, что и в onProgress: ручные пути не должны быть мягче
      // хоткей-пути. Раньше privacyDowngraded здесь просто игнорировался.
      const downgraded = r.privacyDowngraded;
      const head = downgraded
        ? $t('ui.status.downgraded', { host: hostLabel(r.host) })
        : (r.copied === false ? $t('ui.status.clipboardBusy') : hostLabel(r.host));
      setStatus(
        `${head}${r.temp ? $t('ui.status.temp') : ''}` +
          (r.copied === false ? $t('ui.status.copyNote') : $t('ui.status.copiedNote')),
        r.copied === false || downgraded ? 'bad' : 'ok',
        r.url
      );
      await loadHistory();
      return r;
    } catch (e) {
      // Раньше здесь исключение пролетало мимо, и метка навсегда зависала
      // на «загружаю…»: второй клик не помогал, состояние не восстанавливалось.
      fail($t('ui.status.failed', { label, error: e && e.message ? e.message : e }));
      return null;
    }
  }

  async function uploadClipboard() {
    await runUpload($t('ui.status.uploadingClipboard'), () => bridge.uploadClipboardImage());
  }

  /** Файл выбран перетаскиванием или диалогом: сразу уходит в загрузку. */
  async function onFilesPicked(event) {
    const list = (event && event.detail) || [];
    // Список в поле вкладки нужен только чтобы показать, что файл взяли;
    // после загрузки он снова пуст.
    picked = [];
    // Все файлы по очереди: раньше брался только первый, остальные терялись.
    for (const file of list) {
      const path = bridge.pathForFile(file);
      if (!path) return fail($t('ui.status.noPath'));
      await runUpload($t('ui.status.uploadingFile'), () => bridge.uploadFile(path));
    }
  }

  // -------------------------------------------------------------------------
  // История
  // -------------------------------------------------------------------------

  /** Подпись строки истории: источник, время и срок жизни файла. */
  function historyMeta(item) {
    const when = new Date(item.at).toLocaleString($lang === 'ru' ? 'ru-RU' : 'en-GB', {
      day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    const life = item.temp
      ? $t('ui.history.temp')
      : (item.expiresAt
        ? $t('ui.history.until', { date: new Date(item.expiresAt).toLocaleDateString($lang === 'ru' ? 'ru-RU' : 'en-GB') })
        : $t('ui.history.permanent'));
    return `${item.source || hostLabel(item.host)} · ${when} · ${life}`;
  }

  function copyUrl(url) {
    bridge.copyText(url);
    setStatus($t('ui.status.copied'), 'ok');
  }

  async function loadHistory() {
    let list = [];
    try {
      list = await bridge.getHistory();
    } catch (e) {
      historyItems = [];
      historyError = $t('ui.history.unreadable');
      return;
    }
    historyError = '';
    historyItems = list;
  }

  async function clearHistory() {
    // Удаление истории необратимо, а спрятано внизу окна.
    if (!window.confirm($t('ui.history.confirmClear'))) return;
    clearStatus();
    try {
      await bridge.clearHistory();
    } catch (e) {
      fail(e && e.message ? e.message : $t('ui.history.clearFailed'));
    }
    await loadHistory();
  }

  // -------------------------------------------------------------------------
  // Статусы из главного процесса
  // -------------------------------------------------------------------------

  bridge.onProgress((p) => {
    if (!p) return;
    if (p.state === 'step') {
      // Главный процесс шлёт сюда человеческие причины («сервер отверг ключ»,
      // «ссылка не вывозит файл»). Раньше они уходили в никуда.
      if (p.message) setStatus(p.message, 'busy');
    } else if (p.state === 'capturing') setStatus($t('ui.status.progressCapturing'), 'busy');
    else if (p.state === 'captured') setStatus($t('ui.status.progressCaptured'), 'busy');
    else if (p.state === 'copied') setStatus($t('note.imageInClipboard'), 'ok');
    else if (p.state === 'error') fail(p.message);
    else if (p.state === 'done') {
      // Главный процесс уже знает, копировалась ли ссылка и не уехала ли она
      // на публичный хостинг. Раньше эти поля игнорировались, и окно врало.
      const head = p.privacyDowngraded
        ? $t('ui.status.downgraded', { host: hostLabel(p.host) })
        : (p.copied === false ? $t('ui.status.clipboardBusy') : hostLabel(p.host));
      setStatus(
        `${head}${p.temp ? $t('ui.status.temp') : ''}` +
          (p.copied === false ? $t('ui.status.copyNote') : $t('ui.status.copiedNote')),
        p.copied === false || p.privacyDowngraded ? 'bad' : 'ok',
        p.url
      );
    }
  });

  // -------------------------------------------------------------------------
  // Старт
  // -------------------------------------------------------------------------

  async function initHosts() {
    hosts = await bridge.hosts();
  }

  (async function init() {
    try {
      const broken = await bridge.brokenSettings();
      if (broken) brokenReason = broken;
    } catch (e) {
      /* канал мог не ответить, покажем это отдельно */
    }

    try {
      applySettings(await bridge.getSettings());
    } catch (e) {
      // Раньше исключение уходило в консоль, и форма выглядела готовой с
      // пустыми полями. Теперь это видно.
      brokenReason = $t('ui.brokenReason', { error: e && e.message ? e.message : e });
      fail($t('ui.readFailed'));
      return;
    }

    try {
      await initHosts();
    } catch (e) {
      fail($t('ui.hostsFailed', { error: e && e.message ? e.message : e }));
      return;
    }

    await loadHistory();
  })();
</script>

<!-- Файл, брошенный мимо зоны загрузки, иначе открылся бы в самом окне. -->
<svelte:window on:keydown={onWindowKeydown} on:dragover|preventDefault on:drop|preventDefault />

<div class="page">
  <PageHeader
    class="[&>div:first-child]:max-w-[30rem]"
    title="puuush"
    description={$t('ui.description')}
  >
    <svelte:fragment slot="actions">
      <Button variant="quiet" on:click={() => bridge.closeSelf()}>{$t('ui.close')}</Button>
    </svelte:fragment>
  </PageHeader>

  {#if brokenReason}
    <div class="mt-4">
      <Notice tone="danger" title={$t('ui.brokenTitle')}>
        <p>{brokenReason}</p>
        <p class="mt-1">{$t('ui.brokenBody')}</p>
      </Notice>
    </div>
  {/if}

  <main class="mt-6">
    <SectionBlock title={$t('ui.section.language')} first>
      <SegmentedControl
        label={$t('ui.section.language')}
        options={LANGS}
        value={$lang}
        on:change={onLangChange}
      />
      <p class="mt-1.5 text-xs leading-relaxed text-ink-soft">{$t('ui.hint.language')}</p>
    </SectionBlock>

    <SectionBlock title={$t('ui.section.hotkey')}>
      <TextField
        id="hotkey"
        label={$t('ui.field.snapshot')}
        value={hotkeyTexts.hotkey}
        readonly
        spellcheck="false"
        on:focus={() => startListening('hotkey')}
        on:blur={stopListening}
      />
      <div class="mt-3">
        <TextField
          id="imageHotkey"
          label={$t('ui.field.image')}
          value={hotkeyTexts.imageHotkey}
          readonly
          spellcheck="false"
          on:focus={() => startListening('imageHotkey')}
          on:blur={stopListening}
        />
      </div>
      <div class="mt-3">
        <Button variant="secondary" on:click={testHotkey}>
          {$t('ui.button.check')}
        </Button>
      </div>
      <p class="mt-1.5 text-xs leading-relaxed text-ink-soft">{$t('ui.hint.hotkey')}</p>
    </SectionBlock>

    <SectionBlock title={$t('ui.section.hosting')}>
      <SelectField
        id="host"
        label={$t('ui.field.hosting')}
        bind:value={host}
        options={hostOptions}
        on:change={onHostChange}
      />
      <p
        class="mt-1.5 text-xs leading-relaxed {nextTarget.warn
          ? 'font-medium text-ink'
          : 'text-ink-soft'}"
        aria-live="polite"
      >
        {nextTarget.text}
      </p>

      <div id="ownBox" class="mt-4 space-y-3" style:display={ownVisible ? 'block' : 'none'}>
        <TextField
          id="ownUrl"
          label={$t('ui.field.ownServer')}
          placeholder={$t('ui.field.ownUrlPlaceholder')}
          bind:value={ownUrl}
          aria-invalid={ownUrlInvalid ? 'true' : undefined}
          on:change={onOwnUrlChange}
        />

        <div class="flex items-end gap-3">
          <div class="min-w-0 flex-1">
            <TextField
              id="ownKey"
              label={$t('ui.field.writeKey')}
              type={keyVisible ? 'text' : 'password'}
              autocomplete="off"
              spellcheck="false"
              placeholder={$t('ui.field.writeKeyPlaceholder')}
              bind:value={ownKey}
              on:change={onOwnKeyChange}
            />
          </div>
          <Button
            variant="secondary"
            class="shrink-0"
            aria-pressed={keyVisible}
            on:click={toggleKeyVisibility}
          >
            {keyVisible ? $t('ui.button.hide') : $t('ui.button.show')}
          </Button>
          <Button
            variant="secondary"
            class="shrink-0"
            loading={verifying}
            on:click={checkServer}
          >
            {$t('ui.button.checkServer')}
          </Button>
        </div>

        {#if serverState.text}
          <p
            class="text-xs leading-relaxed {serverState.kind === 'bad'
              ? 'text-danger-text'
              : serverState.kind === 'ok'
                ? 'text-success-text'
                : 'text-ink-soft'}"
            role="status"
            aria-live="polite"
          >
            {serverState.text}
          </p>
        {/if}
        <p class="text-xs leading-relaxed text-ink-soft">
          {$t(host === 'own' ? 'ui.hint.keyOwn' : 'ui.hint.key', { method: 'POST /v1/uploads' })}
        </p>
      </div>
    </SectionBlock>

    <SectionBlock title={$t('ui.section.behaviour')}>
      <div class="space-y-3">
        <div>
          <Checkbox id="openAfterUpload" bind:checked={openAfterUpload} on:change={onOpenAfterUploadChange}>
            {$t('ui.check.openInBrowser')}
          </Checkbox>
        </div>
        <div>
          <Checkbox id="keepLocalCopy" bind:checked={keepLocalCopy} on:change={onKeepLocalCopyChange}>
            {$t('ui.check.keepLocalCopy')}
          </Checkbox>
        </div>
        {#if canLaunchAtLogin}
          <div>
            <Checkbox id="launchAtLogin" bind:checked={launchAtLogin} on:change={onLaunchAtLoginChange}>
              {$t('ui.check.launchAtLogin')}
            </Checkbox>
            <p class="mt-1 text-xs leading-relaxed text-ink-soft">{$t('ui.hint.launchAtLogin')}</p>
          </div>
        {/if}

        <div class="flex items-end gap-3">
          <div class="min-w-0 flex-1">
            <TextField
              id="saveDir"
              label={$t('ui.field.saveDir')}
              placeholder={$t('ui.field.saveDirPlaceholder')}
              bind:value={saveDir}
              on:change={onSaveDirChange}
            />
          </div>
          <Button variant="secondary" class="shrink-0" on:click={pickDir}>
            {$t('ui.button.choose')}
          </Button>
        </div>
      </div>
      <p class="mt-1.5 text-xs leading-relaxed text-ink-soft">{$t('ui.hint.behaviour')}</p>
    </SectionBlock>

    <SectionBlock title={$t('ui.section.upload')}>
      <FileUpload
        label={$t('ui.upload.label')}
        chooseLabel={$t('ui.upload.chooseLabel')}
        bind:files={picked}
        on:change={onFilesPicked}
      />
      <div class="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="secondary" on:click={uploadClipboard}>
          {$t('ui.button.fromClipboard')}
        </Button>
        <Badge tone={stateTag.tone}>{stateTag.label}</Badge>
      </div>

      {#if status.text || status.url}
        <div class="mt-3">
          <Notice tone={status.kind === 'bad' ? 'danger' : status.kind === 'ok' ? 'success' : 'info'}>
            {#if status.url}
              <p class="break-url text-ink">{status.url}</p>
            {/if}
            {#if status.text}
              <p class={status.url ? 'mt-1' : ''}>{status.text}</p>
            {/if}
          </Notice>
        </div>
      {/if}
    </SectionBlock>

    <SectionBlock title={$t('ui.section.history')}>
      {#if historyError}
        <div class="rounded-ui border border-line">
          <EmptyState title={historyError} />
        </div>
      {:else if historyItems.length}
        <ul class="divide-y divide-line border-y border-line">
          {#each historyItems as item (item.url + String(item.at))}
            <li class="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <button
                type="button"
                class="break-url min-w-0 flex-1 text-left text-xs text-ink-soft transition-colors duration-fast hover:text-ink"
                title={$t('ui.history.copyTitle')}
                on:click={() => copyUrl(item.url)}
              >
                {item.url}
              </button>
              <span class="shrink-0 whitespace-nowrap text-xs text-ink-faint">
                {historyMeta(item)}
              </span>
              <Button variant="text" size="sm" on:click={() => bridge.openExternal(item.url)}>
                {$t('ui.button.open')}
              </Button>
            </li>
          {/each}
        </ul>
      {:else}
        <div class="rounded-ui border border-line">
          <EmptyState
            title={$t('ui.history.emptyTitle')}
            description={$t('ui.history.emptyDescription')}
          />
        </div>
      {/if}
      <div class="mt-3 flex justify-end">
        <Button variant="danger" on:click={clearHistory}>{$t('ui.button.clearHistory')}</Button>
      </div>
    </SectionBlock>
  </main>
</div>
