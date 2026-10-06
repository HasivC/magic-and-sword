/**
 * 几何。
 *
 * 单开一个文件是为了断开循环依赖：属性系统要用距离，
 * 而 world 要用属性系统。几何谁都不依赖，放在最底层最安全。
 *
 * ⚠ 这里只用 Math.sqrt，不用 Math.hypot。
 *   sqrt 是 IEEE 754 强制精确的，跨引擎逐位一致；
 *   hypot 不是，用了会破坏重放和联机同步。
 */
import type { Vec2, Vec3 } from './types.ts'

/** 平面距离，不含 z —— z 只用于渲染 */
export function distance(a: Vec3, b: Vec3): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  return Math.sqrt(dx * dx + dy * dy)
}

/** 高度差。击飞、空中判定用 */
export function heightDelta(a: Vec3, b: Vec3): number {
  return b.z - a.z
}

/** 归一化成单位向量。零向量返回 (1, 0)，不返回 NaN */
export function normalize2(v: Vec2): Vec2 {
  const len = Math.sqrt(v.x * v.x + v.y * v.y)
  if (len === 0) return { x: 1, y: 0 }
  return { x: v.x / len, y: v.y / len }
}

/** 点积。判断"在不在我面前"用 */
export function dot2(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y
}

// ---------------------------------------------------------------- 形状

/**
 * 一个形状（屏障那类实体用的）。
 *
 * ⚠ 只有两种，和 schema 里的 `EntityShape` 一一对应 ——
 *   放一份在 sim 里是因为**纪律 4**：sim 不许 import 内容层以外的运行时对象，
 *   而 schema 只是类型。所以这里重新声明一次结构，由内容层翻译过来。
 */
export type Shape =
  | { kind: 'circle'; radius: number }
  | { kind: 'segment'; length: number; width: number }

/**
 * 点到形状**表面**的有符号距离：负数 = 在形状里，正数 = 在外面。
 *
 * ⚠ 有符号是刻意的：它同时回答两个问题 ——
 *   "撞上了吗"（`<= 0`）和"要推出去多远"（`-它`）——
 *   于是投射物判定和"把人推出去"用的是同一份数学。
 *   两处各写一遍的话，会出现"子弹被挡住了、人却从墙里走过去"这种事。
 */
export function shapeClearance(shape: Shape, center: Vec3, facing: Vec2, p: Vec3): number {
  if (shape.kind === 'circle') {
    return distance(center, p) - shape.radius
  }

  /*
   * 线段：以实体朝向为轴，长 length、宽 width，中心在实体位置。
   * 判定和载体的 capsule 一样 —— 两次投影，不需要三角函数。
   */
  const f = normalize2(facing)
  const dx = p.x - center.x
  const dy = p.y - center.y
  const along = dx * f.x + dy * f.y
  const half = shape.length / 2
  const clamped = along < -half ? -half : along > half ? half : along
  // 最近点 = 中心 + 朝向 × clamped
  const cx = center.x + f.x * clamped
  const cy = center.y + f.y * clamped
  const ddx = p.x - cx
  const ddy = p.y - cy
  return Math.sqrt(ddx * ddx + ddy * ddy) - shape.width / 2
}

/**
 * 把一个点从形状里**推出来**（已经在外面就原样返回）。
 *
 * ⚠ 推出方向取"最近点 → 点"的方向；点正好压在轴上（退化）时用**法线**，
 *   而且符号固定 —— 不能用随机或者"看哪个方向更近"，那会破坏可重放。
 */
export function pushOutOfShape(
  shape: Shape,
  center: Vec3,
  facing: Vec2,
  p: Vec3,
  neededClearance: number,
): { x: number; y: number } | undefined {
  const clearance = shapeClearance(shape, center, facing, p)
  if (clearance >= neededClearance) return undefined
  const push = neededClearance - clearance

  if (shape.kind === 'circle') {
    const dx = p.x - center.x
    const dy = p.y - center.y
    const len = Math.sqrt(dx * dx + dy * dy)
    if (len < 1e-6) return { x: center.x + push, y: center.y }   // 正中心：往固定方向推
    return { x: p.x + (dx / len) * push, y: p.y + (dy / len) * push }
  }

  const f = normalize2(facing)
  const half = shape.length / 2
  const alongRaw = (p.x - center.x) * f.x + (p.y - center.y) * f.y
  const clamped = alongRaw < -half ? -half : alongRaw > half ? half : alongRaw
  const cx = center.x + f.x * clamped
  const cy = center.y + f.y * clamped
  const ddx = p.x - cx
  const ddy = p.y - cy
  const len = Math.sqrt(ddx * ddx + ddy * ddy)
  if (len < 1e-6) {
    // 正好压在轴上：用**左法线**（固定符号，保证可重放）
    return { x: p.x - f.y * push, y: p.y + f.x * push }
  }
  return { x: p.x + (ddx / len) * push, y: p.y + (ddy / len) * push }
}
