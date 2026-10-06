/**
 * 生成的说明（`src/describe.ts`）的测试。
 *
 * 玩家原话：**「『命中时回复 8 点生命』，在调整数值之后这个 8 应该改变，但它没有。」**
 *
 * 根因和"点数手写在 JSON 上"是同一个：**说明也是手写的，所以会和数值脱节。**
 * 现在的规矩一样：说明是内容的函数。这个文件把那条规矩钉死。
 *
 * ⚠ 第二类是**id 不能漏到界面上**（玩家 2026-09-21 点名的那一批）：
 *   > 也不要有「捅中的人被挑飞出去 · #0 · 值」这种白话…
 *
 *   `status.shield`、`entity.skeleton`、`char.bloodPact.current`、`pipeline.cancelled`
 *   这些都是**存进 JSON 的值**，不是给人看的字。看得懂的前提是有人把它们翻成人话 ——
 *   下面那一段就是钉"翻了没有"。
 */
import {
  describeActions, describeCondition, describeDelivery, describePayload,
  describeRule, describeStatus, describeStatusTip, describeValue, describeWhen,
} from '../src/describe.ts'
import type { DescribeNames } from '../src/describe.ts'
import type { Action, Phase, Rule, Skill, StatusDef } from '../src/schema.ts'

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

function eq(name: string, actual: unknown, expected: unknown): void {
  ok(name, actual === expected, `实际「${String(actual)}」，期望「${String(expected)}」`)
}

function section(title: string): void {
  console.log(`\n${title}`)
}

let seq = 0
function rule(when: Rule['when'], then: Rule['then'], over: Partial<Rule> = {}): Rule {
  seq++
  return { id: `r${seq}`, when, then, order: seq, ...over }
}

function heal(n: number, target?: 'self' | 'hit'): Action {
  const a: Action = { payload: { kind: 'heal', amount: { const: n } } }
  if (target !== undefined) a.target = target
  return a
}

function status(id: string, over: Partial<StatusDef> = {}): StatusDef {
  return { id, name: id, tags: ['debuff'], duration: 3, ...over }
}

// ============================================================================
//  这条是玩家报的 bug
// ============================================================================

section('改数值，说明必须跟着变')

{
  const r = rule('onHit', [heal(8, 'self')])
  eq('8 点就是 8 点', describeRule(r), '命中时 回复 8 点生命（自己）')

  // 玩家在编辑器里把 8 拖成 20 —— 那句话必须变成 20
  const then = r.then
  if (then?.[0]?.payload.kind === 'heal' && then[0].payload.amount !== undefined) {
    then[0].payload.amount.const = 20
  }
  eq('拖成 20，说明就是 20', describeRule(r), '命中时 回复 20 点生命（自己）')

  // 再改一次，还是跟着走
  if (then?.[0]?.payload.kind === 'heal' && then[0].payload.amount !== undefined) {
    then[0].payload.amount.const = 5
  }
  eq('再拖成 5，说明就是 5', describeRule(r), '命中时 回复 5 点生命（自己）')
}

// ============================================================================
//  时机
// ============================================================================

section('触发时机')

{
  eq('命中', describeWhen(rule('onHit', [heal(1)]), undefined), '命中时')
  eq('施放', describeWhen(rule('onCast', [heal(1)]), undefined), '施放时')
  eq('被打', describeWhen(rule('onDamaged', [heal(1)]), undefined), '被打时')
  eq('致命伤', describeWhen(rule('onLethalDamage', [heal(1)]), undefined), '受到致命伤时')

  const tick = rule('onTick', [heal(1)], { every: 0.5 })
  eq('周期带间隔', describeWhen(tick, undefined), '每 0.5 秒')
  eq('周期不写 every 时按每秒', describeWhen(rule('onTick', [heal(1)]), undefined), '每秒')

  // 阶段 id 要换成**名字**：玩家不认识 `swing`
  const atPhase = rule('phaseComplete', [heal(1)], { phaseId: 'swing' })
  /*
   * ⚠ 阶段名**不加书名号**了（玩家 2026-09-21：「不要故弄玄虚的名字」）。
   *   内容里的阶段名现在就是 前摇 / 命中 / 后摇 这种平实词，
   *   直接接在后面读着通顺：「前摇结束 造成 30 点物理伤害」。
   */
  eq('阶段结束时用阶段名', describeWhen(atPhase, '前摇'), '前摇结束')
  eq('「命中」那一段特殊处理（"命中结束"是病句）', describeWhen(atPhase, '命中'), '命中时')
  eq('没有阶段名时不留半个句子', describeWhen(atPhase, undefined), '结束')
}

// ============================================================================
//  载荷
// ============================================================================

section('载荷')

{
  const dmg: Action = { payload: { kind: 'damage', amount: { const: 30 }, damageType: 'physical' } }
  eq('伤害', describePayload(dmg.payload), '造成 30 点物理伤害')

  const lethal: Action = { payload: { kind: 'damage', amount: { const: 1 }, mode: 'lethal' } }
  eq('必杀', describePayload(lethal.payload), '造成必杀伤害（无视生命值）')

  const energy: Action = {
    payload: { kind: 'attribute', path: 'char.energy.current', op: 'add', value: { const: -15 } },
  }
  eq('扣能量说"消耗"而不是"-15"', describePayload(energy.payload), '消耗 15 能量')

  const gain: Action = {
    payload: { kind: 'attribute', path: 'char.energy.current', op: 'add', value: { const: 15 } },
  }
  eq('回能量说"回复"', describePayload(gain.payload), '回复 15 能量')

  const reset: Action = {
    payload: { kind: 'attribute', path: 'skill.cooldown', op: 'reset', value: { const: 0 } },
  }
  eq('重置冷却', describePayload(reset.payload), '重置冷却')

  const apply = status('status.sunder', { name: '破甲' })
  const st: Action = { payload: { kind: 'status', verb: 'apply', inline: apply } }
  eq('挂状态带名字和时长', describePayload(st.payload), '挂上「破甲」，持续 3 秒')
}

{
  // 动态数值要说清楚它**跟什么走**，还要把范围写出来
  const curved = describeValue({
    ref: 'charge',
    curve: [[0, 20], [3, 150]],
  })
  /*
   * ⚠ 曲线报成**范围**（"蓄力量 20~150"），不再把坐标点念出来
   *   （原来是 `蓄力量（0→20，3→150）`）——
   *   那是给人读的句子，不是让人去解析坐标。
   */
  ok('曲线说成范围', curved.includes('蓄力量') && curved.includes('20') && curved.includes('150'), curved)
  ok('  不再念坐标点', !curved.includes('→'), curved)

  const ranged = describeValue({ ref: 'distance', min: 0, max: 6 })
  ok('区间会被写出来', ranged.includes('距离') && ranged.includes('0~6'), ranged)
}

// ============================================================================
//  载体
// ============================================================================

section('载体')

{
  eq('飞弹带参数', describeDelivery({ kind: 'projectile', speed: 12, lifetime: 1.5 }),
    '发射飞弹（飞 12 米/秒，最多飞 1.5 秒）')
  eq('扇形带半径和张角', describeDelivery({ kind: 'meleeArc', radius: 2.5, angle: 120 }),
    '近身扇形（2.5 米，120°）')
  eq('光束带长度', describeDelivery({ kind: 'beam', length: 8, width: 0.6 }), '光束（8 米长，0.6 米宽）')
  eq('没参数就不写括号', describeDelivery({ kind: 'area' }), '指定区域')
}

// ============================================================================
//  条件与状态
// ============================================================================

section('条件')

{
  eq('带状态',
    describeCondition({ type: 'hasStatus', who: 'self', value: 'status.lava-armor' }),
    '自己身上有「status.lava-armor」')
  // ⚠ 阈值放在 range[0]，不是 value —— 引擎就是这么读的
  eq('层数阈值',
    describeCondition({ type: 'stackAtLeast', who: 'target', value: 'status.burn', range: [3, 3] }),
    '目标的「status.burn」至少 3 层')
  // 血量写成 0~1 的比例，但要说成百分比
  eq('血量百分比',
    describeCondition({ type: 'hpBelow', who: 'self', value: 0.3 }),
    '自己血量低于 30%')
  eq('取反',
    describeCondition({ type: 'not', of: [{ type: 'hasTag', who: 'target', value: 'undead' }] }),
    '不满足（目标带标签「undead」）')
}

{
  const armor = status('status.armor', {
    name: '熔岩护甲',
    tags: ['buff'],
    duration: 10,
    modifiers: [
      { path: 'char.speed', op: 'mul', value: { const: 0.8 } },
      { path: 'char.damageTaken', op: 'mul', value: { const: 1.15 } },
    ],
  })
  const text = describeStatus(armor)
  ok('倍率写成人话（-20%），不是 0.8', text.includes('移速 -20%'), text)
  ok('受伤倍率没写反', text.includes('受伤 +15%'), text)

  const frozen = status('status.freeze', {
    name: '冻结', tags: ['hardCC'], duration: 2,
    disables: ['move', 'attack', 'cast'],
  })
  ok('禁用能力说成"不能移动/攻击/施法"',
    describeStatus(frozen).includes('不能移动/攻击/施法'), describeStatus(frozen))

  const forever = status('status.permanent', { name: '永久', duration: -1 })
  ok('永久状态不写秒数', describeStatus(forever).includes('永久'), describeStatus(forever))
}

/*
 * ---- 状态的一行说明（HUD 上鼠标移上去看的那种）----
 *
 * ⚠ 玩家 2026-09-21 记的待办：
 *   > "司命负重"这种状态应该有鼠标移动到其上显示说明的功能。
 *
 *   说明必须是**生成的** —— "移速 -20%、持续 10 秒"这种话，数值一改就得跟着变。
 */
{
  const burden = status('status.named-blade.burden', {
    name: '司命·负重',
    tags: ['debuff'],
    duration: 10,
    modifiers: [{ path: 'char.hp.max', op: 'mul', value: { const: 0.85 } }],
  })
  const tip = describeStatusTip(burden)
  ok('说明里有名字、有效果、有持续', 
    tip.includes('司命·负重') && tip.includes('生命上限') && tip.includes('最长 10 秒'), tip)
  ok('  而且效果是从数值算的（改数值它自己变）',
    describeStatusTip({ ...burden, modifiers: [{ path: 'char.hp.max', op: 'mul', value: { const: 0.5 } }] })
      !== tip)

  const plain = status('status.plain', { name: '无修饰', tags: [], duration: -1 })
  ok('什么都不改的状态也给一句人话（不吐空串）',
    describeStatusTip(plain).includes('无修饰') && describeStatusTip(plain).includes('一直挂着'),
    describeStatusTip(plain))
}

// ============================================================================
//  一整条规则
// ============================================================================

section('一整条规则')

{
  const phase: Phase = {
    id: 'swing', name: '命中', duration: 0.2,
    occupiesCaster: false, interrupt: 'damage', cancellable: false,
  }
  const r = rule('phaseComplete', [
    { delivery: { kind: 'meleeArc', radius: 2.5, angle: 120 },
      payload: { kind: 'damage', amount: { const: 30 }, damageType: 'physical' } },
  ], { phaseId: phase.id })

  eq('阶段 + 载体 + 数值，一句话说完',
    describeRule(r, phase.name),
    '命中时 近身扇形（2.5 米，120°），造成 30 点物理伤害')
}

{
  // 带条件的规则要把条件写出来 —— 条件不参与定价，
  // 不写的话玩家会以为"只在血少时触发"的效果是白拿的
  const r = rule('onHit', [heal(10, 'self')], {
    if: [{ type: 'hpBelow', who: 'self', value: 0.3 }],
  })
  eq('条件写进括号里', describeRule(r), '命中时（若 自己血量低于 30%）回复 10 点生命（自己）')
}

{
  // 一条规则可以有好几个动作
  const r = rule('onHit', [
    { payload: { kind: 'damage', amount: { const: 20 }, damageType: 'fire' } },
    heal(10, 'self'),
  ])
  eq('多动作用分号隔开', describeRule(r),
    '命中时 造成 20 点火焰伤害；回复 10 点生命（自己）')
}

{
  // 没有动作要说清楚，不能吐一个空字符串
  const r = rule('onHit', [])
  eq('空规则也要有话说', describeActions(r), '（没有动作）')
}

{
  // 伤害类型要翻译
  const fire: Action = { payload: { kind: 'damage', amount: { const: 12 }, damageType: 'shadow' } }
  eq('伤害类型翻译成人话', describePayload(fire.payload), '造成 12 点暗影伤害')

  const custom: Action = { payload: { kind: 'damage', amount: { const: 12 }, damageType: 'weird' } }
  eq('不认识的类型原样输出', describePayload(custom.payload), '造成 12 点weird伤害')
}

// ---------------------------------------------------------------- id 必须翻成人话

console.log('\n说明里不许出现 id / 属性路径（玩家 2026-09-21 点名的那一批）')

{
  /*
   * ⚠ 这一组钉的是"存进 JSON 的值"和"给人看的字"之间的那道翻译。
   *
   *   玩家看到 `挂上「status.shield」`、`生成 entity.skeleton`、
   *   `char.bloodPact.current 3`、`pipeline.cancelled 1` 时，
   *   他的原话是"看得懂吗" —— 看不懂，而且**看着像 bug**。
   */
  const names: DescribeNames = {
    statusName: id => (id === 'status.shield' ? '护盾' : id === 'status.lava-armor' ? '熔岩护甲' : undefined),
    entityName: id => (id === 'entity.skeleton' ? '骷髅兵' : undefined),
  }

  const st: Action = { payload: { kind: 'status', verb: 'apply', statusId: 'status.shield' } }
  eq('状态 id 翻成名字', describePayload(st.payload, names), '挂上「护盾」')

  const rm: Action = { payload: { kind: 'status', verb: 'remove', statusId: 'status.shield' } }
  eq('驱散也说名字', describePayload(rm.payload, names), '移除「护盾」')

  const spawn: Action = { payload: { kind: 'spawn', entityId: 'entity.skeleton', count: 2 } }
  eq('召唤物 id 翻成名字', describePayload(spawn.payload, names), '生成「骷髅兵」 ×2')

  const cond = describeCondition({ type: 'hasStatus', who: 'self', value: 'status.lava-armor' }, names)
  eq('条件里的状态 id 也翻', cond, '自己身上有「熔岩护甲」')

  /*
   * ⚠ 查不到名字时**退回 id**：那时候 id 是唯一能指认它的东西。
   *   退回空串或者"未知状态"会让玩家连"是哪一个"都不知道。
   */
  eq('查不到名字就退回 id（那是唯一能指认它的东西）',
    describePayload({ kind: 'spawn', entityId: 'entity.nope' } as never, names),
    '生成「entity.nope」')

  // ---- 属性路径：血契 / 管线伪属性 ----
  const pact: Action = {
    payload: { kind: 'attribute', path: 'char.bloodPact.current', op: 'add', value: { const: 3 } },
  }
  eq('血契不写属性路径', describePayload(pact.payload), '积攒 3 血契')

  const cancel: Action = {
    payload: { kind: 'attribute', path: 'pipeline.cancelled', op: 'set', value: { const: 1 } },
  }
  ok('管线伪属性翻成人话（不是 pipeline.cancelled）',
    !describePayload(cancel.payload).includes('pipeline.'), describePayload(cancel.payload))

  /*
   * ⚠ 认不出来的属性**也不许打路径原文**。
   *   `char.foo 0.9` 看着像 bug；「某个属性」是明确的"我认不出来"。
   */
  const weird: Action = {
    payload: { kind: 'attribute', path: 'char.weird.thing', op: 'add', value: { const: 1 } },
  }
  ok('认不出来的属性不打路径原文',
    !describePayload(weird.payload).includes('char.'), describePayload(weird.payload))
}

// ---------------------------------------------------------------- 收尾

// Skill 只在类型上用到，这里用一个空的引用避免"未使用"的噪声
void (0 as unknown as Skill)

console.log('')
if (failed > 0) {
  console.log(`✗ ${failed} 个断言失败（${passed} 个通过）`)
  process.exitCode = 1
} else {
  console.log(`✓ 全部 ${passed} 个断言通过`)
  process.exitCode = 0
}
