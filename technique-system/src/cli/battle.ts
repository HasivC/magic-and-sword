/**
 * 战斗运行器：多个 AI 单位打一场，然后告诉你结果。
 *
 * 和 `run.ts` 的区别：
 *   run.ts    一份术式，一对一，看**这个技能**是怎么跑的
 *   battle.ts 一份场景，多对多，看**这场仗**是怎么打的
 *
 * 前四步做出来的东西全都在这里碰头：AI、投射物、管线、阶段机、
 * 状态、阵营查询。任何一个环节不对，这里都会露馅。
 *
 * 用法：
 *   node src/cli/battle.ts content/scenarios/duel.json
 *   node src/cli/battle.ts content/scenarios/duel.json --duration 40
 */
import { resolve } from 'node:path'
import { readJson } from '../loader.ts'
import { loadLibrary } from '../bridge.ts'
import {
  createWorld, factionOf, getStored, resolveAttribute, stepWorld,
} from '../sim/index.ts'
import type { BalanceConfig } from '../validator/types.ts'
import type { Entity, SimEvent } from '../sim/index.ts'
import type { Scenario } from '../schema.ts'
import { applyScenario, lowerScenario } from '../scenario.ts'

// ---------------------------------------------------------------- 颜色

const COLOR = process.stdout.isTTY === true && process.env.NO_COLOR === undefined
function paint(code: string, s: string): string {
  return COLOR ? `\x1b[${code}m${s}\x1b[0m` : s
}
const dim = (s: string) => paint('2', s)
const bold = (s: string) => paint('1', s)
const red = (s: string) => paint('31', s)
const yellow = (s: string) => paint('33', s)
const green = (s: string) => paint('32', s)
const cyan = (s: string) => paint('36', s)

const LINE = '─'.repeat(72)

function fmt(n: number): string {
  const r = Math.round(n * 10) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

// ---------------------------------------------------------------- 统计

interface Stats {
  entity: Entity
  label: string
  dealt: number
  taken: number
  kills: number
  casts: number
}

function main(): number {
  const argv = process.argv.slice(2).filter(a => !a.startsWith('--'))
  const file = argv[0]
  const durIdx = process.argv.indexOf('--duration')
  const overrideDuration = durIdx >= 0 ? Number(process.argv[durIdx + 1]) : undefined

  if (file === undefined) {
    console.log(`
用法：
  node src/cli/battle.ts <场景.json> [--duration N]

例：
  node src/cli/battle.ts content/scenarios/duel.json
  node src/cli/battle.ts content/scenarios/duel.json --duration 40
`)
    return 2
  }

  const balance = readJson<BalanceConfig>(resolve('content/balance.json'))
  const lib = loadLibrary(balance)

  // 编译不出来的术式（引用了不存在的技能）必须当场说清楚，不能悄悄变成空技能
  if (lib.problems.length > 0) {
    console.log('')
    for (const p of lib.problems) console.log(`  ${red(`✗ ${p.message}`)}`)
    return 1
  }

  let scenario: Scenario
  try {
    scenario = readJson<Scenario>(resolve(file))
  } catch (e) {
    console.error(red(`✗ ${(e as Error).message}`))
    return 1
  }

  console.log('')
  console.log(bold('战斗运行器') + dim('  ·  多个 AI 单位打一场'))
  console.log(LINE)
  console.log(`  ${dim('场景')}  ${bold(scenario.name)} ${dim(`· ${scenario.id}`)}`)
  console.log('')

  // ---- 装配 ----
  // 翻译和装配都在 src/scenario.ts 里，浏览器用的是同一份 —— 两边行为必须一致
  const lowered = lowerScenario(scenario, id => lib.compiled.get(id), [], [], [...lib.weapons.values()])
  if (lowered.problems.length > 0) {
    console.log('')
    for (const m of lowered.problems) console.log(`  ${red('✗ ' + m)}`)
    return 1
  }

  const world = createWorld({ seed: lowered.seed })
  const stats: Stats[] = []

  console.log(`  ${bold('参战')}`)
  const roster = applyScenario(world, lowered)
  for (const def of lowered.entities) {
    const e = roster.get(def.label)
    if (e === undefined) continue
    /*
     * ⚠ 地上的东西（`kind: 'item'`）**不算参战单位**。
     *   它是场景的一部分（比如一把等着被捡的剑），
     *   打进战果表里会多出一行"剩余 0 / 0"的怪东西。
     */
    if (def.control === 'none') continue

    const list = (def.init.techniqueIds ?? []).join('，') || dim('（无）')
    const weapon = e.weapon !== undefined ? dim(` 武器 ${e.weapon.name}`) : ''
    console.log(`    ${bold(def.label.padEnd(10))} ${factionOf(e).padEnd(8)} HP ${resolveAttribute(e, 'char.hp.max', { world, self: e })}   技能 ${list}${weapon}`)
    stats.push({ entity: e, label: def.label, dealt: 0, taken: 0, kills: 0, casts: 0 })
  }

  const byId = new Map<number, Stats>()
  for (const s of stats) byId.set(s.entity.id, s)

  const nameOf = (id: number): string => byId.get(id)?.label ?? `#${id}`

  console.log('')
  console.log(LINE)

  // ---- 打 ----
  // 场景没写 duration（= 不限时，浏览器里就是打到死）时，命令行给一个够长的默认值
  const duration = overrideDuration ?? (lowered.duration >= 0 ? lowered.duration : 60)
  const ticks = Math.round(duration / world.dt)
  const timeline: { t: number, text: string }[] = []
  let nextBloodLine = 5

  for (let i = 0; i < ticks; i++) {
    stepWorld(world)
    const t = (i + 1) * world.dt

    for (const ev of world.events) {
      const text = narrate(ev, byId, nameOf)
      if (text !== undefined) timeline.push({ t, text })
      tally(ev, byId)
    }

    // 每 5 秒插一行血线，不然时间轴读起来没有节奏
    if (t >= nextBloodLine) {
      nextBloodLine += 5
      const line = stats
        .map(s => `${s.label} ${fmt(getStored(s.entity, 'char.hp.current'))}`)
        .join(dim('  vs  '))
      timeline.push({ t, text: dim(`— ${line} —`) })
    }

    const alive = stats.filter(s => s.entity.alive)
    if (alive.length <= 1) break
  }

  console.log(`  ${bold('时间轴')}`)
  const shown = condense(timeline)
  for (const item of shown) {
    console.log(`    ${dim(`t=${item.t.toFixed(2)}s`.padEnd(12))} ${item.text}`)
  }
  const hidden = timeline.length - shown.length
  if (hidden > 0) console.log(`    ${dim(`（省略 ${hidden} 条重复事件）`)}`)
  console.log('')

  // ---- 战果 ----
  console.log(`  ${bold('战果')}`)
  for (const s of stats) {
    const hpMax = resolveAttribute(s.entity, 'char.hp.max', { world, self: s.entity })
    const hp = getStored(s.entity, 'char.hp.current')
    const state = s.entity.alive ? `${fmt(hp)} / ${fmt(hpMax)}` : red('阵亡')
    console.log(
      `    ${bold(s.label.padEnd(10))} 剩余 ${state.padEnd(12)} `
      + `${cyan(`造成 ${fmt(s.dealt)}`)}   ${yellow(`承受 ${fmt(s.taken)}`)}   `
      + `击杀 ${s.kills}   施法 ${s.casts} 次`,
    )
  }
  console.log('')

  const alive = stats.filter(s => s.entity.alive)
  const verdict = alive.length === 0
    ? red('同归于尽')
    : alive.length === stats.length
      ? dim('时间到，双方都还活着')
      : green(`${alive.map(s => s.label).join('、')} 获胜`)
  console.log(`  ${verdict}`)
  console.log(LINE)

  return 0
}

// ---------------------------------------------------------------- 事件叙述

/** 只叙述"看得懂"的事件。castPhase 这种噪声一律丢掉 */
function narrate(ev: SimEvent, byId: Map<number, Stats>, nameOf: (id: number) => string): string | undefined {
  switch (ev.type) {
    case 'castStarted': {
      const s = byId.get(ev.casterId)
      if (s !== undefined) s.casts++
      return `${nameOf(ev.casterId)} 施放 ${short(ev.techniqueId)}`
    }
    case 'castInterrupted':
      return yellow(`${nameOf(ev.casterId)} 的 ${short(ev.techniqueId)} 被打断`)
    case 'castBlocked':
      return undefined
    case 'damaged':
      return `${nameOf(ev.entityId)} 受到 ${bold(fmt(ev.amount))} 伤害`
        + (ev.lethal ? red(' [必杀]') : '')
    case 'healed':
      return green(`${nameOf(ev.entityId)} 回复 ${fmt(ev.amount)}`)
    case 'died':
      return red(`${nameOf(ev.entityId)} 阵亡`)
    case 'statusApplied':
      // 状态挂得太频繁，只报"第一次获得"
      return undefined
    case 'displaced': {
      const how = ev.mode === 'knockback' ? '被击退'
        : ev.mode === 'pull' ? '被拉近'
          : ev.mode === 'teleport' ? '瞬移' : '冲刺'
      return cyan(`${nameOf(ev.entityId)} ${how} ${fmt(ev.distance)} 米`)
    }
    default:
      return undefined
  }
}

function short(techniqueId: string): string {
  return techniqueId.startsWith('tech.') ? techniqueId.slice(5) : techniqueId
}

function tally(ev: SimEvent, byId: Map<number, Stats>): void {
  switch (ev.type) {
    case 'damaged': {
      const target = byId.get(ev.entityId)
      if (target !== undefined) target.taken += ev.amount
      const src = byId.get(ev.sourceId)
      if (src !== undefined && src.entity.id !== ev.entityId) src.dealt += ev.amount
      return
    }
    case 'healed': {
      const t = byId.get(ev.entityId)
      if (t !== undefined) t.taken -= ev.amount
      return
    }
    case 'died': {
      const killer = byId.get(ev.killerId)
      if (killer !== undefined && killer.entity.id !== ev.entityId) killer.kills++
      return
    }
    default:
      return
  }
}

/** 把连续重复的叙述压成一条。AI 打架会刷出大量一模一样的事件 */
function condense(items: { t: number, text: string }[]): { t: number, text: string }[] {
  const out: { t: number, text: string }[] = []
  let prev = ''
  let repeats = 0

  for (const item of items) {
    if (item.text === prev) {
      repeats++
      continue
    }
    if (repeats > 0) {
      out.push({ t: item.t, text: dim(`（上一条重复了 ${repeats} 次）`) })
      repeats = 0
    }
    out.push(item)
    prev = item.text
  }
  if (repeats > 0) out.push({ t: 0, text: dim(`（最后一条重复了 ${repeats} 次）`) })
  return out
}

process.exitCode = main()
