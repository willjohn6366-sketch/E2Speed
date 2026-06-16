import { contextBridge, ipcRenderer } from "electron";
import type {
  IperfCompleteEvent,
  IperfErrorEvent,
  IperfLogEvent,
  IperfMetricEvent,
  IperfPeerCompleteEvent,
  IperfPeerMetricEvent,
  AppUpdateState,
  ServerConfig,
  TestConfig
} from "../shared/types";

contextBridge.exposeInMainWorld("iperf", {
  getVersion: () => ipcRenderer.invoke("iperf:getVersion"),
  startClient: (config: TestConfig) => ipcRenderer.invoke("iperf:startClient", config),
  startServer: (config: ServerConfig) => ipcRenderer.invoke("iperf:startServer", config),
  findServers: () => ipcRenderer.invoke("iperf:findServers"),
  stop: (runId: string) => ipcRenderer.invoke("iperf:stop", runId),
  onLog: (handler: (event: IperfLogEvent) => void) => subscribe("iperf:log", handler),
  onMetric: (handler: (event: IperfMetricEvent) => void) => subscribe("iperf:metric", handler),
  onPeerMetric: (handler: (event: IperfPeerMetricEvent) => void) => subscribe("iperf:peerMetric", handler),
  onComplete: (handler: (event: IperfCompleteEvent) => void) => subscribe("iperf:complete", handler),
  onPeerComplete: (handler: (event: IperfPeerCompleteEvent) => void) => subscribe("iperf:peerComplete", handler),
  onError: (handler: (event: IperfErrorEvent) => void) => subscribe("iperf:error", handler)
});

contextBridge.exposeInMainWorld("appInfo", {
  getVersion: () => ipcRenderer.invoke("app:getVersion"),
  getUpdateState: () => ipcRenderer.invoke("app:getUpdateState"),
  checkForUpdates: () => ipcRenderer.invoke("app:checkForUpdates"),
  installUpdate: () => ipcRenderer.invoke("app:installUpdate"),
  openUpdatePage: () => ipcRenderer.invoke("app:openUpdatePage"),
  onUpdateState: (handler: (event: AppUpdateState) => void) => subscribe("app:updateState", handler)
});

contextBridge.exposeInMainWorld("settings", {
  get: () => ipcRenderer.invoke("settings:get"),
  getNetworkAddresses: () => ipcRenderer.invoke("settings:getNetworkAddresses"),
  getMacAddress: (ipAddress: string) => ipcRenderer.invoke("settings:getMacAddress", ipAddress),
  selectIperfBinary: () => ipcRenderer.invoke("settings:selectIperfBinary")
});

contextBridge.exposeInMainWorld("windowControls", {
  minimize: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("window:toggleMaximize"),
  close: () => ipcRenderer.invoke("window:close")
});

contextBridge.exposeInMainWorld("report", {
  savePdf: (payload: { html: string; filename: string }) => ipcRenderer.invoke("report:savePdf", payload)
});

function subscribe<T>(channel: string, handler: (event: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
