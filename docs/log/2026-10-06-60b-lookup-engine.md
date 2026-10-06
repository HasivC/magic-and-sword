# 日志 60b · 引擎改成「查表 + 相加」：各选中表项相加 = 最终技能点数

- **日期**：2026-09-30
- **触发**：**用户**定的规格（原话，和 60a 同一句，这一片是它的**下半句**）：

  > 一个技能的所有变量的取值对应点数的**和（即线性叠加）**就是最终的技能点数，
  > 为正或 0 能用，为负消耗血契。**因此它必须是实际值。**

  60a 只**造表**（`content/balance.json` 的新一栏 `lookupTable`），
  它把最紧要的一条待裁定写在第 8 节第 1 条：**表里的数加起来 ≠ 今天的实际账**
  （试点实测 120 对耦合）⇒ 要让用户那句成立，**必须把定价改成查表 + 相加**。
  这一片做的就是这件事。
- **动了哪些文件**：
  `src/pricing.ts`（新一节「全量点表」+ `skillLedger` 分叉 + `PriceOptions.lookupTable` + `priceOptionsFor`）、
  `src/validator/types.ts`（`BalanceConfig.lookupTable`）、
  `src/validator/checks.ts`（`checkLookupTable` 第 ② 条 + `checkLookupCoverage` 第 ③ 条）、
  `src/validator/index.ts`（第 ① 条：`validateSkill` 报 `LOOKUP_VALUE_NOT_IN_TABLE`）、
  `src/cli/validate.ts`（新一节「查表覆盖」）、
  `tools/calibrate.ts`（**`--write` 摘掉**）、
  **`web/src/editor.ts` / `web/src/technique-editor.ts`（只有三处装配线 + 三个 import）**、
  `tests/pricing.ts` / `tests/barrier.ts` / `tests/weapons.ts` / `tests/scenario.ts` / `tests/web.ts`（断言跟着账改）、
  `README.md` / `docs/STRUCTURE.md` / `docs/log/README.md`。
  **删掉**：`tools/lookup-table.ts`（上一支代理的孤儿）。
  ⚠ **没有动的**：`web/src/**` 的渲染 / 控件 / 布局 / 文案 / CSS 一行都没碰（用户硬命令）；
  内容里现有数值一个都没改；`balance.json` 的 `lookupTable` **一个数都没改**（那是用户签的字）。

## 一、引擎现在是什么样

用户规格落成一句：**某个技能 = 它每个变量现在选中的取值 → 各查一格 → 纯相加**。

- **删了两样**（在**这条路上**）：
  1. **"非零条目至少 1 点"的地板**（`integerPointsOf` 里那个钳位）——查表这条路**不再经过它**；
  2. **"先加小数再取整"那条路**（`integerizeEntries`）——查表这条路**不再经过它**。
  理由就是用户点名的：表里的数本来就是整数，**相加还是整数**；
  那两样东西正是"**两个变量一起改 ≠ 两项相加**"的根因之一。
- **加了一条什么**：`lookupEntriesOf(skill, base, table)` ——
  遍历**表里那个技能分区的每一个变量**，读它**现在选中的取值**（`lookupValueKeyOf`），
  查一格，非 0 的留一条明细。`total` 就是这些明细的**和**（`reduce`，不取整、不相减）。
- **"出厂值那一格 = 0 ⇒ 出厂技能合计恒 0"照样成立**：
  每份技能的每个变量取的都是出厂值 ⇒ 表里那一格是 0（60a 逐格实测 377 格全 0）⇒ 加起来 0。
  ⚠ 这一条**不再靠"自己减自己"**，靠"**表里那一格是 0**"——这是换算法之后最容易悄悄破的一条，
  所以逐份打印钉着（见第 五 节）。
- **变量清单的权威来源是表本身**（60a §1.1 那张表 = 编辑器今天真画出来的旋钮的快照）。
  引擎**不去重走** `web/src/leaves.ts` 的枚举：那会让 `src/**` 依赖编辑器 UI 代码，
  两份枚举一旦漂移，症状是"某个旋钮的点数**默默**不算了"（本项目最恨的静默不一致）。
  ⚠ 这也是"表里没有的东西不参与定价"这句话的机械含义（见待裁定第 2 条）。
- **分区按基础技能取**（`base.id`），取值从**现在这份技能**读 ——
  "变体 = 模板 + 我的选择"，和 60a 起草每一格时的口径同一个方向。
- **`o.lookupTable` 是这条路的开关**：装了 ⇒ 查表 + 相加；没装 ⇒ 老公式路（见待裁定第 1 条）。

## 二、那三处装配线（逐行 diff）

用户批的是**甲**（只把表装进 `options`）。三处**每一处都只加了一行 `lookupTable:`**
（另加 import 里的那一个名字，否则编译不过），**渲染 / 控件 / 布局 / 文案 / CSS 一行都没碰**。

`web/src/editor.ts`（第 295 行的 `options`）：

```diff
-import { priceRule, priceSkill, readRates, skillLedger } from '../../src/pricing.ts'
+import { priceRule, priceSkill, readLookupTable, readRates, skillLedger } from '../../src/pricing.ts'
@@ createEditor 里那一份 options @@
     ruleSlotSellGain: balance.ruleSlotSellGain,
     tolerance: typeof balance.balanceTolerance === 'number' ? balance.balanceTolerance : 0,
+    // ⚠ 全量点表（2026-09-30 日志 60b）：装上它，技能的点数才是**查表 + 相加**
+    //   （用户规格）。不装的话账会**静默地**退回老公式 —— 而编辑器里看到的数
+    //   就会和命令行算出来的不一样（本项目最恨的那类漂移）。
+    lookupTable: readLookupTable(balance.lookupTable),
     // ⚠ 不传的话，引用状态库的规则在点数条上是 0 点
     ...(host.statuses !== undefined ? { statuses: host.statuses } : {}),
```

`web/src/technique-editor.ts`（第 232 行，术式编辑器那一份）：

```diff
-import { groupBySkill, priceTechnique, readRates, skillLedger } from '../../src/pricing.ts'
+import { groupBySkill, priceTechnique, readLookupTable, readRates, skillLedger } from '../../src/pricing.ts'
@@ createTechniqueEditor 里那一份 options @@
     ruleSlotSellGain: host.balance.ruleSlotSellGain,
     tolerance: typeof host.balance.balanceTolerance === 'number' ? host.balance.balanceTolerance : 0,
+    // ⚠ 全量点表（2026-09-30 日志 60b）：装上它，技能的点数才是**查表 + 相加**
+    //   （用户规格）。不装就**静默**退回老公式 —— 界面上的数和命令行对不上。
+    lookupTable: readLookupTable(host.balance.lookupTable),
     ...(host.statuses !== undefined ? { statuses: host.statuses } : {}),
```

`web/src/technique-editor.ts`（第 1147 行，`techniqueLedger` 那个"给外部用的出口"）：

```diff
     ruleSlotSellGain: balance.ruleSlotSellGain,
     tolerance: typeof balance.balanceTolerance === 'number' ? balance.balanceTolerance : 0,
+    // ⚠ 全量点表（2026-09-30 日志 60b）：这一份是"给外部（测试）用的出口"，
+    //   它必须和界面上那一份**逐字相同**（否则测试绿着、界面是另一个数）。
+    lookupTable: readLookupTable(balance.lookupTable),
     ...(statuses !== undefined ? { statuses } : {}),
```

**断言**：这三处 diff 里**没有一行改动落在渲染 / 控件 / 布局 / 文案 / CSS 上** ——
只多了一行往 `options` 里装的键，和 import 里的一个名字。

⚠ **别处也跟着改了一处**（逐个点名）：`src/pricing.ts` 的 `priceOptionsFor` 也加上了
`lookupTable: readLookupTable(balance.lookupTable)` —— 命令行 / 校验器 / 桥都走它，
是**第 4 处装配线**（它对手拼 `options` 的那三处不生效，所以那三处才要单独改）。

## 三、账的算法换了 ⇒ 断言跟着改的逐条清单

⚠ **没有"默默改"**：下面每一条都是"账从公式换成纯相加"的直接后果。

| # | 断言（改前 → 改后） | 为什么必须改 |
| --- | --- | --- |
| 1 | `tests/pricing.ts` 第 ④ 组"差 1 点也是负值术式"：那笔例子从**伤害 30 → 60** 改成 **30 → 50**（期望仍是 −1） | 表里裂地斩的伤害行是 `10 / 25 / 30 / 50 / 200` —— **没有 60 那一格**。60 是**表外取值**（第 ① 条要报错，账上还会留一条 `⚠ 表外取值`）；50 那一格恰好还是 **−1**，要钉的东西（差 1 点就算负值术式、要付血契）**一个字都没变** |
| 2 | `tests/weapons.ts`「变体买 **6** 条规则位 → 花掉 6 × ruleSlotBuyCost」→「买 **4** 条 → 花掉 4 × ruleSlotBuyCost（查表那一格 = −6）」 | 表里 `ruleSlots` 那一行是 `0…8`（出厂 4 ⇒ 0 点，8 ⇒ −6 点）。买 6 条 = 10 条 ⇒ **表外**（点数 0）——而这一节要的是"一份改强了的变体"，账上必须有数 |
| 3 | `tests/web.ts`「变体买 6 条规则位 = 花掉 9 点 / `比模板强 9 点`」→「买 4 条 = 花掉 6 点 / `比模板强 6 点`」 | 同第 2 条（同一个变体、同一个表外取值） |
| 4 | `tests/web.ts`「自定义技能的账进了术式（**规则位**那一条）」：检查的字串从 `规则位` 改成 `ruleSlots` | ⚠ **账上的措辞变了**：新账记的是"**被选中的那一格**"，标签就是**表里的变量键**（`ruleSlots = 8`）。中文名（"买 4 条规则位（初始 4）"）是**老公式路**那一代的措辞，描述的是"哪条规则被买了"。要不要给变量键配中文名是**用户**的事（见待裁定第 3 条） |
| 5 | `tests/scenario.ts` 血契那节的变体：**买 10 条规则位 = 15 点** → **买 4 条 = 6 点** | 同第 2 条（10 + 4 = 14 条 ⇒ 表外 ⇒ 血契消耗会变成 0，而这一节要的正是"一份**负值术式**真的带上了血契消耗"） |
| 6 | `tests/barrier.ts` 三条（"放行敌人的子弹 → 拿回点数" / "挡住自己的子弹 → 也更省额度" / "挡住敌人（人）→ 更值钱"）→ **合成一条**："⚠ 四个 `block` 开关**不在点表里** ⇒ 查表账对它们一字不动（0 点）—— 待用户裁"。断言数 **27 → 25** | ⚠⚠ **这是这一片最要紧的一条语义后果**：那四个开关住在**实体预设**（`EntityDef.block`）里，**不在技能的任何数值叶子上** ⇒ **表里没有格子** ⇒ 查表账对它们**一个字都不动**。老公式（`barrierPoints`）会为它们计价。⚠ 它**不是**"忘了填表"：60a §8.5 第 ⑤ 条早就把"修饰零件参数与武器属性要不要进表"挂出来问用户了。这里**如实钉住现状**，同时列进待裁定（第 2 条），不让它变成一个没人知道的洞 |

⚠ 除这 6 条以外，`tests/**` 里**没有别的断言动过**（合计 1786 → 1784，
= 1786 − 2，那 2 条就是 barrier 那三条合成一条的结果；15 个断言文件的和 1757 → **1755**）。

## 四、三条校验规则（用户第 3 条）

| | 规则 | 级别 | 住在哪 | 出厂内容上的实测 |
| --- | --- | --- | --- | --- |
| ① | **表外取值 → 报错**（**不许静默当 0**） | `error` `LOOKUP_VALUE_NOT_IN_TABLE` | `validateSkill`（逐份技能，基准是它的 `basedOn`）**+ 账那边**：`lookupEntriesOf` 为这一格留一条 `⚠ 表外取值：…（表里没有这一格）` 的 **0 点记录**（看得见） | **0 条**（60a 覆盖实测 0 漏，60b 复验 0 漏） |
| ② | **同一个变量的表项全部相等 → 报警**（= 那个旋钮在账上是死的） | `warning` `LOOKUP_DEAD_KNOB` | `checkBalance`（只看表本身） | **93 条** —— 全是"整行 0"，和 60a §8.6 那个数**逐位相同**（射程 / 宽度 / 投射物速度 / 占用施法者……今天不参与定价） |
| ③ | **表必须覆盖内容里出现的每个技能 / 每个变量** | `error` `LOOKUP_SKILL_NOT_IN_TABLE` / `LOOKUP_VARIABLE_MISSING` | `checkLookupCoverage`（**跨文件**，命令行新一节「查表覆盖」） | **0 条**（32 个技能都在表里、32 个分区、每个阶段的两个 `@` 键都在） |

⚠ **① 和 ③ 是"覆盖"的一体两面，故意不重复报**：③ 管**结构**
（内容里有这个技能 / 这一段吗），① 管**取值**（内容里这个数在表里吗）。
少了 ③ 的话，"**新增一份技能、忘了进表**"会**静默地**退回老公式 ——
① 查不出来（没有分区 ⇒ 一个变量都枚举不到 ⇒ 一条错都不报）。

⚠ **表外取值不许静默当 0** 的机械判据（实测，`.scratch/lookup60b/rules.ts`）：

```
① 表外取值（伤害 30 → 60）：账 = 0 点，明细 1 条
     0  ⚠ 表外取值：effect.0.then.0.payload.amount.const = 60（表里没有这一格）
   校验器：✓ error [LOOKUP_VALUE_NOT_IN_TABLE] effect.0.then.0.payload.amount.const
② 死旋钮：93 条警告（级别 warning）
③ 覆盖（出厂内容）：0 条
   拿掉 skill.blink 的分区 ⇒ 1 条：LOOKUP_SKILL_NOT_IN_TABLE skill.blink
   拿掉 skill.cleave 的 @打断等级.2 ⇒ 1 条：LOOKUP_VARIABLE_MISSING @打断等级.2
```

## 五、用户那句话成真的证据（各表项相加 = 合计）

```
⭐ 相加：伤害 50 单独 = -1；规则位 8 单独 = -6；两个一起 = -7
   两项相加 = -7 ⇒ ✓ 相等
     -1  effect.0.then.0.payload.amount.const = 50
     -6  ruleSlots = 8
```

⚠ 这一条**正是老账做不到的事**：60a §8.1 实测过 **120 对耦合**（两条单独 −1 的改动一起做可能只有 −1）。
现在它是**构造出来的**：账 = 各条之和，没有第二种算法。

## 六、`calibrate`：**留壳，但把 `--write` 摘掉**（判断项）

- **判断**：留一件**只报告、不写回**的壳，**不删**。
- **理由**：它的存在理由（"拟合汇率，让每个技能的账等于目标值"）**确实没了** ——
  账现在是**查表 + 相加**，汇率只喂**绝对账**（`priceSkill`：报表 / 内部强度标尺），
  而绝对账**不是**玩家看到的那个数 ⇒ 照着它改 `rates` **改不动任何一份技能的账**。
  但 `priceSkill` 逐份打印 + 残差仍然是"这套汇率下的绝对量级"唯一的量化视图，
  删掉它等于把那个视图一起删了 —— 留着**代价是一个工具**，删掉**代价是以后要靠猜**。
- **做法**：`--write` 那一段（写回 `balance.json`）**整段删掉**，尾巴换成一段说明
  （"要改**账**，改的是 `lookupTable`；这里的汇率只喂绝对账"）。
  ⚠ 不"留一个看着还能写的开关"：那比删掉更危险（下一个人会以为它还在改账）。
- **实测**：它的**数值输出逐行不变**（比如 `"summonBase": 10, (+8)` / `"rangePerMeter": 0.14, (-0.26)` /
  最大偏差 **7**、均方根 **8.117 → 2.735** 一个字没变）—— 因为绝对账这一片**一行都没动**。
  ⚠ 退出码 **1**（`stuck`：残差 7 > 一格）**不是这一片引入的**：那一条判据（`worst1 > GRID`）我一行没碰。

## 七、孤儿文件

`tools/lookup-table.ts` **删掉了**。它 `import` 了 `src/pricing.ts` 里今天不存在的
`LOOKUP_TABLE_VERSION` / `variableKeyOf` / `valueKeyOf`，
写的是 `content/lookup-table.json`（那个文件根本不存在），而且**不在** `tsconfig.json` 的 include 里、
`validate` 也不扫它 ⇒ 与三条硬指标无关，**只会误导下一个人**（60a §8.3 把它挂着等裁定，这一片按用户的直接命令删）。
⚠ 全仓 grep 确认：除了 60a 那份**历史日志**，没有任何地方引用它。

## 八、验证（真实输出）

```
$ npm test                      exit 0
  ✓ 全部 236 / 50 / 80 / 240 / 25 / 32 / 57 / 146 / 128 / 88 / 429 / 71 / 72 / 27 / 74 个断言通过
  ✓ 全部 11 个用例通过（smoke）      ✓ core-sim 纯净性检查通过（18 个文件）
  ⇒ 17 个文件全绿；合计 1784 = 1755 + 11 + 18（改前 1786 = 1757 + 11 + 18，只差 barrier 那 2 条）

$ npm run validate              exit 0
  汇总  57 个文件 · 57 通过 · 0 失败 · 9 警告          ← 四个数一个都没变
  查表覆盖  ✓ （32 个技能都在表里 · 表里 32 个分区 · 0 条漏）   ← 新一节
  ⚠ 平衡配置那一栏多了 93 条 [LOOKUP_DEAD_KNOB] 警告（第 ② 条）——
    它**不计进汇总**（汇总只数每个文件自己的警告），所以 57/57/0/**9** 四个数照旧

$ npm run typecheck             exit 0（无输出）
$ npm run build:web             exit 0

$ node src/cli/battle.ts content/scenarios/duel.json --duration 12
  bytes=1989
  sha256=44C782A4984C3922A728786E9A63B9BC2396D5DCED1570FDE19C93CD942998B1
  ⚠ 与基线**逐位相同**且**文件非空**（空文件的 E3B0C442… 也合法 ⇒ 光比哈希会假通过）
  ⚠ 采集口径：`| Out-File -Encoding utf8`（Windows PowerShell 5.1 ⇒ BOM + CRLF ⇒ 1989 字节）

$ npm run calibrate             exit 1（= stuck，残差 7，判据未动）
  数值输出逐行不变；尾巴上"要写回… --write"换成"只报告、不写回"那三行
```

⭐ **出厂全 0 逐份打印**（`.scratch/lookup60b/zero.ts`，32 技能 + 14 术式）：

```
装了表：true · 分区 32
  ✓ 32 份技能（灵光盾 … 刺击）每一份都是 0 点 · 0 条明细
  ✓ 14 份术式（血契 … 潜行）每一份都是 0 点 · 0 条明细
⭐ 出厂全 0（32 技能 + 14 术式）
```

## 九、待裁定（我没自己定的地方）

1. **⚠⚠ 没装表的时候走老公式路 —— 这条退路留着对不对。**
   今天 `o.lookupTable === undefined` ⇒ `skillLedger` 走 `ledgerEntries`（老公式 + 相减 + 整数化）。
   留着它的**唯一**用处是"合成探针"（`tests/pricing.ts` 那些手拼 `PriceOptions` 的用例钉的是老公式）。
   ⚠ 代价：**"非零条目至少 1 点"的地板和"先加小数再取整"这两样东西在代码里还活着**（只服务那条路 + 绝对账）。
   要连根拔掉的话得**删掉 tests/pricing.ts 里大约七十条公式断言**（那是一整节一整节地删）——
   我判断那是**另一次手术**，不在这一片的预算里。**请用户裁**：
   留着退路（现状），还是"**没有表就直接报错**"（那样老公式那一整套可以整个删掉）。
2. **⚠⚠ 表里没有的东西不参与定价。** 用户规格只覆盖"表里那 377 个变量"，
   于是这些东西**一律 0 点**：实体预设的 `block` 四个开关（屏障，见第三节第 6 条）、
   修饰零件的参数、武器属性、以及 60a §8.5 列的那五样。
   **要不要把它们补进表**是**用户**的事（⚠ 我不许改表里的数）。
   这一片只把后果**摆到明面上**（barrier 那一条断言 + README/STRUCTURE）。
3. **账上的措辞**：新账的标签 = **表里的变量键**（`ruleSlots = 8` / `phases.0.duration = 0.1`）+
   取值。它机械、和表逐字一致，但玩家看到的是路径。要不要中文名（以及中文名住表里还是住代码里）**请用户裁**。
4. **表外取值时那一格算 0**（账上留一条 `⚠` 记录 + 校验器报错）。
   "不许静默当 0"我按"**看得见地说 0**"实现；另一种读法是"**整份技能不给账**"。请用户裁。
5. **`@` 变量在引擎里怎么读**：我按 **60a §1.1 和表自己的 `_口径`**（冷却时机 = 扛着冷却那一段的**名字** /
   打断等级 = `interrupt ?? 'damage'` / 占用施法者 = `=== true`）。⚠ 阶段**重名**时取值键会撞车
   （60a 说生成器留了 `名字#下标` 的保险，出厂内容没有重名）—— 真撞上时查不到格，
   账上会留 `⚠ 表外取值`（不静默），但**取值键的口径要不要也带上下标**请用户裁。
6. **"没有冷却"时 `phases.N.cost.cooldown` 那个变量的值不存在** ⇒ 我让它**贡献 0**
   （理由：那一笔已经记在 `@冷却时机 = 没有冷却` 那一格上，再算一次就是同一笔钱收两次）。
   ⚠ 这条是**判断**，列出来。
7. **校验规则 ② 报在"平衡配置"那一栏**（93 条），所以 `validate` 的汇总仍然是 **9 警告**。
   另一种做法是把它摊到每个技能文件上（那样汇总会变成 **102**）。**请用户裁**放哪儿。
8. **`checkLookupCoverage` 只在命令行跑**（它是跨文件的检查）。编辑器里的实时校验（`validateSkill`）
   拿不到"全部内容"，所以**第 ③ 条在浏览器里不生效**（第 ①② 条有效）。要不要给它一条浏览器路径，请用户裁。

## 十、没做的事（下一片）

- **老公式那一整套没删**（`absoluteEntries` / `ledgerEntries` / `phaseTierProblems` /
  `integerPointsOf` / 档位表 `tierTables`）—— 它们还在给**绝对账**（报表 / `calibrate`）和**没装表的退路**干活。
  ⚠ 用户"删掉地板和取整"这条命令在**查表这条路**上做到了；**绝对账**上它们还在（见待裁定第 1 条）。
- **表里的数一个都没动**（用户签的字）；**明显是 0 但应该有价的格子没自己填** ——
  93 个"整行 0"的变量实例就是清单（`npm run validate` 的平衡那一栏逐个印着）。
- **编辑器 UI 一行没碰**（用户硬命令）：所以账上的中文措辞、以及"表外取值"在界面上的样子，
  都还是老样子（等用户下令那一轮再动）。
- `tools/lookup-table.ts` 那套"生成器"**没有重写**：表是用户的手写数据了，
  要重新生成的话得先问用户（生成器读的是老公式，而老公式已经不是账了）。
