import type { ServerConfig, TestConfig } from "./types";

export function buildClientArgs(config: TestConfig): string[] {
  const args = ["-c", config.host.trim(), "-p", String(config.port), "--json-stream", "--forceflush"];

  if (config.protocol === "udp") args.push("--udp", "--get-server-output");
  if (config.protocol === "sctp") args.push("--sctp");
  if (config.direction === "reverse") args.push("--reverse");
  if (config.direction === "bidirectional") args.push("--bidir");

  args.push("--time", String(config.duration));
  args.push("--parallel", String(config.parallel));
  args.push("--interval", String(config.interval));

  pushValue(args, "--bitrate", config.protocol === "udp" && !config.bitrate ? `${config.targetMbps}M` : config.bitrate);
  pushValue(args, "--length", config.length);
  pushValue(args, "--window", config.window);

  if (config.advanced.ipVersion === "ipv4") args.push("--version4");
  if (config.advanced.ipVersion === "ipv6") args.push("--version6");
  pushValue(args, "--bind", config.advanced.bindAddress);
  pushValue(args, "--set-mss", config.advanced.mss);
  if (config.advanced.noDelay) args.push("--no-delay");
  if (config.advanced.zeroCopy) args.push("--zerocopy");
  pushValue(args, "--dscp", config.advanced.dscp);
  pushValue(args, "--tos", config.advanced.tos);
  pushValue(args, "--connect-timeout", config.advanced.connectTimeout);

  return args;
}

export function buildServerArgs(config: ServerConfig): string[] {
  const args = ["--server", "--port", String(config.port), "--json-stream", "--forceflush"];

  pushValue(args, "--bind", config.bindAddress || "0.0.0.0");
  if (config.oneOff) args.push("--one-off");
  pushValue(args, "--idle-timeout", config.idleTimeout);
  pushValue(args, "--server-max-duration", config.serverMaxDuration);

  return args;
}

export function commandPreview(binaryPath: string, args: string[]): string[] {
  return [binaryPath, ...args];
}

function pushValue(args: string[], flag: string, value: string | number | undefined): void {
  if (value === undefined) return;
  const normalized = String(value).trim();
  if (!normalized) return;
  args.push(flag, normalized);
}
