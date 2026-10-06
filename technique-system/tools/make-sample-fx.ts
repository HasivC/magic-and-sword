/**
 * 生成一条**示例序列帧特效** —— 只为证明管线通，等着被真素材替换。
 *
 * ## 它是什么
 *
 * 把程序化的刀光烘焙成 24 张 PNG，写进 `content/fx/slash/`，
 * 再配一个 `content/fx/slash.json`。
 *
 * 于是"作者做的序列帧"这条路**今天就能跑通**：
 *   加载 → 解析定义 → 播帧 → 画到屏幕上
 * 等到你在 AE 里做出真东西，把 `content/fx/slash/` 里的 PNG 换掉就行，
 * **JSON 和代码一行都不用动**。
 *
 * ⚠ 这是占位素材，不是最终效果。它长什么样不重要，
 *   重要的是它验证了：命名、帧数、比例、锚点、混合模式这几件事的约定是对的。
 *
 * 用法：
 *   node tools/make-sample-fx.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { allPrims, spawnDelivery, updateDelivery } from '../web/src/fx.ts'
import type { DeliveryEvent } from '../web/src/fx.ts'
import { encodePng } from './png.ts'
import { makeImage, raster } from './raster.ts'

// ---- 这条示例特效的规格（会被写进 JSON，也是给你做素材时的参考值）----

const NAME = 'slash'
const ID = 'fx.slash'
const FRAMES = 24
const FPS = 60
const PX_PER_METER = 64
/*
 * ⚠ 画布必须装得下**整个**特效。
 *
 *    扇形的原点在施法者身上（锚点 = 画布中心），半径 2.5 米，
 *    所以画布至少得 5 米见方 —— 第一版写了 3.6 米，刀光被切掉了一半。
 *    留 0.5 米余量给火星和光晕。
 */
const METERS = 6
const SIZE = Math.round(PX_PER_METER * METERS)   // 384
const W = SIZE
const H = SIZE

const EVENT: DeliveryEvent = {
  kind: 'meleeArc',
  // 中心放在画面正中：锚点就是中心，也就是施法者站的地方
  from: { x: METERS / 2, y: METERS / 2 },
  dir: { x: 1, y: 0 },
  radius: 2.5,
  angle: 120,
  hitCount: 1,
  damageType: 'physical',
}

const OUT_DIR = resolve('content/fx', NAME)
mkdirSync(OUT_DIR, { recursive: true })

const view = { scale: PX_PER_METER, ox: 0, oy: 0 }

// 整条特效在 0.4 秒里播完 —— 和程序化版本的 life 对齐，观感才一致
const TOTAL = 0.4

for (let i = 0; i < FRAMES; i++) {
  // 第 i 帧对应哪一刻
  const target = (i / FRAMES) * TOTAL

  const fx = spawnDelivery(EVENT)
  // 程序化版本的 life 只有 0.26s，这里拉长到 0.4s 播完
  fx.life = TOTAL
  while (fx.age < target) {
    updateDelivery(fx, 1 / 600)
    if (fx.age >= fx.life) break
  }

  const img = makeImage(W, H)
  raster(img, allPrims(fx), view)

  const n = String(i + 1).padStart(4, '0')
  writeFileSync(resolve(OUT_DIR, `${NAME}_${n}.png`), encodePng(img))
}

const def = {
  schemaVersion: 1,
  id: ID,
  name: '刀光（示例占位）',
  _comment: '这是 tools/make-sample-fx.ts 生成的**占位素材**。把 content/fx/slash/ 里的 PNG 换成你在 AE 里做的，这个文件不用改。规格见 docs/fx-authoring.md',
  kind: 'flipbook',
  dir: NAME,
  prefix: `${NAME}_`,
  pad: 4,
  ext: 'png',
  frames: FRAMES,
  fps: FPS,
  pxPerMeter: PX_PER_METER,
  meters: METERS,
  anchor: [0.5, 0.5],
  offset: [0, 0],
  rotate: 'none',
  blend: 'add',
} as const

writeFileSync(resolve('content/fx', `${NAME}.json`), JSON.stringify(def, null, 2) + '\n', 'utf8')

console.log('')
console.log(`示例序列帧特效  ·  ${ID}`)
console.log('─'.repeat(60))
console.log(`  ${FRAMES} 帧  ·  ${FPS}fps  ·  ${(FRAMES / FPS).toFixed(3)}s  ·  ${W}×${H}px`)
console.log(`  画布 ${METERS} 米见方，${PX_PER_METER} px/米`)
console.log(`  写到 content/fx/${NAME}/  +  content/fx/${NAME}.json`)
console.log('')
console.log('  ⚠ 占位素材。换成你自己的图时，JSON 和代码都不用动。')
console.log('')
