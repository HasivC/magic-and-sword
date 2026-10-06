# 屏障（真·长墙）+ 序列层推广到所有术式

- **日期**：2026-09-21
- **触发**：玩家对上一轮"积木核对"的回答：

  > 1，B，且玩家可以决定自己的子弹能否穿过墙（如果有反弹型子弹，这条就有用了）、
  > 敌人的子弹能否穿墙（用于获取点数），以及敌人和友方能否穿墙。
  > 2 要。
  > 3，之前定下来的"序列"机制只作用于武器技能，但现在我觉得应该也作用于魔法技能了，
  > 因为想实现二段技能只能用这种方法，让每条序列有不同的 CD。

  这一轮做完的是 **①（B 路：真·长墙）**、**②（两块通用积木）**、**③（序列推广）**，
  以及它们共同撑起来的**两个新技能**：「屏障」和「标记 · 瞬影」（二段）。

- **动了哪些文件**：
  - `schema/skill-schema.ts`（`EntityDef.kind: 'obstacle'`、`EntityShape`、
    `BlockPolicy`、`Skill.note` 的说明改写）
  - `src/sim/`：**新 `barrier.ts`**、`geom.ts`（`shapeClearance` / `pushOutOfShape`）、
    `types.ts`（`EntityKind: 'obstacle'`、`Entity.shape` / `block`、`blocked` 事件、
    `peekSequence`）、`projectile.ts`（撞墙 + 销毁子弹）、`world.ts`（第 8a 步
    `resolveBarriers`）、`status.ts`（`isHostile` 搬家）、`pipeline.ts`（spawn 屏障 +
    朝向）、`cast.ts`（序列层文档 + `peekSequence`）、`ai.ts`（走 pressSequence/peekSequence）
  - `src/pricing.ts`（`barrierPoints`：四个开关的账）
  - `content/entities/barrier.json`、`content/skills/barrier.json`、
    `content/techniques/barrier.json`、`content/manifest.json`
  - **二段技能那一组**：`content/skills/{mark,blink}.json`、
    `content/techniques/{mark-step,blink-step,mark-blink}.json`
  - `src/sim/targeting.ts`（`requireStatusTag`）、`pipeline.ts`（`anchor` / `side`）、
    `compile.ts`（`sequenceLinks` 进编译产物）
  - `web/src/main.ts`（画墙、HUD 的连段进度、按键走 `pressSequence`）、
    `web/src/leaves.ts`（`lifetime` 点表换了一格）
  - `tools/calibrate.ts`（屏障进 `NOT_FITTED`）
  - `tests/barrier.ts`（**新，27 条断言**）、`package.json`

## ① 屏障：一堵真的墙

### 它和"区域"的区别只有一条，但是本质的

| | `area`（火墙、迟滞场） | `obstacle`（屏障） |
| --- | --- | --- |
| 谁都能穿过去 | ✅ | ❌ **挡** —— 按策略挡子弹、也能挡人 |
| 进出的规则 | `onEnter` / `onLeave` | 不需要：它就是"过不去" |

### 四个开关，都由玩家决定

```jsonc
"block": {
  "ownProjectiles": true,    // 自己的子弹能不能穿过（默认 true = 放行）
  "enemyProjectiles": false, // 敌人的子弹（默认 false = 挡住）
  "ownUnits": true,          // 自己人（默认 true = 不挡人）
  "enemyUnits": true         // 敌人（默认 true）
}
```

⚠ **判定方式是"按阵营比出来的"**，不是四个开关随便配：
同阵营查 `own*`、敌对查 `enemy*`。所以召唤者被魅惑（改阵营）之后，
他的墙对新阵营来说仍然是"自己的墙" —— 和纪律 1 一致。

### 形状：线段，不是圆

```jsonc
"shape": { "kind": "segment", "length": 6, "width": 0.5 }   // 以实体朝向为轴
```

⚠ 一堵墙拿圆拼的话，圆和圆之间一定有缝，子弹从缝里钻过去 ——
而那看起来像"墙漏了"，作者会以为是判定写错了。

⚠ 判定只有**一份**（`geom.ts` 的 `shapeClearance`）：投射物撞墙和"把人推出去"
用的是同一个函数。分成两处写的话迟早出现"子弹被挡、人却穿过去"，
而两边各自的测试都会通过。

### 四个开关**进点数账**（玩家点名要的那条）

`pricing.ts` 的 `barrierPoints`：

| 开关 | 挡住 | 放行 |
| --- | --- | --- |
| `enemyProjectiles` | 收益（墙的本职） | 让掉本职 → 那笔收益不记（**拿回点数**） |
| `enemyUnits` | 收益（敌人过不来） | 不记 |
| `ownUnits` | 半分收益（挡追兵，也挡队友） | 不记 |
| `ownProjectiles` | **代价**（自己的子弹也被挡） | 不记 |

⚠ 途中改过一次**模型的错**，值得记：屏障一开始按召唤物计价
（血量池 + `summonBase`），结果一堵 120 血的墙在账上是 **−15 点** ——
想配平得写 80 秒冷却，等于它在内容里根本立不住。

根因是**重复计费**：召唤物的血量值钱是因为那具骷髅会打人，
而屏障不打人 —— 它的血量只是"挡子弹"的弹药，而"挡子弹"已经由
`barrierPoints` 买过一次了。现在屏障只算 `barrierPoints`。

⚠ 还改过一次**符号**的错：`barrierPoints` 返回的已经是账上的符号（负 = 收益），
我却把它塞进 `-(summonBase + barrierPoints)` 里又套了一层负号 ——
于是"挡住了"算成了"更便宜"。测试当场抓住了（四条方向断言）。

## ③ 序列层推广到所有术式

玩家要的是"二段技能"：**每条序列有自己的 CD**。

- 引擎侧本来就已经是通用的（每条序列**自己是一门术式**，冷却键是 `cd.<那一段>`），
  这一轮补的是**用它的地方**：
  - **按键**走 `pressSequence`（`main.ts` 的 `pressCast`）—— 挂了序列的术式
    按"放完才推进 / 150ms 缓冲 / 超时回第一条"走，没挂的照旧 `activate`
  - **AI** 也走 `pressSequence` + 新的 `peekSequence`（否则敌人学了二段技能只会放容器）
  - **HUD** 显示「第 2/2 段」，而且"能不能按"问的是**下一段**
    （序列术式的冷却在每一段上，容器自己没有冷却 —— 盯容器会一直显示可放）
- 新增 `peekSequence(world, caster, technique)`：**按一下会发生什么**（无副作用）。
  它是 HUD 和 AI 共用的预判，也是"这段在冷却里"唯一能提前知道的地方。

## ② 两块通用积木 + 第一个二段技能（同一轮的下一段）

玩家第 2 条说"要"，于是这一轮把两块积木补掉了：

### 积木一：**以目标为锚的落点**

```jsonc
{ "kind": "displacement", "mode": "teleport",
  "anchor": "target",     // 不写 = 'self'（沿施法者朝向走 N 米，老行为）
  "side": "behind",       // behind / front / left / right（以**目标**的朝向为准）
  "distance": { "const": 1.5 } }
```

⚠ `anchor: 'target'` 时**必须有目标**，没有就**什么都不发生** ——
不退化成"朝前闪"：那会让"标记丢了还瞬移出去"变成一种随机传送，
而玩家完全不知道为什么。

### 积木二：**按状态标签选目标**

```jsonc
"targeting": { "mode": "auto", "range": 30, "requireStatusTag": "marked" }
```

⚠ 没有这一条，第二段打的是"现在最近的那个" ——
稍微走位一下瞬移就会落到别人身后，而玩家以为自己标的是它。

### 顺手补上：序列条件门**运行时真的生效**

`sequenceLinks[i].if` 以前**只有校验器读**（写了等于没写，而且不报错）。
现在 `cast.ts` 的 `nextIndex` 会过门：不成立就跳过那一段、绕到下一段。

⚠ 这里有个坑：门上的条件常常是**关于目标**的（"那个目标身上有标记吗"），
而"目标是谁"是由**那一段自己的 targeting** 决定的 ——
所以过门时要先把那一段的瞄准解析一次，把 target 交给条件求值。
不然 `who: 'target'` 的条件永远拿不到 target，门永远不成立。

### 内容：`tech.mark-blink`（标记 · 瞬影）

| 文件 | 是什么 |
| --- | --- |
| `content/skills/mark.json` | 标记：给最近的敌人打 `marked` 标签（5 秒） |
| `content/techniques/mark-step.json` | **第一段**：`auto` 选最近的 —— **不写冷却**（玩家要的"不进 CD"） |
| `content/skills/blink.json` | 瞬影：`anchor: target` + `side: behind` |
| `content/techniques/blink-step.json` | **第二段**：`requireStatusTag: 'marked'`，**冷却 8 秒** |
| `content/techniques/mark-blink.json` | 容器：两条序列 + 条件门「目标身上有标记」+ 超时 3 秒 |

⚠ "两段各有各的冷却"不是特意做的功能，而是**序列层本来的形状**：
每条序列自己是一门术式，冷却的键是 `cd.<术式id>` ——
所以"这段不进冷却、那段进冷却"只要各写各的就行。

## 验证

```
npm test         ✓ 16 个测试文件 · 1032 个断言（新增 tests/barrier.ts 27 条、tests/blink.ts 25 条）
npm run validate ✓ 69 个文件 · 69 通过 · 0 失败 · 14 警告
npm run typecheck ✓ 两份 tsconfig 都干净
npm run calibrate ✓ 最大偏差 1.47（屏障进 NOT_FITTED，见下）
battle duel --duration 12 ✓ 逐字节一致
npm run build:web ✓ 页面 200
```

⚠ **标定器那一关**：屏障一开始参与拟合，最大偏差从 1.53 涨到 **2.76** ——
因为它那条轴（正面宽度 × 挡住什么）的单价是拍出来的（借的是范围那条汇率），
拿它去拽所有汇率会把别人一起拽歪。所以按老规矩进了 `NOT_FITTED`，
并写清"等玩过、把量级定下来再放它进来"。

## 意外发现的一个真 bug（**没修，先记账**）

`pipeline.ts` 发射投射物时读的是 `ctx.actor.facing`，**没有读**
`cast.facing`（`resolveAim` 算出来的那个）：

```ts
spawnProjectile(ctx.world, { pos: ctx.actor.pos, dir: ctx.actor.facing, ... })
```

- 对 `directional` 没影响：客户端会先 `player.facing = dir` 再施法（所以网页里一直是对的）
- 对 `locked` / `auto` **有影响**：引擎算出了"朝目标"，子弹却按施法者当时的朝向飞 ——
  **AI 的瞄准到不了子弹上**

改动是一行（`dir: ctx.cast?.facing ?? ctx.actor.facing`），但它会**改动 duel 的金标准数字**
（AI 的子弹会开始真的朝对手飞）。所以没有擅自改，先记在这里等拍板。

（`tests/barrier.ts` 里显式设了朝向 —— 那是客户端本来就在做的事，
为了让"屏障挡子弹"这件事被测到，而不是让测试顺带测另一个 bug。）

## 欠账

- **屏障的单价是待定的**：借的是 `areaRadiusPerMeter`（范围那条轴）。
  玩过之后如果觉得"墙太便宜/太贵"，动 `content/balance.json` 的那条汇率，不是公式。
- **`summonBase` 对屏障不收**：理由写进了 `pricing.ts`（它注释自己写着"还会打人"）。
  如果以后有"会打人的屏障"，这条要重新想。
- **两个新技能都没进任何场景**：想看它们得按 `Tab` → 术式页签 →
  把「屏障」或「标记 · 瞬影」装到一个键上。
  （技能栏只有十格，而 arena 已经满了 —— 键位重绑是后面的活。）
- 投射物朝向那个 bug（见上一节）。
- **点表宽度是中位数（五档）卡着的**：这一轮给它瘦过三张表
  （`angle` 剪 270、`hp` 剪 15、`lifetime` 换一格、屏障的宽度从 0.5 改成 0.6）——
  加内容会让中位数往上飘，而那条断言盯的就是这件事。
  ⚠ 下一次再加内容时，先跑一遍"每张表几个叶子在用这个宽度"的统计再动手。
- `sequenceLinks` 的门现在**只在"从上一段走过来"时判**（`index > 0`），
  第 0 段永远可以放 —— 这是"总得有个起点"的老约定，
  但"第一段也要有条件"（比如"没标记就不许出手"）现在表达不出来。
