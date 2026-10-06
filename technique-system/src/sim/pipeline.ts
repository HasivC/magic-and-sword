/**
 * 六步伤害管线。
 *
 * ┌──────────────────────────────────────────────────────────┐
 * │ 1 raw        原始     计算基础值                          │
 * │ 2 intercept  拦截     名刀、免疫（阻止它发生）             │
 * │ 3 modify     修正     增减伤、伤害转治疗、亡灵反转         │
 * │ 4 absorb     吸收     护盾、次数盾                        │
 * │ 5 apply      应用     真正扣血                            │
 * │ 6 after      后置     吸血、反伤、onDamaged               │
 * └──────────────────────────────────────────────────────────┘
 *
 * 为什么必须是管线而不是一行 `hp -= dmg`：
 *   名刀司命要"阻止这次伤害"，护盾要"先吃一部分"，
 *   龟壳要"把伤害变成治疗" —— 这些都不是减法能表达的。
 *   而且它们必须**有序**：护盾一定在减伤之后才算。
 *
 * 伤害和治疗共用这一条管线，只是 kind 不同 ——
 * 否则禁疗、治疗加成、亡灵反转每一条都要写两遍。
 *
 * 钩子有三个来源（纪律 6）：技能图（第 4 步）、状态、实体本身。
 * 这个文件负责从各处收集、按 priority 排序、按 stage 依次执行。
 */
import type {
  Action, Condition, Faction, ModifierOp, PipelineHook, PipelineStage, StatusDef, TriggerEvent,
  ValueSpec,
} from '../schema.ts'
import type { CompiledMod, CompiledTechnique } from './compile.ts'
import type {
  ActionContext, ActiveStatus, CastInstance, Entity, HitInstance, ProjectileSpec, ValueContext, World,
} from './types.ts'
import { getStored, hpPercent, resolveAttribute, resolveValue, setStored } from './attributes.ts'
import { applyStatus, factionOf, removeStatus, removeStatusInstance } from './status.ts'
import { spawn } from './world.ts'
import type { SpawnInit } from './world.ts'
import { setTechniqueActive } from './cast.ts'
import { runModifierTriggers } from './trigger.ts'
import { evaluateAll, CRIT_TAG } from './conditions.ts'
import { resolveTargets } from './targeting.ts'
import { spawnProjectile, acquireHomingTarget } from './projectile.ts'
import { normalize2 } from './geom.ts'
import { ownerOf } from './compile.ts'
import { nextFloat } from './rng.ts'
import { recordCarrier } from './mod-state.ts'
import type { CarrierOrigin } from './mod-state.ts'

/**
 * 载体几何里的一个数（`radius` / `length` 可以是动态参数）。
 *
 * ⚠ 和 `targeting.ts` 里那个同名函数是**同一个约定**：写数字就用数字，
 *   写 `ref` 就用施法者的上下文解析。两处解析出来的必须是同一个值 ——
 *   判定用 3 米、特效画 2 米的话，"够得着"和"看着够得着"就分家了。
 */
function geomNumber(v: number | ValueSpec | undefined, ctx: ActionContext): number | undefined {
  if (v === undefined) return undefined
  if (typeof v === 'number') return v
  return resolveValue(v, ctx)
}
import {
  HITSTOP_FRACTION, KNOCKBACK_FRACTION, LOW_HP_PCT, MAX_HITSTOP, MAX_KNOCKBACK, MIN_HITSTOP_DAMAGE,
  PUSH_DECAY,
} from './world.ts'

/**
 * 把"想让它移动这么多米"翻译成一个冲量。
 *
 * 位移载荷写的是 `distance`（米），而引擎里推人靠的是 `push` 冲量 ——
 * 每次 tick 按 PUSH_DECAY 衰减，位置按 `(vel*scale + push) * dt` 积分。
 *
 * 衰减是等比数列，所以总位移有闭式解：
 *
 *     Σ p₀ · dᵏ · dt = p₀ · dt / (1 − d)
 *
 * 反解：
 *
 *     p₀ = distance · (1 − d) / dt
 *
 * ⚠ `dt` 不能漏。漏了的话冲量会小 60 倍（60Hz 下），
 *   而表现是"击退写了 3 米，实际推了 5 厘米"—— 看起来像 distance 没生效。
 *   这个式子里的 dt 是它唯一出现的地方，很容易顺手写掉。
 *
 * 不这么做的话 `distance` 就只是个装饰：写 3 米实际推多远取决于衰减常数，
 * 改常数会让所有已调好的技能一起漂。
 *
 * ⚠ 它给的是"理想情况下正好 distance 米"。
 *   目标同时在用 `vel` 走路的话会抵消掉一部分 —— 那是对的，
 *   逆着冲刺的人本来就该被推得更近。
 */
function addImpulse(world: World, target: Entity, ux: number, uy: number, distance: number): void {
  const p0 = (distance * (1 - PUSH_DECAY)) / world.dt
  target.push.x += ux * p0
  target.push.y += uy * p0
}

/** 技能的冷却存在这个存储属性上 */
export function cooldownPath(techniqueId: string): string {
  return `cd.${techniqueId}`
}

/**
 * 感知载荷不写 duration 时用多久。
 *
 * 5 秒是"够你干一件事"的长度：绕到背后、脱战、或者把一套连招打完。
 * 再长就变成"整场都看不见你"，那是另一个量级的效果。
 */
const PERCEPTION_DEFAULT_DURATION = 5

/**
 * 召唤物摆放用的八个单位方向。
 *
 * ⚠ 手写常量而不是 `[cos θ, sin θ]`：`Math.sin` / `Math.cos` 在
 *   purity 测试里是被禁的（跨 JS 引擎不保证逐位一致，会破坏重放）。
 *   八个方向对"召三五个"完全够用，而且是纯常量、零计算。
 */
const SPAWN_RING: readonly (readonly [number, number])[] = [
  [1, 0], [0.7071, 0.7071], [0, 1], [-0.7071, 0.7071],
  [-1, 0], [-0.7071, -0.7071], [0, -1], [0.7071, -0.7071],
]

/*
 * 触发链深度上限（"结算预算"）。
 *
 * ⚠⚠ **2026-09-30 日志 58：定义搬去了 `src/limits.ts`，这里只再导出一次。**
 *
 *   搬家的理由只有一个：这个数现在有**第二个**消费者 ——「弹射」的上限
 *   必须和它**是同一条规矩**（玩家原话："各写一份迟早出现弹射绕过深度保护
 *   ⇒ 自反馈"）。而 `school.ts`（管参数夹取的那个纯函数模块）读不到
 *   `sim/**` 里的东西，所以它必须住在一个**谁都能 import、且不拖任何依赖**
 *   的叶子模块里 —— 那个模块就是 `src/limits.ts`。
 *
 *   ⚠ **值一个字节都没改**（还是 4），`executeAction` 的用法也一字没动：
 *     这一片只是把"这个数有几份"变成"只有一份"。
 */
import { MAX_ACTION_DEPTH } from '../limits.ts'

export { MAX_ACTION_DEPTH }

/** 六个阶段的固定顺序。永远不由玩家改 —— 玩家只能拖同一阶段内的顺序 */
export const STAGE_ORDER: readonly PipelineStage[] = [
  'raw', 'intercept', 'modify', 'absorb', 'apply', 'after',
]

// ============================================================================
//  命中实例
// ============================================================================

export interface HitInit {
  kind?: 'damage' | 'heal'
  sourceId: number
  targetId: number
  amount: number
  damageType?: string
  mode?: 'normal' | 'lethal'
  tags?: string[]
  techniqueId?: string
}

export function createHit(init: HitInit): HitInstance {
  return {
    kind: init.kind ?? 'damage',
    sourceId: init.sourceId,
    targetId: init.targetId,
    amount: init.amount,
    rawAmount: init.amount,
    tags: [...(init.tags ?? [])],
    mode: init.mode ?? 'normal',
    intercepted: false,
    absorbed: 0,
    applied: 0,
    connected: false,
    stages: [],
    ...(init.damageType !== undefined ? { damageType: init.damageType } : {}),
    ...(init.techniqueId !== undefined ? { techniqueId: init.techniqueId } : {}),
  }
}

/** 管线伪属性。它们可以在钩子里被 AttributePayload 直接改 */
export const PIPELINE_PATHS: readonly string[] = [
  'pipeline.amount', 'pipeline.cancelled', 'pipeline.reverse', 'pipeline.absorbed',
]

export function isPipelinePath(path: string): boolean {
  return path.startsWith('pipeline.')
}

export function readPipelineAttr(hit: HitInstance, path: string): number | undefined {
  switch (path) {
    case 'pipeline.amount': return hit.amount
    case 'pipeline.cancelled': return hit.intercepted ? 1 : 0
    case 'pipeline.reverse': return 0
    case 'pipeline.absorbed': return hit.absorbed
    default: return undefined
  }
}

/**
 * 写管线伪属性。
 *
 * pipeline.cancelled 设成非 0 → 拦截这次伤害（名刀司命）
 * pipeline.reverse   设成非 0 → 反转方向（亡灵受治疗反而受伤）
 * pipeline.amount    可以 add / mul / set —— 减伤就是这么做的
 */
export function writePipelineAttr(hit: HitInstance, path: string, op: ModifierOp, value: number): void {
  switch (path) {
    case 'pipeline.amount':
      hit.amount = applyOp(hit.amount, op, value)
      break
    case 'pipeline.cancelled':
      if (value !== 0) hit.intercepted = true
      break
    case 'pipeline.reverse':
      if (value !== 0) hit.kind = hit.kind === 'damage' ? 'heal' : 'damage'
      break
    default:
      break
  }
}

function applyOp(cur: number, op: ModifierOp, v: number): number {
  switch (op) {
    case 'add': return cur + v
    case 'stack': return cur + v
    case 'mul': return cur * v
    case 'set': return v
    case 'reset': return 0
    default: return cur
  }
}

// ============================================================================
//  钩子收集
// ============================================================================

export interface CollectedHook {
  hook: PipelineHook
  from: 'entity' | 'status' | 'technique'
  /** 钩子宿主。条件里的 self 指它 */
  owner: Entity
  /** 宿主状态（absorb 模式要写回它的 pool） */
  status?: ActiveStatus
  /** 宿主术式（技能图来源的钩子才有） */
  techniqueId?: string
  /** 钩子长在哪一侧 */
  side: 'target' | 'source'
}

/**
 * 规则里的哪些时机，可以当作管线钩子用。
 *
 * 技能图的钩子只对**常驻技能**（activation 是 auto，或 toggle 打开）生效 ——
 * 一个按一下就结束的技能，不可能在你挨打的时候还挂着。
 * 名刀司命做成武器被动，走的就是这条路。
 */
const RULE_HOOK_MAP: Record<string, { stage: PipelineStage; side: 'target' | 'source' }> = {
  // onDamaged 放在 modify 而不是 after：
  //   玩家写 onDamaged 时想干的事，九成是"减伤 / 转治疗 / 免疫"，
  //   这些必须在伤害落地**之前**改。放到 after 就来不及了。
  //   想写"伤害落地之后再反应"的效果（吸血那种），用 onHit。
  onDamaged: { stage: 'modify', side: 'target' },
  onLethalDamage: { stage: 'intercept', side: 'target' },
  onHit: { stage: 'after', side: 'source' },
  onCrit: { stage: 'after', side: 'source' },
  onNonCrit: { stage: 'after', side: 'source' },
  onMiss: { stage: 'after', side: 'source' },
}

/**
 * 收集这次命中的全部钩子。
 *
 * 顺序：目标实体 → 目标的状态 → 施法者实体 → 施法者的状态。
 * 然后按 priority 稳定排序（小的先跑，同样大小按收集顺序）。
 *
 * 为什么要分两侧收：
 *   龟壳、护盾、名刀、反伤长在**被打**的那一侧；
 *   吸血、增伤长在**打人**的那一侧。
 *   钩子用 side 声明自己长在哪边 —— 不声明的话反伤会在自己打人时也触发，
 *   变成"打人的人被自己的反伤弹死"。这个坑真踩过。
 */
export function collectHooks(world: World, hit: HitInstance): CollectedHook[] {
  const target = world.entities.find(e => e.id === hit.targetId)
  const source = world.entities.find(e => e.id === hit.sourceId)
  const out: CollectedHook[] = []

  const wants = (h: PipelineHook, side: 'target' | 'source'): boolean => {
    const declared = h.side ?? 'target'
    return declared === 'any' || declared === side
  }

  const push = (owner: Entity, side: 'target' | 'source'): void => {
    for (const h of owner.hooks) {
      if (wants(h, side)) out.push({ hook: h, from: 'entity', owner, side })
    }
    for (const s of owner.statuses) {
      for (const h of s.hooks) {
        if (wants(h, side)) out.push({ hook: h, from: 'status', owner, status: s, side })
      }
    }
    // 第三个来源：技能图。只对常驻技能生效
    for (const techId of owner.activeTechniques) {
      const tech = world.techniques.get(techId)
      if (tech === undefined) continue
      for (const rule of tech.rules) {
        const mapped = RULE_HOOK_MAP[rule.when]
        if (mapped === undefined || mapped.side !== side) continue
        const hook: PipelineHook = {
          stage: mapped.stage,
          side: mapped.side,
          when: rule.when,
        }
        if (rule.if !== undefined) hook.if = rule.if
        if (rule.then !== undefined) hook.then = rule.then
        out.push({ hook, from: 'technique', owner, side, techniqueId: techId })
      }
    }
  }

  if (target !== undefined) push(target, 'target')
  if (source !== undefined && source.id !== target?.id) push(source, 'source')

  return out
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.hook.priority ?? 0) - (b.c.hook.priority ?? 0) || a.i - b.i)
    .map(x => x.c)
}

function buildValueContext(
  world: World,
  hit: HitInstance,
  c: CollectedHook,
  target: Entity,
  source: Entity | undefined,
): ValueContext {
  const ctx: ValueContext = { world, self: c.owner, hit }
  // 目标侧："target" 就是被打的人；施法者侧："target" 是被打的人，"self" 是打人的人
  const other = c.side === 'target' ? source : target
  if (other !== undefined && other.id !== c.owner.id) ctx.target = other
  if (c.status !== undefined) ctx.status = c.status
  return ctx
}

// ============================================================================
//  主流程
// ============================================================================

/**
 * 跑完一次命中的整条管线。
 *
 * depth 用来限制触发链：嵌套的伤害（反伤、连锁）会传 depth + 1，
 * 超过 MAX_ACTION_DEPTH 就截断。
 */
export function resolveHit(world: World, hit: HitInstance, depth = 0): HitInstance {
  const target = world.entities.find(e => e.id === hit.targetId)
  if (target === undefined || !target.alive) {
    hit.connected = false
    return hit
  }
  const source = world.entities.find(e => e.id === hit.sourceId)

  /*
   * 暴击。**必须在收集钩子之前掷**。
   *
   * 因为 `onCrit` / `onNonCrit` 是靠 `hit.tags` 里有没有 CRIT_TAG 判断的
   * （见 matchWhen），掷晚了这一步，钩子会按"没暴击"收进来。
   *
   * ⚠ `critRate` 是 0 的时候**一次骰子都不掷**。
   *   掷了就消耗一个随机数，会把世界的随机序列往后推一格 ——
   *   于是"没开暴击的内容"也会因为这次改动而重放结果不同。
   *   rng 是全局的、有状态的，任何一次多余的调用都是可观测的。
   */
  if (hit.kind === 'damage' && source !== undefined) {
    const rate = resolveAttribute(source, 'char.critRate', { world, self: source, hit })
    if (rate > 0 && nextFloat(world) < rate) {
      hit.tags.push(CRIT_TAG)
      hit.amount *= resolveAttribute(source, 'char.critDamage', { world, self: source, hit })
    }
  }

  const hooks = collectHooks(world, hit)

  runStage(world, hit, 'raw', hooks, target, source, depth)
  runStage(world, hit, 'intercept', hooks, target, source, depth)

  if (hit.intercepted) {
    world.events.push({
      type: 'hitIntercepted',
      entityId: target.id,
      sourceId: hit.sourceId,
      byStatus: hit.interceptedBy ?? 'unknown',
    })
    // 被拦了也跑 after：名刀挂的无敌状态就是从它自己的钩子里出来的
    runStage(world, hit, 'after', hooks, target, source, depth)
    return hit
  }

  runStage(world, hit, 'modify', hooks, target, source, depth)

  /*
   * 目标身上的"受到伤害倍率"。
   *
   * 破甲这类状态就是改它（char.damageTaken × 1.15）。
   * 放在 modify 钩子**之后**：规则可以随便改 pipeline.amount，
   * 但默认的易伤系数也要生效。
   *
   * ⚠ 它的默认值必须是 1，不能是 0 —— 否则所有伤害都会被乘成 0。
   */
  if (hit.kind === 'damage') {
    const hasSource = source !== undefined
    const taken = resolveAttribute(target, 'char.damageTaken', {
      world,
      self: target,
      hit,
      ...(hasSource ? { target: source } : {}),
    })
    if (taken !== 1) hit.amount *= taken
  }

  runStage(world, hit, 'absorb', hooks, target, source, depth)
  runStage(world, hit, 'apply', hooks, target, source, depth)
  applyHit(world, hit, target)
  runStage(world, hit, 'after', hooks, target, source, depth)

  return hit
}

function runStage(
  world: World,
  hit: HitInstance,
  stage: PipelineStage,
  hooks: CollectedHook[],
  target: Entity,
  source: Entity | undefined,
  depth: number,
): void {
  hit.stages.push(stage)

  // absorb 是引擎自己算的，不走钩子的 then
  if (stage === 'absorb') {
    runAbsorb(world, hit, hooks, target, source)
    return
  }

  for (const c of hooks) {
    if (c.hook.stage !== stage) continue
    if (!matchWhen(c.hook.when, hit, target)) continue

    const ctx = buildValueContext(world, hit, c, target, source)
    if (!evaluateAll(c.hook.if, ctx)) continue

    const actionCtx: ActionContext = {
      ...ctx,
      actor: c.owner,
      depth,
      ...(c.status !== undefined ? { sourceId: c.status.defId } : {}),
    }

    for (const action of c.hook.then ?? []) {
      executeAction(actionCtx, action)
    }

    // 记下是谁拦的，顺便让后面的钩子知道
    if (hit.intercepted && hit.interceptedBy === undefined) {
      hit.interceptedBy = c.status?.defId
        ?? c.techniqueId
        ?? c.owner.defId
        ?? `entity:${c.owner.id}`
    }
  }
}

/** 钩子的 when 只在管线的语境里有意义，别的时机一律不匹配 */
function matchWhen(when: TriggerEvent | undefined, hit: HitInstance, target: Entity): boolean {
  if (when === undefined) return true
  const isCrit = hit.tags.includes(CRIT_TAG)
  switch (when) {
    case 'onLethalDamage':
      return hit.kind === 'damage' && wouldKill(hit, target)
    case 'onDamaged':
      return hit.kind === 'damage'
    case 'onHit':
      return hit.connected
    case 'onMiss':
      return !hit.connected
    case 'onCrit':
      return hit.kind === 'damage' && isCrit
    case 'onNonCrit':
      return hit.kind === 'damage' && !isCrit
    default:
      return false
  }
}

function wouldKill(hit: HitInstance, target: Entity): boolean {
  if (hit.kind !== 'damage') return false
  if (hit.mode === 'lethal') return true
  return getStored(target, 'char.hp.current') - hit.amount <= 0
}

// ============================================================================
//  第 4 步：吸收
// ============================================================================

function runAbsorb(
  world: World,
  hit: HitInstance,
  hooks: CollectedHook[],
  target: Entity,
  source: Entity | undefined,
): void {
  // 护盾不吸治疗
  if (hit.kind !== 'damage') return
  if (hit.amount <= 0) return

  for (const c of hooks) {
    if (c.hook.stage !== 'absorb') continue
    const absorb = c.hook.absorb
    if (absorb === undefined || c.status === undefined) continue

    const ctx = buildValueContext(world, hit, c, target, source)
    if (!evaluateAll(c.hook.if, ctx)) continue

    const status = c.status
    let pool = status.vars['pool'] ?? 0
    if (pool <= 0) continue

    if (absorb.mode === 'hits') {
      // 次数盾：吃掉整整一次命中，不管这一下多疼
      pool -= 1
      hit.absorbed += hit.amount
      hit.amount = 0
    } else {
      // 吸收盾：吃多少算多少
      const eaten = Math.min(pool, hit.amount)
      pool -= eaten
      hit.amount -= eaten
      hit.absorbed += eaten
    }

    status.vars['pool'] = pool

    if (pool <= 0) {
      world.events.push({ type: 'shieldBroken', entityId: c.owner.id, statusId: status.defId })
      removeStatusInstance(world, c.owner, status)
    }

    if (hit.amount <= 0) break
  }
}

// ============================================================================
//  第 5 步：应用
// ============================================================================

/**
 * 真正改写生命值。这一步是引擎独占的，钩子只能旁观。
 *
 * lethal 模式无视当前血量直接清零 —— 阿瓦达索命。
 * 它之所以能被反制，是因为 intercept 阶段在它前面。
 */
/**
 * 血量**跨过**低血线的那一刻：跑挨打者自己的 `onLowHp` 规则。
 *
 * ⚠ 关键词是"跨过"（crossing），不是"低于"。
 *
 *   写成"低于就触发"的话，一个残血的人每挨一下都会再触发一次 ——
 *   于是"血量过低时获得护盾"会变成"每次挨打都白送一个护盾"。
 *   正确语义是**状态变化的那一瞬间**：上一 tick 还在线上，这一 tick 掉下去了。
 *
 * ⚠ 跑的是**挨打那个人自己**的常驻术式，不是打人那个的。
 *   `onLowHp` 问的是"我快死了"，所以主语只能是被打到快死的那个。
 *   这也意味着它只对 auto / toggle 的常驻术式有意义 ——
 *   一个按一下才存在的技能，不可能在你残血的时候还挂着
 *   （和管线钩子那条规矩是同一个道理）。
 */
function fireLowHp(world: World, target: Entity, hpBefore: number): void {
  const max = resolveAttribute(target, 'char.hp.max', { world, self: target })
  if (!(max > 0)) return

  const after = getStored(target, 'char.hp.current') / max
  const before = hpBefore / max

  if (!(before >= LOW_HP_PCT && after < LOW_HP_PCT)) return

  world.events.push({ type: 'lowHp', entityId: target.id, hpPct: after })

  for (const techId of target.activeTechniques) {
    const tech = world.techniques.get(techId)
    if (tech === undefined) continue
    runTechniqueRules(world, tech, target, 'onLowHp')
    /*
     * ⚠ ---- **修饰技能的 `onLowHp` 触发副本**（日志 48）----
     *
     *   条件那一步由**这里**做，不是由执行器每 tick 做 —— 因为
     *   "**跨过**低血线"这件事只有这个函数知道（它拿着掉血前后的两个数）。
     *   执行器每 tick 只能看到"现在低于 30%"，那是"残血期间无限刷"。
     *
     *   ⇒ 所以监测器的 `crossing` 语义**复用同一套**：旧「背水」的
     *     `_comment_semantics`（"跨过，不是低于"）在拆解时原样保住，
     *     而不是在新机制里重新定义一遍（那会漂移成两种语义）。
     */
    runModifierTriggers(world, target, tech, 'onLowHp')
  }
}

function applyHit(world: World, hit: HitInstance, target: Entity): void {
  if (hit.kind === 'heal') {
    if (hit.amount <= 0) {
      hit.connected = false
      return
    }
    const max = resolveAttribute(target, 'char.hp.max')
    const cur = getStored(target, 'char.hp.current')
    const next = Math.min(max, cur + hit.amount)
    setStored(target, 'char.hp.current', next)
    hit.applied = next - cur
    hit.connected = true
    world.events.push({
      type: 'healed', entityId: target.id, sourceId: hit.sourceId, amount: hit.applied,
    })
    return
  }

  if (hit.amount <= 0 && hit.mode !== 'lethal') {
    hit.connected = false
    return
  }

  const cur = getStored(target, 'char.hp.current')
  const next = hit.mode === 'lethal' ? 0 : Math.max(0, cur - hit.amount)
  setStored(target, 'char.hp.current', next)
  hit.applied = cur - next
  hit.connected = true

  /*
   * 记住"这一 tick 挨过打"。
   *
   * 打断等级是 'damage' 的阶段靠它判断要不要断（见 cast.ts）。
   * 这里**不直接打断** —— 施法系统 import 管线，反过来会成环。
   */
  if (hit.applied > 0) target.damagedTick = world.tick

  applyImpact(world, hit, target)

  world.events.push({
    type: 'damaged',
    entityId: target.id,
    sourceId: hit.sourceId,
    amount: hit.applied,
    absorbed: hit.absorbed,
    lethal: hit.mode === 'lethal',
  })

  // 血量掉到线以下的那一刻，让**挨打的人自己**的常驻术式有机会响应
  if (hit.applied > 0 && next > 0) fireLowHp(world, target, cur)

  if (next <= 0 && target.alive) {
    target.alive = false
    world.events.push({ type: 'died', entityId: target.id, killerId: hit.sourceId })
  }
}

/**
 * 打击感：顿帧 + 击退。
 *
 * 两个都按"这一下打掉了目标多少比例的血"算，不按绝对伤害 ——
 * 对一只 40 血的小怪打 30 点，比对一个 2000 血的 Boss 打 30 点爽得多，
 * 那也是对的。
 *
 * ⚠ 这两件事属于**模拟**，不属于渲染：
 *   渲染层假装停顿的话，模拟还在跑，停顿结束后敌人会"跳"一下。
 *   放在这里，所有人（包括局域网里的对手）经历的是同一段停顿。
 */
function applyImpact(world: World, hit: HitInstance, target: Entity): void {
  if (hit.kind !== 'damage' || hit.applied <= 0) return

  const fraction = hit.applied / Math.max(1, resolveAttribute(target, 'char.hp.max'))

  // 顿帧：小伤害不触发，否则 DOT 每 0.5 秒跳一次会把游戏卡成幻灯片
  if (hit.applied >= MIN_HITSTOP_DAMAGE) {
    const stop = Math.min(MAX_HITSTOP, fraction * HITSTOP_FRACTION)
    if (stop > world.hitstop) world.hitstop = stop
  }

  // 击退：从施法者指向目标的方向推开
  const source = world.entities.find(e => e.id === hit.sourceId)
  if (source === undefined) return

  const dx = target.pos.x - source.pos.x
  const dy = target.pos.y - source.pos.y
  const len = Math.sqrt(dx * dx + dy * dy)
  if (len < 1e-6) return

  const speed = Math.min(MAX_KNOCKBACK, fraction * KNOCKBACK_FRACTION)
  target.push.x += (dx / len) * speed
  target.push.y += (dy / len) * speed
}

// ============================================================================
//  动作执行器
// ============================================================================

/**
 * 把一个动作**射出去**，而不是当场结算。
 *
 * 命中发生在未来某一刻，那时候这次施法早就结束了 ——
 * 所以投射物必须自己带着要执行的动作和归属。
 *
 * ⚠ 带出去的动作要**去掉 delivery**，否则命中时又会"放一个投射物"，无限套娃。
 *   这是 projection 唯一的递归风险，所以 `onImpact` 是重新拼的对象，
 *   不是原来那个 action 的引用。
 *
 * ⚠ 它对**所有载荷**通用（status / heal / perception / spawn …），
 *   不只是 damage。以前只认 damage，导致"挂了状态的箭"根本不会飞。
 */
function spawnProjectileFrom(ctx: ActionContext, action: Action): void {
  const d = action.delivery
  if (d === undefined) return
  const p = action.payload
  if (p === undefined) return

  const onImpact: Action = { payload: p }
  if (action.target !== undefined) onImpact.target = action.target
  if (action.valid !== undefined) onImpact.valid = action.valid

  const spec: ProjectileSpec = {
    actions: [onImpact],
    valid: action.valid ?? ctx.validTargets ?? ['enemy'],
    sourceId: ctx.actor.id,
    hitIds: [],
    pierce: d.pierce === true,
  }
  if (ctx.sourceId !== undefined) spec.techniqueId = ctx.sourceId

  /*
   * 命中特效要跟着子弹带出去。
   *
   * ⚠ 发射那一刻**不播** —— 投射物自己是实体，客户端已经在画它了。
   *   但命中是另一件事：火花得打在目标身上，不是发射点上。
   *   所以 vfx 只在这里存进 spec，由 projectile.ts 在落地时发事件。
   */
  if (d.vfx !== undefined) spec.vfx = d.vfx
  // 只有伤害有伤害类型；别的载荷没有，所以这里是可选的
  const damageType = p.kind === 'damage' ? p.damageType : undefined
  if (damageType !== undefined) spec.damageType = damageType

  /*
   * ⚠ ---- **这一发会不会自己拐向最近的敌人**（修饰零件「追踪」，日志 56）----
   *
   *   修饰副本住在**容器**产物的 `segments[].mods` 上（段那份里 `segments` 是空的，
   *   和 `carrierOriginOf` 那段踩过的坑是同一个），所以这里要从
   *   `ctx.cast.homeTechnique` 里找到**这一发所属的那一段**再问它有没有追踪副本。
   *
   *   ⚠⚠ **在读 `ctx.cast` 之前就判 `d.kind === 'projectile'`**：
   *     只有投射物会走到这个函数（`executeAction` 就是这么分的），所以这一行
   *     看着像废话 —— 它其实是**玩家那条界线的落点**：
   *     "追踪**只对会飞的东西有效**，非飞行载体（激光那类）什么都不做"。
   *     ⚠ 它**不需要**任何"否则报警告" —— 照「环绕」那条先例，
   *       "这个修饰对这条序列不起作用"由**界面**画在那条序列下方，引擎不出声。
   */
  const homing = d.kind === 'projectile' ? homingOfCast(ctx) : undefined
  /*
   * ⚠⚠ **抄成一份新的**（不是把编译产物那个对象挂上去）—— 2026-09-30 日志 62 起，
   *   追踪的锁（`lockedId`）是**这一发自己的**运行状态，而编译产物是**一份术式共用**的
   *   （多重释放的 N 发会拿到同一个对象 ⇒ 一发的锁会写到别人头上）。
   *   ⚠ 和下面 `spec.bounce` 是同一个做法（那里也是一个新对象）。
   */
  if (homing !== undefined) {
    spec.homing = { turnRate: homing.turnRate, maxRange: homing.maxRange }
  }

  /*
   * ⚠ ---- **这一发打中之后会不会弹给下一个敌人**（修饰零件「弹射」，日志 58）----
   *
   *   读法和追踪**逐字同源**（`bounceOfCast` 与 `homingOfCast` 是一个形状：
   *   从容器产物的 `segments[].mods` 里按**段 id** 找回这一段）。
   *
   *   ⚠⚠ **上限这里是"最后一道"**：`spec.bounce.left` 取
   *     `min(编译期读好的次数, MAX_ACTION_DEPTH)` —— 那个常量就在**本文件**上方
   *     （现在由 `src/limits.ts` 定义，见那一段）。
   *     ⚠ 为什么这里还要再夹一次（编译期的 `modifierBounceCountOf` 已经夹过了）：
   *       编译产物**可以被手改的存档 / 老分享码**直接塞进世界 ——
   *       而弹射是一条链（每段一颗新子弹，`depth` 不累加），
   *       这一道是链上唯一和"结算预算"绑在一起的刹车，不许只靠上游。
   *       玩家原话："各写一份迟早出现弹射绕过深度保护 ⇒ 自反馈"。
   *
   *   ⚠ `amountScale` 初值 **1**：**第一段是全额**，衰减从"弹过去的那一段"开始算
   *     （玩家的话："被它修饰的投射物命中一个敌人**之后** → 弹给最近的另一个敌人，
   *     最多 N 次，每次衰减"）。
   */
  const bounce = d.kind === 'projectile' ? bounceOfCast(ctx) : undefined
  if (bounce !== undefined) {
    spec.bounce = {
      left: Math.min(bounce.maxBounces, MAX_ACTION_DEPTH),
      amountScale: 1,
      damageFalloff: bounce.damageFalloff,
    }
  }

  /*
   * ---- 方向：用**施法瞬间解算出来的那个**（`ctx.cast.facing`）----
   *
   * ⚠ 2026-09-21 改了（玩家定的："按下那一刻的方向，之后甩鼠标也不改"）。
   *
   *   以前这里（和下面 `fireDelivery` 里）是：
   *     锁定/自动索敌 → `cast.facing`；`directional` → `actor.facing`（角色的**当前**朝向）
   *
   *   也就是说 `directional` 的"攻击朝哪"取决于**客户端每一帧往 `facing` 里写了什么**。
   *   那条链断掉的方式全是静默的（指针坐标没送到 / 算方向时凭空返回一个默认值 /
   *   别处覆盖了朝向），而表现是"这一刀砍在别处" —— 玩家 2026-09-21 报的
   *   「左键的攻击始终朝向正右方」正是这一类。
   *
   *   现在：**施法那一刻解算出来的朝向就是这一下的朝向**，之后谁改 `facing` 都不影响它。
   *   客户端每帧写 `facing` 只剩一个用途 —— 画角色朝向（这也是它该管的）。
   *
   *   代价（明说）：前摇里转身**不会**把这一下带歪，也**不再**能微调。
   *   想"前摇里还能改方向"就得在施法那一刻之后重新传意图（那是另一套输入，
   *   现在是按下即锁定）。
   */
  const dir = ctx.cast?.facing ?? ctx.actor.facing

  const projectile = spawnProjectile(ctx.world, {
    pos: ctx.actor.pos,
    dir,
    delivery: d,
    tags: damageType !== undefined ? [damageType] : [],
    spec,
  })

  /*
   * ⚠⚠ ---- **追踪的"索敌距离"只在发射这一刻用一次**（2026-09-30 日志 62）----
   *
   *   玩家原话："**限制不应该是射程，而是持续时间** —— 这样就**追到消失**"，
   *   以及"那个'射程'旋钮**改语义为「索敌距离」** —— **发射那一瞬间**能找到多远的目标"。
   *
   *   ⇒ 位置就在这里：**子弹刚被造出来、还没飞第一步**（`integrate` 在后面的步骤）。
   *     找到就写进 `spec.homing.lockedId`，那一发从此**只咬这一个**，
   *     直到它自己飞完 `lifetime` 消失（中间**不再重新搜**、也就**不会丢锁**）。
   *   ⚠ 找不到（那一刻没有合法目标）⇒ `lockedId` 保持 `undefined` ⇒ 一路直走。
   *     这里**不许**退化成"飞近一点再找"—— 玩家点名的是"发射那一瞬间"。
   *   ⚠ `judge` 用 `ctx.actor`：和 `tickProjectiles` 里那个
   *     "`world.entities.find(id === spec.sourceId) ?? p`" 此刻是**同一个实体**
   *     （刚发射完，施法者一定还在），所以两处的敌我视角逐位一致。
   */
  if (spec.homing !== undefined) {
    spec.homing.lockedId = acquireHomingTarget(ctx.world, projectile, ctx.actor, spec)
  }

  /*
   * ⚠ ---- **记下"这次施法放出去了一颗"**（2026-09-30 日志 55）----
   *
   *   投射物是四类载体里**最容易被混进"打空了"**的那一类：它飞完
   *   `delivery.lifetime` 就自己没了（那正是"载体消失"的典型场景）。
   *   ⚠ 记在 `spawnProjectile` **之后**：投射物没造出来就没有台账，
   *   也就没有"消失"这回事（判据在 `carrierBegun`）。
   *
   *   ⚠ 造不出来 / 不在施法中 ⇒ `carrierOriginOf` 返回 `undefined` ⇒
   *   **一个字节都不记**（见它那段：不许给「载体消失」猜一个触发者）。
   */
  const origin = carrierOriginOf(ctx)
  if (origin !== undefined && ctx.cast !== undefined) {
    recordCarrier(ctx.world, projectile, ctx.cast.id, origin)
  }
}

/**
 * 「**这一次施法长出来的载体**」的来历 —— 给台账记一笔（2026-09-30 日志 55）。
 *
 * ## 它回答的问题
 * 引擎里原来只有"按下技能"这一刻（`ctx.cast`），而**载体的下场**发生在
 * 很多 tick 之后：那时候施法已经结束（`pruneCasts` 把它移出了 `world.casts`），
 * `ctx` 早就不在了。所以"上一次放出去的那个东西后来怎么样了"这件事
 * **必须当场记下来**（`mod-state.ts` 的台账），别的地方都晚了一步。
 *
 * ## ⚠ 为什么记的是 `ctx.cast.technique`（**容器**那份编译产物）
 *   · 触发器要的名单（技能 id + 激活方式）在**载体消失**时解算 ——
 *     到时候手里只有这里记下的东西，**没有** `ctx`、也没法查世界
 *     （⚠ 序列段那一份术式**根本不在 `world.techniques` 里**，
 *      `applyScenario` 只注册容器术式 ⇒ 按 id 查会查不到 ⇒ 触发器**静默不响**）。
 *   · `fireModifier` 本来就只从这份产物里按 `skillId` 前缀筛阶段和规则，
 *     容器那份筛出来的和段那份**是同一批**。
 *
 * ## ⚠ 技能 id 从**当前阶段**取（`ownerOf(phase.id)`）
 *   编译期给每个阶段加了 `${skillId}#` 前缀（`compile.ts`），所以
 *   "现在在跑哪个技能"是**已经记着**的 —— 不用在这里再问一遍是谁调用的。
 *   取不到（阶段越界 / 不在施法中）⇒ 返回 `undefined` ⇒ **不记台账**：
 *   ⚠ 记一笔"不知道是谁放的"载体，等于给「载体消失」造一个**猜出来的**
 *   触发者 —— 那比"什么都不发生"坏得多（报告第 4 节那条纪律）。
 */
function carrierOriginOf(ctx: ActionContext): CarrierOrigin | undefined {
  const cast = ctx.cast
  if (cast === undefined) return undefined
  const phase = cast.technique.phases[cast.phaseIndex]
  if (phase === undefined) return undefined
  const skillId = ownerOf(phase.id)
  if (skillId === '') return undefined
  return {
    technique: cast.technique,
    /*
     * ⚠⚠ **容器那一份**：`ctx.cast.technique` 是**段**产物（它只有阶段和规则），
     *   而修饰副本住在**容器**产物的 `segments[].mods` 上。
     *   不记这一笔的话「载体消失」那边会遍历到一个空段数组 ⇒
     *   触发器**永远不响、而且一声不吭**（这一片踩过，见 `CarrierOrigin`）。
     */
    container: cast.homeTechnique,
    skillId,
    activation: cast.technique.activation,
    casterId: cast.casterId,
    /*
     * ⚠ ---- **按下那一刻的意图，抄一份带走**（2026-09-30 日志 62）----
     *
     *   触发器的「生成位置 = 瞄准的落点」（`origin: 'aim'`）以前在这条路上退化成
     *   "最近的敌人方向"（一个**猜出来**的点，玩家 2026-09-30 否掉了）。
     *   新口径是"取**触发这个技能的那次施法**的意图"—— 而这次施法到载体消失时
     *   早就结束了（`pruneCasts` 把它移出了 `world.casts`）⇒ **必须现在抄**。
     *
     *   ⚠ 抄的是**值**（不是 `cast` 的引用）：`cast.aimPoint` / `cast.facing` 之后
     *     还会被引擎改（阶段锁会换 `lockedFacing`），而"按下那一刻朝哪"不该跟着变。
     */
    intent: {
      ...(cast.aimPoint !== undefined
        ? { point: { x: cast.aimPoint.x, y: cast.aimPoint.y } }
        : {}),
      facing: { x: cast.facing.x, y: cast.facing.y },
    },
  }
}

/**
 * 「**这一发该不该追踪，拐多快**」—— 修饰零件「追踪」（2026-09-30 日志 56）。
 *
 * ## 它要解决的那个坑
 *
 * 修饰副本住在**容器**产物的 `segments[].mods` 上，而施法手里那一份
 * （`ctx.cast.technique`）是**段**产物 —— **段里没有 `mods`**。
 * ⚠ 这个坑日志 55 在「载体消失」上踩过一次（触发器**永远不响而且一声不吭**），
 *   修法是台账多记一份 `container`（`cast.homeTechnique`）。
 *   这里走同一条路：**从容器里按"段那一份的 id"找回这一段**，再读它的副本。
 *
 * ## 为什么要在**发射那一刻**抄进 `ProjectileSpec`
 *   · 子弹飞出去之后那次施法早结束了（`ctx` 不在了）；
 *   · sim 里**没有内容层**（原型表是 `bridge.ts` 读进来的）⇒ 运行时查不到原型；
 *   · 半路上改原型**不该**影响已经在飞的那一发（发射即锁定，和 `cast.facing` 同理）。
 *
 * ## ⚠ 为什么取"段的**第一**个技能"（`targetIndex === 0`）
 *
 * 和「份数」类 / 「排布」**同一个限制**：`at` 是"后面第几个技能"，
 * 而引擎落地"这一段的第一份施法"的地方只有一处（`activateGroup`）。
 * ⚠ `at > 0` 由校验器给 `MODIFIER_GROUP_AT_NOT_WIRED` 警告，**不静默**。
 *
 * ⚠ 找不到（不在施法中 / 不是序列段 / 这一段没挂追踪副本）⇒ `undefined`
 *   ⇒ **这一发就是普通直线弹** —— 和"没装这个零件"逐位相同。
 */
function homingOfCast(ctx: ActionContext): CompiledMod['homing'] | undefined {
  const cast = ctx.cast
  if (cast === undefined) return undefined
  const segments = cast.homeTechnique.segments
  if (segments === undefined) return undefined

  for (const segment of segments) {
    // ⚠ 按 **id** 认段（不是按下标）：`at` 在编译期就换算成绝对下标了，
    //   而这里手里只有"段那一份产物"，它的 `id` 就是锚点。
    if (segment.technique.id !== cast.technique.id) continue
    const mod = (segment.mods ?? []).find(m => m.kind === 'homing' && m.targetIndex === 0)
    return mod?.homing
  }
  return undefined
}

/**
 * 这一发所属的那一段上有没有「弹射」副本（日志 58）——
 * `homingOfCast` 的**同形**版本（读法必须一致：段产物里没有 `mods`，
 * 修饰副本住在**容器**产物的 `segments[].mods` 上，按 `id` 认段）。
 *
 * ⚠ 只取 `targetIndex === 0`（和追踪 / 份数类 / 排布同一个限制）——
 *   写在 `at: 1` 上的那几份**今天不生效**，校验器有一条
 *   `MODIFIER_GROUP_AT_NOT_WIRED` 专门出声。
 */
function bounceOfCast(ctx: ActionContext): CompiledMod['bounce'] | undefined {
  const cast = ctx.cast
  if (cast === undefined) return undefined
  const segments = cast.homeTechnique.segments
  if (segments === undefined) return undefined

  for (const segment of segments) {
    // ⚠ 按 **id** 认段（不是按下标）—— 和 `homingOfCast` 同一个坑、同一个解法。
    if (segment.technique.id !== cast.technique.id) continue
    const mod = (segment.mods ?? []).find(m => m.kind === 'bounce' && m.targetIndex === 0)
    return mod?.bounce
  }
  return undefined
}

/**
 * 执行一个动作。
 *
 * 目前支持：
 *   attribute    —— 改存储属性，或改管线伪属性
 *   damage       —— 嵌套一次命中（反伤、连锁、DOT）
 *   heal         —— 同上，治疗方向
 *   status       —— 挂状态 / 移除状态
 *   displacement —— 击退 / 拉拽 / 冲刺 / 传送
 *   perception   —— 隐形 / 显形 / 标记
 *   spawn        —— 按预设召唤单位
 *
 * ⚠ 七种**全部实现完了**。schema 里再加一种的话，这个 switch 会编译不过
 *   （default 分支里 p 会被收窄成 never），那正是我们想要的提醒。
 */
export function executeAction(ctx: ActionContext, action: Action): void {
  if (ctx.depth > MAX_ACTION_DEPTH) return

  const p = action.payload
  if (p === undefined) return

  /*
   * ---- 投射物：**任何载荷**都能被射出去 ----
   *
   * ⚠ 这里以前只认 `damage`（那一行是 `p.kind === 'damage' && …projectile`）。
   *   后果是：一个 `status` 载荷写了 `delivery: {kind:'projectile'}`，
   *   那个 delivery 会被**静默忽略**，变成"立刻命中锁定目标" ——
   *   技能照样能用、照样挂上状态，所以没人会发现箭根本没飞出去。
   *
   *   这个 bug 是加"按模式瞄准"时被测试逼出来的：锁定目标的语义一变，
   *   原来靠"锁定目标"兜底的假投射物就没有目标可打了，当场现形。
   *
   * 唯一的例外是**管线伪属性**（`pipeline.amount` 这类）：它改的是
   *   当前这一次命中，必须当场生效，不能延迟到落地。
   */
  const isPipelineAttr = p.kind === 'attribute' && isPipelinePath(p.path)
  if (action.delivery?.kind === 'projectile' && !isPipelineAttr) {
    spawnProjectileFrom(ctx, action)
    return
  }

  switch (p.kind) {
    case 'attribute': {
      const value = resolveValue(p.value, ctx)
      if (isPipelinePath(p.path)) {
        if (ctx.hit !== undefined) writePipelineAttr(ctx.hit, p.path, p.op, value)
        return
      }
      const t = resolveActionTarget(ctx, action)
      if (t === undefined) return
      applyAttributeAction(t, p.path, p.op, value, ctx)
      return
    }

    case 'damage':
    case 'heal': {
      const targets = pickActionTargets(ctx, action)
      if (targets.length === 0) {
        // 一个都没打中 —— 让施法者的 onMiss 规则有机会响应
        if (p.kind === 'damage') fireCastRules(ctx, 'onMiss')
        return
      }

      /*
       * ⚠⚠ **衰减只作用于 `damage`**（修饰零件「弹射」，2026-09-30 日志 58 **第二版** ——
       *   用户裁定原话："**衰减只作用于伤害，不要乘 heal** ✗ —— 用户原话只说'伤害' ✓
       *   而且'会弹的治疗'是另一种机制 ✗"）。
       *
       *   ⇒ `heal` **照原值**：一颗被弹射修饰的**治疗**弹丸，第二段治得和第一段一样多。
       *     （`tests/scenario.ts` 第 62c 节拿真的子弹打了两次治疗钉着它。）
       *
       *   ⚠ 缺省 / `x * 1` 那两条老规矩不变 ⇒ 除了弹射，引擎里**没有任何一条路**
       *   写 `ctx.amountScale`，今天的行为一个字节都不变。
       */
      const raw = resolveValue(p.amount, ctx)
      const amount = p.kind === 'damage' ? raw * (ctx.amountScale ?? 1) : raw
      for (const t of targets) {
        const nested: HitInit = {
          kind: p.kind,
          sourceId: ctx.actor.id,
          targetId: t.id,
          amount,
        }
        if (p.kind === 'damage') {
          if (p.damageType !== undefined) nested.damageType = p.damageType
          if (p.mode !== undefined) nested.mode = p.mode
        }
        const hit = resolveHit(ctx.world, createHit(nested), ctx.depth + 1)

        // 打中了 / 打空了 / 打死了，都要让施法者的规则有机会响应
        if (p.kind === 'damage') {
          fireCastRules(ctx, hit.connected ? 'onHit' : 'onMiss', t)
          if (!t.alive) fireCastRules(ctx, 'onKill', t)
        }
      }
      return
    }

    case 'status': {
      /*
       * ⚠ 这里必须用 pickActionTargets，不能用 resolveActionTarget。
       *
       * 用单目标解析器的话，`delivery` 和 `valid` 会被完全忽略 ——
       * 「无下限」那个 6 米光环会变成"只挂给自己"。
       * 这个 bug 真的踩过：光环挂到施法者头上，还挂着"移速 ×0.20"。
       */
      const targets = pickActionTargets(ctx, action)
      if (targets.length === 0) return

      for (const t of targets) {
        if (p.verb === 'remove') {
          if (p.statusId === undefined) continue
          const req: { tag?: string; sourceId?: string } = { tag: 'dispel' }
          if (ctx.sourceId !== undefined) req.sourceId = ctx.sourceId
          removeStatus(ctx.world, t, p.statusId, req)
          continue
        }

        const def = resolveStatusDef(ctx.world, p)
        if (def === undefined) {
          throw new Error(`找不到状态定义：${String(p.statusId)}`)
        }
        applyStatus(ctx.world, t, def, ctx.actor.id, p.stacks ?? 1)
      }
      return
    }

    case 'displacement': {
      const dist = resolveValue(p.distance, ctx)

      /*
       * ---- 谁动？两族，别混 ----
       *
       *   knockback / pull  → 动**目标**（把它推开 / 拉过来）
       *   dash / teleport   → 动**施法者自己**（朝面向方向冲 / 闪）
       *
       * 这不是约定俗成，是这两个动作的语义本身：
       * "击退"的主语永远是挨打的那个，"冲刺"的主语永远是冲刺的那个。
       * 硬用一个 target 字段统一它们，会让"给自己来一发击退"这种
       * 没人想要的效果变得可写。
       */
      if (p.mode === 'dash' || p.mode === 'teleport') {
        /*
         * ---- 落点：自己朝前，还是"以某个目标为锚" ----
         *
         * ⚠ 玩家 2026-09-21 要的"瞬移到标记敌人身后"，就是 `anchor: 'target'`。
         *   以前只有"沿我自己朝前闪 N 米"这一种写法，表达不出"那个人的身后"。
         *
         * ⚠ 锚定落点**必须有目标**（术式选出来的那个）。没有就什么都不做 ——
         *   退化成"朝前闪"的话，"标记丢了还瞬移出去"会变成一种随机传送，
         *   而玩家完全不知道为什么。宁可这一下白按（而且它本来就没冷却）。
         */
        if (p.anchor === 'target') {
          const t = ctx.target
          if (t === undefined || !t.alive) return

          const side = p.side ?? 'behind'
          // 目标自己的朝向（它背面 = 朝向的反方向）—— 和"朝向要跟着人转"同一个道理
          const tf = normalize2(t.facing)
          let dx = 0
          let dy = 0
          if (side === 'behind') { dx = -tf.x; dy = -tf.y }
          else if (side === 'front') { dx = tf.x; dy = tf.y }
          else if (side === 'left') { dx = -tf.y; dy = tf.x }
          else { dx = tf.y; dy = -tf.x }   // right

          ctx.actor.pos.x = t.pos.x + dx * dist
          ctx.actor.pos.y = t.pos.y + dy * dist

          ctx.world.events.push({
            type: 'displaced',
            entityId: ctx.actor.id,
            techniqueId: ctx.cast?.technique.id ?? '',
            mode: 'teleport',
            distance: dist,
          })
          return
        }

        const dir = normalize2(ctx.actor.facing)

        if (p.mode === 'teleport') {
          // 瞬移：直接改坐标，不经过中间的每一帧
          ctx.actor.pos.x += dir.x * dist
          ctx.actor.pos.y += dir.y * dist
        } else {
          // 冲刺：给一个冲量，所以它是**滑过去**的 ——
          // 中途撞上什么、被打断，都还在物理世界里
          addImpulse(ctx.world, ctx.actor, dir.x, dir.y, dist)
        }

        ctx.world.events.push({
          type: 'displaced',
          entityId: ctx.actor.id,
          techniqueId: ctx.cast?.technique.id ?? '',
          mode: p.mode,
          distance: dist,
        })
        return
      }

      // ---- 击退 / 拉拽：走载体几何，所以"范围击退"也能写 ----
      const targets = pickActionTargets(ctx, action)
      for (const t of targets) {
        const dx = t.pos.x - ctx.actor.pos.x
        const dy = t.pos.y - ctx.actor.pos.y
        const len = Math.sqrt(dx * dx + dy * dy)
        if (len < 1e-6) continue

        // knockback 沿着"施法者 → 目标"，pull 反过来
        const sign = p.mode === 'pull' ? -1 : 1
        const ux = (dx / len) * sign
        const uy = (dy / len) * sign

        addImpulse(ctx.world, t, ux, uy, dist)

        // 击飞：只加 z 冲量（渲染看得见弧线），不影响平面判定
        if (p.airborne === true) t.push.z += dist * 2

        ctx.world.events.push({
          type: 'displaced',
          entityId: t.id,
          techniqueId: ctx.cast?.technique.id ?? '',
          mode: p.mode,
          distance: dist,
        })
      }
      return
    }

    case 'perception': {
      /*
       * 感知：改"别人能不能看见你"。
       *
       * ⚠ 三种模式里只有 setVisibility 会造状态，另外两种是**反向操作**：
       *
       *   setVisibility  挂一个带 visibility 的状态 → 变隐形
       *   reveal         把降低可见性的状态**移掉** → 揪出来
       *   mark           挂一个 tagged 状态 → 给别的规则当钩子
       *
       * ⚠ reveal 为什么必须是"移除"而不是"再挂一个 visibility: 1 的状态"：
       *   `visibilityOf` 取的是**最小值**（只要有一个状态让你隐形，你就是隐形的）。
       *   所以想"让对方显形"，唯一的办法是把那个隐形状态拿掉。
       *   挂一个可见的状态是**没有用的** —— 最小值还是 0。
       */
      const targets = pickActionTargets(ctx, action)

      for (const t of targets) {
        if (p.mode === 'reveal') {
          const stripped = t.statuses.filter(s => (s.visibility ?? 1) < 1)
          for (const s of stripped) removeStatusInstance(ctx.world, t, s)
          ctx.world.events.push({
            type: 'revealed',
            entityId: t.id,
            techniqueId: ctx.cast?.technique.id ?? '',
            removed: stripped.length,
          })
          continue
        }

        const duration = p.duration ?? PERCEPTION_DEFAULT_DURATION

        if (p.mode === 'setVisibility') {
          // 不写 value 就当"完全隐形"（0）—— 校验器会警告 setVisibility 缺 value
          const v = Math.max(0, Math.min(1, resolveValue(p.value ?? { const: 0 }, ctx)))
          const def: StatusDef = {
            id: 'status.perception.hidden',
            name: v <= 0 ? '隐形' : '半透明',
            tags: ['buff', 'perception'],
            duration,
            visibility: v,
            removal: { expires: true },
          }
          applyStatus(ctx.world, t, def, ctx.actor.id, 1)
          continue
        }

        // mark：只打标签。它本身没有数值效果，
        // 价值在于别的规则能用 hasStatusTag(target, 'marked') 认出人来
        const def: StatusDef = {
          id: 'status.perception.marked',
          name: '标记',
          tags: ['debuff', 'marked', 'perception'],
          duration,
          removal: { expires: true },
        }
        applyStatus(ctx.world, t, def, ctx.actor.id, 1)
      }
      return
    }

    case 'spawn': {
      /*
       * 召唤：按预设造几个单位出来。
       *
       * ⚠ 这是"廉价版召唤" —— 只能引用 `content/entities/` 里的**预设**，
       *   不能现场捏一个。玩家自定义召唤物的 AI 是另一个量级的工程
       *   （自己写行为、自己配技能组、自己定成长），留给以后。
       *
       * 这条线划在这儿是有意的：它让「召唤骷髅」「狼群」「分身」这一整类
       * 技能当天就能写出来，代价是召唤物不能长得随心所欲。
       */
      const def = ctx.world.entityDefs.get(p.entityId)
      if (def === undefined) {
        // 内容写错了名字。加载期检查本该拦住它 —— 拦不住就说明内容绕过了
        // 检查，这时候宁可炸也不要静默召唤出一团空气
        throw new Error(`找不到实体预设：${p.entityId}`)
      }

      const count = Math.max(1, Math.floor(p.count ?? 1))
      const caster = ctx.actor

      /*
       * 阵营：`'caster'` 解析成召唤者的阵营。
       *
       * 写死 'enemy' 的话，敌人召唤的骷髅会帮着玩家打 —— 写死 'player'
       * 反过来。这就是纪律 1（一切按阵营动态查询）在内容层的体现。
       */
      const faction: Faction = def.faction === 'caster' ? factionOf(caster) : def.faction

      // 生命周期
      let lifetime = -1
      let diesWithOwner = false
      if (typeof p.lifetime === 'number') lifetime = p.lifetime
      else if (p.lifetime === 'untilCasterDies') diesWithOwner = true
      // 'permanent' 和不写都是 -1（一直活着）

      for (let i = 0; i < count; i++) {
        /*
         * ⚠ **区域**摆在落点上，别的召唤物摆在召唤者周围一圈。
         *
         *   区域是"一块地方"，不是"一个单位"：它必须长在
         *   `areapoint` 术式点的那一点（`cast.aimPoint`），
         *   不然"往那块地上放一片减速场"就变成"放在自己脚下"。
         *
         *   而且区域**不做环形散开** —— 一片火墙散成两个半片是没有意义的。
         */
        /*
         * ⚠ **屏障**（`kind: 'obstacle'`）和区域一样摆在**落点**上，而且
         *   **朝向跟着施法者**：一堵墙是"横在你面前"的东西，
         *   它的轴就是施法者当时的朝向。
         *
         *   和区域的区别：区域谁都能穿过去，屏障会挡（`Entity.block`）。
         */
        const isBarrier = def.kind === 'obstacle'
        const isField = def.kind === 'area'
        const fallback = isField || isBarrier
          ? { x: ctx.cast?.aimPoint?.x ?? caster.pos.x, y: ctx.cast?.aimPoint?.y ?? caster.pos.y }
          : (() => {
            /*
             * 摆在召唤者周围一圈。
             *
             * ⚠ 不能都摆在同一个点上：几个单位叠在一起，选中、击退、
             *   范围技能全都会表现得像只有一个。按方向均分到半径 1.2 米的圈上，
             *   至少彼此分得开。
             *
             * ⚠ 起点要**避开已经有的召唤物**：只按 `i` 取方向的话，
             *   第二次召唤的第一个又会落在方向 0 上，和上一次那个完全重叠
             *   （实测 0.00 米）。所以要数一下主人名下已有的同类，
             *   从下一个方向开始排。
             *
             * ⚠ 这里**不用 sin/cos** —— 纪律 4 禁掉了它们（跨 JS 引擎不保证
             *   逐位一致，会破坏重放）。用固定的八个单位方向向量轮取：
             *   召唤物最多也就几个，八个方向够用，而且是纯常量。
             */
            const existing = ctx.world.entities.filter(e =>
              e.alive && e.ownerId === caster.id && e.defId === def.id).length
            const d = SPAWN_RING[(existing + i) % SPAWN_RING.length] ?? SPAWN_RING[0]!
            const r = 1.2
            return { x: caster.pos.x + d[0] * r, y: caster.pos.y + d[1] * r }
          })()

        const init: SpawnInit = {
          faction,
          tags: def.tags !== undefined ? [...def.tags] : [],
          pos: fallback,
          base: def.attributes ?? {},
          techniqueIds: def.techniques ?? [],
          ownerId: caster.id,
          lifetime,
          defId: def.id,
          // 屏障的朝向 = 施法者当时的朝向（"横在你面前"）
          ...(isBarrier ? { facing: { ...caster.facing } } : {}),
        }
        if (isField) init.kind = 'area'
        if (isBarrier) init.kind = 'obstacle'
        if (def.radius !== undefined) init.radius = def.radius
        if (def.shape !== undefined) init.shape = def.shape
        if (def.block !== undefined) init.block = def.block
        if (def.ai !== undefined) init.ai = def.ai
        if (diesWithOwner) init.diesWithOwner = true

        const minion = spawn(ctx.world, init)

        /*
         * ⚠ ---- **记下"这次施法放出去了一个会自己在世界里活着的东西"** ----
         *   （2026-09-30 日志 55）
         *
         *   这一条路一次长出**三档**载体（玩家点名的那几类里的三档）：
         *     · `kind: 'area'`     —— 落点区域（`place-slow-field` / 火墙那种）
         *     · `kind: 'obstacle'` —— 屏障（`barrier` / `aegis` 那种）
         *     · 其余               —— 召唤物（骷髅 / 图腾 / 分身）
         *   ⚠ 三档**都**要记：它们都有"后来怎么样了"（到期 / 被打掉 / 被撤掉），
         *   而玩家要的引信对这三档是一视同仁的。
         *
         *   ⚠ 记在 `spawn` **之后**、而且在 `count` 循环**里面** ——
         *   一次施法放了几个就记几笔，"全部消失才算"才数得对
         *   （语义和理由见 `mod-state.ts` 的 `allCarriersGone`）。
         */
        const carrier = carrierOriginOf(ctx)
        if (carrier !== undefined && ctx.cast !== undefined) {
          recordCarrier(ctx.world, minion, ctx.cast.id, carrier)
        }

        // 预设里的常驻术式（被动）当场挂上
        for (const id of def.activeTechniques ?? []) {
          setTechniqueActive(ctx.world, minion, id, true)
        }

        ctx.world.events.push({
          type: 'summoned',
          entityId: minion.id,
          ownerId: caster.id,
          defId: def.id,
          faction,
        })
      }
      return
    }

    default: {
      /*
       * 七种载荷**全部实现完了** —— 所以 TypeScript 在这里把 `p` 收窄成了
       * `never`（这就是为什么下面要 `as` 一下才能读到 kind）。
       *
       * 这个分支保留着，是为了"schema 加了第八种载荷但忘了实现"的情况：
       * 那种时候它会在运行时报错，而不是静默什么都不做。
       */
      const unknown = p as { kind: string }
      throw new Error(
        `动作类型「${unknown.kind}」还没实现。目前支持 attribute / damage / heal / status / displacement / perception / spawn。`,
      )
    }
  }
}

function resolveStatusDef(world: World, p: { statusId?: string; inline?: StatusDef }): StatusDef | undefined {
  if (p.inline !== undefined) return p.inline
  if (p.statusId !== undefined) return world.statusDefs.get(p.statusId)
  return undefined
}

/**
 * 动作打到谁身上。
 *
 * 默认打 ctx.target —— 这次命中里"对面那个"：
 *   被打侧的钩子（反伤）→ 打人的人
 *   打人侧的钩子（吸血的目标之外）→ 被打的人
 * 若动作声明 target: 'self'，就打 ctx.actor（吸血、给自己挂无敌）。
 *
 * 注意这和 Targeting（怎么选中目标）完全是两回事。
 *
 * ⚠⚠ **2026-09-30 日志 61：没有目标 ⇒ 这个动作什么都不做**（以前是
 *   `ctx.target ?? ctx.actor`，也就是**算到施法者自己头上**）。
 *
 *   为什么那一条要清掉（用户定的）：一个"需要目标"的动作（打人 / 挂状态 /
 *   改属性 / 位移）**选不到目标**时，正确的表现是"这一下白放" ——
 *   而 `?? ctx.actor` 让"锁定目标不见了"变成一个**静默的自伤 / 自增益**：
 *   玩家看到的是"我明明瞄着它，怎么套在自己身上了"，而且没有任何提示。
 *   ⚠ 它和"瞬移到目标身后但没有目标"(见 `displacement` 那条 `anchor`)是
 *     **同一条纪律**：不许"随便挑一个"，也不许"算我自己身上"。
 *
 *   ⚠ **不会误伤"本来就打自己"的内容**：`runTechniqueRules` 已经先判
 *     `tech.targeting.valid` 是不是**清一色 self** —— 是的话 `ctx.target`
 *     **就是**施法者（那条路一个字都没动）。这里拦的只是"合法目标不含自己、
 *     又没选到任何目标"那一种。
 *   ⚠ 想"无论如何都打自己"的动作请**显式写** `target: 'self'`（定稿口径：
 *     落点是**每条动作一处**，不靠兜底猜）。
 */
function resolveActionTarget(ctx: ActionContext, action: Action): Entity | undefined {
  if (action.target === 'self') return ctx.actor
  return ctx.target
}

/**
 * 一个动作可能打到多个目标 —— 扇形挥砍、范围爆炸都是。
 *
 * 有载体规格时按几何找目标；没有就退回单体（术式的 targeting 选出来的那一个）。
 *
 * ⚠ 没有目标 ⇒ **空表**（动作什么都不做）—— 理由和 `resolveActionTarget`
 *   那一段**逐字相同**（日志 61），两处必须是同一条规矩：
 *   只清一处的话，"没载体"和"有载体"两条路会给出两种答案。
 */
function pickActionTargets(ctx: ActionContext, action: Action): Entity[] {
  if (action.target === 'self') return [ctx.actor]

  const d = action.delivery
  if (d === undefined) {
    const t = ctx.target
    return t === undefined ? [] : [t]
  }

  const hits = resolveTargets(ctx.world, {
    caster: ctx.actor,
    // 动作自己声明了 valid 就用它 —— 否则继承术式的 targeting.valid
    valid: action.valid ?? ctx.validTargets ?? ['enemy'],
    delivery: d,
    origin: ctx.actor,
    /*
     * ⚠ 朝向和中心**只在对应模式真的需要时才传**（见 ResolvedAim 的两个开关）。
     *
     *   全都传的话会出事：前摇 0.3 秒里人已经移动了，用施法那一刻的坐标
     *   当中心，挥砍就砍在身后的空气上 —— `duel` 里的剑士当场打出 0 伤害。
     *   所以：
     *     originPoint   只有 areapoint（点地面）才钉
     *     facing        **施法那一刻的朝向**（`cast.facing`），见上面那段注释 ——
     *                   2026-09-21 起 `directional` 也钉住了，不再跟着 `actor.facing` 走
     */
    ...(ctx.cast?.aimPoint !== undefined ? { originPoint: ctx.cast.aimPoint } : {}),
    ...(ctx.cast !== undefined ? { facing: ctx.cast.facing } : {}),
    ...(ctx.target !== undefined ? { preferredId: ctx.target.id } : {}),
  })

  /*
   * 告诉客户端"这一下打出去了，形状是这样"。
   *
   * ⚠ 放在这里是因为**这里是唯一一处**把载体规格变成目标的地方 ——
   *   所有瞬时载体（扇形 / 光束 / 突刺 / 范围 / 光环）都走这条路径，
   *   投射物不走（它在上面就 return 了，它自己是实体，客户端已经在画）。
   *
   * ⚠ 打空了也发（hitCount: 0）。
   */
  const p = action.payload
  /*
   * ⚠ 载体几何可能是**动态参数**（`{ ref: 'weapon.reach' }`），
   *   而事件里要的是**那一刻真的用了多少米** —— 客户端照着它画特效，
   *   画错的话"够得着"和"看着够得着"就分家了。
   *   判定那边（`resolveTargets`）自己解析同一个 ref，两处用的是同一个值。
   */
  const geomLength = geomNumber(d.length, ctx)
  const geomRadius = geomNumber(d.radius, ctx)
  /*
   * ⚠ 事件里的方向要和**真的打出去的方向**一致（判定用的是
   *   `cast.facing ?? actor.facing`，见上面 `resolveTargets` 那段）。
   *   两处不一致的表现是"打中了 A，刀光却画在 B 那边"——
   *   而"够得着"和"看着够得着"分家正是这个项目一直在防的事。
   */
  const firedDir = ctx.cast?.facing ?? ctx.actor.facing
  ctx.world.events.push({
    type: 'deliveryFired',
    casterId: ctx.actor.id,
    techniqueId: ctx.cast?.technique.id ?? '',
    kind: d.kind,
    from: { x: ctx.actor.pos.x, y: ctx.actor.pos.y },
    dir: { x: firedDir.x, y: firedDir.y },
    ...(geomLength !== undefined ? { length: geomLength } : {}),
    ...(d.width !== undefined ? { width: d.width } : {}),
    ...(geomRadius !== undefined ? { radius: geomRadius } : {}),
    ...(d.angle !== undefined ? { angle: d.angle } : {}),
    hitCount: hits.length,
    ...(p.kind === 'damage' && p.damageType !== undefined ? { damageType: p.damageType } : {}),
    ...(d.vfx !== undefined ? { vfx: d.vfx } : {}),
  })

  // ⚠ 这里是**所有载体**的唯一汇聚点（投射物除外，它上面就 return 了）——
  //   所以"这一段技能碰到人了没有"也在这里记。
  markSkillHit(ctx, hits)

  return hits
}

/**
 * 记下"**这一段技能碰到人了**"。
 *
 * ⚠ 这是术式能编程的另一半（条件那一半是 `prevHit`，见 conditions.ts）。
 *   没有它的话，`links` 里的 `prevHit` 永远读到 false。
 *
 * 判定标准：这次动作作用到了**除自己以外**的至少一个单位。
 *   为什么排除自己：`prevHit` 问的是"碰到了没有"，给自己挂个护甲不算碰到人 ——
 *   不然"位移过去没撞到就不炸"会退化成"永远都炸"
 *   （因为自我增益也把自己算成目标了）。
 *
 * ⚠ 投射物**不算**：它飞出去的时候这次施法早就结束了，命中的是未来某一刻。
 *   所以"射一发、中了才接下一段"用这个机制写不出来 —— 见日志的欠账。
 */
function markSkillHit(ctx: ActionContext, targets: readonly Entity[]): void {
  const cast = ctx.cast
  if (cast === undefined) return
  if (!targets.some(t => t.id !== ctx.actor.id)) return

  const phase = cast.technique.phases[cast.phaseIndex]
  if (phase === undefined) return
  const skill = ownerOf(phase.id)
  if (skill === '' || cast.hitSkills.includes(skill)) return
  cast.hitSkills.push(skill)
}

/** 施法者的 cast 规则因为某次命中而触发 */
function fireCastRules(ctx: ActionContext, when: TriggerEvent, target?: Entity): void {
  const cast = ctx.cast
  if (cast === undefined) return
  const caster = ctx.world.entities.find(e => e.id === cast.casterId)
  if (caster === undefined) return
  runRules(ctx.world, cast, caster, when, target !== undefined ? { target } : {})
}

/**
 * 跑一个术式里匹配某个时机的全部规则。
 *
 * 这是"规则执行"的核心：`当【时机】若【条件】则【动作】`。
 * 规则顺序由玩家拖出来的 order 决定 —— 这是玩家唯一能控制的排序，
 * 六个管线阶段本身是系统固定的。
 *
 * ⚠ 动作的**默认目标**由术式的 targeting 决定，不能无脑用锁定目标：
 *     只对 self 有效 → 打自己（自我增益、护甲、铁布衫这类）
 *     否则          → 打锁定的目标
 *   不这样分的话，"熔岩护甲给自己挂减速"会挂到敌人头上（真踩过）。
 */
export function runTechniqueRules(
  world: World,
  tech: CompiledTechnique,
  caster: Entity,
  when: TriggerEvent,
  opts: { phaseId?: string; target?: Entity; cast?: CastInstance } = {},
): void {
  const matched = tech.rules
    .filter(r => r.when === when)
    .filter(r => opts.phaseId === undefined || r.phaseId === opts.phaseId)
    .sort((a, b) => a.order - b.order)

  if (matched.length === 0) return

  const selfOnly = tech.targeting.valid.length > 0
    && tech.targeting.valid.every(v => v === 'self')
  const lockedId = opts.cast?.targetId
  const lockedTarget = lockedId === undefined
    ? undefined
    : world.entities.find(e => e.id === lockedId)
  const target = opts.target ?? (selfOnly ? caster : lockedTarget)

  for (const rule of matched) {
    /*
     * onTick 的限速。
     *
     * 没写 every 的话 onTick 是**每个 tick 都触发**（一秒 60 次）——
     * "每 0.5 秒扣 3 能量"会变成每秒扣 180 点。这个坑真踩过。
     */
    if (when === 'onTick' && rule.every !== undefined && rule.every > 0) {
      const key = `${tech.id}:${rule.id}`
      const left = caster.ruleTimers.get(key) ?? 0
      if (left > 0) continue
      caster.ruleTimers.set(key, rule.every)
    }

    const ctx: ActionContext = {
      world,
      self: caster,
      actor: caster,
      depth: 0,
      sourceId: tech.id,
      validTargets: tech.targeting.valid,
    }
    if (opts.cast !== undefined) ctx.cast = opts.cast
    if (target !== undefined) ctx.target = target

    if (!evaluateAll(rule.if, ctx)) continue
    for (const action of rule.then ?? []) {
      executeAction(ctx, action)
    }
  }
}

/** 施法中的规则执行。带上 cast，动作就能读到 skill.* 和蓄力量 */
export function runRules(
  world: World,
  cast: CastInstance,
  caster: Entity,
  when: TriggerEvent,
  opts: { phaseId?: string; target?: Entity } = {},
): void {
  runTechniqueRules(world, cast.technique, caster, when, { ...opts, cast })
}

/**
 * 动作改属性。
 *
 * ⚠ 只允许改**存储属性**和管线伪属性。
 *   派生属性（char.hp.max / speed / 暴击率）要改，得挂一个带 modifiers 的状态 ——
 *   因为动作是一次性的，而派生属性需要持续生效的修饰。
 *   这条区分如果不守，玩家会发现"加了 buff 但是下一帧就没了"。
 */
function applyAttributeAction(
  target: Entity,
  path: string,
  op: ModifierOp,
  value: number,
  ctx: ActionContext,
): void {
  const cast = ctx.cast

  // skill.* 是"这次施法"的属性，永远属于施法者，不属于被打的人。
  // 不这样做的话，"击杀时重置本术式 CD" 会去改敌人身上的冷却（真的踩过）。
  let owner = target
  if (cast !== undefined && path.startsWith('skill.')) {
    owner = ctx.world.entities.find(e => e.id === cast.casterId) ?? target
  }

  // skill.cooldown 是"当前这个术式的冷却"的简写 —— 露娜的大招刷新写起来就是它
  const resolved = path === 'skill.cooldown' && cast !== undefined
    ? cooldownPath(cast.technique.id)
    : path

  const writable = owner.stored.has(resolved) || resolved.startsWith('cd.')
  if (!writable) {
    throw new Error(
      `动作只能改存储属性（char.hp.current / char.energy.current / `
      + `char.bloodPact.current / cd.*）或管线伪属性（pipeline.*）。`
      + `「${path}」是派生属性 —— 要改它请挂一个带 modifiers 的状态。`,
    )
  }
  setStored(owner, resolved, applyOp(getStored(owner, resolved), op, value))
}

/** 方便：造一次命中并直接跑完 */
export function dealDamage(
  world: World,
  sourceId: number,
  targetId: number,
  amount: number,
  opts: { damageType?: string; mode?: 'normal' | 'lethal'; tags?: string[] } = {},
): HitInstance {
  const init: HitInit = { kind: 'damage', sourceId, targetId, amount, tags: opts.tags ?? [] }
  if (opts.damageType !== undefined) init.damageType = opts.damageType
  if (opts.mode !== undefined) init.mode = opts.mode
  return resolveHit(world, createHit(init))
}

/** 方便：造一次治疗并直接跑完 */
export function heal(
  world: World,
  sourceId: number,
  targetId: number,
  amount: number,
): HitInstance {
  return resolveHit(world, createHit({ kind: 'heal', sourceId, targetId, amount }))
}

export { hpPercent }
