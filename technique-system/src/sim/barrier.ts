/**
 * 屏障：**谁能穿过我**。
 *
 * ## 为什么单独一个文件
 *
 * "挡子弹"和"挡人"看起来是两件事（一个在投射物里、一个在位置积分之后），
 * 但它们必须用**同一份判定**。分成两处写的话，
 * 迟早出现"子弹被挡住了、人却从墙里走过去"这种自相矛盾的行为 ——
 * 而且两边各自的测试都会通过。
 *
 * ## 四条通行规则
 *
 * 玩家 2026-09-21 要的：
 *   > 玩家可以决定自己的子弹能否穿过墙（如果有反弹型子弹，这条就有用了）、
 *   > 敌人的子弹能否穿墙（用于获取点数）、以及敌人和友方能否穿墙。
 *
 * ⚠ 四项都存在 `Entity.block` 上，而且**都是"能不能穿过"**（`true` = 放行）。
 *   判定方式是**按阵营比出来的**：同阵营查 `own*`，敌对阵营查 `enemy*`。
 *   所以被魅惑（改阵营）之后，他的墙对新阵营来说仍然是"自己的墙"——
 *   这一条和纪律 1（一切按阵营动态查询）是一致的。
 */
import type { BlockPolicy, EntityShape } from '../schema.ts'
import type { Entity, World } from './types.ts'
import { factionOf, isHostile } from './status.ts'
import { shapeClearance, type Shape } from './geom.ts'

/**
 * 默认策略：**自己的子弹放行、敌人的子弹挡住、人不挡**。
 *
 * ⚠ 默认值是有立场的，不是随手填的：
 *   · 自己的子弹挡住 → 你打不到墙那边的敌人，这是纯亏（没人会想要）
 *   · 敌人的子弹放行 → 那这堵墙什么都不是
 *   · 挡人 → 是个很大的行为（会把队友关在外面、把敌人卡住），
 *     必须显式开，不能默认开
 */
export const DEFAULT_BLOCK: Required<BlockPolicy> = {
  ownProjectiles: true,
  enemyProjectiles: false,
  ownUnits: true,
  enemyUnits: true,
}

export type BlockTarget = 'projectile' | 'unit'

/** 实体身上生效的通行策略（没写就是默认表） */
export function blockPolicyOf(entity: Entity): Required<BlockPolicy> {
  return { ...DEFAULT_BLOCK, ...(entity.block ?? {}) }
}

/**
 * `mover` 能不能**穿过** `wall`？
 *
 * ⚠ 参数是 `mover` 而不是"阵营"：因为阵营必须**当场**从实体上读
 *   （魅惑会改它），传一个阵营进来就等于把那一刻的快照烧死在调用处。
 */
export function canPassThrough(world: World, wall: Entity, mover: Entity, kind: BlockTarget): boolean {
  void world
  const policy = blockPolicyOf(wall)
  const same = !isHostile(factionOf(wall), factionOf(mover))
  if (kind === 'projectile') return same ? policy.ownProjectiles : policy.enemyProjectiles
  return same ? policy.ownUnits : policy.enemyUnits
}

/** 这个实体是不是"屏障"（会挡东西的那种） */
export function isObstacle(entity: Entity): boolean {
  return entity.kind === 'obstacle' && entity.alive
}

/** 屏障的形状（没写形状就是圆，半径用实体自己的） */
export function shapeOf(entity: Entity): Shape {
  const s: EntityShape | undefined = entity.shape
  if (s === undefined) return { kind: 'circle', radius: entity.radius }
  if (s.kind === 'circle') return { kind: 'circle', radius: s.radius }
  return { kind: 'segment', length: s.length, width: s.width }
}

/**
 * `mover` 撞上这个屏障了吗（按它自己的体积算）。
 *
 * ⚠ `extra` 是调用方自己的碰撞半径：
 *   投射物用 `p.radius`，人用 `radius`。判定是"两个形状重叠"，
 *   也就是"中心到墙面的距离 < 我的半径"。
 */
export function overlapsObstacle(wall: Entity, moverPos: { x: number; y: number; z: number }, extra: number): boolean {
  return shapeClearance(shapeOf(wall), wall.pos, wall.facing, moverPos as never) <= extra
}
