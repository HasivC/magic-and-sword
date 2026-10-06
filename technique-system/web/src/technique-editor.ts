/**
 * 术式编辑器：**把技能组合成术式**。
 *
 * ## 为什么这个文件比技能编辑器重要
 *
 * 玩家 2026-09-21 的原话：
 *
 *   > 术式是玩家创造的，不是你写死在代码里的，要有把技能组合成术式的界面，
 *   > 我要的不是只有几个技能的无聊游戏，而是成千上万种可能的术式组合
 *
 * 所以**游戏的内容不是那 30 个技能，而是这些技能能拼出来的组合**。
 * 技能是零件，术式编辑器才是玩家的创作台。
 *
 * ## 玩家的术式库是**他自己那一个**
 *
 * ⚠ 玩家 2026-09-21 定的：
 *   > 敌人用的术式存到别的地方，玩家在编辑器里看不到这些示范术式，也没法引用它们。
 *
 * 所以这个编辑器**只列 `host.mine`**（存档里那些）。
 * 出厂术式（`content/internal-techniques/`）是引擎和敌人在用的东西，
 * 一份都不出现在界面里 —— 以前它们列成一个「出厂示范（只读）」分组，
 * 二十多份"一个技能配一份同名术式"的示范把创作台淹成了一条技能栏。
 * 玩家想要起点的话，起点就是**开局发的那份术式**（见 `web/src/main.ts` 的播种）。
 *
 * ## 它编的是什么
 *
 * 一份 `Technique`：
 *
 *   技能链     skills: ["skill.dash", "skill.burst"]      ← 按顺序接起来
 *   条件门     links:  [{ if: [prevHit] }]                ← 决定第二段跑不跑
 *
 * 这就是"编程组合"：不是把技能摞在一起，而是**给每一段之间加一个门**。
 *
 * ## 三个设计决定
 *
 * **1. 中间那条账是主视觉，不是附注。**
 *    玩家的工作循环是"加一个强零件 → 账面变负 → 加一个代价零件 → 回到 0"。
 *    所以每一段旁边都要显示它值多少点，合计旁边要显示**还差多少**。
 *    把账藏起来的话，这个循环就断了，玩家只能靠猜。
 *
 * **2. 技能库里显示每个零件自己值多少点。**
 *    "我不知道哪块便宜"是没法做设计的。加之前就得看得见。
 *
 * **3. 列表式，但数据就是引擎认的那份。**
 *    玩家选的"图式"（节点 + 连线）以后要加的 —— 那时它是**同一份数据的
 *    另一种画法**，不是另一套数据。所以这里**只改 `Technique`，
 *    不引入任何编辑器私有的中间结构**。这是为图视图留的路。
 */
import type {
  Condition, ConditionType, ModifierKind, ModifierProto, SegmentMod, SequenceSegment, Skill,
  StatusDef, Technique, TechniqueSequences,
} from '../../src/schema.ts'
import { groupBySkill, priceTechnique, readLookupTable, readRates, skillLedger } from '../../src/pricing.ts'
import type { PriceEntry, PriceOptions } from '../../src/pricing.ts'
import { describeCondition } from '../../src/describe.ts'
import { collectStatuses } from '../../src/validator/checks.ts'
import type { BalanceConfig } from '../../src/validator/types.ts'
import { decodeShare, encodeShare } from './store.ts'
// 重画时把焦点/光标 + **滚动位置**接回来 + 一块一块挂（结构固定的两步，见 ui/dom.ts）
import { captureFocus, captureScroll, endBlocks, mountBlock, restoreFocus, restoreScroll } from './ui/dom.ts'
// ⚠ 常驻那一句**用户点名的原文**在技能页那个文件里（`skill-page.ts`）——
//   在术式页里再抄一遍的话，两页迟早写成两句不一样的话。
import { PERMANENT_NOTE } from './skill-page.ts'

/**
 * 这一份术式的**技能链**，永远拿到一个真的数组。
 *
 * ⚠ 类型上 `Technique.skills` 是**可选**的 —— 序列术式（武器术式）不写它，
 *   它挂的是 `sequences`。编辑器只编辑**玩家自己的术式**（那些一定有技能链），
 *   但类型不知道这件事，所以这里统一收口。
 *
 * ⚠ 它在必要时**把数组补上**（`t.skills = []`）—— 调用方要往链上 push /
 *   splice / 交换，光返回一个临时空数组的话改动会丢掉。
 *   这是编辑器唯一一处"读的时候顺手补字段"，因为"加一段"本来就要先有那个数组。
 */
function chainOf(t: Technique): string[] {
  if (t.skills === undefined) t.skills = []
  return t.skills
}

/**
 * ⚠⚠ **这一片最要紧的一条数据决定**：技能链**写两遍**。
 *
 * ## 为什么
 *
 * 术式有两个"技能住在哪儿"的读法，而它们今天**都是活的**：
 *
 *   · `tech.skills`         —— **账**读它（`pricing.ts` 的 `priceTechnique`：
 *     逐条 `skillLedger` 记点数）。空着的话，整条技能链在账上是 **0 条明细** ——
 *     而"账"是这一页的主视觉（"加一个强零件 → 账面变负 → 加一个代价零件 → 回到 0"）。
 *     账不显示技能 = 玩家的循环断了。
 *   · `sequences[0].skills` —— **引擎**读它（`sim/compile.ts` 把每一段编成
 *     `CompiledSegment`，`cast.ts` 的 `pressSequence` 放的就是它），
 *     而且**修饰副本住在段上**（`SegmentMod.at` 是"它修饰段里第几个技能"）——
 *     不写段的话，零件根本没有落脚的地方。
 *
 * ## 为什么不会放两遍
 *
 * `pressSequence` 走的是"**有序列就放序列**"（`segmentCountOf(technique) === 0`
 * 才退回 `activate`，见 `cast.ts`），所以容器的 `compiled.phases` 不会被一起放。
 * 这一点是这一条决定能成立的地基，所以写在这儿：**改引擎那一句之前先看这里**。
 *
 * ## 谁是权威
 *
 * **段**是权威（`seq0(t)`）：所有改动先写段，再 `syncChain(t)` 把 `tech.skills`
 * 抄一份过去。反过来（以 `tech.skills` 为权威）不行 —— 副本改不动段里的位置。
 */
function seq0(t: Technique): SequenceSegment {
  const seqs = t.sequences ?? (t.sequences = [] as TechniqueSequences)
  const first = seqs[0]
  /*
   * ⚠ 老形状（`sequences: ["tech.xxx"]` 字符串引用）在这一页**读不动** ——
   *   它引用的是一份独立的术式，那种数据是出厂 / 老存档里的东西。
   *   这里**不覆盖**它，而是**往前插**一段内联的：
   *   覆盖的话玩家一进来就等于把老数据扔了（而且没有任何地方会提醒他）。
   */
  if (first === undefined || typeof first === 'string') {
    /*
     * ⚠ **把老那一份搬进来**（`skills` + `links`）—— 这一步不是可选的：
     *   这一页所有编辑最后都会 `syncChain(t)`（段 → `t.skills`），
     *   段里空着的话，玩家在这份老术式上**改任何一个字**都会把它的技能链清空，
     *   而且不报错（表现是"我点了一下上移，整条链没了"）。
     */
    const seg: SequenceSegment = {
      skills: [...(t.skills ?? [])],
      ...(t.links === undefined || t.links.length === 0 ? {} : { links: t.links }),
    }
    seqs.unshift(seg)
    return seg
  }
  if (!Array.isArray(first.skills)) first.skills = []
  return first
}

/** 段 → `tech.skills` 抄一份（见 `seq0` 的说明）。**每一次改动之后都要调它** */
function syncChain(t: Technique): void {
  t.skills = [...seq0(t).skills]
}

export interface TechniqueHost {
  /** 零件库：**基础技能库**（`content/skills`，出厂、只读） */
  skills: ReadonlyMap<string, Skill>
  /**
   * **自定义技能库**：玩家创造出来的变体（存在存档里）。
   *
   * ⚠ 术式**两个库都能引用**（玩家 2026-09-21 定的）：
   *   "玩家不只能从自定义技能库中组成术式，也能从基础技能库中选择"。
   *   少了这张表，玩家自己编的技能在他自己的术式里会显示成"找不到"。
   */
  custom?: ReadonlyMap<string, Skill>
  /**
   * **修饰原型表**（`content/modifiers/`，出厂零件）。
   *
   * ⚠ 玩家定的路径是"**点中序列里的那个零件 → 进它自己的编辑界面**"，
   *   而那个界面的参数表（`paramsTemplate`）**只住在原型上** ——
   *   没有这张表，副本就只能显示一个 id。
   *   ⚠ 原型**只读**：界面上一律不给"新建 / 改原型"的路（用户点名）。
   */
  modifiers?: ReadonlyMap<string, ModifierProto>
  /**
   * 已经被占用的术式 id（内部术式库 + 玩家自己的）。
   *
   * ⚠ **只是用来避让 id**，界面上不列、也引用不到。
   *   内部术式（`content/internal-techniques/`，敌人和武器在用的那些）撞了 id
   *   的话，玩家导入的那份会**把内部术式顶掉** —— 表现是敌人当场行为异常，
   *   而没有任何地方会报错。所以撞了就改名。
   */
  takenIds?: ReadonlySet<string>
  /**
   * 这份术式**现在放不出来的原因**（编译问题 / 还是个空壳）。
   *
   * ⚠ 宿主（`web/src/main.ts`）知道，编辑器不知道 —— 引擎认的是编译产物，
   *   而"编译出来了但有悬空引用"这种东西只有宿主那边看得见。
   *   玩家 2026-09-21 报的"绑了键按下去没反应"，根因就在这一类里。
   */
  problemsOf?: (id: string) => string[]
  /** 玩家自己做的术式。**就地改这一份** */
  mine: Map<string, Technique>
  /** 技能栏：按键 1..0 上装哪几个术式（按顺序）。也是就地改 */
  loadout: string[]
  balance: BalanceConfig
  statuses?: ReadonlyMap<string, StatusDef>
  entities?: ReadonlyMap<string, { id: string }>
  /** 有任何改动（含换键）就调它 —— 宿主负责存盘 + 重编译 + 装回世界 */
  onChanged: () => void
  /** 导入失败之类的提示 */
  onNotice?: (msg: string) => void
  /** 要一段分享码贴到剪贴板；返回实际写进去的文本 */
  onCopy?: (text: string) => void
  /** 让玩家把一段分享码贴回来（用 prompt 之类）。取消返回 undefined */
  onPaste?: () => string | undefined
  /**
   * 这份术式用到的**自定义技能**（分享时要打包进码里）。
   *
   * ⚠ 玩家 2026-09-21 定的：分享码**带着**这份术式用到的自定义技能 ——
   *   不带的话，收码的人拿到的是一份跑不起来的连招，
   *   而且他没法自己"搞到"那些技能（它们是发码的人编出来的）。
   */
  bundleFor?: (tech: Technique) => Skill[]
  /**
   * 收一份码：**先把码里的自定义技能导进库里**，再返回要采用的那份术式。
   *
   * ⚠ 交给宿主做（`web/src/main.ts`），因为两个技能库在它手里。
   *   冲突时**必须问玩家**（"用我的 / 导入码里的新副本"），不能静默覆盖 ——
   *   覆盖掉的是别人编出来的东西，而他自己那份可能已经用在好几份术式上了。
   */
  onRedeem?: (tech: Technique, skills: Skill[]) => { technique: Technique; notes: string[] }
}

export interface TechniqueEditor {
  /**
   * 重画一次。
   *
   * ⚠ 这个编辑器**不拥有**那个浮层的开关 —— 开关是技能编辑器管的
   *   （`#editor` 只有一个，两个编辑器各管各的会互相抢 class）。
   *   它是浮层里的第二个页签，所以只需要"重画"这一个动作。
   */
  refresh: () => void
}

// ============================================================================
//  条件：编辑器要支持哪几种，各自要什么参数
// ============================================================================

interface CondSpec {
  type: ConditionType
  label: string
  /** 要不要"判断谁" */
  who: boolean
  arg: 'none' | 'text' | 'number' | 'range' | 'statusId' | 'hitKind'
}

/*
 * ⚠ 这里**故意只放平铺的条件**，没有 not / anyOf / allOf。
 *
 *   嵌套条件在列表式界面里没法表达清楚（要缩进、要拖拽、要折叠），
 *   而它们至今零内容。等真的有技能需要"不满足 A 且满足 B 或 C"时再加，
 *   那时也该是图视图的活。
 */
const COND_SPECS: CondSpec[] = [
  { type: 'prevHit', label: '上一段碰到了人', who: false, arg: 'none' },
  { type: 'hasStatusTag', label: '身上有某种状态', who: true, arg: 'text' },
  { type: 'hasStatus', label: '身上有某个状态（按 id）', who: true, arg: 'statusId' },
  { type: 'hasTag', label: '自身带某个标签', who: true, arg: 'text' },
  { type: 'hpBelow', label: '血量低于百分之几', who: true, arg: 'number' },
  { type: 'distanceIs', label: '距离在某个区间', who: false, arg: 'range' },
  { type: 'targetCountIs', label: '目标数量在某个区间', who: false, arg: 'range' },
  { type: 'isCrit', label: '本次暴击', who: false, arg: 'none' },
  { type: 'hitKindIs', label: '本次是伤害还是治疗', who: false, arg: 'hitKind' },
]

function specOf(type: ConditionType): CondSpec | undefined {
  return COND_SPECS.find(s => s.type === type)
}

/**
 * 修饰原型 `paramsTemplate` 里的**一个参数**。
 *
 * ⚠ 形状由**内容**定（`content/modifiers/*.json` 的 `paramsTemplate`），
 *   不是这里发明的：`type` 决定界面上给什么控件，`min` / `max` / `step`
 *   决定号码的边界。所以这一页**不认识具体某个零件** ——
 *   加一个新零件（改 JSON）不用改这里一个字。
 *
 * ⚠ `condition` / `array` / `event` 这几档这一片**只显示不给改**（见 `modEditHtml`），
 *   所以它们在界面上走"只读"那条路。
 */
interface ModParamTemplate {
  type?: string
  default?: unknown
  min?: number
  max?: number
  step?: number
  label?: string
  values?: string[]
}

/** 新建一个条件的默认形状。默认值要**能用** —— 空字符串会让条件恒不成立 */
function newCondition(type: ConditionType): Condition {
  const spec = specOf(type)
  if (spec === undefined) return { type }
  const c: Condition = { type }
  if (spec.who) c.who = 'target'
  switch (spec.arg) {
    case 'text': c.value = type === 'hasStatusTag' ? 'shield' : 'undead'; break
    case 'statusId': c.value = 'status.shield'; break
    case 'number': c.value = 0.3; break
    case 'range': c.range = [0, 3]; break
    case 'hitKind': c.value = 'damage'; break
    default: break
  }
  return c
}

// ============================================================================
//  编辑器
// ============================================================================

/*
 * ⚠ 这里原来有三张表：`TARGETING_MODES` / `VALID_TAGS` / `MODE_LABEL`
 *   （"怎么瞄 / 对谁有效"那两排控件的选项）。
 *
 *   **2026-09-21（日志 47）删掉了** —— 瞄准搬到**技能**上之后，术式这一页
 *   不再有那两排控件（理由见 `metaHtml` 的注释）。
 *   留着它们等于留着"瞄准能在这页改"的假线索。
 *   ⚠ 技能的瞄准控件在**技能编辑器**那一页（`web/src/editor.ts`），那里另有一套。
 */
const ACTIVATIONS = ['press', 'release', 'hold', 'toggle', 'auto'] as const

const ACTIVATION_LABEL: Record<string, string> = {
  press: '按一下',
  release: '蓄力后松手',
  hold: '按住持续',
  toggle: '按一下切换开关',
  auto: '不用按，常驻',
}

export function createTechniqueEditor(host: TechniqueHost): TechniqueEditor {
  const bodyEl = document.getElementById('techBody') as HTMLDivElement | null
  if (bodyEl === null) {
    // 没有这个容器就退化成一个空实现，不让整个客户端起不来
    return { refresh: () => {} }
  }
  const body: HTMLDivElement = bodyEl

  const options: PriceOptions = {
    rates: readRates(host.balance.rates),
    baseRuleSlots: host.balance.baseRuleSlots,
    ruleSlotBuyCost: host.balance.ruleSlotBuyCost,
    ruleSlotSellGain: host.balance.ruleSlotSellGain,
    tolerance: typeof host.balance.balanceTolerance === 'number' ? host.balance.balanceTolerance : 0,
    // ⚠ 全量点表（2026-09-30 日志 60b）：装上它，技能的点数才是**查表 + 相加**
    //   （用户规格）。不装就**静默**退回老公式 —— 界面上的数和命令行对不上。
    lookupTable: readLookupTable(host.balance.lookupTable),
    ...(host.statuses !== undefined ? { statuses: host.statuses } : {}),
    /*
     * ⚠⚠ **修饰原型表也要传下去**（2026-10-07 术式页那一片修的）。
     *   不传的后果是**静默的**：份数类（多重释放 / 一分为 X）和排布 / 追踪 / 弹射
     *   在账上**一笔都不记** —— 于是"一次打 4 个"看起来是**白送的**，
     *   而界面上那个零件旁边写着它自己花多少（写出来的是 0，玩家会当成真的）。
     *   `priceOptionsFor`（`src/pricing.ts`）那条路上本来就有它；
     *   编辑器这一处是**手拼** `PriceOptions` 的，得自己传。
     */
    ...(host.modifiers !== undefined ? { modifiers: host.modifiers } : {}),
  }
  const tol = options.tolerance ?? 0

  let currentId: string | undefined

  /**
   * 现在在哪一屏。
   *
   * ⚠ 照设计模板：**库和编辑是两块屏**（模板里是 `#viewTech` / `#editTech`
   *   两块 `.body`，靠 `display` 切）。技能页（`editor.ts`）那一屏也是这个形状。
   *   不切屏的话，"选中一份术式"会当场把它整页摊开 —— 而用户的流程是
   *   "先看清库里有哪些、这一份是什么，按了『编辑此术式』才进去改"。
   */
  let view: 'lib' | 'edit' = 'lib'

  /**
   * 正在编辑**一个修饰副本**（`undefined` = 在编辑整条术式）。
   *
   * ⚠ 用户定的路径：「**点中序列里的那个零件 → 进它自己的编辑界面**改」。
   *   所以它不是"就地展开一段参数"，而是**换一屏**（和"点中技能格 → 打开技能"
   *   是同一个形状，模板里也是这么分的：`openModEdit` 换掉了整块编辑区）。
   */
  let editingMod: { si: number; mi: number } | undefined

  /**
   * 库那一屏的搜索词。
   *
   * ⚠ 它是**界面状态**，不是术式的字段 —— 所以**不回写草稿**
   *   （回写的话"搜过什么"会被存进存档）。
   *   技术库里两个库（技能 / 术式）共用这一个词是**故意的**：
   *   玩家在库里搜"火"，进编辑屏之后还想挑"火"开头的技能。
   */
  let query = ''

  /**
   * 库里每一份术式的合计点数（`id → 点数`）。
   *
   * ⚠ 它每次重画**算一次**（`ledgerCache()`）：列表上每一行都要它，
   *   按行各算一遍整本账是 20 倍的浪费（而结果一模一样）。
   */
  let ledger: Map<string, number> = new Map()

  /** 当前编辑的术式。**就是 host.mine 里那一份**，不是副本 —— 改了立刻是存档 */
  function draft(): Technique | undefined {
    return currentId === undefined ? undefined : host.mine.get(currentId)
  }

  /**
   * 按 id 找技能 —— **两个库都查**（自定义库优先、基础库兜底）。
   *
   * ⚠ 玩家 2026-09-21 定的：术式可以引用**基础技能库**里的技能，
   *   也可以引用**自定义技能库**里的变体。只查基础库的话，
   *   玩家自己编的技能在他自己的术式里会显示成"内容库里没有"。
   */
  function skillOf(id: string): Skill | undefined {
    return host.custom?.get(id) ?? host.skills.get(id)
  }

  /** 两个库合并成一份（列表、状态收集用） */
  function allSkills(): Skill[] {
    return [...host.skills.values(), ...(host.custom === undefined ? [] : host.custom.values())]
  }

  /**
   * 这一段**给这份术式带来多少点**。
   *
   * ⚠ 是**相对它的模板**的偏离，不是绝对账（2026-09-21 起账就算相对值）。
   *   基础技能 = 0 点（出厂内容在宗旨下就是 0）；变体 = 它比模板强/弱多少。
   *   用绝对账的话，列表上写着"魔法飞弹 −0.7"，而账上根本没有这一笔 ——
   *   两个数对不上，玩家会以为账算错了。
   */
  function partPoints(skill: Skill): number {
    if (skill.basedOn === undefined) return 0
    const base = skillOf(skill.basedOn)
    if (base === undefined) return 0
    return skillLedger(skill, base, options).total
  }

  // ==========================================================================
  //  术式库那一屏要用的几件纯读数
  // ==========================================================================

  /**
   * 这一份术式是**武器术式**还是**魔法术式**。
   *
   * ⚠ 走 `Technique.kind`（**显式字段**，schema 里定过"不能靠有没有 sequences 推"），
   *   老存档里缺字段的那一份由加载器补过（`src/school.ts` 的 `deriveTechniqueKind`）。
   *   这里再兜一次底只是为了让 `kind` 缺失时**落在安全那一边**（魔法），
   *   而不是让它变成一个界面上没有的分组。
   */
  function kindOf(t: Technique): 'weapon' | 'magic' {
    return t.kind === 'weapon' ? 'weapon' : 'magic'
  }

  /**
   * 魔法术式下面那一层：**常驻 / 主动**。
   *
   * ⚠ 判据是 `activation === 'auto'` —— 引擎里"不响应按键"的那一档
   *   （`cast.ts` 的 `pressSequence` 见到它就报 `autoTechnique`：
   *   "这个东西本来就没有按键"）。所以它不是界面自己发明的一个分类。
   */
  function isPermanent(t: Technique): boolean {
    return t.activation === 'auto'
  }

  /** 这一份术式里一共几个零件（"3 条序列 / 5 个技能" 里的那个数） */
  function partCountOf(t: Technique): number {
    let n = (t.skills ?? []).length
    for (const seg of t.sequences ?? []) {
      if (typeof seg === 'string') continue
      n += seg.skills.length + (seg.mods ?? []).length
    }
    return n
  }

  /** 装到第几格键上（没装 ⇒ -1） */
  function slotOf(t: Technique): number {
    return host.loadout.indexOf(t.id)
  }

  function slotLabel(t: Technique): string {
    const i = slotOf(t)
    return i < 0 || i > 9 ? '（待装键）' : `键 ${i === 9 ? 0 : i + 1}`
  }

  /** 这条术式"跑不起来"的那些问题（宿主给的；没有就说没有） */
  function problemsOf(t: Technique): string[] {
    return host.problemsOf?.(t.id) ?? []
  }

  /**
   * 这一份术式的账，**只算一次**。
   *
   * ⚠ 列表上每一行都要显示点数、而点数要算一遍整本账 ——
   *   在 `map` 里各算一次的话，20 份术式就是 20 遍（而且它们的结果一模一样）。
   */
  function ledgerCache(): Map<string, number> {
    const out = new Map<string, number>()
    for (const id of host.mine.keys()) {
      const t = host.mine.get(id)
      if (t === undefined) continue
      out.set(id, priceTechnique(t, x => skillOf(x), options).total)
    }
    return out
  }

  /**
   * 账上**每一条**明细的路径 → 点数之和。
   *
   * ⚠ 这是"**每个零件各显示它自己花多少**"（用户点名）的唯一数据来源。
   *   按 `path` 归而不是按 `label` / `refId`：
   *   `path` 是 `sequences[j].mods[k]`（**段号 + 序号**，唯一），
   *   而 `refId` 是 `mod:原型@at` —— 同一段里两个不同序号的副本
   *   只要原型和位置一样就会撞在一起（那时两笔会被合成一笔）。
   */
  function pointsByPath(t: Technique): Map<string, number> {
    const priced = priceTechnique(t, x => skillOf(x), options)
    const out = new Map<string, number>()
    for (const e of priced.entries) {
      out.set(e.path, (out.get(e.path) ?? 0) + e.points)
    }
    return out
  }

  /** 这一段技能**自己**值多少点（相对它的模板；出厂技能恒 0） */
  function skillPoints(skillId: string): number {
    const s = skillOf(skillId)
    return s === undefined ? 0 : partPoints(s)
  }

  /** 修饰副本的参数表（原型上那份 `paramsTemplate`，只读） */
  function modTemplate(protoId: string): Record<string, ModParamTemplate> {
    const raw = host.modifiers?.get(protoId)?.paramsTemplate
    return (raw ?? {}) as Record<string, ModParamTemplate>
  }

  /** 副本的某个参数现在是多少（副本没写 ⇒ 原型的默认值） */
  function modParamValue(mod: SegmentMod, key: string): unknown {
    const own = mod.params[key]
    if (own !== undefined) return own
    return modTemplate(mod.proto)[key]?.default
  }

  /**
   * 把一个修饰副本**加进当前序列**。
   *
   * ⚠ `at` 一律取 `0`（"它修饰紧邻的下一个技能"）—— 这是定稿 §八 里**唯一接了线**
   *   的那一档（`at > 0` 引擎不落地，校验器报 `MODIFIER_GROUP_AT_NOT_WIRED`）。
   *   所以界面**只给这一档**，不做一个"写上去不生效"的下拉框。
   */
  function addMod(protoId: string): void {
    const t = draft()
    if (t === undefined) return
    const seg = seq0(t)
    syncChain(t)
    const mods = seg.mods ?? (seg.mods = [])
    const params: Record<string, unknown> = {}
    for (const [k, spec] of Object.entries(modTemplate(protoId))) {
      if (spec.default !== undefined) params[k] = spec.default
    }
    mods.push({ proto: protoId, at: 0, params })
    touchedStructurally()
    // 加完**直接进它的编辑界面**（照用户定的路径：点中零件 → 改它自己的参数）
    editingMod = { si: 0, mi: mods.length - 1 }
    renderAll()
  }

  /*
   * 删掉一个零件，同时**把位置对回去**。
   *
   * ⚠ 这一段是这一页最容易写错的地方：副本的 `at` 是**段内技能的下标**，
   *   删掉它前面一个技能之后，所有 `at` 比它大的副本都会**指错人** ——
   *   而且指错的方向是静默的（界面上还是"这两个挨着"，实际已经差一格）。
   *   所以删技能和"挪动"走的是**同一套位置搬运**（`moveSkill` / `dropSkill`）。
   */
  function dropSkill(si: number, i: number): void {
    const t = draft()
    if (t === undefined) return
    const seg = seq0(t)
    if (i < 0 || i >= seg.skills.length) return
    seg.skills.splice(i, 1)
    for (const m of seg.mods ?? []) {
      if (m.at > i) m.at = m.at - 1
      else if (m.at === i) m.at = Math.max(0, i - 1)   // 它修饰的那个技能没了 ⇒ 往上一格靠
    }
    syncChain(t)
    touchedStructurally()
  }

  /** 挪动一个技能（`d = -1` 上移 / `+1` 下移），副本的位置跟着走 */
  function moveSkill(si: number, i: number, d: number): void {
    const t = draft()
    if (t === undefined) return
    const seg = seq0(t)
    const j = i + d
    if (i < 0 || i >= seg.skills.length || j < 0 || j >= seg.skills.length) return
    const a = seg.skills[i] as string
    seg.skills[i] = seg.skills[j] as string
    seg.skills[j] = a
    /*
     * ⚠ 副本的 `at` 也要**跟着换**，否则"上移一格"会把它修饰的对象换成隔壁那个技能。
     *   这里的做法是"把落在 i / j 上的 at 互换"—— 正好等于两个位置整体对调。
     */
    for (const m of seg.mods ?? []) {
      if (m.at === i) m.at = j
      else if (m.at === j) m.at = i
    }
    syncChain(t)
    touchedStructurally()
  }

  /** 删掉一个修饰副本 */
  function dropMod(si: number, mi: number): void {
    const t = draft()
    if (t === undefined) return
    const seg = seq0(t)
    const mods = seg.mods ?? []
    if (mi < 0 || mi >= mods.length) return
    mods.splice(mi, 1)
    if (editingMod !== undefined && editingMod.si === si) {
      // 正在编辑它自己 ⇒ 退回术式编辑屏（留着会编辑到一个不存在的下标）
      editingMod = editingMod.mi === mi ? undefined
        : editingMod.mi > mi ? { si, mi: editingMod.mi - 1 } : editingMod
    }
    touchedStructurally()
  }

  /** 全部可选的状态 id：状态库 + 所有技能内联的（两个库都要扫） */
  function knownStatusIds(): string[] {
    const out = new Set<string>(host.statuses?.keys() ?? [])
    for (const s of allSkills()) {
      for (const { status } of collectStatuses(s)) {
        if (typeof status.id === 'string' && status.id.length > 0) out.add(status.id)
      }
    }
    return [...out].sort()
  }

  function touched(): void {
    host.onChanged()
    patchLedger()
  }

  /**
   * **只改账那个数，不重画结构**。
   *
   * ⚠ 为什么 `touched()` 不能直接 `renderAll()`：它是在**输入框的 `input` 事件**里
   *   调的（改名字 / 拖修饰参数），重画会把玩家正在输入的那个框换掉 ——
   *   焦点、光标、输入法候选全丢。这是这一页和技能页共用的一条规矩。
   *
   * ⚠ 那也意味着"每敲一个字，下面那本账是**短暂过时**的"（明细那几行不重算）。
   *   所以这里只**改那个数**（`data-live-ledger`），并把明细标成"改完才刷新"——
   *   静默地显示一个过时的合计比不显示更坏（玩家会拿它当结论）。
   *   失焦（`change`）时那一侧会 `renderAll()`，账和明细一起对上。
   */
  function patchLedger(): void {
    const t = draft()
    if (t === undefined) return
    const total = Math.round(priceTechnique(t, id => skillOf(id), options).total)
    const txt = `${total > 0 ? '+' : ''}${String(total)}`
    const all = (body as { querySelectorAll?: (s: string) => ArrayLike<unknown> }).querySelectorAll
    if (typeof all !== 'function') return
    for (const raw of Array.from(all.call(body, '[data-live-ledger]') as ArrayLike<unknown>)) {
      const el = raw as { textContent?: string | null }
      if (el.textContent !== txt) el.textContent = txt
    }
  }

  /** 结构性改动（加段、删段、换术式）→ 整块重画 */
  function touchedStructurally(): void {
    host.onChanged()
    renderAll()
  }

  // ---------------------------------------------------------------- 渲染

  //  这一页一共三块屏（照设计模板 `editor-v2.html`）：
  //    · 库（`#viewTech`）        —— 左栏术式列表 + 右栏详情
  //    · 术式编辑（`#editTech`）   —— 左边窄技能库 + 右边序列
  //    · **修饰副本自己的编辑屏**  —— 点中序列里那个零件进来的那一屏
  //
  //  ⚠ 前两块是模板里就有的；第三块模板里是 `openModEdit`
  //    （**换掉整块编辑区**，不是就地展开）—— 因为"副本的参数"和"术式的参数"
  //    是两套东西（定稿 §八：普通技能讲前摇/命中/后摇，修饰讲一条改写规则）。

  /** 不是当前那一屏就套一层"藏着"的壳（照技能页 `editor.ts` 的写法） */
  function hideUnless(visible: boolean, html: string): string {
    return visible ? html : `<div class="sk-offscreen" style="display:none">${html}</div>`
  }

  // ------------------------------------------------------------- 屏 1：术式库

  function renderLibrary(): void {
    if (view !== 'lib') {
      mountBlock(body, 'tech-libpage', hideUnless(false, ''))
      return
    }
    mountBlock(body, 'tech-libpage', `<div class="sk-page"><div class="sk-cols">
      <div class="sk-techlib">
        <input class="sk-search" id="techSearch" data-act="search" placeholder="搜术式…"
               value="${esc(query)}">
        <div class="sk-tlibbody">${techListHtml()}</div>
      </div>
      ${techDetailHtml()}
    </div></div>`)
  }

  /**
   * 左边那一栏的**内容**（搜索框下面那一段 —— 打字时只换这一段，不重画输入框）。
   *
   * ⚠ 分组是**用户定的**：
   *     武器术式
   *     魔法术式 ── 常驻术式 / 主动术式
   *   ⚠ 旧名「触发术式」**不许用**（用户点名删掉的那个词）。
   *   每一组末尾一个「＋ 新建一个…术式」入口，**框的大小和术式框一样**
   *   （所以它也走 `.sk-row2`，只多一条虚线边）。
   */
  function techListHtml(): string {
    const groups = groupTechs()
    const rows = (list: Technique[]): string =>
      list.length === 0
        ? '<div class="sk-empty">这一组里还没有</div>'
        : list.map(t => techRowHtml(t)).join('')

    const groupHead = (color: string, title: string, note: string): string =>
      `<div class="sk-grouphead"><span class="sk-dot" style="background:${color}"></span>`
      + `${esc(title)} <span class="sk-n">${esc(note)}</span></div>`

    /*
     * ⚠⚠ 2026-10-07（用户实测第 2 条）：二级标题（常驻 / 主动）走**另一个类**，
     *   而且整组挂进 `.sk-subgroup` 里。
     *   用户原话：「常驻和主动术式是在**魔法术式下**的分组，而不是和魔法术式**同级**」。
     *   他看到的"四个平级分组"，成因就是四条标题共用 `.sk-grouphead` 一个样式 ——
     *   所以这里连类名都错开（`.sk-subhead` / `.sk-subdot`），
     *   测试断言的也正是"一级和二级的类名不同 + 二级在魔法那一组的**里面**"。
     *   ⚠ 2026-10-06（又一条用户实测）：「二级术式**不要缩进**」——
     *     原来 `.sk-subgroup` 的缩进 + 左侧竖线**已经删掉**（见 `web/index.html` 里
     *     `.sk-subhead` 那一段）。层级现在只靠**更小 + 更淡 + 短横**说。
     *     ⚠ `.sk-subgroup` 这个类名**照旧保留**：它说的是**结构**（二级在魔法那一组里面），
     *       而结构正是下面那些断言钉的东西 —— 去掉的是观感，不是这一层。
     *   ⚠ 分类依据不变：还是 `isPermanent` 那个 `activation === 'auto'`，
     *     界面不自己发明分类（`groupTechs` 一个字都没动）。
     */
    const subHead = (color: string, title: string, note: string): string =>
      `<div class="sk-subhead"><span class="sk-subdot" style="background:${color}"></span>`
      + `${esc(title)} <span class="sk-n">${esc(note)}</span></div>`

    /** 魔法术式底下那一层：一个二级标题 + 它自己那几行（**不缩进**；层级靠更小更淡的字 + 短横） */
    const subGroup = (color: string, title: string, note: string, list: Technique[]): string =>
      `<div class="sk-subgroup">${subHead(color, title, note)}${rows(list)}</div>`

    const newRow = (kind: 'weapon' | 'magic'): string =>
      `<div class="sk-row2 sk-new" data-act="newTech" data-kind="${kind}" `
      + `title="建一份新的${kind === 'weapon' ? '武器' : '魔法'}术式">`
      + `＋ 新建一个${kind === 'weapon' ? '武器' : '魔法'}术式</div>`

    /*
     * ⚠ 两棵**并列**的树：`.sk-group[data-group="weapon"]` 和 `[data-group="magic"]`。
     *   武器那一侧**没有**常驻 / 主动（引擎里武器术式是按键序列，没有 auto 那一档）；
     *   常驻 / 主动整个挂在魔法那一棵**里面**（`.sk-subgroup` 是它的孩子）。
     *   `data-group` 不是装饰：测试就是靠它断言"这两个二级标题在魔法那一组里面，
     *   而武器那一组里一个都没有"。
     */
    return `<div class="sk-group" data-group="weapon">
      ${groupHead('#f0883e', '武器术式', `（只能放武器技能 + 修饰技能 · ${String(groups.weapon.length)} 份）`)}
      ${rows(groups.weapon)}
      ${newRow('weapon')}
    </div>
    <div style="height:16px"></div>
    <div class="sk-group" data-group="magic">
      ${groupHead('#c678dd', '魔法术式', '（放魔法技能 + 修饰技能）')}
      ${subGroup('#d29922', '常驻术式', `（不占键位 · ${String(groups.permanent.length)} 份）`, groups.permanent)}
      ${subGroup('#58a6ff', '主动术式', `（按键释放 · ${String(groups.active.length)} 份）`, groups.active)}
      ${newRow('magic')}
    </div>`
  }

  /** 库里现在的三组（`kind` 那一层 + 魔法下面那一层，各自按搜索词过滤） */
  function groupTechs(): { weapon: Technique[]; permanent: Technique[]; active: Technique[] } {
    const q = query.trim().toLowerCase()
    const all = [...host.mine.keys()].sort()
      .map(id => host.mine.get(id))
      .filter((t): t is Technique => t !== undefined)
      .filter(t => q === '' || t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q))
    return {
      weapon: all.filter(t => kindOf(t) === 'weapon'),
      permanent: all.filter(t => kindOf(t) === 'magic' && isPermanent(t)),
      active: all.filter(t => kindOf(t) === 'magic' && !isPermanent(t)),
    }
  }

  /**
   * 术式库里的一行（照模板 `techRow`）。
   *
   * ⚠ 右端那个点数是**算出来的**（`priceTechnique`），而且**显示整数**
   *   （用户点名："账显示整数"）—— 账在 `pricing.ts` 的出口处已经整数化了，
   *   这里再取一次整只是防止"哪一天有人把整数化挪走"时界面先变成小数。
   * ⚠ 跑不起来的那一份显示"⚠ 跑不起来"，**不是 0** —— 写成 0 的话
   *   它看起来会像一份配平好的术式（而按下去什么都没有）。
   *
   * ⚠⚠ 武器术式显示"**不算账**"，不是"0 点"（2026-10-06 日志 64）：
   *   账按武器 / 魔法分开算，武器术式的账**根本不存在**（数字来自武器本身）——
   *   写成"0 点"会被读成"配平好了、白送"。
   *   ⚠ 判据读的是 `kindOf(t)`（= `Technique.kind`，见 `school.ts` 的
   *   `techniquePaysPoints`），不是界面自己另判一份。
   */
  function techRowHtml(t: Technique): string {
    const on = t.id === currentId ? ' on' : ''
    const bad = problemsOf(t).length > 0
    const weapon = kindOf(t) === 'weapon'
    const p = Math.round(ledger.get(t.id) ?? 0)
    const cls = bad ? 'bad' : p === 0 ? 'ok' : p < 0 ? 'neg' : 'warn'
    const ptsTxt = bad
      ? '⚠ 跑不起来'
      : weapon ? '不算账' : `${p > 0 ? '+' : ''}${String(p)} 点`
    const kind = weapon ? '武器术式' : isPermanent(t) ? '魔法 · 常驻' : '魔法 · 主动'
    const title = [t.name, kind, bad ? problemsOf(t).join('；') : ptsTxt].join(' · ')
    return `<div class="sk-row2${on}${bad ? ' bad' : ''}" data-act="pickTech" data-i="${esc(t.id)}"
        title="${esc(title)}">
      <span class="sk-nm2">${esc(t.name)}</span>
      <span class="sk-meta"><span>${String((t.sequences ?? []).length)} 条序列</span>`
      + `<span>${String(partCountOf(t))} 个零件</span><span>${esc(slotLabel(t))}</span></span>
      <span class="sk-pts ${cls}">${esc(ptsTxt)}</span>
    </div>`
  }

  /** 右边那块详情（照模板 `techDetail`） */
  function techDetailHtml(): string {
    const t = draft()
    if (t === undefined) {
      return `<aside class="sk-detail"><div class="sk-none">
        <div class="sk-none-big">选中术式以查看详情</div><div>左边点一行</div></div></aside>`
    }
    const weapon = kindOf(t) === 'weapon'
    const kindCol = weapon ? '#f0883e' : '#c678dd'
    const kindTxt = weapon ? '武器术式' : isPermanent(t) ? '魔法术式 · 常驻' : '魔法术式 · 主动'
    const probs = problemsOf(t)
    const p = Math.round(ledger.get(t.id) ?? 0)

    const seqRows = (t.sequences ?? []).map((seg, i) => {
      const names = typeof seg === 'string'
        ? [seg]
        : [...seg.skills.map(id => skillOf(id)?.name ?? `${id}（找不到）`),
          ...(seg.mods ?? []).map(m => `【${host.modifiers?.get(m.proto)?.name ?? m.proto}】`)]
      return `<tr><td>${String(i + 1)}</td><td>${
        esc(names.length === 0 ? '（空的）' : names.join(' + '))}</td></tr>`
    }).join('')
    const ownChain = (t.skills ?? []).length === 0
      ? ''
      : `<div class="sk-sect">它的技能链</div><table class="sk-num"><tr><td>顺序</td><td>${
        esc((t.skills ?? []).map(id => skillOf(id)?.name ?? id).join(' → '))}</td></tr></table>`

    return `<aside class="sk-detail">
      <div class="sk-dname">${esc(t.name)}
        <span class="sk-pill" style="border-color:#58a6ff;color:#58a6ff">${esc(slotLabel(t))}</span>
        <span class="sk-pill" style="border-color:${kindCol};color:${kindCol}">${esc(kindTxt)}</span></div>
      <div class="sk-dnote">${esc(t.note ?? '（没写介绍）')}</div>
      ${probs.length === 0 ? '' : `<div class="sk-warn">${esc(probs.join('；'))}</div>`}
      <div class="sk-sect">序列</div>
      <table class="sk-num">${seqRows === '' ? '<tr><td>—</td><td>还没有序列</td></tr>' : seqRows}</table>
      ${ownChain}
      ${isPermanent(t) ? `<div class="sk-perm">${esc(PERMANENT_NOTE)}</div>` : ''}
      <div class="sk-sect">点数</div>
      <table class="sk-num"><tr><td>合计</td>
        <td class="sk-pts ${probs.length > 0 ? 'bad' : p === 0 ? 'ok' : p < 0 ? 'neg' : 'warn'}">${
          probs.length > 0 ? '—' : `${p > 0 ? '+' : ''}${String(p)} 点`}</td></tr></table>
      <div class="sk-dact">
        <button class="sk-primary" data-act="openEdit">编辑此术式</button>
      </div></aside>`
  }

  // ------------------------------------------------------------- 屏 2：术式编辑

  /**
   * 一条序列的格子（模板 `.seq`：序号 + 一排正方形空位）。
   *
   * ⚠ **位置顺序就是语义**（用户定）：越靠前越先放。
   *   所以"加一个技能"是**追加到末尾**，"上移 / 下移"是**换位**，
   *   而不是"把某个技能挂到别的技能下面"。
   * ⚠ 修饰副本也占一格，排在**它修饰的那个技能前面** ——
   *   这是引擎的读法（`at` = "修饰段里第几个技能"，`modsAt` 取的是
   *   "挂在这个技能前面的那些"）。
   * ⚠ **不是拖拽**（用户定的：先用按钮）—— 每一格旁边就是 ↑ ↓ ×。
   */
  function seqRowHtml(t: Technique, si: number): string {
    const seg = seq0(t)
    const byPath = pointsByPath(t)

    const skillSlot = (id: string, i: number): string => {
      const s = skillOf(id)
      const missing = s === undefined
      const name = s?.name ?? `${id}（找不到）`
      const p = Math.round(skillPoints(id))
      const pt = p === 0 ? '' : `<span class="sk-slot-pt ${p > 0 ? 'gain' : 'cost'}"
          title="这个零件自己的点数">${p > 0 ? '+' : ''}${String(p)}</span>`
      const title = missing ? `找不到这个技能：${id}` : `${name} · 点它进它自己的编辑界面`
      return `<button class="sk-slot${missing ? ' sk-bad' : ''}" data-act="openPart"
          data-si="${String(si)}" data-i="${String(i)}" title="${esc(title)}">
        <span class="ic" style="background:${missing ? '#f85149' : s?.basedOn === undefined ? '#58a6ff' : '#c678dd'}">${
          esc(name.slice(0, 1))}</span>
        <span class="sk-slot-nm">${esc(name)}</span>${pt}</button>`
    }

    const modSlot = (mi: number): string => {
      const mod = (seg.mods ?? [])[mi]
      if (mod === undefined) return ''
      const name = host.modifiers?.get(mod.proto)?.name ?? mod.proto
      const p = Math.round(byPath.get(`sequences[${String(si)}].mods[${String(mi)}]`) ?? 0)
      const pt = p === 0 ? '' : `<span class="sk-slot-pt ${p > 0 ? 'gain' : 'cost'}">${
        p > 0 ? '+' : ''}${String(p)}</span>`
      return `<button class="sk-slot sk-mod" data-act="openPart" data-si="${String(si)}"
          data-mod="${String(mi)}"
          title="${esc(`${name} · 副本（只属于这份术式）· 点它改它自己的参数`)}">
        <span class="ic" style="background:#e3b341">饰</span>
        <span class="sk-slot-nm">${esc(name)}</span>${pt}</button>`
    }

    /** 挂在第 `i` 个技能**前面**的那些副本（`at === i`） */
    const modsBefore = (i: number): string =>
      (seg.mods ?? []).map((m, mi) => (m.at === i ? modSlot(mi) : '')).join('')

    const rows: string[] = []
    for (let i = 0; i < seg.skills.length; i++) {
      /*
       * ⚠ 两个技能之间那一格是**连接门**（`links[i]` 管 `skills[i+1]`）——
       *   术式能"编程"就靠它：上一段打中了才进下一段。
       *   放在两格中间而不是塞进某一格，是因为它是**两段之间的关系**，
       *   挂在任意一端都会让玩家读成"这个技能自己带的条件"。
       */
      if (i > 0) rows.push(`<div class="sk-partrow"><span class="sk-arrow">↓</span>${
        gateHtml(i - 1, String(i + 1))}</div>`)
      rows.push(`<div class="sk-partrow">${modsBefore(i)}${skillSlot(seg.skills[i] as string, i)}
        <span class="sk-ops">
          <button data-act="partUp" data-si="${String(si)}" data-i="${String(i)}"${
            i === 0 ? ' disabled' : ''} title="往上挪一格">↑</button>
          <button data-act="partDown" data-si="${String(si)}" data-i="${String(i)}"${
            i === seg.skills.length - 1 ? ' disabled' : ''} title="往下挪一格">↓</button>
          <button data-act="partDel" data-si="${String(si)}" data-i="${String(i)}"
            title="删掉这个零件（挂在它上面的副本会跟着挪位）">×</button>
        </span></div>`)
    }

    /*
     * ⚠ 尾巴上那些 `at` 越界的副本（老数据 / 手改的存档）**照样要看得见、点得开** ——
     *   藏起来的话，玩家在这份术式里永远删不掉它们（而它们照样进账）。
     */
    const tail = (seg.mods ?? [])
      .map((m, mi) => (m.at >= seg.skills.length ? modSlot(mi) : ''))
      .filter(x => x !== '')
      .join('')
    const addSlot = `<button class="sk-slot sk-add" data-act="addSlot" data-si="${String(si)}"
        title="再加一个技能（追加到末尾）">＋</button>`
    const bottom = seg.skills.length === 0 && tail === ''
      ? `<div class="sk-slots">${addSlot}</div>`
      : `<div class="sk-partrow" style="margin-top:10px">${tail}${addSlot}</div>`

    return `<div class="sk-seq">
      <div class="sk-seqhead">
        <span class="sk-seq-idx">${String(si + 1)}</span>
        <span class="sk-aim">这一条里的技能各自判断瞄准（术式本身没有瞄准）</span>
        <span class="sk-ops"><button data-act="seqDel" data-si="${String(si)}">删掉这条</button></span>
      </div>
      <div class="sk-parts">${rows.join('')}</div>
      ${bottom}
    </div>`
  }

  /**
   * 左边那条窄技能库（模板 `.lib`，214px）。
   *
   * ⚠ **列什么由这份术式的系别决定**（模板 `renderLib` 的规矩）：
   *     武器术式 → 武器技能 + 修饰技能
   *     魔法术式 → 魔法技能 + 我的技能 + 修饰技能
   *   不按系别过滤的话，玩家能把魔法技能塞进武器术式 —— 而校验器
   *   要到**做完之后**才把它报成 `WEAPON_TECHNIQUE_MAGIC_SKILL`。
   * ⚠ **修饰技能两边都能用**：它们没有系别（`ModifierProto` 里根本没有这一栏）。
   */
  function techLibHtml(t: Technique): string {
    const want = kindOf(t)
    const q = query.trim().toLowerCase()
    const okSchool = (s: Skill): boolean => (s.school ?? 'magic') === want
    const match = (s: Skill): boolean =>
      q === '' || s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)

    const chip = (s: Skill): string => {
      const p = Math.round(skillPoints(s.id))
      const tag = s.basedOn !== undefined ? '我的' : s.readonly === true ? '武器' : '基础'
      return `<button class="sk-chip2" data-act="addPart" data-id="${esc(s.id)}"
          title="${esc(`${s.name}（${tag}）—— 点它就加到当前序列末尾`)}">
        <span class="sq" style="background:${s.basedOn !== undefined ? '#c678dd' : '#58a6ff'}">${
          esc(s.name.slice(0, 1))}</span><span>${esc(s.name)}</span>
        <span class="k">${p === 0 ? tag : `${p > 0 ? '+' : ''}${String(p)}`}</span></button>`
    }

    const magic = [...host.skills.values()].filter(s => s.readonly !== true && okSchool(s) && match(s))
    const weapon = [...host.skills.values()].filter(s => s.readonly === true && okSchool(s) && match(s))
    const mine = [...(host.custom?.values() ?? [])].filter(s => match(s))
    const mods = [...(host.modifiers?.values() ?? [])].filter(m =>
      q === '' || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))

    const head = (color: string, title: string, note: string): string =>
      `<div class="sk-grouphead" style="margin:8px 0 6px"><span class="sk-dot" style="background:${color}"></span>`
      + `${esc(title)}<span class="sk-n">${esc(note)}</span></div>`
    const none = '<div class="sk-empty">这一类里没有</div>'
    const listing = (list: Skill[]): string => (list.length === 0 ? none : list.map(chip).join(''))

    /*
     * ⚠ 武器术式那一侧**没有「我的技能」**（模板明写的那条规矩）：
     *   武器技能全是出厂模板（横砍 / 刺击），它们之间靠**武器属性**不同而不同
     *   （范围 / 伤害 / 前后摇），玩家不自己做武器技能。
     */
    const skills = want === 'weapon'
      ? `${head('#58a6ff', '武器技能', '（出厂 · 只读）')}${listing(weapon)}`
      : `${head('#58a6ff', '魔法技能', '（出厂）')}${listing(magic)}
         ${head('#c678dd', '我的技能', '（我做的）')}${listing(mine)}`

    const modChips = mods.length === 0 ? none : mods.map(m =>
      `<button class="sk-chip2" data-act="addMod" data-id="${esc(m.id)}"
        title="${esc(`${m.name} · ${m.note ?? ''} —— 点它加出一个只属于这份术式的副本`)}">
        <span class="sq" style="background:#e3b341">饰</span><span>${esc(m.name)}</span>
        <span class="k">零件</span></button>`).join('')

    return `<div class="sk-libcol">
      <div class="sk-libhead">技能库（${want === 'weapon' ? '武器技能 / 修饰' : '魔法技能 / 我的 / 修饰'}）</div>
      <div class="sk-libscroll" data-scroll="techParts">
        ${skills}
        ${head('#e3b341', '修饰技能', '（点一下变副本）')}${modChips}
        <div class="sk-lib-hint" style="padding:2px 0 6px">点一下就加进当前序列的末尾。
          ⚠ <b>原型只能看、不能建、不能改</b>；加进来的是<b>副本</b>，它只属于这份术式。</div>
      </div>
    </div>`
  }

  /** 术式编辑那一屏（照模板 `openTechEdit`：左窄技能库 + 右序列） */
  function renderEdit(): void {
    const t = draft()
    if (t === undefined || view !== 'edit') {
      mountBlock(body, 'tech-editpage', hideUnless(false, ''))
      return
    }
    /* ⚠ 正在编辑一个修饰副本 ⇒ 这一屏整块换成**它自己的编辑界面**（照模板 `openModEdit`） */
    if (editingMod !== undefined) {
      mountBlock(body, 'tech-editpage', modEditHtml())
      return
    }

    const weapon = kindOf(t) === 'weapon'
    const kindTxt = weapon ? '武器术式' : isPermanent(t) ? '魔法术式 · 常驻' : '魔法术式 · 主动'
    const seqs = (t.sequences ?? []).length === 0
      ? '<div class="sk-empty">还没有序列 —— 点顶栏「＋ 新建一条序列」，或者直接从左边技能库点一个技能。</div>'
      : (t.sequences ?? []).map((_seg, i) => seqRowHtml(t, i)).join('')

    const head = `<div class="sk-edithead">
      <button data-act="techBack" title="回术式库">✕ 返回术式库</button>
      <span class="sk-t">${esc(t.name)}</span>
      <span class="sk-sub">${esc(kindTxt)} · ${esc(ACTIVATION_LABEL[t.activation] ?? t.activation)}</span>
      <span class="sk-spacer"></span>
      <span class="sk-ops">
        <button data-act="newSeq" title="再加一条序列">＋ 新建一条序列</button>
        <button data-act="saveAs">另存为一份</button>
        <button data-act="export">导出 JSON</button>
        <button data-act="copy">分享码</button>
      </span></div>`

    const empty = (t.skills ?? []).length === 0 && (t.sequences ?? []).length === 0
    const probs = problemsOf(t)
    const foot = `<div class="sk-foot">
      <span class="sk-note">${empty
        ? '先加一个技能，才能装到按键上（空术式按下去不会有反应）'
        : `装到 ${esc(slotLabel(t))}`}</span>
      <span class="sk-spacer"></span>
      <span class="sk-ops">
        <button data-act="rename" title="改这份术式的名字">改名字</button>
        <button data-act="del" title="删掉这份术式">删掉这份术式</button>
        <button data-act="import">导入 JSON</button>
        <button data-act="redeem">粘贴分享码</button>
      </span></div>`

    mountBlock(body, 'tech-editpage', `<div class="sk-page">
      <div class="sk-editcols">
        ${techLibHtml(t)}
        <div class="sk-editscreen" style="flex:1;min-width:0">
          ${head}
          ${isPermanent(t) ? `<div class="sk-perm">${esc(PERMANENT_NOTE)}</div>` : ''}
          ${probs.length === 0 ? '' : `<div class="sk-warn">这份术式现在<b>跑不起来</b>：${
            probs.map(p => esc(p)).join('；')}</div>`}
          <div class="sk-editscreen" style="gap:14px">${seqs}</div>
          ${ledgerCardHtml(t)}
          ${whyNotCastHtml()}
        </div>
      </div>
      ${foot}
    </div>`)
  }

  /**
   * "**这一下为什么放不出来**"（用户点名要的五条）。
   *
   * ⚠ 那五句的取值是**引擎报出来的原因**（`src/sim/types.ts` 的 `CastBlockReason`），
   *   不是界面自己编的分类：
   *     冷却中 = `cooldown`　正在施法 = `busy`　能量不够 = `energy`
   *     血契不够 = `bloodPact`　被沉默 = `silenced`
   *   ⇒ 这一块是**对照表**（编辑时看），不是实时的 —— 编辑器手里没有玩家的
   *     能量 / 冷却 / 状态，那是 HUD 的事（⚠ 这一片不碰 HUD）。
   *   每一句都写出"该等什么 / 去哪儿攒"，因为五种原因的行动建议完全不同。
   */
  function whyNotCastHtml(): string {
    const rows: [string, string][] = [
      ['冷却中', '离上一发太近 —— 每个技能各自有冷却，等它转好（HUD 上会显示还剩多久）'],
      ['正在施法', '同一个人同一时刻只能有一段施法 —— 上一段放完才轮到这一下'],
      ['能量不够', '等一会儿（能量会自己回）或者把这一下的能量代价降下来'],
      ['血契不够', '这是负值术式，超模的那部分要付血契 —— 血契靠"进入危机的行为"攒'
        + '（残血 / 被挂负面状态 / 抵押属性上限），它不自动回复'],
      ['被沉默', '身上有沉默类状态 —— 先解掉它，或者等它过期'],
    ]
    return `<div class="sk-card">
      <div class="sk-card-h">这一下为什么放不出来
        <span class="sk-card-n">引擎报的那五个原因，各一句</span></div>
      <div class="sk-why">${rows.map(([label, why]) =>
        `<div><b>${esc(label)}</b> —— ${esc(why)}</div>`).join('')}</div>
    </div>`
  }

  /** 账那一张卡（这一页的主视觉） */
  function ledgerCardHtml(t: Technique): string {
    const priced = priceTechnique(t, id => skillOf(id), options)
    const total = Math.round(priced.total)
    const missing = [...new Set((t.skills ?? []).filter(id => skillOf(id) === undefined))]

    /*
     * ⚠⚠ **武器术式不算账**（用户 2026-09-30 第 7 条；判据在 `school.ts` 的
     *   `techniquePaysPoints`）：它的数字来自**武器本身**（射程 / 伤害 / 攻速
     *   由装上的那把武器代入），这一本账根本不存在。
     *
     *   ⚠ 所以判语**必须说出来** —— 空账的合计也是 0，静默显示一个 0
     *     会被读成"配平好了、白送"（"不算账" ≠ "0 点免费"）。
     *   ⚠ 这里只改**取账 / 显示**那一半：布局、CSS、控件一个字节没动。
     */
    const weapon = kindOf(t) === 'weapon'

    let cls = 'ok'
    let verdict = `✓ 已配平${tol > 0 ? `（容差 ±${String(tol)}）` : ''} —— 这份术式可以用了`
    if (missing.length > 0) {
      cls = 'bad'
      verdict = `有 ${String(missing.length)} 个技能在内容库里找不到：${missing.map(esc).join('、')}`
        + ' —— 它们的点数根本没进账，所以合计是不准的。'
    } else if (weapon) {
      verdict = '**武器术式不算账** —— 它的数字来自**武器本身**'
        + '（射程 / 伤害 / 攻速由装上的那把武器代入），定价器看不见那把武器。'
        + '⚠ 这不是"0 点免费"：它的强度体现在**装到哪把武器上**，换一把武器数字就跟着变。'
    } else if (total > 0) {
      cls = 'warn'
      verdict = `还差 ${String(total)} 点额度没用完 —— 加强效果，或者把某一段的代价降下来。额度不用完就是白送。`
    } else if (total < 0) {
      /*
       * ⚠ 合计为负**不是错误** —— 这是**负值术式**（玩家定的）：
       *   > 花超了的术式叫做：负值术式，消耗血契才能释放
       *   所以这里不能说"你错了、去接一段代价零件"。
       */
      cls = 'negative'
      verdict = `这是负值术式：每次释放消耗 ${String(-total)} 点血契（不够就放不出来）。`
        + '血契靠「进入危机的行为」攒 —— 残血、被挂负面状态、抵押属性上限。'
    }

    const detail = priced.entries.map(e =>
      `<div class="te-detail-row"><span class="te-val ${
        e.points > 0 ? 'gain' : e.points < 0 ? 'cost' : ''}">${
        e.points > 0 ? '+' : ''}${String(Math.round(e.points))}</span> ${esc(e.label)}</div>`).join('')

    const perSkill = groupBySkill(priced.entries, t.skills ?? []).map((g, i) => {
      const name = skillOf(g.skillId)?.name ?? g.skillId
      const p = Math.round(g.points)
      return `<div class="te-row"><span class="te-n">${String(i + 1)}</span>`
        + `<span class="te-name">${esc(name)}</span>`
        + `<span class="te-val ${p > 0 ? 'gain' : p < 0 ? 'cost' : ''}">${
          p > 0 ? '+' : ''}${String(p)}</span></div>`
    }).join('')

    return `<div class="sk-card">
      <div class="sk-card-h">点数账<span class="sk-card-n">算出来的，不是调的 · 整数</span></div>
      <div class="te-total">
        <span class="te-total-num ${total > 0 ? 'gain' : total < 0 ? 'cost' : ''}" data-live-ledger>${
          total > 0 ? '+' : ''}${String(total)}</span>
        <span class="dim">${weapon
          ? '合计（武器术式不算账 —— 不是 0 点免费）'
          : total < 0 ? '合计（负 = 负值术式，花血契）' : '合计（必须是 0）'}</span>
      </div>
      <div class="te-verdict ${cls}">${verdict}</div>
      <div class="te-per-seg">${perSkill}</div>
      <details class="te-entries"><summary>看每一笔明细（${
        String(priced.entries.length)} 条 · 改完才刷新）</summary>${detail}</details>
    </div>`
  }

  // ------------------------------------------------------------- 屏 3：修饰副本

  /**
   * **修饰副本自己的编辑界面**（用户定的路径：点中序列里那个零件 → 进这里）。
   *
   * ⚠ 三件事在这一屏上是**只读**的，而且要说清楚为什么：
   *   1. **原型**（这个零件出厂时长什么样）—— 用户点名"只能看，不能建、不能改"；
   *   2. **它是哪一类改写规则**（`kind`）—— 那是引擎的分支，不是一个可调的旋钮；
   *   3. **它的身份** —— 副本只属于这份术式（另存为时才跟着深拷贝）。
   *   能改的只有它自己的那几个数值参数。
   */
  function modEditHtml(): string {
    const t = draft()
    const at = editingMod
    if (t === undefined || at === undefined) return ''

    const mod = (seq0(t).mods ?? [])[at.mi]
    if (mod === undefined) {
      /*
       * 副本没了（在别处被删了）—— **不留一屏"编辑空气"**。
       * 这里只丢一句话，`renderAll()` 下一轮就会按 `editingMod === undefined` 重画。
       * ⚠ 不在这里回头调 `renderEdit()`：那会在挂块过程中再挂一次块（块会套起来）。
       */
      editingMod = undefined
      return '<div class="sk-empty">这个副本已经不在序列里了 —— 返回上一步。</div>'
    }
    const proto = host.modifiers?.get(mod.proto)
    const tpl = modTemplate(mod.proto)
    const p = Math.round(pointsByPath(t).get(`sequences[${String(at.si)}].mods[${String(at.mi)}]`) ?? 0)

    /** 只读地显示一个值（`condition` / `array` / `event` 那几档走这里） */
    const readonlyField = (label: string, v: unknown, why: string): string =>
      `<div class="sk-field"><div class="label"><span>${esc(label)}</span></div>
        <div class="sk-why"><b>${esc(JSON.stringify(v ?? null))}</b><span>${esc(why)}</span></div></div>`

    const control = (key: string, spec: ModParamTemplate): string => {
      const v = modParamValue(mod, key)
      const label = spec.label ?? key
      const field = (inner: string): string =>
        `<div class="sk-field"><div class="label"><span>${esc(label)}</span></div>${inner}</div>`
      const attrs = `data-act="modParam" data-si="${String(at.si)}" data-mi="${String(at.mi)}" data-key="${esc(key)}"`

      if (spec.type === 'boolean') {
        const on = v === true
        return field(`<div class="sk-choice">
          <button class="sk-chip${on ? ' on' : ''}" data-act="modFlag" data-si="${String(at.si)}"
            data-mi="${String(at.mi)}" data-key="${esc(key)}" data-v="true">开</button>
          <button class="sk-chip${on ? '' : ' on'}" data-act="modFlag" data-si="${String(at.si)}"
            data-mi="${String(at.mi)}" data-key="${esc(key)}" data-v="false">关</button></div>`)
      }
      if (spec.type === 'enum' && Array.isArray(spec.values)) {
        return field(`<div class="sk-choice">${spec.values.map(x =>
          `<button class="sk-chip${x === v ? ' on' : ''}" ${attrs} data-v="${esc(x)}">${esc(x)}</button>`
        ).join('')}</div>`)
      }
      if (spec.type === 'condition') {
        /*
         * ⚠ 条件型参数（"看到什么才算数"）这一片**不给编辑器**：
         *   它要的是技能里那**同一套条件控件**（`cond-*` 那一族），
         *   而那是技能页的活。塞一个文本框让玩家手打 JSON 是更坏的选择
         *   —— 打错了没有任何地方会拦。所以这里如实说"现在改不了"。
         */
        return readonlyField(label, v,
          '条件型参数这一片还改不了（要的是技能里那套条件控件）—— 它跟着原型出厂值跑。已记进报告等裁定。')
      }
      if (spec.type === 'array' || spec.type === 'event') {
        return readonlyField(label, v,
          `${spec.type === 'array' ? '列表型' : '事件型'}参数这一片先照原型值跑，不给改（记在报告里等裁定）`)
      }
      const range = spec.min === undefined && spec.max === undefined
        ? ''
        : `范围 ${spec.min === undefined ? '—' : String(spec.min)} ~ ${spec.max === undefined ? '—' : String(spec.max)}`
      return field(`<input ${attrs} type="${spec.type === 'number' ? 'number' : 'text'}"
        value="${esc(String(v ?? ''))}"${spec.step === undefined ? '' : ` step="${String(spec.step)}"`}
        style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:7px 9px;color:#e6edf3">
        ${range === '' ? '' : `<div class="sk-why"><span>${esc(range)}</span></div>`}`)
    }

    const params = Object.keys(tpl).length === 0
      ? '<div class="sk-empty">这个原型没声明参数（它出厂就是这个样子）</div>'
      : Object.entries(tpl).map(([k, spec]) => control(k, spec)).join('')

    return `<div class="sk-page">
      <div class="sk-edithead">
        <button data-act="modBack">✕ 返回这条序列</button>
        <span class="sk-t">${esc(proto?.name ?? mod.proto)}（副本）</span>
        <span class="sk-sub">修饰零件 · 只属于这份术式</span>
        <span class="sk-spacer"></span>
        <span class="sk-ops"><button data-act="modDel" data-si="${String(at.si)}"
          data-mi="${String(at.mi)}">从序列里删掉它</button></span>
      </div>
      <div class="sk-card">
        <div class="sk-card-h">它在做什么<span class="sk-card-n">原型 ${esc(mod.proto)} · 只读</span></div>
        <div class="sk-dnote">${esc(proto?.note ?? '（原型没写说明）')}</div>
        <div class="sk-why">修饰零件不讲"前摇 / 命中 / 后摇"，它讲的是一条<b>改写规则</b>。
          <b>原型只能看，不能建、不能改</b> —— 能改的只有这份术式里这个副本的参数。</div>
      </div>
      <div class="sk-card">
        <div class="sk-card-h">它自己的参数<span class="sk-card-n">点数按这里的值算，不是写死的</span></div>
        ${params}
      </div>
      <div class="sk-card">
        <div class="sk-card-h">这个零件花多少<span class="sk-card-n">整数</span></div>
        <div class="te-total">
          <span class="te-total-num ${p > 0 ? 'gain' : p < 0 ? 'cost' : ''}" data-live-ledger>${
            p > 0 ? '+' : ''}${String(p)}</span>
          <span class="dim">它在这份术式的账里自己占的那几笔（改完参数才刷新）</span>
        </div>
      </div>
    </div>`
  }

  /**
   * 连接门（`links[i]` 管的是 `skills[i+1]`）。
   *
   * ⚠ 这句话要**显示在界面上**，不能只在文档里：
   *   平行数组最容易错的就是"这一条管的是哪一段"。
   */
  function gateHtml(i: number, tick: string): string {
    const t = draft()
    if (t === undefined) return ''
    const seg = seq0(t)
    const link = seg.links?.[i] ?? {}
    const conds = link.if ?? []

    const condRows = conds.map((c, ci) => conditionRowHtml(i, ci, c)).join('')
    const summary = conds.length === 0
      ? '<span class="dim">无条件 —— 上一段跑完就进这一段</span>'
      : `<span class="dim">以上全部成立才进入第 ${tick} 段；不成立就跳过它，接着往后走</span>`

    return `<div class="te-gate">
      <div class="te-gate-head">
        <span class="te-gate-title">进入第 ${tick} 段的条件</span>
        <button data-act="cond-add" data-l="${String(i)}">＋ 加条件</button>
        ${conds.length > 0 ? `<button data-act="cond-clear" data-l="${String(i)}">清空</button>` : ''}
      </div>
      ${condRows}
      <div class="te-gate-sum">${summary}</div>
    </div>`
  }

  function conditionRowHtml(linkIndex: number, condIndex: number, c: Condition): string {
    const spec = specOf(c.type)
    const opts = COND_SPECS
      .map(s => `<option value="${s.type}"${s.type === c.type ? ' selected' : ''}>${esc(s.label)}</option>`)
      .join('')

    let argHtml = ''
    if (spec?.who === true) {
      argHtml += `<select data-act="cond-who" data-l="${String(linkIndex)}" data-c="${String(condIndex)}">`
        + ['target', 'self', 'caster'].map(w =>
          `<option value="${w}"${(c.who ?? 'target') === w ? ' selected' : ''}>${
            w === 'target' ? '目标' : w === 'self' ? '自己' : '施法者'}</option>`).join('')
        + '</select>'
    }

    switch (spec?.arg) {
      case 'text':
        argHtml += `<input data-act="cond-value" data-l="${String(linkIndex)}" data-c="${
          String(condIndex)}" value="${esc(String(c.value ?? ''))}" placeholder="标签名" size="10">`
        break
      case 'number':
        argHtml += `<input type="number" step="0.05" min="0" max="1" data-act="cond-value"
          data-l="${String(linkIndex)}" data-c="${String(condIndex)}"
          value="${String(c.value ?? 0)}"> <span class="dim">（0~1，0.3 = 三成血）</span>`
        break
      case 'range':
        argHtml += `<input type="number" step="0.5" data-act="cond-min" data-l="${String(linkIndex)}"
          data-c="${String(condIndex)}" value="${String(c.range?.[0] ?? 0)}" size="4"> ~ `
          + `<input type="number" step="0.5" data-act="cond-max" data-l="${String(linkIndex)}"
          data-c="${String(condIndex)}" value="${String(c.range?.[1] ?? 0)}" size="4"> <span class="dim">米 / 个</span>`
        break
      case 'statusId': {
        const ids = knownStatusIds()
        argHtml += `<select data-act="cond-value" data-l="${String(linkIndex)}" data-c="${
          String(condIndex)}">`
          + ids.map(id => `<option value="${esc(id)}"${c.value === id ? ' selected' : ''}>${
            esc(id)}</option>`).join('')
          + '</select>'
        break
      }
      case 'hitKind':
        argHtml += `<select data-act="cond-value" data-l="${String(linkIndex)}" data-c="${
          String(condIndex)}">`
          + ['damage', 'heal'].map(k =>
            `<option value="${k}"${c.value === k ? ' selected' : ''}>${
              k === 'damage' ? '伤害' : '治疗'}</option>`).join('')
          + '</select>'
        break
      default:
        break
    }

    return `<div class="te-cond">
      <select data-act="cond-type" data-l="${String(linkIndex)}" data-c="${String(condIndex)}">${opts}</select>
      ${argHtml}
      <button data-act="cond-del" data-l="${String(linkIndex)}" data-c="${String(condIndex)}"
        title="删掉这个条件">×</button>
      <span class="dim">= ${esc(describeCondition(c))}</span>
    </div>`
  }

  /**
   * 重画整页。
   *
   * ⚠ 和技能编辑器同一个道理（见 `web/src/editor.ts` 的 `render()`）：
   *   整块 `innerHTML` 重写会把**焦点/光标**和**滚动位置**砸掉
   *   （玩家实测报过"往下滚了之后点一格，页面弹回最上面"）。
   *   所以这里包一层：画之前记下、画完放回去 —— 两样都记。
   */
  function renderAll(): void {
    const focus = captureFocus(body)
    const scroll = captureScroll(body)
    renderAllInner()
    restoreFocus(body, focus)
    restoreScroll(body, scroll)
  }

  /**
   * 渲染 = **一块一块挂**（玩家 2026-09-21 定的"结构固定、只更新变化的数"）。
   *
   * ⚠ 为什么不是拼一大串 `innerHTML` 一次写进去：
   *   一串里只要有一个字变了，整串都得重建 —— 于是 `<details open>` 会合上、
   *   CSS transition 从头开始。
   *
   * ⚠ 这一页现在只有**两块**（库那一屏 / 编辑那一屏），而不是技能页那种
   *   "一张卡一块"。理由：这一页里序列 / 账 / 技能库是**耦合**的
   *   （加一个零件要同时改这三处），拆细之后块与块之间还得互相同步 ——
   *   成本比收益大。所以按屏分块、屏内一次拼好。
   */
  function renderAllInner(): void {
    // ⚠ 账**只算一次**（列表上每一行都要它，按行各算一遍是 20 倍的浪费）
    ledger = ledgerCache()
    if (currentId === undefined || !host.mine.has(currentId)) ensureSelect()
    renderLibrary()
    renderEdit()
    /*
     * ⚠ **两块都列着**，不按当前屏裁剪 —— 两屏的关键区别是"另一块套了一层
     *   `display:none` 的壳"（照模板：`#viewTech` / `#editTech` 都在 DOM 里）。
     *   按屏裁剪的话，切屏时那一块会被删掉再重建，`<details open>` / transition 全丢。
     */
    endBlocks(body, ['tech-libpage', 'tech-editpage'])
  }

  // ---------------------------------------------------------------- 改动

  /**
   * 选中一份"我的术式"。
   *
   * ⚠ **不自动新建。** 打开游戏/点开编辑器不该凭空多出一份空术式 ——
   *   那会立刻写进存档，而且它会以"编译不出来"的形式刷一屏红字。
   *   没有就是没有，界面上给一句"点新建开始拼"。
   *
   * ⚠ 它**只选、不画**（画的活是 `renderAllInner` 的）——
   *   在这里回头调 `renderAll()` 会在挂块过程中再挂一次块（块会套起来）。
   */
  function ensureSelect(): void {
    if (currentId !== undefined && host.mine.has(currentId)) return
    /*
     * 默认选中**技能栏上装着的那一份** —— 打开编辑器时最可能想看的就是它。
     * （2026-09-21 之前是"id 排序第一个"。加了开局补发的起手术式之后，
     *   排序第一个变成了那份起手，而玩家自己排上场的那份反而要手点一下。）
     * 一份都没装才退回排序第一个 —— 至少它是稳定的，不会每次打开都换一个。
     */
    currentId = host.loadout.find(id => host.mine.has(id)) ?? [...host.mine.keys()].sort()[0]
  }

  function nextId(): string {
    const used = new Set([...host.mine.keys(), ...(host.takenIds ?? [])])
    let n = 1
    while (used.has(`tech.mine-${n}`)) n++
    return `tech.mine-${n}`
  }

  /**
   * 新建一份**空术式**。
   *
   * ⚠ `kind` 由**按钮**给（"＋ 新建一个武器术式" / "＋ 新建一个魔法术式"），
   *   因为 schema 定死了"**新建时由玩家选，之后不能改**"：
   *   允许事后改的话，"改一下系别"会把里面已经引用的技能全部变成非法。
   * ⚠ 空术式的形状是 `sequences: [{ skills: [] }]` —— **不是** `skills: []`：
   *   这一页所有编辑都发生在段上（副本的家也在段上），先有段才加得进东西。
   *   ⚠ 空段是合法的（校验器一条都不报，`tech.skills` 也是空 ⇒ 引擎不会放两遍）。
   */
  function createNew(kind: 'weapon' | 'magic'): void {
    const id = nextId()
    host.mine.set(id, {
      schemaVersion: 1,
      id,
      name: `${kind === 'weapon' ? '武器' : '魔法'}术式 ${String(host.mine.size + 1)}`,
      kind,
      /*
       * ⚠ 默认 `press`（按一下）：常驻（`auto`）是**玩家自己选的一档**，
       *   而他这一片只能通过"魔法术式 → 常驻术式"那一组的归属看出来 ——
       *   新建时默认给常驻的话，玩家会拿到一个"装上就生效、按键没反应"的东西，
       *   而界面上没有任何地方告诉他为什么。
       */
      activation: 'press',
      // ⚠ 不写 `targeting`：**术式没有瞄准**（2026-09-21 日志 47），它在技能上
      sequences: [{ skills: [] }],
      skills: [],
    })
    currentId = id
    touchedStructurally()
  }

  /**
   * 库那一屏**点一行**：选中它（只是高亮 + 把详情读进来），**不自动进编辑屏**
   * —— 照设计模板，按了「编辑此术式」才进去。
   */
  function selectTech(id: string): void {
    if (!host.mine.has(id)) return
    currentId = id
    view = 'lib'
    editingMod = undefined
    renderAll()
  }

  function copyCurrent(): void {
    const src = draft()
    if (src === undefined) return
    const id = nextId()
    /*
     * ⚠ **整体 JSON 深拷贝 —— 修饰副本就是靠它跟着走的**（2026-09-21 日志 48）。
     *
     *   定稿 §八 要的是："术式'另存为'时**副本跟着深拷贝**，之后两份互相独立"。
     *   而副本住在 `sequences[i].mods` 里（两层数组）——
     *   这一句 `JSON.parse(JSON.stringify(...))` **两层都覆盖到了** ✓，
     *   所以这里**不需要**再补一次（补了反而多一份会漂移的拷贝逻辑）。
     *
     *   ⚠⚠ **别把它改成浅拷贝**（`{ ...src }` 或 `structuredClone` 之外的手写拷贝）：
     *     浅拷贝之后两份术式的副本是**同一个对象** —— 改一份的条件，
     *     另一份跟着变，而且**没有任何地方会报错**（表现是"我明明只改了这一份"）。
     *     这是这一片最容易被下一次重构踩掉的一条，所以写在这儿。
     *
     *   ⚠ 普通技能**照旧是引用**（不深拷贝）：序列里存的是技能 id，
     *     深拷贝它们没有意义（它们根本不在术式里）。见 `web/src/store.ts`
     *     的 `cloneModifierCopies`（同一个规矩的另一处落点）。
     */
    const copy = JSON.parse(JSON.stringify(src)) as Technique
    copy.id = id
    copy.name = `${src.name} 副本`
    host.mine.set(id, copy)
    currentId = id
    touchedStructurally()
  }

  function deleteCurrent(): void {
    if (currentId === undefined) return
    host.mine.delete(currentId)
    const i = host.loadout.indexOf(currentId)
    if (i >= 0) host.loadout.splice(i, 1)
    currentId = [...host.mine.keys()].sort()[0]
    touchedStructurally()
  }

  function exportJson(): void {
    const t = draft()
    if (t === undefined) return
    const blob = new Blob([JSON.stringify(t, null, 2) + '\n'], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${t.id.replace(/^tech\./, '')}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  function notice(msg: string): void {
    if (host.onNotice !== undefined) host.onNotice(msg)
  }

  /** 装进"我的术式"并选中它。导入和兑换分享码都走这里 */
  function adopt(t: Technique, renamed: boolean): void {
    const id = host.mine.has(t.id) || (host.takenIds?.has(t.id) ?? false) ? nextId() : t.id
    const copy = JSON.parse(JSON.stringify(t)) as Technique
    copy.id = id
    if (renamed) copy.name = `${t.name}（导入）`
    host.mine.set(id, copy)
    currentId = id
    touchedStructurally()

    // 缺技能要**当场说**，不能等他按下去发现没反应
    const missing = chainOf(copy).filter(s => !(skillOf(s) !== undefined))
    if (missing.length > 0) {
      notice(`导入成功，但内容库里没有这几个技能：${missing.join('、')} —— `
        + '那几段不会有任何效果，换成你自己的技能。')
    }
  }

  function importJson(): void {
    if (host.onPaste === undefined) return
    const text = host.onPaste()
    if (text === undefined || text.trim() === '') return

    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (e) {
      notice(`这不是合法的 JSON：${String(e)}`)
      return
    }
    // 允许一次贴一整份数组
    const list = Array.isArray(raw) ? raw : [raw]
    let n = 0
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue
      const o = item as Record<string, unknown>
      if (typeof o['id'] !== 'string' || !Array.isArray(o['skills'])) {
        notice('这段 JSON 看起来不是一份术式（缺 id 或 skills）')
        continue
      }
      adopt(item as Technique, true)
      n++
    }
    if (n > 0) notice(`导入了 ${n} 份术式`)
  }

  function share(): void {
    const t = draft()
    if (t === undefined) return
    if (host.onCopy === undefined) return
    /*
     * ⚠ 码里**带着这份术式用到的自定义技能**（玩家 2026-09-21 定的）。
     *   收码的人不需要先有那些技能 —— 它们会被导进他的自定义技能库。
     *   不带的话他拿到的是一份跑不起来的连招。
     */
    host.onCopy(encodeShareSafe(t, host.bundleFor?.(t) ?? []))
  }

  function redeem(): void {
    if (host.onPaste === undefined) return
    const code = host.onPaste()
    if (code === undefined || code.trim() === '') return
    const res = decodeShareSafe(code)
    if (!res.ok) {
      notice(`分享码用不了：${res.error}`)
      return
    }
    // ⚠ 码里的自定义技能先入库（有冲突时宿主会问玩家），再采用术式
    let tech = res.technique
    const notes: string[] = []
    if (host.onRedeem !== undefined && res.skills.length > 0) {
      const out = host.onRedeem(res.technique, res.skills)
      tech = out.technique
      notes.push(...out.notes)
    }
    adopt(tech, true)
    notice(`已导入「${tech.name}」${notes.length > 0 ? `　（${notes.join('；')}）` : ''}`)
  }

  // ---------------------------------------------------------------- 事件

  /** 这一下点的是哪个零件（`data-si` = 第几条序列 / `data-i` = 第几个技能 / `data-mod` = 第几个副本） */
  function partAt(el: HTMLElement): { si: number; i: number; mi: number } {
    return {
      si: Number(el.dataset['si'] ?? '0'),
      i: Number(el.dataset['i'] ?? '-1'),
      mi: Number(el.dataset['mod'] ?? '-1'),
    }
  }

  function addPart(id: string): void {
    const t = draft()
    if (t === undefined) return
    const seg = seq0(t)
    seg.skills.push(id)
    syncChain(t)
    // 新加的和前一个之间默认没有门（无条件进入）—— 门那一排自己会往回缩
    syncLinks(t)
    touchedStructurally()
  }

  body.addEventListener('input', (ev) => {
    const el = ev.target as HTMLElement
    const act = el.dataset['act']
    const t = draft()
    if (t === undefined || act === undefined) return

    switch (act) {
      case 'search':
        /*
         * ⚠ 搜索框打字**不回写草稿**（它不是一个数据字段，只是这一屏的过滤词）。
         *   回写的话，"搜过什么"会被存进存档 —— 那不是玩家的数据，是界面的状态。
         */
        query = (el as HTMLInputElement).value
        renderAll()
        break
      case 'name':
        t.name = (el as HTMLInputElement).value
        touched()
        break
      case 'cond-value': {
        const c = condAt(t, el.dataset['l'], el.dataset['c'])
        if (c === undefined) break
        const raw = (el as HTMLInputElement | HTMLSelectElement).value
        // hpBelow 是 0~1 的比例，别的条件是字符串
        c.value = specOf(c.type)?.arg === 'number' ? Number(raw) : raw
        touched()
        break
      }
      case 'cond-min':
      case 'cond-max': {
        const c = condAt(t, el.dataset['l'], el.dataset['c'])
        if (c === undefined) break
        const v = Number((el as HTMLInputElement).value)
        const r: [number, number] = c.range ?? [0, 0]
        if (act === 'cond-min') r[0] = v
        else r[1] = v
        c.range = r
        touched()
        break
      }
      /*
       * ⚠ **修饰副本自己的参数**（用户定的路径：点中序列里的那个零件 → 进它的编辑界面改）。
       *   这里只**写值**，不重画 —— 重画会把正在输入的那个框换掉（焦点和光标全丢，
       *   和技能页那几处滑块是同一条规矩）。`change` 那一侧才重画。
       */
      case 'modParam': {
        const at = partAt(el)
        const mod = (seq0(t).mods ?? [])[at.mi]
        const key = el.dataset['key']
        if (mod === undefined || key === undefined) break
        const raw = (el as HTMLInputElement).value
        const spec = modTemplate(mod.proto)[key]
        if (spec?.type === 'number') {
          const n = Number(raw)
          // ⚠ 空串 / 非数**不许写成 NaN**：NaN 进了 JSON 会变成 null，
          //   而引擎读到 null 会当成"没写"⇒ 静默回落到原型默认值。
          if (!Number.isFinite(n)) break
          mod.params[key] = n
        } else {
          mod.params[key] = raw
        }
        touched()
        break
      }
      default:
        break
    }
  })

  body.addEventListener('change', (ev) => {
    const el = ev.target as HTMLElement
    const act = el.dataset['act']
    const t = draft()
    if (act === undefined) return

    // ⚠ 输入框失焦时才整块重画（把新的账算出来），打字期间只改草稿
    if (act === 'modParam' || act === 'name') {
      renderAll()
      return
    }

    if (act === 'search') {
      query = (el as HTMLInputElement).value
      renderAll()
      return
    }
    if (t === undefined) return

    switch (act) {
      case 'slot': {
        const idx = Number((el as HTMLSelectElement).value)
        const at = host.loadout.indexOf(t.id)
        if (at >= 0) host.loadout.splice(at, 1)
        if (idx >= 0) {
          // 目标位置上已经有别人就顶掉它
          while (host.loadout.length <= idx) host.loadout.push('')
          host.loadout[idx] = t.id
          host.loadout = host.loadout.filter(x => x !== '')
        }
        host.onChanged()
        renderAll()
        break
      }
      case 'cond-type': {
        const l = Number(el.dataset['l'])
        const c = Number(el.dataset['c'])
        const link = linkAt(t, l)
        if (link === undefined || link.if === undefined) break
        link.if[c] = newCondition((el as HTMLSelectElement).value as ConditionType)
        touchedStructurally()
        break
      }
      case 'cond-who': {
        const c = condAt(t, el.dataset['l'], el.dataset['c'])
        if (c === undefined) break
        c.who = (el as HTMLSelectElement).value as Condition['who']
        touched()
        break
      }
      default:
        break
    }
  })

  body.addEventListener('click', (ev) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]')
    if (el === null) return
    const act = el.dataset['act']
    if (act === undefined) return
    const t = draft()
    const at = partAt(el)

    /*
     * ---- 不依赖"当前有没有草稿"的那几颗（库那一屏的入口 / 导入分享） ----
     * ⚠ 它们必须排在 `t === undefined` 那道门**前面**：库里一份术式都没有时，
     *   "＋ 新建一个魔法术式"就是唯一能点的东西 —— 排在门后面的话，
     *   玩家会面对一个**永远点不动的新建按钮**（而且不报错）。
     */
    switch (act) {
      case 'newTech': {
        // ⚠ 系别**新建时定、之后不能改**（schema 定的）——所以它是按钮的参数
        createNew(el.dataset['kind'] === 'weapon' ? 'weapon' : 'magic')
        return
      }
      case 'pickTech': {
        const id = el.dataset['i']
        if (id !== undefined) selectTech(id)
        return
      }
      case 'import': importJson(); return
      case 'redeem': redeem(); return
      default: break
    }

    if (t === undefined) return

    switch (act) {
      // ---- 库那一屏 / 两屏之间的来回 ----
      case 'openEdit':
        view = 'edit'
        editingMod = undefined
        renderAll()
        break
      case 'techBack':
      case 'modBack':
        // ⚠ 从副本那一屏退出来是**回术式编辑屏**（不是回库）——用户定的层级
        editingMod = undefined
        if (act === 'techBack') view = 'lib'
        renderAll()
        break
      case 'saveAs': copyCurrent(); break
      case 'del': deleteCurrent(); break
      case 'export': exportJson(); break
      case 'copy': share(); break
      case 'rename': {
        /*
         * ⚠ 改名字用 `prompt`（宿主给的 `onPaste` 那条路是**分享码 / JSON**，
         *   文本完全不同，不能复用）。名字是**存档里的数据**，不是一个可调旋钮 ——
         *   技能页那边也是用输入框直接改，这里照同一件事做。
         */
        const next = window.prompt('这份术式叫什么？', t.name)
        if (next === null || next.trim() === '') break
        t.name = next.trim()
        touchedStructurally()
        break
      }

      // ---- 序列 / 零件 ----
      case 'newSeq': {
        const seqs = t.sequences ?? (t.sequences = [])
        seqs.push({ skills: [] })
        touchedStructurally()
        break
      }
      case 'seqDel': {
        const seqs = t.sequences ?? []
        if (at.si < 0 || at.si >= seqs.length) break
        seqs.splice(at.si, 1)
        if (editingMod !== undefined && editingMod.si === at.si) editingMod = undefined
        syncChain(t)
        touchedStructurally()
        break
      }
      case 'addPart': {
        const id = el.dataset['id']
        if (id !== undefined) addPart(id)
        break
      }
      case 'addMod': {
        const id = el.dataset['id']
        if (id !== undefined) addMod(id)
        break
      }
      case 'addSlot':
        // 空位就是"再加一个技能"的入口（照模板那个 `＋` 格子）——
        // 真正加哪个技能由左边技能库决定，所以这里只把玩家引到那儿
        notice('从左边技能库里点一个技能就加进来了（它排在末尾）。')
        break
      case 'partUp': moveSkill(at.si, at.i, -1); break
      case 'partDown': moveSkill(at.si, at.i, 1); break
      case 'partDel': dropSkill(at.si, at.i); break
      /*
       * ⚠ **点中序列里的那个零件 = 进它自己的编辑界面**（用户定的路径）。
       *   技能 → 这一页不编技能，去**技能页**编（那是另一个页签的活）；
       *   修饰副本 → 进它自己的那一屏（这一页能编）。
       */
      case 'openPart': {
        if (at.mi >= 0) {
          editingMod = { si: at.si, mi: at.mi }
          renderAll()
          break
        }
        const id = seq0(t).skills[at.i]
        const name = id === undefined ? undefined : skillOf(id)?.name
        notice(`技能「${name ?? id ?? '？'}」在**技能页**里编（Tab 切到「技能」那一页）——
          这一页只管把它排进序列。`)
        break
      }

      // ---- 修饰副本自己的那一屏 ----
      case 'modFlag':
      case 'modParam': {
        const mod = (seq0(t).mods ?? [])[at.mi]
        const key = el.dataset['key']
        if (mod === undefined || key === undefined) break
        const spec = modTemplate(mod.proto)[key]
        if (act === 'modFlag' || spec?.type === 'boolean') {
          mod.params[key] = el.dataset['v'] === 'true'
        } else if (spec?.type === 'enum' || spec?.type === 'string') {
          mod.params[key] = el.dataset['v'] ?? ''
        } else {
          const n = Number(el.dataset['v'])
          if (!Number.isFinite(n)) break
          mod.params[key] = n
        }
        touchedStructurally()
        break
      }
      case 'modDel': dropMod(at.si, at.mi); break

      // ---- 序列里的条件门（`links`，管的是"上一段打中了才进下一段"）----
      case 'cond-add': {
        const link = ensureLink(t, Number(el.dataset['l']))
        const ifs = link.if ?? (link.if = [])
        ifs.push(newCondition('prevHit'))
        touchedStructurally()
        break
      }
      case 'cond-clear': {
        const link = linkAt(t, Number(el.dataset['l']))
        if (link !== undefined) delete link.if
        touchedStructurally()
        break
      }
      case 'cond-del': {
        const l = Number(el.dataset['l'])
        const c = Number(el.dataset['c'])
        const link = linkAt(t, l)
        if (link?.if === undefined) break
        link.if.splice(c, 1)
        if (link.if.length === 0) delete link.if
        touchedStructurally()
        break
      }
      default:
        break
    }
  })

  // ---------------------------------------------------------------- 起手

  /*
   * ⚠ 起手**停在库那一屏**（照模板：打开编辑器先看到"有哪些术式"）。
   *   而且**不自动新建** —— 打开游戏/点开编辑器不该凭空多出一份空术式：
   *   那会立刻写进存档，还会以"编译不出来"的形式刷一屏红字（玩家之前报过）。
   */
  ensureSelect()
  renderAll()

  return {
    /**
     * 重画一次。
     *
     * ⚠ 从别的页面切过来时**回到库那一屏**（"看一眼就关"是常见用法）——
     *   停在半路的"正在编辑某个副本"会让玩家下次切进来一脸问号。
     */
    refresh(): void {
      ensureSelect()
      view = 'lib'
      editingMod = undefined
      renderAll()
    },
  }
}

// ============================================================================
//  小工具
// ============================================================================

/**
 * `links` 的长度必须跟着**段里的技能**走。
 *
 * ⚠ 这里是**唯一**会动 `links` 长度的地方，而且只减不增 ——
 *   新加的段默认没有门（无条件进入）。多出来的门指向一个不存在的技能，
 *   是**静默失效**的：玩家以为写了条件，实际那段永远执行。
 *   （校验器会报 `TOO_MANY_LINKS`，但不该让玩家先写出错的再被骂。）
 * ⚠ 长度**取段**（`seq0`），不是取 `tech.skills`：门是段里的事
 *   （`SequenceSegment.links`），而 `tech.skills` 只是账读的那一份副本。
 */
function syncLinks(t: Technique): void {
  const max = Math.max(0, seq0(t).skills.length - 1)
  if (t.links === undefined) return
  if (t.links.length > max) t.links.length = max
}

/*
 * ⚠ 门（`links`）读写的**唯一入口**：段上那一份。
 *   引擎读的是 `SequenceSegment.links`（`compile.ts` 把段交给 `compileSkillChain`），
 *   而 `Technique.links` 那一份在这一页**不再写** —— 两处都写迟早漂
 *   （表现是"界面上写了条件，实际每一段都执行"）。
 */
function linkArrayOf(t: Technique): NonNullable<Technique['links']> {
  const seg = seq0(t)
  return seg.links ?? (seg.links = [])
}

function ensureLink(t: Technique, i: number): NonNullable<Technique['links']>[number] {
  const links = linkArrayOf(t)
  while (links.length <= i) links.push({})
  return links[i] as NonNullable<Technique['links']>[number]
}

function linkAt(t: Technique, i: number): NonNullable<Technique['links']>[number] | undefined {
  return seq0(t).links?.[i]
}

function condAt(t: Technique, l: string | undefined, c: string | undefined): Condition | undefined {
  if (l === undefined || c === undefined) return undefined
  return seq0(t).links?.[Number(l)]?.if?.[Number(c)]
}

function swap<T>(arr: T[], a: number, b: number): void {
  const tmp = arr[a] as T
  arr[a] = arr[b] as T
  arr[b] = tmp
}

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100)
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c
  ))
}

/*
 * ⚠ 分享码的编解码实现在 `store.ts`，不在这里。
 *   原因：它是唯一处理"别人给的字符串"的地方，必须有测试盯着
 *   （截断的码、别的版本的码、乱改的码）。界面这一层只管调用。
 */

function encodeShareSafe(t: Technique, skills: Skill[]): string {
  return encodeShare(t, skills)
}

function decodeShareSafe(code: string): ReturnType<typeof decodeShare> {
  return decodeShare(code)
}

/** 给外部（测试）用的出口：术式的账怎么算，和在界面上看到的是同一份 */
export function techniqueLedger(
  t: Technique,
  skills: ReadonlyMap<string, Skill>,
  balance: BalanceConfig,
  statuses?: ReadonlyMap<string, StatusDef>,
  modifiers?: ReadonlyMap<string, ModifierProto>,
): { total: number; per: { skillId: string; points: number }[]; entries: PriceEntry[] } {
  const options: PriceOptions = {
    rates: readRates(balance.rates),
    baseRuleSlots: balance.baseRuleSlots,
    ruleSlotBuyCost: balance.ruleSlotBuyCost,
    ruleSlotSellGain: balance.ruleSlotSellGain,
    tolerance: typeof balance.balanceTolerance === 'number' ? balance.balanceTolerance : 0,
    // ⚠ 全量点表（2026-09-30 日志 60b）：这一份是"给外部（测试）用的出口"，
    //   它必须和界面上那一份**逐字相同**（否则测试绿着、界面是另一个数）。
    lookupTable: readLookupTable(balance.lookupTable),
    ...(statuses !== undefined ? { statuses } : {}),
    // ⚠ 同上：不传的话份数类修饰在账上一笔都不记（见 `createTechniqueEditor` 里那一段）
    ...(modifiers !== undefined ? { modifiers } : {}),
  }
  const priced = priceTechnique(t, id => skills.get(id), options)
  const groups = groupBySkill(priced.entries, chainOf(t))
  return {
    total: priced.total,
    per: groups.map(g => ({ skillId: g.skillId, points: g.points })),
    entries: priced.entries,
  }
}
