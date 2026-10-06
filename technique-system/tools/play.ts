/**
 * 用**独立窗口**玩，不在浏览器标签页里。
 *
 * ## 做法
 *
 * 用 Edge / Chrome 的 `--app` 模式：一个**没有标签页、没有地址栏**的窗口，
 * 有自己的任务栏图标，看起来就是一个独立程序。
 *
 * ## 为什么不用 Electron
 *
 * 那是"真正的"桌面应用做法（打一个 .exe 出去），但它要下 200MB 的 Chromium，
 * 而且这个项目和它的依赖目前只有 typescript 一个。
 *
 * **先要的是"不像在浏览器里玩"，不是"能发给别人"。**
 * 所以先用系统上已有的浏览器，零依赖、零等待。
 * 真要打包发布的时候再上 Electron/Tauri —— 见 docs/desktop.md。
 *
 * 用法：
 *   npm run play               起服务（如果没起）并开一个独立窗口
 *   npm run play -- --port 6000
 *   npm run play -- --window 1600x900
 *   npm run play -- --browser "C:\path\to\msedge.exe"
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { request } from 'node:http'

// ---------------------------------------------------------------- 参数

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const PORT = Number(arg('port') ?? 5173)
const SIZE = arg('window') ?? '1440x900'
const URL = `http://127.0.0.1:${PORT}/`

// ---------------------------------------------------------------- 找浏览器

/**
 * 按顺序找一个能用的 Chromium 系浏览器。
 *
 * ⚠ 只要 Chromium 系（Edge / Chrome / Brave）—— `--app` 是它们特有的。
 *   Firefox 没有等价参数，Safari 也没有。
 */
function findBrowser(): string | undefined {
  const forced = arg('browser')
  if (forced !== undefined) return existsSync(forced) ? forced : undefined

  const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const local = process.env['LOCALAPPDATA'] ?? ''

  const candidates = process.platform === 'win32'
    ? [
      `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      `${local}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
    ]
    : process.platform === 'darwin'
      ? [
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ]
      : [
        '/usr/bin/microsoft-edge',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
      ]

  return candidates.find(p => existsSync(p))
}

// ---------------------------------------------------------------- 服务

/** 端口上已经有人应答了吗 */
function serverUp(): Promise<boolean> {
  return new Promise(resolve => {
    const req = request({ host: '127.0.0.1', port: PORT, path: '/', method: 'HEAD', timeout: 800 }, res => {
      res.resume()
      resolve(true)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.end()
  })
}

/**
 * 这个命令**自己起过**服务吗。
 *
 * ⚠ 和"服务现在活着吗"是两件事（这两个语义混过一次，见 ensureServer 的注释）。
 *   用途只有一个：开完窗口后回来确认"我起的那个还活着吗" ——
 *   服务本来就在跑的话，它活得好好的是理所当然的，不用多嘴。
 */
let startedServer = false

/**
 * 保证服务在跑。
 *
 * ⚠ 返回的是"**现在服务是活的吗**"，不是"我刚起的吗"。
 *   这两个语义搞混过一次：写成"是我起的才返回 true"，
 *   结果**服务已经在跑**（最常见的情况）反而被判成失败、直接退出了。
 */
async function ensureServer(): Promise<boolean> {  if (await serverUp()) {
    console.log(`  服务已经在跑了：${URL}`)
    return true
  }

  console.log('  起服务…')
  startedServer = true
  /*
   * ⚠ `stdio: 'ignore'` —— **不是** 'inherit'，虽然 'inherit' 看起来更"透明"。
   *
   *   用 'inherit' 的话，子进程会**继承调用方的控制台句柄**。
   *   我们自己 `detached` + `unref` 之后就退出了，但 PowerShell / bash
   *   会一直等那个句柄关闭 —— 表现是 `npm run play` **挂住不返回**
   *   （实测挂满 120 秒的命令超时）。
   *
   *   沙箱里 piped stdio（'pipe'）会 EPERM，但 'ignore' 是允许的，
   *   而且这里也不需要看服务的日志：下面会轮询 5 秒确认它真的能应答，
   *   起不来的话照样报错。看得见结果，就不用看得见过程。
   */
  const child = spawn(process.execPath, ['src/cli/serve.ts', '--port', String(PORT)], {
    stdio: 'ignore',
    detached: true,
  })
  child.unref()

  // 等它真的能应答（最多 5 秒）
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100))
    if (await serverUp()) return true
  }
  console.error(`  ✗ 服务起不来（端口 ${PORT}）`)
  return false
}

// ---------------------------------------------------------------- 主流程

console.log('')
console.log('术式系统 · 独立窗口')
console.log('─'.repeat(56))

const browser = findBrowser()
if (browser === undefined) {
  console.error('')
  console.error('  ✗ 没找到 Chromium 系浏览器（Edge / Chrome / Brave）')
  console.error('    --app 是它们特有的，Firefox 没有等价的参数。')
  console.error('    可以手动指定：npm run play -- --browser "路径\\到\\msedge.exe"')
  console.error('')
  process.exit(1)
}

console.log(`  浏览器  ${browser}`)

if (!(await ensureServer())) process.exit(1)

/*
 * ⚠ `--user-data-dir` 单独开一个配置目录。
 *
 *   不写的话，这个窗口会挂到你**日常浏览器**的进程上 ——
 *   关掉它可能会把日常浏览器的窗口一起关了，反过来也一样。
 *   单独一个目录 = 真正独立的进程和窗口。
 */
const profile = `${process.cwd()}\\.window-profile`
console.log(`  窗口    ${SIZE}   （独立的浏览器配置，不会影响你日常那个）`)

const args = [
  `--app=${URL}`,
  `--window-size=${SIZE}`,
  `--user-data-dir=${profile}`,
  // 关掉 app 模式下偶尔冒出来的滚动条和默认边距
  '--disable-features=Translate,BackForwardCache',
  '--no-first-run',
  '--no-default-browser-check',
]

/*
 * ⚠ 起浏览器**必须**把失败说出来。
 *
 *   stdio: 'ignore' + detached 的组合下，spawn 失败是一声不吭的：
 *   脚本照常打印"✓ 窗口应该已经开了"，然后什么都没发生。
 *   踩过一次，找问题找了两轮。
 *
 *   所以这里等到 spawn 事件（成功）或 error 事件（失败）才往下走，
 *   error 时把手动命令打出来。
 */
function manualHint(): void {
  console.log('')
  console.log('  可以手动开一个同样的窗口：')
  console.log('')
  console.log(`    "${browser}" --app=${URL} --window-size=${SIZE} --user-data-dir="${profile}"`)
  console.log('')
}

let launched = false
try {
  const child = spawn(browser, args, { stdio: 'ignore', detached: true })

  await new Promise<void>((resolve) => {
    child.once('spawn', () => { launched = true; resolve() })
    child.once('error', (err) => {
      console.error('')
      console.error(`  ✗ 浏览器起不来：${err.message}`)
      manualHint()
      resolve()
    })
    // 'spawn' / 'error' 一定会来一个，但别为了它挂死
    setTimeout(resolve, 3000)
  })

  child.unref()
} catch (err) {
  console.error('')
  console.error(`  ✗ 浏览器起不来：${err instanceof Error ? err.message : String(err)}`)
  manualHint()
}

if (launched) {
  console.log('')
  console.log('  ✓ 窗口应该已经开了。关掉窗口不会停服务；')
  console.log('    下次 npm run play 会复用已经跑着的服务。')

  /*
   * ⚠ 自己起的服务，要提醒一句"它可能活不过这条命令"。
   *
   *   在沙箱化 / 受管理的环境里，`detached` 出去的服务进程会跟着
   *   **跑这条命令的那个进程**一起被回收 —— 而回收发生在命令**退出之后**，
   *   所以脚本在退出前怎么检查都查不出来（试过：退出前 500ms 它是活的，
   *   加了检查也不会触发，只会给人"检查过了"的假安心）。
   *
   *   表现是：脚本打印"✓ 窗口应该已经开了"，而窗口里是白的。
   *
   *   既然查不出来，就别装作查得出来 —— 直接写清楚白屏了怎么办。
   *   骗人的成功提示比报错难查得多。
   */
  if (startedServer) {
    console.log('')
    console.log('  ⚠ 服务是**这条命令**起的。在受管理的环境里它可能活不过命令退出，')
    console.log('    那样窗口会是白的。遇到白屏就单独开一个终端：')
    console.log('')
    console.log('      npm run serve      # 让它一直开着')
    console.log('      npm run play       # 再开窗口（会复用那个服务）')
  }
  console.log('')
}
