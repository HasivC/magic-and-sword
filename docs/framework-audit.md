# 框架审计：多余的东西、以及"承诺了但没做"的东西

- **日期**：2026-09-20
- **触发**：玩家说「目前你的重心不是做新技能，而是做好引擎和框架，让这个框架能承载各种技能。
  现在制作的技能是用来测试框架的，以后会把它们删除。**检查是否有多余的、未来用不到的东西**」
- **这份文档回答的**：schema 向技能作者承诺了什么，引擎实际做到了什么，差距在哪

## 为什么要按"承诺 vs 实现"来查

技能是**照着 schema 写**的。所以最坏的东西不是"没实现"，
而是**声明了、校验器放行了、说明生成器还会为它写一句话，但引擎从来不读**——
写技能的人会以为它生效了。

这一类已经陆续抓到五个：

| 抓到的 | 症状 |
|---|---|
| `visibility` | `visibilityOf()` 算出来了，没有任何地方消费；熔岩护甲那条 `visibility: 1` 是空操作 |
| `EntityDef` | 整个类型零引用（因为 `spawn` 会 throw） |
| `hasStatusTag()` | 函数实现了，没有任何条件类型能调到它 |
| `immuneTags` | 定价里一个字没提（免疫控制是免费的） |
| `位置/感知/召唤` 三个载荷 | schema 认、校验器认、describe 写得出人话，`pipeline.ts` 直接 throw |

所以这一轮不再靠"感觉哪里不对"，写了两个**可重跑**的审计脚本。

## 审计方法

| 脚本 | 问的问题 |
|---|---|
| `.scratch/audit-fields.mjs` | schema 里每个**字段**，引擎读不读 |
| `.scratch/audit-enums.mjs` | 每个 union 的每个**取值**，引擎认不认 |
| `.scratch/audit-exports.mjs` | 每个**导出**，有没有调用点 |

两个坑（都踩了，都写进脚本注释了）：

1. **字段审计必须去注释**。这个仓库的注释里到处在提字段名，不去掉全是假阳性。
2. **枚举审计必须保留字符串**。第一版连字符串一起去掉了，然后拿 `'press'` 去搜 ——
   于是**所有**取值都"一处都没出现"，包括明明实现了的。枚举取值在代码里**就是字符串**。
3. **导出审计的定义方和消费方不是同一批文件**。第一版没算 `tests/` 和 `tools/`，
   于是 `resolveHit` / `createHit` / `advance` / `snapshot` 这些测试天天在用的东西
   全被报成"零调用"（71 个里大半是假的）。

去注释那段还顺手写了「只对 `//` 和 `/*`，保留 `'` / `"` / `` ` ``」的状态机 ——
字符串里的 `//`（URL）不能当注释。

## 发现一：惰性字段（最危险的一类）

**引擎一处都不读，但校验器认真检查、说明生成器还会写出一句话。**

| 字段 | 现状 | 说明 |
|---|---|---|
| `TargetingMode`（`self`/`directional`/`locked`/`auto`/`areapoint`） | **5 个取值全部惰性** | `targeting.mode` 只出现在 schema、校验器白名单、和一个测试 fixture 里。引擎**从不分支** —— 真正决定打谁的是 `valid` + `delivery` + 调用方给的朝向/锁定目标 |
| `DeliverySpec.homing` | 惰性，**而且说明生成器会写出「追踪」** | 比惰性更糟：界面在承诺引擎做不到的事 |
| `StatusDef.vfx` | 惰性，**出厂内容里有 15 处** | 它自己的注释写着「玩家必须能一眼看出身上有什么」。现实是：挂上状态**没有任何视觉表现**，HUD 里只有一行字 |
| `Phase.locks` | 惰性 | 出厂内容里就有一处：`charged-laser` 蓄力时 `locks: ['turn']`（**不该能转头**）—— 实际照样能转 |
| `HealPayload.blockable` | 惰性 | 已删（见下） |
| `AiProfile.behaviors` | 惰性 | 已删（见下） |
| `AiProfile.targetFaction` | 惰性 | 它的类型是**单值字面量** `'enemyOfSelf'`，AI 不分支 |
| `EntityDef.baseZ` | 惰性 | 浮空单位的视觉 z 基准，没人读 |
| `Cost.bloodPact` | 惰性 | 血契还没实现（玩家已明确它是延申机制，所以这个先留着） |

### 已做的处理：让它们**出声**

删掉一个字段是"以后不用了"，但像 `locks` / `homing` / `StatusDef.vfx` 是**该做而没做**——
删掉会把设计意图一起丢掉。所以这一类加的是**校验器警告**：

```
! 警告 [INERT_FIELD] phases[0].locks
    阶段上的 locks 引擎不读
    「这个阶段锁住哪些能力」还没实现 —— 写上去角色不会被定住。
    要定住人请用状态（disables）。

! 警告 [TARGETING_MODE_INERT] targeting.mode
    targeting.mode 是 "areapoint"，但引擎目前不读这个字段
```

- `npm run validate` 的警告从 **4 条涨到 17 条** —— 这 13 条全是以前**看不见**的真问题
- 加完立刻抓到两个：`charged-laser` 的 `locks`（作者以为是定身的），
  以及 15 处 `vfx`（作者以为会有视觉表现）

**这是这次审计最有价值的产出**：不是删掉了多少行，而是把 13 个静默的谎变成了 13 条会说话的警告。

## 发现二：孤儿类型（零引用，已删）

| 类型 | 为什么删 |
|---|---|
| `StatusDisable { capability }` | **全仓库零引用**。而且 `StatusDef.disables` 早就改成了裸的 `Capability[]`，根本不用包一层对象。留着只会让人以为两种写法都行 |
| `AiProfile.behaviors` | 注释写着"目前没用到，留着给以后的行为树"—— 没有任何计划，行为树是个很大的"也许" |
| `HealPayload.blockable` | 没计划、没消费者；而且它想要的语义（治疗被拦截）在引擎里本来就不成立 |
| `checkStatusRefs()` | **我自己上一轮留下的兼容壳**。所有调用方都迁到 `checkRefs` 之后它零调用 —— 典型的"为了不破坏调用方"结果一个调用方都没有 |

## 发现三：一整层"没引擎的内容层"

这些类型在 `skill-schema.ts` 里，**引擎里出现 0 次**：

| 类型 | 章节 |
|---|---|
| `WeaponDef`（武器：基础属性 + 连段 + 铭刻槽） | §11 |
| `ComboChain` / `ComboStep`（近战连段） | §11 |
| `Combo`（可分享的组合技） | ~~§10~~ —— **后来整个删掉了，不是挪走**。玩家澄清："没有组合技这个概念，分享码是术式的"。术式自己就是"若干技能编程组合出来的东西"，见 `PLANNED.md` §零 |
| `SkillSource`（技能槽的提供者）+ `slots` / `weaponId` | §12 |
| `Build`（构筑：技能来源 + 血契）+ `sources` / `bloodPact` | §13 |

加起来是 schema 的**最后三节**，约 120 行。玩家说过「meta/Build 层（构筑）不紧急」——
所以它们不是"错了"，是**排期在后面**。

**但我建议把它们从代码 schema 里挪出去**，理由是方法论上的：
schema 是"技能作者照着写的东西"，而作者照着写了就会期待它生效。
一个没有任何引擎实现的类型，放在 schema 里就是一张空头支票。

> 建议：挪到 `schema/PLANNED.md`（或 docs 下的设计稿），标题写清楚
> 「**以下是计划，引擎还没实现**」。等真做的时候再挪回来。
> 这样 `skill-schema.ts` 里剩下的每一样东西都是**现在就能用的**。

## 发现四：零调用的导出（46 个）

审计报出 46 个在 `src/ + web/src/ + tests/ + tools/` 里都没有调用点的导出。
但**不能一律删** —— 要分三类：

| 类别 | 例子 | 建议 |
|---|---|---|
| **真冗余** | `checkStatusRefs`（已删）、`installLibrary`（battle 改用 applyScenario 之后就没人调了） | 删 |
| **框架 API，暂时没消费者** | `findAlly`（找最近的同类 —— 召唤/治疗用）、`nextInt` / `nextRange` / `pickWeighted`（AI 决策、掉落）、`despawn`（清理）、`isTechniqueActive`、`cooldownRemaining`、`heightDelta` | **留**。这是给未来技能准备的表面，而且都很小 |
| **不该导出的内部件** | `cosDegrees`、`isPipelinePath`、`writePipelineAttr`、`collectHooks`、`VALID_SELF/ALLY/ENEMY/ANY`、`labelFor` / `unitFor` / `semanticKey`、`drawPrims` | 去掉 `export` 即可（它们只在自己文件里用） |

第二类和第三类的界线是**"这个函数是不是引擎完整能力的一部分"**：
`findAlly` 不是多余 —— 没有它，"治疗友军"和"召唤物跟随"这类技能写不出来。
`cosDegrees` 就只是 `targeting.ts` 的实现细节。

## 这次实际改了什么

- **删**：`StatusDisable`、`AiProfile.behaviors`、`HealPayload.blockable`、`checkStatusRefs`
- **加**：`INERT_FIELD` 警告（`locks` / `homing` / `StatusDef.vfx`）
  + `TARGETING_MODE_INERT` 警告（`areapoint` / `auto`）
- **加**：三个可重跑的审计脚本（`.scratch/audit-*.mjs`）

## 需要你拍板的三件事

1. **`targeting.mode` 怎么办？** 它是这一轮最大的发现：**框架里技能"怎么瞄准"这件事是空的**。
   五种模式全是惰性，引擎只认 `valid` + `delivery`。要承载"点地面放技能"（`areapoint`）
   和"自动选最近的敌人"（`auto`），得真的做目标选择那一层。
   **这是"让框架能承载各种技能"最实的一块缺口**，我建议优先做它。
   另一条路是把模式砍到三种（只留和现状对得上的），但那样框架就少了一块能力。

2. **状态要不要有视觉表现？** 现在挂上状态在界面上只有一行字。
   `StatusDef.vfx` 承诺了但没做，出厂内容里 15 处写了它。
   要做的话路是通的（和载具特效一样：事件带上 vfx → 客户端找素材），
   但需要你出素材 —— 所以这可能是"先不做，先把 15 处 `vfx` 删掉"更实在。

3. **`WeaponDef` / `ComboChain` / `Combo` / `SkillSource` / `Build` 挪不挪出去？**
   我的建议是挪（见上）。它们是设计意图，不该待在"照着写就能用"的 schema 里。

## 玩家的答复（2026-09-21）

> 「1，真的做出来。2要。3搬」

1. **`targeting.mode` 真的做出来** ✅ —— 五种模式全部接上引擎。
   点地面（`areapoint`）现在真的是"往那一点打"，
   自动选敌（`auto`）真的会自己挑最近的，`locked` 真的会把朝向钉在施法那一刻。
2. **状态要有视觉表现** ✅ —— 状态光环画出来了，按"硬控 → 软控 → 护盾 → 持续伤害 → 诅咒 → 减益 → 增益"
   分了几种颜色和形状，挂上的瞬间有一圈扩散。
3. **`WeaponDef` / `ComboChain` / `SkillSource` / `Build` 搬出去** ✅ —— 搬进 `schema/PLANNED.md`。
   **`Combo` 不搬，直接删**（理由见上面那行）。

### ⚠ 后续更新（2026-09-21，审计之后）

上表里"引擎里出现 0 次"这件事**已经过期了一半**，别照它下判断：

| 类型 | 现在 |
| --- | --- |
| `WeaponDef` | **搬回 schema 了**（§11 之二），有内容（`content/weapons/longsword.json`）和引擎读取路径 |
| `SkillSource` | **搬回 schema 了**。⚠ 但**还没有消费者** —— 武器还没装到人身上，所以"零引用"这条对它依然成立 |
| `ComboChain` | **不搬回来了**：被**序列层**取代（`Technique.sequences` / `sequenceLinks` / `sequenceTimeout`）。连段里那些"输入窗口 / 取消窗口"的时间数字，现在是阶段自己的 `cancellable` / `interrupt` |
| `Build` | 仍然在 `PLANNED.md`（差"多个来源的聚合"这个结构本身） |

判据没变，还是这一句：**引擎里真的有代码读它了**。
见 [`log/2026-09-24-25`](log/2026-09-24-25-weapon-and-sequence-data-model.md)。

补一条审计当时没查出来的：`targeting.mode` 只是"惰性"里最显眼的一个。
同一类问题在**载荷层**也有 —— 比如"任何载荷都能当投射物"这件事以前不成立，
只有 `damage` 能飞出去，`status` 写了 `delivery: projectile` 会被静默地就地生效。

## 怎么重跑这份审计

```bash
node .scratch/audit-fields.mjs     # 每个字段有没有人读
node .scratch/audit-enums.mjs      # 每个取值有没有人认
node .scratch/audit-exports.mjs    # 每个导出有没有人调
npm run validate                   # 惰性字段的警告会在这里冒出来
```

`npm run overview` 是另一件事：它查的是**内容覆盖率**（哪些机制还没有内容），
和这三个脚本（查**代码承诺**）互补。
