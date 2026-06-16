import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  BarChart3,
  Download,
  Eye,
  FileText,
  History,
  Info,
  LoaderCircle,
  Maximize2,
  Minus,
  Play,
  Search,
  Server,
  Square,
  Trash2,
  Wifi,
  X
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import type {
  AppSettings,
  AppUpdateState,
  DiscoveredServer,
  IperfLogEvent,
  IperfMetricPoint,
  IperfPeerCompleteEvent,
  IperfPeerMetricEvent,
  LocalNetworkAddress,
  Protocol,
  RunState,
  RunSummary,
  ServerConfig,
  TestConfig
} from "../shared/types";
import "./styles.css";

type View = "test" | "history" | "about";
type WorkbenchMode = "client" | "server";
type SuitePhase = "idle" | "tcp" | "udp";

const PROJECT_REPOSITORY_URL = "https://github.com/willjohn6366-sketch/E2Speed";
const UPDATE_RELEASES_URL = "https://gh-proxy.org/https://github.com/willjohn6366-sketch/E2Speed/releases/latest";

interface ReportStats {
  rate: number;
  peakRate: number;
  minRate: number;
  avgRate: number;
  duration: number;
  bytes: number;
  retransmits?: number;
  jitterMs?: number;
  lostPercent?: number;
  rttMs?: number;
}

interface ClientSuiteState {
  active: boolean;
  baseConfig: TestConfig | null;
  tcpRunId?: string;
  udpRunId?: string;
  tcpSummary?: RunSummary;
}

interface PeerMetricPoint extends IperfMetricPoint {
  protocol?: Protocol;
}

const defaultClientConfig: TestConfig = {
  mode: "client",
  targetMbps: "",
  protocol: "tcp",
  host: "127.0.0.1",
  port: 5201,
  direction: "upload",
  duration: 10,
  parallel: 4,
  interval: 1,
  bitrate: "",
  length: "",
  window: "",
  advanced: {
    ipVersion: "auto",
    bindAddress: "",
    mss: "",
    noDelay: false,
    zeroCopy: false,
    dscp: "",
    tos: "",
    connectTimeout: ""
  }
};

const defaultServerConfig: ServerConfig = {
  mode: "server",
  bindAddress: "0.0.0.0",
  port: 5201,
  oneOff: false,
  idleTimeout: "",
  serverMaxDuration: ""
};

const fallbackSettings: AppSettings = {
  iperfBinaryPath: null,
  bundledBinaryPath: "resources/bin/<platform>/iperf3",
  binaryExists: false
};

const fallbackUpdateState: AppUpdateState = {
  status: "idle",
  currentVersion: "0.0.0",
  releaseUrl: UPDATE_RELEASES_URL,
  canInstallInApp: false,
  platform: "darwin"
};

function App() {
  const [view, setView] = useState<View>("test");
  const [workbenchMode, setWorkbenchMode] = useState<WorkbenchMode>("client");
  const [clientConfig, setClientConfig] = useState<TestConfig>(defaultClientConfig);
  const [serverConfig, setServerConfig] = useState<ServerConfig>(defaultServerConfig);
  const [settings, setSettings] = useState<AppSettings>(fallbackSettings);
  const [updateState, setUpdateState] = useState<AppUpdateState>(fallbackUpdateState);
  const [networkAddresses, setNetworkAddresses] = useState<LocalNetworkAddress[]>([]);
  const [version, setVersion] = useState("未检测");
  const [runState, setRunState] = useState<RunState>("idle");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRunMode, setActiveRunMode] = useState<WorkbenchMode | null>(null);
  const [metrics, setMetrics] = useState<IperfMetricPoint[]>([]);
  const [peerMetrics, setPeerMetrics] = useState<PeerMetricPoint[]>([]);
  const [peerSummaries, setPeerSummaries] = useState<RunSummary[]>([]);
  const [tcpMetrics, setTcpMetrics] = useState<IperfMetricPoint[]>([]);
  const [udpMetrics, setUdpMetrics] = useState<IperfMetricPoint[]>([]);
  const [logs, setLogs] = useState<IperfLogEvent[]>([]);
  const [history, setHistory] = useState<RunSummary[]>(() => loadHistory());
  const [currentSummary, setCurrentSummary] = useState<RunSummary | null>(null);
  const [message, setMessage] = useState("准备进行点对点带宽测试");
  const [suitePhase, setSuitePhase] = useState<SuitePhase>("idle");
  const [phaseStartedAt, setPhaseStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const suiteRef = useRef<ClientSuiteState>({ active: false, baseConfig: null });
  const logsRef = useRef<IperfLogEvent[]>([]);
  const manuallyStoppedRunIdsRef = useRef<Set<string>>(new Set());

  const isRunning = runState === "starting" || runState === "running" || runState === "stopping";

  useEffect(() => {
    if (!isRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [isRunning]);

  useEffect(() => {
    refreshRuntime();

    const offLog = window.iperf?.onLog((event) => {
      setLogs((items) => {
        const next = [...items.slice(-260), event];
        logsRef.current = next;
        return next;
      });
      setMessage(statusMessageFromLog(event));
    });
    const offMetric = window.iperf?.onMetric((event) => {
      const suite = suiteRef.current;
      if (suite.active && event.runId === suite.tcpRunId) {
        setTcpMetrics((items) => [...items.filter((point) => point.id !== event.point.id), event.point].slice(-120));
      } else if (suite.active && event.runId === suite.udpRunId) {
        setUdpMetrics((items) => [...items.filter((point) => point.id !== event.point.id), event.point].slice(-120));
      } else {
        setMetrics((items) => [...items.filter((point) => point.id !== event.point.id), event.point].slice(-120));
      }
      setRunState("running");
      setMessage("运行中");
    });
    const offPeerMetric = window.iperf?.onPeerMetric((event: IperfPeerMetricEvent) => {
      const point: PeerMetricPoint = { ...event.point, protocol: event.protocol };
      setPeerMetrics((items) => [...items.filter((item) => item.id !== point.id), point].slice(-120));
      setRunState("running");
      setMessage(event.clientHost ? `已收到客户端 ${event.clientHost} 的质量指标` : "已收到客户端质量指标");
    });
    const offPeerComplete = window.iperf?.onPeerComplete((event: IperfPeerCompleteEvent) => {
      setPeerSummaries((items) => {
        const next = [event.summary, ...items.filter((item) => item.runId !== event.summary.runId)].slice(0, 20);
        const syncedReport = synchronizedPeerReport(event.summary, next);
        if (syncedReport) saveReportToHistory(syncedReport, setHistory);
        return next;
      });
    });
    const offComplete = window.iperf?.onComplete((event) => {
      if (handleSuiteComplete(event.summary, event.exitCode)) return;

      if (manuallyStoppedRunIdsRef.current.delete(event.runId)) {
        setRunState("completed");
        setActiveRunId(null);
        setActiveRunMode(null);
        setMessage(event.summary.config.mode === "server" ? "服务端已停止" : "测试已停止");
        return;
      }

      setRunState(event.exitCode === 0 ? "completed" : "failed");
      setActiveRunId(null);
      setActiveRunMode(null);
      if (event.exitCode === 0) setCurrentSummary(event.summary);
      saveReportToHistory(event.summary, setHistory);
      setMessage(event.exitCode === 0 ? "待运行" : failureMessageForRun(event.summary, logsRef.current));
    });
    const offError = window.iperf?.onError((event) => {
      setRunState("failed");
      setActiveRunMode(null);
      setMessage(event.message);
    });
    const offUpdateState = window.appInfo?.onUpdateState?.((event) => {
      setUpdateState(event);
    });

    return () => {
      offLog?.();
      offMetric?.();
      offPeerMetric?.();
      offComplete?.();
      offPeerComplete?.();
      offError?.();
      offUpdateState?.();
    };
  }, []);

  async function refreshRuntime() {
    const appVersion = await window.appInfo?.getVersion?.();
    if (appVersion) setVersion(appVersion);
    const nextUpdateState = await window.appInfo?.getUpdateState?.();
    if (nextUpdateState) setUpdateState(nextUpdateState);
    const next = await window.settings?.get?.();
    if (next) setSettings(next);
    const addresses = await window.settings?.getNetworkAddresses?.();
    if (addresses) setNetworkAddresses(addresses);
  }

  async function startClient(config = clientConfig) {
    if (!isPositiveNumber(config.targetMbps)) {
      setRunState("failed");
      setActiveRunMode(null);
      setMessage("请填写线路标称带宽，单位 Mbps");
      return;
    }

    resetWorkbenchResults();
    setRunState("starting");
    setActiveRunMode("client");
    setSuitePhase("tcp");
    setPhaseStartedAt(Date.now());
    suiteRef.current = { active: true, baseConfig: normalizeClientConfig(config) };
    try {
      const tcpConfig: TestConfig = { ...normalizeClientConfig(config), protocol: "tcp", bitrate: "" };
      const result = await window.iperf.startClient(tcpConfig);
      suiteRef.current.tcpRunId = result.runId;
      setActiveRunId(result.runId);
      setRunState("running");
      setMessage("阶段 1/2：TCP 多线程极限带宽测试中");
    } catch (error) {
      suiteRef.current = { active: false, baseConfig: null };
      setSuitePhase("idle");
      setPhaseStartedAt(null);
      setRunState("failed");
      setActiveRunMode(null);
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function startServer() {
    resetWorkbenchResults();
    setRunState("starting");
    setActiveRunMode("server");
    setPhaseStartedAt(Date.now());
    try {
      const result = await window.iperf.startServer(serverConfig);
      setActiveRunId(result.runId);
      setRunState("running");
      setMessage("本机接收端监听中");
    } catch (error) {
      setRunState("failed");
      setActiveRunMode(null);
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function stopRun() {
    if (!activeRunId) return;
    manuallyStoppedRunIdsRef.current.add(activeRunId);
    setRunState("stopping");
    setMessage("正在停止");
    await window.iperf.stop(activeRunId);
    suiteRef.current = { active: false, baseConfig: null };
    setSuitePhase("idle");
    setPhaseStartedAt(null);
  }

  function resetWorkbenchResults() {
    setActiveRunId(null);
    setMetrics([]);
    setPeerMetrics([]);
    setPeerSummaries([]);
    setTcpMetrics([]);
    setUdpMetrics([]);
    setLogs([]);
    setCurrentSummary(null);
    logsRef.current = [];
    manuallyStoppedRunIdsRef.current.clear();
    suiteRef.current = { active: false, baseConfig: null };
    setSuitePhase("idle");
    setPhaseStartedAt(null);
  }

  function handleSuiteComplete(summary: RunSummary, exitCode: number | null): boolean {
    const suite = suiteRef.current;
    if (!suite.active) return false;

    if (summary.runId === suite.tcpRunId) {
      if (exitCode !== 0 || !suite.baseConfig) {
        suiteRef.current = { active: false, baseConfig: null };
        setSuitePhase("idle");
        setPhaseStartedAt(null);
        return false;
      }

      suite.tcpSummary = summary;
      const udpConfig: TestConfig = {
        ...suite.baseConfig,
        protocol: "udp",
        parallel: 1,
        bitrate: `${qualityUdpMbps(suite.baseConfig, summary)}M`
      };

      void window.iperf.startClient(udpConfig).then((result) => {
        suite.udpRunId = result.runId;
        setActiveRunId(result.runId);
        setSuitePhase("udp");
        setPhaseStartedAt(Date.now());
        setMessage("阶段 2/2：UDP 丢包与抖动测试中");
      }).catch((error) => {
        suiteRef.current = { active: false, baseConfig: null };
        setSuitePhase("idle");
        setPhaseStartedAt(null);
        setRunState("failed");
        setActiveRunMode(null);
        setMessage(error instanceof Error ? error.message : String(error));
      });
      return true;
    }

    if (summary.runId === suite.udpRunId && suite.tcpSummary && suite.baseConfig) {
      const combined = combineSuiteSummary(suite.baseConfig, suite.tcpSummary, summary);
      suiteRef.current = { active: false, baseConfig: null };
      setSuitePhase("idle");
      setPhaseStartedAt(null);
      setRunState(exitCode === 0 ? "completed" : "failed");
      setActiveRunId(null);
      setActiveRunMode(null);
      if (exitCode === 0) setCurrentSummary(combined);
      saveReportToHistory(combined, setHistory);
      setMessage(exitCode === 0 ? "待运行" : failureMessageForRun(summary, logsRef.current));
      return true;
    }

    return true;
  }

  function rerun(summary: RunSummary) {
    if (summary.config.mode === "client") {
      setClientConfig(normalizeClientConfig(summary.config));
      setView("test");
      void startClient(normalizeClientConfig(summary.config));
    } else {
      setServerConfig(normalizeServerConfig(summary.config));
      setView("test");
      setWorkbenchMode("server");
    }
  }

  function clearHistory() {
    localStorage.removeItem("iperf3-history");
    setHistory([]);
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <nav className="nav-list">
          <NavButton icon={<Wifi />} label="工作台" active={view === "test"} onClick={() => setView("test")} />
          <NavButton icon={<History />} label="测试报告" active={view === "history"} onClick={() => setView("history")} />
          <NavButton icon={<Info />} label="关于" active={view === "about"} onClick={() => setView("about")} />
        </nav>

        <div className="window-controls">
          <button aria-label="最小化" title="最小化" onClick={() => window.windowControls?.minimize()}>
            <Minus size={15} />
          </button>
          <button aria-label="最大化" title="最大化" onClick={() => window.windowControls?.toggleMaximize()}>
            <Maximize2 size={14} />
          </button>
          <button className="close" aria-label="关闭" title="关闭" onClick={() => window.windowControls?.close()}>
            <X size={15} />
          </button>
        </div>

      </header>

      <section className="workspace">
        {view === "test" && (
          <div className="workbench">
            <div className="workbench-toolbar">
              <div className="launch-panel">
                <div className="run-controls">
                  {isRunning ? (
                    <button className="danger-button" onClick={stopRun}>
                      <Square size={16} /> 停止
                    </button>
                  ) : (
                    <button className="primary-button" onClick={() => (workbenchMode === "server" ? startServer() : startClient())}>
                      <Play size={16} /> {workbenchMode === "server" ? "启动服务端" : "开始测速"}
                    </button>
                  )}
                  <StatusPill state={runState} mode={activeRunMode} message={message} />
                </div>
              </div>

              <div className="mode-switch">
                <button className={workbenchMode === "client" ? "mode-card active" : "mode-card"} onClick={() => setWorkbenchMode("client")}>
                  <Wifi size={20} />
                  <strong>客户端</strong>
                  <span>连接对端服务端，测线路极限带宽</span>
                </button>
                <button className={workbenchMode === "server" ? "mode-card active" : "mode-card"} onClick={() => setWorkbenchMode("server")}>
                  <Server size={20} />
                  <strong>服务端</strong>
                  <span>本机监听端口，等待对端发起测试</span>
                </button>
              </div>
            </div>

            {workbenchMode === "client" ? (
              <div className="content-grid product-grid">
                <TestSetupPanel
                  config={clientConfig}
                  onChange={setClientConfig}
                />
                <LiveResultPanel
                  tcpMetrics={tcpMetrics}
                  udpMetrics={udpMetrics}
                  targetMbps={clientConfig.targetMbps}
                  lastSummary={currentSummary ?? undefined}
                  phase={suitePhase}
                  isRunning={isRunning}
                  phaseStartedAt={phaseStartedAt}
                  phaseDuration={clientConfig.duration}
                  now={now}
                />
              </div>
            ) : (
              <div className="content-grid server-grid">
                <ServerPanel config={serverConfig} onChange={setServerConfig} networkAddresses={networkAddresses} />
                <ServerStatusPanel
                  peerMetrics={peerMetrics}
                  peerSummaries={peerSummaries}
                  logs={logs}
                  isRunning={isRunning}
                />
              </div>
            )}
          </div>
        )}

        {view === "history" && <HistoryPanel history={history} onClear={clearHistory} />}
        {view === "about" && <AboutPanel version={version} settings={settings} updateState={updateState} setUpdateState={setUpdateState} />}
      </section>
    </main>
  );
}

function NavButton(props: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button className={props.active ? "nav-button active" : "nav-button"} onClick={props.onClick}>
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}

function StatusPill({ state, mode, message }: { state: RunState; mode: WorkbenchMode | null; message: string }) {
  return <span className={`status-pill ${state}`}>{runStateLabel(state, mode, message)}</span>;
}

function TestSetupPanel({
  config,
  onChange
}: {
  config: TestConfig;
  onChange: (config: TestConfig) => void;
}) {
  const [discovering, setDiscovering] = useState(false);
  const [discoveryResults, setDiscoveryResults] = useState<DiscoveredServer[]>([]);
  const [discoveryMessage, setDiscoveryMessage] = useState("");
  const [showDiscovery, setShowDiscovery] = useState(false);
  const set = <K extends keyof TestConfig>(key: K, value: TestConfig[K]) => onChange({ ...config, [key]: value });
  const setAdvanced = <K extends keyof TestConfig["advanced"]>(key: K, value: TestConfig["advanced"][K]) =>
    onChange({ ...config, advanced: { ...config.advanced, [key]: value } });

  async function discoverServers() {
    setDiscovering(true);
    setDiscoveryMessage("");
    setDiscoveryResults([]);
    setShowDiscovery(true);
    try {
      const results = await window.iperf.findServers();
      setDiscoveryResults(results);
      if (!results.length) {
        setDiscoveryMessage("未发现同网段服务端，请确认服务端已启动且防火墙允许发现请求");
      }
    } catch (error) {
      setDiscoveryMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setDiscovering(false);
    }
  }

  function selectDiscoveredServer(server: DiscoveredServer) {
    onChange({ ...config, host: server.host, port: server.port });
    setShowDiscovery(false);
  }

  return (
    <section className="panel setup-panel">
      <div className="panel-heading">
        <Activity size={18} />
        <h2>测试参数</h2>
      </div>
      <div className="focus-form">
        <Field label="对端服务端地址">
          <div className="host-discovery-field">
            <input value={config.host} onChange={(event) => set("host", event.target.value)} />
            <button type="button" className="discover-button" disabled={discovering} onClick={discoverServers}>
              {discovering ? <LoaderCircle size={15} /> : <Search size={15} />}
              {discovering ? "查找中" : "自动查找"}
            </button>
            {showDiscovery && (
              <div className="discovery-popover">
                <div className="discovery-popover-head">
                  <strong>发现服务端</strong>
                  <button type="button" onClick={() => setShowDiscovery(false)}>关闭</button>
                </div>
                {discoveryResults.length > 0 ? (
                  <div className="discovery-list">
                    {discoveryResults.map((server) => (
                      <button
                        type="button"
                        className="discovery-result"
                        key={`${server.host}-${server.port}-${server.localAddress}`}
                        onClick={() => selectDiscoveredServer(server)}
                      >
                        <strong>{server.host}:{server.port}</strong>
                        <span>通过 {server.localInterface} · {server.latencyMs} ms</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="discovery-empty">
                    {discovering ? "正在扫描同网段服务端..." : discoveryMessage}
                  </div>
                )}
              </div>
            )}
          </div>
        </Field>
        <Field label="端口">
          <input type="number" value={config.port} onChange={(event) => set("port", numberValue(event.target.value))} />
        </Field>
        <Field label="线路标称（Mbps）">
          <input
            type="number"
            min="1"
            required
            placeholder="例如 100"
            value={config.targetMbps}
            onChange={(event) => set("targetMbps", event.target.value)}
          />
        </Field>
        <Field label="并发线程">
          <input type="number" value={config.parallel} onChange={(event) => set("parallel", numberValue(event.target.value))} />
        </Field>
        <Field label="测试时长（秒）">
          <input type="number" value={config.duration} onChange={(event) => set("duration", numberValue(event.target.value))} />
        </Field>
        <Field label="采样间隔 秒">
          <input type="number" value={config.interval} onChange={(event) => set("interval", numberValue(event.target.value))} />
        </Field>
      </div>

      <div className="test-flow-card">
        <strong>完整测试流程</strong>
        <span>先跑 TCP 多线程极限带宽，再跑 UDP 丢包、抖动和质量测试。</span>
      </div>

      <details className="advanced-box">
        <summary>高级参数</summary>
        <div className="form-grid">
          <Field label="IP 版本">
            <select
              value={config.advanced.ipVersion}
              onChange={(event) => setAdvanced("ipVersion", event.target.value as TestConfig["advanced"]["ipVersion"])}
            >
              <option value="auto">自动</option>
              <option value="ipv4">IPv4</option>
              <option value="ipv6">IPv6</option>
            </select>
          </Field>
          <Field label="绑定地址">
            <input value={config.advanced.bindAddress} onChange={(event) => setAdvanced("bindAddress", event.target.value)} />
          </Field>
          <Field label="块大小（字节）">
            <input value={config.length} onChange={(event) => set("length", event.target.value)} />
          </Field>
          <Field label="窗口大小（字节）">
            <input value={config.window} onChange={(event) => set("window", event.target.value)} />
          </Field>
        </div>
        <div className="toggle-row">
          <label>
            <input
              type="checkbox"
              checked={config.advanced.noDelay}
              onChange={(event) => setAdvanced("noDelay", event.target.checked)}
            />
            禁用 Nagle 算法
          </label>
          <label>
            <input
              type="checkbox"
              checked={config.advanced.zeroCopy}
              onChange={(event) => setAdvanced("zeroCopy", event.target.checked)}
            />
            零拷贝发送
          </label>
        </div>
      </details>
    </section>
  );
}

function LiveResultPanel({
  tcpMetrics,
  udpMetrics,
  targetMbps,
  lastSummary,
  phase,
  isRunning,
  phaseStartedAt,
  phaseDuration,
  now
}: {
  tcpMetrics: IperfMetricPoint[];
  udpMetrics: IperfMetricPoint[];
  targetMbps: string;
  lastSummary?: RunSummary;
  phase: SuitePhase;
  isRunning: boolean;
  phaseStartedAt: number | null;
  phaseDuration: number;
  now: number;
}) {
  const [selectedReport, setSelectedReport] = useState<RunSummary | null>(null);
  const [macLookup, setMacLookup] = useState<Record<string, string | null>>({});
  const liveTcp = reportFromMetrics(tcpMetrics);
  const liveUdp = reportFromMetrics(udpMetrics);
  const finalTcp = lastSummary ? tcpReportFromSummary(lastSummary) : null;
  const finalUdp = lastSummary ? udpReportFromSummary(lastSummary) : null;
  const isActivelyTesting = isRunning && phase !== "idle";
  const tcpReport = isActivelyTesting ? mergeReportStats(liveTcp, finalTcp) : finalTcp ?? liveTcp;
  const udpReport = isActivelyTesting ? mergeReportStats(liveUdp, finalUdp) : mergeReportStats(finalUdp, liveUdp);
  const targetBits = parseMbpsBits(targetMbps || normalizedTargetMbpsFromSummary(lastSummary));
  const utilization = tcpReport && targetBits ? Math.min((tcpReport.rate / targetBits) * 100, 999) : null;
  const fullJudgement = tcpReport ? formatFullJudgement(tcpReport, udpReport, targetMbps || normalizedTargetMbpsFromSummary(lastSummary)) : "";
  const lossGrade = gradePacketLoss(udpReport?.lostPercent);
  const jitterGrade = gradeJitter(udpReport?.jitterMs);
  const heroRate = tcpReport ? (isActivelyTesting ? tcpReport.rate : tcpReport.avgRate) : null;
  const chartData = tcpMetrics.map((point) => ({
    time: point.seconds.toFixed(0),
    Mbps: Number((point.bitsPerSecond / 1_000_000).toFixed(2))
  }));
  const displayRemaining = phase === "tcp" || phase === "udp" ? countdownSeconds(phaseStartedAt, phaseDuration, now) : null;
  const heroRateParts = heroRate ? formatHeroRate(heroRate) : null;

  useEffect(() => {
    if (!selectedReport) return;
    let cancelled = false;
    const endpoints = reportEndpoints(selectedReport);
    const addresses = [endpoints.clientIp, endpoints.serverIp].filter(Boolean) as string[];
    if (!addresses.length) return;

    void Promise.all(addresses.map(async (address) => [address, await window.settings?.getMacAddress?.(address)] as const)).then((items) => {
      if (cancelled) return;
      setMacLookup((current) => ({
        ...current,
        ...Object.fromEntries(items)
      }));
    });

    return () => {
      cancelled = true;
    };
  }, [selectedReport]);

  return (
    <section className="client-results">
      <div className="results-zone">
        <div className={isActivelyTesting ? "hero-result active" : "hero-result"}>
          <span>{isActivelyTesting ? "实时带宽" : "平均带宽"}</span>
          <strong className="hero-rate">
            {heroRateParts ? (
              <>
                <span className="hero-rate-value">{heroRateParts.value}</span>
                <span className="hero-rate-unit">{heroRateParts.unit}</span>
              </>
            ) : (
              "-"
            )}
          </strong>
          <div className="result-caption">
            {phase === "udp" && <span>UDP 质量测试中</span>}
            {phase === "tcp" && <span>TCP 带宽测试中</span>}
            {isActivelyTesting && <span>剩余 {formatCountdown(displayRemaining)}</span>}
            <span>峰值 {tcpReport ? `${formatRate(tcpReport.peakRate)}/s` : "-"}</span>
            <span>谷值 {tcpReport ? `${formatRate(tcpReport.minRate)}/s` : "-"}</span>
            <span>利用率 {utilization === null ? "-" : `${utilization.toFixed(1)}%`}</span>
          </div>
        </div>

        <div className="metric-strip report-metrics">
          <Metric label="往返时延" value={tcpReport?.rttMs !== undefined ? `${tcpReport.rttMs.toFixed(2)} ms` : "-"} />
          <Metric label="重传" value={tcpReport?.retransmits ?? "-"} />
          <Metric label="丢包" value={udpReport?.lostPercent !== undefined ? `${udpReport.lostPercent.toFixed(2)}%` : "-"} />
          <Metric label="抖动" value={udpReport?.jitterMs !== undefined ? `${udpReport.jitterMs.toFixed(2)} ms` : "-"} />
        </div>

        <div className="chart-panel primary-chart">
          <div className="panel-heading">
            <BarChart3 size={18} />
            <h2>实时带宽</h2>
          </div>
          <div className="chart-box">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="throughputFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#009a91" stopOpacity={0.38} />
                    <stop offset="95%" stopColor="#009a91" stopOpacity={0.04} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#d9ded5" />
                <XAxis dataKey="time" tickFormatter={(value) => `${value}s`} />
                <YAxis width={56} tickFormatter={(value) => `${value}M`} />
                <Tooltip formatter={(value) => [`${value} Mbps`, "带宽"]} labelFormatter={(label) => `${label} 秒`} />
                <Area type="monotone" dataKey="Mbps" stroke="#009a91" fill="url(#throughputFill)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {tcpReport && (
        <div className="report-card current-report">
          <div className="current-report-head">
            <div className="panel-heading">
              <FileText size={18} />
              <h2>本次报告</h2>
            </div>
            <button className="report-view-button" onClick={() => lastSummary && setSelectedReport(lastSummary)} disabled={!lastSummary}>
              <Eye size={16} /> 查询详情
            </button>
          </div>
          <p className="current-report-line">
            {fullJudgement}；丢包 {formatOptionalPercent(udpReport?.lostPercent)}（{lossGrade.label}），抖动 {formatOptionalMs(udpReport?.jitterMs)}（{jitterGrade.label}）
          </p>
        </div>
      )}
      {selectedReport && (
        <FullReportModal
          summary={selectedReport}
          macLookup={macLookup}
          onClose={() => setSelectedReport(null)}
        />
      )}
    </section>
  );
}

function ServerPanel({
  config,
  onChange,
  networkAddresses
}: {
  config: ServerConfig;
  onChange: (config: ServerConfig) => void;
  networkAddresses: LocalNetworkAddress[];
}) {
  const set = <K extends keyof ServerConfig>(key: K, value: ServerConfig[K]) => onChange({ ...config, [key]: value });

  return (
    <section className="panel setup-panel">
      <div className="panel-heading">
        <Server size={18} />
        <h2>接收参数</h2>
      </div>
      <div className="focus-form">
        <div className="field server-address-field">
          <span>监听网卡 IP</span>
          <NetworkAddressList addresses={networkAddresses} />
        </div>
        <Field label="监听端口">
          <input type="number" value={config.port} onChange={(event) => set("port", numberValue(event.target.value))} />
        </Field>
      </div>
    </section>
  );
}

function NetworkAddressList({ addresses }: { addresses: LocalNetworkAddress[] }) {
  if (!addresses.length) return <div className="network-address-list empty">未检测到可用网卡 IP</div>;

  return (
    <div className="network-address-list">
      {addresses.map((item) => (
        <div className="network-address" key={`${item.name}-${item.family}-${item.address}`}>
          <strong>{item.address}</strong>
          <span>{item.name} · {item.family}</span>
        </div>
      ))}
    </div>
  );
}

function ServerStatusPanel({
  peerMetrics,
  peerSummaries,
  logs,
  isRunning
}: {
  peerMetrics: PeerMetricPoint[];
  peerSummaries: RunSummary[];
  logs: IperfLogEvent[];
  isRunning: boolean;
}) {
  const connection = connectionFromLogs(logs);
  const peerTcpMetrics = currentMetricSegment(metricsForProtocol(peerMetrics, "tcp"));
  const peerUdpMetrics = currentMetricSegment(metricsForProtocol(peerMetrics, "udp"));
  const latestPeerTcpSummary = latestSummaryForProtocol(peerSummaries, "tcp");
  const latestPeerUdpSummary = latestSummaryForProtocol(peerSummaries, "udp");
  const peerTcpLiveReport = reportFromMetrics(peerTcpMetrics);
  const peerUdpLiveReport = reportFromMetrics(peerUdpMetrics);
  const peerTcpFinalReport = latestPeerTcpSummary ? reportFromSummary(latestPeerTcpSummary) : null;
  const peerUdpFinalReport = latestPeerUdpSummary ? reportFromSummary(latestPeerUdpSummary) : null;
  const testDuration = serverTestDurationFromLogs(logs);
  const latestMetric = peerTcpMetrics[peerTcpMetrics.length - 1];
  const isTesting = Boolean(isRunning && connection && latestMetric && !isServerTestEnded(logs));
  const displayTcpReport = isTesting ? mergeReportStats(peerTcpLiveReport, peerTcpFinalReport) : peerTcpFinalReport ?? peerTcpLiveReport;
  const displayUdpReport = isTesting ? mergeReportStats(peerUdpLiveReport, peerUdpFinalReport) : mergeReportStats(peerUdpFinalReport, peerUdpLiveReport);
  const displayReport = mergeReportStats(displayTcpReport, displayUdpReport);
  const remaining = isTesting ? remainingSeconds(testDuration, displayReport?.duration ?? 0) : null;
  const clientLabel = connection ? `${connection.host}${connection.port ? `:${connection.port}` : ""}` : "-";
  const chartMetrics = peerTcpMetrics;
  const chartData = chartMetrics.map((point) => ({
    time: point.seconds.toFixed(0),
    Mbps: Number((point.bitsPerSecond / 1_000_000).toFixed(2))
  }));

  return (
    <section className="panel service-panel">
      <div className={isTesting ? "service-hero active" : "service-hero"}>
        <div>
          <strong>{isTesting ? (displayReport ? `${formatRate(displayReport.avgRate)}/s` : "-") : "等待客户端连接"}</strong>
        </div>
        <div className="service-meta">
          <span><b>客户端</b>{isTesting ? clientLabel : "-"}</span>
          <span><b>剩余时间</b>{isTesting ? formatCountdown(remaining) : "-"}</span>
        </div>
      </div>

      <div className="server-live-grid">
        <Metric label="平均带宽" value={displayReport ? `${formatRate(displayReport.avgRate)}/s` : "-"} />
        <Metric label="峰值带宽" value={displayReport ? `${formatRate(displayReport.peakRate)}/s` : "-"} />
        <Metric label="传输数据" value={displayReport ? formatBytes(displayReport.bytes) : "-"} />
        <Metric label="测试时长" value={displayReport ? `${displayReport.duration.toFixed(1)} 秒` : "-"} />
      </div>

      <div className="server-live-grid secondary">
        <Metric label="往返时延" value={displayReport?.rttMs !== undefined ? `${displayReport.rttMs.toFixed(2)} ms` : "-"} />
        <Metric label="重传" value={displayReport?.retransmits ?? "-"} />
        <Metric label="丢包" value={displayReport?.lostPercent !== undefined ? `${displayReport.lostPercent.toFixed(2)}%` : "-"} />
        <Metric label="抖动" value={displayReport?.jitterMs !== undefined ? `${displayReport.jitterMs.toFixed(2)} ms` : "-"} />
      </div>

      <div className="chart-panel server-chart">
        <div className="panel-heading">
          <BarChart3 size={18} />
          <h2>实时带宽</h2>
        </div>
        <div className="chart-box">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="serverThroughputFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#009a91" stopOpacity={0.38} />
                  <stop offset="95%" stopColor="#009a91" stopOpacity={0.04} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#d9ded5" />
              <XAxis dataKey="time" tickFormatter={(value) => `${value}s`} />
              <YAxis width={56} tickFormatter={(value) => `${value}M`} />
              <Tooltip formatter={(value) => [`${value} Mbps`, "带宽"]} labelFormatter={(label) => `${label} 秒`} />
              <Area type="monotone" dataKey="Mbps" stroke="#009a91" fill="url(#serverThroughputFill)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </section>
  );
}

function HistoryPanel({ history, onClear }: { history: RunSummary[]; onClear: () => void }) {
  const [selectedReport, setSelectedReport] = useState<RunSummary | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [macLookup, setMacLookup] = useState<Record<string, string | null>>({});

  useEffect(() => {
    if (!selectedReport) return;
    let cancelled = false;
    const endpoints = reportEndpoints(selectedReport);
    const addresses = [endpoints.clientIp, endpoints.serverIp].filter(Boolean) as string[];
    if (!addresses.length) return;

    void Promise.all(addresses.map(async (address) => [address, await window.settings?.getMacAddress?.(address)] as const)).then((items) => {
      if (cancelled) return;
      setMacLookup((current) => ({
        ...current,
        ...Object.fromEntries(items)
      }));
    });

    return () => {
      cancelled = true;
    };
  }, [selectedReport]);

  return (
    <section className="panel wide-panel">
      <div className="report-toolbar">
        <button className="clear-report-button" onClick={() => setConfirmClear(true)} disabled={history.length === 0}>
          <Trash2 size={16} /> 清空
        </button>
      </div>
      <div className="report-history">
        {history.length === 0 && <div className="empty-state">暂无报告</div>}
        {history.map((item) => {
          const report = tcpReportFromSummary(item);
          const udpReport = udpReportFromSummary(item);
          return (
            <article className="report-card history-report" key={item.runId}>
              <div className="history-report-meta">
                <strong>{item.config.mode === "client" ? "客户端链路测试" : "服务端接收报告"}</strong>
                <span>{new Date(item.startedAt).toLocaleString()}</span>
                <code>{describeConfig(item.config)}</code>
              </div>
              <div className="history-report-rate">
                <span>平均带宽</span>
                <strong>{report ? `${formatRate(report.avgRate)}/s` : item.summaryText}</strong>
              </div>
              <div className="history-report-facts">
                <span><b>峰值</b>{report ? `${formatRate(report.peakRate)}/s` : "-"}</span>
                <span><b>谷值</b>{report ? `${formatRate(report.minRate)}/s` : "-"}</span>
                <span><b>丢包</b>{udpReport?.lostPercent !== undefined ? `${udpReport.lostPercent.toFixed(2)}%` : "-"}</span>
                <span><b>重传</b>{report?.retransmits ?? "-"}</span>
              </div>
              <div className="history-actions">
                <button className="report-view-button" onClick={() => setSelectedReport(item)}>
                  <Eye size={16} /> 查看完整报告
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {selectedReport && (
        <FullReportModal
          summary={selectedReport}
          macLookup={macLookup}
          onClose={() => setSelectedReport(null)}
        />
      )}
      {confirmClear && (
        <ConfirmDialog
          title="清空全部报告"
          message="确认清空并删除全部测试报告？此操作无法撤销。"
          confirmText="清空"
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => {
            onClear();
            setConfirmClear(false);
          }}
        />
      )}
    </section>
  );
}

function ConfirmDialog({
  title,
  message,
  confirmText,
  onCancel,
  onConfirm
}: {
  title: string;
  message: string;
  confirmText: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="confirm-backdrop" role="dialog" aria-modal="true">
      <article className="confirm-dialog">
        <h2>{title}</h2>
        <p>{message}</p>
        <div className="confirm-actions">
          <button className="ghost-button" onClick={onCancel}>取消</button>
          <button className="danger-button compact" onClick={onConfirm}>
            <Trash2 size={15} /> {confirmText}
          </button>
        </div>
      </article>
    </div>
  );
}

function FullReportModal({
  summary,
  macLookup,
  onClose
}: {
  summary: RunSummary;
  macLookup: Record<string, string | null>;
  onClose: () => void;
}) {
  const endpoints = reportEndpoints(summary);
  const tcpReport = tcpReportFromSummary(summary);
  const udpReport = udpReportFromSummary(summary);
  const targetMbps = normalizedTargetMbpsFromSummary(summary);
  const conclusion = formatFullJudgement(tcpReport, udpReport, targetMbps);
  const lossGrade = gradePacketLoss(udpReport?.lostPercent);
  const jitterGrade = gradeJitter(udpReport?.jitterMs);
  const config = summary.config;
  const duration = tcpReport ? (tcpReport.duration + (udpReport?.duration ?? 0)).toFixed(2) : "-";
  const reportNo = `LINK-${new Date(summary.startedAt).toISOString().slice(0, 10).replace(/-/g, "")}-${summary.runId.slice(0, 8).toUpperCase()}`;
  const reportDocumentId = `report-document-${summary.runId}`;

  async function downloadPdf() {
    const element = document.getElementById(reportDocumentId);
    if (!element) return;
    const filename = `端端测速链路测试报告-${reportNo}.pdf`;
    const result = await window.report?.savePdf?.({
      filename,
      html: buildReportPrintHtml(element.outerHTML)
    });
    if (result && !result.ok && !result.canceled) {
      window.alert(`PDF 下载失败：${result.error || "未知错误"}`);
    }
  }

  return (
    <div className="report-modal-backdrop" role="dialog" aria-modal="true">
      <article className="report-modal" id={reportDocumentId}>
        <header className="report-modal-head">
          <button className="icon-button" onClick={downloadPdf} title="下载 PDF" aria-label="下载 PDF">
            <Download size={16} />
          </button>
          <button className="icon-button" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </header>

        <div className="report-document-title">
          <span>E2Speed Network Performance Assessment</span>
          <h1>端端测速链路测试报告</h1>
          <div>
            <strong>报告编号：{reportNo}</strong>
            <strong>生成时间：{new Date().toLocaleString()}</strong>
          </div>
        </div>

        <section className="report-doc-section">
          <h2>一、链路信息</h2>
          <ReportTable
            rows={[
              ["测试开始时间", new Date(summary.startedAt).toLocaleString(), "测试完成时间", new Date(summary.completedAt).toLocaleString()],
              ["客户端 IP", endpoints.clientIp || "未获取", "客户端 MAC", macLookup[endpoints.clientIp || ""] || "未获取"],
              ["服务端 IP", endpoints.serverIp || "未获取", "服务端 MAC", macLookup[endpoints.serverIp || ""] || "未获取"]
            ]}
          />
        </section>

        <section className="report-doc-section">
          <h2>二、测试参数</h2>
          <ReportTable
            rows={[
              ["测试时长", `${duration} 秒`, "服务端端口", String(config.port)],
              ["线路标称", config.mode === "client" ? `${config.targetMbps || "-"} Mbps` : "-", "并发线程", config.mode === "client" ? String(config.parallel) : "-"],
              ["采样间隔", config.mode === "client" ? `${config.interval} 秒` : "-", "测试流程", summary.suite ? "TCP 极限带宽 + UDP 质量测试" : describeConfig(config)]
            ]}
          />
        </section>

        <section className="report-doc-section">
          <h2>三、测试结果</h2>
          <ReportTable
            rows={[
              ["平均带宽", tcpReport ? `${formatRate(tcpReport.avgRate)}/s` : "-", "峰值带宽", tcpReport ? `${formatRate(tcpReport.peakRate)}/s` : "-"],
              ["传输数据", tcpReport ? formatBytes(tcpReport.bytes) : "-", "TCP 重传", tcpReport?.retransmits !== undefined ? String(tcpReport.retransmits) : "-"],
              ["UDP 丢包", qualityValue(formatOptionalPercent(udpReport?.lostPercent), lossGrade), "UDP 抖动", qualityValue(formatOptionalMs(udpReport?.jitterMs), jitterGrade)]
            ]}
          />
        </section>

        <section className="report-doc-section conclusion">
          <h2>四、测试结论</h2>
          <p>{conclusion}。{qualityAdvice(lossGrade, jitterGrade)}</p>
        </section>

        <section className="report-doc-section report-statement">
          <span>
            本报告由 <a href="https://github.com/willjohn6366-sketch/E2Speed" target="_blank" rel="noreferrer">端端测速</a> 工具自动生成，测试结果以客户端同步的最终统计为准。
          </span>
        </section>

      </article>
    </div>
  );
}

function ReportTable({ rows }: { rows: Array<[string, string, string, string]> }) {
  return (
    <table className="report-doc-table">
      <tbody>
        {rows.map((row) => (
          <tr key={row.join("-")}>
            <th>{row[0]}</th>
            <td>{row[1]}</td>
            <th>{row[2]}</th>
            <td>{row[3]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function buildReportPrintHtml(reportHtml: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>端端测速链路测试报告</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: #102629;
      background: #ffffff;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    }
    .report-modal {
      display: grid;
      gap: 18px;
      width: 100%;
      max-width: none;
      max-height: none;
      padding: 0;
      background: #ffffff;
      box-shadow: none;
      overflow: visible;
    }
    .report-modal-head,
    .report-document-footer button {
      display: none !important;
    }
    .report-document-title {
      display: grid;
      gap: 10px;
      border-bottom: 2px solid #193a3d;
      padding-bottom: 16px;
      text-align: center;
    }
    .report-document-title span,
    .report-document-title strong,
    .report-document-footer span {
      color: #6f8081;
      font-size: 12px;
      font-weight: 800;
    }
    .report-document-title h1 {
      margin: 0;
      color: #102629;
      font-size: 28px;
      letter-spacing: 0;
    }
    .report-document-title div,
    .report-document-footer {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 12px;
    }
    .report-doc-section {
      display: grid;
      gap: 10px;
      break-inside: avoid;
    }
    .report-doc-section h2 {
      margin: 0;
      color: #193a3d;
      font-size: 16px;
    }
    .report-doc-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      border: 1px solid #cfdcda;
    }
    .report-doc-table th,
    .report-doc-table td {
      border: 1px solid #cfdcda;
      padding: 10px 12px;
      font-size: 13px;
      line-height: 1.45;
      text-align: left;
      vertical-align: top;
      overflow-wrap: anywhere;
    }
    .report-doc-table th {
      width: 18%;
      color: #395457;
      background: #f2f7f6;
      font-weight: 900;
    }
    .report-doc-table td {
      width: 32%;
      background: #ffffff;
    }
    .report-doc-section.conclusion {
      border: 1px solid #cfdcda;
      border-left: 4px solid #009a91;
      padding: 14px 16px;
      background: #f8fbfa;
    }
    .report-doc-section.conclusion p {
      margin: 0;
      color: #254346;
      font-size: 15px;
      font-weight: 900;
      line-height: 1.55;
    }
    .report-statement {
      border-top: 1px solid #cfdcda;
      border-bottom: 1px solid #cfdcda;
      padding: 10px 0;
      text-align: center;
    }
    .report-statement span,
    .report-statement a {
      color: #6f8081;
      font-size: 12px;
      font-weight: 800;
      text-decoration: none;
    }
    .report-document-footer {
      border-top: 0;
      padding-top: 0;
    }
  </style>
</head>
<body>${reportHtml}</body>
</html>`;
}

function AboutPanel({
  version,
  settings,
  updateState,
  setUpdateState
}: {
  version: string;
  settings: AppSettings;
  updateState: AppUpdateState;
  setUpdateState: React.Dispatch<React.SetStateAction<AppUpdateState>>;
}) {
  const displayVersion = version === "未检测" ? "未检测" : `v${version.replace(/^v/i, "")}`;
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
  const [noticeDialog, setNoticeDialog] = useState<{ title: string; message: string } | null>(null);
  const [updateMessage, setUpdateMessage] = useState("");
  const latestVersion = updateState.latestVersion ? `v${updateState.latestVersion.replace(/^v/i, "")}` : "";
  const hasUpdate = updateState.status === "available";

  async function handleUpdateButton() {
    if (updateState.status === "checking" || updateState.status === "downloading") return;
    if (hasUpdate) {
      setShowUpdateDialog(true);
      return;
    }

    setUpdateMessage("");
    const next = await window.appInfo.checkForUpdates();
    setUpdateState(next);
    if (next.status === "available") {
      setShowUpdateDialog(true);
    } else if (next.status === "not-available") {
      setUpdateMessage("当前已经是最新版本");
    } else if (next.status === "error") {
      const noManifest = next.error === "NO_MANIFEST";
      setNoticeDialog({
        title: noManifest ? "暂无更新清单" : "暂时无法检查更新",
        message: noManifest
          ? "仓库里的 version.json 还没有发布到可访问位置。更新清单可用后，这里就可以正常检查更新。"
          : "无法连接更新服务。当前环境可能没有互联网访问，稍后可以回到关于页面重新检查。"
      });
    }
  }

  async function confirmUpdate() {
    if (updateState.canInstallInApp) {
      const next = await window.appInfo.installUpdate();
      setUpdateState(next);
      if (next.status === "error") {
        setShowUpdateDialog(false);
        setNoticeDialog({
          title: "更新安装器启动失败",
          message: "可以稍后重新尝试，或者前往下载页手动下载安装包。"
        });
      }
      return;
    }

    await window.appInfo.openUpdatePage();
  }

  return (
    <section className="about-page">
      <article className="about-card">
        <h1>端端测速</h1>
        <p>
          面向局域网与专线链路的端端带宽测试工具，将服务端接收、客户端测速、自动发现与客户交付报告整合到同一个简洁界面中。
          让链路验证从命令行参数与零散数据中解放出来，真正实现“启动即测试，完成即交付”。
        </p>

        <div className="about-divider" />

        <div className="about-actions">
          <strong>当前版本 {displayVersion}</strong>
          <button type="button" onClick={handleUpdateButton} disabled={updateState.status === "checking" || updateState.status === "downloading"}>
            {updateButtonText(updateState)}
          </button>
        </div>
        {hasUpdate && (
          <span className="about-update-note">
            发现新版本 {latestVersion}
          </span>
        )}
        {updateMessage && <span className="about-update-note">{updateMessage}</span>}

        <footer className="about-credit">
          <span>
            by: 斯坦尼斯王夫斯基 <a className="about-source-link" href={PROJECT_REPOSITORY_URL} target="_blank" rel="noreferrer">查看源码</a>，基于 <a className="about-source-link" href="https://github.com/esnet/iperf" target="_blank" rel="noreferrer">iperf3</a> 开发
          </span>
        </footer>
        {!settings.binaryExists && <span className="about-runtime-note">内置 iperf3 二进制未找到，请检查运行资源。</span>}
      </article>

      {showUpdateDialog && (
        <div className="update-modal-backdrop" role="presentation">
          <section className="update-modal" role="dialog" aria-modal="true" aria-labelledby="update-title">
            <button className="update-modal-close" type="button" onClick={() => setShowUpdateDialog(false)} aria-label="关闭">
              <X size={18} />
            </button>
            <span className="update-modal-kicker">发现新版本</span>
            <h2 id="update-title">{latestVersion || "新版本"} 可用</h2>
            <p>{updateState.releaseName || "建议更新到最新版本，以获得最新修复和功能改进。"}</p>
            <div className="update-release-notes">
              {updateState.releaseNotes || "该版本暂未填写更新说明。"}
            </div>
            <div className="update-modal-actions">
              <button type="button" className="secondary" onClick={() => setShowUpdateDialog(false)}>稍后</button>
              <button type="button" onClick={confirmUpdate}>
                {updateState.canInstallInApp ? "立即更新" : "前往下载"}
              </button>
            </div>
          </section>
        </div>
      )}

      {noticeDialog && (
        <div className="update-modal-backdrop" role="presentation">
          <section className="update-modal update-notice-modal" role="dialog" aria-modal="true" aria-labelledby="update-notice-title">
            <button className="update-modal-close" type="button" onClick={() => setNoticeDialog(null)} aria-label="关闭">
              <X size={18} />
            </button>
            <span className="update-modal-kicker">更新提示</span>
            <h2 id="update-notice-title">{noticeDialog.title}</h2>
            <p>{noticeDialog.message}</p>
            <div className="update-modal-actions">
              <button type="button" onClick={() => setNoticeDialog(null)}>知道了</button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

function updateButtonText(updateState: AppUpdateState): string {
  if (updateState.status === "checking") return "正在检查";
  if (updateState.status === "downloading") return "正在下载";
  if (updateState.status === "available") return "发现新版本";
  return "检查更新";
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function reportFromMetrics(metrics: IperfMetricPoint[]): ReportStats | null {
  if (!metrics.length) return null;
  const latest = metrics[metrics.length - 1];
  const rates = metrics.map((item) => item.bitsPerSecond);
  const avgRate = rates.reduce((sum, value) => sum + value, 0) / rates.length;
  return {
    rate: latest.bitsPerSecond,
    peakRate: Math.max(...rates),
    minRate: Math.min(...rates),
    avgRate,
    duration: latest.seconds,
    bytes: metrics.reduce((sum, item) => sum + item.bytes, 0),
    retransmits: lastDefined(metrics, "retransmits"),
    jitterMs: lastDefined(metrics, "jitterMs"),
    lostPercent: lastDefined(metrics, "lostPercent"),
    rttMs: lastDefined(metrics, "rttMs")
  };
}

function qualityUdpMbps(config: TestConfig, tcpSummary: RunSummary): number {
  const nominalMbps = Number.parseFloat(config.targetMbps);
  const tcpReport = reportFromSummary(tcpSummary);
  const candidates = [
    Number.isFinite(nominalMbps) && nominalMbps > 0 ? nominalMbps * 0.1 : null,
    tcpReport && tcpReport.avgRate > 0 ? (tcpReport.avgRate / 1_000_000) * 0.2 : null,
    100
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);

  return Math.max(1, Math.round(Math.min(...candidates)));
}

type QualityLevel = "优秀" | "良好" | "一般" | "较差" | "未获取";

interface QualityGrade {
  label: QualityLevel;
  rank: number;
}

function gradePacketLoss(value?: number): QualityGrade {
  if (value === undefined) return { label: "未获取", rank: 0 };
  if (value <= 0.1) return { label: "优秀", rank: 4 };
  if (value <= 0.5) return { label: "良好", rank: 3 };
  if (value <= 1) return { label: "一般", rank: 2 };
  return { label: "较差", rank: 1 };
}

function gradeJitter(value?: number): QualityGrade {
  if (value === undefined) return { label: "未获取", rank: 0 };
  if (value <= 5) return { label: "优秀", rank: 4 };
  if (value <= 20) return { label: "良好", rank: 3 };
  if (value <= 50) return { label: "一般", rank: 2 };
  return { label: "较差", rank: 1 };
}

function qualityAdvice(loss: QualityGrade, jitter: QualityGrade): string {
  const worst = Math.min(loss.rank || 4, jitter.rank || 4);
  if (worst >= 4) return "链路质量稳定，可作为正常交付结果。";
  if (worst === 3) return "链路质量整体可用，建议结合业务峰值时段复测。";
  if (worst === 2) return "链路存在一定波动，建议检查带宽占用、队列拥塞或无线环境。";
  return "链路质量偏差，建议降低 UDP 测试带宽后复测，并排查端口、设备性能和中间网络。";
}

function qualityValue(value: string, grade: QualityGrade): string {
  return grade.label === "未获取" ? value : `${value}（${grade.label}）`;
}

function currentMetricSegment<T extends IperfMetricPoint>(metrics: T[]): T[] {
  if (metrics.length <= 1) return metrics;
  let start = 0;
  for (let index = 1; index < metrics.length; index += 1) {
    if (metrics[index].seconds <= metrics[index - 1].seconds) start = index;
  }
  return metrics.slice(start);
}

function metricsForProtocol(metrics: PeerMetricPoint[], protocol: Protocol): PeerMetricPoint[] {
  return metrics.filter((point) => point.protocol === protocol);
}

function latestSummaryForProtocol(summaries: RunSummary[], protocol: Protocol): RunSummary | undefined {
  return summaries.find((summary) => summary.config.mode === "client" && summary.config.protocol === protocol);
}

function mergeReportStats(primary: ReportStats | null, fallback: ReportStats | null): ReportStats | null {
  if (!primary) return fallback;
  if (!fallback) return primary;
  return {
    rate: primary.rate || fallback.rate,
    peakRate: Math.max(primary.peakRate, fallback.peakRate),
    minRate: minPositive(primary.minRate, fallback.minRate),
    avgRate: primary.avgRate || fallback.avgRate,
    duration: Math.max(primary.duration, fallback.duration),
    bytes: Math.max(primary.bytes, fallback.bytes),
    retransmits: primary.retransmits ?? fallback.retransmits,
    jitterMs: primary.jitterMs ?? fallback.jitterMs,
    lostPercent: primary.lostPercent ?? fallback.lostPercent,
    rttMs: primary.rttMs ?? fallback.rttMs
  };
}

function minPositive(...values: number[]): number {
  const positive = values.filter((value) => Number.isFinite(value) && value > 0);
  return positive.length ? Math.min(...positive) : 0;
}

function reportFromSummary(summary: RunSummary): ReportStats | null {
  if (summary.suite?.tcp) return reportFromSummary(summary.suite.tcp);

  const data = summaryEndData(summary);
  if (!data) return null;
  const udpStream = data.streams?.find((item: any) => item?.udp)?.udp;
  const stream = data.streams?.[0]?.sender ?? data.streams?.[0]?.receiver;
  const best = pickBestSummary([data.sum, data.sum_sent, data.sum_received, udpStream, stream]);
  if (!best) return null;
  return {
    rate: Number(best.bits_per_second ?? 0),
    peakRate: Number(best.bits_per_second ?? 0),
    minRate: Number(best.bits_per_second ?? 0),
    avgRate: Number(best.bits_per_second ?? 0),
    duration: Number(best.seconds ?? 0),
    bytes: Number(best.bytes ?? 0),
    retransmits: optionalNumber(data.sum_sent?.retransmits ?? stream?.retransmits),
    jitterMs: optionalNumber(data.sum_received?.jitter_ms ?? data.sum?.jitter_ms ?? udpStream?.jitter_ms ?? stream?.jitter_ms),
    lostPercent: optionalNumber(data.sum_received?.lost_percent ?? data.sum?.lost_percent ?? udpStream?.lost_percent ?? stream?.lost_percent),
    rttMs: optionalNumber(stream?.mean_rtt === undefined ? undefined : Number(stream.mean_rtt) / 1000)
  };
}

function summaryEndData(summary: RunSummary): any | null {
  const events = [...summary.rawJson].reverse() as any[];
  const serverOutput = events.find((item) => item?.event === "server_output_json" && item?.data?.end);
  if (serverOutput?.data?.end) return serverOutput.data.end;

  const endEvent = events.find((item) => item?.event === "end" || item?.end);
  return endEvent?.data ?? endEvent?.end ?? endEvent ?? null;
}

function tcpReportFromSummary(summary?: RunSummary): ReportStats | null {
  if (!summary) return null;
  return summary.suite?.tcp ? reportFromSummary(summary.suite.tcp) : reportFromSummary(summary);
}

function udpReportFromSummary(summary?: RunSummary): ReportStats | null {
  if (!summary) return null;
  return summary.suite?.udp ? reportFromSummary(summary.suite.udp) : null;
}

function combineSuiteSummary(baseConfig: TestConfig, tcp: RunSummary, udp: RunSummary): RunSummary {
  const tcpReport = reportFromSummary(tcp);
  const udpReport = reportFromSummary(udp);
  const judgement = formatFullJudgement(tcpReport, udpReport, baseConfig.targetMbps);

  return {
    runId: `${tcp.runId}+${udp.runId}`,
    startedAt: tcp.startedAt,
    completedAt: udp.completedAt,
    config: baseConfig,
    command: [...tcp.command, "then", ...udp.command],
    exitCode: tcp.exitCode === 0 && udp.exitCode === 0 ? 0 : 1,
    summaryText: tcpReport ? `${formatRate(tcpReport.rate)}/s` : "完整测试完成",
    rawJson: [],
    suite: {
      tcp,
      udp,
      judgement
    }
  };
}

function synchronizedPeerReport(summary: RunSummary, peerSummaries: RunSummary[]): RunSummary | null {
  if (summary.config.mode !== "client") return null;
  if (summary.suite) return summary;

  const tcp = latestPeerRun(peerSummaries, "tcp", summary.config);
  const udp = latestPeerRun(peerSummaries, "udp", summary.config);
  if (!tcp || !udp) return null;

  const baseConfig = tcp.config.mode === "client" ? tcp.config : summary.config;
  return combineSuiteSummary(baseConfig, tcp, udp);
}

function latestPeerRun(summaries: RunSummary[], protocol: Protocol, config: TestConfig): RunSummary | undefined {
  return summaries.find((item) => {
    if (item.config.mode !== "client") return false;
    return item.config.protocol === protocol && item.config.host === config.host && item.config.port === config.port;
  });
}

function saveReportToHistory(summary: RunSummary, setHistory: React.Dispatch<React.SetStateAction<RunSummary[]>>): void {
  setHistory((items) => {
    const next = [summary, ...items.filter((item) => item.runId !== summary.runId)].slice(0, 100);
    localStorage.setItem("iperf3-history", JSON.stringify(next));
    return next;
  });
}

function statusMessageFromLog(event: IperfLogEvent): string {
  if (event.stream === "system") return event.line.length > 120 ? "iperf3 进程状态已更新" : event.line;

  const line = event.line.trim();
  if (!line.startsWith("{")) return line.length > 120 ? `${line.slice(0, 117)}...` : line;

  try {
    const payload = JSON.parse(line);
    const accepted = payload?.data?.accepted_connection;
    if (accepted?.host) return `已连接客户端 ${accepted.host}:${accepted.port ?? ""}`;
    if (payload.event === "end") return "测试结束，正在整理报告";
    if (payload.event === "interval") return "测试运行中，已收到实时采样";
    if (payload.event === "start") return "测试已启动，正在建立连接";
    if (payload.event === "error") return String(payload.data ?? "iperf3 返回错误");
  } catch {
    return "收到 iperf3 输出";
  }

  return "收到程序输出";
}

function failureMessageForRun(summary: RunSummary, logs: IperfLogEvent[]): string {
  const rawMessages = [
    ...summary.rawJson.map(errorTextFromJson).filter(Boolean),
    ...logs
      .filter((item) => item.runId === summary.runId || summary.runId.includes(item.runId))
      .map((item) => item.line)
  ] as string[];

  const joined = rawMessages.join("\n");
  const config = summary.config;
  const target = config.mode === "client" ? `${config.host}:${config.port}` : `端口 ${config.port}`;

  if (isNetworkFailure(joined)) {
    return config.mode === "client"
      ? `网络连接失败，请检查目标地址和端口（${target}）`
      : `网络连接异常，请检查本机监听端口和防火墙（${target}）`;
  }

  const explicit = rawMessages.map(cleanIperfError).find(Boolean);
  if (explicit) return explicit;
  return "运行失败，请重新检查网络、端口和 iperf3 配置";
}

function errorTextFromJson(item: unknown): string {
  const payload = item as any;
  if (payload?.event === "error") return String(payload.data ?? "");
  if (payload?.error) return String(payload.error);
  return "";
}

function cleanIperfError(value: string): string {
  return value
    .replace(/^iperf3?:\s*/i, "")
    .replace(/^error\s*-\s*/i, "")
    .trim();
}

function isNetworkFailure(value: string): boolean {
  return /unable to connect|connection refused|connection timed out|timed out|no route to host|network is unreachable|host is down|could not resolve|name or service not known|nodename nor servname|temporary failure in name resolution|getaddrinfo|econnrefused|etimedout|enotfound|ehostunreach|enetunreach/i.test(value);
}

function connectionFromLogs(logs: IperfLogEvent[]): { host: string; port?: number } | null {
  for (const event of [...logs].reverse()) {
    const line = event.line.trim();
    if (line.startsWith("{")) {
      try {
        const payload = JSON.parse(line);
        const accepted = payload?.data?.accepted_connection;
        if (accepted?.host) return { host: String(accepted.host), port: optionalNumber(accepted.port) };
        const connected = payload?.data?.connected?.find((item: any) => item?.remote_host);
        if (connected?.remote_host) {
          return { host: String(connected.remote_host), port: optionalNumber(connected.remote_port) };
        }
      } catch {
        continue;
      }
    }

    const textMatch = line.match(/accepted connection from ([^,\s]+), port (\d+)/i);
    if (textMatch) return { host: textMatch[1], port: Number(textMatch[2]) };
  }

  return null;
}

function reportEndpoints(summary: RunSummary): { clientIp?: string; serverIp?: string } {
  const source = summary.suite?.tcp ?? summary;
  const startEvent = source.rawJson.find((item: any) => item?.event === "start" || item?.start) as any;
  const start = startEvent?.data ?? startEvent?.start ?? startEvent;
  const connected = start?.connected?.find((item: any) => item?.local_host || item?.remote_host);
  const config = summary.config;

  if (config.mode === "client") {
    return {
      clientIp: normalizeDisplayIp(connected?.local_host),
      serverIp: normalizeDisplayIp(connected?.remote_host ?? config.host)
    };
  }

  return {
    clientIp: normalizeDisplayIp(connected?.remote_host),
    serverIp: normalizeDisplayIp(connected?.local_host ?? config.bindAddress)
  };
}

function normalizeDisplayIp(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/^::ffff:/, "");
  return normalized === "0.0.0.0" || normalized === "::" ? undefined : normalized;
}

function describeConfig(config: RunSummary["config"]): string {
  if (config.mode === "server") return `服务端 ${config.bindAddress || "0.0.0.0"}:${config.port}`;
  return `${config.protocol.toUpperCase()} ${config.host}:${config.port} ${config.parallel} 线程 ${config.duration}s`;
}

function remainingSeconds(duration: number | null, elapsedSeconds: number): number | null {
  if (duration === null || !Number.isFinite(duration) || duration <= 0) return null;
  const remaining = Math.max(0, Math.ceil(duration - elapsedSeconds));
  return Number.isFinite(remaining) ? remaining : null;
}

function countdownSeconds(startedAt: number | null, duration: number, now: number): number | null {
  if (!startedAt || !Number.isFinite(duration) || duration <= 0) return null;
  return Math.max(0, Math.ceil(duration - (now - startedAt) / 1000));
}

function formatCountdown(seconds: number | null): string {
  if (seconds === null) return "测试中";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function serverTestDurationFromLogs(logs: IperfLogEvent[]): number | null {
  for (const event of logs) {
    const line = event.line.trim();
    if (!line.startsWith("{")) continue;
    try {
      const payload = JSON.parse(line);
      const duration = payload?.data?.test_start?.duration;
      const numeric = Number(duration);
      if (Number.isFinite(numeric) && numeric > 0) return numeric;
    } catch {
      continue;
    }
  }
  return null;
}

function isServerTestEnded(logs: IperfLogEvent[]): boolean {
  for (const event of [...logs].reverse()) {
    const line = event.line.trim();
    if (!line.startsWith("{")) continue;
    try {
      const payload = JSON.parse(line);
      if (payload?.event === "end") return true;
      if (payload?.event === "interval") return false;
      if (payload?.data?.test_start) return false;
      if (payload?.data?.accepted_connection) return false;
    } catch {
      continue;
    }
  }
  return false;
}

function numberValue(value: string): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function lastDefined<T extends keyof IperfMetricPoint>(items: IperfMetricPoint[], key: T): IperfMetricPoint[T] | undefined {
  for (const item of [...items].reverse()) {
    if (item[key] !== undefined) return item[key];
  }
  return undefined;
}

function pickBestSummary(candidates: unknown[]): any | null {
  const valid = candidates.filter(Boolean) as any[];
  if (!valid.length) return null;
  return valid.sort((a, b) => Number(b?.bits_per_second ?? 0) - Number(a?.bits_per_second ?? 0))[0];
}

function parsedLogPayloads(logs: IperfLogEvent[]): any[] {
  const payloads: any[] = [];
  for (const event of logs) {
    const line = event.line.trim();
    if (!line.startsWith("{")) continue;
    try {
      payloads.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return payloads;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function parseMbpsBits(value: string): number | null {
  const numeric = Number(String(value).trim());
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric * 1_000_000;
}

function isPositiveNumber(value: string): boolean {
  const numeric = Number(String(value).trim());
  return Number.isFinite(numeric) && numeric > 0;
}

function normalizedTargetMbpsFromSummary(summary?: RunSummary): string {
  const config = summary?.config;
  if (config?.mode !== "client") return "";
  return config.targetMbps || "";
}

function formatFullJudgement(report: ReportStats | null, udpReport: ReportStats | null, targetMbps: string): string {
  if (!report) return "等待测试结果";
  const targetBits = parseMbpsBits(targetMbps);
  if (!targetBits) return "缺少线路标称";
  const percent = (report.rate / targetBits) * 100;
  const target = `${Number(targetMbps).toFixed(Number(targetMbps) % 1 === 0 ? 0 : 1)}Mbps`;
  const lossGrade = gradePacketLoss(udpReport?.lostPercent);
  const jitterGrade = gradeJitter(udpReport?.jitterMs);
  const quality = udpReport
    ? `；丢包 ${qualityValue(formatOptionalPercent(udpReport.lostPercent), lossGrade)}，抖动 ${qualityValue(formatOptionalMs(udpReport.jitterMs), jitterGrade)}`
    : "";
  if (percent > 150) {
    const multiple = report.rate / targetBits;
    return `实测超过标称 ${target} 的 ${multiple.toFixed(multiple >= 10 ? 1 : 2)} 倍，请确认标称带宽或单位是否正确${quality}`;
  }
  if (percent >= 105) return `实测高于标称 ${target}，达到 ${percent.toFixed(1)}%${quality}`;
  if (percent >= 90) return `线路接近标称 ${target}，达到 ${percent.toFixed(1)}%${quality}`;
  return `达到标称 ${target} 的 ${percent.toFixed(1)}%，未跑满${quality}`;
}

function formatOptionalPercent(value?: number): string {
  return value === undefined ? "-" : `${value.toFixed(2)}%`;
}

function formatOptionalMs(value?: number): string {
  return value === undefined ? "-" : `${value.toFixed(2)} ms`;
}

function formatRate(bits: number): string {
  if (bits >= 1_000_000_000) return `${(bits / 1_000_000_000).toFixed(2)} Gbit`;
  if (bits >= 1_000_000) return `${(bits / 1_000_000).toFixed(2)} Mbit`;
  if (bits >= 1_000) return `${(bits / 1_000).toFixed(2)} Kbit`;
  return `${bits.toFixed(0)} bit`;
}

function formatHeroRate(bits: number): { value: string; unit: string } {
  if (bits >= 1_000_000_000) return { value: (bits / 1_000_000_000).toFixed(2), unit: "Gbit/s" };
  if (bits >= 1_000_000) return { value: (bits / 1_000_000).toFixed(2), unit: "Mbit/s" };
  if (bits >= 1_000) return { value: (bits / 1_000).toFixed(2), unit: "Kbit/s" };
  return { value: bits.toFixed(0), unit: "bit/s" };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(2)} KB`;
  return `${bytes.toFixed(0)} B`;
}

function runStateLabel(state: RunState, mode: WorkbenchMode | null = null, message = ""): string {
  if (state === "failed") return `错误：${message || "运行失败"}`;
  if (state === "starting" || state === "running" || state === "stopping") {
    return mode === "server" ? "服务端运行中" : "客户端运行中";
  }
  return "待运行";
}

function loadHistory(): RunSummary[] {
  try {
    return JSON.parse(localStorage.getItem("iperf3-history") ?? "[]");
  } catch {
    return [];
  }
}

function normalizeServerConfig(config: ServerConfig): ServerConfig {
  return {
    ...config,
    bindAddress: config.bindAddress || "0.0.0.0",
    oneOff: false
  };
}

function normalizeClientConfig(config: TestConfig): TestConfig {
  return {
    ...config,
    targetMbps: config.targetMbps || "",
    direction: "upload"
  };
}

createRoot(document.getElementById("root")!).render(<App />);
