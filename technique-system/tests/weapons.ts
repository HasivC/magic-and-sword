/**
 * 武器 + 序列层。
 *
 * ## 分两半
 *
 * **数据模型**（2026-09-21 上一轮）：属性缺省值、只读标记、序列术式的形状、
 * 悬空引用。这一半里有三件事手测不出来，而且坏法全是静默的：
 *
 *   1. **武器属性的缺省值。** `weapon.reach` 忘写时不该得到一把
 *      打不到人的剑。缺省逻辑错了的表现是"我明明按了普攻"。
 *   2. **两个术式槽的悬空引用。** 写错名字的表现是"左键没反应"。
 *   3. **序列术式的形状。** 一个技能都不带（只挂 `sequences`），
 *      判据只认 `skills` 的地方会把它悄悄丢掉。
 *
 * **运行时**（2026-09-21 这一轮）：武器是**实体**，能捡起来、能换掉，
 * 换下来的那把掉在原地。这一半手测只能测"看着对不对"，
 * 而真正会坏的是**状态**：谁手上有哪把武器（伤害靠它）、
 * 地上还剩几件、两把武器是不是共享了同一张属性表。
 */
import { resolve } from 'node:path'
import { loadLibrary } from '../src/bridge.ts'
import { readJson, collectJsonFiles } from '../src/loader.ts'
import { compileTechnique } from '../src/sim/compile.ts'
import type { CompiledMod, CompiledSegment } from '../src/sim/compile.ts'
import { groupPlanOf, layoutPlanOf, placementOptionsOf } from '../src/sim/trigger.ts'
import { allRulesOf } from '../src/effects.ts'
import type { CompiledTechnique } from '../src/sim/compile.ts'
import { WEAPON_DEFAULTS, weaponParam } from '../src/sim/types.ts'
import { bloodPactCostOf, priceOptionsFor, priceTechnique } from '../src/pricing.ts'
import { lowerScenario, applyScenario } from '../src/scenario.ts'
import {
  PICKUP_RANGE, equipItem, nearestPickup, pickupNearby, weaponAttribute,
} from '../src/sim/equip.ts'
import { createWorld, getEntity, registerTechnique, snapshot, spawn, stepWorld } from '../src/sim/world.ts'
import { activate, interruptCast, pressSequence } from '../src/sim/cast.ts'
import { advance } from '../src/sim/world.ts'
import { applyStatus } from '../src/sim/status.ts'
import { getStored, setStored } from '../src/sim/attributes.ts'
import type { Entity } from '../src/sim/types.ts'
import { validateSkill, validateTechnique, validateWeapon } from '../src/validator/index.ts'
import { validateModifierProto } from '../src/validator/checks.ts'
import type { BalanceConfig } from '../src/validator/types.ts'
import type { Scenario, Technique, WeaponDef, Skill } from '../src/schema.ts'

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

/** 相等断言（这一节里用得多：一边是实际值、一边是期望值） */
function eq(name: string, actual: unknown, expected: unknown): void {
  ok(name, Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected),
    '实际 ' + JSON.stringify(actual) + '，期望 ' + JSON.stringify(expected))
}

function section(title: string): void {
  console.log(`\n${title}`)
}

const balance = readJson<BalanceConfig>(resolve('content/balance.json'))

// ============================================================================
//  1. 武器属性的代入与缺省
// ============================================================================

section('武器属性：同一份技能模板，代入不同的值')

{
  const longsword = readJson<WeaponDef>(resolve('content/weapons/longsword.json'))

  ok('长剑的属性读得到 weapon.reach',
    weaponParam(longsword.attributes, 'weapon.reach') === longsword.attributes['weapon.reach'],
    `属性表=${JSON.stringify(longsword.attributes)}`)

  /*
   * ⚠ 这条钉的是**"同一份模板在不同武器上不一样"**这个设计承诺。
   *   短匕只写了 damage，没写 reach —— 它必须退到全局缺省值，
   *   而不是 0（0 米 = 打不到人，而且界面上完全看不出来）。
   */
  const dagger: WeaponDef = {
    schemaVersion: 1,
    id: 'weapon.dagger-test',
    name: '短匕（测试用）',
    attributes: { 'weapon.damage': 0.6 },
  }

  ok('没写 reach 的武器落到全局缺省值（不是 0）',
    weaponParam(dagger.attributes, 'weapon.reach') === WEAPON_DEFAULTS['weapon.reach']
    && WEAPON_DEFAULTS['weapon.reach'] > 0,
    `reach=${weaponParam(dagger.attributes, 'weapon.reach')}`)

  ok('缺省表和 schema 注释里写的一致（2.5 / 1 / 1）',
    WEAPON_DEFAULTS['weapon.reach'] === 2.5
    && WEAPON_DEFAULTS['weapon.damage'] === 1
    && WEAPON_DEFAULTS['weapon.windup'] === 1,
    JSON.stringify(WEAPON_DEFAULTS))

  ok('写了的属性优先于缺省值',
    weaponParam(dagger.attributes, 'weapon.damage') === 0.6)

  /*
   * ⚠ 写坏的值（字符串、NaN）也要退回缺省 —— 手改 JSON 时很容易写成 "0.6"。
   *   认了它的话，伤害会变成 0（`"0.6" * 25` = NaN，一路传下去）。
   */
  const broken = { 'weapon.damage': '0.6' } as unknown as Record<string, number>
  ok('写坏的值（字符串）退回缺省，不会变成 NaN',
    weaponParam(broken, 'weapon.damage') === 1)
}

// ============================================================================
//  2. 武器技能是只读的
// ============================================================================

section('武器技能模板：编辑器不给改')

{
  const weaponSkills = collectJsonFiles('content/weapon-skills').map(f => readJson<Skill>(f))

  ok('内容里至少有两份武器技能模板（横砍 / 刺击）',
    weaponSkills.length >= 2,
    `实际 ${weaponSkills.length} 份`)

  ok('它们都带 readonly: true（编辑器里不给改数值）',
    weaponSkills.every(s => s.readonly === true),
    weaponSkills.map(s => `${s.id}=${String(s.readonly)}`).join(' '))

  /*
   * ⚠ 反过来说：**玩家技能不许带 readonly**。
   *   带上的话编辑器会不给改 —— 而它本该是玩家自己的零件。
   */
  const playerSkills = collectJsonFiles('content/skills').map(f => readJson<Skill>(f))
  ok('玩家技能没有一个带 readonly（那是玩家自己的零件）',
    playerSkills.every(s => s.readonly !== true),
    playerSkills.filter(s => s.readonly === true).map(s => s.id).join(' '))

  /*
   * ⚠ 武器技能的伤害必须走 `ref: 'weapon.damage'`，不能写死数字。
   *   写死的话"同一份模板在不同武器上数值不同"就不成立了 ——
   *   而这条正是玩家要的东西。
   *
   * ⚠ 走 `allRulesOf`：2026-09-21 起"这个技能是什么"住在 `effect` 里，
   *   只看 `rules` 的话这条断言会在**武器技能**上悄悄失明
   *   （它的伤害动作已经搬进 effect 了）。
   */
  const slash = weaponSkills.find(s => s.id === 'skill.ws-slash')
  const damageRule = (slash === undefined ? [] : allRulesOf(slash)).flatMap(r => r.then)
    .find(a => a.payload?.kind === 'damage')
  const amount = damageRule?.payload?.kind === 'damage' ? damageRule.payload.amount : undefined
  const ref = typeof amount === 'object' && amount !== null && 'ref' in amount
    ? (amount as { ref?: unknown }).ref
    : undefined

  ok('横砍的伤害读的是 weapon.damage，不是写死的数字',
    ref === 'weapon.damage',
    `实际 ref=${JSON.stringify(ref)}`)
}

// ============================================================================
//  3. 序列术式：形状、编译、引用
// ============================================================================

section('序列术式：只挂序列、不带技能')

{
  const lib = loadLibrary(balance)

  ok('内容库能整个加载出来（0 条编译问题）',
    lib.problems.length === 0,
    lib.problems.map(p => p.message).join(' | '))

  ok('武器技能和玩家技能进的是**同一张**技能表（术式按 id 引用，不分来源）',
    lib.skills.has('skill.ws-slash') && lib.skills.has('skill.cleave'),
    [...lib.skills.keys()].join(' '))

  ok('武器表里有长剑',
    lib.weapons.has('weapon.longsword'),
    [...lib.weapons.keys()].join(' '))

  const basic = lib.compiled.get('tech.longsword-basic')
  ok('武器术式编译出来了',
    basic !== undefined,
    [...lib.compiled.keys()].join(' '))

  /*
   * ⚠ 2026-09-21（日志 46）序列**内联**之后，这里断言的是**每一段的身份和内容**：
   *   · `segments[i].technique.id` = 那一段的术式 id —— **它就是冷却键**
   *     （`cd.<id>`），所以它必须还是旧子术式那个 id（行为逐位不变）
   *   · `segments[i].technique.skillIds` = 这一段用了哪个技能
   *
   *   ⚠ 为什么不断言"段的 `name`"：那是给人看的、不影响行为 ——
   *     拿它当判据的话，改个显示名字就会让测试变红。
   */
  ok('它带上了两段序列（横砍 → 刺击）',
    basic?.segments?.length === 2
    && basic.segments[0]?.technique.id === 'tech.ws-slash'
    && basic.segments[1]?.technique.id === 'tech.ws-thrust',
    JSON.stringify(basic?.segments?.map(s => s.technique.id)))

  ok('  每一段自己带着它的技能（内联之后技能就在段里）',
    basic?.segments?.[0]?.technique.skillIds.join(',') === 'skill.ws-slash'
    && basic?.segments?.[1]?.technique.skillIds.join(',') === 'skill.ws-thrust',
    JSON.stringify(basic?.segments?.map(s => s.technique.skillIds)))

  ok('超时默认 1 秒（两条序列之间最多隔多久还算连着）',
    basic?.sequenceTimeout === 1,
    String(basic?.sequenceTimeout))

  /*
   * ⚠ 序列术式的 phases / rules 是**空的**，这是对的：
   *   时间轴在每一条序列里，不在这一层。走序列是输入层的事（下一轮）。
   *   这一条钉的是"空不是 bug，是这个模型的正常形状"。
   */
  ok('它自己的时间轴是空的（时间轴在每一条序列里）',
    basic?.phases.length === 0 && basic?.rules.length === 0)

  ok('普攻免费：武器术式不带血契消耗（武器术式不算账 ⇒ 也就没有"负值术式"）',
    basic?.bloodPactCost === 0,
    String(basic?.bloodPactCost))
}

// ============================================================================
//  4. 武器技能**不算账**（玩家 2026-09-21 的原话）
// ============================================================================

section('武器技能不算账 —— 数值由武器属性代入，校验器看不见那把武器')

{
  const lib = loadLibrary(balance)
  const opts = {
    balance,
    skills: lib.skills,
    statuses: lib.statuses,
    entities: lib.entities,
    techniques: lib.techniques,
  }

  /*
   * ⚠ 玩家原话：
   *   > 我不是说了武器技能不算帐吗
   *
   *   理由是它算出来的那个数是**拿缺省武器属性硬猜**的
   *   （`weapon.damage` 读不到就退到 1），而真正的数值要看装在哪把武器上。
   *   一个猜出来的数字比没有数字更坏：玩家会照着它去调一个不存在的平衡。
   */
  const weaponSkill = validateSkill('(测试)', lib.skills.get('skill.ws-slash') as Skill,
    balance, lib.statuses, lib.entities)
  ok('武器技能（readonly）不报点数明细',
    weaponSkill.ledger.length === 0 && weaponSkill.priceless !== undefined,
    JSON.stringify(weaponSkill.ledger))

  /*
   * ⚠ 2026-09-21（日志 46）序列内联之后，"由武器技能拼成的那个术式"不再是
   *   内容库里独立的一份（`tech.ws-slash` 那份文件删了）—— 它是容器里的一段。
   *
   *   ⚠ 而这一条测的东西**一点没变**：**武器术式不算账、也不判负值术式**。
   *     判据换了一处落地（2026-10-06 日志 64）：从"看技能 `readonly`"
   *     换成 `school.ts` 的 `techniquePaysPoints`（看术式的**系别** `kind`），
   *     所以这里拿"容器里的第一段"当被测对象 —— 它就是同一份东西。
   *
   *   ⚠ 那两段的 `skills` 是武器技能 ⇒ 容器 `kind: "weapon"` ⇒ 不算账。
   */
  const segA = lib.compiled.get('tech.iron-sword-basic')?.segments?.[0]?.technique
  ok('  （前提）铁剑那一段用的是武器技能',
    segA?.skillIds.join(',') === 'skill.ws-slash', JSON.stringify(segA?.skillIds))
  const weaponSeqReport = validateTechnique('(测试)', {
    schemaVersion: 1,
    id: 'tech.seg-probe',
    name: '由武器技能拼成的一段',
    kind: 'weapon',
    activation: 'press',
    // ⚠ 瞄准在**技能**上（2026-09-21 日志 47）：术式这一层不写它，
    //   `skill.ws-slash` 自己带着
    skills: ['skill.ws-slash'],
  }, opts)
  ok('由武器技能拼成的术式：不算账，也不判负值术式',
    weaponSeqReport.ledger.length === 0
    && !weaponSeqReport.issues.some(i => i.code === 'NEGATIVE_TECHNIQUE' || i.code === 'NOT_BALANCED')
    && weaponSeqReport.priceless !== undefined,
    weaponSeqReport.issues.map(i => i.code).join(' '))

  /*
   * ⚠ 血契消耗必须和校验器用**同一句判据** ——
   *   否则会出现"校验器说它不算账，绑上键却扣血契"，
   *   而且是按一个猜出来的数字扣。
   *
   * ⚠⚠ 2026-10-06（日志 64）起这句判据**只剩一个来源**：
   *   血契从**账**里读（`bloodPactCostOf` → `priceTechnique`），而账按系别分
   *   （`school.ts` 的 `techniquePaysPoints`）。改前这里写的是
   *   `if (isWeaponSide(...)) return 0` —— 那是**第二份**判据，两份会漂移。
   */
  ok('武器术式（容器）的血契消耗是 0（普攻不会吃血契）',
    bloodPactCostOf(lib.techniques.get('tech.longsword-basic') as Technique,
      id => lib.skills.get(id),
      priceOptionsFor(balance, lib.statuses, lib.entities)) === 0)

  ok('武器术式（挂了序列的那份容器）也没有账，理由换成了"武器术式不算账"',
    (() => {
      const r = validateTechnique('(测试)', lib.techniques.get('tech.longsword-basic') as Technique, opts)
      return r.ledger.length === 0 && (r.priceless ?? '').includes('武器术式不算账')
    })())

  /*
   * ---- ⚠⚠ 2026-10-06（日志 64）：**账按武器 / 魔法分开算**，这一节钉住它 ----
   *
   * 改前 `priceTechnique` **只读 `tech.skills`**、不看系别 ⇒ 同一份武器术式
   * 会有**两本账**：编辑器那本把「段上的修饰」照收（实测多重释放 ×10 ⇒ −18 点），
   * 而校验器说它"不算账"（旧判据是"挂了 `sequences` ⇒ 不算账"）——
   * **两边都不报错**，而界面上那块账是错的。
   */
  const multi = readJson<{ id: string }>(resolve('content/modifiers/multi-fire.json'))
  const wmOpts = priceOptionsFor(balance, lib.statuses, lib.entities, lib.modifiers)
  const weaponWithMod: Technique = {
    schemaVersion: 1, id: 'tech.test-weapon-mod', name: '武器术式带份数',
    kind: 'weapon', activation: 'press',
    sequences: [{
      skills: ['skill.ws-slash'],
      mods: [{ proto: multi.id, at: 0, params: { count: 10 } }],
    }],
  }
  const wmPriced = priceTechnique(weaponWithMod, id => lib.skills.get(id), wmOpts)
  ok('武器术式 + 多重释放 ×10 ⇒ **一整本空账**（改前这里算的是 −18 点）',
    wmPriced.total === 0 && wmPriced.entries.length === 0,
    `合计 ${String(wmPriced.total)} · ${String(wmPriced.entries.length)} 条`)

  /*
   * ⚠ 反过来的那一半：**魔法术式照常算账**，而且**常驻 / 主动都算**。
   *   改前这两份都会被"序列术式不算账"那句话盖住（校验器给 `priceless`），
   *   而它们的账其实一直在算（血契也照扣）。
   */
  for (const activation of ['press', 'auto'] as const) {
    const magicWithMod: Technique = {
      schemaVersion: 1, id: `tech.test-magic-mod-${activation}`, name: '魔法术式带份数',
      kind: 'magic', activation,
      sequences: [{
        skills: ['skill.magic-bolt'],
        mods: [{ proto: multi.id, at: 0, params: { count: 10 } }],
      }],
    }
    const r = validateTechnique('(测试)', magicWithMod, { ...opts, modifierProtos: lib.modifiers })
    ok(`魔法术式（${activation === 'auto' ? '常驻' : '主动'}）+ 多重释放 ×10 ⇒ **照常算账**`
      + '（有明细、判成负值术式、要付血契）',
      r.ledger.length > 0 && r.priceless === undefined && r.kind === 'negative'
      && r.bloodPactPerUse > 0,
      `账 ${String(r.ledger.length)} 条 · 合计 ${String(r.total)} · priceless=${String(r.priceless)}`)
  }

  /*
   * ⚠⚠ "不算账" **不许**被读成"0 点免费"（用户点名）——
   *   两者的**合计都是 0**、含义正相反，所以那句话必须把区别说出来。
   */
  ok('  "不算账"和"0 点免费"的区别写在文案里（不是只给一个 0）',
    (() => {
      const r = validateTechnique('(测试)', lib.techniques.get('tech.longsword-basic') as Technique, opts)
      return (r.priceless ?? '').includes('不算账') && (r.priceless ?? '').includes('0 点免费')
    })())

  /*
   * ⚠ 反过来说：**玩家自己的术式照样要算账**。
   *   武器侧那条豁免不能漏成"所有术式都不算账"。
   *
   *   ⚠ 注意账是**相对出厂值**算的（宗旨），所以光引用一个出厂技能
   *     得到的是一本**空账** —— 要看见数字，得让这份术式带上
   *     一份**被改过的技能副本**。这里买 6 条规则位：
   *     复杂度税是实打实要花钱的，账上立刻有数。
   */
  const cleave = lib.skills.get('skill.cleave')
  if (cleave === undefined) throw new Error('内容里没有 skill.cleave')
  const variant: Skill = JSON.parse(JSON.stringify(cleave)) as Skill
  variant.id = 'custom.cleave.1'
  variant.name = '裂地斩-副本1'
  variant.basedOn = cleave.id
  /*
   * ⚠⚠ 2026-09-30（日志 60b）**这一笔从"买 6 条"改成了"买 4 条"**，理由是账的算法换了：
   *   现在是**查表 + 相加**，而表里 `ruleSlots` 那一行是 `0…8`（出厂 4 ⇒ 0 点，8 ⇒ −6 点）。
   *   买 6 条 = 10 条 ⇒ **表外取值**（账上会留 `⚠ 表外取值` 记录、点数 0）——
   *   而这一节要的是一份"改强了"的变体（账上有数）。8 = 4 + 4 正好在表里，
   *   这一条要钉的东西（变体相对**模板**算账）一个字都没变。
   */
  variant.ruleSlots += 4

  // 「两个库」= 一张合并后的表（自定义库优先、基础库兜底）
  const twoLibs = new Map(opts.skills)
  twoLibs.set(variant.id, variant)

  const playerTech: Technique = {
    schemaVersion: 1,
    id: 'tech.test-player',
    name: '玩家自己的术式',
    // ⚠ 系别必填（schema 的 Technique.kind）：变体是**魔法系**的（玩家造不出武器系）
    kind: 'magic',
    activation: 'press',
    // ⚠ 瞄准在**技能**上（2026-09-21 日志 47）：变体是从 `skill.cleave` 拷来的，
    //   瞄准跟着它一起拷过来了
    skills: [variant.id],
  }
  const playerReport = validateTechnique('(测试)', playerTech, { ...opts, skills: twoLibs })
  ok('玩家自己的术式照样算账（豁免只给武器侧）',
    playerReport.ledger.length > 0 && playerReport.priceless === undefined,
    `ledger=${playerReport.ledger.length} priceless=${String(playerReport.priceless)}`)
  ok('  变体的账对着它的**基础技能**算，而且标着是哪一段贡献的',
    playerReport.ledger.every(e => e.skillId === variant.id),
    playerReport.ledger.map(e => String(e.skillId)).join(', '))
  ok('  变体买 4 条规则位 → 花掉 4 × ruleSlotBuyCost（查表那一格 = −6）',
    Math.abs(playerReport.total + 4 * balance.ruleSlotBuyCost) < 1e-9,
    `合计 ${playerReport.total}`)
}

// ============================================================================
//  5. 引用查错：静默失败的三处
// ============================================================================

section('悬空引用：报在加载期，而不是"按下去没反应"')

{
  const lib = loadLibrary(balance)
  const techniqueMap = lib.techniques

  /*
   * ⚠ 这一节的两半都要测，因为**序列现在有两种形状**（schema 的 `TechniqueSequences`）：
   *
   *   · **老形状**（字符串 id，引用另一份术式）：**老存档 / 老分享码里就是它**。
   *     内容里已经一份都不剩了（那四份子术式文件删掉了），
   *     但判死等于玩家手里的东西全成垃圾 —— 所以这条读法**必须留着**，
   *     而"引用的那份我这里没有"必须**报得出来**（那就是 `UNKNOWN_SEQUENCE`）。
   *   · **内联**（段自带 `skills`）：现在写内容用这个。
   *     段里的技能写错一个字母时，唯一会响的地方是校验器 ——
   *     因为**那一份子术式文件没有了**，以前"它被单独校验一遍"那条路也一起没了。
   *     `UNKNOWN_SKILL` 那一组就是补这个洞的（2026-09-21 日志 46）。
   *
   * ⚠ **`techniqueMap` 里已经没有那两份子术式了**（它们删了）——
   *   所以"老形状引用得到东西"这一条要**自己造一张表**塞进去：
   *   现实里等价的场景就是"这份老存档来自一个还有那份子术式的版本"。
   *   直接用内容库的话，`tech.ws-slash` 必然查不到，测的就成了
   *   "悬空引用报得对不对"，而不是"引用得到时不报"。
   */
  const legacySeq: Technique = {
    schemaVersion: 1,
    id: 'tech.legacy-ws-slash',
    name: '老版本里的横砍',
    kind: 'weapon',
    activation: 'press',
    // ⚠ 瞄准在**技能**上（2026-09-21 日志 47）：这一段原来那份
    //   `directional / enemy / 4` 就是 `skill.ws-slash` 自己的瞄准
    skills: ['skill.ws-slash'],
  }
  const mapWithLegacy = new Map(techniqueMap)
  mapWithLegacy.set(legacySeq.id, legacySeq)

  const oldShape: Technique = {
    schemaVersion: 1,
    id: 'tech.test-seq',
    name: '测试用序列术式（老形状）',
    kind: 'weapon',
    activation: 'press',
    // ⚠ 不写 `targeting`：这一节测的是**序列的形状 / 悬空引用**
    sequences: [legacySeq.id],
  }

  const good = validateTechnique('(测试)', oldShape, { techniques: mapWithLegacy })
  ok('老形状：引用了存在的序列时没有 UNKNOWN_SEQUENCE',
    !good.issues.some(i => i.code === 'UNKNOWN_SEQUENCE'),
    good.issues.map(i => i.code).join(' '))

  const typo = validateTechnique('(测试)', { ...oldShape, sequences: ['tech.legacy-ws-slah'] },
    { techniques: mapWithLegacy })
  ok('老形状：序列名敲错一个字母 → 报 UNKNOWN_SEQUENCE（这就是老码的唯一提示）',
    typo.issues.some(i => i.code === 'UNKNOWN_SEQUENCE'),
    typo.issues.map(i => i.code).join(' '))

  const dangling = validateTechnique('(测试)', { ...oldShape, sequences: ['tech.ws-slash'] },
    { techniques: techniqueMap })
  ok('老形状：引用的是**已经删掉的那份子术式** → 报 UNKNOWN_SEQUENCE（不静默）',
    dangling.issues.some(i => i.code === 'UNKNOWN_SEQUENCE'),
    dangling.issues.map(i => i.code).join(' '))

  /*
   * ⚠ 不传术式表时**不许**报悬空 —— 否则"单独校验一个术式文件"
   *   会把存在的序列全报成错误，这个用法就废了。
   */
  const noLibrary = validateTechnique('(测试)', oldShape)
  ok('没给术式表时不查序列（单独校验单个文件仍然可用）',
    !noLibrary.issues.some(i => i.code === 'UNKNOWN_SEQUENCE'),
    noLibrary.issues.map(i => i.code).join(' '))

  /*
   * ---- 内联形状：段里的技能必须存在 ----
   *
   * ⚠ 这一条是**这次迁移最要紧的新检查**：内联之前，"序列里那个技能在不在"
   *   由**那份子术式自己**被校验时查；子术式文件删掉之后那条路没有了。
   *   没有这一条的话，`skills: ['skill.typo']` 会一路静默到"按下去没反应"。
   */
  const inline: Technique = {
    ...oldShape,
    id: 'tech.test-inline',
    name: '测试用序列术式（内联）',
    sequences: [
      { id: 'tech.seg-a', name: '第一段', skills: ['skill.ws-slash'] },
      { skills: ['skill.ws-thrust'] },
    ],
  }
  const inlineGood = validateTechnique('(测试)', inline, { skills: lib.skills, techniques: techniqueMap })
  ok('内联：段里的技能都存在 → 不报 UNKNOWN_SKILL',
    !inlineGood.issues.some(i => i.code === 'UNKNOWN_SKILL'),
    inlineGood.issues.map(i => `${i.code}@${i.path}`).join(' '))

  const inlineTypo = validateTechnique('(测试)',
    { ...inline, sequences: [{ skills: ['skill.ws-slash'] }, { skills: ['skill.ws-thrst'] }] },
    { skills: lib.skills, techniques: techniqueMap })
  const miss = inlineTypo.issues.find(i => i.code === 'UNKNOWN_SKILL')
  ok('内联：段里的技能敲错 → 报 UNKNOWN_SKILL，而且**指出是第几段的第几个**',
    miss !== undefined && miss.path === 'sequences[1].skills[0]',
    inlineTypo.issues.map(i => `${i.code}@${i.path}`).join(' '))

  const inlineBroken = validateTechnique('(测试)',
    { ...inline, sequences: [{ name: '坏的' } as never] }, { skills: lib.skills })
  ok('内联：段没有 `skills`（手改坏了）→ 报 BAD_SEQUENCE（不许等到编译期才炸）',
    inlineBroken.issues.some(i => i.code === 'BAD_SEQUENCE'),
    inlineBroken.issues.map(i => i.code).join(' '))

  const both = validateTechnique('(测试)',
    { ...oldShape, skills: ['skill.ws-slash'] }, { techniques: techniqueMap })
  ok('同时写 skills 和 sequences：报 SKILLS_AND_SEQUENCES',
    both.issues.some(i => i.code === 'SKILLS_AND_SEQUENCES'),
    both.issues.map(i => i.code).join(' '))

  const tooMany = validateTechnique('(测试)',
    { ...oldShape, sequenceLinks: [{}, {}] }, { techniques: techniqueMap })
  ok('序列条件比序列还多：报 TOO_MANY_SEQUENCE_LINKS',
    tooMany.issues.some(i => i.code === 'TOO_MANY_SEQUENCE_LINKS'),
    tooMany.issues.map(i => i.code).join(' '))

  const badTimeout = validateTechnique('(测试)',
    { ...oldShape, sequenceTimeout: 0 }, { techniques: techniqueMap })
  ok('sequenceTimeout = 0：报 BAD_SEQUENCE_TIMEOUT',
    badTimeout.issues.some(i => i.code === 'BAD_SEQUENCE_TIMEOUT'),
    badTimeout.issues.map(i => i.code).join(' '))

  // ---- 武器：两个术式槽 ----
  const weapon: WeaponDef = {
    schemaVersion: 1,
    id: 'weapon.test',
    name: '测试剑',
    attributes: { 'weapon.reach': 3 },
    weaponTechnique: 'tech.longsword-basic',
  }
  const known = new Set(lib.techniques.keys())
  /** `validator/index.ts` 的 validateWeapon 返回一份报告，这里只要问题清单 */
  const weaponIssues = (w: WeaponDef): { code: string }[] =>
    validateWeapon('(测试)', w, known).issues

  ok('武器术式槽指向存在的术式：没有问题',
    !weaponIssues(weapon).some(i => i.code === 'UNKNOWN_WEAPON_TECHNIQUE'))

  ok('武器术式槽指向不存在的术式：报 UNKNOWN_WEAPON_TECHNIQUE',
    weaponIssues({ ...weapon, weaponTechnique: 'tech.nope' })
      .some(i => i.code === 'UNKNOWN_WEAPON_TECHNIQUE'))

  /*
   * ⚠ 属性名拼错（`weapon.range`）是个**警告**而不是错误 ——
   *   武器还是能用的，只是那个 ref 读不到、退到缺省值。
   *   报错误会拦住一份本来能玩的内容；不报的话玩家永远查不出来。
   */
  ok('属性名拼错：报 UNKNOWN_WEAPON_ATTRIBUTE（警告，不拦）',
    weaponIssues({ ...weapon, attributes: { 'weapon.range': 3 } })
      .some(i => i.code === 'UNKNOWN_WEAPON_ATTRIBUTE'))

  ok('char.* 是持有者修饰，不算拼错',
    !weaponIssues({ ...weapon, attributes: { 'weapon.reach': 3, 'char.speed': 0.9 } })
      .some(i => i.code === 'UNKNOWN_WEAPON_ATTRIBUTE'))

  ok('属性值是字符串：报错（会被当成 NaN 一路传下去）',
    weaponIssues({ ...weapon, attributes: { 'weapon.reach': '3' } as unknown as Record<string, number> })
      .some(i => i.code === 'BAD_WEAPON_ATTRIBUTE_VALUE'))
}

// ============================================================================
//  6. 编译：带序列的术式和不带序列的术式走同一条路
// ============================================================================

section('编译：序列信息原样带进编译产物')

{
  const skill: Skill = {
    schemaVersion: 1,
    id: 'skill.test-compile',
    name: '测试技能',
    phases: [{ id: 'p', name: '一段', duration: 0.1, occupiesCaster: false, cancellable: false, interrupt: 'damage' }],
    rules: [],
    ruleSlots: 4,
    /*
     * ⚠ 瞄准在**技能**上（2026-09-21 日志 47）：下面那几份术式原来各自
     *   写着一份 `targeting`，现在它们都引用这一个技能 ——
     *   于是编译产物里那一份（`targetingOfChain` 取的）就是这里这一份。
     *   这一节测的是**编译**（段的形状 / 冷却键 / 老形状的 `refId`），
     *   所以取哪一份瞄准不影响任何一条断言。
     */
    targeting: { mode: 'directional', valid: ['enemy'], range: 4 },
  }
  const lookup = (id: string) => (id === skill.id ? skill : undefined)

  const plain = compileTechnique({
    schemaVersion: 1,
    id: 'tech.plain',
    name: '普通术式',
    kind: 'magic',
    activation: 'press',
    skills: [skill.id],
  }, lookup)

  ok('普通术式：没有 segments 字段（不是空数组）',
    plain.compiled.segments === undefined
    && plain.compiled.phases.length === 1)

  /*
   * ---- 内联的段：编译出**一份完整的编译产物**（阶段 + 技能 + 冷却键）----
   *
   * ⚠ 这是内联之后**最要紧的一条**：段不再是"一个要去世界里查的 id"，
   *   而是"一份现成的术式"。所以它的 `phases` / `rules` / `skillIds` 都得在。
   *   只断言"有几段"的话，段里编译出来是空的也照样绿 ——
   *   而空的表现就是"按下去没反应"。
   */
  const seq = compileTechnique({
    schemaVersion: 1,
    id: 'tech.seq',
    name: '序列术式',
    kind: 'weapon',
    activation: 'press',
    // ⚠ 不写 `targeting`：瞄准在**技能**上（2026-09-21 日志 47）
    sequences: [
      // 不写 id → 编译器合成 `<容器id>.seq<序号>`
      { name: '第一段', skills: [skill.id] },
      // 写了 id → 用它（迁移时就是这么沿用旧子术式的冷却键的）
      { id: 'tech.legacy-seg', skills: [skill.id] },
    ],
  }, lookup)

  ok('序列术式：段带进编译产物、时间轴在这一层仍是空的、没有编译问题',
    seq.compiled.segments?.length === 2
    && seq.compiled.phases.length === 0
    && seq.problems.length === 0,
    JSON.stringify({ segs: seq.compiled.segments?.length, phases: seq.compiled.phases.length, problems: seq.problems }))

  ok('  没写 id 的段：冷却键按 `<容器id>.seq<序号>` 合成（新序列的稳定键）',
    seq.compiled.segments?.[0]?.technique.id === 'tech.seq.seq0',
    String(seq.compiled.segments?.[0]?.technique.id))

  ok('  写了 id 的段：冷却键就是它（迁移时沿用旧子术式的 id，行为才逐位不变）',
    seq.compiled.segments?.[1]?.technique.id === 'tech.legacy-seg',
    String(seq.compiled.segments?.[1]?.technique.id))

  ok('  段的编译产物里有它自己的阶段和技能（不是空壳）',
    seq.compiled.segments?.[0]?.technique.phases.length === 1
    && seq.compiled.segments?.[0]?.technique.skillIds.join(',') === skill.id,
    JSON.stringify({
      phases: seq.compiled.segments?.[0]?.technique.phases.map(p => p.id),
      skills: seq.compiled.segments?.[0]?.technique.skillIds,
    }))

  ok('  段的名字取段自己的（事件和界面提示上显示的是"横砍"那种，不是容器名）',
    seq.compiled.segments?.[0]?.technique.name === '第一段'
    && seq.compiled.segments?.[1]?.technique.name === 'tech.legacy-seg',
    `${String(seq.compiled.segments?.[0]?.technique.name)} / ${String(seq.compiled.segments?.[1]?.technique.name)}`)

  ok('  容器的 skillIds = 各段之和（技能页的"被谁用到"就靠它）',
    seq.compiled.skillIds.join(',') === `${skill.id},${skill.id}`,
    JSON.stringify(seq.compiled.skillIds))

  /*
   * ---- 老形状（字符串 id）：编译产物是一份**空壳 + refId** ----
   *
   * ⚠ 它**不是**"编译失败"：技能要等运行时按 id 去世界里查
   *   （见 `src/sim/cast.ts` 的 `resolveSegment`）。
   *   这里钉的是"两半都被认，而且老形状不会顺手报一条假问题"。
   */
  const legacy = compileTechnique({
    schemaVersion: 1,
    id: 'tech.seq-legacy',
    name: '老形状的序列术式',
    kind: 'weapon',
    activation: 'press',
    // ⚠ 不写 `targeting`：老形状那一段的瞄准在**运行时**由世界里那份术式提供
    //   （`resolveSegment` 按 `refId` 查），编译这一层拿不到 —— 也不需要
    sequences: ['tech.ws-slash'],
  }, lookup)

  ok('老形状：段被认下来，带 refId（运行时按它去世界里查那份术式）',
    legacy.compiled.segments?.length === 1
    && legacy.compiled.segments?.[0]?.refId === 'tech.ws-slash'
    && legacy.problems.length === 0,
    JSON.stringify({ segs: legacy.compiled.segments, problems: legacy.problems }))

  ok('序列术式缺省超时 1 秒',
    seq.compiled.sequenceTimeout === 1,
    String(seq.compiled.sequenceTimeout))
}

// ============================================================================
//  7. 武器是**实体**：能捡起来、能换掉，换下来的掉在原地
// ============================================================================

section('换武器：武器在地上是一个实体')

{
  const lib = loadLibrary(balance)
  const arena = readJson<Scenario>(resolve('content/scenarios/arena.json'))

  /** 把 arena 装进世界，返回世界和花名册 */
  function arenaWorld(): { w: ReturnType<typeof createWorld>; roster: Map<string, import('../src/sim/types.ts').Entity> } {
    const lowered = lowerScenario(
      arena, id => lib.compiled.get(id), [], [], [...lib.weapons.values()],
    )
    if (lowered.problems.length > 0) throw new Error(lowered.problems.join(' | '))
    const w = createWorld({ seed: lowered.seed })
    const roster = applyScenario(w, lowered)
    return { w, roster }
  }

  {
    const { w, roster } = arenaWorld()
    const me = roster.get('你')
    const sword = roster.get('长剑（地上）')
    ok('开局：玩家拿着铁剑，地上躺着长剑',
      me?.weapon?.id === 'weapon.iron-sword' && sword?.weapon?.id === 'weapon.longsword')

    /*
     * ⚠ 相隔 3.16 米，够不着 —— 这是**开局**该有的样子：
     *   武器要"走过去捡"，不是站在出生点按一下就到手。
     */
    const tooFar = pickupNearby(w, me as never)
    ok('离得远时捡不到（tooFar），而不是隔着半张地图把剑吸过来',
      tooFar.ok === false && tooFar.reason === 'tooFar',
      JSON.stringify(tooFar))
  }

  {
    const { w, roster } = arenaWorld()
    const me = roster.get('你')
    const sword = roster.get('长剑（地上）')
    if (me === undefined || sword === undefined) throw new Error('arena 里应该有两个单位')

    // 走过去
    me.pos.x = sword.pos.x
    me.pos.y = sword.pos.y

    // 提示和真捡必须用**同一个**判据 —— 提示出现了按键就一定有效
    ok('够得着的时候 nearestPickup 找得到它',
      nearestPickup(w, me)?.id === sword.id)

    const res = pickupNearby(w, me)
    ok('捡起来了，换上的是长剑',
      res.ok && res.equipped?.id === 'weapon.longsword',
      JSON.stringify(res))
    ok('换下来的铁剑掉在原地（换武器是可逆的）',
      res.dropped?.id === 'weapon.iron-sword',
      JSON.stringify(res.dropped))
    ok('那把长剑的实体已经没了（它到你手上了，不是复制一份）',
      sword.alive === false && getEntity(w, sword.id)?.alive !== true)

    const dropped = w.entities.filter(e => e.kind === 'item' && e.alive)
    ok('地上现在躺着一把铁剑',
      dropped.length === 1 && dropped[0]?.weapon?.id === 'weapon.iron-sword',
      dropped.map(e => e.weapon?.id).join(' '))

    /*
     * ⚠ 换下来的那把**不能和玩家脚下完全重合**：
     *   重合的话下一次按 F 捡到的是自己刚丢的那把 ——
     *   等价于什么都没发生，而玩家看不出为什么。
     */
    const d = dropped[0]
    ok('它掉在脚边而不是正踩在脚下（否则下一次按 F 会把刚丢的捡回来）',
      d !== undefined && Math.abs(d.pos.x - me.pos.x) + Math.abs(d.pos.y - me.pos.y) > 0.5)

    ok('手上的武器参数跟着换（伤害从 0.8 变 1.1）',
      weaponAttribute(me, 'weapon.damage') === 1.1
      && weaponAttribute(me, 'weapon.reach') === 3)
  }

  {
    // ---- 再换回去：地上那把铁剑捡回来，长剑又掉下 ----
    const { w, roster } = arenaWorld()
    const me = roster.get('你')
    const sword = roster.get('长剑（地上）')
    if (me === undefined || sword === undefined) throw new Error('装配失败')

    me.pos.x = sword.pos.x
    me.pos.y = sword.pos.y
    pickupNearby(w, me)

    const iron = w.entities.find(e => e.kind === 'item' && e.alive && e.weapon?.id === 'weapon.iron-sword')
    ok('地上躺着的是铁剑', iron !== undefined)
    if (iron === undefined) throw new Error('地上应该有铁剑')

    me.pos.x = iron.pos.x
    me.pos.y = iron.pos.y
    const back = pickupNearby(w, me)

    ok('能再换回铁剑（换来换去是可逆的）',
      back.ok && back.equipped?.id === 'weapon.iron-sword')
    ok('换回来之后地上剩一把长剑，一件不多一件不少',
      w.entities.filter(e => e.kind === 'item' && e.alive).length === 1
      && w.entities.filter(e => e.kind === 'item' && e.alive)[0]?.weapon?.id === 'weapon.longsword',
      String(w.entities.filter(e => e.kind === 'item' && e.alive).length))
  }

  {
    // ---- 属性是**拷一份**，不是共享同一张表 ----
    const w = createWorld({ seed: 1 })
    const a = spawn(w, { kind: 'item', weapon: { id: 'weapon.t', name: 'T', attributes: { 'weapon.damage': 1 } } })
    const b = spawn(w, { kind: 'item', weapon: { id: 'weapon.t', name: 'T', attributes: { 'weapon.damage': 1 } } })
    if (a.weapon !== undefined) a.weapon.attributes['weapon.damage'] = 99
    ok('两把用同一个定义生成的武器**不共享**属性表',
      b.weapon?.attributes['weapon.damage'] === 1,
      String(b.weapon?.attributes['weapon.damage']))
  }

  {
    // ---- 死人捡不了、拿人当东西捡也不行 ----
    const w = createWorld({ seed: 1 })
    const me = spawn(w, { faction: 'player' })
    const other = spawn(w, { faction: 'enemy' })
    const item = spawn(w, { kind: 'item', weapon: { id: 'weapon.t', name: 'T', attributes: {} } })

    ok('拿人当东西捡：notItem', equipItem(w, me, other).reason === 'notItem')
    me.alive = false
    ok('死人捡不了东西：dead', equipItem(w, me, item).reason === 'dead')
  }

  {
    // ---- 武器进快照（它是模拟状态的一部分） ----
    const { w, roster } = arenaWorld()
    const me = roster.get('你')
    const sword = roster.get('长剑（地上）')
    if (me === undefined || sword === undefined) throw new Error('装配失败')

    const before = snapshot(w).entities.find(e => e.id === me.id)
    ok('快照里有武器（否则"谁手上有哪把剑"不进重放）',
      before?.weapon?.id === 'weapon.iron-sword',
      JSON.stringify(before?.weapon))

    me.pos.x = sword.pos.x
    me.pos.y = sword.pos.y
    pickupNearby(w, me)
    const after = snapshot(w).entities.find(e => e.id === me.id)
    ok('捡完之后快照跟着变（伤害不一样了，这一局就该不一样）',
      after?.weapon?.id === 'weapon.longsword')
  }

  {
    /*
     * ---- 同一串动作跑两遍，逐字节一致 ----
     *
     * ⚠ 这条是"捡东西是**模拟**的一部分"的守门测试。
     *   如果换武器写在客户端里（改一个界面变量），
     *   下面这两个快照就会一样 —— 而重放和局域网同步都会悄悄错掉。
     */
    function run(): string {
      const { w, roster } = arenaWorld()
      const me = roster.get('你')
      const sword = roster.get('长剑（地上）')
      if (me === undefined || sword === undefined) throw new Error('装配失败')
      me.pos.x = sword.pos.x
      me.pos.y = sword.pos.y
      pickupNearby(w, me)
      return JSON.stringify(snapshot(w))
    }
    ok('同样的走位和拾取跑两遍，快照逐字节一致', run() === run())
  }

  ok('捡东西的距离是一个常量（提示和判定共用同一句）',
    PICKUP_RANGE > 0 && PICKUP_RANGE <= 3,
    String(PICKUP_RANGE))
}

// ============================================================================
//  8. 武器属性**真的代入**了技能（伤害 + 够得着的距离）
// ============================================================================

section('属性代入：同一份横砍，换个武器就换了个打法')

{
  const lib = loadLibrary(balance)
  /*
   * ⚠ 2026-09-21（日志 46）序列内联之后，**横砍不再是内容库里一份独立的术式** ——
   *   它是长剑/铁剑那两份容器里的一段（`segments[0]`）。
   *   所以这里从容器里把它取出来：拿到的仍然是同一份**编译产物**
   *   （阶段、技能、规则都一模一样），只是它现在住在容器里。
   */
  const basicIron = lib.compiled.get('tech.iron-sword-basic')
  const basicLong = lib.compiled.get('tech.longsword-basic')
  const slash = basicIron?.segments?.[0]?.technique
  if (slash === undefined || basicIron === undefined || basicLong === undefined) {
    throw new Error('武器相关的术式应该都编译出来了')
  }
  const sweep = slash

  function iron(): WeaponDef {
    return readJson<WeaponDef>(resolve('content/weapons/iron-sword.json'))
  }
  function longsword(): WeaponDef {
    return readJson<WeaponDef>(resolve('content/weapons/longsword.json'))
  }

  /**
   * 让一个拿 `weapon` 的人挥一次 `slash`，返回：
   *   · 打中了哪个目标
   *   · 掉血多少
   * 目标放在 `dist` 米处（正前方）。
   */
  function swing(w: WeaponDef, dist: number): { hit: boolean; damage: number } {
    const world = createWorld({ seed: 1 })
    registerTechnique(world, sweep)
    const me = spawn(world, {
      faction: 'player',
      pos: { x: 0, y: 0 },
      base: { 'char.hp.max': 100, 'char.energy.max': 0, 'char.speed': 5 },
      weapon: { id: w.id, name: w.name, attributes: w.attributes },
    })
    const foe = spawn(world, {
      faction: 'enemy',
      pos: { x: dist, y: 0 },
      base: { 'char.hp.max': 1000, 'char.energy.max': 0 },
    })
    activate(world, me, sweep, { intent: { kind: 'direction', dir: { x: 1, y: 0 } } })
    // 横砍的判定挂在"斩"这个阶段的 phaseComplete 上（0.35 秒处）
    for (let i = 0; i < 60; i++) stepWorld(world)
    const hp = getStored(foe, 'char.hp.current')
    return { hit: hp < 1000, damage: 1000 - hp }
  }

  const ironNear = swing(iron(), 2)
  const longNear = swing(longsword(), 2)
  ok('同一份横砍模板，长剑打得比铁剑疼（伤害由 weapon.damage 代入）',
    longNear.damage > ironNear.damage && ironNear.damage > 0,
    `铁剑 ${ironNear.damage} / 长剑 ${longNear.damage}`)

  /*
   * ⚠ 这条钉的是**够得着的距离**：铁剑 reach 2.2，长剑 reach 3。
   *   目标站在 2.9 米处时，长剑够得着、铁剑够不着。
   *
   *   ⚠ 为什么不是 2.6：命中判定是 `dist > radius + e.radius` ——
   *     目标的**体积**也算进去了（默认半径 0.4）。所以铁剑的实际够得着
   *     是 2.2 + 0.4 = 2.6 米。定 2.6 会正好压在边界上，测出来是"打得到"，
   *     看着像 bug，其实是判定本来就这么宽。
   *
   *   这正是玩家要的"每种武器的技能范围因为属性不同而不同" ——
   *   少了它，换武器就只是换个伤害数字。
   */
  const ironFar = swing(iron(), 2.9)
  const longFar = swing(longsword(), 2.9)
  ok('2.9 米处：长剑够得着，铁剑够不着（扇形半径读 weapon.reach）',
    longFar.hit && !ironFar.hit,
    `铁剑 hit=${ironFar.hit} 长剑 hit=${longFar.hit}`)

  /*
   * ⚠ 没武器的实体照样放得出技能 —— 退到全局缺省值（reach 2.5）。
   *   不然"忘配武器"会变成"技能打不到人"，而那种错完全没有提示。
   */
  const bare = spawn(createWorld({ seed: 1 }), { faction: 'player' })
  ok('空手时读的是全局缺省值（不是 0）',
    weaponParam(bare.weapon?.attributes ?? {}, 'weapon.reach') === WEAPON_DEFAULTS['weapon.reach'])

  /*
   * ⚠ 两个术式的**招式不同**：铁剑只有一段横砍，长剑是横砍 → 刺击。
   *   "换武器"换掉的不只是数字，还有能走的招。
   */
  ok('铁剑的左键只有一段序列', (basicIron.segments ?? []).length === 1)
  ok('长剑的左键是两段（横砍 → 刺击）', (basicLong.segments ?? []).length === 2)
}

// ============================================================================
//  9. 输入层：按一次走一段、放完才推进、150ms 缓冲、超时回第一条
// ============================================================================

section('序列推进（左键那套普攻的规则）')

{
  const lib = loadLibrary(balance)
  /*
   * ⚠ 2026-09-21（日志 46）序列内联之后，"横砍/刺击"两份**不再注册进世界**了 ——
   *   它们就在容器里（`segments[i].technique`），`resolveSegment` 直接取。
   *   所以这里只注册容器。
   *   ⚠ 但断言里的 `cast.technique.id` 仍然是 `tech.ws-slash` / `tech.ws-thrust` ——
   *     那是段**显式写下来的 id**（也就是冷却键），迁移时沿用旧值，
   *     所以下面那些"哪一段在放 / 冷却记在哪个键上"一条都没变。
   */
  const containerLookup = lib.compiled.get('tech.longsword-basic')
  if (containerLookup === undefined) {
    throw new Error('序列相关的术式应该都编译出来了')
  }
  // ⚠ 收进非可选的局部量：`?? throw` 的窄化传不进下面那个嵌套函数
  const container: CompiledTechnique = containerLookup

  /** 造一个拿着长剑的人，并把容器注册进世界 */
  function arena(): { w: ReturnType<typeof createWorld>; me: Entity } {
    const w = createWorld({ seed: 1 })
    registerTechnique(w, container)
    const me = spawn(w, {
      faction: 'player',
      base: { 'char.hp.max': 300, 'char.energy.max': 100, 'char.energy.regen': 20, 'char.speed': 5 },
      weapon: {
        id: 'weapon.longsword', name: '长剑',
        attributes: { 'weapon.reach': 3, 'weapon.damage': 1.1, 'weapon.windup': 1 },
      },
    })
    // 一个远处的靶子，让招真的打出去
    spawn(w, { faction: 'enemy', pos: { x: 2, y: 0 }, base: { 'char.hp.max': 9999, 'char.energy.max': 0 } })
    return { w, me }
  }

  const intent = { kind: 'direction' as const, dir: { x: 1, y: 0 } }
  /** 一直跑到没人在放为止 */
  function settle(w: ReturnType<typeof createWorld>): void {
    let guard = 0
    while (w.casts.some(c => !c.finished && !c.interrupted) && guard++ < 300) stepWorld(w)
  }

  {
    const { w, me } = arena()
    const r = pressSequence(w, me, container, { intent })
    ok('第一次按 → 走第一段（横砍）',
      r.ok && r.index === 0 && r.cast?.technique.id === 'tech.ws-slash',
      JSON.stringify({ ok: r.ok, index: r.index, tech: r.cast?.technique.id }))
  }

  {
    /*
     * ---- 放完才推进：正在放的时候按只是缓冲 ----
     *
     * ⚠ 缓冲**只在窗口内有效**（150ms = 9 tick）。所以按键要按在
     *   "这一刀快放完的时候"——那才是输入缓冲的用途：
     *   接住"提前一点点按下"的那一下，而不是把两秒前的按键翻出来。
     *
     *   横砍三段共 0.55 秒 = 33 tick（长剑 windup 1）。
     */
    const { w, me } = arena()
    pressSequence(w, me, container, { intent })

    // 先在**开头**按两下（太早了，应该过期作废）
    stepWorld(w)
    const early = pressSequence(w, me, container, { intent })
    ok('正在放的时候按 → 只缓冲，不插队（这一刀不会被自己取消）',
      early.ok && early.buffered === true && early.index === undefined,
      JSON.stringify(early))
    ok('  场上还是只有那一次施法', w.casts.filter(c => !c.finished).length === 1)

    advance(w, 29)          // 到第 30 tick，离结束还有 3 tick
    pressSequence(w, me, container, { intent })   // 缓冲 #1
    stepWorld(w)
    pressSequence(w, me, container, { intent })   // 缓冲 #2（覆盖 #1）
    advance(w, 5)

    const running = w.casts.filter(c => !c.finished && !c.interrupted)
    ok('第一段放完的**那一刻**缓冲里的那一下接上了第二段（刺击）',
      running.length === 1 && running[0]?.technique.id === 'tech.ws-thrust',
      running.map(c => c.technique.id).join(' '))
    ok('  连点两下只多出一刀（缓冲是单槽，不是队列）', running.length === 1)

    settle(w)
    ok('开头那两下早按的**已经过期作废**（不会几秒后又自己挥一刀）',
      w.casts.filter(c => !c.finished).length === 0)
  }

  {
    // ---- 到底回绕 ----
    const { w, me } = arena()
    const order: string[] = []
    for (let i = 0; i < 3; i++) {
      const r = pressSequence(w, me, container, { intent })
      if (r.cast !== undefined) order.push(r.cast.technique.id)
      settle(w)
    }
    ok('一段一段按下去：横砍 → 刺击 → 回到横砍（到底回绕）',
      order.join(' → ') === 'tech.ws-slash → tech.ws-thrust → tech.ws-slash',
      order.join(' → '))
  }

  {
    // ---- 超时回第一条 ----
    const { w, me } = arena()
    pressSequence(w, me, container, { intent })
    settle(w)
    ok('第一段已放完，链上记着"下一段是刺击"',
      me.chain?.next === 1, JSON.stringify(me.chain))

    // 隔了 2 秒（超过 sequenceTimeout 的 1 秒）再按
    advance(w, 120)
    const again = pressSequence(w, me, container, { intent })
    ok('隔了 2 秒再按 → 回到第一段（超时回第一条），而不是接第二段',
      again.index === 0 && again.cast?.technique.id === 'tech.ws-slash',
      JSON.stringify({ index: again.index, tech: again.cast?.technique.id }))
  }

  {
    /*
     * ---- 放到一半被打断 ----
     *
     * ⚠ 判据是**下一次攻击激活哪一条序列**：
     *   第一段（横砍）被中途打断之后，链上记的是下一条 ——
     *   所以下次攻击出的是**刺击**，不是回到横砍。
     */
    const { w, me } = arena()
    pressSequence(w, me, container, { intent })
    stepWorld(w)
    pressSequence(w, me, container, { intent })   // 缓冲
    const cast = w.casts.find(c => !c.finished)
    if (cast === undefined) throw new Error('应该有正在放的施法')
    interruptCast(w, cast, me, 'damaged')

    const running = w.casts.filter(c => !c.finished && !c.interrupted)
    ok('第一段（横砍）被打断 → 缓冲里的那一下激活**下一条**序列（刺击）',
      running.length === 1 && running[0]?.technique.id === 'tech.ws-thrust',
      running.map(c => c.technique.id).join(' '))

    /*
     * ⚠ 再确认一次"被打断之后**下一次按**走哪条" ——
     *   上面那条测的是缓冲（打断时立刻接上），这条测的是**没有缓冲**时
     *   的下一次按键：链上记的仍然是下一条，不是第一条。
     */
    const { w: w2, me: me2 } = arena()
    pressSequence(w2, me2, container, { intent })
    stepWorld(w2)
    const running2 = w2.casts.find(c => !c.finished)
    if (running2 === undefined) throw new Error('应该有正在放的施法')
    interruptCast(w2, running2, me2, 'damaged')   // 没有缓冲

    advance(w2, 3)
    const after = pressSequence(w2, me2, container, { intent })
    ok('打断时没有缓冲 → 下一次按键走的是**下一条**序列（刺击），不回到横砍',
      after.ok && after.cast?.technique.id === 'tech.ws-thrust',
      JSON.stringify({ index: after.index, tech: after.cast?.technique.id }))
  }

  {
    /*
     * ---- 同一串输入跑两遍，逐字节一致 ----
     *
     * ⚠ 这条钉的是"序列链在**模拟**里"。
     *   链存在客户端的话，下面两个快照会一样 —— 而重放、
     *   以及将来的局域网同步都会悄悄错掉（"我这边出的是刺击，你那边是横砍"）。
     */
    function run(): string {
      const { w, me } = arena()
      pressSequence(w, me, container, { intent })
      advance(w, 5)
      pressSequence(w, me, container, { intent })
      advance(w, 60)
      return JSON.stringify(snapshot(w))
    }
    ok('同一串按键跑两遍，快照逐字节一致', run() === run())
  }

  {
    // ---- 普通术式不受影响 ----
    const w = createWorld({ seed: 1 })
    const plain = lib.compiled.get('tech.cleave')
    if (plain === undefined) throw new Error('cleave 应该编译出来了')
    registerTechnique(w, plain)
    const me = spawn(w, { faction: 'player', base: { 'char.hp.max': 100, 'char.energy.max': 100 } })
    const r = pressSequence(w, me, plain, { intent })
    ok('没有 sequences 的普通术式：pressSequence 就是 activate（老路一条不少）',
      r.ok && r.cast?.technique.id === 'tech.cleave' && me.chain === undefined)
  }

  /*
   * ---- 轮到的这一段在冷却 → **不激活它**，只把游标挪到下一条 ----
   *
   * ⚠ 玩家 2026-09-21 定的（日志 49 改的口径）：
   *   > 如果一条序列中有技能正在 CD，则不激活这条序列并给出提示，
   *   > 然后指针指到下一条序列**等待按键触发**。
   *
   *   ⚠ 和日志 46 那一版的差别就在最后半句：以前是"跳到下一条并**当场
   *     把它打出去**"，现在这一下**什么都不放** —— 出招的是**下一次**按键。
   *     一次按键打出去的技能换了人，玩家会以为"我按的是第一刀，
   *     怎么出来的是第二刀"。
   *
   * ⚠ **只有冷却会跳**：能量不够 / 血契不够 / 沉默 / 忙一律**原样失败** ——
   *   那是"这一下（这个人）根本放不出来"，跳过会让人以为"是 CD 的问题"。
   */
  {
    /**
     * 内联的容器：每段自带 `skills`，而且**显式写 `id`**（= 冷却键）。
     *
     * ⚠ 这里刻意用内联形状：CD 跳段要测的正是"**每一段的冷却键**"，
     *   而键就是段的 `id` —— 老形状（字符串引用）走的是另一条路
     *   （要去世界里查那份术式），两半在 `resolveSegment` 里分开。
     */
    const box = compileTechnique(
      {
        schemaVersion: 1,
        id: 'tech.tseg-box',
        name: '两段测试容器',
        // ⚠ 挂了序列的术式（老判据叫"武器术式"）
        kind: 'weapon',
        activation: 'press',
        /*
         * ⚠ 不写 `targeting`（2026-09-21 日志 47，瞄准在技能上）：
         *   两段各自引用 `skill.cleave` / `skill.magic-bolt`，它们自己带瞄准。
         */
        sequences: [
          { id: 'tech.tseg-a', skills: ['skill.cleave'] },
          { id: 'tech.tseg-b', skills: ['skill.magic-bolt'] },
        ],
      },
      sid => lib.skills.get(sid),
      { bloodPactCost: 0 },
    ).compiled
    const aId = box.segments?.[0]?.technique.id ?? 'tech.tseg-a'
    const bId = box.segments?.[1]?.technique.id ?? 'tech.tseg-b'

    function cdArena(): { w: ReturnType<typeof createWorld>; me: Entity } {
      const w = createWorld({ seed: 1 })
      registerTechnique(w, box)
      const me = spawn(w, {
        faction: 'player',
        base: { 'char.hp.max': 300, 'char.energy.max': 100, 'char.energy.regen': 20, 'char.speed': 5 },
      })
      return { w, me }
    }

    {
      // ① 冷却中按下 → 什么都不放 + 游标到下一条 + 提示说清"哪一条、还剩多久"
      const { w, me } = cdArena()
      setStored(me, `cd.${aId}`, 5)
      const r = pressSequence(w, me, box, { intent })
      ok('第一段在冷却 → 这一下**什么都不放**（不是"换一条打出去"）',
        !r.ok && r.reason === 'cooldown' && r.cast === undefined && w.casts.length === 0,
        JSON.stringify({ ok: r.ok, reason: r.reason, casts: w.casts.length }))
      ok('  游标已经指到**下一条序列**（等下一次按键，不在这里放）',
        me.chain?.next === 1, JSON.stringify({ next: me.chain?.next }))
      ok('  提示说得清**哪一条 + 还剩多久**（玩家上一轮的亏就在这里）',
        r.cooldown?.index === 0
        && r.cooldown.techniqueId === aId
        && r.cooldown.name === box.segments?.[0]?.technique.name
        && r.cooldown.remaining > 0 && r.cooldown.remaining <= 5
        && r.cooldown.allCooling === false,
        JSON.stringify(r.cooldown))
      ok('  冷却没有被绕过去（那一段还是冷却中）', getStored(me, `cd.${aId}`) > 0)
    }

    {
      // ② **再按一次** → 下一条才真的被打出来（证明"等下一次按键"）
      const { w, me } = cdArena()
      setStored(me, `cd.${aId}`, 5)
      pressSequence(w, me, box, { intent })          // ① 挡住 + 游标到下一条
      const r = pressSequence(w, me, box, { intent }) // ② 这才试下一条
      ok('再按一次 → 下一条（第二段）被打出来（"等下一次按键"）',
        r.ok && r.index === 1 && r.cast?.technique.id === bId,
        JSON.stringify({ ok: r.ok, index: r.index, tech: r.cast?.technique.id, reason: r.reason }))
      ok('  而且打出来的是第二段（不是又替第一段重试）',
        r.cast?.technique.id !== aId)
    }

    {
      // ③ 第一段的冷却好了 → 绕一圈**回到它**
      const { w, me } = cdArena()
      setStored(me, `cd.${aId}`, 5)
      pressSequence(w, me, box, { intent })          // ① 挡住，游标 → 第二段
      setStored(me, `cd.${aId}`, 0)                  // 第一段的冷却好了
      const second = pressSequence(w, me, box, { intent })
      ok('游标还指在第二段 → 先放出第二段（不是抢回第一段）',
        second.ok && second.index === 1 && second.cast?.technique.id === bId,
        JSON.stringify({ ok: second.ok, index: second.index, tech: second.cast?.technique.id }))

      const cast = w.casts.find(c => c.casterId === me.id)
      if (cast === undefined) throw new Error('第二段应该正在放')
      interruptCast(w, cast, me, 'damaged')          // 这一段结束 → 游标绕回第一段
      const back = pressSequence(w, me, box, { intent })
      ok('再按 → 绕回第一段，它已经能放了 → **回到它**',
        back.ok && back.index === 0 && back.cast?.technique.id === aId,
        JSON.stringify({ ok: back.ok, index: back.index, tech: back.cast?.technique.id, reason: back.reason }))
    }

    {
      // ④ 一圈都在冷却 → 回到第一条，**在原位等待**
      const { w, me } = cdArena()
      setStored(me, `cd.${aId}`, 5)
      setStored(me, `cd.${bId}`, 5)
      const r = pressSequence(w, me, box, { intent })
      ok('两段都在冷却 → 失败，而且是"冷却中"（不是静默什么都不发生）',
        !r.ok && r.reason === 'cooldown' && w.casts.length === 0,
        JSON.stringify({ ok: r.ok, reason: r.reason, casts: w.casts.length }))
      ok('  一圈都在冷却 → 游标回到**第一条**（不空转、不无限找）',
        me.chain?.next === 0, JSON.stringify({ next: me.chain?.next }))
      ok('  提示里说清"整条链都在冷却"（否则玩家会一直按）',
        r.cooldown?.allCooling === true && r.cooldown.index === 0,
        JSON.stringify(r.cooldown))
    }

    {
      /*
       * 能量不够**不跳段**：那是"这一下打不出来"，不是"换一招"。
       * `skill.charged-laser` 的能量代价很高（100 上限 + 回复 20 也够不着），
       * 所以把能量清成 0 就一定能拿到 `energy`。
       */
      const { w, me } = cdArena()
      setStored(me, 'char.energy.current', 0)
      const box2 = compileTechnique(
        {
          schemaVersion: 1,
          id: 'tech.tseg-box2',
          name: '两段容器 2',
          kind: 'weapon',
          activation: 'press',
          // ⚠ 不写 `targeting`（2026-09-21 日志 47，瞄准在技能上）
          sequences: [
            { id: 'tech.tseg-thirsty', skills: ['skill.charged-laser'] },
            { id: 'tech.tseg-b', skills: ['skill.magic-bolt'] },
          ],
        },
        sid => lib.skills.get(sid),
        { bloodPactCost: 0 },
      ).compiled
      registerTechnique(w, box2)
      const r = pressSequence(w, me, box2, { intent })
      ok('能量不够时**不**跳到下一条序列（原样失败）',
        !r.ok && r.reason === 'energy',
        JSON.stringify({ ok: r.ok, reason: r.reason, index: r.index }))
      ok('  游标没动（这不是"轮到的段在冷却"，没有下一条可等）',
        me.chain?.next === 0, JSON.stringify({ next: me.chain?.next }))
      ok('  而且**不给冷却提示**（给了玩家会以为"等一会儿就好"）',
        r.cooldown === undefined, JSON.stringify(r.cooldown))
    }

    {
      /*
       * 沉默**不跳段**：这是"你根本放不出来"，和"轮到的这一段在冷却"
       * 是两件事 —— 跳了的话提示会说成 CD，玩家会去等一个等不来的东西。
       */
      const { w, me } = cdArena()
      applyStatus(w, me, {
        id: 'status.silence-cdtest', name: '沉默', tags: ['hardCC'], duration: 3, disables: ['cast'],
      } as never, me.id)
      const r = pressSequence(w, me, box, { intent })
      ok('被沉默时**不**跳到下一条序列（原样失败）',
        !r.ok && r.reason === 'silenced',
        JSON.stringify({ ok: r.ok, reason: r.reason, index: r.index }))
      ok('  游标没动', me.chain?.next === 0, JSON.stringify({ next: me.chain?.next }))
      ok('  也不给冷却提示', r.cooldown === undefined, JSON.stringify(r.cooldown))
    }
  }
}

// ============================================================================
//  10. 左键那一刀打在**朝向**那一边（玩家 2026-09-21 报的 bug）
// ============================================================================

section('挥砍的方向 = 角色的朝向')

{
  /*
   * 玩家原话：
   *   > 使用铁剑时鼠标左键的攻击始终朝向正右方而不是鼠标方向
   *
   * 这一组钉的是**客户端依赖的那条契约**：瞬时载体（扇形/光束/范围）的命中方向
   * 取自**施法者当前朝向**（`ctx.actor.facing`），而不是调用方给的那个 `intent.dir`
   * （见 `pipeline.ts` 里那段"方向要用瞄准解算出来的那个"的注释 ——
   * `directional` 走的是"跟着当前朝向"，只有 locked/auto 才把方向钉死）。
   *
   * ⚠ 所以客户端必须**每帧把鼠标方向写进 `player.facing`**；
   *   写不进去（或者算方向那一步返回了一个假方向）的表现就是
   *   "这一刀砍在别处" —— 而引擎这边看起来完全正常。
   *
   * ⚠ 为什么以前没测出来：这一批测试里所有 `intent` 都写 `dir: {x:1,y:0}`（正右），
   *   而角色默认朝向也是正右 —— 方向写错了照样是绿的。
   */
  const lib2 = loadLibrary(balance)
  const container2 = lib2.compiled.get('tech.iron-sword-basic')
  // ⚠ 序列内联之后横砍不再单独注册（它在容器的 `segments[0]` 里，见 `resolveSegment`）
  if (container2 === undefined) throw new Error('铁剑那套术式应该编译出来了')

  /** 正上方和正右方各站一个靶子，都在剑的够得着的范围内 */
  function facingArena(): {
    w: ReturnType<typeof createWorld>
    me: Entity
    up: Entity
    right: Entity
  } {
    const w = createWorld({ seed: 1 })
    registerTechnique(w, container2 as CompiledTechnique)
    const me = spawn(w, {
      faction: 'player',
      base: { 'char.hp.max': 300, 'char.energy.max': 100, 'char.speed': 5 },
      weapon: {
        id: 'weapon.iron-sword', name: '铁剑',
        attributes: { 'weapon.reach': 2.2, 'weapon.damage': 0.8, 'weapon.windup': 1.15 },
      },
    })
    const up = spawn(w, {
      faction: 'enemy', pos: { x: 0, y: -1.5 },
      base: { 'char.hp.max': 9999, 'char.energy.max': 0, 'char.speed': 0 },
    })
    const right = spawn(w, {
      faction: 'enemy', pos: { x: 1.5, y: 0 },
      base: { 'char.hp.max': 9999, 'char.energy.max': 0, 'char.speed': 0 },
    })
    return { w, me, up, right }
  }

  function settle(w: ReturnType<typeof createWorld>): void {
    let guard = 0
    while (w.casts.some(c => !c.finished && !c.interrupted) && guard++ < 300) stepWorld(w)
  }

  {
    // 朝上挥（客户端就是把鼠标方向写进 facing 的）
    const { w, me, up, right } = facingArena()
    const before = { up: getStored(up, 'char.hp.current'), right: getStored(right, 'char.hp.current') }
    me.facing = { x: 0, y: -1 }
    pressSequence(w, me, container2 as CompiledTechnique, {
      intent: { kind: 'direction', dir: { x: 0, y: -1 } },
    })
    settle(w)
    ok('朝上挥 → 上方那个挨打',
      getStored(up, 'char.hp.current') < before.up,
      `上方 ${before.up} → ${getStored(up, 'char.hp.current')}`)
    ok('  朝上的这一刀不会打到右边那个',
      getStored(right, 'char.hp.current') === before.right,
      `右边 ${before.right} → ${getStored(right, 'char.hp.current')}`)
  }

  {
    // 朝右挥（对照）
    const { w, me, up, right } = facingArena()
    const before = { up: getStored(up, 'char.hp.current'), right: getStored(right, 'char.hp.current') }
    me.facing = { x: 1, y: 0 }
    pressSequence(w, me, container2 as CompiledTechnique, {
      intent: { kind: 'direction', dir: { x: 1, y: 0 } },
    })
    settle(w)
    ok('朝右挥 → 右边那个挨打',
      getStored(right, 'char.hp.current') < before.right,
      `右边 ${before.right} → ${getStored(right, 'char.hp.current')}`)
    ok('  朝右的这一刀不会打到上方那个',
      getStored(up, 'char.hp.current') === before.up,
      `上方 ${before.up} → ${getStored(up, 'char.hp.current')}`)
  }

  /*
   * ---- 方向在**施法那一刻**锁死（玩家 2026-09-21 定的）----
   *
   * 玩家原话：
   *   > 改吧
   *
   * 改的是这件事：以前 `directional` 的朝向是读施法者**当前**的朝向，
   * 也就是说"这一刀朝哪"取决于**客户端每一帧往 `facing` 里写了什么**。
   * 那条链断掉的方式全是静默的（指针坐标没送到 / 算方向时凭空返回默认值 /
   * 别处覆盖了朝向），表现就是"这一刀砍在别处" —— 玩家报的就是这一类。
   *
   * 现在：施法瞬间解算出来的方向就是这一下的方向，之后谁改 `facing` 都不影响它。
   * 下面这两条就是钉这个 —— 前摇里（客户端）把朝向拧到反方向，命中仍然在原方向。
   */
  {
    const { w, me, up, right } = facingArena()
    const before = { up: getStored(up, 'char.hp.current'), right: getStored(right, 'char.hp.current') }
    me.facing = { x: 0, y: -1 }
    const r = pressSequence(w, me, container2 as CompiledTechnique, {
      intent: { kind: 'direction', dir: { x: 0, y: -1 } },
    })
    ok('施法那一刻锁下来的朝向就是"朝上"',
      Math.abs((r.cast?.facing.y ?? 0) + 1) < 1e-9,
      `cast.facing = ${JSON.stringify(r.cast?.facing)}`)

    // 前摇里转身 —— 以前这一下会跟着转，现在不会
    advance(w, 3)
    me.facing = { x: 1, y: 0 }
    settle(w)

    ok('前摇里转身**不会**把这一刀带歪（还是打上方）',
      getStored(up, 'char.hp.current') < before.up,
      `上方 ${before.up} → ${getStored(up, 'char.hp.current')}`)
    ok('  右边那个也没挨打（方向没有跟着当前朝向走）',
      getStored(right, 'char.hp.current') === before.right,
      `右边 ${before.right} → ${getStored(right, 'char.hp.current')}`)
  }

  /*
   * 投射物同理 —— 那是另一行代码（`fireProjectile` 里的 `dir`），
   * 以前它跟瞬时载体走的是**两条不一样的规矩**。
   */
  {
    const bolt = lib2.compiled.get('tech.magic-bolt')
    if (bolt === undefined) throw new Error('magic-bolt 应该编译出来了')
    const w = createWorld({ seed: 1 })
    registerTechnique(w, bolt)
    const me = spawn(w, {
      faction: 'player', pos: { x: 0, y: 0 },
      base: { 'char.hp.max': 100, 'char.energy.max': 100, 'char.speed': 5 },
    })
    me.facing = { x: 0, y: -1 }
    activate(w, me, bolt, { intent: { kind: 'direction', dir: { x: 0, y: -1 } } })

    // 前摇里一直把朝向写成"右边"（客户端每帧都在写），然后等飞弹出来
    let guard = 0
    let proj: Entity | undefined
    while (proj === undefined && guard++ < 120) {
      me.facing = { x: 1, y: 0 }
      stepWorld(w)
      proj = w.entities.find(e => e.kind === 'projectile')
    }
    ok('前摇里转身，飞弹还是朝施法那一刻的方向（朝上）飞',
      proj !== undefined && proj.vel.y < 0 && Math.abs(proj.vel.x) < Math.abs(proj.vel.y),
      proj === undefined ? '没有飞弹飞出来' : `vel = ${proj.vel.x.toFixed(2)}, ${proj.vel.y.toFixed(2)}`)
  }
}

// ============================================================================
//  份数类修饰（多重释放 / 一分为 X）的**校验器规矩** —— 2026-09-21 日志 51
// ============================================================================

section('份数类修饰：上限 / 只作用于瞬发 / "今天只在 at: 0 生效"要说出来')

{
  const libM = loadLibrary(balance)
  const modOpts = {
    balance,
    skills: libM.skills,
    statuses: libM.statuses,
    entities: libM.entities,
    techniques: libM.techniques,
    /*
     * ⚠ **这一项必须传**：不传的话那几条规矩**一条都不查**，
     *   而"没查"和"没问题"在报告里长得一模一样（这是日志 48 起就有的约定）。
     *   ⚠ 2026-09-21（日志 51）它从"原型 id → kind"换成了"原型 id → 原型"：
     *     份数类的**上限**在原型上（`params.max`），只拿 kind 读不到。
     */
    modifierProtos: libM.modifiers,
  }

  /** 造一份带修饰副本的术式（技能取出厂的那几个） */
  const techWith = (id: string, skills: string[], mods: Array<Record<string, unknown>>): Technique => ({
    schemaVersion: 1,
    id,
    name: id,
    kind: 'magic',
    activation: 'press',
    sequences: [{ name: '一段', skills: [...skills], mods: mods as never }],
  })

  const codesOf = (t: Technique): string[] =>
    validateTechnique('(测试)', t, modOpts).issues.map(i => i.code)

  /*
   * ---- ① 上限：N ≤ 10 / X ≤ 4（**每个动词自己的上限**，从原型读）----
   */
  const overMulti = codesOf(techWith('t.multi-over',
    ['skill.magic-bolt', 'skill.hunt'],
    [{ proto: 'mod.multi.fire', at: 0, params: { count: 11 } }]))
  ok('多重释放要 11 份 → 报 MODIFIER_COUNT_OVER_CAP',
    overMulti.includes('MODIFIER_COUNT_OVER_CAP'), overMulti.join(' '))

  const atCap = codesOf(techWith('t.multi-cap',
    ['skill.magic-bolt', 'skill.hunt'],
    [{ proto: 'mod.multi.fire', at: 0, params: { count: 10 } }]))
  ok('  正好 10 份 → 不报（上限是闭区间）',
    !atCap.includes('MODIFIER_COUNT_OVER_CAP'), atCap.join(' '))

  const overSplit = codesOf(techWith('t.split-over',
    ['skill.magic-bolt'],
    [{ proto: 'mod.split', at: 0, params: { count: 5 } }]))
  ok('一分为 X 要 5 份 → 报 MODIFIER_COUNT_OVER_CAP（它的上限是 4，不是 10）',
    overSplit.includes('MODIFIER_COUNT_OVER_CAP'), overSplit.join(' '))

  const splitCap = codesOf(techWith('t.split-cap',
    ['skill.magic-bolt'],
    [{ proto: 'mod.split', at: 0, params: { count: 4 } }]))
  ok('  正好 4 份 → 不报',
    !splitCap.includes('MODIFIER_COUNT_OVER_CAP'), splitCap.join(' '))

  /*
   * ⚠ **上限必须是从原型读的**（数据），不是代码里的常数 ——
   *   所以这里顺手证明"改原型就能改上限"：把 `params.max` 抬到 20，
   *   同一个 11 份的副本就不该再被拦。这条断言钉的是"上限住在内容里"。
   */
  const patched = new Map(libM.modifiers)
  const multiProto = patched.get('mod.multi.fire')
  if (multiProto === undefined) throw new Error('内容里没有 mod.multi.fire')
  patched.set('mod.multi.fire', { ...multiProto, params: { ...multiProto.params, max: 20 } })
  const lifted = validateTechnique('(测试)', techWith('t.multi-lifted',
    ['skill.magic-bolt', 'skill.hunt'],
    [{ proto: 'mod.multi.fire', at: 0, params: { count: 11 } }]),
  { ...modOpts, modifierProtos: patched }).issues.map(i => i.code)
  ok('  把原型的 params.max 抬到 20 → 同一个副本就不报了（上限是**数据**）',
    !lifted.includes('MODIFIER_COUNT_OVER_CAP'), lifted.join(' '))

  /*
   * ---- ② **多重释放只作用于瞬发技能**（玩家 / 定稿 §八 的原话）----
   *
   * ⚠ 查的是"它一下子要打出去的那几个技能"，**不是只查紧邻那一个**：
   *   玩家写 N=3 时，第三个是蓄力技能同样打不出去。
   */
  const nonInstant = techWith('t.multi-charged',
    ['skill.magic-bolt', 'skill.charged-laser'],
    [{ proto: 'mod.multi.fire', at: 0, params: { count: 2 } }])
  const nonInstantCodes = codesOf(nonInstant)
  ok('多重释放后面跟着蓄力技能 → 报 MULTI_FIRE_NON_INSTANT',
    nonInstantCodes.includes('MULTI_FIRE_NON_INSTANT'), nonInstantCodes.join(' '))

  const behindN = codesOf(techWith('t.multi-behind-n',
    ['skill.magic-bolt', 'skill.hunt', 'skill.charged-laser'],
    [{ proto: 'mod.multi.fire', at: 0, params: { count: 3 } }]))
  ok('  哪怕是第 3 个（N=3 才够得着）也照样拦',
    behindN.includes('MULTI_FIRE_NON_INSTANT'), behindN.join(' '))

  const notReached = codesOf(techWith('t.multi-not-reached',
    ['skill.magic-bolt', 'skill.hunt', 'skill.charged-laser'],
    [{ proto: 'mod.multi.fire', at: 0, params: { count: 2 } }]))
  ok('  但 N=2 够不着它 → 不报（判据是"这次真的要打出去的那几个"）',
    !notReached.includes('MULTI_FIRE_NON_INSTANT'), notReached.join(' '))

  const sustained = codesOf(techWith('t.multi-sustained',
    ['skill.magic-bolt', 'skill.slow-field'],
    [{ proto: 'mod.multi.fire', at: 0, params: { count: 2 } }]))
  ok('  常驻（passive，没有时间轴）同样拦 —— "一起打出去"对它没有落点',
    sustained.includes('MULTI_FIRE_NON_INSTANT'), sustained.join(' '))

  /*
   * ⚠ **「一分为 X」不查这一条**：玩家只对「多重释放」说了"只作用于瞬发技能"。
   *   替玩家补一条规矩 = 自己定规矩 —— 它是**待裁定项**（日志 51 报告第 5 节），
   *   所以这里**不断言"不报"**，只在日志里记着。
   */

  /*
   * ---- ③ 凑不满 N 个**互不相同**的技能 → 警告（不是错误）----
   *
   * ⚠ 引擎照实打（有几个打几个），账也按实际份数收 —— 所以它不是错误。
   *   但"我写了 5 个、只出来 2 个"必须说出来。
   */
  const tooFew = codesOf(techWith('t.multi-too-few',
    ['skill.magic-bolt', 'skill.hunt'],
    [{ proto: 'mod.multi.fire', at: 0, params: { count: 5 } }]))
  ok('这一段只有 2 个不同的技能、却要 5 份 → 报 MODIFIER_COUNT_CLAMPED（警告）',
    tooFew.includes('MODIFIER_COUNT_CLAMPED'), tooFew.join(' '))
  const stillFine = codesOf(techWith('t.multi-ok',
    ['skill.magic-bolt', 'skill.hunt'],
    [{ proto: 'mod.multi.fire', at: 0, params: { count: 2 } }]))
  ok('  够得着 → 不报',
    !stillFine.includes('MODIFIER_COUNT_CLAMPED'), stillFine.join(' '))

  /*
   * ---- ④ **今天只在 `at: 0` 生效** → 警告，不报错 ----
   *
   * ⚠ 引擎里落地这件事的地方（`sim/trigger.ts` 的 `activateGroup`）只认
   *   "紧邻的第一个技能被修饰" —— 和触发器 / 监测器今天同一个限制。
   *   写在别处**不生效**，而"写上去不生效"是这个项目列为最危险的静默失败。
   */
  const atOne = codesOf(techWith('t.multi-at1',
    ['skill.magic-bolt', 'skill.hunt'],
    [{ proto: 'mod.multi.fire', at: 1, params: { count: 2 } }]))
  ok('at: 1 → 报 MODIFIER_GROUP_AT_NOT_WIRED（警告，不是错误）',
    atOne.includes('MODIFIER_GROUP_AT_NOT_WIRED'), atOne.join(' '))
  ok('  而且它**不是**错误（内容是合理的前置，引擎迟早会接线）',
    !validateTechnique('(测试)', techWith('t.multi-at1b',
      ['skill.magic-bolt', 'skill.hunt'],
      [{ proto: 'mod.multi.fire', at: 1, params: { count: 2 } }]), modOpts)
      .issues.some(i => i.code === 'MODIFIER_GROUP_AT_NOT_WIRED' && i.level === 'error'))

  /*
   * ---- ⑤ 「不叠同类」照样管着：两个多重释放叠一起 → **错误** ----
   *     （不同类才行 —— 「多重释放 + 一分为 X」是合法的，见下一节）
   */
  const stacked = codesOf(techWith('t.multi-stacked',
    ['skill.magic-bolt', 'skill.hunt'],
    [
      { proto: 'mod.multi.fire', at: 0, params: { count: 2 } },
      { proto: 'mod.multi.fire', at: 0, params: { count: 3 } },
    ]))
  ok('同类的两个「多重释放」叠在同一个技能前面 → 报 MODIFIER_STACKED_KIND',
    stacked.includes('MODIFIER_STACKED_KIND'), stacked.join(' '))

  const twoKinds = codesOf(techWith('t.multi-split-both',
    ['skill.magic-bolt', 'skill.hunt'],
    [
      { proto: 'mod.multi.fire', at: 0, params: { count: 2 } },
      { proto: 'mod.split', at: 0, params: { count: 3 } },
    ]))
  ok('  但「多重释放 + 一分为 X」是**两个类别** → 放行（叠加算法见日志 51）',
    !twoKinds.includes('MODIFIER_STACKED_KIND'), twoKinds.join(' '))
}

// ============================================================================
//  「等待 X 秒」的**校验器规矩** —— 2026-09-30 日志 52
// ============================================================================

section('等待 X 秒：范围 0.2~3 / 锁只剩两项 / 打断档只能三档')

{
  const libW = loadLibrary(balance)
  const wOpts = {
    balance,
    skills: libW.skills,
    statuses: libW.statuses,
    entities: libW.entities,
    techniques: libW.techniques,
    modifierProtos: libW.modifiers,
  }
  const techWait = (id: string, params: Record<string, unknown>): Technique => ({
    schemaVersion: 1,
    id,
    name: id,
    kind: 'magic',
    activation: 'press',
    sequences: [{
      name: '一段',
      skills: ['skill.magic-bolt', 'skill.hunt'],
      mods: [{ proto: 'mod.wait', at: 1, params }],
    }],
  })
  const codes = (t: Technique): string[] =>
    validateTechnique('(测试)', t, wOpts).issues.map(i => i.code)

  /*
   * ---- ① 秒数的范围（0.2 ~ 3）----
   *
   * ⚠ 上限住在**原型**里（`content/modifiers/wait.json` 的 `params.max`），
   *   下限那一头玩家**说死了**（0.2）。
   */
  const over = codes(techWait('t.wait-over', { seconds: 12 }))
  ok('要等 12 秒 → 报 MODIFIER_SECONDS_OVER_CAP（原型的上限是 3）',
    over.includes('MODIFIER_SECONDS_OVER_CAP'), over.join(' '))

  const atCap = codes(techWait('t.wait-cap', { seconds: 3 }))
  ok('  正好 3 秒 → 不报（上限是闭区间）',
    !atCap.includes('MODIFIER_SECONDS_OVER_CAP'), atCap.join(' '))

  const under = codes(techWait('t.wait-under', { seconds: 0.05 }))
  ok('要等 0.05 秒 → 报 MODIFIER_SECONDS_UNDER_MIN（下限 0.2 是闭区间）',
    under.includes('MODIFIER_SECONDS_UNDER_MIN'), under.join(' '))

  const atMin = codes(techWait('t.wait-min', { seconds: 0.2 }))
  ok('  正好 0.2 秒 → 不报',
    !atMin.includes('MODIFIER_SECONDS_UNDER_MIN'), atMin.join(' '))

  const bad = codes(techWait('t.wait-bad', { seconds: '很久' }))
  ok('秒数写成字符串 → 报 MODIFIER_BAD_SECONDS（不是静默当默认值）',
    bad.includes('MODIFIER_BAD_SECONDS'), bad.join(' '))

  /*
   * ⚠ **上限是数据**：把原型的 `params.max` 抬到 10，同一个 12 秒的副本
   *   照旧报（12 > 10），但改成 8 秒就不该报了 —— 这条钉的是"改内容就能改上限"。
   */
  const patched = new Map(libW.modifiers)
  const waitProto = patched.get('mod.wait')
  if (waitProto === undefined) throw new Error('内容里没有 mod.wait')
  patched.set('mod.wait', { ...waitProto, params: { ...waitProto.params, max: 10 } })
  const lifted = validateTechnique('(测试)', techWait('t.wait-lifted', { seconds: 8 }),
    { ...wOpts, modifierProtos: patched }).issues.map(i => i.code)
  ok('  把原型的 params.max 抬到 10 → 8 秒就不报了（上限是**数据**）',
    !lifted.includes('MODIFIER_SECONDS_OVER_CAP'), lifted.join(' '))

  /*
   * ---- ② 锁只能那两个值（引擎 `Capability` 里**还配得了**的两项）----
   *
   * ⚠⚠ **2026-09-30（日志 54）**：玩家把"施法独占"定成了**引擎硬规矩**
   *   （原话："玩家又没有第二人格"）⇒ `cast` / `attack` **不再是可配项**，
   *   写进零件的 `locks` 里就是一条错误（专属错误码）。
   *
   *   ⚠ 老断言在这里钉的正好相反 —— 原话是
   *     '  四项全勾 → 不报'（`locks: ['move', 'attack', 'cast', 'turn']`）。
   *     它当时就**没测到什么**：`MODIFIER_BAD_LOCKS` 那条判据只认"不认识的取值"，
   *     所以 `cast` / `attack` 混在里面照样通过。
   *     ⇒ 现在换成"那两个值各自报错、还配得了的两项不报"，才真的钉得住。
   */
  const badLock = codes(techWait('t.wait-bad-lock', { seconds: 1.5, locks: ['cast', '飞行'] }))
  ok('锁里写了 `cast` → 报 MODIFIER_LOCK_ENGINE_RESERVED（施法独占是引擎硬规矩，不是可配项）',
    badLock.includes('MODIFIER_LOCK_ENGINE_RESERVED'), badLock.join(' '))
  ok('  同一份里那个真正的错别字（`飞行`）照旧报 MODIFIER_BAD_LOCKS —— 两条判据分开',
    badLock.includes('MODIFIER_BAD_LOCKS'), badLock.join(' '))

  const atkLock = codes(techWait('t.wait-bad-lock-atk', { seconds: 1.5, locks: ['attack'] }))
  ok('锁里写了 `attack` → 一样报 MODIFIER_LOCK_ENGINE_RESERVED（武器攻击也是施法）',
    atkLock.includes('MODIFIER_LOCK_ENGINE_RESERVED'), atkLock.join(' '))

  const okLocks = codes(techWait('t.wait-ok-lock', { seconds: 1.5, locks: ['move', 'turn'] }))
  ok('  还配得了的那两项（move + turn）→ 不报',
    !okLocks.includes('MODIFIER_BAD_LOCKS') && !okLocks.includes('MODIFIER_LOCK_ENGINE_RESERVED'),
    okLocks.join(' '))

  const emptyLocks = codes(techWait('t.wait-empty-lock', { seconds: 1.5, locks: [] }))
  ok('  一个都不锁 → 合法（那是"这段空档什么都不挡"，不是错误）',
    !emptyLocks.includes('MODIFIER_BAD_LOCKS'), emptyLocks.join(' '))

  const notArray = codes(techWait('t.wait-lock-str', { seconds: 1.5, locks: 'cast' }))
  ok('锁写成一个字符串 → 报 MODIFIER_BAD_LOCKS',
    notArray.includes('MODIFIER_BAD_LOCKS'), notArray.join(' '))

  /*
   * ⚠ **原型那一层也要拦**（同一份规矩，两个落点：副本在 `validator/index.ts`、
   *   原型在 `validator/checks.ts` 的 `validateModifierProto`）。
   *   只在副本那一层拦的话，出厂零件自己写着 `cast` 也没人吭声 ——
   *   而"出厂零件里写着一条不生效的锁"正是最容易被当成先例抄下去的写法。
   */
  const badProto = validateModifierProto({
    ...libW.modifiers.get('mod.wait')!,
    params: { ...(libW.modifiers.get('mod.wait')?.params ?? {}), locks: ['cast'] },
  })
  ok('原型 params.locks 里写了 `cast` → 照样报 MODIFIER_LOCK_ENGINE_RESERVED',
    badProto.some(i => i.code === 'MODIFIER_LOCK_ENGINE_RESERVED'),
    badProto.map(i => i.code).join(' '))
  const goodProto = validateModifierProto({
    ...libW.modifiers.get('mod.wait')!,
    params: { ...(libW.modifiers.get('mod.wait')?.params ?? {}), locks: ['move', 'turn'] },
  })
  ok('  原型里写 move + turn → 不报',
    goodProto.length === 0, goodProto.map(i => i.code).join(' '))

  /*
   * ---- ③ 打断档只能那三档（和 `InterruptLevel` 同一套取值，不新造）----
   */
  const badInterrupt = codes(techWait('t.wait-bad-int', { seconds: 1.5, interrupt: '免打断' }))
  ok('打断档写了新造的取值 → 报 MODIFIER_BAD_INTERRUPT',
    badInterrupt.includes('MODIFIER_BAD_INTERRUPT'), badInterrupt.join(' '))

  const okInterrupt = codes(techWait('t.wait-ok-int', { seconds: 1.5, interrupt: 'damage' }))
  ok('  三档里的任何一档 → 放行（玩家要"能被打断的等待"就显式改它）',
    !okInterrupt.includes('MODIFIER_BAD_INTERRUPT'), okInterrupt.join(' '))

  /*
   * ---- ④ 它和份数类零件是**不同类别** ⇒ 不触发"不叠同类" ----
   */
  const both = validateTechnique('(测试)', {
    schemaVersion: 1,
    id: 't.wait-multi',
    name: 't.wait-multi',
    kind: 'magic',
    activation: 'press',
    sequences: [{
      name: '一段',
      skills: ['skill.magic-bolt', 'skill.hunt'],
      mods: [
        { proto: 'mod.wait', at: 1, params: { seconds: 1.5 } },
        { proto: 'mod.multi.fire', at: 0, params: { count: 2 } },
      ],
    }],
  }, wOpts).issues.map(i => i.code)
  ok('「等待」+「多重释放」并排 → 不报 MODIFIER_STACKED_KIND（两个类别）',
    !both.includes('MODIFIER_STACKED_KIND'), both.join(' '))

  /*
   * ⚠ **两个等待叠在同一段里**照旧被"不叠同类"拦下（`kind` 是同一个）——
   *   而引擎那一侧还有第二道防线（编译期只插第一个、数量对不上就整段退回），
   *   两层都不静默。
   */
  const twoWaits = codes({
    schemaVersion: 1,
    id: 't.wait-twice',
    name: 't.wait-twice',
    kind: 'magic',
    activation: 'press',
    sequences: [{
      name: '一段',
      skills: ['skill.magic-bolt', 'skill.hunt'],
      mods: [
        { proto: 'mod.wait', at: 0, params: { seconds: 1 } },
        { proto: 'mod.wait', at: 1, params: { seconds: 1 } },
      ],
    }],
  })
  ok('  两个「等待」叠在同一段 → 报 MODIFIER_STACKED_KIND',
    twoWaits.includes('MODIFIER_STACKED_KIND'), twoWaits.join(' '))
}

section('排布：三选一 / 参数范围 / 认不出的摆法不许猜（校验器那一侧）')

{
  const libL = loadLibrary(balance)
  const lOpts = {
    balance,
    skills: libL.skills,
    statuses: libL.statuses,
    entities: libL.entities,
    techniques: libL.techniques,
    modifierProtos: libL.modifiers,
  }
  const layoutCodesOf = (t: Technique): string[] =>
    validateTechnique('(测试)', t, lOpts).issues.map(i => i.code)
  const techLayout = (id: string, params: Record<string, unknown>, skills = ['skill.magic-bolt']): Technique => ({
    schemaVersion: 1,
    id,
    name: id,
    kind: 'magic',
    activation: 'press',
    sequences: [{ name: '一段', skills: [...skills], mods: [{ proto: 'mod.layout', at: 0, params }] as never }],
  })

  /*
   * ---- ① `type` 三选一 ----
   *     玩家："一个零件、**编辑时选类型**"（环绕 / 扇形散射 / 反向镜像）。
   *     ⚠ 认不出的取值**必须报错**：引擎那一侧会整块不生效（不猜摆法）——
   *       而"写了不生效"是本项目列为最危险的一类静默失败。
   */
  for (const t of ['ring', 'fan', 'mirror']) {
    const cs = layoutCodesOf(techLayout(`t.layout-${t}`, { type: t }))
    ok(`摆法 ${t} → 放行（三选一里的合法取值）`,
      !cs.includes('MODIFIER_LAYOUT_BAD_TYPE'), cs.join(' '))
  }
  const badType = layoutCodesOf(techLayout('t.layout-bad', { type: 'circle' }))
  ok('摆法写成 circle → 报 MODIFIER_LAYOUT_BAD_TYPE',
    badType.includes('MODIFIER_LAYOUT_BAD_TYPE'), badType.join(' '))
  const missingType = layoutCodesOf(techLayout('t.layout-missing', { radius: 2 }))
  ok('  副本**不写** type → 放行（按原型的默认摆法，和 count / seconds 同一条规矩）',
    !missingType.includes('MODIFIER_LAYOUT_BAD_TYPE'), missingType.join(' '))

  /*
   * ---- ② 半径 / 三个角度 / 张角都在**原型**给的范围内 ----
   *     ⚠ 范围住在原型里（`content/modifiers/layout.json` 的
   *       `params.minRadius` / `maxRadius` / `maxAngle` / `maxSpread`），
   *       不是代码里的常数 —— 所以这里证明"改原型就能改范围"。
   */
  const overRadius = layoutCodesOf(techLayout('t.layout-r-over', { type: 'ring', radius: 99 }))
  ok('半径 99 米 → 报 MODIFIER_LAYOUT_OVER_CAP',
    overRadius.includes('MODIFIER_LAYOUT_OVER_CAP'), overRadius.join(' '))
  const underRadius = layoutCodesOf(techLayout('t.layout-r-under', { type: 'ring', radius: 0.01 }))
  ok('  半径 0.01 米 → 报 MODIFIER_LAYOUT_OVER_CAP（下限那一头也是判据）',
    underRadius.includes('MODIFIER_LAYOUT_OVER_CAP'), underRadius.join(' '))

  const okRadius = layoutCodesOf(techLayout('t.layout-r-ok', { type: 'ring', radius: 6 }))
  ok('  正好 6 米（上限）→ 放行（闭区间）',
    !okRadius.includes('MODIFIER_LAYOUT_OVER_CAP'), okRadius.join(' '))

  const overStart = layoutCodesOf(techLayout('t.layout-a-over', { type: 'ring', startAngle: 9999 }))
  ok('起始角 9999 度 → 报 MODIFIER_LAYOUT_OVER_CAP',
    overStart.includes('MODIFIER_LAYOUT_OVER_CAP'), overStart.join(' '))
  const negStart = layoutCodesOf(techLayout('t.layout-a-neg', { type: 'ring', startAngle: -90 }))
  ok('  起始角是**有正负的**（-90 度放行）',
    !negStart.includes('MODIFIER_LAYOUT_OVER_CAP'), negStart.join(' '))

  const overSpread = layoutCodesOf(techLayout('t.layout-s-over', { type: 'fan', spread: 100000 }))
  ok('张角 100000 度 → 报 MODIFIER_LAYOUT_OVER_CAP',
    overSpread.includes('MODIFIER_LAYOUT_OVER_CAP'), overSpread.join(' '))
  const negSpread = layoutCodesOf(techLayout('t.layout-s-neg', { type: 'fan', spread: -10 }))
  ok('  张角 -10 度 → 报（它**只有正的一侧**）',
    negSpread.includes('MODIFIER_LAYOUT_OVER_CAP'), negSpread.join(' '))

  const badNumber = layoutCodesOf(techLayout('t.layout-nan', { type: 'ring', radius: '很远' }))
  ok('半径写成字符串 → 报 MODIFIER_LAYOUT_BAD_NUMBER（不许静默当默认值）',
    badNumber.includes('MODIFIER_LAYOUT_BAD_NUMBER'), badNumber.join(' '))

  /*
   * ---- ③ `even` 必须是 true / false ----
   *     写成 `1` 时引擎按默认的"均匀"处理 ⇒ 而"我关掉了它却还是均匀排"
   *     正是最该拦住的那种静默坏行为。
   */
  const badEven = layoutCodesOf(techLayout('t.layout-even', { type: 'ring', even: 1 }))
  ok('even 写成 1 → 报 MODIFIER_LAYOUT_BAD_EVEN',
    badEven.includes('MODIFIER_LAYOUT_BAD_EVEN'), badEven.join(' '))
  const okEven = layoutCodesOf(techLayout('t.layout-even-ok', { type: 'ring', even: false }))
  ok('  写成 false / true → 放行',
    !okEven.includes('MODIFIER_LAYOUT_BAD_EVEN'), okEven.join(' '))

  /*
   * ---- ④ 范围是**数据**：把原型的 maxRadius 抬到 20，同一个 99 米副本照样拦（上限变了）----
   *     这一条钉的是"范围住在内容里"，不是"代码里写死了一个 6"。
   */
  const patchedL = new Map(libL.modifiers)
  const layoutProto = patchedL.get('mod.layout')
  if (layoutProto === undefined) throw new Error('内容里没有 mod.layout')
  patchedL.set('mod.layout', {
    ...layoutProto,
    params: { ...layoutProto.params, maxRadius: 20, radius: 20 },
  })
  const liftedRadius = validateTechnique('(测试)',
    techLayout('t.layout-lifted', { type: 'ring', radius: 15 }),
    { ...lOpts, modifierProtos: patchedL }).issues.map(i => i.code)
  ok('  把原型的 maxRadius 抬到 20 → 15 米就不报了（范围是**数据**）',
    !liftedRadius.includes('MODIFIER_LAYOUT_OVER_CAP'), liftedRadius.join(' '))

  /*
   * ---- ⑤ 今天只有 `at: 0` 会生效 → 警告，不是错误 ----
   *     ⚠ 排布和份数共用**同一个落点**（`activateGroup` 的"第一份施法"），
   *       所以它和「多重释放」/「一分为 X」同一个限制。
   */
  const atOne = validateTechnique('(测试)', {
    schemaVersion: 1,
    id: 't.layout-at1',
    name: 't.layout-at1',
    kind: 'magic',
    activation: 'press',
    sequences: [{
      name: '一段',
      skills: ['skill.magic-bolt', 'skill.hunt'],
      mods: [{ proto: 'mod.layout', at: 1, params: { type: 'ring', radius: 2 } }] as never,
    }],
  }, lOpts)
  const atOneCodes = atOne.issues.map(i => i.code)
  ok('at: 1 → 报 MODIFIER_GROUP_AT_NOT_WIRED（警告：写上去不生效要说出来）',
    atOneCodes.includes('MODIFIER_GROUP_AT_NOT_WIRED'), atOneCodes.join(' '))
  ok('  而且它是**警告**不是错误（内容是合理的前置）',
    atOne.issues.every(i => i.code !== 'MODIFIER_GROUP_AT_NOT_WIRED' || i.level === 'warning'),
    atOne.issues.map(i => `${i.code}:${i.level}`).join(' '))

  /*
   * ---- ⑥ ⚠⚠ **排布不查任何"份数"的规矩**（玩家划的第一条硬界线）----
   *
   *   它**不管份数** ⇒ 那两条只对份数类零件有意义的判据在它身上一条都不该出现：
   *     · `MODIFIER_COUNT_OVER_CAP`（超出份数上限）
   *     · `MULTI_FIRE_NON_INSTANT`（多重释放只作用于瞬发技能）
   *   ⚠ 这里用**蓄力技能**当目标：如果哪天有人把排布接进"份数那一套"，
   *     它会被判成"多打了一个蓄力技能"而红 —— 这条断言就是那道门闩。
   */
  const aroundCharged = layoutCodesOf(techLayout('t.layout-charged', { type: 'ring', radius: 2 }, ['skill.charged-laser']))
  ok('⚠ 排布放在**蓄力技能**前面 → 不报 MULTI_FIRE_NON_INSTANT（它不管份数）',
    !aroundCharged.includes('MULTI_FIRE_NON_INSTANT'), aroundCharged.join(' '))
  ok('  也不报 MODIFIER_COUNT_OVER_CAP（它没有份数可超）',
    !aroundCharged.includes('MODIFIER_COUNT_OVER_CAP'), aroundCharged.join(' '))

  /*
   * ---- ⑦ 它和份数类零件是**不同类别** ⇒ 不触发"不叠同类" ----
   *     玩家要的用法正是"一分为 X 掰出几份 + 排布把它们摆开"。
   */
  const withSplit = validateTechnique('(测试)', {
    schemaVersion: 1,
    id: 't.layout-split',
    name: 't.layout-split',
    kind: 'magic',
    activation: 'press',
    sequences: [{
      name: '一段',
      skills: ['skill.magic-bolt'],
      mods: [
        { proto: 'mod.split', at: 0, params: { count: 3 } },
        { proto: 'mod.layout', at: 0, params: { type: 'ring', radius: 2 } },
      ] as never,
    }],
  }, lOpts).issues.map(i => i.code)
  ok('「一分为 X」+「排布」并排 → 不报 MODIFIER_STACKED_KIND（两个类别）',
    !withSplit.includes('MODIFIER_STACKED_KIND'), withSplit.join(' '))
  const twoLayouts = layoutCodesOf({
    schemaVersion: 1,
    id: 't.layout-twice',
    name: 't.layout-twice',
    kind: 'magic',
    activation: 'press',
    sequences: [{
      name: '一段',
      skills: ['skill.magic-bolt', 'skill.hunt'],
      mods: [
        { proto: 'mod.layout', at: 0, params: { type: 'ring' } },
        { proto: 'mod.layout', at: 1, params: { type: 'fan' } },
      ] as never,
    }],
  })
  ok('  而两个「排布」叠在同一段 → 报 MODIFIER_STACKED_KIND（同类不许叠）',
    twoLayouts.includes('MODIFIER_STACKED_KIND'), twoLayouts.join(' '))
}

section('追踪：两个参数的范围 / 认不出的转速不许猜（校验器那一侧）')

{
  /*
   * ⚠⚠ 这一节钉的是**玩家那条界线**在校验器这一侧的表述（**日志 56 第二版**）：
   *   "**只对会飞的东西有效**"；非飞行载体装了它 ⇒ 引擎**什么都不做**，
   *   ⚠ **要报出来（警告）** + **账上一分钱都不收** —— 玩家原话：
   *   "**花钱买了什么都不做** 比'没提示'更糟"。
   *   ⚠ 判据**只有一处**（`school.ts` 的 `carrierFliesInWorld`，日志 58 从
   *     `homingAppliesTo` 改名、**函数体一个字没改**），校验器和账本共用它。
   */
  const libH = loadLibrary(balance)
  const hOpts = {
    balance,
    skills: libH.skills,
    statuses: libH.statuses,
    entities: libH.entities,
    techniques: libH.techniques,
    modifierProtos: libH.modifiers,
  }
  const homingIssues = (t: Technique):
  Array<{ code: string, level: string }> =>
    validateTechnique('(测试)', t, hOpts).issues.map(i => ({ code: i.code, level: i.level }))
  const homingCodes = (t: Technique): string[] => homingIssues(t).map(i => i.code)
  const techHoming = (
    id: string,
    params: Record<string, unknown>,
    skills = ['skill.magic-bolt'],
  ): Technique => ({
    schemaVersion: 1,
    id,
    name: id,
    kind: 'magic',
    activation: 'press',
    sequences: [{ name: '一段', skills: [...skills], mods: [{ proto: 'mod.homing', at: 0, params }] as never }],
  })

  /*
   * ---- ① 副本**不写**参数 → 放行（按原型那两个默认值） ----
   *     和 `count` / `seconds` / 摆法同一条规矩：缺了有兜底，只拦"写了但写歪了"。
   */
  const missing = homingCodes(techHoming('t.homing-missing', {}))
  ok('副本不写 turnRate / maxRange → 放行（按原型的默认值）',
    !missing.includes('MODIFIER_HOMING_BAD_NUMBER')
    && !missing.includes('MODIFIER_HOMING_OVER_CAP'), missing.join(' '))

  // ---- ② 两个参数都在**原型**给的范围内（闭区间两头都放行） ----
  const okBoth = homingCodes(techHoming('t.homing-ok', { turnRate: 30, maxRange: 16 }))
  ok('  转速 30 / 搜索距离 16（两个上限）→ 放行（闭区间）',
    !okBoth.includes('MODIFIER_HOMING_OVER_CAP'), okBoth.join(' '))
  const atMin = homingCodes(techHoming('t.homing-min', { turnRate: 1, maxRange: 1 }))
  ok('  转速 1（下限）/ 搜索距离 1（下限）→ 放行',
    !atMin.includes('MODIFIER_HOMING_OVER_CAP'), atMin.join(' '))

  /*
   * ---- ③ 越界 ⇒ `MODIFIER_HOMING_OVER_CAP`（两头都是判据） ----
   *     ⚠ 范围**住在原型里**（`content/modifiers/homing.json` 的
   *       `maxTurnRate` / `minRange` / `maxRangeCap`），不是代码里的常数。
   */
  const overTurn = homingCodes(techHoming('t.homing-turn-over', { turnRate: 9999 }))
  ok('转速 9999 度/tick → 报 MODIFIER_HOMING_OVER_CAP',
    overTurn.includes('MODIFIER_HOMING_OVER_CAP'), overTurn.join(' '))
  /*
   * ⚠⚠ 转速的**下限回到了 1**（2026-09-30 玩家裁定，日志 56 第二版）：
   *   整圈角度表已经**做细到 1 度** ⇒ "1 度"是一个**真能表达**的刻度。
   *   在那之前表是 **5 度一格**，下限只能抬到 5 —— 因为"每 tick 转 2 度"
   *   会被吸成 **0 度** ⇒ 子弹**设了转速却完全直飞**（**静默失效**）。
   *   ⇒ 这一组断言钉两件事：**2 度要放行**（表做细了）、**0 度仍然要报**
   *     （0 = "每 tick 拐 0 度" = 这个零件白装，和"没装"在表现上一模一样）。
   */
  const atTwo = homingCodes(techHoming('t.homing-turn-2', { turnRate: 2 }))
  ok('⚠ 转速 2 度/tick → **放行**（表做细到 1 度之后它是真能表达的刻度）',
    !atTwo.includes('MODIFIER_HOMING_OVER_CAP'), atTwo.join(' '))
  const zeroTurn = homingCodes(techHoming('t.homing-turn-0', { turnRate: 0 }))
  ok('  转速 0 度/tick → 报 MODIFIER_HOMING_OVER_CAP（0 = 这个零件白装）',
    zeroTurn.includes('MODIFIER_HOMING_OVER_CAP'), zeroTurn.join(' '))

  const overRange = homingCodes(techHoming('t.homing-range-over', { maxRange: 100 }))
  ok('搜索距离 100 米 → 报 MODIFIER_HOMING_OVER_CAP（不许"全图追踪"）',
    overRange.includes('MODIFIER_HOMING_OVER_CAP'), overRange.join(' '))
  const underRange = homingCodes(techHoming('t.homing-range-under', { maxRange: 0.1 }))
  ok('  搜索距离 0.1 米 → 报 MODIFIER_HOMING_OVER_CAP（下限那一头也是判据）',
    underRange.includes('MODIFIER_HOMING_OVER_CAP'), underRange.join(' '))

  const badNumber = homingCodes(techHoming('t.homing-nan', { turnRate: '很快' }))
  ok('转速写成字符串 → 报 MODIFIER_HOMING_BAD_NUMBER（不许静默当默认值）',
    badNumber.includes('MODIFIER_HOMING_BAD_NUMBER'), badNumber.join(' '))

  /*
   * ---- ④ 范围是**数据**：把原型的 maxRangeCap 抬到 40，同一个 100 米副本照样拦 ----
   *     这一条钉的是"范围住在内容里"，不是"代码里写死了一个 16"。
   */
  const patchedH = new Map(libH.modifiers)
  const homingProto = patchedH.get('mod.homing')
  if (homingProto === undefined) throw new Error('内容里没有 mod.homing')
  patchedH.set('mod.homing', {
    ...homingProto,
    params: { ...homingProto.params, maxRangeCap: 40 },
  })
  const liftedRange = validateTechnique('(测试)',
    techHoming('t.homing-lifted', { maxRange: 30 }),
    { ...hOpts, modifierProtos: patchedH }).issues.map(i => i.code)
  ok('  把原型的 maxRangeCap 抬到 40 → 30 米就不报了（范围是**数据**）',
    !liftedRange.includes('MODIFIER_HOMING_OVER_CAP'), liftedRange.join(' '))

  /*
   * ---- ⑤ 今天只有 `at: 0` 会生效 → **警告**，不是错误 ----
   *     ⚠ 和份数类 / 排布同一个限制：引擎读修饰副本的地方只处理紧邻的第一个技能。
   */
  const atOne = validateTechnique('(测试)', {
    schemaVersion: 1,
    id: 't.homing-at1',
    name: 't.homing-at1',
    kind: 'magic',
    activation: 'press',
    sequences: [{
      name: '一段',
      skills: ['skill.magic-bolt', 'skill.hunt'],
      mods: [{ proto: 'mod.homing', at: 1, params: { turnRate: 12 } }] as never,
    }],
  }, hOpts)
  const atOneCodes = atOne.issues.map(i => i.code)
  ok('at: 1 → 报 MODIFIER_GROUP_AT_NOT_WIRED（写上去不生效要说出来）',
    atOneCodes.includes('MODIFIER_GROUP_AT_NOT_WIRED'), atOneCodes.join(' '))
  ok('  而且它是**警告**不是错误（内容是合理的前置）',
    atOne.issues.every(i => i.code !== 'MODIFIER_GROUP_AT_NOT_WIRED' || i.level === 'warning'),
    atOne.issues.map(i => `${i.code}:${i.level}`).join(' '))

  /*
   * ---- ⑥ ⚠⚠ **装在非飞行载体上：报出来 + 不收钱**（玩家 2026-09-30 裁定）----
   *
   *   玩家原话："部分技能比如**激光**不能被它修饰，看着不合理" ——
   *   追问后的口径是"**什么都不做**"，而日志 56 第二版又裁了一条：
   *   **"花钱买了什么都不做 比'没提示'更糟"** ⇒
   *     · 校验器：报一条 **`MODIFIER_HOMING_NOT_FLYING`**（**警告**，"不起作用"是设计允许的）
   *     · 账本：**一分钱都不收**（下面第 ⑦ 组钉它）
   *   ⚠⚠ 两条读的是**同一个判据**：`school.ts` 的 `carrierFliesInWorld(kind)`
   *     （日志 58 从 `homingAppliesTo` 改名，**函数体一个字没改**）。
   *
   *   ⚠ 用 `skill.charged-laser`（出厂那个 `beam` 载体 + 蓄力）当目标 ——
   *     它就是玩家点名的那类"看着不合理"的技能。
   */
  const onBeam = homingIssues(techHoming('t.homing-beam', { turnRate: 12 }, ['skill.charged-laser']))
  ok('⚠ 装在激光（beam 载体）上 → 报 MODIFIER_HOMING_NOT_FLYING（让人看见它不起作用）',
    onBeam.some(i => i.code === 'MODIFIER_HOMING_NOT_FLYING'), JSON.stringify(onBeam))
  ok('  而且它是**警告**不是错误（"不起作用"是设计允许的，不是写错了）',
    onBeam.every(i => i.code !== 'MODIFIER_HOMING_NOT_FLYING' || i.level === 'warning'),
    JSON.stringify(onBeam))
  ok('  它**不报** DELIVERY_FIELD_UNUSED 那一类（那是载体自己的字段，和修饰副本无关）',
    onBeam.every(i => i.code !== 'DELIVERY_FIELD_UNUSED'), JSON.stringify(onBeam))

  /*
   * ⚠ 反过来：装在一个**会飞**的技能上（`skill.magic-bolt` 是投射物）⇒ **不该有那条警告**。
   *   少了这一条，"判据永远返回 false"和"判据真的在管事"就分不出来。
   */
  const onBolt = homingIssues(techHoming('t.homing-bolt', { turnRate: 12 }))
  ok('  反过来：装在**会飞**的技能上 → **不报**那条警告（判据真的在管事）',
    !onBolt.some(i => i.code === 'MODIFIER_HOMING_NOT_FLYING'), JSON.stringify(onBolt))

  /*
   * ⚠ 还有一半：**一个载体都没有的技能**（纯属性 / 纯位移）⇒ 同样"它拐不了任何东西"
   *   ⇒ 也报。⚠ 用 `skill.charge-dash`（纯位移，出厂那份）。
   */
  const onDash = homingIssues(techHoming('t.homing-dash', { turnRate: 12 }, ['skill.charge-dash']))
  ok('  而一个载体都没有的技能（纯位移）→ 也报（追踪对它同样什么都不做）',
    onDash.some(i => i.code === 'MODIFIER_HOMING_NOT_FLYING'), JSON.stringify(onDash))

  /*
   * ---- ⑦ 它和份数类零件是**不同类别** ⇒ 不触发"不叠同类" ----
   *     玩家要的用法正是"一分为 X 掰出几份 + 每一发都追踪"。
   */
  const withSplit = validateTechnique('(测试)', {
    schemaVersion: 1,
    id: 't.homing-split',
    name: 't.homing-split',
    kind: 'magic',
    activation: 'press',
    sequences: [{
      name: '一段',
      skills: ['skill.magic-bolt'],
      mods: [
        { proto: 'mod.split', at: 0, params: { count: 3 } },
        { proto: 'mod.homing', at: 0, params: { turnRate: 12 } },
      ] as never,
    }],
  }, hOpts).issues.map(i => i.code)
  ok('「一分为 X」+「追踪」并排 → 不报 MODIFIER_STACKED_KIND（两个类别）',
    !withSplit.includes('MODIFIER_STACKED_KIND'), withSplit.join(' '))
  const twoHoming = homingCodes({
    schemaVersion: 1,
    id: 't.homing-twice',
    name: 't.homing-twice',
    kind: 'magic',
    activation: 'press',
    sequences: [{
      name: '一段',
      skills: ['skill.magic-bolt', 'skill.hunt'],
      mods: [
        { proto: 'mod.homing', at: 0, params: { turnRate: 12 } },
        { proto: 'mod.homing', at: 1, params: { turnRate: 12 } },
      ] as never,
    }],
  })
  ok('  而两个「追踪」叠在同一段 → 报 MODIFIER_STACKED_KIND（同类不许叠）',
    twoHoming.includes('MODIFIER_STACKED_KIND'), twoHoming.join(' '))
}

section('弹射：次数上限**就是引擎的深度限制** + 装在非飞行载体上要报出来（校验器那一侧）')

{
  /*
   * ⚠⚠ 玩家 2026-09-30 日志 58 的两条硬命令：
   *   1. "**上限必须和 `pipeline` 的深度限制用同一条规矩** ✗（先 grep `depth` ✓
   *      找现有上限 ✓ **复用它** ✓ —— 各写一份迟早出现'弹射绕过深度保护 ⇒ 自反馈'✗）"
   *      ⇒ 判据是**一个数**：`src/limits.ts` 的 `MAX_ACTION_DEPTH`。
   *        `school.ts` 的 `MODIFIER_BOUNCE_COUNT_MAX` 就是它（不是第二份 4）。
   *   2. "**只对"会飞的东西"有效**；非飞行载体 ⇒ **什么都不做、而且不收费** ——
   *      **这**和「追踪」是同一条规矩** ✓ 所以**判据要共用**"。
   *      ⇒ 判据**只有一处**（`school.ts` 的 `carrierFliesInWorld`），
   *        校验器和账本共用它（账那一半在 `tests/pricing.ts`）。
   */
  const libB = loadLibrary(balance)
  const bOpts = {
    balance,
    skills: libB.skills,
    statuses: libB.statuses,
    entities: libB.entities,
    techniques: libB.techniques,
    modifierProtos: libB.modifiers,
  }
  const bounceIssues = (t: Technique):
  Array<{ code: string, level: string }> =>
    validateTechnique('(测试)', t, bOpts).issues.map(i => ({ code: i.code, level: i.level }))
  const bounceCodes = (t: Technique): string[] => bounceIssues(t).map(i => i.code)
  const techBounce = (
    id: string,
    params: Record<string, unknown>,
    skills = ['skill.magic-bolt'],
  ): Technique => ({
    schemaVersion: 1,
    id,
    name: id,
    kind: 'magic',
    activation: 'press',
    sequences: [{ name: '一段', skills: [...skills], mods: [{ proto: 'mod.bounce', at: 0, params }] as never }],
  })

  /*
   * ---- ① ⚠⚠ **上限和深度限制是同一个数** ----
   *
   *   ⚠ 这一条是"同一条规矩"在**校验器**这一侧的落点：
   *     写 5 次（超过深度上限 4）⇒ 报 `MODIFIER_BOUNCE_OVER_CAP`。
   *     写 4 ⇒ 放行（闭区间）。
   */
  const overFive = bounceCodes(techBounce('t.bounce-over5', { maxBounces: 5 }))
  ok('⚠⚠ 弹射 5 次（超过引擎的深度上限 4）→ 报 MODIFIER_BOUNCE_OVER_CAP',
    overFive.includes('MODIFIER_BOUNCE_OVER_CAP'), overFive.join(' '))
  const atFour = bounceCodes(techBounce('t.bounce-4', { maxBounces: 4 }))
  ok('  弹射 4 次（= MAX_ACTION_DEPTH）→ 放行（闭区间）',
    !atFour.includes('MODIFIER_BOUNCE_OVER_CAP'), atFour.join(' '))
  const atOne = bounceCodes(techBounce('t.bounce-1', { maxBounces: 1 }))
  ok('  弹射 1 次（下限）→ 放行',
    !atOne.includes('MODIFIER_BOUNCE_OVER_CAP'), atOne.join(' '))
  const zero = bounceCodes(techBounce('t.bounce-0', { maxBounces: 0 }))
  ok('  弹射 0 次 → 报（0 = 这个零件白装，和"没装"一模一样）',
    zero.includes('MODIFIER_BOUNCE_OVER_CAP'), zero.join(' '))
  const frac = bounceCodes(techBounce('t.bounce-frac', { maxBounces: 2.7 }))
  ok('  弹射 2.7 次 → 报 MODIFIER_BOUNCE_BAD_NUMBER（次数是整数）',
    frac.includes('MODIFIER_BOUNCE_BAD_NUMBER'), frac.join(' '))
  const badCount = bounceCodes(techBounce('t.bounce-str', { maxBounces: '三次' }))
  ok('  次数写成字符串 → 报 MODIFIER_BOUNCE_BAD_NUMBER（不许静默当默认值）',
    badCount.includes('MODIFIER_BOUNCE_BAD_NUMBER'), badCount.join(' '))

  /*
   * ⚠⚠ **"上限只有一个"的机械证据**：把原型的 `maxBouncesCap` 抬到 9，
   *   副本写 9 **仍然报** —— 因为引擎真正读的是 `min(它, MAX_ACTION_DEPTH)`。
   *   ⚠ 这一条和数据驱动的零件（排布 / 追踪）**故意不一样**：
   *     那两个"范围住在原型里"，弹射的次数上限**住在引擎里**
   *     （玩家原话："各写一份迟早出现弹射绕过深度保护 ⇒ 自反馈"）。
   */
  const patched = new Map(libB.modifiers)
  const bounceProto = patched.get('mod.bounce')
  if (bounceProto === undefined) throw new Error('内容里没有 mod.bounce')
  patched.set('mod.bounce', {
    ...bounceProto,
    params: { ...bounceProto.params, maxBouncesCap: 9 },
  })
  const lifted = validateTechnique('(测试)',
    techBounce('t.bounce-lifted', { maxBounces: 9 }),
    { ...bOpts, modifierProtos: patched }).issues.map(i => i.code)
  ok('  把原型的 maxBouncesCap 抬到 9 → 9 次**照样报**（上限不是数据说了算）',
    lifted.includes('MODIFIER_BOUNCE_OVER_CAP'), lifted.join(' '))

  // ---- ② 衰减：范围是数据（原型里的 minFalloff / maxFalloff） ----
  const okFalloff = bounceCodes(techBounce('t.bounce-f-ok', { damageFalloff: 0.7 }))
  ok('  衰减 0.7（默认）→ 放行',
    !okFalloff.includes('MODIFIER_BOUNCE_OVER_CAP'), okFalloff.join(' '))
  const amp = bounceCodes(techBounce('t.bounce-f-amp', { damageFalloff: 1.5 }))
  ok('  衰减 1.5（= 越弹越强）→ 报 MODIFIER_BOUNCE_OVER_CAP（上限是 1）',
    amp.includes('MODIFIER_BOUNCE_OVER_CAP'), amp.join(' '))
  const zeroF = bounceCodes(techBounce('t.bounce-f-0', { damageFalloff: 0 }))
  ok('  衰减 0（下一段 0 伤害）→ 报（那和"没有第二段"分不出来）',
    zeroF.includes('MODIFIER_BOUNCE_OVER_CAP'), zeroF.join(' '))
  const badF = bounceCodes(techBounce('t.bounce-f-str', { damageFalloff: '很弱' }))
  ok('  衰减写成字符串 → 报 MODIFIER_BOUNCE_BAD_NUMBER',
    badF.includes('MODIFIER_BOUNCE_BAD_NUMBER'), badF.join(' '))
  const missing = bounceCodes(techBounce('t.bounce-missing', {}))
  ok('  两个参数都不写 → 放行（按原型的默认值兜底）',
    !missing.includes('MODIFIER_BOUNCE_BAD_NUMBER')
    && !missing.includes('MODIFIER_BOUNCE_OVER_CAP'), missing.join(' '))

  // ---- ③ 今天只有 `at: 0` 会生效 → 警告，不是错误 ----
  const atOneB = validateTechnique('(测试)', {
    schemaVersion: 1,
    id: 't.bounce-at1',
    name: 't.bounce-at1',
    kind: 'magic',
    activation: 'press',
    sequences: [{
      name: '一段',
      skills: ['skill.magic-bolt', 'skill.hunt'],
      mods: [{ proto: 'mod.bounce', at: 1, params: { maxBounces: 2 } }] as never,
    }],
  }, bOpts)
  const atOneBCodes = atOneB.issues.map(i => i.code)
  ok('  at: 1 → 报 MODIFIER_GROUP_AT_NOT_WIRED（写上去不生效要说出来）',
    atOneBCodes.includes('MODIFIER_GROUP_AT_NOT_WIRED'), atOneBCodes.join(' '))
  ok('  而且它是**警告**不是错误',
    atOneB.issues.every(i => i.code !== 'MODIFIER_GROUP_AT_NOT_WIRED' || i.level === 'warning'),
    atOneB.issues.map(i => `${i.code}:${i.level}`).join(' '))

  /*
   * ---- ④ ⚠⚠ **装在非飞行载体上：报出来**（和追踪**同一条规矩**）----
   *
   *   ⚠ 用 `skill.charged-laser`（出厂那个 `beam` 载体 + 蓄力）当目标 ——
   *     它就是玩家点名的那类"看着不合理"的技能。
   *   ⚠⚠ **"判据要共用"的机械证据就是这一节和 `tests/pricing.ts` 那一节**：
   *     同一个技能、同一个零件 ⇒ 这里**报**、那里**不收钱**，
   *     而两处读的是同一个函数（`school.ts` 的 `carrierFliesInWorld`）。
   */
  const onBeamB = bounceIssues(techBounce('t.bounce-beam', { maxBounces: 2 }, ['skill.charged-laser']))
  ok('⚠ 装在激光（beam 载体）上 → 报 MODIFIER_BOUNCE_NOT_FLYING（让人看见它不起作用）',
    onBeamB.some(i => i.code === 'MODIFIER_BOUNCE_NOT_FLYING'), JSON.stringify(onBeamB))
  ok('  而且它是**警告**不是错误（"不起作用"是设计允许的，不是写错了）',
    onBeamB.every(i => i.code !== 'MODIFIER_BOUNCE_NOT_FLYING' || i.level === 'warning'),
    JSON.stringify(onBeamB))

  /*
   * ⚠ 反过来：装在一个**会飞**的技能上（`skill.magic-bolt` 是投射物）⇒ **不该有那条警告**。
   *   少了这一条，"判据永远返回 false"和"判据真的在管事"就分不出来。
   */
  const onBoltB = bounceIssues(techBounce('t.bounce-bolt', { maxBounces: 2 }))
  ok('  反过来：装在**会飞**的技能上 → **不报**那条警告（判据真的在管事）',
    !onBoltB.some(i => i.code === 'MODIFIER_BOUNCE_NOT_FLYING'), JSON.stringify(onBoltB))

  // ⚠ 一个载体都没有的技能（纯位移）⇒ 同样"它弹不了任何东西" ⇒ 也报
  const onDashB = bounceIssues(techBounce('t.bounce-dash', { maxBounces: 2 }, ['skill.charge-dash']))
  ok('  而一个载体都没有的技能（纯位移）→ 也报（弹射对它同样什么都不做）',
    onDashB.some(i => i.code === 'MODIFIER_BOUNCE_NOT_FLYING'), JSON.stringify(onDashB))

  /*
   * ⚠⚠ **"判据只有一处"的直接断言**：追踪和弹射在同一个技能上**同时**报/不报 ——
   *   两处各写一份判据的话，这一条迟早变成"一个报一个不报"。
   */
  const bothOnBeam = validateTechnique('(测试)', {
    schemaVersion: 1,
    id: 't.both-beam',
    name: 't.both-beam',
    kind: 'magic',
    activation: 'press',
    sequences: [{
      name: '一段',
      skills: ['skill.charged-laser'],
      mods: [
        { proto: 'mod.homing', at: 0, params: { turnRate: 12 } },
        { proto: 'mod.bounce', at: 0, params: { maxBounces: 2 } },
      ] as never,
    }],
  }, bOpts).issues.map(i => i.code)
  ok('⚠⚠ 同一束激光上同时装追踪 + 弹射 → **两条警告都报**（判据是同一个函数）',
    bothOnBeam.includes('MODIFIER_HOMING_NOT_FLYING')
    && bothOnBeam.includes('MODIFIER_BOUNCE_NOT_FLYING'), bothOnBeam.join(' '))

  /*
   * ---- ⑤ 它和份数类 / 追踪是**不同类别** ⇒ 不触发"不叠同类" ----
   */
  const withSplitB = validateTechnique('(测试)', {
    schemaVersion: 1,
    id: 't.bounce-split',
    name: 't.bounce-split',
    kind: 'magic',
    activation: 'press',
    sequences: [{
      name: '一段',
      skills: ['skill.magic-bolt'],
      mods: [
        { proto: 'mod.split', at: 0, params: { count: 3 } },
        { proto: 'mod.homing', at: 0, params: { turnRate: 12 } },
        { proto: 'mod.bounce', at: 0, params: { maxBounces: 2 } },
      ] as never,
    }],
  }, bOpts).issues.map(i => i.code)
  ok('「一分为 X」+「追踪」+「弹射」并排 → 不报 MODIFIER_STACKED_KIND（三个类别）',
    !withSplitB.includes('MODIFIER_STACKED_KIND'), withSplitB.join(' '))
  const twoBounce = bounceCodes({
    schemaVersion: 1,
    id: 't.bounce-twice',
    name: 't.bounce-twice',
    kind: 'magic',
    activation: 'press',
    sequences: [{
      name: '一段',
      skills: ['skill.magic-bolt', 'skill.hunt'],
      mods: [
        { proto: 'mod.bounce', at: 0, params: { maxBounces: 2 } },
        { proto: 'mod.bounce', at: 1, params: { maxBounces: 2 } },
      ] as never,
    }],
  })
  ok('  而两个「弹射」叠在同一段 → 报 MODIFIER_STACKED_KIND（同类不许叠）',
    twoBounce.includes('MODIFIER_STACKED_KIND'), twoBounce.join(' '))
}

section('排布：三种摆法的方向 / 位置是**纯函数**算出来的（份数与意图都不动）')

{
  /*
   * ---- ① ⚠⚠ **硬界线一：排布不改份数** ----
   *
   * 判据是**编译产物的份数列表**：同一段带 / 不带排布，`groupPlanOf`
   * 给出的下标必须**逐位相同**。⚠ 只数"起了几个施法"是不够的
   * （那是运行期的观察），这里数的是**计划本身**。
   */
  const segOf = (mods: CompiledSegment['mods']): CompiledSegment => ({
    technique: {
      id: 'seg', name: 'seg', activation: 'press',
      targeting: { mode: 'directional', valid: ['enemy'] },
      phases: [], rules: [], ruleSlots: 4, skillIds: ['skill.a', 'skill.b'], links: [], bloodPactCost: 0,
    },
    mods,
  })
  const modOf = (
    kind: CompiledMod['kind'],
    extra: Partial<CompiledMod> = {},
  ): CompiledMod => ({
    source: { proto: `mod.${kind}`, at: 0, params: {} },
    kind,
    targetIndex: 0,
    ...extra,
  })

  const noLayout = groupPlanOf(segOf([modOf('split', { count: 3 })]))
  const withLayout = groupPlanOf(segOf([
    modOf('split', { count: 3 }),
    modOf('layout', {
      layout: { mode: 'ring', radius: 2, startAngle: 0, even: true, spread: 60, mirrorAngle: 0 , carrierFlies: true },
    }),
  ]))
  eq('⚠⚠ 不带排布：份数列表 3 项', noLayout?.skillIndices.length, 3)
  eq('⚠⚠ 带排布：份数列表**还是 3 项**（排布不管份数）',
    withLayout?.skillIndices.length, 3)
  ok('  而且两个列表**逐位相同**',
    JSON.stringify(noLayout?.skillIndices) === JSON.stringify(withLayout?.skillIndices),
    `${JSON.stringify(noLayout?.skillIndices)} vs ${JSON.stringify(withLayout?.skillIndices)}`)

  /*
   * ---- ② 只有 1 份时什么都不做 ----
   *     ⚠ 待裁定项（日志 53 报告第 6 节 a）：规格说"把**已经存在的那几份**分布在周围"，
   *       1 份没有"分布"可言 —— 所以这里返回**全空的计划**（不改任何一份）。
   */
  const one = layoutPlanOf(segOf([
    modOf('layout', { layout: { mode: 'ring', radius: 4, startAngle: 0, even: true, spread: 60, mirrorAngle: 0 , carrierFlies: true } }),
  ]), { kind: 'direction', dir: { x: 0, y: 1 } }, 1, { x: 0, y: 0 })
  eq('1 份 → 计划只有 1 项', one.length, 1)
  ok('  而那 1 项**什么都不改**（没有落点、没有朝向）',
    one[0]?.point === undefined && one[0]?.facing === undefined, JSON.stringify(one))

  /*
   * ---- ③ ⚠⚠ **硬界线二：排布不改瞄准** ----
   *
   *   两种摆法各查一遍：`fan` / `mirror` **只给方向**，
   *   一份落点都不给（`point` 是"改瞄准"的唯一出口）。
   */
  const two = 2
  const fanPlan = layoutPlanOf(segOf([
    modOf('layout', { layout: { mode: 'fan', radius: 6, startAngle: 0, even: true, spread: 90, mirrorAngle: 0 , carrierFlies: true } }),
  ]), { kind: 'direction', dir: { x: 0, y: 1 } }, two, { x: 0, y: 0 })
  eq('扇形：计划 2 项', fanPlan.length, 2)
  ok('⚠ 扇形**一份落点都不给**（不改瞄准：只动方向）',
    fanPlan.every(p => p.point === undefined), JSON.stringify(fanPlan))

  const mirrorPlan = layoutPlanOf(segOf([
    modOf('layout', { layout: { mode: 'mirror', radius: 6, startAngle: 0, even: true, spread: 60, mirrorAngle: 0 , carrierFlies: true } }),
  ]), { kind: 'direction', dir: { x: 0, y: 1 } }, two, { x: 0, y: 0 })
  ok('⚠ 镜像**一份落点都不给**（它只把方向转过去）',
    mirrorPlan.every(p => p.point === undefined), JSON.stringify(mirrorPlan))
  ok('  第 1 份照原样（就是那个意图的方向）、第 2 份正好转 180°',
    Math.abs((mirrorPlan[0]?.facing?.x ?? 9) - 0) < 1e-9
    && Math.abs((mirrorPlan[0]?.facing?.y ?? 9) - 1) < 1e-9
    && Math.abs((mirrorPlan[1]?.facing?.x ?? 9) - 0) < 1e-9
    && Math.abs((mirrorPlan[1]?.facing?.y ?? 9) + 1) < 1e-9,
    JSON.stringify(mirrorPlan))

  /*
   * ---- ④ 环绕：份数 / 半径 / 起始角 / 是否均匀 ----
   *     ⚠ 断言用**极坐标事实**（半径 + 相对基准方向的方位），不是常数坐标。
   */
  const ringPlan = (members: number, radius: number, startAngle: number, even = true) =>
    layoutPlanOf(segOf([
      modOf('layout', { layout: { mode: 'ring', radius, startAngle, even, spread: 60, mirrorAngle: 0 , carrierFlies: true } }),
    ]), { kind: 'direction', dir: { x: 0, y: 1 } }, members, { x: 0, y: 0 })

  const r3 = ringPlan(3, 2, 0)
  eq('环绕：3 份 → 3 项', r3.length, 3)
  const degOf = (p: { x: number, y: number }): number =>
    Math.round(((Math.atan2(p.y, p.x) * 180) / Math.PI - 90 + 360) % 360)
  const ringDirs = r3.map(p => degOf(p.point ?? { x: 1, y: 0 })).sort((a, b) => a - b)
  ok('  方位是 0° / 120° / 240°（相对瞄准方向均分）',
    ringDirs[0] === 0 && Math.abs((ringDirs[1] ?? 0) - 120) <= 1 && Math.abs((ringDirs[2] ?? 0) - 240) <= 1,
    ringDirs.join(' / '))
  const ringLens = r3.map(p => {
    const q = p.point ?? { x: 0, y: 0 }
    return Math.round(Math.sqrt(q.x * q.x + q.y * q.y) * 1000) / 1000
  })
  ok('  每一份离施法者的距离都等于半径 2 米',
    ringLens.every(v => Math.abs(v - 2) <= 1e-6), ringLens.join(' / '))

  const r4 = ringPlan(4, 3, 0)
  const r4d = r4.map(p => degOf(p.point ?? { x: 1, y: 0 })).sort((a, b) => a - b)
  ok('  4 份 → 间隔变成 90°（份数变了，摆法跟着变）',
    r4d[1] === 90 && r4d[2] === 180, r4d.join(' / '))

  const r3start = ringPlan(3, 2, 90)
  const r3sd = r3start.map(p => degOf(p.point ?? { x: 1, y: 0 })).sort((a, b) => a - b)
  ok('  起始角 90 → 整圈被转过 90°（90 / 210 / 330）',
    r3sd[0] === 90 && Math.abs((r3sd[1] ?? 0) - 210) <= 1, r3sd.join(' / '))

  const r3uneven = ringPlan(3, 2, 0, false)
  ok('  关掉"均匀分布" → 三份全在 0°（同一束，不是随机散开）',
    r3uneven.every(p => degOf(p.point ?? { x: 1, y: 0 }) === 0),
    r3uneven.map(p => degOf(p.point ?? { x: 1, y: 0 })).join(' / '))

  /*
   * ---- ⑤ 意图是 `point`（点地面）时：**落点那半边一个字都不动** ----
   *     玩家那句话的机械表述："它不许改瞄准"。
   *     ⚠ 这里查的是**代理函数**（`placementOptionsOf`）的输出：
   *       方向换掉了，而 `x` / `y` 逐位不变。
   */
  const pointIntent = { kind: 'point', x: 7, y: -3, dir: { x: 0, y: 1 } } as const
  const fanOpts = placementOptionsOf({ intent: pointIntent }, fanPlan[1] ?? {})
  const fanDir = fanOpts.intent?.kind === 'point' ? fanOpts.intent.dir : undefined
  const fanDeg = fanDir === undefined ? 999 : Math.round((Math.atan2(fanDir.y, fanDir.x) * 180) / Math.PI)
  ok('意图是 point 时：方向被转过去了（第 2 份 = 基准 +45° ⇒ 绝对朝向 135°）',
    fanDeg === 135, String(fanDeg))
  ok('⚠ 而落点 x / y **逐位不变**（7 / -3）',
    fanOpts.intent?.kind === 'point' && fanOpts.intent.x === 7 && fanOpts.intent.y === -3,
    JSON.stringify(fanOpts.intent))
  ok('  而且它**没有**给 aimPoint（散射不改落点）', fanOpts.aimPoint === undefined)

  /*
   * ---- ⑥ 环绕给的落点是"绕**施法者**那一圈"，圆心不是瞄准点 ----
   *     ⚠ 用别的圆心（比如解算出来的落点）会让"点地面技能"把自己
   *       摆在**目标点**周围 —— 那不是"分布在施法者周围"。
   */
  const ringFrom = layoutPlanOf(segOf([
    modOf('layout', { layout: { mode: 'ring', radius: 2, startAngle: 0, even: true, spread: 60, mirrorAngle: 0 , carrierFlies: true } }),
  ]), { kind: 'point', x: 100, y: 100, dir: { x: 0, y: 1 } }, 2, { x: 5, y: 5 })
  const p0 = ringFrom[0]?.point ?? { x: 0, y: 0 }
  ok('  圆心是**施法者**（5, 5）：第 1 份在 (5, 7) 而不是在瞄准点 (100, 100) 附近',
    Math.abs(p0.x - 5) <= 1e-6 && Math.abs(p0.y - 7) <= 1e-6, `${String(p0.x)} , ${String(p0.y)}`)

  /*
   * ---- ⑦ 摆法认不出来 ⇒ 计划**什么都不改**（引擎不猜）----
   */
  const unknown = layoutPlanOf(segOf([
    modOf('layout', { layout: undefined }),
  ]), { kind: 'direction', dir: { x: 0, y: 1 } }, 3, { x: 0, y: 0 })
  ok('没有 layout（摆法认不出）→ 3 项计划全都是空的',
    unknown.length === 3 && unknown.every(p => p.point === undefined && p.facing === undefined),
    JSON.stringify(unknown))
}

section('触发器 / 监测器：条件不能空、也不能缺（2026-09-30 日志 54）')

{
  /*
   * ⚠⚠ **背景**：出厂零件「应声触发」原来写着 `"condition": {}`，而求值器按 `type`
   *   分派（`sim/conditions.ts`），`{}` 落到 `switch` 的 `default: return false`
   *   ⇒ **恒不成立** ⇒ 那个零件**永不触发**，而且**一声不吭**
   *   （既没有 `modifierTriggered` 也没有 `modifierBlocked`）——
   *   出厂零件**自己就是坏的**，直到日志 54 才查出来。
   *
   * ⚠ 玩家两轮裁定之后的定稿口径：
   *   · 触发器的**默认条件**是『**载体（前一个魔法）消失**』（Noita 那种**引信**），
   *     而它要的时机（`onExpire` / `onRemoved`）**引擎今天没接线**；
   *   · ⇒ **没有可用的默认值** ⇒ 今天**要用这个零件就得自己写一个真的条件**；
   *   · 于是三条判据：**显式空对象报错** / **副本和原型都没有条件也报错** /
   *     **原型上有条件、副本省略 → 合法**（引擎的参数读法是"副本优先、原型兜底"）。
   *   ⚠ 最后那一条是「背水」（`tech.last-stand` 的 `mod.monitor.low-hp` + `params: {}`）
   *     活到今天的原因，所以它必须在测试里钉住 —— 不然一条"太严"的判据会把内容判死。
   */
  const libT = loadLibrary(balance)
  const tOpts = {
    balance,
    skills: libT.skills,
    statuses: libT.statuses,
    entities: libT.entities,
    techniques: libT.techniques,
    modifierProtos: libT.modifiers,
  }
  const codesT = (t: Technique): string[] =>
    validateTechnique('(测试)', t, tOpts).issues.map(i => i.code)

  /** 一门带一个触发器副本的探针术式 */
  const trig = (id: string, params: Record<string, unknown>): Technique => ({
    schemaVersion: 1, id, name: id, kind: 'magic', activation: 'press',
    sequences: [{
      name: '一段',
      skills: ['skill.magic-bolt'],
      mods: [{ proto: 'mod.trigger.on-cast', at: 0, params }],
    }],
  })

  // ---- ① 显式空条件对象 → 报错 ----
  const empty = codesT(trig('t.trig-empty', { condition: {} }))
  ok('副本写 `condition: {}` → 报 MODIFIER_EMPTY_CONDITION（恒不成立，不是"无条件"）',
    empty.includes('MODIFIER_EMPTY_CONDITION'), empty.join(' '))

  // ---- ② 副本不写、原型也没有 → **合法**（不写 = 「载体消失」，日志 55 起真的会触发）----
  /*
   * ⚠⚠ 这一条**在日志 55 反过来了**。
   *
   *   日志 54 时它必须报 `MODIFIER_CONDITION_REQUIRED`：玩家点名的默认值
   *   「**载体（前一个技能）消失**」要 `onExpire` / `onRemoved` 那一档，
   *   而引擎**没接线** ⇒ 不写条件就是"永不触发"（最危险的一类静默）。
   *
   *   日志 55 把那一档接上了（`trigger.ts` 的 `sweepCarriersGone` +
   *   `world.ts` 第 11b 步）⇒ **"不写"有真实语义了**：
   *     不写 `condition` ⇒ 这次驱动它的是「**载体没了**」；
   *     写了（哪怕写的是 `{}`）⇒ 在它自己那个 `when` 上求值。
   *   ⇒ 判据只剩 ①（显式 `{}`），见上一条。
   */
  const missing = codesT(trig('t.trig-missing', { origin: 'caster' }))
  ok('副本和原型都没有条件 → **合法**（不写 = 「载体消失」这条默认值）',
    !missing.includes('MODIFIER_CONDITION_REQUIRED') && !missing.includes('MODIFIER_EMPTY_CONDITION'),
    missing.join(' '))

  // ---- ③ 写了真条件 → 照常（不报）----
  const real = codesT(trig('t.trig-real',
    { origin: 'caster', condition: { type: 'hpBelow', who: 'self', value: 1 } }))
  ok('写了真的条件 → 一条都不报',
    !real.includes('MODIFIER_EMPTY_CONDITION') && !real.includes('MODIFIER_CONDITION_REQUIRED'),
    real.join(' '))

  // ---- ④ 副本省略、**原型上有** → 合法（「背水」那条路，别被新判据判死）----
  const byProto = codesT({
    schemaVersion: 1, id: 't.monitor-by-proto', name: 't.monitor-by-proto', kind: 'magic', activation: 'press',
    sequences: [{
      name: '一段',
      skills: ['skill.magic-bolt'],
      mods: [{ proto: 'mod.monitor.low-hp', at: 0, params: {} }],
    }],
  })
  ok('副本不写、但原型的 `params.condition` 是真的 → 合法（"副本优先、原型兜底"）',
    !byProto.includes('MODIFIER_CONDITION_REQUIRED') && !byProto.includes('MODIFIER_EMPTY_CONDITION'),
    byProto.join(' '))

  // ---- ⑤ 原型那一层：`params.condition = {}` 也要拦 ----
  const waitProtoT = libT.modifiers.get('mod.trigger.on-cast')
  if (waitProtoT === undefined) throw new Error('内容里没有 mod.trigger.on-cast')
  const badProto = validateModifierProto({
    ...waitProtoT,
    params: { ...(waitProtoT.params ?? {}), condition: {} },
  })
  ok('原型 `params.condition = {}` → 报 MODIFIER_EMPTY_CONDITION（出厂零件原来就是这么坏的）',
    badProto.some(i => i.code === 'MODIFIER_EMPTY_CONDITION'), badProto.map(i => i.code).join(' '))
  const goodProto = validateModifierProto({
    ...waitProtoT,
    params: { ...(waitProtoT.params ?? {}), condition: { type: 'hpBelow', who: 'self', value: 1 } },
  })
  ok('  原型写一个真的条件 → 不报', goodProto.length === 0, goodProto.map(i => i.code).join(' '))

  /*
   * ---- ⑥ `onRemoved`：**故意没接线，而且必须出声**（2026-09-30 日志 55，上级裁定）----
   *
   * ⚠⚠ 这一条测的是**一条纪律**，不是一条语法：
   *   "写上去不生效"必须**变成一句人话**，不许静默。
   *
   *   背景：`onExpire` 和 `onRemoved` 在语义上都是"载体消失那一刻"，
   *   而引擎里只有 `sweepCarriersGone` 那一处发现它，那处**分不出**
   *   "自然到期"和"被打掉" ⇒ 有一条路可挑：
   *     (a) 真把它接上（要先把 `reason` 一路记进台账 —— 另立一片）；
   *     (b) **从"已接线"那张表里拿掉它** ⇒ 校验器给警告，警告里指路 `onExpire`。
   *   这一片走的是 **(b)**（小、而且**诚实**）。
   *
   *   ⚠ 反面就是这一整轮在清的那类：让它留在"已接线"表里 ⇒
   *     **写上去不生效、而且校验器一声不吭**（最难查的一种）。
   */
  const removed = codesT(trig('t.trig-removed', { when: 'onRemoved', origin: 'caster' }))
  ok('⚠ 写 `when: onRemoved` → **报** MODIFIER_TRIGGER_NOT_WIRED（不许静默）',
    removed.includes('MODIFIER_TRIGGER_NOT_WIRED'), removed.join(' '))

  const removedIssue = validateTechnique('(测试)',
    trig('t.trig-removed2', { when: 'onRemoved', origin: 'caster' }), tOpts)
    .issues.find(i => i.code === 'MODIFIER_TRIGGER_NOT_WIRED')
  ok('  而且那句话里**直接指路** `onExpire`（作者不用去翻源码）',
    removedIssue !== undefined
    && `${removedIssue.message}${removedIssue.hint ?? ''}`.includes('onExpire'),
    JSON.stringify(removedIssue === undefined
      ? undefined
      : { m: removedIssue.message, h: removedIssue.hint }))

  const onExpireOk = codesT(trig('t.trig-expire', { when: 'onExpire', origin: 'caster' }))
  ok('  对照组：写 `onExpire`（今天真的接线那一档）→ 不报这条',
    !onExpireOk.includes('MODIFIER_TRIGGER_NOT_WIRED'), onExpireOk.join(' '))

  /*
   * ---- ⑥ `if: [{}]`（规则 / 连接 / 序列门）也是同一个坑 ----
   *
   * ⚠ 它和 `condition` 是**两套写法、同一个求值器**：`evaluateAll([{}])` 同样恒假
   *   ⇒ 那道门**永远不通过**（表现是"后面那个技能一辈子不放"），而它读起来像"我没写条件"。
   *   ⚠ 而 **`if: []` / 不写 `if`** 是**合法**的（= 没有门）—— 这两条对照必须有，
   *     否则一条"见空就报"的判据会把正常内容判死。
   */
  const skillWith = (cond: unknown[]): Skill => ({
    schemaVersion: 1, id: 'skill.t-cond', name: 't-cond',
    phases: [{ id: 'cast', duration: 0.2, occupiesCaster: false, interrupt: 'damage', cancellable: false }],
    rules: [{ id: 'r1', when: 'onTick', order: 0, if: cond as never, then: [] }],
    ruleSlots: 8,
    targeting: { mode: 'directional', valid: ['enemy'] },
  })
  const ruleBad = validateSkill('(测试)', skillWith([{}]), balance).issues.map(i => i.code)
  ok('规则 `if: [{}]` → 报 EMPTY_CONDITION', ruleBad.includes('EMPTY_CONDITION'), ruleBad.join(' '))
  const ruleEmpty = validateSkill('(测试)', skillWith([]), balance).issues.map(i => i.code)
  ok('  `if: []`（= 没有门）→ 不报',
    !ruleEmpty.includes('EMPTY_CONDITION'), ruleEmpty.join(' '))

  const linkBad = codesT({
    schemaVersion: 1, id: 't.link-empty-cond', name: 't.link-empty-cond', kind: 'magic', activation: 'press',
    skills: ['skill.magic-bolt', 'skill.hunt'],
    links: [{ if: [{}] as never }],
  })
  ok('技能之间的连接 `if: [{}]` → 报 EMPTY_CONDITION',
    linkBad.includes('EMPTY_CONDITION'), linkBad.join(' '))

  const seqBad = codesT({
    schemaVersion: 1, id: 't.seq-empty-cond', name: 't.seq-empty-cond', kind: 'magic', activation: 'press',
    sequences: [{ name: '一段', skills: ['skill.magic-bolt'] }, { name: '二段', skills: ['skill.hunt'] }],
    sequenceLinks: [{ if: [{}] as never }],
  })
  ok('序列之间的门 `if: [{}]` → 报 EMPTY_CONDITION',
    seqBad.includes('EMPTY_CONDITION'), seqBad.join(' '))
}

console.log('')
if (failed > 0) {
  console.log(`✗ ${failed} 个断言失败（${passed} 个通过）`)
  process.exitCode = 1
} else {
  console.log(`✓ 全部 ${passed} 个断言通过`)
}
