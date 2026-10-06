/**
 * 桥：把磁盘上的 JSON 变成模拟核里能跑的东西。
 *
 * 这一层**不属于 core-sim** —— 它要读文件、要报错，
 * 而 src/sim/ 必须和运行环境完全无关（纪律 4）。
 *
 * 它做四件事：
 *
 *   读技能 → 校验 → 读术式 → **编译**（把术式的技能接成一条时间轴）
 *
 * "编译"这一步是两层数据模型（技能 / 术式）和单层执行引擎之间的桥。
 */
import type { EntityDef, ModifierProto, Skill, Technique, WeaponDef } from './schema.ts'
import type { BalanceConfig, ValidationReport } from './validator/types.ts'
import {
  collectStatuses, validateModifierProto, validateStatus, validateWeapon as checkWeapon,
} from './validator/checks.ts'
import { validateSkill, validateTechnique } from './validator/index.ts'
import { LoadError, readJson, collectJsonFiles } from './loader.ts'
import { priceOptionsFor, bloodPactCostOf } from './pricing.ts'
import { MODIFIER_SKILL_DIR, schoolOfSkillFile, stampSchool } from './school.ts'
import { registerEntityDef, registerStatusDef, registerTechnique } from './sim/index.ts'
import { compileTechnique } from './sim/compile.ts'
import type { CompiledTechnique, CompileProblem } from './sim/compile.ts'
import type { World } from './sim/index.ts'
import type { StatusDef } from './schema.ts'

export interface LoadedSkill {
  path: string
  skill: Skill
  report: ValidationReport
}

export interface LoadedTechnique {
  path: string
  technique: Technique
  compiled: CompiledTechnique
  problems: CompileProblem[]
}

function fail(path: string, what: string, issues: { code: string, path: string, message: string }[]): never {
  const lines = issues.map(i => `  [${i.code}] ${i.path}：${i.message}`).join('\n')
  throw new LoadError(path, `${what}校验没过，不能加载：\n${lines}`)
}

/** 读一个技能文件并校验 */
export function loadSkillFile(
  path: string,
  balance: BalanceConfig,
  statuses?: ReadonlyMap<string, StatusDef>,
  entities?: ReadonlyMap<string, EntityDef>,
): LoadedSkill {
  const skill = readJson<Skill>(path)
  /*
   * ⚠ **盖系别章**（派生字段，不写进 JSON，见 src/school.ts）——
   *   而且要在 `validateSkill` **之前**：算账和校验都读它，
   *   盖晚了会报一屏 `SKILL_SCHOOL_MISSING`（那是校验器自己的 bug）。
   */
  stampSchool(skill, schoolOfSkillFile(path))
  const report = validateSkill(path, skill, balance, statuses, entities)
  const errors = report.issues.filter(i => i.level === 'error')
  if (errors.length > 0) fail(path, '技能', errors)
  return { path, skill, report }
}

/**
 * 读一个**修饰原型**文件并校验（`content/modifiers/`，日志 48）。
 *
 * ⚠ 它和 `loadSkillFile` **故意是两条路**：
 *   原型的形状不是 `Skill`（没有阶段、没有规则、没有点数），
 *   塞进技能那条路的话 `pricing.ts` 那句 `skill.phases.forEach`
 *   会当场抛 —— 那是**加载期**的炸，一炸白屏。
 *
 * ⚠ 两条路的**共同点只有一处**：都"读文件 → 校验 → 有错就带着文件名抛"。
 *   别的都不共用（共用的话就会有人往原型上补一个 `phases: []` 去迁就，
 *   而那正是"为了整齐而整齐"）。
 */
export function loadModifierFile(path: string): { path: string, proto: ModifierProto } {
  const proto = readJson<ModifierProto>(path)
  const issues = validateModifierProto(proto)
  const errors = issues.filter(i => i.level === 'error')
  if (errors.length > 0) fail(path, '修饰原型', errors)
  return { path, proto }
}

/** 读一个术式文件。编译要等技能都读进来之后再做 */
export function loadTechniqueFile(path: string): { technique: Technique, report: ValidationReport } {
  const technique = readJson<Technique>(path)
  const report = validateTechnique(path, technique)
  const errors = report.issues.filter(i => i.level === 'error')
  if (errors.length > 0) fail(path, '术式', errors)
  return { technique, report }
}

// ============================================================================
//  内容库
// ============================================================================

export interface Library {
  skills: Map<string, Skill>
  /**
   * **修饰技能的原型**（`content/modifiers/`，日志 48）。
   *
   * ⚠ 它和 `skills` 是**两张表**，而且故意不合并：
   *   · 技能会被术式**按 id 引用**，找不到就是悬空引用（`UNKNOWN_SKILL`）；
   *   · 原型只被**副本**引用（`SegmentMod.proto`），而副本的"找不到"
   *     表现完全不同 —— 那一条序列**照旧按按键激活**（静默地不像修饰技能）。
   *   合成一张表的话，两种"找不到"就分不开了。
   *
   * ⚠ **它没有"自定义原型库"**（玩家不能创建原型）——
   *   所以这张表永远是内容层那一份，不像技能那样还要和存档合并。
   */
  modifiers: Map<string, ModifierProto>
  techniques: Map<string, Technique>
  /** 编译产物。引擎和客户端都认这个 */
  compiled: Map<string, CompiledTechnique>
  /** 状态库：可复用、可被多个技能按 id 引用 */
  statuses: Map<string, StatusDef>
  /** 实体预设：`spawn` 载荷按 id 引用 */
  entities: Map<string, EntityDef>
  /**
   * 武器（`content/weapons/`）。
   *
   * ⚠ 现在只有**数据**，还没有"谁拿着它"这件事 ——
   *   属性代入（`ref: 'weapon.damage'`）和左键绑武器术式
   *   是武器运行时那一轮的事。先把它读进来是因为：
   *   武器文件写错（属性名拼错、术式槽指向不存在的术式）
   *   从这一刻起就能在开局报出来，而不是等按下左键发现没反应。
   */
  weapons: Map<string, WeaponDef>
  problems: CompileProblem[]
  /** 每个技能被哪些术式引用，编辑器显示用 */
  usedBy: Map<string, string[]>
}

const SKILL_DIR = 'content/skills'
/**
 * 武器技能模板。
 *
 * ⚠ 它进的是**同一张技能表**（`Library.skills`）—— 术式按 id 引用技能时
 *   不区分自己引的是玩家技能还是武器模板。分两张表的话，
 *   校验、定价、装配都得查两遍，迟早漏一边（那时武器术式会被算成 0 点，
 *   等于白送）。区别只有内容上的 `readonly: true`（编辑器不给改）。
 */
const WEAPON_SKILL_DIR = 'content/weapon-skills'
/**
 * 武器。一把 = 一张属性表 + 两个术式槽（武器术式 / 魔法术式）。
 *
 * ⚠ 现在是**内容层的一张表**：加载 + 查两个槽的悬空引用。
 *   "装到人身上"（属性代入、左键绑武器术式）是武器运行时那一轮的事。
 */
const WEAPON_DIR = 'content/weapons'
/**
 * **内部术式库**：引擎/内容自己在用的术式。
 *
 * ⚠ 和玩家的术式库是两回事（玩家 2026-09-21 定的）：
 *   > 敌人用的术式存到别的地方，玩家在编辑器里看不到这些示范术式，也没法引用它们。
 *
 * 这一层里只放**真的被引用**的：场景里 AI 挂的、玩家开局那一格、武器术式的序列、
 * 二段技能的容器。玩家的术式住在存档里（`SavedState.techniques`），
 * 编辑器只列那一份 —— 两边不共用一张表，所以"出厂示范"不会再淹掉玩家的创作台。
 */
const TECHNIQUE_DIR = 'content/internal-techniques'
/**
 * 状态库。
 *
 * ⚠ 它是内容的**第三层**，和技能/术式并列：
 *
 *   技能 Skill      零件（有阶段、有规则）
 *   术式 Technique  编排（哪几个技能、绑哪个键）
 *   状态 Status     可复用的效果容器 —— 可以被多个技能按 id 引用
 *
 * 为什么需要它：内联状态（写在规则的 payload 里）只能被**它所在的那个技能**
 * 定义，别的技能想用它就得靠"那个技能恰好也在内容库里"这个隐藏耦合。
 * 灵光盾定义 status.shield、裂魂引用它 —— 删掉灵光盾，裂魂就悬空了。
 * （这个悬空**现在会被 checkStatusRefs 抓住**，但更好的做法是根本别产生它。）
 */
const STATUS_DIR = 'content/statuses'
/**
 * 实体预设。`spawn` 载荷按 `entityId` 引用它们。
 *
 * ⚠ 和状态库一样是"**被引用的内容**"：做成可加载的还不够，
 *   加载期必须做引用检查 —— 否则召唤技能会在**按下去的那一刻**
 *   才抛「找不到实体预设」。
 */
const ENTITY_DIR = 'content/entities'
/**
 * **修饰技能的原型**（日志 48）。
 *
 * ⚠ 出厂零件、**只读**、**玩家不能创建原型**（玩家 2026-09-21 定的）。
 *   玩家拖进序列得到的是**副本**（`SequenceSegment.mods`），副本住在术式里 ——
 *   所以这个目录和 `content/skills` 有一处根本不同：**没有"自定义原型库"**。
 *
 * ⚠ 为什么它必须在术式**之前**读进来：编译要按原型判断
 *   "这一段是不是被常驻包装了"（那决定了它参不参与按键激活）。
 *   晚一步的话，一份常驻术式里的那一段会被当成普通技能段 ——
 *   表现是"按下去真的放了一个技能"，而它本该**不占按键**。
 */
const MODIFIER_DIR = MODIFIER_SKILL_DIR
export function loadLibrary(balance: BalanceConfig): Library {
  const skills = new Map<string, Skill>()
  const modifiers = new Map<string, ModifierProto>()
  const techniques = new Map<string, Technique>()
  const compiled = new Map<string, CompiledTechnique>()
  const statuses = new Map<string, StatusDef>()
  const entities = new Map<string, EntityDef>()
  const weapons = new Map<string, WeaponDef>()
  const problems: CompileProblem[] = []
  const usedBy = new Map<string, string[]>()

  for (const file of collectJsonFiles(ENTITY_DIR)) {
    const def = readJson<EntityDef>(file)
    if (typeof def.id !== 'string' || def.id.length === 0) {
      throw new LoadError(file, '实体预设缺少 id')
    }
    entities.set(def.id, def)
  }

  for (const file of collectJsonFiles(MODIFIER_DIR)) {
    const { proto } = loadModifierFile(file)
    modifiers.set(proto.id, proto)
  }

  for (const file of collectJsonFiles(STATUS_DIR)) {
    const status = readJson<StatusDef>(file)
    const issues = validateStatus(status)
    const errors = issues.filter(i => i.level === 'error')
    if (errors.length > 0) fail(file, '状态', errors)
    statuses.set(status.id, status)
  }

  for (const file of collectJsonFiles(SKILL_DIR)) {
    // ⚠ 状态库要一起传 —— 技能里按 statusId 引用库状态时才算得出点数
    const loaded = loadSkillFile(file, balance, statuses, entities)
    /*
     * ⚠ **盖系别章**（派生字段，不写进 JSON）。
     *   武器技能模板和玩家技能进的是**同一张表**，术式按 id 引用时不区分来源 ——
     *   所以"这一份是哪一系"必须跟着对象走，否则校验器判不了
     *   "术式和它里面的技能同不同系"（见 src/school.ts）。
     */
    skills.set(loaded.skill.id, stampSchool(loaded.skill, 'magic'))
  }

  /*
   * 修饰技能（`content/modifiers/`，日志 48）。
   *
   * ⚠ 它**不进 `skills` 那张表**：原型不是 `Skill`（没有阶段、没有规则），
   *   而技能表会被定价、编译、装配到处遍历 —— 塞进去会炸在
   *   `pricing.ts` 的 `skill.phases.forEach` 上（加载期，一炸白屏）。
   *   术式要用的那份原型由 `Library.modifiers` 提供，编译时按 id 查。
   *
   * ⚠ 它必须在**术式之前**读进来：编译要按原型判断
   *   "哪一段被常驻包装了"（那是**运行时的行为**：常驻段不参与按键激活）。
   */
  for (const file of collectJsonFiles(MODIFIER_DIR)) {
    const { proto } = loadModifierFile(file)
    modifiers.set(proto.id, proto)
  }

  /*
   * 武器技能模板。
   *
   * ⚠ 它必须在术式之前读进来 —— 武器术式引用的就是它们，
   *   晚一步的话每条武器术式都会被报成"引用了不存在的技能"。
   *   校验路径和玩家技能**完全一样**（同一份 `loadSkillFile`），
   *   因为规矩本来就一样：它们也是技能，只是带 readonly 标记。
   */
  for (const file of collectJsonFiles(WEAPON_SKILL_DIR)) {
    const loaded = loadSkillFile(file, balance, statuses, entities)
    // ⚠ 系别章：这一边（content/weapon-skills）是**武器系** —— 见 src/school.ts
    skills.set(loaded.skill.id, stampSchool(loaded.skill, 'weapon'))
  }

  for (const file of collectJsonFiles(TECHNIQUE_DIR)) {
    const { technique } = loadTechniqueFile(file)
    techniques.set(technique.id, technique)

    /*
     * ⚠ 编译时必须把**血契消耗**传进去。
     *
     *   算出这个数的是 `src/pricing.ts`，而它在 sim 之外 ——
     *   所以在这里算好、作为数据传进编译产物（见 compile.ts 的 bloodPactCost）。
     *   漏传的后果很隐蔽：负值术式**不扣血契**，等于白送一整套爆发，
     *   而且没有任何地方会报错。
     */
    /*
     * ⚠ 查技能走一张**合并后的表**：基础技能库（内容）+ 自定义技能库（存档）。
     *   命令行没有存档，所以这里就是基础库 —— 但"按 id 查一张表"这个形状
     *   和浏览器那边保持一致（那边会把玩家的变体并进来）。
     */
    const lookup = (id: string): Skill | undefined => skills.get(id)
    const result = compileTechnique(technique, lookup, {
      bloodPactCost: bloodPactCostOf(
        /*
         * ⚠ 原型表传进定价（2026-09-21 日志 51）：份数类修饰的账要靠它认
         *   （"这个副本是多重释放还是一分为 X"）。漏传的后果是**静默**的：
         *   账面上"一次打 10 个"看起来是白送的。
         */
        technique, lookup, priceOptionsFor(balance, statuses, entities, modifiers),
      ),
      /*
       * ⚠ 原型表要传进编译：它决定"哪一段被常驻包装了"，而那是**运行时的行为**
       *   （常驻段不参与按键激活）。漏传的后果是静默的：
       *   常驻术式里那一段会被当成普通技能段 —— 按一下真的会放出来。
       */
      modifiers,
    })
    problems.push(...result.problems)
    compiled.set(technique.id, result.compiled)

    for (const skillId of result.compiled.skillIds) {
      const list = usedBy.get(skillId) ?? []
      list.push(technique.id)
      usedBy.set(skillId, list)
    }
  }

  /*
   * ---- 武器 ----
   *
   * ⚠ 放在**最后**：查两个术式槽的悬空引用要等术式表收齐。
   *
   *   `weaponTechnique` 指向一个不存在的术式时，引擎不会报错 ——
   *   它会得到一把"左键是空的"武器。空槽和错名字在引擎看来完全一样，
   *   所以这条检查是唯一能提前告诉玩家的地方。
   */
  for (const file of collectJsonFiles(WEAPON_DIR)) {
    const weapon = readJson<WeaponDef>(file)
    const issues = checkWeapon(weapon, new Set(techniques.keys()))
    const errors = issues.filter(i => i.level === 'error')
    if (errors.length > 0) fail(file, '武器', errors)
    weapons.set(weapon.id, weapon)
  }

  return { skills, modifiers, techniques, compiled, statuses, entities, weapons, problems, usedBy }
}

/**
 * 把一个编译好的术式装进世界。
 *
 * 装两样东西：
 *   1. 术式本身（常驻技能的钩子要靠 world.techniques 查）
 *   2. 它内联定义的所有状态（这样规则里用 statusId 引用也能找到）
 */
export function installTechnique(world: World, technique: CompiledTechnique): StatusDef[] {
  registerTechnique(world, technique)

  const installed: StatusDef[] = []
  for (const { status } of collectStatuses(technique)) {
    registerStatusDef(world, status)
    installed.push(status)
  }
  return installed
}

/** 装一整个内容库。场景和客户端都用它 */
export function installLibrary(world: World, lib: Library): StatusDef[] {
  // ⚠ 先装"被引用的东西"（状态库、实体预设），再装术式。
  //   反过来的话，术式里按 id 引用它们的规则会先跑在空表上。
  for (const s of lib.statuses.values()) registerStatusDef(world, s)
  for (const e of lib.entities.values()) registerEntityDef(world, e)

  const out: StatusDef[] = [...lib.statuses.values()]
  for (const c of lib.compiled.values()) out.push(...installTechnique(world, c))
  return out
}
