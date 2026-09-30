# 01 · 一键安装：补 `@downloadURL` / `@updateURL` 并发布

Status: ready-for-human

> 2026-09-30：机制与元数据都已落地，**只剩「人来做发布」这一步**（push `develop` → 建 `main` → 设默认分支），见文末 Comments 与 [`../spec.md`](../spec.md) 的待办。

## 背景

脚本今天只能靠「把 `.user.js` 文件递给使用者」分发——`README.md` 的第二步就是照这个现实写的。仓库没有任何远端（`.git/config` 只有 `[core]`，无 `[remote]`），没有 `.github/`、没有 CI / Pages，脚本元数据块里也没有 `@downloadURL` / `@updateURL`。

从「打开 README」到「脚本开始跑」现在约 3 分钟，其中最难的一步是**拿到文件**：文件得由别人递过来。发布 + 一条安装链接能把它压到 10 秒（点链接 → Tampermonkey 自动弹安装页 → 点「安装」），这是唯一能真正兑现「使用者快速便捷」的杠杆。

本工单是 grilling 时明确「不做进 README」而单独立账的那件事——README 里放一条点不通的链接，比不放更伤信任。

## 范围

1. **决定发布渠道**：公开还是私有、GitHub 还是别处。私有仓库的 raw 链接需要 token，等于没有一键安装，所以这条实际等价于「公开」。
2. **补脚本元数据**：`@downloadURL`、`@updateURL`（都指向 raw 的 `.user.js`）。⚠️ `@version` 每次发版必须递增，否则 Tampermonkey 不认更新。
3. **README 第二步改写**：加一条「点开安装链接」的最短路径，把「拖文件 / 复制粘贴」降为备用。
4. **连带改动（补完之后这些说法就变假了，必须同步改）**：
   - `docs/usage/xuexitong-auto-next.md` 第 28 行「本脚本没配 `@updateURL`，不会自己更新」；
   - `README.md`「用它之前必须知道的三件事」第 3 条「脚本不会自己更新」。

## 验收

- 在**没装过脚本**的浏览器上，点 README 里的安装链接 → Tampermonkey 弹安装页 → 点「安装」→ 学习页右下角出现状态条；
- 改一版 `@version` 重新发布 → Tampermonkey 面板能拉到新版；
- README 与两份 usage 文档里不再出现「不会自己更新」这类已失效的说法。

## 明确不做

- 不做自动发布流水线（仓库没有构建工具链，也没有 `package.json`）。
- 不动脚本的行为代码 —— 本工单只碰元数据块与文档。

## Comments

### 2026-09-30 机制落地（走 `/grill-with-docs`，完整结论与验收见 [`../spec.md`](../spec.md)）

本工单第 1、2、4 条已落地，第 3 条（README 第二步改写）也已改写 —— 但**那条安装链接要等发布之后才点得通**：

- **渠道（第 1 条）**：定为 GitHub 公开仓库 `875778261/xuexitong-auto-play`，已关联为 `origin`。⚠️ 我这边匿名访问一直返回 404、它当时也不在该账号的公开仓库列表里，所以「确实公开」**降级成验收项**，没当作已证实的事实。
- **元数据（第 2 条）**：`@version` 从 `1.0.0` 改成 **`1.8.0`**（`1.<行为轮次>.<补丁>`，第八轮的行为口径），补上 `@updateURL` / `@downloadURL`（两个字段都指 `main` 分支的 raw `.user.js`），脚本内加 `SCRIPT_VERSION` 常量并把版本挂在 `window.__xuexitongAutoNext.VERSION` 上。
- **连带改动（第 4 条）**：`docs/usage/xuexitong-auto-next.md` 与 `README.md` 里「不会自己更新」的说法已改写；`docs/agents/userscript-install-via-playwright.md` 里那条「没有 `@updateURL`」也一并重写。
- 「⚠️ `@version` 每次发版必须递增」这句脚注，已升级成一条**有机制的纪律**：见 [`docs/adr/0012`](../../../docs/adr/0012-release-branch-and-version-scheme.md)（发布边界与编号）与 [`docs/adr/0013`](../../../docs/adr/0013-version-marker-instead-of-grant.md)（页面里怎么确认版本）。

**剩下的只有人要做的事**（顺序不能颠倒）：push `develop` → 建 `main` 并合入 → 把 `main` 设为默认分支。

**两条要先实证的东西**：① 匿名能不能抓到 `main` 的 raw（= 仓库确实公开）；② 使用者的网络能不能直连 `raw.githubusercontent.com`（不通就把两个 URL 改指 jsDelivr，代价是分支引用约 12 小时缓存）。此外还有一条与本工单相邻的口子：`@grant none` 下 `GM_info` 是否可读 —— 若可读，`ADR 0013` 的结论要重审。
