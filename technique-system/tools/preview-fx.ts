/**
 * 特效预览器：把一条载体特效**离线渲染成 PNG**。
 *
 * ## 为什么需要它
 *
 * 特效是给人看的，但我在命令行里 —— 不开浏览器就看不见自己刚写的东西。
 * 那意味着"这道刀光好不好看"只能靠玩家反馈，一轮迭代要几分钟。
 *
 * 所以：`web/src/fx.ts` 把"画什么"抽成了**图元列表**（纯函数），
 * 这个工具用同一份图元在命令行里光栅化成 PNG。
 * **只有一份几何真相**，浏览器和这个工具是两个消费者。
 *
 * ## 它不替代真机
 *
 * 滤镜、混合、字形、缩放后的抗锯齿 —— 这些仍然是浏览器的活。
 * 它回答的是"形状对不对、层次够不够、颜色搭不搭"，
 * 也就是**能离线判断的那一半**。
 *
 * ## 用法
 *
 *   node tools/preview-fx.ts                    # 裂地斩的扇形，一整套帧
 *   node tools/preview-fx.ts --kind beam        # 看光束
 *   node tools/preview-fx.ts --type fire        # 换个伤害类型
 *   node tools/preview-fx.ts --out docs/fx      # 换个输出目录
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { resolve } from 'node:path'
import { spawnDelivery, updateDelivery, allPrims } from '../web/src/fx.ts'
import type { DeliveryFx, DeliveryEvent, Prim } from '../web/src/fx.ts'

// ---------------------------------------------------------------- 参数

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const KIND = (arg('kind') ?? 'meleeArc') as DeliveryEvent['kind']
const TYPE = arg('type') ?? 'physical'
const OUT = resolve(arg('out') ?? 'docs/fx')
const SCALE = Number(arg('scale') ?? 120)     // 每米多少像素

// 裂地斩：半径 2.5 米、张角 120°、朝右
const EVENT: DeliveryEvent = {
  kind: KIND,
  from: { x: 0, y: 0 },
  dir: { x: 1, y: 0 },
  hitCount: 1,
  damageType: TYPE,
  ...(KIND === 'meleeArc' ? { radius: 2.5, angle: 120 } : {}),
  ...(KIND === 'beam' || KIND === 'capsule' ? { length: 12, width: 0.8 } : {}),
  ...(KIND === 'area' || KIND === 'aura' ? { radius: 2.5, width: 0.5 } : {}),
}

// ---------------------------------------------------------------- 光栅化

/**
 * 一张 RGB 画布（浮点，方便做加法混合），背景是按项目配色的深色。
 *
 * 底色取和游戏里一样的 #0d1017 —— 特效在别的底色上完全是另一个样子。
 */
const BG = { r: 13, g: 16, b: 23 }

interface Canvas {
  w: number
  h: number
  buf: Float32Array
}

function makeCanvas(w: number, h: number): Canvas {
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

/** 世界坐标（米） → 像素。原点画在画布中心偏左，好让扇形铺开 */
function toPx(c: Canvas, x: number, y: number): { px: number; py: number } {
  return { px: c.w / 2 - SCALE * 1.2 + x * SCALE, py: c.h / 2 + y * SCALE }
}

/** 点到线段的距离 */
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

/** 角度 a 在 [a0, a1] 这段弧里吗（a1 可以超过 a0 + 2π，表示整圈） */
function angIn(a: number, a0: number, a1: number): boolean {
  if (a1 - a0 >= Math.PI * 2 - 1e-9) return true
  const d = angDiff(a, a0)
  return d >= -1e-9 && d <= (a1 - a0) + 1e-9
}

/**
 * 一个图元的**覆盖率**（0..1）。用 2×2 超采样，边缘就不会是硬锯齿。
 *
 * 这里每种图元都写成了"点到形状的距离"的解析判断 ——
 * 因为图元本身就是解析形状（弧、线段、扇形），不需要通用多边形填充。
 */
function coverage(c: Canvas, p: Prim, px: number, py: number): number {
  const o = toPx(c, p.x ?? 0, p.y ?? 0)
  const inside = (sx: number, sy: number): boolean => {
    switch (p.op) {
      case 'disc': {
        const d = Math.hypot(sx - o.px, sy - o.py)
        return d <= p.r * SCALE
      }
      case 'annulus': {
        const d = Math.hypot(sx - o.px, sy - o.py)
        if (d < p.r0 * SCALE || d > p.r1 * SCALE) return false
        const a = Math.atan2(sy - o.py, sx - o.px)
        return angIn(a, p.a0, p.a1)
      }
      case 'wedge': {
        const d = Math.hypot(sx - o.px, sy - o.py)
        if (d > p.r * SCALE) return false
        const a = Math.atan2(sy - o.py, sx - o.px)
        return angIn(a, p.a0, p.a1)
      }
      case 'arc': {
        const d = Math.hypot(sx - o.px, sy - o.py)
        if (Math.abs(d - p.r * SCALE) > (p.width * SCALE) / 2) return false
        const a = Math.atan2(sy - o.py, sx - o.px)
        return angIn(a, p.a0, p.a1)
      }
      case 'line': {
        const A = toPx(c, p.x0, p.y0)
        const B = toPx(c, p.x1, p.y1)
        const d = distToSegment(sx, sy, A.px, A.py, B.px, B.py)
        return d <= Math.max(0.6, (p.width * SCALE) / 2)
      }
      default:
        return false
    }
  }

  let hit = 0
  for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
    if (inside(px + dx, py + dy)) hit++
  }
  return hit / 4
}

/** 加法混合画一批图元（和浏览器里的 `lighter` 一个意思） */
function raster(c: Canvas, prims: Prim[]): void {
  for (const p of prims) {
    const [r, g, b] = hexToRgb(p.color)
    const a = Math.max(0, Math.min(1, p.alpha))
    if (a <= 0) continue

    for (let y = 0; y < c.h; y++) {
      for (let x = 0; x < c.w; x++) {
        const cov = coverage(c, p, x, y)
        if (cov <= 0) continue
        const k = a * cov
        const i = (y * c.w + x) * 3
        c.buf[i] = Math.min(255, (c.buf[i] ?? 0) + r * k)
        c.buf[i + 1] = Math.min(255, (c.buf[i + 1] ?? 0) + g * k)
        c.buf[i + 2] = Math.min(255, (c.buf[i + 2] ?? 0) + b * k)
      }
    }
  }
}

// ---------------------------------------------------------------- PNG 编码
//
// 手写一个最小 PNG 编码器（IHDR + IDAT + IEND），因为项目里没有图像依赖。
// 8 位真彩、无滤波 —— 对这种图足够，而且没有一行多余的东西。

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const len = data.length
  out[0] = (len >>> 24) & 0xff; out[1] = (len >>> 16) & 0xff
  out[2] = (len >>> 8) & 0xff; out[3] = len & 0xff
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  const crc = crc32(out.subarray(4, 8 + data.length))
  out[8 + len] = (crc >>> 24) & 0xff; out[9 + len] = (crc >>> 16) & 0xff
  out[10 + len] = (crc >>> 8) & 0xff; out[11 + len] = crc & 0xff
  return out
}

function encodePng(c: Canvas): Uint8Array {
  // 每行前面加一个滤波字节（0 = 不滤波）
  const raw = new Uint8Array(c.h * (c.w * 3 + 1))
  for (let y = 0; y < c.h; y++) {
    const rowStart = y * (c.w * 3 + 1)
    raw[rowStart] = 0
    for (let x = 0; x < c.w * 3; x++) {
      raw[rowStart + 1 + x] = Math.max(0, Math.min(255, Math.round(c.buf[y * c.w * 3 + x] ?? 0)))
    }
  }

  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, c.w)
  view.setUint32(4, c.h)
  ihdr[8] = 8     // 位深
  ihdr[9] = 2     // 真彩 RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk('IEND', new Uint8Array(0)),
  ]

  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

// ---------------------------------------------------------------- 主流程

const W = 760
const H = 560

mkdirSync(OUT, { recursive: true })

/**
 * 一条特效在某一刻的样子。**单帧** —— 浏览器里每一帧就是这么画的。
 *
 * ⚠ 不要叠几帧来"暗示拖尾"：那会把亮度叠高，看图的人（包括我）
 *   会以为实际效果有那么亮。拖尾本来就是**同一帧里**的那条环带。
 */
function renderAt(fx: DeliveryFx, age: number): Uint8Array {
  const c = makeCanvas(W, H)

  const copy = spawnDelivery(EVENT)
  // 按 240Hz 推进到目标时刻：粒度比 60Hz 细，扫过的角度才准
  const step = 1 / 240
  while (copy.age < age && copy.age < copy.life) updateDelivery(copy, step)

  raster(c, allPrims(copy))
  return encodePng(c)
}

const frames = [0.02, 0.05, 0.08, 0.12, 0.18, 0.24]
console.log('')
console.log(`特效预览  ·  ${KIND}  ·  ${TYPE}`)
console.log('─'.repeat(60))

for (const t of frames) {
  const png = renderAt(spawnDelivery(EVENT), t)
  const name = `${KIND}-${TYPE}-t${String(Math.round(t * 1000)).padStart(3, '0')}.png`
  writeFileSync(resolve(OUT, name), png)
  console.log(`  ${name}   ${(png.length / 1024).toFixed(1)} KB`)
}

console.log('')
console.log(`  写到 ${OUT}`)
console.log('')
