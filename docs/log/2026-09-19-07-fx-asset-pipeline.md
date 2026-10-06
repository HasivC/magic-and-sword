# 特效素材管线：AE 能用，路修好了

- **日期**：2026-09-19
- **触发**：玩家说「你的特效我不喜欢，教教我怎么自己做特效，我手上有 AE，能用吗」
- **动了哪些文件**：`web/src/assets.ts`（新）、`web/src/fx.ts`（加序列帧）、
  `web/src/main.ts`（接线）、`schema/skill-schema.ts`（`DeliverySpec.vfx`）、
  `src/sim/types.ts` + `pipeline.ts`（事件带 vfx）、`content/fx/`（新，示例素材）、
  `content/manifest.json`、`content/skills/cleave.json`、
  `tools/png.ts` + `tools/raster.ts` + `tools/make-sample-fx.ts`（新）、
  `tests/fx.ts`、`tests/smoke.ts`、`docs/fx-authoring.md`（新）、
  `src/loader.ts`（BOM）

## 改了什么

### 1. 先把结论说清楚：AE 能用，走 PNG 序列帧

三条路里只有一条适合 2D 战斗特效：

| 路线 | 判断 |
|---|---|
| **PNG 序列帧** | ✅ 走这条 |
| Lottie | ❌ **AE 的 Glow / 混合模式 / 粒子它都不支持**，导出后效果直接消失，而且不报错 |
| 视频 / GIF | ❌ 没有 alpha、不能加色混合 |

### 2. 补上那条一直缺的路：客户端**根本不能加载图片**

查出来的事实：`web/src/` 里**一处 `Image()` 都没有**。
也就是说，玩家在 AE 里做的一切，游戏都读不了。

新增：
- `web/src/assets.ts` —— 读特效定义 + 逐帧加载，**单条失败不影响能玩**
- `web/src/fx.ts` 的序列帧部分 —— `SpriteFx`、`spriteFrameIndex`、播放/绘制
- `DeliverySpec.vfx` —— 技能里写 `"vfx": "fx.slash"` 就用作者的素材
- `deliveryFired` 事件带上 `vfx`

**两条路线并存**：写了 `vfx` 用序列帧，没写就用程序化兜底。
素材没做好之前游戏照样能跑，加了新载体也不会变成隐形的。

### 3. 生成示例素材，让管线今天就通

`tools/make-sample-fx.ts` 把程序化刀光烘焙成 24 张 PNG（384×384，64px/米）
写进 `content/fx/slash/`，配一份 JSON。裂地斩已经指向它。

**这是占位素材**，作用是验证命名、帧数、比例、锚点、混合模式的约定是对的 ——
玩家把 PNG 换掉就行，**JSON 和代码一行都不用动**。

为此把 PNG 编码器和光栅化器抽成了共享模块（`tools/png.ts` / `tools/raster.ts`），
顺便给光栅化器加了**包围盒裁剪**（24 片拖尾不裁剪要扫 24 遍全屏）。

### 4. 顺手修掉一个踩过两次的坑

PowerShell 的 `Set-Content -Encoding utf8` 会往文件开头塞 UTF-8 BOM，
而 `JSON.parse` 见了它抛 `Unexpected token ''` —— **报错信息完全看不出原因**。

这个坑项目里踩过两次（手写内容一次、工具脚本一次），所以这次在
`readJson` 里一次性挡掉：**BOM 是合法的 UTF-8，不该算 JSON 语法错误。**

### 5. 写了给玩家看的手册

`docs/fx-authoring.md`：三条路怎么选、**AE 逐步导出设置**、
`pxPerMeter` 和 `meters` 的区别（最容易搞错的一处）、
alpha 两种做法怎么选、五条硬约束、**建议从"命中火花"开始练手**。

## 为什么

- 玩家说"不喜欢"是对的：程序化只能做"一个形状换个颜色"，
  真要有味道得靠作者做的图。**这不是我该争的事，是该给工具的事。**
- 但是"给 AE 导出"这件事的前提是**游戏得能读图** —— 而它不能。
  所以这一轮的真活是**修管线**，不是画特效。
- 两条路线并存而不是替换：程序化的东西不用画，杂兵和临时效果继续用它。

## 验证

`typecheck` 0 错 · `npm test` **525 个断言**全绿
（`tests/fx.ts` 从 51 → 71，新增序列帧时序 + **"定义里的帧数必须等于磁盘上的 PNG 数量"**）·
`validate` 15/15 · 纯净性 14 文件 ·
服务器上 `/content/fx/slash.json`、第 1 帧、第 24 帧、`assets.js`、`fx.js` 全部 200。

测试抓到一个真 bug：`spriteDone` 用 `2n` 算来回播的时长，
`spriteFrameIndex` 用 `2n-2` —— 会出现"画面停在最后一帧、特效还没被回收"。
现在两处共用一个 `spriteSteps()`。

## 欠账

- **图集打包没做**：现在是一帧一个文件，一条 24 帧的特效是 24 个请求。
  十条特效就是 240 个请求。等特效多起来要打包成一张图 + JSON 索引
- **序列帧没有程序化的火星**：用了 `vfx` 就只有作者画的那叠图
- **没有素材检查器**：帧数对不对有测试管，但"画布够不够大、有没有裁切"
  只能靠眼睛看
- `StatusDef.vfx` 还是死字段
