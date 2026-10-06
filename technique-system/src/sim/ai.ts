/**
 * 敌人 AI。
 *
 * ⚠ 纪律 1 在这里兑现：目标选择**一律按阵营动态查询**，
 *   绝不写 `if (entity.id === playerId)`。
 *
 *   为了「魅惑」做对这件事，白送了召唤 —— 两者都是"找最近的敌对阵营"。
 *   反过来，如果这里硬编码"追玩家"，魅惑就得重写所有 AI。
 *
 * 现在的 AI 有四条规则，够用就好：
 *   1. 找最近的敌人（没有就站着）
 *   2. 按 preferredRange 保持距离
 *   3. 间隔 thinkInterval 试一次技能，够得着就放
 *   4. **队友遭殃了先救队友**（见 `pickRescue`）
 *
 * 它是**确定性**的：不用随机，所以同一份场景跑一百次结果完全一样。
 * 以后要加随机决策，必须用 `nextFloat(world)`，不能用全局随机。
 */
import type { World, Entity } from './types.ts'
import type { CompiledTechnique } from './compile.ts'
import { distance, normalize2 } from './geom.ts'
import { resolveAttribute } from './attributes.ts'
import { canActivate, peekSequence, pressSequence, releaseCharge } from './cast.ts'
import { findAlly, findHostile } from './world.ts'
import { canAct } from './status.ts'
import { matchesValid } from './targeting.ts'
import type { AimIntent } from './targeting.ts'

const DEFAULT_THINK = 0.25
const DEFAULT_RANGE = 2

export function tickAi(world: World): void {
  for (const e of world.entities) {
    if (!e.alive || e.ai === undefined || e.kind !== 'actor') continue

    // ---- 蓄力技：蓄够了就松手 ----
    // 蓄力阶段（duration = -1）永远不会自己结束。AI 不松手的话，
    // 它会永远举着那把剑 —— 蓄力技在 AI 手里等于不存在。
    const own = world.casts.find(c => c.casterId === e.id)
    if (own !== undefined) {
      const ph = own.technique.phases[own.phaseIndex]
      if (ph !== undefined && ph.duration < 0 && own.charge >= (e.ai.chargeTime ?? 1.5)) {
        releaseCharge(world, own.id)
      }
    }

    const target = findHostile(world, e, e.ai.targetTags !== undefined ? { tags: e.ai.targetTags } : {})
    if (target === undefined) {
      e.vel.x = 0
      e.vel.y = 0
      continue
    }

    const dir = normalize2({ x: target.pos.x - e.pos.x, y: target.pos.y - e.pos.y })
    e.facing = dir

    // ---- 走位：按想保持的距离靠近 / 拉开 ----
    const dist = distance(e.pos, target.pos)
    const want = e.ai.preferredRange ?? DEFAULT_RANGE
    const speed = resolveAttribute(e, 'char.speed', { world, self: e })
    const canMove = canAct(e, 'move')

    // 施法者被占用时不挪窝（引导技要站桩）
    const busy = world.casts.some(c => c.casterId === e.id
      && c.technique.phases[c.phaseIndex]?.occupiesCaster === true)

    if (!canMove || busy) {
      e.vel.x = 0
      e.vel.y = 0
    } else if (dist > want + 0.4) {
      e.vel.x = dir.x * speed
      e.vel.y = dir.y * speed
    } else if (dist < want - 0.4) {
      e.vel.x = -dir.x * speed
      e.vel.y = -dir.y * speed
    } else {
      e.vel.x = 0
      e.vel.y = 0
    }

    // ---- 决策：队友有难先救队友，否则够得着就打 ----
    e.aiThinkAt -= world.dt
    if (e.aiThinkAt > 0) continue
    e.aiThinkAt = e.ai.thinkInterval ?? DEFAULT_THINK

    if (!canAct(e, 'cast')) continue

    /*
     * ⚠ **先救队友，再考虑打人。**
     *
     *   在它之前，引擎里有个 `findAlly()` 却**一次都没被调用过** ——
     *   于是"会治疗同伴的敌人"这类设计根本做不出来：不是技能写不出来，
     *   是**没有人会去放它**。玩家点名要的"特定敌人才能治愈同伴"卡在这儿。
     *
     *   顺序是有意的：治疗排在被攻击前面。一个会奶人的敌人应该先救人，
     *   否则它永远在"打人"和"救人"之间二选一，而它总是选打人。
     *   这个顺序也让行为**可预测**（确定性 AI 的前提）。
     */
    const rescue = pickRescue(world, e)
    if (rescue !== undefined) {
      /*
       * 对着队友放 —— 具体的落点/朝向由引擎按 targeting.mode 解析。
       * ⚠ 也用 `pressSequence`：救人的术式同样可能挂序列（"先解控再回血"这种两段）。
       */
      pressSequence(world, e, rescue.tech, { intent: { kind: 'entity', id: rescue.ally.id } })
      continue
    }

    const tech = pickTechnique(world, e, target, dist)
    if (tech === undefined) continue

    /*
     * ⚠ 按 `targeting.mode` 给**原始意图**，让引擎去解析（`resolveAim`）。
     *   （那份 `targeting` 是**编译产物**里的一份 —— 2026-09-21 日志 47 之后
     *    它来自**技能**，编译时由 `compile.ts` 的 `targetingOfChain` 取来。）
     *
     *   `areapoint`（点地面）的 AI 把落点放在目标脚下 ——
     *   这就是"AI 会放地面技能"，不需要另写一套。
     *   别的模式给锁定目标 + 朝向就够，引擎自己决定要不要把朝向掰过去
     *   （locked / auto 会，directional 不会）。
     *
     * 为什么不让 AI 先算好结果再传：那样子模式逻辑又跑到引擎外面去了，
     * 玩家一套、AI 一套 —— 而"两套逻辑"正是 mode 变成死字段的原因。
     *
     * ⚠ 落点那份**必须把方向也带上**（`dir`，2026-09-21 日志 47）：
     *   一次输入只有一个意图，而"方向"和"落点"是**同一份意图的两半**。
     *   `areapoint` 自己用落点；万一这份瞄准被改成别的模式（或者一段里换了技能），
     *   没有 `dir` 就会退回"施法者当前朝向"，而不是"朝着目标"——
     *   那是行为差，而且看不见（AI 的朝向每 tick 都在被改成朝着目标，
     *   所以绝大多数时候两者恰好一样，只在目标刚换人的那一 tick 露出来）。
     */
    const intent: AimIntent = tech.targeting.mode === 'areapoint'
      ? { kind: 'point', x: target.pos.x, y: target.pos.y, dir }
      : { kind: 'entity', id: target.id }

    /*
     * ⚠ AI 也走 `pressSequence`，不是 `activate`。
     *
     *   玩家 2026-09-21 把序列层推广到了**所有术式**（二段技能靠它）。
     *   AI 若还用 `activate`，那么一门挂了序列的术式在它手里
     *   只会放"容器"（容器自己没有阶段 = 什么都不发生）——
     *   表现是"敌人学了二段技能，但永远不出招"。
     */
    pressSequence(world, e, tech, { intent, facing: dir })
  }
}

/**
 * 从会用的术式里挑一个能放的。
 *
 * 顺序就是 techniqueIds 的顺序 —— 玩家（或关卡设计者）把重要的排前面。
 * 不随机，所以行为可预测、可重放。
 *
 * ⚠ **必须检查"这个术式对目标有效吗"。**
 *
 *   在补这一句之前，`pickTechnique` 只看射程和能不能放 ——
 *   于是"会治疗的敌人"会拿**治疗术**去打人：
 *   它以为自己在攻击，而引擎的瞄准解析（`resolveAim` 的 `locked` 模式）
 *   发现"敌人不是这个术式的合法目标"，就**顺手挑了个最近的合法目标** ——
 *   也就是它自己的队友，然后给队友奶了一口。
 *
 *   症状是"敌人莫名其妙在治疗队友，而且它明明想打人"。
 *   判据用 `matchesValid`（引擎里唯一那份"谁能被这个术式作用"的实现），
 *   所以 `valid: ['undead']` 这种按标签筛的写法也照样管用。
 */
function pickTechnique(
  world: World,
  e: Entity,
  target: Entity,
  dist: number,
): CompiledTechnique | undefined {
  for (const id of e.techniqueIds) {
    const tech = world.techniques.get(id)
    if (tech === undefined) continue

    if (!matchesValid(e, target, tech.targeting.valid)) continue

    const range = tech.targeting.range
    if (range !== undefined && dist > range) continue

    /*
     * ⚠ 能不能放要问 `peekSequence`（序列术式问的是**下一段**）。
     *   问容器自己的话，二段技能的冷却永远看不见 ——
     *   AI 会对着冷却中的技能一直按。
     */
    if (peekSequence(world, e, tech).reason !== undefined) continue
    return tech
  }
  return undefined
}

/**
 * 挑一个"该救的队友 + 用哪个术式救"。
 *
 * ⚠ 两个判据都是**内容驱动**的，没有一条是这个函数硬编码的：
 *
 *   1. **什么样的队友算"有难"**：身上挂着带 `debuff` / `curse` 标签的状态。
 *      标签是内容写的，所以以后加"中毒""诅咒""虚弱"都不用改这里。
 *   2. **哪个术式算"救人的"**：`targeting.valid` 里有 `ally`。
 *      术式自己声明"我对谁有效"，AI 照着认 —— 不是靠术式 id 或者名字猜。
 *
 * ⚠ 顺序：先找最近的队友，再按 `techniqueIds` 顺序挑术式。
 *   两边都不随机，所以行为可重放（确定性 AI 的底线）。
 */
function pickRescue(world: World, e: Entity): { tech: CompiledTechnique, ally: Entity } | undefined {
  const techs: CompiledTechnique[] = []
  for (const id of e.techniqueIds) {
    const tech = world.techniques.get(id)
    if (tech === undefined) continue
    if (!tech.targeting.valid.includes('ally')) continue
    if (canActivate(world, e, tech) !== undefined) continue
    techs.push(tech)
  }
  if (techs.length === 0) return undefined

  /*
   * ⚠ 治疗射程用**术式自己的 range**，不另设一个 AI 参数。
   *   多一个参数就是多一处会和内容漂移的东西 ——
   *   作者把射程调长了，AI 却还在老位置才奶，那是查不出来的 bug。
   */
  const maxRange = Math.max(...techs.map(t => t.targeting.range ?? Infinity))
  const ally = findAlly(world, e, Number.isFinite(maxRange) ? { maxDistance: maxRange } : {})
  if (ally === undefined) return undefined
  if (!ally.statuses.some(s => s.tags.includes('debuff') || s.tags.includes('curse'))) {
    return undefined
  }

  // 射程够得着的第一个（按 techniqueIds 的顺序）
  for (const tech of techs) {
    const range = tech.targeting.range
    if (range !== undefined && distance(e.pos, ally.pos) > range) continue
    return { tech, ally }
  }
  return undefined
}
