# 「排布」这个修饰零件（一个零件、编辑时选类型）

- **日期**：2026-09-30
- **触发**：玩家点的下一片修饰零件。原话里的规格：
  - **一个零件，类型可选** —— 至少三种：**环绕生成**（把已经存在的那几份
    **分布在施法者周围一圈**；参数 = 半径 / 起始角 / 是否均匀分布）、
    **扇形散射**（以某个角度散开；参数 = 张角）、
    **反向镜像**（**同时朝反方向**也放一次；参数 = 无或偏移角）。
  - ⚠⚠ **两条硬界线**（玩家明确划的，违反了就算做错）：
    1. **它只管"排布 / 路径"，✗ 不管份数** —— 份数归「一分为 X」（已落地）
       或者技能本来就几发；
    2. **它不许改瞄准** —— 意图照旧一个；它只是把**已经存在的那几份**
       摆到不同位置 / 方向。
  - **预算有限**：先实现、后文档；**不要整份读大文件**；**不要动编辑器 UI**
    （玩家有硬命令：UI 在他下令之前一个字都不许动）；**不要做轨迹环绕**（另一件事）。
- **动了哪些文件**

  | 文件 | 改了什么 |
  |---|---|
  | `content/modifiers/layout.json` | **新**：一份原型（`mod.layout`，`kind: 'layout'`）—— 三选一的 `type` + 五个参数 |
  | `content/manifest.json` | 清单里加上 `layout`（不加的话测试当场红：「有文件没进清单，永远不会被加载」） |
  | `content/balance.json` | `modifierRates` 加**三条**汇率（`layoutBasePerPoint` / `layoutPerMeterPerPoint` / `layoutPerDegreePerPoint`）；⚠ **故意不放进 `rates`** |
  | `schema/skill-schema.ts` | `ModifierKind` 加 `'layout'` + 两条硬界线的注释 |
  | `src/school.ts` | 「排布」那一族读法（`modifierLayoutModeOf` / `*RadiusOf` / `*StartAngleOf` / `*SpreadOf` / `*MirrorAngleOf` / `*EvenOf` + 上下限的兜底常数） |
  | `src/sim/compile.ts` | `CompiledMod.layout` 字段 + `compileMods` 里读好 / 夹好 / 出声 |
  | `src/sim/targeting.ts` | **整圈** cos / sin 表 + `rotate2()`（⚠ **只增不改**：老那张 0~90 度表和 `cosDegrees` 一个字没动） |
  | `src/sim/trigger.ts` | 执行器：`layoutPlanOf` / `layoutOffsetsOf` / `layoutRingPointOf` / `placementOptionsOf` + 接进 `activateGroup` |
  | `src/sim/cast.ts` | 抽出 `aimIntentOf()`（原始意图的**唯一**化简处）；`activate` / `pressSequence` 改用它 |
  | `src/validator/checks.ts` | 原型那一组加「排布」的参数校验；`checkBalance` 盯三条新汇率；`MODIFIER_KINDS` 加 `layout` |
  | `src/validator/index.ts` | 副本那一组加 `MODIFIER_LAYOUT_*` 五条规矩 |
  | `src/pricing.ts` | `modifierPointsOf` 里「排布」那一笔 + 三条汇率的兜底值 |
  | `tests/scenario.ts` / `tests/weapons.ts` / `tests/pricing.ts` | 三节新断言（引擎行为 / 校验器 + 纯函数 / 点数） |
  | `README.md` | 计数（55 文件 / 1535 断言）+ 一节说明 |
  | `docs/STRUCTURE.md` | 计数、文件行数、「排布」那一行、日志索引那一行 |

  ⚠ **`web/src/editor.ts` / `technique-editor.ts` 一个字节都没动**（玩家硬命令）。

---

## 改了什么

### 一个零件、三档摆法（参数是数据，不是代码常数）

`content/modifiers/layout.json`：

```json
"paramsTemplate": { "type": {"options": ["ring","fan","mirror"]}, "radius": …, "startAngle": …,
                    "even": …, "spread": …, "mirrorAngle": … }
"params":         { "type": "ring", "radius": 1.5, "startAngle": 0, "even": true,
                    "spread": 60, "mirrorAngle": 0,
                    "minRadius": 0.5, "maxRadius": 6, "maxAngle": 180, "maxSpread": 360 }
```

- **`ring` 环绕**：把**已经存在的那几份**铺在施法者周围一圈 ——
  第 k 份在方位角 `瞄准方向 + startAngle + k × (360 / 份数)` 上（`even: false` ⇒ 去掉最后那一项，
  全都挤在同一束；**不是随机散开** —— 随机不可重放）。
  它给**载体中心**（`aimPoint`）+ 朝向取**径向向外**。
  ⚠ 第 1 份正好落在"朝瞄准方向 R 米"处 —— 所以**瞄准的方向没有被改**。
- **`fan` 扇形散射**：几份**以瞄准方向为中心**均分在 `spread` 度里
  （第 k 份偏 `-spread/2 + k × spread/(份数−1)`）。**落点一个字都不动**，只转方向。
- **`mirror` 反向镜像**：交替 —— 第 1 份照原样、第 2 份转 `180 + mirrorAngle` 度
  （默认 `mirrorAngle = 0` 正好就是玩家说的"**同时朝反方向**"）。
  同样只转方向，落点不动。

### 编译期 / 运行期怎么分工（和现成的三份零件同一套形状）

| 阶段 | 做什么 | 在哪 |
|---|---|---|
| 编译期 | 查原型表 → 把**半径 / 三个角度 / 是否均匀**读好、夹进原型给的范围、夹了就报一条 `CompileProblem`；摆法认不出时 **`layout` 整块缺席** | `sim/compile.ts` 的 `compileMods` |
| 运行期 | `activateGroup` 里**只读** `plan.skillIndices.length`（已经算好的份数），算出**每一份**摆哪儿 / 朝哪儿，逐份生成 `ActivateOptions` | `sim/trigger.ts` 的 `layoutPlanOf` / `placementOptionsOf` |
| 校验 | 摆法三选一 / 半径与角度超范围 / 不是数字 / `even` 不是布尔；`at ≠ 0` 给警告 | `validator/index.ts` + `checks.ts` |
| 定价 | 底价 + 米 + 度（**每一档只为它真的用到的参数付钱**） | `pricing.ts` 的 `modifierPointsOf` |

⚠ **为什么不用三角函数**：「环绕」要算"绕一圈的第 k 个方向"。两条路：
① `sin` / `cos`（purity 测试当场拦下 —— 白名单里没有它们，而且规范不保证跨引擎逐位一致）；
② 把**瞄准方向**这个单位向量**旋转** `Δ` 度（`targeting.ts` 新加的一张**整圈**查表 + `rotate2`）。
选了 ②：于是"起点"天然就是**瞄准方向**（平移 `startAngle`），"均匀分布"就是每份再转 `360/份数`，
一个角度都不用手算。步长 5 度 ⇒ 任意角度吸到最近那一格（0.13% 半径误差），换来可重放。
⚠ 老那张 0~90 度的表**保留不动**（`cosDegrees` 有调用方在依赖：`meleeArc` 的张角判据），
新表是**另开的两张**，两处 0~90 那一段**逐位相同**。

### ⚠⚠ 两条硬界线是**代码形状**，不是靠自觉

1. **不管份数**：`CompiledMod.layout` 里**没有**份数字段；`layoutPlanOf` 的返回值长度**一定**
   等于 `plan.skillIndices.length`；份数那一套（`modifierCountOf` / `MODIFIER_COUNT_KEY`）
   在「排布」这一族读法里**一个字都不出现**。测试里有一条门闩：
   **同一段带 / 不带排布，`groupPlanOf` 给出的份数列表逐位相同**。
2. **不改瞄准**：它拿到的意图**只有一个**（`opts.intent`，经 `cast.ts` 的 `aimIntentOf` 化简 ——
   ⚠ 这一步是**新抽出来**的：以前 `activate` / `pressSequence` 里各写一份同样的链子，
   而排布要读"意图里那半个方向"，自己再判一次就会出现"看不到 `opts.facing`、
   于是按 (1,0) 排了一圈"这种只在老调用方（测试 / AI / 命令行）下出现的错位 —— **真踩过**：
   `pressSequence` 只给 `facing` 时环绕整整差了 90 度）。
   它只改三样：**方向那一半、朝向、落点**；**不改 `targetId`**、**不碰任何代价字段**。
   测试里钉着：**扇形 / 镜像一份 `aimPoint` 都不给**；意图是 `point`（点地面）时
   **`x` / `y` 逐位不变**。

---

## 为什么

### 点数：一条底价 + 两个小增量（⚠ 建议值、**待玩家签字**）

硬指标要求"**点数随类型与参数变**"。最直接的做法是**三档各一条独立汇率**，
但那会立刻撞上一个约束：**三档共用一个容差**（`balanceTolerance` = 2 点），
分开调就迟早出现"环绕比镜像便宜一半、而同一次激活里两者买到的东西差不多"这种自相矛盾的账。
⇒ 所以改成：**一个"装上这个零件"的底价** + **两个"参数越极端越贵"的小增量**，
三档的差价**全部由参数**表达。而且**每一档只为它真的用到的参数付钱**：
`ring` = 米 + 起始角、`fan` = 张角、`mirror` = 米 + 镜像角
（三个都收的话，"环绕"会为它用不到的张角付钱 —— 那是同一件事收两次钱的翻版）。

建议值与理由（写在 `balance.json` 那三条的 `_layout*` 里，**待玩家签字**）：

| 键 | 建议值 | 一句话 |
|---|---|---|
| `layoutBasePerPoint` | **0.8** | 参照系是「多打一份」的 2 点：排布**不产生新的一份**，买到的是"**同样这几份**摆得更好用" ⇒ 取 2 点的 0.4 倍 |
| `layoutPerMeterPerPoint` | **0.1** | 半径越大，那几份离施法者越远（越难被范围技能一起照顾到、也越难同时打中同一个目标） |
| `layoutPerDegreePerPoint` | **0.005** | 角度越极端越贵 |

最贵的三笔：`ring 0.8 + 6×0.1 + 180×0.005 = 2.3 点`、`fan 0.8 + 360×0.005 = 2.6 点`、
`mirror 0.8 + 6×0.1 + 45×0.005 = 1.625 点`。
⚠ **老实说：散射和环绕最极端那两笔超过了配平容差（2 点）**（最便宜那一档 0.85 点，
远大于"看得见"的门槛）。这是**故意的取舍**，写在这里让玩家裁定：把半径拉满、张角开整圈，
是**整门术式**的配平结果，而不是容差内的小调整。想让每一档都落在容差里 ⇒
把 `layoutPerDegreePerPoint` 降到 0.003 以下（360 度 = 1.08 点）—— 改的是**数据里的一个数**。

⚠ 三条都**故意不在 `rates` 里**：`tools/calibrate.ts` 的拟合变量是
`Object.keys(DEFAULT_RATES)`，往那张表里加一个键，标定输出**立刻变** ——
而"标定逐行不变"是这一片的硬指标（修饰零件不进战斗）。

### 待裁定项（**没有自己定**，见下面第 6 节）

规格里没写清的地方一律**停下、写进报告**，没有自己定：1 份时摆不摆开、
`startAngle` 的 0 度算哪个方向、环绕挪落点算不算"改瞄准"、三档之外要不要留扩展位。

---

## 验证

| 命令 | 结果 |
|---|---|
| `npm test` | **17 个文件全绿**；合计 **1535** 个断言（口径 `1506 + 11 + 18`，用 README 里那段 PowerShell 逐个文件读出来的） |
| `npm run validate` | **55 个文件 · 55 通过 · 0 失败 · 9 警告**（文件数 54 → 55 = 多了一份原型；**警告数没变**） |
| `npm run typecheck` | 通过（两个 tsconfig 都过） |
| `npm run calibrate` | **逐行不变**：`E829F40B2BA7DBED95969C276BD5EAB89AAA9E3D03ABA09DA1C3894FDE3AFEAE`（前 `E829F40B…`） |
| `node src/cli/battle.ts content/scenarios/duel.json --duration 12` | **逐位不变**：`656C37F99ACCD88D3CD993DD011C9DEDC28F8B537435207B87CD29739BFFD041`（前 `656C37F9…`） |
| `npm run build:web` | 成功 |
| ⭐ 出厂全 0 | 逐份打印 **32 技能 + 14 术式**：每一份的**合计与条目数两个都是 0**（`.scratch/layout53-factory-zero.ts`） |
| 纯净性 | `core-sim 纯净性检查通过（18 个文件）` —— 没有 `Date` / `Math.random` / `sin` / `cos` 之类 |
| 引擎行为 | `scenario` 278 → **321**（第 52–56 节）、`weapons` 141 → **183**、`pricing` 148 → **169**（**+106**，其余 12 个断言文件一个数都没变） |

改动前的快照存在 `.scratch/layout53-before/`（`content` / `src` / `tests` 的 159 个 SHA256 +
五条命令的原始输出 + 两条哈希）。

---

## 欠账

- **`at > 0` 今天不生效**（和「多重释放」/「一分为 X」同一个限制）：执行器只处理段的
  **第一份施法**。⚠ 排布**必须**和份数落在同一处（它摆的正是份数算出来的那几份），
  所以两者分家就没人知道该摆哪几份 ⇒ 校验器给 `MODIFIER_GROUP_AT_NOT_WIRED` 警告，不静默。
- **编辑器 UI 一个字都没动**（玩家的硬命令）：`type` 三选一、半径 / 角度的旋钮、
  "是否均匀"的开关都还只在数据里 —— 界面上今天**拖不进这个零件**。
  `paramsTemplate` 已经照模板的形状写好了（含 `min` / `max` / `step`：⚠ 角度 / 半径的旋钮
  **应该按 5 度 / 0.1 米**走，因为旋转查表就是 5 度一格）。
- **轨迹环绕**（投射物"飞出去绕着转"）**没做** —— 那是一套新机制，单独立项。
- 环绕的落点语义在**近战 / 自身范围**技能上有反直觉的一面（第 6 节 c）。
- 「排布」和「等待」/「一分为 X」**叠加**怎么算没有规定（各自独立记一笔，没有组合项）。
- HUD / 预览**没有**画"这几份会摆在哪"（`peekSequence` 只回答"能不能放"）。
