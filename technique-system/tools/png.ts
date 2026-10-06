/**
 * 一个最小的 PNG 编码器。
 *
 * 为什么手写：项目里没有任何图像依赖（只有 typescript 和 @types/node），
 * 而我们需要把渲染结果写成 PNG 看一眼。PNG 的无损格式本身不复杂 ——
 * IHDR + zlib 压过的 IDAT + IEND，够了。
 *
 * 真彩（8 位 RGB），无滤波、无透明度 —— 我们画的东西都是不透明的，
 * 需要"加法发光"的地方在**渲染时**叠加，而不是靠 alpha 通道。
 */
import { deflateSync, inflateSync } from 'node:zlib'

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

/** 一张 RGB 图（浮点也行，会被钳到 0..255） */
export interface RgbImage {
  w: number
  h: number
  buf: Float32Array | Uint8Array
}

export function encodePng(img: RgbImage): Uint8Array {
  const { w, h, buf } = img

  // 每行前面加一个滤波字节（0 = 不滤波）
  const raw = new Uint8Array(h * (w * 3 + 1))
  for (let y = 0; y < h; y++) {
    const rowStart = y * (w * 3 + 1)
    raw[rowStart] = 0
    for (let x = 0; x < w * 3; x++) {
      raw[rowStart + 1 + x] = Math.max(0, Math.min(255, Math.round(buf[y * w * 3 + x] ?? 0)))
    }
  }

  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, w)
  view.setUint32(4, h)
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

// ============================================================================
//  解码
// ============================================================================

/** 解出来的一张 RGBA 图 */
export interface RgbaImage {
  w: number
  h: number
  /** RGBA，每像素 4 字节 */
  rgba: Uint8Array
}

/**
 * 一个够用的 PNG 解码器：8 位、真彩或真彩+alpha、非隔行。
 *
 * 为什么手写：项目里没有图像依赖，而我们需要**逐像素看素材**
 * （背景透不透明、有没有被裁）和**把素材合成到场景里预览**。
 *
 * ⚠ 它不解隔行、不解 16 位、不解调色板 —— AE 的默认导出不碰这些，
 *   遇到不支持的会**明确抛错**，不会静默解错。
 */
export function decodePng(buf: Uint8Array): RgbaImage {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (view.getUint32(0) !== 0x89504e47) throw new Error('不是 PNG')

  let at = 8
  let w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0
  const idat: Uint8Array[] = []

  while (at + 8 <= buf.length) {
    const len = view.getUint32(at)
    const type = String.fromCharCode(buf[at + 4] ?? 0, buf[at + 5] ?? 0, buf[at + 6] ?? 0, buf[at + 7] ?? 0)
    const data = buf.subarray(at + 8, at + 8 + len)

    if (type === 'IHDR') {
      w = view.getUint32(at + 8)
      h = view.getUint32(at + 12)
      bitDepth = data[8] ?? 0
      colorType = data[9] ?? 0
      interlace = data[12] ?? 0
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    at += 12 + len
  }

  if (bitDepth !== 8) throw new Error(`只支持 8 位，实际 ${bitDepth} 位`)
  if (interlace !== 0) throw new Error('不支持隔行 PNG')
  if (colorType !== 2 && colorType !== 6) {
    throw new Error(`只支持真彩（2）和真彩+alpha（6），实际 colorType=${colorType}`)
  }

  const srcCh = colorType === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat.map(d => Buffer.from(d))))
  const stride = w * srcCh
  const out = new Uint8Array(w * h * 4)
  const line = new Uint8Array(stride)
  const prev = new Uint8Array(stride)

  let p = 0
  for (let y = 0; y < h; y++) {
    const filter = raw[p++] ?? 0
    for (let i = 0; i < stride; i++) {
      const x = raw[p + i] ?? 0
      const a = i >= srcCh ? (line[i - srcCh] ?? 0) : 0
      const b = prev[i] ?? 0
      const c = i >= srcCh ? (prev[i - srcCh] ?? 0) : 0

      let v: number
      switch (filter) {
        case 0: v = x; break
        case 1: v = x + a; break
        case 2: v = x + b; break
        case 3: v = x + ((a + b) >> 1); break
        case 4: {
          const pp = a + b - c
          const pa = Math.abs(pp - a)
          const pb = Math.abs(pp - b)
          const pc = Math.abs(pp - c)
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default: throw new Error(`不认识的滤波器 ${filter}`)
      }
      line[i] = v & 0xff
    }
    p += stride

    for (let x = 0; x < w; x++) {
      const s = x * srcCh
      const d = (y * w + x) * 4
      out[d] = line[s] ?? 0
      out[d + 1] = line[s + 1] ?? 0
      out[d + 2] = line[s + 2] ?? 0
      out[d + 3] = srcCh === 4 ? (line[s + 3] ?? 0) : 255
    }
    prev.set(line)
  }

  return { w, h, rgba: out }
}
