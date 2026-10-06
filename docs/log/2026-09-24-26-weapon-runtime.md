# 武器运行时：能捡、能换、属性代入、左键会连招

- **日期**：2026-09-21
- **触发**：上一轮（[25](2026-09-24-25-weapon-and-sequence-data-model.md)）只做了数据模型和内容层，
  我说"数据齐了，但按左键还走不动"。玩家先提醒了一句：

  > 提醒，换武器的前提是武器有建模，能作为实体被交互。先做吧

  所以这一轮的第一件事不是输入层，而是**让武器在世界里存在**。
- **动了哪些文件**：
  - `schema/scenario-schema.ts`（`ScenarioEntity.kind: 'actor' | 'item'` + `weapon`）、
    `schema/skill-schema.ts`（`DeliverySpec.radius` / `length` 放宽成 `number | ValueSpec`）
  - `src/sim/`：**新 `equip.ts`**、`types.ts`（`EntityKind: 'item'`、`WeaponInstance`、
    `Entity.weapon` / `Entity.chain`、`CastInstance.speedScale` / `sequence`）、
    `world.ts`（spawn / snapshot）、`cast.ts`（**序列推进 + 攻速**）、
    `attributes.ts`（`weapon.*` 三个 ref）、`targeting.ts`（几何解析 ref）、
    `pipeline.ts`、`projectile.ts`
  - `src/scenario.ts`（武器 id → 运行时拷贝、`control: 'none'`）、
    `src/pricing.ts`（几何 ref 的兜底）、`src/describe.ts`、`src/validator/checks.ts`、
    `src/cli/validate.ts`、`src/cli/battle.ts`、`src/bridge.ts`
  - `web/src/main.ts`（左键、F 键、地上武器、HUD 武器行与连段进度）、`web/src/editor.ts`（只读技能不给改）
  - `content/weapons/iron-sword.json`、`content/techniques/iron-sword-basic.json`、
    `content/scenarios/arena.json`、`content/weapon-skills/*.json`、`content/manifest.json`
  - `tests/weapons.ts`（**60 → 72 断言**）、`tests/scenario.ts`、`tests/web.ts`
  - `docs/STRUCTURE.md`

## 改了什么

### 1. 武器是一个**实体**（玩家那句话的落点）

```jsonc
// content/scenarios/arena.json
{ "label": "长剑（地上）", "kind": "item", "faction": "neutral",
  "pos": { "x": 2.6, "y": 1.8 }, "weapon": "weapon.longsword" }
```

- `EntityKind` 多了一个 `'item'`：**掉在地上的一件东西**。
  它不动、不打、不挨打、不进区域 —— 只有一件事：能被捡起来。
- 捡起来走引擎：`pickupNearby()` / `equipItem()`（新文件 `src/sim/equip.ts`）。
  **换下来的那把掉在原地**（偏开 0.6 米，不然下一次按 F 会把刚丢的捡回来）。
- `control` 多了一档 `'none'`：地上的东西既不是玩家也不是 AI。
  不加这一档，一把剑会因为"没有 ai"被推断成 `human` —— 场景里出现两个玩家。
- 快照带上 `weapon` 和 `chain`：它们**决定伤害和下一刀是哪一招**，
  重放必须逐字节一致（测试里两条"跑两遍一模一样"钉着）。

### 2. 武器属性**真的代入**（`weapon.*` + 载体几何）

| 在哪 | 怎么读的 |
| --- | --- |
| 伤害 `amount: { ref: 'weapon.damage' }` | `attributes.ts` 的 `readRef` |
| 扇形半径 / 线形长度 `{ ref: 'weapon.reach' }` | `targeting.ts` 的命中判定、`pipeline.ts` 的事件、两者解同一个 ref |
| 攻速 `weapon.windup` | `CastInstance.speedScale`（见下） |

⚠ **载体几何放宽成 `number | ValueSpec`** 是这一步的关键改动：
`DeliverySpec.radius` / `length` 以前是裸 number，武器技能只能写死 3 米。
现在写 `{ ref: 'weapon.reach' }`，同一份横砍在铁剑（2.2）和长剑（3）上范围不同。

⚠ **读不到的兜底**：没武器 → `WEAPON_DEFAULTS`（reach 2.5 / damage 1 / windup 1）。
空手的敌人照样放得出技能，不会因为少配一把剑就变成打不到人。

⚠ 投射物的 `radius` 是**子弹自己的大小**，不是射程 —— 它只认数字，
写了 ref 会退到默认值并报一条 `GEOM_REF_IGNORED` 警告。

### 3. 攻速：`weapon.windup` 乘所有阶段时长

玩家定的是"术式级攻速倍率"。实现是 `CastInstance.speedScale`
在**施法瞬间**算一次并锁住：

- 乘在 `tickCast` 的 `cast.elapsed < phase.duration * cast.speedScale` 上
- **不在施法中途改**：挥到一半把剑换成匕首，这一刀不该突然变快 ——
  那会让"换武器"变成一种取消后摇的技巧
- 钳到 0.2 ~ 5：手写的 JSON 里 `windup: 0` 会让阶段时长变成 0，
  一 tick 走完整个术式

### 4. 输入层：左键那套连招（**全在模拟里**）

规则一条一条对应到代码（`cast.ts` 的"序列推进"一节）：

| 玩家原话 | 实现 |
| --- | --- |
| 按一次走一段 → 到底回绕 | `pressSequence()` + `chain.next = (index+1) % count` |
| **放完才走下一段** | 正在放的时候按键只写 `chain.bufferedTick`，不插队 |
| **150ms 缓冲** | 那一段结束时（`onSequenceEnd`）若缓冲还在窗口内就立刻接下一段 |
| 超时 1 秒回第一条 | `world.tick - chain.lastEndTick > timeoutTicks` → 段号归零 |

⚠ **为什么整块在 sim 里**：AI 也要能连招（AI 没有客户端）、
重放和将来局域网同步要走同一条路。客户端那侧只剩"我按了一下"。

⚠ 单槽缓冲（不是队列）：连点两下只多出一刀。
测试里那条"开头早按两下会过期作废"也是刻意的 ——
输入缓冲的用途是接住"提前一点点按下"，不是把两秒前的按键翻出来。

## 为什么

### 为什么先做实体，再做输入

玩家的提醒是对的，而且理由比"顺序"更深一层：
如果武器只是角色身上的几个数字，那么**"换武器"就只能是一个菜单**。
它在世界里不存在，AI 不会去捡，地图上没有值得为之走过去的理由，
"打到一个好武器"这件事也就无从发生。先让它站在地上，后面所有玩法才有地方长。

### 为什么 `control: 'none'` 而不是"item 也算 AI"

因为它**真的什么都不做**。把它算成 AI 的话，
将来 AI 的"找最近的目标"、"要不要救人"这些判断里都要多一个
"这不是个人"的特判 —— 而现在这个问题在装配层就被消掉了。

### 为什么攻速锁在施法瞬间，而不是每 tick 读武器

两个理由：一是动画已经播了一半，中途变速说不清；
二是**"换武器"不该是一种取消后摇的技巧** —— 那种技巧会让最优解变成
"每次快收招时换一下武器"，而那不是我们想做的深度。

## 验证

```
npm test         ✓ 14 个测试文件 · 945 个断言（tests/weapons.ts 从 36 涨到 72）
npm run validate ✓ 62 个文件 · 62 通过 · 0 失败 · 14 警告
npm run typecheck ✓ 两份 tsconfig 都干净
npm run calibrate ✓ 最大偏差 1.53（容差 2）
battle duel --duration 12 ✓ 逐字节一致：剑士 67.6/300 造成 129、法师 71/200 造成 232.4、施法 5/8 次
npm run build:web ✓ 页面 200（服务器仍在 5173）
```

⚠ **duel 逐字节一致**这条这次特别有意义：duel 里两个 AI 都没武器，
所以攻速倍率恒为 1、几何 ref 一个都没用到 ——
"没配武器的人和以前一模一样"是被证明的，不是被假设的。

这一轮新钉住的断言（`tests/weapons.ts`）里，值得单独说的几条：

- 2.9 米处**长剑够得着、铁剑够不着**（差的就是 `weapon.reach` 那 0.8 米）
- 同一份横砍模板，长剑打得比铁剑疼（`weapon.damage` 代入）
- 连点两下只多出一刀；开头早按的**会过期作废**
- 隔 2 秒再按回到第一段（超时）；一段一段按会回绕
- **一段被打断**后两条路都测了：有缓冲 → 打断当场接上下一条；
  没缓冲 → **下一次按键**走的是下一条序列（不是回到第一条）
- 同一串按键跑两遍快照逐字节一致

## 欠账

- **魔法术式槽还没接**：`WeaponDef.magicTechnique` 这一格有类型、没内容也没入口。
  按玩家的"两个槽都进技能栏、玩家自己绑键"，它该是**技能栏里的一个普通格子** ——
  而技能栏的绑键重构（含键位重映射）是单独一轮。
- **AI 还不会捡武器、也不会连招**：数据都在（`chain` 在实体上、`pressSequence` 在引擎里），
  但 `ai.ts` 没调用。等有"敌人也拿武器"的内容时一起做。
- **左键只是默认绑法**：现在左键直接查手上的武器，**还不能改绑**。
  玩家明确要的是"可以重绑"，那是键位那一轮。
- **编辑器还不认序列**：`chainOf(t)` 只是让编辑器别炸（16 处收口），
  序列的编辑界面（加一段、调超时、看每段的账）还没做。
- **被打断时走哪条序列**（玩家 2026-09-21 确认）：一段序列被中途打断，
  手上那条链记着的仍然是**下一条序列** —— 所以**下一次攻击激活的是下一条**，
  不回到第一条。反过来的做法（"挨打就回到第一段"）会让被围攻时连招永远接不起来。
  ⚠ 我第一版把这条写成"招式断了，连段没断"，措辞含糊 ——
  准的说法是"**单段被打断后，下次攻击激活下一条序列**"。
- **`weapon.*` 只被武器技能用**：玩家自己做的技能里写 `ref: 'weapon.damage'` 也读得到
  （用的是他手上那把），这条是顺带成立的，但**没有内容验证过**。
