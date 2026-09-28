# 站点探查用 playwright-cli 而非 playwright-mcp

写脚本前需要看清目标站点的真实 DOM、页面脚本与网络行为，这要求一个能被 agent 驱动的浏览器。我们让 agent 通过全局安装的 `@playwright/cli`（含其官方 skill）做探查会话，而不是通过 `microsoft/playwright-mcp`。

两者驱动同一个浏览器引擎，取舍在上下文成本与状态模型：MCP 把工具 schema 与可访问性树持续灌进上下文，换回跨调用的持久浏览器状态；CLI 每次只返回当次需要的那一段事实，代价是会话状态要调用方自己用 `-s=<session>` 管理。本仓库的交付物都是单文件油猴脚本，agent 的上下文更该留给目标站点的代码与页面自身的脚本，因此选了 token 更省的 CLI。

## Considered Options

- **playwright-mcp**：官方定位为"需要持久状态与深度内省的专用 agent 循环"，与本研究场景其实贴合；放弃它是因为每次探查动作的固定上下文开销在本仓库不划算。
- **只用 CLI 的 `--help`、不装官方 skill**：少维护一份说明，但把命令发现成本转嫁给每次探查。

## Consequences

- 依赖全局可用的 `playwright-cli`；仓库保持纯油猴脚本仓库，不引入 `package.json`。
- 会话状态改由调用方负责：CLI 默认 profile 在内存中，需靠 `.playwright/cli.config.json` 指定 `userDataDir` 才会落盘，登录态据此跨会话复用。详见 `docs/login-flow.md`。
- 探查产物（快照、控制台日志）落在 `.playwright-cli/`，已在 `.gitignore` 中忽略。
