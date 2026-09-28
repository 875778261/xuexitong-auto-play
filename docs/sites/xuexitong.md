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
- 章节树节点上的 `input.jobUnfinishCount` 是**整节点跨全部卡片**的未完成数，可以直接当「本节点还剩几个」用——它**随完成实时变化**（实测：某个任务点播完被判定完成时，这个数当场减一）。当前节点的那个：`div.posCatalog_active input.jobUnfinishCount`（`type=hidden`）。
- 任务点的完成态只有一个可靠标记：容器 `div.ans-attach-ct` 上的 **`ans-job-finished`** 类。
- `div.ans-job-icon`（`role="option"`）只能当**「这是个任务点」的识别位**，**既不是完成判据、也不是类型判据**：未完成时它带 `aria-label="任务点未完成"`，已完成时它可能是个空 div 也可能整个不存在，两种情况都实测过。
- **任务点的类型只能从它内部的模块 iframe 的 `src` 读**。`ans-job-icon` 的类名靠不住——视频是 `ans-job-icon ans-job-video ans-job-icon-clear`，**音频与 PPT 都是空的 `ans-job-icon `**：

  | 类型 | 模块 iframe | 其它线索 |
  |---|---|---|
  | 视频 | `/ananas/modules/video/index.html` | 容器带 `videoContainer` 类 |
  | 音频 | `/ananas/modules/audio/index_new.html` | 容器 `aria-label` 是文件名（形如 `Unit05R1Word.mp3`） |
  | PPT | `/ananas/modules/pdf/index.html` | iframe 上直接带 `jobid`；`data` 里 `name` 形如 `Unit 5.ppt` |

- 视频任务点的完成条件是观看时长，**不同节点标示的比例不一致**：同一门课里见过 **90%** 与 **100%** 两种。
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
- `videoFaceCaptureEnc` 说明**部分课程启用人脸抓拍**，那类课程无法自动化。
- 视频文件本体在 `s2.cldisk.com` / `p2.cldisk.com`（跨域 CDN），但只影响媒体资源，不影响 DOM 操作。

## 「下一节」的行为

- 它是 `<div onclick="PCount.next('<index>','<chapterId>','<courseId>','<clazzid>','',true)">`，**不是链接**。页面上有 3 个 `PCount.next` 入口：`a.jb_btn.jb_btn_92.fr.fs14.nextChapter`、`div#prevNextFocusNext`，以及确认框里的 `a.bluebtn02.prebutton.nextChapter`。
- **当前节点还有未完成任务点时，点击会弹确认框**：「当前章节还有任务点未完成，是否去完成？[下一节][去学习]」——平台在明确劝阻跳过。
- 确认框是**常驻在 HTML 里、靠 `display:none` 隐藏**的两个弹层：`div.maskDiv.jobFinishTip > div.popDiv.wid440.popMove > p.popWord2.fs16.colorIn.jobLimitTip`，以及 `div#jobFinishTip.AlertCon02 > div.con03`。判「有没有弹出来」不能看 `visibility` / `opacity`，只能看**尺寸是否为 0**（隐藏时两者都是 `0×0`）。
- 在未完成状态下，直接调用 `PCount.next(...)` **不产生任何跳转**（页面、URL、`window` 状态全不变）。
- ⚠️ **跳转是一次整页重载还是 SPA 局部刷新，尚未确认**——只有"节点内任务点全部完成"后才测得出来。因此脚本按**幂等**设计：每次就绪都重新"找第一个未完成任务点"，不依赖跨页保存的进度。这样两种情形都成立。

## 防挂机机制

- 平台**自陈**的成因就在视频任务点的「完成条件」文案里：**「未完成任务点前，当前视频不可倍速、不可拖拽、观看时不可离开或将页面最小化」**——防挂机不是附加的限制，它就是完成条件的执行方式。
- 鼠标移出窗口（或其他导致失焦的操作）会让视频暂停。
- 实测：`document` 派发 `mouseleave`、`window` 派发 `blur` **都无法触发它**——判据在更底层，不是普通 DOM 事件监听。
- 因此应对方式只能是**监听 `video` 的 `pause` + 判断此刻窗口状态**，做**显式提示 + 一键恢复**；不做静默续播（见 `docs/adr/0002`）。

## 使用约束（重要）

- **多端登录会被判定异常学习**：同一账号在两个浏览器/设备上同时进入章节页面，平台会弹警告**并登出其中一个会话**（实测发生在本仓库的 Chrome 探查会话与用户日常 Edge 之间）。⚠️ **同一个浏览器里同时开两个章节页也算**（实测：新开一个标签页后，先开的那个标签页被跳到 `detect.xuexitong.com` 的警告页）。探查时只留一个章节标签页。
- 平台风控是活跃的，且 `isdrag`、`videoFaceCaptureEnc` 都指向同一个目标：**防伪造观看**。
