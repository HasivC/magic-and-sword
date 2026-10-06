/**
 * 一个极小的静态文件服务器，只用来在本地看游戏（浏览器里）。
 *
 * 它**不是**游戏服务器 —— 那要等阶段 5（局域网对战）。
 * 这里只是把静态文件递出去，没有任何游戏逻辑。
 *
 * ⚠ 真正的实现住在 `src/server/static.ts` —— **桌面壳用的是同一份**
 *   （见 `docs/desktop.md`）。这个文件只剩"命令行参数 + 打印地址"。
 *
 *   node src/cli/serve.ts            # 默认 5173 端口
 *   node src/cli/serve.ts --port 8080
 */
import { resolve } from 'node:path'
import { createStaticServer } from '../server/static.ts'

const ROOT = resolve('.')

function parsePort(argv: string[]): number {
  const i = argv.indexOf('--port')
  const v = i >= 0 ? Number(argv[i + 1]) : NaN
  return Number.isFinite(v) && v > 0 ? v : 5173
}

function main(): void {
  const port = parsePort(process.argv.slice(2))
  const server = createStaticServer(ROOT)

  server.listen(port, '127.0.0.1', () => {
    console.log('')
    console.log('  · 浏览器里跑模拟核心')
    console.log('  ────────────────────────────────────────')
    console.log(`  打开：http://127.0.0.1:${port}/`)
    console.log('')
    console.log('  没画面？先编一次：')
    console.log('    npm run build:web')
    console.log('')
    console.log('  Ctrl+C 停止')
  })
}

main()
