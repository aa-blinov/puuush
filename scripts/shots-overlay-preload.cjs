'use strict';
/**
 * Заглушка моста для окна выбора области.
 *
 * Окно получает снимок экрана сразу и никуда его не отправляет: скриншот
 * нужен ради того, что видно, а не ради того, что выбрано.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('puuush', {
  onFrame(cb) {
    ipcRenderer.invoke('shot:frame').then((frame) => cb(frame));
  },
  submitRegion() {},
});
