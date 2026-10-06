/**
 * 二段技能（标记 → 瞬影）和它逼出来的两块积木。
 *
 * 玩家 2026-09-21 的原话：
 *   > 给最近的敌人挂上标记（不进入CD）、再次按下技能会瞬移到标记敌人身后（进入CD）。
 *   > 之前定下来的"序列"机制只作用于武器技能，但现在我觉得也应该作用于魔法技能了，
 *   > 因为想实现二段技能只能用这种方法，让每条序列有不同的 CD。
 *
 * 这一个技能逼出了三样新东西，缺一样它就写不出来：
 *
 *   1. **以目标为锚的落点**（`anchor: 'target'` + `side: 'behind'`）——
 *      `teleport` 原来只能"沿我自己朝前闪 N 米"
 *   2. **按状态标签选目标**（`targeting.requireStatusTag`）——
 *      `auto` 原来只会挑"最近的"，而第二段要的是"我标过的那个人"
 *   3. **序列之间的条件门在运行时生效**（`sequenceLinks[i].if`）——
 *      原来只有校验器读它，写了等于没写
 *
 * ⚠ 第 3 条最阴：写的门不生效，**不会报任何错**，
 *   表现只是"标记过期之后还瞬移出去"（落点未知）—— 玩家会以为是随机传送。
 *
 * ⚠ **2026-09-21（日志 46）序列内联之后的改动，只有"段从哪儿拿"这一件：**
 *   内容从**三份文件**（容器 + 两段各一份）变成**一份**（容器里内联两段），
 *   所以 `lib.compiled.get('tech.mark-step')` 拿不到了 ——
 *   改成从容器里取：`container.segments[i].technique`。
 *
 *   ⚠ 下面那些断言**一个字都没改**，因为**行为**一个字都没变：
 *     · `cast.technique.id` 仍然是 `tech.mark-step` / `tech.blink-step`
 *       （段把旧 id 显式写下来了，见 schema 的 `SequenceSegment.id`）
 *     · 冷却仍然记在 `cd.tech.mark-step` / `cd.tech.blink-step` 上
 *
 * ⚠ **2026-09-21（日志 47）"瞄准搬到技能层"之后的改动，也只有"从哪儿读"这一件：**
 *   第二段那句 `requireStatusTag: 'marked'` 从**段**搬到了**技能**
 *   （`content/skills/blink.json` 的 `targeting`）—— 所以第 7 节读的是
 *   `lib.skills.get('skill.blink').targeting`。
 *   ⚠ **行为断言一个字都没变**：第二段仍然必须打"**带标记的那个**"，
 *     不是"最近的"（编译时 `compile.ts` 的 `targetingOfChain`
 *     会把它从技能取进段的编译产物，运行时读的还是同一份）。
 */
import { resolve } from 'node:path'
import { loadLibrary } from '../src/bridge.ts'
import { readJson } from '../src/loader.ts'
import { advance, createWorld, registerTechnique, spawn, stepWorld } from '../src/sim/world.ts'
import { getStored } from '../src/sim/attributes.ts'
import { activate, pressSequence } from '../src/sim/cast.ts'
import { hasStatusTag } from '../src/sim/status.ts'
import { compileTechnique } from '../src/sim/compile.ts'
import type { CompiledTechnique } from '../src/sim/compile.ts'
import { allRulesOf } from '../src/effects.ts'
import type { BalanceConfig } from '../src/validator/types.ts'
import type { Skill, Technique } from '../src/schema.ts'

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

/** 端到端的那个二段技能（内容里那一份容器，两段内联在它里面） */
const containerLookup = lib.compiled.get('tech.mark-blink')
if (containerLookup === undefined) {
  console.log('✗ 内容里的二段技能没编译出来')
  process.exit(1)
}
// ⚠ 收进非可选量：下面的嵌套函数里 TS 不再保留窄化
const container: CompiledTechnique = containerLookup

/**
 * ⚠ 两段现在住在容器里（`segments[i].technique`），不再是内容库里两份独立的术式。
 *   取出来的是一份**完整的编译产物**（阶段 / 技能 / 瞄准都在），
 *   所以下面用它当"一份术式"用的地方（比如"单独 activate 第二段"）一字不用改。
 */
const markStepLookup = container.segments?.[0]?.technique
const blinkStepLookup = container.segments?.[1]?.technique
if (markStepLookup === undefined || blinkStepLookup === undefined) {
  console.log('✗ 二段技能的两段没编译进容器')
  process.exit(1)
}
const markStep: CompiledTechnique = markStepLookup
const blinkStep: CompiledTechnique = blinkStepLookup

/**
 * 造一个战场：
 *   玩家在 (0,0)
 *   近敌 near 在 (3,0)，朝向 +y（于是它的"背后"是 -y 方向）
 *   远敌 far  在 (9,0)
 */
function arena(): {
  w: ReturnType<typeof createWorld>
  me: ReturnType<typeof spawn>
  near: ReturnType<typeof spawn>
  far: ReturnType<typeof spawn>
} {
  const w = createWorld({ seed: 1 })
  /*
   * ⚠ 内联之后**只注册容器**（两段在它里面，`resolveSegment` 直接取）。
   *   以前这里要注册三份：容器 + 两份子术式（段是"按 id 去世界查"的）。
   */
  registerTechnique(w, container)

  const me = spawn(w, {
    faction: 'player', pos: { x: 0, y: 0 },
    base: { 'char.hp.max': 200, 'char.energy.max': 200, 'char.energy.regen': 50 },
  })
  const near = spawn(w, { faction: 'enemy', pos: { x: 3, y: 0 }, facing: { x: 0, y: 1 }, base: { 'char.hp.max': 100 } })
  const far = spawn(w, { faction: 'enemy', pos: { x: 9, y: 0 }, facing: { x: 0, y: 1 }, base: { 'char.hp.max': 100 } })
  return { w, me, near, far }
}

/** 一直跑到没人施法为止 */
function settle(w: ReturnType<typeof createWorld>): void {
  let guard = 0
  while (w.casts.some(c => !c.finished && !c.interrupted) && guard++ < 300) stepWorld(w)
}

// ============================================================================
//  1. 第一段：标记最近的敌人，而且**不进冷却**
// ============================================================================

section('第一段：标记最近的敌人（不进入 CD）')

{
  const { w, me, near } = arena()
  const r = pressSequence(w, me, container, { intent: { kind: 'none' } })
  ok('第一次按 → 走第一段（标记）',
    r.ok && r.index === 0 && r.cast?.technique.id === 'tech.mark-step',
    JSON.stringify({ index: r.index, tech: r.cast?.technique.id }))

  settle(w)
  ok('最近的敌人身上有了「marked」标签',
    hasStatusTag(near, 'marked'), near.statuses.map(s => s.defId).join(','))

  ok('第一段**没有**进冷却（这是玩家点名要的）',
    getStored(me, 'cd.tech.mark-step') === 0,
    `cd=${getStored(me, 'cd.tech.mark-step')}`)
}

// ============================================================================
//  2. 第二段：闪到标记目标的**身后**（以目标为锚的落点）
// ============================================================================

section('第二段：瞬移到标记目标的背后（新积木：以目标为锚的落点）')

{
  const { w, me, near } = arena()
  pressSequence(w, me, container, { intent: { kind: 'none' } })
  settle(w)

  const second = pressSequence(w, me, container, { intent: { kind: 'none' } })
  ok('第二次按 → 走第二段（瞬影）',
    second.ok && second.index === 1 && second.cast?.technique.id === 'tech.blink-step',
    JSON.stringify({ index: second.index, tech: second.cast?.technique.id }))

  settle(w)
  /*
   * 目标的朝向是 +y，所以"身后"是 -y 方向、距离 1.5 米。
   * 它验证的是**以目标的位置和朝向算落点**这件事 ——
   * 沿"我自己"的朝向闪的话，落点会是 (±1.5, 0) 那一带。
   */
  ok('落点在目标的背后（-y 1.5 米），不是"沿自己朝前"',
    Math.abs(me.pos.x - near.pos.x) < 0.01 && Math.abs(me.pos.y - (near.pos.y - 1.5)) < 0.01,
    `玩家 (${me.pos.x.toFixed(2)}, ${me.pos.y.toFixed(2)})，目标 (${near.pos.x}, ${near.pos.y})`)

  ok('第二段**进了**冷却（8 秒）',
    getStored(me, 'cd.tech.blink-step') > 0,
    `cd=${getStored(me, 'cd.tech.blink-step')}`)
}

{
  /*
   * ⚠ 四个 side 都要对。这是几何，不是行为 —— 错了的话表现是
   *   "瞬移过去了，但站在奇怪的地方"，而那很容易被当成"手感问题"。
   */
  const dirs: Record<string, [number, number]> = {
    behind: [0, -1],   // 目标朝向 +y → 背后是 -y
    front: [0, 1],
    left: [-1, 0],     // 目标朝向 +y 的左手边是 -x
    right: [1, 0],
  }

  for (const [side, [ex, ey]] of Object.entries(dirs)) {
    const w = createWorld({ seed: 1 })
    /*
     * ⚠ 瞄准在**技能**上（2026-09-21 日志 47）：这一段把那句 `targeting`
     *   搬到了**技能**定义上（下一条注释里那个 `probeBlink`）——
     *   术式那一层已经没有这个字段了。
     */
    const probeBlink: Skill = {
      ...(lib.skills.get('skill.blink') as Skill),
      // 用 locked + targetId，把"选谁"这件事从测试里排除掉，只测落点
      targeting: { mode: 'locked', valid: ['enemy'], range: 30 },
    }
    const tech = compileTechnique({
      schemaVersion: 1,
      id: `tech.test-blink-${side}`,
      name: `瞬影·${side}`,
      // ⚠ 系别必填（schema 的 Technique.kind）：瞬影是魔法术式
      kind: 'magic',
      activation: 'press',
      skills: [probeBlink.id],
    }, id => (id === probeBlink.id ? probeBlink : undefined))

    const me = spawn(w, { faction: 'player', pos: { x: 0, y: 0 }, base: { 'char.hp.max': 100, 'char.energy.max': 100 } })
    const t = spawn(w, { faction: 'enemy', pos: { x: 5, y: 0 }, facing: { x: 0, y: 1 }, base: { 'char.hp.max': 100 } })

    // 把内容里的 blink 改成要测的那一侧
    const compiled = JSON.parse(JSON.stringify(tech.compiled))
    compiled.rules[0].then[0].payload.side = side
    registerTechnique(w, compiled)

    activate(w, me, compiled, { intent: { kind: 'entity', id: t.id } })
    advance(w, 30)

    const gotX = me.pos.x - t.pos.x
    const gotY = me.pos.y - t.pos.y
    ok(`  ${side}：落在目标 (${ex * 1.5}, ${ey * 1.5}) 米处`,
      Math.abs(gotX - ex * 1.5) < 0.01 && Math.abs(gotY - ey * 1.5) < 0.01,
      `实际 (${gotX.toFixed(2)}, ${gotY.toFixed(2)})`)
  }
}

{
  // 没有目标 → 什么都不发生（不是"退化成朝前闪"）
  const w = createWorld({ seed: 1 })
  const me = spawn(w, { faction: 'player', pos: { x: 0, y: 0 }, facing: { x: 1, y: 0 }, base: { 'char.hp.max': 100, 'char.energy.max': 100 } })
  registerTechnique(w, blinkStep)
  activate(w, me, blinkStep, { intent: { kind: 'none' } })
  advance(w, 30)
  ok('没有带标记的目标 → 原地不动（不退化成"朝前闪"）',
    me.pos.x === 0 && me.pos.y === 0,
    `(${me.pos.x}, ${me.pos.y})`)
}

// ============================================================================
//  3. 新积木：按状态标签选目标
// ============================================================================

section('新积木：`requireStatusTag` —— 挑的是"我标过的那个"，不是"最近的"')

{
  const { w, me, near, far } = arena()
  /*
   * ⚠ 这里刻意让**远的那个**吃到标记：如果 targeting 还按"最近"挑，
   *   第二段会闪到 near 身后 —— 而那正是玩家会遇到的"我明明标了它"的困惑。
   *
   * 做法：先把 near 挪到射程外（14 米），于是第一段只能标到 far；
   * 标完再把 near 挪回 3 米（比 far 的 9 米更近），再看第二段挑谁。
   */
  near.pos.x = 40
  pressSequence(w, me, container, { intent: { kind: 'none' } })
  settle(w)
  ok('标记打在了当时唯一够得着的那个（far）身上', hasStatusTag(far, 'marked'))
  near.pos.x = 3

  const r = pressSequence(w, me, container, { intent: { kind: 'none' } })
  ok('第二段挑的是**带标记的那个**（far，9 米），不是最近的那个（near，3 米）',
    r.ok && r.index === 1, JSON.stringify({ index: r.index, tech: r.cast?.technique.id }))
  settle(w)
  ok('  于是落点在 far 的背后，而不是 near 背后',
    Math.abs(me.pos.x - far.pos.x) < 0.5 && Math.abs(me.pos.y - (far.pos.y - 1.5)) < 0.5,
    `玩家 (${me.pos.x.toFixed(2)}, ${me.pos.y.toFixed(2)})，far (${far.pos.x}, ${far.pos.y})，near (${near.pos.x}, ${near.pos.y})`)
}

// ============================================================================
//  4. 新积木：序列之间的条件门**真的生效**
// ============================================================================

section('新积木：序列条件门（"有标记才瞬移"）')

{
  const { w, me, near } = arena()
  pressSequence(w, me, container, { intent: { kind: 'none' } })
  settle(w)

  // 把标记清掉（模拟"标记过期了"）
  near.statuses.length = 0

  const r = pressSequence(w, me, container, { intent: { kind: 'none' } })
  ok('没有标记时按第二下 → **跳过瞬移**，回到第一段（重新标记）',
    r.ok && r.index === 0 && r.cast?.technique.id === 'tech.mark-step',
    JSON.stringify({ index: r.index, tech: r.cast?.technique.id }))

  settle(w)
  ok('  而且它真的把标记打回去了', hasStatusTag(near, 'marked'))
}

{
  /*
   * ⚠ 门不成立时**不该**把段号卡在第二段上。
   *   卡住的话玩家会陷入"按一下没反应、按一下没反应"，
   *   而他完全不知道是因为标记没了。
   */
  const { w, me, near } = arena()
  pressSequence(w, me, container, { intent: { kind: 'none' } })
  settle(w)
  near.statuses.length = 0
  pressSequence(w, me, container, { intent: { kind: 'none' } })
  settle(w)
  ok('跳过之后链上留的是"下一段是第一段"（不会卡在第二段）',
    me.chain?.next === 1, JSON.stringify(me.chain))
}

// ============================================================================
//  5. 端到端：连按两次，人会出现在标记目标背后
// ============================================================================

section('端到端：连按两次（用内容里那一份容器，不改任何东西）')

{
  const { w, me, near } = arena()
  pressSequence(w, me, container, { intent: { kind: 'none' } })
  settle(w)
  pressSequence(w, me, container, { intent: { kind: 'none' } })
  settle(w)

  ok('两下之后玩家在 near 的背后 1.5 米',
    Math.abs(me.pos.x - near.pos.x) < 0.01 && Math.abs(me.pos.y - (near.pos.y - 1.5)) < 0.01,
    `玩家 (${me.pos.x.toFixed(2)}, ${me.pos.y.toFixed(2)})，near (${near.pos.x}, ${near.pos.y})`)

  ok('两段加起来只花了两次按键（没有第三段）',
    (container.segments ?? []).length === 2)
}

// ============================================================================
//  5b. 第二段在冷却 → **不激活这条序列**，游标回第一条等着（日志 49）
// ============================================================================

section('第二段在冷却时按下：不激活这条序列，指针回第一条等按键')

{
  /*
   * ⚠ 玩家 2026-09-21 定的（**日志 49** 改的口径）：
   *   > 如果一条序列中有技能正在 CD，则不激活这条序列并给出提示，
   *   > 然后指针指到下一条序列**等待按键触发**。
   *
   *   在真实内容上走一遍：第二段（瞬影）8 秒 CD、第一段（标记）没有 CD。
   *   ⚠ 要钉住的正是**"没有替你改放第一段的标记"**这一条 ——
   *     以前（日志 46 那一版）会当场把能放的那一段打出去，玩家看到的是
   *     "我按的是第二段，怎么丢出去一个标记"。
   */
  const { w, me } = arena()
  pressSequence(w, me, container, { intent: { kind: 'none' } })   // ① 标记（不进 CD）
  settle(w)
  pressSequence(w, me, container, { intent: { kind: 'none' } })   // ② 瞬影（进 8 秒 CD）
  settle(w)
  ok('前置：第二段真的进了冷却', getStored(me, 'cd.tech.blink-step') > 0,
    `cd=${getStored(me, 'cd.tech.blink-step')}`)

  pressSequence(w, me, container, { intent: { kind: 'none' } })   // ③ 第一段又能放（标记）
  settle(w)
  const r = pressSequence(w, me, container, { intent: { kind: 'none' } })  // ④ 轮到第二段，它在 CD
  ok('第二段在冷却时按下 → 这一下**什么都不放**（没有替你改放第一段的标记）',
    !r.ok && r.reason === 'cooldown' && w.casts.length === 0,
    JSON.stringify({ ok: r.ok, reason: r.reason, casts: w.casts.length }))
  ok('  指针回到**第一条**（第一段没 CD，下一次按键就用它）',
    me.chain?.next === 0, JSON.stringify({ next: me.chain?.next }))
  ok('  提示说得清是**哪一条 + 还剩多久**',
    r.cooldown?.techniqueId === 'tech.blink-step' && r.cooldown.remaining > 0
    && r.cooldown.allCooling === false,
    JSON.stringify(r.cooldown))
}

// ============================================================================
//  6. 确定性
// ============================================================================

section('二段技能：跑两遍逐字节一致')

{
  function run(): string {
    const { w, me, near } = arena()
    pressSequence(w, me, container, { intent: { kind: 'none' } })
    advance(w, 10)
    pressSequence(w, me, container, { intent: { kind: 'none' } })
    advance(w, 40)
    return JSON.stringify({
      me: [me.pos.x, me.pos.y],
      near: [near.pos.x, near.pos.y],
      next: me.chain?.next,
      cd: getStored(me, 'cd.tech.blink-step'),
      statuses: near.statuses.map(s => s.defId),
    })
  }
  ok('同一串按键跑两遍，结果一样', run() === run())
}

// ============================================================================
//  7. 内容本身
// ============================================================================

section('内容：那一份容器里两段各自的职责')

{
  const containerDef = readJson<Technique>(resolve('content/internal-techniques/mark-blink.json'))
  ok('容器只挂序列、不带技能',
    (containerDef.sequences ?? []).length === 2 && containerDef.skills === undefined)

  /*
   * ⚠ 2026-09-21（日志 46）**段现在自带技能**，所以"它里面是什么"也在这里核。
   *
   *   这一条是这次迁移最该被钉住的东西：内联之前"第一段用 `skill.mark`、
   *   第二段用 `skill.blink`"这件事写在**两份单独的文件**里，
   *   而 `npm run validate` 会把那两份各自校验一遍。内联之后它们只是
   *   容器里的两个对象 —— 写错一个技能名，唯一的哨兵就是这条断言
   *   （以及校验器的 `UNKNOWN_SKILL`）。
   */
  ok('  两段各自带着它的技能（标记 → 瞬影）',
    containerDef.sequences?.[0] !== undefined && typeof containerDef.sequences[0] !== 'string'
    && containerDef.sequences[0].skills.join(',') === 'skill.mark'
    && containerDef.sequences[1] !== undefined && typeof containerDef.sequences[1] !== 'string'
    && containerDef.sequences[1].skills.join(',') === 'skill.blink',
    JSON.stringify(containerDef.sequences?.map(s => (typeof s === 'string' ? s : s.skills))))

  /*
   * ⚠ 段的 `id` **必须显式写下来，而且必须是旧子术式那个 id** ——
   *   它就是冷却键（`cd.<id>`），而"第一段不进 CD、第二段进 CD"正是靠它成立的。
   *   丢了 id 的话，键会变成合成的 `tech.mark-blink.seq0`，
   *   而下面几条（和存档里的冷却）就全对不上了。
   */
  ok('  两段的 id 沿用旧子术式的 id（冷却键，行为逐位不变的前提）',
    containerDef.sequences?.[0] !== undefined && typeof containerDef.sequences[0] !== 'string'
    && containerDef.sequences[0].id === 'tech.mark-step'
    && containerDef.sequences[1] !== undefined && typeof containerDef.sequences[1] !== 'string'
    && containerDef.sequences[1].id === 'tech.blink-step',
    JSON.stringify(containerDef.sequences?.map(s => (typeof s === 'string' ? s : s.id))))

  ok('第一段（标记）没写冷却 —— 玩家要的"不进 CD"',
    (markStep.phases.flatMap(p => (p.cost?.cooldown !== undefined ? [p.cost.cooldown] : []))).length === 0)
  ok('第二段（瞬影）有冷却',
    blinkStep.phases.some(p => (p.cost?.cooldown ?? 0) > 0))

  /*
   * ⚠ **2026-09-21（日志 47）这条改的是"从哪儿读"，不是"读什么"。**
   *
   *   上一片（日志 46 内联）钉的是 `SequenceSegment.targeting` 里那句
   *   `requireStatusTag: 'marked'`（当时它还是过渡遗留、运行时真的会读它）。
   *   这一片瞄准搬到了**技能层**，段上那个字段删掉了 ——
   *   所以现在读的是 **`skill.blink` 的 `targeting`**。
   *
   *   ⇒ 断言的意思一个字没变：**第二段必须挑"我标过的那个"**，
   *     而不是"最近的那个"（丢了这句话，瞬影会闪到最近的敌人背后）。
   *     编译时 `targetingOfChain` 会把它从技能取进段的编译产物，
   *     所以行为还是原来那一条（上面第 3 节那几条断言原样钉着它）。
   */
  const blinkSkill = lib.skills.get('skill.blink')
  ok('  瞬影自己的 targeting 写了 requireStatusTag: marked（从段搬到了技能上）',
    blinkSkill?.targeting?.requireStatusTag === 'marked',
    JSON.stringify(blinkSkill?.targeting))

  ok('  这一段的编译产物里也是那一份（编译时从技能取来的，行为不变）',
    blinkStep.targeting.requireStatusTag === 'marked',
    JSON.stringify(blinkStep.targeting))

  // ⚠ 走 allRulesOf：瞬影的载荷住在 `effect` 里（"这个技能是什么"）
  const action = (blinkSkill === undefined ? [] : allRulesOf(blinkSkill))[0]?.then[0]
  ok('瞬影的载荷是 anchor: target + side: behind',
    action?.payload.kind === 'displacement'
    && action.payload.anchor === 'target'
    && action.payload.side === 'behind',
    JSON.stringify(action?.payload))
}

console.log('')
if (failed > 0) {
  console.log(`✗ ${failed} 个断言失败（${passed} 个通过）`)
  process.exitCode = 1
} else {
  console.log(`✓ 全部 ${passed} 个断言通过`)
}
