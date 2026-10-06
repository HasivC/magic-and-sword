import type {
  ActivationMode, EntityDef, ModifierKind, ModifierProto, SequenceSegment, Skill, SkillForm, StatusDef,
  Technique, WeaponDef,
} from '../schema.ts'
import type {
  BalanceConfig, CheckGroupReport, Issue, LedgerEntry, ValidationReport,
} from './types.ts'
import * as checks from './checks.ts'
import { allRulesOf } from '../effects.ts'
import { bloodPactCostOf, bloodPactOfResult, defaultTargetOf, lookupGapsOf, phaseTierProblems, priceOptionsFor, priceSkill, priceTechnique, readLookupTable } from '../pricing.ts'
import type { PriceOptions } from '../pricing.ts'
/*
 * ⚠ 份数 / 等待 / 排布的**下限 / 读法 / 上限**只有一处声明（`src/school.ts`，
 *   日志 51 / 52 / 53）—— 编译期、校验器、账三处共用它。这里只引，不再抄一遍。
 *   抄一遍的下场是漂移，而漂移是静默的：校验器说"3 秒没问题"、
 *   引擎那边按 0.2 夹住了。
 */
import {
  carrierFliesInWorld,
  MODIFIER_BOUNCE_COUNT_KEY, MODIFIER_BOUNCE_FALLOFF_KEY,
  MODIFIER_BOUNCE_COUNT_MIN, modifierBounceCountOf, modifierBounceFalloffOf,
  modifierBounceMaxCountOf, modifierBounceMaxFalloffOf, modifierBounceMinFalloffOf,
  MODIFIER_CONDITION_KEY, MODIFIER_COUNT_KEY,
  MODIFIER_HOMING_MAX_RANGE_KEY, MODIFIER_HOMING_MAX_TURN_KEY,
  MODIFIER_HOMING_MIN_RANGE_KEY, MODIFIER_HOMING_RANGE_KEY,
  MODIFIER_HOMING_TURN_KEY, MODIFIER_HOMING_TURN_MIN,
  MODIFIER_INTERRUPT_KEY, MODIFIER_INTERRUPT_VALUES,
  MODIFIER_LAYOUT_EVEN_KEY, MODIFIER_LAYOUT_MIRROR_KEY, MODIFIER_LAYOUT_MODES,
  MODIFIER_LAYOUT_RADIUS_KEY, MODIFIER_LAYOUT_SPREAD_KEY, MODIFIER_LAYOUT_START_KEY,
  MODIFIER_LAYOUT_TYPE_KEY, MODIFIER_LOCK_ENGINE_RESERVED, MODIFIER_LOCKS_DEFAULT,
  MODIFIER_LOCKS_KEY, MODIFIER_LOCK_VALUES, MODIFIER_SECONDS_KEY,
  MODIFIER_SECONDS_MIN, modifierCountOf, modifierHomingMaxRangeOf, modifierHomingMaxTurnOf,
  modifierHomingMinRangeOf,
  modifierLayoutMaxAngleOf, modifierLayoutMaxSpreadOf,
  modifierLayoutModeOf, modifierLayoutRadiusOf, modifierSecondsOf,
  isConstantSequence,
  techniquePaysPoints,
} from '../school.ts'

/*
 * ⚠ 这个 `EPS` 原来配着"配平容差"一起用（`|合计| > 容差 + EPS` 才报错）。
 *   2026-09-30（日志 57）容差删了，它也就**没有用处了** —— 判据只剩
 *   "合计 < 0 就是负值术式"（见下面那段），而合计是**整数**。
 *   留着它只会让下一个人以为"这里还有一条宽容线"。
 */

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * 这门术式是不是**纯常驻**（它有序列，而且**每一条**都是常驻序列）。
 *
 * ⚠ 判据**不在这里另写**：每一条读的是 `school.ts` 的 `isConstantSequence`
 *   （= `hasConstantWrapper`，`at === 0` 的 `wrap` 副本 —— 和
 *   `sim/compile.ts` 的 `constantSegments` 是**同一句**）。
 *   这里只有**两件事**属于校验器：① "有没有序列"（空术式见下面那条注释）、
 *   ② "是不是每一条都是"。
 *
 * ## ⚠ 三段式表里它决定**错误还是警告**
 *
 * 定稿第十二节：**纯常驻**术式常驻那半为负 ⇒ **报错**（它连主动那半都没有，
 * 负的额度没有任何出口）；**混合**术式里常驻那半为负 ⇒ **同样报错**
 * （2026-10-06 日志 66 从警告升上来：那是**同一条硬约束**，不该两种档）。
 * ⚠ 所以这一句今天**只决定措辞**（"只有常驻序列" / "两种都有"），不决定级别。
 *
 * ## ⚠ 空术式 / 只有 `skills` 没有序列的术式 ⇒ `false`（按"不是纯常驻"）
 *
 *   两条都不是"纯常驻"：前者没有序列可切（`threeSection` 也不会出现，
 *   因为切分是按段做的、一段都没有时两半都是 0）；后者的技能挂在**术式层**，
 *   而术式层那半边**属于主动**（玩家按那个键）。
 *   ⇒ 这一句只在"有序列、且每条都是常驻"时才为真。
 */
function allSequencesAreConstant(
  tech: Technique,
  protos?: ReadonlyMap<string, ModifierProto>,
): boolean {
  const seqs = tech.sequences ?? []
  if (seqs.length === 0) return false
  return seqs.every(seg => typeof seg !== 'string' && isConstantSequence(seg, protos))
}

/**
 * 这些载荷「落在谁身上」会改变**符号**。
 * 和 `checks.ts` 里那张 `AFFECTS_OTHERS` 是同一件事，两边必须一起改。
 */
const SIGN_CHANGING: ReadonlySet<string> = new Set([
  'attribute', 'status', 'perception', 'displacement',
])

/**
 * 定价选项。⚠ 真正的拼装逻辑在 `pricing.ts` 的 `priceOptionsFor` ——
 *   命令行、浏览器、校验器必须用**同一份**，否则同一个内容会算出不同的账。
 */
function priceOptions(
  balance: BalanceConfig,
  statuses?: ReadonlyMap<string, StatusDef>,
  entities?: ReadonlyMap<string, EntityDef>,
  modifiers?: ReadonlyMap<string, ModifierProto>,
): PriceOptions {
  /*
   * ⚠ 修饰原型表也传下去（日志 51）：份数类修饰的账要靠它认。
   *   不传的话，那一笔**一笔都不记**，而"没记"和"免费"在合计上一样。
   */
  return priceOptionsFor(balance, statuses, entities, modifiers)
}

/*
 * ⚠ `toleranceOf(balance)` 在这里被删掉了（2026-09-30 日志 57）。
 *   它读的是 `balance.json` 的 `balanceTolerance`（= 2 点）——
 *   那个"产品意义上的容差"已经不存在了：**合计 ≥ 0 就能用，< 0 要付血契**。
 *   判据现在只有一条，写在下面 `kind === 'negative'` 那里。
 */

function err(code: string, path: string, message: string, hint?: string): Issue {
  return hint ? { level: 'error', code, path, message, hint } : { level: 'error', code, path, message }
}

function warn(code: string, path: string, message: string, hint?: string): Issue {
  return hint ? { level: 'warning', code, path, message, hint } : { level: 'warning', code, path, message }
}

// ============================================================================
//  施法形态 × 激活方式（docs/sequence-and-modifier-model.md §二 / §五）
// ============================================================================
//
//  ⚠ 这一节回答的是**两个被混在一起的概念对不对得上**（§一 把它们分开的）：
//
//      施法形态   `Skill.form`            技能层：这次释放要不要一条时间轴、要多长
//      激活方式   `Technique.activation`  术式层：玩家**怎么按**
//
//    两个方向都会漏，而且漏得**很安静**（这一节存在的全部理由）：
//      · 蓄力技能放进"按一下"的术式 → 那一段 `duration: -1` 永远跑不完，
//        玩家看到的是"按下去就没反应了"，而不是一条报错。
//      · 常驻技能（无下限那类）混进主动术式 → 它**没有时间轴**，
//        串不进编译器吐出来的那条时间轴，"按下去到底该发生什么"没有答案。

/** 形态的中文名。报错的人话里用它 */
const FORM_LABELS: Record<SkillForm, string> = {
  instant: '瞬发',
  charged: '蓄力',
  sustained: '持续',
  passive: '常驻',
}

/** 激活方式的中文名 */
const ACTIVATION_LABELS: Record<ActivationMode, string> = {
  press: '按一下',
  release: '蓄力放开',
  hold: '按住',
  toggle: '开关',
  auto: '装上就生效',
}

/**
 * **相容表**：术式的激活方式能带动哪些形态的技能（§五）。
 *
 * ⚠ 写成 `Record<SkillForm, ...>` 而不是一张散表：少写一个形态
 *   TypeScript 当场报错，"表里漏了一行"这种漏法就被堵死了。
 *
 * ⚠ 表里的每一项都是**规矩**，不是"现在内容里有什么"：
 *   持续 → 按住 / 开关（今天内容里一个持续技能都没有，那不代表这一行可以省）。
 */
const FORM_ACTIVATIONS: Record<SkillForm, readonly ActivationMode[]> = {
  instant: ['press', 'release'],
  charged: ['release'],
  sustained: ['hold', 'toggle'],
  passive: ['auto'],
}

/** 相容表的人话版，进 hint */
const COMPAT_TABLE = '瞬发 → 按一下 / 蓄力放开；蓄力 → **只能**蓄力放开；'
  + '持续 → 按住 / 开关；常驻 → 只能进"全常驻"的术式（activation: "auto"）'

/**
 * 一个技能的形态。**不写 = 瞬发**（默认值，理由见 schema 的 `SkillForm`）。
 */
function formOf(skill: Skill): SkillForm {
  return skill.form ?? 'instant'
}

/**
 * 形态 × 激活方式的两条规则：
 *
 *   ① `FORM_INCOMPATIBLE` —— 这个术式的激活方式和它用到的技能形态不相容
 *   ② `FORM_NOT_FIRST`    —— 蓄力 / 持续技能不在它所在序列的第一个
 *
 * ⚠ 报错必须能让人一眼知道**改哪个文件、哪个技能、为什么**：
 *   消息里有术式名（或序列名）+ 技能名 + 两个取值，hint 里有相容表和改法。
 *
 * ⚠ **序列里的技能也要查**（§五 规矩 2："同一门术式的不同序列可以是不同形态，
 *   前提是**每一段都和术式的激活方式相容**"）。只挂序列的术式自己没有
 *   `skills` —— 只看 `tech.skills` 会**一条都看不见**。
 *   判据用的是**父术式的** activation：序列在"激活方式"上位于术式层级的下方
 *   （schema 的 `Technique.sequences`），玩家按的是父术式那个键。
 *
 * ⚠ 但**顺序那一条只查术式自己的 `skills`**：一条序列**自己**就是
 *   "一条按顺序走的技能链"，它被单独校验时（那时 `tech.skills` 就是它里面那些技能）
 *   会报同一条错。顺着父术式再报一遍的话，同一个问题会被报两次，
 *   而"改哪个文件"反而糊了。
 *
 * ⚠ 2026-09-21（日志 46）序列**内联**之后这里少了一次查表：
 *   以前技能长在被引用的那份子术式里（要 `techniques` 那张表才看得见），
 *   现在段自带 `skills`，直接读 —— 所以 `techniques` 这个参数
 *   **只对老形状（字符串引用）还有用**。
 */
function skillFormIssues(
  tech: Technique,
  skills: ReadonlyMap<string, Skill>,
  techniques: ReadonlyMap<string, Technique> | undefined,
): Issue[] {
  const out: Issue[] = []

  const act = tech.activation
  const actLabel = `${act}（${ACTIVATION_LABELS[act] ?? '?'}）`
  const selfName = `术式「${typeof tech.name === 'string' && tech.name.length > 0 ? tech.name : tech.id}」`

  /**
   * 查一条技能链。
   *
   * @param ids        技能 id 列表
   * @param whereOf    这个技能**住在哪儿** —— 报错里要说清楚，
   *                   因为要改的文件**可能不是正在校验的这一份**（技能长在序列里）
   * @param pathOf     JSON 路径
   * @param checkOrder 要不要查"蓄力 / 持续必须在最前"
   */
  function check(
    ids: readonly unknown[],
    whereOf: (skillName: string) => string,
    pathOf: (i: number) => string,
    checkOrder: boolean,
  ): void {
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      if (typeof id !== 'string' || id.length === 0) continue
      const sk = skills.get(id)
      // 引用不到的技能由 `UNKNOWN_SKILL` 报（那一条才算得了账）
      if (sk === undefined) continue

      const form = formOf(sk)

      /*
       * ⚠ 取值非法时**不猜**：`FORM_ACTIVATIONS[form]` 会是 undefined，
       *   直接 `.includes` 会抛异常（把校验器自己的 bug 报成内容的问题）。
       *   非法取值由技能那一侧的 `BAD_ENUM` 报。
       */
      const allowed = FORM_ACTIVATIONS[form] as readonly ActivationMode[] | undefined
      if (allowed === undefined) continue

      const skName = typeof sk.name === 'string' && sk.name.length > 0 ? sk.name : id
      const where = whereOf(`「${skName}」`)
      const formLabel = `${form}（${FORM_LABELS[form] ?? '?'}）`

      // ---- ① 形态不相容 ----
      if (!allowed.includes(act)) {
        out.push(err('FORM_INCOMPATIBLE', pathOf(i),
          `${selfName}的激活方式是 ${actLabel}，但${where}的形态是 ${formLabel} —— 两者不相容`,
          `相容表：${COMPAT_TABLE}。`
          + (form === 'charged'
            ? '蓄力技能的时间轴里有一段 `duration: -1`（时长由玩家控制，按下开始、松开结束）——'
              + '放进"按一下"的术式里，那一段永远跑不完。'
            : form === 'sustained'
              ? '持续技能的时间轴一直挂着，要"按下开始、松开/再按结束"才成立。'
              : form === 'passive'
                ? '常驻技能**没有时间轴**（装上就生效），串不进一次施法的时间轴 ——'
                  + '这类技能只能进"全常驻"的术式（activation: "auto"）。'
                : '瞬发技能要在"按一下 / 蓄力放开"的术式里才打得出去。')
          + `改法：换一个形态相符的技能，或者把这份术式的 activation 改掉`
          + '（`hold` / `toggle` 只能带持续技能，`auto` 只能带常驻技能）。'))
      }

      // ---- ② 蓄力 / 持续必须是序列的第一个 ----
      if (checkOrder && i > 0 && (form === 'charged' || form === 'sustained')) {
        out.push(err('FORM_NOT_FIRST', pathOf(i),
          `${where}的形态是 ${formLabel}，但它不是这条序列的第一个技能（前面还有 ${i} 个）`,
          '蓄力 / 持续技能**必须是它所在序列的第一个技能**（前面不能有别的技能）——'
          + '⚠ 不是"这条序列里只有它"：后面完全可以跟瞬发技能。'
          + `改法：把${where}拖到最前面，或者给它单开一条序列。`))
      }
    }
  }

  // ---- 它自己那条序列（普通术式的 `skills`）----
  check(tech.skills ?? [], n => `技能${n}`, i => `skills[${i}]`, true)

  // ---- 顺着序列往里看 ----
  const segs = tech.sequences ?? []
  for (let j = 0; j < segs.length; j++) {
    const seg = segs[j]
    if (seg === undefined) continue

    /*
     * ⚠ **内联的段：技能就在手边。**
     *
     *   段没有名字的时候（新写的序列通常不写）报"第 N 段" ——
     *   报错得让人找得到地方，"sequences[0] 里的技能"也算找得到，
     *   但有了名字更像人话（"序列「横砍」里的技能"）。
     */
    if (typeof seg !== 'string') {
      // ⚠ 形状坏掉时不在这里抛 —— 由 `BAD_SEQUENCE` 报（理由见下面 `refs` 那段）
      if (!Array.isArray(seg.skills)) continue
      const where = seg.name !== undefined && seg.name.length > 0
        ? `序列「${seg.name}」里的技能`
        : `第 ${j + 1} 条序列里的技能`
      check(seg.skills, n => `${where}${n}`,
        i => `sequences[${j}].skills[${i}]`, false)
      continue
    }

    /*
     * ⚠ **老形状（字符串 id）：仍然顺着查。**
     *   老存档 / 老分享码里的术式就是这个形状（见 schema 的 `TechniqueSequences`）——
     *   不查的话，"父术式的激活方式和序列里技能形态不相容"在这类数据上查不出来，
     *   而那正是 §五 规矩 2 要挡的东西。
     *
     *   引用不到那份术式由 `UNKNOWN_SEQUENCE` 报，这里当它不存在。
     */
    if (techniques === undefined) continue
    const seq = techniques.get(seg)
    if (seq === undefined) continue
    const seqName = typeof seq.name === 'string' && seq.name.length > 0 ? seq.name : seg
    check(seq.skills ?? [], n => `序列「${seqName}」里的技能${n}`,
      i => `sequences[${j}].skills[${i}]`, false)
  }

  return out
}

/**
 * 修饰副本的四条规矩（定稿 §八）。**逐条对应**，理由写在 `validateTechnique`
 * 调用它上面那一段。
 *
 * ⚠ 它**只查副本，不查原型**：原型那些规矩在 `checks.ts` 的
 *   `validateModifierProto` 里（"这个零件出厂时写对了没有"是另一件事，
 *   而它由 `npm run validate` 逐个原型文件查）。
 */
/**
 * 一个技能里**所有**动作的载体（`delivery.kind`）—— 判「追踪」起不起作用用。
 *
 * ⚠ 走 `allRulesOf(skill)`（`effects.ts`）而不是 `skill.rules`：
 *   **固有效果**（`Skill.effect`）编译时会被折成一条 `phaseComplete` 规则 ——
 *   只读 `skill.rules` 会漏掉它，而"这个技能会不会飞"恰恰经常写在固有效果上
 *   （出厂那个「魔法飞弹」就是）。
 *   ⚠ README 里那条定律："**'这个技能会做什么'只有 `allRulesOf()` 一个入口。**"
 *
 * ⚠ 它和 `pricing.ts` 里那个同名函数是**同一段逻辑的两份**吗？—— 是，
 *   而且**故意的**：`validator → pricing` 已经有一条依赖（`priceOptionsFor`），
 *   反过来让 `pricing` 去 import 校验器内部的小工具会绕成环。
 *   ⚠ 真正**不许有两份**的是**判据**（"哪种载体算会飞"），
 *     那一条只有一处：`school.ts` 的 `carrierFliesInWorld` ——
 *     这个函数只负责"把技能里的载体收集出来"，**一个判断都不做**。
 */
function deliveryKindsOfSkill(skill: Skill): string[] {
  const out: string[] = []
  for (const rule of allRulesOf(skill)) {
    for (const action of rule.then ?? []) {
      const kind = action.delivery?.kind
      if (typeof kind === 'string') out.push(kind)
    }
  }
  return out
}

function modifierIssues(
  tech: Technique,
  seqs: readonly (string | SequenceSegment)[],
  protos: ReadonlyMap<string, ModifierProto>,
  skills: ReadonlyMap<string, Skill> | undefined,
): Issue[] {  const out: Issue[] = []
  /** 有常驻包装的段（用来查第 4 条） */
  const constant: number[] = []

  for (let j = 0; j < seqs.length; j++) {
    const seg = seqs[j]
    // 老形状（字符串 id）不带副本 —— 副本住在段里，而那一半没有段
    if (seg === undefined || typeof seg === 'string') continue
    if (!Array.isArray(seg.skills)) continue

    const mods = seg.mods
    if (mods === undefined) continue
    if (!Array.isArray(mods)) {
      out.push(err('BAD_MODS', `sequences[${j}].mods`,
        '`mods` 必须是数组（修饰副本的列表）',
        '⚠ 修饰副本**并列**在 `mods` 里，**不许**混进 `skills` ——'
        + '技能表是"这一段按顺序执行哪几个技能"，混进去的话每一处读 `skills`'
        + '的地方都得重新判"这个字符串是不是技能"。'))
      continue
    }

    /** 这一段已经用过的机制类别（第 3 条） */
    const usedKinds = new Map<ModifierKind, number>()

    for (let k = 0; k < mods.length; k++) {
      const mod = mods[k]
      const at = `sequences[${j}].mods[${k}]`
      if (mod === null || typeof mod !== 'object') {
        out.push(err('BAD_MODS', at, '这一项不是修饰副本'))
        continue
      }

      const proto = typeof mod.proto === 'string' ? protos.get(mod.proto) : undefined
      const kind = proto?.kind
      if (typeof mod.proto !== 'string' || mod.proto.length === 0) {
        out.push(err('BAD_MODS', `${at}.proto`, '修饰副本缺少 proto（它引用哪个原型）'))
      } else if (proto === undefined) {
        out.push(err('UNKNOWN_MODIFIER', `${at}.proto`,
          `找不到修饰原型「${mod.proto}」`,
          '⚠ 修饰原型**只有出厂那一批**（`content/modifiers/*.json`）——'
          + '玩家**不能创建原型**（他拖进序列得到的是**副本**，副本住在术式里）。'
          + '所以这一条多半是 id 写错了，或者那一份原型还没做出来。'))
      } else {
        // ---- 第 3 条：一条序列里不叠同类 ----
        /*
         * ⚠ 这里用的是 `proto.kind`（不是上面那个 `kind`）：`kind` 是
         *   `proto?.kind`，只有这一支里 `proto` 才**确定存在**（上一行判过）——
         *   直接用 `kind` 的话类型上还得再判一次，而"再判一次"就是第二份真相。
         */
        const first = usedKinds.get(proto.kind)
        if (first !== undefined) {
          out.push(err('MODIFIER_STACKED_KIND', at,
            `这一条序列里有 ${proto.kind} 类的两个修饰副本（第 ${first} 个和这一个）`,
            '定稿 §八：**一条序列里不叠同类** —— 两个「多重释放」会立刻炸成 4 个、'
            + '8 个，点数也算不清。⚠ 判据是**原型的类别**（`kind`），'
            + '不是 id：两个不同的触发器叠在一起同样是"一次条件放出两段"。'
            + '⚠ 它**不挡不同类**：一条序列里放一个「多重释放」和一个「一分为 X」是合法的，'
            + '两者叠加怎么算见日志 51 的裁定。'))
        } else {
          usedKinds.set(proto.kind, k)
        }
      }

      /*
       * ---- 第 5 条：时机**没接线**要说出来（警告，不是错误）----
       *
       * ⚠ 副本自己写的 `params.when` 会**盖过**原型（`compile.ts` 的 `compileMods`
       *   是"先看副本、再看原型"）⇒ 所以这一条必须**副本也查一遍**：
       *   只在原型那一侧查的话，"副本把 when 改成 onHit"这种写法一路静默到运行期，
       *   表现是"条件明明满足，它什么都不放" —— 而那正是本项目列为最危险的一类。
       *
       * ⚠ 原型那一侧也查（`checks.ts` 的 `validateModifierProto`），
       *   两处查的是**同一张表**（`WIRED_TRIGGER_EVENTS`，住在 `sim/trigger.ts`），
       *   所以不会漂 —— 接线了新时机只改那一张表。
       */
      const rawParams: unknown = (mod as { params?: unknown }).params
      const copyParams = (rawParams !== null && typeof rawParams === 'object' && !Array.isArray(rawParams))
        ? rawParams as Record<string, unknown>
        : undefined
      const unwiredCopy = checks.unwiredTriggerIssue(
        copyParams?.['when'], `${at}.params.when`, '这个修饰副本的 `params.when`')
      if (unwiredCopy !== undefined) out.push(unwiredCopy)

      /*
       * ---- 第 2 条：at 得指得到这一段里真实存在的技能 ----
       *
       * ⚠ `at` 是"**它后面第几个技能**"（0 = 紧邻的下一个）——
       *   而玩家定的用法是"修饰技能**排在被它修饰的那个技能前面**"，
       *   所以被修饰的技能就是 `skills[at]`（`at: 0` = `skills[0]`）。
       *
       * ⚠ 算错一个位置的后果是**静默的**：修饰会落到旁边那个技能上，
       *   而"触发器修饰了不该修饰的那个"看起来和"修饰生效了"一模一样。
       */
      const at2 = mod['at'] as unknown
      if (!Number.isInteger(at2) || (at2 as number) < 0) {
        out.push(err('BAD_MODIFIER_AT', `${at}.at`,
          `at 必须是非负整数（"它修饰后面第几个技能"，0 = 紧邻的下一个），实际是 ${JSON.stringify(at2)}`))
      } else if ((at2 as number) >= seg.skills.length) {
        out.push(err('MODIFIER_OUT_OF_RANGE', `${at}.at`,
          `这个修饰副本指向它后面第 ${at2 as number} 个技能（这一段里第 ${(at2 as number) + 1} 个），`
          + `但这一段只有 ${seg.skills.length} 个技能`,
          '⚠ 它**修饰不到任何东西** —— 表现是"装了个修饰技能，什么都没发生"，'
          + '而且不报错。所以这里当场拦住。'
          + '⚠ 排法是：**修饰副本排在它修饰的那个技能前面**（拖进去的顺序就是语义），'
          + '所以 `skills[0]` 就是被修饰的那个技能、`at: 0` 指它。'))
      }

      // ---- 第 4 条：常驻包装只能进"按一下"的普通术式 ----
      if (kind === 'wrap' && at2 === 0) constant.push(j)

      /*
       * ---- 第 5 条：**份数类修饰**（多重释放 / 一分为 X）的三条规矩 ----
       *      ★ 2026-09-21 日志 51 新加的。三条判据全来自玩家给的那段规格：
       *
       *   ① 份数在 `[2, params.max]` 里
       *      —— 玩家：N 默认 2、**上限 10**；X 默认 2、**上限默认 4**。
       *      ⚠ 上限从**原型**读（`modifierMaxOf`），不是代码里的常数：
       *        玩家那句"上限**默认** 4"就是说这个数本身可调。
       *   ② **多重释放不能放在蓄力 / 持续技能前面**
       *      —— 玩家原话（也是定稿 §八 的原话）："**只作用于瞬发技能**"。
       *      ⚠ 查的是**它一下子要打出去的那几个技能**（`at` 起数 `count` 个），
       *        不是只查紧邻那一个：N=3 时第三个是蓄力技能，同样是"打不出去"。
       *      ⚠ **「一分为 X」不查这一条**：玩家只对多重释放说了这句话。
       *        替玩家补一条规矩 = 自己定规矩（它是**待裁定项**，见日志 51）。
       *   ③ **今天只接线了 `at: 0`** → 警告，不报错
       *      —— 引擎里 `activateGroup` 只处理 `at: 0`（和触发器 / 监测器
       *        同一个限制）。写在别处**不生效**，所以必须出声。
       */
      if (proto !== undefined && (proto.kind === 'multi' || proto.kind === 'split')) {
        const cap = modifierCountOf(mod, proto)
        if (cap.raw > cap.max) {
          out.push(err('MODIFIER_COUNT_OVER_CAP', `${at}.params.${MODIFIER_COUNT_KEY}`,
            `这个「${proto.name}」副本的份数是 ${cap.raw}，超过它自己的上限 ${cap.max}`,
            '⚠ 上限是**每个动词自己的**（多重释放 10 / 一分为 X 4）—— 它不是一条通用规矩，'
            + '而它为什么需要：份数 = 一次激活里的施法个数，没有上限的话'
            + `\`count: 9999\` 会在一个 tick 里起 9999 个施法。`
            + `⚠ 上限住在原型里（\`content/modifiers/${mod.proto}.json\` 的 \`params.max\`），`
            + '要改改那儿，不用改代码。'))
        }

        if (proto.kind === 'multi' && Number.isInteger(at2) && (at2 as number) >= 0) {
          /*
           * ⚠ 从 `at` 起数 `count` 个技能，**跳过重复的 id**
           *   （玩家写的是"N 个**互不相同**的瞬发技能"）。
           *   引擎那一侧数是同一套（`sim/trigger.ts` 的 `groupPlanOf`）——
           *   两边分头数的话，"账上查了 3 个、引擎打了 2 个"会同时成立。
           */
          const seen = new Set<string>()
          const wanted: string[] = []
          for (let k = at2 as number; k < seg.skills.length && wanted.length < cap.count; k++) {
            const id = seg.skills[k]
            if (id === undefined || seen.has(id)) continue
            seen.add(id)
            wanted.push(id)
          }

          for (const id of wanted) {
            const sk = skills?.get(id)
            // 技能查不到由 `UNKNOWN_SKILL` 报（那一条说"这一段的账算不了"），这里不重复报
            if (sk === undefined) continue
            if (formOf(sk) === 'instant') continue
            out.push(err('MULTI_FIRE_NON_INSTANT', `${at}.at`,
              `「${proto.name}」会把「${sk.name}」一起打出去，而它的施法形态是 ${formOf(sk)}（不是瞬发）`,
              '玩家 / 定稿 §八：**多重释放只作用于瞬发技能** ——'
              + '蓄力（`charged`）和持续（`sustained`）**必须在序列最前面**'
              + '（它们要玩家按住 / 一直挂着），把"一次激活打出好几个"套在它们头上说不通：'
              + '一个输入驱动不了 N 条各自等输入的时长轴。'
              + '⚠ 常驻（`passive`）同样拦 —— 它**没有时间轴**，"一起打出去"这句话对它没有落点。'))
          }

          /*
           * ⚠ 这一段里**凑不够** N 个互不相同的技能 → 警告。
           *   引擎会**照实打**（有几个打几个），所以这不是错误；
           *   但"我写了 5 个，实际只出来 2 个"必须说出来 ——
           *   不然玩家会以为自己的修饰没生效。
           */
          if (wanted.length < cap.count) {
            out.push(warn('MODIFIER_COUNT_CLAMPED', `${at}.params.${MODIFIER_COUNT_KEY}`,
              `「${proto.name}」说一次打 ${cap.count} 个，但这一段从第 ${(at2 as number) + 1} 个技能起`
              + `只有 ${wanted.length} 个**互不相同**的技能 —— 实际只会打出 ${wanted.length} 个`,
              '⚠ 引擎照实打（有几个打几个），账也按实际份数收 —— 所以这里不是错误。'
              + '写成错误的话，"技能少但合法"的序列会被判死。'))
          }
        }

        if (at2 !== 0) {
          out.push(warn('MODIFIER_GROUP_AT_NOT_WIRED', `${at}.at`,
            `这个「${proto.name}」副本的 at 是 ${String(at2)}，而**今天只有 \`at: 0\` 会生效**`,
            '⚠ 引擎里落地"一次激活打出好几份"的地方（`sim/trigger.ts` 的 `activateGroup`）'
            + '只处理**紧邻的第一个技能**被修饰的情形 —— 和触发器 / 监测器今天同一个限制'
            + '（见 `sim/trigger.ts` 文件头）。'
            + '⚠ **写上去不生效**是这个项目列为最危险的一类静默失败，所以这里出声；'
            + '它不是错误（内容是合理的前置），但"它在哪儿生效"必须说清楚。'
            + '⚠ 引擎那一侧为什么不做 at > 0：那要"先按顺序跑 at 之前那几个技能、'
            + '再把 at 起的那几个一起打出去"，也就是**一次激活里两条时间轴** —— 那是另一件事。')) 
        }
      }

      /*
       * ---- 第 6 条：**「等待 X 秒」的四条规矩** ----
       *      ★ 2026-09-30 日志 52 新加的。判据全来自玩家定稿的那段规格：
       *
       *   ① 秒数在 `[0.2, params.max]` 里（两头**闭区间**）
       *      —— 玩家：范围 0.2 ~ 3 秒，写成 0 没有意义（那不如删掉这个零件）。
       *      ⚠ 上限从**原型**读（`modifierSecondsOf`），下限是玩家说死的 0.2。
       *   ② 秒数必须是个有限数 —— 写成 `"很久"` 不许静默当默认值。
       *   ③ `locks` 只能写 `move` / `turn`
       *      —— ⚠ **2026-09-30（日志 54）从"四项可勾"收窄到两项**：玩家定的
       *      "同一个施法者同一时刻只有一段施法"是**引擎硬规矩**，
       *      所以 `cast` / `attack` 不再由零件来配（出现就报
       *      `MODIFIER_LOCK_ENGINE_RESERVED`，说清"不是可配项"）。
       *      ⚠ 认不出的值**不静默丢掉**：丢掉的表现是"我锁了，它没锁上"。
       *   ④ `interrupt` 只能是那三档（**和 `InterruptLevel` 同一套取值**）
       *      —— 玩家定的默认是 `'none'`（不可打断）。
       *      ⚠ 在这里新造一个取值等于再造一套打断语义：引擎那一侧
       *        `Phase.interrupt` 只认那三个。
       *
       *   ⚠ **`at` 这件事等待和份数不一样**：份数类零件今天只认 `at: 0`
       *     （引擎里"一次激活打出好几份"只能落在段的第一份施法上），
       *     而等待是**往时间轴里插一格**，插在哪儿引擎都做得到 ——
       *     所以它**不该**收到 `MODIFIER_GROUP_AT_NOT_WIRED`
       *     （那会告诉玩家一句假话："写在 at: 1 不生效"，而它生效）。
       */
      if (proto !== undefined && proto.kind === 'wait') {
        const secondsRaw = mod.params[MODIFIER_SECONDS_KEY]
        const waitPath = `${at}.params.${MODIFIER_SECONDS_KEY}`
        if (typeof secondsRaw !== 'number' || !Number.isFinite(secondsRaw)) {
          out.push(err('MODIFIER_BAD_SECONDS', waitPath,
            `「${proto.name}」的秒数必须是一个有限的数字，现在是 ${JSON.stringify(secondsRaw)}`,
            '⚠ 写成字符串（或者不写）时**不许静默当默认值**：玩家会看到'
            + '"我写了 5 秒，它等了 1.5 秒" —— 而两边的数都"看起来对"。'))
        } else {
          const { max } = modifierSecondsOf(mod, proto)
          if (secondsRaw > max) {
            out.push(err('MODIFIER_SECONDS_OVER_CAP', waitPath,
              `这个「${proto.name}」副本要等 ${secondsRaw} 秒，超过它的上限 ${max} 秒`,
              '⚠ 上限**住在原型里**（`content/modifiers/wait.json` 的 `params.max`），'
              + '不是代码里的常数 —— 玩家要改"最长能等多久"改那儿，不用改代码。'
              + '⚠ 没有上限的话一段 `seconds: 9999` 会把那个技能在这一局里彻底堵死。'))
          }
          if (secondsRaw < MODIFIER_SECONDS_MIN) {
            out.push(err('MODIFIER_SECONDS_UNDER_MIN', waitPath,
              `这个「${proto.name}」副本要等 ${secondsRaw} 秒，低于下限 ${String(MODIFIER_SECONDS_MIN)} 秒`,
              '玩家定的是 **0.2 ~ 3 秒**，两头都是闭区间。'
              + '⚠ 写成 0 就是"没有这一段空档"—— 那不如把这个零件删掉，'
              + '而不是留一个什么都不做的零件在序列里（它还会占掉"不叠同类"那一格）。'))
          }
        }

        /*
         * ⚠ 两条判据，顺序不能反（2026-09-30 日志 54）：
         *   ① `cast` / `attack` ⇒ **引擎硬规矩，不是可配项** —— 专属错误码，
         *      说的不是"你拼错了"，而是"这一项本来就不该由零件来配"。
         *   ② 别的认不出的值 ⇒ 老那一条 `MODIFIER_BAD_LOCKS`（拼错了 / 不存在）。
         * 合成一条的话，提示只能二选一：要么把硬规矩说成拼写错误，
         * 要么把拼写错误说成硬规矩 —— 两种都会把玩家指到错的方向去。
         */
        const locksRaw = mod.params[MODIFIER_LOCKS_KEY]
        if (locksRaw !== undefined) {
          if (!Array.isArray(locksRaw)) {
            out.push(err('MODIFIER_BAD_LOCKS', `${at}.params.${MODIFIER_LOCKS_KEY}`,
              `\`${MODIFIER_LOCKS_KEY}\` 必须是一个数组，现在是 ${JSON.stringify(locksRaw)}`,
              '玩家定的是"移动 / 转身**两项可勾**"（⚠ 施法和攻击**不在里面**：'
              + '它们是引擎硬规矩，见下一条）。'
              + `⚠ 写成裸的字符串时读参数那一步会把它当成"没写"、静默换成默认的 ${JSON.stringify([...MODIFIER_LOCKS_DEFAULT])}。`))
          } else {
            for (const v of locksRaw) {
              if (typeof v === 'string' && MODIFIER_LOCK_ENGINE_RESERVED.includes(v)) {
                out.push(err('MODIFIER_LOCK_ENGINE_RESERVED', `${at}.params.${MODIFIER_LOCKS_KEY}`,
                  `\`${v}\` 不许写进这个零件的 \`${MODIFIER_LOCKS_KEY}\` —— `
                  + '**施法独占是引擎硬规矩，不是可配项**',
                  '玩家 2026-09-30 定的（原话："玩家又没有第二人格"）：'
                  + '**同一个施法者，同一时刻只能有一个进行中的施法** —— '
                  + '它由引擎强制（`canActivate` ⇒ `busy`），**和这里锁没锁它无关**：'
                  + '把锁解开也不许并行。'
                  + '⚠ 武器攻击也是绑在左键上的术式 ⇒ `attack` 一样被同一条硬规矩挡着。'
                  + `能配的只剩 ${MODIFIER_LOCK_VALUES.join(' / ')}。`))
                continue
              }
              if (typeof v === 'string' && MODIFIER_LOCK_VALUES.includes(v)) continue
              out.push(err('MODIFIER_BAD_LOCKS', `${at}.params.${MODIFIER_LOCKS_KEY}`,
                `锁的取值只能是 ${MODIFIER_LOCK_VALUES.join(' / ')}，现在是 ${JSON.stringify(v)}`,
                '它正好是引擎 `Capability` 里**还能配的那两项**。'
                + '⚠ 认不出的值**不静默丢掉**：丢掉的表现是"我锁了它，它没锁上"。'
                + `⚠ \`${MODIFIER_LOCK_ENGINE_RESERVED.join('\` / \`')}\` 是另一条判据`
                + '（`MODIFIER_LOCK_ENGINE_RESERVED`）：那两个是引擎硬规矩，不是拼错了。'))
            }
          }
        }

        const interruptRaw = mod.params[MODIFIER_INTERRUPT_KEY]
        if (interruptRaw !== undefined
          && (typeof interruptRaw !== 'string' || !MODIFIER_INTERRUPT_VALUES.includes(interruptRaw))) {
          out.push(err('MODIFIER_BAD_INTERRUPT', `${at}.params.${MODIFIER_INTERRUPT_KEY}`,
            `打断档只能是 ${MODIFIER_INTERRUPT_VALUES.join(' / ')}，现在是 ${JSON.stringify(interruptRaw)}`,
            '⚠ 玩家定的默认是 **`none`（不可打断）** —— 可打断会让"晚 X 秒"当场消失、'
            + '后面那个技能反而**提前**打出来（那不是打断，是把排好的序列顺序改掉了）。'
            + '要和引擎那三档用**同一套取值**（`InterruptLevel`），别在这里新造一个。'))
        }

        /*
         * ⚠ 触发器 / 监测器副本的**条件**判据**不在这里** —— 它在下面单独一块
         *   （`proto.kind === 'trigger' || 'monitor'`）：那两个键只有那一类零件才有，
         *   而且"副本和原型都没有条件"要**同时看两层**（原型得从 `proto` 读）。
         */
      }

      /*
       * ---- 第 6.5 条：**触发器 / 监测器的条件**（2026-09-30 日志 54，玩家两轮裁定）----
       *
       * ⚠⚠ 背景：出厂零件「应声触发」原来写着 `condition: {}`，而求值器按 `type`
       *   分派，`{}` 落到 `default: return false` ⇒ **恒不成立** ⇒ 那个零件
       *   **永不触发、而且一声不吭**（出厂零件自己就是坏的）。
       *
       * ⚠⚠ **2026-09-30 日志 55：第 ② 条（`MODIFIER_CONDITION_REQUIRED`）已经松掉。**
       *   日志 54 当时**必须**报它，理由只有一个：玩家点名的默认值
       *   「**载体（前一个技能）消失**」要 `onExpire` / `onRemoved` 那一档时机，
       *   而引擎**没接线** ⇒ 不写条件就是"永不触发"，那是最危险的一类静默。
       *   现在那一档**接上了**（`trigger.ts` 的 `sweepCarriersGone`，
       *   `world.ts` 第 11b 步）⇒ **不写条件有真实语义了**：
       *     · 没写 `condition` ⇒ 这次驱动它的是「**载体没了**」；
       *     · 写了（哪怕写的是 `{}`）⇒ 照老规矩在**它自己那个时机**上求值。
       *   ⇒ 所以现在还留在这一块里的**只有 ①（显式 `{}`）** —— 它不是"没写"，
       *     是一个明确的"永不通过"，照旧必须拦住。
       *
       *   ⚠ 原型那一层有**同名**的两条（`checks.ts` 的 `validateModifierProto`）：
       *     原型写着 `{}` 也要拦（否则"出厂零件自己写错"没人吭声）。
       */
      if (proto !== undefined && (proto.kind === 'trigger' || proto.kind === 'monitor')) {
        const condCopy = mod.params[MODIFIER_CONDITION_KEY]
        if (checks.isEmptyConditionObject(condCopy)) {
          out.push(err('MODIFIER_EMPTY_CONDITION', `${at}.params.${MODIFIER_CONDITION_KEY}`,
            '`condition: {}` 是个**空条件对象** —— 它**恒不成立**',
            '⚠ 它读起来像"无条件"，实际是"**永不触发**"、而且一声不吭。'
            + '⚠ 而且它还会**盖住原型上那个真的条件**（引擎的参数读法是"副本优先、原型兜底"）'
            + '⇒ 把这一份的条件**删掉**（那是「**载体消失**」= 玩家点名的默认值，'
            + '日志 55 起真的会触发）或者**写一个真的**。'))
        }
      }

      /*
       * ---- 第 7 条：**「排布」的五条规矩** ----
       *      ★ 2026-09-30 日志 53 新加的。判据全来自玩家那段规格：
       *
       *   ① `type` 必须是三选一
       *      —— 玩家："一个零件、**编辑时选类型**"（环绕 / 扇形散射 / 反向镜像）。
       *      ⚠ 认不出的取值**不是错误地静默**：引擎那一侧整块不生效
       *      （`modifierLayoutModeOf` 返回 undefined），所以这里必须报错。
       *   ② `radius` 在 `[minRadius, maxRadius]` 里（原型上的区间）
       *   ③ `startAngle` / `mirrorAngle` 在 `±maxAngle` 里
       *   ④ `spread` 在 `[0, maxSpread]` 里
       *      —— ②③④ 是同一个形状：**范围住在原型里**（和份数的 `max`、
       *      等待的 `max` 同构），所以"改范围"是改数据不是改代码。
       *      ⚠ 越界时引擎会**夹住**（`school.ts` 那三个 `modifierLayout*Of`），
       *      而"我写了 99 米它只摆了 6 米"必须说出来 —— 夹是兜底，不是判据。
       *   ⑤ `even` 必须是 true / false
       *      —— 写成 `1` / `"true"` 时引擎按默认的"均匀"处理，
       *      而"我关掉了它却还是均匀排"正是最该拦住的那种静默坏行为。
       *
       *   ⚠ **今天只接线了 `at: 0`**（和份数类那两个动词同一个限制）：
       *     引擎落地"一次激活打出好几份"的地方（`activateGroup`）只处理段的
       *     第一份施法，排布也只能在那儿生效 —— 写在别处给警告，不静默。
       *
       *   ⚠⚠ **这里一个"份数"判据都没有**（玩家划的第一条硬界线）：
       *     排布**不管份数**，所以它没有 `count` 可查、也不参与
       *     `MODIFIER_COUNT_OVER_CAP` / `MULTI_FIRE_NON_INSTANT` 那两条。
       */
      if (proto !== undefined && proto.kind === 'layout') {
        const typeRaw = mod.params[MODIFIER_LAYOUT_TYPE_KEY]
        const mode = modifierLayoutModeOf(mod, proto)
        if (mode === undefined) {
          out.push(err('MODIFIER_LAYOUT_BAD_TYPE', `${at}.params.${MODIFIER_LAYOUT_TYPE_KEY}`,
            `这个「${proto.name}」副本的摆法是 ${JSON.stringify(typeRaw)}，`
            + `不是 ${MODIFIER_LAYOUT_MODES.join(' / ')} 之一`,
            '玩家定的：**一个零件、编辑时选类型**（环绕生成 / 扇形散射 / 反向镜像）。'
            + '⚠ 引擎那一侧对认不出的取值**什么都不做**（不猜一个默认摆法）——'
            + '因为"我选了反向镜像，它给我排了个圈"不是兜底，是静默改语义。'))
        }

        const radiusRaw = mod.params[MODIFIER_LAYOUT_RADIUS_KEY]
        if (radiusRaw !== undefined) {
          const r = modifierLayoutRadiusOf(mod, proto)
          if (typeof radiusRaw !== 'number' || !Number.isFinite(radiusRaw)) {
            out.push(err('MODIFIER_LAYOUT_BAD_NUMBER', `${at}.params.${MODIFIER_LAYOUT_RADIUS_KEY}`,
              `环绕的半径必须是一个有限的数（米），现在是 ${JSON.stringify(radiusRaw)}`,
              '⚠ 写成字符串时**不许静默当默认值**：玩家会看到"我写了 4 米，它摆了 1.5 米"'
              + ' —— 而两边的数都"看起来对"。'))
          } else if (radiusRaw < r.min || radiusRaw > r.max) {
            out.push(err('MODIFIER_LAYOUT_OVER_CAP', `${at}.params.${MODIFIER_LAYOUT_RADIUS_KEY}`,
              `这个「${proto.name}」副本的环绕半径是 ${String(radiusRaw)} 米，`
              + `超出它的范围 [${String(r.min)}, ${String(r.max)}] 米`,
              '⚠ 范围**住在原型里**（`content/modifiers/layout.json` 的 `params.minRadius` / `maxRadius`），'
              + '不是代码里的常数 —— 玩家要改"这一圈最大能多大"改那儿，不用改代码。'
              + '⚠ 越界时引擎**会夹住**（不夹的话 `radius: 9999` 会把那几份摆到地图外面：'
              + '技能放出来了、什么都不打中），所以这里出声、而不是让它静静夹。'))
          }
        }

        for (const [key, label] of [
          [MODIFIER_LAYOUT_START_KEY, '起始角'],
          [MODIFIER_LAYOUT_MIRROR_KEY, '镜像偏移角'],
        ] as const) {
          const v = mod.params[key]
          if (v === undefined) continue
          const lim = modifierLayoutMaxAngleOf(proto)
          if (typeof v !== 'number' || !Number.isFinite(v)) {
            out.push(err('MODIFIER_LAYOUT_BAD_NUMBER', `${at}.params.${key}`,
              `${label}必须是一个有限的数（度），现在是 ${JSON.stringify(v)}`))
          } else if (v < -lim || v > lim) {
            out.push(err('MODIFIER_LAYOUT_OVER_CAP', `${at}.params.${key}`,
              `这个「${proto.name}」副本的${label}是 ${String(v)} 度，超出 ±${String(lim)} 度`,
              '⚠ 上限住在原型里（`params.maxAngle`）：没有它的话，'
              + '一份手改的 `startAngle: 1e9` 会绕上几百万圈 ——'
              + '结果虽然还是落在圈上，但"我写的是多少"和"它摆的是多少"再也对不上。'))
          }
        }

        const spreadRaw = mod.params[MODIFIER_LAYOUT_SPREAD_KEY]
        if (spreadRaw !== undefined) {
          const lim = modifierLayoutMaxSpreadOf(proto)
          if (typeof spreadRaw !== 'number' || !Number.isFinite(spreadRaw)) {
            out.push(err('MODIFIER_LAYOUT_BAD_NUMBER', `${at}.params.${MODIFIER_LAYOUT_SPREAD_KEY}`,
              `扇形张角必须是一个有限的数（度），现在是 ${JSON.stringify(spreadRaw)}`))
          } else if (spreadRaw < 0 || spreadRaw > lim) {
            out.push(err('MODIFIER_LAYOUT_OVER_CAP', `${at}.params.${MODIFIER_LAYOUT_SPREAD_KEY}`,
              `这个「${proto.name}」副本的张角是 ${String(spreadRaw)} 度，超出 [0, ${String(lim)}] 度`,
              '⚠ 张角**只有正的一侧**（负张角没有意义），上限住在原型里（`params.maxSpread`）。'))
          }
        }

        const evenRaw = mod.params[MODIFIER_LAYOUT_EVEN_KEY]
        if (evenRaw !== undefined && typeof evenRaw !== 'boolean') {
          out.push(err('MODIFIER_LAYOUT_BAD_EVEN', `${at}.params.${MODIFIER_LAYOUT_EVEN_KEY}`,
            `是否均匀分布只能是 true / false，现在是 ${JSON.stringify(evenRaw)}`,
            '玩家原话是"**是否**均匀分布" —— 它是一个开关。'
            + '⚠ 写成 `1` / `"true"` 时引擎按默认的"均匀"处理 ——'
            + '"我关掉了它却还是均匀排"是静默改行为。'))
        }

        /*
         * ⚠ `at` 的限制**和份数类那两个动词一样**（不是和等待一样）：
         *   排布和份数共用**同一个落点**（`activateGroup` 的"第一份施法"），
         *   而等待是"往时间轴里插一格"（插在哪儿都做得到）。
         *   ⇒ 写在 `at: 1` 上**今天不生效**，必须出声。
         */
        if (at2 !== 0) {
          out.push(warn('MODIFIER_GROUP_AT_NOT_WIRED', `${at}.at`,
            `这个「${proto.name}」副本的 at 是 ${String(at2)}，而**今天只有 \`at: 0\` 会生效**`,
            '⚠ 引擎里落地"一次激活打出好几份"的地方（`sim/trigger.ts` 的 `activateGroup`）'
            + '只处理**紧邻的第一个技能**被修饰的情形 —— 和「多重释放」/「一分为 X」同一个限制。'
            + '⚠ 排布要多走这一步是因为它**必须**和份数落在同一处：'
            + '排布摆的正是"份数算出来的那几份"，两者分家就没人知道该摆哪几份了。'
            + '⚠ **写上去不生效**是这个项目列为最危险的一类静默失败，所以这里出声。'))
        }
      }

      /*
       * ---- 第 8 条：**「追踪」的两条规矩** ----
       *      ★ 2026-09-30 日志 56 新加的。判据全来自玩家那段规格：
       *
       *   ① `turnRate` 在 `[1, 原型上限]` 里
       *   ② `maxRange` 在 `[原型下限, 原型上限]` 里
       *      —— 两条是同一个形状：**范围住在原型里**（和份数的 `max`、等待的 `max`、
       *      排布的 `minRadius`/`maxRadius` 同构），所以"改范围"是改数据不是改代码。
       *      ⚠ 越界时引擎会**夹住**（`school.ts` 的 `modifierHoming*Of`），
       *      而"我写了 9999 米它只锁了 16 米"必须说出来 —— 夹是兜底，不是判据。
       *      ⚠ 转速**下限是 1**（不是 0）：0 就是"每 tick 拐 0 度"= 这个零件白装，
       *        而那和"没装"在表现上完全一样。
       *
       *   ⚠⚠ **`maxRange` 的语义 2026-09-30（日志 62）改成了"索敌距离"**
       *     （玩家："限制不应该是射程，而是**持续时间** —— 这样就追到消失"）：
       *     它只在**发射那一刻**用一次 —— 锁上之后一路咬到这一发自己消失为止，
       *     中间**不丢锁**、也**不换目标**。键名故意没改（改键名要同步
       *     代码 / 校验器 / 内容 / 点表，而这一片要的是语义）。
       *     ⇒ 下面那些话里的"范围"仍然是**同一个范围**（1~16 米），只是它现在管的是
       *       "**发射那一刻**能锁多远"。
       *
       *   ⚠ **今天只接线了 `at: 0`**（和份数类 / 排布同一个限制 —— 见下面那条警告）。
       *
       *   ⚠⚠ **这里一个字都没有"载体"**（玩家明确划的界线）：
       *     把它装在激光 / 扇形 / 光环上，引擎那一侧**什么都不做**，
       *     而这**不是错误、也不是警告**（照「环绕」那条先例）——
       *     "这个修饰对这条序列不起作用"由**界面**画在那条序列下方。
       *     ⇒ 校验器**不许**加"你装错载体了"的判据：那会把一个
       *       "不起作用的修饰"变成一条报错，和玩家的规格相反。
       */
      if (proto !== undefined && proto.kind === 'homing') {
        const turnRaw = mod.params[MODIFIER_HOMING_TURN_KEY]
        if (turnRaw !== undefined) {
          const lim = modifierHomingMaxTurnOf(proto)
          if (typeof turnRaw !== 'number' || !Number.isFinite(turnRaw)) {
            out.push(err('MODIFIER_HOMING_BAD_NUMBER', `${at}.params.${MODIFIER_HOMING_TURN_KEY}`,
              `追踪的转速必须是一个有限的数（度/tick），现在是 ${JSON.stringify(turnRaw)}`,
              '⚠ 写成字符串时**不许静默当默认值**：玩家会看到"我写了 20 度，它按 12 度拐"'
              + ' —— 而两边的数都"看起来对"。'))
          } else if (turnRaw < MODIFIER_HOMING_TURN_MIN || turnRaw > lim) {
            out.push(err('MODIFIER_HOMING_OVER_CAP', `${at}.params.${MODIFIER_HOMING_TURN_KEY}`,
              `这个「${proto.name}」副本的转速是 ${String(turnRaw)} 度/tick，`
              + `超出它的范围 [${String(MODIFIER_HOMING_TURN_MIN)}, ${String(lim)}] 度/tick`,
              '⚠ 范围**住在原型里**（`content/modifiers/homing.json` 的 `params.maxTurnRate`），'
              + '不是代码里的常数 —— 玩家要改"最多能拐多快"改那儿，不用改代码。'
              + '⚠ 越界时引擎**会夹住**（不夹的话 `turnRate: 1e9` 会让子弹'
              + '**一 tick 贴到目标脸上** —— 表现是"我装了追踪，它变成了一发必中的瞬移弹"），'
              + '所以这里出声、而不是让它静静夹。'))
          }
        }

        const rangeRaw = mod.params[MODIFIER_HOMING_RANGE_KEY]
        if (rangeRaw !== undefined) {
          const min = modifierHomingMinRangeOf(proto)
          const max = modifierHomingMaxRangeOf(proto)
          if (typeof rangeRaw !== 'number' || !Number.isFinite(rangeRaw)) {
            out.push(err('MODIFIER_HOMING_BAD_NUMBER', `${at}.params.${MODIFIER_HOMING_RANGE_KEY}`,
              `追踪的索敌距离必须是一个有限的数（米），现在是 ${JSON.stringify(rangeRaw)}`))
          } else if (rangeRaw < min || rangeRaw > max) {
            out.push(err('MODIFIER_HOMING_OVER_CAP', `${at}.params.${MODIFIER_HOMING_RANGE_KEY}`,
              `这个「${proto.name}」副本的索敌距离是 ${String(rangeRaw)} 米，`
              + `超出它的范围 [${String(min)}, ${String(max)}] 米`,
              '⚠ 范围**住在原型里**（`params.minRange` / `maxRangeCap`），不是代码里的常数。'
              + '⚠ 写成很大（比如 100）就是"全图索敌"，那会让"索敌距离"这一整条交易轴**当场失效**'
              + ' —— 所以上限必须存在，越界时引擎会夹住并在这里出声。'))
          }
        }

        /*
         * ⚠ `at` 的限制**和份数类那两个动词 / 排布一样**：
         *   引擎读"这一段的第一份施法"（`homingOfCast` 只取 `targetIndex === 0`），
         *   写在 `at: 1` 上**今天不生效** —— 必须出声，不许静默。
         */
        if (at2 !== 0) {
          out.push(warn('MODIFIER_GROUP_AT_NOT_WIRED', `${at}.at`,
            `这个「${proto.name}」副本的 at 是 ${String(at2)}，而**今天只有 \`at: 0\` 会生效**`,
            '⚠ 引擎读修饰副本的地方（`sim/pipeline.ts` 的 `homingOfCast`）'
            + '只处理**紧邻的第一个技能**被修饰的情形 —— 和「多重释放」/「一分为 X」/「排布」同一个限制。'
            + '⚠ **写上去不生效**是这个项目列为最危险的一类静默失败，所以这里出声。'))
        }

        /*
         * ---- 第 9 条：**「追踪」只对"会飞的东西"有效** ----
         *      ★ 2026-09-30 日志 56 第二版（玩家裁定）。
         *
         *   玩家原话：
         *   > 部分技能比如**激光**不能被它修饰，看着不合理
         *
         *   追问后的口径：非飞行载体被它修饰时**什么都不做** ——
         *   那是**设计允许的**（所以这里**只警告、不报错**），
         *   但**必须让玩家看见**（"我装了它，它一次都没拐"不能是一句没人说的话）。
         *
         *   ⚠⚠ **判据只有一处**：`school.ts` 的 `carrierFliesInWorld(kind)` ——
         *     校验器（这条警告）和 `pricing.ts`（**不收钱**）读的是**同一个函数**。
         *     两处各写一份的话迟早出现"校验器说它不起作用、账本还在收钱"。
         *     ⚠ 玩家给这条的理由（原话）："**花钱买了什么都不做** 比'没提示'更糟"——
         *     所以"报出来"（这一条）和"不收钱"（账本那一侧）**必须成对**，
         *     而它们成对的方式就是共用这一个判据。
         *
         *   ⚠ 判据是"**一个会飞的都没有**"（不是"第一个不是飞行"）：
         *     一个技能可以有好几条动作（一发光弹 + 一记横扫），
         *     只要**有**一发会飞，这个零件就真的在起作用。
         */
        const kindSkillId = seg.skills[mod.at]
        const kindSkill = kindSkillId === undefined ? undefined : skills?.get(kindSkillId)
        if (kindSkill !== undefined) {
          const kinds = deliveryKindsOfSkill(kindSkill)
          /*
           * ⚠ **一个动作都没有的技能**（纯属性 / 纯位移那种）⇒ 也算"什么都不做"：
           *   它连载体都没有，追踪当然拐不了任何东西。
           *   ⚠ 但这条警告的措辞要能覆盖"没有载体"这一半，别只说"载体不是投射物"。
           */
          if (!kinds.some(k => carrierFliesInWorld(k))) {
            const what = kinds.length === 0
              ? '它一个载体都没有（纯属性 / 纯位移那种）'
              : `它的载体是 ${[...new Set(kinds)].join(' / ')}，没有一个会飞`
            out.push(warn('MODIFIER_HOMING_NOT_FLYING', `${at}.at`,
              `这个「${proto.name}」副本修饰的技能**不是一个会飞的东西** —— ${what}`,
              '玩家定的：**追踪只对会飞的东西有效**（`delivery.kind: "projectile"`）。'
              + '`beam` / `capsule` / `meleeArc` / `aura` / `area` / `self` 这些**非飞行载体**'
              + '被它修饰时**引擎什么都不做**。\n'
              + '⚠ 所以：**这一份不会被报错**（"不起作用"是设计允许的），'
              + '而且**账上一分钱都不收**（判据和这条警告是**同一个函数**：'
              + '`school.ts` 的 `carrierFliesInWorld`）—— 玩家原话：'
              + '"**花钱买了什么都不做** 比\'没提示\'更糟"。\n'
              + '⇒ 想让它真的起作用就换一个**投射物**技能；'
              + '不想用就把这份副本**删掉**。'))
          }
        }
      }

      /*
       * ---- 第 11 条：**「弹射」的三条规矩** ----
       *      ★ 2026-09-30 日志 58 新加的。判据全来自玩家那段规格：
       *
       *   ① `maxBounces` 在 `[1, 原型上限]` 里 —— ⚠⚠ 而**原型上限本身**
       *      又被引擎的深度上限顶着（`school.ts` 的 `modifierBounceMaxCountOf`
       *      夹的是 `MAX_ACTION_DEPTH`，`src/limits.ts`）。
       *      玩家原话："**上限必须和 `pipeline` 的深度限制用同一条规矩** ✗
       *      （各写一份迟早出现弹射绕过深度保护 ⇒ 自反馈 ✗）"。
       *      ⇒ 所以这一条的"范围"有**两半**：数据那一半（`maxBouncesCap`）
       *        **可以调小**，但**不许调大到超过深度上限**（超了在原型那一层报 ——
       *        见 `checks.ts` 的 `MODIFIER_PROTO_BAD_PARAMS`）。
       *   ② `damageFalloff` 在 `[原型下限, 原型上限]` 里（默认 0.7 = "每次 −30%"）。
       *   ③ **只对"会飞的东西"有效** —— 判据和追踪**共用同一个函数**
       *      （`carrierFliesInWorld`）：非飞行载体上装了它 ⇒ 警告 + **账上一分钱都不收**。
       *      ⚠⚠ 这条警告**不是**"引擎不做"的判据（那是代码形状保证的），
       *        而是"**必须让玩家看见**"的判据 —— 两处读同一个函数，不许各写一份。
       *
       *   ⚠ **今天只接线了 `at: 0`**（和份数类 / 排布 / 追踪同一个限制）。
       */
      if (proto !== undefined && proto.kind === 'bounce') {
        const countRaw = mod.params[MODIFIER_BOUNCE_COUNT_KEY]
        if (countRaw !== undefined) {
          const lim = modifierBounceMaxCountOf(proto)
          if (typeof countRaw !== 'number' || !Number.isFinite(countRaw)) {
            out.push(err('MODIFIER_BOUNCE_BAD_NUMBER', `${at}.params.${MODIFIER_BOUNCE_COUNT_KEY}`,
              `弹射的次数必须是一个有限的数（次），现在是 ${JSON.stringify(countRaw)}`,
              '⚠ 写成字符串时**不许静默当默认值**：玩家会看到"我写了 3 次，它按 2 次弹"'
              + ' —— 而两边的数都"看起来对"。'))
          } else if (!Number.isInteger(countRaw)) {
            out.push(err('MODIFIER_BOUNCE_BAD_NUMBER', `${at}.params.${MODIFIER_BOUNCE_COUNT_KEY}`,
              `弹射的次数必须是**整数**（次），现在是 ${String(countRaw)}`,
              '⚠ 引擎会 `Math.floor` 它（"弹 2.7 次"不是一种表现），'
              + '而"我写了 2.7、它弹了 2"必须说出来 —— 夹是兜底，不是判据。'))
          } else if (countRaw < MODIFIER_BOUNCE_COUNT_MIN || countRaw > lim) {
            out.push(err('MODIFIER_BOUNCE_OVER_CAP', `${at}.params.${MODIFIER_BOUNCE_COUNT_KEY}`,
              `这个「${proto.name}」副本的弹射次数是 ${String(countRaw)} 次，`
              + `超出它的范围 [${String(MODIFIER_BOUNCE_COUNT_MIN)}, ${String(lim)}] 次`,
              '⚠ 范围**住在原型里**（`content/modifiers/bounce.json` 的 `params.maxBouncesCap`）——'
              + '⚠⚠ 而它是**上限的上限**：数据**可以调小**（更保守），**调大无效**，'
              + '因为引擎真正读的是 `min(它, MAX_ACTION_DEPTH)`'
              + '（`src/limits.ts` —— `sim/pipeline.ts` 的深度限制**就是那一个数**）。'
              + '玩家原话："**上限必须和 pipeline 的深度限制用同一条规矩** ——'
              + '各写一份迟早出现弹射绕过深度保护 ⇒ 自反馈"。\n'
              + '⚠ 为什么这件事特别要紧：弹射是一条**链**，链上每一段都是**一颗新子弹**，'
              + '所以 `executeAction` 的 `depth` **不会自然累加** ——'
              + '次数就是这条链**唯一**的刹车。'))
          }
        }

        const falloffRaw = mod.params[MODIFIER_BOUNCE_FALLOFF_KEY]
        if (falloffRaw !== undefined) {
          const min = modifierBounceMinFalloffOf(proto)
          const max = modifierBounceMaxFalloffOf(proto)
          if (typeof falloffRaw !== 'number' || !Number.isFinite(falloffRaw)) {
            out.push(err('MODIFIER_BOUNCE_BAD_NUMBER', `${at}.params.${MODIFIER_BOUNCE_FALLOFF_KEY}`,
              `弹射的每次衰减必须是一个有限的数（乘数），现在是 ${JSON.stringify(falloffRaw)}`))
          } else if (falloffRaw < min || falloffRaw > max) {
            out.push(err('MODIFIER_BOUNCE_OVER_CAP', `${at}.params.${MODIFIER_BOUNCE_FALLOFF_KEY}`,
              `这个「${proto.name}」副本的每次衰减是 ${String(falloffRaw)}，`
              + `超出它的范围 [${String(min)}, ${String(max)}]`,
              '⚠ 它是**乘数**（0.7 = 玩家说的"每次 −30%"），范围**住在原型里**'
              + '（`params.minFalloff` / `maxFalloff`），不是代码里的常数。'
              + '⚠ 写 > 1 就是"越弹越强"（那不是这个零件的事）；'
              + '写 0 会让弹射的第二段变成 **0 伤害**（和"没有第二段"分不出来）。'))
          }
        }

        // ⚠ `at` 的限制**和份数类 / 排布 / 追踪一样**：引擎只读 `targetIndex === 0`
        if (at2 !== 0) {
          out.push(warn('MODIFIER_GROUP_AT_NOT_WIRED', `${at}.at`,
            `这个「${proto.name}」副本的 at 是 ${String(at2)}，而**今天只有 \`at: 0\` 会生效**`,
            '⚠ 引擎读修饰副本的地方（`sim/pipeline.ts` 的 `bounceOfCast`）'
            + '只处理**紧邻的第一个技能**被修饰的情形 —— 和「多重释放」/「一分为 X」/'
            + '「排布」/「追踪」同一个限制。'
            + '⚠ **写上去不生效**是这个项目列为最危险的一类静默失败，所以这里出声。'))
        }

        /*
         * ---- **「弹射」只对"会飞的东西"有效** ----
         *
         *   ⚠⚠ **判据和追踪是同一条**（玩家原话："这**和「追踪」是同一条规矩** ✓
         *     所以**判据要共用**"）⇒ 两处读的**都是** `school.ts` 的
         *     `carrierFliesInWorld`。⚠ 这一条最要紧：它同时管住
         *     "报出来"（这里）和"**不收费**"（`pricing.ts`）。
         */
        const bSkillId = seg.skills[mod.at]
        const bSkill = bSkillId === undefined ? undefined : skills?.get(bSkillId)
        if (bSkill !== undefined) {
          const kinds = deliveryKindsOfSkill(bSkill)
          if (!kinds.some(k => carrierFliesInWorld(k))) {
            const what = kinds.length === 0
              ? '它一个载体都没有（纯属性 / 纯位移那种）'
              : `它的载体是 ${[...new Set(kinds)].join(' / ')}，没有一个会飞`
            out.push(warn('MODIFIER_BOUNCE_NOT_FLYING', `${at}.at`,
              `这个「${proto.name}」副本修饰的技能**不是一个会飞的东西** —— ${what}`,
              '玩家定的：**弹射只对会飞的东西有效**（`delivery.kind: "projectile"`）。'
              + '`beam` / `capsule` / `meleeArc` / `aura` / `area` / `self` 这些**非飞行载体**'
              + '被它修饰时**引擎什么都不做**。\n'
              + '⚠ 所以：**这一份不会被报错**（"不起作用"是设计允许的），'
              + '而且**账上一分钱都不收**（判据和这条警告是**同一个函数**：'
              + '`school.ts` 的 `carrierFliesInWorld` —— 和「追踪」那条警告读的是它）'
              + '—— 玩家原话："**花钱买了什么都不做** 比\'没提示\'更糟"。\n'
              + '⇒ 想让它真的起作用就换一个**投射物**技能；'
              + '不想用就把这份副本**删掉**。'))
          }
        }
      }
    }
  }

  if (constant.length > 0 && tech.activation !== 'press') {
    out.push(err('WRAP_IN_NON_PRESS_TECHNIQUE', 'sequences',
      `第 ${constant.map(i => i + 1).join('、')} 段被**常驻包装**了，但这门术式的激活方式是 ${tech.activation}（不是 press）`,
      '玩家定的：「常驻包装把它自己和后面那个技能包装成常驻 →'
      + '于是这一块**进常驻序列、不参与按键激活（被跳过）**」。'
      + '⚠ "不参与按键激活"只有在一门**按一下**的术式里才有意义：'
      + '`auto` 的常驻术式本来就不参与按键激活（包装在那儿是个空动作），'
      + '而 `release` / `hold` / `toggle` 都带着一次玩家输入，'
      + '那一块不该等输入。'
      + '⚠ **"常驻块和按键块能不能混在一门术式里"是待裁定项**'
      + '（定稿 §六 说能混，而这一条暂时按"不能"处理）—— 见日志 48。'))
  }

  return out
}

function summarize(name: string, found: Issue[]): CheckGroupReport {  return {
    name,
    errors: found.filter(i => i.level === 'error').length,
    warnings: found.filter(i => i.level === 'warning').length,
  }
}

/**
 * 技能的点数账。
 *
 * ⚠ **整份都是算出来的。**
 *   第一版把点数手写在规则和阶段上，结果玩家把"30 伤害"改成"300 伤害"，
 *   点数纹丝不动 —— 等于可以白嫖。做编辑器的时候实测踩到的。
 *   现在点数是内容的函数：改数值，点数自己跟着变。
 */
export function buildLedger(
  skill: Skill,
  balance: BalanceConfig,
  statuses?: ReadonlyMap<string, StatusDef>,
  entities?: ReadonlyMap<string, EntityDef>,
): LedgerEntry[] {
  return priceSkill(skill, priceOptions(balance, statuses, entities)).entries
}

/**
 * 校验一个**技能**（编辑的单位：阶段 + 规则）。
 *
 * 顺序很重要：先查结构，结构坏到一定程度就不往下走了 ——
 * 否则后面的检查会产出一屏没有意义的报错，反而盖住真正的问题。
 */
export function validateSkill(
  file: string,
  skill: Skill,
  balance: BalanceConfig,
  /** 状态库。不传的话按 statusId 引用的状态算不出点数（当成 0 点） */
  statuses?: ReadonlyMap<string, StatusDef>,
  /** 实体预设。不传的话召唤算不出价钱 */
  entities?: ReadonlyMap<string, EntityDef>,
  /**
   * 技能库（`content/skills/` + `content/weapon-skills/`）。
   *
   * ⚠ 2026-09-30（日志 59）新加的：**变体（`basedOn`）的"档位检查"要拿它的
   *   基础技能当基准**（"这一段现在这个时长在不在档位表里"）。
   *   不传的话只跳过那一条检查 —— 而"跳过"和"没问题"看起来一样。
   *   命令行已经把整张表建好了才调这里（见 `cli/validate.ts`）。
   */
  skills?: ReadonlyMap<string, Skill>,
): ValidationReport {
  const ctx: checks.Ctx = { skill, balance }
  const issues: Issue[] = []
  const groups: CheckGroupReport[] = []

  const shapeIssues = checks.checkShape(ctx)
  issues.push(...shapeIssues)
  groups.push(summarize('结构', shapeIssues))

  const fatal = shapeIssues.some(i =>
    i.level === 'error' && (i.code === 'BAD_RULES' || i.code === 'NO_PHASES'))

  if (!fatal) {
    const rest: [string, Issue[]][] = [
      ['引用', checks.checkReferences(ctx)],
      ['阶段', checks.checkPhases(ctx)],
      ['规则', checks.checkRules(ctx)],
      ['动作与载荷', checks.checkActions(ctx)],
      ['状态', checks.checkStatuses(ctx)],
      ['目标', checks.checkTargeting(ctx)],
    ]
    for (const [name, found] of rest) {
      issues.push(...found)
      groups.push(summarize(name, found))
    }
  }

  // ---- 点数账：全部由 pricing 推导 ----
  const opts = priceOptions(balance, statuses, entities)
  const priced = priceSkill(skill, opts)

  /*
   * ⚠ 这里**故意一条点数问题都不报**。
   *
   *   玩家 2026-09-21 的原话：
   *   > 技能不必配平到 0，但要想编排为术式，术式必须配平（单个技能也可以成为术式）
   *
   *   技能是**零件**：一块纯收益（+17 的火球）和一块纯代价（-8 的长冷却收招）
   *   都是合法的零件。要求每个零件自己配平的话，任何组合都自动是平的，
   *   "配平"这件事就整个消失了 —— 而且账面上永远绿灯，错得很隐蔽。
   *
   *   配平检查在 `validateTechnique` 里。单个技能当术式用时，
   *   它自己就会被要求配平，所以这里不需要重复一遍。
   *
   *   为什么不加一条"这个零件不平衡"的**警告**：那是假警报。
   *   零件的价值就是它可以歪 —— 玩家会**故意**做歪零件，
   *   这时候弹警告等于告诉他"你做错了"，而他没有。
   *   （这个坑踩过好几次了：`NO_DELIVERY`、`PREV_HIT_ON_FIRST_LINK`
   *     都是对着唯一正确的写法报警告。）
   *
   *   不平衡这件事由**编辑器里那条实时点数条**呈现，那才是它该在的地方：
   *   看得见、边改边变、不是一次性的报告。
   */
  const pointIssues: Issue[] = []

  /*
   * ⚠ ---- **内容里出现的取值必须在档位表里**（2026-09-30 日志 59）----
   *
   *   查表定价的前提是"取值落在档位上"。这一段时长如果不是表里的某一档
   *   （`0 / 1× / 3× / 9×`），账就**指不出这一格值多少点** ——
   *   而"指不出来"如果被实现成"那就是 0 点"，就正好复刻了本项目当年删掉
   *   手写 `points` 的那个病：**内容改了，点数纹丝不动**。
   *
   *   ⚠ 基准**只能是它的基础技能（`basedOn`）**：
   *     · 出厂技能（没有 `basedOn`）的基准就是它自己 ⇒ 恒为 `1×` ⇒ 永远在表里
   *       （所以这一条**对出厂内容一个错都不报**，那条"出厂全 0"的常驻断言不受影响）；
   *     · 变体（玩家在编辑器里另存出来的那一份）才是真的会落到格子外的那种 ——
   *       编辑器今天的时长控件还是**线性秒数**滑块（点表 `[-1, 0.1, 0.2, 0.3, 0.5, 1]`），
   *       四档选择是日志 50 §6.2 留下的欠账，还没做。
   *   ⚠ 技能库没传（单独校验一个临时文件）时**跳过**这一条 —— 那时没有基准。
   */
  if (skill.basedOn !== undefined && skills !== undefined) {
    const template = skills.get(skill.basedOn)
    if (template !== undefined) {
      for (const p of phaseTierProblems(skill, template, opts)) {
        pointIssues.push(err('PHASE_TIER_NOT_IN_TABLE', `phases[${p.phaseId}].duration`,
          `这一段出厂是 ${p.wasDuration} 秒，现在是 ${p.nowDuration} 秒 —— `
          + '这个取值不在档位表里',
          `阶段时长的价是**查表**查出来的（${p.table}：`
          + '`0` 取消这一段 / `1×` 出厂本身 / `3×` / `9×`）。'
          + `⚠ 现在这个时长是 ${p.nowDuration} 秒，不在任何一档上，所以`
          + '**账指不出这一格值多少点**。请把时长拖回四个档位之一'
          + '（编辑器里"取消前摇"的四档选择是欠账，见日志 50 §6.2 —— 在做出来之前，'
          + '把 duration 写成"出厂值 × 0 / 1 / 3 / 9"的秒数即可）。'))
      }
    }
  }

  /*
   * ⚠ ---- **表外取值 → 报错**（2026-09-30 日志 60b 第 ① 条）----
   *
   *   账现在是**查表 + 相加**（`pricing.ts` 的 `lookupEntriesOf`，用户规格）。
   *   查表定价的前提是"这个取值在表里有格子" —— **没有格子就指不出它值多少点**。
   *   而"指不出来"如果被实现成"那就是 0 点"，就正好复刻了本项目当年删掉
   *   手写 `points` 的那个病：**内容改了，点数纹丝不动**（"把 30 改成 300"）。
   *
   *   ⇒ 所以这一条是**错误**，而且账那边**也不许静默**：`lookupEntriesOf`
   *     会为这一格留一条 `⚠ 表外取值…` 的 0 点记录（看得见）。
   *
   *   ⚠ 它和上面那条 `PHASE_TIER_NOT_IN_TABLE`（阶段时长的档位）是两个时代的东西：
   *     老那条只管一根轴（时长走档位表），这一条管**全部 377 个变量**。
   *     ⚠ 两条都留着是有意的：没有表（`balance.json` 缺 `lookupTable` 那一栏）时
   *     账会退回老公式+档位表，那时老那条仍然是对的。
   *
   *   ⚠ 基准**只能是它的基础技能（`basedOn`）**，和账的口径逐字相同：
   *     变体对着模板查取值。技能库没传 / 模板不在库里 ⇒ 跳过
   *     （"跳过"这件事由命令行的 `checkLookupCoverage` 第 ③ 条兜住）。
   */
  const lookupTable = readLookupTable(balance.lookupTable)
  if (lookupTable !== undefined) {
    const base = skill.basedOn !== undefined ? skills?.get(skill.basedOn) : skill
    if (base !== undefined) {
      for (const gap of lookupGapsOf(skill, base, lookupTable)) {
        // ⚠ 只有"取值不在表里"是错：另外两种（没有分区 / 变量在这份技能里不存在）
        //   由第 ③ 条和 `lookupGapsOf` 的注释各管一段，在这里报就是**假警报**。
        if (gap.why !== 'value-not-in-table') continue
        pointIssues.push(err('LOOKUP_VALUE_NOT_IN_TABLE', gap.variable ?? skill.id,
          `变量 ${String(gap.variable)} 现在选中了 ${String(gap.value)}，而这个取值在点表里没有格子`,
          '账按表算：**表里没有这一格 ⇒ 指不出它值多少点**（不许静默当 0 —— 用户第 ① 条）。'
          + '请把取值改回表里有的那一档；如果这个取值是**新设计**，'
          + '那要请用户把这一格补进 `content/balance.json` 的 `lookupTable`'
          + '（⚠ 那张表是**用户签的字**，代码这边不许自己填数）。'))
      }
    }
  }

  issues.push(...pointIssues)
  groups.push(summarize('点数', pointIssues))
  return {
    file,
    id: typeof skill.id === 'string' ? skill.id : '(无 id)',
    name: typeof skill.name === 'string' ? skill.name : '(无名字)',
    kind: priced.kind,
    total: priced.total,
    declaredTotal: priced.total,
    bloodPactPerUse: priced.kind === 'negative' ? Math.abs(priced.total) : 0,
    /*
     * ⚠ **武器技能（只读）不报账**。玩家 2026-09-21：
     *   > 我不是说了武器技能不算帐吗
     *
     *   它算出来的那个数是**拿缺省武器属性硬猜**的（`weapon.damage` 读不到
     *   就退到 1）—— 真正的数值要看装在哪把武器上。给一个猜出来的数字，
     *   玩家会照着它调平衡，而那个平衡根本不存在。
     *
     *   注意这里只是**不报账**：它照样过结构检查（`issues` 一条不少），
     *   因为这些技能是内容的一部分，写错了还是要在加载期炸出来。
     */
    ledger: skill.readonly === true ? [] : priced.entries,
    ...(skill.readonly === true
      ? { priceless: '武器技能不算账 —— 数值由武器属性代入（reach / damage / windup），'
        + '校验器看不见那把武器。强度体现在**装到哪把武器上**。' }
      : {}),
    issues,
    groups,
    fatal,
  }
}

export function validateWeapon(
  file: string,
  weapon: WeaponDef,
  /** 内容库里的术式 id 表。不传就不查两个术式槽的悬空引用 */
  techniques?: ReadonlySet<string>,
): ValidationReport {
  const issues = checks.validateWeapon(weapon, techniques)
  const errors = issues.filter(i => i.level === 'error').length
  const warnings = issues.length - errors

  /*
   * ⚠ 武器的账**是空的**，而且这不是"还没做"，是**对的**：
   *
   *   武器不带效果，带的是**属性**（reach / damage / windup）。
   *   点数账是"这一下有多强"的账，武器的强度体现在它代入技能之后
   *   —— 那把账记在**术式**头上（同一份横砍模板，长剑和短匕的点数一样，
   *   因为它们**形状**一样，差的是数值）。
   *
   *   所以武器这一栏只有红绿灯，没有明细。要做"武器强度分"的话，
   *   那应该是另一个指标（把属性代进去重算一遍术式的总伤害），
   *   不是把这里的空账填满。
   */
  return {
    file,
    id: typeof weapon.id === 'string' ? weapon.id : '(无 id)',
    name: typeof weapon.name === 'string' ? weapon.name : '(无名字)',
    kind: 'normal',
    total: 0,
    declaredTotal: 0,
    bloodPactPerUse: 0,
    ledger: [],
    issues,
    groups: [{ name: '武器', errors, warnings }],
    fatal: false,
  }
}

/**
 * 校验一个**术式**（绑按键的东西：激活方式 + 目标 + 一串技能）。
 *
 * ⚠ **点数的判据在这里**，不在技能上。
 *   玩家原话：_"技能不必配平到 0，但要想编排为术式，术式必须配平
 *   （单个技能也可以成为术式）"_
 *   术式是成品，成品必须用得起。零件可以很歪。
 *
 * ⚠⚠ 2026-09-30（日志 57）：**"配平到 0"这句话只对了一半**，用户重新定了口径：
 *   > **点数之和大于 0 就能用，小于 0 就要支付血契才能用**
 *   ⇒ 判据只有一条：**合计 < 0 ⇒ 负值术式**（警告 + 血契），
 *     合计 ≥ 0 ⇒ 能用，**不报任何东西**（"额度没用完"不再是问题）。
 *     "容差 2 点"连同 `NOT_BALANCED` 那条错误**一起删了**。
 *
 * 引用的技能存不存在本身是编译期的事（见 src/sim/compile.ts），
 * 但**算账必须有技能表**，所以传了 `skills` 就顺便把"引用不到的零件"
 * 也报出来 —— 不然账会静默地少算一段，玩家看到的是"能用"。
 */
export function validateTechnique(
  file: string,
  tech: Technique,
  opts: {
    balance?: BalanceConfig
    skills?: ReadonlyMap<string, Skill>
    statuses?: ReadonlyMap<string, StatusDef>
    entities?: ReadonlyMap<string, EntityDef>
    /**
     * 内容库里的术式表（用来查 `sequences` 指不指得到东西）。
     *
     * ⚠ 不传就**不查** —— 和 `skills` 一样：单独校验一个术式文件、
     *   没有整库的时候，查了只会把存在的序列误报成悬空。
     *   （这也是为什么它是可选的，而不是"必须传一张空表"。）
     */
    techniques?: ReadonlyMap<string, Technique>
    /**
     * **修饰原型表**（原型 id → 机制类别）。
     *
     * ⚠ 不传就**不查修饰副本的规矩**（和 `skills` / `techniques` 同一个约定）：
     *   单校验一份术式、手里没有原型表的时候，查了只会把
     *   "这是个合法的触发器"误报成"原型不存在"。
     *   ⚠ 但那意味着**别的检查里必须有人传它** —— 传它的是
     *   `cli/validate.ts` 和 `web` 编辑器，两边都拿得到内容库。
     */
    modifierProtos?: ReadonlyMap<string, ModifierProto>
  } = {},
): ValidationReport {
  const issues: Issue[] = []

  if (tech.schemaVersion !== 1) {
    issues.push(err('BAD_VERSION', 'schemaVersion',
      `schemaVersion 应为 1，实际是 ${JSON.stringify(tech.schemaVersion)}`))
  }
  if (typeof tech.id !== 'string' || tech.id === '') {
    issues.push(err('MISSING', 'id', '缺少 id'))
  }
  if (typeof tech.name !== 'string' || tech.name === '') {
    issues.push(err('MISSING', 'name', '缺少 name'))
  }

  const ACTIVATIONS = ['press', 'release', 'hold', 'toggle', 'auto']
  if (!ACTIVATIONS.includes(tech.activation)) {
    issues.push(err('BAD_ENUM', 'activation',
      `激活方式取值非法：${JSON.stringify(tech.activation)}`,
      `合法值：${ACTIVATIONS.join(' / ')}`))
  }

  /*
   * ---- 系别（`kind`）：武器术式 / 魔法术式，**必填** ----
   *
   * ⚠ 玩家 2026-09-21 定的：**新建时选、之后不能改**。
   *   今天"武器术式"的判据是"写了 `sequences`"，而新编辑器会让**所有**
   *   术式都走序列层 —— 那条判据会失效，而且失效得**很安静**
   *   （见 schema 里 `Technique.kind` 的注释）。所以这里是显式字段。
   *
   * ⚠ 缺了它**不许默认成 magic**：默认的话，一门武器术式会被当成魔法术式，
   *   报出来的是一堆"魔法术式里不能出现武器系技能" ——
   *   真正的问题（字段没写）反而被埋在下面。
   */
  const kindOk = tech.kind === 'weapon' || tech.kind === 'magic'
  if (!kindOk) {
    issues.push(err('MISSING_KIND', 'kind',
      `kind（系别）必须是 'weapon' 或 'magic'，实际是 ${JSON.stringify(tech.kind)}`,
      '系别回答"这是武器术式还是魔法术式"，**新建时选、之后不能改** ——'
      + '编辑器的技能库按它过滤，校验器按它检查里面的技能同不同系。'
      + '老内容 / 老存档没有它时由加载器补上（src/school.ts 的 deriveTechniqueKind：'
      + '**直接或顺着序列引用了武器系技能**的算 weapon，否则算 magic；'
      + '⚠ 不是"有 sequences 就算 weapon"）。'))
  }

  /*
   * ---- 三层模型：术式编排的是**技能**或**序列**，二选一 ----
   *
   * ⚠ 玩家 2026-09-21 定的：
   *   > 本质上是在术式的层级之下多加了一层序列层……
   *   > 序列在**实现方式**上可以看作术式，但在**激活方式**上它在术式层级的下方。
   *
   *   所以一个术式要么走"技能链"（普通术式），要么走"序列循环"（武器术式）。
   *   **两个都写没有答案** —— "按一次到底该走哪套"说不清，所以是错误。
   */
  const hasSkills = Array.isArray(tech.skills) && tech.skills.length > 0
  const seqs = Array.isArray(tech.sequences) ? tech.sequences : []
  const hasSequences = seqs.length > 0

  if (!hasSkills && !hasSequences) {
    issues.push(err('NO_SKILLS', 'skills',
      '术式至少要引用一个技能，或者一组序列',
      '术式是编排：普通术式编排技能，武器术式编排序列。'
      + '两样都是空的，它就没东西可放。'))
  } else if (hasSkills && hasSequences) {
    issues.push(err('SKILLS_AND_SEQUENCES', 'sequences',
      '同时写了 skills 和 sequences —— 按一次到底走哪套没有答案',
      '普通术式用 `skills` + `links`；挂了序列的术式用 `sequences` + `sequenceLinks`。'
      + '要一段攻击先从技能开始，就在**序列内部**写技能链'
      + '（`sequences[i].skills` + `sequences[i].links`）。'))
  } else if (hasSkills && (tech.skills?.length ?? 0) > 4) {
    issues.push(warn('MANY_SKILLS', 'skills',
      `这个术式引用了 ${tech.skills?.length ?? 0} 个技能`,
      '技能是按顺序接起来，引太多会让释放时间变得很长。'))
  }

  /*
   * ---- 系别要一致：术式里的每一个技能都必须和它同系 ----
   *
   * ⚠ **这是这次改动真正的牙齿。** 技能的系别由**目录**决定
   *   （content/skills → 魔法、content/weapon-skills → 武器，见 src/school.ts），
   *   而术式自己声明它要哪一系。两者对不上的后果是**静默的**：
   *
   *     · 武器技能（`readonly`）的数值由**武器属性代入**（`ref: 'weapon.*'`）。
   *       它被放进魔法术式里时，那一份**永远代入不进去**（读缺省值）——
   *       打出来的伤害和编辑器里显示的都不对，而没有一处报错。
   *     · 魔法技能放进武器术式，等于把"左键普攻"那一套（免费、按序列走、
   *       不算账）套在一个普通技能上，"普攻免费"这条设计就漏了。
   *       ⚠ 玩家 2026-09-21 定的**新账规矩**是"**按系别分**：武器术式不算账、
   *         魔法术式都要算账"（写在
   *         [`docs/sequence-and-modifier-model.md`](../../../docs/sequence-and-modifier-model.md)
   *         的欠账一节里）—— ⚠ 这句后面本来跟着"**而代码里还是老的
   *         '序列术式不算账'**，实现新规矩是下一片的事"。
   *         **新规矩已经落地了**（2026-10-06 日志 64）：判据只有一处，
   *         即 `school.ts` 的 `techniquePaysPoints`（读 `kind`）。
   *
   * ⚠ **序列里的技能也要查**（2026-09-21 日志 46 补的，否则这条规矩会漏掉一半）。
   *
   *   两条判据各自要成立：
   *     · 内联的段 → 直接读段里的 `skills`（技能就在手边）
   *     · 老形状的字符串 → 按 id 去 `opts.techniques` 里查那份子术式（老存档 / 老分享码）
   *   只查 `tech.skills` 的话，**挂了序列的术式一条都查不到** ——
   *   而"魔法术式里放武器技能"最典型的形状恰恰是"序列里放的"。
   *
   *   ⚠ 报错的 `path` 指到**具体哪一段的哪一个技能**（`sequences[j].skills[i]`）：
   *     只说"这个术式里有武器技能"的话，一份十来段的术式根本找不着地方。
   *
   * ⚠ `skill.school` 缺失时**不许静默通过**（`SKILL_SCHOOL_MISSING`）——
   *   那种情况下"同不同系"根本判不了，而"判不了"和"没问题"看起来一模一样。
   */
  if (opts.skills !== undefined) {
    /** 一门术式里**全部**按 id 引用的技能，带 JSON 路径。两半都收 */
    const refs: { id: string; path: string }[] = []
    for (let i = 0; i < (tech.skills ?? []).length; i++) {
      const id = (tech.skills ?? [])[i]
      if (typeof id === 'string' && id.length > 0) refs.push({ id, path: `skills[${i}]` })
    }
    const segs = tech.sequences ?? []
    for (let j = 0; j < segs.length; j++) {
      const seg = segs[j]
      if (seg === undefined) continue
      if (typeof seg !== 'string') {
        /*
         * ⚠ `Array.isArray` 不是防御性编程：手改坏的存档/分享码里
         *   `sequences: [{ name: '坏的' }]` 会让 `seg.skills.length` 当场抛 ——
         *   而那是**校验器自己崩**，报出来的东西和内容的问题完全无关。
         *   形状错由后面的 `BAD_SEQUENCE` 报（那一条才是给人看的）。
         */
        if (!Array.isArray(seg.skills)) continue
        for (let i = 0; i < seg.skills.length; i++) {
          const id = seg.skills[i]
          if (typeof id === 'string' && id.length > 0) refs.push({ id, path: `sequences[${j}].skills[${i}]` })
        }
        continue
      }
      // 老形状：那份子术式的技能也算这一门术式的（和引擎的 `resolveSegment` 同一个意思）
      const seq = opts.techniques?.get(seg)
      for (let i = 0; i < (seq?.skills ?? []).length; i++) {
        const id = (seq?.skills ?? [])[i]
        if (typeof id === 'string' && id.length > 0) refs.push({ id, path: `sequences[${j}].skills[${i}]` })
      }
    }

    for (const { id, path } of refs) {
      const sk = opts.skills.get(id)
      // 引用不到的零件由 UNKNOWN_SKILL 报（那一条才算得了账）
      if (sk === undefined) continue

      const school = sk.school
      const skName = typeof sk.name === 'string' && sk.name.length > 0 ? sk.name : id

      if (school === undefined) {
        issues.push(err('SKILL_SCHOOL_MISSING', path,
          `技能「${skName}」没有系别章（school），判不了它能不能放进「${tech.name}」`,
          '系别是**加载时按目录盖上去的派生字段**（content/skills → magic，'
          + 'content/weapon-skills → weapon），内容 JSON 里本来就没有它、也不该写。'
          + '看到这一条说明**这张技能表不是走加载器建的** —— '
          + '命令行走 loadLibrary()、浏览器走 web/src/main.ts 的 loadContent()，'
          + '系别规则本身在 src/school.ts。'))
        continue
      }

      if (!kindOk) continue   // 上面已经报了 MISSING_KIND，别再说一遍

      if (tech.kind === 'weapon' && school !== 'weapon') {
        issues.push(err('WEAPON_TECHNIQUE_MAGIC_SKILL', path,
          `武器术式「${tech.name}」里放了魔法系技能「${skName}」`,
          '武器术式里**每一个技能都必须是武器系技能**（content/weapon-skills/ 里的模板）——'
          + '它靠武器属性代入数值（reach / damage / windup），魔法技能没有那一套。'
          + '换成武器技能，或者把这份术式建成魔法术式（系别新建时选，之后不能改）。'
          + '⚠ 序列里的技能也算"这份术式里的技能"（2026-09-21 起）。'))
      } else if (tech.kind === 'magic' && school === 'weapon') {
        issues.push(err('MAGIC_TECHNIQUE_WEAPON_SKILL', path,
          `魔法术式「${tech.name}」里放了武器系技能「${skName}」`,
          '武器系技能（content/weapon-skills/）是**只读模板**，数值由武器属性代入 ——'
          + '只有在武器术式里才代得进去，放进魔法术式里它读的是缺省值。'
          + '要么换成魔法系的技能，要么把这份术式的 kind 定成 weapon'
          + '（新建时选，之后不能改；老内容请照 src/school.ts 的规则补上）。'
          + '⚠ 序列里的技能也算"这份术式里的技能"（2026-09-21 起）。'))
      }
    }
  }

  /*
   * ---- 施法形态 × 激活方式 ----
   *
   * ⚠ 只在**技能表拿得到**而且 activation 是合法取值的时候查：
   *   · 没有技能表就判不了形态（`opts.skills` 不传的场合是分享码那种半截数据，
   *     报一屏"判不了形态"没有用）—— 和上面"系别"那一节同一个约定；
   *   · activation 非法时上面已经报了 BAD_ENUM，这里再报一屏"不相容"只会盖住它。
   *
   *   具体的两条规则在 `skillFormIssues`（文件上半部分，连相容表一起）。
   */
  if (opts.skills !== undefined && ACTIVATIONS.includes(tech.activation)) {
    issues.push(...skillFormIssues(tech, opts.skills, opts.techniques))
  }

  /*
   * 序列之间也能带条件（玩家明确要的）。
   * `sequenceLinks[i]` 管 `sequences[i+1]` —— 和 `links` 是同一套平行数组约定。
   */
  if (hasSequences) {
    const sl = tech.sequenceLinks ?? []
    const maxSl = seqs.length - 1
    if (sl.length > maxSl) {
      issues.push(err('TOO_MANY_SEQUENCE_LINKS', 'sequenceLinks',
        `有 ${sl.length} 条序列条件，但 ${seqs.length} 条序列最多只需要 ${maxSl} 条`,
        'sequenceLinks[i] 管的是 sequences[i+1]。多出来的指向不存在的序列，'
        + '不会有任何效果。'))
    }
    if (tech.sequenceTimeout !== undefined
      && (!isNum(tech.sequenceTimeout) || tech.sequenceTimeout <= 0)) {
      issues.push(err('BAD_SEQUENCE_TIMEOUT', 'sequenceTimeout',
        'sequenceTimeout 必须是正数（秒）',
        '它是"两条序列之间最多隔多久还算连着"。不写默认 1 秒。'))
    }
    /*
     * ⚠ 序列之间的门**也要过同一条判据**（2026-09-30 日志 54）：
     *   `if: [{}]` 恒假 ⇒ 后面那一条序列**永远不激活**，而它读起来像"没有门"。
     */
    for (let j = 0; j < sl.length; j++) {
      const link = sl[j]
      if (link === undefined || !Array.isArray(link.if)) continue
      for (let k = 0; k < link.if.length; k++) {
        if (checks.isEmptyConditionObject(link.if[k])) {
          issues.push(err('EMPTY_CONDITION', `sequenceLinks[${j}].if[${k}]`,
            '这一条序列门的条件是**空对象**（`{}`）—— 它**恒不成立**',
            '⚠ 后面那一条序列会**永远不激活**，而它读起来像"无条件"。'
            + '要"没有门"就写 `if: []` 或者干脆不写 `if`。'))
        }
      }
    }
    /*
     * ---- 每一段都得是个能用的形状 ----
     *
     * ⚠ 两半都认（见 schema 的 `TechniqueSequences`）：
     *   · **内联的段**：得是个对象，而且 `skills` 必须是数组 ——
     *     不然编译期会 `for…of` 一个 undefined（那是**加载期**的炸，一炸白屏）
     *   · **老形状的字符串**：得是非空字符串
     */
    for (let j = 0; j < seqs.length; j++) {
      const seg = seqs[j]
      if (typeof seg === 'string') {
        if (seg.length === 0) {
          issues.push(err('BAD_SEQUENCE', `sequences[${j}]`, '序列 id 是空字符串'))
        }
        continue
      }
      if (seg === null || typeof seg !== 'object' || !Array.isArray(seg.skills)) {
        issues.push(err('BAD_SEQUENCE', `sequences[${j}]`,
          '这一条序列的形状不对：内联的序列必须是个对象，而且带 `skills` 数组',
          '内联的形状是 `{ name?, skills: [...], links?: [...] }`。'
          + '⚠ `skills` 不是数组的话，编译期遍历它会当场抛 —— 那是**加载期**的炸。'))
        continue
      }

      /*
       * ---- ⚠ 防回潮②：序列段里再写 `targeting` → **报错** ----
       *
       * 和术式那一层同一条规矩（玩家 2026-09-21，日志 47）：
       * **序列段也不带瞄准**，瞄准在**技能**上。
       *
       * ⚠ 它是"上一片临时保留、这一片删掉"的那个字段
       *   （`SequenceSegment.targeting`，内联时从旧子术式照搬过来的）——
       *   所以**旧内容文件里每一段都还写着它**，照抄一段就会把它带回来。
       *   报错是唯一能拦住这件事的东西。
       *
       * `path` 指到**具体哪一段**：一份十来段的术式里得能找到是哪儿。
       */
      if ((seg as unknown as Record<string, unknown>)['targeting'] !== undefined) {
        issues.push(err('TARGETING_MOVED_TO_SKILL', `sequences[${j}].targeting`,
          '序列段不再有 targeting —— 瞄准搬到了**技能**上',
          '玩家 2026-09-21 定的：**序列段和术式一样不带瞄准**，'
          + '每个技能各自解释玩家给的那**一个意图**。'
          + `把这一段的瞄准写到**这一段里的那个技能**的 \`targeting\` 上`
          + '（`content/skills/*.json` / `content/weapon-skills/*.json`），'
          + '删掉段里这一份。'))
      }
    }

    /*
     * ⚠ 序列悬空引用：**这是最容易漏的一类错**。
     *
     *   `sequences: ["tech.ws-slash"]` 里的名字敲错时，引擎不会报错 ——
     *   它会得到一条"按下去没反应"的术式。名字敲错和那条序列真的没有
     *   在引擎看来完全一样，所以只有这里能提前告诉玩家。
     *
     *   （和 UNKNOWN_SKILL 同一个理由：账不但要算得对，还要算得**全**。）
     *
     * ⚠ 2026-09-21（日志 46）：**内容里已经不写这种形状了**（序列内联了，
     *   那四份子术式文件删掉了）。但这条检查**不能删** ——
     *   **老存档和老分享码里的术式就是这个形状**（玩家原话：判死等于
     *   他手里的东西全成垃圾），而这条检查正是唯一能告诉他
     *   "你这份老术式引用的那一份我这里没有"的地方。
     */
    if (opts.techniques !== undefined) {
      for (const seg of seqs) {
        if (typeof seg !== 'string' || seg.length === 0) continue
        if (!opts.techniques.has(seg)) {
          issues.push(err('UNKNOWN_SEQUENCE', 'sequences',
            `内容库里没有序列「${seg}」`,
            '这是**老形状**的序列（按 id 引用另一份术式）—— 迁移之后内容里'
            + '已经不这么写了（序列内联在术式里），所以这一份多半来自'
            + '旧存档 / 旧分享码，而它引用的那份子术式已经删掉了。'
            + '按下去不会有反应，但**不会崩**。'))
        }
      }
    }
  }

  /*
   * ---- 修饰技能（修饰副本）的规矩（★ 2026-09-21 日志 48 新加的）----
   *
   * ⚠ 这一节是**新机制的第一道牙齿**。四条规矩，全部来自定稿 §八：
   *   1. 副本得引用一个**存在的原型**（原型只做出厂那一批，玩家不能创建原型）；
   *   2. `at` 得指得到**这一段里真实存在**的那个技能（指不到 = 一条永远不触发的修饰）；
   *   3. **一条序列里不叠同类** —— 两个「多重释放」会炸成 4 个、8 个，账也算不清；
   *   4. **被常驻包装的段落只能出现在 `activation: "auto"` 的常驻术式里**。
   *
   * ⚠ 第 3 条的判据是**原型的 `kind`**，不是 `proto` 字符串：
   *   两个不同的触发器原型也是"同类"，叠在一起同样是"一次条件成立放出两段" ——
   *   那是同一类错误，不该因为 id 不同就放行。
   *   ⇒ 所以 `modifierProtos` 那张表（原型 id → 原型）要传进来。
   *
   *   ⚠ 2026-09-21（日志 51）这张表**从"id → kind"换成了"id → 原型"**：
   *     份数类修饰要读原型上的**上限**（`params.max`），只拿 kind 读不到。
   *     换成整份原型之后，kind 从它身上取（`proto.kind`）—— 一处读法，不分两份。
   *
   * ⚠ 第 4 条**排除了"一门术式里既有常驻块、又有按键块"**这种写法。
   *   定稿 §六 说"常驻序列**可以**和技能序列混在一门术式里"，所以这条是
   *   **更严的一版** —— 加它的理由是"按下去到底该不该走那一块"今天没有答案，
   *   而不是"它一定错"。**记在日志 48 的待裁定项里**，别当成定论。
   */
  if (opts.modifierProtos !== undefined) {
    issues.push(...modifierIssues(tech, seqs, opts.modifierProtos, opts.skills))
  }

  /*
   * ---- 序列里的技能必须存在（★ 2026-09-21 日志 46 新加的）----
   *
   * ⚠ **这是这次迁移唯一一处会让"静默失败"重新出现的地方，所以必须补上。**
   *
   *   内联之前，序列是**另一份术式**：`content/internal-techniques/ws-slash.json`
   *   自己会被 `npm run validate` 单独校验一遍，"它引用的技能在不在"在那时就查了
   *   （`UNKNOWN_SKILL`）。内联、而且把那几份文件删掉之后，
   *   那一遍**没有了** —— 段里的技能写错一个字母，校验器一声不响，
   *   玩家/作者要等按下去发现"这一段没反应"才知道。
   *
   *   ⚠ 这一条**不报账**，只报"找不到" —— 账怎么算见下面 `priceless` 那一段
   *     （序列段**不进点数账**，那是现行规矩，不是这里漏了）。
   */
  if (opts.skills !== undefined) {
    const skillsMap = opts.skills
    for (let j = 0; j < seqs.length; j++) {
      const seg = seqs[j]
      if (seg === undefined || typeof seg === 'string') continue
      // ⚠ 形状坏掉时不在这里抛 —— 由 `BAD_SEQUENCE` 报（理由见上面 `refs` 那段）
      if (!Array.isArray(seg.skills)) continue
      for (let i = 0; i < seg.skills.length; i++) {
        const id = seg.skills[i]
        if (typeof id !== 'string' || id.length === 0) {
          issues.push(err('BAD_SEQUENCE_SKILL', `sequences[${j}].skills[${i}]`,
            '这一项不是非空的技能 id'))
          continue
        }
        if (skillsMap.has(id)) continue
        issues.push(err('UNKNOWN_SKILL', `sequences[${j}].skills[${i}]`,
          `这一段引用了不存在的技能「${id}」`,
          '序列内联之后，那几份子术式文件没有了 —— 所以"技能在不在"'
          + '要在这里查（编译期也会报一次，但校验器这条能指出**是第几段的第几个**）。'
          + 'id 写错了，或者那个技能还没建。'))
      }
    }
  }

  /*
   * ---- ⚠ 防回潮①：术式里再写 `targeting` → **报错** ----
   *
   * 玩家 2026-09-21（日志 47）定的规矩：**术式没有瞄准** ——
   * 瞄准在**技能**上（`Skill.targeting`），每个技能各自解释那一个意图。
   *
   * ⚠ 为什么这里必须**报错**而不是"忽略它"：
   *   写上去的东西**不会生效**（术式那一层已经没有这个字段了，
   *   引擎读的是编译产物里从技能取来的那一份），
   *   而"写了没用的字段"在这个项目里是最贵的一类坑 ——
   *   声明了、放行了、作者照着填了，运行时却不读，而且**一处都不报错**。
   *   更坏的是这次是**回潮**：老内容里本来就有这个字段，
   *   照抄一份旧文件来改就会把它带回来。
   *
   * `path` 只写 `targeting`（不是"哪个技能的"）：它本来就不该在这儿。
   */
  if ((tech as unknown as Record<string, unknown>)['targeting'] !== undefined) {
    issues.push(err('TARGETING_MOVED_TO_SKILL', 'targeting',
      '术式不再有 targeting —— 瞄准搬到了**技能**上',
      '玩家 2026-09-21 定的：**术式没有瞄准**，每个技能各自解释玩家给的那**一个意图**'
      + '（默认鼠标方向）。把这份瞄准写到**那个技能**的 `targeting` 上'
      + '（`content/skills/*.json`），删掉术式这一层这一份。'))
  }

  /*
   * ---- 技能之间的连接条件（术式"编程"的地方） ----
   *
   * `links[i]` 管的是 `skills[i+1]`。所以长度最多是 `skills.length - 1`：
   * 多出来的连接指向一个不存在的技能，是**静默失效**的 ——
   * 玩家以为写了条件，实际那段技能永远无条件执行。
   */
  const links = tech.links ?? []
  const maxLinks = Math.max(0, (tech.skills?.length ?? 0) - 1)

  if (links.length > maxLinks) {
    issues.push(err('TOO_MANY_LINKS', 'links',
      `有 ${links.length} 条连接，但 ${tech.skills?.length ?? 0} 个技能最多只需要 ${maxLinks} 条`,
      'links[i] 管的是 skills[i+1]。多出来的那几条指向不存在的技能，'
      + '不会有任何效果。'))
  }

  for (let i = 0; i < links.length; i++) {
    const link = links[i]
    if (link === undefined) continue
    const at = `links[${i}]`

    if (link.if !== undefined && !Array.isArray(link.if)) {
      issues.push(err('BAD_LINK_IF', `${at}.if`, 'if 必须是数组'))
    }
    /*
     * ⚠ **`if: [{}]`（显式空条件对象）**（2026-09-30 日志 54 玩家裁定）：
     *   `evaluateAll([{}])` 恒假 ⇒ 这道门**永远不通过**（表现是"后面那个技能
     *   一辈子不放"），而它读起来像"我没写条件" —— 一声不吭的那一类。
     *   ⚠ 规则那一侧的同类判据在 `checks.ts` 的 `checkCondition` 里（同一个错误码）。
     */
    if (Array.isArray(link.if)) {
      for (let j = 0; j < link.if.length; j++) {
        if (checks.isEmptyConditionObject(link.if[j])) {
          issues.push(err('EMPTY_CONDITION', `${at}.if[${j}]`,
            '这一条连接的条件是**空对象**（`{}`）—— 它**恒不成立**',
            '⚠ 这道门会**永远不通过**（后面那个技能一辈不放），而它读起来像"无条件"。'
            + '要"没有门"就写 `if: []` 或者干脆不写 `if`。'))
        }
      }
    }
    if (typeof link.note === 'string' && /[0-9０-９]/.test(link.note)) {
      issues.push(warn('NOTE_WITH_NUMBER', `${at}.note`,
        `说明里写了数字：「${link.note}」`,
        '说明是从数据生成的，手写的数字改完数值就会变成错的。'))
    }
    if (link.elseTo !== undefined) {
      if (!Number.isInteger(link.elseTo) || link.elseTo < 0) {
        issues.push(err('BAD_LINK_TARGET', `${at}.elseTo`,
          'elseTo 必须是非负整数（技能的下标）'))
      } else if (link.elseTo <= i) {
        /*
         * ⚠ 只允许往后跳。往回跳就是循环，而"这次施法什么时候结束"
         *   会变成一件说不清楚的事 —— 技能是"一次释放"，本来就不该循环。
         */
        issues.push(err('LINK_LOOP', `${at}.elseTo`,
          `elseTo 是 ${link.elseTo}，不能往回跳（最多和 links[${i}] 平齐）`,
          '往回跳等于循环，施法就结束不了了。技能是一次释放，不该有循环。'))
      } else if (link.elseTo > (tech.skills?.length ?? 0)) {
        issues.push(err('BAD_LINK_TARGET', `${at}.elseTo`,
          `elseTo 是 ${link.elseTo}，超出了技能数量`,
          '它应该是"跳到第几个技能"，从 0 开始数。'))
      }
    }
  }

  /*
   * ⚠ 这里本来还有一条「links[0] 用了 prevHit 所以上一段不存在」的警告，**删掉了**：
   *   它是错的。`links[i]` 管的是 `skills[i+1]`，所以 `links[0]` 管 `skills[1]` ——
   *   它的上一段正是 `skills[0]`，`prevHit` 完全成立。
   *
   *   而"上一段技能碰到了人没有"这个条件在每一条连接上都是有意义的，
   *   不存在"用错位置"的情况。加了那条警告的结果是对着**唯一一个正确的例子**
   *   报警告 —— 差点让我去改本来没错的内容。
   */

  // ---- 点数账：术式是成品，成品必须**用得起**（合计 < 0 就要付血契）----
  const pointIssues: Issue[] = []
  let total = 0
  let kind: 'normal' | 'negative' = 'normal'
  let ledger: LedgerEntry[] = []
  /*
   * ⚠ 每次释放要付多少血契 —— **裁定 (A)**，从三段式表里读
   *   （2026-10-06 日志 66 接线）。它和**引擎扣的那个数**、
   *   和界面显示的那个数是**同一个函数**给的（`bloodPactOfResult`）。
   *   默认 0 对两种情形都对：不算账的武器术式、以及结构烂到算不出账的术式。
   */
  let bloodPactUse = 0

  const { balance, skills, statuses, entities } = opts

  /*
   * 结构烂到算不出账时就别算了：空术式没有账，
   * 硬算出来一个 0 会显示成"能用"，比不显示更糟。
   *
   * ⚠⚠ ---- **账按武器 / 魔法分开算**（用户 2026-09-30 第 7 条；
   *   2026-10-06 日志 64 落地）----
   *
   * 判据**只有一处**：`school.ts` 的 `techniquePaysPoints`（读 `kind` ——
   * 就是 `deriveTechniqueKind` 那个系别结论）。⚠ **不在这里另立一份**
   * （以前这里判的是"引用了 `readonly` 的技能吗"，那是**第二份**判据）。
   *
   *   · **武器术式 ⇒ 不算账**：它的数字来自**武器本身**
   *     （`weapon.damage` / `reach` / `windup` 由装上的那把武器代入），
   *     校验器看不见那把武器 —— 硬算出来的是一个**猜**出来的数，
   *     而一个猜出来的数字比没有数字更坏：它会被当成真的。
   *   · **魔法术式 ⇒ 算账** —— ⚠ **常驻（`activation: "auto"`）/ 主动都算**：
   *     常驻只是"不响应按键"，不等于免费。
   *
   * ⚠ **这条替掉了旧的"序列术式不算账"**（看有没有 `sequences`，
   *   2026-09-21 日志 46 写的那句）。它跟真相脱节，而且两头都说反了、一声不吭：
   *     · 一份**魔法**术式只要挂了序列（内联之后几乎人人都挂）就被说成"不算账"，
   *       而它的账**一直在算**（段上的修饰那一部分进账）、血契也照扣；
   *     · 一份**武器**术式反倒拿不到"武器侧"那句话 —— 它自己那一层没有
   *       `skills`，旧判据（`hasSkills && isWeaponSide(...)`）根本走不进去。
   *   ⇒ 日志 64 的探针实测：同一份武器术式（多重释放 ×10），
   *     编辑器那本账显示 **−18 点**、校验器说"不算账" —— 两份判据漂移的现形。
   *
   * ⚠⚠ **"不算账" ≠ "0 点免费"**：两者的**合计都是 0**，含义正相反
   *   （"0 点"是真的算过、账刚好平；"不算账"是根本没有这本账）。
   *   所以这里必须**说出来** —— 静默不显示会被读成"白送"。
   */
  const weaponTech = !techniquePaysPoints(tech)
  const priceable = (hasSkills || hasSequences) && skills !== undefined && !weaponTech

  let priceless: string | undefined
  if (weaponTech) {
    priceless = '武器术式不算账 —— 它的数字来自**武器本身**'
      + '（`weapon.damage` / `reach` / `windup` 由装上的那把武器代入），'
      + '校验器看不见那把武器，硬算出来的是一个猜出来的数。'
      + '⚠ **"不算账"不等于"0 点免费"**：它的强度体现在**装到哪把武器上** ——'
      + '换一把武器，这一门术式的数字就跟着变。'
  }

  /**
   * 这个术式**只对自己有效**吗？
   *
   * ⚠ 判据要和引擎里那一句**一字不差**：引擎读的是**编译产物**那份 `targeting`
   *   （`runTechniqueRules` 的 `selfOnly`），而编译产物那份是编译时从**技能**身上
   *   取来的（`compile.ts` 的 `targetingOfChain`：链上第一个带瞄准的技能）。
   *   所以这里也从技能取 —— **不是**从术式取（2026-09-21 日志 47 起术式没有瞄准了）。
   *
   *   ⚠ 两边取法不一致的话，报出来的错误本身就是错的 ——
   *     "不写 target 的动作落在谁身上"正是由这一句决定的。
   *
   *   ⚠ 没有技能表（单独校验一个文件）时取不到技能：那时候**不判** selfOnly
   *     （`hasSkills` 为真、而技能表为空 → 下面那条 `UNKNOWN_SKILL` 会先报出来）。
   */
  const targetingSkills = (tech.skills ?? [])
    .map(id => skills?.get(id))
    .filter((s): s is Skill => s !== undefined)
  const techTargeting = targetingSkills.find(s => s.targeting !== undefined)?.targeting
  const selfOnly = techTargeting !== undefined
    && techTargeting.valid.length > 0
    && techTargeting.valid.every(v => v === 'self')

  if (balance !== undefined && skills !== undefined && priceable) {
    const priced = priceTechnique(
      tech, id => skills.get(id), priceOptions(balance, statuses, entities, opts.modifierProtos),
    )
    total = priced.total
    kind = priced.kind
    ledger = priced.entries
    /*
     * ⚠ 血契**从切分里读**，不再从整本账的符号推（日志 66）——
     *   引擎扣的是这个数，报告里写的也必须是这个数。
     */
    bloodPactUse = bloodPactOfResult(priced)

    /*
     * 引用不到的零件：**必须报错**。
     *
     * ⚠ 不报的话账会静默地少算一整段 —— 玩家看到"已配平"，
     *   实际上有一段技能的价格根本没进账，等它被删掉或者改名之后
     *   术式才会突然不平衡。这是最难查的一类：账本来是错的，但它显示绿灯。
     */
    const wantedSkills = tech.skills ?? []
    const missing = wantedSkills.filter(id => !skills.has(id))
    for (const id of missing) {
      pointIssues.push(err('UNKNOWN_SKILL', 'skills',
        `算不了账：内容库里没有技能「${id}」`,
        '这一段的点数完全没进账，所以"已配平"是假的。id 写错了，或者那个技能还没建。'))
    }

    /*
     * ⚠ **变体的基础技能必须找得到** —— 找不到就算不了账。
     *
     *   变体的点数 = 它相对 `basedOn` 那个基础技能的偏离，所以基础技能没了
     *   就等于"这笔账的基准没了"：`priceTechnique` 会**整段跳过**它，
     *   而跳过是不出声的（术式看起来配平了，其实少算了一整段）。
     *   内容改版（技能被删/改名）之后，老存档里的变体就会落进这个坑。
     */
    for (const id of wantedSkills) {
      const sk = skills.get(id)
      if (sk?.basedOn === undefined) continue
      if (skills.has(sk.basedOn)) continue
      pointIssues.push(err('UNKNOWN_BASE', 'skills',
        `「${sk.name}」的基础技能「${sk.basedOn}」找不到了`,
        '变体的账是对着它相对基础技能的偏离算的 —— 基础技能没了，这一段的点数算不出来。'
        + '把这个技能换个基础技能，或者从术式里换掉它。'))
    }

    /*
     * ⚠ **账和引擎的方向对不上** —— 这一节里最值钱的一条。
     *
     *   不写 `target` 的动作落在谁身上，取决于**它所在的术式**：
     *   术式的 `valid` 全是 `self`（自愈、架势、附魔、代价）→ 引擎打自己；
     *   否则 → 打锁定目标。
     *
     *   而定价是**按技能**算的，那会儿还不知道它会进哪个术式 ——
     *   所以缺省按"打对面那个"算（schema 里写明「不写就是 'hit'」）。
     *
     *   于是同一个技能只要被"自愈术式"用一次，那条账就是**反的**。
     *   这个坑咬了四次，症状都是"数值没动，点数却不对"，
     *   而且**没有任何地方会报警**。
     *
     *   现在报了 —— 而且只有在**术式层**报得出来，因为只有这里知道 `valid`。
     *   技能层的那条 `TARGET_DEPENDS_ON_TECHNIQUE` 只是提醒"这里有个假设"。
     */
    if (selfOnly) {
      for (const skillId of tech.skills ?? []) {
        const sk = skills.get(skillId)
        if (sk === undefined) continue
        for (const loc of checks.collectActions(sk)) {
          const a = loc.action
          if (a.target !== undefined) continue
          if (a.delivery !== undefined || a.valid !== undefined) continue
          const p = a.payload
          if (p === undefined || !SIGN_CHANGING.has(p.kind)) continue
          if (p.kind === 'attribute' && typeof p.path === 'string' && p.path.startsWith('pipeline.')) continue
          if (defaultTargetOf(loc.when, loc.inHook) !== 'depends') continue
          pointIssues.push(err('TARGET_CONTRADICTS_TECHNIQUE',
            `${skillId}.${loc.path}.target`,
            '这个术式只对自己有效，但这条动作没写 `target` —— 引擎会打自己，而账是按打敌人算的',
            '两边方向反了，所以这条规则在账上的符号是错的。'
            + '修法：显式写 `target: "self"`（这条动作确实是作用于自己的）。'))
        }
      }
    }

    if (missing.length === 0) {
      if (kind === 'negative') {
        /*
         * ⚠ **负值术式**（玩家 2026-09-21 定的名字，以前叫"超模术式"）。
         *
         *   它**不是错误** —— 它是一个可以放出来的东西，只是每次要花血契。
         *   所以这里只给一条警告，把"这一下要花多少"说清楚。
         *
         *   量和 `bloodPactPerUse` 是**同一个数** —— 因为引擎就是按它扣的
         *   （见 src/sim/cast.ts 的 activate）。
         *
         *   ⚠⚠ 2026-10-06（日志 66）：那个数**不再是 `|合计|`**，而是三段式表里的
         *     `threeSection.bloodPact`（裁定 (A)：只从**主动那半**来）。
         *     两种情形当场分道（都实测过）：
         *       · **混合**（主动 −18 / 常驻 +2）：合计 −16，但血契是 **18**
         *         （常驻那 +2 **不补贴**主动）⇒ 老口径**少收** 2 点；
         *       · **纯常驻为负**（常驻 −18）：合计 −18，但血契是 **0**
         *         （常驻那半**不能吃血契**）⇒ 老口径**多收** 18 点。
         *     后一种今天按定稿那张表是**错误**（下面 `CONSTANT_*` 那条），
         *     所以这条警告在那种形状下会跟着说"消耗 0 点血契"——
         *     ⚠ **那两句话今天并存是对的**（一个说"整本账为负"，一个说
         *     "常驻那半边必须自己 ≥ 0"），要不要在血契为 0 时把这条收起来，
         *     是日志 66 报告里的待裁定项，不在这里自己定。
         */
        pointIssues.push(warn('NEGATIVE_TECHNIQUE', 'points',
          `负值术式：合计 ${total}，每次释放消耗 ${bloodPactUse} 点血契`,
          `血契来自"让玩家进入危机的行为"（残血、被挂负面状态、抵押属性上限…），`
          + `攒在 char.bloodPact.current 上，跨关卡累积、不自动回复。`
          + `不够就放不出来 —— 这是有意的：负值术式该是"攒出来的那一发"。`))
      }
      /*
       * ⚠⚠ ---- **三段式表**（定稿第十二节；2026-10-06 日志 65）----
       *
       * 账**再按「序列」切**（上面那一层是按武器 / 魔法切，两层**不是同一条**）：
       *
       *   · **常驻那半**（被包装的序列）**必须 ≥ 0** —— 为负 ⇒ **错误**
       *     （一条纯常驻术式"不平"就是白拿了强度，而且它**不能吃血契**：
       *     血契只从主动那半来 ⇒ 负的常驻额度**没有出口**）。
       *   · 为**正** ⇒ **警告**（用户原话："**为正没有什么用**" —— 白给了额度，
       *     而且按裁定 (A) 它**不能补贴主动**那半）。
       *   · 混合术式里常驻那半为负 ⇒ **错误**（2026-10-06 日志 66 从警告升上来的）。
       *     定稿那句"**常驻那半边必须自己 ≥ 0**"是**一条硬约束**，
       *     而**同一条约束不该两种档**（用户裁定）。
       *     ⚠ 日志 65 当时选了告警，理由是"该情形今天构造不出来"——**那个理由是错的**：
       *       探针实测 `activation: "press"` + 常驻段 + 主动段是**能编译、能过校验**的形状
       *       （`WRAP_IN_NON_PRESS_TECHNIQUE` 只管"非 press"），
       *       所以混合为负**真能构造** ⇒ 它和纯常驻是同一件事，不该两种档。
       *     ⚠ 两条 code 仍然分开（`CONSTANT_ONLY_NEGATIVE` / `CONSTANT_SIDE_NEGATIVE`），
       *       因为**措辞**不同（"只有常驻序列" / "两种都有"）；**判据只有这一处 `if`**。
       */
      const section = priced.threeSection
      if (section !== undefined) {
        const passiveLabel = `常驻序列的点数和 ${section.passivePoints}`
        const activeLabel = `主动序列的点数和 ${section.activePoints}`

        if (section.passivePoints < 0) {
          const onlyConstant = allSequencesAreConstant(tech, opts.modifierProtos)
          const msg = `${passiveLabel}（不为 0 就不合规：**常驻那半边必须自己 ≥ 0**）`
          const hint = '不平的常驻 = 白拿强度，而它**不能吃血契** —— 血契只从主动那半来'
            + `（${activeLabel}），所以负的常驻额度**没有出口**。`
            + '修法：给常驻那一边加一条亏模的常驻序列抵消（"超模常驻依然允许存在"）。'
          pointIssues.push(onlyConstant
            ? err('CONSTANT_ONLY_NEGATIVE', 'points',
              `纯常驻术式的${msg}`,
              hint + '⚠ 这一门**只有常驻序列** ⇒ 按定稿那张表，它是**错误**。')
            : err('CONSTANT_SIDE_NEGATIVE', 'points',
              `混合术式的${msg}`,
              hint + '⚠ 这一门**两种序列都有** —— 但定稿那条"常驻那半边必须自己 ≥ 0"'
              + '是**一条硬约束**，和纯常驻**同一个档**（错误）。'
              + '主动那半照旧自由（它可以为负，血契就从它来）。'))
        } else if (section.passivePoints > 0) {
          pointIssues.push(warn('CONSTANT_SIDE_POSITIVE', 'points',
            `${passiveLabel} —— **为正没有什么用**（白给了额度）`,
            '额度不用完就是白送，而且按裁定 (A) 它**不能补贴主动那半**：'
            + `血契 = max(0, −主动和) ⇒ 这里只有 ${activeLabel} 算数`
            + `（今天 ${section.bloodPact} 点血契）。`
            + '修法：把这半边的点数压回 0（或者把多出来的额度真的用掉）。'))
        }
      }
      /*
       * ⚠⚠ 2026-09-30（日志 57）：这里原来还有一条 `NOT_BALANCED` **错误** ——
       *   `|合计| > 容差 + EPS` 就报错，管的是两头：
       *     · 合计为负且超过容差（其实到不了这里，上面那条警告先接走了）；
       *     · **合计为正且超过容差** ⇒ "额度没用完 = 没配平"。
       *
       *   **两样都删了**，用户 2026-09-30 的规格原话：
       *   > **点数之和大于 0 就能用，小于 0 就要支付血契才能用**
       *
       *   ⇒ **合计 ≥ 0 是合法的**（余额没用完不再算错），
       *     合计 < 0 是**负值术式**（上面那条警告），
       *     而"容差"这个词在校验器里**不存在了**。
       *   ⚠ 这也是"警告数会变"的唯一来源 —— 要说清从几条变几条（日志 57 报告）。
       */
    }
  }

  issues.push(...pointIssues)

  const errors = issues.filter(i => i.level === 'error').length
  const warns = issues.length - errors

  return {
    file,
    id: typeof tech.id === 'string' ? tech.id : '(无 id)',
    name: typeof tech.name === 'string' ? tech.name : '(无名字)',
    kind,
    total,
    declaredTotal: total,
    bloodPactPerUse: bloodPactUse,
    ledger,
    ...(priceless !== undefined ? { priceless } : {}),
    issues,
    groups: [{ name: '结构', errors, warnings: warns }],
    fatal: errors > 0,
  }
}
