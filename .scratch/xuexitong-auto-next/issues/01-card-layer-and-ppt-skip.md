# 01 · 按「节点 → 卡片 → 任务点」重做适配层，并按 ADR 0005 跳过 PPT

Status: ready-for-agent

## 背景

script 现有的「节点 → 任务点」模型在真实页面上不成立：节点下还有一层**卡片**（`ul.prev_ul > li#dctN`，带 `title` 标签与 `cardid`），**同一时刻只有 `active` 那张卡片的内容被渲染出来**，而章节树的 `input.jobUnfinishCount` 是**整节点跨全部卡片**的未完成数。这才是脚本「本卡片播完就去点下一节、于是撞上确认框」的根因。

同时 PPT 的结论已定案（`docs/adr/0005`）：PPT 的内容层跨域（`pan-yz.chaoxing.com`），脚本够不到，因此**不由脚本完成**；本节点内只剩 PPT 未完成时，脚本点「下一节」并代为确认确认框。

术语与层级见 `CONTEXT.md`；站点事实见 `docs/sites/xuexitong.md`；spec 的「循环单位」「推进方式」两节已按新模型改过。

## 范围

修改 `src/xuexitong-auto-next.user.js` 与 `src/tests/decision.test.js`。**不碰 PPT 的播放/滚动**（ADR 0005），不引入构建工具链，不改测试缝的位置。

### 第 1 步 · 两处与模型无关的缺陷（先做，改完 37 条用例应当全绿）

1. **`findMedia()` 会选中空的试听音频。** 每个卡片文档里都有 `<audio id="auditionAudio" src="" style="display:none">`，它在文档顺序上排在深层 `<video>` / 播放器 `<audio>` 之前，而打分同为 0 时严格 `<` 会保留第一个——实测确实选中了它。修法：把「没有可用源（`currentSrc` 与 `src` 都为空）且 `duration` 不可用」的候选排到最后（仍要能选中还没起播的真媒体）。
2. **`searchableAttrs()` 不读 `aria-label`。** 「任务点未完成」只写在 `div.ans-job-icon` 的 `aria-label` 上，不读它就一个任务点都扫不到。加上 `aria-label`（可放在 `title` 之后）。

### 第 2 步 · 引入卡片层

在 `ADAPTER_FACTS` 里补上卡片切换器的选择器与活动态类名，然后：

- **任务点扫描改按容器读**：`.ans-attach-ct` 才是任务点容器。完成态 = 容器带 `ans-job-finished`；**不要**再用文本或 `aria-label` 判完成（已完成的任务点没有「已完成」文案，icon 也可能整个不存在）。`ans-job-icon` 只当「这是个任务点」的识别位。
- **任务点类型只看模块 `src`**：容器内 `iframe[src*="/ananas/modules/"]` 的模块名 → `video` / `audio` / `pdf`。**不看卡片标签**（标签不约束内容），也不要再按 `ans-job-icon` 的类名猜（音频与 PPT 的类名是空的）。
- **卡片级判据**：一张卡片「跑完了」= 卡内所有 `.ans-attach-ct` 都带 `ans-job-finished`。
- 遍历卡片的顺序：从第 1 张卡片起。卡片切换靠点 `li#dctN`（`onclick` 是 `changeDisplayContent(...)`）。切换后文档会被重渲染，**所有缓存的元素引用都要失效重取**（现有的 `memo` 已经会因为 `isConnected === false` 重查，确认它覆盖到这个场景）。

### 第 3 步 · 决策核心

- **动作集不新增动作**：把 `openTaskPoint` 的语义从「点开第一个未完成任务点」扩成「**定位到第一个未完成的可播单元**：本卡片内找不到就切到下一张卡片」。
- **`confirmAdvance` 回到主路径**（ADR 0005）：当**本节点所有卡片的未完成任务点都是 PPT 类**时，发出 `confirmAdvance`。判据必须遍历全部卡片——`jobUnfinishCount` 含 PPT，不能拿它当判据。
- **新增一条停止原因**：任务点类型既不是 video / audio / pdf → 停下提示（ADR 0005 的 Consequences）。
- `mediaIncompleteConfirm` 保留，但语义收窄为「脚本以为本节点已无未完成的媒体任务点，平台不同意 —— 判断不可信」，与 `dialogWithoutUnfinished` 同性质。
- **`completePpt` 不做**（`0004` 已废）。
- **状态条**：改为报**当前卡片**的进度「x/y」，另加平台的节点计数「本节点未完成 N（含 PPT）」。字面上不要写成「还剩 N 个要做」——PPT 会被脚本跳过，N 永远不会归零。

### 第 4 步 · 用例

按 `Testing Decisions` 的规矩：**每条停止原因一条用例**（新增那条必须有），另外补正常路径——卡片内推进、切卡片、只剩 PPT 时 `confirmAdvance`、本节点还有可播任务点时不点「下一节」。

## 验收

分两半：决策核心靠测试缝，适配层靠真实页面。

### 决策核心（第 3、4 步）

```bash
node src/tests/decision.test.js        # 全绿，且新增的停止原因有用例
node src/tests/decision.test.js 卡片     # 新用例可单独筛出来
```

用例文件末尾那条「每条停止原因都必须有用例」的自检必须通过。

### 适配层（第 1、2 步）

这两步**没有单元测试可跑**：测试缝是纯函数，`node:vm` 里没有 DOM；调试句柄也刻意只暴露决策核心。按 `AGENTS.md` 的立场，靠 `playwright-cli` 对真实页面做端到端确认。

一次性准备：在 `.playwright/profile` 里装 **Tampermonkey**，并把 `src/xuexitong-auto-next.user.js` 加为脚本（注意脚本头有 `@noframes`）。装一次即可，后续改动只需刷新页面。

确认清单（**必须在本仓库根目录**执行，否则 `playwright-cli` 会另开空 profile）：

```bash
playwright-cli -s=xuexitong eval "location.href"   # 先确认停在目标学习页
```

- 状态条报出「本节 x/y」，其中 **y > 0** —— 若一直是 `0/0` 或「任务点：尚未采到」，就是 `searchableAttrs()` 没读到 `aria-label`
- **不出现 `MEDIA_NOT_FOUND` / `PLAYBACK_REFUSED`** —— 这两条正是 `findMedia()` 选中空 `<audio id="auditionAudio">` 的症状
- **视频卡与音频卡各确认一次**（模块 `src` 不同，`classify` 的两条路都要走到）；音频卡可用 3.5 Unit 5 的 `dct3`（11 个 `.mp3` 任务点）
- 切卡片后元素引用会失效——确认缓存能自己重查（状态条不卡在上一张卡片的数据上）

⚠️ 这一步会**真的起播、真的上报**。别在别人的课程上做；`playingTime` 低于判定线时不会把任务点标成完成，但观看记录是真实的。

## 明确不做

- 不做 PPT 的滚动 / 播放，也不给脚本加 `pan-yz.chaoxing.com` 的 `@match`（ADR 0005 的 Considered Options 里记了为什么不划算）。
- 不动 `decide()` 之外的纯函数形状，不改三层边界。
- 不引入 `package.json`、打包器或任何测试运行器。
