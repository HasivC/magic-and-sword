# 「载体消失」接上线（触发器的真默认条件）+ 「必须写条件」那条判据松掉 + 删掉死字段 `delivery.count`

- **日期**：2026-09-30
- **触发**：玩家点名的默认值 —— **上一次施法放出去的那个东西消失 / 到期 / 被打掉时，触发挂在那个技能上的触发器副本**（Noita 那种**引信**）。日志 54 第 7 节把它**单独记成一笔引擎工作**（"**缺机制**"），这一片把那笔账还了。
- ⚠⚠ **上级 2026-09-30 当轮裁了三条 + 追加一条**（第 9 节逐条记着）：
  - **① 多载体 = 「全部消失才算」** —— **接受**（理由见第 5 节）；
  - **② `onRemoved` 不许静默** —— 指令原话："**不要留成"写上去不生效且不吭声"** ✗ —— 那正是这一整轮在清的那一类"。两条路挑小的，**这一片走 (b)：从"已接线"那张表里拿掉它**（第 6 节，诚实 > 静默）；
  - **③ 删掉死字段 `delivery.count`** —— 理由原话："份数今天已经有唯一一条路（一分为 X）⇒ 留着它就是**第二个真相**"（**已删**，见第 9 节③）。
  - **④ `homing`（追踪）：先把假话拿掉**（我上一轮顺路发现、报上去；上级当轮裁了**第一步**，
    原话"**立刻把那句假话拿掉** ✗ —— 比 `count` 更糟：`count` 只是白写 ✓ 这个是**骗人** ✓"）
    ⇒ 描述里不再写「追踪」+ 写它**报 error**（**已做**，见第 9 节④）。
    ⚠⚠ **第二步「追踪」做还是删 —— 上级在问玩家，这一片没做**。
- **动了哪些文件**：
  - `src/sim/`：`mod-state.ts`（载体台账：`CarrierOrigin` / `recordCarrier` / `carrierBegun` / `allCarriersGone` / `expiredCarriers`）、`trigger.ts`（**新增 `sweepCarriersGone`** + 把遍历 / 解算名单抽成 `driveModifierCopies`，两条路共用；⚠ **`onRemoved` 从 `WIRED_TRIGGER_EVENTS` 里拿掉**）、`world.ts`（第 **11b** 步调它）、`pipeline.ts`（`carrierOriginOf` + 两处造载体的地方记一笔）、`projectile.ts`（**没改** —— 投射物是从 `pipeline` 记的）、`cast.ts`（`ActivateOptions.homeTechnique` + 把它放进 `CastInstance`）、`types.ts`（`CastInstance.homeTechnique`）
  - `content/`：`modifiers/trigger-on-cast.json`（`when` / `paramsTemplate.when` 默认 → **`onExpire`**；`condition` 不写 = 「载体消失」；`_comment` 重写 —— 含"`onRemoved` 故意没接"那一段）
  - `src/`：`validator/index.ts`（**删掉 `MODIFIER_CONDITION_REQUIRED`**，只留 `MODIFIER_EMPTY_CONDITION`）、`validator/checks.ts`（⚠ **`onRemoved` 的警告里直接指路 `onExpire`**；⚠ **`delivery.count` 从死字段表里拿掉、改成指名道姓的 `BAD_DELIVERY` 报错**；⚠ **`homing` 从警告升成 `INERT_FIELD` 报错**）、`school.ts`（注释口径）、`describe.ts`（删掉拼 "N 发" 那一行 + ⚠ **删掉假话「追踪」**）
  - `schema/`：`skill-schema.ts`（**删掉 `DeliverySpec.count`**，原地留一段"它为什么被删"的注解；⚠ **`homing` 那段注解写清"声明了但引擎不读、而且它会骗人"**）
  - `tests/`：`scenario.ts`（**新第 55 节** + `quietWorld` 补注册实体预设 + `triggerEvents` 助手）、`weapons.ts`（第 ② 条**反过来** + **新 ⑥ 组 3 条**钉 `onRemoved` 必须出声）、`smoke.ts`（**新 `checkDeliveryCountRemoved`** 钉删掉的那个字段会报错并指路 + **新 `checkHomingDoesNotLie`** 钉"描述里不许有「追踪」、写了它报 error 且说清不生效"）
  - 文档：这一份 + `docs/log/README.md` 一行 + `technique-system/README.md` / `docs/STRUCTURE.md` 的计数
- ⚠ **`web/src/` 一个字节没动**（玩家硬命令）；瞄准 / CD 名牌 / 已落地零件（触发器·监测器·常驻包装·多重释放·一分为 X·等待·排布）的语义**一个都没动**；**内容里现有数值一个都没改**（`trigger-on-cast.json` 只动了默认值那一栏 + 注释；`delivery.count` 出厂内容里**一处都没写**，所以没有内容要改）

## 1. 先摸清的两条路径（这是这一片最先要给的东西）

| | 入口 | 备注 |
| --- | --- | --- |
| **创建**（投射物） | `pipeline.ts` 的 `spawnProjectileFrom` → `projectile.ts` 的 `spawnProjectile`（`projectile.ts:220` 的 `spawn`） | 投射物是**实体**，`delivery.kind === 'projectile'` 那条路 |
| **创建**（区域 / 屏障 / 召唤） | `pipeline.ts` 的 `case 'spawn'` 分支里那一个 `spawn(ctx.world, init)` | **一处长三档**：`def.kind === 'area'`（区域）/ `'obstacle'`（屏障）/ 其余（召唤物） |
| **移除**（统一收口） | `alive = false` + `world.events.push({type:'removed'})` —— `world.ts` 的 `despawn()`（`world.ts:263`）、`tickLifetime()`（`world.ts:641`）、`projectile.ts:179`（撞墙那支）、`world.ts:632`（主人死了跟着走） | ⚠ **判据只有一条**："还在不在 `world.entities` 里、`alive` 是不是真" ⇒ 到期 / 被打掉 / 撞墙 / 主人死了**全都算**，不需要给每一档各接一次 |
| **清理** | `world.ts` 第 11 步 `world.entities = world.entities.filter(e => e.alive)` | ⚠ 台账**必须在这一步之后**问（见第 2 节） |

⚠ **`delivery.count`（"发射数量"）当时是个死字段**：只进描述和定价（`describe.ts:139` / `pricing.ts`），**引擎不读**（`pipeline.ts` 造投射物时只看速度 / 寿命 / 半径）。⇒ 想造"一次施法多个投射物载体"**做不到**（除了份数类修饰，但那走的是 `activateGroup`、**每份各起一个施法** ⇒ 各有各的 `castId`）。这一片的多载体用**区域**测（`spawn` 载荷的 `count`，那一个是真读的）。
⚠⚠ **上级 2026-09-30 裁定：把这个死字段删掉**（第 9 节③）—— 所以上面这句现在读作"**它当时**是个死字段，**已经删了**"，校验器对还写着它的一律报错。

## 2. 接线落在哪三处

### 2.1 记一笔：这次施法长出了哪些载体（`mod-state.ts` 的台账）

`recordCarrier(world, entity, castId, origin)` —— 在**载体真的被造出来之后**调（`pipeline.ts` 两处：投射物那支、`spawn` 载荷那一支**循环里**，一次施法放几个就记几笔）。

台账按 **`castId`** 分组（`Map<entityId, CarrierRow>`），`CarrierOrigin` 记四样：

| 字段 | 为什么要记 |
| --- | --- |
| `technique` | **段**那一份编译产物（给 `skillTechnique` 拼时间轴用） |
| `container` | ⚠⚠ **容器**那一份 —— **这一片踩过的那个坑**，见第 4 节 |
| `skillId` | 载体是从哪个技能长出来的（在**记录那一刻**从 `${skillId}#` 前缀解算） |
| `activation` / `casterId` | 触发出来的技能照抄激活方式；去谁身上找触发副本 |

⚠ **为什么必须当场记**：载体的下场发生在**很多 tick 之后**，那时候施法早被 `pruneCasts` 移出 `world.casts` 了 —— 这就是日志 54 说的"缺**施法结果上下文**"。

### 2.2 问一句：它们全没了吗（`world.ts` 第 11b 步）

```ts
// 11. 清理
world.entities = world.entities.filter(e => e.alive)
// 11b. 载体消失 → 触发副本（日志 55）
sweepCarriersGone(world)
```

⚠⚠ **必须在清理之后**：这一档问的是"还在不在"，清理**之前**死掉的实体还在数组里 ⇒ 会答"还在" ⇒ **永远不触发**（而且静默：没有任何事件）。
⚠ **必须在 `world.tick++` 之前**：触发出来的技能靠同一个 `activate` 建施法，读的是**这一 tick** 的世界。
⚠ 它和 10b（`releaseAreaOccupants`）是一对：10b 保证"区域散掉之前把里面的人放出去"，11b 才说"那个区域现在算没了"。

### 2.3 走老路：复用 `fireModifier`

`sweepCarriersGone` 把台账交给**同一个** `fireModifier`（代价 / 冷却 / 事件 / `engineInternal` 一个都不另写），只是驱动它的时机换成 `onExpire`。
实现上把原来 `runModifierTriggers` 里那段"遍历段 → 认 `at: 0` → 解算名单"抽成 **`driveModifierCopies`**，两条路共用（各写一遍必然漂移，而漂移的表现是"某个时机静默不触发"）。

## 3. ⚠⚠ 两条纪律（各钉在测试里）

| 纪律 | 判据 | 为什么 |
| --- | --- | --- |
| **找不到载体 ⇒ 什么都不发生** | `carrierBegun(world, castId)` —— 这次施法**一个载体都没长过**（瞬时载体 / 还没放出去 / 施法被打断在半路）⇒ "载体消失"这件事**压根没发生过** | ⚠ **不许猜、也不许退化成"立刻触发"**（和"没目标就不发生"同一条）。退化的后果：引信在按下那一瞬间就烧完了，而 `origin: prevEndPoint` 会指向一个**从来不存在**的失效位置 |
| **一个瞬间，不是一个状态** | `allCarriersGone` 回答**一次**就记进 `gone` 表 | 不记的话"载体没了"会在之后**每个 tick** 都被重新发现一次（连段节奏会被反复打断） |

前面还加了一道**防误伤**：`carrierOriginOf` 拿不到技能 id（不在施法中 / 阶段越界）⇒ **一个字节都不记**。理由同上：记一笔"不知道是谁放的"载体，等于给这条默认值造一个**猜出来的**触发者。

## 4. ⚠⚠ 动手时踩的坑（留给下一个人，这是这一片最贵的一课）

**症状**：触发器**永远不响**，而且**一声不吭**（没有 `modifierTriggered`、没有报错）；台账明明记上了（`expiredCarriers` 有那一行）。

**根因**：`CarrierOrigin` 第一版只记了 `cast.technique`，而**那一个是「段」的编译产物** ——
`compileTechnique` 把 `segments[].mods` 挂在**容器**产物上，**段那份里 `segments` 是空的**。
⇒ "载体消失时去找哪一份触发器副本"遍历到的是一个**空数组**。

**修法**：`CarrierOrigin` 加 **`container`**（= `CastInstance.homeTechnique`），台账**两份都记**：
段那份给 `activation` / `phases` / `rules`（放技能），容器那份给 `segments[].mods`（找副本）。

⚠ 为了拿到容器，新增 `ActivateOptions.homeTechnique` + `CastInstance.homeTechnique` —— **默认就是这一次激活的那份**（普通术式 / 触发器链条 / 命令行都对），**只有"序列术式按了某一段"要显式把容器传下来**（`startSequence` 做了这一件事）。⚠ 这是这一片唯一一处碰 `CastInstance` 形状的地方，它**不读、只存**，行为零变化。

**顺带两条测试上的坑**（都让人得出过假结论）：

| 坑 | 表现 | 真因 |
| --- | --- | --- |
| `advance(world, n)` 收的是 **tick 数**，不是秒 | "子弹还没飞出去" | 一秒 = 60 tick；把秒当 tick 传，时间只走了 1/60 |
| `world.events` **每 tick 开头被清空** | "一次都没触发" | 一把 `advance` 推过去，`modifierTriggered` 早被后面那些 tick 清掉了 ⇒ 想观察**瞬间事件**必须**一 tick 一 tick 地看** |

## 5. 多个载体：**全部消失**才算（✅ 上级已裁定，见第 9 节①）

一次施法可以长出**好几个**载体（`spawn` 载荷的 `count`）。两个候选语义都说得通，这一片选的是「**全部消失才算**」，理由写死在 `allCarriersGone` 的注释里：

1. **引信就该烧到最后一个** —— "火球飞出去、它消失那一刻再触发"：场上还有一颗同批的火球在飞的时候就说"它消失了"，那颗火球算谁的？
2. **和既有的「份数」机制是一条连续的规矩** —— 多重释放 / 一分为 X 把一次激活变成 N 份，而"**这一组什么时候算结束**"引擎里已经有答案了（`CastInstance.activation`：等**最后一份**）⇒ 载体这一层用**同一个答案**，玩家不用学第二套"什么时候算完"。
3. **代价（明说）**：一发放空 / 飞出屏幕的子弹会让后续技能**晚到**；但"早到半个身位"会直接改变连段节奏，比"晚到"危险得多。

⇒ ✅ **上级 2026-09-30 裁定：接受「全部消失才算」**（理由逐条认了，见第 9 节①）；裁定下来**只改 `allCarriersGone` 那一个函数**（测试第 55 节⑤那条会红，逼着改的人去读那段理由）。

⚠ **今天还测不了"错开消失"**：同一个 `spawn` 载荷给的寿命一样 ⇒ 两个载体同 tick 到期。要让它们错开，得先有"多个载体各自不同寿命"的写法（⚠ `delivery.count` 那个死字段**已经删掉了**，见第 9 节③ ⇒ 得走别的路）。

## 6. `onRemoved`：**故意没接，但一定出声**（上级裁定 2026-09-30）

⚠⚠ 这一节的第一版是"让它进已接线那张表，注释里交代一句"—— **上级当场否掉了**：

> **不要留成"写上去不生效且不吭声"** ✗ —— 那正是我们这一整轮在清的那一类

⇒ 现在走的是 **"从已接线那张表里拿掉它"**（(b) 那条小路），
写 `onRemoved` 会拿到 `MODIFIER_TRIGGER_NOT_WIRED` **警告**，话里**直接指路 `onExpire`**。

⇒ 详细的取舍（为什么没走"真接上"那条路、要接上得先做什么）写在**第 9 节②**。

## 7. 校验器：`MODIFIER_CONDITION_REQUIRED` 松掉了

| | 日志 54 | 日志 55 |
| --- | --- | --- |
| 副本 / 原型都**不写** `condition` | **报错** `MODIFIER_CONDITION_REQUIRED` | **合法** —— 那就是「载体消失」这条默认值 |
| 显式写 `condition: {}` | 报错 `MODIFIER_EMPTY_CONDITION` | **照旧报错**（⚠ 它不是"没写"，是一个明确的"**永不通过**"） |
| 副本不写、**原型**写着 | 合法 | 合法（副本优先、原型兜底） |

理由：日志 54 当时**必须**报它，唯一的原因是"那条默认值引擎没接线"⇒ 不写就是"永不触发"。现在接上了，**"不写"有真实语义**。

⚠ 实现上"写了 / 没写"**必须分开判**（`hasConditionOf`），不然那条默认值会把一个写着 `{}` 的副本**救活**。

⚠⚠ 同时把原型的 **`when` 默认值从 `onCast` 改成 `onExpire`**：`when` 和条件**是两个旋钮、一个语义** —— 写 `onCast` + 不写条件的话，「载体消失」这条默认值**永远不会被问到**（`onCast` 那条路上没有任何东西知道载体后来怎么样了）⇒ 表现就是"装了这个零件，它一声不吭"。
⚠ **出厂内容里一个 `mod.trigger.on-cast` 副本都没有** ⇒ 这条默认值改动**不影响任何现有战斗**（哈希逐位不变就是证据）。

## 8. 验证

| 命令 | 结果 |
| --- | --- |
| `npm test` | **17 个文件全绿**；合计 **1587 → 1616** 个断言（用 README 里那段 PowerShell **逐个文件读它自己打印的数**加出来的：`scenario` 340 → **366**、`weapons` 197 → **200**，其余 15 个文件**一个数都没变**）。⚠ `smoke.ts` 那两件新检查（`checkDeliveryCountRemoved` / `checkHomingDoesNotLie`）**并进它原来那 11 条**里，所以**合计不变** |
| `npm run validate` | **55 个文件 · 55 通过 · 0 失败 · 9 警告**（文件数与警告数都和改前一样 —— 本轮**没有新内容文件**；⚠ 两条新判据都**只对写它的内容**出声，而出厂内容**一处都没写**：没有 `onRemoved`、没有 `delivery.count`、没有 `homing`） |
| `npm run typecheck` | 通过（`tsc --noEmit` 无输出） |
| `npm run calibrate` | **逐行不变**（`Compare-Object` 对改前 / 改后两份输出：**IDENTICAL**，88 行） |
| `node src/cli/battle.ts content/scenarios/duel.json --duration 12` | **逐行不变** + `Get-FileHash -Algorithm SHA256` = **`44C782A4984C3922A728786E9A63B9BC2396D5DCED1570FDE19C93CD942998B1`**（**与基线逐位相同** ✓ —— 出厂内容里没有触发器副本、没有一处写 `delivery.count`、也没有一处写 `homing`，这一片只影响"将来有人用它的时候"） |
| `npm run build:web` | 成功 |
| ⭐ 出厂全 0 | 逐份打印 **32 技能 + 14 术式**：**合计与条目数两个都是 0 的有 46 份、不合格 0 份**（`.scratch/factory-zero.ts`，和日志 53 / 54 同一份探针） |
| 纯净性 | `core-sim 纯净性检查通过（18 个文件）` —— 没有 `Date` / `Math.random` / `sin` / `cos` 之类 |

改前的原始输出存在 `.scratch/expire55-before/`（`test` / `validate` / `calibrate` / `battle` 四份）。

## 9. ⚠⚠ 上级 2026-09-30 的四条裁定（逐条落在哪一行）

### ① 多载体 = 「全部消失才算」—— **接受** ✓

裁定的原话把理由也认了（引信该烧到最后一个 ✓ 和「份数」是"等最后一份"同一条规矩 ✓
玩家不用学第二套"什么时候算完" ✓ 而且"早到半个身位"比"晚到"更危险 ✓）。

⚠ **那条设计保持**：裁定下来**只改 `allCarriersGone` 一个函数**，
而 `tests/scenario.ts` 第 55 节⑤**会当场变红** —— 逼着改的人去读那段理由（第 5 节）。

### ② `onRemoved` 不许静默 —— **走 (b)：从"已接线"那张表里拿掉** ✓

指令原话：

> **不要留成"写上去不生效且不吭声"** ✗ —— 那正是我们这一整轮在清的那一类

两条路，(a) 真接上 / (b) 拿掉 + 让校验器出声。**这一片走 (b)**，理由是"小"：

| | (a) 真把它接上 | (b) **拿掉它**（选了这个） |
| --- | --- | --- |
| 要做什么 | 把"**为什么没了**"（`reason`：`expired` / `died` / `despawned`）**一路记进载体台账** —— 而"载体不在世界上了"这**一个**事实由 `sweepCarriersGone` 在**一处**发现，要分就得给 `tickLifetime` / 撞墙那支 / 主人死那支 / `despawn` **各记一笔** | **一行**：`WIRED_TRIGGER_EVENTS` 去掉 `'onRemoved'` |
| 语义风险 | 还要定"撞墙算哪一类"（今天没有答案） | 零（而且让两个名字指同一个事实本来就是**假的区分**） |
| 作者的体验 | 能写 `onRemoved` | 拿到 `MODIFIER_TRIGGER_NOT_WIRED` **警告**，话里**直接指路**改写成 `onExpire` |

⚠ 这一片**不硬造区分**：`onExpire` 和 `onRemoved` 在今天的引擎里
**就是同一个事实**（"这次施法放出去的东西不在世界上了"），
让两个名字各指一档才是假的。⇒ 留**一个**真名字（`onExpire` = 玩家点名的「载体消失」），
另一个**出声拒绝**。

**落在哪一行**（三处，都在改过一次的地方）：

1. `src/sim/trigger.ts` 的 `WIRED_TRIGGER_EVENTS`：`['onLowHp','onTick','onCast','onExpire']`（去掉 `onRemoved`）+ 表头那段写清"**为什么故意不在表里**"；
2. `src/validator/checks.ts` 的 `unwiredTriggerIssue`：给 `onRemoved` **单独一句**改写建议（不是笼统的"还没接线"，那会让作者以为要等以后）；
3. `content/modifiers/trigger-on-cast.json` 的 `_comment`：把它从"已接线"那一行改成"**故意没接**"那一段。

**钉住它的测试**（`tests/weapons.ts` 第 ⑥ 组，**+3 条**）：

- 写 `when: 'onRemoved'` → **报** `MODIFIER_TRIGGER_NOT_WIRED`（⚠ 不许静默）；
- 那句话里**直接出现 `onExpire`**（作者不用去翻源码）；
- **对照组**：写 `onExpire` → 不报这条（否则"见 `onRemoved` 就报"也能过，而那不是判据）。

### ③ 删掉死字段 `delivery.count` —— **已删** ✓

指令原话：

> 份数今天已经有唯一一条路（一分为 X）⇒ 留着 `delivery.count` 就是**第二个真相** ✗

⚠ **先核实了"牵连面"**（指令说大的话就停下报告）—— 结论是**小**：

| 谁读它 | 结论 |
| --- | --- |
| `schema/skill-schema.ts` | **声明处**（`DeliverySpec.count`）→ 删掉，原地留一段"为什么被删"的注解 |
| `src/describe.ts` | 拼 "N 发" 那一行 → 删掉（⚠ 它会让界面写出一个**根本没发生**的"N 发"） |
| `src/pricing.ts` | **❌ 不读它**（grep 过：那几处 `p.count` 读的是 **`SpawnPayload.count`**，另一件事） |
| `src/sim/pipeline.ts` | **❌ 从来不读**（造投射物只看 `speed` / `lifetime` / `radius`）—— 这就是它"死"的证据 |
| `content/**` | **一处都没写**（grep 过全部 JSON；`barrier` / `place-slow-field` / `raise-dead` 那三个 `count` 是 **`spawn` 载荷**的，不是 delivery 的）⇒ **没有内容要改** |
| `tests/**` | **没有一条**依赖它 |

⇒ 一共改了 **3 个文件**（schema / describe / validator），**不用停下报告**。

**校验器**：`delivery.count` 从 `checkDeliveryNumbers` 的"非负数"名单里去掉、
从 `DELIVERY_FIELD_UNUSED` 的 `all` 名单里去掉，改成**指名道姓的报错**：

```
BAD_DELIVERY  <path>.delivery.count
  `delivery.count`（"发射数量"）**已经删掉了** —— 它是个死字段，引擎从来没读过它
  ⚠ 它的下场是"**第二个真相**"：schema 里写着、描述和点数也照着它算，而引擎造投射物时
    只看 speed / lifetime / radius ⇒ 写 count: 3 出来的还是**一发**
  ⇒ "一次打出好几发"今天**只有一条路**：修饰零件「**一分为 X**」
```

⚠ **为什么是报错不是警告**：那条 `DELIVERY_FIELD_UNUSED` 警告说的是
"这个字段**在这类载体上**没用"，而这里要说的是"**这个字段不存在了**、
你想做的事得换一个零件做"—— 后者必须让人**看见**，不能只是一条可能被忽略的警告。

**钉住它的测试**（`tests/smoke.ts` 新 `checkDeliveryCountRemoved`，**+1 条**）：
写 `delivery: { kind:'projectile', …, count: 3 }` → 报 `BAD_DELIVERY`，**而且话里出现「一分为 X」**
（⚠ 只测"报了错"是不够的：作者还得知道**该怎么办**）。

⚠ **`battle` 哈希不变**就是"出厂内容一处都没写它"的证据。

### ④ `homing`（追踪）：**先把假话拿掉** ✓（上级 2026-09-30，分两步只做第一步）

⚠ 这一条是我上一轮**顺路发现、报上去**的（现在记在第 11 节第 5 条），上级当场裁了**第一步**：

> **立刻把那句假话拿掉** ✗ —— 比 `count` 更糟：`count` 只是白写 ✓
> 这个是**骗人** ✓（玩家照着配了，然后发现飞弹直直地飞 ✗ 而且他会以为是 bug ✗）

⇒ **为什么它比 `count` 那种死字段更坏**（这一条值得单独记）：

| | `delivery.count`（白写） | `homing`（**骗人**） |
| --- | --- | --- |
| 写上去之后 | 没效果 | 没效果 |
| **说明里会写什么** | 「3 发」——⚠ 也是假的，但那句话**引擎和界面都不真执行** | 「**追踪**」——⚠ 玩家会**照着它配** |
| 玩家会遇到什么 | "怎么只有一发"（他会怀疑自己写错了） | "怎么直直地飞"（**他会以为这是 bug** ✓ 而他没有任何办法知道那是"没实现"） |

**做了两件事**（都只动已经碰过的那几处）：

1. **`src/describe.ts`**：删掉 `if (d.homing === true) bits.push('追踪')` 那一行 ——
   **描述里从此只写引擎真的会做的事**（`speed` / `lifetime` / `pierce`）。
   ⇒ 所以玩家**看不到那句假承诺**了。
2. **`src/validator/checks.ts`**：`homing` 从 `warn('INERT_FIELD', …)` **升成 `err('INERT_FIELD', …)`** ——
   ⚠ 上级的原话是"**宁可报错让人看见，不要留个警告混在 9 条里** ✗"。
   新的话术**说三件事**：它今天不生效（引擎真的读的只有 `speed`/`lifetime`/`radius`/`pierce`）、
   **它和别的死字段不一样（它会骗人）**、以及"**追踪做不做玩家还没裁定**"。
3. **`schema/skill-schema.ts`**：`homing` 那段注解写清"声明了但引擎不读、而且它会骗人"，
   并写明**两条出路**（做 ⇒ 引擎真读它 + 描述加回来；不做 ⇒ 按 `count` 的先例删字段）。

**钉住它的测试**（`tests/smoke.ts` 新 `checkHomingDoesNotLie`）—— ⚠ **两个方向都测**，
缺一个都证不了"骗人这件事被堵住了"：

- ① `describeDelivery({… homing: true})` 的结果里**不许出现「追踪」**（拿掉假话）；
- ② 写 `homing` 的内容**报 `INERT_FIELD`、而且 `level === 'error'`**（⚠ 断言级别！只断言"报了个东西"的话，
  退回警告也能过 —— 那正是上级要避免的）、并且话里说清"**不生效**"。

⚠ **第二步（「追踪」到底做还是删）上级在问玩家** —— 这一片**没有**做：
引擎那边 `homing` **一个字节都没读**，schema 字段和 `sim/types.ts` 的 `ProjectileSpec` 也**都没动**。
⚠ 上级倾向**做**（经典机制 + schema 早就写着 + 日志 53 刚给了**整圈角度表 + `rotate2()`** ⇒
转向可以**不用三角函数**算、确定性不成问题）—— 等回话。

## 10. 端到端测试（第 55 节，`tests/scenario.ts`）

**放出去一个会自己在世界上活着的东西 → 它消失 / 到期 / 被打掉时，后面那个技能真的被触发**（时间可控）：

| # | 测什么 | 怎么保证不是"碰巧过的" |
| --- | --- | --- |
| ① | 按下 → 子弹真的在世界上飞；**飞的时候一次都不触发** | 探针副本**一个字都不写** `when` / `condition` ⇒ 同时钉住默认 `when` + 默认条件语义 + 台账真的记上了 |
| ② | 子弹**飞完寿命** ⇒ 触发器响**一次**，时机报 `onExpire`，而且**触发出来的技能真的起了施法** | 一 tick 一 tick 推到引信烧断；另加一条"**是在子弹飞完寿命之后**才响的（不是按下就响）" |
| ②b | 之后**不再重复触发** | 连推 2 秒，累计 `modifierTriggered` = 0 |
| ③ | 载体**被打掉**（不是到期）⇒ 同样触发 | ⚠ 到期 / 被打掉是**两条不同的代码路径**（`tickLifetime` / 撞墙那一支），只测一条的话另一条坏了没人知道 |
| ④ | **一个载体都没长过**（瞬时载体）⇒ **什么都不发生**，世界也干净 | 推 5 秒，`modifierTriggered` = 0、没有多出实体 |
| ⑤ | 一次施法长出**两个**载体 ⇒ **全部消失才触发一次** | 现造一份 `count: 2` 的变体（**没改出厂数值**）；两个都在时 = 0 次（⚠ 裁定①钉的就是它） |

## 11. 待裁定项 / 仍然开着的

1. ✅ ~~多载体语义~~ —— **上级 2026-09-30 裁定：全部消失**（第 9 节①，**已定**）。
2. ✅ ~~`onRemoved` 与 `onExpire` 要不要分开~~ —— **上级 2026-09-30 裁定：不许静默**，
   今天走"拿掉 + 出声"（第 9 节②）。⚠ **"真把它接上"仍然开着** ——
   要做的话得把 `reason` 一路记进台账，而且要先定"撞墙算哪一类"（另立一片）。
3. ⚠ **条件和触发不在同一个"点"上求值**：`condition` 今天在**施法者**的语境里求值（`contextOf`），而这一档的事件点在**载体倒下那一处**。写 `distanceIs` 那类条件的副本要按哪个点算，玩家没说过（今天照老规矩：施法者）。
4. ⚠ **一次施法里多个技能各自长载体**：台账按 `castId` 分组，而"这个副本修饰的是哪一个技能"由遍历本身定位（`at: 0` 那一段）。同一次施法里两个技能都长载体时怎么分，今天没有答案（`CarrierOrigin.skillId` 已经记着，随时能用）。
5. ✅ ~~`homing`（追踪）是同一类死字段~~ —— ⚠ 我上一轮顺路看见并报了上去，
   **上级 2026-09-30 裁了第一步**（把那句假话拿掉，见**第 9 节④**，**已做**）。
   ⚠⚠ **第二步「追踪」到底做还是删 —— 上级在问玩家，这一片没做**：
   引擎那边 `homing` **一个字节都没读**。
   ⚠ 上级倾向**做**（经典机制 + schema 早就写着 + 日志 53 给了**整圈角度表 + `rotate2()`**
   ⇒ 转向可以**不用三角函数**算）。

## 12. 没做的事

- **没碰编辑器 UI**：`web/src/editor.ts` / `web/src/technique-editor.ts`（以及 `web/src/` 下**任何一个字节**）都没动。
- **只接了 `onExpire` 这一档**：`onHit` / `onMiss` / `onCrit` / `onStatusApplied` 那几档**一个都没接**；⚠ `onRemoved` **故意没接**（第 9 节②）。
- **没碰瞄准 / CD 名牌**；已落地零件的语义（触发器·监测器·常驻包装·多重释放·一分为 X·等待·排布）**一个都没动**。
- **没改内容里现有的数值**（`trigger-on-cast.json` 只动了 `when` 的默认值和注释；所有技能 / 术式 / 平衡数值一个数都没动；`delivery.count` 出厂内容一处都没写）。
- **没做**"多个载体各自不同寿命"（那要先有"一次施法 N 个投射物"的写法，而 `delivery.count` 已经删掉了 ⇒ 得走别的路）。
- ⚠ **`homing` 只做了"拿掉假话"那一半**（第 9 节④）：说明里不再写「追踪」、写它报错 ——
  但**引擎仍然不读它**，字段也**没删**。⚠ 「追踪」这个机制本身**没做**（等玩家裁定）。

## 13. 欠账

- ⚠ **`onRemoved` 真接上**要做的话，得把"为什么没了"（`reason`）记进载体台账，
  并且先定"撞墙算到期还是算被打掉"（第 9 节② 的 (a)）。
- ⚠⚠ **`homing`（追踪）机制本身**：假话已经拿掉（第 9 节④），但**机制还没做**。
  ⇒ 等玩家裁定：**做**（引擎真读它 + 把描述那一行加回来，⚠ 用日志 53 的整圈角度表 +
  `rotate2()` 可以**不用三角函数**算）还是**删**（按 `delivery.count` 的先例删字段）。
  ⚠ **在那之前 `homing` 是个"写了就报错"的字段**，不是可用的旋钮。
- ⚠ **日志 48 那几档时机仍然没接线**（`onHit` / `onMiss` / `onStatusApplied`）—— 和日志 54 记的是同一笔。
- 修饰零件的 `paramsTemplate` **今天没有任何界面**（日志 53 的欠账，仍未做）—— 所以这一片改的那个默认值玩家在界面上还看不到。
