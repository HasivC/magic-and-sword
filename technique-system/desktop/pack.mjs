/**
 * 打出**能跑的桌面应用目录**（不靠 electron-builder）。
 *
 * ## 为什么不用 electron-builder
 *
 * 它在这台机器上过不去：签名工具包 `winCodeSign` 里带着 **macOS 的符号链接**，
 * Windows 建符号链接要**开发者模式或管理员** —— 于是 `app-builder.exe` 那一步失败，
 * 而且会把 `out/` 留成半成品（exe 拷过去了、`resources/` 却是空的）。
 *
 * ## Electron 其实只要两样东西
 *
 * ```
 * <某个目录>/
 *   <你的 exe>          ← electron/dist/electron.exe 改个名
 *   *.dll / locales/…   ← electron/dist 里的其它东西
 *   resources/
 *     app/              ← 你的壳代码（main.js + package.json）——有它就能跑，不必打成 asar
 *     web/  content/  schema/   ← 游戏本体（壳按 process.resourcesPath 找它们）
 * ```
 *
 * 所以打包就是"拷三份 + 改个名 + 写一个三行的 package.json"。
 * ⚠ 这条路的好处：**每一步我都能验**（见文件末尾的校验），
 *   而且不引入一个几百 MB、又依赖系统权限的打包器。
 *   electron-builder 留在 `devDependencies` 里，将来要**单文件 portable exe / 安装包**
 *   的时候再用（那时先开开发者模式）。
 *
 * 用法：node desktop/pack.mjs
 */
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')          // 仓库根（technique-system/）
const electronDist = join(here, 'node_modules', 'electron', 'dist')
const out = join(here, 'out', 'win-unpacked')

if (!existsSync(electronDist)) {
  console.error('✗ 还没装 Electron。先跑：\n    node desktop/node_modules/electron/install.js')
  process.exit(1)
}

// 客户端是编译产物，没编就没得玩
const bundle = join(root, 'web', 'dist', 'technique-system', 'web', 'src', 'main.js')
if (!existsSync(bundle)) {
  console.error('✗ 客户端还没编译。先在仓库根跑：\n    npm run build:web')
  process.exit(1)
}

console.log('▸ 清掉旧的 out/')
rmSync(join(here, 'out'), { recursive: true, force: true })
mkdirSync(out, { recursive: true })

console.log('▸ 拷 Electron 本体')
cpSync(electronDist, out, { recursive: true })
renameSync(join(out, 'electron.exe'), join(out, 'MagicAndSword.exe'))

console.log('▸ 拷游戏本体（内容 / 客户端 / schema）')
for (const dir of ['web', 'content']) {
  cpSync(join(root, dir), join(out, 'resources', dir), { recursive: true })
}
/*
 * ⚠ `schema/` 不在 `technique-system/` 里，它在**仓库根**（`magic and sword/schema`）——
 *   客户端运行时不读它（类型在编译时就擦掉了），但它是这份内容的**说明书**，
 *   一起带上：以后想手改内容 / 做 mod，旁边就有定义。
 */
const schemaSrc = resolve(root, '..', 'schema')
if (existsSync(schemaSrc)) cpSync(schemaSrc, join(out, 'resources', 'schema'), { recursive: true })

console.log('▸ 放壳自己的代码（resources/app/）')
const appDir = join(out, 'resources', 'app')
mkdirSync(appDir, { recursive: true })
cpSync(join(here, 'main.js'), join(appDir, 'main.js'))
cpSync(join(here, 'build'), join(appDir, 'build'), { recursive: true })
writeFileSync(join(appDir, 'package.json'), JSON.stringify({
  name: 'magic-and-sword',
  version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
  main: 'main.js',
}, null, 2) + '\n')

// ---------------------------------------------------------------- 自检
//
// ⚠ 这几条不是仪式：装上之后白屏 / "找不到 manifest.json"，
//   99% 是这四样里的某一样没搬过来。所以打包**当场**就说。
const must = [
  join(out, 'MagicAndSword.exe'),
  join(out, 'resources', 'app', 'main.js'),
  join(out, 'resources', 'app', 'build', 'static.js'),
  join(out, 'resources', 'content', 'manifest.json'),
  join(out, 'resources', 'web', 'index.html'),
  bundle.replace(join(root, 'web'), join(out, 'resources', 'web')),
]
const missing = must.filter(p => !existsSync(p))
if (missing.length > 0) {
  console.error('✗ 打出来的目录不完整：')
  for (const p of missing) console.error('   ' + p.replace(out, 'out/win-unpacked'))
  process.exit(1)
}

console.log('\n✓ 打好了：desktop/out/win-unpacked/')
console.log('  双击 MagicAndSword.exe（**在它自己这个文件夹里**启动，别单独拷走）')
