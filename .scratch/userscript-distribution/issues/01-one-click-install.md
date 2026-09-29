# 01 · 一键安装：补 `@downloadURL` / `@updateURL` 并发布

Status: ready-for-human

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
