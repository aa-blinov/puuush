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
  clearHistory: () => ipcRenderer.invoke('puuush:clear-history'),
  hosts: () => ipcRenderer.invoke('puuush:hosts'),
  reapplyHotkey: () => ipcRenderer.invoke('puuush:reapply-hotkey'),
  verifyServer: (cfg) => ipcRenderer.invoke('puuush:verify-server', cfg),

  // --- файлы и загрузка ---
  chooseFile: () => ipcRenderer.invoke('puuush:choose-file'),
  chooseDir: () => ipcRenderer.invoke('puuush:choose-dir'),
  uploadFile: (filePath) => ipcRenderer.invoke('puuush:upload-file', filePath),
  uploadDropped: (filePath) => ipcRenderer.invoke('puuush:upload-dropped', filePath),
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

  // --- окно ---
  closeSelf: () => ipcRenderer.invoke('puuush:close-self'),
  openExternal: (url) => ipcRenderer.invoke('puuush:open-external', url),
  platform: process.platform,
});