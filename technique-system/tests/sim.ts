/**
 * 模拟核心的测试。
 *
 * 分四块：
 *   属性系统   —— 积木 A，吃掉过 6 个独立需求，必须先保证它对
 *   状态容器   —— 控制 / 霸体 / 净化 / 隐身全靠它
 *   世界推进   —— 固定 tick 的顺序和边界
 *   确定性     —— 重放、无头批跑、联机同步的前提
 */
import {
  advance, applyStatus, canAct, capabilities, createWorld, despawn, distance,
  findHostile, getStored, hpPercent, nextFloat, removeStatus, resolveAttribute,
  setStored, snapshot, spawn, statusStacks, stepWorld, visibilityOf,
} from '../src/sim/index.ts'
import type { Entity, World } from '../src/sim/index.ts'
import type { StatusDef } from '../src/schema.ts'

// ---------------------------------------------------------------- 迷你测试框架

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
  ok(name, Object.is(actual, expected), `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`)
}

function near(name: string, actual: number, expected: number, eps = 1e-9): void {
  ok(name, Math.abs(actual - expected) < eps, `实际 ${actual}，期望 ${expected}`)
}

function section(title: string): void {
  console.log(`\n${title}`)
}

// ---------------------------------------------------------------- 测试夹具
//
// 用 schema 里的 StatusDef 形状直接写状态，不经过 JSON ——
// 这一步测的是模拟核心，不是加载器。

function status(id: string, over: Partial<StatusDef> = {}): StatusDef {
  return {
    id,
    name: id,
    tags: [],
    duration: 5,
    ...over,
  }
}

const FREEZE = status('status.freeze', {
  tags: ['hardCC', 'debuff'],
  duration: 2,
  disables: ['move', 'attack', 'cast'],
})

const SILENCE = status('status.silence', {
  tags: ['hardCC', 'debuff'],
  duration: 4,
  disables: ['cast'],
})

const SUPER_ARMOR = status('status.superArmor', {
  tags: ['buff'],
  duration: 3,
  immuneTags: ['hardCC'],
})

const STEALTH = status('status.stealth', { tags: ['buff'], duration: 3, visibility: 0 })

const PURGE_ONLY = status('status.soulRend', {
  tags: ['debuff', 'dot'],
  duration: 6,
  removal: { immuneTo: ['heal', 'dispel'], onlyBy: ['tech.purge'], expires: true },
})

const SLOW = status('status.slow', {
  tags: ['softCC', 'debuff'],
  duration: 4,
  modifiers: [{ path: 'char.speed', op: 'mul', value: { const: 0.5 } }],
})

const WEIGHT = status('status.weight', {
  tags: ['debuff'],
  duration: 4,
  modifiers: [{ path: 'char.speed', op: 'add', value: { const: -2 } }],
})

const FRAGILE = status('status.fragile', {
  tags: ['debuff'],
  duration: 4,
  modifiers: [{ path: 'char.hp.max', op: 'mul', value: { const: 0.9 } }],
})

const BURN = status('status.burn', {
  tags: ['debuff', 'dot'],
  duration: 5,
  stack: { max: 5, behavior: 'stack' },
})

const REGEN_BUFF = status('status.regenBuff', {
  tags: ['buff'],
  duration: 3,
  modifiers: [{ path: 'char.energy.regen', op: 'mul', value: { const: 2 } }],
})

const PERMANENT = status('status.curse', { tags: ['debuff'], duration: -1 })

// ---------------------------------------------------------------- 1. 属性系统

section('属性系统')

{
  const w = createWorld()
  const e = spawn(w, { base: { 'char.hp.max': 200, 'char.energy.regen': 12 }, stored: { 'char.hp.current': 200 } })

  eq('基础值直读', resolveAttribute(e, 'char.hp.max'), 200)
  eq('存储属性直读', resolveAttribute(e, 'char.hp.current'), 200)
  eq('没写过的属性是 0', resolveAttribute(e, 'nope'), 0)

  applyStatus(w, e, WEIGHT, 0)
  eq('add 生效', resolveAttribute(e, 'char.speed'), 3) // 默认 5 - 2

  applyStatus(w, e, SLOW, 0)
  eq('add 之后乘算', resolveAttribute(e, 'char.speed'), 1.5) // (5 - 2) * 0.5

  applyStatus(w, e, REGEN_BUFF, 0)
  eq('mul 作用在不同属性上', resolveAttribute(e, 'char.energy.regen'), 24)
}

{
  const w = createWorld()
  const e = spawn(w, { base: { 'char.hp.max': 100 }, stored: { 'char.hp.current': 100 } })

  applyStatus(w, e, FRAGILE, 0)
  eq('状态可以压缩上限', resolveAttribute(e, 'char.hp.max'), 90)

  stepWorld(w)
  eq('上限降下来后当前值被钳制', getStored(e, 'char.hp.current'), 90)
  eq('血量百分比按新上限算', hpPercent(e), 1)
}

{
  const w = createWorld()
  const e = spawn(w, { base: { 'char.hp.max': 100 }, stored: { 'char.hp.current': 50 } })

  const storedMod = status('status.energyDrain', {
    tags: ['debuff'],
    duration: 5,
    modifiers: [{ path: 'char.hp.current', op: 'add', value: { const: -10 } }],
  })

  applyStatus(w, e, storedMod, 0)
  eq(
    '存储属性不吃状态修饰（这是故意的）',
    resolveAttribute(e, 'char.hp.current'),
    50,
  )
  eq(
    '要持续扣血得用 onTick 规则的属性载荷',
    getStored(e, 'char.hp.current'),
    50,
  )
}

{
  const w = createWorld()
  const e = spawn(w, { base: { 'cooldown': 8 } })

  const cdDown = status('status.cdDown', {
    tags: ['buff'],
    duration: 1,
    modifiers: [{ path: 'cooldown', op: 'reset', value: { const: 0 } }],
  })

  applyStatus(w, e, cdDown, 0)
  eq('reset 恢复成基础值（露娜的大招刷新）', resolveAttribute(e, 'cooldown'), 8)
}

// ---------------------------------------------------------------- 2. 状态容器

section('状态容器')

{
  const w = createWorld()
  const e = spawn(w, {})

  applyStatus(w, e, BURN, 0)
  eq('第一次挂上', statusStacks(e, 'status.burn'), 1)

  applyStatus(w, e, BURN, 0)
  eq('stack 行为：层数 +1', statusStacks(e, 'status.burn'), 2)

  for (let i = 0; i < 10; i++) applyStatus(w, e, BURN, 0)
  eq('stack 行为：不超过 stack.max', statusStacks(e, 'status.burn'), 5)
}

{
  const w = createWorld()
  const e = spawn(w, {})

  const REFRESH_ONLY = status('status.mark', {
    tags: ['debuff'],
    duration: 3,
    stack: { max: 3, behavior: 'refresh' },
  })

  applyStatus(w, e, REFRESH_ONLY, 0)
  advance(w, 60) // 1 秒
  const before = e.statuses[0]?.remaining ?? 0
  applyStatus(w, e, REFRESH_ONLY, 0)
  const after = e.statuses[0]?.remaining ?? 0

  ok('refresh 行为：时长被刷回满', after > before, `${before} → ${after}`)
  eq('refresh 行为：层数不变', statusStacks(e, 'status.mark'), 1)
}

{
  const w = createWorld()
  const e = spawn(w, {})

  const INDEP = status('status.zone', {
    tags: ['debuff'],
    duration: 3,
    stack: { max: 9, behavior: 'independent' },
  })

  applyStatus(w, e, INDEP, 0)
  applyStatus(w, e, INDEP, 0)
  eq('independent 行为：挂成两份', e.statuses.length, 2)
  eq('层数合计', statusStacks(e, 'status.zone'), 2)
}

{
  const w = createWorld()
  const e = spawn(w, {})

  applyStatus(w, e, BURN, 0) // 5 秒
  advance(w, 60 * 4) // 4 秒
  eq('还没到期', e.statuses.length, 1)

  advance(w, 60 * 2) // 再 2 秒
  eq('到期被移除', e.statuses.length, 0)
}

{
  const w = createWorld()
  const e = spawn(w, {})

  applyStatus(w, e, PERMANENT, 0)
  advance(w, 60 * 100)
  eq('duration = -1 是永久的', e.statuses.length, 1)
}

section('控制与免疫')

{
  const w = createWorld()
  const e = spawn(w, {})

  eq('默认什么都能做', canAct(e, 'move') && canAct(e, 'cast') && canAct(e, 'attack'), true)

  applyStatus(w, e, FREEZE, 0)
  const c1 = capabilities(e)
  ok('冻结禁掉三个能力', !c1.move && !c1.attack && !c1.cast)
  ok('冻结不影响转向', c1.turn)

  applyStatus(w, e, SILENCE, 0)
  ok('冻结 + 沉默取并集，不会互相覆盖', !capabilities(e).move)
}

{
  const w = createWorld()
  const e = spawn(w, {})

  applyStatus(w, e, SUPER_ARMOR, 0)
  const applied = applyStatus(w, e, FREEZE, 0)

  eq('霸体挡住控制（按标签匹配）', applied, false)
  eq('控制没挂上', e.statuses.filter(s => s.defId === 'status.freeze').length, 0)

  const applied2 = applyStatus(w, e, SILENCE, 0)
  eq('霸体同样挡住沉默', applied2, false)

  const applied3 = applyStatus(w, e, BURN, 0)
  eq('霸体不挡非控制类的 dot', applied3, true)
}

{
  const w = createWorld()
  const e = spawn(w, {})

  applyStatus(w, e, PURGE_ONLY, 0)

  const byDispel = removeStatus(w, e, 'status.soulRend', { tag: 'dispel' })
  eq('神锋无影的创伤：净化无效', byDispel, 0)
  eq('状态还在', e.statuses.length, 1)

  const byHeal = removeStatus(w, e, 'status.soulRend', { tag: 'heal' })
  eq('治疗也移不掉', byHeal, 0)

  const byOther = removeStatus(w, e, 'status.soulRend', { sourceId: 'tech.fireball' })
  eq('别的技能也不行', byOther, 0)

  const byPurge = removeStatus(w, e, 'status.soulRend', { sourceId: 'tech.purge' })
  eq('只有特定技能能移除', byPurge, 1)
  eq('移除后清空', e.statuses.length, 0)
}

{
  const w = createWorld()
  const e = spawn(w, {})

  eq('默认完全可见', visibilityOf(e), 1)
  applyStatus(w, e, STEALTH, 0)
  eq('隐身把可见性压到 0', visibilityOf(e), 0)
  ok('隐身不等于无敌（用户明确要的设计）', e.alive)
}

// ---------------------------------------------------------------- 3. 世界推进

section('固定 tick 推进')

{
  const w = createWorld({ dt: 1 / 60 })
  const e = spawn(w, { base: { speed: 5 }, vel: { x: 5, y: 0 }, stored: { 'char.hp.current': 100 } })

  advance(w, 60) // 1 秒
  near('1 秒后会走 5 米', e.pos.x, 5, 1e-6)
  eq('tick 计数正确', w.tick, 60)
}

{
  const w = createWorld()
  const e = spawn(w, { base: { 'char.energy.max': 100, 'char.energy.regen': 10 }, stored: { 'char.energy.current': 0 } })

  advance(w, 60)
  near('固定速率回复：1 秒回 10 点', getStored(e, 'char.energy.current'), 10, 1e-6)

  advance(w, 60 * 20)
  eq('到上限就停', getStored(e, 'char.energy.current'), 100)
}

{
  const w = createWorld()
  const e = spawn(w, { lifetime: 0.5 })
  advance(w, 30)
  eq('还没到期', e.alive, true)
  advance(w, 5)
  eq('存在时间到了就消失', e.alive, false)
}

{
  const w = createWorld()
  const e = spawn(w, {})
  despawn(w, e, 'died')
  ok('removed 事件带原因', w.events.some(ev => ev.type === 'removed' && ev.reason === 'died'))
}

section('阵营与目标查询（纪律 1）')

{
  const w = createWorld()
  const me = spawn(w, { faction: 'player', pos: { x: 0, y: 0 } })
  const near_ = spawn(w, { faction: 'enemy', pos: { x: 3, y: 0 } })
  const far = spawn(w, { faction: 'enemy', pos: { x: 9, y: 0 } })
  spawn(w, { faction: 'player', pos: { x: 1, y: 0 } })

  const target = findHostile(w, me)
  eq('找到最近的敌人，不是更近的队友', target?.id, near_.id)

  const limited = findHostile(w, me, { maxDistance: 5 })
  eq('距离限制生效', limited?.id, near_.id)

  const none = findHostile(w, me, { maxDistance: 1 })
  eq('超出距离就没目标', none, undefined)

  // 魅惑：只改一个字段，AI 的行为自动翻转
  near_.faction = 'player'
  const afterCharm = findHostile(w, me)
  eq('改阵营之后（魅惑），目标立刻换成另一个敌人', afterCharm?.id, far.id)
}

// ---------------------------------------------------------------- 4. 确定性

section('确定性（重放 / 无头批跑 / 联机同步的前提）')

function buildScenario(seed: number): World {
  const w = createWorld({ seed })
  const a = spawn(w, { faction: 'player', pos: { x: 0, y: 0 }, vel: { x: 1.3, y: -0.4 } })
  const b = spawn(w, { faction: 'enemy', pos: { x: 7, y: 2 }, vel: { x: -0.9, y: 0.2 } })

  applyStatus(w, a, BURN, 0)
  applyStatus(w, a, SLOW, b.id)
  applyStatus(w, b, FREEZE, a.id)
  applyStatus(w, b, WEIGHT, a.id)
  return w
}

{
  const w1 = buildScenario(12345)
  const w2 = buildScenario(12345)
  advance(w1, 1000)
  advance(w2, 1000)

  const s1 = JSON.stringify(snapshot(w1))
  const s2 = JSON.stringify(snapshot(w2))
  ok('同种子跑 1000 tick，两次快照逐字节一致', s1 === s2,
    s1 === s2 ? undefined : '模拟里有不确定的东西，重放和联机都会出问题')
}

{
  const w1 = buildScenario(1)
  const w2 = buildScenario(2)
  advance(w1, 100)
  advance(w2, 100)
  ok('不同种子结果不同（随机数确实在起作用）',
    JSON.stringify(snapshot(w1)) !== JSON.stringify(snapshot(w2)))
}

{
  const w1 = createWorld({ seed: 42 })
  const w2 = createWorld({ seed: 42 })
  const seq1 = Array.from({ length: 5 }, () => nextFloat(w1))
  const seq2 = Array.from({ length: 5 }, () => nextFloat(w2))
  eq('RNG 同种子序列一致', seq1.join(','), seq2.join(','))

  const inRange = seq1.every(v => v >= 0 && v < 1)
  ok('RNG 输出落在 [0, 1)', inRange, seq1.join(', '))
}

{
  // 边界：实体被移除后，下一 tick 不该再被处理
  const w = createWorld()
  const e = spawn(w, {})
  const id = e.id
  despawn(w, e, 'died')
  stepWorld(w)
  ok('死掉的实体从世界里清掉了', !w.entities.some(x => x.id === id))
  ok('清理不会影响 tick 计数', w.tick === 1)
}

{
  // 距离用 sqrt 而不是 hypot —— hypot 不保证跨引擎一致
  near('平面距离不含 z', distance({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 100 }), 5, 1e-12)
}

// ---------------------------------------------------------------- 汇总

console.log('')
if (failed > 0) {
  console.log(`✗ ${failed} 个断言失败（${passed} 个通过）`)
  process.exitCode = 1
} else {
  console.log(`✓ 全部 ${passed} 个断言通过`)
  process.exitCode = 0
}
