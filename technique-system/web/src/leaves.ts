/**
 * 数值叶子：从**技能** JSON 里抽出所有能调的数字。
 *
 * ⚠ 编辑器编的是技能（阶段 + 规则），不是术式 ——
 *   术式只管"哪几个技能、按什么顺序、绑哪个键"，本身没有可调的数值。
 *
 * 这是编辑器的核心，也是它**不针对任何一种效果写专用表单**的原因 ——
 * 加新效果不用改编辑器，新技能一进来，它的数字自动出现在面板上。
 *
 * ⚠ 标题（`label`）的规矩 —— 玩家 2026-09-21 指着面板说的：
 *   > 也不要有「捅中的人被挑飞出去 · #0 · 值」这种白话，
 *   > 因为这里该写「击飞」，并且「#0值」又是什么？
 *
 *   所以标题必须是 **`时机 · 效果 · 数值名`** 三段，人话：
 *
 *     「命中时 · 击退 · 距离」      ← 好
 *     「捅中的人被挑飞出去 · #0 · 值」  ← 手写的 note + 数组下标 + 没名字的字段
 *
 *   三段的来源分别是：
 *     时机   `whenName(rule.when)` —— 和规则那一行**同一张表**
 *     效果   `effectName(payload)` —— 伤害 / 治疗 / 击退 / 挂状态 / 召唤
 *     数值名 `fieldName(...)`      —— 距离 / 时长 / 伤害 / 能量…
 *
 *   手写的 `note` **不进来**：它是设计意图（"命中的人被挑飞出去"），
 *   不是字段名。把它当标题的结果就是上面那条被玩家点名的问题。
 *
 * 单独一个文件是为了能测：它不碰 DOM，Node 里直接跑。
 */
import type { Payload, Skill } from '../../src/schema.ts'
import { effectName, pipelineStageName, whenName } from '../../src/describe.ts'

export type PathSeg = string | number
export type Path = PathSeg[]

export interface NumLeaf {
  path: Path
  /** 面板上显示的名字，例如「挥砍 · 时长」 */
  label: string
  value: number
  /**
   * 这个数值**允许取哪几个值**。
   *
   * ⚠ 这是一张**点表**，不是一段连续区间。
   *   第一版给的是 `min/max/step` —— 结果是 0~300 的伤害滑块有 300 个取值，
   *   玩家既调不准（拖一格差 1 点，毫无意义），也感受不到"选择"。
   *
   *   现在大部分是三五个取值，最多不超过九个。**每一次拖动都是一次决策。**
   *   出厂内容里的值如果不在表上，会被插进来（见 `valuesFor`）——
   *   否则一打开编辑器就会跳值。
   */
  values: number[]
  /** value 在 values 里的下标 */
  index: number
  /**
   * 当前值不在预设表上，是临时插进来的。
   *
   * 面板要标出来：它意味着"这个技能用的是格子外的数值"，
   * 一旦拖走就再也回不来了。
   */
  offGrid: boolean
  /** 分组：阶段 / 规则 / 代价 / 其他 */
  group: string
  /** 单位（`s` / `m` / `m/s` / `°` …）。空串 = 纯数字 */
  unit: string
  /**
   * 这个值有什么特殊含义。
   *
   * `-1` 在这套 schema 里是**哨兵值**，不是数字：
   * 阶段时长 -1 = 蓄力（由玩家控制），状态时长 -1 = 永久。
   * 点表的第一格就是它，面板上必须写清楚，不然玩家不知道选它会发生什么。
   */
  hint?: string
}

/**
 * 点表：按"这个东西叫什么"决定它能有哪几个取值。
 *
 * 为什么是**手写一张表**而不是自动切分区间：
 * 数值的"手感格子"是不均匀的 —— 伤害 5→10 是一倍，100→105 什么都不是。
 * 自动等分会把 15、16、17 这种毫无意义的档位塞给玩家。
 *
 * 挑格子的原则：
 *   1. **档位之间有可感知的差别**（伤害 10 / 15 / 25 / 30 / 50……）
 *   2. **大部分四到六个**，超过九个就不叫选择了
 *   3. 常用值优先（冷却 3 秒、扇形 120°、能量 10）
 *
 * ⚠ 出厂内容**必须落在格子上**。
 *   落在格子外不是"内容错了"，而是**表错了**：要么少了一格，
 *   要么那个数值本来就不该那么细。tests/editor.ts 会盯着这件事。
 */
/**
 * **血契**的点表。
 *
 * ⚠ 它必须单独一张，而且和别的属性加减法**不是一个量纲**：
 *   通用兜底是 `[-4,-3,0,1]`（"扣 3 点能量"那种小差值），
 *   而血契是一门**货币**，玩家定的量级是"日常在 10 上下，偶尔冲到 100"。
 *   拿兜底表去写，就只能写出"每次危机 +1" —— 攒到 100 要一百次危机。
 *
 * ⚠ 这一条正是这个文件顶上那条原则的例子：
 *   **落在格子外不是内容错了，是表错了。**
 *   （`perStack` 和 `distance` 都是同一条原则补出来的。）
 *
 * 档位是照着玩家给的量级铺的：小额（1/2/3）是日常的涓流，
 * 8/15 是一次成规模的危机，30/60/100 是"一整局攒一发"的终极。
 *
 * ⚠ 它通过 `walk` 的 `override` 机制生效（认的是属性名 `char.bloodPact.current`），
 *   **不是**靠 `semanticKey` 猜 —— 键名只有 `const`，分不出改的是血契还是能量。
 *
 * ⚠ 必须声明在 `VALUE_SETS` **之前**：它被那张表引用，
 *   放后面会撞上 TDZ（`Cannot access before initialization`）。
 */
const BLOOD_PACT_AMOUNTS = [1, 2, 3, 5, 8, 15, 30, 60, 100]

const VALUE_SETS: Record<string, number[]> = {
  // -1 是哨兵值：阶段 = 蓄力（由玩家控制），状态 = 永久
  duration: [-1, 0.1, 0.2, 0.3, 0.5, 1],
  /*
   * ⚠ 15 被剪掉了。
   *
   *   它夹在 10 和 25 中间，而 10→15 是 +50%、15→25 是 +67% ——
   *   两边的差别都比中间这一格大，"选 15"没有清晰的理由。
   *   玩家要的是"每一次拖动都是一次决策"，夹在中间那一格不是决策。
   *
   *   剪格子不等于砍数值：出厂内容里没有任何技能用 15。
   *   `.scratch/grid-audit.mjs` 会把每一档的利用率打出来，照着它剪。
   */
  amount: [10, 25, 30, 50, 200],
  /*
   * ⚠ 扇形的张角剪掉 270（2026-09-21，加屏障那一轮）。
   *
   *   出厂内容里只有 120 在用，而 270 是个"几乎一整圈但缺一角"的角度 ——
   *   它不是一个决策：要打一片就用 180，要打一圈就用 360。
   *   剪掉它正好让点表回到五档（"大部分三五个"那条断言盯着中位数）。
   */
  angle: [45, 90, 120, 180, 360],
  /**
   * 半径：**弹体**用（投射物有多大、挥砍扇形多长）。
   *
   * ⚠ 它和 `areaRadius` 是两张表，因为量纲差一个数量级 ——
   *   弹体 0.5 米是"一根手指粗细"，而 AoE 6 米是"半个屏幕"。
   *   混用一张表的后果：要么弹体能设成 6 米（一个占满场地的火球），
   *   要么 AoE 最大只能 6 米（放不下一个真正的"扫描全场"）。
   *   「洞察」要 12 米的扫描范围时撞上了这条，才拆开。
   */
  radius: [0.5, 1, 2.5, 4, 6],
  /**
   * 半径：**范围 / 光环**用（area / aura 载体）。
   *
   * 参照系：人身位约 0.5 米、场地半径 18 米。
   *   2.5 = 贴身一圈，6 = 一大步，12 = 大半个场地，18 = 整个场地。
   *
   * ⚠ 8 那一格剪掉了：没内容用它，而且它夹在 6 和 12 中间 ——
   *   "6 米还是 12 米"是决策，"6 米还是 8 米"不是。
   *   （加火墙之后点表宽度把中位数顶到 6 档，剪掉它正好回到 5 档。）
   */
  areaRadius: [2.5, 4, 6, 12, 18],
  length: [2, 4, 8, 12, 16],
  width: [0.2, 0.4, 0.6, 0.8, 1.2],
  speed: [4, 8, 12, 16, 24],
  /*
   * ⚠ `lifetime` 这一格为**屏障**换过一次（2026-09-21）：
   *   上面那几个（0.5~3 秒）是"投射物能飞多久"的量级，
   *   而"一堵墙立多久"是另一种量级 —— 3 秒的墙刚竖起来就没了，那不叫屏障。
   *
   *   所以加了 8，同时**剪掉 2**（出厂内容里没人用它）——
   *   点表宽度上限是五档（"大部分三五个"那条断言盯着），不能只是加。
   *
   *   ⚠ 这就是点表跟着内容长的正常过程：要么内容迁就格子，
   *     要么给格子补一档 **并且剪掉一格没人用的**。
   */
  lifetime: [0.5, 1, 1.5, 3, 8],
  /*
   * ⚠ 能量和冷却各剪掉一格没人用的（5 和 1）。
   *
   *   "5 点能量"和"10 点能量"在手感上没有区别 —— 都是"很便宜"，
   *   而"1 秒冷却"等于没有冷却（2 秒才是真正的下限）。
   *   没人用的格子就是白占宽度，玩家每拖一次都要多跨过一格噪音。
   */
  energy: [10, 20, 30, 40],
  cooldown: [2, 3, 8, 20],
  /*
   * ⚠ `hp` 剪掉 15（2026-09-21）：出厂内容一个都没用到它，
   *   而它夹在 10 和 20 中间 —— 和 `areaRadius` 剪掉 8、`amount` 剪掉 15
   *   是同一个理由："10 还是 20"是决策，"15"不是。
   */
  hp: [3, 5, 10, 20, 30],
  every: [0.1, 0.25, 0.5, 1, 2],
  stacks: [1, 2, 3, 5],
  max: [1, 3, 5, 8, 12],
  min: [-5, -2, -1, 0, 1, 5],
  /*
   * 规则位是"条数"，所以每一档都要有 —— **0 到 8**。
   *   0 = 一条规则都不写（合法但没用的配置）
   *   4 = 出厂基准（baseRuleSlots）
   *   8 = 很复杂了
   * 玩家指出来过：下限 3 没有任何道理，而且中间跳档也说不通。
   */
  ruleSlots: [0, 1, 2, 3, 4, 5, 6, 7, 8],
  visibility: [0, 0.5, 1],
  /**
   * 倍率（`op: 'mul'` 的修饰值）。
   *
   * ⚠ 它必须**单独一张表**：倍率的"格子"在 1 附近（×0.9 是削弱 10%），
   *   和加减法的格子（-4 点能量）完全不是一个量纲。
   *   混用的话要么倍率没法调，要么加减法全是 0.1 这种没意义的档。
   *
   * ⚠ ×1 也被剪掉了 —— 它是**空操作**（改了个寂寞）。
   *   滑条上有一格是"什么都不做"，不是选择，是陷阱。
   */
  mul: [0.5, 0.8, 0.9, 1.15],
  /**
   * 吸收池：护盾能挡多少伤害。
   *
   * ⚠ 这张表是**加内容的时候才补上的**。
   *   在它之前 `perStack` 不在任何表里，落到通用兜底 `[-15,-4,-3,0,1]` ——
   *   也就是说**护盾这个机制根本没法在格子上写出来**：
   *   想要 150 点的盾，就只能在格子外插一个值，而 tests/editor.ts 会判定
   *   "出厂内容不在点表上"。
   *
   *   这正是这个文件顶上那条原则说的：落在格子外不是内容错了，是**表错了**。
   */
  perStack: [50, 100, 150, 250, 500],
  /**
   * 次数盾：能挡几次。
   *
   * 和 `perStack` 是**两张表**，因为量纲完全不同 ——
   * 一个是伤害点数，一个是"几次"。次数只有 1 到 3 才有意义。
   */
  perStackHits: [1, 2, 3],
  /**
   * 位移距离（米）。
   *
   * ⚠ 这张表是**做位移技能的时候才补上的**，和 `perStack` 一样：
   *   在那之前 `distance` 不在任何表里，落到通用兜底 `[-15,-4,-3,0,1]` ——
   *   想写"击退 2.5 米"就只能插格子外的值，而 tests/editor.ts 会判定
   *   "出厂内容不在点表上"。
   *
   *   尺度参照：人身位约 0.5 米、挥砍半径 2.5 米、场地半径 18 米。
   *   所以 1~6 米是"推开一步"到"扔出去半场"的范围。
   */
  distance: [1, 1.5, 2, 2.5, 4, 6],
  /**
   * 血契的额度。见上面的 `BLOOD_PACT_AMOUNTS`。
   *
   * 这里放一份引用，是为了让 `labelFor` / `unitFor` 和调试时
   * 能按 `bloodPact` 这个名字找到它。
   */
  bloodPact: BLOOD_PACT_AMOUNTS,
  /** 那些没进表的键（主要是"改某个属性"的加减法、动作的默认值），给一串通用档位兜底 */
  '': [-4, -3, 0, 1],
}

/** 兜底档位 —— 连兜底都不能太多 */
const FALLBACK = VALUE_SETS[''] ?? [0]

/**
 * 状态时长的点表。
 *
 * 它和阶段时长**必须是两张表**：阶段是"零点几秒"的动作节奏，
 * 状态是"几秒到半分钟"的持续时间，共用一张的话两边都不合适。
 * 25 秒那格是名刀·司命的冷却，不许动。
 */
const STATUS_DURATIONS = [-1, 0.5, 1.5, 3, 5, 10, 25]

/**
 * 这个数值能取哪几个值。
 *
 * ⚠ 当前值如果不在表上，**插进去**，不把它改掉。
 *   否则"打开编辑器"这一个动作就会悄悄改内容 —— 玩家什么都没干，
 *   存档里的数字就变了。
 *
 *   但插进来的那一格会在面板上标一个点（`offGrid`）：
 *   它意味着"这个技能用的数值不在格子上"，拖走就回不来了。
 *   tests/editor.ts 会断言**出厂内容的 67 个数值一个都不在格子外**。
 */
function valuesFor(key: string, v: number): { values: number[]; offGrid: boolean } {
  const base = VALUE_SETS[key] ?? FALLBACK
  const offGrid = !base.includes(v)
  const values = offGrid ? [...base, v].sort((a, b) => a - b) : [...base]
  return { values, offGrid }
}

/** 点表要**看上下文**：`duration` 在阶段和状态里是两张不同的表 */
function valuesForPath(sk: string, path: Path, v: number): { values: number[]; offGrid: boolean } {
  if (sk === 'duration' && !path.includes('phases')) {
    const offGrid = !STATUS_DURATIONS.includes(v)
    return {
      values: offGrid ? [...STATUS_DURATIONS, v].sort((a, b) => a - b) : [...STATUS_DURATIONS],
      offGrid,
    }
  }
  return valuesFor(sk, v)
}

/** 这些键下的数字不可编辑：要么是内部字段，要么是算出来的 */
const SKIP_KEYS = new Set([
  'schemaVersion',
  'order',
  /*
   * ⚠ 点数**不在这里**，它在下面 SKIP_SUBTREES 里。
   *
   *   第一版把点数手写在 JSON 上，还给配了滑块 —— 结果玩家拖伤害，
   *   点数纹丝不动，等于可以白嫖。现在点数是内容的函数（src/pricing.ts），
   *   调数值它就自己变，所以它一个滑块都不该有。
   */
  'x', 'y', 'z',   // 位置的三个分量
])

/** 整棵子树都不编辑的键 */
const SKIP_SUBTREES = new Set([
  'targeting',     // 目标选择是枚举，不是数字
  'tags',
  'curve',         // 曲线是数组的数组，先留着不做
  'points',        // 算出来的账，不是编辑出来的
])

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 从路径里往回找一个"语义键"，用来查范围表 */
export function semanticKey(path: Path): string {
  for (let i = path.length - 1; i >= 0; i--) {
    const seg = path[i]
    if (typeof seg !== 'string') continue
    if (VALUE_SETS[seg] !== undefined) return seg
  }
  return ''
}

/** 字段名 → 人话 */
export function labelFor(key: string, parentKey?: string): string {
  const table: Record<string, string> = {
    duration: parentKey === 'phases' ? '时长' : '持续',
    amount: '数值',
    points: '点数',
    energy: '能量',
    cooldown: '冷却',
    hp: '生命',
    radius: '半径',
    angle: '张角',
    length: '长度',
    width: '宽度',
    speed: '速度',
    lifetime: '飞行时间',
    every: '间隔',
    stacks: '层数',
    seconds: '秒数',
    perStack: '吸收量',
    bloodPact: '血契',
    max: '上限',
    min: '下限',
    count: '数量',
    ruleSlots: '规则位上限',
    distance: '距离',
    value: '值',
    const: '值',
  }
  return table[key] ?? key
}

/**
 * 数值名：**这个数字本身是什么**（"距离""时长""伤害"）。
 *
 * ⚠ 它和 `labelFor` 的区别：`labelFor` 只认字段名，所以
 *   `payload.amount.const` / `payload.value.const` 都只能叫「值」——
 *   而「值」什么信息都没有（玩家原话："「#0值」又是什么？"）。
 *
 *   这里多两样上下文：
 *     `payloadKind` —— 这是伤害还是治疗？（决定 amount 该叫"伤害"还是"治疗量"）
 *     `pathStr`     —— 改的是哪条属性？（`char.bloodPact.current` → 血契）
 */
function fieldName(key: string, parentKey: string | undefined, payloadKind: string | undefined, pathStr: string): string {
  /*
   * ⚠ `const` / `value` / `amount` 这三个**先看效果类型**，不能先查通用表。
   *   通用表把它们都翻成「值」—— 而「值」什么信息都没有
   *   （玩家原话："「#0值」又是什么？"）。
   *   先查通用表的话 `const` 会在这一句就被返回，后面那套映射永远走不到。
   */
  if (key === 'const' || key === 'value' || key === 'amount') {
    switch (payloadKind) {
      case 'damage': return '伤害'
      case 'heal': return '治疗量'
      case 'displacement': return '距离'
      case 'perception': return '可见度'
      case 'spawn': return '数量'
      case 'attribute': return attrFieldName(pathStr)
      case 'status': return '状态数值'
      default: return '数值'
    }
  }

  // 其余字段：通用表说清楚了就用它（时长 / 半径 / 速度 / 层数…）
  const generic = labelFor(key, parentKey)
  if (generic !== key) return generic

  return key
}

/** 属性载荷改的是"什么"（用在数值名上） */
function attrFieldName(path: string): string {
  if (path.endsWith('bloodPact.current')) return '血契'
  if (path.endsWith('energy.current')) return '能量'
  if (path.endsWith('hp.current')) return '生命'
  if (path.endsWith('hp.max')) return '生命上限'
  if (path.endsWith('energy.max')) return '能量上限'
  if (path.includes('cooldown')) return '冷却'
  if (path.includes('moveScale')) return '移速倍率'
  if (path.includes('speed')) return '移速'
  if (path.includes('damageTaken')) return '受伤倍率'
  if (path.includes('damageDealt')) return '伤害倍率'
  if (path === 'pipeline.reverse') return '治疗/伤害反转'
  if (path.startsWith('pipeline.')) return '这一下的数值'
  /*
   * ⚠ 兜底**不打路径原文**：`char.foo.bar 0.9` 看着像 bug。
   *   写「某个属性」是明确的"我认不出来" —— 那比假装看懂了强。
   *   （真的要加新属性时，往上面这张表里补一行就行。）
   */
  return '某个属性'
}

/**
 * 数组里的一项**在标题里占哪一段**。
 *
 * ⚠ 这就是原来 `#0` 的来源：数组项认不出来时直接写下标。
 *   下标对写代码的人有用，对玩家是噪声 ——
 *   所以现在改成"认出来才写，认不出来就不占位置"。
 */
function arrayItemName(
  item: unknown,
  index: number,
  count: number,
  phaseNameOf: (id: string | undefined) => string | undefined,
): string | undefined {
  if (!isObj(item)) return count > 1 ? `第 ${index + 1} 项` : undefined

  /*
   * 固有效果 → **它挂在哪个阶段**（"这一下发生在哪一段"）。
   *
   * ⚠ 效果和 `phaseComplete` 规则的叫法必须**一模一样**
   *   （同样返回阶段名），否则同一个数字在"固有效果"组里叫一个名字、
   *   在"规则"组里叫另一个名字，玩家会以为它们是两回事。
   */
  if (typeof item['at'] === 'string') {
    return phaseNameOf(item['at'])
  }

  /*
   * 规则 → **时机**（"命中时" / "未命中时"）。
   * ⚠ 用 `describeWhen` 而不是 `whenName`：前者会把 `phaseId` 换成阶段名，
   *   所以 `phaseComplete` 会变成「命中时」而不是「phaseComplete」——
   *   规则那一行和滑块标题必须**字一模一样**，否则玩家以为不是同一条。
   */
  if (typeof item['when'] === 'string') {
    const when = item['when']
    if (when === 'phaseComplete' || when === 'phaseEnter' || when === 'phaseInterrupt') {
      return phaseNameOf(typeof item['phaseId'] === 'string' ? item['phaseId'] : undefined)
    }
    return whenName(when as never, item['every'] as number | undefined)
  }

  // 动作 → 效果类型（伤害 / 治疗 / 击退 / 挂状态…）
  const payload = item['payload']
  if (isObj(payload) && typeof payload['kind'] === 'string') {
    return effectName(payload as unknown as Payload)
  }

  // 阶段 → 阶段名（内容里现在写的是 前摇 / 命中 / 后摇 这种平实词）
  if (typeof item['duration'] === 'number' && typeof item['name'] === 'string') return item['name']

  // 管线钩子 → 它在哪个阶段生效（"修正阶段"，不是 "modify 阶段"）
  if (typeof item['stage'] === 'string') return `${pipelineStageName(item['stage'])}阶段`

  /*
   * ⚠ 认不出来的**不占位置**（返回 undefined）。
   *   退回 `#0` 的话标题会变成「护盾 · #0 · 吸收量」——
   *   中间那段既不是人话也没有信息，纯噪声。
   */
  void count
  return undefined
}

/**
 * 每个数值带什么单位。
 *
 * ⚠ 单位不是装饰。面板上写着「挥砍 · 时长  0.2」和写着 `0.2 s`，
 *   玩家对它的理解完全不同 —— 前者要猜，后者不用。
 *
 * 距离和速度用**米**：场地半径 18 米、人 1 米左右、挥砍 2.5 米，
 *   这是一个自洽的尺度（跑速 6 米/秒 ≈ 人类短跑）。
 */
const UNITS: Record<string, string> = {
  duration: 's',
  every: 's',
  lifetime: 's',
  cooldown: 's',
  radius: 'm',
  areaRadius: 'm',
  length: 'm',
  width: 'm',
  speed: 'm/s',
  angle: '°',
  energy: '能量',
  hp: '生命',
  amount: '点',
  stacks: '层',
  ruleSlots: '条',
  bloodPact: '血契',
}

/**
 * 这个数值的单位。返回空串表示"它就是个数字"。
 *
 * `duration` 要看上下文：阶段和状态都是秒，一样。
 */
export function unitFor(key: string): string {
  return UNITS[key] ?? ''
}

/**
 * 从属性载荷的路径推出单位。
 *
 * ⚠ 为什么需要它：属性载荷里的数字挂在 `payload.value.const` 上，
 *   路径里没有 `energy` 这种键名，点表只能落到通用兜底 ——
 *   于是面板上写着「额外能量消耗  -15」，没有单位。
 *
 *   玩家提的是"属性设置应该加上 s、m 这样的单位"，指的就是这一类。
 */
function unitFromAttribute(path: string): string {
  if (path.endsWith('energy.current') || path.endsWith('energy.max')) return '能量'
  if (path.endsWith('hp.current') || path.endsWith('hp.max')) return '生命'
  if (path.includes('cooldown')) return 's'
  if (path.includes('regen')) return '/s'
  // 倍率类的（移速、受伤、伤害）本身没有单位，它就是个数
  return ''
}

/**
 * 抽出术式里所有能调的数字。
 *
 * `ctx` 是给滑块起名字用的：走到 `phases[0]` 时记下阶段名，
 * 走到 `rules[2]` 时记下规则备注 —— 这样面板上写的是
 * 「破甲 · 持续」，而不是 `rules[1].then[0].payload.inline.duration`。
 */
/**
 * 一个字段的**点表**（档位列表）。
 *
 * ⚠ 只有"要单独做一个控件"的地方用它（现在只有**冷却**：它是技能唯一的属性，
 *   编辑器里要把它画成"多少秒 + 从哪一段开始算"一行，而不是一个普通滑块）。
 *   别的地方一律走 `collectLeaves` —— 那里的档位是跟着**内容里真实存在的值**
 *   算出来的，不要在这里另开一套。
 */
export function gridOf(key: string): number[] {
  return [...(VALUE_SETS[key] ?? [])]
}

export function collectLeaves(root: Skill): NumLeaf[] {
  const out: NumLeaf[] = []

  /**
   * 阶段 id → 阶段名。
   * ⚠ 阶段在内容里现在叫 前摇 / 命中 / 后摇 这种平实词，
   *   所以标题里直接用它就够清楚了；查不到就退回 id。
   */
  const phaseNameOf = (id: string | undefined): string | undefined => {
    if (id === undefined) return undefined
    return root.phases.find(p => p.id === id)?.name ?? id
  }

  /**
   * `override` 是点表键的**强制覆盖**，只在一种情况下用：
   * `op: 'mul'` 的修饰值要和加减法的值用不同的格子（见 VALUE_SETS.mul）。
   * 它会沿着子树往下传 —— 因为数字在 `modifiers[0].value.const`，
   * 离那个写着 `op: 'mul'` 的对象还有两层。
   */
  const walk = (
    node: unknown,
    path: Path,
    ctx: string[],
    group: string,
    override?: string,
    attrUnit?: string,
    payloadKind?: string,
    /**
     * 属性载荷改的是哪条属性（`char.moveScale` 这种）。
     *
     * ⚠ 必须一路带下来：状态里的修饰符长这样
     *   `inline.modifiers[0].value.const` —— 那个数字是"移速 ×0.5"的 0.5，
     *   而它的 key 只叫 `const`。不带这条路径的话，标题只能写
     *   「挂状态 · 状态数值 0.5」，玩家根本不知道改的是什么。
     */
    attrPath?: string,
  ): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => {
        const name = arrayItemName(item, i, node.length, phaseNameOf)
        // 认不出名字的项**不占标题位置**（见 arrayItemName 的注释）
        const next = name === undefined ? ctx : [...ctx, name.length > 24 ? name.slice(0, 24) + '…' : name]
        // 修饰符（`{path, op, value}`）也算"改属性"，只是没有 kind 字段
        const isModifier = isObj(item) && typeof item['path'] === 'string' && typeof item['op'] === 'string'
        walk(
          item, [...path, i], next, group, override, attrUnit,
          isObj(item) && isObj(item['payload']) && typeof item['payload']['kind'] === 'string'
            ? item['payload']['kind'] as string
            : isModifier ? 'attribute' : payloadKind,
          isModifier ? item['path'] as string : attrPath,
        )
      })
      return
    }

    if (!isObj(node)) return

    // 进到一个倍率修饰里了：它的值用倍率点表
    /*
     * 进到一个倍率修饰里了 → 用倍率点表。
     *
     * ⚠ `mode === 'hits'` 只出现在吸收池上（次数盾），
     *   别的载荷的 mode 是 'lethal' / 'knockback' / 'reveal' 这些，
     *   不会误伤。次数盾的"几次"和护盾的"多少点"量纲不同，必须分表。
     *
     * `kind === 'area' | 'aura'` 是同样的道理：载体的半径和弹体的半径
     * 差一个数量级，必须分表（见 VALUE_SETS 里的注释）。
     * 别的 kind 是载荷类型（'damage' / 'status'…），那些对象底下没有 radius，
     * 所以不会误伤。
     */
    const inner = node['op'] === 'mul' ? 'mul'
      : node['mode'] === 'hits' ? 'perStackHits'
        : node['kind'] === 'area' || node['kind'] === 'aura' ? 'areaRadius'
          /*
           * ⚠ 改**血契**的加减法用自己那盘点表。
           *
           *   为什么要在这里判而不是让 `semanticKey` 去猜：
           *   数字的键名是 `const`，路径是 `...payload.value.const` ——
           *   它分不出"给血契 +3"和"扣 3 点能量"，两者会落到同一张兜底表。
           *   而血契是货币（1/2/3/…/100），属性加减是差值（-4/-3/0/1）——
           *   量纲差一个数量级。
           *
           *   `walk` 本来就有一个 `override` 机制（`mul` 用过），
           *   这个属性载荷对象上有 `path`，直接看它就行。
           */
          : (typeof node['path'] === 'string' && node['kind'] === 'attribute'
            && node['path'].includes('bloodPact') ? 'bloodPact' : override)
    // 进到一个属性载荷里了：它的值从路径推单位；路径本身也是"改的是什么"的答案
    const isAttrPayload = typeof node['path'] === 'string' && node['kind'] === 'attribute'
    const ownAttrPath = isAttrPayload ? node['path'] as string : attrPath
    const unitHint = isAttrPayload ? unitFromAttribute(node['path'] as string) : attrUnit

    for (const [k, v] of Object.entries(node)) {
      if (SKIP_KEYS.has(k) || SKIP_SUBTREES.has(k)) continue

      const np: Path = [...path, k]
      /*
       * 分组：
       *   phases → 阶段（时间轴）
       *   effect → **固有效果**（这个技能是什么）
       *   rules  → 规则（额外做了什么）
       *   cost   → **代价**（单独一组）
       *
       * ⚠ cost 单独分组是玩家问出来的。原来它挂在阶段下面，面板上写着
       *   「收招 · 冷却 3」，看着像是"收招这个阶段有多长"。它其实是
       *   **这个技能有多长冷却，以及从哪个阶段开始算** —— 两件事，
       *   分组和说明都得说清楚。
       *
       * ⚠ effect 和 rules **必须分开**（玩家 2026-09-21 第 1 条）：
       *   "技能本身的效果不计入规则栏中"。混在一组里的话，
       *   玩家翻到"规则"会先看到"这个技能是什么"，而那正是他要区分的两件事。
       */
      const g = k === 'phases' ? '阶段'
        : k === 'effect' ? '固有效果'
          : k === 'rules' ? '规则'
            : k === 'cost' ? '代价'
              : group
      /*
       * ⚠ `parentKey` 取最后一个**字符串**段，但 `phases.0.duration` 的路径是
       *   `['phases', 0]` —— 最后一段是数字下标，于是 parentKey 变成 undefined，
       *   `duration` 就只能显示成「持续」。阶段里的那个数其实是**时长**。
       *   所以标题用 `labelParent`（阶段里一律按"阶段时长"叫），
       *   而"这是不是代价"要按**真实的**最后一段判（`cost`）。
       */
      const inPhases = path.includes('phases')
      const realParent = typeof path[path.length - 1] === 'string'
        ? path[path.length - 1] as string
        : undefined
      const parentKey = inPhases ? 'phases' : realParent

      if (typeof v === 'number') {
        const sk = inner ?? semanticKey(np)
        const { values, offGrid } = valuesForPath(sk, np, v)
        const phaseName = path.includes('phases') ? ctx[ctx.length - 1] : undefined
        /*
         * ⚠ 三段式标题：`时机 · 效果 · 数值名`（见文件头的注释）。
         *   最后一段用 `fieldName` 而不是 `labelFor` —— 前者知道
         *   "这个 amount 是伤害的 amount"，所以能写「伤害」而不是「值」。
         */
        const last = fieldName(k, parentKey, payloadKind, ownAttrPath ?? np.join('.'))
        const head = ctx.filter(Boolean)
        /*
         * 标题的拼法：
         *   最后一段和上一段重名 → 只留一个（「伤害 · 伤害」→「伤害」）
         *   最后一段是"认不出来的兜底"（数值 / 某个属性）而前面已经说了改什么
         *     → 也去掉，别在尾巴上挂一个没有信息的词
         *   （玩家点名的那条「… · 值」就是这种尾巴）
         */
        const genericTail = last === '数值' || last === '值' || last === '某个属性' || last === '状态数值'
        const parts = head[head.length - 1] === last
          ? head
          : genericTail && head.length > 0 ? head : [...head, last]
        const leaf: NumLeaf = {
          path: np,
          label: parts.join(' · '),
          value: v,
          values,
          index: Math.max(0, values.indexOf(v)),
          offGrid,
          group: g,
          unit: unitFor(sk) || unitHint || '',
        }
        // 哨兵值要说清楚，不然玩家拖到那一格不知道会发生什么
        if (sk === 'duration' && v === -1) {
          leaf.hint = path.includes('phases')
            ? '−1 = 蓄力阶段（按住键不放，由玩家决定什么时候放出去）'
            : '−1 = 永久（不会自己结束）'
        }
        // 阶段上的代价：说清楚它同时决定"多少"和"什么时候开始算"
        if (realParent === 'cost' && phaseName !== undefined) {
          const what = sk === 'cooldown' ? '冷却' : sk === 'energy' ? '能量' : sk === 'hp' ? '生命' : '代价'
          leaf.hint = `数值是"多少${what}"，「${phaseName}」是"什么时候付" —— `
            + `这个阶段一结束，${what}才开始扣/开始走。换个阶段就是换代价时机。`
        }
        out.push(leaf)
      } else {
        walk(v, np, ctx, g, inner, unitHint, payloadKind, ownAttrPath)
      }
    }
  }

  walk(root, [], [], '其他')
  return out
}

/** 按路径写回 */
export function setByPath(root: unknown, path: Path, value: number): void {
  if (path.length === 0) return
  // ⚠ 走到**父节点**，不是走到底 —— 走到底拿到的是叶子那个数字，
  //   在数字上设属性会直接抛 TypeError。这个 bug 刚被测试抓到过。
  const parent = walkTo(root, path.slice(0, -1))
  if (parent === null || typeof parent !== 'object') return
  const last = path[path.length - 1]
  if (last === undefined) return
  ;(parent as Record<PathSeg, unknown>)[last as never] = value as never
}

/** 按路径读 */
export function getByPath(root: unknown, path: Path): number | undefined {
  const v = walkTo(root, path)
  return typeof v === 'number' ? v : undefined
}

function walkTo(root: unknown, path: Path): unknown {
  let cur: unknown = root
  for (let i = 0; i < path.length; i++) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<PathSeg, unknown>)[path[i] as never]
  }
  return cur
}

/** 深拷贝一份，别把原对象改坏了 */
export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}
