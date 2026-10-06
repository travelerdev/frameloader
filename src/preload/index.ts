import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { EventMap, FrameloaderApi } from "../shared/ipc";

const api: FrameloaderApi = {
  devices: {
    list: () => ipcRenderer.invoke("devices:list"),
    remove: (id) => ipcRenderer.invoke("devices:remove", id),
    rename: (id, nickname) => ipcRenderer.invoke("devices:rename", id, nickname),
  },
  connection: {
    state: () => ipcRenderer.invoke("connection:state"),
    pair: (req) => ipcRenderer.invoke("connection:pair", req),
    cancelPair: () => ipcRenderer.invoke("connection:cancelPair"),
    connectPassword: (req) => ipcRenderer.invoke("connection:password", req),
    connectSaved: (id) => ipcRenderer.invoke("connection:saved", id),
    disconnect: () => ipcRenderer.invoke("connection:disconnect"),
    installRuntime: (which) => ipcRenderer.invoke("connection:installRuntime", which),
    discover: () => ipcRenderer.invoke("connection:discover"),
  },
  payload: {
    inspect: (paths) => ipcRenderer.invoke("payload:inspect", paths),
    pick: () => ipcRenderer.invoke("payload:pick"),
    discard: (id) => ipcRenderer.invoke("payload:discard", id),
    runtimes: (id) => ipcRenderer.invoke("payload:runtimes", id),
  },
  install: {
    start: (req) => ipcRenderer.invoke("install:start", req),
  },
  titles: {
    list: () => ipcRenderer.invoke("titles:list"),
    launch: (id) => ipcRenderer.invoke("titles:launch", id),
    stop: (id) => ipcRenderer.invoke("titles:stop", id),
    remove: (id) => ipcRenderer.invoke("titles:remove", id),
  },
  logcat: {
    start: (id) => ipcRenderer.invoke("logcat:start", id),
    stop: () => ipcRenderer.invoke("logcat:stop"),
  },
  activity: {
    recent: () => ipcRenderer.invoke("activity:recent"),
  },
  getPathForFile: (file) => webUtils.getPathForFile(file),
  on<K extends keyof EventMap>(event: K, cb: (payload: EventMap[K]) => void): () => void {
    const handler = (_e: Electron.IpcRendererEvent, payload: EventMap[K]) => cb(payload);
    ipcRenderer.on(event, handler);
    return () => ipcRenderer.removeListener(event, handler);
  },
};

contextBridge.exposeInMainWorld("frameloader", api);
