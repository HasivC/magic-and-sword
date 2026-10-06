/**
 * 场景 → 世界。**装配层**。
 *
 * 这一层做的事情只有一件：
 *   把"内容里写的场景"翻译成"引擎要的 spawn 调用"。
 *
 * 为什么它必须是一份、而不是 CLI 和浏览器各写一份：
 *   两边各写一份的话，`battle.ts` 里能跑的阵容在浏览器里装配不出来，
 *   而且报错方式还不一样 —— 一边是清晰的"术式找不到"，
 *   一边是白屏。这个坑在 manifest.json 上踩过一次（lava-armor 404 → 白屏）。
 *
 * ⚠ 它**不属于 core-sim**：sim 只认 spawn / registerTechnique 这些原子操作，
 *   不认识"场景"这个概念。所以这个文件放在 src/ 而不是 src/sim/。
 */
import type { EntityDef, Scenario, ScenarioEntity, StatusDef, WeaponDef } from './schema.ts'
import type { CompiledTechnique } from './sim/compile.ts'
import type { Entity, WeaponInstance, World } from './sim/types.ts'
import type { SpawnInit } from './sim/world.ts'
import { registerEntityDef, registerStatusDef, spawn } from './sim/world.ts'
import { registerTechnique, setTechniqueActive } from './sim/index.ts'
import { collectStatuses } from './validator/checks.ts'

/**
 * 场景里的一个单位，翻译好之后的样子
 */
export interface LoweredEntity {
  label: string
  /** 直接喂给 spawn() 的东西 */
  init: SpawnInit
  /**
   * 谁在驱动它。
   *
   * ⚠ `'none'` 是 2026-09-21 加的：**地上的东西**（`kind: 'item'`）
   *   既不是玩家也不是 AI，它什么都不做。
   *   不加这一档的话，一把躺在地上的剑会因为"没有 ai"被推断成 `'human'`，
   *   于是场景里出现**两个**玩家操控的单位 —— 而校验只允许一个，
   *   玩家会看到一条「一个键盘只能驱动一个」的报错，
   *   原因却是地上有把剑。
   */
  control: 'human' | 'ai' | 'none'
  /** 要注册进世界的术式（只有这个场景用得上的） */
  install: CompiledTechnique[]
  /** 这些术式里还要注册的状态定义 */
  statuses: ReturnType<typeof collectStatuses>
  /** 开局就要打开的常驻术式 */
  active: string[]
}

export interface LoweredScenario {
  id: string
  name: string
  seed: number
  /** 秒。不写就是 -1 = 不限时 */
  duration: number
  entities: LoweredEntity[]
  /**
   * 状态库里的状态（`content/statuses/`）。
   *
   * ⚠ 它是**全局**的，不属于任何单位 —— 所以放在这一层而不是 entity 里。
   *   技能里按 `statusId` 引用的库状态，装载时必须真的注册进世界，
   *   否则运行到那一刻会抛「找不到状态定义」。
   */
  libraryStatuses: StatusDef[]
  /**
   * 实体预设（`content/entities/`）。`spawn` 载荷按 id 引用。
   *
   * ⚠ 和状态库同理：不注册的话，召唤技能会在**放出来的那一刻**才抛
   *   「找不到实体预设」—— 而那正是加载期检查该拦住的事。
   */
  libraryEntities: EntityDef[]
  /** 玩家操控的那一个。没有 = 纯观战 / 无头对殴 */
  player: LoweredEntity | undefined
  /** 装配不了的地方。**不 throw** —— 一个单位配错不该让整局打不开 */
  problems: string[]
}

/**
 * 谁在驱动这个单位。
 *
 * 不写 controlledBy 就按有没有 ai 推断 —— 但这只在"场景里本来就有 AI"时可靠，
 * 所以纯 AI 对殴里放一个没 ai 的木桩，要显式写 controlledBy: 'ai'。
 */
function controlOf(def: ScenarioEntity): 'human' | 'ai' | 'none' {
  // 地上的东西没人驱动 —— 见 LoweredEntity.control 的注释
  if (def.kind === 'item') return 'none'
  if (def.controlledBy !== undefined) return def.controlledBy
  return def.ai !== undefined ? 'ai' : 'human'
}

/**
 * 翻译一个场景。
 *
 * `lookup` 是"按 id 找编译好的术式"，由调用方提供 ——
 * 这样这个函数就是纯的，命令行和浏览器都能用，测试里也能塞假的进去。
 */
export function lowerScenario(
  scenario: Scenario,
  lookup: (id: string) => CompiledTechnique | undefined,
  /**
   * 状态库。命令行和浏览器都会传它；不传的话，
   * 技能里按 `statusId` 引用库状态的规则会在运行到那一刻抛异常。
   */
  libraryStatuses: readonly StatusDef[] = [],
  /** 实体预设。同上 —— 召唤技能靠它才找得到要造什么 */
  libraryEntities: readonly EntityDef[] = [],
  /**
   * 武器库（`content/weapons/`）。
   *
   * ⚠ 场景里的单位写的是**武器 id**（`weapon: 'weapon.longsword'`），
   *   翻译时要把它换成运行时那份拷贝（`WeaponInstance`）。
   *   找不到就只记一条问题、那个单位空手 —— **不 throw**：
   *   和别的内容错误一样，一个武器写错不该让整局打不开。
   */
  libraryWeapons: readonly WeaponDef[] = [],
): LoweredScenario {
  const problems: string[] = []
  const entities: LoweredEntity[] = []
  const seenLabels = new Set<string>()
  const weaponById = new Map<string, WeaponDef>()
  for (const w of libraryWeapons) weaponById.set(w.id, w)

  /** 把武器 id 换成运行时拷贝。找不到返回 undefined（调用方记问题） */
  function weaponOf(id: string): WeaponInstance | undefined {
    const def = weaponById.get(id)
    if (def === undefined) return undefined
    return { id: def.id, name: def.name, attributes: { ...def.attributes } }
  }

  if (!Array.isArray(scenario.entities) || scenario.entities.length === 0) {
    problems.push(`场景「${scenario.name}」里一个单位都没有`)
  }

  for (const def of scenario.entities ?? []) {
    if (seenLabels.has(def.label)) {
      // label 是报错和战报里唯一的指认方式，重名会让所有提示都失去意义
      problems.push(`单位名重复：「${def.label}」—— 战报里分不清是谁`)
    }
    seenLabels.add(def.label)

    const init: SpawnInit = {
      faction: def.faction,
      pos: { x: def.pos.x, y: def.pos.y },
      base: def.attributes ?? {},
    }
    if (def.tags !== undefined) init.tags = def.tags
    if (def.stored !== undefined) init.stored = def.stored
    if (def.lifetime !== undefined) init.lifetime = def.lifetime
    if (def.radius !== undefined) init.radius = def.radius
    if (def.ai !== undefined) init.ai = def.ai

    /*
     * ---- 东西还是人 ----
     *
     * ⚠ `kind: 'item'` 的单位（地上的武器）**没有术式、没有 AI**：
     *   给它 techniques 是内容写错了（它不会动，也不会打），
     *   所以这里直接报出来，而不是默默生成一个拿着技能的剑。
     */
    if (def.kind === 'item') {
      init.kind = 'item'
      if ((def.techniques ?? []).length > 0 || def.ai !== undefined) {
        problems.push(`「${def.label}」标的是地上的东西（kind: 'item'），却写了术式或者 AI —— 它不会动也不会打`)
      }
    }

    if (def.weapon !== undefined) {
      const w = weaponOf(def.weapon)
      if (w === undefined) {
        problems.push(`${def.label} 想要的武器找不到：${def.weapon}`)
      } else {
        init.weapon = w
      }
    }

    const wanted = def.techniques ?? []
    init.techniqueIds = wanted

    const install: CompiledTechnique[] = []
    for (const id of wanted) {
      const t = lookup(id)
      if (t === undefined) {
        problems.push(`${def.label} 想要的术式找不到：${id}`)
        continue
      }
      install.push(t)
    }

    const statuses: ReturnType<typeof collectStatuses> = []
    for (const t of install) statuses.push(...collectStatuses(t))

    // 常驻术式：注册 + 记下来，spawn 完再打开
    const active = def.activeTechniques ?? []
    for (const id of active) {
      const t = lookup(id)
      if (t === undefined) {
        problems.push(`${def.label} 想要的常驻术式找不到：${id}`)
        continue
      }
      if (!install.includes(t)) {
        install.push(t)
        statuses.push(...collectStatuses(t))
      }
    }

    entities.push({
      label: def.label,
      init,
      control: controlOf(def),
      install,
      statuses,
      active,
    })
  }

  const players = entities.filter(e => e.control === 'human')
  if (players.length > 1) {
    problems.push(
      `场景里有 ${players.length} 个单位标着 controlledBy: 'human'：`
      + players.map(p => p.label).join('、')
      + ' —— 一个键盘只能驱动一个。',
    )
  }

  const lowered: LoweredScenario = {
    id: scenario.id,
    name: scenario.name,
    seed: scenario.seed ?? 1,
    duration: scenario.duration ?? -1,
    entities,
    libraryStatuses: [...libraryStatuses],
    libraryEntities: [...libraryEntities],
    player: players[0],
    problems,
  }
  return lowered
}

/** 装配结果：label → 实体，调用方按名字找玩家 */
export type ScenarioRoster = Map<string, Entity>

/**
 * 把翻译好的场景装进一个（空的）世界。
 *
 * 顺序是有讲究的，别调换：
 *   1. 先注册全部术式和它们内联的状态定义
 *      —— 晚一步的话，spawn 完之后立刻触发的钩子（比如"开局就挂的护盾"）
 *         会在 world.statusDefs 里查不到自己
 *   2. 再 spawn 全部单位
 *   3. 最后打开常驻术式
 *      —— 必须等实体存在，setTechniqueActive 要写实体的 activeTechniques
 */
export function applyScenario(world: World, lowered: LoweredScenario): ScenarioRoster {
  // "被引用的东西"最先装：技能里按 id 引用它们的规则可能在任何时刻跑
  for (const s of lowered.libraryStatuses) registerStatusDef(world, s)
  for (const e of lowered.libraryEntities) registerEntityDef(world, e)

  for (const e of lowered.entities) {
    for (const t of e.install) registerTechnique(world, t)
    for (const { status } of e.statuses) registerStatusDef(world, status)
  }

  const roster: ScenarioRoster = new Map()
  for (const e of lowered.entities) {
    roster.set(e.label, spawn(world, e.init))
  }

  for (const e of lowered.entities) {
    const entity = roster.get(e.label)
    if (entity === undefined) continue
    for (const id of e.active) setTechniqueActive(world, entity, id, true)
  }

  return roster
}

/**
 * 兜底场景：内容里的场景一个都读不出来时用。
 *
 * ⚠ 存在的意义是**不白屏**。内容文件坏掉是常态（改 JSON 时手滑），
 *   那种时候玩家应该看到"内容加载失败 + 一个能玩的默认局"，
 *   而不是一个转圈或者黑屏 —— 后者看不出是哪个文件的问题。
 */
export function fallbackScenario(): Scenario {
  return {
    schemaVersion: 1,
    id: 'scenario.fallback',
    name: '兜底演武场（内容加载失败时用）',
    seed: 1,
    entities: [
      {
        label: '你',
        faction: 'player',
        pos: { x: 0, y: 0 },
        controlledBy: 'human',
        attributes: {
          'char.hp.max': 400,
          'char.energy.max': 100,
          'char.energy.regen': 14,
          'char.speed': 6,
        },
        techniques: ['tech.cleave', 'tech.magic-bolt'],
      },
      {
        label: '木桩',
        faction: 'enemy',
        pos: { x: 6, y: 0 },
        controlledBy: 'ai',
        tags: ['dummy'],
        attributes: { 'char.hp.max': 220, 'char.energy.regen': 9, 'char.speed': 4 },
        techniques: ['tech.magic-bolt'],
        ai: { targetFaction: 'enemyOfSelf', preferredRange: 7, thinkInterval: 0.4 },
      },
    ],
  }
}
