# 02 · 浏览器侧验收：首装、拉到新版、两个搭车实测

Status: ready-for-human

> 2026-09-30：从 [`01`](./01-one-click-install.md) 收口时析出。这几条都只能在真机浏览器里做，其中一条还要等下一次带号发布才有条件。

## 背景

`01` 的机制、元数据、文档与首次发布都已落地，但它的验收里有两条**纯文件检查验不到**：

1. **首装**：在没装过脚本的浏览器上点 `README` 的安装链接 → 弹安装页 → 装完学习页右下角出现状态条；
2. **拉到新版**：改一版 `@version` 重新发布 → 篡改猴面板「检查脚本更新」能拉到新版。

另有两条**搭车**实测（都不依赖版本号，可以在第 1 条那次会话里一起问掉）：

3. `@grant none` 下 `typeof GM_info` 是否可读 —— 若可读，[`docs/adr/0013`](../../../docs/adr/0013-version-marker-instead-of-grant.md) 的结论要重审（那时「读 `GM_info`」就是零漂移的单一事实源）；
4. [`docs/agents/userscript-install-via-playwright.md`](../../../docs/agents/userscript-install-via-playwright.md) 里标着待实证的那条：篡改猴面板的「更新」是不是**只**对 `@updateURL` 生效（检索到的实际行为是一条回退链 `@updateURL` → `@downloadURL` → 安装来源 URL）。

## 怎么做

- **首装（第 1 条）**：用**探查 profile**，先删掉里面那份脚本 —— 它装的是 `1.0.0`，且元数据里**没有 `@updateURL`**，本来也验不了更新链 —— 再用 `README` 的安装链接从零装一遍，顺路把 `1.0.0` 换掉。
  ⚠️ **不新建一个干净 profile**：那要重新登录学习通，而多端登录会被平台判异常学习、把先开的会话踢掉；这条验收要证的是「链接能弹安装页、装完状态条出现」，两者在这件事上没有差别。
- **拉到新版（第 2 条）**：**等下一次真实发布**时顺带验，不为它人为造一次发布 —— 造发布 = 面向全班发一次版本变更，正是 [ADR 0012](../../../docs/adr/0012-release-branch-and-version-scheme.md) 否掉「用 `develop` 当更新源」时算过的那笔账。
- **第 3、4 条**跟着第 1 条那次会话一起问。

## 硬边界

探查纪律照 [`docs/agents/userscript-install-via-playwright.md`](../../../docs/agents/userscript-install-via-playwright.md)：`playwright-cli` 在仓库根执行、每一处 `open` 显式 `--headed`、同时只留一个章节标签页、单设备、不 `attach` 日常浏览器、学习页 URL 不外泄。

## 验收

- [ ] 探查 profile 删掉脚本后，点 `README` 的安装链接 → 弹安装页 → 学习页右下角出现状态条，且 `window.__xuexitongAutoNext.VERSION` 返回 `"1.8.0"`；
- [ ] 下一次带号发布后，篡改猴面板「检查脚本更新」能拉到新版；
- [ ] 第 3、4 条各有结论，并记进 [`../spec.md`](../spec.md) 与本文件的 Comments。
