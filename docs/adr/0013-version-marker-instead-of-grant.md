# 版本判据：不引入 grant，改挂一条手工同步的 `VERSION` 常量

`@version` 住在 `==UserScript==` 注释块里，而脚本是 `@grant none` —— **页面里读不到它**。于是「使用者手上是哪一版」在浏览器侧没有通路，第八轮排查「是不是装了旧版」时只能靠**功能标记**（`CONSTANTS.TREE_RECHECK_GRACE_MS` 在不在）反推。功能标记有个天生上限：它只能回答「**至少**是第几轮」，回答不了「是不是最新」；而且一旦某一轮的行为变更没留下新的常量或枚举，就没有标记可用（第九轮若只是改默认值，就是这种情形）。

因此：

- 脚本内加一条**与元数据块手工同步**的 `SCRIPT_VERSION` 常量，挂在既有调试句柄上：`window.__xuexitongAutoNext.VERSION`。使用手册里的核对命令从「查功能标记」改成「读版本号」。
- **功能标记保留，但降级为能力判据** —— 它回答的是「有没有这个能力」，不再回答「是不是最新」。
- 两处手工同步是这次唯一新增的漂移点，由零依赖的 `src/tests/version.test.js` 断言（元数据 `@version` 与脚本内 `VERSION` 必须一致）。

## Considered Options

- **读 `GM_info.script.version`（真正的单一事实源）**：这一轮放弃。它要动 `@grant none` —— 本脚本跑在页面上下文里，直接读写跨 iframe 的 DOM 与媒体元素（`video.play()`、`currentTime`、章节树上的节点）。引入 grant 会给脚本套一层沙箱，**有可能**改变这些对象访问的行为，属于「要动就得把整条链路真机复验一遍」的改动。用一个「SSOT」换这个风险，不值。
- **继续只用功能标记**：放弃。见上，它结构上答不了「是不是最新」，而「是不是最新」正是本轮要解决的问题；`docs/usage` 里那句「别指望版本号」的告诫会一直有效。
- **让使用手册不再提版本、只说「重装一次就好」**：放弃。这是把问题藏起来 —— 使用者与维护者都会遇到「我这版有没有这个修复」，而真机验证时也需要一个能对上号的标识。

## Consequences

- **`SCRIPT_VERSION` 必须是纯手工同步**：仓库没有构建链（连 `package.json` 都没有），没有东西能自动生成它。
- ⚠️ **一处必须先实测的口子**：`@grant none` 下 `GM_info` 是否**仍可读**（Tampermonkey 有可能不按 grant 注入它）。若可读，则上面第一条被否方案（读 `GM_info`）的代价会**塌到接近零**，本 ADR 的结论就要重审 —— 一句 `typeof GM_info` 即可定案，结果记进 [`.scratch/userscript-distribution/spec.md`](../../.scratch/userscript-distribution/spec.md) 与 [`issues/01`](../../.scratch/userscript-distribution/issues/01-one-click-install.md) 的 Comments。
- **文档要改三处**：`docs/usage/xuexitong-auto-next.md` 的「装好了怎么确认版本」与「更新脚本」两节、`docs/agents/userscript-install-via-playwright.md` 里那条确认安装的 `eval`、以及 `CONTEXT.md` 里「功能标记」这个词条。
- **`SCRIPT_VERSION` 不进 `CONSTANTS`**：`CONSTANTS` 是「唯一调参处」，版本号不是可调参数 —— 它只作为调试句柄上的独立字段 `VERSION` 暴露。
