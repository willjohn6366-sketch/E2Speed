# iperf3 Visual Studio 产品与架构方案

## 目标

把 iperf3 从命令行工具包装成跨平台桌面 GUI，降低测试门槛，让用户通过表单调整常用参数、启动客户端/服务端、查看实时曲线和历史结果，同时保留等价命令，方便高级用户复现。

## 产品形态

- 使用 Electron 桌面应用，首版优先 Windows，保留 macOS 和 Linux 路径。
- 底层不重写 iperf3 测速逻辑，主进程调用项目内置或用户指定的 `iperf3` 可执行文件。
- 项目内复制 iperf3 源码到 `vendor/iperf-3.21/`，不跨目录引用父级源码，便于整体移动。

## 功能布局

- 快速测试：一屏完成服务端地址、端口、协议、方向、时长、并发、带宽设置，并实时查看结果。
- 客户端：完整客户端参数表单，支持 TCP/UDP/SCTP、上传、下载、双向、IPv4/IPv6、绑定地址、MSS、NoDelay、ZeroCopy、DSCP/TOS、连接超时。
- 服务端：端口、单次连接、空闲超时、最大测试时长、服务端带宽限制，以及启动/停止和连接日志。
- 历史记录：保存每次测试配置、摘要、原始 JSON，支持重新运行和导出。
- 设置：显示 iperf3 路径、版本检测和自定义二进制选择。

## 技术架构

- Renderer：React + TypeScript + Vite，负责 UI、表单、图表和历史展示。
- Main Process：Electron 主进程，负责进程管理、IPC、文件系统、本地配置。
- Shared：共享类型和命令构建器，避免前后端参数理解不一致。
- Runtime：`resources/bin/<platform>/iperf3`，没有内置二进制时允许用户选择外部路径。

## IPC

- `iperf:getVersion`
- `iperf:startClient`
- `iperf:startServer`
- `iperf:stop`
- `settings:get`
- `settings:selectIperfBinary`

## 命令策略

- 不使用 shell 字符串，只使用 `child_process.spawn(binary, argv)`。
- 客户端默认加入 `--json-stream --forceflush`。
- 服务端默认加入 `--json-stream --forceflush`。
- 前端始终显示等价命令，便于复制和排错。

## 首版验收

- 项目移动后不依赖父目录。
- 缺少二进制时界面清晰提示并可选择路径。
- 可以启动/停止服务端。
- 可以发起客户端测试并解析 JSON stream。
- TCP/UDP 常用指标能以图表和摘要展示。
- 历史记录能保存和重跑。
