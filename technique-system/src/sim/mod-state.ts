/**
 * 修饰副本的**运行状态**（日志 48）。
 *
 * ## 为什么它单独一个文件
 *
 * ⚠ **为了打断一个循环依赖**：`cast.ts` 要在"卸下常驻术式"时清掉触发状态，
 *   而执行器（`trigger.ts`）要调 `cast.ts` 的 `activate()`。
 *   两个文件互相 import 的话，模块初始化顺序就变成一件要靠运气的事
 *   （ESM 能处理环，但"谁先求值"决定了两边看到的是不是一个空表）。
 *
 *   这份状态**只被两处读写**，而且它本身不认识施法、不认识内容 ——
 *   抽出来之后两边都往下依赖，谁也不往上依赖。
 *
 * ## ⚠⚠ 状态按**世界**分桶（这个坑踩过一次，写在明面上）
 *
 *   第一版把它写成**模块级的一张表**（`Map<entityId, …>`），跑单个测试文件
 *   时看着全绿 —— 可 `tests/scenario.ts` 里有**几十个 `createWorld()`**，
 *   每个世界都从 `nextId = 1` 开始 ⇒ **实体 id 在每个世界里都是 1、2、3**。
 *   于是第 21 节（背水）拿到的那个"实体 1"继承了**前面某一节**留下的
 *   "已经触发过"记录：表现是"血量跨过去了，但触发器一声不响" ——
 *   而单看那一节的代码完全看不出问题。
 *
 *   ⇒ 所以这几张表**按世界分**（`WeakMap<World, …>`）：
 *     一个世界的状态和另一个世界**永远不共享**，而 World 被回收时
 *     整桶自动跟着走（WeakMap 不需要手工清理）。
 *
 *   ⚠ **为什么不用"实体 id 全局唯一"来绕开**：那要改 `world.nextId` 的语义，
 *     而它是**快照 / 重放 / 联机同步**共用的东西（`tests/sim.ts` 钉着
 *     "同种子跑 1000 tick 两次快照逐字节一致"）。为了一个零件改实体编号，
 *     代价和收益完全不成比例。
 */
import type { Technique } from '../schema.ts'
import type { CompiledMod, CompiledTechnique } from './compile.ts'
import type { Entity, World } from './types.ts'

/** 世界 → （实体 id → 它身上**已经触发过**的那些修饰副本） */
const firedByWorld = new WeakMap<World, Map<number, Set<CompiledMod>>>()

/** 世界 → （实体 id → 触发副本留下的上一个点） */
const prevPointByWorld = new WeakMap<World, Map<number, { x: number; y: number }>>()

function firedIn(world: World): Map<number, Set<CompiledMod>> {
  let m = firedByWorld.get(world)
  if (m === undefined) {
    m = new Map()
    firedByWorld.set(world, m)
  }
  return m
}

function pointsIn(world: World): Map<number, { x: number; y: number }> {
  let m = prevPointByWorld.get(world)
  if (m === undefined) {
    m = new Map()
    prevPointByWorld.set(world, m)
  }
  return m
}

/**
 * ⚠ 键为什么是**修饰副本对象本身**（`CompiledMod` 的引用），不是"段下标 + 技能 id"：
 *   编译产物是不变对象、一份术式一份，所以引用稳定；
 *   而**同一个技能可以被好几条修饰盯上**（触发器 + 别的），
 *   按下标去重会让它们互相把对方的状态清掉。
 */
export function hasFired(world: World, entity: Entity, mod: CompiledMod): boolean {
  return firedIn(world).get(entity.id)?.has(mod) ?? false
}

/** 第一次触发返回 true（并且记下来）；已经触发过返回 false */
export function markFired(world: World, entity: Entity, mod: CompiledMod): boolean {
  const per = firedIn(world)
  let s = per.get(entity.id)
  if (s === undefined) {
    s = new Set()
    per.set(entity.id, s)
  }
  if (s.has(mod)) return false
  s.add(mod)
  return true
}

export function rememberPoint(world: World, entityId: number, p: { x: number; y: number }): void {
  pointsIn(world).set(entityId, { x: p.x, y: p.y })
}

export function lastPointOf(world: World, entityId: number): { x: number; y: number } | undefined {
  return pointsIn(world).get(entityId)
}

/**
 * 卸下 / 重装一份常驻术式时**清掉**这个实体的触发状态。
 *
 * ⚠ 不清的后果：装上 → 触发过 → 卸下 → 再装上之后，那个跨线触发
 *   会以为自己已经触发过了 —— 表现是"第二次装上它永远不生效"。
 */
export function forgetModifierState(world: World, entityId: number): void {
  firedIn(world).delete(entityId)
  pointsIn(world).delete(entityId)
}

// ============================================================================
//  「载体消失」的台账（2026-09-30 日志 55）
// ============================================================================
//
//  ⚠⚠ 这一节补的是日志 54 第 7 节那笔单独记着的引擎工作：
//    「**施法结果上下文**」—— 引擎要知道"**上一次施法放出去的那个东西**
//    后来怎么样了"（投射物 / 区域 / 屏障 / 召唤 都算"会自己在世界里活着的东西"）。
//
//  为什么它住在这个文件（而不是新开一个）：这里已经是"**修饰副本的运行状态**"
//    （触发过没有、上一次的点在哪）。载体账是同一类东西的第三笔：
//    **施法放出去的东西，现在还在不在**。放进新文件就要为同一个
//    `WeakMap<World, …>` 的分桶规矩（见文件头那段"按世界分桶"）再抄一遍。

/**
 * **一次施法在"按下那一刻"解算出来的意图**（2026-09-30 日志 62）。
 *
 * ⚠ 为什么要有这一份：触发器的「生成位置」里有一档是 `aim`（"瞄准的落点"），
 *   而**触发这条路没有玩家那一个意图** —— 日志 48 起它退化成"最近的敌人方向"
 *   （=`contextOf().target`，一个**猜出来**的点）。玩家 2026-09-30 定的新口径：
 *   "取**触发这个技能的那次施法**的意图（瞄准点/方向）"，
 *   **取不到就什么都不做**（不许退化成"最近敌人"）。
 *
 * ⇒ "那次施法"的意图必须在**它还在的时候**抄下来（`CastInstance` 会被 `pruneCasts`
 *   移出世界，载体往往活得比施法长）。这两个半边就是 `CastInstance` 上那两栏：
 *   · `point` —— `cast.aimPoint`（**只有 `areapoint` 类的技能才有**：它要一个落点）；
 *   · `facing` —— `cast.facing`（**每一次施法都有**：施法那一刻锁死的朝向）。
 *
 * ⚠ **快照、不是引用**：`cast.facing` 是会被引擎在阶段锁那儿换掉的（`lockedFacing`），
 *   而"按下那一刻朝哪"正是不该跟着变的那一个。
 */
export interface CastIntent {
  /** 那次施法的**落点**（`areapoint` 那类技能才有；别的技能不钉点） */
  point?: { x: number; y: number }
  /** 那次施法的**方向**（施法那一刻锁死，之后谁改 `facing` 都不影响它） */
  facing: { x: number; y: number }
}

/**
 * 一个**会自己在世界里活着的载体**是从哪一次施法、哪一个技能长出来的。
 *
 * ⚠ 它**记的是对象引用，不是 id** —— 这是有意的，而且是唯一能对的做法：
 *   · `technique` 是编译产物（不变对象，一份术式一份），引用稳定；
 *   · 用 id（`world.techniques.get(segId)`）查的话，**序列段那一份根本不在世界里**
 *     （`applyScenario` 只注册容器术式）⇒ 查不到 ⇒ 触发器**静默不响**。
 *     而"去 registerTechnique 里顺手补一刀"会把**老形状序列**（按 id 引用的子术式）
 *     的解析路径一起改掉 —— 那是另一件事，不该被这一片顺手改。
 */
export interface CarrierOrigin {
  /** 承载触发副本的那份编译产物（段自己的那一份，和引擎驱动触发器时用的是同一个） */
  technique: CompiledTechnique
  /**
   * ⚠⚠ **容器**那一份编译产物（`cast.technique` 的**上一层**）。
   *
   *   为什么必须多记这一笔（踩过一次）：**修饰副本住在段那一层，
   *   而 `seg.technique` 里没有 `mods`** —— `compileTechnique` 把
   *   `segments[].mods` 和摊平的 `mods` 都挂在**容器**产物上，
   *   段那份只有阶段和规则。
   *   ⇒ 只记段那一份的话，「载体消失」这条路在"找哪一份触发器副本"时
   *   遍历到的是一个**空段数组**，于是**触发器永远不响、而且一声不吭**
   *   （没有事件、没有报错）。这正是这一片要躲开的那类静默失败。
   *
   *   ⚠ 两份都要：段那份给 `activation` / `phases` / `rules`（放技能要用），
   *   容器那份给 `segments[].mods`（找触发器要用）。
   */
  container: CompiledTechnique
  /** 它修饰的那个技能（`targetIndex` 在**记录载体那一刻**就解算成了技能 id） */
  skillId: string
  /**
   * 触发出来的技能照抄哪个激活方式。
   *
   * ⚠ 也必须是**那一刻**抄下来的：`skillTechnique()` 要一个完整的
   *   `CompiledTechnique`，而载体消失时手里只有"施法者 + 这一段"——
   *   少这一个字段就得回头去世界里查那份术式（见上面那段为什么不能查）。
   */
  activation: Technique['activation']
  /** 谁放的。载体消失时要找它的身上挂没挂触发副本 */
  casterId: number
  /**
   * ---- **那一次施法在按下那一刻的意图**（2026-09-30 日志 62，`origin: 'aim'` 要它）----
   *
   * ⚠ 为什么必须记在这儿：载体消失**发生在很多 tick 之后**，那时候施法早就结束了
   *   （`pruneCasts` 把 `CastInstance` 移出了 `world.casts`）—— 晚一步就**永远取不到**。
   *
   * ⚠ 它是**可选**的：记台账的调用方（`sim/pipeline.ts` 的 `carrierOriginOf`）
   *   手里一定有 `ctx.cast`，所以今天**总是**填得上；留成可选的唯一理由是
   *   "取不到 ⇒ 什么都不做"那条纪律要有一个**能表达的**形状
   *   （而不是靠一个空对象冒充"意图是 (0,0)"）。
   */
  intent?: CastIntent
}

/** 一个载体在台账里的那一行 */
interface CarrierRow {
  /** 它在世界里是几号实体 —— 每 tick 就是靠它回答"还在不在" */
  entityId: number
  castId: number
  origin: CarrierOrigin
}

/** 世界 → （载体实体 id → 它的来历） */
const carriersByWorld = new WeakMap<World, Map<number, CarrierRow>>()

/** 世界 → （那些**已经长过载体**的施法 id）。⚠ 见下面"一次载体都没有"那条 */
const begunByWorld = new WeakMap<World, Set<number>>()

/** 世界 → （已经为哪次施法报过"载体没了"）。⚠ 一次施法只报一次 */
const goneByWorld = new WeakMap<World, Set<number>>()

function carriersIn(world: World): Map<number, CarrierRow> {
  let m = carriersByWorld.get(world)
  if (m === undefined) {
    m = new Map()
    carriersByWorld.set(world, m)
  }
  return m
}

function begunIn(world: World): Set<number> {
  let s = begunByWorld.get(world)
  if (s === undefined) {
    s = new Set()
    begunByWorld.set(world, s)
  }
  return s
}

function goneIn(world: World): Set<number> {
  let s = goneByWorld.get(world)
  if (s === undefined) {
    s = new Set()
    goneByWorld.set(world, s)
  }
  return s
}

/**
 * 记下"**这一次施法产生了一个会自己在世界里活着的载体**"。
 *
 * ⚠ 它**只该在载体真的被造出来之后调**（投射物 / 落点区域 / 屏障 / 召唤）——
 *   瞬时载体（挥砍 / 光束 / 光环）没有实体，也就没有"后来怎么样了"这回事。
 *
 * ⚠ 顺手记一笔 `carrierBegun`：**"这次施法长过载体"是"载体消失"能不能谈的前提**。
 *   没有这一笔的话，"一个技能根本没有载体"和"它的载体已经全消失"在引擎里
 *   长得一模一样 —— 而前者**什么都不该发生**（不许猜、也不许退化成"立刻触发"）。
 */
export function recordCarrier(
  world: World,
  entity: Entity,
  castId: number,
  origin: CarrierOrigin,
): void {
  carriersIn(world).set(entity.id, { entityId: entity.id, castId, origin })
  begunIn(world).add(castId)
}

/** 这一次施法**长过**载体吗（没有 ⇒ "载体消失"这件事无从谈起） */
export function carrierBegun(world: World, castId: number): boolean {
  return begunIn(world).has(castId)
}

/**
 * 这次施法放出去的那些载体**全都消失了**吗 —— 全没了才返回 true（**只回答一次**）。
 *
 * ## ⚠⚠ 语义：**全部消失**才算"载体消失"（待玩家裁定）
 *
 * 一次施法可以长出**好几个**载体（`spawn` 载荷的 `count`、连锁出来的第二发…）。
 * 两个候选语义都说得通，这一片选的是**全部消失**：
 *   · **引信就该烧到最后一个**："火球飞出去、它消失那一刻再触发"——
 *     场上还有一颗同批的火球在飞的时候就说"它消失了"，那颗火球算谁的？
 *   · **对既有的「份数」机制是一条连续的规矩**：多重释放 / 一分为 X 把一次激活
 *     变成 N 份，而"**这一组什么时候算结束**"在引擎里已经有答案了
 *     （`CastInstance.activation`：等**最后一份**）—— 载体这一层用同一个答案，
 *     玩家不用学第二套"什么时候算完"。
 *   · 反过来的代价（明说）：一发放空、飞出屏幕的子弹会让后续技能**晚到**；
 *     但"早到半个身位"会直接改变连段节奏，比"晚到"危险得多。
 *   ⇒ ⚠ **这一条是待玩家裁定项**（报告第 5 节），裁定下来改这一个函数就够。
 *
 * ⚠ 它还兼着"**只回答一次**"：第一次全消失时记下来，之后同一次施法再问都返回 false
 *   （否则"载体没了"会在之后每个 tick 都被重新发现一次）。
 */
export function allCarriersGone(world: World, castId: number): boolean {
  for (const row of carriersIn(world).values()) {
    if (row.castId !== castId) continue
    const e = world.entities.find(x => x.id === row.entityId)
    if (e !== undefined && e.alive) return false
  }
  const gone = goneIn(world)
  if (gone.has(castId)) return false
  gone.add(castId)
  return true
}

/** 台账里那些**已经不在世界上**的载体（连着它们的来历，给总线一并处理） */
export function expiredCarriers(
  world: World,
): { entityId: number; castId: number; origin: CarrierOrigin }[] {
  const out: { entityId: number; castId: number; origin: CarrierOrigin }[] = []
  for (const row of carriersIn(world).values()) {
    const e = world.entities.find(x => x.id === row.entityId)
    if (e === undefined || !e.alive) {
      out.push({ entityId: row.entityId, castId: row.castId, origin: row.origin })
    }
  }
  return out
}
