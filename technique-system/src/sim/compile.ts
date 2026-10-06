/**
 * 编译：术式 + 技能 → 一条能跑的时间轴。
 *
 * ## 为什么需要这一层
 *
 * 数据模型是两层：
 *   **技能 Skill**  —— 编辑的单位。有阶段、有规则。挥砍是一个技能。
 *   **术式 Technique** —— 绑按键的东西。释放的是它。它按顺序执行若干技能。
 *
 * 但引擎不需要知道这个区别 —— 它只要一条时间轴。所以编译就是把术式里
 * 每个技能的阶段**接起来**，把阶段 id 加上前缀免得撞车。
 *
 * 这样一来 cast.ts / ai.ts / pipeline.ts 一行都不用改：它们认的还是
 * "一个有 phases 和 rules 的东西"。
 *
 * ## 命名空间
 *
 * 两个技能都可能有叫 `cast` 的阶段。编译器给它们加前缀 `skillId#`，
 * 规则里的 `phaseId` 也跟着改写。玩家看不见这个前缀，只有引擎看得见。
 */
import type {
  Capability, Condition, InterruptLevel, ModifierProto, Phase, Rule, SegmentMod, Skill, SkillLink, Targeting,
  Technique, TriggerEvent, TriggerOrigin,
} from '../schema.ts'
import type { ModifierKind } from '../schema.ts'
/*
 * ⚠ 份数的读法 / 上下限只有一处声明（`src/school.ts`，日志 51）——
 *   编译期、校验器、账三处共用它。`school.ts` 是**纯函数**模块
 *   （只 import type，没有文件、没有环境），所以 sim 依赖它不破坏纪律 4
 *   （`tests/purity.ts` 盯的是 sim 里出现 `Date` / `Math.random` / `node:` 这些）。
 *
 * ⚠ 等待的秒数 / 锁 / 打断档同理（日志 52）：读法只写在 `school.ts` 那一处。
 *
 * ⚠ 「排布」的半径 / 三个角度 / 是否均匀同理（日志 53）：读法也只在那一处。
 *
 * ⚠ 「追踪」的转速 / 搜索距离同理（日志 56）：读法也只在那一处。
 *
 * ⚠ 「弹射」的次数 / 每次衰减同理（日志 58）：读法也只在那一处 ——
 *   而它的次数上限**不是**这一层给的，是 `src/limits.ts` 的深度上限
 *   （`school.ts` 的 `modifierBounceMaxCountOf` 把它套在数据上限外面）。
 */
import {
  MODIFIER_BOUNCE_COUNT_KEY, MODIFIER_BOUNCE_FALLOFF_KEY,
  MODIFIER_COUNT_KEY,
  MODIFIER_HOMING_RANGE_KEY, MODIFIER_HOMING_TURN_KEY,
  MODIFIER_LAYOUT_MIRROR_KEY, MODIFIER_LAYOUT_MODES, MODIFIER_LAYOUT_RADIUS_KEY,
  MODIFIER_LAYOUT_SPREAD_KEY,
  MODIFIER_LAYOUT_START_KEY, MODIFIER_LAYOUT_TYPE_KEY,
  MODIFIER_SECONDS_KEY, MODIFIER_SECONDS_MIN, carrierFliesInWorld, modifierBounceCountOf, modifierBounceFalloffOf,
  modifierCountOf, modifierHomingRangeOf, modifierHomingTurnOf,
  modifierInterruptOf, modifierLayoutEvenOf,
  modifierLayoutMaxAngleOf, modifierLayoutMaxSpreadOf, modifierLayoutMirrorAngleOf,
  modifierLayoutModeOf, modifierLayoutRadiusOf,
  modifierLayoutSpreadOf, modifierLayoutStartAngleOf, modifierLocksOf, modifierSecondsOf,
} from '../school.ts'
import { allRulesOf } from '../effects.ts'

/**
 * 编译产物。引擎只认这个。
 *
 * 结构和老版本的 Technique 一模一样 —— 这是故意的：
 * 换模型的时候让引擎那侧零改动。
 */
export interface CompiledTechnique {
  id: string
  name: string
  activation: Technique['activation']
  /**
   * 这份编译产物**这次怎么解释意图**（怎么选中人 / 对谁有效 / 多远的射程）。
   *
   * ⚠ **它从技能身上来**（2026-09-21 日志 47 起）：术式和序列段都**不带瞄准**了，
   *   编译时按 `targetingOfChain`（链上第一个声明了瞄准的技能）取一份放进来。
   *   取这一份而不是"读的时候再去查技能"，是为了让
   *   `resolveAim` / 动作的默认目标 / AI 挑术式**一行都不用改** ——
   *   它们本来就只认"一份编译好的术式"。
   *
   * ⚠ 容器那一层（挂了序列的术式）自己这份**不参与运行时**：
   *   它没有阶段、规则也不跑；真正生效的是**每一段**那一份。
   */
  targeting: Targeting
  /** 所有技能的阶段，按顺序接起来 */
  phases: Phase[]
  /** 所有技能的规则，phaseId 已加前缀 */
  rules: Rule[]
  /** 所有技能的规则位之和 */
  ruleSlots: number
  /** 这个术式由哪些技能组成，按顺序 */
  skillIds: string[]
  /**
   * 技能之间的连接条件。`links[i]` 管 `skillIds[i+1]` 要不要执行。
   *
   * ⚠ 长度可能**短于** `skillIds.length - 1`：不写就是无条件。
   *   读取方按"缺失 = 无条件"处理，别拿下标直接取。
   */
  links: SkillLink[]
  /**
   * **负值术式**每次释放要消耗多少血契。
   *
   * ⚠ 这个数是**算出来的**（`priceTechnique` 的 |合计|），而算出它的
   *   `src/pricing.ts` **不在 sim 里**。所以它由调用方在编译时传进来，
   *   编译产物把它带上 —— 这样 `cast.ts` 只需要读一个数字，
   *   不需要认识"点数"这个概念。
   *
   *   0 = 不是负值术式（配平了，或者没算过账）。
   *   ⚠ "没算过账"和"配平了"在引擎看来是同一件事 —— 这是有意的：
   *     引擎不该因为调用方忘了算账就拒绝释放技能。
   */
  bloodPactCost: number
  /**
   * **序列术式**：这个术式不由技能拼成，而是由若干条序列按顺序走。
   *
   * ⚠ 有它的时候 `phases` / `rules` 是**空的** —— 时间轴不在这一层，
   *   在每一条序列里。走序列、回绕、超时回第一条是**输入层**的事
   *   （见 `cast.ts` 的"序列推进"一节）。
   *
   * ⚠ 2026-09-21（日志 46）序列**内联**了：以前这里是 `string[]`
   *   （每一条是一个术式 id，运行时要去 `world.techniques` 里查），
   *   现在每一条**自己就带一份编译产物**（`CompiledSegment.technique`）——
   *   少一次查表，也少一条"这一段没注册进世界"的静默失败路径。
   *
   *   老形状（字符串 id）仍然认：那时候 `refId` 有值，运行时按它去世界里查
   *   （老存档 / 老分享码里的术式就是这种，见 schema 的 `TechniqueSequences`）。
   */
  segments?: CompiledSegment[]
  /**
   * 序列之间的**条件门**（平行数组：`sequenceLinks[i]` 管 `sequences[i+1]`）。
   *
   * ⚠ 和技能之间的 `links` 是同一套语义：**条件不成立就跳过那一段**。
   *   玩家 2026-09-21 要的二段技能就靠它：
   *   "身上有标记才瞬移" —— 标记没了再按，那一段跳过、回到第一段去重新标记。
   *
   * ⚠ 早先只有校验器读它（`TOO_MANY_SEQUENCE_LINKS` 那些），
   *   运行时**没读** —— 也就是说写了等于没写，而且不报错。
   *   现在是运行时的行为（`cast.ts` 的 `nextIndex`）。
   */
  sequenceLinks?: SkillLink[]
  /** 走序列的时候，多久没按就回第一条（秒）。缺省 1 秒 */
  sequenceTimeout?: number
  /**
   * **被常驻包装的那几段**（段下标，日志 48）。
   *
   * ⚠ 玩家定的：「常驻包装**把它自己和后面那个技能**包装成常驻 →
   *   于是这一块**进常驻序列、不参与按键激活（被跳过）**」。
   *
   * 所以这个字段回答的是**输入层**那个问题："按一下的时候，这一段要不要走？"
   *   有它 ⇒ **不走**（它已经在 `activeTechniques` 里挂着，靠触发器自己放技能）；
   *   没它 ⇒ 照常。
   *
   * ⚠ 它是编译期算出来的（原型表决定），不是运行时去查 ——
   *   运行时查的话每 tick 都要读原型表，而且"忘了传原型表"会静默地
   *   把常驻段当成普通段（按一下真的会放出来）。
   */
  constantSegments?: number[]
  /**
   * 这份术式里**全部**的修饰副本（含每一段里的），编译期从原型表解析过。
   *
   * ⚠ 和 `segments[].mods` 是**同一批**（不是两份真相）：这里只是摊平一份，
   *   给"这份术式带没带修饰"这种整体问题用（HUD 分组、分享码提示、校验）。
   */
  mods?: CompiledMod[]
}

/**
 * **一条编译好的序列**（序列内联之后，容器术式里的一段）。
 *
 * ⚠ 它和 `CompiledTechnique` 是**同一个东西** —— 一段序列本来就是
 *   "一份只有技能链的术式"（它没有自己的激活方式，继承父术式那个）。
 *   所以这里不是包装一层新概念，而是明写"这一段就是一份编译产物"。
 *
 *   好处很实际：`activate` / `canActivate` / 冷却键 / HUD 的 `cd.*`
 *   **一行都不用改**，它们本来就只认"一份编译好的术式"。
 */
export interface CompiledSegment {
  /**
   * 这一段的编译产物。
   *
   * ⚠ `id` 就是这一段的**冷却键**（`cd.<id>`）：
   *   · 内容里显式写了 `SequenceSegment.id` 的 → 用它（迁移时沿用旧子术式的 id，
   *     所以 `cd.tech.blink-step` 这个键和逐字节行为一个都没变）
   *   · 没写的 → 编译器按 `<容器id>.seq<序号>` 合成
   *   见 `segmentKey()`。
   */
  technique: CompiledTechnique
  /**
   * 老形状（`sequences: ["tech.ws-slash"]`）**引用过来的那个术式 id**。
   *
   * ⚠ 有它的时候运行时按 id 去世界里查（老存档 / 老分享码里的术式就是这种形状，
   *   见 schema 的 `TechniqueSequences`）。内联的段没有这个字段 —— 它自给自足。
   */
  refId?: string
  /**
   * ---- **这一段的修饰副本**（修饰技能，日志 48）----
   *
   * ⚠ 原型表在**编译期**解析过一次（`CompiledMod.kind` / `params` 都填好了），
   *   运行时**不再查原型表**：sim 里没有内容层，而"运行时忘了传原型表"
   *   会静默地把一个触发器当成不存在。
   */
  mods?: CompiledMod[]
}

/**
 * 一条**编译好的修饰副本**（`SegmentMod` 解析过原型之后的形状）。
 *
 * ⚠ 为什么不在运行时直接读 `SegmentMod` + 原型表：
 *   · sim 不认识内容层（`content/modifiers/*.json` 是 `bridge.ts` 读进来的）；
 *   · 原型表缺席时 `kindOfMod` 只能返回 `undefined`，而"不知道它是什么"
 *     在运行时**没有任何合理的兜底** —— 猜错的代价是静默的
 *     （把 wrap 猜成 trigger ⇒ 这一块照旧要按键激活）。
 *   ⇒ 所以解析放在编译期，**解析不出来就报问题**（`UNKNOWN_MODIFIER`）。
 */
export interface CompiledMod {
  /** 副本本身（原型 id + 位置 + 参数原样） */
  source: SegmentMod
  kind: ModifierKind
  /**
   * 它修饰的那个技能**在这条链上的下标**（`at` 解析成真实下标之后）。
   *
   * ⚠ `at` 是"后面第几个"，这里换算成绝对下标 —— 运行时要用它去
   *   `technique.skillIds[skillIndex]` 拿技能 id。越界的副本**编译期就报错**
   *   （`MODIFIER_OUT_OF_RANGE`），所以运行时读到的下标一定有效。
   */
  targetIndex: number
  /** `trigger` / `monitor` 用：什么时候看（现成事件之一） */
  when?: TriggerEvent
  /** `trigger` / `monitor` 用：还要满足什么（技能里那**同一套**条件） */
  condition?: Condition
  /** `trigger` / `monitor` 用：跨过才算（不是"一直都算"）。缺省看原型的 params */
  crossing?: boolean
  /** `trigger` / `monitor` 用：被触发的技能生成在哪里（四选一） */
  origin?: TriggerOrigin
  /**
   * `multi` / `split` 用：**一次激活里放出几份**（2026-09-21 日志 51）。
   *
   * ⚠ 已经在编译期**读好并夹到上限**了（`school.ts` 的 `modifierCountOf`）：
   *   运行时只读这一个数，不再查原型表（sim 里没有内容层）。
   *   "夹"这一步的目的不是判据（判据在校验器），而是**手改的存档 / 老分享码**
   *   绕过校验器时的兜底 —— 不夹的话 `count: 9999` 会在一个 tick 里起 9999 个施法。
   *   夹了会说（编译期给一条 `CompileProblem`）。
   */
  count?: number
  /**
   * `wait` 用：**这段空档有多久**（秒，2026-09-30 日志 52）。
   *
   * ⚠ 已经在编译期**读好并夹到 `[0.2, 原型的上限]`** 了（`school.ts` 的
   *   `modifierSecondsOf`）—— 和 `count` 同一个理由：手改的存档 / 老分享码
   *   绕过校验器时的兜底（不夹的话 `seconds: 9999` 会插一段 9999 秒的空档，
   *   表现是"这个技能再也放不出来"，而且无处可查）。
   *
   * ⚠ 运行时**读不到它也没关系**：真正的时间轴在 `phases` 里
   *   （那个插进去的等待阶段自己带着 `duration`）——
   *   这个字段是留给**定价和报告**读的（"这一段空档是哪个零件插的"）。
   */
  waitSeconds?: number
  /**
   * `wait` 用：这 X 秒里**禁用施法者哪些能力**（`Capability` 的四个值之一部分）。
   *
   * ⚠ 它**逐字**来自参数（`school.ts` 的 `modifierLocksOf`，认不出的取值已经丢掉）——
   *   编译期读好，运行时不再查原型表（和 `count` 同一个理由）。
   */
  waitLocks?: Capability[]
  /**
   * `wait` 用：这段空档**能不能被打断**（三档之一，默认 `'none'`）。
   *
   * ⚠ 它直接写进那个等待阶段的 `Phase.interrupt` —— 所以"默认不可打断"
   *   在引擎里就是**它本来就会执行的那条分支**，不需要任何等待专用逻辑。
   */
  waitInterrupt?: InterruptLevel
  /**
   * `wait` 用：**插进去的那个阶段叫什么**（编译期定，`#wait0` / `#wait1`…）。
   *
   * ⚠ 为什么不是运行时现编一个常量：同一份编译产物里可能有**两段**等待
   *   （两个等待副本分别盯不同的技能），而阶段 id 是 `castPhase` 事件、
   *   调试和 HUD 认阶段的键 —— 全叫 `#wait` 的话它们就分不开了。
   *   ⚠ 它**故意不带技能前缀**（不是 `skill.x#wait`）：`advancePhase` 拿
   *   "换技能了吗"当连接门的判据，带上目标技能的前缀会让那道门**被跳过**
   *   （详见 `insertWaitPhases` 的注释）。
   */
  waitPhaseId?: string
  /**
   * `layout` 用：**这一次激活里的那几份该摆成什么样**（2026-09-30 日志 53）。
   *
   * ⚠⚠ 这里**故意没有份数字段** —— 玩家划的第一条硬界线是
   *   「排布**只管排布 / 路径**，✗ 不管份数」。份数由 `groupPlanOf` 从
   *   `multi` / `split` 算，排布只读它的**长度**（"已经存在的那几份"）。
   *   ⚠ 往这个对象里加一个 `count` 就是把那条界线当场拆掉：
   *     它会和「一分为 X」变成两个都能加份数的地方，而账只按一个收。
   *
   * ⚠ 各字段**已经在编译期读好、夹好**（`school.ts` 的
   *   `modifierLayout*Of` 那一族）—— 运行时不再查原型表，和 `count` /
   *   `waitSeconds` 同一个理由：sim 里没有内容层，"忘了读参数"的后果是静默的
   *   （表现是"我装了排布，它一份都没挪"）。
   */
  layout?: {
    /**
     * 怎么摆：`ring` 环绕 / `fan` 扇形散射 / `mirror` 反向镜像。
     *
     * ⚠ 认不出的取值**编译期不会走到这里**（`modifierLayoutModeOf` 返回
     *   `undefined` ⇒ 这个字段整块缺席），运行时读不到它就**什么都不做** ——
     *   而不是挑一个默认的摆法（那会静默地把"反向镜像"做成"排了个圈"）。
     */
    mode: 'ring' | 'fan' | 'mirror'
    /** `ring` 用：这一圈多大（米，已夹到 `[minRadius, maxRadius]`） */
    radius: number
    /** `ring` 用：从瞄准方向起算转多少度（已夹到 ±maxAngle） */
    startAngle: number
    /** `ring` 用：是否均匀分布（关掉 = 全都摆在 `startAngle` 那一条射线上） */
    even: boolean
    /** `fan` 用：张角（度，已夹到 `[0, maxSpread]`） */
    spread: number
    /** `mirror` 用：反方向相对正方向的偏移角（度，已夹到 ±maxAngle；0 = 正反方向） */
    mirrorAngle: number
    /**
     * ⚠⚠ 这个技能（副本修饰的那一个）的载体里**有没有"会飞的东西"**
     *   —— 判据是 `school.ts` 的 `carrierFliesInWorld`（**只有那一处**）。
     *
     * 用户 2026-09-30 定的（日志 61）：**载体从施法者身上长出来**
     * （`meleeArc` / `self` / `aura` / `beam` / `capsule`）⇒ **环绕什么都不做**。
     * ⚠ 是"什么都不做"，**不是警告** —— 和「追踪」/「弹射」同一条规矩。
     *
     * ⚠ **只有 `ring` 读它**（见 `sim/trigger.ts` 的 `layoutPlanOf`）：
     *   `fan` / `mirror` 只转方向，长在施法者身上的载体照样转得动 ——
     *   玩家点的是「**环绕**」那一档，不是整个零件。
     */
    carrierFlies: boolean
  }
  /**
   * `homing` 用：**这一发飞出去之后怎么拐**（2026-09-30 日志 56）。
   *
   * ⚠ 两个数**已经在编译期读好、夹好**（`school.ts` 的 `modifierHoming*Of`）——
   *   运行时不再查原型表，和 `count` / `waitSeconds` / `layout` 同一个理由：
   *   sim 里没有内容层，"忘了读参数"的后果是静默的
   *   （表现是"我装了追踪，它还是直着飞"）。
   *
   * ⚠⚠ **它里面没有"打谁"**（没有 `targetId` / 没有 `valid`）：
   *   候选目标在**发射那一刻**才定得下来（要按投射物自己的位置找最近的，
   *   见 `sim/projectile.ts` 的 `steerProjectile`）—— 编译期世界还没跑，
   *   这里填一个目标就是**猜**。编译期只管"拐多快、看多远"这两件不变量。
   *
   * ⚠ 它**只在发射那一刻被抄进 `ProjectileSpec.homing`**（`sim/pipeline.ts`）：
   *   半路上改原型**不会**影响已经飞出去的那一发（发射即锁定，和 `cast.facing` 同理）。
   */
  homing?: {
    /** 每 tick 最多转多少度（已夹到 `[1, 原型上限]`） */
    turnRate: number
    /** 搜索距离上限（米，已夹到 `[原型下限, 原型上限]`） */
    maxRange: number
  }
  /**
   * `bounce` 用：**这一发打中之后弹给下一个敌人几次、每次衰减多少**（日志 58）。
   *
   * ⚠ 两个数**已经在编译期读好、夹好**（`school.ts` 的 `modifierBounce*Of`）——
   *   运行时不再查原型表，和 `homing` / `count` / `waitSeconds` / `layout` 同一个理由。
   *
   * ⚠⚠ **次数上限是引擎的深度上限**（`src/limits.ts` 的 `MAX_ACTION_DEPTH`，
   *   经由 `modifierBounceMaxCountOf` 套在"数据写的上限"外面）：
   *   弹射是一条**链**，链上每一段都是一颗新子弹，所以 `executeAction` 的
   *   `depth` **不会自然累加** —— 那个上限是这条链唯一的刹车。
   *   玩家原话："各写一份迟早出现弹射绕过深度保护 ⇒ 自反馈"。
   *
   * ⚠ 它里面**没有"弹给谁"**（和 `homing` 一个字都不许有目标同一个道理）：
   *   下一个敌人在**命中的那一刻**按**子弹自己的位置**找（`sim/projectile.ts`），
   *   编译期世界还没跑 —— 填一个目标就是猜。
   */
  bounce?: {
    /** 最多弹几次（已夹到 `[1, min(原型上限, MAX_ACTION_DEPTH)]`） */
    maxBounces: number
    /** 每弹一次，下一段的载荷量乘多少（已夹到 `[原型下限, 原型上限]`，默认 0.7 = −30%） */
    damageFalloff: number
  }
}

/**
 * 一个技能段的**冷却键**。
 *
 * ⚠ 这是本次迁移里唯一一件"必须想清楚"的事（见日志 46）：
 *   序列内联之前，每一段的冷却键是**它自己那份子术式的 id**
 *   （`cd.tech.blink-step`），而那个键是**对外可观察的行为** ——
 *   `tests/` 里钉着它、"改冷却"的规则按它认身份、存档里存的就是它。
 *
 *   所以"合成的键"不能随便造一个新的：
 *   · 内容里那几段**沿用旧 id**（写在 `SequenceSegment.id` 上）→ 行为逐位不变；
 *   · 真正新写的序列才按 `<容器id>.seq<i>` 合成 —— 它和容器、和段号绑定，
 *     不会因为改别的地方而漂。
 */
export function segmentKey(containerId: string, index: number, explicitId?: string): string {
  return explicitId !== undefined && explicitId.length > 0
    ? explicitId
    : `${containerId}.seq${index}`
}

/**
 * 编译不出来的原因，给编辑器和校验器用。
 *
 * ⚠⚠ **2026-09-30 日志 61：它从"扁平"改成"带段号"**（用户点名的 UI 前提）。
 *
 *   以前只有 `{ techniqueId, skillId, message }` —— **段号只写在文字里**
 *   （"序列段「第一段」上的修饰副本…"）。界面要"把提示画在**有问题的
 *   **那一条序列下方**"，就得去**解析自己写的中文**才知道是哪一段 ——
 *   那是拿文案当数据结构，文案一改界面就瞎 ✗。
 *
 *   ⚠ **文案一个字都没改**（这一片只加字段）：`message` 还是那句话，
 *     多出来的三个下标是**同一件事的结构化版本**，给界面用的。
 *
 *   ⚠ 三个下标**都是可选的**，而且**同时缺席 = "整门术式那一层"**
 *     （不是"第 0 段"！）—— 用 `undefined` 表达"容器自己没有段号"，
 *     别用 `-1` / `0` 冒充：`0` 是第一段，`-1` 是"界面必须特判的魔法数"。
 */
export interface CompileProblem {
  techniqueId: string
  skillId: string
  message: string
  /**
   * 问题落在**第几段**（`Technique.sequences` 的 **0 基**下标）。
   *
   * ⚠ 缺席 = 问题在**术式那一层**（容器自己的技能链，比如"引用了不存在的技能"）。
   * ⚠ **多段的问题锚在第一个出问题的段上**（"常驻包装在非 press 术式里"那条
   *   —— 它一句话管好几段，`message` 里仍然把段号列全，这里只给界面一个落点）。
   */
  segmentIndex?: number
  /**
   * 落在**这一段里第几个技能**（`SequenceSegment.skills` 的 **0 基原始下标**，
   * 含查不到的技能 —— 和 `SegmentMod.at` 用的是**同一个坐标系**）。
   *
   * ⚠ 原始下标而不是编译后下标：界面画的是**数据里那一行**，
   *   而编译后的 `skillIds` 会把查不到的技能跳掉（少一个就整体错位一格）。
   */
  skillIndex?: number
  /**
   * 落在**这一段里第几个修饰副本**（`SequenceSegment.mods` 的 **0 基**下标）。
   *
   * ⚠ 有它才画得到"**是哪个副本写错了**"：一段里可以挂好几个副本
   *   （只要不同类），只说"这一段有问题"会让玩家去猜是哪一个。
   */
  modIndex?: number
  /**
   * 出问题的那个**取值位置**（副本 `params` 里的键名，如 `radius` / `turnRate`）。
   *
   * ⚠ 只有"某一个参数写坏了"这一类才有它；"整个副本不存在"那种
   *   （`UNKNOWN_MODIFIER`）没有取值位置可言 ⇒ 缺席。
   */
  paramKey?: string
}

export interface CompileResult {
  compiled: CompiledTechnique
  problems: CompileProblem[]
}

/** 找一个技能。找不到就返回 undefined，由调用方决定怎么办 */
export type SkillLookup = (skillId: string) => Skill | undefined

export interface CompileOptions {
  /**
   * 这个术式的血契消耗（|点数合计|，只对负值术式有意义）。
   *
   * 调用方从 `priceTechnique` 拿来传进来。不传 = 0。
   */
  bloodPactCost?: number
  /**
   * **修饰技能的原型表**（`content/modifiers/`）。
   *
   * ⚠ 不传的后果是**静默的**（见 `CompiledMod` 那段）：副本解析不出来，
   *   于是常驻包装不成常驻、触发器永远不触发。所以这里给一条
   *   `UNKNOWN_MODIFIER` 问题，让"没传表"和"原型真的不存在"都看得见。
   */
  modifiers?: ReadonlyMap<string, ModifierProto>
}

/**
 * 一份编译产物用的**空目标**。
 *
 * ⚠ 只有"这条链上一个技能都没编译进来"才用得上（技能表里查不到 / 空链），
 *   而那种情况下**没有什么会读它**：没有阶段就没有时间轴，
 *   规则也不会跑。给它一份空表只是为了类型完整、让读的人少一条分支。
 *
 * ⚠ **不许拿它当"默认瞄准"**：出厂内容里每个技能都显式写着自己的瞄准，
 *   这条兜底只服务于"内容坏了"那一条路（`tests/` 里现造的术式也是）。
 */
const EMPTY_TARGETING: Targeting = { mode: 'directional', valid: [] }

/**
 * 一条技能链的**瞄准**。
 *
 * ⚠ 2026-09-21（日志 47）"瞄准搬到技能层"之后，术式和序列段都**不带瞄准**了，
 *   可运行时那几处（`activate` → `resolveAim`、动作的默认目标、AI 挑术式、
 *   接触判定 `markContactHit`）读的仍然是**一份编译产物**
 *   （`CompiledTechnique.targeting`）。所以编译这一层负责把它从**技能**身上
 *   取出来 —— 那几处**一行都没改**。
 *
 * 取法：**按顺序**走过这条链（`skills` 然后每一段的 `skills`），
 * 取**第一个声明了 `targeting` 的技能**那一份。
 *
 * ⚠ 为什么容器也要顺带看**段**：容器自己不执行任何东西（`phases` / `rules` 是空的），
 *   但它的编译产物仍然是"这份术式"的读数 —— `markContactHit` 就是拿容器的
 *   `targeting.valid` 判"碰到的是不是合法目标"的（`cast.technique` 在容器那一次
 *   施法里就是容器）。只看容器的 `skills` 的话，武器术式 / 二段技能这种
 *   **只挂序列**的术式会得到一份空表 ⇒ 接触判定永远不成立（`tests/scenario.ts` 第 31 节）。
 *
 * ⚠ 为什么是"第一个"而不是"每个技能一份"：
 *   · `cast.facing`（这一发朝哪）是在**施法瞬间解算一次**、之后不再变的
 *     （见 `cast.ts` 的注释），所以一次施法产不出 N 个朝向；
 *   · `valid`（这次动作对谁有效）和 `range` 也跟着这一份走。
 *   ⇒ 今天出厂内容里，一条链上的技能瞄准**都是一样的**（迁移时逐条搬的），
 *     "第一个"和"任意一个"没有区别 ✓。
 *   ⚠ 哪天内容里出现"同一条链、两个技能瞄准不同"，那是一个**需要裁定**的问题
 *     （"这次施法听谁的"），别在这里随手挑一个就完事 —— 日志 47 把它记成了欠账。
 */
function targetingOfTechnique(tech: Technique, lookup: SkillLookup): Targeting {
  const fromTop = targetingOfChain(tech.skills ?? [], lookup)
  if (fromTop !== EMPTY_TARGETING) return fromTop
  for (const seg of tech.sequences ?? []) {
    if (typeof seg === 'string') continue   // 老形状：那段技能在另一份术式里，这里查不到
    const found = targetingOfChain(seg.skills, lookup)
    if (found !== EMPTY_TARGETING) return found
  }
  return EMPTY_TARGETING
}

function targetingOfChain(skillList: readonly string[], lookup: SkillLookup): Targeting {
  for (const id of skillList) {
    const skill = lookup(id)
    if (skill?.targeting !== undefined) return skill.targeting
  }
  return EMPTY_TARGETING
}

/*
 * ⚠ 这里没有加"段引用了谁"的字段：`compileSkillChain` 产出的
 *   `skillIds` 已经就是链上**编译进来的**技能（顺序不变、查不到的跳过），
 *   运行时要"这一段的代表技能"直接读 `skillIds[0]` 就行 ——
 *   再加一个字段就是同一个事实的第二份真相。
 */

export function compileTechnique(
  tech: Technique,
  lookup: SkillLookup,
  opts: CompileOptions = {},
): CompileResult {
  const problems: CompileProblem[] = []

  /*
   * ---- 它自己的技能链（普通术式的那一半）----
   *
   * ⚠ 每一段序列**就是一份只有技能链的术式**，所以这里抽成一个函数：
   *   容器那一层和段那一层走的是**同一段编译逻辑**。
   *   两边各写一遍的话，迟早有一边漏掉"找不到的技能要报问题"或者
   *   "`links` 要按编译后的位置对齐"—— 而那两种漏法都是静默的。
   */
  const part = compileSkillChain(tech.id, tech.name, tech.skills ?? [], tech.links, lookup, problems)  /*
   * ⚠ 容器自己那份瞄准：按顺序走过 `skills` 和每一段的 `skills`（见 `targetingOfTechnique`）。
   *   容器没有阶段、规则也不跑，但它那份 `targeting.valid` **有一个真的读者**：
   *   接触判定（`cast.ts` 的 `markContactHit`）拿它判"碰到的是不是合法目标"。
   *   真正决定"这一发怎么瞄"的仍然是**每一段**那份（段自己的第一个技能）。
   */
  const ownTargeting = targetingOfTechnique(tech, lookup)

  const segments: CompiledSegment[] = []
  const seqs = tech.sequences ?? []
  /** 被常驻包装的段（见 `CompiledTechnique.constantSegments`） */
  const constantSegments: number[] = []
  /** 原型表。⚠ 没有它时副本解析不出来 —— 那是**要报出来的**，不是当它不存在 */
  const protoOf: ReadonlyMap<string, ModifierProto> = opts.modifiers ?? new Map()

  for (let i = 0; i < seqs.length; i++) {
    const seg = seqs[i]
    if (seg === undefined) continue

    /*
     * ---- 老形状：字符串 id（引用另一份术式）----
     *
     * ⚠ 这条读法**必须留着**（玩家 2026-09-21：老存档和老分享码里的东西
     *   不许判死）。它不带技能，所以编译产物是空的 —— 运行时按 `refId`
     *   去世界里查那份术式来放。查不到 = `noSequence`（"按了没反应"），
     *   和迁移前**一模一样**，不会崩。
     */
    if (typeof seg === 'string') {
      if (seg.length > 0) {
        /*
         * ⚠ 老形状在**编译期拿不到**那份术式（它要等运行时按 `refId` 去世界里查），
         *   所以这份空产物上没法填一份真的瞄准 —— 给它 `EMPTY_TARGETING`。
         *
         *   ⚠ **不会改变行为**：`resolveSegment` 见到 `refId` 就改用**世界里那份**
         *     已编译好的术式，这份空产物根本不会被拿去解析瞄准。
         *     填容器那份反而是错的（那是另一份术式的瞄准）。
         */
        segments.push({
          refId: seg,
          technique: emptyCompiled(seg, seg, tech.activation, EMPTY_TARGETING),
        })
      }
      continue
    }

    /*
     * ---- 内联：这一段自己带技能 ----
     *
     * ⚠ 段的 `links` 用的是**段自己的下标**（`links[i]` 管 `skills[i+1]`），
     *   所以直接交给 `compileSkillChain` —— 它已经按"原始下标"对齐了
     *   （少一个技能时不会整体错位一格，见那里的注释）。
     */
    const key = segmentKey(tech.id, i, seg.id)
    // ⚠ 传 `i`（段号）：这一层的问题要落回"第几段"（日志 61）
    const inner = compileSkillChain(key, key, seg.skills, seg.links, lookup, problems, i)

    /*
     * ---- 这一段的修饰副本（日志 48）----
     *
     * ⚠ 解析放在**编译期**（见 `CompiledMod` 那段）：运行时没有原型表。
     *   解析不出来就报一条 `UNKNOWN_MODIFIER` —— 那一条比"运行时静默地
     *   把它当成不存在"重要得多（后者表现是"我装了个修饰技能，什么都没发生"）。
     */
    // ⚠ 段号 / `lookup` 一起传进去：副本问题要段号，`layout` 要查载体（日志 61）
    const compiledMods = compileMods(seg, key, seg.skills, inner.compiledIndexAt, protoOf, problems, i, lookup)

    /*
     * ⚠ ---- **把「等待 X 秒」的空档插进时间轴**（2026-09-30 日志 52）----
     *
     *   它是这一片唯一动时间轴的地方，而且**只动有等待副本的段**：
     *   出厂内容里一个副本都没有 ⇒ `compiledMods` 里没有 `wait`
     *     ⇒ `insertWaitPhases` 原样返回 ⇒ 编译产物**逐字节不变**
     *     （这是 `npm run calibrate` 和 `duel` 12 秒逐位不变的根据）。
     *
     *   ⚠ 插的是**真阶段**（不是新概念）：占用施法者 / 锁能力 / 不可打断
     *     这三件事本来就是阶段的性质，所以引擎那一侧**零改动**。
     */
    const segPhases = insertWaitPhases(inner.phases, inner.skillIds, compiledMods)

    /*
     * ⚠ **常驻段**：`at: 0` 的那个技能被 `wrap` 包住了 ⇒ 这一块不参与按键激活。
     *   判据和 `school.ts` 的 `hasConstantWrapper` 是**同一句**
     *   （"紧邻的第一个技能被 wrap 包了"）—— 这里只是拿编译期解析好的
     *   `kind` 再说一遍，免得运行时去查原型表。
     */
    if (compiledMods.some(m => m.kind === 'wrap' && m.targetIndex === 0)) {
      constantSegments.push(i)
    }

    segments.push({
      ...(compiledMods.length > 0 ? { mods: compiledMods } : {}),
      technique: {
        id: key,
        /*
         * ⚠ 名字取段的 `name`，取不到就退回**段的 id**。
         *
         *   为什么不是容器的名字：`name` 会出现在事件和界面提示里
         *   （"施放 横砍"），而它和内联之前那份子术式的 `name` 是同一个 ——
         *   写成容器的名字会让两段看起来是同一招（"施放 长剑·基本式" ×2）。
         */
        name: seg.name !== undefined && seg.name.length > 0 ? seg.name : key,
        activation: tech.activation,
        /*
         * ⚠ ---- **这一段的瞄准从它的技能身上取**（日志 47）----
         *
         *   2026-09-21 那一次内联时，段上还挂着一份 `targeting`
         *   （照搬自旧子术式），运行时会读它 —— 所以那一片只是把它搬了个位置。
         *   这一片把它**删掉**，改为从**段里的技能**取（定稿：瞄准在技能层）。
         *
         *   ⚠ 取到的必须和段上原来那一份**等价**，否则行为会变：
         *     内容里那几段原先的瞄准已经逐字搬到了它们的技能上
         *     （`tech.blink-step` 的 `requireStatusTag: 'marked'` → `skill.blink`），
         *     所以这里取到的就是原来那一份。
         *     `tests/blink.ts` 的"第二段必须打**带标记的那个**"钉的就是这一条。
         *
         *   ⚠ 取法见 `targetingOfChain`（链上第一个声明了瞄准的技能）。
         *     链上一个技能都取不到（技能表里查不到）时给 `EMPTY_TARGETING`——
         *     那种情况没有阶段、没有规则，读不到它。
         */
        targeting: targetingOfChain(seg.skills, lookup),
        /*
         * ⚠ `segPhases`（不是 `inner.phases`）：这一段的时间轴里可能已经
         *   **插进了「等待 X 秒」的空档**（日志 52）。没有等待副本时
         *   `segPhases` 就是 `inner.phases` 的一份拷贝，内容逐字节相同。
         */
        phases: segPhases,
        rules: inner.rules,
        ruleSlots: inner.ruleSlots,
        skillIds: inner.skillIds,
        links: inner.links,
        /*
         * ⚠ 血契消耗 = 0：段**不进点数账**（见 pricing.ts 的 priceTechnique
         *   和 README 里"普攻免费"那条）。给段算血契的话，
         *   "负值术式"的代价会在**按下去的每一段**上重复收一次。
         */
        bloodPactCost: 0,
      },
    })
  }

  /*
   * ⚠ `skillIds` 取**各段之和**（不只是它自己的 `skills`）。
   *
   *   它是"技能页 → 被这些术式用到"那张反查表（`usedBy`）的来源。
   *   内联之前，容器的 `skillIds` 是空的、技能在两条子术式那一层，
   *   所以技能页显示的是"被 tech.ws-slash 用到"；内联之后子术式没了，
   *   不摊平的话技能页会显示"**没有任何术式用到它**" —— 静默地少一半。
   */
  const skillIds = [...part.skillIds, ...segments.flatMap(s => s.technique.skillIds)]

  /** 摊平一份全部副本（见 `CompiledTechnique.mods`） */
  const flatMods = segments.flatMap(s => s.mods ?? [])

  /*
   * ⚠ ---- **常驻包装只能包普通技能**（日志 48 的取舍，明写在这里）----
   *
   *   玩家定的是"包装成常驻 ⇒ 这一块**不参与按键激活**"。可一份
   *   `activation: 'auto'` 的术式**本来就不参与按键激活**（它走
   *   `setTechniqueActive`，"装上就生效"）—— 于是"常驻包装"在那种术式里
   *   **什么都不改**，而它明明写着"我把它包成常驻"。
   *
   *   两边都会静默：放进 auto 术式里包装是个空动作，放进按键术式里
   *   那一块又永远等不到触发。所以这里把后者挑明（前者由校验器的
   *   `FORM_INCOMPATIBLE` 挡：auto 术式只能带常驻技能，而普通技能
   *   只有在被包装时才该是"常驻"）。
   *
   * ⚠ 这是**待裁定项**（报告第 5 节）：定稿 §六 说"常驻序列可以和技能序列
   *   混在一门术式里"，那一天要改的就是这一条 + `pressSequence` 的跳段。
   *   今天按"不能混"处理，因为"按下去到底该不该放它、HUD 那一格显示什么"
   *   规格里没有答案 —— 与其自己定一个（那是**改玩法**），不如报出来。
   */
  if (constantSegments.length > 0 && tech.activation !== 'press') {
    problems.push({
      techniqueId: tech.id,
      skillId: segments[constantSegments[0] as number]?.technique.skillIds[0] ?? '',
      /*
       * ⚠ 这一条**一句话管好几段**（message 里把它们列全了），
       *   而界面只能把提示画在**一段**下面 ⇒ 锚在**第一个**出问题的段上。
       *   挑第一个而不是"最后""随便一个"：消息里第一个报的就是它，
       *   两边读起来是同一段（日志 61）。
       */
      segmentIndex: constantSegments[0] as number,
      message: `术式「${tech.name}」里有被常驻包装的段落（第 ${constantSegments.map(i => i + 1).join('、')} 段），`
        + `但它的激活方式是 ${tech.activation} —— 常驻包装只对"按一下"的普通术式有意义`
        + '（auto 的常驻术式本来就不参与按键激活；蓄力 / 按住 / 开关都带着一次输入，'
        + '而那一块不该等输入）',
    })
  }

  return {
    compiled: {
      id: tech.id,
      name: tech.name,
      activation: tech.activation,
      /*
       * ⚠ 容器自己那一份（不是段的）：容器没有阶段、规则也不跑，
       *   所以它**不参与运行时** —— 它只是"这份术式怎么瞄"的一个读数，
       *   读它的人（`cli/run.ts`、`tools/overview.ts`）看的是术式这一层。
       */
      targeting: ownTargeting,
      phases: part.phases,
      rules: part.rules,
      ruleSlots: part.ruleSlots,
      skillIds,
      links: part.links,
      bloodPactCost: opts.bloodPactCost ?? 0,
      /*
       * ⚠ 只在**有序列**的时候带 `segments`（空数组不带）——
       *   和迁移前"空数组不带 `sequences`"是同一条判据，
       *   `tests/weapons.ts` 钉着"普通术式没有这个字段（不是空数组）"。
       */
      ...(segments.length > 0
        ? {
          segments,
          sequenceTimeout: tech.sequenceTimeout ?? 1,
          // 序列之间的条件门：没有就不带这个字段（读取方按"无条件"处理）
          ...(tech.sequenceLinks !== undefined && tech.sequenceLinks.length > 0
            ? { sequenceLinks: tech.sequenceLinks.map(l => ({ ...l })) }
            : {}),
          // ⚠ 空数组不带（和 segments 同一条判据）：读取方按"没有被包装的段"处理
          ...(constantSegments.length > 0 ? { constantSegments } : {}),
          ...(flatMods.length > 0 ? { mods: flatMods } : {}),
        }
        : {}),
    },
    problems,
  }
}

/**
 * 一个技能里**所有**动作的载体（`delivery.kind`）——
 * 只负责"把载体收集出来"，**一个判断都不做**。
 *
 * ⚠ 走 `allRulesOf(skill)`（`effects.ts`）而不是 `skill.rules`：**固有效果**
 *   （`Skill.effect`）编译时会被折成一条 `phaseComplete` 规则 —— 只读
 *   `skill.rules` 会漏掉它，而"这个技能会不会飞"恰恰经常写在固有效果上
 *   （出厂那个「魔法飞弹」就是）。
 *
 * ⚠ 它和 `validator/index.ts` / `pricing.ts` 里那两个同名函数**是同一个形状的
 *   三份**，而且**故意的**：`sim/**` 不许 import 校验器（分层），
 *   反向让校验器 import sim 又绕成环。
 *   ⚠ 真正**不许有两份**的是**判据**（"哪种载体算会飞"）——
 *   那一条只有一处：`school.ts` 的 `carrierFliesInWorld`。
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

/**
 * 这个技能的载体里**有没有"会飞的东西"** —— 判据 = `school.ts` 的
 * `carrierFliesInWorld`（**只有那一处**，日志 61）。
 *
 * ⚠ 查不到技能 ⇒ `false`（"它不是一个会飞的东西"）——
 *   和"非飞行载体什么都不做"同一条路，也和老数据/拼错的 id 走同一条路。
 *   ⚠ 这一条的后果**不静默**：技能查不到时 `compileSkillChain` 已经报过
 *   `UNKNOWN_SKILL` 了。
 */
function carrierFliesInSkill(skillId: string | undefined, lookup: SkillLookup): boolean {
  if (skillId === undefined) return false
  const skill = lookup(skillId)
  if (skill === undefined) return false
  return deliveryKindsOfSkill(skill).some(k => carrierFliesInWorld(k))
}

/**
 * 把一段的**修饰副本**（`SequenceSegment.mods`）解析成编译产物。
 *
 * ⚠ 三件事必须一起做，少一件就是静默的坏行为：
 *   1. **查原型**：查不到 ⇒ 报 `UNKNOWN_MODIFIER`（不许当它不存在）；
 *   2. **`at` 换算成真实下标**：越界 ⇒ 报 `MODIFIER_OUT_OF_RANGE`
 *      （不报的话"修饰一个不存在的技能"就是一条永远不触发的修饰）；
 *   3. **`wrap` 的 `at` 必须落在同一个技能上**（`at` 是它自己修饰谁）。
 *
 * ⚠ `skillList` 用**原始下标**（含查不到的技能），返回值里的 `targetIndex`
 *   也是**原始下标** —— 而运行时读的是 `compiled.skillIds`（编译后、跳过了
 *   查不到的技能）。所以下面用 `skillIds` 做一次"这个原始位置有没有编进来"的
 *   筛：**没编进来的目标不产生副本**（它的技能都不存在，触发它就毫无意义）。
 *
 * ⚠ `segmentIndex`（日志 61）：这一段在 `Technique.sequences` 里的 0 基下标。
 *   副本**只住在段里**（老形状的字符串段没有副本），所以它是必填的 ——
 *   这里没有"容器那一层"那种缺席可言。
 */
function compileMods(
  seg: { id?: string; name?: string; mods?: SegmentMod[] },
  ownerId: string,
  skillList: readonly string[],
  compiledIndexAt: ReadonlyMap<number, number>,
  protos: ReadonlyMap<string, ModifierProto>,
  problems: CompileProblem[],
  segmentIndex: number,
  lookup: SkillLookup,
): CompiledMod[] {
  const raw = seg.mods ?? []
  if (raw.length === 0) return []

  const out: CompiledMod[] = []

  for (let modIndex = 0; modIndex < raw.length; modIndex++) {
    const mod = raw[modIndex]
    if (mod === undefined) continue
    /*
     * ⚠ 这一段的副本问题都带 `segmentIndex` / `modIndex`（日志 61）——
     *   界面画在"那一条序列"下面、而且要指出**是哪一个副本**。
     *   一段里可以挂好几个副本（只要不同类），只说"这一段有问题"等于没说。
     */
    const where = { techniqueId: ownerId, segmentIndex, modIndex }
    const proto = protos.get(mod.proto)
    if (proto === undefined) {
      problems.push({
        ...where,
        skillId: skillList[0] ?? '',
        paramKey: 'proto',
        message: `序列段「${seg.name ?? seg.id ?? ownerId}」上的修饰副本引用了不存在的修饰原型：${mod.proto}`
          + '（修饰原型只做出厂那一批，玩家不能创建原型）',
      })
      continue
    }

    /*
     * ⚠ ---- **`at` 的语义**（这一片唯一的"判断"，写清楚）----
     *
     * 玩家的原话是"修饰技能**靠位置**：修饰紧邻它**后面**那个技能"。
     * 落到数据上有**两种**读法，必须挑一种、而且要**和校验器挑同一种**：
     *
     *   (A) `at` = **这一段里第几个技能**（`at: 0` ⇒ `skills[0]`）
     *   (B) `at` = 从**副本自己那一格**往后数第几个
     *
     * 这一片选 **(A)**，理由：
     *   · (B) 在"一个技能前面挂两个副本"时**算不出来**
     *     （第二个副本往后数第一个是 `skills[0]`、从它自己数却成了负数），
     *     而玩家明确要"一条序列里可以有好几个修饰"（只是不许叠同类）；
     *   · (A) 和"被修饰的技能排在前面、副本紧跟着它"是同构的 ——
     *     没有第三个坐标系。
     *
     * ⚠ 定稿那句话和 (A) **不矛盾**：`at` 数的是技能，而"紧邻"说的是
     *   副本在**编辑界面里**排的位置（副本显示在它修饰的技能前面）。
     *   数据里 `mods` 和 `skills` 是**两张并列的表**，
     *   "副本排第几个"在这张表里没有表达 —— 所以 `at` 只能数技能。
     *   ⚠ **这是待裁定项**（报告第 5 节）：编辑界面落地时如果要
     *     "拖副本到某个技能前面"，那时候要么给 `at` 补一个坐标系，
     *     要么让编辑器只允许 `at` = 被修饰技能的下标。
     */
    const targetRaw = mod.at
    if (!Number.isInteger(mod.at) || mod.at < 0 || targetRaw >= skillList.length) {
      problems.push({
        ...where,
        skillId: skillList[0] ?? '',
        paramKey: 'at',
        message: `序列段「${seg.name ?? seg.id ?? ownerId}」上的修饰副本「${proto.name}」指向它后面第 ${mod.at} 个技能，`
          + `但这一段只有 ${skillList.length} 个技能 —— 它修饰不到任何东西`,
      })
      continue
    }

    const targetIndex = compiledIndexAt.get(targetRaw)
    if (targetIndex === undefined) {
      // 它修饰的那个技能在技能表里查不到（`UNKNOWN_SKILL` 已经报过那一条）——
      // 这里不再重复报，只是**不产生副本**（触发一个不存在的技能毫无意义）
      continue
    }

    const p = mod.params ?? {}
    const compiled: CompiledMod = {
      source: mod,
      kind: proto.kind,
      targetIndex,
    }
    if (proto.kind !== 'wrap') {
      /*
       * ⚠ 参数**逐字从副本读**（副本才属于这份术式），读不到才回落到原型的
       *   `params`。反过来的话，玩家给这个副本改过的条件会被原型覆盖掉 ——
       *   而那正是"副本只属于这份术式"那条规矩要保住的东西。
       */
      const when = p['when'] ?? proto.params?.['when']
      if (typeof when === 'string') compiled.when = when as TriggerEvent
      const cond = p['condition'] ?? proto.params?.['condition']
      if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
        compiled.condition = cond as Condition
      }
      const crossing = p['crossing'] ?? proto.params?.['crossing']
      if (typeof crossing === 'boolean') compiled.crossing = crossing
      const origin = p['origin'] ?? proto.params?.['origin']
      if (typeof origin === 'string') compiled.origin = origin as TriggerOrigin
    }
    /*
     * ⚠ ---- **份数类修饰（多重释放 / 一分为 X）的份数**（日志 51）----
     *
     *   两个动词都只读一个数（`count`），所以在编译期**读好、夹好**，
     *   运行时不再查原型表 —— 和 `when` / `origin` 那几项放在同一个位置，
     *   理由是同一个：sim 里没有内容层，运行时"忘了读参数"的后果是静默的
     *   （表现是"我装了多重释放，它一次只打一个"）。
     */
    if (proto.kind === 'multi' || proto.kind === 'split') {
      const { count, raw, max, clamped } = modifierCountOf(mod, proto)
      compiled.count = count
      if (clamped) {
        /*
         * ⚠ **夹了就要说**。校验器已经会对着内容报
         *   `MODIFIER_COUNT_OVER_CAP` / `MODIFIER_COUNT_CLAMPED`（那是给作者看的），
         *   而这一条走的是另一条路：**手改的存档 / 老分享码**绕过校验器直接进世界。
         *   不说的话，玩家看到的是"我写了 12，它只打了 10" —— 而且无处可查。
         */
        problems.push({
          ...where,
          skillId: skillList[0] ?? '',
          paramKey: MODIFIER_COUNT_KEY,
          message: `序列段「${seg.name ?? seg.id ?? ownerId}」上的修饰副本「${proto.name}」要的份数是 ${raw}，`
            + `超过它的上限 ${max} —— 只按 ${count} 份放`,
        })
      }
    }
    /*
     * ⚠ ---- **「等待 X 秒」的三个参数**（2026-09-30 日志 52）----
     *
     *   和份数放在同一个位置、同一个理由：sim 里没有内容层，
     *   运行时"忘了读参数"的后果是静默的
     *   （表现是"我装了等待，它一点都不等 / 我锁了施法，它照样放技能"）。
     *
     *   ⚠ 三个参数各自**夹过 / 滤过**（读法在 `school.ts`）：
     *     秒数夹进 `[0.2, 原型上限]`、锁只留引擎认得的那四个值、
     *     打断档认不出就按默认的"不可打断"。
     */
    if (proto.kind === 'wait') {
      const { seconds, raw, max, clamped } = modifierSecondsOf(mod, proto)
      compiled.waitSeconds = seconds
      compiled.waitLocks = modifierLocksOf(mod, proto) as Capability[]
      compiled.waitInterrupt = modifierInterruptOf(mod, proto) as InterruptLevel
      if (clamped) {
        /*
         * ⚠ 和份数那条**同一个形状**：夹了就要说（手改的存档绕过校验器）。
         *   不说的话，玩家看到的是"我写了 30 秒，它只等了 3 秒" —— 无处可查。
         */
        problems.push({
          ...where,
          skillId: skillList[0] ?? '',
          paramKey: MODIFIER_SECONDS_KEY,
          message: `序列段「${seg.name ?? seg.id ?? ownerId}」上的修饰副本「${proto.name}」要等 ${raw} 秒，`
            + `超出它的范围 [${MODIFIER_SECONDS_MIN}, ${max}] —— 只按 ${seconds} 秒等`,
        })
      }
    }
    /*
     * ⚠ ---- **「排布」的五个参数**（2026-09-30 日志 53）----
     *
     *   和份数 / 等待放在同一个位置、同一个理由：sim 里没有内容层，
     *   运行时"忘了读参数"的后果是静默的
     *   （表现是"我装了排布，那几份一份都没挪"）。
     *
     *   ⚠⚠ **这里一个份数都不读**（玩家划的第一条硬界线）：
     *     这一块只填 `compiled.layout`，`compiled.count` 只由
     *     `multi` / `split` 那一支写 —— 排布加份数这条路**在类型上就不存在**。
     *
     *   ⚠ **摆法认不出来时整块缺席**（`modifierLayoutModeOf` 返回 undefined）：
     *     引擎读不到 `layout` 就**什么都不做**，校验器报
     *     `MODIFIER_LAYOUT_BAD_TYPE`。猜一个默认摆法 = 静默改语义。
     *
     *   ⚠ 半径 / 角度**都夹过**（读法在 `school.ts`）：夹了就说（和上面两条同一个形状），
     *     不说的话玩家看到的是"我写了 99 米，它只摆了 6 米"。
     */
    if (proto.kind === 'layout') {
      const mode = modifierLayoutModeOf(mod, proto)
      if (mode === undefined) {
        problems.push({
          ...where,
          skillId: skillList[0] ?? '',
          paramKey: MODIFIER_LAYOUT_TYPE_KEY,
          message: `序列段「${seg.name ?? seg.id ?? ownerId}」上的修饰副本「${proto.name}」的 `
            + `${MODIFIER_LAYOUT_TYPE_KEY} 不是 ${MODIFIER_LAYOUT_MODES.join(' / ')} 之一 —— `
            + '这一份**不会生效**（摆法认不出来时引擎不猜）',
        })
      } else {
        const r = modifierLayoutRadiusOf(mod, proto)
        const start = modifierLayoutStartAngleOf(mod, proto)
        const spread = modifierLayoutSpreadOf(mod, proto)
        const mirror = modifierLayoutMirrorAngleOf(mod, proto)
        compiled.layout = {
          mode,
          radius: r.radius,
          startAngle: start,
          even: modifierLayoutEvenOf(mod, proto),
          spread,
          mirrorAngle: mirror,
          /*
           * ⚠⚠ ---- **这个技能的载体里有没有"会飞的东西"**（2026-09-30 日志 61）----
           *
           *   用户定的：**载体是从施法者身上长出来的**（`meleeArc` / `self` /
           *   `aura` / `beam` / `capsule`）⇒ **环绕不起作用**（"什么都不做"，
           *   不是警告 —— 和「追踪」/「弹射」**同一条规矩**）。
           *
           *   ⚠⚠ **判据一行都不新写**：`school.ts` 的 `carrierFliesInWorld` ——
           *     校验器（那两条警告）和账本（不收钱）读的是**同一个函数**。
           *     这里只负责**把载体收集出来**（那个收集器在本文件里，
           *     和 `validator` / `pricing` 里那两份是同一个形状 ——
           *     README 定律："不许有两份的只有**判据**"）。
           *
           *   ⚠ **读的是"副本修饰的那个技能"**（`skillList[mod.at]`），
           *     和校验器那两条警告**读同一个位置**（`seg.skills[mod.at]`）——
           *     两处读不同的技能会出现"校验器说它起作用、引擎什么都不做"。
           *
           *   ⚠ 为什么在**编译期**算：sim 里没有内容层（技能表只在
           *     `compileTechnique` 的 `lookup` 里），运行时的
           *     `layoutPlanOf` 拿不到 `Skill`。这和 `count` / `waitSeconds`
           *     是同一个理由 —— 编译期读好，运行时只读产物。
           */
          carrierFlies: carrierFliesInSkill(skillList[mod.at], lookup),
        }
        /*
         * ⚠ **夹了就要说**（和份数 / 等待那两条同一个形状）：
         *   说的是**夹之前那个数**，所以这里重新读一遍副本里那份原始值。
         *   手改的存档 / 老分享码绕过校验器直接进世界 ——
         *   不说的话，玩家看到的是"我写了 9999 度，它摆了 180 度"，
         *   而且无处可查。
         */
        const alerts: Array<{ key: string, label: string, value: number, raw: unknown, lim: number }> = [
          {
            key: MODIFIER_LAYOUT_START_KEY, label: '起始角', value: start,
            raw: mod.params[MODIFIER_LAYOUT_START_KEY] ?? proto.params?.[MODIFIER_LAYOUT_START_KEY] ?? 0,
            lim: modifierLayoutMaxAngleOf(proto),
          },
          {
            key: MODIFIER_LAYOUT_SPREAD_KEY, label: '张角', value: spread,
            raw: mod.params[MODIFIER_LAYOUT_SPREAD_KEY] ?? proto.params?.[MODIFIER_LAYOUT_SPREAD_KEY] ?? 0,
            lim: modifierLayoutMaxSpreadOf(proto),
          },
          {
            key: MODIFIER_LAYOUT_MIRROR_KEY, label: '镜像偏移角', value: mirror,
            raw: mod.params[MODIFIER_LAYOUT_MIRROR_KEY] ?? proto.params?.[MODIFIER_LAYOUT_MIRROR_KEY] ?? 0,
            lim: modifierLayoutMaxAngleOf(proto),
          },
        ]
        for (const a of alerts) {
          if (typeof a.raw !== 'number' || a.raw === a.value) continue
          problems.push({
            ...where,
            skillId: skillList[0] ?? '',
            paramKey: a.key,
            message: `序列段「${seg.name ?? seg.id ?? ownerId}」上的修饰副本「${proto.name}」要的${a.label}是 ${String(a.raw)} 度，`
              + `超出它的范围（${a.key === MODIFIER_LAYOUT_SPREAD_KEY ? `[0, ${String(a.lim)}]` : `±${String(a.lim)}`}）`
              + ` —— 只按 ${String(a.value)} 度摆`,
          })
        }
        if (r.clamped) {
          problems.push({
            ...where,
            skillId: skillList[0] ?? '',
            paramKey: MODIFIER_LAYOUT_RADIUS_KEY,
            message: `序列段「${seg.name ?? seg.id ?? ownerId}」上的修饰副本「${proto.name}」要的半径是 ${r.raw} 米，`
              + `超出它的范围 [${r.min}, ${r.max}] —— 只按 ${r.radius} 米摆`,
          })
        }
      }
    }
    /*
     * ⚠ ---- **「追踪」的两个参数**（2026-09-30 日志 56）----
     *
     *   和份数 / 等待 / 排布放在同一个位置、同一个理由：sim 里没有内容层，
     *   运行时"忘了读参数"的后果是静默的
     *   （表现是"我装了追踪，它还是一条直线飞过去"）。
     *
     *   ⚠⚠ **这里一个"目标"都不读、也读不到**：候选目标是**发射那一刻**
     *     按投射物自己的位置找的（`sim/pipeline.ts` 的 `spawnProjectileFrom`
     *     调 `acquireHomingTarget`）—— 编译期世界还没跑，填一个目标就是猜。
     *     编译期只管"拐多快、**发射那一刻**能锁多远"（⚠ 2026-09-30 日志 62：
     *     `maxRange` 的语义从"飞行途中的射程"改成了"**索敌距离**"）。
     *
     *   ⚠ 两个数**都夹过**（读法在 `school.ts`）：夹了就说（和上面三条同一个形状），
     *     不说的话玩家看到的是"我写了 9999 米，它只追了 16 米"，
     *     而且无处可查。
     */
    if (proto.kind === 'homing') {
      const turn = modifierHomingTurnOf(mod, proto)
      const range = modifierHomingRangeOf(mod, proto)
      compiled.homing = { turnRate: turn.turnRate, maxRange: range.maxRange }
      const alerts: Array<{ key: string, label: string, unit: string, raw: unknown, value: number, min: number, max: number }> = [
        {
          key: MODIFIER_HOMING_TURN_KEY, label: '转速', unit: '度/tick',
          raw: mod.params[MODIFIER_HOMING_TURN_KEY] ?? proto.params?.[MODIFIER_HOMING_TURN_KEY] ?? 0,
          value: turn.turnRate, min: turn.min, max: turn.max,
        },
        {
          key: MODIFIER_HOMING_RANGE_KEY, label: '索敌距离', unit: '米',
          raw: mod.params[MODIFIER_HOMING_RANGE_KEY] ?? proto.params?.[MODIFIER_HOMING_RANGE_KEY] ?? 0,
          value: range.maxRange, min: range.min, max: range.max,
        },
      ]
      for (const a of alerts) {
        if (typeof a.raw !== 'number' || a.raw === a.value) continue
        problems.push({
          ...where,
          skillId: skillList[0] ?? '',
          paramKey: a.key,
          message: `序列段「${seg.name ?? seg.id ?? ownerId}」上的修饰副本「${proto.name}」要的${a.label}是 ${String(a.raw)} ${a.unit}，`
            + `超出它的范围 [${String(a.min)}, ${String(a.max)}] ${a.unit} —— 只按 ${String(a.value)} ${a.unit} 算`,
        })
      }
    }
    /*
     * ⚠ ---- **「弹射」的两个参数**（2026-09-30 日志 58）----
     *
     *   和上面四个零件放在同一个位置、同一个理由：sim 里没有内容层，
     *   运行时"忘了读参数"的后果是静默的
     *   （表现是"我装了弹射，它打完就消失了"）。
     *
     *   ⚠⚠ **次数那一条的上限不是数据说了算**：`modifierBounceCountOf` 的
     *     `max` 来自 `modifierBounceMaxCountOf(proto)`，而它把数据写的
     *     `maxBouncesCap` **夹在 `MAX_ACTION_DEPTH` 里** ——
     *     数据想写 9，引擎也只弹 4。⚠ 那**不是静默的**：校验器有一条
     *     `MODIFIER_BOUNCE_OVER_CAP` 专门报"数据想超过引擎的深度上限"。
     */
    if (proto.kind === 'bounce') {
      const count = modifierBounceCountOf(mod, proto)
      const falloff = modifierBounceFalloffOf(mod, proto)
      compiled.bounce = { maxBounces: count.maxBounces, damageFalloff: falloff.damageFalloff }
      const alerts: Array<{ key: string, label: string, unit: string, raw: unknown, value: number, min: number, max: number }> = [
        {
          key: MODIFIER_BOUNCE_COUNT_KEY, label: '弹射次数', unit: '次',
          raw: mod.params[MODIFIER_BOUNCE_COUNT_KEY] ?? proto.params?.[MODIFIER_BOUNCE_COUNT_KEY] ?? 0,
          value: count.maxBounces, min: count.min, max: count.max,
        },
        {
          key: MODIFIER_BOUNCE_FALLOFF_KEY, label: '每次衰减', unit: '（乘数）',
          raw: mod.params[MODIFIER_BOUNCE_FALLOFF_KEY] ?? proto.params?.[MODIFIER_BOUNCE_FALLOFF_KEY] ?? 0,
          value: falloff.damageFalloff, min: falloff.min, max: falloff.max,
        },
      ]
      for (const a of alerts) {
        if (typeof a.raw !== 'number' || a.raw === a.value) continue
        problems.push({
          ...where,
          skillId: skillList[0] ?? '',
          paramKey: a.key,
          message: `序列段「${seg.name ?? seg.id ?? ownerId}」上的修饰副本「${proto.name}」要的${a.label}是 ${String(a.raw)} ${a.unit}，`
            + `超出它的范围 [${String(a.min)}, ${String(a.max)}] ${a.unit} —— 只按 ${String(a.value)} ${a.unit} 弹`,
        })
      }
    }
    out.push(compiled)
  }

  return out
}

/**
 * 把**「等待 X 秒」的那些空档插进时间轴**（2026-09-30 日志 52）。
 *
 * ## 为什么是"插一个真阶段"，而不是新造一套等待机制
 *
 * 玩家那条规格的三件事（**占用施法者** / **锁四样能力** / **不可打断**）
 * 在引擎里**全都已经存在**，而且都挂在**阶段**上：
 *
 * | 规格那一句 | 引擎里现成的落点 |
 * | --- | --- |
 * | 期间施法者被占用，不能继续释放技能 / 术式 | `occupiesCaster` + `locks`（`canActivate` 的 `locked`） |
 * | 「锁哪些能力」四项可勾 | `Phase.locks`（`Capability` 的四个值，`applyPhaseLocks` 真的执行） |
 * | 默认不可打断 | `Phase.interrupt`（`InterruptLevel` 三档之一） |
 *
 * ⇒ 所以这一片**一行新引擎代码都不加**：编译期插一个 0 秒~X 秒的阶段，
 *   后面那些阶段**自然**被推后 X 秒（时间轴是**一条线**，
 *   `tickCast` 一个阶段一个阶段地走）。
 *   ⚠ 这同时保证了"等待**不是**并行" —— 它根本没有"并行"可以在哪儿发生。
 *
 * ## 插在哪一格（和 `at` 的关系）
 *
 * `at` 说的是"它修饰**这一段里第几个技能**"（`compileMods` 的注释：选 (A)），
 * 所以空档插在**那个技能的第一个阶段之前**：
 *
 *   `[A的前摇, A的命中, B的前摇, B的命中]` + 「等待，at: 1（管 B）」
 *     ⇒ `[A的前摇, A的命中, **等待**, B的前摇, B的命中]`
 *
 * ⚠ **等待阶段故意不挂在任何技能名下**（id 用段级的 `#wait`，
 *   `ownerOf` 取出来是空字符串），而**不是**写成 `B#wait`。理由：
 *   `advancePhase` 认"换技能了"的办法是**比阶段 id 的技能前缀** ——
 *   如果等待挂上 B 的前缀，那"从等待进 B 的第一个阶段"就**不过那道连接门**
 *   （门是按技能换不换判的），于是 `links` 的条件再也拦不住 B。
 *   挂在段级前缀上的话，"进等待"和"等待→B"各过一次门，
 *   两道门算的都是 `links[B-1]`（`advancePhase` 里 `k = skillIds.indexOf(skill)`），
 *   和没有等待时**同一条判据**。
 *
 * ⚠ **它必须排在 `at: 0` 也能生效**（不像份数类零件今天只认 `at: 0`）：
 *   插阶段这件事对任何 `at` 都是同一个动作，没有任何"两条时间轴"的麻烦 ——
 *   所以份数那条 `MODIFIER_GROUP_AT_NOT_WIRED` 警告**不适用于等待**。
 *
 * @param phases   `compileSkillChain` 产出的时间轴（**会被复制**，不改原数组）
 * @param skillIds 同一条链的**编译后**技能 id（`phase.id` 的前缀就是它）
 * @param mods     这一段的编译副本（只挑 `kind === 'wait'`）
 */
function insertWaitPhases(
  phases: readonly Phase[],
  skillIds: readonly string[],
  mods: readonly CompiledMod[],
): Phase[] {
  const waits = mods.filter(m => m.kind === 'wait' && m.waitSeconds !== undefined)
  if (waits.length === 0) return [...phases]

  /** 这个技能在第一份时间轴里的**第一个阶段**在哪（找不到 = 这个技能一个阶段都没有） */
  const firstPhaseAt = new Map<string, number>()
  for (let p = 0; p < phases.length; p++) {
    const phase = phases[p]
    if (phase === undefined) continue
    const owner = ownerOf(phase.id)
    if (!firstPhaseAt.has(owner)) firstPhaseAt.set(owner, p)
  }

  /*
   * ⚠ 按"插在第几个编译后技能前面"分组，**同一个下标只留第一个**：
   *   校验器的"一条序列里不叠同类"只挡得住同一种 `kind`，
   *   而手改的存档能在一段里塞两个等待副本。
   *   两个都插在同一个位置在语义上是安全的（就是 2X 秒），
   *   但**顺序必须确定** —— 可重放要求"同样的数据产出同样的时间轴"，
   *   所以这里按 `mods` 的顺序取第一个，而不是按 Map 的遍历顺序。
   */
  /*
   * ⚠ 插不到时间轴里的等待（`targetIndex` 越界、或者目标技能一个阶段都没有）
   *   **直接丢掉**，两条路都各自会出声（`compileMods` 的越界早退、
   *   校验器的 `MODIFIER_WAIT_NO_PHASES`），所以这里不重复报、也不静默地
   *   把它改插到别处 —— "等在所有技能之后"这种凭空多出来的空档，
   *   恰恰是这个项目最怕的那种"看起来生效了"。
   */
  const bySkill = new Map<number, CompiledMod>()
  for (const m of waits) {
    if (m.targetIndex >= skillIds.length) continue
    if (!bySkill.has(m.targetIndex)) bySkill.set(m.targetIndex, m)
  }

  /*
   * 插入点：**目标技能的第一个阶段之前**（插在下标 `p` 上）。
   */
  const atPhase = new Map<number, number>()
  let waitSeq = 0
  for (const [skillIndex, mod] of [...bySkill.entries()].sort((a, b) => a[0] - b[0])) {
    const owner = skillIds[skillIndex]
    const insertAt = owner === undefined ? undefined : firstPhaseAt.get(owner)
    if (insertAt === undefined) continue
    /*
     * ⚠ `id` 必须逐个不同：`enterPhase` 会把它写进 `castPhase` 事件、
     *   调试和 HUD 也按 id 认阶段。全叫 `#wait` 的话，
     *   "两段等待"在同一份编译产物里**分不开**（而它们可能是不同长度的）。
     */
    mod.waitPhaseId = `#wait${waitSeq++}`
    atPhase.set(insertAt, skillIndex)
  }

  const out: Phase[] = []
  for (let p = 0; p < phases.length; p++) {
    const isInsertPoint = atPhase.get(p)
    if (isInsertPoint !== undefined) {
      const mod = bySkill.get(isInsertPoint)
      if (mod !== undefined) out.push(waitPhaseOf(mod))
    }
    const phase = phases[p]
    if (phase !== undefined) out.push(phase)
  }

  /*
   * ⚠ 数量核对：`out` 必须正好是"原阶段 + 真正插进去的等待"。
   *   对不上说明上面那一趟漏了/多抓了阶段 ——
   *   宁可**整段退回原样**（等待不生效，校验器/编译器会报），
   *   也不要悄悄少掉一个前摇（那种 bug 半年后才被发现，而且查不出原因）。
   */
  return out.length === phases.length + waitSeq
    ? out
    : [...phases]
}

/**
 * 一个等待阶段的**形状** —— ⚠ 全项目只有这一处构造它。
 *
 * | 字段 | 取值 | 为什么 |
 * | --- | --- | --- |
 * | `duration` | 夹过的秒数 | 时间轴上的长度就是它 |
 * | `occupiesCaster` | **true** | 玩家定的"期间施法者被占用"—— 它同时让 `isBusy` 认得这一段。
 *   ⚠ 2026-09-30（日志 54）：**"放不出别的"这件事今天不靠它了** ——
 *   施法独占是引擎硬规矩（`hasRunningCast`，看的是"手上还有没有没放完的那一段"）。
 *   `occupiesCaster` 现在管的是排期口径（AI 引导期间不挪窝） |
 * | `locks` | 从参数读（只剩 `move` / `turn`）| 玩家定的"锁哪些能力做成参数"。
 *   ⚠ 日志 54 起 `cast` / `attack` **不在参数表里**了（引擎硬规矩，校验器报错） |
 * | `interrupt` | 从参数读，默认 `'none'` | 玩家定的"默认不可打断" |
 * | `cancellable` | **false** | ⚠ 见下 |
 * | `wait` | true | 给定价器认（`pricePhase` 见到它就返回 0） |
 *
 * ⚠ **`cancellable: false` 是我按现有先例取的，不是玩家说的**（记在日志 52 的待裁定项）：
 *   · 这个字段今天**引擎一处都不读**（`cancellable` 只在 schema 和编辑器里活着）；
 *   · 但它是**数据**，将来编辑器接上"主动取消"那一刻它就生效了，
 *     所以不能随手写 `true` —— "排好的等待被自己取消掉"，后果和"被打断"同构
 *     （后面那个技能**提前**打出来），而那正是玩家要避免的那件事。
 *   ⇒ 取"不可自己取消"，和"默认不可打断"同向。
 */
function waitPhaseOf(mod: CompiledMod): Phase {
  const seconds = mod.waitSeconds ?? 0
  return {
    id: mod.waitPhaseId ?? '#wait',
    name: `等待 ${formatWaitSeconds(seconds)} 秒`,
    duration: seconds,
    occupiesCaster: true,
    cancellable: false,
    locks: [...(mod.waitLocks ?? [])],
    interrupt: mod.waitInterrupt ?? 'none',
    wait: true,
  }
}

/** 秒数写成人看的样子（`1.5` / `0.2`）—— 只给 `Phase.name` 用，不参与任何计算 */
function formatWaitSeconds(seconds: number): string {
  return String(Math.round(seconds * 100) / 100)
}

/**
 * 把**一条技能链**（一个技能的列表 + 它们之间的门）编译成时间轴。
 *
 * ⚠ 容器那一层和序列那一层共用它（见 `compileTechnique` 里的调用点）。
 *
 * ⚠ `ownerLabel`（报错里那个"哪份术式"）和 `ownerId`（问题记录里的 techniqueId）
 *   **是两个东西**，别合成一个：
 *   · 容器那一层：`ownerLabel` 是术式的 `name`（给人看）、`ownerId` 是它的 id
 *   · 序列那一层：两者都是**段的 id**（给引擎和账认身份）
 *   合成一个的话，容器的报错会从"术式「裂地斩」引用了…"变成
 *   "术式「tech.cleave」引用了…" —— 而 `name` 才是给人看的那一个。
 *
 * ⚠ `ownSegmentIndex`（日志 61）：问题记录里的段号。容器那一层**不传** ——
 *   容器自己没有段号，"第 0 段"是撒谎（见 `CompileProblem.segmentIndex`）。
 */
function compileSkillChain(
  ownerId: string,
  ownerLabel: string,
  skillList: readonly string[],
  techLinks: readonly SkillLink[] | undefined,
  lookup: SkillLookup,
  problems: CompileProblem[],
  ownSegmentIndex?: number,
): { phases: Phase[]; rules: Rule[]; ruleSlots: number; skillIds: string[]; links: SkillLink[]; compiledIndexAt: Map<number, number> } {
  const phases: Phase[] = []
  const rules: Rule[] = []
  const skillIds: string[] = []
  const links: SkillLink[] = []
  /**
   * 原始下标 → 编译后下标。
   *
   * ⚠ 修饰副本的 `at` 用的是**原始下标**（内容里那个 `skills` 数组的位置），
   *   而运行时读的是编译产物（跳过了查不到的技能）。这张表是两者的桥 ——
   *   用它而不是"运行时再算一遍"，是因为"算一遍"就有了第二份真相。
   */
  const compiledIndexAt = new Map<number, number>()
  let ruleSlots = 0

  for (let i = 0; i < skillList.length; i++) {
    const skillId = skillList[i] as string
    const skill = lookup(skillId)
    if (skill === undefined) {
      problems.push({
        techniqueId: ownerId,
        skillId,
        // ⚠ 原始下标：界面画的是数据里那一行（见 `CompileProblem.skillIndex`）
        skillIndex: i,
        ...(ownSegmentIndex !== undefined ? { segmentIndex: ownSegmentIndex } : {}),
        message: `术式「${ownerLabel}」引用了不存在的技能：${skillId}`,
      })
      continue
    }

    /*
     * ⚠ 连接条件按**编译后的位置**排，不是按原始的 `skillList` 下标。
     *
     *   上面那个 `continue` 会把找不到的技能**整段跳过** ——
     *   于是 `skillIds` 会比 `skillList` 短，两者的下标对不上。
     *   直接拿 `techLinks` 当下标用的话，少一个技能就会让后面所有条件
     *   整体错位一格（"碰到才炸"变成"没碰到才炸"，而且完全静默）。
     *
     *   `techLinks[i-1]` 是**原始下标**（它管的就是 `skillList[i]`），
     *   按顺序 push 进 `links` 之后就自然对齐到编译后的位置了。
     */
    if (i > 0) links.push(techLinks?.[i - 1] ?? {})

    skillIds.push(skillId)
    const prefix = `${skillId}#`

    for (const p of skill.phases) {
      phases.push({ ...p, id: prefix + p.id })
    }
    /*
     * ⚠ 走 `allRulesOf`（固有效果 + 规则），不是 `skill.rules`。
     *
     *   固有效果（"这个技能是什么"）在这里被折成一条
     *   `when: 'phaseComplete'` 的规则 —— 引擎那边**不需要新概念**，
     *   它认的还是"什么时机、做什么事"。
     *   漏了这一句的表现是：技能有阶段、有代价、账上也有数，
     *   **但打出去什么都没有**（而且不报错、不崩）。
     */
    for (const r of allRulesOf(skill)) {
      const copy: Rule = { ...r, id: prefix + r.id }
      if (r.phaseId !== undefined) copy.phaseId = prefix + r.phaseId
      rules.push(copy)
    }
    ruleSlots += skill.ruleSlots
    compiledIndexAt.set(i, skillIds.length - 1)
  }

  return { phases, rules, ruleSlots, skillIds, links, compiledIndexAt }
}

/**
 * 一份**空**的编译产物。
 *
 * ⚠ 只有一个用处：老形状的序列（字符串 id）在编译期拿不到技能 ——
 *   它要等运行时按 `refId` 去世界里查。给它一份空时间轴而不是 `undefined`，
 *   是为了让读取方少一条分支（"有没有 segments"和"这一段有没有编译产物"是两件事）。
 */
function emptyCompiled(
  id: string,
  name: string,
  activation: Technique['activation'],
  targeting: Targeting,
): CompiledTechnique {
  return {
    id,
    name,
    activation,
    targeting,
    phases: [],
    rules: [],
    ruleSlots: 0,
    skillIds: [],
    links: [],
    bloodPactCost: 0,
  }
}

/** 反查：这个阶段/规则属于哪个技能。编辑器和高亮用得上 */
export function ownerOf(id: string): string {
  const i = id.indexOf('#')
  return i < 0 ? '' : id.slice(0, i)
}

/*
 * ⚠ 这里原来有个 `skillLookupFor(tech, factory)` ——
 *   它负责"这份术式自己的技能副本优先"。
 *
 *   那个模型废了（玩家 2026-09-21 纠正：技能不属于术式）。
 *   现在是**两个库**：基础技能库（内容）+ 自定义技能库（存档），
 *   术式按 id 引用技能。所以调用方只要建一张**合并后的表**就行，
 *   不需要按术式分别解析。
 */

/** 去掉前缀，拿到技能内的原始 id */
export function localId(id: string): string {
  const i = id.indexOf('#')
  return i < 0 ? id : id.slice(i + 1)
}
