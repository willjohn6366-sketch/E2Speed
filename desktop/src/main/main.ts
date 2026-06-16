import { app, BrowserWindow, dialog, ipcMain, screen, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import dgram, { type RemoteInfo, type Socket as UdpSocket } from "node:dgram";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import http, { type Server as HttpServer } from "node:http";
import { networkInterfaces } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type {
  AppSettings,
  AppUpdateState,
  DiscoveredServer,
  IperfCompleteEvent,
  IperfErrorEvent,
  IperfLogEvent,
  IperfMetricEvent,
  IperfPeerCompleteEvent,
  IperfPeerMetricEvent,
  LocalNetworkAddress,
  RunSummary,
  ServerConfig,
  TestConfig
} from "../shared/types";
import { buildClientArgs, buildServerArgs, commandPreview } from "../shared/commands";

interface ActiveRun {
  process: ChildProcessWithoutNullStreams;
  config: TestConfig | ServerConfig;
  args: string[];
  command: string[];
  startedAt: string;
  rawJson: unknown[];
  stdoutBuffer: string;
  stderrBuffer: string;
  portRetryCount: number;
}

const activeRuns = new Map<string, ActiveRun>();
let mainWindow: BrowserWindow | null = null;
let peerMetricServer: HttpServer | null = null;
let peerMetricPort: number | null = null;
let discoveryResponder: UdpSocket | null = null;
let discoveryResponderPort: number | null = null;

const DISCOVERY_REQUEST_TYPE = "iperf3-visual-discovery";
const DISCOVERY_RESPONSE_TYPE = "iperf3-visual-discovery-response";
const DISCOVERY_VERSION = 1;
const DISCOVERY_PORT = 55201;
const DISCOVERY_TIMEOUT_MS = 1200;
const RELEASE_API_URL = "https://api.github.com/repos/willjohn6366-sketch/E2Speed/releases/latest";
const UPDATE_RELEASES_URL = "https://gh-proxy.org/https://github.com/willjohn6366-sketch/E2Speed/releases/latest";
const UPDATE_CHECK_TIMEOUT_MS = 4500;

app.setName("E2Speed");
app.setAppUserModelId("com.e2speed.desktop");
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

let updateState: AppUpdateState = createInitialUpdateState();

function preferredWindowBounds(): { width: number; height: number; minWidth: number; minHeight: number } {
  const { width: workWidth, height: workHeight } = screen.getPrimaryDisplay().workAreaSize;
  const maxInitialWidth = Math.max(900, workWidth - 48);
  const maxInitialHeight = Math.max(620, workHeight - 48);
  const width = Math.min(1320, maxInitialWidth);
  const height = Math.min(860, maxInitialHeight);
  const minWidth = Math.min(1180, Math.max(900, Math.min(Math.max(1000, workWidth - 80), workWidth - 24)));
  const minHeight = Math.min(760, Math.max(620, Math.min(Math.max(680, workHeight - 80), workHeight - 24)));

  return {
    width: Math.max(width, minWidth),
    height: Math.max(height, minHeight),
    minWidth,
    minHeight
  };
}

function createWindow(): void {
  const windowBounds = preferredWindowBounds();
  const iconPath = getWindowIconPath();
  mainWindow = new BrowserWindow({
    width: windowBounds.width,
    height: windowBounds.height,
    minWidth: windowBounds.minWidth,
    minHeight: windowBounds.minHeight,
    backgroundColor: "#f6f7f2",
    frame: false,
    title: "E2Speed",
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const isExternal = /^https?:\/\//i.test(url) && url !== mainWindow?.webContents.getURL();
    if (!isExternal) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
}

app.whenReady().then(() => {
  const iconPath = getWindowIconPath();
  if (process.platform === "darwin" && iconPath) {
    app.dock?.setIcon(iconPath);
  }

  registerIpc();
  createWindow();
  setTimeout(() => {
    void checkForUpdates({ silent: true });
  }, 1800);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopAllRuns();
  if (process.platform !== "darwin") app.quit();
});

function registerIpc(): void {
  ipcMain.handle("window:minimize", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle("window:toggleMaximize", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  ipcMain.handle("window:close", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  ipcMain.handle("app:getVersion", () => getAppVersion());
  ipcMain.handle("app:getUpdateState", () => updateState);
  ipcMain.handle("app:checkForUpdates", () => checkForUpdates({ silent: false }));
  ipcMain.handle("app:installUpdate", () => installUpdate());
  ipcMain.handle("app:openUpdatePage", async () => {
    await shell.openExternal(UPDATE_RELEASES_URL);
  });

  ipcMain.handle("settings:get", () => getSettings());
  ipcMain.handle("settings:getNetworkAddresses", () => getNetworkAddresses());
  ipcMain.handle("settings:getMacAddress", async (_event, ipAddress: string) => getMacAddress(ipAddress));
  ipcMain.handle("settings:selectIperfBinary", async () => {
    const dialogOptions: Electron.OpenDialogOptions = {
      title: "选择 iperf3 可执行文件",
      properties: ["openFile"]
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);

    if (!result.canceled && result.filePaths[0]) {
      const settings = getSettings();
      settings.iperfBinaryPath = result.filePaths[0];
      saveSettings(settings);
    }

    return getSettings();
  });

  ipcMain.handle("report:savePdf", async (_event, payload: { html: string; filename: string }) => {
    const defaultPath = path.join(app.getPath("documents"), sanitizeFilename(payload.filename || "端端测速链路测试报告.pdf"));
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, {
          title: "下载测试报告",
          defaultPath,
          filters: [{ name: "PDF 文件", extensions: ["pdf"] }]
        })
      : await dialog.showSaveDialog({
          title: "下载测试报告",
          defaultPath,
          filters: [{ name: "PDF 文件", extensions: ["pdf"] }]
        });

    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

    const pdfWindow = new BrowserWindow({
      width: 1024,
      height: 1448,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    try {
      await pdfWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(payload.html)}`);
      const pdf = await pdfWindow.webContents.printToPDF({
        pageSize: "A4",
        printBackground: true,
        margins: {
          top: 0.4,
          bottom: 0.4,
          left: 0.45,
          right: 0.45
        }
      });
      writeFileSync(result.filePath, pdf);
      return { ok: true, filePath: result.filePath };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      pdfWindow.destroy();
    }
  });

  ipcMain.handle("iperf:getVersion", async () => {
    const binary = resolveIperfBinary();
    if (!binary) return { ok: false, error: "未配置 iperf3 可执行文件" };

    return new Promise((resolve) => {
      const child = spawn(binary, ["--version"], { windowsHide: true });
      let output = "";
      let error = "";
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        error += chunk.toString();
      });
      child.on("error", (err) => resolve({ ok: false, error: err.message }));
      child.on("close", (code) => {
        if (code === 0) resolve({ ok: true, version: output.trim() });
        else resolve({ ok: false, error: error.trim() || `iperf3 exited with ${code}` });
      });
    });
  });

  ipcMain.handle("iperf:startClient", (_event, config: TestConfig) => {
    validateClientConfig(config);
    return startRun(config, buildClientArgs(config));
  });

  ipcMain.handle("iperf:startServer", async (_event, config: ServerConfig) => {
    validateServerConfig(config);
    await releaseListeningPort(config.port);
    await startPeerMetricServer(metricRelayPort(config.port));
    await startDiscoveryResponder(config.port);
    return startRun(config, buildServerArgs(config));
  });

  ipcMain.handle("iperf:findServers", async () => {
    return findServers();
  });

  ipcMain.handle("iperf:stop", (_event, runId: string) => {
    const run = activeRuns.get(runId);
    if (!run) return { ok: true };
    run.process.kill();
    return { ok: true };
  });
}

function startRun(config: TestConfig | ServerConfig, args: string[]): { runId: string; command: string[] } {
  const binary = resolveIperfBinary();
  if (!binary) throw new Error("未配置 iperf3 可执行文件，请在设置页选择路径或放入 resources/bin 对应平台目录。");

  const runId = crypto.randomUUID();
  const command = commandPreview(binary, args);
  const child = spawn(binary, args, { windowsHide: true });
  const run: ActiveRun = {
    process: child,
    config,
    args,
    command,
    startedAt: new Date().toISOString(),
    rawJson: [],
    stdoutBuffer: "",
    stderrBuffer: "",
    portRetryCount: 0
  };
  activeRuns.set(runId, run);

  emitLog({ runId, line: `启动: ${quoteCommand(command)}`, stream: "system" });
  wireProcess(runId, child);

  return { runId, command };
}

function wireProcess(runId: string, child: ChildProcessWithoutNullStreams): void {
  child.stdout.on("data", (chunk) => {
    handleProcessOutput(runId, "stdout", chunk.toString());
  });

  child.stderr.on("data", (chunk) => {
    handleProcessOutput(runId, "stderr", chunk.toString());
  });

  child.on("error", (error) => {
    emitError({ runId, message: error.message });
  });

  child.on("close", (exitCode, signal) => {
    void handleProcessClose(runId, exitCode, signal);
  });
}

async function handleProcessClose(runId: string, exitCode: number | null, signal: NodeJS.Signals | null): Promise<void> {
  const current = activeRuns.get(runId);
  if (!current) return;

  if (shouldRetryPortConflict(current)) {
    current.portRetryCount += 1;
    emitLog({ runId, line: `端口 ${current.config.port} 被占用，正在自动释放并重试。`, stream: "system" });
    await releaseListeningPort(current.config.port, runId);

    const binary = resolveIperfBinary();
    if (!binary) {
      emitError({ runId, message: "未配置 iperf3 可执行文件" });
      activeRuns.delete(runId);
      return;
    }

    current.rawJson = [];
    current.stdoutBuffer = "";
    current.stderrBuffer = "";
    current.process = spawn(binary, current.args, { windowsHide: true });
    wireProcess(runId, current.process);
    emitLog({ runId, line: `重试: ${quoteCommand(current.command)}`, stream: "system" });
    return;
  }

  activeRuns.delete(runId);
  if (current.config.mode === "server" && !hasActiveServerRun()) {
    void stopDiscoveryResponder();
  }
  const summary = summarizeRun(runId, current, exitCode);
  sendPeerComplete(runId, current, summary);
  emitComplete({ runId, exitCode, signal, summary });
}

function handleProcessOutput(runId: string, stream: "stdout" | "stderr", text: string): void {
  const run = activeRuns.get(runId);
  if (!run) return;

  if (stream === "stdout") run.stdoutBuffer += text;
  else run.stderrBuffer += text;

  const bufferKey = stream === "stdout" ? "stdoutBuffer" : "stderrBuffer";
  const lines = run[bufferKey].split(/\r?\n/);
  run[bufferKey] = lines.pop() ?? "";

  for (const line of lines) {
    if (!line.trim()) continue;
    emitLog({ runId, line, stream });
    tryParseMetric(runId, run, line);
  }
}

function tryParseMetric(runId: string, run: ActiveRun, line: string): void {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return;

  try {
    const parsed = JSON.parse(trimmed);
    run.rawJson.push(parsed);
    const point = metricFromJson(runId, parsed);
    if (point) {
      emitMetric({ runId, point });
      sendPeerMetric(runId, run, point);
    }
  } catch {
    emitLog({ runId, line: "收到非完整 JSON 行，已保留在原始日志。", stream: "system" });
  }
}

function metricFromJson(runId: string, payload: any): IperfMetricEvent["point"] | null {
  const interval = payload?.event === "interval" ? payload.data : payload?.interval;
  const sum = interval?.sum ?? interval?.sum_sent ?? interval?.sum_received;
  if (!sum) return null;
  const stream = interval?.streams?.find((item: any) => item?.rtt !== undefined);
  const udpStream = interval?.streams?.find((item: any) => item?.udp)?.udp;

  return {
    id: `${runId}-${sum.end ?? Date.now()}`,
    seconds: Number(sum.end ?? 0),
    bitsPerSecond: Number(sum.bits_per_second ?? 0),
    bytes: Number(sum.bytes ?? 0),
    retransmits: optionalNumber(sum.retransmits ?? stream?.retransmits),
    jitterMs: optionalNumber(sum.jitter_ms ?? udpStream?.jitter_ms),
    lostPercent: optionalNumber(sum.lost_percent ?? udpStream?.lost_percent),
    rttMs: stream?.rtt === undefined ? undefined : Number(stream.rtt) / 1000,
    omitted: Boolean(sum.omitted)
  };
}

function summarizeRun(runId: string, run: ActiveRun, exitCode: number | null): RunSummary {
  const lastJson = run.rawJson[run.rawJson.length - 1] as any;
  const end = lastJson?.data ?? lastJson?.end ?? lastJson;
  const candidates = [end?.sum, end?.sum_sent, end?.sum_received, end?.streams?.[0]?.sender, end?.streams?.[0]?.receiver].filter(Boolean);
  const sum = candidates.sort((a: any, b: any) => Number(b?.bits_per_second ?? 0) - Number(a?.bits_per_second ?? 0))[0];

  const rate = Number(sum?.bits_per_second ?? 0);
  const summaryText = rate > 0 ? `${formatBits(rate)}/s` : exitCode === 0 ? "已完成" : "未生成摘要";

  return {
    runId,
    startedAt: run.startedAt,
    completedAt: new Date().toISOString(),
    config: run.config,
    command: run.command,
    exitCode,
    summaryText,
    rawJson: run.rawJson
  };
}

async function startPeerMetricServer(port: number): Promise<void> {
  if (peerMetricServer && peerMetricPort === port) return;
  await stopPeerMetricServer();

  peerMetricServer = http.createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.startsWith("/peer-")) {
      response.writeHead(404);
      response.end();
      return;
    }

    readRequestJson(request)
      .then((payload) => {
        const clientHost = normalizeRemoteAddress(request.socket.remoteAddress);
        if (request.url?.startsWith("/peer-metric") && payload?.point) {
          emitPeerMetric({
            runId: String(payload.runId ?? "peer"),
            point: payload.point,
            protocol: payload.protocol,
            clientHost
          });
        }
        if (request.url?.startsWith("/peer-complete") && payload?.summary) {
          emitPeerComplete({
            runId: String(payload.runId ?? "peer"),
            summary: payload.summary,
            clientHost
          });
        }
        response.writeHead(204);
        response.end();
      })
      .catch(() => {
        response.writeHead(400);
        response.end();
      });
  });

  await new Promise<void>((resolve) => {
    peerMetricServer?.once("error", (error) => {
      emitLog({ runId: "peer-metric", line: `客户端指标接收端口 ${port} 启动失败：${error.message}`, stream: "system" });
      peerMetricServer = null;
      peerMetricPort = null;
      resolve();
    });
    peerMetricServer?.listen(port, "0.0.0.0", () => {
      peerMetricPort = port;
      emitLog({ runId: "peer-metric", line: `客户端指标接收已启动，端口 ${port}`, stream: "system" });
      resolve();
    });
  });
}

function stopPeerMetricServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!peerMetricServer) {
      peerMetricPort = null;
      resolve();
      return;
    }
    peerMetricServer.close(() => {
      peerMetricServer = null;
      peerMetricPort = null;
      resolve();
    });
  });
}

async function startDiscoveryResponder(iperfPort: number): Promise<void> {
  const port = DISCOVERY_PORT;
  if (discoveryResponder && discoveryResponderPort === port) return;
  await stopDiscoveryResponder();

  const socket = dgram.createSocket("udp4");
  discoveryResponder = socket;

  socket.on("message", (message, rinfo) => {
    handleDiscoveryRequest(socket, message, rinfo, iperfPort);
  });
  socket.on("error", (error) => {
    emitLog({ runId: "discovery", line: `自动发现响应器异常：${error.message}`, stream: "system" });
  });

  await new Promise<void>((resolve) => {
    const handleStartupError = (error: Error) => {
      emitLog({ runId: "discovery", line: `自动发现响应器端口 ${port} 启动失败：${error.message}`, stream: "system" });
      if (discoveryResponder === socket) {
        discoveryResponder = null;
        discoveryResponderPort = null;
      }
      resolve();
    };
    socket.once("error", handleStartupError);
    socket.bind(port, "0.0.0.0", () => {
      socket.off("error", handleStartupError);
      discoveryResponderPort = port;
      emitLog({ runId: "discovery", line: `自动发现响应器已启动，端口 ${port}`, stream: "system" });
      resolve();
    });
  });
}

function stopDiscoveryResponder(): Promise<void> {
  return new Promise((resolve) => {
    if (!discoveryResponder) {
      discoveryResponderPort = null;
      resolve();
      return;
    }
    const socket = discoveryResponder;
    discoveryResponder = null;
    discoveryResponderPort = null;
    socket.close(() => resolve());
  });
}

function handleDiscoveryRequest(socket: UdpSocket, message: Buffer, rinfo: RemoteInfo, iperfPort: number): void {
  let payload: any;
  try {
    payload = JSON.parse(message.toString("utf8"));
  } catch {
    return;
  }

  if (payload?.type !== DISCOVERY_REQUEST_TYPE || payload?.version !== DISCOVERY_VERSION) return;

  const response = Buffer.from(JSON.stringify({
    type: DISCOVERY_RESPONSE_TYPE,
    version: DISCOVERY_VERSION,
    port: iperfPort
  }));
  socket.send(response, rinfo.port, rinfo.address);
}

async function findServers(): Promise<DiscoveredServer[]> {
  const interfaces = getIpv4BroadcastInterfaces();
  if (!interfaces.length) return [];

  const results = await Promise.all(interfaces.map((item) => discoverOnInterface(item)));
  return dedupeDiscoveredServers(results.flat()).sort((a, b) => a.latencyMs - b.latencyMs);
}

function discoverOnInterface(item: { name: string; address: string; broadcast: string }): Promise<DiscoveredServer[]> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const startedAt = Date.now();
    const found: DiscoveredServer[] = [];
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      try {
        socket.close();
      } catch {
        // Socket may already be closed after an interface-level error.
      }
      resolve(found);
    };

    socket.on("message", (message, rinfo) => {
      let payload: any;
      try {
        payload = JSON.parse(message.toString("utf8"));
      } catch {
        return;
      }
      if (payload?.type !== DISCOVERY_RESPONSE_TYPE || payload?.version !== DISCOVERY_VERSION) return;
      const discoveredPort = Number(payload.port);
      if (!Number.isInteger(discoveredPort) || discoveredPort < 1 || discoveredPort > 65535) return;
      found.push({
        host: normalizeRemoteAddress(rinfo.address) ?? rinfo.address,
        port: discoveredPort,
        localInterface: item.name,
        localAddress: item.address,
        latencyMs: Math.max(1, Date.now() - startedAt)
      });
    });

    socket.on("error", () => finish());
    socket.bind(0, item.address, () => {
      try {
        socket.setBroadcast(true);
        const payload = Buffer.from(JSON.stringify({
          type: DISCOVERY_REQUEST_TYPE,
          version: DISCOVERY_VERSION
        }));
        socket.send(payload, DISCOVERY_PORT, item.broadcast);
        setTimeout(() => {
          if (!finished) socket.send(payload, DISCOVERY_PORT, item.broadcast);
        }, 220);
      } catch {
        finish();
        return;
      }
      setTimeout(finish, DISCOVERY_TIMEOUT_MS);
    });
  });
}

function getIpv4BroadcastInterfaces(): Array<{ name: string; address: string; broadcast: string }> {
  const items: Array<{ name: string; address: string; broadcast: string }> = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const item of addresses ?? []) {
      if (item.internal || item.family !== "IPv4" || !item.netmask) continue;
      const broadcast = ipv4BroadcastAddress(item.address, item.netmask);
      if (!broadcast) continue;
      items.push({ name, address: item.address, broadcast });
    }
  }
  return items;
}

function ipv4BroadcastAddress(address: string, netmask: string): string | null {
  const ip = ipv4ToUint32(address);
  const mask = ipv4ToUint32(netmask);
  if (ip === null || mask === null) return null;
  return uint32ToIpv4(((ip & mask) | (~mask >>> 0)) >>> 0);
}

function ipv4ToUint32(value: string): number | null {
  const parts = value.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] << 24) >>> 0) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function uint32ToIpv4(value: number): string {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255
  ].join(".");
}

function dedupeDiscoveredServers(items: DiscoveredServer[]): DiscoveredServer[] {
  const seen = new Map<string, DiscoveredServer>();
  for (const item of items) {
    const key = `${item.host}:${item.port}:${item.localAddress}`;
    const existing = seen.get(key);
    if (!existing || item.latencyMs < existing.latencyMs) seen.set(key, item);
  }
  return [...seen.values()];
}

function hasActiveServerRun(): boolean {
  return [...activeRuns.values()].some((run) => run.config.mode === "server");
}

function sendPeerMetric(runId: string, run: ActiveRun, point: IperfMetricEvent["point"]): void {
  if (run.config.mode !== "client") return;
  postPeerPayload(run.config, "/peer-metric", {
    runId,
    protocol: run.config.protocol,
    point
  });
}

function sendPeerComplete(runId: string, run: ActiveRun, summary: RunSummary): void {
  if (run.config.mode !== "client") return;
  postPeerPayload(run.config, "/peer-complete", {
    runId,
    protocol: run.config.protocol,
    summary
  });
}

function postPeerPayload(config: TestConfig, endpoint: string, payload: unknown): void {
  const body = JSON.stringify(payload);
  const request = http.request(
    {
      host: config.host.trim(),
      port: metricRelayPort(config.port),
      path: endpoint,
      method: "POST",
      timeout: 800,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body)
      }
    },
    (response) => {
      response.resume();
    }
  );

  request.on("error", () => undefined);
  request.on("timeout", () => request.destroy());
  request.end(body);
}

function readRequestJson(request: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 1_000_000) {
        request.destroy();
        reject(new Error("payload too large"));
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function metricRelayPort(iperfPort: number): number {
  return iperfPort + 1;
}

function normalizeRemoteAddress(value?: string): string | undefined {
  if (!value) return undefined;
  return value.replace(/^::ffff:/, "");
}

function resolveIperfBinary(): string | null {
  const settings = getSettings();
  if (settings.iperfBinaryPath && existsSync(settings.iperfBinaryPath)) return settings.iperfBinaryPath;
  if (settings.binaryExists) return settings.bundledBinaryPath;
  return null;
}

function getSettings(): AppSettings {
  const stored = readSettings();
  const bundledBinaryPath = getBundledBinaryPath();
  return {
    iperfBinaryPath: stored.iperfBinaryPath ?? null,
    bundledBinaryPath,
    binaryExists: existsSync(bundledBinaryPath)
  };
}

function getNetworkAddresses(): LocalNetworkAddress[] {
  const items: LocalNetworkAddress[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const item of addresses ?? []) {
      if (item.internal) continue;
      if (item.family !== "IPv4" && item.family !== "IPv6") continue;
      items.push({
        name,
        address: item.address,
        family: item.family,
        mac: normalizeMacAddress(item.mac)
      });
    }
  }
  return items.sort((a, b) => {
    if (a.family !== b.family) return a.family === "IPv4" ? -1 : 1;
    return `${a.name}${a.address}`.localeCompare(`${b.name}${b.address}`);
  });
}

async function getMacAddress(ipAddress: string): Promise<string | null> {
  const normalizedIp = normalizeRemoteAddress(ipAddress.trim()) ?? ipAddress.trim();
  if (!normalizedIp) return null;

  const local = getNetworkAddresses().find((item) => item.address === normalizedIp && item.mac);
  if (local?.mac) return local.mac;

  if (!isIpv4Address(normalizedIp)) return null;
  try {
    const output = process.platform === "win32"
      ? await runCommand("arp", ["-a", normalizedIp])
      : await runCommand("arp", ["-n", normalizedIp]);
    return parseMacAddress(output);
  } catch {
    return null;
  }
}

function parseMacAddress(value: string): string | null {
  const match = value.match(/\b([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5}|[0-9a-f]{2}(?:-[0-9a-f]{2}){5})\b/i);
  return match ? normalizeMacAddress(match[1]) ?? null : null;
}

function sanitizeFilename(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|]/g, "_").trim();
  return cleaned.endsWith(".pdf") ? cleaned : `${cleaned || "端端测速链路测试报告"}.pdf`;
}

function normalizeMacAddress(value?: string): string | undefined {
  if (!value || value === "00:00:00:00:00:00") return undefined;
  const parts = value.replace(/-/g, ":").split(":");
  if (parts.length !== 6) return undefined;
  return parts.map((part) => part.padStart(2, "0").toLowerCase()).join(":");
}

function isIpv4Address(value: string): boolean {
  return ipv4ToUint32(value) !== null;
}

function readSettings(): Partial<AppSettings> {
  const file = settingsFilePath();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function saveSettings(settings: AppSettings): void {
  const file = settingsFilePath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2));
}

function settingsFilePath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

function getAppVersion(): string {
  try {
    const versionFile = path.join(__dirname, "../../version.json");
    const parsed = JSON.parse(readFileSync(versionFile, "utf8"));
    if (typeof parsed.version === "string" && parsed.version.trim()) return parsed.version.trim();
  } catch {
    // Fall back to package metadata if the standalone version file is missing or invalid.
  }
  return app.getVersion();
}

function createInitialUpdateState(): AppUpdateState {
  return {
    status: "idle",
    currentVersion: getAppVersion(),
    releaseUrl: UPDATE_RELEASES_URL,
    canInstallInApp: process.platform === "win32",
    platform: process.platform
  };
}

function setUpdateState(next: AppUpdateState): AppUpdateState {
  updateState = next;
  mainWindow?.webContents.send("app:updateState", updateState);
  return updateState;
}

async function checkForUpdates({ silent }: { silent: boolean }): Promise<AppUpdateState> {
  const currentVersion = getAppVersion();
  if (!silent) {
    setUpdateState({
      ...updateState,
      status: "checking",
      currentVersion,
      error: undefined
    });
  }

  try {
    const release = await requestLatestRelease();
    const latestVersion = normalizeVersion(release.tag_name || release.name || "");
    const hasUpdate = latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false;
    return setUpdateState({
      status: hasUpdate ? "available" : "not-available",
      currentVersion,
      latestVersion: latestVersion || undefined,
      releaseName: release.name || release.tag_name || undefined,
      releaseNotes: stripReleaseMarkdown(release.body || ""),
      releaseUrl: UPDATE_RELEASES_URL,
      checkedAt: new Date().toISOString(),
      canInstallInApp: process.platform === "win32",
      platform: process.platform
    });
  } catch (error) {
    return setUpdateState({
      ...updateState,
      status: "error",
      currentVersion,
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function installUpdate(): Promise<AppUpdateState> {
  if (process.platform !== "win32") {
    await shell.openExternal(UPDATE_RELEASES_URL);
    return updateState;
  }

  if (updateState.status !== "available") {
    const checked = await checkForUpdates({ silent: false });
    if (checked.status !== "available") return checked;
  }

  setUpdateState({ ...updateState, status: "downloading", error: undefined });
  try {
    autoUpdater.autoDownload = false;
    const result = await autoUpdater.checkForUpdates();
    if (!result) throw new Error("没有获取到可用的更新包");
    await autoUpdater.downloadUpdate();
    autoUpdater.quitAndInstall(false, true);
    return updateState;
  } catch (error) {
    return setUpdateState({
      ...updateState,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString()
    });
  }
}

interface GithubReleaseResponse {
  tag_name?: string;
  name?: string;
  body?: string;
}

function requestLatestRelease(): Promise<GithubReleaseResponse> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      RELEASE_API_URL,
      {
        headers: {
          "Accept": "application/vnd.github+json",
          "User-Agent": "E2Speed"
        },
        timeout: UPDATE_CHECK_TIMEOUT_MS
      },
      (response) => {
        if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400 && response.headers.location) {
          response.resume();
          reject(new Error("更新检查被重定向，请稍后重试"));
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`更新检查失败：HTTP ${response.statusCode ?? "unknown"}`));
          return;
        }

        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 2_000_000) {
            request.destroy(new Error("更新信息过大"));
          }
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(body || "{}"));
          } catch {
            reject(new Error("更新信息解析失败"));
          }
        });
      }
    );

    request.on("timeout", () => request.destroy(new Error("更新检查超时")));
    request.on("error", reject);
  });
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, "");
}

function compareVersions(a: string, b: string): number {
  const left = normalizeVersion(a).split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const right = normalizeVersion(b).split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function stripReleaseMarkdown(value: string): string {
  const cleaned = value
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "- ")
    .trim();
  return cleaned.slice(0, 4000);
}

function getProjectRoot(): string {
  if (app.isPackaged) return process.resourcesPath;
  return path.resolve(__dirname, "../../..");
}

function getWindowIconPath(): string | undefined {
  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, "build", "icon.png"),
        path.join(process.resourcesPath, "icon.png")
      ]
    : [
        path.join(getProjectRoot(), "desktop", "build", "icon.png")
      ];

  return candidates.find((candidate) => existsSync(candidate));
}

function getBundledBinaryPath(): string {
  const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
  const fileName = process.platform === "win32" ? "iperf3.exe" : "iperf3";
  return path.join(getProjectRoot(), "resources", "bin", platform, fileName);
}

function validateClientConfig(config: TestConfig): void {
  if (!config.host.trim()) throw new Error("服务器地址不能为空");
  if (!isPositiveNumericString(config.targetMbps)) throw new Error("线路标称带宽为必填项，单位 Mbps");
  validatePort(config.port);
  if (config.duration <= 0) throw new Error("测试时长必须大于 0");
  if (config.parallel <= 0) throw new Error("并发流数必须大于 0");
}

function validateServerConfig(config: ServerConfig): void {
  validatePort(config.port);
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口必须在 1-65535 之间");
}

function isPositiveNumericString(value: string): boolean {
  const numeric = Number(String(value).trim());
  return Number.isFinite(numeric) && numeric > 0;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function formatBits(bits: number): string {
  const units = ["bit", "Kbit", "Mbit", "Gbit", "Tbit"];
  let value = bits;
  let index = 0;
  while (value >= 1000 && index < units.length - 1) {
    value /= 1000;
    index += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 2)} ${units[index]}`;
}

function quoteCommand(command: string[]): string {
  return command.map((part) => (/\s/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part)).join(" ");
}

function emitLog(event: IperfLogEvent): void {
  mainWindow?.webContents.send("iperf:log", event);
}

function emitMetric(event: IperfMetricEvent): void {
  mainWindow?.webContents.send("iperf:metric", event);
}

function emitPeerMetric(event: IperfPeerMetricEvent): void {
  mainWindow?.webContents.send("iperf:peerMetric", event);
}

function emitComplete(event: IperfCompleteEvent): void {
  mainWindow?.webContents.send("iperf:complete", event);
}

function emitPeerComplete(event: IperfPeerCompleteEvent): void {
  mainWindow?.webContents.send("iperf:peerComplete", event);
}

function emitError(event: IperfErrorEvent): void {
  mainWindow?.webContents.send("iperf:error", event);
}

function stopAllRuns(): void {
  for (const run of activeRuns.values()) {
    run.process.kill();
  }
  activeRuns.clear();
  void stopPeerMetricServer();
  void stopDiscoveryResponder();
}

async function releaseListeningPort(port: number, excludeRunId?: string): Promise<void> {
  const activeServerRuns = [...activeRuns.entries()].filter(
    ([runId, run]) => runId !== excludeRunId && run.config.mode === "server" && run.config.port === port
  );

  for (const [runId, run] of activeServerRuns) {
    run.process.kill();
    activeRuns.delete(runId);
  }

  const pids = process.platform === "win32" ? await findWindowsListeningPids(port) : await findUnixListeningPids(port);
  const targets = pids.filter((pid) => pid > 0 && pid !== process.pid);

  for (const pid of targets) {
    if (process.platform === "win32") {
      await runCommand("taskkill", ["/PID", String(pid), "/T", "/F"]);
      continue;
    }

    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (!isMissingProcessError(error)) throw error;
    }
  }

  if (targets.length && process.platform !== "win32") {
    await delay(350);
    for (const pid of targets) {
      try {
        process.kill(pid, 0);
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (!isMissingProcessError(error)) throw error;
      }
    }
  }
}

async function findUnixListeningPids(port: number): Promise<number[]> {
  try {
    const output = await runCommand("lsof", ["-t", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
    return uniquePids(output.split(/\s+/));
  } catch (error) {
    if (isCommandExitError(error)) return [];
    throw new Error(`无法检查端口 ${port}：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function findWindowsListeningPids(port: number): Promise<number[]> {
  try {
    const output = await runCommand("netstat", ["-ano", "-p", "tcp"]);
    const pids: string[] = [];
    for (const line of output.split(/\r?\n/)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 5 || columns[0].toUpperCase() !== "TCP") continue;
      const localAddress = columns[1];
      const state = columns[3].toUpperCase();
      if (state === "LISTENING" && localAddress.endsWith(`:${port}`)) pids.push(columns[4]);
    }
    return uniquePids(pids);
  } catch (error) {
    throw new Error(`无法检查端口 ${port}：${error instanceof Error ? error.message : String(error)}`);
  }
}

function runCommand(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function uniquePids(values: string[]): number[] {
  return [...new Set(values.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))];
}

function isMissingProcessError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function isCommandExitError(error: unknown): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "number";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryPortConflict(run: ActiveRun): run is ActiveRun & { config: ServerConfig } {
  if (run.config.mode !== "server" || run.portRetryCount >= 1) return false;
  const rawError = run.rawJson.some((item: any) => {
    return item?.event === "error" && String(item?.data ?? "").includes("Address already in use");
  });
  return rawError || run.stderrBuffer.includes("Address already in use") || run.stdoutBuffer.includes("Address already in use");
}
