/**
 * 素材检查器：**在特效进游戏之前，把会静默坏掉的地方查出来。**
 *
 * ## 为什么需要它
 *
 * 从 AE 导出的 PNG 有一堆"能打开、看着挺好、进游戏才发现不对"的坑：
 *
 *   1. **背景不是透明的** —— 导出时忘了关掉背景层，于是整个特效带着一块
 *      不透明底色。加色混合下它会变成一整片亮块，而不是一道光。
 *   2. **画面被裁掉了** —— 合成开小了，特效顶到边缘。
 *      画面上看不出来（边缘就是边缘），进游戏才发现被切了一刀。
 *   3. **前后一堆空帧** —— AE 的补零导出经常带空白头尾，
 *      播起来就是"按下去先愣一下"。
 *   4. **命名对不上** —— 帧号从 0 还是 1 开始、补几位零，拼错就是 404。
 *
 * 这四样**都不会报错**。所以要有工具看一眼，而不是等玩家说"怎么不对"。
 *
 * 用法：
 *   node tools/check-fx.ts content/fx/magic-bolt-hit
 *   node tools/check-fx.ts content/fx/magic-bolt-hit --json
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { decodePng } from './png.ts'

// ============================================================================
//  检查
// ============================================================================

interface Report {
  file: string
  w: number
  h: number
  hasAlpha: boolean
  /** 完全透明的像素占多少 */
  transparentPct: number
  /** 完全不透明的像素占多少（太高 = 背景被烘进去了） */
  opaquePct: number
  /** 非透明内容的包围盒 */
  bbox: [number, number, number, number] | null
  /** 内容有没有顶到画布边缘 */
  touchesEdge: boolean
  /** 整张图是空的吗 */
  blank: boolean
  problems: string[]
}

/**
 * 这个 PNG 带 alpha 通道吗（colorType 6 = 真彩+alpha，2 = 真彩）。
 * 解码器统一吐 RGBA，所以要单独看原始 colorType。
 */
function hasAlphaChannel(buf: Buffer): boolean {
  return buf[25] === 6
}

/** alpha 大于这个值就算"有内容" */
const ALPHA_CUTOFF = 8
/** 贴着边缘这么多像素内有内容就算顶边 */
const EDGE_MARGIN = 2

function check(path: string): Report {
  const img = decodePng(readFileSync(path))
  const { w, h, rgba } = img

  let transparent = 0
  let opaque = 0
  let minX = w, minY = h, maxX = -1, maxY = -1

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = rgba[(y * w + x) * 4 + 3] ?? 0
      if (a <= ALPHA_CUTOFF) { transparent++; continue }
      if (a >= 250) opaque++
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }

  const total = w * h
  const blank = maxX < 0
  const bbox: [number, number, number, number] | null = blank ? null : [minX, minY, maxX, maxY]

  const touchesEdge = !blank && (
    minX <= EDGE_MARGIN || minY <= EDGE_MARGIN ||
    maxX >= w - 1 - EDGE_MARGIN || maxY >= h - 1 - EDGE_MARGIN
  )

  const problems: string[] = []
  const opaquePct = (opaque / total) * 100
  const transparentPct = (transparent / total) * 100

  if (!blank && opaquePct > 40) {
    problems.push(`完全不透明的像素占 ${opaquePct.toFixed(0)}% —— 背景可能被烘进去了。`
      + '检查 AE 里背景层是不是没关，或者渲染时通道选了 RGB 而不是 RGB+Alpha')
  }
  if (touchesEdge) {
    problems.push('内容顶到画布边缘 —— 要么被裁掉了，要么特效本来就该这么大（确认一下）')
  }

  return {
    file: basename(path), w, h,
    hasAlpha: hasAlphaChannel(readFileSync(path)),
    transparentPct, opaquePct, bbox, touchesEdge, blank, problems,
  }
}

// ================================================================ 主流程

const target = resolve(process.argv[2] ?? 'content/fx')
const asJson = process.argv.includes('--json')

const dir = statSync(target).isDirectory() ? target : resolve(target, '..')
const files = readdirSync(dir).filter(f => f.toLowerCase().endsWith('.png')).sort()

if (files.length === 0) {
  console.error(`✗ ${dir} 里没有 PNG`)
  process.exit(1)
}

const reports = files.map(f => check(join(dir, f)))

// ---- 帧序列层面的检查 ----

const blanks = reports.filter(r => r.blank)
const sizes = new Set(reports.map(r => `${r.w}×${r.h}`))
const alphas = new Set(reports.map(r => r.hasAlpha))

// 内容包围盒的并集：所有帧的最大范围
const boxes = reports.map(r => r.bbox).filter((b): b is [number, number, number, number] => b !== null)
const union = boxes.length === 0 ? null : [
  Math.min(...boxes.map(b => b[0])), Math.min(...boxes.map(b => b[1])),
  Math.max(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3])),
] as [number, number, number, number]

const seqProblems: string[] = []
if (sizes.size > 1) seqProblems.push(`各帧尺寸不一致：${[...sizes].join(' / ')}`)
if (alphas.size > 1) seqProblems.push('有的帧有 alpha 通道、有的没有')
if (blanks.length > 0) {
  const list = blanks.map(b => b.file).join(', ')
  seqProblems.push(`有 ${blanks.length} 张空帧（${list}）—— 播起来会先愣一下`)
}

if (asJson) {
  console.log(JSON.stringify({ dir, frames: reports.length, union, reports }, null, 2))
  process.exit(0)
}

// ---- 打印 ----

console.log('')
console.log(`素材检查  ·  ${dir}`)
console.log('─'.repeat(72))
console.log(`  ${reports.length} 帧  ·  ${[...sizes].join(' / ')}  ·  ${
  [...alphas].every(Boolean) ? '带 alpha' : [...alphas].some(Boolean) ? '⚠ alpha 不一致' : '无 alpha（黑底）'}`)
if (union !== null) {
  const [x0, y0, x1, y1] = union
  console.log(`  所有帧的内容范围  x ${x0}~${x1}   y ${y0}~${y1}`)
  const w = reports[0]?.w ?? 1
  const h = reports[0]?.h ?? 1
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const offX = cx - (w - 1) / 2
  const offY = cy - (h - 1) / 2
  console.log(`  内容中心  (${cx.toFixed(1)}, ${cy.toFixed(1)})   画布中心  (${((w - 1) / 2).toFixed(1)}, ${((h - 1) / 2).toFixed(1)})`
    + (Math.abs(offX) > 4 || Math.abs(offY) > 4
      ? `   ⚠ 偏了 (${offX.toFixed(0)}, ${offY.toFixed(0)}) 像素`
      : '   ✓ 居中'))
}
console.log(`  完全透明的像素  平均 ${(reports.reduce((s, r) => s + r.transparentPct, 0) / reports.length).toFixed(1)}%`)
console.log(`  完全不透明的像素 平均 ${(reports.reduce((s, r) => s + r.opaquePct, 0) / reports.length).toFixed(1)}%`)

console.log('')
const allProblems: string[] = []
for (const p of seqProblems) allProblems.push(`[序列] ${p}`)
const perFrame = reports.filter(r => r.problems.length > 0)
for (const r of reports.slice(0, 3)) {
  for (const p of r.problems) allProblems.push(`[${r.file}] ${p}`)
}
if (perFrame.length > 3) {
  allProblems.push(`[其他 ${perFrame.length - 3} 帧] 有同样的问题（先看上面三条）`)
}

if (allProblems.length === 0) {
  console.log('  ✓ 没查出问题')
} else {
  console.log('  发现的问题：')
  for (const p of allProblems) console.log(`    ! ${p}`)
}

console.log('')
process.exit(allProblems.length > 0 ? 1 : 0)
