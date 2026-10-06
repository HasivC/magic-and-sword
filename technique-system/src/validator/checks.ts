import type {
  Action, Condition, DeliverySpec, ModifierProto, Payload, Rule, Skill, SkillEffect, StatusDef, TriggerEvent,
  ValueSpec, WeaponDef,
} from '../schema.ts'
import type { BalanceConfig, Issue } from './types.ts'
import {
  DEFAULT_MODIFIER_RATES, MODIFIER_BOUNCE_BASE_KEY, MODIFIER_BOUNCE_FALLOFF_RATE_KEY,
  MODIFIER_BOUNCE_TIMES_KEY, MODIFIER_EXTRA_COPY_KEY,
  MODIFIER_HOMING_BASE_KEY, MODIFIER_HOMING_DEGREE_KEY, MODIFIER_HOMING_METER_KEY,
  MODIFIER_LAYOUT_BASE_KEY,
  MODIFIER_LAYOUT_DEGREE_KEY, MODIFIER_LAYOUT_METER_KEY, MODIFIER_WAIT_SECOND_KEY,
  TIER_BY_SKILL_KEY, TIER_NEUTRAL, TIER_TABLE_PHASE_DURATION, defaultTargetOf, lookupGapsOf, readLookupTable, readTierTable,
} from '../pricing.ts'
import { effectAsRule } from '../effects.ts'
/*
 * ⚠ 从 `sim/trigger.ts` 引一张表（**唯一一处声明**："哪些触发时机真的接了线"）。
 *
 *   为什么校验器要读它：内容里写一个**没接线**的时机（`onHit` / `onExpire`…）
 *   **不报错也不生效** —— 那是这个项目列为最危险的一类静默失败。
 *   校验器拿这张表报一条**警告**，把"写上去不生效"变成一句人话。
 *
 *   ⚠ 方向是 `validator → sim`，**没有环**（`src/sim/**` 一处都不引校验器）。
 *     表放在 `sim` 而不是这儿：接线新时机的人改的是 `sim`，
 *     表就该在他手边 —— 抄到这儿来就变成两份、迟早不同步。
 */
import { WIRED_TRIGGER_EVENTS } from '../sim/trigger.ts'
/*
 * ⚠ 「份数」类修饰（多重释放 / 一分为 X）和「等待 X 秒」的参数键与上下限
 *   **只有一处声明**（`src/school.ts`，日志 51 / 52）——
 *   编译期、校验器、账三处共用它。
 *   抄一份到这里来就变成两份、迟早漂移（漂移的表现是静默的：
 *   账上按 3 份收钱、引擎打出 5 份 —— 或者账上按 30 秒收、引擎只等 3 秒）。
 */
import {
  MODIFIER_BOUNCE_COUNT_KEY, MODIFIER_BOUNCE_COUNT_MAX, MODIFIER_BOUNCE_COUNT_MIN,
  MODIFIER_BOUNCE_FALLOFF_KEY, MODIFIER_BOUNCE_FALLOFF_MIN_FALLBACK,
  MODIFIER_BOUNCE_MAX_COUNT_KEY, MODIFIER_BOUNCE_MAX_FALLOFF_KEY, MODIFIER_BOUNCE_MIN_FALLOFF_KEY,
  modifierBounceMaxFalloffOf,
  MODIFIER_COUNT_KEY, MODIFIER_COUNT_MIN, MODIFIER_HOMING_MAX_RANGE_KEY,
  MODIFIER_HOMING_MAX_TURN_KEY, MODIFIER_HOMING_MIN_RANGE_KEY,
  MODIFIER_HOMING_RANGE_KEY, MODIFIER_HOMING_RANGE_MIN_FALLBACK,
  MODIFIER_HOMING_TURN_KEY, MODIFIER_HOMING_TURN_MIN,
  MODIFIER_INTERRUPT_KEY, MODIFIER_INTERRUPT_VALUES,
  MODIFIER_LAYOUT_EVEN_KEY, MODIFIER_LAYOUT_MAX_ANGLE_KEY, MODIFIER_LAYOUT_MAX_RADIUS_KEY,
  MODIFIER_LAYOUT_MAX_SPREAD_KEY, MODIFIER_LAYOUT_MIN_RADIUS_KEY, MODIFIER_LAYOUT_MIRROR_KEY,
  MODIFIER_LAYOUT_MODES, MODIFIER_LAYOUT_RADIUS_KEY, MODIFIER_LAYOUT_RADIUS_MIN,
  MODIFIER_LAYOUT_SPREAD_KEY, MODIFIER_LAYOUT_START_KEY, MODIFIER_LAYOUT_TYPE_KEY,
  MODIFIER_LOCK_ENGINE_RESERVED, MODIFIER_LOCKS_KEY, MODIFIER_LOCK_VALUES,
  MODIFIER_MAX_FALLBACK, MODIFIER_MAX_KEY,
  MODIFIER_SECONDS_KEY, MODIFIER_SECONDS_MAX_KEY, MODIFIER_SECONDS_MIN, MODIFIER_SECONDS_MIN_KEY,
  modifierHomingMaxRangeOf, modifierHomingMaxTurnOf,
} from '../school.ts'

export interface Ctx {
  skill: Skill
  balance: BalanceConfig
}

// ============================================================================
//  枚举表 —— 唯一真相在这里，schema 里的联合类型是给人看的
// ============================================================================

const ACTIVATIONS: readonly string[] = ['press', 'release', 'hold', 'toggle', 'auto']
/**
 * **施法形态**的合法取值（`Skill.form`）。
 *
 * ⚠ 表的**唯一真相**在这儿，`SkillForm` 那个联合类型是给人看的
 *   （和上面 ACTIVATIONS / INTERRUPT_LEVELS 同一套约定）。
 */
const SKILL_FORMS: readonly string[] = ['instant', 'charged', 'sustained', 'passive']
/** 打断等级，从最脆到最硬 */
const INTERRUPT_LEVELS: readonly string[] = ['damage', 'control', 'none']
const TRIGGERS: readonly string[] = [
  'onCast', 'onHit', 'onMiss', 'onCrit', 'onNonCrit', 'onKill',
  'onExpire', 'onRemoved', 'onEnter', 'onLeave',
  'onDamaged', 'onLethalDamage', 'onStatusApplied', 'onLowHp', 'onTick',
  'phaseEnter', 'phaseComplete', 'phaseInterrupt',
]
const PHASE_TRIGGERS: readonly string[] = ['phaseEnter', 'phaseComplete', 'phaseInterrupt']
const CAPABILITIES: readonly string[] = ['move', 'attack', 'cast', 'turn']
const STAGES: readonly string[] = ['raw', 'intercept', 'modify', 'absorb', 'apply', 'after']
const DELIVERY_KINDS: readonly string[] = [
  'self', 'projectile', 'beam', 'meleeArc', 'capsule', 'area', 'aura', 'spawn',
]
const PAYLOAD_KINDS: readonly string[] = [
  'damage', 'heal', 'attribute', 'status', 'displacement', 'perception', 'spawn',
]
const TARGETING_MODES: readonly string[] = ['self', 'directional', 'locked', 'auto', 'areapoint']
const MODIFIER_OPS: readonly string[] = ['add', 'mul', 'set', 'reset', 'stack']
const VALUE_REFS: readonly string[] = [
  'distance', 'selfHpPct', 'targetStacks', 'targetCount', 'elapsed', 'charge', 'missingHpPct',
  /*
   * ⚠ **武器参数**（`weapon.*`）—— 只有武器技能用得上。
   *
   *   它们和别的 ref 有个本质区别：别的都是**运行时**量
   *   （到目标的距离、蓄力量…），而这三个是**这把武器的属性**，
   *   在装上武器的时候就定了。
   *
   *   所以"同一份武器技能模板在不同武器上数值不同"就是靠它们 ——
   *   这也是玩家说的"每种武器的技能范围和伤害因为属性不同而不同"。
   */
  'weapon.reach', 'weapon.damage', 'weapon.windup',
]
const CONDITION_TYPES: readonly string[] = [
  'hasTag', 'hasStatusTag', 'hasStatus', 'stackAtLeast', 'hpBelow', 'distanceIs',
  'targetCountIs', 'isCrit', 'hitKindIs', 'prevHit', 'not', 'anyOf', 'allOf',
]
const WHO: readonly string[] = ['self', 'target', 'caster']
/**
 * 阵营取值。⚠ 和 `EntityDef.faction` 是**同一组** —— 它们指同一件事。
 *   `'caster'` 在状态里表示"跟挂上这个状态的那个人同阵营"。
 */
const FACTIONS: readonly string[] = ['caster', 'player', 'enemy', 'neutral']
const MAX_NEST_DEPTH = 4

/**
 * 这些载荷"落在谁身上"会改变**符号**（收益还是代价）。
 *
 * ⚠ 只有它们值得报 `TARGET_DEPENDS_ON_TECHNIQUE`：
 *   `attribute` / `status` / `perception` / `displacement` 打自己还是打敌人，
 *   在账上是反的两个方向。
 *
 *   不在里面的（报了就是噪音）：
 *   · `damage` —— 打谁都一样，都是收益
 *   · `heal` —— 同样，**定价不看目标**
 *   · `spawn` —— 落在谁身上和它无关
 *   另外 `attribute` 改的是 `pipeline.*`（管线伪属性）时也不算 ——
 *   那改的是**这次命中**本身，不是某个人的属性。
 */
const AFFECTS_OTHERS: ReadonlySet<string> = new Set([
  'attribute', 'status', 'perception', 'displacement',
])

/**
 * 这些时机"自带一个明确的单位"，动作不带载体时打的就是它。
 *
 * ⚠ 用于 `NO_DELIVERY` 警告的语境判断：
 *   挂在 `onHit` 上的无载体伤害打的是"刚打中的那个"（正确）；
 *   挂在 `phaseComplete` 上的无载体伤害打的是"锁定目标"（可能是自己，得提醒）。
 */
const REACTIVE_WHENS: ReadonlySet<TriggerEvent | undefined> = new Set([
  'onHit', 'onMiss', 'onKill', 'onCrit', 'onNonCrit', 'onDamaged', 'onLethalDamage',
])

/**
 * 存储属性：会被直接改写的状态量（当前血量、当前能量、当前血契）。
 * 必须和 src/sim/types.ts 里的 STORED_ATTRIBUTES 保持一致。
 */
const STORED_ATTRIBUTES: readonly string[] = [
  'char.hp.current', 'char.energy.current', 'char.bloodPact.current',
]

// ============================================================================
//  小工具
// ============================================================================

function err(code: string, path: string, message: string, hint?: string): Issue {
  return hint ? { level: 'error', code, path, message, hint } : { level: 'error', code, path, message }
}

function warn(code: string, path: string, message: string, hint?: string): Issue {
  return hint ? { level: 'warning', code, path, message, hint } : { level: 'warning', code, path, message }
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isStr(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) dup.add(id)
    seen.add(id)
  }
  return [...dup]
}

function checkEnum(
  out: Issue[], value: unknown, allowed: readonly string[], path: string, what: string,
): void {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    out.push(err('BAD_ENUM', path,
      `${what}取值非法：${JSON.stringify(value)}`,
      `合法值：${allowed.join(' / ')}`))
  }
}

/** 一个术式里出现的全部动作（含内联状态钩子里的），带 JSON 路径 */
export interface LocatedAction {
  action: Action
  path: string
  /**
   * 这条动作挂在哪条规则/钩子上（`when`）。
   *
   * ⚠ 有些检查**必须知道语境**：比如"没有载体的伤害动作"，
   *   挂在 `onHit` 上时打的就是"刚打中的那个"（完全正确），
   *   挂在 `phaseComplete` 上时打的才是"锁定目标"（可能打自己）。
   *   少了这个字段就只能一刀切，要么漏报要么全是假警告。
   */
  when?: TriggerEvent
  /**
   * 这条动作挂在**状态钩子**上（`hooks[i].then[j]`）还是**规则**上（`rules[i].then[j]`）。
   *
   * ⚠ 同样必须知道：状态钩子总是挂在某个具体单位身上跑的
   *   （`actor` = 状态持有者，`target` = 这次命中的另一方），
   *   所以"没有载体的伤害"在钩子里打的一定是个合理的对象，不用提醒。
   *   只有**规则**级别才可能既没锁定目标又没语境，退化成打自己。
   */
  inHook: boolean
}

/**
 * 把一份东西里的**全部动作**摊平，带上 JSON 路径。
 *
 * ⚠ 固有效果（`effect`）和规则（`rules`）**都要摊**。
 *   自 2026-09-21 起，"这个技能是什么"住在 `effect` 里 ——
 *   只走 `rules` 的调用方会**看不见技能的固有效果**：
 *   跨文件引用检查会漏掉它的 statusId / entityId，
 *   而那两样漏掉的表现都是**运行期才炸**（或者静默无效）。
 */
export function collectActions(source: { rules?: Rule[], effect?: SkillEffect[] }): LocatedAction[] {
  const out: LocatedAction[] = []
  const visited = new Set<StatusDef>()

  const visitStatus = (s: StatusDef, at: string, depth: number): void => {
    if (depth > MAX_NEST_DEPTH) return
    const hooks = s.hooks ?? []
    for (let i = 0; i < hooks.length; i++) {
      const hook = hooks[i]
      if (!hook) continue
      const then = hook.then ?? []
      for (let j = 0; j < then.length; j++) {
        const a = then[j]
        if (!a) continue
        const p = `${at}.hooks[${i}].then[${j}]`
        const located: LocatedAction = { action: a, path: p, inHook: true }
        if (hook.when !== undefined) located.when = hook.when
        out.push(located)
        const pl = a.payload
        if (pl && pl.kind === 'status' && pl.inline && !visited.has(pl.inline)) {
          visited.add(pl.inline)
          visitStatus(pl.inline, `${p}.payload.inline`, depth + 1)
        }
      }
    }
  }

  for (const { rule, base } of rulesWithPaths(source)) {
    const then = rule.then ?? []
    for (let j = 0; j < then.length; j++) {
      const a = then[j]
      if (!a) continue
      const p = `${base}.then[${j}]`
      const located: LocatedAction = { action: a, path: p, inHook: false }
      if (rule.when !== undefined) located.when = rule.when
      out.push(located)
      const pl = a.payload
      if (pl && pl.kind === 'status' && pl.inline && !visited.has(pl.inline)) {
        visited.add(pl.inline)
        visitStatus(pl.inline, `${p}.payload.inline`, 1)
      }
    }
  }

  return out
}

/**
 * 固有效果 + 规则，**各自带自己的 JSON 路径前缀**。
 *
 * ⚠ 顺序 = 效果在前（和 `src/effects.ts` 的 `allRulesOf` 一致）。
 *   路径必须是**真的那个字段**（`effect[2]` / `rules[0]`）——
 *   报错、高亮、点表都靠它定位；写成统一的下标会指到别人身上。
 */
function rulesWithPaths(source: { rules?: Rule[], effect?: SkillEffect[] }): { rule: Rule, base: string }[] {
  const out: { rule: Rule, base: string }[] = []
  ;(source.effect ?? []).forEach((e, i) => { out.push({ rule: effectAsRule(e, i), base: `effect[${i}]` }) })
  ;(source.rules ?? []).forEach((r, i) => { out.push({ rule: r, base: `rules[${i}]` }) })
  return out
}

/** 一个术式里定义的全部内联状态，带 JSON 路径 */
export function collectStatuses(
  source: { rules?: Rule[], effect?: SkillEffect[] },
): { status: StatusDef; path: string }[] {
  const out: { status: StatusDef; path: string }[] = []
  const visited = new Set<StatusDef>()

  const visit = (s: StatusDef, at: string, depth: number): void => {
    out.push({ status: s, path: at })
    if (depth >= MAX_NEST_DEPTH) return
    const hooks = s.hooks ?? []
    for (let i = 0; i < hooks.length; i++) {
      const then = hooks[i]?.then ?? []
      for (let j = 0; j < then.length; j++) {
        const pl = then[j]?.payload
        if (pl && pl.kind === 'status' && pl.inline && !visited.has(pl.inline)) {
          visited.add(pl.inline)
          visit(pl.inline, `${at}.hooks[${i}].then[${j}].payload.inline`, depth + 1)
        }
      }
    }
  }

  // ⚠ 固有效果里的内联状态也要收（理由同 `collectActions`）
  for (const { rule, base } of rulesWithPaths(source)) {
    const then = rule.then ?? []
    for (let j = 0; j < then.length; j++) {
      const pl = then[j]?.payload
      if (pl && pl.kind === 'status' && pl.inline && !visited.has(pl.inline)) {
        visited.add(pl.inline)
        visit(pl.inline, `${base}.then[${j}].payload.inline`, 1)
      }
    }
  }

  return out
}

// ============================================================================
//  1. 结构
// ============================================================================

export function checkShape(ctx: Ctx): Issue[] {
  const { skill } = ctx
  const out: Issue[] = []

  if (skill.schemaVersion !== 1) {
    out.push(err('BAD_VERSION', 'schemaVersion',
      `schemaVersion 应为 1，实际是 ${JSON.stringify(skill.schemaVersion)}`,
      '版本号一变，就必须在 loader 里补迁移函数，否则老存档会静默读错。'))
  }

  if (!isStr(skill.id)) out.push(err('MISSING', 'id', '缺少 id'))
  if (!isStr(skill.name)) out.push(err('MISSING', 'name', '缺少 name'))

  /*
   * ⚠ **技能介绍里不许写数字**。
   *
   *   它是唯一允许手写的那类说明（写给玩家看，显示在编辑器最上面）。
   *   手写 + 数字 = 一定会和数值脱节：玩家把伤害从 30 拖成 50，
   *   介绍里那句"造成 30 点伤害"不会变 —— 而这正是当初把说明
   *   全部改成"从数据生成"的原因（见 src/describe.ts 的文件头）。
   *
   *   所以：想写数字就交给生成的那一栏，这里只写"它是什么、什么时候用、代价是什么"。
   */
  if (isStr(skill.note) && /[0-9０-９]/.test(skill.note)) {
    out.push(warn('NOTE_WITH_NUMBER', 'note',
      `技能介绍里写了数字：「${skill.note.slice(0, 40)}${skill.note.length > 40 ? '…' : ''}」`,
      '数字要和数值脱节的话，就会被拖成错的。'
      + '介绍写"它是什么、什么时候用、代价是什么"，具体数值交给下面那栏**生成的**说明。'))
  }

  // ⚠ 激活方式（press / toggle / …）是**术式**的属性，不是技能的。
  //   技能是"一次释放"，谁按键、怎么按，那是编排层的事。

  /*
   * ⚠ 施法形态（`form`）**是技能的属性** —— 和上面那一句恰好相反。
   *
   *   它回答"这次释放**要不要一条时间轴**、要多长"，那是技能自己的事实；
   *   "玩家怎么按"才是术式的（`Technique.activation`）。两个概念以前被混在一起，
   *   见 docs/sequence-and-modifier-model.md §一。
   *
   *   两者**对不对得上**由 `validateTechnique` 报（FORM_INCOMPATIBLE /
   *   FORM_NOT_FIRST）—— 那要同时看到术式和技能表，技能这一层看不见。
   *
   * ⚠ 这里只管**取值合法**。不写 = `'instant'`（瞬发，默认值见 schema 的
   *   `SkillForm`）；但**取值非法时不许静默当成瞬发** —— 那会让一个拼错的
   *   `form: "passiv"` 表现成"这个技能是瞬发的"，而它显然是想写常驻。
   */
  if (skill.form !== undefined && !SKILL_FORMS.includes(skill.form)) {
    out.push(err('BAD_ENUM', 'form',
      `施法形态取值非法：${JSON.stringify(skill.form)}`,
      `合法值：${SKILL_FORMS.join(' / ')}。⚠ 不写就是 'instant'（瞬发）—— `
      + '内容里只标**不是瞬发**的那些（见 schema 的 SkillForm）。'))
  }

  if (!Array.isArray(skill.phases) || skill.phases.length === 0) {
    out.push(err('NO_PHASES', 'phases', '至少要有一个阶段',
      '哪怕时长是 0 也要写一个 —— 模拟器靠它推进时间轴。'))
  }

  if (!Array.isArray(skill.rules)) {
    out.push(err('BAD_RULES', 'rules', 'rules 必须是数组'))
  }

  if (!Number.isInteger(skill.ruleSlots) || skill.ruleSlots < 0) {
    out.push(err('BAD_RULE_SLOTS', 'ruleSlots',
      `ruleSlots 必须是非负整数，实际是 ${JSON.stringify(skill.ruleSlots)}`))
  } else if (Array.isArray(skill.rules) && skill.rules.length > skill.ruleSlots) {
    out.push(err('TOO_MANY_RULES', 'rules',
      `写了 ${skill.rules.length} 条规则，但 ruleSlots 只有 ${skill.ruleSlots}`,
      '要么删规则，要么花点数把 ruleSlots 买上去。'))
  }

  // ⚠ 点数不在这里查 —— 它现在是**算出来的**（见 src/pricing.ts），
  //   校验器用 priceSkill 推导后再比对，不用再读一个手写字段。

  return out
}

// ============================================================================
//  2. 引用
// ============================================================================

export function checkReferences(ctx: Ctx): Issue[] {
  const { skill } = ctx
  const out: Issue[] = []
  const phaseIds = new Set((skill.phases ?? []).map(p => p?.id).filter(isStr))
  const known = [...phaseIds].join(' / ') || '（无）'

  const rules = skill.rules ?? []
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i]
    if (!r) continue

    if (PHASE_TRIGGERS.includes(r.when)) {
      if (!isStr(r.phaseId)) {
        out.push(err('MISSING_PHASE_ID', `rules[${i}].phaseId`,
          `when 是 ${r.when} 时必须写 phaseId`, `这个术式的阶段有：${known}`))
      } else if (!phaseIds.has(r.phaseId)) {
        out.push(err('UNKNOWN_PHASE', `rules[${i}].phaseId`,
          `找不到阶段「${r.phaseId}」`, `这个术式的阶段有：${known}`))
      }
    } else if (r.phaseId !== undefined) {
      out.push(warn('PHASE_ID_IGNORED', `rules[${i}].phaseId`,
        `when 是 ${r.when}，phaseId 不会生效`,
        '只有 phaseEnter / phaseComplete / phaseInterrupt 才看 phaseId。'))
    }
  }

  /*
   * ⚠ **固有效果也要挂在一个存在的阶段上。**
   *
   *   效果是"时间轴走到这一段就发生" —— 阶段 id 打错的表现是
   *   打出去什么都没有（而且不报错），和"规则挂错阶段"是同一个病。
   *   搬家的时候最容易漏掉这一层检查：效果不在 `rules` 里，
   *   上面那个循环根本看不到它。
   */
  const effects = skill.effect ?? []
  const effectIds = new Set<string>()
  for (let i = 0; i < effects.length; i++) {
    const e = effects[i]
    if (!e) continue
    if (!isStr(e.id)) {
      out.push(err('MISSING', `effect[${i}].id`, '固有效果缺少 id'))
    } else if (effectIds.has(e.id)) {
      out.push(err('DUP_EFFECT_ID', `effect[${i}].id`,
        `固有效果 id 重复：「${e.id}」`, 'id 必须唯一 —— 账和报错都按它认身份。'))
    } else {
      effectIds.add(e.id)
    }

    if (!isStr(e.at)) {
      out.push(err('MISSING_EFFECT_PHASE', `effect[${i}].at`,
        '固有效果必须写清楚"在哪一段结束的时候发生"'))
    } else if (!phaseIds.has(e.at)) {
      out.push(err('UNKNOWN_PHASE', `effect[${i}].at`,
        `固有效果挂在找不到的阶段「${e.at}」上`, `这个术式的阶段有：${known}`))
    }

    if (!Array.isArray(e.then) || e.then.length === 0) {
      out.push(err('EMPTY_EFFECT', `effect[${i}].then`,
        '固有效果是空的（这一下什么都没做）',
        '什么都不做的效果写它没有意义 —— 想表达"这个技能只有反应"就别写 effect。'))
    }
  }

  return out
}

// ============================================================================
//  3. 阶段
// ============================================================================

export function checkPhases(ctx: Ctx): Issue[] {
  const { skill } = ctx
  const out: Issue[] = []
  const phases = skill.phases ?? []

  for (const d of duplicates(phases.map(p => p?.id).filter(isStr))) {
    out.push(err('DUP_PHASE_ID', 'phases', `阶段 id 重复：「${d}」`, '阶段 id 必须唯一，否则规则不知道该挂到谁身上。'))
  }

  let chargeCount = 0

  for (let i = 0; i < phases.length; i++) {
    const p = phases[i]
    if (!p) continue
    const at = `phases[${i}]`

    if (!isStr(p.id)) out.push(err('MISSING', `${at}.id`, '阶段缺少 id'))

    if (!isNum(p.duration) || (p.duration < 0 && p.duration !== -1)) {
      out.push(err('BAD_DURATION', `${at}.duration`,
        'duration 必须是 >= 0 的秒数，或 -1 表示由玩家控制',
        `实际是 ${JSON.stringify(p.duration)}`))
    }
    if (p.duration === -1) chargeCount++

    for (const cap of p.locks ?? []) {
      checkEnum(out, cap, CAPABILITIES, `${at}.locks`, '能力')
    }
    /*
     * ⚠ `locks` **2026-09-21 起真的生效了**，所以那条 INERT_FIELD 警告撤掉了。
     *
     *   它以前是"校验器很认真、引擎不认"的最坏组合：校验器逐个检查取值、
     *   说明生成器会写一句"无法转向"，而引擎一处都不读 ——
     *   作者以为角色被定住了，实际上照样能跑。
     *
     *   现在由 `applyPhaseLocks()` 在 `stepWorld` 的 7b 强制执行
     *   （夹在 AI 和位置积分之间，所以玩家和 AI 的意图都会被覆盖）。
     *   撤掉警告的**同时**要有测试盯着 —— 见 `tests/scenario.ts`
     *   的「阶段锁」那一节。
     *
     * ⚠ 这里**故意不再加"蓄力阶段锁朝向"之类的提醒**。
     *   那正好是玩家点名要做的东西（"高伤持续激光，但是无法转向"），
     *   出厂内容的「贯日」就是这么写的 —— 对着一个**刻意做出来的正确写法**
     *   报警告，是这个项目反复踩过的坑（`NO_DELIVERY`、
     *   `PREV_HIT_ON_FIRST_LINK`、`LOPSIDED_PART` 都是）。
     *   取值合法性由上面那条 `checkEnum` 管，行为由测试管，够了。
     */

    if (p.cost) {
      const keys = ['energy', 'cooldown', 'hp'] as const
      for (const k of keys) {
        const v = p.cost[k]
        if (v !== undefined && (!isNum(v) || v < 0)) {
          out.push(err('BAD_COST', `${at}.cost.${k}`,
            `${k} 必须是非负数`, `实际是 ${JSON.stringify(v)}`))
        }
      }
      if (p.cost.hpIsPercent === true && p.cost.hp === undefined) {
        out.push(warn('HP_PERCENT_WITHOUT_HP', `${at}.cost.hpIsPercent`,
          '写了 hpIsPercent 但没有 hp', '这条设置不会生效。'))
      }
    }

    // ⚠ 阶段没有手写的 points 了 —— 它由时长、可打断性和代价推导
  }

  if (chargeCount > 1) {
    out.push(err('MULTI_CHARGE', 'phases',
      `有 ${chargeCount} 个 duration 为 -1 的阶段`,
      '蓄力阶段最多只能有一个 —— 否则模拟器不知道"抬起按键"该结束哪一个。'))
  }

  // 打断等级必须是三档之一（不写 = 'damage'）
  phases.forEach((p, i) => {
    if (p === undefined || p.interrupt === undefined) return
    if (!INTERRUPT_LEVELS.includes(p.interrupt)) {
      out.push(err('BAD_ENUM', `phases[${i}].interrupt`,
        `打断等级取值非法：${JSON.stringify(p.interrupt)}`,
        `合法值：${INTERRUPT_LEVELS.join(' / ')}（不写 = damage）`))
    }
  })

  // 设计警告：代价时机的定价前提。
  // 如果所有阶段都打不断，"早付代价"就没有风险，那部分点数是免费收益。
  if (phases.length > 0
    && phases.every(p => p !== undefined && (p.interrupt ?? 'damage') === 'none')) {
    out.push(warn('NEVER_INTERRUPTIBLE', 'phases',
      '所有阶段都无法打断',
      '那么"早付代价"就没有风险，"早付换点数"的定价前提不成立 —— 这部分点数会变成免费收益。'))
  }

  /*
   * ⚠ **冷却是技能唯一的属性**（玩家 2026-09-21）：
   *   > 冷却是技能的唯一属性，**不能在前后摇都有冷却**，编辑器内可以选择
   *   > 这个唯一的冷却属性在前摇/后摇进入冷却。
   *
   *   数据上冷却写在**某个阶段**的 `cost` 上（"代价付在哪一段"参与定价：
   *   早付是风险、晚付是安全），所以"唯一"这条得**盯着**，不能靠字段的放置保证。
   *
   *   两个阶段都有冷却的后果是静默的：引擎那边后一个会把冷却**盖**成它那个数
   *   （`cast.ts` 取大值），而定价那边**两笔都算** —— 玩家付了两次钱，
   *   实际只得到一个冷却，账面上还看不出来。
   */
  const cdPhases = phases
    .map((p, i) => ({ i, cd: p?.cost?.cooldown }))
    .filter(x => typeof x.cd === 'number' && x.cd > 0)
  if (cdPhases.length > 1) {
    const where = cdPhases.map(x => `${phases[x.i]?.id ?? x.i}=${String(x.cd)}秒`).join('、')
    out.push(err('COOLDOWN_TWO_PHASES', 'phases',
      `冷却是技能唯一的属性，但这里有 ${cdPhases.length} 个阶段都写了冷却：${where}`,
      '冷却是**一个**数（秒数）+ **一个**时机（从哪一段开始算）。'
      + '编辑器里「进入冷却的时机」那一块只能选一个 —— 手改 JSON 时也要守住这条。'))
  }

  return out
}

// ============================================================================
//  4. 规则
// ============================================================================

export function checkRules(ctx: Ctx): Issue[] {
  const { skill } = ctx
  const out: Issue[] = []
  const rules = skill.rules ?? []

  for (const d of duplicates(rules.map(r => r?.id).filter(isStr))) {
    out.push(err('DUP_RULE_ID', 'rules', `规则 id 重复：「${d}」`))
  }

  const orders = rules.map(r => r?.order).filter(isNum)
  for (const d of duplicates(orders.map(String))) {
    out.push(err('DUP_ORDER', 'rules', `有两条规则的 order 都是 ${d}`,
      'order 是玩家拖出来的执行顺序，必须唯一 —— 否则"同一时机内谁先执行"是不确定的。'))
  }
  const sorted = [...orders].sort((a, b) => a - b)
  const contiguous = sorted.every((v, i) => v === i)
  if (sorted.length > 0 && !contiguous) {
    out.push(warn('NON_CONTIGUOUS_ORDER', 'rules',
      `order 不连续：${sorted.join(', ')}`,
      `建议整理成 0..${sorted.length - 1}，编辑器算插入位置会简单很多。`))
  }

  for (let i = 0; i < rules.length; i++) {
    const r = rules[i]
    if (!r) continue
    const at = `rules[${i}]`

    if (!isStr(r.id)) out.push(err('MISSING', `${at}.id`, '规则缺少 id'))
    checkEnum(out, r.when, TRIGGERS, `${at}.when`, '触发时机')

    // ⚠ 这里**不再**检查 r.points —— 点数已经从 schema 里删掉了，
    //   它是内容的函数（src/pricing.ts），存在 JSON 里必然会和数值脱节。
    if (!isNum(r.order)) out.push(err('BAD_ORDER', `${at}.order`, 'order 必须是数字'))

    /*
     * note 里不许写数字。
     *
     * 理由和上面那条一模一样：**说明也会和数值脱节。**
     * 玩家在编辑器里把"回复 8 点生命"拖成 20，那句话还写着 8 ——
     * 这是实测踩到的，不是假想。
     *
     * 现在说明是从数据生成的（src/describe.ts），note 只写
     * 生成不出来的**设计意图**（"先蓄一发飞弹逼走位"）。
     */
    if (isStr(r.note) && /[0-9０-９]/.test(r.note)) {
      out.push(warn('NOTE_WITH_NUMBER', `${at}.note`,
        `规则说明里写了数字：「${r.note}」`,
        '说明是从数据生成的，手写的数字改完数值就会变成错的。'
        + '这里只写设计意图（"近身横扫"），数值交给生成的那句话。'))
    }

    if (!Array.isArray(r.then) || r.then.length === 0) {
      out.push(err('EMPTY_THEN', `${at}.then`, '规则必须至少有一个动作',
        '如果这条规则只是记账，那不是规则该干的事 —— 代价写在阶段的 cost 里。'))
    }

    if (r.when === 'onTick' && (!r.if || r.if.length === 0) && r.every === undefined) {
      out.push(warn('TICK_WITHOUT_CONDITION', `${at}.if`,
        'onTick 规则既没有条件也没有 every',
        '它会在每个 tick 都触发（一秒几十次）。'
        + '加个条件、或者写 every（触发间隔）、或者换成 onExpire 这类一次性时机。'))
    }

    if (r.every !== undefined) {
      if (!isNum(r.every) || r.every <= 0) {
        out.push(err('BAD_EVERY', `${at}.every`, 'every 必须是正数（秒）'))
      } else if (r.when !== 'onTick') {
        out.push(warn('EVERY_IGNORED', `${at}.every`,
          `when 是 ${r.when}，every 不会生效`,
          'every 只对 onTick 有意义。'))
      }
    }

    const conds = r.if ?? []
    for (let j = 0; j < conds.length; j++) {
      checkCondition(out, conds[j], `${at}.if[${j}]`)
    }
  }

  return out
}

/**
 * 这是不是一个「**写了、但是个空条件对象**」（`{}`）—— 2026-09-30（日志 54）加的。
 *
 * ⚠⚠ 为什么它值得一个**专门的判据**（而不是笼统的"条件类型非法"）：
 *   求值器按 `type` 分派（`sim/conditions.ts` 的 `evaluateCondition`），
 *   而 `{}` 没有 `type` ⇒ 落到 `switch` 的 **`default: return false`** ⇒ **恒不成立**。
 *   ⇒ 它**读起来像"无条件"**（"我没写什么条件"），实际是"**这条门永远不通过**"，
 *     而且**一声不吭** —— 正是这个项目列为最危险的那一类（"判不了 ≠ 没问题"）。
 *
 *   ⚠⚠ **日志 55 起：`{}` 和"不写"是两件事**（这是它值得一个专门判据的**第二个**理由）。
 *     玩家点名的默认值「**载体（前一个技能）消失**」日志 55 **接上线了**
 *     （`sim/trigger.ts` 的 `sweepCarriersGone`）⇒ **不写条件有真实语义**；
 *     而 `{}` 仍然是一个明确的"**永不通过**"。
 *     ⇒ 不分开的话，那条默认值会把一个写着 `{}` 的副本**救活** —— 那不是默认值该干的事。
 *     ⚠ 副本那一层的另一半（`MODIFIER_CONDITION_REQUIRED`）日志 55 已经**松掉了**
 *       （见 `validator/index.ts` 第 6.5 条那段）。
 */
export function isEmptyConditionObject(c: unknown): boolean {
  return isObj(c) && Object.keys(c).length === 0
}

function checkCondition(out: Issue[], c: Condition | undefined, path: string): void {
  if (!isObj(c)) {
    out.push(err('BAD_CONDITION', path, '条件必须是对象'))
    return
  }
  /*
   * ⚠ 空对象**单独说一句**（日志 54）：`checkEnum` 只会说"条件类型取值非法：undefined"，
   *   而那句话把根因指到了"类型拼错了"，真正的根因是"**写了个空条件**"。
   */
  if (isEmptyConditionObject(c)) {
    out.push(err('EMPTY_CONDITION', path,
      '这是一个**空条件对象**（`{}`）—— 它**恒不成立**',
      '求值器按 `type` 分派，`{}` 落到 `default: return false` ⇒ **这条门永远不通过**，'
      + '而且一声不吭（表现是"我明明没写条件，它却永远不触发"）。'
      + '⚠ 要"无条件"就**别写这个键**（不写 = 无条件）；要"空的一组门"就写 `if: []`。'))
    return
  }
  checkEnum(out, c.type, CONDITION_TYPES, `${path}.type`, '条件类型')

  if (c.type === 'not' || c.type === 'anyOf' || c.type === 'allOf') {
    if (!Array.isArray(c.of) || c.of.length === 0) {
      out.push(err('MISSING_SUB', `${path}.of`, `${c.type} 必须带 of 子条件`))
    } else {
      for (let k = 0; k < c.of.length; k++) {
        checkCondition(out, c.of[k], `${path}.of[${k}]`)
      }
    }
  } else if (c.value === undefined && c.range === undefined) {
    out.push(err('CONDITION_NO_VALUE', path,
      `${c.type} 既没有 value 也没有 range`, '这条条件永远无法判断真假。'))
  }

  if (c.who !== undefined) checkEnum(out, c.who, WHO, `${path}.who`, 'who')
}

// ============================================================================
//  5. 动作与载荷
// ============================================================================

export function checkActions(ctx: Ctx): Issue[] {
  const out: Issue[] = []

  for (const { action, path, when, inHook } of collectActions(ctx.skill)) {    if (!isObj(action)) {
      out.push(err('BAD_ACTION', path, '动作必须是对象'))
      continue
    }

    const p = action.payload
    if (!isObj(p)) {
      out.push(err('MISSING_PAYLOAD', `${path}.payload`, '动作缺少 payload',
        'payload 决定这个动作到底做什么，不能省。'))
      continue
    }

    checkEnum(out, p.kind, PAYLOAD_KINDS, `${path}.payload.kind`, '载荷类型')
    checkPayload(out, p as unknown as Payload, `${path}.payload`)

    const d = action.delivery
    if (d !== undefined) {
      if (!isObj(d)) {
        out.push(err('BAD_DELIVERY', `${path}.delivery`, 'delivery 必须是对象'))
      } else {
        checkEnum(out, d.kind, DELIVERY_KINDS, `${path}.delivery.kind`, '载体')
        checkDeliveryNumbers(out, d as unknown as DeliverySpec, `${path}.delivery`)
      }
    } else if ((p.kind === 'damage' || p.kind === 'heal') && !inHook && !REACTIVE_WHENS.has(when)) {
      /*
       * ⚠ 没有载体的伤害/治疗打的是**锁定的那个目标**；
       *   一个都没锁定时会退化成**打自己**（`pickActionTargets` 的最后兜底）。
       *
       *   有意的用法确实存在 —— 比如"位移撞到谁就补一下"，
       *   第二段故意不带载体、直接打锁定的目标。
       *   所以是**警告**不是错误：提醒作者知道自己在用这个兜底。
       *
       * ⚠ 但挂了反应式时机（`onHit` / `onKill` / `onDamaged` …）时**不该报**：
       *   这些时机本身就带着"刚碰到/刚打中/刚被打的那个单位"，
       *   不带载体打的就是它 —— 这是对的做法，报出来就是假警告。
       *   所以必须看语境，见 `LocatedAction.when`。
       */
      out.push(warn('NO_DELIVERY', `${path}.delivery`,
        `${p.kind} 动作没有载体，打的是**锁定的目标**`,
        '没有锁定目标时会退化成打自己。'
        + '如果这是有意的（比如"撞到谁就补一下"），忽略这条；'
        + '否则补一个载体（扇形 / 光束 / 范围 / 投射物）。'))
    }

    /*
     * ⚠ **不写 `target` 时，效果落在谁身上是不确定的。**
     *
     *   这不是吹毛求疵，是一个真实存在过的、代价很高的坑：
     *   定价器以前用 `when !== 'onHit'` 去猜，猜错的方向就是"账算反了"——
     *   本该是收益的规则记成代价（或者反过来），而且**没有任何地方会报警**。
     *   它咬了四次，每次的症状都是"数值明明没动，点数却不对劲"。
     *
     *   现在定价器和引擎都按同一张表（`defaultTargetOf`）走，
     *   但 `'depends'` 那几类时机**本质上取决于它所在的术式**：
     *   同一个技能放进"自愈术式"和"攻击术式"，账会不一样。
     *   定价只能取一个默认（对面那个），所以**这里要把它报出来** ——
     *   让人知道这条账是"假定打敌人"算的。
     *
     *   真正的确定性判据在 `validateTechnique` 里：那时候术式的 `valid` 是已知的，
     *   可以判断"引擎实际会打谁"和"账上假定打谁"是否一致
     *   （见 `TARGET_CONTRADICTS_TECHNIQUE`）。
     */
    if (action.target === undefined
      && action.delivery === undefined
      && action.valid === undefined
      && defaultTargetOf(when, inHook) === 'depends'
      && AFFECTS_OTHERS.has(p.kind)
      && !(p.kind === 'attribute' && typeof p.path === 'string' && p.path.startsWith('pipeline.'))) {
      out.push(warn('TARGET_DEPENDS_ON_TECHNIQUE', `${path}.target`,
        '这条动作没写 target，落在谁身上**取决于它所在的术式**',
        '术式的 valid 全是 self → 打自己；否则 → 打锁定目标（通常是敌人）。'
        + '⚠ 而那个锁定目标**也可能根本不存在**（方向性术式没锁人）——'
        + '那时候这条动作**什么都不做**（2026-09-30 日志 61：不许"随便挑一个"、'
        + '也不许"算我自己身上"）。'
        + '这条账现在按「打对面那个」算。'
        + '想让账和引擎都确定下来，就显式写 `target: "self"` 或 `"hit"`。'
        + '（有载体、或者动作自己写了 valid 的，目标由几何和 valid 决定，不算这一类。）'))
    }
  }

  return out
}

function checkDeliveryNumbers(out: Issue[], d: DeliverySpec, at: string): void {
  /*
   * ⚠ `radius` / `length` 可以是**动态参数**（`{ ref: 'weapon.reach' }`）——
   *   那就是"长剑够得着 3 米、短匕只有 2.2 米"的实现方式。
   *   所以这两个字段允许是对象，但对象里必须真的有一个 ref。
   */
  const GEOM = ['radius', 'length'] as const
  for (const k of GEOM) {
    const v = d[k]
    if (v === undefined || isNum(v)) continue
    if (!isObj(v) || !isStr((v as { ref?: unknown }).ref)) {
      out.push(err('BAD_DELIVERY', `${at}.${k}`,
        `${k} 要么是个非负数，要么是个带 ref 的动态参数`,
        `实际是 ${JSON.stringify(v)}`))
    }
  }

  /*
   * ⚠ 这一串里原来还有 `'count'`（"发射数量"）—— 2026-09-30 日志 55 跟着
   *   schema 那个**死字段**一起删掉了（它不再是 `DeliverySpec` 的字段）。
   *   还写着 `count` 的内容由下面那条**指名道姓的报错**接住（见 USED 那一段）。
   */
  const keys = ['angle', 'width', 'speed', 'lifetime'] as const
  for (const k of keys) {
    const v = d[k]
    if (v !== undefined && (!isNum(v) || v < 0)) {
      out.push(err('BAD_DELIVERY', `${at}.${k}`,
        `${k} 必须是非负数`, `实际是 ${JSON.stringify(v)}`))
    }
  }
  if (d.kind === 'meleeArc' && isNum(d.angle) && d.angle > 360) {
    out.push(err('BAD_ANGLE', `${at}.angle`, '扇形张角不能超过 360 度'))
  }
  if ((d.kind === 'beam' || d.kind === 'capsule') && d.length === undefined) {
    out.push(err('MISSING_LENGTH', `${at}.length`,
      `${d.kind} 必须写 length`, '光束和突刺都需要长度，否则判定不出来。'))
  }
  /*
   * ⚠⚠ **`DeliverySpec.homing`（追踪）：字段**已经删掉了** —— 还写着它的一律报错**
   *   （2026-09-30 日志 56，玩家裁定）。理由和上面 `delivery.count` **逐字相同**：
   *   它是"schema 有、`describe` 为它生成过「追踪」两个字、**引擎一处都不读**"的
   *   **第二个真相**，而且它比 `count` 更坏 —— 它**骗人**（玩家照着配了飞弹、
   *   打出去发现它**直直地飞**，然后以为这是一个 bug，而他没有任何办法知道那是"没实现"）。
   *
   *   ⇒ 玩家 2026-09-30 把「追踪」裁定成**一件修饰零件**（不是载体上的开关）：
   *     "**正常的技能只沿着发射方向走，而追踪技能瞄准敌人**"（追问后确认：**自己找敌人**）。
   *     它的落点是 `content/modifiers/homing.json`（`kind: 'homing'`），
   *     挂在**被修饰的那个技能前面**（`at: 0`）—— 和「一分为 X」/「排布」同一个用法。
   *
   *   ⚠ 为什么是**报错**而不是上面那条警告：警告说"这个字段在这类载体上没用"，
   *     而这里要说的是"**这个字段不存在了**，你想做的事情得换一个零件做"。
   *     ⇒ 内容里真的写了它的作者**必须**看到这句话，不能只拿到一条可能被忽略的警告。
   *
   *   ⚠⚠ **不许留孤儿判据**：这一段和 `describe.ts` 里那条"生成「追踪」"的注释
   *     是同一个字段的两半，两半都在这一片里清掉了 —— 引擎里**没有** `homing`
   *     的读取点，也没有它的兜底，所以删掉它不会让任何既有内容少一个行为。
   */
  if (d.kind === 'area' && d.radius === undefined) {
    out.push(err('MISSING_RADIUS', `${at}.radius`, 'area 必须写 radius'))
  }

  /*
   * ⚠ **投射物的 `radius` 是子弹自己的大小**，不是"够得着多远"。
   *   写成 `{ ref: 'weapon.reach' }` 的话它会被静默忽略
   *   （`spawnProjectile` 只认数字，退到默认 0.25 米）——
   *   而作者以为自己的子弹会跟着武器变粗。
   *   射程该写在扇形/线形载体的 geometry 上。
   */
  if (d.kind === 'projectile' && d.radius !== undefined && !isNum(d.radius)) {
    out.push(warn('GEOM_REF_IGNORED', `${at}.radius`,
      '投射物的 radius 是**子弹自己的大小**，写动态参数没有用（引擎只认数字）',
      '武器射程要写在扇形（meleeArc 的 radius）或线形（beam / capsule 的 length）上。'))
  }

  /*
   * ⚠ **用错了载体的字段** —— 写上去一点效果都没有。
   *
   *   玩家 2026-09-21 给了一条原则：
   *   > 如果改变技能的某种属性不会改变技能的效果（或非常不明显），
   *   > 那这个属性可以固定而不进入编辑器供玩家修改。
   *
   *   这一条是它的**校验器侧**：引擎对每种载体只读固定的几个字段
   *   （见 `src/sim/targeting.ts` 里那几个分支）。别的字段写上去是**静默失效**的，
   *   而编辑器又会照着 JSON 里有什么就给什么配滑块 ——
   *   于是玩家拖着一个"半径"，拖了半天发现打出去的宽度没变。
   *
   *   宁可在加载期说一句，也不要让玩家在编辑器里对着一个死滑块发呆。
   */
  const USED: Record<string, readonly string[]> = {
    meleeArc: ['radius', 'angle'],
    area: ['radius'],
    aura: ['radius'],
    beam: ['length', 'width'],
    capsule: ['length', 'width'],
    projectile: ['speed', 'lifetime', 'radius'],
    self: [],
    spawn: [],
  }
  const used = USED[d.kind]
  if (used !== undefined) {
    /*
     * ⚠⚠ **`count` 从这一张表里拿掉了**（2026-09-30 日志 55）：它已经不是
     *   `DeliverySpec` 的字段了（那个"发射数量"是**死字段** —— 引擎从来没读过它），
     *   所以它现在走下面那条**指名道姓的报错**，而不是这里那句笼统的"这类载体不认它"。
     *   ⚠ 报错比警告强：这里说的不是"这个字段用错载体了"，而是"**这个字段没了**"。
     */
    const all = ['radius', 'angle', 'length', 'width', 'speed', 'lifetime'] as const
    for (const k of all) {
      if (d[k] === undefined) continue
      if (used.includes(k)) continue
      out.push(warn('DELIVERY_FIELD_UNUSED', `${at}.${k}`,
        `${d.kind} 不读 ${k} —— 写上去没有任何效果`,
        `这类载体只认：${used.length > 0 ? used.join(' / ') : '（什么都不认，它只是个容器）'}。`
        + `删掉 ${k}，或者换一个用得上它的载体。`))
    }

    /*
     * ⚠⚠ **`delivery.count` 已经删掉了 —— 还写着它的一律报错**（2026-09-30 日志 55，
     *   上级裁定）。理由：它是"schema 有、`describe` / `pricing` 读、**引擎不读**"的
     *   **第二个真相**；"一次打出好几发"今天只有一条路（修饰零件「**一分为 X**」，
     *   走 `activateGroup`，每一份各起一次施法）。
     *
     *   ⚠ 为什么是**报错**而不是上面那条警告：警告说"这个字段在这类载体上没用"，
     *     而这里要说的是"**这个字段不存在了**，你想做的事情得换一个零件做"。
     *     ⇒ 内容里真的写了它的作者**必须**看到这句话，不能只拿到一条可能被忽略的警告。
     */
    const raw = d as unknown as Record<string, unknown>
    if (raw['count'] !== undefined) {
      out.push(err('BAD_DELIVERY', `${at}.count`,
        '`delivery.count`（"发射数量"）**已经删掉了** —— 它是个死字段，引擎从来没读过它',
        '⚠ 它的下场是"**第二个真相**"：schema 里写着、描述和点数也照着它算，'
        + '而引擎造投射物时**只看 `speed` / `lifetime` / `radius`** ⇒ '
        + '写 `count: 3` 出来的还是**一发**，而且只有一句警告兜着。\n'
        + '⇒ "一次打出好几发"今天**只有一条路**：修饰零件「**一分为 X**」'
        + '（`content/modifiers/split.json`）—— 它走 `activateGroup`，每一份各起一次施法、'
        + '各付各的能量和冷却。把它挂在这个技能**前面**（`at: 0`）就行。'))
    }

    /*
     * ⚠⚠ **`DeliverySpec.homing`（追踪）：字段**已经删掉了** —— 还写着它的一律报错**
     *   （2026-09-30 日志 56，玩家裁定）。理由和上面 `delivery.count` **逐字相同**：
     *   它是"schema 有、`describe` 为它生成过「追踪」两个字、**引擎一处都不读**"的
     *   **第二个真相**，而且它比 `count` 更坏 —— 它**骗人**（玩家照着配了飞弹、
     *   打出去发现它**直直地飞**，然后以为这是一个 bug，而他没有任何办法知道那是"没实现"）。
     *
     *   ⇒ 玩家 2026-09-30 把「追踪」裁定成**一件修饰零件**（不是载体上的开关）：
     *     "**正常的技能只沿着发射方向走，而追踪技能瞄准敌人**"（追问后确认：**自己找敌人**）。
     *     它的落点是 `content/modifiers/homing.json`（`kind: 'homing'`），
     *     挂在**被修饰的那个技能前面**（`at: 0`）—— 和「一分为 X」/「排布」同一个用法。
     *
     *   ⚠ 为什么是**报错**而不是上面那条警告：警告说"这个字段在这类载体上没用"，
     *     而这里要说的是"**这个字段不存在了**，你想做的事情得换一个零件做"。
     *     ⇒ 内容里真的写了它的作者**必须**看到这句话，不能只拿到一条可能被忽略的警告。
     *
     *   ⚠⚠ **不许留孤儿判据**：这一段和 `describe.ts` 里那条"生成「追踪」"的注释
     *     是同一个字段的两半，两半都在这一片里清掉了 —— 引擎里**没有** `homing`
     *     的读取点，也没有它的兜底，所以删掉它不会让任何既有内容少一个行为。
     */
    if (raw['homing'] !== undefined) {
      out.push(err('BAD_DELIVERY', `${at}.homing`,
        '`delivery.homing`（"追踪"）**已经删掉了** —— 它是个死字段，引擎从来没读过它',
        '⚠ 它的下场和 `delivery.count` 一样是"**第二个真相**"：schema 里写着、'
        + '说明生成器还为它写出过「**追踪**」两个字，而引擎造投射物时'
        + '**只看 `speed` / `lifetime` / `radius` / `pierce`** ⇒ 写 `homing: true` 出来的'
        + '**还是一发直着飞的子弹**，而玩家会以为那是 bug。\n'
        + '⇒ 「追踪」今天**是一件修饰零件**（玩家 2026-09-30 裁定的）：'
        + '`content/modifiers/homing.json`，`kind: "homing"` —— 把它挂在这个技能**前面**'
        + '（`at: 0`）就行，被它修饰的投射物会在半路上**自己找最近的敌人**。\n'
        + '⚠ **只对会飞的东西有效**（`delivery.kind: "projectile"`）：'
        + '`beam` / `capsule` / `meleeArc` / `aura` / `area` / `self` 这些**非飞行载体**'
        + '被它修饰时**什么都不做** —— 那不是报错（照「环绕」的先例），'
        + '提示由**界面**画在那条序列下方。\n'
        + '⚠ 所以把 `delivery.homing` **删掉**，改去装那个零件。'))
    }
  }
}

function checkPayload(out: Issue[], p: Payload, at: string): void {
  switch (p.kind) {
    case 'damage': {
      checkValue(out, p.amount, `${at}.amount`)
      if (p.mode !== undefined) {
        checkEnum(out, p.mode, ['normal', 'lethal'], `${at}.mode`, '伤害模式')
      }
      if (p.mode === 'lethal') {
        out.push(warn('LETHAL_DAMAGE', at,
          '这是一条"命中必杀"的伤害',
          '必杀必须能被反制，否则对局会收敛成"谁先出手"。记得给对手留一个"免疫即死"的状态标签。'))
      }
      break
    }
    case 'heal':
      checkValue(out, p.amount, `${at}.amount`)
      break
    case 'attribute':
      if (!isStr(p.path)) {
        out.push(err('MISSING', `${at}.path`,
          '属性载荷必须写 path', '例如 char.energy.current / char.critDamage / skill.cooldown。'))
      }
      checkEnum(out, p.op, MODIFIER_OPS, `${at}.op`, '修饰操作')
      checkValue(out, p.value, `${at}.value`)
      break
    case 'status':
      checkEnum(out, p.verb, ['apply', 'remove'], `${at}.verb`, 'verb')
      if (!isStr(p.statusId) && !p.inline) {
        out.push(err('MISSING_STATUS', at,
          'status 载荷要么写 statusId，要么写 inline',
          'statusId 引用内置状态；inline 是玩家自己捏的状态。'))
      }
      if (isStr(p.statusId) && p.inline) {
        out.push(warn('STATUS_BOTH', at, '同时写了 statusId 和 inline',
          '两个都会生效，容易搞混。建议只留一个。'))
      }
      // 内联状态的详细检查交给 checkStatuses 做，避免同一个状态被查两遍、警告打两次。
      break
    case 'displacement':
      checkEnum(out, p.mode, ['knockback', 'pull', 'teleport', 'dash'], `${at}.mode`, '位移模式')
      checkValue(out, p.distance, `${at}.distance`)
      if (p.airborne === true) {
        out.push(warn('AIRBORNE', at,
          '这个位移带击飞',
          '击飞需要一个只用于渲染的 z 偏移。中招者"飞起来但仍能被击中"这类边界情况要单独定。'))
      }
      break
    case 'perception':
      checkEnum(out, p.mode, ['reveal', 'mark', 'setVisibility'], `${at}.mode`, '感知模式')
      if (p.mode === 'setVisibility' && p.value === undefined) {
        out.push(err('MISSING_VALUE', `${at}.value`, 'setVisibility 必须写 value（0 = 完全隐形）'))
      }
      if (p.value !== undefined) checkValue(out, p.value, `${at}.value`)
      break
    case 'spawn':
      if (!isStr(p.entityId)) {
        out.push(err('MISSING', `${at}.entityId`,
          'spawn 载荷必须引用一个实体定义 id',
          '只做"引用预设敌人"的廉价版召唤；玩家自定义召唤物的 AI 是另一个量级的工程。'))
      }
      break
    default:
      break
  }
}

function checkValue(out: Issue[], v: ValueSpec | undefined, at: string): void {
  if (!isObj(v)) {
    out.push(err('MISSING_VALUE', at, '缺少数值',
      '要么写 const（常量），要么写 ref（引用运行时量，比如距离、血量百分比）。'))
    return
  }

  const hasConst = v.const !== undefined
  const hasRef = v.ref !== undefined

  if (!hasConst && !hasRef) {
    out.push(err('EMPTY_VALUE', at, 'const 和 ref 至少要写一个'))
  }
  if (hasConst && hasRef) {
    out.push(err('AMBIGUOUS_VALUE', at, 'const 和 ref 只能写一个',
      '两个都写的话，模拟器不知道该用哪个。'))
  }
  if (hasConst && !isNum(v.const)) {
    out.push(err('BAD_VALUE', `${at}.const`, 'const 必须是数字'))
  }
  if (hasRef) {
    checkEnum(out, v.ref, VALUE_REFS, `${at}.ref`, '运行时量')
    if (v.curve !== undefined) {
      if (!Array.isArray(v.curve) || v.curve.length < 2) {
        out.push(err('BAD_CURVE', `${at}.curve`, 'curve 至少要有两个点'))
      } else {
        for (let i = 0; i < v.curve.length; i++) {
          const pt = v.curve[i]
          if (!Array.isArray(pt) || pt.length !== 2 || !isNum(pt[0]) || !isNum(pt[1])) {
            out.push(err('BAD_CURVE_POINT', `${at}.curve[${i}]`,
              '曲线上的点必须是 [输入, 输出] 两个数字'))
          }
        }
      }
    }
    if (v.ref === 'targetStacks' && !isStr(v.refArg)) {
      out.push(err('MISSING_REF_ARG', `${at}.refArg`,
        'ref 是 targetStacks 时必须写 refArg',
        '要说明是"哪个状态的"层数，比如 "status.burn"。'))
    }
  }
  if (v.min !== undefined && v.max !== undefined && isNum(v.min) && isNum(v.max) && v.min > v.max) {
    out.push(err('BAD_RANGE', at, `min (${v.min}) 大于 max (${v.max})`))
  }
}

// ============================================================================
//  6. 状态
// ============================================================================

export function checkStatuses(ctx: Ctx): Issue[] {
  const out: Issue[] = []
  const seen = new Map<string, string>()

  for (const { status, path } of collectStatuses(ctx.skill)) {
    checkStatus(out, status, path)
    checkStatusInert(out, status, path)

    if (isStr(status.id)) {
      const prev = seen.get(status.id)
      if (prev !== undefined) {
        out.push(err('DUP_STATUS_ID', `${path}.id`,
          `内联状态 id「${status.id}」出现了两次`,
          `第一次在 ${prev}。同名会被当成同一个状态，很容易出玄学 bug。`))
      } else {
        seen.set(status.id, path)
      }
    }
  }

  return out
}

function checkStatus(out: Issue[], s: StatusDef, at: string): void {
  if (!isObj(s)) {
    out.push(err('BAD_STATUS', at, '状态必须是对象'))
    return
  }

  if (!isStr(s.id)) out.push(err('MISSING', `${at}.id`, '状态缺少 id'))
  if (!isStr(s.name)) {
    out.push(warn('MISSING_NAME', `${at}.name`, '状态没有名字',
      '玩家在界面上会直接看到 id，读起来很难受。'))
  }

  if (!Array.isArray(s.tags) || s.tags.length === 0) {
    out.push(warn('NO_TAGS', `${at}.tags`, '状态没有任何标签',
      '标签是净化、霸体、抗性、亡灵覆写的匹配依据。没有标签的状态，这些机制全都识别不了它。'))
  }

  if (s.duration !== undefined && (!isNum(s.duration) || (s.duration < 0 && s.duration !== -1))) {
    out.push(err('BAD_DURATION', `${at}.duration`,
      'duration 必须是 >= 0 的秒数，或 -1 表示永久'))
  }

  /*
   * ⚠ `visibility: 1` 是**空操作** —— 写上去等于没写。
   *
   *   `visibilityOf()` 取的是所有状态里的**最小值**，而它的起点就是 1
   *   （正常可见）。所以：
   *     visibility: 1    什么都不会发生（这一条就是为它加的）
   *     visibility: 0.5  半透明
   *     visibility: 0    看不见 → 敌人锁定不了你
   *
   *   熔岩护甲里曾经写着 `visibility: 1`，看上去像"让它更显眼"，
   *   其实一个字都没做。玩家 2026-09-21 给的原则正好管这一类：
   *   **改了不生效的属性，不该出现在界面上让人拖。**
   *   这里先把"写了不生效"的那一种拦掉。
   */
  if (s.visibility !== undefined) {
    if (!isNum(s.visibility) || s.visibility < 0 || s.visibility > 1) {
      out.push(err('BAD_VISIBILITY', `${at}.visibility`,
        'visibility 必须是 0~1 之间的数', '0 = 完全隐形，0.5 = 半透明，1 = 正常可见。'))
    } else if (s.visibility >= 1) {
      out.push(warn('VISIBILITY_NO_OP', `${at}.visibility`,
        'visibility: 1 是空操作 —— 正常可见就是默认值',
        'visibilityOf 取的是最小值，起点就是 1，所以写 1 什么都不会发生。'
        + '想变隐形要写小于 1 的值（0.5 = 半透明，0 = 完全隐形）；'
        + '本来就不打算改动它的话，删掉这一行。'))
    }
  }

  /*
   * 阵营覆盖（魅惑）。
   *
   * ⚠ 取值必须和 `EntityDef.faction` 一样 —— 它们指的是同一件事。
   *   `'caster'` 是"跟挂上这个状态的那个人同阵营"。
   */
  if (s.faction !== undefined) {
    checkEnum(out, s.faction, FACTIONS, `${at}.faction`, '阵营覆盖')
    /*
     * ⚠ 挂在自己身上、又写 `'caster'` 是**空操作**（自己当然是自己的阵营）。
     *   这类"写了不生效"的东西按玩家那条原则就该被点出来 ——
     *   和 `visibility: 1` 是同一类。
     */
    if (s.faction === 'caster' && s.tags?.includes('selfOnly')) {
      out.push(warn('FACTION_NO_OP', `${at}.faction`,
        '这个状态只能挂在自己身上，再写 faction: caster 是空操作',
        '自己跟自己的阵营当然一样。要么删掉这一行，要么让它能挂到别人身上。'))
    }
  }

  for (const c of s.disables ?? []) {
    checkEnum(out, c, CAPABILITIES, `${at}.disables`, '能力')
  }
  if (Array.isArray(s.disables) && s.disables.length > 0 && Array.isArray(s.tags) && !s.tags.some(t => t === 'hardCC' || t === 'softCC')) {
    out.push(warn('CC_WITHOUT_TAG', `${at}.tags`,
      '这个状态禁用了能力，但没有 hardCC / softCC 标签',
      '霸体靠标签匹配来免疫控制。没有标签的话，霸体挡不住它。'))
  }

  if (s.stack) {
    if (!Number.isInteger(s.stack.max) || s.stack.max < 1) {
      out.push(err('BAD_STACK', `${at}.stack.max`, 'stack.max 必须是 >= 1 的整数'))
    }
    checkEnum(out, s.stack.behavior, ['refresh', 'stack', 'independent'],
      `${at}.stack.behavior`, '叠层方式')
  }

  if (s.removal) {
    if (s.removal.immuneTo !== undefined && !Array.isArray(s.removal.immuneTo)) {
      out.push(err('BAD_REMOVAL', `${at}.removal.immuneTo`, 'immuneTo 必须是数组'))
    }
    if (s.removal.onlyBy !== undefined && !Array.isArray(s.removal.onlyBy)) {
      out.push(err('BAD_REMOVAL', `${at}.removal.onlyBy`, 'onlyBy 必须是数组'))
    }
    const immuneDispel = Array.isArray(s.removal.immuneTo) && s.removal.immuneTo.includes('dispel')
    const hasOnlyBy = Array.isArray(s.removal.onlyBy) && s.removal.onlyBy.length > 0
    if (immuneDispel && !hasOnlyBy && s.duration === -1) {
      out.push(warn('UNREMOVABLE', `${at}.removal`,
        '永久状态 + 免疫净化 + 没有"只能由某技能移除"的白名单',
        '这个状态一旦挂上就永远下不来。如果是故意的就忽略；不是的话补一个 onlyBy。'))
    }
  }

  if (Array.isArray(s.tags) && s.tags.includes('debuff') && s.duration === -1 && !s.removal) {
    out.push(warn('PERMANENT_DEBUFF', at,
      '永久负面状态，而且没有写任何移除规则',
      '玩家没有任何办法摆脱它。至少给它一个 removal（比如"可以被净化"）。'))
  }

  const mods = s.modifiers ?? []
  for (let i = 0; i < mods.length; i++) {
    const m = mods[i]
    if (!m) continue
    if (!isStr(m.path)) {
      out.push(err('MISSING', `${at}.modifiers[${i}].path`, '属性修饰必须写 path'))
    }
    checkEnum(out, m.op, MODIFIER_OPS, `${at}.modifiers[${i}].op`, '修饰操作')
    checkValue(out, m.value, `${at}.modifiers[${i}].value`)

    if (isStr(m.path) && STORED_ATTRIBUTES.includes(m.path)) {
      out.push(warn('MODIFIER_ON_STORED', `${at}.modifiers[${i}].path`,
        `「${m.path}」是存储属性，状态修饰对它不生效`,
        '状态修饰只作用于派生属性（上限、速率、移速……）。要持续扣血扣能量，'
        + '用一条 onTick 规则的属性载荷 —— 那才会真的改写它。'))
    }
  }

  const hooks = s.hooks ?? []
  for (let i = 0; i < hooks.length; i++) {
    const h = hooks[i]
    if (!h) continue
    checkEnum(out, h.stage, STAGES, `${at}.hooks[${i}].stage`, '管线步骤')
    if (h.when !== undefined) {
      checkEnum(out, h.when, TRIGGERS, `${at}.hooks[${i}].when`, '触发时机')
    }
    if (h.side !== undefined) {
      checkEnum(out, h.side, ['target', 'source', 'any'], `${at}.hooks[${i}].side`, '钩子侧')
    }
    if (h.every !== undefined) {
      if (!isNum(h.every) || h.every <= 0) {
        out.push(err('BAD_EVERY', `${at}.hooks[${i}].every`, 'every 必须是正数（秒）'))
      } else if (h.when !== 'onTick') {
        out.push(warn('EVERY_IGNORED', `${at}.hooks[${i}].every`,
          `when 是 ${String(h.when)}，every 不会生效`, 'every 只对 onTick 有意义。'))
      }
    }
    if (h.when === 'onTick' && h.every === undefined) {
      out.push(warn('HOOK_TICK_NO_EVERY', `${at}.hooks[${i}].every`,
        'onTick 钩子没写 every',
        '会按默认的 1 秒一次。写清楚更好 —— 持续伤害的节奏是手感的一部分。'))
    }
    if (h.priority !== undefined && !isNum(h.priority)) {
      out.push(err('BAD_PRIORITY', `${at}.hooks[${i}].priority`, 'priority 必须是数字'))
    }
    if (!Array.isArray(h.then) || h.then.length === 0) {
      // 纯吸收型的钩子（护盾、次数盾）不需要动作，池子就是它的全部效果
      if (h.absorb === undefined) {
        out.push(err('EMPTY_HOOK', `${at}.hooks[${i}].then`,
          '管线钩子必须至少有一个动作',
          '除非它是纯吸收型钩子（写了 absorb），那种钩子靠池子生效。'))
      }
    }
    if (h.absorb !== undefined) {
      if (h.stage !== 'absorb') {
        out.push(err('ABSORB_WRONG_STAGE', `${at}.hooks[${i}].absorb`,
          `写了 absorb 但 stage 是 ${h.stage}`,
          '吸收池只在 absorb 阶段有用。'))
      }
      checkEnum(out, h.absorb.mode, ['damage', 'hits'], `${at}.hooks[${i}].absorb.mode`, '吸收模式')
      if (!isNum(h.absorb.perStack) || h.absorb.perStack <= 0) {
        out.push(err('BAD_ABSORB', `${at}.hooks[${i}].absorb.perStack`,
          'perStack 必须是正数',
          'damage 模式是吸收多少点伤害，hits 模式是挡几次。'))
      }
    }
  }

  if (s.visibility !== undefined && (!isNum(s.visibility) || s.visibility < 0 || s.visibility > 1)) {
    out.push(err('BAD_VISIBILITY', `${at}.visibility`,
      'visibility 必须在 0 到 1 之间（0 = 完全隐形）'))
  }
}

/**
 * 惰性字段：写在**状态**上的。
 *
 * ⚠ 单独抽出来是因为 `checkStatus` 太长了，而这一类问题以后还会加。
 *   判据只有一个：**引擎读了它吗**。没读就是惰性，不管听起来多合理。
 *
 * 现在这张表是**空的** —— `vfx` 那条已经修掉了：
 *   `ActiveStatus` 会从定义里把它抄过来（sim/types.ts 的 makeActiveStatus），
 *   客户端遍历 `entity.statuses` 就能画出"谁身上有什么"（web/src/fx.ts 的
 *   pickStatusStyle + statusPrims）。没有素材时按标签退回程序化光环。
 *
 * 留着这个函数是因为下一个惰性字段还会来 —— 到时候照这个格式写就行。
 */
function checkStatusInert(_out: Issue[], _s: StatusDef, _at: string): void {
  // 目前没有惰性字段。
}

// ============================================================================
//  6b. 状态库里的一个状态（跨文件，不属于任何技能）
// ============================================================================

/**
 * 校验**状态库**里的一个状态定义（`content/statuses/*.json`）。
 *
 * ⚠ 它和 `checkStatuses` 的关系：那一组查的是**内联**状态（写在某个技能的
 *   规则里），这里查的是**独立文件**里的状态。两边跑的是同一个 `checkStatus`,
 *   所以规矩一致 —— 新加一条状态规则不用改两处。
 */
export function validateStatus(status: StatusDef): Issue[] {
  const out: Issue[] = []
  checkStatus(out, status, '')
  return out
}

// ============================================================================
//  6b. 武器定义（content/weapons/*.json）
// ============================================================================
//
//  ⚠ 为什么武器也要校验，而不是"反正就是一张属性表"：
//
//    1. `weaponTechnique` 写错名字的话，后果和状态悬空引用**一模一样** ——
//       校验全绿、能进游戏，直到你真的按下左键才发现"没反应"。
//       这条检查的价值就是把那一刻提前到加载期。
//    2. 属性名写错（`weapon.reach` 敲成 `weapon.range`）不会被任何地方拦住：
//       技能 ref 读不到就用缺省值，武器"看起来能用"，只是钩不着人。
//       这种错最难查 —— 数字看着像个数字，就是不对。
//
//  ⚠ 属性名表必须和 `src/sim/types.ts` 的 `WEAPON_DEFAULTS` 保持一致
//    （和上面的 STORED_ATTRIBUTES 同一个道理）。

/** 武器自己的参数：只被武器技能的 `ref` 读 */
const WEAPON_ATTRIBUTES: readonly string[] = ['weapon.reach', 'weapon.damage', 'weapon.windup']

/**
 * 持有者修饰的名字空间前缀。
 *
 * ⚠ `char.*` 不加白名单检查 —— 那是"给人身上的修饰"，
 *   合法名字由 STORED_ATTRIBUTES 和修饰符系统决定，
 *   在这里再抄一份会变成第三份真相。只查前缀拼错（比如 `chr.speed`）。
 */
const HOLDER_ATTR_PREFIX = 'char.'

export function validateWeapon(w: WeaponDef, techniques?: ReadonlySet<string>): Issue[] {
  const out: Issue[] = []

  if (!isStr(w.id) || w.id.length === 0) {
    out.push(err('BAD_ID', 'id', '武器没有 id。', 'id 是别的文件引用它的唯一凭据。'))
  }
  if (!isStr(w.name) || w.name.length === 0) {
    out.push(err('BAD_NAME', 'name', '武器没有名字。', '名字是给玩家看的，HUD 上换武器就靠它。'))
  }
  if (typeof w.schemaVersion !== 'number') {
    out.push(err('BAD_SCHEMA_VERSION', 'schemaVersion', '缺少 schemaVersion。'))
  }

  // ---- 属性表 ----
  // ⚠ 先算出 attrs 再逐项查，而不是"表坏了就直接 return" ——
  //   属性表写坏和术式槽写错是两件独立的错，一次报全，别让玩家改两轮。
  const attrs = isObj(w.attributes) ? w.attributes : null
  if (attrs === null) {
    out.push(err(
      'BAD_WEAPON_ATTRIBUTES', 'attributes', 'attributes 必须是「属性名 → 数字」的表。',
      '没有属性表的武器读不到 weapon.reach / weapon.damage，技能会用全局缺省值。',
    ))
  } else {
    const keys = Object.keys(attrs)
    if (keys.length === 0) {
      out.push(warn(
        'EMPTY_WEAPON_ATTRIBUTES', 'attributes', '这把武器一个属性都没写。',
        '所有武器技能都会退回全局缺省值（reach 2.5 / damage 1 / windup 1）——' +
        '能用，但和别的武器没区别，多半是忘了写。',
      ))
    }

    for (const key of keys) {
      const value = attrs[key]
      if (!isNum(value)) {
        out.push(err(
          'BAD_WEAPON_ATTRIBUTE_VALUE', `attributes.${key}`,
          `属性「${key}」的值不是数字：${JSON.stringify(value)}`,
          '属性会被直接代入技能里的 ref，值必须是数字。',
        ))
        continue
      }
      if (WEAPON_ATTRIBUTES.includes(key)) continue
      if (key.startsWith(HOLDER_ATTR_PREFIX)) continue

      out.push(warn(
        'UNKNOWN_WEAPON_ATTRIBUTE', `attributes.${key}`,
        `属性名「${key}」既不在这把武器自己的参数表里，也不是「${HOLDER_ATTR_PREFIX}」开头的持有者修饰。`,
        `武器参数只有 ${WEAPON_ATTRIBUTES.join(' / ')}；` +
        `要改持有者本人就写 ${HOLDER_ATTR_PREFIX}xxx。拼错的属性名不会被任何地方拦下来 —— ` +
        '技能 ref 读不到就用缺省值，武器看着能用，只是够不着人。',
      ))
    }
  }

  // ---- 两个术式槽 ----
  for (const slot of ['weaponTechnique', 'magicTechnique'] as const) {
    const value = w[slot]
    if (value === undefined) continue
    if (!isStr(value) || value.length === 0) {
      out.push(err('BAD_WEAPON_TECHNIQUE', slot, `${slot} 必须是术式 id 字符串（或者干脆不写）。`))
      continue
    }
    // ⚠ 悬空引用：这才是校验武器最值钱的一条。
    //   术式名写错的话，表现是"按左键没反应" —— 和状态悬空引用一样，
    //   不查就只能等玩家自己发现。
    if (techniques !== undefined && !techniques.has(value)) {
      out.push(err(
        'UNKNOWN_WEAPON_TECHNIQUE', slot,
        `算不了账：内容库里没有术式「${value}」`,
        slot === 'weaponTechnique'
          ? '这是左键那套普攻 —— 引用不到就是装上武器之后左键空的。id 写错了，或者那个术式还没建。'
          : '这是魔法术式槽 —— 引用不到就是这个槽是空的。id 写错了，或者那个术式还没建。',
      ))
    }
  }

  if (w.weaponTechnique === undefined) {
    out.push(warn(
      'NO_WEAPON_TECHNIQUE', 'weaponTechnique',
      '这把武器没有武器术式 —— 装上它之后左键是空的。',
      '如果是有意的（比如纯属性道具、盾），忽略这条；' +
      '否则补一个写了 sequences 的术式 id。',
    ))
  }

  return out
}

// ============================================================================
//  7. 目标
// ============================================================================
//
// ⚠ **2026-09-21（日志 47）：瞄准搬到技能层了。**
//
//   定稿（`docs/sequence-and-modifier-model.md` §六 / §九）：
//   **术式没有瞄准，序列段也没有** —— 瞄准是"这个技能怎么解释那一个意图"，
//   所以它住在 `Skill.targeting` 上，每个技能各自判断（默认鼠标方向）。
//
//   于是这一组检查跟着搬过来：以前它检查**术式**的 `targeting`
//   （`validateTechnique` 里那几条），现在检查**技能**的。
//   ⚠ **形状和枚举一个字都没变**（`mode` / `valid` / `range` / `requireStatusTag`）——
//     这次是搬家，不是重新设计瞄准，所以报的错也和以前一样。
//
//   ⚠ 防回潮那两条（术式 / 段里又冒出 `targeting`）**不在这里**：
//     它们要看得见"术式"和"段"，所以住在 `validator/index.ts` 的
//     `validateTechnique` 里（那才是能看到术式形状的地方）。

/**
 * 瞄准方式的合法取值。
 *
 * ⚠ 表的**唯一真相**就是上面那个 `TARGETING_MODES` —— schema 里的
 *   `TargetingMode` 联合类型是给人看的（和 `ACTIVATIONS` 同一套约定）。
 */
export function checkTargeting(ctx: Ctx): Issue[] {
  const { skill } = ctx
  const out: Issue[] = []

  /*
   * ⚠ 不写 = **默认鼠标方向**（`directional`）✓
   *
   *   这是玩家定的第 1 条规矩："每个技能自己判断（**默认鼠标方向**）"。
   *   所以**这里不报错也不警告**：不写是合法的、也是常见写法。
   *
   *   ⚠ 但出厂内容里**每个技能都显式写着**——那是**内容**的纪律，
   *     不是校验器的规矩（目的是让"它的瞄准是从哪儿来的"能一条条说出来，
   *     见日志 47 的对照表）。把它做成校验器的规矩就是"对着唯一正确的写法报警告"，
   *     这个坑这个项目踩过好几次（见 `validateSkill` 里那段注释）。
   */
  const t = skill.targeting
  if (t === undefined) return out

  if (!isObj(t)) {
    out.push(err('BAD_TARGETING', 'targeting',
      `targeting 必须是对象，实际是 ${JSON.stringify(t)}`,
      '它回答"这个技能怎么解释玩家给的那一个意图"：'
      + `{ mode, valid, range? }，mode 取 ${TARGETING_MODES.join(' / ')}。`))
    return out
  }

  checkEnum(out, t['mode'], TARGETING_MODES, 'targeting.mode', '瞄准方式')

  /*
   * `valid` 不能为空 —— 空表的意思是"对谁都不有效"，
   * 也就是这个技能**永远不产生效果**（而且不会报错，只是静默地什么都不做）。
   */
  if (!Array.isArray(t['valid']) || t['valid'].length === 0) {
    out.push(err('EMPTY_VALID', 'targeting.valid', 'valid 不能为空',
      '它回答"这个技能对谁有效"。空表 = 对谁都不有效 —— '
      + '释放会成功，但什么都不会发生，而且没有任何地方会报错。'))
  }

  /*
   * ⚠ `areapoint` **必须写 range**。
   *
   *   它的 range 不是"打得到多远"，而是"落点最远能放多远" ——
   *   不写的话超出的落点不会被压回边缘（引擎里 `range > 0` 才做钳制），
   *   玩家能隔着半张地图放火墙。
   *
   *   `locked` / `auto` 不写 range 只是"锁不到人"，还能退回朝向打出去，
   *   所以那两个只在语义上可惜，不报错。
   */
  if (t['mode'] === 'areapoint' && t['range'] === undefined) {
    out.push(err('AREAPOINT_NO_RANGE', 'targeting.range',
      'areapoint 必须写 range',
      'range 在这里是"落点最远能放多远"。不写的话落点不会被限制，'
      + '可以隔着半张地图放地面技能。'))
  }

  return out
}

// ============================================================================
//  9. 跨文件的引用：statusId 到底指不指得到东西
// ============================================================================
//
// ⚠ 这一组**不属于任何一个技能** —— 它要看整份内容库，所以签名和上面
//   那些 checkXxx(ctx) 不一样。
//
//   为什么必须有它：`statusId` 引用不到东西的时候，引擎是**运行期**才炸的
//   （pipeline.ts 的 `throw new Error('找不到状态定义')`）。
//   也就是说内容写错了，一路能过校验、能进游戏，直到你真的按出那个技能。
//
//   这不是假想：`skill.soul-rend` 里那条「驱散目标身上的 status.shield」
//   引用的名字**在出厂内容里根本不存在**（只出现在一个测试文件里），
//   它在那里躺了很久没人发现 —— 因为没有任何东西会提前告诉你。

/** 一条跨文件的引用问题 */
export interface StatusRefIssue {
  /** 哪个技能的哪条规则 */
  where: string
  statusId: string
  /** apply 引用不到会抛异常；remove 引用不到只是静默什么都没做 */
  verb: 'apply' | 'remove'
  level: 'error' | 'warning'
}

/** 一条跨文件的引用问题（状态 / 实体预设都走这一种） */
export interface ContentRefIssue {
  /** 哪个技能的哪条规则 */
  where: string
  /** 引用的是什么：状态还是实体预设 */
  what: 'status' | 'entity'
  /** 被引用的 id */
  refId: string
  /** 状态才有：apply 引用不到会抛异常；remove 引用不到只是静默什么都没做 */
  verb?: 'apply' | 'remove'
  level: 'error' | 'warning'
}

/**
 * 检查整份内容库里所有**按 id 的跨文件引用**。
 *
 * 现在管两种：
 *   `statusId`   —— 状态（apply 会抛异常，remove 会静默无效）
 *   `entityId`   —— 实体预设（`spawn` 会抛异常）
 *
 * ⚠ 它们必须是**同一个检查**，理由一模一样：
 *   引用不到东西的时候，引擎都是**运行期**才炸的。
 *   内容写错了照样能过校验、能进游戏、能开局，直到你真的按出那个技能。
 *
 *   `statusId` 那一半不是假想：`skill.soul-rend` 里那条
 *   「驱散目标身上的 status.shield」引用的名字**在出厂内容里根本不存在**
 *   （只出现在一个测试文件里），它在那里躺了很久 —— 因为没有任何东西
 *   会提前告诉你。`entityId` 那一半在做 spawn 的同一轮就接上了，
 *   不用再等一次同样的教训。
 *
 * `skills` 传**全部**技能 —— 状态可以内联定义在一个技能里、
 * 被另一个技能按 id 引用（灵光盾定义 status.shield，裂魂引用它）。
 * 只查单个技能内部会误报。
 */
export function checkRefs(
  skills: readonly { id?: string, rules?: Rule[] }[],
  known: {
    /** 额外已知的状态 id（状态库 `content/statuses/`） */
    statuses?: readonly string[]
    /** 额外已知的实体预设 id（`content/entities/`） */
    entities?: readonly string[]
  } = {},
): ContentRefIssue[] {
  const definedStatuses = new Set<string>(known.statuses ?? [])
  const definedEntities = new Set<string>(known.entities ?? [])

  // 1. 先把所有内联定义的状态收齐
  for (const s of skills) {
    for (const { status } of collectStatuses(s)) {
      if (typeof status.id === 'string' && status.id.length > 0) definedStatuses.add(status.id)
    }
  }

  // 2. 再查所有按 id 的引用
  const out: ContentRefIssue[] = []
  for (const s of skills) {
    for (const { action, path } of collectActions(s)) {
      const p = action.payload
      if (p === undefined) continue
      const where = `${s.id ?? '(无 id)'} · ${path}`

      if (p.kind === 'status') {
        // 内联定义的不用查（它自己就是定义）
        if (p.inline !== undefined) continue
        if (typeof p.statusId !== 'string' || p.statusId.length === 0) continue
        if (definedStatuses.has(p.statusId)) continue

        out.push({
          where,
          what: 'status',
          refId: p.statusId,
          verb: p.verb,
          /*
           * apply 引用不到 = 一定会抛异常 → 错误
           * remove 引用不到 = 静默什么都没做 → 也是错误，但性质不同
           *
           * 两个都算**错误**而不是警告，因为两种情况下内容写的都不是它想表达的意思。
           * 区别只写在提示里。
           */
          level: 'error',
        })
        continue
      }

      if (p.kind === 'spawn') {
        if (typeof p.entityId !== 'string' || p.entityId.length === 0) continue
        if (definedEntities.has(p.entityId)) continue

        out.push({
          where,
          what: 'entity',
          refId: p.entityId,
          // 召唤一个不存在的预设：运行到那一刻直接抛异常
          level: 'error',
        })
      }
    }
  }
  return out
}

// ============================================================================
//  10. 平衡配置（全局检查，不针对单个术式）
// ============================================================================

export function checkBalance(balance: BalanceConfig): Issue[] {
  const out: Issue[] = []

  if (!Number.isInteger(balance.baseRuleSlots) || balance.baseRuleSlots < 0) {
    out.push(err('BAD_BALANCE', 'baseRuleSlots', 'baseRuleSlots 必须是非负整数'))
  }
  if (!isNum(balance.ruleSlotBuyCost) || balance.ruleSlotBuyCost < 0) {
    out.push(err('BAD_BALANCE', 'ruleSlotBuyCost', 'ruleSlotBuyCost 必须是非负数'))
  }
  if (!isNum(balance.ruleSlotSellGain) || balance.ruleSlotSellGain < 0) {
    out.push(err('BAD_BALANCE', 'ruleSlotSellGain', 'ruleSlotSellGain 必须是非负数'))
  }
  if (isNum(balance.ruleSlotBuyCost) && isNum(balance.ruleSlotSellGain)
    && balance.ruleSlotSellGain > balance.ruleSlotBuyCost) {
    out.push(err('ARBITRAGE', 'ruleSlotSellGain',
      `卖规则位赚 ${balance.ruleSlotSellGain} 点，买规则位只花 ${balance.ruleSlotBuyCost} 点`,
      '这是低买高卖的点数漏洞。ruleSlotSellGain 必须 <= ruleSlotBuyCost。'))
  }

  /*
   * ⚠⚠ 2026-09-30（日志 57）：这里原来有一条 `balanceTolerance 必须是非负数`。
   *   那个字段**已经作废**（"配平容差"整个概念删掉了：合计 ≥ 0 就能用、
   *   < 0 要付血契），`content/balance.json` 里那个键也**已经删了** ——
   *   留着这条检查就是"校验一个谁也不读的字段"，那正是我们要清掉的那类话。
   */

  /*
   * ---- 「份数」类修饰的汇率（2026-09-21 日志 51）----
   *
   * ⚠ 它是**一份份数的价钱**，缺了的话账上那份好处就是**白送**——
   *   而"白送"和"这一条没计价"在账面上长得一模一样（合计照样是 0）。
   *   所以缺了就出声。为什么是**警告**而不是错误：
   *   代码里有一份兜底值（`pricing.ts` 的 `DEFAULT_MODIFIER_RATES`），
   *   缺了不至于算不出账 —— 但玩家必须知道"我改的这个数没生效"。
   *
   * ⚠ 它**不在 `rates` 里**（故意的）：`tools/calibrate.ts` 的拟合变量是
   *   `Object.keys(DEFAULT_RATES)`，往那张表里加键会让标定输出立刻变，
   *   而标定必须逐行不变（修饰不进战斗）。
   */
  const extra = balance.modifierRates?.[MODIFIER_EXTRA_COPY_KEY]
  if (!isNum(extra) || extra <= 0) {
    out.push(warn('BAD_BALANCE', `modifierRates.${MODIFIER_EXTRA_COPY_KEY}`,
      `「份数」类修饰（多重释放 / 一分为 X）的汇率没写对，现在是 ${JSON.stringify(extra)}`,
      '它是"**每多一份**花多少点"（多重释放多打出的 N-1 个、一分为 X 多掰出的 X-1 份共用它）。'
      + '⚠ 缺了的话账上那份好处就变成了**白送**，而"白送"和"没计价"在账面上看不出来 ——'
      + `所以这里必须说一句。兜底用的是代码里那个 ${String(DEFAULT_MODIFIER_RATES[MODIFIER_EXTRA_COPY_KEY])} 点。`))
  }

  /*
   * ---- 「等待 X 秒」的汇率（2026-09-30 日志 52）----
   *
   * ⚠ 和上面那条同一个理由，**符号相反**：它是"每一秒等待提供多少额度"。
   *   缺了 / 写成 0 的话，等待那一段的价**一笔都不记** ——
   *   而"没计价"和"这份代价白送"在合计上是同一个数（玩家会看到
   *   "空出 3 秒不花我什么"，然后把它当成免费的时间轴调节器）。
   *   ⚠ 为什么是**警告**不是错误：代码里有兜底值（0.6），不至于算不出账，
   *     但玩家必须知道"我改的这个数没生效"。
   */
  const waitRate = balance.modifierRates?.[MODIFIER_WAIT_SECOND_KEY]
  if (!isNum(waitRate) || waitRate <= 0) {
    out.push(warn('BAD_BALANCE', `modifierRates.${MODIFIER_WAIT_SECOND_KEY}`,
      `「等待 X 秒」的汇率没写对，现在是 ${JSON.stringify(waitRate)}`,
      '它是"**每一秒等待**提供多少额度"（正数 = 提供额度：空出一段时间是代价）。'
      + '⚠ 缺了的话那一段空档就变成了**白送**，而"白送"和"没计价"在账面上看不出来 ——'
      + `所以这里必须说一句。兜底用的是代码里那个 ${String(DEFAULT_MODIFIER_RATES[MODIFIER_WAIT_SECOND_KEY])} 点/秒。`))
  }

  /*
   * ⚠ ---- **「排布」的三条汇率**（2026-09-30 日志 53）----
   *
   *   和上面两条同一个理由：缺了就会**静默地**回落到代码里那份兜底
   *   （0.8 / 0.1 / 0.005）—— 而"我调了 balance.json 但它没生效"
   *   和"这一项就是这么便宜"在账面上长得一模一样。
   *
   *   ⚠ 底价和两个增量分三条键（不是一条），因为它们**各自可调**：
   *     玩家可能只想让"半径"更贵、不想动"角度" —— 合成一条就调不了。
   *
   *   ⚠ 这里**允许 0**（`>= 0`）：把"每米"或"每度"调成 0 是一个合法的取舍
   *     （"半径不要钱"），和 `stackPenaltyPerPoint` 那条同一个道理 ——
   *     写成 `> 0` 的话，调成 0 会被静默当成"没写"然后回落到兜底值。
   *     ⚠ 但**底价不许是 0**：0 就是"这个零件不要钱"，而那和"没计价"同形。
   */
  for (const [key, label, min] of [
    [MODIFIER_LAYOUT_BASE_KEY, '装上「排布」这个零件的底价', 1e-9],
    [MODIFIER_LAYOUT_METER_KEY, '「排布」每米半径的价钱', 0],
    [MODIFIER_LAYOUT_DEGREE_KEY, '「排布」每度的价钱', 0],
  ] as const) {
    const v = balance.modifierRates?.[key]
    if (!isNum(v) || v < min) {
      out.push(warn('BAD_BALANCE', `modifierRates.${key}`,
        `「排布」的汇率 ${key} 没写对，现在是 ${JSON.stringify(v)}`,
        `它是"${label}"（${min > 0 ? '正数' : '>= 0'}）。`
        + '⚠ 缺了的话就会**静默地**用代码里那份兜底，而"我改了它没生效"'
        + '和"这一项本来就是这个价"在账面上看不出来。'
        + `兜底用的是 ${String(DEFAULT_MODIFIER_RATES[key])}。`))
    }
  }

  /*
   * ⚠ ---- **「追踪」的三条汇率**（2026-09-30 日志 56）----
   *
   *   和上面两条同一个理由：缺了就会**静默地**回落到代码里那份兜底
   *   （1.2 / 0.05 / 0.05）—— 而"我调了 balance.json 但它没生效"
   *   和"这一项就是这么便宜"在账面上长得一模一样。
   *
   *   ⚠ **底价不许是 0**（0 就是"这个零件不要钱"，那和"没计价"同形）；
   *     两个增量**允许 0**（"搜索距离不要钱"/"转速不要钱"是合法的取舍）——
   *     和「排布」那三条同一套判据。
   */
  for (const [key, label, min] of [
    [MODIFIER_HOMING_BASE_KEY, '装上「追踪」这个零件的底价', 1e-9],
    [MODIFIER_HOMING_METER_KEY, '「追踪」每米搜索距离的价钱', 0],
    [MODIFIER_HOMING_DEGREE_KEY, '「追踪」每度转速的价钱', 0],
  ] as const) {
    const v = balance.modifierRates?.[key]
    if (!isNum(v) || v < min) {
      out.push(warn('BAD_BALANCE', `modifierRates.${key}`,
        `「追踪」的汇率 ${key} 没写对，现在是 ${JSON.stringify(v)}`,
        `它是"${label}"（${min > 0 ? '正数' : '>= 0'}）。`
        + '⚠ 缺了的话就会**静默地**用代码里那份兜底，而"我改了它没生效"'
        + '和"这一项本来就是这个价"在账面上看不出来。'
        + `兜底用的是 ${String(DEFAULT_MODIFIER_RATES[key])}。`))
    }
  }

  /*
   * ⚠ ---- **「弹射」的三条汇率**（2026-09-30 日志 58）----
   *
   *   和上面三条同一套判据、同一个理由（缺了就**静默**回落到代码兜底：
   *   1.2 / 0.7 / 0.8）。
   *
   *   ⚠ **底价不许是 0**（0 = "这个零件不要钱"，和"没计价"同形）；
   *     另外两条**允许 0**（"多弹几次不要钱"/"不衰减不要钱"是合法的取舍 ——
   *     后者甚至是这一片给"全衰减"那一档的默认形态）。
   */
  for (const [key, label, min] of [
    [MODIFIER_BOUNCE_BASE_KEY, '装上「弹射」这个零件的底价', 1e-9],
    [MODIFIER_BOUNCE_TIMES_KEY, '「弹射」每多弹一次的价钱', 0],
    [MODIFIER_BOUNCE_FALLOFF_RATE_KEY, '「弹射」衰减每少一点的价钱', 0],
  ] as const) {
    const v = balance.modifierRates?.[key]
    if (!isNum(v) || v < min) {
      out.push(warn('BAD_BALANCE', `modifierRates.${key}`,
        `「弹射」的汇率 ${key} 没写对，现在是 ${JSON.stringify(v)}`,
        `它是"${label}"（${min > 0 ? '正数' : '>= 0'}）。`
        + '⚠ 缺了的话就会**静默地**用代码里那份兜底，而"我改了它没生效"'
        + '和"这一项本来就是这个价"在账面上看不出来。'
        + `兜底用的是 ${String(DEFAULT_MODIFIER_RATES[key])}。`
        + '⚠⚠ **这几个数一律"待玩家签字"**（日志 58 第 3 节），'
        + '而且**这一片没有为任何配平容差压低它们** ——'
        + '容差已经删掉了（日志 57），教训写在 `balance.json` 的 '
        + '`_lesson_toleranceLoweredRates` 那一条里。'))
    }
  }

  /*
   * ⚠ ---- **查表定价的档位表**（2026-09-30 日志 59）----
   *
   *   机制（`readTierTable` / `tierOf`）住在 `pricing.ts`，数据住在这一栏。
   *   这里查的是"**这张表还能不能当表用**"——三条，全是**错误**（不是警告）：
   *
   *     1. 表**不在**（`tierTables.phaseDurationPoints` 没了）：查表定价当场退回
   *        代码兜底那一份（`DEFAULT_TIER_TABLES`）—— 于是"玩家改数据"这个动作
   *        **完全没生效**，而账上一分钱都看不出来。这正是本项目的头号病。
   *     2. **中性档（1×）不等于 0**：中性档 = 这个技能自己的出厂值，
   *        它必须 0 点。不是 0 的话"出厂全 0"（宗旨）当场破，
   *        而且是**静默**破：每一份出厂内容的账都会带上那一笔。
   *     3. **值不是整数**：用户 2026-09-30（日志 57）把账定成了整数
   *        （"点数之和大于 0 就能用"）。表里一个 2.5 会顺着整数化那一层
   *        变成"看它和同一本账里别的条目怎么分格"—— 那就不是"挨个填值"了。
   *
   *   ⚠ 为什么不要一条"0 档必须比 9× 档贵"的检查：**它已经有一条断言在钉**
   *     （`tests/pricing.ts` 的档位那一节），而且它是**定价取舍**，
   *     不是数据形状错误 —— 把它写成校验器错误会在玩家真的想试
   *     "0 档便宜一点"的时候挡住他。表里那一行旁边写着"待用户签字"。
   */
  {
    const raw = balance.tierTables?.[TIER_TABLE_PHASE_DURATION]
    const table = readTierTable(raw, TIER_TABLE_PHASE_DURATION)
    if (raw === undefined || table === undefined) {
      out.push(err('TIER_TABLE_MISSING', `tierTables.${TIER_TABLE_PHASE_DURATION}`,
        `查表定价的档位表不见了（现在是 ${JSON.stringify(raw)}）`,
        '阶段时长那一档的价是**查表**查出来的（`档位 → 整数点数`）：'
        + '`0`（取消这一段）/ `1`（出厂本身，中性档）/ `3` / `9`。'
        + '⚠ 缺了的话会**静默地**用代码里那份兜底，也就是"你改的数据没生效"。'))
    } else {
      const neutral = table.rows.find(r => r.tier === TIER_NEUTRAL)
      if (neutral === undefined || neutral.points !== 0) {
        out.push(err('TIER_TABLE_NEUTRAL_NOT_ZERO',
          `tierTables.${TIER_TABLE_PHASE_DURATION}.${TIER_NEUTRAL}`,
          `中性档（${TIER_NEUTRAL}×，= 这个技能自己的出厂时长）现在是 `
          + `${neutral === undefined ? '没有这一行' : String(neutral.points)}，必须是 0`,
          '账算的是"你改了多少"：出厂值自己减自己 = 0 点，这就是"出厂全 0"的地基。'
          + '⚠ 这一行不是价格，是**定义** —— 想调价请调 0 / 3 / 9 那三档。'))
      }
      for (const r of table.rows) {
        if (!Number.isInteger(r.points)) {
          out.push(err('TIER_TABLE_NOT_INTEGER',
            `tierTables.${TIER_TABLE_PHASE_DURATION}.${r.tier}`,
            `档位 ${r.tier}× 的价是 ${r.points}，不是整数`,
            '用户 2026-09-30 定的口径：账上每一笔都是**整数**（日志 57）。'
            + '查表定价就是"**挨个填一个整数点数**" —— 小数会让整数化那一层'
            + '把它和同一本账里别的条目一起分格，看不见也说不清。'))
        }
      }
      if (table.rows.length === 0) {
        out.push(err('TIER_TABLE_MISSING', `tierTables.${TIER_TABLE_PHASE_DURATION}`,
          '档位表是空的（一行都没有）',
          '至少要有一行：`1`（中性档 = 出厂本身，值必须是 0）。'))
      }
      /*
       * ⚠ ---- **按技能覆盖**那一栏（2026-09-30 日志 63）----
       *
       *   覆盖是这一片新加的结构（用户要的"共享四格默认 + 允许按技能覆盖"）。
       *   它比共享那四格**更容易写坏**，而且坏了是**静默**的：
       *     · 覆盖里把 `1`（中性档）写成非 0 ⇒ 那一个技能的**每一样出厂内容**
       *       都带上那一笔，"出厂全 0"（宗旨）当场破，而账上看起来很正常；
       *     · 覆盖里写小数 ⇒ 违背"挨个填一个整数"（和共享那一栏同一个理由）。
       *
       *   ⚠ 只查**覆盖里真的写了的那几档**：没写的档位走共享那四格，
       *     它们的合法性由上面那两条查过了。
       */
      for (const [skillId, rows] of Object.entries(table.bySkill ?? {})) {
        const overNeutral = rows.find(r => r.tier === TIER_NEUTRAL)
        if (overNeutral !== undefined && overNeutral.points !== 0) {
          out.push(err('TIER_TABLE_NEUTRAL_NOT_ZERO',
            `tierTables.${TIER_TABLE_PHASE_DURATION}.${TIER_BY_SKILL_KEY}.${skillId}.${TIER_NEUTRAL}`,
            `「${skillId}」的覆盖里，中性档（${TIER_NEUTRAL}×）写的是 ${String(overNeutral.points)}，必须是 0`,
            '中性档 = 这个技能自己的出厂时长 ⇒ 出厂值自己减自己 = 0。'
            + '⚠ 覆盖里写一个非 0 的中性档，等于给这一个技能的**每一样出厂内容**'
            + '都加了一笔 —— "出厂全 0"当场破，而且账上**不会报任何别的问题**。'
            + '想调价请调 0 / 3 / 9 那三档。'))
        }
        for (const r of rows) {
          if (Number.isInteger(r.points)) continue
          out.push(err('TIER_TABLE_NOT_INTEGER',
            `tierTables.${TIER_TABLE_PHASE_DURATION}.${TIER_BY_SKILL_KEY}.${skillId}.${r.tier}`,
            `「${skillId}」的覆盖里，档位 ${r.tier}× 的价是 ${r.points}，不是整数`,
            '用户 2026-09-30 定的口径：账上每一笔都是**整数**（日志 57）。'
            + '覆盖和共享那四格是同一种东西（挨个填的整数），所以判据一样。'))
        }
      }
    }
  }

  /*
   * ⚠ ---- **全量点表**（2026-09-30 日志 60b 第 ② 条）----
   *
   *   用户原话：
   *   > 同一个变量的表项全部相等 → 报警（= 那个旋钮在账上是死的）
   *
   *   表的三条校验里只有这一条**只看表本身**；① 表外取值住在
   *   `validateSkill`（那份技能自己那一份），③ 覆盖住在命令行那一侧
   *   （`checkLookupCoverage`，它要一次看见全部内容）。
   */
  out.push(...checkLookupTable(balance.lookupTable))

  return out
}

// ============================================================================
//  全量点表（`balance.json` 的 `lookupTable`）—— 2026-09-30 日志 60b
// ============================================================================
//
//  表本身是**用户签的字**（玩家改不了，只能选取值）——所以这里一条"数值合不合理"
//  都不判，只判**它能不能当表用**，以及**它有没有把内容盖住**。

/**
 * 第 ② 条：**同一个变量的表项全部相等 ⇒ 那个旋钮在账上是死的**（警告）。
 *
 * 为什么值得出声 —— 它正是本项目当年删掉手写 `points` 的那个病的同一张脸：
 * **玩家能动它，而账上一个数都不动**（用户原话："= 那个旋钮在账上是死的"）。
 *
 * ⚠ 出厂内容里有 **93 个**（全是"整行 0"），和 60a §8.6 那个数逐位相同 ——
 *   它们是**已知的**（射程/宽度/投射物速度/占用施法者……今天不参与定价），
 *   所以这是**警告**不是错误：要不要给它们定价是用户的事（60a §8.6 待裁定）。
 * ⚠ 表不在（`lookupTable` 整栏没了）**也是警告**：那时账会**静默地**退回老公式
 *   （公式定价 ≠ 用户规格"查表 + 相加"），而"我改了表没生效"和
 *   "这一项本来就是这个价"在账面上长得一模一样 —— 这正是本项目最恨的那类话。
 */
export function checkLookupTable(raw: unknown): Issue[] {
  const out: Issue[] = []
  const table = readLookupTable(raw)
  if (table === undefined) {
    out.push(warn('LOOKUP_TABLE_MISSING', 'lookupTable',
      '全量点表不见了（`balance.json` 里没有 `lookupTable` 这一栏，或者它是空的）',
      '用户 2026-09-30 定的规格是"**一个技能的所有变量的取值对应点数的和**'
      + '（即线性叠加）就是最终的技能点数" —— 那张表就是它的全部依据。'
      + '⚠ 缺了的话技能的点数会**静默地**退回老公式（`pricing.ts` 的 `ledgerEntries`），'
      + '也就是"你签的那张表一个字都没生效"。'))
    return out
  }
  for (const [partition, variables] of Object.entries(table)) {
    for (const [variable, row] of Object.entries(variables)) {
      const cells = Object.entries(row)
      if (cells.length === 0) continue
      const first = cells[0]?.[1]
      if (!cells.every(([, points]) => points === first)) continue
      out.push(warn('LOOKUP_DEAD_KNOB', `${partition}.${variable}`,
        `「${partition}」的 ${variable}：表里每一档都是 ${String(first)} 点 —— 这个旋钮在账上是死的`,
        '玩家能动它，而点数一个数都不动（"改了数值、点数纹丝不动"是同一个病）。'
        + '要么给它定价（把格子填成不同的数），要么承认它不参与定价 —— '
        + '⚠ **这个数是用户签的字**（`balance.json` 的 `lookupTable`），代码这边不许改它。'))
    }
  }
  return out
}

/**
 * 第 ③ 条：**表必须覆盖内容里出现的每个技能 / 每个变量**（跨文件，命令行调用）。
 *
 * ⚠ 和 ① 的分工（两条都在管"覆盖"，但看的东西不一样，**不要重复报**）：
 *   · ① **取值**覆盖（"内容里这个数在不在表里"）住在 `validateSkill`：
 *     它对**每一份技能文件**都跑一遍，所以出厂内容里出现的每一个取值都被查过；
 *   · ③（本函数）管**结构**覆盖：内容里有这个**技能**（分区在不在）、
 *     内容里有这**一段**（`@打断等级.N` / `@占用施法者.N` 在不在）。
 *   少了 ③ 的话，"新增一份技能、忘了进表"会**静默地**退回老公式
 *   （① 查不出来：没有分区 ⇒ 一个变量都枚举不到 ⇒ 一条错都不报）。
 *
 * ⚠ 变体（`basedOn`）对着**它的模板**查 —— 和账的口径逐字相同
 *   （`skillLedger` 按基础技能取分区）。模板不在内容表里（合成探针）就跳过：
 *   那时没有基准可比，而"跳过"和"没问题"在这一条上要靠 ① 兜住。
 */
export function checkLookupCoverage(skills: readonly Skill[], balance: BalanceConfig): Issue[] {
  const table = readLookupTable(balance.lookupTable)
  // ⚠ 表整个不在时这里一条都不报：那是 `checkLookupTable` 的活（它已经在 balance 那一栏说过了）
  if (table === undefined) return []
  const byId = new Map(skills.map(s => [s.id, s]))
  const out: Issue[] = []
  for (const skill of skills) {
    const base = skill.basedOn !== undefined ? byId.get(skill.basedOn) : skill
    if (skill.basedOn !== undefined && base === undefined) continue
    const baseId = base?.id ?? skill.id
    const partition = table[baseId]
    if (partition === undefined) {
      out.push(err('LOOKUP_SKILL_NOT_IN_TABLE', skill.id,
        `全文点表里没有「${baseId}」这个技能的分区`,
        '账按表算：**表里没有它 ⇒ 它的点数会静默地退回老公式**，'
        + '而"老公式算出来的数"和"用户签字的那张表的和"是两个不同的数。'
        + '请把这份技能（以及它每一个变量、每一个取值）补进 '
        + '`content/balance.json` 的 `lookupTable`。'))
      continue
    }
    /*
     * ⚠ **内容里有几段，表里就得有对应的两个 `@` 键**。
     *   这两个键是"编辑器真的画出来的控件"里唯一**跟着阶段数变**的 ——
     *   加一段（内容是手写的，编辑器没有这个控件）而忘了进表，
     *   那一段的打断等级 / 占用施法者就**没有任何一格**：静默地不参与定价。
     */
    for (let i = 0; i < skill.phases.length; i++) {
      for (const variable of [`@打断等级.${String(i)}`, `@占用施法者.${String(i)}`]) {
        if (partition[variable] !== undefined) continue
        out.push(err('LOOKUP_VARIABLE_MISSING', variable,
          `内容里有第 ${String(i)} 段，而表里没有「${variable}」这个变量`,
          '这两个变量是**跟着阶段数变**的（每一段一对）。'
          + '⚠ 少了它，那一段的打断等级 / 占用施法者在账上就**没有格子** ——'
          + '不报错、也不计价（"没计价"和"免费"在合计上是同一个数）。'))
      }
    }
  }
  return out
}

// ============================================================================
//  11. 修饰技能的原型（`content/modifiers/*.json`）
// ============================================================================
//
//  ⚠ 这一节**只校验原型**（出厂零件）。副本（`SequenceSegment.mods`）的规矩
//    和术式绑在一起（"不叠同类"、"常驻包装只能进 auto 术式"），所以它们在
//    `validator/index.ts` 里、和术式一起查 —— 那也是它们唯一能被看见的地方。

/**
 * 修饰技能原型的合法机制。⚠ 和 `ModifierKind` 那个联合类型**必须一起改**
 *   （和 `TRIGGERS` / `CONDITION_TYPES` 同一套约定：表的唯一真相在这边）。
 */
const MODIFIER_KINDS: readonly string[] = [
  'trigger', 'monitor', 'wrap', 'multi', 'split', 'wait', 'layout', 'homing', 'bounce',
]

/** 生成位置的四个取值。⚠ 和 `TriggerOrigin` 一起改 */
const TRIGGER_ORIGINS: readonly string[] = ['caster', 'aim', 'prevHitPoint', 'prevEndPoint']

/** `wrap` 能改的那一条性质。⚠ 和 `WrapEffect` 一起改 */
const WRAP_EFFECTS: readonly string[] = ['persistent']

/**
 * 引擎会读的参数键。触发器 / 监测器**共用同一个执行器**，所以键名也共用
 * （见 schema 的 `ModifierProto.params` 那段"两份会漂移"的警告）。
 *
 * ⚠⚠ **2026-09-30（日志 54）：`condition` 从"必填三键"里拿掉了** ——
 *   它现在是**原型上可选**的，并且**日志 55 起"不写"有了真实语义**：
 *   玩家点名的默认条件是「**载体（前一个技能）消失**」（Noita 那种**引信**），
 *   它要的时机（`onExpire` / `onRemoved`）日志 55 **接上线了**
 *   （`sim/trigger.ts` 的 `sweepCarriersGone`）。
 *
 *   ⇒ 分工是：**原型可以不写**（它只是一份模板，自己不会触发），
 *     **副本也可以不写**（那就是"载体消失"这条默认值）。
 *     ⚠ 原型 / 副本写着 `{}` **照样要拦**（`MODIFIER_EMPTY_CONDITION`）——
 *     那不是"没写"，是一个明确的"**永不通过**"，出厂零件原来就是这么坏掉的。
 *   ⚠ 其余三个键照旧必填 —— 缺了就会静默换默认值（表现是"这个触发器不按我写的时机走"）。
 */
const TRIGGER_PARAM_KEYS: readonly string[] = ['when', 'crossing', 'origin']

/**
 * **这个触发时机今天真的会触发吗** —— 不接线就说出来（**警告，不是错误**）。
 *
 * ⚠ 为什么是警告不是错误：内容作者**可能只是提前写**（先按设计把 `onHit` 填上、
 *   等引擎接线）。报**错**会把这种写法判死，而"把合理的提前量判死"会让作者
 *   去写一个假的时机（更坏）。但**不能不说** —— 不接线 = 写上去不生效，
 *   而"不生效"是这个项目列为最危险的一类静默失败。
 *
 * ⚠ 判据表**只有一处**：`WIRED_TRIGGER_EVENTS`（`src/sim/trigger.ts`）。
 *   接线了新的时机就改那一张表，原型的检查和副本的检查**自动跟着对**。
 *
 * 两种"永远不会触发"都拦：**不认识的取值**（写错 / 新造事件）
 * 和**认识但没接线**的取值。
 */
export function unwiredTriggerIssue(value: unknown, path: string, what: string): Issue | undefined {
  if (typeof value !== 'string') return undefined
  if (WIRED_TRIGGER_EVENTS.includes(value as TriggerEvent)) return undefined

  const known = TRIGGERS.includes(value)
  /*
   * ⚠⚠ **`onRemoved` 单独说一句**（2026-09-30 日志 55，上级裁定）。
   *
   *   它是**认识但今天不触发**的那一类，可它和 `onHit` / `onMiss` 那种
   *   "引擎还没接线"**不是一回事**：玩家点名的默认值「**载体消失**」在语义上
   *   就是它，而那一档日志 55 已经用 **`onExpire`** 接上了。
   *   ⇒ 让作者看到笼统的"还没接线"会以为要等以后；这里直接给**改写建议**。
   *   ⚠ 反过来说：让它进那张"已接线"的表就是**假的接线**
   *     （写上去不生效**而且不吭声**）—— 那正是这一整轮在清的那类静默失败。
   */
  const removedHint = value === 'onRemoved'
    ? '⚠ `onRemoved` 和 `onExpire` 在今天**是同一个事实**（"这次施法放出去的东西不在世界上了"）：'
    + '引擎里只有 `sweepCarriersGone` 那一处发现它，而那处分不出"自然到期"和"被打掉"。'
    + '⇒ **把它改写成 `onExpire`**（那就是玩家点名的「载体消失」）；'
    + '要真的区分两种下场，得另立一片把"为什么没了"记进台账。'
    : undefined
  return warn('MODIFIER_TRIGGER_NOT_WIRED', path,
    known
      ? `${what}用的是 \`${value}\`，而这个时机**今天不会触发**`
      : `${what}用的是 \`${value}\`，它**不是现成的事件之一**（TriggerEvent），永远不会触发`,
    known
      ? (removedHint !== undefined
        ? `${removedHint}\n`
        : '⚠ 引擎里还没有一个地方知道该在什么时候调它'
          + '（`onExpire` 要"状态失效的那一刻"、`onHit` 要"这一次命中是谁打的"）。')
      + `今天真的接了线的只有：${WIRED_TRIGGER_EVENTS.join(' / ')}。`
      + '⚠ 其余时机**写上去不报错也不生效** —— 这不是"没实现"，是**待办**；'
      + '接线之后 `WIRED_TRIGGER_EVENTS` 那张表一改，这里自动放行。'
      : `合法取值：${TRIGGERS.join(' / ')}。`
      + '⚠ 玩家明说了**不要新造事件** —— 触发器 / 监测器的条件来源就是这张表。')
}

/**
 * 校验一个修饰原型。
 *
 * ⚠ **为什么原型也要校验**（它明明是出厂内容、我们自己在写）：
 *   因为 `paramsTemplate`（给人看的旋钮）和 `params`（引擎真的读的值）
 *   是**两份**，而它们会漂移 —— 漂移的表现是静默的：
 *   副本从模板填出参数、引擎读不到 `when`，于是**这个触发器永远不触发**。
 *   出厂内容写错一次，玩家那边就是"我装了个修饰技能，什么都没发生"。
 */
export function validateModifierProto(proto: ModifierProto): Issue[] {
  const out: Issue[] = []

  if (typeof proto.id !== 'string' || proto.id.length === 0) {
    out.push(err('MODIFIER_PROTO_NO_ID', 'id', '修饰原型缺少 id'))
  }
  if (typeof proto.name !== 'string' || proto.name.length === 0) {
    out.push(err('MODIFIER_PROTO_NO_NAME', 'name', '修饰原型缺少 name'))
  }
  if (typeof proto.schemaVersion !== 'number') {
    out.push(err('BAD_SCHEMA_VERSION', 'schemaVersion', 'schemaVersion 必须是数字'))
  }

  if (!MODIFIER_KINDS.includes(proto.kind)) {
    out.push(err('BAD_ENUM', 'kind',
      `kind 只能是 ${MODIFIER_KINDS.join(' / ')}，现在是 ${JSON.stringify(proto.kind)}`,
      '修饰技能不分类（参数异构），但引擎必须知道按哪套规矩执行它 —— '
      + '`kind` 说的是这个，不是玩法分类。'))
    // 取值不认识就没有下一步可查了 —— 再查下去只会报一堆连带的错
    return out
  }

  const params = proto.params

  if (proto.kind === 'wrap') {
    const eff = params?.['effect']
    if (typeof eff !== 'string' || !WRAP_EFFECTS.includes(eff)) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', 'params.effect',
        `wrap 的 params.effect 只能是 ${WRAP_EFFECTS.join(' / ')}，现在是 ${JSON.stringify(eff)}`,
        '⚠ 引擎读的是 `params`，不是 `paramsTemplate`（模板只是给编辑器看的形状）。'
        + '两份漂移的表现是"这个包装装上去什么都没发生"。'))
    }
    return out
  }

  // ---- multi / split（份数类，2026-09-21 日志 51）----
  /*
   * ⚠ 引擎读的是**两个键**：`count`（默认几份）+ `max`（上限）。
   *   把 `max` 也放在原型里（而不是写死在代码里）是玩家那句话的直译：
   *   "N 可调、默认 2、**上限** 10"、"X 可调、默认 2、**上限默认** 4" ——
   *   后面那个"默认"说的就是**上限本身也是一个可调的值**。
   *   ⇒ 所以"上限是多少"必须能不改代码就改，校验器只盯形状。
   */
  if (proto.kind === 'multi' || proto.kind === 'split') {
    const count = params?.[MODIFIER_COUNT_KEY]
    const max = params?.[MODIFIER_MAX_KEY]

    if (!Number.isInteger(count) || (count as number) < MODIFIER_COUNT_MIN) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_COUNT_KEY}`,
        `${proto.kind} 原型缺少引擎要读的参数 \`${MODIFIER_COUNT_KEY}\`（默认几份，${MODIFIER_COUNT_MIN} 起），`
        + `现在是 ${JSON.stringify(count)}`,
        '⚠ 1 份 = 没有这个修饰 —— 它在数据上不该存在（"花了份数的钱、买了零份的好处"）。'
        + '⚠ 只写在 `paramsTemplate` 里是不够的：引擎看的是 `params`。'))
    } else if (Number.isInteger(max) && (count as number) > (max as number)) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_COUNT_KEY}`,
        `默认的 ${MODIFIER_COUNT_KEY}（${String(count)}）比它自己的上限 ${MODIFIER_MAX_KEY}（${String(max)}）还大`,
        '默认值超上限的话，玩家一拖进序列就得到一个**已经被夹过**的份数 ——'
        + '夹的动作是静默的，所以这里当场拦住。'))
    }

    if (!Number.isInteger(max) || (max as number) < MODIFIER_COUNT_MIN) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_MAX_KEY}`,
        `${proto.kind} 原型缺少上限 \`${MODIFIER_MAX_KEY}\`（这个动词最多几份），`
        + `现在是 ${JSON.stringify(max)}`,
        '⚠ 上限**住在原型里**（数据），不是代码里的常数 —— 玩家要能改"最多几份"而不用改代码。'
        + `今天玩家给的两个数是：多重释放 ${MODIFIER_MAX_FALLBACK.multi} / 一分为 X ${MODIFIER_MAX_FALLBACK.split}。`))
    }

    return out
  }

  // ---- wait（「等待 X 秒」，2026-09-30 日志 52）----
  /*
   * ⚠ 引擎读的是**五个键**：`seconds`（默认等多久）+ `min` / `max`（范围）
   *   + `locks`（锁哪些能力）+ `interrupt`（能不能被打断）。
   *
   *   为什么范围也住在原型里（而不是写死在代码里）：
   *     玩家定的是"**0.2 ~ 3 秒**"，而"最长能等多久"是**内容侧的旋钮** ——
   *     和份数那个 `max` 是同一条规矩（改它不用改代码）。
   *     ⚠ 下限 0.2 那一头玩家说死了（不像上限那样说"默认"），
   *     所以代码里也有一份 `MODIFIER_SECONDS_MIN` 兜底，两边**必须一致**
   *     （不一致时下面会报错，不让它静默地以哪一边为准）。
   */
  if (proto.kind === 'wait') {
    const seconds = params?.[MODIFIER_SECONDS_KEY]
    const min = params?.[MODIFIER_SECONDS_MIN_KEY]
    const max = params?.[MODIFIER_SECONDS_MAX_KEY]

    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_SECONDS_KEY}`,
        `wait 原型缺少引擎要读的参数 \`${MODIFIER_SECONDS_KEY}\`（默认等多久），`
        + `现在是 ${JSON.stringify(seconds)}`,
        '⚠ 引擎看的是 `params`，不是 `paramsTemplate`（模板只是给编辑器看的形状）。'
        + '两份漂移的表现是"这个零件拖进序列之后一点都不等"。'))
    } else if (typeof max === 'number' && seconds > max) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_SECONDS_KEY}`,
        `默认的 ${MODIFIER_SECONDS_KEY}（${String(seconds)}）比它自己的上限 ${MODIFIER_SECONDS_MAX_KEY}（${String(max)}）还大`,
        '默认值超上限的话，玩家一拖进序列就得到一个**已经被夹过**的秒数 ——'
        + '夹的动作是静默的，所以这里当场拦住。'))
    } else if (seconds < MODIFIER_SECONDS_MIN) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_SECONDS_KEY}`,
        `默认的 ${MODIFIER_SECONDS_KEY}（${String(seconds)}）比下限 ${String(MODIFIER_SECONDS_MIN)} 还小`,
        '玩家定的范围是 **0.2 ~ 3 秒**：写成 0 就是"没有这一段空档"，那不如把这个零件删掉。'))
    }

    if (typeof max !== 'number' || !Number.isFinite(max)) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_SECONDS_MAX_KEY}`,
        `wait 原型缺少上限 \`${MODIFIER_SECONDS_MAX_KEY}\`（最长能等多久），`
        + `现在是 ${JSON.stringify(max)}`,
        '⚠ 上限**住在原型里**（数据），不是代码里的常数 —— 玩家要能改"最长等多久"而不用改代码。'
        + '玩家给的是 3 秒。'))
    } else if (max < MODIFIER_SECONDS_MIN) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_SECONDS_MAX_KEY}`,
        `上限 ${String(max)} 比下限 ${String(MODIFIER_SECONDS_MIN)} 还小 —— 这是个空区间`,
        '⚠ 夹取（`Math.min(max, Math.max(min, …))`）会静默地把**每一次**等待都变成那个上限，'
        + '而"我写了 1.5 秒，它只等 0.1 秒"在界面上看不出是为什么。'))
    }

    if (typeof min !== 'number' || !Number.isFinite(min)) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_SECONDS_MIN_KEY}`,
        `wait 原型缺少下限 \`${MODIFIER_SECONDS_MIN_KEY}\`，现在是 ${JSON.stringify(min)}`,
        `玩家定的下限是 **${String(MODIFIER_SECONDS_MIN)} 秒**（两头闭区间）。`
        + '⚠ 它写在数据里是为了让人一眼看到那个数 —— 真正的下限在代码里（`MODIFIER_SECONDS_MIN`），'
        + '两者不一致会报错，不会静默地以某一边为准。'))
    } else if (min !== MODIFIER_SECONDS_MIN) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_SECONDS_MIN_KEY}`,
        `下限写的是 ${String(min)}，而玩家定的是 **${String(MODIFIER_SECONDS_MIN)} 秒**`,
        '⚠ 下限这一头玩家**说死了**（不像上限那样说"默认"）—— 所以这里比对是**相等**，'
        + '不是">="。要改下限是一条要玩家点头的设计改动，不是随手调一个数。'))
    }

    const locks = params?.[MODIFIER_LOCKS_KEY]
    if (!Array.isArray(locks)) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_LOCKS_KEY}`,
        `wait 原型缺少 \`${MODIFIER_LOCKS_KEY}\`（这 X 秒里锁住哪些能力，一个数组），`
        + `现在是 ${JSON.stringify(locks)}`,
        '⚠ 玩家定的：**"锁哪些能力"是这个零件的参数**，但 ⚠⚠ **2026-09-30（日志 54）'
        + '从"四项可勾"收窄到 `move` / `turn` 两项** —— 施法和攻击是**引擎硬规矩**'
        + '（同一个人同一时刻只有一段施法），不由零件配。'))
    } else {
      for (const v of locks) {
        /*
         * ⚠ 顺序和 `validator/index.ts` 里那一条**必须一致**（日志 54）：
         *   先报"引擎保留值"（硬规矩，不是拼错了），再报"认不出的值"。
         */
        if (typeof v === 'string' && MODIFIER_LOCK_ENGINE_RESERVED.includes(v)) {
          out.push(err('MODIFIER_LOCK_ENGINE_RESERVED', `params.${MODIFIER_LOCKS_KEY}`,
            `\`${v}\` 不许写进 \`${MODIFIER_LOCKS_KEY}\` —— `
            + '**施法独占是引擎硬规矩，不是可配项**',
            '玩家 2026-09-30 定的（原话："玩家又没有第二人格"）：'
            + '**同一个施法者，同一时刻只能有一个进行中的施法**，由引擎强制'
            + '（`canActivate` ⇒ `busy`），**和锁没锁它无关**。'
            + '⚠ 武器攻击也是绑在左键上的术式 ⇒ `attack` 一样被挡着。'
            + `能配的只剩 ${MODIFIER_LOCK_VALUES.join(' / ')}。`))
          continue
        }
        if (typeof v !== 'string' || !MODIFIER_LOCK_VALUES.includes(v)) {
          out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_LOCKS_KEY}`,
            `锁的取值只能是 ${MODIFIER_LOCK_VALUES.join(' / ')}，现在是 ${JSON.stringify(v)}`,
            '它正好是引擎 `Capability` 里**还能配的那两项**'
            + `（\`${MODIFIER_LOCK_ENGINE_RESERVED.join('\` / \`')}\` 是引擎硬规矩，`
            + '报的是另一条 `MODIFIER_LOCK_ENGINE_RESERVED`）。'))
        }
      }
    }

    const interrupt = params?.[MODIFIER_INTERRUPT_KEY]
    if (typeof interrupt !== 'string' || !MODIFIER_INTERRUPT_VALUES.includes(interrupt)) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_INTERRUPT_KEY}`,
        `打断档只能是 ${MODIFIER_INTERRUPT_VALUES.join(' / ')}，现在是 ${JSON.stringify(interrupt)}`,
        '⚠ 玩家定的默认是 **`none`（不可打断）** —— 可打断会让"晚 X 秒"当场消失、'
        + '后面那个技能反而**提前**打出来（那不是打断，是把排好的序列顺序改掉了）。'
        + '要和引擎那三档用**同一套取值**（`InterruptLevel`），别在这里新造一个。'))
    }

    return out
  }

  /*
   * ---- 「排布」（日志 53）----
   *
   * ⚠ 和上面那三档的**共同形状**：引擎读的键必须写在 `params` 里
   *   （只写在 `paramsTemplate` 里等于没写 —— 那是给编辑器看的形状）。
   *   而 `layout` 的键**全都带默认值**（缺了也有兜底），所以这里**不报缺键**，
   *   只报"写了但写歪了" —— 那才是会造成静默坏行为的写法
   *   （半径夹住 = 玩家写了 99 米却只摆了 6 米；`even` 写成 1 = 我关掉了均匀分布它却按均匀排）。
   */
  if (proto.kind === 'layout') {
    const type = params?.[MODIFIER_LAYOUT_TYPE_KEY]
    if (typeof type !== 'string' || !MODIFIER_LAYOUT_MODES.includes(type)) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_LAYOUT_TYPE_KEY}`,
        `排布的 \`${MODIFIER_LAYOUT_TYPE_KEY}\` 只能是 ${MODIFIER_LAYOUT_MODES.join(' / ')}，`
        + `现在是 ${JSON.stringify(type)}`,
        '玩家定的：**一个零件、编辑时选类型**（环绕生成 / 扇形散射 / 反向镜像）。'
        + '⚠ 认不出的取值**不许猜**：引擎那一侧会整块不生效（`modifierLayoutModeOf` 返回 undefined），'
        + '因为"我选了反向镜像，它给我排了个圈"不是兜底，是静默改语义。'))
    }

    const minR = params?.[MODIFIER_LAYOUT_MIN_RADIUS_KEY]
    const maxR = params?.[MODIFIER_LAYOUT_MAX_RADIUS_KEY]
    if (typeof minR !== 'number' || !Number.isFinite(minR)) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_LAYOUT_MIN_RADIUS_KEY}`,
        `排布原型缺少半径下限 \`${MODIFIER_LAYOUT_MIN_RADIUS_KEY}\`（米），现在是 ${JSON.stringify(minR)}`,
        '⚠ 写成 0 就是"全都堆在施法者身上"，那还不如不要这个零件。'
        + `代码里那份兜底是 ${String(MODIFIER_LAYOUT_RADIUS_MIN)} 米（\`MODIFIER_LAYOUT_RADIUS_MIN\`）。`))
    }
    if (typeof maxR !== 'number' || !Number.isFinite(maxR)) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_LAYOUT_MAX_RADIUS_KEY}`,
        `排布原型缺少半径上限 \`${MODIFIER_LAYOUT_MAX_RADIUS_KEY}\`（米），现在是 ${JSON.stringify(maxR)}`,
        '⚠ 没有上限的话一份手改的 `radius: 9999` 会把那几份摆到地图外面 ——'
        + '表现是"技能放出来了，什么都不打中"，而且无处可查。'))
    } else if (typeof minR === 'number' && maxR < minR) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_LAYOUT_MAX_RADIUS_KEY}`,
        `半径上限 ${String(maxR)} 比下限 ${String(minR)} 还小 —— 这是个空区间`,
        '⚠ 空区间会让夹取静默地把每一次环绕都变成下限那个数。'))
    }
    const radius = params?.[MODIFIER_LAYOUT_RADIUS_KEY]
    if (typeof radius !== 'number' || !Number.isFinite(radius)) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_LAYOUT_RADIUS_KEY}`,
        `排布原型缺少默认半径 \`${MODIFIER_LAYOUT_RADIUS_KEY}\`（米），现在是 ${JSON.stringify(radius)}`))
    } else if (typeof minR === 'number' && typeof maxR === 'number'
      && (radius < minR || radius > maxR)) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_LAYOUT_RADIUS_KEY}`,
        `默认半径 ${String(radius)} 不在它自己的范围 [${String(minR)}, ${String(maxR)}] 里`,
        '⚠ 默认值落在范围外面时，**每一个**没改过这个参数的副本都会被夹一次。'))
    }

    const maxAngle = params?.[MODIFIER_LAYOUT_MAX_ANGLE_KEY]
    if (typeof maxAngle !== 'number' || !Number.isFinite(maxAngle) || maxAngle <= 0) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_LAYOUT_MAX_ANGLE_KEY}`,
        `排布原型缺少角度上限 \`${MODIFIER_LAYOUT_MAX_ANGLE_KEY}\`（度，正数），`
        + `现在是 ${JSON.stringify(maxAngle)}`,
        '⚠ 它管的是"有正负的那两个角"（`startAngle` / `mirrorAngle`，取 ±）。'
        + '没有它的话一份手改的 `startAngle: 1e9` 会绕上几百万圈'
        + '（结果虽然还是落在圈上，但"我写的是多少"和"它摆的是多少"再也对不上）。'))
    }
    const maxSpread = params?.[MODIFIER_LAYOUT_MAX_SPREAD_KEY]
    if (typeof maxSpread !== 'number' || !Number.isFinite(maxSpread) || maxSpread < 0) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_LAYOUT_MAX_SPREAD_KEY}`,
        `排布原型缺少张角上限 \`${MODIFIER_LAYOUT_MAX_SPREAD_KEY}\`（度，>= 0），`
        + `现在是 ${JSON.stringify(maxSpread)}`,
        '⚠ 张角和上面那两个角**分开写**：它只有正的一侧（负张角没有意义）。'))
    }

    for (const key of [
      MODIFIER_LAYOUT_START_KEY, MODIFIER_LAYOUT_SPREAD_KEY, MODIFIER_LAYOUT_MIRROR_KEY,
    ]) {
      const v = params?.[key]
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${key}`,
          `排布的 \`${key}\` 必须是一个有限的数，现在是 ${JSON.stringify(v)}`))
      }
    }
    const even = params?.[MODIFIER_LAYOUT_EVEN_KEY]
    if (typeof even !== 'boolean') {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_LAYOUT_EVEN_KEY}`,
        `排布的 \`${MODIFIER_LAYOUT_EVEN_KEY}\` 必须是 true / false，现在是 ${JSON.stringify(even)}`,
        '玩家原话是"**是否**均匀分布" —— 它是一个开关。'
        + '⚠ 写成 `1` / `"true"` 这种既不是真也不是假的取值时，引擎按默认的"均匀"处理，'
        + '而"我关掉了它却还是均匀排"正是本文件要拦住的那种静默坏行为。'))
    }

    return out
  }

  /*
   * ---- 「追踪」（日志 56）----
   *
   * ⚠ 和「排布」的**共同形状**：引擎读的键必须写在 `params` 里
   *   （只写在 `paramsTemplate` 里等于没写 —— 那是给编辑器看的形状）。
   *   而追踪的两个键**都带默认值**（缺了也有兜底），所以这里**不报缺键**，
   *   只报"写了但写歪了"，以及**四个范围键**（它们才是"夹取"的真相）——
   *   ⚠ 范围写歪了的表现是静默的：`maxRangeCap: 0` 会让每一次索敌都夹成 0 米
   *     （表现是"我装了追踪，它一次都不生效"）。
   *
   * ⚠⚠ **这里一个字都没有"载体"**：追踪对非飞行载体"什么都不做"是**引擎的
   *   代码形状**保证的（非飞行载体根本不走 `spawnProjectileFrom`），
   *   而且玩家明确说了**不许报警告**（"提示由界面画在那条序列下方"）。
   *   ⇒ 校验器**不许**在这里加一条"你把它装在激光上了"的检查 ——
   *     那会把一个"不起作用的修饰"变成一个"错误"，和玩家的规格相反。
   */
  if (proto.kind === 'homing') {
    const turn = params?.[MODIFIER_HOMING_TURN_KEY]
    if (turn !== undefined && (typeof turn !== 'number' || !Number.isFinite(turn))) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_HOMING_TURN_KEY}`,
        `追踪的 \`${MODIFIER_HOMING_TURN_KEY}\`（每 tick 最多转多少度）必须是一个有限的数，`
        + `现在是 ${JSON.stringify(turn)}`,
        '⚠ 写成字符串时**不许静默当默认值**：玩家会看到"我写了 20 度，它按 12 度拐"。'))
    }
    const range = params?.[MODIFIER_HOMING_RANGE_KEY]
    if (range !== undefined && (typeof range !== 'number' || !Number.isFinite(range))) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_HOMING_RANGE_KEY}`,
        `追踪的 \`${MODIFIER_HOMING_RANGE_KEY}\`（索敌距离，米）必须是一个有限的数，`
        + `现在是 ${JSON.stringify(range)}`))
    }

    const minRange = params?.[MODIFIER_HOMING_MIN_RANGE_KEY]
    if (typeof minRange !== 'number' || !Number.isFinite(minRange) || minRange < 0) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_HOMING_MIN_RANGE_KEY}`,
        `追踪原型缺少索敌距离下限 \`${MODIFIER_HOMING_MIN_RANGE_KEY}\`（米，>= 0），`
        + `现在是 ${JSON.stringify(minRange)}`,
        '⚠ 写成 0 就是"只锁已经贴脸的那个"，那还不如不要这个零件。'
        + `代码里那份兜底是 ${String(MODIFIER_HOMING_RANGE_MIN_FALLBACK)} 米。`))
    }
    const maxTurn = params?.[MODIFIER_HOMING_MAX_TURN_KEY]
    if (typeof maxTurn !== 'number' || !Number.isFinite(maxTurn) || maxTurn < MODIFIER_HOMING_TURN_MIN) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_HOMING_MAX_TURN_KEY}`,
        `追踪原型缺少转速上限 \`${MODIFIER_HOMING_MAX_TURN_KEY}\`（度/tick，>= ${String(MODIFIER_HOMING_TURN_MIN)}），`
        + `现在是 ${JSON.stringify(maxTurn)}`,
        '⚠ 没有上限的话一份手改的 `turnRate: 1e9` 会让子弹**一 tick 贴到目标脸上**'
        + '（表现是"我装了追踪，它变成了一发必中的瞬移弹"），而且无处可查。'
        + `代码里那份兜底是 ${String(modifierHomingMaxTurnOf(proto))} 度/tick。`))
    }
    const maxRange = params?.[MODIFIER_HOMING_MAX_RANGE_KEY]
    if (typeof maxRange !== 'number' || !Number.isFinite(maxRange)) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_HOMING_MAX_RANGE_KEY}`,
        `追踪原型缺少索敌距离上限 \`${MODIFIER_HOMING_MAX_RANGE_KEY}\`（米），`
        + `现在是 ${JSON.stringify(maxRange)}`,
        '⚠ 写成很大（比如 100）就是"全图索敌"，那会让"索敌距离"这一整条交易轴**当场失效** ——'
        + '所以上限必须存在。' + `代码里那份兜底是 ${String(modifierHomingMaxRangeOf(proto))} 米。`))
    } else if (typeof minRange === 'number' && maxRange < minRange) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_HOMING_MAX_RANGE_KEY}`,
        `索敌距离上限 ${String(maxRange)} 比下限 ${String(minRange)} 还小 —— 这是个空区间`,
        '⚠ 空区间会让夹取静默地把每一次索敌都变成下限那个数。'))
    }
    if (typeof turn === 'number' && typeof maxTurn === 'number' && turn > maxTurn) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_HOMING_TURN_KEY}`,
        `默认转速 ${String(turn)} 比它自己的上限 ${String(maxTurn)} 还大`,
        '⚠ 默认值超出上限时，**每一个**没改过这个参数的副本都会被夹一次。'))
    }
    if (typeof range === 'number' && typeof maxRange === 'number' && range > maxRange) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_HOMING_RANGE_KEY}`,
        `默认索敌距离 ${String(range)} 比它自己的上限 ${String(maxRange)} 还大`,
        '⚠ 同上：默认值落在范围外面时，**每一个**副本都会被夹一次。'))
    }

    return out
  }

  /*
   * ---- 「弹射」（2026-09-30 日志 58）----
   *
   * ⚠⚠ **这一块里最要紧的是"上限那一半"**：数据的 `maxBouncesCap` 是
   *   **上限的上限**（用户 2026-09-30 裁定的口径 —— 编辑器拿它划滑块范围，
   *   也可以配得更保守；⚠ 但**把上限抬到引擎之上是无效的**，因为引擎取
   *   `min(它, MAX_ACTION_DEPTH)`，`school.ts` 的 `modifierBounceMaxCountOf`）。
   *   玩家原话："**上限必须和 `pipeline` 的深度限制用同一条规矩** ✗
   *   （各写一份迟早出现弹射绕过深度保护 ⇒ 自反馈 ✗）"。
   *   ⇒ 数据写超过 `MODIFIER_BOUNCE_COUNT_MAX`（= 那个深度上限）时**必须报出来**
   *     （不许静默地被夹回去）—— 而这里读的是**同一个常量**，
   *     它就是 `src/limits.ts` 的 `MAX_ACTION_DEPTH`。
   *
   * ⚠ 这一节只校验**原型**（出厂零件）：副本那两个数在 `validator/index.ts` 里查。
   */
  if (proto.kind === 'bounce') {
    const cap = params?.[MODIFIER_BOUNCE_MAX_COUNT_KEY]
    if (typeof cap !== 'number' || !Number.isFinite(cap) || !Number.isInteger(cap)
      || cap < MODIFIER_BOUNCE_COUNT_MIN) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_BOUNCE_MAX_COUNT_KEY}`,
        `弹射原型缺少次数上限 \`${MODIFIER_BOUNCE_MAX_COUNT_KEY}\`（整数，>= ${String(MODIFIER_BOUNCE_COUNT_MIN)}），`
        + `现在是 ${JSON.stringify(cap)}`,
        '⚠ 没有上限的话一份手改的 `maxBounces: 1e9` 会让一次施法**打到天荒地老**'
        + '（弹射链上每一段都是一颗新子弹，`executeAction` 的 `depth` 不会自然累加）。'
        + `代码里那一档是 [${String(MODIFIER_BOUNCE_COUNT_MIN)}, ${String(MODIFIER_BOUNCE_COUNT_MAX)}] 次。`))
    } else if (cap > MODIFIER_BOUNCE_COUNT_MAX) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_BOUNCE_MAX_COUNT_KEY}`,
        `弹射原型的次数上限是 ${String(cap)}，**超过引擎的深度上限 ${String(MODIFIER_BOUNCE_COUNT_MAX)}**`,
        '⚠⚠ 玩家定的："**上限必须和 `pipeline` 的深度限制用同一条规矩**"'
        + '（`src/limits.ts` 的 `MAX_ACTION_DEPTH`）—— 弹射是一条**链**，'
        + '链上每一段都是**一颗新子弹**，`executeAction` 的 `depth` **不会自然累加**，'
        + '所以那个数是这条链**唯一**的刹车。\n'
        + '⚠ 数据这一份**可以调小**（那是"这个零件比引擎允许的更保守"），'
        + '但调大只会被引擎夹回去 —— 而"我写了 9、它只弹 4"必须在这里说出来。'))
    }

    const bounces = params?.[MODIFIER_BOUNCE_COUNT_KEY]
    if (bounces !== undefined && (typeof bounces !== 'number' || !Number.isFinite(bounces))) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_BOUNCE_COUNT_KEY}`,
        `弹射的 \`${MODIFIER_BOUNCE_COUNT_KEY}\`（最多弹几次）必须是一个有限的数，`
        + `现在是 ${JSON.stringify(bounces)}`,
        '⚠ 写成字符串时**不许静默当默认值**：玩家会看到"我写了 3 次，它按 2 次弹"。'))
    } else if (typeof bounces === 'number' && typeof cap === 'number' && bounces > cap) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_BOUNCE_COUNT_KEY}`,
        `默认弹射次数 ${String(bounces)} 比它自己的上限 ${String(cap)} 还大`,
        '⚠ 默认值落在范围外面时，**每一个**没改过这个参数的副本都会被夹一次。'))
    }

    const falloff = params?.[MODIFIER_BOUNCE_FALLOFF_KEY]
    if (falloff !== undefined && (typeof falloff !== 'number' || !Number.isFinite(falloff))) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_BOUNCE_FALLOFF_KEY}`,
        `弹射的 \`${MODIFIER_BOUNCE_FALLOFF_KEY}\`（每次衰减，乘数）必须是一个有限的数，`
        + `现在是 ${JSON.stringify(falloff)}`,
        '⚠ 它是**乘数**（0.7 = 玩家说的"每次 −30%"），不是"减多少"。'))
    }

    const minFalloff = params?.[MODIFIER_BOUNCE_MIN_FALLOFF_KEY]
    if (typeof minFalloff !== 'number' || !Number.isFinite(minFalloff)
      || minFalloff < 0 || minFalloff > 1) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_BOUNCE_MIN_FALLOFF_KEY}`,
        `弹射原型缺少衰减下限 \`${MODIFIER_BOUNCE_MIN_FALLOFF_KEY}\`（0 ~ 1 的乘数），`
        + `现在是 ${JSON.stringify(minFalloff)}`,
        '⚠ 写成 0 会让"弹射的第二段"变成 **0 伤害** —— 那和"没有第二段"分不出来。'
        + `代码里那份兜底是 ${String(MODIFIER_BOUNCE_FALLOFF_MIN_FALLBACK)}。`))
    }
    const maxFalloff = params?.[MODIFIER_BOUNCE_MAX_FALLOFF_KEY]
    if (typeof maxFalloff !== 'number' || !Number.isFinite(maxFalloff)
      || maxFalloff <= 0 || maxFalloff > 1) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_BOUNCE_MAX_FALLOFF_KEY}`,
        `弹射原型缺少衰减上限 \`${MODIFIER_BOUNCE_MAX_FALLOFF_KEY}\`（> 0 且 <= 1 的乘数），`
        + `现在是 ${JSON.stringify(maxFalloff)}`,
        '⚠ 上限**必须是 1 或更小**：> 1 就是"越弹越强"，那不是这个零件的事。'
        + `代码里那份兜底是 ${String(modifierBounceMaxFalloffOf(proto))}。`))
    } else if (typeof minFalloff === 'number' && maxFalloff < minFalloff) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_BOUNCE_MAX_FALLOFF_KEY}`,
        `衰减上限 ${String(maxFalloff)} 比下限 ${String(minFalloff)} 还小 —— 这是个空区间`,
        '⚠ 空区间会让夹取静默地把每一次弹射的下一段都乘成同一个数。'))
    }
    if (typeof falloff === 'number' && typeof maxFalloff === 'number' && falloff > maxFalloff) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_BOUNCE_FALLOFF_KEY}`,
        `默认衰减 ${String(falloff)} 比它自己的上限 ${String(maxFalloff)} 还大`,
        '⚠ 同上：默认值落在范围外面时，**每一个**副本都会被夹一次。'))
    }
    if (typeof falloff === 'number' && typeof minFalloff === 'number' && falloff < minFalloff) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${MODIFIER_BOUNCE_FALLOFF_KEY}`,
        `默认衰减 ${String(falloff)} 比它自己的下限 ${String(minFalloff)} 还小`,
        '⚠ 同上：默认值落在范围外面时，**每一个**副本都会被夹一次。'))
    }

    return out
  }

  // ---- trigger / monitor ----
  for (const key of TRIGGER_PARAM_KEYS) {
    if (!(key in (params ?? {}))) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', `params.${key}`,
        `${proto.kind} 原型缺少引擎要读的参数 \`${key}\``,
        `触发器 / 监测器读这几个键：${TRIGGER_PARAM_KEYS.join(' / ')}`
        + '（⚠ `condition` 原型上可以不写，但**副本必须凑得出一个真的条件** —— 见日志 54）。'
        + '⚠ 只写在 `paramsTemplate` 里是不够的 —— 引擎看的是 `params`。'))
    }
  }

  const when = params?.['when']
  if (when !== undefined && (typeof when !== 'string' || !TRIGGERS.includes(when))) {
    out.push(err('MODIFIER_PROTO_BAD_PARAMS', 'params.when',
      `params.when 必须是现成的事件之一（TriggerEvent），现在是 ${JSON.stringify(when)}`,
      `合法取值：${TRIGGERS.join(' / ')}。`
      + '⚠ 玩家明说了**不要新造事件** —— 触发器 / 监测器的条件来源就是这张表。'))
  }
  /*
   * ⚠ 时机**接没接线**要说出来（警告）。
   *   取值不认识的时候上面那条 `err` 已经报了 —— 这里**不重复报**（一条问题说两遍是噪声）。
   */
  if (typeof when === 'string' && TRIGGERS.includes(when)) {
    const unwired = unwiredTriggerIssue(when, 'params.when', '这个原型的 `params.when`')
    if (unwired !== undefined) out.push(unwired)
  }

  const origin = params?.['origin']
  if (origin !== undefined && (typeof origin !== 'string' || !TRIGGER_ORIGINS.includes(origin))) {
    out.push(err('MODIFIER_PROTO_BAD_PARAMS', 'params.origin',
      `params.origin 必须是四选一，现在是 ${JSON.stringify(origin)}`,
      `合法取值：${TRIGGER_ORIGINS.join(' / ')}`
      + '（施法者身上 / **触发这个技能的那次施法**的瞄准（落点 / 方向）/ 命中位置 / 失效位置）。'
      /*
       * ⚠⚠ **`aim` 那一档的语义 2026-09-30（日志 62）改了**，这里必须跟着说清楚：
       *   它**不再**退化成"最近的敌人"（那是日志 48 ~ 61 的行为，一个**猜出来**的点）。
       *   新的读法是"取**触发这个技能的那次施法**在按下那一刻解算出来的意图"，
       *   而**取不到就什么都不做**（和"没目标就不发生"同一条纪律）。
       * ⚠ 哪些路上取不到：`onLowHp` / `onTick` / `onCast`（挂载）**没有"那一次施法"**；
       *   只有「载体消失」（`onExpire`）那条路手里有（载体台账把意图抄下来了）。
       *   ⇒ 在这三条路上写 `origin: 'aim'` = **那一档不生效**（技能照常放出来，
       *     只是既不钉落点、也不钉方向）。⚠ 这不是"没实现"，是玩家 2026-09-30 定的。
       */
      + '⚠ `aim` 取不到"那一次施法"的意图时（监测器 / 挂载那几条路）**什么都不做**：'
      + '不钉落点、也不钉方向（**不会**退化成"最近的敌人"）。'))
  }

  const crossing = params?.['crossing']
  if (crossing !== undefined && typeof crossing !== 'boolean') {
    out.push(err('MODIFIER_PROTO_BAD_PARAMS', 'params.crossing',
      `params.crossing 必须是 true / false，现在是 ${JSON.stringify(crossing)}`))
  }

  const cond = params?.['condition']
  if (cond !== undefined && cond !== null) {
    if (typeof cond !== 'object' || Array.isArray(cond)) {
      out.push(err('MODIFIER_PROTO_BAD_PARAMS', 'params.condition',
        `params.condition 必须是一个条件对象（或者不写），现在是 ${JSON.stringify(cond)}`))
    } else if (isEmptyConditionObject(cond)) {
      /*
       * ⚠⚠ 2026-09-30（日志 54）：**出厂零件就是这么坏掉的** ——
       *   `content/modifiers/trigger-on-cast.json` 原来写着 `"condition": {}`，
       *   于是「应声触发」**出厂就是死的**（恒定不成立），而且一声不吭
       *   （既没有 `modifierTriggered` 也没有 `modifierBlocked`）。
       *   语义定稿：**不写条件 = 无条件**（宿主一触发就生效）—— 那才是触发器的自然语义。
       */
      out.push(err('MODIFIER_EMPTY_CONDITION', 'params.condition',
        '`condition: {}` 是个**空条件对象** —— 它**恒不成立**',
        '⚠ 它读起来像"无条件"，实际是"**永不触发**"、而且一声不吭。'
        + '⚠ 这个零件的**默认条件**（玩家点名的「**载体消失**」）**引擎今天还没接线** '
        + '⇒ 所以今天**必须写一个真的条件**（原型上不写、让副本写也行）。'
        + '⚠ 引擎那一侧求值器按 `type` 分派，`{}` 落到 `default: return false`。'))
    }
  }

  return out
}
