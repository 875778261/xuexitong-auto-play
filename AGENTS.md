# AGENTS.md

## 项目简介

本仓库用于编写**针对特定网站的油猴脚本（Tampermonkey userscripts）**：一个脚本服务一个具体站点，解决一类具体操作。典型用途：

- **自动播放下一节** —— 课程、视频类站点上的自动跳转与续播
- **规避站点的特殊限制** —— 例如播放限制、交互阻断

交付形态是单文件 `.user.js`，统一放在 `src/` 下，头部带 `==UserScript==` 元数据块（`@match`、`@grant`、`@run-at` 等）。仓库没有构建工具链、没有 `package.json`，脚本由浏览器扩展直接加载运行。

## 脚本结构与测试缝

每个脚本都分三层：**决策核心（纯函数）→ 站点适配层（DOM 读写）→ 驱动循环（副作用）**。决策核心把「下一步做什么」写成 `decide(观察值, 记忆) → 动作`，用脚本末尾的调试句柄（`globalThis.__<脚本名>`）暴露出来。这个纯函数是**唯一**的测试缝，用例在 `src/tests/`：

```bash
node src/tests/decision.test.js        # 跑全部用例
node src/tests/decision.test.js 暂停    # 只跑名字里含「暂停」的
```

- **零依赖**：脚本文件本身是合法 JS（元数据块全是 `//` 注释），用例直接把它丢进 `node:vm` 加载、取调试句柄，然后喂观察值、断言动作。**不**引入测试运行器、打包器或 `package.json`。
- **只测外部行为**：不碰 DOM、不等真实时间（「当前时刻」是入参）。每一条**停止原因**都必须有用例——用例文件末尾会检查这件事，漏一条就红。
- **适配层不硬凑测试**：选择器、iframe 遍历、真实时序无法脱离页面验证，靠 `playwright-cli` 对真实页面做少量端到端确认。

## 站点探查

写或改脚本之前，先用 `playwright-cli` 对目标站点开一个探查会话，看清它真实的 DOM 与运行时行为：

```bash
playwright-cli -s=<session> open <目标站点>   # 默认 headless；登录态由配置持久化
playwright-cli -s=<session> snapshot          # 可访问性树；用其中的 ref 定位元素
playwright-cli -s=<session> find "登录"        # 在快照里按文本/正则搜索
playwright-cli -s=<session> eval "document.title"
playwright-cli -s=<session> console            # 页面控制台
playwright-cli -s=<session> requests           # 网络请求
playwright-cli -s=<session> close
```

- **每次探查都带会话名**（`-s=<session>`），不要用匿名会话；开始前先 `playwright-cli list` 看有没有冲突的会话。
- **命令必须在仓库根目录执行**：`.playwright/cli.config.json` 用相对路径把 profile 指向 `.playwright/profile/`，换目录执行会另开一个空 profile、表现为"没登录"。
- 登录态已持久化，`open` 即复用，**不需要**再传 `--persistent`；只有需要人工接管时才加 `--headed`。首次登录与失效处理见 `docs/login-flow.md`。
- 不要用 `attach --extension=chrome`——那会连上日常浏览器的真实登录会话。
- 探查产物（快照、控制台日志）落在 `.playwright-cli/`，已在 `.gitignore` 中忽略，不要提交。
- `snapshot --filename=<f>` 是例外：它把文件写到**当前工作目录**，在仓库根执行会直接污染仓库——用完记得移进 `.playwright-cli/`，或干脆用默认的时间戳文件名。

为什么是 CLI 而不是 playwright-mcp：见 `docs/adr/0001-playwright-cli-over-mcp.md`。

已探查过的目标站点事实（域名分工、iframe 层级、上报接口、使用约束）记在 `docs/sites/` 下，写脚本前先读。

## Agent skills

### Issue tracker

Issues and specs live as markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles, label strings equal to the role names. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
