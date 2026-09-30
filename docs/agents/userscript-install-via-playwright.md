# 用 playwright-cli 安装 / 升级油猴脚本

**面向 agent**：把 `src/*.user.js` 装进 Tampermonkey，并确认页面里跑的是不是当前版本。

给人看的安装步骤在仓库根目录的 [`README.md`](../../README.md)，两份不重合：本文只写自动化那条路，以及几条**必须遵守**的边界。

下面这条流程是 2026-09-28 第七轮实测可靠的。

## 前置

- ⚠️ **所有 `playwright-cli` 命令必须在仓库根目录执行**：`.playwright/cli.config.json` 用相对路径把 profile 指向 `.playwright/profile/`，换目录执行会另开一个空 profile、表现为「没登录」。
- 登录态已持久化，`open` 即复用，**不要**传 `--persistent`。**每一处 `open` 都显式写 `--headed`**（不依赖 CLI 默认值，用户要看着浏览器）。
- 本地静态服务（只监听回环 `http://127.0.0.1:8123`，在仓库根目录 `python -m http.server 8123` 起）—— 下面用它把 `.user.js` 喂给 Tampermonkey。
- 动手前先 `playwright-cli list` 看有没有冲突会话。

## 安装 / 升级的步骤

```bash
# 1. 用户要求：动手前先重启浏览器
playwright-cli -s=xuexitong close
playwright-cli -s=xuexitong open --headed http://127.0.0.1:8123/src/xuexitong-auto-next.user.js

# 2. ⚠️ 必须用 goto（同一个 URL），reload 不够
playwright-cli -s=xuexitong goto http://127.0.0.1:8123/src/xuexitong-auto-next.user.js

# 3. 切到 Tampermonkey 另开的安装标签页，找到并点「重新安装」
#    （goto 会唤起安装页，并另开一个 chrome-extension://…/ask.html 标签页）
playwright-cli -s=xuexitong tab-select 1
playwright-cli -s=xuexitong find "重新安装"
playwright-cli -s=xuexitong click <上一步给出的那个 button 的 ref>

# 4. 点完两个标签页都会关掉，只剩 about:blank；再导航到学习页确认版本
playwright-cli -s=xuexitong goto <学习页 URL>
playwright-cli -s=xuexitong eval "window.__xuexitongAutoNext.VERSION"
```

- **第 2 步是这套流程唯一的坑**：`open` 之后只 `reload`，页面会停在裸 JS 文本上、**不弹安装页**；换成 `goto` 才会唤起 Tampermonkey。
- **第 3 步的 ref 每轮都会变**（本轮是 `e59`），别写死，用 `find` 现取。按钮文案取决于是否已装过：**首次是「安装」，覆盖升级才是「重新安装」**——`find "安装"` 两种都能命中。
- 本仓库没有构建工具链（连 `package.json` 都没有）：脚本就是 `src/xuexitong-auto-next.user.js` 这一个文件，改了它必须走一遍上面的流程才会在页面里生效。
- 确认安装的那条 `eval`：返回 **`"1.8.0"` 这样一串号** = 装的就是这一版（号等于元数据块里的 `@version`，两处一致由 `src/tests/version.test.js` 断言）；**`"undefined"`** = 第八轮及以前的旧版，或脚本没注入（检查 `@match` 与 `isStudyPage()`）。想确认「某个能力在不在」，再查**功能标记**，例如 `typeof (window.__xuexitongAutoNext||{}).CONSTANTS.TREE_RECHECK_GRACE_MS`（`"number"` = 至少第八轮）。
- **本脚本已配 `@updateURL` / `@downloadURL`**，两个字段都指向**发布分支 `main`** 的 raw `.user.js`。于是：上面这套**覆盖安装**照样能用（`develop` 上的改动想在页面里验证，就得靠它，因为篡改猴只会从 `main` 拉更新）；而使用者的升级交给篡改猴自己 —— **发布 = 合入 `main`**，见 [`docs/adr/0012`](../adr/0012-release-branch-and-version-scheme.md)。
- ⚠️ **一条未实证的说法**：本仓库文档原先写「篡改猴面板里的『更新』**只**对 `@updateURL` 生效」。检索到的实际行为是**一条回退链**（`@updateURL` → `@downloadURL` → 安装来源 URL），但官方文档正文是 JS 渲染的、只取到了目录，**改写相关文案之前先真机验一次**，别照抄这一条。

## 装完怎么读页面状态（只读）

状态条在 Shadow DOM 里：

```bash
playwright-cli -s=xuexitong eval "document.getElementById('auto-lesson-status-host').shadowRoot.querySelector('.text').textContent"
```

点它上面那两个按钮（要找 `shadowRoot.querySelectorAll('button')` 里 textContent 为「停止」/「继续」的那个）：

```bash
playwright-cli -s=xuexitong eval "Array.from(document.getElementById('auto-lesson-status-host').shadowRoot.querySelectorAll('button')).map(b=>b.textContent)"
```

要跨 iframe 找媒体、读播放状态，用页面内遍历 `contentDocument` 的普通 `eval`（`eval` 只在浏览器侧求值，`page` 传不进去，`async page => …` 那种文件跑不动）；**多行表达式要合成一行**：

```js
(()=>{const docs=[];const walk=d=>{docs.push(d);try{d.querySelectorAll("iframe").forEach(f=>{try{if(f.contentDocument)walk(f.contentDocument)}catch(e){}})}catch(e){}};walk(document);
let b=null;for(const d of docs){const v=d.querySelector("video");if(v&&isFinite(v.duration)&&v.duration>0)b=v}
const h=document.getElementById("auto-lesson-status-host");
return JSON.stringify({paused:b?b.paused:null,ct:b?Math.round(b.currentTime):null,bar:h?h.shadowRoot.querySelector(".text").textContent:null})})()
```

## 硬边界（别踩）

- ⚠️ **学习页 URL 不写进任何文档，也不提交**（含 `courseId` / `clazzId` / `cpi` / `enc` / `openc` / `chapterId`）——要就现开一个只读 `eval "location.href"` 读，或抄下来之后关掉浏览器。脱敏规则见 [`docs/sites/xuexitong.md`](../sites/xuexitong.md) 与 `.scratch/`。
- ⚠️ **不要 `attach --extension=chrome`**：那会连上日常浏览器的真实登录会话。
- ⚠️ `.playwright/profile/` 里是真实登录 cookie：已 gitignore，**永不提交、永不外传**。
- ⚠️ **用户日常浏览器可能登着同一个账号，多端登录会被判异常学习**（同一个浏览器里另开一个章节页也算，先开的那个会被跳到警告页）。动探查会话前先确认。
- ⚠️ **同时只留一个章节标签页**（用户要求）；需要对比或复读时，先把值读出来，再关掉多余的页。
- 探查产物落在 `.playwright-cli/`，已忽略、不要提交。⚠️ `snapshot --filename=<f>` 是例外——它把文件写到**当前工作目录**，在仓库根执行会污染仓库，用完记得移走或干脆用默认文件名。

## 验证决策核心没坏

```bash
node src/tests/decision.test.js        # 全部；可加过滤词，例如 node src/tests/decision.test.js 续播
```
