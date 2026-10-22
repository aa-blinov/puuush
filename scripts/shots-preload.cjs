'use strict';
/**
 * Заглушка моста для скриншотов.
 *
 * Настоящий preload отдаёт живые данные из главного процесса. Здесь нужен
 * ровно тот же контракт, но с управляемым содержимым: скриншот обязан
 * показывать конкретное состояние — свой сервер настроен, файл настроек
 * побит, — и не зависеть от того, что лежит в каталоге пользователя.
 *
 * Данные приходят по IPC, а не аргументом командной строки: preload в
 * окне запускается в песочнице, где доступны только electron и несколько
 * модулей Node, и никакого node:fs.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('puuush', {
  getSettings: () => ipcRenderer.invoke('shot:state').then((s) => s.settings),
  brokenSettings: () => ipcRenderer.invoke('shot:state').then((s) => s.broken || null),
  getHistory: () => ipcRenderer.invoke('shot:state').then((s) => s.history || []),
  clearHistory: async () => {},
  hosts: () => ipcRenderer.invoke('shot:state').then((s) => s.hosts),
  saveSettings: async (patch) => {
    const s = await ipcRenderer.invoke('shot:state');
    return { ...s.settings, ...patch };
  },
  reapplyHotkey: async () => true,
  verifyServer: async () => ({ files: 3, bytes: 1024 }),
  chooseDir: async () => '',
  uploadFile: async () => null,
  uploadClipboardImage: async () => null,
  onProgress: () => {},
  pathForFile: () => '',
  closeSelf: async () => {},
  openExternal: async () => {},
  platform: process.platform,
  lang: () => 'en',
});
