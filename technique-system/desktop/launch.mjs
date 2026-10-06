/**
 * 起桌面壳。
 *
 * 为什么不是一句 `electron .`：
 *   客户端是**编译产物**，改完不编译就会看到旧画面（而且很难意识到是"忘了编"）。
 *   所以这里把"编客户端 → 编壳要复用的那份映射 → 起 Electron"串成一条命令。
 *
 * 用法（在仓库根）：
 *   npm run desktop
 *
 * ⚠ 用 Node 起、不用 `npm --prefix desktop start`：少一层 npm，
 *   换 shell（PowerShell / cmd / Git Bash）都不会因为脚本策略卡住。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

function run(label, args, cwd) {
  console.log(`\n▸ ${label}`)
  const r = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`✗ ${label} 失败（退出码 ${String(r.status)}）`)
    process.exit(r.status ?? 1)
  }
}

// 1. 客户端（改了 web/src 或 src/sim 就得重编 —— 这是最容易忘的一步）
run('编客户端（web/dist）', [tsc, '-p', 'tsconfig.web.json'], root)
// 2. 壳要复用的资源映射（src/server/assets.ts → desktop/build/assets.js）
run('编壳用的资源映射', [tsc, '-p', 'tsconfig.json'], here)

// 3. Electron 本体
const electron = join(here, 'node_modules', 'electron', 'dist', 'electron.exe')
if (!existsSync(electron)) {
  console.error(
    '\n✗ 还没装 Electron。先跑一次：\n'
    + '    cd desktop && npm install\n'
    + '（约 250MB，只下一次。它**不**进游戏本体的依赖 —— 见 docs/desktop.md）',
  )
  process.exit(1)
}

console.log('\n▸ 起窗口\n')
const r = spawnSync(electron, ['.'], { cwd: here, stdio: 'inherit' })
process.exit(r.status ?? 0)
