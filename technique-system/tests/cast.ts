/**
 * 阶段机与技能执行的测试。
 *
 * 这里覆盖：多阶段推进、代价时机、打断、蓄力、冷却、能量、
 * onCast / onHit / onMiss / onKill、扇形多目标、有效目标过滤，
 * 以及**技能图作为第三个钩子来源**（名刀司命做成常驻被动）。
 */
import {
  activate, advance, applyStatus, cancelCast, canActivate, cooldownRemaining, createWorld, dealDamage,
  getStored, phaseLocksOf, registerTechnique, releaseCharge, setStored, setTechniqueActive,
  spawn, stepWorld,
} from '../src/sim/index.ts'
import type { Entity, SimEvent, World } from '../src/sim/index.ts'
import type { Phase, Rule, Skill, Technique } from '../src/schema.ts'
import { compileTechnique } from '../src/sim/compile.ts'
import type { CompiledTechnique } from '../src/sim/compile.ts'
import { pricePhase } from '../src/pricing.ts'
import { DEFAULT_RATES } from '../src/pricing.ts'

// ---------------------------------------------------------------- 迷你框架

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

// ---------------------------------------------------------------- 构造工具

function phase(id: string, duration: number, over: Partial<Phase> = {}): Phase {
  return {
    id,
    duration,
    occupiesCaster: false,
    interrupt: 'damage',
    cancellable: false,
    ...over,
  }
}

let ruleSeq = 0
function rule(when: Rule['when'], then: Rule['then'], over: Partial<Rule> = {}): Rule {
  ruleSeq++
  return { id: `r${ruleSeq}`, when, then, order: ruleSeq, ...over }
}

/**
 * 造一个"只有一个技能的术式"，返回**编译产物** —— 引擎只认它。
 *
 * 为什么不直接造 Technique：现在的数据模型分两层，技能才有阶段和规则。
 * 测试里想写的其实是"一个技能"，所以这里顺手包一层术式再编译。
 *
 * ⚠ 编译器会给阶段 id 加 `skillId#` 前缀（两个技能可能都有叫 cast 的阶段）。
 *   测试不用管：规则里的 phaseId 会被一起改写，两边始终对得上，
 *   而且没有任何一条断言去读裸的阶段 id。
 */
function tech(id: string, over: Partial<CompiledTechnique> = {}): CompiledTechnique {
  const { phases, rules, ruleSlots, ...rest } = over
  const skill: Skill = {
    schemaVersion: 1,
    id: `skill.${id}`,
    name: id,
    phases: phases ?? [phase('cast', 0.2)],
    rules: rules ?? [],
    ruleSlots: ruleSlots ?? 8,
    /*
     * ⚠ 瞄准在**技能**上（2026-09-21 日志 47）：术式那个字段删掉了，
     *   所以这里把 `over.targeting` 放到技能上 —— 调用方写的东西一个字没变，
     *   编译出来的 `compiled.targeting` 也还是它（`targetingOfChain` 取第一个）。
     */
    targeting: rest.targeting ?? { mode: 'directional', valid: ['enemy'] },
  }
  const technique: Technique = {
    schemaVersion: 1,
    id,
    name: id,
    // ⚠ 系别必填（schema 的 Technique.kind）：这里造的都是魔法术式
    kind: 'magic',
    activation: rest.activation ?? 'press',
    skills: [skill.id],
  }
  return compileTechnique(technique, k => (k === skill.id ? skill : undefined)).compiled
}

function arena(): { w: World; a: Entity; b: Entity } {
  const w = createWorld({ seed: 5 })
  // 能量回复关掉 —— 测试要算准数字，别让回复掺进来
  const a = spawn(w, {
    faction: 'player',
    pos: { x: 0, y: 0 },
    base: { 'char.hp.max': 200, 'char.energy.max': 100, 'char.energy.regen': 0 },
  })
  const b = spawn(w, { faction: 'enemy', pos: { x: 1.5, y: 0 }, base: { 'char.hp.max': 200 } })
  return { w, a, b }
}

/** 造一个满血 200 的敌人，免得默认 100 让断言数字对不上 */
function enemy(w: World, x: number, y: number, tags: string[] = []): Entity {
  return spawn(w, { faction: 'enemy', pos: { x, y }, base: { 'char.hp.max': 200 }, tags })
}

/**
 * 跑若干 tick 并收集**所有**事件。
 *
 * 注意 stepWorld 每 tick 开始时清空 world.events ——
 * 想看"跑完之后有没有出现过某个事件"，必须自己一路收。
 */
function runCollect(w: World, ticks: number): string[] {
  const seen: string[] = []
  for (let i = 0; i < ticks; i++) {
    stepWorld(w)
    for (const e of w.events) seen.push(e.type)
  }
  return seen
}

const SWING_DAMAGE = {
  delivery: { kind: 'meleeArc' as const, radius: 3, angle: 120 },
  payload: { kind: 'damage' as const, amount: { const: 30 }, damageType: 'physical' },
}

// ---------------------------------------------------------------- 1. 基本

section('基本施法')

{
  const { w, a, b } = arena()
  const CUT = tech('tech.cut', {
    phases: [phase('swing', 0.2)],
    rules: [rule('phaseComplete', [SWING_DAMAGE], { phaseId: 'swing' })],
  })

  const res = activate(w, a, CUT)
  ok('激活成功', res.ok)
  eq('还没打出去', getStored(b, 'char.hp.current'), 200)
  ok('推出了 castStarted 事件', w.events.some(e => e.type === 'castStarted'))

  const ev = runCollect(w, 20)
  eq('前摇走完，伤害落地', getStored(b, 'char.hp.current'), 170)
  eq('施法结束', w.casts.length, 0)
  ok('推出了 castFinished 事件', ev.includes('castFinished'))
}

{
  const { w, a, b } = arena()
  // 三阶段：前摇 → 释放 → 后摇
  const COMBO = tech('tech.combo', {
    phases: [phase('windup', 0.1), phase('release', 0.05), phase('recovery', 0.15)],
    rules: [rule('phaseComplete', [SWING_DAMAGE], { phaseId: 'release' })],
  })

  activate(w, a, COMBO)
  advance(w, 3)
  eq('前摇还没走完，没伤害', getStored(b, 'char.hp.current'), 200)

  advance(w, 10)
  eq('释放阶段走完，伤害落地', getStored(b, 'char.hp.current'), 170)

  eq('后摇还在跑', w.casts.length, 1)
  advance(w, 12)
  eq('后摇走完，施法结束', w.casts.length, 0)
}

// ---------------------------------------------------------------- 2. 代价

section('代价时机')

{
  const { w, a, b } = arena()
  // 故意留一个"空窗期"（sustain），才能证明伤害落地时冷却确实还没进。
  // 如果释放和进冷却挨在一起，两者会落在同一 tick，就分不出来了。
  const COSTLY = tech('tech.costly', {
    phases: [
      phase('windup', 0.1, { cost: { energy: 10 } }),
      phase('release', 0.05),
      phase('sustain', 0.25),
      phase('recovery', 0.1, { cost: { cooldown: 3 } }),
    ],
    rules: [rule('phaseComplete', [SWING_DAMAGE], { phaseId: 'release' })],
  })

  activate(w, a, COSTLY)
  eq('前摇一进入就扣能量（早付）', getStored(a, 'char.energy.current'), 90)
  eq('冷却还没进', cooldownRemaining(a, 'tech.costly'), 0)

  advance(w, 11)
  eq('释放阶段：伤害落地', getStored(b, 'char.hp.current'), 170)
  eq('这时候冷却仍然没进（晚付）', cooldownRemaining(a, 'tech.costly'), 0)

  // ⚠ 要留够余量：命中会产生顿帧，顿帧期间世界不动但 tick 照走，
  //   所以"跑 40 tick"不等于"过了 40 tick 的模拟时间"。
  //   这不是测试写错，是顿帧真的在改变节奏。
  advance(w, 40)
  ok('后摇一进入冷却就进了', cooldownRemaining(a, 'tech.costly') > 2.5)
}

{
  const { w, a } = arena()
  const HP_COST = tech('tech.hpCost', {
    phases: [phase('cast', 0.1, { cost: { hp: 0.5, hpIsPercent: true } })],
  })

  activate(w, a, HP_COST)
  eq('百分比生命代价按上限算', getStored(a, 'char.hp.current'), 100)
}

{
  const { w, a } = arena()
  const SUICIDE = tech('tech.suicide', {
    phases: [phase('cast', 0.1, { cost: { hp: 9999 } })],
  })

  activate(w, a, SUICIDE)
  eq('生命代价能把施法者弄死', a.alive, false)
  eq('施法被中断', w.casts.length, 0)
}

// ---------------------------------------------------------------- 3. 打断

section('打断')

{
  const { w, a, b } = arena()
  const FREEZE = { id: 'status.freeze', name: '冻结', tags: ['hardCC'], duration: 2, disables: ['move', 'attack', 'cast'] as const }

  const SLOW_CAST = tech('tech.slowCast', {
    phases: [phase('windup', 0.5), phase('release', 0.05)],
    rules: [rule('phaseComplete', [SWING_DAMAGE], { phaseId: 'release' })],
  })

  activate(w, a, SLOW_CAST)
  advance(w, 6)
  eq('施法进行中', w.casts.length, 1)

  applyStatus(w, a, FREEZE as never, a.id)
  advance(w, 1)

  eq('沉默/眩晕中断了施法', w.casts.length, 0)
  ok('推出了 castInterrupted 事件', w.events.some(e => e.type === 'castInterrupted'))
  eq('效果没打出去', getStored(b, 'char.hp.current'), 200)

  advance(w, 60)
  eq('打断之后也不会补上伤害', getStored(b, 'char.hp.current'), 200)
}

{
  const { w, a } = arena()
  const REFUND = tech('tech.refund', {
    phases: [phase('windup', 0.5, { cost: { energy: 20 } })],
    rules: [rule('phaseInterrupt', [
      /*
       * ⚠ `target: 'self'` 是**必须写的**（2026-09-30 日志 61 起）：
       *   动作没有目标时**什么都不做**了，不再"算到施法者自己头上"。
       *   退能量打的就是自己，所以这里显式写出来（定稿口径：落点每条动作一处）。
       */
      { target: 'self', payload: { kind: 'attribute', path: 'char.energy.current', op: 'add', value: { const: 20 } } },
    ], { phaseId: 'windup' })],
  })

  activate(w, a, REFUND)
  eq('先扣了 20 能量', getStored(a, 'char.energy.current'), 80)

  applyStatus(w, a, { id: 'status.stun', name: '眩晕', tags: ['hardCC'], duration: 1, disables: ['cast'] } as never, a.id)
  advance(w, 1)

  eq('phaseInterrupt 规则把能量退了', getStored(a, 'char.energy.current'), 100)
}

{
  const { w, a } = arena()
  const UNSTOPPABLE = tech('tech.unstoppable', {
    phases: [phase('windup', 0.3, { interrupt: 'none' })],
    rules: [rule('phaseComplete', [SWING_DAMAGE], { phaseId: 'windup' })],
  })

  activate(w, a, UNSTOPPABLE)
  applyStatus(w, a, { id: 'status.stun2', name: '眩晕', tags: ['hardCC'], duration: 1, disables: ['cast'] } as never, a.id)
  advance(w, 25)

  eq('无法打断的阶段照样走完', w.casts.length, 0)
  ok('伤害打出去了', getStored(a, 'char.hp.current') === 200)
}

// ---------------------------------------------------------------- 3b. 三档打断等级

section('三档打断等级（挨打就断 / 只被控制打断 / 无法打断）')

{
  /*
   * ⚠ 玩家原话：「不应该所有技能都会被伤害打断，应该分成
   *   被伤害打断、被控制打断、无法打断三个等级。」
   *
   *   只有两档的时候，一个"扛得住小伤害、但吃硬控"的释放帧表达不出来 ——
   *   而那恰恰是动作游戏里最常见的那种帧。
   */
  const swing = (level: 'damage' | 'control' | 'none'): ReturnType<typeof tech> => tech(`tech.${level}`, {
    phases: [phase('windup', 0.5, { interrupt: level })],
    rules: [rule('phaseComplete', [SWING_DAMAGE], { phaseId: 'windup' })],
  })

  // ---- 挨一下就断（默认档）----
  {
    const { w, a, b } = arena()
    const t = swing('damage')
    activate(w, a, t)
    eq('挨打就断：施法还在', w.casts.length, 1)

    dealDamage(w, b.id, a.id, 10)
    advance(w, 2)

    eq('挨打就断：施法没了', w.casts.length, 0)
    ok('挨打就断：打出去了 castInterrupted 事件',
      w.events.some(e => e.type === 'castInterrupted'))
  }

  // ---- 扛得住伤害，扛不住硬控 ----
  {
    const { w, a, b } = arena()
    const t = swing('control')
    activate(w, a, t)

    dealDamage(w, b.id, a.id, 10)
    advance(w, 2)

    eq('只被控制打断：挨打不断，施法还在', w.casts.length, 1)

    applyStatus(w, a, { id: 'status.stun3', name: '眩晕', tags: ['hardCC'], duration: 1, disables: ['cast'] } as never, a.id)
    advance(w, 2)

    eq('只被控制打断：硬控一到就断', w.casts.length, 0)
  }

  // ---- 什么都不打断 ----
  {
    const { w, a, b } = arena()
    const t = swing('none')
    activate(w, a, t)

    dealDamage(w, b.id, a.id, 10)
    applyStatus(w, a, { id: 'status.stun4', name: '眩晕', tags: ['hardCC'], duration: 1, disables: ['cast'] } as never, a.id)
    advance(w, 2)

    eq('无法打断：挨打 + 硬控都不打断', w.casts.length, 1)

    advance(w, 30)
    eq('而且它照样走完了', w.casts.length, 0)
  }
}

{
  // 三档的收益必须是单调的：越扛得住越值钱（消耗越多额度）
  const mk = (level: 'damage' | 'control' | 'none'): number =>
    pricePhase(phase('p', 0.5, { interrupt: level }), DEFAULT_RATES)

  const d = mk('damage')
  const c = mk('control')
  const n = mk('none')

  ok('挨打就断 < 只被控制打断 < 无法打断（点数单调下降）', d > c && c > n,
    `damage=${d} control=${c} none=${n}`)
  ok('"只被控制打断"的收益正好是一半',
    Math.abs((d - c) - (c - n)) < 1e-9, `damage→control ${d - c}，control→none ${c - n}`)
}

// ---------------------------------------------------------------- 3c. 载体事件

section('载体打出去了（deliveryFired）')

/**
 * 边跑边收事件。
 *
 * ⚠ `stepWorld` **每个 tick 都会清空 `world.events`** —— 直接 `advance` 之后
 *   再看，只能看到最后一个 tick 的事件。想断言"某一刻发生过什么"就必须边跑边收。
 *   （这个坑第一次写这批断言时踩了：伤害明明落地了，事件却是空的。）
 */
function runCollecting(w: World, ticks: number): SimEvent[] {
  const out: SimEvent[] = []
  for (let i = 0; i < ticks; i++) {
    stepWorld(w)
    out.push(...w.events)
  }
  return out
}

{
  /*
   * ⚠ 玩家报的："贯日没有技能特效"。
   *
   *   查下来是一整类问题：**15 种事件全是"结果"，没有"过程"** ——
   *   客户端只能从 damaged 反推是谁打的，所以**打空了什么都没有**，
   *   而打空恰恰是最需要看得见的时刻。
   *
   *   这条事件带的是**几何**（起点 / 方向 / 长度 / 宽度 / 角度 / 打中几个），
   *   和 damaged 带一个 amount 是同一类东西。
   */
  const { w, a } = arena()

  const ARC = tech('tech.arc', {
    phases: [phase('cast', 0.1)],
    rules: [rule('phaseComplete', [{
      delivery: { kind: 'meleeArc', radius: 2.5, angle: 120 },
      payload: { kind: 'damage', amount: { const: 30 }, damageType: 'physical' },
    }], { phaseId: 'cast' })],
  })

  activate(w, a, ARC)
  const events = runCollecting(w, 20)

  const fired = events.find(e => e.type === 'deliveryFired')
  ok('扇形挥砍推出了 deliveryFired', fired !== undefined)
  if (fired !== undefined && fired.type === 'deliveryFired') {
    eq('带上了载体类型', fired.kind, 'meleeArc')
    eq('带上了施法者', fired.casterId, a.id)
    eq('带上了半径', fired.radius, 2.5)
    eq('带上了张角', fired.angle, 120)
    eq('带上了伤害类型（客户端按它上色）', fired.damageType, 'physical')
    eq('起点就是施法者位置', fired.from.x, a.pos.x)
    eq('方向是朝前的单位向量', fired.dir.x, 1)
    ok('打中了 1 个', fired.hitCount === 1, String(fired.hitCount))
  }
}

{
  // 打空了也要发 —— 这是这条事件最要紧的性质
  const { w, a } = arena()
  const ARC = tech('tech.arc.miss', {
    phases: [phase('cast', 0.1)],
    rules: [rule('phaseComplete', [{
      delivery: { kind: 'meleeArc', radius: 0.05, angle: 10 },
      payload: { kind: 'damage', amount: { const: 30 } },
    }], { phaseId: 'cast' })],
  })

  activate(w, a, ARC)
  const events = runCollecting(w, 20)

  const missFired = events.find(e => e.type === 'deliveryFired')
  ok('一个人都没打到，但事件照样发出去了', missFired !== undefined)
  if (missFired !== undefined && missFired.type === 'deliveryFired') {
    eq('hitCount 是 0', missFired.hitCount, 0)
  }
}

{
  // 投射物**不发**这条 —— 它是个实体，客户端已经在画它了
  const { w, a } = arena()
  const BOLT = tech('tech.bolt.check', {
    phases: [phase('cast', 0.1)],
    rules: [rule('phaseComplete', [{
      delivery: { kind: 'projectile', speed: 12, lifetime: 1 },
      payload: { kind: 'damage', amount: { const: 10 } },
    }], { phaseId: 'cast' })],
  })

  activate(w, a, BOLT)
  const events = runCollecting(w, 20)

  eq('投射物不发 deliveryFired（避免和实体重复画）',
    events.filter(e => e.type === 'deliveryFired').length, 0)
}

{
  // 光束：带长度和宽度
  const { w, a, b } = arena()
  const BEAM = tech('tech.beam.check', {
    phases: [phase('cast', 0.1)],
    rules: [rule('phaseComplete', [{
      delivery: { kind: 'beam', length: 12, width: 0.8 },
      payload: { kind: 'damage', amount: { const: 20 }, damageType: 'arcane' },
    }], { phaseId: 'cast' })],
  })

  a.facing = { x: 1, y: 0 }
  b.pos.x = 5
  b.pos.y = 0

  activate(w, a, BEAM)
  const events = runCollecting(w, 20)

  const beamFired = events.find(e => e.type === 'deliveryFired')
  ok('光束推出了 deliveryFired', beamFired !== undefined)
  if (beamFired !== undefined && beamFired.type === 'deliveryFired') {
    eq('光束带长度', beamFired.length, 12)
    eq('光束带宽度', beamFired.width, 0.8)
    eq('光束的颜色按奥术', beamFired.damageType, 'arcane')
    ok('光束打到了 5 米外的人', beamFired.hitCount >= 1, String(beamFired.hitCount))
  }
}

{
  // 确定性不受影响：多了这条事件，同一场景跑两遍仍然逐字节一致
  const run = (): string => {
    const { w, a, b } = arena()
    const ARC = tech('tech.det', {
      phases: [phase('cast', 0.1)],
      rules: [rule('phaseComplete', [{
        delivery: { kind: 'meleeArc', radius: 2.5, angle: 120 },
        payload: { kind: 'damage', amount: { const: 30 } },
      }], { phaseId: 'cast' })],
    })
    activate(w, a, ARC, { targetId: b.id })
    return JSON.stringify(runCollecting(w, 60))
  }
  const first = run()
  ok('多了一条事件，结果仍然逐字节一致', first === run())
  ok('而且这一轮确实收到了事件（不是两个空数组相等）',
    first.includes('deliveryFired'), first.slice(0, 120))
}

// ---------------------------------------------------------------- 4. 冷却与能量

section('冷却与能量')

{
  const { w, a, b } = arena()
  const CD = tech('tech.cd', {
    phases: [phase('cast', 0.1, { cost: { cooldown: 2 } })],
    rules: [rule('phaseComplete', [SWING_DAMAGE], { phaseId: 'cast' })],
  })

  activate(w, a, CD)
  advance(w, 10)
  ok('冷却中', cooldownRemaining(a, 'tech.cd') > 0)

  const blocked = activate(w, a, CD)
  eq('冷却中放不出来', blocked.ok, false)
  eq('原因正确', blocked.ok === false ? blocked.reason : '?', 'cooldown')
  ok('推出了 castBlocked 事件', w.events.some(e => e.type === 'castBlocked'))

  advance(w, 130)
  eq('冷却走完', cooldownRemaining(a, 'tech.cd'), 0)
  eq('现在能放了', activate(w, a, CD).ok, true)
}

{
  const { w, a } = arena()
  setStored(a, 'char.energy.current', 5)
  const EXPENSIVE = tech('tech.expensive', {
    phases: [phase('cast', 0.1, { cost: { energy: 40 } })],
  })

  const res = activate(w, a, EXPENSIVE)
  eq('能量不够时激活就失败', res.ok, false)
  eq('原因正确', res.ok === false ? res.reason : '?', 'energy')
  eq('一点能量都没扣', getStored(a, 'char.energy.current'), 5)
}

{
  const { w, a } = arena()
  const CHANNEL = tech('tech.channel', {
    phases: [phase('beam', 1.0, { occupiesCaster: true })],
  })

  activate(w, a, CHANNEL)
  advance(w, 3)

  const second = activate(w, a, CHANNEL)
  eq('占用施法者的技能不能同时开两个', second.ok, false)
  eq('原因正确', second.ok === false ? second.reason : '?', 'busy')
}

{
  const { w, a } = arena()
  const DEAD = tech('tech.dead')
  a.alive = false
  eq('死人放不出技能', activate(w, a, DEAD).ok, false)
}

// ---------------------------------------------------------------- 5. 蓄力

section('蓄力')

{
  const { w, a, b } = arena()
  const CHARGED = tech('tech.charged', {
    phases: [phase('charge', -1), phase('release', 0.05)],
    rules: [rule('phaseComplete', [{
      delivery: { kind: 'meleeArc', radius: 5, angle: 360 },
      payload: {
        kind: 'damage',
        amount: { ref: 'charge', curve: [[0, 10], [2, 50]] },
        damageType: 'physical',
      },
    }], { phaseId: 'release' })],
  })

  const res = activate(w, a, CHARGED)
  ok('激活成功', res.ok)
  const castId = res.ok ? res.cast.id : -1

  advance(w, 60) // 蓄力 1 秒
  eq('蓄力阶段不会自己结束', w.casts.length, 1)

  releaseCharge(w, castId)
  advance(w, 5)

  // 蓄 1 秒 → 曲线上 [0,10]~[2,50] 的中点 = 30
  near('伤害按蓄力量走曲线', 200 - getStored(b, 'char.hp.current'), 30, 1e-6)
}

{
  const { w, a } = arena()
  const QUICK = tech('tech.quick', { phases: [phase('cast', 0.2, { cancellable: true })] })
  const res = activate(w, a, QUICK)
  const castId = res.ok ? res.cast.id : -1

  eq('取消成功', cancelCast(w, castId), true)
  eq('施法没了', w.casts.length, 0)
}

// ---------------------------------------------------------------- 6. 命中时机

section('onCast / onHit / onMiss / onKill')

{
  const { w, a } = arena()
  const TRACER = tech('tech.tracer', {
    phases: [phase('swing', 0.15)],
    rules: [
      rule('onCast', [
        // ⚠ `target: 'self'` 必须显式写（日志 61：没目标 = 什么都不做）
        { target: 'self', payload: { kind: 'attribute', path: 'char.energy.current', op: 'add', value: { const: -1 } } },
      ]),
      rule('phaseComplete', [SWING_DAMAGE], { phaseId: 'swing' }),
      // ⚠ onHit 默认打到"被打中的那个"（挂破甲这类用途），
      //   想打自己必须显式写 target: 'self'
      rule('onHit', [
        { target: 'self', payload: { kind: 'attribute', path: 'char.energy.current', op: 'add', value: { const: 5 } } },
      ]),
    ],
  })

  // 能量先留出空间，否则加上去会被上限钳掉，看不出差别
  setStored(a, 'char.energy.current', 50)
  activate(w, a, TRACER)
  eq('onCast 立刻生效', getStored(a, 'char.energy.current'), 49)

  advance(w, 20)
  eq('打中之后 onHit 给自己回 5 点', getStored(a, 'char.energy.current'), 54)
}

{
  const { w, a, b } = arena()
  b.pos.x = 100 // 打不到
  const MISSER = tech('tech.misser', {
    phases: [phase('swing', 0.15)],
    rules: [
      rule('phaseComplete', [SWING_DAMAGE], { phaseId: 'swing' }),
      rule('onMiss', [
        // ⚠ 同上：退给自己 = 显式 `target: 'self'`（日志 61）
        { target: 'self', payload: { kind: 'attribute', path: 'char.energy.current', op: 'add', value: { const: 7 } } },
      ]),
    ],
  })

  setStored(a, 'char.energy.current', 50)
  activate(w, a, MISSER)
  advance(w, 20)

  eq('打空了触发 onMiss', getStored(a, 'char.energy.current'), 57)
  eq('目标没掉血', getStored(b, 'char.hp.current'), 200)
}

{
  const { w, a, b } = arena()
  setStored(b, 'char.hp.current', 20)

  const EXECUTER = tech('tech.executer', {
    phases: [phase('swing', 0.15, { cost: { cooldown: 8 } })],
    rules: [
      rule('phaseComplete', [SWING_DAMAGE], { phaseId: 'swing' }),
      rule('onKill', [
        { payload: { kind: 'attribute', path: 'skill.cooldown', op: 'reset', value: { const: 0 } } },
      ]),
    ],
  })

  activate(w, a, EXECUTER)
  advance(w, 20)

  eq('目标死了', b.alive, false)
  eq('击杀重置了冷却（露娜的大招刷新）', cooldownRemaining(a, 'tech.executer'), 0)
  eq('现在能马上再放', activate(w, a, EXECUTER).ok, true)
}

// ---------------------------------------------------------------- 7. 范围与过滤

section('扇形多目标与有效目标过滤')

{
  const { w, a, b } = arena()
  const front1 = enemy(w, 1.5, 0.5)
  const front2 = enemy(w, 2, -1)
  const behind = enemy(w, -2, 0)
  const ally = spawn(w, { faction: 'player', pos: { x: 1, y: 1 } })

  const SWEEP = tech('tech.sweep', {
    phases: [phase('swing', 0.15)],
    rules: [rule('phaseComplete', [SWING_DAMAGE], { phaseId: 'swing' })],
  })

  activate(w, a, SWEEP)
  advance(w, 20)

  eq('正前方两个都吃到了', getStored(b, 'char.hp.current'), 170)
  eq('第二个也吃到了', getStored(front1, 'char.hp.current'), 170)
  eq('第三个也吃到了', getStored(front2, 'char.hp.current'), 170)
  eq('背后的没吃到', getStored(behind, 'char.hp.current'), 200)
  eq('队友没吃到', getStored(ally, 'char.hp.current'), 100)
}

{
  const { w, a } = arena()
  const zombie = enemy(w, 1.5, 0, ['undead'])
  const robot = enemy(w, 2, 0, ['construct'])

  const TURN_UNDEAD = tech('tech.turnUndead', {
    targeting: { mode: 'directional', valid: ['undead'] },
    phases: [phase('swing', 0.15)],
    rules: [rule('phaseComplete', [{
      delivery: { kind: 'meleeArc', radius: 4, angle: 180 },
      payload: { kind: 'damage', amount: { const: 25 }, damageType: 'holy' },
    }], { phaseId: 'swing' })],
  })

  activate(w, a, TURN_UNDEAD)
  advance(w, 20)

  eq('只打亡灵', getStored(zombie, 'char.hp.current'), 175)
  eq('构装体免疫（valid 里没有它）', getStored(robot, 'char.hp.current'), 200)
}

// ---------------------------------------------------------------- 8. 技能图钩子

section('技能图作为第三个钩子来源（常驻被动）')

{
  const { w, a, b } = arena()

  // 名刀司命做成一个 auto 被动 —— 武器铭刻的就是这类东西
  const NAMED_BLADE = tech('tech.namedBlade', {
    activation: 'auto',
    targeting: { mode: 'self', valid: ['self'] },
    phases: [phase('idle', 0.01)],
    rules: [rule('onLethalDamage', [
      { payload: { kind: 'attribute', path: 'pipeline.cancelled', op: 'set', value: { const: 1 } } },
    ])],
  })
  registerTechnique(w, NAMED_BLADE)

  const before = dealDamage(w, a.id, b.id, 9999, { mode: 'lethal' })
  eq('没开被动：直接被打死', b.alive, false)
  void before

  // 重来一次，这次挂上被动
  const s2 = arena()
  registerTechnique(s2.w, NAMED_BLADE)
  setTechniqueActive(s2.w, s2.b, NAMED_BLADE.id, true)

  const hit = dealDamage(s2.w, s2.a.id, s2.b.id, 9999, { mode: 'lethal' })
  eq('开了被动：致命伤被拦下', hit.intercepted, true)
  ok('还活着', s2.b.alive)
  eq('血量一点没掉', getStored(s2.b, 'char.hp.current'), 200)
}

{
  const { w, a, b } = arena()
  const GUARD_PASSIVE = tech('tech.guardPassive', {
    activation: 'toggle',
    targeting: { mode: 'self', valid: ['self'] },
    phases: [phase('idle', 0.01)],
    rules: [rule('onDamaged', [
      { payload: { kind: 'attribute', path: 'pipeline.amount', op: 'mul', value: { const: 0.5 } } },
    ])],
  })
  registerTechnique(w, GUARD_PASSIVE)

  dealDamage(w, a.id, b.id, 40)
  eq('没开的时候正常吃伤害', getStored(b, 'char.hp.current'), 160)

  setTechniqueActive(w, b, GUARD_PASSIVE.id, true)
  dealDamage(w, a.id, b.id, 40)
  eq('toggle 打开后半伤', getStored(b, 'char.hp.current'), 140)

  setTechniqueActive(w, b, GUARD_PASSIVE.id, false)
  dealDamage(w, a.id, b.id, 40)
  eq('关掉之后恢复', getStored(b, 'char.hp.current'), 100)
}

{
  const { w, a, b } = arena()
  // 常驻吸血被动 —— 钩子必须声明长在"打人"那一侧
  const VAMPIRIC = tech('tech.vampiric', {
    activation: 'auto',
    targeting: { mode: 'self', valid: ['self'] },
    phases: [phase('idle', 0.01)],
    rules: [rule('onHit', [
      { target: 'self', payload: { kind: 'heal', amount: { const: 12 } } },
    ])],
  })
  registerTechnique(w, VAMPIRIC)
  setTechniqueActive(w, a, VAMPIRIC.id, true)
  setStored(a, 'char.hp.current', 50)

  dealDamage(w, a.id, b.id, 30)
  eq('打人的一方吸到了血', getStored(a, 'char.hp.current'), 62)
  eq('被打的一方正常掉血', getStored(b, 'char.hp.current'), 170)
}

// ---------------------------------------------------------------- 阶段锁

section('阶段锁：locks 真的把人定住了')

{
  /*
   * ⚠ `locks` 以前是**惰性字段** —— schema 里有、内容里写了
   *   （贯日写着 `locks: ["turn"]`）、校验器认真检查取值、
   *   说明生成器还会写一句"无法转动"，而**引擎一处都不读**。
   *
   *   玩家想做的"高伤持续激光，但是无法转向"就卡在这儿。
   *   现在由 `applyPhaseLocks()` 在 stepWorld 的 7b 强制执行
   *   （夹在 AI 和位置积分之间），这一节把三件事钉住：
   *     朝向冻住 / 速度清零 / locks 里的 cast 挡得住别的术式
   */
  const { w, a, b } = arena()
  const laser = tech('laser', {
    phases: [phase('charge', 0.5, { locks: ['turn', 'move'], occupiesCaster: true })],
  })
  registerTechnique(w, laser)

  // 施法前先定一个朝向，再让它偏一点，好分辨"冻的是哪一个"
  a.facing.x = 1
  a.facing.y = 0
  const r = activate(w, a, laser, { intent: { kind: 'direction', dir: { x: 1, y: 0 } } })
  eq('施法成功', r.ok, true)

  // 玩家/AI 试图转向 + 移动
  a.facing.x = 0
  a.facing.y = 1
  a.vel.x = 5
  a.vel.y = 5

  stepWorld(w)

  near('朝向被掰回施法那一刻的方向（x）', a.facing.x, 1)
  near('朝向被掰回施法那一刻的方向（y）', a.facing.y, 0)
  near('速度被清零（动不了）', a.vel.x, 0)
  near('  两个分量都清', a.vel.y, 0)
  near('  所以人没挪动', a.pos.x, 0)

  eq('查询接口也看得到这两个锁',
    phaseLocksOf(w, a).sort().join(','), 'move,turn')

  /*
   * ⚠ 只清 `vel`、不清 `push`：被击退是**别人对你做的事**，
   *   阶段锁管的是"你自己想干什么"。硬直的人照样会被撞飞。
   */
  a.push.x = 10
  stepWorld(w)
  ok('被击退照样会被推走（阶段锁管不了别人对你的位移）',
    a.pos.x > 0, `pos.x = ${a.pos.x}`)

  void b
}

{
  /*
   * `locks` 里有 `cast` → 这个阶段里放不出别的术式。
   *
   * ⚠ 和 `busy`（occupiesCaster 排期冲突）分开：那个是"排不上队"，
   *   这个是"设计上不许"。提示和判据都该是两条。
   */
  const { w, a } = arena()
  const busy = tech('busy', { phases: [phase('hold', 0.5, { locks: ['cast'] })] })
  const other = tech('other', { phases: [phase('cast', 0.1)] })
  registerTechnique(w, busy)
  registerTechnique(w, other)

  eq('第一个术式放得出', activate(w, a, busy).ok, true)
  const blocked = activate(w, a, other)
  eq('锁了 cast 的时候放不出第二个', blocked.ok, false)
  eq('  原因是 locked（不是笼统的 busy）',
    blocked.ok ? '' : blocked.reason, 'locked')
  ok('  事件里也带了这个原因',
    w.events.some(e => e.type === 'castBlocked' && e.reason === 'locked'))
}

{
  // 阶段结束之后锁要**自动解除** —— 不然人就被永久定住了
  const { w, a } = arena()
  const short = tech('short', { phases: [phase('cast', 0.1, { locks: ['move'] })] })
  registerTechnique(w, short)
  activate(w, a, short)
  stepWorld(w)

  advance(w, 30)   // 跑到阶段结束、施法清理
  eq('施法结束之后没有锁了', phaseLocksOf(w, a).length, 0)

  a.vel.x = 3
  stepWorld(w)
  ok('  又能动了', a.pos.x > 0, `pos.x = ${a.pos.x}`)
}

// ---------------------------------------------------------------- 施法独占

section('施法独占：同一个人同一时刻只有一段施法（2026-09-30 日志 54）')

{
  /*
   * ⚠⚠ **玩家 2026-09-30 定的硬规矩**（原话："玩家又没有第二人格"）：
   *     > 同一个施法者，同一时刻只能有一个"进行中的施法"。
   *
   *   这条断言钉的正是**改掉的那个 bug**：改之前 `canActivate` 问的是
   *   "**这一门术式**有没有占人阶段" **且** 那一段占着人 ——
   *   于是**瞬发 / 脱手**的术式（`occupiesCaster: false`）能从一段正在跑的
   *   施法中间插进去，**两段施法同时在跑**。
   *
   *   ⚠ 它和 `locks` **无关**：这里两门术式**一条锁都没写**，
   *     照样拒绝 —— 施法独占不是可配项。
   */
  const { w, a } = arena()
  const channel = tech('channel', { phases: [phase('beam', 1.0, { occupiesCaster: true })] })
  // ⚠ `phase()` 默认 `occupiesCaster: false` ⇒ 这一门是**脱手技**
  const instant = tech('instant', { phases: [phase('cast', 0.1)] })
  registerTechnique(w, channel)
  registerTechnique(w, instant)

  eq('引导技放出来了', activate(w, a, channel).ok, true)
  advance(w, 3)

  const sneak = activate(w, a, instant)
  eq('⚠ 引导技还没放完 → 脱手的术式也插不进来（老行为：能插，两段同时在跑）',
    sneak.ok, false)
  eq('  原因说得清：正在施法', sneak.ok === false ? sneak.reason : '?', 'busy')
  eq('  手上只有一段施法（不是两段）', w.casts.filter(c => c.casterId === a.id).length, 1)
  ok('  而且拒绝的理由进了事件流（客户端靠它飘字）',
    w.events.some(e => e.type === 'castBlocked' && e.reason === 'busy'))
}

{
  // 同一个术式**再按** → 一样被拒（独占挡的是"人"，不是"别的术式"）
  const { w, a } = arena()
  const chant = tech('chant', { phases: [phase('cast', 0.5)] })
  registerTechnique(w, chant)

  eq('第一下放出来了', activate(w, a, chant).ok, true)
  const again = activate(w, a, chant)
  eq('同一个术式再按下 → 被拒', again.ok, false)
  eq('  原因：正在施法', again.ok === false ? again.reason : '?', 'busy')
  eq('  也没有起第二段', w.casts.filter(c => c.casterId === a.id).length, 1)
}

{
  /*
   * ⚠⚠ **不许把脱手技堵死**（玩家划的另一半）：
   *   脱手技的特点是"**施法动作很快就结束**了，效果自己活着" ——
   *   所以它**放完就该能立刻再放别的**。
   *
   *   这一节把两半都测：**还没放完**时插不进去（独占），
   *   **放完的那一刻起**立刻能放（没有被堵死）。
   *   只测前一半的话，一个"永远拒绝"的实现也能通过。
   */
  const { w, a } = arena()
  const released = tech('released', { phases: [phase('flick', 0.2, { occupiesCaster: false })] })
  const other = tech('other', { phases: [phase('cast', 0.1)] })
  registerTechnique(w, released)
  registerTechnique(w, other)

  eq('脱手技放出来了', activate(w, a, released).ok, true)
  const mid = activate(w, a, other)
  eq('  它还在放（0.2 秒没走完）→ 别的照样被拒', mid.ok, false)
  eq('  原因：正在施法', mid.ok === false ? mid.reason : '?', 'busy')

  advance(w, 30)   // 0.5 秒 ≫ 0.2 秒：这一段早就跑完了
  eq('  它的施法已经结束（"施法动作很快就结束"）',
    w.casts.filter(c => c.casterId === a.id).length, 0)
  eq('⚠ 放完**立刻**能再放别的（脱手技没被独占堵死）', activate(w, a, other).ok, true)
}

{
  /*
   * ⚠ **同一次激活的第 2..N 份**是刻意留的口子（`sameActivation`）：
   *   份数类修饰（多重释放 / 一分为 X）**天生**就是"一次激活好几段"，
   *   那是玩家签字过的机制 —— 全拦掉等于删掉那个零件
   *   （`tests/scenario.ts` 第 41–45 节照样绿，就是这一条的证据）。
   *
   * ⚠⚠ 另一条口子是 **`engineInternal`**（2026-09-30 日志 54，玩家裁定）：
   *   "施法独占"管的是**玩家的手指**，不是**引擎内部的延续** ——
   *   触发器链条 / 监测器的被动反射**不受它管**（只有 `sim/trigger.ts` 会填）。
   *   ⚠ 不豁免的后果是**静默的**：玩家施法中途跨过危险线，撑盾那一下被吞掉、
   *     盾永远不挂 —— 等于把日志 48 的机制废掉。端到端那两条钉在
   *     `tests/scenario.ts` 第 58 节（②触发器链条 / ③被动反射）。
   */
  const { w, a } = arena()
  const group = tech('group', { phases: [phase('cast', 0.3)] })
  registerTechnique(w, group)

  eq('第一份放出来了', activate(w, a, group).ok, true)
  eq('⚠ 同一次激活里的第 2 份仍然放行（份数类修饰的落点）',
    canActivate(w, a, group, { sameActivation: true }), undefined)
  eq('⚠ 引擎内部的延续也放行（触发器链条 / 被动反射）',
    canActivate(w, a, group, { engineInternal: true }), undefined)
  eq('  可"玩家手指那一下"照样被拒', canActivate(w, a, group), 'busy')
  eq('  什么都不给就是被拒（默认那一条路才是硬规矩）',
    canActivate(w, a, group, {}), 'busy')
}

// ---------------------------------------------------------------- 没有目标

section('没有目标就什么都不发生（2026-09-30 日志 61）')

{
  /*
   * ⚠⚠ 用户 2026-09-30 定的：**需要目标却选不到 ⇒ 这个动作什么都不做**。
   *
   *   不许"随便挑一个"，也**不许"算我自己身上"** —— 后者是以前那句
   *   `ctx.target ?? ctx.actor` 干的事：瞄准的目标不在了，动作会**静默地
   *   落到施法者自己头上**（打人变成自伤、给敌人挂状态变成给自己挂）。
   *
   *   ⚠ 它是"瞬移到目标身后但没有目标 ⇒ 什么都不做"那条规矩的**推广**
   *     （`sim/pipeline.ts` 的 `anchor: 'target'` 早就是那样）。
   *   ⚠ 判据只有一处、两条路**都读它**：`resolveActionTarget`（单目标动作）
   *     和 `pickActionTargets`（无载体动作）—— 只清一处的话，
   *     "改属性"和"挂状态"会给出两种答案。
   */

  // ---- ① 无载体 + 不写 target：选不到目标 ⇒ **一滴血都不掉** ----
  const { w, a, b } = arena()
  const NO_TARGET = tech('tech.noTarget', {
    phases: [phase('swing', 0.15)],
    rules: [
      rule('phaseComplete', [
        // ⚠ 没有 `delivery`（无载体），也没写 `target` ⇒ 它"需要目标"
        { payload: { kind: 'attribute', path: 'char.hp.current', op: 'add', value: { const: -10 } } },
      ], { phaseId: 'swing' }),
    ],
  })
  const beforeHp = getStored(a, 'char.hp.current')
  activate(w, a, NO_TARGET)
  advance(w, 20)
  eq('① 没有目标 ⇒ 那个动作**什么都没做**（施法者不掉血）',
    getStored(a, 'char.hp.current'), beforeHp)
  eq('  而且敌人也一点事都没有（"随便挑一个"也是不许的）',
    getStored(b, 'char.hp.current'), 200)

  /*
   * ---- ② 对照：同一个动作**显式写** `target: 'self'` ⇒ 照旧打自己 ----
   *
   *   ⚠ 这一条是"把该打的都拦掉了"的反例门闩：新规矩要的是"**别猜**"，
   *     不是"禁止打自己"。定稿口径是**每条动作一处** —— 想打自己就写出来。
   */
  const { w: w2, a: a2 } = arena()
  const SELF_HIT = tech('tech.selfHit', {
    phases: [phase('swing', 0.15)],
    rules: [
      rule('phaseComplete', [
        {
          target: 'self',
          payload: { kind: 'attribute', path: 'char.hp.current', op: 'add', value: { const: -10 } },
        },
      ], { phaseId: 'swing' }),
    ],
  })
  const beforeHp2 = getStored(a2, 'char.hp.current')
  activate(w2, a2, SELF_HIT)
  advance(w2, 20)
  eq('② 显式写了 target: self ⇒ 照旧打自己（新规矩不禁止自伤）',
    getStored(a2, 'char.hp.current'), beforeHp2 - 10)
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
