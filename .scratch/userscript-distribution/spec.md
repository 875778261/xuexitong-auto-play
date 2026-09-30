# Spec — 油猴脚本的交付：分发、版本号与更新机制

Status: ready-for-human（发布会话需要人；文档与代码部分已足够具体，可由 agent 落）

本 spec 管的是**交付机制**，不是脚本行为：脚本怎么送到使用者手上、使用者拿到的是哪一版、新版本怎么到他们手里。
脚本行为本身的口径见 [`.scratch/xuexitong-auto-next/spec.md`](../xuexitong-auto-next/spec.md)。

## Problem Statement

脚本此前只能靠「把 `.user.js` 文件递给使用者」分发：仓库没有远端、没有 CI、元数据块里没有 `@updateURL` / `@downloadURL`。于是：

- 从「打开 README」到「脚本开始跑」约 3 分钟，其中最难的一步是**拿到文件**——文件得由别人递过来；
- `@version` 从初始提交起一直是 `1.0.0`，从没随改动升过。第八轮排查「是不是装了旧版」时撞到了这个坑，最后只能靠**功能标记**分辨装的是哪一版；
- Tampermonkey 面板里的「更新」不会生效，使用者想升级只能重走一遍安装流程、点「重新安装」。

第一条与第三条已经记账在 [`issues/01-one-click-install.md`](./issues/01-one-click-install.md)；第二条是那一轮留下的脚注（「⚠️ `@version` 每次发版必须递增」），它没有被定义成任何机制。

## Solution

发布源固定在 GitHub 公开仓库 `875778261/xuexitong-auto-play`，`@updateURL` / `@downloadURL` 都指向 `main` 分支的 raw `.user.js`：

- **推送 ≠ 发布**：日常在 `develop` 上开发，**合入 `main` 才是发布**（见 [ADR 0012](../../docs/adr/0012-release-branch-and-version-scheme.md)）；
- **`@version = 1.<行为轮次>.<补丁>`**，首次发布写 `1.8.0`（对应第八轮的行为口径）；
- 脚本文件有实质改动的那笔提交**自己带版本号**，纯文档 / 测试改动不动号；
- 页面里能直接读出装的是哪一版：`window.__xuexitongAutoNext.VERSION`（见 [ADR 0013](../../docs/adr/0013-version-marker-instead-of-grant.md)）；功能标记保留，但**降级为能力判据**（回答「至少是第几轮」，不再回答「是不是最新」）；
- 「元数据 `@version` 与脚本内 `VERSION` 一致」由 `src/tests/version.test.js` 断言。

## User Stories

1. 作为使用者，我想在 README 里点一条链接就把脚本装好，不用等别人把文件发给我。
2. 作为使用者，我想让脚本自己更新到新版本，不用重装、不用被通知「你去换一份文件」。
3. 作为使用者，我想在页面控制台一条命令读出当前版本号，这样我能确知自己手上是哪一版。
4. 作为使用者，我想让文档里「脚本不会自己更新」这类说法消失，这样我不会照着作废的步骤做。
5. 作为维护者，我想在真机验证之前就知道「推送」不会自动发给使用者，这样未验证的改动不会传染。
6. 作为维护者，我想让「改了脚本却忘了递增版本号」这种**静默事故**至少有一条会红的检查。
7. 作为维护者，我想让「我装的到底是哪一版」在页面里能一句话问出来，而不是凭功能标记反推。

## Implementation Decisions

1. **发布边界**：新建 `main` 作发布分支；`@updateURL` / `@downloadURL` 都指 `main` 的 raw `.user.js`；日常留在 `develop`。理由与代价见 `ADR 0012`。
2. **编号方案**：`1.<行为轮次>.<补丁>`，首次发布 = `1.8.0`。MINOR = 一次行为口径变更，PATCH = 脚本改了但行为没变，MAJOR 留给「翻转既有行为边界」那一类（如 `0009` 反转 `0002`）。全纯数字点分 —— Tampermonkey 只可靠地比较这种格式。
3. **递增时机**：脚本文件有实质改动的那笔提交**自己带号**（在 `develop` 上）；merge 到 `main` 不再动号；纯文档 / README / 测试改动不 +1。
4. **非行为轮不占号**：轮次计数只数**行为口径变更**。本 spec 这类交付机制轮**不**计入，所以本轮落地时 `@version` 仍是 `1.8.0`，不是 `1.9.0`。
5. **运行时判据**：脚本内加一条与元数据块手工同步的 `SCRIPT_VERSION` 常量（挂到句柄上就是 `window.__xuexitongAutoNext.VERSION`）；**不动 `@grant none`**，见 `ADR 0013`。
6. **功能标记的新定位**：从「唯一的版本判据」降为**能力判据**（「至少第八轮」「有没有某个能力」）。它的词条进 `CONTEXT.md`，见决策 7。
7. **沉淀**：`docs/adr/0012`、`docs/adr/0013`；`CONTEXT.md` 增收**功能标记**一条（把「版本号 / 版本标记」列进 `_Avoid_`），「版本」「发布」两个通用词不进词表。

## 验收

**发布侧（需要人手动做，见「待办」）**

- [ ] 匿名（不登录）能抓到 `main` 分支的 raw `.user.js` —— 这条同时是「仓库确实公开」的闭环证据（本轮只验到 SSH 可达 + 匿名 404，未能确认公开）。
- [ ] 使用者的网络能直连 `raw.githubusercontent.com`。不通则 `@updateURL` 改指 jsDelivr 镜像（代价：分支引用约有 12 小时缓存，「发布后立刻生效」做不到）。
- [ ] 改一版 `@version` 重新发布 → Tampermonkey 面板「检查脚本更新」能拉到新版。
- [ ] 在**没装过脚本**的浏览器上，点 README 的安装链接 → 弹安装页 → 点安装 → 学习页右下角出现状态条。

**脚本侧（装进油猴后实测）**

- [ ] 控制台 `window.__xuexitongAutoNext.VERSION` 返回 `"1.8.0"`。
- [ ] `node src/tests/version.test.js` 绿；`node src/tests/decision.test.js` 94 条绿、两个自检都过。
- [ ] 真机验证时页面里跑的确实是工作区里这一份（`VERSION` 与元数据一致）。

**文档侧**

- [ ] `README.md`、`docs/usage/xuexitong-auto-next.md`、`docs/agents/userscript-install-via-playwright.md` 里不再出现「脚本不会自己更新」「本脚本没有 `@updateURL`」这类已失效的说法。

## 明确不做

- 不引入 CI、构建链、`package.json`；不做「自动递增版本号」的流水线（仓库的零依赖前提不动）。
- 不引入 GitHub Release / tag 作为更新源 —— 固定 ref 永远不会自动更新。
- 不改脚本的**行为**代码：本轮只碰元数据块、一条常量、一个新检查文件与文档。
- 不动 `@grant none`（理由见 `ADR 0013`）。

## 待办

1. ~~先提交第八轮~~ —— 已提交两笔（`docs` 先行、`feat` 随后）。本轮要改的 `src/xuexitong-auto-next.user.js`、`CONTEXT.md`、`README.md`、`docs/usage/xuexitong-auto-next.md` 与第八轮的改动**完全重叠**，所以这个顺序不能颠倒。
2. ~~落本轮~~ —— 已落：`ADR 0012` / `ADR 0013`、`CONTEXT.md` 一条术语、元数据两个 URL、`SCRIPT_VERSION` 常量、`src/tests/version.test.js`、三处文档改写、`issues/01` 收口。
3. ~~提交本轮~~ —— 已按同样的拆法提交（`docs` 先行、`feat` 随后）。
4. **只剩人要做的一步**：`git push -u origin develop` → 建 `main` 并合入 → 把 `main` 设为默认分支。**发布之前 README 里那条安装链接点不通**（正是 `issues/01` 否掉过的「点不通的链接」），所以这一步要尽快跟上。
5. 发布后照上面「验收」逐条真机确认，尤其是那两条要先实证的（匿名可达 raw / 使用者的网络直连 raw）。

## Comments

### 2026-09-30 交付与版本机制（`/grill-with-docs`：八问八答，每题带推荐答案，用户逐条「使用推荐」）

起因是第八轮收尾时留下的那条悬而未决：`@version` 从没升过、也没有 `@updateURL`，「使用者拿到的是哪一版」没有出口。会话进行到一半，用户创建了远端仓库 `git@github.com:875778261/xuexitong-auto-play.git` 并关联为 `origin`，渠道这一支随之落定。

**只读核到的事实**：

1. 仓库**没有远端**（会话中途才有）；本地只有一个分支 `develop`；远端初始完全空（`git ls-remote` 无任何 ref），所以**第一个推上去的分支会成为默认分支**。
2. 远端仓库经 SSH 可达、但匿名访问是 404、且不在该账号的公开仓库列表里 → 当时判定为**私有**；用户随后改为 public，但**我这边复验仍是 404**（可能是我侧缓存）。因此「公开可见」降级为验收项，不作为已证实事实。
3. `@version` 在 `==UserScript==` 注释里，脚本是 `@grant none` —— **页面里读不到版本号**，这是第八轮只能靠功能标记的根因。
4. 使用手册第 25 行、`docs/agents/userscript-install-via-playwright.md` 第 41 行都写着「Tampermonkey 面板里的『更新』**只**对 `@updateURL` 生效」。我查到的行为是**一条回退链**（`@updateURL` → `@downloadURL` → 安装来源 URL），即「从 URL 安装的脚本，没配这两个字段也可能自动更新」。⚠️ **这条未实证**（官方文档正文是 JS 渲染的，只取到了目录），改写文档时必须先真机验一次，不能照抄本文的说法。

**用户确认的决定（八问，每题「使用推荐」）**：

1. **Q1 发布边界 = A**：新建 `main` 作发布分支，`@updateURL` / `@downloadURL` 指向 `main` 的 raw；日常在 `develop`；**merge 到 `main` 就是发布**。
2. **Q2 编号方案 = A**：`1.<行为轮次>.<补丁>`，首次发布 `1.8.0`；MINOR = 一次行为口径变更，PATCH = 不改行为的脚本改动，MAJOR = 翻转既有行为边界。硬约束：首次发布必须**严格大于 `1.0.0`**（面板里装着的就是它，同号 Tampermonkey 不认更新且失败是静默的）。
3. **Q3 递增时机 = A**：脚本文件有实质改动的那笔提交自己带号；纯文档 / 测试不 +1；merge 不带号。
4. **Q4 运行时判据 = A**：脚本内加手工同步的 `VERSION` 常量 + 功能标记降级为能力判据；**不引入 grant**。
5. **Q5 更新源 = A**：两个 URL 都指同一个 raw `.user.js`（零新增文件、零新漂移点）；`raw.githubusercontent.com` 的国内可达性写成验收项，不通则落到 jsDelivr。
6. **Q6 机械检查 = A**：新落零依赖的 `src/tests/version.test.js`，断言元数据 `@version` 与脚本内 `VERSION` 一致。
7. **Q7 沉淀 = A**：两条 ADR（`0012` 发布边界与编号、`0013` 版本判据）；`CONTEXT.md` 只增收「功能标记」一条。
8. **Q8 范围 = A**：文档 + 代码一起落，按仓库惯例拆两笔提交（`docs` 先行、`feat` 随后）。

**被否掉的方案（细节在各个 ADR 的 Considered Options）**：用 `develop` 当更新源（push 即发布）；用 tag 当更新源；编号从 `1.0.0` 重开或改用 `2.0.0`；日期式版本号；只在 merge 时改号；另出 `.meta.js`；读 `GM_info` 走单一事实源；不落机械检查只写发布清单。

**实现时必须先实测的一处口子**：`@grant none` 下 `GM_info` 是否仍可读。若可读，则决策 4 的 `C`（读 `GM_info`，真正单一事实源、零漂移）代价会塌到接近零，`ADR 0013` 的结论要重审 —— 一句 `typeof GM_info` 即可定案，结果记进本文件与 `issues/01` 的 Comments。
