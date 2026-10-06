/**
 * 点数推导。
 *
 * ## 为什么必须有这个文件
 *
 * 第一版把点数**手写**在规则、阶段、状态上。玩家把"30 伤害"改成"300 伤害"，
 * 点数纹丝不动 —— 等于可以白嫖。
 *
 * 那是在编辑器里实测踩到的：**手写的价格表和数值是两份会漂移的东西。**
 * 所以现在的规矩是：
 *
 *   **点数由内容推导。你改数值，点数自己跟着变。**
 *
 * ## 符号约定：这是一本「额度账」
 *
 *   负数 = **消耗额度**（效果本身、买规则位）
 *   正数 = **提供额度**（代价：扣能量、冷却、自我限制、卖规则位）
 *
 * ## ⚠ 账是**相对出厂值**算的（玩家 2026-09-21 定的宗旨）
 *
 *   玩家原话：
 *
 *   > 所有点数相关的可调整的值，都具有一个默认值，在这个默认值下点数是配平为0的。
 *   > ……是按**技能**算。
 *   > （默认值从哪来）**每个技能自己定（内容里的就是默认）**
 *
 *   所以这本账算的是**你改动了多少**，不是"这个东西绝对值多少"：
 *
 *     账 = 现在的技能 − 内容里的那个技能     （逐条贡献相减，见 `skillLedger`）
 *
 *   推论，每一条都重要：
 *
 *   · **出厂内容全部是 0 点。** 没被玩家改过的技能，账是空的 —— 这是对的，
 *     它表达的是"你拿到的这套东西本身就是配平的"。不会出现"两个数值相同
 *     而效果不同的火球"（玩家原话），也不会出现"出厂技能自带一笔点数额度"。
 *   · **机制免费，数值有价。** "能位移"这件事不要钱，
 *     位移了**几米**才要钱（玩家原话："位移的机制本身是不应该有代价的，
 *     位移的距离有代价"）。这一点由"逐条相减"自然满足：
 *     机制不变的那部分在两边一模一样，相减就没了。
 *   · **配平的责任在术式上，不在技能上。** 技能改过之后可以很歪
 *     （把冷却拉到 20 秒换来一大堆额度），术式必须收支相抵。
 *   · **单个技能当术式用时，它自己就必须配平** —— 那时它就是成品。
 *
 *   ⚠ 出厂内容"应该"值多少点（"一个标准技能该有多强"）**不是这本账管的**：
 *   那由 `docs/default-values.md` 那张**写内容时用的强度标尺**管，
 *   而汇率（`content/balance.json` 的 `rates`）决定**交易价格**——
 *   "4 米射程值多少伤害"。两者别再混在一起看。
 *
 *   合计 **< 0** = 花超了 = **负值术式** → 每次使用按 |合计| 消耗血契。
 *   合计 **≥ 0** = **能用**（正好平、或者还有余额没用完）。
 *   ⚠⚠ 2026-09-30（日志 57）这句以前写的是"合计 > 0 = 不超模，只是**没配平**"——
 *     现在**"没配平"这个状态不存在了**：用户定的规格是
 *     "**点数之和大于 0 就能用，小于 0 就要支付血契**"（容差整个删掉了）。
 *
 * ⚠ 这个方向反过一次，值得写下来。
 *
 *   玩家原话：**"买卖规则位得点数的正负反了。"**
 *   他的意思是：账本里别的东西都是"消耗额度 = 负"，唯独"买规则位"
 *   （同样是消耗额度）显示成 **+1.5**。**那一条的方向反了**，
 *   不是整本账都反了。
 *
 *   我当时把整本账翻了过来（于是"伤害"变成正数），结果把超模的判据也翻反了，
 *   玩家第二次纠正：**"点数为负值的才是超模技能"**。
 *
 *   教训：**账本的方向是从玩家那一侧定的，不能因为一行看着别扭就整本翻。**
 *
 * ## 公式长什么样
 *
 * 每个东西折算成"功率"，功率用一张汇率表换成点数：
 *
 *   伤害 A        →  -A / damagePerPoint        （负 = 消耗额度）
 *   治疗 A        →  -A / healPerPoint
 *   扣能量 E      →  +E / energyPerPoint        （正 = 提供额度）
 *   扣生命 H      →  +H / hpPerPoint
 *   冷却 C 秒     →  +C × cooldownSecondPerPoint
 *   阶段时长 D 秒 →  +D × phaseSecondPerPoint   （前摇后摇本身是代价）
 *   不可打断      →  -uninterruptiblePhase      （这是收益，消耗额度）
 *
 * ⚠ **唯一一条不走汇率的轴是「阶段时长」的档位**（2026-09-30 日志 59）：
 *   玩家看到的那本账里，这一段值多少点**是查表查出来的**（档位 → 整数点数，
 *   见下面的「查表定价」一节），不是 `秒 × 汇率` 算出来的。
 *   `phaseSecondPerPoint` 只留给**绝对账**（内部强度标尺 / 标定器的输入）——
 *   绝对账没有"出厂值"这个参照，档位在它那里无从谈起（见 `absoluteEntries`）。
 *   状态          →  见 priceStatus
 *   重置冷却      →  -cooldownReset
 *
 * 汇率全在 `content/balance.json` 的 `rates` 里 —— **改汇率不用改代码**。
 *
 * ## 这套公式当然不完美
 *
 * "强度"这种东西本质上不可比（射程和伤害怎么换算？）。但**一份会自己更新的
 * 大概价格**，比一份永远和数值脱节的手写价格表强得多。
 * 后面用无头模拟器去调这张表，就是"自动平衡"的正路。
 */
import type {
  Action, AttributeMod, DeliverySpec, EntityDef, ModifierProto, Phase, PipelineHook, Rule, Skill, StatusDef,
  Technique, ValueSpec,
} from './schema.ts'
import { allRulesOf, effectAsRule } from './effects.ts'
import {
  carrierFliesInWorld,
  isConstantSequence,
  modifierBounceCountOf, modifierBounceFalloffOf, modifierBounceMinFalloffOf,
  modifierCountOf, modifierHomingRangeOf, modifierHomingTurnOf,
  modifierLayoutMirrorAngleOf, modifierLayoutModeOf, modifierLayoutRadiusOf,
  modifierLayoutSpreadOf, modifierLayoutStartAngleOf, modifierSecondsOf,
  techniquePaysPoints,
} from './school.ts'
import type { BalanceConfig } from './validator/types.ts'

// ============================================================================
//  汇率
// ============================================================================

export interface Rates {
  /** 多少伤害值 1 点 */
  damagePerPoint: number
  /** 多少治疗值 1 点 */
  healPerPoint: number
  /** 多少能量值 1 点 */
  energyPerPoint: number
  /** 多少生命值 1 点 */
  hpPerPoint: number
  /** 1 秒冷却值多少点 */
  cooldownSecondPerPoint: number
  /** 1 秒阶段时长值多少点（前摇后摇是代价，越长越赚）—— ⚠ **只用于绝对账**（见文件头那一节） */
  phaseSecondPerPoint: number
  /**
   * **能量 0 档的乘数 K**（「不耗蓝」）。
   *
   * 玩家 2026-09-21 裁定「**同一个 K = 9 套所有轴**」
   * （起草时写的「K 只用于阶段时长」被**否掉**了，见 §12.7）。
   * 算法和阶段时长那一项**逐字相同**，只是基底换成「这个技能出厂的能量总额 ÷ energyPerPoint」。
   *
   * ⚠ 基底用**总额**而不是逐段算：能量是「这个技能总共花多少」，
   *   逐段算的话，把一段 20 拆成两段 10 会凭空多算一笔 0 档。
   *
   * ⚠ 出厂内容里**没有任何一段**写 `energy: 0`（也没有一段不写 cost），
   *   所以这一项**对出厂账一个数都不改** —— 它只在玩家真的把耗蓝拖到 0 时才生效。
   */
  energyZeroTierMultiplier: number
  /**
   * **冷却 0 档的乘数 K**（「无冷却」）。
   *
   * 同一把尺（§12.7）。基底是**全技能唯一那一段**的冷却 ——
   * 因为冷却是**技能的唯一属性**（一个技能只有一份冷却，见校验器 `COOLDOWN_TWO_PHASES`），
   * 取「各段相加」会把一个不存在的第二份冷却也算进去。
   *
   * ⚠ 量级：出厂 8 秒冷却 → 0 档 = −9 × (8 × 0.2) = **−14.4 点**，
   *   一笔就把整门术式压成负的 ⇒ 基本只能靠血契付。**用户看过这个数才签的字**（§12.6）。
   *   这是设计意图，不是 bug；嫌贵就调 K。
   *   ⚠ 2026-09-30（日志 57）起账上印的是**整数**，所以这一笔实际印成 −14 或 −15
   *     （看它和同一本账里别的条目怎么分那几格，见 `integerPointsOf`）——
   *     "量级"这句话不受影响。
   */
  cooldownZeroTierMultiplier: number
  /** 蓄力阶段（duration = -1）值多少点 */
  chargePhasePerPoint: number
  /** 不可打断的阶段值多少点收益 */
  uninterruptiblePhase: number
  /** 状态的"强度 × 秒"值多少点 */
  statusPerStrengthSecond: number
  /** 每禁用一项能力、每秒值多少点 */
  controlPerSecondPerPoint: number
  /** 重置一次冷却值多少点收益 */
  cooldownReset: number
  /** 一个能力标志的"禁用权重"，用来算状态强度 */
  disableStrength: number
  /**
   * 免疫一类标签的"强度权重"（霸体）。
   *
   * ⚠ 这一项是**加内容的时候才补上的**。
   *   在那之前 `statusStrength` 只数 modifiers / disables / hardCC，
   *   `immuneTags` 一个字都没提 —— 也就是**免疫控制是完全免费的**。
   *
   *   后果很具体：「铁布衫」只免疫控制的时候，账上还剩 +5.38 点。
   *   当时的直觉是"把代价调低"，但那是错的 —— 真正的原因是
   *   这个效果压根没被计价，代价却在照常扣。
   */
  immuneTagStrength: number
  /**
   * 强制位移：把别人推开 / 拉过来 1 米值多少点。
   *
   * 参照系：1 点 ≈ 10 点伤害 ≈ 1 秒冷却。1 米 ≈ 1 点，
   * 因为 3 米的击退（≈ 一个身位多一点）在体感上和 30 点伤害是一个量级。
   */
  displacementPerMeter: number
  /**
   * 自己位移打几折。
   *
   * 冲刺/闪现买到的不是"能到那儿"（那段路本来就能走过去），
   * 而是"这一瞬间就到"。所以它比推开敌人便宜，但不是免费。
   */
  selfMoveShare: number
  /**
   * 击飞的额外权重（按距离乘）。
   *
   * 击飞 = 位移 + 一段时间碰不到地面，是实打实的压制。
   * 目前引擎里 z 只影响渲染（没有空中判定），所以这一项定得不高 ——
   * 等"击飞期间不能行动"做出来之后要往上调。
   */
  airborneShare: number
  /**
   * "把一次命中掉头"每秒值多少点（`pipeline.reverse`）。
   *
   * 定在 0.8：一个 5 秒的亡灵诅咒值 4 点，正好和"40 能量 + 8 秒冷却"
   * 那个量级的代价对得上。参照系是 statusPerStrengthSecond（0.667/强度秒）——
   * 反转一次命中比单纯加减属性更硬，所以定得略高。
   */
  pipelineReversePerSecond: number
  /**
   * "揪出隐身"一次值多少点（`perception` 的 reveal）。
   *
   * 一次性的动作，所以是**定额**不是按秒。2 点 ≈ 20 点伤害 ≈ 2 秒冷却 ——
   * 反隐是个强功能，但它只在对手真的藏起来时才有用，
   * 所以不该定得太贵（定贵了就成了"没人会带的针对牌"）。
   */
  revealStrength: number
  /**
   * **阵营覆盖**（魅惑）：每秒多少点。
   *
   * ⚠ 在它存在之前，`faction` 是**不参与定价的** —— 而"把敌人变成队友"
   *   是这个引擎里最强的一类效果（对方少一个输出、你多一个）。
   *   没有这一项的话，魅惑就是白送：账上看不出来。
   *
   * 按**秒**算而不是一次算：魅惑 3 秒和 30 秒完全不是一回事。
   */
  factionOverridePerSecond: number
  /**
   * 召唤一具单位的基础代价（不含它的血量池）。
   *
   * 血量的部分按 `hp / hpPerPoint` 单独算 —— 那个锚是现成的
   * （护盾就是这么定价的）。这一项补的是"它在场上还会打人"：
   * 占位、吸引火力、磨血，全都不是血量能表达的。
   *
   * ⚠ 粗估。真正该算的是它的 DPS × 预期存活时间，
   *   而那要读它带的术式、甚至模拟一遍。定在 2 是偏保守的：
   *   宁可把召唤算便宜，也不要让它以"免费"的形式进游戏。
   */
  summonBase: number
  /**
   * **射程**：每米多少点。
   *
   * ⚠ 它是一条**相对**的价，不是绝对的：每个载体类型有自己的标准射程
   *   （`REACH_BASELINE`），只有**偏离标准**的那部分才计价 ——
   *   长了扣点，短了补贴。
   *
   *   这条轴是玩家最早提的那个例子本身："牺牲射程换来伤害提高"。
   *   在它存在之前，射程是**免费**的：一个近战技能把扇形半径从 2.5
   *   拖到 12 米，账面纹丝不动。
   */
  rangePerMeter: number
  /**
   * **范围**：`area` / `aura` 的半径每米多少点。
   *
   * ⚠ 和 `rangePerMeter` 是**两条轴**：
   *   射程 = 打得多远（扇形半径 / 光束长度 / 突刺长度）
   *   范围 = 打得有多广（落在地上一圈多大、光环覆盖多大）
   *
   *   合成一条的话，"火墙的圈该多大"和"火墙能放多远"就挤在同一个价上，
   *   两边都说不清。玩家 2026-09-21 明确要求分开。
   *
   * 同样是**相对**的价：`area` 标准 6 米、`aura` 标准 4 米。
   */
  areaRadiusPerMeter: number
}

export const DEFAULT_RATES: Rates = {
  damagePerPoint: 10,
  healPerPoint: 10,
  energyPerPoint: 10,
  hpPerPoint: 10,
  cooldownSecondPerPoint: 1,
  phaseSecondPerPoint: 1,
  /*
   * 0 档的乘数 K。**阶段时长那一支已经删掉了**（2026-09-30 日志 59）——
   * 它现在是**查表**（`tierTables.phaseDurationPoints`，一条轴一张表），
   * 所以这个数不再存在。剩下两条轴（能量 / 冷却）**一个字都没动**：
   * 用户硬命令「别的旋钮的定价留在后面几步」。
   *
   * ⚠ 这三个数**只是默认值**：真正的值在 `content/balance.json` 的 `rates` 里，
   *   玩家说「先按这个来、以后慢慢测试」⇒ 调它不用改代码。
   */
  energyZeroTierMultiplier: 9,
  cooldownZeroTierMultiplier: 9,
  chargePhasePerPoint: 2,
  uninterruptiblePhase: 3,
  statusPerStrengthSecond: 3,
  controlPerSecondPerPoint: 1.5,
  cooldownReset: 4,
  disableStrength: 1,
  /*
   * 免疫一类标签 ≈ 1.5 点强度。参照系：禁用一项能力是 1 点强度。
   *   免疫一整类（hardCC = 冻结、沉默、缴械……）比"禁用一项能力"更值钱，
   *   因为它是**面向未来**的：以后新加的硬控它自动全挡。
   */
  immuneTagStrength: 1.5,
  displacementPerMeter: 1,
  selfMoveShare: 0.5,
  airborneShare: 0.3,
  pipelineReversePerSecond: 0.8,
  revealStrength: 2,
  /* 阵营覆盖每米 0.4 点。起点值，由 calibrate 拟合。 */
  factionOverridePerSecond: 0.4,
  summonBase: 2,
  /*
   * 射程每米 0.4 点。
   *
   * 起点值，真正该是多少由 `npm run calibrate` 拟合 —— 它是**唯一**
   * 一条"标准值是相对的"轴，所以标定器要同时决定"偏离多少算贵"。
   * 0.4 的直觉：扇形从 2.5 米拖到 8 米（+5.5 米）要付 2.2 点，
   * 而 2.2 点大约是一段"附加 30 点伤害"的量级 —— 这是笔当真的交易。
   */
  rangePerMeter: 0.4,
  /*
   * 范围每米 0.3 点。同样是起点值，由 `npm run calibrate` 拟合。
   *
   * 比射程略便宜是有理由的：射程买到的是"我够得着而对方够不着"，
   * 那是**主动**的优势；范围买到的是"一下子扫到更多人"，
   * 那取决于对手站得多密 —— 它没那么稳。
   */
  areaRadiusPerMeter: 0.3,
}

/** 从 balance.json 里读汇率，缺的用默认值补上 */
export function readRates(raw: Record<string, number> | undefined): Rates {
  const out: Rates = { ...DEFAULT_RATES }
  if (raw === undefined) return out
  for (const k of Object.keys(DEFAULT_RATES) as (keyof Rates)[]) {
    const v = raw[k]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v
  }
  return out
}

// ---------------------------------------------------------------------------
//  「份数」类修饰（多重释放 / 一分为 X）的汇率 —— 2026-09-21 日志 51
// ---------------------------------------------------------------------------
//
//  ⚠⚠ **为什么不放进上面那张 `Rates` / `DEFAULT_RATES`**（这是一个坑，写在明面上）：
//    `tools/calibrate.ts` 的拟合变量是 `Object.keys(DEFAULT_RATES)`
//    （标定器自己那一行，见它的 `KEYS`）——
//    往 `DEFAULT_RATES` 里加一个键，标定器就会**多拟合一个参数**，
//    `npm run calibrate` 的输出**立刻变**。而这一次的硬要求是
//    "标定必须逐行不变（修饰不进战斗）" ⇒ 所以份数那两条汇率
//    **单开一栏**（`balance.json` 的 `modifierRates`），形状仍然是**数据**。

/** `balance.json` 的 `modifierRates` 里，"每多一份花多少点"那一项的名字 */
export const MODIFIER_EXTRA_COPY_KEY = 'extraCopyPerPoint'

/** `balance.json` 的 `modifierRates` 里，"两个份数修饰叠一起"的额外一笔 */
export const MODIFIER_STACK_PENALTY_KEY = 'stackPenaltyPerPoint'

/**
 * `balance.json` 的 `modifierRates` 里，"**每一秒等待**提供多少额度"那一项。
 *
 * ⚠ 玩家给的规矩（定稿 §八 ③）：**点数按秒数算**、越长越亏 ⇒ **提供额度**、
 *   汇率住在 `balance.json` 里、**不许写死**。这是那一项的名字。
 */
export const MODIFIER_WAIT_SECOND_KEY = 'waitSecondPerPoint'

export const MODIFIER_LAYOUT_BASE_KEY = 'layoutBasePerPoint'
export const MODIFIER_LAYOUT_METER_KEY = 'layoutPerMeterPerPoint'
export const MODIFIER_LAYOUT_DEGREE_KEY = 'layoutPerDegreePerPoint'

/**
 * 「追踪」的三条汇率（2026-09-30 日志 56）——
 * **底价 + 每米搜索距离 + 每度转速**。
 *
 * ⚠ 和「排布」那个零件**故意不共用键**：两者的旋钮各自可调，
 *   共用一个键名会出现"调追踪的转速顺手把排布的每度价也改了"。
 */
export const MODIFIER_HOMING_BASE_KEY = 'homingBasePerPoint'
export const MODIFIER_HOMING_METER_KEY = 'homingPerMeterPerPoint'
export const MODIFIER_HOMING_DEGREE_KEY = 'homingPerDegreePerPoint'

/**
 * 「弹射」的三条汇率（2026-09-30 日志 58）——
 * **底价 + 每弹一次 + 衰减每少一点**。
 *
 * ⚠ 和「追踪」/「排布」**故意不共用键**：三个零件的旋钮各自可调。
 * ⚠⚠ 次数那一档的**上限跟着引擎的深度上限走**（`src/limits.ts` 的
 *   `MAX_ACTION_DEPTH`）：账本这一侧的最贵档位因此**不是**写死在这里的。
 */
export const MODIFIER_BOUNCE_BASE_KEY = 'bounceBasePerPoint'
export const MODIFIER_BOUNCE_TIMES_KEY = 'bouncePerBouncePerPoint'
export const MODIFIER_BOUNCE_FALLOFF_RATE_KEY = 'bouncePerFalloffPerPoint'

/**
 * 三种摆法在**账本上**的名字（`modifierPointsOf` 那条明细的标签）。
 *
 * ⚠ 它是**账本的措辞**，不是引擎的取值表 —— 取值表只有一处
 *   （`school.ts` 的 `MODIFIER_LAYOUT_MODES`，校验器和引擎都读它）。
 *   这里多一份映射是因为账本要说人话（"环绕生成"而不是 `ring`），
 *   而它的键**必须**和那张表一致（对不上时标签回落到取值本身，不炸）。
 */
const LAYOUT_MODE_LABELS: Readonly<Record<string, string>> = {
  ring: '环绕生成',
  fan: '扇形散射',
  mirror: '反向镜像',
}

/**
 * 修饰零件汇率的**建议值**（⚠ 玩家还没签字，见日志 51 / 52 / 53 的报告）。
 *
 * 为什么份数是 2 点：
 *   · **参照系**：一个出厂技能的净值量级 ≈ 2~4 点（`damagePerPoint` 29.083、
 *     `phaseSecondPerPoint` 0.566）⇒ **多一份 ≈ 半个技能**，也就是 2 点；
 *   · **它必须"看得见"**：账上每个非零条目**至少 1 点**（日志 57 的规格），
 *     多一份是 2 点 ⇒ 玩家在编辑器里一眼看得出"多打一个"贵在哪；
 *   · **两个动词共用一把尺**：多重释放买的（多打出 N-1 个不同的技能）
 *     和一分为 X 买的（多掰出 X-1 份）都是"同一次激活里多一份输出"，
 *     今天没有把它们分成两条轴的依据（分成两条 = 两个自由参数，而只有一个约束）。
 *
 * ⚠⚠ 2026-09-30（日志 57）：**"容差 2 点"那条参照系已经作废**（容差本身删了）。
 *   原来的理由"它必须能被容差看见"不再成立 —— 现在的理由是上面第 2 条
 *   （1 点是账的**地板**，不是"容差的可见下限"）。
 *
 * 为什么等待是 0.6 点/秒：见下面那一项自己的注释
 * （参照"一段不可打断阶段的价" 0.601 —— ⚠ 那条也曾拿容差当理由，已改写）。
 *
 * ⚠ 这几个数**只是兜底**：真值在 `content/balance.json` 的 `modifierRates` 里，
 *   校验器会在缺了的时候警告（`BAD_BALANCE`）—— 因为"汇率没生效"和
 *   "这份好处白送"在账面上长得一样。
 */
export const DEFAULT_MODIFIER_RATES: Readonly<Record<string, number>> = {
  [MODIFIER_EXTRA_COPY_KEY]: 2,
  /**
   * 叠加的额外一笔，**今天定的是 0**。
   *
   * ⚠ 为什么是 0 而不是某个正数：叠加的算法本身是**相加**的
   *   （一分为 X 掰出的 X 份 + 多重释放多带的 N-1 个不同的技能
   *   = 一共 X + N − 1 份），而点数**已经按实际份数收了**
   *   —— 再收一笔就是同一件事收两次。
   *   ⇒ 这个旋钮留着，是为了"玩家觉得两个修饰凑一起该有个组合惩罚"
   *     那一天改一个数就行（**待玩家裁定**，见日志 51 报告第 5 节）。
   */
  [MODIFIER_STACK_PENALTY_KEY]: 0,
  /**
   * 「等待 X 秒」每秒提供多少额度 —— ⚠ **建议值，待玩家签字**（2026-09-30 日志 52）。
   *
   * ## 为什么是 0.6 点 / 秒
   *
   * 1. **参照系是"一段不可打断的阶段"的价**：`uninterruptiblePhase` = **0.601 点**
   *    （`balance.json` 的 `rates`）。玩家给这个零件的定位是"**一段可自由排的、
   *    挨打不会没的空档**" —— 它买到的东西和"这一帧是霸体帧"是同一类，
   *    所以一把尺量到底：**1 秒等待 ≈ 0.6 点**。
   *    ⚠ 玩家定的另外两条（"默认不可打断" / "占用施法者"）**故意不另收钱**：
   *      它们不是这个零件买来的好处，而是它的**定义**（不可打断的理由写在
   *      `content/modifiers/wait.json`：能打断的话"晚 X 秒"当场消失）。
   *      再说了 —— 它今天在引擎里本来就执行得到（`Phase.interrupt` / `locks`），
   *      要收钱的话就会和上面那条"一段不可打断阶段的价"再撞一次。
   *
   * 2. **它必须小到"最长的那一档也不炸账"**：用户定的上限是 **3 秒**，
   *    ⇒ 一笔最多 `3 × 0.6 = **1.8 点**`。
   *    ⚠⚠ 2026-09-30（日志 57）：这一条**原来写的是"正好在配平容差（2 点）之内"**，
   *      而那个容差**已经删掉了** —— 现在没有任何"之内"可言，
   *      合计是负的就要付血契，一笔 1.8 点就是一笔 1.8 点。
   *      留着 0.6 的理由只剩下"它和'一段不可打断阶段'一把尺"这一条
   *      （⚠ 这个数**是用户签的字**，本轮不许改）。
   *
   * 3. **它必须大到最短的那一档看得见**：下限 0.2 秒 ⇒ `0.12 点`。
   *    ⚠⚠ 2026-09-30（日志 57）这一条**已经被账本身兜住了**：账上每个非零条目
   *      **至少 1 点**（"逐条取整 + 至少 1 点"的规格），所以 0.2 秒的等待
   *      现在印成 **+1 点**，而不是 0.12 点 —— "几乎免费"那个毛病没有了。
   *     ⚠ 但**汇率本身（0.6）没有动**：它仍然是用户签过字的那个数，
   *      本轮只改账的表示，不改这张表。
   *
   * ⚠ 这个数**只是兜底**：真值在 `content/balance.json` 的 `modifierRates` 里
   *   （缺了校验器会在 `BAD_BALANCE` 里说一句 —— "汇率为 0"和"这一项没计价"
   *   在账面上长得一模一样）。
   */
  [MODIFIER_WAIT_SECOND_KEY]: 0.6,
  /**
   * 「排布」的三条汇率 —— ⚠ **建议值，待玩家签字**（2026-09-30 日志 53）。
   *
   * ## 为什么是"一把尺 + 两个小增量"
   *
   * 玩家给的规格里，排布有**三种类型**和**一组参数**（半径 / 起始角 / 是否均匀 /
   * 张角 / 镜像偏移角），而且硬指标要求"**点数随类型与参数变**"。
   * 把三档各定一个价（三条独立的汇率）会立刻撞上一个约束：
   * 三档买到的是同一类东西（"把这几份摆得更好用"），
   * 三档的价一旦分开调，就迟早出现"环绕比镜像便宜一半、而同一次激活里
   * 两者买到的东西差不多"这种自相矛盾的账。
   * ⚠（2026-09-30 日志 57：原来这句话是"三档共用一个容差"，
   *  容差删掉之后理由换成上面这条 —— **结论没变**。）
   *
   * ⇒ 所以：**一个"装上这个零件"的底价**（`layoutBasePerPoint`）+
   *   **两个"参数越极端越贵"的小增量**（每米 / 每度）。
   *   三档的差价**全部由参数**表达出来（环绕有半径、散射有张角、镜像有偏移角），
   *   而"参数变 ⇒ 点数变"这条要求自动成立 —— 不需要为每一档单独造一条轴。
   *
   * ## 为什么这三个数这么小（0.8 / 0.1 / 0.005）
   *
   * 1. **参照系是"多打一份"的价**：`extraCopyPerPoint` = 2。
   *    排布**不产生新的一份**（硬界线第一条），它买到的是"**同样这几份**
   *    摆得更好用"—— 价值明显低于"凭空多一份"，所以底价取 **0.8 点**（0.4 份）。
   * 2. ⚠ **它必须小到"最极端的那一档也不炸账"**：参数的上限是
   *    半径 6 米 / 张角 360 度 / 起始角 ±180 度。⚠ **每一档只为它真的用到的参数付钱**
   *    （环绕 = 米 + 起始角、散射 = 张角、镜像 = 米 + 镜像角），于是最贵的三笔是：
   *      `ring`   `0.8 + 6 × 0.1 + 180 × 0.005 = 2.3 点`
   *      `fan`    `0.8 + 360 × 0.005          = 2.6 点`
   *      `mirror` `0.8 + 6 × 0.1 + 45 × 0.005 = 1.625 点`
   *    ⚠⚠ 2026-09-30（日志 57）：这三笔**原来被写成"已经超过配平容差（2 点）"** ——
   *      那句话**现在是假话**：容差已经删了，账上没有"之内 / 之外"这回事。
   *      量级本身没变（还是上面那三个原料数；印到账上再逐条取整）。
   *    ⚠ **当初为了让最贵那笔落进容差，`layoutPerDegreePerPoint` 是被压低过的**
   *      （原话："想让每一档都落在容差里 ⇒ 把这个数降到 0.003 以下"）。
   *      现在这条约束**没有了** ⇒ 这个汇率**可以重签**，
   *      但**本轮一个数都没改**（那是用户签字的事，见日志 57 第 5 节）。
   * 3. **它必须大到"最保守的那一档看得见"**：半径取下限 0.5 米、起始角 0 度、
   *    张角 0 度 ⇒ `0.8 + 0.05 = 0.85` 点 ⇒ 账上印成 **−1 点**
   *    （⚠ 2026-09-30 日志 57 起"每个非零条目至少 1 点"，见 `integerPointsOf`。
   *      这一条以前的说法是"远大于容差里看得见的门槛"，容差已删）。
   *
   * ⚠ 这三个数**只是兜底**：真值在 `content/balance.json` 的 `modifierRates` 里
   *   （缺了校验器会在 `BAD_BALANCE` 里说一句 —— "汇率为 0"和"这一项没计价"
   *   在账面上长得一模一样）。
   */
  [MODIFIER_LAYOUT_BASE_KEY]: 0.8,
  [MODIFIER_LAYOUT_METER_KEY]: 0.1,
  [MODIFIER_LAYOUT_DEGREE_KEY]: 0.005,
  /**
   * 「追踪」的三条汇率 —— ⚠ **建议值，待玩家签字**（2026-09-30 日志 56）。
   *
   * ## 为什么是"一把尺 + 两个增量"（和排布同一个形状）
   *
   * 这个零件有两个**各自可调**的参数（转速 / 搜索距离），硬指标要求
   * "点数随参数变" ⇒ 底价（装上这个零件）+ 每米 + 每度。
   * ⚠ 和排布一样，两个增量**分开三条键**：玩家可能只想让"看更远"更贵、
   *   不想动"拐更快" —— 合成一条就调不了了。
   *
   * ## 为什么这三个数这么小（1.2 / 0.05 / 0.05）
   *
   * 1. **参照系是"多打一份"的价**：`extraCopyPerPoint` = 2。
   *    追踪**不产生新的一份**（和排布一样），它买到的是"**这一发**更容易打中"
   *    —— 价值明显低于"凭空多一份"，所以底价取 **1.2 点**（0.6 份）。
   *    ⚠ 它比排布的底价 0.8 贵一半，理由：排布只是"把已有的摆开"（不改变
   *      任何一发能不能打中），而追踪**直接改命中率** —— 那是这一套修饰里
   *      离"输出"最近的一件事。
   * 2. **它必须小到"最极端的那一档也不炸账"**：参数上限是
   *    转速 30 度/tick、搜索距离 16 米，于是最贵那一笔是
   *      `1.2 + 16 × 0.05 + 30 × 0.05 = 1.2 + 0.8 + 1.5 = **3.5 点**`
   *    ⚠⚠ 2026-09-30（日志 57）：这一条**原来写的是"已经超过配平容差（2 点）"** ——
   *      那句话**现在是假话**（容差已经删了）。
   *    ⚠ **当初为了让最贵那笔落进容差，`homingPerDegreePerPoint` 也是被压低过的**
   *      （原话："想让每一档都落在容差里 ⇒ 把它降到 0.02 以下"）。
   *      现在这条约束**没有了** ⇒ 这个汇率**可以重签**，
   *      但**本轮一个数都没改**（用户签字的事，见日志 57 第 5 节）。
   * 3. **它必须大到"最保守的那一档看得见"**：转速取下限 1 度/tick、
   *    搜索距离取下限 1 米 ⇒ `1.2 + 0.05 + 0.05 = 1.3 点` ⇒ 账上印成 **−1 点**
   *    （⚠ 日志 57 起"每个非零条目至少 1 点"；这一格曾经是"远大于看得见的门槛"）。
   *    ⚠ 也就是说这个零件的**便宜那头是 1.3 点**（不是 0.1 点）——
   *      它是"一个明确的机制"，不是一个微调旋钮。
   *
   * ⚠ 这三个数**只是兜底**：真值在 `content/balance.json` 的 `modifierRates` 里
   *   （缺了校验器会在 `BAD_BALANCE` 里说一句 —— "汇率为 0"和"这一项没计价"
   *   在账面上长得一模一样）。
   */
  [MODIFIER_HOMING_BASE_KEY]: 1.2,
  [MODIFIER_HOMING_METER_KEY]: 0.05,
  [MODIFIER_HOMING_DEGREE_KEY]: 0.05,
  /*
   * 「弹射」的三条（2026-09-30 日志 58）。
   *
   * ## 为什么是"底价 + 每弹一次 + 衰减每少一点"
   *
   * 它有两个**各自可调**的参数（弹几次 / 每次衰减多少），硬指标要求
   * "点数随参数变"（和排布 / 追踪同一个形状，三条键分开）。
   *
   * ## 量级
   *
   * · 参照系是"多打一份"的 2 点（`extraCopyPerPoint`）：弹射**不产生新的一份**，
   *   它买到的是"打中一个之后**再打下一个**" ⇒ 底价取 **1.2 点**（和追踪同价）。
   *   ⚠ 同价的理由是"两个零件**可以同时装**"（弹过去的每一段照样会拐）——
   *     底价分开定会让"两个都装"变成一笔说不清的账。
   * · 每次弹射 **0.7 点**：每一次弹射都是**一次新的命中结算**，
   *   所以它是这一套修饰里离"多一份输出"最近的一件事（≈ 三分之一份）。
   * · 衰减 **0.8 点 / 每少衰减 1**：账按 `(damageFalloff − 原型下限)` 收 ——
   *   全衰减不收这一项，完全不衰减最贵。
   *
   * ⚠⚠ **最贵那一档会跟着引擎的深度上限动**：次数上限是
   *   `MAX_ACTION_DEPTH`（`src/limits.ts`，现在 4）⇒ 最贵 = `1.2 + 4×0.7
   *   + (1−0.1)×0.8 = 4.72 点`；默认那一档（2 次、0.7）= `3.08 点` ⇒ 印成 −3。
   * ⚠ 这三个数**只是兜底**：真值在 `content/balance.json` 的 `modifierRates` 里
   *   （缺了校验器会在 `BAD_BALANCE` 里说一句 —— "汇率为 0"和"这一项没计价"
   *   在账面上长得一模一样）。⚠ 它们一律**标待玩家签字**（见日志 58 第 3 节）。
   */
  [MODIFIER_BOUNCE_BASE_KEY]: 1.2,
  [MODIFIER_BOUNCE_TIMES_KEY]: 0.7,
  [MODIFIER_BOUNCE_FALLOFF_RATE_KEY]: 0.8,
}

/** 从 balance.json 的 `modifierRates` 读份数汇率，缺的用建议值补上 */
export function readModifierRates(raw: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = { ...DEFAULT_MODIFIER_RATES }
  if (raw === undefined) return out
  for (const k of Object.keys(DEFAULT_MODIFIER_RATES)) {
    const v = raw[k]
    /*
     * ⚠ 0 是**合法值**（叠加惩罚今天就是 0），所以这里不能像 `readRates`
     *   那样要求 `v > 0` —— 写成 `> 0` 的话"把组合惩罚调成 0"这个动作
     *   会被静默地当成"没写"，然后回落到兜底值（今天是 0，看不出来；
     *   哪天兜底改成 1 就成了一个查不出的 bug）。
     */
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v
  }
  return out
}

// ============================================================================
//  结果
// ============================================================================

export interface PriceEntry {
  label: string
  points: number
  /**
   * 这一笔是**哪一层**贡献的。
   *
   * ⚠ `effect`（固有效果）和 `rule`（额外行为）分开报，虽然它们在账上
   *   是同一套算法（效果折成规则，见 `src/effects.ts`）：
   *   玩家在界面上看到的必须是"我改的那一块"，
   *   而不是一长条混在一起的数字。
   */
  from: 'effect' | 'rule' | 'phase' | 'ruleSlots' | 'technique'
  refId?: string
  /**
   * 这一条是**哪个技能**贡献的。
   *
   * ⚠ 只有术式账（`priceTechnique`）会填。编辑器要靠它把账按段分组显示
   *   （"第 2 段 突进 = 0 点"），否则玩家看到的是一长条混在一起的数字，
   *   没法知道该改哪一段。技能自己的账不填 —— 那时没有"哪一段"这回事。
   */
  skillId?: string
  /**
   * 这一笔落在**三段式切分**的哪一半（2026-10-06 日志 66）。
   *
   * ⚠ `'active'` = **主动那半**（玩家按出来的序列）／
   *   `'passive'` = **常驻那半**（被 `wrap` 包装的序列）。
   *   界面上要按这一栏把同一本账分成两栏显示 —— 这也是"账能说出
   *   这一笔在哪一半"的**唯一**来源（`threeSection` 那两个和就是从它加出来的）。
   *
   * ⚠ **只有 `priceTechnique` 会填**（和 `skillId` 同一条规矩）：
   *   技能自己的账 / 不算账的术式（武器术式）没有"哪一半"这回事。
   *   ⇒ 读它的人先判 `undefined`，**别把"没填"读成 `'active'`**；
   *     唯一的例外是 `priceTechnique` 内部汇总那一步（那里"认不出 ⇒ 按主动算"
   *     是**安全方向**，见那段注释）。
   */
  half?: 'active' | 'passive'
  /** JSON 路径，报错和定位用 */
  path: string
}

/**
 * 术式账的**三段式切分**结果（2026-10-06 日志 65）。
 *
 * ⚠ 定稿 `docs/sequence-and-modifier-model.md` 第十二节那张三段式表：
 *   账按**序列**切（不是按武器 / 魔法切 —— 那是**上面那一层**，
 *   见 `techniquePaysPoints`），切出来的两半各有各的约束：
 *
 *   · **常驻那半**：点数必须 **≥ 0**（为**正**只是警告："为正没有什么用"）；
 *     它**不吃血契**。
 *   · **主动那半**：**可以为负**，而且它才是**血契的来源**。
 *
 * ## ⚠⚠ 裁定 (A)：血契 = `max(0, −主动序列的点数和)`
 *
 * 常驻那半多出来的**正额度不能补贴主动**（两边完全切开）。
 * 另一案 (B)（按整门术式的合计算）**已作废** —— 在 (B) 下"常驻为正"
 * 就**有用**了（能替主动付一部分），和"为正没有用"当场矛盾。
 *
 * ⚠ `passivePoints` 为负 = 违反了"常驻那半必须自己平"（校验器据此报错）；
 *   为**正** = 白给了额度（校验器据此报警告）。`undefined` 表示
 *   **这门术式不切分**（三样：不算账的武器术式 / 技能账 / 技能变体账）。
 */
export interface ThreeSection {
  /** 主动序列那半的点数和（**可以为负** —— 血契就是它的负数部分） */
  activePoints: number
  /** 常驻（被包装）序列那半的点数和（**必须 ≥ 0**；为正只是白给额度） */
  passivePoints: number
  /** 主动那半的**血契** = `max(0, −activePoints)` —— 裁定 (A) */
  bloodPact: number
  /** 两半加起来 —— **必须等于 `PriceResult.total`**（切分不改账） */
  total: number
}

export interface PriceResult {
  entries: PriceEntry[]
  /**
   * 合计。**负 = 花超了（超模），正 = 还有余额没用完**。
   *
   * ⚠ **必须是 0 的是术式，不是技能。**
   *   `priceSkill` 出来的 total 是"这个技能自己值多少"（绝对账，报表用）；
   *   `skillLedger` / `priceTechnique` 出来的 total 是"相对出厂值偏离了多少"。
   *   玩家要看的、配平判据用的，都是**后者**。
   */
  total: number
  /**
   * 'normal'      能用（**合计 ≥ 0** —— 正好 0 和正数都算能用）
   * 'negative' 合计为负 —— 花超了。**每次使用按 |total| 消耗血契**
   *
   * ⚠ 判据是 **total < 0**，不是 > 0。
   *   玩家原话：**"点数为负值的才是超模技能。"**
   *   这是一本"额度账"：效果消耗额度（负）、代价提供额度（正），
   *   加起来是负的，说明效果花的比代价给的多 —— 花超了。
   *
   * ⚠⚠ 2026-09-30（日志 57）**这里原来还有一条产品容差**（`|合计| ≤ 2` 算配平），
   *   **已删**：用户定的新口径是"**点数之和大于 0 就能用，小于 0 就要支付血契**"。
   *   现在账上每一个数都是**整数**（逐条取整 + 最大余数法，见 `integerPointsOf`），
   *   唯一的"缓冲"是机器精度 `POINT_EPS`（浮点护栏，不是设计上的宽容度）。
   */
  kind: 'normal' | 'negative'
  /**
   * 术式账的**三段式切分**（主动那半 / 常驻那半）。
   *
   * ⚠ **只有 `priceTechnique` 会填**，而且**只有魔法术式**会填
   *   （武器术式不算账、技能账没有"序列"这回事）⇒ 其余地方是 `undefined`。
   *   读它的人要先判 `undefined`，别把"没切分"读成"两半都是 0"。
   */
  threeSection?: ThreeSection
}

// ============================================================================
//  从 balance.json 拼出定价选项（**只在这里拼一次**）
// ============================================================================

/*
 * ⚠⚠ 2026-09-30（日志 57）：这里原来有一个 `toleranceOf(balance)` ——
 *   `balance.json` 的 `balanceTolerance`（= 2 点）读出来当"配平容差"用。
 *   **它已经删掉了**（用户规格：产品意义上的容差**不该存在**）。
 *   代码里**没有**任何一个地方读 `balanceTolerance` 了，判据只剩
 *   `total < -POINT_EPS`（见 `kindOf`）。
 *
 *   ⚠ `BalanceConfig.balanceTolerance` **这个类型字段还留着**，理由只有一个：
 *     `web/src/**`（编辑器 UI）当轮**冻结**、一个字都不许动，而它读那个字段。
 *     留着 = 它读到一个 `undefined`、自己退化成"没有容差"（= 新口径），
 *     而不是编译不过。**下一个能动 UI 的人应该把这个字段一起删干净。**
 */

/**
 * 把 `content/balance.json` + 内容库变成一份定价选项。
 *
 * ⚠ **只在这里拼一次。**
 *   以前 `validator/index.ts` 私有一份、`bridge.ts` 私有一份、
 *   浏览器里又拼一份 —— 三份迟早会漂移，而漂移的表现是
 *   "命令行算出来 7.18、游戏里算出来 7.2"；或者更糟：
 *   某一处忘了传 `statuses`，于是引用库状态的效果被算成 0 点（看起来白送）。
 */
export function priceOptionsFor(
  balance: BalanceConfig,
  statuses?: ReadonlyMap<string, StatusDef>,
  entities?: ReadonlyMap<string, EntityDef>,
  modifiers?: ReadonlyMap<string, ModifierProto>,
): PriceOptions {
  return {
    rates: readRates(balance.rates),
    baseRuleSlots: balance.baseRuleSlots,
    ruleSlotBuyCost: balance.ruleSlotBuyCost,
    ruleSlotSellGain: balance.ruleSlotSellGain,
    // ⚠ 这里**不再传 `tolerance`**（2026-09-30 日志 57：产品容差已删）
    // ⚠ 传下去，否则按 statusId / entityId 引用的动作会被定价成 0 点
    ...(statuses !== undefined ? { statuses } : {}),
    ...(entities !== undefined ? { entities } : {}),
    /*
     * ⚠ 修饰原型表也传下去（2026-09-21 日志 51）—— 不传的后果和上面那两条
     *   同一类，但更安静：**份数类的修饰会一笔账都不记**
     *   （账面上那个"一次打 10 个"看起来是白送的）。
     */
    ...(modifiers !== undefined ? { modifiers } : {}),
    /*
     * ⚠ 份数那两条汇率从 `balance.modifierRates` 读（**不在 `rates` 里**）：
     *   `rates` 是标定器的拟合变量表（`Object.keys(DEFAULT_RATES)`），
     *   往里加键会让 `npm run calibrate` 的输出立刻变 —— 而它必须逐行不变
     *   （修饰不进战斗）。缺了就回落到代码里那份建议值（校验器会警告）。
     */
    modifierRates: readModifierRates(balance.modifierRates),
    /*
     * ⚠ **查表定价的档位表从内容侧读**（2026-09-30 日志 59）——
     *   不读的话阶段时长会退回老的线性式，而"编辑器显示 +2、命令行按 +1 扣"
     *   正是这个项目最恨的那类漂移。
     */
    tierTables: readTierTables(balance.tierTables),
    /*
     * ⚠⚠ **全量点表也从内容侧读**（2026-09-30 日志 60b）—— 这是**账的算法的开关**：
     *   装了它 ⇒ 技能的点数 = 查表 + 相加（用户规格）；没装 ⇒ 老公式路。
     *   ⚠ 命令行 / 校验器 / 桥都走这里，所以它们**自动**是查表定价；
     *     编辑器那三处是**手拼** `PriceOptions` 的，得自己传（各一行）。
     *   ⚠ 读不出来（老存档没有这一栏）时是 `undefined` ⇒ 行为一个字都不变。
     */
    lookupTable: readLookupTable(balance.lookupTable),
  }
}

/*
 * ⚠⚠ ---- **这里原来有一份 `isWeaponSide(tech, lookup)`，2026-10-06（日志 64）删了** ----
 *
 * 它判的是"这个术式**引用了 `readonly` 的技能**吗"（武器技能模板），
 * 是**看技能**那一套；而 `techniquePaysPoints`（`school.ts`）判的是
 * "这门术式的**系别**"，是**看术式**那一套。
 *
 * 两份判据在**合法内容**上永远一致（武器术式只能放武器技能，校验器盯着），
 * 但在**没写 `kind` 的老数据** / 系别写错的坏内容上会分叉 —— 而分叉的后果
 * 正是这个项目最恨的那类：**报价 / 血契 / 界面各按各的算，一处都不报错**
 * （旧代码里"校验器说它不算账，绑上键却扣血契"就是这么来的）。
 *
 * 用户 2026-09-30 定的规矩是"**账按武器 / 魔法分开算**"，而"是武器术式吗"
 * 这个结论**只该有一处**：`school.ts`（目录 → 系别、老数据靠
 * `deriveTechniqueKind` 补、内容里 `kind` 是显式字段）。所以这里不再另立一份。
 */

/**
 * 一个术式的**血契消耗**。只有**负值术式**有，其余是 0。
 *
 * ⚠ 这个数是引擎扣血契的依据：编译时写进 `CompiledTechnique.bloodPactCost`
 *   （见 src/sim/cast.ts 的 activate）。所以判据必须和校验器、
 *   和界面上显示的**是同一句** —— 今天那句是**三段式表的裁定 (A)**：
 *
 *     血契 = `max(0, −主动序列的点数和)`（`PriceResult.threeSection.bloodPact`）
 *
 *   ⚠⚠ 2026-10-06（日志 66）**接线之前**这里读的是 `kind === 'negative' ⇒ |合计|`
 *     （整本账的符号）—— 表和引擎**分头算**，于是构造出反例：
 *     **纯常驻 + 多重释放 ×10** ⇒ 表说血契 **0**（常驻那半不能吃血契），
 *     而引擎按整本账收 **18**（多收）。现在两边读**同一个数**，那种分歧在
 *     构造上不可能再出现（不是"记得同步"，是**只有一处**）。
 *   ⚠ 判据的方向别读反了：`negative` 那个判据（**合计为负才是负值术式**，
 *     玩家原话）说的是"这门术式能不能白用"，**不是**"扣多少血契"；
 *     扣多少由**主动那半**说了算。两件事今天各有各的入口。
 *
 * ⚠ 单独抽成一个函数，是因为它有**两个调用点**（命令行加载内容库、
 *   浏览器里改完重编译）。两边各写一遍的话，迟早有一处忘了传 ——
 *   而那个后果是静默的：负值术式不扣血契，等于白送一整套爆发。
 *
 * ⚠⚠ **武器术式为什么永远返回 0：不用在这里写第二句**（2026-10-06 日志 64）。
 *   它的账**根本算不出来**（数字来自武器本身），而那句话已经落在
 *   `priceTechnique` 里（`techniquePaysPoints`）—— 那本账是空的 ⇒
 *   没有 `threeSection` ⇒ 下面那句给 0。
 *   ⚠ 以前这里写着 `if (isWeaponSide(...)) return 0`：那是**第二份判据**，
 *     一旦它和账的判据分叉，"校验器说它不算账、绑上键却扣血契"就会复活。
 *   ⇒ 血契**只**从账里读，两者不可能不一致。
 */
export function bloodPactCostOf(
  tech: Technique,
  lookup: (id: string) => Skill | undefined,
  o: PriceOptions,
): number {
  return bloodPactOfResult(priceTechnique(tech, lookup, o))
}

/**
 * 一本**已经算好的账**里的血契 —— **裁定 (A)**：`max(0, −主动那半)`。
 *
 * ⚠ 为什么要有这个函数（而不是各处写 `priced.threeSection?.bloodPact ?? 0`）：
 *   同一个数有**三个**读者 —— 引擎（`bloodPactCostOf` → `cast.ts` 的扣费）、
 *   校验器（`ValidationReport.bloodPactPerUse` 和它的文案）、界面。
 *   三处各写一遍就是**三份判据**，而这份漂移的症状正是日志 65 那处现形
 *   （**表说 0、引擎扣 18**）。⇒ 只有这一处。
 *
 * ⚠ `threeSection === undefined` **只有一种来源**：`priceTechnique` 判
 *   "这门术式**不算账**"（武器术式 —— 它的数字来自武器本身）。见那里的第一行。
 *   不算账 ⇒ 没有点数 ⇒ **血契 0**。
 *   ⚠⚠ **不是"退化成老口径 `|合计|`"** —— 老口径就是本片修掉的那个 bug，
 *     一个字都不许退回去（真要区分，就去看 `kind`，别在这里猜）。
 */
export function bloodPactOfResult(priced: PriceResult): number {
  return priced.threeSection?.bloodPact ?? 0
}

// ============================================================================
//  数值
// ============================================================================

/**
 * 把术式账按**技能**分组，给编辑器和校验器用。
 *
 * 顺序跟着 `skillIds` 走（不是跟着 entries 出现的顺序），
 * 因为编辑器里技能段是有序的，账必须和它们一一对齐。
 *
 * ⚠ 找不到的 id 也会出现一条 0 点的记录 —— **这是故意的**：
 *   编辑器要能显示"这一段是空的/引用坏了"，直接跳过的话那一段会凭空消失。
 */
export function groupBySkill(
  entries: readonly PriceEntry[],
  skillIds: readonly string[],
): { skillId: string; points: number; entries: PriceEntry[] }[] {
  return skillIds.map((skillId) => {
    const mine = entries.filter(e => e.skillId === skillId)
    return {
      skillId,
      points: Math.round(mine.reduce((s, e) => s + e.points, 0) * 100) / 100,
      entries: mine,
    }
  })
}

/**
 * 一个 ValueSpec 的"上限值"。
 *
 * 动态参数（`ref: 'charge'` 那种）算不出确定值，取曲线的**最大输出** ——
 * 那是它的天花板，按天花板定价才不会让"蓄满 150 伤害"白拿。
 */
export function peakValue(v: ValueSpec | undefined): number {
  if (v === undefined) return 0
  if (typeof v.const === 'number') return v.const
  if (Array.isArray(v.curve) && v.curve.length > 0) {
    let peak = 0
    for (const pt of v.curve) {
      if (Array.isArray(pt) && typeof pt[1] === 'number' && Math.abs(pt[1]) > Math.abs(peak)) {
        peak = pt[1]
      }
    }
    return peak
  }
  return 0
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * **机器精度**（⚠ 它**不是"产品容差"**）。
 *
 * 它只有一个职责：**挡住浮点噪声**。
 *   · 一个"真的为 0"的贡献有时会算成 `1.1e-17` —— 那是噪声不是账。
 *     没有这条线的话，"逐条取整"会把噪声钳成 **±1 点**，凭空造出一笔
 *     谁也没做过的交易（和以前"按下标认规则"是同一类病：账是错的但不报错）。
 *   · 一个**真的是整数**的值有时会算成 `0.9999999999999999` ——
 *     没有这条线的话，向下取整会让它掉一格，于是"合计完美的术式"被判成负。
 *
 * ⚠⚠ **它绝不是那个被删掉的"容差 2 点"**（2026-09-30 日志 57）。
 *   产品意义上的容差已经**不存在**了：**合计 ≥ 0 就能用，合计 < 0 要付血契** ——
 *   没有缓冲区、没有"差 2 点也算平"。这条线是 `1e-9`，比任何一笔真账
 *   小七、八个数量级：它挡的是浮点，不是玩家的设计。
 */
export const POINT_EPS = 1e-9

/**
 * 把一串**小数**贡献变成一串**整数**贡献 ——「**逐条取整 + 最大余数法**」。
 *
 * ## ⚠ 为什么不能各取各的
 *
 * 每一笔单独 `Math.round` 的话，**各条之和就和合计对不上**：
 * 三个 `0.5` 会各自变成 1（和 = 3），而合计是 `round(1.5)` = 2。
 * 那种账最烦人 —— 玩家逐条加一遍，加出来的数和合计**不是一个数**，
 * 而两边都不报错（正是本项目列为最危险的那类**静默不一致**）。
 *
 * ## 这套算法怎么走
 *
 * 1. **先钳"至少 1 点"**：非零的那几条抬（或压）到 `±1` 起步。
 *    详见下面"每个非零条目至少 1 点"。
 * 2. **每条取地板**（`Math.floor`，向 −∞）—— 正负一视同仁：
 *    差的那一部分（余数）**永远落在 `[0, 1)`**。这是取 `floor` 而不是 `trunc`
 *    的全部理由：用 `trunc` 的话负条目的余数是**负的**，
 *    于是"补格子"变成"扣格子"，正负条目会互相抢那几格（用户点名要问的那一条）。
 * 3. **要补几格由合计定**：`delta = round(Σ 钳过的值) − Σ地板`。
 *    ⚠ 取整的是**合计**，所以"**各条之和 = 合计**"是**构造出来的**，不是碰巧。
 * 4. **补格子的顺序按余数从大到小**（这才是"最大余数法"）——
 *    余数最大的那几条拿走那一格，误差被摊得最平。
 *    ⚠ 余数相同时按**下标**（稳定）：同一个技能每次算出来必须逐位相同，
 *      否则"什么都没改、账却变了"。
 *
 * ⚠ `delta` **一定 ≥ 0 且 ≤ 余数 > 0 的条目数**（因为 `Σ余数 < 条数`），
 *   所以地板上的数**只会被抬高、永远不会被压低** ——
 *   这就是"钳过 ±1 的条目不会再掉回 0"的证明。
 *
 * ## ⚠ 每个非零条目至少 1 点（用户 2026-09-30 的规格）
 *
 * > 不许出现"0.12 点"那种"账面上几乎免费"的条目
 *
 * 所以**取地板之前**先把非零的那几条钳到 `±1` 起步：
 *
 * ```
 * 0.12 → 1        −0.85 → −1        0（真的是 0）→ 0（不钳）
 * ```
 *
 * ⚠⚠ **钳过之后"合计"就是这些钳过的数之和。** 这是有意的：
 *   账的定义是"**各条之和**"，而"每条都看得见"是用户定的一条**硬规矩**；
 *   两者只在"某一条的原始值小于 1 点"（0.12 那类）时才会差 ≤ 1 点。
 *   ⚠ 这是**判断**，不是规格里写死的 —— 列在日志 57 的"待裁定项"里。
 *
 * ⚠ 判"是不是 0"用 `POINT_EPS`：**噪声不会被钳成 ±1 点**（见那里）。
 * ⚠ 数学只用 `floor` / `round` / `abs` / `min` / `max`（纯净性纪律禁 `pow` 之类）。
 */
export function integerPointsOf(raws: readonly number[]): number[] {
  const clamped = raws.map(v => {
    if (Math.abs(v) < POINT_EPS) return 0
    return v > 0 ? Math.max(v, 1) : Math.min(v, -1)
  })
  const floors = clamped.map(v => Math.floor(v))
  const remainders = clamped.map((v, i) => v - (floors[i] ?? 0))
  const target = Math.round(clamped.reduce((s, v) => s + v, 0))
  let delta = target - floors.reduce((s, v) => s + v, 0)
  const order = clamped
    .map((_, i) => i)
    .sort((a, b) => ((remainders[b] ?? 0) - (remainders[a] ?? 0)) || (a - b))
  const out = floors.slice()
  for (const i of order) {
    if (delta <= 0) break
    // ⚠ 0 那一格是"这一条什么都不是"，不给它补钱（补了就凭空多一笔账）
    if ((out[i] ?? 0) === 0) continue
    out[i] = (out[i] ?? 0) + 1
    delta -= 1
  }
  return out
}

/** 把一份账的每一条都过一遍 {@link integerPointsOf}（账的入口统一走这里） */
function integerizeEntries(entries: readonly PriceEntry[]): PriceEntry[] {
  if (entries.length === 0) return [...entries]
  const pts = integerPointsOf(entries.map(e => e.points))
  return entries.map((e, i) => {
    const p = pts[i] ?? 0
    return e.points === p ? e : { ...e, points: p }
  })
}

// ============================================================================
//  定价
// ============================================================================

/** 一个属性载荷值多少点。只认得出"扣能量 / 扣生命 / 重置冷却"这几种 */
function priceAttribute(a: Action, R: Rates): number {
  const p = a.payload
  if (p.kind !== 'attribute') return 0

  // 重置冷却：露娜的大招刷新那种，很值钱（收益 → 消耗额度 → 负）
  if (p.op === 'reset') return -R.cooldownReset

  // 值是负的（扣 15 能量）→ 点数反而是正的（代价提供额度）✓
  const amount = peakValue(p.value)
  if (p.path.endsWith('energy.current')) return -amount / R.energyPerPoint
  if (p.path.endsWith('hp.current')) return -amount / R.hpPerPoint
  // 上限、速率、移速这些改法太杂，先不计价（会在明细里标出来）
  return 0
}

/**
 * 一个属性修饰值多少"强度"，**正数 = 对持有者有利**。
 *
 * ⚠ 这里必须带符号，而且要看**这个属性越高越好还是越低越好**。
 *   第一版用了 `Math.abs(v - 1)`，于是"给自己 -20% 移速"这种代价
 *   被算成了**收益**（点数反而变小）—— 玩家加一条代价结果点数变负，
 *   那"牺牲 X 换 Y"整个循环就是反的。实测踩到的。
 */
function signedModifierStrength(m: AttributeMod): number {
  const v = peakValue(m.value)
  // 改了多少：×1.15 → +0.15（变强），×0.6 → -0.4（变弱）
  const delta = m.op === 'mul' ? (v - 1) : v / 10

  // 这个属性是"越高越好"还是"越低越好"
  const higherIsBetter = !(
    m.path.includes('damageTaken') ||
    m.path.includes('cooldown') ||
    m.path.includes('energyCost')
  )

  return higherIsBetter ? delta : -delta
}

/**
 * 一个状态的"强度"。**正数 = 对持有者有利**，负数 = 对持有者有害。
 *
 * 属性修饰按"变了多少比例"，禁用能力按项数，硬控再额外算一笔 ——
 * 这三样本来不可比，硬凑一个数出来是为了能自动排序。
 * ⚠ 强弱是**持有者视角**，至于这对施法者是赚是亏，由 priceStatus 定。
 */
function statusStrength(s: StatusDef, R: Rates): number {
  let strength = 0

  for (const m of s.modifiers ?? []) {
    strength += signedModifierStrength(m)
  }

  // 禁用能力对持有者一定是坏事
  strength -= (s.disables?.length ?? 0) * R.disableStrength
  // 硬控比"不能攻击"这种软控更值钱
  if (s.tags.includes('hardCC')) strength -= R.controlPerSecondPerPoint

  /*
   * 免疫一类标签（霸体）**对持有者有利**，正号。
   *
   * ⚠ 这一条以前完全不存在。少了它，"免疫一切硬控"在账上是零成本的，
   *   而技能的代价照常扣 —— 于是这一类技能永远"还剩一大截"，
   *   看起来像是数值没调好，其实是计价漏了一整项。
   *
   * 免疫按**标签**匹配，所以它挡的是"以后所有新加的硬控" ——
   * 这个"面向未来"的性质正是它该值钱的地方。
   */
  strength += (s.immuneTags?.length ?? 0) * R.immuneTagStrength

  // 强度封顶：不封的话一个 0.01 倍移速能把点数刷爆
  return Math.max(-6, Math.min(3, strength))
}

/**
 * 一个状态值多少点。**从施法者的角度算账。**
 *
 *   挂在敌人身上 + 对持有者有害 = 施法者赚了 → 收益 → 消耗额度（负）
 *   挂在自己身上 + 对持有者有害 = 施法者吃亏 → 代价 → 提供额度（正）
 *
 * 少了 `toSelf` 这个参数，**自我减益会被定价成收益** ——
 * 那么"给自己挂个虚弱换 20 点伤害"就变成了白送。
 */
function priceStatus(s: StatusDef, ctx: PriceContext, toSelf: boolean): number {
  const R = ctx.rates
  // 永久（-1）按 10 秒估
  const duration = s.duration < 0 ? 10 : s.duration

  // 持有者受益为正；施法者视角要翻一次符号
  const casterValue = statusStrength(s, R) * (toSelf ? 1 : -1)
  let total = -casterValue * duration * R.statusPerStrengthSecond

  total += priceHooks(s.hooks, ctx)
  total += priceDenial(s.hooks, duration, R, toSelf)

  /*
   * **阵营覆盖**（魅惑）。
   *
   * ⚠ 方向：把**敌人**变成自己人，对施法者是收益 → 消耗额度（负）。
   *   把**自己**变成敌人那边（精神被控）是代价 → 提供额度（正）。
   *   和别的"打自己还是打对面"一样，`toSelf` 就是那个开关。
   *
   * 按**秒**算：魅惑 3 秒和 30 秒完全不是一回事 —— 它是个持续效果，
   * 不是一次性的开关。
   *
   * ⚠ 在它存在之前 `faction` 是不参与定价的，而"把敌人变成队友"
   *   是这个引擎里最强的一类效果（对方少一个输出、你多一个）——
   *   不定价的话，魅惑就是白送。
   */
  if (s.faction !== undefined) {
    total -= R.factionOverridePerSecond * duration * (toSelf ? -1 : 1)
  }

  return total
}

/**
 * "改写一次命中"的钩子值多少点（`pipeline.reverse`）。
 *
 * ⚠ 这一项也是**加内容的时候才补上的**，和 `immuneTags` 同一个病：
 *   一个把整次命中掉头的效果，账上**值 0 点**。
 *
 *   表现：「亡灵诅咒」（治疗反转成伤害）算出来是 +3.66 —— 全是阶段的代价，
 *   效果一分没算。当时的第一反应是"把能量和冷却调低"，但那是错的：
 *   一个 5 秒的诅咒总得付得起点什么，问题在于它根本没进账。
 *
 * ⚠ 只认 `reverse`，**不认 `cancelled`**。
 *   `cancelled`（名刀司命的拦截）同样没被定价，但名刀靠它那条永久负重
 *   正好配平；现在给它补一项会把已经调好的名刀推歪。
 *   这是个已知的欠账，不是"cancelled 不值钱"—— 见日志。
 */
function priceDenial(
  hooks: PipelineHook[] | undefined,
  duration: number,
  R: Rates,
  toSelf: boolean,
): number {
  let total = 0

  for (const h of hooks ?? []) {
    for (const a of h.then ?? []) {
      const p = a.payload
      if (p === undefined || p.kind !== 'attribute') continue
      if (p.path !== 'pipeline.reverse') continue

      // 对持有者有害（治疗反过来伤他）→ 挂在敌人身上就是施法者的收益
      const harmful = peakValue(p.value) !== 0
      if (!harmful) continue

      total -= R.pipelineReversePerSecond * duration * (toSelf ? -1 : 1)
    }
  }

  return total
}

/**
 * 定价时的上下文。
 *
 * `statuses` 是**状态库**（`content/statuses/`）。
 *
 * ⚠ 少了它，按 id 引用库里的状态会被定价成 **0 点** ——
 *   一个"挂上一个 150 点护盾"的动作在账上免费。
 *   这和位移以前走 default 返回 0 是同一个病：
 *   **效果没进账，代价照常扣**，看起来像数值没调好。
 *
 * 不传也能跑（内联状态照样定价），只是引用库状态的那部分算不出来。
 */
export interface PriceContext {
  rates: Rates
  statuses?: ReadonlyMap<string, StatusDef> | undefined
  /**
   * 实体预设（`content/entities/`）。
   *
   * ⚠ 同理：不传的话，召唤**算不出价钱**（找不到预设就只知道有个单位），
   *   一具 60 血的骷髅会显示成 2 点而不是 8 点。
   */
  entities?: ReadonlyMap<string, EntityDef> | undefined
}

/** 一个钩子链值多少点 */
function priceHooks(hooks: PipelineHook[] | undefined, ctx: PriceContext): number {
  const R = ctx.rates
  let total = 0
  for (const h of hooks ?? []) {
    // 吸收型钩子：能挡伤害是收益 → 消耗额度（负）
    if (h.absorb !== undefined) {
      total -= h.absorb.perStack / R.damagePerPoint
    }
    // onTick 的钩子要按频率算 —— 每 0.5 秒烧 6 点和每秒烧 6 点不是一回事
    const perSecond = h.when === 'onTick' ? tickRate(h.every) : 1
    for (const a of h.then ?? []) total += actionPoints(a, ctx) * perSecond
  }
  return total
}

/**
 * onTick 的频率倍数。
 *
 * `every` 是"几秒触发一次"，所以 1/every 就是每秒几次。
 * 上限卡在 4：`every: 0.01` 这种写法在 60Hz 下就是每帧一次，
 * 不封顶的话一条持续伤害规则能凭空值上百点。
 */
function tickRate(every: number | undefined): number {
  const e = every ?? 1
  if (!(e > 0)) return 1
  return Math.min(4, 1 / e)
}

/** 一个动作值多少点。**负 = 消耗额度（效果），正 = 提供额度（代价）** */
export function priceAction(
  a: Action,
  R: Rates,
  statuses?: ReadonlyMap<string, StatusDef>,
  entities?: ReadonlyMap<string, EntityDef>,
): number {
  return actionPoints(a, { rates: R, statuses, entities })
}

/**
 * 各载体类型的**标准射程**。
 *
 * ⚠ 玩家 2026-09-21 定的形状：
 *   > 不同的技能有不同的标准值（近战技能近，远程技能远），
 *   > 多了则计价、少了则补贴点数。这样近战技能想打得远就要付出代价。
 *
 * 标准值取的是**出厂内容里这类载体的典型值**（近战扇形 2.5 米、
 * 光束 8 米、飞弹 18 米…）。这样做有两个好处：
 *   1. 出厂技能自然落在 0 附近，不会因为加了这个计价项就全体失衡
 *   2. "标准"有据可查 —— 它不是一个拍出来的数，而是"这类东西通常多远"
 *
 * ⚠ **不在表里的载体不参与射程计价**：
 *   - `self` / `spawn` 没有射程可言
 *   - `area` / `aura` 的 `radius` 是**范围大小**，不是射程（打得多远）。
 *     那是另一条交易轴，混进来会让"火墙的圈该多大"和"火墙能放多远"
 *     挤在同一个价上，两边都说不清。**这一条还没定，是个欠账。**
 *   - `projectile` 的飞行距离是 `速度 × 存在时间` 算出来的，不是玩家直接拖的一个数。
 *     它该不该占同一条轴还没定 —— 玩家选的范围是
 *     "扇形半径 / 光束长度 / 突刺长度"这三个，所以先只做这三个。
 */
const REACH_BASELINE: Partial<Record<string, number>> = {
  meleeArc: 2.5,
  capsule: 4,
  beam: 8,
}

/**
 * 各载体类型的**标准范围**（`area` / `aura` 的半径）。
 *
 * ⚠ 玩家 2026-09-21 明确要求"范围"也要单独计价：
 *   它是**另一条交易轴** —— 射程是"打得多远"，范围是"打得有多广"。
 *   混在一条轴上，火墙那个圈该多大和火墙能放多远就分不开了。
 *
 * 标准值同样取出厂内容的典型值（`node .scratch/delivery-values.mjs` 能打出来）：
 *   area  2.5 / 2.5 / 6 / 12 / 12  → 6
 *   aura  4（目前只有圣光术一个）
 *
 * 参照系（`web/src/leaves.ts` 的 `areaRadius` 表里定过）：
 *   2.5 = 贴身一圈、6 = 一大步、12 = 大半个场地、18 = 整个场地。
 *   所以 2.5 会拿到**补贴**、12 要**付钱** —— 这正是该有的取舍。
 *
 * ⚠ 两种载体用**同一个汇率**（`areaRadiusPerMeter`），但各自有自己的标准值。
 */
const AREA_BASELINE: Partial<Record<string, number>> = {
  area: 6,
  aura: 4,
}

/**
 * 载体几何里写死的数字。写了一整条 `ref` 的话返回 undefined ——
 * **算不出来**（见下面 `reachPoints` 的注释）。
 */
function fixedNumber(v: number | ValueSpec | undefined): number | undefined {
  return typeof v === 'number' ? v : undefined
}

/**
 * 这个载体**能打到多远**（米）。
 *
 * 两种载体量的东西不一样，所以要分开取：
 *   扇形 —— 半径
 *   光束 / 突刺 —— 长度
 *
 * ⚠ 几何写成动态参数（`{ ref: 'weapon.reach' }`）时返回 undefined：
 *   那不是"没有射程"，是**这一刻算不出来** —— 它取决于装的是哪把武器，
 *   而定价器手里只有技能模板，没有武器。见 `reachPoints`。
 */
function reachOf(d: DeliverySpec): number | undefined {
  switch (d.kind) {
    case 'meleeArc': return fixedNumber(d.radius)
    case 'beam':
    case 'capsule': return fixedNumber(d.length)
    default: return undefined
  }
}

/**
 * 载体的**射程**值多少点。
 *
 * **长了 = 收益 = 负（消耗额度）；短了 = 补贴 = 正（提供额度）。**
 * 符号方向必须和整本账一致 —— 这本账的方向错过四次，每次都没有东西报警。
 *
 * ⚠ 几何是动态参数时算成 **0 点**（当作"标准射程"），而不是猜一个数。
 *   武器技能模板就是这样：它的射程由武器代入，
 *   定价器**看不见那把武器** —— 猜出来的数字比没有数字更坏
 *   （玩家会照着它去调一个根本不存在的平衡）。
 *   ⚠ 这条和"武器术式不算账"（`techniquePaysPoints`，见 `school.ts`）是配套的：
 *     真正的武器术式整本账都不算，这里是玩家自己写的技能引用武器参数时的兜底。
 */
function reachPoints(d: DeliverySpec | undefined, R: Rates): number {
  if (d === undefined) return 0
  const baseline = REACH_BASELINE[d.kind]
  if (baseline === undefined) return 0
  const reach = reachOf(d)
  if (reach === undefined) return 0
  return -(reach - baseline) * R.rangePerMeter
}

/**
 * 载体的**范围**值多少点（`area` / `aura` 的半径）。
 *
 * 和射程同向：圈子越大越是收益，越要付钱；贴身的小圈拿补贴。
 * ⚠ 动态参数的兜底和 `reachPoints` 同一句。
 */
function areaPoints(d: DeliverySpec | undefined, R: Rates): number {
  if (d === undefined) return 0
  const baseline = AREA_BASELINE[d.kind]
  if (baseline === undefined) return 0
  const radius = fixedNumber(d.radius)
  if (radius === undefined) return 0
  return -(radius - baseline) * R.areaRadiusPerMeter
}

/** 内部实现。公开的 priceAction 只是包一层，好让递归调用共用同一份上下文 */
function actionPoints(a: Action, ctx: PriceContext): number {
  return payloadPoints(a, ctx)
    + reachPoints(a.delivery, ctx.rates)
    + areaPoints(a.delivery, ctx.rates)
}

function payloadPoints(a: Action, ctx: PriceContext): number {
  const R = ctx.rates
  const p = a.payload

  switch (p.kind) {
    case 'damage':
      return -peakValue(p.amount) / R.damagePerPoint
    case 'heal':
      return -peakValue(p.amount) / R.healPerPoint
    case 'attribute':
      return priceAttribute(a, R)
    case 'status': {
      /*
       * ⚠ `remove` 定价 **0**，只有 `apply` 进账。
       *
       *   第一版把两种 verb 一视同仁，结果「裂魂」里那条
       *   「命中时驱散护盾」被算成"挂了一个 150 点的盾"——
       *   裂魂的点数从 −5.89 掉到 −16.41，凭空多出 10 点开销。
       *   驱散**不是**施加，符号和意义都不是一回事。
       *
       * 为什么干脆算 0：驱散是一次**条件性反制**，它的价值完全取决于
       *   对手身上有没有那个状态。给一个"对手没盾就毫无作用"的动作
       *   标一个固定价，只会让所有带驱散的技能一起失衡。
       *   这和"条件不参与定价"（见 describe.ts 里那条注释）是同一个立场。
       *
       * 这是欠账：真要给它定价，得先有一套"反制类效果"的模型。
       */
      if (p.verb === 'remove') return 0

      /*
       * ⚠ 两种引用方式都要能查到：
       *     inline   —— 状态写在这条规则里（自带定义）
       *     statusId —— 引用**状态库**里的定义
       *
       *   只认 inline 的话，`statusId: "status.shield"` 会被算成 0 点 ——
       *   "挂一个 150 点的盾"在账上免费。这就是这一节要修的东西。
       */
      const s = p.inline
        ?? (p.statusId === undefined ? undefined : ctx.statuses?.get(p.statusId))
      return s === undefined ? 0 : priceStatus(s, ctx, a.target === 'self')
    }
    /*
     * 位移。
     *
     * ⚠ 在这一项存在之前，位移是**免费**的 —— 定价器对不认识的载荷返回 0
     *   （那句注释写的是"还没实现，也就无从定价"，诚实但危险）：
     *   一个纯击退技能会算出"还剩一大截点"，看起来像数值没调好，
     *   实际是它的效果压根没进账。
     *
     * 只算**距离**，不算"推了谁"：
     *   把敌人推开 `d` 米是收益 → 消耗额度（负）
     *   自己冲出去 `d` 米也是收益，但打折 —— 因为**那段路本来就能走过去**，
     *   冲刺买到的是"这一瞬间就到"，不是"能到那儿"。
     */
    case 'displacement': {
      const d = Math.abs(peakValue(p.distance))
      const perMeter = R.displacementPerMeter
      const selfMove = p.mode === 'dash' || p.mode === 'teleport'
      const base = selfMove ? perMeter * R.selfMoveShare : perMeter
      // 击飞额外算一点：它让目标在空中待着，是实打实的压制
      const air = p.airborne === true ? d * perMeter * R.airborneShare : 0
      return -(d * base + air)
    }
    /*
     * 感知。
     *
     * ⚠ 隐形很强：看不见就**锁定不了**（findHostile 会跳过），
     *   所以按"强度 × 秒"计价，复用状态那张表 ——
     *   隐形本质就是一个强度 = (1 − 可见性) 的状态。
     *   完全隐形 5 秒 = 强度 1 × 5 秒，和"挂一个 5 秒的强增益"同一个量级。
     *
     * 三种模式的账不一样：
     *   setVisibility  隐形：对持有者有利，所以挂给别人是**代价**（正）
     *   reveal         揪出隐身：对敌人用是收益（负），对自己用是代价（正）
     *   mark           只打标签，数值上什么都不做 → 0（它的价值由消费它的规则决定）
     */
    case 'perception': {
      const toSelf = a.target === 'self'
      const duration = p.duration ?? 5

      if (p.mode === 'setVisibility') {
        const v = Math.max(0, Math.min(1, peakValue(p.value ?? { const: 0 })))
        const strength = 1 - v
        const casterValue = strength * (toSelf ? 1 : -1)
        return -casterValue * duration * R.statusPerStrengthSecond
      }

      if (p.mode === 'reveal') {
        // 对敌人 = 收益；对自己 = 代价（花力气把自己显形？没人会这么写，但符号要对）
        return toSelf ? R.revealStrength : -R.revealStrength
      }

      return 0
    }

    /*
     * 召唤。
     *
     * ⚠ 在这一项存在之前它走 default 返回 0 —— **免费**。
     *   和位移以前是同一个病：效果没进账、代价照常扣，
     *   表现是"还剩一大截点"，看起来像数值没调好。
     *   这一轮实现 spawn 的时候**同时**把定价补上了 —— 不用再等一次教训。
     *
     * 怎么估值：一具召唤物的**血量池**就是它替你吃掉的伤害，
     * 所以按 `hp / hpPerPoint` 算 —— 和"一个同血量的护盾"同一个价钱。
     * 这个锚是现成的（护盾是 150 点 ≈ 10 点额度），不用另发明一套。
     *
     * 再加一笔 `summonBase` 表示"它在场上还会打人"。
     * ⚠ 那是个**粗估**：真正该算的是它的 DPS × 预期存活时间，
     *   而那要读它带的术式、模拟一遍才有意义。现在用固定值代替，
     *   偏保守（宁可算便宜也不要把召唤算成免费）。
     */
    case 'spawn': {
      const count = Math.max(1, Math.floor(p.count ?? 1))
      const def = ctx.entities?.get(p.entityId)

      /*
       * ---- 屏障：**不按召唤物计价** ----
       *
       * ⚠ 这一条不是特例，是**纠正一处重复计费**：
       *
       *   召唤物的血量池之所以值钱，是因为那具骷髅**会打人**，
       *   血量是"让它继续打下去"的东西 —— 所以 `hp / hpPerPoint` 是在买
       *   "它替我吃掉的伤害 + 它多活一会儿多打几下"。
       *
       *   而屏障**不打人**。它的血量只是"挡子弹"这件事的**弹药**，
       *   而"挡子弹"已经由 `barrierPoints`（正面宽度 × 挡住什么）买过一次了。
       *   再按血量池收一遍，就是同一个效果收两次钱 ——
       *   实测的后果很具体：一堵 120 血的墙在账上是 −15 点，
       *   想配平得写 80 秒冷却，等于这堵墙在内容里根本立不住。
       *
       *   所以屏障只算 `barrierPoints`（正面宽度 × 挡住什么）。
       *   ⚠ `summonBase` **也不收**：它自己的注释写着"它在场上还会打人"——
       *     而屏障不打人，它唯一的用处就是挡。收它就是收一份不存在的功能。
       *   ⚠ `barrierPoints` 是**账上的符号**（负 = 收益），直接返回，别再套负号 ——
       *     套上去会把"挡住了"算成"更便宜"（方向反了，实测过一次）。
       */
      if (def !== undefined && def.kind === 'obstacle') {
        return count * barrierPoints(def, R)
      }

      // 查不到预设时按最小代价估 —— 加载期检查会先把这种内容拦下来
      const hp = def === undefined ? 0 : (def.attributes?.['char.hp.max'] ?? 0)

      const perBody = hp / R.hpPerPoint + R.summonBase
      // 让目标"直到主人死"比限时更值一点：它有机会活满全场
      const lasting = p.lifetime === 'untilCasterDies' || p.lifetime === 'permanent' ? 1.15 : 1
      return -(count * perBody * lasting)
    }
  }
}

/**
 * 屏障的**通行策略**值多少点 —— 玩家 2026-09-21 点名要的那条轴。
 *
 * 玩家原话：
 *   > 玩家可以决定自己的子弹能否穿过墙（如果有反弹型子弹，这条就有用了）、
 *   > 敌人的子弹能否穿墙（**用于获取点数**）、以及敌人和友方能否穿墙。
 *
 * ## 模型（简单到能一眼看懂，也就能一眼改）
 *
 * 一堵墙的价值 = **它挡住了多少东西** × **它有多长**。
 * 四个开关决定"挡住了多少"：
 *
 * | 开关 | 挡住（`false`） | 放行（`true`，默认看下面） |
 * | --- | --- | --- |
 * | `enemyProjectiles` | **收益**（这就是墙的本职） | 让掉本职 → 那笔收益不记 |
 * | `enemyUnits` | **收益**（敌人过不来） | 不记 |
 * | `ownUnits` | 半分收益（挡住追兵，但也挡住队友） | 不记 |
 * | `ownProjectiles` | **代价**（自己的子弹也被挡了） | 不记 |
 *
 * ⚠ 符号方向和整本账一致：**挡住 = 收益 = 负**，**挡自己 = 代价 = 正**。
 *   方向写反过一次的教训在 `pricePhase` 上面那段注释里。
 *
 * ⚠ **单价的量级是待定的**（现在借 `areaRadiusPerMeter` 这条轴）：
 *   它和"范围"同量纲（都是"覆盖多大一块地方"），所以先借它。
 *   玩过之后如果觉得"墙太便宜/太贵"，动的是 `content/balance.json` 里那条汇率，
 *   不是这里的公式。
 */
export function barrierPoints(def: EntityDef, R: Rates): number {
  const shape = def.shape
  /** 正面宽度：线段是长度，圆是直径 */
  const frontage = shape !== undefined && shape.kind === 'segment'
    ? shape.length
    : (def.radius ?? 0.4) * 2

  const b = {
    ownProjectiles: true, enemyProjectiles: false,
    ownUnits: true, enemyUnits: true,
    ...(def.block ?? {}),
  }

  let blocked = 0
  if (!b.enemyProjectiles) blocked += 1
  if (!b.enemyUnits) blocked += 1
  if (!b.ownUnits) blocked += 0.5

  // 挡住自己的子弹是**代价**（正），所以它从收益里减掉
  const selfBlocked = b.ownProjectiles ? 0 : 1

  return -(frontage * blocked - frontage * selfBlocked) * R.areaRadiusPerMeter
}

/**
 * 一个阶段值多少点。
 *
 * 时间、能量、冷却、生命都是**代价** → 提供额度（正）。
 * 唯一反过来的是"打断等级" —— 越扛得住，越是收益（消耗额度）。
 *
 * ⚠ **这一条是"1× 档"的价，也就是相对账的中性点所在**：
 *   `skillLedger` 拿它算「现在 − 出厂」，所以**出厂时长自己减自己是 0 点**，
 *   一个例外都没有。它算的**不是**「你偏离了多少」，而是「这个绝对值值多少」——
 *   绝对式本来就是对的，这一点玩家 2026-09-21 亲自纠正过一次
 *   （`docs/standard-values-draft.md` §十四：起草时以为要把 `pricePhase` 改成相对式，
 *    **那是错案** —— 相减之后各自为 0，不需要动这里）。
 *
 * ⚠ **0 秒阶段在这一条里是 0 点，但它在账上不是免费的** ——
 *   那一笔由**档位表**单独给（见下面的「查表定价」一节，
 *   `content/balance.json` 的 `tierTables.phaseDurationPoints`）。
 *   **两者分工写清楚**：
 *     本函数 = 「这一段占用多少时间 × 汇率」—— **绝对账**用（`priceSkill`），
 *              0 秒就是 0 点 ✓（老实）
 *     档位表 = 「你把这一段取消 / 拖到 3× / 9×」在**相对账**里值多少点 ✓
 *   ⚠ 2026-09-30（日志 59）之前，0 档那一笔是 `−K × D × 汇率` 算出来的
 *     （K 住在 `rates` 里）；现在它是**人填在表里的一个整数**，K 已经删掉。
 */
export function pricePhase(p: Phase, R: Rates): number {
  let total = 0

  /*
   * ⚠ ---- **「等待 X 秒」插进来的空档在这里是 0 点**（2026-09-30 日志 52）----
   *
   *   理由不是"它免费"，而是**它已经在别处按自己的尺子收过了**：
   *   等待的价 = `秒数 × modifierRates.waitSecondPerPoint`（见 `modifierPointsOf`）。
   *
   *   ⚠ 为什么不能让这一段也走下面那两行（那正是**同一个东西收两次钱**）：
   *     · `duration × phaseSecondPerPoint` —— 「技能自己的时间轴有多长」的价；
   *       而等待**不是技能的时间轴**，它是修饰零件买来的一段空档，
   *       玩家给它的规矩是"**按秒数算、汇率住在 balance.json 里**"。
   *       两把尺一起量，"1.5 秒的等待"会被收两次（而且两次的汇率各自可调，
   *       调一个看不到另一个，账面会自相矛盾）。
   *     · `uninterruptibleCredit` —— 「扛打断」的价。等待阶段**天然**就是
   *       `interrupt: 'none'`（玩家定的默认），那笔收益已经含在
   *       `waitSecondPerPoint` 的建议值里（见那个常数的注释）。
   *
   *   ⚠ **这一行对出厂账一个数都不改**：`wait` 只可能由编译期插进来
   *     （内容里的技能写不了它），而出厂内容一个等待副本都没有。
   *     `npm run calibrate` 逐行不变就是它的证据。
   */
  if (p.wait === true) return 0

  // 蓄力阶段（duration = -1）也是时间，玩家得按住键等
  if (p.duration < 0) total += R.chargePhasePerPoint
  else total += p.duration * R.phaseSecondPerPoint

  total += (p.cost?.energy ?? 0) / R.energyPerPoint
  total += (p.cost?.cooldown ?? 0) * R.cooldownSecondPerPoint
  total += (p.cost?.hp ?? 0) / R.hpPerPoint

  total -= uninterruptibleCredit(p, R)

  return total
}

// ============================================================================
//  查表定价：档位 → 整数点数（2026-09-30 日志 59）
// ============================================================================
//
//  ## 这是什么
//
//  「一条轴值多少点」有两种给法：
//
//    ① **汇率式**（老办法）：`值 × 每单位多少点` —— 线性，能表达任意取值，
//       但"取消这一段"（值 = 0）在它下面**免费**，而引擎会给好处。
//    ② **查表式**（这一节）：**档位很少**，每个档位**挨个填一个整数**。
//       用户原话：
//       > 不必有汇率这种线性关系，档位很少，挨个填值就行
//
//  ⚠ **表住在内容侧**（`content/balance.json` 的 `tierTables`），
//    **一条轴一张表**（键 = 表名）。机制在这里，数据在那里 ——
//    加第二条轴的档位表**一行代码都不用改**（给 `tierTables` 添一个键就行）。
//
//  ⚠⚠ **为什么不能把表塞进 `rates`**：`tools/calibrate.ts` 把
//    `Object.keys(DEFAULT_RATES)` 当**拟合变量**，而且 `--write` 会把
//    每个键**写成拟合出来的小数** —— 表进去就会被标定器压成小数，而档位
//    必须是整数。所以它和 `modifierRates` 一样**单开一栏**。
//
//  ## 三个不变式（`tests/pricing.ts` 逐个钉着）
//
//    1. **中性档（1×）必须是 0 点** —— 它是"这个技能自己的出厂值"，
//       出厂值自己减自己 = 0（宗旨：出厂内容全是 0 点）。
//    2. **档位不能倒挂**：0 档（取消这一段）必须**比 9× 档更贵**。
//    3. **整数**：账上印的是整数（2026-09-30 日志 57）。

/** 表名：阶段时长那一张（`content/balance.json` 的 `tierTables` 下的键） */
export const TIER_TABLE_PHASE_DURATION = 'phaseDurationPoints'

/**
 * **中性档** = `1`，也就是"这个技能自己的出厂值"。
 *
 * ⚠ 它是**定义**，不是数据：`1×` 就是出厂本身，账上 0 点。
 *   表里这一行**必须存在而且必须是 0** —— 否则"出厂全 0"当场破
 *   （校验器 `checkBalance` 会把它报出来）。
 */
export const TIER_NEUTRAL = 1

/** 表里的一行：档位（倍数）→ 整数点数 */
export interface TierRow {
  tier: number
  points: number
}

/**
 * **按技能覆盖**那一栏的键名（`tierTables.<表名>.bySkill`）—— 2026-09-30 日志 63。
 *
 * ⚠ 它是个**保留键**（`readTierTable` 认它），**不是一个档位**：
 *   档位键一律是数字（`"0"` / `"1"` / `"3"` / `"9"`，`Number("bySkill")` 是 `NaN`），
 *   所以两者不会撞车。校验器指路的时候也用它拼路径。
 */
export const TIER_BY_SKILL_KEY = 'bySkill'

/** 一张**查表定价**的表。见上面那一节。 */
export interface TierTable {
  /** 表名 —— 出问题时用它指路（"改 `tierTables.xxx` 那个键"） */
  name: string
  /** 档位 → 整数点数，**按档位升序**。空的表 = 不存在 */
  rows: readonly TierRow[]
  /**
   * **按技能覆盖**（2026-09-30 日志 63）：技能 id → 只写**要改的那几档**。
   *
   * ## 为什么要有它
   *
   * 用户 2026-09-30 给四档定值的时候原话是
   * > **先按你的默认值来，以后我会改**
   * 而且他点名要的是"**可以按技能改**"。所有技能共用一张表的话，
   * "某个技能的 9× 该更贵一点"那一天就没有地方写了。
   *
   * ## ⚠ 覆盖是**加法式**的，不是"整张换掉"
   *
   * 覆盖栏里写一格就只换那一格，别的档位照旧走 `rows`（共享的四格默认）。
   * 整张换掉的话，玩家改一格会**静默地**把另外三档带回代码兜底值 ——
   * 而"我改了它没生效"和"这一档本来就是这个价"在账面上长得一模一样。
   *
   * ## 谁对着哪个 id 查
   *
   * **基础技能 id**（= `lookupTable` 的分区键）：变体（`basedOn`）对着它的模板查，
   * 和账本身的口径逐字相同（见 `skillLedger` 那一段）。
   *
   * ⚠ 今天（日志 63）出厂内容是**空的**（`{}` = 一格没填）—— 这正是用户要的状态：
   *   "覆盖栏留空也行，但结构要在"。填法见 `content/balance.json` 的
   *   `tierTables.phaseDurationPoints.bySkill`（它旁边的 `_comment` 就写着格式）。
   */
  bySkill?: Readonly<Record<string, readonly TierRow[]>>
}

/** 表名 → 表。缺的表就是"这条轴还没做查表" */
export type TierTables = Readonly<Record<string, TierTable>>

/**
 * **建议值**（代码里那一份兜底）。
 *
 * ⚠⚠ 它**只是兜底**：真正的值在 `content/balance.json` 的 `tierTables` 里，
 *   `priceOptionsFor` 会用内容里那份盖掉它。**留着它的唯一理由**：
 *   `web/src/**`（编辑器 UI）当轮**冻结**，它自己手工拼 `PriceOptions`、
 *   不带表 —— 没有这份兜底，编辑器里那条点数条会**退回老的线性式**，
 *   于是"编辑器显示 +2、命令行按 +1 扣"（这个项目最恨的那类漂移）。
 *   ⇒ `tests/pricing.ts` 钉着"**这一份必须和 `content/balance.json` 里那份逐位相同**"。
 *
 * ⚠ 能动 `web/src/**` 的那一轮应该让编辑器走 `priceOptionsFor`，
 *   然后**把这一份删掉**（"所有价格都是数据"）。
 */
export const DEFAULT_TIER_TABLES: TierTables = {
  [TIER_TABLE_PHASE_DURATION]: {
    name: TIER_TABLE_PHASE_DURATION,
    rows: [
      { tier: 0, points: -6 },
      { tier: 1, points: 0 },
      { tier: 3, points: 2 },
      { tier: 9, points: 4 },
    ],
    /*
     * ⚠ **按技能覆盖那一栏在这里是空的**（2026-09-30 日志 63）—— 但**结构要在**：
     *   用户 2026-09-30 的规格是"一张共享的四格默认 + 允许按技能覆盖"，
     *   而且他会自己填（"先按你的默认值来，以后我会改"）。
     *   留 `{}` 而不是省掉这个键，是为了让"这一栏存在"这件事在代码兜底那一份里
     *   也看得见 —— `tests/pricing.ts` 钉着"兜底那一份和内容侧那一份逐位相同"。
     */
    bySkill: {},
  },
}

/**
 * 从 `content/balance.json` 的 `tierTables` 里读一张表。
 *
 * 形状（⚠ `_` 开头的键是**文案**，不是档位；和 `rates` / `modifierRates` 同一个惯例）：
 *
 * ```jsonc
 * "tierTables": {
 *   "phaseDurationPoints": {
 *     "0": -6, "_0": "为什么是 −6……",
 *     "1": 0,  "_1": "中性档，不许改",
 *     "3": 2,  "_3": "……",
 *     "9": 4,  "_9": "……",
 *     // ⚠ 2026-09-30 日志 63：**按技能覆盖**那一栏（可以留空，但结构要在）
 *     "bySkill": {
 *       "_comment": "技能 id → 只写要改的那几档，其余走上面共享的四格",
 *       "skill.magic-bolt": { "9": 6 }
 *     }
 *   }
 * }
 * ```
 *
 * ⚠ **认不出的行一律不算数**（非数字键、非整数、非有限值）—— 宁可少一行，
 *   也不要拿一个 `NaN` 去算账（`NaN` 会让整本账变成 `NaN`，而且**不报错**）。
 *   表本身坏掉由校验器 `checkBalance` 报（它在内容侧看一眼数据就说人话）。
 *
 * ⚠ `bySkill` 那一栏里**认不出**的东西同样不算数（同一个理由），
 *   而且**一格都没读出来**的技能 id 直接不出现在 `bySkill` 里 ——
 *   "有这个技能、但一格都没覆盖"和"没有这个技能"没有任何行为差别。
 */
export function readTierTable(raw: unknown, name: string): TierTable | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const rows = readTierRows(raw)
  if (rows.length === 0) return undefined
  const bySkill = readTierBySkill((raw as Record<string, unknown>)[TIER_BY_SKILL_KEY])
  return Object.keys(bySkill).length === 0 ? { name, rows } : { name, rows, bySkill }
}

/**
 * 一张表里"档位 → 整数点数"那几行。
 *
 * ⚠ 顶层共享那一段和 `bySkill` 里**每一段**都走这一个解析器 ——
 *   两处各写一遍的话，迟早有一处漏掉"认不出的行不算数"，
 *   而那个漏掉的地方会拿一个 `NaN` 或小数去算账（静默）。
 *   `bySkill` 这个键在这里被自然地跳过（`Number('bySkill')` 是 `NaN`）。
 */
function readTierRows(raw: unknown): TierRow[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
  const rows: TierRow[] = []
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k.startsWith('_')) continue
    const tier = Number(k)
    if (!Number.isFinite(tier) || tier < 0) continue
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    rows.push({ tier, points: v })
  }
  rows.sort((a, b) => a.tier - b.tier)
  return rows
}

/** 把 `bySkill` 那一栏读出来（技能 id → 覆盖行）。缺 / 坏 ⇒ 空对象（"一个字都没覆盖"） */
function readTierBySkill(raw: unknown): Record<string, readonly TierRow[]> {
  const out: Record<string, readonly TierRow[]> = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [skillId, over] of Object.entries(raw as Record<string, unknown>)) {
    if (skillId.startsWith('_')) continue
    const rows = readTierRows(over)
    if (rows.length > 0) out[skillId] = rows
  }
  return out
}

/** 把 `balance.tierTables` 整栏读出来（缺的表直接不存在，不报错） */
export function readTierTables(raw: unknown): TierTables {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, TierTable> = {}
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (name.startsWith('_')) continue
    const t = readTierTable(v, name)
    if (t !== undefined) out[name] = t
  }
  return out
}

/**
 * 一条轴的表：**内容侧优先，代码兜底**（兜底的理由见 `DEFAULT_TIER_TABLES`）。
 *
 * ⚠ 它永远不会返回 `undefined`（兜底那份一定有）—— 调用方不用写"表没了怎么办"，
 *   而"表没了"这件事由校验器（`checkBalance`）在内容那一侧报出来。
 */
export function tierTableOf(o: { tierTables?: TierTables }, name: string): TierTable {
  return o.tierTables?.[name] ?? DEFAULT_TIER_TABLES[name] ?? { name, rows: [] }
}

/** 表里这个档位值多少点；表里没有这个档位 → `undefined`（= **表外取值**） */
export function tierPointsOf(table: TierTable, tier: number): number | undefined {
  const row = table.rows.find(r => r.tier === tier)
  return row?.points
}

/**
 * 表里这个档位值多少点 —— **先看这个技能的覆盖，再看共享的四格默认**。
 *
 * ⚠ 这是**定价要用的那一个**（`tierPointsOf` 只看共享那一份，留给"只看默认值"的地方）。
 *   判断"这一档有没有价"的所有地方都必须走这一句：两处各写一遍的话，
 *   迟早有一处忘了看覆盖，症状是"给某个技能填了覆盖，账上不动"——
 *   和本项目头号病（改了数据没生效）同一张脸。
 *
 * ⚠ `skillId` 是**基础技能 id**（`lookupTable` 的分区键）；传 `undefined` =
 *   "没有技能上下文"（合成探针 / 还没进表的技能）⇒ 只走共享那一份。
 */
export function tierPointsForSkill(table: TierTable, tier: number, skillId?: string): number | undefined {
  const over = skillId === undefined ? undefined : table.bySkill?.[skillId]
  const row = over?.find(r => r.tier === tier)
  if (row !== undefined) return row.points
  return tierPointsOf(table, tier)
}

/**
 * **倍数档走表**：一段阶段的时长现在值多少点
 * —— `undefined` = "**不在这套倍数里** ⇒ 交给绝对秒数那条老路"（2026-09-30 日志 63）。
 *
 * ## 这一段要钉的口径（用户 2026-09-30 批的）
 *
 * 编辑器上那四个按钮（**无 / 1× / 3× / 9×**）是**倍数**，相对**这个技能自己的**
 * 出厂时长。所以"这一档值多少点"必须是**查表**查出来的（`档位 → 整数点数`），
 * 而不是"秒数 × 汇率"：
 *
 * ```
 * 现在 / 出厂 ∈ { 0, 1, 3, 9 }（表里那几档） ⇒ 价 = 表里那一格
 * 别的（1.7× 那种拖到格子外的值）           ⇒ undefined ⇒ 老路（绝对秒数格）
 * ```
 *
 * ## ⚠ 为什么"两套并存"而不是把老的删掉
 *
 * `lookupTable` 的 `phases.N.duration` 是**绝对秒数**的一条路（每个技能自己那几格），
 * 它是"绝对档滑块"那条路用的。这一片**只加不减**：
 *   · **倍数档走表**（本函数）—— 四档永远有价可查，改一个数（甚至改某一个技能的
 *     覆盖）四档的价一起变；
 *   · **绝对秒数继续走老的** —— 表外的取值照旧按 `lookupTable` 那一格收，
 *     一格都没有时照旧留 `⚠ 表外取值` 记录（不许静默当 0）。
 * 优先级写在 `lookupEntriesOf` 里：**先问本函数，问不出来才查绝对格**。
 *
 * ## 什么时候返回 `undefined`（= 不在轴上）
 *
 * | 出厂那一头 | 现在这一头 | 在轴上吗 | 为什么 |
 * | --- | --- | --- | --- |
 * | `> 0` 秒 | `>= 0` 秒 | ✓ | 正常：无 / 1× / 3× / 9× 四档 |
 * | `> 0` 秒 | `< 0`（蓄力哨兵） | ✗ | **换了一根轴**：蓄力是"按住键"的哨兵值，价是 `chargePhasePerPoint` 定额 |
 * | `<= 0`（出厂就是蓄力 / 没时长） | 任意 | ✗ | 出厂那一头没有一个"1×"可当基准 —— 档位无从谈起 |
 * | 表里**没有这一档**（玩家删了那一行） | —— | ✗ | 表指不出来 ⇒ 退回绝对格（**不静默当 0**） |
 *
 * ⚠ 判据 `onDurationTierAxis` 和 `phaseTierProblems` 用的是**同一个** ——
 *   分开写的话，"账上认得出这一档、校验器却说不在这档上"会同时成立。
 */
export function phaseDurationTierPriceOf(
  wasDuration: number,
  nowDuration: number,
  o: { tierTables?: TierTables },
  skillId?: string,
): { tier: number; points: number } | undefined {
  if (!onDurationTierAxis(wasDuration, nowDuration)) return undefined
  const table = tierTableOf(o, TIER_TABLE_PHASE_DURATION)
  const tier = tierOf(wasDuration, nowDuration, table)
  if (tier === undefined) return undefined
  const points = tierPointsForSkill(table, tier, skillId)
  if (points === undefined) return undefined
  return { tier, points }
}

/**
 * 把 `now / base` 认成哪一档。认不出（玩家拖到了格子外）就返回 `undefined`
 * —— 那是"**取值不在表里**"，校验器会报错（不许静默当 0 点）。
 *
 * ⚠ **档位集合来自表本身**（不是代码里写死的 `[0, 1, 3, 9]`）：
 *   往 `content/balance.json` 添一档（比如 27×）**不用改代码**。
 *
 * ⚠ 浮点必须容错：`0.3 / 0.1` 是 2.9999999999999996 —— 直接比 `=== 3` 会认不出 3× 档，
 *   而那正是编辑器里最常见的那一次拖动。同样地 27 秒 / 3 秒 = 9.000000000000002。
 */
export function tierOf(base: number, now: number, table: TierTable): number | undefined {
  if (!(base > 0)) return undefined
  const ratio = now / base
  for (const r of table.rows) {
    if (r.tier === 0) continue          // 0 档是"取消这一段"，由下面那一行单独认（ratio = 0）
    if (Math.abs(ratio - r.tier) <= 1e-6 * r.tier) return r.tier
  }
  if (now === 0 && table.rows.some(r => r.tier === 0)) return 0
  return undefined
}

// ============================================================================
//  全量点表：技能 × 变量 × 取值 → 一个整数点（2026-09-30 日志 60b）
// ============================================================================
//
//  ## 用户定的规格（原话）
//
//  > 一个技能的所有变量的取值对应点数的**和（即线性叠加）**就是最终的技能点数，
//  > 为正或 0 能用，为负消耗血契。**因此它必须是实际值。**
//
//  ⇒ 账不再由**公式**算，而是**查一格、再相加**：
//
//      某个技能 = Σ（它每个变量现在选中的取值 → 表里那一格）
//
//  ⚠ 出厂值那一格恒等于 0（60a 逐格实测：377 格全 0）⇒ **出厂技能合计恒 0**
//    （宗旨：默认值下配平为 0）。这一条不再靠"现在减出厂"实现，
//    而靠"表里出厂那一格是 0 + 逐格相加"。
//
//  ⚠⚠ 这条路上**没有**"非零条目至少 1 点"的地板，**也没有**"先加小数再取整"：
//    表里的数本来就是整数，相加还是整数。那两样东西（加上"价格是公式算的"）
//    正是"**两个变量一起改 ≠ 两项相加**"的根因 —— 用户点名要删的就是它们。
//
//  ## 表住在哪、长什么样
//
//  `content/balance.json` 的 `lookupTable` 一栏（**不是**一个新内容文件：
//  `validate` 数的就是内容文件个数，见 60a §1）：
//
//  ```jsonc
//  "lookupTable": {
//    "_这是什么": "…",                                              // `_` 开头是文案，不是分区
//    "skill.magic-bolt": {                                          // ← 分区 = **技能 id**
//      "phases.0.duration": { "1": 1, "-1": 3, "0.1": -1, "0.3": 0 }, // ← 变量 → 取值 → 整数点
//      "@冷却时机": { "命中": 0, "没有冷却": -4 }                    // ← 编辑器里没有字段路径的控件
//    }
//  }
//  ```
//
//  ## 变量怎么读（口径来自 60a §1.1 和表自己的 `_口径`，**不是**这里新定的）
//
//  | 变量键 | 这个技能"选了哪个取值" |
//  | --- | --- |
//  | 数值叶子（**字段路径**，和编辑器滑块的 `data-path` 逐字相同） | 那个路径上的数，写成十进制（`String(v)`） |
//  | `@冷却时机` | 扛着冷却那一段的**名字**；没有冷却 ⇒ `没有冷却` |
//  | `@打断等级.N` | 第 N 段的 `interrupt`（缺省 `damage`） |
//  | `@占用施法者.N` | 第 N 段的 `occupiesCaster`（`true` / `false`） |
//
//  ⚠ **变量清单的权威来源是表本身**（它就是"编辑器今天真的画出来的那些旋钮"的快照）。
//    引擎**不**重走一遍 `web/src/leaves.ts` 的枚举 —— 那会让 `src/**` 依赖编辑器 UI 代码，
//    而两份枚举一旦漂移，症状是"某个旋钮的点数**默默地**不再参与计算"
//    （本项目列为最危险的那类静默不一致）。
//
//  ⚠⚠ 账按**基础技能（`base`）**的分区查（变体对着它的模板查），
//    取值从**现在这份技能（`cur`）**读 —— 这正是"变体 = 模板 + 我的选择"。
//
//  ## 三条校验（用户 2026-09-30 定的；级别见各自那一行）
//
//  ① **表外取值 → 报错**（不许静默当 0）：账上留一条 `⚠ 表外取值` 的记录
//     （`points: 0`，但**看得见**），校验器报 `LOOKUP_VALUE_NOT_IN_TABLE`（错误）。
//  ② **同一个变量的表项全部相等 → 报警**：那个旋钮在账上是**死的**
//     （`checkBalance` 报 `LOOKUP_DEAD_KNOB`，警告）。出厂内容里有 **93 个**，
//     全是"整行 0"—— 和 60a §8.6 那个数逐位相同。
//  ③ **表必须覆盖内容里出现的每个取值** → 错误（`lookupGapsOf` + 下面的
//     `lookupCoverageIssues`）：出厂内容实测 **0 漏**（60a §4 + 60b 复验）。

/** 表的一行：**取值键 → 整数点数** */
export type LookupRow = Readonly<Record<string, number>>

/** 表的一个分区：**变量键 → 一行** */
export type LookupPartition = Readonly<Record<string, LookupRow>>

/**
 * `content/balance.json` 的 `lookupTable` 一栏（读出来之后的样子）。
 *
 * ⚠ 键 = **技能 id**（`skill.magic-bolt`），不是技能名 —— 名字是文案，会改；
 *   id 是身份，账（和 `basedOn`）都按它认。
 */
export type LookupTable = Readonly<Record<string, LookupPartition>>

/**
 * 从 `content/balance.json` 的 `lookupTable` 读这张表。
 *
 * ⚠⚠ **读不出来就返回 `undefined`，不返回空表**：
 *   · `undefined` = "这份 options 根本没在查表定价下跑" ⇒ 走老公式路
 *     （合成探针的 `PriceOptions` 就是这个情形，见 `skillLedger`）；
 *   · 空表 `{}` = "查了表，但一格都没有" ⇒ 那是**另一个**意思。
 *   两者混成一个 `{}` 的话，"没装表"和"表是空的"在账上长得一模一样。
 *
 * ⚠ 认不出的格子一律不算数（不是有限数 / 不是整数）：宁可少一格，
 *   也不要拿一个 `NaN` 或小数去算账。表本身写坏了由 `checkBalance` 说人话。
 */
export function readLookupTable(raw: unknown): LookupTable | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, LookupPartition> = {}
  for (const [partition, v] of Object.entries(raw as Record<string, unknown>)) {
    // ⚠ `_` 开头的是文案（`_这是什么` / `_口径`），不是技能分区
    if (partition.startsWith('_')) continue
    if (v === null || typeof v !== 'object' || Array.isArray(v)) continue
    const rows: Record<string, LookupRow> = {}
    for (const [variable, row] of Object.entries(v as Record<string, unknown>)) {
      if (variable.startsWith('_')) continue
      if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
      const cells: Record<string, number> = {}
      for (const [value, points] of Object.entries(row as Record<string, unknown>)) {
        if (value.startsWith('_')) continue
        if (typeof points !== 'number' || !Number.isInteger(points)) continue
        cells[value] = points
      }
      rows[variable] = cells
    }
    out[partition] = rows
  }
  // ⚠ 一格都没有 ⇒ 当成"没有表"（理由见上面那段：空表不是"有一张空表"）
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * 读一个**字段路径**上的数（`phases.0.duration` / `ruleSlots` / `rules.0.then.0.…`）。
 *
 * ⚠ 数字段一律当**数组下标**用（`Array.isArray` 那一支）—— 路径是编辑器
 *   `data-path` 的写法，阶段是数组、不是对象。
 * ⚠ 路径上任何一段不存在 ⇒ `undefined`（**不抛异常**）：这才是"这个变量
 *   在这份技能里没有"的正常表达（编辑器允许摘掉东西，例如"没有冷却"）。
 */
function numberAtPath(root: unknown, path: string): number | undefined {
  let cur: unknown = root
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = Array.isArray(cur)
      ? (cur as readonly unknown[])[Number(seg)]
      : (cur as Record<string, unknown>)[seg]
  }
  return typeof cur === 'number' && Number.isFinite(cur) ? cur : undefined
}

/**
 * 这个技能里，`variable` 这个变量**现在选中的取值键**（= 表里那一行的键）。
 *
 * ⚠ 返回 `undefined` = "这份技能里没有这个变量"（**不是** 0、也不是出厂值）。
 *   调用方必须把"没有这个变量"和"值不在表里"分开 —— 见 `lookupGapsOf`。
 *
 * ⚠ `@冷却时机` 永远有值（没有冷却 ⇒ `没有冷却`），因为它是"哪一段进冷却"这个
 *   二选一本身，编辑器对**每一份有阶段的技能**都画那一块（60a §8.4 的裁定口径）。
 */
export function lookupValueKeyOf(skill: Skill, variable: string): string | undefined {
  if (variable === '@冷却时机') {
    /*
     * ⚠ 冷却是**技能的唯一属性**（校验器 `COOLDOWN_TWO_PHASES`）⇒
     *   扛着它的那一段最多一段，取第一段就是取唯一那一段。
     * ⚠ 取值键是**阶段名**（表里的键就是名字）；名字会重复，而重名会让
     *   取值键撞车 —— 那时查不到格，账上会留 `⚠ 表外取值` 记录（不静默）。
     */
    const i = skill.phases.findIndex(p => p.cost?.cooldown !== undefined)
    if (i < 0) return '没有冷却'
    const p = skill.phases[i]
    const name = p?.name ?? p?.id
    return typeof name === 'string' && name.length > 0 ? name : undefined
  }
  const interrupt = /^@打断等级\.(\d+)$/.exec(variable)
  if (interrupt !== null) {
    const p = skill.phases[Number(interrupt[1])]
    return p === undefined ? undefined : (p.interrupt ?? 'damage')
  }
  const occupies = /^@占用施法者\.(\d+)$/.exec(variable)
  if (occupies !== null) {
    const p = skill.phases[Number(occupies[1])]
    return p === undefined ? undefined : (p.occupiesCaster === true ? 'true' : 'false')
  }
  const v = numberAtPath(skill, variable)
  return v === undefined ? undefined : String(v)
}

/** 一处"表里查不到格"的地方 —— 三条校验共用的素材 */
export interface LookupGap {
  /** 现在这一份技能的 id */
  skillId: string
  /** 变量的键；`no-partition` 时没有（那时是**整份技能**不在表里） */
  variable?: string
  /** 这份技能现在选中的取值键；`undefined` = 这个变量在这份技能里不存在 */
  value?: string
  /**
   * 为什么没格：
   *   · `no-partition`       表里没有这个技能（基础技能）的分区
   *   · `value-not-in-table` **表外取值** —— 用户第 ① 条要的东西
   *   · `variable-missing`   表里有这个变量，这份技能里没有它
   *     （⚠ 例：选"没有冷却"之后 `phases.N.cost.cooldown` 那个叶子被摘掉了 ——
   *      那一笔已经记在 `@冷却时机` 上，所以**这一条不是错**，只是要说出来）
   */
  why: 'no-partition' | 'value-not-in-table' | 'variable-missing'
}

/**
 * 这份技能按这张表查下来，有哪几处查不到格。
 *
 * ⚠ 分区按**基础技能**的 id 取（`base`）：变体（`basedOn`）对着它的模板查，
 *   取值从 `skill` 读。基础技能传自己 ⇒ 等价于按自己的 id 查。
 *
 * ⚠ 这是**只报告、不改账**的纯查询：账怎么算看 `lookupEntriesOf`。
 */
export function lookupGapsOf(skill: Skill, base: Skill, table: LookupTable): LookupGap[] {
  const partition = table[base.id]
  if (partition === undefined) {
    return [{ skillId: skill.id, why: 'no-partition' }]
  }
  const out: LookupGap[] = []
  for (const [variable, row] of Object.entries(partition)) {
    const value = lookupValueKeyOf(skill, variable)
    if (value === undefined) {
      out.push({ skillId: skill.id, variable, why: 'variable-missing' })
      continue
    }
    if (!Object.prototype.hasOwnProperty.call(row, value)) {
      out.push({ skillId: skill.id, variable, value, why: 'value-not-in-table' })
    }
  }
  return out
}

/**
 * 一个技能**查表**算出来的账：**每一格一笔，0 点的那几格不留记录**。
 *
 * ⚠⚠ `total` 就是这些 `points` 的和 —— **纯相加**。没有取整、没有地板、
 *   没有"现在减出厂"（出厂那一格是 0，相减和不相减一个样）。
 *
 * ⚠ **表外取值**（玩家拖到了格子外）时这一格**不留 0 就走**：账上会出现一条
 *   `⚠ 表外取值…` 的 0 点记录。用户第 ① 条要的就是这个 ——
 *   "**不许静默当 0**"：静默的 0 和"这一项没计价"在合计上长得一模一样。
 *
 * ## ⚠⚠ 两条路并存（2026-09-30 日志 63）—— 优先级写死在这里
 *
 * `phases.N.duration` 这一条轴有**两张来源**，而且它们**不是二选一**：
 *
 *   ① **倍数档走表**（`o.tierTables.phaseDurationPoints`）：现在 / 出厂落在
 *      `{0, 1, 3, 9}` 里 ⇒ 价 = 表里那一格（`phaseDurationTierPriceOf`）。
 *      这是编辑器那四个按钮走的路 —— **四档永远有价可查**。
 *   ② **绝对秒数继续走老的**（`table` 里那一行格子）：表外的取值（1.7× 那种）
 *      照旧按那一格收；一格都没有时照旧留 `⚠ 表外取值` 记录（不许静默当 0）。
 *
 * ⚠ **为什么倍数档优先**：那四档的价格是**用户 2026-09-30 亲口定的四个整数**
 *   （无 −6 / 1× 0 / 3× +2 / 9× +4），而老格子里那几格是**跑出来的**近似值
 *   （60a 那一轮把"改了这一个变量之后的相对账"整格量了一遍）。
 *   两张表打架时，"用户签的那个数"必须赢 —— 否则会出现"表里写 +2、账上按 −1 扣"。
 *
 * ⚠ `o` 不传（老调用方 / 合成探针）⇒ **一个字都不变**：只走 ② 那条老路。
 *   这是故意的退路：没有 `PriceOptions` 的地方（纯函数测试）不该被新机制碰到。
 */
export function lookupEntriesOf(
  skill: Skill,
  base: Skill,
  table: LookupTable,
  o?: PriceOptions,
): PriceEntry[] {
  const partition = table[base.id]
  if (partition === undefined) return []
  const out: PriceEntry[] = []
  for (const [variable, row] of Object.entries(partition)) {
    const value = lookupValueKeyOf(skill, variable)
    // ⚠ 这个变量在这份技能里不存在（例如"没有冷却"之后冷却秒数那个叶子没了）
    //   ⇒ 它贡献 0。**不能**拿出厂值顶上去：出厂那一格是 0，顶上去还是 0，
    //   但那是"猜"，会让"变量被摘掉"和"变量没动"再也分不开。
    if (value === undefined) continue
    /*
     * ---- ① 倍数档走表（见上面那一节）----
     *
     * ⚠ 0 点的那一档（= `1×`，中性档）**不留记录** ——
     *   出厂技能走的全是这一支（出厂时长除以自己 = 1×），所以
     *   "出厂全 0"（合计 **和** 条目数都是 0）这条常驻断言一个字都没变。
     */
    const tierPrice = o === undefined ? undefined : phaseDurationTierEntryOf(variable, skill, base, o)
    if (tierPrice !== undefined) {
      if (tierPrice.points === 0) continue
      out.push({
        label: `${variable} = ${value}（${String(tierPrice.tier)}× 档 · 查表）`,
        points: tierPrice.points,
        from: lookupFromOf(variable),
        path: variable,
      })
      continue
    }
    // ---- ② 绝对秒数那条老路（一个数都没动）----
    if (!Object.prototype.hasOwnProperty.call(row, value)) {
      out.push({
        label: `⚠ 表外取值：${variable} = ${value}（表里没有这一格）`,
        points: 0,
        from: lookupFromOf(variable),
        path: variable,
      })
      continue
    }
    const points = row[value]
    if (points === undefined || points === 0) continue
    out.push({ label: `${variable} = ${value}`, points, from: lookupFromOf(variable), path: variable })
  }
  return out
}

/** `phases.<下标>.duration` —— 唯一一条**倍数档**轴（2026-09-30 日志 63） */
const PHASE_DURATION_VARIABLE = /^phases\.(\d+)\.duration$/

/**
 * 这一个变量（如果是阶段时长的话）**按倍数档**值多少点。
 *
 * ⚠ 变量键的下标是**按位置**的（`phases.2.duration`），所以出厂那一头也从
 *   `base.phases[同一个下标]` 取 —— 两边用同一个下标，这正是"这一段"：
 *   变体的段序和模板不一致时这里会取错段，但那是账本**一直**的口径
 *   （`lookupValueKeyOf` 也是按下标读的），不是这一片引入的。
 *
 * ⚠ 覆盖按 **`base.id`** 查（分区键 = 基础技能 id）：变体对着它的模板查，
 *   和 `skillLedger` 取分区那句是同一个 id。
 */
function phaseDurationTierEntryOf(
  variable: string,
  cur: Skill,
  base: Skill,
  o: PriceOptions,
): { tier: number; points: number } | undefined {
  const m = PHASE_DURATION_VARIABLE.exec(variable)
  if (m === null) return undefined
  const i = Number(m[1])
  const nowPhase = cur.phases[i]
  const wasPhase = base.phases[i]
  if (nowPhase === undefined || wasPhase === undefined) return undefined
  return phaseDurationTierPriceOf(wasPhase.duration, nowPhase.duration, o, base.id)
}

/**
 * 一条查表记录算**哪一层**（`PriceEntry.from`）。
 *
 * ⚠ 它只影响账本上的**分组标签**（`validate` / 编辑器那一栏），
 *   不影响任何一个数。`@` 开头的那三个都是**阶段属性**
 *   （冷却时机 = 哪一段进冷却、打断等级、占用施法者）⇒ 记 `phase`。
 */
function lookupFromOf(variable: string): PriceEntry['from'] {
  if (variable === 'ruleSlots') return 'ruleSlots'
  if (variable.startsWith('phases.') || variable.startsWith('@')) return 'phase'
  if (variable.startsWith('effect.')) return 'effect'
  return 'rule'
}

/**
 * 一条**按轴**记的账：把一个技能的某条轴折成"出厂多少点 / 现在多少点"。
 *
 * ⚠ 每条轴的**基底**取法不一样，这是刻意的（取错了会静默地多算一笔）：
 *
 * | 轴 | 基底 | 为什么 |
 * | --- | --- | --- |
 * | `phase` 阶段时长 | **这一段的**时长 | 每一段各自有档位（前摇 0 档 ≠ 后摇 0 档）。⚠ 2026-09-30（日志 59）起它的价**查表**（`tierTables`），不是 `× 汇率` |
 * | `energy` 能量 | 付能量**那一段自己的**值 | 它是"这一段自己的代价"（拆段不该多算钱） |
 * | `cooldown` 冷却 | 全技能**唯一那一段** | 冷却是**技能的唯一属性**（校验器 `COOLDOWN_TWO_PHASES`）；"各段相加"会把一份不存在的第二份冷却也算进去 |
 * | `hp` 生命 | —— | **没有 0 档**：出厂内容没有任何一段付生命，而且"0 血代价"是"没写"的写法，不是一档收益。`zeroTierK('hp')` 返回 0，正好关掉它 |
 *
 * ⚠⚠ **`phase` 已经不在这个联合里**（2026-09-30 日志 59）：阶段时长的档位价
 *   改成**查表**了，K 那个乘数在它身上已经不存在（"0 档"那一笔是表里的一个整数）。
 *   下面这两条（能量 / 冷却）**一个字都没动** —— 用户硬命令：
 *   「别的旋钮的定价留在后面几步」。
 */
type TierAxisKind = 'energy' | 'cooldown' | 'hp'

/** 一条轴的 0 档乘数 K —— 从 `rates` 来，**不写死**（玩家："先按这个来、以后慢慢测试"） */
function zeroTierK(kind: TierAxisKind, R: Rates): number {
  if (kind === 'energy') return R.energyZeroTierMultiplier
  if (kind === 'cooldown') return R.cooldownZeroTierMultiplier
  return 0
}

/**
 * **一段时长占了多少点** —— 就是 `pricePhase` 里"时间"那一项本身。
 *
 * ⚠ 存在的理由：查表定价要把这一项**从段价里换掉**（换成表里的整数），
 *   所以它必须**只有一处定义**。抄第二遍的话，`pricePhase` 改了而这里没改，
 *   症状是"档位那一笔每次都多算/少算一点点"，而**两个数看起来都正常**。
 *
 *   · `wait` 段（修饰零件插进来的空档）→ 0（它按秒数在别处收，见 `pricePhase`）
 *   · 蓄力（`duration < 0`）→ `chargePhasePerPoint`（定额，**不在档位轴上**）
 *   · 其余 → `秒 × phaseSecondPerPoint`
 */
function durationTermOf(p: Phase, R: Rates): number {
  if (p.wait === true) return 0
  if (p.duration < 0) return R.chargePhasePerPoint
  return p.duration * R.phaseSecondPerPoint
}

/**
 * 这一段**在不在档位轴上**（= 能不能查表）。
 *
 * | 出厂那一头 | 现在这一头 | 在轴上吗 | 为什么 |
 * | --- | --- | --- | --- |
 * | `> 0` 秒 | `>= 0` 秒 | ✓ | 正常：0 / 1× / 3× / 9× 四档 |
 * | `> 0` 秒 | `< 0`（蓄力哨兵） | ✗ | **换了一根轴**：蓄力是"按住键"的哨兵值，价是 `chargePhasePerPoint` 定额 |
 * | `<= 0`（出厂就是蓄力 / 没时长） | 任意 | ✗ | 出厂那一头没有一个"1×"可当基准 —— 档位无从谈起 |
 * | 那一段现在被删了 | —— | ✓ | 「删掉这一段」是 **0 档的极限形态**（`tierOf(base, 0)`） |
 *
 * ⚠⚠ **`< 0` 那一行必须留着**（老代码同样有一条 `was.duration > 0` 的判据）：
 *   少了它，出厂就是蓄力的技能会被当成"你把时长取消了"，白送一笔 0 档的额度 ——
 *   而它出厂那一笔本来就按 `chargePhasePerPoint` 收过了。
 */
function onPhaseDurationTierAxis(was: Phase, now: Phase): boolean {
  return onDurationTierAxis(was.duration, now.duration)
}

/**
 * 上面那条判据的**秒数版**（2026-09-30 日志 63 抽出来）。
 *
 * ⚠ 抽出来的理由不是好看：现在有**两个**调用方（段级的 `onPhaseDurationTierAxis`
 *   和 `phaseDurationTierPriceOf`），而"哪一段在档位轴上"必须是**同一句话** ——
 *   两处各写一遍的话，迟早出现"账上算得出这一档、校验器却说它不在这档上"。
 */
function onDurationTierAxis(wasDuration: number, nowDuration: number): boolean {
  return wasDuration > 0 && nowDuration >= 0
}

/** 「这个取值不在档位表里」——一条给校验器/编辑器看的**问题**（不是警告，是错误） */
export interface PhaseTierProblem {
  /** 哪一段（`phases[i]` 里的 id） */
  phaseId: string
  /** 这一段出厂多少秒 / 现在多少秒（报错的话里要能看见这两个数） */
  wasDuration: number
  nowDuration: number
  /** 出问题的那条轴的表名（指路用） */
  table: string
}

/**
 * **`内容里出现的取值必须在表里`** —— 这一条就是那道保险（用户 2026-09-30 硬命令）。
 *
 * 逐段对一遍：出厂有时长、现在也还是个时长的那些段，它的
 * `现在 / 出厂` **必须**是表里的某一档。不是的话返回一条问题，
 * 调用方（校验器 / 编辑器）**报错**。
 *
 * ⚠⚠ **为什么必须报错、不许静默**：
 *   查表定价的前提是"取值落在档位上"。落不在档位上的话，表**指不出这一格值多少点**——
 *   而"指不出来"如果被实现成"那就是 0 点"，就正好复刻了本项目当年删掉
 *   手写 `points` 的那个病：**内容改了，点数纹丝不动**（"把 30 改成 300"那个）。
 *   ⇒ 宁可报错让玩家把值拖回档位（编辑器里那四档就是为此存在的，见日志 50 §6.2），
 *     也不要给一个看起来正常的 0。
 *
 * ⚠ 它**只对"有出厂值的段"成立**：新加的一段没有基准，谈不上"表外取值"
 *   （那种段照旧按绝对价记，见 `ledgerEntries`）。
 */
export function phaseTierProblems(cur: Skill, base: Skill, o: PriceOptions): PhaseTierProblem[] {
  const table = tierTableOf(o, TIER_TABLE_PHASE_DURATION)
  const out: PhaseTierProblem[] = []
  for (const phase of cur.phases ?? []) {
    const was = (base.phases ?? []).find(p => p.id === phase.id)
    if (was === undefined) continue                       // 新加的一段：没有基准
    if (!onPhaseDurationTierAxis(was, phase)) continue     // 不在轴上（蓄力 / 出厂没时长）
    if (tierOf(was.duration, phase.duration, table) !== undefined) continue
    out.push({
      phaseId: phase.id,
      wasDuration: was.duration,
      nowDuration: phase.duration,
      table: table.name,
    })
  }
  return out
}

/**
 * 一条轴的"1× 档价"（绝对值，正 = 提供额度）：**能量**。
 *
 * ⚠ 单独一个函数是为了让"基底取什么"这件事在调用点上一眼可见 ——
 *   能量取的是**这一段自己的**值（不是技能总额：那是"各段相加会多算"的老坑）。
 */
function energyAxisPoints(energy: number, R: Rates): number {
  return energy / R.energyPerPoint
}

/** 一条轴的"1× 档价"（绝对值，正 = 提供额度）：**冷却**（技能的唯一属性，取唯一那一段） */
function cooldownAxisPoints(seconds: number, R: Rates): number {
  return seconds * R.cooldownSecondPerPoint
}

/**
 * **0 档值多少点**（负 = 消耗额度）。
 *
 * ```
 * 0 档的价 = −(K + 1) ×（这一条轴的 1× 档价）
 * ```
 *
 * ⚠ **`−(K + 1)`，不是 `−K`**，这一条错了没有任何地方会报警，所以写清楚：
 *
 * | | 值 | 价 |
 * | --- | --- | --- |
 * | 出厂那 8 秒冷却（1× 档） | `+8 秒` | `+8 × 汇率` = 这条轴的 1× 档价 |
 * | 现在 0（**0 档**） | `0 秒` | **`−K × 1× 档价`** ← 定稿 §12.5 / §12.6 印的 −2.33 / −14.4 是这个 |
 * | **账上那一行** = 0 档的价 − 这一段现在的价 | | 见下面第 2 条 |
 *
 * ⚠ **两件事别混（这一片最容易错的地方）**：
 *   1. 定稿那张表印的是 **`−K × 轴价`**（0 档的价本身）；
 *   2. **账上那一行减掉的是"这一段整段的价"**（`pricePhase`），
 *      不是"这条轴自己的价" —— 一段里通常还挂着时长（0.2 秒 = 0.2 点）。
 *      ⇒ 一行会比表里的数**再低一点**，差多少取决于这一段还付了什么。
 *      (`ledgerEntries` 里那一行 = `e.points`（这一段现在的价）**加上**本函数的返回值。)
 *
 * ⚠ **必须写成一步 `-(K+1) * B`，不许拆成 `-K * B - B`**：
 *   两个式子在数学上相等，在浮点里**不等**（`K = 9、B = 0.3` 差 4e-16），
 *   而 `round` 会把这点差放大成 0.1 点。实测踩到过、查了很久。
 *
 * ⚠ `basePoints` 是**点**，不是**值**（秒 / 能量）—— 调用方先换算再传。
 *   传值进来会静默地大几十倍（实测：`−5.0` 变成 `−100.5`）。
 */
function zeroTierValue(kind: TierAxisKind, basePoints: number, R: Rates): number {
  if (!(basePoints > 0)) return 0
  return round(-(zeroTierK(kind, R) + 1) * basePoints)
}

/**
 * 「扛打断」值多少额度（正数，调用方减掉就是消耗额度）。
 *
 *   被伤害打断（默认）→ 0
 *   只被控制打断       → 一半
 *   无法打断           → 全额
 *
 * ⚠ 那个"一半"是个**近似**：它对玩家完全够用（"挨打不断"确实只值
 *   "完全不断"的一半左右），但它不是推导出来的。标定器调不了它 ——
 *   要调就改这个常数，别再引入一个汇率。
 */
const CONTROL_ONLY_SHARE = 0.5

function uninterruptibleCredit(p: Phase, R: Rates): number {
  switch (p.interrupt ?? 'damage') {
    case 'none': return R.uninterruptiblePhase
    case 'control': return R.uninterruptiblePhase * CONTROL_ONLY_SHARE
    default: return 0
  }
}

/**
 * 一条动作**不写 `target`** 时，效果到底落在谁身上。
 *
 * ## 为什么要把它变成一个显式的函数
 *
 * 以前这里是一句猜的：`r.when !== 'onHit'` —— "除了 onHit 之外都是自己"。
 * 它和引擎的**实际行为**不一致，而症状极难查：
 * **同一个动作，引擎打敌人、账上按打自己算**，于是这条规则的符号整个反了
 * （本该是 -3 的收益，账上是 +3 的代价）。
 * 这个坑咬了四次，每次都是"账算反了但没有任何地方会报警"。
 *
 * 现在的判据是**逐条对照引擎的调用点**抄下来的（不是设计意图，是事实）：
 *
 *   `'other'`（对面那个，确定）
 *     onHit          —— `fireCastRules(ctx,'onHit', t)`、投射物 `{target}`、管线钩子
 *     onKill         —— `fireCastRules(ctx,'onKill', t)`、投射物
 *     onEnter/onLeave—— 区域的重叠判定，带"走进来的那个人"
 *     onDamaged / onLethalDamage / onCrit / onNonCrit —— 管线里 `buildValueContext` 给的"另一方"
 *
 *   `'self'`（就是自己，确定）
 *     onLowHp        —— `runTechniqueRules(world, tech, target, …)`，target 就是血量跨线的那个人
 *     onStatusApplied—— 触发者是**挂上状态的那个人**自己
 *     状态钩子的 onTick —— `tickStatusHooks` 的 ctx 里 `actor` 就是持有者，
 *       而 ⚠ **2026-09-30 日志 61 起 `target` 也显式填成持有者**（以前不填，
 *       靠 `ctx.target ?? ctx.actor` 那句兜底 —— 那句清掉之后不填就"什么都不做"）
 *
 *   `'depends'`（**由术式决定**）
 *     onCast / phaseEnter / phaseComplete / phaseInterrupt / 规则级 onTick / onMiss
 *       —— 这几条 `runRules` **不传 target**，于是落到
 *          `runTechniqueRules` 里那句 `selfOnly ? caster : lockedTarget`：
 *          · 术式的 `valid` 全是 `self` → 打自己
 *          · 否则 → 打锁定目标（通常是敌人）
 *       onMiss 还要额外注意：`fireCastRules(ctx,'onMiss')` 有一处**不传 target**，
 *       另一处传 —— 所以它也算 depends。
 *
 * ⚠⚠ **2026-09-30 日志 61 起，`'depends'` 那几条多了一种收尾**：
 *   那一句 `selfOnly ? caster : lockedTarget` 给出 `undefined` 时（方向性术式
 *   没锁到人），动作**什么都不做** —— 用户定的"需要目标却选不到 ⇒ 什么都不做"，
 *   以前是静默地落到施法者自己头上（见 `sim/pipeline.ts` 的
 *   `resolveActionTarget` / `pickActionTargets`）。
 *   ⚠ 这只改**引擎行为**，不改账：`defaultTargetOf` 取的那个默认值照旧
 *     （"假定打敌人"），所以账一个数都没动。
 *
 * ⚠ `'depends'` 是**真·不确定**：同一个技能放进"自愈术式"和"攻击术式"里，
 *   账会不一样。所以定价只能取一个默认值，而**校验器必须把这个不确定报出来**
 *   （见 `TARGET_DEPENDS_ON_TECHNIQUE` / `TARGET_CONTRADICTS_TECHNIQUE`）。
 *   这就是"不再偷偷猜"的全部含义。
 */
export type DefaultTarget = 'self' | 'other' | 'depends'

/** 管线钩子里会带"另一方"的那几个时机 */
const HOOK_OTHER: readonly string[] = [
  'onHit', 'onDamaged', 'onLethalDamage', 'onCrit', 'onNonCrit', 'onMiss',
]

/** 规则级确实带"另一方"的那几个时机（**不含 onMiss**，理由见下） */
const RULE_OTHER: readonly string[] = [
  'onHit', 'onKill', 'onCrit', 'onNonCrit', 'onDamaged', 'onLethalDamage',
  'onEnter', 'onLeave',
]

export function defaultTargetOf(when: string | undefined, inHook: boolean): DefaultTarget {
  if (when === undefined) return 'depends'

  /*
   * ⚠ 钩子（管线 / 状态钩子）里的语境和规则级**不一样**，必须分开判：
   *   管线钩子由 `buildValueContext` 建 ctx，`target` 是"另一方"；
   *   而状态钩子的 `onTick` 由 `tickStatusHooks` 建 ctx，**只有 actor**。
   *   把两者混起来，soul-rend 那条 DoT 的账就会反。
   */
  if (inHook) {
    if (HOOK_OTHER.includes(when)) return 'other'
    if (when === 'onTick') return 'self'
    // 其余的时机在钩子里 `matchWhen` 一律返回 false —— 根本不会触发
    return 'depends'
  }

  if (RULE_OTHER.includes(when)) return 'other'
  if (when === 'onLowHp' || when === 'onStatusApplied') return 'self'

  /*
   * ⚠ `onMiss` 在**规则级**是不确定的，不能算 'other'。
   *
   *   `pipeline.ts` 里有两条路会触发它：
   *     · 有具体目标时：`fireCastRules(ctx, hit.connected ? 'onHit' : 'onMiss', t)` → 带 target
   *     · **一个目标都没打中**时：`fireCastRules(ctx, 'onMiss')` → **不带 target**
   *       （那时确实没有"那个单位"可传）
   *   第二条落回 `selfOnly ? caster : lockedTarget` —— 所以它和 phaseComplete 同类。
   *
   *   这正是"引擎自己有两条路"的地方，定价只能承认它不确定。
   */
  return 'depends'
}

/**
 * 一条规则值多少点，**按一次触发算**。
 *
 * ⚠ 不写 `target` 的动作落在谁身上，由 `defaultTargetOf()` 决定 ——
 *   那是**照抄引擎调用点**得出来的事实，不是猜的。
 *   `'depends'` 时取 `'other'`（schema 里写明"不写就是 'hit'"，
 *   也就是"对面那个"），而**校验器会把这一处不确定报出来**。
 */
export function priceRule(
  r: Rule,
  R: Rates,
  statuses?: ReadonlyMap<string, StatusDef>,
  entities?: ReadonlyMap<string, EntityDef>,
): number {
  const fallback = defaultTargetOf(r.when, false) === 'self' ? 'self' : 'other'
  const ctx: PriceContext = { rates: R, statuses, entities }

  let total = 0
  for (const a of r.then ?? []) {
    const action: Action = a.target === undefined && fallback === 'self'
      ? { ...a, target: 'self' }
      : a
    total += actionPoints(action, ctx)
  }

  // onTick 是"每秒发生几次"，不乘频率的话一个每 0.5 秒扣 3 点能量的
  // 持续代价只按一次算 —— 白送。
  if (r.when === 'onTick') total *= tickRate(r.every)

  return total
}

// ============================================================================
//  主函数
// ============================================================================

export interface PriceOptions {
  rates: Rates
  baseRuleSlots: number
  ruleSlotBuyCost: number
  ruleSlotSellGain: number
  /**
   * ⚠⚠ **已作废、不再读**（2026-09-30 日志 57）。
   *
   *   它原来是"配平容差"：`|合计| ≤ 容差` 就算配平。**那个东西已经不存在了** ——
   *   用户规格：**合计 ≥ 0 就能用、合计 < 0 才要付血契**，没有缓冲区。
   *
   *   ⚠ 字段本身留着**只为了让 `web/src/**`（编辑器 UI，当轮冻结）编译过**；
   *     传进来也会被**无声地忽略**。判据看 `kindOf` / `POINT_EPS`。
   *     能动 UI 的那一轮应该把这个字段一起删掉。
   */
  tolerance?: number
  /**
   * 状态库（`content/statuses/`）。
   *
   * ⚠ 不传的话，技能里按 `statusId` 引用库状态的动作会被定价成 **0 点**
   *   （只认内联定义）。表现是"挂一个 150 点的盾在账上免费"——
   *   和位移以前走 default 返回 0 是同一个病。
   *
   * 命令行、编辑器、标定器都应该传它；只有不认识内容库的纯函数测试才省略。
   */
  statuses?: ReadonlyMap<string, StatusDef>
  /**
   * 实体预设（`content/entities/`）。
   *
   * ⚠ 不传的话，召唤**算不出价钱**：找不到预设就只知道"有个单位"，
   *   一具 60 血的骷髅会被算成 2 点而不是 8 点。
   */
  entities?: ReadonlyMap<string, EntityDef>
  /**
   * **修饰原型表**（`content/modifiers/`）—— 2026-09-21 日志 51。
   *
   * ⚠ 不传的话，修饰零件的账**一笔都不记**：份数类（多重释放 / 一分为 X）
   *   和等待类（等待 X 秒）都算不出来 —— 账面上"一次打 10 个"和
   *   "空出 3 秒"看起来都是白送的，而"白送"和"没计价"在合计上是同一个数字。
   *   所以命令行 / 编辑器 / 校验器都要传。
   */
  modifiers?: ReadonlyMap<string, ModifierProto>
  /**
   * 修饰零件的汇率（`balance.json` 的 `modifierRates`）。
   *
   * ⚠ 它**故意不在 `rates` 里**（见 `DEFAULT_MODIFIER_RATES` 上面那段：
   *   标定器的拟合变量是 `rates`，加进去 `npm run calibrate` 的输出会变）。
   */
  modifierRates?: Readonly<Record<string, number>>
  /**
   * **查表定价的档位表**（`balance.json` 的 `tierTables`）—— 2026-09-30 日志 59。
   *
   * ⚠ 缺了的话落到 `DEFAULT_TIER_TABLES` 那份**代码兜底**（见它的注释：
   *   `web/src/**` 当轮冻结、它手工拼 `PriceOptions`）—— 所以调用方**不传**
   *   不会算出 0 点，但也**不该指望它**：命令行 / 校验器 / 编辑器都应该走
   *   `priceOptionsFor`（表是从内容侧读的）。
   *
   * ⚠⚠ 它**不在 `rates` 里**（和 `modifierRates` 同一个理由，而且更硬）：
   *   `calibrate --write` 会把 `rates` 里每个键**写成拟合出来的小数** ——
   *   表进去就会被压成小数，而档位必须是整数。
   */
  tierTables?: TierTables
  /**
   * **全量点表**（`balance.json` 的 `lookupTable`）—— 2026-09-30 日志 60b。
   *
   * ⚠⚠ 这是**账的算法的开关**：
   *   · 给了（不是 `undefined`）⇒ 技能的点数 = **查表 + 相加**（用户规格）；
   *   · 没给 ⇒ 走**老公式路**（`ledgerEntries`）。
   *
   *   "没给"是**故意的**一条退路：合成探针（`tests/pricing.ts` 那些 `skill.probe`）
   *   的 `PriceOptions` 是手拼的、不带表，它们钉的是老公式那一套。
   *   ⚠ 而**当真内容的边**（命令行 / 校验器 / 编辑器）一律要经过
   *     `priceOptionsFor` 或那三处装配线 —— 那里**必须**装上表，
   *     否则账会**静默地**退回老公式（"我改了表，点数没动"那种漂移）。
   *
   * ⚠ 它不在 `rates` 里（和 `tierTables` 同一个理由，而且更硬）：
   *   `calibrate --write` 会把 `rates` 里的每个键**写成拟合出来的小数** ——
   *   表进去就会被压成小数，而表里的数按用户规格**必须是整数**。
   */
  lookupTable?: LookupTable
}

/** 合计 → 这个技能算普通还是超模 */
function kindOf(total: number): PriceResult['kind'] {
  /*
   * ⚠ 花超了才是超模。判据是 **< 0**。
   *
   * ⚠⚠ 2026-09-30（日志 57）**删掉了产品意义上的容差**（原来是 `total < -容差`）。
   *   用户原话：**"点数之和大于 0 就能用，小于 0 就要支付血契才能用"** ——
   *   所以这里没有缓冲区。`POINT_EPS` **不是容差**，它只是浮点护栏
   *   （合计是整数，它今天根本用不上；留着是因为"这条判据不许因为
   *   一个 `-0.9999999999999999` 把一份完美配平的术式判成败给"）。
   */
  return total < -POINT_EPS ? 'negative' : 'normal'
}

/**
 * 一条贡献的**稳定身份**。
 *
 * ⚠ 必须按 `id` 认，不能按**下标**认。
 *   改了规则顺序（玩家拖拽就能改 order）之后，按下标对的话
 *   `rules[0]` 会拿自己去减出厂版本的 `rules[0]`（其实是另一条规则），
 *   算出来的差值是**两个不相关的数相减** —— 账面上会出现一笔
 *   谁也没做过的交易，而且没有任何地方会报错。
 *
 * 阶段和规则都有 `id`；规则位没有，它只有一条。
 */
function entryKey(e: PriceEntry): string {
  if (e.from === 'ruleSlots') return 'ruleSlots'
  return `${e.from}:${e.refId ?? e.path}`
}

/**
 * 秒数写成人看的样子：`0.3s` / `0s` / `蓄力`。
 *
 * ⚠ 账上必须能看见**时长本身**，不然"0 档"这件事在界面上完全没有痕迹 ——
 *   而它是这本账里最贵的一笔（一条 8 秒冷却的 0 档 = −14.4 点）。
 */
function formatSeconds(duration: number): string {
  if (duration < 0) return '蓄力'
  return `${Math.round(duration * 1000) / 1000}s`
}

/**
 * 一个技能的**绝对**账：它现在值多少点（不减去出厂值）。
 *
 * `priceSkill` 和 `skillLedger` 共用这一段 —— 两边各写一遍的话，
 * 迟早会漂移，而漂移的表现是"编辑器里显示 +3，术式里却按 +4 扣"。
 *
 * ## ⚠ 这里**不认档位**，认档位的是 `skillLedger`
 *
 * 阶段时长这条轴上，本函数报的就是「这一段占用了多少秒 × 汇率」——
 * "取消这一段"那笔收益（`−K × 出厂时长 × 汇率`）**只在相对账里存在**，
 * 因为只有相对账才知道出厂时长是多少。
 *
 * 这样分工有两个好处：
 *   1. `priceSkill`（绝对账 / `npm run calibrate` 的输入）**一个数都不变** ——
 *      玩家 2026-09-21 明确说过"绝对式本来就对，不用改代码"。
 *   2. 出厂技能自己减自己仍然是 0：相对账两头都用同一张档位表，
 *      `1× 档 − 1× 档 = 0`，**一个例外都没有**。
 *
 * ⚠ 唯一的例外是**蓄力阶段 `duration: -1`** —— 它的价是
 *   `chargePhasePerPoint` 一笔**定额**（见 `pricePhase`），
 *   所以"取消蓄力"不是一套"0 档"能表达的：出厂就是蓄力的技能，
 *   把时长拖成 0 会走正常线性式（0 点），**不给 K 那一笔**。
 *   这是个已知的边角，写在这里免得下一个人以为漏了。
 */
function absoluteEntries(skill: Skill, o: PriceOptions): PriceEntry[] {
  const R = o.rates
  const entries: PriceEntry[] = []

  skill.phases.forEach((p, i) => {
    const points = round(pricePhase(p, R))
    /*
     * ⚠ 0 点也有话说：时长被拖成 **0 秒**（0 档）时它是 0 点，
     *   而"取消这一段"那笔价必须让玩家看得见 —— 所以这一条**不能**被 `points === 0` 吞掉。
     *
     * ⚠ 而且**它必须和"这一段的其他代价"合成一条**：
     *   账是按 `entryKey`（= `phase:<段 id>`）认身份的，一条 0 档的记录
     *   和一条"这一段还有 20 能量"的记录会**撞在同一个 key 上**，
     *   于是相对账里两个数相减 = 一笔谁也没做过的交易
     *   （和"按下标认规则"是同一个病的两种形态）。
     *
     * ⚠ 蓄力阶段（`duration: -1`）**没有档位**：它的价是 `chargePhasePerPoint`
     *   一笔定额，不是"秒 × 汇率"。所以它既不算 0 档，也不带档位后缀。
     */
    const instant = p.duration === 0                    // 0 档：这一段被取消了
    const charge = p.duration < 0                       // 蓄力：定额，不参与档位
    if (points === 0 && !instant) return
    const name = p.name !== undefined ? `阶段「${p.name}」` : `阶段 ${p.id}`
    const suffix = charge ? '（蓄力）' : instant ? '（0 档 · 取消这一段）' : ''
    entries.push({
      label: `${name} ${formatSeconds(p.duration)}${suffix}`,
      points,
      from: 'phase',
      refId: p.id,
      path: `phases[${i}].points`,
    })
  })

  /*
   * ---- 技能级的 0 档：**冷却**（"无冷却"这一档）与 **能量**（"不耗蓝"）----
   *
   * ⚠ **这两条不能在这里记**，只能记在 `ledgerEntries` 里 ——
   *   因为"冷却被清零了"这件事**需要一个出厂值来比**（现在 0、出厂 3 秒）。
   *   在这里记的话就变成了"凡是 0 都是 0 档"，而**出厂本来就不付这条轴的技能**
   *   （魔法飞弹没有冷却、血契不花能量）会白拿一笔 `K × 0` ——
   *   更糟的是"出厂 0、现在 0"会被判成一次改动，宗旨当场破。
   *   ⚠ 而且能量的 0 档是**它自己那一段**的账（见 `ledgerEntries`），
   *     在这里再记一条就是同一笔钱收两次。
   */

  /*
   * ⚠ 遍历的是 `allRulesOf`（固有效果 + 规则），不是 `skill.rules`。
   *
   *   效果里的数值（伤害、距离、时长）照样要计价 —— 玩家追问过，
   *   选的是"**机制免费、数值偏离默认才计价**"：
   *   "位移的机制本身是不应该有代价的，位移的距离有代价"。
   *   只遍历 `rules` 的话，效果里那些数字会变成**免费**的，
   *   而它们在宗旨下本来只是"出厂时恰好为 0"。
   *
   * ⚠ 效果的条目单独标 `from: 'effect'`：账上要分得清
   *   "我改的是这个技能本身"还是"我加了一条额外行为"。
   */
  /*
   * ⚠ 固有效果（`skill.effect`）**照样要计价**。
   *
   *   玩家追问过，选的是"**机制免费、数值偏离默认才计价**"：
   *   "位移的机制本身是不应该有代价的，位移的距离有代价"。
   *   只算 `rules` 的话，效果里那些数字会变成**真的免费** ——
   *   而它们在宗旨下本来只是"出厂时恰好为 0"。
   *
   * ⚠ 效果和规则**分开报**（`from: 'effect' | 'rule'`）：
   *   账上要分得清"我改的是这个技能本身"还是"我加了一条额外行为"。
   *   顺序和 `allRulesOf` 一致：**效果在前、反应在后**。
   */
  const push = (r: Rule, path: string, isEffect: boolean): void => {
    const points = round(priceRule(r, R, o.statuses, o.entities))
    if (points === 0) return
    entries.push({
      label: r.note !== undefined && r.note !== '' ? r.note : `规则 ${r.id}`,
      points,
      from: isEffect ? 'effect' : 'rule',
      refId: r.id,
      path,
    })
  }

  ;(skill.effect ?? []).forEach((e, i) => { push(effectAsRule(e, i), `effect[${i}].then`, true) })
  skill.rules.forEach((r, i) => { push(r, `rules[${i}].then`, false) })

  /*
   * 规则位：**复杂度税**。
   *
   *   买 N 条（上限高过基准）→ 你花掉了 N × buyCost      → 负
   *   卖 N 条（上限低于基准）→ 你赚到了 N × sellGain     → 正
   *
   * 方向的经济学含义：上限越高，你能塞的东西越多，所以要**付出**；
   * 主动把上限压下去是自缚，所以要**补偿**。前者是复杂度税，
   * 后者让"极简技能"能把额度换成单点强度。
   *
   * ⚠ 这里用的是**全局**基准 `baseRuleSlots`（不是这个技能出厂时的条数）——
   *   它是"复杂度税"这条规矩本身，和单个技能无关。
   *   技能自己出厂几条，在 `skillLedger` 相减时自然抵消。
   */
  const delta = skill.ruleSlots - o.baseRuleSlots
  if (delta !== 0) {
    const label = delta > 0
      ? `买 ${delta} 条规则位（初始 ${o.baseRuleSlots}）`
      : `卖 ${-delta} 条规则位（初始 ${o.baseRuleSlots}）`
    const points = delta > 0 ? -delta * o.ruleSlotBuyCost : -delta * o.ruleSlotSellGain
    entries.push({ label, points: round(points), from: 'ruleSlots', path: 'ruleSlots' })
  }

  /*
   * ⚠⚠ **这里交出去的是"原料值"（小数），不是账上印的整数** —— 2026-09-30 日志 57。
   *
   *   整数化**只在三个出口**做（`priceSkill` / `skillLedger` / `priceTechnique`），
   *   原因是一个**很容易做错、而且错了不报警**的地方：
   *   相对账是"现在 − 出厂"，如果两头**各自先取整**，那么
   *   `0.3 秒 → 0.9 秒` 这种小改动会在两头各自被 ±1 的地板抹平，
   *   相减得到 **0**，于是"玩家改了一件事、账上一个字都没有"。
   *   ⇒ **先在原料上相减，最后对本账条目取一次整。**
   *     这样 0.9 − 0.3 = 0.6 还在，取整之后就是 +1 点（看得见）。
   */
  return entries
}

/**
 * 算一个技能的**绝对**账：它自己值多少点。
 *
 * ⚠ 单个技能报表用这个（`npm run validate`、校验器的技能报告）；
 *   **术式账和编辑器要用 `skillLedger`** —— 玩家看到的应该是
 *   "我改动了多少"，而不是一个和出厂值无关的绝对数。
 */
export function priceSkill(skill: Skill, o: PriceOptions): PriceResult {
  // ⚠ **账的出口才整数化**（原料在 `absoluteEntries` 里，见那里的注释）
  const entries = integerizeEntries(absoluteEntries(skill, o))
  // ⚠ 合计**就是从各条加出来的**（各条已经是整数）：不再单独取一次整 ——
  //   单独取整正是"条目加起来和合计对不上"的来源（见 `integerPointsOf`）。
  const total = entries.reduce((s, e) => s + e.points, 0)
  return { entries, total, kind: kindOf(total) }
}

/**
 * **相对账里的"现在"那一头**：把现在这个技能的逐段贡献算出来。
 *
 * 和 `absoluteEntries(cur)` 的区别**只有阶段时长这一条轴**：
 *
 * | | 绝对账（`priceSkill`） | 相对账的现在这一头（这里） |
 * | --- | --- | --- |
 * | 0.3 秒（1× 档） | `+0.3 × 汇率` | 同左（1× 档就是它自己） |
 * | 0.9 秒（3× 档） | `+0.9 × 汇率` | 同左 |
 * | **0 秒（0 档）** | `0`（老实：它占用的时间确实是 0） | **`−K × 出厂时长 × 汇率`**（取消这一段的价） |
 * | 段被删了 | （没有这一段） | 同上（0 档的极限） |
 *
 * ⚠ 为什么要分两个函数而不是给 `absoluteEntries` 加一个参数：
 *   **`priceSkill` 是 `npm run calibrate` 的输入**，玩家 2026-09-21 明确说过
 *   "绝对式本来就对" ⇒ 它的输出**一个数都不许变**。分开写，两边各自可测。
 *
 * ⚠ 认段用 **id**，不按下标 —— 玩家拖拽就能改顺序，
 *   按下标对会把两个不相关的数相减（见 `entryKey` 那段注释）。
 */
function ledgerEntries(cur: Skill, base: Skill, o: PriceOptions): PriceEntry[] {
  const R = o.rates
  const out: PriceEntry[] = []

  /*
   * ---- 技能级的两条 0 档轴：能量 / 冷却 ----
   *
   * ⚠ 两条都**只**在"出厂真的有这条轴、现在被清零了"时才算（见下面的 `> 0`）：
   *   出厂本来就不花能量 / 没有冷却的技能**没有 0 档可言** ——
   *   少了那个判据，"出厂 0、现在 0"会被当成一次改动，宗旨（出厂全 0）当场破。
   *
   * ⚠ **基底是技能级的，不是逐段算的**：
   *   · 能量 = "这个技能总共花多少" ⇒ 取**全部付过能量的段相加**（拆段不该多算钱）。
   *   · 冷却 = **技能的唯一属性**（校验器 `COOLDOWN_TWO_PHASES`）⇒ 取**那唯一一段**。
   *     "各段相加"会把一份不存在的第二份冷却也算进去。
   */
  const baseEnergy = base.phases.reduce((s, p) => s + (p.cost?.energy ?? 0), 0)
  const baseCd = base.phases.reduce((s, p) => Math.max(s, p.cost?.cooldown ?? 0), 0)
  const nowCd = cur.phases.reduce((s, p) => Math.max(s, p.cost?.cooldown ?? 0), 0)
  const cdZero = baseCd > 0 && nowCd === 0
  /*
   * ⚠ 冷却的 0 档记在**哪一段**上，本身就是个决策：
   *   冷却是"技能的唯一属性"，它出厂写在某一段上，玩家可能把它清零（或连同那一段删掉）。
   *   规则：**先认"出厂扛着它的那一段"**（它还在就记在它头上），
   *   那一段被删了就退到**现在的第一段**上 ——
   *   否则那一段一删，冷却的 0 档会**跟着一起消失**（实测：−88 掉到 −10）。
   */
  const cdPhase = cdZero
    ? (cur.phases.find(p => base.phases.some(b => b.id === p.id && (b.cost?.cooldown ?? 0) > 0))
      ?? cur.phases[0])
    : undefined

  /*
   * ⚠ 出厂的参照点**只有这一个来源**：`absoluteEntries(base)` 里那些
   *   **账上印出来的数**（它同时是 `skillLedger` 相减的那一头）。
   *
   * ⚠ 2026-09-30（日志 59）之前这里还有一张 `beforeByPhase`（按段 id 索引的
   *   出厂段价），0 档那一笔是拿它算的。**查表之后它没有用处了**：
   *   表里的值是一个整数，不需要"这一段出厂值多少点"当基底。
   *   ⇒ 删掉，不留一个"看起来还在用"的死变量（那种变量下一个人会照着它写新逻辑）。
   */

  for (const e of absoluteEntries(cur, o)) {
    if (e.from !== 'phase') { out.push(e); continue }
    const phase = cur.phases.find(p => p.id === e.refId)
    const was = base.phases.find(p => p.id === e.refId)
    if (phase === undefined) { out.push(e); continue }

    /*
     * ⚠ 这里**只补三类 0 档 + 阶段时长那一档**，普通改动一个字都不碰 ——
     *   因为 `absoluteEntries(cur)` 已经把"现在值 × 汇率"算进去了，
     *   再按 0 档加一遍就是**同一笔钱收两次**（实测过：一段 20 能量
     *   的 0 档会从 −5.02 变成 −10.04）。
     *
     * ⚠ **出厂那一头必须是"真的付过时长"的段**（`was.duration > 0`）。
     *   少了这个判据，一条**本来就没有时长**的段（蓄力 `-1`）会被当成
     *   "你把时长取消了"，白送一笔额度 —— 而蓄力那一段的价
     *   本来就是 `chargePhasePerPoint` 一笔定额，它不在档位轴上（见 `pricePhase`）。
     */
    let points = e.points
    /*
     * ① **时长这条轴：查表**（2026-09-30 日志 59）。
     *
     *    这一段现在的价（`e.points`）里混着两项：`秒 × phaseSecondPerPoint`
     *    和别的（能量 / 冷却 / 扛打断）。查表定价要做的只有一件事 ——
     *    **把"时间"那一项换成表里的整数**，别的项一个都不动：
     *
     *        账上这一头 = 这一段现在的价 − 现在那一项 + 出厂那一项 + 表[档位]
     *
     *    ⚠ 为什么加回"出厂那一项"：相对账是 **`现在 − 出厂`**，而出厂那一头
     *      （`absoluteEntries(base)`）里**含着自己的时间那一项**。不加回来，
     *      1× 档（没改动）都会凭空差一个 `D × 汇率`。
     *      ⇒ 出厂那一头因此**一个数都不用改**（`phaseSecondPerPoint` 那套
     *      绝对式原样留着，`priceSkill` / 标定器看不到任何变化）。
     *
     *    ⚠ **表外取值**（玩家拖到了 1.7× 这种格子外）时**一个字都不加** ——
     *      于是这一行退回"两条绝对账相减"（老行为：值改了多少、点数就动多少）。
     *      这是**故意的**：宁可让点数跟着内容动（不许"纹丝不动"），
     *      同时由 `phaseTierProblems` 把"这个取值不在表里"**报成错误**。
     */
    const durationTable = tierTableOf(o, TIER_TABLE_PHASE_DURATION)
    if (was !== undefined && onPhaseDurationTierAxis(was, phase)) {
      const tier = tierOf(was.duration, phase.duration, durationTable)
      // ⚠ 2026-09-30 日志 63：这一格要**先看这个技能的覆盖**（`bySkill`），
      //   再看共享的四格默认 —— 和查表那条路用的是同一个取值函数
      //   （`tierPointsForSkill`）。这里若还用 `tierPointsOf`，
      //   "给某个技能填了覆盖"就只对**装了点表**的账生效，老公式那条路看不到。
      const tierPoints = tier === undefined
        ? undefined
        : tierPointsForSkill(durationTable, tier, base.id)
      if (tierPoints !== undefined) {
        /*
         * ⚠ 这里用的是**没取过整**的段价（`pricePhase` 本身），不是 `e.points`：
         *   两条路用的是**同一个表达式**（`durationTermOf` 就是 `pricePhase`
         *   里那一项），所以"减掉自己再加回来"是**逐位精确**的，不会因为
         *   `round` 的 ±0.005 在整数化那一步翻出 ±1 点。
         */
        points = pricePhase(phase, R) - durationTermOf(phase, R)
          + durationTermOf(was, R) + tierPoints
      }
    }
    // ② 能量这条轴进 0 档（这一段不花能量了，出厂花过）——
    //    它是**这一段自己的代价**，所以记在这一段上（不另起一行）
    if ((was?.cost?.energy ?? 0) > 0 && (phase.cost?.energy ?? 0) === 0) {
      points += zeroTierValue('energy', energyAxisPoints((was as Phase).cost?.energy ?? 0, R), R)
    }
    // ③ 冷却这条轴进 0 档：它是**技能的唯一属性**，记在 `cdPhase` 那一段上
    if (cdZero && cdPhase !== undefined && phase.id === cdPhase.id) {
      points += zeroTierValue('cooldown', cooldownAxisPoints(baseCd, R), R)
    }

    /*
     * ⚠ `points === 0` 也**可能**要留下 —— 见下面的 `|| keep`：
     *   冷却的 0 档要挂到 `cdPhase` 上，而它自己那一段的相对账可能正好是 0
     *   （出厂就写在这段上：3 秒没了、−3 秒也没了）。
     *   不留一个"落脚点"的话，那一笔 `−K × 8 × 汇率` 会**无处可挂、静默消失**。
     *
     * ⚠ 那一行的 `label` 也必须改口：它现在装的是**两件事**
     *   （这一段的时长 ± 技能唯一那份冷却被取消），
     *   照原样印出来就是一个误导（账上写着 −88，而那一行看起来只是"一段 0.2 秒"）。
     *
     * ⚠⚠ **一条 0 档记录必须和"同一段别的代价"合成一条**（下一个人一定会踩）：
     *   账是按 `entryKey`（= `phase:<段 id>`）认身份的，所以本函数**只往
     *   `absoluteEntries` 已经产出的那些行上加数**（`out.push({ ...e, points })`），
     *   **绝不另起一条同 `refId` 的记录**。另起一条的后果是两条记录撞在同一个 key 上：
     *   下面 `skillLedger` 相减时只会命中其中一条，另一条**静默丢掉**（或者相减两次），
     *   账面会出现一笔谁也没做过的交易 —— 和"按下标认规则"是同一个病的两种形态。
     */
    const keep = cdZero && cdPhase !== undefined && phase.id === cdPhase.id
    if (points !== 0 || keep) {
      out.push({
        ...e,
        points: round(points),
        ...(keep ? { label: `${e.label} · 冷却（0 档 · 无冷却）` } : {}),
      })
    }
  }

  /*
   * ---- 出厂有、现在没了的那几段（删段 = 0 档的极限形态）----
   *
   * ⚠ **不能靠"出厂那张绝对账"来报"（删掉）"**：
   *   删掉一段的同时也把它的代价（能量、冷却）删掉了，而"删掉"那条记录
   *   用的会是**出厂那一刻的绝对值**，于是 0 档该拿的那笔 K 一起没了。
   *   所以这里替每一段"出厂有、现在没有"的段补一条 0 档记录。
   *
   * ⚠⚠ **删整段时三笔 0 档都要补**（时长 / 能量 / 冷却），少一笔就是白送
   *   （段都没了，那笔收益自然也没人提）。实测踩到过：只补时长那一笔时，
   *   一段带 8 秒冷却的段被删，账上从 −88 掉到 −10 —— **静默少了 78 点**。
   *
   * ⚠ 冷却那一笔**只在 `!cdZero` 时补**，而且它"该记在哪一段"由上面的
   *   `cdPhase` 决定：`cdZero` 为真 ⇒ 已经记在**现在的第一段**上了
   *   （**必须退到第一段**：扛着冷却的那一段被删了，0 档不能跟着一起消失）。
   */
  for (const was of base.phases) {
    if (cur.phases.some(p => p.id === was.id)) continue
    if (!(was.duration > 0)) continue
    /*
     * ⚠ **时长那一笔是查出来的**（2026-09-30 日志 59）：删掉一整段 = **0 档的极限形态**，
     *   所以它拿的是表里 0 档那个整数，**不再**是 `−(K+1) × 出厂时长 × 汇率`。
     *
     * ⚠ 为什么是 `出厂那一项 + 表[0]`（而不是只有表[0]）：
     *   这一条记录是"**现在**那一头"的值，而 `skillLedger` 会拿它减掉出厂那一头
     *   （出厂那一头含着自己的时间那一项）。所以：
     *
     *      账上那一行 = (出厂那一项 + 表[0]) − 出厂整段价 = 表[0] − 这一段别的代价
     *
     *   ⇒ "删掉这一段"和"把它的时长拖成 0"拿到的是**同一笔**（0 档），
     *     一个例外都没有 —— 这正是这一条存在的理由。
     */
    const durationTable = tierTableOf(o, TIER_TABLE_PHASE_DURATION)
    // ⚠ 0 档这一笔同样**先看这个技能的覆盖**（日志 63，理由同上面那一段）
    let points = durationTermOf(was, R) + (tierPointsForSkill(durationTable, 0, base.id) ?? 0)
    if ((was.cost?.energy ?? 0) > 0) {
      points += zeroTierValue('energy', energyAxisPoints(was.cost?.energy ?? 0, R), R)
    }
    /*
     * ⚠ 冷却的 0 档**只在"扛着它的那一段被删了、而技能级那条判据没轮到"时**才在这里补，
     *   否则就是同一笔钱收两次（冷却是技能唯一的属性，全技能只该有一笔）：
     *     · `cdZero` 为真 ⇒ 已经记在 `cdPhase` 那一段上了，这里一个字都不加
     *     · `cdZero` 为假 ⇒ 说明现在还有别的段扛着冷却，这一段被删只是"少了一份冷却"
     */
    if (!cdZero && (was.cost?.cooldown ?? 0) > 0) {
      points += zeroTierValue('cooldown', cooldownAxisPoints(was.cost?.cooldown ?? 0, R), R)
    }
    if (points === 0) continue
    out.push({
      label: `阶段「${was.name ?? was.id}」（删掉这一段）`,
      points: round(points),
      from: 'phase',
      refId: was.id,
      path: `phases[${was.id}].points`,
    })
  }

  return out
}

/**
 * 算一个技能**相对出厂值**的账 —— **玩家真正要看的那个数**。
 *
 * ## ⚠⚠ 2026-09-30（日志 60b）：账现在是**查表 + 相加**
 *
 * 用户规格：一个技能的所有变量的取值对应点数的**和**就是它的点数。
 * 所以**装了表的时候**（`o.lookupTable`，见 `PriceOptions`）这个函数
 * **不是**在做"两条账相减"，而是：
 *
 *     各变量现在选中的值 → 各查一格 → **纯相加**（`lookupEntriesOf`）
 *
 * 下面那一大段"逐条相减"的描述是**没装表的老路**（合成探针 / 还没进表的技能），
 * 留着是因为它对那一条路**仍然逐字正确**。⚠ 两条路的出口形状完全一样
 * （`PriceResult`），但数的来源完全不同 —— 下一个人别把两段说明读混。
 *
 * ⚠ **为什么"出厂技能恒 0"在新路上照样成立**：表里**出厂值那一格恒等于 0**
 *   （60a 逐格实测 377 格全 0），而每份技能的每一个变量取的都是出厂值
 *   ⇒ 加起来的每一项都是 0。
 *
 * 逐条相减（按 `entryKey` 认身份，不按下标）：
 *
 *     改了伤害 25 → 50        → 一条"-0.9"（多花的）
 *     加了第 5 条规则          → 一条"（新增）"
 *     删了原来那条规则        → 一条"（删掉）"，符号翻过来
 *     把冷却 2 秒 → 20 秒      → 一条"+3.6"（赚到的额度）
 *
 * 出厂技能自己减自己 = **空账**（这是宗旨的机械表述，`tests/pricing.ts` 盯着它）。
 * ⚠ **一个例外都没有**：曾经有过一个 `factoryDebt`（"出厂就负债的零件"）
 *   让少数技能从绝对账起算，2026-09-21 删掉了 —— 理由见 `Skill` 里那段墓碑注释。
 *
 * ## ⚠ 阶段时长这条轴走 `ledgerPrice`，不走"两条绝对账相减"
 *
 * 因为**只有档位轴需要知道"出厂是多少"**：
 *
 * | 情形 | 公式 | 横砍后摇（D = 0.2） |
 * | --- | --- | --- |
 * | 时长改了（1× → 3×） | `Δ值 × 汇率` | 0.6 × 0.863 = **+0.35** |
 * | 时长被取消（1× → **0 档**） | `−(K + 1) × D × 汇率` | −10 × 0.2 × 0.863 = **−1.73** |
 * | 段被删了（0 档的极限） | 同上 | 同上 |
 *
 * ⚠ **为什么 0 档是 `−(K + 1) × D × 汇率` 而不是 `−K × D × 汇率`**：
 *   "现在"那一头不是 0，是 `−K × D × 汇率`（0 档的价，见 `zeroTierValue`）；
 *   "出厂"那一头是 `+D × 汇率`。两者相减 = `−(K + 1) × D × 汇率`。
 *   ⇒ 一条 0 档的**净额**正好是"9× 档那笔额度"（`+K × D × 汇率`）
 *     加上"1× 档那笔额度"（`+D × 汇率`）——也就是**两头都拿满**，
 *     因为取消一段同时拿到"不用等了"和"不用付代价的时长"两样。
 *   ⚠ 定稿 §12.5 那张表里的 **−2.33** 是**现在那一头**（0 档的价），
 *     不是净额；玩家在账上看到的是这里的净额。两者差一个 1× 档，
 *     这个差在实现里错一次**没有任何地方会报警**，所以写在这里。
 *
 * ⚠ **普通轴**（伤害、能量、冷却、状态……）一条都没动：出厂值两头都在，
 *   相减就是"改动量"。玩家 2026-09-21 亲自纠正过这一点
 *   （`docs/standard-values-draft.md` §十四：「绝对式本来就对，相减之后各自为 0」）。
 *
 * ⚠ 两边都按同一个 `o` 算。传两套汇率的话，"相减"就不再是
 *   "改动量"，而是两个不同标尺下的数相减 —— 那种 bug 的值看起来很正常。
 */
export function skillLedger(cur: Skill, base: Skill, o: PriceOptions): PriceResult {
  /*
   * ⚠⚠ ---- **查表 + 相加**：用户 2026-09-30 定的规格（日志 60b）----
   *
   *   一个技能的所有变量的取值对应点数的**和**就是它的点数。
   *   ⇒ `lookupEntriesOf` 把每一格查出来，这里只做一件事：**加起来**。
   *     不取整（表里本来就是整数）、不设地板（"至少 1 点"已经删）、
   *     不相减（出厂那一格恒 0）。
   *
   *   ⚠ 分区按 **`base`（基础技能）** 取：变体（`basedOn`）对着它的模板查，
   *     取值从 `cur` 读 —— "变体 = 模板 + 我的选择"。
   *   ⚠ 表里没有这个分区（合成探针 / 还没进表的技能）⇒ 落到下面老公式路。
   *     真内容不会有这个情形：表覆盖 32 份技能，第 ③ 条校验盯着它。
   */
  if (o.lookupTable !== undefined && o.lookupTable[base.id] !== undefined) {
    /*
     * ⚠⚠ 2026-09-30（日志 63）：`o` 必须**传下去** ——
     *   查表那条路里，阶段时长要**先问倍数档那张表**（`phaseDurationTierPriceOf`），
     *   问不出来才落到绝对秒数那一格。不传 `o` 的话四档又只剩"表里恰好好有那一格"
     *   的那几个技能有价，也就是 3× 16/58、9× 0/58 的老毛病。
     */
    const entries = lookupEntriesOf(cur, base, o.lookupTable, o)
    // ⚠ 合计**就是从各条加出来的**：不另取一次整（见 `integerPointsOf` 的墓碑注释）
    const total = entries.reduce((s, e) => s + e.points, 0)
    return { entries, total, kind: kindOf(total) }
  }

  const now = ledgerEntries(cur, base, o)
  const was = absoluteEntries(base, o)
  const wasByKey = new Map(was.map(e => [entryKey(e), e]))
  const nowKeys = new Set(now.map(entryKey))

  const entries: PriceEntry[] = []
  for (const e of now) {
    const before = wasByKey.get(entryKey(e))
    const points = round(e.points - (before?.points ?? 0))
    if (points === 0) continue
    entries.push(before === undefined
      ? { ...e, points, label: `${e.label}（新增）` }
      : { ...e, points })
  }
  // 出厂版本里有、现在没了 → 删掉了。符号翻过来：删掉一条收益 = 赚回额度。
  for (const e of was) {
    if (nowKeys.has(entryKey(e))) continue
    const points = round(-e.points)
    if (points === 0) continue
    entries.push({ ...e, points, label: `${e.label}（删掉）` })
  }

  /*
   * ⚠ **出口处统一整数化**（2026-09-30 日志 57）。
   *
   *   两头（`now` / `was`）本来就已经是整数了，所以这一步**平常是个空操作**；
   *   它不是空操作的地方只有一处：阶段/能量/冷却的 **0 档**那一笔
   *   （`zeroTierValue`）是按 `−(K+1) × 那一段自己的价` 算出来的，
   *   而"那一段自己的价"可以是小数（能量的 0 档尤其明显）。
   *   ⇒ 那一笔不在这里再收一次，账上就又会冒出小数条目。
   *
   *   ⚠ 顺序很讲究：**先相加、再整数化**。反过来（每条先整数化再相加）
   *     就是那个"条目加起来对不上合计"的老坑。
   */
  const ints = integerizeEntries(entries)
  const total = ints.reduce((s, e) => s + e.points, 0)
  return { entries: ints, total, kind: kindOf(total) }
}

/**
 * 算一个**术式**的点数账 —— **配平的判据在这里**。
 *
 * 术式自己不带效果，所以它的账 = 它引用的每个技能**相对它的基础技能**的偏离之和。
 *
 * ⚠ `lookup` 要给**合并后的技能表**（基础技能库 + 自定义技能库）——
 *   玩家 2026-09-21 定的模型是"**两个库**"，术式按 id 引用技能，
 *   两个库都能引用。所以这里**不需要**任何"这份术式自己的副本"参数。
 *
 * ⚠ **变体（`basedOn`）的账对着它的基础技能算**，不是对着上一份变体：
 *   账永远是"偏离出厂版多少"（宗旨：默认值下配平为 0）。
 *   于是**同一个变体改一次，所有用到它的术式一起变** —— 这正是玩家要的
 *   "技能不是独属于一个术式的，应该影响所有用到它的术式"。
 *
 * ⚠ 基础技能（没有 `basedOn`）自己减自己 = **0 点**，所以出厂内容全是 0。
 *
 * ⚠ 每一行都打上 `skillId`：编辑器按段分组显示，玩家才知道该改哪一段。
 *
 * ⚠ 找不到的技能**直接跳过**，不让它变成一条 0 点的记录 ——
 *   一条 0 点的记录会让玩家以为那段没花钱，而事实是那段根本不存在。
 *   引用是否有效由编译期负责报错（`compileTechnique`），这里不重复管。
 */
export function priceTechnique(
  tech: Technique,
  lookup: (id: string) => Skill | undefined,
  o: PriceOptions,
): PriceResult {
  /*
   * ⚠⚠ ---- **账按武器 / 魔法分开算**（2026-10-06 日志 64）----
   *
   * 用户定的规矩，判据**只有一处**：`school.ts` 的 `techniquePaysPoints`
   * （读 `kind`，也就是 `deriveTechniqueKind` 那个系别结论）。
   *
   *   · **武器术式** ⇒ 这里直接返回**一本空账**（0 点、0 条明细）。
   *     为什么不是"算出来但不显示"：它的数字来自**武器本身**，
   *     定价器看不见那把武器 ⇒ 算出来的是**猜**的。
   *   · **魔法术式** ⇒ 照常往下算（常驻 / 主动都算）。
   *
   * ⚠⚠ **空账 ≠ "0 点免费"** —— 这两个东西的**合计**都是 0，但含义相反：
   *   "0 点"是**真的算过**、账刚好平（出厂技能的相对账就是 0）；
   *   "不算账"是**根本没有这本账**，它的强度体现在**装到哪把武器上**。
   *   所以界面上那一块必须**说出来**（校验器的 `priceless`、编辑器账卡上的
   *   那一句判语），否则"不算账"会被读成"白送"。
   *
   * ⚠ 这也修掉了一处**看得见的错**（就是这一片要修的东西）：
   *   `priceTechnique` 以前**只读 `tech.skills`**、不看系别，于是
   *   一份武器术式只要挂了「份数 / 等待」这类**段上的修饰**，编辑器那本账
   *   就会当场算出一个负值（实测：多重释放 ×10 ⇒ **−18 点**，见日志 64 的报告），
   *   而校验器同时说它"不算账" —— 同一份术式两本账，而且**两边都不报错**。
   */
  if (!techniquePaysPoints(tech)) return { entries: [], total: 0, kind: 'normal' }

  const entries: PriceEntry[] = []

  /*
   * ⚠⚠ ---- **第二层：账再按「序列」切**（2026-10-06 日志 65）----
   *
   * 定稿第十二节那张**三段式表**：
   *
   *   | 术式               | 合计                        | 血契 |
   *   | 纯主动（只有主动） | 可以为负 ✓                  | 能吃 ✓ |
   *   | 纯常驻（只有常驻） | 不能为负 ✗；为正 → 警告 ✓   | 不能吃 ✗ |
   *   | 混合（两种都有）   | **只有常驻那半边受约束**：常驻 ≥ 0；主动照旧可为负 | 能吃 ✓：`max(0, −主动和)` |
   *
   * ## ⚠ 它和**上面那一层**（武器 / 魔法）是**两层**，不是同一条规矩
   *
   *   第 64 片（`techniquePaysPoints`）切的是**术式的系别**：
   *     **武器术式 ⇒ 这里已经返回空账了**（上面那一行），根本走不到下面；
   *     **魔法术式 ⇒ 才轮到本片这一层**（按序列切）。
   *   ⇒ 所以这一层**只对魔法术式生效**，而且它**不动**上面那一层的结论
   *     （武器术式照旧"不算账"，一个字都没变 ✗）。
   *
   * ## ⚠ 判据复用 `school.ts`：**不新写第二份**
   *
   *   · "这一段是不是常驻序列" ⇒ `isConstantSequence`（= `hasConstantWrapper`，
   *     和 `sim/compile.ts` 的 `constantSegments`、校验器那条
   *     "被包装的段只能在 press 术式里"读的是**同一句**：`at === 0` 的 `wrap` 副本）。
   *   · ⚠ 拿不到原型表（`o.modifiers === undefined`）时**一个都认不出来** ⇒
   *     **整本账落进主动那半**。这是**故意的**：那种情形下
   *     `modifierPointsOf` 本来就"一笔都不记"（份数 / 等待都算不出来），
   *     而"认不出常驻"的**安全方向**是"按主动算"—— 若按常驻算，（A）会把
   *     这本账的血契从"有"变成"没有"，那是**白送**（静默地少收钱）。
   */
  const protos = o.modifiers
  /** 第 j 段是不是常驻序列（被包装）—— 和 `hasConstantWrapper` 同一句 */
  const constantFlags: boolean[] = (tech.sequences ?? []).map(seg =>
    typeof seg === 'string' ? false : isConstantSequence(seg, protos))

  /*
   * ⚠ 2026-10-06（日志 66）：**"这一笔在哪一半"记在明细自己身上**
   *   （`PriceEntry.half`），不再另存一份"哪些下标是常驻"的名单 ——
   *   两份东西分头走迟早对不上，而界面要读的正是明细上那个字段。
   */

  /*
   * ⚠ `?? []` 不是防御性编程，是**序列术式**（只挂 `sequences` 的术式）的
   *   正常形状 —— 武器术式基本都长这样，它自己一个技能都不带。
   *
   *   它的账**就是空的**，这是对的：序列本身就是一段完整的术式，
   *   已经各自记过账了（校验器会逐个报），在这里再累加一遍会把同一笔钱算两次。
   */
  for (const skillId of tech.skills ?? []) {
    const cur = lookup(skillId)
    if (cur === undefined) continue
    // 变体的账对着它的**基础技能**算；基础技能自己对着自己算 = 0
    const base = cur.basedOn === undefined ? cur : lookup(cur.basedOn)
    if (base === undefined) continue
    const r = skillLedger(cur, base, o)
    for (const e of r.entries) {
      entries.push({
        ...e,
        label: `${cur.name} · ${e.label}`,
        path: `${skillId}.${e.path}`,
        skillId,
        /*
         * ⚠ **技能那一层算主动那半**：技能挂在**术式那一层**，
         *   而术式那一层是玩家**按那个键**才走到的
         *   （和 `allSequencesAreConstant` 那条注释是同一句话）。
         */
        half: 'active',
      })
    }
  }

  /*
   * ⚠ ---- **份数类修饰（多重释放 / 一分为 X）也要进账** ----
   *
   *   它们挂在**段**上（`sequences[j].mods`），而段是"这条术式"的一部分 ——
   *   所以这笔钱记在术式账上。不进账的话，账面上"一次打 10 个"
   *   看起来是白送的，而这正是"未计价"和"免费"分不清的那个坑。
   *
   *   ⚠ 出厂内容里**一个副本都没有**，所以这一行对今天所有出厂账
   *     **一个数都不改**（`npm run calibrate` 逐行不变的根据之一）。
   *
   *   ⚠ 本片**不改它一个数**：只把"这一笔算在哪一半"记下来
   *     （它自己带着 `段号` ⇒ `path` 就是 `sequences[j].mods[...]`）。
   */
  for (const e of modifierPointsOf(tech, o, lookup)) {
    const segIndex = segmentIndexOfEntryPath(e.path)
    /*
     * ⚠ 认不出段号（技能那一层的 `path` 认不出来）或那一段不是常驻 ⇒ **按主动算**。
     *   这是**安全方向**：按常驻算的话，裁定 (A) 会把血契从"有"变成"没有"（白送）。
     */
    const passive = segIndex !== undefined && constantFlags[segIndex] === true
    entries.push({ ...e, half: passive ? 'passive' : 'active' })
  }

  /*
   * ⚠ **出口处统一整数化**（2026-09-30 日志 57）：技能账那几段本来就是整数，
   *   而 `modifierPointsOf` 交上来的那一批可以是小数
   *   （等待 / 排布 / 追踪都按"参数 × 汇率"算）。一次整数化把整本术式账
   *   收成整数，**合计仍然等于各条之和**。
   *
   *   ⚠ 它**保序**（见 `integerizeEntries`），而且**原样带着 `half`**，
   *     所以"这一笔在哪一半"整数化之后照样说得出来。
   */
  const ints = integerizeEntries(entries)
  const total = ints.reduce((s, e) => s + e.points, 0)

  /*
   * ---- 裁定 (A)：两半**完全切开** ----
   *
   *   血契 = `max(0, −主动和)` —— **常驻那半的正额度不补贴主动**。
   *   ⚠ 切分**只是分类**，一个数都不改：`activePoints + passivePoints === total`
   *     是**构造出来的**（两半就是同一批整数条目分开加的），
   *     所以出厂全 0 / `calibrate` / `duel` 的输出都不动。
   *
   * ⚠ 判据**只有 `half` 那一栏**（上面逐条填的那个）—— 汇总和界面不可能不一致；
   *   两边各判一次的话，症状正是本片修的那类："界面按 A 显示、引擎按 B 扣"。
   */
  let activePoints = 0
  let passivePoints = 0
  for (const e of ints) {
    if (e.half === 'passive') passivePoints += e.points
    else activePoints += e.points
  }
  const threeSection: ThreeSection = {
    activePoints,
    passivePoints,
    bloodPact: activePoints < 0 ? Math.abs(activePoints) : 0,
    total,
  }

  return { entries: ints, total, kind: kindOf(total), threeSection }
}

/**
 * 从一条明细的 `path` 里取出**段号**（`sequences[j]...` ⇒ `j`）。
 *
 * ⚠ 为什么读 `path` 而不是让 `modifierPointsOf` 多返回一个字段：
 *   那条 `path` 是**给玩家看的定位**（"第 j 段第几个零件"），
 *   它本来就是段号的唯一来源；另开一个字段就有了**两份段号**，
 *   而两份迟早漂移（表现是"账算在第 1 段、界面指到第 2 段"，无声）。
 *
 * ⚠ 认不出来返回 `undefined`（调用方按"主动"处理 —— 见 `priceTechnique` 里
 *   那条"认不出的安全方向"）。技能那一条 `path` 是 `<skillId>.…`，
 *   它**永远**认不出来，那是对的：技能挂在术式那一层，不属于任何一条序列。
 */
function segmentIndexOfEntryPath(path: string): number | undefined {
  const m = /^sequences\[(\d+)\]/.exec(path)
  if (m === null) return undefined
  const n = Number(m[1])
  return Number.isInteger(n) ? n : undefined
}

/**
 * 一个技能里**所有**动作的载体（`delivery.kind`）—— 判"这个零件对它起不起作用"用。
 *
 * ⚠ 走 `allRulesOf(skill)` 而不是 `skill.rules`：
 *   **固有效果**（`Skill.effect`）编译时会被折成一条 `phaseComplete` 规则
 *   （`effects.ts`），只读 `skill.rules` 会漏掉它 —— 而"这个技能会不会飞"
 *   恰恰经常写在固有效果上（魔法飞弹就是）。
 *   ⚠ 这条定律 README 里写着："**'这个技能会做什么'只有 `allRulesOf()` 一个入口**"。
 *
 * ⚠ 返回值里可能有重复（好几条动作同一个载体）—— 调用方只 `.some()`，
 *   不关心重复，所以这里不去重（少一次 Set 分配）。
 */
function deliveryKindsOf(skill: Skill): string[] {
  const out: string[] = []
  for (const rule of allRulesOf(skill)) {
    for (const action of rule.then ?? []) {
      const kind = action.delivery?.kind
      if (typeof kind === 'string') out.push(kind)
    }
  }
  return out
}

/**
 * **修饰零件的点数** —— 份数类（多重释放 / 一分为 X，2026-09-21 日志 51）
 * 与等待类（等待 X 秒，2026-09-30 日志 52）。
 *
 * ⚠ 它**只算段里的副本**（`tech.sequences[].mods`）：副本住在段上，
 *   而段就是"这条术式"的一部分 —— 所以这笔钱记在**术式**的账上
 *   （`from: 'technique'`），不是技能身上（技能不算这个账：
 *   同一个技能前面放不放「多重释放」是**术式**的事，见 schema 的 `SegmentMod`）。
 *
 * ## 两类零件各一把尺
 *
 * | 零件 | 收什么 | 汇率 |
 * | --- | --- | --- |
 * | 多重释放 / 一分为 X | **多出来的份数**（N − 1 / X − 1） | `modifierRates.extraCopyPerPoint` |
 * | 等待 X 秒 | **秒数**（越长越亏 ⇒ 提供额度 ⇒ 正点数） | `modifierRates.waitSecondPerPoint` |
 *
 * ⚠ 符号是反的（份数 = 消耗额度 = 负、等待 = 提供额度 = 正），
 *   这不是笔误：多打一份是**好处**，空出一段时间是**代价**（玩家定稿 §八 ③）。
 *
 * ## 份数：收"多出来的份数"
 *
 * ⚠ 账跟的是**引擎实际会打出的份数**（`modifierCountOf` 夹过之后的那个数）——
 *   两个数必须是同一个，否则"账上收 1 份、打出 2 份"会同时成立。
 *   份数 1 在数据上不该存在（校验器对 `count < 2` 报错），
 *   而真出现时引擎会夹到 2、账也按 2 收（夹的动作编译期会报一条问题）。
 *
 * ⚠ **叠加**（同一个技能前面同时放着两个）的算法见日志 51 的裁定：
 *   一分为 X 先把它掰成 X 份，多重释放再把**另外** N−1 个不同的技能带上
 *   ⇒ 一共 `X + N − 1` 份，点数据此收（多出来的是 `X + N − 2` 份）。
 *   ⚠ 不是 `N × X`：A 在"N 个不同技能"里已经算过一份了，
 *     相乘会把同一个技能数两遍（理由写在日志 51 里）。
 *
 * ## 等待：收"秒数"，而且**只收这一笔**
 *
 * ⚠ 等待阶段的价在 `pricePhase` 里是 **0**（见那里的注释）——
 *   两处各收一遍就是同一件事收两次钱，而且两次的汇率各自可调，账面会自相矛盾。
 */
function modifierPointsOf(
  tech: Technique,
  o: PriceOptions,
  lookup: (id: string) => Skill | undefined,
): PriceEntry[] {
  const protos = o.modifiers
  if (protos === undefined) return []

  const rate = o.modifierRates?.[MODIFIER_EXTRA_COPY_KEY]
    ?? DEFAULT_MODIFIER_RATES[MODIFIER_EXTRA_COPY_KEY] ?? 0
  const stackPenalty = o.modifierRates?.[MODIFIER_STACK_PENALTY_KEY]
    ?? DEFAULT_MODIFIER_RATES[MODIFIER_STACK_PENALTY_KEY] ?? 0
  const out: PriceEntry[] = []

  const seqs = tech.sequences ?? []
  for (let j = 0; j < seqs.length; j++) {
    const seg = seqs[j]
    // 老形状（字符串 id 引用另一份术式）不带副本 —— 那些副本住在**那一份**术式里，账也算在那儿
    if (seg === undefined || typeof seg === 'string') continue
    const mods = seg.mods ?? []
    if (mods.length === 0) continue

    /** 两个份数修饰是不是**盯上了同一个技能**（`at` 相同 ⇒ 那条叠加规则才成立） */
    const multiAts: number[] = []
    const splitAts: number[] = []

    for (const mod of mods) {
      const proto = protos.get(mod.proto)
      if (proto === undefined) continue

      /*
       * ⚠ ---- **「等待 X 秒」的那一笔**（2026-09-30 日志 52）----
       *
       *   玩家给的规矩：**点数按秒数算**、越长越亏 ⇒ **提供额度**（正点数）。
       *   汇率从 `balance.json` 的 `modifierRates.waitSecondPerPoint` 读
       *   —— **不许写死**（写死之后调平衡就得改代码，而这是内容侧的旋钮）。
       *
       *   ⚠ 秒数取**夹过之后**的那个（`modifierSecondsOf`）：账和引擎必须是同一个数，
       *     否则"账上按 30 秒收、引擎只等 3 秒"会同时成立（份数那边有同一条规矩）。
       *
       *   ⚠ 这一笔**和 `pricePhase` 是分工的**：等待阶段的价在那里是 **0**
       *     （见那段注释）—— 所以这里就是**唯一**一笔，不会收两次。
       *     这也是为什么这个 `if` 放在遍历里、而不是另开一趟：
       *     和份数那两种修饰并列成"一个零件一笔账"（编辑器要按零件分组显示）。
       */
      if (proto.kind === 'wait') {
        const { seconds } = modifierSecondsOf(mod, proto)
        const perSecond = o.modifierRates?.[MODIFIER_WAIT_SECOND_KEY]
          ?? DEFAULT_MODIFIER_RATES[MODIFIER_WAIT_SECOND_KEY] ?? 0
        out.push({
          label: `修饰「${proto.name}」· 空出 ${formatSeconds(seconds)}`,
          points: round(seconds * perSecond),
          from: 'technique',
          refId: `mod:${mod.proto}@${String(mod.at)}`,
          path: `sequences[${j}].mods[${String(mods.indexOf(mod))}]`,
        })
        continue
      }

      /*
       * ⚠ ---- **「排布」的那一笔**（2026-09-30 日志 53）----
       *
       *   玩家给的规矩：它是一份**好处**（把已经存在的那几份摆得更好用）⇒ **花额度**
       *   （负点数，和份数类同一个方向、和等待相反）。
       *   "点数随类型与参数变"这一条由**公式**兑现：
       *     底价（装上这个零件）+ 半径 × 每米 + 张角 × 每度。
       *   三档的差价全在参数里（环绕有半径、散射有张角、镜像有偏移角），
       *   所以不需要为每一档单开一条汇率 —— 理由写在 `DEFAULT_MODIFIER_RATES` 那三项。
       *
       *   ⚠⚠ **它和份数那一笔是两件事**（玩家划的硬界线第一条）：
       *     这里收的是"**同样这几份**摆得更好用"的钱，**不是**"多来一份"的钱 ——
       *     份数那一笔由 `multi` / `split` 单独记。所以排布那笔**不读 `count`**，
       *     也不会因为份数变多而变贵（份数多的时候摆得更好用，那是份数自己的账）。
       *
       *   ⚠ 参数取**夹过之后**的值（`school.ts` 的 `modifierLayout*Of`）：
       *     账和引擎必须是同一个数，否则"账上按 99 米收、引擎只摆 6 米"会同时成立
       *     （份数和等待那两条有同一条规矩）。
       *
       *   ⚠ 摆法**认不出来**时一笔都不记（和"不传原型表就不记"同一条纪律）：
       *     引擎那一侧整块不生效，账上也就没有东西可收 ——
       *     而"写了不生效"由校验器报 `MODIFIER_LAYOUT_BAD_TYPE`，不靠账本出声。
       */
      if (proto.kind === 'layout') {
        const mode = modifierLayoutModeOf(mod, proto)
        if (mode === undefined) continue
        const base = o.modifierRates?.[MODIFIER_LAYOUT_BASE_KEY]
          ?? DEFAULT_MODIFIER_RATES[MODIFIER_LAYOUT_BASE_KEY] ?? 0
        const perMeter = o.modifierRates?.[MODIFIER_LAYOUT_METER_KEY]
          ?? DEFAULT_MODIFIER_RATES[MODIFIER_LAYOUT_METER_KEY] ?? 0
        const perDegree = o.modifierRates?.[MODIFIER_LAYOUT_DEGREE_KEY]
          ?? DEFAULT_MODIFIER_RATES[MODIFIER_LAYOUT_DEGREE_KEY] ?? 0
        const radius = modifierLayoutRadiusOf(mod, proto).radius
        const spread = modifierLayoutSpreadOf(mod, proto)
        const start = modifierLayoutStartAngleOf(mod, proto)
        const mirror = modifierLayoutMirrorAngleOf(mod, proto)
        /*
         * ⚠ ---- **哪几个参数真的参与了这一档的价**（按摆法取，不是三个都收）----
         *
         *   三档各自买的参数是**不同的**（玩家把参数分成三组）：
         *     `ring`   ⇒ 半径（米）+ 起始角（度）
         *     `fan`    ⇒ 张角（度）
         *     `mirror` ⇒ 镜像偏移角（度）
         *   ⚠ 三个都收的话，"环绕"会为它**用不到的张角**付钱
         *     （而那个张角只是原型上的默认值 60）—— 那是同一件事收两次钱的翻版。
         *   ⚠ 而"有多极端"取这一档**真的用到的那几个角**里绝对值最大的一个：
         *     镜像是唯一同时用到米和度的档（`radius` 在缩放那一半），
         *     所以它的两个分量分开算。
         */
        const looseness = mode === 'ring'
          ? Math.abs(start) * perDegree
          : mode === 'fan'
            ? spread * perDegree
            : Math.abs(mirror) * perDegree
        const meters = (mode === 'ring' || mode === 'mirror') ? radius * perMeter : 0
        const points = base + meters + looseness
        out.push({
          label: `修饰「${proto.name}」· ${LAYOUT_MODE_LABELS[mode] ?? mode}`,
          points: -round(points),
          from: 'technique',
          refId: `mod:${mod.proto}@${String(mod.at)}`,
          path: `sequences[${j}].mods[${String(mods.indexOf(mod))}]`,
        })
        continue
      }

      /*
       * ⚠ ---- **「追踪」的那一笔**（2026-09-30 日志 56）----
       *
       *   玩家给的定位：它是**让这一发更容易打中**的机制（"自己找敌人"）
       *   ⇒ 和排布一样是一份**好处** ⇒ **花额度**（负点数，和份数类同一个方向、
       *   和等待相反）。
       *
       *   "点数随参数变"由**公式**兑现：底价（装上这个零件）
       *   + 搜索距离 × 每米 + 转速 × 每度。
       *   ⚠ 两个参数**各自可调**，所以是**两条独立的增量**，不是一条 ——
       *     理由和排布那三条一样（合成一条就调不了"只让看更远变得更贵"）。
       *
       *   ⚠ 参数取**夹过之后**的值（`school.ts` 的 `modifierHoming*Of`）：
       *     账和引擎必须是同一个数，否则"账上按 9999 米收、引擎只追 16 米"
       *     会同时成立（份数 / 等待 / 排布那三条有同一条规矩）。
       *
       *   ⚠⚠ **它一点都不看"这一发是什么载体"**：账**照收**，哪怕那个技能
       *     是个激光（非飞行载体，引擎那一侧"什么都不做"）。
       *     理由：账算的是"**你往这条序列里放了一个什么零件**"，
       *     而"它对这条序列起不起作用"是**界面**要告诉玩家的事
       *     （画在那条序列下方）—— 两件事各有各的落点，不在这里合流。
       *     ⚠ 换句话说：**装错了照样花钱**，而"装错了"由界面说出来。
       */
      if (proto.kind === 'homing') {
        /*
         * ⚠⚠ **2026-09-30 玩家裁定（日志 56 第二版）：装错了不收钱。**
         *
         *   上面那段"照收"是这一片**第一版**写的，玩家把它否掉了，原话：
         *   "**花钱买了什么都不做** 比'没提示'更糟" ——
         *   ⇒ 非飞行载体（`beam` / `capsule` / `meleeArc` / `aura` / `area` / `self`）
         *     被「追踪」修饰时：**引擎什么都不做**、**账上一分钱都不收**、
         *     而校验器报一条**警告**让人看见（"不起作用"是设计允许的，不是错误）。
         *
         *   ⚠⚠ 判据**只有一处**：`school.ts` 的 `carrierFliesInWorld(kind)` ——
         *     校验器和账本**读的是同一个函数**。两处各写一份的话，
         *     迟早出现"校验器说它不起作用、账本还在收钱"（或者反过来），
         *     而那正是本项目列为最危险的一类**静默不一致**。
         *
         *   ⚠ 找得到技能就按它**全部**动作（含 `Skill.effect`，走 `allRulesOf`）
         *     里的载体判；找不到技能（引用坏了）⇒ 不判、照收 ——
         *     引用坏了由编译期报错，账本不替它兜底（和 `modifierPointsOf`
         *     上面那条"找不到的技能直接跳过"同一条纪律）。
         */
        const targetSkillId = seg.skills[mod.at]
        const targetSkill = targetSkillId === undefined ? undefined : lookup(targetSkillId)
        if (targetSkill !== undefined) {
          const kinds = deliveryKindsOf(targetSkill)
          /*
           * ⚠ **"一个会飞的都没有"才免单**（不是"第一个不是飞行"就免）：
           *   一个技能可以有好几条动作（一发光弹 + 一记横扫），
           *   只要**有**一发会飞，这个零件就**真的在起作用** ⇒ 照收。
           */
          if (!kinds.some(k => carrierFliesInWorld(k))) continue
        }

        const base = o.modifierRates?.[MODIFIER_HOMING_BASE_KEY]
          ?? DEFAULT_MODIFIER_RATES[MODIFIER_HOMING_BASE_KEY] ?? 0
        const perMeter = o.modifierRates?.[MODIFIER_HOMING_METER_KEY]
          ?? DEFAULT_MODIFIER_RATES[MODIFIER_HOMING_METER_KEY] ?? 0
        const perDegree = o.modifierRates?.[MODIFIER_HOMING_DEGREE_KEY]
          ?? DEFAULT_MODIFIER_RATES[MODIFIER_HOMING_DEGREE_KEY] ?? 0
        const turnRate = modifierHomingTurnOf(mod, proto).turnRate
        const maxRange = modifierHomingRangeOf(mod, proto).maxRange
        const points = base + maxRange * perMeter + turnRate * perDegree
        out.push({
          label: `修饰「${proto.name}」· 每 tick 拐 ${String(turnRate)}°，索敌 ${String(maxRange)} 米`,
          points: -round(points),
          from: 'technique',
          refId: `mod:${mod.proto}@${String(mod.at)}`,
          path: `sequences[${j}].mods[${String(mods.indexOf(mod))}]`,
        })
        continue
      }

      /*
       * ---- 第 10 条：**「弹射」的账**（★ 2026-09-30 日志 58 新加的）----
       *
       *   和「追踪」那一条**逐字同源**，包括最要紧的那半：
       *   ⚠⚠ **装错了不收钱** —— 非飞行载体（激光那类）上装了它 ⇒ `continue`，
       *     一条明细都不记。判据是**同一个函数** `carrierFliesInWorld`
       *     （校验器那条警告读的也是它）—— 玩家原话：
       *     "**花钱买了什么都不做** 比'没提示'更糟"。
       *
       *   ⚠ 两个参数取**夹过之后**的值（`school.ts` 的 `modifierBounce*Of`）：
       *     账和引擎必须是同一个数 —— ⚠⚠ 尤其是**次数**：它的上限是引擎的
       *     深度上限（`MAX_ACTION_DEPTH`），所以账**不能**按数据写的
       *     `maxBouncesCap` 收钱（那会收出一个引擎给不出的东西）。
       */
      if (proto.kind === 'bounce') {
        const targetSkillIdB = seg.skills[mod.at]
        const targetSkillB = targetSkillIdB === undefined ? undefined : lookup(targetSkillIdB)
        if (targetSkillB !== undefined) {
          const kindsB = deliveryKindsOf(targetSkillB)
          // ⚠ 和追踪同一条：**"一个会飞的都没有"才免单**（只要有**一发**会飞，它就在起作用）
          if (!kindsB.some(k => carrierFliesInWorld(k))) continue
        }

        const base = o.modifierRates?.[MODIFIER_BOUNCE_BASE_KEY]
          ?? DEFAULT_MODIFIER_RATES[MODIFIER_BOUNCE_BASE_KEY] ?? 0
        const perBounce = o.modifierRates?.[MODIFIER_BOUNCE_TIMES_KEY]
          ?? DEFAULT_MODIFIER_RATES[MODIFIER_BOUNCE_TIMES_KEY] ?? 0
        const perFalloff = o.modifierRates?.[MODIFIER_BOUNCE_FALLOFF_RATE_KEY]
          ?? DEFAULT_MODIFIER_RATES[MODIFIER_BOUNCE_FALLOFF_RATE_KEY] ?? 0
        const maxBounces = modifierBounceCountOf(mod, proto).maxBounces
        const falloff = modifierBounceFalloffOf(mod, proto).damageFalloff
        /*
         * ⚠ 衰减那一项按"**离全衰减有多远**"收：`damageFalloff − 原型下限`。
         *   全衰减（下限那一档）⇒ 0 点；完全不衰减 ⇒ 0.9 × 汇率。
         *   这样"越不衰减越贵"是**单调**的，而且和"参数越极端越贵"同一把尺。
         */
        const falloffFloor = modifierBounceMinFalloffOf(proto)
        const points = base + maxBounces * perBounce + (falloff - falloffFloor) * perFalloff
        out.push({
          label: `修饰「${proto.name}」· 弹 ${String(maxBounces)} 次，每次 ×${String(falloff)}`,
          points: -round(points),
          from: 'technique',
          refId: `mod:${mod.proto}@${String(mod.at)}`,
          path: `sequences[${j}].mods[${String(mods.indexOf(mod))}]`,
        })
        continue
      }

      if (proto.kind !== 'multi' && proto.kind !== 'split') continue
      /*
       * ⚠ 一条一笔地记（两个动词分开报），而不是合成一笔：
       *   编辑器要把账按"我拖进来的那个零件"分组显示 ——
       *   合成一笔的话玩家看到的是一整段 −6 点，不知道是哪两个零件凑的。
       */
      const { count } = modifierCountOf(mod, proto)
      const extra = count - 1
      if (proto.kind === 'multi') multiAts.push(mod.at)
      else splitAts.push(mod.at)

      out.push({
        label: `修饰「${proto.name}」· 多出的 ${extra} 份`,
        points: -extra * rate,
        from: 'technique',
        refId: `mod:${mod.proto}@${String(mod.at)}`,
        path: `sequences[${j}].mods[${String(mods.indexOf(mod))}]`,
      })
    }

    /*
     * ⚠ 叠加的额外一笔 —— **今天这个数是 0**（`balance.json` 的
     *   `stackPenaltyPerPoint`），所以这一段平常一分钱都不记。
     *   留着它是因为"两个修饰凑一起要不要更贵"是一个**待玩家裁定**的问题：
     *   玩家说要，就改 balance.json 里那一个数，不用改代码。
     */
    if (stackPenalty > 0 && multiAts.some(a => splitAts.includes(a))) {
      out.push({
        label: '修饰叠加（多重释放 + 一分为 X 盯上同一个技能）',
        points: -stackPenalty,
        from: 'technique',
        refId: `mod:stack@${String(j)}`,
        path: `sequences[${j}].mods`,
      })
    }
  }

  return out
}
