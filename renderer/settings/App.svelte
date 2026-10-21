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
   */
  import {
    Badge,
    Button,
    Checkbox,
    EmptyState,
    FileUpload,
    Notice,
    PageHeader,
    SelectField,
    TextField,
  } from '@monos/ui';
  import SectionBlock from './lib/SectionBlock.svelte';
  import { fieldValue } from './lib/dom.js';
  import { keyFromEvent, prettyCombo } from './lib/hotkey.js';

  const bridge = window.puuush;
  const isMac = bridge.platform === 'darwin';

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

  /** Поля формы. */
  let hotkeyText = '';
  let listening = false;
  let host = 'auto';
  let ownUrl = '';
  let ownKey = '';
  let keyVisible = false;
  let saveDir = '';
  let openAfterUpload = false;
  let keepLocalCopy = true;

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
  $: nextTarget = describeNextTarget(host, ownReady, hostOptions);
  $: stateTag = describeStateTag(status.kind);

  /**
   * Куда уйдёт следующий снимок.
   *
   * Свою приватность обещать можно только когда сервер реально настроен.
   * В режиме «авто» пустой сервер молча пропускается, и файл уходит на
   * публичный хостинг — раньше здесь стояло «уйдёт на свой сервер», и на
   * чистой установке это была ложь ровно в том месте, где продукт обещает
   * человеку приватность.
   */
  function describeNextTarget(currentHost, ready, options) {
    if (currentHost === 'own') {
      return {
        text: ready
          ? 'Следующий снимок уйдёт на свой сервер. Если он недоступен, загрузка не состоится.'
          : 'Свой сервер не настроен: заполни адрес и ключ, иначе снимок не загрузится.',
        warn: false,
      };
    }
    if (currentHost === 'auto') {
      return {
        text: ready
          ? 'Следующий снимок уйдёт на свой сервер, а если он недоступен — на внешний хостинг.'
          : 'Свой сервер не настроен, следующий снимок уйдёт на публичный внешний хостинг.',
        warn: !ready,
      };
    }
    const option = options.find((item) => item.value === currentHost);
    // В подписи варианта уже есть «— постоянно», второй раз повторять не нужно.
    const name = option ? option.label.split('—')[0].trim() : 'выбранный хостинг';
    return { text: `Следующий снимок уйдёт на ${name}, это публичный хостинг.`, warn: true };
  }

  /** Слово состояния операции: цвет несёт точка, слово остаётся читаемым. */
  function describeStateTag(kind) {
    if (kind === 'bad') return { label: 'ошибка', tone: 'danger' };
    if (kind === 'ok') return { label: 'принято', tone: 'success' };
    if (kind === 'busy') return { label: 'работаю', tone: 'accent' };
    return { label: 'готов', tone: 'neutral' };
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
    hotkeyText = prettyCombo(next.hotkey, isMac);
    host = next.host;
    ownUrl = (next.own && next.own.base_url) || '';
    ownKey = (next.own && next.own.write_key) || '';
    openAfterUpload = !!next.openAfterUpload;
    keepLocalCopy = next.keepLocalCopy !== false;
    saveDir = next.saveDir || '';
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
      fail(e && e.message ? e.message : 'настройки не сохранились');
      try {
        applySettings(await bridge.getSettings());
      } catch (ignored) {
        /* файл настроек недоступен целиком, баннер об этом уже показан */
      }
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Хоткей
  // -------------------------------------------------------------------------

  function startListening() {
    listening = true;
    hotkeyText = 'комбинация… Esc — отмена';
  }

  function stopListening() {
    if (!listening) return;
    listening = false;
    hotkeyText = prettyCombo(settings.hotkey, isMac);
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
      if (!combo || !combo.includes('+')) return;
      stopListening();
      const ok = await save({ hotkey: combo });
      if (ok && settings && settings.hotkeyApplied === false) {
        // Записалось, но занять клавишу не вышло: в приложении работает старая
        // комбинация, а поле показывало бы новую.
        fail(`не удалось занять ${prettyCombo(combo, isMac)}, её держит другая программа`);
      }
      if (!ok) {
        // save() при отказе перечитал настоящие настройки, но оптимистично
        // присвоенное значение комбинации затирало их обратно: поле показывало
        // комбинацию, которой на самом деле нет.
        hotkeyText = prettyCombo(settings.hotkey, isMac);
        return;
      }
      hotkeyText = prettyCombo(combo, isMac);
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
      const ok = await bridge.reapplyHotkey();
      const shown = prettyCombo(settings.hotkey, isMac);
      setStatus(
        ok ? `хоткей ${shown} занять удалось`
           : `не удалось занять ${shown}, его держит другая программа`,
        ok ? 'ok' : 'bad'
      );
    } catch (e) {
      fail(e && e.message ? e.message : 'проверка не удалась');
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

  /** Русское склонение: 1 файл, 2 файла, 5 файлов. */
  function plural(n, one, few, many) {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  /** Размер для человека: килобайты до мегабайта, потом мегабайты. */
  function humanSize(bytes) {
    if (bytes < 1048576) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
    return `${Math.round(bytes / 1048576)} МБ`;
  }

  async function checkServer() {
    ownUrlInvalid = false;
    serverState = { kind: '', text: 'проверяю…' };
    verifying = true;
    const own = { base_url: ownUrl.trim(), write_key: ownKey.trim() };
    try {
      // Сохраняем раньше проверки: поля пишутся по уходу фокуса, и без этого
      // проверка ушла бы на старый адрес. Отказ сохранения проверку отменяет,
      // иначе рядом встанут зелёная и красная строки о разных вещах.
      if (!(await save({ own }))) {
        serverState = { kind: 'bad', text: 'настройки не сохранились, проверка отменена' };
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
              ? 'сервер отвечает, ключ подходит.'
              : `сервер отвечает, ключ подходит. На нём ${files} ${plural(files, 'файл', 'файла', 'файлов')}, ${size}.`,
        };
        brokenReason = '';
      } catch (e) {
        // Поле адреса помечается, когда проверка провалилась: красный контур видно
        // без чтения строки.
        ownUrlInvalid = true;
        // Electron добавляет к ошибке IPC служебный префикс: пользователю он не нужен.
        const raw = e && e.message ? e.message : String(e);
        const detail = raw.replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
        serverState = { kind: 'bad', text: `сервер не настроен или не отвечает: ${detail}` };
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
      fail(e && e.message ? e.message : 'папку выбрать не удалось');
    }
  }

  // -------------------------------------------------------------------------
  // Загрузка: три равноправных пути
  // -------------------------------------------------------------------------

  async function runUpload(label, run) {
    clearStatus();
    setStatus(`${label}…`, 'busy');
    try {
      const r = await run();
      if (!r || !r.url) {
        fail(`${label}: сервер не вернул ссылку`);
        return null;
      }
      // Тот же разбор, что и в onProgress: ручные пути не должны быть мягче
      // хоткей-пути. Раньше privacyDowngraded здесь просто игнорировался.
      const downgraded = r.privacyDowngraded;
      const head = downgraded
        ? `внимание: свой сервер не сработал, файл ушёл на публичный ${r.host}`
        : (r.copied === false ? 'буфер занят' : r.host);
      setStatus(
        `${head}${r.temp ? ' · ссылка временная' : ''}` +
          (r.copied === false ? ' — скопируй вручную' : ' — скопировано в буфер'),
        r.copied === false || downgraded ? 'bad' : 'ok',
        r.url
      );
      await loadHistory();
      return r;
    } catch (e) {
      // Раньше здесь исключение пролетало мимо, и метка навсегда зависала
      // на «загружаю…»: второй клик не помогал, состояние не восстанавливалось.
      fail(`${label} не удалась: ${e && e.message ? e.message : e}`);
      return null;
    }
  }

  async function uploadClipboard() {
    await runUpload('Загрузка картинки из буфера', () => bridge.uploadClipboardImage());
  }

  /** Файл выбран перетаскиванием или диалогом: сразу уходит в загрузку. */
  async function onFilesPicked(event) {
    const list = (event && event.detail) || [];
    // Список в поле вкладки нужен только чтобы показать, что файл взяли;
    // после загрузки он снова пуст.
    picked = [];
    const file = list[0];
    if (!file) return;
    const path = bridge.pathForFile(file);
    if (!path) return fail('не удалось определить путь к файлу');
    await runUpload('Загрузка файла', () => bridge.uploadFile(path));
  }

  // -------------------------------------------------------------------------
  // История
  // -------------------------------------------------------------------------

  /** Подпись строки истории: источник, время и срок жизни файла. */
  function historyMeta(item) {
    const when = new Date(item.at).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    const life = item.temp
      ? 'временная'
      : (item.expiresAt ? 'до ' + new Date(item.expiresAt).toLocaleDateString('ru-RU') : 'постоянно');
    return `${item.source || item.host} · ${when} · ${life}`;
  }

  function copyUrl(url) {
    bridge.copyText(url);
    setStatus('ссылка скопирована', 'ok');
  }

  async function loadHistory() {
    let list = [];
    try {
      list = await bridge.getHistory();
    } catch (e) {
      historyItems = [];
      historyError = 'историю прочитать не удалось';
      return;
    }
    historyError = '';
    historyItems = list;
  }

  async function clearHistory() {
    // Удаление истории необратимо, а спрятано внизу окна.
    if (!window.confirm('Удалить всю историю ссылок?')) return;
    clearStatus();
    try {
      await bridge.clearHistory();
    } catch (e) {
      fail(e && e.message ? e.message : 'историю очистить не удалось');
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
    } else if (p.state === 'capturing') setStatus('снимаю экран…', 'busy');
    else if (p.state === 'captured') setStatus('вырезал область, загружаю…', 'busy');
    else if (p.state === 'error') fail(p.message);
    else if (p.state === 'done') {
      // Главный процесс уже знает, копировалась ли ссылка и не уехала ли она
      // на публичный хостинг. Раньше эти поля игнорировались, и окно врало.
      const head = p.privacyDowngraded
        ? 'внимание: свой сервер не сработал, файл ушёл на публичный ' + p.host
        : (p.copied === false ? 'буфер занят' : p.host);
      setStatus(
        `${head}${p.temp ? ' · ссылка временная' : ''}` +
          (p.copied === false ? ' — скопируй вручную' : ' — скопировано в буфер'),
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
    hostOptions = [
      {
        value: 'auto',
        label: 'авто: свой сервер, потом ' + hosts.map((h) => h.name).join(', '),
      },
      ...hosts.map((h) => ({ value: h.name, label: h.label })),
      { value: 'own', label: 'только свой сервер — ничего не уходит наружу' },
    ];
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
      brokenReason = `настройки прочитать не удалось: ${e && e.message ? e.message : e}`;
      fail('настройки прочитать не удалось');
      return;
    }

    try {
      await initHosts();
    } catch (e) {
      fail(`список хостингов не загрузился: ${e && e.message ? e.message : e}`);
      return;
    }

    await loadHistory();
  })();
</script>

<svelte:window on:keydown={onWindowKeydown} />

<div class="page">
  <PageHeader
    class="[&>div:first-child]:max-w-[30rem]"
    title="puuush"
    description="Настройки. Снимок области, загрузка, ссылка в буфере обмена."
  >
    <svelte:fragment slot="actions">
      <Button variant="quiet" on:click={() => bridge.closeSelf()}>Закрыть</Button>
    </svelte:fragment>
  </PageHeader>

  {#if brokenReason}
    <div class="mt-4">
      <Notice tone="danger" title="Файл настроек не прочитан.">
        <p>{brokenReason}</p>
        <p class="mt-1">
          Показанные значения — по умолчанию. Если ты выбирал «только свой сервер»,
          следующий снимок может уйти на публичный хостинг. Настройки сохраняются
          сами: поправь нужные поля, и всё применится.
        </p>
      </Notice>
    </div>
  {/if}

  <main class="mt-6">
    <SectionBlock title="Горячая клавиша" first>
      <div class="flex items-end gap-3">
        <div class="min-w-0 flex-1">
          <TextField
            id="hotkey"
            label="Снимок экрана"
            value={hotkeyText}
            readonly
            spellcheck="false"
            on:focus={startListening}
            on:blur={stopListening}
          />
        </div>
        <Button variant="secondary" class="shrink-0" on:click={testHotkey}>Проверить</Button>
      </div>
      <p class="mt-1.5 text-xs leading-relaxed text-ink-soft">
        Нажми поле, потом комбинацию. Нужен хотя бы один модификатор: Command, Ctrl,
        Alt или Shift. Голую клавишу приложение не примет, она забьёт её у всех
        программ. Изменение сохраняется само. Esc, Tab и Backspace выходят из поля,
        ничего не стирая.
      </p>
    </SectionBlock>

    <SectionBlock title="Куда загружать">
      <SelectField
        id="host"
        label="Хостинг"
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
          label="Свой сервер"
          placeholder="https://media.example.duckdns.org"
          bind:value={ownUrl}
          aria-invalid={ownUrlInvalid ? 'true' : undefined}
          on:change={onOwnUrlChange}
        />

        <div class="flex items-end gap-3">
          <div class="min-w-0 flex-1">
            <TextField
              id="ownKey"
              label="Ключ записи"
              type={keyVisible ? 'text' : 'password'}
              autocomplete="off"
              spellcheck="false"
              placeholder="ключ, который выдал сервер"
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
            {keyVisible ? 'Скрыть' : 'Показать'}
          </Button>
          <Button
            variant="secondary"
            class="shrink-0"
            loading={verifying}
            on:click={checkServer}
          >
            Проверить сервер
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
          Ключ уходит заголовком <code class="rounded-ui bg-surface px-1.5 py-0.5 text-ink">POST
            /v1/uploads</code>, в ссылке и в логах сервера его нет. Если сервер недоступен,
          уходим во внешний хостинг.
        </p>
      </div>
    </SectionBlock>

    <SectionBlock title="Поведение">
      <div class="space-y-3">
        <div>
          <Checkbox id="openAfterUpload" bind:checked={openAfterUpload} on:change={onOpenAfterUploadChange}>
            Открывать ссылку в браузере
          </Checkbox>
        </div>
        <div>
          <Checkbox id="keepLocalCopy" bind:checked={keepLocalCopy} on:change={onKeepLocalCopyChange}>
            Хранить снимки на диске
          </Checkbox>
        </div>

        <div class="flex items-end gap-3">
          <div class="min-w-0 flex-1">
            <TextField
              id="saveDir"
              label="Папка для скринов"
              placeholder="пусто = Pictures/puuush"
              bind:value={saveDir}
              on:change={onSaveDirChange}
            />
          </div>
          <Button variant="secondary" class="shrink-0" on:click={pickDir}>Выбрать…</Button>
        </div>
      </div>
      <p class="mt-1.5 text-xs leading-relaxed text-ink-soft">
        Выключено: снимок удаляется с диска и при неудаче загрузки тоже.
        Галочка «открывать в браузере» перехватит фокус на браузере после каждой
        загрузки, что мешает вставлять ссылку дальше.
      </p>
    </SectionBlock>

    <SectionBlock title="Проверка загрузки">
      <FileUpload
        label="Перетащи файл сюда"
        chooseLabel="или выбери его — загрузится и скопируется ссылка"
        multiple={false}
        bind:files={picked}
        on:change={onFilesPicked}
      />
      <div class="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="secondary" on:click={uploadClipboard}>Загрузить из буфера</Button>
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

    <SectionBlock title="История">
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
                title="Скопировать ссылку"
                on:click={() => copyUrl(item.url)}
              >
                {item.url}
              </button>
              <span class="shrink-0 whitespace-nowrap text-xs text-ink-faint">
                {historyMeta(item)}
              </span>
              <Button variant="text" size="sm" on:click={() => bridge.openExternal(item.url)}>
                Открыть
              </Button>
            </li>
          {/each}
        </ul>
      {:else}
        <div class="rounded-ui border border-line">
          <EmptyState
            title="История пуста"
            description="Ссылки появятся здесь после первой загрузки."
          />
        </div>
      {/if}
      <div class="mt-3 flex justify-end">
        <Button variant="danger" on:click={clearHistory}>Очистить историю</Button>
      </div>
    </SectionBlock>
  </main>
</div>
