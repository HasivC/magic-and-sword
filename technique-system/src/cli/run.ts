/**
 * 运行器：把一份技能或术式 JSON 真的跑起来，然后把发生了什么打出来。
 *
 * 存在的意义：校验器只能告诉你"这份数据说得通"，
 * 它**不能**告诉你"这个技能按下去会发生什么"。
 * 前摇多长、伤害什么时候落地、能量什么时候扣、CD 从哪一刻开始走 ——
 * 这些只有真跑一遍才知道。
 *
 * ## 两层模型在这里的样子
 *
 * 你可以给它一个**术式**，也可以给它一个**技能**：
 *
 *   - 给术式 → 直接编译它引用的技能链，跑。
 *   - 给技能 → 找出哪个术式用了它，跑那个术式（`--tech` 指定用哪个）。
 *              如果没有任何术式用它，就现场包一个临时术式跑 ——
 *              刚写完一个技能还没接进术式的时候，这是唯一的验证办法。
 *
 * 用法：
 *   node src/cli/run.ts content/internal-techniques/cleave.json
 *   node src/cli/run.ts content/skills/cleave.json
 *   node src/cli/run.ts content/skills/cleave.json --tech tech.longsword-basic
 */
import { resolve } from 'node:path'
import { readJson, shortPath, LoadError } from '../loader.ts'
import { installTechnique, loadLibrary } from '../bridge.ts'
import type { Library } from '../bridge.ts'
import {
  activate, createWorld, dealDamage, factionOf, getStored, normalize2, releaseCharge,
  resolveAttribute, setStored, setTechniqueActive, spawn, stepWorld,
} from '../sim/index.ts'
import type { BalanceConfig, ValidationReport } from '../validator/types.ts'
import { validateSkill, validateTechnique } from '../validator/index.ts'
import type { Skill, Technique } from '../schema.ts'
import type { Entity, SimEvent, World } from '../sim/index.ts'
import type { ValueContext } from '../sim/index.ts'
import { compileTechnique, localId, ownerOf } from '../sim/compile.ts'
import type { CompiledTechnique } from '../sim/compile.ts'
import { priceRule, priceSkill, readRates } from '../pricing.ts'
import { allRulesOf } from '../effects.ts'
import type { Rates } from '../pricing.ts'
import { describeRule } from '../describe.ts'
import { schoolOfSkillFile } from '../school.ts'

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

/**
 * 数字格式化。
 *
 * 模拟核里是浮点：60 次 1/60 加起来是 3.0000000000000004，
 * 曲线插值之后伤害会变成 149.99999999999974。
 * 这种事不该出现在玩家眼前 —— 显示层负责抹平，模拟层不用管。
 */
function fmt(n: number): string {
  const r = Math.round(n * 10) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

// ---------------------------------------------------------------- 参数

interface Args {
  file: string
  ticks: number
  distance: number
  regen: number
  charge: number
  /** 给技能文件用：用哪个术式去跑它 */
  tech: string | undefined
}

function parseArgs(argv: string[]): Args | undefined {
  const positional: string[] = []
  let ticks = 180
  let distance = 1.5
  let regen = 0
  let charge = 1.5
  let tech: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined) continue
    if (a === '--ticks') { ticks = Number(argv[++i] ?? 180); continue }
    if (a === '--distance') { distance = Number(argv[++i] ?? 1.5); continue }
    if (a === '--regen') { regen = Number(argv[++i] ?? 0); continue }
    if (a === '--charge') { charge = Number(argv[++i] ?? 1.5); continue }
    if (a === '--tech') { tech = argv[++i]; continue }
    if (!a.startsWith('--')) positional.push(a)
  }

  const file = positional[0]
  if (file === undefined) return undefined
  return { file, ticks, distance, regen, charge, tech }
}

function usage(): void {
  console.log(`
用法：
  node src/cli/run.ts <技能.json | 术式.json> [选项]

选项：
  --ticks N       跑多少 tick（默认 180，即 3 秒）
  --distance N    目标和施法者的距离，米（默认 1.5）
  --regen N       施法者每秒回多少能量（默认 0，方便看清代价扣在哪一刻）
  --charge N      蓄力技蓄多少秒后自动松手（默认 1.5）
  --tech ID       给技能文件指定用哪个术式去跑它

例：
  node src/cli/run.ts content/internal-techniques/longsword-basic.json
  node src/cli/run.ts content/skills/cleave.json
  node src/cli/run.ts content/skills/charged-laser.json --charge 3
  node src/cli/run.ts content/skills/magic-bolt.json --tech tech.longsword-basic
`)
}

// ---------------------------------------------------------------- 事件渲染

/**
 * 实体的显示名。
 *
 * 用一张表记住，而不是现查 —— 实体死了会被移出 world.entities，
 * 那时候再查就只能显示 `#2`。事件是在移除**之前**推出来的，
 * 所以只要在捕获事件时顺手记一笔，名字就一直有。
 */
type Labels = Map<number, string>

function remember(world: World, labels: Labels): void {
  for (const e of world.entities) {
    if (labels.has(e.id)) continue
    labels.set(e.id, factionOf(e) === 'player' ? 'A' : 'B')
  }
}

function labelOf(labels: Labels, id: number): string {
  return labels.get(id) ?? `#${id}`
}

function describe(labels: Labels, ev: SimEvent): string | undefined {
  switch (ev.type) {
    case 'castStarted': return `开始施法 ${ev.techniqueId}`
    // 阶段 id 带技能前缀（`skill.cleave#swing`），那是编译器加的。给人看的时候去掉
    case 'castPhase': return `进入阶段「${localId(ev.phaseId)}」`
    case 'castFinished': return green('施法完成')
    case 'castInterrupted': return yellow(`被打断（阶段「${localId(ev.phaseId)}」）`)
    case 'castBlocked': return yellow(`放不出来：${ev.reason}`)
    case 'damaged':
      return `${labelOf(labels, ev.entityId)} 受到 ${bold(fmt(ev.amount))} 伤害`
        + (ev.absorbed > 0 ? dim(`（护盾挡了 ${fmt(ev.absorbed)}）`) : '')
        + (ev.lethal ? red(' [必杀]') : '')
    case 'healed': return green(`${labelOf(labels, ev.entityId)} 回复 ${fmt(ev.amount)}`)
    case 'statusApplied': return `${labelOf(labels, ev.entityId)} 获得 ${cyan(ev.statusId)} ×${ev.stacks}`
    case 'statusExpired': return dim(`${labelOf(labels, ev.entityId)} 失去 ${ev.statusId}`)
    case 'statusImmune': return dim(`${labelOf(labels, ev.entityId)} 免疫了 ${ev.statusId}（${ev.byStatus}）`)
    case 'hitIntercepted': return yellow(`${labelOf(labels, ev.entityId)} 的致命伤被拦下（${ev.byStatus}）`)
    case 'shieldBroken': return `${labelOf(labels, ev.entityId)} 的护盾碎了`
    case 'displaced': {
      const how = ev.mode === 'knockback' ? '被击退'
        : ev.mode === 'pull' ? '被拉拽'
          : ev.mode === 'teleport' ? '瞬移' : '冲刺'
      return cyan(`${labelOf(labels, ev.entityId)} ${how} ${fmt(ev.distance)} 米`)
    }
    case 'died': return red(`${labelOf(labels, ev.entityId)} 死了`)
    case 'spawned':
    case 'removed':
      return undefined
    default:
      return undefined
  }
}

// ---------------------------------------------------------------- 输出

/** 把阶段规划画成一条时间轴 */
function printPlan(tech: CompiledTechnique): void {
  console.log(`  ${bold('阶段规划')}`)
  let t = 0
  for (const p of tech.phases) {
    const len = p.duration < 0 ? yellow('玩家控制') : `${p.duration.toFixed(2)}s`
    // 打断等级三档：越扛得住越是绿的
    const level = p.interrupt ?? 'damage'
    const flags: string[] = [
      level === 'damage' ? dim('挨打就断') : level === 'control' ? yellow('只被控制打断') : green('无法打断'),
      p.occupiesCaster ? cyan('持续') : '脱手',
    ]
    if (p.cancellable) flags.push('可取消')

    const cost: string[] = []
    if (p.cost?.energy !== undefined) cost.push(`能量 ${p.cost.energy}`)
    if (p.cost?.cooldown !== undefined) cost.push(`CD ${p.cost.cooldown}s`)
    if (p.cost?.hp !== undefined) {
      cost.push(`生命 ${p.cost.hpIsPercent === true ? `${p.cost.hp * 100}%` : p.cost.hp}`)
    }

    const head = p.duration < 0 ? '蓄力' : `${t.toFixed(2)}s`
    console.log(
      `    ${head.padStart(7)}  ${bold(p.name ?? p.id).padEnd(14)} ${len.padStart(11)}  `
      + dim(flags.join(' / '))
      + (cost.length > 0 ? red(`   代价 ${cost.join('，')}`) : ''),
    )
    if (p.duration >= 0) t += p.duration
  }
  console.log(`    ${''.padStart(7)}  ${dim(`总时长 ${t.toFixed(2)}s`)}`)
  console.log('')
}

/**
 * 规则列表 —— 让玩家看清"什么时候发生什么"。
 *
 * ⚠ 中间那句话是**生成的**（`describeRule`），不是 JSON 里的 `note`。
 *   手写的说明会和数值脱节：改了伤害，它还写着旧数字。
 *   `note` 只作为设计意图挂在后面（小字）。
 *
 * ⚠ 点数**也不是**从规则上读的，是现算的（`priceRule`）。
 *   规则上的 id 带技能前缀（`skill.cleave#hit`），所以先反查出它属于哪个技能，
 *   再用技能内的原始 id 找那条规则。这样改任何数值，这一列立刻跟着变。
 */
function printRules(tech: CompiledTechnique, lib: Library, rates: Rates): void {
  const sorted = [...tech.rules].sort((a, b) => a.order - b.order)

  /*
   * ⚠ 固有效果和规则**分两栏**（玩家 2026-09-21 第 1 条）。
   *
   *   编译产物里它们已经折成同一种东西了（效果 = 一条 phaseComplete 规则），
   *   所以"这一条是不是效果"要回内容里查：它是不是雇主技能 `effect` 里的那个 id。
   *   不查的话，命令行的清单会把"这个技能是什么"和"它额外做了什么"混在一起 ——
   *   而那正是玩家要分开的两件事。
   */
  const columns = [
    { title: '固有效果', rows: sorted.filter(r => isEffectOf(tech, r.id, lib)) },
    { title: '规则', rows: sorted.filter(r => !isEffectOf(tech, r.id, lib)) },
  ]

  for (const col of columns) {
    if (col.rows.length === 0) continue
    console.log(`  ${bold(col.title)}`)
    for (const r of col.rows) {
      /*
       * ⚠ 找的是**内容里的那一条**：编译产物里的 id 带技能前缀，
       *   所以先反查出它属于哪个技能，再在 `allRulesOf` 里找 ——
       *   只查 `rules` 的话，固有效果那几条会变成"找不到"，
       *   显示成 id + 0 点（看起来像"这一下不花钱"，其实是查错了地方）。
       */
      const owner = lib.skills.get(ownerOf(r.id))
      const local = owner === undefined
        ? undefined
        : allRulesOf(owner).find(x => x.id === localId(r.id))
      const pts = local === undefined ? 0 : Math.round(priceRule(local, rates) * 100) / 100
      const shown = pts > 0 ? green(`+${pts}`) : pts < 0 ? cyan(String(pts)) : dim('0')

      const phase = local?.phaseId !== undefined
        ? owner?.phases.find(p => p.id === local.phaseId)?.name ?? localId(local.phaseId)
        : undefined
      const text = local !== undefined ? describeRule(local, phase) : r.id
      const intent = local?.note !== undefined && local.note !== '' ? dim(`　（${local.note}）`) : ''
      const ownerTag = owner === undefined ? '' : dim(` [${owner.name}]`)

      console.log(`    ${shown.padStart(6)}  ${text}${intent}${ownerTag}`)
    }
    console.log('')
  }
}

/** 这条编译产物里的规则，是不是某个技能的**固有效果**折出来的 */
function isEffectOf(tech: CompiledTechnique, ruleId: string, lib: Library): boolean {
  const owner = lib.skills.get(ownerOf(ruleId))
  if (owner === undefined) return false
  const local = localId(ruleId)
  return (owner.effect ?? []).some(e => e.id === local)
}

/**
 * 手感检查。
 *
 * 这几条代码不会报错，但打起来是错的 ——
 * 只有把阶段规划摆出来才看得见。
 */
function lintFeel(tech: CompiledTechnique): void {
  const notes: string[] = []
  const last = tech.phases[tech.phases.length - 1]

  if (last !== undefined) {
    const hitsOnLastFrame = tech.rules.some(r =>
      r.when === 'phaseComplete'
      && r.phaseId === last.id
      && (r.then ?? []).some(a => a.payload?.kind === 'damage' || a.payload?.kind === 'heal'))
    if (hitsOnLastFrame) {
      notes.push('命中帧就是最后一帧 —— 没有后摇。打完之后可以立刻移动，打起来会"飘"。'
        + '建议在它后面补一个短的后摇阶段。')
    }
  }

  if (tech.phases.every(p => (p.interrupt ?? 'damage') === 'damage')) {
    notes.push('所有阶段都是"挨打就断" —— 高强度技能通常该有一段扛打断的释放帧，'
      + '否则太容易被白嫖。（打断等级：挨打就断 / 只被控制打断 / 无法打断）')
  }

  if (tech.phases.every(p => p.duration >= 0) && tech.phases.length === 1) {
    notes.push('只有一个阶段 —— 前摇和命中挤在一起，玩家没有反应和取消的空间。')
  }

  if (notes.length === 0) return
  console.log(`  ${yellow('手感提醒')}`)
  for (const n of notes) console.log(`    ${yellow('!')} ${n}`)
  console.log('')
}

function printFinal(world: World, a: Entity, b: Entity): void {
  console.log(`  ${bold('结束状态')}  ${dim(`（跑了 ${world.tick} tick = ${(world.tick * world.dt).toFixed(2)}s）`)}`)
  for (const e of [a, b]) {
    const name = factionOf(e) === 'player' ? 'A（施法者）' : 'B（目标）'
    /*
     * ⚠ 查询属性必须带上下文。
     *
     * 状态修饰里可能写了动态参数（无下限的 `ref: 'distance'`），
     * 不给 ctx 的话 resolveAttribute 会直接抛错 —— 这是故意的，
     * 静默算个错误的值比崩掉危险得多。
     */
    const ctx: ValueContext = { world, self: e }
    const hpMax = resolveAttribute(e, 'char.hp.max', ctx)
    const hp = `${fmt(getStored(e, 'char.hp.current'))} / ${fmt(hpMax)}`
    const enMax = resolveAttribute(e, 'char.energy.max', ctx)
    const en = enMax > 0
      ? `   能量 ${fmt(getStored(e, 'char.energy.current'))} / ${fmt(enMax)}`
      : ''
    const cd = [...e.stored.entries()]
      .filter(([k, v]) => k.startsWith('cd.') && v > 0)
      .map(([k, v]) => `   ${k.slice(3)} 冷却剩 ${v.toFixed(2)}s`)
      .join('')
    console.log(`    ${bold(name.padEnd(12))} HP ${hp}${en}${cd}`)

    // 位置 + 移速倍率 —— 减速类效果的唯一可见证据
    const scale = resolveAttribute(e, 'char.moveScale', ctx)
    const scaleTxt = Math.abs(scale - 1) > 1e-9
      ? `   ${cyan(`移速 ×${scale.toFixed(2)}`)}`
      : ''
    console.log(`    ${''.padEnd(12)} 位置 (${e.pos.x.toFixed(1)}, ${e.pos.y.toFixed(1)})${scaleTxt}`)

    if (e.statuses.length > 0) {
      const st = e.statuses
        .map(s => {
          const dur = s.remaining < 0 ? '永久' : `剩 ${s.remaining.toFixed(1)}s`
          return `${s.name}${s.stacks > 1 ? `×${s.stacks}` : ''}（${dur}）`
        })
        .join('，')
      console.log(`    ${''.padEnd(12)} 状态：${st}`)
    }
    if (!e.alive) console.log(`    ${''.padEnd(12)} ${red('☠ 已死')}`)
  }
  console.log('')
}

// ---------------------------------------------------------------- 选目标

/**
 * 术式有激活方式；技能有阶段。靠形状分辨，不靠目录名。
 *
 * ⚠ 判据是「有 activation」，不是「有 skills」——**序列术式一个技能都不带**
 *   （只挂 `sequences`，武器术式基本都长这样）。只认 skills 的话，
 *   跑 `duel --tech tech.longsword-basic` 会把它当成技能，
 *   然后炸在 `skill.phases.forEach of undefined` 上。
 */
function looksLikeTechnique(v: unknown): boolean {
  if (v === null || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (typeof o.activation !== 'string') return false
  return Array.isArray(o.skills) || Array.isArray(o.sequences)
}

interface Target {
  tech: CompiledTechnique
  report: ValidationReport
  /** 一行说明这次跑的术式是怎么来的 */
  origin: string
  /** 如果跑的是单个技能，带上它，好显示点数 */
  skill: Skill | undefined
}

type TargetResult = Target | string

function pickTarget(args: Args, lib: Library, balance: BalanceConfig): TargetResult {
  let raw: unknown
  try {
    raw = readJson<unknown>(args.file)
  } catch (e) {
    const msg = e instanceof LoadError ? e.message : String(e)
    return `读不到 ${shortPath(resolve(args.file))}：${msg}`
  }

  // ---- 情况一：给的是术式 ----
  if (looksLikeTechnique(raw)) {
    const fileTech = raw as Technique
    const known = lib.compiled.get(fileTech.id)
    if (known !== undefined) {
      return {
        tech: known,
        report: validateTechnique(args.file, fileTech),
        origin: dim('（内容库里的术式）'),
        skill: undefined,
      }
    }
    // 内容库外的术式：现场编译，技能从库里查
    const res = compileTechnique(fileTech, id => lib.skills.get(id))
    if (res.problems.length > 0) {
      return res.problems.map(p => p.message).join('\n  ')
    }
    return {
      tech: res.compiled,
      report: validateTechnique(args.file, fileTech),
      origin: dim('（不在内容库里，现场编译）'),
      skill: undefined,
    }
  }

  // ---- 情况二：给的是技能 ----
  const skill = raw as Skill
  const report = validateSkill(args.file, skill, balance)
  const errors = report.issues.filter(i => i.level === 'error')
  if (errors.length > 0) {
    return `技能校验没过：\n  ${errors.map(i => `[${i.code}] ${i.path}：${i.message}`).join('\n  ')}`
  }

  // 这个技能可能是库外的文件 —— 查表时把它自己补进去
  const lookup = (id: string): Skill | undefined =>
    id === skill.id ? skill : lib.skills.get(id)

  const uses = (lib.usedBy.get(skill.id) ?? []).filter(id => lib.techniques.has(id))

  let techId: string | undefined
  if (args.tech !== undefined) {
    const chosen = lib.techniques.get(args.tech)
    if (chosen === undefined) return `内容库里没有术式 ${args.tech}`
    if (!(chosen.skills ?? []).includes(skill.id)) {
      return `术式「${chosen.name}」并没有用到技能「${skill.name}」`
    }
    techId = chosen.id
  } else if (uses.length > 0) {
    techId = uses[0]
  }

  if (techId !== undefined) {
    const chosen = lib.techniques.get(techId)
    const known = lib.compiled.get(techId)
    if (chosen !== undefined && known !== undefined) {
      return {
        tech: known,
        report,
        origin: dim(`（技能「${skill.name}」→ 术式「${chosen.name}」）`),
        skill,
      }
    }
  }

  // 没有任何术式用它 —— 现场包一个，否则刚写完的技能根本没法验证
  const adhoc: Technique = {
    schemaVersion: 1,
    id: 'adhoc',
    name: `${skill.name}（临时术式）`,
    note: '技能还没接进任何术式，运行器临时包了一层',
    /*
     * ⚠ 系别要和**这个技能文件所在的目录**同系（见 src/school.ts）：
     *   拿一份武器技能当魔法术式跑，读的是**缺省**武器属性（reach 2.5 / damage 1），
     *   而真实那一刀的数值是装在哪把武器决定的 —— 运行器打出来的数就成了假的。
     *   （技能对象自己身上没有 `school`：这一份是从参数指定的文件现读的，
     *     没走过加载器。）
     */
    kind: schoolOfSkillFile(args.file),
    activation: 'press',
    /*
     * ⚠ 瞄准在**技能**上（2026-09-21 日志 47），所以这份临时术式**不写**它 ——
     *   编译时 `compileTechnique` 会从 `skill.targeting` 取（`targetingOfChain`）。
     *   取到的就是玩家给这份技能文件写的那个瞄准，也就是运行器该复现的那一个。
     */
    skills: [skill.id],
  }
  const res = compileTechnique(adhoc, lookup)
  return {
    tech: res.compiled,
    report,
    origin: dim('（没有术式用它，临时包了一层）'),
    skill,
  }
}

// ---------------------------------------------------------------- 主流程

function main(): number {
  const args = parseArgs(process.argv.slice(2))
  if (args === undefined) {
    usage()
    return 2
  }

  const balancePath = resolve('content/balance.json')
  let balance: BalanceConfig
  try {
    balance = readJson<BalanceConfig>(balancePath)
  } catch (e) {
    console.error(red(`读不到 ${shortPath(balancePath)}：${(e as Error).message}`))
    return 1
  }

  console.log('')
  console.log(bold('运行器') + dim('  ·  技能 / 术式装进模拟核真跑一遍'))
  console.log(LINE)

  // ---- 加载整个内容库：编译需要看到所有技能 ----
  let lib: Library
  try {
    lib = loadLibrary(balance)
  } catch (e) {
    const msg = e instanceof LoadError ? e.message : String(e)
    console.error(red('✗ 内容库加载失败'))
    console.error(`  ${msg}`)
    return 1
  }

  const rates = readRates(balance.rates)

  // ---- 这次要跑什么 ----
  const target = pickTarget(args, lib, balance)
  if (typeof target === 'string') {
    console.error(red(`✗ ${target}`))
    return 2
  }

  const { tech, report, origin, skill } = target
  if (tech.phases.length === 0) {
    console.error(red('✗ 这个术式编译出来一个阶段都没有，没什么可跑的。'))
    return 2
  }

  console.log(`  ${dim('文件')}  ${shortPath(resolve(args.file))}`)
  console.log(`  ${dim('跑的是')}  ${bold(tech.name)} ${dim(`· ${tech.id}`)}  ${dim(origin)}`)
  if (skill !== undefined) {
    const p = priceSkill(skill, {
      rates,
      baseRuleSlots: balance.baseRuleSlots,
      ruleSlotBuyCost: balance.ruleSlotBuyCost,
      ruleSlotSellGain: balance.ruleSlotSellGain,
    })
    // 正 = 收益（绿），负 = 代价（蓝）
    const shown = p.total > 0 ? green(`+${p.total}`) : p.total < 0 ? cyan(String(p.total)) : bold('0')
    /*
     * ⚠ 2026-09-30（日志 57）这里原来印的是"已配平（容差 ±2）" / "没配平"。
     *   容差删掉之后判据只剩"合计 < 0 才是负值术式"——
     *   而且这一行是**绝对账**（内部强度标尺），更不该有红绿灯。
     */
    const verdict = p.kind === 'negative'
      ? cyan(`负值术式 · 每次释放消耗 ${Math.abs(p.total)} 血契`)
      : dim('合计 ≥ 0 · 能用')
    console.log(`  ${dim('点数')}  ${shown}  ${verdict}`)
  }
  console.log(`  ${dim('激活')}  ${tech.activation}    ${dim('目标')}  ${tech.targeting.mode} → ${tech.targeting.valid.join(' / ')}`)
  console.log(`  ${dim('技能链')}  ${tech.skillIds.map(id => lib.skills.get(id)?.name ?? id).join(dim(' → '))}`)
  console.log(`  ${green('✓ 校验通过')}`)

  const warnings = report.issues.filter(i => i.level === 'warning')
  if (warnings.length > 0) {
    console.log(`  ${yellow(`⚠ ${warnings.length} 条警告`)}`)
    for (const w of warnings) console.log(`      ${dim(`[${w.code}]`)} ${w.message}`)
  }
  console.log('')

  printPlan(tech)
  printRules(tech, lib, rates)
  lintFeel(tech)

  // ---- 建场景 ----
  const world = createWorld({ seed: 1 })
  const a = spawn(world, {
    faction: 'player',
    pos: { x: 0, y: 0 },
    base: { 'char.hp.max': 200, 'char.energy.max': 100, 'char.energy.regen': args.regen },
  })
  const b = spawn(world, {
    faction: 'enemy',
    pos: { x: args.distance, y: 0 },
    base: { 'char.hp.max': 200 },
  })
  // 施法者面朝目标，不然扇形打不到
  a.facing = normalize2({ x: b.pos.x - a.pos.x, y: b.pos.y - a.pos.y })
  setStored(a, 'char.energy.current', 100)

  /*
   * 让 B 一直朝 A 走。
   *
   * 减速类效果（无下限那种）光看状态列表是看不出效果的 ——
   * 得让它真的走，然后量它走了多远。这是唯一诚实的验证方式。
   */
  b.vel = { x: -2, y: 0, z: 0 }

  const installed = installTechnique(world, tech)

  console.log(`  ${bold('场景')}`)
  console.log(`    A（施法者）  player   HP 200  能量 100  位置 (0, 0)`)
  console.log(`    B（目标）    enemy    HP 200  位置 (${args.distance}, 0)   朝 A 走 2 米/秒`)
  console.log(`    注册了 ${installed.length} 个内联状态：${installed.map(s => s.id).join('，') || dim('（无）')}`)
  console.log('')

  // ---- 真跑 ----
  const timeline: { t: number, text: string }[] = []
  const labels: Labels = new Map()

  const capture = (t: number): void => {
    // 先把这一刻还在场上的实体记下名字，再解释事件 ——
    // 否则被打死的那个下一 tick 就查不到了
    remember(world, labels)
    for (const ev of world.events) {
      const text = describe(labels, ev)
      if (text !== undefined) timeline.push({ t, text })
    }
  }

  // 只对 self 有效的术式不该锁定敌人 —— 否则自我增益会挂到敌人头上
  const selfOnly = tech.targeting.valid.length > 0
    && tech.targeting.valid.every(v => v === 'self')

  let castId: number | undefined
  let releaseAtTick = -1

  if (tech.activation === 'auto') {
    setTechniqueActive(world, a, tech.id, true)
    console.log(`  ${dim('常驻被动：不需要按键，直接挂上')}`)
    console.log('')
  } else {
    if (tech.activation === 'toggle') {
      setTechniqueActive(world, a, tech.id, true)
    }
    const res = activate(world, a, tech, selfOnly ? {} : { targetId: b.id })
    if (!res.ok) {
      console.log(`  ${red(`✗ 第一步就放不出来：${res.reason}`)}`)
      return 1
    }
    castId = res.cast.id
    /*
     * 蓄力技（有 duration = -1 的阶段）：跑到指定秒数就"松手"。
     *
     * 没有这一步的话，蓄力阶段永远不结束 ——
     * "伤害随蓄力量增长"这条路径在真内容上就永远验不到。
     */
    if (tech.phases.some(p => p.duration < 0)) {
      releaseAtTick = Math.max(1, Math.round(args.charge / world.dt))
    }
  }
  capture(0)

  // 不管哪种激活方式，时间都要往前走 —— auto 被动也不例外
  for (let i = 0; i < args.ticks; i++) {
    stepWorld(world)
    const t = (i + 1) * world.dt

    if (i + 1 === releaseAtTick && castId !== undefined) {
      timeline.push({ t, text: cyan(`— 松开蓄力键（蓄了 ${args.charge}s）—`) })
      releaseCharge(world, castId)
    }
    capture(t)
  }

  // ---- 探针：让 B 打 A 一下，看反应式钩子（onDamaged / onLethalDamage）有没有生效 ----
  // 术式里如果写了 onLethalDamage，探针就改成必杀 —— 否则永远测不到那条分支
  const hasLethalRule = tech.rules.some(r => r.when === 'onLethalDamage')
  const probeAmount = hasLethalRule ? 9999 : 20
  const probeMode = hasLethalRule ? 'lethal' as const : 'normal' as const

  const probeAt = Math.max(1, Math.round(args.ticks * world.dt * 1000) / 1000)
  const aHpBefore = getStored(a, 'char.hp.current')
  const bHpBefore = getStored(b, 'char.hp.current')
  const probeHit = dealDamage(world, b.id, a.id, probeAmount, { mode: probeMode })
  timeline.push({
    t: probeAt,
    text: dim(`— 探针：B 打了 A 一下（${hasLethalRule ? '必杀' : `${probeAmount} 点`}）—`),
  })
  capture(probeAt)

  for (let i = 0; i < 30; i++) {
    stepWorld(world)
    capture(probeAt + (i + 1) * world.dt)
  }

  const lost = aHpBefore - getStored(a, 'char.hp.current')
  const reflected = bHpBefore - getStored(b, 'char.hp.current')
  const reacted = probeHit.intercepted || lost !== probeAmount || reflected > 0

  console.log(`  ${bold('发生了什么')}`)
  if (timeline.length === 0) {
    console.log(`    ${dim('什么都没发生')}`)
  }
  for (const item of timeline) {
    console.log(`    ${dim(`t=${item.t.toFixed(3)}s`.padEnd(13))} ${item.text}`)
  }
  console.log('')

  // 探针结论 —— 反应式钩子有没有真的接上，看这一行
  if (reacted) {
    const parts: string[] = []
    if (probeHit.intercepted) parts.push(red('致命伤被拦截'))
    else parts.push(`A 掉了 ${fmt(lost)} 点（原始 ${probeAmount}）`)
    if (reflected > 0) parts.push(`B 被反伤 ${fmt(reflected)} 点`)
    console.log(`  ${green('探针：反应式钩子生效')} —— ${parts.join('，')}`)
  } else {
    console.log(`  ${dim(`探针：没有反应式钩子，A 正常掉了 ${probeAmount} 点`)}`)
  }
  console.log('')

  printFinal(world, a, b)

  console.log(LINE)
  return 0
}

process.exitCode = main()
