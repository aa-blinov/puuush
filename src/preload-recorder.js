 'use strict';
/**
 * Мост для страницы записи.
 *
 * Отдельный preload, как у окна выбора области: странице записи не нужны ни
 * ключ записи, ни адрес сервера, ни загрузка произвольного файла. Здесь
 * ровно то, что нужно записи: разметка экранов, куски файла и команды.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('puuush', {
  /** Раскладка экранов, флаги звука и куда всё складывать. */
  recLayout: () => ipcRenderer.invoke('puuush:rec-layout'),

  /** Кусок записанного файла. invoke ждёт, пока главный процесс его примет. */
  recChunk: (bytes) => ipcRenderer.invoke('puuush:rec-chunk', bytes),

  /** Запись началась; info говорит, какие звуковые источники вошли. */
  recStarted: (info) => ipcRenderer.invoke('puuush:rec-started', info),

  /** Запись остановилась. */
  recStopped: () => ipcRenderer.invoke('puuush:rec-stopped'),

  /** Ошибка записи. */
  recError: (message) => ipcRenderer.invoke('puuush:rec-error', message),

  /** Команда «остановить». */
  onStop: (cb) => ipcRenderer.on('puuush:rec-stop', () => cb()),

  /** Пауза и продолжение: MediaRecorder делает это сам. */
  onPause: (cb) => ipcRenderer.on('puuush:rec-pause', () => cb()),
  onResume: (cb) => ipcRenderer.on('puuush:rec-resume', () => cb()),

  fps: 30,
});
