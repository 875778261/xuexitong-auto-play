# PPT 无法由脚本完成，因此本节点只剩 PPT 未完成时代为确认推进

PPT 任务点确实有自己的完成判定——**把内容拉到最底端**，触发一次 `job/document`（见 `0004`）。但**那个内容层脚本够不到**：PPT 由 `/ananas/modules/pdf/index.html` 渲染，其内容框架 `iframe#panView` 指向 `mooc1.xuexitong.com/mooc-ans/screen/file?objectid=…`，**302 跳到 `pan-yz.chaoxing.com/screen/v2/file_…`**——另一个域。父页面里的脚本读不到它的 DOM（`contentDocument` 为 `null`、读 `location.href` 抛 `SecurityError`）、`fetch` 也被拒，无法驱动它的滚动；平台恰恰把滚动处理挂在那个框架的 `onload="bindScroll()"` 上。「滚到底」这件事**只能由人来做**。

因此我们决定：**PPT 任务点不由脚本完成**。当本节点内**只剩 PPT 未完成**时，脚本点「下一节」，并在平台弹出「还有任务点未完成」确认框时**代为确认**。除此之外的确认框一律停下提示（`0002` 不变）。

> ⚠️ 这个例外的范围已被 [`0007`](./0007-unplayable-task-points-are-skipped-too.md) 从「只剩 PPT」**扩成「只剩脚本播不了的任务点」**（PPT ＋ 认不出类型的模块）。规则的形状与理由都没变，仍是「脚本在技术上做不到」。

这条规则与 `0003` **相同**，但理由完全不同：`0003` 说「PPT 不计入需完成范围」，那是**错的**——平台把 PPT 计入 `jobUnfinishCount`，也有自己的完成判定。正确的理由是「脚本在技术上够不到它」。

## Considered Options

- **维持 `0004`，让脚本驱动滚动**：放弃它，因为要滚的容器在跨域框架内。唯一能碰到的办法是让脚本也注入 `pan-yz.chaoxing.com`——那是现有三层边界之外的新一层（父子帧只能用 `postMessage` 协调），且从未验证过。为一个未验证的手段去改脚本头的 `@match` / `@noframes`，不划算。
- **遇到 PPT 就停下提示、让人来滚**：边界最干净。放弃它，是因为那会让「自动跑完整门课」在每个含 PPT 的节点断一次，而这个断点挡住的是一件**脚本本来就做不到**的事——停下也没有更好的出路。

## Consequences

- **如实接受这个代价**：PPT 没做完，节点在平台上就一直显示「未完成」（`jobUnfinishCount` 不为 0）。脚本保证的是**推进**，不是整门课 100% 完成。
- 「只剩 PPT 未完成」**必须遍历本节点的全部卡片**才能判定：`jobUnfinishCount` 把 PPT 也算进去，不能拿它当判据。卡片标签不代表内容类型，任务点是不是 PPT 只能看它自己的模块 `src`（`/ananas/modules/pdf/`）。
- **`CONFIRM_ADVANCE` 从「兜底探测」回到主路径**——它就是这条规则的执行端。而 `mediaIncompleteConfirm`（媒体未完成时弹出的确认框）仍是「脚本判断出错」的信号，停下。
- 认不出的模块类型（既不是 `video` / `audio` / `pdf`）**停下提示**，不猜。⚠️ 这一条已被 [`0006`](./0006-task-point-is-identified-by-jobid.md) **收窄**：任务点先按 `jobid` 认，读不到 `jobid` 的容器（资料附件）根本不算任务点，不再走「认不出的类型」这条路。
- 任务点类型一律按模块 `src` 判，**与卡片标签无关**：标签写着「语法」的卡片里如果装的是 PDF 模块，就按 PPT 处理（跳过）；装的是别的模块，就停下（同样按 `0006` 收窄到「带 `jobid` 的真任务点」）。
