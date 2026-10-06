/**
 * 载体特效。
 *
 * ## 为什么单开一个文件
 *
 * 表现层以前只有**一个方向**：命中之后冒粒子（`damaged` 事件）。
 * 但"打出去那一下长什么样"完全没人管 —— 八种载体里有五种是无形的，
 * 六个用了载体的技能里五个看不见。**挥砍、光束、范围爆发全是隐形的。**
 *
 * ## 数据从哪来
 *
 * 模拟核现在会推一条 `deliveryFired` 事件，带**几何**：
 * 起点、方向、长度、宽度、半径、张角、打中了几个、伤害类型。
 *
 * ⚠ 那是几何，不是渲染指令 —— 和 `damaged` 带一个 `amount` 是同一类东西。
 *   客户端一个字都不用猜，也就不存在"两份真相"。
 *
 * ⚠ 打空了也会发（`hitCount: 0`）。**打空是最需要看得见的时刻** ——
 *   以前空放一个技能，屏幕上什么都没有。
 *
 * ## 上色：按技能的类型
 *
 * 一张表按 `damageType` 分派（物理 / 火焰 / 冰霜 / 闪电 / 奥术 / 暗影 / 神圣 / 毒素）。
 * 每种类型给的不只是颜色，还有**性格**：
 *   物理 = 锐利短促、白芯冷边、火星直；火焰 = 跳动、暖、火星多；
 *   暗影 = 闷、拖尾长；奥术 = 通透、星点。
 *
 * 加一种伤害类型 = 在表里加一行。**不用改任何绘制代码。**
 */
import type { DeliveryKind } from '../../src/schema.ts'

/** 二维向量。表现层自己定一个 —— `Vec2` 是模拟核的内部类型，不该反向依赖它 */
export interface Vec2 { x: number; y: number }

// ============================================================================
//  风格表
// ============================================================================

export interface FxStyle {
  /** 芯：最亮的那一层 */
  core: string
  /** 边：拖尾和外缘 */
  edge: string
  /** 火星 */
  spark: string
  /** 辉光层数 —— 同一条弧画几遍，越宽越暗（加法混合叠出来的假辉光） */
  glowLayers: number
  /** 火星数量 */
  sparkCount: number
  /** 火星飞得多快（米/秒） */
  sparkSpeed: number
  /** 手感，写在文档和调试里用 */
  feel: string
}

const STYLES: Record<string, FxStyle> = {
  physical: {
    core: '#ffffff', edge: '#6fd8ff', spark: '#eaf7ff',
    glowLayers: 4, sparkCount: 18, sparkSpeed: 11, feel: '锐利、短促、直来直去',
  },
  fire: {
    core: '#fff6d0', edge: '#ff6a12', spark: '#ffc247',
    glowLayers: 4, sparkCount: 26, sparkSpeed: 9, feel: '跳动、暖、火星往上飘',
  },
  ice: {
    core: '#f2fdff', edge: '#39a9ff', spark: '#c9ecff',
    glowLayers: 4, sparkCount: 16, sparkSpeed: 7, feel: '冷、脆、碎屑',
  },
  lightning: {
    core: '#ffffff', edge: '#ffd93d', spark: '#fff9c4',
    glowLayers: 5, sparkCount: 22, sparkSpeed: 16, feel: '闪、快、分叉',
  },
  arcane: {
    core: '#eafaff', edge: '#8b5cff', spark: '#b98cff',
    glowLayers: 4, sparkCount: 20, sparkSpeed: 9, feel: '通透、星点、慢慢散',
  },
  shadow: {
    core: '#e9d5ff', edge: '#6d28d9', spark: '#c084fc',
    glowLayers: 4, sparkCount: 20, sparkSpeed: 6, feel: '闷、拖尾长、吸光',
  },
  holy: {
    core: '#fffdf0', edge: '#ffc400', spark: '#fff3a8',
    glowLayers: 5, sparkCount: 24, sparkSpeed: 7, feel: '亮、稳、往外扩',
  },
  poison: {
    core: '#efffd6', edge: '#65a30d', spark: '#bef264',
    glowLayers: 3, sparkCount: 16, sparkSpeed: 5, feel: '黏、沉、往下滴',
  },
}

/** 没写 damageType 时用这个（中性） */
export const DEFAULT_STYLE: FxStyle = {
  core: '#ffffff', edge: '#c9d1d9', spark: '#e6edf3',
  glowLayers: 3, sparkCount: 12, sparkSpeed: 8, feel: '中性',
}

/** 按伤害类型取风格。不认识的类型退回中性 —— 内容永远不该因为缺一行颜色就画不出来 */
export function pickStyle(damageType: string | undefined): FxStyle {
  if (damageType === undefined) return DEFAULT_STYLE
  return STYLES[damageType] ?? DEFAULT_STYLE
}

// ============================================================================
//  状态光环的风格
// ============================================================================
//
// ⚠ 状态以前**完全没有视觉表现** —— `StatusDef.vfx` 声明了、出厂内容里
//   15 处写了它，但（a）没人读那个字段，（b）就算读了也**没有素材**
//   （`fx.sunder` 这些名字一条 PNG 都没有）。
//
//   所以这里做的是**按标签上色**的兜底：不管有没有素材，
//   "谁身上有什么"都得看得出来。有素材的时候再叠一条序列帧上去。
//
//   这就是既有的那条分工：**素材是加分项，程序化是保底**。

export interface StatusStyle {
  /** 环的主色 */
  ring: string
  /** 内芯辉光（淡一层） */
  glow: string
  /**
   * 要不要在里面糊一层淡盘。
   *
   * ⚠ 这是个**显式的开关**，不是从 `feel` 那段人话里猜出来的。
   *   第一版我写的是 `feel.startsWith('金色')` —— 拿给人看的文案当判断依据，
   *   改一个字就会静默改变画面。文案是文案，行为是行为。
   */
  heavy: boolean
  /** 手感说明，写在文档和调试里用（**不参与任何判断**） */
  feel: string
}

/**
 * 按标签取色。
 *
 * ⚠ 这是一张**有序**表，不是字典 —— 顺序就是优先级。
 *   一个"冻结"同时带 hardCC 和 debuff、一个"护盾"同时带 buff 和 shield，
 *   谁先匹配决定它长什么样。**控制类必须排在 buff/debuff 前面**：
 *   "被冻住了"是玩家最需要一眼看见的信息，不该被"这是个 debuff"盖掉。
 */
const STATUS_STYLES: { tag: string; style: StatusStyle }[] = [
  { tag: 'hardCC', style: { ring: '#7dd3fc', glow: '#e0f2fe', heavy: true, feel: '冰壳 —— 动不了' } },
  { tag: 'softCC', style: { ring: '#a5b4fc', glow: '#e0e7ff', heavy: false, feel: '迟滞 —— 动得慢' } },
  { tag: 'shield', style: { ring: '#fcd34d', glow: '#fef3c7', heavy: true, feel: '金色护罩 —— 有池子' } },
  { tag: 'dot', style: { ring: '#84cc16', glow: '#ecfccb', heavy: false, feel: '持续伤害 —— 会跳字' } },
  { tag: 'curse', style: { ring: '#c084fc', glow: '#f3e8ff', heavy: false, feel: '诅咒 —— 紫、阴' } },
  { tag: 'debuff', style: { ring: '#f87171', glow: '#fee2e2', heavy: false, feel: '负面 —— 红' } },
  { tag: 'buff', style: { ring: '#4ade80', glow: '#dcfce7', heavy: false, feel: '正面 —— 绿' } },
]

/** 一个标签都不认识时用这个 */
export const DEFAULT_STATUS_STYLE: StatusStyle = {
  ring: '#c9d1d9', glow: '#e6edf3', heavy: false, feel: '中性',
}

export function pickStatusStyle(tags: readonly string[]): StatusStyle {
  for (const s of STATUS_STYLES) {
    if (tags.includes(s.tag)) return s.style
  }
  return DEFAULT_STATUS_STYLE
}

/**
 * 一个状态光环的半径（米）。
 *
 * ⚠ 按"这是第几个状态"往外错开一圈，不然同时挂三个状态时三圈完全重合，
 *   看起来只有一个。这和召唤物摆位是同一个道理。
 */
export function statusRingRadius(index: number, entityRadius: number): number {
  return entityRadius + 0.22 + index * 0.14
}

/**
 * 一个状态的光环图元。**纯函数**，不碰 canvas。
 *
 * 画法：一圈细环 + 一圈很淡的内盘。
 * 内盘用 `disc` 加低 alpha，加法混合之后就是"这个人身上有东西"的观感。
 */
export function statusPrims(
  x: number,
  y: number,
  index: number,
  entityRadius: number,
  style: StatusStyle,
  /** 0..1，用来做呼吸感。不写就不呼吸 */
  pulse = 1,
): Prim[] {
  const r = statusRingRadius(index, entityRadius)
  const w = 0.055 + 0.02 * pulse
  const out: Prim[] = [
    { op: 'arc', x, y, r, a0: 0, a1: 360, width: w, color: style.ring, alpha: 0.55 + 0.25 * pulse },
  ]
  // 内盘只在比较"重"的状态上画 —— 每个状态都糊一层会把画面弄脏
  if (style.heavy) {
    out.push({ op: 'disc', x, y, r: r - w * 0.5, color: style.glow, alpha: 0.10 })
  }
  return out
}

/** 表里都有哪些类型（测试用：内容里出现的类型必须都在表里） */
export function knownTypes(): string[] {
  return Object.keys(STYLES)
}

// ============================================================================
//  生命周期
// ============================================================================

/** 每种载体的存活时长（秒）。**不是模拟时间，只是画面上的存在时间** */
const LIVES: Record<DeliveryKind, number> = {
  self: 0.2,
  projectile: 0.2,   // 投射物是实体，不发 deliveryFired，这个值只是兜底
  meleeArc: 0.26,
  beam: 0.18,
  capsule: 0.2,
  area: 0.42,
  aura: 0.5,
  spawn: 0.3,
}

export interface Spark {
  x: number
  y: number
  vx: number
  vy: number
  size: number
  life: number
  age: number
}

export interface DeliveryFx {
  kind: DeliveryKind
  from: Vec2
  dir: Vec2
  /** 米 */
  length: number
  width: number
  radius: number
  /** **弧度**（事件里是度，这里已经换算过） */
  angle: number
  style: FxStyle
  hitCount: number
  age: number
  life: number
  sparks: Spark[]
}

/** `deliveryFired` 事件里那段几何（刻意不 import sim 的类型，免得表现层反向依赖模拟层） */
export interface DeliveryEvent {
  kind: DeliveryKind
  from: Vec2
  dir: Vec2
  length?: number
  width?: number
  radius?: number
  angle?: number
  hitCount: number
  damageType?: string
}

const DEG = Math.PI / 180

/**
 * 没写宽度时给一个合理的「厚度」。
 *
 * ⚠ 扇形的 `width` 不是"打击范围"，是**刀有多厚** —— 它只影响画面，
 *   判定用的是 `radius` + `angle`。
 *   第一版让扇形吃了 0.5 米的默认宽度，画出来是一条两米厚的白板。
 */
function defaultWidth(kind: DeliveryKind, radius: number): number {
  if (kind === 'meleeArc') return Math.max(0.1, Math.min(0.3, radius * 0.07))
  return 0.5
}

/**
 * 造一条特效。
 *
 * 几何的缺省值是**和模拟核一致的**（`targeting.ts` 里 beam 缺省 5 米、扇形缺省…），
 * 所以这里也填同样的兜底 —— 不然"没写 length 的光束"会在判定上打 5 米、
 * 在画面上打 1 米。
 */
export function spawnDelivery(ev: DeliveryEvent): DeliveryFx {
  const style = pickStyle(ev.damageType)
  const life = LIVES[ev.kind] ?? 0.25

  const fx: DeliveryFx = {
    kind: ev.kind,
    from: { x: ev.from.x, y: ev.from.y },
    dir: { x: ev.dir.x, y: ev.dir.y },
    length: ev.length ?? (ev.kind === 'beam' || ev.kind === 'capsule' ? 5 : 2),
    width: ev.width ?? defaultWidth(ev.kind, ev.radius ?? 2),
    radius: ev.radius ?? (ev.kind === 'area' || ev.kind === 'aura' ? 2 : 2),
    angle: (ev.angle ?? 90) * DEG,
    style,
    hitCount: ev.hitCount,
    age: 0,
    life,
    sparks: [],
  }

  fx.sparks = makeSparks(fx)
  return fx
}

/**
 * 火星。
 *
 * 扇形：沿弧线撒一排，往外飞（挥砍的感觉来自"火星是**散开**的"）。
 * 光束 / 突刺：沿线的两侧撒，往垂直方向飞。
 * 范围：从中心往外炸。
 */
function makeSparks(fx: DeliveryFx): Spark[] {
  const out: Spark[] = []
  const n = fx.style.sparkCount
  const base = Math.atan2(fx.dir.y, fx.dir.x)
  const speed = fx.style.sparkSpeed

  for (let i = 0; i < n; i++) {
    // 用下标做伪随机，不用 Math.random —— 同一发技能每次长得一样，
    // 这样"手感变了"一定是代码或数值变了，不是运气
    const h1 = frac(Math.sin(i * 12.9898) * 43758.5453)
    const h2 = frac(Math.sin(i * 78.233) * 12345.6789)

    let a = base
    let r = fx.radius
    let v = speed

    if (fx.kind === 'meleeArc') {
      /*
       * 火星要**贴着刀锋**跑 —— 散在整个扇形里就变成灰尘了。
       *
       * 所以：角度压在前沿往后 60% 的那一段里，半径贴外缘，
       * 速度方向是"切向甩出去"（法向 + 一点切向），才像被削下来的碎屑。
       */
      const back = fx.angle * 0.6
      a = base - back + back * (i / Math.max(1, n - 1))
      r = fx.radius * (0.88 + h1 * 0.16)
      v = speed * (0.5 + h2 * 1.0)
    } else if (fx.kind === 'area' || fx.kind === 'aura') {
      a = (i / n) * Math.PI * 2
      r = fx.radius * (0.3 + h1 * 0.6)
      v = speed * (0.5 + h2)
    } else {
      // 线状：沿长度铺开，往两侧飞
      const along = r * 0 + fx.length * (i / Math.max(1, n)) * (fx.kind === 'beam' ? 1 : 0.6)
      const side = (h1 < 0.5 ? -1 : 1) * (fx.width * 0.5)
      const px = fx.from.x + Math.cos(base) * along - Math.sin(base) * side
      const py = fx.from.y + Math.sin(base) * along + Math.cos(base) * side
      const spread = (h1 - 0.5) * 1.1
      out.push({
        x: px, y: py,
        vx: Math.cos(base + spread) * v + Math.cos(base) * 2,
        vy: Math.sin(base + spread) * v + Math.sin(base) * 2,
        size: 0.06 + h2 * 0.08,
        life: fx.life * (0.5 + h2 * 0.6),
        age: 0,
      })
      continue
    }

    out.push({
      x: fx.from.x + Math.cos(a) * r,
      y: fx.from.y + Math.sin(a) * r,
      // 切向甩出去：法向 + 一点切向，看起来是"被削下来的"
      vx: Math.cos(a) * v * 0.75 - Math.sin(a) * v * 0.45,
      vy: Math.sin(a) * v * 0.75 + Math.cos(a) * v * 0.45,
      size: 0.07 + h1 * 0.09,
      life: fx.life * (0.6 + h2 * 0.7),
      age: 0,
    })
  }
  return out
}

function frac(v: number): number {
  return v - Math.floor(v)
}

/** 推进一帧。用**真实时间**，不是模拟时间 —— 顿帧的时候特效要继续走 */
export function updateDelivery(fx: DeliveryFx, dt: number): boolean {
  fx.age += dt
  for (const s of fx.sparks) {
    s.age += dt
    s.x += s.vx * dt
    s.y += s.vy * dt
    // 阻力：火星飞出去要慢下来，不然像射线不像火星
    s.vx *= 0.90
    s.vy *= 0.90
  }
  return fx.age < fx.life
}

// ============================================================================
//  绘制
// ============================================================================

/**
 * 画布上下文 —— **只列出我们用到的那些方法**。
 *
 * ⚠ 为什么不直接用 `CanvasRenderingContext2D`：
 *   那会把整个 DOM 类型拖进来，于是这个文件在 Node 里 import 不了，
 *   也就没法测（`tests/fx.ts` 直接 import 它），
 *   更没法在命令行里把它画成 PNG 看一眼（`tools/preview-fx.ts`）。
 *   表现层的模块只该依赖"我用到的那几个方法"，不该依赖浏览器。
 *
 * `fillStyle` / `strokeStyle` 写成 `unknown` 是为了兼容真实 ctx 的类型
 * （它是 `string | CanvasGradient | CanvasPattern`），我们只往里写字符串。
 */
export interface DrawCtx {
  globalAlpha: number
  globalCompositeOperation: string
  fillStyle: unknown
  strokeStyle: unknown
  lineWidth: number
  lineCap: string
  save(): void
  restore(): void
  beginPath(): void
  closePath(): void
  fill(): void
  stroke(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  arc(x: number, y: number, radius: number, a0: number, a1: number, ccw?: boolean): void
  translate(x: number, y: number): void
  rotate(radians: number): void
  /** 画一张序列帧。`image` 由调用方塞进来 —— fx.ts 不许依赖 DOM */
  drawImage(image: unknown, x: number, y: number, w: number, h: number): void
}

/**
 * 一个绘制**图元**。
 *
 * ## 为什么要把"画什么"和"怎么画"分开
 *
 * 原来 `drawMeleeArc` 直接调 canvas API。那有个实际问题：
 * **只有浏览器能看见它** —— 我在命令行里没法把它画出来看一眼，
 * 于是"这道刀光好不好看"只能等你反馈，迭代一轮要好几分钟。
 *
 * 拆开之后：
 *
 *   `deliveryPrims(fx)`   纯函数，吐出图元列表 —— **能测，也能离线光栅化**
 *   `drawPrims(ctx, …)`   把图元交给 canvas（浏览器里跑的就是这一份）
 *   `tools/preview-fx.ts` 用**同一份图元**在命令行里渲染成 PNG，不用开浏览器
 *
 * 只有一份几何真相，两个消费者。
 */
export type Prim =
  /** 从中心往外的一块扇形 */
  | { op: 'wedge'; x: number; y: number; r: number; a0: number; a1: number; color: string; alpha: number }
  /**
   * 一段**环带扇区**（内半径 r0 到外半径 r1 之间的一块）。
   *
   * ⚠ 挥砍的拖尾必须是环带，不能是从圆心铺开的楔形 ——
   *   楔形画出来像一把折扇，而且中心会糊成一团白。
   *   刀光是**一条带子扫过去**，中心是空的。
   */
  | { op: 'annulus'; x: number; y: number; r0: number; r1: number; a0: number; a1: number; color: string; alpha: number }
  /** 一段弧线（有粗细） */
  | { op: 'arc'; x: number; y: number; r: number; a0: number; a1: number; width: number; color: string; alpha: number }
  /** 一条线段 */
  | { op: 'line'; x0: number; y0: number; x1: number; y1: number; width: number; color: string; alpha: number }
  /** 实心圆 */
  | { op: 'disc'; x: number; y: number; r: number; color: string; alpha: number }

/** 剩余的亮度（0..1）。前段亮，后段快速衰减 */
function fade(fx: DeliveryFx): number {
  const p = Math.min(1, fx.age / fx.life)
  return Math.max(0, 1 - p * p)
}

/** 挥砍在前 38% 的时间里扫完，剩下的是余韵 */
const SWEEP_FRACTION = 0.38
/** 前沿亮弧占整段张角的比例 */
const EDGE_SPAN = 0.34

/**
 * 一条特效 → 图元列表。**纯函数**，不碰 canvas。
 *
 * 所有图层都是**加法混合**（`lighter`），所以"艳丽"来自叠加而不是单层高亮。
 */
export function deliveryPrims(fx: DeliveryFx): Prim[] {
  const a = fade(fx)
  if (a <= 0) return []

  switch (fx.kind) {
    case 'meleeArc': return meleeArcPrims(fx, a)
    case 'beam':
    case 'capsule': return beamPrims(fx, a)
    case 'area':
    case 'aura': return areaPrims(fx, a)
    default: return pulsePrims(fx, a)
  }
}

function meleeArcPrims(fx: DeliveryFx, a: number): Prim[] {
  const out: Prim[] = []
  const base = Math.atan2(fx.dir.y, fx.dir.x)
  const half = fx.angle / 2
  const a0 = base - half
  const sweep = Math.min(1, fx.age / (fx.life * SWEEP_FRACTION))
  const a1 = a0 + fx.angle * sweep

  const blade = fx.width
  const rIn = fx.radius * 0.42
  const rOut = fx.radius
  const rBlade = rOut * 0.96

  /*
   * 1. 拖尾：**环带**，而且越靠前越亮。
   *
   *    做法是把扫过的那段角切成若干小片，每片一个 alpha ——
   *    这样不用渐变 API（Canvas 的扇形填充本来也不支持角度渐变）就能出"余韵"。
   *
   * ⚠ 片数不能少：第一版 7 片，画出来是一条一条的百叶窗。
   *   24 片 + 幂曲线，相邻两片的差就看不出来了。
   */
  const SEGS = 24
  const span = a1 - a0
  for (let i = 0; i < SEGS; i++) {
    const t0 = a0 + (span * i) / SEGS
    const t1 = a0 + (span * (i + 1)) / SEGS
    const w = (i + 1) / SEGS          // 0（最旧）→ 1（前沿）
    out.push({
      // ⚠ 拖尾**始终用边色**，不用芯色 —— 白色叠出来是一块灰板。
      //   "白"要留给刀身那一笔，不然整片都是白的、没有层次。
      op: 'annulus', x: fx.from.x, y: fx.from.y, r0: rIn, r1: rOut, a0: t0, a1: t1,
      color: fx.style.edge,
      alpha: a * (0.04 + 0.50 * Math.pow(w, 1.6)),
    })
  }

  /*
   * 1b. 外缘的一条**热边**：整条拖尾最亮的地方在"刀走过的那一圈"上。
   *     没有这一层的话，扇形是一整片均匀的蓝，看不出刀锋的轨迹。
   */
  for (let i = 0; i < SEGS; i++) {
    const t0 = a0 + (span * i) / SEGS
    const t1 = a0 + (span * (i + 1)) / SEGS
    const w = (i + 1) / SEGS
    out.push({
      op: 'annulus', x: fx.from.x, y: fx.from.y, r0: rOut * 0.86, r1: rOut, a0: t0, a1: t1,
      color: w > 0.85 ? fx.style.core : fx.style.edge,
      alpha: a * 0.32 * Math.pow(w, 2.2),
    })
  }

  // 2. 刀身：外缘那一条最亮的细弧 —— 这一笔才是「刀」
  const e0 = Math.max(a0, a1 - EDGE_SPAN)

  /*
   * ⚠ 辉光必须**和刀身同心**（都在 rBlade 上），不能画在内外半径的正中间。
   *   第一版画在 mid 上，结果刀身外侧一条白线、内侧一条灰板，看起来像块木板。
   */
  for (let i = 0; i < fx.style.glowLayers; i++) {
    const k = i / Math.max(1, fx.style.glowLayers - 1)   // 0 → 1
    out.push({
      op: 'arc', x: fx.from.x, y: fx.from.y, r: rBlade, a0: e0, a1,
      width: blade * (3.0 - k * 1.7),
      color: i === fx.style.glowLayers - 1 ? fx.style.core : fx.style.edge,
      alpha: a * (0.10 + k * k * 0.42),
    })
  }

  out.push({
    op: 'arc', x: fx.from.x, y: fx.from.y, r: rBlade, a0: e0, a1,
    width: blade * 0.5, color: fx.style.core, alpha: a * 0.95,
  })

  // 3. 刀尖：前沿停住的地方点一颗亮的，眼睛会跟着它走
  const tipX = fx.from.x + Math.cos(a1) * rBlade
  const tipY = fx.from.y + Math.sin(a1) * rBlade
  out.push({ op: 'disc', x: tipX, y: tipY, r: blade * 0.85, color: fx.style.edge, alpha: a * 0.35 })
  out.push({ op: 'disc', x: tipX, y: tipY, r: blade * 0.4, color: fx.style.core, alpha: a * 0.9 })

  /*
   * 4. 冲击波：**跟在刀锋后面**的一串短弧，越往后越淡越往外。
   *
   * ⚠ 不能画成一整条从 a0 到 a1 的弧 —— 那会在画面上留一个灰色的大月牙，
   *   看起来像一刀砍出了一个铁环（第一版就是这样）。
   *   冲击波应该是"刀走过去之后留下的涟漪"，所以是**碎成几段、逐段衰减**。
   */
  const shock = 1 + (1 - a) * 0.20
  const WAVES = 6
  const waveSpan = Math.min(a1 - e0, span * 0.55)
  for (let i = 0; i < WAVES; i++) {
    const q0 = a1 - (waveSpan * (i + 1)) / WAVES
    const q1 = a1 - (waveSpan * i) / WAVES
    const w = 1 - i / WAVES
    if (q1 <= e0) break
    out.push({
      op: 'arc', x: fx.from.x, y: fx.from.y, r: rBlade * shock, a0: Math.max(e0, q0), a1: q1,
      width: blade * 0.7, color: fx.style.edge, alpha: a * a * 0.30 * w,
    })
  }

  // 5. 命中反馈：打中了才在前沿补一小段更亮的，让"这一下打到了"有分量
  if (fx.hitCount > 0) {
    out.push({
      op: 'arc', x: fx.from.x, y: fx.from.y, r: rOut, a0: e0, a1,
      width: blade * 0.35, color: fx.style.core, alpha: a * 0.5,
    })
  }

  return out
}

function beamPrims(fx: DeliveryFx, a: number): Prim[] {
  const out: Prim[] = []
  const base = Math.atan2(fx.dir.y, fx.dir.x)
  const ux = Math.cos(base)
  const uy = Math.sin(base)

  for (let i = 0; i < fx.style.glowLayers; i++) {
    const k = i / Math.max(1, fx.style.glowLayers - 1)
    out.push({
      op: 'line',
      x0: fx.from.x, y0: fx.from.y,
      x1: fx.from.x + ux * fx.length, y1: fx.from.y + uy * fx.length,
      width: fx.width * (5.0 - k * 4.0),
      color: i === fx.style.glowLayers - 1 ? fx.style.core : fx.style.edge,
      alpha: a * (0.10 + k * k * 0.8),
    })
  }
  return out
}

function areaPrims(fx: DeliveryFx, a: number): Prim[] {
  const p = 1 - a   // 0 → 1 扩散
  const r = fx.radius * (0.25 + p * 0.95)
  return [
    { op: 'disc', x: fx.from.x, y: fx.from.y, r, color: fx.style.edge, alpha: a * 0.16 },
    { op: 'arc', x: fx.from.x, y: fx.from.y, r, a0: 0, a1: Math.PI * 2,
      width: fx.width * 0.5, color: fx.style.core, alpha: a * 0.85 },
  ]
}

/** 兜底：一个短促的光环。**保证任何载体都不会是隐形的** */
function pulsePrims(fx: DeliveryFx, a: number): Prim[] {
  return [{
    op: 'arc', x: fx.from.x, y: fx.from.y, r: fx.radius * (1.2 - a * 0.2), a0: 0, a1: Math.PI * 2,
    width: fx.width * 0.4, color: fx.style.core, alpha: a * 0.7,
  }]
}

/** 火星：画成短条，看起来才是"飞出去的"而不是"一堆点" */
export function sparkPrims(fx: DeliveryFx): Prim[] {
  const out: Prim[] = []
  for (const s of fx.sparks) {
    const k = 1 - s.age / s.life
    if (k <= 0) continue
    out.push({
      op: 'line',
      x0: s.x, y0: s.y,
      x1: s.x + s.vx * 0.03, y1: s.y + s.vy * 0.03,
      width: s.size * k, color: fx.style.spark, alpha: k,
    })
  }
  return out
}

/** 一条特效的**全部**图元（本体 + 火星），按画序 */
export function allPrims(fx: DeliveryFx): Prim[] {
  return [...deliveryPrims(fx), ...sparkPrims(fx)]
}

/**
 * 把图元交给 canvas。**世界坐标**（调用方已经把 ctx 变换成"米"了）。
 *
 * 不用 `shadowBlur` 做辉光 —— 它在缩放过的 transform 下各浏览器表现不一致，
 * 所以辉光是"同一形状画几遍"叠出来的（见上面）。
 */
export function drawPrims(ctx: DrawCtx, prims: Prim[]): void {
  if (prims.length === 0) return

  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.lineCap = 'round'

  for (const p of prims) {
    ctx.globalAlpha = Math.max(0, Math.min(1, p.alpha))
    ctx.fillStyle = p.color
    ctx.strokeStyle = p.color

    switch (p.op) {
      case 'wedge':
        ctx.beginPath()
        ctx.moveTo(p.x, p.y)
        ctx.arc(p.x, p.y, p.r, p.a0, p.a1)
        ctx.closePath()
        ctx.fill()
        break

      case 'disc':
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fill()
        break

      case 'annulus':
        // 环带 = 外弧顺着走一圈 + 内弧倒着走回来（Canvas 没有环带填充）
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r1, p.a0, p.a1)
        ctx.arc(p.x, p.y, p.r0, p.a1, p.a0, true)
        ctx.closePath()
        ctx.fill()
        break

      case 'arc':
        ctx.lineWidth = p.width
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, p.a0, p.a1)
        ctx.stroke()
        break

      case 'line':
        ctx.lineWidth = p.width
        ctx.beginPath()
        ctx.moveTo(p.x0, p.y0)
        ctx.lineTo(p.x1, p.y1)
        ctx.stroke()
        break
    }
  }

  ctx.restore()
}

/** 画一条特效（本体 + 火星） */
export function drawDelivery(ctx: DrawCtx, fx: DeliveryFx): void {
  drawPrims(ctx, allPrims(fx))
}

// ============================================================================
//  序列帧特效（作者用 AE 之类做的，见 docs/fx-authoring.md）
// ============================================================================

/** 一张加载好的图。只用到宽高，所以不依赖 DOM 类型 */
export interface Frame {
  readonly width: number
  readonly height: number
}

/**
 * 一条作者做的序列帧特效的**定义**（`content/fx/<名字>.json`）。
 *
 * ⚠ 它住在这个文件里，不在 `assets.ts` 里 —— 因为**定义和命名是纯数据**，
 *   可以离线测；而 `assets.ts` 要 `new Image()`、要 fetch，
 *   那是碰浏览器的代码，Node 里跑不了。
 *   分开之后 `frameUrl` 这种"最容易拼错"的东西才能被测试盯住。
 */
export interface FxDef {
  schemaVersion: number
  id: string
  name?: string
  kind?: 'flipbook'
  /** 帧文件所在子目录（相对 content/fx/） */
  dir: string
  prefix: string
  pad: number
  /**
   * 第一帧的编号。
   *
   * ⚠ AE 默认从 **0** 开始（`00000.png`），也有的从 1 开始。
   *   假设错了就是整条特效 404 —— 而报错只说"读不到图片"，
   *   看不出是编号起点的问题。所以它是数据，不是猜的。
   */
  start?: number
  ext?: string
  frames: number
  fps: number
  pxPerMeter: number
  meters: number
  anchor?: [number, number]
  offset?: [number, number]
  rotate?: 'none' | 'facing'
  blend?: 'add' | 'normal'
}

/** 一叠加载好的帧 */
export interface FxAsset {
  def: FxDef
  frames: readonly Frame[]
  /** 一帧占多少秒 */
  frameTime: number
  /** 整条特效多久（秒） */
  duration: number
}

/**
 * 帧号 → 文件路径。`slash_0001.png` / `magic-bolt-hit_00000.png`
 *
 * ⚠ 起点是 `start`（默认 1），因为 AE 默认从 0 开始编号 ——
 *   这一位写错，整条特效全是 404。
 */
export function frameUrl(def: FxDef, index: number): string {
  const start = def.start ?? 1
  const n = String(start + index).padStart(def.pad, '0')
  const ext = def.ext ?? 'png'
  return `/content/fx/${def.dir}/${def.prefix}${n}.${ext}`
}

/**
 * 一叠序列帧的一次播放。
 *
 * ⚠ 这是**两条特效路线的第二条**：
 *   程序化（上面那一整套图元）—— 零资产，参数化，适合"一个形状换个颜色"
 *   序列帧（这里）      —— 作者做的，长得完全由你决定，适合主角技能
 *   同一个技能可以先用序列帧，没有就用程序化兜底。**不是二选一。**
 */
export interface SpriteFx {
  kind: 'sprite'
  /** 帧图。类型故意留宽 —— fx.ts 不许依赖 DOM，真正的图片由调用方塞进来 */
  frames: readonly SpriteFrame[]
  /** 一帧多少秒 */
  frameTime: number
  age: number
  /** 世界坐标（米） */
  x: number
  y: number
  /** 朝向（弧度）。`rotate: 'none'` 时是 0 */
  rot: number
  /** 画出来在世界里占多宽（米） */
  meters: number
  /** 锚点（0..1），决定贴图哪一点对齐到 (x, y) */
  anchorX: number
  anchorY: number
  blend: 'add' | 'normal'
  /** 播完之后自动倒放一遍（有些特效这样收尾更好看） */
  pingPong: boolean
}

export interface SpriteFrame {
  readonly width: number
  readonly height: number
}

/**
 * 一个播放周期有多少**帧步**。
 *
 * ⚠ 来回播是 `2n - 2` 不是 `2n` —— 峰值和起点各只出现一次
 *   （0,1,…,n-1,n-2,…,1）。`spriteDone` 和 `spriteFrameIndex`
 *   必须用同一个数，不然会出现"画面已经停在最后一帧、特效却还没被回收"
 *   或者反过来"播到一半就被删掉"。这个不一致是测试抓到的。
 */
function spriteSteps(fx: SpriteFx): number {
  const n = fx.frames.length
  if (n === 0) return 0
  return fx.pingPong ? Math.max(1, n * 2 - 2) : n
}

/** `SpriteFx` 播完了吗 */
export function spriteDone(fx: SpriteFx): boolean {
  return fx.age >= spriteSteps(fx) * fx.frameTime
}

/** 现在该画第几帧 */
export function spriteFrameIndex(fx: SpriteFx): number {
  const n = fx.frames.length
  if (n === 0) return 0
  const raw = Math.floor(fx.age / fx.frameTime)
  if (!fx.pingPong) return Math.min(n - 1, raw)

  const period = spriteSteps(fx)
  const k = period <= 0 ? 0 : raw % period
  return k < n ? k : period - k
}

/** 推进一帧序列帧特效 */
export function updateSprite(fx: SpriteFx, dt: number): boolean {
  fx.age += dt
  return !spriteDone(fx)
}

/** 画一叠序列帧。**世界坐标**（调用方已经把 ctx 变换成"米"了） */
export function drawSprite(ctx: DrawCtx, fx: SpriteFx): void {
  const frame = fx.frames[spriteFrameIndex(fx)]
  if (frame === undefined || frame.width <= 0) return

  const w = fx.meters
  const h = w * (frame.height / frame.width)
  // 锚点在贴图上的位置 → 左上角该画在哪
  const left = fx.x - w * fx.anchorX
  const top = fx.y - h * fx.anchorY

  ctx.save()
  ctx.globalCompositeOperation = fx.blend === 'add' ? 'lighter' : 'source-over'
  ctx.globalAlpha = 1

  if (fx.rot === 0) {
    ctx.drawImage(frame, left, top, w, h)
  } else {
    // 绕锚点旋转：先把原点挪到锚点上，转完再挪回去
    ctx.translate(fx.x, fx.y)
    ctx.rotate(fx.rot)
    ctx.drawImage(frame, -w * fx.anchorX, -h * fx.anchorY, w, h)
  }

  ctx.restore()
}