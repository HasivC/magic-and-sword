import type { Skill } from '../schema.ts'

export type IssueLevel = 'error' | 'warning'

/** 一条校验结果。path 是 JSON 路径，用来直接定位到出问题的字段。 */
export interface Issue {
  level: IssueLevel
  /** 机器可读的错误码，方便以后做文档和忽略规则 */
  code: string
  path: string
  message: string
  /** 怎么改。校验器的价值一半在这里 */
  hint?: string
}

/** 一行点数明细。这是"算出来的"，不是从 JSON 里读的。 */
export interface LedgerEntry {
  label: string
  points: number
  /**
   * 这一笔是哪一层贡献的。
   *
   * ⚠ `effect`（固有效果）和 `rule`（额外行为）分开报：
   *   界面上要分得清"我改的是这个技能本身"还是"我加了一条额外行为"——
   *   它们在账上是同一套算法（效果折成规则）。
   */
  from: 'effect' | 'rule' | 'phase' | 'ruleSlots' | 'technique'
  refId?: string
  /** 这一条是术式里**哪一段**贡献的。只有术式账会填，编辑器按它分组 */
  skillId?: string
  path: string
}

/** content/balance.json 的形状 */
export interface BalanceConfig {
  schemaVersion: number
  baseRuleSlots: number
  ruleSlotBuyCost: number
  ruleSlotSellGain: number
  /**
   * ⚠⚠ **已作废、没有任何地方读它**（2026-09-30 日志 57）。
   *
   *   它原来是"配平容差（点）"：`|合计| <= balanceTolerance` 就算配平。
   *   为什么当初要它：定价表是一个**有限项模型** —— 射程、投射物、
   *   触发频率这些还没有计价项，硬追绝对 0 会让每个技能都差零点几。
   *
   *   **现在它不存在了。** 用户的规格：
   *   > **点数之和大于 0 就能用，小于 0 就要支付血契才能用**
   *   ⇒ 判据只剩一条（`pricing.ts` 的 `kindOf`：`合计 < 0` ⇒ `negative`），
   *     "差 2 点也算平"那种宽容度**没有了**。差额改由**整数化**
   *     （逐条取整 + 至少 1 点，见 `integerPointsOf`）处理，
   *     唯一的缓冲是机器精度 `POINT_EPS`。
   *
   *   ⚠ **字段本身还留着，只为一件事**：`web/src/**`（编辑器 UI）当轮**冻结**，
   *     它读 `host.balance.balanceTolerance` —— 删掉这个类型字段它编译不过。
   *     留着 = 它读到 `undefined`、自己退化成"没有容差"（新口径，正确）。
   *     **能改 UI 的那一轮应该把这里和 `priceOptionsFor` 的残留一起删干净。**
   *   ⚠ `content/balance.json` 里那个键**已经删掉了**（连同解释它的 `_` 文案）。
   */
  balanceTolerance?: number
  rates?: Record<string, number>
  /**
   * **修饰技能（份数类）的汇率** —— 和 `rates` **分开一栏**（2026-09-21 日志 51）。
   *
   * ⚠ 为什么不能塞进 `rates`：`tools/calibrate.ts` 的拟合变量是
   *   `Object.keys(DEFAULT_RATES)` —— 往那张表里加一个键，**标定输出立刻变**，
   *   而标定必须逐行不变（修饰不进战斗）。所以它单开一栏，
   *   而形状仍然是**数据**（见 `pricing.ts` 的 `modifierRateOf`）。
   */
  modifierRates?: Record<string, number>
  /**
   * **查表定价的档位表**（2026-09-30 日志 59）—— `表名 → （档位 → 整数点数）`。
   *
   * ⚠ 和 `modifierRates` 一样**单开一栏**，理由更硬：
   *   `tools/calibrate.ts` 的拟合变量是 `Object.keys(DEFAULT_RATES)`，
   *   而且 `--write` 会把 `rates` 里每个键**写成拟合出来的小数** ——
   *   表塞进 `rates` 会被标定器压成小数，而档位必须是**整数**。
   *
   * 形状见 `pricing.ts` 的 `readTierTable`（`_` 开头的键是文案，不是档位）。
   */
  tierTables?: Record<string, Record<string, unknown>>
  /**
   * **全量点表**（2026-09-30 日志 60b）—— `技能 id → 变量 → 取值 → 整数点数`。
   *
   * ⚠ 这是**账的算法的开关**（`pricing.ts` 的 `readLookupTable` 读它，
   *   `skillLedger` 按它决定"查表 + 相加"还是走老公式路）。
   *   `_` 开头的键是文案（`_这是什么` / `_口径`），不是技能分区。
   *
   * ⚠ 形状故意写成 `Record<string, unknown>`：**读的人是 `readLookupTable`**
   *   （它逐格挑整数出来），校验的人看着它说人话（`checkBalance`）。
   *   在这里再声明一遍精确形状等于把"表的形状"抄两遍。
   */
  lookupTable?: Record<string, unknown>
}

/** 一组检查的通过情况，CLI 用它画勾叉 */
export interface CheckGroupReport {
  name: string
  errors: number
  warnings: number
}

export interface ValidationReport {
  file: string
  id: string
  name: string
  kind: 'normal' | 'negative'
  /** 推导出来的点数合计。**正 = 收益，负 = 代价** */
  total: number
  /** 声明的合计（老存档里的 points.total），只用来对比 */
  declaredTotal: number
  /**
   * 超模技能每次使用要消耗多少血契。
   *
   * ⚠⚠ 2026-10-06（日志 66）**术式这一侧改口径了**：它 = 三段式表的
   *   `threeSection.bloodPact` = `max(0, −主动序列的点数和)`（裁定 (A)）——
   *   也**正是引擎扣的那个数**（`src/sim/cast.ts` 的 activate 读
   *   `CompiledTechnique.bloodPactCost`，那个数是 `bloodPactCostOf` 给的）。
   *   ⇒ 报告里这个数、界面上那个数、引擎扣的数**同一个来源**。
   *   ⚠ 技能那一侧（`validateSkill`）仍然是 `|合计|`：技能**没有"哪一半"**
   *     这回事（技能不是"按一下放出来的一串"），而且技能不会被释放。
   */
  bloodPactPerUse: number
  ledger: LedgerEntry[]
  /**
   * **没有账**，以及为什么（一句人话）。有账时为 undefined。
   *
   * ⚠ 它存在的理由：不显示账这件事必须是**说出来的**，不能是静默的。
   *   静默的话玩家看到的是"这一点数明细都没有" —— 他会以为校验器漏了，
   *   或者更糟：以为这个术式是**免费的**（零成本 = 白送）。
   *
   *   两种情况：
   *     · **序列术式**（武器术式）：时间轴和账都在每一条序列里
   *     · **武器技能**：数值由武器属性代入，校验器看不见那把武器
   */
  priceless?: string
  issues: Issue[]
  groups: CheckGroupReport[]
  /** 结构层面是否已经坏到没法继续检查 */
  fatal: boolean
}

export interface TechniqueFile {
  path: string
  skill: Skill
}
