// 决策核心的用例 —— 本仓库的唯一测试缝。
//
//   node src/tests/decision.test.js              # 跑全部
//   node src/tests/decision.test.js 暂停          # 只跑名字里含「暂停」的
//
// 零依赖：不用测试运行器、不引入打包器。脚本文件本身是合法 JS（元数据块全是 // 注释），
// 直接丢进一个 vm 上下文加载，取它暴露的调试句柄。
//
// 这里只测外部行为：喂一个观察值 + 一份记忆，断言返回的动作。不碰 DOM、不等真实时间。

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const SCRIPT_PATH = path.join(__dirname, '..', 'xuexitong-auto-next.user.js')
const sandbox = {}
vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(SCRIPT_PATH, 'utf8'), sandbox, { filename: SCRIPT_PATH })

const api = sandbox.__xuexitongAutoNext
if (!api) {
  console.error('没能从脚本里取到 __xuexitongAutoNext 调试句柄')
  process.exit(1)
}

const C = api.CONSTANTS
const A = api.ACTION
const R = api.STOP_REASON
const P = api.PENDING
const NOW = 1700000000000

// ---------------------------------------------------------------- 构造器

function video(id, completed) { return { id: id || 'v1', kind: 'video', completed: !!completed } }
function audio(id, completed) { return { id: id || 'a1', kind: 'audio', completed: !!completed } }
function ppt(id, completed) { return { id: id || 'p1', kind: 'ppt', completed: !!completed } }

function page(over) {
  return Object.assign(
    { hasNext: true, confirmDialogVisible: false, riskControlWarning: false, faceCaptureRequired: false },
    over
  )
}

function media(over) {
  return Object.assign({ key: 'mk1', currentTime: 5, paused: false, ended: false, failed: false }, over)
}

// 章节树（ADR 0010）。unfinished = 树上有未完成计数（真实站点上是 input.jobUnfinishCount 在不在，
// 它含 PPT 且**只有资料附件或空内容的节点没有**）；label 是节点短号，真实值形如 `4.1`。
function treeNode(id, over) {
  return Object.assign({ id: id, label: id, count: null, unfinished: false, current: false }, over)
}
function unfinished(id, over) { return treeNode(id, Object.assign({ count: 1, unfinished: true }, over)) }
function tree(nodes) { return { nodes: nodes } }

function observe(over) {
  return Object.assign({
    now: NOW,
    userStopped: false,
    focus: { lost: false },
    page: page(),
    card: { active: 1, total: 1 }, // 默认「本节点只有一张卡片」，卡片层的用例自己指定
    tree: null,                    // 默认「章节树不可用」= 回退到点下一节的路径
    taskPoints: [video('v1', false)],
    media: null,
  }, over)
}

function memory(over) { return Object.assign(api.initialMemory(), over) }

// 章节树不可用时的回退路径：窗口期已经走完，脚本回到「点下一节」那一套（ADR 0010 保留的那条）
function fallback(over) {
  return Object.assign({ treeUnreadySince: NOW - C.TREE_READY_GRACE_MS }, over || null)
}

// 续播阶梯的账本（docs/adr/0009）：{ key, stage, attempts, dueAt, playingSince }
//   stage 1 = 第一段（最多 5 次）；stage 2 = 重启之后（最多 3 次）
//   attempts === 本段上限 表示「最后一次已发出，正在等它是否生效」
function ladder(over) {
  return Object.assign({ key: 'mk1', stage: 1, attempts: 0, dueAt: NOW, playingSince: null }, over)
}

// ---------------------------------------------------------------- 用例

const CASES = [
  // ---- 直接交给用户的三类 ----
  {
    name: '用户按了停止 → 停下',
    obs: observe({ userStopped: true }),
    expect: { kind: A.STOP, reason: R.USER_STOPPED },
  },
  {
    name: '多端登录风控警告 → 停下',
    obs: observe({ page: page({ riskControlWarning: true }) }),
    expect: { kind: A.STOP, reason: R.LOGIN_RISK_CONTROL },
  },
  {
    name: '课程启用人脸抓拍 → 放弃',
    obs: observe({ page: page({ faceCaptureRequired: true }) }),
    expect: { kind: A.STOP, reason: R.FACE_CAPTURE_COURSE },
  },

  // ---- 本卡片一个任务点都没有（只剩资料附件的节点，ADR 0006）----
  {
    name: '本卡片没有任务点 → 先等窗口期，并开始计时',
    obs: observe({ taskPoints: [] }),
    // 倒计时：窗口期结束就跳过本卡片
    expect: { kind: A.WAIT, pending: P.EMPTY_CARD, pendingDueAt: NOW + C.EMPTY_CARD_GRACE_MS },
    expectMemory: (m) => m.emptyCardSince === NOW,
  },
  {
    name: '本卡片没有任务点、窗口期内 → 继续等，不重置计时',
    obs: observe({ taskPoints: [] }),
    mem: () => memory({ emptyCardSince: NOW - C.EMPTY_CARD_GRACE_MS + 1 }),
    expect: { kind: A.WAIT },
    expectMemory: (m) => m.emptyCardSince === NOW - C.EMPTY_CARD_GRACE_MS + 1,
  },
  {
    name: '本卡片没有任务点、窗口期内 → 不把这笔记进卡片账本',
    obs: observe({ taskPoints: [], card: { active: 1, total: 2 } }),
    expect: { kind: A.WAIT },
    expectMemory: (m) => m.scan === null,
  },
  {
    name: '（回退路径）本卡片没有任务点、窗口期过了、本节点只有这一张卡片 → 点下一节（资料展示节点）',
    obs: observe({ taskPoints: [] }),
    mem: () => memory(fallback({ emptyCardSince: NOW - C.EMPTY_CARD_GRACE_MS })),
    expect: { kind: A.ADVANCE },
  },
  {
    name: '本卡片没有任务点、窗口期过了、还有没扫过的卡片 → 切过去，不推进',
    obs: observe({ taskPoints: [], card: { active: 1, total: 2 } }),
    mem: () => memory({ emptyCardSince: NOW - C.EMPTY_CARD_GRACE_MS }),
    expect: { kind: A.OPEN_TASK_POINT, card: 2 },
  },
  {
    name: '（回退路径）本卡片没有任务点、窗口期过了、卡片已扫遍 → 点下一节',
    obs: observe({ taskPoints: [], card: { active: 2, total: 2 } }),
    mem: () => memory(fallback({
      emptyCardSince: NOW - C.EMPTY_CARD_GRACE_MS,
      scan: { total: 2, visited: [1], sawUnfinished: false },
    })),
    expect: { kind: A.ADVANCE },
  },
  {
    name: '本卡片没有任务点却在弹确认框 → 停下（判定必须排在「空卡片就推进」之前）',
    obs: observe({ taskPoints: [], page: page({ confirmDialogVisible: true }) }),
    expect: { kind: A.STOP, reason: R.DIALOG_WITHOUT_UNFINISHED },
  },

  // ---- 认不出的任务点类型（ADR 0007：与 PPT 同档 —— 脚本播不了，跳过）----
  {
    name: '（回退路径）只剩未完成的认不出类型、本节点只有一张卡片 → 点下一节',
    obs: observe({ taskPoints: [{ id: 'u1', kind: 'unknown', completed: false }] }),
    mem: () => memory(fallback()),
    expect: { kind: A.ADVANCE },
  },
  {
    name: '只剩未完成的认不出类型、平台弹了确认框 → 代为确认推进',
    obs: observe({
      taskPoints: [{ id: 'u1', kind: 'unknown', completed: false }],
      page: page({ confirmDialogVisible: true }),
    }),
    expect: { kind: A.CONFIRM_ADVANCE },
  },
  {
    name: '认不出类型 + 还有没播完的视频 → 先播视频，不跳过',
    obs: observe({ taskPoints: [{ id: 'u1', kind: 'unknown', completed: false }, video('v1', false)] }),
    expect: { kind: A.OPEN_TASK_POINT },
  },
  {
    name: '已完成的任务点认不出类型 → 不拦路',
    obs: observe({ taskPoints: [{ id: 'u1', kind: 'unknown', completed: true }, video('v1', false)] }),
    expect: { kind: A.OPEN_TASK_POINT },
  },

  // ---- 未完成确认框（ADR 0002 / ADR 0005） ----
  {
    name: '确认框 + 只剩 PPT 未完成 → 代为点头确认推进',
    obs: observe({ taskPoints: [video('v1', true), ppt('p1', false)], page: page({ confirmDialogVisible: true }) }),
    expect: { kind: A.CONFIRM_ADVANCE },
  },
  {
    name: '确认框 + 还有没看完的视频 → 停下，不代确认',
    obs: observe({ taskPoints: [video('v1', false), ppt('p1', false)], page: page({ confirmDialogVisible: true }) }),
    expect: { kind: A.STOP, reason: R.MEDIA_INCOMPLETE_CONFIRM },
  },
  {
    name: '确认框 + 读到任务点却都已完成 → 判定不可信，停下',
    obs: observe({ taskPoints: [video('v1', true)], page: page({ confirmDialogVisible: true }) }),
    expect: { kind: A.STOP, reason: R.DIALOG_WITHOUT_UNFINISHED },
  },
  {
    name: '确认框刚点过、还在冷却里 → 不重复点',
    obs: observe({ taskPoints: [ppt('p1', false)], page: page({ confirmDialogVisible: true }) }),
    mem: () => memory({ lastAction: { kind: A.CONFIRM_ADVANCE, at: NOW - 1000 } }),
    expect: { kind: A.WAIT },
  },

  // ---- 媒体异常 ----
  {
    name: '视频加载失败 → 不再立刻停下，先走续播阶梯',
    obs: observe({ media: media({ failed: true }) }),
    // 倒计时：5 秒后自动续播（第 1/5 次）
    expect: { kind: A.WAIT, pending: P.AUTO_RESUME, pendingDueAt: NOW + C.RESUME_INTERVAL_MS },
    expectMemory: (m) => m.resume && m.resume.stage === 1 && m.resume.key === 'mk1',
  },
  {
    name: '加载失败且阶梯用尽 → 停下，原因仍是加载失败',
    obs: observe({ media: media({ failed: true }) }),
    mem: () => memory({ resume: ladder({ stage: 2, attempts: C.RESTART_MAX_ATTEMPTS, dueAt: NOW }) }),
    expect: { kind: A.STOP, reason: R.MEDIA_LOAD_FAILED },
  },
  {
    name: '进度长时间不前进 → 停下',
    obs: observe({ media: media({ currentTime: 5 }) }),
    mem: () => memory({ lastSample: { at: NOW - C.STALL_TIMEOUT_MS, currentTime: 5 } }),
    expect: { kind: A.STOP, reason: R.STALLED },
  },
  {
    name: '进度在前进 → 不误判卡住',
    obs: observe({ media: media({ currentTime: 60 }) }),
    mem: () => memory({ lastSample: { at: NOW - C.STALL_TIMEOUT_MS, currentTime: 5 } }),
    expect: { kind: A.WAIT },
    expectMemory: (m) => m.lastSample.at === NOW && m.lastSample.currentTime === 60,
  },

  // ---- 播完之后等一段再推进 ----
  {
    name: '刚播完 → 先记下时刻并等待',
    obs: observe({ media: media({ ended: true, currentTime: 88 }) }),
    expect: { kind: A.WAIT },
    expectMemory: (m) => m.endedAt === NOW,
  },
  {
    name: '播完但没等够 → 继续等',
    obs: observe({ media: media({ ended: true, currentTime: 88 }) }),
    mem: () => memory({ endedAt: NOW - C.ADVANCE_DELAY_MS + 1 }),
    // 倒计时：等够就继续推进
    expect: { kind: A.WAIT, pending: P.ADVANCE_DELAY, pendingDueAt: NOW + 1 },
    expectMemory: (m) => m.endedAt === NOW - C.ADVANCE_DELAY_MS + 1,
  },
  {
    name: '播完且等够了 → 去找下一个未完成的可播单元',
    obs: observe({ media: media({ ended: true, currentTime: 88 }) }),
    mem: () => memory({ endedAt: NOW - C.ADVANCE_DELAY_MS }),
    expect: { kind: A.OPEN_TASK_POINT },
  },
  {
    name: '（回退路径）播完且等够了、本卡片已无未完成可播 → 点下一节',
    obs: observe({ taskPoints: [video('v1', true)], media: media({ ended: true, currentTime: 88 }) }),
    mem: () => memory(fallback({ endedAt: NOW - C.ADVANCE_DELAY_MS })),
    expect: { kind: A.ADVANCE },
  },

  // ---- 卡片层：同一时刻只有 active 那张卡片的内容在 DOM 里 ----
  {
    name: '卡片内还有下一个未完成的可播任务点 → 卡片内推进，不换卡片',
    obs: observe({ taskPoints: [video('v1', true), video('v2', false)], card: { active: 1, total: 4 }, media: null }),
    expect: { kind: A.OPEN_TASK_POINT, card: null },
    expectMemory: (m) => m.scan === null,
  },
  {
    name: '本卡片没有可播的了、本节点还有卡片没扫过 → 切下一张卡片',
    obs: observe({ taskPoints: [video('v1', true)], card: { active: 1, total: 2 }, media: null }),
    expect: { kind: A.OPEN_TASK_POINT, card: 2 },
    expectMemory: (m) => m.scan && m.scan.visited.length === 1 && m.scan.visited[0] === 1,
  },
  {
    name: '本卡片只剩 PPT、但还有卡片没扫过 → 回到第 1 张卡片接着找，不点下一节',
    obs: observe({ taskPoints: [ppt('p1', false)], card: { active: 2, total: 4 }, media: null }),
    expect: { kind: A.OPEN_TASK_POINT, card: 1 },
  },
  {
    name: '本节点的卡片层认不出来 → 不瞎切卡片、也不点下一节',
    obs: observe({ taskPoints: [ppt('p1', false)], card: { active: 0, total: 0 }, media: null }),
    expect: { kind: A.OPEN_TASK_POINT, card: null },
    expectMemory: (m) => m.scan === null,
  },
  {
    name: '（回退路径）最后一张卡片也扫过、只剩别的卡片里的 PPT → 点下一节',
    obs: observe({ taskPoints: [video('v1', true)], card: { active: 2, total: 2 }, media: null }),
    mem: () => memory(fallback({ scan: { total: 2, visited: [1], sawUnfinished: true } })),
    expect: { kind: A.ADVANCE },
  },
  {
    name: '本节点卡片数变了 → 账本作废，重新扫',
    obs: observe({ taskPoints: [video('v1', true)], card: { active: 1, total: 3 }, media: null }),
    mem: () => memory({ scan: { total: 2, visited: [1, 2], sawUnfinished: true } }),
    expect: { kind: A.OPEN_TASK_POINT },
    expectMemory: (m) => m.scan.total === 3 && m.scan.visited.length === 1,
  },
  {
    name: '确认框 + 扫遍全部卡片、只剩 PPT → 代为点头确认推进',
    obs: observe({
      taskPoints: [video('v1', true)],
      card: { active: 2, total: 2 },
      page: page({ confirmDialogVisible: true }),
    }),
    mem: () => memory({ scan: { total: 2, visited: [1], sawUnfinished: true } }),
    expect: { kind: A.CONFIRM_ADVANCE },
  },
  {
    name: '确认框 + 本节点还有卡片没扫过 → 停下，不代确认',
    obs: observe({
      taskPoints: [video('v1', true)],
      card: { active: 1, total: 2 },
      page: page({ confirmDialogVisible: true }),
    }),
    expect: { kind: A.STOP, reason: R.MEDIA_INCOMPLETE_CONFIRM },
  },
  {
    name: '确认框 + 扫遍全部卡片却一个未完成任务点都没看到 → 停下',
    obs: observe({
      taskPoints: [video('v1', true)],
      card: { active: 2, total: 2 },
      page: page({ confirmDialogVisible: true }),
    }),
    mem: () => memory({ scan: { total: 2, visited: [1], sawUnfinished: false } }),
    expect: { kind: A.STOP, reason: R.DIALOG_WITHOUT_UNFINISHED },
  },

  // ---- 续播阶梯（docs/adr/0009）：暂停/被拒/加载失败不再直接停下 ----
  //      形状：第一段 5 次 → 重启一次脚本 → 第二段 3 次 → 才真正停下；间隔都是 5 秒

  // 起播那一支：首次请求仍然立刻发（被反转的是「之后」）
  {
    name: '还没起播的暂停 → 首次起播请求立刻发出',
    obs: observe({ media: media({ currentTime: 0, paused: true }) }),
    expect: { kind: A.START },
    expectMemory: (m) => m.startRequestedKey === 'mk1',
  },
  {
    name: '换了媒体（key 变了）→ 允许再请求一次起播',
    obs: observe({ media: media({ key: 'mk2', currentTime: 0, paused: true }) }),
    mem: () => memory({ startRequestedKey: 'mk1' }),
    expect: { kind: A.START },
  },
  {
    name: '请求过起播却仍没动 → 改走续播阶梯（不再 6 秒判被拒）',
    obs: observe({ media: media({ currentTime: 0, paused: true }) }),
    mem: () => memory({ startRequestedKey: 'mk1' }),
    // 倒计时：5 秒后自动续播（第 1/5 次）
    expect: { kind: A.WAIT, pending: P.AUTO_RESUME, pendingDueAt: NOW + C.RESUME_INTERVAL_MS },
  },
  {
    name: '起播始终没动、阶梯用尽 → 停下，原因是被拒',
    obs: observe({ media: media({ currentTime: 0, paused: true }) }),
    mem: () => memory({
      startRequestedKey: 'mk1',
      resume: ladder({ stage: 2, attempts: C.RESTART_MAX_ATTEMPTS, dueAt: NOW }),
    }),
    expect: { kind: A.STOP, reason: R.PLAYBACK_REFUSED },
  },

  // 第一段：每 RESUME_INTERVAL_MS 一次，最多 RESUME_MAX_ATTEMPTS 次
  {
    name: '媒体被暂停 → 不再直接停下，先排一次自动续播',
    obs: observe({ media: media({ currentTime: 30, paused: true }) }),
    // 倒计时：5 秒后自动续播（第 1/5 次）
    expect: { kind: A.WAIT, pending: P.AUTO_RESUME, pendingDueAt: NOW + C.RESUME_INTERVAL_MS },
    expectMemory: (m) => m.resume && m.resume.stage === 1 && m.resume.attempts === 0 && m.resume.key === 'mk1',
  },
  {
    name: '失焦后被暂停 → 同样先排自动续播（焦点只在「停下」那一刻用来定原因）',
    obs: observe({ media: media({ currentTime: 30, paused: true }), focus: { lost: true } }),
    expect: { kind: A.WAIT, pending: P.AUTO_RESUME },
  },
  {
    name: '续播到点 → 对当前媒体再按一次播放，并排下一次',
    obs: observe({ media: media({ currentTime: 30, paused: true }) }),
    mem: () => memory({ resume: ladder({ attempts: 0, dueAt: NOW }) }),
    expect: { kind: A.AUTO_RESUME, pending: P.AUTO_RESUME },
    expectMemory: (m) => m.resume.attempts === 1 && m.resume.dueAt === NOW + C.RESUME_INTERVAL_MS,
  },
  {
    name: '续播还没到点 → 原地等，不重复按播放',
    obs: observe({ media: media({ currentTime: 30, paused: true }) }),
    mem: () => memory({ resume: ladder({ attempts: 1, dueAt: NOW + 3000 }) }),
    expect: { kind: A.WAIT, pending: P.AUTO_RESUME, pendingDueAt: NOW + 3000 },
  },
  {
    name: '光标离开窗口那一档（有焦点时的暂停）→ 一样自动续播',
    obs: observe({ media: media({ currentTime: 30, paused: true }) }),
    mem: () => memory({ resume: ladder({ attempts: 1, dueAt: NOW }) }),
    expect: { kind: A.AUTO_RESUME },
  },

  // 成功判据：连续在播满一个间隔才算真的活了 —— 「起了又被按停」不能算成功，
  // 否则平台的播放器守卫（1 秒内按停非令牌持有者）会把 5 次上限悄悄变成无限
  {
    name: '续播后连续在播满一个间隔 → 判定恢复，账本清空',
    obs: observe({ media: media({ currentTime: 35, paused: false }) }),
    mem: () => memory({
      resume: ladder({ attempts: 1, dueAt: NOW + 9999, playingSince: NOW - C.RESUME_INTERVAL_MS }),
    }),
    expect: { kind: A.WAIT, pending: null },
    expectMemory: (m) => m.resume === null,
  },
  {
    name: '连续在播还没满一个间隔 → 账本留着，不提前清零',
    obs: observe({ media: media({ currentTime: 35, paused: false }) }),
    mem: () => memory({ resume: ladder({ attempts: 1, dueAt: NOW + 9999, playingSince: NOW - 1000 }) }),
    expect: { kind: A.WAIT },
    expectMemory: (m) => m.resume && m.resume.attempts === 1 && m.resume.playingSince === NOW - 1000,
  },
  {
    name: '续播后不到一个间隔又被按停 → 不清零，接着消耗名额',
    obs: observe({ media: media({ currentTime: 35, paused: true }) }),
    mem: () => memory({ resume: ladder({ attempts: 1, dueAt: NOW, playingSince: NOW - 2000 }) }),
    expect: { kind: A.AUTO_RESUME, pending: P.AUTO_RESUME },
    expectMemory: (m) => m.resume.attempts === 2 && m.resume.playingSince === null,
  },
  {
    name: '没有阶梯时在播 → 不建立账本',
    obs: observe({ media: media({ currentTime: 31, paused: false }) }),
    expect: { kind: A.WAIT },
    expectMemory: (m) => m.resume === null,
  },
  {
    name: '换了媒体 → 续播账本重新开一轮（另一条媒体另有 5 次）',
    obs: observe({ media: media({ key: 'mk2', currentTime: 30, paused: true }) }),
    mem: () => memory({ resume: ladder({ key: 'mk1', attempts: 4, dueAt: NOW }) }),
    expect: { kind: A.WAIT, pending: P.AUTO_RESUME, pendingDueAt: NOW + C.RESUME_INTERVAL_MS },
    expectMemory: (m) => m.resume.key === 'mk2' && m.resume.stage === 1 && m.resume.attempts === 0,
  },
  {
    name: '阶梯中途媒体消失 → 账本留着，不被当成新的一轮',
    obs: observe({ taskPoints: [video('v1', false)], media: null }),
    mem: () => memory({ resume: ladder({ attempts: 3, dueAt: NOW - 5000 }) }),
    expect: { kind: A.OPEN_TASK_POINT },
    expectMemory: (m) => m.resume && m.resume.attempts === 3,
  },

  // 第一段用尽 → 重启一次脚本
  {
    name: '第一段 5 次用尽 → 倒计时「再等 N 秒仍没恢复就重启脚本」',
    obs: observe({ media: media({ currentTime: 30, paused: true }) }),
    mem: () => memory({ resume: ladder({ attempts: C.RESUME_MAX_ATTEMPTS, dueAt: NOW + 2000 }) }),
    expect: { kind: A.WAIT, pending: P.RESUME_RESTART, pendingDueAt: NOW + 2000 },
  },
  {
    name: '第一段用尽到点 → 重启脚本：重置时间基准、保住推进记忆、进入第二段',
    obs: observe({ media: media({ currentTime: 30, paused: true }) }),
    mem: () => memory({
      resume: ladder({ attempts: C.RESUME_MAX_ATTEMPTS, dueAt: NOW }),
      unreadySince: NOW - 10000,
      lastAction: { kind: A.ADVANCE, at: NOW - 1000 },
      advanceSignature: 'v11',
      jumpRequested: { id: 'n9', at: NOW - 1000 },
    }),
    // 重启那一刻先再播一次，并把第二段第 1 次排在一个间隔之后
    expect: { kind: A.AUTO_RESUME, pending: P.AUTO_RESUME_AFTER_RESTART, pendingDueAt: NOW + C.RESUME_INTERVAL_MS },
    expectMemory: (m) => m.resume.stage === 2 && m.resume.attempts === 0 && m.resume.key === 'mk1' &&
      m.unreadySince === null &&
      !!m.lastAction && m.lastAction.kind === A.ADVANCE &&
      m.advanceSignature === 'v11' &&
      !!m.jumpRequested && m.jumpRequested.id === 'n9',
  },

  // 第二段：重启之后再试 RESTART_MAX_ATTEMPTS 次，然后才真正停下
  {
    name: '第二段到点 → 再按一次播放，倒计时报第 k/3 次',
    obs: observe({ media: media({ currentTime: 30, paused: true }) }),
    mem: () => memory({ resume: ladder({ stage: 2, attempts: 0, dueAt: NOW }) }),
    expect: { kind: A.AUTO_RESUME, pending: P.AUTO_RESUME_AFTER_RESTART },
    expectMemory: (m) => m.resume.stage === 2 && m.resume.attempts === 1,
  },
  {
    name: '第二段 3 次用尽 → 倒计时「再等 N 秒仍没恢复就停下」',
    obs: observe({ media: media({ currentTime: 30, paused: true }) }),
    mem: () => memory({ resume: ladder({ stage: 2, attempts: C.RESTART_MAX_ATTEMPTS, dueAt: NOW + 4000 }) }),
    expect: { kind: A.WAIT, pending: P.RESUME_FINAL, pendingDueAt: NOW + 4000 },
  },
  {
    name: '第二段用尽到点 → 真正停下，原因记为「播放被暂停」',
    obs: observe({ media: media({ currentTime: 30, paused: true }) }),
    mem: () => memory({ resume: ladder({ stage: 2, attempts: C.RESTART_MAX_ATTEMPTS, dueAt: NOW }) }),
    expect: { kind: A.STOP, reason: R.MANUAL_PAUSE },
  },
  {
    name: '第二段用尽到点、此刻仍失焦 → 原因记为「失焦暂停」',
    obs: observe({ media: media({ currentTime: 30, paused: true }), focus: { lost: true } }),
    mem: () => memory({ resume: ladder({ stage: 2, attempts: C.RESTART_MAX_ATTEMPTS, dueAt: NOW }) }),
    expect: { kind: A.STOP, reason: R.FOCUS_LOST_PAUSE },
  },

  // ---- 回退路径的推进与结束（章节树不可用；ADR 0010 只把它留作回退）----
  {
    name: '（回退路径）没有可播任务点、还有下一节 → 点下一节',
    obs: observe({ taskPoints: [video('v1', true), ppt('p1', true)] }),
    mem: () => memory(fallback()),
    expect: { kind: A.ADVANCE },
  },
  {
    name: '（回退路径）只剩 PPT 未完成、还没弹确认框 → 直接点下一节',
    obs: observe({ taskPoints: [video('v1', true), ppt('p1', false)] }),
    mem: () => memory(fallback()),
    expect: { kind: A.ADVANCE },
  },
  {
    name: '（回退路径）只剩 PPT 未完成、页面已到末尾 → 判定整门课跑完',
    obs: observe({ taskPoints: [ppt('p1', false)], page: page({ hasNext: false }) }),
    mem: () => memory(fallback()),
    expect: { kind: A.STOP, reason: R.COURSE_COMPLETED },
  },
  {
    name: '（回退路径）全部完成、还有下一节 → 点下一节',
    obs: observe({ taskPoints: [video('v1', true), audio('a1', true)] }),
    mem: () => memory(fallback()),
    expect: { kind: A.ADVANCE },
  },
  {
    name: '（回退路径）页面没变化时 → 不重复点下一节',
    obs: observe({ taskPoints: [video('v1', true)] }),
    mem: () => memory(fallback({ advanceSignature: 'v11', lastAction: { kind: A.ADVANCE, at: NOW - 1000 } })),
    // 倒计时：页面没变时的冷却更长，照 8 秒算
    expect: { kind: A.WAIT, pending: P.ADVANCE_COOLDOWN, pendingDueAt: NOW - 1000 + C.ADVANCE_REPEAT_GUARD_MS },
  },
  {
    name: '（回退路径）页面变了（任务点签名不同）→ 立刻允许推进',
    obs: observe({ taskPoints: [video('v1', true)] }),
    mem: () => memory(fallback({ advanceSignature: 'v10', lastAction: { kind: A.ADVANCE, at: NOW - 1000 } })),
    expect: { kind: A.ADVANCE },
  },
  {
    name: '（回退路径）页面迟迟没反应且等够了 → 允许再点一次下一节',
    obs: observe({ taskPoints: [video('v1', true)] }),
    mem: () => memory(fallback({
      advanceSignature: 'v11',
      lastAction: { kind: A.ADVANCE, at: NOW - C.ADVANCE_REPEAT_GUARD_MS },
    })),
    expect: { kind: A.ADVANCE },
  },

  // ---- 章节树：只向前跳到「当前节点之后第一个未完成节点」（docs/adr/0010）----
  //      这一组的场面就是用户报的那一个：打开一个早已做完的节点，应当**只跳一次**就到位
  {
    name: '章节树：当前节点已完成、后面还有未完成节点 → 跳到它',
    obs: observe({
      taskPoints: [video('v1', true)],
      tree: tree([treeNode('n1', { current: true }), treeNode('n1b'), unfinished('n2')]),
    }),
    expect: { kind: A.JUMP_NODE, nodeId: 'n2' },
    expectMemory: (m) => !!m.jumpRequested && m.jumpRequested.id === 'n2' && m.jumpRequested.at === NOW,
  },
  {
    name: '章节树：本节点只剩已完成的任务点 → 不去按它的播放键，直接跳走',
    obs: observe({
      taskPoints: [video('v1', true)],
      media: media({ currentTime: 0, paused: true }),
      tree: tree([treeNode('n1', { current: true }), unfinished('n2')]),
    }),
    expect: { kind: A.JUMP_NODE, nodeId: 'n2' },
  },
  {
    // docs/adr/0011：平台的「判定完成」可以早于媒体 ended（实测 489 秒的视频在 437 秒就戴上了
    // ans-job-finished，还剩 53 秒）。那一刻本节点已经没有可播单元，但媒体还在播 ——
    // 当场走不但少看一截，还会正好撞进「树还没刷新」的那几秒
    name: '本节点只剩已完成的任务点、但媒体还在播 → 等它播完，不离开节点',
    obs: observe({
      taskPoints: [video('v1', true)],
      media: media({ currentTime: 437, paused: false, ended: false }),
      tree: tree([unfinished('n1', { current: true }), unfinished('n2')]),
    }),
    expect: { kind: A.WAIT, pending: null },
    expectMemory: (m) => m.jumpRequested === null && m.treeMismatch === null,
  },
  {
    name: '同上：媒体播到 ended → 才走「播完固定等一段」那条路',
    obs: observe({
      taskPoints: [video('v1', true)],
      media: media({ currentTime: 489, paused: false, ended: true }),
      tree: tree([unfinished('n1', { current: true }), unfinished('n2')]),
    }),
    expect: { kind: A.WAIT, pending: P.ADVANCE_DELAY, pendingDueAt: NOW + C.ADVANCE_DELAY_MS },
  },
  {
    name: '同上：进度长时间不前进 → 仍按「卡住」停下（这条等待不会无限吊着）',
    obs: observe({
      taskPoints: [video('v1', true)],
      media: media({ currentTime: 437, paused: false, ended: false }),
      tree: tree([unfinished('n1', { current: true }), unfinished('n2')]),
    }),
    mem: () => memory({ lastSample: { at: NOW - C.STALL_TIMEOUT_MS, currentTime: 437 } }),
    expect: { kind: A.STOP, reason: R.STALLED },
  },
  {
    name: '章节树：当前节点自己还有可播的未完成任务点 → 就地播，不跳',
    obs: observe({
      taskPoints: [video('v1', false)],
      tree: tree([unfinished('n1', { current: true }), unfinished('n2')]),
    }),
    expect: { kind: A.OPEN_TASK_POINT },
    expectMemory: (m) => m.jumpRequested === null,
  },
  {
    name: '章节树说还有未完成、脚本一个未完成的都没采到 → 先给一个复查窗口，不立刻停',
    obs: observe({
      taskPoints: [video('v1', true)],
      tree: tree([unfinished('n1', { current: true }), unfinished('n2')]),
    }),
    // 倒计时：窗口走完仍不一致才认「判定不可信」（docs/adr/0011）
    expect: { kind: A.WAIT, pending: P.TREE_UNFINISHED_MISMATCH, pendingDueAt: NOW + C.TREE_RECHECK_GRACE_MS },
    expectMemory: (m) => !!m.treeMismatch && m.treeMismatch.nodeId === 'n1' && m.treeMismatch.since === NOW,
  },
  {
    name: '同一个节点、复查窗口还没走完 → 继续等，不重置计时',
    obs: observe({
      taskPoints: [video('v1', true)],
      tree: tree([unfinished('n1', { current: true }), unfinished('n2')]),
    }),
    mem: () => memory({ treeMismatch: { nodeId: 'n1', since: NOW - C.TREE_RECHECK_GRACE_MS + 1 } }),
    expect: { kind: A.WAIT, pending: P.TREE_UNFINISHED_MISMATCH },
    expectMemory: (m) => m.treeMismatch.since === NOW - C.TREE_RECHECK_GRACE_MS + 1,
  },
  {
    name: '复查窗口是对着节点算的：换了节点就重新计时（旧账不作数）',
    obs: observe({
      taskPoints: [video('v1', true)],
      tree: tree([unfinished('n1', { current: true }), unfinished('n2')]),
    }),
    mem: () => memory({ treeMismatch: { nodeId: 'n0', since: NOW - C.TREE_RECHECK_GRACE_MS } }),
    expect: { kind: A.WAIT, pending: P.TREE_UNFINISHED_MISMATCH, pendingDueAt: NOW + C.TREE_RECHECK_GRACE_MS },
    expectMemory: (m) => m.treeMismatch.nodeId === 'n1' && m.treeMismatch.since === NOW,
  },
  {
    name: '复查窗口里树刷新了（当前节点已无未完成计数）→ 正常跳走，并把账本清掉',
    obs: observe({
      taskPoints: [video('v1', true)],
      tree: tree([treeNode('n1', { current: true }), unfinished('n2')]),
    }),
    mem: () => memory({ treeMismatch: { nodeId: 'n1', since: NOW - 1000 } }),
    expect: { kind: A.JUMP_NODE, nodeId: 'n2' },
    expectMemory: (m) => m.treeMismatch === null,
  },
  {
    name: '章节树说还有未完成、一个未完成的都没采到、复查窗口也走完了 → 停下',
    obs: observe({
      taskPoints: [video('v1', true)],
      tree: tree([unfinished('n1', { current: true }), unfinished('n2')]),
    }),
    mem: () => memory({ treeMismatch: { nodeId: 'n1', since: NOW - C.TREE_RECHECK_GRACE_MS } }),
    expect: { kind: A.STOP, reason: R.TREE_UNFINISHED_NOT_FOUND },
    expectMemory: (m) => m.pending === null,
  },
  {
    name: '章节树说还有未完成、但采到的都是脚本播不了的（PPT）→ 允许跳过',
    obs: observe({
      taskPoints: [video('v1', true), ppt('p1', false)],
      tree: tree([unfinished('n1', { current: true }), unfinished('n2')]),
    }),
    expect: { kind: A.JUMP_NODE, nodeId: 'n2' },
  },
  {
    name: '章节树：当前节点之后没有未完成节点了 → 判定结束',
    obs: observe({
      taskPoints: [video('v1', true)],
      tree: tree([treeNode('n1', { current: true }), treeNode('n2')]),
    }),
    expect: { kind: A.STOP, reason: R.COURSE_COMPLETED },
  },
  {
    name: '章节树：未完成的节点在当前节点之前 → 不回头，判定结束',
    obs: observe({
      taskPoints: [video('v1', true)],
      tree: tree([unfinished('n0'), treeNode('n1', { current: true })]),
    }),
    expect: { kind: A.STOP, reason: R.COURSE_COMPLETED },
  },
  {
    name: '章节树认不出当前节点 → 当树不可用，先等窗口期',
    obs: observe({ taskPoints: [video('v1', true)], tree: tree([unfinished('n2')]) }),
    expect: { kind: A.WAIT, pending: P.TREE_NOT_READY },
    expectMemory: (m) => m.treeUnreadySince === NOW,
  },
  {
    name: '章节树拿不到 → 先等窗口期，到点才改用「下一节」',
    obs: observe({ taskPoints: [video('v1', true)] }),
    // 倒计时：窗口期结束就改用下一节推进
    expect: { kind: A.WAIT, pending: P.TREE_NOT_READY, pendingDueAt: NOW + C.TREE_READY_GRACE_MS },
    expectMemory: (m) => m.treeUnreadySince === NOW,
  },
  {
    name: '章节树拿不到、窗口期还没走完 → 继续等，不重置计时',
    obs: observe({ taskPoints: [video('v1', true)] }),
    mem: () => memory({ treeUnreadySince: NOW - C.TREE_READY_GRACE_MS + 1 }),
    expect: { kind: A.WAIT, pending: P.TREE_NOT_READY },
    expectMemory: (m) => m.treeUnreadySince === NOW - C.TREE_READY_GRACE_MS + 1,
  },
  {
    name: '同一个目标只跳一次：还没到位时不重复点，改报「再等 N 秒没动静就停下」',
    obs: observe({
      taskPoints: [video('v1', true)],
      tree: tree([treeNode('n1', { current: true }), unfinished('n2')]),
    }),
    mem: () => memory({ jumpRequested: { id: 'n2', at: NOW - 2000 } }),
    expect: { kind: A.WAIT, pending: P.UNREADY, pendingDueAt: NOW - 2000 + C.UNREADY_TIMEOUT_MS },
    expectMemory: (m) => !!m.jumpRequested && m.jumpRequested.id === 'n2',
  },
  {
    name: '跳节点之后当前节点一直没变成目标 → 到点停下（沿用「一直没找到」那一条）',
    obs: observe({
      taskPoints: [video('v1', true)],
      tree: tree([treeNode('n1', { current: true }), unfinished('n2')]),
    }),
    mem: () => memory({ jumpRequested: { id: 'n2', at: NOW - C.UNREADY_TIMEOUT_MS } }),
    expect: { kind: A.STOP, reason: R.MEDIA_NOT_FOUND },
  },
  {
    name: '跳节点已经到位（当前节点就是目标）→ 把那一笔划掉，接着跳下一个',
    obs: observe({
      taskPoints: [video('v1', true)],
      tree: tree([treeNode('n1', { current: true }), unfinished('n2')]),
    }),
    mem: () => memory({ jumpRequested: { id: 'n1', at: NOW - 2000 } }),
    expect: { kind: A.JUMP_NODE, nodeId: 'n2' },
    expectMemory: (m) => !!m.jumpRequested && m.jumpRequested.id === 'n2',
  },
  {
    name: '刚跳过、还在冷却里 → 不重复跳（报「N 秒后重试跳转」）',
    obs: observe({
      taskPoints: [video('v1', true)],
      tree: tree([treeNode('n1', { current: true }), unfinished('n2')]),
    }),
    mem: () => memory({ lastAction: { kind: A.JUMP_NODE, at: NOW - 1000 } }),
    expect: { kind: A.WAIT, pending: P.ADVANCE_COOLDOWN, pendingDueAt: NOW - 1000 + C.ACTION_COOLDOWN_MS },
  },
  {
    name: '播完等一段、下一步确实要跳节点 → 倒计时带上目标短号',
    obs: observe({
      taskPoints: [video('v1', true)],
      media: media({ ended: true, currentTime: 88 }),
      tree: tree([treeNode('n1', { current: true }), unfinished('n2', { label: '4.1' })]),
    }),
    mem: () => memory({ endedAt: NOW - C.ADVANCE_DELAY_MS + 1 }),
    expect: { kind: A.WAIT, pending: P.ADVANCE_DELAY, pendingDueAt: NOW + 1 },
    expectMemory: (m) => !!m.pending && m.pending.label === '4.1',
  },
  {
    name: '播完等一段、后面没有要跳的节点 → 倒计时不带短号',
    obs: observe({
      taskPoints: [video('v1', true)],
      media: media({ ended: true, currentTime: 88 }),
      tree: tree([treeNode('n1', { current: true })]),
    }),
    mem: () => memory({ endedAt: NOW - C.ADVANCE_DELAY_MS + 1 }),
    expect: { kind: A.WAIT, pending: P.ADVANCE_DELAY },
    expectMemory: (m) => !!m.pending && m.pending.label === null,
  },

  // ---- 打开任务点 ----
  {
    name: '有未完成视频但还没打开 → 打开任务点',
    obs: observe({ taskPoints: [video('v1', false)], media: null }),
    expect: { kind: A.OPEN_TASK_POINT },
  },
  {
    name: '任务点已打开但一直等不到媒体 → 停下',
    obs: observe({ taskPoints: [video('v1', false)], media: null }),
    mem: () => memory({ unreadySince: NOW - C.UNREADY_TIMEOUT_MS }),
    expect: { kind: A.STOP, reason: R.MEDIA_NOT_FOUND },
  },
  {
    name: '已完成的媒体不影响选择：优先第一个未完成',
    obs: observe({ taskPoints: [video('v1', true), video('v2', false)], media: null }),
    expect: { kind: A.OPEN_TASK_POINT },
  },
  {
    name: '音频任务点走同一条路径',
    obs: observe({ taskPoints: [audio('a1', false)], media: null }),
    expect: { kind: A.OPEN_TASK_POINT },
  },

  // ---- 等待倒计时（每条 PENDING 都要有用例，理由与停止原因同款）----
  {
    name: '等页面交出可播单元 → 倒计时「再等 N 秒没动静就停下」',
    obs: observe({ taskPoints: [video('v1', false)], media: null }),
    mem: () => memory({
      unreadySince: NOW - 5000,
      lastAction: { kind: A.OPEN_TASK_POINT, at: NOW - 1000 }, // 定位动作还在冷却里
    }),
    expect: { kind: A.WAIT, pending: P.UNREADY, pendingDueAt: NOW - 5000 + C.UNREADY_TIMEOUT_MS },
  },
  {
    name: '进度停顿 → 倒计时「再等 N 秒没进度就停下」',
    obs: observe({ media: media({ currentTime: 5, paused: false }) }),
    mem: () => memory({ lastSample: { at: NOW - 3000, currentTime: 5 } }),
    expect: { kind: A.WAIT, pending: P.STALLED, pendingDueAt: NOW - 3000 + C.STALL_TIMEOUT_MS },
  },

  // ---- 什么都不用做 ----
  {
    name: '正在播 → 什么都不做',
    obs: observe({ media: media({ currentTime: 12, paused: false }) }),
    // 正常播放不报「会停下」的倒计时（进度每次采样都在前进）
    expect: { kind: A.WAIT, pending: null },
  },
  {
    name: '同一观察值重复判定 → 动作一致（幂等）',
    obs: observe({ media: media({ currentTime: 12, paused: false }) }),
    twice: true,
    expect: { kind: A.WAIT },
  },
]

// ---------------------------------------------------------------- 跑

const filter = process.argv[2]
const cases = filter ? CASES.filter((c) => c.name.indexOf(filter) >= 0) : CASES

let passed = 0
const failures = []

for (const testCase of cases) {
  const mem = testCase.mem ? testCase.mem() : undefined
  const obs = testCase.obs
  const frozen = mem ? JSON.stringify(mem) : null
  let result
  try {
    result = api.decide(obs, mem)
  } catch (error) {
    failures.push(testCase.name + '\n    抛异常：' + error.message)
    continue
  }

  const problems = []
  const action = result.action
  if (action.kind !== testCase.expect.kind) {
    problems.push('动作应为 ' + testCase.expect.kind + '，实际 ' + action.kind)
  }
  if (testCase.expect.reason && action.reason !== testCase.expect.reason) {
    problems.push('停止原因应为 ' + testCase.expect.reason + '，实际 ' + action.reason)
  }
  // expect.card：动作要求切到哪张卡片（null = 明确要求不切卡片，保持在本卡片内）
  if (testCase.expect.card !== undefined) {
    const actualCard = action.card === undefined ? null : action.card
    if (actualCard !== testCase.expect.card) {
      problems.push('该切到的卡片应为 ' + testCase.expect.card + '，实际 ' + actualCard)
    }
  }
  // expect.pending：这一次等待该报哪条倒计时（null = 明确要求不报）
  if (testCase.expect.pending !== undefined) {
    const actualPending = result.memory.pending ? result.memory.pending.kind : null
    if (actualPending !== testCase.expect.pending) {
      problems.push('倒计时应为 ' + testCase.expect.pending + '，实际 ' + actualPending)
    }
  }
  if (testCase.expect.pendingDueAt !== undefined) {
    const actualDueAt = result.memory.pending ? result.memory.pending.dueAt : null
    if (actualDueAt !== testCase.expect.pendingDueAt) {
      problems.push('倒计时到期时刻应为 ' + testCase.expect.pendingDueAt + '，实际 ' + actualDueAt)
    }
  }
  if (testCase.expectMemory && !testCase.expectMemory(result.memory)) {
    problems.push('记忆不符：' + JSON.stringify(result.memory))
  }
  if (testCase.twice) {
    const again = api.decide(obs, mem)
    if (again.action.kind !== action.kind) {
      problems.push('第二次判定动作不同：' + action.kind + ' vs ' + again.action.kind)
    }
  }
  if (frozen !== null && JSON.stringify(mem) !== frozen) {
    problems.push('输入的记忆被改写了（不再是纯函数）')
  }

  if (problems.length === 0) passed += 1
  else failures.push(testCase.name + '\n    ' + problems.join('\n    '))
}

// 元测试：每条停止原因都必须有用例，避免新增异常类型时漏测
const covered = new Set(CASES.map((c) => c.expect.reason).filter(Boolean))
const uncovered = Object.keys(R)
  .map((key) => R[key])
  .filter((reason) => !covered.has(reason))

// 元测试：每条等待（PENDING）也同样必须有用例 —— 漏掉一个分支的倒计时，
// 症状与用户抱怨的「看不出脚本在干什么」一模一样，只有自检拦得住
const coveredPending = new Set(CASES.map((c) => c.expect.pending).filter(Boolean))
const uncoveredPending = Object.keys(P)
  .map((key) => P[key])
  .filter((kind) => !coveredPending.has(kind))

console.log('用例：' + passed + '/' + cases.length + ' 通过' + (filter ? '（过滤：' + filter + '）' : ''))
if (failures.length) {
  console.log('\n失败：')
  for (const failure of failures) console.log('  · ' + failure)
}
if (uncovered.length) {
  console.log('\n没有被任何用例覆盖的停止原因：' + uncovered.join(', '))
}
if (uncoveredPending.length) {
  console.log('\n没有被任何用例覆盖的等待（倒计时）：' + uncoveredPending.join(', '))
}

process.exit(failures.length === 0 && uncovered.length === 0 && uncoveredPending.length === 0 ? 0 : 1)
