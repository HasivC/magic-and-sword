# 桌面应用（真 .exe 和独立窗口）

- **日期**：2026-09-21
- **触发**：玩家

  > 先做准备工作吧，我不想用目前的浏览器界面，而是实打实的exe和应用程序窗口，这样更有质感

  所以这条定下来：**目标是一个自己的 .exe**（不是"在 Edge 里开了个像应用的东西"）。
  这份文件是准备工作：选型、这台机器的事实、壳怎么搭、以及**打包之后会变的东西**
  （存档、路径、图标、开发循环）。

- 现状：`tools/play.ts` 已经能用系统的 Edge 开一个 `--app=` 独立窗口
  （没有地址栏、没有标签页、有自己的任务栏图标）—— 那是**阶段 0**，零依赖。

---

## 一、这台机器的实际情况（2026-09-21 实查）

| 需要什么 | 有没有 | 影响 |
| --- | --- | --- |
| Node / npm | **v24.21.0 / 11.19.0** ✓ | Electron 这条路只需要它 |
| **Rust / cargo** | **没有** ✗ | Tauri 要装 rustup + MSVC（GB 级） |
| .NET / dotnet | **没有** ✗ | WebView2 + C# 那条路要装 .NET SDK |
| **WebView2 运行时** | **有**（153.0.4234.48）✓ | Tauri / WebView2 壳**能跑**，只是构建工具链缺 |
| Edge / Chrome | Edge ✓ / Chrome ✗ | `--app=` 窗口能用（走 Edge） |
| Visual Studio 目录 | 有 | 可能带 MSVC，但**没有 dotnet**，要用还得确认 |

## 二、四条路（按"这台机器现在能不能直接走"排）

| 方案 | 产物 | 要装的工具链 | 体积 | 质感 / 可控度 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **Electron** | 真 .exe（portable / 安装包） | **只要 npm**（下 ~250MB 开发依赖） | .exe ~80MB | 高：自定义标题栏/图标/菜单/全屏/以后自动更新 | ✅ **推荐** |
| Tauri | 真 .exe | 先装 **Rust + MSVC**（GB 级） | .exe ~10MB | 高（也是 WebView2） | 体积最漂亮，但要先装工具链 |
| WebView2 + C# | 真 .exe | 先装 **.NET SDK** | ~1MB + 依赖 WebView2 | 中：窗口控制要自己写 | 最轻，但要装另一个工具链 |
| `--app=` 窗口（已有） | **不是** .exe | 零 | 0 | 低：那是 Edge 的窗口（图标、任务栏分组都是 Edge） | **阶段 0**：今天就能"不像在浏览器里玩" |

⚠ **推荐 Electron 的理由只有一个**：它是**唯一一条不需要安装新工具链**就能出真 .exe 的路
（这台机器有 Node ✓，没有 Rust ✗，没有 .NET ✗）。

⚠ 代价说清楚：Electron 会把 ~250MB 的开发依赖装进 `node_modules`（打包后 .exe ~80MB）。
**游戏本体不受影响** —— 它仍然只有 `typescript` 和 `@types/node` 两个开发依赖；
Electron 住在单独的 `desktop/` 里。

⚠ 如果你更在乎"小"，那就装 Rust 走 Tauri（.exe ~10MB，也是 WebView2 内核，
这台机器已经有 WebView2 运行时 ✓）。**这个选择权在你**，两条我都能做。

## 三、壳怎么搭（方案已经定了，和选型无关的部分）

### 3.1 内容怎么端给窗口 —— **复用同一套映射**

`src/server/assets.ts`（2026-09-21 抽出来的）已经回答了"哪个 URL 对应哪个文件、什么 content-type"，
两个消费者共用：

- `src/cli/serve.ts`：开发时的小静态服务器（浏览器 / `--app=` 窗口）
- **桌面壳**：自定义协议 `app://` 直接读磁盘

⚠ 两边各写一份的话，漂移的表现是"**只有打包版才 404**"—— 开发时好好的，
发给别人就白屏。所以这份映射只有一份，而且**有测试钉着**（`tests/web.ts`：
`/content/...` → `content/...`、`/dist/...` → `web/dist/...`、越界退回首页）。

### 3.2 端内容：**回环 HTTP**（不是自定义协议）

一开始我用的是自定义协议 `app://` + `protocol.handle`。**这是错的**，玩家装上 .exe 之后
就是那个结果：

> 进去后提示找不到 manifest.json，failed to fetch

页面能打开、窗口标题也对，但**页面里所有 `fetch` 全挂**。两个原因：

| 原因 | 说明 |
| --- | --- |
| 自定义协议要**登记特权** | 没写 `protocol.registerSchemesAsPrivileged({ supportFetchAPI: true, … })` 时，`fetch('app://…')` 一律失败 |
| ⚠ **localStorage 按 origin 分** | `scheme + host + port` 才是 origin。自定义协议的 origin 是实现细节，而 `http://127.0.0.1:<固定端口>` 是**稳定的** —— **存档才有地方落**。这条比上一条重要得多 |

所以改成：主进程起一个**只绑回环**的静态服务器（和命令行那份**同一份实现**），
窗口指向 `http://127.0.0.1:51735/`。

- ⚠ **端口写死**，不能随机 —— 端口随机 = 每次启动一个新 origin = **每次打开存档都是空的**
- 回环监听**不触发 Windows 防火墙询问**（那是给对外接口弹的），单实例锁保证端口不被自己抢
- 好处：开发时（浏览器 5173）和打包后（窗口 51735）**走的是同一条代码路径**，
  所以不会有"只有打包版才 404"这种事；而且这条路径**有端到端测试**
  （`tests/web.ts`：起服务器 → 真请求 `/`、`/content/manifest.json`、`/dist/...`、越界）

### 3.3 壳要做的其它事

- `BrowserWindow`：尺寸（默认 1440×900，记住上次）、标题、图标、`autoHideMenuBar: true`
- 安全默认：`contextIsolation: true`、`nodeIntegration: false`（客户端是纯浏览器代码 ✓ 不需要 Node）
- 快捷键：`F11` 全屏、`Ctrl+R` 刷新（改完 `npm run build:web` 就刷）、`Ctrl+Shift+I` 开发者工具
- 单实例锁（点两次图标不要开两个窗口）
- 以后：`electron-builder` 出 portable exe + 安装包、图标 `.ico`、主题

### 3.4 打包时要注意的四件事（准备工作里最容易漏的）

1. **存档不跟着走** ⚠ 现在存档在**浏览器的 localStorage** 里（`dsh.technique-system.save`）。
   换成 .exe 之后 localStorage 落在 Electron 自己的 userData 目录 ——
   **你在浏览器里做的东西不会自动出现**。
   办法（挑一个，等真打包时做）：术式编辑器加"导出/导入 JSON"（已经有 ✓）、
   或者做一个一次性的"从浏览器搬存档"的小页面。
2. **路径里有空格**（`D:\dsh works\magic and sword\...`）：开发时无所谓，
   打包后资源路径一律用 `process.resourcesPath` 拼，别用相对路径。
3. **`content/` 放 `extraResources`**（不要塞进 asar）：
   内容是**数据**，放在压缩包里读起来别扭，而且以后做 mod / 手改内容会麻烦。
4. **每次改完要 `npm run build:web`**（客户端是编译产物）——
   壳里按 `Ctrl+R` 刷新就行。这一步以后可以做成"壳起来时自动编译一次"。

## 四、阶段计划

| 阶段 | 做什么 | 状态 |
| --- | --- | --- |
| **0** | `npm run play`：Edge 的 `--app=` 独立窗口（零依赖、今天就能用） | ✅ 已有（`tools/play.ts`） |
| **1** | `desktop/` 里的 Electron 壳 + **portable .exe**（双击就能玩，内容从 `content/` 读） | 🔨 做中（见下面"怎么用"） |
| **2** | 图标 / 标题 / 窗口尺寸记忆 / 安装包（electron-builder） | ⬜ |
| **3** | 存档搬迁、自动更新、发布 | ⬜ 以后 |

⚠ 桌面壳和**编辑器 UI 重做**（`editor-ui-brief.md`）**不冲突**：
壳只负责"把页面装进一个自己的窗口"，页面里面长什么样是另一件事。

---

## 五、怎么用（阶段 1 的实现）

```
technique-system/
  desktop/                 ← 壳（自己一份 package.json，**不进游戏本体的依赖**）
    main.js                主进程：自定义协议 app:// + 开窗口 + 快捷键
    launch.mjs             串联：编客户端 → 编资源映射 → 起 Electron
    tsconfig.json          只编 src/server/assets.ts 这一份（壳要复用它）
    build/assets.js        上面那份的编译产物（壳不会重复实现一遍映射）
    out/MagicAndSword-*.exe 打包出来的 portable exe
```

| 命令 | 做什么 |
| --- | --- |
| `npm run desktop` | **开发用**：编客户端 → 编映射 → 开窗口。改完客户端再跑一次（或窗口里 `Ctrl+R`） |
| `cd desktop && npm install` | 第一次要跑一次（下 Electron，约 250MB） |
| `node desktop/pack.mjs` | **打包（推荐）**：直接按 Electron 要的布局拷出来 → `desktop/out/win-unpacked/MagicAndSword.exe` |
| `cd desktop && npm run dist:portable` | 打**单文件** portable exe（要 electron-builder，⚠ 见下面第 3 条） |

### 为什么打包用自己的脚本，不用 electron-builder

electron-builder 在这台机器上过不去：它的签名工具包 `winCodeSign` 带着 **macOS 的符号链接**，
Windows 建符号链接要**开发者模式或管理员** —— `app-builder.exe` 那一步失败，
而且会把 `out/` 留成**半成品**（exe 拷过去了、`resources/` 是空的 ✗ 双击就白屏）。

Electron 其实只要"三份东西 + 一个三行的 package.json"：

```
out/win-unpacked/
  MagicAndSword.exe          ← electron/dist/electron.exe 改个名
  *.dll / locales/ / …       ← electron/dist 的其它东西
  resources/
    app/main.js + app/build/ ← 壳自己的代码（有 app/ 就能跑，不必打成 asar）
    web/  content/  schema/  ← 游戏本体（壳按 process.resourcesPath 找）
```

`desktop/pack.mjs` 做的就是这件事，而且**每一步都自检**（缺哪一样当场报出来，
不等到双击白屏）。`electron-builder` 留在 devDependencies 里 —— 将来要**单文件 exe / 安装包**
时再开开发者模式用它。

### 第一次装 / 打包会撞到的三个坑（2026-09-21 实测，都记下来）

**1. 装完没有 `electron.exe`？** npm 11 **默认不跑 postinstall**（它会提示
`1 package has install scripts not yet covered by allowScripts: electron`）。两条路：

```powershell
# 要么直接跑它的安装脚本（就是下载二进制那一步）
node desktop/node_modules/electron/install.js
# 要么放行脚本再装一次
cd desktop && npm install-scripts approve electron && npm install
```

**2. 二进制下不下来（`ECONNRESET` / TLS 报错）？** 卡的是它从 **GitHub** 拉的 180MB。
换国内镜像：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
```

⚠ npm 的缓存也放工作区里（受限环境会拦用户目录）：

```powershell
$env:npm_config_cache="D:\dsh works\.cache\npm"
$env:ELECTRON_CACHE="D:\dsh works\.cache\electron"
$env:ELECTRON_BUILDER_CACHE="D:\dsh works\.cache\electron-builder"
```

**3. `--win portable` 报 `Cannot create symbolic link ... libcrypto.dylib`？**
那是 electron-builder 的签名工具包（`winCodeSign`）里有 **macOS 的符号链接**，
Windows 上建符号链接要**开发者模式**或**管理员**。两个办法：

- 开 Windows「开发者模式」（设置 → 系统 → 开发者选项），或那次用管理员开终端 → 再跑 `npm run dist`
- 或者先不追单文件：`npx electron-builder --win dir` → `out/win-unpacked/MagicAndSword.exe`
  **双击就能玩**（整个文件夹是它的运行环境，别单独把 exe 拷走）

⚠ **依赖的边界**：游戏本体的 `package.json` 仍然只有 `@types/node` 和 `typescript`；
Electron / electron-builder 住在 `desktop/` 自己的 `node_modules` 里。

⚠ **打包时资源从 `process.resourcesPath` 读**（`extraResources` 把 `web/` `content/` `schema/`
搬到 exe 旁边）—— 所以壳里那句资源根是 `app.isPackaged ? process.resourcesPath : 仓库根`。

⚠ **第一次跑之前必须先编过客户端**：壳会检查 `web/dist/.../main.js` 在不在，
不在就显示一句"先跑 `npm run build:web`"，**不是白屏**。

⚠ Windows 上 npm 写缓存默认在用户目录；沙箱/受限环境里要把它挪进工作区：

```powershell
$env:npm_config_cache="D:\dsh works\.cache\npm"
$env:ELECTRON_CACHE="D:\dsh works\.cache\electron"
$env:ELECTRON_BUILDER_CACHE="D:\dsh works\.cache\electron-builder"
```
