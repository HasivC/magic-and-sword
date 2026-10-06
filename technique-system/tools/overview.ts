/**
 * 内容总览：把全部技能和术式压成一张表。
 *
 * 做内容设计的时候看这个 —— 它回答的是"我手上到底有什么"：
 *   每个术式用了哪几个技能、什么激活方式、每条规则在什么时机做什么、
 *   用了哪几种载荷和载体。
 *
 * ⚠ 它和 `npm run validate` 的分工：
 *     validate  回答"这个内容对不对"（点数、引用、结构）
 *     overview  回答"这个内容是什么"（机制覆盖面、有没有重复）
 *
 * 加内容之前先跑一遍，能一眼看出哪些机制还是零内容 ——
 * 这一轮补的护盾 / 霸体 / 冻结，就是这么找出来的。
 *
 * 用法：
 *   npm run overview            # 全部
 *   npm run overview -- cleave  # 只看名字里带 cleave 的
 *
 * ⚠ 末尾的"机制覆盖"**永远是全局统计**，不受过滤影响 ——
 *   过滤掉之后还显示"零内容"会误导（第一版就是这么写的）。
 */
import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { readJson } from '../src/loader.ts'
import { allRulesOf } from '../src/effects.ts'
import type { Rule, Skill, StatusDef, Technique } from '../src/schema.ts'
import { SKILL_DIRS } from '../src/school.ts'

const TECHNIQUES = 'content/internal-techniques'
const STATUS_DIR = 'content/statuses'

/** 一条规则做了什么：载荷 + 载体 */
function describeRule(r: Rule): { when: string, payloads: string[], deliveries: string[] } {
  const payloads: string[] = []
  const deliveries = new Set<string>()

  for (const a of r.then ?? []) {
    const p = a.payload
    if (p === undefined) continue
    let s: string = p.kind
    if (p.kind === 'damage') s += `(${p.damageType ?? '无属性'})`
    if (p.kind === 'status') {
      const what = p.statusId ?? (p.inline !== undefined ? `inline:${p.inline.id}` : '?')
      s += `(${p.verb} ${what}${p.inline !== undefined ? ' ' + JSON.stringify(p.inline.tags) : ''})`
    }
    if (p.kind === 'attribute') s += `(${p.path} ${p.op})`
    if (p.kind === 'displacement') s += `(${p.mode})`
    if (p.kind === 'perception') s += `(${p.mode})`
    if (p.kind === 'spawn') s += `(${p.entityId})`
    payloads.push(s)
    if (a.delivery !== undefined) deliveries.add(a.delivery.kind)
  }

  return { when: r.when, payloads, deliveries: [...deliveries] }
}

/** 状态里那些"零内容机制"的开关，单独列出来 —— 这正是要盯的东西 */
function statusMechanics(s: Skill): string[] {
  const out: string[] = []
  const seen = new Set<unknown>()

  const visit = (st: { tags?: string[], disables?: string[], immuneTags?: string[], visibility?: number, hooks?: { stage: string, absorb?: unknown }[] }): void => {
    if (seen.has(st)) return
    seen.add(st)
    if ((st.disables?.length ?? 0) > 0) out.push(`disables=[${st.disables?.join(',')}]`)
    if ((st.immuneTags?.length ?? 0) > 0) out.push(`immuneTags=[${st.immuneTags?.join(',')}]`)
    if (st.visibility !== undefined) out.push(`visibility=${st.visibility}`)
    for (const h of st.hooks ?? []) {
      if (h.absorb !== undefined) out.push(`absorb(${JSON.stringify(h.absorb)})`)
    }
    for (const h of st.hooks ?? []) {
      // 嵌套状态：钩子的动作里还可能挂状态
      for (const a of (h as { then?: { payload?: { inline?: never } }[] }).then ?? []) {
        const inl = a.payload?.inline
        if (inl !== undefined) visit(inl)
      }
    }
  }

  for (const r of allRulesOf(s)) {
    for (const a of r.then ?? []) {
      const p = a.payload
      if (p !== undefined && p.kind === 'status') {
        if (p.inline !== undefined) visit(p.inline)
      }
    }
  }
  return out
}

const filter = process.argv.slice(2)
const hit = (s: string): boolean => filter.length === 0 || filter.some(f => s.includes(f))

/**
 * 技能 id → 技能，用来查技能链。
 *
 * ⚠ **两个目录都要读**（`SKILL_DIRS` = `content/skills` + `content/weapon-skills`）。
 *   只读前者的话，武器术式那两份（`iron-sword-basic` / `longsword-basic`）
 *   会显示"✗ 技能不存在：skill.ws-slash" —— 技能明明在，是工具只读了半个库。
 *   这和 `src/bridge.ts` / `tests/smoke.ts` 读的是同一张合并表。
 */
const skills = new Map<string, Skill>()
for (const dir of SKILL_DIRS) {
  if (!existsSync(dir)) continue
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    const s = readJson<Skill>(resolve(dir, f))
    skills.set(s.id, s)
  }
}

const coverage = new Map<string, string[]>()

/*
 * ⚠ 术式有两张表：**技能表**（`skills`）和**序列表**（`sequences`）。
 *
 *   挂了序列的术式**不写 `skills`**（schema 里是二选一），所以
 *   `for (const sid of t.skills)` 会**当场抛** —— 而 `npm run overview`
 *   正是加内容前后都要跑的那个工具，抛了就等于这个工具废了。
 *   踩到的时机很典型：一份术式改成序列式之后，这个工具第一个坏。
 *   所以下面一律走 `skillIdsDeep`（它自己会 `?? []`）。
 *
 * ⚠ 2026-09-21（日志 46）序列**内联**之后，往下走那一层不再需要查表 ——
 *   段自带 `skills`。但**老形状**（字符串 id）仍然要查，
 *   所以 `techniqueById` 和 `seen` 都留着。
 */

/** 按 id 取序列 —— 老形状（字符串引用）才用得上 */
const techniqueById = new Map<string, Technique>()
for (const f of readdirSync(TECHNIQUES)) {
  if (!f.endsWith('.json')) continue
  const t = readJson<Technique>(resolve(TECHNIQUES, f))
  techniqueById.set(t.id, t)
}

/**
 * 这门术式**直接或顺着序列**用到的技能 id。
 *
 * ⚠ 必须往下走一层：武器术式（`tech.iron-sword-basic`）自己一个技能都不带，
 *   技能长在它的**序列**里。不展开的话总览上它是空的 ——
 *   "我手上到底有什么"这个工具最不该漏的就是这种。
 *
 * ⚠ 内联的段**直接读 `skills`**；老形状的字符串才去查表。
 *   `seen` 防循环只对老形状有意义（内联的段是值，构不成环），
 *   但它留在同一处更省事，也免得以后有人把两条路合起来时忘了防环。
 */
function skillIdsDeep(t: Technique): string[] {
  const out: string[] = []
  const seen = new Set<string>([t.id])
  const queue: Technique[] = [t]
  while (queue.length > 0) {
    const cur = queue.pop() as Technique
    for (const sid of cur.skills ?? []) out.push(sid)
    for (const seg of cur.sequences ?? []) {
      if (typeof seg !== 'string') {
        for (const sid of seg.skills) out.push(sid)
        continue
      }
      if (seen.has(seg)) continue
      seen.add(seg)
      const next = techniqueById.get(seg)
      if (next !== undefined) queue.push(next)
    }
  }
  return [...new Set(out)]
}

/** 所有技能过一遍，统计机制覆盖 —— **不受过滤影响**，覆盖是全局的事实 */
for (const f of readdirSync(TECHNIQUES)) {
  if (!f.endsWith('.json')) continue
  const t = readJson<Technique>(resolve(TECHNIQUES, f))
  for (const sid of skillIdsDeep(t)) {
    const s = skills.get(sid)
    if (s === undefined) continue
    for (const m of statusMechanics(s)) {
      const key = m.split(/[=([]/)[0] ?? m
      const list = coverage.get(key) ?? []
      // 同一个技能被多个术式引用时只记一次
      const who = `${s.name}(${f.replace('.json', '')})`
      if (!list.includes(who)) list.push(who)
      coverage.set(key, list)
    }
  }
}

/*
 * ⚠ 状态库也要扫。
 *
 *   灵光盾的 absorb 钩子搬进了 content/statuses/shield.json，
 *   只扫技能的话覆盖率会显示"absorb 1 处（背水）"——
 *   把已经做过的机制报成半空。
 */
if (existsSync(STATUS_DIR)) {
  for (const f of readdirSync(STATUS_DIR)) {
    if (!f.endsWith('.json')) continue
    const st = readJson<StatusDef>(resolve(STATUS_DIR, f))
    for (const m of statusMechanics({ rules: [{ id: 'x', when: 'onCast', order: 0, then: [{ payload: { kind: 'status', verb: 'apply', inline: st } }] }] } as Skill)) {
      const key = m.split(/[=([]/)[0] ?? m
      const list = coverage.get(key) ?? []
      const who = `${st.name ?? st.id}(状态库)`
      if (!list.includes(who)) list.push(who)
      coverage.set(key, list)
    }
  }
}

let shown = 0

for (const f of readdirSync(TECHNIQUES).sort()) {
  if (!f.endsWith('.json')) continue
  const t = readJson<Technique>(resolve(TECHNIQUES, f))
  if (!hit(f) && !hit(t.id) && !hit(t.name)) continue
  shown++

  console.log('─'.repeat(78))
  console.log(`${t.name}  ${t.id}`)
  /*
   * ⚠ **瞄准在技能上**（2026-09-21 日志 47）：术式不再有 `targeting` 了，
   *   所以这里顺着 `skillIdsDeep(t)` 取**第一个带瞄准的技能**那一份 ——
   *   和编译器 `targetingOfChain` 是同一条规矩（"这条链怎么瞄"）。
   *   ⚠ 找不到（技能文件缺失 / 链是空的）时**照实说**，别印一个假读数。
   */
  const aim = skillIdsDeep(t)
    .map(id => skills.get(id)?.targeting)
    .find(x => x !== undefined)
  console.log(`  激活 ${t.activation}   目标 ${aim === undefined ? '（链上没有技能带瞄准）' : `${aim.mode} / 有效 [${aim.valid.join(', ')}]`}`)
  if ((t.tags ?? []).length > 0) console.log(`  标签 ${(t.tags ?? []).join(' ')}`)

  for (const sid of skillIdsDeep(t)) {
    const s = skills.get(sid)
    if (s === undefined) {
      console.log(`  ✗ 技能不存在：${sid}`)
      continue
    }
    console.log(`  ▸ ${s.name}  ${s.id}   规则位 ${s.ruleSlots}`)
    console.log(`    阶段 ${(s.phases ?? []).map(p =>
      `${p.id}(${p.duration === -1 ? '蓄力' : p.duration + 's'}${p.interrupt !== undefined ? ',' + p.interrupt : ''}${p.cost !== undefined ? ',' + JSON.stringify(p.cost) : ''})`).join(' ')}`)

    // ⚠ 走 allRulesOf：固有效果也要列出来（不然大多数技能看起来"什么都没做"）
    for (const r of allRulesOf(s).sort((a, b) => a.order - b.order)) {
      const d = describeRule(r)
      const cond = (r.if ?? []).length > 0 ? ` 若[${(r.if ?? []).map(c => c.type).join(',')}]` : ''
      const every = r.every !== undefined ? ` 每${r.every}s` : ''
      console.log(`    [${r.order}] ${d.when}${r.phaseId !== undefined ? '/' + r.phaseId : ''}${cond}${every}`)
      console.log(`         → ${d.payloads.join(' + ')}${d.deliveries.length > 0 ? '   载体 ' + d.deliveries.join('/') : ''}`)
      if (r.note !== undefined) console.log(`         「${r.note}」`)
    }

    // 机制覆盖在下面统一打印（全局统计，不在这里累加）
  }
}

console.log('─'.repeat(78))
console.log(`共 ${shown} 个术式${filter.length > 0 ? '（已过滤）' : ''}`)

/*
 * ---- 机制覆盖 ----
 *
 * ⚠ 这里要扫的东西比"状态字段"多得多。
 *
 *   第一版只数了 disables / immuneTags / absorb / visibility 四个状态字段，
 *   于是加了「潜行」（perception 的 setVisibility）之后它仍然报
 *   "visibility ⚠ 零内容" —— 因为可见性是**载荷在运行时**设的，
 *   内容里根本不会出现那个字段。一个会误报"零内容"的覆盖率工具，
 *   比没有还糟：它会让你以为自己还没做某个机制。
 *
 *   所以现在分四类扫：载荷种类 / 载体 / 载荷的 mode / 触发时机。
 *   这些是**内容里真的写了什么**，和引擎有没有实现是两件事。
 */
type Bucket = Map<string, string[]>

const payloads: Bucket = new Map()
const carriers: Bucket = new Map()
const modes: Bucket = new Map()
const triggers: Bucket = new Map()

const bump = (b: Bucket, key: string, who: string): void => {
  const list = b.get(key) ?? []
  if (!list.includes(who)) list.push(who)
  b.set(key, list)
}

for (const f of readdirSync(TECHNIQUES)) {
  if (!f.endsWith('.json')) continue
  const t = readJson<Technique>(resolve(TECHNIQUES, f))
  const who = f.replace('.json', '')
  for (const sid of skillIdsDeep(t)) {
    const s = skills.get(sid)
    if (s === undefined) continue
    for (const r of allRulesOf(s)) {
      bump(triggers, r.when, who)
      for (const a of r.then ?? []) {
        if (a.delivery !== undefined) bump(carriers, a.delivery.kind, who)
        const p = a.payload
        if (p === undefined) continue
        bump(payloads, p.kind, who)
        // 带 mode 的载荷（位移 / 感知）：mode 才是真正的机制
        const mode = (p as { mode?: string }).mode
        if (typeof mode === 'string') bump(modes, `${p.kind}.${mode}`, who)
      }
    }
  }
}

const ALL_PAYLOADS = ['damage', 'heal', 'attribute', 'status', 'displacement', 'perception', 'spawn']
const ALL_CARRIERS = ['self', 'projectile', 'beam', 'meleeArc', 'capsule', 'area', 'aura', 'spawn']
const ALL_MODES = [
  'displacement.knockback', 'displacement.pull', 'displacement.teleport', 'displacement.dash',
  'perception.reveal', 'perception.mark', 'perception.setVisibility',
]
const ALL_TRIGGERS = [
  'onCast', 'onHit', 'onMiss', 'onCrit', 'onNonCrit', 'onKill',
  'onExpire', 'onRemoved', 'onEnter', 'onLeave',
  'onDamaged', 'onLethalDamage', 'onLowHp', 'onTick',
  'phaseEnter', 'phaseComplete', 'phaseInterrupt',
]

function report(title: string, b: Bucket, all: string[]): void {
  console.log(`\n${title}`)
  for (const k of all) {
    const users = b.get(k) ?? []
    console.log(`  ${k.padEnd(22)} ${users.length === 0
      ? '⚠ 零内容'
      : `${String(users.length).padStart(2)} 处  ${users.slice(0, 4).join(', ')}${users.length > 4 ? ' …' : ''}`}`)
  }
  // 内容里出现了但不在清单里的（说明清单该更新了）
  for (const [k, users] of b) {
    if (all.includes(k)) continue
    console.log(`  ${k.padEnd(22)} ? ${users.join(', ')}  ← 不在清单里，补进上面那几行`)
  }
}

report('载荷覆盖', payloads, ALL_PAYLOADS)
report('载体覆盖', carriers, ALL_CARRIERS)
report('位移 / 感知的模式', modes, ALL_MODES)
report('触发时机覆盖', triggers, ALL_TRIGGERS)

console.log('\n状态字段（写在状态定义里的那几种）')
for (const k of ['disables', 'immuneTags', 'absorb', 'visibility']) {
  const users = coverage.get(k) ?? []
  console.log(`  ${k.padEnd(22)} ${users.length === 0 ? '⚠ 零内容' : `${users.length} 处  ${users.join(', ')}`}`)
}
