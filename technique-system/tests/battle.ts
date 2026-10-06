/**
 * 投射物与 AI 的测试。
 *
 * 前四步测的都是"一个技能自己能不能跑"。这一批测的是**它们碰在一起**：
 * 子弹飞出去之后施法早就结束了、AI 按阵营选目标、蓄力技要有人松手。
 */
import { readJson } from '../src/loader.ts'
import { resolve } from 'node:path'
import { installTechnique, loadLibrary } from '../src/bridge.ts'
import { probeTechnique } from './probes.ts'
import type { BalanceConfig } from '../src/validator/types.ts'
import {
  activate, advance, applyStatus, createWorld, dealDamage, distance, getStored,
  registerTechnique, resolveAttribute, setTechniqueActive, snapshot, spawn, spawnProjectile,
  setStored, stepWorld,
} from '../src/sim/index.ts'
import type { Entity, ProjectileSpec, SimEvent, Vec3, World } from '../src/sim/index.ts'
import type { Phase, Rule, Skill, StatusDef, Technique } from '../src/schema.ts'
import { compileTechnique } from '../src/sim/compile.ts'
import type { CompiledTechnique } from '../src/sim/compile.ts'

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

function near(name: string, actual: number, expected: number, eps = 1e-6): void {
  ok(name, Math.abs(actual - expected) < eps, `实际 ${actual}，期望 ${expected}`)
}

function section(title: string): void {
  console.log(`\n${title}`)
}

// ---------------------------------------------------------------- 工具

function phase(id: string, duration: number, over: Partial<Phase> = {}): Phase {
  return { id, duration, occupiesCaster: false, interrupt: 'damage', cancellable: false, ...over }
}

let seq = 0
function rule(when: Rule['when'], then: Rule['then'], over: Partial<Rule> = {}): Rule {
  seq++
  return { id: `r${seq}`, when, then, order: seq, ...over }
}

/** 造一个单技能术式，返回编译产物。理由见 tests/cast.ts 里的同名函数 */
function tech(id: string, over: Partial<CompiledTechnique> = {}): CompiledTechnique {
  const { phases, rules, ruleSlots, ...rest } = over
  const skill: Skill = {
    schemaVersion: 1,
    id: `skill.${id}`,
    name: id,
    phases: phases ?? [phase('cast', 0.15)],
    rules: rules ?? [],
    ruleSlots: ruleSlots ?? 8,
    /*
     * ⚠ 瞄准在**技能**上（2026-09-21 日志 47）：术式那个字段删掉了 ——
     *   这里把 `over.targeting` 放到技能上，调用方写的东西一个字没变。
     */
    targeting: rest.targeting ?? { mode: 'directional', valid: ['enemy'], range: 12 },
  }
  const technique: Technique = {
    schemaVersion: 1,
    id,
    name: id,
    // ⚠ 系别必填（见 schema 的 Technique.kind）：测试造的这些都是魔法术式，
    //   里面的技能也是从 `skill.*` 现造的（`school` 由加载器盖，这里用不上）
    kind: 'magic',
    activation: rest.activation ?? 'press',
    skills: [skill.id],
  }
  return compileTechnique(technique, k => (k === skill.id ? skill : undefined)).compiled
}

function at(x: number, y: number): Vec3 {
  return { x, y, z: 0 }
}

function arena(): { w: World; a: Entity; b: Entity } {
  const w = createWorld({ seed: 3 })
  const a = spawn(w, {
    faction: 'player',
    pos: { x: 0, y: 0 },
    base: { 'char.hp.max': 200, 'char.energy.max': 100, 'char.energy.regen': 0, 'char.speed': 5 },
  })
  const b = spawn(w, {
    faction: 'enemy',
    pos: { x: 10, y: 0 },
    base: { 'char.hp.max': 200, 'char.speed': 5 },
  })
  a.facing = { x: 1, y: 0 }
  return { w, a, b }
}

// ---------------------------------------------------------------- 1. 投射物

section('投射物：飞行与命中')

{
  const { w, a, b } = arena()
  const spec: ProjectileSpec = {
    actions: [{
      payload: { kind: 'damage', amount: { const: 25 }, damageType: 'arcane' },
    }],
    valid: ['enemy'],
    sourceId: a.id,
    hitIds: [],
    pierce: false,
  }

  const p = spawnProjectile(w, {
    pos: a.pos,
    dir: { x: 1, y: 0 },
    delivery: { kind: 'projectile', speed: 10, lifetime: 2, radius: 0.3 },
    tags: ['arcane'],
    spec,
  })

  ok('投射物被造出来了', p.kind === 'projectile')
  near('速度是 10 米/秒', p.vel.x, 10)

  advance(w, 6)
  ok('6 tick 后还在飞', w.entities.some(e => e.id === p.id))
  eq('还没打到', getStored(b, 'char.hp.current'), 200)

  // 10 米 / 10 米每秒 = 1 秒
  advance(w, 60)
  eq('1 秒后打中，扣 25 血', getStored(b, 'char.hp.current'), 175)
  ok('命中后子弹消失', !w.entities.some(e => e.id === p.id))
}

{
  const { w, a, b } = arena()
  // B 挪开，子弹会飞过头
  b.pos = at(10, 8)

  spawnProjectile(w, {
    pos: a.pos,
    dir: { x: 1, y: 0 },
    delivery: { kind: 'projectile', speed: 10, lifetime: 1 },
    tags: [],
    spec: {
      actions: [{ payload: { kind: 'damage', amount: { const: 25 } } }],
      valid: ['enemy'], sourceId: a.id, hitIds: [], pierce: false,
    },
  })

  advance(w, 90)
  eq('打空了：一颗血都没掉', getStored(b, 'char.hp.current'), 200)
  ok('子弹飞完存在时间自己消失', w.entities.filter(e => e.kind === 'projectile').length === 0)
}

{
  const { w, a, b } = arena()
  const c = spawn(w, { faction: 'enemy', pos: at(12, 0), base: { 'char.hp.max': 200 } })

  spawnProjectile(w, {
    pos: a.pos,
    dir: { x: 1, y: 0 },
    delivery: { kind: 'projectile', speed: 10, lifetime: 2, radius: 0.3, pierce: true },
    tags: [],
    spec: {
      actions: [{ payload: { kind: 'damage', amount: { const: 20 } } }],
      valid: ['enemy'], sourceId: a.id, hitIds: [], pierce: true,
    },
  })

  advance(w, 90)
  ok('穿透弹打中了两个', getStored(b, 'char.hp.current') < 200 && getStored(c, 'char.hp.current') < 200,
    `b=${getStored(b, 'char.hp.current')} c=${getStored(c, 'char.hp.current')}`)
  eq('第一个中了 20', getStored(b, 'char.hp.current'), 180)
  eq('第二个也中了 20', getStored(c, 'char.hp.current'), 180)
}

{
  const { w, a, b } = arena()
  // 队友挡在中间：子弹不该打自己人
  const ally = spawn(w, { faction: 'player', pos: { x: 5, y: 0 }, base: { 'char.hp.max': 200 } })

  spawnProjectile(w, {
    pos: a.pos,
    dir: { x: 1, y: 0 },
    delivery: { kind: 'projectile', speed: 10, lifetime: 2, radius: 0.3 },
    tags: [],
    spec: {
      actions: [{ payload: { kind: 'damage', amount: { const: 20 } } }],
      valid: ['enemy'], sourceId: a.id, hitIds: [], pierce: false,
    },
  })

  advance(w, 90)
  eq('队友一点没掉', getStored(ally, 'char.hp.current'), 200)
  eq('敌人掉了 20', getStored(b, 'char.hp.current'), 180)
}

section('投射物走完整条技能链')

{
  const { w, a, b } = arena()
  // 通过术式发射 —— 这才是真内容走的路径
  const BOLT = tech('tech.bolt', {
    phases: [phase('cast', 0.15, { cost: { energy: 10 } })],
    rules: [
      rule('phaseComplete', [{
        delivery: { kind: 'projectile', speed: 10, lifetime: 2, radius: 0.3 },
        payload: { kind: 'damage', amount: { const: 25 }, damageType: 'arcane' },
      }], { phaseId: 'cast' }),
      rule('onHit', [
        { target: 'self', payload: { kind: 'attribute', path: 'char.energy.current', op: 'add', value: { const: 5 } } },
      ]),
    ],
  })
  registerTechnique(w, BOLT)

  activate(w, a, BOLT, { targetId: b.id })
  advance(w, 30)

  ok('子弹已经出去了', w.entities.some(e => e.kind === 'projectile'))
  eq('施法早就结束了', w.casts.length, 0)
  eq('这时候还没打到', getStored(b, 'char.hp.current'), 200)

  advance(w, 60)
  eq('飞到了，扣 25', getStored(b, 'char.hp.current'), 175)
  eq('onHit 规则也触发了（发射者回 5 能量）', getStored(a, 'char.energy.current'), 95)
}

{
  const { w, a, b } = arena()
  // 命中后挂状态，而不是直接伤害
  const HEX = tech('tech.hex', {
    phases: [phase('cast', 0.15)],
    rules: [rule('phaseComplete', [{
      delivery: { kind: 'projectile', speed: 8, lifetime: 2, radius: 0.3 },
      payload: {
        kind: 'status',
        verb: 'apply',
        inline: {
          id: 'status.hexed', name: '中咒', tags: ['debuff'], duration: 5,
          modifiers: [{ path: 'char.moveScale', op: 'mul', value: { const: 0.5 } }],
        },
      },
    }], { phaseId: 'cast' })],
  })
  registerTechnique(w, HEX)

  activate(w, a, HEX, { targetId: b.id })
  advance(w, 120)

  ok('子弹命中后挂上了状态', b.statuses.some(s => s.defId === 'status.hexed'))
  near('减速生效：移速被压到一半',
    resolveAttribute(b, 'char.moveScale', { world: w, self: b }), 0.5)
}

section('投射物：方向听「瞄准」的，不听「脸」的')

/*
 * 这一条守的是一个**只有 AI 会中招**的 bug。
 *
 *   角色面朝 +x、敌人在 +y。用 `locked` 索敌，`resolveAim` 会把朝向掰向敌人
 *   （`facing: {0,1}` 且 `facingLocked: true`）—— 但投射物生成时用的是
 *   `ctx.actor.facing`，也就是**脸朝哪儿往哪儿飞**。
 *
 *   玩家手动瞄准时"脸朝的方向"就是"要打的方向"，所以看不出来；
 *   AI 用 locked / auto 时方向算得对、子弹却歪着出去，
 *   表现成"法师一直在朝空气放飞弹" —— 看起来像 AI 笨，不像 bug。
 *
 * ⚠ 断言必须**同时**看 x 和 y：只断言"打中了"是不够的，
 *   敌人就在 +y 而且很近，歪着飞的子弹也可能蹭到。
 */
{
  const { w, a, b } = arena()
  a.facing = at(1, 0)
  b.pos = at(0, 8)

  const LOCK_BOLT = tech('tech.lock-bolt', {
    targeting: { mode: 'locked', valid: ['enemy'], range: 20 },
    phases: [phase('cast', 0.15)],
    rules: [rule('phaseComplete', [{
      delivery: { kind: 'projectile', speed: 10, lifetime: 2, radius: 0.3 },
      payload: { kind: 'damage', amount: { const: 25 } },
    }], { phaseId: 'cast' })],
  })
  registerTechnique(w, LOCK_BOLT)

  activate(w, a, LOCK_BOLT, { targetId: b.id })
  advance(w, 12)

  const p = w.entities.find(e => e.kind === 'projectile')
  if (p === undefined) {
    ok('子弹出去了', false, '12 tick 后场上没有投射物')
  } else {
    near('横向速度是 0（没有照着脸朝 +x 飞出去）', p.vel.x, 0)
    near('纵向速度是 10（朝着敌人 +y 飞）', p.vel.y, 10)
  }
}

section('两个技能库：变体和基础版是两样东西，各有各的数值')

/*
 * ⚠ 这一条钉的是"**改了等于没改**"和"**两样东西**"。
 *
 *   玩家 2026-09-21 定的：技能分**两个库** —— 基础技能库（内容、只读）和
 *   自定义技能库（存档里玩家创造的变体）。术式按 id 引用技能，两个库都能引用。
 *   所以编译那一刻查的必须是**合并后的那张表**：
 *   漏了的话，界面上账变了、打出来的伤害却还是基础版的 ——
 *   全绿、无报错，只有玩家会觉得"怎么打不动了"。
 */
{
  const { w, a, b } = arena()
  const base: Skill = {
    schemaVersion: 1,
    id: 'skill.copy-bolt',
    name: '基础飞弹',
    phases: [phase('cast', 0.15)],
    rules: [rule('phaseComplete', [{
      delivery: { kind: 'projectile', speed: 10, lifetime: 2, radius: 0.3 },
      payload: { kind: 'damage', amount: { const: 25 } },
    }], { phaseId: 'cast' })],
    ruleSlots: 8,
    /*
     * ⚠ 瞄准在**技能**上（2026-09-21 日志 47）：术式那个字段删掉了。
     *   这里写一份，变体是 `JSON.parse(JSON.stringify(base))` 来的，
     *   所以**两份都带着它** —— 编译时取的是**引用的那个技能**那一份。
     */
    targeting: { mode: 'directional', valid: ['enemy'], range: 12 },
  }
  // 玩家创造的变体：自己的 id + 记住模板（`basedOn`）
  const stronger: Skill = JSON.parse(JSON.stringify(base)) as Skill
  stronger.id = 'custom.copy-bolt.1'
  stronger.name = '基础飞弹-副本1'
  stronger.basedOn = base.id
  stronger.rules[0]!.then[0]!.payload = { kind: 'damage', amount: { const: 60 } }

  // 「两个库」= 一张合并后的表（自定义库优先、基础库兜底）
  const lib = new Map<string, Skill>([[base.id, base], [stronger.id, stronger]])
  const lookup = (id: string): Skill | undefined => lib.get(id)

  const T: Technique = {
    schemaVersion: 1,
    id: 'tech.copy-bolt',
    name: '副本飞弹',
    kind: 'magic',
    activation: 'press',
    // ⚠ 瞄准在**技能**上（2026-09-21 日志 47）：上面那两个技能各自带着自己的
    skills: [stronger.id],
  }
  const compiled = compileTechnique(T, lookup).compiled
  registerTechnique(w, compiled)

  activate(w, a, compiled)
  advance(w, 90)

  eq('术式引用的是**变体** → 打出来是变体的数值 60（不是基础的 25）',
    getStored(b, 'char.hp.current'), 140)

  // 反过来：引用基础技能时**必须是基础的数值**（两样东西，各有各的数）
  const { w: w2, a: a2, b: b2 } = arena()
  const plain: Technique = { ...T, id: 'tech.plain-bolt', skills: [base.id] }
  const plainCompiled = compileTechnique(plain, lookup).compiled
  registerTechnique(w2, plainCompiled)
  activate(w2, a2, plainCompiled)
  advance(w2, 90)
  eq('  引用基础技能 → 用的就是基础的 25（两样东西互不影响）',
    getStored(b2, 'char.hp.current'), 175)
}

// ---------------------------------------------------------------- 2. AI

section('AI：阵营查询与走位')

{
  const { w, a, b } = arena()
  b.pos = at(20, 0)
  // 一个更近的队友 —— AI 不该把它当目标
  spawn(w, { faction: 'enemy', pos: { x: 3, y: 0 }, base: { 'char.hp.max': 200 } })

  const SWING = tech('tech.swing', {
    targeting: { mode: 'directional', valid: ['enemy'], range: 3 },
    phases: [phase('swing', 0.2)],
    rules: [rule('phaseComplete', [{
      delivery: { kind: 'meleeArc', radius: 3, angle: 180 },
      payload: { kind: 'damage', amount: { const: 10 } },
    }], { phaseId: 'swing' })],
  })
  registerTechnique(w, SWING)

  a.ai = { targetFaction: 'enemyOfSelf', preferredRange: 1.5, thinkInterval: 0.2 }
  a.techniqueIds = ['tech.swing']

  advance(w, 120)

  ok('AI 会朝最近的敌人走', a.pos.x > 0.5, `x=${a.pos.x}`)
  eq('AI 打到了那个敌人（不是更远的那个）',
    getStored(w.entities.find(e => e.faction === 'enemy' && e.pos.x < 10) ?? b, 'char.hp.current') < 200,
    true)
}

{
  const { w, a, b } = arena()
  b.pos = at(8, 0)
  a.ai = { targetFaction: 'enemyOfSelf', preferredRange: 5, thinkInterval: 0.3 }
  a.techniqueIds = []

  advance(w, 180)
  const d = distance(a.pos, b.pos)
  ok('AI 会停在想保持的距离上（5 米）', Math.abs(d - 5) < 1.2, `实际 ${d.toFixed(2)} 米`)
}

{
  const { w, a, b } = arena()
  b.pos = at(2, 0)
  const SHOT = tech('tech.shot', {
    phases: [phase('cast', 0.1, { cost: { cooldown: 1 } })],
    rules: [rule('phaseComplete', [{
      delivery: { kind: 'meleeArc', radius: 4, angle: 360 },
      payload: { kind: 'damage', amount: { const: 15 } },
    }], { phaseId: 'cast' })],
  })
  registerTechnique(w, SHOT)

  a.ai = { targetFaction: 'enemyOfSelf', preferredRange: 2, thinkInterval: 0.2 }
  a.techniqueIds = ['tech.shot']

  advance(w, 120)
  ok('AI 会反复放技能', b.statuses !== undefined && getStored(b, 'char.hp.current') < 200)
  ok('掉了不止一次（冷却好了就再放）',
    getStored(b, 'char.hp.current') <= 200 - 15 * 2,
    `实际 ${getStored(b, 'char.hp.current')}`)
}

section('AI：蓄力技要有人松手')

{
  const { w, a, b } = arena()
  b.pos = at(6, 0)
  const LASER = tech('tech.laser', {
    phases: [
      phase('charge', -1, { occupiesCaster: true }),
      // 加冷却，不然 3 秒里它会连着放好几发，断言就算不清了
      phase('fire', 0.1, { cost: { cooldown: 5 } }),
    ],
    rules: [rule('phaseComplete', [{
      delivery: { kind: 'beam', length: 12, width: 1 },
      payload: { kind: 'damage', amount: { ref: 'charge', curve: [[0, 10], [2, 90]] } },
    }], { phaseId: 'fire' })],
  })
  registerTechnique(w, LASER)

  a.ai = { targetFaction: 'enemyOfSelf', preferredRange: 5, thinkInterval: 0.2, chargeTime: 1 }
  a.techniqueIds = ['tech.laser']

  advance(w, 30)
  ok('进入蓄力了', a !== undefined && w.casts.length > 0)

  advance(w, 90)
  // 蓄 1 秒 → 曲线上 10 + 80*(1/2) = 50
  near('AI 蓄够 1 秒就松手，伤害按蓄力量算', 200 - getStored(b, 'char.hp.current'), 50, 1.5)
}

// ---------------------------------------------------------------- 3b. 命中特效

section('命中特效（投射物在**落地**时才发，不是在发射时）')

/**
 * 边跑边收事件 —— `stepWorld` 每 tick 会清空 `world.events`。
 * （和 tests/cast.ts 里那个是同一个东西；两处都用到，但都很短，不值得抽公共模块）
 */
function runCollecting(w: World, ticks: number): SimEvent[] {
  const out: SimEvent[] = []
  for (let i = 0; i < ticks; i++) {
    stepWorld(w)
    out.push(...w.events)
  }
  return out
}

/**
 * 边跑边收事件，并在**事件发生的那一 tick** 记下目标的坐标。
 *
 * ⚠ 为什么要记：命中会**击退**目标，之后它就不在原来的位置了。
 *   直接拿跑完之后 `b.pos` 去比，会差出一个击退距离（实测 0.03 米），
 *   看起来像"落点算错了"，其实是目标被打飞了。
 *
 * ⚠ 同一 tick 里坐标还没变：击退只是个冲量，`integrate`（第 8 步）
 *   在投射物碰撞（第 9 步）**之前**跑，所以那一刻的位置就是命中位置。
 */
function runCollectingWithTarget(w: World, target: Entity, ticks: number): {
  events: SimEvent[]
  hitFrom: { x: number; y: number } | undefined
  targetAt: { x: number; y: number } | undefined
} {
  const events: SimEvent[] = []
  let hitFrom: { x: number; y: number } | undefined
  let targetAt: { x: number; y: number } | undefined

  for (let i = 0; i < ticks; i++) {
    stepWorld(w)
    if (hitFrom === undefined) {
      const ev = w.events.find(e => e.type === 'deliveryFired')
      if (ev !== undefined && ev.type === 'deliveryFired') {
        hitFrom = ev.from
        targetAt = { x: target.pos.x, y: target.pos.y }
      }
    }
    events.push(...w.events)
  }
  return { events, hitFrom, targetAt }
}

{
  /*
   * ⚠ 玩家自己做的第一条素材是「魔法飞弹 · 命中火花」。
   *
   *   关键在于**时机**：投射物发射的那一刻不发特效事件
   *   （它自己是实体，客户端已经在画它了），
   *   只有**命中**才发 —— 而且坐标是目标身上，不是发射点。
   *
   *   搞错了的表现是：火花在手里炸，而不是在敌人身上炸。
   */
  const { w, a, b } = arena()

  const BOLT = tech('tech.hitspark', {
    phases: [phase('cast', 0.05)],
    rules: [rule('phaseComplete', [{
      delivery: { kind: 'projectile', speed: 12, lifetime: 1, vfx: 'fx.spark-test' },
      payload: { kind: 'damage', amount: { const: 10 }, damageType: 'arcane' },
    }], { phaseId: 'cast' })],
  })

  a.facing = { x: 1, y: 0 }
  b.pos.x = 4
  b.pos.y = 0

  activate(w, a, BOLT, { targetId: b.id })
  const { events, hitFrom, targetAt } = runCollectingWithTarget(w, b, 40)

  const fired = events.filter(e => e.type === 'deliveryFired')
  eq('整段飞行只发了 1 条命中特效事件（发射时不发）', fired.length, 1)

  const hit = fired[0]
  ok('拿到了落点', hitFrom !== undefined && targetAt !== undefined)
  if (hit !== undefined && hit.type === 'deliveryFired' && hitFrom !== undefined && targetAt !== undefined) {
    eq('载体类型标成 projectile', hit.kind, 'projectile')
    eq('带上了作者指定的特效 id', hit.vfx, 'fx.spark-test')
    eq('伤害类型一起带上（上色要用）', hit.damageType, 'arcane')
    eq('打中了 1 个', hit.hitCount, 1)

    /*
     * ⚠ 落点必须在**目标的表面**上，不是目标中心。
     *
     *   玩家指出来过：打在体型大的 Boss 身上时，用中心点会**看起来像自爆** ——
     *   火花从怪物身体正中炸开，而不是在身上炸开。
     *
     *   子弹从左边来 → 接触点应该在目标的**左边缘**，
     *   也就是离中心恰好一个目标半径。
     */
    const dx = hitFrom.x - targetAt.x
    const dy = hitFrom.y - targetAt.y
    const dist = Math.sqrt(dx * dx + dy * dy)
    near('落点离目标中心的距离 = 目标半径（贴在表面上）', dist, b.radius, 1e-9)
    ok('而且落在**来向那一侧**（左边缘），不是中心',
      hitFrom.x < targetAt.x - b.radius * 0.9,
      `落点 x=${hitFrom.x.toFixed(3)}，中心 x=${targetAt.x.toFixed(3)}，半径 ${b.radius}`)
    ok('不在施法者身上', Math.abs(hitFrom.x - a.pos.x) > 1,
      `落点 x=${hitFrom.x.toFixed(2)}，施法者 x=${a.pos.x.toFixed(2)}`)
  }
}

{
  /*
   * 大体型 Boss：落点也要在它自己的表面上。
   *
   * 这一条是玩家那条意见的核心 —— 半径越大，中心点和表面点差得越远，
   * "自爆"的观感就越明显。小怪身上看不出问题，Boss 身上一眼就露馅。
   */
  const { w, a, b } = arena()
  b.radius = 3          // 体型放大到 3 米
  b.pos.x = 8

  const BOLT = tech('tech.bossbolt', {
    phases: [phase('cast', 0.05)],
    rules: [rule('phaseComplete', [{
      delivery: { kind: 'projectile', speed: 14, lifetime: 2, vfx: 'fx.spark-boss' },
      payload: { kind: 'damage', amount: { const: 10 }, damageType: 'arcane' },
    }], { phaseId: 'cast' })],
  })

  a.facing = { x: 1, y: 0 }
  activate(w, a, BOLT, { targetId: b.id })
  const { hitFrom, targetAt } = runCollectingWithTarget(w, b, 60)

  ok('Boss 身上也发了命中特效', hitFrom !== undefined && targetAt !== undefined)
  if (hitFrom !== undefined && targetAt !== undefined) {
    const dist = Math.sqrt((hitFrom.x - targetAt.x) ** 2 + (hitFrom.y - targetAt.y) ** 2)
    near('落点在 Boss 的表面上（离中心整整 3 米）', dist, 3, 1e-9)
    ok('中心点会差整整 3 米 —— 那就是"自爆"观感的来源',
      Math.abs(hitFrom.x - targetAt.x) > 2.9,
      `落点 x=${hitFrom.x.toFixed(2)}，中心 x=${targetAt.x.toFixed(2)}`)
  }
}

{
  // 没写 vfx 的投射物**不发**这条 —— 现有内容应该一条都不受影响
  const { w, a, b } = arena()
  const PLAIN = tech('tech.plainbolt', {
    phases: [phase('cast', 0.05)],
    rules: [rule('phaseComplete', [{
      delivery: { kind: 'projectile', speed: 12, lifetime: 1 },
      payload: { kind: 'damage', amount: { const: 10 } },
    }], { phaseId: 'cast' })],
  })

  a.facing = { x: 1, y: 0 }
  b.pos.x = 4
  b.pos.y = 0

  activate(w, a, PLAIN, { targetId: b.id })
  const events = runCollecting(w, 40)

  eq('没写 vfx 的投射物不发命中特效事件（对现有内容零影响）',
    events.filter(e => e.type === 'deliveryFired').length, 0)
  ok('但伤害照常结算', getStored(b, 'char.hp.current') < 200)
}

// ---------------------------------------------------------------- 3. 光束

section('光束：有宽度的线段')

{
  const { w, a, b } = arena()
  b.pos = at(6, 0)
  const front = spawn(w, { faction: 'enemy', pos: { x: 3, y: 0 }, base: { 'char.hp.max': 200 } })
  const side = spawn(w, { faction: 'enemy', pos: { x: 3, y: 5 }, base: { 'char.hp.max': 200 } })
  const behind = spawn(w, { faction: 'enemy', pos: { x: -3, y: 0 }, base: { 'char.hp.max': 200 } })

  const BEAM = tech('tech.beam', {
    phases: [phase('cast', 0.1)],
    rules: [rule('phaseComplete', [{
      delivery: { kind: 'beam', length: 8, width: 1 },
      payload: { kind: 'damage', amount: { const: 30 } },
    }], { phaseId: 'cast' })],
  })
  registerTechnique(w, BEAM)

  activate(w, a, BEAM, { targetId: b.id })
  advance(w, 30)

  eq('正前方 3 米的吃到了', getStored(front, 'char.hp.current'), 170)
  eq('正前方 6 米的也吃到了', getStored(b, 'char.hp.current'), 170)
  eq('侧边 5 米的没吃到（光束只有 1 米宽）', getStored(side, 'char.hp.current'), 200)
  eq('背后的没吃到', getStored(behind, 'char.hp.current'), 200)
}

// ---------------------------------------------------------------- 4. 确定性

section('多单位场景的确定性')

function battlefield(seed: number): World {
  const w = createWorld({ seed })
  const mk = (label: string, faction: 'player' | 'enemy', x: number, y: number): Entity => {
    const e = spawn(w, {
      faction,
      pos: { x, y },
      base: { 'char.hp.max': 300, 'char.energy.regen': 10, 'char.speed': 5 },
    })
    e.ai = { targetFaction: 'enemyOfSelf', preferredRange: 3, thinkInterval: 0.25 }
    return e
  }
  const BOLT = tech('tech.test-bolt', {
    activation: 'press',
    phases: [phase('cast', 0.2, { cost: { cooldown: 1.2, energy: 10 } })],
    rules: [rule('phaseComplete', [{
      delivery: { kind: 'projectile', speed: 10, lifetime: 2, radius: 0.3 },
      payload: { kind: 'damage', amount: { const: 18 } },
    }], { phaseId: 'cast' })],
  })
  registerTechnique(w, BOLT)
  mk('x', 'player', -6, 0)
  mk('y', 'enemy', 6, 0)
  // ⚠ 这行必须在 mk 之后 —— 放前面的话两个单位建出来时 techniqueIds 还是空的
  for (const e of w.entities) e.techniqueIds = ['tech.test-bolt']
  return w
}

{
  const w1 = battlefield(99)
  const w2 = battlefield(99)
  advance(w1, 600)
  advance(w2, 600)

  const s1 = JSON.stringify(snapshot(w1))
  const s2 = JSON.stringify(snapshot(w2))
  ok('四个单位互相扔投射物，跑 600 tick 结果逐字节一致', s1 === s2,
    s1 === s2 ? undefined : 'AI 或投射物里混进了不确定的东西')
}

{
  const w1 = battlefield(1)
  advance(w1, 600)
  ok('打完之后有人掉血了（不是站着不动）',
    w1.entities.some(e => getStored(e, 'char.hp.current') < resolveMaxHp(e)),
    '两边都在放技能的话总该有人挨打')
}

function resolveMaxHp(e: Entity): number {
  return e.base.get('char.hp.max') ?? 0
}

// ---------------------------------------------------------------- 5. 两个实测出来的 bug

section('玩家实测报的两个 bug')

/*
 * bug 1：无下限对子弹不生效。
 *
 * 根因有两层：
 *   1. 投射物的阵营是 neutral —— 而 isHostileTo 对 neutral 一律返回 false，
 *      所以光环的 valid: ['enemy'] 永远匹配不到子弹
 *   2. integrate() 里写了 "只有 actor 吃 moveScale" —— 我当时觉得
 *      "子弹不该因为发射者被减速而变慢"。但减速是挂在子弹自己身上的，
 *      而且「靠近的东西自动减速」本来就该管子弹 —— 这是那个术式的全部意义
 */
{
  const { w, a, b } = arena()
  b.pos = at(8, 0)

  const SLOW: StatusDef = {
    id: 'status.test-slow',
    name: '迟滞',
    tags: ['softCC', 'debuff'],
    duration: 3,
    modifiers: [{ path: 'char.moveScale', op: 'mul', value: { const: 0.25 } }],
  }

  const AURA = tech('tech.test-aura', {
    activation: 'toggle',
    targeting: { mode: 'self', valid: ['self'] },
    phases: [phase('cast', 0.01)],
    rules: [rule('onTick', [{
      valid: ['enemy'],
      delivery: { kind: 'area', radius: 12 },
      payload: { kind: 'status', verb: 'apply', inline: SLOW },
    }], { every: 0.1 })],
  })

  const SHOOTER = tech('tech.test-shoot', {
    phases: [phase('cast', 0.1)],
    rules: [rule('phaseComplete', [{
      delivery: { kind: 'projectile', speed: 8, lifetime: 3, radius: 0.3 },
      payload: { kind: 'damage', amount: { const: 10 } },
    }], { phaseId: 'cast' })],
  })

  registerTechnique(w, AURA)
  registerTechnique(w, SHOOTER)
  setTechniqueActive(w, a, 'tech.test-aura', true)

  b.facing = { x: -1, y: 0 }
  activate(w, b, SHOOTER, { targetId: a.id })

  advance(w, 30)
  const bullet = w.entities.find(e => e.kind === 'projectile')
  ok('子弹已经出去了', bullet !== undefined)

  if (bullet !== undefined) {
    ok('投射物继承了发射者的阵营（不是 neutral）', bullet.faction === 'enemy',
      `实际 ${bullet.faction}`)
    ok('光环给子弹挂上了减速', bullet.statuses.some(s => s.defId === 'status.test-slow'),
      `子弹身上的状态：${bullet.statuses.map(s => s.defId).join(',') || '（无）'}`)
    const scale = resolveAttribute(bullet, 'char.moveScale', { world: w, self: bullet })
    near('子弹的移速倍率被压到 0.25', scale, 0.25)
  }
}

/*
 * bug 2：玩家不会死。
 *
 * 根因是内容：名刀·司命没有冷却，所以**每一次**致命伤都被它拦下来，
 * 玩家因此永远死不了 —— 实测的时候砍了半天血一直是满的。
 *
 * 这个测试直接读**真内容文件**，不是抄一份 —— 抄一份的话，
 * 内容改了测试还是绿的，那就白测了。
 */
{
  const { w, a, b } = arena()

  /*
   * 读**真内容文件**，不是抄一份 —— 抄一份的话内容改了测试还是绿的。
   *
   * 分层之后要多走一步：技能 → 术式 → **编译产物**。
   * 引擎只认编译产物，所以这里用 loadLibrary 把整条链跑完。
   */
  const lib = loadLibrary(readJson<BalanceConfig>(resolve('content/balance.json')))
  /*
   * ⚠ 名刀·司命那份出厂示范删了（2026-09-21 把示范术式清了），
   *   但**技能**还在，测试要的只是它编译出来的样子 —— 所以现造一份。
   */
  const blade = probeTechnique(lib, 'tech.named-blade')
  ok('造得出名刀·司命（技能还在内容里）', blade !== undefined)
  if (blade === undefined) throw new Error('skill.named-blade 没编译出来（内容坏了吗？）')

  installTechnique(w, blade)
  setTechniqueActive(w, a, blade.id, true)

  const first = dealDamage(w, b.id, a.id, 9999, { mode: 'lethal' })
  eq('第一次致命伤被拦下', first.intercepted, true)
  eq('玩家还活着', a.alive, true)
  ok('身上多了「司命」无敌', a.statuses.some(s => s.defId === 'status.namedBlade.invuln'))
  ok('并且进入了冷却', a.statuses.some(s => s.defId === 'status.namedBlade.spent'))

  // 等无敌（1.5 秒）过去，但冷却（25 秒）还在
  advance(w, 120)
  ok('无敌已经消了', !a.statuses.some(s => s.defId === 'status.namedBlade.invuln'))
  ok('冷却还在', a.statuses.some(s => s.defId === 'status.namedBlade.spent'))

  // 冷却期内再来一发必杀 —— 这次拦不住了
  const second = dealDamage(w, b.id, a.id, 9999, { mode: 'lethal' })
  eq('冷却期内第二发必杀拦不住', second.intercepted, false)
  eq('玩家死了', a.alive, false)
  ok('推出了 died 事件', w.events.some(e => e.type === 'died' && e.entityId === a.id))
}

// ---------------------------------------------------------------- 6. 打击感

section('打击感：顿帧与击退')

{
  const { w, a, b } = arena()
  b.pos = at(2, 0)

  // 60 / 200 = 30% 的血 → 0.18 秒，被上限压到 0.12
  dealDamage(w, a.id, b.id, 60)
  ok('打掉三成血会产生顿帧', w.hitstop > 0, `实际 ${w.hitstop}`)
  near('顿帧被上限压住', w.hitstop, 0.12, 1e-9)

  // 顿帧期间：世界停住，但 tick 照走
  b.vel = { x: 5, y: 0, z: 0 }
  const x0 = b.pos.x
  const tick0 = w.tick
  stepWorld(w)

  eq('顿帧期间位置不动', b.pos.x, x0)
  eq('但 tick 照样推进（停的是世界，不是时间）', w.tick, tick0 + 1)
  ok('顿帧在倒计时', w.hitstop < 0.12)

  // 跑完顿帧之后，世界恢复
  advance(w, 30)
  eq('顿帧会结束', w.hitstop, 0)
  ok('世界恢复运转，目标动了', b.pos.x > x0)
}

{
  const { w, a, b } = arena()
  b.pos = at(2, 0)

  // DOT 每 0.5 秒跳一次，如果每次都快照一下，游戏会变成幻灯片
  dealDamage(w, a.id, b.id, 5)
  eq('小伤害不触发顿帧', w.hitstop, 0)
}

{
  const { w, a, b } = arena()
  b.pos = at(2, 0)

  dealDamage(w, a.id, b.id, 60)
  ok('目标被往远离施法者的方向推开', b.push.x > 0, `push.x = ${b.push.x}`)

  const away = b.pos.x
  advance(w, 60)
  ok('击退真的移动了它', b.pos.x > away, `${away} → ${b.pos.x}`)

  // 冲量会衰减到停
  advance(w, 120)
  ok('冲量衰减到零，不会一直滑下去',
    b.push.x === 0 && b.push.y === 0, `push = (${b.push.x}, ${b.push.y})`)
}

{
  const { w, a, b } = arena()
  b.pos = at(2, 0)
  const before = dealDamage(w, a.id, b.id, 80)
  ok('大伤害的顿帧不会短于小伤害', before.applied > 0)

  const w2 = arena()
  w2.b.pos = at(2, 0)
  dealDamage(w2.w, w2.a.id, w2.b.id, 20)

  // 80/200 = 40% vs 20/200 = 10%，前者顿得更久（都还没撞到上限）
  ok('打掉的血越多，顿得越久', w.hitstop >= w2.w.hitstop,
    `${w.hitstop} vs ${w2.w.hitstop}`)
}

{
  // 顿帧不能破坏确定性
  const mk = (): World => {
    const w = createWorld({ seed: 21 })
    const p = spawn(w, { faction: 'player', pos: at(0, 0), base: { 'char.hp.max': 300 } })
    const e = spawn(w, { faction: 'enemy', pos: at(2, 0), base: { 'char.hp.max': 300 } })
    p.facing = { x: 1, y: 0 }
    return w
  }
  const w1 = mk()
  const w2 = mk()
  for (let i = 0; i < 40; i++) {
    dealDamage(w1, 1, 2, 40)
    dealDamage(w2, 1, 2, 40)
    advance(w1, 30)
    advance(w2, 30)
  }
  ok('反复顿帧之后结果仍然逐字节一致',
    JSON.stringify(snapshot(w1)) === JSON.stringify(snapshot(w2)))
}

// ---------------------------------------------------------------- 7. 状态的 onTick

section('状态上的 onTick 钩子（持续伤害）')

/*
 * 这个以前**完全没跑**。
 *
 * 管线里的 matchWhen 对 onTick 一律返回 false，所以状态钩子写
 * `when: 'onTick'` 等于没写 —— soul-rend 的裂魂创伤一直是白挂的，
 * 只是它一击就把目标秒了，没人发现。
 *
 * 做编辑器的「＋命中持续伤害」模板时才撞出来。
 */
{
  const { w, a, b } = arena()

  const DOT: StatusDef = {
    id: 'status.test-dot',
    name: '灼烧',
    tags: ['debuff', 'dot'],
    duration: 3,
    removal: { expires: true },
    hooks: [{
      stage: 'after',
      when: 'onTick',
      every: 0.5,
      then: [{ payload: { kind: 'damage', amount: { const: 10 } } }],
    }],
  }

  applyStatus(w, b, DOT, a.id)
  eq('状态挂上了', b.statuses.length, 1)

  advance(w, 240) // 4 秒，比状态本身还长
  const lost = 200 - getStored(b, 'char.hp.current')

  ok('持续伤害真的在跳（以前是 0）', lost > 0, `掉了 ${lost}`)
  ok('按 every: 0.5 跳，3 秒里大概 5 次',
    lost >= 40 && lost <= 60, `掉了 ${lost}，期望 40~60`)
  ok('状态过期后不再跳', b.statuses.length === 0)
}

{
  const { w, a, b } = arena()

  // 不写 every 就按 1 秒 —— 不该变成每秒 60 次
  const SLOW_DOT: StatusDef = {
    id: 'status.test-dot2',
    name: '慢性毒',
    tags: ['debuff', 'dot'],
    duration: 3,
    removal: { expires: true },
    hooks: [{
      stage: 'after',
      when: 'onTick',
      then: [{ payload: { kind: 'damage', amount: { const: 10 } } }],
    }],
  }

  applyStatus(w, b, SLOW_DOT, a.id)
  advance(w, 240)

  const lost = 200 - getStored(b, 'char.hp.current')
  ok('不写 every 时默认 1 秒一次，不是每 tick 一次',
    lost >= 20 && lost <= 40, `掉了 ${lost}，期望 20~40`)
}

// ---------------------------------------------------------------- AI 救人

section('AI：队友挂了负面状态就去救（findAlly 第一次被用上）')

{
  /*
   * ⚠ 这一条补的是一个**已经存在但没人调用**的能力：引擎里一直有
   *   `findAlly()`，而 AI 一次都没用过 —— 于是"会治疗同伴的敌人"
   *   根本做不出来：不是技能写不出来，是**没有人会去放它**。
   *
   *   判据全部是内容驱动的，这个函数里没有一条硬编码：
   *     · 什么算"有难"     → 身上挂着带 debuff / curse 标签的状态
   *     · 哪个术式算"救人" → `targeting.valid` 里有 ally
   */
  const w = createWorld({ seed: 11 })

  const heal = tech('heal-ally', {
    targeting: { mode: 'locked', valid: ['ally'], range: 8 },
    /*
     * ⚠ `phaseId` 不能省。
     *
     *   编译器会给阶段 id 加 `技能id#` 前缀（`skill.heal-ally#cast`），
     *   规则里的 `phaseId` 会被**一起改写** —— 但前提是它得有值。
     *   不写的话 `runRules` 的过滤条件
     *   （`opts.phaseId === undefined || r.phaseId === opts.phaseId`）永远不成立，
     *   规则**静默地**不触发：看起来像"治疗没生效"，其实是根本没跑。
     *   写这条测试时踩过一次（症状是"AI 明明放了治疗术式，血量纹丝不动"），
     *   所以在这里写清楚。
     */
    rules: [rule('phaseComplete', [{
      payload: { kind: 'heal', amount: { const: 40 } },
    }], { phaseId: 'cast' })],
  })
  const punch = tech('punch', {
    targeting: { mode: 'directional', valid: ['enemy'], range: 6 },
    rules: [rule('phaseComplete', [{
      delivery: { kind: 'meleeArc', radius: 2.5, angle: 120 },
      payload: { kind: 'damage', amount: { const: 30 } },
    }], { phaseId: 'cast' })],
  })
  registerTechnique(w, heal)
  registerTechnique(w, punch)

  // 两个敌人（同阵营）+ 一个玩家（敌人眼里的敌人）
  const medic = spawn(w, {
    faction: 'enemy', pos: { x: 0, y: 0 },
    base: { 'char.hp.max': 200, 'char.energy.max': 100, 'char.energy.regen': 0, 'char.speed': 5 },
    techniqueIds: ['heal-ally', 'punch'],
  })
  medic.ai = { targetFaction: 'enemyOfSelf', preferredRange: 2, thinkInterval: 0.2 }

  const wounded = spawn(w, {
    faction: 'enemy', pos: { x: 3, y: 0 },
    base: { 'char.hp.max': 200, 'char.energy.regen': 0 },
  })
  const hero = spawn(w, {
    faction: 'player', pos: { x: 6, y: 0 },
    base: { 'char.hp.max': 400, 'char.energy.regen': 0, 'char.speed': 0 },
  })
  hero.ai = { targetFaction: 'enemyOfSelf', preferredRange: 2, thinkInterval: 0.2 }

  // 队友先被打伤（不然治疗看不出来）
  setStored(wounded, 'char.hp.current', 100)

  // ① 队友身上**没有**负面状态 → 不救，正常打人
  advance(w, 30)
  eq('队友身上什么都没有时不浪费技能', wounded.statuses.length, 0)
  ok('  该打人还是打人', hero.alive, '玩家应该被打到了')
  const hpAfterNoNeed = getStored(wounded, 'char.hp.current')
  eq('  队友没被顺手治疗（治疗术式只对 ally，打不到它）', hpAfterNoNeed, 100)

  // ② 给队友挂一个 debuff → AI 应该去救
  applyStatus(w, wounded, {
    id: 'status.probe-curse', name: '诅咒', tags: ['debuff', 'curse'], duration: 10,
  }, medic.id)
  advance(w, 30)

  ok('队友被诅咒之后 AI 放了治疗术式（血量涨了）',
    getStored(wounded, 'char.hp.current') > 100,
    `${hpAfterNoNeed} → ${getStored(wounded, 'char.hp.current')}`)
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
