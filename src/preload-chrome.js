'use strict';
/**
 * Мост для рамки и панели записи.
 *
 * Ни ключа, ни адреса сервера, ни доступа к файлам: окнам записи нужно ровно
 * три вещи — узнать состояние, попросить паузу или остановку и узнать язык.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('puuushChrome', {
  onState: (cb) => ipcRenderer.on('puuush:chrome-state', (_e, payload) => cb(payload)),
  action: (name) => ipcRenderer.send('puuush:chrome-action', name),
});
