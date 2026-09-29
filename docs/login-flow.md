# 登录流程

目标站点的登录态持久化在本仓库里：**人工登录一次，之后 agent 的探查会话直接复用**，不再需要人工介入。

## 配置与落点

| 用途 | 位置 | 是否提交 |
|---|---|---|
| CLI 配置 | `.playwright/cli.config.json` | 是 |
| 浏览器 profile（真实登录凭据）| `.playwright/profile/` | **否**（已 gitignore）|
| 探查产物（快照、控制台日志）| `.playwright-cli/` | **否**（已 gitignore）|

`cli.config.json` 只做一件事：把 `browser.userDataDir` 指向 `.playwright/profile`。playwright-cli 默认把 profile 放在内存里、会话一关就丢，指定 `userDataDir` 才落盘——所以**不再需要**手写 `--persistent`。

> ⚠️ 配置里的路径是相对路径，按工作目录解析。**必须在仓库根目录执行所有 `playwright-cli` 命令**，否则会另开一个空 profile、表现为"没登录"。

## 首次登录（每个目标站点各做一次）

```bash
cd <repo root>
playwright-cli -s=xuexitong open --headed https://i.xuexitong.com/base
```

在弹出的窗口里**由人工**完成登录。agent 不参与登录、不索取凭据。

确认落地成功——返回的 `Page URL` 必须是个人空间，不是登录页：

```bash
playwright-cli -s=xuexitong snapshot --depth=3
playwright-cli -s=xuexitong close
```

## 日常复用

直接开（`--headed` 照旧显式带上，不依赖 CLI 默认值）：

```bash
playwright-cli -s=xuexitong open --headed 'https://i.xuexitong.com/base?ws=1'
```

判据：`Page URL` 若为 `https://passport2.xuexitong.com/login?...`，说明登录态已失效 → 回到「首次登录」重做一次。

登录态彻底损坏、需要从零开始时，删掉 profile 再重登：

```bash
playwright-cli -s=xuexitong delete-data     # 或直接删除 .playwright/profile/
```

## 学习通的固定事实

- 登录域名：`passport2.xuexitong.com`（登录页支持 手机号/超星号 + 密码、验证码、学习通 APP 扫码）
- 个人空间：`i.xuexitong.com/base`；**内容全部在一个 iframe 里**，`snapshot` 要给足 `--depth`，或直接 `snapshot <iframe 的 ref>`，否则什么都看不到
- 课程页：左侧菜单第 3 项「课程」→ iframe 内渲染课程卡片列表
- 课程条目链接：`https://mooc1.xuexitong.com/visit/stucoursemiddle?courseid=…&clazzid=…&cpi=…&ismooc2=1&v=2`
- 当前使用的单位/角色：**山西大同大学实验室安全管理系统**（`fid=185100`）

**内容跨了三个域名**（`i.` / `passport2.` / `mooc1.`），油猴脚本的 `@match` 必须按真正承载播放器的那一层域名写。

## 安全边界

- 用的是**独立 profile**，不碰日常浏览器的登录态：不要用 `attach --extension=chrome`，也不要用 `--cdp` 连你正在用的浏览器。
- `.playwright/profile/` 里是真实 cookie，只留在本机，永不提交。
