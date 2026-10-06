# 桌面壳的准备工作（真 .exe）+ 抽出浏览器和壳共用的资源映射

- **日期**：2026-09-21
- **触发**：玩家

  > 先做准备工作吧，我不想用目前的浏览器界面，而是实打实的exe和应用程序窗口，这样更有质感

- **动了哪些文件**
  - **新**：`src/server/assets.ts`（URL → 文件 + MIME，两个消费者共用）、`docs/desktop.md`（选型 + 搭法 + 打包注意）
  - 改：`src/cli/serve.ts`（改成调用那份映射，自己只管 HTTP）
  - 测试：`tests/web.ts`（7 条：映射 + content-type + 越界）

---

## 一、先摸机器（选型的事实基础，实查）

| 需要什么 | 结果 |
| --- | --- |
| Node / npm | **v24.21.0 / 11.19.0** ✓ |
| **Rust / cargo** | **没有** ✗（Tauri 要它） |
| .NET / dotnet | **没有** ✗（WebView2 + C# 要它） |
| **WebView2 运行时** | **有**（153.0.4234.48）✓ |
| Edge / Chrome | Edge ✓ / Chrome ✗ |

结论：**Electron 是唯一一条不需要装新工具链就能出真 .exe 的路**（这台机器有 Node）。
代价是 ~250MB 开发依赖 + 打包后 .exe ~80MB；**游戏本体不受影响**（仍然只有
`typescript` 和 `@types/node`），Electron 住在单独的 `desktop/` 里。
想要小（~10MB）就走 Tauri，但要先装 Rust —— **选择权留给玩家**，两条都能做。

## 二、抽出一份"URL → 文件"的映射（两个消费者共用）

壳要面临的第一件事：**内容怎么端给窗口**。现在这件事写死在 `src/cli/serve.ts` 里，
而壳（自定义协议 `app://`）也要同一套规则 —— 两边各写一份的话，
漂移的表现是"**只有打包版才 404**"：开发时好好的，发给别人就白屏。

所以抽出 `src/server/assets.ts`：只回答两个问题（哪个文件、什么 content-type），
**不做 IO**（不读文件、不写响应），两个消费者都能用，测试里也不用起服务器。

⚠ **顺手收紧了一个越界洞**（原来就在，不是这次引入的）：

```
/content/../package.json  →  以前：<root>/package.json   ← 能读到项目根的 package.json
                             现在：退回首页（挡住）
```

判据从"落在 `<root>` 之下"改成"落在**这一分支的根**之下"：
`/content/*` 必须落在 `<root>/content` 里、`/schema/*` 落在 `<root>/schema` 里、
其他落在 `<root>/web` 里。7 条测试钉着（`tests/web.ts`）。

## 三、壳的设计（和选型无关的部分，已经写进 `docs/desktop.md`）

- **用自定义协议，不要起本地 HTTP 服务器**：本地 HTTP 在 Windows 上会弹**防火墙询问**，
  而且还要处理端口冲突；自定义协议直接读磁盘，客户端**一行都不用改**
  （它只认 `/content/...` 这种根相对路径 ✓）
- 复用第二节那份映射 ✓；`contextIsolation: true` / `nodeIntegration: false`（客户端是纯浏览器代码）
- 快捷键：`F11` 全屏 / `Ctrl+R` 刷新（改完 `npm run build:web`）/ `Ctrl+Shift+I` 开发者工具
- 单实例锁、窗口尺寸记忆、图标、`extraResources` 放 `content/`

⚠ **打包时最容易漏的一条**：**存档不跟着走**。
现在存档在**浏览器的 localStorage**（`dsh.technique-system.save`），
换成 .exe 之后它落在 Electron 自己的 userData 目录 —— 玩家在浏览器里做的东西
**不会自动出现**。真打包时要做一个一次性的搬迁（术式编辑器已经有"导出/导入 JSON"，
也可以做个小页面读旧存档）。

## 四、阶段计划

| 阶段 | 做什么 | 状态 |
| --- | --- | --- |
| 0 | `npm run play`：Edge 的 `--app=` 独立窗口（零依赖） | ✅ 已有 |
| 1 | `desktop/` 里的 Electron 壳 + portable .exe | ⬜ 等玩家点头（要下 ~250MB） |
| 2 | 图标 / 标题 / 尺寸记忆 / 安装包 | ⬜ |
| 3 | 存档搬迁、自动更新、发布 | ⬜ |

---

## 验证

| 检查 | 结果 |
| --- | --- |
| `npm test` | 16 个文件全绿 · **1129 个断言**（新加 7） |
| `npm run validate` | 51 个文件 · 51 通过 · 0 失败 · 9 警告 |
| `npm run typecheck` | 两个 tsconfig 都干净 |
| 重构后的服务器**端到端** | 另起一个端口（5199）实跑：`/` 200、`/content/manifest.json` 200、`/dist/.../main.js` 200、越界请求 404 |

## 欠账

- 桌面壳阶段 1 **没动手**（要先定 Electron / Tauri）——这一轮只做了准备工作：选型依据、
  共用映射、越界修复、打包注意事项。
- 编辑器 UI 那边（玩家自己做设计）**在等线框**：见 `editor-ui-brief.md`；
  序列模型 B 的落地清单在 `sequence-model-plan.md`，和编辑器 UI 一起做。
