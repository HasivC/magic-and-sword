# 桌面壳（Electron）：能跑起来的 .exe

- **日期**：2026-09-21
- **触发**：玩家

  > 预留联机方案和框架就行，现在要做的是可行的exe

  两条分开处理：
  - **联机**：只预留（方案 + 插入点写下来，**不写占位代码**）
  - **.exe**：这一轮做出来

- **动了哪些文件**
  - **新**：`desktop/`（`package.json` / `main.js` / `launch.mjs` / `tsconfig.json`）
  - 改：`technique-system/package.json`（加 `npm run desktop`）
  - 文档：`docs/desktop.md`（怎么用）、`docs/lan-feasibility.md`（新增"预留：插在哪几处"）

---

## 一、联机：只预留，而且**不写占位代码**

玩家定的：联机方案和框架预留，先做 exe。

⚠ 这里有个**这个项目自己的规矩**挡着，我按它办的：
[`framework-audit.md`](../framework-audit.md) 把"声明了但没人用的东西"（惰性字段）列为**最危险的一类** ——
`locks` / `homing` / `StatusDef.vfx` 当年都是"写上了、没人读"，害人查了很久。

所以"预留"做的是：

1. 把**插入点**一条条写进 `lan-feasibility.md`（哪个文件、哪个函数、现在什么状态、将来怎么改）
2. **保持那两条纪律**（`src/sim` 不许 `Date`/`Math.random`；数学只用 IEEE 精确的）——
   它们不是形式主义，是联机的前提，而且**有测试自动盯着**
3. **不新增** `net/` 空壳、不新增 `if (multiplayer)` 这种分支

具体插入点（详见那份文件）：

| 将来要动 | 在哪 | 现在 |
| --- | --- | --- |
| 输入来源（本地 → 也可以来自网络） | `web/src/main.ts` 的 `applyInput()` | 只做"把键鼠写进实体" |
| 谁是权威 | 现在每端各自 `stepWorld()` | 锁步不动它；主机权威时挪进壳的主进程 |
| 内容哈希握手 | 加载完内容之后 | **要加** |
| 哈希比对（不同步检测） | `snapshot()` 已有 | 只差"每 N tick 交换一次" |
| "只有一个人类" | `src/scenario.ts` 的校验 | 联机时放宽 |
| 本地会话概念 | `paused` / `restart()` / 血契跨局 | 联机时"房主说了算" |
| 传输层 | **壳的主进程** | 空着（将来的 UDP/TCP 开这儿） |

## 二、.exe：壳怎么搭的

```
technique-system/desktop/
  package.json     自己一份依赖（Electron / electron-builder）——**不污染游戏本体**
  main.js          主进程：自定义协议 app:// + 窗口 + 快捷键 + 单实例锁
  launch.mjs       一条命令串起来：编客户端 → 编资源映射 → 起 Electron
  tsconfig.json    只编 src/server/assets.ts（壳复用它，不重写一遍映射）
  build/assets.js  上面那份的产物
  out/             portable .exe 出来放这儿
```

**关键设计（都有理由，见 `docs/desktop.md`）**：

| 决定 | 为什么 |
| --- | --- |
| 用**自定义协议** `app://`，不起本地 HTTP | 本地 HTTP 在 Windows 上会弹防火墙询问，还要处理端口冲突；自定义协议直接读磁盘，**客户端一行都不用改** |
| 资源映射**复用** `src/server/assets.ts` | 两边各写一份的表现是"开发时好好的，打包版 404" |
| 壳是 **CommonJS 的 .js**，不是 .ts | 壳跑在 Electron 自己的 Node 里，版本不由我们定 —— 依赖"能擦除类型"会在换版本时炸 |
| 客户端没编译时**显示一句人话** | 不是白屏。壳会检查 `web/dist/.../main.js` 在不在 |
| 渲染进程的 `console` 转发到 stdout | 不然"页面上什么都没发生"在打包版里完全不可见 |
| 快捷键自己接（`F11` / `Ctrl+R` / `Ctrl+Shift+I`） | 没有菜单栏 |
| `contextIsolation: true` + `nodeIntegration: false` + `sandbox: true` | 客户端是纯浏览器代码，按最严的来 |
| 单实例锁 | 点两次图标不要开两个窗口（联机以后更是一进程一身份） |

## 三、装 Electron / 打包：踩到的三个坑（都修好并写进文档了）

| 坑 | 现象 | 解法 |
| --- | --- | --- |
| **npm 缓存写用户目录被拦** | `rejected by your operating system` | 三个缓存目录都挪进工作区：`npm_config_cache` / `ELECTRON_CACHE` / `ELECTRON_BUILDER_CACHE` |
| **npm 11 默认不跑 postinstall** | 装完 404 个包，但**没有 `electron.exe`**（它把 `electron@33` 的 postinstall 列为"未放行"） | `node desktop/node_modules/electron/install.js`（或 `npm install-scripts approve electron`） |
| **二进制从 GitHub 下不下来** | `ECONNRESET` / TLS 报错 | 换镜像 `ELECTRON_MIRROR` + `ELECTRON_BUILDER_BINARIES_MIRROR`（npmmirror）→ 180MB 40 秒下完 |
| **`--win portable` 建符号链接失败** | `Cannot create symbolic link ... libcrypto.dylib`（`winCodeSign` 里的 macOS 符号链接要开发者模式/管理员） | 先出 `--win dir`（不需要签名工具）；单文件那个等开了开发者模式再打 |

⚠ 还有一条**不是坑、是沙箱**：`electron.exe` 在受限会话里起不来
（`crashpad_client_win.cc: not connected` —— crashpad 要用**命名管道**，受限模式明令禁止）。
**玩家正常双击不受影响** ✓。

## 四、产物（实测）

```
desktop/out/win-unpacked/
  MagicAndSword.exe        180 MB（Electron 本体，从 electron.exe 改名）
  resources/app/           壳自己的代码（main.js + build/）—— 有它就能跑
  resources/content/…      内容 ✓
  resources/web/dist/…     客户端编译产物 ✓
  resources/schema/…       说明书（仓库根那份，可选）
```

打包**不用 electron-builder**（它在这台机器上过不去，见第五节），
用自己写的 `desktop/pack.mjs`：按 Electron 要的布局拷三份 + 改名 + 写三行 package.json，
**每一步自检**（缺哪样当场报，不等到双击白屏）。

## 五、⚠ 第一个 .exe 是**坏的**（诚实记录）

给玩家打出来的第一个 .exe，他装上之后是：

> 进去后提示找不到 manifest.json，failed to fetch

**窗口本身是好的**（标题都对），坏的是**页面里所有 `fetch`**。根因是我选了自定义协议：

| 原因 | 说明 |
| --- | --- |
| 自定义协议要**登记特权** | 没写 `protocol.registerSchemesAsPrivileged({ supportFetchAPI: true, … })` 时，`fetch('app://…')` 一律失败 |
| ⚠ **localStorage 按 origin 分** | `scheme + host + port` 才是 origin。自定义协议的 origin 是实现细节；而 `http://127.0.0.1:<固定端口>` 稳定 —— **存档才有地方落**。这条更根本 |

修法：**主进程起一个只绑回环的静态服务器**（和命令行**同一份实现** `src/server/static.ts`），
窗口指向 `http://127.0.0.1:51735/`：

- 端口**写死**：随机端口 = 每次新 origin = 每次打开存档都是空的
- 回环监听不触发 Windows 防火墙询问；单实例锁保证端口不被抢
- 开发（浏览器 5173）和打包后（窗口 51735）**同一条代码路径** → 不会再有"只有打包版才 404"
- 新增 4 条**端到端**测试（`tests/web.ts`：真的 listen、真的请求 `/`、`/content/manifest.json`、
  `/dist/...`、越界）—— 就是这次踩的那个坑的回归测试

⚠ 打包路上另外两个坑：
1. **electron-builder 会把 `out/` 留成半成品**（exe 拷了、`resources/` 空）——
   所以改成自己的 `pack.mjs`，而且它**自检**
2. 玩家窗口开着的时候 `out/` 是**锁着的**（`EPERM`）—— 重新打包前得先关掉窗口
   （这次我确实是先关掉了他那个坏窗口再重打的）

顺手还清了 `web/index.html` 里那个过时标题（窗口标题一直是"术式系统 · 里程碑 0.5"）。

---

## 验证

| 检查 | 结果 |
| --- | --- |
| `npm test` | 16 个文件全绿 · **1133 个断言**（新加 4 条端到端服务器测试） |
| `npm run validate` | 51 个文件 · 51 通过 · 0 失败 · 9 警告 |
| `npm run typecheck` | 两个 tsconfig 都干净（`desktop/**` 不在 include 里，故意） |
| 映射（纯函数） | `tsc -p desktop/tsconfig.json` → `build/{assets,static}.js` ✓；CJS `require` 实测四种路径 ✓ |
| **服务器（真 listen + 真请求）** | ✓ `/` 200（有 `<canvas>`）、`/content/manifest.json` 200 + JSON、`/dist/...` 200、越界不给 package.json |
| **打包后的目录** | ✓ 用 `resources/app/build/static.js` + `resources/` 起服务器实测：index 200、manifest 200（技能 30）、bundle 200 |
| `pack.mjs` 自检 | ✓ 六样东西缺一即报错退出 |
| 窗口能不能起 | ✓ **玩家实测过**（第一次那个 .exe 窗口起来了、标题对）；⚠ 我这边起不来（沙箱禁命名管道） |

## 欠账

- **请玩家再双击一次** `desktop/out/win-unpacked/MagicAndSword.exe`：这次应该能看到画面了
  （如果还报 fetch，请把开发者工具里的完整报错发我 —— 窗口里 `Ctrl+Shift+I`）。
- 单文件 portable exe：开 Windows 开发者模式（或管理员终端）后 `npm run dist:portable`。
- 阶段 2：图标（现在是 Electron 默认图标）、窗口尺寸记忆、安装包。
- ⚠ **存档搬迁**：浏览器里的存档和 .exe 的存档是两份（origin 不同）——
  真开始用 .exe 之前要做一次性搬迁。
- 编辑器 UI（玩家设计）与序列模型 B（`sequence-model-plan.md`）仍在队列里，和壳互不冲突。
