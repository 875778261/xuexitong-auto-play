# 学习通（xuexitong.com）

本仓库的**目标站点**之一。这里只记录**反直觉、且下次写脚本必然要用到**的事实。站点结构会变，凡是能现查的（章节树、任务点数量、课程列表）都不写进来——它们只会变成过期的雷。

## 域名分工

| 域名 | 作用 |
|---|---|
| `passport2.xuexitong.com` | 登录 |
| `i.xuexitong.com` | 个人空间，内容全在一个 iframe 里 |
| `mooc2-ans.xuexitong.com` | 课程页（章节树）|
| `mooc1.xuexitong.com` | **学习页面与播放器**——油猴脚本主要打这一层 |
| `mobilelearn.` / `stat2-ans.` / `robot-lc.` / `noteyd.` | 活动、统计、数字人、笔记等辅助接口 |

- **找目录（章节树）的必经路径**：课程页 `mooc2-ans/mycourse/stu?courseid=…&clazzid=…&cpi=…` 打开后默认落在**「任务」**页，**章节树要点一下「章节」标签才会渲染**；而且它在一个**跨域 iframe** 里，主文档的 `contentDocument` 读不到——得用 Playwright 的 `page.frames()` 逐帧读。节点名与「未完成数」都在那一帧里。
- ⚠️ **更正上一轮的一条结论**：`playwright-cli` 的 `find`/`snapshot` **能**读到那个跨域帧里的章节树（可访问性树会穿过去），而**点节点用快照里的 ref（形如 `f124e93`）是可行的**——2026-09-28 实测点它直接跳到该节点的学习页。上一轮记的「getByRole / getByText 够不到那个帧」只对那两种定位方式成立，别据此认为 CLI 碰不到这棵树。
- 学习页上也有同一棵树（侧边栏 `.posCatalog_active` 就是当前节点），**不用回课程页也能切节点**。

## 学习页面的层级

`mooc1.xuexitong.com/mycourse/studentstudy?chapterId=…`

```
主页面                                  ← 「下一节」「上一节」在这一层
├─ 卡片切换器  ul.prev_ul > li#dct1..N  ← 节点内的内容分组，只有 active 那张会被渲染
│     onclick="changeDisplayContent(<序号>,4,<chapterId>,<courseId>,<clazzid>,'')"
└─ iframe                              ← 当前卡片的正文
   └─ iframe（每个任务点一个）
      └─ iframe  mooc1.xuexitong.com/ananas/modules/video/index.html
         └─ <video>                      ← 与主页面同源，可直接取用
```

- **一个节点（chapter）下有多张「卡片」**（`li#dctN`，带 `title` 标签与 `cardid`），**同一时刻只有 `active` 那张的内容被渲染进 `iframe`**——另外几张在 DOM 里根本不存在。所以「在页面上扫任务点」永远只能扫到**当前卡片**的任务点，而章节树给的「N 个待完成任务点」是**整节点**的数。
- **卡片标签（视频 / PPT / 音频 / 语法 …）只是标签，不约束组内内容**——任何一张卡片里都可能同时有视频、音频与 PPT，**不要按标签决定怎么处理**。实测：标签写着「语法」的卡片，装的是视频。
- 卡片切换器在**主文档**里：`ul.prev_ul > li#dctN`（带 `title` 标签、`cardid`），**活动那张带 `active` 类**，其余几张带 `c<序号>` 类——判断「当前是哪张卡片」只认 `active`。切换靠点 `li` 自己（`onclick="changeDisplayContent(<序号>,…)"`）。
- 切卡片只重渲染 `iframe`，**不会**触发「还有任务点未完成」确认框。但重渲染会让**所有缓存的元素引用失效**，脚本必须重查。
- 播放器 iframe 与主页面**同源**（都在 `mooc1.xuexitong.com`），不必跨域通信。
- 但**任务点内容全在 iframe 里**，只读主页面 DOM 会一无所获。
- ⚠️ 当前卡片文档里固定有一个 `<audio id="auditionAudio" src="" style="display:none">`（AI 试听），**它不是任务点**——按「页面上第一个 `<audio>`」取媒体会取到它。

## 任务点与完成判定

- 任务点挂在**卡片**下（见上节）。**一张卡片会把它全部任务点一次渲染出来**（实测同一张卡片里十几个任务点同时在 DOM 里），不是懒加载。
- **扫描入口只能是容器 `div.ans-attach-ct` 本身**：容器里那块 `div.ans-job-icon` 可能只是个空 div、也可能整个不存在（实测 PPT 卡里就有一个容器两者都没有，`jobid` 也不在 iframe 属性上、只写在 iframe 的 `data` JSON 里）。
- **容器 ≠ 任务点**：平台把**资料附件**也塞进同样的 `div.ans-attach-ct` 里。区分的唯一可靠判据是 **`jobid`**——任务点的 `jobid` 写在模块 iframe 的属性上（PPT 的在 `data` JSON 里），**资料附件两处都没有**。实测节点「1.1 音标教学PPT」只有一个容器、里面是 `downloadfile` 模块的 `音标.ppt` 附件，被当成任务点后脚本直接停在 `unknownTaskPointKind`。
- 章节树节点上的 `input.jobUnfinishCount` 是**整节点跨全部卡片**的未完成数，可以直接当「本节点还剩几个」用——它**随完成实时变化**（实测：某个任务点播完被判定完成时，这个数当场减一）。
- ⚠️ **但那一步「实时」是服务端往返级的，不是同 tick**（2026-09-30 实测，更正上一条的措辞）：容器的 `ans-job-finished` 是**客户端当场生效**，而树的计数要等平台自己再发一次 `GET mooc-ans/mycourse/studentstudycourselist?…&chapterId=<当前节点>` 才更新（实测紧跟在那条触发完成判定的 `multimedia/log?playingTime=435` 之后）。两次实测的滞后都是 **3–6 秒**：FIN 那一刻计数还在（`value="1"`），几秒后元素整个消失。**所以「DOM 说做完了、树还说没做完」是一个正常的中转态**，不是两边矛盾。当前节点的那个：`div.posCatalog_active input.jobUnfinishCount`（`type=hidden`）。⚠️ 它**只在未完成数 > 0 时才渲染**：节点没有未完成任务点时页面上根本查不到这个元素（读出来是 `null`，不是 `0`）。
- 任务点的完成态只有一个可靠标记：容器 `div.ans-attach-ct` 上的 **`ans-job-finished`** 类。
- `div.ans-job-icon`（`role="option"`）只能当**「这是个任务点」的识别位**，**既不是完成判据、也不是类型判据**：未完成时它带 `aria-label="任务点未完成"`，已完成时它可能是个空 div 也可能整个不存在，两种情况都实测过。
- **任务点的类型只能从它内部的模块 iframe 的 `src` 读**。`ans-job-icon` 的类名靠不住——视频是 `ans-job-icon ans-job-video ans-job-icon-clear`，**音频与 PPT 都是空的 `ans-job-icon `**：

  | 类型 | 模块 iframe | 其它线索 |
  |---|---|---|
  | 视频 | `/ananas/modules/video/index.html` | 容器带 `videoContainer` 类 |
  | 音频 | `/ananas/modules/audio/index_new.html` | 容器 `aria-label` 是文件名（形如 `Unit05R1Word.mp3`） |
  | PPT | `/ananas/modules/pdf/index.html` | iframe 上直接带 `jobid`；`data` 里 `name` 形如 `Unit 5.ppt` |
  | **资料附件**（**不是任务点**） | `/ananas/modules/downloadfile/index-pc.html` | iframe 上明写 `module="downloadfile"` 与 `class="downloadfile"`；**没有 `jobid`**；`data` 只有 `objectid / name / type / size / hsize / mid`，`name` 形如 `音标.ppt`、`英语语法看这本就够了大全集.pdf` |

- 视频任务点的完成条件是观看时长，**不同节点标示的比例不一致**：同一门课里见过 **90%** 与 **100%** 两种。
- ⚠️ **「被判定完成」可以远早于媒体 `ended`**（2026-09-30 实测，两条视频对照）：上报 URL 里带 `rt=0.9`（完成比例）；比例 < 1 的视频在**还剩几十秒**时容器就戴上 `ans-job-finished`——实测那一刻 `currentTime=437/489`（89.3%，**还剩 53 秒**），容器变 FIN 之后媒体一直播到 `490/490`，平台才自己 `pause()`。同一门课里 `rt=1` 的那条（242 秒）是**播到 `241/242` 才** FIN。**「完成」与「播完」是两个时刻，不能互推。**
- **PPT 任务点没有 `currentTime`**。它的完成条件是**把内容拉到最底端**：滚到底会触发一次
  `GET mooc-ans/job/document?jobid=…&knowledgeid=…&courseid=…&clazzid=…&jtoken=…`，
  响应 `{"msg":"添加考核点成功","status":true}`，之后容器才带上 `ans-job-finished`。
- ⚠️ **但真正承载 PPT 内容的框架是跨域的**：模块里的 `iframe#panView` 指向 `mooc1.xuexitong.com/mooc-ans/screen/file?objectid=…`，它 **302 跳到 `pan-yz.chaoxing.com/screen/v2/file_…?appid=…&nonce=…&timestamp=…&signature=…`**——另一个域。脚本读不到它的 DOM（`contentDocument` 为 `null`，读 `location.href` 抛 `SecurityError`），`fetch` 也被拒。`iframe#wpsView` 是 `about:blank`、`0×0`，**不是**内容层。
- 脚本能触到的只有外层（主文档 / 卡片文档），而**外层滚到底是否足以让平台记完成，尚未验证**。试过的三种都没有触发 `job/document`、容器也没变成 `ans-job-finished`：程序化把主文档滚到底、可信滚轮悬停在查看器上、可信滚轮落在查看器外把主文档滚到底。⚠️ 但这几次探查中查看器请求 `pan-yz.chaoxing.com` 是 `net::ERR_FAILED`（该域本身 `no-cors` 可达，所以是那个带签名的具体请求失败）——**查看器压根没加载起来，否定结果不能当证据**。
- 「滚到底」的挂载点可以亲眼看到：模块给 `iframe#panView` 写了 **`onload="bindScroll()"`**——滚动处理是在这个跨域框架加载完成后绑上去的。
- `job/document` 的调用方**不在任何同源脚本里**（枚举 25 个同源 `script[src]` 全部无命中），触发逻辑要么在外链 bundle、要么就在那个跨域页里。
- 模块里常驻一段隐藏的错误模板：`div#note > p.tipStyle`「文档转码失败，请使用其他软件另存后重新上传【9005】」，`display:none`；文档加载不出来时才会显示。
- 这个跨域查看器**不总是能加载**：本次探查里 `pan-yz.chaoxing.com` 那次带签名的请求是 `net::ERR_FAILED`，`#panView.contentDocument` 始终为 `null`，页面上也就没有任何逐页内容可滚。**排查 PPT 时的第一步应该是先确认它到底加载起来没有。**
- 每个任务点有自己的播放器 iframe 与媒体元素，而且**同一张卡片里的媒体元素是一次性全渲染出来的**（实测同一张卡片里十几个 `<video>`/`<audio>` 同时在 DOM 里）。视频：`preload="none"`、`autoplay=false`、`muted=false`，所以**时长必须等 `play()` 之后才拿得到**（起播前 `duration` 为 `null`）。音频：每个任务点一个真播放器 `audio#audio_html5_api`，外加一个空的 `audio1_html5_white`。
- ⚠️ **媒体元素的 `id` 在各 iframe 里重名**（全都叫 `video_html5_api` / `audio_html5_api`），**不能当「这是同一个媒体」的稳定标识**——同一张卡片里的播放器 id 完全一样。
- ⚠️ **`networkState === 3`（NETWORK_NO_SOURCE）不等于加载失败**：`preload="none"` 的播放器在还没开始加载时就是这个值，而 `error` 仍是 `null`（实测切卡片后新渲染出来的媒体全是这个状态）。判加载失败只能看 `error`。
- ⚠️ 那个 `auditionAudio` 因为 `src=""` **天生带 `error.code=4`**（SRC_NOT_SUPPORTED），同样不能据此判「媒体坏了」。

## 播放与上报

**零点击自动播放可行。** 该域已有用户交互记录，Chrome 的域级 autoplay 授权放行有声播放，实测直接 `video.play()` 成功（`muted:false`）——**不需要静默降级**。

**而且不需要先「选中/打开」任务点**：直接对目标媒体 `play()` 就会播、模块自己会上报（实测：不点任何入口起播后，`multimedia/log` 照发）。反过来，点任务点容器里的 `div.ans-job-icon` **没有任何可观察效果**（DOM 无变化、也不起播）——它不是播放开关。

上报节奏实测**约每 60 秒一次**（同一段视频看到 `playingTime=59 / 62 / 87 …`）。

播放期间按已看时长增量反复调用上报接口：

```
GET mooc1.xuexitong.com/mooc-ans/multimedia/log/a/{personid}/{sessionhash}
    ?playingTime=<已看秒数> &duration=<总秒数> &clipTime=0_88
    &objectId=<视频ID> &jobid=<任务ID> &courseId=… &clazzId=…
    &isdrag=<0|1|2|3> &rt=0.9 &view=pc
    &videoFaceCaptureEnc=<人脸抓拍，多数视频为空> &attDurationEnc=…
```

- **`isdrag` 是平台判定"你是否拖动过进度条"的字段**——脚本绝不能靠改 `currentTime` 来推进。
  ⚠️ **它的取值映射没搞清楚，先别当判据用**：已知取值域是 `0|1|2|3`，但实测脚本只调过 `play()`、全程没碰 `currentTime`，上报出来的仍是 **`isdrag=3`**（2026-09-28，节点「2.3 四级解题技巧视频精讲」第一个视频，`playingTime=59&duration=1378`）。所以 3 很可能表示「没拖」，也可能另有含义——**未确认**，别拿它反推行为。
- `videoFaceCaptureEnc` 说明**部分课程启用人脸抓拍**，那类课程无法自动化。
- 视频文件本体在 `s2.cldisk.com` / `p2.cldisk.com`（跨域 CDN），但只影响媒体资源，不影响 DOM 操作。

## 「下一节」的行为

- 它是 `<div onclick="PCount.next('<index>','<chapterId>','<courseId>','<clazzid>','',true)">`，**不是链接**。页面上有 3 个 `PCount.next` 入口：`a.jb_btn.jb_btn_92.fr.fs14.nextChapter`、`div#prevNextFocusNext`，以及确认框里的 `a.bluebtn02.prebutton.nextChapter`。
- **当前节点还有未完成任务点时，点击会弹确认框**：「当前章节还有任务点未完成，是否去完成？[下一节][去学习]」——平台在明确劝阻跳过。
- 确认框是**常驻在 HTML 里、靠 `display:none` 隐藏**的两个弹层：`div.maskDiv.jobFinishTip > div.popDiv.wid440.popMove > p.popWord2.fs16.colorIn.jobLimitTip`，以及 `div#jobFinishTip.AlertCon02 > div.con03`。判「有没有弹出来」不能看 `visibility` / `opacity`，只能看**尺寸是否为 0**（隐藏时两者都是 `0×0`）。
- 在未完成状态下，直接调用 `PCount.next(...)` **不产生任何跳转**（页面、URL、`window` 状态全不变）。
- **拦不拦只看 `checkJob()`**：`PCount.next(count, chapterId, courseId, clazzid, knowledgestr, checkType)` 的源码里，`checkType && !courseEnded && checkJob()` 为真才 `showCheckDiv(true)` 弹确认框并 `return`，否则往下走真正的跳转。实测在 `1.1 音标教学PPT`、`2.1.2 《……够了》系列电子书`、`2.1.1 词根词缀背单词`（都只有资料附件或空内容）上推进，**一次确认框都没弹**。
- **跳转已确认是局部刷新，不是整页重载**：主文档不重载，只换 URL 与卡片内容（实测：状态条上停住的旧判定连续跨三次换节都没被重置，`performance.now()` 显示文档已开了 96 秒）。⚠️ 推论很重要——**脚本实例跨节点存活**，它一旦在某个节点停下，从这里往后的所有节点都不会再被它管，除非用户点「继续」。

## 章节树与跳节点

- **学习页主文档里就有整棵章节树**，不用回课程页：`div.posCatalog#coursetree`。内容是 `GET mooc-ans/mycourse/studentstudycourselist?courseId=…&chapterId=…&clazzid=…&cpi=…&mooc2=1&searchChapterListByName=` 铺出来的（`$(document).ready` 里一次；成功回调是 `document.getElementById("coursetree").innerHTML = data`，整段替换）。**服务端那份 HTML 里的树是空的**，所以启动瞬间可能还没有节节点。
- 树的两级：**章** = `div.posCatalog_select.firstLayer`（id 就是 chapterId，没有 `posCatalog_name`，只有 `span.posCatalog_title`）；**节** = `div.posCatalog_select#cur<chapterId>`，判据是 **id 以 `cur` 开头**。
- 节的形状与两个**互斥**标记（实测同一门课里两种都在）：

  ```html
  <!-- 已完成 -->
  <div class="posCatalog_select" id="cur<chapterId>">
    <span class="posCatalog_name" title="…" onclick="getTeacherAjax('<courseId>','<clazzid>','<chapterId>');">…</span>
    <span class="icon_Completed prevTips">…已完成…</span>
  </div>
  <!-- 未完成 -->
  <div class="posCatalog_select" id="cur<chapterId>">
    <span class="posCatalog_name" …onclick="getTeacherAjax(…)">…</span>
    <input type="hidden" class="jobUnfinishCount" value="1">
    <span class="catalog_points_yi"><span class="orangeNew">1</span></span>
  </div>
  ```

- ⚠️ **只有资料附件或空内容的节点，这两个标记一个都没有**（`0006` 说它们不进计数，这里得到印证）。所以「这个节点还有事没做」的判据是 `input.jobUnfinishCount` **存在**，不是「没有 `icon_Completed`」。
- **当前节点额外带 `posCatalog_active`**，全树唯一。节点短号（`4.1`）在 **`em.posCatalog_sbar`** 里（⚠️ 是 `em` 不是 `span`，写成 `span.posCatalog_sbar` 会一个都取不到——真机验收时踩过），节点全名在 `span.posCatalog_name[title]` 里。
- **跳节点的入口就是站点自己的**：点 `span.posCatalog_name`（`onclick="getTeacherAjax(courseId, clazzid, chapterId)"`）。实测（同一门课里从 2.3 跳到 4.1、再从 4.1 跳到 4.2）：
  - 一次 `GET mooc-ans/mycourse/studentstudyAjax` 换掉 `#mainid`，URL 跟着变，**不整页重载**——`window` 上的全局变量与脚本实例都活着，被停掉的脚本状态条原样留着；
  - **跨章跳转不需要 `changeCapter`**（`PCount.next` 走到底才 `POST changeCapter`，`getTeacherAjax` 不碰它）；
  - **不弹「还有任务点未完成」确认框**——`checkJob()` 只写在 `PCount.next` 里。实测从**仍有 1 个未完成任务点**的 4.1 直接跳走，两个弹层都是 `0×0`。
- 跳转本身只产生 `studentstudyAjax` + `validatejobcount`（后者由 `getTeacherAjax` 里那句 `$("#cur"+chapterId+" .orangeNew")` 触发）。
- ⚠️ **树会被平台自己刷新，但何时刷新不可控**（2026-09-29 更正）：实测跳转之后**接着出现**一次 `studentstudycourselist?chapterId=<目标节点>`（紧跟在目标节点的播放器初始化之后）。⚠️ 所以「选目标不能假设树是新鲜的」仍然是结论，只是理由换了——不是「不会刷新」，而是**刷新时机不受脚本控制**（`0010` 的「只向前」正是为此）。
  ⚠️ **更正一条旧记录**：本条先前写的是「跳过去之后树不会自己刷新」，证据是「跳转只产生 `studentstudyAjax` + `validatejobcount`」。那条证据**无效**——当时的 grep 模式里写的是 `coursetree` / `catalog`，**匹配不到 `studentstudycourselist` 这个词**，属于「看漏了却当成没发生」。记在这里当教训：**否定性结论要么用完整日志，要么别写。**
- ⚠️ `GET mooc-ans/edit/validatejobcount?courseId=…&clazzid=…&nodeid=…` 的响应体是字符串 `"true"`，**不是计数**，别当实时数据源。
- 树上 39 个节节点**全部**带 `getTeacherAjax` 的 onclick，实测没有锁定态、也没有「未解锁」标记。
- ⚠️ **`studentstudyAjax` 的响应可能不是节点内容，而是「章级人脸识别」页**（2026-09-30 读主文档脚本确认）：站点自己在 success 回调里写着 `jQuery('#mainid').html(data); if(document.getElementById("chapterFaceState") != null){ //人脸识别 return; }` —— 命中时它**提前 return**，于是「点 `posCatalog_name` 跳节点」这条路**静默不生效**（`posCatalog_active` 也不会更新）。主文档里还有 `faceCheckOverJump(chapterId, courseId, clazzid, faceCheckEnc, faceCheckTime)` 与注释「人脸采集」；视频模块的配置 JSON 里另有 `randomFaceCaptureTimeList` / `randomCaptureTime`。脚本侧的现象：跳转失败判据（当前节点没变成目标）与 `detectFaceCapture()` 都可能因此触发。
- 🔍 **一条未复现的观察，待查**（2026-09-30）：探查中脚本曾以 `faceCaptureCourse` 停过一次（视频播到 `67/242` 秒时），但事后用**同一套判据**在页面里复查是 **0 命中**（含隐藏模板也没有「人脸」字样），全程没有任何人脸抓拍专用请求，同 session 里另外两条视频播到自然结束都没触发。判据本身（主文档 `<script>` 里 `videoFaceCaptureEnc=…`，或**任意同源文档里可见的短文本**含「人脸抓拍 / 人脸识别」）看起来会误报；**下次复现时先抓那一刻到底匹配到了哪个元素**。⚠️ 顺带更正：上报参数 `videoFaceCaptureEnc` **不是**「本视频启用人脸抓拍」的可靠标志——实测它在这门课里有的视频非空、有的为空，与是否真的抓拍对不上。

## 防挂机机制

- 平台**自陈**的成因就在视频任务点的「完成条件」文案里：**「未完成任务点前，当前视频不可倍速、不可拖拽、观看时不可离开或将页面最小化」**——防挂机不是附加的限制，它就是完成条件的执行方式。
  ⚠️ 但用户判断这条**不是项目需求**：项目本身不要求「离开就暂停」，是**前端开发人员失误**加进来的，脚本因此把它当前端缺陷绕过（`docs/adr/0009`）。上面这句平台自陈**作为原始证据保留**，不再当作脚本的行为依据。
- 鼠标移出窗口（或其他导致失焦的操作）会让视频暂停。
- **机制在哪一层**（2026-09-28 补）：不在同源内联脚本里 —— 当前学习页的 **10 个同源文档、25 个含内联代码的 `<script>`** 里，`visibilitychange`、`document.hidden`、`mouseleave|mouseout`、`.pause()` 的命中数**全是 0**。实现全在外链 bundle：视频模块加载 `video-js-7.2.2/video.min.js` 与 `/ananas/videojs-ext/videojs-ext.min.js`。
- **判据是元素级 `mouseout`，一次性**：`videojs-ext.min.js` 里那个 `studyControl` 插件把监听绑在**播放器元素**上（`options.el`，缺省退回 `window.top` / `document`），且只有 `e.relatedTarget || e.toElement` **为空**（= 光标真的离开了窗口，而不是在页面内部移动）时才暂停。
  - 这条**精确化了上一轮记的「判据在更底层、派发 `mouseleave`/`blur` 触发不了」**：监听挂在元素上、不在 `document` 上，文档级合成事件打不中它。
  - ⚠️ **它不是轮询、是事件驱动**：`mouseover`（带 `relatedTarget`）回到窗口只把一个标志位置回 `true`，**平台自己不会恢复播放**。推论：**脚本 `play()` 一次就能顶住**（除非光标再进出一次窗口）——这是 `0009` 两段阶梯成立的前提。
- **开关关不掉**：插件选项 `enableSwitchWindow`（值等于 1 时**不**暂停）在**构造时读进闭包**，之后改 `options` 无效——「干脆把这个暂停关掉」这条路走不通，只剩「暂停后重新 `play()`」。
- **另有一层与失焦无关的守卫**：`videojs-ext` 里还有一个 `singleton` —— 某个事件（读起来是「开始播放」）时把自己的随机 id 写进一个**跨 frame 共享的槽位**，随后**每 1 秒**检查：槽位有值且不是自己的 id 就 `pause()`。效果是「同一时刻只有一个播放器能播」，最后起播的持有令牌、其余的在 1 秒内被按停。⚠️ 这段是**读混淆代码推断**的，但它给出了一个现成的理由：**`play()` 调用成功 ≠ 真的在播**，判「续播是否成功」必须看它是否**持续**在播（`0009`）。
- ⚠️ **两个判据是错位的**：平台按一次性 `mouseout` 暂停，脚本按 `document.hasFocus()` 分类失焦/手动。光标移出窗口但**窗口仍有焦点**（移到任务栏、第二块屏）时，脚本会把它算成 `manualPause` —— 所以「光标离开窗口」这一档必须走 `manualPause` 那条路（`0009`）。
- 应对方式：**监听 `video` 的 `pause` + 判断此刻窗口状态**、做显式提示；自 `docs/adr/0009` 起改为**自动续播**（两段阶梯），不再停在那里等人。

## 使用约束（重要）

- **多端登录会被判定异常学习**：同一账号在两个浏览器/设备上同时进入章节页面，平台会弹警告**并登出其中一个会话**（实测发生在本仓库的 Chrome 探查会话与用户日常 Edge 之间）。⚠️ **同一个浏览器里同时开两个章节页也算**（实测：新开一个标签页后，先开的那个标签页被跳到 `detect.xuexitong.com` 的警告页）。探查时只留一个章节标签页。
- 平台风控是活跃的，且 `isdrag`、`videoFaceCaptureEnc` 都指向同一个目标：**防伪造观看**。
