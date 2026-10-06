/**
 * 捡东西 / 换武器。
 *
 * ## 为什么"换武器"要从这一层开始
 *
 * 玩家 2026-09-21 给的前提：
 *   > 换武器的前提是武器有建模，能作为实体被交互。
 *
 * 所以武器在引擎里不是一个"角色身上的数字"，而是一个**实体**：
 * 站在地上、看得见、走过去捡得起来。这条决定了三件事：
 *
 *   1. 武器要能在世界里**存在**（`kind: 'item'` + `Entity.weapon`）
 *   2. 捡起来是一个**引擎动作**（这个文件），不是界面上的换装菜单
 *   3. 换下来的那把**掉在原地** —— 换来换去是可逆的，而且地上会留东西
 *
 * ## 为什么放在 sim 里，而不是客户端里
 *
 * ⚠ "谁手上有哪把武器"是**模拟状态**：它决定伤害（`ref: 'weapon.damage'`）、
 *   决定攻速、决定左键走哪几段序列。放在客户端的话：
 *   · 重放/回放对不上（快照里的 weapon 是另一回事）
 *   · AI 永远不会捡武器（它没有客户端）
 *   · 将来局域网同步要多传一份"玩家手上的武器"
 *
 * 纪律 4 也要求这一层只有纯逻辑：没有文件、没有 DOM、没有随机。
 */
import type { Entity, WeaponInstance, World } from './types.ts'
import { despawn, spawn } from './world.ts'

/**
 * 能捡起东西的距离（米）。
 *
 * ⚠ 它是**一个**常量，因为有两个地方必须一致：
 *   · `pickupNearby` 判"够不够得着"
 *   · 客户端画"按 F 拾取长剑"那句提示
 *   各写一份的话，提示会出现在捡不到的位置上 —— 玩家按了没反应，
 *   而且他不会怀疑是提示的错。
 */
export const PICKUP_RANGE = 1.5

/** 手上有什么武器（没拿就是 undefined） */
export function weaponOf(entity: Entity): WeaponInstance | undefined {
  return entity.weapon
}

/**
 * 武器参数：`weapon.*` 那几条。
 *
 * ⚠ 没武器（或者武器没写那一条）时返回 `undefined`，
 *   由调用方决定退到什么 —— `resolveValue` 退到全局缺省值
 *   （见 sim/attributes.ts 的 readRef）。这里不返回 0：
 *   "没有这把武器"和"这把武器的射程是 0 米"是两件完全不同的事。
 */
export function weaponAttribute(entity: Entity, key: string): number | undefined {
  const w = entity.weapon
  if (w === undefined) return undefined
  const v = w.attributes[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export type EquipFailReason =
  | 'dead'        // 死人捡不了东西
  | 'notItem'     // 那个实体不是地上的东西（拿人当东西捡是内容写错了）
  | 'noWeapon'    // 那件东西身上没有武器
  | 'tooFar'      // 够不着

export interface EquipResult {
  ok: boolean
  reason?: EquipFailReason
  /** 换上的是哪把 */
  equipped?: { id: string; name: string }
  /** 换下来的那把（掉在原地了）。空手换新武器时没有 */
  dropped?: { id: string; name: string }
}

/**
 * 把地上那件东西捡起来（**明确的**目标，不自己找）。
 *
 * 顺序是刻意的：
 *   1. 先把手上的武器**放到地上**（如果手上有）
 *   2. 再把地上的东西**拿起来**
 *   3. 最后把那件 item 实体清掉
 *
 * ⚠ 先放手再拿：反过来写的话，"手上那把掉在哪"要用到已经被改掉的
 *   `entity.weapon`，而第 3 步又会把 item 清掉 —— 中间任一步失败都会
 *   出现"两个人手上有同一把武器"或者"武器凭空消失"。顺序对了，
 *   最坏情况是"两把都在地上"，那还是可恢复的。
 */
export function equipItem(world: World, actor: Entity, item: Entity): EquipResult {
  if (!actor.alive) return { ok: false, reason: 'dead' }
  if (item.kind !== 'item') return { ok: false, reason: 'notItem' }
  const incoming = item.weapon
  if (incoming === undefined) return { ok: false, reason: 'noWeapon' }
  if (!item.alive) return { ok: false, reason: 'noWeapon' }

  const previous = actor.weapon

  if (previous !== undefined) {
    /*
     * 换下来的掉在**脚边**，稍微偏一点。
     *
     * ⚠ 偏这一点点不是为了好看：不偏的话新捡起来的那件东西和刚丢下的
     *   完全重合，玩家会以为"怎么还是这把" —— 而且下一次按 F 捡到的是
     *   自己刚丢的那把（等价于什么都没发生，但他看不出来为什么）。
     *   偏移量固定，不用随机（纪律 4）。
     */
    const drop = spawn(world, {
      kind: 'item',
      faction: 'neutral',
      pos: { x: actor.pos.x + 0.6, y: actor.pos.y + 0.6 },
      radius: 0.25,
      weapon: previous,
    })
    world.events.push({ type: 'weaponDropped', entityId: actor.id, itemId: drop.id, weaponId: previous.id })
  }

  actor.weapon = {
    id: incoming.id,
    name: incoming.name,
    attributes: { ...incoming.attributes },
  }
  world.events.push({
    type: 'weaponEquipped', entityId: actor.id, itemId: item.id, weaponId: incoming.id, name: incoming.name,
  })

  despawn(world, item, 'despawned')

  return {
    ok: true,
    equipped: { id: incoming.id, name: incoming.name },
    ...(previous !== undefined ? { dropped: { id: previous.id, name: previous.name } } : {}),
  }
}

/**
 * 捡起**最近**的一件东西（按键那一下走这条）。
 *
 * ⚠ 它自己选目标，而不是让界面选好再传进来 ——
 *   和"施法只给原始意图、目标由引擎解析"是同一条原则
 *   （见 targeting.ts 的 resolveAim）。界面自己选的话，
 *   "够不够得着"就成了两处判断，而它们迟早会不一致。
 *
 * ⚠ 平手时取 id 小的那个：`world.entities` 的顺序是有意义的
 *   （生成顺序），沿用它就不用引入随机。
 */
export function pickupNearby(world: World, actor: Entity): EquipResult {
  if (!actor.alive) return { ok: false, reason: 'dead' }

  let best: Entity | undefined
  let bestDist = 0
  for (const e of world.entities) {
    if (!e.alive || e.kind !== 'item' || e.weapon === undefined) continue
    const dx = e.pos.x - actor.pos.x
    const dy = e.pos.y - actor.pos.y
    const d = Math.sqrt(dx * dx + dy * dy)
    // 够得着的距离按两者的体积放宽一点：大块头的东西不用踩上去
    if (d > PICKUP_RANGE + actor.radius + e.radius) continue
    if (best === undefined || d < bestDist) {
      best = e
      bestDist = d
    }
  }

  if (best === undefined) return { ok: false, reason: 'tooFar' }
  return equipItem(world, actor, best)
}

/**
 * 离得最近、够得着的那件东西（只用来**问**，不改状态）。
 *
 * 客户端拿它画"按 F 拾取长剑" —— 判据和 `pickupNearby` 完全一样，
 * 所以提示出现的时候按键一定有效。
 */
export function nearestPickup(world: World, actor: Entity): Entity | undefined {
  let best: Entity | undefined
  let bestDist = 0
  for (const e of world.entities) {
    if (!e.alive || e.kind !== 'item' || e.weapon === undefined) continue
    const dx = e.pos.x - actor.pos.x
    const dy = e.pos.y - actor.pos.y
    const d = Math.sqrt(dx * dx + dy * dy)
    if (d > PICKUP_RANGE + actor.radius + e.radius) continue
    if (best === undefined || d < bestDist) {
      best = e
      bestDist = d
    }
  }
  return best
}
