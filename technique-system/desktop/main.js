/**
 * 桌面壳的主进程。
 *
 * ## 它做什么
 *
 * 1. 起一个**只绑回环**（127.0.0.1）的静态服务器 —— **和命令行那份是同一份实现**
 *    （`src/server/static.ts`，编到 `build/static.js`）
 * 2. 开一个自己的窗口（没有地址栏 / 标签页 / 菜单栏），指向那个地址
 * 3. 以后：局域网联机的传输层也住在这一侧（见 `docs/lan-feasibility.md`）
 *
 * ## 为什么是 HTTP，不是自定义协议 `app://`
 *
 * 先做的是 `app://` + `protocol.handle`，玩家装上 .exe 之后**页面里所有 fetch 全挂**
 * （"找不到 manifest.json / failed to fetch"）。原因有两条：
 *
 *   1. 自定义协议没登记 `registerSchemesAsPrivileged({ supportFetchAPI: true })` 时，
 *      页面能打开，但它里面的 `fetch('app://…')` 一律失败
 *   2. ⚠ **更根本的**：localStorage **按 origin 分**（scheme + host + port）。
 *      自定义协议的 origin 是实现细节，而 `http://127.0.0.1:<固定端口>` 是稳定的 ——
 *      **存档才有地方落**。这条比第一条重要得多。
 *
 * HTTP 的代价只有一个回环端口：**回环监听不触发 Windows 防火墙询问**
 * （那是给对外接口弹的），而且单实例锁保证端口不会被自己抢。
 *
 * ## 为什么这个文件是 **CommonJS 的 .js**，不是 .ts
 *
 * 游戏本体那边 Node 24 能直接跑 `.ts`（类型擦除），但**壳跑在 Electron 自己的 Node 里**，
 * 版本不受我们控制 —— 依赖"能擦除类型"会在换 Electron 版本时炸。
 * 所以壳这一侧只用最普通的 JS；要复用的那两个模块由 `npm run build:assets` 预先编好。
 *
 * ⚠ 那两个模块**必须复用**，不能在这里重写一份：
 *   两边不一样的表现是"开发时好好的，打包版 404"—— 每次都要重新查一遍。
 */
const { app, BrowserWindow, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { createStaticServer } = require('./build/static.js')

/**
 * 资源根。
 *
 * ⚠ 开发时是仓库根（`desktop/..`），打包后是 `resources/`
 *   （见 `package.json` 的 `extraResources`：`web` / `content` / `schema` 会被搬过去）。
 */
const ROOT = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..')

/** 客户端是编译产物，没编就没得玩 —— 提前查一次，给一句人话，而不是白屏 */
const CLIENT_BUNDLE = path.join(ROOT, 'web', 'dist', 'technique-system', 'web', 'src', 'main.js')

const WINDOW = { width: 1440, height: 900, background: '#0d1117' }

/**
 * ⚠ 端口**写死**，不能随机。
 *
 *   localStorage 按 origin 分（scheme + host + port）——
 *   端口随机 = 每次启动一个新 origin = **玩家每次打开存档都是空的**。
 *   单实例锁保证这个端口只有我们自己在用；真被占了就让 Windows 报错，
 *   也好过悄悄换一个端口把存档弄丢。
 */
const PORT = 51735
const URL_BASE = `http://127.0.0.1:${PORT}/`

function createWindow() {
  const win = new BrowserWindow({
    width: WINDOW.width,
    height: WINDOW.height,
    minWidth: 960,
    minHeight: 600,
    title: '术式系统',
    backgroundColor: WINDOW.background,
    autoHideMenuBar: true,
    show: false,          // 等第一帧画好再显示，免得看到一块白
    webPreferences: {
      // 客户端是**纯浏览器代码**（不碰 Node），所以按最严的来
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.once('ready-to-show', () => win.show())

  /*
   * ⚠ 渲染进程的 console 要转发到壳的 stdout。
   *   不然"页面上什么都没发生"这种问题在打包版里完全不可见 ——
   *   开发者工具能开，但报错通常只有当事人看得到。
   */
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`[页面] ${message}`)
  })
  win.webContents.on('did-finish-load', () => console.log('[壳] 页面加载完成'))
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[壳] 加载失败 ${code} ${desc} —— ${url}`)
  })

  /*
   * 快捷键：没有菜单栏，所以自己接。
   *   F11 全屏 / Ctrl+R 刷新（改完 `npm run build:web` 按一下）/ Ctrl+Shift+I 开发者工具
   */
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const key = (input.key || '').toLowerCase()
    if (key === 'f11') {
      win.setFullScreen(!win.isFullScreen())
      event.preventDefault()
    } else if (input.control && key === 'r') {
      win.webContents.reload()
      event.preventDefault()
    } else if (input.control && input.shift && key === 'i') {
      win.webContents.toggleDevTools()
      event.preventDefault()
    }
  })

  if (!fs.existsSync(CLIENT_BUNDLE)) {
    // 不白屏：说清是哪一步没做
    const html = `<html><body style="background:#0d1117;color:#e6edf3;font:16px/1.7 sans-serif;padding:40px">
      <h2>客户端还没编译</h2>
      <p>先在这个仓库里跑一次：</p><pre style="color:#e3b341">npm run build:web</pre>
      <p>然后关掉这个窗口、重新 <code>npm run desktop</code>。</p>
      <p style="color:#6e7681">（改完客户端代码也要重跑那一句；窗口里按 Ctrl+R 刷新就行）</p>
      </body></html>`
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    return
  }

  win.loadURL(URL_BASE)
}

/**
 * 起那个静态服务器（只绑回环）。
 *
 * ⚠ 它和命令行那份**是同一份实现**（`src/server/static.ts`）——
 *   开发时怎么跑、打包后还怎么跑，所以不会有"只有打包版才 404"这种事。
 */
function startServer() {
  return new Promise((resolve, reject) => {
    const server = createStaticServer(ROOT)
    server.once('error', reject)
    server.listen(PORT, '127.0.0.1', () => {
      console.log(`[壳] 服务器：${URL_BASE}`)
      resolve(server)
    })
  })
}

// 第二次点图标不要开两个窗口（联机以后更要紧：一个进程一个房主身份）
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win !== undefined) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    try {
      await startServer()
    } catch (e) {
      // 端口被占（理论上单实例锁挡住了；真发生就说清楚，别白屏）
      console.error(`[壳] 端口 ${PORT} 起不来：${String(e)}`)
    }
    createWindow()
    console.log(`[壳] 资源根：${ROOT}`)
    console.log(`[壳] 打包模式：${app.isPackaged ? '是' : '否（开发）'}`)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => app.quit())

  // 别让页面里的 target=_blank 把游戏顶掉
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
      return { action: 'deny' }
    })
  })
}
