export type Protocol = "tcp" | "udp" | "sctp";
export type Direction = "upload" | "reverse" | "bidirectional";
export type IpVersion = "auto" | "ipv4" | "ipv6";
export type RunState = "idle" | "starting" | "running" | "stopping" | "completed" | "failed";

export interface AdvancedConfig {
  ipVersion: IpVersion;
  bindAddress: string;
  mss: string;
  noDelay: boolean;
  zeroCopy: boolean;
  dscp: string;
  tos: string;
  connectTimeout: string;
}

export interface TestConfig {
  mode: "client";
  targetMbps: string;
  protocol: Protocol;
  host: string;
  port: number;
  direction: Direction;
  duration: number;
  parallel: number;
  interval: number;
  bitrate: string;
  length: string;
  window: string;
  advanced: AdvancedConfig;
}

export interface ServerConfig {
  mode: "server";
  bindAddress: string;
  port: number;
  oneOff: boolean;
  idleTimeout: string;
  serverMaxDuration: string;
}

export interface IperfMetricPoint {
  id: string;
  seconds: number;
  bitsPerSecond: number;
  bytes: number;
  retransmits?: number;
  jitterMs?: number;
  lostPercent?: number;
  rttMs?: number;
  omitted?: boolean;
}

export interface RunSummary {
  runId: string;
  startedAt: string;
  completedAt: string;
  config: TestConfig | ServerConfig;
  command: string[];
  exitCode: number | null;
  summaryText: string;
  rawJson: unknown[];
  suite?: {
    tcp?: RunSummary;
    udp?: RunSummary;
    judgement?: string;
  };
}

export interface AppSettings {
  iperfBinaryPath: string | null;
  bundledBinaryPath: string;
  binaryExists: boolean;
}

export type UpdateStatus = "idle" | "checking" | "available" | "not-available" | "error" | "downloading";

export interface AppUpdateState {
  status: UpdateStatus;
  currentVersion: string;
  latestVersion?: string;
  releaseName?: string;
  releaseNotes?: string;
  releaseUrl: string;
  downloadUrl?: string;
  checkedAt?: string;
  error?: string;
  canInstallInApp: boolean;
  platform: string;
}

export interface LocalNetworkAddress {
  name: string;
  address: string;
  family: "IPv4" | "IPv6";
  mac?: string;
}

export interface DiscoveredServer {
  host: string;
  port: number;
  localInterface: string;
  localAddress: string;
  latencyMs: number;
}

export interface IperfRunStarted {
  runId: string;
  command: string[];
}

export interface IperfLogEvent {
  runId: string;
  line: string;
  stream: "stdout" | "stderr" | "system";
}

export interface IperfMetricEvent {
  runId: string;
  point: IperfMetricPoint;
}

export interface IperfPeerMetricEvent {
  runId: string;
  point: IperfMetricPoint;
  protocol?: Protocol;
  clientHost?: string;
}

export interface IperfCompleteEvent {
  runId: string;
  exitCode: number | null;
  signal: string | null;
  summary: RunSummary;
}

export interface IperfPeerCompleteEvent {
  runId: string;
  summary: RunSummary;
  clientHost?: string;
}

export interface IperfErrorEvent {
  runId?: string;
  message: string;
}

export interface IperfApi {
  getVersion: () => Promise<{ ok: boolean; version?: string; error?: string }>;
  startClient: (config: TestConfig) => Promise<IperfRunStarted>;
  startServer: (config: ServerConfig) => Promise<IperfRunStarted>;
  findServers: () => Promise<DiscoveredServer[]>;
  stop: (runId: string) => Promise<{ ok: boolean }>;
  onLog: (handler: (event: IperfLogEvent) => void) => () => void;
  onMetric: (handler: (event: IperfMetricEvent) => void) => () => void;
  onPeerMetric: (handler: (event: IperfPeerMetricEvent) => void) => () => void;
  onComplete: (handler: (event: IperfCompleteEvent) => void) => () => void;
  onPeerComplete: (handler: (event: IperfPeerCompleteEvent) => void) => () => void;
  onError: (handler: (event: IperfErrorEvent) => void) => () => void;
}

export interface SettingsApi {
  get: () => Promise<AppSettings>;
  getNetworkAddresses: () => Promise<LocalNetworkAddress[]>;
  getMacAddress: (ipAddress: string) => Promise<string | null>;
  selectIperfBinary: () => Promise<AppSettings>;
}

export interface WindowControlsApi {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
}

export interface ReportApi {
  savePdf: (payload: { html: string; filename: string }) => Promise<{ ok: boolean; filePath?: string; canceled?: boolean; error?: string }>;
}

export interface AppInfoApi {
  getVersion: () => Promise<string>;
  getUpdateState: () => Promise<AppUpdateState>;
  checkForUpdates: () => Promise<AppUpdateState>;
  installUpdate: () => Promise<AppUpdateState>;
  openUpdatePage: () => Promise<void>;
  onUpdateState: (handler: (event: AppUpdateState) => void) => () => void;
}

declare global {
  interface Window {
    appInfo: AppInfoApi;
    iperf: IperfApi;
    settings: SettingsApi;
    windowControls: WindowControlsApi;
    report: ReportApi;
  }
}
