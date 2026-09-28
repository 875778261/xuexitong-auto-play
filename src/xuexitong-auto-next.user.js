// ==UserScript==
// @name         学习通 · 自动播放下一节
// @namespace    auto-lesson
// @version      1.0.0
// @description  在目标站点的学习页面上，依次自动播完视频/音频任务点，播完后推进到下一个任务点
// @author       auto-lesson
// @match        https://mooc1.xuexitong.com/mycourse/*
// @grant        none
// @noframes
// @run-at       document-idle
// ==/UserScript==

// 行为边界见 docs/adr/0002（只做如实完播后的推进）与 docs/adr/0003（PPT 不计入需完成范围）。
// 设计依据见 .scratch/xuexitong-auto-next/spec.md。
//
// 本文件分三层：
//   决策核心（纯函数） → 站点适配层 → 驱动循环（副作用）
// 适配层是**全站唯一读/写目标站点 DOM 的地方**（状态条只碰它自己创建的节点）；
// 驱动循环只调它的 isStudyPage / observe / progressText / perform / playOnce。
// 决策核心就是测试缝：喂它观察值，断言它返回的动作。用例在 src/tests/。

(function () {
  'use strict'

  // ============================================================
  // 参数（唯一调参处）
  // ============================================================
  const C = {
    TICK_MS: 1000,                    // 采样间隔
    ADVANCE_DELAY_MS: 15000,          // 播完之后固定等这么久再推进（spec 的共识第 3 条）
    PAUSE_GRACE_MS: 5000,             // 已起播的媒体被暂停后，等这么久才判定为「停下」
    START_GIVEUP_MS: 6000,            // 已请求过起播却仍停在原地，等这么久就判定被浏览器拒绝
    STALL_TIMEOUT_MS: 20000,          // currentTime 这么久不前进即判定卡住
    UNREADY_TIMEOUT_MS: 30000,        // 页面给不出任务点/媒体，等这么久才放弃
    ACTION_COOLDOWN_MS: 4000,         // 同类动作的最小重复间隔
    ADVANCE_REPEAT_GUARD_MS: 8000,    // 页面没变化时，不重复点「下一节」
    TASK_POINT_CACHE_MS: 3000,        // 任务点元素的重扫间隔
  }

  // ============================================================
  // 动作与停止原因（可枚举 —— 回归测试的主体就是这里每一条）
  // ============================================================
  const ACTION = {
    WAIT: 'wait',
    START: 'start',                   // 调 media.play()
    OPEN_TASK_POINT: 'openTaskPoint', // 打开第一个可播的未完成任务点
    ADVANCE: 'advance',               // 点「下一节」
    CONFIRM_ADVANCE: 'confirmAdvance',// 点确认框里的「下一节」
    STOP: 'stop',
  }

  const STOP_REASON = {
    USER_STOPPED: 'userStopped',
    LOGIN_RISK_CONTROL: 'loginRiskControl',
    FACE_CAPTURE_COURSE: 'faceCaptureCourse',
    TASK_POINTS_NOT_FOUND: 'taskPointsNotFound',
    MEDIA_NOT_FOUND: 'mediaNotFound',
    MEDIA_INCOMPLETE_CONFIRM: 'mediaIncompleteConfirm',
    DIALOG_WITHOUT_UNFINISHED: 'dialogWithoutUnfinished',
    MEDIA_LOAD_FAILED: 'mediaLoadFailed',
    FOCUS_LOST_PAUSE: 'focusLostPause',
    MANUAL_PAUSE: 'manualPause',
    STALLED: 'stalled',
    PLAYBACK_REFUSED: 'playbackRefused',
    COURSE_COMPLETED: 'courseCompleted',
  }

  const KIND = { VIDEO: 'video', AUDIO: 'audio', PPT: 'ppt' }

  // ============================================================
  // 决策核心（纯函数 · 测试缝）
  // ============================================================
  //
  // 观察值 observation —— 适配层能「读」到的一切，不含历史：
  //   {
  //     now: number                      当前时刻（ms）
  //     userStopped: boolean             用户是否按了「停止」
  //     focus:  { lost: boolean }        窗口是否失去焦点
  //     page: {
  //       hasNext: boolean               页面上是否还有「下一节」入口
  //       confirmDialogVisible: boolean  「还有任务点未完成」确认框是否可见
  //       riskControlWarning: boolean    多端登录风控警告
  //       faceCaptureRequired: boolean   该课程是否启用人脸抓拍
  //     }
  //     taskPoints: [{ id, kind, completed }]  当前节点内的任务点，按页面顺序
  //     media: null | { key, currentTime, paused, ended, failed }
  //       key —— 这一个媒体元素的稳定标识，用来判断「起播是否已经请求过」
  //   }
  //
  // 记忆 memory —— 跨 tick 的纯数据，本函数返回「下一份」，驱动循环只负责搬运。
  // 动作 action —— { kind }，kind ∈ ACTION；STOP 时另带 reason。

  function initialMemory() {
    return {
      lastSample: null,        // { at, currentTime } 上次 currentTime 发生变化的时刻
      endedAt: null,           // 当前媒体播完的时刻
      unreadySince: null,      // 页面连续给不出「任务点 / 媒体」的起点
      pausedSince: null,       // 当前媒体持续处于暂停的起点
      lastAction: null,        // { kind, at } 上次发出的动作
      advanceSignature: null,  // 上次点「下一节」时看到的任务点签名
      startRequestedKey: null, // 已经替哪个媒体请求过起播（spec：起播不重试）
    }
  }

  function normalizeMemory(mem) {
    return Object.assign(initialMemory(), mem || null)
  }

  // 这批「从某个时刻起算」的字段都是同一形状：没见过就现在开始算，见过就沿用
  function since(previous, now) {
    return previous === null ? now : previous
  }

  function wait(mem) {
    return { action: { kind: ACTION.WAIT }, memory: mem }
  }

  function stop(mem, reason) {
    return { action: { kind: ACTION.STOP, reason }, memory: mem }
  }

  // 同类动作在冷却期内不重复发出 —— 让「点一下」不会变成「点很多下」
  function throttledAction(kind, mem, now, guardMs) {
    const window = guardMs === undefined ? C.ACTION_COOLDOWN_MS : guardMs
    const last = mem.lastAction
    if (last && last.kind === kind && now - last.at < window) return wait(mem)
    return { action: { kind }, memory: Object.assign({}, mem, { lastAction: { kind, at: now } }) }
  }

  // 任务点签名：用来区分「点了没反应」和「已经翻到别处了」
  function signatureOf(taskPoints) {
    return taskPoints.map((t) => t.id + (t.completed ? '1' : '0')).join(',')
  }

  function advance(taskPoints, mem, now) {
    const signature = signatureOf(taskPoints)
    const unchanged = mem.advanceSignature !== null && mem.advanceSignature === signature
    const result = throttledAction(ACTION.ADVANCE, mem, now, unchanged ? C.ADVANCE_REPEAT_GUARD_MS : 0)
    if (result.action.kind === ACTION.WAIT) return result
    return { action: result.action, memory: Object.assign({}, result.memory, { advanceSignature: signature }) }
  }

  function decide(observation, memory) {
    const mem0 = normalizeMemory(memory)
    const now = observation.now
    const page = observation.page || {}
    const focus = observation.focus || {}

    // 1. 用户按了「停止」
    if (observation.userStopped) return stop(mem0, STOP_REASON.USER_STOPPED)

    // 2. 平台风控 / 3. 人脸抓拍 —— 这两类不是脚本能处理的事，直接交给用户
    if (page.riskControlWarning) return stop(mem0, STOP_REASON.LOGIN_RISK_CONTROL)
    if (page.faceCaptureRequired) return stop(mem0, STOP_REASON.FACE_CAPTURE_COURSE)

    const taskPoints = observation.taskPoints || []

    // 4. 采不到任务点：可能页面还在加载，给它一个窗口期
    if (taskPoints.length === 0) {
      const unreadySince = since(mem0.unreadySince, now)
      const mem = Object.assign({}, mem0, { unreadySince })
      if (now - unreadySince >= C.UNREADY_TIMEOUT_MS) return stop(mem, STOP_REASON.TASK_POINTS_NOT_FOUND)
      return wait(mem)
    }

    let mem = mem0
    const unfinished = taskPoints.filter((t) => !t.completed)
    const playable = unfinished.filter((t) => t.kind !== KIND.PPT)

    // 5. 未完成确认框：只剩 PPT 才可以替用户点，否则停在这里（ADR 0002 / ADR 0003）
    if (page.confirmDialogVisible) {
      // 读到「已无未完成任务点」却还弹着确认框 —— 两边有一边错了，停下让人看
      if (unfinished.length === 0) return stop(mem, STOP_REASON.DIALOG_WITHOUT_UNFINISHED)
      if (playable.length === 0) return throttledAction(ACTION.CONFIRM_ADVANCE, mem, now)
      return stop(mem, STOP_REASON.MEDIA_INCOMPLETE_CONFIRM)
    }

    const media = observation.media || null

    // 页面给出了「媒体」或「本来就没有可播的」，这个等待窗口就算结束了
    if (media || playable.length === 0) mem = Object.assign({}, mem, { unreadySince: null })

    // 6. 媒体加载失败
    if (media && media.failed) return stop(mem, STOP_REASON.MEDIA_LOAD_FAILED)

    // 7. 播完了：固定等一段再推进
    if (media && media.ended) {
      const endedAt = since(mem.endedAt, now)
      mem = Object.assign({}, mem, { endedAt })
      if (now - endedAt < C.ADVANCE_DELAY_MS) return wait(mem)
      return advance(taskPoints, mem, now)
    }
    mem = Object.assign({}, mem, { endedAt: null })

    // 8. 暂停分两种，两种都不静默续播（ADR 0002）
    if (media && media.paused) {
      const pausedSince = since(mem.pausedSince, now)
      mem = Object.assign({}, mem, { pausedSince })

      // 8a. 已经起播过又被暂停：可能失焦，也可能是用户自己点的 —— 停下，等用户发话
      if (media.currentTime > 0) {
        if (now - pausedSince >= C.PAUSE_GRACE_MS) {
          return stop(mem, focus.lost ? STOP_REASON.FOCUS_LOST_PAUSE : STOP_REASON.MANUAL_PAUSE)
        }
        return wait(mem)
      }

      // 8b. 还没起播：替它请求一次起播，同一个媒体只请求一次（spec：不重试、不静音重试）
      if (mem.startRequestedKey !== media.key) {
        mem = Object.assign({}, mem, { startRequestedKey: media.key })
        return throttledAction(ACTION.START, mem, now)
      }
      if (now - pausedSince >= C.START_GIVEUP_MS) return stop(mem, STOP_REASON.PLAYBACK_REFUSED)
      return wait(mem)
    }
    mem = Object.assign({}, mem, { pausedSince: null })

    // 9. 卡住：播放中 currentTime 长时间不前进
    if (media) {
      const sample = !mem.lastSample || mem.lastSample.currentTime !== media.currentTime
        ? { at: now, currentTime: media.currentTime }
        : mem.lastSample
      mem = Object.assign({}, mem, { lastSample: sample })
      if (now - sample.at >= C.STALL_TIMEOUT_MS) return stop(mem, STOP_REASON.STALLED)
    } else {
      mem = Object.assign({}, mem, { lastSample: null })
    }

    // 10. 没有可播的任务点了：整门课跑完，或者推进
    if (playable.length === 0) {
      if (page.hasNext === false) return stop(mem, STOP_REASON.COURSE_COMPLETED)
      return advance(taskPoints, mem, now)
    }

    // 11. 有可播的任务点但还没有媒体 —— 打开它；一直等不到就是页面没给出该有的东西
    if (!media) {
      const unreadySince = since(mem.unreadySince, now)
      mem = Object.assign({}, mem, { unreadySince })
      if (now - unreadySince >= C.UNREADY_TIMEOUT_MS) return stop(mem, STOP_REASON.MEDIA_NOT_FOUND)
      return throttledAction(ACTION.OPEN_TASK_POINT, mem, now)
    }

    // 12. 正在播：什么都不做
    return wait(mem)
  }

  // ============================================================
  // 站点适配层 —— 全站唯一知道目标站点 DOM 的地方
  // ============================================================
  //
  // ⚠️ 下面这些选择器/文案是按 docs/sites/xuexitong.md 记下的事实写的，但
  // 「任务点已完成」的标记、音频任务点的结构、确认框的确切结构都还没在真实页面上见过。
  // 它们全部集中在 ADAPTER_FACTS 里，实现时当场确认后改这一处即可。

  const ADAPTER_FACTS = {
    taskPointText: /任务点(未完成|已完成)/,
    taskPointDoneText: /任务点已完成/,
    kindPpt: /ppt/i,
    kindAudio: /音频|audio/i,
    kindVideo: /视频|video/i,
    nextEntry: /下一节/,
    nextOnclick: /PCount\.next/,
    confirmText: /还有任务点未完成/,
    riskControlText: /多端登录|异常学习|其它设备|异地登录|账号.*下?线/,
    faceCaptureText: /人脸抓拍|人脸识别/,
    faceCaptureEnc: /videoFaceCaptureEnc\s*[=:]\s*["']?[A-Za-z0-9+/=]{4,}/,
  }

  const MEDIA_SELECTOR = 'video, audio'
  const MAX_FRAME_DEPTH = 4

  // 遍历所有**同源**文档（主文档 + 逐层 iframe）
  function eachDocument(root, visit, depth) {
    if (depth === undefined) depth = 0
    if (!root || depth > MAX_FRAME_DEPTH) return
    visit(root)
    let frames
    try {
      frames = root.querySelectorAll('iframe')
    } catch (e) {
      return
    }
    for (let i = 0; i < frames.length; i++) {
      let doc = null
      try {
        doc = frames[i].contentDocument // 跨域时抛错或为 null
      } catch (e) {
        doc = null
      }
      if (doc) eachDocument(doc, visit, depth + 1)
    }
  }

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  function ownText(el) {
    let text = ''
    for (let i = 0; i < el.childNodes.length; i++) {
      const node = el.childNodes[i]
      if (node.nodeType === 3) text += node.nodeValue
    }
    return text.replace(/\s+/g, '')
  }

  // 大容器的 textContent 要拼接整棵子树，每秒跑一遍明显拖慢页面。
  // 只在小容器上取全文，够命中要提示的文案。
  function shortText(el, limit) {
    if (!el || el.children.length > 3) return ''
    const text = el.textContent || ''
    if (text.length > (limit || 120)) return ''
    return text.replace(/\s+/g, '')
  }

  // 元素上所有「可以用来搜」的标识拼成一段字符串，供关键词判断
  function searchableAttrs(el) {
    if (!el) return ''
    const cls = typeof el.className === 'string' ? el.className : ''
    const attr = function (name) { return (el.getAttribute && el.getAttribute(name)) || '' }
    return [attr('title'), attr('aria-label'), cls, el.id].filter(Boolean).join(' ')
  }

  function classify(el) {
    const hay = searchableAttrs(el) + '|' + (el.textContent || '').slice(0, 60)
    if (ADAPTER_FACTS.kindPpt.test(hay)) return KIND.PPT
    if (ADAPTER_FACTS.kindAudio.test(hay)) return KIND.AUDIO
    if (ADAPTER_FACTS.kindVideo.test(hay)) return KIND.VIDEO
    return KIND.VIDEO // 认不出来就按视频试；试不出媒体会停成 MEDIA_NOT_FOUND 并提示
  }

  let taskPointCache = { at: 0, items: [] }

  function scanTaskPoints() {
    const matched = []
    eachDocument(document, function (doc) {
      let all
      try {
        all = doc.querySelectorAll('body *')
      } catch (e) {
        return
      }
      for (let i = 0; i < all.length; i++) {
        const el = all[i]
        if (ADAPTER_FACTS.taskPointText.test(searchableAttrs(el)) || ADAPTER_FACTS.taskPointText.test(ownText(el))) {
          matched.push(el)
        }
      }
    })
    // 只保留最深的匹配元素，避免祖先把自己算成任务点
    const leaves = matched.filter(function (el) {
      return !matched.some(function (other) {
        return other !== el && el.contains(other)
      })
    })
    return leaves.map(function (el, index) {
      const label = searchableAttrs(el) + '|' + ownText(el)
      const container = el.closest('li, [role="option"], a, [onclick]') || el
      return {
        id: (container.id || '') + '#' + index + '#' + ownText(el),
        kind: classify(container),
        completed: ADAPTER_FACTS.taskPointDoneText.test(label),
        label: (ownText(el) || searchableAttrs(el) || '任务点').slice(0, 40),
        el: container,
      }
    })
  }

  function currentTaskPoints() {
    const now = Date.now()
    const stale = taskPointCache.items.some(function (t) { return t.el && !t.el.isConnected })
    if (now - taskPointCache.at >= C.TASK_POINT_CACHE_MS || stale || taskPointCache.items.length === 0) {
      taskPointCache = { at: now, items: scanTaskPoints() }
    }
    return taskPointCache.items
  }

  // 页面上可能同时留着上一个任务点的 <video>（切节点时未必被移除）。
  // 所以先排除已播完的、再排除不可见的，免得把旧媒体当成当前这个。
  function findMedia() {
    const candidates = []
    eachDocument(document, function (doc) {
      let all
      try {
        all = doc.querySelectorAll(MEDIA_SELECTOR)
      } catch (e) {
        return
      }
      for (let i = 0; i < all.length; i++) candidates.push(all[i])
    })
    let best = null
    let bestScore = Infinity
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i]
      const ended = el.ended ? 2 : 0
      const hidden = el.tagName === 'AUDIO' || visible(el) ? 0 : 1 // <audio> 没有可见盒子
      if (ended + hidden < bestScore) {
        best = el
        bestScore = ended + hidden
      }
    }
    return best
  }

  function findInDocuments(selector, test) {
    let hit = null
    eachDocument(document, function (doc) {
      if (hit) return
      let all
      try {
        all = doc.querySelectorAll(selector)
      } catch (e) {
        return
      }
      for (let i = 0; i < all.length; i++) {
        if (test(all[i])) { hit = all[i]; return }
      }
    })
    return hit
  }

  // 每秒都要跑的几个查询，缓存一小段时间。元素一旦从文档里掉出去就立刻重查。
  function memo(fn, ttl) {
    let at = 0
    let value = null
    return function () {
      const now = Date.now()
      if (now - at >= ttl || (value && value.isConnected === false)) {
        value = fn()
        at = now
      }
      return value
    }
  }

  const PAGE_CANDIDATES = 'div, span, p, a, button, li'

  const findNextEntry = memo(function () {
    const byOnclick = findInDocuments('[onclick]', function (el) {
      return ADAPTER_FACTS.nextOnclick.test(el.getAttribute('onclick') || '') && visible(el)
    })
    if (byOnclick) return byOnclick
    return findInDocuments(PAGE_CANDIDATES, function (el) {
      const text = ownText(el)
      return text.length > 0 && text.length <= 12 && ADAPTER_FACTS.nextEntry.test(text) && visible(el)
    }) || null
  }, 1000)

  const findConfirmDialog = memo(function () {
    return findInDocuments(PAGE_CANDIDATES, function (el) {
      const text = shortText(el, 200)
      return !!text && ADAPTER_FACTS.confirmText.test(text) && visible(el)
    })
  }, 1000)

  function findConfirmNextButton(dialog) {
    const scope = dialog.parentElement || dialog
    const candidates = scope.querySelectorAll('a, div, span, button')
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i]
      const text = ownText(el)
      if (text.length > 0 && text.length <= 12 && ADAPTER_FACTS.nextEntry.test(text) && visible(el)) return el
    }
    return null
  }

  const detectRiskControl = memo(function () {
    return !!findInDocuments(PAGE_CANDIDATES, function (el) {
      const text = shortText(el, 200)
      return !!text && ADAPTER_FACTS.riskControlText.test(text) && visible(el)
    })
  }, 1500)

  const detectFaceCapture = memo(function () {
    // 人脸抓拍的标记在上报参数里，先只扫 <script>，比整棵 DOM 便宜得多
    const scripts = document.querySelectorAll('script')
    for (let i = 0; i < scripts.length; i++) {
      if (ADAPTER_FACTS.faceCaptureEnc.test(scripts[i].textContent || '')) return true
    }
    return !!findInDocuments(PAGE_CANDIDATES, function (el) {
      const text = shortText(el, 120)
      return !!text && ADAPTER_FACTS.faceCaptureText.test(text) && visible(el)
    })
  }, 5000)

  let mediaSeq = 0

  // 同一个媒体元素的稳定标识。刻意不用 src/currentSrc —— 它们在加载中会变。
  function mediaKey(el) {
    if (!el.__autoLessonKey) {
      el.__autoLessonKey = el.getAttribute('data-objectid') || el.id || 'm' + (++mediaSeq)
    }
    return el.__autoLessonKey
  }

  function observeMedia() {
    const el = findMedia()
    if (!el) return null
    return {
      key: mediaKey(el),
      currentTime: Number(el.currentTime) || 0,
      paused: !!el.paused,
      ended: !!el.ended,
      failed: !!el.error || el.networkState === 3, // 3 = NETWORK_NO_SOURCE
    }
  }

  function observe() {
    const taskPoints = currentTaskPoints().map(function (t) {
      return { id: t.id, kind: t.kind, completed: t.completed }
    })
    return {
      now: Date.now(),
      userStopped: false, // 由驱动循环覆盖
      focus: { lost: !document.hasFocus() },
      page: {
        hasNext: !!findNextEntry(),
        confirmDialogVisible: !!findConfirmDialog(),
        riskControlWarning: detectRiskControl(),
        faceCaptureRequired: detectFaceCapture(),
      },
      taskPoints: taskPoints,
      media: observeMedia(),
    }
  }

  function attemptPlay(el) {
    if (!el || !el.play) return
    const result = el.play()
    if (result && typeof result.catch === 'function') {
      result.catch(function () { /* 按 spec 不重试，交给决策核心的时限去判定 */ })
    }
  }

  // 适配层对外的全部能力。驱动循环只认这几个，自己一行都不碰目标站点的 DOM。
  const adapter = {
    isStudyPage: function () {
      if (typeof location === 'undefined') return false
      if (!/mooc1\.xuexitong\.com$/.test(location.hostname)) return false
      if (/\/mycourse\/(studentstudy|studentstudycourse)/.test(location.pathname)) return true
      return !!findNextEntry()
    },

    observe: observe,

    progressText: function () {
      const points = currentTaskPoints()
      if (points.length === 0) return '任务点：尚未采到'
      const done = points.filter(function (t) { return t.completed }).length
      const media = findMedia()
      const clock = media && media.duration && isFinite(media.duration)
        ? ' | ' + Math.floor(media.currentTime) + '/' + Math.floor(media.duration) + 's'
        : ''
      return '本节进度：' + done + '/' + points.length + clock
    },

    perform: function (action) {
      switch (action.kind) {
        case ACTION.START:
          attemptPlay(findMedia())
          return
        case ACTION.OPEN_TASK_POINT: {
          const target = currentTaskPoints().filter(function (t) {
            return !t.completed && t.kind !== KIND.PPT
          })[0]
          if (target && target.el && target.el.click) target.el.click()
          return
        }
        case ACTION.ADVANCE: {
          const entry = findNextEntry()
          if (entry && entry.click) entry.click()
          return
        }
        case ACTION.CONFIRM_ADVANCE: {
          const dialog = findConfirmDialog()
          const button = dialog && findConfirmNextButton(dialog)
          if (button && button.click) button.click()
          return
        }
        default:
          return
      }
    },

    // 「继续」是人的动作，不是脚本的决策：直接替用户按一次播放
    playOnce: function () {
      const media = findMedia()
      if (media && media.paused && !media.ended) attemptPlay(media)
    },
  }

  // ============================================================
  // 状态条（Shadow DOM 隔离，不碰站点样式）
  // ============================================================
  const REASON_TEXT = {
    userStopped: '你停止了脚本',
    loginRiskControl: '检测到多端登录风控警告，已停下 —— 请只保留一个设备在线',
    faceCaptureCourse: '这门课启用了人脸抓拍，脚本无法自动化，已放弃',
    taskPointsNotFound: '一直没找到任务点，可能不是学习页面，或页面结构变了',
    mediaNotFound: '任务点已打开但等不到视频/音频元素，可能任务点类型识别有误',
    mediaIncompleteConfirm: '这个节点还有没看完的视频，平台弹出了确认框 —— 脚本不替你确认',
    dialogWithoutUnfinished: '平台弹出「还有任务点未完成」，但脚本读到的任务点却都已完成 —— 判定不可信，已停下',
    mediaLoadFailed: '视频加载失败，已停下',
    focusLostPause: '窗口失去焦点后播放被暂停，已停下 —— 请回到窗口后点「继续」',
    manualPause: '播放被暂停了，已停下 —— 点「继续」接着跑',
    stalled: '播放卡住了（进度长时间不前进），已停下',
    playbackRefused: '浏览器拒绝了自动播放，已停下 —— 请手动点一下播放',
    courseCompleted: '整门课已跑完',
    running: '正在运行',
  }

  function createStatusBar() {
    let host = null
    let shadow = null
    let textEl = null
    let stopButton = null
    let resumeButton = null

    function mount() {
      if (host && host.isConnected) return
      host = document.createElement('div')
      host.id = 'auto-lesson-status-host'
      host.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;'
      shadow = host.attachShadow({ mode: 'open' })
      shadow.innerHTML =
        '<style>' +
        '.bar{font:12px/1.5 -apple-system,"Microsoft YaHei",sans-serif;color:#fff;' +
        'background:rgba(20,22,26,.92);border-radius:8px;padding:10px 12px;max-width:340px;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.3)}' +
        '.title{font-weight:600;margin-bottom:4px}' +
        '.row{margin-top:6px;display:flex;gap:8px;flex-wrap:wrap}' +
        'button{font:inherit;color:#fff;background:#3a3f47;border:0;border-radius:5px;' +
        'padding:3px 10px;cursor:pointer}button:hover{background:#4b515b}' +
        '</style>' +
        '<div class="bar"><div class="title">学习通 · 自动播放下一节</div>' +
        '<div class="text"></div><div class="row"></div></div>'
      const row = shadow.querySelector('.row')
      stopButton = document.createElement('button')
      stopButton.textContent = '停止'
      stopButton.addEventListener('click', function () { controller.stop() })
      resumeButton = document.createElement('button')
      resumeButton.textContent = '继续'
      resumeButton.addEventListener('click', function () { controller.resume() })
      row.appendChild(stopButton)
      row.appendChild(resumeButton)
      textEl = shadow.querySelector('.text')
      document.body.appendChild(host)
    }

    // spec 只要求「停下时给恢复入口」：跑的时候只给「停止」，停下才给「继续」
    function render(text, stopped) {
      mount()
      if (textEl.textContent !== text) textEl.textContent = text
      resumeButton.style.display = stopped ? '' : 'none'
      stopButton.style.display = stopped ? 'none' : ''
    }

    return { render: render }
  }

  // ============================================================
  // 驱动循环 —— 唯一的副作用来源
  // ============================================================
  const controller = {
    memory: initialMemory(),
    stopped: false,
    reason: null,
    stoppedByUser: false,
    progress: '',
    timer: null,
    bar: createStatusBar(),
  }

  function tick() {
    if (controller.stopped) return
    let observation
    try {
      observation = adapter.observe()
    } catch (e) {
      return
    }
    observation.userStopped = controller.stoppedByUser
    controller.progress = adapter.progressText()

    const result = decide(observation, controller.memory)
    controller.memory = result.memory

    if (result.action.kind === ACTION.STOP) {
      controller.stopped = true
      controller.reason = result.action.reason
      if (controller.timer) clearInterval(controller.timer)
      controller.timer = null
      controller.bar.render(REASON_TEXT[result.action.reason] + '　' + controller.progress, true)
      return
    }

    adapter.perform(result.action)
    controller.bar.render(REASON_TEXT.running + '　' + controller.progress)
  }

  controller.stop = function () {
    controller.stoppedByUser = true
    controller.stopped = true
    if (controller.timer) clearInterval(controller.timer)
    controller.timer = null
    controller.bar.render(REASON_TEXT.userStopped + '　' + controller.progress, true)
  }

  // 「继续」是人的动作，不是脚本的决策：重置全部时间基准，并按用户意愿直接起播一次
  controller.resume = function () {
    controller.stoppedByUser = false
    controller.stopped = false
    controller.reason = null
    const fresh = initialMemory()
    fresh.lastAction = controller.memory.lastAction
    fresh.advanceSignature = controller.memory.advanceSignature
    controller.memory = fresh
    adapter.playOnce()
    controller.start()
  }

  controller.start = function () {
    if (controller.timer) return
    controller.bar.render(REASON_TEXT.running)
    controller.timer = setInterval(tick, C.TICK_MS)
    tick()
  }

  // ============================================================
  // 调试句柄 —— 测试缝的入口，用例靠它驱动决策核心（见 src/tests/）
  // 刻意只暴露决策核心需要的东西：观察值怎么来、动作怎么执行都归适配层，不在这里开口子
  // ============================================================
  globalThis.__xuexitongAutoNext = {
    decide: decide,
    initialMemory: initialMemory,
    ACTION: ACTION,
    STOP_REASON: STOP_REASON,
    CONSTANTS: C,
  }

  // ============================================================
  // 启动守卫
  // ============================================================
  function bootstrap() {
    if (!adapter.isStudyPage()) return
    controller.start()
  }

  if (typeof document !== 'undefined' && typeof location !== 'undefined') {
    if (document.readyState === 'complete' || document.readyState === 'interactive') bootstrap()
    else document.addEventListener('DOMContentLoaded', bootstrap)
  }
})()
