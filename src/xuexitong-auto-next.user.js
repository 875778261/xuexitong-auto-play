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

// 行为边界见 docs/adr/0002（只做如实完播后的推进）、docs/adr/0005 与 0007（脚本播不了的任务点一律跳过，
// 平台弹确认框时代为确认）、docs/adr/0006（任务点按 jobid 认；只剩资料附件的节点直接推进，不等也不停）、
// docs/adr/0009（媒体没在播时不再直接停下：自动续播 5 次 → 重启一次脚本 → 再 3 次，才真正停下）。
// 设计依据见 .scratch/xuexitong-auto-next/spec.md；层级是「节点 → 卡片 → 任务点」，见 CONTEXT.md。
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
    RESUME_INTERVAL_MS: 5000,         // 续播阶梯的节奏：每 5 秒一次（也接走了原来的暂停宽限）
    RESUME_MAX_ATTEMPTS: 5,           // 第一段：重启之前最多续播几次
    RESTART_MAX_ATTEMPTS: 3,          // 第二段：重启之后最多续播几次
    STALL_TIMEOUT_MS: 20000,          // currentTime 这么久不前进即判定卡住
    UNREADY_TIMEOUT_MS: 30000,        // 页面给不出媒体（或卡片层认不出来），等这么久才放弃
    EMPTY_CARD_GRACE_MS: 3000,        // 本卡片一个任务点都没有时，先按这么久当「还没渲染出来」
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
    AUTO_RESUME: 'autoResume',        // 媒体没在播：再按一次播放（续播阶梯，见 ADR 0009）
    OPEN_TASK_POINT: 'openTaskPoint', // 定位到第一个未完成的可播单元（本卡片内找不到就切下一张卡片）
    ADVANCE: 'advance',               // 点「下一节」
    CONFIRM_ADVANCE: 'confirmAdvance',// 点确认框里的「下一节」
    STOP: 'stop',
  }

  const STOP_REASON = {
    USER_STOPPED: 'userStopped',
    LOGIN_RISK_CONTROL: 'loginRiskControl',
    FACE_CAPTURE_COURSE: 'faceCaptureCourse',
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

  // 「等待」和停止原因一样可枚举 —— 状态条上的倒计时就靠它（见 issues/02）。
  // ⚠️ 同款纪律：新增一条就补一条用例；删掉一条就连它的倒计时文案一起删。
  const PENDING = {
    EMPTY_CARD: 'emptyCard',             // 本卡片 0 个任务点，等它渲染出来
    ADVANCE_DELAY: 'advanceDelay',       // 媒体播完后的固定延迟
    ADVANCE_COOLDOWN: 'advanceCooldown', // 刚推进过，等同类动作的冷却
    UNREADY: 'unready',                  // 等页面交出可播单元，等不到就停下
    AUTO_RESUME: 'autoResume',           // 续播阶梯第一段：还有名额，到点就再按一次播放
    RESUME_RESTART: 'resumeRestart',     // 第一段用尽：等最后一次的结果，没恢复就重启脚本
    AUTO_RESUME_AFTER_RESTART: 'autoResumeAfterRestart', // 第二段（重启之后）：还有名额
    RESUME_FINAL: 'resumeFinal',         // 第二段也用尽：等最后一次的结果，没恢复就停下
    STALLED: 'stalled',                  // 在播，但进度不前进
  }

  const KIND = { VIDEO: 'video', AUDIO: 'audio', PPT: 'ppt', UNKNOWN: 'unknown' }

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
  //     card: { active, total }        当前节点渲染的是第几张卡片、共几张（只有 active 那张的内容在 DOM 里）
  //     taskPoints: [{ id, kind, completed }]  **当前卡片**的任务点，按页面顺序；kind ∈ KIND
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
      unreadySince: null,      // 页面连续给不出「媒体」（或卡片层认不出来）的起点
      emptyCardSince: null,    // 本卡片连续「一个任务点都没有」的起点
      lastAction: null,        // { kind, at } 上次发出的动作
      advanceSignature: null,  // 上次点「下一节」时看到的任务点签名
      startRequestedKey: null, // 已经替哪个媒体请求过起播（spec：起播不重试）
      // 本轮续播阶梯的账本，见 docs/adr/0009：
      //   { key, stage, attempts, dueAt, playingSince }
      //   stage 1 = 第一段（最多 RESUME_MAX_ATTEMPTS 次）；stage 2 = 重启之后（最多 RESTART_MAX_ATTEMPTS 次）
      //   attempts 到本段上限 = 最后一次已发出、正在等它是否生效；playingSince = 从何时起「连续在播」
      resume: null,
      scan: null,              // 本轮「找可播单元」的卡片账本：{ total, visited, sawUnfinished }
      pending: null,           // 当前这次等待：{ kind ∈ PENDING, dueAt, …文案要拼的数字 }；没有倒计时可报就是 null
    }
  }

  function normalizeMemory(mem) {
    return Object.assign(initialMemory(), mem || null)
  }

  // 这批「从某个时刻起算」的字段都是同一形状：没见过就现在开始算，见过就沿用
  function since(previous, now) {
    return previous === null ? now : previous
  }

  // 这一次等待是等什么、等到什么时候 —— 状态条拿它报倒计时。
  // 纯数据，不含文案：文案在状态条那一层（PENDING_TEXT）。
  // extra 用来捎带文案要拼的数字（续播阶梯要报「第 k/N 次」）
  function pendingOf(kind, dueAt, extra) {
    return Object.assign({ kind: kind, dueAt: dueAt }, extra || null)
  }

  // 续播阶梯每一段的名额（docs/adr/0009）
  function resumeMaxOf(stage) {
    return stage === 1 ? C.RESUME_MAX_ATTEMPTS : C.RESTART_MAX_ATTEMPTS
  }

  // 阶梯上这一次等待该报哪条倒计时：还有名额 → 动手类（到点再续播一次）；
  // 名额用尽 → 放弃类（到点就重启脚本 / 就停下）。
  function resumePending(resume) {
    const max = resumeMaxOf(resume.stage)
    if (resume.attempts < max) {
      return pendingOf(
        resume.stage === 1 ? PENDING.AUTO_RESUME : PENDING.AUTO_RESUME_AFTER_RESTART,
        resume.dueAt,
        { attempt: resume.attempts + 1, max: max }
      )
    }
    return pendingOf(resume.stage === 1 ? PENDING.RESUME_RESTART : PENDING.RESUME_FINAL, resume.dueAt)
  }

  // pending 省略 = 这一次等待没有倒计时可报（例如「正在播、什么都不做」）
  function wait(mem, pending) {
    return { action: { kind: ACTION.WAIT }, memory: Object.assign({}, mem, { pending: pending || null }) }
  }

  function stop(mem, reason) {
    return { action: { kind: ACTION.STOP, reason }, memory: Object.assign({}, mem, { pending: null }) }
  }

  // 同类动作在冷却期内不重复发出 —— 让「点一下」不会变成「点很多下」。
  // 冷却期的倒计时只对「推进」这一支单独报：定位那一支永远与「再等 N 秒就停下」并存，
  // 报后者更有用（见 waitForPlayable），所以它不单独占一个 PENDING。
  function throttledAction(kind, mem, now, guardMs, extra) {
    const window = guardMs === undefined ? C.ACTION_COOLDOWN_MS : guardMs
    const last = mem.lastAction
    if (last && last.kind === kind && now - last.at < window) {
      const advancing = kind === ACTION.ADVANCE || kind === ACTION.CONFIRM_ADVANCE
      return advancing ? wait(mem, pendingOf(PENDING.ADVANCE_COOLDOWN, last.at + window)) : wait(mem)
    }
    return {
      action: Object.assign({ kind }, extra || null),
      memory: Object.assign({}, mem, { lastAction: { kind, at: now }, pending: null }),
    }
  }

  // 「可播的未完成任务点」—— 决策核心与适配层共用同一个判据，别各写一份
  function isPlayableUnfinished(t) {
    return !t.completed && (t.kind === KIND.VIDEO || t.kind === KIND.AUDIO)
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
    return {
      action: result.action,
      // 页面要翻了，重新开始算「本卡片是空的」—— 别把上一张卡片的计时等到新节点头上
      memory: Object.assign({}, result.memory, { advanceSignature: signature, emptyCardSince: null }),
    }
  }

  // 「可播单元要跨卡片找」这件事的账本：
  // 一张卡片给出可播单元，搜索就按 spec 写死的顺序从第 1 张卡片重来；
  // 没给出可播单元就把它记下来，记满本节点全部卡片 = 本节点已无可播单元（只剩 PPT）。
  // card.total === 0 表示「卡片层认不出来」（有切换器却没有活动卡片），此时不记也不下结论。
  // provisional = 这张卡片还在「一个任务点都没有」的窗口期里：内容可能只是还没渲染出来，
  // 这一笔不能记（记了就等于「这个节点没什么可做的」，会把它真的跳过）。
  function withCardScan(mem, card, cardGaveWork, cardHasUnfinished, provisional) {
    if (provisional) return mem
    if (cardGaveWork || card.total <= 0) return Object.assign({}, mem, { scan: null })
    const previous = mem.scan && mem.scan.total === card.total
      ? mem.scan
      : { total: card.total, visited: [], sawUnfinished: false }
    const visited = previous.visited.indexOf(card.active) >= 0
      ? previous.visited
      : previous.visited.concat(card.active)
    return Object.assign({}, mem, {
      scan: {
        total: card.total,
        visited: visited,
        sawUnfinished: previous.sawUnfinished || cardHasUnfinished,
      },
    })
  }

  // 本节点的全部卡片是否都看过了。
  // 只有一张卡片时，当前这张就是全部；卡片层认不出来时一律算「没看遍」——宁可停下也不跳。
  function scanCoversNode(mem, card) {
    if (card.total === 0) return false
    if (card.total <= 1) return true
    const scan = mem.scan
    if (!scan || scan.total !== card.total) return false
    for (let i = 1; i <= card.total; i++) {
      if (scan.visited.indexOf(i) < 0) return false
    }
    return true
  }

  // spec 写死的查找顺序：从第 1 张卡片起。切卡片就切到「还没找过的卡片里序号最小的那张」。
  // 返回 null = 别切（卡片层认不出来时宁可原地等超时停下，也不瞎点）。
  function nextCardToVisit(mem, card) {
    if (card.total <= 0) return null
    const scan = mem.scan
    if (!scan || scan.total !== card.total) return 1
    for (let i = 1; i <= card.total; i++) {
      if (scan.visited.indexOf(i) < 0) return i
    }
    return 1
  }

  function decide(observation, memory) {
    const mem0 = normalizeMemory(memory)
    const now = observation.now
    const page = observation.page || {}
    const focus = observation.focus || {}
    const card = observation.card || { active: 1, total: 1 }

    // 1. 用户按了「停止」
    if (observation.userStopped) return stop(mem0, STOP_REASON.USER_STOPPED)

    // 2. 平台风控 / 3. 人脸抓拍 —— 这两类不是脚本能处理的事，直接交给用户
    if (page.riskControlWarning) return stop(mem0, STOP_REASON.LOGIN_RISK_CONTROL)
    if (page.faceCaptureRequired) return stop(mem0, STOP_REASON.FACE_CAPTURE_COURSE)

    const taskPoints = observation.taskPoints || []

    // 「要播的」与「脚本播不了的」是两个集合：PPT、以及被判成**认不出类型**的任务点都归后者
    // （ADR 0005 / 0007）。它们不参与播放，但要参与「本节点还有没有要做的事」这个判断。
    const unfinished = taskPoints.filter((t) => !t.completed)
    const playable = unfinished.filter(isPlayableUnfinished)

    // 4. 本卡片一个任务点都没有 —— 先当「内容还没渲染出来」，给它一个窗口期。
    //    窗口期里不记账：记了就等于「这个节点没什么可做的」，会把真任务点也跳过去（ADR 0006）
    const emptyCardSince = taskPoints.length === 0 ? since(mem0.emptyCardSince, now) : null
    const emptyCardProvisional = emptyCardSince !== null && now - emptyCardSince < C.EMPTY_CARD_GRACE_MS

    // 5. 卡片账本：可播单元要找遍本节点的全部卡片（DOM 里只有 active 那张的内容）
    let mem = withCardScan(mem0, card, playable.length > 0, unfinished.length > 0, emptyCardProvisional)
    mem = Object.assign({}, mem, { emptyCardSince })
    const scannedAll = scanCoversNode(mem, card)

    // 6. 未完成确认框（ADR 0002 / 0005 / 0007）：扫遍全部卡片、未完成的全是**脚本播不了的**
    //    （PPT 或认不出类型），才替用户点确认。
    //    ⚠️ 这一步必须排在「本卡片空就推进」前面：平台说还有没做的、脚本却一个未完成都没看见时，
    //    这里是唯一会停下来的地方（ADR 0006 的安全网就是这张确认框，不是脚本自己造的判据）
    if (page.confirmDialogVisible) {
      if (scannedAll && playable.length === 0) {
        // 扫遍了却一个未完成任务点都没看到，平台却弹了确认框 —— 两边有一边错了，停下让人看
        if (mem.scan && mem.scan.sawUnfinished) return throttledAction(ACTION.CONFIRM_ADVANCE, mem, now)
        return stop(mem, STOP_REASON.DIALOG_WITHOUT_UNFINISHED)
      }
      return stop(mem, STOP_REASON.MEDIA_INCOMPLETE_CONFIRM)
    }

    // 7. 本卡片是空的：窗口期内先等；窗口期过了就照卡片账本办 ——
    //    没扫遍本节点的其他卡片就去扫，扫遍了就推进（ADR 0006：只剩资料附件的节点直接推进）
    if (emptyCardProvisional) {
      return wait(mem, pendingOf(PENDING.EMPTY_CARD, emptyCardSince + C.EMPTY_CARD_GRACE_MS))
    }
    if (taskPoints.length === 0) return locateOrAdvance()

    const media = observation.media || null

    // 页面给出了「媒体」，这个等待窗口就算结束了
    if (media) mem = Object.assign({}, mem, { unreadySince: null })

    // 8. 续播阶梯的「恢复确认」：媒体回到在播、且**连续在播满一个间隔**才算真的活了（ADR 0009）。
    //    只用「paused === false」不行：平台的播放器之间有一个 1 秒轮询的「同一时刻只有一个能播」
    //    守卫，「起了又被按停」会被瞬时判据当成成功 —— 5 次的上限于是悄悄变成无限。
    //    媒体中途消失（media 为 null）时账本原样留着：那是同一轮故障，不能被当成新的一轮。
    if (mem.resume && media) {
      if (!media.failed && !media.paused) {
        const playingSince = since(mem.resume.playingSince, now)
        mem = Object.assign({}, mem, {
          resume: now - playingSince >= C.RESUME_INTERVAL_MS
            ? null
            : Object.assign({}, mem.resume, { playingSince: playingSince }),
        })
      } else if (mem.resume.playingSince !== null) {
        mem = Object.assign({}, mem, { resume: Object.assign({}, mem.resume, { playingSince: null }) })
      }
    }

    // 9. 媒体加载失败 → 先走续播阶梯（原先立刻停；网络抖动时 play() 会重跑资源选择，可能救回来）
    if (media && media.failed) return resumeOrStop(STOP_REASON.MEDIA_LOAD_FAILED)

    // 10. 播完了：固定等一段，再去找下一个可播单元。播完说明这条媒体的事已经结束，阶梯作废
    if (media && media.ended) {
      const endedAt = since(mem.endedAt, now)
      mem = Object.assign({}, mem, { endedAt, resume: null })
      if (now - endedAt < C.ADVANCE_DELAY_MS) {
        return wait(mem, pendingOf(PENDING.ADVANCE_DELAY, endedAt + C.ADVANCE_DELAY_MS))
      }
      return locateOrAdvance()
    }
    mem = Object.assign({}, mem, { endedAt: null })

    // 11. 暂停：不再停下等人，交给续播阶梯（ADR 0009）
    if (media && media.paused) {
      // 11a. 还没起播：替它请求一次起播，同一个媒体只请求一次。**首次请求仍然立刻发**，
      //      被反转的只是「之后不重试」（那一条现在由阶梯接管）。
      //      起播请求**不走冷却**：同一个媒体只请求一次已由 startRequestedKey 守住；
      //      再叠一层冷却反而会把那次请求吞掉（冷却返回 WAIT 时 key 已经记下，之后不再发）
      if (media.currentTime === 0 && mem.startRequestedKey !== media.key) {
        mem = Object.assign({}, mem, { startRequestedKey: media.key })
        return throttledAction(ACTION.START, mem, now, 0)
      }
      // 11b. 其余情形（已起播又被暂停、起播请求过却一直没动）都走阶梯 ——
      //      原因只在**真正停下**那一刻才用，焦点那时可能已经回来了。
      //      从没播起来过的一律算「被拒」；确实播过才按焦点分「失焦」与「手动」
      return resumeOrStop(media.currentTime === 0
        ? STOP_REASON.PLAYBACK_REFUSED
        : (focus.lost ? STOP_REASON.FOCUS_LOST_PAUSE : STOP_REASON.MANUAL_PAUSE))
    }

    // 12. 卡住：播放中 currentTime 长时间不前进
    let pending = null
    if (media) {
      // 本 tick 的 currentTime 和上次采样一样 = 进度真的没动，这时才报倒计时。
      // 正常播放时每次采样都在前进，报的是「还剩 Ns」，而不是一条吓人的「会停下」
      const advanced = !mem.lastSample || mem.lastSample.currentTime !== media.currentTime
      const sample = advanced ? { at: now, currentTime: media.currentTime } : mem.lastSample
      mem = Object.assign({}, mem, { lastSample: sample })
      if (now - sample.at >= C.STALL_TIMEOUT_MS) return stop(mem, STOP_REASON.STALLED)
      if (!advanced) pending = pendingOf(PENDING.STALLED, sample.at + C.STALL_TIMEOUT_MS)
    } else {
      mem = Object.assign({}, mem, { lastSample: null })
    }

    // 13. 本卡片还有未完成的可播任务点、媒体也已经在播 —— 什么都不做
    if (playable.length > 0 && media) return wait(mem, pending)

    // 14. 该去找下一个可播单元了
    return locateOrAdvance()

    // 续播阶梯（docs/adr/0009）：「媒体没在播」的几条出口共用这一段 ——
    // 先按间隔再播几次；第一段用尽就重启一次脚本；第二段也用尽才真正停下。
    // reason 由调用方给出，只在**停下那一刻**才用到（焦点可能已经回来了）。
    function resumeOrStop(reason) {
      const key = media.key
      let resume = mem.resume
      if (!resume || resume.key !== key) {
        // 新的一轮（换了媒体，或头一次发现这条媒体没在播）：第一次尝试排在一个间隔之后
        resume = { key: key, stage: 1, attempts: 0, dueAt: now + C.RESUME_INTERVAL_MS, playingSince: null }
        mem = Object.assign({}, mem, { resume: resume })
        return wait(mem, resumePending(resume))
      }
      if (now < resume.dueAt) return wait(mem, resumePending(resume))

      const max = resumeMaxOf(resume.stage)
      if (resume.attempts < max) {
        resume = Object.assign({}, resume, {
          attempts: resume.attempts + 1,
          dueAt: now + C.RESUME_INTERVAL_MS,
          playingSince: null,
        })
        mem = Object.assign({}, mem, { resume: resume })
        return {
          action: { kind: ACTION.AUTO_RESUME },
          memory: Object.assign({}, mem, { pending: resumePending(resume) }),
        }
      }

      // 名额用尽且已到点：第一段 → 重启一次脚本；第二段 → 真正停下
      if (resume.stage === 1) {
        // 重启 = 与「继续」按钮同一套口径：重置全部时间基准（重新扫任务点、重新找媒体），
        // 但**保住推进的记忆**（lastAction / advanceSignature 丢了会重复点「下一节」），
        // 并记住「已经重启过一次」这件事 —— 否则重启后又获得 5 次，就无限了
        const fresh = initialMemory()
        fresh.lastAction = mem.lastAction
        fresh.advanceSignature = mem.advanceSignature
        fresh.resume = { key: key, stage: 2, attempts: 0, dueAt: now + C.RESUME_INTERVAL_MS, playingSince: null }
        return {
          action: { kind: ACTION.AUTO_RESUME },
          memory: Object.assign(fresh, { pending: resumePending(fresh.resume) }),
        }
      }
      return stop(mem, reason)
    }

    // 「推进」的全部出口：先在本卡片内定位；本卡片没有可播单元就切到还没找过的卡片；
    // 全部卡片都找过、确实没有可播单元了，才去点「下一节」。
    function locateOrAdvance() {
      if (playable.length > 0) return waitForPlayable(null)
      if (!scannedAll) return waitForPlayable({ card: nextCardToVisit(mem, card) })
      if (page.hasNext === false) return stop(mem, STOP_REASON.COURSE_COMPLETED)
      return advance(taskPoints, mem, now)
    }

    // 还在等页面把可播单元交出来（媒体还没出现，或卡片还没切过去）——
    // 一直等不到就停下，别在这儿硬撑
    function waitForPlayable(extra) {
      const unreadySince = since(mem.unreadySince, now)
      // 要切卡片了：页面马上要换一张，重新开始算「本卡片是空的」
      mem = Object.assign({}, mem, { unreadySince, emptyCardSince: null })
      if (now - unreadySince >= C.UNREADY_TIMEOUT_MS) return stop(mem, STOP_REASON.MEDIA_NOT_FOUND)
      const result = throttledAction(ACTION.OPEN_TASK_POINT, mem, now, undefined, extra)
      if (result.action.kind !== ACTION.WAIT) return result
      // 「再等多久就停下」比「多久后重试定位」要紧：两个倒计时并存时留前者
      return wait(result.memory, pendingOf(PENDING.UNREADY, unreadySince + C.UNREADY_TIMEOUT_MS))
    }
  }

  // ============================================================
  // 站点适配层 —— 全站唯一知道目标站点 DOM 的地方
  // ============================================================
  //
  // 下面这些选择器/文案都是按 docs/sites/xuexitong.md 里记下的**已确认事实**写的
  // （卡片层、任务点容器、模块 iframe、确认框、风控文案）。站点改版时改这一处。

  const ADAPTER_FACTS = {
    taskPointContainer: '.ans-attach-ct',       // 任务点容器：完成态看它的 ans-job-finished 类
    jobFinishedClass: 'ans-job-finished',
    moduleFrame: 'iframe[src*="/ananas/modules/"]', // 类型只看这个模块 iframe 的 src
    moduleKind: /\/ananas\/modules\/([a-z]+)\//,
    moduleKindMap: { video: KIND.VIDEO, audio: KIND.AUDIO, pdf: KIND.PPT },
    cardSwitcher: 'ul.prev_ul > li',            // 卡片切换器（在主文档里），活动态带 active 类
    cardId: /^dct\d+$/,                         // 事实上的卡片是 li#dctN
    cardActiveClass: 'active',
    nodeUnfinishedInput: '.posCatalog_active input.jobUnfinishCount', // 平台自己的「本节点待完成数」
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

  // 任务点的类型只看它自己的模块 iframe 的 src：卡片标签不代表内容，
  // ans-job-icon 的类名对音频与 PPT 也是空的。认不出就返回 UNKNOWN，交给决策核心停下。
  function classifyTaskPoint(el) {
    const module = el.querySelector(ADAPTER_FACTS.moduleFrame)
    if (!module) return KIND.UNKNOWN
    const matched = ADAPTER_FACTS.moduleKind.exec(module.getAttribute('src') || '')
    if (!matched) return KIND.UNKNOWN
    return ADAPTER_FACTS.moduleKindMap[matched[1]] || KIND.UNKNOWN
  }

  // 任务点的唯一判据：jobid。模块 iframe 的属性上有，或者 data JSON 里有（PPT 的只写在 data 里）。
  // 两处都读不到就**不是任务点** —— 平台把资料附件（/ananas/modules/downloadfile/）渲染进同一个
  // .ans-attach-ct 容器里，它没有 jobid、不计入 jobUnfinishCount、也不会拦住「下一节」（ADR 0006）。
  function jobIdOf(el) {
    const module = el.querySelector(ADAPTER_FACTS.moduleFrame)
    if (!module) return ''
    const direct = module.getAttribute('jobid')
    if (direct) return direct
    try {
      const data = JSON.parse(module.getAttribute('data') || '{}')
      return data.jobid || data._jobid || ''
    } catch (e) {
      return ''
    }
  }

  let taskPointCache = { at: 0, items: [] }

  // 任务点 = 卡片文档里**带 jobid** 的 .ans-attach-ct 容器，**不**按文案或 icon 找：
  // 已完成的任务点没有「已完成」文案，ans-job-icon 也可能整个不存在。
  function scanTaskPoints() {
    const found = []
    eachDocument(document, function (doc) {
      let all
      try {
        all = doc.querySelectorAll(ADAPTER_FACTS.taskPointContainer)
      } catch (e) {
        return
      }
      for (let i = 0; i < all.length; i++) found.push(all[i])
    })
    // 容器一般不套容器；稳妥起见把嵌套的内层去掉，免得一个任务点被数两次
    const containers = found.filter(function (el) {
      return !found.some(function (other) { return other !== el && other.contains(el) })
    })
    const items = []
    containers.forEach(function (el) {
      const id = jobIdOf(el)
      if (!id) return // 资料附件，或模块 iframe 还没渲染出来 —— 都不是任务点
      items.push({
        id: id,
        kind: classifyTaskPoint(el),
        completed: el.classList.contains(ADAPTER_FACTS.jobFinishedClass),
        el: el,
      })
    })
    return items
  }

  function currentTaskPoints() {
    const now = Date.now()
    const stale = taskPointCache.items.some(function (t) { return t.el && !t.el.isConnected })
    if (now - taskPointCache.at >= C.TASK_POINT_CACHE_MS || stale || taskPointCache.items.length === 0) {
      taskPointCache = { at: now, items: scanTaskPoints() }
    }
    return taskPointCache.items
  }

  // 有 src / currentSrc / <source> / 读得到的 duration 才算「有可用源」。
  // 卡片文档里那个 <audio id="auditionAudio" src=""> 四样都没有。
  function hasUsableSource(el) {
    if (!el) return false
    if (el.currentSrc) return true
    if (el.getAttribute('src')) return true
    if (el.querySelector && el.querySelector('source[src]')) return true
    return typeof el.duration === 'number' && isFinite(el.duration) && el.duration > 0
  }

  // 媒体元素在任务点的模块 iframe 里，它自己看不到外面的容器，要靠 frameElement 往上一层找
  function containingTaskPoint(el) {
    let frame = null
    try {
      const doc = el.ownerDocument
      frame = doc && doc.defaultView && doc.defaultView.frameElement
    } catch (e) {
      frame = null
    }
    return frame && frame.closest ? frame.closest(ADAPTER_FACTS.taskPointContainer) : null
  }

  // 「第一个未完成的可播单元」——定位动作与起播都以它为准
  function firstPlayableUnfinished() {
    return currentTaskPoints().filter(isPlayableUnfinished)[0] || null
  }

  // 一张卡片会把它的全部任务点一次渲染出来，页面上同时躺着好几个媒体元素。
  // 打分顺序：有可用源 → 属于未完成的可播任务点 → 没播完 → 可见。
  // 于是每个文档里那个空的 AI 试听 <audio> 排在最后（没有可用源的元素根本不会被当成媒体，
  // 见 observeMedia）。
  // ⚠️ 副作用（2026-09-28 真机实测）：因为「没播完」也参与打分，一条媒体播完后只要本卡片还有
  // 别的未完成任务点，这里就会选中**下一个**媒体——决策核心里 `media.ended` 那一支
  // （播完固定等 ADVANCE_DELAY_MS）实际上只在**本卡片最后一个可播任务点**播完时才走到。
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
    const playable = currentTaskPoints().filter(isPlayableUnfinished)
    let best = null
    let bestScore = Infinity
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i]
      const container = containingTaskPoint(el)
      const inUnfinished = !!container && playable.some(function (t) { return t.el === container })
      const score = (hasUsableSource(el) ? 0 : 8)
        + (inUnfinished ? 0 : 4)
        + (el.ended ? 2 : 0)
        + (el.tagName === 'AUDIO' || visible(el) ? 0 : 1) // <audio> 没有可见盒子
      if (score < bestScore) {
        best = el
        bestScore = score
      }
    }
    return best
  }

  // 卡片：主文档里的切换器，同一时刻只有带 active 的那张把内容渲染进 iframe。
  // 事实上的卡片是 `li#dctN`（见 docs/sites），所以先按 id 收一遍，收不到才退回全部 li。
  function cardList() {
    let all = []
    try {
      all = Array.prototype.slice.call(document.querySelectorAll(ADAPTER_FACTS.cardSwitcher))
    } catch (e) {
      return []
    }
    const byId = all.filter(function (li) { return ADAPTER_FACTS.cardId.test(li.id) })
    return byId.length > 0 ? byId : all
  }

  function cardIndexOf(cards) {
    for (let i = 0; i < cards.length; i++) {
      if (cards[i].classList.contains(ADAPTER_FACTS.cardActiveClass)) return i
    }
    return -1
  }

  function observeCard() {
    const cards = cardList()
    const active = cardIndexOf(cards)
    // 只有一张卡片（或压根没有切换器）：当前这张就是全部
    if (cards.length < 2) return { active: 1, total: 1 }
    // 有切换器却认不出活动卡片：卡片层不可信，交给决策核心按「没找遍」处理（宁可停下也不跳）
    if (active < 0) return { active: 0, total: 0 }
    return { active: active + 1, total: cards.length }
  }

  // 切到指定的那张卡片（1 起算）。点在站点自己的 changeDisplayContent 入口上。
  // 目标卡片由决策核心按 spec 的顺序给出（从第 1 张卡片起）。
  function switchToCard(index) {
    const cards = cardList()
    const target = cards[index - 1]
    if (!target || !target.click) return
    if (target.classList.contains(ADAPTER_FACTS.cardActiveClass)) return
    target.click()
    taskPointCache = { at: 0, items: [] } // 卡片重渲染，缓存的元素引用立刻作废
  }

  // 把要播的任务点带到眼前。起播本身不需要点任何入口（实测直接 play() 即可，
  // 模块自己会上报），这里只是不让它一直在屏幕外播。
  function bringIntoView(el) {
    if (!el || !el.scrollIntoView) return
    try {
      el.scrollIntoView({ block: 'center' })
    } catch (e) {
      /* 老引擎不认 options，忽略 */
    }
  }

  // 「定位到第一个未完成的可播单元」：
  // 决策核心说切卡片（带 card 序号）就切过去；没说就说明可播单元在本卡片里，把它带到眼前。
  function locateNextPlayable(cardIndex) {
    if (cardIndex) {
      switchToCard(cardIndex)
      return
    }
    const target = firstPlayableUnfinished()
    if (target) bringIntoView(target.el)
  }

  // 平台自己在章节树上给的「本节点待完成数」（含 PPT），只用来展示
  function readNodeUnfinished() {
    try {
      const input = document.querySelector(ADAPTER_FACTS.nodeUnfinishedInput)
      const value = input ? Number(input.value) : NaN
      return isFinite(value) ? value : null
    } catch (e) {
      return null
    }
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

  // 同一个媒体元素的稳定标识。刻意不用 src/currentSrc —— 它们在加载中会变；
  // 也不能用 el.id —— 同一张卡片里 10 个播放器都叫 video_html5_api。
  function mediaKey(el) {
    if (!el.__autoLessonKey) {
      el.__autoLessonKey = el.getAttribute('data-objectid') || 'm' + (++mediaSeq)
    }
    return el.__autoLessonKey
  }

  function observeMedia() {
    const el = findMedia()
    if (!el) return null
    // 没有可用源的元素不是「能播的媒体」：它是卡片里那个 src="" 的 AI 试听音频，
    // 或模块 iframe 还没渲染出播放器。当成 null 等真媒体出现，别拿它当故障或去起播。
    if (!hasUsableSource(el)) return null
    return {
      key: mediaKey(el),
      currentTime: Number(el.currentTime) || 0,
      paused: !!el.paused,
      ended: !!el.ended,
      // 只看 error：preload="none" 的播放器在还没开始加载时也会报
      // networkState=3（NETWORK_NO_SOURCE）而 error 为 null，那不是故障
      failed: !!el.error,
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
      card: observeCard(),
      taskPoints: taskPoints,
      media: observeMedia(),
    }
  }

  function attemptPlay(el) {
    if (!el || !el.play) return
    const container = containingTaskPoint(el)
    if (container) bringIntoView(container)
    const result = el.play()
    if (result && typeof result.catch === 'function') {
      result.catch(function () { /* 失败不在这里管：交给决策核心的续播阶梯（ADR 0009） */ })
    }
  }

  // 「继续」按钮与续播阶梯共用同一件事：对当前媒体按一次播放。
  // 仍然只碰这一个媒体 —— 不改时间轴、不动上报字段（ADR 0002 的边界不动）。
  function playOnce() {
    const media = findMedia()
    if (media && hasUsableSource(media) && media.paused && !media.ended) attemptPlay(media)
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

    // 进度是**当前卡片**的 x/y（DOM 里只有这一张卡片的任务点），另加平台自己给的
    // 「本节点未完成 N（含 PPT）」—— 那个数含 PPT、不会归零，所以不写成「还剩 N 个要做」。
    // memory 只用来读 pending 那条倒计时（唯一来源在决策核心，适配层不自己算时限）
    progressText: function (memory) {
      const points = currentTaskPoints()
      const card = observeCard()
      const parts = []
      if (points.length === 0) {
        parts.push('本卡片无任务点')
      } else {
        const done = points.filter(function (t) { return t.completed }).length
        parts.push('本卡片 ' + done + '/' + points.length)
      }
      if (card.total > 1) parts.push('卡片 ' + card.active + '/' + card.total)
      const nodeUnfinished = readNodeUnfinished()
      if (nodeUnfinished !== null) parts.push('本节点未完成 ' + nodeUnfinished + '（含 PPT）')
      const media = findMedia()
      const playing = media && media.duration && isFinite(media.duration)
      if (playing) {
        const remain = Math.max(0, Math.floor(media.duration - media.currentTime))
        parts.push(Math.floor(media.currentTime) + '/' + Math.floor(media.duration) + 's')
        if (remain > 0) parts.push('还剩 ' + remain + 's')
      }
      const countdown = pendingText(memory)
      if (countdown) parts.push(countdown)
      return parts.join('　|　')
    },

    perform: function (action) {
      switch (action.kind) {
        case ACTION.START:
          attemptPlay(findMedia())
          return
        case ACTION.AUTO_RESUME:
          playOnce()
          return
        case ACTION.OPEN_TASK_POINT:
          locateNextPlayable(action.card)
          return
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

    // 「继续」是人的动作，不是脚本的决策：直接替用户按一次播放（与续播阶梯同一个动作）
    playOnce: playOnce,
  }

  // ============================================================
  // 状态条（Shadow DOM 隔离，不碰站点样式）
  // ============================================================
  // 文案里的时限一律由常量拼 —— 手写的数字迟早与常量对不上（「文案说 20 秒、代码等 30 秒」）
  function secs(ms) {
    return Math.round(ms / 1000)
  }

  // 续播阶梯两段都用尽之后才有的后缀 —— 步数同样由常量拼，不手写数字（docs/adr/0009）
  const RESUME_EXHAUSTED = '（已自动续播 ' + C.RESUME_MAX_ATTEMPTS + ' 次、重启后 ' +
    C.RESTART_MAX_ATTEMPTS + ' 次均未成功）'

  const REASON_TEXT = {
    userStopped: '你停止了脚本',
    loginRiskControl: '检测到多端登录风控警告，已停下 —— 请只保留一个设备在线',
    faceCaptureCourse: '这门课启用了人脸抓拍，脚本无法自动化，已放弃',
    mediaNotFound: '一直没找到可播的视频/音频元素，等了 ' + secs(C.UNREADY_TIMEOUT_MS) +
      ' 秒也没有，已停下 —— 可能是任务点结构变了，或卡片层认不出来',
    mediaIncompleteConfirm: '平台弹出了「还有任务点未完成」，但脚本还没把本节点的可播任务点找完/播完 —— 判断不可信，脚本不替你确认',
    dialogWithoutUnfinished: '平台弹出「还有任务点未完成」，但脚本扫遍本节点却一个未完成任务点都没看到 —— 判定不可信，已停下',
    mediaLoadFailed: '视频/音频加载失败，已停下' + RESUME_EXHAUSTED,
    focusLostPause: '窗口失去焦点后播放被暂停，已停下 —— 请回到窗口后点「继续」' + RESUME_EXHAUSTED,
    manualPause: '播放被暂停了，已停下 —— 点「继续」接着跑' + RESUME_EXHAUSTED,
    stalled: '播放卡住了（进度 ' + secs(C.STALL_TIMEOUT_MS) + ' 秒不前进），已停下',
    playbackRefused: '浏览器拒绝了自动播放，已停下 —— 请手动点一下播放' + RESUME_EXHAUSTED,
    courseCompleted: '没有「下一节」入口了，脚本结束 —— 若后面还有内容，多半是页面结构变了',
    running: '正在运行',
  }

  // 倒计时的措辞：到期会「动手」的用「N 秒后…」，到期会「停下」的用「再等 N 秒…」——
  // 两类必须一眼分得开，否则「还剩 4 秒」到底是动手还是放弃都得猜
  const PENDING_TEXT = {
    [PENDING.EMPTY_CARD]: function (s) { return s + ' 秒后跳过本卡片' },
    [PENDING.ADVANCE_DELAY]: function (s) { return s + ' 秒后继续推进' },
    [PENDING.ADVANCE_COOLDOWN]: function (s) { return s + ' 秒后重试推进' },
    [PENDING.UNREADY]: function (s) { return '再等 ' + s + ' 秒没动静就停下' },
    [PENDING.AUTO_RESUME]: function (s, p) {
      return s + ' 秒后自动续播（第 ' + p.attempt + '/' + p.max + ' 次）'
    },
    [PENDING.RESUME_RESTART]: function (s) { return '再等 ' + s + ' 秒仍没恢复就重启脚本' },
    [PENDING.AUTO_RESUME_AFTER_RESTART]: function (s, p) {
      return '脚本已重启　' + s + ' 秒后自动续播（第 ' + p.attempt + '/' + p.max + ' 次）'
    },
    [PENDING.RESUME_FINAL]: function (s) { return '再等 ' + s + ' 秒仍没恢复就停下' },
    [PENDING.STALLED]: function (s) { return '再等 ' + s + ' 秒没进度就停下' },
  }

  // 一个 tick 里只登记一条等待（决策核心保证），这里只负责把它翻成一句话
  function pendingText(memory) {
    const pending = memory && memory.pending
    if (!pending) return ''
    const template = PENDING_TEXT[pending.kind]
    if (!template) return ''
    const remain = Math.ceil((pending.dueAt - Date.now()) / 1000)
    // 第二个入参是整条 pending：续播阶梯要拼「第 k/N 次」这类数字
    return template(remain > 0 ? remain : 0, pending)
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

    const result = decide(observation, controller.memory)
    controller.memory = result.memory
    // 进度条读的是**判定之后**的记忆：这样倒计时不会慢一拍，
    // 停下时 pending 已被清掉，所以停止文案后面不会挂一条倒计时
    controller.progress = adapter.progressText(controller.memory)

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
    // 停下后的文案不带倒计时：上一次 tick 存下来的那条已经不作数了，重算一遍
    controller.progress = adapter.progressText(null)
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
    PENDING: PENDING,
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
