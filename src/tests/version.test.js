// 版本一致性检查 —— 交付机制里两处手工同步由这里兜住（docs/adr/0012、docs/adr/0013）。
//
//   node src/tests/version.test.js
//
// 版本号写在两个地方，仓库没有构建链、只能手工同步，而漏改任何一处都是**静默事故**：
//   · 元数据块的 @version 漏改 —— Tampermonkey 判「无变化」，使用者永远收不到这一版；
//   · 脚本内的 SCRIPT_VERSION 漏改 —— 页面里问「装的是哪一版」得到的答案是假的，
//     真机验证时也就分不清跑的是不是工作区里这一份。
// 零依赖：只读脚本文件本身，不起 vm、不碰 DOM、不联网。

const fs = require('node:fs')
const path = require('node:path')

const SCRIPT_PATH = path.join(__dirname, '..', 'xuexitong-auto-next.user.js')
const source = fs.readFileSync(SCRIPT_PATH, 'utf8')

const metaVersion = (source.match(/^\/\/\s*@version\s+(\S+)\s*$/m) || [])[1] || null
const mirrorVersion = (source.match(/^\s*const SCRIPT_VERSION\s*=\s*'([^']+)'\s*$/m) || [])[1] || null

const problems = []
if (!metaVersion) problems.push('元数据块里找不到 @version')
if (!mirrorVersion) problems.push('脚本里找不到 const SCRIPT_VERSION')

if (metaVersion && mirrorVersion && metaVersion !== mirrorVersion) {
  problems.push('两处版本号不一致：@version = ' + metaVersion + '，SCRIPT_VERSION = ' + mirrorVersion)
}

// 纯数字点分是硬要求：Tampermonkey 只可靠地比较这种格式（docs/adr/0012）
if (metaVersion && !/^\d+(\.\d+)+$/.test(metaVersion)) {
  problems.push('@version 不是纯数字点分格式（Tampermonkey 会比较不出来）：' + metaVersion)
}

console.log('版本一致性：' + (problems.length ? '不通过' : '通过') +
  '（@version = ' + metaVersion + '，SCRIPT_VERSION = ' + mirrorVersion + '）')
for (const problem of problems) console.log('  · ' + problem)

process.exit(problems.length ? 1 : 0)
