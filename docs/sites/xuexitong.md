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
└─ iframe                              ← 章节正文
   └─ iframe（每个任务点一个）
      └─ iframe  mooc1.xuexitong.com/ananas/modules/video/index.html
         └─ <video>                      ← 与主页面同源，可直接取用
```

- 播放器 iframe 与主页面**同源**（都在 `mooc1.xuexitong.com`），不必跨域通信。
- 但**任务点内容全在 iframe 里**，只读主页面 DOM 会一无所获。

## 任务点与完成判定

- 一个节点（如「3.1 Unit 1」）下有多个**任务点**，分「视频 / PPT / 音频」三类标签。
- 视频任务点的完成条件写在页面上：**观看时长 ≥ 总时长的 90%**。
- 每个任务点一个独立 `<video>`，`preload="none"`、`autoplay=false`、`muted=false`，所以**时长必须等 `play()` 之后才拿得到**（起播前 `duration` 为 `null`）。

## 播放与上报

**零点击自动播放可行。** 该域已有用户交互记录，Chrome 的域级 autoplay 授权放行有声播放，实测直接 `video.play()` 成功（`muted:false`）——**不需要静默降级**。

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

- 它是 `<div onclick="PCount.next('<index>','<chapterId>','<courseId>','<clazzid>','',true)">`，**不是链接**。
- **当前节点还有未完成任务点时，点击会弹确认框**：「当前章节还有任务点未完成，是否去完成？[下一节][去学习]」——平台在明确劝阻跳过。
- 在未完成状态下，直接调用 `PCount.next(...)` **不产生任何跳转**（页面、URL、`window` 状态全不变）。
- ⚠️ **跳转是一次整页重载还是 SPA 局部刷新，尚未确认**——只有"节点内任务点全部完成"后才测得出来。因此脚本按**幂等**设计：每次就绪都重新"找第一个未完成任务点"，不依赖跨页保存的进度。这样两种情形都成立。

## 防挂机机制

- 鼠标移出窗口（或其他导致失焦的操作）会让视频暂停。
- 实测：`document` 派发 `mouseleave`、`window` 派发 `blur` **都无法触发它**——判据在更底层，不是普通 DOM 事件监听。
- 因此应对方式只能是**监听 `video` 的 `pause` + 判断此刻窗口状态**，做**显式提示 + 一键恢复**；不做静默续播（见 `docs/adr/0002`）。

## 使用约束（重要）

- **多端登录会被判定异常学习**：同一账号在两个浏览器/设备上同时进入章节页面，平台会弹警告**并登出其中一个会话**（实测发生在本仓库的 Chrome 探查会话与用户日常 Edge 之间）。
- 平台风控是活跃的，且 `isdrag`、`videoFaceCaptureEnc` 都指向同一个目标：**防伪造观看**。
