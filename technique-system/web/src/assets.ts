/**
 * 资源：**把作者做好的序列帧加载进来**。
 *
 * ## 为什么现在才有这个文件
 *
 * 在这之前，客户端只会画几何图形 —— 没有任何加载图片的能力。
 * 也就是说：**你在 AE 里做的东西，游戏根本读不了。**
 * 这个文件就是那段路。
 *
 * ## 它只管"加载"，不管"长什么样"
 *
 * 定义、命名规则、播放时序都在 `fx.ts` 里（纯数据，能离线测）。
 * 这个文件碰 `fetch` 和 `new Image()`，所以只有浏览器能跑 ——
 * 把这两类东西分开，是为了让 `frameUrl` 这种最容易拼错的地方**能被测试盯住**。
 *
 * ## 一条特效长什么样
 *
 * `content/fx/<名字>.json`：
 *
 * ```jsonc
 * {
 *   "id": "fx.magic-bolt-hit",
 *   "dir": "magic-bolt-hit",       // 帧文件在 content/fx/magic-bolt-hit/ 里
 *   "prefix": "magic-bolt-hit_",   // 文件名前缀
 *   "pad": 5,                      // 帧号补零到几位
 *   "start": 0,                    // 第一帧的编号（AE 默认从 0 开始！）
 *   "frames": 12,
 *   "fps": 60,
 *   "pxPerMeter": 128,             // 你做的时候按多少像素一米画的
 *   "meters": 2,                   // 它在世界里该占多宽
 *   "anchor": [0.5, 0.5],          // 贴图上的锚点（0..1）
 *   "blend": "add"                 // 发光类用 add
 * }
 * ```
 *
 * ⚠ `pxPerMeter` 和 `meters` 是**两个不同的东西**，别混：
 *   前者是"你做图时的比例"，后者是"它在游戏里多大"。
 *   分开之后，想把特效改大一倍只需要动 `meters`，不用重做图。
 *
 * ## 描错的路径不会白屏
 *
 * 任何一个特效加载失败都只记一条问题、继续加载其余的 ——
 * 这是 lava-armor 那次 404 白屏换来的教训。
 */
import { frameUrl } from './fx.ts'
import type { FxAsset, FxDef, Frame } from './fx.ts'

export type { FxAsset, FxDef, Frame } from './fx.ts'
export { frameUrl } from './fx.ts'

export interface FxLoadResult {
  assets: Map<string, FxAsset>
  problems: string[]
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json() as T
}

/** 加载一张图。失败就拒绝 —— 调用方决定是记一笔还是中断 */
export function loadImage(url: string): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img as unknown as Frame)
    img.onerror = () => reject(new Error(`读不到图片：${url}`))
    img.src = url
  })
}

/**
 * 读一个特效定义 + 它的每一帧。
 *
 * 帧可以并行加载（浏览器会排队），但**任何一帧失败整条特效就作废** ——
 * 少一帧的序列播出来会跳，比不播更难看。
 */
export async function loadFx(name: string): Promise<FxAsset> {
  const def = await fetchJson<FxDef>(`/content/fx/${name}.json`)

  if (def.kind !== undefined && def.kind !== 'flipbook') {
    throw new Error(`还不认识这种特效类型：${def.kind}`)
  }
  if (!Number.isInteger(def.frames) || def.frames <= 0) {
    throw new Error(`frames 必须是正整数，实际是 ${String(def.frames)}`)
  }
  if (!(def.fps > 0)) throw new Error(`fps 必须大于 0，实际是 ${String(def.fps)}`)
  if (!(def.pxPerMeter > 0)) throw new Error('pxPerMeter 必须大于 0')

  const frames = await Promise.all(
    Array.from({ length: def.frames }, (_, i) => loadImage(frameUrl(def, i))),
  )

  return {
    def,
    frames,
    frameTime: 1 / def.fps,
    duration: def.frames / def.fps,
  }
}

/** 按清单读全部特效。**单个失败不中断其余的** */
export async function loadFxLibrary(names: string[]): Promise<FxLoadResult> {
  const assets = new Map<string, FxAsset>()
  const problems: string[] = []

  for (const name of names) {
    try {
      const asset = await loadFx(name)
      assets.set(asset.def.id, asset)
    } catch (e) {
      problems.push(`content/fx/${name}.json —— ${String(e)}`)
    }
  }

  return { assets, problems }
}
