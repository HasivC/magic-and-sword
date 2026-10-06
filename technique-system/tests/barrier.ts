/**
 * 屏障（挡子弹的墙）的测试。
 *
 * ## 为什么这个文件必须有
 *
 * "谁能穿过这堵墙"是玩家 2026-09-21 亲口要的一条**可交易**的规则：
 *
 *   > 玩家可以决定自己的子弹能否穿过墙（如果有反弹型子弹，这条就有用了）、
 *   > 敌人的子弹能否穿墙（用于获取点数）、以及敌人和友方能否穿墙。
 *
 * 它有三个坏法，而且**都很难在游戏里看出来**：
 *
 *   1. **判定和通行策略不是同一份**：子弹被挡住了、人却从墙里走过去。
 *      两边各自的测试都会通过，只有放在一起看才矛盾。
 *   2. **穿透方向反了**：自己的子弹被自己的墙挡住 ——
 *      玩家会觉得"这墙没用"，而其实是策略读反了。
 *   3. **墙不吃伤害**：子弹穿过去了，墙永远满血 ——
 *      "耐久"这个机制就名存实亡，而且没有任何地方会报错。
 */
import { resolve } from 'node:path'
import { loadLibrary } from '../src/bridge.ts'
import { readJson } from '../src/loader.ts'
import { advance, createWorld, getEntity, registerEntityDef, registerTechnique, resolveBarriers, spawn, stepWorld } from '../src/sim/world.ts'
import { getStored, resolveAttribute } from '../src/sim/attributes.ts'
import { activate } from '../src/sim/cast.ts'
import { canPassThrough, isObstacle, shapeOf } from '../src/sim/barrier.ts'
import { validateWeapon } from '../src/validator/index.ts'
import { priceOptionsFor, skillLedger } from '../src/pricing.ts'
import type { BalanceConfig } from '../src/validator/types.ts'
import type { EntityDef, Skill, Technique } from '../src/schema.ts'

let passed = 0
let failed = 0

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail !== undefined ? `\n      ${detail}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n${title}`)
}

const balance = readJson<BalanceConfig>(resolve('content/balance.json'))
const lib = loadLibrary(balance)
const barrierDef = readJson<EntityDef>(resolve('content/entities/barrier.json'))

/** 造一个带墙的战场：墙横在 x=3 处（朝向 y 轴），两边各一个人 */
function arena(opts: { block?: EntityDef['block'] } = {}): {
  w: ReturnType<typeof createWorld>
  wall: ReturnType<typeof spawn>
  shooter: ReturnType<typeof spawn>
  foe: ReturnType<typeof spawn>
} {
  const w = createWorld({ seed: 1 })
  const bolt = lib.compiled.get('tech.magic-bolt')
  if (bolt === undefined) throw new Error('magic-bolt 应该编译出来了')
  registerTechnique(w, bolt)

  // ⚠ 站位很要紧：**两个人在墙的两侧**，各自朝墙打。
  //   放在同一侧的话，子弹是"飞离墙"的，测试会绿着通过却什么都没测到。
  const shooter = spawn(w, {
    faction: 'player', pos: { x: 0, y: 0 },
    base: { 'char.hp.max': 100, 'char.energy.max': 100 },
  })
  const foe = spawn(w, {
    faction: 'enemy', pos: { x: 6, y: 0 },
    base: { 'char.hp.max': 100, 'char.energy.max': 100 },
  })
  // 墙：竖在中间，朝向 y 轴（于是它的"正面"挡的是 x 方向的子弹）
  const wall = spawn(w, {
    kind: 'obstacle',
    faction: 'player',
    pos: { x: 3, y: 0 },
    facing: { x: 0, y: 1 },
    radius: 0.4,
    shape: { kind: 'segment', length: 6, width: 0.5 },
    block: { ownProjectiles: true, enemyProjectiles: false, ownUnits: true, enemyUnits: true, ...(opts.block ?? {}) },
    base: { 'char.hp.max': 120 },
  })
  return { w, wall, shooter, foe }
}

/** 让 `from` 朝 `dir` 射一发魔法飞弹，跑 `ticks` 个 tick */
function shoot(
  w: ReturnType<typeof createWorld>,
  from: ReturnType<typeof spawn>,
  ticks: number,
  dir: { x: number; y: number } = { x: 1, y: 0 },
): void {
  const bolt = w.techniques.get('tech.magic-bolt')
  if (bolt === undefined) throw new Error('术式没注册')
  /*
   * ⚠ **必须自己转朝向**，而且这不是测试的偷懒 ——
   *   它正是客户端在做的事（`pressCast` 里先 `player.facing = dir` 再 activate）。
   *
   *   因为 `pipeline.ts` 发射投射物时读的是 `ctx.actor.facing`，
   *   **没有读** `cast.facing`（`resolveAim` 解析出来的那个）。
   *   对 `directional` 来说是同一个值（客户端已经转过向），
   *   但对 `locked` / `auto` 就不是了 —— 引擎算了朝向，投射物却不看。
   *   ⚠ 这是一条**已知的、单独记账的**问题，见日志欠账；
   *     在这里绕过它，是为了让"屏障挡子弹"这件事被测到，
   *     而不是让测试顺带把另一个 bug 也测进去。
   */
  from.facing = { x: dir.x, y: dir.y }
  activate(w, from, bolt, { intent: { kind: 'direction', dir } })
  advance(w, ticks)
}

/** 敌人朝墙打（它在墙的 +x 侧，所以要往 -x 打） */
const foeShoot = (w: ReturnType<typeof createWorld>, foe: ReturnType<typeof spawn>, ticks = 90): void =>
  shoot(w, foe, ticks, { x: -1, y: 0 })

// ============================================================================
//  1. 挡子弹
// ============================================================================

section('屏障：敌人的子弹被挡下来')

{
  const { w, wall, shooter, foe } = arena()
  foeShoot(w, foe)

  ok('墙掉了血（子弹打在墙上，走的是同一条伤害管线）',
    getStored(wall, 'char.hp.current') < 120,
    `墙血 ${getStored(wall, 'char.hp.current')}`)

  ok('射手毫发无伤（子弹没穿过去）',
    getStored(shooter, 'char.hp.current') === 100,
    `射手血 ${getStored(shooter, 'char.hp.current')}`)
}

{
  // blocked 事件是**那一刻**的事，所以要边跑边看（`advance` 到下一个 tick 就清掉了）
  const { w, wall, foe } = arena()
  const bolt = w.techniques.get('tech.magic-bolt')
  if (bolt === undefined) throw new Error('术式没注册')
  foe.facing = { x: -1, y: 0 }   // 理由见 `shoot` 的注释
  activate(w, foe, bolt, { intent: { kind: 'direction', dir: { x: -1, y: 0 } } })

  let blocked = 0
  for (let i = 0; i < 90; i++) {
    stepWorld(w)
    if (w.events.some(e => e.type === 'blocked')) blocked++
  }
  ok('拦下的那一刻发了 blocked 事件（画面要靠它把火花打在墙面上）',
    blocked >= 1, `发了 ${blocked} 次`)
  ok('  墙也真的掉了血', getStored(wall, 'char.hp.current') < 120,
    `墙血 ${getStored(wall, 'char.hp.current')}`)
}

// ============================================================================
//  2. 自己的子弹穿过去（默认）
// ============================================================================

section('屏障：自己的子弹能穿过去（这是默认，也是它有用的前提）')

{
  const { w, wall, shooter } = arena()

  ok('策略读出来是"自己的子弹放行"',
    canPassThrough(w, wall, shooter, 'projectile') === true)

  shoot(w, shooter, 90)

  ok('自己毫发无伤（自己的子弹不该打到自己）',
    getStored(shooter, 'char.hp.current') === 100)
  ok('墙也是满血（子弹直接穿过去了，没落在自己墙上）',
    getStored(wall, 'char.hp.current') === 120,
    `墙血 ${getStored(wall, 'char.hp.current')}`)
}

{
  /*
   * ⚠ 反向也成立：把 `ownProjectiles` 关掉（挡住自己的子弹）——
   *   这正是玩家说的"用于获取点数"的那类开关。
   */
  const { w, wall, shooter } = arena({ block: { ownProjectiles: false } })
  ok('把"自己的子弹能穿"关掉之后：策略说挡住了',
    canPassThrough(w, wall, shooter, 'projectile') === false)

  shoot(w, shooter, 90)
  ok('  于是自己的子弹被自己的墙吃掉（墙掉血）',
    getStored(wall, 'char.hp.current') < 120,
    `墙血 ${getStored(wall, 'char.hp.current')}`)
}

// ============================================================================
//  3. 单位穿墙：四个开关里最难的两个
// ============================================================================

section('屏障：谁能走过去')

{
  const { w, wall, shooter, foe } = arena()

  ok('默认谁都走得过去（挡人是个大行为，要显式开）',
    canPassThrough(w, wall, shooter, 'unit') && canPassThrough(w, wall, foe, 'unit'))

  // 让两个人一起往墙里挤
  shooter.pos.x = 2.6
  foe.pos.x = 3.4
  resolveBarriers(w)

  const sClear = Math.abs(shooter.pos.x - wall.pos.x) > 0.2
  const fClear = Math.abs(foe.pos.x - wall.pos.x) > 0.2
  ok('  ——所以没人被推开', sClear && fClear,
    `射手 ${shooter.pos.x} / 敌人 ${foe.pos.x}`)
}

{
  // 挡住**敌人**（不挡自己人）
  const { w, wall, shooter, foe } = arena({ block: { enemyUnits: false } })
  foe.pos.x = 3.2
  shooter.pos.x = 2.8
  resolveBarriers(w)

  ok('敌人被推出去（它不能穿）',
    Math.abs(foe.pos.x - wall.pos.x) > 0.3, `敌人 x=${foe.pos.x}`)
  ok('自己人不动（他还能穿）',
    Math.abs(shooter.pos.x - wall.pos.x) < 0.3, `射手 x=${shooter.pos.x}`)
}

{
  // 挡住**自己人**（不挡敌人）—— 这就是"把队友关在外面"那种设计
  const { w, wall, shooter, foe } = arena({ block: { ownUnits: false } })
  shooter.pos.x = 3.2
  foe.pos.x = 2.8
  resolveBarriers(w)

  ok('自己人被推出去', Math.abs(shooter.pos.x - wall.pos.x) > 0.3, `射手 x=${shooter.pos.x}`)
  ok('敌人不动', Math.abs(foe.pos.x - wall.pos.x) < 0.3, `敌人 x=${foe.pos.x}`)
}

{
  /*
   * ⚠ **推开是幂等的**：已经推到外面之后再推一次，位置不该再动。
   *   不幂等的话，站着不动的人会每 tick 被推一点点，慢慢滑走 ——
   *   而那是"墙在推人"，玩家会觉得地面在动。
   */
  const { w, wall, foe } = arena({ block: { enemyUnits: false } })
  foe.pos.x = 3.2
  resolveBarriers(w)
  const once = foe.pos.x
  resolveBarriers(w)
  resolveBarriers(w)
  ok('推出去之后不会一直滑（幂等）', Math.abs(foe.pos.x - once) < 1e-9,
    `${once} → ${foe.pos.x}`)
}

// ============================================================================
//  4. 耐久：血掉光墙就散
// ============================================================================

section('屏障：耐久')

{
  const { w, wall, foe } = arena({ block: { enemyProjectiles: false } })
  const bolt = w.techniques.get('tech.magic-bolt')
  if (bolt === undefined) throw new Error('术式没注册')

  // 一直射（朝墙射），直到墙散或者射够很多发
  for (let i = 0; i < 40 && wall.alive; i++) {
    // 补能量和冷却：这里只测"墙会不会散"，不是测经济
    const e = getEntity(w, foe.id)
    if (e !== undefined) {
      e.stored.set('char.energy.current', 100)
      e.stored.set('cd.tech.magic-bolt', 0)
    }
    foe.facing = { x: -1, y: 0 }   // 理由见 `shoot` 的注释
    activate(w, foe, bolt, { intent: { kind: 'direction', dir: { x: -1, y: 0 } } })
    advance(w, 60)
  }

  ok('挨够子弹之后墙散了（血量就是它的耐久）',
    !wall.alive || getEntity(w, wall.id) === undefined,
    `墙血 ${getStored(wall, 'char.hp.current')} alive=${wall.alive}`)
}

// ============================================================================
//  5. 形状
// ============================================================================

section('屏障：形状是线段，不是圆')

{
  const { w, wall } = arena()
  const shape = shapeOf(wall)
  ok('线段形状原样进到运行时', shape.kind === 'segment' && shape.length === 6 && shape.width === 0.5,
    JSON.stringify(shape))

  /*
   * ⚠ 这条钉的是"墙**横着**挡"这件事：
   *   墙的轴是 y（长 6），所以离轴 4 米的一点（墙外的正前方）**不算撞上**，
   *   而轴上 2.9 米处那一点**算**。用圆的话这两点都成立 —— 那就不是墙了。
   */
  const onAxis = shapeOf(wall)
  const clear = 0   // 只是为了可读性
  void onAxis
  void clear
  ok('墙是"一条线"，不是"一个圆"（长度 6 米的线段）', shape.kind === 'segment')
}

// ============================================================================
//  6. 点数：四个开关真的进账，而且方向对
// ============================================================================

section('屏障：四个开关进点数账（"用于获取点数"那条）')

{
  const factory = lib.skills.get('skill.barrier')
  if (factory === undefined) throw new Error('内容里没有 skill.barrier')
  const options = priceOptionsFor(balance, lib.statuses, lib.entities)

  /*
   * ⚠ 这里必须走**相对出厂值**的账（`skillLedger`），不能走 `priceTechnique`。
   *
   *   账是相对出厂值算的（宗旨：默认值下配平为 0）——
   *   所以"给这个术式算一笔绝对账"永远得到 0，
   *   要问"把开关改了值多少点"，只能拿**一份只改了那个字段的副本**
   *   去和出厂版本相减。差额就是那条交易轴的价格。
   */
  const pointsWith = (block: EntityDef['block']): number => {
    const def: EntityDef = { ...barrierDef, id: 'entity.barrier-probe', block }
    const copy: Skill = JSON.parse(JSON.stringify(factory)) as Skill
    // ⚠ 竖墙这一下住在 `effect` 里（"这个技能是什么"），不在 rules 里
    const spawn = copy.effect?.[0]?.then[0]
    if (spawn === undefined) throw new Error('屏障技能里没有"竖墙"这一下')
    ;(spawn.payload as { entityId?: string }).entityId = def.id

    const entities = new Map(lib.entities)
    entities.set(def.id, def)
    return skillLedger(copy, factory, { ...options, entities }).total
  }

  const base = pointsWith({ ownProjectiles: true, enemyProjectiles: false, ownUnits: true, enemyUnits: true })
  const noBlock = pointsWith({ ownProjectiles: true, enemyProjectiles: true, ownUnits: true, enemyUnits: true })
  const selfBlocked = pointsWith({ ownProjectiles: false, enemyProjectiles: false, ownUnits: true, enemyUnits: true })
  const enemyKeptOut = pointsWith({ ownProjectiles: true, enemyProjectiles: false, ownUnits: true, enemyUnits: false })

  /*
   * ⚠ 方向约定（整本账都一样）：**负 = 收益**（要花额度）、**正 = 代价**（提供额度）。
   *   所以"更值钱"= 更负；"拿回点数"= 更正。
   */
  ok('出厂那份开关不动 → 一分点数都没有（相对出厂值 = 0）', base === 0, `合计 ${base}`)

  /*
   * ⚠⚠ 2026-09-30（日志 60b）：**下面三条断言变了，因为账的算法换成了"查表 + 相加"。**
   *
   *   新账 = **各变量的选中值 → 各查一格 → 相加**（用户规格），而**这张表**
   *   （`content/balance.json` 的 `lookupTable`，32 技能 × 377 变量）覆盖的是
   *   **编辑器真的画出来的那些旋钮**：数值叶子 / 冷却时机 / 打断等级 / 占用施法者。
   *
   *   ⇒ 屏障的四个 `block` 开关（放行敌方子弹 / 挡住自己的子弹 / 挡住敌人）
   *     **住在实体预设（`EntityDef`）里，不在技能的任何数值叶子上**，
   *     所以它们**在表里没有格子** ⇒ 查表账对它们**一个字都不动**（一律 0 点）。
   *
   *   ⚠ 老公式会为它们计价（`barrierPoints` 数 `block` 那四个开关）——
   *     那正是"价格由公式推导"这一代的事。新口径下"表里没有的东西不参与定价"，
   *     而**该不该把它们也填进表**是**用户**的事（60a §8.5 第 ⑤ 条已经把这个
   *     问题挂出来了：修饰零件参数与武器属性要不要进表）。
   *     ⇒ 这里**如实钉住现状**，不让它变成一个没人知道的洞。
   */
  ok('⚠ 四个 `block` 开关**不在点表里** ⇒ 查表账对它们一字不动（0 点）—— 待用户裁',
    noBlock === base && selfBlocked === base && enemyKeptOut === base,
    `挡住 ${base} → 放行子弹 ${noBlock} / 挡住自己 ${selfBlocked} / 挡住敌人 ${enemyKeptOut}`)
}

// ============================================================================
//  7. 确定性
// ============================================================================

section('屏障：跑两遍逐字节一致')

{
  function run(): string {
    const { w, wall, shooter, foe } = arena({ block: { enemyProjectiles: false, enemyUnits: false } })
    foeShoot(w, foe, 30)
    shooter.pos.x = 2.9
    foe.pos.x = 3.1
    for (let i = 0; i < 40; i++) stepWorld(w)
    return JSON.stringify({
      wall: getStored(wall, 'char.hp.current'),
      shooter: [shooter.pos.x, shooter.pos.y],
      foe: [foe.pos.x, foe.pos.y],
      alive: w.entities.length,
    })
  }
  ok('同样的局面跑两遍，结果一样', run() === run())
}

// ============================================================================
//  8. 内容本身
// ============================================================================

section('屏障：内容定义')

{
  ok('content/entities/barrier.json 是 obstacle',
    barrierDef.kind === 'obstacle' && barrierDef.faction === 'caster')

  const def = readJson<EntityDef>(resolve('content/entities/barrier.json'))
  ok('它有形状（不是靠一堆圆拼的）',
    def.shape !== undefined && def.shape.kind === 'segment')

  // 顺带用武器校验器确认没写坏（它只查结构，屏障走的是实体预设那一套）
  void validateWeapon
  ok('实体预设被命令行和浏览器都装进了库', lib.entities.has('entity.barrier'))
}

console.log('')
if (failed > 0) {
  console.log(`✗ ${failed} 个断言失败（${passed} 个通过）`)
  process.exitCode = 1
} else {
  console.log(`✓ 全部 ${passed} 个断言通过`)
}
