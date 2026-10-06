/**
 * 世界与固定 tick。
 *
 * "固定 tick"的意思：模拟永远以 dt 秒为一步推进，一步不多一步不少。
 * 渲染帧率和模拟步长完全解耦 —— 渲染卡了，模拟该走几步还是几步。
 *
 * 这是后面一切的前提：
 *   · 重放（同一份输入 + 同一个种子 = 同一个结果）
 *   · 无头批跑（平衡模拟器就是拿它跑几万次）
 *   · 局域网同步（主机权威，客户端只做表现）
 */
import type { AiProfile, EntityDef, PipelineHook, StatusDef } from '../schema.ts'
import type { CompiledTechnique } from './compile.ts'
import type {
  Entity, EntityKind, Faction, ProjectileSpec, SimEvent, Vec2, Vec3, WeaponInstance, World,
} from './types.ts'
import type { BlockPolicy, EntityShape } from '../schema.ts'
import { resolveAttribute, getStored, setStored } from './attributes.ts'
import { tickStatuses } from './status.ts'
import {
  applyPhaseLocks, releaseAreaOccupants, tickActiveTechniques, tickAreaOverlap, tickCasts,
  tickCooldowns, tickStatusAppliedRules, tickStatusHooks,
} from './cast.ts'
import { tickModifierTriggers, sweepCarriersGone } from './trigger.ts'
import { tickAi } from './ai.ts'
import { tickProjectiles } from './projectile.ts'
import { seedRng } from './rng.ts'
import { distance, pushOutOfShape } from './geom.ts'
import { canPassThrough, isObstacle, shapeOf } from './barrier.ts'
import { factionOf, isHostile, visibilityOf } from './status.ts'

export { distance }

/** 默认 60 tick/秒 —— 动作游戏手感的标准值 */
export const DEFAULT_DT = 1 / 60

/**
 * 打击感的三个常数。它们是**模拟层**的，所以必须确定性 —— 只依赖伤害和血量。
 *
 * 顿帧按"这一下打掉了目标多少比例的血"算，不是按绝对伤害：
 * 对一只 40 血的小怪打 30 点，比对一个 2000 血的 Boss 打 30 点爽得多，
 * 那也是对的。
 */
export const MAX_HITSTOP = 0.12          // 最长停多久（秒）
export const HITSTOP_FRACTION = 0.6      // 打掉 X% 的血 → 停 X% × 0.6 秒
export const MIN_HITSTOP_DAMAGE = 12     // 低于这个不进顿帧 —— DOT 每 0.5 秒跳一次，不然会一直卡
export const MAX_KNOCKBACK = 5           // 击退速度上限（米/秒）
export const KNOCKBACK_FRACTION = 6      // 打掉 X% 的血 → X% × 6 米/秒
export const PUSH_DECAY = 0.85           // 冲量每 tick 的保留比例
/**
 * 低血线：血量百分比掉到这个值**以下的那一刻**算"过低"。
 *
 * ⚠ 它是一条**线**，不是一段区间：`onLowHp` 只在"跨过去"那一下触发
 *   （见 pipeline.ts 的 fireLowHp）。低于它就每 tick 触发一次的话，
 *   "残血时获得护盾"会变成"每次挨打都白送护盾"。
 *
 * 0.3 是个常规值：三条命里掉到第三条，玩家会开始紧张，
 * 也正是"该给点翻盘手段"的时刻。
 */
export const LOW_HP_PCT = 0.3

/** 派生属性的默认基础值。不写就用这些 */
const DEFAULT_BASE: Record<string, number> = {
  'char.hp.max': 100,
  'char.energy.max': 100,
  'char.energy.regen': 10,
  'char.speed': 5,
  /**
   * 移速倍率。减速 / 加速状态改它，1 = 正常。
   *
   * `char.speed` 是"这个人基础能跑多快"，给控制器（玩家输入 / AI）读；
   * `char.moveScale` 是"现在跑得动吗"，由状态修饰。两者分工不同：
   * 前者决定你想跑多快，后者决定实际乘多少。
   */
  'char.moveScale': 1,
  /**
   * 受到伤害的倍率。**必须是 1，不能是 0**。
   * 它是"易伤 / 减伤"这类状态的挂载点（破甲就是把它 ×1.15），
   * 默认写成 0 的话所有伤害都会被乘成 0。
   */
  'char.damageTaken': 1,
  /**
   * 暴击率和暴击倍率。
   *
   * ⚠ 默认 0 —— **不是 0.1**。
   *   在这个属性存在之前，"暴击"只活在注释里：`CRIT_TAG` 有人读、没人写，
   *   所以 `onCrit` / `onNonCrit` / `isCrit` 三个时机**永远不会成立**。
   *   要开暴击，由场景或状态给这个属性（arena.json 给玩家配了 0.15）。
   *
   *   默认给 0 有两个理由：
   *     1. 已有内容的伤害数值是按"不暴击"配平的，偷偷加上暴击会让它们全部超模
   *     2. 0 的时候引擎**不掷骰**，所以已有战斗的随机序列一格都不动（可重放不受影响）
   */
  'char.critRate': 0,
  /** 暴击倍率：暴击时伤害乘多少 */
  'char.critDamage': 2,
}

export interface SpawnInit {
  kind?: EntityKind
  defId?: string
  tags?: string[]
  faction?: Faction
  pos?: Partial<Vec3>
  vel?: Partial<Vec3>
  facing?: Vec2
  /** 派生属性的基础值 */
  base?: Record<string, number>
  /** 存储属性（当前血量、当前能量） */
  stored?: Record<string, number>
  ownerId?: number
  /** 主人死了就跟着消失。召唤物用（投射物**不**跟，箭飞出去就该继续飞） */
  diesWithOwner?: boolean
  lifetime?: number
  radius?: number
  /** 实体**天生**带的管线钩子（不需要状态就生效的被动） */
  hooks?: PipelineHook[]
  /** 当前生效的常驻术式 id */
  activeTechniques?: string[]
  /** 投射物命中后要做什么 */
  payload?: ProjectileSpec
  /** 这个实体会哪些术式（AI 从这里挑） */
  techniqueIds?: string[]
  /** AI 配置。不写就不会自己动 */
  ai?: AiProfile
  /**
   * 身上带的武器（`kind: 'actor'` = 拿着，`kind: 'item'` = 地上躺着的）。
   *
   * ⚠ 传进来的是**运行时拷贝**（`WeaponInstance`），不是内容层的 `WeaponDef` ——
   *   sim 不认识内容层。谁读的文件谁负责翻译（见 src/scenario.ts）。
   */
  weapon?: WeaponInstance
  /** **形状**（屏障用）。不写就是圆（用 `radius`）。 */
  shape?: EntityShape
  /** **谁能穿过我**（屏障用）。不写用默认策略。 */
  block?: BlockPolicy
}

export interface WorldOptions {
  dt?: number
  seed?: number
}

export function createWorld(opts: WorldOptions = {}): World {
  const world: World = {
    dt: opts.dt ?? DEFAULT_DT,
    tick: 0,
    hitstop: 0,
    rngState: 0,
    entities: [],
    nextId: 1,
    events: [],
    statusDefs: new Map(),
    techniques: new Map(),
    entityDefs: new Map(),
    casts: [],
    nextCastId: 1,
    pendingStatusApplied: [],
  }
  seedRng(world, opts.seed ?? 1)
  return world
}

/** 把一个状态定义注册进世界。规则里用 statusId 引用内置状态时靠它 */
export function registerStatusDef(world: World, def: StatusDef): void {
  world.statusDefs.set(def.id, def)
}

/** 把一个术式注册进世界。常驻技能（auto / toggle）的钩子靠它查 */
export function registerTechnique(world: World, tech: CompiledTechnique): void {
  world.techniques.set(tech.id, tech)
}

/** 把一个实体预设注册进世界。`spawn` 载荷按 entityId 查它 */
export function registerEntityDef(world: World, def: EntityDef): void {
  world.entityDefs.set(def.id, def)
}

// ---------------------------------------------------------------- 生成实体

export function spawn(world: World, init: SpawnInit = {}): Entity {
  const base = new Map<string, number>()
  for (const [k, v] of Object.entries(DEFAULT_BASE)) base.set(k, v)
  for (const [k, v] of Object.entries(init.base ?? {})) base.set(k, v)

  const stored = new Map<string, number>()
  // 默认满血满蓝
  stored.set('char.hp.current', base.get('char.hp.max') ?? 0)
  stored.set('char.energy.current', base.get('char.energy.max') ?? 0)
  /*
   * ⚠ 血契必须**在这里初始化**，不能只靠场景写。
   *
   *   `owner.stored.has(path)` 是"这个属性能不能被动作改"的判据
   *   （见 pipeline.ts 的 applyAttributeAction）。不在 stored 里的路径
   *   一改就抛异常 —— 所以"攒血契"这条规则会在运行到那一刻炸。
   *   把它和血/蓝一样默认给上，任何实体都能收血契（敌人也可以，
   *   将来要做"敌人也攒血契"就不用再动这里）。
   */
  stored.set('char.bloodPact.current', 0)
  for (const [k, v] of Object.entries(init.stored ?? {})) stored.set(k, v)

  const entity: Entity = {
    id: world.nextId++,
    kind: init.kind ?? 'actor',
    tags: [...(init.tags ?? [])],
    faction: init.faction ?? 'neutral',
    pos: { x: init.pos?.x ?? 0, y: init.pos?.y ?? 0, z: init.pos?.z ?? 0 },
    vel: { x: init.vel?.x ?? 0, y: init.vel?.y ?? 0, z: init.vel?.z ?? 0 },
    push: { x: 0, y: 0, z: 0 },
    facing: { x: init.facing?.x ?? 1, y: init.facing?.y ?? 0 },
    alive: true,
    stored,
    base,
    statuses: [],
    hooks: [...(init.hooks ?? [])],
    activeTechniques: [...(init.activeTechniques ?? [])],
    ruleTimers: new Map(),
    damagedTick: -1,
    techniqueIds: [...(init.techniqueIds ?? [])],
    aiThinkAt: 0,
    lifetime: init.lifetime ?? -1,
    radius: init.radius ?? 0.4,
    /*
     * "谁站在我里面" —— 只有 `kind: 'area'` 会在每 tick 的比较里用到它。
     * 一开始是空的，所以**区域长出来的第一 tick** 会把已经在里面的人
     * 全部算成"刚进来"（火墙放在脚下，站在里面的人当场就该被烧到）。
     */
    inside: [],
  }

  if (init.payload !== undefined) entity.payload = init.payload
  if (init.ai !== undefined) entity.ai = init.ai
  /*
   * ⚠ 武器要**拷一份** `attributes`。
   *
   *   直接把内容层那个对象挂上去的话，两把用同一个 `WeaponDef` 生成的武器
   *   会共享同一张属性表 —— 之后任何"临时改一下武器属性"的效果
   *   （强化、诅咒、铭刻）都会同时改到别人身上，而且完全静默。
   */
  if (init.weapon !== undefined) {
    entity.weapon = {
      id: init.weapon.id,
      name: init.weapon.name,
      attributes: { ...init.weapon.attributes },
    }
  }
  // 形状 / 通行策略同样是拷一份（内容层的对象不该被运行时改到）
  if (init.shape !== undefined) entity.shape = { ...init.shape }
  if (init.block !== undefined) entity.block = { ...init.block }

  if (init.defId !== undefined) entity.defId = init.defId
  if (init.ownerId !== undefined) entity.ownerId = init.ownerId
  if (init.diesWithOwner === true) entity.diesWithOwner = true
  world.entities.push(entity)
  world.events.push({ type: 'spawned', id: entity.id })
  return entity
}

export function getEntity(world: World, id: number): Entity | undefined {
  return world.entities.find(e => e.id === id)
}

export function despawn(world: World, entity: Entity, reason: 'expired' | 'died' | 'despawned' = 'despawned'): void {
  if (!entity.alive) return
  entity.alive = false
  world.events.push({ type: 'removed', id: entity.id, reason })
}

// ---------------------------------------------------------------- 查询
//
// ⚠ 纪律 1：所有目标选择都必须按【阵营】动态查询。
//   绝对不要写 if (entity.id === playerId) 这种东西。
//   为了魅惑做对这件事，召唤就几乎免费 —— 两者都是"找最近的敌对阵营"。

/*
 * ⚠ `isHostile` 的定义搬到 `status.ts` 了 —— 和 `factionOf` 放一起。
 *
 *   理由：阵营相关的判定现在有**三个**读者（目标选择、区域进出、屏障通行），
 *   而 `world.ts`（定义处）反过来要 import 屏障那份判定（挡人那一步），
 *   那会成环。搬到 `status.ts`（谁都依赖它、它不依赖任何业务）就断了。
 *
 *   对外没有变化：`src/sim/index.ts` 照样导出它（来自 status.ts）。
 */

export interface TargetQuery {
  /** 只要带这些标签的 */
  tags?: string[]
  /** 最远距离（米），不填则不限制 */
  maxDistance?: number
  /** 只找活着的 */
  aliveOnly?: boolean
  /**
   * 连隐形的也算进去。
   *
   * 默认**不**算 —— 这是"隐形"这个机制全部的玩法含义：
   * 看不见就锁定不了。想打中隐形的对手，得先 `reveal` 或者用范围技能。
   */
  ignoreVisibility?: boolean
}

/**
 * 可见性低于这个值就算"看不见"，AI 找不到。
 *
 * 和 `visibilityOf` 的 0 / 0.5 / 1 三档对得上：0 完全隐形、0.5 半透明、
 * 1 正常。0.5 那一档**仍然会被发现** —— 半透明是"难找"，不是"找不到"。
 */
export const INVISIBLE_BELOW = 0.5

/** 找一个敌对目标。AI 的目标选择全走这里 */
export function findHostile(world: World, self: Entity, query: TargetQuery = {}): Entity | undefined {
  let best: Entity | undefined
  let bestDist = Infinity

  for (const e of world.entities) {
    if (e.id === self.id) continue
    if (query.aliveOnly !== false && !e.alive) continue
    if (!isHostile(factionOf(self), factionOf(e))) continue
    if (query.tags !== undefined && !query.tags.every(t => e.tags.includes(t))) continue
    if (query.ignoreVisibility !== true && visibilityOf(e) < INVISIBLE_BELOW) continue

    const d = distance(self.pos, e.pos)
    if (query.maxDistance !== undefined && d > query.maxDistance) continue
    if (d < bestDist) {
      bestDist = d
      best = e
    }
  }

  return best
}

/** 找最近的同类。召唤物、队友都靠它 */
export function findAlly(world: World, self: Entity, query: TargetQuery = {}): Entity | undefined {
  let best: Entity | undefined
  let bestDist = Infinity

  for (const e of world.entities) {
    if (e.id === self.id) continue
    if (query.aliveOnly !== false && !e.alive) continue
    if (factionOf(e) !== factionOf(self)) continue
    if (query.tags !== undefined && !query.tags.every(t => e.tags.includes(t))) continue

    const d = distance(self.pos, e.pos)
    if (query.maxDistance !== undefined && d > query.maxDistance) continue
    if (d < bestDist) {
      bestDist = d
      best = e
    }
  }

  return best
}

/** 平面距离。实现搬到了 geom.ts（为了断开循环依赖），这里转出去方便调用 */

// ---------------------------------------------------------------- 固定 tick

/**
 * 推进一 tick。
 *
 * 顺序是**固定的**，不许改。改了会让同一份输入产生不同结果，
 * 也会让"伤害是在回复之前还是之后结算"这类问题变成玄学。
 *
 *   0. 顿帧（整个世界停一下）
 *   1. 状态时长倒计时，到期的移除
 *   2. 资源回复（能量按固定速率回）
 *   3. 上限钳制 + 钳到 0 以上
 *   4. 冷却与规则间隔倒计时
 *   5. 施法推进（付代价、跑规则、判打断）
 *   6. 常驻术式的 onTick
 *   7. AI 决策（它负责决定这一 tick 往哪走）
 *   8. 位置积分
 *   9. 投射物碰撞（**必须在移动之后**，否则子弹会穿模）
 *  10. 存在时间倒计时，到期移除
 *  11. 清理这一 tick 死掉的实体
 *  11b. 「**载体消失**」→ 挂在那个技能上的触发副本（2026-09-30 日志 55）
 *  12. tick++
 *
 * 冷却排在施法前面：这一 tick 刚转好的技能，这一 tick 就能放。
 * AI 排在移动前面：先决定往哪走，再走。
 * 投射物碰撞排在移动后面：先飞，再看撞到谁。
 * 载体消失排在清理后面：它问的是"还在不在"，得先真的不在。
 */
export function stepWorld(world: World): void {
  world.events.length = 0

  /*
   * 0. 顿帧。
   *
   * 命中那一下整个世界停住 —— 打击感里最有用的一件事。
   * 注意它**照样推进 tick**：停的是世界，不是时间。
   * 事件在这里清空了，所以顿帧期间不会有任何新事件漏出去。
   */
  if (world.hitstop > 0) {
    world.hitstop -= world.dt
    // 钳到 0：不钳的话会停在 -0.013 这种数上，
    // 快照里就多了一个"永远为负的剩余量"，读起来莫名其妙
    if (world.hitstop < 0) world.hitstop = 0
    world.tick++
    return
  }

  // 1. 状态倒计时
  for (const e of world.entities) {
    if (e.alive) tickStatuses(world, e, world.dt)
  }

  // 2. 资源回复
  regenerate(world)

  // 3. 上限钳制
  clampToMax(world)

  // 4. 冷却
  tickCooldowns(world)

  // 5. 施法
  tickCasts(world)

  // 6. 常驻术式的 onTick（持续代价靠它）
  tickActiveTechniques(world)

  /*
   * 6a. **常驻术式里那些触发副本的 `onTick`**（日志 48）。
   *
   * ⚠ 它必须在 `tickActiveTechniques` **之后**：`onTick` 那条规则可能刚刚
   *   改过血量 / 能量，而"每 tick 看一次"的条件应该看到**这一 tick 的结果**。
   *   反过来（放在前面）的后果是条件永远慢一帧 —— 触发在血量已经改回来
   *   之后才发生，或者干脆不发生（跨线那一瞬间只有一帧）。
   *
   * ⚠ 它跑的是**触发副本**，不是规则 —— 两件事住在一个时机上，但一个是
   *   "这个技能每 tick 做什么"，一个是"每 tick 看一眼、成立就把后面那个技能放出去"。
   */
  tickModifierTriggers(world, 'onTick')

  // 6b. 状态上的 onTick 钩子（持续伤害靠它）
  tickStatusHooks(world)

  // 6c. 这一 tick 新挂上的状态 → 跑 onStatusApplied 规则（血契的一条来源）
  tickStatusAppliedRules(world)

  // 7. AI 决策
  tickAi(world)

  /*
   * 7b. 阶段锁（`Phase.locks`）。
   *
   * ⚠ 必须夹在 AI 和位置积分**中间**：
   *   放在 AI 之前，AI 紧接着就把朝向和速度又写回去了 ——
   *   "无法转向的激光"照样会转。
   *   放在积分之后，这一 tick 已经动过了。
   */
  applyPhaseLocks(world)

  // 8. 位置积分
  integrate(world)

  /*
   * 8a. **屏障挡人**。
   *
   * ⚠ 位置积分之后：先让人按速度走，再把"走进去的那部分"推出来。
   *   放在之前的话，这一 tick 的速度又会把人送进墙里（墙看起来是漏的）。
   *
   * ⚠ 它和"挡子弹"用的是**同一份通行判定**（`barrier.ts`）——
   *   两处各写一遍的话会出现"子弹被挡、人却穿过去"，而两边测试都通过。
   */
  resolveBarriers(world)

  /*
   * 8b. 区域重叠 → onEnter / onLeave。
   *
   * ⚠ 必须在位置积分**之后**：放在之前用的是上一帧的坐标，
   *   跑得快的人会「穿过去」而不触发进出。
   */
  tickAreaOverlap(world)

  // 9. 投射物碰撞
  tickProjectiles(world)

  // 10. 存在时间
  tickLifetime(world)

  /*
   * 10b. 区域散掉之前把里面的人放出去。
   *
   * ⚠ 必须在**清理之前**：区域实体这时候还在数组里（只是 alive=false），
   *   它的规则还跑得起来。放到 11 之后就查不到它了，
   *   而后果是"被减速的人永久减速"—— 状态挂在人身上，场地散不散和它无关。
   */
  releaseAreaOccupants(world)

  // 11. 清理
  world.entities = world.entities.filter(e => e.alive)

  /*
   * 11b. **载体消失** → 「载体消失」那一档触发副本（2026-09-30 日志 55）。
   *
   * ⚠ 必须在**清理之后**：这一档问的是"这次施法放出去的东西**还在不在**"
   *   （`alive` 判定），而清理之前那些死掉的实体还在数组里 —— 那时候问
   *   会得到"还在"，于是**永远不触发**（而且是静默的：没有任何事件）。
   *
   * ⚠ 必须在 `world.tick++` **之前**：触发出来的技能靠 `activate` 建施法，
   *   而那件事和玩家按技能走的是同一条路 —— 它读到的是**这一 tick** 的世界。
   *
   * ⚠ 顺序上它和 10b（`releaseAreaOccupants`）是一对：10b 保证"区域散掉
   *   之前把里面的人放出去"，11b 才说"那个区域现在算没了" —— 反过来写的话，
   *   区域内的人还在受影响，引信就已经烧到下一段了。
   */
  sweepCarriersGone(world)

  world.tick++
}

/**
 * 屏障挡人：把**走进墙里**的单位推出去。
 *
 * ⚠ 只在 `kind: 'obstacle'` 上生效，而且只挡**策略说该挡的**那些人
 *   （`block.ownUnits` / `block.enemyUnits`）—— 默认谁都不挡。
 *
 * ⚠ 推动而不是"取消这一步的移动"：
 *   取消要记住"这一 tick 从哪儿来"，而击退/位移/冲量都会改位置，
 *   来源变得说不清。推出去是**幂等**的：推到不重叠为止，谁改的位置都一样。
 *
 * ⚠ 顺序固定（实体数组的顺序），推出方向也是确定的（见 `pushOutOfShape`）——
 *   否则同一场战斗重放两次位置会不一样。
 */
export function resolveBarriers(world: World): void {
  const walls = world.entities.filter(e => isObstacle(e))
  if (walls.length === 0) return

  for (const e of world.entities) {
    if (!e.alive || (e.kind !== 'actor')) continue
    for (const wall of walls) {
      if (wall.id === e.id) continue
      if (canPassThrough(world, wall, e, 'unit')) continue
      const moved = pushOutOfShape(shapeOf(wall), wall.pos, wall.facing, e.pos, e.radius)
      if (moved === undefined) continue
      e.pos.x = moved.x
      e.pos.y = moved.y
    }
  }
}

/**
 * 资源回复。
 *
 * 固定速率 —— 这是前面定下的：能量不因为"你什么时候花的"而改变回复速度。
 * 正因为如此，"早付能量"是纯风险，应该给点数；
 * 而"早进 CD"自带收益（技能时长被算进冷却），不该给点数。两者必须分开定价。
 *
 * ⚠ 血契**不在**这里回复。它只从"进入危机的行为"来（残血、被挂负面状态、
 *   抵押属性上限），不随时间长。这是它和能量的本质区别：能量是节奏，
 *   血契是**这一局攒出来的资本**。所以它一个 regen 都不该有。
 */
function regenerate(world: World): void {
  for (const e of world.entities) {
    if (!e.alive) continue

    const regen = resolveAttribute(e, 'char.energy.regen')
    if (regen <= 0) continue

    const max = resolveAttribute(e, 'char.energy.max')
    const cur = getStored(e, 'char.energy.current')
    if (cur >= max) continue

    setStored(e, 'char.energy.current', Math.min(max, cur + regen * world.dt))
  }
}

/**
 * 把这一 tick 新挂上的状态变成 `onStatusApplied` 规则。
 *
 * 实现在 `cast.ts`（那里已经 import 了 `runTechniqueRules`）。
 * ⚠ 不能写在这个文件里：`world.ts → pipeline.ts → world.ts` 是循环依赖
 *   （pipeline 要 `spawn`），ESM 下会变成难查的 TDZ 报错。
 */

/** 上限被状态压下来时，当前值要跟着降；存储属性也不许变成负数 */
function clampToMax(world: World): void {
  for (const e of world.entities) {
    if (!e.alive) continue

    const maxHp = resolveAttribute(e, 'char.hp.max')
    const hp = getStored(e, 'char.hp.current')
    const clampedHp = Math.max(0, maxHp > 0 ? Math.min(hp, maxHp) : hp)
    if (clampedHp !== hp) setStored(e, 'char.hp.current', clampedHp)

    const maxEnergy = resolveAttribute(e, 'char.energy.max')
    const en = getStored(e, 'char.energy.current')
    const clampedEn = Math.max(0, maxEnergy > 0 ? Math.min(en, maxEnergy) : en)
    if (clampedEn !== en) setStored(e, 'char.energy.current', clampedEn)
  }
}

function integrate(world: World): void {
  const dt = world.dt
  for (const e of world.entities) {
    if (!e.alive) continue

    /*
     * 移速倍率。
     *
     * `vel` 是**实际速度**（投射物、击退、冲刺都直接改它），
     * `char.moveScale` 是"这个东西现在跑得动吗" —— 减速/加速状态改它。
     *
     * ⚠ 所有实体都吃这个倍率，**包括投射物**。
     *   我一开始只给 actor 加，理由是"子弹不该因为发射者被减速而变慢"——
     *   但减速是挂在子弹**自己**身上的，跟发射者无关。
     *   而且「无下限：靠近的东西自动减速」本来就该管子弹，那是它的全部意义。
     *   实测踩到过。
     */
    const scale = resolveAttribute(e, 'char.moveScale', { world, self: e })

    // 冲量单独加：它不受移速倍率影响（击退是动量，不是"想跑多快"）
    const px = e.push.x
    const py = e.push.y
    const pz = e.push.z

    e.pos.x += (e.vel.x * scale + px) * dt
    e.pos.y += (e.vel.y * scale + py) * dt
    // z 只影响渲染，但它也要积分，否则击飞看不出弧线
    e.pos.z += (e.vel.z + pz) * dt

    // 冲量衰减。0.85 是每 tick 的保留比例，手感上大概是"推一下滑半米"
    if (px !== 0 || py !== 0 || pz !== 0) {
      e.push.x = px * PUSH_DECAY
      e.push.y = py * PUSH_DECAY
      e.push.z = pz * PUSH_DECAY
      if (Math.abs(e.push.x) < 0.01) e.push.x = 0
      if (Math.abs(e.push.y) < 0.01) e.push.y = 0
      if (Math.abs(e.push.z) < 0.01) e.push.z = 0
    }
  }
}

function tickLifetime(world: World): void {
  for (const e of world.entities) {
    if (!e.alive) continue

    /*
     * 主人死了就跟着走（`lifetime: 'untilCasterDies'`）。
     *
     * ⚠ 放在 `lifetime < 0` 那个 continue **之前** —— 这类召唤物的
     *   lifetime 正是 -1（它不按时间到期），先 continue 就永远轮不到它。
     *   第一版就是写反了，表现是"主人死了骷髅还在打"。
     */
    if (e.diesWithOwner === true && e.ownerId !== undefined) {
      const owner = world.entities.find(x => x.id === e.ownerId)
      if (owner === undefined || !owner.alive) {
        e.alive = false
        world.events.push({ type: 'removed', id: e.id, reason: 'expired' })
        continue
      }
    }

    if (e.lifetime < 0) continue

    e.lifetime -= world.dt
    if (e.lifetime <= 0) {
      e.alive = false
      world.events.push({ type: 'removed', id: e.id, reason: 'expired' })
    }
  }
}

/** 连跑 n tick 的方便写法 */
export function advance(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) stepWorld(world)
}

// ---------------------------------------------------------------- 快照

export interface EntitySnapshot {
  id: number
  kind: EntityKind
  faction: Faction
  alive: boolean
  pos: Vec3
  vel: Vec3
  stored: [string, number][]
  statuses: { defId: string; stacks: number; remaining: number }[]
  /**
   * 身上的武器 id + 属性。
   *
   * ⚠ 它在快照里，是因为**武器是模拟状态的一部分**：
   *   技能里的 `ref: 'weapon.damage'` 会读出不同的数 ——
   *   两局"除了谁捡了哪把剑以外完全一样"的战斗必须能被打成不同的快照，
   *   同一局重放两次必须一模一样。
   */
  weapon?: { id: string; attributes: [string, number][] }
  /**
   * 序列链的状态（走到第几段了）。
   *
   * ⚠ 它在快照里，是因为它**决定下一刀是哪一招** ——
   *   同一份输入在同一个 tick 按下，必须走出同一段。
   *   这是重放和将来局域网同步的前提。
   */
  chain?: { techniqueId: string; next: number }
}

export interface Snapshot {
  tick: number
  rngState: number
  entities: EntitySnapshot[]
}

/**
 * 把世界导出成纯数据。
 *
 * 用途有三个：确定性测试（两次跑到同一 tick，快照必须一模一样）、
 * 回放、以及将来局域网对战的快照同步。
 */
export function snapshot(world: World): Snapshot {
  return {
    tick: world.tick,
    rngState: world.rngState,
    entities: world.entities.map(e => ({
      id: e.id,
      kind: e.kind,
      faction: factionOf(e),
      alive: e.alive,
      pos: { x: e.pos.x, y: e.pos.y, z: e.pos.z },
      vel: { x: e.vel.x, y: e.vel.y, z: e.vel.z },
      stored: [...e.stored.entries()],
      statuses: e.statuses.map(s => ({
        defId: s.defId,
        stacks: s.stacks,
        remaining: s.remaining,
      })),
      ...(e.weapon !== undefined
        ? { weapon: { id: e.weapon.id, attributes: Object.entries(e.weapon.attributes) } }
        : {}),
      ...(e.chain !== undefined
        ? { chain: { techniqueId: e.chain.techniqueId, next: e.chain.next } }
        : {}),
    })),
  }
}

export type { SimEvent }
