/**
 * 修饰技能的**执行器**：触发器 + 监测器（日志 48）。
 *
 * ## 这一片做了什么、没做什么
 *
 * 做了（玩家点名的三件事）：
 *   1. **条件满足 → 激活它后面那个技能**（定稿 §八 的「触发器」）；
 *   2. **监测器 = 触发器的一种**（条件是"监测什么"，例如血量低于某值）；
 *   3. **生成位置四选一**（施法者身上 / 瞄准的落点 / 命中位置 / 失效位置）；
 *   4. 被触发的技能**照常付自己的能量和冷却**（代价按**每次触发**结算）——
 *      "常驻 ≠ 免费"就落在这一条上：本文件**不碰任何资源**，
 *      它只是 `activate()` 的另一个调用方，于是该扣的一分不少。
 *
 * **没做**（下一片）：连锁（"弹给最近的敌人"）—— 它是**另一个机制**
 *   （不是份数），要"弹射"和"选下一个目标"，见日志 51 的报告。
 *
 * 2026-09-21（**日志 51**）补上了「份数」类的两个动词：**多重释放** / **一分为 X**。
 *   它们住在这个文件的下半部分（`groupPlanOf` / `activateGroup`）——
 *   和触发器共用同一句话：**代价按每一次结算**（本文件不碰任何资源，
 *   它只是 `activate()` 的另一个调用方）。
 *
 * ## 为什么执行器在 sim 里
 *
 * AI 也要能触发（它没有客户端），重放和将来的局域网同步也要走同一条路。
 * 客户端那侧只剩一件事：什么都不用做 —— 触发是**模拟**里发生的事。
 *
 * ## ⚠ 只接线了五个时机里的两类（诚实交代）
 *
 * **接线了哪些时机看 `WIRED_TRIGGER_EVENTS`（就在下面，全项目唯一一处声明）** ——
 * 那一张表同时被校验器拿去报 `MODIFIER_TRIGGER_NOT_WIRED` 警告。
 * ⚠ 这里**故意不再抄一份表格**：同一个事实写两处 = 迟早不同步。
 *
 * ⚠ 其余那些**不是"没实现"，是"还没有一个地方知道该在什么时候调"**：
 *   比如 `onHit` 要"这一次命中是谁打的"、`onMiss` 要"那一下打空了"。
 *   今天它们写在**触发器上不生效** —— 那是**待办**，
 *   而且**不许静默**：校验器会给出警告（见 `MODIFIER_TRIGGER_NOT_WIRED`）。
 *
 * ## 2026-09-30（**日志 55**）：玩家点名的默认值「**载体消失**」接上线了
 *
 * 补的是日志 54 第 7 节单独记着的那笔引擎工作（「**施法结果上下文**」）。
 *
 * · **谁算载体**：`delivery` / `spawn` 载荷造出来的、**会自己在世界里活着**的东西
 *   —— 投射物 / 落点区域 / 屏障 / 召唤。瞬时载体（挥砍 / 光束 / 光环）没有实体，
 *   也就没有"后来怎么样了"这回事。
 * · **什么时候算消失**：那个实体**不在世界上**的那一刻（到期 / 被打掉 / 撞墙 /
 *   主人死了跟着走，全都算 —— 判据只有一条"还在不在 `world.entities` 里"）。
 * · **怎么接的线**：照 `runModifierTriggers` 那条老路，**复用同一个 `fireModifier`**
 *   （代价 / 冷却 / 事件一个都不另写），只是驱动它的时机换成了"载体没了"。
 * · ⚠⚠ **找不到"前一个技能的载体"时什么都不发生**：一个技能**一个载体都没长过**
 *   （瞬时载体 / 还没放出去 / 施法被打断在半路），那"载体消失"这件事压根没发生过 ——
 *   **不许猜、也不许退化成"立刻触发"**。判据在 `carrierBegun`。
 * · ⚠ **不写条件的触发器 = 「载体消失」**（玩家点名的默认值：引信）。
 *   所以 `condition` 不写**不再是**"永不触发"（日志 54 那条 `MODIFIER_CONDITION_REQUIRED`
 *   判据因此松掉了）—— 见 `carrierGoneConditionsOf`。
 * · ⚠⚠ **`onRemoved` 没接**（2026-09-30 日志 55，上级裁定 —— **诚实 > 静默**）：
 *   "载体不在世界上了"这**一个**事实只由 `sweepCarriersGone` 发现，而那处
 *   **分不出**"自然到期"和"被打掉 / 撞墙"（要分得把 `reason` 记进台账，另立一片）。
 *   ⇒ 它**故意留在 `WIRED_TRIGGER_EVENTS` 之外**：写 `onRemoved` 会拿到
 *   `MODIFIER_TRIGGER_NOT_WIRED` **警告**（而不是"写上去不生效、还一声不吭"），
 *   那句话里直接指路 **改写成 `onExpire`**（"载体消失"的语义就是它）。
 *   ⚠ 反面教训：让它进那张表（"反正语义一样"）就是**假的接线**——
 *   这一整轮清的就是这一类。
 */
import type { Condition, TriggerEvent, TriggerOrigin } from '../schema.ts'
import type { CompiledMod, CompiledSegment, CompiledTechnique } from './compile.ts'
import type { CastInstance, Entity, World } from './types.ts'
import { activate, aimIntentOf, bloodPactOf, totalEnergyCost } from './cast.ts'
import type { ActivateOptions, ActivateResult } from './cast.ts'
import { getStored } from './attributes.ts'
import { evaluateAll } from './conditions.ts'
import { normalize2 } from './geom.ts'
import { rotate2 } from './targeting.ts'
import type { AimIntent } from './targeting.ts'
import {
  allCarriersGone, expiredCarriers, forgetModifierState, lastPointOf, markFired, rememberPoint,
} from './mod-state.ts'
import type { CarrierOrigin, CastIntent } from './mod-state.ts'

/**
 * **今天真的接了线的触发时机** —— ⚠ 全项目**只有这一处**声明。
 *
 * | 时机 | 谁在调它 |
 * | --- | --- |
 * | `onLowHp` | `pipeline.ts` 的 `fireLowHp`（**跨过**低血线那一瞬间） |
 * | `onTick` | `world.ts` 第 6 步（每 tick 一次） |
 * | `onCast` | `runModifierOnEquip`（常驻术式**挂上**的那一刻；`cast.ts` 里那条"auto 术式挂上就跑一次"是**同一条规矩**） |
 * | `onExpire` | `sweepCarriersGone`（`world.ts` 第 11 步的 11b）—— **这次施法放出去的东西不再活着**的那一刻 |
 *
 * ⚠⚠ **`onRemoved` 故意不在这一张表里**（2026-09-30 日志 55，上级裁定）。
 *   引擎里"载体不在世界上了"这**一个**事实由 `sweepCarriersGone` 在那**一处**发现，
 *   而那处**分不出**"自然到期"和"被打掉"（要分就得把 `reason` 一路记进台账 ——
 *   另立一片）。⇒ 与其让它进这张表却**永远不触发**（写上去不生效**而且不吭声**，
 *   正是这一整轮在清的那类静默失败），不如**把它留在表外**：
 *   写 `onRemoved` 会拿到校验器那条 `MODIFIER_TRIGGER_NOT_WIRED` 警告，
 *   那句话里直接告诉作者**改写成 `onExpire`**（"载体消失"那个语义就是它）。
 *
 * ⚠ 这张表**不是"计划"，是"今天的事实"**。它存在的唯一理由：
 *   内容里写别的时机**不报错也不生效** —— 那是这个项目列为最危险的一类静默失败。
 *   校验器拿它报一条**警告**（`MODIFIER_TRIGGER_NOT_WIRED`），
 *   把"写上去不生效"变成一句人话。
 *
 * ⚠ **接线了新的时机就改这一张表**（然后校验器自动跟着对）——
 *   别在别处再抄一份。
 */
export const WIRED_TRIGGER_EVENTS: readonly TriggerEvent[] = [
  'onLowHp', 'onTick', 'onCast', 'onExpire',
]

export { forgetModifierState } from './mod-state.ts'
/**
 * **已经触发过**的修饰副本（边沿检测用）—— 状态住在 `mod-state.ts` 里。
 *
 * ⚠ 为什么需要边沿检测：`onTick` 上写的条件是"**现在**成不成立"
 *   （`hpBelow 0.3` 在残血时**每 tick** 都成立）。不记上一次的话，
 *   一个常驻术式会在残血的每一帧都放一次盾 —— 那不是"跨过危险线给一次"，
 *   而是"残血期间无限刷"。旧「背水」的语义是**跨过**（`fireLowHp` 的实现
 *   和它的 `_comment_semantics` 都写死了这一条），拆解时**原样保住**。
 */

/**
 * 跑一个实体的**某一份常驻术式**里、某个时机上的全部触发副本。
 *
 * @param when      这次是哪个时机（必须是 `TriggerEvent` 里已有的值）
 * @param hitPoint  这个时机带的位置（命中位置 / 失效位置）。没有就不传
 *
 * ⚠ 它**只跑符合 `when` 的那些副本**：同一个实体身上可以同时挂着
 *   "盯血量的"和"每 tick 掉血的"，它们由各自的时机分开驱动。
 */
export function runModifierTriggers(
  world: World,
  owner: Entity,
  technique: CompiledTechnique,
  when: TriggerEvent,
  hitPoint?: { x: number; y: number },
): void {
  /*
   * ⚠ ---- **哪些段里的触发器会被驱动** ----
   *
   *   判据是"**这一段的第一个技能被修饰了**"（段里有 `at: 0` 的副本），
   *   而**不是** `constantSegments`。两个理由：
   *
   *   1. `constantSegments` 说的是"**这一段不参与按键激活**"，
   *      它只由 `wrap` 产生 —— 而一个**纯监测器**的段（比如「背水」：
   *      监测 + 撑盾，没有 wrap）照样该被驱动。
   *      拿 `constantSegments` 当判据的话，「背水」一辈子不会触发
   *      （踩过：日志 48 的第一版就是这么写的，第 21 节当场抓到）。
   *   2. `at: 0` 正是"它修饰后面那个技能"那个位置 ——
   *      只有它对应的副本才该影响这一段的第一个技能。
   *
   *   ⚠ 非常驻段（玩家按出来的那一段）要不要驱动触发器**今天没有裁定**
   *     （报告第 5 节）。今天的做法是**驱动**（判据只看 `at: 0`）——
   *     因为"按一下，然后它自己触发下一段"和"常驻着它自己触发"在
   *     引擎里是同一件事，而**多驱动**总比"写了不生效"好。
   */
  driveModifierCopies(world, owner, technique, when, (mod) => ({
    ok: evaluateAll(conditionOf(mod), contextOf(world, owner)),
  }), { hitPoint })
}

/**
 * 「这一份副本过不过」的答案。
 *
 * ⚠ 为什么不是一个 `boolean`：「载体消失」那条路要顺手把**生成位置**
 *   换成载体倒下的那一处（那就是 `prevEndPoint` 的字面意思 ——
 *   schema 里写着"失效位置"）。把点位塞进返回值里，两条路的差别就只有这一处，
 *   遍历 / 认 `at: 0` / 解算名单那些**一个字都不用抄第二遍**。
 */
interface ModGate {
  /** 过不过（各条路自己的判据） */
  ok: boolean
  /** 过了而且**换生成位置**（不填 = 用调用方给的那个点） */
  point?: { x: number; y: number }
}

/**
 * **这一次触发手里拿着的东西**（2026-09-30 日志 62 收成一个包）。
 *
 * ⚠ 为什么不继续加形参：`driveModifierCopies` → `fireModifier` → `resolveOrigin`
 *   三层都要把这两样**原样传下去**，而它们**只在 `resolveOrigin` 里被读**
 *   （一个决定"生成在哪"、另一个决定"朝哪"）。合成一个包之后，
 *   将来再加一样"这次触发带的东西"只改这一个接口。
 */
interface TriggerContext {
  /** 这个时机带的位置（命中位置 / 失效位置）。没有就不传 */
  hitPoint?: { x: number; y: number }
  /**
   * ---- **触发这个技能的那次施法的意图**（`origin: 'aim'` 读它，日志 62）----
   *
   * ⚠ 四条驱动路径里**只有「载体消失」拿得到**（那次施法写在载体台账里）。
   *   `onLowHp` / `onTick` / `onCast`（挂载）**没有"那一次施法"** —— 它们保持
   *   `undefined` ⇒ `origin: 'aim'` 在那些路上**什么都不做**。
   *   ⚠ **不许**退化成"最近的敌人"（那是日志 48 起的旧行为，玩家 2026-09-30 否掉了）：
   *     一个**猜出来**的点比"什么都不做"坏得多（玩家看不见这个点是猜的）。
   */
  intent?: CastIntent
}

/**
 * 驱动一份术式里**匹配某个时机**的触发副本（唯一一处遍历 + 解算名单）。
 *
 * ⚠ 抽出来是因为「载体消失」那条路（`sweepCarriersGone`）要走**同一套**：
 *   遍历哪几段、认 `at: 0`、名单怎么解算（技能 id + 激活方式）——
 *   两处各写一遍的话，迟早漂移，而漂移的表现是"某个时机静默不触发"。
 */
function driveModifierCopies(
  world: World,
  owner: Entity,
  technique: CompiledTechnique,
  when: TriggerEvent,
  gate: (mod: CompiledMod) => ModGate,
  ctx: TriggerContext,
): void {
  const segments = technique.segments ?? []

  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si]
    if (seg === undefined) continue
    const mods = seg.mods ?? []
    if (!mods.some(m => m.targetIndex === 0)) continue
    for (const mod of mods) {
      if (mod.targetIndex !== 0) continue
      if (mod.when !== when) continue
      if (mod.kind !== 'trigger' && mod.kind !== 'monitor') continue
      const pass = gate(mod)
      if (!pass.ok) continue
      /*
       * ⚠ 名单在**这一刻**解算（技能 id + 激活方式）：老的那条路手里
       *   本来就有"这一段"（`seg.technique`），解出来就是 `fireModifier`
       *   要的那份 `CarrierOrigin`。载体那条路在记录载体时做同一件事。
       */
      const skillId = seg.technique.skillIds[mod.targetIndex]
      if (skillId === undefined) continue
      fireModifier(world, owner, {
        technique: seg.technique,
        /*
         * ⚠ 这条路手里拿的就是 `technique`（调用方传进来的那份，本来就是容器）
         *   —— 段是自己遍历出来的，容器就是它。
         */
        container: technique,
        skillId,
        activation: seg.technique.activation,
        casterId: owner.id,
      }, mod, {
        hitPoint: pass.point ?? ctx.hitPoint,
        /*
         * ⚠ **意图照原样传下去**（`pass` 里没有它 —— 它属于"那一次施法"，
         *   不属于"这一份副本过不过"）：载体那条路在 `driveModifierCopies`
         *   的调用处把它交进来，别的三条路根本不传。
         */
        ...(ctx.intent === undefined ? {} : { intent: ctx.intent }),
      })
    }
  }
}

/**
 * 「**载体消失**」那一档：`world.ts` 第 11 步调它（这次施法放出去的东西
 * 不再活着的那一刻）。
 *
 * ## 为什么需要"施法结果上下文"
 * 老那三个时机（`onLowHp` / `onTick` / `onCast`）驱动时，手里就有"哪一份术式、
 * 哪一段"；而"载体后来怎么样了"这件事发生在**很多 tick 之后**，那时候施法早
 * 已经结束（`pruneCasts` 把它移出了 `world.casts`）。所以台账
 * （`mod-state.ts` 的 `CarrierOrigin`）在**载体被造出来那一刻**就把
 * "术式 + 技能 id + 激活方式 + 施法者"记下来 —— 这里只管把它交给同一条触发路径。
 *
 * ## ⚠⚠ 判据（两条纪律，缺一条就变成"静默的错行为"）
 *
 *  ① **一次载体都没有长过的施法 ⇒ 什么都不发生**。判据是 `allCarriersGone`
 *     里的 `carrierBegun`：一个技能**一个载体都没长过**（瞬时载体 / 还没放出去 /
 *     施法被打断在半路）时，"载体消失"这件事**压根没发生过** ——
 *     ⚠ **不许猜、也不许退化成"立刻触发"**（和"没目标就不发生"是同一条纪律）。
 *
 *  ② **`condition` 不写的副本才归这条路**。写了条件的副本仍然由它自己那条
 *     时机驱动、在那些时机上求值 —— 玩家写的条件**一个字都不改语义**。
 *     ⚠ 不这么分的话，「载体消失」这条默认值会把一个写着
 *     `condition: {}`（恒不成立）的副本**救活** —— 那是明确的"永不通过"。
 *
 * ## ⚠ 多载体：**全部消失**才算（`allCarriersGone`，待玩家裁定）
 * 语义和理由写在 `mod-state.ts` 那个函数的头上（引信烧到最后一个 + 和既有的
 * 「份数」机制用同一个答案）。裁定下来**只改那一个函数**。
 */
export function sweepCarriersGone(world: World): void {
  /*
   * ⚠ 先把"这一次该问哪些施法"收成**一个集合**再处理。
   *
   *   直接边遍历边处理的话，同一次施法的第二个载体也会各问一遍
   *   `allCarriersGone` —— 它靠 `gone` 那张表只回答第一次，所以结果是对的，
   *   但"这一次施法要问几遍"取决于它有几个载体，读起来像碰运气。
   */
  const castIds: number[] = []
  for (const row of expiredCarriers(world)) {
    if (!castIds.includes(row.castId)) castIds.push(row.castId)
  }

  for (const castId of castIds) {
    if (!allCarriersGone(world, castId)) continue
    const origin = carrierOriginOf(world, castId)
    /*
     * ⚠ 载体比施法者活得久是**正常**的（放完火球人就被打死了）——
     *   施法者不在 / 已经死了 ⇒ 它身上挂不了触发副本，什么都不发生。
     *   ⚠ 尤其**不许**换成"由载体自己触发"：那会让一个死了的人继续放技能。
     */
    if (origin === undefined) continue
    const owner = world.entities.find(e => e.id === origin.casterId)
    if (owner === undefined || !owner.alive) continue

    const at = carrierPointOf(world, castId)
    /*
     * ⚠⚠ 遍历的是**容器**那一份（`origin.container`），**不是** `origin.technique`：
     *   修饰副本住在容器的 `segments[].mods` 上，而段那份里 `segments` 是空的
     *   ⇒ 拿段那份去遍历会得到一个空数组、触发器**永远不响而且一声不吭**。
     *   （这一片真踩过，见 `CarrierOrigin.container` 那段。）
     */
    driveModifierCopies(world, owner, origin.container, 'onExpire', (mod) => ({
      ok: carrierGoneConditionsOf(mod),
      ...(at === undefined ? {} : { point: at }),
    }), {
      hitPoint: at,
      /*
       * ⚠⚠ ---- **"触发这个技能的那次施法"的意图**（2026-09-30 日志 62）----
       *
       *   它就是**长出这个载体的那一次施法**（玩家原话："取**按下技能那一刻**的瞄准"）。
       *   台账在载体被造出来那一刻把它抄下来了 —— 这里只是转交，**不查世界**
       *   （施法早结束了，查不到；见 `CarrierOrigin.intent`）。
       *
       *   ⚠ `origin.intent` 缺了（老形状的台账 / 手改的数据）⇒ 不传 ⇒
       *     `origin: 'aim'` 什么都不做（和"监测器那条路"同一个结果）。
       */
      ...(origin.intent === undefined ? {} : { intent: origin.intent }),
    })
  }
}

/**
 * 「载体消失」这条路的台账留在**哪一个技能**上、以及它的来历。
 *
 * ⚠ 载体是从**哪一个技能**长出来的，在"它消失"这一刻已经问不出来了
 *   （施法早结束了）—— 所以台账在记录时就把它记下来（`mod-state.ts`）。
 *   这里只是把"这次施法的那笔"取回来。
 */
function carrierOriginOf(world: World, castId: number): CarrierOrigin | undefined {
  for (const row of expiredCarriers(world)) {
    if (row.castId === castId) return row.origin
  }
  return undefined
}

/** 载体倒下的那一处（`prevEndPoint` 的字面意思） */
function carrierPointOf(world: World, castId: number): { x: number; y: number } | undefined {
  for (const row of expiredCarriers(world)) {
    if (row.castId !== castId) continue
    const e = world.entities.find(x => x.id === row.entityId)
    if (e === undefined) continue
    return { x: e.pos.x, y: e.pos.y }
  }
  return undefined
}

/**
 * 「**载体消失**」这一档的判据：**没写条件**的副本才归它。
 *
 * ⚠ 这就是日志 54 那条 `MODIFIER_CONDITION_REQUIRED`（"触发器必须写条件"）
 *   可以松掉的**全部理由**：不写条件**不再是**"永不触发"，而是
 *   玩家点名的默认值「载体（前一个技能）消失」（Noita 那种引信）。
 *   ⇒ 判据因此从"必须有条件"变成"有条件就照它求值、没条件就是载体消失"。
 *
 * ⚠ 名字里的复数是有意的：一段里可以挂**好几份**副本，各自可能写、可能不写。
 */
function carrierGoneConditionsOf(mod: CompiledMod): boolean {
  /*
   * ⚠ 先看"写了没有"（`hasConditionOf`），**不是**直接求值：
   *   不写 = 这条默认值，写 = 由它自己那条时机驱动（不归这条路）。
   *   两件事混起来的话，`condition: {}` 会被"不写 = 载体消失"救活 ——
   *   而 `{}` 是一个明确的"永不通过"（见 `hasConditionOf` 那段）。
   *
   * ⚠ **这里还没有用到"载体是从哪个技能长出来的"**：遍历本身定位了那段
   *   （`at: 0` 的那个技能就是长载体的那个）。等裁定下来"同一次施法里
   *   多个技能怎么分"时，判据要读 `CarrierOrigin.skillId` ——
   *   那是**待裁定项**（报告第 5 节），台账里已经记着，不用再加一笔。
   */
  return !hasConditionOf(mod)
}

/**
 * 一份常驻术式**挂上**的时候：跑 `onCast` 那一类触发副本一次。
 *
 * ⚠ 它和 `setTechniqueActive` 里那条"auto 术式的 onCast 规则挂上就跑一次"
 *   是**同一条规矩**（`cast.ts` 里写了理由：没有"按一下"这一刻，
 *   装备代价就永远不落地）。触发器也一样 —— 不跑一次的话，
 *   "装上时放一个护盾"这类写法**永远不会发生**。
 */
export function runModifierOnEquip(world: World, owner: Entity, technique: CompiledTechnique): void {
  forgetModifierState(world, owner.id)
  runModifierTriggers(world, owner, technique, 'onCast')
}

/** 一个修饰副本的条件（不写 = 恒成立） */
function conditionOf(mod: CompiledMod): Condition[] {
  return mod.condition === undefined ? [] : [mod.condition]
}

/**
 * 「这个修饰副本**写了**条件吗」—— ⚠ 它和"条件成不成立"是两件事。
 *
 * 分这两种的**唯一理由**是玩家点名的默认值：「**载体消失**」是**不写条件**时的语义，
 * 而不是又一个条件类型。所以：
 *   · 没写 `condition` ⇒ 这次驱动它的是"**载体没了**"；
 *   · 写了（哪怕写的是 `{}`）⇒ 照老规矩在**这次驱动**上求值。
 * ⚠ 不分开的话，一个写着 `condition: {}`（恒不成立）的副本会被
 *   "不写 = 载体消失"那条默认值**救活** —— 而 `{}` 是一个明确的"永不通过"。
 */
function hasConditionOf(mod: CompiledMod): boolean {
  return mod.condition !== undefined
}

/**
 * 条件求值的上下文。
 *
 * ⚠ `target` 取"最近的敌人" —— 监测器的条件里有一半是关于**目标**的
 *   （`hasStatusTag` / `stackAtLeast` / `distanceIs`）。
 *   不给 target 的话那些条件**恒为 false**，而表现是"我写了条件，它不触发"。
 *   ⚠ 这一条**没有裁定过**（"监测器要不要能盯别人"）：今天的取法是
 *   "最近的敌人"，记在报告第 5 节里。`who: 'self'` 的条件不受影响
 *   （`pick()` 按 `who` 选人）。
 */
function contextOf(world: World, owner: Entity): { world: World; self: Entity; target?: Entity } {
  let best: Entity | undefined
  let bestD = Number.POSITIVE_INFINITY
  for (const e of world.entities) {
    if (!e.alive || e.id === owner.id) continue
    if (e.faction === owner.faction) continue
    const dx = e.pos.x - owner.pos.x
    const dy = e.pos.y - owner.pos.y
    const d = dx * dx + dy * dy
    if (d < bestD) {
      bestD = d
      best = e
    }
  }
  return best === undefined
    ? { world, self: owner }
    : { world, self: owner, target: best }
}

/**
 * 把**一个技能**编成一份可以 `activate` 的产物。
 *
 * ⚠ 为什么走 `activate()` 而不是自己跑规则：
 *   · 「代价按每次触发结算」这条要求**在 `activate` 里已经实现了**
 *     （能量、冷却、血契、被打断…）—— 自己再写一遍就是**第二套规矩**，
 *     而两套迟早漂移（漂移的表现是"触发出来的技能不扣能量"）；
 *   · `activate` 是 AI / 客户端 / 序列共用的那一条路，触发器接上去，
 *     "触发出来的技能"和"按出来的技能"在引擎里就是**同一种东西**。
 *
 * ⚠ 它**不进世界**（`registerTechnique` 不调它）：
 *   产物是每次触发现造的临时对象，和"段自己的编译产物"不是一回事 ——
 *   段那份是**冷却键**和 HUD 认身份的东西（`cd.<段id>`），
 *   而这份只是"把技能的时间轴接起来跑一遍"。
 */
function skillTechnique(
  template: CompiledTechnique,
  segment: CompiledSegment,
  skillId: string,
): CompiledTechnique | undefined {
  const step = stepOf(template, segment, skillId)
  if (step === undefined) return undefined
  return {
    id: `${template.id}#${skillId}`,
    name: step.name,
    /*
     * ⚠ 激活方式照抄"这个技能所在那一段"的 —— 它只影响
     *   `setTechniqueActive` 里那条 onCast 分支，而这里**不走那一条**。
     *   抄一份是为了让类型完整（读的人少一条分支），不是因为引擎会读它。
     */
    activation: template.activation,
    targeting: step.targeting,
    phases: step.phases,
    rules: step.rules,
    ruleSlots: step.ruleSlots,
    skillIds: [skillId],
    links: [],
    bloodPactCost: 0,
  }
}

/** 触发出来的技能的时间轴：从段的编译产物里**切出那一个技能** */
function stepOf(
  template: CompiledTechnique,
  segment: CompiledSegment,
  skillId: string,
): { name: string; targeting: CompiledTechnique['targeting']; phases: CompiledTechnique['phases']; rules: CompiledTechnique['rules']; ruleSlots: number } | undefined {
  const inner = segment.technique
  if (!inner.skillIds.includes(skillId)) return undefined

  const prefix = `${skillId}#`
  const phases = inner.phases.filter(p => p.id.startsWith(prefix))
  const rules = inner.rules.filter(r => r.id.startsWith(prefix))

  /*
   * ⚠ 技能查不到（编译时 `UNKNOWN_SKILL`）会有 `skillIds` 里没有它的情形 ——
   *   上面那一条 `includes` 已经挡掉了。这里再挡一次"一个阶段都没有"：
   *   那种技能触发出来是**空的**，`activate` 会立刻算作放完并推进链
   *   （`cast.ts` 里写明了那是**行为改变**，不是兼容），所以宁可不触发。
   */
  if (phases.length === 0) return undefined

  return {
    name: skillId,
    targeting: inner.targeting,
    phases,
    rules,
    ruleSlots: 0,
  }
}

/**
 * 触发一次：条件成立之后，真的把那个技能放出去。
 *
 * ⚠ 顺序：**先记下"这一次的点"再放** —— 放出来的技能自己的
 *   `deliveryFired` / `damaged` 事件是**后面**才发生的，
 *   而"上一个点"要的是**触发它的那个技能**留下的点，
 *   拿刚放出去的那个技能的点会把两个概念混成一个。
 *
 * ⚠ `origin` 是"**被触发的那个技能是谁**"（术式 + 技能 id + 激活方式）。
 *   两条驱动路径给的形状不一样，所以**记在施法那一刻**：
 *   · 「载体消失」那条路手里只有载体台账（`CarrierOrigin`）——
 *     它一份术式引用都没有地方可查（序列段不在 `world.techniques` 里）；
 *   · 老的三个时机手里是"这一次调用的那一份术式 + 那一段"。
 *   两条路都在自己那一侧把 `CarrierOrigin` 拼好，这里只管放。
 *
 * ⚠ 形参叫 `who` 而不是 `origin`：下面 `resolveOrigin(...)` 那个 `origin`
 *   是"这一次该生成在**哪个点**"（`TriggerOrigin` 四选一），两件事一个字都不能混。
 */
function fireModifier(
  world: World,
  owner: Entity,
  who: CarrierOrigin,
  mod: CompiledMod,
  ctx: TriggerContext,
): void {
  if (!owner.alive) return

  const skillId = who.skillId
  if (skillId === '') return

  /*
   * ⚠ 触发出来的技能照抄**被触发的那个技能**的激活方式 ——
   *   它只影响 `setTechniqueActive` 里那条 onCast 分支，而这里**不走那一条**。
   *   抄一份是为了让类型完整（读的人少一条分支），不是因为引擎会读它。
   */
  const step: CompiledTechnique = {
    id: `${who.technique.id}#${skillId}`,
    name: skillId,
    activation: who.activation,
    targeting: who.technique.targeting,
    phases: who.technique.phases.filter(p => p.id.startsWith(`${skillId}#`)),
    rules: who.technique.rules.filter(r => r.id.startsWith(`${skillId}#`)),
    ruleSlots: 0,
    skillIds: [skillId],
    links: [],
    bloodPactCost: 0,
  }
  /*
   * ⚠ 时间轴切出来是**空的**（一个阶段都没有）时**不触发**，和老的路径同一条规矩：
   *   `activate` 对空时间轴是"当场算放完"，而"当场放完"会抢着去推进连段链。
   *   一个正常的技能至少有一个阶段，所以这一步只在内容坏掉时走得到。
   */
  if (step.phases.length === 0) return

  /*
   * ⚠ ---- 边沿检测（`crossing`）：**一次跨线只触发一次** ----
   *
   *   为什么**不管是谁驱动的**都要过这一道：
   *     · `onTick` 那条路上条件说的是"**现在**成不成立"
   *       （`hpBelow 0.3` 在残血时每 tick 都成立）—— 不过这一道就是
   *       "残血期间无限刷盾"；
   *     · `onLowHp` 那条路上，`fireLowHp` 已经做了"跨过"，可它问的是
   *       "**水位**跨过 30%"，而监测器问的是**它自己那个条件** ——
   *       一份术式挂在身上，血量在 30% 上下反复荡的时候，
   *       引擎那条会重复放行（每个"掉到线下"的瞬间都算一次）。
   *     ⇒ 边沿检测放在**这里**（唯一一处），两条路共用同一个判据。
   *
   *   ⚠ 代价（已知，写出来）：监测器触发过之后**不会自己复位** ——
   *     条件离开过再回来也不重置（没有"离开"的时刻可观察，因为驱动它的是
   *     "跨过"那一瞬间）。要"能反复触发"的话得给监测器加一条
   *     "每隔 N 秒也可以"的语义 —— 那是**待裁定项**（报告第 5 节）。
   */
  if (mod.crossing === true) {
    if (!markFired(world, owner, mod)) return
  }
  const place = resolveOrigin(world, owner, mod, ctx)
  /*
   * ⚠⚠ **`engineInternal: true` 不能省**（2026-09-30 日志 54，玩家裁定）：
   *   "施法独占"管的是**玩家的手指**，不是**引擎内部的延续** —— 触发出来的
   *   技能**不受它管**。不传的后果是**静默的**：玩家在施法中途跨过危险线，
   *   撑盾那一下被 `busy` 挡掉，盾**永远不挂**、而且没有任何提示 ——
   *   等于把日志 48 那一整套机制废掉，而玩家报不出这个 bug。
   *
   *   ⚠ 防滥用不在这儿：被触发的技能照旧付自己的代价、照旧记自己的冷却
   *     （`activate` 里那几道**资源与生死**的门一份都不跳）。
   *
   * ⚠ ---- **两个半边都传**（2026-09-30 日志 62）----
   *   玩家要的是"取**触发这个技能的那次施法**的意图（**瞄准点 / 方向**）"：
   *   · `aimPoint` —— 引擎里**唯一**读它的地方是范围类载体（落点）；
   *   · `facing` —— 方向（"按下那一刻朝哪"）。⚠ 不传它的话，一个朝前的技能
   *     会跟着施法者**当前**的朝向走 —— 那正是玩家点名不要的"实时的"那一半。
   *   ⚠ 两个都**没取到**时才什么都不传（技能用它自己那套瞄准）——
   *     这一条和 `caster` 那一档是同一个形状（不钉任何东西）。
   */
  const opts: ActivateOptions = { engineInternal: true }
  if (place.point !== undefined) opts.aimPoint = { x: place.point.x, y: place.point.y }
  if (place.facing !== undefined) opts.facing = { x: place.facing.x, y: place.facing.y }
  const result = activate(world, owner, step, opts)

  if (!result.ok) {
    /*
     * ⚠ **放不出来就说出来**（这一次触发被代价拦住了：能量不够 / 冷却没转好）。
     *   不说的话，玩家看到的是"条件到了但什么都没发生"，而原因
     *   （能量不够 / 那个技能还在冷却）**本来是可以显示的**。
     */
    world.events.push({
      type: 'modifierBlocked',
      entityId: owner.id,
      techniqueId: who.technique.id,
      protoId: mod.source.proto,
      skillId,
      reason: result.reason,
    })
    return
  }

  world.events.push({
    type: 'modifierTriggered',
    entityId: owner.id,
    techniqueId: who.technique.id,
    protoId: mod.source.proto,
    skillId,
    ...(mod.when === undefined ? {} : { when: mod.when }),
    ...(place.point === undefined ? {} : { at: place.point }),
  })

  /*
   * ⚠ 记下这次触发的位置 —— `prevHitPoint` / `prevEndPoint` 两个生成位置
   *   读的就是它（见 `prevPoint` 上面那段"这是权宜"的话）。
   */
  const here = place.point ?? { x: owner.pos.x, y: owner.pos.y }
  rememberPoint(world, owner.id, here)
}

/**
 * 生成位置**四选一**（玩家定的；**2026-09-30 日志 62 改了 `aim` 那一档的口径**）。
 *
 * | 取值 | 落在哪 |
 * | --- | --- |
 * | `caster` | **施法者身上**（这一条还带朝向：不传点，让技能用自己那套瞄准） |
 * | `aim` | **触发这个技能的那次施法的瞄准**（落点 / 方向两个半边）—— 见下 |
 * | `prevHitPoint` | **触发它的那个技能的命中位置**（记在 `prevPoint` 里） |
 * | `prevEndPoint` | **失效位置** ⚠ 这一项的确切含义还没定；今天和上一条同一个点 |
 *
 * ⚠ `caster` 那一条**故意不传点**：它就是要"技能自己那套瞄准"
 *   （对自己 = 落在自己身上；朝前打 = 从自己这儿朝前）。硬塞一个点进去的话，
 *   `hpBelow` 那类自我增益也会被当成"落在某个点上"，行为就变了。
 *
 * ## ⚠⚠ `aim` 那一档：**取那次施法的意图，取不到就什么都不做**（日志 62）
 *
 * 玩家 2026-09-30 原话的意思：
 *   > 触发器的「生成在瞄准的位置」= 取**按下技能那一刻**的瞄准
 *   > （**不是**实时的鼠标位置）；**取不到 ⇒ 什么都不做**，
 *   > **不许**退化成"最近敌人"。
 *
 * ⇒ 这一档读的是 `ctx.intent`（`CarrierOrigin.intent`：那次施法在**按下那一刻**
 *   解算出来的 `aimPoint` / `facing`）。**取不到（`undefined`）⇒ 一个字节都不给**：
 *   · 不传点 ⇒ 落点不由这一档决定（技能按自己那套瞄准走，"没目标就不发生"同理）；
 *   · 不传方向 ⇒ 朝向也不由这一档决定。
 *   ⚠⚠ **旧行为（日志 48 ~ 61）是**：拿 `contextOf(...).target`（"最近的敌人"）
 *     当落点 —— 那是一个**猜出来**的点，而且玩家看不见它是猜的。它**已经删掉**。
 */
function resolveOrigin(
  world: World,
  owner: Entity,
  mod: CompiledMod,
  ctx: TriggerContext,
): { point?: { x: number; y: number }; facing?: { x: number; y: number } } {
  const origin: TriggerOrigin = mod.origin ?? 'caster'

  switch (origin) {
    case 'caster':
      return {}

    case 'aim': {
      /*
       * ⚠⚠ **取"触发这个技能的那次施法"的意图**（2026-09-30 日志 62，玩家裁定）——
       *   取不到 ⇒ **什么都不给**（`{}`），**绝不**退化成"最近的敌人"。
       *
       *   ⚠ 旧行为（日志 48 ~ 61）就是退化成 `contextOf(world, owner).target`
       *     （"最近的敌人"那个方向）—— 那是一个**猜出来**的点：
       *     玩家写的是"瞄准的落点"，而引擎给了"系统挑的那个人身上"，
       *     两者只有在"玩家恰好瞄准了那个最近的人"时才重合，**而且没有任何提示**。
       *
       *   ⚠ **两个半边都要传**（玩家原话里的"瞄准点 / 方向"）：
       *     · 有落点 ⇒ 带点（范围类载体的中心由它决定）；
       *     · 方向**一定**有（`CastIntent.facing` 不是可选的）⇒ 一定带上。
       *   ⚠ 只有点、没有方向的施法不存在（`facing` 每次施法都有），所以这里
       *     不存在"只传点"的分支 —— 那种形状会让 `CastIntent` 的两栏看起来可以各自缺席。
       */
      const intent = ctx.intent
      if (intent === undefined) return {}
      return intent.point === undefined
        ? { facing: { x: intent.facing.x, y: intent.facing.y } }
        : {
            point: { x: intent.point.x, y: intent.point.y },
            facing: { x: intent.facing.x, y: intent.facing.y },
          }
    }

    case 'prevHitPoint':
    case 'prevEndPoint': {
      const hitPoint = ctx.hitPoint
      const p = lastPointOf(world, owner.id)
      if (p !== undefined) return { point: { x: p.x, y: p.y } }
      if (hitPoint !== undefined) return { point: { x: hitPoint.x, y: hitPoint.y } }
      return {}
    }

    default:
      return {}
  }
}

/**
 * 一个实体身上**全部**常驻术式的指定时机（给 `world.ts` 第 6 步用）。
 *
 * ⚠ 它只看 `activeTechniques`（挂上的那些）—— 没挂上的术式里那些触发副本
 *   **不该跑**（"装上就一直在盯"的前提是**装上了**）。
 */
export function tickModifierTriggers(world: World, when: TriggerEvent): void {
  for (const e of world.entities) {
    if (!e.alive || e.activeTechniques.length === 0) continue
    for (const id of e.activeTechniques) {
      const tech = world.techniques.get(id)
      if (tech === undefined) continue
      /*
       * ⚠ 只跳过"**一个副本都没有**"的术式（绝大多数术式都是这种）——
       *   那是一个纯性能上的筛子，不是判据。判据在 `runModifierTriggers` 里。
       *   在这里顺手按 `mods` 筛（而不是按 `constantSegments`）：
       *   后者只由 `wrap` 产生，用它会漏掉纯监测器的术式。
       */
      if ((tech.mods ?? []).length === 0 && (tech.segments ?? []).every(s => (s.mods ?? []).length === 0)) {
        continue
      }
      runModifierTriggers(world, e, tech, when)
    }
  }
}

// ============================================================================
//  「份数」类修饰的执行器：多重释放 / 一分为 X（2026-09-21 日志 51）
// ============================================================================
//
//  ⚠ **为什么和触发器住在同一个文件**：它们是同一类东西的两种落地 ——
//    "一次激活里的施法个数"和"条件到了就放一个"都要
//    **把某一个技能单独编成一份可以 `activate` 的产物**（`skillTechnique` / `stepOf`），
//    而那两段（"切出这一个技能的时间轴"）只有一份。抄到另一个文件里，
//    迟早一边改了另一边没改（表现是"触发器放出来的技能扣冷却、份数放出来的不扣"）。
//
//  ⚠ **代价一分不少**：这里**不碰任何资源**，只是 `activate()` 的另一个调用方 ——
//    所以"蓝耗按份数乘"根本不需要专门写一行：X 份就是 X 次激活，
//    每一次各付自己那一份（和触发器那句"常驻 ≠ 免费"是同一条规矩）。

/**
 * 这一次激活要**一起打出去**的技能：按段里的技能下标列出（**可以有重复**）。
 *
 * ⚠ 重复就是「一分为 X」的份数 —— 它是**同一个技能**打 X 次，
 *   而「多重释放」是**不同的技能**各一次。两者合成一个"下标列表"
 *   之后，运行期只有一条路（"把列表里每一个都激活一遍"），
 *   不需要在施法那一层再分叉。
 */
export interface GroupPlan {
  /** 技能在这一段编译产物里的下标（`segment.technique.skillIds` 的位置） */
  skillIndices: number[]
  /** 是哪几个修饰副本引起的（报错 / 事件 / 报告用） */
  protoIds: string[]
}

/**
 * 这一段有没有「份数」类修饰 → 这一次激活要打哪几份。
 *
 * ## 算法（和玩家那段规格一条一条对应）
 *
 * **只有 `targetIndex === 0` 的副本算数**（和触发器 / 监测器同一个限制）：
 * 引擎落地"一次激活打出好几份"的地方是**段的第一份施法**，
 * 而 `at > 0` 要"先按顺序跑前面那几个、再把后面那几个一起打出去"
 * —— 那是"一次激活里两条时间轴"，另一件事（校验器会给警告，不静默）。
 *
 * 1. **一分为 X**：把 `skillIds[0]` 排 **X** 遍。
 * 2. **多重释放**：从 `skillIds[0]` 起数 **N 个互不相同**的技能（跳过重复的 id），
 *    但**第 0 个已经在上面那一份里了** ⇒ 只把剩下的 `N − 1` 个接在后面。
 * 3. 两个都在 ⇒ 一共 `X + (N − 1)` 份（**相加**，不是相乘 —— 理由见日志 51：
 *    A 在"N 个不同技能"里已经算过一份，相乘会把同一个技能数两遍）。
 *
 * ⚠ 这一段里的技能**不够 N 个**时**照实打**（有几个打几个，不报错）：
 *   账也按实际份数收（`pricing.ts` 单独数，两边用的是**同一句**判据）。
 */
export function groupPlanOf(segment: CompiledSegment): GroupPlan | undefined {
  const mods = (segment.mods ?? []).filter(
    m => m.targetIndex === 0 && (m.kind === 'multi' || m.kind === 'split'),
  )
  if (mods.length === 0) return undefined

  const ids = segment.technique.skillIds
  if (ids.length === 0) return undefined

  const multi = mods.find(m => m.kind === 'multi')
  const split = mods.find(m => m.kind === 'split')
  const indices: number[] = []

  /*
   * ---- 1. 一分为 X：同一个技能排 X 遍 ----
   *
   * ⚠ `count` 是**编译期读好并夹到上限**的那个数（`CompiledMod.count`）——
   *   运行时不再查原型表（sim 里没有内容层）。
   *   取不到（老编译产物 / 手改的数据）时按 **2** 份：那正是玩家定的默认值。
   */
  const x = split?.count ?? 2
  const copies = split === undefined ? 1 : Math.max(1, Math.floor(x))
  for (let i = 0; i < copies; i++) indices.push(0)

  /*
   * ---- 2. 多重释放：再带上 N − 1 个**不同**的技能 ----
   */
  if (multi !== undefined) {
    const n = Math.max(1, Math.floor(multi.count ?? 2))
    const seen = new Set<string>()
    let picked = 0
    for (let k = 0; k < ids.length && picked < n; k++) {
      const id = ids[k]
      if (id === undefined || seen.has(id)) continue
      seen.add(id)
      picked++
      // 第 0 个已经在上面那一份（或那 X 份）里了，不重复排
      if (k === 0) continue
      indices.push(k)
    }
  }

  if (indices.length === 0) return undefined
  return { skillIndices: indices, protoIds: mods.map(m => m.source.proto) }
}

/**
 * 把「份数」类修饰要的那几份**一起打出去**（多重释放 / 一分为 X）。
 *
 * ## 为什么是"起 N 个施法"，而不是"一个施法里放 N 个技能"
 *
 * 阶段机是**一条线**（`phases` 顺序跑），"同时"在它里面说不出来 ——
 * 一个施法里塞 N 个技能只会变成"N 个技能排着队放"。
 * 所以"同一次激活"落地成 **N 个各跑各的施法实例**，它们：
 *   · 在**同一个 tick** 里开始（所以是"一起打出去"）；
 *   · 共用**同一个意图**（同一份 `opts` ⇒ 同一个朝向 / 落点 / 锁定目标，
 *     由各自的技能去解释，见定稿 §九）；
 *   · 各自付**自己的**能量和冷却（份数不是免费的）。
 *
 * ## 三道必须做的事（少一道就是静默的坏行为）
 *
 * 1. **代价先加起来判一次**：不这么做的话，蓝刚好够前两份时，
 *    第三份会在 `activate` 里失败 —— 玩家看到"三份里出来了两份"，
 *    而且不知道是为什么。这里**全有或全无**。
 * 2. **每一份都挂同一个 `activation` 记号**（`CastInstance.activation`）：
 *    "这一段什么时候算结束"一次激活只能发生一次（见 `onSequenceEnd`）。
 * 3. **冷却键用段自己的 id**（不是 `段id#技能id`）：这一段冷却了就是冷却了，
 *    HUD / `peekSequence` 问的也是段那一格 —— 一份一个键的话，
 *    "多重释放打出 3 个"会变成"这一段永远不冷却"。
 *
 * ⚠ 空时间轴的技能（一个阶段都没有）**不参与**：`activate` 对它是"当场算放完"，
 *   而在这一组里"当场放完"会让它抢在兄弟之前去推进连段链
 *   （`onSequenceEnd` 靠 `activation` 记号码兄弟，可那一下还没轮到它们建出来）。
 *   一个正常的技能至少有一个阶段，所以这条路只在内容坏掉时走得到。
 */
export function activateGroup(
  world: World,
  caster: Entity,
  template: CompiledTechnique,
  segment: CompiledSegment,
  plan: GroupPlan,
  opts: ActivateOptions,
): ActivateResult {
  /** 这一组的记号：**第一份那次施法的 id**（自己就是第一份时正好相等） */
  const activation = world.nextCastId

  const members: CompiledTechnique[] = []
  for (const index of plan.skillIndices) {
    const member = groupMemberOf(template, segment, index)
    if (member !== undefined) members.push(member)
  }

  if (members.length === 0) {
    world.events.push({
      type: 'modifierBlocked',
      entityId: caster.id,
      techniqueId: template.id,
      protoId: plan.protoIds[0] ?? 'mod.unknown',
      skillId: segment.technique.skillIds[0] ?? '',
      reason: 'unknown',
    })
    return { ok: false, reason: 'unknown' }
  }

  /*
   * ---- 1. 代价**先加起来判一次**（全有或全无）----
   *
   * ⚠ 只加"能量"和"血契"这两条**资源**账；生死 / 沉默 / 冷却由每一份自己的
   *   `activate` 去判（前两条是**每一份都照判**的，见 `sameActivation` 的注释）。
   *   加总之后判一次够不够，等价于"逐个判也都能过"：
   *   `E ≥ e1+e2+…` ⇒ 付完 e1 之后 `E−e1 ≥ e2+…` ⇒ 每一份都过得去。
   */
  let needEnergy = 0
  let needBloodPact = 0
  for (const m of members) {
    needEnergy += totalEnergyCost(m)
    needBloodPact += m.bloodPactCost
  }
  if (needEnergy > 0 && getStored(caster, 'char.energy.current') < needEnergy) {
    world.events.push({
      type: 'castBlocked', casterId: caster.id, techniqueId: segment.technique.id, reason: 'energy',
    })
    return { ok: false, reason: 'energy' }
  }
  if (needBloodPact > 0 && bloodPactOf(caster) < needBloodPact) {
    world.events.push({
      type: 'castBlocked', casterId: caster.id, techniqueId: segment.technique.id, reason: 'bloodPact',
    })
    return { ok: false, reason: 'bloodPact' }
  }

  /*
   * ---- 1.5 **「排布」：把这几份摆到不同位置 / 方向**（2026-09-30 日志 53）----
   *
   * ⚠⚠ 它**只读**上面那份 `plan.skillIndices`（"已经存在的那几份"）——
   *   返回的数组长度**一定**等于份数，所以"排布不改份数"这条硬界线
   *   在代码形状上就成立（不是靠自觉）。
   *
   * ⚠ 它在**代价加总之前**算：排布只动意图 / 落点，一个代价字段都不碰，
   *   所以放在哪一步都不影响账 —— 放在这里是因为它**不改世界**（纯计算），
   *   万一将来有人在里面读世界状态，位置在"判够不够"之前更容易被发现。
   *
   * ⚠ 圆心用**施法者那一刻的位置**（`caster.pos`）："分布在施法者周围一圈"
   *   说的就是"绕着他" —— 用别的东西当圆心（比如解算出来的落点）会让
   *   一个点地面技能把自己摆在**目标点**周围，那不是玩家要的。
   */
  const placements = layoutPlanOf(segment, aimIntentOf(opts), plan.skillIndices.length, caster.pos)

  /*
   * ---- 2. 每一份都激活一遍 ----
   *
   * ⚠ `sameActivation: true` ⇒ 冷却 / `busy` / `locked` 这三道"别人占着"的门槛
   *   只判第一份（见 `ActivateOptions.sameActivation`）。
   *   资源和生死**一份都不跳**。
   */
  let first: CastInstance | undefined
  for (let i = 0; i < members.length; i++) {
    const m = members[i]
    if (m === undefined) continue
    const r = activate(world, caster, m, placementOptionsOf({
      ...opts,
      /*
       * ⚠ **第一份走完整那道门**（冷却 / `busy` / `locked` 都判），
       *   后面几份才跳过 —— 因为那三道门槛问的是"**别人**占着 / 刚记过"，
       *   而同一次激活的份数不是别人（见 `ActivateOptions.sameActivation`）。
       *   ⚠ 全都跳过是错的：那会让"这一段在冷却"这个判据**整个消失**
       *     （踩过：第二下按下去照样出一组）。
       */
      sameActivation: i > 0,
      activation,
    }, placements[i] ?? {}))
    if (!r.ok) {
      /*
       * ⚠ 走到这里说明"加总判一次"漏掉了什么（比如第一份的中途把施法者弄死了）。
       *   **不装作没事**：把这一份的失败原样报出去，外面（`startSequence`）
       *   会退回段号、玩家看到"这一下没放出来"。已经放出去的那几份**不退还**
       *   （和"早付更便宜"那条定价前提一致：代价不自动退）。
       */
      return { ok: false, reason: r.reason }
    }
    if (first === undefined) first = r.cast
  }

  return first === undefined ? { ok: false, reason: 'unknown' } : { ok: true, cast: first }
}

/**
 * 把段里的**某一个技能**编成一份可以 `activate` 的产物（份数类修饰用）。
 *
 * ⚠ 它和 `skillTechnique`（触发器用的那份）**是同一件事**，只差一个字段：
 *   `id` 取的是**段自己的键**（`segment.technique.id`）——
 *   份数是"这一段的一次激活"，冷却、HUD、`peekSequence` 认的都是段那一格。
 *   用 `段id#技能id` 的话，多重释放打出的 N 个各自记一份冷却，
 *   而**段自己那份永远不被记上** ⇒ 按一下必定出一组（每 tick 按都能放）。
 *
 * ⚠ 时间轴的切法**复用 `stepOf`**（唯一一处）：份数和触发器切出来的
 *   必须是同一份东西，否则"同一个技能"在两条路上会有两种时间轴。
 */
function groupMemberOf(
  template: CompiledTechnique,
  segment: CompiledSegment,
  skillIndex: number,
): CompiledTechnique | undefined {
  const skillId = segment.technique.skillIds[skillIndex]
  if (skillId === undefined) return undefined
  const step = stepOf(template, segment, skillId)
  if (step === undefined) return undefined

  return {
    // ⚠ 段的键（不是 `段id#技能id`）：冷却 / HUD / 界面认的都是它
    id: segment.technique.id,
    name: step.name,
    activation: segment.technique.activation,
    targeting: step.targeting,
    phases: step.phases,
    rules: step.rules,
    ruleSlots: step.ruleSlots,
    skillIds: [skillId],
    links: [],
    /*
     * ⚠ 血契 = 0：血契记在**术式**那一层（`compileTechnique` 给容器的
     *   `bloodPactCost`），段自己那一份本来就写着 0（见 compile.ts）。
     *   在这里再收一次的话，一次"多重释放"会把整招的血契收 N 遍。
     */
    bloodPactCost: 0,
  }
}

// ============================================================================
//  「排布」类修饰的执行器（2026-09-30 日志 53）
// ============================================================================
//
//  ⚠⚠ **两条硬界线**（玩家划的，违反就算做错）——这一节每一个函数都受它们约束：
//
//   1. **只管排布 / 路径，✗ 不管份数**：下面这些函数**只读** `GroupPlan`
//      （"已经存在的那几份"），返回的东西**只有方向 / 位置**，
//      没有一个字段能表达"多来一份"。`activateGroup` 的循环次数
//      完全由 `plan.skillIndices` 决定 —— 排布进不去那个数。
//   2. **不许改瞄准**：它拿到的 `opts.intent` **只有一个**（玩家那一个意图），
//      它做的全部事情是"把**同一个意图**绕施法者转一个角度"。
//      落点（`aimPoint`）只有「环绕」那一档会改，因为"摆到半径 R 那一圈上"
//      这句话本身就是在说位置（见 `layoutPlanOf` 的 ① 那段）。
//
//  ⚠ 为什么执行器住在这个文件：它和「多重释放」/「一分为 X」是**同一个落点**
//    （段的第一份施法，`activateGroup`），而且都要那个"已经算好的份数列表"。
//    抄到另一个文件里，迟早一边改了另一边没改。

/**
 * 这一次激活里，**第 i 份**该摆在哪儿 / 朝哪儿。
 *
 * ⚠ 两个字段都是**可选的覆盖**：不填 = 照原样（"排布不做任何事"是这个零件
 *   合法的结果 —— 比如只有 1 份的时候，见 `layoutPlanOf`）。
 */
export interface LayoutPlacement {
  /** 载体中心要挪到哪儿（只有「环绕」会填） */
  point?: { x: number; y: number }
  /** 这一份的朝向（把**同一个意图**转 `delta` 度之后的单位向量） */
  facing?: { x: number; y: number }
}

/**
 * 这一段有没有「排布」副本 → 这一次激活里的每一份摆在哪儿。
 *
 * ## 算法（和玩家那段规格一条一条对应）
 *
 * `mods` 里挑 `targetIndex === 0` 的排布副本（**和份数类同一个限制**：
 * 引擎落地"一次激活打出好几份"的地方是段的第一份施法，见文件头）。
 * 摆法的参数**编译期就读好了**（`CompiledMod.layout`）—— 这里不查原型表。
 *
 * `members` 是**已经**算好的份数（`GroupPlan.skillIndices.length`）。
 * ⚠⚠ 它**只是读进来**：返回值一定只有 `members` 项，
 *   而"要不要多来一份"这件事在这个文件里**没有任何表达方式**。
 *
 * ### ① `ring` 环绕生成 —— 把这几份铺在施法者周围一圈
 *
 * 第 k 份在离施法者 `radius` 米、方位角
 * `aimDir + startAngle + k × (360 / members)` 的地方（`even: false` 时去掉最后那一项 ⇒ 全在同一束）。
 *
 * ⚠⚠ **2026-09-30 日志 61：载体从施法者身上长出来时，这一档什么都不做**
 *   （判据 = 编译期的 `layout.carrierFlies` = `school.ts` 的
 *   `carrierFliesInWorld`）—— 见下面那个早退。
 *
 * ⚠ **它是唯一会挪"载体中心"的一档**（给 `placement.point`）：
 *   "分布在施法者周围"这句话说的就是**位置**，只转方向表达不出来。
 *   · 第 1 份（k = 0）正好落在"朝瞄准方向 `radius` 米"处，
 *     所以**瞄准本身没有被改**（方向照旧，只是这一发从那个点长出来）。
 *     ⚠ **这一条是待玩家裁定的解释**（日志 53 报告第 6 节 c）：
 *       规格里"环绕"三个字本身就带着"摆到别的位置"，所以按字面做了。
 *   · 朝向取**径向向外**（和"摆在周围"自洽：每一份都朝自己那一侧打出去）。
 *     ⚠ 它也会盖住 `locked` / `auto` **解算出来的**朝向 ——
 *       但**不会**改意图（`opts.intent` 还是原来那一个），
 *       下一条的"不改瞄准"指的是**输入那一个意图**。
 *
 * ### ② `fan` 扇形散射 —— 以某个角度散开
 *
 * **落点一个字都不动**（不给 `placement.point`）：几份**以瞄准方向为中心**
 * 均分在 `spread` 度里（第 k 份偏 `-spread/2 + k × spread/(members-1)` 度）。
 * ⚠ 只有方向那一半被改写 —— 这正是"它只是把已经存在的那几份摆到不同方向"。
 *
 * ### ③ `mirror` 反向镜像 —— 同时朝反方向也放一次
 *
 * 交替：偶数份照原样（0 度），奇数份转 `180 + mirrorAngle` 度
 * （默认 `mirrorAngle = 0` ⇒ 正好是玩家说的"反方向"）。
 *
 * ### ⚠ 只有一份时**什么都不做**
 *
 * 见 `members < 2` 那个早退：规格说的是"把**已经存在的那几份**分布在周围"，
 * 而 1 份"分布"无从谈起。给第一份凭空挪个位置是**自己定规矩**，
 * 所以这里返回全 0 度的计划，并把这条写进报告（日志 53 报告第 6 节 a）。
 */
export function layoutPlanOf(
  segment: CompiledSegment,
  intent: AimIntent | undefined,
  members: number,
  origin: { x: number; y: number },
): LayoutPlacement[] {
  /** 什么都不改的计划：`members` 项、每一项都没有覆盖 */
  const none = (): LayoutPlacement[] => {
    const out: LayoutPlacement[] = []
    for (let i = 0; i < members; i++) out.push({})
    return out
  }

  const mod = (segment.mods ?? []).find(m => m.kind === 'layout' && m.targetIndex === 0)
  const layout = mod?.layout
  if (layout === undefined) return none()
  // ⚠ 1 份时"排布"构不成一个动作（只有 1 份没有什么可摆的）
  if (members < 2) return none()

  const mode = layout.mode
  if (mode !== 'ring' && mode !== 'fan' && mode !== 'mirror') return none()

  /*
   * 基准朝向：**玩家那一个意图**里的方向，没有就用施法者的当前朝向。
   *
   * ⚠ 这里**故意不用** `resolveAim` 解算出来的 `cast.facing`（虽然它更"准"）：
   *   解算会把 `locked` / `auto` 的朝向掰向目标，于是"反向镜像"在锁定时
   *   会变成"镜像向目标的方向" —— 而玩家要的是"**我瞄的反方向**"。
   *   意图是**输入**，解算结果是**引擎的解释**；排布只该动输入那一层。
   *   （`origin` 是施法者的位置 —— 它的朝向兜底由调用方在 `facing` 里给，
   *    见 `activateGroup`：那里传进来的意图已经带上了施法者朝向那份兜底。）
   */
  const base = baseDirOf(intent)

  if (mode === 'ring') {
    /*
     * ⚠⚠ ---- **载体从施法者身上长出来 ⇒ 环绕什么都不做**（2026-09-30 日志 61）----
     *
     *   用户定的：`meleeArc` / `self` / `aura` / `beam` / `capsule` 这些载体的
     *   位置**就是施法者**（"长在他身上"），把"载体中心"摆到半径 R 的那一圈上
     *   **没有任何意义** —— 所以这一档对它们**什么都不做**。
     *
     *   ⚠ **不是警告、不是报错**（用户明确划的）：照「追踪」/「弹射」那条规矩，
     *     "这个修饰对这条序列不起作用"由**界面**画在那条序列下方，引擎不出声。
     *     提示由**界面**画（引擎这一侧一行提示都不发）。
     *
     *   ⚠⚠ **判据一行都不新写**：`layout.carrierFlies` 是编译期拿
     *     `school.ts` 的 `carrierFliesInWorld` 算好的（**只有那一处**）——
     *     和「追踪」/「弹射」的警告、以及账本"不收钱"读的是**同一个函数**。
     *
     *   ⚠ **只有 `ring` 这一档受它管**：`fan` / `mirror` 改的是**方向**，
     *     而长在施法者身上的载体照样转得动（一记横扫本来就该能散射 / 镜像）。
     *     用户点的是「**环绕**」那一档，不是整个零件。
     */
    if (!layout.carrierFlies) return none()

    /*
     * ⚠ 半径**不是**方向：它是"多少米"，所以圆心用施法者的位置（`origin`）。
     *   第 1 份正好落在"朝基准方向 `radius` 米"处 —— 那一份的位置
     *   和"从施法者朝瞄向打出去 R 米"是同一个点，所以瞄准没有被改。
     */
    const out: LayoutPlacement[] = []
    for (let i = 0; i < members; i++) {
      const point = layoutRingPointOf(layout, base, origin, i, members)
      out.push({ point, facing: normalize2({ x: point.x - origin.x, y: point.y - origin.y }) })
    }
    return out
  }

  const offsets = layoutOffsetsOf(layout, members)
  const out: LayoutPlacement[] = []
  for (let i = 0; i < members; i++) {
    const deg = offsets[i] ?? 0
    /*
     * ⚠ 0 度时**原样返回基准向量**：`normalize2` 会重新除一次长度，
     *   而"什么都没做"的那一份必须逐位等于原来的意图（边界要能钉住）。
     */
    out.push({ facing: deg === 0 ? base : normalize2(rotate2(base, deg)) })
  }
  return out
}

/**
 * 这次激活的**基准朝向**（单位向量）：意图里的方向，没有就是 `(1, 0)`。
 *
 * ⚠ 兜底是 `(1, 0)` 而**不是**"施法者当前朝向"：施法者的朝向由调用方
 *   在传进来的意图里表达（`intent.kind === 'direction'`，见 `cast.ts` 里
 *   `opts.facing` ⇒ `{ kind: 'direction', dir: opts.facing }` 那一句）——
 *   在这里再读一次 `caster.facing` 会有**第二个真相**：AI 在调
 *   `pressSequence` 之前刚把 `e.facing` 设成朝向目标的向量，两处读到的
 *   可能是同一个值也可能不是，而"排布算出来的方向"必须只有一个来源。
 */
function baseDirOf(intent: AimIntent | undefined): { x: number; y: number } {
  const dir = intent !== undefined && (intent.kind === 'direction' || intent.kind === 'point')
    ? intent.dir
    : undefined
  return dir !== undefined ? normalize2(dir) : { x: 1, y: 0 }
}

/**
 * 三档摆法的**角度偏移**（度，每份一个）—— 纯函数，不碰世界。
 *
 * ⚠ 它**只回答角度**：`ring` 用不到它（那是位置），`fan` / `mirror` 用它转方向。
 *   分成两件事的理由：转角是"绕施法者转"，而环绕还要一个半径 ——
 *   混在一起就得让 `fan` / `mirror` 也背一个"半径"的假参数。
 */
export function layoutOffsetsOf(
  layout: NonNullable<CompiledMod['layout']>,
  members: number,
): number[] {
  const out: number[] = []
  if (layout.mode === 'fan') {
    /*
     * 以瞄准方向为**中心**均分：-spread/2 … +spread/2。
     * ⚠ `members - 1` 是**份数之间的间隔数**（N 份有 N−1 个间隔）——
     *   除以 N 的话第一份和最后一份都不在张角的边界上（扇面看着"没张开"）。
     */
    for (let i = 0; i < members; i++) {
      out.push(-layout.spread / 2 + (layout.spread * i) / (members - 1))
    }
    return out
  }
  if (layout.mode === 'mirror') {
    // 交替：第 1 份照原样、第 2 份转过去、第 3 份照原样……（默认正好相差 180 度）
    for (let i = 0; i < members; i++) out.push(i % 2 === 0 ? 0 : 180 + layout.mirrorAngle)
    return out
  }
  return out
}

/**
 * 「环绕」里**第 i 份**该摆在哪儿（世界坐标）—— 唯一一处会挪"载体中心"的地方。
 *
 * 方位角 = `startAngle + i × (360/members)`（`even: false` 时去掉最后那一项）。
 * ⚠ 这里**没有用三角函数算角度再转成向量**：那一套要 `sin` / `cos`
 *   （purity 白名单里没有）。改成"把**基准方向**旋转 `Δ` 度"（`rotate2`，查表）
 *   —— 于是"起点"天然就是**瞄准方向**（平移了一个 `startAngle`），
 *   而"均匀分布"就是每份再转 `360/members`。
 *
 * ⚠ 取模用 `((x % 360) + 360) % 360`：JS 的 `%` 保留被除数符号，
 *   直接 `%` 会让负的起始角（比如 -90）算到圈外面去。
 */
export function layoutRingPointOf(
  layout: NonNullable<CompiledMod['layout']>,
  base: { x: number; y: number },
  origin: { x: number; y: number },
  index: number,
  members: number,
): { x: number; y: number } {
  const stepDeg = layout.even ? 360 / members : 0
  const raw = layout.startAngle + stepDeg * index
  const deg = ((raw % 360) + 360) % 360
  const dir = normalize2(rotate2(base, deg))
  return { x: origin.x + dir.x * layout.radius, y: origin.y + dir.y * layout.radius }
}

/**
 * 把一份 `LayoutPlacement` 变成**这一份的** `ActivateOptions`。
 *
 * ## 做了什么（就这三件，一件都不多）
 *
 * 1. **方向**：把意图里的方向那一半转过去（`kind: 'direction'` 换掉 `dir`；
 *    `kind: 'point'` 换掉可选的 `dir`；`entity` / `none` 不动 ——
 *    它们的方向来自"解算出来的朝向"，那一样由 `facing` 覆盖）。
 *    ⚠ `point` 的 `x` / `y` **一个字都不动** —— 玩家那句话：
 *    "它不许改瞄准 …… 只是把那几份摆到不同方向/位置"。
 * 2. **朝向**：显式给 `facing`，这样 `entity` / `none` 那两种意图也有方向可转
 *    （`resolveAim` 的方向分支读的就是它）。
 * 3. **落点**（只有「环绕」有）：`aimPoint` ⇒ 载体中心挪到那一圈上。
 *    ⚠ 引擎里**唯一**读 `aimPoint` 的地方是"载体中心"（`pipeline.ts` 的
 *    `originPoint`），所以这一步不会顺手改掉别的什么。
 *
 * ## ⚠ 两件**故意不做**的事
 *
 * · **不改 `targetId`**：`locked` / `auto` 锁的那个目标照旧 —— 排布不许改瞄准。
 * · **不动代价**：能量 / 血契 / 冷却一个字段都不碰（"份数不是免费的"那条规矩
 *   管的是份数，而排布不多给份数）。
 */
export function placementOptionsOf(opts: ActivateOptions, place: LayoutPlacement): ActivateOptions {
  const out: ActivateOptions = { ...opts }
  if (place.facing !== undefined) {
    const dir = { x: place.facing.x, y: place.facing.y }
    if (opts.intent?.kind === 'direction') out.intent = { kind: 'direction', dir }
    else if (opts.intent?.kind === 'point') out.intent = { kind: 'point', x: opts.intent.x, y: opts.intent.y, dir }
    out.facing = dir
  }
  if (place.point !== undefined) out.aimPoint = { x: place.point.x, y: place.point.y }
  return out
}
