/**
 * 技能页（第一片）的**纯逻辑**：标签表、四档时长、死旋钮判定、数值叶子归属。
 *
 * ## 为什么单独一个文件
 *
 * `web/src/editor.ts` 是 DOM 层（拼 html + 接事件），没法在 Node 里点。
 * 但这一片真正的规矩（"四档是哪四档"、"什么算死旋钮"、"哪个数值属于哪一组"）
 * 都是**纯函数**，而它们恰恰是最容易错、错了又看不出来的地方。
 *
 * ⚠⚠ 所以这个文件**不许碰 DOM**：`tests/editor.ts` 会直接 import 它，
 *   而那个测试走的是根 `tsconfig.json` —— **故意没有 DOM 类型**
 *   （引擎那侧是 headless 的，"类型层面拿不到 window/document" 是一道额外栅栏，
 *   理由和 `ui/dom.ts` 开头那段一样）。
 *
 * ## 这一片解掉的两个铁律
 *
 * 1. **时长控件是四档选择，不是线性滑块**（用户 2026-09-21 定死的形状）：
 *    无 / 1× / 3× / 9×，`1×` 是"默认"（账上恒 0），`3×`/`9×` 相对**这个技能自己的**
 *    出厂时长，而 `-1`（蓄力哨兵）是**单独一档**，绝不和「无」合并。
 *    见 `tierChoices()`。
 * 2. **死滑块铁律**：任何控件拖了账上不动就不合格。账走 `lookupTable` 的
 *    **绝对取值 → 整数点** 格子，所以"这一格在账上是活的吗"是可判的：
 *    整行同值 = 死的（校验器 `LOOKUP_DEAD_KNOB`）、整行不存在 = 不参与账。
 *    见 `knobState()` / `knobReason()`。
 */
import type { DeliveryKind, Skill, SkillForm, TargetingMode } from '../../src/schema.ts'
import type { Path } from './leaves.ts'

// ============================================================================
//  一、形态（Skill.form）—— 今天界面上完全没有，这一片要露出来
// ============================================================================

/**
 * 形态 → 人话。
 *
 * ⚠ 界面上**只读**：形态是"这次释放要不要一条时间轴"的**机制事实**
 *   （`passive` 的技能没有时间轴、`charged` 的技能时间轴里必有一段 `duration: -1`），
 *   让它可点会让"形态"和"阶段"两份数据打架 —— 而打架的两份数据里
 *   一定有一份是**静默**错的。要改形态 = 改阶段（加一段蓄力 / 去掉时间轴）。
 */
export const FORM_LABEL: Readonly<Record<SkillForm, string>> = {
  instant: '瞬发',
  charged: '蓄力',
  sustained: '持续',
  passive: '常驻',
}

/** 不写就是瞬发（`Skill.form` 的默认值，schema 里定的） */
export function formOf(skill: Pick<Skill, 'form'>): SkillForm {
  return skill.form ?? 'instant'
}

/** 这个形态**为什么**是它 —— 写给人看的那一句 */
export function formWhy(form: SkillForm): string {
  switch (form) {
    case 'charged': return '时间轴里有一段由玩家按住键控制的时长（那一段的时长是 −1）'
    case 'sustained': return '时间轴一直挂着，直到输入说"结束"'
    case 'passive': return '没有时间轴 —— 装上就生效，靠事件或每 tick 起作用'
    default: return '时间轴跑完就结束（不写形态的技能都是它）'
  }
}

/**
 * 用户 2026-09-30 点名要写在界面上的那一句。
 *
 * ⚠ 它**不是**给"常驻"的免责声明，是给玩家的账目说明：常驻省掉的是键位，
 *   **不是**能量和冷却。
 */
export const PERMANENT_NOTE = '常驻不占键位，但每次触发照样付能量和冷却'

// ============================================================================
//  二、瞄准（Skill.targeting）—— 三组控件里的第一组
// ============================================================================

/** 怎么选中人。⚠ 这是**枚举**，不是点表里的数值（见下面 `UNPRICED_NOTE`） */
export const AIM_MODES: readonly { value: TargetingMode; label: string; tip: string }[] = [
  { value: 'directional', label: '鼠标方向', tip: '朝鼠标那一边打（不写瞄准时的默认）' },
  { value: 'locked', label: '锁定目标', tip: '打当前锁定的那个人' },
  { value: 'auto', label: '自动选最近的', tip: '自己挑最近的有效目标' },
  { value: 'areapoint', label: '点地面', tip: '落点由鼠标位置决定（火墙那类）' },
  { value: 'self', label: '自己', tip: '不看意图，直接作用在自己身上' },
]

export function aimModeLabel(mode: string | undefined): string {
  return AIM_MODES.find(m => m.value === mode)?.label ?? '（没写 · 按鼠标方向）'
}

/**
 * `valid` 里的两个保留字 + 两种通用。
 *
 * ⚠ 词表来自引擎（`src/sim/targeting.ts` 的 `VALID_*`），**不是这里发明的**：
 *   其余字符串一律当**实体标签**匹配（boss / undead / construct …）。
 */
export const RESERVED_VALID: readonly { value: string; label: string }[] = [
  { value: 'self', label: '自己' },
  { value: 'ally', label: '友方' },
  { value: 'enemy', label: '敌方' },
  { value: 'any', label: '任意' },
]

/** 保留字 → 中文；别的字符串就是标签本身 */
export function validLabel(v: string): string {
  return RESERVED_VALID.find(x => x.value === v)?.label ?? v
}

// ============================================================================
//  三、载体（Action.delivery）—— 三组控件里的第二组
// ============================================================================

/** 载体：效果怎么送出去（8 种 + "没有载体"） */
export const CARRIERS: readonly { value: DeliveryKind | ''; label: string; tip: string }[] = [
  { value: '', label: '没有载体', tip: '直接落在选中的目标身上（今天 53 个动作里有 37 个是它）' },
  { value: 'self', label: '自己', tip: '直接作用于自己' },
  { value: 'projectile', label: '投射物', tip: '飞行实体，途中碰撞' },
  { value: 'beam', label: '光束', tip: '瞬时或持续的直线' },
  { value: 'meleeArc', label: '近身扇形', tip: '挥砍那类' },
  { value: 'capsule', label: '窄长直线', tip: '突刺那类' },
  { value: 'area', label: '固定区域', tip: '留在空间里（火墙、地火）' },
  { value: 'aura', label: '跟随光环', tip: '挂在施法者身上跟着走' },
  { value: 'spawn', label: '造一个实体', tip: '图腾、召唤物' },
]

export function carrierLabel(kind: string | undefined): string {
  if (kind === undefined || kind === '') return '没有载体'
  return CARRIERS.find(c => c.value === kind)?.label ?? kind
}

/**
 * 载体的**形状参数** → 人话。
 *
 * ⚠ 这几个才是这一组里**真的进账**的旋钮（`lookupTable` 里有
 *   `…delivery.radius` / `angle` / `length` / `width` / `speed` / `lifetime`
 *   这些变量），所以它们仍然是可拖的点表控件 —— 只是被搬到了这一组。
 */
export const DELIVERY_SHAPE_LABEL: Readonly<Record<string, string>> = {
  radius: '半径',
  angle: '张角',
  length: '长度',
  width: '宽度',
  speed: '速度',
  lifetime: '存在时长',
}

// ============================================================================
//  四、宿主（Action.target / Action.valid / PipelineHook.side）—— 第三组
// ============================================================================

/** 这条动作**作用在谁身上** */
export const HOST_TARGETS: readonly { value: 'hit' | 'self'; label: string; tip: string }[] = [
  { value: 'hit', label: '这次命中里"对面那个"', tip: '不写就是它：被打侧的钩子 → 打人的人（反伤）；打人侧的钩子 → 被打的人' },
  { value: 'self', label: '宿主自己', tip: '吸血、给自己挂无敌' },
]

/**
 * ⚠ `Action.target` 在内容里**出现过不是字符串的东西**（`lava-armor.json` 的 r3
 *   写成了一个 `{mode, valid}` 对象）—— 那是内容里的脏数据（别的片在管 `content/**`）。
 *   这里只负责**不把它读成"自己"**：认不出来就如实说认不出来。
 */
export function hostTargetLabel(t: unknown): string {
  if (t === undefined || t === null) return '不写 · 按"对面那个"'
  if (typeof t === 'string') return HOST_TARGETS.find(x => x.value === t)?.label ?? `⚠ 认不出的取值「${t}」`
  return '⚠ 这里写的不是一个合法取值（是个对象）—— 内容里的脏数据，引擎按"对面那个"处理'
}

/** 规则（管线钩子）**听谁的** */
export const HOOK_SIDES: readonly { value: 'target' | 'source' | 'any'; label: string; tip: string }[] = [
  { value: 'target', label: '宿主被打时', tip: '不写就是它：护盾、龟壳、名刀、反伤、亡灵反转' },
  { value: 'source', label: '宿主打人时', tip: '吸血、增伤' },
  { value: 'any', label: '两边都算', tip: '少用 —— 反伤写它会在自己打人时也触发' },
]

export function hookSideLabel(s: string | undefined): string {
  if (s === undefined) return '不写 · 宿主被打时'
  return HOOK_SIDES.find(x => x.value === s)?.label ?? s
}

// ============================================================================
//  五、四档时长（阶段：无 / 1× / 3× / 9×，外加单独的蓄力）
// ============================================================================

/** 四档 = **倍数**，相对**这个技能自己的**出厂时长（定义在 `tierTables.phaseDurationPoints`） */
export const TIER_STEPS: readonly number[] = [0, 1, 3, 9]

export function tierLabel(tier: number): string {
  return tier === 0 ? '无' : tier < 0 ? '蓄力' : `${tier}×`
}

/**
 * 乘完之后的秒数。
 *
 * ⚠ 必须**收敛浮点**：`0.1 × 3 = 0.30000000000000004`，而点表的键是 `"0.3"`
 *   ⇒ 不收的话"3× 档查不到格"，而那会表现成"这一档在账上是死的"（静默错）。
 *   查表那边同样容错（`tierOf` 用 1e-6 相对误差），这里取 1e-10 让两边对得上。
 */
export function tierSeconds(factory: number, tier: number): number {
  if (tier === 0) return 0
  if (tier < 0) return -1
  return Number((factory * tier).toFixed(10))
}

/** 四档里的一档 */
export interface TierChoice {
  /** 倍数；`-1` = 蓄力哨兵、`0` = 无 */
  tier: number
  label: string
  /** 选它之后写进 `phases.N.duration` 的秒数 */
  seconds: number
  /** `1×` —— 中性档，标签上要写「默认」 */
  neutral: boolean
  /** 账上（`lookupTable`）有这一格吗。**没有 ⇒ 不给点**（死滑块铁律） */
  available: boolean
}

/**
 * 这个阶段的四档（+ 蓄力那一档）。
 *
 * ⚠⚠ **蓄力（−1）永远单独一档，不和「无」（0 秒）合并**：
 *   数据上是两个不同的数，机制上更是两件事 ——
 *   `-1` = "时长由玩家按住键控制"（价走 `chargePhasePerPoint` 一笔定额），
 *   `0` = "这一段没有时长"（引擎按瞬发处理）。
 *   合并成一个"取消"的话，玩家想要"按住才放"会得到"瞬发"，而且没有任何地方会报错。
 *
 * ⚠ `available` 由调用方给的判据决定（**账上有没有这一格**）。
 *   今天出厂内容里 `9×` 一格都没有、`无` 只有 3 处有 —— 那些档**置灰不给点**，
 *   这正是"死滑块铁律"要的结果：能动的必须真的动账。
 */
export function tierChoices(factory: number, hasCell: (seconds: number) => boolean): TierChoice[] {
  const out: TierChoice[] = []
  for (const tier of TIER_STEPS) {
    const seconds = tierSeconds(factory, tier)
    out.push({ tier, label: tierLabel(tier), seconds, neutral: tier === 1, available: hasCell(seconds) })
  }
  out.push({ tier: -1, label: tierLabel(-1), seconds: -1, neutral: false, available: hasCell(-1) })
  return out
}

// ============================================================================
//  六、死旋钮（用户 2026-09-30 的铁律）
// ============================================================================

/** 账上这一行格子（`lookupTable[技能id][变量]`） */
export type LookupCells = Readonly<Record<string, number>>

/**
 * 这一格旋钮在账上是活的吗。
 *
 *   · `live`     —— 整行**不是**同一个值 ⇒ 拖它账会动 ✓ 给拖
 *   · `dead`     —— 整行同值（通常是整行 0）⇒ **拖了账不动** ✗ 不给拖
 *                   （校验器那一侧报 `LOOKUP_DEAD_KNOB`；出厂内容里有 93 个）
 *   · `unpriced` —— 表里根本没有这个变量 ⇒ 它**不参与账** ✗ 不给拖
 *
 * ⚠ 这个判据是**唯一**的：界面不许自己猜"这个看起来该计价"。
 *   猜错的症状是"玩家拖了半天，账上纹丝不动"——那正是这条铁律要杀的。
 */
export function knobState(cells: LookupCells | undefined): 'live' | 'dead' | 'unpriced' {
  if (cells === undefined) return 'unpriced'
  const vals = Object.values(cells)
  if (vals.length === 0) return 'unpriced'
  return vals.some(v => v !== vals[0]) ? 'live' : 'dead'
}

/** 这一行里"选这个取值"值多少点（没有这一格 → `undefined`，**不许当 0**） */
export function cellOf(cells: LookupCells | undefined, value: number): number | undefined {
  if (cells === undefined) return undefined
  return cells[String(value)]
}

/** 为什么不给拖 —— 界面上要**说出原因**（静默置灰会被读成"坏了"） */
export function knobReason(state: 'live' | 'dead' | 'unpriced'): string {
  if (state === 'dead') {
    return '账上这一项整行同值（校验器报 LOOKUP_DEAD_KNOB）—— 拖它点数不动，所以不给拖'
  }
  if (state === 'unpriced') {
    return '账上没有这一项（lookupTable 里没有这条变量）—— 它不进点数，所以不给拖'
  }
  return ''
}

/**
 * 这一组的控件**整组都不进账**时写在组头上的那一句。
 *
 * ⚠ 用户定的口径里，瞄准 / 载体种类 / 宿主这些**枚举**今天在 `lookupTable` 里
 *   一个变量都没有（表里只有数值叶子和 `@冷却时机` / `@打断等级.N` / `@占用施法者.N`）。
 *   静默地什么都不说的话，玩家会以为"选敌方"是免费的或花了钱的 —— 两者都是猜。
 */
export const UNPRICED_NOTE = '⚠ 这一组今天不进点数账（lookupTable 里没有这些变量）—— 选它不花点数、也不赚点数'

// ============================================================================
//  七、数值叶子归到哪一组（三组控件 + 剩下的）
// ============================================================================

/** 三组 + 剩下的那堆（伤害、代价、状态时长……照旧按原来的组排） */
export type LeafZone = 'aim' | 'carrier' | 'host' | 'rest'

/**
 * 一个数值叶子属于哪一组。
 *
 * ⚠ `targeting.*` 今天**没有**数值叶子（`collectLeaves` 不收 `targeting.range`，
 *   `lookupTable` 里也没有它）⇒ `aim` 这一支是个**未来口子**，
 *   现在只会命中"哪天有人给瞄准加了点表数值"。写出来是为了让归属规则**只有一处**。
 */
export function leafZone(path: Path): LeafZone {
  const s = path.join('.')
  if (s === 'targeting.range' || s.startsWith('targeting.')) return 'aim'
  if (s.startsWith('delivery.') || s.includes('.delivery.')) return 'carrier'
  return 'rest'
}

/** 载体形状参数（`…delivery.radius` 这种）—— 这一组里真的进账的那些 */
export function isDeliveryShapeLeaf(path: Path): boolean {
  const last = String(path[path.length - 1] ?? '')
  return leafZone(path) === 'carrier' && Object.prototype.hasOwnProperty.call(DELIVERY_SHAPE_LABEL, last)
}

/** 阶段时长（四档控件接管的那些，别在通用滑块列表里再出现一次） */
export function isPhaseDurationLeaf(path: Path): boolean {
  return path.length === 3 && path[0] === 'phases' && path[2] === 'duration'
}

/** 冷却（技能唯一的属性，它有自己的控件 —— 见 `coolDownTiming`） */
export function isCooldownLeaf(path: Path): boolean {
  return path[path.length - 1] === 'cooldown'
}
