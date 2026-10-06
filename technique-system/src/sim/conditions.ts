/**
 * 条件求值。
 *
 * 条件在三个地方用到：规则的 if、管线钩子的 if、以及以后 AI 的决策。
 * 所以它必须只有一份实现 —— 这是纪律 6 的另一面：
 * 管线钩子有三个来源（技能图 / 状态 / 实体），但它们跑的是同一套判断。
 */
import type { Condition } from '../schema.ts'
import type { CastInstance, Entity, ValueContext } from './types.ts'
import { factionOf, statusStacks, hasStatus, hasTag, hasStatusTag } from './status.ts'
import { distance } from './geom.ts'
import { hpPercent } from './attributes.ts'
import { DEFAULT_QUERY_RADIUS } from './attributes.ts'
import { ownerOf } from './compile.ts'

/**
 * 暴击暂时用标签表达：命中实例的 tags 里带 'crit' 就算暴击。
 * 等第 4 步做技能执行时，会由一条规则往里写这个标签。
 */
export const CRIT_TAG = 'crit'

function pick(who: Condition['who'], ctx: ValueContext): Entity | undefined {
  switch (who) {
    case 'target':
      return ctx.target
    case 'caster': {
      // "caster" = 这次命中是谁打出来的
      const id = ctx.hit?.sourceId
      if (id === undefined) return ctx.self
      return ctx.world.entities.find(e => e.id === id) ?? ctx.self
    }
    case 'self':
    default:
      return ctx.self
  }
}

export function evaluateCondition(c: Condition, ctx: ValueContext): boolean {
  switch (c.type) {
    case 'not':
      return !(c.of ?? []).some(sub => evaluateCondition(sub, ctx))

    case 'anyOf':
      return (c.of ?? []).some(sub => evaluateCondition(sub, ctx))

    case 'allOf':
      return (c.of ?? []).every(sub => evaluateCondition(sub, ctx))

    case 'hasTag': {
      const e = pick(c.who, ctx)
      return e !== undefined && typeof c.value === 'string' && hasTag(e, c.value)
    }

    /*
     * ⚠ hasTag 和 hasStatusTag 是**两件事**，别混：
     *
     *   hasTag       查实体**自身**的标签（undead / boss / construct）
     *   hasStatusTag 查它**身上状态**的标签（shield / dot / buff）
     *
     *   混用会静默失败 —— 条件永远不成立，规则永远不触发，
     *   看起来像"技能没效果"。裂魂那条"命中时驱散护盾"就是这么死的：
     *   它写的是 hasTag(target, 'shield')，而护盾是**状态**的标签，
     *   实体自己身上没有 shield 这个标签，所以条件恒为假。
     *
     *   hasStatusTag 这个函数在 status.ts 里一直都有，但以前**没有任何
     *   条件类型能调到它** —— 实现了却接不上线，等于没有。
     */
    case 'hasStatusTag': {
      const e = pick(c.who, ctx)
      return e !== undefined && typeof c.value === 'string' && hasStatusTag(e, c.value)
    }

    case 'hasStatus': {
      const e = pick(c.who, ctx)
      return e !== undefined && typeof c.value === 'string' && hasStatus(e, c.value)
    }

    case 'stackAtLeast': {
      const e = pick(c.who, ctx)
      if (e === undefined || typeof c.value !== 'string') return false
      const need = typeof c.range === 'object' ? c.range[0] : 1
      // value 是状态 id，阈值放 range[0]
      return statusStacks(e, c.value) >= need
    }

    case 'hpBelow': {
      const e = pick(c.who, ctx)
      if (e === undefined) return false
      const threshold = typeof c.value === 'number' ? c.value : 0
      // 阈值写成 0~1 的百分比
      return hpPercent(e) < threshold
    }

    case 'distanceIs': {
      if (ctx.target === undefined) return false
      const d = distance(ctx.self.pos, ctx.target.pos)
      const r = c.range ?? [0, Infinity]
      return d >= r[0] && d <= r[1]
    }

    case 'targetCountIs': {
      let n = 0
      for (const e of ctx.world.entities) {
        if (!e.alive || e.id === ctx.self.id) continue
        if (factionOf(e) === factionOf(ctx.self) || factionOf(e) === 'neutral') continue
        if (distance(ctx.self.pos, e.pos) > DEFAULT_QUERY_RADIUS) continue
        n++
      }
      const r = c.range ?? [0, Infinity]
      return n >= r[0] && n <= r[1]
    }

    case 'isCrit': {
      const want = c.value !== 0
      const got = ctx.hit?.tags.includes(CRIT_TAG) ?? false
      return want === got
    }

    case 'hitKindIs':
      // 亡灵反转靠它：只在"治疗"进来时才翻转
      return ctx.hit !== undefined && ctx.hit.kind === c.value

    /*
     * ⚠ `prevHit`：**这一段技能有没有碰到过人**。
     *
     *   这是术式"编程组合"里最常用的那个条件 ——
     *   「位移过去，碰到了才炸」里的"碰到了"就是它。
     *
     * ⚠ 它读的是**当前阶段所属的那一段技能**，不是"往回找上一段不同的技能"。
     *
     *   为什么：连接条件是在**离开上一段的那一刻**求值的
     *   （`advancePhase` 里，`cast.phaseIndex` 还停在上一段的最后一个阶段）。
     *   站在那个位置，"刚才那段"就是当前阶段的主人。
     *   第一版写成"往回找第一个不同技能的阶段"，结果是**永远找不到**
     *   （往回走全是自己这一段），条件恒为 false ——
     *   验收测试当场抓到：碰上了也不炸。
     */
    case 'prevHit': {
      const cast = ctx.cast
      if (cast === undefined) return false
      const phase = cast.technique.phases[cast.phaseIndex]
      if (phase === undefined) return false
      const skill = ownerOf(phase.id)
      if (skill === '') return false
      return cast.hitSkills.includes(skill)
    }

    default:
      return false
  }
}

/** 一组条件全部成立才算通过。空数组 = 通过 */
export function evaluateAll(conds: Condition[] | undefined, ctx: ValueContext): boolean {
  if (conds === undefined || conds.length === 0) return true
  for (const c of conds) {
    if (!evaluateCondition(c, ctx)) return false
  }
  return true
}
