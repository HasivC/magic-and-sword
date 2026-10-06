/**
 * 序列帧特效预览：**把作者的素材合成到一个"像游戏"的场景里**。
 *
 * ## 为什么需要它
 *
 * 玩家问的两个问题——"火花是不是太小了"、"为什么炸在怪物中心"——
 * 都只能**看图**回答，看数字答不了。
 *
 * 这个工具把素材按定义里的 `meters` 缩放，画到一张带参照物的画布上：
 * 一只小怪、一只大体型 Boss、命中点标记。
 * 于是"多大合适""炸在哪"变成可以一眼判断的事，不用来回开浏览器试。
 *
 * ⚠ 它**不替代真机**（滤镜、混合、帧间过渡还是浏览器的活），
 *   但它能回答尺寸和位置这类几何问题 —— 而那正是最费时间来回试的部分。
 *
 * 用法：
 *   node tools/preview-sprite.ts magic-bolt-hit
 *   node tools/preview-sprite.ts magic-bolt-hit --meters 4
 *   node tools/preview-sprite.ts magic-bolt-hit --frame 7 --boss 3
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { decodePng, encodePng } from './png.ts'
import type { RgbaImage } from './png.ts'
import { readJson } from '../src/loader.ts'
import type { FxDef } from '../web/src/fx.ts'

// ---------------------------------------------------------------- 参数

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const NAME = process.argv.slice(2).find(a => !a.startsWith('--') && !/^\d+(\.\d+)?$/.test(a)) ?? 'magic-bolt-hit'
const DEF = readJson<FxDef>(resolve('content/fx', `${NAME}.json`))

/** 覆盖 `meters`（想试不同大小又不想改文件时用） */
const METERS = Number(arg('meters') ?? DEF.meters)
const BOSS_RADIUS = Number(arg('boss') ?? 3)
const SMALL_RADIUS = 0.5
const OUT = resolve(arg('out') ?? 'docs/fx')

// ---------------------------------------------------------------- 场景

const PX_PER_M = 64
const W = 900
const H = 420

/** 深色底，和游戏一致 */
const BG = { r: 13, g: 16, b: 23 }
const MONSTER = { r: 60, g: 70, b: 84 }
const MONSTER_EDGE = { r: 110, g: 124, b: 143 }
const MARK = { r: 255, g: 90, b: 90 }

interface Canvas {
  w: number
  h: number
  r: Float32Array
  g: Float32Array
  b: Float32Array
}

function makeCanvas(w: number, h: number): Canvas {
  const n = w * h
  const c: Canvas = { w, h, r: new Float32Array(n), g: new Float32Array(n), b: new Float32Array(n) }
  for (let i = 0; i < n; i++) { c.r[i] = BG.r; c.g[i] = BG.g; c.b[i] = BG.b }
  return c
}

/** 普通覆盖（画怪物的身体） */
function blend(c: Canvas, x: number, y: number, rgb: { r: number, g: number, b: number }, a: number): void {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h || a <= 0) return
  const i = y * c.w + x
  const k = Math.min(1, a)
  c.r[i] = (c.r[i] ?? 0) * (1 - k) + rgb.r * k
  c.g[i] = (c.g[i] ?? 0) * (1 - k) + rgb.g * k
  c.b[i] = (c.b[i] ?? 0) * (1 - k) + rgb.b * k
}

/** 加法混合（画特效 —— 和游戏里的 `lighter` 一个意思） */
function add(c: Canvas, x: number, y: number, rgb: { r: number, g: number, b: number }, a: number): void {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h || a <= 0) return
  const i = y * c.w + x
  const k = Math.min(1, a)
  c.r[i] = Math.min(255, (c.r[i] ?? 0) + rgb.r * k)
  c.g[i] = Math.min(255, (c.g[i] ?? 0) + rgb.g * k)
  c.b[i] = Math.min(255, (c.b[i] ?? 0) + rgb.b * k)
}

/** 画一个圆（怪物的身体 + 描边） */
function drawCircle(c: Canvas, cx: number, cy: number, rMeters: number, fill: typeof MONSTER, edge: typeof MONSTER): void {
  const r = rMeters * PX_PER_M
  const x0 = Math.max(0, Math.floor(cx - r - 2))
  const x1 = Math.min(c.w - 1, Math.ceil(cx + r + 2))
  const y0 = Math.max(0, Math.floor(cy - r - 2))
  const y1 = Math.min(c.h - 1, Math.ceil(cy + r + 2))

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
      if (d <= r - 1) blend(c, x, y, fill, 1)
      else if (d <= r) blend(c, x, y, edge, Math.min(1, r - d))
    }
  }
}

/** 一个十字标记（命中点） */
function drawMark(c: Canvas, cx: number, cy: number): void {
  for (let d = -7; d <= 7; d++) {
    blend(c, Math.round(cx) + d, Math.round(cy), MARK, 0.85)
    blend(c, Math.round(cx), Math.round(cy) + d, MARK, 0.85)
  }
}

/**
 * 把一帧素材按世界尺寸贴上去。
 *
 * ⚠ 缩放用**最近邻**，不插值 —— 这个工具是拿来看"多大 / 在哪"的，
 *   插值出来的柔边会让人误判强度。真机上浏览器会做双线性，那才是最终效果。
 */
function drawSprite(
  c: Canvas, img: RgbaImage,
  worldX: number, worldY: number,
  meters: number, anchorX: number, anchorY: number,
): void {
  const scale = (meters * PX_PER_M) / img.w
  const w = Math.round(img.w * scale)
  const h = Math.round(img.h * scale)
  const left = worldX - w * anchorX
  const top = worldY - h * anchorY

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.w - 1, Math.floor(x / scale))
      const sy = Math.min(img.h - 1, Math.floor(y / scale))
      const si = (sy * img.w + sx) * 4
      const a = (img.rgba[si + 3] ?? 0) / 255
      if (a <= 0.004) continue
      add(c, Math.round(left) + x, Math.round(top) + y, {
        r: img.rgba[si] ?? 0,
        g: img.rgba[si + 1] ?? 0,
        b: img.rgba[si + 2] ?? 0,
      }, a)
    }
  }
}

function framePath(index: number): string {
  const start = DEF.start ?? 1
  const n = String(start + index).padStart(DEF.pad, '0')
  return resolve('content/fx', DEF.dir, `${DEF.prefix}${n}.${DEF.ext ?? 'png'}`)
}

// ---------------------------------------------------------------- 主流程

mkdirSync(OUT, { recursive: true })

const frames = Array.from({ length: DEF.frames }, (_, i) => decodePng(readFileSync(framePath(i))))

/** 最亮的那一帧（文件最大的通常是内容最多的，避开空帧） */
const brightest = frames.reduce((best, f, i) => {
  let sum = 0
  for (let p = 3; p < f.rgba.length; p += 4) sum += f.rgba[p] ?? 0
  return sum > best.sum ? { i, sum } : best
}, { i: 0, sum: -1 }).i

const useFrame = Number(arg('frame') ?? brightest)
const img = frames[useFrame] ?? frames[0]
if (img === undefined) throw new Error('一帧都没读出来')

const anchorX = DEF.anchor?.[0] ?? 0.5
const anchorY = DEF.anchor?.[1] ?? 0.5

// ---- 三个场景并排，一眼看出区别 ----

const scenes: { title: string, sub: string }[] = [
  { title: '小怪（半径 0.5 米）', sub: '接触点' },
  { title: `Boss（半径 ${BOSS_RADIUS} 米）`, sub: '接触点' },
  { title: `Boss（半径 ${BOSS_RADIUS} 米）`, sub: '目标中心 ← 旧行为' },
]

const c = makeCanvas(W, H)
const colW = W / 3

scenes.forEach((scene, i) => {
  const cx = colW * i + colW / 2
  const cy = H / 2 + 30
  const r = i === 0 ? SMALL_RADIUS : BOSS_RADIUS

  drawCircle(c, cx, cy, r, MONSTER, MONSTER_EDGE)

  // 命中点：第三个场景故意用中心（展示旧行为长什么样）
  const atCenter = i === 2
  const hx = atCenter ? cx : cx
  const hy = atCenter ? cy : cy - r

  if (!atCenter) drawMark(c, hx, hy)
  drawSprite(c, img, hx, hy, METERS, anchorX, anchorY)
})

const out = encodePng({
  w: c.w, h: c.h,
  buf: (() => {
    const buf = new Float32Array(c.w * c.h * 3)
    for (let i = 0; i < c.w * c.h; i++) {
      buf[i * 3] = c.r[i] ?? 0
      buf[i * 3 + 1] = c.g[i] ?? 0
      buf[i * 3 + 2] = c.b[i] ?? 0
    }
    return buf
  })(),
})

const name = `${NAME}-preview-m${METERS}-f${useFrame}.png`
writeFileSync(resolve(OUT, name), out)

console.log('')
console.log(`序列帧预览  ·  ${DEF.name ?? DEF.id}`)
console.log('─'.repeat(64))
console.log(`  素材      ${DEF.frames} 帧 · ${img.w}×${img.h}px · ${DEF.pxPerMeter} px/米（做图比例）`)
console.log(`  画出来    最亮的一帧是第 ${brightest} 帧，这里用第 ${useFrame} 帧`)
console.log(`  世界尺寸  ${METERS} 米宽   （定义里写的是 ${DEF.meters} 米）`)
if (METERS !== DEF.meters) console.log(`            ⚠ 命令行覆盖了定义里的值`)
console.log(`  锚点      [${anchorX}, ${anchorY}]`)
console.log('')
console.log(`  三栏对比：小怪接触点 / Boss 接触点 / Boss 中心（旧行为）`)
console.log(`  写到 ${resolve(OUT, name)}`)
console.log('')
