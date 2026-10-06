/**
 * 编辑器的纯逻辑测试。
 *
 * 编辑器没法在 Node 里点，但**数值抽取**那一层是纯函数 ——
 * 而它恰恰是最容易错的地方：路径写错、范围写反、漏掉某个字段。
 *
 * 这里对**全部七个真技能**做三件事：
 *   1. 抽出来的每条路径，在原来的对象上都能读到数字
 *   2. 写回去能读回来
 *   3. 当前值落在滑块范围**之内** —— 不然滑块一碰就会跳
 *
 * 外加一条**回归测试**（最后一节）：改数值必须改变点数。
 * 第一版把点数手写在 JSON 里，玩家把 30 伤害改成 300 伤害点数纹丝不动 ——
 * 那是在编辑器里实测踩到的，所以现在拿它当断言钉死。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readJson } from '../src/loader.ts'
import { collectLeaves, getByPath, setByPath, clone } from '../web/src/leaves.ts'
// 技能页（编辑器 UI 第一片）的那些判据 —— 纯函数，这里直接钉
import {
  FORM_LABEL, PERMANENT_NOTE, cellOf, formOf, formWhy, hostTargetLabel,
  isCooldownLeaf, isDeliveryShapeLeaf, isPhaseDurationLeaf, knobReason, knobState,
  leafZone, tierChoices, tierSeconds,
} from '../web/src/skill-page.ts'
import { phaseDurationTierPriceOf, priceSkill, readRates, readTierTables } from '../src/pricing.ts'
import type { BalanceConfig } from '../src/validator/types.ts'
import type { Skill } from '../src/schema.ts'

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

/** 编辑器编辑的是**技能**，不是术式 —— 术式只管编排，没有什么可调的数值 */
const DIR = resolve('content/skills')
const files = readdirSync(DIR).filter(f => f.endsWith('.json')).sort()

const balance = readJson<BalanceConfig>(resolve('content/balance.json'))
const options = {
  rates: readRates(balance.rates),
  baseRuleSlots: balance.baseRuleSlots,
  ruleSlotBuyCost: balance.ruleSlotBuyCost,
  ruleSlotSellGain: balance.ruleSlotSellGain,
}
const totalOf = (skill: Skill): number => priceSkill(skill, options).total

console.log('\n编辑器：数值抽取')

let totalLeaves = 0

for (const file of files) {
  const skill = readJson<Skill>(resolve(DIR, file))
  const leaves = collectLeaves(skill)
  totalLeaves += leaves.length

  const unreadable: string[] = []
  const offGridList: string[] = []
  const unwritable: string[] = []
  const tooMany: string[] = []

  for (const leaf of leaves) {
    const label = leaf.path.join('.')

    // 1. 路径读得到
    const v = getByPath(skill, leaf.path)
    if (typeof v !== 'number') {
      unreadable.push(label)
      continue
    }

    /*
     * 2. **当前值必须落在点表上**（不是"被塞进点表"）。
     *
     *    `collectLeaves` 会把格子外的值插进来 —— 那是为了不让编辑器
     *    一打开就改内容。但 `offGrid` 会标记出来，而出厂内容**不许有**
     *    格子外的值：那意味着要么表少了一格，要么那个数值本来就不该那么细。
     */
    if (leaf.offGrid) {
      offGridList.push(`${label} = ${v}（点表：${leaf.values.join('/')}）`)
    }
    if (leaf.values[leaf.index] !== v) {
      offGridList.push(`${label} 的下标指错了：values[${leaf.index}] ≠ ${v}`)
    }

    // 3. 档位不能多 —— 玩家要的是"选择"，不是"微调"
    if (leaf.values.length > 10) {
      tooMany.push(`${label}：${leaf.values.length} 档`)
    }

    // 4. 写回去读得回来（挑一个中间的档位）
    const copy = clone(skill)
    const probe = leaf.values[Math.floor(leaf.values.length / 2)] ?? v
    setByPath(copy, leaf.path, probe)
    if (getByPath(copy, leaf.path) !== probe) unwritable.push(label)
  }

  const problems: string[] = []
  if (unreadable.length > 0) problems.push(`读取不到：${unreadable.slice(0, 4).join(', ')}`)
  if (offGridList.length > 0) problems.push(`当前值不在点表上：${offGridList.slice(0, 4).join(' | ')}`)
  if (tooMany.length > 0) problems.push(`档位太多：${tooMany.slice(0, 4).join(' | ')}`)
  if (unwritable.length > 0) problems.push(`写不回去：${unwritable.slice(0, 4).join(', ')}`)

  if (problems.length > 0) {
    console.log(`  ✗ ${file}`)
    for (const p of problems) console.log(`      ${p}`)
    failed++
  } else {
    console.log(`  ✓ ${file}  （${leaves.length} 个可调数值）`)
    passed++
  }
}

// ---------------------------------------------------------------- 覆盖度

console.log('\n编辑器：覆盖度')

{
  // 每个技能至少得抽出点什么，否则这个编辑器对它就是一片空白
  const empty = files.filter(f => {
    const skill = readJson<Skill>(resolve(DIR, f))
    return collectLeaves(skill).length === 0
  })
  ok('每个技能都有可调的数值', empty.length === 0, empty.join(', '))
  ok('总数不为零', totalLeaves > 30, `总共 ${totalLeaves} 个`)
  console.log(`      （七个技能合计 ${totalLeaves} 个可调数值）`)
}

// ---------------------------------------------------------------- 档位要少

console.log('\n编辑器：档位是"选择"，不是"微调"')

{
  /*
   * ⚠ 玩家原话：「数值选择的滑条不必有那么多取值，大部分用三五个取值就够了，
   *   最多也不要超过 10 个。」
   *
   *   第一版是 min/max/step：0~300 的伤害有 300 个取值，拖一格差 1 点 ——
   *   既调不准也没有"选择"的感觉。现在是点表。
   */
  const all = files.flatMap(f => collectLeaves(readJson<Skill>(resolve(DIR, f))))

  const counts = all.map(l => l.values.length).sort((a, b) => a - b)
  const max = counts[counts.length - 1] ?? 0
  const median = counts[Math.floor(counts.length / 2)] ?? 0
  const small = counts.filter(n => n <= 6).length / counts.length
  const avg = counts.reduce((a, b) => a + b, 0) / counts.length

  ok('没有任何一个数值超过 10 档（上限是硬要求）', max <= 10, `最多的一个有 ${max} 档`)
  ok('中位数不超过 5 档（"大部分三五个"）', median <= 5, `中位 ${median} 档`)
  /*
   * ⚠ 这里不是"八成"，是"七成" —— 因为**规则位是条数**，
   *   它的点表是 0..8 全整数（玩家要求：0 到 8 每档都要有）。
   *   计数的格子和属性的格子不一样，"5 条"和"6 条"是两个不同的东西，
   *   跳档在计数上没有意义。9 档仍然在"最多 10 个"这条硬线以内。
   */
  ok('至少七成数值在 6 档以内', small >= 0.7, `${(small * 100).toFixed(0)}%`)
  console.log(`      （${all.length} 个数值：平均 ${avg.toFixed(1)} 档，中位 ${median} 档，最多 ${max} 档，${
    (small * 100).toFixed(0)}% 在 6 档以内）`)

  // 档位必须严格递增，而且互不相同
  const bad = all.filter(l => {
    for (let i = 1; i < l.values.length; i++) {
      if (!((l.values[i] ?? 0) > (l.values[i - 1] ?? 0))) return true
    }
    return false
  })
  ok('每一张点表都是严格递增的', bad.length === 0, bad.slice(0, 3).map(l => l.label).join(' / '))

  // 出厂内容**一个格子外的值都不许有**
  const off = all.filter(l => l.offGrid)
  ok('出厂内容全部落在点表上（没有临时插进来的格子）', off.length === 0,
    off.slice(0, 3).map(l => `${l.label}=${l.value}`).join(' | '))
}

{
  // 阶段时长一定要能调 —— 那是手感最直接的一个旋钮
  const skill = readJson<Skill>(resolve(DIR, 'cleave.json'))
  const leaves = collectLeaves(skill)
  const durations = leaves.filter(l => l.path[l.path.length - 1] === 'duration')
  const phaseDurations = durations.filter(l => l.group === '阶段')

  ok('cleave 的三个阶段时长都能调', phaseDurations.length === 3,
    `实际 ${phaseDurations.length} 个（另外 ${durations.length - phaseDurations.length} 个是状态时长）`)
  // 阶段时长是"零点几秒"的量级，状态时长是"几秒到几十秒"的量级
  ok('阶段时长的档位都是短时长（最长 3 秒）',
    phaseDurations.every(l => (l.values[l.values.length - 1] ?? 0) <= 3),
    phaseDurations.map(l => `${l.label}:${l.values.join('/')}`).join(' '))
  ok('状态时长的档位里有长时长（超过 10 秒）',
    durations.filter(l => l.group !== '阶段').some(l => (l.values[l.values.length - 1] ?? 0) > 10),
    durations.filter(l => l.group !== '阶段').map(l => l.values.join('/')).join(' '))
}

{
  // 状态时长能到 25 秒（名刀的冷却）
  const blade = readJson<Skill>(resolve(DIR, 'named-blade.json'))
  const leaves = collectLeaves(blade)
  const cool = leaves.find(l => l.path[l.path.length - 1] === 'duration' && l.value === 25)
  ok('名刀的 25 秒冷却就在点表上（不用临时插值）',
    cool !== undefined && cool.values.includes(25) && !cool.offGrid,
    cool === undefined ? '没抽到 25 秒那个时长' : `${cool.value} ∈ {${cool.values.join(', ')}} offGrid=${cool.offGrid}`)
  ok('它是「规则」组（在状态里），不是「阶段」组', cool?.group === '规则', cool?.group)
}

{
  // 蓄力阶段的 -1 是哨兵值，点表第一格就是它
  const laser = readJson<Skill>(resolve(DIR, 'charged-laser.json'))
  const leaves = collectLeaves(laser)
  const charge = leaves.find(l => l.group === '阶段' && l.label.includes('蓄力') && l.path[l.path.length - 1] === 'duration')
  ok('蓄力阶段的 -1 是点表的第一格',
    charge !== undefined && charge.values[0] === -1,
    charge === undefined ? '没抽到蓄力阶段的时长' : `{${charge.values.join(', ')}}`)
  ok('并且带了说明', charge?.hint !== undefined)
}

// ---------------------------------------------------------------- 标题必须是人话

console.log('\n编辑器：滑块标题必须是人话（玩家 2026-09-21 点名的那条）')

{
  /*
   * ⚠ 玩家原话：
   *   > 也不要有「捅中的人被挑飞出去 · #0 · 值」这种白话，
   *   > 因为这里该写「击飞」，并且「#0值」又是什么？
   *
   *   三个毛病一次说清：
   *     「捅中的人被挑飞出去」 —— 那是手写的 `note`（设计意图），不是字段名
   *     「#0」               —— 数组下标漏到界面上了
   *     「值」               —— `const` 的兜底名字，什么信息都没有
   *
   * 所以下面这三条是**回归断言**：哪天再有人在标题里塞这些，当场红灯。
   */
  const all = files.flatMap(f => collectLeaves(readJson<Skill>(resolve(DIR, f))))

  const withIndex = all.filter(l => /#\d/.test(l.label))
  ok('标题里没有 #0 这种数组下标', withIndex.length === 0,
    withIndex.slice(0, 5).map(l => l.label).join(' | '))

  const bareValue = all.filter(l => /(^| · )(值|数值|distance|amount|const|状态数值)$/.test(l.label))
  ok('标题不以「值 / 数值」这种没信息的词结尾', bareValue.length === 0,
    bareValue.slice(0, 5).map(l => l.label).join(' | '))

  const rawId = all.filter(l => /(status|entity|skill|tech|char|pipeline)\./.test(l.label))
  ok('标题里不出现 id / 属性路径（status.shield、char.hp.max 这种）',
    rawId.length === 0, rawId.slice(0, 5).map(l => l.label).join(' | '))
}

{
  // 具体那一条：破军突刺的击退距离，标题要写成「命中时 · 击退 · 距离」
  //
  // ⚠ 路径是 `effect[...]`：2026-09-21 起"这个技能是什么"住在 `effect` 里，
  //   规则栏只剩"额外做了什么"（刺空了顺势前冲）。
  const pierce = readJson<Skill>(resolve(DIR, 'armor-pierce.json'))
  const leaves = collectLeaves(pierce)
  const knockdown = leaves.find(l => l.path.join('.') === 'effect.1.then.0.payload.distance.const')
  ok('击退距离的标题是「命中 · 击退 · 距离」',
    knockdown?.label === '命中 · 击退 · 距离', knockdown?.label)

  const damage = leaves.find(l => l.path.join('.') === 'effect.0.then.0.payload.amount.const')
  ok('伤害的标题是「命中 · 伤害」（不重复写两遍）',
    damage?.label === '命中 · 伤害', damage?.label)

  // 阶段里那个数是**时长**，不是「持续」（状态才叫持续）
  const phaseDur = leaves.find(l => l.path.join('.') === 'phases.0.duration')
  ok('阶段时长写成「前摇 · 时长」', phaseDur?.label === '前摇 · 时长', phaseDur?.label)

  // 手写的 note 不该出现在任何标题里（它是设计意图，只在效果/规则那一行做小字）
  const noteLeak = leaves.filter(l => l.label.includes(pierce.effect?.[1]?.note ?? '@@'))
  ok('手写的 note 没有漏进标题', noteLeak.length === 0, noteLeak.map(l => l.label).join(' | '))

  // ⚠ 固有效果和规则必须在**不同的组**里（玩家第 1 条：效果不进规则栏）
  ok('固有效果单独一组（不在「规则」里）',
    leaves.some(l => l.group === '固有效果') && leaves.some(l => l.group === '规则'),
    [...new Set(leaves.map(l => l.group))].join(' / '))
}

// ---------------------------------------------------------------- 技能介绍

console.log('\n编辑器：每个技能都要有「技能介绍」（玩家 2026-09-21 要的）')

{
  /*
   * ⚠ 玩家原话：
   *   > 技能要在编辑器中有技能介绍。（不必一句话，要介绍清楚）
   *
   *   它是**唯一允许手写**的那类说明（别的说明必须从数据生成）。
   *   手写 + 数字 = 一定和数值脱节，所以校验器会报 `NOTE_WITH_NUMBER`。
   */
  const skills = files.map(f => readJson<Skill>(resolve(DIR, f)))
  const missing = skills.filter(s => (s.note ?? '').trim() === '')
  ok('出厂内容里每个技能都写了介绍', missing.length === 0,
    missing.map(s => s.id).join(', '))

  const numbered = skills.filter(s => /[0-9０-９]/.test(s.note ?? ''))
  ok('介绍里没有数字（数字会和数值脱节）', numbered.length === 0,
    numbered.map(s => `${s.id}: ${s.note}`).join(' | '))

  const tooShort = skills.filter(s => (s.note ?? '').length < 15)
  ok('介绍不是一句敷衍（都写清楚了）', tooShort.length === 0,
    tooShort.map(s => `${s.id}: ${s.note}`).join(' | '))

  const asciiQuote = skills.filter(s => (s.note ?? '').includes('"'))
  ok('介绍里不用 ASCII 引号（JSON 里会出事）', asciiQuote.length === 0,
    asciiQuote.map(s => s.id).join(', '))
}

// ---------------------------------------------------------------- 单位与分组

console.log('\n编辑器：单位与分组（玩家问出来的两件事）')

{
  /*
   * ⚠ 玩家原话：「属性设置应该加上 s、m 这样的单位。」
   *
   *   面板上写着「挥砍 · 时长  0.2」和写着 `0.2 s`，理解成本完全不同 ——
   *   前者要猜，后者不用。
   */
  const all = files.flatMap(f => collectLeaves(readJson<Skill>(resolve(DIR, f))))

  const withUnits = all.filter(l => l.unit !== '')
  ok('有单位的数值都真的标了单位',
    all.every(l => l.unit !== '' || !l.path.includes('delivery')),
    all.filter(l => l.unit === '' && l.path.includes('delivery')).map(l => l.label).join(', '))

  ok('时长是秒', all.filter(l => l.path[l.path.length - 1] === 'duration').every(l => l.unit === 's'),
    all.filter(l => l.path[l.path.length - 1] === 'duration' && l.unit !== 's').map(l => l.label).join(', '))
  ok('距离是米',
    all.filter(l => ['radius', 'length', 'width'].includes(String(l.path[l.path.length - 1])))
      .every(l => l.unit === 'm'),
    all.filter(l => ['radius', 'length', 'width'].includes(String(l.path[l.path.length - 1])) && l.unit !== 'm')
      .map(l => `${l.label}=${l.unit}`).join(', '))
  ok('速度是米每秒',
    all.filter(l => l.path[l.path.length - 1] === 'speed').every(l => l.unit === 'm/s'))
  ok('张角是度',
    all.filter(l => l.path[l.path.length - 1] === 'angle').every(l => l.unit === '°'))
  console.log(`      （${withUnits.length} / ${all.length} 个数值带单位）`)
}

{
  /*
   * ⚠ 玩家原话：「收招 · 冷却是干嘛的？如果是冷却时间那没必要标注是收招，
   *   如果是选择进入冷却的阶段那取值应该是阶段而不是秒数。」
   *
   *   答案是**两件事都要说**：数值是"多长"，阶段是"从什么时候开始算"。
   *   所以它单独分成「代价」一组（不再埋在阶段下面），并且带一句说明。
   */
  const all = files.flatMap(f => collectLeaves(readJson<Skill>(resolve(DIR, f))))
  const costs = all.filter(l => l.path.includes('cost'))

  ok('阶段上的代价单独分成「代价」组', costs.length > 0 && costs.every(l => l.group === '代价'),
    costs.filter(l => l.group !== '代价').map(l => `${l.label}=${l.group}`).join(', '))
  ok('每一条代价都解释了"数值是多久、阶段是什么时候"',
    costs.every(l => (l.hint ?? '').includes('什么时候付')),
    costs.filter(l => !(l.hint ?? '').includes('什么时候付')).map(l => l.label).join(', '))
  ok('冷却的单位还是秒（它是时长，不是阶段）',
    costs.filter(l => l.path[l.path.length - 1] === 'cooldown').every(l => l.unit === 's'))
}

{
  // ⚠ 玩家原话：「规则位上限的数值应该为 012345678」
  const all = files.flatMap(f => collectLeaves(readJson<Skill>(resolve(DIR, f))))
  const slots = all.filter(l => l.path[l.path.length - 1] === 'ruleSlots')

  ok('规则位上限的档位就是 0 到 8，一个不缺',
    slots.length > 0 && slots.every(l => l.values.join(',') === '0,1,2,3,4,5,6,7,8'),
    slots.map(l => `{${l.values.join(',')}}`).join(' '))
}

// ---------------------------------------------------------------- 点数必须是算出来的

console.log('\n编辑器：点数由内容推导')

{
  /*
   * ⚠ 这是整套测试里最重要的一条。
   *
   * 第一版把点数**手写**在规则和阶段上。玩家在编辑器里把"30 伤害"拖到"300 伤害"，
   * 点数纹丝不动 —— 等于可以白嫖。这是在编辑器里实测踩到的。
   *
   * 现在的规矩是：点数由内容推导，JSON 里一个 points 都不许存。
   */
  const withPoints = files.filter(f =>
    readFileSync(resolve(DIR, f), 'utf8').includes('"points"'))
  ok('技能 JSON 里不再存 points（存了就一定会和数值脱节）',
    withPoints.length === 0, withPoints.join(', '))
}

{
  // 算出来的总账不能被当成可调项塞进滑块
  const skill = readJson<Skill>(resolve(DIR, 'cleave.json'))
  const derived = collectLeaves(skill).filter(l => l.path[l.path.length - 1] === 'points')
  ok('算出来的点数没有被当成可调项', derived.length === 0,
    derived.map(l => l.path.join('.')).join(', '))
}

{
  // 核心回归：把伤害调大，点数必须变（而且是变少 —— 收益变多了）
  const skill = readJson<Skill>(resolve(DIR, 'cleave.json'))
  const before = totalOf(skill)

  // ⚠ 伤害住在 `effect[0]` 里（"这个技能是什么"），不在 rules 里
  const hit = skill.effect?.[0]
  const dmg = hit?.then?.[0]?.payload
  ok('找得到那条伤害规则', dmg?.kind === 'damage', dmg?.kind)

  const copy = clone(skill)
  const target = copy.effect?.[0]?.then?.[0]?.payload
  if (target !== undefined && target.kind === 'damage' && target.amount !== undefined) {
    target.amount.const = 300
  }
  const after = totalOf(copy)

  ok('把 30 伤害改成 300 伤害，总点数跟着变',
    after !== before, `改前 ${before}，改后 ${after}`)
  ok('伤害变高会消耗更多额度，点数变小', after < before, `改前 ${before}，改后 ${after}`)

  // 反向验证：时长的账也要能动
  /*
   * ⚠⚠ 2026-09-30（日志 57）这里原来拖的是 `0.15s → 0.9s`。
   *   账上印整数之后（每个非零条目**至少 1 点**），那两档的原料差 0.647 点，
   *   **落在同一格里**（都是 +1）—— 量不出来不是 bug，是整数账的地板。
   *   ⇒ 改成拖过地板的两档（0.15s → 3s）。
   */
  const slow = clone(skill)
  const phase = slow.phases.find(p => p.id === 'windup')
  if (phase !== undefined) phase.duration = 3
  ok('把起手从 0.15s 拖到 3s，总点数跟着变',
    totalOf(slow) !== before, `改前 ${before}，改后 ${totalOf(slow)}`)
}

// ---------------------------------------------------------------- 技能页（编辑器 UI 第一片）
//
// ⚠⚠ 2026-10-06：这一片把技能页照用户给的设计模板改成"技能库 + 编辑区"两块屏，
//   并落了三条用户定的规矩。它们全是**纯逻辑**（在哪一档、能不能拖、属于哪一组），
//   所以在这里钉住 —— 界面那边（`tests/web.ts`）只能断字符串，钉不住这些判据。

console.log('\n技能页：时长是四档选择，不是线性滑块（用户 2026-09-21 定死的形状）')

{
  /*
   * 四档 = 无 / 1× / 3× / 9×，**相对这个技能自己的出厂时长**；
   * `-1`（蓄力哨兵）是**单独一档** —— 它和「无」（0 秒）在数据上是两个不同的数。
   */
  const tier = tierChoices(0.1, (s) => s === 0 || s === 0.1 || s === 0.3 || s === -1)

  ok('四档就是 无 / 1× / 3× / 9×',
    tier.slice(0, 4).map(t => t.label).join('/') === '无/1×/3×/9×',
    tier.map(t => t.label).join('/'))

  ok('秒数按**这个技能自己的**出厂时长算（0.1 ⇒ 0 / 0.1 / 0.3 / 0.9）',
    tier.slice(0, 4).map(t => t.seconds).join(',') === '0,0.1,0.3,0.9',
    tier.map(t => t.seconds).join(','))

  ok('1× 就是出厂值本身，而且标着「默认」（账上恒 0 点的那一档）',
    tier[1]?.neutral === true && tier[1]?.seconds === 0.1,
    `neutral=${String(tier[1]?.neutral)} seconds=${String(tier[1]?.seconds)}`)

  ok('⚠ 蓄力（−1）单独一档，**不和「无」合并**（0 秒 ≠ "按住键"）',
    tier.length === 5 && tier[4]?.tier === -1 && tier[4]?.seconds === -1 && tier[0]?.seconds === 0,
    tier.map(t => `${t.label}:${t.seconds}`).join(' '))

  ok('账上没有那一格的档标成 available=false（死滑块铁律：不给点）',
    tier.filter(t => t.available).map(t => t.label).join('/') === '无/1×/3×/蓄力'
    && tier[3]?.available === false,
    tier.map(t => `${t.label}=${String(t.available)}`).join(' '))

  // ⚠ 浮点必须收敛：0.1 × 3 = 0.30000000000000004，而点表的键是 "0.3"
  ok('浮点收敛：0.1 的 3× 认得出是 0.3（不然这一档查不到格 = 静默变成"死"的）',
    tierSeconds(0.1, 3) === 0.3 && String(tierSeconds(0.3, 9)) === '2.7',
    `${tierSeconds(0.1, 3)} / ${tierSeconds(0.3, 9)}`)
}

console.log('\n技能页：出厂内容的四档时长在账上有价吗（死滑块铁律的实测）')

{
  /*
   * ⚠ 这一条钉的是**"中性档永远有格"**，也就是"出厂技能恒 0 点"的地基：
   *   1× 那一档必须每一段都查得到，而且那格的值必须是 0。
   *
   * ⚠⚠ 2026-09-30（日志 63）：**"有价可查"的判据换了一条路**。
   *
   *   以前数的是 `lookupTable` 里"恰好有那一格"（绝对秒数那条老路）——
   *   出厂内容实测：`1×` 58/58、`蓄力` 58/58、`3×` 只有 16/58、`9×` **一格都没有**、
   *   `无` 只有 3/58。那几档因此在界面上**置灰**（"拖了不动的不给点"）。
   *
   *   现在四档走**倍数档表**（`tierTables.phaseDurationPoints`，含按技能覆盖），
   *   判据是 `phaseDurationTierPriceOf`（**和账本、和编辑器同一个函数**）。
   *   ⇒ 四档各自 57/58（58 个阶段里唯一不在轴上的那一段**出厂就是蓄力** ——
   *   它没有"1×"可当基准，见 `onDurationTierAxis`）。
   *
   *   ⚠ 老路那一列（`lookupTable` 的原始格子数）**照旧打出来**：
   *   它是"绝对秒数那条路还剩多少格"的证据，一个数都没动（日志 63 的要求）。
   */
  const realBalance = readJson<BalanceConfig>(resolve('content/balance.json'))
  const table = realBalance.lookupTable ?? {}
  const tierTables = readTierTables(realBalance.tierTables)
  let phases = 0
  const badNeutral: string[] = []
  const missingTier: Record<string, number> = { 0: 0, 3: 0, 9: 0 }
  const noPriceTier: Record<string, number> = { 0: 0, 1: 0, 3: 0, 9: 0 }
  /** 不在倍数轴上的段（出厂那一头不是"固定的秒数"）—— 它们**本来就没有档位** */
  const notOnAxis: string[] = []

  for (const dir of ['content/skills', 'content/weapon-skills']) {
    for (const f of readdirSync(resolve(dir)).filter(x => x.endsWith('.json')).sort()) {
      const sk = readJson<Skill>(resolve(dir, f))
      const part = (table as Record<string, Record<string, Record<string, number>>>)[sk.id] ?? {}
      sk.phases.forEach((p, i) => {
        phases++
        const row = part[`phases.${i}.duration`] ?? {}
        if (row[String(p.duration)] !== 0) badNeutral.push(`${sk.id} phases.${i}（出厂 ${p.duration}s）`)
        for (const t of [0, 3, 9]) {
          const sec = t === 0 ? 0 : Number((p.duration * t).toFixed(10))
          if (!Object.prototype.hasOwnProperty.call(row, String(sec))) missingTier[t]++
        }
        // ⚠ 新判据：倍数档走表，**四档各自有没有价**
        if (!(p.duration > 0)) notOnAxis.push(`${sk.id} phases.${i}（出厂 ${p.duration}s）`)
        for (const t of [0, 1, 3, 9]) {
          const sec = t === 0 ? 0 : Number((p.duration * t).toFixed(10))
          if (phaseDurationTierPriceOf(p.duration, sec, { tierTables }, sk.id) === undefined) noPriceTier[t]++
        }
      })
    }
  }

  ok('每一个阶段的 1× 档在账上都有一格、而且那一格是 0 点（"出厂恒 0"的地基）',
    phases > 0 && badNeutral.length === 0,
    `${badNeutral.slice(0, 4).join(' / ')}（共 ${badNeutral.length} 处，阶段 ${phases} 个）`)
  ok('⭐ 四档**每一档都有价可查**（倍数档走表）：58 个阶段里只有"出厂就是蓄力"那一段不在轴上',
    notOnAxis.length === 1 && notOnAxis[0]?.includes('charged-laser')
    && [0, 1, 3, 9].every(t => noPriceTier[t] === notOnAxis.length),
    `没价的：无 ${noPriceTier[0]} / 1× ${noPriceTier[1]} / 3× ${noPriceTier[3]} / 9× ${noPriceTier[9]}`
    + `（共 ${phases} 个阶段，不在轴上的 ${notOnAxis.length} 个：${notOnAxis.join('、')}）`)
  console.log(`      （老路那一列的"账上还没格"数量：无 ${missingTier[0]} / 3× ${missingTier[3]} / 9× ${missingTier[9]}`
    + ' —— 那是 `lookupTable` 的**绝对秒数格**，日志 63 **一个数都没动**；'
    + '倍数额走的是 `tierTables.phaseDurationPoints`，界面不再因此置灰）')
}

console.log('\n技能页：死旋钮（拖了账上不动的不给拖）')

{
  ok('整行同值 = 死的（校验器报 LOOKUP_DEAD_KNOB）',
    knobState({ '0': 0, '1': 0, '2': 0 }) === 'dead'
    && knobState({ '0': -1, '1': 0 }) === 'live',
    knobState({ '0': 0, '1': 0 }))
  ok('表里没这一项 = 不进账（不是"值 0"，是"根本没这一项"）',
    knobState(undefined) === 'unpriced' && knobState({}) === 'unpriced')
  ok('两种"不给拖"各自说出了原因（静默置灰会被读成"坏了"）',
    knobReason('dead').includes('LOOKUP_DEAD_KNOB')
    && knobReason('unpriced').includes('lookupTable')
    && knobReason('live') === '')
  ok('取值 → 那一格的点数（没有这一格时返回 undefined，**不许当 0**）',
    cellOf({ '0.3': 2 }, 0.3) === 2 && cellOf({ '0.3': 2 }, 0.9) === undefined)
}

console.log('\n技能页：数值叶子归到哪一组（三组控件的归属规则）')

{
  ok('阶段时长归"阶段那一块"（四档控件接管，不再进通用滑块列表）',
    isPhaseDurationLeaf(['phases', 0, 'duration']) === true
    && isPhaseDurationLeaf(['rules', 0, 'then', 0, 'payload', 'inline', 'duration']) === false)
  ok('冷却是技能唯一的属性（自有控件）',
    isCooldownLeaf(['phases', 2, 'cost', 'cooldown']) === true)
  ok('载体形状参数归"效果发生在哪里"那一组',
    isDeliveryShapeLeaf(['effect', 0, 'then', 0, 'delivery', 'radius']) === true
    && isDeliveryShapeLeaf(['rules', 1, 'then', 0, 'delivery', 'angle']) === true
    && isDeliveryShapeLeaf(['effect', 0, 'then', 0, 'payload', 'amount', 'const']) === false)
  ok('瞄准将来有点表数值时归"瞄准"那一组（今天这一支是空的口子）',
    leafZone(['targeting', 'range']) === 'aim'
    && leafZone(['effect', 0, 'then', 0, 'delivery', 'radius']) === 'carrier'
    && leafZone(['effect', 0, 'then', 0, 'payload', 'amount', 'const']) === 'rest')
}

console.log('\n技能页：形态露出来了（今天之前界面上完全没有）')

{
  ok('不写形态就是瞬发（schema 定的默认值）', formOf({}) === 'instant')
  ok('四个形态都有中文名',
    ['instant', 'charged', 'sustained', 'passive'].every(f => (FORM_LABEL as Record<string, string>)[f] !== undefined),
    Object.values(FORM_LABEL).join('/'))
  ok('每个形态都有一句"为什么是它"', ['instant', 'charged', 'sustained', 'passive']
    .every(f => formWhy(f as 'instant').length > 4))
  ok('⚠ 用户点名要写在界面上的那一句，逐字一致',
    PERMANENT_NOTE === '常驻不占键位，但每次触发照样付能量和冷却', PERMANENT_NOTE)
}

console.log('\n技能页：宿主（作用在谁身上）碰到脏内容不许瞎猜')

{
  /*
   * ⚠ `content/skills/lava-armor.json` 的 r3 把 `Action.target` 写成了一个
   *   `{mode, valid}` 对象 —— 那是**内容里的脏数据**（别的片在管 content/**）。
   *   界面只负责**不把它读成"自己"**：认不出来就如实说认不出来。
   */
  ok('不写 = "按对面那个"', hostTargetLabel(undefined).includes('对面那个'))
  ok('认得 hit / self', hostTargetLabel('self').includes('宿主自己') && hostTargetLabel('hit').includes('对面'))
  ok('⚠ 对象那种脏数据要如实说"认不出"，**不许**当成 self',
    hostTargetLabel({ mode: 'auto', valid: ['enemy'] }).includes('不是')
    && !hostTargetLabel({ mode: 'auto', valid: ['enemy'] }).includes('宿主自己'),
    hostTargetLabel({ mode: 'auto', valid: ['enemy'] }))
}

console.log('')
if (failed > 0) {
  console.log(`✗ ${failed} 个断言失败（${passed} 个通过）`)
  process.exitCode = 1
} else {
  console.log(`✓ 全部 ${passed} 个断言通过`)
  process.exitCode = 0
}
