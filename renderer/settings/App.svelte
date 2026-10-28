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
    FileUpload,
    PageHeader,
    SegmentedControl,
    SelectField,
    TextField,
  } from '@monos/ui';
  import SectionBlock from './lib/SectionBlock.svelte';
  import { fieldValue } from './lib/dom.js';
  import { keyFromEvent, prettyCombo } from './lib/hotkey.js';
  import { LANGS, lang, setLang, t } from '../shared/i18n.js';
  import appInfo from '../../package.json';

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

  /** Подключённые экраны для выбора того, что записывать. */
  let displays = [];
  let screenOptions = [];

  /** Почему файл настроек не прочитан. Пусто — значит, всё в порядке. */
  let brokenReason = '';

  /** Строка состояния операции: что делаем и чем кончилось. */
  let status = { kind: '', text: '', url: '' };

  /** Ответ на проверку своего сервера. */
  let serverState = { kind: '', text: '' };

  /** Проверка скорости облачных хостингов. */
  let speedTesting = false;
  let speedResults = [];

  /** Локальная ссылка на последний файл: работает, пока открыто приложение. */
  let localUrl = '';

  /** Идёт ли запись экрана прямо сейчас. */
  let recording = false;
  let recordingBusy = false;

  /** Поля формы. Тексты двух комбинаций: сама комбинация или подсказка про запись. */
  let hotkeyTexts = { hotkey: '', imageHotkey: '', recordHotkey: '' };
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
  let recordMicrophone = true;
  let recordSystemAudio = true;
  let recordScreen = 'cursor';
  let videoMode = 'link';
  let photoMode = 'link';
  let recordArea = 'screen';
  let recordFormat = 'video';
  let recordFps = '30';
  let recordMicGain = '1';
  /** Можно ли записать системный звук на этой системе. */
  const systemAudioPossible = bridge.platform === 'win32';

  /** Служебное. */
  let ownUrlInvalid = false;
  let verifying = false;
  /** Файл, взятый перетаскиванием или диалогом. */
  let picked = [];

  // -------------------------------------------------------------------------
  // Производные значения
  // -------------------------------------------------------------------------

  $: ownVisible = host === 'own' || host === 'auto';
  $: if (typeof document !== 'undefined') document.title = $t('tray.settingsTitle');
  $: ownReady = Boolean(ownUrl.trim() && ownKey.trim());
  $: nextTarget = describeNextTarget(host, ownReady, hosts, $t);
  $: stateTag = describeStateTag(status.kind, $t);
  $: hostOptions = buildHostOptions(hosts, $t, settings.hostOrder);
  $: screenOptions = buildScreenOptions(displays, $t, recordScreen);
  // Куда девать готовую запись и с каким усилением писать микрофон.
  $: targetOptions = buildTargetOptions($t);
  $: photoOptions = buildPhotoOptions($t);
  $: areaOptions = buildAreaOptions($t);
  $: formatOptions = buildFormatOptions($t);
  $: fpsOptions = buildFpsOptions($t);
  $: gainOptions = buildGainOptions($t);

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

  /** Куда девать готовую запись. */
  function buildTargetOptions(tr) {
    return [
      { value: 'link', label: tr('ui.option.video.link') },
      { value: 'clipboard', label: tr('ui.option.video.clipboard') },
      { value: 'disk', label: tr('ui.option.video.disk') },
    ];
  }

  /** Что делать со снимком. */
  function buildPhotoOptions(tr) {
    return [
      { value: 'link', label: tr('ui.option.photo.link') },
      { value: 'clipboard', label: tr('ui.option.photo.clipboard') },
    ];
  }

  /** Область записи. */
  function buildAreaOptions(tr) {
    return [
      { value: 'screen', label: tr('ui.option.area.screen') },
      { value: 'region', label: tr('ui.option.area.region') },
      { value: 'all', label: tr('ui.option.area.all') },
    ];
  }

  /** Формат: видео со звуком или GIF без звука. */
  function buildFormatOptions(tr) {
    return [
      { value: 'video', label: tr('ui.option.format.video') },
      { value: 'gif', label: tr('ui.option.format.gif') },
    ];
  }

  function buildFpsOptions(tr) {
    return [
      { value: '30', label: tr('ui.option.fps.30') },
      { value: '60', label: tr('ui.option.fps.60') },
    ];
  }

  /** Усиление микрофона: тихий голос на записи лечится здесь. */
  function buildGainOptions(tr) {
    return [
      { value: '1', label: tr('ui.option.gain.100') },
      { value: '1.5', label: tr('ui.option.gain.150') },
      { value: '2', label: tr('ui.option.gain.200') },
    ];
  }

  /** Выбор экрана: курсор, конкретный монитор или все мониторы в одном кадре. */
  function buildScreenOptions(list, tr, current) {
    const options = [
      { value: 'cursor', label: tr('ui.screen.cursor') },
      { value: 'all', label: tr('ui.screen.all') },
    ];
    for (const d of list) {
      const name = d.name || tr('ui.screen.displayN', { n: d.index || '' });
      const shape = `${d.width}×${d.height}`;
      options.push({
        value: String(d.id),
        label: d.primary
          ? tr('ui.screen.primary', { name, shape })
          : tr('ui.screen.display', { name, shape }),
      });
    }
    if (current && current !== 'cursor' && current !== 'all' && !list.some((d) => String(d.id) === current)) {
      options.push({ value: current, label: tr('ui.screen.missing') });
    }
    return options;
  }

  function buildHostOptions(list, tr, order) {
    // В режиме «авто» первым будет тот хостинг, который измерила проверка
    // скорости. Показывать при этом статический список — значит обещать не
    // тот порядок, в котором приложение действительно пойдёт.
    const byName = new Map(list.map((h) => [h.name, h]));
    const names = [];
    for (const name of Array.isArray(order) ? order : []) {
      if (byName.has(name) && !names.includes(name)) names.push(name);
    }
    for (const h of list) if (!names.includes(h.name)) names.push(h.name);
    return [
      { value: 'auto', label: tr('ui.hostAuto', { hosts: names.join(', ') }) },
      ...list.map((h) => ({
        value: h.name,
        // Потолок файла виден прямо в списке: у временных хостингов он
        // больше, чем у постоянных, и для записи встречи это важно.
        label: h.max
          ? `${tr(`host.${h.name}`)} — ${Math.round(h.max / 1048576)} ${tr('ui.size.mb')}`
          : tr(`host.${h.name}`),
      })),
      { value: 'own', label: tr('ui.hostOwnOnly') },
    ];
  }

  /**
   * Проверка скорости облачных хостингов.
   *
   * Задержка до одного и того же хостинга из разных регионов разная, и
   * угадать её нельзя. Проверка загружает маленький файл в каждый хостинг,
   * показывает время и сохраняет порядок: в режиме «авто» быстрые
   * пробуются первыми.
   */
  async function testHosts() {
    if (speedTesting) return;
    speedTesting = true;
    speedResults = [];
    setStatus($t('ui.speed.testing'), 'busy');
    try {
      const r = await bridge.testHosts();
      speedResults = (r && r.results) || [];
      const ok = speedResults.filter((x) => x.ok).length;
      setStatus(
        ok
          ? $t('ui.speed.done', { count: ok })
          : $t('ui.speed.none'),
        ok ? 'ok' : 'bad'
      );
    } catch (e) {
      fail(e && e.message ? e.message : $t('ui.speed.failed'));
    } finally {
      speedTesting = false;
    }
  }

  /** Время для человека: миллисекунды, секунды для долгих ответов. */
  function speedText(ms) {
    if (ms == null) return '';
    if (ms < 1000) return `${ms} ${$t('ui.speed.ms')}`;
    return `${(ms / 1000).toFixed(1)} ${$t('ui.speed.sec')}`;
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
      recordHotkey: prettyCombo(next.recordHotkey, isMac),
    };
    host = next.host;
    ownUrl = (next.own && next.own.base_url) || '';
    ownKey = (next.own && next.own.write_key) || '';
    openAfterUpload = !!next.openAfterUpload;
    keepLocalCopy = next.keepLocalCopy !== false;
    launchAtLogin = !!next.launchAtLogin;
    recordMicrophone = next.recordMicrophone !== false;
    recordSystemAudio = next.recordSystemAudio !== false;
    recordScreen = typeof next.recordScreen === 'string' && next.recordScreen
      ? next.recordScreen
      : (next.recordAllScreens === true ? 'all' : 'cursor');
    videoMode = next.videoMode === 'clipboard' || next.videoMode === 'disk' ? next.videoMode : 'link';
    photoMode = next.photoMode === 'clipboard' ? 'clipboard' : 'link';
    recordArea = next.recordArea === 'region' || next.recordArea === 'all' ? next.recordArea : 'screen';
    recordFormat = next.recordFormat === 'gif' ? 'gif' : 'video';
    recordFps = Number(next.recordFps) === 60 ? '60' : '30';
    recordMicGain = String(Number(next.recordMicGain) === 2 ? 2 : Number(next.recordMicGain) === 1.5 ? 1.5 : 1);
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
      const fields = ['hotkey', 'imageHotkey', 'recordHotkey'];
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

  async function onRecordMicrophoneChange() {
    await save({ recordMicrophone });
  }

  async function onRecordSystemAudioChange() {
    await save({ recordSystemAudio });
  }

  async function onVideoModeChange() {
    await save({ videoMode });
  }

  async function onPhotoModeChange() {
    await save({ photoMode });
  }

  async function onRecordAreaChange() {
    await save({ recordArea });
  }

  async function onRecordFormatChange() {
    await save({ recordFormat });
  }

  async function onRecordFpsChange() {
    await save({ recordFps: Number(recordFps) || 30 });
  }

  async function onRecordMicGainChange() {
    // В настройках лежит число, а поле выбора работает со строками.
    await save({ recordMicGain: Number(recordMicGain) || 1 });
  }

  async function onRecordScreenChange() {
    // Старый boolean пишем рядом: если человек откроет эту же папку в
    // предыдущей версии, она поймёт хотя бы режим «все экраны».
    await save({ recordScreen, recordAllScreens: recordScreen === 'all' });
  }

  /**
   * Запись экрана из окна настроек.
   *
   * Та же команда, что и по хоткею: запись идёт, а файл уходит на сервер
   * после остановки. Кнопка показывает, что происходит, потому что запись
   * идёт минуту и молчать в это время неправильно.
   */
  async function toggleRecording() {
    if (recordingBusy) return;
    recordingBusy = true;
    try {
      if (recording) {
        await bridge.stopRecording();
      } else {
        // Обещание живёт до конца загрузки файла, поэтому ждём здесь.
        await bridge.startRecording();
      }
    } catch (e) {
      fail($t('rec.failed', { error: e && e.message ? e.message : e }));
    } finally {
      recordingBusy = false;
    }
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
      localUrl = r.localUrl || '';
      setStatus(
        `${head}${r.temp ? $t('ui.status.temp') : ''}` +
          (r.copied === false ? $t('ui.status.copyNote') : $t('ui.status.copiedNote')),
        r.copied === false || downgraded ? 'bad' : 'ok',
        r.url
      );
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
  // Статусы из главного процесса
  // -------------------------------------------------------------------------

  bridge.onProgress((p) => {
    if (!p) return;
    if (p.state === 'step') {
      // Главный процесс шлёт сюда человеческие причины («сервер отверг ключ»,
      // «ссылка не вывозит файл»). Раньше они уходили в никуда.
      if (p.message) setStatus(p.message, 'busy');
    } else if (p.state === 'recording') {
      recording = true;
      setStatus($t('ui.status.recording'), 'busy');
    } else if (p.state === 'idle') {
      recording = false;
    } else if (p.state === 'capturing') setStatus($t('ui.status.progressCapturing'), 'busy');
    else if (p.state === 'captured') setStatus($t('ui.status.progressCaptured'), 'busy');
    else if (p.state === 'copied') setStatus($t('note.imageInClipboard'), 'ok');
    else if (p.state === 'error') fail(p.message);
    else if (p.state === 'done' && p.host === 'disk') {
      recording = false;
      setStatus($t('ui.status.recordOnDisk') + (p.file ? ': ' + p.file : ''), 'ok');
    } else if (p.state === 'done') {
      // Главный процесс уже знает, копировалась ли ссылка и не уехала ли она
      // на публичный хостинг. Раньше эти поля игнорировались, и окно врало.
      const head = p.privacyDowngraded
        ? $t('ui.status.downgraded', { host: hostLabel(p.host) })
        : (p.copied === false ? $t('ui.status.clipboardBusy') : hostLabel(p.host));
      localUrl = p.localUrl || '';
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

  async function initDisplays() {
    displays = await bridge.displays();
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

    try {
      await initDisplays();
    } catch (e) {
      fail($t('ui.displaysFailed', { error: e && e.message ? e.message : e }));
    }

  })();
</script>

<!-- Файл, брошенный мимо зоны загрузки, иначе открылся бы в самом окне. -->
<svelte:window on:keydown={onWindowKeydown} on:dragover|preventDefault on:drop|preventDefault />

<div class="flex h-screen min-h-0 flex-col overflow-hidden bg-bg">
  <div class="page min-h-0 flex-1 overflow-y-auto">
  <PageHeader
    class="[&>div:last-child]:ml-auto [&>div:last-child]:justify-end"
    title={$t('ui.settingsTitle')}
    description={$t('ui.description')}
  >
    <svelte:fragment slot="actions">
      <span class="app-version" aria-label={$t('ui.version', { version: appInfo.version })}>
        <Badge tone="neutral">v{appInfo.version}</Badge>
      </span>
      <Button variant="secondary" on:click={() => bridge.openGallery()}>
        {$t('ui.gallery.open')}
      </Button>
    </svelte:fragment>
  </PageHeader>

  {#if brokenReason}
    <div class="mt-comfortable rounded-ui border border-line bg-surface p-3 text-sm text-ink" role="alert">
      <p class="font-bold">{$t('ui.brokenTitle')}</p>
      <p class="mt-1 text-xs leading-relaxed text-ink-soft">{brokenReason}</p>
      <p class="mt-1 text-xs leading-relaxed text-ink-soft">{$t('ui.brokenBody')}</p>
    </div>
  {/if}

  <main class="mt-roomy">
    <SectionBlock title={$t('ui.section.language')} first>
      <div class="space-y-field">
        <SegmentedControl
          label={$t('ui.section.language')}
          options={LANGS}
          value={$lang}
          on:change={onLangChange}
        />
        <p class="text-xs leading-relaxed text-ink-soft">{$t('ui.hint.language')}</p>
      </div>
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
      <TextField
        id="imageHotkey"
        label={$t('ui.field.image')}
        value={hotkeyTexts.imageHotkey}
        readonly
        spellcheck="false"
        on:focus={() => startListening('imageHotkey')}
        on:blur={stopListening}
      />
      <SelectField
        id="photoMode"
        label={$t('ui.field.photoMode')}
        bind:value={photoMode}
        options={photoOptions}
        on:change={onPhotoModeChange}
      />
      <div class="space-y-base">
        <div class="settings-action flex justify-end">
          <Button variant="secondary" on:click={testHotkey}>
            {$t('ui.button.check')}
          </Button>
        </div>
        <p class="text-xs leading-relaxed text-ink-soft">{$t('ui.hint.hotkey')}</p>
      </div>
    </SectionBlock>

    <SectionBlock title={$t('ui.section.recording')}>
      <TextField
        id="recordHotkey"
        label={$t('ui.field.recordHotkey')}
        value={hotkeyTexts.recordHotkey}
        readonly
        spellcheck="false"
        on:focus={() => startListening('recordHotkey')}
        on:blur={stopListening}
      />

      <div class="settings-action flex justify-end">
        <Button variant="secondary" loading={recordingBusy} on:click={toggleRecording}>
          {recording ? $t('ui.button.stopRecord') : $t('ui.button.startRecord')}
        </Button>
      </div>

      <SelectField
        id="recordFormat"
        label={$t('ui.field.recordFormat')}
        bind:value={recordFormat}
        options={formatOptions}
        on:change={onRecordFormatChange}
      />
      <p class="text-xs leading-relaxed text-ink-soft">
        {$t(recordFormat === 'gif' ? 'ui.hint.format.gif' : 'ui.hint.format.video')}
      </p>

      {#if recordFormat !== 'gif'}
        <div class="space-y-base">
          <div>
            <Checkbox id="recordMicrophone" bind:checked={recordMicrophone} on:change={onRecordMicrophoneChange}>
              {$t('ui.check.recordMicrophone')}
            </Checkbox>
          </div>
          {#if systemAudioPossible}
            <div class="space-y-field">
              <div>
                <Checkbox id="recordSystemAudio" bind:checked={recordSystemAudio} on:change={onRecordSystemAudioChange}>
                  {$t('ui.check.recordSystemAudio')}
                </Checkbox>
              </div>
              <p class="text-xs leading-relaxed text-ink-soft">{$t('ui.hint.recordSystemAudio')}</p>
            </div>
          {/if}
        </div>
      {/if}

      <SelectField
        id="videoMode"
        label={$t('ui.field.videoMode')}
        bind:value={videoMode}
        options={targetOptions}
        on:change={onVideoModeChange}
      />
      <p class="text-xs leading-relaxed text-ink-soft">
        {$t(`ui.hint.videoMode.${videoMode}`)}
      </p>

      <SelectField
        id="recordArea"
        label={$t('ui.field.recordArea')}
        bind:value={recordArea}
        options={areaOptions}
        hint={$t('ui.hint.recordArea')}
        on:change={onRecordAreaChange}
      />
      <SelectField
        id="recordFps"
        label={$t('ui.field.recordFps')}
        bind:value={recordFps}
        options={fpsOptions}
        hint={$t('ui.hint.recordFps')}
        on:change={onRecordFpsChange}
      />
      {#if recordFormat !== 'gif' && recordMicrophone}
        <SelectField
          id="recordMicGain"
          label={$t('ui.field.recordMicGain')}
          bind:value={recordMicGain}
          options={gainOptions}
          hint={$t('ui.hint.recordMicGain')}
          on:change={onRecordMicGainChange}
        />
      {/if}
      {#if recordArea === 'screen'}
        <SelectField
          id="recordScreen"
          label={$t('ui.field.recordScreen')}
          bind:value={recordScreen}
          options={screenOptions}
          hint={$t('ui.hint.recordScreen')}
          on:change={onRecordScreenChange}
        />
      {/if}
      <p class="text-xs leading-relaxed text-ink-soft">{$t('ui.hint.recording')}</p>
    </SectionBlock>

    <SectionBlock title={$t('ui.section.hosting')}>
      <div class="space-y-field">
        <SelectField
          id="host"
          label={$t('ui.field.hosting')}
          bind:value={host}
          options={hostOptions}
          on:change={onHostChange}
        />
        <p
          class="text-xs leading-relaxed {nextTarget.warn
            ? 'font-medium text-ink'
            : 'text-ink-soft'}"
          aria-live="polite"
        >
          {nextTarget.text}
        </p>
      </div>

      <div class="settings-action flex justify-end">
        <Button variant="secondary" loading={speedTesting} on:click={testHosts}>
          {$t('ui.speed.button')}
        </Button>
      </div>
      <p class="text-xs leading-relaxed text-ink-soft">{$t('ui.speed.hint')}</p>

      {#if speedResults.length}
        <ul class="space-y-1 text-xs">
          {#each speedResults as r (r.name)}
            <li class="flex items-center gap-3 {r.ok ? 'text-ink-soft' : 'text-ink-faint'}">
              <span class="min-w-0 flex-1 truncate">{hostLabel(r.name)}</span>
              <span class="shrink-0 tabular-nums">
                {r.ok ? speedText(r.ms) : $t('ui.speed.unreachable')}
              </span>
              <Badge tone={r.ok ? 'success' : 'danger'}>
                {$t(r.ok ? 'ui.speed.reachable' : 'ui.speed.unreachable')}
              </Badge>
            </li>
          {/each}
        </ul>
      {/if}

      <div id="ownBox" class="space-y-comfortable" style:display={ownVisible ? 'block' : 'none'}>
          <TextField
          id="ownUrl"
          label={$t('ui.field.ownServer')}
          placeholder={$t('ui.field.ownUrlPlaceholder')}
          bind:value={ownUrl}
          aria-invalid={ownUrlInvalid ? 'true' : undefined}
          on:change={onOwnUrlChange}
        />

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

        <div class="settings-action flex flex-wrap items-center justify-end gap-3">
          <Button
            variant="secondary"
            aria-pressed={keyVisible}
            on:click={toggleKeyVisibility}
          >
            {keyVisible ? $t('ui.button.hide') : $t('ui.button.show')}
          </Button>
          <Button
            variant="secondary"
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
      <div class="space-y-base">
        <div>
          <Checkbox id="openAfterUpload" bind:checked={openAfterUpload} on:change={onOpenAfterUploadChange}>
            {$t('ui.check.openInBrowser')}
          </Checkbox>
        </div>
        <div>
          <Checkbox id="keepLocalCopy" bind:checked={keepLocalCopy} on:change={onKeepLocalCopyChange}>
            {$t('ui.check.keepLocalCopy')}
          </Checkbox>
          <p class="mt-field text-xs leading-relaxed text-ink-soft">{$t('ui.hint.keepLocalCopy')}</p>
        </div>
        {#if canLaunchAtLogin}
          <div class="space-y-field">
            <div>
              <Checkbox id="launchAtLogin" bind:checked={launchAtLogin} on:change={onLaunchAtLoginChange}>
                {$t('ui.check.launchAtLogin')}
              </Checkbox>
            </div>
            <p class="text-xs leading-relaxed text-ink-soft">{$t('ui.hint.launchAtLogin')}</p>
          </div>
        {/if}
      </div>

      <TextField
        id="saveDir"
        label={$t('ui.field.saveDir')}
        placeholder={$t('ui.field.saveDirPlaceholder')}
        bind:value={saveDir}
        on:change={onSaveDirChange}
      />
      <div class="settings-action flex justify-end">
        <Button variant="secondary" on:click={pickDir}>
          {$t('ui.button.choose')}
        </Button>
      </div>
      <p class="text-xs leading-relaxed text-ink-soft">{$t('ui.hint.behaviour')}</p>
    </SectionBlock>

    <SectionBlock title={$t('ui.section.upload')}>
      <FileUpload
        label={$t('ui.upload.label')}
        chooseLabel={$t('ui.upload.chooseLabel')}
        bind:files={picked}
        on:change={onFilesPicked}
      />
      <div class="settings-action flex flex-wrap items-center justify-end gap-3">
        <Button variant="secondary" on:click={uploadClipboard}>
          {$t('ui.button.fromClipboard')}
        </Button>
        <Badge tone={stateTag.tone}>{stateTag.label}</Badge>
      </div>

      {#if status.text || status.url}
        <div>
          <div
            class="rounded-ui border border-line bg-surface p-3 text-xs leading-relaxed text-ink-soft"
            role={status.kind === 'bad' ? 'alert' : 'status'}
            aria-live={status.kind === 'bad' ? 'assertive' : 'polite'}
          >
            {#if status.url}
              <p class="break-url text-ink">{status.url}</p>
            {/if}
            {#if status.text}
              <p class={status.url ? 'mt-1' : ''}>{status.text}</p>
            {/if}
            {#if localUrl}
              <p class="mt-1 break-url text-xs text-ink-soft">
                {$t('ui.local.label')}: {localUrl}
              </p>
            {/if}
          </div>
        </div>
      {/if}
    </SectionBlock>

  </main>
  </div>
</div>
