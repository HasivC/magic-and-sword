/**
 * 模拟核心的数据结构。
 *
 * ⚠ 纪律 4：这个目录下的所有文件，不许引用任何外部 API。
 *   没有时间 API、没有全局随机、没有 window/document、没有 node:fs。
 *   原因：模拟必须能被重放、能被无头批跑、能在主机和客户端跑出同样的结果。
 *   `npm test` 里的 purity 测试会自动检查这一条。
 */
import type {
  Action, AiProfile, AttributeMod, BlockPolicy, Capability, DeliveryKind, EntityDef, EntityShape,
  Faction, PipelineHook, PipelineStage, RemovalRule, StatusDef,
} from '../schema.ts'
import type { CompiledTechnique } from './compile.ts'

/** 二维向量（朝向、方向） */
export interface Vec2 {
  x: number
  y: number
}

/**
 * 三维位置。
 *
 * z 只用于渲染（击飞、浮空），**不参与碰撞和判定**。
 * 这是 2D 俯视游戏表达"飞起来"的最小代价。
 */
export interface Vec3 {
  x: number
  y: number
  z: number
}

/**
 * ⚠ Faction 的定义搬到了 schema/scenario-schema.ts —— 场景是内容，内容要能写它。
 *   这里只转出一次，别在两处各写一份（会漂移）。
 */
export type { Faction }

export type EntityKind =
  | 'actor'       // 玩家或敌人
  | 'projectile'  // 投射物
  | 'area'        // 留在地上的区域
  /*
   * 掉在地上的一件东西 —— 现在只有**武器**（见 WeaponInstance）。
   *
   * ⚠ 玩家 2026-09-21 给的前提：
   *   > 换武器的前提是武器有建模，能作为实体被交互。
   *
   *   所以武器不是一个"角色身上的数字"，而是一个**站着不动的实体**：
   *   能看见、能走过去、能被捡起来。`item` 不做别的事 ——
   *   不动、不打、不挨打、不进区域（见 cast.ts 的 tickAreaOverlap）。
   */
  | 'item'
  /*
   * **屏障**：竖在那儿挡东西的一道墙（玩家 2026-09-21 要的）。
   *
   * ⚠ 和 `area`（火墙、迟滞场）的区别只有一条，但是本质的：
   *   `area` 什么都不妨碍，谁都能穿过去；
   *   `obstacle` **挡** —— 挡子弹、也能挡人（按 `Entity.block` 的四个开关）。
   */
  | 'obstacle'

/**
 * 一件武器在**运行时**的样子。
 *
 * ⚠ 它是 `WeaponDef` 的一份**拷贝**，不是引用 ——
 *   理由是纪律 4：sim 不许读文件，也不认识"内容层"这个概念。
 *   内容层把 `content/weapons/*.json` 读成这个纯数据对象，然后交进来。
 *
 * ⚠ `attributes` 是 `weapon.*` 那几条参数（reach / damage / windup）。
 *   技能里的 `ref: 'weapon.damage'` 读的就是它 ——
 *   这就是"同一份横砍模板，长剑和短匕打出来不一样"的全部机制。
 */
export interface WeaponInstance {
  /** 武器定义 id（`weapon.longsword`）。HUD 和存档用它 */
  id: string
  /** 给人看的名字。捡起来的时候要能说"换上了长剑" */
  name: string
  /** `weapon.*` 属性表 */
  attributes: Record<string, number>
}

/**
 * 存储属性：会被**直接改写**的状态量。
 *
 * 和派生属性的区别是整个属性系统的地基：
 *   存储属性（char.hp.current / char.energy.current / char.bloodPact.current）
 *              —— 真的加减，存在实体上
 *   派生属性（char.hp.max / char.energy.regen / speed）—— 基础值 + 状态修饰，算出来的
 *
 * 状态修饰**不要**用在存储属性上。要持续扣血，用一条 onTick 规则。
 * 校验器会检查这一条（MODIFIER_ON_STORED）。
 *
 * ⚠ `char.bloodPact.current` 是**血契**：负值术式的燃料。
 *
 *   它不是第 1 版的"手写在 Cost 上的那个字段"那个东西（那个删掉了，
 *   因为点数是算出来的）。这一条是**引擎里的真实资源**，和能量一样：
 *     · 残血、被挂上负面状态、抵押属性上限 —— 这些"进入危机"的行为给它加
 *       （引擎只提供"加一条属性"这个能力，具体数额由内容写，见 content/techniques/blood-pact.json）
 *     · 释放一个**负值术式**时按它的 |点数合计| 扣掉
 *     · 不够就放不出来（和能量不足是同一种失败）
 *
 *   玩家 2026-09-21 定的量级：日常在 10 上下，攒一整局才够一次 ~100 的终极。
 */
export const STORED_ATTRIBUTES: readonly string[] = [
  'char.hp.current', 'char.energy.current', 'char.bloodPact.current',
]

export function isStoredAttribute(path: string): boolean {
  return STORED_ATTRIBUTES.includes(path)
}

/**
 * 武器参数的**缺省值**。
 *
 * ⚠ 为什么需要它：武器技能模板里写的是 `ref: 'weapon.reach'`
 *   （同一份模板在不同武器上代入不同的值），而**武器可以只写它关心的那几项**。
 *   没有缺省值的话，忘写 `reach` 的武器会得到一把**打不到人的剑** ——
 *   而那种错误在界面上完全不明显（"我明明按了普攻"）。
 *
 * ⚠ 它放在引擎里而不是 schema 里，是因为 schema 是**纯类型**的
 *   （一个值都不导出）。这里是和 `STORED_ATTRIBUTES` 同一类的
 *   "引擎和内容共同约定的一张小表"。
 *
 * 命名空间是 `weapon.*` 而不是 `char.*`：
 *   `char.*` 是**人**的属性（血量上限、移速），
 *   混进去会分不清"这把剑更长"和"这个人跑得更快"。
 */
export const WEAPON_DEFAULTS: Readonly<Record<string, number>> = {
  'weapon.reach': 2.5,
  'weapon.damage': 1,
  'weapon.windup': 1,
}

/** 读一个武器参数，缺项走默认值 */
export function weaponParam(attributes: Record<string, number>, key: string): number {
  const v = attributes[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return WEAPON_DEFAULTS[key] ?? 0
}

// ============================================================================
//  伤害管线的实例
// ============================================================================

/**
 * 一次"命中"的全部数据。它在六个阶段之间流动，每个阶段都可能改动它。
 *
 * **伤害和治疗共用这一个结构**，只是 kind 不同 ——
 * 否则禁疗、治疗加成、亡灵反转每一条都要写两遍。
 *
 * 它的字段同时也是"伪属性"，可以在钩子里用 AttributePayload 改：
 *   pipeline.amount     当前数值（可以 add / mul / set）
 *   pipeline.cancelled  设为 1 = 拦截掉这次（名刀司命）
 *   pipeline.reverse    设为 1 = 反转方向（亡灵受治疗受伤）
 *   pipeline.absorbed   已被吸收掉多少（引擎写，只读）
 */
export interface HitInstance {
  kind: 'damage' | 'heal'
  /** 谁打出来的 */
  sourceId: number
  /** 打谁 */
  targetId: number
  /** 当前数值。每个阶段都可能被改 */
  amount: number
  /** 进管线之前的原始值，用于统计和显示 */
  rawAmount: number
  /** 伤害类型标签：fire / physical / shadow…… 抗性靠它匹配 */
  damageType?: string
  /** 附带标签，供抗性匹配 */
  tags: string[]
  /** lethal = 无视生命值（阿瓦达索命） */
  mode: 'normal' | 'lethal'
  /** 被拦截了吗 */
  intercepted: boolean
  /** 被谁拦的 */
  interceptedBy?: string
  /** 实际被护盾吃掉了多少 */
  absorbed: number
  /** 实际生效多少 */
  applied: number
  /** 打下去了吗（没被拦截、也没被完全吸收） */
  connected: boolean
  /** 走的哪个技能（第 4 步才会有值） */
  techniqueId?: string
  /** 走过哪些阶段，调试用 */
  stages: PipelineStage[]
}

export type HitKind = HitInstance['kind']

// ============================================================================
//  投射物
// ============================================================================

/**
 * 挂在投射物实体上的"命中后要做什么"。
 *
 * 为什么放在实体上而不是另开一张表：
 *   投射物飞出去之后，发射它的那次施法可能早就结束了。
 *   它必须**自己带着**要执行的动作和归属信息，否则命中时没人知道该谁负责。
 *
 * 这也是为什么 `actions` 直接引用内容里的 Action —— 它是不可变的定义，不是运行时状态。
 */
export interface ProjectileSpec {
  /** 命中后执行的动作（来自发射它的那条规则） */
  actions: Action[]
  /** 命中判定用哪套有效目标 */
  valid: string[]
  /** 发射者。伤害归属和阵营判定都靠它 */
  sourceId: number
  /** 用的哪个术式。onHit / onKill 规则要能找到它 */
  techniqueId?: string
  /** 已经打中过谁。穿透弹靠它避免重复命中 */
  hitIds: number[]
  /** 命中后是否继续飞 */
  pierce: boolean
  /**
   * **这一发会不会自己在半路上拐向最近的敌人**（修饰零件「追踪」，2026-09-30 日志 56）。
   *
   * ⚠⚠ **它是在发射那一刻从 `CompiledMod.homing` 冻结下来的**（`sim/pipeline.ts`
   *   的 `spawnProjectileFrom`），不是运行时回头去查原型表 —— 和 `cast.facing`
   *   同一条纪律：
   *     · sim 里**没有内容层**（原型表是 `bridge.ts` 读进来的），运行时查不到；
   *     · 子弹飞出去之后那次施法早就结束了（这个文件上面那段说的就是这件事）；
   *     · 半路上被别人改了原型，**已经飞出去的那一发不该变**（那正是"发射即锁定"）。
   *
   * ⚠ 缺省 = **不追**。所以老存档 / 手改的数据 / 别的调用方（测试直接
   *   `spawnProjectile`）都不用改一个字 —— "没写"就是今天的行为（直着飞）。
   */
  homing?: {
    /** 每 tick 最多转多少度（已夹到 `[1, 原型上限]`，读法在 `school.ts`） */
    turnRate: number
    /**
     * ---- **索敌距离**（米，已夹到 `[minRange, 原型上限]`）----
     *
     * ⚠⚠ **2026-09-30 日志 62 改了语义**（用户原话："**限制不应该是射程，而是持续时间**
     *   —— 这样就**追到消失**"）：
     *   · 改之前：这是**射程** —— 每一 tick 都拿它筛一遍，目标跑出去就**丢锁**；
     *   · 改之后：这是**索敌距离** —— 它只在**发射那一刻**用一次
     *     （"这一发能找到多远的目标"），锁上就**一路咬到这一发自己消失为止**。
     *   ⚠ 键名**故意没改**（还是 `maxRange`）：改键名要同步代码 / 校验器 / 内容 / 点数表，
     *     而这一片要的只是**语义**（文案在 `content/modifiers/homing.json` 与 `content/balance.json`）。
     */
    maxRange: number
    /**
     * **发射那一刻锁定的那个目标**（`Entity.id`；`undefined` = 那一刻一个都没找到）。
     *
     * ⚠ 它和 `maxRange` 是**同一刻**定下来的（`sim/pipeline.ts` 的 `spawnProjectileFrom`
     *   在投射物被造出来之后立刻问一次），之后**再也不会变**：
     *   · 目标跑多远都不丢锁（那正是玩家要的"追到消失"）；
     *   · 目标死了 / 已经打过了 / 变得不合法 ⇒ 这一发**直走**，**不许**换一个目标
     *     （"换目标"是玩家没定的语义，猜它等于把 `maxRange` 变成一个新旋钮）。
     */
    lockedId?: number
  }
  /**
   * **这一发命中之后会不会弹给下一个敌人**（修饰零件「弹射」，2026-09-30 日志 58）。
   *
   * ⚠⚠ 和 `homing` 同一条纪律：**发射那一刻**从 `CompiledMod.bounce` 冻结下来
   *   （`sim/pipeline.ts` 的 `spawnProjectileFrom`），运行时不再查原型表。
   *
   * ⚠⚠ **它在链上是一份"会变小"的状态**（这是它和 `homing` 最大的不同）：
   *   命中的那一下会**再放一颗新子弹**（`sim/projectile.ts` 的 `bounceToNextTarget`），
   *   而新那颗带的是 `{ left: left - 1, amountScale: amountScale × damageFalloff, … }`
   *   （⚠ `amountScale` 只乘**伤害** —— 见下面那一段和 `ActionContext.amountScale`）。
   *
   *   为什么是"再放一颗新子弹"而不是"把这一颗掉头"：
   *   · 掉头那一颗的 `lifetime` 已经飞掉一半了 —— 第二段可能在半路**静默过期**
   *     （表现是"我设了弹 2 次，它只弹了 0 次"，而且无处可查）；
   *   · 新子弹出生时 `lifetime` 是全新的（`delivery.lifetime`），
   *     而且它自己带 `hitIds`（打过的都带上 ⇒ **不许弹回刚打过的那个**）。
   *
   * ⚠ 缺省 = **不弹**。所以老存档 / 手改的数据 / 别的调用方（测试直接
   *   `spawnProjectile`）都不用改一个字 —— "没写"就是今天的行为（打完就消失）。
   */
  bounce?: {
    /** 还能弹几次（发射时 = `min(数据要的, MAX_ACTION_DEPTH)`，每一段减一） */
    left: number
    /**
     * **这一段的伤害乘多少**（第 k 段 = `damageFalloff` 的 k 次方，用连乘算，不用 `pow`）。
     *
     * ⚠⚠ **它只管 `damage`，不碰 `heal`**（2026-09-30 日志 58 第二版，用户裁定）：
     *   "衰减只作用于伤害，不要乘 heal —— 用户原话只说'伤害'，而且'会弹的治疗'是另一种机制"。
     */
    amountScale: number
    /** 每弹一次，下一段的**伤害**乘多少（< 1 = 衰减；默认 0.7 = 玩家说的"−30%"） */
    damageFalloff: number
  }
  /**
   * **这一类的飞行参数**（速度 / 存在时间 / 粗细）—— 弹射的下一段要**照原样再飞一次**。
   *
   * ⚠ 为什么要抄一份进 `spec`：`spawnProjectile` 是**从 `delivery` 读**这三个数的，
   *   而弹射发生在**命中那一刻** —— 那时候手里只有 `spec`，**没有** `delivery`
   *   （发射那次施法早就结束了，见 `ProjectileSpec` 顶上那段）。
   *   不抄的话第二段只能吃 `spawnProjectile` 的默认值（12 米/秒 / 1.2 秒 / 0.25 米）——
   *   一颗慢悠悠的大火球弹一下会变成一支快箭，而且**没有任何地方会说**。
   *
   * ⚠ 缺省（别的调用方直接 `spawnProjectile` 而不走 `spawnProjectileFrom`）⇒
   *   弹射读不到它 ⇒ **只按默认值飞**（今天没有别的调用方会带 `bounce`）。
   */
  flight?: {
    speed: number
    lifetime: number
    radius: number
  }
  /**
   * 命中时播哪条特效（`content/fx/<id>.json`）。
   *
   * ⚠ 和发射时的 `DeliverySpec.vfx` 是**两个不同的时机**：
   *   发射时投射物不发特效（它自己就是实体，客户端已经在画它了），
   *   所以投射物只在**命中**时才发事件 —— 命中火花必须打在目标身上。
   */
  vfx?: string
  /** 伤害类型，命中特效按它上色 */
  damageType?: string
}

// ============================================================================
//  施法实例（阶段机的状态）
// ============================================================================

/**
 * 一次正在进行的施法。
 *
 * 技能不是"按一下就打出去"，而是一条时间轴：
 *   前摇 → 释放 → 后摇，中间被打断就整段作废。
 * 这个结构就是那条时间轴的游标。
 */
export interface CastInstance {
  id: number
  casterId: number
  technique: CompiledTechnique
  /**
   * **这一次施法"从头到尾"是哪一份编译产物**（容器 / 序列术式那一层）。
   *
   * ⚠ 大多数时候它就是 `technique`（普通术式、触发器链条、命令行）。
   *   两者**不一样的只有一条路**：序列术式按下某一段时，`technique` 是
   *   `resolveSegment` 给的**段**产物（只有阶段和规则），而这一份是容器
   *   （带着 `segments[].mods` —— 修饰副本住在那一层）。
   *
   * ⚠ 为什么非要有它（2026-09-30 日志 55）：「载体消失」要在**很多 tick 之后**
   *   回头找"这个技能上挂了哪一份触发器副本"，而那时候手里只有这次施法留下的
   *   东西 —— 段那份里 `segments` 是空的 ⇒ 遍历到一个空数组 ⇒
   *   触发器**永远不响、而且一声不吭**。
   */
  homeTechnique: CompiledTechnique
  /** 当前走到第几个阶段 */
  phaseIndex: number
  /** 当前阶段已经过了多少秒 */
  elapsed: number
  /**
   * 这次施法的**攻速倍率**：每个阶段的时长都乘它。
   *
   * ⚠ 玩家 2026-09-21 定的方向：
   *   > 术式级攻速倍率：`weapon.windup` 只乘所有阶段时长
   *
   *   比"把每个阶段都写成动态参数"好懂，也比"先不做"完整：
   *   一把慢剑就是每一段都慢一点，而不是某一段特别慢。
   *
   * ⚠ 它在**施法瞬间**从施法者当时手上的武器算一次，然后**锁住**：
   *   挥到一半把剑换成匕首，这一刀不该突然变快 ——
   *   那既说不清（动画都播了一半），也会让"换武器"变成一种取消后摇的技巧。
   */
  speedScale: number
  /** 蓄力值。duration = -1 的蓄力阶段靠它累积 */
  charge: number
  /** 哪些阶段的代价已经付过了。被打断时不自动退还 —— 那正是"早付"的风险 */
  paid: boolean[]
  interrupted: boolean
  finished: boolean
  /** 施法瞬间锁定的目标 */
  targetId?: number
  /** 施法瞬间锁定的朝向。之后锁定朝向的技能（激光）靠它 */
  facing: Vec2
  /**
   * 载体中心的坐标 —— **只在 `areapoint` 模式下和 caster 的位置不同**。
   *
   * ⚠ 它必须在**施法瞬间**算好并锁住，不能每帧重新读鼠标：
   *   地面技能一旦放出去，火墙就长在那块地上了，
   *   不能因为玩家把鼠标移开就跟着跑。
   */
  aimPoint?: Vec2
  /**
   * **已经作用到过目标的技能段**（`skill.product` 的 id）。
   *
   * ⚠ 这是"术式能编程"的关键状态：`links` 里的 `prevHit` 条件问的就是
   *   "上一段技能有没有碰到人"。
   *
   * 记的是**技能 id** 而不是阶段下标：一个技能可能有好几个阶段，
   * 判定发生在哪个阶段都算这一段碰过了。
   */
  hitSkills: string[]
  /**
   * 这次瞄准是**按哪条规则**解析出来的（`resolveAim` 的 reason）。
   *
   * 只用于 UI 提示和调试 —— 玩家需要知道"为什么这一发打的是它"
   * （尤其 `auto` 和"锁不到所以退回朝向"这两种情况）。
   */
  aimReason?: string
  /**
   * 当前阶段**禁用了施法者的哪些能力**（`Phase.locks` 的运行时影子）。
   *
   * ⚠ 为什么要有它：`locks` 以前是**惰性字段** —— schema 里有、内容里写了
   *   （贯日写着 `locks: ["turn"]`）、校验器认真检查它的取值、
   *   说明生成器还会为它写一句话，而**引擎一处都不读**。
   *   于是"无法转向的激光"根本做不出来，作者却以为已经做了。
   *
   * 语义：**在这个阶段里，施法者做不了这些事。** 由 `applyPhaseLocks()`
   * 每 tick 强制执行（不是靠调用方自觉 —— AI 和玩家走的是同一条路）。
   */
  locks: Capability[]
  /**
   * `locks` 里有 `turn` 时，**进入这个阶段那一刻**的朝向。
   *
   * ⚠ 必须是"进入阶段时"的快照，不是施法时的朝向：
   *   一个技能的蓄力阶段锁朝向，锁的该是"开始蓄力时朝哪"，
   *   而不是"按下技能时朝哪" —— 两者之间可能隔着好几个阶段。
   */
  lockedFacing?: Vec2
  /**
   * 这次施法是**哪条序列**、属于哪个序列术式（输入层填的）。
   *
   * ⚠ 它记的是**容器**（`tech.longsword-basic`）+ 段号，不是被放的那一段
   *   （`tech.ws-slash` 自己是 `technique`）——
   *   因为"下一步走哪"要问的是容器：它是拥有序列列表的那个人。
   */
  sequence?: { techniqueId: string; index: number }
  /**
   * **同一次激活的记号**（份数类修饰：多重释放 / 一分为 X，2026-09-21 日志 51）。
   *
   * ⚠ 一次激活里打出的 N 份共用它（= 第一份那次施法的 `cast.id`）。
   *   它存在的唯一理由：**这一组什么时候算结束**。N 份各自跑自己的时间轴，
   *   而"结束"这件事（推进连段链、消费缓冲按键、记 `lastEndTick`）
   *   **一次激活只能发生一次** —— 所以 `onSequenceEnd` 会等**最后一份**。
   */
  activation?: number
}

/**
 * 一个实体的**序列链**状态（武器术式那套"按一次走一段"）。
 *
 * ⚠ 为什么它必须存在**模拟里**（而不是客户端的一个变量）：
 *   · AI 也要能连招 —— AI 没有客户端
 *   · 重放/局域网同步：同一份输入必须走出同一串招式
 *   · 快照要能回答"他下一刀会出哪一段"
 *
 * ⚠ 每个实体**一条链**（不是每条术式一条）：
 *   一个人手上就一把武器、一套普攻。同时在两把武器之间交替按是
 *   现在的玩法里不存在的事；真出现了再按术式拆开。
 */
export interface SequenceChain {
  /** 哪条序列术式的链 */
  techniqueId: string
  /** 下一次**自己按下**时该走第几段（0 起） */
  next: number
  /** 上一段结束是在哪个 tick（-1 = 还没走过）。超时回第一段靠它 */
  lastEndTick: number
  /**
   * 上一段还在放的时候**缓冲**下来的那次按键是在哪个 tick（-1 = 没有）。
   *
   * ⚠ 玩家 2026-09-21 定的是"**放完才走下一段**，按下进 150ms 缓冲"：
   *   连点不会插队，也不会丢输入 —— 但缓冲只在短时间内有效，
   *   不然"随手多按几下"会让他几秒后莫名其妙又挥一刀。
   */
  bufferedTick: number
}

// ============================================================================
//  状态
// ============================================================================

/** 正在生效的一个状态实例 */
export interface ActiveStatus {
  defId: string
  name: string
  tags: string[]
  stacks: number
  /** 剩余秒数。-1 = 永久 */
  remaining: number
  /** 初始时长。动态参数 elapsed（已持续多久）要拿它减 remaining */
  duration: number
  /** 谁挂上来的 */
  sourceId: number
  /** 禁用了目标哪些能力（控制效果就是它） */
  disables: Capability[]
  /** 对派生属性的修改 */
  modifiers: AttributeMod[]
  /** 挂载的伤害管线钩子（护盾、伤转治疗、免疫致命伤） */
  hooks: PipelineHook[]
  /** 免疫带这些标签的状态（霸体） */
  immuneTags: string[]
  /**
   * 这个状态实例自己的运行时变量。
   * 护盾的剩余池子（pool）就存在这里 —— 同一个状态定义，每个实例一份。
   */
  vars: Record<string, number>
  /** 可见性覆盖。0 = 完全隐形 */
  visibility?: number
  /**
   * **阵营覆盖**（魅惑就是它）。
   *
   * ⚠ 为什么把它做成状态字段、而不是"改 `entity.faction` 的动作"：
   *   魅惑在玩法上天生是**临时的**，而且应该能被驱散。
   *   做成状态之后，这两件事**一点额外机制都不用加** ——
   *   时长到了自己还原，净化类技能按标签就能摘掉它。
   *   而"永久改阵营"用 `duration: -1` 写出来就是了。
   *
   * ⚠ `'caster'` 在**施加的那一刻**就解析成具体阵营了（见 `applyStatus`），
   *   所以这里存的永远是 `player` / `enemy` / `neutral` 之一。
   *   不这么做的话，`factionOf()` 就得拿着 world 去查来源是谁 ——
   *   而它是被 `matchesValid` 这类热点函数调用的。
   */
  faction?: Faction
  /**
   * 视觉表现：用哪条序列帧特效（`content/fx/<id>.json`）。
   *
   * ⚠ 这一条以前是**死字段**：`StatusDef.vfx` 声明了、出厂内容里有 15 处写了它，
   *   但 `ActiveStatus` 根本没把它抄过来，所以客户端想看也看不到。
   *   现在抄过来了 —— 客户端可以直接遍历 `entity.statuses` 画出"谁身上有什么"。
   *
   * 没素材的时候不写就行：客户端会按标签退回到程序化光环。
   */
  vfx?: string
  removal?: RemovalRule
}

export interface Entity {
  id: number
  kind: EntityKind
  /** 引用哪个定义（EntityDef.id），可选 */
  defId?: string
  /** 类别标签：undead / boss / construct…… 目标有效性靠它匹配 */
  tags: string[]
  /**
   * **现在有哪些实体站在我里面**（只有 `kind: 'area'` 会填）。
   *
   * ⚠ 这是"进入 / 离开"两个时机**唯一**的判据来源：
   *   引擎没有空间索引，也没有"重叠事件"这种东西 ——
   *   每 tick 拿上一帧的名单和这一帧比一次，差集就是进和出。
   *
   * 存的是**实体 id 数组**、按 `world.entities` 的顺序填，
   *   不用 Set：集合的遍历顺序在跨引擎时没有保证，
   *   而这里是模拟的一部分，必须逐位可重放。
   */
  inside: number[]
  faction: Faction
  pos: Vec3
  /** 速度（米/秒）。投射物和击退都靠它 */
  vel: Vec3
  /**
   * 外力冲量（米/秒），会自己衰减。
   *
   * 为什么不直接加到 vel 上：AI 每 tick 都会覆写 vel，
   * 那样击退会当场被抹掉。冲量单独存一份，`integrate` 把它加在 vel 之外。
   */
  push: Vec3
  /**
   * 朝向，单位向量。
   *
   * 为什么不用角度：角度要用 sin/cos 才能变成方向，而 sin/cos 不保证
   * 跨浏览器逐位一致，会破坏重放。存向量就完全不需要三角函数。
   */
  facing: Vec2
  alive: boolean
  /** 存储属性：会被直接改写 */
  stored: Map<string, number>
  /** 派生属性的基础值。最终值 = 基础值 + 状态修饰 */
  base: Map<string, number>
  statuses: ActiveStatus[]
  /**
   * 这个实体**天生**带的管线钩子（不需要状态就生效的被动）。
   * 亡灵生物"受治疗反而受伤"就挂在这里。
   */
  hooks: PipelineHook[]
  /**
   * 当前生效的常驻术式 id（activation 是 auto 的被动，或 toggle 打开的）。
   *
   * 这是管线钩子的**第三个来源**：技能图。名刀司命做成武器被动就用它。
   * 只存 id，术式定义放在 world.techniques 里 —— 不然快照会变得很大。
   */
  activeTechniques: string[]
  /**
   * 规则的触发间隔计时器：键是 `术式id:规则id`，值是"还要等多少秒"。
   *
   * onTick 规则写了 `every` 就靠它限速 —— 不然一秒触发 60 次，
   * "每 0.5 秒扣 3 能量"会变成每秒扣 180 点。
   */
  ruleTimers: Map<string, number>
  /**
   * 最近一次挨伤害是在哪个 tick。
   *
   * ⚠ 为什么要有这个字段：伤害是在管线里结算的（一 tick 的第 9 步），
   *   而施法推进在第 5 步 —— **施法比伤害早**。想在"挨打就断"里
   *   立刻反应，管线就得反过来 import 施法系统，那是个循环依赖。
   *   所以伤害只留一个时间戳，施法那边自己比：
   *   `damagedTick === world.tick - 1` 就是"上一个 tick 挨过打"。
   *
   * 没有挨过打是 -1。
   */
  damagedTick: number
  /** 投射物命中后要做什么。只有 kind === 'projectile' 的实体才有 */
  payload?: ProjectileSpec
  /** 这个实体会哪些术式（AI 从这里挑） */
  techniqueIds: string[]
  /** AI 配置。没有就是不会自己动 */
  ai?: AiProfile
  /** 距离下次 AI 决策还有多久（秒） */
  aiThinkAt: number
  /** 投射物的发射者 / 召唤物的主人 */
  ownerId?: number
  /**
   * 主人死了就跟着消失（`spawn` 载荷的 `lifetime: 'untilCasterDies'`）。
   *
   * ⚠ 只有召唤物会用它。投射物有 `ownerId` 但**不**跟着主人死 ——
   *   人都死了，箭还在飞，这是对的。
   */
  diesWithOwner?: boolean
  /** 剩余存在时间（秒）。-1 = 永久 */
  lifetime: number
  /** 碰撞半径（米） */
  radius: number
  /**
   * 身上的武器。
   *
   *   `kind: 'actor'` → **拿着的**武器（`weapon.*` 参数从它读）
   *   `kind: 'item'`  → 地上躺着的**就是**它
   *
   * ⚠ 两种情况共用一个字段，是因为它们本来就是同一件事：
   *   "这件东西身上的武器"。捡起来 = 把这个对象从 item 挪到 actor 上，
   *   然后把人手上原来那个挪到地上（见 equip.ts）。
   *
   * 没武器（undefined）时 `weapon.*` 读**全局缺省值**（`WEAPON_DEFAULTS`），
   *   所以空手的敌人照样放得出技能，不会因为少一把剑就变成打不到人。
   */
  weapon?: WeaponInstance
  /**
   * 序列链的状态（武器术式那套）。没连过就是 undefined。
   * ⚠ 解释见 `SequenceChain` 的注释 —— 它必须在模拟里，不在客户端里。
   */
  chain?: SequenceChain
  /**
   * **形状**（只有 `kind: 'obstacle'` 真的会读它；不写就是圆）。
   *
   * ⚠ 运行时的一份**拷贝**（和 `weapon` 同理）：sim 不认识内容层。
   */
  shape?: EntityShape
  /**
   * **谁能穿过我**（`kind: 'obstacle'` 读它）。不写就是默认策略：
   * 自己的子弹放行 / 敌人的子弹挡住 / 人不挡。
   */
  block?: BlockPolicy
}

// ============================================================================
//  解析上下文
// ============================================================================

/**
 * 解析动态参数需要的上下文。
 *
 * 这是第 3 步才补上的东西：没有它，`ref: 'distance'`（越近越慢）、
 * `ref: 'selfHpPct'`（残血增伤）这些全都没法算。
 */
export interface ValueContext {
  world: World
  /** 条件里的 self / 动态参数里的 selfHpPct 指的是谁 */
  self: Entity
  target?: Entity
  /** 如果是在伤害管线里跑，带上管线实例（可以引用 pipeline.* 伪属性） */  hit?: HitInstance
  /** 如果是状态的钩子，带上宿主状态（可以引用它的层数和 vars） */
  status?: ActiveStatus
  /** 如果是在施法里跑（规则执行），带上施法实例 */
  cast?: CastInstance
}

/** 执行一个动作需要的上下文 */
export interface ActionContext extends ValueContext {
  /** 动作的发起者 */
  actor: Entity
  /** 动作来源的 id（技能或状态），onlyBy 白名单匹配它 */
  sourceId?: string
  /** 递归深度。触发链超过上限就截断，防止自我触发刷屏 */
  depth: number
  /**
   * 这次动作的有效目标标签（来自术式的 targeting.valid）。
   * 有载体规格的动作靠它筛选范围里的人。
   */
  validTargets?: string[]
  /**
   * **这一次命中里"伤害"乘多少**（修饰零件「弹射」的衰减，2026-09-30 日志 58）。
   *
   * ⚠ 缺省 = **不乘**（消费方读的是 `ctx.amountScale ?? 1`）⇒ 除了弹射，
   *   引擎里**没有任何一条路**会写它：今天的行为一个字节都不变。
   *
   * ⚠ 为什么衰减要落在这里，而不是"把载荷的 `amount` 乘一下"：
   *   载荷里的 `amount` 是**未解算**的 `ValueSpec`（可能是 `{ ref: 'weapon.damage' }`
   *   这种动态值，见 `spawnProjectileFrom` 抄进 `spec.actions` 的就是原样那一份）。
   *   编译期没法乘它（那时候还不知道施法者是谁）——
   *   所以只能在**结算那一刻**乘，而那正是 `executeAction` 解算 `amount` 的地方。
   *
   * ⚠⚠ **它只乘 `damage`，不碰 `heal`**（2026-09-30 日志 58 **第二版**，用户裁定：
   *   "衰减只作用于伤害，不要乘 heal —— 用户原话只说'伤害'，而且'会弹的治疗'
   *   是另一种机制"）。`status` / `spawn` 那类本来就没有"量"可衰减。
   *   ⇒ 换句话说：**引擎里读它的地方只有一处**（`executeAction` 的 `damage` 那一支）。
   */
  amountScale?: number
}

// ============================================================================
//  世界
// ============================================================================

/** 一 tick 内发生的事情。渲染层和上层逻辑靠它知道"刚刚发生了什么" */
export type CastBlockReason =
  | 'dead' | 'silenced' | 'cooldown' | 'energy'
  /**
   * **手上已经有一段"进行中的施法"** —— 施法独占（引擎硬规矩）。
   *
   * ⚠ 2026-09-30（日志 54）口径收紧了，玩家原话："玩家又没有第二人格"：
   *   同一个人、同一时刻**只能有一段进行中的施法**。
   *   · 以前它只覆盖"**这一门术式有占人阶段**（`occupiesCaster`）**且**
   *     那一段占着人"——于是瞬发 / 脱手术式能从中间插进去，**两段同时在跑**；
   *   · 现在它只问"手上还有没有没放完的那一段"，**与 `locks` / `occupiesCaster` 无关**
   *     （把锁解开也不许并行）。武器攻击是同一条路 ⇒ "边等边砍"同样不成立。
   *   ⚠ **脱手技照样能"放完立刻再放"**：它的那一段很快就 `finishCast` 了，
   *     拒的只是"**还没放完**的时候再插一段"。
   *   ⚠ 客户端把它翻成"**正在施法**"（`web/src/main.ts` 的 `blockReason`）。
   */
  | 'busy'
  /** 挨了伤害，而当前阶段的打断等级是 'damage' */
  | 'damaged'
  /**
   * 正在进行的某个阶段**禁用了施法**（`Phase.locks` 里有 `cast`）——
   * **内容作者写在阶段上的那句声明**。
   *
   * ⚠ 和 `busy` 分开：`busy` 是**引擎硬规矩**（同一个人只有一段施法，2026-09-30
   *   日志 54），而 `locked` 是"这一段明确不许你再放别的"。
   *   后者更具体，所以两件事同时成立时**以 `locked` 为准**（见 `canActivate` 的顺序）。
   *
   * ⚠ 它**不再**是"能不能并行"的开关（那是硬规矩，不可配）；
   *   修饰零件（`content/modifiers/*.json`）里的 `locks` 也**不许**再写 `cast` /
   *   `attack`（校验器报 `MODIFIER_LOCK_ENGINE_RESERVED`）。
   */
  | 'locked'
  | 'unknown'
  /**
   * 这是个**负值术式**，而血契不够。
   *
   * ⚠ 和 `energy` 分开，不是合并成"资源不足"：
   *   血契不是自动回复的，玩家必须知道"我差多少、还得去挨几下"，
   *   而能量等一会儿就回来了。两种提示的**行动建议完全不同**。
   */
  | 'bloodPact'
  /**
   * 这是一门 **`activation: 'auto'` 的常驻术式**，它不响应按键。
   *
   * ⚠ 为什么要单独一个原因（而不是复用 `locked` / `busy`）：
   *   玩家报了"按了没反应"的时候，必须能一眼区分
   *   "我被控住了"（过一会儿能放）和"**这个东西本来就没有按键**
   *   （它在常驻那一栏里，装上就生效）"—— 后者的行动建议是
   *   "去常驻术式那个分组看"，和前者的处置完全不同。
   *
   * ⚠ 2026-09-21（日志 48）加它的直接原因：**常驻包装**（修饰技能）
   *   把一整块变成常驻之后，那一块就**不参与按键激活**了。
   *   没有这条原因的话，玩家按下去只会看到"什么都没发生"。
   */
  | 'autoTechnique'

export type SimEvent =
  | { type: 'spawned'; id: number }
  | { type: 'removed'; id: number; reason: 'expired' | 'died' | 'despawned' }
  | { type: 'statusApplied'; entityId: number; statusId: string; stacks: number }
  | { type: 'statusExpired'; entityId: number; statusId: string }
  | { type: 'statusImmune'; entityId: number; statusId: string; byStatus: string }
  | { type: 'damaged'; entityId: number; sourceId: number; amount: number; absorbed: number; lethal: boolean }
  | { type: 'healed'; entityId: number; sourceId: number; amount: number }
  | { type: 'hitIntercepted'; entityId: number; sourceId: number; byStatus: string }
  | { type: 'shieldBroken'; entityId: number; statusId: string }
  /**
   * 有人被挪动了（击退 / 拉拽 / 冲刺 / 传送）。
   *
   * ⚠ 为什么位移要发事件：它**不是伤害的附属品**。
   *   冲刺和传送一点伤害都没有，但客户端必须知道"这一下把人挪走了"。
   *   只从 `damaged` 反推的话，这两种技能在画面上是隐形的。
   *
   * `distance` 是**载荷上写的**距离，不是实际位移 —— 实际位移会被
   * 对方自己的移动抵消一部分。要看真实位移就前后对比 pos。
   */
  | { type: 'displaced'; entityId: number; techniqueId: string; mode: string; distance: number }
  /**
   * 放了一个**负值术式**，血契被扣掉。
   *
   * ⚠ 它必须是个事件，不能只靠客户端去读属性：
   *   "血契从 12 掉到 4"和"血契从 12 掉到 4 是因为刚放了个大招"
   *   在界面上是完全不同的两件事 —— 后者要有一圈红光或者一个碎裂音效，
   *   因为那是这一局里最贵的一次点击。
   */
  | { type: 'bloodPactSpent'; entityId: number; techniqueId: string; amount: number; left: number }
  /**
   * 有人**跨过**了低血线（血量百分比掉到 LOW_HP_PCT 以下的那一瞬间）。
   *
   * ⚠ 只在这一下发，不是每 tick 发 —— 客户端拿它播"濒死"的表现
   *   （红屏、心跳声），发成持续的就变成一直闪。
   */
  | { type: 'lowHp'; entityId: number; hpPct: number }
  /**
   * 有人被"揪出来"了（`perception` 的 reveal）。
   *
   * `removed` 是被扒掉的隐形状态个数 —— 0 表示他本来就没藏，
   * 这一次 reveal 是空放。客户端靠它决定要不要播"现形"的表现。
   */
  | { type: 'revealed'; entityId: number; techniqueId: string; removed: number }
  /**
   * 有人被召唤出来了（`spawn` 载荷）。
   *
   * ⚠ 它和 `spawned` 不是一回事：`spawned` 是"世界里多了一个实体"（引擎级），
   *   这一条是"某个技能召唤了一个单位"（玩法级）——
   *   客户端要靠它播召唤特效、给召唤物挂血条。
   */
  | {
    type: 'summoned'
    entityId: number
    ownerId: number
    defId: string
    /** 解析之后的阵营（`caster` 已经换算成召唤者的阵营） */
    faction: Faction
  }
  | { type: 'died'; entityId: number; killerId: number }
  | { type: 'castStarted'; castId: number; casterId: number; techniqueId: string }
  | { type: 'castPhase'; castId: number; casterId: number; phaseId: string; index: number }
  | { type: 'castInterrupted'; castId: number; casterId: number; techniqueId: string; phaseId: string }
  | { type: 'castFinished'; castId: number; casterId: number; techniqueId: string }
  /**
   * 一个**瞬时载体**打出去了（扇形 / 光束 / 突刺 / 范围 / 光环）。
   *
   * ⚠ 为什么要有这条事件：15 种事件全是"结果"（damaged / healed / statusApplied…），
   *   没有"过程"。客户端只能从 `damaged` 反推是谁打的 ——
   *   **打空了就什么都没有**，而打空恰恰是最需要看得见的时刻。
   *
   * ⚠ 它是**几何**，不是渲染指令：
   *   起点、方向、长度、宽度、半径、张角，全是数字。
   *   和 `damaged` 带一个 `amount` 是同一类东西，不违反纪律 4。
   *
   * ⚠ 投射物**不发**这条 —— 它是个实体，客户端已经在画它了。
   */
  | {
    type: 'deliveryFired'
    casterId: number
    techniqueId: string
    kind: DeliveryKind
    from: Vec2
    /** 单位向量 */
    dir: Vec2
    length?: number
    width?: number
    radius?: number
    angle?: number
    /** 打中了几个。0 = 打空了 —— **也要发** */
    hitCount: number
    /** 伤害类型，客户端按它上色 */
    damageType?: string
    /** 指定用哪条序列帧特效（见 DeliverySpec.vfx）。不写就用程序化的 */
    vfx?: string
  }
  | { type: 'castBlocked'; casterId: number; techniqueId: string; reason: CastBlockReason }
  /**
   * 一个**修饰技能**（触发器 / 监测器）的条件成立了，它后面那个技能被放了出去。
   *
   * ⚠ 为什么要有这条事件（而不是让客户端去读状态反推）：
   *   "血少到 30% 以下时自动撑起一层盾"里，**"是它自己触发的"这件事本身**
   *   才是玩家要看的东西 —— 玩家原话是「被打得越狠越想要它」，
   *   而一个不知从哪儿冒出来的盾和一个"背水生效了"的盾在画面上完全不同。
   *
   * ⚠ `at` 是**这次触发的落点**（生成位置四选一算出来的那一个点）。
   *   不写 = 这次触发没钉点（落在施法者自己身上，走技能那套瞄准）。
   */
  | {
    type: 'modifierTriggered'
    entityId: number
    techniqueId: string
    /** 哪个修饰原型（`content/modifiers/` 的 id） */
    protoId: string
    /** 被放出去的那个技能 */
    skillId: string
    /** 是哪个时机触发的（`TriggerEvent`） */
    when?: string
    at?: Vec2
  }
  /**
   * 一个修饰技能**条件成立了但没放出去**（被代价拦住了）。
   *
   * ⚠ 它和 `castBlocked` **故意分开**：`castBlocked` 是"玩家按了一下没放出来"，
   *   而这一条是"玩家什么都没按，某个常驻的零件想放却没放出来"。
   *   后者的原因（能量不够 / 那个技能还在冷却）必须能显示，
   *   否则玩家看到的是"条件明明到了，什么都没发生"。
   */
  | {
    type: 'modifierBlocked'
    entityId: number
    techniqueId: string
    protoId: string
    skillId: string
    reason: CastBlockReason
  }
  /*
   * ---- 换武器 ----
   *
   * ⚠ 发事件而不是只靠返回值，是因为"手上换了把武器"会改变**后面所有事**：
   *   伤害、攻速、左键走哪几段序列、HUD 上写什么。
   *   客户端把这些当状态读（每帧读 `entity.weapon`）也行，
   *   但"装备变了"这件事本身需要一个明确的时刻 —— 飘字、音效、
   *   以后要做"换武器时刷新某个被动"都挂在它上面。
   */
  | { type: 'weaponEquipped'; entityId: number; itemId: number; weaponId: string; name: string }
  | { type: 'weaponDropped'; entityId: number; itemId: number; weaponId: string }
  /*
   * ---- 屏障 ----
   *
   * 一颗子弹被墙拦下了。
   *
   * ⚠ 单独一条事件（而不是复用 `damaged`），是因为**画面需要知道"是墙挡的"**：
   *   火花该打在墙面上、声音该是"叮"而不是"噗"。
   *   而且墙挨的那一下还会照常发 `damaged`（它真的掉了血/掉了一层次数盾），
   *   两条事件说的是两件事，都要有。
   */
  | { type: 'blocked'; blockerId: number; projectileId: number; sourceId: number }

export interface World {
  /** 每 tick 多少秒。固定不变 —— 这是"固定 tick"的全部含义 */
  dt: number
  /** 已经推进了多少 tick */
  tick: number
  /**
   * 顿帧剩余时长（秒）。
   *
   * 命中瞬间整个世界停一下 —— 这是打击感里最有用的一件事，
   * 比闪白、飘字、抖屏加起来的贡献都大。
   *
   * ⚠ 它属于**模拟**，不属于渲染。
   *   渲染层假装停顿的话，模拟还在跑，停顿结束后敌人会"跳"一下。
   *   放在这里，所有人（包括局域网里的对手）经历的是同一段停顿。
   */
  hitstop: number
  /** 确定性随机数的内部状态 */
  rngState: number
  entities: Entity[]
  nextId: number
  /** 本 tick 产生的事件。每 tick 开始时清空 */
  events: SimEvent[]
  /**
   * 状态定义表。规则里用 statusId 引用内置状态时从这里查。
   *
   * 放在 World 上而不是模块级的全局变量 —— 模块级可变状态会让
   * "同一个种子跑出同样的结果"这条保证失效。
   */
  statusDefs: Map<string, StatusDef>
  /** 术式定义表。常驻技能（auto / toggle）的钩子要从这里查 */
  techniques: Map<string, CompiledTechnique>
  /**
   * 实体预设表。`spawn` 载荷按 `entityId` 从这里查。
   *
   * 和 statusDefs 一样放在 World 上而不是模块级全局 ——
   * 模块级可变状态会让"同一个种子跑出同样的结果"失效。
   */
  entityDefs: Map<string, EntityDef>
  /** 正在进行的施法 */
  casts: CastInstance[]
  nextCastId: number
  /**
   * 这一 tick **新挂上**了状态的实体 id（同一个实体可能重复出现）。
   *
   * ⚠ 存在的理由是打断递归：`applyStatus` 跑在伤害管线里面，
   *   而 `onStatusApplied` 的规则又可能施加新状态。当场触发就是递归，
   *   深度还取决于内容怎么写。排队到这个 tick 的固定位置再跑，深度恒为 1。
   *   详见 `cast.ts` 的 `tickStatusAppliedRules`。
   *
   * 只在**第一次挂上**时入队 —— 刷新时长和叠层不入队（否则一个
   * 每秒重挂的 debuff 会变成血契刷子）。
   */
  pendingStatusApplied: number[]
}

// ============================================================================
//  构造
// ============================================================================

/** 创建一个状态的运行时实例，并把吸收池初始化好 */
export function makeActiveStatus(
  def: StatusDef,
  sourceId: number,
  stacks: number,
): ActiveStatus {
  const hooks = [...(def.hooks ?? [])]

  // 吸收池：护盾和次数盾共用这一个字段，只是消耗规则不同
  const vars: Record<string, number> = {}
  for (const h of hooks) {
    if (h.absorb === undefined) continue
    vars['pool'] = (vars['pool'] ?? 0) + h.absorb.perStack * stacks
  }

  return {
    defId: def.id,
    name: def.name,
    tags: [...def.tags],
    stacks,
    remaining: def.duration,
    duration: def.duration,
    sourceId,
    disables: [...(def.disables ?? [])],
    modifiers: [...(def.modifiers ?? [])],
    hooks,
    immuneTags: [...(def.immuneTags ?? [])],
    vars,
    ...(def.visibility !== undefined ? { visibility: def.visibility } : {}),
    /*
     * ⚠ 阵营**不在这里抄** —— 它由 `applyStatus` 解析之后写进来。
     *   因为 `'caster'` 要解析成"施法者的阵营"，而那需要查 world，
     *   这个函数是纯的（只拿到 def 和 sourceId）。
     */
    ...(def.vfx !== undefined ? { vfx: def.vfx } : {}),
    ...(def.removal !== undefined ? { removal: def.removal } : {}),
  }
}
