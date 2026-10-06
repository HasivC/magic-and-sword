"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIME = void 0;
exports.resolveAssetUrl = resolveAssetUrl;
exports.contentTypeOf = contentTypeOf;
/**
 * **把内容端给窗口**：URL → 磁盘文件 + MIME。
 *
 * ## 为什么单独一个文件
 *
 * 同一套映射现在有**两个消费者**：
 *
 *   1. `src/cli/serve.ts` —— 开发/浏览器用的小静态服务器
 *   2. **桌面壳**（Electron / WebView2 那种，见 `docs/desktop.md`）——
 *      它要么起同一个服务器，要么用自定义协议 `app://` 直接读磁盘
 *
 * 两边各写一份的话迟早会漂移，而漂移的表现是**只有打包版才有的 bug**：
 * 开发时 `/content/xxx.json` 好好的，装成 .exe 之后 404 ——
 * 那种 bug 每次都要重新查一遍。所以映射规则只有这一份。
 *
 * ⚠ 它**不做 IO**（不读文件、不写响应），只回答两个问题：
 *   这个 URL 对应哪个文件？它的 content-type 是什么？
 *   这样两个消费者都能用，测试里也不用起服务器。
 */
const node_path_1 = require("node:path");
/** 扩展名 → content-type。没有的按二进制发 */
exports.MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
};
/**
 * URL → 磁盘路径。
 *
 * ```
 * /                       → <root>/web/index.html
 * /content/... /schema/... → <root>/content/...（内容按目录端出去）
 * 其他                     → <root>/web/...
 * ```
 *
 * ⚠ `/content/` 和 `/schema/` 是**按目录**端的，其他都从 `web/` 里找 ——
 *   这条规则和客户端里的 fetch 路径是**一对**：
 *   客户端写 `/content/manifest.json`，这里就必须把它映射到 `<root>/content/manifest.json`。
 *
 * ⚠ 越界保护是**按分支**做的（2026-09-21 收紧）：
 *   `/../secret.txt` 这种要挡住的不只是"跑出 root"，还有"跑出这一分支该在的目录" ——
 *   `web/../secret.txt` 会落到 `<root>/secret.txt`（还在 root 里，但已经不是 web 了），
 *   于是 `package.json` / `tsconfig.json` 这类东西会被端出去。
 *   现在的判据是"解析结果必须落在**这一分支的根**之下"，越界一律退回首页
 *   （不是 403：这个服务器只服务自己的资源，宁可给一个看起来正常的首页）。
 */
function resolveAssetUrl(root, urlPath) {
    const clean = decodeURIComponent(urlPath.split('?')[0] ?? '/');
    const home = (0, node_path_1.join)(root, 'web', 'index.html');
    if (clean === '/' || clean === '')
        return home;
    /*
     * 先定"这一条 URL 属于哪个分支"，再由分支决定它的根：
     *   /content/... → <root>/content
     *   /schema/...  → <root>/schema
     *   其他          → <root>/web
     * ⚠ 根要定到**子目录**，不能只定到 `<root>` ——
     *   否则 `/content/../package.json` 会落在 `<root>/package.json`：
     *   它确实还在 root 里，但它已经不是 content 了。
     */
    const seg = clean.split('/')[1] ?? '';
    const isContent = seg === 'content' || seg === 'schema';
    // 两个分支的拼接方式不一样（内容按 root 拼、其他按 web 拼），但**越界判据一样**：
    // 解析结果必须落在这一分支的根之下。
    const base = (0, node_path_1.normalize)((0, node_path_1.join)(root, isContent ? seg : 'web'));
    const safe = (0, node_path_1.normalize)(isContent ? (0, node_path_1.join)(root, clean) : (0, node_path_1.join)(base, clean));
    const inside = safe === base || safe.startsWith(base + node_path_1.sep);
    return inside ? safe : home;
}
/** 按扩展名给 content-type。认不出来的按二进制发 */
function contentTypeOf(file) {
    return exports.MIME[(0, node_path_1.extname)(file).toLowerCase()] ?? 'application/octet-stream';
}
