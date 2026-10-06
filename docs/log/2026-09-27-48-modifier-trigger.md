# 修饰技能（触发器 / 监测器）+ 背水拆解

- **日期**：2026-09-21
- **触发**：玩家 2026-09-21 定稿 [`sequence-and-modifier-model.md`](../sequence-and-modifier-model.md)
  **第八节「修饰技能」**。这一片只做**形状 + 触发器 / 监测器 + 背水拆解**；
  玩家点名「**多重释放**」和「**连锁**」是**下一片**。
- **这一轮是"收尾"而不是"重做"**：上一个执行者把**引擎侧做完了**
  （schema / 原型 / 编译器 / 执行器 / 校验器 / 分享码 / 背水拆解都在），
  但**停在 `tests/school.ts` 红着**、日志与计数没写。本次是**看懂它 → 补齐它 → 修到全绿**，
  **没有推倒重来、一行引擎代码都没改**（下面"改了什么"里写清了哪三处是我动的）。

## 改了什么

### 上一个执行者做完了的（本次核对过，没动）

| 层 | 落点 |
| --- | --- |
| **schema** | `ModifierKind`（`trigger` / `monitor` / `wrap`）、`TriggerOrigin`（四选一）、`ModifierProto`（**原型**）、`SegmentMod`（**副本** `{proto, at, params}`）+ `SequenceSegment.mods` |
| **内容** | `content/modifiers/` **三份原型**（新建目录）：`wrap-persistent` / `monitor-low-hp` / `trigger-on-cast`；`manifest.json` 加 `modifiers` 那一栏 |
| **编译** | `sim/compile.ts` 的 `compileMods`：**编译期**查原型表 → `CompiledMod`（`kind` / `when` / `condition` / `crossing` / `origin` 填好、`at` 换算成绝对下标 `targetIndex`）；`wrap` + `at: 0` → `constantSegments` |
| **执行** | `sim/trigger.ts`（执行器）、`sim/mod-state.ts`（"已经触发过"的状态，按世界分桶）；`world.ts` 第 6 步每 tick 调一次 |
| **校验** | `checks.ts` 的 `validateModifierProto`；`validator/index.ts` 的 `MODIFIER_STACKED_KIND`（不叠同类）/ `MODIFIER_OUT_OF_RANGE` / `UNKNOWN_MODIFIER` / `BAD_MODIFIER_AT` / `BAD_MODS` |
| **按键** | `sim/cast.ts`：`constantSegments` 非空 → 不进按键激活（报 `castBlocked` / `autoTechnique`） |
| **背包/存档** | 分享码升 **`TS3`**、**`TS2` 继续读**；存档 **v5** + 迁移；`cloneModifierCopies`（"另存为"时副本跟着深拷贝） |
| **内容** | 「背水」拆解（见下）；`content/skills/last-stand.json` **整个删掉** |
| **测试** | `tests/probes.ts` 删掉「背水」探针；`tests/scenario.ts` 第 21 节改挂**内容里那一门真实术式**；`tests/smoke.ts` 的 manifest↔目录双向检查加了 `modifiers` |

### 我补齐的三处（**只有这三处**）

1. **`tests/school.ts` —— 两条写死的计数重数**（这是全绿断掉的那一处）。
   `techById.size` 13 → **14**、`weapons.length + 11` → **+ 12**。
   ⚠ **为什么是改测试而不是改代码**：那一门的注释自己写着这个数字**故意写死** ——
   "它逼着下一个人'多了/少了都要重数一遍'"。而 +1 是**拆解本身的算术后果**：
   玩家定的形状是「监测器 + 生成护盾的技能 + **一门常驻术式**」，第三件**没有别的地方可放**
   （副本住段里、段住术式里、术式只能是一份文件）。所以这是"它故意改掉的行为"，
   断言跟着重数，并把"为什么 13 → 14"写进注释。
2. **计数收尾**：`README.md` 三处（`validate` 那行 47 → **51**、`npm test` 那行
   1223 → **1231** 口径 `1196+11+16` → `1202+11+18`、"十七套自动检查"那一整块）
   + 两处**内容份数**（13 → 14 份内部术式、以及加了一行 `last-stand.json` 的说明）；
   `docs/STRUCTURE.md` 计数合计块 + 内容/文件计数（`internal-techniques/` 13 → 14、
   `modifiers/` 新增一行、`src/sim` 16 → 18 个文件） + 新增两行文件说明
   （`trigger.ts` / `mod-state.ts`）+ 段形状补 `mods?` + "哪个文件该改"补一行修饰技能。
3. **这份日志 + `docs/log/README.md` 索引一行。**

## 原型与副本的**真实形状**

```
原型（出厂、只读、玩家不能创建）        副本（只属于这一份术式）
content/modifiers/*.json                术式 · sequences[i].mods[j]
┌──────────────────────────────┐        ┌──────────────────────────┐
│ ModifierProto                │        │ SegmentMod               │
│  schemaVersion, id, name     │        │  proto: "mod.monitor.low-hp"
│  note                        │        │  at: 0      ← 修饰它**后面第几个**技能
│  kind: trigger|monitor|wrap  │        │  params: {} ← 副本优先、原型兜底
│  paramsTemplate  ← 给人/编辑器看        └──────────────────────────┘
│  params          ← **引擎真的读的**            │ 编译期（compileMods）
│  tags                        │                 ↓
│  ⚠ **没有 points**           │        ┌──────────────────────────┐
└──────────────────────────────┘        │ CompiledMod              │
                                        │  source, kind            │
三份：                                   │  targetIndex ← at 换算成绝对下标
  mod.wrap.persistent  常驻包装          │  when?, condition?,      │
  mod.monitor.low-hp   命悬监测          │  crossing?, origin?      │
  mod.trigger.on-cast  应声触发          └──────────────────────────┘
```

三条**不许走样**的：
- **副本不混进 `skills: string[]`**（玩家点名的红线）—— 并列在 `mods` 里，用 `at` 说位置。
  混进去的话，每一处读 `skills` 的地方都得重新判"这个字符串是不是技能"，
  上一片（序列内联 + 瞄准搬家）的成果会全部推翻。
- **原型住内容层、副本住术式里**：`content/skills` 的技能会被玩家"另存为变体"，
  而这里**没有"自定义原型库"** —— 副本不进任何库、别的术式引用不到，
  但**跟着存档和分享码走**（`TS3`）。
- **`paramsTemplate` 和 `params` 是两份**：前者是"这个零件有哪些旋钮"（给人看），
  后者是引擎真读的值。⚠ 两份会漂移，所以校验器盯的是
  "引擎读的那几个键在不在"（`MODIFIER_PROTO_BAD_PARAMS`），不靠人自觉。

## 「背水」拆解：前后对照

| | 拆解前 | 拆解后 |
| --- | --- | --- |
| **技能** | `skill.last-stand`（背水，`form: passive`）—— **自己带一条 `onLowHp` 规则**，反应式：血线一到立刻发盾 | `skill.last-stand-shield`（背水 · 撑盾，`form: passive`）—— 规则挂在 `phaseComplete(ready)`，**它自己不看血线** |
| **"什么时候"** | 混在那个技能自己的规则里 | `mod.monitor.low-hp` 副本：`when: onLowHp` + `condition: hpBelow(self, 0.3)` + `crossing: true` |
| **承载体** | `tests/probes.ts` 里的**探针** `tech.last-stand`（`activation: toggle`） | `content/internal-techniques/last-stand.json`（`activation: auto`） |
| **段** | 无（术式只写 `skills`） | `sequences[0]` = `{ id: tech.last-stand.seq0, name: 命悬撑盾, skills: [skill.last-stand-shield], mods: [{ proto: mod.monitor.low-hp, at: 0, params: {} }] }` |
| **点数**（技能那侧） | 前摇 1.94 / 后摇 1.09 / 规则 −3.62 / 绝对强度 −0.59 | **一模一样**（只有规则那句标签从"命悬一线时撑起一层盾"变成"撑起一层背水盾"） |
| **代价** | 能量 30（前摇那一相）/ 冷却 8 秒（后摇那一相） | **同两个数**，但**每触发一次各收一次**（走同一个 `activate()`） |
| **可观察差异** | 盾在跨线那一瞬间就有 | 盾要等撑盾技能跑完 **0.5 秒前摇**（⚠ 这不是静默变化 —— `tests/scenario.ts` 第 21 节明文写着，观感是"盾晚半秒出现"，而那半秒本来就是那个技能的施法时间） |
| **calibrate** | `背水` −1.4 | `背水 · 撑盾` −1.4（**数没变**，只有显示名变） |
| **旧技能** | `content/skills/last-stand.json` | **删掉了** ✓ 没有留半死的旧技能（`skill.last-stand` 这个 id 在源码/内容/测试里**一处都不剩**） |

⚠ **为什么必须拆**（不只是为了用上新零件）：旧的写法把**"什么时候"和"给什么"焊在一个技能里**，
于是写不出别的组合 ——"血量低时改成回血""护盾失效时炸一下"都得各造一个技能。
拆开之后，"什么时候"是修饰副本（可换、参数可编辑），"给什么"是普通技能（可以换成别的）。

## 生成位置**四选一**怎么落地

玩家定的四选一在 `sim/trigger.ts` 的 `resolveOrigin()`：

| 取值 | 落在哪 | 今天的实现 |
| --- | --- | --- |
| `caster` | **施法者身上** | **故意不传点** —— 让技能用**它自己那套瞄准**（对自己 = 落自己身上，朝前打 = 从自己这儿朝前）。硬塞一个点进去的话，`hpBelow` 那类自我增益也会被当成"落在某个点上"，行为就变了 |
| `aim` | **瞄准的落点** | ⚠ 触发**没有玩家那一个意图**（不是他按的）⇒ 只能退一步用**"最近的敌人"那个方向**。**这是没定下来的地方**（待裁定项 3） |
| `prevHitPoint` | **触发它的那个技能的命中位置** | 读"上一次触发留下的那个点"（`mod-state.ts` 的 `prevPoint`，跟着世界分桶） |
| `prevEndPoint` | **失效位置** | ⚠ 定稿 §八 自己就标着"这一项的确切含义还没定" ⇒ 今天和上一条**同一个点**（待裁定项 4） |

## 为什么这么写（几个**不做就会静默出错**的地方）

- **执行器为什么要走 `activate()` 而不是自己跑规则**：玩家那句"被触发的技能**照常付**
  能量 / 冷却，按**每次触发**结算"**在 `activate` 里已经实现了**。再写一遍就是**第二套规矩**，
  而两套迟早漂移 —— 漂移的表现是"触发出来的技能不扣能量"，一件不会报错的坏事。
- **`mod-state` 为什么按世界分桶**（`WeakMap<World, …>`）：第一版写成模块级的一张表，
  单跑一个测试文件全绿 —— 可 `tests/scenario.ts` 里有几十个 `createWorld()`，
  **实体 id 在每个世界里都是 1、2、3**，于是第 21 节那个"实体 1"继承了前面某一节留下的
  "已经触发过"记录，表现是"血量跨过去了，但触发器一声不响"，而**单看那一节完全看不出问题**。
  ⚠ 没改成"实体 id 全局唯一"是因为那要动 `world.nextId`，而它是快照 / 重放 / 联机同步共用的。
- **边沿检测（`crossing`）为什么必须有**：`onTick` 上的条件是"**现在**成不成立"
  （`hpBelow 0.3` 在残血时**每 tick** 都成立）⇒ 不记上一次的话，一个常驻术式会在残血的
  **每一帧**都放一次盾。那不是"跨过危险线给一次"，而是"残血期间无限刷"。
  旧「背水」的语义就是**跨过**，拆解时原样保住。
- **判据为什么是"这一段的第一个技能被修饰了"（`at: 0`）而不是 `constantSegments`**：
  后者只由 `wrap` 产生，而一个**纯监测器**的段（「背水」就是：监测 + 撑盾，没有 wrap）
  照样该被驱动 —— 拿它当判据的话「背水」**一辈子不会触发**（第一版就是这么写的，当场抓到）。
- **`CompiledMod` 为什么在编译期解析原型**：`sim` 不认识内容层，而"原型表缺席时猜错"
  的代价是静默的（把 `wrap` 猜成 `trigger` ⇒ 这一块照旧要按键激活）。

## 验证（**全部实跑**）

```
npm test            → 17 个文件**全绿**，1231 个断言 = 1202 + 11 + 18
npm run validate    → 51 个文件 · 51 通过 · 0 失败 · 9 警告
npm run typecheck   → 干净（exit 0）
npm run calibrate   → 18.4 → 1.47  **不变**
node src/cli/battle.ts content/scenarios/duel.json --duration 12  → 内容逐字不变
npm run build:web   → exit 0
```

**断言计数**（照 README 里"别手算"那段 PowerShell **逐个文件读它自己打印的数**，
不是在旧值上加 —— 这个数被算错过三次）：

```
barrier 27  battle 88  blink 28  cast 109  describe 50  editor 71  fx 80
pipeline 146  pricing 92  purity 18  scenario 182  school 27  sim 57
smoke 11（校验器用例）  store 72  weapons 99  web 74
                                    = 1231
```

**这一片动了哪几个数**（其余**一个数都没变**）：

| 文件 | 前 → 后 | 为什么 |
| --- | --- | --- |
| `tests/scenario.ts` | 177 → **182**（+5） | 第 21 节改成挂**内容里那一门真实术式**，并补了"跨过危险线**只触发一次**"的哨兵（`modifierTriggered` 计数） |
| `tests/store.ts` | 71 → **72**（+1） | 分享码 `TS3` / 副本跟着术式走 |
| `tests/school.ts` | 27 → 27（**总数不变**） | ⚠ 变的是**里面那两条写死的计数**（13 → 14、11 → 12）—— 那两条是**当场重数**的 |
| 纯净性（`tests/purity.ts`） | 16 → **18** | `src/sim` 多了 `trigger.ts` / `mod-state.ts`（它数的是"扫了几个文件"，不是断言） |

**`npm run validate`：47 → 51 个文件**= +3 份修饰原型 + 1 份撑盾技能
（技能那一侧是**换**不是加：旧 `last-stand` 删掉、新 `last-stand-shield` 进来）。
警告仍是 **9 条**（一条都没新增）。

**`duel` 12 秒逐位不变**的证据：我这边抓取时终端给文件加了 BOM + CRLF，所以
`Get-FileHash` 直接比会不同（这是**抓取方式**的差异，不是行为差异）——
去掉 BOM、统一行尾之后与改前**逐字节相同**（sha256 前缀 `792CA3C1…`，
2206 bytes）。`calibrate` 同理：90 行里**只有 2 行**不同，
而那 2 行是同一个技能的**显示名**（`背水` → `背水 · 撑盾`）——
**最大偏差 18.4 → 1.47、均方根 8.024 → 0.832 一个数都没动**。

## 待裁定项（⚠ 玩家没给规则的，**我一个都没自己定**）

1. **修饰技能的点数怎么算** —— 玩家没给规则。这一片**照今天的账走**：
   原型**不给 `points` 字段**、副本也不进点数账（"序列术式不算账"这条现行规矩）。
   ⚠ 这是**故意的空着**，不是忘了。
2. **其余 `TriggerEvent` 写上去不生效** —— 今天**真的接了线**的只有三个：
   `onLowHp`（`pipeline.ts` 的 `fireLowHp`）、`onTick`（`world.ts` 第 6 步）、
   `onCast`（挂上常驻术式那一刻）。`onHit` / `onMiss` / `onExpire` / `onRemoved` /
   `onStatusApplied` / `onCrit` … **还没有一个地方知道该在什么时候调**
   （`onExpire` 要"状态失效的那一刻"、`onHit` 要"这一次命中是谁打的"）。
   ⚠ 内容里写它们**不报错也不生效** —— 这是**待办**，不是实现。
3. **触发路径上的 `aim`** —— 触发没有玩家意图，"瞄准的落点"今天退化成
   **"最近的敌人"**。语义要玩家定（或者裁定"修饰技能不许用 `aim`"）。
4. **`prevEndPoint`（失效位置）的确切含义** —— 定稿 §八 / §十三 自己就标着"还没定"。
5. **监测器触发过之后不复位**（`crossing` 的已知代价）：条件离开过再回来**也不重置**，
   因为驱动它的是"跨过"那一瞬间、**没有"离开"的时刻可观察**。
   要不要给监测器加一条"每隔 N 秒也可以触发"的语义？
6. **玩家按出来的那一段要不要驱动触发器** —— 今天的判据只看 `at: 0`，所以**会驱动**
   （理由：多驱动总比"写了不生效"好）。没裁定。
7. **监测器能不能盯别人** —— 今天条件求值的上下文里 `target` 取**"最近的敌人"**
   （不给的话 `hasStatusTag` / `distanceIs` 那几条**恒为 false**，
   表现是"我写了条件，它不触发"）。没裁定。
8. **「背水」住在 `content/internal-techniques/` 对不对** —— 那个目录的定义是
   "**玩家看不到、也引用不到**"，而「背水」显然是**给玩家装的**一门常驻术式。
   今天它进得了 `tests/scenario.ts`（测试直接按 id 挂），但**玩家在界面上拿不到它**。
   ⇒ 要么给玩家可见的常驻术式另开一个分组，要么裁定"它就该是内部的"。
   ⚠ 拆解前它也拿不到（那时它只是 `tests/probes.ts` 里的探针），所以**不是回归**。
9. **"常驻 ≠ 免费"要不要在界面上说出来**（玩法 / UI 层）。
10. **0.5 秒前摇这个可观察差异**（见上表）—— 已被 `tests/scenario.ts` 明文记下，
    但"要不要保留这个前摇"是玩家的事。

## 欠账

- **修饰技能的编辑界面**（定稿 §八 明说"编辑界面是它自己的一套"）—— **下一片**。
  今天副本的 `params` 是**从原型填出来的**（引擎读法是"副本优先、原型兜底"），
  所以界面做出来之后**原型不会被改到**。
- **「多重释放」和「连锁」** —— **下一片**（玩家点名的）。它们牵扯"一次放出 N 个"
  和"弹给最近的敌人"，而**修饰技能的点数还没规则**，所以先不做。
- **只有 3 个触发时机接线**（待裁定项 2）。加一个新的 `TriggerEvent` 时，
  除了 schema / pipeline / conditions / checks / describe / pricing 那**六处**，
  **还有第七处**：得有人在**对的时刻**去调 `runModifierTriggers`。
- **AI 不会主动选修饰技能**（`sim/ai.ts` 仍旧只会"挑一份术式按出来"）。
  ⚠ 触发器是**引擎自己**触发的，所以 AI 挂着带修饰的术式**照样吃得到** ——
  缺的是"AI 自己拼一份带修饰的术式"。
- **我没有额外补"另存为时副本深拷贝"的端到端断言**（`store.ts` 的
  `cloneModifierCopies` 在，`tests/store.ts` 那 72 条里有它，我没再加）。
- ⚠ **`Technique.modifierCopies` 是一个"声明了、没人写"的字段**（收尾时核出来的，
  **没有自己动手补**）：schema 里它有声明（`modifierCopies?: SegmentMod[]`），
  注释说它"给存档迁移 / 分享码的缺零件提示 / 编辑器列清单用"，
  而实测（全仓 grep）**一处赋值都没有** —— 唯一出现赋值形状的是 `store.ts` 的
  `cloneModifierCopies` 里那条**防御性**分支（`if (Array.isArray(out.modifierCopies))`，
  恒为假）。校验器也不查它。
  ⇒ 它今天**不影响任何行为**（测试全绿、validate 干净），但它是这个项目自己列为
  **最危险**的那一类（"声明了没人用"）。⚠ **为什么要裁定而不是我来补**：
  补它要先定"**谁在什么时候把它摊平**、和 `sequences[].mods` 谁是真相"
  （schema 的注释说"这里只是照抄一份便于查"——那就得盯住两份不许漂），
  这是一个设计决定，而编辑器是下一片。**先记在这里，别让它悄悄变成第二个真相。**
- **`desktop/out/win-unpacked/resources/` 里那份 schema 快照是旧的**（打包产物，
  里面还是没有修饰技能的那一版）。没重新打包 —— 那要跑一遍 Electron 打包，
  和这一片无关。
- ⚠ **`docs/sequence-and-modifier-model.md` 第十三节「还没定的 / 欠账」没有更新**：
  上面那 10 条待裁定项**没有**回写到那份定稿文档里（只写在这份日志里）。
  下次动那一节时要把它们收进去，别让"待裁定"只活在日志里。
