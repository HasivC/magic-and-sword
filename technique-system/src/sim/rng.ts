/**
 * 确定性随机数。
 *
 * ⚠ 绝对不能用 Math.random() —— 它没有任何办法重放。
 *
 * 用的是 mulberry32：一个很小的整数混洗算法。
 * 只用位运算和 Math.imul，这两样在所有 JS 引擎上都是逐位一致的。
 */
import type { World } from './types.ts'

/** 把任意 32 位整数作为种子，初始化世界里的随机状态 */
export function seedRng(world: World, seed: number): void {
  world.rngState = seed >>> 0
}

/** 取一个 [0, 1) 的随机数，并推进世界里的随机状态 */
export function nextFloat(world: World): number {
  world.rngState = (world.rngState + 0x6d2b79f5) >>> 0
  let t = world.rngState
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** 取一个 [min, max) 的随机浮点数 */
export function nextRange(world: World, min: number, max: number): number {
  return min + nextFloat(world) * (max - min)
}

/** 取一个 [0, n) 的随机整数 */
export function nextInt(world: World, n: number): number {
  return Math.floor(nextFloat(world) * n)
}

/**
 * 按权重挑一个。
 * 用于 AI 决策和掉落 —— 这些也都必须可重放。
 */
export function pickWeighted<T>(world: World, items: readonly T[], weightOf: (item: T) => number): T | undefined {
  let total = 0
  for (const it of items) total += weightOf(it)
  if (total <= 0) return undefined

  let roll = nextFloat(world) * total
  for (const it of items) {
    roll -= weightOf(it)
    if (roll <= 0) return it
  }
  return items[items.length - 1]
}
