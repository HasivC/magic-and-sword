/**
 * 场景与装配的测试。
 *
 * 这一批测的是**内容怎么变成一局游戏** —— 在它进 schema 之前，
 * 这件事发生在 web/src/main.ts 的一段硬编码数组里，等于没法测。
 *
 * 重点不是"能不能跑"，而是三条承诺：
 *   1. 翻译是纯的、可测的，命令行和浏览器拿到的是**同一个结果**
 *   2. 内容写错时**报错清楚**，而不是白屏或者静默当成空技能
 *   3. 术式内联的状态定义真的被注册了
 *      —— 这是"浏览器里查不到、命令行里查得到"那类 bug 的入口
 */
import { readJson } from '../src/loader.ts'
import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadLibrary } from '../src/bridge.ts'
import { probeTechnique } from './probes.ts'
import { compileTechnique } from '../src/sim/compile.ts'
import { groupPlanOf } from '../src/sim/trigger.ts'
import { bloodPactCostOf, priceOptionsFor } from '../src/pricing.ts'
import { validateStatus } from '../src/validator/checks.ts'
import type { BalanceConfig } from '../src/validator/types.ts'
import type { EntityDef, Scenario, Skill, StatusDef, Technique, WeaponDef } from '../src/schema.ts'
import {
  applyScenario, fallbackScenario, lowerScenario,
} from '../src/scenario.ts'
import {
  DEFAULT_DT, MAX_ACTION_DEPTH, activate, advance, applyPhaseLocks, applyStatus, canAct, canActivate, createWorld,
  dealDamage, despawn, distance, executeAction, factionOf, findAlly, findHostile, getStored, hasStatusTag, isHostile,
  phaseLocksOf, pressSequence, registerEntityDef, registerStatusDef, registerTechnique, removeStatus,
  resolveAttribute, runTechniqueRules, setStored, setTechniqueActive, spawn, spawnProjectile, stepWorld, visibilityOf,
} from '../src/sim/index.ts'
import type { ActionContext, ProjectileSpec } from '../src/sim/index.ts'

// ---------------------------------------------------------------- 迷你框架

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

function eq(name: string, actual: unknown, expected: unknown): void {
  ok(name, Object.is(actual, expected), `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`)
}

function section(title: string): void {
  console.log(`\n${title}`)
}

// ---------------------------------------------------------------- 准备

const balance = readJson<BalanceConfig>(resolve('content/balance.json'))
const lib = loadLibrary(balance)

if (lib.problems.length > 0) {
  for (const p of lib.problems) console.log(`  ✗ 内容编译失败：${p.message}`)
  process.exitCode = 1
}

function load(name: string): Scenario {
  return readJson<Scenario>(resolve(`content/scenarios/${name}.json`))
}

/**
 * 按 id 查编译好的术式：**出厂内容优先，其次是测试自带的探针**。
 *
 * ⚠ 探针（`tests/probes.ts`）是 2026-09-21 加的：那二十多份
 *   "一个技能配一份同名术式"的出厂示范删掉了，而这一批测试测的是**引擎行为**
 *   （护盾吸收、冻结禁用、被动 onCast ……），和出厂有几份示范无关。
 *   所以用到的那几份在测试里现造。
 */
const lookup = (id: string) => lib.compiled.get(id) ?? probeTechnique(lib, id)

/** 状态库。命令行和浏览器都传它，测试也得传 —— 否则走的不是同一条路 */
const libraryStatuses: StatusDef[] = existsSync(resolve('content/statuses'))
  ? readdirSync(resolve('content/statuses'))
    .filter(f => f.endsWith('.json'))
    .map(f => readJson<StatusDef>(resolve('content/statuses', f)))
  : []

/** 实体预设。同上 —— 召唤技能靠它才找得到要造什么 */
const libraryEntities: EntityDef[] = existsSync(resolve('content/entities'))
  ? readdirSync(resolve('content/entities'))
    .filter(f => f.endsWith('.json'))
    .map(f => readJson<EntityDef>(resolve('content/entities', f)))
  : []

/**
 * 武器库。
 *
 * ⚠ 场景里的单位写的是**武器 id**（`weapon: 'weapon.iron-sword'`），
 *   装配时要拿它换成运行时那份拷贝。不传的话，
 *   "你"想要的铁剑会装配失败 → 空手开局，而且只有一条 problem 会说出来。
 */
const libraryWeapons: WeaponDef[] = existsSync(resolve('content/weapons'))
  ? readdirSync(resolve('content/weapons'))
    .filter(f => f.endsWith('.json'))
    .map(f => readJson<WeaponDef>(resolve('content/weapons', f)))
  : []

// ============================================================================

section('1. 内容里的场景真的能装进世界')

{
  const s = load('arena')
  const lowered = lowerScenario(s, lookup, [], [], libraryWeapons)

  eq('内容里的场景没有装配问题', lowered.problems.length, 0)
  ok('问题是空的（否则上面那条会打印出来）',
    lowered.problems.length === 0, lowered.problems.join(' / '))

  ok('找到了玩家单位', lowered.player !== undefined)
  eq('玩家就是「你」', lowered.player?.label, '你')
  eq('玩家是人在操作', lowered.player?.control, 'human')

  const others = lowered.entities.filter(e => e.control === 'ai')
  eq('另外三个是 AI', others.length, 3)

  /*
   * ⚠ 地上的武器**不是**一个"可控单位"。
   *   不给它单独一档 control 的话，它会因为"没有 ai"被推断成 'human'，
   *   于是场景里出现两个玩家 —— 而校验只允许一个。
   */
  const items = lowered.entities.filter(e => e.control === 'none')
  eq('地上那把剑没人驱动', items.length, 1)
  eq('它就是长剑', items[0]?.init.weapon?.id, 'weapon.longsword')

  const w = createWorld({ seed: lowered.seed })
  const roster = applyScenario(w, lowered)

  eq('世界里生成了五个实体（四个单位 + 地上那把剑）', w.entities.length, 5)
  ok('roster 里能按名字找到人', roster.get('你') !== undefined)

  const me = roster.get('你')
  ok('玩家满血开局', me !== undefined && getStored(me, 'char.hp.current') === 400)
  /*
   * ⚠ 玩家 2026-09-21 定的：开局只有**一格**术式（数字键 1 = 魔法飞弹）。
   *
   *   以前这儿塞了 10 个"一个技能一个术式"的出厂示范，名字和技能一模一样 ——
   *   看起来就是一条技能栏，而它其实一直是术式。现在其余 9 格空着，玩家自己拼。
   *
   * ⚠ 场景里这一格是**内部术式**（`content/internal-techniques/magic-bolt.json`，
   *   敌人的骷髅术士也在用它）。浏览器那边开局会把它**复制一份进玩家的术式库**
   *   （`web/src/main.ts` 的 seedStarter），这样「我做的」里有一份能改的起点；
   *   而装配层这一侧看到的仍然是内容里写的这一份。
   */
  eq('玩家的技能栏只装了 1 个术式（其余 9 格空着，等玩家自己拼）', me?.techniqueIds.length, 1)
  eq('  第一格是魔法飞弹那个术式', me?.techniqueIds[0], 'tech.magic-bolt')
  eq('玩家开局拿的是铁剑', me?.weapon?.id, 'weapon.iron-sword')
  ok('铁剑的属性跟着过来了（不是空表）',
    (me?.weapon?.attributes['weapon.damage'] ?? 0) === 0.8,
    JSON.stringify(me?.weapon?.attributes))
}

section('2. 常驻术式：挂上去的那一刻就生效')

{
  const s = load('arena')
  const lowered = lowerScenario(s, lookup)
  const w = createWorld({ seed: lowered.seed })
  const roster = applyScenario(w, lowered)
  const me = roster.get('你')

  /*
   * ⚠ 玩家 2026-09-21 定的：
   *   > 血契记账器不是被动，它是一种**特殊机制**，不在被动栏显示。
   *   > 前两个被动（名刀·司命 / 猎手直觉），它们应该只有在玩家创造术式、
   *   > 术式中有它们并且术式被挂载时才激活。
   *
   * 所以名刀司命**不再白送**：开局只有血契记账器（那是系统机制）。
   */
  ok('开局只挂了血契记账器（它不在被动栏，是系统机制）',
    me?.activeTechniques.length === 1
    && me.activeTechniques[0] === 'tech.blood-pact',
    JSON.stringify(me?.activeTechniques))
  ok('  名刀司命 / 猎手直觉没有再白送',
    me?.activeTechniques.includes('tech.named-blade') !== true
    && me?.activeTechniques.includes('tech.hunter-instinct') !== true)

  const freeHp = me === undefined
    ? 0
    : resolveAttribute(me, 'char.hp.max', { world: w, self: me })
  ok('没挂的时候生命上限就是场景里写的 400', freeHp === 400, `实际 ${freeHp}`)

  /*
   * ⚠ 这条是真正要测的东西（和"谁拥有它"无关，是**引擎行为**）。
   *
   *   auto 的被动没有"按下"这一刻，它的 onCast 规则在**挂上时**跑一次 ——
   *   名刀司命的"刀带着它，一直压着你"（生命上限代价）就是靠这条落地的。
   *   自己手写一个 push 到 activeTechniques 的版本会漏掉它，代价就白赚了。
   *
   * ⚠ 得先 `registerTechnique`：`applyScenario` 只装**场景里那些单位列出来的**
   *   术式，而名刀司命现在不在任何清单里了（开局不白送）。世界里没有它，
   *   `setTechniqueActive` 就查不到定义、那条 onCast 也就不会跑。
   *   （真游戏里 `restart()` 会把整个内容库都注册进去，所以那边没这个问题。）
   */
  if (me !== undefined) mount(w, me, 'tech.named-blade')
  const maxHp = me === undefined
    ? 0
    : resolveAttribute(me, 'char.hp.max', { world: w, self: me })
  ok('挂上名刀司命之后，它的 onCast 代价落地了（生命上限被压低）',
    maxHp !== 400 && maxHp > 0, `生命上限是 ${maxHp}，场景里写的 400`)
}

section('3. 单位名重复要报出来')

{
  const dup: Scenario = {
    schemaVersion: 1,
    id: 'scenario.test-dup',
    name: '重名测试',
    entities: [
      { label: '同名', faction: 'player', pos: { x: 0, y: 0 }, techniques: ['tech.cleave'] },
      { label: '同名', faction: 'enemy', pos: { x: 3, y: 0 }, techniques: ['tech.cleave'] },
    ],
  }
  const lowered = lowerScenario(dup, lookup)
  ok('重名被报出来', lowered.problems.some(p => p.includes('单位名重复')),
    lowered.problems.join(' / '))
  ok('而且顺带报出了"两个人"', lowered.problems.some(p => p.includes('一个键盘')),
    lowered.problems.join(' / '))
  ok('重名不影响装配 —— 两个都生成了', lowered.entities.length === 2)
}

section('4. 引用不存在的术式：报错清楚，不抛异常')

{
  const bad: Scenario = {
    schemaVersion: 1,
    id: 'scenario.test-bad',
    name: '坏引用',
    entities: [
      {
        label: '你',
        faction: 'player',
        pos: { x: 0, y: 0 },
        techniques: ['tech.cleave', 'tech.does-not-exist'],
      },
    ],
  }

  let threw = false
  let lowered
  try {
    lowered = lowerScenario(bad, lookup)
  } catch {
    threw = true
  }

  ok('不抛异常（一个单位配错不该让整局打不开）', !threw)
  ok('报出了哪个单位、缺哪个 id',
    lowered !== undefined
    && lowered.problems.some(p => p.includes('你') && p.includes('tech.does-not-exist')),
    lowered?.problems.join(' / '))
  eq('能装的那个照样装上了', lowered?.entities[0]?.install.length, 1)
}

section('5. controlledBy 的推断')

{
  // 有 ai = AI；没 ai 也没写 controlledBy = 人
  const s: Scenario = {
    schemaVersion: 1,
    id: 'scenario.test-infer',
    name: '推断',
    entities: [
      { label: '有AI', faction: 'enemy', pos: { x: 0, y: 0 }, ai: { targetFaction: 'enemyOfSelf' } },
      { label: '没AI', faction: 'player', pos: { x: 1, y: 0 } },
      {
        label: '木桩',
        faction: 'neutral',
        pos: { x: 2, y: 0 },
        controlledBy: 'ai',
      },
    ],
  }
  const lowered = lowerScenario(s, lookup)

  const byLabel = new Map(lowered.entities.map(e => [e.label, e]))
  eq('写了 ai 的是 AI', byLabel.get('有AI')?.control, 'ai')
  eq('什么都没写的是人', byLabel.get('没AI')?.control, 'human')
  eq('显式写了 ai 的木桩是 AI', byLabel.get('木桩')?.control, 'ai')
  eq('所以玩家是「没AI」', lowered.player?.label, '没AI')
}

section('6. 一个键盘只能驱动一个人')

{
  const s: Scenario = {
    schemaVersion: 1,
    id: 'scenario.test-two-humans',
    name: '两个人',
    entities: [
      { label: '甲', faction: 'player', pos: { x: 0, y: 0 }, controlledBy: 'human' },
      { label: '乙', faction: 'player', pos: { x: 1, y: 0 }, controlledBy: 'human' },
    ],
  }
  const lowered = lowerScenario(s, lookup)
  ok('两个 human 被报出来', lowered.problems.some(p => p.includes('一个键盘只能驱动一个')),
    lowered.problems.join(' / '))
}

section('7. 纯 AI 场景是合法的（观战）')

{
  const lowered = lowerScenario(load('duel'), lookup)
  eq('duel 没有装配问题', lowered.problems.length, 0)
  eq('duel 没有玩家单位', lowered.player, undefined)
  eq('两边都是 AI', lowered.entities.filter(e => e.control === 'ai').length, 2)
}

section('8. 术式内联的状态定义被注册进世界')

{
  /*
   * ⚠ 这是"浏览器里查不到、命令行里查得到"那类 bug 的守门测试。
   *
   *   web/src/main.ts 以前只调 registerTechnique（= world.techniques.set），
   *   不注册状态定义；bridge.ts 的 installTechnique 两样都做。
   *   结果：技能里按 statusId 引用的状态，命令行跑得好好的，
   *   浏览器里 resolveStatusDef 返回 undefined → 运行期 throw。
   *
   *   现在装配统一走 applyScenario，两边一样。这个测试从**内容**这一侧锁住它。
   */
  const lowered = lowerScenario(load('arena'), lookup, libraryStatuses, libraryEntities, libraryWeapons)
  const w = createWorld({ seed: 1 })
  applyScenario(w, lowered)

  // 内容里内联定义的状态都该在 world.statusDefs 里
  let inlineCount = 0
  for (const e of lowered.entities) {
    for (const { status } of e.statuses) {
      if (status.id === undefined) continue
      inlineCount++
      ok(`内联状态已注册：${status.id}`, w.statusDefs.get(status.id) !== undefined)
    }
  }
  ok('内容里确实有内联状态（否则这个测试没测到东西）', inlineCount > 0, `数到 ${inlineCount} 个`)
}

section('9. 兜底场景必须真的能玩')

{
  const fb = fallbackScenario()
  const lowered = lowerScenario(fb, lookup)

  eq('兜底场景自身没有装配问题', lowered.problems.length, 0)
  ok('兜底场景有玩家', lowered.player !== undefined)

  const w = createWorld({ seed: 1 })
  const roster = applyScenario(w, lowered)
  eq('兜底场景生成了两个单位', w.entities.length, 2)

  const me = roster.get('你')
  ok('兜底玩家有技能', (me?.techniqueIds.length ?? 0) > 0)

  // 真的能跑：不出异常，时间在走
  for (let i = 0; i < 120; i++) stepWorld(w)
  eq('跑了两秒之后 tick 是 120', w.tick, 120)
}

section('10. 同一份场景翻译两次结果一样（可重放的前提）')

{
  const a = lowerScenario(load('arena'), lookup, [], [], libraryWeapons)
  const b = lowerScenario(load('arena'), lookup, [], [], libraryWeapons)

  eq('种子一样', a.seed, b.seed)
  eq('单位数一样', a.entities.length, b.entities.length)
  eq('玩家一样', a.player?.label, b.player?.label)

  // 世界逐 tick 一致 —— 这是 core-sim 的核心承诺
  const w1 = createWorld({ seed: a.seed })
  const w2 = createWorld({ seed: b.seed })
  applyScenario(w1, a)
  applyScenario(w2, b)

  for (let i = 0; i < 300; i++) {
    stepWorld(w1)
    stepWorld(w2)
  }

  const hp1 = w1.entities.map(e => getStored(e, 'char.hp.current'))
  const hp2 = w2.entities.map(e => getStored(e, 'char.hp.current'))
  eq('五秒之后双方血量逐个一致', JSON.stringify(hp1), JSON.stringify(hp2))
}

section('11. 存储属性可以直接给（开局残血这种）')
{
  const s: Scenario = {
    schemaVersion: 1,
    id: 'scenario.test-stored',
    name: '残血开局',
    entities: [
      {
        label: '二阶段',
        faction: 'enemy',
        pos: { x: 0, y: 0 },
        controlledBy: 'ai',
        attributes: { 'char.hp.max': 1000 },
        stored: { 'char.hp.current': 300 },
      },
    ],
  }
  const lowered = lowerScenario(s, lookup)
  const w = createWorld({ seed: 1 })
  const roster = applyScenario(w, lowered)

  eq('开局血量是写死的 300，不是满血 1000',
    getStored(roster.get('二阶段')!, 'char.hp.current'), 300)
}

// ============================================================================
//  12~15：新内容是不是**真的在引擎里干活**
// ============================================================================
//
// ⚠ 这一组是整个"补充内容"里最重要的一段。
//
//   护盾（absorb）、霸体（immuneTags）、冻结（disables）在引擎、定价、
//   校验器里都写好了，但**一个技能都没用过**。零内容 = 零验证：
//   一个从没被跑过的机制，和没实现是一回事。
//
//   所以每加一个这样的技能，就得在这里留一条"它真的生效了"的断言。

/** 把演武场装好，返回世界里的人和几个便捷查询 */
function arenaWorld(): {
  w: ReturnType<typeof createWorld>
  roster: Map<string, ReturnType<typeof createWorld>['entities'][number]>
} {
  const lowered = lowerScenario(load('arena'), lookup, libraryStatuses, libraryEntities, libraryWeapons)
  const w = createWorld({ seed: lowered.seed })
  return { w, roster: applyScenario(w, lowered) }
}

/**
 * 直接跑一个术式的某条规则 —— 不用真的按键施法，省得被阶段时长和冷却绕进去。
 *
 * ⚠ `phase` 要写**编译后**的 id，也就是带 `skillId#` 前缀的那个。
 *   编译器给每个技能的阶段 id 加前缀是为了让两个技能里同名的阶段不撞车
 *   （见 compile.ts 的"命名空间"一节）。写裸 `weave` 匹配不上，
 *   而失败方式是**静默的**：规则不触发，看起来像技能没效果。
 *   这个坑刚踩过。
 */
/**
 * 把一个常驻术式**挂到人身上**（测试用）。
 *
 * ⚠ 两步缺一不可，而且第一步是 2026-09-21 才需要的：
 *   `applyScenario` 只注册"场景里那些单位列出来的"术式，而演武场开局
 *   只给玩家**一格**术式（名刀·司命 / 猎手直觉不再白送）——
 *   世界里没有那个术式，`setTechniqueActive` 就查不到定义，它的 onCast 不会跑。
 *   真游戏里 `restart()` 会把整个内容库都注册进去，所以那边没这个问题。
 */
function mount(
  w: ReturnType<typeof createWorld>,
  e: ReturnType<typeof createWorld>['entities'][number],
  techniqueId: string,
): void {
  const tech = w.techniques.get(techniqueId) ?? lookup(techniqueId)
  if (tech === undefined) throw new Error(`内容库里没有术式 ${techniqueId}`)
  registerTechnique(w, tech)
  setTechniqueActive(w, e, techniqueId, true)
}

/**
 * 从头数一遍**这一局到目前为止**触发了几次修饰技能。
 *
 * ⚠ 为什么要它（而不是 `w.events.some(...)`）：
 *   `stepWorld` 每 tick 开头会把 `world.events` **清空**（见 world.ts 第 0 步），
 *   所以事件数组只看得见**这一 tick** —— "第 21 节里那个 `modifierTriggered`
 *   还在不在"在推进世界之后就再也查不到了。
 *
 * ⚠ 而且"触发了几次"本身就是这一节要钉的东西：只判"有没有触发过"的话，
 *   把 `crossing` 边沿检测删掉、让它在残血期间每 tick 都触发一次，
 *   断言**照样全绿**（盾会一直被刷新，数量看起来也一样）。
 *
 * ⚠ **它必须在推进世界的同时累加**（`advance()` 就是干这个的），
 *   不能等推进完了再去数事件数组 —— 那样只会数到**最后那一 tick**。
 */
function countTriggers(w: ReturnType<typeof createWorld>): number {
  let n = 0
  for (const ev of w.events) {
    if (ev.type === 'modifierTriggered') n++
  }
  return n
}

/**
 * 推进 `n` 个 tick，并**累计**这一路上发生的两件事。
 *
 * ⚠ 返回的是**这一趟里**的数量（调用方自己累加）—— 写成"就地写进一个
 *   全局计数器"的话，两节测试之间会互相污染，而那是**静默**的。
 */
function advanceCounting(
  w: ReturnType<typeof createWorld>,
  ticks: number,
): { triggers: number; shieldApplied: number; entityId: number } {
  let triggers = 0
  let shieldApplied = 0
  const entityId = w.entities.find(e => e.faction === 'player')?.id ?? -1
  for (let i = 0; i < ticks; i++) {
    stepWorld(w)
    triggers += countTriggers(w)
    for (const ev of w.events) {
      if (ev.type === 'statusApplied' && ev.statusId === 'status.lastStand') shieldApplied++
    }
  }
  return { triggers, shieldApplied, entityId }
}

function fireRule(  w: ReturnType<typeof createWorld>,
  caster: ReturnType<typeof createWorld>['entities'][number],
  techniqueId: string,
  when: Parameters<typeof runTechniqueRules>[3],
  phaseSkill?: string,
  phaseName?: string,
  target?: ReturnType<typeof createWorld>['entities'][number],
): void {
  /*
   * ⚠ 世界里没有就**从内容库里当场注册**。
   *
   *   `applyScenario` 只注册"场景里那些单位列出来的"术式，而 2026-09-21 起
   *   演武场开局只给**一格**术式（玩家自己拼其余的）—— 于是这个辅助函数
   *   要用的那十几个术式都不在 `world.techniques` 里了。
   *   让它自己去库里取，测试就不再依赖"场景恰好装了哪些术式"。
   */
  let tech = w.techniques.get(techniqueId)
  if (tech === undefined) {
    const fromLib = lookup(techniqueId)
    if (fromLib !== undefined) {
      registerTechnique(w, fromLib)
      tech = fromLib
    }
  }
  if (tech === undefined) throw new Error(`世界里没有术式 ${techniqueId}`)

  const opts: Parameters<typeof runTechniqueRules>[4] = {}
  if (phaseSkill !== undefined && phaseName !== undefined) {
    opts.phaseId = `${phaseSkill}#${phaseName}`
  }
  if (target !== undefined) opts.target = target

  runTechniqueRules(w, tech, caster, when, opts)
}

section('12. 护盾真的在吸收伤害（absorb）')

{
  const { w, roster } = arenaWorld()
  const me = roster.get('你')!
  const foe = roster.get('剑奴')!

  // 给自己套盾（阶段名是 weave，规则挂 phaseComplete）
  fireRule(w, me, 'tech.aegis', 'phaseComplete', 'skill.aegis', 'weave')

  const shield = me.statuses.find(s => s.defId === 'status.shield')
  ok('护盾挂上了', shield !== undefined)
  ok('池子里有 150 点', (shield?.vars?.['pool'] ?? 0) === 150,
    `池子 = ${String(shield?.vars?.['pool'])}`)

  const hpBefore = getStored(me, 'char.hp.current')

  // 打 60 点进去：应该全被盾吃掉
  dealDamage(w, foe.id, me.id, 60)
  eq('60 点伤害被盾全吃了，血没动',
    getStored(me, 'char.hp.current'), hpBefore)

  const left = me.statuses.find(s => s.defId === 'status.shield')?.vars?.['pool']
  eq('池子剩 90', left, 90)

  // 再打 200：盾破，多出来的 110 打在血上
  dealDamage(w, foe.id, me.id, 200)
  ok('盾碎了', me.statuses.every(s => s.defId !== 'status.shield'))
  eq('溢出伤害打在血上', getStored(me, 'char.hp.current'), hpBefore - 110)
}

section('13. 冻结真的禁用了能力（disables）')

{
  const { w, roster } = arenaWorld()
  const me = roster.get('你')!
  const foe = roster.get('剑奴')!

  fireRule(w, foe, 'tech.frost-lock', 'onHit', undefined, undefined, me)

  const frozen = me.statuses.find(s => s.defId === 'status.frozen')
  ok('冻结挂上了', frozen !== undefined)
  eq('四种能力全禁', JSON.stringify(frozen?.disables ?? []),
    JSON.stringify(['move', 'attack', 'cast', 'turn']))

  // canAct 是引擎里唯一的"能不能动"的判据 —— 它认了才算真冻住
  ok('走不了', !canAct(me, 'move'))
  ok('打不了', !canAct(me, 'attack'))
  ok('放不了技能', !canAct(me, 'cast'))
}

section('14. 霸体真的挡住了冻结（immuneTags）')

{
  const { w, roster } = arenaWorld()
  const me = roster.get('你')!
  const foe = roster.get('剑奴')!

  // 先开铁布衫
  fireRule(w, me, 'tech.iron-shirt', 'phaseComplete', 'skill.iron-shirt', 'gather')
  ok('铁布衫挂上了', me.statuses.some(s => s.defId === 'status.iron-shirt'))

  // 再拿冰冻它
  fireRule(w, foe, 'tech.frost-lock', 'onHit', undefined, undefined, me)

  ok('冻结被免疫了，身上没有 status.frozen',
    me.statuses.every(s => s.defId !== 'status.frozen'))
  ok('免疫事件发出去了（界面上要能看见）',
    w.events.some(e => e.type === 'statusImmune'))
  ok('还动得了', canAct(me, 'move'))
}

section('15. 裂魂终于能驱散护盾了（那条死了很久的规则）')

{
  /*
   * ⚠ 这条规则以前**一定**会抛异常，而且坏了三层（见日志）：
   *   1. status.shield 这个名字哪儿都不存在（只在一个测试文件里）
   *   2. 条件写的是 hasTag（查实体自身的标签），而护盾是**状态**的标签
   *   3. hasStatusTag() 实现了，但没有任何条件类型能调到它
   *
   *   现在灵光盾把 status.shield 内联定义出来了，r2 也改用 hasStatusTag。
   *
   * 施法者是石像鬼（Boss）—— 裂魂的 targeting.valid 里有 boss 标签，
   * 所以它只能由带 boss 标签的单位放出来。
   */
  const { w, roster } = arenaWorld()
  const me = roster.get('你')!
  const boss = roster.get('石像鬼')!

  // 两边都套上盾：玩家有盾，Boss 也有盾
  fireRule(w, me, 'tech.aegis', 'phaseComplete', 'skill.aegis', 'weave')
  fireRule(w, boss, 'tech.aegis', 'phaseComplete', 'skill.aegis', 'weave')

  ok('玩家身上有 status.shield', me.statuses.some(s => s.defId === 'status.shield'))
  ok('Boss 也有盾了', boss.statuses.some(s => s.defId === 'status.shield'))

  let threw: unknown
  try {
    // Boss 一发裂魂打过来
    fireRule(w, boss, 'tech.soul-rend', 'onHit', undefined, undefined, me)
  } catch (e) {
    threw = e
  }

  ok('驱散不再抛异常', threw === undefined, String(threw))
  ok('玩家的护盾被驱散了',
    me.statuses.every(s => s.defId !== 'status.shield'),
    '玩家身上还剩：' + me.statuses.map(s => s.defId).join(', '))
  ok('裂魂还会留下一道无法驱散的创伤',
    me.statuses.some(s => s.defId === 'status.soul-rend'))
}

// ============================================================================
//  16~20：第二轮补的机制 —— 位移 / 暴击 / 亡灵反转 / 背水
// ============================================================================

section('16. 场景确实给玩家配了暴击（否则 onCrit 永远不触发）')

{
  const lowered = lowerScenario(load('arena'), lookup, libraryStatuses, libraryEntities, libraryWeapons)
  const me = lowered.entities.find(e => e.label === '你')
  const rate = me?.init.base?.['char.critRate'] ?? 0
  ok('玩家的 critRate 来自场景，而且大于 0', rate > 0, `critRate = ${rate}`)
  ok('暴击倍率也配了', (me?.init.base?.['char.critDamage'] ?? 0) > 1)
}

section('17. 位移载荷真的把人和自己挪动了')

{
  const { w, roster } = arenaWorld()
  const me = roster.get('你')!
  const foe = roster.get('剑奴')!

  /*
   * ⚠ 两个坑，都会让这个测试**假绿或假红**：
   *
   *   1. 必须**显式传目标**。`runTechniqueRules` 不传 target 时用的是
   *      术式锁定的目标，这里没有 cast 就没有锁定目标 ——
   *      于是动作落到施法者自己头上，击退方向算出来是零向量。
   *      （表现是"什么都没发生"，而不是报错。）
   *
   *   2. 必须**关掉敌人的 AI**。它会主动往玩家身上贴，
   *      4 秒的推进足够它跑完全程 —— 于是量到的是 AI 的走位，不是击退。
   */
  delete foe.ai

  const before = distance(me.pos, foe.pos)

  // 破军突刺：规则 1 是伤害，规则 2 是击退
  fireRule(w, me, 'tech.armor-pierce', 'phaseComplete', 'skill.armor-pierce', 'thrust', foe)
  ok('发了 displaced 事件', w.events.some(e => e.type === 'displaced'))

  advance(w, 240)
  const after = distance(me.pos, foe.pos)
  ok('目标被推远了（2 米 ± 一点）', after - before > 1.5,
    `原来 ${before.toFixed(2)} 米，现在 ${after.toFixed(2)} 米`)
}

section('18. 冲刺动的是自己')

{
  const { w, roster } = arenaWorld()
  const me = roster.get('你')!
  me.facing = { x: 1, y: 0 }
  const x0 = me.pos.x

  // 破军突刺：规则 3 是 onMiss 时的冲刺
  fireRule(w, me, 'tech.armor-pierce', 'onMiss')
  advance(w, 240)

  ok('施法者自己前冲了（2 米 ± 一点）', me.pos.x - x0 > 1.5,
    `前进 ${(me.pos.x - x0).toFixed(2)} 米`)
}

section('19. 亡灵诅咒：治疗反过来伤自己（hitKindIs）')

{
  const { w, roster } = arenaWorld()
  const me = roster.get('你')!
  const caster = roster.get('骷髅术士')!

  // 先把血打掉一截，好看出治疗的方向
  setStored(me, 'char.hp.current', 200)

  // 术士下咒 —— 目标是玩家
  fireRule(w, caster, 'tech.curse-of-undead', 'phaseComplete', 'skill.curse-of-undead', 'chant', me)
  ok('诅咒挂上了', me.statuses.some(s => s.defId === 'status.curseOfUndead'))

  // 自己治疗自己 —— 应该变成伤害
  fireRule(w, me, 'tech.holy-light', 'phaseComplete', 'skill.holy-light', 'pray')
  const hp = getStored(me, 'char.hp.current')
  ok('被诅咒时治疗变成了伤害（血变少而不是变多）', hp < 200, `血量 ${hp}（下咒前 200）`)
}

section('20. 诅咒消失后治疗恢复正常')

{
  const { w, roster } = arenaWorld()
  const me = roster.get('你')!
  setStored(me, 'char.hp.current', 200)

  // 不下咒，直接治疗
  fireRule(w, me, 'tech.holy-light', 'phaseComplete', 'skill.holy-light', 'pray')
  const hp = getStored(me, 'char.hp.current')
  ok('没被诅咒时治疗就是治疗（回 30 点）', hp > 200, `血量 ${hp}（治疗前 200）`)
}

section('21. 背水：血量跨过 30% 的那一瞬间给盾')

{
  const { w, roster } = arenaWorld()
  const me = roster.get('你')!

  /*
   * ⚠ ---- **2026-09-21（日志 48）这一节换了挂的东西，语义一个字没变** ----
   *
   *   拆解前：`mount(w, me, 'tech.last-stand')` —— 那是一份**探针**
   *     （`activation: 'toggle'` 的常驻术式，里面只有一个 `skill.last-stand`，
   *      而那个技能自己带一条 `onLowHp` 规则）。
   *   拆解后：挂的是**内容里那一门真实的常驻术式**
   *     （`content/internal-techniques/last-stand.json`，`activation: auto`），
   *     它里面是"监测器修饰副本 + 撑盾技能"。
   *
   *   ⇒ 三条要钉的东西**一条都没松**：
   *     · 跨过 30% 低血线 → 发出 `lowHp` 事件（`fireLowHp`，引擎级）
   *     · 盾挂上了（现在由**触发器**去 `activate` 那个撑盾技能）
   *     · 已经低血时再挨打**不重复触发**（还是"跨过"不是"低于"）
   */
  mount(w, me, 'tech.last-stand')

  const max = resolveAttribute(me, 'char.hp.max', { world: w, self: me })
  // 打到刚好在低血线之上
  setStored(me, 'char.hp.current', Math.ceil(max * 0.35))

  const foe = roster.get('剑奴')!
  dealDamage(w, foe.id, me.id, Math.ceil(max * 0.1))   // 掉到 25%，跨过去了

  ok('跨过低血线时发了 lowHp 事件', w.events.some(e => e.type === 'lowHp'))
  /*
   * ⚠ 盾不是**当场**挂上的：撑盾技能有 0.5 秒前摇，要**推进世界**才跑得完
   *   （旧的被动版是反应式的，规则一跑盾就有了）。这不是行为改变 ——
   *   玩家的观感是"盾晚半秒出现"，而那半秒本来就是那个技能的施法时间。
   */
  ok('监测器触发了它后面那个技能（撑盾）',
    w.events.some(e => e.type === 'modifierTriggered'))
  /*
   * ⚠ ---- **整节只准触发一次**（日志 48 拆解时补的哨兵）----
   *
   *   这一节跑在一个**会还手的演武场**里（剑奴会砍、骷髅术士会下咒），
   *   所以"盾消失了"有很多种可能的原因 —— 打空、时长到了、被驱散。
   *   只盯"盾还在不在"的话，测出来的可能是**别的东西**（第一版就是这么
   *   栽的：盾被砍空之后 `after` 变成 0，而那条断言看起来像"多触发了"）。
   *
   *   ⇒ 真正属于这一节的那个事实是"**跨过危险线只触发一次**"，
   *     而它有一个**与世界无关**的读数：`modifierTriggered` 的次数。
   *     ⚠ 必须在推进世界的同时**累加**（`advanceCounting`）——
   *       事件数组每 tick 都被清空，推完了再数只会数到最后那一 tick（也栽过）。
   */
  /*
   * ⚠ 先数一遍**此刻**事件里的触发（跨线那一下刚刚发生，就在这个数组里）——
   *   再推进世界的话，第一次 `stepWorld` 会把它清掉，那个数就永远数不到了。
   */
  const triggersAtCrossing = countTriggers(w)
  const first = advanceCounting(w, 60)
  const triggersTotal = triggersAtCrossing + first.triggers
  ok('  跨过危险线只触发了一次', triggersTotal === 1, String(triggersTotal))
  ok('拿到了背水盾', first.shieldApplied > 0, String(first.shieldApplied))

  /*
   * ⚠ 关键：再挨一下**不该**再给一个盾。
   *
   *   ⚠ 拆解之后"不重复"有两道保险，而且**两道都必须成立**：
   *     1. `fireLowHp` 的"跨过"判据（引擎级，和拆解前同一个函数）；
   *     2. 触发器自己的 `crossing` 边沿检测（`mod-state.ts` 的 `fired`）。
   *   只钉结果的话，删掉任意一道都还是绿的 —— 所以这里连**触发次数**
   *   也一起数（它只可能是 1）。
   */
  const before = me.statuses.filter(s => s.defId === 'status.lastStand').length
  dealDamage(w, foe.id, me.id, 5)
  const second = advanceCounting(w, 60)
  const after = me.statuses.filter(s => s.defId === 'status.lastStand').length
  /*
   * ⚠ 这一条比的是"**没有再多出一个盾**"（`after <= before`），不是相等。
   *
   *   ⚠ 为什么不是 `after === before`（第一版就是这么写的，当场栽了）：
   *     这一节跑在**会还手的演武场**里，而且拆解之后盾是**真的会被打空**的
   *     （吸收了 100 点就碎，`pipeline.ts` 的 `runAbsorb` 里那句
   *     `pool <= 0 ⇒ shieldBroken`）。所以 `after` 比 `before` **小**
   *     是完全正常的事 —— 那说明盾被打碎了，不说明"多触发了一次"。
   *     相等只在"这 60 tick 里没人碰它"时才成立，而那**不是这一节要钉的东西**。
   */
  ok('已经低血时再挨打不会**多出一个**盾（是"跨过"不是"低于"）', after <= before,
    `${before} → ${after}`)
  eq('触发器一次都没再响（crossing 边沿检测）', second.triggers, 0)
  eq('  推完第二趟之后，整节加一起也还是那一次',
    triggersAtCrossing + first.triggers + second.triggers, 1)
  eq('  第二个盾也没被挂上（只看事件，不看它还在不在）', second.shieldApplied, 0)
}

section('22. 猎手直觉：暴击回血（onCrit）')

{
  const { w, roster } = arenaWorld()
  const me = roster.get('你')!
  const foe = roster.get('剑奴')!

  mount(w, me, 'tech.hunter-instinct')

  // 生命上限被那条负重压过（0.9），所以先看当前上限
  const max = resolveAttribute(me, 'char.hp.max', { world: w, self: me })
  setStored(me, 'char.hp.current', max - 50)

  // 必暴
  me.base.set('char.critRate', 1)
  const before = getStored(me, 'char.hp.current')
  dealDamage(w, me.id, foe.id, 10)

  ok('暴击时回了 10 点血（onCrit 生效）',
    getStored(me, 'char.hp.current') > before,
    `${before} → ${getStored(me, 'char.hp.current')}`)
}

section('23. 潜行让敌人真的找不到你（visibility 第一次被消费）')

{
  const { w, roster } = arenaWorld()
  const me = roster.get('你')!
  const foe = roster.get('剑奴')!

  // 先确认敌人是能看见你的
  ok('开局敌人锁定得到你', findHostile(w, foe)?.id === me.id)

  fireRule(w, me, 'tech.stealth', 'phaseComplete', 'skill.stealth', 'vanish')

  eq('不可见了', visibilityOf(me), 0)
  ok('敌人锁定不到你了', findHostile(w, foe)?.id !== me.id,
    `它锁定的是 #${String(findHostile(w, foe)?.id)}`)

  // ⚠ 隐形躲的是"锁定"，不是"判定" —— 范围技能照样打得中
  ok('但 ignoreVisibility 还能找到（范围技能照样打得中）',
    findHostile(w, foe, { ignoreVisibility: true })?.id === me.id)
}

section('24. 洞察把藏起来的人揪出来，并打上标记')

{
  const { w, roster } = arenaWorld()
  const me = roster.get('你')!
  const foe = roster.get('剑奴')!

  // 敌人先藏起来
  fireRule(w, foe, 'tech.stealth', 'phaseComplete', 'skill.stealth', 'vanish')
  eq('敌人藏好了', visibilityOf(foe), 0)
  ok('你锁定不到他了', findHostile(w, me)?.id !== foe.id)

  // 你放洞察 —— 注意它打的是**敌人**，所以目标要显式传
  fireRule(w, me, 'tech.insight', 'phaseComplete', 'skill.insight', 'scan', foe)

  eq('敌人的隐形被扒掉了', visibilityOf(foe), 1)
  ok('又能锁定他了', findHostile(w, me)?.id === foe.id)
  ok('身上带了标记', foe.statuses.some(s => s.defId === 'status.perception.marked'))
  ok('标记的标签是 marked（猎杀靠它认人）', hasStatusTag(foe, 'marked'))
}

section('25. 猎杀对带标记的目标打得更痛（hasStatusTag 被消费）')

{
  const { w, roster } = arenaWorld()
  const me = roster.get('你')!
  const foe = roster.get('剑奴')!

  const max = resolveAttribute(foe, 'char.hp.max', { world: w, self: foe })
  setStored(foe, 'char.hp.current', max)

  /*
   * ⚠ 先把暴击关掉。
   *
   * 场景给玩家配了 15% 暴击率，所以这一箭**有时**是 25、有时是 50 ——
   * 直接比大小会变成一条偶尔红的测试（第一次跑就红了，差额 50）。
   * 赌运气的断言不是断言。
   */
  me.base.set('char.critRate', 0)

  // 没标记：r2 的条件不成立，一点伤害都不该有
  fireRule(w, me, 'tech.hunt', 'onHit', undefined, undefined, foe)
  const noMark = max - getStored(foe, 'char.hp.current')
  eq('没标记时那条额外伤害不触发', noMark, 0)

  // 打上标记再来一次
  setStored(foe, 'char.hp.current', max)
  fireRule(w, me, 'tech.insight', 'phaseComplete', 'skill.insight', 'scan', foe)
  fireRule(w, me, 'tech.hunt', 'onHit', undefined, undefined, foe)
  const marked = max - getStored(foe, 'char.hp.current')

  eq('带标记时正好多挨 25 点', marked, 25)
}

section('26. 召唤：造出来的东西替**召唤者**打仗（faction: caster）')

{
  const { w, roster } = arenaWorld()
  const me = roster.get('你')!
  const foe = roster.get('剑奴')!

  const before = w.entities.length

  fireRule(w, me, 'tech.raise-dead', 'phaseComplete', 'skill.raise-dead', 'ritual')

  eq('世界里多了一个实体', w.entities.length, before + 1)

  const minion = w.entities[w.entities.length - 1]!
  eq('它是按预设造出来的', minion.defId, 'entity.skeleton')
  eq('阵营跟召唤者一致（不是写死的）', minion.faction, me.faction)
  eq('记着主人是谁', minion.ownerId, me.id)
  eq('血量来自预设', getStored(minion, 'char.hp.current'), 60)
  ok('会放预设里写的术式', minion.techniqueIds.includes('tech.cleave'))
  ok('有 AI（预设里配了）', minion.ai !== undefined)
  ok('发了 summoned 事件', w.events.some(e => e.type === 'summoned'))

  // ⚠ 关键：它得**真的帮玩家打**，而不是站着或者帮倒忙
  ok('它把剑奴当敌人（findHostile 按阵营动态查）',
    findHostile(w, minion)?.id === foe.id,
    `它锁定的是 #${String(findHostile(w, minion)?.id)}`)
}

section('27. 敌人召唤的东西帮敌人打（同一份预设）')

{
  const { w, roster } = arenaWorld()
  const foe = roster.get('剑奴')!
  const me = roster.get('你')!

  /*
   * ⚠ 这一条盯的是 `faction: 'caster'` 的解析。
   *
   *   如果预设里写死了 'player'，敌人召出来的骷髅会帮玩家打 ——
   *   那等于给敌人配了一个内鬼。反向写死 'enemy' 也一样糟。
   *
   *   两个方向都测，才算真的验证了"按阵营动态解析"。
   */
  fireRule(w, foe, 'tech.raise-dead', 'phaseComplete', 'skill.raise-dead', 'ritual')

  const minion = w.entities[w.entities.length - 1]!
  eq('召唤者是敌人，所以召唤物也是敌人', minion.faction, foe.faction)
  ok('它把玩家当敌人', findHostile(w, minion)?.id === me.id,
    `它锁定的是 #${String(findHostile(w, minion)?.id)}`)
}

section('28. 主人死了召唤物跟着消失（untilCasterDies）')

{
  const { w, roster } = arenaWorld()
  const me = roster.get('你')!

  fireRule(w, me, 'tech.raise-dead', 'phaseComplete', 'skill.raise-dead', 'ritual')
  const minion = w.entities[w.entities.length - 1]!
  ok('先确认它活着', minion.alive)
  ok('而且它不按时间到期（lifetime 是 -1）', minion.lifetime < 0)
  eq('挂了「跟主人同生共死」的标记', minion.diesWithOwner, true)

  // 主人倒下
  setStored(me, 'char.hp.current', 0)
  me.alive = false
  /*
   * ⚠ 只推进 **1 tick**。
   *
   * `world.events` 每 tick 开头清空（"本 tick 产生的事件"）。
   * 推进 2 tick 的话，第 1 tick 发的 removed 事件已经被清掉了 ——
   * 而召唤物确实已经消失，于是断言失败得很莫名其妙。
   */
  advance(w, 1)

  ok('主人一死，召唤物也跟着没了', !minion.alive)
  ok('发了 removed 事件', w.events.some(e => e.type === 'removed' && e.id === minion.id))
}

section('29. 召唤物摆在主人周围，不是一个点上')

{
  const { w, roster } = arenaWorld()
  const me = roster.get('你')!

  fireRule(w, me, 'tech.raise-dead', 'phaseComplete', 'skill.raise-dead', 'ritual')
  fireRule(w, me, 'tech.raise-dead', 'phaseComplete', 'skill.raise-dead', 'ritual')

  const minions = w.entities.filter(e => e.defId === 'entity.skeleton')
  eq('造出来两具', minions.length, 2)

  const a = minions[0]!
  const b = minions[1]!
  ok('两具没有叠在一起',
    distance(a.pos, b.pos) > 0.5,
    `两者相距 ${distance(a.pos, b.pos).toFixed(2)} 米`)
}

section('30. 不存在的实体预设会明确报错，不静默')

{
  const { w, roster } = arenaWorld()
  const me = roster.get('你')!

  let threw: unknown
  try {
    const ctx: ActionContext = { world: w, self: me, target: me, actor: me, depth: 0 }
    executeAction(ctx, {
      payload: { kind: 'spawn', entityId: 'entity.does-not-exist' },
    })
  } catch (e) {
    threw = e
  }

  ok('召唤不存在的预设会抛异常', threw !== undefined)
  ok('报错里说清了是哪个预设',
    String(threw).includes('entity.does-not-exist'), String(threw))
}

section('31. 术式编程：位移碰到了才放第二段（玩家给的那个例子）')

{
  /*
   * ⚠ 这一组是玩家原话的验收测试：
   *
   *   「术式例子：向指向方向位移（技能），若触碰到敌人则释放冲击（技能）」
   *
   *   对应内容：`tech.charge-impact`（出厂那份示范删了，
   *   现在这份定义住在 `tests/probes.ts` —— 形状一字不差）
   *     skills: [skill.charge-dash, skill.impact-burst]
   *     links:  [{ if: [prevHit] }]
   *
   * 在没有 links 之前这是**写不出来**的：术式只是把技能的阶段接起来，
   * 第二段永远无条件执行，"碰到了才炸"无处可写。
   */
  function composeArena(foeX: number, foeY: number) {
    const w = createWorld({ seed: 5 })
    const me = spawn(w, {
      faction: 'player',
      pos: { x: 0, y: 0 },
      base: { 'char.hp.max': 400, 'char.energy.max': 100, 'char.energy.regen': 0, 'char.speed': 6 },
      techniqueIds: ['tech.charge-impact'],
    })
    me.facing = { x: 1, y: 0 }
    const foe = spawn(w, {
      faction: 'enemy',
      pos: { x: foeX, y: foeY },
      base: { 'char.hp.max': 300, 'char.speed': 0 },
    })
    // 术式要注册进世界，引擎才查得到
    const tech = lookup('tech.charge-impact')
    if (tech !== undefined) registerTechnique(w, tech)
    return { w, me, foe }
  }

  // ---- 碰到了：两段都跑 ----
  {
    const { w, me, foe } = composeArena(1.2, 0)   // 贴脸站着
    const before = getStored(foe, 'char.hp.current')

    activate(w, me, lookup('tech.charge-impact')!, {
      intent: { kind: 'direction', dir: { x: 1, y: 0 } },
    })
    advance(w, 120)

    ok('碰到了：第二段跑了（敌人挨了冲击波）',
      getStored(foe, 'char.hp.current') < before,
      `血量 ${before} → ${getStored(foe, 'char.hp.current')}`)
  }

  // ---- 没碰到：第二段跳过 ----
  {
    const { w, me, foe } = composeArena(0, 14)   // 远远站在旁边
    const before = getStored(foe, 'char.hp.current')

    activate(w, me, lookup('tech.charge-impact')!, {
      intent: { kind: 'direction', dir: { x: 1, y: 0 } },
    })
    advance(w, 120)

    eq('没碰到：第二段被跳过，敌人一点血没掉',
      getStored(foe, 'char.hp.current'), before)
    eq('而且这次施法正常收尾了（不是卡住）', w.casts.length, 0)
  }

  // ---- 跳过第二段不影响第一段 ----
  {
    const { w, me } = composeArena(0, 14)
    const x0 = me.pos.x

    activate(w, me, lookup('tech.charge-impact')!, {
      intent: { kind: 'direction', dir: { x: 1, y: 0 } },
    })
    advance(w, 120)

    ok('跳过第二段不影响第一段：人还是冲出去了',
      me.pos.x - x0 > 3,
      `前进了 ${(me.pos.x - x0).toFixed(2)} 米`)
  }
}

section('32. 连接条件长什么样：prevHit 是"上一段碰到了人"')

{
  /*
   * ⚠ `prevHit` 问的是"**上一段技能**碰到了人没有"，
   *   不是"这次命中打中了没有"（那是钩子里的 onHit）。
   *   两者语境不同 —— 混了就会写出永远成立或永远不成立的条件。
   */
  const tech = lookup('tech.charge-impact')
  eq('这个术式有两个技能', tech?.skillIds.length, 2)
  eq('有一条连接条件（管第二个技能）', tech?.links.length, 1)
  ok('条件用的是 prevHit',
    JSON.stringify(tech?.links[0]?.if ?? []).includes('prevHit'),
    JSON.stringify(tech?.links[0]?.if))
}

// ---------------------------------------------------------------- 血契

section('33. 负值术式：血契不够就放不出来，够就扣掉')

{
  const { w, roster } = arenaWorld()
  const me = roster.get('你')!
  const foe = roster.get('剑奴')!

  /*
   * ⚠ **负值术式现在要自己造**。
   *
   *   出厂内容全是 0 点（宗旨没有例外 —— 曾经有过一个 `factoryDebt`
   *   "出厂就负债"的标记，2026-09-21 删掉了：玩家原话"负债件的变体
   *   不一定是负债件"，而且"为了两个出厂示范在宗旨上开口子"不值得）。
   *
   *   所以这里照着玩家真正会做的事做一遍：拿血祭斩做一份**变体**、
   *   把它改强（买 4 条规则位 = 花掉 6 点）—— 那份术式就是负值术式。
   *
   *   ⚠⚠ 2026-09-30（日志 60b）**"买 10 条"改成了"买 4 条"**：账现在是
   *     **查表 + 相加**，表里 `ruleSlots` 那一行是 `0…8`（出厂 4 ⇒ 0 点，8 ⇒ −6 点）。
   *     买 10 条 = 14 条 ⇒ 表外取值（点数 0）—— 而这一节要的正是"一份负值术式
   *     真的带上了血契消耗"。8 = 4 + 4 在表里，要钉的语义一个字都没变。
   */
  const baseSkill = readJson<Skill>(resolve('content/skills/blood-offering.json'))
  const variant: Skill = {
    ...(JSON.parse(JSON.stringify(baseSkill)) as Skill),
    id: 'custom.blood-offering.1',
    name: '血祭斩-副本1',
    basedOn: baseSkill.id,
  }
  variant.ruleSlots += 4

  const skillMap = new Map(lib.skills)
  skillMap.set(variant.id, variant)
  const lookup2 = (id: string): Skill | undefined => skillMap.get(id)
  const techDef: Technique = {
    schemaVersion: 1,
    id: 'tech.debt-probe',
    name: '负债探针',
    // ⚠ 系别必填（schema 的 Technique.kind）：它引用的是血祭斩的变体（魔法系）
    kind: 'magic',
    activation: 'press',
    // ⚠ 瞄准在**技能**上（2026-09-21 日志 47）：这一节测的是**血契**，
    //   瞄准由上面那个变体（`variant`，从 `skill.blood-offering` 拷来的）自己带
    skills: [variant.id],
  }
  const tech = compileTechnique(techDef, lookup2, {
    bloodPactCost: bloodPactCostOf(
      techDef, lookup2, priceOptionsFor(balance, lib.statuses, lib.entities),
    ),
  }).compiled
  registerTechnique(w, tech)

  eq('这个术式是负值术式（编译时带上了血契消耗）', tech.bloodPactCost > 0, true)
  ok('  —— 而且消耗是正的（|合计|）', tech.bloodPactCost > 0, String(tech.bloodPactCost))

  /*
   * ⚠ 这一条钉的是玩家选的语义：
   *   > 花超了的术式叫做：负值术式，消耗血契才能释放
   *   > 不够时 —— **放不出来**
   *
   *   备选方案（允许透支成负债 / 不够就用血补）都问过了，玩家选了最干净的那个。
   */
  setStored(me, 'char.bloodPact.current', 0)
  const blocked = activate(w, me, tech)
  ok('血契为 0 时放不出来', blocked.ok === false, JSON.stringify(blocked))
  ok('  而且原因是 bloodPact（不是笼统的"资源不足"）',
    blocked.ok === false && blocked.reason === 'bloodPact',
    blocked.ok ? '竟然放出来了' : blocked.reason)
  ok('  事件里也带了这个原因（界面要拿它显示"还差多少"）',
    w.events.some(e => e.type === 'castBlocked' && e.reason === 'bloodPact'))

  // 刚好够
  setStored(me, 'char.bloodPact.current', tech.bloodPactCost)
  const okCast = activate(w, me, tech)
  ok('血契刚好够时能放', okCast.ok === true, JSON.stringify(okCast))
  eq('  而且**精确扣掉** |合计| 那么多',
    getStored(me, 'char.bloodPact.current'), 0)
  ok('  扣血契会发事件（"这一局最贵的一次点击"要看得见）',
    w.events.some(e => e.type === 'bloodPactSpent'))

  // 差一点点
  setStored(me, 'char.bloodPact.current', tech.bloodPactCost - 0.01)
  const almost = activate(w, me, tech)
  ok('差 0.01 也放不出来（不是四舍五入之后够就算够）',
    almost.ok === false, JSON.stringify(almost))
}

section('34. 普通术式不受血契影响')

{
  const { w, roster } = arenaWorld()
  const me = roster.get('你')!
  const tech = lookup('tech.cleave')!

  eq('普通术式的血契消耗是 0', tech.bloodPactCost, 0)
  setStored(me, 'char.bloodPact.current', 0)
  const r = activate(w, me, tech)
  ok('血契为 0 照样能放（不然所有技能都废了）', r.ok === true, JSON.stringify(r))
}

section('35. 血契从"进入危机的行为"来')

{
  const { w, roster } = arenaWorld()
  const me = roster.get('你')!

  // 出厂内容把 tech.blood-pact 挂成了常驻术式
  ok('演武场给玩家挂了血契记账器',
    me.activeTechniques.includes('tech.blood-pact'), JSON.stringify(me.activeTechniques))

  setStored(me, 'char.bloodPact.current', 0)

  /*
   * ① 挂上一个**负面状态** → 攒血契。
   *
   * ⚠ 这一整条走的是 `onStatusApplied`。它**晚一 tick** 才结算 ——
   *   applyStatus 在伤害管线里面跑，而规则又可能施加新状态，
   *   当场触发就是递归。所以排队到 stepWorld 的固定位置。
   */
  const before = getStored(me, 'char.bloodPact.current')
  fireRule(w, me, 'tech.frost-lock', 'onHit', undefined, undefined, me)
  eq('挂上冻结的瞬间还没结算（排队等着）',
    getStored(me, 'char.bloodPact.current'), before)

  stepWorld(w)
  const afterDebuff = getStored(me, 'char.bloodPact.current')
  ok('跑一 tick 之后血契涨了（被挂 debuff 算一次危机）',
    afterDebuff > before, `${before} → ${afterDebuff}`)

  /*
   * ② **刷新同一个状态不该再给一次。**
   *
   *    不给这条限制的话，一个每秒重挂一次的 debuff 就是血契刷子 ——
   *    而"进入危机"该是一件有次数的事。
   */
  fireRule(w, me, 'tech.frost-lock', 'onHit', undefined, undefined, me)
  stepWorld(w)
  eq('再挂一次同一个状态不给第二份血契',
    getStored(me, 'char.bloodPact.current'), afterDebuff)

  /*
   * ③ 残血跨过 30% 也算一次危机。
   *
   *    `onLowHp` 的语义是"**跨过**"那一瞬间，不是"低于就一直触发" ——
   *    后者会变成"按时间收租"。
   */
  const hpMax = resolveAttribute(me, 'char.hp.max', { world: w, self: me })
  const beforeLow = getStored(me, 'char.bloodPact.current')
  setStored(me, 'char.hp.current', hpMax * 0.5)
  /*
   * ⚠ 先把暴击关掉：这一条测的是"跨过 30% 那一刻攒血契"，
   *   而一次暴击（×2）会把 120 点伤害变成 240 —— 人直接从 200 打到 0，
   *   跨线是跨了，但这条断言就变成看运气。机制测试不该依赖随机。
   */
  me.base.set('char.critRate', 0)
  dealDamage(w, me.id, me.id, hpMax * 0.3)
  const justAfter = getStored(me, 'char.hp.current')
  const lowEvents = w.events.filter(e => e.type === 'lowHp').length
  stepWorld(w)
  ok('血量跌破三成时血契涨了', getStored(me, 'char.bloodPact.current') > beforeLow,
    `${beforeLow} → ${getStored(me, 'char.bloodPact.current')}`
    + `（打完就 ${justAfter}/${hpMax}，lowHp 事件 ${lowEvents} 次，`
    + `一 tick 之后 ${getStored(me, 'char.hp.current')}）`)
}

section('36. 血契不会自己回复')

{
  /*
   * ⚠ 必须用一个**没有敌人**的干净世界来测这一条。
   *
   *   第一版是在演武场里测的，结果 5 秒里血契从 7 涨到 20 ——
   *   因为敌人真的在打他，残血和被挂 debuff 各触发了好几次。
   *   那说明**收入是活的**（好事），但它测不出"有没有 regen"。
   *   要单独测 regen，就得把收入源拿掉。
   */
  const w = createWorld({ seed: 1 })
  registerTechnique(w, lookup('tech.blood-pact')!)
  const me = spawn(w, {
    faction: 'player',
    pos: { x: 0, y: 0 },
    base: { 'char.hp.max': 200, 'char.energy.max': 100, 'char.energy.regen': 10 },
  })
  setTechniqueActive(w, me, 'tech.blood-pact', true)

  setStored(me, 'char.bloodPact.current', 7)
  advance(w, 300)   // 5 秒，中间没有任何危机事件
  /*
   * ⚠ 这是血契和能量的**本质区别**：能量是节奏，等一会儿就回来；
   *   血契是这一局攒出来的资本，只能靠危机换。
   *   一个 regen 都不该有 —— 有了的话"攒"这个动作就没意义了。
   */
  eq('没有任何危机事件时，跑 5 秒一点没变',
    getStored(me, 'char.bloodPact.current'), 7)
}

// ---------------------------------------------------------------- 隐形

section('37. 状态**自己声明**的 visibility 也能用（不只是载荷那条路）')

{
  const { w, roster } = arenaWorld()
  const me = roster.get('你')!
  const foe = roster.get('剑奴')!

  ok('开局敌人锁定得到你', findHostile(w, foe)?.id === me.id)

  /*
   * ⚠ 隐形有**两条路**，这里是第二条：
   *
   *   ① 载荷：`perception setVisibility` —— 引擎在运行期造一个带 visibility 的状态
   *          （潜行走的就是这条，第 23 节测过）
   *   ② 状态：`StatusDef.visibility` —— **作者直接在状态定义里写**
   *
   *   第 23 节测的是 ①。两条路都该能走通，因为它们最后都落到同一个
   *   `visibilityOf()`。只测 ① 的话，② 坏掉了没人知道。
   */
  const half = (): StatusDef => ({
    id: 'status.probe-half', name: '半透明', tags: ['buff'], duration: 5, visibility: 0.5,
  })
  const invisible = (): StatusDef => ({
    id: 'status.probe-invisible', name: '完全隐形', tags: ['buff'], duration: 5, visibility: 0,
  })

  applyStatus(w, me, half(), me.id)
  eq('声明 visibility: 0.5 → 半透明', visibilityOf(me), 0.5)
  /*
   * ⚠ 0.5 **还是能被锁定**的 —— 判据是 `visibilityOf < 0.5`（严格小于）。
   *   "半透明但还在"和"完全看不见"是两件事，这条界线不能糊。
   */
  ok('半透明还锁定得到（0.5 不是"隐身"）', findHostile(w, foe)?.id === me.id)

  applyStatus(w, me, invisible(), me.id)
  eq('再挂一个 0 → 取最小值，完全隐形', visibilityOf(me), 0)
  ok('现在锁定不到了', findHostile(w, foe)?.id !== me.id)

  // 移除之后要回到半透明（不是直接回到 1）—— 说明取的是当前状态集合的最小值
  removeStatus(w, me, 'status.probe-invisible')
  eq('把完全隐形摘掉 → 回到半透明', visibilityOf(me), 0.5)

  removeStatus(w, me, 'status.probe-half')
  eq('全摘掉 → 正常可见', visibilityOf(me), 1)
}

section('38. visibility: 1 是空操作，会被告出来')

{
  /*
   * ⚠ 玩家 2026-09-21 的原则：
   *   > 如果改变技能的某种属性不会改变技能的效果（或非常不明显），
   *   > 那这个属性可以固定而不进入编辑器供玩家修改。
   *
   *   `visibility: 1` 正好是这一类里最隐蔽的一种：它**看起来**像在设置什么，
   *   实际是默认值。熔岩护甲里曾经躺着这么一行。
   */
  const noop = validateStatus({
    id: 'status.probe-noop', name: '多余的', tags: ['buff'], duration: 3, visibility: 1,
  })
  ok('visibility: 1 会被报成空操作',
    noop.some(i => i.code === 'VISIBILITY_NO_OP'),
    noop.map(i => i.code).join(', '))

  const okOne = validateStatus({
    id: 'status.probe-ok', name: '半透明', tags: ['buff'], duration: 3, visibility: 0.5,
  })
  ok('  写 0.5 不报（那是真的有用）',
    !okOne.some(i => i.code === 'VISIBILITY_NO_OP'),
    okOne.map(i => i.code).join(', '))

  const bad = validateStatus({
    id: 'status.probe-bad', name: '越界', tags: ['buff'], duration: 3, visibility: 2,
  })
  ok('  越界（>1）是错误', bad.some(i => i.code === 'BAD_VISIBILITY'),
    bad.map(i => i.code).join(', '))
}

// ---------------------------------------------------------------- 持久区域

section('39. 持久区域：进来触发 onEnter，出去触发 onLeave')

{
  /*
   * ⚠ 这一节测的是**两块一直缺着的能力**：
   *   · `EntityKind: 'area'` —— 声明了「留在地上的区域」，引擎一处都不读
   *   · `onEnter` / `onLeave` —— schema 和说明生成器里都有，从来没被触发过
   *
   *   玩家点名要的「无下限术式：靠近的事物自动减速」就卡在这儿。
   */
  const w = createWorld({ seed: 1 })
  registerTechnique(w, lookup('tech.slow-field')!)

  // 一片长在原地的区域。它的行为来自**自己**的常驻术式
  const field = spawn(w, {
    kind: 'area',
    faction: 'player',
    pos: { x: 0, y: 0 },
    radius: 5,
    activeTechniques: ['tech.slow-field'],
    base: { 'char.hp.max': 1, 'char.energy.max': 0, 'char.speed': 0 },
  })
  eq('区域是 area 类型（AI 不会去驱动它）', field.kind, 'area')

  // 一个敌人，先站在**场外**
  const foe = spawn(w, {
    faction: 'enemy',
    pos: { x: 10, y: 0 },
    base: { 'char.hp.max': 200, 'char.speed': 6 },
  })
  foe.vel.x = 0
  foe.vel.y = 0

  stepWorld(w)
  ok('在场外时身上没有减速', !foe.statuses.some(s => s.defId === 'status.slowField'))
  eq('  区域也记着「里面没人」', field.inside.length, 0)

  // 走进去（直接改坐标，省得等它慢慢走）
  foe.pos.x = 4
  stepWorld(w)
  ok('走进去 → onEnter 触发，减速挂上了',
    foe.statuses.some(s => s.defId === 'status.slowField'),
    foe.statuses.map(s => s.defId).join(','))
  eq('  区域记下了「它在里面」', field.inside.join(','), String(foe.id))

  /*
   * ⚠ 再跑一 tick **不该重复触发**。
   *   重复触发的后果是状态被反复重挂 —— 时长永远刷新、层数一直涨，
   *   而且每次都会发一遍事件（界面上一片闪烁）。
   */
  const stacks = foe.statuses.find(s => s.defId === 'status.slowField')?.stacks
  stepWorld(w)
  eq('  还站在里面时不会重复触发',
    foe.statuses.find(s => s.defId === 'status.slowField')?.stacks, stacks)

  /*
   * ⚠ 减速**真的生效**了吗？看属性，不是看状态在不在。
   *   状态挂上了但 modifiers 没接上，是另一类"看着有、其实没有"。
   */
  const slow = resolveAttribute(foe, 'char.speed', { world: w, self: foe })
  ok('  而且速度真的被砍了一半', slow < 6, `速度 = ${slow}（基础 6）`)

  // 走出去
  foe.pos.x = 10
  stepWorld(w)
  ok('走出去 → onLeave 触发，减速被摘掉',
    !foe.statuses.some(s => s.defId === 'status.slowField'),
    foe.statuses.map(s => s.defId).join(','))
  eq('  区域也记着「它出去了」', field.inside.length, 0)
  eq('  速度也回到正常',
    resolveAttribute(foe, 'char.speed', { world: w, self: foe }), 6)
}

{
  /*
   * ⚠ **区域长出来的那一 tick**，已经在里面的人算「刚进来」。
   *
   *   这不是 bug，是必须的行为：火墙放在脚下，站在里面的人当场就该被烧到。
   *   反过来的实现（第一帧不发）会让「往人堆里扔一片场地」
   *   要等他们出去再进来才生效 —— 那是说不通的。
   */
  const w = createWorld({ seed: 2 })
  registerTechnique(w, lookup('tech.slow-field')!)

  const foe = spawn(w, {
    faction: 'enemy', pos: { x: 1, y: 0 }, base: { 'char.hp.max': 200, 'char.speed': 0 },
  })
  spawn(w, {
    kind: 'area',
    faction: 'player',
    pos: { x: 0, y: 0 },
    radius: 5,
    activeTechniques: ['tech.slow-field'],
    base: { 'char.hp.max': 1, 'char.energy.max': 0, 'char.speed': 0 },
  })

  stepWorld(w)
  ok('区域立起来的当帧就影响到了已经站在里面的人',
    foe.statuses.some(s => s.defId === 'status.slowField'),
    foe.statuses.map(s => s.defId).join(','))
}

{
  /*
   * ⚠ 区域**不互相进入**。
   *   一片火墙踩进另一片、一个减速场套另一个 —— 那些组合没有人想过，
   *   引擎不该默认产生它们。要让区域互相影响，是**显式**写规则的事。
   */
  const w = createWorld({ seed: 3 })
  const a = spawn(w, {
    kind: 'area', faction: 'player', pos: { x: 0, y: 0 }, radius: 5,
    base: { 'char.hp.max': 1, 'char.speed': 0 },
  })
  const b = spawn(w, {
    kind: 'area', faction: 'enemy', pos: { x: 0, y: 0 }, radius: 5,
    base: { 'char.hp.max': 1, 'char.speed': 0 },
  })

  stepWorld(w)
  eq('重叠的两片区域互不「进入」', a.inside.length + b.inside.length, 0)
}

{
  /*
   * 另一种形态：**跟着人走的光环**。
   *
   * ⚠ 它不需要新能力 —— `delivery.kind: 'aura'` 会按施法者当前位置取范围内的人，
   *   配一条 `onTick` 规则就是"持续施加"。和区域的分工是：
   *     光环 —— 持续施加（一直减速）
   *     区域 —— 进出那一刻触发一次（进来才减速、出去恢复）
   *   两种都做出来了，用途不同，所以没有合并成一个字段。
   *
   * 这一条只验证 aura 载体会跟着施法者走（区域是钉在原地不动的对照组）。
   */
  const w = createWorld({ seed: 4 })
  const tech = lookup('tech.holy-light')!   // aura 载体的出厂例子
  registerTechnique(w, tech)

  const me = spawn(w, {
    faction: 'player', pos: { x: 0, y: 0 },
    base: { 'char.hp.max': 200, 'char.energy.max': 100, 'char.speed': 5 },
  })
  const foe = spawn(w, {
    faction: 'enemy', pos: { x: 3, y: 0 }, base: { 'char.hp.max': 200, 'char.speed': 0 },
  })

  // 光环跟着人走：把人挪过去，覆盖范围跟着挪
  me.pos.x = 2
  stepWorld(w)
  ok('光环载体读的是施法者**当前**位置（所以它跟着人走）',
    distance(me.pos, foe.pos) < 4, `距离 ${distance(me.pos, foe.pos)}`)
}


{
  /*
   * ⚠ **场地散了，里面的人要被放出来。**
   *
   *   这是那个 bug 的回归测试：状态是挂在**人**身上的，
   *   场地散不散和它没关系 —— 不在清理前补一刀，
   *   被减速过的人会**永久减速**，而且没有任何地方会报错。
   *
   *   表现是"这一局打完之后人还是慢的"，而那种现象
   *   通常会被当成"数值没调好"，查很久。
   */
  const w = createWorld({ seed: 5 })
  registerTechnique(w, lookup('tech.slow-field')!)

  spawn(w, {
    kind: 'area',
    faction: 'player',
    pos: { x: 0, y: 0 },
    radius: 5,
    // 只活 0.2 秒 —— 让它很快自己散掉
    lifetime: 0.2,
    activeTechniques: ['tech.slow-field'],
    base: { 'char.hp.max': 1, 'char.energy.max': 0, 'char.speed': 0 },
  })

  const foe = spawn(w, {
    faction: 'enemy',
    pos: { x: 2, y: 0 },
    base: { 'char.hp.max': 200, 'char.speed': 6 },
  })
  foe.vel.x = 0
  foe.vel.y = 0

  stepWorld(w)
  ok('场地立起来的当帧就黏住了里面的人',
    foe.statuses.some(s => s.defId === 'status.slowField'))

  // 跑到场地自己到期消失
  advance(w, 30)
  ok('场地已经散了', w.entities.every(e => e.kind !== 'area'))
  ok('  而且把里面的人放出来了（不是永久减速）',
    !foe.statuses.some(s => s.defId === 'status.slowField'),
    foe.statuses.map(s => s.defId).join(','))
  eq('  速度也回到正常',
    resolveAttribute(foe, 'char.speed', { world: w, self: foe }), 6)
}
// ---------------------------------------------------------------- 改阵营

section('40. 魅惑：把敌人变成队友（factionOf 是唯一的判据）')

{
  /*
   * ⚠ `EntityDef.faction` 只在 spawn 时定，之后没有任何一条路能改它 ——
   *   而 schema 里那句注释（「魅惑就是改这个字段」）写了很久。
   *
   *   现在改的是 `StatusDef.faction`：挂着就改阵营、到期就还原。
   *   引擎里**只有** `factionOf()` 一处读阵营，所以改完立刻处处生效。
   */
  const { w, roster } = arenaWorld()
  const me = roster.get('你')!
  const foe = roster.get('剑奴')!

  ok('开局敌人锁定得到你', findHostile(w, foe)?.id === me.id)
  ok('  你是它眼里的敌人（isHostile）', isHostile(factionOf(me), factionOf(foe)))

  // 玩家策反剑奴 —— faction: 'caster' 解析成**施加者**的阵营
  applyStatus(w, foe, {
    id: 'status.probe-charm', name: '策反', tags: ['debuff', 'charm'],
    duration: 10, faction: 'caster', removal: { expires: true },
  }, me.id)

  eq('阵营被盖掉了', factionOf(foe), 'player')
  ok('  它不再是你的敌人了', !isHostile(factionOf(me), factionOf(foe)))
  ok('  而且它锁定不到你了（findHostile 按阵营动态查）',
    findHostile(w, foe)?.id !== me.id,
    `它锁定的是 #${String(findHostile(w, foe)?.id)}`)
  ok('  它现在算你的友军（findAlly 看得到它）',
    findAlly(w, me)?.id === foe.id)
  /*
   * ⚠ 反过来也要成立 —— 这才是「一份内容两边都对」：
   *   敌人对玩家用同一个技能，玩家就变成敌军。
   */
  ok('  而且它对你的友军是敌对的（阵营换了一整边）',
    w.entities.some(e => e.id !== foe.id && isHostile(factionOf(foe), factionOf(e))))
}

{
  // 到期之后**自动还原** —— 这是"做成状态"换来的好处，一点额外机制都没加
  const { w, roster } = arenaWorld()
  const me = roster.get('你')!
  const foe = roster.get('剑奴')!

  applyStatus(w, foe, {
    id: 'status.probe-charm2', name: '策反', tags: ['debuff'],
    duration: 0.2, faction: 'caster', removal: { expires: true },
  }, me.id)
  eq('挂上时是友军', factionOf(foe), 'player')

  advance(w, 30)   // 跑过那 0.2 秒
  ok('状态到期了', !foe.statuses.some(s => s.defId === 'status.probe-charm2'))
  eq('阵营自动还原', factionOf(foe), 'enemy')
  ok('  又锁定得到你了', findHostile(w, foe)?.id === me.id)
}

{
  /*
   * ⚠ 最后挂上的那个说了算。
   *   被策反回来又被策反过去，当前状态应该是**后者** ——
   *   取"第一个"的话，第二次策反会静默失效。
   */
  const { w, roster } = arenaWorld()
  const me = roster.get('你')!
  const foe = roster.get('剑奴')!

  applyStatus(w, foe, {
    id: 'status.probe-to-player', name: '策反', tags: ['debuff'],
    duration: 10, faction: 'player',
  }, me.id)
  applyStatus(w, foe, {
    id: 'status.probe-to-enemy', name: '再策反', tags: ['debuff'],
    duration: 10, faction: 'enemy',
  }, foe.id)
  eq('后挂上的那个说了算', factionOf(foe), 'enemy')

  removeStatus(w, foe, 'status.probe-to-enemy')
  eq('  摘掉它之后回落到前一个', factionOf(foe), 'player')
}
// ---------------------------------------------------------------- 份数类修饰

/**
 * **一个安静的演武场**：只有你一个人，没有 AI 来打岔。
 *
 * ⚠ 为什么份数那几节不直接用 `arenaWorld()`（那四节踩不起这个坑）：
 *   这几节要**推进好几秒**（一段跑完、冷却转好、缓冲过期），
 *   而 arena 里那三个 AI 会在这几秒里把玩家砍死 ——
 *   那时候"第二下没放出来"的原因就成了**人死了**，
 *   而断言（`!r.ok`）看起来照样通过。测出来的不是要测的那件事。
 */
function quietWorld(): {
  w: ReturnType<typeof createWorld>
  me: ReturnType<typeof createWorld>['entities'][number]
} {
  const w = createWorld({ seed: 7 })
  const me = spawn(w, {
    faction: 'player',
    pos: { x: 0, y: 0 },
    base: { 'char.hp.max': 500, 'char.energy.max': 200 },
  })
  /*
   * ⚠ 状态定义要**注册进世界**：份数那几节用的技能里有挂状态的
   *   （`skill.mark` 的 perception、`skill.cleave` 的内联状态），
   *   而"世界里没有这个状态定义"的失败方式是**静默的**（技能看起来放了、什么都没发生）。
   *   `arenaWorld()` 走 `applyScenario` 时顺手注册了，这里得自己来。
   */
  for (const st of libraryStatuses) registerStatusDef(w, st)
  /*
   * ⚠ 实体预设同理（日志 55 加的）：`skill.place-slow-field` 这类**召唤载体**
   *   的技能要 `world.entityDefs` 里有那份预设（`spawn` 载荷查不到会**抛异常**，
   *   那是故意的 —— 静默召唤出一团空气更坏）。`arenaWorld()` 走 `applyScenario`
   *   时顺手注册了，`quietWorld()` 得自己来。
   */
  for (const def of libraryEntities) registerEntityDef(w, def)
  return { w, me }
}

/**
 * 造一份**带份数类修饰**的测试术式：一段、若干个真技能、前面挂几个副本。
 *
 * ⚠ 用**出厂技能**（不是现编的假技能）：这几节测的是"份数"这一层，
 *   而它读的是技能自己的时间轴 / 能量 / 冷却 —— 假技能会把那些数一起换掉，
 *   于是"蓝耗按份数乘"这类断言就变成了在测自己编的数。
 */
function groupTechnique(
  id: string,
  skills: string[],
  mods: Array<{ proto: string, count: number, at?: number }>,
): Technique {
  return {
    schemaVersion: 1,
    id,
    name: id,
    kind: 'magic',
    activation: 'press',
    sequences: [{
      name: '一段',
      skills: [...skills],
      mods: mods.map(m => ({
        proto: m.proto,
        at: m.at ?? 0,
        params: { count: m.count },
      })),
    }],
  }
}

/** 编译一份测试术式（**带上出厂原型表** —— 不带的话副本解析不出来，而且是静默的） */
function compileProbe(tech: Technique): {
  compiled: ReturnType<typeof compileTechnique>['compiled']
  problems: ReturnType<typeof compileTechnique>['problems']
} {
  const r = compileTechnique(tech, id => lib.skills.get(id), {
    bloodPactCost: 0,
    modifiers: lib.modifiers,
  })
  return { compiled: r.compiled, problems: r.problems }
}

/** 这一 tick 里**你**起了几个施法 */
function castsStartedBy(w: ReturnType<typeof createWorld>, entityId: number): number {
  let n = 0
  for (const ev of w.events) {
    if (ev.type === 'castStarted' && ev.casterId === entityId) n++
  }
  return n
}

/**
 * 这一 tick 里触发了哪几份修饰副本。
 *
 * ⚠ 单独一个函数是因为它的**读法**容易错：`world.events` 是"**这一 tick**
 *   发生了什么"（`stepWorld` 开头就清空）—— 想观察一个瞬间事件，
 *   必须**一 tick 一 tick 地看**，不能一把 `advance` 过去（见第 55 节那段）。
 *   抽成一个函数至少让"读的是这一 tick"这件事写在名字旁边。
 */
function triggerEvents(
  w: ReturnType<typeof createWorld>,
): Array<{ techniqueId: string; when?: string }> {
  const out: Array<{ techniqueId: string; when?: string }> = []
  for (const ev of w.events) {
    if (ev.type === 'modifierTriggered') {
      out.push(ev.when === undefined
        ? { techniqueId: ev.techniqueId }
        : { techniqueId: ev.techniqueId, when: ev.when })
    }
  }
  return out
}

section('41. 多重释放：一次激活把后面 N 个技能一起打出去')

{
  const { w, me } = quietWorld()
  const tech = groupTechnique(
    'probe.multi-fire',
    ['skill.magic-bolt', 'skill.hunt', 'skill.impact-burst'],
    [{ proto: 'mod.multi.fire', count: 3 }],
  )
  const { compiled, problems } = compileProbe(tech)
  eq('编译没有报问题', problems.length, 0)
  eq('  副本记下了份数（编译期读好的）', compiled.segments?.[0]?.mods?.[0]?.count, 3)
  registerTechnique(w, compiled)

  const energy0 = getStored(me, 'char.energy.current')
  /*
   * ⚠ 意图给的是"朝上"：三个技能都要**读同一个意图**（定稿 §九）——
   *   一次输入只有一份指向，各自解释它。
   */
  const r = pressSequence(w, me, compiled, { facing: { x: 0, y: 1 } })
  ok('按一下放出来了', r.ok === true, String(r.reason ?? ''))
  eq('  一次激活里起了 **3 个**施法（三个人技能一起打出）', castsStartedBy(w, me.id), 3)

  const mine = w.casts.filter(c => c.casterId === me.id)
  eq('  三个施法都在跑', mine.length, 3)
  ok('  它们**共用同一个意图**（三个都朝上）',
    mine.every(c => c.facing.x === 0 && c.facing.y === 1),
    mine.map(c => `${String(c.facing.x)},${String(c.facing.y)}`).join(' | '))
  ok('  而且是三个**不同**的技能各一份',
    new Set(mine.map(c => c.technique.skillIds[0])).size
    === new Set(['skill.magic-bolt', 'skill.hunt', 'skill.impact-burst']).size,
    mine.map(c => String(c.technique.skillIds[0])).join(', '))

  /*
   * ⚠ **份数不是免费的**：三个技能各付自己那一份能量
   *   （魔法飞弹 10 + 猎杀 10 + 冲击爆发 20 = 40）。
   *   写成"只付一份"的话，多重释放就是白送 —— 而账面上看不出来。
   */
  eq('  能量按**三份**扣（10 + 10 + 20）',
    energy0 - getStored(me, 'char.energy.current'), 40)

  /*
   * ⚠ **冷却键是段自己的**（不是"段#技能"）：所以"这一段在冷却"这件事
   *   跟的是段那一格，HUD / `peekSequence` 问的也是它。
   *   ⚠ 一份一个键（`段#技能`）的话，"多重释放打出 3 个"会变成
   *     **这一段永远不冷却** —— 按一下出一组，一直按一直出。
   *
   *   ⚠ 这里只判"段那一格 > 0 而每份各自的键 = 0"，
   *     **不判具体是多少秒**：冷却是在**阶段进入**时付的
   *     （`payPhaseCost`），此刻只有各份的**第一个阶段**进过 ——
   *     所以那个数是"已经进过的阶段里的最大值"，不是"三份冷却里的最大值"。
   *     拿它去断言 3 秒会测到一个**和段键无关的事实**。
   */
  const segId = compiled.segments?.[0]?.technique.id ?? ''
  ok('  这一段自己的冷却格记上了（冷却跟的是**段**，不是某一份）',
    getStored(me, 'cd.' + segId) > 0, String(getStored(me, 'cd.' + segId)))
  eq('  而没有"一份一个键"那种东西',
    getStored(me, 'cd.' + segId + '#skill.magic-bolt'), 0)

  /*
   * ⚠ 放的过程中再按 → **只缓冲**（"放完才走下一段"那条规矩，日志 49），
   *   而**不能**再起一组 —— 不然连点等于白嫖倍数的倍数。
   *
   *   ⚠ 数事件要**数增量**：`world.events` 只在 `stepWorld` 开头清空，
   *     这里没有推进世界，所以数组里还留着第一下那三条
   *     （写成"等于 0"会测到一个假事实）。
   */
  const beforeBuffered = castsStartedBy(w, me.id)
  const again = pressSequence(w, me, compiled, { facing: { x: 0, y: 1 } })
  ok('  放的过程中再按 → 只缓冲（不插队）', again.ok === true && again.buffered === true,
    JSON.stringify({ ok: again.ok, buffered: again.buffered, reason: again.reason }))
  eq('  而且这一下**没有**新起施法', castsStartedBy(w, me.id) - beforeBuffered, 0)
}

{
  /*
   * ⚠ ---- **冷却那一格真的用上了** ----
   *
   *   "一次激活起了 N 个施法"如果各记各的冷却（`段#技能`），
   *   那**段自己那一格永远不会冷却** —— 表现是"按一下出一组、一直按一直出"。
   *   所以这一节把它钉住：一段放完之后进冷却，冷却里按不出第二组。
   */
  const { w, me } = quietWorld()
  const tech = groupTechnique(
    'probe.multi-cd',
    ['skill.magic-bolt', 'skill.hunt'],
    [{ proto: 'mod.multi.fire', count: 2 }],
  )
  const { compiled } = compileProbe(tech)
  registerTechnique(w, compiled)

  const r1 = pressSequence(w, me, compiled, { facing: { x: 0, y: 1 } })
  ok('第一下放出来了', r1.ok === true)
  eq('  两份额技能一起打出', castsStartedBy(w, me.id), 2)

  // 推到这一组跑完（猎杀 2 个阶段 ≈ 0.6 秒），冷却还在
  advance(w, 60)
  ok('  这一组跑完了（没有残留的施法）',
    w.casts.filter(c => c.casterId === me.id).length === 0,
    String(w.casts.filter(c => c.casterId === me.id).length))

  const cooling = pressSequence(w, me, compiled, { facing: { x: 0, y: 1 } })
  ok('冷却里按 → 放不出来，而且原因是**冷却**（不是"静默什么都不发生"）',
    cooling.ok === false && cooling.reason === 'cooldown',
    JSON.stringify({ ok: cooling.ok, reason: cooling.reason }))
  eq('  这一下也一个施法都没起', castsStartedBy(w, me.id), 0)

  // 再推到冷却转好（那一段 3 秒）
  advance(w, 200)
  const cool = getStored(me, 'cd.' + (compiled.segments?.[0]?.technique.id ?? ''))
  eq('  冷却转好了', Math.round(cool * 100) / 100, 0)
  const r2 = pressSequence(w, me, compiled, { facing: { x: 0, y: 1 } })
  ok('冷却过了再按 → 又能放出一整组', r2.ok === true, String(r2.reason ?? ''))
  eq('  而且还是**两份**', castsStartedBy(w, me.id), 2)
}

section('42. 多重释放：份数的上限与"凑不满就照实打"')

{
  /*
   * ⚠ 上限住在**原型**里（`mod.multi.fire` 的 `params.max` = 10）——
   *   编译期把它夹住，而且**夹了要说出来**（手改的存档绕过校验器直接进世界）。
   */
  const { w, me } = quietWorld()
  const over = groupTechnique(
    'probe.multi-over',
    ['skill.magic-bolt', 'skill.hunt'],
    [{ proto: 'mod.multi.fire', count: 11 }],
  )
  const r = compileProbe(over)
  eq('要 11 份 → 编译期报一条问题（说清楚被夹到了上限）', r.problems.length, 1)
  ok('  而且它说的是"超过上限 10"',
    (r.problems[0]?.message ?? '').includes('上限 10'), r.problems[0]?.message ?? '')
  eq('  编译产物里记的份数被夹到 **10**', r.compiled.segments?.[0]?.mods?.[0]?.count, 10)

  registerTechnique(w, r.compiled)
  const pressed = pressSequence(w, me, r.compiled, { facing: { x: 0, y: 1 } })
  ok('  放得出来', pressed.ok === true)
  /*
   * ⚠ 这一段只有**两个互不相同**的技能 ⇒ 照实打两个。
   *   玩家写的是"N 个**互不相同**的瞬发技能"，所以"凑不满"不是错误，
   *   而是"有几个打几个"（校验器会给一条警告，见 `tests/weapons.ts`）。
   */
  eq('  这一段只有 2 个不同的技能 → 只打出 2 份', castsStartedBy(w, me.id), 2)
}

section('43. 一分为 X：同一个技能 X 份，蓝耗按份数乘')

{
  const { w, me } = quietWorld()
  /*
   * ⚠ 只有一个技能（魔法飞弹，10 能量）——「一分为 X」动的是**它的份数**，
   *   和「多重释放」动"后面 N 个不同的技能"是**两条轴**。
   */
  const tech = groupTechnique('probe.split', ['skill.magic-bolt'],
    [{ proto: 'mod.split', count: 3 }])
  const { compiled, problems } = compileProbe(tech)
  eq('编译没有报问题', problems.length, 0)
  registerTechnique(w, compiled)

  const energy0 = getStored(me, 'char.energy.current')
  const r = pressSequence(w, me, compiled, { facing: { x: 0, y: 1 } })
  ok('按一下放出来了', r.ok === true, String(r.reason ?? ''))
  eq('  同一个技能起了 **3 个**施法', castsStartedBy(w, me.id), 3)

  const mine = w.casts.filter(c => c.casterId === me.id)
  eq('  三份是**同一个技能**（不是三个不同的技能）',
    new Set(mine.map(c => c.technique.skillIds[0])).size, 1)
  ok('  而且它们的施法产物都是**这一段自己的键**（冷却 / HUD 认的就是它）',
    mine.every(c => c.technique.id === (compiled.segments?.[0]?.technique.id ?? '')),
    mine.map(c => c.technique.id).join(', '))
  /*
   * ⚠⚠ **蓝耗按份数乘** —— 玩家点名的规矩。
   *   ⚠ 它是**自然的结果**，不是外加的一行：每一份都是一次独立的激活，
   *     各自付自己那一份。这一条断言就是钉住"以后别把它优化成一份"。
   */
  eq('  能量按**三份**乘（10 × 3 = 30）',
    energy0 - getStored(me, 'char.energy.current'), 30)
}

{
  /* ⚠ X 的上限是 **4**（原型 `mod.split` 的 `params.max`）—— 和多重释放的 10 不是一条 */
  const { w, me } = quietWorld()
  const over = groupTechnique('probe.split-over', ['skill.magic-bolt'],
    [{ proto: 'mod.split', count: 5 }])
  const r = compileProbe(over)
  eq('要 5 份 → 编译期报一条问题', r.problems.length, 1)
  ok('  而且它说的是"超过上限 4"',
    (r.problems[0]?.message ?? '').includes('上限 4'), r.problems[0]?.message ?? '')
  eq('  编译产物里记的份数被夹到 **4**', r.compiled.segments?.[0]?.mods?.[0]?.count, 4)

  registerTechnique(w, r.compiled)
  const energy0 = getStored(me, 'char.energy.current')
  const pressed = pressSequence(w, me, r.compiled, { facing: { x: 0, y: 1 } })
  ok('  放得出来', pressed.ok === true, String(pressed.reason ?? ''))
  eq('  打出 **4 份**（夹过之后的份数）', castsStartedBy(w, me.id), 4)
  eq('  能量也按 4 份乘（10 × 4 = 40）',
    energy0 - getStored(me, 'char.energy.current'), 40)
}

section('44. 两个份数修饰叠在同一个技能前面：一共 X + N − 1 份（相加，不是相乘）')

{
  const { w, me } = quietWorld()
  /*
   * ⚠⚠ 这是**这一片自己定的一条**（玩家点名的"你自己定一个合理做法"）：
   *     「一分为 X」把第一个技能掰成 X 份，「多重释放」再把**另外** N−1 个
   *     不同的技能带上 —— 一共 **X + (N−1)** 份。
   *   ⚠ **不是 N × X**：第一个技能在"N 个不同技能"里已经算过一份了，
   *     相乘会把同一个技能数两遍（理由写在日志 51 的待裁定项里）。
   *   ⚠ 这条断言的意义就是"钉住这个选择" —— 它**待玩家裁定**：
   *     玩家要是说"该相乘"，改的是这一行和日志，而不是偷偷漂过去。
   */
  const tech = groupTechnique(
    'probe.multi-split',
    ['skill.magic-bolt', 'skill.hunt', 'skill.impact-burst'],
    [
      { proto: 'mod.multi.fire', count: 2 },
      { proto: 'mod.split', count: 3 },
    ],
  )
  const { compiled, problems } = compileProbe(tech)
  eq('编译没有报问题（两个**不同类**的副本可以并排）', problems.length, 0)
  registerTechnique(w, compiled)

  const energy0 = getStored(me, 'char.energy.current')
  const r = pressSequence(w, me, compiled, { facing: { x: 0, y: 1 } })
  ok('按一下放出来了', r.ok === true, String(r.reason ?? ''))
  /* X(3) + N−1(1) = 4 份；如果是相乘就是 6 份 —— 这条断言把两者分开 */
  eq('  一共打出 **4 份**（3 + 2 − 1，不是 3 × 2 = 6）', castsStartedBy(w, me.id), 4)
  /* 能量：魔法飞弹 3 份（30）+ 猎杀 1 份（10）= 40 */
  eq('  能量按**实际打出的份数**收（10×3 + 10 = 40）',
    energy0 - getStored(me, 'char.energy.current'), 40)
}

section('45. 一次激活的代价不够 → 整组都不放（不是"放出一半"）')

{
  const { w, me } = quietWorld()
  const tech = groupTechnique(
    'probe.group-energy',
    ['skill.magic-bolt', 'skill.hunt', 'skill.impact-burst'],
    [{ proto: 'mod.multi.fire', count: 3 }],
  )
  const { compiled } = compileProbe(tech)
  registerTechnique(w, compiled)

  /*
   * ⚠ 这一组要 40 点能量，只给 25 —— 前两份够、第三份不够。
   *   如果一份一份地判，玩家会看到"三份里出来两份"，而且**不知道为什么**。
   *   所以 `activateGroup` 先把所有份的代价加起来判一次：**全有或全无**。
   */
  setStored(me, 'char.energy.current', 25)
  const r = pressSequence(w, me, compiled, { facing: { x: 0, y: 1 } })
  ok('能量不够 → 整组都放不出来，原因说清楚是**能量**',
    r.ok === false && r.reason === 'energy', JSON.stringify({ ok: r.ok, reason: r.reason }))
  eq('  一个施法都没起（不是"放出一半"）', castsStartedBy(w, me.id), 0)
  eq('  能量一点都没扣', getStored(me, 'char.energy.current'), 25)

  // 给够 → 整组照常出来（证明上面那条不是"这一段坏了"）
  setStored(me, 'char.energy.current', 40)
  const ok2 = pressSequence(w, me, compiled, { facing: { x: 0, y: 1 } })
  ok('给够 40 点 → 一整组都出来', ok2.ok === true, String(ok2.reason ?? ''))
  eq('  三份', castsStartedBy(w, me.id), 3)
  eq('  能量扣光', getStored(me, 'char.energy.current'), 0)
}

// ============================================================================
//  「等待 X 秒」—— 2026-09-30 日志 52
// ============================================================================

/**
 * 造一份**带等待**的测试术式：一段、若干个真技能、前面挂一个等待副本。
 *
 * ⚠ 和 `groupTechnique` 分开是因为等待的参数形状**和份数不是一套**
 *   （修饰技能参数异构，定稿 §八 明确不要统一参数表）——
 *   硬塞进 `groupTechnique` 会让那个辅助函数长出一个"看 proto 决定参数键"的分支。
 */
function waitTechnique(
  id: string,
  skills: string[],
  params: { seconds?: number, locks?: string[], interrupt?: string, at?: number } = {},
): Technique {
  const p: Record<string, unknown> = { seconds: params.seconds ?? 1.5 }
  if (params.locks !== undefined) p['locks'] = params.locks
  if (params.interrupt !== undefined) p['interrupt'] = params.interrupt
  return {
    schemaVersion: 1,
    id,
    name: id,
    kind: 'magic',
    activation: 'press',
    sequences: [{ name: '一段', skills: [...skills], mods: [{ proto: 'mod.wait', at: params.at ?? 0, params: p }] }],
  }
}

/**
 * 按一次、然后**一 tick 一 tick 地推**，记下每个阶段在哪一 tick 进入。
 *
 * ⚠ 为什么不用 `advance(w, N)`：这一节要断言的正是**时间点**
 *   （"后面那个技能晚了多少"），而 `advance` 只给一个终点状态 ——
 *   拿终态去推时间就只能"数阶段"，那测的是另一件事。
 */
function phaseTicksOf(
  w: ReturnType<typeof createWorld>,
  me: ReturnType<typeof createWorld>['entities'][number],
  compiled: ReturnType<typeof compileTechnique>['compiled'],
  maxSteps = 400,
): { pressed: ReturnType<typeof pressSequence>, ticks: Map<string, number> } {
  const ticks = new Map<string, number>()
  /*
   * ⚠ **`pressSequence` 自己就会进第 0 个阶段**（`activate` → `enterPhase(…, 0)`），
   *   所以那一条 `castPhase` 事件在按下的那一刻就已经躺在 `world.events` 里了。
   *   不在这里收一次的话，"第一个技能是第几个 tick 进的"永远是 `undefined` ——
   *   而那一格正是"等待确实把它后面的推后了"的对照组。
   *   ⚠ 这也是"第一下是同一 tick 里进阶段的"这条引擎行为的直接体现。
   */
  const pressed = pressSequence(w, me, compiled, { facing: { x: 0, y: 1 } })
  for (const ev of w.events) {
    if (ev.type === 'castPhase') ticks.set(ev.phaseId, w.tick)
  }
  for (let i = 0; i < maxSteps; i++) {
    stepWorld(w)
    for (const ev of w.events) {
      if (ev.type === 'castPhase') ticks.set(ev.phaseId, w.tick)
    }
    if (w.casts.filter(c => c.casterId === me.id).length === 0) break
  }
  return { pressed, ticks }
}

const WAIT_PHASE_ID = '#wait0'

/**
 * 一个阶段 id 属于**哪个技能**（`skill.x#cast` → `skill.x`）。
 *
 * ⚠ 等待阶段的前缀是**空的**（`#wait0`）—— 它故意不挂在任何技能名下，
 *   理由见 `compile.ts` 的 `insertWaitPhases`（挂了会让 `links` 那道门被跳过）。
 *   这里按**和引擎同一句规矩**取前缀（第一个 `#` 之前），而不是自己另写一套。
 */
function ownerNameOf(phaseId: string | undefined): string {
  if (phaseId === undefined) return ''
  const i = phaseId.indexOf('#')
  return i < 0 ? '' : phaseId.slice(0, i)
}

section('46. 等待 X 秒：它在时间轴上就是一段空档（插在某一格前面）')

{
  const { w, me } = quietWorld()
  /*
   * ⚠ 一份**两个技能**的术式，等待插在**第二个技能前面**（`at: 1`）——
   *   这正是这个零件的用法："插在某一格前面，让后面的技能晚 X 秒"。
   *   引擎侧**零新概念**：编译期往时间轴里插一个真阶段，
   *   后面那些阶段自然被推后（时间轴是一条线）。
   */
  /*
   * ⚠ 2026-09-30（日志 54）：`locks` 从 `['cast', 'attack']` 改成 `['move']`。
   *   玩家改了行为 —— **施法 + 攻击不再是可配项**（施法独占是引擎硬规矩），
   *   所以这一节钉的"逐字来自副本"那个值也跟着换成**还配得了**的那一项。
   *   （断言本身没弱化：它照样要求副本里的值原样传进编译产物。）
   */
  const tech = waitTechnique('probe.wait-timeline', ['skill.magic-bolt', 'skill.hunt'],
    { seconds: 1.5, locks: ['move'], interrupt: 'none', at: 1 })
  const { compiled, problems } = compileProbe(tech)
  eq('编译没有报问题', problems.length, 0)

  const seg = compiled.segments?.[0]
  const mod = seg?.mods?.[0]
  eq('  副本记下了秒数（编译期读好的）', mod?.waitSeconds, 1.5)
  eq('  也记下了「锁哪些能力」这个参数（逐字来自副本）',
    JSON.stringify(mod?.waitLocks), JSON.stringify(['move']))
  eq('  还有打断档', mod?.waitInterrupt, 'none')

  const phases = seg?.technique.phases ?? []
  /*
   * ⚠ 段自己的时间轴 = 魔法飞弹 1 个阶段 + 猎杀 2 个阶段 = 3 格，
   *   等待再插 1 格 ⇒ **4 格**（多出来的就是那一段空档）。
   */
  eq('  时间轴多了一格（1 个等待阶段）', phases.length, 4)
  eq('  它插在**第二个技能的第一个阶段之前**', phases[1]?.id, WAIT_PHASE_ID)
  eq('  它的时长就是那 X 秒', phases[1]?.duration, 1.5)
  eq('  它**占用施法者**（玩家定的"期间施法者被占用"）', phases[1]?.occupiesCaster, true)
  eq('  它的打断档是参数给的那一档', phases[1]?.interrupt, 'none')
  eq('  它带着定价器要认的那个标记', phases[1]?.wait, true)
  /*
   * ⚠ 等待阶段**故意不挂在任何技能名下**（不是 `skill.hunt#wait`）：
   *   `advancePhase` 拿"换技能了吗"当连接门的判据，挂上目标技能的前缀
   *   会让那道门**被跳过**（`links` 的条件再也拦不住那个技能）。
   */
  eq('  它不挂在任何技能名下（连接门才不会被跳过）', ownerNameOf(phases[1]?.id), '')

  registerTechnique(w, compiled)
  const run = phaseTicksOf(w, me, compiled)
  ok('按一下放出来了', run.pressed.ok === true, String(run.pressed.reason ?? ''))
  const boltAt = run.ticks.get('skill.magic-bolt#cast')
  const waitAt = run.ticks.get(WAIT_PHASE_ID)
  const huntAt = run.ticks.get('skill.hunt#aim')
  ok('  第一个技能照常先放（前摇进过了）', boltAt !== undefined, [...run.ticks.keys()].join(' '))
  ok('  然后进等待', waitAt !== undefined && boltAt !== undefined && waitAt > boltAt,
    `${String(boltAt)} → ${String(waitAt)}`)
  ok('  再之后才是第二个技能', huntAt !== undefined && waitAt !== undefined && huntAt > waitAt,
    `${String(waitAt)} → ${String(huntAt)}`)
}

section('47. 等待确实让后面的技能晚 X 秒（和有 / 没有等待对照）')

{
  /** 一次施法里，等待和第二个技能各自进入的那一 tick */
  function startTicks(tech: Technique): { wait?: number, hunt?: number } {
    const { w, me } = quietWorld()
    const { compiled } = compileProbe(tech)
    registerTechnique(w, compiled)
    const run = phaseTicksOf(w, me, compiled)
    return { wait: run.ticks.get(WAIT_PHASE_ID), hunt: run.ticks.get('skill.hunt#aim') }
  }

  /*
   * ⚠ 对照组用的是**同一份技能组合、同一个 `at`**，唯一差别是有没有那个等待副本
   *   （所以"晚了多少"只可能来自等待，不会来自别的字段）。
   */
  const without = startTicks({
    schemaVersion: 1, id: 'probe.wait-none', name: 'probe.wait-none', kind: 'magic', activation: 'press',
    sequences: [{ name: '一段', skills: ['skill.magic-bolt', 'skill.hunt'] }],
  })
  const oneAndHalf = startTicks(waitTechnique('probe.wait-15', ['skill.magic-bolt', 'skill.hunt'],
    { seconds: 1.5, at: 1 }))

  ok('没有等待时：第二个技能紧接着就开始了（没有那一段）',
    without.hunt !== undefined && without.wait === undefined, JSON.stringify(without))
  ok('有 1.5 秒等待时：它确实晚了',
    oneAndHalf.hunt !== undefined && without.hunt !== undefined && oneAndHalf.hunt > without.hunt,
    `${String(without.hunt)} → ${String(oneAndHalf.hunt)}`)

  /*
   * ⚠ 把"晚了多少"和"那一段有多长"对上：等待是 1.5 秒，
   *   而它是**插在第二个技能之前**的 ⇒ 第二个技能开始的时刻应当正好推迟
   *   那一段的长度（±2 tick 的容差：`dt` 离散化 + "先进阶段再累计时长"那一步）。
   *   直接用**秒**换算成 tick，而不是写死一个帧数：
   *   帧数取决于 `world.dt`，而玩家说的那句话是"秒"。
   */
  const delayedTicks = (oneAndHalf.hunt ?? 0) - (without.hunt ?? 0)
  const expectedTicks = 1.5 / DEFAULT_DT
  ok(`  晚了约 1.5 秒（${String(Math.round(delayedTicks))} tick，期望约 ${String(Math.round(expectedTicks))}）`,
    Math.abs(delayedTicks - expectedTicks) <= 2,
    `实际 ${String(delayedTicks)}，期望 ${String(expectedTicks)}`)
}

section('48. 等待期间不能继续释放技能 / 术式（施法者被占用）')

{
  const { w, me } = quietWorld()
  /*
   * ⚠ 2026-09-30（日志 54）：`locks` 从 `['cast', 'attack']` 改成 `['move']` ——
   *   玩家把"施法独占"改成了**引擎硬规矩**，所以这一节拦住那两下的
   *   **不再是锁**，而是引擎自己（`hasRunningCast` ⇒ 原因 `busy`）。
   *   这一节要证的结论**没变**（等待期间放不出别的），变的是**它靠什么成立**：
   *   所以下面把"以前靠锁"那两条断言换成了"现在锁里根本没有 cast、照样拦得住"。
   */
  const tech = waitTechnique('probe.wait-busy', ['skill.magic-bolt'],
    { seconds: 1.5, locks: ['move'], interrupt: 'none' })
  const { compiled } = compileProbe(tech)
  registerTechnique(w, compiled)

  const first = pressSequence(w, me, compiled, { facing: { x: 0, y: 1 } })
  ok('第一下放出来了', first.ok === true, String(first.reason ?? ''))

  // 推到等待里（魔法飞弹前摇 0.3 秒，给 30 tick 绰绰有余）
  advance(w, 30)
  const mine = w.casts.filter(c => c.casterId === me.id)
  eq('  现在正在放的是那一段等待', mine[0]?.technique.phases[mine[0].phaseIndex]?.id, WAIT_PHASE_ID)
  ok('  阶段锁里有「移动」（玩家定的默认）',
    phaseLocksOf(w, me).includes('move'), phaseLocksOf(w, me).join(','))
  ok('  ⚠ 锁里**没有**「施法」—— 施法独占不靠锁（引擎硬规矩）',
    !phaseLocksOf(w, me).includes('cast'), phaseLocksOf(w, me).join(','))

  /*
   * ⚠ "不能继续释放技能 / 术式"的判据分**两层**，这里两层都测：
   *
   *   ① `canActivate` 说"不行，原因是**正在施法**"（`busy`）—— 这是**引擎的判据**。
   *      ⚠ 2026-09-30（日志 54）**原因从 `locked` 变成 `busy`**：以前是那个
   *      `locks: ['cast']` 参数（"被锁着"），现在是**施法独占**这条硬规矩。
   *      玩家的行为规定变了，所以这条断言的**期望值**跟着变（不是把它放宽）。
   *   ② 真按下去：**不会起新施法** —— 它进的是**缓冲**（"放的过程中再按只缓冲"，
   *      日志 49 那条规矩），而不是被静默丢掉。
   *
   *   ⚠ 只测 ② 是不够的：`pressSequence` 对"任何正在放的时候"都会走缓冲，
   *     所以它通过**不能**证明施法独占生效了（把硬规矩去掉它照样通过）。
   *     只测 ① 也不够：那是"读了个判断"，没证明按键这一路真的没放出去。
   */
  const lockedOut = canActivate(w, me, compiled)
  eq('  引擎的判据：现在放不了它，原因是「正在施法」', lockedOut, 'busy')

  const startedBefore = castsStartedBy(w, me.id)
  const again = pressSequence(w, me, compiled, { facing: { x: 0, y: 1 } })
  ok('  同一门术式按下去：**没有**新的施法起（只进了缓冲，不是静默丢掉）',
    again.ok === true && again.buffered === true && castsStartedBy(w, me.id) === startedBefore,
    JSON.stringify({ ok: again.ok, buffered: again.buffered, reason: again.reason }))

  const other = compileProbe({
    schemaVersion: 1, id: 'probe.wait-other', name: '别的术式', kind: 'magic', activation: 'press',
    skills: ['skill.magic-bolt'],
  }).compiled
  registerTechnique(w, other)
  const otherStartBefore = castsStartedBy(w, me.id)
  const otherPress = pressSequence(w, me, other, { facing: { x: 0, y: 1 } })
  ok('  换一门**别的**术式：一样被拦住（"不能继续释放术式"，原因是正在施法）',
    otherPress.ok === false && otherPress.reason === 'busy' && castsStartedBy(w, me.id) === otherStartBefore,
    JSON.stringify({ ok: otherPress.ok, reason: otherPress.reason }))
}

section('49. 锁哪些能力跟着参数走（只剩移动 / 转身；施法与攻击是引擎硬规矩）')

{
  /*
   * ⚠ 玩家定的：**"锁哪些能力"是这个零件的参数** —— 所以这一节要证明
   *   "参数真的接上了"：同一份术式、同一个副本，换参数就换行为。
   *
   * ⚠⚠ 2026-09-30（日志 54）**口径改了两处**（玩家改的行为，不是我们放宽断言）：
   *   ① 可勾项从四项收窄到 **`move` / `turn`** —— `cast` / `attack` 是
   *      **引擎硬规矩**（施法独占），不再由零件配；
   *   ② 默认值从 `['cast', 'attack']` 改成 **`[]`（一个都不锁：能走、能转身）**。
   *      ⚠ 中间我一度取过 `['move']`（"站住"）—— 那是**我猜的**，
   *      玩家 2026-09-30 当场裁掉：他原来那句"**但能走**"里的前两项现在由引擎
   *      保证 ⇒ 参数只剩移动 / 转身 ⇒ 默认就该是**都不锁**。
   *   ⇒ "默认能走：速度没被动过"那条老断言**回来了**（对照组换成"只锁移动"）。
   */
  const { w, me } = quietWorld()
  const dCompiled = compileProbe(waitTechnique('probe.wait-locks-default', ['skill.magic-bolt'])).compiled
  registerTechnique(w, dCompiled)
  pressSequence(w, me, dCompiled, { facing: { x: 0, y: 1 } })
  advance(w, 30)

  eq('默认参数：锁里**一个都没有**（能走、也能转身）', phaseLocksOf(w, me).length, 0)
  ok('  ⚠ 默认参数里**没有** cast / attack —— 它们不是可配项（引擎硬规矩）',
    !phaseLocksOf(w, me).includes('cast') && !phaseLocksOf(w, me).includes('attack'),
    phaseLocksOf(w, me).join(','))

  /*
   * ⚠ `move` 是 `applyPhaseLocks` 真的**执行**的那一档（速度归零）——
   *   所以这一条不是"读了个字段"，是"引擎真的没拦人"。
   */
  me.vel.x = 3
  me.vel.y = 3
  applyPhaseLocks(w)
  ok('  默认能走、能转身：速度没被动过', me.vel.x === 3 && me.vel.y === 3, `${me.vel.x},${me.vel.y}`)

  // ---- 换成"只锁移动" ⇒ 走不动（参数真的管事）----
  const { w: w2, me: me2 } = quietWorld()
  const mCompiled = compileProbe(
    waitTechnique('probe.wait-locks-move', ['skill.magic-bolt'], { seconds: 1.5, locks: ['move'], interrupt: 'none' }),
  ).compiled
  registerTechnique(w2, mCompiled)
  pressSequence(w2, me2, mCompiled, { facing: { x: 0, y: 1 } })
  advance(w2, 30)

  ok('  换成"只锁移动"：锁里没有 move 以外的东西（参数真的管事）',
    phaseLocksOf(w2, me2).join(',') === 'move', phaseLocksOf(w2, me2).join(','))
  me2.vel.x = 3
  me2.vel.y = 3
  applyPhaseLocks(w2)
  ok('  引擎真的把速度归零了（不是只读了个字段）', me2.vel.x === 0 && me2.vel.y === 0,
    `${me2.vel.x},${me2.vel.y}`)

  /*
   * ⚠⚠ **这一条是玩家 2026-09-30（日志 54）亲自改掉的行为**，老断言在这里
   *   钉的正好相反：
   *
   *     老断言（已删）：
   *       · '  不锁施法时：别的术式**能**插进来（引擎今天的行为，待玩家裁定）'
   *       · '  而原来那段等待**照样在跑**（插招不会把它打断 —— 两段同时在放）'
   *
   *   玩家的裁定已经下来了 —— **施法独占是引擎硬规矩**（原话："玩家又没有
   *   第二人格"）：同一个人同一时刻只能有一段进行中的施法，
   *   **和 `locks` 里有没有 cast 无关**（"不锁施法"这条路今天根本不存在了：
   *   零件里写 `cast` 会被校验器报错）。
   *   ⇒ 所以这里换成**相反**的一组断言：插不进来、永远只有一段在跑。
   */
  const other = compileProbe({
    schemaVersion: 1, id: 'probe.wait-insert', name: '插进来的招', kind: 'magic', activation: 'press',
    skills: ['skill.magic-bolt'],
  }).compiled
  registerTechnique(w2, other)
  const startedBeforeInsert = castsStartedBy(w2, me2.id)
  const inserted = pressSequence(w2, me2, other, { facing: { x: 0, y: 1 } })
  ok('  施法独占：别的术式**插不进来**（原因是正在施法）',
    inserted.ok === false && inserted.reason === 'busy'
    && castsStartedBy(w2, me2.id) === startedBeforeInsert,
    JSON.stringify({ ok: inserted.ok, reason: inserted.reason, n: castsStartedBy(w2, me2.id) }))
  eq('  施法者手上永远只有**一段**进行中的施法',
    w2.casts.filter(c => c.casterId === me2.id).length, 1)
  ok('  也没有任何打断发生（拒绝 ≠ 打断正在跑的那一段）',
    !w2.events.some(e => e.type === 'castInterrupted'),
    JSON.stringify(w2.events.map(e => e.type)))
}

section('50. 默认不可打断（挨打不消失）—— 以及可打断配置下真的会消失')

{
  /*
   * ⚠ 玩家定的（原话："我觉得默认不可打断更合适"，默认 = `InterruptLevel` 的 `'none'`）。
   *   理由：可打断会让"晚 X 秒"当场消失，后面的技能反而**提前**打出来 ——
   *   那不是打断，是**把排好的序列顺序改掉了**。
   *
   * ⚠ 这一节的两半**互为对照**：默认那一半证明"挨打不消失"，
   *   改参数那一半证明"这个参数真的在管事"（而不是"引擎根本不看它"）——
   *   只测一半的话，"参数没接线"也能让默认那一半通过。
   */
  function runWithDamage(interrupt: string): {
    ticks: Map<string, number>
    interrupted: boolean
    hpLost: number
  } {
    const { w, me } = quietWorld()
    const tech = waitTechnique('probe.wait-hit', ['skill.magic-bolt', 'skill.hunt'],
      { seconds: 1.5, locks: ['move'], interrupt, at: 1 })
    const { compiled } = compileProbe(tech)
    registerTechnique(w, compiled)

    const hp0 = getStored(me, 'char.hp.current')
    pressSequence(w, me, compiled, { facing: { x: 0, y: 1 } })
    const ticks = new Map<string, number>()
    let interrupted = false
    for (let i = 0; i < 400; i++) {
      /*
       * ⚠ 挨打要掐在**等待里**：等待是第 0 个阶段（`at: 0` ⇒ 它在 0.3 秒的前摇
       *   **之前**就开始等），所以前 30 tick 一定落在等待里。
       *   每 tick 都打 —— 只要那段等待还活着，"这一段挨了打"就成立。
       */
      if (i < 30) dealDamage(w, me.id, me.id, 5, { damageType: 'arcane' })
      stepWorld(w)
      for (const ev of w.events) {
        if (ev.type === 'castPhase') ticks.set(ev.phaseId, w.tick)
        if (ev.type === 'castInterrupted') interrupted = true
      }
      if (w.casts.filter(c => c.casterId === me.id).length === 0) break
    }
    return { ticks, interrupted, hpLost: hp0 - getStored(me, 'char.hp.current') }
  }

  const hard = runWithDamage('none')
  ok('伤害真的打到了（不是被免掉：掉血 150）', hard.hpLost === 150, String(hard.hpLost))
  ok('  默认不可打断：整段施法**一次都没被打断**', hard.interrupted === false)
  ok('  而且后面那个技能照样打出来了（"晚 X 秒"没有变成"不放了"）',
    hard.ticks.get('skill.hunt#aim') !== undefined, [...hard.ticks.keys()].join(' '))
  ok('  顺序仍然是 等待 → 猎杀',
    (hard.ticks.get(WAIT_PHASE_ID) ?? 0) < (hard.ticks.get('skill.hunt#aim') ?? 0),
    [...hard.ticks.keys()].join(' '))

  const soft = runWithDamage('damage')
  ok('  反例（显式改成"挨打就断"）：这一次**真的被打断了**', soft.interrupted === true)
  ok('  于是后面那个技能一次都没开始（玩家要避免的正是它）',
    soft.ticks.get('skill.hunt#aim') === undefined, [...soft.ticks.keys()].join(' '))
}

section('51. X 的范围 0.2 ~ 3 被夹住')

{
  /** 编译一份只有一个等待的术式，看它最终插进去多少秒 */
  function waitCompiled(seconds: number): ReturnType<typeof compileProbe> {
    return compileProbe(waitTechnique('probe.wait-range', ['skill.magic-bolt'], { seconds }))
  }

  /*
   * ⚠ 上限住在**原型**里（`content/modifiers/wait.json` 的 `params.max` = 3）——
   *   编译期把它夹住，而且**夹了要说出来**（手改的存档绕过校验器直接进世界）。
   *   下限 0.2 那一头玩家说死了（不像上限那样说"默认"）。
   */
  const over = waitCompiled(12)
  eq('要 12 秒 → 编译期报一条问题（说清楚被夹到了范围里）', over.problems.length, 1)
  ok('  而且它说的是范围 [0.2, 3]',
    (over.problems[0]?.message ?? '').includes('[0.2, 3]'), over.problems[0]?.message ?? '')
  eq('  编译产物里记的秒数被夹到 **3**', over.compiled.segments?.[0]?.mods?.[0]?.waitSeconds, 3)
  eq('  插进去的那一段也正好 3 秒', over.compiled.segments?.[0]?.technique.phases[0]?.duration, 3)

  const under = waitCompiled(0.05)
  eq('要 0.05 秒 → 编译期报一条问题', under.problems.length, 1)
  eq('  秒数被夹到下限 **0.2**', under.compiled.segments?.[0]?.mods?.[0]?.waitSeconds, 0.2)

  const justRight = waitCompiled(1.5)
  const justRightSeconds = justRight.compiled.segments?.[0]?.mods?.[0]?.waitSeconds
  eq('范围内的值（1.5）原样保留，一条问题都不报',
    `${String(justRight.problems.length)} / ${String(justRightSeconds)}`, '0 / 1.5')
  const lowerEdge = waitCompiled(0.2)
  const lowerSeconds = lowerEdge.compiled.segments?.[0]?.mods?.[0]?.waitSeconds
  ok('下限那一头是**闭区间**（0.2 原样保留、不报问题）',
    lowerEdge.problems.length === 0 && lowerSeconds === 0.2,
    `${String(lowerEdge.problems.length)} / ${String(lowerSeconds)}`)
  const upperEdge = waitCompiled(3)
  const upperSeconds = upperEdge.compiled.segments?.[0]?.mods?.[0]?.waitSeconds
  ok('上限那一头也是闭区间（3 原样保留、不报问题）',
    upperEdge.problems.length === 0 && upperSeconds === 3,
    `${String(upperEdge.problems.length)} / ${String(upperSeconds)}`)
}

// ============================================================================
//  「排布」零件 —— 2026-09-30 日志 53
// ============================================================================
//
// ⚠⚠ 这一节有**两条断言是硬界线**，它们比"三种类型各自生效"更要紧：
//   · **排布不改份数**（第 52 节 ②）—— 玩家明确划的第一条线；
//   · **排布不改瞄准**（第 53 节）—— 第二条线：意图照旧一个。

/**
 * 造一份**带排布**的测试术式（一段、若干个真技能、可以再挂一个份数副本）。
 *
 * ⚠ 和 `groupTechnique` 分开的理由和 `waitTechnique` 一样：排布的参数形状
 *   和份数**不是一套**（修饰技能参数异构），硬塞进去会让那个辅助函数
 *   长出一个"看 proto 决定参数键"的分支。
 */
function layoutTechnique(
  id: string,
  skills: string[],
  layoutParams: Record<string, unknown>,
  extra: Array<{ proto: string, count: number, at?: number }> = [],
): Technique {
  return {
    schemaVersion: 1,
    id,
    name: id,
    kind: 'magic',
    activation: 'press',
    sequences: [{
      name: '一段',
      skills: [...skills],
      mods: [
        ...extra.map(m => ({ proto: m.proto, at: m.at ?? 0, params: { count: m.count } })),
        { proto: 'mod.layout', at: 0, params: layoutParams },
      ],
    }],
  }
}

/**
 * 从**瞄准方向**（单位向量）量到"这一份实际朝哪"的**有符号角度**（度，逆时针为正）。
 *
 * ⚠ 测试里**允许**用 `Math.atan2`（purity 只扫 `src/sim/**`）——
 *   而且这里就该用它：断言要的是"转了多少度"这个**几何事实**，
 *   和被测的那张查表（`rotate2`）共用一个实现的话，两边会一起错。
 *   ⚠ 这也是"环绕不会用三角函数"那条纪律的对照物：被测代码不许用，测试可以。
 */
function angleBetweenDeg(
  from: { x: number, y: number },
  to: { x: number, y: number },
): number {
  const cross = from.x * to.y - from.y * to.x
  const dot = from.x * to.x + from.y * to.y
  return (Math.atan2(cross, dot) * 180) / Math.PI
}

section('52. 排布 · 环绕生成：把已经存在的那几份铺在施法者周围一圈')

{
  const { w, me } = quietWorld()
  const tech = layoutTechnique(
    'probe.layout-ring',
    ['skill.magic-bolt'],
    { type: 'ring', radius: 2, startAngle: 0, even: true },
    [{ proto: 'mod.split', count: 3 }],
  )
  const { compiled, problems } = compileProbe(tech)
  eq('编译没有报问题', problems.length, 0)
  /*
   * ⚠ 编译产物里记的是**摆法的参数**（编译期读好、夹好）——
   *   运行时不再查原型表（和 `count` / `waitSeconds` 同一条纪律）。
   */
  eq('  编译期读好了摆法', compiled.segments?.[0]?.mods?.[1]?.layout?.mode, 'ring')
  eq('  半径按参数记下', compiled.segments?.[0]?.mods?.[1]?.layout?.radius, 2)
  registerTechnique(w, compiled)

  /*
   * ---- ① ⚠⚠ **硬界线一：排布不改份数** ----
   *
   * 份数是「一分为 X」给的 3 份。装了排布之后**还是 3 份** ——
   * 这条断言是这一节的门闩：如果哪天有人在 `layoutPlanOf` 里
   * 顺手按份数做了点什么（或者让排布自己去凑份数），它会当场红。
   * ⚠ 判据是**编译产物里的份数列表**（`groupPlanOf`）+ **真的起了几个施法**，
   *   两个都数 —— 只看一个的话"计划对了但执行时多起了一个"会溜过去。
   */
  const seg0 = compiled.segments?.[0]
  if (seg0 === undefined) throw new Error('编译产物里没有第 0 段')
  const plan = groupPlanOf(seg0)
  eq('⚠ 装了排布之后，份数列表**还是 3 项**（排布不管份数）',
    plan?.skillIndices.length, 3)

  const r = pressSequence(w, me, compiled, { facing: { x: 0, y: 1 } })
  ok('按一下放出来了', r.ok === true, String(r.reason ?? ''))
  eq('  而且**只起了 3 个施法**（和没有排布时逐位相同）', castsStartedBy(w, me.id), 3)

  const mine = w.casts.filter(c => c.casterId === me.id)
  eq('  三个施法都在跑', mine.length, 3)

  /*
   * ---- ② 三份均分在半径 2 米的那一圈上 ----
   *
   * 基准朝向是"朝上" (0, 1)，`startAngle` = 0，`even` = true
   * ⇒ 三份分别在 0° / 120° / 240°（相对瞄准方向，逆时针）。
   * ⚠ 断言用**极坐标事实**（离施法者多远 + 相对瞄准方向多少度），
   *   而不是常数坐标 —— 后者会把"表里那一格是多少"抄进测试，改表就全红。
   */
  const posOf = (c: { aimPoint?: { x: number, y: number } }): { x: number, y: number } =>
    c.aimPoint ?? { x: 0, y: 0 }
  const angles = mine
    .map(c => angleBetweenDeg({ x: 0, y: 1 }, posOf(c)))
    .map(a => Math.round(((a % 360) + 360) % 360))
    .sort((a, b) => a - b)
  ok('  三份的方位是 0° / 120° / 240°（绕瞄准方向均分整圈）',
    angles.length === 3 && angles[0] === 0 && Math.abs((angles[1] ?? 0) - 120) <= 1
    && Math.abs((angles[2] ?? 0) - 240) <= 1,
    angles.join(' / '))

  const radii = mine.map(c => {
    const p = posOf(c)
    return Math.round(Math.sqrt(p.x * p.x + p.y * p.y) * 1000) / 1000
  })
  ok('  三份离施法者的距离都等于半径 2 米（±0.02：查表是 5 度一格）',
    radii.every(v => Math.abs(v - 2) <= 0.02), radii.join(' / '))

  /*
   * ⚠ **第 1 份落在"朝瞄准方向 2 米"处** —— 这条是"环绕没有改瞄准"的落点版：
   *   玩家瞄哪儿，最前面那一份就在那个方向上（只是提前了 2 米长出来）。
   */
  const first = mine[0]
  const fp = first === undefined ? { x: 0, y: 0 } : posOf(first)
  ok('  第 1 份正好在"朝瞄准方向 2 米"处（瞄准的方向没有被改）',
    Math.abs(fp.x) <= 0.02 && Math.abs(fp.y - 2) <= 0.02, `${String(fp.x)} , ${String(fp.y)}`)
}

section('52b. 排布 · 环绕对"从施法者身上长出来的载体"什么都不做（2026-09-30 日志 61）')

{
  /*
   * ⚠⚠ 用户 2026-09-30 定的：**载体是从施法者身上长出来的**
   *   （`meleeArc` / `self` / `aura` / `beam` / `capsule`）⇒ 「环绕」**什么都不做**。
   *
   *   为什么：环绕做的唯一一件事是"把**载体中心**摆到半径 R 的那一圈上"
   *   （`LayoutPlacement.point` ⇒ `cast.aimPoint`），而这些载体的中心**就是
   *   施法者**（"长在他身上"）—— 给它们一个圈上的位置没有意义。
   *
   *   ⚠ **是"什么都不做"，不是警告**（用户明确划的）：照「追踪」/「弹射」那条
   *     规矩 —— "这个修饰对这条序列不起作用"由**界面**画在那条序列下方，
   *     引擎不出声（所以这一节一条 `problems` / 事件都不断言）。
   *   ⚠ 判据**只有一处**：`school.ts` 的 `carrierFliesInWorld`
   *     （编译期读好放进 `layout.carrierFlies`）—— 这里只钉**它的后果**。
   */

  // ---- ① 编译期就把判据读好了（近战扇形 = 不飞；投射物 = 飞）----
  const melee = layoutTechnique(
    'probe.layout-ring-melee',
    ['skill.cleave'],
    { type: 'ring', radius: 2, startAngle: 0, even: true },
    [{ proto: 'mod.split', count: 3 }],
  )
  const meleeRes = compileProbe(melee)
  eq('① 编译没有报问题（"不起作用"不是错，校验器那边也不出声）', meleeRes.problems.length, 0)
  eq('① 近战扇形（meleeArc）的载体**不会飞** ⇒ 环绕对它不适用',
    meleeRes.compiled.segments?.[0]?.mods?.[1]?.layout?.carrierFlies, false)

  const flyRes = compileProbe(layoutTechnique(
    'probe.layout-ring-fly',
    ['skill.magic-bolt'],
    { type: 'ring', radius: 2, startAngle: 0, even: true },
  ))
  eq('① 对照：投射物会飞 ⇒ 环绕照旧适用',
    flyRes.compiled.segments?.[0]?.mods?.[0]?.layout?.carrierFlies, true)

  /*
   * ---- ② 运行时：那 3 份**一处都没被改** ----
   *
   *   判据用两个"改没改"的标志：
   *     · `aimPoint` 有没有 ⇒ 落点有没有被挪（环绕唯一的出口）；
   *     · `facing` 是不是**瞄准方向**本身 ⇒ 朝向有没有被转（环绕同时会给径向朝向）。
   *   ⚠ 两份都要数：只数落点的话，"环绕不挪点、但把三份的朝向转开了"
   *     这种半生效会溜过去 —— 而玩家看到的正是"近战还是散开了"。
   */
  const { w, me } = quietWorld()
  registerTechnique(w, meleeRes.compiled)
  const r = pressSequence(w, me, meleeRes.compiled, { facing: { x: 0, y: 1 } })
  ok('② 按一下放出来了', r.ok === true, String(r.reason ?? ''))
  const mine = w.casts.filter(c => c.casterId === me.id)
  eq('② 还是 3 份（环绕不生效 ≠ 不改份数 —— 份数是「一分为 X」给的）', mine.length, 3)
  ok('② 三份的落点**一个都没挪**（aimPoint 一个都没有）',
    mine.every(c => c.aimPoint === undefined),
    mine.map(c => JSON.stringify(c.aimPoint)).join(' | '))
  ok('② 三份的朝向**也没有被转**（都还是"瞄准方向"）',
    mine.every(c => Math.abs(c.facing.x) < 1e-9 && Math.abs(c.facing.y - 1) < 1e-9),
    mine.map(c => JSON.stringify(c.facing)).join(' | '))

  /*
   * ---- ③ 对照：**只有「环绕」那一档**被拦住 ----
   *
   *   `fan` 改的是**方向**，而"长在施法者身上"的载体照样转得动
   *   （一记横扫本来就该能散射）—— 所以同一个近战技能 + 扇形散射，
   *   三份的朝向必须**真的不一样**。
   *   ⚠ 这一条是"别把整个零件一起关掉"的门闩。
   */
  const { w: w2, me: me2 } = quietWorld()
  const fanRes = compileProbe(layoutTechnique(
    'probe.layout-fan-melee',
    ['skill.cleave'],
    { type: 'fan', radius: 2, even: true, spread: 90 },
    [{ proto: 'mod.split', count: 3 }],
  ))
  eq('③ 编译没有报问题', fanRes.problems.length, 0)
  registerTechnique(w2, fanRes.compiled)
  const r2 = pressSequence(w2, me2, fanRes.compiled, { facing: { x: 0, y: 1 } })
  ok('③ 按一下放出来了', r2.ok === true, String(r2.reason ?? ''))
  const fanDirs = w2.casts
    .filter(c => c.casterId === me2.id)
    .map(c => Math.round(angleBetweenDeg({ x: 0, y: 1 }, c.facing)))
    .sort((a, b) => a - b)
  ok('③ 扇形散射照旧生效：三份是 −45° / 0° / +45°（只有环绕被拦住）',
    fanDirs.length === 3 && fanDirs[0] === -45 && Math.abs(fanDirs[1] ?? 99) <= 0.5
    && fanDirs[2] === 45,
    fanDirs.join(' / '))
}

section('53. 排布 · 扇形散射 / 反向镜像：只改方向，落点一个字都不动')

{
  /*
   * ---- ① 扇形散射：几份**以瞄准方向为中心**散开 ----
   *
   * 张角 90 度、3 份 ⇒ -45° / 0° / +45°（相对瞄准方向）。
   */
  const { w, me } = quietWorld()
  const tech = layoutTechnique(
    'probe.layout-fan',
    ['skill.magic-bolt'],
    { type: 'fan', spread: 90 },
    [{ proto: 'mod.split', count: 3 }],
  )
  const { compiled } = compileProbe(tech)
  registerTechnique(w, compiled)
  const r = pressSequence(w, me, compiled, { facing: { x: 0, y: 1 } })
  ok('扇形：按一下放出来了', r.ok === true, String(r.reason ?? ''))

  const mine = w.casts.filter(c => c.casterId === me.id)
  eq('  仍然是 3 份（散射不改份数）', mine.length, 3)

  const fangs = mine
    .map(c => Math.round(angleBetweenDeg({ x: 0, y: 1 }, c.facing)))
    .sort((a, b) => a - b)
  ok('  三份的朝向是 -45° / 0° / +45°（以瞄准方向为中心）',
    fangs.length === 3 && Math.abs((fangs[0] ?? 0) + 45) <= 1 && fangs[1] === 0
    && Math.abs((fangs[2] ?? 0) - 45) <= 1,
    fangs.join(' / '))

  /*
   * ⚠⚠ **硬界线二：排布不改瞄准** —— 散射这一档最简单：
   *   落点（`aimPoint`）**一个都没有**（"只是把已经存在的那几份摆到不同方向"）。
   *   `aimPoint` 是"载体中心被钉住"的唯一标志，所以"没有它"就是"落点没被动"。
   */
  ok('⚠ 散射**没有**改任何一份的落点（aimPoint 一个都没有）',
    mine.every(c => c.aimPoint === undefined),
    mine.map(c => JSON.stringify(c.aimPoint)).join(' | '))

  /*
   * ⚠ 而且**意图只有那一个**：三份的 `targetId` 都和"没有排布"时一样
   *   （这里意图是 `direction`，本来就没有锁定目标 ⇒ 三份都不该凭空锁一个）。
   */
  ok('  三份都没有凭空多出一个锁定目标（意图照旧那一个）',
    mine.every(c => c.targetId === undefined),
    mine.map(c => String(c.targetId)).join(' | '))
}

{
  /*
   * ---- ② 反向镜像：同时朝反方向也来一份 ----
   *
   * 2 份 ⇒ 第 1 份照原样（0°）、第 2 份转 180° + `mirrorAngle`（默认 0）。
   */
  const { w, me } = quietWorld()
  const tech = layoutTechnique(
    'probe.layout-mirror',
    ['skill.magic-bolt'],
    { type: 'mirror', mirrorAngle: 0 },
    [{ proto: 'mod.split', count: 2 }],
  )
  const { compiled } = compileProbe(tech)
  registerTechnique(w, compiled)
  const r = pressSequence(w, me, compiled, { facing: { x: 0, y: 1 } })
  ok('镜像：按一下放出来了', r.ok === true, String(r.reason ?? ''))

  const mine = w.casts.filter(c => c.casterId === me.id)
  eq('  2 份（镜像不加份数：要几份归「一分为 X」）', mine.length, 2)
  const mangs = mine
    .map(c => Math.round(angleBetweenDeg({ x: 0, y: 1 }, c.facing)))
    .sort((a, b) => a - b)
  ok('  两份的朝向正好相差 180°（0° 和 180°）',
    mangs.length === 2 && mangs[0] === 0 && Math.abs((mangs[1] ?? 0) - 180) <= 1,
    mangs.join(' / '))
  ok('  而且两份都**没有**改落点（镜像也只改方向）',
    mine.every(c => c.aimPoint === undefined),
    mine.map(c => JSON.stringify(c.aimPoint)).join(' | '))
}

{
  /*
   * ---- ③ `mirrorAngle` 这个参数真的接上了 ----
   *
   * 玩家的规格里这一档的参数是"**无或偏移角**"：默认 0 = 正反方向，
   * 写了值就是"镜像轴歪一点"。⚠ 判据是"第 2 份相对第 1 份差多少"**而不是**
   * "绝对朝向" —— 后者会把辅助函数的实现细节抄进测试。
   */
  const { w, me } = quietWorld()
  const tech = layoutTechnique(
    'probe.layout-mirror-offset',
    ['skill.magic-bolt'],
    { type: 'mirror', mirrorAngle: 30 },
    [{ proto: 'mod.split', count: 2 }],
  )
  const { compiled } = compileProbe(tech)
  registerTechnique(w, compiled)
  pressSequence(w, me, compiled, { facing: { x: 0, y: 1 } })
  const mine = w.casts.filter(c => c.casterId === me.id)
  const a0 = mine[0] === undefined ? { x: 0, y: 0 } : mine[0].facing
  const a1 = mine[1] === undefined ? { x: 0, y: 0 } : mine[1].facing
  const diff = Math.round(((angleBetweenDeg(a0, a1) % 360) + 360) % 360)
  ok('mirrorAngle = 30 → 第 2 份相对第 1 份差 210°（180 + 30）',
    Math.abs(diff - 210) <= 1, String(diff))
}

section('54. 排布 · 环绕的参数：起始角 / 是否均匀（都跟着参数走）')

{
  /*
   * ---- ① `startAngle` 把整圈**转过去** ----
   *     起始角 90°、3 份 ⇒ 90° / 210° / 330°（相对瞄准方向）。
   */
  const { w, me } = quietWorld()
  const tech = layoutTechnique(
    'probe.layout-ring-start',
    ['skill.magic-bolt'],
    { type: 'ring', radius: 2, startAngle: 90, even: true },
    [{ proto: 'mod.split', count: 3 }],
  )
  const { compiled } = compileProbe(tech)
  eq('编译期把起始角记下了', compiled.segments?.[0]?.mods?.[1]?.layout?.startAngle, 90)
  registerTechnique(w, compiled)
  pressSequence(w, me, compiled, { facing: { x: 0, y: 1 } })
  const mine = w.casts.filter(c => c.casterId === me.id)
  const angles = mine
    .map(c => Math.round(((angleBetweenDeg({ x: 0, y: 1 }, c.aimPoint ?? { x: 0, y: 0 }) % 360) + 360) % 360))
    .sort((a, b) => a - b)
  ok('起始角 90 → 方位是 90° / 210° / 330°（整圈被转过去了）',
    angles.length === 3 && Math.abs((angles[0] ?? 0) - 90) <= 1
    && Math.abs((angles[1] ?? 0) - 210) <= 1 && Math.abs((angles[2] ?? 0) - 330) <= 1,
    angles.join(' / '))

  /*
   * ---- ② `even: false`（不均匀）⇒ 全都摆在起始角**那一条射线**上 ----
   *
   * ⚠ 这是"是否均匀分布"这个开关**关掉时**的定义（写在 `layout.json` 的
   *   `_even` 里）：不是"随机散开"（随机不可重放），而是"挤在同一束"。
   */
  const uneven = quietWorld()
  const tech2 = layoutTechnique(
    'probe.layout-ring-uneven',
    ['skill.magic-bolt'],
    { type: 'ring', radius: 2, startAngle: 0, even: false },
    [{ proto: 'mod.split', count: 3 }],
  )
  const c2 = compileProbe(tech2).compiled
  eq('编译期把"不均匀"记下了', c2.segments?.[0]?.mods?.[1]?.layout?.even, false)
  registerTechnique(uneven.w, c2)
  pressSequence(uneven.w, uneven.me, c2, { facing: { x: 0, y: 1 } })
  const mine2 = uneven.w.casts.filter(c => c.casterId === uneven.me.id)
  ok('不均匀 → 三份的方位**全是 0°**（挤在同一束，不是随机散开）',
    mine2.length === 3
    && mine2.every(c => {
      const a = ((angleBetweenDeg({ x: 0, y: 1 }, c.aimPoint ?? { x: 0, y: 0 }) % 360) + 360) % 360
      return a <= 1 || a >= 359
    }),
    mine2.map(c => String(Math.round(angleBetweenDeg({ x: 0, y: 1 }, c.aimPoint ?? { x: 0, y: 0 })))).join(' / '))
}

section('55. 排布 · 半径 / 角度被夹住（范围住在原型里，夹了会说）')

{
  /*
   * ⚠ 上限住在**原型**里（`content/modifiers/layout.json` 的
   *   `params.maxRadius` = 6 / `maxAngle` = 180 / `maxSpread` = 360）——
   *   编译期把它夹住，而且**夹了要说出来**（手改的存档绕过校验器直接进世界）。
   *   ⚠ 夹是**兜底**，判据在校验器（`weapons.ts` 那一节）——
   *   两者都**不许**是"静默地夹一下算了"。
   */
  const over = compileProbe(layoutTechnique('probe.layout-over',
    ['skill.magic-bolt'], { type: 'ring', radius: 99 }))
  eq('半径要 99 米 → 编译期报一条问题', over.problems.length, 1)
  ok('  而且它说的是范围 [0.5, 6]',
    (over.problems[0]?.message ?? '').includes('[0.5, 6]'), over.problems[0]?.message ?? '')
  eq('  编译产物里的半径被夹到 **6**', over.compiled.segments?.[0]?.mods?.[0]?.layout?.radius, 6)

  const under = compileProbe(layoutTechnique('probe.layout-under',
    ['skill.magic-bolt'], { type: 'ring', radius: 0.01 }))
  eq('半径要 0.01 米 → 编译期报一条问题', under.problems.length, 1)
  eq('  被夹到下限 **0.5**', under.compiled.segments?.[0]?.mods?.[0]?.layout?.radius, 0.5)

  const angle = compileProbe(layoutTechnique('probe.layout-angle',
    ['skill.magic-bolt'], { type: 'ring', radius: 2, startAngle: 9999 }))
  eq('起始角要 9999 度 → 报一条问题', angle.problems.length, 1)
  const angleStart = angle.compiled.segments?.[0]?.mods?.[0]?.layout?.startAngle
  ok('  被夹到 **180**（角度上限在原型里）', Math.abs((angleStart ?? 0) - 180) < 1e-9, String(angleStart))

  const spread = compileProbe(layoutTechnique('probe.layout-spread',
    ['skill.magic-bolt'], { type: 'fan', spread: 100000 }))
  eq('张角要 100000 度 → 报一条问题', spread.problems.length, 1)
  eq('  被夹到 **360**', spread.compiled.segments?.[0]?.mods?.[0]?.layout?.spread, 360)

  const fine = compileProbe(layoutTechnique('probe.layout-fine',
    ['skill.magic-bolt'], { type: 'ring', radius: 3, startAngle: -45, even: true }))
  eq('范围内的值（半径 3 / 起始角 -45）原样保留，一条问题都不报',
    `${String(fine.problems.length)} / ${String(fine.compiled.segments?.[0]?.mods?.[0]?.layout?.radius)}`
    + ` / ${String(fine.compiled.segments?.[0]?.mods?.[0]?.layout?.startAngle)}`,
    '0 / 3 / -45')

  /*
   * ⚠ **认不出的摆法**：编译期报一条问题，而且 `layout` **整块缺席** ——
   *   于是运行时**什么都不做**（不是猜一个默认摆法）。
   *   "我选了反向镜像，它给我排了个圈"是静默改语义，不是兜底。
   */
  const bad = compileProbe(layoutTechnique('probe.layout-bad-type',
    ['skill.magic-bolt'], { type: 'circle' }))
  eq('摆法写成别的东西 → 编译期报一条问题', bad.problems.length, 1)
  ok('  而且编译产物里**没有** layout（引擎不猜摆法）',
    bad.compiled.segments?.[0]?.mods?.[0]?.layout === undefined,
    JSON.stringify(bad.compiled.segments?.[0]?.mods?.[0]?.layout ?? null))

  const badWorld = quietWorld()
  const badCompiled = bad.compiled
  registerTechnique(badWorld.w, badCompiled)
  const rr = pressSequence(badWorld.w, badWorld.me, badCompiled, { facing: { x: 0, y: 1 } })
  ok('  按下去**照样放得出技能**（只是没有排布）', rr.ok === true, String(rr.reason ?? ''))
  eq('  而且它一个施法都没多（份数还是那个份数）', castsStartedBy(badWorld.w, badWorld.me.id), 1)
  const only = badWorld.w.casts.filter(c => c.casterId === badWorld.me.id)
  ok('  落点一个都没挪（认不出摆法 ⇒ 什么都不做）',
    only.every(c => c.aimPoint === undefined), only.map(c => JSON.stringify(c.aimPoint)).join('|'))
}

section('56. 排布 · 只有 1 份时什么都不做（待裁定的那一档）')

{
  /*
   * ⚠ 规格说的是"把**已经存在的那几份**分布在周围"，而 1 份"分布"无从谈起。
   *   这一片**不做任何事**（`members < 2` 早退），而不是"凭空给第一份挪个位置"
   *   —— 后者是**自己定规矩**。它是**待裁定项**（日志 53 报告第 6 节 a）：
   *   玩家要"只有一份也摆到半径上"的话，改的是那一个早退条件。
   *
   * ⚠ 这条断言把**今天的行为**钉住，所以将来改它必须是有意识的。
   */
  const { w, me } = quietWorld()
  const tech = layoutTechnique(
    'probe.layout-single',
    ['skill.magic-bolt'],
    { type: 'ring', radius: 4, even: true },
  )
  const { compiled, problems } = compileProbe(tech)
  eq('编译没有报问题', problems.length, 0)
  registerTechnique(w, compiled)
  const r = pressSequence(w, me, compiled, { facing: { x: 0, y: 1 } })
  ok('按一下放出来了（1 份）', r.ok === true, String(r.reason ?? ''))
  eq('  只有 1 个施法', w.casts.filter(c => c.casterId === me.id).length, 1)
  ok('  落点**没有**被挪到半径 4 米上（1 份时不摆开）',
    w.casts.filter(c => c.casterId === me.id).every(c => c.aimPoint === undefined),
    w.casts.map(c => JSON.stringify(c.aimPoint)).join(' | '))
}

section('57. 施法独占：等待里那一刀也砍不出来（武器攻击就是绑在左键上的术式）')

{
  /*
   * ⚠⚠ 玩家 2026-09-30（日志 54）把"边等边砍"这条堵死了，理由是他自己给的那句：
   *     > 武器攻击也是绑在左键上的术式 → 它也是施法。
   *
   *   这一节用的是**出厂内容**那条路：`tech.iron-sword-basic`（铁剑的左键，
   *   一段横砍）—— 不是测试现造的探针，所以它证明的是"玩家真的会遇到的那一下"。
   *   `pressSequence` 就是客户端左键调的那一个函数。
   */
  const { w, me } = quietWorld()
  const wait = compileProbe(
    waitTechnique('probe.solo-wait', ['skill.magic-bolt'], { seconds: 1.5, locks: ['move'], interrupt: 'none' }),
  ).compiled
  registerTechnique(w, wait)

  const sword = lookup('tech.iron-sword-basic')
  ok('出厂那条左键术式查得到（铁剑普攻）', sword !== undefined)
  if (sword === undefined) throw new Error('内容里没有 tech.iron-sword-basic')
  registerTechnique(w, sword)

  const first = pressSequence(w, me, wait, { facing: { x: 0, y: 1 } })
  ok('等待那一下放出来了', first.ok === true, String(first.reason ?? ''))
  advance(w, 30)
  eq('  现在正在放的是那一段等待',
    w.casts.filter(c => c.casterId === me.id)[0]?.technique.phases[0]?.id, WAIT_PHASE_ID)

  const started = castsStartedBy(w, me.id)
  const swing = pressSequence(w, me, sword, { facing: { x: 1, y: 0 } })
  ok('⚠ 等待里按左键：那一刀**砍不出来**（原因是正在施法）',
    swing.ok === false && swing.reason === 'busy', JSON.stringify({ ok: swing.ok, reason: swing.reason }))
  eq('  也没有起第二段施法（不是"两段同时在跑"）', castsStartedBy(w, me.id), started)
  eq('  施法者手上仍然只有那一段', w.casts.filter(c => c.casterId === me.id).length, 1)

  /*
   * ⚠ 对照：等待**放完之后**那一刀必须砍得出来 ——
   *   否则上面那条只能证明"左键坏了"，证明不了"那一段还没放完"。
   */
  advance(w, 200)
  eq('  等待放完了', w.casts.filter(c => c.casterId === me.id).length, 0)
  const swing2 = pressSequence(w, me, sword, { facing: { x: 1, y: 0 } })
  ok('  这时候左键照旧能砍（拒绝的是"还没放完"，不是左键本身）',
    swing2.ok === true, JSON.stringify({ ok: swing2.ok, reason: swing2.reason }))
}

section('58. 施法独占只管玩家的手指 —— 引擎内部的延续 / 反射不受它管')

{
  /*
   * ⚠⚠ **玩家 2026-09-30（日志 54）亲口划的边界**（原话）：
   *     > "施法独占"管的是**玩家的手指**，不是**引擎内部的延续**。
   *
   *   两类豁免（都在 `ActivateOptions` 里）：
   *     · `sameActivation` —— 同一次激活的第 2..N 份（份数类修饰，日志 51 就有）；
   *     · **`engineInternal`** —— 触发器链条 / 监测器的被动反射，
   *       **只有 `sim/trigger.ts` 的 `fireModifier` 会填**。
   *
   *   ⚠ 不豁免的后果是**静默的**：玩家在施法中途跨过危险线，撑盾那一下被
   *     `busy` 吞掉、盾**永远不挂**，一个提示都没有 —— 等于把日志 48
   *     那一整套机制废掉，而玩家报不出这个 bug。
   *
   *   这一节把三件事钉在一起（缺一条都证不了"边界划对了"）：
   *     ① 玩家按键 → **被拒**
   *     ② 触发器链条（施法途中挂上常驻 → 它的 onCast 触发器）→ **照常打得出来**
   *     ③ 被动反射（施法途中跨低血线 → 监测器撑盾）→ **照常触发**
   */
  const { w, me } = quietWorld()

  /*
   * "我正在施法"这件事用一段**不会自己结束**的施法来造：
   * 贯日的蓄力段是 `duration: -1`（由 `releaseCharge` 结束，不自动推进），
   * 所以它**稳定地**停在"手上有一段"这个状态里，不受 tick 数影响。
   */
  const channel = lookup('tech.charged-laser')
  if (channel === undefined) throw new Error('内容库里没有 tech.charged-laser')
  registerTechnique(w, channel)

  const hold = pressSequence(w, me, channel, { facing: { x: 1, y: 0 } })
  ok('先把人放进"正在施法"（贯日蓄力，不会自己结束）', hold.ok === true, String(hold.reason ?? ''))
  eq('  手上有一段正在放的', w.casts.filter(c => c.casterId === me.id).length, 1)

  // ---- ① 玩家按出来的那一下 → 被拒 ----
  const bolt = lookup('tech.magic-bolt')
  if (bolt === undefined) throw new Error('内容库里没有 tech.magic-bolt')
  registerTechnique(w, bolt)
  const hand = pressSequence(w, me, bolt, { facing: { x: 0, y: 1 } })
  ok('① 玩家按键：被拒（原因是正在施法）',
    hand.ok === false && hand.reason === 'busy', JSON.stringify({ ok: hand.ok, reason: hand.reason }))
  eq('  没有起第二段（独占生效）', w.casts.filter(c => c.casterId === me.id).length, 1)

  // ---- ② 触发器链条：施法途中挂上常驻 → onCast 触发器照常放技能 ----
  /*
   * ⚠⚠ 这里的条件是**显式写的一个真条件**（2026-09-30 日志 54，玩家两轮裁定的口径）：
   *   · 触发器点名的**默认条件**是「**载体（前一个魔法）消失**」（Noita 那种**引信**），
   *     它要的时机（`onExpire` / `onRemoved`）**日志 55 已经接上线**了；
   *   · 而这份原型的旧版写着 `condition: {}` —— 空对象在求值器里**恒假**
   *     ⇒ 出厂零件**自己就是坏的**（永不触发、而且一声不吭），日志 54 才查出来；
   *   · ⇒ 现在：**不写条件 = 「载体消失」**（那条默认值，日志 55 起真的会触发），
   *     显式写 `{}` 才报错（`MODIFIER_EMPTY_CONDITION`）。
   *
   * ⚠⚠ **这一节测的是 `onCast` 那条路，所以 `when` 必须显式写出来**：
   *   日志 55 把原型的 `when` 默认值改成了 `onExpire`（"载体消失"那一档），
   *   而 `when` 的读法是"副本优先、原型兜底"（`compile.ts`）——
   *   不写的话这个探针会落到 `onExpire` 上，于是**挂载时不再触发**
   *   （`onExpire` 要等载体消失，而这里故意没让载体活过挂载那一刻）。
   *   ⇒ 这里和下面那条 `condition` 一样，是**显式钉住这一节要测的那个时机**。
   */
  setStored(me, 'char.hp.current', 250)   // quietWorld 的 hp.max = 500 ⇒ 50%
  const passive = compileProbe({
    schemaVersion: 1, id: 'probe.solo-mount-trigger', name: 'probe.solo-mount-trigger',
    kind: 'magic', activation: 'auto',
    sequences: [{
      name: '一段',
      skills: ['skill.magic-bolt'],
      // ⚠ `origin: 'caster'` 显式写出来：挂载这一刻没有"瞄准意图"，
      //   靠原型默认的 `aim` 会退回施法者身上（结果一样），写出来是为了**确定**。
      mods: [{
        proto: 'mod.trigger.on-cast',
        at: 0,
        params: {
          when: 'onCast',
          origin: 'caster',
          condition: { type: 'hpBelow', who: 'self', value: 1 },
        },
      }],
    }],
  })
  eq('② 那份常驻探针编译没有报问题', passive.problems.length, 0)
  registerTechnique(w, passive.compiled)

  const beforeTrigger = castsStartedBy(w, me.id)
  setTechniqueActive(w, me, passive.compiled.id, true)
  ok('② 施法途中挂上常驻术式：它的 onCast 触发器**照常触发**',
    w.events.some(e => e.type === 'modifierTriggered'),
    JSON.stringify(w.events.map(e => e.type))
    + ' 被挡住的原因：' + JSON.stringify(w.events.filter(e => e.type === 'castBlocked').map(e => e.reason)))
  eq('  而且真的起了一次新施法（施法独占不管引擎内部的延续）',
    castsStartedBy(w, me.id), beforeTrigger + 1)
  eq('  手上现在是两段（外层的蓄力 + 被触发的那一个）',
    w.casts.filter(c => c.casterId === me.id).length, 2)

  /*
   * ---- ③ 被动反射：施法途中跨过低血线 → 监测器照常撑盾（出场那条「背水」）----
   *
   * ⚠ 走的是**出厂内容**那条路（`tech.last-stand` = 监测器副本 + 撑盾技能），
   *   和这一节上面两半用的是同一套豁免。
   */
  const { w: w2, roster } = arenaWorld()
  const you = roster.get('你')!
  mount(w2, you, 'tech.last-stand')

  const max = resolveAttribute(you, 'char.hp.max', { world: w2, self: you })
  setStored(you, 'char.hp.current', Math.ceil(max * 0.35))   // 刚好在低血线之上

  const channel2 = lookup('tech.charged-laser')
  if (channel2 === undefined) throw new Error('内容库里没有 tech.charged-laser')
  registerTechnique(w2, channel2)
  const hold2 = pressSequence(w2, you, channel2, { facing: { x: 1, y: 0 } })
  ok('③ 先进入"正在施法"', hold2.ok === true, String(hold2.reason ?? ''))
  eq('  手上有一段正在放的', w2.casts.filter(c => c.casterId === you.id).length, 1)

  const foe = roster.get('剑奴')!
  dealDamage(w2, foe.id, you.id, Math.ceil(max * 0.1))       // 掉到 25%，跨过去了
  ok('③ 施法途中跨过危险线：监测器**照常触发**',
    w2.events.some(e => e.type === 'modifierTriggered'),
    JSON.stringify(w2.events.map(e => e.type)))
  eq('  撑盾那一下起了新施法（被动反射不受施法独占管）',
    w2.casts.filter(c => c.casterId === you.id).length, 2)
}

// ---------------------------------------------------------------- 55. 载体消失（引信）
//
// ⚠ 这一节测的是**玩家点名的那条默认值**（2026-09-30 日志 55）：
//   上一次施法放出去的**那个东西**（投射物 / 落点区域 / 屏障 / 召唤物）
//   消失 / 到期 / 被打掉的那一刻 → 触发挂在那个技能上的触发器副本
//   （Noita 那种**引信**）。
//
// ⚠⚠ 两条纪律，各测一遍（它们和"没目标就不发生"是同一条）：
//   · **载体真的消失** ⇒ 触发（时间可控：投射物飞完 `delivery.lifetime`）；
//   · **一个载体都没有长过** ⇒ **什么都不发生**（不许猜、不许退化成"立刻触发"）。

section('55. 载体消失：上一次放出去的那个东西没了，才轮到后面那个技能')

{
  /*
   * 探针：一段、两个技能，第一个技能（`skill.magic-bolt`）上挂一个触发器副本。
   *
   * ⚠⚠ **这个副本一个字都不写 `condition`，也一个字都不写 `when`** ——
   *   这正是玩家点名的默认值：「**载体消失**」。
   *   · 不写 `when` ⇒ 落到原型的默认 `onExpire`（"失效 / 结束"那一档）；
   *   · 不写 `condition` ⇒ 驱动的时机就是"**载体没了**"。
   *   ⚠ 这一节因此**同时钉住**了三件事：默认 `when`（内容）
   *     + 默认条件的语义（`carrierGoneConditionsOf`）
   *     + 载体台账真的记上了（`recordCarrier`）。少任何一件，下面的断言都不响。
   */
  const fuse = compileProbe({
    schemaVersion: 1, id: 'probe.carrier-fuse', name: 'probe.carrier-fuse',
    kind: 'magic', activation: 'press',
    sequences: [{
      name: '一段',
      skills: ['skill.magic-bolt', 'skill.impact-burst'],
      mods: [{ proto: 'mod.trigger.on-cast', at: 0, params: { origin: 'prevEndPoint' } }],
    }],
  })
  eq('① 探针编译没有报问题', fuse.problems.length, 0)

  /** 一颗子弹飞多久（`content/skills/magic-bolt.json` 的 `delivery.lifetime`，秒） */
  const BOLT_LIFETIME = 1.5
  /*
   * ⚠⚠ `advance(world, n)` 走的是 **tick 数**，不是秒（`world.ts` 的 `advance`
   *   就是"连跑 n tick"）。一秒 = `1 / DEFAULT_DT` = 60 tick。
   *   ⚠ 这一条踩过：把秒当 tick 传进去，时间只走了 1/60，
   *   于是"子弹还没飞出去"——而断言会以**误导人的方式**失败
   *   （看起来像"载体台账没记上"）。
   */
  const TICKS_PER_SECOND = 60

  // ---- ① 载体**到期** ⇒ 触发 ----
  const { w, me } = quietWorld()
  registerTechnique(w, fuse.compiled)

  const press = pressSequence(w, me, fuse.compiled, { facing: { x: 1, y: 0 } })
  ok('① 按下第一段：放出去了', press.ok === true, String(press.reason ?? ''))
  const castId = press.cast?.id
  ok('  手里有这一次施法的 id（载体台账靠它分组）', castId !== undefined, String(castId))

  /*
   * ⚠ 施法自己的 `cast` 阶段是 0.3 秒 —— 子弹在**阶段生效那一刻**才造出来，
   *   所以先推 0.4 秒（跨过它），此时子弹**已经在世界上飞**。
   */
  advance(w, Math.round(0.4 * TICKS_PER_SECOND))
  const bolt = w.entities.find(e => e.kind === 'projectile')
  ok('  子弹真的在世界上活着（这就是那个"会自己活着的载体"）',
    bolt !== undefined && bolt.alive, JSON.stringify(w.entities.map(e => e.kind)))

  eq('  ⚠ 子弹还在飞的时候：**一次都不触发**（引信还没烧到）', triggerEvents(w).length, 0)
  eq('  后面那个技能（爆裂）也一次都没起',
    w.events.filter(e => e.type === 'castStarted' && e.techniqueId === fuse.compiled.id).length, 0)

  /*
   * ⚠⚠ **一 tick 一 tick 地推到"引信烧断"那一刻**，而不是一把推过去。
   *
   *   为什么不能用 `advance(w, 200)`：`stepWorld` **每 tick 开头清空
   *   `world.events`**（顿帧 / 事件是"这一 tick 发生了什么"）——
   *   一把推过去之后，`modifierTriggered` 早就被后面那些 tick 清掉了，
   *   于是断言会看到"一次都没触发"。⚠ 这一条真踩过：结论一度是
   *   "载体台账没记上"，而真相是**测试看错了地方**。
   *
   *   时间账要算**两段**：施法自己的 `cast` 阶段（0.3 秒）先走完，
   *   子弹才被造出来 —— 它的 `lifetime` **从那一刻**才开始倒数。
   *   所以预算是 0.4（已推）+（0.3 + 1.5）+ 余量。
   */
  const budget = Math.round((0.3 + BOLT_LIFETIME + 0.7) * TICKS_PER_SECOND)
  let fuseTick = -1
  for (let i = 0; i < budget && fuseTick < 0; i++) {
    stepWorld(w)
    if (triggerEvents(w).length > 0) fuseTick = w.tick
  }

  ok('② 子弹到期了（不在世界上了）',
    w.entities.every(e => e.kind !== 'projectile' || !e.alive),
    JSON.stringify(w.entities.filter(e => e.kind === 'projectile').map(e => e.alive)))

  const fired = triggerEvents(w)
  eq('  载体消失那一刻：触发器**真的响了**', fired.length, 1)
  /*
   * ⚠ 事件里报的是**段**那一份的 id（`probe.carrier-fuse.seq0`），
   *   不是容器（`probe.carrier-fuse`）—— 因为驱动它的那份术式是段的产物
   *   （`fireModifier` 的 `who.technique`）。用 `startsWith` 而不是相等，
   *   免得把"哪一层"这件事钉死在测试里（那是引擎的内部形状）。
   */
  eq('  而且是挂在第一段那个技能上的那一份',
    fired[0] !== undefined && fired[0].techniqueId.startsWith(fuse.compiled.id), true)
  eq('  时机报的就是 onExpire（"失效 / 结束"那一档）',
    fired[0] !== undefined && fired[0].when === 'onExpire', true)
  ok('  ⚠ 而且是在**子弹飞完寿命之后**才响的（不是按下就响）',
    fuseTick > Math.round(0.4 * TICKS_PER_SECOND), `触发于第 ${fuseTick} tick`)
  ok('  触发出来的那个技能**真的起了施法**（引信接上了后面那一段）',
    w.casts.some(c => c.technique.id.includes(fuse.compiled.id)),
    JSON.stringify(w.casts.map(c => c.technique.id)))

  // 再推一段：载体早就没了，**不该**每 tick 都重新发现一次
  let repeats = 0
  for (let i = 0; i < 2 * TICKS_PER_SECOND; i++) {
    stepWorld(w)
    repeats += triggerEvents(w).length
  }
  eq('  ⚠ 之后不再重复触发（"消失"是一个瞬间，不是一个状态）', repeats, 0)

  // ---- ② 载体**被打掉**（不是到期）⇒ 同样触发 ----
  /*
   * ⚠ 之所以要单独测一遍："载体消失"的判据是 `alive`
   *   （`mod-state.ts` 的 `allCarriersGone`），而"到期"和"被打掉"是
   *   **两条不同的代码路径**（`tickLifetime` 的倒计时 / `tickProjectiles`
   *   撞墙那一支）。只测一条的话，另一条坏了没人知道。
   */
  const knocked = quietWorld()
  registerTechnique(knocked.w, fuse.compiled)
  const press2 = pressSequence(knocked.w, knocked.me, fuse.compiled, { facing: { x: 1, y: 0 } })
  ok('③ 第二局：按下第一段', press2.ok === true, String(press2.reason ?? ''))
  advance(knocked.w, Math.round(0.4 * TICKS_PER_SECOND))
  const bolt2 = knocked.w.entities.find(e => e.kind === 'projectile')
  ok('  子弹在飞', bolt2 !== undefined && bolt2.alive, '')
  if (bolt2 !== undefined) {
    /*
     * 直接把它"打掉"（`alive = false`）—— 这和撞墙那一支做的是**同一次状态变更**
     *   （`projectile.ts` 里撞墙就是把 `alive` 置 false + 推一条 `removed` 事件）。
     * ⚠ 不用"真的摆一堵墙"是为了让这一节**不依赖屏障的几何** ——
     *   这里要证的是"alive 一翻，引信就烧"，屏障挡子弹是另一节的事。
     */
    despawn(knocked.w, bolt2, 'despawned')
    stepWorld(knocked.w)
    eq('  载体被打掉 ⇒ 触发器同样响了',
      knocked.w.events.filter(e => e.type === 'modifierTriggered').length, 1)
  }

  // ---- ③ 一次施法长出**好几个**载体：全部消失才算 ----
  /*
   * ⚠⚠ 这一节钉的是**待玩家裁定**的那条语义（`mod-state.ts` 的 `allCarriersGone`）：
   *
   *   一次施法可以长出**好几个**载体（`spawn` 载荷的 `count`）。
   *   两个候选语义都说得通，这一片选的是「**全部消失才算**」，
   *   理由写在那个函数头上（引信烧到最后一个 + 和既有的「份数」机制
   *   用同一个答案）—— **裁定下来只改那一个函数**。
   *
   * ⚠ 这一节**钉住的是"今天的答案"**，不是"正确答案"：
   *   它存在的意义是"改语义时这个测试会红"，逼着改的人去读那段理由。
   *
   * ⚠ 用**区域**而不是投射物：区域是 `spawn` 载荷那条路（另一档载体），
   *   顺带证明"投射物以外的那几档也记进台账了"。
   */
  /*
   * ⚠ 出厂那份 `skill.place-slow-field` 的 `count` 是 **1** —— 一次只长一个载体。
   *   要测"多个载体"，就得现造一份 `count: 2` 的（照抄出厂那份，只改一个数）：
   *   ⚠ **不改出厂数值**（玩家硬命令），所以变体只活在测试里。
   */
  const fieldBase = lib.skills.get('skill.place-slow-field')
  if (fieldBase === undefined) throw new Error('内容库里没有 skill.place-slow-field')
  const twoFieldSkill: Skill = {
    ...fieldBase,
    id: 'skill.probe-two-fields',
    name: '两片场（探针）',
    effect: [{
      id: 'e1',
      at: 'sow',
      then: [{
        target: 'self',
        payload: { kind: 'spawn', entityId: 'entity.slow-field', count: 2, lifetime: 1 },
      }],
    }],
  }
  const lookupWithTwo = (id: string): Skill | undefined =>
    id === twoFieldSkill.id ? twoFieldSkill : lib.skills.get(id)

  const twoFieldsDef: Technique = {
    schemaVersion: 1, id: 'probe.carrier-two', name: 'probe.carrier-two',
    kind: 'magic', activation: 'press',
    sequences: [{
      name: '一段',
      skills: [twoFieldSkill.id, 'skill.impact-burst'],
      mods: [{ proto: 'mod.trigger.on-cast', at: 0, params: { origin: 'prevEndPoint' } }],
    }],
  }
  const twoFields = compileTechnique(twoFieldsDef, lookupWithTwo, {
    bloodPactCost: 0,
    modifiers: lib.modifiers,
  })
  eq('⑤ 两载体探针编译没有报问题', twoFields.problems.length, 0)

  const pair = quietWorld()
  registerTechnique(pair.w, twoFields.compiled)
  const press4 = pressSequence(pair.w, pair.me, twoFields.compiled, { facing: { x: 1, y: 0 } })
  ok('⑤ 按下：放出去了', press4.ok === true, String(press4.reason ?? ''))
  // 前摇 0.5 秒 → 再给一点余量
  advance(pair.w, Math.round(0.8 * TICKS_PER_SECOND))
  const areas = pair.w.entities.filter(e => e.kind === 'area')
  eq('  ⚠ 一次施法真的长出了**两个**载体（同一个 `count` 出来的）', areas.length, 2)
  eq('  两个都还在的时候：一次都不触发', triggerEvents(pair.w).length, 0)

  /*
   * 两个载体的 `lifetime` 一样（同一个 `spawn` 载荷给的）⇒ 它们会同 tick 到期。
   * 一 tick 一 tick 推到引信烧断。
   */
  const budget2 = Math.round(4 * TICKS_PER_SECOND)
  let fuseTick2 = -1
  for (let i = 0; i < budget2 && fuseTick2 < 0; i++) {
    stepWorld(pair.w)
    if (triggerEvents(pair.w).length > 0) fuseTick2 = pair.w.tick
  }
  eq('  两个载体都不在了',
    pair.w.entities.filter(e => e.kind === 'area' && e.alive).length, 0)
  eq('  ⚠ 全部消失 ⇒ 触发**一次**（不是每个载体各触发一次）',
    triggerEvents(pair.w).length, 1)
  ok('  而且是在两个都没了之后才响的', fuseTick2 > 0, `第 ${fuseTick2} tick`)

  // ---- ③ 一个载体都**没有长过** ⇒ 什么都不发生 ----
  /*
   * ⚠⚠ 这是玩家那条纪律里最要紧的一半：**找不到载体 → 什么都不发生**。
   *
   *   `skill.impact-burst` 是**瞬时载体**（放完当场结算，没有实体）——
   *   于是"这次施法长过载体"这件事压根没发生过（`carrierBegun` 为假）。
   *   ⚠ 这里**不许**退化成"立刻触发"：
   *     一个没有载体的技能如果也能点亮引信，那"引信"就没意义了
   *     （它在按下的那一瞬间就烧完了），而玩家写 `origin: prevEndPoint`
   *     会指向一个**从来不存在**的失效位置。
   */
  const instant = compileProbe({
    schemaVersion: 1, id: 'probe.carrier-none', name: 'probe.carrier-none',
    kind: 'magic', activation: 'press',
    sequences: [{
      name: '一段',
      skills: ['skill.impact-burst', 'skill.magic-bolt'],
      mods: [{ proto: 'mod.trigger.on-cast', at: 0, params: { origin: 'prevEndPoint' } }],
    }],
  })
  const none = quietWorld()
  registerTechnique(none.w, instant.compiled)
  const press3 = pressSequence(none.w, none.me, instant.compiled, { facing: { x: 1, y: 0 } })
  ok('④ 瞬时载体的技能：按下去照样放得出来', press3.ok === true, String(press3.reason ?? ''))

  advance(none.w, 5 * TICKS_PER_SECOND)
  eq('  ⚠ 一个载体都没长过 ⇒ 一次都不触发（不许猜、不许"立刻触发"）',
    none.w.events.filter(e => e.type === 'modifierTriggered').length, 0)
  eq('  世界也干干净净：没有多出任何实体', none.w.entities.filter(e => e.kind === 'projectile').length, 0)
}

// ------------------------------------------------- 生成位置 `aim`（日志 62）

section('55b. 生成位置 `aim`：取**那次施法**的意图（取不到 ⇒ 什么都不做）')

{
  const TICKS_PER_SECOND = 60

  /*
   * 玩家 2026-09-30（日志 62）选的是**丙**（按他的原话复述）：
   *   > 触发器的「生成在瞄准的位置」= 取**按下技能那一刻**的瞄准
   *   > —— **不是**实时的鼠标位置（那要新增每帧输入通道 + 联机同步，**以后再说**）
   *   > **取不到 ⇒ 什么都不做**（和"没目标就不发生"同一条纪律）
   *   > —— **不许**退化成"最近敌人"
   *
   * ⇒ 两条路各测一遍（这正是"取得到 / 取不到"的分界）：
   *   · ① 「载体消失」那条路**手里有**那次施法（台账记着）⇒ 意图真的传下去；
   *   · ② 监测器 / 挂载那条路**没有**"那一次施法" ⇒ 一样都不传（那一档不生效）。
   *
   * ⚠⚠ **"什么都不做"说的是"那一档不生效"**（既不钉落点、也不钉方向），
   *   **不是"不触发"** —— 被触发的技能照旧放出来（和「环绕」/「追踪」对
   *   非飞行载体"什么都不做"是同一条读法：零件不生效，技能照跑）。
   *   ⇒ ② 里必须**同时**断言"触发器照常响"（否则"什么都不做"会因为
   *     "整个触发器坏了"而假装通过）。
   */

  // ---- ① 载体消失：`origin: 'aim'` 取到的是**那次施法**的意图（落点 + 方向）----
  /*
   * ⚠ 为什么现造一份技能变体：出厂那份 `skill.magic-bolt` 是 `directional`
   *   （它**没有落点**，`cast.aimPoint` 只在 `areapoint` 那类技能上才有），
   *   而这一半要看的正是落点。⇒ 只把**瞄准方式**改成 `areapoint`（range 8），
   *   别的字段一个都不动（⚠ 出厂数值一个都不许改：变体只活在测试里，
   *   和上面那份 `count: 2` 的探针是同一条路）。
   *   ⚠ `valid` 原样留着 `['enemy']`：这一条技能的载荷是打敌人的，
   *     `target: 'self'` 那类动作会撞上"没目标就什么都不发生"（日志 61）——
   *     那样连载体都长不出来，这一节测的就变成了别的东西。
   * ⚠ 它是**投射物**（会飞、有实体）⇒ 飞完 `lifetime` 就消失，
   *   引信烧断正是"载体消失"（日志 55）。
   */
  const boltBase = lib.skills.get('skill.magic-bolt')
  if (boltBase === undefined) throw new Error('内容库里没有 skill.magic-bolt')
  const aimBoltSkill: Skill = {
    ...boltBase,
    id: 'skill.probe-aim-bolt',
    name: '朝着点飞的那一发（探针）',
    targeting: { mode: 'areapoint', valid: ['enemy'], range: 8 },
  }
  const lookupAim = (id: string): Skill | undefined =>
    id === aimBoltSkill.id ? aimBoltSkill : lib.skills.get(id)
  /*
   * ⚠ 不写 `when` / 不写 `condition` ⇒ 走玩家点名的默认值「载体消失」（日志 55）。
   * ⚠⚠ **被触发的那个技能 = 这一段的第一份**（`at: 0` ⇒ `skillIds[0]`）——
   *   所以这里只摆一个技能：它自己长载体、载体消失时又把自己放一遍（引信）。
   */
  const aimFuseDef: Technique = {
    schemaVersion: 1, id: 'probe.aim-fuse', name: 'probe.aim-fuse',
    kind: 'magic', activation: 'press',
    sequences: [{
      name: '一段',
      skills: [aimBoltSkill.id],
      mods: [{ proto: 'mod.trigger.on-cast', at: 0, params: { origin: 'aim' } }],
    }],
  }
  const aimFuse = compileTechnique(aimFuseDef, lookupAim, {
    bloodPactCost: 0,
    modifiers: lib.modifiers,
  })
  eq('① 探针编译没有报问题', aimFuse.problems.length, 0)

  const { w, me } = quietWorld()
  /*
   * ⚠ 摆一个**最近的敌人**在 10 米外（`+x` 方向）：旧行为就是拿它的位置当落点，
   *   所以这一条越明显越好（新行为给的落点是 `(5,5)`，和它**不是一个地方**）。
   */
  spawn(w, {
    faction: 'enemy', pos: { x: 10, y: 0 }, base: { 'char.hp.max': 500, 'char.energy.max': 0 },
  })
  registerTechnique(w, aimFuse.compiled)
  /*
   * ⚠ 意图给的是**鼠标那一个点**（日志 47 的口径）—— 火墙那类 `areapoint`
   *   技能会把它钉成 `cast.aimPoint`，而方向由它推出来（`resolveAim` 里那一支）。
   */
  const pressAim = pressSequence(w, me, aimFuse.compiled, {
    intent: { kind: 'point', x: 5, y: 5 },
  })
  ok('① 按下了第一段（点着放的那片场）', pressAim.ok === true, String(pressAim.reason ?? ''))
  const pressedCast = pressAim.cast
  eq('  那一次施法真的钉住了一个落点（`areapoint` ⇒ `cast.aimPoint`）',
    `${String(pressedCast?.aimPoint?.x)},${String(pressedCast?.aimPoint?.y)}`, '5,5')

  /*
   * ⚠⚠ **按下之后把施法者的朝向改掉** —— 这就是"取按下那一刻的瞄准"与
   *   "取实时的"之间的**唯一**区别：意图不该跟着变。
   *   （新朝向 = `+x`，和那一次的意图方向 `(0.707, 0.707)` 明显不同。）
   */
  me.facing = { x: 1, y: 0 }

  const budget = Math.round(5 * TICKS_PER_SECOND)
  let fired: ReturnType<typeof createWorld>['casts'][number] | undefined
  for (let i = 0; i < budget && fired === undefined; i++) {
    stepWorld(w)
    if (triggerEvents(w).length > 0) {
      /*
       * ⚠ 被触发的那个技能 id 带一个 `#技能id` 后缀（`fireModifier` 拼的），
       *   而按下去那一次的 id 就是段自己的键 —— 靠这个把两者分开。
       */
      fired = w.casts.find(c => c.technique.id.includes('#'))
    }
  }
  ok('① 载体消失之后：触发器响了，而且**真的放出了**后面那个技能',
    fired !== undefined, JSON.stringify(w.casts.map(c => c.technique.id)))

  eq('  ⚠⚠ 落点 = **那次施法**指的那个点 (5,5)，**不是**最近的敌人 (10,0)（旧行为就是后者）',
    `${String(fired?.aimPoint?.x)},${String(fired?.aimPoint?.y)}`, '5,5')
  const intentFacing = pressedCast?.facing
  const firedFacing = fired?.facing
  ok('  ⚠⚠ 方向 = **那次施法**那一刻的方向（中途把施法者转向 +x 也不改）',
    intentFacing !== undefined && firedFacing !== undefined
    && Math.abs(firedFacing.x - intentFacing.x) < 1e-9
    && Math.abs(firedFacing.y - intentFacing.y) < 1e-9,
    `那次 ${JSON.stringify(intentFacing)} → 触发那次 ${JSON.stringify(firedFacing)}（施法者现在是 ${JSON.stringify(me.facing)}）`)

  // ---- ② 监测器 / 挂载那条路：**没有**"那一次施法" ⇒ 一样都不传 ----
  /*
   * ⚠ 这一半钉的是"**取不到就什么都不做**"：
   *   挂在身上的一份常驻术式，它的 `onCast` 触发器在**挂上那一刻**就跑一次
   *   （`runModifierOnEquip`）—— 那一刻**没有任何"那次施法"**
   *   （不是玩家按的，也没有载体）。
   * ⇒ `origin: 'aim'` 在这条路上**一档都不生效**：
   *   · 落点不由它决定（`cast.aimPoint` **一个都没有**）；
   *   · 方向不由它决定（照旧是技能自己那套：`directional` ⇒ 施法者当前朝向）。
   *   ⚠⚠ **尤其不许**退化成"最近的敌人"（旧行为：`contextOf().target`）——
   *     敌人就摆在 `+x` 10 米处，而施法者朝 `+y`，两种行为**一眼可分**。
   */
  const mount = quietWorld()
  mount.me.facing = { x: 0, y: 1 }
  /*
   * ⚠ `hpBelow ... value: 1` 在满血时**不成立**（`hpPercent` 是 0~1，
   *   满血 = 1，而判据是"**小于** 1"）⇒ 先把血扣到一半，条件才真的成立。
   *   ⚠ 这不是这一节的语义，纯粹是"让那个条件成立"——
   *     条件不成立的话这一节会因为"触发器压根没响"而**假通过**。
   */
  setStored(mount.me, 'char.hp.current', 250)
  spawn(mount.w, {
    faction: 'enemy', pos: { x: 10, y: 0 }, base: { 'char.hp.max': 500, 'char.energy.max': 0 },
  })
  const monitorAim = compileProbe({
    schemaVersion: 1, id: 'probe.aim-monitor', name: 'probe.aim-monitor',
    kind: 'magic', activation: 'auto',
    sequences: [{
      name: '一段',
      skills: ['skill.magic-bolt'],
      mods: [{
        proto: 'mod.trigger.on-cast',
        at: 0,
        params: {
          when: 'onCast',
          origin: 'aim',
          /*
           * ⚠ 条件**显式写**一个真条件（挂载那一刻求值）——
           *   不写的话它落到"载体消失"那条默认值上，而挂载这条路**不会**驱动那一档。
           */
          condition: { type: 'hpBelow', who: 'self', value: 1 },
        },
      }],
    }],
  })
  eq('② 常驻探针编译没有报问题', monitorAim.problems.length, 0)
  registerTechnique(mount.w, monitorAim.compiled)
  setTechniqueActive(mount.w, mount.me, monitorAim.compiled.id, true)

  const monitorCast = mount.w.casts.find(c => c.technique.id.includes('skill.magic-bolt'))
  ok('② 触发器**照常响**（"什么都不做"说的是那一档不生效，不是不触发）',
    monitorCast !== undefined, JSON.stringify(mount.w.casts.map(c => c.technique.id)))
  eq('  ⚠⚠ 落点**一个都没有**（`aim` 这一档什么都没做 ⇒ 没被钉住）',
    monitorCast?.aimPoint, undefined)
  const mountFacing = monitorCast?.facing
  ok('  ⚠⚠ 方向照旧是**技能自己那套**（施法者当前朝向 +y），不是那个 10 米外的敌人（+x）',
    mountFacing !== undefined && Math.abs(mountFacing.x) < 1e-9 && Math.abs(mountFacing.y - 1) < 1e-9,
    JSON.stringify(mountFacing))
}

// ---------------------------------------------------------------- 追踪（日志 56）

/**
 * 造一份**带追踪**的测试术式。
 *
 * ⚠ 和 `layoutTechnique` / `waitTechnique` 分开的理由一样：修饰技能**参数异构**，
 *   追踪的两个键（`turnRate` / `maxRange`）和别人的不是一套 ——
 *   硬塞进一个公用辅助函数会让它长出"看 proto 决定参数键"的分支。
 */
function homingTechnique(
  id: string,
  skills: string[],
  params: Record<string, unknown>,
  at = 0,
): Technique {
  return {
    schemaVersion: 1,
    id,
    name: id,
    kind: 'magic',
    activation: 'press',
    sequences: [{
      name: '一段',
      skills: [...skills],
      mods: [{ proto: 'mod.homing', at, params }],
    }],
  }
}

/** 这一 tick 里那颗子弹往哪个方向飞（单位向量；没有子弹就是 `undefined`） */
function boltDirOf(w: ReturnType<typeof createWorld>): { x: number, y: number } | undefined {
  const p = w.entities.find(e => e.kind === 'projectile' && e.alive)
  if (p === undefined) return undefined
  const len = Math.sqrt(p.vel.x * p.vel.x + p.vel.y * p.vel.y)
  if (len < 1e-9) return undefined
  return { x: p.vel.x / len, y: p.vel.y / len }
}

/** 把子弹朝**发射方向**偏了多少度（有符号，逆时针为正）—— ⚠ 测试里可以用 `atan2` */
function boltTurnDeg(d: { x: number, y: number }): number {
  return angleBetweenDeg({ x: 0, y: 1 }, d)
}

section('59. 追踪：被修饰的投射物自己找最近的敌人')

{
  const TICKS_PER_SECOND = 60

  // ---- ① 会飞的东西被追踪 → **真的拐向最近的那个敌人** ----
  const { w, me } = quietWorld()
  /*
   * 敌人在**斜前方**（离发射线 5 米远）：直着飞的子弹永远打不到它 ——
   * 所以"它后来被打中了"这件事**只可能**来自拐弯。
   *
   * ⚠⚠ **位置从 `(6,6)` 改成了 `(5,5)`**（2026-09-30 日志 62）：
   *   `maxRange` 现在是**索敌距离** —— 只在**发射那一刻**、以**发射点**为圆心量一次。
   *   施法者站在 `(0,0)`（子弹也生在这儿），所以：
   *     · `(6,6)` ⇒ 距离 **8.49 米 > 8 米** ⇒ 那一刻**锁定不了** ⇒ 这一发会一路直走；
   *     · `(5,5)` ⇒ 距离 **7.07 米 ≤ 8 米** ⇒ 锁得上，这条断言测的"它真的拐了"才成立。
   *   ⚠ 改的是**测试的几何**，不是参数（`maxRange` 还是 8）：语义一改，
   *     原来那个位置就从"锁得上"变成了"锁不上"。
   */
  const foe = spawn(w, {
    faction: 'enemy',
    pos: { x: 5, y: 5 },
    base: { 'char.hp.max': 200, 'char.energy.max': 0 },
  })

  const tech = homingTechnique(
    'probe.homing',
    ['skill.magic-bolt'],
    { turnRate: 12, maxRange: 8 },
  )
  const { compiled, problems } = compileProbe(tech)
  eq('编译没有报问题', problems.length, 0)
  /*
   * ⚠ 编译产物里记的是**飞出去之后怎么拐**那两个数（编译期读好、夹好）——
   *   运行时不再查原型表（和 `count` / `waitSeconds` / `layout` 同一条纪律）。
   */
  eq('  编译期读好了转速', compiled.segments?.[0]?.mods?.[0]?.homing?.turnRate, 12)
  eq('  编译期读好了搜索距离', compiled.segments?.[0]?.mods?.[0]?.homing?.maxRange, 8)
  registerTechnique(w, compiled)

  const press = pressSequence(w, me, compiled, { facing: { x: 0, y: 1 } })
  ok('按一下放出来了（朝正上方，敌人不在那条线上）', press.ok === true, String(press.reason ?? ''))

  // 前摇 0.3 秒 → 推 0.4 秒，子弹已经在飞
  advance(w, Math.round(0.4 * TICKS_PER_SECOND))
  const bolt = w.entities.find(e => e.kind === 'projectile' && e.alive)
  ok('  子弹真的在飞', bolt !== undefined, JSON.stringify(w.entities.map(e => e.kind)))

  /*
   * ⚠⚠ **判据用"要几个 tick 才转够 15 度"，不用"单 tick 转了多少度"。**
   *
   *   为什么：子弹在**出生后、我还没开始看**的那几个 tick 里已经在拐了，
   *   而且"这一步够不够"那一支可能让它**一次对准**（那一步可以很大）——
   *   所以"单 tick 转角"不是一个稳定的读数（第一版就栽在这儿：
   *   量到的第一格是 49 度，看着像"一 tick 直接贴上去"，其实只是它已经对准了）。
   *   ⇒ 量**累计**的 15 度花掉几个 tick：那个数**只能**由 `turnRate` 决定
   *     （2 度/tick 至少要 5 tick、30 度/tick 一两 tick 就够）。
   *   ⚠ 15 度是**相对发射方向**（正上方）量的，与敌人具体在哪儿无关 ——
   *     这条测试因此和几何解耦，只钉"参数真的在管事"。
   */
  let ticks = 0
  let turned15 = -1
  let turned30 = -1
  for (let i = 0; i < TICKS_PER_SECOND && turned30 < 0; i++) {
    stepWorld(w)
    ticks++
    const d = boltDirOf(w)
    if (d === undefined) break
    const deg = Math.abs(boltTurnDeg(d))
    if (turned15 < 0 && deg >= 15) turned15 = ticks
    if (turned30 < 0 && deg >= 30) turned30 = ticks
  }
  ok('  ⚠ 它真的拐了（3 秒之内转够了 15 度）', turned15 > 0, `第 ${String(turned15)} tick`)

  // ---- ② 拐过去之后**真的打中**了那个不在发射线上的敌人 ----
  const hp0 = getStored(foe, 'char.hp.current')
  let hitTick = -1
  for (let i = 0; i < 2 * TICKS_PER_SECOND && hitTick < 0; i++) {
    stepWorld(w)
    if (getStored(foe, 'char.hp.current') < hp0) hitTick = w.tick
  }
  ok('  ⚠ 拐过去之后**真的打中了**那个不在发射线上的敌人（直着飞永远打不到它）',
    getStored(foe, 'char.hp.current') < hp0,
    `HP ${String(hp0)} → ${String(getStored(foe, 'char.hp.current'))}`)
  ok('  而且是在飞了一会儿之后才打中的（不是出生就贴脸）', hitTick > 0, `第 ${hitTick} tick`)
  eq('  打中就消失（不穿透的子弹照旧）',
    w.entities.filter(e => e.kind === 'projectile' && e.alive).length, 0)
}

section('59b. 追踪 · 转速跟着参数走（同一个敌人、只改转速）')

{
  const TICKS_PER_SECOND = 60

  /**
   * 跑一局：**敌人在正右方 14 米**（离发射方向 90 度）、同一个技能，只换转速 ——
   * 数"相对发射方向转够 **45 度**花了几个 tick"。
   *
   * ⚠⚠ **为什么敌人要摆到 14 米**（第一版摆 6 米，栽过）：
   *   慢的那一档（2 度/tick）转 45 度要 20 多个 tick，而这段时间子弹要飞
   *   5 米以上 —— 敌人摆在 6 米时它**还在慢慢拐的过程中就撞上去了**，
   *   于是"转够 45 度"这件事压根没发生（那一条读数成了 -1）。
   *   ⇒ 距离必须大于"最慢那一档在转够 45 度之前飞过的距离"。
   *   ⚠ 14 米 ≤ 索敌距离 16 米（`maxRange`）⇒ **发射那一刻**就锁上了
   *     （2026-09-30 日志 62 起它只在那一刻量一次，之后一路咬着、不再重新搜）。
   *
   * ⚠⚠ **为什么阈值取 45 度**（第一版取 20 度，也栽过）：
   *   引擎有一条"**已经基本对准了就一次对准**"的收敛判据
   *   （`|dot| ≥ cos(5°)`，见 `sim/projectile.ts` 那段），它是**故意**的
   *   （不然子弹会在目标两侧打摆子）—— 但它意味着"最后那几度"可以一步到位。
   *   ⇒ 阈值必须离 90 度**足够远**：30 度/tick 要 2 tick、2 度/tick 要 20 多 tick。
   *   ⚠ 这**不是**测试为了好看而挑的姿势：真实的"甩不掉"场景就是侧后方来的目标。
   */
  function ticksToTurn45(turnRate: number): number {
    const { w, me } = quietWorld()
    spawn(w, {
      faction: 'enemy', pos: { x: 14, y: 0 }, base: { 'char.hp.max': 5000, 'char.energy.max': 0 },
    })
    const t = homingTechnique(
      `probe.homing-turn-${String(turnRate)}`,
      ['skill.magic-bolt'],
      { turnRate, maxRange: 16 },
    )
    const c = compileProbe(t)
    registerTechnique(w, c.compiled)
    pressSequence(w, me, c.compiled, { facing: { x: 0, y: 1 } })
    advance(w, Math.round(0.4 * TICKS_PER_SECOND))

    let n = 0
    for (let i = 0; i < TICKS_PER_SECOND; i++) {
      stepWorld(w)
      n++
      const d = boltDirOf(w)
      if (d === undefined) break
      if (Math.abs(boltTurnDeg(d)) >= 45) return n
    }
    return -1
  }

  /*
   * ⚠⚠ **慢的那一档用 2 度/tick —— 这正是当年被表的分辨率吃掉的那个值。**
   *
   *   整圈角度表原来是 **5 度一格**，`rotate2` 会把 `turnRate: 2` 吸成 **0 度**
   *   ⇒ 那一档的子弹**设了转速却完全直飞**（**静默失效**：参数看着生效、
   *   表现和"没装这个零件"一模一样）。玩家 2026-09-30 裁定把表**做细到 1 度**
   *   （`sim/targeting.ts` 的 `turnIndex`），于是 2 成了**真能表达**的刻度。
   *   ⇒ 这一条断言就是那次裁定的**门闩**：它必须真的拐（转够 45 度），
   *     而且必须**明显慢于** 30 度/tick 那一档。
   *   ⚠ 它在修复前会以"第 −1 tick"（= 一次都没转够）红，那正是我们要钉住的坏行为。
   */
  const slow = ticksToTurn45(2)
  const mid = ticksToTurn45(5)
  const fast = ticksToTurn45(30)
  /*
   * ⚠ 实测（1 度表 + 敌人正右方 14 米）：`2 → 23 tick`、`5 → 10`、`12 → 4`、`30 → 2`。
   *   理论下界 45 / 2 = 23 —— 实测**正好**是它（这一档余量大，
   *   "一次对准"那一步没赶上，所以是纯匀速 2 度/tick）。
   *   ⇒ 断言取 **≥ 15**：留够余量（别的参数一动就可能吃掉一两 tick），
   *     但远大于"一次对准"能做到的 1~2 tick ⇒ 它钉的仍然是"慢得下来"。
   *   ⚠ 不要取 1 度/tick：那一档转满 45 度要 44 tick，而子弹的
   *     `lifetime` 只有 1.5 秒（90 tick）—— 从这里发射飞不到那么久就过期了
   *     （实测：第 60 tick 才转到 43 度）。**这不是 bug**，是"太慢的追踪追不上"，
   *     正好说明这个参数是有意义的。所以测试用 2 度那一档。
   */
  ok('⚠⚠ 转速 2 度/tick：**真的拐了**（表做细到 1 度之前，它会被吸成 0 ⇒ 完全直飞）',
    slow > 0, `第 ${String(slow)} tick`)
  ok('  而且它明显慢（45 / 2 的理论下界是 23 tick）',
    slow >= 15, `第 ${String(slow)} tick`)
  ok('⚠ 转速 30 度/tick：两三 tick 就够（90 度里最后那几度会一次对准）',
    fast > 0 && fast <= 3, `第 ${String(fast)} tick`)
  ok('  转速越大拐得越快（2 → 5 → 30 单调）',
    slow > mid && mid > fast && fast > 0, `${String(slow)} / ${String(mid)} / ${String(fast)}`)
}

section('60. 追踪：找不到敌人就沿原发射方向直走（不许乱拐）')

{
  const TICKS_PER_SECOND = 60

  // ---- ① **没有**追踪副本的对照组：一条直线（证明上面那个拐弯是零件干的） ----
  const plain = quietWorld()
  spawn(plain.w, {
    faction: 'enemy', pos: { x: 6, y: 6 }, base: { 'char.hp.max': 200, 'char.energy.max': 0 },
  })
  /*
   * ⚠ 对照组用**同一份技能**（`skill.magic-bolt`）、同一个意图，只差一个副本 ——
   *   这样"拐了"和"没拐"之间**只有一个变量**。
   */
  const noMod = compileProbe({
    schemaVersion: 1, id: 'probe.homing-none', name: 'probe.homing-none',
    kind: 'magic', activation: 'press', sequences: [{ name: '一段', skills: ['skill.magic-bolt'] }],
  })
  registerTechnique(plain.w, noMod.compiled)
  pressSequence(plain.w, plain.me, noMod.compiled, { facing: { x: 0, y: 1 } })
  advance(plain.w, Math.round(0.4 * TICKS_PER_SECOND))
  const plainDirs: Array<{ x: number, y: number }> = []
  for (let i = 0; i < 3; i++) {
    stepWorld(plain.w)
    const d = boltDirOf(plain.w)
    if (d !== undefined) plainDirs.push(d)
  }
  ok('① 没有追踪副本的同一发子弹：3 tick 里**一度都没拐**（全在正上方）',
    plainDirs.length === 3 && plainDirs.every(d => Math.abs(d.x) < 1e-9 && Math.abs(d.y - 1) < 1e-9),
    plainDirs.map(d => `${d.x.toFixed(3)},${d.y.toFixed(3)}`).join(' / '))

  // ---- ② 装了追踪，但**发射那一刻**索敌距离里一个合法目标都没有 ⇒ 一路直走 ----
  const far = quietWorld()
  /*
   * ⚠⚠ **2026-09-30 日志 62 重写了这一条**（玩家把"射程"改成了"索敌距离"）。
   *
   *   敌人摆在 `(4,10)`：**发射那一刻**离发射点 `(0,0)` **10.77 米 > 索敌距离 8 米**
   *   ⇒ 那一刻锁不上。
   *
   *   ⚠⚠ 关键在于它**后来会飞进索敌距离里**：子弹朝正上方飞，飞到 `y ≈ 8.7` 那一刻
   *   离敌人只有 **4.2 米**（< 8）。旧口径（每 tick 拿 `maxRange` 重新搜）**到那时就会
   *   拐过去**；新口径（只搜发射那一刻）**一度都不拐**。
   *   ⇒ 这一条从"射程内没目标就直走"变成了"**那次搜索只有一次、就在发射那一刻**"。
   *   ⚠ 子弹**不会**撞上它：它一直在 `x = 0` 那条线上飞，而敌人站在 `x = 4`（最接近 4 米）。
   */
  spawn(far.w, {
    faction: 'enemy', pos: { x: 4, y: 10 }, base: { 'char.hp.max': 200, 'char.energy.max': 0 },
  })
  const farTech = homingTechnique('probe.homing-far', ['skill.magic-bolt'], { turnRate: 12, maxRange: 8 })
  const farCompiled = compileProbe(farTech)
  registerTechnique(far.w, farCompiled.compiled)
  pressSequence(far.w, far.me, farCompiled.compiled, { facing: { x: 0, y: 1 } })
  advance(far.w, Math.round(0.4 * TICKS_PER_SECOND))
  const farDirs: Array<{ x: number, y: number }> = []
  let farClosest = -1
  for (let i = 0; i < 20; i++) {
    stepWorld(far.w)
    const d = boltDirOf(far.w)
    if (d !== undefined) farDirs.push(d)
    /*
     * 顺手量一下"这一刻离敌人多远" —— 用来证明确实**飞进了**索敌距离里
     * （不然这一条和"敌人一直在外面"是同一件事，什么都证不了）。
     */
    const p = far.w.entities.find(e => e.kind === 'projectile' && e.alive)
    const foe = far.w.entities.find(e => e.faction === 'enemy')
    if (p !== undefined && foe !== undefined) {
      const dist = distance(p.pos, foe.pos)
      if (farClosest < 0 || dist < farClosest) farClosest = dist
    }
  }
  ok('② 装了追踪、但发射那一刻敌人在 10.77 米外（索敌距离 8 米）：**一度都没拐**',
    farDirs.length === 20 && farDirs.every(d => Math.abs(d.x) < 1e-9 && Math.abs(d.y - 1) < 1e-9),
    farDirs.map(d => `${d.x.toFixed(3)},${d.y.toFixed(3)}`).join(' / '))
  ok('  ⚠⚠ 而且它**后来飞进了索敌距离里**（最近不到 8 米）—— 照样一度都不拐：搜索只在发射那一刻发生',
    farClosest > 0 && farClosest < 8,
    `最近 ${farClosest.toFixed(2)} 米`) 

  // ---- ③ 飞进射程之后才开始拐（射程这个数**真的在管事**） ----
  /*
   * ⚠ 这一条是 ② 的对照：同一份参数、同一个敌人位置，只把 `maxRange` 从 8 改成 16
   *   ⇒ 第一 tick 就该开始拐。**只测 ② 不测 ③ 的话**，"射程"这个参数
   *   是"没接上"还是"接上了但敌人在外面"就分不出来（两种情况都表现为直飞）。
   */
  const near = quietWorld()
  spawn(near.w, {
    faction: 'enemy', pos: { x: 12, y: 0 }, base: { 'char.hp.max': 200, 'char.energy.max': 0 },
  })
  const wideTech = homingTechnique('probe.homing-wide', ['skill.magic-bolt'], { turnRate: 12, maxRange: 16 })
  const wideCompiled = compileProbe(wideTech)
  registerTechnique(near.w, wideCompiled.compiled)
  pressSequence(near.w, near.me, wideCompiled.compiled, { facing: { x: 0, y: 1 } })
  advance(near.w, Math.round(0.4 * TICKS_PER_SECOND))
  const wideDirs: Array<{ x: number, y: number }> = []
  for (let i = 0; i < 3; i++) {
    stepWorld(near.w)
    const d = boltDirOf(near.w)
    if (d !== undefined) wideDirs.push(d)
  }
  ok('③ 同一发子弹、同 12 米的敌人，只把搜索距离改成 16 米 ⇒ **立刻开始拐**',
    wideDirs.length === 3 && wideDirs.every(d => d.x > 0),
    wideDirs.map(d => `${d.x.toFixed(3)},${d.y.toFixed(3)}`).join(' / '))
}

section('60b. 追踪：**锁上之后追到消失**（不丢锁 / 不换目标）')

{
  const TICKS_PER_SECOND = 60

  /*
   * 玩家 2026-09-30（日志 62）原话：
   *   > 限制不应该是**射程**，而是**持续时间** —— 这样就**追到消失**
   * ⇒ 两条断言，各钉一半：
   *   ① 目标**跑出索敌距离**之后**还在拐**（旧口径会在同一刻丢锁 ⇒ 一度都不拐）；
   *   ② 锁定的那个**没了**之后**不换人**（宁可直走，也不许就近另挑一个）。
   *
   * ⚠ 两条都用"**方向还在不在变**"当读数：追踪只改 `vel`（`sim/projectile.ts`），
   *   而 `integrate` 不会改方向 —— 所以"方向一动不动"就是
   *   "引擎这一 tick **没有**在拐"的**精确**读数（不用估角度、不用容差）。
   */

  // ---- ① 不丢锁：目标跑到 60 米外，这一发还在拐 ----
  const { w, me } = quietWorld()
  const runner = spawn(w, {
    faction: 'enemy', pos: { x: 2, y: 7 }, base: { 'char.hp.max': 5000, 'char.energy.max': 0 },
  })
  const chase = homingTechnique('probe.homing-chase', ['skill.magic-bolt'], { turnRate: 12, maxRange: 8 })
  const chaseC = compileProbe(chase)
  registerTechnique(w, chaseC.compiled)
  pressSequence(w, me, chaseC.compiled, { facing: { x: 0, y: 1 } })
  advance(w, Math.round(0.4 * TICKS_PER_SECOND))
  const atLaunch = boltDirOf(w)
  ok('① 子弹在飞，而且已经在朝敌人拐了（发射那一刻它离发射点 7.28 米 ≤ 索敌距离 8 米）',
    atLaunch !== undefined && atLaunch.x > 0, JSON.stringify(atLaunch))

  /*
   * ⚠ 把敌人挪到 **60 米外**（远远超过索敌距离）——"目标跑出射程就丢锁"
   *   正是旧口径要改掉的那件事，所以这里量的是"它还在不在拐"。
   */
  runner.pos.x = 60
  runner.pos.y = 2
  for (let i = 0; i < 15; i++) stepWorld(w)
  const chasing = boltDirOf(w)
  ok('① ⚠⚠ 目标跑到 60 米外之后**还在拐**（方向已经转到几乎正右方 = 还在咬着它）',
    chasing !== undefined && chasing.x > 0.9, JSON.stringify(chasing))

  /*
   * ⚠ "追到消失"的字面意思：**这一发自己飞完 `lifetime` 就不见了**
   *   （不是"追到目标为止"）。目标一直在 60 米外 ⇒ 它追不上，
   *   可它照样咬着不放，直到**自己**到寿。
   */
  let diedAt = -1
  for (let i = 0; i < 3 * TICKS_PER_SECOND && diedAt < 0; i++) {
    stepWorld(w)
    if (boltDirOf(w) === undefined) diedAt = i + 1
  }
  ok('① 一边咬着一边飞，直到**自己**到寿消失（追到消失）', diedAt > 0, `第 ${diedAt} tick`)

  // ---- ② 不换目标：锁的那个没了之后**直走** ----
  const second = quietWorld()
  const locked = spawn(second.w, {
    faction: 'enemy', pos: { x: 2, y: 7 }, base: { 'char.hp.max': 5000, 'char.energy.max': 0 },
  })
  /*
   * ⚠ 另一个敌人在 **8.49 米**外（**超过**索敌距离 8 米）⇒ 发射那一刻**不会**锁它。
   *   它待会儿会被挪到子弹边上，用来问"要不要换目标"。
   */
  const other = spawn(second.w, {
    faction: 'enemy', pos: { x: -6, y: -6 }, base: { 'char.hp.max': 5000, 'char.energy.max': 0 },
  })
  const loyal = homingTechnique('probe.homing-loyal', ['skill.magic-bolt'], { turnRate: 12, maxRange: 8 })
  const loyalC = compileProbe(loyal)
  registerTechnique(second.w, loyalC.compiled)
  pressSequence(second.w, second.me, loyalC.compiled, { facing: { x: 0, y: 1 } })
  advance(second.w, Math.round(0.4 * TICKS_PER_SECOND))
  const biased = boltDirOf(second.w)
  ok('② 它咬的是最近那个（2,7），不是 8.49 米外那个',
    biased !== undefined && biased.x > 0 && biased.y > 0, JSON.stringify(biased))

  despawn(second.w, locked, 'expired')
  /*
   * ⚠ 把另一个敌人挪到子弹边上（约 3 米，**远小于**索敌距离 8 米）：
   *   · 旧口径（每 tick 重新搜）会在这一 tick **当场换目标**、拐过去；
   *   · 新口径（只认发射那一刻锁的那一个）⇒ **一度都不拐**。
   */
  other.pos.x = -3
  other.pos.y = 2
  const d0 = boltDirOf(second.w)
  const pAt = second.w.entities.find(e => e.kind === 'projectile' && e.alive)
  const nearAt = pAt === undefined ? -1 : distance(pAt.pos, other.pos)
  for (let i = 0; i < 15; i++) stepWorld(second.w)
  const d1 = boltDirOf(second.w)
  ok('② ⚠⚠ 锁的那个没了之后：**一度都没拐**（方向逐位不变 —— 不许换目标）',
    d0 !== undefined && d1 !== undefined && d1.x === d0.x && d1.y === d0.y,
    `${JSON.stringify(d0)} → ${JSON.stringify(d1)}`)
  ok('  而另一个敌人**就在子弹边上**（< 索敌距离 8 米）—— 换目标的话它一定搜得到',
    nearAt > 0 && nearAt < 8, `${nearAt.toFixed(2)} 米`)
}

section('61. 追踪：非飞行载体（激光那类）装了它 —— 什么都不做，而且**不出声**')

{
  /*
   * ⚠⚠ 玩家划的界线（原话）：
   *   > 部分技能比如**激光**不能被它修饰，看着不合理
   *   追问之后的口径：**只对"会飞的东西"有效**；非飞行载体
   *   （`beam` / `capsule` / `meleeArc` / `aura` / `area` / `self`）
   *   被它修饰 ⇒ **什么都不做** —— ⚠ **不是警告、不是报错**，
   *   是"**这个修饰对这条序列不起作用**"（照「环绕」那条先例；
   *   提示由界面画在那条序列下方，引擎不出声）。
   *
   * ⚠ 所以这里测两件事：
   *   ① 一份**装了追踪的光束术式**照常编译、照常放得出来（零件不拦路）；
   *   ② 放完之后世界里**一颗子弹都没有**（非飞行载体根本不走 `spawnProjectile`）
   *      —— "什么都不做"是**代码形状**保证的，不是引擎里的一行 `if`。
   */
  const { w, me } = quietWorld()
  spawn(w, {
    faction: 'enemy', pos: { x: 5, y: 0 }, base: { 'char.hp.max': 200, 'char.energy.max': 0 },
  })
  /*
   * ⚠ 用**出厂那个激光技能**（`skill.charged-laser` 是 `beam` 载体 + 蓄力）——
   *   它就是玩家点名的"激光"。⚠ 蓄力技能必须是序列的第一个（`FORM_NOT_FIRST`），
   *   这里只有它一个，合法。
   */
  const beamTech = homingTechnique('probe.homing-beam', ['skill.charged-laser'], { turnRate: 12, maxRange: 8 })
  const { compiled, problems } = compileProbe(beamTech)
  eq('① 装了追踪的光束术式**照常编译**（零件不拦路、不报错）', problems.length, 0)

  registerTechnique(w, compiled)
  const press = pressSequence(w, me, compiled, { facing: { x: 1, y: 0 } })
  ok('  按一下放出来了', press.ok === true, String(press.reason ?? ''))

  /*
   * 蓄力阶段靠"按住"推进：这里直接给它足够多的 tick，让曲线跑起来。
   * ⚠ 我们不关心它打了多少伤害 —— 只关心**有没有一个会飞的东西被造出来**。
   */
  advance(w, 4 * 60)
  eq('② ⚠ 一颗子弹都没有（光束不是会飞的东西 ⇒ 追踪对它什么都不做）',
    w.entities.filter(e => e.kind === 'projectile').length, 0)
  ok('  而这次施法是真的发生过的（不是"因为放不出来所以没子弹"）',
    press.cast !== undefined, String(press.cast?.id))
}

// ---------------------------------------------------------------- 弹射（日志 58）

/**
 * 造一份**带弹射**的测试术式。
 *
 * ⚠ 和 `homingTechnique` / `layoutTechnique` 分开的理由一样：修饰技能**参数异构**，
 *   弹射的两个键（`maxBounces` / `damageFalloff`）和别人的不是一套。
 */
function bounceTechnique(
  id: string,
  skills: string[],
  params: Record<string, unknown>,
  at = 0,
): Technique {
  return {
    schemaVersion: 1,
    id,
    name: id,
    kind: 'magic',
    activation: 'press',
    sequences: [{
      name: '一段',
      skills: [...skills],
      mods: [{ proto: 'mod.bounce', at, params }],
    }],
  }
}

/** 世界里**活着**的那几颗子弹（弹射每一段都是一颗新子弹，所以这里通常是 0 或 1 颗） */
function liveProjectiles(w: ReturnType<typeof createWorld>): Array<{ id: number }> {
  return w.entities.filter(e => e.kind === 'projectile' && e.alive)
}

/**
 * 一 tick 一 tick 地推，直到某个人的血**变了** —— 返回花掉几个 tick（`-1` = 一直没变）。
 *
 * ⚠ 为什么要这个而不是一把 `advance`：弹射的每一段都会**换一颗子弹**，
 *   "打中的那一 tick"正是"新子弹出生的那一 tick"—— 只有一步步走才看得见它。
 */
function ticksUntilHurt(
  w: ReturnType<typeof createWorld>,
  e: ReturnType<typeof createWorld>['entities'][number],
  hp0: number,
  limit: number,
): number {
  for (let i = 1; i <= limit; i++) {
    stepWorld(w)
    if (getStored(e, 'char.hp.current') < hp0) return i
  }
  return -1
}

/** 造一个"站在那儿挨打"的敌人（血量给足，免得它死了影响下一段） */
function bounceFoe(
  w: ReturnType<typeof createWorld>,
  x: number,
  y: number,
): ReturnType<typeof createWorld>['entities'][number] {
  return spawn(w, {
    faction: 'enemy',
    pos: { x, y },
    base: { 'char.hp.max': 500, 'char.energy.max': 0 },
  })
}

section('62. 弹射：打中之后**弹给最近的另一个敌人**（而且每次衰减）')

{
  const TICKS_PER_SECOND = 60

  /*
   * 玩家规格（原话）：
   * > 被它修饰的**投射物命中一个敌人之后** → **弹给最近的另一个敌人** ✓
   * > 最多 **N 次** ✓ 每次**衰减** ✓（"弹两下的闪电"✓）
   *
   * 摆法：我在 (0,0) 朝**正上方**打，第一个敌人在正上方 6 米（一定先打到它），
   * 第二个敌人在 (6,6) —— **不在发射线上**，所以"它后来被打中了"
   * 这件事**只可能**来自弹射。
   */
  const { w, me } = quietWorld()
  const near = bounceFoe(w, 0, 6)
  const far = bounceFoe(w, 6, 6)

  const tech = bounceTechnique('probe.bounce', ['skill.magic-bolt'], {
    maxBounces: 2,
    damageFalloff: 0.7,
  })
  const { compiled, problems } = compileProbe(tech)
  eq('编译没有报问题', problems.length, 0)
  /*
   * ⚠ 编译产物里记的是"打中之后弹几次、每次弱多少"（编译期读好、夹好）——
   *   运行时不再查原型表（和 `count` / `waitSeconds` / `layout` / `homing` 同一条纪律）。
   */
  eq('  编译期读好了次数', compiled.segments?.[0]?.mods?.[0]?.bounce?.maxBounces, 2)
  eq('  编译期读好了每次衰减', compiled.segments?.[0]?.mods?.[0]?.bounce?.damageFalloff, 0.7)
  registerTechnique(w, compiled)

  const press = pressSequence(w, me, compiled, { facing: { x: 0, y: 1 } })
  ok('按一下放出来了（朝正上方，第二个敌人不在那条线上）',
    press.ok === true, String(press.reason ?? ''))

  const hpNear0 = getStored(near, 'char.hp.current')
  const hpFar0 = getStored(far, 'char.hp.current')

  // ---- ① 第一段：命中**最近的那个**（正上方）----
  const t1 = ticksUntilHurt(w, near, hpNear0, 3 * TICKS_PER_SECOND)
  ok('① 打中了最近的那个敌人', t1 > 0, `第 ${t1} tick`)
  eq('  这时候第二个敌人**还没**挨打（它是另一个，不是同一个）',
    getStored(far, 'char.hp.current'), hpFar0)

  /*
   * ---- ② 弹射：打中的那一 tick 里，世界上应该**已经换了一颗子弹** ----
   *
   * ⚠⚠ 这一条是"弹射真的发生了"的**唯一**直接证据：
   *   不弹的话那一发当场消失（`!spec.pierce`），世界里一颗子弹都没有。
   */
  eq('② ⚠ 打中之后**还有一颗子弹在飞**（它是弹出去的那一颗，不是原来那颗）',
    liveProjectiles(w).length, 1)
  const dir = boltDirOf(w)
  ok('  而且它朝**另一个**敌人那个方向飞（不是继续朝正上方）',
    dir !== undefined && dir.x > 0.3,
    dir === undefined ? '没有子弹' : `${dir.x.toFixed(3)},${dir.y.toFixed(3)}`)

  // ---- ③ 第二段：真的打到那个**不在发射线上**的敌人 ----
  const t2 = ticksUntilHurt(w, far, hpFar0, 3 * TICKS_PER_SECOND)
  ok('③ ⚠ 第二段真的打中了另一个敌人（它不在发射线上 ⇒ 只有弹射能解释）',
    t2 > 0, `第 ${t2} tick`)

  /*
   * ---- ④ 衰减：第二段 = 第一段 × 0.7 ----
   *
   * ⚠ 用**实打掉的血**比，不用"我以为它算的是多少"：中间还有易伤 / 暴击那几道门，
   *   它们对两段是同一套（同一个施法者、同一个目标类型）。
   */
  const d1 = hpNear0 - getStored(near, 'char.hp.current')
  const d2 = hpFar0 - getStored(far, 'char.hp.current')
  ok('④ ⚠ 第二段**衰减**了（= 第一段 × 0.7，玩家说的"每次 −30%"）',
    Math.abs(d2 - d1 * 0.7) < 1e-6,
    `第一段 ${d1} → 第二段 ${d2}（×0.7 = ${d1 * 0.7}）`)

  // ---- ⑤ 没有第三个敌人 ⇒ 停在第二段（不弹了）----
  eq('⑤ 弹完这一下就停（没有第三个敌人）', liveProjectiles(w).length, 0)
}

section('62b. 弹射 · 次数上限**就是**引擎的深度限制（不是这个零件自己的数）')

{
  /*
   * ⚠⚠ 玩家 2026-09-30 的硬命令（原话）：
   * > **上限必须和 `pipeline` 的深度限制用同一条规矩** ✗（先 grep `depth` ✓
   * > 找现有上限 ✓ **复用它** ✓ —— 各写一份迟早出现"弹射绕过深度保护 ⇒ 自反馈"✗）
   *
   * ⇒ 判据是**一个数**：`src/limits.ts` 的 `MAX_ACTION_DEPTH`。
   *   ⚠ 这条测试钉的就是"它是**同一个数**"：把副本写成 9 ⇒ 引擎只认 4
   *   （而且编译期**会说**，不静默）。
   */
  const over = bounceTechnique('probe.bounce-over', ['skill.magic-bolt'], {
    maxBounces: 9,
    damageFalloff: 0.7,
  })
  const r = compileProbe(over)
  eq('① 要 9 次 ⇒ 引擎只认 4 次（= MAX_ACTION_DEPTH）',
    r.compiled.segments?.[0]?.mods?.[0]?.bounce?.maxBounces,
    MAX_ACTION_DEPTH)
  ok('② 而且**编译期就说了**（不许静默地夹住）',
    r.problems.length === 1 && r.problems[0]?.message.includes('[1, 4]'),
    JSON.stringify(r.problems.map(p => p.message)))

  /*
   * ⚠ 另一半：这个数**只有一个**。把深度上限当成"另一份上限"抄一遍的话，
   *   这条断言会在有人改 `MAX_ACTION_DEPTH` 时**当众变红** —— 那正是我们要的。
   */
  eq('③ 那个 4 就是 pipeline 的结算预算（同一个导出）', MAX_ACTION_DEPTH, 4)
}

section('62c. 弹射：衰减**只作用于伤害** —— 治疗照原值（用户 2026-09-30 裁定）')

{
  /*
   * ⚠⚠ 用户裁定（原话）：
   * > **衰减只作用于伤害，不要乘 heal** ✗ —— 用户原话只说"伤害" ✓
   * > 而且"会弹的治疗"是另一种机制 ✗
   *
   * ⇒ 引擎里两半：① `runProjectileHit` 把 `spec.bounce.amountScale` 塞进 `ctx`；
   *   ② `executeAction` **只对 `damage` 那一支**乘它（`heal` 照原值）。
   *   这一节用一个**载荷是治疗**的真弹丸走完整条路（`spawnProjectile` → 命中 →
   *   弹射 → 第二段命中），钉住"第二段治得和第一段一样多"。
   *
   * ⚠ 为什么手工造 `spec` 而不走技能：**出厂技能里没有"投射物 + 治疗"那一份**
   *   （`holy-light` / `hunter-instinct` 都不是飞行载体）—— 现造一份技能
   *   会把"治疗量 / 载体的速度"这些和本条裁定无关的数一起搬进来。
   *   ⚠ 这里量的是**两次治疗之差**，所以那些数是多少都不影响结论。
   */
  const TICKS_PER_SECOND = 60
  const { w, me } = quietWorld()
  /** 两个**自己人**（`valid: ['ally']`），站成一条斜线，让第二段有得弹 */
  const allyA = spawn(w, {
    faction: 'player',
    pos: { x: 0, y: 6 },
    base: { 'char.hp.max': 500, 'char.energy.max': 0 },
  })
  const allyB = spawn(w, {
    faction: 'player',
    pos: { x: 6, y: 6 },
    base: { 'char.hp.max': 500, 'char.energy.max': 0 },
  })
  /*
   * ⚠⚠ **必须先把血真的压下去**：`base` 里的 `char.hp.current` 会被出生时的
   *   "回满血"覆盖（实测血一直满着）—— 而**满血的人治疗被钳住 ⇒ 一点变化都看不见**，
   *   这一节就会变成"两次都是 0"的**假绿**（第一版正是这么栽的：4 条一起红在
   *   `HP 500 → 500` 上）。⇒ 出生之后显式设一次。
   */
  setStored(allyA, 'char.hp.current', 100)
  setStored(allyB, 'char.hp.current', 100)

  /*
   * ⚠ `amountScale: 0.5`（不是 1）是**故意**的：不为 1 才会真的写进 `ctx`
   *   （`runProjectileHit` 有一句 `!== 1` 的快路）—— 于是"治疗会不会被乘"
   *   在这一条里**真的被走到**。真要是乘了，第二段只会治 20 而不是 40。
   */
  const spec: ProjectileSpec = {
    actions: [{ payload: { kind: 'heal', amount: { const: 40 } } }],
    valid: ['ally'],
    sourceId: me.id,
    hitIds: [],
    pierce: false,
    bounce: { left: 1, amountScale: 0.5, damageFalloff: 0.7 },
  }
  spawnProjectile(w, {
    pos: { x: me.pos.x, y: me.pos.y, z: 0 },
    dir: { x: 0, y: 1 },
    delivery: { kind: 'projectile', speed: 12, lifetime: 1.5, radius: 0.5 },
    tags: [],
    spec,
  })

  const hA0 = getStored(allyA, 'char.hp.current')
  const hB0 = getStored(allyB, 'char.hp.current')

  // 治疗是**往上涨**的 —— 所以这里不能用 `ticksUntilHurt`
  let ticks = 0
  while (ticks < 3 * TICKS_PER_SECOND && getStored(allyA, 'char.hp.current') === hA0) {
    stepWorld(w)
    ticks++
  }
  const hA1 = getStored(allyA, 'char.hp.current')
  ok('① 第一段治到了最近的那个自己人', hA1 > hA0, `HP ${String(hA0)} → ${String(hA1)}`)

  // 弹射：打中的那一 tick 世界里应该已经换了一颗新子弹
  eq('② ⚠ 打中之后还有一颗子弹在飞（它弹了）', liveProjectiles(w).length, 1)

  let ticks2 = 0
  while (ticks2 < 3 * TICKS_PER_SECOND && getStored(allyB, 'char.hp.current') === hB0) {
    stepWorld(w)
    ticks2++
  }
  const hB1 = getStored(allyB, 'char.hp.current')
  ok('③ 第二段治到了另一个自己人（它不在发射线上 ⇒ 只有弹射能解释）',
    hB1 > hB0, `HP ${String(hB0)} → ${String(hB1)}`)

  /*
   * ---- ④ ⚠⚠ 这一条就是裁定本身 ----
   *
   *   两段治的**一样多**（不是 × 0.7、也不是 × 0.5）——
   *   也就是说"衰减"只落在伤害那一边，治疗**照原值**。
   */
  const healA = hA1 - hA0
  const healB = hB1 - hB0
  ok('④ ⚠⚠ **弹射不衰减治疗**：两段治得一样多（衰减只管伤害）',
    Math.abs(healA - healB) < 1e-6, `第一段 ${healA} → 第二段 ${healB}`)
  ok('  而且它真的治了 40（不是"两次都是 0"那种假相等）',
    Math.abs(healA - 40) < 1e-6, String(healA))
  eq('⑤ 弹完这一下就停（没有第三个自己人）', liveProjectiles(w).length, 0)
}

section('63. 弹射：弹够 N 次就停（不会一直弹下去）')

{
  const TICKS_PER_SECOND = 60

  /*
   * 三个敌人排成一条斜线：A 在正上方（一定先打到），B 是 A 之后**最近**的那个，
   * C 更远。次数给 **1** ⇒ 只该弹一次（A → B），C 一根汗毛都不该掉。
   */
  const { w, me } = quietWorld()
  const a = bounceFoe(w, 0, 6)
  const b = bounceFoe(w, 4, 6)
  const c = bounceFoe(w, 9, 6)

  const tech = bounceTechnique('probe.bounce-n1', ['skill.magic-bolt'], {
    maxBounces: 1,
    damageFalloff: 0.7,
  })
  const { compiled, problems } = compileProbe(tech)
  eq('编译没有报问题', problems.length, 0)
  registerTechnique(w, compiled)
  pressSequence(w, me, compiled, { facing: { x: 0, y: 1 } })

  const hpa0 = getStored(a, 'char.hp.current')
  const hpb0 = getStored(b, 'char.hp.current')
  const hpc0 = getStored(c, 'char.hp.current')

  ok('① 第一段打中 A', ticksUntilHurt(w, a, hpa0, 3 * TICKS_PER_SECOND) > 0)
  // ⚠ 记住"A 挨完这一下之后"的血量：最后要证明它**只**掉了这么多
  const hpa1 = getStored(a, 'char.hp.current')
  ok('② 弹到 B（A 之后最近的那个）',
    ticksUntilHurt(w, b, hpb0, 3 * TICKS_PER_SECOND) > 0)
  eq('③ ⚠ 次数用完 ⇒ **停在 B**（世界里没有子弹了）', liveProjectiles(w).length, 0)

  // 再推两秒：C 一次都不该被打，A / B 也不该被第二次打到
  advance(w, 2 * TICKS_PER_SECOND)
  eq('④ C 一根汗毛都没掉（弹一次就是一次）', getStored(c, 'char.hp.current'), hpc0)
  eq('⑤ A 只挨了那一次（次数用完就是真的停）', getStored(a, 'char.hp.current'), hpa1)
  ok('  ⑤b 而 A 的血**确实掉过**（不是"没打中所以没变"）', hpa1 < hpa0,
    `${String(hpa0)} → ${String(hpa1)}`)
}

section('64. 弹射：没有下一个敌人 ⇒ 停在那儿；**不许弹回刚打过的那个**')

{
  const TICKS_PER_SECOND = 60

  // ---- ① 世界里只有一个敌人 ⇒ 弹不出去，就地停下 ----
  {
    const { w, me } = quietWorld()
    const only = bounceFoe(w, 0, 6)
    const tech = bounceTechnique('probe.bounce-solo', ['skill.magic-bolt'], {
      maxBounces: 2,
      damageFalloff: 0.7,
    })
    const { compiled, problems } = compileProbe(tech)
    eq('① 编译没有报问题', problems.length, 0)
    registerTechnique(w, compiled)
    pressSequence(w, me, compiled, { facing: { x: 0, y: 1 } })

    const hp0 = getStored(only, 'char.hp.current')
    ok('  打中了那个唯一的敌人', ticksUntilHurt(w, only, hp0, 3 * TICKS_PER_SECOND) > 0)
    eq('  ⚠ **没有下一个 ⇒ 不弹**（打中的那一 tick 世界上一颗子弹都没有）',
      liveProjectiles(w).length, 0)
    const hpAfter = getStored(only, 'char.hp.current')
    advance(w, 2 * TICKS_PER_SECOND)
    eq('  而且它就停在那儿（那颗唯一的敌人不会再被弹一次）',
      getStored(only, 'char.hp.current'), hpAfter)
  }

  // ---- ② 两个敌人 + 次数给 3 ⇒ 打完两个就停，**不许来回弹** ----
  {
    const { w, me } = quietWorld()
    const a = bounceFoe(w, 0, 6)
    const b = bounceFoe(w, 4, 6)
    const tech = bounceTechnique('probe.bounce-pingpong', ['skill.magic-bolt'], {
      maxBounces: 3,
      damageFalloff: 0.7,
    })
    const { compiled, problems } = compileProbe(tech)
    eq('② 编译没有报问题', problems.length, 0)
    registerTechnique(w, compiled)
    pressSequence(w, me, compiled, { facing: { x: 0, y: 1 } })

    const hpa0 = getStored(a, 'char.hp.current')
    const hpb0 = getStored(b, 'char.hp.current')
    ok('  A 挨了一下', ticksUntilHurt(w, a, hpa0, 3 * TICKS_PER_SECOND) > 0)
    const hpa1 = getStored(a, 'char.hp.current')
    ok('  弹到 B', ticksUntilHurt(w, b, hpb0, 3 * TICKS_PER_SECOND) > 0)
    const hpb1 = getStored(b, 'char.hp.current')
    eq('  ⚠ 两个都打过了 ⇒ 停下（没有第三颗子弹）', liveProjectiles(w).length, 0)

    advance(w, 2 * TICKS_PER_SECOND)
    eq('  ⚠⚠ A 没有被第二次弹到（不许来回弹）', getStored(a, 'char.hp.current'), hpa1)
    eq('  B 也只是一下', getStored(b, 'char.hp.current'), hpb1)
  }
}

section('65. 弹射：非飞行载体（激光那类）装了它 —— 什么都不做')

{
  /*
   * ⚠⚠ 玩家划的界线（和「追踪」**同一条规矩**）：
   * > **只对"会飞的东西"有效**；**非飞行载体**（激光 / 光束 / 扇形 / 光环 /
   * > 落点区域 / 自己）→ **什么都不做** ✗ **而且不收费** ✗
   *
   * 这一节测的是**引擎那一半**："什么都不做"是**代码形状**保证的
   * （非飞行载体根本不走 `spawnProjectileFrom`）。
   * ⚠ 另外两半（**校验器警告** + **账上一分钱都不收**）在
   *   `tests/weapons.ts` / `tests/pricing.ts` —— 三处读的都是**同一个判据**
   *   （`src/school.ts` 的 `carrierFliesInWorld`）。
   */
  const { w, me } = quietWorld()
  const foe = spawn(w, {
    faction: 'enemy', pos: { x: 0, y: 3 }, base: { 'char.hp.max': 200, 'char.energy.max': 0 },
  })
  /*
   * ⚠ 用**扇形**（`skill.cleave` 是 `meleeArc`）而不是激光：
   *   激光（`skill.charged-laser`）是**蓄力**技能（`charge` 阶段 `duration: -1`），
   *   它要玩家松手才打出 `fire` 那一段 —— "它到底有没有打出去"会混进蓄力那一套里，
   *   而这一节要看的**只有**"非飞行载体 ⇒ 弹射什么都不做"。
   *   ⚠ 玩家点名的是"激光那类"，`meleeArc` 和它同属**非飞行载体**那一类。
   */
  const beamTech = bounceTechnique('probe.bounce-arc', ['skill.cleave'], {
    maxBounces: 2,
    damageFalloff: 0.7,
  })
  const { compiled, problems } = compileProbe(beamTech)
  eq('① 装了弹射的扇形术式**照常编译**（零件不拦路、不报错）', problems.length, 0)
  /*
   * ⚠ 编译产物里**也有** `bounce`（编译期读参数这一层和"它起不起作用"是两件事）——
   *   起作用与否由**载体**决定，而那件事根本走不到这儿。
   */
  eq('  参数照常读好了（起不起作用是另一回事）',
    compiled.segments?.[0]?.mods?.[0]?.bounce?.maxBounces, 2)

  registerTechnique(w, compiled)
  const press = pressSequence(w, me, compiled, { facing: { x: 0, y: 1 } })
  ok('  按一下放出来了', press.ok === true, String(press.reason ?? ''))

  const hp0 = getStored(foe, 'char.hp.current')
  /*
   * ⚠ 一 tick 一 tick 地推并盯 `deliveryFired`：那一条是"这次载体**真的放出去了**"的
   *   官方信号（瞬时载体走 `pipeline.ts` 的 `fireDelivery`，投射物走 `projectile.ts`）——
   *   用它比用"它打掉了多少血"稳（一刀多少血和这一片无关）。
   *   ⚠ `world.events` 是"**这一 tick** 发生了什么"（`stepWorld` 开头清空）。
   */
  let arcFired = false
  for (let i = 0; i < 4 * 60 && !arcFired; i++) {
    stepWorld(w)
    if (w.events.some(ev => ev.type === 'deliveryFired' && ev.kind === 'meleeArc')) arcFired = true
  }
  eq('② ⚠ 一颗子弹都没有（扇形不是会飞的东西 ⇒ 弹射对它什么都不做）',
    w.entities.filter(e => e.kind === 'projectile').length, 0)
  ok('  而这次施法是真的发生过的（不是"因为放不出来所以没子弹"）',
    press.cast !== undefined, String(press.cast?.id))
  ok('  ③ 扇形照常打出去了（弹射没有拦住别的任何东西）', arcFired,
    `HP ${String(hp0)} → ${String(getStored(foe, 'char.hp.current'))}`)
}



section('66. 编译问题**带段号**（2026-09-30 日志 61 —— 界面要能把提示画在那一条序列下面）')

{
  /*
   * ⚠⚠ 用户点名的 UI 前提：今天编译问题是**扁平**的
   *   （`{ techniqueId, skillId, message }`，段号只写在**文字**里）。
   *   界面要"把提示画在**有问题的那一条序列下方**"就得去解析自己写的中文 ——
   *   那是拿文案当数据结构（文案一改界面就瞎）。
   *
   *   ⇒ `CompileProblem` 多出四个**结构化**字段：`segmentIndex` /
   *     `skillIndex` / `modIndex` / `paramKey`。
   *   ⚠ **文案一个字都没改**（这一节同时钉住它：`message` 还是原来那句话）。
   *   ⚠ 三个下标**同时缺席 = "整门术式那一层"**（不是"第 0 段"）——
   *     用 `undefined` 说"容器没有段号"，不用 -1 / 0 冒充。
   */

  // ---- ① 容器那一层：段号必须**缺席**（它是"整门术式"的问题）----
  const containerProblems = compileProbe({
    schemaVersion: 1,
    id: 'probe.problem-container',
    name: '容器探针',
    kind: 'magic',
    activation: 'press',
    skills: ['skill.magic-bolt', 'skill.does-not-exist'],
  }).problems
  const unknown = containerProblems.find(p => p.skillId === 'skill.does-not-exist')
  ok('① 容器里那个不存在的技能被报出来了', unknown !== undefined,
    JSON.stringify(containerProblems.map(p => p.message)))
  eq('  段号**缺席**（容器自己没有段号 —— 不是"第 0 段"）', unknown?.segmentIndex, undefined)
  eq('  技能下标 = 1（原始下标，界面画的就是数据里那一行）', unknown?.skillIndex, 1)

  // ---- ② 段那一层：段号 / 副本号 / 取值位置 ----
  const segProblems = compileProbe({
    schemaVersion: 1,
    id: 'probe.problem-segment',
    name: '段探针',
    kind: 'magic',
    activation: 'press',
    sequences: [
      { name: '第一段', skills: ['skill.magic-bolt'] },
      {
        name: '第二段',
        skills: ['skill.magic-bolt'],
        // 半径 99 米越界 ⇒ 编译期夹到 6 并报一条（日志 53）
        mods: [{ proto: 'mod.layout', at: 0, params: { type: 'ring', radius: 99 } }],
      },
    ],
  }).problems
  const radius = segProblems.find(p => p.paramKey === 'radius')
  ok('② 第二段那个越界的半径被报出来了', radius !== undefined,
    JSON.stringify(segProblems.map(p => p.message)))
  eq('  段号 = 1（0 基 —— 界面要画在**第二段**下面）', radius?.segmentIndex, 1)
  eq('  副本号 = 0（这一段里第 0 个副本）', radius?.modIndex, 0)
  eq('  取值位置 = radius（界面能指到"哪一个旋钮"）', radius?.paramKey, 'radius')
  ok('  而且**文案一个字都没退化**（还是那句人话，带段名）',
    (radius?.message ?? '').includes('序列段「第二段」') && (radius?.message ?? '').includes('超出它的范围'),
    radius?.message ?? '')

  // ---- ③ 原型不存在那种：有副本号，但没有"取值位置" ----
  const badProto = compileProbe({
    schemaVersion: 1,
    id: 'probe.problem-proto',
    name: '原型探针',
    kind: 'magic',
    activation: 'press',
    sequences: [{ name: '唯一段', skills: ['skill.magic-bolt'], mods: [{ proto: 'mod.nope', at: 0, params: {} }] }],
  }).problems
  const proto = badProto.find(p => (p.message ?? '').includes('mod.nope'))
  ok('③ 不存在的原型被报出来了', proto !== undefined, JSON.stringify(badProto.map(p => p.message)))
  eq('  段号 = 0', proto?.segmentIndex, 0)
  eq('  副本号 = 0', proto?.modIndex, 0)
  eq('  取值位置 = proto（"整个副本不存在"也有个位置：那个字段本身）', proto?.paramKey, 'proto')
}

// ---------------------------------------------------------------- 汇总

console.log('')
if (failed > 0) {
  console.log(`✗ ${failed} 个断言失败（${passed} 个通过）`)
  process.exitCode = 1
} else {
  console.log(`✓ 全部 ${passed} 个断言通过`)
  process.exitCode = 0
}
