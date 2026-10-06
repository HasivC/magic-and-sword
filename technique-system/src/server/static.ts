/**
 * 静态文件服务器：**开发用的命令行**和**桌面壳**共用这一份。
 *
 * ## 为什么要有它（而不是各写一份）
 *
 * 两个消费者：
 *   1. `src/cli/serve.ts` —— 开发时在浏览器里看（`npm run serve`）
 *   2. **桌面壳的主进程**（`desktop/main.js`）——它起同一个服务器，
 *      窗口指向 `http://127.0.0.1:<port>/`
 *
 * ⚠ 各写一份的表现是"**只有打包版才有 bug**"：开发时 `/content/xxx.json` 好好的，
 *   装成 .exe 之后 404 —— 那种 bug 每次都要从头查一遍。
 *   所以 URL→文件、content-type、404、no-store 全都只有这一份。
 *
 * ## 为什么壳用 HTTP，而不是自定义协议 `app://`
 *
 * 试过 `app://`（`protocol.handle`），撞了两个坑：
 *   1. 没登记 `registerSchemesAsPrivileged({supportFetchAPI: true})` 的话，
 *      页面能打开、但它里面的 `fetch('app://...')` 全是 **Failed to fetch**
 *   2. ⚠ **更根本的一条**：localStorage 是**按 origin** 分的
 *      （scheme + host + port）。自定义协议的 origin 是个实现细节，
 *      而 HTTP 的 `http://127.0.0.1:<固定端口>` 是**稳定的** —— 存档才有地方落。
 *
 * HTTP 的代价只有一个：一个只绑 **127.0.0.1（回环）** 的端口 ——
 * 回环监听不触发 Windows 防火墙询问（那是给对外接口弹的），
 * 而且壳有单实例锁，端口不会被抢。
 */
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { contentTypeOf, resolveAssetUrl } from './assets.ts'

/**
 * 造一个只服务 `root` 的服务器（**不 listen** —— 端口由调用方决定，
 * 这样测试里可以用 0 端口拿一个临时的）。
 */
export function createStaticServer(root: string): Server {
  return createServer((req, res) => {
    void (async () => {
      const file = resolveAssetUrl(root, req.url ?? '/')
      try {
        const info = await stat(file)
        if (info.isDirectory()) {
          res.writeHead(404).end('是一个目录')
          return
        }
        const body = await readFile(file)
        res.writeHead(200, {
          'content-type': contentTypeOf(file),
          // ⚠ 不缓存：改完内容 / 重编译客户端之后，刷新必须立刻生效
          //   （桌面壳里就是 Ctrl+R；缓存会让"改了没变"变成常态）
          'cache-control': 'no-store',
        })
        res.end(body)
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`找不到 ${req.url}`)
      }
    })()
  })
}
