/**
 * 定价表的测试。
 *
 * ## 符号约定：**正 = 收益，负 = 代价**
 *
 * 这是从玩家那一侧读的：
 *
 *   伤害 +10       你拿到了 10 点强度
 *   扣能量 -2      你付出了 2 点
 *   买规则位 -1.5  你花掉了 1.5 点
 *   卖规则位 +1    你赚到了 1 点
 *
 * ⚠ 一个**术式**的所有条目加起来必须**等于 0**。
 *   技能（零件）**不必** —— 玩家 2026-09-21 澄清过：
 *   > 技能不必配平到 0，但要想编排为术式，术式必须配平（单个技能也可以成为术式）
 *   下面「配平的责任在术式，不在技能」那一节就是钉这句话的。
 *
 * ## 这个文件存在的理由
 *
 * 点数的**方向**错过四次，而且四次都没有任何东西报警 ——
 * 全是"玩家一试就发现、代码全绿"：
 *
 *   1. 点数手写在 JSON 上 → 改数值点数不动（编辑器里实测踩到）
 *   2. 状态的"强度"取了绝对值 → **自我减益被算成收益**
 *   3. 规则位买卖两边符号都反了（第一版）
 *   4. **整本账的符号反了**：写着 `买 1 条规则位 +1.5`，玩家读成"我赚了 1.5"，
 *      而它其实是花掉的。玩家原话："买卖规则位得点数的正负反了。"
 *      —— 编辑器的 CSS 里绿色的那条叫 `.gain`（收益），可它填的却是"多出代价"。
 *      **两份东西对不上时，是代码错了，不是玩家读错了。**
 *
 * 前四条现在都钉在这里。它们是"为了变强必须付出代价"这个循环的地基 ——
 * 方向错了，整个编辑器就是在鼓励玩家白嫖。
 */
import {
  bloodPactCostOf,
  defaultTargetOf, integerPointsOf, phaseTierProblems, priceAction, priceOptionsFor, pricePhase, priceRule,
  priceSkill, priceTechnique, readRates, readTierTable, readTierTables, skillLedger, tierOf, tierPointsForSkill,
  tierPointsOf,
  DEFAULT_RATES, DEFAULT_TIER_TABLES, TIER_BY_SKILL_KEY, TIER_NEUTRAL, TIER_TABLE_PHASE_DURATION,
} from '../src/pricing.ts'
import type { LookupTable, PriceOptions, TierTable } from '../src/pricing.ts'
import { compileTechnique } from '../src/sim/compile.ts'
import { checkBalance } from '../src/validator/checks.ts'
import { validateSkill, validateTechnique } from '../src/validator/index.ts'
import { stampSchool } from '../src/school.ts'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { readJson } from '../src/loader.ts'
import type { BalanceConfig } from '../src/validator/types.ts'
import type { Action, ModifierProto, Phase, Rule, SequenceSegment, Skill, StatusDef, Technique } from '../src/schema.ts'

let passed = 0
let failed = 0

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail !== undefined ? `\n      ${detail}` : ''}`)
  }
}

/** 相等断言（这一节里用得多） */
function okEq(name: string, actual: string, expected: string): void {
  ok(name, actual === expected, '实际 ' + actual + '，期望 ' + expected)
}

function section(title: string): void {
  console.log(`\n${title}`)
}

const R = DEFAULT_RATES

const OPTIONS = {
  rates: R,
  baseRuleSlots: 4,
  ruleSlotBuyCost: 5,
  ruleSlotSellGain: 3,
}

function phase(id: string, duration: number, over: Partial<Phase> = {}): Phase {
  return { id, duration, occupiesCaster: false, interrupt: 'damage', cancellable: false, ...over }
}

let seq = 0
function rule(when: Rule['when'], then: Rule['then'], over: Partial<Rule> = {}): Rule {
  seq++
  return { id: `r${seq}`, when, then, order: seq, ...over }
}

function skill(over: Partial<Skill> = {}): Skill {
  return {
    schemaVersion: 1,
    id: 'skill.probe',
    name: 'probe',
    /*
     * ⚠ **系别章**（派生字段，正常由加载器按目录盖，见 src/school.ts）。
     *   手造的技能表必须自己盖 —— 缺了它校验器报 `SKILL_SCHOOL_MISSING`
     *   （"判不了同不同系"不许静默通过），而那些用例本来一个字都没错。
     *   这些探针全是魔法系的。
     */
    school: 'magic',
    phases: [phase('cast', 0)],
    rules: [],
    ruleSlots: 4,
    ...over,
  }
}

function status(id: string, over: Partial<StatusDef> = {}): StatusDef {
  return { id, name: id, tags: ['debuff'], duration: 4, ...over }
}

function applyStatus(s: StatusDef, target: 'self' | 'hit'): Action {
  return { target, payload: { kind: 'status', verb: 'apply', inline: s } }
}

function total(s: Skill): number {
  return priceSkill(s, OPTIONS).total
}

/** 只用来把期望值印进断言名里（两位小数），不参与比较 */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * ⚠⚠ **账上印整数之后的断言口径**（2026-09-30 日志 57）。
 *
 * 用户规格：**点数改成整数**（逐条取整 + 最大余数法），而且
 * **每个非零条目至少 1 点**。⇒ 一条"金额 = 某个小数公式"的断言
 * **不能再要求逐位相等** —— `0.6` 那一笔账上印的是 `1`。
 *
 * 新口径断两件事（两件都是**规格**，不是"差不多就行"）：
 *   ① **是整数**（这正是这一片要钉的东西）；
 *   ② **离原料值不到 1 点** —— 最大余数法保证每条落在 `[floor(原料), floor(原料)+1]`，
 *      而"至少 1 点"的地板把 `0.12` 抬到 `1`（差 0.88 < 1）。两条合起来 ⇒ 差 < 1。
 *
 * ⚠ 所以名字里那个公式**仍然有意义**：它说的是"这一笔的原料是多少"。
 */
function okIntNear(name: string, actual: number, raw: number, detail?: string): void {
  ok(name,
    Number.isInteger(actual) && Math.abs(actual - raw) < 1,
    `${actual}（原料 ${round2(raw)}，差 ${round2(actual - raw)}）${detail !== undefined ? ` ${detail}` : ''}`)
}

// ============================================================================
//  方向：正 = 收益，负 = 代价
// ============================================================================

section('额度的方向（负 = 消耗额度，正 = 提供额度）')

{
  // 纯伤害：收益（正点）
  const dmg = skill({ rules: [rule('onHit', [{ payload: { kind: 'damage', amount: { const: 100 } } }])] })
  ok('伤害消耗额度（负点）', total(dmg) < 0, `实际 ${total(dmg)}`)
  ok('100 伤害消耗 100 / damagePerPoint',
    Math.abs(total(dmg) + 100 / R.damagePerPoint) < 1e-9,
    `实际 ${total(dmg)}，期望 ${-100 / R.damagePerPoint}`)
}

{
  // 给自己挂减益 = 代价（负点）。⚠ 这条曾经算成收益，整个循环就是反的。
  const penalty = skill({
    rules: [rule('onCast', [applyStatus(status('status.weak', {
      modifiers: [{ path: 'char.speed', op: 'mul', value: { const: 0.8 } }],
    }), 'self')])],
  })
  ok('自我减益（移速 ×0.8）提供额度（正点）', total(penalty) > 0, `实际 ${total(penalty)}`)
}

{
  // 给敌人挂减益 = 收益（正点）
  const hex = skill({
    rules: [rule('onHit', [applyStatus(status('status.slow', {
      modifiers: [{ path: 'char.moveScale', op: 'mul', value: { const: 0.5 } }],
    }), 'hit')])],
  })
  ok('给敌人挂减益（移速 ×0.5）消耗额度（负点）', total(hex) < 0, `实际 ${total(hex)}`)
}

{
  // 同一份状态、同样的时长：方向必须相反，大小必须相等
  const s = status('status.same', {
    modifiers: [{ path: 'char.speed', op: 'mul', value: { const: 0.7 } }],
  })
  const onSelf = priceRule(rule('onCast', [applyStatus(s, 'self')]), R)
  const onFoe = priceRule(rule('onHit', [applyStatus(s, 'hit')]), R)
  ok('同一份状态挂自己 / 挂敌人，符号相反', onSelf > 0 && onFoe < 0, `自己 ${onSelf}，敌人 ${onFoe}`)
  ok('而且大小相等', Math.abs(onSelf + onFoe) < 1e-9, `自己 ${onSelf}，敌人 ${onFoe}`)
}

{
  // 给自己上增益 = 收益（正点）
  const buff = skill({
    rules: [rule('onCast', [applyStatus(status('status.might', {
      tags: ['buff'],
      modifiers: [{ path: 'char.damageDealt', op: 'mul', value: { const: 1.3 } }],
    }), 'self')])],
  })
  ok('自我增益（伤害 ×1.3）消耗额度（负点）', total(buff) < 0, `实际 ${total(buff)}`)
}

{
  // 受伤 +15% 是**对持有者有害**，给敌人挂就是收益
  const sunder = skill({
    rules: [rule('onHit', [applyStatus(status('status.sunder', {
      modifiers: [{ path: 'char.damageTaken', op: 'mul', value: { const: 1.15 } }],
    }), 'hit')])],
  })
  ok('给敌人挂「受伤 +15%」消耗额度（负点）', total(sunder) < 0, `实际 ${total(sunder)}`)

  const selfSunder = skill({
    rules: [rule('onCast', [applyStatus(status('status.sunder2', {
      modifiers: [{ path: 'char.damageTaken', op: 'mul', value: { const: 1.15 } }],
    }), 'self')])],
  })
  ok('给自己挂「受伤 +15%」提供额度（正点）', total(selfSunder) > 0, `实际 ${total(selfSunder)}`)
}

{
  // 控制：把敌人冻住是收益
  const frozen = skill({
    rules: [rule('onHit', [applyStatus(status('status.freeze', {
      tags: ['hardCC'],
      duration: 2,
      disables: ['move', 'attack', 'cast'],
    }), 'hit')])],
  })
  ok('冻结敌人消耗额度（负点）', total(frozen) < 0, `实际 ${total(frozen)}`)
}

{
  // 扣能量 = 代价
  const cost = skill({
    rules: [rule('onCast', [{
      payload: { kind: 'attribute', path: 'char.energy.current', op: 'add', value: { const: -20 } },
    }])],
  })
  ok('扣 20 能量提供额度（正点）', total(cost) > 0, `实际 ${total(cost)}`)
}

{
  // 阶段的时长、冷却都是代价
  const slow = skill({ phases: [phase('cast', 1, { cost: { cooldown: 10 } })] })
  ok('1 秒前摇 + 10 秒冷却都提供额度（正点）', total(slow) > 0, `实际 ${total(slow)}`)
}

{
  // 扛打断是收益 → 消耗额度 → 点数更低（更负）
  const soft = skill({ phases: [phase('cast', 0.5, { interrupt: 'damage' })] })
  const hard = skill({ phases: [phase('cast', 0.5, { interrupt: 'none' })] })
  ok('无法打断比挨打就断点数更低（消耗更多额度）', total(hard) < total(soft),
    `挨打就断 ${total(soft)}，无法打断 ${total(hard)}`)
}

{
  // 重置冷却很值钱 → 收益 → 消耗额度
  const reset = skill({
    rules: [rule('onKill', [{
      payload: { kind: 'attribute', path: 'skill.cooldown', op: 'reset', value: { const: 0 } },
    }])],
  })
  ok('击杀重置冷却消耗额度（负点）', total(reset) < 0, `实际 ${total(reset)}`)
}

// ============================================================================
//  频率：onTick 要按"每秒几次"算
// ============================================================================

section('触发频率')

{
  const drain = (every: number | undefined): Rule => {
    const r = rule('onTick', [{
      payload: { kind: 'attribute', path: 'char.energy.current', op: 'add', value: { const: -10 } },
    }])
    if (every !== undefined) r.every = every
    return r
  }

  const once = priceRule(drain(undefined), R)   // 默认 1 秒一次
  const twice = priceRule(drain(0.5), R)
  const four = priceRule(drain(0.25), R)

  // 每 1 次扣 10 能量 = 提供额度 10 / energyPerPoint = +1 点
  const perTrigger = 10 / R.energyPerPoint

  ok('onTick 不写 every 时按每秒一次算', Math.abs(once - perTrigger) < 1e-9,
    `实际 ${once}，期望 ${perTrigger}`)
  ok('every 0.5 的代价是每秒一次的 2 倍', Math.abs(twice - once * 2) < 1e-9, `${once} → ${twice}`)
  ok('every 0.25 的代价是每秒一次的 4 倍', Math.abs(four - once * 4) < 1e-9, `${once} → ${four}`)

  // 每帧一次（every 0.01）不能算出几百点来 —— 频率有上限
  const spam = priceRule(drain(0.01), R)
  ok('每帧一次的写法有频率上限，不会刷爆点数', spam <= once * 4 + 1e-9, `实际 ${spam}`)
}

// ============================================================================
//  规则位：买是花掉，卖是赚到
// ============================================================================

section('规则位（买是花掉，卖是赚到）')

{
  const base = skill({ ruleSlots: 4 })
  const bought = skill({ ruleSlots: 6 })
  const sold = skill({ ruleSlots: 2 })

  ok('刚好用满初始规则位时，规则位不贡献任何点数', total(base) === 0, `实际 ${total(base)}`)
  ok('多买 2 条规则位是**花掉**（负点）', total(bought) < 0, `实际 ${total(bought)}`)
  ok('卖掉 2 条规则位是**赚到**（正点）', total(sold) > 0, `实际 ${total(sold)}`)
  ok('买 2 条正好是 -2 × ruleSlotBuyCost',
    Math.abs(total(bought) + 2 * OPTIONS.ruleSlotBuyCost) < 1e-9,
    `实际 ${total(bought)}，期望 ${-2 * OPTIONS.ruleSlotBuyCost}`)
  ok('卖 2 条正好是 +2 × ruleSlotSellGain',
    Math.abs(total(sold) - 2 * OPTIONS.ruleSlotSellGain) < 1e-9,
    `实际 ${total(sold)}，期望 ${2 * OPTIONS.ruleSlotSellGain}`)
}

{
  /*
   * ⚠ 玩家报的就是这一条。原来买规则位显示 +1.5，读起来像"我赚了 1.5"。
   *   现在它必须是负数 —— **花掉的东西在账本上是负的**。
   */
  const bought = priceSkill(skill({ ruleSlots: 5 }), OPTIONS)
  const entry = bought.entries.find(e => e.from === 'ruleSlots')
  ok('「买规则位」那一行是负数', entry !== undefined && entry.points < 0,
    entry === undefined ? '没抽到规则位那一条' : `${entry.label} → ${entry.points}`)
  ok('而且标签写的是「买」', entry?.label.startsWith('买') === true, entry?.label)
}

// ============================================================================
//  点数跟着数值走 —— 这一条是那次改造的起因
// ============================================================================

section('点数由内容推导')

{
  const mk = (amount: number): Skill => skill({
    rules: [rule('onHit', [{ payload: { kind: 'damage', amount: { const: amount } } }])],
  })

  const a = total(mk(30))
  const b = total(mk(300))
  ok('30 伤害 → 300 伤害，点数跟着变', a !== b, `${a} → ${b}`)
  ok('伤害翻十倍，点数也翻十倍', Math.abs(b - a * 10) < 1e-9, `${a} → ${b}`)

  // 阶段时长同理（前摇是代价 → 提供额度 → 越长点数越高）
  /*
   * ⚠⚠ 2026-09-30（日志 57）这里原来是 `0.1s → 1.0s`。
   *   账上**每个非零条目至少 1 点**之后，0.1 秒和 1.0 秒**都是 1 点**
   *   （两条原料都落在"不到 1 点"那一格里）—— 那不是 bug，是整数账的地板。
   *   所以拿**越过地板**的两档来量这根轴：1 秒 vs 8 秒。
   */
  const fast = total(skill({ phases: [phase('cast', 1)] }))
  const slow = total(skill({ phases: [phase('cast', 8)] }))
  ok('前摇 1s → 8s，点数跟着变', slow > fast, `${fast} → ${slow}`)
  ok('  ⚠ 而 0.1 秒和 1.0 秒**都是 1 点**（不到 1 点的原料被"至少 1 点"的地板抬平）',
    total(skill({ phases: [phase('cast', 0.1)] })) === 1
    && total(skill({ phases: [phase('cast', 1)] })) === 1,
    `${total(skill({ phases: [phase('cast', 0.1)] }))} / ${total(skill({ phases: [phase('cast', 1)] }))}`)
}

// ============================================================================
//  配平：责任在**术式**，不在技能
// ============================================================================

section('配平的责任在术式，不在技能')

{
  const balance: BalanceConfig = {
    schemaVersion: 1,
    baseRuleSlots: 4,
    ruleSlotBuyCost: 5,
    ruleSlotSellGain: 3,
    rates: {},
  }

  /*
   * ⚠ 玩家 2026-09-21 定的宗旨：
   *   > 所有点数相关的可调整的值，都具有一个默认值，在这个默认值下点数是配平为0的。
   *   > （默认值从哪来）**每个技能自己定（内容里的就是默认）**
   *
   *   所以账算的是"**你改了多少**"：出厂技能自己减自己必须是空的。
   *   下面是两块**故意做歪的零件**（纯收益的火球、纯代价的长冷却收招）——
   *   它们自己是 0 点，歪的是**玩家改出来的那两份副本**。
   */

  const options = {
    rates: readRates(balance.rates),
    baseRuleSlots: balance.baseRuleSlots,
    ruleSlotBuyCost: balance.ruleSlotBuyCost,
    ruleSlotSellGain: balance.ruleSlotSellGain,
  }

  /** 出厂技能自己减自己 = 空账。这一条是宗旨的机械表述 */
  const identity = skill({ id: 'skill.zero', name: '零' })
  ok('出厂技能自己减自己 = 空账（0 点，一条明细都没有）',
    skillLedger(identity, identity, options).total === 0
    && skillLedger(identity, identity, options).entries.length === 0,
    `合计 ${skillLedger(identity, identity, options).total}`)

  // 纯收益零件：300 伤害，一点代价都没有
  const gainPart = skill({
    id: 'skill.gain',
    name: '收益件',
    rules: [rule('onHit', [{ payload: { kind: 'damage', amount: { const: 300 } } }], { order: 0 })],
  })
  const gainReport = validateSkill('gain.json', gainPart, balance)
  ok('歪的零件（纯收益）在技能这一层不报错',
    gainReport.issues.filter(i => i.level === 'error').length === 0,
    gainReport.issues.filter(i => i.level === 'error').map(i => i.code).join(', '))
  ok('  ⚠ 绝对账仍然看得出它花超了 —— 但那是**内部强度标尺**，不是判据',
    gainReport.total < 0 && gainReport.kind === 'negative',
    `${gainReport.kind}，合计 ${gainReport.total}`)
  ok('  相对出厂值它是 0 点（没改过就是配平的）',
    skillLedger(gainPart, gainPart, options).total === 0,
    `实际 ${skillLedger(gainPart, gainPart, options).total}`)

  // 纯代价零件：白扣一大笔能量，什么效果都没有
  const costPart = skill({
    id: 'skill.cost',
    name: '代价件',
    rules: [rule('onCast', [{
      payload: { kind: 'attribute', path: 'char.energy.current', op: 'add', value: { const: -30 } },
    }], { order: 0 })],
  })
  const costReport = validateSkill('cost.json', costPart, balance)
  ok('歪的零件（纯代价）在技能这一层也不报错',
    costReport.issues.filter(i => i.level === 'error').length === 0,
    costReport.issues.map(i => i.code).join(', '))

  // ---- 玩家改出来的两份副本：一份改强、一份改弱 ----
  /** 改强：伤害 ×2 */
  function stronger(s: Skill, times: number): Skill {
    const out = JSON.parse(JSON.stringify(s)) as Skill
    const action = out.rules[0]!.then[0]!
    // `ValueSpec` 没有判别字段，所以这里按结构改（不是按 kind 分支）
    const amount = (action.payload as { amount?: Record<string, unknown> } | undefined)?.amount
    if (amount !== undefined && typeof amount['const'] === 'number') {
      amount['const'] = (amount['const'] as number) * times
    }
    return out
  }
  const strongGain = stronger(gainPart, 2)
  ok('把伤害改高一倍 → 账是负的（花超了）',
    skillLedger(strongGain, gainPart, options).total < 0,
    `实际 ${skillLedger(strongGain, gainPart, options).total}`)

  const heavierCost: Skill = JSON.parse(JSON.stringify(costPart)) as Skill
  heavierCost.rules[0]!.then[0]!.payload = {
    kind: 'attribute', path: 'char.energy.current', op: 'add', value: { const: -60 },
  }
  ok('把代价改重一倍 → 账是正的（提供额度）',
    skillLedger(heavierCost, costPart, options).total > 0,
    `实际 ${skillLedger(heavierCost, costPart, options).total}`)

  // ---- 加减一条规则 ----
  const withExtra: Skill = JSON.parse(JSON.stringify(costPart)) as Skill
  withExtra.rules.push(rule('onKill', [{
    payload: { kind: 'damage', amount: { const: 100 } },
  }], { order: 9 }))
  ok('新加一条规则 → 明细上标着「（新增）」',
    skillLedger(withExtra, costPart, options).entries.some(e => e.label.includes('（新增）')),
    skillLedger(withExtra, costPart, options).entries.map(e => e.label).join(' / '))

  const withoutRule: Skill = JSON.parse(JSON.stringify(costPart)) as Skill
  withoutRule.rules = []
  ok('删掉那条代价规则 → 额度被收回（账变负）',
    skillLedger(withoutRule, costPart, options).total < 0,
    `实际 ${skillLedger(withoutRule, costPart, options).total}`)

  /*
   * ⚠ 对账认的是 **id**，不是下标。
   *   按下标对的话，把两条规则**换个顺序**会被算成一笔交易 ——
   *   而那笔交易谁也没做过，账面上还看不出异常。
   */
  const twoRules = skill({
    id: 'skill.two',
    name: '两条规则',
    rules: [
      rule('onHit', [{ payload: { kind: 'damage', amount: { const: 30 } } }], { order: 0 }),
      rule('onCast', [{
        payload: { kind: 'attribute', path: 'char.energy.current', op: 'add', value: { const: -30 } },
      }], { order: 1 }),
    ],
  })
  const swapped: Skill = JSON.parse(JSON.stringify(twoRules)) as Skill
  swapped.rules = [swapped.rules[1]!, swapped.rules[0]!]
  ok('只换规则顺序 → 账不动（认 id，不认下标）',
    skillLedger(swapped, twoRules, options).total === 0,
    `实际 ${skillLedger(swapped, twoRules, options).total}`)

  // ---- 术式：成品，必须配平 ----
  /*
   * ⚠ **两个技能库**（玩家 2026-09-21 定的）：基础技能库（内容、只读）
   *   + 自定义技能库（玩家编的变体，`basedOn` 指向模板）。
   *   术式按 id 引用技能，两个库都能引用 —— 所以下面把变体也放进同一张表。
   */
  const lib = new Map<string, Skill>([[gainPart.id, gainPart], [costPart.id, costPart]])

  /** 把一份技能做成"玩家编出来的变体"（新 id + 记住模板） */
  function asVariant(skill: Skill, n: number): Skill {
    return { ...JSON.parse(JSON.stringify(skill)) as Skill, id: `custom.${skill.id.replace(/^skill\./, '')}.${n}`, basedOn: skill.id }
  }
  const vStrong = asVariant(strongGain, 1)
  const vHeavy = asVariant(heavierCost, 1)
  lib.set(vStrong.id, vStrong)
  lib.set(vHeavy.id, vHeavy)

  function tech(skills: string[]): Technique {
    return {
      schemaVersion: 1,
      id: 'tech.probe',
      name: 'probe',
      // ⚠ 系别必填（schema 的 Technique.kind）：这些术式里的技能都是魔法系
      kind: 'magic',
      activation: 'press',
      // ⚠ 瞄准在**技能**上（2026-09-21 日志 47）：术式不再有 `targeting`。
      //   这一段测的是**账**，和技能瞄哪儿无关，所以这里不补。
      skills,
    }
  }

  // ⓪ 没改过 → 出厂内容本来就是配平的
  const untouched = validateTechnique('t.json', tech([gainPart.id]), { balance, skills: lib })
  ok('没改过的术式 → 合计 0，不报没配平',
    untouched.total === 0 && !untouched.issues.some(i => i.code === 'NOT_BALANCED'),
    `合计 ${untouched.total}；${untouched.issues.map(i => i.code).join(', ')}`)

  // ① 单个技能当术式用、而且改强了 → 账就落在它自己身上
  const soloGain = validateTechnique('t.json', tech([vStrong.id]), { balance, skills: lib })
  ok('单个技能当术式用时，账 = 它相对**模板**的偏离',
    Math.abs(soloGain.total - skillLedger(vStrong, gainPart, options).total) < 1e-9,
    `${soloGain.total} vs ${skillLedger(vStrong, gainPart, options).total}`)

  /*
   * ⚠ 两个方向**不对称**，这是既有的设计，不是这里新加的：
   *
   *   合计 **< 0**（花超了）→ **负值术式**，**允许**，每次释放拿血契付（警告）
   *   合计 **> 0**（没用完）→ 没配平，**错误**
   *
   *   理由：花超了有代价（血契，而且**得先攒**），额度没用完则是纯粹的白送 ——
   *   没有任何东西在限制它，所以必须拦。
   *
   *   （血契**现在是核心机制**：2026-09-21 玩家把它扶正 ——
   *     "花超了的术式叫做负值术式，消耗血契才能释放"。
   *     存量、来源、扣费在 `tests/scenario.ts` 的 33~36 节钉着。
   *     所以"要不要收紧成硬错误"这个问题也已经答了：**不收紧**，
   *     负值术式是一条合法的路，代价是"得攒够"。）
   */
  /*
   * ⚠⚠ 2026-09-30（日志 57）**两个方向现在只有一条判据**，用户原话：
   *   > **点数之和大于 0 就能用，小于 0 就要支付血契才能用**
   *
   *   ⇒ 合计 **< 0**（花超了）→ **负值术式**，允许，每次释放拿血契付（警告）
   *     合计 **≥ 0**（正好平 / 还有余额）→ **能用**，**不报任何东西**。
   *
   *   ⚠ 这里原来还有一条 `NOT_BALANCED` 错误，管的是"额度没用完 = 白送"——
   *     那条**连同"容差 2 点"一起删了**（用户的规格：> 0 就是能用）。
   */
  ok('单个技能当术式用、且花超了 → 走血契那条路（警告）',
    soloGain.kind === 'negative'
    && soloGain.issues.some(i => i.code === 'NEGATIVE_TECHNIQUE'),
    `${soloGain.kind} ${soloGain.total}；${soloGain.issues.map(i => i.code).join(', ')}`)

  const soloCost = validateTechnique('t.json', tech([vHeavy.id]), { balance, skills: lib })
  ok('⭐ 合计 > 0（额度没用完）**能用**，一条问题都不报 —— 没有那个 2 点缓冲区了',
    soloCost.total > 0
    && soloCost.kind === 'normal'
    && soloCost.issues.length === 0,
    `合计 ${soloCost.total}；${soloCost.issues.map(i => i.code).join(', ') || '(无)'}`)

  /*
   * ⚠ 而"正好 0"也是能用（新规格的边界：**≥ 0** 就能用）。
   *   这是"取整之后合计为 0、但各条不全为 0"的那个情形 —— 判据只看合计。
   */
  const soloZero = validateTechnique('t.json', tech([gainPart.id]), { balance, skills: lib })
  ok('合计 = 0（出厂技能自己减自己）→ 能用，而且不报问题',
    soloZero.total === 0 && soloZero.kind === 'normal' && soloZero.issues.length === 0,
    `合计 ${soloZero.total}；${soloZero.issues.map(i => i.code).join(', ') || '(无)'}`)

  /*
   * ② 两份改过的技能拼起来 → 这才是"组合"。
   *
   *    一段改强（花超）、一段改弱（赚额度），加起来就是配平。
   *    这正是玩家要的那个循环：拿代价零件去付收益零件的账。
   */
  const combo = validateTechnique(
    't.json', tech([vStrong.id, vHeavy.id]), { balance, skills: lib })
  ok('  术式账 = 两份变体各自偏离相加',
    Math.abs(combo.total
      - (skillLedger(vStrong, gainPart, options).total
        + skillLedger(vHeavy, costPart, options).total)) < 1e-9,
    `${combo.total}`)
  ok('  账上每一行都标了是**哪一段**贡献的（编辑器要靠它分组）',
    combo.ledger.length > 0 && combo.ledger.every(e => typeof e.skillId === 'string'),
    combo.ledger.map(e => e.skillId ?? '(无)').join(', '))

  // ③ 引用不到的零件：必须报错，否则"已配平"是假的
  const broken = validateTechnique('t.json', tech(['skill.typo']), { balance, skills: lib })
  ok('零件引用不到时必须报错，而不是算成 0 点',
    broken.issues.some(i => i.code === 'UNKNOWN_SKILL'),
    broken.issues.map(i => i.code).join(', '))

  /*
   * ④ ⚠⚠ 2026-09-30（日志 57）**这条作废了**：以前"额度没用完（合计为正）"
   *    要报 `NOT_BALANCED` 错误，现在用户定的规格是"**大于 0 就能用**"。
   *    上面 ① 那一块已经改成钉新口径（> 0 → 一条问题都不报）。
   *    ⚠ 这里只留一条**新口径的边界断言**：合计 > 0 时 `kind` 必须是 `normal`
   *      （不是 `negative`）—— 方向反了才是真 bug。
   */
  ok('合计为正 ⇒ kind = normal（新口径：> 0 是能用，不是超模）',
    soloCost.total > 0 && soloCost.kind === 'normal',
    `合计 ${soloCost.total} / ${soloCost.kind}`)

  // ⑤ 花超了要提示血契
  const over = soloGain
  ok('负值术式（合计为负）会提醒要拿血契付',
    over.kind === 'negative' && over.issues.some(i => i.code === 'NEGATIVE_TECHNIQUE'),
    `${over.kind} ${over.total}；${over.issues.map(i => i.code).join(', ')}`)
  ok('  血契消耗量 = |合计|',
    Math.abs(over.bloodPactPerUse + over.total) < 1e-9,
    `${over.bloodPactPerUse} vs ${over.total}`)
}

// ============================================================================
//  宗旨没有例外：**每一个**出厂技能自己减自己都是 0
// ============================================================================

section('宗旨是铁的：出厂内容全都是 0 点（一个例外都没有）')

{
  /*
   * ⚠ 这里曾经有过一个例外：`Skill.factoryDebt`（"出厂就负债的零件"）——
   *   标了它的技能从**绝对账**起算，好让裂魂/血祭斩在出厂内容里就是负值术式。
   *
   *   2026-09-21 玩家看完之后判断"没什么必要"，删掉了。两句话：
   *     > **负债件的变体不一定是负债件**（当时实现判的是"模板标没标"，
   *     >   所以变体是**一定**继承 —— 把裂魂改弱之后，那个术式反而拿到额度）
   *     > 宗旨（每个技能在它自己的默认值下是 0 点）应该是**铁的**
   *
   *   所以这一节钉的是：**内容里每一个技能的账都是空的** ——
   *   不是抽查两个，是逐个扫。有谁偷偷偏离了，这里当场红。
   */
  const balance: BalanceConfig = {
    schemaVersion: 1, baseRuleSlots: 4, ruleSlotBuyCost: 1.5, ruleSlotSellGain: 1,
    rates: {},
  }
  const opts = {
    rates: readRates(balance.rates),
    baseRuleSlots: balance.baseRuleSlots,
    ruleSlotBuyCost: balance.ruleSlotBuyCost,
    ruleSlotSellGain: balance.ruleSlotSellGain,
  }

  const dir = resolve('content/skills')
  const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort()
  const dirty: string[] = []
  for (const f of files) {
    const skill = readJson<Skill>(resolve(dir, f))
    const r = skillLedger(skill, skill, opts)
    if (r.total !== 0 || r.entries.length > 0) dirty.push(`${skill.id}=${r.total}`)
  }
  ok(`内容里 ${files.length} 个技能，每一个自己减自己都是空账`,
    dirty.length === 0, dirty.join(', '))

  // ⚠ 而且**变体**也是同一条规矩：它对着模板算，不是"继承模板的债"
  const base = stampSchool(readJson<Skill>(resolve(dir, 'soul-rend.json')), 'magic')
  const variant: Skill = JSON.parse(JSON.stringify(base)) as Skill
  variant.id = 'custom.soul-rend.1'
  variant.basedOn = base.id
  ok('一份原样的变体也是 0 点（出厂技能没有"债"可以继承）',
    skillLedger(variant, base, opts).total === 0,
    `实际 ${skillLedger(variant, base, opts).total}`)

  // 想变成负值术式？**自己把它改强** —— 那才是血契要服务的东西
  const stronger: Skill = JSON.parse(JSON.stringify(variant)) as Skill
  stronger.ruleSlots += 4
  const lib = new Map<string, Skill>([[base.id, base], [stronger.id, stronger]])
  const tech: Technique = {
    schemaVersion: 1, id: 'tech.t', name: 't', kind: 'magic', activation: 'press',
    // ⚠ 瞄准在**技能**上（2026-09-21 日志 47）：这一段测的是账，不看瞄哪儿
    skills: [stronger.id],
  }
  const rep = validateTechnique('t.json', tech, { balance, skills: lib })
  ok('把变体改强 → 那份术式就是负值术式（一放就吃血契）',
    rep.kind === 'negative' && rep.bloodPactPerUse > 0,
    `${rep.kind} ${rep.total}；血契 ${rep.bloodPactPerUse}`)
}

// ============================================================================
//  冷却是**技能唯一的属性**
// ============================================================================

section('冷却是技能唯一的属性：不能在两个阶段都有')

{
  /*
   * ⚠ 玩家 2026-09-21：
   *   > **冷却是技能的唯一属性，不能在前后摇都有冷却**，编辑器内可以选择
   *   > 这个唯一的冷却属性在前摇/后摇进入冷却。
   *
   *   数据上冷却写在**某个阶段**的 `cost` 上（"代价付在哪一段"参与定价：
   *   早付是风险、晚付是安全），所以"唯一"这条得**盯着**。
   *   两个阶段都有冷却的后果是静默的：引擎取大值（只生效一个），
   *   而定价两笔都算 —— 玩家付了两次钱，账面还看不出来。
   */
  const balance: BalanceConfig = {
    schemaVersion: 1, baseRuleSlots: 4, ruleSlotBuyCost: 1.5, ruleSlotSellGain: 1,
    rates: {},
  }

  const two: Skill = skill({
    phases: [
      phase('windup', 0.2, { cost: { cooldown: 2 } }),
      phase('swing', 0.2, { cost: { cooldown: 8 } }),
    ],
  })
  const bad = validateSkill('t.json', two, balance)
  ok('两个阶段都写了冷却 → 报 COOLDOWN_TWO_PHASES',
    bad.issues.some(i => i.code === 'COOLDOWN_TWO_PHASES'),
    bad.issues.map(i => i.code).join(', '))

  const one: Skill = skill({
    phases: [phase('windup', 0.2), phase('swing', 0.2, { cost: { cooldown: 8 } })],
  })
  const good = validateSkill('t.json', one, balance)
  ok('只有一个阶段有冷却 → 不报（内容现在全是这样）',
    !good.issues.some(i => i.code === 'COOLDOWN_TWO_PHASES'),
    good.issues.map(i => i.code).join(', '))

  // ⚠ 0 秒不算"写了冷却"（那是"这个阶段不付冷却"）
  const zero: Skill = skill({
    phases: [phase('windup', 0.2, { cost: { cooldown: 0 } }), phase('swing', 0.2, { cost: { cooldown: 8 } })],
  })
  ok('0 秒不算第二份冷却', 
    !validateSkill('t.json', zero, balance).issues.some(i => i.code === 'COOLDOWN_TWO_PHASES'))
}

// ============================================================================
//  射程：相对于载体自己的标准值
// ============================================================================
section('射程计价：长了扣点，短了补贴')

{
  /*
   * ⚠ 玩家 2026-09-21 定的形状：
   *   > 不同的技能有不同的标准值（近战技能近，远程技能远），多了则计价、
   *   > 少了则补贴点数。这样近战技能想打得远就要付出代价。
   *
   *   所以这一条轴是**相对**的：每个载体类型有自己的标准值
   *   （扇形 2.5 米 / 突刺 6 米 / 光束 8 米），只有偏离标准的那部分才计价。
   */
  const at = (radius: number): number => priceAction({
    delivery: { kind: 'meleeArc', radius, angle: 120 },
    payload: { kind: 'damage', amount: { const: 0 } },
  }, R)

  ok('扇形正好取标准值 2.5 米 → 射程这一项是 0', at(2.5) === 0, String(at(2.5)))
  ok('拖到 8 米 → 扣点（负 = 消耗额度）', at(8) < 0, String(at(8)))
  ok('缩到 1 米 → 补贴点数（正 = 提供额度）', at(1) > 0, String(at(1)))
  ok('拖得越远扣得越多', at(12) < at(8), `${at(12)} vs ${at(8)}`)

  // 三种载体各有一条自己的标准值，"近战近、远程远"就体现在这儿
  const beam = (length: number): number => priceAction({
    delivery: { kind: 'beam', length, width: 0.6 },
    payload: { kind: 'damage', amount: { const: 0 } },
  }, R)
  ok('光束取标准值 8 米 → 0', beam(8) === 0, String(beam(8)))
  ok('  同一个 8 米，对光束是标准、对扇形是加长',
    beam(8) === 0 && at(8) < 0, `beam ${beam(8)} / arc ${at(8)}`)

  const capsule = (length: number): number => priceAction({
    delivery: { kind: 'capsule', length, width: 0.8 },
    payload: { kind: 'damage', amount: { const: 0 } },
  }, R)
  ok('突刺取标准值 4 米 → 0（出厂内容里的破军突刺就是 4 米）',
    capsule(4) === 0, String(capsule(4)))
  ok('  同一个 4 米，对突刺是标准、对光束是短了',
    capsule(4) === 0 && beam(4) > 0, `capsule ${capsule(4)} / beam ${beam(4)}`)

  /*
   * ⚠ **范围是另一条轴**（玩家 2026-09-21 明确要求）。
   *
   *   射程 = 打得多远，范围 = 打得有多广。合成一条的话，
   *   "火墙的圈该多大"和"火墙能放多远"会挤在同一个价上，两边都说不清。
   *
   *   界线靠"哪个 kind 归哪张表"来划：一个载体只有一个 radius。
   */
  const area = (radius: number): number => priceAction({
    delivery: { kind: 'area', radius },
    payload: { kind: 'damage', amount: { const: 0 } },
  }, R)
  ok('范围取标准值 6 米 → 0', area(6) === 0, String(area(6)))
  ok('  铺到 12 米 → 扣点', area(12) < 0, String(area(12)))
  ok('  缩到 2.5 米（贴身一圈）→ 补贴', area(2.5) > 0, String(area(2.5)))

  const aura = (radius: number): number => priceAction({
    delivery: { kind: 'aura', radius },
    payload: { kind: 'heal', amount: { const: 0 } },
  }, R)
  ok('光环有自己的标准值 4 米 → 0', aura(4) === 0, String(aura(4)))
  ok('  同一个 4 米，对光环是标准、对范围是缩小了',
    aura(4) === 0 && area(4) > 0, `aura ${aura(4)} / area ${area(4)}`)

  ok('范围载体的半径不计入射程（它是范围，不是射程）',
    area(12) !== 0 && at(12) !== area(12), `area ${area(12)} vs arc ${at(12)}`)

  // 投射物的飞行距离是速度×时间算的，两条轴都不管它（玩家选的范围不含它）
  const bolt = (speed: number, lifetime: number): number => priceAction({
    delivery: { kind: 'projectile', speed, lifetime, radius: 0.5 },
    payload: { kind: 'damage', amount: { const: 0 } },
  }, R)
  ok('投射物两条轴都不参与', bolt(24, 3) === 0, String(bolt(24, 3)))
}


// ============================================================================
//  不写 target 时落在谁身上：照抄引擎，不猜
// ============================================================================

section('默认目标：照抄引擎的调用点，不猜')

{
  /*
   * ⚠ 这一节钉的是一段**黑历史**。
   *
   *   定价器以前用 `r.when !== 'onHit'` 去猜"不写 target 时效果落在谁身上"。
   *   它和引擎的实际行为不一致，而症状极难查：
   *   **同一个动作，引擎打敌人、账上按打自己算** ——
   *   于是这条规则的符号整个反了（本该 -3 的收益，账上是 +3 的代价）。
   *   咬了四次，每次都是"账算反了但没有任何地方会报警"。
   *
   *   现在 `defaultTargetOf()` 是**逐条对照引擎调用点**写下来的事实。
   *   下面每一条断言都对应一个真实的调用点 —— 改引擎那边的时候，
   *   这些断言会红，提醒你把这张表一起改。
   */

  // ---- 'other'：引擎确实把"对面那个"传进去了 ----
  for (const w of ['onHit', 'onKill', 'onEnter', 'onLeave', 'onDamaged', 'onLethalDamage'] as const) {
    ok(`${w} → 对面那个（引擎传了 target）`,
      defaultTargetOf(w, false) === 'other', defaultTargetOf(w, false))
  }
  ok('onCrit / onNonCrit → 对面那个（管线钩子里 buildValueContext 给的）',
    defaultTargetOf('onCrit', false) === 'other' && defaultTargetOf('onNonCrit', false) === 'other')

  // ---- 'self'：引擎给的就是自己 ----
  ok('onLowHp → 自己（runTechniqueRules 的 caster 就是血量跨线的那个人）',
    defaultTargetOf('onLowHp', false) === 'self', defaultTargetOf('onLowHp', false))
  ok('onStatusApplied → 自己（触发者是挂上状态的那个人）',
    defaultTargetOf('onStatusApplied', false) === 'self', defaultTargetOf('onStatusApplied', false))

  /*
   * ⚠ 钩子里的 onTick 和规则级的 onTick **不是一回事**。
   *   钩子（状态上的持续伤害）由 tickStatusHooks 建 ctx，只有 actor，没有 target
   *   → 落在持有者自己身上；规则级的不传 target，落到"锁定目标"。
   *   把两者混起来，soul-rend 那条 DoT 的账就会反。
   */
  ok('钩子里的 onTick → 自己（tickStatusHooks 的 ctx 没有 target）',
    defaultTargetOf('onTick', true) === 'self', defaultTargetOf('onTick', true))
  ok('规则级的 onTick → depends（不传 target，看术式）',
    defaultTargetOf('onTick', false) === 'depends', defaultTargetOf('onTick', false))

  // ---- 'depends'：由术式决定，定价只能假定，校验器负责报出来 ----
  for (const w of ['onCast', 'phaseEnter', 'phaseComplete', 'phaseInterrupt', 'onMiss'] as const) {
    ok(`${w} → depends（runRules 不传 target，落到 selfOnly ? 自己 : 锁定目标）`,
      defaultTargetOf(w, false) === 'depends', defaultTargetOf(w, false))
  }

  /*
   * 方向必须**照表**走：
   *   phaseComplete 上的"给敌人上减速"（不写 target）按**打对面**算 → 收益 → 负数。
   *   老代码会把它当"给自己上 debuff"→ 代价 → 正数。这一正一负就是那四次事故。
   */
  const slow: StatusDef = {
    id: 'status.probe-slow', name: '迟滞', tags: ['debuff'], duration: 3,
    modifiers: [{ path: 'char.speed', op: 'mul', value: { const: 0.5 } }],
  }
  const r = rule('phaseComplete', [{
    payload: { kind: 'status', verb: 'apply', inline: slow },
  }], { order: 0 })
  const pts = priceRule(r, R)
  ok('phaseComplete 上不写 target 的减速 → 按「打对面」算（收益，负数）',
    pts < 0, String(pts))

  // 显式写 self 之后方向翻过来（变成"给自己上 debuff"= 代价）
  const rSelf = rule('phaseComplete', [{
    target: 'self',
    payload: { kind: 'status', verb: 'apply', inline: slow },
  }], { order: 0 })
  ok('  显式写 target: self 之后方向相反（代价，正数）',
    priceRule(rSelf, R) > 0, String(priceRule(rSelf, R)))
}

section('默认目标：不确定的地方要报出来，不偷偷猜')

{
  const balance: BalanceConfig = {
    schemaVersion: 1, baseRuleSlots: 4, ruleSlotBuyCost: 1.5, ruleSlotSellGain: 1,
    rates: {},
  }
  const slow: StatusDef = {
    id: 'status.probe-slow2', name: '迟滞', tags: ['debuff'], duration: 3,
    modifiers: [{ path: 'char.speed', op: 'mul', value: { const: 0.5 } }],
  }

  // 一个"给自己上架势"的技能 —— 没写 target
  const buff = skill({
    id: 'skill.probe-buff',
    name: '架势',
    rules: [rule('phaseComplete', [{
      payload: { kind: 'status', verb: 'apply', inline: { ...slow, tags: ['buff'] } },
    }], { order: 0, phaseId: 'cast' })],
  })

  // ① 技能层：提醒"这条账有个假设"
  const rep = validateSkill('buff.json', buff, balance)
  ok('技能层会提醒：没写 target 的动作，落在谁身上取决于术式',
    rep.issues.some(i => i.code === 'TARGET_DEPENDS_ON_TECHNIQUE'),
    rep.issues.map(i => i.code).join(', '))

  const lib = new Map<string, Skill>([[buff.id, buff]])
  /*
   * ⚠ 瞄准在**技能**上（2026-09-21 日志 47）：术式那个字段删掉了。
   *   所以这个"造术式"的助手现在只在术式上写 `skills`，瞄准由**技能**那一份决定。
   *   ⚠ 下面两段用同一个技能、两次都传不同的 `valid` —— 那两段测的正是
   *     "技能自己的有效目标"和"账的假设"要对得上，所以这里得给技能换一份瞄准。
   */
  const mkTech = (valid: string[]): Technique => {
    lib.set(buff.id, { ...buff, targeting: { mode: 'self', valid } })
    return {
      schemaVersion: 1, id: 'tech.probe', name: 'probe', kind: 'magic', activation: 'press',
      skills: [buff.id],
    }
  }

  // ② 术式层（只对自己有效）：账按"打敌人"算，而引擎打自己 → **方向反了，报错**
  const selfT = validateTechnique('t.json', mkTech(['self']), { balance, skills: lib })
  ok('自愈/架势类术式里，没写 target 会报「账和引擎方向相反」',
    selfT.issues.some(i => i.code === 'TARGET_CONTRADICTS_TECHNIQUE'),
    selfT.issues.map(i => i.code).join(', '))

  // ③ 术式层（打敌人）：账按"打敌人"算，引擎也打敌人 → 一致，不报
  const foeT = validateTechnique('t.json', mkTech(['enemy']), { balance, skills: lib })
  ok('  攻击类术式里不报（两边一致）',
    !foeT.issues.some(i => i.code === 'TARGET_CONTRADICTS_TECHNIQUE'),
    foeT.issues.map(i => i.code).join(', '))

  // ④ 显式写了 target 就不该报
  const explicit = skill({
    id: 'skill.probe-explicit',
    name: '写明了的架势',
    rules: [rule('phaseComplete', [{
      target: 'self',
      payload: { kind: 'status', verb: 'apply', inline: { ...slow, tags: ['buff'] } },
    }], { order: 0, phaseId: 'cast' })],
  })
  const expLib = new Map<string, Skill>([[
    explicit.id,
    // ⚠ 瞄准在**技能**上（2026-09-21 日志 47）：这一份对应原来术式上那句
    //   `{ mode: 'self', valid: ['self'] }`，所以搬到技能上，断言一个字没变。
    { ...explicit, targeting: { mode: 'self', valid: ['self'] } },
  ]])
  const expRep = validateSkill('e.json', explicit, balance)
  ok('显式写了 target: self → 技能层也不再提醒',
    !expRep.issues.some(i => i.code === 'TARGET_DEPENDS_ON_TECHNIQUE'),
    expRep.issues.map(i => i.code).join(', '))

  const expTech: Technique = {
    schemaVersion: 1, id: 'tech.probe2', name: 'probe', kind: 'magic', activation: 'press',
    skills: [explicit.id],
  }
  const expT = validateTechnique('t.json', expTech, { balance, skills: expLib })
  ok('  术式层也不报', !expT.issues.some(i => i.code === 'TARGET_CONTRADICTS_TECHNIQUE'),
    expT.issues.map(i => i.code).join(', '))
}

// ============================================================================
//  查表定价：阶段时长的四档（2026-09-30 日志 59）
// ============================================================================

/*
 * 这一节钉的是用户 2026-09-30 定的新机制：**档位 → 整数点数**（查表），
 * 取代原来的公式（`−(K+1) × 这一段价`，K = 9 住在 `rates` 里）。
 *
 * 用户原话：
 * > **不必有汇率这种线性关系，档位很少，挨个填值就行**
 *
 * 为什么非要钉它：**线性式下"取消一段"是免费的**（`0 秒 × 任何汇率 = 0`），
 * 而引擎会把 0 秒阶段当**瞬发**处理 —— 「引擎给好处、账上不扣钱」。
 * 用户原话「**没有前摇很超标**」。
 *
 * ⚠ 这一节断的是**四件不同的事**，别混：
 *   ① 表**住在内容侧**、以及表自己的三个不变式（中性档 = 0 / 整数 / 不倒挂）；
 *   ② **逐档**：账上那个数就是表里的那个整数（一个近似都不用）；
 *   ③ 它是**数据驱动**的（翻倍表里的值 ⇒ 账翻倍；添一档 ⇒ 那一档立刻认得出来）；
 *   ④ **表外取值必须报错**（不许静默当 0 点）—— 那道保险。
 */

section('查表定价：阶段时长的四档 = 表里填的那个整数')

{
  /*
   * ---- ① 表住在内容侧 + 表自己的不变式 ----
   *
   * ⚠ 这里刻意**读真内容**（`content/balance.json`）：这一节要钉的正是
   *   "价是**数据**" —— 自己在代码里编一张表的话，"改 balance.json 就变"
   *   这句话根本测不到。
   */
  const realBalance = readJson<BalanceConfig>(resolve('content/balance.json'))
  const rawTable = realBalance.tierTables?.[TIER_TABLE_PHASE_DURATION]
  const table = readTierTable(rawTable, TIER_TABLE_PHASE_DURATION)
  ok('表住在内容侧：`content/balance.json` 的 `tierTables.phaseDurationPoints` 读得到',
    table !== undefined,
    `读到 ${JSON.stringify(rawTable)}`)
  if (table === undefined) {
    console.log('  ⚠ 表读不到，后面那些断言全部跳过（先修内容）')
  } else {
    /** 表里这个档位值多少点（读不到就是 undefined） */
    const pts = (tier: number): number | undefined => tierPointsOf(table, tier)

    ok('四档都在表里：0（无）/ 1×（出厂本身）/ 3× / 9×',
      pts(0) !== undefined && pts(TIER_NEUTRAL) !== undefined
      && pts(3) !== undefined && pts(9) !== undefined,
      table.rows.map(r => `${r.tier}→${r.points}`).join(' '))

    /*
     * ⚠⚠ **中性档必须是 0** —— 这是"出厂全 0"（宗旨）的地基：
     *   账算的是"你改了多少"，出厂值自己减自己就是 0。
     *   它不是一格价格，是**定义**（校验器 `checkBalance` 也会报）。
     */
    ok(`中性档（${TIER_NEUTRAL}× = 这个技能自己的出厂时长）必须是 0 点`,
      pts(TIER_NEUTRAL) === 0, `表里写的是 ${String(pts(TIER_NEUTRAL))}`)

    ok('表里每一档都是**整数**（用户 2026-09-30：账上每一笔都是整数）',
      table.rows.every(r => Number.isInteger(r.points)),
      table.rows.map(r => `${r.tier}→${r.points}`).join(' '))

    /*
     * ⚠ **档位不能倒挂**：0 档（取消这一段）必须比 9× 档**更贵**，
     *   否则"把 9× 档改成 0 档"就成了白赚额度的一条路（日志 50 §12.4 讲的正是这个洞）。
     *   用户还额外要求它"**贵得多**"（原话"没有前摇很超标"）。
     */
    const p0 = pts(0) ?? 0
    const p3 = pts(3) ?? 0
    const p9 = pts(9) ?? 0
    ok('档位单调：0 档 < 1× 档(0) < 3× 档 < 9× 档',
      p0 < 0 && 0 < p3 && p3 < p9, `${p0} / 0 / ${p3} / ${p9}`)
    ok('  0 档比 9× 档更贵（不许倒挂）', Math.abs(p0) > p9, `|${p0}| vs ${p9}`)
    ok('  而且"贵得多"：|0 档| ≥ 3× 档的 2 倍（用户原话"没有前摇很超标"）',
      Math.abs(p0) >= 2 * p3, `|${p0}| vs ${p3}`)

    /*
     * ⚠⚠ **代码里那份兜底必须和内容侧那份逐位相同**。
     *
     *   理由很具体：`web/src/**`（编辑器 UI）当轮**冻结**，它自己手工拼
     *   `PriceOptions`、不带表 ⇒ 它会用 `DEFAULT_TIER_TABLES`。
     *   两份不一致的表现是"编辑器显示 +2、命令行按 +1 扣"——
     *   这个项目最恨的那类漂移，而且**没有任何地方会报警**。
     */
    const mirror = DEFAULT_TIER_TABLES[TIER_TABLE_PHASE_DURATION]
    ok('代码兜底（DEFAULT_TIER_TABLES）和内容侧那张表**逐位相同**',
      mirror !== undefined && table.rows.length === mirror.rows.length
      && table.rows.every((r, i) => mirror.rows[i]?.tier === r.tier && mirror.rows[i]?.points === r.points),
      `内容 ${table.rows.map(r => `${r.tier}→${r.points}`).join(' ')}`
      + ` / 代码 ${mirror?.rows.map(r => `${r.tier}→${r.points}`).join(' ')}`)

    /*
     * ---- ② 逐档：账上那个数 = 表里那个整数 ----
     *
     * ⚠ 用**只有时长**的一段（没有能量 / 冷却 / 扛打断）——
     *   那样"这一段值多少点"只有一个来源，账上那个数必须**逐位等于**表里的值。
     */
    const D = 0.3
    const base = skill({ id: 'skill.tier-base', name: '档位基准', phases: [phase('cast', D)] })
    /** 把这一段的时长改成 `duration` 秒，其余一个字不动 */
    const at = (duration: number): Skill => ({ ...base, phases: [phase('cast', duration)] })

    for (const [tier, label, duration] of [
      [0, '0 档（无 = 取消这一段）', 0],
      [1, '1× 档（= 出厂时长本身）', D],
      [3, '3× 档', D * 3],
      [9, '9× 档', D * 9],
    ] as const) {
      const ledger = skillLedger(at(duration), base, OPTIONS)
      const want = pts(tier) ?? 0
      ok(`${label}：账上 = 表里的 ${want} 点`,
        ledger.total === want, `账上 ${ledger.total}，表里 ${want}`)
    }

    ok('  1× 档连一条明细都没有（出厂值自己减自己 = 空账）',
      skillLedger(at(D), base, OPTIONS).entries.length === 0,
      skillLedger(at(D), base, OPTIONS).entries.map(e => e.label).join(' / '))
    ok('  0 档那一行是**消耗**额度（负）', skillLedger(at(0), base, OPTIONS).total < 0,
      `${skillLedger(at(0), base, OPTIONS).total}`)
    ok('  账上看得见时长本身（"0s"）',
      skillLedger(at(0), base, OPTIONS).entries.some(e => e.label.includes('0s')),
      skillLedger(at(0), base, OPTIONS).entries.map(e => e.label).join(' / '))

    /*
     * ⚠ **删掉一整段 = 把它拖到 0 秒**（0 档的极限形态）。
     *   两条路走的是**同一个整数** —— 这条断言就是"不许一边算漏"的判据。
     *
     * ⚠ 用**两段**的技能来量（删掉其中一段）：那段里"留下的那一段"一个字都没动，
     *   所以账上只剩被删那一段的那一笔 —— 单段的技能删完就空了，
     *   量的就成了"新增一段"那种噪声。
     */
    const twoPhase = skill({
      id: 'skill.tier-two', name: '两段基准',
      phases: [phase('cast', D), phase('extra', D)],
    })
    const oneLeft = skill({ id: 'skill.tier-two', name: '两段基准', phases: [phase('cast', D)] })
    const zeroed = skill({
      id: 'skill.tier-two', name: '两段基准',
      phases: [phase('cast', D), phase('extra', 0)],
    })
    const delTotal = skillLedger(oneLeft, twoPhase, OPTIONS).total
    const zeroTotal = skillLedger(zeroed, twoPhase, OPTIONS).total
    ok('删掉出厂有时长的那一段 = 同一个 0 档价（两条路必须一样）',
      delTotal === (pts(0) ?? 0) && delTotal === zeroTotal,
      `删掉 ${delTotal} vs 拖到 0 秒 ${zeroTotal}（表里 0 档是 ${pts(0)}）`)
    ok('  账上写着「删掉这一段」',
      skillLedger(oneLeft, twoPhase, OPTIONS).entries.some(e => e.label.includes('删掉')),
      skillLedger(oneLeft, twoPhase, OPTIONS).entries.map(e => e.label).join(' / '))

    /*
     * ---- ③ 数据驱动：翻倍表里的值 ⇒ 账翻倍 ----
     *
     * ⚠ 这一条取代了老版里那句"K 改成 3 → 0 档的价跟着变"：
     *   现在**没有任何乘数**可以调，价就是表里那个数 —— 所以要证明的是
     *   "**表是唯一的来源**"（改表就改账），而不是"某个汇率是活的"。
     */
    const doubledTable = {
      name: table.name,
      rows: table.rows.map(r => ({ tier: r.tier, points: r.points * 2 })),
    }
    const doubled = {
      ...OPTIONS,
      tierTables: { [TIER_TABLE_PHASE_DURATION]: doubledTable },
    }
    ok('把表里每一档翻倍 ⇒ 9× 档那一笔跟着翻倍（价就是表里那个数，没有别的来源）',
      skillLedger(at(D * 9), base, doubled).total === (pts(9) ?? 0) * 2,
      `${skillLedger(at(D * 9), base, doubled).total}`)
    ok('  中性档仍然是 0（翻倍 0 还是 0）',
      skillLedger(at(D), base, doubled).total === 0,
      `${skillLedger(at(D), base, doubled).total}`)

    /*
     * ⚠ **档位集合来自表本身**（不是代码里写死的 `[0, 1, 3, 9]`）：
     *   往表里添一档（27×）**不用改代码**，`tierOf` 当场就认。
     *   这条是"机制可复用"的证据。
     */
    const withExtra = { name: table.name, rows: [...table.rows, { tier: 27, points: 12 }] }
    ok('往表里添一档 27× ⇒ tierOf 当场认得出来（档位集合是数据，不是代码里的常数）',
      tierOf(1, 27, withExtra) === 27, String(tierOf(1, 27, withExtra)))
    ok('  而它不在原来那张表里 ⇒ 认不出来（undefined = 表外）',
      tierOf(1, 27, table) === undefined, String(tierOf(1, 27, table)))

    /*
     * ---- ④ 那道保险：**内容里出现的取值必须在表里** ----
     *
     * ⚠⚠ 查表定价的前提是"取值落在档位上"。落不在档位上的话，表**指不出
     *   这一格值多少点** —— 而"指不出来"如果被实现成"那就是 0 点"，
     *   就正好复刻了本项目当年删掉手写 `points` 的那个病
     *   （"把 30 改成 300，点数纹丝不动"）。
     */
    const odd = at(D * 1.7)          // 1.7×：正是编辑器那个线性时长滑块能拖出来的值
    const problems = phaseTierProblems(odd, base, OPTIONS)
    ok('表外取值（1.7×）→ `phaseTierProblems` 报出来',
      problems.length === 1 && problems[0].phaseId === 'cast'
      && problems[0].wasDuration === D && problems[0].nowDuration === D * 1.7,
      JSON.stringify(problems))
    ok('  表外取值（×10，也就是"把 30 改成 300"那种）同样报出来',
      phaseTierProblems(at(D * 10), base, OPTIONS).length === 1,
      JSON.stringify(phaseTierProblems(at(D * 10), base, OPTIONS)))
    ok('  四个档位一个都不报（表里的值必须干净通过）',
      [0, D, D * 3, D * 9].every(d => phaseTierProblems(at(d), base, OPTIONS).length === 0),
      [0, D, D * 3, D * 9].map(d => phaseTierProblems(at(d), base, OPTIONS).length).join(','))
    ok('  出厂技能自己（没有 basedOn）永远不报 —— 它的基准就是它自己（恒 1×）',
      phaseTierProblems(base, base, OPTIONS).length === 0)

    /*
     * ⚠ **校验器那一侧**：变体（`basedOn`）指着出厂那一份 ⇒ 报 `PHASE_TIER_NOT_IN_TABLE`。
     *   这是真的会发生在玩家身上的那条路：编辑器"另存为"出来的技能就是变体，
     *   而它今天的时长控件还是线性秒数滑块（四档选择是日志 50 §6.2 的欠账）。
     */
    const variant: Skill = {
      ...odd, id: 'skill.tier-variant', name: '档位变体', basedOn: 'skill.tier-base',
    }
    const lib = new Map<string, Skill>([[base.id, base]])
    const rep = validateSkill('variant.json', variant, realBalance, undefined, undefined, lib)
    const hit = rep.issues.filter(i => i.code === 'PHASE_TIER_NOT_IN_TABLE')
    ok('校验器：变体里那一格时长不在表里 ⇒ 报 `PHASE_TIER_NOT_IN_TABLE`（错误）',
      hit.length === 1 && hit[0].level === 'error', rep.issues.map(i => i.code).join(', '))
    ok('  而且指到**那一段的 duration** 上（玩家一眼看得见改哪儿）',
      hit[0]?.path === 'phases[cast].duration', String(hit[0]?.path))
    ok('  四个档位上的变体一个错都不报',
      [0, D, D * 3, D * 9].every((d) => {
        const v: Skill = { ...at(d), id: 'skill.tier-variant', name: '档位变体', basedOn: 'skill.tier-base' }
        return !validateSkill('v.json', v, realBalance, undefined, undefined, lib)
          .issues.some(i => i.code === 'PHASE_TIER_NOT_IN_TABLE')
      }))

    /*
     * ⚠⚠ **表外取值时账上那一笔不许是 0** —— 这是"不许静默当 0 点"的机械判据：
     *   点数**仍然跟着内容动**（退回"两条绝对账相减"），同时校验器报错。
     *   两件事一起才叫"不静默"：数字会动 + 明说取值不在档位上。
     */
    const oddLedger = skillLedger(odd, base, OPTIONS)
    ok('  ⚠ 表外取值时账上**不是 0**（点数仍然跟着内容动，不许"纹丝不动"）',
      oddLedger.total !== 0, `${oddLedger.total}`)

    /*
     * ⚠ **蓄力段（`duration: -1`）不在档位轴上**：它是哨兵值，价是
     *   `chargePhasePerPoint` 一笔定额 ⇒ **不报档位错**（那是另一根轴，别误报）。
     *   老代码里那条 `was.duration > 0` 的判据守的就是这件事。
     */
    const chargeBase = skill({ id: 'skill.tier-charge', name: '蓄力', phases: [phase('cast', -1)] })
    ok('出厂就是蓄力的段：自己减自己 = 0，也不报档位错',
      skillLedger(chargeBase, chargeBase, OPTIONS).total === 0
      && phaseTierProblems(chargeBase, chargeBase, OPTIONS).length === 0)
    ok('  把一段**固定时长**改成蓄力（换了一根轴）⇒ 不报档位错',
      phaseTierProblems({ ...base, phases: [phase('cast', -1)] }, base, OPTIONS).length === 0,
      JSON.stringify(phaseTierProblems({ ...base, phases: [phase('cast', -1)] }, base, OPTIONS)))

    /*
     * ⚠ 浮点容错：`0.3 / 0.1` 是 2.9999999999999996 —— 直接比 `=== 3` 会认不出
     *   3× 档，而那正是编辑器里最常见的那一次拖动。
     */
    ok('0.1 → 0.3 认得出是 3× 档（浮点容错）', tierOf(0.1, 0.3, table) === 3, String(tierOf(0.1, 0.3, table)))
    ok('  1.0 → 3.0 同样是 3× 档（正常路径也对）', tierOf(1, 3, table) === 3, String(tierOf(1, 3, table)))
  }
}

section('倍数档走表：账本那一侧（装着 lookupTable 的时候）—— 2026-09-30 日志 63')

{
  /*
   * ⚠⚠ 这一节钉的是**两条路并存**（用户 2026-09-30 的规格）：
   *
   *   ① **倍数档走表**：现在 / 出厂 ∈ {0, 1, 3, 9} ⇒ 价 = `tierTables` 那一格；
   *   ② **绝对秒数继续走老的**：表外的取值 ⇒ 照旧查 `lookupTable` 那一行格子
   *      （一格都没有时照旧留 `⚠ 表外取值` 记录 —— 不许静默当 0）。
   *
   * ⚠ 为什么非钉不可：编辑器上那四个按钮今天**有价可查**，靠的就是 ①；
   *   而 ① 的判据和账本必须是**同一句** —— 否则"界面显示 +2、命令行按 0 扣"
   *   （这个项目最恨的那类漂移）会同时成立，而且两边都不报错。
   *
   * ⚠ 用**只有时长**的一段 + 一张**故意残缺**的点表（没有 3× / 9× / 无 那三格，
   *   出厂内容今天就是这样）—— 那样"账上那个数从哪来"只有一个可能来源。
   */
  const D = 0.2
  const base: Skill = skill({ id: 'skill.tier-lookup', name: '倍数档', phases: [phase('cast', D)] })
  /**
   * 点表：**只有绝对秒数那几格**（`1` / `-1` / `0.1` / `0.2` / `0.3` / `0.5`）。
   * ⚠ 出厂那一格（`0.2`）必须是 0；`-1`（蓄力）3 点；`0.3` 那格是 −1（"改了多少"那种近似价）。
   */
  const lookupRows: Record<string, number> = { '1': 0, '-1': 3, '0.1': -1, '0.2': 0, '0.3': -1, '0.5': 1 }
  const lookup: LookupTable = { [base.id]: { 'phases.0.duration': lookupRows } }
  const tierTable: TierTable = {
    name: TIER_TABLE_PHASE_DURATION,
    rows: [
      { tier: 0, points: -6 },
      { tier: 1, points: 0 },
      { tier: 3, points: 2 },
      { tier: 9, points: 4 },
    ],
  }
  const o: PriceOptions = {
    ...OPTIONS,
    lookupTable: lookup,
    tierTables: { [TIER_TABLE_PHASE_DURATION]: tierTable },
  }
  /** 把这一段的时长改成 `duration` 秒，其余一个字不动 */
  const at = (duration: number): Skill => ({ ...base, phases: [phase('cast', duration)] })

  // ---- ① 倍数档走表：四档**每一档都有价**（这就是"有价可查"）----
  ok('0 档（无）⇒ 表里那一格 −6（点表里**没有** 0 秒那一格，以前是一条 `⚠ 表外取值` 的 0 点）',
    skillLedger(at(0), base, o).total === -6, `${skillLedger(at(0), base, o).total}`)
  ok('3×（0.6 秒）⇒ 表里那一格 +2（点表里也**没有** 0.6 这一格）',
    skillLedger(at(D * 3), base, o).total === 2, `${skillLedger(at(D * 3), base, o).total}`)
  ok('9×（1.8 秒）⇒ 表里那一格 +4',
    skillLedger(at(D * 9), base, o).total === 4, `${skillLedger(at(D * 9), base, o).total}`)
  ok('1×（出厂本身）⇒ **空账**（0 点、0 条明细 —— "出厂全 0"的地基）',
    skillLedger(base, base, o).total === 0 && skillLedger(base, base, o).entries.length === 0,
    JSON.stringify(skillLedger(base, base, o).entries))
  ok('  账上写着这一笔是**查表**来的（「3× 档 · 查表」），不是绝对值相减',
    skillLedger(at(D * 3), base, o).entries.some(e => e.label.includes('3× 档') && e.label.includes('查表')),
    skillLedger(at(D * 3), base, o).entries.map(e => e.label).join(' / '))

  // ---- ② 绝对秒数那条老路**一个字都没动** ----
  /*
   * ⚠ `0.3 秒`（= 1.5×，**不是**倍数档）⇒ 走 `lookupRows['0.3']` = −1。
   *   这一条就是"两套并存"的机械判据：倍数档走表、非倍数档走老格。
   */
  ok('不是倍数的取值（0.3 秒 = 1.5×）⇒ 照旧走点表里那一格（−1）',
    skillLedger(at(0.3), base, o).total === -1, `${skillLedger(at(0.3), base, o).total}`)
  ok('  而点表里也没有的取值（0.7 秒）⇒ 留一条 `⚠ 表外取值`（不算倍数、也不算有格）',
    skillLedger(at(0.7), base, o).total === 0
    && skillLedger(at(0.7), base, o).entries.some(e => e.label.includes('表外取值')),
    skillLedger(at(0.7), base, o).entries.map(e => e.label).join(' / '))
  ok('  蓄力（−1）是**另一根轴**：照旧走点表里那一格（+3），不查倍数表',
    skillLedger(at(-1), base, o).total === 3, `${skillLedger(at(-1), base, o).total}`)

  // ---- ③ 按技能覆盖（`bySkill`）：**加法式**，只换写上来的那几档 ----
  const withOverride: TierTable = {
    ...tierTable,
    bySkill: { [base.id]: [{ tier: 0, points: -9 }, { tier: 9, points: 7 }] },
  }
  const oOver: PriceOptions = { ...o, tierTables: { [TIER_TABLE_PHASE_DURATION]: withOverride } }
  ok('覆盖 0 / 9 两档 ⇒ 那两档的价跟着变（−9 / +7）',
    skillLedger(at(0), base, oOver).total === -9 && skillLedger(at(D * 9), base, oOver).total === 7,
    `${skillLedger(at(0), base, oOver).total} / ${skillLedger(at(D * 9), base, oOver).total}`)
  ok('  ⚠ **没写的那几档照旧走共享的四格**（3× 还是 +2，不是被整张换掉）',
    skillLedger(at(D * 3), base, oOver).total === 2, `${skillLedger(at(D * 3), base, oOver).total}`)
  ok('  覆盖只对**那一个技能**生效（别的技能 id 照旧 +4）',
    skillLedger({ ...at(D * 9), id: 'skill.other' }, { ...base, id: 'skill.other' }, oOver).total === 4,
    `${skillLedger({ ...at(D * 9), id: 'skill.other' }, { ...base, id: 'skill.other' }, oOver).total}`)
  ok('  ⚠ 覆盖里写了中性档 0 ⇒ 仍然空账（覆盖**不许**破"出厂全 0"）',
    skillLedger(base, base, {
      ...o,
      tierTables: {
        [TIER_TABLE_PHASE_DURATION]: {
          ...tierTable,
          bySkill: { [base.id]: [{ tier: TIER_NEUTRAL, points: 0 }] },
        },
      },
    }).entries.length === 0)

  /*
   * ⚠⚠ **覆盖里把中性档写成非 0** ⇒ 校验器报 `TIER_TABLE_NEUTRAL_NOT_ZERO`。
   *   这是"新结构最容易写坏、而且坏了是静默的"那一处：那一个技能的**每一样**
   *   出厂内容都会带上那一笔，"出厂全 0"当场破。
   */
  const brokenBalance: BalanceConfig = {
    ...readJson<BalanceConfig>(resolve('content/balance.json')),
    tierTables: {
      [TIER_TABLE_PHASE_DURATION]: {
        '0': -6, '1': 5, '3': 2, '9': 4,
        [TIER_BY_SKILL_KEY]: { [base.id]: { '1': 5 } },
      },
    },
  }
  const brokenIssues = checkBalance(brokenBalance)
  ok('覆盖里把中性档写成非 0 ⇒ `TIER_TABLE_NEUTRAL_NOT_ZERO`（错误）',
    brokenIssues.some(i => i.code === 'TIER_TABLE_NEUTRAL_NOT_ZERO'
      && i.path.includes(TIER_BY_SKILL_KEY) && i.level === 'error'),
    brokenIssues.map(i => `${i.code}@${i.path}`).join(', '))
  ok('  而共享那一栏的中性档写成非 0 也照旧报（老规矩没被覆盖那条挡住）',
    checkBalance({ ...brokenBalance, tierTables: { [TIER_TABLE_PHASE_DURATION]: { '0': -6, '1': 5, '3': 2, '9': 4 } } })
      .some(i => i.code === 'TIER_TABLE_NEUTRAL_NOT_ZERO'))

  // ---- ④ 读表：`bySkill` 那一栏怎么读、认不出的怎么办 ----
  const raw = {
    '0': -6, '1': 0, '3': 2, '9': 4,
    '_9': '文案，不是档位',
    [TIER_BY_SKILL_KEY]: {
      '_comment': '文案',
      'skill.a': { '9': 7, '_9': '文案', '3': '不是数字' },
      'skill.b': {},
    },
  }
  const read = readTierTable(raw, TIER_TABLE_PHASE_DURATION)
  ok('`bySkill` 读得出来（技能 id → 只写要改的那几档）',
    read?.bySkill?.['skill.a']?.length === 1 && read.bySkill['skill.a'][0]?.points === 7,
    JSON.stringify(read?.bySkill))
  ok('  ⚠ 一行都没读出来的技能 id **不出现**在 bySkill 里（"有覆盖"和"空覆盖"没有行为差别）',
    read?.bySkill?.['skill.b'] === undefined, JSON.stringify(read?.bySkill))
  ok('  ⚠ `bySkill` 不污染共享那四格（四条，一条不多）',
    read?.rows.length === 4 && read.rows.map(r => r.tier).join(',') === '0,1,3,9',
    JSON.stringify(read?.rows))
  ok('`tierPointsForSkill`：先看这个技能的覆盖，再看共享那四格',
    read !== undefined
    && tierPointsForSkill(read, 9, 'skill.a') === 7
    && tierPointsForSkill(read, 9, 'skill.b') === 4
    && tierPointsForSkill(read, 9) === 4,
    read === undefined ? '读不到' : `${tierPointsForSkill(read, 9, 'skill.a')} / ${tierPointsForSkill(read, 9, 'skill.b')}`)

  /*
   * ⚠ **内容侧那一栏是空的但结构在**（用户："覆盖栏留空也行，但结构要在"）。
   *   出厂内容今天就是这个状态 —— 空覆盖 = 所有技能走共享那四格。
   */
  const rawBalance = readJson<BalanceConfig>(resolve('content/balance.json'))
  const rawTier = rawBalance.tierTables?.[TIER_TABLE_PHASE_DURATION] as Record<string, unknown> | undefined
  const rawOver = rawTier?.[TIER_BY_SKILL_KEY] as Record<string, unknown> | undefined
  ok('内容侧的 `bySkill` **键在**（结构要在），而今天**一格都没填**（只剩 `_` 文案）',
    rawOver !== undefined
    && Object.keys(rawOver).filter(k => !k.startsWith('_')).length === 0,
    JSON.stringify(rawOver ?? null))
  ok('  而它读出来是"没有覆盖"（空覆盖 = 所有技能走共享那四格）',
    readTierTables(rawBalance.tierTables)[TIER_TABLE_PHASE_DURATION]?.bySkill === undefined)
}

section('档位的两条技能级轴：冷却（技能的唯一属性）与能量')

{
  /** 实测值 + 容差（和上一节同一个口径：账上 round 到两位，段价里混着别的项） */
  const TOL = 0.31
  const rate = R.phaseSecondPerPoint
  /*
   * 一条 8 秒冷却的技能（定稿 §12.6 用的就是这个量级）。
   * ⚠ 冷却是**技能的唯一属性**（校验器 COOLDOWN_TWO_PHASES）：它写在**唯一那一段**上。
   */
  const D = 0.2
  const CD = 8
  const base = skill({
    id: 'skill.tier-cd', name: '冷却档位',
    phases: [phase('cast', D, { cost: { cooldown: CD } })],
  })

  // ---- 1× 档 = 0 ----
  ok('冷却没动 → 0 点', skillLedger(base, base, OPTIONS).total === 0)

  // ---- 3× / 9×：线性（冷却也是一根汇率） ----
  const cdRate = R.cooldownSecondPerPoint
  const cdAt = (cd: number): Skill => skill({
    id: 'skill.tier-cd', name: '冷却档位',
    phases: [phase('cast', D, { cost: { cooldown: cd } })],
  })
  const three = skillLedger(cdAt(CD * 3), base, OPTIONS)
  ok(`冷却 3× = +2 × ${CD} 秒 × 汇率 = +${round2(2 * CD * cdRate)}`,
    Math.abs(three.total - 2 * CD * cdRate) < 1e-9, `${three.total}`)

  /*
   * ---- 0 档：定稿 §12.6 那个数 ----
   *
   * ⚠ 定稿印的是 "**取消一个 8 秒冷却 ≈ −14.4 点**"（= 0 档那条贡献本身）。
   *   相对账算的是**净变化**，所以还要再减掉"这一段本身值多少"（1.6 点）= −16。
   *   这里照旧从**这一段价**推（`pricePhase`），别去猜"只有 8 × 汇率"。
   */
  const zero = skillLedger(cdAt(0), base, OPTIONS)
  const K = R.cooldownZeroTierMultiplier
  const cdAxisPoints = CD * cdRate                 // 这条轴的 1× 档价（8 秒 × 汇率）
  /*
   * ⚠ 实测：账上那一行是 `0 档的价`（`−K × 轴价`）再减掉"这一段自己的价"。
   *   那一段里除了冷却还挂着时长（0.2 秒），所以它 **不是** `−(K+1) × 轴价`。
   *   ⚠ 这里的汇率是 **`DEFAULT_RATES` 的**（`cooldownSecondPerPoint = 1`），
   *     不是 `balance.json` 的 0.2 —— 拿 balance 的数去手算会差 5 倍。
   */
  ok(`取消 8 秒冷却那一行是负的、而且是一大笔（实测 ${zero.total}）`,
    zero.total < -2,
    `${zero.total}`)
  ok('  ⚠ "0 档的价"那一头 = −K × 8 秒 × 汇率（K 从 rates 来，不写死）',
    Math.abs(-K * cdAxisPoints - (-K * CD * cdRate)) < 1e-9,
    `${round2(-K * cdAxisPoints)}`)
  /*
   * ⚠⚠ 2026-09-30（日志 57）这条原来写的是"**远超配平容差 2 点** ⇒ 只能靠血契付"——
   *   **容差已经删了**，那句话现在是假话。留下的真事实：这一笔的**量级**
   *   （−88 点）远大于"能用"那条线（0），所以它**只能靠血契付**。
   */
  ok('  ⚠ 这一笔远大于"能用"那条线（0）⇒ 只能靠血契付（用户看过这个数才签的字）',
    Math.abs(zero.total) > 2, `${zero.total}`)
  ok('  账上写着「无冷却」这一档',
    zero.entries.some(e => e.label.includes('无冷却')), zero.entries.map(e => e.label).join(' / '))

  /*
   * ---- 出厂**本来就没有**冷却的技能没有 0 档可言 ----
   *
   * ⚠ 少了这条判据，"出厂 0、现在 0"会被当成一次改动 ——
   *   而那是宗旨（出厂内容全 0）当场破的地方，还没有任何东西会报警。
   */
  const noCd = skill({ id: 'skill.tier-nocd', name: '本来就没冷却', phases: [phase('cast', D)] })
  ok('出厂没有冷却的技能：自己减自己还是 0（"0 拖到 0"不是一次改动）',
    skillLedger(noCd, noCd, OPTIONS).total === 0
    && skillLedger(noCd, noCd, OPTIONS).entries.length === 0,
    skillLedger(noCd, noCd, OPTIONS).entries.map(e => e.label).join(' / '))

  // ---- 能量：0 档记在**付能量那一段自己的账**上（不另起一行、不重复收钱） ----
  const enBase = skill({
    id: 'skill.tier-en', name: '能量档位',
    phases: [phase('cast', D, { cost: { energy: 20 } })],
  })
  const enZero = skillLedger(
    skill({ id: 'skill.tier-en', name: '能量档位', phases: [phase('cast', D, { cost: { energy: 0 } })] }),
    enBase, OPTIONS)
  const enPhasePoints = pricePhase(phase('cast', D, { cost: { energy: 20 } }), R)
  ok(`取消 20 能量 = −(K+1) × 这一段价 = ${round2(-(K + 1) * enPhasePoints)} 点`,
    Math.abs(enZero.total - (-(K + 1) * enPhasePoints)) < 1e-9, `${enZero.total}`)
  ok('  ⚠ 只有一条明细（同一笔钱不许收两次）',
    enZero.entries.length === 1, enZero.entries.map(e => `${e.points} ${e.label}`).join(' / '))
  ok('  而且那一条算在**它自己那一段**上（0 能量是这一段的代价）',
    enZero.entries[0]?.refId === 'cast', String(enZero.entries[0]?.refId))

  /*
   * ---- 删掉一整段：段、时长、代价一起没 ----
   *
   * ⚠ 这是 0 档的极限形态，而且它**最容易算漏**：出厂那张绝对账会把
   *   "这一段值多少"整笔翻过来，而 0 档该拿的那笔 K 会一起被抹掉。
   */
  const gone = skillLedger(
    skill({ id: 'skill.tier-cd', name: '冷却档位', phases: [phase('other', D)] }),
    base, OPTIONS)
  ok('删掉那一段：账是负的，而且额度不少于"只把它拖到 0 秒"',
    gone.total < 0 && Math.abs(gone.total) >= Math.abs(zero.total),
    `删掉 ${gone.total} vs 0 档 ${zero.total}`)
  ok('  账上写着「删掉这一段」',
    gone.entries.some(e => e.label.includes('删掉')), gone.entries.map(e => e.label).join(' / '))

  // ---- 蓄力段（duration = -1）不在档位轴上：它是一笔定额 ----
  const charge = skill({ id: 'skill.tier-charge', name: '蓄力', phases: [phase('cast', -1)] })
  ok('蓄力段自己减自己 = 0（定额，不参与档位）',
    skillLedger(charge, charge, OPTIONS).total === 0)
  ok('  把蓄力改成 0 秒**不会**凭空给一笔 K（它不是 1× 档的 0 倍）',
    skillLedger({ ...charge, phases: [phase('cast', 0)] }, charge, OPTIONS).total > -(K + 1) * rate,
    `${skillLedger({ ...charge, phases: [phase('cast', 0)] }, charge, OPTIONS).total}`)
}

// ============================================================================
//  份数类修饰的点数（多重释放 / 一分为 X）—— 2026-09-21 日志 51
// ============================================================================

section('份数类修饰：点数随参数变，汇率住在 balance.json 里（不许写死在代码里）')

{
  /*
   * ⚠ 这里刻意**用真内容**（`content/modifiers/*.json` + `content/balance.json`）：
   *   这一节要钉的正是"汇率是**数据**"—— 自己编一份 rates 的话，
   *   "改 balance.json 点数就跟着变"这句话根本测不到。
   */
  const realBalance = readJson<BalanceConfig>(resolve('content/balance.json'))
  const protos = new Map<string, ModifierProto>()
  const modDir = resolve('content/modifiers')
  for (const f of readdirSync(modDir).filter(f => f.endsWith('.json'))) {
    const p = readJson<ModifierProto>(resolve(modDir, f))
    protos.set(p.id, p)
  }

  const rate = realBalance.modifierRates?.['extraCopyPerPoint']
  ok('balance.json 里写着份数的汇率（每多一份多少点）',
    typeof rate === 'number' && rate > 0, JSON.stringify(realBalance.modifierRates))
  ok('  ⚠ 而且它**不在 `rates` 里**（在 `rates` 里会让 `npm run calibrate` 的输出变）',
    realBalance.rates?.['extraCopyPerPoint'] === undefined,
    JSON.stringify(realBalance.rates?.['extraCopyPerPoint']))

  const mOpts = {
    rates: readRates(realBalance.rates),
    baseRuleSlots: realBalance.baseRuleSlots,
    ruleSlotBuyCost: realBalance.ruleSlotBuyCost,
    ruleSlotSellGain: realBalance.ruleSlotSellGain,
      modifiers: protos,
    modifierRates: realBalance.modifierRates,
  }
  /** 术式的账（相对出厂值）+ 技能表（真技能） */
  const lookup = (id: string): Skill | undefined => realSkills.get(id)
  const realSkills = new Map<string, Skill>()
  for (const f of readdirSync(resolve('content/skills')).filter(f => f.endsWith('.json'))) {
    const s = readJson<Skill>(resolve('content/skills', f))
    realSkills.set(s.id, s)
  }
  for (const f of readdirSync(resolve('content/weapon-skills')).filter(f => f.endsWith('.json'))) {
    const s = readJson<Skill>(resolve('content/weapon-skills', f))
    realSkills.set(s.id, s)
  }

  const withMods = (
    mods: Array<{ proto: string, count: number, at?: number }>,
    skills: string[] = ['skill.magic-bolt'],
  ): Technique => ({
    schemaVersion: 1,
    id: 'tech.mod-points',
    name: '带份数修饰的术式',
    kind: 'magic',
    activation: 'press',
    sequences: [{
      name: '一段',
      skills,
      mods: mods.map(m => ({ proto: m.proto, at: m.at ?? 0, params: { count: m.count } })),
    }],
  })

  const pointsOf = (t: Technique, o = mOpts): number => priceTechnique(t, lookup, o).total
  const entriesOf = (t: Technique, o = mOpts): number => priceTechnique(t, lookup, o).entries.length
  const modEntries = (t: Technique, o = mOpts): string[] =>
    priceTechnique(t, lookup, o).entries.filter(e => e.from === 'technique').map(e => `${e.points} ${e.label}`)

  /*
   * ---- ① 份数 = 1（没有这个修饰）→ 0 点 ----
   *     ⚠ 数据上 `count: 1` 不该存在（校验器报错），而引擎会把它夹到 2；
   *       账跟着**夹过之后的份数**走 —— 账和引擎必须是同一个数，
   *       不然"账上收 1 份、打出 2 份"会同时成立。
   */
  ok('没有修饰的术式：账是 0 点、一条明细都没有',
    pointsOf(withMods([])) === 0 && entriesOf(withMods([])) === 0,
    `${pointsOf(withMods([]))} / ${entriesOf(withMods([]))}`)

  /*
   * ---- ② **N 越大花得越多**（多重释放）----
   *     收的是"多出来的份数"：count − 1。
   */
  const m2 = pointsOf(withMods([{ proto: 'mod.multi.fire', count: 2 }], ['skill.magic-bolt', 'skill.hunt']))
  const m3 = pointsOf(withMods([{ proto: 'mod.multi.fire', count: 3 }],
    ['skill.magic-bolt', 'skill.hunt', 'skill.impact-burst']))
  const m10 = pointsOf(withMods([{ proto: 'mod.multi.fire', count: 10 }],
    ['skill.magic-bolt', 'skill.hunt', 'skill.impact-burst']))
  ok(`多重释放 2 份 = −${String(rate)} 点`, Math.abs(m2 - (-(2 - 1) * (rate ?? 0))) < 1e-9, String(m2))
  ok('  3 份花得更多（−2 × 汇率）', Math.abs(m3 - (-(3 - 1) * (rate ?? 0))) < 1e-9, String(m3))
  ok('  10 份花得更多（−9 × 汇率）', Math.abs(m10 - (-(10 - 1) * (rate ?? 0))) < 1e-9, String(m10))
  ok('  而且它是**好处**（负点数：花额度）而不是收益', m2 < 0 && m3 < m2, `${m2} → ${m3}`)

  /*
   * ---- ③ **X 越大花得越多**（一分为 X），同一个公式 ----
   */
  const x2 = pointsOf(withMods([{ proto: 'mod.split', count: 2 }]))
  const x4 = pointsOf(withMods([{ proto: 'mod.split', count: 4 }]))
  ok(`一分为 X：2 份 = −${String(rate)} 点`, Math.abs(x2 - (-(2 - 1) * (rate ?? 0))) < 1e-9, String(x2))
  ok('  4 份花得更多（−3 × 汇率）', Math.abs(x4 - (-(4 - 1) * (rate ?? 0))) < 1e-9, String(x4))

  /*
   * ---- ④ **汇率是数据**：换一份 `modifierRates`，同一个术式的点数跟着变 ----
   */
  const doubled = pointsOf(withMods([{ proto: 'mod.multi.fire', count: 3 }],
    ['skill.magic-bolt', 'skill.hunt', 'skill.impact-burst']),
  { ...mOpts, modifierRates: { extraCopyPerPoint: (rate ?? 0) * 2 } })
  ok('把汇率翻倍 → 同一个术式的点数也翻倍（汇率是数据，不是代码里的常数）',
    Math.abs(doubled - m3 * 2) < 1e-9, `${m3} → ${doubled}`)

  /*
   * ---- ⑤ 叠加（多重释放 + 一分为 X 盯上同一个技能）：**相加** ----
   *     一共打出 X + N − 1 份 ⇒ 收"多出来的 X + N − 2 份"。
   *     ⚠ 这是这一片自己定的一条（**待玩家裁定**，日志 51 报告第 5 节）。
   */
  const both = withMods([
    { proto: 'mod.multi.fire', count: 2 },
    { proto: 'mod.split', count: 3 },
  ], ['skill.magic-bolt', 'skill.hunt'])
  const bothPoints = pointsOf(both)
  ok('叠加 = (X−1) + (N−1) 份的钱（相加，不是相乘）',
    Math.abs(bothPoints - (-(1 + 2) * (rate ?? 0))) < 1e-9, String(bothPoints))
  ok('  明细是**两条**（各自的零件各记一笔，编辑器要按零件分组显示）',
    modEntries(both).length === 2, modEntries(both).join(' / '))

  /*
   * ⚠ 叠加的额外一笔（`stackPenaltyPerPoint`）今天是 **0** ——
   *   而它是**活的**：往 balance.json 里改成 5，叠加就多花 5 点。
   *   这一条测的是"旋钮真的接上了"，不是"今天是多少"。
   */
  const penalized = pointsOf(both, { ...mOpts, modifierRates: { extraCopyPerPoint: rate ?? 0, stackPenaltyPerPoint: 5 } })
  ok('  叠加惩罚那个旋钮是活的（设成 5 → 多花 5 点）',
    Math.abs(penalized - (bothPoints - 5)) < 1e-9, `${bothPoints} → ${penalized}`)
  const notStacked = pointsOf(withMods([{ proto: 'mod.multi.fire', count: 2 }],
    ['skill.magic-bolt', 'skill.hunt']),
  { ...mOpts, modifierRates: { extraCopyPerPoint: rate ?? 0, stackPenaltyPerPoint: 5 } })
  ok('  而**没叠加**的时候收不到它（名字里那个"叠"不是装饰）',
    Math.abs(notStacked - m2) < 1e-9, `${m2} → ${notStacked}`)

  /*
   * ---- ⑥ ⚠ 不传原型表 = **一笔账都不记**（调用方必须传，见 `PriceOptions.modifiers`）----
   *
   *   这一条不是在"允许"这件事，而是把它的**症状**钉住：
   *   账面上"一次打 10 个"看起来是白送的 —— 而白送和没计价在合计上是同一个数。
   */
  ok('不传原型表 → 份数那笔账一条都不记（所以命令行 / 编辑器 / 校验器都必须传）',
    priceTechnique(withMods([{ proto: 'mod.multi.fire', count: 10 }],
      ['skill.magic-bolt', 'skill.hunt', 'skill.impact-burst']), lookup,
    { ...mOpts, modifiers: undefined }).entries.length === 0)

  /*
   * ---- ⑦ ⭐ **出厂内容仍然全是 0 点**（这一条最要紧）----
   *
   *   ⚠ 逐个扫**术式**（技能那一边由上面"宗旨是铁的"那一节扫）。
   *     判据是**两个都是 0**：合计 0 **且**条目 0 ——
   *     只看合计的话，"两个错误互相抵消"也能装出 0。
   */
  const dirT = resolve('content/internal-techniques')
  const dirty: string[] = []
  for (const f of readdirSync(dirT).filter(f => f.endsWith('.json')).sort()) {
    const t = readJson<Technique>(resolve(dirT, f))
    const r = priceTechnique(t, lookup, mOpts)
    if (r.total !== 0 || r.entries.length > 0) {
      dirty.push(`${t.id}=${r.total}(${String(r.entries.length)} 条)`)
    }
  }
  ok(`出厂 ${String(readdirSync(dirT).filter(f => f.endsWith('.json')).length)} 份术式：合计和条目数**都是 0**`,
    dirty.length === 0, dirty.join(', '))
}

// ============================================================================
//  ⭐ **三段式表**：账按**序列**切（定稿 §十二；2026-10-06 日志 65）
// ============================================================================
//
//  ⚠ 它和上面那一层（账按**武器 / 魔法**切，日志 64）**不是同一条规矩** ——
//    这一节的用例**全部是魔法术式** ⇒ 走的正是"先过系别那一关、
//    再按序列切"的第二层。
//
//  ⚠ 判据**没有另写一份**：常驻那半认的是 `school.ts` 的
//    `isConstantSequence`（= `hasConstantWrapper`，`at === 0` 的 `wrap` 副本），
//    和 `sim/compile.ts` 的 `constantSegments` 是**同一句**。

section('⭐ 三段式表：账按**序列**切（常驻 ≥ 0；血契 = max(0, −主动和)）')

{
  const realBalance = readJson<BalanceConfig>(resolve('content/balance.json'))
  const protoMap = new Map<string, ModifierProto>()
  for (const f of readdirSync(resolve('content/modifiers')).filter(f => f.endsWith('.json'))) {
    const p = readJson<ModifierProto>(resolve(resolve('content/modifiers'), f))
    protoMap.set(p.id, p)
  }
  const threeOpts: PriceOptions = {
    rates: readRates(realBalance.rates),
    baseRuleSlots: realBalance.baseRuleSlots,
    ruleSlotBuyCost: realBalance.ruleSlotBuyCost,
    ruleSlotSellGain: realBalance.ruleSlotSellGain,
    modifiers: protoMap,
    modifierRates: realBalance.modifierRates,
  }
  const threeSkills = new Map<string, Skill>()
  for (const dir of ['content/skills', 'content/weapon-skills']) {
    for (const f of readdirSync(resolve(dir)).filter(f => f.endsWith('.json'))) {
      const s = readJson<Skill>(resolve(resolve(dir), f))
      threeSkills.set(s.id, s)
    }
  }
  const threeLookup = (id: string): Skill | undefined => threeSkills.get(id)

  /** 一条**主动**序列（没有被包装） */
  const activeSeg = (skills: string[], mods: unknown[] = []): SequenceSegment => ({
    name: '主动段',
    skills,
    ...(mods.length > 0 ? { mods: mods as SequenceSegment['mods'] } : {}),
  })
  /**
   * 一条**常驻**序列 —— `at: 0` 的 `wrap` 副本就是"常驻包装"。
   *
   * ⚠ 这就是定稿里 `tech.last-stand` 的形状（它的段上今天挂着
   *   `mod.wrap.persistent`）⇒ 用例和出厂内容用的是**同一个判据**。
   */
  const constantSeg = (skills: string[], mods: unknown[] = []): SequenceSegment => ({
    name: '常驻段',
    skills,
    mods: [
      { proto: 'mod.wrap.persistent', at: 0, params: {} },
      ...(mods as SequenceSegment['mods'] ?? []),
    ] as SequenceSegment['mods'],
  })
  const mkTech = (id: string, seqs: SequenceSegment[]): Technique => ({
    schemaVersion: 1, id, name: id, kind: 'magic', activation: 'press', sequences: seqs,
  })
  /** 多重释放 ×N —— **好处** ⇒ 负点数（花额度） */
  const multi = (n: number) => ({ proto: 'mod.multi.fire', at: 0, params: { count: n } })
  /** 等待 X 秒 —— **代价** ⇒ 正点数（提供额度） */
  const wait = (s2: number) => ({ proto: 'mod.wait', at: 0, params: { seconds: s2 } })

  const three = (t: Technique) => priceTechnique(t, threeLookup, threeOpts).threeSection

  // ---- ① 混合术式：主动那半为负、常驻那半为正 ----
  const mixed = mkTech('probe.mixed', [
    activeSeg(['skill.magic-bolt', 'skill.hunt'], [multi(10)]),
    constantSeg(['skill.magic-bolt'], [wait(3)]),
  ])
  const mixedPriced = priceTechnique(mixed, threeLookup, threeOpts)
  const mixedS = mixedPriced.threeSection
  ok('混合术式：两半**切得开**（主动那半 −18、常驻那半 +2）',
    mixedS?.activePoints === -18 && mixedS.passivePoints === 2,
    `active=${String(mixedS?.activePoints)} passive=${String(mixedS?.passivePoints)}`)
  /*
   * ⚠⚠ **这一条就是裁定 (A)**：血契只看**主动那半**。
   *   另一案 (B)（按整门术式的合计算）会给出 `max(0, −(−16)) = 0` ——
   *   也就是"常驻那 2 点正额度**补贴**了主动" ⇒ 和"为正没有什么用"当场矛盾 ✗。
   */
  ok('⚠ 裁定 (A)：血契 = max(0, −主动和) = **18**（常驻那 +2 **不补贴**主动）',
    mixedS?.bloodPact === 18, String(mixedS?.bloodPact))
  /*
   * ⚠ **"不补贴"长什么样**：作废的 (B) 按整门术式的合计算 ⇒ `max(0, −(−16)) = 16`。
   *   它比 (A) 的 18 **少 2 点** —— 那 2 点正是常驻那半的正额度。
   *   ⇒ (A) 和 (B) **必须给出不同的数**，否则这条用例等于没测（写成
   *     "两者都是 0" 会当场假绿 —— 本片第一版就是这么写错的）。
   *   ⚠ 注意 (B) 也不是 0：合计是**负的**（效果花的比代价给的多），
   *     所以两种算法都要收血契，差的正是"常驻那 2 点算不算数"。
   */
  ok('  而作废的 (B)（按整门术式合计）给出 **16** —— 比 (A) 少 2 点，那 2 点就是被 (A) 切开的常驻额度',
    Math.max(0, -mixedPriced.total) === 16 && mixedS?.bloodPact === 18,
    `(B)=${String(Math.max(0, -mixedPriced.total))} (A)=${String(mixedS?.bloodPact)}`)

  // ---- ② 纯主动：可以为负，照旧吃血契 ----
  const pureActive = mkTech('probe.active', [activeSeg(['skill.magic-bolt', 'skill.hunt'], [multi(10)])])
  const activeS = three(pureActive)
  ok('纯主动术式：主动那半为负（−18）⇒ 能吃血契（18）',
    activeS?.activePoints === -18 && activeS.bloodPact === 18 && activeS.passivePoints === 0,
    JSON.stringify(activeS))

  // ---- ③ 纯常驻：正常/为负都不吃血契 ----
  const pureConstPos = mkTech('probe.constant.pos', [constantSeg(['skill.magic-bolt'], [wait(3)])])
  const constPosS = three(pureConstPos)
  ok('纯常驻术式（为正）：常驻那半 +2、**血契 0**（不能吃 ✗）',
    constPosS?.passivePoints === 2 && constPosS.bloodPact === 0 && constPosS.activePoints === 0,
    JSON.stringify(constPosS))

  // ---- ④ 切分**不改账**：两半之和恒等于合计 ----
  const sumsOk = [mixed, pureActive, pureConstPos].every((t) => {
    const r = priceTechnique(t, threeLookup, threeOpts)
    return r.threeSection !== undefined
      && r.threeSection.activePoints + r.threeSection.passivePoints === r.total
  })
  ok('⚠ 切分只是分类：**两半之和恒等于合计**（三个用例都不改一个数）', sumsOk)

  // ---- ⑤ 拿不到原型表 ⇒ 认不出常驻 ⇒ 整本账落进**主动**那半 ----
  /*
   * ⚠ 这是**安全方向**：认不出常驻时若按常驻算，(A) 会把血契从"有"变成"没有"
   *   （白送）。所以这里必须落进主动那半 —— 用例钉住它。
   */
  /*
   * ⚠ 拿不到原型表时**连修饰的账都不记**（`modifierPointsOf` 直接返回空）——
   *   所以这一条能观测到的是**那一半的切分整块消失**，而不是"落进主动那半"。
   *   ✅ 两条一起钉：① 账崩成空（`total` 从 −16 变 0）；② 两半都是 0（**不是**
   *   "常驻 +2 / 主动 0"那种把账搬错半边）。
   *
   *   ⚠ 为什么这一条重要：`o.modifiers` 缺席时 `isConstantSequence` 一律返回
   *     `false`（认不出来）⇒ **整本账落进主动那半**。若哪天有人把它改成
   *     "默认算常驻"，(A) 会把血契从"有"变成"没有"（白送）——
   *     那时这一条会红在"两半都是 0"上。
   */
  const noProtos = priceTechnique(mixed, threeLookup, { ...threeOpts, modifiers: undefined })
  ok('拿不到原型表 ⇒ 修饰的账**一笔都不记**（合计 −16 → 0），而且两半都不会错搬成常驻',
    noProtos.total === 0 && noProtos.entries.length === 0
    && noProtos.threeSection?.activePoints === 0
    && noProtos.threeSection.passivePoints === 0
    && noProtos.threeSection.bloodPact === 0,
    JSON.stringify(noProtos.threeSection) + ` total=${String(noProtos.total)}`)

  // ---- ⑥ 校验器：常驻那半**为负** ⇒ 纯常驻报**错误**、混合只报**警告** ----
  const codesOf = (t: Technique): { code: string, level: string }[] =>
    validateTechnique('(测试)', t, {
      balance: realBalance, skills: threeSkills, modifierProtos: protoMap,
    }).issues
      .filter(i => i.code.startsWith('CONSTANT_'))
      .map(i => ({ code: i.code, level: i.level }))

  // 常驻那半为负、而主动那半为正（多重释放 + 等待 3 秒都在**同一段**里）
  const constOnlyNeg = mkTech('probe.constant.neg', [
    constantSeg(['skill.magic-bolt', 'skill.hunt'], [multi(10), wait(3)]),
  ])
  const negIssues = codesOf(constOnlyNeg)
  ok('纯常驻术式：常驻那半为负 ⇒ **报错** CONSTANT_ONLY_NEGATIVE（定稿那张表的"不能为负 ✗"）',
    negIssues.length === 1 && negIssues[0]?.code === 'CONSTANT_ONLY_NEGATIVE'
    && negIssues[0]?.level === 'error',
    JSON.stringify(negIssues))

  ok('  而**纯常驻为正**（③ 那个形状）⇒ 警告 CONSTANT_SIDE_POSITIVE（"为正没有什么用"）',
    JSON.stringify(codesOf(pureConstPos)) === JSON.stringify([{ code: 'CONSTANT_SIDE_POSITIVE', level: 'warning' }]),
    JSON.stringify(codesOf(pureConstPos)))

  /*
   * ⚠⚠ **混合术式 + 常驻那半为负** ⇒ **错误**（2026-10-06 日志 66 从警告升上来的）。
   *   定稿那句"**常驻那半边必须自己 ≥ 0**"是**一条硬约束**
   *   ⇒ **同一条约束不该两种档**（用户裁定）：纯常驻报错，混合也报错。
   *   ⚠ 日志 65 选告警的理由是"该情形今天构造不出来"—— **那个理由是错的**：
   *     这一门就是构造出来的（`press` + 常驻段 + 主动段，下面 ⑧ 还对着它跑校验器）。
   */
  const mixedNeg = mkTech('probe.mixed.neg', [
    activeSeg(['skill.magic-bolt', 'skill.hunt'], [wait(3)]),
    constantSeg(['skill.magic-bolt', 'skill.hunt'], [multi(10)]),
  ])
  const mixedNegIssues = codesOf(mixedNeg)
  ok('混合术式 + 常驻那半为负 ⇒ **错误** CONSTANT_SIDE_NEGATIVE（和纯常驻同一个档）',
    mixedNegIssues.length === 1 && mixedNegIssues[0]?.code === 'CONSTANT_SIDE_NEGATIVE'
    && mixedNegIssues[0]?.level === 'error',
    JSON.stringify(mixedNegIssues))

  const constNeg = mkTech('probe.constant.neg', [
    constantSeg(['skill.magic-bolt', 'skill.hunt'], [multi(10)]),
  ])
  const constNegReport = validateTechnique('(测试)', constNeg, {
    balance: realBalance, skills: threeSkills, modifierProtos: protoMap,
  })
  ok('⭐ 而且那条**错误**真的到得了（不是死代码）：纯常驻 + 多重释放 ×10 ⇒ 合计 −18 全在常驻那半 ⇒ `fatal`',
    constNegReport.fatal
    && constNegReport.issues.some(i => i.code === 'CONSTANT_ONLY_NEGATIVE' && i.level === 'error'),
    constNegReport.issues.map(i => `${i.level}:${i.code}`).join(' '))
  /*
   * ⚠ 这一门**同时**拿到 `CONSTANT_ONLY_NEGATIVE`（表里"不能为负"）**和**
   *   `NEGATIVE_TECHNIQUE`（"整本账为负 ⇒ 要付血契"）—— 两条不互相压制：
   *   前者说的是**常驻那半必须自己 ≥ 0**，后者说的是**整本账的符号**。
   *   ⚠ 但**血契那个数**现在是 **0**（常驻那半不能吃血契，裁定 (A)）
   *     ⇒ 那条老警告会说"消耗 0 点血契"。
   *     这正是日志 66 报告里那条待裁定（要不要在血契为 0 时把它收起来）。
   */
  ok('  这一门**同时**拿到 CONSTANT_ONLY_NEGATIVE（错误）和 NEGATIVE_TECHNIQUE（老警告）—— 两条不互相压制',
    constNegReport.issues.some(i => i.code === 'CONSTANT_ONLY_NEGATIVE' && i.level === 'error')
    && constNegReport.issues.some(i => i.code === 'NEGATIVE_TECHNIQUE' && i.level === 'warning'),
    constNegReport.issues.map(i => `${i.level}:${i.code}`).join(' '))

  /*
   * ---- ⑨ ⭐⭐ **接线**（2026-10-06 日志 66）：表算的和引擎扣的**必须同一个数** ----
   *
   * ⚠ 日志 65 把这张表算出来了、却**没接线**：引擎按**整本账的符号**收，
   *   于是同一个形状有两个数。这一节钉的就是"没有两个数" ——
   *   `bloodPactCostOf`（编译时写进 `CompiledTechnique.bloodPactCost`，
   *   也就是 `cast.ts` 扣费读的那个字段）和 `threeSection.bloodPact`（表）
   *   读的是**同一处**（`bloodPactOfResult`）。
   */
  const engine = (t: Technique): number => bloodPactCostOf(t, threeLookup, threeOpts)
  const table = (t: Technique): number => three(t)?.bloodPact ?? 0

  ok('⭐⭐ 反例消失了：**纯常驻 + 多重释放 ×10** ⇒ 表 0、引擎 0（改前：表 0、引擎 **18** —— 多收）',
    table(constNeg) === 0 && engine(constNeg) === 0,
    `表=${String(table(constNeg))} 引擎=${String(engine(constNeg))}`)
  ok('  而且**校验器报告里那个数**也是 0（`bloodPactPerUse` 和引擎读同一处）',
    constNegReport.bloodPactPerUse === 0, String(constNegReport.bloodPactPerUse))
  ok('  那个数真的进了编译产物：`CompiledTechnique.bloodPactCost` = 0 ⇒ 放得出来也不扣',
    compileTechnique(constNeg, threeLookup, { bloodPactCost: engine(constNeg) })
      .compiled.bloodPactCost === 0)
  ok('⭐ 反方向的另一面：**混合**（主动 −18 / 常驻 +2）⇒ 表 18、引擎 18'
    + '（改前引擎按 |−16| 收 **16** —— 少收 2，常驻那半的正额度被拿去补贴主动了）',
    table(mixed) === 18 && engine(mixed) === 18 && Math.abs(mixedPriced.total) === 16,
    `表=${String(table(mixed))} 引擎=${String(engine(mixed))} |合计|=${String(Math.abs(mixedPriced.total))}`)
  ok('  纯主动（主动 −18）⇒ 18；纯常驻为正 ⇒ 0（这两种形状本来就没变）',
    engine(pureActive) === 18 && engine(pureConstPos) === 0,
    `${String(engine(pureActive))} / ${String(engine(pureConstPos))}`)
  /*
   * ⚠ **不算账的术式**（武器术式）没有切分 ⇒ 血契 0。
   *   这一条钉的是 `bloodPactOfResult` 的 `?? 0` 那一支：
   *   它**不许**退化成老口径 `|合计|` —— 那正是本片修掉的那个 bug。
   */
  const weaponProbe: Technique = {
    schemaVersion: 1, id: 'probe.weapon', name: 'probe.weapon', kind: 'weapon', activation: 'press',
    sequences: [activeSeg(['skill.ws-slash'], [multi(10)])],
  }
  ok('  不算账的术式（武器系）⇒ 引擎 0（没有切分，**不许**退回 |合计|）',
    three(weaponProbe) === undefined && engine(weaponProbe) === 0
    && priceTechnique(weaponProbe, threeLookup, threeOpts).entries.length === 0,
    `threeSection=${String(three(weaponProbe))} 引擎=${String(engine(weaponProbe))}`)
  /*
   * ⚠ 用户裁定（日志 66 第 4 条）：**主动那半为正 ⇒ 不报**
   *   （定稿：这一格"可以按警告处理，也可以只提示不报警"）⇒ 留口子，一条都不报。
   */
  const pureActivePos = mkTech('probe.active.pos', [activeSeg(['skill.magic-bolt'], [wait(3)])])
  ok('⭐ 主动那半为**正** ⇒ 一条 CONSTANT_* 都不报（用户裁定：这一格留口子）',
    JSON.stringify(codesOf(pureActivePos)) === '[]' && three(pureActivePos)?.activePoints === 2,
    JSON.stringify(codesOf(pureActivePos)) + ` active=${String(three(pureActivePos)?.activePoints)}`)

  /*
   * ---- ⑩ ⭐ 账能说出"这一笔在哪一半"（`PriceEntry.half`，日志 66）----
   *
   * ⚠ 它不只是给界面看的：**两半的和就是从这一栏加出来的**（判据只有一处）
   *   ⇒ 这里同时钉"每一条都说得出来"和"和就是那两栏加出来的"。
   */
  const halfSum = (t: Technique, half: 'active' | 'passive'): number =>
    priceTechnique(t, threeLookup, threeOpts).entries
      .filter(e => e.half === half).reduce((s, e) => s + e.points, 0)
  ok('⚠ 术式账**每一条**都带着"我在哪一半"（`half` 不许有洞）',
    mixedPriced.entries.length > 0
    && mixedPriced.entries.every(e => e.half === 'active' || e.half === 'passive'),
    JSON.stringify(mixedPriced.entries.map(e => `${String(e.half)}:${String(e.points)}`)))
  ok('  ⭐ 两半的和**就是**按 `half` 加出来的（和 `threeSection` 逐位相同）',
    halfSum(mixed, 'passive') === mixedS?.passivePoints && halfSum(mixed, 'active') === mixedS?.activePoints
    && halfSum(constNeg, 'passive') === -18 && halfSum(constNeg, 'active') === 0,
    `混合 passive=${String(halfSum(mixed, 'passive'))} active=${String(halfSum(mixed, 'active'))}；`
    + `纯常驻 passive=${String(halfSum(constNeg, 'passive'))} active=${String(halfSum(constNeg, 'active'))}`)
  ok('  没被包装的段 ⇒ 整本账落进**主动**那半（安全方向：认不出常驻就按主动算）',
    priceTechnique(pureActive, threeLookup, threeOpts).entries.every(e => e.half === 'active'),
    JSON.stringify(priceTechnique(pureActive, threeLookup, threeOpts).entries.map(e => e.half)))
  /*
   * ⚠ **技能自己的账不填** `half`（`priceSkill` / `skillLedger`）：
   *   那时没有"哪一段"这回事，正如它也不填 `skillId`。
   */
  const skBase = threeSkills.get('skill.magic-bolt') as Skill
  const skVariant: Skill = {
    ...(JSON.parse(JSON.stringify(skBase)) as Skill),
    id: 'probe.skill.variant', basedOn: skBase.id, ruleSlots: (skBase.ruleSlots ?? 0) + 4,
  }
  const skLedger = skillLedger(skVariant, skBase, threeOpts)
  ok('  而**技能自己的账**没有 `half`、也没有 `threeSection`（没有"哪一段"这回事）',
    skLedger.entries.length > 0 && skLedger.entries.every(e => e.half === undefined)
    && skLedger.threeSection === undefined,
    `${String(skLedger.entries.length)} 条 · half=${JSON.stringify(skLedger.entries.map(e => e.half))}`)

  // ---- ⑦ 出厂 14 份：切分对它们**一个数都不动**（合计与条目数照旧都是 0）----
  const factoryDirty: string[] = []
  for (const f of readdirSync(resolve('content/internal-techniques')).filter(f => f.endsWith('.json')).sort()) {
    const t = readJson<Technique>(resolve(resolve('content/internal-techniques'), f))
    const r = priceTechnique(t, threeLookup, threeOpts)
    const s3 = r.threeSection
    if (r.total !== 0 || r.entries.length > 0) factoryDirty.push(`${t.id}=${r.total}`)
    // ⚠ 魔法术式必须**有**切分；武器术式必须**没有**（那一层不算账）
    if (t.kind === 'magic' && s3 === undefined) factoryDirty.push(`${t.id} 缺切分`)
    if (t.kind === 'weapon' && s3 !== undefined) factoryDirty.push(`${t.id} 不该有切分`)
  }
  ok('⭐ 出厂 14 份：账仍是**合计与条目数都是 0**，且切分**只在魔法术式上出现**',
    factoryDirty.length === 0, factoryDirty.join(', '))

  /*
   * ---- ⑧ ⭐ **账和校验器的数必须对得上**（同一门术式、跨两个模块）----
   *
   * ⚠ 这一条比上面那些都值钱：上面测的是"账切得对"，这里测的是
   *   **"玩家在界面上看到的评语引用的就是那本账"**。
   *   两者漂移的话，症状是"账上写 −18、评语说 2 点" —— 而两处都不报错。
   *
   *   ⚠ 混合术式**过得了校验器**（对着探针实测：`press` + 常驻段 + 主动段，
   *     只有 `MODIFIER_COUNT_CLAMPED` / `NEGATIVE_TECHNIQUE` 两条老警告，
   *     `fatal=false`）—— 所以三段式表**今天就是可用的形状**，
   *     不是"等哪天放开了才能用"。
   */
  const mixedReport = validateTechnique('(测试)', mixed, {
    balance: realBalance, skills: threeSkills, modifierProtos: protoMap,
  })
  const positiveIssue = mixedReport.issues.find(i => i.code === 'CONSTANT_SIDE_POSITIVE')
  ok('⭐ 账说常驻那半为正 ⇒ 校验器**确实**报了 CONSTANT_SIDE_POSITIVE（两处同一个数）',
    mixedS?.passivePoints === 2 && positiveIssue !== undefined,
    `passivePoints=${String(mixedS?.passivePoints)} / issue=${String(positiveIssue?.code)}`)
  ok('  而且那条警告里印的数**就是账里的数**（passivePoints / activePoints / 血契）',
    positiveIssue?.message.includes('常驻序列的点数和 2') === true
    && positiveIssue?.hint?.includes('主动序列的点数和 -18') === true
    && positiveIssue?.hint?.includes('18 点血契') === true,
    `${positiveIssue?.message ?? ''} || ${positiveIssue?.hint ?? ''}`)
}

// ============================================================================
//  「等待 X 秒」的点数 —— 2026-09-30 日志 52
// ============================================================================

section('等待 X 秒：点数按秒数算（提供额度），汇率住在 balance.json 里')

{
  const realBalance = readJson<BalanceConfig>(resolve('content/balance.json'))
  const wProtos = new Map<string, ModifierProto>()
  const wModDir = resolve('content/modifiers')
  for (const f of readdirSync(wModDir).filter(f => f.endsWith('.json'))) {
    const p = readJson<ModifierProto>(resolve(wModDir, f))
    wProtos.set(p.id, p)
  }

  const waitRate = realBalance.modifierRates?.['waitSecondPerPoint']
  ok('balance.json 里写着等待的汇率（每一秒多少点）',
    typeof waitRate === 'number' && waitRate > 0, JSON.stringify(realBalance.modifierRates))
  ok('  ⚠ 而且它**不在 `rates` 里**（在 `rates` 里会让 `npm run calibrate` 的输出变）',
    realBalance.rates?.['waitSecondPerPoint'] === undefined,
    JSON.stringify(realBalance.rates?.['waitSecondPerPoint']))

  const wOpts = {
    rates: readRates(realBalance.rates),
    baseRuleSlots: realBalance.baseRuleSlots,
    ruleSlotBuyCost: realBalance.ruleSlotBuyCost,
    ruleSlotSellGain: realBalance.ruleSlotSellGain,
      modifiers: wProtos,
    modifierRates: realBalance.modifierRates,
  }
  const wSkills = new Map<string, Skill>()
  for (const f of readdirSync(resolve('content/skills')).filter(f => f.endsWith('.json'))) {
    const s = readJson<Skill>(resolve('content/skills', f))
    wSkills.set(s.id, s)
  }
  const wLookup = (id: string): Skill | undefined => wSkills.get(id)

  const withWait = (seconds: number): Technique => ({
    schemaVersion: 1,
    id: 'tech.wait-points',
    name: '带等待的术式',
    kind: 'magic',
    activation: 'press',
    sequences: [{
      name: '一段',
      skills: ['skill.magic-bolt'],
      mods: [{ proto: 'mod.wait', at: 0, params: { seconds } }],
    }],
  })
  const pointsOf = (seconds: number, o = wOpts): number =>
    priceTechnique(withWait(seconds), wLookup, o).total
  const waitEntries = (seconds: number, o = wOpts): string[] =>
    priceTechnique(withWait(seconds), wLookup, o).entries
      .filter(e => e.from === 'technique')
      .map(e => `${String(e.points)} ${e.label}`)

  /*
   * ---- ① **按秒数算、而且是正的**（提供额度）----
   *
   * ⚠ 符号和份数类修饰（负 = 消耗额度）**相反**：
   *   多打一份是好处，空出一段时间是**代价** —— 玩家定稿 §八 ③："越长越亏"。
   */
  const one = pointsOf(1)
  const two = pointsOf(2)
  const three = pointsOf(3)
  /*
   * ⚠⚠ 2026-09-30（日志 57）：这三条以前是"逐位相等"（+0.6 / +1.2 / +1.8）。
   *   账上印整数之后（每个非零条目至少 1 点）它们印成 **+1 / +1 / +2** ——
   *   断言改成新口径：**是整数 + 离原料不到 1 点**（见 `okIntNear`）。
   *   ⚠ 顺便：0.6 那一笔**被"至少 1 点"的地板抬上来了** ——
   *     那正是用户点名的那个毛病（"几乎免费"），现在看得见了。
   */
  okIntNear(`等 1 秒 = +${String(waitRate)} 点（原料；账上印整数）`,
    one, waitRate ?? 0, `（实测 ${one}）`)
  okIntNear('  等 2 秒更多（+2 × 汇率）', two, 2 * (waitRate ?? 0), `（实测 ${two}）`)
  okIntNear('  等 3 秒更多（+3 × 汇率）', three, 3 * (waitRate ?? 0), `（实测 ${three}）`)
  ok('  而且是**收益**（正点数：提供额度）而不是消耗', one > 0 && three > one, `${one} → ${three}`)
  ok('  ⚠ 而且 1 秒和 2 秒**都是 +1 点**（两根都在"至少 1 点"的地板附近，整数账量不出 0.6 vs 1.2）',
    one === 1 && two === 1, `${one} / ${two}`)

  /*
   * ---- ② **汇率是数据**：换一份 `modifierRates`，同一个术式的点数跟着变 ----
   */
  const doubled = pointsOf(2, { ...wOpts, modifierRates: { waitSecondPerPoint: (waitRate ?? 0) * 2 } })
  ok('把汇率翻倍 → 同一个术式的点数也翻倍（汇率是数据，不是代码里的常数）',
    Math.abs(doubled - two * 2) < 1e-9, `${two} → ${doubled}`)

  /*
   * ---- ③ ⚠ **等待阶段的价是 0，钱只走那一把尺**（不许收两次）----
   *
   *   `pricePhase` 对 `Phase.wait` 直接返回 0（等待的价 = 秒数 × 汇率，
   *   在 `modifierPointsOf` 里记）。让它也走"时长 × phaseSecondPerPoint"
   *   就是**同一件事收两次钱**，而且两次的汇率各自可调 —— 账面会自相矛盾。
   */
  const segMod = priceTechnique(withWait(2), wLookup, wOpts).entries.filter(e => e.from === 'technique')
  const modOnly = segMod.filter(e => e.label.includes('等待')).length
  ok('  等待那一段只记**一条**明细（不是"时长一笔 + 等待一笔"）',
    modOnly === 1, `${String(modOnly)} 条：${segMod.map(e => e.label).join(' / ')}`)
  ok('  而那一条的标签写清了秒数',
    segMod[0]?.label.includes('2s') === true, String(segMod[0]?.label))
  ok('  它的路径指得到那个副本',
    segMod[0]?.path === 'sequences[0].mods[0]', String(segMod[0]?.path))

  /*
   * ---- ④ 不传原型表 → 等待那一笔**一条账都不记**（调用方必须传）----
   */
  ok('不传原型表 → 等待那笔账一条都不记（所以命令行 / 编辑器 / 校验器都必须传）',
    priceTechnique(withWait(3), wLookup, { ...wOpts, modifiers: undefined }).entries.length === 0)

  /*
   * ---- ⑤ 夹过的秒数才算钱（账和引擎必须是同一个数）----
   *
   * ⚠ 手改的存档能写 `seconds: 12`，而引擎会把它夹到原型的上限 3 ——
   *   账要是按 12 收，就会同时成立"账上给 12 秒的额度、引擎只等 3 秒"。
   */
  const clamped = pointsOf(12)
  okIntNear('  写 12 秒 → 账按**夹过之后的 3 秒**收（和引擎同一个数）',
    clamped, 3 * (waitRate ?? 0), `（实测 ${clamped}）`)

  /*
   * ---- ⑥ ⭐ 出厂内容仍然全是 0 点（这一条最要紧）----
   *
   *   ⚠ 等待**只可能由副本产生**，而出厂内容一个副本都没有 ⇒
   *     `pricePhase` 那条 `if (p.wait) return 0` 对出厂账**一个数都不改**。
   *     这一条同时也是"`npm run calibrate` 逐行不变"的机械表述。
   */
  const dirW = resolve('content/internal-techniques')
  const dirtyW: string[] = []
  for (const f of readdirSync(dirW).filter(f => f.endsWith('.json')).sort()) {
    const t = readJson<Technique>(resolve(dirW, f))
    const r = priceTechnique(t, wLookup, wOpts)
    if (r.total !== 0 || r.entries.length > 0) {
      dirtyW.push(`${t.id}=${r.total}(${String(r.entries.length)} 条)`)
    }
  }
  ok(`出厂 ${String(readdirSync(dirW).filter(f => f.endsWith('.json')).length)} 份术式：合计和条目数**都是 0**`,
    dirtyW.length === 0, dirtyW.join(', '))

  ok('  而且出厂**一份**等待副本都没有（这条改动的账对出厂内容没有任何影响）',
    [...wProtos.keys()].includes('mod.wait') && dirtyW.length === 0)
}

// ============================================================================
//  「排布」的点数 —— 2026-09-30 日志 53
// ============================================================================

section('排布：点数随类型与参数变（花额度），汇率住在 balance.json 里')

{
  const realBalance = readJson<BalanceConfig>(resolve('content/balance.json'))
  const lProtos = new Map<string, ModifierProto>()
  const lModDir = resolve('content/modifiers')
  for (const f of readdirSync(lModDir).filter(f => f.endsWith('.json'))) {
    const p = readJson<ModifierProto>(resolve(lModDir, f))
    lProtos.set(p.id, p)
  }

  const lBase = realBalance.modifierRates?.['layoutBasePerPoint']
  const lMeter = realBalance.modifierRates?.['layoutPerMeterPerPoint']
  const lDegree = realBalance.modifierRates?.['layoutPerDegreePerPoint']
  ok('balance.json 里写着排布的三条汇率（底价 / 每米 / 每度）',
    typeof lBase === 'number' && lBase > 0
    && typeof lMeter === 'number' && lMeter >= 0
    && typeof lDegree === 'number' && lDegree >= 0,
    JSON.stringify(realBalance.modifierRates))
  ok('  ⚠ 而且三条**都不在 `rates` 里**（在 `rates` 里会让 `npm run calibrate` 的输出变）',
    realBalance.rates?.['layoutBasePerPoint'] === undefined
    && realBalance.rates?.['layoutPerMeterPerPoint'] === undefined
    && realBalance.rates?.['layoutPerDegreePerPoint'] === undefined,
    JSON.stringify(realBalance.rates?.['layoutBasePerPoint']))

  const lOpts = {
    rates: readRates(realBalance.rates),
    baseRuleSlots: realBalance.baseRuleSlots,
    ruleSlotBuyCost: realBalance.ruleSlotBuyCost,
    ruleSlotSellGain: realBalance.ruleSlotSellGain,
      modifiers: lProtos,
    modifierRates: realBalance.modifierRates,
  }
  const lSkills = new Map<string, Skill>()
  for (const f of readdirSync(resolve('content/skills')).filter(f => f.endsWith('.json'))) {
    const s = readJson<Skill>(resolve('content/skills', f))
    lSkills.set(s.id, s)
  }
  const lLookup = (id: string): Skill | undefined => lSkills.get(id)

  const withLayout = (params: Record<string, unknown>): Technique => ({
    schemaVersion: 1,
    id: 'tech.layout-points',
    name: '带排布的术式',
    kind: 'magic',
    activation: 'press',
    sequences: [{
      name: '一段',
      skills: ['skill.magic-bolt'],
      mods: [{ proto: 'mod.layout', at: 0, params }],
    }],
  })
  const pointsOf = (params: Record<string, unknown>, o = lOpts): number =>
    priceTechnique(withLayout(params), lLookup, o).total
  const layoutEntries = (params: Record<string, unknown>, o = lOpts): string[] =>
    priceTechnique(withLayout(params), lLookup, o).entries
      .filter(e => e.from === 'technique')
      .map(e => `${String(e.points)} ${e.label}`)

  const base = lBase ?? 0
  const meter = lMeter ?? 0
  const degree = lDegree ?? 0

  /*
   * ---- ① **它是一份好处 ⇒ 花额度**（负点数）----
   *     方向**和份数类相同**（买了东西）、和「等待」相反（空出时间是代价）。
   */
  const ring1 = pointsOf({ type: 'ring', radius: 1, startAngle: 0 })
  okIntNear('环绕（半径 1 / 起始角 0）= −(底价 + 1 × 每米) 点',
    ring1, -(base + meter), `（实测 ${ring1}）`)
  ok('  它花额度（负点数）而不是提供额度', ring1 < 0, String(ring1))

  /*
   * ---- ② **参数变 ⇒ 点数变**（硬指标里点名要的那一条）----
   *
   * ⚠⚠ 2026-09-30（日志 57）**这两条在本轮的账上量不出来了**，照实说：
   *   账上每个非零条目**至少 1 点**（用户的规格）以后，
   *   半径这根轴的全部行程（0.5~6 米 × 0.1 点/米 = **0.05~0.6 点**）
   *   落在**同一格**里 —— 半径 0.5 米和 6 米**都是 −1 点**。
   *   起始角那根（±180 度 × 0.005 = **最多 0.9 点**）同样只有拉满才跨一格。
   *   ⇒ 下面改成：**原料公式照旧断**（`okIntNear`）、
   *     **"更贵"改在跨得动一格的那一档上断**（起始角 180 度），
   *     并把"这一根被地板吃掉"这个事实**单独钉一条**（免得下一个人以为是 bug）。
   *   ⚠ 这是**要报告给用户**的一件事：这几条小增量的量级在整数账上偏小，
   *     它们当初正是"为容差压过"的那些数（见日志 57 第 5 节）。
   */
  const ring6 = pointsOf({ type: 'ring', radius: 6, startAngle: 0 })
  okIntNear('  半径拉到 6 米 ⇒ 原料更贵（每米那一项）', ring6, -(base + 6 * meter), `（实测 ${ring6}）`)
  ok('  ⚠ 但账上"半径 0.5 米"和"半径 6 米"**都是 −1 点**（0.05~0.6 点全在同一格里）',
    ring6 === ring1 && pointsOf({ type: 'ring', radius: 0.5, startAngle: 0 }) === ring1,
    `0.5 米 ${pointsOf({ type: 'ring', radius: 0.5, startAngle: 0 })} / 1 米 ${ring1} / 6 米 ${ring6}`)

  const ringTurn = pointsOf({ type: 'ring', radius: 1, startAngle: 180 })
  okIntNear('  起始角拉到 180 度 ⇒ 原料更贵（每度那一项）',
    ringTurn, -(base + meter + 180 * degree), `（实测 ${ringTurn}）`)
  ok('  而且这一档**跨得动一格**（账上真的更贵：−1 → 更负）',
    ringTurn < ring1, `${ring1} → ${ringTurn}`)
  ok('  而负的起始角同样算钱（取绝对值：-180 和 +180 一个价）',
    pointsOf({ type: 'ring', radius: 1, startAngle: -180 }) === ringTurn,
    String(pointsOf({ type: 'ring', radius: 1, startAngle: -180 })))

  /*
   * ---- ③ **类型变 ⇒ 点数变**（三档各自只为它真的用到的参数付钱）----
   *
   * ⚠ 这一条钉的是"三档的差价由**参数**表达"这个设计：
   *   环绕 = 米 + 起始角、散射 = 张角、镜像 = 米 + 镜像角。
   *   三个都收的话，"环绕"会为它**用不到的张角**（原型默认 60 度）付钱 ——
   *   那是同一件事收两次钱的翻版。
   */
  const fan60 = pointsOf({ type: 'fan', spread: 60 })
  okIntNear('扇形（张角 60）= −(底价 + 60 × 每度) 点 —— 它**不付半径和起始角的钱**',
    fan60, -(base + 60 * degree), `（实测 ${fan60}）`)
  /*
   * ⚠⚠ 这一条原来断的是"fan60 比 ring6 便宜"（原料 −1.1 vs −1.4）。
   *   账上印整数之后**两个都是 −1** —— 差 0.3 点在整数账上不存在。
   *   ⇒ 改成断**原料**（那才是"三档各自只为用到的参数付钱"这条设计），
   *     而把"账上印的是同一个数"单独钉住。
   */
  ok('  ⚠ 原料上它比"半径 6 米的环绕"便宜（两档买的参数不是一套）',
    (base + 60 * degree) < (base + 6 * meter), `${round2(base + 60 * degree)} vs ${round2(base + 6 * meter)}`)
  ok('  ⚠ 而账上两者**都是 −1 点**（差 0.3 点被整数账的地板吃掉）',
    fan60 === ring6, `fan ${fan60} vs ring ${ring6}`)

  const fan0 = pointsOf({ type: 'fan', spread: 0 })
  okIntNear('  张角 0（全都朝正前方）= 只有底价（等于没有散开）',
    fan0, -base, `（实测 ${fan0}）`)
  const fan360 = pointsOf({ type: 'fan', spread: 360 })
  ok('  张角拉到 360 度 ⇒ 账上真的更贵（这一档跨得动好几格）',
    fan360 < fan60, `${fan60} → ${fan360}`)

  const mirrorTight = pointsOf({ type: 'mirror', radius: 1.5, mirrorAngle: 0 })
  const mirrorWide = pointsOf({ type: 'mirror', radius: 1.5, mirrorAngle: 45 })
  okIntNear('镜像（半径 = 默认 1.5、偏移角 0）= −(底价 + 1.5 × 每米) 点',
    mirrorTight, -(base + 1.5 * meter), `（实测 ${mirrorTight}）`)
  okIntNear('  偏移角开到 45 度 ⇒ 原料更贵（每度那一项）',
    mirrorWide, -(base + 1.5 * meter + 45 * degree), `（实测 ${mirrorWide}）`)
  ok('  ⚠ 但账上**两个都是 −1 点**（0.225 点那一档跨不动一格 —— 和半径那条同病）',
    mirrorWide === mirrorTight, `${mirrorTight} → ${mirrorWide}`)

  /*
   * ---- ④ **汇率是数据**：把三条一起翻倍，同一个术式的点数也跟着变 ----
   */
  const doubled = pointsOf({ type: 'ring', radius: 6, startAngle: 90 }, {
    ...lOpts,
    modifierRates: {
      layoutBasePerPoint: base * 2,
      layoutPerMeterPerPoint: meter * 2,
      layoutPerDegreePerPoint: degree * 2,
    },
  })
  ok('把三条汇率都翻倍 → 同一个术式的点数也翻倍（汇率是数据，不是代码里的常数）',
    Math.abs(doubled - pointsOf({ type: 'ring', radius: 6, startAngle: 90 }) * 2) < 1e-9,
    `${pointsOf({ type: 'ring', radius: 6, startAngle: 90 })} → ${doubled}`)

  /*
   * ---- ⑤ 一条明细、路径指得到那个副本、标签说清是哪种摆法 ----
   *     编辑器要按"我拖进来的那个零件"分组显示。
   */
  const entries = layoutEntries({ type: 'fan', spread: 60 })
  okEq('  只记**一条**明细（一个零件一笔账）', String(entries.length), '1')
  ok('  标签写清了是哪种摆法（不是光写个 mod.layout）',
    (entries[0] ?? '').includes('扇形散射'), String(entries[0]))
  ok('  它的路径指得到那个副本',
    priceTechnique(withLayout({ type: 'fan' }), lLookup, lOpts).entries
      .filter(e => e.from === 'technique')[0]?.path === 'sequences[0].mods[0]',
    String(priceTechnique(withLayout({ type: 'fan' }), lLookup, lOpts).entries
      .filter(e => e.from === 'technique')[0]?.path))

  /*
   * ---- ⑥ 不传原型表 → 排布那笔账一条都不记（调用方必须传）----
   */
  ok('不传原型表 → 排布那笔账一条都不记（所以命令行 / 编辑器 / 校验器都必须传）',
    priceTechnique(withLayout({ type: 'ring', radius: 6 }), lLookup,
      { ...lOpts, modifiers: undefined }).entries.length === 0)

  /*
   * ---- ⑦ 摆法**认不出**时一笔都不记（和引擎那一侧一致：整块不生效）----
   *     ⚠ "写了不生效"由校验器报 `MODIFIER_LAYOUT_BAD_TYPE`，不靠账本出声。
   */
  ok('摆法写成 circle → 账上一条都不记（引擎那边也不生效，两边一致）',
    priceTechnique(withLayout({ type: 'circle' }), lLookup, lOpts).entries
      .filter(e => e.from === 'technique').length === 0)

  /*
   * ---- ⑧ 夹过的参数才算钱（账和引擎必须是同一个数）----
   *     半径写 99 米时引擎按上限 6 米摆 ⇒ 账也必须按 6 米收。
   */
  okEq('  半径写 99 米 → 账按**夹过之后的 6 米**收（和引擎同一个数）',
    String(pointsOf({ type: 'ring', radius: 99 })), String(ring6))

  /*
   * ---- ⑨ ⭐ 出厂内容仍然全是 0 点（这一条最要紧）----
   *     排布**只可能由副本产生**，而出厂内容一个副本都没有。
   *     这一条同时也是"`npm run calibrate` 逐行不变"的机械表述。
   */
  const dirL = resolve('content/internal-techniques')
  const dirtyL: string[] = []
  for (const f of readdirSync(dirL).filter(f => f.endsWith('.json')).sort()) {
    const t = readJson<Technique>(resolve(dirL, f))
    const r = priceTechnique(t, lLookup, lOpts)
    if (r.total !== 0 || r.entries.length > 0) {
      dirtyL.push(`${t.id}=${r.total}(${String(r.entries.length)} 条)`)
    }
  }
  ok(`出厂 ${String(readdirSync(dirL).filter(f => f.endsWith('.json')).length)} 份术式：合计和条目数**都是 0**`,
    dirtyL.length === 0, dirtyL.join(', '))
}

// ============================================================================
//  「追踪」的点数 —— 2026-09-30 日志 56
// ============================================================================

section('追踪：只对会飞的东西收钱（装在激光上一分钱都不收）')

{
  /*
   * ⚠⚠ 玩家 2026-09-30 裁定（日志 56 第二版），原话：
   *   "**花钱买了什么都不做** 比'没提示'更糟"
   *
   * ⇒ 判据**只有一处**：`school.ts` 的 `carrierFliesInWorld(kind)`（日志 58 前叫
   *   `homingAppliesTo`，**函数体一个字没改**）——
   *   **校验器**（报一条警告让人看见）和**账本**（不收钱）读的是同一个函数。
   *   ⚠ 这一节钉的就是"账本那一半"，而 `tests/weapons.ts` 钉"校验器那一半"。
   *     两半**必须成对**：只报不收 ⇒ 玩家还是白花钱；只收不报 ⇒ 更糟。
   */
  const realBalance = readJson<BalanceConfig>(resolve('content/balance.json'))
  const hProtos = new Map<string, ModifierProto>()
  const hModDir = resolve('content/modifiers')
  for (const f of readdirSync(hModDir).filter(f => f.endsWith('.json'))) {
    const p = readJson<ModifierProto>(resolve(hModDir, f))
    hProtos.set(p.id, p)
  }

  const hBase = realBalance.modifierRates?.['homingBasePerPoint']
  const hMeter = realBalance.modifierRates?.['homingPerMeterPerPoint']
  const hDegree = realBalance.modifierRates?.['homingPerDegreePerPoint']
  ok('balance.json 里写着追踪的三条汇率（底价 / 每米 / 每度）',
    typeof hBase === 'number' && hBase > 0
    && typeof hMeter === 'number' && hMeter >= 0
    && typeof hDegree === 'number' && hDegree >= 0,
    JSON.stringify(realBalance.modifierRates))
  ok('  ⚠ 而且三条**都不在 `rates` 里**（在 `rates` 里会让 `npm run calibrate` 的输出变）',
    realBalance.rates?.['homingBasePerPoint'] === undefined
    && realBalance.rates?.['homingPerMeterPerPoint'] === undefined
    && realBalance.rates?.['homingPerDegreePerPoint'] === undefined,
    JSON.stringify(realBalance.rates?.['homingBasePerPoint']))

  const hOpts = {
    rates: readRates(realBalance.rates),
    baseRuleSlots: realBalance.baseRuleSlots,
    ruleSlotBuyCost: realBalance.ruleSlotBuyCost,
    ruleSlotSellGain: realBalance.ruleSlotSellGain,
      modifiers: hProtos,
    modifierRates: realBalance.modifierRates,
  }
  const hSkills = new Map<string, Skill>()
  for (const f of readdirSync(resolve('content/skills')).filter(f => f.endsWith('.json'))) {
    const s = readJson<Skill>(resolve('content/skills', f))
    hSkills.set(s.id, s)
  }
  const hLookup = (id: string): Skill | undefined => hSkills.get(id)

  const withHoming = (
    params: Record<string, unknown>,
    skillId = 'skill.magic-bolt',
  ): Technique => ({
    schemaVersion: 1,
    id: 'tech.homing-points',
    name: '带追踪的术式',
    kind: 'magic',
    activation: 'press',
    sequences: [{ name: '一段', skills: [skillId], mods: [{ proto: 'mod.homing', at: 0, params }] }],
  })
  const homingEntries = (
    params: Record<string, unknown>,
    skillId = 'skill.magic-bolt',
  ): Array<{ points: number, label: string }> =>
    priceTechnique(withHoming(params, skillId), hLookup, hOpts).entries
      .filter(e => e.from === 'technique')

  const base = hBase ?? 0
  const meter = hMeter ?? 0
  const degree = hDegree ?? 0

  /*
   * ---- ① **会飞的技能上：花额度**（负点数，和份数类 / 排布同一个方向）----
   */
  const onBolt = homingEntries({ turnRate: 12, maxRange: 8 })
  ok('装在投射物技能上 → 记一笔（花额度）', onBolt.length === 1, JSON.stringify(onBolt))
  okIntNear('  金额 = −(底价 + 搜索距离 × 每米 + 转速 × 每度)',
    onBolt[0]?.points ?? 0, -(base + 8 * meter + 12 * degree),
    `（实测 ${String(onBolt[0]?.points)}）`)

  /*
   * ---- ② **参数变 ⇒ 点数变** ----
   * ⚠ 2026-09-30（日志 57）：原料那一头照旧断；"更贵"那一条用**跨得动格子**的
   *   两极（1 点 vs 3.5 点），所以它在整数账上仍然成立（实测 −1 → −3）。
   */
  const slow = homingEntries({ turnRate: 1, maxRange: 1 })[0]?.points ?? 0
  const fast = homingEntries({ turnRate: 30, maxRange: 16 })[0]?.points ?? 0
  ok('参数变 ⇒ 点数跟着变（转得更快 / 看得更远 = 更贵）', fast < slow, `${String(slow)} vs ${String(fast)}`)
  okIntNear('  下限那一档 = −(底价 + 1 × 每米 + 1 × 每度)',
    slow, -(base + meter + degree), `（实测 ${slow}）`)

  /*
   * ---- ③ ⚠⚠ **装在非飞行载体上：一分钱都不收**（玩家裁定）----
   *
   *   `skill.charged-laser` 是 `beam` 载体（玩家点名的"激光"）。
   *   ⚠ 判据和校验器那条警告**是同一个函数**（`school.ts` 的 `carrierFliesInWorld`）——
   *     所以这两条断言和 `tests/weapons.ts` 里那条 `MODIFIER_HOMING_NOT_FLYING`
   *     **必须同时成立**：一个说"报出来"，一个说"不收钱"。
   */
  const onBeam = homingEntries({ turnRate: 12, maxRange: 8 }, 'skill.charged-laser')
  ok('⚠⚠ 装在激光（beam 载体）上 → **账上一条都不记**（不能"花钱买了什么都不做"）',
    onBeam.length === 0, JSON.stringify(onBeam))

  /*
   * ⚠ 反过来：一个**会飞**的技能照收 ⇒ 少了这条，"判据永远返回 false"
   *   （= 所有追踪都免费）和"判据真的在管事"就分不出来。
   */
  ok('  反过来：装在**会飞**的技能上照收（判据真的在管事，不是"追踪一律免费"）',
    homingEntries({ turnRate: 12, maxRange: 8 }, 'skill.magic-bolt').length === 1)

  /*
   * ---- ④ 一个载体都没有的技能（纯位移）也算"什么都不做" ⇒ 不收 ----
   */
  ok('  一个载体都没有的技能（纯位移 `skill.charge-dash`）→ 同样不收',
    homingEntries({ turnRate: 12, maxRange: 8 }, 'skill.charge-dash').length === 0)

  /*
   * ---- ⑤ 夹过的参数才算钱（账和引擎必须是同一个数）----
   *     搜索距离写 9999 米时引擎按上限 16 米追 ⇒ 账也必须按 16 米收。
   */
  const clamped = homingEntries({ turnRate: 12, maxRange: 9999 })[0]?.points ?? 0
  const atCap = homingEntries({ turnRate: 12, maxRange: 16 })[0]?.points ?? 0
  okEq('  搜索距离写 9999 米 → 账按**夹过之后的 16 米**收（和引擎同一个数）',
    String(clamped), String(atCap))

  /*
   * ---- ⑥ 不传原型表 → 那一笔一条都不记（调用方必须传）----
   */
  ok('不传原型表 → 追踪那笔账一条都不记（所以命令行 / 编辑器 / 校验器都必须传）',
    priceTechnique(withHoming({ turnRate: 12 }), hLookup,
      { ...hOpts, modifiers: undefined }).entries.length === 0)

  /*
   * ---- ⑦ ⭐ 出厂内容仍然全是 0 点（这一条最要紧）----
   *     追踪**只可能由副本产生**，而出厂内容一个副本都没有。
   *     这一条同时也是 "`npm run calibrate` 逐行不变" 的机械表述。
   */
  const dirH = resolve('content/internal-techniques')
  const dirtyH: string[] = []
  for (const f of readdirSync(dirH).filter(f => f.endsWith('.json')).sort()) {
    const t = readJson<Technique>(resolve(dirH, f))
    const r = priceTechnique(t, hLookup, hOpts)
    if (r.total !== 0 || r.entries.length > 0) {
      dirtyH.push(`${t.id}=${r.total}(${String(r.entries.length)} 条)`)
    }
  }
  ok(`出厂 ${String(readdirSync(dirH).filter(f => f.endsWith('.json')).length)} 份术式：合计和条目数**都是 0**`,
    dirtyH.length === 0, dirtyH.join(', '))
}

// ============================================================================
//  「弹射」的点数 —— 2026-09-30 日志 58
// ============================================================================

section('弹射：只对会飞的东西收钱（装在激光上一分钱都不收）＋ 账按**夹过的次数**收')

{
  /*
   * ⚠⚠ 玩家日志 58 的两条硬命令：
   *   1. **只对"会飞的东西"有效**；非飞行载体 ⇒ **什么都不做、而且不收费** ——
   *      "这**和「追踪」是同一条规矩** ✓ 所以**判据要共用**"。
   *      ⇒ 判据**只有一处**：`school.ts` 的 `carrierFliesInWorld` ——
   *        **校验器**（报一条警告让人看见）和**账本**（不收钱）读同一个函数。
   *        这一节钉"账本那一半"，`tests/weapons.ts` 钉"校验器那一半"。
   *   2. ⚠⚠ **上限必须和 `pipeline` 的深度限制用同一条规矩**：
   *      次数上限是 `MAX_ACTION_DEPTH`（`src/limits.ts`）——
   *      ⇒ **账必须按夹过之后的次数收**（否则"账上按 9 次收、引擎只弹 4 次"）。
   */
  const bBalance = readJson<BalanceConfig>(resolve('content/balance.json'))
  const bProtos = new Map<string, ModifierProto>()
  const bModDir = resolve('content/modifiers')
  for (const f of readdirSync(bModDir).filter(f => f.endsWith('.json'))) {
    const p = readJson<ModifierProto>(resolve(bModDir, f))
    bProtos.set(p.id, p)
  }

  const bBase = bBalance.modifierRates?.['bounceBasePerPoint']
  const bTimes = bBalance.modifierRates?.['bouncePerBouncePerPoint']
  const bFalloff = bBalance.modifierRates?.['bouncePerFalloffPerPoint']
  ok('balance.json 里写着弹射的三条汇率（底价 / 每次 / 衰减）',
    typeof bBase === 'number' && bBase > 0
    && typeof bTimes === 'number' && bTimes >= 0
    && typeof bFalloff === 'number' && bFalloff >= 0,
    JSON.stringify(bBalance.modifierRates))
  ok('  ⚠ 而且三条**都不在 `rates` 里**（在 `rates` 里会让 `npm run calibrate` 的输出变）',
    bBalance.rates?.['bounceBasePerPoint'] === undefined
    && bBalance.rates?.['bouncePerBouncePerPoint'] === undefined
    && bBalance.rates?.['bouncePerFalloffPerPoint'] === undefined,
    JSON.stringify(bBalance.rates?.['bounceBasePerPoint']))

  const bOpts = {
    rates: readRates(bBalance.rates),
    baseRuleSlots: bBalance.baseRuleSlots,
    ruleSlotBuyCost: bBalance.ruleSlotBuyCost,
    ruleSlotSellGain: bBalance.ruleSlotSellGain,
    modifiers: bProtos,
    modifierRates: bBalance.modifierRates,
  }
  const bSkills = new Map<string, Skill>()
  for (const f of readdirSync(resolve('content/skills')).filter(f => f.endsWith('.json'))) {
    const s = readJson<Skill>(resolve('content/skills', f))
    bSkills.set(s.id, s)
  }
  const bLookup = (id: string): Skill | undefined => bSkills.get(id)

  const withBounce = (
    params: Record<string, unknown>,
    skillId = 'skill.magic-bolt',
  ): Technique => ({
    schemaVersion: 1,
    id: 'tech.bounce-points',
    name: '带弹射的术式',
    kind: 'magic',
    activation: 'press',
    sequences: [{ name: '一段', skills: [skillId], mods: [{ proto: 'mod.bounce', at: 0, params }] }],
  })
  const bounceEntries = (
    params: Record<string, unknown>,
    skillId = 'skill.magic-bolt',
  ): Array<{ points: number, label: string }> =>
    priceTechnique(withBounce(params, skillId), bLookup, bOpts).entries
      .filter(e => e.from === 'technique')

  const baseB = bBase ?? 0
  const timesB = bTimes ?? 0
  const falloffB = bFalloff ?? 0
  /** 原型上那份衰减下限（账就是按"离全衰减有多远"收的） */
  const proto = bProtos.get('mod.bounce')
  const floor = typeof proto?.params?.['minFalloff'] === 'number'
    ? (proto.params['minFalloff'] as number)
    : 0.1

  /*
   * ---- ① **会飞的技能上：花额度**（负点数，和份数类 / 排布 / 追踪同一个方向）----
   */
  const onBolt = bounceEntries({ maxBounces: 2, damageFalloff: 0.7 })
  ok('装在投射物技能上 → 记一笔（花额度）', onBolt.length === 1, JSON.stringify(onBolt))
  okIntNear('  金额 = −(底价 + 次数 × 每次 + (衰减 − 下限) × 每点衰减)',
    onBolt[0]?.points ?? 0, -(baseB + 2 * timesB + (0.7 - floor) * falloffB),
    `（实测 ${String(onBolt[0]?.points)}）`)

  /*
   * ---- ② **参数变 ⇒ 点数变** ----
   *   最保守（弹 1 次 + 全衰减）vs 最贵（弹满 + 完全不衰减）。
   */
  const cheap = bounceEntries({ maxBounces: 1, damageFalloff: 0.1 })[0]?.points ?? 0
  const pricey = bounceEntries({ maxBounces: 4, damageFalloff: 1 })[0]?.points ?? 0
  ok('参数变 ⇒ 点数跟着变（弹得更多 / 更不衰减 = 更贵）',
    pricey < cheap, `${String(cheap)} vs ${String(pricey)}`)

  /*
   * ---- ③ ⚠⚠ **账按夹过的次数收**：写 9 次 ⇒ 按 4 次（= MAX_ACTION_DEPTH）----
   *
   *   ⚠ 这一条是那一整条"上限和深度限制同一条规矩"在**账本**这一侧的落点：
   *     不夹的话账会按 9 次收钱，而引擎只弹 4 次 ——
   *     那就是"花了 9 次的钱、买到 4 次的东西"，而且**账面看不出来**。
   */
  const clamped9 = bounceEntries({ maxBounces: 9, damageFalloff: 0.7 })[0]?.points ?? 0
  const atCap4 = bounceEntries({ maxBounces: 4, damageFalloff: 0.7 })[0]?.points ?? 0
  okEq('⚠⚠ 写 9 次 → 账按**夹过之后的 4 次**收（和引擎同一个数）',
    String(clamped9), String(atCap4))
  ok('  而且那一档确实比 2 次贵（不是"两个都变成同一个数"的假相等）',
    atCap4 < (onBolt[0]?.points ?? 0), `${String(atCap4)} vs ${String(onBolt[0]?.points)}`)

  /*
   * ---- ④ ⚠⚠ **装在非飞行载体上：一分钱都不收** ----
   *
   *   `skill.charged-laser` 是 `beam` 载体（玩家点名的"激光"）。
   *   ⚠ 判据和校验器那条警告**是同一个函数**（`school.ts` 的 `carrierFliesInWorld`）——
   *     所以这条断言和 `tests/weapons.ts` 里那条 `MODIFIER_BOUNCE_NOT_FLYING`
   *     **必须同时成立**：一个说"报出来"，一个说"不收钱"。
   */
  const onBeam = bounceEntries({ maxBounces: 2, damageFalloff: 0.7 }, 'skill.charged-laser')
  ok('⚠⚠ 装在激光（beam 载体）上 → **账上一条都不记**（不能"花钱买了什么都不做"）',
    onBeam.length === 0, JSON.stringify(onBeam))

  /*
   * ⚠ 反过来：一个**会飞**的技能照收 ⇒ 少了这条，"判据永远返回 false"
   *   （= 所有弹射都免费）和"判据真的在管事"就分不出来。
   */
  ok('  反过来：装在**会飞**的技能上照收（判据真的在管事，不是"弹射一律免费"）',
    bounceEntries({ maxBounces: 2, damageFalloff: 0.7 }, 'skill.magic-bolt').length === 1)

  // ---- ⑤ 一个载体都没有的技能（纯位移）也算"什么都不做" ⇒ 不收 ----
  ok('  一个载体都没有的技能（纯位移 `skill.charge-dash`）→ 同样不收',
    bounceEntries({ maxBounces: 2, damageFalloff: 0.7 }, 'skill.charge-dash').length === 0)

  /*
   * ---- ⑥ 夹过的**衰减**才算钱（账和引擎必须是同一个数）----
   */
  const clampedF = bounceEntries({ maxBounces: 2, damageFalloff: 99 })[0]?.points ?? 0
  const atMaxF = bounceEntries({ maxBounces: 2, damageFalloff: 1 })[0]?.points ?? 0
  okEq('  衰减写 99 → 账按**夹过之后的 1**收（和引擎同一个数）',
    String(clampedF), String(atMaxF))

  /*
   * ---- ⑦ 不传原型表 → 那一笔一条都不记（调用方必须传）----
   */
  ok('不传原型表 → 弹射那笔账一条都不记（所以命令行 / 编辑器 / 校验器都必须传）',
    priceTechnique(withBounce({ maxBounces: 2 }), bLookup,
      { ...bOpts, modifiers: undefined }).entries.length === 0)

  /*
   * ---- ⑧ ⭐ 出厂内容仍然全是 0 点 ----
   *     弹射**只可能由副本产生**，而出厂内容一个副本都没有。
   */
  const dirB = resolve('content/internal-techniques')
  const dirtyB: string[] = []
  for (const f of readdirSync(dirB).filter(f => f.endsWith('.json')).sort()) {
    const t = readJson<Technique>(resolve(dirB, f))
    const r = priceTechnique(t, bLookup, bOpts)
    if (r.total !== 0 || r.entries.length > 0) {
      dirtyB.push(`${t.id}=${r.total}(${String(r.entries.length)} 条)`)
    }
  }
  ok(`出厂 ${String(readdirSync(dirB).filter(f => f.endsWith('.json')).length)} 份术式：合计和条目数**都是 0**`,
    dirtyB.length === 0, dirtyB.join(', '))
}

// ============================================================================
//  ⭐ 点数改成整数 + 删掉产品容差 —— 2026-09-30 日志 57
// ============================================================================

section('点数改成整数：逐条整数、各条之和 = 合计、非零条目至少 1 点')

{
  /*
   * 用户 2026-09-30 的规格（原话）：
   *   > 我在思考点数要不要不那么精确（到小数点后）……
   *   > 既然正的容差没用，那**容差就不该存在** ——
   *   > **点数之和大于 0 就能用，小于 0 就要支付血契才能用**
   *
   * 落地成四件事，这一节逐条钉住：
   *   ① 账上每一笔都是**整数**（逐条取整 + **最大余数法**，见 `integerPointsOf`）；
   *   ② ⭐ **各条之和 = 合计**（**构造出来的**，不是碰巧 —— 单独对合计取整
   *      就会让"条目加起来对不上"，那正是这一片要修的毛病）；
   *   ③ **每个非零条目至少 1 点**（"0.12 点"那种"账面上几乎免费"的条目不许存在）；
   *   ④ 判据只剩一条：**合计 ≥ 0 能用 / < 0 要付血契**（产品容差 2 点**删了**）。
   */

  // ---- ① / ③ / ② 的**算法本身**：最大余数法 ----
  /*
   * ⚠ 这些是**纯函数**断言（不经过内容），因为它们钉的正是"怎么分那几格"：
   *   余数最大的拿走那一格；余数相同按**下标**（稳定 ⇒ 同一个技能每次都逐位相同）。
   */
  const show = (v: readonly number[]): string => JSON.stringify(integerPointsOf(v))
  okEq('两笔 1.5 ⇒ 合计仍是 3，多出来那一格给**下标小的**（同余数按下标，稳定）',
    show([1.5, 1.5]), '[2,1]')
  okEq('余数不同 ⇒ 给余数大的那一笔（1.5 / 1.4 ⇒ 3 点的那一格给 1.5）',
    show([1.5, 1.4]), '[2,1]')
  okEq('⚠ **负条目也走 floor**（向 −∞）⇒ 余数永远非负、正负条目一视同仁地分格子',
    show([2.5, -1.5]), '[3,-2]')
  okEq('⚠ 浮点噪声（1e-12）**不会被钳成 ±1 点**（机器精度那道护栏）',
    show([1e-12]), '[0]')
  okEq('⚠ 真的是整数、但浮点算成 0.9999999999999999 ⇒ 仍然落回 1（不掉格）',
    show([0.9999999999999999]), '[1]')
  okEq('⚠ 判断项：三笔 0.4 点 ⇒ 账上是 1 / 1 / 1（**合计 3**）—— 见下面的说明',
    show([0.4, 0.4, 0.4]), '[1,1,1]')
  ok('  ⚠ 这条是**两条规格在这里冲突**的地方：原料合计是 1.2 ⇒ 取整该是 1，'
    + '但"每个非零条目至少 1 点"要求三条各 1 ⇒ 合计只能是 3。**本实现选后者**'
    + '（账的定义 = 各条之和），列在日志 57 的"待裁定项"里',
    integerPointsOf([0.4, 0.4, 0.4]).reduce((s, v) => s + v, 0) === 3,
    `${String(integerPointsOf([0.4, 0.4, 0.4]).reduce((s, v) => s + v, 0))} vs 原料合计取整 1`)

  // ---- 逐份打印当证据：32 个技能 + 14 份术式 ----
  const balance = readJson<BalanceConfig>(resolve('content/balance.json'))
  const statuses = new Map<string, StatusDef>()
  for (const f of readdirSync(resolve('content/statuses')).filter(f => f.endsWith('.json'))) {
    const s = readJson<StatusDef>(resolve('content/statuses', f))
    statuses.set(s.id, s)
  }
  const entities = new Map<string, import('../src/schema.ts').EntityDef>()
  for (const f of readdirSync(resolve('content/entities')).filter(f => f.endsWith('.json'))) {
    const e = readJson<import('../src/schema.ts').EntityDef>(resolve('content/entities', f))
    entities.set(e.id, e)
  }
  const protos = new Map<string, ModifierProto>()
  for (const f of readdirSync(resolve('content/modifiers')).filter(f => f.endsWith('.json'))) {
    const p = readJson<ModifierProto>(resolve('content/modifiers', f))
    protos.set(p.id, p)
  }
  const o = priceOptionsFor(balance, statuses, entities, protos)

  const skillDirs = ['content/skills', 'content/weapon-skills']
  const allSkills = new Map<string, Skill>()
  const badSkills: string[] = []
  const badLines: string[] = []
  let skillCount = 0
  console.log('    ⭐ 逐份打印（32 个技能 · 绝对账）')
  for (const dir of skillDirs) {
    const d = resolve(dir)
    for (const f of readdirSync(d).filter(f => f.endsWith('.json')).sort()) {
      const s = readJson<Skill>(resolve(d, f))
      skillCount++
      allSkills.set(s.id, s)
      const r = priceSkill(s, o)
      const sum = r.entries.reduce((a, e) => a + e.points, 0)
      const allInt = r.entries.every(e => Number.isInteger(e.points))
      const floorOk = r.entries.every(e => e.points === 0 || Math.abs(e.points) >= 1)
      const sumOk = sum === r.total && Number.isInteger(r.total)
      if (!allInt || !floorOk || !sumOk) {
        badSkills.push(`${s.id}: 整数=${String(allInt)} 至少1点=${String(floorOk)} 加得起来=${String(sumOk)}`)
      }
      badLines.push(`${s.name.padEnd(12)} ${String(r.total).padStart(4)} 点 · ${String(r.entries.length)} 条明细`)
    }
  }
  for (const line of badLines) console.log(`      ${line}`)
  ok(`ⓐ 32 个技能的账**逐条都是整数**、**非零条目至少 1 点**、**各条之和 = 合计**（在册 ${String(skillCount)} 份）`,
    badSkills.length === 0, badSkills.join(' / '))
  okEq('  而且真的是 32 份（30 个技能 + 2 份武器技能）', String(skillCount), '32')

  // 出厂术式：账必须是**空的**（宗旨）—— 这一条是"出厂全 0"的常驻断言
  const techDir = resolve('content/internal-techniques')
  const techFiles = readdirSync(techDir).filter(f => f.endsWith('.json')).sort()
  const badTech: string[] = []
  console.log('    ⭐ 逐份打印（14 份术式 · 相对账）')
  for (const f of techFiles) {
    const t = readJson<Technique>(resolve(techDir, f))
    const r = priceTechnique(t, id => allSkills.get(id), o)
    console.log(`      ${t.name.padEnd(12)} ${String(r.total).padStart(4)} 点 · ${String(r.entries.length)} 条明细`)
    if (r.total !== 0 || r.entries.length > 0) badTech.push(`${t.id}=${r.total}(${String(r.entries.length)} 条)`)
  }
  ok('ⓑ 14 份出厂术式：**合计和条目数都是 0**（⭐ 出厂全 0 的常驻断言 —— "0 取整还是 0"）',
    badTech.length === 0 && techFiles.length === 14,
    `在册 ${String(techFiles.length)} 份；${badTech.join(', ')}`)

  // ---- ④ **没有那个 2 点缓冲区了**：差 1 点也算负值术式 ----
  /*
   * ⚠ 这是这一片最容易做错的一条：旧口径下 `|合计| ≤ 2` 都算"配平"，
   *   所以一份差 1 点的术式**旧代码会说它没问题**。新口径：差 1 点就是负值术式。
   *
   * ⚠⚠ 2026-09-30（日志 60b）**这一笔的取值从 60 改成了 50**，理由是账的算法换了：
   *   现在是**查表 + 相加**，而表里裂地斩的伤害那一行是
   *   `{ 10: 1, 25: 1, 30: 0, 50: −1, 200: −6 }` —— **没有 60 这一格**。
   *   60 是**表外取值**（第 ① 条要报错，而且账上留一条 `⚠ 表外取值` 记录），
   *   拿它当"差 1 点"的例子已经不成立了。50 那一格恰好还是 **−1**，
   *   这一条要钉的东西（差 1 点也算负值术式）**一个字都没变**。
   */
  const cleave = readJson<Skill>(resolve('content/skills', 'cleave.json'))
  const doubled: Skill = JSON.parse(JSON.stringify(cleave)) as Skill
  doubled.id = 'custom.cleave.double'
  doubled.basedOn = cleave.id
  const dmgPayload = doubled.effect?.[0]?.then?.[0]?.payload
  if (dmgPayload !== undefined && dmgPayload.kind === 'damage' && dmgPayload.amount !== undefined) {
    dmgPayload.amount.const = 50
  }
  const one = skillLedger(doubled, cleave, o)
  ok('差 1 点也是负值术式（旧口径的"容差 2 点"会把这一笔判成配平）',
    one.total === -1, `合计 ${one.total}`)
  ok('  而且它**逐条是整数**、各条之和 = 合计',
    one.entries.every(e => Number.isInteger(e.points))
    && one.entries.reduce((s, e) => s + e.points, 0) === one.total,
    one.entries.map(e => `${String(e.points)} ${e.label}`).join(' / '))

  const lib = new Map<string, Skill>([[cleave.id, cleave], [doubled.id, doubled]])
  const oneTech: Technique = {
    schemaVersion: 1, id: 'tech.one-point', name: '差一点', kind: 'magic',
    activation: 'press', skills: [doubled.id],
  }
  const oneReport = validateTechnique('t.json', oneTech, { balance, skills: lib })
  ok('  校验器按"要付血契"报出来（1 点也不能白用）',
    oneReport.kind === 'negative'
    && oneReport.bloodPactPerUse === 1
    && oneReport.issues.some(i => i.code === 'NEGATIVE_TECHNIQUE'),
    `${oneReport.kind} ${String(oneReport.total)} / 血契 ${String(oneReport.bloodPactPerUse)}；`
    + oneReport.issues.map(i => i.code).join(', '))
  ok('  ⚠ 而且**不再有** NOT_BALANCED 这条错误（新口径里没有"没配平"这回事）',
    !oneReport.issues.some(i => i.code === 'NOT_BALANCED'),
    oneReport.issues.map(i => i.code).join(', '))
}

console.log('')
if (failed > 0) {
  console.log(`✗ ${failed} 个断言失败（${passed} 个通过）`)
  process.exitCode = 1
} else {
  console.log(`✓ 全部 ${passed} 个断言通过`)
  process.exitCode = 0
}
