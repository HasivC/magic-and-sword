import { resolve } from 'node:path'
import { collectJsonFiles, readJson, shortPath, LoadError } from '../loader.ts'
import { validateSkill, validateTechnique, validateWeapon } from '../validator/index.ts'
import { checkBalance, checkLookupCoverage, checkRefs, validateModifierProto, validateStatus } from '../validator/checks.ts'
import { readLookupTable } from '../pricing.ts'
import { SKILL_DIRS, MODIFIER_SKILL_DIR, schoolOfSkillFile, stampSchool } from '../school.ts'
import type { EntityDef, ModifierProto, Skill, StatusDef, Technique, WeaponDef } from '../schema.ts'
import type { BalanceConfig, Issue, ValidationReport } from '../validator/types.ts'

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

/*
 * 技能内容分散在两个目录，但它们是**同一张技能表**：
 *   content/skills/        玩家能编辑的技能（零件）—— **魔法系**
 *   content/weapon-skills/ 武器自带的技能模板（只读）—— **武器系**
 * 术式按 id 引用技能时不区分自己引的是哪一边，所以建表要两边都收。
 *
 * ⚠ 目录清单从 `src/school.ts` 拿（那里同时是"目录 → 系别"的真相）——
 *   在这里再抄一份的话，加第三个技能目录时校验器会**看不见它**，
 *   而那种漏法是静默的（那些技能不参与建表 → 术式一律报"引用不到技能"）。
 */

// ---------------------------------------------------------------- 输出小工具
function mark(level: 'error' | 'warning'): string {
  return level === 'error' ? red('✗') : yellow('!')
}

/** 一组检查的勾叉：结构 ✓   规则 ✓   点数 ✗ 2 */
function groupLine(r: ValidationReport): string {
  const parts = r.groups.map((g) => {
    if (g.errors > 0) return `${g.name} ${red(`✗${g.errors > 1 ? ` ${g.errors}` : ''}`)}`
    if (g.warnings > 0) return `${g.name} ${yellow(`!${g.warnings > 1 ? ` ${g.warnings}` : ''}`)}`
    return `${g.name} ${green('✓')}`
  })
  return '  ' + parts.join(dim('   '))
}

function printIssues(issues: Issue[]): void {
  const errors = issues.filter(i => i.level === 'error')
  const warnings = issues.filter(i => i.level === 'warning')
  const ordered = [...errors, ...warnings]
  if (ordered.length === 0) return

  for (const i of ordered) {
    const head = i.level === 'error' ? red('错误') : yellow('警告')
    console.log(`  ${mark(i.level)} ${head} ${dim(`[${i.code}]`)} ${dim(i.path)}`)
    console.log(`      ${i.message}`)
    if (i.hint) console.log(`      ${dim('→ ' + i.hint)}`)
    console.log('')
  }
}

function printLedger(r: ValidationReport, isTechnique: boolean): void {
  if (r.ledger.length === 0) return

  console.log(`  ${bold('点数明细')}`)
  const width = Math.max(...r.ledger.map(e => String(e.points).length), 4)

  for (const e of r.ledger) {
    const n = String(e.points).padStart(width)
    const colored = e.points > 0 ? green(n) : e.points < 0 ? cyan(n) : dim(n)
    const tag = e.from === 'rule' ? '' : dim(` (${e.from === 'phase' ? '阶段' : '规则位'})`)
    console.log(`    ${colored}  ${e.label}${tag}`)
  }

  const total = String(r.total).padStart(width)

  /*
   * ⚠ 判据在**术式**上，不在技能上。
   *
   *   技能是零件：出厂状态下它就是 0 点（宗旨），玩家改过之后可以很歪 ——
   *   纯收益的爆发、纯代价的长冷却收招都是合法的。
   *   所以技能这一栏**不给红绿灯**，给红灯就是假警报。
   *
   * ⚠ 这里打的是**绝对**账（内部强度标尺）：它回答的是"这个技能站在
   *   `content/balance.json` 那张汇率表的哪个位置"，**不是**"它配平了吗"。
   *   玩家在编辑器里看到的是另一个数 —— **相对出厂值的差**（见 `skillLedger`）。
   */
  console.log(`    ${dim('─'.repeat(width + 40))}`)

  if (!isTechnique) {
    console.log(`    ${total}  ${bold('绝对强度')} ${dim('·')}  ${
      dim('内部标尺，不判配平 —— 出厂技能在宗旨下就是 0 点；玩家改了多少看编辑器')}`)
    console.log('')
    return
  }

  /*
   * 术式是成品：这一栏有红绿灯。
   *
   * ⚠ 账是**相对出厂值的差**（宗旨）—— 出厂术式全是 0，
   *   有数字就说明玩家改过什么东西。
   *
   * ⚠⚠ 判据 2026-09-30（日志 57）**只剩一条**，用户原话：
   *   > 点数之和大于 0 就能用，小于 0 就要支付血契才能用
   *   ⇒ **合计 ≥ 0 = 能用（绿）**、**合计 < 0 = 负值术式（要付血契）**。
   *   ⚠ 以前这里还有一条"容差 ±2"：合计为正但没配平到 0 会打红灯 ——
   *     **那条连同"容差"一起删了**，"额度没用完"不再是问题。
   */
  const usable = r.kind !== 'negative'

  const verdict = usable ? green('✓') : dim('血契')
  const kindLabel = r.kind === 'negative'
    ? `负值术式 · 合计 ${r.total}，每次释放消耗 ${r.bloodPactPerUse} 血契`
    : `能用 · 合计 ${r.total}（≥ 0）`

  console.log(`    ${total}  ${bold('合计')} ${verdict}  ${dim(kindLabel)}`)
  console.log('')
}

// ---------------------------------------------------------------- 主流程
function usage(): void {
  console.log(`
用法：
  node src/cli/validate.ts <文件或目录> [更多路径...]

例：
  npm run validate
  npm run validate -- content/skills
  npm run validate -- content/internal-techniques/longsword-basic.json

不带参数时扫全部内容目录（技能 / 武器技能 / 术式 / 武器）。
技能是**零件**（可以不平衡），术式是**成品**（⚠ 判据：**合计 ≥ 0 就能用，< 0 要付血契** ——
2026-09-30 日志 57 起**没有"配平容差"这回事了**）。
武器不带账 —— 它带的是属性，强度体现在代入技能之后的术式上。

退出码：0 通过 · 1 有错误 · 2 用法错误
`)
}

/**
 * 技能有 phases，术式有激活方式 + 技能引用列表 —— 靠形状分辨，不靠目录名。
 *
 * ⚠ 判据是"有 activation"，不是"有 skills"：术式可以**只挂序列**
 *   （武器术式基本都这样，见 schema 的三层模型），那种术式没有 skills 字段。
 *   只认 skills 的话纯序列术式会被当成技能丢进 validateSkill，
 *   然后炸在 `phases.forEach of undefined` 上 —— 报的是校验器自己的 bug，不是内容的问题。
 */
function looksLikeTechnique(v: unknown): boolean {
  if (v === null || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (typeof o.activation !== 'string') return false
  return Array.isArray(o.skills) || Array.isArray(o.sequences)
}

/**
 * 武器定义。**也是靠形状**：一张属性表 + 两个术式槽。
 *
 * ⚠ 它必须排在技能前面判 —— 武器没有 phases、没有 rules、没有 activation，
 *   丢进 validateSkill 会炸在 `phases.forEach of undefined` 上。
 *   判据里带上 `attributes` 是刻意的：那是武器唯一必有的字段。
 */
function looksLikeWeapon(v: unknown): boolean {
  if (v === null || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (typeof o.activation === 'string') return false
  if (Array.isArray(o.phases) || Array.isArray(o.rules)) return false
  if (o.attributes === null || typeof o.attributes !== 'object') return false
  return typeof o.id === 'string'
}

/**
 * **修饰原型**（`content/modifiers/`，2026-09-21 日志 48）。
 *
 * ⚠ 它必须排在技能的判断**之前**，而且判据要**宽**：原型没有 `phases`、
 *   没有 `rules`、没有 `activation` —— 丢进 `validateSkill` 会炸在
 *   `phases.forEach of undefined` 上（校验器自己的 bug，不是内容的问题）。
 *
 * 判据：带 `kind`。取值非法也照样认成原型 —— **取值错要由
 * `validateModifierProto` 报一句人话**，而不是在这里被当成技能、
 * 报一屏"至少要有一个阶段"。
 */
function looksLikeModifier(v: unknown): boolean {
  if (v === null || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (typeof o.kind !== 'string') return false
  return typeof o.id === 'string' && typeof o.name === 'string'
}

interface Loaded {
  file: string
  report: ValidationReport | null
  technique: Technique | null
  /** 技能原文。跨文件的 statusId 检查要拿它去收集内联状态定义 */
  skill: Skill | null
  /** 武器定义原文。两个术式槽要拿到全库的术式表之后才能查悬空引用 */
  weapon: WeaponDef | null
  loadError: string | null
}

function main(): number {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'))

  if (args.length === 0) {
    // 没给参数就默认扫内容目录：技能 + 武器技能 + 术式 + 武器 + 修饰原型
    args.push(...SKILL_DIRS, MODIFIER_SKILL_DIR, 'content/internal-techniques', 'content/weapons')
  }

  // ---- 读平衡配置 ----
  const balancePath = resolve('content/balance.json')
  let balance: BalanceConfig
  try {
    balance = readJson<BalanceConfig>(balancePath)
  } catch (e) {
    const msg = e instanceof LoadError ? e.message : String(e)
    console.error(red(`读不到平衡配置 ${shortPath(balancePath)}：${msg}`))
    console.error(dim('所有点数都依赖它，缺了没法校验。'))
    return 1
  }

  const balanceIssues = checkBalance(balance)

  console.log('')
  console.log(bold('技能 / 术式校验器 v1') + dim('  ·  技能是零件，术式是成品 —— 配平看术式'))
  console.log(LINE)
  console.log(`  ${dim('平衡配置')}  ${shortPath(balancePath)}  ${
    balanceIssues.some(i => i.level === 'error') ? red('✗') : green('✓')}`)
  console.log(dim(`    baseRuleSlots=${balance.baseRuleSlots}  买1条=${balance.ruleSlotBuyCost}点  卖1条=${balance.ruleSlotSellGain}点  点数=整数 · 合计≥0 就能用`))
  console.log('')
  printIssues(balanceIssues)

  // ---- 收集文件 ----
  const files: string[] = []
  for (const target of args) {
    try {
      files.push(...collectJsonFiles(target))
    } catch (e) {
      const msg = e instanceof LoadError ? e.message : String(e)
      console.error(red(`✗ ${shortPath(resolve(target))}  ${msg}`))
      return 2
    }
  }

  // balance.json 不是内容，跳过
  const contentFiles = files.filter(f => !f.endsWith('balance.json'))

  if (contentFiles.length === 0) {
    console.error(red('没找到任何技能 / 术式 JSON 文件。'))
    usage()
    return 2
  }

  /*
   * ---- 先读状态库 ----
   *
   * ⚠ 必须**先**读它，因为后面两件事都要用：
   *   1. 技能里按 statusId 引用库状态时，定价要查得到（否则算成 0 点）
   *   2. 跨文件引用检查要把它算进"已知的状态 id"里
   *   （否则库里的状态会被误报成悬空引用 —— 第一版就是这样。）
   */
  const statuses = new Map<string, StatusDef>()
  let failCountFromStatus = 0
  for (const file of collectJsonFiles('content/statuses')) {
    try {
      const st = readJson<StatusDef>(file)
      const issues = validateStatus(st)
      const errors = issues.filter(i => i.level === 'error')
      if (errors.length > 0) {
        console.log(LINE)
        console.log(bold(shortPath(file)))
        console.log(`  ${red('✗ 状态库里的这个状态有问题')}`)
        printIssues(issues)
        failCountFromStatus++
        continue
      }
      statuses.set(st.id, st)
    } catch (e) {
      console.log(LINE)
      console.log(bold(shortPath(file)))
      console.log(`  ${red('✗ 读取失败')}  ${e instanceof LoadError ? e.message : String(e)}`)
      failCountFromStatus++
    }
  }

  /*
   * ---- 实体预设 ----
   *
   * ⚠ 和状态库同理：`spawn` 载荷按 id 引用它们，引用检查要把它算进"已知"，
   *   否则会把 content/entities/ 里自己定义的东西误报成悬空。
   */
  const entities = new Map<string, EntityDef>()
  for (const file of collectJsonFiles('content/entities')) {
    try {
      const def = readJson<EntityDef>(file)
      if (typeof def.id !== 'string' || def.id.length === 0) {
        console.log(LINE)
        console.log(bold(shortPath(file)))
        console.log(`  ${red('✗ 实体预设缺少 id')}`)
        failCountFromStatus++
        continue
      }
      entities.set(def.id, def)
    } catch (e) {
      console.log(LINE)
      console.log(bold(shortPath(file)))
      console.log(`  ${red('✗ 读取失败')}  ${e instanceof LoadError ? e.message : String(e)}`)
      failCountFromStatus++
    }
  }

  /*
   * ---- 技能表（磁盘那一半）----
   *
   * ⚠ 2026-09-30（日志 59）它**必须建在"逐个校验"之前**：
   *   变体的**档位检查**要拿它的基础技能当基准（"这一段现在的时长在不在档位表里"），
   *   而那条检查住在 `validateSkill` 里 —— 表晚一步建，它就只能跳过，
   *   而"跳过"和"没问题"看起来一模一样。
   *
   * ⚠ 技能表必须是**完整**的，哪怕这次只校验一个术式文件。
   *
   *   术式的账 = 它所有零件加起来，所以"零件找不齐"和"零件真的不存在"
   *   在算法看来是同一件事。只拿参数里的文件建表的话，
   *   `npm run validate -- content/internal-techniques/longsword-basic.json`
   *   会把两个明明存在的技能全报成「内容库里没有这个技能」——
   *   校验单个术式就永远失败，那这个用法就废了。
   */
  const skillMap = new Map<string, Skill>()
  for (const dir of SKILL_DIRS) {
    for (const file of collectJsonFiles(dir)) {
      try {
        const s = readJson<Skill>(file)
        // ⚠ 同样要盖系别章（理由见下面 `stampSchool` 那一段）—— 这是"术式里的技能同不同系"的判据
        if (typeof s.id === 'string' && s.id.length > 0) {
          stampSchool(s, schoolOfSkillFile(file))
          skillMap.set(s.id, s)
        }
      } catch {
        // 坏掉的技能文件由它自己那一轮报错，这里不重复报
      }
    }
  }

  // ---- 逐个校验 ----
  const loaded: Loaded[] = []
  for (const file of contentFiles) {
    try {
      const raw = readJson<unknown>(file)
      if (looksLikeTechnique(raw)) {
        // 术式先占位，等技能表收齐了再算账（见下面的第二遍）
        loaded.push({ file, report: null, technique: raw as Technique, skill: null, weapon: null, loadError: null })
      } else if (looksLikeWeapon(raw)) {
        // 武器也先占位：两个术式槽要等术式表收齐了才能查悬空引用
        loaded.push({ file, report: null, technique: null, skill: null, weapon: raw as WeaponDef, loadError: null })
      } else if (looksLikeModifier(raw)) {
        /*
         * ⚠ **修饰原型走自己那条路**（2026-09-21，日志 48）——
         *   它**不是 `Skill`**：没有阶段、没有规则、没有点数。
         *   丢进 `validateSkill` 会炸在 `pricing.ts` 的
         *   `skill.phases.forEach` 上（加载期，一炸白屏）。
         *   所以这里给它一张自己的报告（`modifierIssues` + 原型那几条规矩），
         *   而**不是**把它硬塞成技能。
         */
        const proto = raw as ModifierProto
        const issues = validateModifierProto(proto)
        loaded.push({
          file,
          report: {
            file,
            id: proto.id,
            name: proto.name,
            kind: 'normal',
            total: 0,
            declaredTotal: 0,
            bloodPactPerUse: 0,
            ledger: [],
            issues,
            groups: [{
              name: '修饰原型',
              errors: issues.filter(i => i.level === 'error').length,
              warnings: issues.filter(i => i.level === 'warning').length,
            }],
            fatal: false,
            /*
             * ⚠ 点数那一栏**故意是空的**：`ModifierProto` 没有 `points` 字段 ——
             *   这是**设计**，不是欠账：一个修饰零件本身不产生效果，
             *   它只在**序列里**改写别的技能，所以账记在**术式**上
             *   （`pricing.ts` 的 `modifierPointsOf`：份数按"多出来的份数"收、
             *   等待按秒数给额度，两边都注明"待玩家签字"）。
             *   ⚠ 2026-09-30（日志 52）改了这句话：它以前写的是
             *   "修饰技能的点数怎么算**还没有定**" —— 从日志 51 起就不成立了，
             *   留着一句**假话**比留一个空栏更糟（读者会以为那份好处是白送的）。
             */
            priceless: '修饰零件本身不算账（原型没有 points 字段）——'
              + '它只在序列里改写别的技能，所以账记在**术式**上：'
              + '份数类按"多出来的份数"收（`rates` 外的 `modifierRates.extraCopyPerPoint`）、'
              + '「等待 X 秒」按秒数提供额度（`modifierRates.waitSecondPerPoint`）。'
              + '⚠ 两个汇率都是**建议值、待玩家签字**。',
          },
          technique: null,
          skill: null,
          weapon: null,
          loadError: null,
        })
      } else {
        /*
         * ⚠ **盖系别章**（派生字段，不写进 JSON）：这个技能文件在哪个目录，
         *   它就是哪一系（见 src/school.ts）。
         *
         *   这一处不能省 —— 参数里指定的技能会被塞进下面的 `skillMap`
         *   （`for (const s of allSkills) skillMap.set(s.id, s)`），
         *   所以它**会覆盖**按目录建表时盖好章的那一份。不盖的话
         *   `npm run validate`（参数里本来就有这两个目录）会报一屏
         *   `SKILL_SCHOOL_MISSING`，而那是校验器自己的 bug，不是内容的问题。
         */
        const skill = stampSchool(raw as Skill, schoolOfSkillFile(file))
        loaded.push({
          file,
          report: validateSkill(file, skill, balance, statuses, entities, skillMap),
          technique: null,
          skill,
          weapon: null,
          loadError: null,
        })
      }
    } catch (e) {
      const msg = e instanceof LoadError ? e.message : String(e)
      loaded.push({ file, report: null, technique: null, skill: null, weapon: null, loadError: msg })
    }
  }

  const allSkills = loaded
    .map(i => i.skill)
    .filter((s): s is Skill => s !== null)

  /*
   * ⚠ 技能表**已经建好了**（在"逐个校验"之前 —— 变体的档位检查要用它，
   *   见上面那一段）。这里只把**参数里指定的技能**补进去
   *   （可能不在 content/skills 下，比如临时文件）。
   */
  for (const s of allSkills) skillMap.set(s.id, s)

  /*
   * ---- 修饰原型表（原型 id → 原型）----
   *
   * ⚠ 它是 `validateTechnique` 里那几条修饰规矩的判据之一：
   *   "这个副本引用的原型在不在"、"它是什么类别"（不叠同类要按类别去重）、
   *   以及**份数类修饰的上限**（上限住在原型的 `params.max` 上，日志 51）。
   *   没有它的话，那几条**一条都查不了** —— 而"查不了"和"没问题"看起来一样。
   *
   * ⚠ 从**磁盘**读，不是从上面那些 `Skill` 记录里挑：
   *   后者只在"这次扫了 modifiers 目录"时才有（单独校验一个术式文件时没有），
   *   而术式是**任何时候**都该被查那几条规矩的。
   *
   * ⚠ 2026-09-21（日志 51）它从 `Map<id, kind>` 换成 `Map<id, ModifierProto>`：
   *   份数类的上限在原型上，只拿 kind 读不到。
   */
  const modifierProtos = new Map<string, ModifierProto>()
  for (const file of collectJsonFiles(MODIFIER_SKILL_DIR)) {
    try {
      const p = readJson<ModifierProto>(file)
      if (typeof p.id === 'string' && p.id.length > 0) modifierProtos.set(p.id, p)
    } catch {
      // 坏掉的原型文件由它自己那一轮报错，这里不重复报
    }
  }

  /*
   * ---- 术式表 ----
   *
   * ⚠ 同样必须是**完整**的，理由和技能表一模一样：
   *   "术式找不齐"和"术式真的不存在"在查引用时是同一件事。
   *   只拿参数里的文件建表的话，`npm run validate -- content/weapons/longsword.json`
   *   会把明明存在的 tech.longsword-basic 报成悬空 —— 那单独校验一个武器就永远失败。
   *
   *   它有两处用处：查**老形状序列**（`sequences: ["tech.xxx"]`，只可能来自
   *   老存档 / 老分享码）的悬空引用，以及查**武器术式槽**的悬空引用。
   *   所以要在第二遍之前建好。
   *
   *   ⚠ 2026-09-21（日志 46）序列内联之后，内容里已经没有"按 id 引用的序列"了 ——
   *     但**这张表和那条检查都留着**：老数据仍然走那条路，而"引用的那份
   *     我这里没有"是唯一能提前告诉玩家的事（见 validator 的 `UNKNOWN_SEQUENCE`）。
   */
  const techniqueMap = new Map<string, Technique>()
  for (const file of collectJsonFiles('content/internal-techniques')) {
    try {
      const t = readJson<Technique>(file)
      if (typeof t.id === 'string' && t.id.length > 0) techniqueMap.set(t.id, t)
    } catch {
      // 坏掉的术式文件由它自己那一轮报错，这里不重复报
    }
  }
  // 参数里指定的术式也收进来（可能不在 content/internal-techniques 下，比如临时文件）
  for (const item of loaded) {
    if (item.technique !== null && typeof item.technique.id === 'string') {
      techniqueMap.set(item.technique.id, item.technique)
    }
  }

  /*
   * ---- 第二遍：术式的点数账 ----
   *
   * ⚠ 必须在技能全都读完**之后**才算 —— 术式的账是它所有零件的账加起来，
   *   没有技能表就算不出来。（第一版术式不标价，所以没这个顺序问题。）
   */
  for (const item of loaded) {
    if (item.technique === null) continue
    item.report = validateTechnique(item.file, item.technique, {
      balance, skills: skillMap, statuses, entities, techniques: techniqueMap, modifierProtos,
    })
  }

  for (const item of loaded) {
    if (item.weapon === null) continue
    item.report = validateWeapon(item.file, item.weapon, new Set(techniqueMap.keys()))
  }

  let pass = 0
  let fail = 0
  let warnCount = 0

  /*
   * ---- 跨文件的 statusId 引用检查 ----
   *
   * ⚠ 它必须放在**逐个校验之后、打印之前**，而且要看**全部技能**：
   *   状态可以内联定义在一个技能里、被另一个技能按 id 引用
   *   （灵光盾定义 status.shield，裂魂引用它）。只查单文件会误报成错误。
   *
   *   这一条把"放技能的那一刻才炸"提前到了加载期 —— 是这一节存在的全部意义。
   */
  const allSkillsForRefs = loaded
    .map(i => i.skill)
    .filter((s): s is Skill => s !== null)
  // ⚠ 状态库 / 实体预设里定义的也算"已知" —— 不传它们会把自己库里的东西误报成悬空
  const refIssues = checkRefs(allSkillsForRefs, {
    statuses: [...statuses.keys()],
    entities: [...entities.keys()],
  })

  if (refIssues.length > 0) {
    console.log(LINE)
    console.log(bold('跨文件的引用'))
    for (const i of refIssues) {
      const what = i.what === 'entity'
        ? '运行时会**直接抛异常**（召唤一个不存在的预设）'
        : i.verb === 'apply'
          ? '运行时会**直接抛异常**'
          : '运行时会静默什么都不做'
      const kind = i.what === 'entity' ? '实体预设' : '状态'
      console.log(`  ${red('✗')} ${i.where}`)
      console.log(`      引用了不存在的${kind}「${cyan(i.refId)}」 —— ${what}`)
    }
    console.log('')
    console.log(dim('  状态可以内联定义在任何一个技能里（灵光盾就定义了 status.shield），'))
    console.log(dim('  也可以来自状态库；实体预设来自 content/entities/。都没有就是写错了名字。'))
    fail += refIssues.length
  } else {
    console.log(LINE)
    console.log(`${bold('跨文件的引用')}  ${green('✓')} ${
      dim(`（${allSkillsForRefs.length} 个技能 + ${statuses.size} 个状态 + ${entities.size} 个实体预设，0 条悬空）`)}`)
  }

  /*
   * ⚠ ---- **查表覆盖**（2026-09-30 日志 60b 第 ③ 条）----
   *
   *   用户定的规格：账 = **各选中表项相加**，而那张表住在
   *   `content/balance.json` 的 `lookupTable` 一栏（32 份技能 × 377 个变量）。
   *   ⇒ "内容里有的东西，表里必须也有" —— 少一份技能的分区，或者少一段的
   *   `@打断等级.N`，那一块就**静默地不参与定价**（"没计价"和"免费"同形）。
   *
   *   ⚠ 它是**跨文件**的检查，所以住在命令行这一层（要看全部技能才数得清）。
   *     ① **取值**覆盖（"内容里这个数在不在表里"）在 `validateSkill` 里逐份跑。
   */
  const lookupIssues = checkLookupCoverage(allSkillsForRefs, balance)
  if (lookupIssues.length > 0) {
    console.log(LINE)
    console.log(bold('查表覆盖') + red(`  ✗ ${String(lookupIssues.length)}`))
    for (const i of lookupIssues) {
      console.log(`  ${red('✗')} ${dim(`[${i.code}]`)} ${dim(i.path)}`)
      console.log(`      ${i.message}`)
      if (i.hint !== undefined) console.log(`      ${dim('→ ' + i.hint)}`)
      console.log('')
    }
    fail += lookupIssues.length
  } else {
    const lookupTable = readLookupTable(balance.lookupTable)
    const partitions = lookupTable === undefined ? 0 : Object.keys(lookupTable).length
    console.log(LINE)
    console.log(`${bold('查表覆盖')}  ${green('✓')} ${
      dim(`（${String(allSkillsForRefs.length)} 个技能都在表里 · 表里 ${String(partitions)} 个分区 · 0 条漏）`)}`)
  }

  for (const item of loaded) {
    console.log(LINE)
    console.log(bold(shortPath(item.file)))

    if (item.loadError !== null || item.report === null) {
      console.log(`  ${red('✗ 读取失败')}  ${item.loadError ?? '未知错误'}`)
      console.log('')
      fail++
      continue
    }

    const r = item.report
    const errors = r.issues.filter(i => i.level === 'error').length
    const warnings = r.issues.filter(i => i.level === 'warning').length
    warnCount += warnings

    const isTechnique = item.technique !== null
    const isWeapon = item.weapon !== null
    /*
     * ⚠ 修饰原型走的是"既不是术式、也不是武器、也不是技能"那条路
     *   （它没有 `skill` 记录 —— 见上面 `looksLikeModifier` 那一支）——
     *   2026-09-30（日志 52）之前它会被打印成「技能」，那是个**假标签**。
     */
    const isModifier = !isTechnique && !isWeapon && item.skill === null
    const kindLabel = isTechnique
      ? dim('术式')
      : isWeapon ? dim('武器') : isModifier ? dim('修饰原型')
        : r.kind === 'negative' ? cyan('负值技能') : dim('技能')

    console.log(`  ${r.name} ${dim('·')} ${dim(r.id)} ${dim('·')} ${kindLabel}`)
    if (isTechnique && item.technique !== null) {
      const refs = item.technique.skills ?? []
      if (refs.length > 0) console.log(`  ${dim('技能链')} ${refs.join(dim(' → '))}`)
      const seqs = item.technique.sequences ?? []
      if (seqs.length > 0) {
        const timeout = item.technique.sequenceTimeout ?? 1
        /*
         * ⚠ 2026-09-21（日志 46）序列**内联**之后这里不再打印"序列 id 链条"，
         *   而是打印**每一段用了哪几个技能** —— 那才是内联之后这一段的内容，
         *   而 id 链条已经不存在了（除非是老形状的术式，那时打 id）。
         */
        const label = seqs.map((seg, i) => {
          if (typeof seg === 'string') return seg
          const name = seg.name !== undefined && seg.name.length > 0 ? seg.name : `第${i + 1}段`
          return `${name}[${seg.skills.join(' ')}]`
        }).join(dim(' → '))
        console.log(`  ${dim('序列')} ${label} ${dim(`· 超时 ${timeout}s`)}`)
      }
    }
    if (isWeapon && item.weapon !== null) {
      const attrs = Object.entries(item.weapon.attributes)
        .map(([k, v]) => `${k} ${v}`)
        .join(dim(' · '))
      if (attrs.length > 0) console.log(`  ${dim('属性')} ${attrs}`)
      const slots: string[] = []
      if (item.weapon.weaponTechnique !== undefined) slots.push(`武器 ${item.weapon.weaponTechnique}`)
      if (item.weapon.magicTechnique !== undefined) slots.push(`魔法 ${item.weapon.magicTechnique}`)
      console.log(`  ${dim('术式槽')} ${slots.length > 0 ? slots.join(dim(' · ')) : dim('（空）')}`)
    }
    console.log('')
    console.log(groupLine(r))
    console.log('')

    if (r.fatal) {
      console.log(`  ${yellow('结构问题太多，后面的检查已跳过。')}\n`)
    }

    if (errors > 0 || warnings > 0) {
      printIssues(r.issues)
    } else {
      console.log(`  ${green('全部通过')}\n`)
    }

    if (r.ledger.length === 0 && r.priceless !== undefined) {
      console.log(`  ${dim('·')} ${dim(r.priceless)}`)
    }

    // 技能和术式都有点数账 —— 只是**判据不同**：术式看"能不能用"（合计 ≥ 0），技能不判
    printLedger(r, isTechnique)

    if (errors > 0) fail++
    else pass++
  }

  console.log(LINE)
  const summary = `汇总  ${loaded.length} 个文件 · ${green(String(pass) + ' 通过')} · ${
    fail > 0 ? red(String(fail) + ' 失败') : '0 失败'} · ${
    warnCount > 0 ? yellow(String(warnCount) + ' 警告') : '0 警告'}`
  console.log(summary)
  console.log('')

  return fail > 0 ? 1 : 0
}

process.exitCode = main()
