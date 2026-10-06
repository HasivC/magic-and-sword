/**
 * 状态容器。
 *
 * 这一个文件装下了前面讨论里的一大半"经典效果"：
 *   冻结 / 沉默 / 缴械 / 定身  = disables 的不同组合
 *   霸体                    = immuneTags
 *   隐身                    = visibility
 *   神锋无影的创伤           = removal.onlyBy
 * 它们全都不是独立机制，只是状态的四种装法。
 */
import type { Capability, StatusDef } from '../schema.ts'
import type { ActiveStatus, Entity, Faction, World } from './types.ts'
import { makeActiveStatus } from './types.ts'

export type CapabilityMap = Record<Capability, boolean>

const ALL_CAPABILITIES: readonly Capability[] = ['move', 'attack', 'cast', 'turn']

// ---------------------------------------------------------------- 查询

/** 合并所有状态的能力禁用。取并集 —— 所以"冻结 + 沉默"不需要特例 */
export function capabilities(entity: Entity): CapabilityMap {
  const caps: CapabilityMap = { move: true, attack: true, cast: true, turn: true }
  for (const s of entity.statuses) {
    for (const c of s.disables) caps[c] = false
  }
  return caps
}

/** 能不能做某件事。控制效果检查全走这里 */
export function canAct(entity: Entity, capability: Capability): boolean {
  return capabilities(entity)[capability]
}

/** 可见性。取最低值 —— 只要有一个状态让你隐形，你就是隐形的 */
export function visibilityOf(entity: Entity): number {
  let v = 1
  for (const s of entity.statuses) {
    if (s.visibility !== undefined && s.visibility < v) v = s.visibility
  }
  return v
}

/**
 * 这个实体**现在算哪一边**。
 *
 * ⚠ **这是纪律 1（一切按阵营动态查询）的最后一块拼图。**
 *
 *   `entity.faction` 是"出厂设定"，只能在 spawn 时定；
 *   而魅惑、精神控制、叛变这一类效果要的是"**现在**算哪一边"。
 *   schema 里那句注释（"魅惑就是改这个字段"）写了很久，
 *   却一直没有一条路能改它 —— 于是那个设计做不出来。
 *
 * 规则：**最后挂上的那个带阵营的状态说了算。**
 *   为什么是"最后"而不是"第一个"：被策反过一次又被策反回来，
 *   后者才是当前状态。而且它依赖的是状态数组的顺序，**确定**，
 *   不碰任何集合遍历顺序（可重放是底线）。
 *
 * ⚠ 所有需要知道阵营的地方都该走它，**不要直接读 `entity.faction`** ——
 *   直接读的表现是"被魅惑的敌人还在打你，只是颜色变了"。
 */
export function factionOf(entity: Entity): Faction {
  for (let i = entity.statuses.length - 1; i >= 0; i--) {
    const f = entity.statuses[i]?.faction
    if (f !== undefined) return f
  }
  return entity.faction
}

/**
 * 两个阵营是否敌对。魅惑改了阵营之后，这里自动跟着变。
 *
 * ⚠ 它**原来在 `world.ts`**，搬到这儿是为了断环：
 *   阵营的读者现在有三个（目标选择、区域进出、**屏障通行**），
 *   而 `world.ts` 那一步"把撞上墙的人推出去"要 import 屏障的判定，
 *   屏障又要用 `isHostile` —— 定义在 world 里就成环了。
 *   放这里谁都依赖它，而它不依赖任何业务。
 *
 * ⚠ `neutral` 对谁都**不**敌对 —— 这是中立方（地上的剑、友方木桩）的语义。
 */
export function isHostile(a: Faction, b: Faction): boolean {
  if (a === 'neutral' || b === 'neutral') return false
  return a !== b
}

export function hasStatus(entity: Entity, statusId: string): boolean {
  return entity.statuses.some(s => s.defId === statusId)
}

/** 某个状态叠了多少层 */
export function statusStacks(entity: Entity, statusId: string): number {
  let n = 0
  for (const s of entity.statuses) {
    if (s.defId === statusId) n += s.stacks
  }
  return n
}

/** 实体自身带某个标签（undead / boss / construct……） */
export function hasTag(entity: Entity, tag: string): boolean {
  return entity.tags.includes(tag)
}

/** 身上有没有任何状态带某个标签 */
export function hasStatusTag(entity: Entity, tag: string): boolean {
  return entity.statuses.some(s => s.tags.includes(tag))
}

// ---------------------------------------------------------------- 免疫

/**
 * 霸体。目标身上有任何状态"免疫某个标签"，新状态带这个标签就挂不上去。
 * 八行代码实现了 MOBA 里一整套"霸体/免控"。
 */
export function findImmunity(target: Entity, def: StatusDef): ActiveStatus | undefined {
  for (const s of target.statuses) {
    if (s.immuneTags.length === 0) continue
    for (const tag of def.tags) {
      if (s.immuneTags.includes(tag)) return s
    }
  }
  return undefined
}

// ---------------------------------------------------------------- 施加

/**
 * 挂一个状态。
 *
 * 叠层行为由 StatusDef.stack.behavior 决定：
 *   refresh     —— 刷新时长，层数不变（默认）
 *   stack       —— 层数 +1，时长刷新，上限 stack.max
 *   independent —— 再挂一份独立的
 */
export function applyStatus(
  world: World,
  target: Entity,
  def: StatusDef,
  sourceId: number,
  stacks = 1,
): boolean {
  if (!target.alive) return false

  const immunity = findImmunity(target, def)
  if (immunity !== undefined) {
    world.events.push({
      type: 'statusImmune',
      entityId: target.id,
      statusId: def.id,
      byStatus: immunity.defId,
    })
    return false
  }

  const behavior = def.stack?.behavior ?? 'refresh'
  const max = def.stack?.max ?? 1

  if (behavior !== 'independent') {
    const existing = target.statuses.find(s => s.defId === def.id)
    if (existing !== undefined) {
      if (behavior === 'stack') {
        existing.stacks = Math.min(existing.stacks + stacks, max)
      }
      existing.remaining = def.duration
      world.events.push({
        type: 'statusApplied',
        entityId: target.id,
        statusId: def.id,
        stacks: existing.stacks,
      })
      return true
    }
  }

  const active = makeActiveStatus(def, sourceId, Math.min(stacks, max))

  /*
   * ⚠ 阵营在**施加的那一刻**就解析成具体值 —— 魅惑就靠这一句。
   *
   *   `'caster'` 是"跟施法者同一阵营"，和 `EntityDef.faction` 用的是同一个词。
   *   在这里解析而不是留到查询时，是为了让 `factionOf()` 保持**纯函数**：
   *   它被 `matchesValid` 这类热点函数调用，不该拿着 world 满地图去查来源。
   */
  if (def.faction !== undefined) {
    const src = world.entities.find(e => e.id === sourceId)
    active.faction = def.faction === 'caster'
      ? (src === undefined ? 'neutral' : factionOf(src))
      : def.faction
  }

  target.statuses.push(active)
  world.events.push({
    type: 'statusApplied',
    entityId: target.id,
    statusId: def.id,
    stacks: active.stacks,
  })
  /*
   * ⚠ 只有**第一次挂上**才入队。
   *
   *   刷新时长和叠层（上面那个分支）不入队 —— 否则一个"每秒重挂一次"的
   *   debuff 会变成血契刷子。而"进入危机"该是一件有次数的事。
   *
   *   `status.ts` 只记一个 id，**不认识规则**：反过来的话
   *   `pipeline → status → pipeline` 就是循环依赖。
   */
  world.pendingStatusApplied.push(target.id)
  return true
}

// ---------------------------------------------------------------- 移除

export interface RemovalRequest {
  /** 这次移除属于哪一类：dispel / heal / expire / death…… */
  tag?: string
  /** 发起者的技能或状态 id。onlyBy 白名单匹配它 */
  sourceId?: string
}

/**
 * 这个状态允许被这次请求移除吗。
 *
 * 规则：
 *   写了 onlyBy  → 只有名单里的来源能移除，别的统统不行（神锋无影的创伤）
 *   写了 immuneTo → 带这些标签的移除请求无效
 *   都没写       → 随便移除
 */
export function canRemove(status: ActiveStatus, req: RemovalRequest): boolean {
  const onlyBy = status.removal?.onlyBy
  if (onlyBy !== undefined && onlyBy.length > 0) {
    return req.sourceId !== undefined && onlyBy.includes(req.sourceId)
  }
  const immuneTo = status.removal?.immuneTo
  if (immuneTo !== undefined && req.tag !== undefined) {
    return !immuneTo.includes(req.tag)
  }
  return true
}

/**
 * 移除一个状态的全部层。
 * 返回真正移除了几个。
 */
export function removeStatus(
  world: World,
  target: Entity,
  statusId: string,
  req: RemovalRequest = {},
): number {
  let removed = 0
  const kept: ActiveStatus[] = []

  for (const s of target.statuses) {
    if (s.defId === statusId && canRemove(s, req)) {
      removed++
      world.events.push({ type: 'statusExpired', entityId: target.id, statusId: s.defId })
    } else {
      kept.push(s)
    }
  }

  if (removed > 0) target.statuses = kept
  return removed
}

/**
 * 精确移除**某一个实例**，绕过 removal 规则。
 *
 * 护盾被打空时用它 —— 那不是"被驱散"，是自然耗尽，
 * 不该被 onlyBy / immuneTo 这类规则拦住。
 */
export function removeStatusInstance(world: World, target: Entity, status: ActiveStatus): boolean {
  const idx = target.statuses.indexOf(status)
  if (idx < 0) return false
  target.statuses.splice(idx, 1)
  world.events.push({ type: 'statusExpired', entityId: target.id, statusId: status.defId })
  return true
}

// ---------------------------------------------------------------- 推进

/** 状态时长倒计时，到期的移除。每 tick 调一次 */
export function tickStatuses(world: World, entity: Entity, dt: number): void {
  if (entity.statuses.length === 0) return

  const kept: ActiveStatus[] = []
  for (const s of entity.statuses) {
    if (s.remaining < 0) {
      // -1 = 永久，不倒计时
      kept.push(s)
      continue
    }
    s.remaining -= dt
    if (s.remaining > 0) {
      kept.push(s)
    } else {
      world.events.push({ type: 'statusExpired', entityId: entity.id, statusId: s.defId })
    }
  }

  if (kept.length !== entity.statuses.length) entity.statuses = kept
}
