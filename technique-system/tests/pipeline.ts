/**
 * 六步伤害管线的测试。
 *
 * 这里覆盖的每一条，都是前面十几轮讨论里点名要的效果：
 *   名刀司命、护盾、次数盾、龟壳、亡灵反转、吸血、反伤、
 *   越近越慢（动态参数）、触发链上限。
 *
 * 测试用的是**状态挂的钩子**（技能图挂的钩子要等第 4 步）。
 */
import {
  advance, applyStatus, createHit, createWorld, dealDamage, distance, evaluateCondition,
  executeAction, findHostile, getStored, hasStatusTag, heal, registerStatusDef, resolveAim,
  resolveHit, resolveValue, setStored, spawn, visibilityOf,
} from '../src/sim/index.ts'
import type { ActionContext, Entity, World } from '../src/sim/index.ts'
import type { Action, PipelineHook, StatusDef } from '../src/schema.ts'

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

function throws(name: string, fn: () => void, needle: string): void {
  try {
    fn()
    ok(name, false, '本该抛错但没有')
  } catch (e) {
    const msg = (e as Error).message
    ok(name, msg.includes(needle), `错误信息里没有「${needle}」：${msg}`)
  }
}

function section(title: string): void {
  console.log(`\n${title}`)
}

// ---------------------------------------------------------------- 夹具

function status(id: string, over: Partial<StatusDef> = {}): StatusDef {
  return { id, name: id, tags: [], duration: 5, ...over }
}

const cancel: Action = {
  payload: { kind: 'attribute', path: 'pipeline.cancelled', op: 'set', value: { const: 1 } },
}

const reverse: Action = {
  payload: { kind: 'attribute', path: 'pipeline.reverse', op: 'set', value: { const: 1 } },
}

/** 名刀司命：免疫致命伤害，并给自己挂一段无敌 */
const INVULNERABLE = status('status.invulnerable', {
  tags: ['buff'],
  duration: 2,
  hooks: [{ stage: 'intercept', then: [cancel] }],
})

const NAMED_BLADE = status('status.namedBlade', {
  tags: ['buff'],
  duration: 99,
  hooks: [{
    stage: 'intercept',
    when: 'onLethalDamage',
    then: [
      cancel,
      { target: 'self', payload: { kind: 'status', verb: 'apply', inline: INVULNERABLE } },
    ],
  }],
})

/** 护盾：吸 500 点 */
const SHIELD = status('status.shield', {
  tags: ['buff', 'shield'],
  duration: 8,
  hooks: [{ stage: 'absorb', absorb: { mode: 'damage', perStack: 500 } }],
})

/** 次数盾：挡 3 次命中，不管多疼 */
const HIT_SHIELD = status('status.hitShield', {
  tags: ['buff', 'shield'],
  duration: 8,
  stack: { max: 9, behavior: 'refresh' },
  hooks: [{ stage: 'absorb', absorb: { mode: 'hits', perStack: 1 } }],
})

/** 龟壳：把伤害转成治疗 */
const TURTLE_SHELL = status('status.turtleShell', {
  tags: ['buff'],
  duration: 5,
  hooks: [{ stage: 'modify', if: [{ type: 'hitKindIs', value: 'damage' }], then: [reverse] }],
})

/** 减伤 50% */
const GUARD = status('status.guard', {
  tags: ['buff'],
  duration: 5,
  hooks: [{
    stage: 'modify',
    then: [{ payload: { kind: 'attribute', path: 'pipeline.amount', op: 'mul', value: { const: 0.5 } } }],
  }],
})

/** 吸血：造成伤害后给自己回 10 点。长在**打人**那一侧 */
const LIFESTEAL = status('status.lifesteal', {
  tags: ['buff'],
  duration: 10,
  hooks: [{
    stage: 'after',
    side: 'source',
    if: [{ type: 'hitKindIs', value: 'damage' }],
    then: [{ target: 'self', payload: { kind: 'heal', amount: { const: 10 } } }],
  }],
})

/** 反伤：被打之后弹回去 7 点。长在**被打**那一侧（默认） */
const THORNS = status('status.thorns', {
  tags: ['buff'],
  duration: 10,
  hooks: [{
    stage: 'after',
    if: [{ type: 'hitKindIs', value: 'damage' }],
    then: [{
      
      payload: { kind: 'damage', amount: { const: 7 }, damageType: 'physical' },
    }],
  }],
})

/** 越近越疼：距离 0 米 ×2，10 米 ×1 */
const CLOSE_BONUS = status('status.closeBonus', {
  tags: ['buff'],
  duration: 5,
  hooks: [{
    stage: 'modify',
    then: [{
      payload: {
        kind: 'attribute', path: 'pipeline.amount', op: 'mul',
        value: { ref: 'distance', curve: [[0, 2], [10, 1]] },
      },
    }],
  }],
})

/**
 * 残血增伤：损失多少血就加多少倍。
 *
 * 注意这里用了 curve —— 动态参数本身只是一个数，
 * 要把它变成倍率必须靠曲线映射：[损失0% → ×1, 损失100% → ×2]。
 */
const DESPERATE = status('status.desperate', {
  tags: ['buff'],
  duration: 5,
  hooks: [{
    stage: 'modify',
    then: [{
      payload: {
        kind: 'attribute', path: 'pipeline.amount', op: 'mul',
        value: { ref: 'missingHpPct', curve: [[0, 1], [1, 2]] },
      },
    }],
  }],
})

/** 亡灵生物天生带的被动：治疗进来会变成伤害 */
const UNDEAD_REVERSAL: PipelineHook = {
  stage: 'modify',
  if: [{ type: 'hitKindIs', value: 'heal' }],
  then: [reverse],
}

// ---------------------------------------------------------------- 场景搭建

function arena(): { w: World; a: Entity; b: Entity } {
  const w = createWorld({ seed: 7 })
  for (const d of [INVULNERABLE, NAMED_BLADE, SHIELD, HIT_SHIELD, TURTLE_SHELL, GUARD,
    LIFESTEAL, THORNS, CLOSE_BONUS, DESPERATE]) {
    registerStatusDef(w, d)
  }
  const a = spawn(w, { faction: 'player', pos: { x: 0, y: 0 }, base: { 'char.hp.max': 100 } })
  const b = spawn(w, { faction: 'enemy', pos: { x: 10, y: 0 }, base: { 'char.hp.max': 100 } })
  return { w, a, b }
}

// ---------------------------------------------------------------- 1. 基本流程

section('基本伤害与治疗')

{
  const { w, a, b } = arena()
  const hit = dealDamage(w, a.id, b.id, 30)

  eq('扣了 30 血', getStored(b, 'char.hp.current'), 70)
  eq('命中成立', hit.connected, true)
  eq('实际生效 30', hit.applied, 30)
  ok('六个阶段都走过了',
    hit.stages.join(',') === 'raw,intercept,modify,absorb,apply,after',
    hit.stages.join(','))
  ok('推出了 damaged 事件', w.events.some(e => e.type === 'damaged' && e.amount === 30))
}

{
  const { w, a, b } = arena()
  setStored(b, 'char.hp.current', 40)
  dealDamage(w, a.id, b.id, 50)

  eq('血量不会变成负数', getStored(b, 'char.hp.current'), 0)
  eq('实体死了', b.alive, false)
  ok('推出了 died 事件', w.events.some(e => e.type === 'died' && e.killerId === a.id))
}

{
  const { w, a, b } = arena()
  setStored(b, 'char.hp.current', 100)
  dealDamage(w, a.id, b.id, 20, { mode: 'lethal' })

  eq('必杀无视血量直接清零', getStored(b, 'char.hp.current'), 0)
  eq('实体死了', b.alive, false)
}

{
  const { w, a, b } = arena()
  setStored(b, 'char.hp.current', 50)
  const h = heal(w, a.id, b.id, 30)

  eq('治疗回血', getStored(b, 'char.hp.current'), 80)
  eq('走的同一条管线', h.stages.length, 6)
  ok('推出了 healed 事件', w.events.some(e => e.type === 'healed'))
}

{
  const { w, a, b } = arena()
  setStored(b, 'char.hp.current', 90)
  heal(w, a.id, b.id, 50)
  eq('治疗不超过上限', getStored(b, 'char.hp.current'), 100)
}

// ---------------------------------------------------------------- 2. 拦截

section('第 2 步 拦截：名刀司命')

{
  const { w, a, b } = arena()
  applyStatus(w, b, NAMED_BLADE, b.id)

  const hit = dealDamage(w, a.id, b.id, 9999, { mode: 'lethal' })

  eq('没有掉血', getStored(b, 'char.hp.current'), 100)
  ok('还活着', b.alive)
  eq('被标记为拦截', hit.intercepted, true)
  eq('记下了是谁拦的', hit.interceptedBy, 'status.namedBlade')
  eq('没有生效伤害', hit.applied, 0)
  ok('推出了 hitIntercepted 事件', w.events.some(e => e.type === 'hitIntercepted'))
  ok('顺便挂上了无敌', b.statuses.some(s => s.defId === 'status.invulnerable'))
}

{
  const { w, a, b } = arena()
  applyStatus(w, b, NAMED_BLADE, b.id)

  dealDamage(w, a.id, b.id, 9999, { mode: 'lethal' })
  // 无敌还在，第二发普通攻击也该被挡住
  const second = dealDamage(w, a.id, b.id, 30)

  eq('无敌期间第二发也被拦住', second.intercepted, true)
  eq('血量一点没掉', getStored(b, 'char.hp.current'), 100)
}

{
  const { w, a, b } = arena()
  applyStatus(w, b, NAMED_BLADE, b.id)
  // 不致命的伤害，名刀不该触发
  const hit = dealDamage(w, a.id, b.id, 30)

  eq('非致命伤害不触发名刀', hit.intercepted, false)
  eq('照常掉血', getStored(b, 'char.hp.current'), 70)
}

// ---------------------------------------------------------------- 3. 修正

section('第 3 步 修正：减伤、增伤、龟壳')

{
  const { w, a, b } = arena()
  applyStatus(w, b, GUARD, b.id)
  dealDamage(w, a.id, b.id, 40)
  eq('减伤 50% 之后只掉 20', getStored(b, 'char.hp.current'), 80)
}

{
  const { w, a, b } = arena()
  applyStatus(w, b, TURTLE_SHELL, b.id)

  const before = getStored(b, 'char.hp.current')
  const hit = dealDamage(w, a.id, b.id, 40)

  eq('龟壳把伤害翻转成了治疗', getStored(b, 'char.hp.current'), before)
  eq('管线里 kind 被翻转了', hit.kind, 'heal')
  ok('推出了 healed 而不是 damaged', w.events.some(e => e.type === 'healed'))
}

{
  const { w, a, b } = arena()
  // 残血时龟壳会把伤害变成治疗 —— 这正是它危险的地方，玩家必须能看见
  setStored(b, 'char.hp.current', 20)
  applyStatus(w, b, TURTLE_SHELL, b.id)
  dealDamage(w, a.id, b.id, 40)
  eq('残血 Boss 缩壳会回血（40 伤害变成 40 治疗）', getStored(b, 'char.hp.current'), 60)
}

{
  const { w, a, b } = arena()
  setStored(b, 'char.hp.current', 90)
  applyStatus(w, b, TURTLE_SHELL, b.id)
  dealDamage(w, a.id, b.id, 40)
  eq('翻转后的治疗也不超过上限', getStored(b, 'char.hp.current'), 100)
}

// ---------------------------------------------------------------- 4. 吸收

section('第 4 步 吸收：护盾与次数盾')

{
  const { w, a, b } = arena()
  applyStatus(w, b, SHIELD, b.id)

  const hit = dealDamage(w, a.id, b.id, 100)
  eq('500 点护盾吃掉 100 点，血量不动', getStored(b, 'char.hp.current'), 100)
  eq('记录吸收了 100', hit.absorbed, 100)
  eq('实际生效 0', hit.applied, 0)
  eq('护盾还剩 400', b.statuses[0]?.vars['pool'], 400)
}

{
  const { w, a, b } = arena()
  applyStatus(w, b, SHIELD, b.id)

  dealDamage(w, a.id, b.id, 300)
  eq('打掉 300，护盾剩 200', b.statuses[0]?.vars['pool'], 200)

  const hit = dealDamage(w, a.id, b.id, 500)
  eq('超出护盾的部分照常扣血', getStored(b, 'char.hp.current'), 0)
  eq('总共吸收了 200', hit.absorbed, 200)
  ok('护盾打空就消失', !b.statuses.some(s => s.defId === 'status.shield'))
  ok('推出了 shieldBroken 事件', w.events.some(e => e.type === 'shieldBroken'))
}

{
  const { w, a, b } = arena()
  applyStatus(w, b, HIT_SHIELD, b.id, 3)

  const h1 = dealDamage(w, a.id, b.id, 1)
  const h2 = dealDamage(w, a.id, b.id, 999)
  const h3 = dealDamage(w, a.id, b.id, 5)

  eq('第一次被挡', h1.connected, false)
  eq('第二次（伤害高得多）也被挡', h2.connected, false)
  eq('第三次也被挡', h3.connected, false)
  eq('三次之后血量还是满的', getStored(b, 'char.hp.current'), 100)

  const h4 = dealDamage(w, a.id, b.id, 10)
  eq('次数用完，第四发打进去了', getStored(b, 'char.hp.current'), 90)
  ok('第四发确实生效', h4.connected)
}

{
  const { w, a, b } = arena()
  applyStatus(w, b, SHIELD, b.id)
  const h = heal(w, a.id, b.id, 30)
  eq('护盾不吸治疗', h.absorbed, 0)
  ok('治疗照常生效', h.connected)
}

// ---------------------------------------------------------------- 5. 后置

section('第 6 步 后置：吸血、反伤')

{
  const { w, a, b } = arena()
  setStored(a, 'char.hp.current', 50)
  applyStatus(w, a, LIFESTEAL, a.id)

  dealDamage(w, a.id, b.id, 30)

  eq('敌人掉了 30', getStored(b, 'char.hp.current'), 70)
  eq('自己回了 10', getStored(a, 'char.hp.current'), 60)
}

{
  const { w, a, b } = arena()
  applyStatus(w, b, THORNS, b.id)

  dealDamage(w, a.id, b.id, 30)

  eq('敌人掉了 30', getStored(b, 'char.hp.current'), 70)
  eq('打人的人被弹了 7 点', getStored(a, 'char.hp.current'), 93)
}

{
  // 两边都有反伤 —— 没有深度上限会无限递归
  const { w, a, b } = arena()
  applyStatus(w, a, THORNS, a.id)
  applyStatus(w, b, THORNS, b.id)

  let crashed = false
  try {
    dealDamage(w, a.id, b.id, 30)
  } catch {
    crashed = true
  }

  ok('双向反伤不会把栈打爆（触发链上限生效）', !crashed)
  ok('两边都掉血了', getStored(a, 'char.hp.current') < 100 && getStored(b, 'char.hp.current') < 100)
}

// ---------------------------------------------------------------- 6. 动态参数

section('动态参数（第 3 步才补上的东西）')

{
  const { w, a, b } = arena()
  applyStatus(w, b, CLOSE_BONUS, b.id)

  b.pos.x = 0
  dealDamage(w, a.id, b.id, 10)
  eq('距离 0 米：×2', getStored(b, 'char.hp.current'), 80)

  // 重置再来一次，这次距离 10 米
  const s2 = arena()
  applyStatus(s2.w, s2.b, CLOSE_BONUS, s2.b.id)
  s2.b.pos.x = 10
  dealDamage(s2.w, s2.a.id, s2.b.id, 10)
  eq('距离 10 米：×1', getStored(s2.b, 'char.hp.current'), 90)

  const s3 = arena()
  applyStatus(s3.w, s3.b, CLOSE_BONUS, s3.b.id)
  s3.b.pos.x = 5
  dealDamage(s3.w, s3.a.id, s3.b.id, 10)
  near('距离 5 米：曲线上插值 ×1.5', 100 - getStored(s3.b, 'char.hp.current'), 15, 1e-9)
}

{
  const { w, a, b } = arena()
  setStored(b, 'char.hp.current', 50)
  applyStatus(w, b, DESPERATE, b.id)

  // 损失 50% 血 → 曲线映射成 ×1.5
  dealDamage(w, a.id, b.id, 20)
  near('残血增伤按 missingHpPct 走曲线算', 50 - getStored(b, 'char.hp.current'), 30, 1e-9)
}

{
  const { w, a, b } = arena()
  throws(
    '有 ref 但没有上下文时明确抛错，不静默算 0',
    () => { resolveValue({ ref: 'distance' }) },
    '需要一个上下文',
  )
  ok('有 const 时不需要上下文', resolveValue({ const: 3 }) === 3)
}

// ---------------------------------------------------------------- 7. 条件

section('条件')

{
  const { w, a, b } = arena()
  const undead = spawn(w, {
    faction: 'enemy', tags: ['undead'], base: { 'char.hp.max': 100 }, hooks: [UNDEAD_REVERSAL],
  })
  setStored(undead, 'char.hp.current', 50)

  const h = heal(w, a.id, undead.id, 30)
  eq('治疗打到亡灵身上变成伤害', getStored(undead, 'char.hp.current'), 20)
  eq('管线里 kind 被翻转了', h.kind, 'damage')

  const d = dealDamage(w, a.id, undead.id, 10)
  eq('普通伤害不受影响', getStored(undead, 'char.hp.current'), 10)
  eq('还是伤害', d.kind, 'damage')
  eq('没有反转', d.applied, 10)
}

{
  const { w, a, b } = arena()
  const lowHpRage = status('status.execute', {
    tags: ['debuff'],
    duration: 5,
    hooks: [{
      stage: 'modify',
      if: [{ type: 'hpBelow', who: 'self', value: 0.5 }],
      then: [{ payload: { kind: 'attribute', path: 'pipeline.amount', op: 'mul', value: { const: 3 } } }],
    }],
  })
  applyStatus(w, b, lowHpRage, b.id)

  dealDamage(w, a.id, b.id, 10)
  eq('满血时不触发处决加成', getStored(b, 'char.hp.current'), 90)

  setStored(b, 'char.hp.current', 40)
  dealDamage(w, a.id, b.id, 10)
  eq('残血时伤害 ×3', getStored(b, 'char.hp.current'), 10)
}

// ---------------------------------------------------------------- 8. 顺序与优先级

section('顺序与边界')

{
  const { w, a, b } = arena()
  // 减伤排在护盾**之前**（stage 顺序固定），所以先减半再被吸
  applyStatus(w, b, GUARD, b.id)
  applyStatus(w, b, SHIELD, b.id)

  const hit = dealDamage(w, a.id, b.id, 100)
  eq('减伤先算：100 → 50', hit.rawAmount, 100)
  eq('护盾吸走减伤后的 50', hit.absorbed, 50)
  eq('血量没动', getStored(b, 'char.hp.current'), 100)
}

{
  const { w, a, b } = arena()
  // 两条**不同**的减伤。同一个状态挂两次会被 refresh 行为合并成一个，
  // 那是设计如此（"同一个 buff 刷新时长，不叠加"）。
  const GUARD2 = status('status.guard2', {
    tags: ['buff'],
    duration: 5,
    hooks: [{
      stage: 'modify',
      then: [{ payload: { kind: 'attribute', path: 'pipeline.amount', op: 'mul', value: { const: 0.5 } } }],
    }],
  })
  registerStatusDef(w, GUARD2)

  applyStatus(w, b, GUARD, b.id)
  applyStatus(w, b, GUARD2, b.id)
  dealDamage(w, a.id, b.id, 80)
  eq('两个不同的 50% 减伤叠成 25%（80 → 20）', getStored(b, 'char.hp.current'), 80)
}

{
  const { w, a, b } = arena()
  applyStatus(w, b, GUARD, b.id)
  applyStatus(w, b, GUARD, b.id)
  eq('同一个状态挂两次只会有一份（refresh 行为）',
    b.statuses.filter(s => s.defId === 'status.guard').length, 1)
}

{
  const { w, a, b } = arena()
  throws(
    '动作不能改派生属性（要改就挂状态）',
    () => {
      const ctx: ActionContext = { world: w, self: b, target: b, actor: b, depth: 0 }
      executeAction(ctx, {
        payload: { kind: 'attribute', path: 'char.speed', op: 'add', value: { const: 1 } },
      })
    },
    '派生属性',
  )
}

{
  const { w, a, b } = arena()
  throws(
    '认不出的载荷会明确报错，不静默吞掉',
    () => {
      const ctx: ActionContext = { world: w, self: b, target: b, actor: b, depth: 0 }
      /*
       * ⚠ 七种载荷**全部实现完了**（attribute / damage / heal / status /
       *   displacement / perception / spawn），所以这条测试只能用一个人造的
       *   未知 kind 来跑。
       *
       *   它守的是**以后**：schema 加了第八种载荷而忘了实现时，
       *   那个技能应该在放出来的那一刻大声报错，而不是静默什么都不做。
       *   （TypeScript 那一侧也有保障：default 分支里 p 会被收窄成 never，
       *    所以改 schema 的人会先撞上编译错误。）
       */
      executeAction(ctx, {
        payload: { kind: 'teleport-the-whole-map' },
      } as unknown as Action)
    },
    '还没实现',
  )
}

{
  const { w, a, b } = arena()
  // 目标已经死了，管线不该再跑
  b.alive = false
  const hit = resolveHit(w, createHit({ sourceId: a.id, targetId: b.id, amount: 10 }))
  eq('打不到死掉的目标', hit.connected, false)
  eq('一个阶段都没跑', hit.stages.length, 0)
}

{
  const { w, a } = arena()
  // 状态时长和管线互不干扰
  applyStatus(w, a, GUARD, a.id)
  advance(w, 60 * 6)
  eq('状态到期后自动清掉', a.statuses.length, 0)
}

// ============================================================================
//  位移载荷
// ============================================================================
//
// ⚠ 这一组测的核心是**距离的契约**：载荷上写 3 米，就该移动 3 米。
//
//   实现上位移是冲量（每次 tick 按 0.85 衰减），而载荷写的是米。
//   中间那次换算 `p₀ = distance · (1 − d) / dt` 里有个 dt ——
//   漏掉它冲量会小 60 倍，表现是"写了 3 米，实际推了 5 厘米"。
//   这个 bug 不会报错，只会让手感悄悄变错，所以必须钉住。

section('位移：击退 / 拉拽 / 冲刺 / 传送')

/** 让 a 对 b 放一次位移载荷 */
function displace(
  w: World, a: Entity, b: Entity,
  mode: 'knockback' | 'pull' | 'dash' | 'teleport',
  distance: number,
  airborne = false,
): void {
  const ctx: ActionContext = { world: w, self: a, target: b, actor: a, depth: 0 }
  executeAction(ctx, {
    payload: { kind: 'displacement', mode, distance: { const: distance }, airborne },
  })
}

{
  const { w, a, b } = arena()
  eq('开局距离 10 米', distance(a.pos, b.pos), 10)

  displace(w, a, b, 'knockback', 3)
  ok('冲量立刻加上了', Math.abs(b.push.x) > 1, `push.x = ${b.push.x}`)

  advance(w, 240)   // 4 秒，足够衰减干净
  const moved = distance(a.pos, b.pos) - 10
  ok('击退正好把目标推远 3 米',
    Math.abs(moved - 3) < 0.05, `实际推远 ${moved.toFixed(3)} 米`)
}

{
  const { w, a, b } = arena()
  displace(w, a, b, 'pull', 4)
  advance(w, 240)

  const moved = 10 - distance(a.pos, b.pos)
  ok('拉拽正好把目标拉近 4 米',
    Math.abs(moved - 4) < 0.05, `实际拉近 ${moved.toFixed(3)} 米`)
}

{
  const { w, a, b } = arena()
  // b 在正右方，所以"从 a 指向 b"是 +x
  displace(w, a, b, 'knockback', 2)
  advance(w, 240)
  ok('击退方向是"从施法者指向目标"', b.pos.x > 11.9 && Math.abs(b.pos.y) < 1e-6,
    `b.pos = (${b.pos.x.toFixed(2)}, ${b.pos.y.toFixed(2)})`)
}

{
  const { w, a, b } = arena()
  displace(w, a, b, 'pull', 2)
  advance(w, 240)
  ok('拉拽方向和击退相反', b.pos.x < 8.1, `b.pos.x = ${b.pos.x.toFixed(2)}`)
}

{
  const { w, a, b } = arena()
  a.facing = { x: 0, y: 1 }   // 朝 +y
  displace(w, a, b, 'dash', 5)
  advance(w, 240)

  ok('冲刺动的是**施法者自己**，目标没动',
    Math.abs(b.pos.x - 10) < 1e-6 && Math.abs(b.pos.y) < 1e-6,
    `b.pos = (${b.pos.x}, ${b.pos.y})`)
  ok('冲刺沿面向位移了 5 米',
    Math.abs(a.pos.y - 5) < 0.05, `a.pos.y = ${a.pos.y.toFixed(3)}`)
}

{
  const { w, a, b } = arena()
  a.facing = { x: 1, y: 0 }
  displace(w, a, b, 'teleport', 6)

  // ⚠ 不 advance —— 瞬移的定义就是"这一 tick 就到位"
  ok('瞬移不需要时间，当 tick 就到位',
    Math.abs(a.pos.x - 6) < 1e-6, `a.pos.x = ${a.pos.x}`)
  eq('瞬移不留下冲量（否则会继续滑）', a.push.x, 0)
}

{
  const { w, a, b } = arena()
  displace(w, a, b, 'knockback', 3, true)
  ok('击飞加了 z 冲量（渲染能看见弧线）', b.push.z > 0, `push.z = ${b.push.z}`)

  advance(w, 30)
  ok('z 真的在积分（人"飞起来"了）', b.pos.z > 0, `pos.z = ${b.pos.z.toFixed(3)}`)
  ok('但平面判定不受影响 —— z 只管渲染',
    Math.abs(b.pos.y) < 1e-6 && b.pos.x > 10, `b.pos = (${b.pos.x.toFixed(2)}, ${b.pos.y.toFixed(2)})`)
}

{
  const { w, a, b } = arena()
  displace(w, a, b, 'knockback', 3)
  const ev = w.events.find(e => e.type === 'displaced')
  ok('发了 displaced 事件（客户端要靠它画）', ev !== undefined)
  eq('事件里带的是**载荷上写的**距离', ev?.type === 'displaced' ? ev.distance : -1, 3)
  eq('事件指向被推的那个人', ev?.type === 'displaced' ? ev.entityId : -1, b.id)
}

{
  const { w, a, b } = arena()
  // 位移不该顺带造成伤害 —— 它是独立的载荷
  displace(w, a, b, 'knockback', 3)
  advance(w, 60)
  eq('纯击退一点伤害都没有', getStored(b, 'char.hp.current'), 100)
}

{
  const { w, a, b } = arena()
  // 距离是 ValueSpec，可以跟随运行时量
  const ctx: ActionContext = { world: w, self: a, target: b, actor: a, depth: 0 }
  executeAction(ctx, {
    payload: { kind: 'displacement', mode: 'knockback', distance: { ref: 'distance' } },
  })
  advance(w, 240)
  const moved = distance(a.pos, b.pos) - 10
  ok('距离可以引用运行时量（这里 = 距离本身 10 米）',
    Math.abs(moved - 10) < 0.1, `实际推远 ${moved.toFixed(3)} 米`)
}

// ============================================================================
//  暴击
// ============================================================================
//
// ⚠ 在这一次之前，暴击**不存在**：`CRIT_TAG` 有人读（matchWhen、isCrit 条件），
//   但**没有任何地方往里写过**。所以 onCrit / onNonCrit / isCrit
//   三个时机永远不成立 —— 写了等于没写。
//
//   最要紧的一条不是"暴击能不能暴"，而是"不暴击的内容有没有被影响"：
//   rng 是全局有状态的，多掷一次骰子就会把整个随机序列推后一格。

section('暴击')

{
  const { w, a, b } = arena()
  // 默认 critRate 是 0
  const before = w.rngState
  dealDamage(w, a.id, b.id, 10)

  eq('暴击率为 0 时伤害不翻倍', getStored(b, 'char.hp.current'), 90)
  eq('⚠ 暴击率为 0 时**一次骰子都不掷**（随机序列一格没动）', w.rngState, before)
}

{
  const { w, a, b } = arena()
  a.base.set('char.critRate', 1)      // 必暴
  dealDamage(w, a.id, b.id, 10)
  eq('必暴时伤害 ×2', getStored(b, 'char.hp.current'), 80)
}

{
  const { w, a, b } = arena()
  a.base.set('char.critRate', 1)
  a.base.set('char.critDamage', 3)
  dealDamage(w, a.id, b.id, 10)
  eq('暴击倍率可以改（×3）', getStored(b, 'char.hp.current'), 70)
}

{
  const { w, a, b } = arena()
  a.base.set('char.critRate', 0.5)

  // 统计：命中的那些里大概一半是暴击。用同一个世界连打，走真实随机序列
  let crits = 0
  const N = 400
  for (let i = 0; i < N; i++) {
    setStored(b, 'char.hp.current', 1000)
    const hit = dealDamage(w, a.id, b.id, 10)
    if (hit.tags.includes('crit')) crits++
  }
  const rate = crits / N
  ok('50% 暴击率打 400 次，实际落在 40%~60%',
    rate > 0.4 && rate < 0.6, `实际 ${(rate * 100).toFixed(1)}%`)
}

{
  // onCrit / onNonCrit 终于有东西能触发它们了
  const { w, a, b } = arena()
  const onCritHook: StatusDef = {
    id: 'status.test-oncrit',
    name: '暴击回应',
    tags: ['buff'],
    duration: 10,
    hooks: [{
      stage: 'after',
      side: 'source',
      when: 'onCrit',
      // ⚠ target: 'self' 不能省。打人侧的钩子默认目标是**被打的那个**，
      //   不写的话"暴击吸血"会吸到敌人身上（真踩过，见 LIFESTEAL 的注释）
      then: [{ target: 'self', payload: { kind: 'heal', amount: { const: 5 } } }],
    }],
  }
  registerStatusDef(w, onCritHook)

  // 必暴
  applyStatus(w, a, onCritHook, a.id)
  setStored(a, 'char.hp.current', 50)
  a.base.set('char.critRate', 1)
  dealDamage(w, a.id, b.id, 10)
  eq('onCrit 钩子触发了（吸血 5）', getStored(a, 'char.hp.current'), 55)
}

{
  const { w, a, b } = arena()
  const onNonCritHook: StatusDef = {
    id: 'status.test-onnoncrit2',
    name: '未暴击回应',
    tags: ['buff'],
    duration: 10,
    hooks: [{
      stage: 'after',
      side: 'source',
      when: 'onNonCrit',
      then: [{
        target: 'self',
        payload: { kind: 'attribute', path: 'char.energy.current', op: 'add', value: { const: -1 } },
      }],
    }],
  }
  registerStatusDef(w, onNonCritHook)
  applyStatus(w, a, onNonCritHook, a.id)

  setStored(a, 'char.energy.current', 50)
  dealDamage(w, a.id, b.id, 10)   // critRate 默认 0 → 一定不暴击
  eq('onNonCrit 钩子触发了（扣 1 能量）', getStored(a, 'char.energy.current'), 49)
}

{
  const { w, a, b } = arena()
  // isCrit 条件终于能判断了
  const noCrit = createHit({ sourceId: a.id, targetId: b.id, amount: 1 })
  ok('没暴击时 isCrit(0) 为真',
    evaluateCondition({ type: 'isCrit', value: 0 }, { world: w, self: a, hit: noCrit }))

  const crit = createHit({ sourceId: a.id, targetId: b.id, amount: 1, tags: ['crit'] })
  ok('暴击时 isCrit(1) 为真',
    evaluateCondition({ type: 'isCrit', value: 1 }, { world: w, self: a, hit: crit }))
}

// ============================================================================
//  感知载荷
// ============================================================================
//
// ⚠ 这一组的重点是**可见性是被谁消费的**。
//
//   在这之前 `visibilityOf()` 算出来了，但**没有任何地方读它** ——
//   状态里写的 visibility 是个死字段（熔岩护甲那条 `visibility: 1` 更是空操作）。
//   一个没人消费的数值，和没实现是一回事。
//
//   现在消费它的是 `findHostile`：看不见就锁定不了。这才是"隐形"的玩法含义。

section('感知：隐形 / 显形 / 标记')

/** 让 a 对目标放一次感知载荷 */
function perceive(
  w: World, a: Entity, b: Entity,
  payload: { kind: 'perception', mode: 'reveal' | 'mark' | 'setVisibility', value?: { const: number }, duration?: number },
  targetSelf = false,
): void {
  const ctx: ActionContext = { world: w, self: a, target: b, actor: a, depth: 0 }
  const action: Action = { payload }
  if (targetSelf) action.target = 'self'
  executeAction(ctx, action)
}

{
  const { w, a, b } = arena()
  perceive(w, a, b, { kind: 'perception', mode: 'setVisibility', value: { const: 0 }, duration: 5 })

  eq('变得完全不可见', visibilityOf(b), 0)
  ok('挂上的是隐形状态', b.statuses.some(s => s.defId === 'status.perception.hidden'))
}

{
  const { w, a, b } = arena()
  perceive(w, a, b, { kind: 'perception', mode: 'setVisibility', value: { const: 0.5 }, duration: 5 })
  eq('半透明就是 0.5', visibilityOf(b), 0.5)
}

{
  const { w, a, b } = arena()
  perceive(w, a, b, { kind: 'perception', mode: 'setVisibility', value: { const: 0 }, duration: 5 })

  ok('隐形之后，敌人找不到了', findHostile(w, a)?.id !== b.id,
    `找到的是 #${String(findHostile(w, a)?.id)}`)

  // ⚠ ignoreVisibility 是给"范围技能"这类用的：打得到看不见的东西
  ok('但 ignoreVisibility 还能找到他（范围技能照样打得中）',
    findHostile(w, a, { ignoreVisibility: true })?.id === b.id)
}

{
  const { w, a, b } = arena()
  perceive(w, a, b, { kind: 'perception', mode: 'setVisibility', value: { const: 0.5 }, duration: 5 })
  ok('半透明**仍然会被发现** —— 半透明是"难找"，不是"找不到"',
    findHostile(w, a)?.id === b.id)
}

{
  const { w, a, b } = arena()
  perceive(w, a, b, { kind: 'perception', mode: 'setVisibility', value: { const: 0 }, duration: 5 })
  ok('先确认藏起来了', findHostile(w, a)?.id !== b.id)

  /*
   * ⚠ 这一段盯的是 reveal 的**实现方式**。
   *
   *   第一直觉会写成"再挂一个 visibility: 1 的状态"，那是**没用**的 ——
   *   `visibilityOf` 取最小值，只要隐形状态还在，最小值就还是 0。
   *   唯一可行的做法是把隐形状态**移除**。
   */
  perceive(w, a, b, { kind: 'perception', mode: 'reveal' })

  ok('reveal 之后身上没有隐形状态了（是把状态移掉，不是再挂一个可见的）',
    b.statuses.every(s => s.defId !== 'status.perception.hidden'))
  eq('可见性恢复了', visibilityOf(b), 1)
  ok('又能锁定他了', findHostile(w, a)?.id === b.id)

  const ev = w.events.filter(e => e.type === 'revealed').pop()
  ok('发了 revealed 事件', ev !== undefined)
  eq('事件里记了扒掉几个', ev?.type === 'revealed' ? ev.removed : -1, 1)
}

{
  const { w, a, b } = arena()
  // 本来就没藏：reveal 是空放，不该报错，也要如实说"扒掉 0 个"
  perceive(w, a, b, { kind: 'perception', mode: 'reveal' })
  const ev = w.events.filter(e => e.type === 'revealed').pop()
  eq('对没隐身的人放 reveal，removed 是 0', ev?.type === 'revealed' ? ev.removed : -1, 0)
}

{
  const { w, a, b } = arena()
  perceive(w, a, b, { kind: 'perception', mode: 'mark', duration: 10 })
  ok('标记挂上了', b.statuses.some(s => s.defId === 'status.perception.marked'))
  ok('标记带 marked 标签，别的规则能用 hasStatusTag 认出他',
    hasStatusTag(b, 'marked'))
  eq('标记**不影响可见性**（它只管打标签）', visibilityOf(b), 1)
}

{
  const { w, a, b } = arena()
  // 隐形是会长到期的
  perceive(w, a, b, { kind: 'perception', mode: 'setVisibility', value: { const: 0 }, duration: 1.5 })
  advance(w, 60 * 2)
  eq('隐形状态到期后自动恢复可见', visibilityOf(b), 1)
}

// ============================================================================
//  瞄准：targeting.mode 真的被读了
// ============================================================================
//
// ⚠ 这一组是"惰性字段"那类问题的**正面证明**。
//
//   `targeting.mode` 以前是死字段：声明了、校验器放行了、技能作者照着填了，
//   但引擎从来不读 —— `areapoint`（点地面）和 `auto`（自动选最近的）
//   写上去和 `directional` 表现**完全一样**，而且不报错。
//
//   现在 `resolveAim` 按 mode 解析出"从哪儿发、朝哪、锁了谁"。
//   五种模式各测一遍 —— "写了没用"这种事只会以静默的方式回来。

section('瞄准：五种 targeting.mode')

/** 只给 resolveAim 用的最小 targeting（它是纯函数，不用真的释放技能） */
function targetingOf(mode: string, valid: string[], range?: number) {
  return (range === undefined ? { mode, valid } : { mode, valid, range }) as never
}

{
  const { w, a } = arena()
  const aim = resolveAim(w, a, targetingOf('self', ['self']), { kind: 'none' })
  eq('self：中心就是自己', aim.point.x, a.pos.x)
  eq('self：锁的是自己', aim.targetId, a.id)
}

{
  const { w, a } = arena()
  const aim = resolveAim(w, a, targetingOf('directional', ['enemy']),
    { kind: 'direction', dir: { x: 0, y: 1 } })
  near('directional：朝向就是给的方向 x', aim.facing.x, 0)
  near('directional：朝向就是给的方向 y', aim.facing.y, 1)
  eq('directional：不锁定任何人', aim.targetId, undefined)
}

{
  const { w, a, b } = arena()
  // b 在 +x 方向 10 米。朝向故意给 +y（背对它），locked 应该把朝向掰回来
  const aim = resolveAim(w, a, targetingOf('locked', ['enemy'], 12),
    { kind: 'direction', dir: { x: 0, y: 1 } })
  eq('locked：锁到了 b', aim.targetId, b.id)
  near('locked：朝向被掰向目标（+x）', aim.facing.x, 1)
}

{
  const { w, a } = arena()
  // 目标在 10 米，射程只有 5 —— 锁不到时应该退回朝向，而不是"按了没反应"
  const aim = resolveAim(w, a, targetingOf('locked', ['enemy'], 5),
    { kind: 'direction', dir: { x: 0, y: 1 } })
  eq('locked 超出射程：不锁', aim.targetId, undefined)
  near('locked 超出射程：还是朝给的方向打出去（不是按了没反应）', aim.facing.y, 1)
}

{
  const { w, a, b } = arena()
  // auto 不看朝向，直接选最近的
  const aim = resolveAim(w, a, targetingOf('auto', ['enemy'], 12),
    { kind: 'direction', dir: { x: 0, y: 1 } })
  eq('auto：锁到了最近的 b（哪怕背对着它）', aim.targetId, b.id)
  near('auto：朝向指向 b', aim.facing.x, 1)
}

{
  const { w, a } = arena()
  const aim = resolveAim(w, a, targetingOf('areapoint', ['enemy'], 8),
    { kind: 'point', x: 3, y: 4 })
  eq('areapoint：中心落在点的 x 上，不是施法者身上', aim.point.x, 3)
  eq('areapoint：中心落在点的 y 上', aim.point.y, 4)
}

{
  const { w, a } = arena()
  // 点在 20 米外，射程 8 —— 压回射程边缘，不是拒绝释放
  const aim = resolveAim(w, a, targetingOf('areapoint', ['enemy'], 8),
    { kind: 'point', x: 20, y: 0 })
  near('areapoint 超出射程：压回边缘（8 米）', aim.point.x, 8)
  ok('areapoint 超出射程：仍然会放出去', aim.reason.includes('压回边缘'), aim.reason)
}

{
  const { w, a } = arena()
  const aim = resolveAim(w, a, targetingOf('areapoint', ['enemy'], 6), { kind: 'none' })
  near('areapoint 没给落点：落在朝向前方 range 米处', aim.point.x, 6)
}

{
  // ⚠ 距离要减掉**双方的半径** —— 不然大体型 Boss 贴脸会被射程拒绝
  const w = createWorld({ seed: 3 })
  const me = spawn(w, { faction: 'player', pos: { x: 0, y: 0 } })
  const big = spawn(w, { faction: 'enemy', pos: { x: 1.2, y: 0 }, radius: 0.9 })
  const aim = resolveAim(w, me, targetingOf('auto', ['enemy'], 0.5), { kind: 'none' })
  eq('射程按"表面距离"算：0.9 米粗的 Boss 贴脸也锁得到', aim.targetId, big.id)
}

{
  /*
   * ⚠ 这一组盯的是两个**开关**：`pointFixed` / `facingLocked`。
   *
   *   它们不是装饰 —— 是踩了一个真 bug 之后加的：
   *   一开始把 `resolveAim` 的 point 和 facing **无条件**喂给命中判定，
   *   于是前摇 0.3 秒里人已经走开了，挥砍却还砍在施法那一刻的位置上。
   *   `duel` 里的剑士当场打出 0 伤害（基准是 129）。
   *
   *   所以：只有 areapoint 钉中心。
   *
   * ⚠ `facingLocked` 的**含义 2026-09-21 变了**，这一组钉的是它现在的含义：
   *   它只描述**瞄准解算这件事本身**（方向是不是被选中的目标钉住的），
   *   不再决定"载体用哪个朝向"—— 现在所有模式都用 `cast.facing`
   *   （施法那一刻解算出来的方向，见 `pipeline.ts` 里那段注释）。
   *   以前 `directional` 是"跟着施法者当前朝向走"，那个取舍已经取消了。
   */
  const { w, a } = arena()

  const dir = resolveAim(w, a, targetingOf('directional', ['enemy'], 8), { kind: 'none' })
  eq('directional：中心**不钉**（载具要跟着人走）', dir.pointFixed, false)
  eq('directional：方向没被目标钉住（它来自输入）', dir.facingLocked, false)

  const point = resolveAim(w, a, targetingOf('areapoint', ['enemy'], 8),
    { kind: 'point', x: 3, y: 0 })
  eq('areapoint：中心**钉死**（火墙就长在那儿）', point.pointFixed, true)
  eq('areapoint：方向没被目标钉住', point.facingLocked, false)

  const locked = resolveAim(w, a, targetingOf('locked', ['enemy'], 12), { kind: 'none' })
  eq('locked：中心不钉', locked.pointFixed, false)
  eq('locked：方向被目标钉住（这就是"锁定"的意思）', locked.facingLocked, true)

  const self = resolveAim(w, a, targetingOf('self', ['self']), { kind: 'none' })
  eq('self：中心不钉', self.pointFixed, false)
  eq('self：方向没被目标钉住', self.facingLocked, false)
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
