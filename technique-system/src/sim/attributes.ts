/**
 * 属性系统 —— 整个引擎的核心积木。
 *
 * 前面讨论里，这一块单独吃掉了 6 个独立需求：
 *   露娜的 CD 重置、暴击叠层、时停免疫、六眼开关、移速惩罚、能量上限被吃。
 * 所以它必须先做，而且要做好。
 *
 * 两类属性，别混：
 *   存储属性 stored —— 会被直接改写（char.hp.current / char.energy.current）
 *   派生属性 derived —— 基础值 + 状态修饰，算出来的（char.hp.max / speed / char.energy.regen）
 */
import type { AttributeMod, ValueRef, ValueSpec } from '../schema.ts'
import type { Entity, ActiveStatus, ValueContext } from './types.ts'
import { weaponParam } from './types.ts'
import { factionOf, statusStacks } from './status.ts'
import { distance } from './geom.ts'

/**
 * targetCount 需要一个查询半径，而 schema 里暂时没有这个字段。
 * 先用一个显式常量，等第 7 步（场景套件）再把它变成规则参数。
 */
export const DEFAULT_QUERY_RADIUS = 5

/**
 * 把一个 ValueSpec 解析成当前情境下的数值。
 *
 * 这是第 3 步补上的东西 —— 没有它，"越近越慢"（ref: distance）、
 * "残血增伤"（ref: missingHpPct）、"按灼烧层数加成"（ref: targetStacks）
 * 全都算不出来。
 *
 * 有 ref 但没有上下文时故意抛错：静默算错比崩掉危险得多。
 */
export function resolveValue(v: ValueSpec, ctx?: ValueContext): number {
  if (typeof v.const === 'number') return clampValue(v, v.const)

  const ref = v.ref
  if (ref === undefined) {
    throw new Error('ValueSpec 既没有 const 也没有 ref')
  }
  if (ctx === undefined) {
    throw new Error(
      `动态参数 ref="${ref}" 需要一个上下文。`
      + '它得知道"谁、打谁、距离多少" —— 请把 ValueContext 传下来。',
    )
  }

  const raw = readRef(ref, v, ctx)
  return clampValue(v, applyCurve(v.curve, raw))
}

function clampValue(v: ValueSpec, n: number): number {
  let out = n
  if (typeof v.min === 'number' && out < v.min) out = v.min
  if (typeof v.max === 'number' && out > v.max) out = v.max
  return out
}

/** 曲线：[[输入, 输出], ...] 线性插值。无下限术式靠它 */
function applyCurve(curve: [number, number][] | undefined, x: number): number {
  if (curve === undefined || curve.length === 0) return x
  const first = curve[0]
  if (first === undefined) return x
  if (curve.length === 1) return first[1]
  if (x <= first[0]) return first[1]

  const last = curve[curve.length - 1]
  if (last === undefined) return x
  if (x >= last[0]) return last[1]

  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1]
    const b = curve[i]
    if (a === undefined || b === undefined) continue
    if (x <= b[0]) {
      const span = b[0] - a[0]
      if (span === 0) return b[1]
      return a[1] + ((x - a[0]) / span) * (b[1] - a[1])
    }
  }
  return last[1]
}

/** 读一个运行时量 */
function readRef(ref: ValueRef, v: ValueSpec, ctx: ValueContext): number {
  switch (ref) {
    case 'distance':
      if (ctx.target === undefined) return 0
      return distance(ctx.self.pos, ctx.target.pos)

    case 'selfHpPct':
      return hpPercent(ctx.self)

    case 'missingHpPct':
      return 1 - hpPercent(ctx.self)

    case 'targetStacks':
      if (ctx.target === undefined || v.refArg === undefined) return 0
      return statusStacks(ctx.target, v.refArg)

    case 'targetCount': {
      let n = 0
      for (const e of ctx.world.entities) {
        if (!e.alive || e.id === ctx.self.id) continue
        if (factionOf(e) === factionOf(ctx.self) || factionOf(e) === 'neutral') continue
        if (distance(ctx.self.pos, e.pos) > DEFAULT_QUERY_RADIUS) continue
        n++
      }
      return n
    }

    case 'elapsed': {
      const s = ctx.status
      if (s === undefined || s.duration < 0) return 0
      return s.duration - s.remaining
    }

    case 'charge':
      return ctx.cast?.charge ?? ctx.status?.vars['charge'] ?? 0

    /*
     * ---- 武器参数 ----
     *
     * ⚠ 这三个和上面那些**本质不同**：上面都是**运行时量**
     *   （到目标的距离、蓄了多少、残血多少），它们是**这把武器的属性** ——
     *   在装上武器那一刻就定了，一整个施法过程里不会变。
     *
     *   这就是"同一份横砍模板，长剑和短匕打出来不一样"的全部机制。
     *
     * ⚠ 读的是 `ctx.self`（**施法者**）的武器，不是目标的。
     *   一次挥砍的射程和伤害取决于"谁在挥"，和"砍到的是谁"无关 ——
     *   写成 ctx.target 的话，打谁就变成谁的武器参数，而且完全讲不通。
     *
     * ⚠ 没武器 / 武器没写那一条 → 用全局缺省值（`WEAPON_DEFAULTS`）。
     *   这就是"空手的敌人也放得出技能"：忘配武器不会让技能变成 0 伤害。
     */
    case 'weapon.reach':
    case 'weapon.damage':
    case 'weapon.windup':
      return weaponParam(ctx.self.weapon?.attributes ?? {}, ref)

    default:
      throw new Error(`不认识的运行时量：${String(ref)}`)
  }
}

/**
 * 求一个属性的最终值。
 *
 * 顺序固定，不许改：基础值 → 加算 → 乘算 → set/reset 覆盖
 * 顺序一变，同一套配置算出来的数就不一样，所以这是硬约定。
 *
 * 存储属性直接返回，不吃任何状态修饰 —— 想持续扣能量，用 onTick 规则，
 * 那才会真的改写它。这条区分是故意的。
 *
 * ctx 只在"状态修饰里用了动态参数"时才需要。
 */
export function resolveAttribute(entity: Entity, path: string, ctx?: ValueContext): number {
  const stored = entity.stored.get(path)
  if (stored !== undefined) return stored

  const base = entity.base.get(path) ?? 0
  let flat = 0
  let mul = 1
  let override: number | undefined

  for (const status of entity.statuses) {
    for (const mod of status.modifiers) {
      if (mod.path !== path) continue
      // 修饰的值本身也可能是动态参数；self 换成挂这个状态的人
      const modCtx = modifierContext(ctx, entity, status)
      const v = resolveValue(mod.value, modCtx)
      switch (mod.op) {
        case 'add':
          flat += v
          break
        case 'stack':
          // 按状态的层数叠加：5 层 × +2 = +10
          flat += v * status.stacks
          break
        case 'mul':
          mul *= v
          break
        case 'set':
          override = v
          break
        case 'reset':
          // 恢复成初始值。露娜的大招刷新靠它
          override = base
          break
      }
    }
  }

  if (override !== undefined) return override
  return (base + flat) * mul
}

/** 这个属性是不是存储属性 */
export function isStored(entity: Entity, path: string): boolean {
  return entity.stored.has(path)
}

/**
 * 求值状态修饰时用的上下文。
 *
 * ⚠ 关键一条：`target` 换成**挂这个状态的人**。
 *
 * 状态上的 `ref: 'distance'` 指的应该是"离给我上状态那个人多远" ——
 * "无下限术式"（越靠近我越慢）就是靠这个。不换的话 distance 永远是 0，
 * 效果会变成"无论多远都按最近算"。
 */
function modifierContext(
  ctx: ValueContext | undefined,
  entity: Entity,
  status: ActiveStatus,
): ValueContext | undefined {
  if (ctx === undefined) return undefined

  const next: ValueContext = { ...ctx, self: entity, status }
  if (status.sourceId !== entity.id) {
    const src = ctx.world.entities.find(e => e.id === status.sourceId)
    if (src !== undefined) next.target = src
  }
  return next
}

// ---------------------------------------------------------------- 存储属性读写

export function getStored(entity: Entity, path: string): number {
  return entity.stored.get(path) ?? 0
}

export function setStored(entity: Entity, path: string, value: number): void {
  entity.stored.set(path, value)
}

export function addStored(entity: Entity, path: string, delta: number): void {
  entity.stored.set(path, getStored(entity, path) + delta)
}

// ---------------------------------------------------------------- 只读查询

/** 还活着吗（血量 > 0） */
export function isAlive(entity: Entity): boolean {
  return entity.alive && getStored(entity, 'char.hp.current') > 0
}

/** 血量百分比，0~1。动态参数 selfHpPct 靠它 */
export function hpPercent(entity: Entity): number {
  const max = resolveAttribute(entity, 'char.hp.max')
  if (max <= 0) return 0
  return getStored(entity, 'char.hp.current') / max
}
