/**
 * 阶段机 —— 技能的执行。
 *
 * 技能不是"按一下就打出去"，而是一条时间轴：
 *
 *   前摇 ──→ 释放 ──→ 后摇
 *    │        │        │
 *   可打断   出效果    可取消
 *
 * 前摇、后摇、引导、蓄力全是"阶段"的实例。它们的区别只有三个字段：
 *   duration        多长。-1 表示由玩家控制（蓄力）
 *   occupiesCaster  是否占用施法者（决定这是持续技还是脱手技）
 *   interruptible   能不能被打断
 *
 * 代价挂在阶段上 —— **在哪一阶段付代价是玩家的设计自由**，也是点数的一个来源：
 *   前摇就付（有被打断的风险）→ 便宜
 *   后摇才付（绝对安全）      → 贵
 */
import type { Capability, Phase } from '../schema.ts'
import type {
  ActionContext, CastBlockReason, CastInstance, Entity, SequenceChain, Vec2, World,
} from './types.ts'
import { weaponParam } from './types.ts'
import { getStored, resolveAttribute, setStored } from './attributes.ts'
import { canAct } from './status.ts'
import { cooldownPath, executeAction, runRules, runTechniqueRules } from './pipeline.ts'
import { compileTechnique, ownerOf } from './compile.ts'
import type { CompiledSegment, CompiledTechnique } from './compile.ts'
import { evaluateAll } from './conditions.ts'
import { runModifierOnEquip } from './trigger.ts'
import { activateGroup, groupPlanOf } from './trigger.ts'
import { forgetModifierState } from './mod-state.ts'
import { matchesValid } from './targeting.ts'
import { resolveAim } from './targeting.ts'
import type { AimIntent } from './targeting.ts'

// ============================================================================
//  激活
// ============================================================================

export type ActivateResult =
  | { ok: true; cast: CastInstance }
  | { ok: false; reason: CastBlockReason }

export interface ActivateOptions {
  targetId?: number
  /** 施法瞬间锁定的朝向。之后锁定朝向的技能（激光）靠它 */
  facing?: Vec2
  /**
   * **原始意图**。给了它就以它为准，引擎按编译产物里那份 `targeting.mode` 解析。
   * （那份 `targeting` 来自**技能**，见 `compile.ts` 的 `targetingOfChain`。）
   *
   * `targetId` / `facing` 是它的简写形式（老调用方还在用）：
   * `targetId` 等价于 `{kind:'entity'}`，`facing` 等价于 `{kind:'direction'}`。
   */
  intent?: AimIntent
  /**
   * ---- **这一次施法的出发点 / 落点覆盖**（修饰技能的生成位置四选一，日志 48）----
   *
   * ⚠ 玩家定的「生成在哪里」有四档，其中两档是"**触发它的那个技能的命中位置**"
   *   和"**失效位置**" —— 那两种情况下，被触发的技能**不该从施法者身上长出来**。
   *
   * 给了它就等于把"落点"钉死在这一个点上（`cast.aimPoint`），
   * 而引擎里**唯一读 `aimPoint` 的地方是范围类载体**（`pipeline.ts` 的
   * `areapoint` 那几处，见它们的注释）。所以：
   *   · 不给 ⇒ 行为和以前**一模一样**（技能自己那套瞄准说了算）；
   *   · 给了 ⇒ 瞬时载体的落点被改写，别的（朝向、锁定目标）照旧。
   *
   * ⚠ 为什么不做成"凭空造一个假施法者"：`cast.casterId` 是**代价、仇恨、
   *   阵营、AI**的共同主语。造一个假人的话，"这次触发的技能算谁放的"
   *   会在四个地方同时变成另一个答案 —— 而那四处一个都不该变。
   */
  aimPoint?: Vec2
  /**
   * 这次施法是某条序列术式的第几段（**只有输入层会填**，见 `pressSequence`）。
   *
   * ⚠ 不填的人走的是普通术式那条路 —— 也就是说引擎里**没有两种施法**，
   *   只有"有没有链"这一个区别。AI 直接 `activate` 一段序列也完全合法
   *   （它只是不参与"按一次走下一段"那套）。
   */
  sequence?: { techniqueId: string; index: number }
  /**
   * ---- **同一次激活的记号**（份数类修饰：多重释放 / 一分为 X，日志 51）----
   *
   * ⚠ 一次激活里打出的 N 份**共用一个记号**（= 第一份那次施法的 `cast.id`，
   *   由 `sim/trigger.ts` 的 `activateGroup` 填）。它解决的是"**这一段什么时候算结束**"：
   *   每一份都带着 `sequence`（这样"正在放这一套"和缓冲都照旧工作），
   *   可 N 份各自跑完自己的时间轴 —— 拿先跑完的那一份去推进连段链是错的。
   *   `onSequenceEnd` 因此只看**最后一份**（`activation` 相同的那些还在跑 ⇒ 先不结束）。
   */
  activation?: number
  /**
   * ---- **这一份是同一次激活里的一员**（只有 `activateGroup` 会填）----
   *
   * ⚠ 它的作用是让"开始一次施法"的那几道门槛**只判一次**：
   *   · 冷却：N 份共用段的主键（`cd.<段id>`），第一份的 `phaseEnter`
   *     已经把冷却记上了 —— 不跳过的话，第二份会被**自己刚记的**冷却挡住；
   *   · `busy` / `locked`：那两句话说的是"**别人**占着施法者"，
   *     而同一次激活的份数**不是别人**。
   *
   * ⚠ **代价一个都不跳**：能量、血契、生死、沉默照判（"份数不是免费的"）。
   *   而且 `activateGroup` 会**先把所有份的代价加起来**判一次够不够 ——
   *   这样就不会出现"前两份放出来了、第三份因为没蓝而失败"的半组。
   */
  sameActivation?: boolean
  /**
   * ---- **这一下不是玩家按出来的**（引擎内部的延续 / 反射，2026-09-30 日志 54）----
   *
   * ⚠⚠ 玩家签字的口径（原话）：
   *   > "施法独占"管的是**玩家的手指**，不是**引擎内部的延续**。
   *
   *   所以**施法独占不看它**（`canActivate` 里那一行会跳过去）。两类都走这条路：
   *     · **同一次施法的延续** —— 份数类修饰（多重释放 / 一分为 X）由上面的
   *       `sameActivation` 管；**触发器链条**（A 的 onCast 触发 B）由这一个管；
   *     · **常驻术式的被动 / 反射** —— 监测器（`onLowHp` / `onTick`）触发撑盾那一下。
   *   ⚠ 挡掉它们的后果是"**日志 48 那一整套机制被静默废掉**"：玩家在施法中途
   *     跨过危险线，盾**永远不挂**，而且没有任何提示（玩家报不出这个 bug）。
   *
   *   ⚠ **防滥用不在这儿**：被触发的技能照旧付自己的代价（能量 / 血契）、
   *     照旧记自己的冷却（`activate` 里那几道**资源与生死**的门一份都不跳）。
   *
   *   ⚠ 谁能填它：**只有引擎自己**（`sim/trigger.ts` 的 `fireModifier`）。
   *     玩家那一侧（客户端按键 / AI / 命令行）**一律不填** —— 填了就等于
   *     把"施法独占"又变成了一个可配项。
   */
  engineInternal?: boolean
  /**
   * ---- **这一次施法"从头到尾"是哪一份编译产物**（容器 / 序列术式那一层）----
   *   （2026-09-30 日志 55，「载体消失」需要它）
   *
   * ⚠⚠ 为什么非要有这一个字段：引擎放技能时手里那份是**段**的产物
   *   （`resolveSegment` 给的就是它），而**修饰副本住在容器那一层的
   *   `segments[].mods` 上** —— 段那份里 `segments` 是空的。
   *   于是"载体消失时去找哪一份触发器副本"遍历到的会是一个空数组：
   *   触发器**永远不响、而且一声不吭**（这一片踩过，见 `CarrierOrigin`）。
   *
   * ⚠ 不填 = 就是这一次激活的那份（普通术式 / 触发器链条 / 命令行都对）——
   *   只有"序列术式按了某一段"这一条路要显式把自己的容器传下来。
   */
  homeTechnique?: CompiledTechnique
}

/**
 * 「放完才走下一段」里那个缓冲窗口，单位**秒**。
 *
 * ⚠ 玩家 2026-09-21 定的：**放完才走下一段，按下进 150ms 缓冲**。
 *   连点不插队（挥砍不会被自己取消），但也不丢输入（连按两下真的会挥两刀）。
 *
 * ⚠ 150ms 这个数是有依据的：60Hz 下是 9 个 tick，比人的"连续两次按键"
 *   间隔（约 100~200ms）略短 —— 刚好接得住搓招，又不会把两秒前的按键翻出来。
 */
export const SEQUENCE_BUFFER = 0.15

/** 把整个术式的能量消耗加起来。用来在激活时一次性判断"够不够" */
export function totalEnergyCost(technique: CompiledTechnique): number {
  let sum = 0
  for (const p of technique.phases) {
    sum += p.cost?.energy ?? 0
  }
  return sum
}

/**
 * 现在有多少血契。
 *
 * ⚠ 单独一个函数而不是到处写 `getStored(e, 'char.bloodPact.current')`：
 *   血契是**负值术式**的燃料，这个概念会被好几个地方问（能不能放、
 *   够不够、还差多少、HUD 显示多少）。写散了下场就是有一处忘了减。
 */
export function bloodPactOf(entity: Entity): number {
  return getStored(entity, 'char.bloodPact.current')
}

/**
 * 攻速倍率：这个人的招式比"标准"快多少 / 慢多少。
 *
 * ⚠ 来源是**武器**（`weapon.windup`），不是 `char.*` 属性：
 *   慢剑就是慢在剑上，换一把就变回来。将来要做"敏捷影响攻速"，
 *   那是在武器之外再乘一个系数 —— 但那是另一条轴，需要玩家拍板。
 *
 * ⚠ 钳到 0.2 ~ 5：
 *   内容是手写的 JSON，`windup: 0` 会让阶段时长变成 0 ——
 *   阶段不再需要 tick 就完成，等于把招式变成瞬发，而且
 *   在 `advancePhase` 里可能出现一 tick 走完整个术式。
 *   上限 5 只是为了别让人写出"一刀 10 秒"这种东西。
 */
export function attackSpeedOf(entity: Entity): number {
  const raw = weaponParam(entity.weapon?.attributes ?? {}, 'weapon.windup')
  if (!Number.isFinite(raw) || raw <= 0) return 1
  return Math.min(5, Math.max(0.2, raw))
}

/** 有没有正在进行的、**占用施法者**的施法（`occupiesCaster` 那一条排期口径） */
export function isBusy(world: World, casterId: number): boolean {
  for (const c of world.casts) {
    if (c.casterId !== casterId) continue
    /*
     * ⚠ 已经结束 / 被打断的不算 —— 它们还留在数组里（要等 `pruneCasts`），
     *   但"上一刀"不该挡住"下一刀"。
     */
    if (c.finished || c.interrupted) continue
    const phase = c.technique.phases[c.phaseIndex]
    if (phase?.occupiesCaster === true) return true
  }
  return false
}

/**
 * **这个施法者手上还有没有"进行中的施法"** —— 施法独占的判据（2026-09-30 日志 54）。
 *
 * ⚠⚠ **玩家定的硬规矩**（原话："玩家又没有第二人格"）：
 *     > 同一个施法者，同一时刻只能有一个"进行中的施法"。
 *
 *   所以这条判据**不看 `locks`**、**也不看 `occupiesCaster`**：
 *     · 以前 `canActivate` 用的是"这一门术式有没有占人阶段"**且** `isBusy`
 *       ⇒ **瞬发 / 脱手**的术式（`occupiesCaster: false`）能从一段正在跑的
 *       施法中间插进去，于是**两段施法同时在跑** —— 那是 bug，不是设计。
 *     · 现在只问一件事：**手上有没有还没结束的那一段**。有 ⇒ 新的激活一律拒绝。
 *   ⚠ `locks` 里有没有 `cast` **和这件事无关**：把锁解开也不许并行
 *     （否则"能并行"就成了一个可配项，而它是引擎硬规矩）。
 *
 * ⚠ 它和 `isBusy` **不是一回事**，别合并：
 *     `isBusy`            "这一段**占着人**吗"（排期：引导技要站桩，
 *                          AI 走位和 `applyPhaseLocks` 之外的一处也看它）
 *     `hasRunningCast`    "这个人**现在能不能再开一段**"（硬规矩，独占）
 *   两者在**脱手技**上正好分岔：脱手技跑着的时候 `isBusy` 是 false
 *   （它不占人），可 `hasRunningCast` 是 true（那一段还没放完）。
 *
 * ⚠ **脱手技不会被堵死**：它的"施法动作很快就结束"（阶段跑完 ⇒ `finishCast`
 *   ⇒ `pruneCasts` 把它移出 `world.casts`），所以"放完立刻再放别的"照旧成立 ——
 *   被拒的只是"**还没放完**的时候再插一段"。tests/scenario.ts 第 55 节钉着这条。
 */
export function hasRunningCast(world: World, casterId: number): boolean {
  for (const c of world.casts) {
    if (c.casterId !== casterId) continue
    /*
     * ⚠ 判据和 `isBusy` 一样跳过"已经结束 / 被打断"的：
     *   它们要等 `pruneCasts` 才离开数组，而"上一刀"不该挡住"下一刀"
     *   （不然连点会偶尔丢一刀，而且是看运气的那种）。
     */
    if (c.finished || c.interrupted) continue
    return true
  }
  return false
}

/**
 * 把 `ActivateOptions` 化简成**一个原始意图**。
 *
 * ⚠ 全项目**只有这一处**做这件事（日志 53 收成一处的）：以前它是写在
 *   `activate` / `pressSequence` 里**各一份**的同一条链子。
 *   两份的下场是**静默的**：`opts.facing` 是简写、`opts.intent` 是正写，
 *   而"排布"（`sim/trigger.ts` 的 `layoutPlanOf`）要读**意图里那半个方向** ——
 *   它要是自己再判一次，就会出现"排布看不到 `opts.facing`，
 *   于是按 (1, 0) 排了一圈"这种**只在老调用方（测试 / AI / 命令行）下出现**的错位。
 *   （真踩过：`pressSequence` 只给 `facing` 时，环绕整整差了 90 度。）
 *
 * 优先级和 `ActivateOptions` 的注释一致：
 *   `intent`（正写）> `targetId`（实体简写）> `facing`（方向简写）> 什么都不给。
 *
 * ⚠ 它**不读施法者的当前朝向** —— 那一步是 `resolveAim` 里 `dirOf` 的兜底
 *   （`intent.kind: 'none'` ⇒ 用 `caster.facing`），职责分得开：
 *   这里回答"调用方给了什么"，`resolveAim` 回答"那就朝哪儿"。
 */
export function aimIntentOf(opts: ActivateOptions): AimIntent {
  if (opts.intent !== undefined) return opts.intent
  if (opts.targetId !== undefined) return { kind: 'entity', id: opts.targetId }
  if (opts.facing !== undefined) return { kind: 'direction', dir: opts.facing }
  return { kind: 'none' }
}

/**
 * 现在能不能放这个术式。
 * 返回 undefined = 能放；返回原因 = 不能放。
 *
 * ⚠ `opts.sameActivation`（份数类修饰，日志 51）只放行"**别人**占着 / 刚记过"
 *   那三道门槛（冷却 / `locked` / `busy`）—— 见 `ActivateOptions.sameActivation`。
 *   资源类的判据**一份都不跳**：份数不是免费的。
 */
export function canActivate(
  world: World,
  caster: Entity,
  technique: CompiledTechnique,
  opts?: { sameActivation?: boolean; engineInternal?: boolean },
): CastBlockReason | undefined {
  if (!caster.alive) return 'dead'
  if (!canAct(caster, 'cast')) return 'silenced'

  const same = opts?.sameActivation === true
  /*
   * ⚠⚠ **"不是玩家按出来的"那一下不受施法独占管**（2026-09-30 日志 54，玩家裁定）：
   *   管的是**玩家的手指**，不是**引擎内部的延续**（触发器链条 / 监测器 /
   *   常驻术式的被动）。见 `ActivateOptions.engineInternal` 那一段 ——
   *   挡掉它们等于把日志 48 那一整套机制**静默废掉**。
   */
  const internal = opts?.engineInternal === true
  /*
   * ⚠ 冷却判据用**段自己的键**：同一次激活的 N 份都写 `cd.<段id>`
   *   （它们的 `technique.id` 就是段键），所以第一份一旦进了 `phaseEnter`，
   *   后面几份就会撞上"自己刚记的"冷却 —— 这就是要跳过它的原因。
   */
  if (!same && getStored(caster, cooldownPath(technique.id)) > 0) return 'cooldown'

  const need = totalEnergyCost(technique)
  if (need > 0 && getStored(caster, 'char.energy.current') < need) return 'energy'

  /*
   * ⚠ 血契：**负值术式**的燃料，不够就放不出来（玩家 2026-09-21 选的）。
   *
   *   备选方案是"允许透支成负债"和"不够就用血补"，两个都问过了，
   *   玩家选了最干净的那个：放不出来，技能栏那格变灰并写清还差多少。
   *
   *   判据用 `bloodPactCost > 0`，而它来自编译时传进来的 |点数合计| ——
   *   sim 不认识"点数"，它只看到一个数字。（见 compile.ts 的 bloodPactCost）
   */
  if (technique.bloodPactCost > 0 && bloodPactOf(caster) < technique.bloodPactCost) {
    return 'bloodPact'
  }

  /*
   * ⚠ 阶段锁里的 `cast`：正在跑的某个阶段**自己声明**"不许同时放别的"。
   *
   *   和 `occupiesCaster` / 施法独占都不是一回事：
   *     occupiesCaster   排期问题（这个阶段占着人，引导技要站桩）
   *     locks: ['cast']  **内容作者**的声明（这个阶段就是不该让你同时放别的）
   *     hasRunningCast   引擎硬规矩（同一个人同一时刻只有一段施法）
   *   前两条分别由 `isBusy` 和这里判，第三条在下面判 —— 提示也该分开。
   *
   *   ⚠ 顺序（2026-09-30 日志 54）：**这里排在施法独占前面** ——
   *     两件事同时成立时，"被锁着"是更具体的那一条（它说的是**这一段**的性质），
   *     而"正在施法"是引擎的兜底。反过来排的话，作者写在阶段上的
   *     `locks: ['cast']` 会永远说不出自己那一句。
   */
  if (!same && phaseLocksOf(world, caster).includes('cast')) return 'locked'

  /*
   * ⚠⚠ ---- **施法独占：引擎硬规矩**（2026-09-30 日志 54，玩家原话
   *   "玩家又没有第二人格"）----
   *
   *   同一个人，同一时刻**只能有一段"进行中的施法"**。所以这里**不再**问
   *   "这一门术式有没有占人阶段"：那样问的后果是**瞬发 / 脱手**的术式
   *   能从正在跑的那一段中间插进去（**两段同时在跑**），而那是 bug。
   *
   *   ⚠ 武器攻击也走这条路（左键就是 `pressSequence` ⇒ `activate`）——
   *     "边等边砍"同样不成立：等的那一段还没放完，这一刀一样被拒。
   *
   *   ⚠ 两类不判（都写在 `ActivateOptions` 里）：
   *     · `sameActivation` —— 同一次激活的第 2..N 份（份数类修饰：多重释放 / 一分为 X）；
   *     · `engineInternal` —— **不是玩家按出来的**（触发器链条 / 监测器的被动反射）。
   *     后者是玩家 2026-09-30 亲口划的边界："管的是**玩家的手指**，
   *     不是**引擎内部的延续**" —— 把它们也拦掉等于把日志 48 的机制静默废掉。
   *
   *   ⚠ 原因用 `busy`（不新造取值）：客户端那条 `blockReason` 把它翻成
   *     "正在施法" —— 正是要说的那一句（见 `web/src/main.ts`）。
   */
  if (!same && !internal && hasRunningCast(world, caster.id)) return 'busy'
  return undefined
}

/**
 * 启动一次施法。
 *
 * 顺序：建施法 → 跑 onCast 规则 → 进入第 0 阶段（付代价 + 跑 phaseEnter）
 */
export function activate(
  world: World,
  caster: Entity,
  technique: CompiledTechnique,
  opts: ActivateOptions = {},
): ActivateResult {
  const blocked = canActivate(world, caster, technique, opts)
  if (blocked !== undefined) {
    world.events.push({
      type: 'castBlocked', casterId: caster.id, techniqueId: technique.id, reason: blocked,
    })
    return { ok: false, reason: blocked }
  }

  /*
   * ⚠ 血契在**施法开始的这一刻**一次性扣掉，不在阶段里扣。
   *
   *   理由：它是**整个术式**的代价（点数账是术式层的），不是某一段的。
   *   摊到阶段里的话，"放完第一段就被打断"会只扣一部分 ——
   *   而玩家做这个负值术式的初衷是"整招换一次爆发"，
   *   半路被打断本来就已经很亏了，再退一半资源反而说不清规则。
   *
   *   `canActivate` 已经保证够扣，所以这里不会扣成负数。
   */
  if (technique.bloodPactCost > 0) {
    const left = bloodPactOf(caster) - technique.bloodPactCost
    setStored(caster, 'char.bloodPact.current', left)
    world.events.push({
      type: 'bloodPactSpent',
      entityId: caster.id,
      techniqueId: technique.id,
      amount: technique.bloodPactCost,
      left,
    })
  }

  /*
   * ---- 瞄准：按 targeting.mode 解析一次，**在施法瞬间锁住** ----
   *
   * ⚠ 这一份 `targeting` **来自技能**（2026-09-21 日志 47："瞄准搬到技能层"）：
   *   编译时由 `compile.ts` 的 `targetingOfChain` 从这条链上的技能身上取来，
   *   放进了编译产物 —— 所以下面这几行**一个字都没改**。
   *   （术式和序列段都不带瞄准了；每个技能各自解释那**一个意图**。）
   *
   * ⚠ 这是 `targeting.mode` 真的被引擎读的地方。
   *
   *   以前是：调用方（客户端 / AI）自己决定打谁和朝哪，引擎照单全收 ——
   *   于是 `mode` 那五个取值一个都没人看，`areapoint`（点地面）和
   *   `auto`（自动选最近的）写上去和 `directional` 完全一样。
   *
   *   现在引擎自己解析：
   *     调用方给"原始意图"（鼠标那一个点 / 选中的实体）
   *     引擎按 mode 算出"从哪儿发、朝哪、锁了谁"
   *   客户端和 AI 走同一条路，所以"AI 会放地面技能"不需要另写一套。
   *
   * ⚠ 解析结果存进 CastInstance，**之后不再变**。
   *   地面技能放出去就长在那块地上了，不会因为玩家把鼠标移开而跟着跑。
   */
  const intent: AimIntent = aimIntentOf(opts)
  const aim = resolveAim(world, caster, technique.targeting, intent)

  const cast: CastInstance = {
    id: world.nextCastId++,
    casterId: caster.id,
    technique,
    /*
     * ⚠ 「这一次施法从头到尾是哪一份」—— 不填就是 `technique` 自己
     *   （普通术式 / 触发器链条 / 命令行都对）。只有"序列术式按了某一段"
     *   要显式传容器下来（见 `ActivateOptions.homeTechnique` 那段）。
     */
    homeTechnique: opts.homeTechnique ?? technique,
    phaseIndex: 0,
    elapsed: 0,
    charge: 0,
    paid: [],
    interrupted: false,
    finished: false,
    // ⚠ 攻速在**施法瞬间**锁住（见 CastInstance.speedScale 的注释）
    speedScale: attackSpeedOf(caster),
    // ⚠ 朝向以**解析结果**为准，不是 opts.facing ——
    //   locked/auto 会把它改成"朝着选中的那个目标"
    facing: aim.facing,
    hitSkills: [],
    /*
     * 阶段锁一开始是空的 —— 真正的值由 `enterPhase()` 填。
     * 放在这里是为了让 CastInstance 的形状完整（读的人不用判 undefined）。
     */
    locks: [],
  }
  if (aim.targetId !== undefined) cast.targetId = aim.targetId
  /*
   * ⚠ 中心只在 `areapoint` 时钉住。
   *
   *   别的载具（挥砍、光束、光环）**跟着施法者走** —— 前摇 0.3 秒里人会移动，
   *   拿施法那一刻的坐标当中心，挥砍就砍在身后的空气上了。
   *   （这个 bug 真踩了：改完全用 aimPoint 之后，`duel` 里的剑士打出 0 伤害。）
   */
  if (aim.pointFixed) cast.aimPoint = aim.point
  /*
   * ⚠ ---- **生成位置的覆盖**（日志 48，修饰技能的四选一）----
   *
   *   放在 `aim.pointFixed` **之后**：覆盖优先。
   *   理由：`pointFixed` 说的是"这个技能自己那套瞄准要求把一个点钉住"，
   *   而覆盖说的是"**这一次触发**它该长在别的地方"——
   *   后者是这一下的实际情况，前者是这个技能的通用规则。
   */
  if (opts.aimPoint !== undefined) cast.aimPoint = { x: opts.aimPoint.x, y: opts.aimPoint.y }
  /*
   * 朝向**一律**以解算结果为准（`cast.facing = aim.facing`，见上面构造 CastInstance 那里）。
   *
   * ⚠ 2026-09-21 起不再分"锁没锁"：
   *   以前 `locked` / `auto` 锁死、`directional` 跟着施法者当前朝向走 ——
   *   于是"攻击朝哪"取决于客户端每帧往 `facing` 里写什么，那一环断掉时
   *   表现是"这一刀砍在别处"（玩家报过）。现在施法那一刻解算出来的方向
   *   就是这一下的方向，之后谁改 `facing` 都不影响它。
   */
  cast.aimReason = aim.reason
  if (opts.sequence !== undefined) cast.sequence = { ...opts.sequence }
  /*
   * ⚠ ---- **同一次激活的记号**（份数类修饰，日志 51）----
   *
   *   只由 `activateGroup` 填。N 份共用它 ⇒ `onSequenceEnd` 能认出
   *   "这一组还没跑完"，于是**只有最后一份**去推进连段链 / 消费缓冲。
   */
  if (opts.activation !== undefined) cast.activation = opts.activation

  world.casts.push(cast)
  world.events.push({
    type: 'castStarted', castId: cast.id, casterId: caster.id, techniqueId: technique.id,
  })

  runRules(world, cast, caster, 'onCast')

  if (technique.phases.length === 0) {
    finishCast(world, cast, caster)
    pruneCasts(world)
    return { ok: true, cast }
  }
  enterPhase(world, cast, caster, 0)
  // 第 0 阶段的代价有可能当场把施法者弄死（生命代价），所以要立刻清理
  pruneCasts(world)

  return { ok: true, cast }
}

// ============================================================================
//  序列推进（"按一次走一段"）
// ============================================================================
//
//  ⚠ **序列不只是武器在用**（玩家 2026-09-21 定的）：
//    > 之前定下来的"序列"机制只作用于武器技能，但现在我觉得也应该作用于
//    > 魔法技能了，因为想实现二段技能只能用这种方法，让每条序列有不同的 CD。
//
//    所以这一层是**所有术式**的能力：一门术式可以挂若干条序列，
//    每条序列**各有各的冷却、能量、目标**。
//    "二段技能"就是两条序列；"标记 → 瞬移"也是。
//
//  ⚠ 玩家 2026-09-21 定的规则，一条一条对应到代码：
//
//    > 按一次走一条序列 → 再按一次走下一条 → 到底回绕
//        压一次 = `pressSequence`，段号存在 `entity.chain.next`
//    > 放完才走下一段，按下进 150ms 缓冲
//        正在放的时候按键只**缓冲**（`bufferedTick`），
//        在那一段结束时（`onSequenceEnd`）才真的接上
//    > 超时 1 秒 → 回第一条
//        `world.tick - lastEndTick` 超过 `sequenceTimeout` 就**回到第一条序列**
//    > 一段被打断时，下次攻击走**下一条**序列（不回到第一条）
//        打断也调 `onSequenceEnd` —— 段号照常推进
//
//  ⚠ 2026-09-21（**日志 49**）改了口径的一条：轮到的这一段**在冷却**时
//    > 不激活这条序列并给出提示，然后指针指到下一条序列**等待按键触发**
//        见 `pressSequence` 里那一段：这一下什么都不放（不是"当场换一条打出去"），
//        游标 +1，下一次按键才试；一圈都在冷却 → 回第一条原位等待。
//    ⚠ 只有**冷却**走这条路 —— 能量/血契/沉默/忙碌照旧原样失败。
//
//  ⚠ 为什么这一整块在**模拟里**而不是客户端里：
//    AI 也要能连招（它没有客户端），重放和将来的局域网同步也要走同一条路。
//    客户端那侧只剩一件事：把"按了一下"告诉引擎。
//
//  ⚠ 2026-09-21（日志 46）序列**内联**之后，这里少了一次查表：
//    以前每一段要 `world.techniques.get(序列id)`（查不到就是"按了没反应"，
//    而且那条失败路径是静默的），现在段自己带一份编译产物。
//    ⚠ 但**老形状**（`sequences: ["tech.ws-slash"]`，老存档 / 老分享码里的）
//    仍然按 id 查 —— 见 `resolveSegment`，那是"宁可留着旧的读法"的落点。

export type PressReason = CastBlockReason | 'noSequence'

/**
 * 一次按键**因为冷却**没放出来时，给界面看的那一份说明。
 *
 * ⚠ 为什么"哪一条 + 还剩多久"要从模拟里带出来，而不是让界面自己去查：
 *   冷却键是**内部形状**（日志 46 起 = 那一段自己的 id，见 `segmentKey`），
 *   而序列术式的冷却记在**每一段**上、容器自己没有 —— 界面算不出
 *   "轮到的是哪一段"，也就说不出"还剩多久"。
 *
 * ⚠ 玩家上一轮的亏就是"按下去没反应，而且不知道为什么"，所以这一份
 *   不是装饰：`pressSequence` 只在**冷却**这条路上填它，别的失败原因
 *   （能量 / 血契 / 沉默 / 忙）不填 —— 那些走 `blockReason`，说的是另一件事。
 */
export interface CooldownNotice {
  /** 轮到的那一段（从 0 数）—— 就是它把这一下挡住了 */
  index: number
  /** 那一段的术式 id（冷却就记在 `cd.<这个 id>` 上） */
  techniqueId: string
  /** 那一段的名字（提示要写给人看，不能只有 id） */
  name: string
  /** 还剩多少秒（一定 > 0） */
  remaining: number
  /**
   * 整条链**都在冷却**（所以游标回到了第一条，见 `pressSequence`）。
   *
   * ⚠ 界面要分开说：这种情况玩家再按也还是什么都没有，
   *   该等的是"最早冷却好的那一条"，不是"下一条"。
   */
  allCooling: boolean
}

export interface PressResult {
  ok: boolean
  reason?: PressReason
  /** 这次真的开始放第几段（从 0 数） */
  index?: number
  /** 在放的时候按下去，进缓冲了（没有立即出招 —— 这是对的） */
  buffered?: boolean
  cast?: CastInstance
  /** 因为冷却失败时：是哪一条序列在冷却、还剩多久（界面拼提示用） */
  cooldown?: CooldownNotice
}

/**
 * 拿到第 `index` 段的**编译产物**。
 *
 * ⚠ 两半都要认（`Technique.sequences` 是联合类型，见 schema）：
 *
 *   1. **内联的段**：编译时就有产物了，直接给它。
 *   2. **老形状（字符串 id）**：那时候编译期拿不到技能（它引用的是一份
 *      单独的术式），所以按 id 去世界里查 —— 这正是迁移前的行为。
 *      查不到就返回 `undefined`（调用方给 `noSequence`，"按了没反应"），
 *      **不抛**：一份老存档里的悬空引用不该让整局崩掉。
 *
 * ⚠ 第 2 条这条路**不能删**：老存档和老分享码里的术式就是这个形状
 *   （玩家 2026-09-21：判死等于他手里的东西全成垃圾）。
 */
function resolveSegment(
  world: World,
  technique: CompiledTechnique,
  index: number,
): CompiledTechnique | undefined {
  const segs = technique.segments ?? []
  const seg: CompiledSegment | undefined = segs[index]
  if (seg === undefined) return undefined

  // ---- 内联的段：编译时就有产物了，自给自足 ----
  if (seg.refId === undefined) return seg.technique

  /*
   * ---- 老形状：按 id 去世界里查（和迁移前那行 `world.techniques.get(id)` 同一句）----
   *
   * ⚠ **查不到就返回 `undefined`，不许拿那份空产物兜底。**
   *   迁移前查不到 = 这一段没装好 = `noSequence`（"按了没反应"）——
   *   兜底的话会变成"放一份空时间轴"，而 `activate` 对空时间轴的处理是
   *   **立刻算作放完并推进链**：玩家会看到"按了一下，什么都没发生，
   *   但连段却往前跳了一段"。那是行为改变，不是兼容。
   */
  return world.techniques.get(seg.refId)
}

function segmentCountOf(technique: CompiledTechnique): number {
  return (technique.segments ?? []).length
}

/** 那个容器术式现在是不是有人在放 */
function runningSequence(world: World, casterId: number, techniqueId: string): CastInstance | undefined {
  return world.casts.find(c =>
    c.casterId === casterId
    && !c.finished && !c.interrupted
    && c.sequence?.techniqueId === techniqueId)
}

/**
 * 按一次**武器术式**。引擎决定走哪一段序列。
 *
 * ⚠ 这是"序列在激活方式上位于术式层级的下方"那句话的落地点：
 *   调用方给的是**容器**（`tech.longsword-basic`），引擎自己挑
 *   `sequences` 里的某一段去放（横砍）。
 *
 * 不是序列术式（没挂序列）时它就是 `activate` —— 普通术式不受影响。
 */
export function pressSequence(
  world: World,
  caster: Entity,
  technique: CompiledTechnique,
  opts: ActivateOptions = {},
): PressResult {
  const count = segmentCountOf(technique)
  if (count === 0) {
    const r = activate(world, caster, technique, opts)
    return r.ok ? { ok: true, cast: r.cast } : { ok: false, reason: r.reason }
  }

  /*
   * ⚠ ---- **被常驻包装的那一块不响应按键**（日志 48）----
   *
   *   玩家定的：「常驻包装把它自己和后面那个技能包装成常驻 →
   *   于是这一块**进常驻序列、不参与按键激活（被跳过）**」。
   *
   *   判据用的是 `constantSegments`（**编译期**按原型表算出来的），
   *   不是"activation 是不是 auto"—— 后者会把一整类**没有包装**的
   *   常驻术式也掐掉，而它们今天照旧可以按（`cli/run.ts` 的常驻分支、
   *   `tests/battle.ts` 里的名刀司命都靠 `activate` 直接跑时间轴）。
   *
   *   没有这一条的话，玩家按下去看到的是"什么都没发生"（或者更坏：
   *   真的又放了一次，而它本该一直挂着）。有了它，界面能说清楚
   *   "这个东西本来就没有按键，它在常驻那一栏里"。
   */
  if ((technique.constantSegments ?? []).length > 0) {
    world.events.push({
      type: 'castBlocked', casterId: caster.id, techniqueId: technique.id, reason: 'autoTechnique',
    })
    return { ok: false, reason: 'autoTechnique' }
  }

  /*
   * 正在放这一套 → **只缓冲**，不插队。
   * 玩家原话是"放完才走下一段"：挥到一半再按一下不该把这一刀掐掉。
   */
  const running = runningSequence(world, caster.id, technique.id)
  if (running !== undefined) {
    const chain = chainOf(caster, technique.id)
    chain.bufferedTick = world.tick
    return { ok: true, buffered: true }
  }

  const chain = chainOf(caster, technique.id)
  /*
   * ⚠ 把**意图**传给选段：序列之间的条件门常常是关于目标的
   *   （"那个目标身上有标记吗"），而目标要靠那一段自己的 targeting 解析出来。
   */
  const intent: AimIntent = aimIntentOf(opts)

  /*
   * ---- 轮到的这一段在冷却 → **这一下什么都不放**，只把游标挪到下一条 ----
   *
   * ⚠ 玩家 2026-09-21 定的（日志 49 改的口径）：
   *   > 如果一条序列中有技能正在 CD，则不激活这条序列并给出提示，
   *   > 然后指针指到下一条序列**等待按键触发**。
   *
   *   ⚠ 三个动作，一个都不能少、也不能多：
   *     ① 不激活这条序列（不是"换一条打出去"）
   *     ② 给提示（说清哪一条在冷却、还剩多久 —— 见 `CooldownNotice`）
   *     ③ 游标 +1，**等下一次按键**才试
   *
   *   ⚠ 这里以前是"跳到下一条并**当场把它打出去**"（日志 46 那一版）。
   *     那和玩家现在要的不是一回事：一次按键打出去的技能换了人，
   *     玩家会以为"我按的是第一刀，怎么出来的是第二刀"。
   *
   * ⚠ **只有冷却会跳过**，其它原因（能量不够 / 血契不够 / 被控 / 正在施法）
   *   一律**原样返回失败**：
   *     · 能量/血契不够是"这一下打不出来"，跳过会让人以为是 CD 的问题
   *     · 被控和忙是"整个人现在动不了"，跳过没有意义
   *   想让它也跳的话是一个明确的取舍，不是这里漏了。
   */
  const index = nextIndex(world, technique, chain, caster, intent)
  const first = startSequence(world, caster, technique, count, chain, index, opts)
  if (first.ok) return first
  // 冷却之外的失败：原样返回（`startSequence` 已经把 `castBlocked` 事件推出去了）
  if (first.reason !== 'cooldown') return first

  /*
   * ⚠ 一圈里**还有没有能放的**？这里只是问一问（`canActivate` 无副作用：
   *   不推进链、不占缓冲），用来区分两种收尾：
   *     · 还有 → 游标前进到**下一条**，等下一次按键
   *     · 没有 → 游标**回到第一条并在原位等待**
   *
   *   ⚠ 最多问 `count - 1` 次（绕一圈就停）：不写成"一直找下去" ——
   *     没有能放的那一天，无限找就是死循环。
   *     段拿不到编译产物（`noSequence`）的算"放不出来"，不当成能放：
   *     它按下去本来就没反应，游标停在它上面是另一码事。
   */
  let anyFree = false
  for (let hop = 1; hop < count; hop++) {
    const probe = resolveSegment(world, technique, (index + hop) % count)
    if (probe !== undefined && canActivate(world, caster, probe) === undefined) {
      anyFree = true
      break
    }
  }

  /*
   * ⚠ 一圈都在冷却 → **回到第一条并在原位等待**（这一条是日志 49 自己定的，
   *   玩家只说了"指针指到下一条"）。
   *
   *   理由：不留这个落点的话，游标会一格一格往前挪，而每一下都只弹一句
   *   "冷却中" —— 玩家看到的是"按了没反应"在无限重复，而且他会以为
   *   按键坏了。回到第一条 = 有一个**确定**的等待位置：第一个冷却好的
   *   那一段，按下去就出。也不会空转（这一下什么都没放），也不会无限找。
   */
  chain.next = anyFree ? (index + 1) % count : 0
  /*
   * ⚠ `lastEndTick` 跟着写一下（= 把手上的链**续**到这一刻）。
   *
   *   `nextIndex` 有两条规则会**无视** `chain.next`：`lastEndTick < 0`
   *   （这一段链还没放过任何一段）和"超过 `sequenceTimeout` 没按"。
   *   不续这一下的话，"轮到的第一段一开始就在冷却"这种情况里游标
   *   根本推不动（下一次按还是算第 0 段），规矩 ③ 就落不了地。
   *
   *   代价（有意的）：序列超时窗口从**这一按**重新开始 ——
   *   跳过之后停手超过 `sequenceTimeout`，照旧回第一条，
   *   和"停一下再按就从第一段开始"是同一条规矩。
   */
  chain.lastEndTick = world.tick

  const seg = resolveSegment(world, technique, index)
  return {
    ok: false,
    reason: 'cooldown',
    ...(seg === undefined ? {} : {
      cooldown: {
        index,
        techniqueId: seg.id,
        name: seg.name,
        remaining: cooldownRemaining(caster, seg.id),
        allCooling: !anyFree,
      },
    }),
  }
}

/**
 * 走到第几段了。
 *
 * ⚠ 三个判断，缺一不可：
 *   1. 隔太久（超过 `sequenceTimeout`）→ **回第一段**：
 *      "停一下再按"不该从中间接上，那会让玩家觉得莫名其妙
 *      （他不知道自己的连段还"挂着"）。
 *   2. 上一段没超时 → 接着下一段（`chain.next`，已经在结束时算好并回绕）。
 *   3. **下一段的条件门**（`sequenceLinks[i].if`）不成立 → **跳过它**，
 *      继续往后找（和技能之间的 `links` 同一套语义）。
 *
 * ⚠ 第 3 条是玩家 2026-09-21 要的那个二段技能逼出来的：
 *   > 给最近的敌人挂上标记（不进入CD）、再次按下技能会瞬移到标记敌人身后。
 *
 *   第二段的门是「目标身上有标记」。标记过期之后再按，第二段不该放 ——
 *   要的是"**回头去标记一个新目标**"（也就是回到第一段），
 *   而不是"对着一个没有标记的人瞬移过去"。
 *   门上写 `if: [hasStatusTag(marked, target)]`、然后两段循环一圈回来，
 *   正好就是这个行为。
 */
function nextIndex(
  world: World,
  technique: CompiledTechnique,
  chain: SequenceChain,
  caster: Entity,
  intent: AimIntent,
): number {
  const timeout = technique.sequenceTimeout ?? 1
  const timeoutTicks = Math.max(1, Math.round(timeout / world.dt))
  const count = segmentCountOf(technique)
  if (count === 0) return 0

  let index: number
  if (chain.lastEndTick < 0) index = 0
  else if (world.tick - chain.lastEndTick > timeoutTicks) index = 0
  else index = chain.next % count

  /*
   * 过门：`sequenceLinks[i]` 管的是 `sequences[i+1]` 能不能跑（平行数组，
   * 和技能之间的 `links` 一样）。不成立就跳过这一段，去看下一段 ——
   * 最多绕一圈（`count` 次），免得写成死循环。
   *
   * ⚠ 门上的条件常常是**关于目标**的（"那个目标身上有标记吗"）。
   *   而目标是谁，是由**那一段自己的瞄准**决定的 ——
   *   而"那一段的瞄准"就是它的编译产物里那一份（2026-09-21 日志 47 起，
   *   它是编译时从**段里的技能**身上取来的，段自己不再带 `targeting`）。
   *   所以这里解析的还是同一份瞄准，一个字都没变。
   *   不然 `who: 'target'` 的条件永远拿不到 target，门永远不成立。
   */
  const links = technique.sequenceLinks ?? []
  for (let hop = 0; hop < count; hop++) {
    // 第 0 段永远可以（总得有个起点）—— 门只管"从上一段走过来"这件事
    if (index === 0) break
    const link = links[index - 1]
    const gate = link?.if
    if (gate === undefined || gate.length === 0) break

    const seg = resolveSegment(world, technique, index)
    const aim = seg === undefined ? undefined : resolveAim(world, caster, seg.targeting, intent)
    const target = aim?.targetId === undefined
      ? undefined
      : world.entities.find(e => e.id === aim.targetId)

    if (evaluateAll(gate, { world, self: caster, ...(target !== undefined ? { target } : {}) })) break
    index = (index + 1) % count
  }
  return index % count
}

/**
 * **按一下会发生什么**（不真的按）。
 *
 * ⚠ 它存在的理由有两个，都很要紧：
 *
 *   1. **HUD**：序列术式的冷却在**每一段**上（`cd.<那一段的术式id>`），
 *      容器自己没有冷却。所以"这一格能不能按"不能只看容器 ——
 *      要看**下一段**能不能放。查错地方的话，界面会一直显示可放，
 *      按下去却什么都不发生。
 *
 *   2. **AI**：它得知道"按这一下会不会有东西出来"，否则会对着
 *      冷却中的二段技能一直按。
 *
 * ⚠ 它**不改任何状态**（不推进链、不占缓冲）——
 *   会被每帧调用的东西绝不能有副作用。
 */
export function peekSequence(
  world: World,
  caster: Entity,
  technique: CompiledTechnique,
): { index: number; reason?: PressReason } {
  if (segmentCountOf(technique) === 0) {
    // 普通术式：直接问它自己能不能放
    const blocked = canActivate(world, caster, technique)
    return blocked === undefined ? { index: 0 } : { index: 0, reason: blocked }
  }

  const chain = caster.chain !== undefined && caster.chain.techniqueId === technique.id
    ? caster.chain
    : { techniqueId: technique.id, next: 0, lastEndTick: -1, bufferedTick: -1 }
  /*
   * ⚠ 预判用的意图是 `{kind:'none'}`：序列的选择（含条件门）在
   *   `auto` / `locked` 下**和调用方的意图无关**（引擎自己挑目标），
   *   而这两个正是会用门的场景。所以这里不需要真的意图。
   */
  const index = nextIndex(world, technique, chain, caster, { kind: 'none' })

  const compiled = resolveSegment(world, technique, index)
  if (compiled === undefined) return { index, reason: 'noSequence' }

  const blocked = canActivate(world, caster, compiled)
  return blocked === undefined ? { index } : { index, reason: blocked }
}

/** 拿到（或建出）这个实体的序列链 */
function chainOf(caster: Entity, techniqueId: string): SequenceChain {
  if (caster.chain === undefined || caster.chain.techniqueId !== techniqueId) {
    /*
     * 换了一条链（换了武器 / 换了术式）→ 从第一段重新开始。
     * ⚠ 不继承旧段号：新招式的序列条数通常不一样，
     *   继承下去会出现"新武器第一刀就使出了第三段"这种怪事。
     */
    caster.chain = { techniqueId, next: 0, lastEndTick: -1, bufferedTick: -1 }
  }
  return caster.chain
}

/** 真的放出第 `index` 段 */
function startSequence(
  world: World,
  caster: Entity,
  technique: CompiledTechnique,
  /** 段数（调用方已经算过一遍，别在这里再 `?? []` 一次） */
  count: number,
  chain: SequenceChain,
  index: number,
  opts: ActivateOptions,
): PressResult {
  const compiled = resolveSegment(world, technique, index)
  if (compiled === undefined) {
    /*
     * ⚠ 这一段**拿不到编译产物** —— 玩家看到的是"按了没反应"。
     *
     *   内联的段不会走到这里（编译时就有产物了）。走到这儿只有一种情况：
     *   **老形状**（字符串 id）引用的那份术式不在世界里（内容删了、
     *   或者存档里是一份悬空引用）。老代码在这里也返回 `noSequence`，
     *   所以行为逐位不变 —— 而且**不抛异常**：一条序列没装好，
     *   不该让整局崩掉。
     */
    return { ok: false, reason: 'noSequence' }
  }

  /*
   * ⚠ 段号在**开始放**的时候就写进链里，而不是等结束。
   *   理由：放的过程中再按会进缓冲，缓冲消费时要走的是"下一段"——
   *   那时候得知道"刚放的是第几段"。结束时的 `onSequenceEnd` 只负责
   *   推进 `next` 和消费缓冲。
   */
  chain.next = (index + 1) % count
  chain.bufferedTick = -1

  /*
   * ⚠ ---- **这一段的副本里有没有"份数"类修饰**（多重释放 / 一分为 X，日志 51）----
   *
   *   有 ⇒ 这一次激活要**一次打出好几份**，走 `activateGroup`；
   *   没有 ⇒ 和以前**一模一样**（一份，整段的时间轴）。
   *
   *   ⚠ 判据是**编译产物**里那些 `kind`（编译期按原型表解析好的），
   *     所以运行时不需要原型表；`groupPlanOf` 只看 `targetIndex === 0`
   *     （和触发器 / 监测器同一个限制，见 `sim/trigger.ts`）。
   *
   *   ⚠ 出厂内容里**一个副本都没有** ⇒ 这一行对所有出厂术式
   *     `plan === undefined`，走的是原来那条路（这是 `npm run calibrate`
   *     和 `node src/cli/battle.ts` 逐行不变的根据）。
   */
  const segment = (technique.segments ?? [])[index]
  const plan = segment === undefined ? undefined : groupPlanOf(segment)

  const r = plan === undefined
    ? activate(world, caster, compiled, {
      ...opts,
      sequence: { techniqueId: technique.id, index },
      /*
       * ⚠ 把**容器**传下去（`compiled` 只是段那一份）——
       *   「载体消失」要在很多 tick 之后回到容器上找触发器副本。
       */
      homeTechnique: technique,
    })
    : activateGroup(world, caster, technique, segment, plan, {
      ...opts,
      sequence: { techniqueId: technique.id, index },
    })
  if (!r.ok) {
    /*
     * ⚠ 放不出来（冷却/能量/被控）时**段号要退回去**。
     *   不退的话，这一次没放出去的段就被"吃掉"了 ——
     *   玩家会看到"第三刀不见了"，而且他不会知道为什么。
     */
    chain.next = index
    return { ok: false, reason: r.reason }
  }
  return { ok: true, index, cast: r.cast }
}

/**
 * 一段序列结束（放完 / 被打断）时调一次。
 *
 * 两件事：
 *   1. 记下结束时刻（超时判定要用）
 *   2. 如果刚才有一次**缓冲**在窗口内的按键 → 立刻接上下一段
 *
 * ⚠ **被打断也走这里**，也就是说：
 *   一段序列被中途打断，手上这条链记着的仍然是**下一条序列** ——
 *   所以**下一次攻击（按左键）激活的是下一条序列**，不是从头重新开始。
 *
 *   反过来说："挨打就回到第一段"是另一种做法，它的代价是
 *   在被围攻时连招永远接不起来（每一刀都还没放完就挨打）。
 *   玩家 2026-09-21 确认了前者。
 */
function onSequenceEnd(world: World, cast: CastInstance, caster: Entity): void {
  const seq = cast.sequence
  if (seq === undefined) return

  /*
   * ⚠ ---- **同一次激活的 N 份，只有最后一份算"这一段结束"**（日志 51）----
   *
   *   份数类修饰（多重释放 / 一分为 X）把一次激活拆成好几个施法，
   *   它们**都**带着 `sequence`（这样"正在放这一套"、缓冲、超时照旧工作）——
   *   可"结束"这件事一次激活只能发生一次：
   *   · 每份都推进一次连段链 ⇒ **按一下走 N 段**（链会飞掉）；
   *   · 每份都消费一次缓冲 ⇒ 一次按键被当成 N 次。
   *
   *   ⇒ 判据是"**同一 `activation` 记号下还有没有人在跑**"。
   *     `finishCast` / `interruptCast` 都已经把这个 cast 标成结束 / 被打断了，
   *     所以这里只数**还活着**的那些（`!finished && !interrupted`）。
   *
   *   ⚠ 为什么不用"等最长的那个阶段跑完"那种写法：每一份的阶段数、
   *     时长、打断等级都不一样（一分为 X 是同一个技能 X 份，
   *     多重释放是 N 个不同技能），"谁最长"要么算错、要么和阶段机打架。
   *     数"还有没有人在跑"是**唯一不需要知道时间轴**的判据。
   */
  if (cast.activation !== undefined
    && world.casts.some(c => c !== cast && !c.finished && !c.interrupted
      && c.activation === cast.activation)) {
    return
  }

  const tech = world.techniques.get(seq.techniqueId)
  if (tech === undefined) return
  const count = segmentCountOf(tech)
  if (count === 0) return

  /*
   * ⚠ 结束的这一段要先从 `world.casts` 里清掉，再去开下一段。
   *
   *   否则 `canActivate` 里的 `hasRunningCast` 会看见"自己刚才那一刀"
   *   （跑完了但仍然挂在数组里），于是缓冲里的那一刀被判成 busy 放不出来 ——
   *   连点就变成了"偶尔丢一刀"，而且是看运气的那种。
   *   ⚠ 日志 54 起这条更要紧了：施法独占的判据**只看**"手上还有没有那一段"，
   *   所以"放完马上接下一段"完全依赖这里先清干净。`pruneCasts` 是幂等的，
   *   多调一次没有副作用。
   */
  pruneCasts(world)

  const chain = chainOf(caster, seq.techniqueId)
  chain.lastEndTick = world.tick
  // 结束的这一刻，链上记的已经是"下一段"了（startSequence 写的）

  const waited = world.tick - chain.bufferedTick
  const bufferTicks = Math.max(1, Math.round(SEQUENCE_BUFFER / world.dt))
  const buffered = chain.bufferedTick >= 0 && waited <= bufferTicks

  if (!buffered) {
    chain.bufferedTick = -1
    return
  }

  /*
   * 消费缓冲：立刻接下一段。
   * ⚠ 用 `startSequence` 而不是 `pressSequence`：这一下是**已经记过账的按键**，
   *   再走一遍 pressSequence 会又进一次缓冲判定（把一次按键算成两次）。
   */
  chain.bufferedTick = -1
  const index = chain.next % count
  startSequence(world, caster, tech, count, chain, index, {})
}

export { onSequenceEnd }

// ============================================================================
//  阶段推进
// ============================================================================

function enterPhase(world: World, cast: CastInstance, caster: Entity, index: number): void {
  const phase = cast.technique.phases[index]
  if (phase === undefined) {
    finishCast(world, cast, caster)
    return
  }

  cast.phaseIndex = index
  cast.elapsed = 0
  // ⚠ 不清空 charge！蓄力值必须活到下一个阶段 ——
  //   否则 "release 阶段按蓄力量算伤害" 永远只能读到 0。
  //   charge 只在创建施法时归零，蓄力阶段最多一个（校验器保证）。

  /*
   * ⚠ 阶段锁在这里生效（`Phase.locks`）。
   *
   *   快照的是**进入这个阶段那一刻**的朝向，不是施法时的 ——
   *   蓄力阶段锁朝向，锁的该是"开始蓄力时朝哪"。
   *   `applyPhaseLocks()` 每 tick 用它把施法者掰回去。
   */
  cast.locks = [...(phase.locks ?? [])]
  if (cast.locks.includes('turn')) {
    cast.lockedFacing = { x: caster.facing.x, y: caster.facing.y }
  } else {
    delete cast.lockedFacing
  }

  world.events.push({
    type: 'castPhase', castId: cast.id, casterId: caster.id, phaseId: phase.id, index,
  })

  payPhaseCost(world, cast, caster, phase, index)

  // 代价可能把施法者弄死（生命代价）
  if (!caster.alive) {
    interruptCast(world, cast, caster, 'dead')
    return
  }

  runRules(world, cast, caster, 'phaseEnter', { phaseId: phase.id })
}

/**
 * 付这一阶段的代价。
 *
 * ⚠ 被记住"已经付过了" —— 被打断时不自动退还。
 *   那正是"早付更便宜"这个定价的前提：早付 = 承担被打断就白付的风险。
 *   想退还，就在 phaseInterrupt 规则里自己写一条。
 */
function payPhaseCost(
  world: World,
  cast: CastInstance,
  caster: Entity,
  phase: Phase,
  index: number,
): void {
  if (cast.paid[index] === true) return
  cast.paid[index] = true

  const cost = phase.cost
  if (cost === undefined) return

  if (cost.energy !== undefined && cost.energy > 0) {
    const cur = getStored(caster, 'char.energy.current')
    setStored(caster, 'char.energy.current', Math.max(0, cur - cost.energy))
  }

  if (cost.hp !== undefined && cost.hp > 0) {
    const amount = cost.hpIsPercent === true
      ? resolveAttribute(caster, 'char.hp.max') * cost.hp
      : cost.hp
    const cur = getStored(caster, 'char.hp.current')
    const next = Math.max(0, cur - amount)
    setStored(caster, 'char.hp.current', next)
    if (next <= 0 && caster.alive) {
      caster.alive = false
      world.events.push({ type: 'died', entityId: caster.id, killerId: caster.id })
    }
  }

  if (cost.cooldown !== undefined && cost.cooldown > 0) {
    const path = cooldownPath(cast.technique.id)
    // 取最大值：后面的阶段不该把前面的冷却改短
    const cur = getStored(caster, path)
    if (cost.cooldown > cur) setStored(caster, path, cost.cooldown)
  }

  // 血契是构筑层的账，不在这里扣 —— 它由负值术式的使用消耗（见 README）
  void world
}

/**
 * 推进所有施法。每 tick 调一次。
 *
 * 打断的判定在这里：沉默 / 眩晕不只是"不能开始新技能"，
 * 还要**中断正在进行的技能**。这条不做的话，控制效果对施法者几乎没用。
 */
export function tickCasts(world: World): void {
  if (world.casts.length === 0) return

  for (const cast of world.casts) {
    tickCast(world, cast)
  }
  pruneCasts(world)
}

/** 把结束和被打断的施法移出去 */
export function pruneCasts(world: World): void {
  world.casts = world.casts.filter(c => !c.finished && !c.interrupted)
}

function tickCast(world: World, cast: CastInstance): void {
  const caster = world.entities.find(e => e.id === cast.casterId)
  if (caster === undefined || !caster.alive) {
    cast.interrupted = true
    cast.finished = true
    return
  }

  const phase = cast.technique.phases[cast.phaseIndex]
  if (phase === undefined) {
    finishCast(world, cast, caster)
    return
  }

  /*
   * 打断。三档，不是布尔值。
   *
   *   'damage'  挨打就断（最脆）
   *   'control' 挨打不断，但被眩晕/沉默会断
   *   'none'    霸体帧，什么都不打断
   *
   * ⚠ 伤害是**上一个 tick 的第 9 步**结算的（投射物碰撞在施法之后），
   *   所以这里比的是 `world.tick - 1`。差一个 tick（16ms）在体感上没有区别，
   *   但换来的是：管线不需要反过来 import 施法系统（那会是个环）。
   */
  const level = phase.interrupt ?? 'damage'
  if (level !== 'none') {
    /*
     * ⚠ `damagedTick >= 0` 这个判断不能省。
     *
     *   没挨过打是 -1，而 `world.tick - 1` 在**第 0 个 tick** 也正好是 -1 ——
     *   少了这个判断，开局第一 tick 所有实体都会被当成"刚挨过打"，
     *   什么技能都放不出来。这个 bug 是测试抓到的（21 条断言同时变红）。
     */
    if (level === 'damage'
      && caster.damagedTick >= 0
      && caster.damagedTick === world.tick - 1) {
      interruptCast(world, cast, caster, 'damaged')
      return
    }
    if (!canAct(caster, 'cast')) {
      interruptCast(world, cast, caster, 'silenced')
      return
    }
  }

  // 施法期间的 onTick：持续扣血 / 扣能量的引导技靠它
  runRules(world, cast, caster, 'onTick')
  if (cast.finished || cast.interrupted) return

  // 位移途中撞到人，也算"这一段碰到了"
  markContactHit(world, cast, caster)

  // 蓄力阶段（duration = -1）由外部 releaseCharge 结束，不自动推进
  if (phase.duration < 0) {
    cast.charge += world.dt
    return
  }

  cast.elapsed += world.dt
  /*
   * ⚠ 阶段时长要乘**攻速倍率**（`weapon.windup`）。
   *   铁剑 1.15 → 每一段都慢 15%；长剑 1 → 标准。
   *
   *   乘在这里而不是改内容里的数字：内容里的 `duration` 是**招式的形状**
   *   （抬手多长、收势多长），武器改的是**速度**。
   *   把两者混在一起的话，换武器就得改技能，而技能是**只读**的模板。
   */
  if (cast.elapsed < phase.duration * cast.speedScale) return

  runRules(world, cast, caster, 'phaseComplete', { phaseId: phase.id })
  if (cast.finished || cast.interrupted) return

  advancePhase(world, cast, caster)
}

/**
 * 进入下一个阶段。
 *
 * ⚠ 这里也是**技能之间的连接条件**生效的地方。
 *
 *   编译后的阶段是**一条扁平的线**（`skillA#cast`, `skillB#roll`, …），
 *   阶段的 id 前缀告诉咱们它属于哪个技能。所以"要不要从技能 A 走到技能 B"
 *   就等于"下一个阶段换技能了吗？换了就先过一遍那道门"。
 *
 *   条件不成立 = **跳过那一整段技能**（它后面可能还有别的技能），
 *   而不是结束这次施法 —— "位移没碰到人就不炸"应该继续走后面的收招，
 *   不是整个人卡在那儿。
 */
function advancePhase(world: World, cast: CastInstance, caster: Entity): void {
  let next = cast.phaseIndex + 1

  while (next < cast.technique.phases.length) {
    const phase = cast.technique.phases[next]
    if (phase === undefined) break

    const skill = ownerOf(phase.id)
    const prev = cast.technique.phases[next - 1]
    const prevSkill = prev === undefined ? undefined : ownerOf(prev.id)

    // 还在同一个技能里：直接进，没有门要过
    if (skill === prevSkill) break

    /*
     * 换技能了 —— 过门。
     * `links[k]` 管的是 `skillIds[k+1]`，所以要按**技能**的位置找门，
     * 不是按阶段的位置（一个技能可能有好几个阶段）。
     */
    const k = cast.technique.skillIds.indexOf(skill)
    const link = k > 0 ? cast.technique.links[k - 1] : undefined
    const gate = link?.if
    if (gate === undefined || gate.length === 0) break

    if (evaluateAll(gate, { world, self: caster, cast })) break

    // 没过门：整段跳过，去看后面还有没有能进的
    const skipTo = link?.elseTo
    next = skipTo !== undefined && skipTo > next
      ? skipTo
      : skipOneSkill(cast.technique, next)
  }

  if (next >= cast.technique.phases.length) {
    finishCast(world, cast, caster)
    return
  }
  enterPhase(world, cast, caster, next)
}

/** 从第 `from` 个阶段起，跳过它所属的那个技能的**全部**阶段，返回下一个技能的第一阶段 */
function skipOneSkill(tech: CompiledTechnique, from: number): number {
  const phase = tech.phases[from]
  if (phase === undefined) return from
  const skill = ownerOf(phase.id)

  let i = from
  while (i < tech.phases.length) {
    const at = tech.phases[i]
    if (at === undefined || ownerOf(at.id) !== skill) break
    i++
  }
  return i
}

/**
 * "位移**碰到**敌人" —— 施法者挨到了谁，就算这一段碰到了。
 *
 * ⚠ 为什么不能只靠"作用到目标"来记：
 *   玩家说的那个例子是「向指向方向位移，**若触碰到敌人**则释放冲击」——
 *   纯位移技能**不作用于任何人**，它只是把自己挪过去。
 *   如果"碰到"只能由动作命中来记，那这个例子就写不出来：
 *   位移段永远算没碰到。
 *
 *   而这个游戏里**本来就没有实体之间的碰撞**（人会互相穿过去）。
 *   所以这里做的是最小版本的接触检测：施法期间，施法者和某个合法目标
 *   挨得足够近（半径和 + 一点点余量）就算碰到了。
 *
 * ⚠ 它只在**有施法在进行**时跑，所以"站在敌人旁边"不会凭空算数 ——
 *   得是某一段技能正在执行的那段时间里挨上的。
 */
function markContactHit(world: World, cast: CastInstance, caster: Entity): void {
  const phase = cast.technique.phases[cast.phaseIndex]
  if (phase === undefined) return
  const skill = ownerOf(phase.id)
  if (skill === '' || cast.hitSkills.includes(skill)) return

  const valid = cast.technique.targeting.valid
  for (const e of world.entities) {
    if (!e.alive || e.id === caster.id) continue
    if (!matchesValid(caster, e, valid)) continue
    const dx = e.pos.x - caster.pos.x
    const dy = e.pos.y - caster.pos.y
    const d = Math.sqrt(dx * dx + dy * dy)
    if (d <= caster.radius + e.radius + CONTACT_MARGIN) {
      cast.hitSkills.push(skill)
      return
    }
  }
}

/** 接触判定的余量（米）。给一点点，免得"擦过去了"不算 */
const CONTACT_MARGIN = 0.15

/**
 * 松开蓄力键：结束当前的蓄力阶段。
 * 蓄力值留在 cast.charge 里，供 release 阶段的规则用 ref: 'charge' 读。
 */
export function releaseCharge(world: World, castId: number): boolean {
  const cast = world.casts.find(c => c.id === castId)
  if (cast === undefined || cast.finished || cast.interrupted) return false

  const caster = world.entities.find(e => e.id === cast.casterId)
  if (caster === undefined) return false

  const phase = cast.technique.phases[cast.phaseIndex]
  if (phase === undefined || phase.duration >= 0) return false

  runRules(world, cast, caster, 'phaseComplete', { phaseId: phase.id })
  if (cast.finished || cast.interrupted) return true

  advancePhase(world, cast, caster)
  return true
}

/** 主动取消。只对 cancellable 的阶段有效 */
export function cancelCast(world: World, castId: number): boolean {
  const cast = world.casts.find(c => c.id === castId)
  if (cast === undefined || cast.finished || cast.interrupted) return false

  const phase = cast.technique.phases[cast.phaseIndex]
  if (phase === undefined || !phase.cancellable) return false

  const caster = world.entities.find(e => e.id === cast.casterId)
  if (caster === undefined) return false

  interruptCast(world, cast, caster, 'unknown')
  pruneCasts(world)
  return true
}

export function interruptCast(
  world: World,
  cast: CastInstance,
  caster: Entity,
  reason: CastBlockReason,
): void {
  if (cast.finished || cast.interrupted) return

  cast.interrupted = true
  cast.finished = true

  const phase = cast.technique.phases[cast.phaseIndex]
  const phaseId = phase?.id ?? '?'

  world.events.push({
    type: 'castInterrupted',
    castId: cast.id,
    casterId: caster.id,
    techniqueId: cast.technique.id,
    phaseId,
  })

  // 让规则有机会退还代价。已付的不自动退 —— 那是"早付"的风险
  runRules(world, cast, caster, 'phaseInterrupt', { phaseId })

  /*
   * ⚠ 被打断**也**走序列结束那一套：
   *   这一段虽然没放完，但它结束了 —— 手上那条链照样推进到**下一条序列**。
   *   所以下次攻击激活的是下一条，而不是回到第一段。
   *   （玩家 2026-09-21 确认过这个行为。）
   */
  onSequenceEnd(world, cast, caster)
  void reason
}

function finishCast(world: World, cast: CastInstance, caster: Entity): void {
  if (cast.finished || cast.interrupted) return
  cast.finished = true
  world.events.push({
    type: 'castFinished',
    castId: cast.id,
    casterId: caster.id,
    techniqueId: cast.technique.id,
  })
  // 放完了：记下结束时刻 + 消费缓冲里的那次按键（如果还在窗口内）
  onSequenceEnd(world, cast, caster)
}

// ============================================================================
//  冷却与常驻技能
// ============================================================================

/**
 * 冷却倒计时 + 规则间隔计时。
 *
 * 冷却存在 `cd.<术式id>` 这个存储属性上 —— 这样"改冷却"就能用
 * 现有的 AttributePayload（op: 'reset' 就是露娜的大招刷新）。
 */
export function tickCooldowns(world: World): void {
  for (const e of world.entities) {
    if (!e.alive) continue
    for (const [path, value] of e.stored) {
      if (!path.startsWith('cd.') || value <= 0) continue
      const next = value - world.dt
      e.stored.set(path, next > 0 ? next : 0)
    }
    // onTick 规则的限速计时（Rule.every）
    for (const [key, value] of e.ruleTimers) {
      if (value > 0) e.ruleTimers.set(key, Math.max(0, value - world.dt))
    }
  }
}

/** 查询某个术式还要等多久 */
export function cooldownRemaining(entity: Entity, techniqueId: string): number {
  return getStored(entity, cooldownPath(techniqueId))
}

/**
 * 打开 / 关闭一个常驻术式（activation 是 auto 的被动，或 toggle 切换的）。
 *
 * 这是管线钩子的第三个来源 —— 名刀司命做成武器被动，走的就是它：
 * 一个 auto 的术式，规则里写 `onLethalDamage → 拦截 + 挂无敌`。
 */
export function setTechniqueActive(
  world: World,
  entity: Entity,
  techniqueId: string,
  active: boolean,
): void {
  const idx = entity.activeTechniques.indexOf(techniqueId)
  if (active && idx < 0) {
    entity.activeTechniques.push(techniqueId)

    /*
     * auto 的被动没有"按下"这一刻，所以它的 onCast 规则在**挂上时**跑一次。
     *
     * 没有这一步的话，"装备它要付的代价"（生命上限 -15% 这类）永远不落地 ——
     * 那些代价的点数就白赚了。名刀司命的负重就是靠这条生效的。
     *
     * toggle 不走这里：它的 onCast 由 activate() 负责，否则会跑两遍。
     */
    const tech = world.techniques.get(techniqueId)
    if (tech !== undefined && tech.activation === 'auto') {
      runTechniqueRules(world, tech, entity, 'onCast')
      /*
       * ⚠ ---- **修饰技能的 `onCast` 触发副本**（日志 48）----
       *
       *   和上面那条规则是**同一条规矩**（没有"按一下"这一刻，装备代价
       *   就永远不落地）：触发器也一样，"装上时放一个护盾"这类写法
       *   不跑一次的话**永远不会发生**。
       *
       * ⚠ 放在规则**之后**：规则是"挂上它要付的代价"（负重、上限 -15%），
       *   而触发副本是"挂上它要放的东西"—— 先付钱再拿货。
       *   反过来的话，一个"装上时就掉血"的代价会让同一次安装的触发
       *   看到一个还没掉血的血量。
       */
      runModifierOnEquip(world, entity, tech)
    }
  } else if (!active && idx >= 0) {
    entity.activeTechniques.splice(idx, 1)
    /*
     * ⚠ 卸下时**清掉触发状态**：再装一次要能重新触发一次。
     *   不清的话，"装上 → 触发过 → 卸下 → 装上"之后那个跨线触发
     *   会以为自己已经触发过了，表现是"第二次装上它永远不生效"。
     */
    forgetModifierState(world, entity.id)
  }
}

export function isTechniqueActive(entity: Entity, techniqueId: string): boolean {
  return entity.activeTechniques.includes(techniqueId)
}

/**
 * 执行阶段锁：**这个阶段禁用施法者哪些能力**。
 *
 * ⚠ 为什么必须放在**模拟里**、而不是让调用方自觉。
 *
 *   玩家那一侧是"鼠标往哪指就往哪转"，AI 那一侧是"朝目标转"。
 *   两边各加一次判断的话，迟早有一边漏 —— 而漏的表现是
 *   "我明明写了 locks: ['turn']，结果还是能转"。
 *   放在这里，两边的**意图**都会被它覆盖掉，一处生效、处处生效。
 *
 * 调用时机在 `stepWorld` 的 7b：**AI 之后、位置积分之前**。
 *   早了会被 AI 的意图盖掉，晚了这一 tick 已经动了。
 *
 * ⚠ 它只清 `vel`，不清 `push`（击退 / 拉拽）。
 *   被击退是**别人对你做的事**，阶段锁管的是"你自己想干什么" ——
 *   硬直的人照样会被撞飞。
 */
export function applyPhaseLocks(world: World): void {
  for (const cast of world.casts) {
    if (cast.locks.length === 0) continue
    const caster = world.entities.find(e => e.id === cast.casterId)
    if (caster === undefined || !caster.alive) continue

    if (cast.locks.includes('move')) {
      caster.vel.x = 0
      caster.vel.y = 0
    }
    if (cast.locks.includes('turn') && cast.lockedFacing !== undefined) {
      caster.facing.x = cast.lockedFacing.x
      caster.facing.y = cast.lockedFacing.y
    }
  }
}

/**
 * 这个实体现在被哪些**阶段锁**禁着（由正在进行的施法决定）。
 *
 * ⚠ 给界面和 AI 用的查询，不是判据 —— 判据是 `applyPhaseLocks()`
 *   和 `canActivate()` 里那两处强制执行。这个函数只是让人**提前知道**
 *   （灰掉技能格、AI 别白费力气），漏调用它不会导致规则不生效。
 */
export function phaseLocksOf(world: World, entity: Entity): Capability[] {
  const out: Capability[] = []
  for (const cast of world.casts) {
    if (cast.casterId !== entity.id) continue
    for (const c of cast.locks) if (!out.includes(c)) out.push(c)
  }
  return out
}

/**
 * 区域的重叠：把"谁进来了 / 谁出去了"变成 `onEnter` / `onLeave` 规则。
 *
 * ## 为什么需要它
 *
 * `EntityKind` 里一直声明着 `'area'`（"留在地上的区域"），
 * `onEnter` / `onLeave` 也一直在 schema 和说明生成器里
 * —— 而**引擎一处都不读**，两个时机从来没被触发过。
 * 于是"靠近的东西自动减速"（无下限术式）、真火墙、毒圈、
 * "站进圈里才有效"这一类设计全都写不出来。
 *
 * ## 怎么判"进"和"出"
 *
 * 没有空间索引，也没有重叠事件。每 tick 算一遍"现在谁在半径内"，
 * 和上一帧的名单（`area.inside`）比一次：
 *   这一帧有、上一帧没有 → `onEnter`（带着"谁进来了"）
 *   上一帧有、这一帧没有 → `onLeave`
 *
 * ⚠ 放在 `stepWorld` 的 **8b**：位置积分**之后**。
 *   放在之前的话，用的是上一帧的坐标 —— 跑得快的人会"穿过去"而不触发。
 *
 * ⚠ 区域**不互相进入**（跳过 `kind === 'area'`）：
 *   不然一片火墙踩进另一片火墙、一个减速场套另一个减速场，
 *   会出现一堆没人想过的组合，而且内容作者无从预料。
 *   要让区域互相影响，那是显式写规则的事，不该是引擎的默认行为。
 */
export function tickAreaOverlap(world: World): void {
  for (const area of world.entities) {
    if (!area.alive || area.kind !== 'area') continue

    const now: number[] = []
    for (const e of world.entities) {
      if (!e.alive || e.id === area.id) continue
      /*
       * ⚠ 区域**不把地上的东西**算成"进来的人"。
       *
       *   一把地上的剑踩进火墙里没有任何意义，但会真的触发 onEnter
       *   （给"那把剑"挂上减速状态、扣它的血……）。玩家看到的是
       *   "火墙好像多打了一个人" —— 这种错最难查，因为它不是崩溃。
       *
       *   投射物**故意留着**：光环给飞过去的子弹挂减速是已经测得的行为
       *   （见 tests/battle.ts），那是"场地上的一切都受影响"，说得通。
       */
      if (e.kind === 'area' || e.kind === 'item') continue
      const d = Math.sqrt(
        (e.pos.x - area.pos.x) ** 2 + (e.pos.y - area.pos.y) ** 2,
      )
      if (d <= area.radius + e.radius) now.push(e.id)
    }

    const before = area.inside
    /*
     * ⚠ 先跑 `onEnter` 再跑 `onLeave`，而且用的是**这一帧的名单**。
     *   顺序写死是为了可重放：同样的局面必须产生同样的规则执行顺序。
     */
    for (const id of now) {
      if (before.includes(id)) continue
      const e = world.entities.find(x => x.id === id)
      if (e !== undefined) runAreaRules(world, area, 'onEnter', e)
    }
    for (const id of before) {
      if (now.includes(id)) continue
      // 已经死掉/被清掉的就不发了 —— 没有"离开"这回事了
      const e = world.entities.find(x => x.id === id)
      if (e !== undefined) runAreaRules(world, area, 'onLeave', e)
    }

    area.inside = now
  }
}

/**
 * 区域**散掉之前**，把里面的人放出去。
 *
 * ⚠ 这是 `tickAreaOverlap` 的必要搭档，漏了它就是一个真 bug：
 *   一次性的伤害区域（火墙）不会因为"人留在原地"而出问题，
 *   但**减速场**会 —— 状态是挂在**人**身上的，场地散了它还在，
 *   于是被减速的人**永久减速**，而且没有任何地方会报错。
 *
 * ⚠ 调用时机是 stepWorld 的 **10b**：`tickLifetime` 之后、清理之前。
 *   那时候区域实体还在数组里、只是 `alive === false`，
 *   所以它的规则还跑得起来（要它的 faction 和 activeTechniques）。
 *   放到 11 之后就查不到它了。
 *
 * 顺带也处理"区域被打死"：只要它这一 tick 变成不 alive，就会走到这里。
 */
export function releaseAreaOccupants(world: World): void {
  for (const area of world.entities) {
    if (area.kind !== 'area' || area.alive) continue
    if (area.inside.length === 0) continue

    for (const id of area.inside) {
      const e = world.entities.find(x => x.id === id)
      // 里面的人可能比场地先死 —— 那就没什么可放的了
      if (e !== undefined && e.alive) runAreaRules(world, area, 'onLeave', e)
    }
    area.inside = []
  }
}

/**
 * 跑一个区域的 `onEnter` / `onLeave` 规则。
 *
 * ⚠ 每个常驻术式**各自**判一次 `valid`：
 *   同一片区域上可以挂好几个术式（"对敌人减速" + "对友军加速"），
 *   各自管各自的目标。用区域的 tags 统一筛的话，这两种就分不开了。
 *
 * ⚠ `caster` 是**区域自己**，不是召唤它的人 —— 这样
 *   `target` 就是"走进来的那个人"，规则里可以直接对他做事：
 *
 *       when: onEnter, then: [ { payload: { kind: 'status', verb: 'apply', inline: 减速 } } ]
 *
 *   不带载体的动作打的就是 `ctx.target`。
 */
function runAreaRules(
  world: World,
  area: Entity,
  when: 'onEnter' | 'onLeave',
  target: Entity,
): void {
  for (const techId of area.activeTechniques) {
    const tech = world.techniques.get(techId)
    if (tech === undefined) continue
    if (!matchesValid(area, target, tech.targeting.valid)) continue
    runTechniqueRules(world, tech, area, when, { target })
  }
}

/**
 * 把这一 tick 新挂上的状态变成 `onStatusApplied` 规则（血契的一条来源）。
 *
 * ⚠ **为什么要排队、不当场触发。**
 *   `applyStatus` 是在伤害管线**里面**跑的，而规则又可能施加新状态 ——
 *   当场触发就是递归（挂 A 触发规则挂 B，B 又触发规则…），
 *   递归深度取决于内容怎么写，等于把"会不会炸栈"交给内容作者。
 *   排队到这个固定位置再跑，深度恒为 1。
 *
 *   `status.ts` 只往队列里记一个实体 id，它**不认识规则** ——
 *   反过来的话 `pipeline → status → pipeline` 就是循环依赖。
 *
 * ⚠ 代价是**晚一 tick**（16ms）才给血契。这个延迟不可感知，
 *   换来的是"内容怎么写都不会递归"。
 */
export function tickStatusAppliedRules(world: World): void {
  if (world.pendingStatusApplied.length === 0) return
  const ids = world.pendingStatusApplied
  world.pendingStatusApplied = []

  for (const id of ids) {
    const e = world.entities.find(x => x.id === id)
    // 挂上之后又死了或被清掉了 —— 那就没什么危机可言
    if (e === undefined || !e.alive) continue
    for (const techId of e.activeTechniques) {
      const tech = world.techniques.get(techId)
      if (tech === undefined) continue
      runTechniqueRules(world, tech, e, 'onStatusApplied')
    }
  }
}

/**
 * 状态上的 onTick 钩子 —— 持续伤害 / 持续扣能量靠它。
 *
 * ⚠ 这个以前是**完全没跑**的：管线里的 `matchWhen` 对 onTick 一律返回 false，
 *   所以状态钩子写 `when: 'onTick'` 等于没写 —— `soul-rend` 的裂魂创伤
 *   一直是白挂的，只是没人发现（它一击就把目标秒了）。
 *   做编辑器模板的时候才撞出来。
 *
 * 限速用和规则同一套计时器（entity.ruleTimers），不写 every 就按 1 秒。
 */
export function tickStatusHooks(world: World): void {
  for (const e of world.entities) {
    if (!e.alive || e.statuses.length === 0) continue

    for (const s of e.statuses) {
      for (let i = 0; i < s.hooks.length; i++) {
        const h = s.hooks[i]
        if (h === undefined || h.when !== 'onTick') continue

        const key = `status:${s.defId}:${i}`
        const left = e.ruleTimers.get(key) ?? 0
        if (left > 0) continue
        e.ruleTimers.set(key, h.every ?? 1)

        const ctx: ActionContext = {
          world,
          self: e,
          actor: e,
          status: s,
          depth: 0,
          sourceId: s.defId,
        }
        /*
         * ⚠⚠ **状态钩子的动作落在"挂着这个状态的那个人"身上** ——
         *   这是这一处的**明写**（2026-09-30 日志 61 起），不是兜底猜的。
         *
         *   以前这里是**不填 `target`** 的，靠 `sim/pipeline.ts` 里那句
         *   `ctx.target ?? ctx.actor` 隐式落到持有者身上 —— 而那一句在日志 61
         *   被清掉了（"需要目标却选不到 ⇒ 什么都不做"）⇒ 不填的话
         *   **持续伤害一点都不会跳**（`soul-rend` 的裂魂创伤当场变成白挂；
         *   `tests/battle.ts` 那三条 DoT 断言会红）。
         *
         *   ⚠ 为什么"落在持有者身上"是对的（不是我们新定的）：持续伤害 /
         *     持续扣能量的**语义**就是"这个状态**折磨挂着它的那个人**"，
         *     而且账本那一侧早就这么认了 —— `pricing.ts` 的
         *     `defaultTargetOf(when, inHook)` 对钩子里的 `onTick`
         *     返回的就是 `'self'`（那一行现在和这里**逐字对上**）。
         */
        ctx.target = e
        if (!evaluateAll(h.if, ctx)) continue
        for (const a of h.then ?? []) {
          executeAction(ctx, a)
        }
      }
    }
  }
}

/**
 * 常驻术式的 onTick 规则，每 tick 跑一次。
 *
 * "穿着它得一直烧能量"这类**持续代价**靠它 ——
 * 代价不是一次性扣完，而是挂着的时候一直在扣。
 * 条件里的 hasStatus 负责筛"现在到底该不该扣"。
 */
export function tickActiveTechniques(world: World): void {
  for (const e of world.entities) {
    if (!e.alive || e.activeTechniques.length === 0) continue
    for (const id of e.activeTechniques) {
      const tech = world.techniques.get(id)
      if (tech === undefined) continue
      runTechniqueRules(world, tech, e, 'onTick')
    }
  }
}
