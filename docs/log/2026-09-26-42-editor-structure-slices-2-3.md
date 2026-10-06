# 编辑器结构改造·第二三片：一块一块挂 + 怎么改布局

- **日期**：2026-09-21
- **触发**：玩家选了"先做结构"之后，接着定：

  > 先做2和3。我如何修改布局呢？

  即：把"逐块挂载"和"数值就地更新"做完，并且**给出一条能照着走的改布局流程**。

- **动了哪些文件**
  - `web/src/ui/dom.ts`（`mountBlock` / `endBlocks` / `applyValues`）
  - `web/src/technique-editor.ts`（术式页 → 5 块）
  - `web/src/editor.ts`（技能页 → 7 块）
  - 测试：`tests/web.ts`（6 条挂块机制的断言）
  - 文档：`docs/editor-ui-brief.md`（**怎么改布局**：四条路 + 别碰清单）

---

## 一、两块页面怎么改的

**术式页**（`technique-editor.ts`）：5 块
`bar` / `meta` / `chain`（含段间门）/ `library` / `ledger`

**技能页**（`editor.ts`）：7 块
`head` / `points`（账）/ `rules`（固有效果 + 规则 + 可加技能）/
`leaves`（数值明细）/ `phases` / `issues` / `export`

手法是**"攒到边界就挂"**：

```ts
function flush(key: string): void {          // 技能页
  if (parts.length === 0) return
  mountBlock(body, key, parts.join(''))
  parts.length = 0                           // 交给下一块
}
```

⚠ 为什么不重排那两百行：**改动小、边界一眼看得见**。原来那句
`body.innerHTML = parts.join('')` 换成最后一次 `flush` + `endBlocks(...)`。

⚠ `mountBlock` **自动给块打 `data-block`**：模板函数不用自己写。
   不这么做的话，改布局时漏掉属性 → 找不到旧块 → **每次重画都多出一块**（越堆越多），
   而且很难看出为什么。

## 二、⚠ 假 DOM 又咬了一口（第二个坑，已修并有测试）

`mountBlock` 第一版在"造不出元素"时**抛** ✗ —— 而测试的假 DOM
`innerHTML` 只是个字符串（不解析、没有 `firstElementChild`），于是整个 boot 炸掉、
报出来却是"客户端加载失败"（27 个断言一起红）。

修法：**解析不出元素就降级** —— 把 html 攒进缓冲区，`endBlocks` 时一次性写上
（假 DOM 里测试本来就只读 `innerHTML` 字符串 ✓ 所以断言照样有意义），
真实浏览器走挂块那条路 ✓。

⚠ 顺带一个教训：第一版还写了"先造一个试一下能不能解析"的**探测** ✗ ——
那会在假 DOM 上多造一个元素，让"造了几个"这种断言没法写。
现在的判据是"**造出来发现解析不了就降级**"，不探测 ✓。

## 三、验证挂块机制（真 DOM 我这边跑不了）

沙箱里起不了浏览器，所以造了一个"**能造元素、不解析 html**"的假 host，
测 `mountBlock` 的**决定逻辑**（6 条断言）：

| 断言 | 防的是 |
| --- | --- |
| `data-block` 自动打上 | 漏属性 → 每帧多一块 |
| 第一次挂：造一个 | —— |
| **同样的 html 再挂：一个都没造** | "明明没变却重建" → `<details>` 合上、动效重来 |
| html 变了才换一块 | —— |
| 是**替换**不是再 append | 越堆越多 |
| 这一轮没挂的块被删掉 | 界面上留着不属于当前状态的东西 |

## 四、给玩家的"怎么改布局"（写进交接单了）

| 路 | 做什么 | 动哪儿 |
| --- | --- | --- |
| 1 换皮 | 颜色/字号/间距/圆角/布局 | `web/index.html` 的 `<style>`（F12 里试，抄回去） |
| 2 挪块 | 换块顺序 | `renderAllInner()` / `renderInner()` 里那几行 `mountBlock`/`flush` 调换位置 |
| 3 改块内排布 | 改那段 html | `barHtml()` / `metaHtml()` / `segmentHtml()` / `gateHtml()` / `libraryHtml()` / `renderLedger()` / `introHtml()` / `coolDownTiming()` / `ruleRow()`… |
| 4 加一块 | 写个返回 html 的函数 + 挂上 | ⚠ **必须把 key 加进 `endBlocks` 的清单**，否则每次重画都会被删 |
| 5 动效/拖拽 | 让"会变的数"不重建 | 元素上写 `data-v="名字"` + 渲染时 `applyValues(body, {名字: 值})` |

别碰：`data-block`（自动的）、`data-act`（事件靠它）、测试依赖的 7 个 id、
`data-hud-*`、以及几个被断言的中文词（`术式栏` / `基础技能库` / `进入第 N 段` / `放不出来`…）。

---

## 验证

| 检查 | 结果 |
| --- | --- |
| `npm test` | 16 个文件全绿 · **1141 个断言**（新加 6 条挂块机制） |
| `npm run validate` | 51 个文件 · 51 通过 · 0 失败 · 9 警告 |
| `npm run typecheck` | 两个 tsconfig 都干净 |
| 打包 | ⚠ 没重打（玩家的 .exe 窗口开着，`out/` 被锁）；浏览器里迭代不受影响 |

## 欠账

- **`applyValues` 还没接到页面上**（工具就位）：技能页拖滑块本来就是就地更新 ✓，
  所以现在**动效/拖拽已经立得住**；哪一块需要"值变但结构不重建"，按第三条第 5 路接就行。
- 重新打包 .exe（等玩家关窗口）。
- 序列模型 B（`sequence-model-plan.md`）仍在队列里 —— 它要等编辑器 UI 的形状定下来一起做。
