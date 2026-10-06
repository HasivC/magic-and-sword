/**
 * 一个极小的**软件光栅化器**：把 `Prim[]` 画进一张 RGB 缓冲。
 *
 * ## 它和浏览器里的绘制器是什么关系
 *
 * `web/src/fx.ts` 把特效拆成了两层：
 *
 *   `deliveryPrims(fx)`  纯函数，吐出**图元**（环带 / 弧 / 线 / 圆）
 *   `drawPrims(ctx, …)`  把图元交给 Canvas 2D（游戏里跑的就是这一份）
 *
 * 这个文件是**第二个消费者** —— 它把同一份图元用 CPU 画出来，
 * 于是特效可以离线变成 PNG：既能在命令行里看一眼（`preview-fx.ts`），
 * 也能生成"假的素材帧"来验证载入管线（`make-sample-fx.ts`）。
 *
 * ⚠ 它**不追求**和 Canvas 一模一样。滤镜、字形、真实缩放下的抗锯齿
 *   仍然是浏览器的活。它回答的是"形状对不对、层次够不够"。
 *
 * ## 每种图元都是解析形状
 *
 * 环带是"半径在 [r0,r1] 且角度在 [a0,a1] 内"，弧是"到圆周的距离小于一半线宽"……
 * 所以不需要通用多边形填充，一个 `inside(x,y)` 就够了。
 * 每个图元先算**包围盒**再逐像素 —— 不裁剪的话 24 片拖尾要把整屏扫 24 遍。
 */
import type { Prim } from '../web/src/fx.ts'
import type { RgbImage } from './png.ts'

/** 底色，和游戏里的 #0d1017 一致 —— 特效在别的底色上完全是另一个样子 */
export const BG = { r: 13, g: 16, b: 23 }

export function makeImage(w: number, h: number): RgbImage {
  const buf = new Float32Array(w * h * 3)
  for (let i = 0; i < w * h; i++) {
    buf[i * 3] = BG.r
    buf[i * 3 + 1] = BG.g
    buf[i * 3 + 2] = BG.b
  }
  return { w, h, buf }
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

function distToSegment(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0
  const dy = y1 - y0
  const len2 = dx * dx + dy * dy
  if (len2 <= 1e-12) return Math.hypot(px - x0, py - y0)
  let t = ((px - x0) * dx + (py - y0) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy))
}

/** 角度差，折到 (-π, π] */
function angDiff(a: number, b: number): number {
  let d = a - b
  while (d > Math.PI) d -= Math.PI * 2
  while (d <= -Math.PI) d += Math.PI * 2
  return d
}

/** 角度 a 在 [a0, a1] 里吗（跨度 ≥ 2π 表示整圈） */
function angIn(a: number, a0: number, a1: number): boolean {
  if (a1 - a0 >= Math.PI * 2 - 1e-9) return true
  const d = angDiff(a, a0)
  return d >= -1e-9 && d <= (a1 - a0) + 1e-9
}

/** 世界坐标（米）→ 像素 */
export interface View {
  scale: number
  ox: number
  oy: number
}

/** 一个图元的包围盒（像素，含线宽的一半），用于裁剪 */
function bbox(p: Prim, v: View): [number, number, number, number] {
  const pad = 2
  const px = (x: number) => v.ox + x * v.scale
  const py = (y: number) => v.oy + y * v.scale

  switch (p.op) {
    case 'disc': {
      const r = p.r * v.scale + pad
      return [px(p.x) - r, py(p.y) - r, px(p.x) + r, py(p.y) + r]
    }
    case 'wedge':
    case 'annulus': {
      const outer = (p.op === 'wedge' ? p.r : p.r1) * v.scale + pad
      return [px(p.x) - outer, py(p.y) - outer, px(p.x) + outer, py(p.y) + outer]
    }
    case 'arc': {
      const r = p.r * v.scale + (p.width * v.scale) / 2 + pad
      return [px(p.x) - r, py(p.y) - r, px(p.x) + r, py(p.y) + r]
    }
    case 'line': {
      const hw = (p.width * v.scale) / 2 + pad
      return [
        Math.min(px(p.x0), px(p.x1)) - hw, Math.min(py(p.y0), py(p.y1)) - hw,
        Math.max(px(p.x0), px(p.x1)) + hw, Math.max(py(p.y0), py(p.y1)) + hw,
      ]
    }
    default:
      return [0, 0, 0, 0]
  }
}

/** 覆盖率（0..1）。2×2 超采样，边缘就不是硬锯齿 */
function coverage(p: Prim, v: View, sx: number, sy: number): number {
  const cx = p.op === 'line' ? 0 : p.x
  const cy = p.op === 'line' ? 0 : p.y
  const ox = v.ox + cx * v.scale
  const oy = v.oy + cy * v.scale

  const inside = (x: number, y: number): boolean => {
    switch (p.op) {
      case 'disc':
        return Math.hypot(x - ox, y - oy) <= p.r * v.scale
      case 'wedge':
        return Math.hypot(x - ox, y - oy) <= p.r * v.scale
          && angIn(Math.atan2(y - oy, x - ox), p.a0, p.a1)
      case 'annulus': {
        const d = Math.hypot(x - ox, y - oy)
        return d >= p.r0 * v.scale && d <= p.r1 * v.scale
          && angIn(Math.atan2(y - oy, x - ox), p.a0, p.a1)
      }
      case 'arc': {
        const d = Math.hypot(x - ox, y - oy)
        if (Math.abs(d - p.r * v.scale) > (p.width * v.scale) / 2) return false
        return angIn(Math.atan2(y - oy, x - ox), p.a0, p.a1)
      }
      case 'line': {
        const x0 = v.ox + p.x0 * v.scale
        const y0 = v.oy + p.y0 * v.scale
        const x1 = v.ox + p.x1 * v.scale
        const y1 = v.oy + p.y1 * v.scale
        return distToSegment(x, y, x0, y0, x1, y1) <= Math.max(0.6, (p.width * v.scale) / 2)
      }
      default:
        return false
    }
  }

  let hit = 0
  for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
    if (inside(sx + dx, sy + dy)) hit++
  }
  return hit / 4
}

/** 加法混合画一批图元（和浏览器里的 `lighter` 一个意思） */
export function raster(img: RgbImage, prims: Prim[], v: View): void {
  for (const p of prims) {
    const [r, g, b] = hexToRgb(p.color)
    const a = Math.max(0, Math.min(1, p.alpha))
    if (a <= 0) continue

    const [bx0, by0, bx1, by1] = bbox(p, v)
    const x0 = Math.max(0, Math.floor(bx0))
    const y0 = Math.max(0, Math.floor(by0))
    const x1 = Math.min(img.w - 1, Math.ceil(bx1))
    const y1 = Math.min(img.h - 1, Math.ceil(by1))

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const cov = coverage(p, v, x, y)
        if (cov <= 0) continue
        const k = a * cov
        const i = (y * img.w + x) * 3
        img.buf[i] = Math.min(255, (img.buf[i] ?? 0) + r * k)
        img.buf[i + 1] = Math.min(255, (img.buf[i + 1] ?? 0) + g * k)
        img.buf[i + 2] = Math.min(255, (img.buf[i + 2] ?? 0) + b * k)
      }
    }
  }
}
