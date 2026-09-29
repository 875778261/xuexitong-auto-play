# 04 · 从章节树直接跳到下一个未完成节点（只向前）

Status: ready-for-agent

## 背景

推进一直是**点「下一节」**（`PCount.next`），一次只走一个节点。用户实测：**打开的是开头的节点、但前面一大段早已完成时**，脚本会一个节点一个节点地走完那一段——每个节点一次局部刷新，还会在每个**已完成**的节点里 `play()` 一次它的媒体（实测日志里一串 `playingTime=0` 的上报）。他要求：**只经过未完成的节点，检查未完成的节点里有没有可播的任务点**；以某课程为例，1.1–3.9 全已完成，从 1.1 打开就应该直接进 4.1。

设计经三轮 grilling 逐条确认，全部决定见 `spec.md` 的 Comments 第七轮与 `docs/adr/0010`；三条关键实现事实见 `docs/sites/xuexitong.md` § 章节树与跳节点。

## 范围

改 `src/xuexitong-auto-next.user.js` 与 `src/tests/decision.test.js`。**不改三层边界**：选目标、以及「允不允许跳过当前节点」的交叉校验全部是决策核心里的纯计算，适配层只负责点 `span.posCatalog_name`。`CONTEXT.md` 不动（「节点」早已定义；「跳转 / 推进」是动作语义，归 ADR）。

### 第 1 步 · 观察值与动作

- **观察值新增 `tree`**：`null`（树不可用）或 `{ nodes: [{ id, label, count, unfinished, current }] }`。
  - `id` = 章节树上的 chapterId（`#cur<id>` 去掉前缀）；
  - `label` = 短号（`span.posCatalog_sbar`，形如 `4.1`），供状态条拼文案；
  - `count` = `input.jobUnfinishCount` 的值（读不到就是 `null`）；
  - `unfinished` = `count !== null`；`current` = 带 `posCatalog_active`。
  - **树不可用** = 容器缺失、一个节节点都没有、或认不出 `posCatalog_active` → 一律 `tree: null`。
- **新动作 `ACTION.JUMP_NODE`**（带 `nodeId`）：语义 = 「点该节点的 `span.posCatalog_name`」。适配层 `perform` 里找到 `#cur<nodeId> span.posCatalog_name` 点它；找不到就什么都不做（由失败判据兜住）。
- `ACTION.ADVANCE` / `ACTION.CONFIRM_ADVANCE` **原样保留**，只在树不可用的回退路径上生效。

### 第 2 步 · 决策核心

- **新常量** `TREE_READY_GRACE_MS = 10000`；**新记忆** `jumpRequested`（目标 chapterId，同一目标只跳一次，与 `startRequestedKey` 同款；`JUMP_NODE` 一发出就记下）。
- **树不可用**：先按 `TREE_READY_GRACE_MS` 当「还没铺好」等（`PENDING.TREE_NOT_READY`，动手类，到期改用「下一节」推进）；窗口期过了仍不可用 → 走**现有**的推进/确认框逻辑，一行不改。
- **只向前选目标**（`tree` 可用时）：
  1. 本卡片/本节点还有可播的未完成任务点 → 就地播，不跳（现有逻辑）；
  2. 否则按卡片账本把本节点扫遍；扫遍之后：
     - **树说当前节点已无未完成计数** → 允许前进；
     - **树说还有未完成、且卡片账本 `sawUnfinished` 为真**（只剩脚本播不了的任务点）→ 允许前进（承 `0007`）；
     - **树说还有未完成、卡片账本却是「一个未完成任务点都没看到」** → **停下** `STOP_REASON.TREE_UNFINISHED_NOT_FOUND`；
     - **树认不出当前节点**（前面已经归入 `tree: null`）→ 回退路径。
  3. 前进 = 取**当前节点之后**第一个 `unfinished` 的节点当目标 → `JUMP_NODE`；后面没有这样的节点 → `STOP_REASON.COURSE_COMPLETED`。
- **跳转的失败判据不是「点了没反应」而是「当前节点有没有变成目标」**：`jumpRequested` 记下目标后，若 `UNREADY_TIMEOUT_MS` 内当前节点还没变成它，沿用 `STOP_REASON.MEDIA_NOT_FOUND`（文案并列这一档）。同一目标不重复点。
- **`ADVANCE_DELAY` 那一支不变**（播完固定等 15 秒），只是到期后走上面的选择逻辑。

### 第 3 步 · 等待与文案

| kind | 状态 | 文案 |
|---|---|---|
| `TREE_NOT_READY`（**新**） | 动手 | `N 秒后改用「下一节」推进` |
| `ADVANCE_DELAY`（改） | 动手 | 有目标：`N 秒后跳到 4.2`；没目标：`N 秒后继续推进` |
| `ADVANCE_COOLDOWN`（改） | 动手 | `N 秒后重试跳转` |
| `EMPTY_CARD` / `UNREADY` / 四条续播 / `STALLED` | 不动 | — |

- 时限一律由常量拼；`pending` 为 `ADVANCE_DELAY` 时多带一个 `label`。
- **停止原因**：新增 `treeUnfinishedNotFound`（`章节树说本节点还有未完成，脚本扫遍全部卡片却一个未完成任务点都没采到 —— 判定不可信，已停下`）；`courseCompleted` 改写为 `当前节点之后没有带未完成计数的节点了，脚本结束 —— 若还有内容，多半是章节树没渲染全、或只剩脚本播不了的任务点`；`mediaNotFound` 在现有文案后并列「或跳节点没生效」。**`mediaIncompleteConfirm` / `dialogWithoutUnfinished` 不删**（回退路径仍在用）。
- **状态条**：树可用时把 `本节点未完成 N（含 PPT）` 换成 `后面还有 M 个任务点未完成（含 PPT）`（M = 当前节点之后各节点 `count` 之和）；树不可用时保持现状。

### 第 4 步 · 用例

新增/改写（用例文件末尾的两个自检会逼齐）：

1. 树上有未完成节点、当前节点已完成 → `JUMP_NODE` 到后面第一个未完成节点；
2. 当前节点自己还有可播的未完成任务点 → 就地播，**不跳**；
3. 树说当前节点还有未完成、卡片账本却说一个都没看到 → 停下 `treeUnfinishedNotFound`；
4. 树说还有未完成、只剩脚本播不了的 → 允许跳过（`JUMP_NODE`）；
5. 当前节点之后没有 `unfinished` 的节点 → `courseCompleted`；
6. 树不可用、窗口期内 → 等 `TREE_NOT_READY`；窗口期过了 → 走回退路径（点下一节）；
7. 跳出去之后当前节点没变成目标满 30 秒 → `mediaNotFound`；
8. 同一目标不重复跳（`jumpRequested`）；
9. `ADVANCE_DELAY` 的两种文案（有目标 / 没目标）；
10. 树可用 / 不可用两种 `progressText`。

## 验收

```bash
node src/tests/decision.test.js        # 全绿 + 两个自检都过
```

真机（`playwright-cli -s=xuexitong`，**仓库根目录**执行）：装新版 → 打开那个「1.1–3.9 全已完成」的课程、从 1.1 进去 → 看它是否**只跳一次**就到 4.1、状态条文案对不对 → **到位立刻按「停止」**。消耗如实记在本文件末尾。

## 明确不做

- 不做「先向前、找不到再回头」（`0010` 的 Considered Options）。
- 不持久化「已排除节点」账本（承 spec 的幂等设计：不保存任何跨页状态）。
- 不删「下一节 + 确认框」那一套（留作树不可用时的回退）。
- 不改 `ADVANCE_DELAY`、续播阶梯、卡片层与 `findMedia` 的打分。
- 不引入构建工具链 / 包管理器 / 测试运行器。
