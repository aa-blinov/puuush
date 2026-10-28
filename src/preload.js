'use strict';
const { contextBridge, ipcRenderer, clipboard, webUtils } = require('electron');

/**
 * Мост между renderer и main.
 *
 * contextIsolation включён, nodeIntegration выключен, поэтому renderer получает
 * ровно этот набор функций и никакого доступа к Node.
 */
contextBridge.exposeInMainWorld('puuush', {
  // --- окно выбора области ---
  onFrame(cb) {
    ipcRenderer.on('puuush:frame', (_e, payload) => cb(payload));
  },
  submitRegion(rect) {
    ipcRenderer.send('puuush:region', rect);
  },

  // --- буфер обмена ---
  copyText(text) {
    clipboard.writeText(String(text ?? ''));
  },

  // --- настройки и история ---
  getSettings: () => ipcRenderer.invoke('puuush:get-settings'),
  brokenSettings: () => ipcRenderer.invoke('puuush:broken-settings'),
  saveSettings: (patch) => ipcRenderer.invoke('puuush:save-settings', patch),
  getHistory: () => ipcRenderer.invoke('puuush:get-history'),
  getGallery: () => ipcRenderer.invoke('puuush:get-gallery'),
  galleryAction: (id, action) => ipcRenderer.invoke('puuush:gallery-action', id, action),
  openGallery: () => ipcRenderer.invoke('puuush:show-gallery'),
  clearHistory: () => ipcRenderer.invoke('puuush:clear-history'),
  hosts: () => ipcRenderer.invoke('puuush:hosts'),
  displays: () => ipcRenderer.invoke('puuush:displays'),
  testHosts: () => ipcRenderer.invoke('puuush:test-hosts'),
  reapplyHotkey: () => ipcRenderer.invoke('puuush:reapply-hotkey'),
  verifyServer: (cfg) => ipcRenderer.invoke('puuush:verify-server', cfg),

  // --- файлы и загрузка ---
  chooseDir: () => ipcRenderer.invoke('puuush:choose-dir'),
  uploadFile: (filePath) => ipcRenderer.invoke('puuush:upload-file', filePath),
  uploadClipboardImage: () => ipcRenderer.invoke('puuush:upload-clipboard-image'),
  onProgress: (cb) => ipcRenderer.on('puuush:progress', (_e, payload) => cb(payload)),

  /** Путь файла, который запилили в окно через drop. */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch (e) {
      return null;
    }
  },

  // --- запись экрана ---
  startRecording: () => ipcRenderer.invoke('puuush:start-recording'),
  stopRecording: () => ipcRenderer.invoke('puuush:stop-recording'),

  // --- локальная раздача ---
  lastLocal: () => ipcRenderer.invoke('puuush:last-local'),

  // --- окно ---
  closeSelf: () => ipcRenderer.invoke('puuush:close-self'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('puuush:window-toggle-maximize'),
  openExternal: (url) => ipcRenderer.invoke('puuush:open-external', url),
  platform: process.platform,
  /**
   * Язык окна, синхронно.
   *
   * Язык нужен до первой отрисовки, иначе окно мигнёт чужой: человек увидит
   * английский интерфейс вместо русского на долю секунды. Синхронный ответ
   * стоит одну строку и происходит один раз за жизнь окна.
   */
  lang: () => ipcRenderer.sendSync('puuush:lang'),
});
