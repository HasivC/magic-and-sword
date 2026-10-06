/**
 * 模拟核心的出口。
 *
 * 这个目录（src/sim/）就是将来要独立出去的那一层：
 * 它不认识浏览器，也不认识 Canvas，只认数据和 tick。
 *
 *   npm run test:purity 会强制检查这一条。
 */
export * from './types.ts'
export * from './geom.ts'
export * from './rng.ts'
export * from './attributes.ts'
export * from './conditions.ts'
export * from './status.ts'
export * from './targeting.ts'
export * from './pipeline.ts'
export * from './projectile.ts'
export * from './cast.ts'
export * from './equip.ts'
export * from './barrier.ts'
export * from './ai.ts'
export * from './world.ts'
