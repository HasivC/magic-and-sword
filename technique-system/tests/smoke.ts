/**
 * 冒烟测试：证明校验器抓得住问题，而且不该报的地方不乱报。
 *
 * 跑法：npm test
 *
 * 为什么要有这个：
 *   校验器本身也是代码，也会写错。没有测试的话，
 *   你会在"校验器说没问题"和"确实没问题"之间失去区分能力 ——
 *   那比没有校验器更危险。
 */
import { readJson } from '../src/loader.ts'
import { collectJsonFiles } from '../src/loader.ts'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { allRulesOf } from '../src/effects.ts'
import { describeDelivery } from '../src/describe.ts'
import { validateSkill, validateTechnique } from '../src/validator/index.ts'
import { checkBalance, checkRefs } from '../src/validator/checks.ts'
import { SKILL_DIRS, schoolOfSkillFile, stampSchool } from '../src/school.ts'
import type { EntityDef, Skill, StatusDef, Technique } from '../src/schema.ts'
import type { BalanceConfig } from '../src/validator/types.ts'

const BALANCE = 'content/balance.json'
const MANIFEST = 'content/manifest.json'

interface Case {
  file: string
  kind: 'skill' | 'technique'
  /** 必须出现的错误码 */
  mustReport: string[]
  /** true = 这个文件必须一条 error 都没有 */
  mustBeClean?: boolean
}

/**
 * 读全部技能，当作术式算账用的内容库。
 *
 * ⚠ 术式的账 = 它所有零件加起来，所以"零件找不齐"和"零件不存在"
 *   在算法看来是同一件事 —— 传子集就会把存在的技能误报成 UNKNOWN_SKILL。
 *
 * ⚠ **两边都要读、而且要盖系别章**：技能分两个目录（`content/skills` = 魔法系、
 *   `content/weapon-skills` = 武器系，见 `src/school.ts`），术式按 id 引用时
 *   不区分来源。少了武器那一边，武器术式一律报"引用不到技能"；
 *   少了章，校验器报 `SKILL_SCHOOL_MISSING`（判不了同不同系）。
 *   这和 `src/bridge.ts` 的 `loadLibrary` 是同一件事、同一张表。
 */
function loadSkillLibrary(): Map<string, Skill> {
  const lib = new Map<string, Skill>()
  for (const dir of SKILL_DIRS) {
    for (const file of collectJsonFiles(dir)) {
      try {
        const s = readJson<Skill>(file)
        if (typeof s.id === 'string' && s.id.length > 0) {
          lib.set(s.id, stampSchool(s, schoolOfSkillFile(file)))
        }
      } catch {
        // 坏文件由它自己那一轮报错
      }
    }
  }
  return lib
}

/*
 * ⚠ 用例分两类：**技能**查结构（点数只报数字，不判配平），
 *   **术式**查编排 + **点数配平**。配平的责任在术式，所以
 *   "不平衡"这类用例只有术式那一边才该出现。
 */
const CASES: Case[] = [
  {
    file: 'content/skills/cleave.json',
    kind: 'skill',
    mustReport: [],
    mustBeClean: true,
  },
  {
    /*
     * ⚠ 这一条以前要求它报 `NEGATIVE_TECHNIQUE`（裂魂**出厂就是**负值术式）。
     *   2026-09-21 那个 `factoryDebt` 标记删掉了：宗旨没有例外 ——
     *   出厂内容全是 0 点，所以出厂术式里没有负值的。
     *   负值术式现在只能由玩家自己编出来（把变体改强），
     *   那条路在 `tests/pricing.ts` 和 `tests/scenario.ts` 里钉着。
     */
    file: 'content/internal-techniques/soul-rend.json',
    kind: 'technique',
    mustReport: [],
    mustBeClean: true,
  },
  {
    /*
     * 技能这一层**一条问题都不该有** —— 哪怕它自己不平衡。
     * 零件歪是设计（纯收益的火球、纯代价的长冷却收招），不是错误。
     */
    file: 'content/skills/soul-rend.json',
    kind: 'skill',
    mustReport: [],
    mustBeClean: true,
  },
  {
    file: 'content/skills/lava-armor.json',
    kind: 'skill',
    mustReport: [],
    mustBeClean: true,
  },
  {
    file: 'content/internal-techniques/cleave.json',
    kind: 'technique',
    mustReport: [],
    mustBeClean: true,
  },
  {
    file: 'content/internal-techniques/longsword-basic.json',
    kind: 'technique',
    mustReport: [],
    mustBeClean: true,
  },
  {
    file: 'tests/fixtures/broken.json',
    kind: 'skill',
    mustReport: [
      'BAD_VERSION',
      'BAD_ENUM',
      'TOO_MANY_RULES',
      'UNKNOWN_PHASE',
      'DUP_ORDER',
      'EMPTY_VALUE',
      // ⚠ 这里以前还有 NOT_BALANCED。配平搬到术式之后技能不再报它了 ——
      //    术式那一侧的配平用例在 tests/pricing.ts 的「配平的责任在术式」一节。
      'TICK_WITHOUT_CONDITION',
    ],
  },
  {
    file: 'tests/fixtures/broken-tech.json',
    kind: 'technique',
    mustReport: [
      'BAD_ENUM',        // activation 是 doubleClick
      /*
       * ⚠ **这一条 2026-09-21（日志 47）换掉了**：原来是 `EMPTY_VALID`
       *   （"术式自己的 `targeting.valid` 是空的"）。
       *
       *   瞄准搬到**技能层**之后，术式上写 `targeting` 这件事本身就错了 ——
       *   所以现在报的是 `TARGETING_MOVED_TO_SKILL`（防回潮那一条）。
       *   夹具**一个字没改**（它本来就写着 `"targeting": { "mode": "self", "valid": [] }`），
       *   改的只是"它现在该报什么"。
       *
       *   ⚠ `EMPTY_VALID` 那条规则**没有消失**，它搬到了技能那一侧
       *     （`checks.ts` 的 `checkTargeting`）—— `broken.json` 那份技能夹具
       *     和内容里每一个技能都在走那条路。
       */
      'TARGETING_MOVED_TO_SKILL',
      'NO_SKILLS',       // 一个技能都没引用
      /*
       * ⚠ 2026-09-21 起 `kind`（系别）是**必填**的，这份夹具没有它 ——
       *   所以它也该报 MISSING_KIND。夹具是"故意写坏的"，
       *   多一条预期正好多钉住一条规矩（别去"修"它）。
       */
      'MISSING_KIND',
    ],
  },
  {
    /*
     * ⚠ **形态不相容**：press（按一下）的术式里放了蓄力技能「贯日」。
     *   那一段是 `duration: -1`（时长由玩家控制）——在"按一下"里永远跑不完。
     */
    file: 'tests/fixtures/form-mismatch.json',
    kind: 'technique',
    mustReport: ['FORM_INCOMPATIBLE'],
  },
  {
    /*
     * ⚠ **蓄力 / 持续不在最前**：release 术式里，「贯日」排在「裂地斩」后面。
     *   形态本身是相容的（蓄力 + 蓄力放开 ✓），所以这一份**只该报顺序那一条** ——
     *   两条规则的分工就在这里（在 `checkSkillForm` 里还有一条断言盯着它）。
     */
    file: 'tests/fixtures/form-not-first.json',
    kind: 'technique',
    mustReport: ['FORM_NOT_FIRST'],
  },
  {
    /*
     * ⚠ **`auto` 术式里出现非 passive 技能**：常驻术式那一条规矩的另一半
     *   （全是常驻序列的术式自动不占按键、不占格子，所以它带不动瞬发技能）。
     */
    file: 'tests/fixtures/form-auto-instant.json',
    kind: 'technique',
    mustReport: ['FORM_INCOMPATIBLE'],
  },
]

function main(): number {
  const balance = readJson<BalanceConfig>(BALANCE)
  let failed = 0

  const balanceIssues = checkBalance(balance)
  const balanceErrors = balanceIssues.filter(i => i.level === 'error')
  if (balanceErrors.length > 0) {
    console.log(`✗ ${BALANCE} 自身就有问题：`)
    for (const i of balanceErrors) console.log(`    [${i.code}] ${i.message}`)
    failed++
  } else {
    console.log(`✓ ${BALANCE}`)
  }

  for (const c of CASES) {
    let report
    try {
      if (c.kind === 'technique') {
        /*
         * ⚠ 术式的账要**完整技能表**才算得出来
         *   （配平判据在术式上，见 schema / src/pricing.ts 的文件头）。
         *   所以这里把 content/skills 全读进来当内容库。
         */
        report = validateTechnique(c.file, readJson<Technique>(c.file), {
          balance, skills: loadSkillLibrary(),
        })
      } else {
        report = validateSkill(c.file, readJson<Skill>(c.file), balance)
      }
    } catch (e) {
      console.log(`✗ ${c.file}\n    读取失败：${(e as Error).message}`)
      failed++
      continue
    }

    const codes = new Set(report.issues.map((i: { code: string }) => i.code))
    const errors = report.issues.filter((i: { level: string }) => i.level === 'error')

    const missing = c.mustReport.filter(code => !codes.has(code))
    const problems: string[] = []

    if (missing.length > 0) {
      problems.push(`漏报：${missing.join(', ')}`)
    }
    if (c.mustBeClean === true && errors.length > 0) {
      problems.push(`不该报错却报了 ${errors.length} 条：${errors.map((i: { code: string }) => i.code).join(', ')}`)
    }

    if (problems.length > 0) {
      console.log(`✗ ${c.file}`)
      for (const p of problems) console.log(`    ${p}`)
      failed++
    } else {
      const n = report.issues.length
      console.log(`✓ ${c.file}  ${n === 0 ? '（无问题）' : `（${n} 条提示，全部符合预期）`}`)
    }
  }

  console.log('')
  if (failed > 0) {
    console.log(`✗ ${failed} 个用例没通过`)
    return 1
  }
  console.log(`✓ 全部 ${CASES.length} 个用例通过`)

  // ---- 内容清单 ----
  failed += checkManifest()

  // ---- 跨文件的按 id 引用 ----
  failed += checkRefsAcrossContent()

  // ---- "写上去不起作用"的载体字段 ----
  failed += checkUnusedDeliveryFields()

  // ---- 被删掉的死字段：`delivery.count`（2026-09-30 日志 55）----
  failed += checkDeliveryCountRemoved()

  // ---- `homing` 会骗人：描述里不许写「追踪」，写了它要报错（日志 55）----
  failed += checkHomingDoesNotLie()

  // ---- 系别（kind）：武器术式不许放魔法技能，魔法术式不许放武器技能 ----
  failed += checkTechniqueKind()

  // ---- 施法形态（form）：内容里"不是瞬发"的那几个 + 两条规矩 ----
  failed += checkSkillForm()

  return failed > 0 ? 1 : 0
}

/**
 * **系别（`kind`）**：武器术式里只能放武器系技能，魔法术式里不许放武器系技能。
 *
 * ## 为什么这一节必须有
 *
 * 技能的系别是**按目录盖上去的派生章**（`content/skills` = 魔法、
 * `content/weapon-skills` = 武器，见 `src/school.ts`），术式的系别是**显式字段**。
 * 两边对不上的后果是**静默的**：
 *
 *   武器技能（`readonly`）的数值由**武器属性代入**（`ref: 'weapon.*'`）。
 *   它被放进魔法术式里时那一份**永远代入不进去**（读缺省值）——
 *   打出来的伤害和编辑器里显示的都不对，而没有一处会报错。
 *
 * ⚠ 三个方向都要测，少一个这条检查就是摆设：
 *   ① 手造的两个正例（最容易看懂，也最容易在以后被人改坏）
 *   ② **出厂内容一份都不许报**（`npm run validate` 的 51/51 就是它）
 *   ③ **反过来**：把出厂内容的系别改掉，必须当场报出来
 */
function checkTechniqueKind(): number {
  let failed = 0
  const balance = readJson<BalanceConfig>(BALANCE)
  const lib = loadSkillLibrary()
  const opts = { balance, skills: lib }

  /** 这个术式会被报出哪些和系别有关的码 */
  const kindCodes = (t: Technique): string[] =>
    validateTechnique('(测试)', t, opts).issues
      .map(i => i.code)
      .filter(c => c.includes('KIND') || c.includes('SCHOOL') || c === 'WEAPON_TECHNIQUE_MAGIC_SKILL'
        || c === 'MAGIC_TECHNIQUE_WEAPON_SKILL')

  const mk = (kind: 'weapon' | 'magic', skillId: string, name = '探针'): Technique => ({
    schemaVersion: 1,
    id: 'tech.probe',
    name,
    kind,
    activation: 'press',
    // ⚠ 瞄准在**技能**上（2026-09-21 日志 47）：术式这一层不写它。
    //   引用的技能从 `lib` 来，它自己带着自己的瞄准。
    skills: [skillId],
  })

  const weaponSkill = lib.get('skill.ws-slash')
  const magicSkill = lib.get('skill.cleave')
  if (weaponSkill === undefined || magicSkill === undefined) {
    console.log('✗ 技能库里缺武器技能或魔法技能 —— 这一节测不了')
    return 1
  }

  // ---------------------------------------------------------------- ① 两个方向
  {
    const rep = validateTechnique('(测试)', mk('weapon', magicSkill.id), opts)
    const issue = rep.issues.find(i => i.code === 'WEAPON_TECHNIQUE_MAGIC_SKILL')
    if (issue?.level === 'error') {
      console.log('✓ 武器术式里放魔法技能 → WEAPON_TECHNIQUE_MAGIC_SKILL（错误）')
    } else {
      console.log('✗ 武器术式里放魔法技能**没报错** —— 那一份武器数值会静默地读缺省值')
      failed++
    }

    /*
     * ⚠ 报错必须说清**哪个术式、哪个技能**。只说"系别不对"的话，
     *   玩家（和内容作者）根本不知道去改哪一份 —— 校验器的价值一半在这里。
     */
    const msg = issue?.message ?? ''
    if (msg.includes('探针') && msg.includes(magicSkill.name)) {
      console.log(`✓   而且说清了是哪个术式、哪个技能（「${magicSkill.name}」）`)
    } else {
      console.log(`✗   报错没说清对象：${msg}`)
      failed++
    }
  }

  {
    const rep = validateTechnique('(测试)', mk('magic', weaponSkill.id), opts)
    const issue = rep.issues.find(i => i.code === 'MAGIC_TECHNIQUE_WEAPON_SKILL')
    if (issue?.level === 'error') {
      console.log('✓ 魔法术式里放武器系技能 → MAGIC_TECHNIQUE_WEAPON_SKILL（错误）')
    } else {
      console.log('✗ 魔法术式里放武器系技能**没报错** —— 武器技能会读不到武器属性')
      failed++
    }
    const msg = issue?.message ?? ''
    if (msg.includes('探针') && msg.includes(weaponSkill.name)) {
      console.log(`✓   而且说清了是哪个术式、哪个技能（「${weaponSkill.name}」）`)
    } else {
      console.log(`✗   报错没说清对象：${msg}`)
      failed++
    }
  }

  // ---- 反面对照：同系的两种搭配都不许报（报了就是假警报）----
  {
    const same = [
      kindCodes(mk('weapon', weaponSkill.id)),
      kindCodes(mk('magic', magicSkill.id)),
    ]
    if (same.every(c => c.length === 0)) {
      console.log('✓ 同系的两组（武器+武器 / 魔法+魔法）一条都不报')
    } else {
      console.log(`✗ 同系的搭配被误报：${same.map(c => c.join(',')).join(' | ')}`)
      failed++
    }
  }

  // ---------------------------------------------------------------- kind 必填
  {
    const noKind = { ...mk('magic', magicSkill.id) } as Record<string, unknown>
    delete noKind['kind']
    if (kindCodes(noKind as unknown as Technique).includes('MISSING_KIND')) {
      console.log('✓ 缺 kind → MISSING_KIND（**不许默认成 magic**）')
    } else {
      console.log('✗ 缺 kind 没报 —— 它会被当成魔法术式，真正的问题（字段没写）被埋掉')
      failed++
    }
  }

  // ---- 判不了系别时不许静默通过 ----
  {
    const bare: Skill = { ...magicSkill }
    delete bare.school
    const bareLib = new Map(lib)
    bareLib.set(bare.id, bare)
    const codes = validateTechnique('(测试)', mk('magic', bare.id), { balance, skills: bareLib })
      .issues.map(i => i.code)
    if (codes.includes('SKILL_SCHOOL_MISSING')) {
      console.log('✓ 技能表里没有系别章 → SKILL_SCHOOL_MISSING（"判不了"≠"没问题"）')
    } else {
      console.log('✗ 系别缺失时静默通过 —— 混系的术式会跟着溜过去')
      failed++
    }
  }

  // ---------------------------------------------------------------- ② 出厂内容
  {
    /*
     * ⚠ 内容库必须**两个目录都读到**：只读 `content/skills` 的话，
     *   武器术式那一份会变成"引用不到技能"，而那不是内容的问题。
     */
    if (lib.has('skill.ws-slash') && lib.has('skill.cleave')) {
      console.log(`✓ 技能库是两半合起来的（${lib.size} 个：content/skills + content/weapon-skills）`)
    } else {
      console.log('✗ 技能库只有一半 —— 系别判不了、武器术式也会报引用不到')
      failed++
    }

    const unstamped = [...lib.values()].filter(s => s.school === undefined).map(s => s.id)
    if (unstamped.length === 0) {
      console.log('✓ 每一个技能都盖了系别章（两个目录都盖到了）')
    } else {
      console.log(`✗ 这些技能没有系别章：${unstamped.join(', ')}`)
      failed++
    }

    const files = collectJsonFiles('content/internal-techniques')
    const bad: string[] = []
    for (const f of files) {
      const t = readJson<Technique>(f)
      const codes = kindCodes(t)
      if (codes.length > 0) bad.push(`${t.id}: ${codes.join(', ')}`)
    }
    if (bad.length === 0) {
      console.log(`✓ 出厂内容 ${files.length} 份术式：系别全都合法（一份都没报）`)
    } else {
      console.log(`✗ 出厂内容里有 ${bad.length} 份术式的系别有毛病：\n    ${bad.join('\n    ')}`)
      failed++
    }
  }

  // ---------------------------------------------------------------- ③ 反向
  {
    /*
     * ⚠ 把出厂内容的系别**改掉**，必须当场报出来。
     *   没有这一条的话，上面那条"内容全合法"也可能是因为**检查根本没跑**。
     */
    const cleaveTech = readJson<Technique>('content/internal-techniques/cleave.json')
    const flipped = { ...cleaveTech, kind: 'weapon' as const }
    if (kindCodes(flipped).includes('WEAPON_TECHNIQUE_MAGIC_SKILL')) {
      console.log('✓ 反向：「裂地斩」的系别改成 weapon → 立刻报出来')
    } else {
      console.log('✗ 改掉系别也没报 —— 这条检查在真内容上是不生效的')
      failed++
    }

    /*
     * ⚠ 这一份钉的是**推导规则的第二个依据**（见 `src/school.ts`）：
     *   一份挂了序列的术式，**光看"它挂没挂序列"判不出系别** ——
     *   得看**序列里是什么技能**。
     *
     *   ⚠ 2026-09-21（日志 46）序列**内联**之后，这条依据要改成**内联的段**：
     *     `tech.ws-slash` 那份文件已经没有了（它成了容器里的一段）；
     *     但"一份魔法术式、段里却放了武器技能"这个形状仍然必须报出来 ——
     *     所以这里现造一份（探针），不再读内容里的文件。
     *     ⚠ 用**现造的**而不是内容里的，理由和 `tests/probes.ts` 一样：
     *       内容改动不该让这条规则测试跟着红。
     */
    const seqProbe: Technique = {
      schemaVersion: 1,
      id: 'tech.probe-seq',
      name: '序列探针',
      kind: 'magic',
      activation: 'press',
      // ⚠ 瞄准在**技能**上（2026-09-21 日志 47）：术式这一层不写它，
      //   这一节测的是**系别**，和瞄哪儿无关
      // 段里放的是**武器系技能** —— 和 kind: 'magic' 冲突
      sequences: [{ skills: [weaponSkill.id] }],
    }
    if (kindCodes(seqProbe).includes('MAGIC_TECHNIQUE_WEAPON_SKILL')) {
      console.log('✓ 魔法术式、但**段里**放了武器技能 → 照样报 MAGIC_TECHNIQUE_WEAPON_SKILL')
    } else {
      console.log('✗ 段里的武器技能没报 —— 内联之后"序列里是什么技能"没人看了')
      failed++
    }
    /*
     * ⚠ 反面对照：**内联的段里是魔法技能**时，一份 magic 术式一条都不许报。
     *   少了这一条，"段里的技能一律报"也能让上面那条绿。
     */
    const seqProbeOk: Technique = {
      ...seqProbe,
      sequences: [{ skills: [magicSkill.id] }],
    }
    if (kindCodes(seqProbeOk).length === 0) {
      console.log('✓ 内联的段里是魔法技能 → 一条都不报（不是"段里的技能一律报"）')
    } else {
      console.log(`✗ 段里是合法技能却被误报：${kindCodes(seqProbeOk).join(', ')}`)
      failed++
    }
  }

  return failed
}

/**
 * **施法形态**（`Skill.form`）：内容里"不是瞬发"的那几个技能，以及形态 × 激活方式的两条规矩。
 *
 * ## 为什么这一节必须有
 *
 * 形态的**默认值是瞬发**（宗旨：默认值下点数是配平为 0 的；猜的面越小越好 ——
 * 见 schema 的 `SkillForm`）。所以"内容里到底标了几个"这件事**只有这张表说得清**：
 * 一个技能悄悄多出 `form`、或者该标的那一个漏标，校验器自己**发现不了** ——
 * 它只会让"非瞬发技能"这张表变大或变小，而两种样子看起来都很正常。
 *
 * ⚠ 三个方向都要测（和上面系别那一节同一个套路，少一个这条检查就是摆设）：
 *   ① 手造的正例 / 反例（最容易看懂，也最容易以后被人改坏）
 *   ② **出厂内容一份都不许报**，而且**对照表 = 文件里写的**
 *   ③ **反过来**：把出厂内容的激活方式改掉，必须当场报出来
 */
function checkSkillForm(): number {
  let failed = 0
  const balance = readJson<BalanceConfig>(BALANCE)
  const lib = loadSkillLibrary()

  /** 术式库：`sequences` 那一半要顺着查（技能都在被引用的子术式里） */
  const techniques = new Map<string, Technique>()
  for (const f of collectJsonFiles('content/internal-techniques')) {
    const t = readJson<Technique>(f)
    if (typeof t.id === 'string' && t.id.length > 0) techniques.set(t.id, t)
  }

  const opts = { balance, skills: lib }
  const optsWithSeq = { balance, skills: lib, techniques }

  const FORM_CODES = new Set(['FORM_INCOMPATIBLE', 'FORM_NOT_FIRST'])
  const formCodes = (t: Technique, o: typeof opts = opts): string[] =>
    validateTechnique('(测试)', t, o).issues.map(i => i.code).filter(c => FORM_CODES.has(c))

  /** 造一份探针术式。不写 activation 就是 press（和内容里的默认一致） */
  const mk = (over: Partial<Technique> = {}): Technique => ({
    schemaVersion: 1,
    id: 'tech.probe-form',
    name: '形态探针',
    kind: 'magic',
    activation: 'press',
    // ⚠ 瞄准在**技能**上（2026-09-21 日志 47）：术式这一层不写它
    skills: [],
    ...over,
  })

  /*
   * ⚠ 内容里**一个 `sustained` 技能都没有**，而且那是对的 ——
   *   不为了演示新造技能（日志 45）。所以"持续"那一行只能在这儿造一个
   *   **临时**技能来验：它只活在这个函数里，不会进内容、也不进两个技能库。
   */
  const sustained: Skill = {
    schemaVersion: 1,
    id: 'skill.probe.sustained',
    name: '探针·持续',
    form: 'sustained',
    school: 'magic',
    phases: [{ id: 'hold', duration: 0.1, occupiesCaster: true, cancellable: false, interrupt: 'none' }],
    rules: [],
    ruleSlots: 4,
  }
  const libPlus = new Map(lib)
  libPlus.set(sustained.id, sustained)

  // ---------------------------------------------------------------- ① 三个反例 + 四个正例
  {
    const chargedInPress = formCodes(mk({ skills: ['skill.charged-laser'] }))
    if (chargedInPress.includes('FORM_INCOMPATIBLE')) {
      console.log('✓ 蓄力技能放进 press 术式 → FORM_INCOMPATIBLE（那一段 duration: -1 永远跑不完）')
    } else {
      console.log('✗ 蓄力技能放进 press 术式**没报错** —— 玩家看到的是"按下去没反应"')
      failed++
    }

    /*
     * ⚠ 这一条钉的是**两条规则的分工**：release + 蓄力本来是相容的，
     *   错的只是**位置**。两条都报的话，玩家会去改 activation（那是对的），
     *   却看不清真正要改的是顺序。
     */
    const order = formCodes(mk({ activation: 'release', skills: ['skill.cleave', 'skill.charged-laser'] }))
    if (order.includes('FORM_NOT_FIRST')) {
      console.log('✓ 蓄力技能排在第二个 → FORM_NOT_FIRST（蓄力 / 持续必须是序列的第一个）')
    } else {
      console.log('✗ 蓄力技能不在最前**没报错**')
      failed++
    }
    if (!order.includes('FORM_INCOMPATIBLE')) {
      console.log('✓   而且**没有**误报形态不相容（release + 蓄力本来是相容的）')
    } else {
      console.log('✗ 两条规则打架了：顺序错的那一份也被判成形态不相容')
      failed++
    }

    const autoInstant = formCodes(mk({ activation: 'auto', skills: ['skill.cleave'] }))
    if (autoInstant.includes('FORM_INCOMPATIBLE')) {
      console.log('✓ auto（全常驻）术式里放瞬发技能 → FORM_INCOMPATIBLE')
    } else {
      console.log('✗ auto 术式里放瞬发技能**没报错** —— 常驻术式不占按键，带不动它')
      failed++
    }

    const pressPassive = formCodes(mk({ skills: ['skill.infinity'] }))
    if (pressPassive.includes('FORM_INCOMPATIBLE')) {
      console.log('✓ 常驻技能放进主动术式 → FORM_INCOMPATIBLE（它没有时间轴，串不进去）')
    } else {
      console.log('✗ 常驻技能混进主动术式**没报错** —— 这就是"被动 + 法球"那个 bug')
      failed++
    }

    // ---- 反面对照：这些组合一条都不该报（报了就是假警报）----
    const clean: [string, string[]][] = [
      ['瞬发序列（两个瞬发技能）', formCodes(mk({ skills: ['skill.cleave', 'skill.magic-bolt'] }))],
      ['蓄力在最前（release + 蓄力）', formCodes(mk({ activation: 'release', skills: ['skill.charged-laser'] }))],
      ['全常驻（auto + 常驻技能）', formCodes(mk({ activation: 'auto', skills: ['skill.blood-pact'] }))],
      ['持续 + 按住（hold）', formCodes(mk({ activation: 'hold', skills: [sustained.id] }),
        { balance, skills: libPlus })],
    ]
    const noisy = clean.filter(([, c]) => c.length > 0)
    if (noisy.length === 0) {
      console.log('✓ 四组合法搭配一条都不报（瞬发 / 蓄力在最前 / 全常驻 / 持续）')
    } else {
      console.log(`✗ 合法搭配被误报：${noisy.map(([n, c]) => `${n}→${c.join(',')}`).join(' | ')}`)
      failed++
    }

    // ---- 持续 + 按一下：非法（内容里没这个技能，用临时的那个验）----
    const sustainedInPress = formCodes(mk({ skills: [sustained.id] }), { balance, skills: libPlus })
    if (sustainedInPress.includes('FORM_INCOMPATIBLE')) {
      console.log('✓ 持续技能放进 press 术式 → FORM_INCOMPATIBLE（它要"松开/再按"才结束）')
    } else {
      console.log('✗ 持续技能放进 press 术式**没报错**')
      failed++
    }
  }

  // ---- form 取值非法：不许静默当成瞬发 ----
  {
    const typo: Skill = { ...sustained, id: 'skill.probe.typo', form: 'passiv' as Skill['form'] }
    const hit = validateSkill('(测试)', typo, balance).issues
      .some(i => i.code === 'BAD_ENUM' && i.path === 'form')
    if (hit) {
      console.log('✓ form 拼错 → BAD_ENUM（**不许**静默当成瞬发）')
    } else {
      console.log('✗ form 拼错没报 —— 一个拼错的形态会表现成"这技能是瞬发的"')
      failed++
    }
  }

  // ---------------------------------------------------------------- ② 出厂内容 + 对照表
  {
    /*
     * ⚠ 对照表**写死在这里**，不是"数一数有几个"。
     *
     *   形态的默认值是瞬发、宗旨是"猜的面越小越好"，所以这份清单**本身就是要核对的那张表**
     *   （日志 45 有逐条的依据）。多一个少一个都该有人来解释一句 ——
     *   这正是 tests/school.ts 那句"17 份出厂内容的 kind 用规则重算 = 文件里写的"的同一种哨兵。
     */
    const EXPECTED: [string, string][] = [
      ['skill.blood-pact', 'passive'],       // 只被 auto 术式用到（tech.blood-pact）
      ['skill.slow-field', 'passive'],       // 只被 auto 术式用到（tech.slow-field）
      ['skill.hunter-instinct', 'passive'],  // 没有固有效果，只有反应规则
      ['skill.infinity', 'passive'],
      ['skill.named-blade', 'passive'],
      /*
       * ⚠ 2026-09-21（日志 48）**这里原来是 `skill.last-stand`**，删掉了：
       *   那一份（"背水"）被**拆开**了 —— 它的盾搬去了
       *   `skill.last-stand-shield`（它**没有"装上就生效"这回事**：它由
       *   监测器触发，而形态标 `passive` 的理由写在它自己那个文件里），
       *   而"什么时候触发"搬去了修饰零件 `mod.monitor.low-hp`。
       *   ⚠ 这正是那一行注释里那句"和它自己文件里的 `_comment_toggle` 冲突"
       *     的结局：冲突不是被和稀泥，是**那个技能不存在了**。
       */
      ['skill.last-stand-shield', 'passive'], // 被常驻包装包着，由监测器触发（见它的 _comment_form）
      ['skill.charged-laser', 'charged'],    // 时间轴里有 duration: -1 那一段
    ]

    const marked = [...lib.values()]
      .filter(s => s.form !== undefined)
      .map(s => `${s.id}=${String(s.form)}`)
      .sort()
    const want = EXPECTED.map(([id, f]) => `${id}=${f}`).sort()

    if (marked.join(' | ') === want.join(' | ')) {
      console.log(`✓ 形态对照表 = 文件里写的（${marked.length} 个：${EXPECTED.filter(e => e[1] === 'passive').length} 个常驻`
        + ` + ${EXPECTED.filter(e => e[1] === 'charged').length} 个蓄力 + 0 个持续）`)
    } else {
      console.log('✗ 形态对照表对不上：')
      console.log(`    文件里：${marked.join(', ') || '（一个都没有）'}`)
      console.log(`    期望是：${want.join(', ')}`)
      failed++
    }

    const sustainedCount = [...lib.values()].filter(s => s.form === 'sustained').length
    if (sustainedCount === 0) {
      console.log('✓ 内容里一个 sustained 都没有 —— 那就不造（没有为了演示新造技能）')
    } else {
      console.log(`✗ 内容里冒出了 ${sustainedCount} 个 sustained 技能 —— 那是新造的，得说清为什么`)
      failed++
    }

    /*
     * 出厂内容：**每一份术式 × 它用到的每一个技能**，一条形态错都不许有。
     * ⚠ 必须带着 `techniques` 传进去 —— 不然 `sequences` 那一半技能一个都查不到，
     *   "内容全绿"就只是因为**没查**。
     */
    const bad: string[] = []
    for (const [id, t] of techniques) {
      const codes = formCodes(t, optsWithSeq)
      if (codes.length > 0) bad.push(`${id}: ${codes.join(', ')}`)
    }
    if (bad.length === 0) {
      console.log(`✓ 出厂内容 ${techniques.size} 份术式：形态 × 激活方式全都合法（含 sequences 里那几段）`)
    } else {
      console.log(`✗ 出厂内容里有 ${bad.length} 份术式的形态有毛病：\n    ${bad.join('\n    ')}`)
      failed++
    }

    // 技能那一侧：`form` 的取值都合法（且没有一个是"标了但拼错"的）
    const badForm: string[] = []
    for (const dir of SKILL_DIRS) {
      for (const f of collectJsonFiles(dir)) {
        const s = stampSchool(readJson<Skill>(f), schoolOfSkillFile(f))
        const hit = validateSkill(f, s, balance).issues.some(i => i.code === 'BAD_ENUM' && i.path === 'form')
        if (hit) badForm.push(s.id)
      }
    }
    if (badForm.length === 0) {
      console.log('✓ 技能库里的 form 取值全都合法（不写的按瞬发算）')
    } else {
      console.log(`✗ 这些技能的 form 取值非法：${badForm.join(', ')}`)
      failed++
    }
  }

  // ---------------------------------------------------------------- ③ 反向：改掉激活方式
  {
    /*
     * ⚠ 报错必须说清**哪个术式、哪个技能**。只说"形态不对"的话，
     *   玩家（和内容作者）根本不知道去改哪一份 —— 校验器的价值一半在这里。
     */
    const cleave = readJson<Technique>('content/internal-techniques/cleave.json')
    const asAuto = { ...cleave, activation: 'auto' as const }
    const issue = validateTechnique('(测试)', asAuto, optsWithSeq).issues
      .find(i => i.code === 'FORM_INCOMPATIBLE')
    if (issue?.level === 'error') {
      console.log('✓ 反向：把「裂地斩」那份术式的 activation 改成 auto → 立刻报出来')
    } else {
      console.log('✗ 改掉激活方式也没报 —— 这条检查在真内容上是不生效的')
      failed++
    }
    const msg = issue?.message ?? ''
    if (msg.includes('裂地斩') && msg.includes('instant') && msg.includes('auto')) {
      console.log('✓   而且说清了两个取值（auto × instant）和是哪个技能')
    } else {
      console.log(`✗   报错没说清对象：${msg}`)
      failed++
    }

    /*
     * ⚠ **顺着 `sequences` 查**：写 `sequences` 的术式自己没有 `skills`，
     *   技能全在被引用的那份子术式里。不查这一条的话，"父术式的激活方式
     *   和序列里技能形态不相容"永远查不出来（§五 规矩 2：每一段都要相容）。
     */
    const longsword = readJson<Technique>('content/internal-techniques/longsword-basic.json')
    if (formCodes(longsword, optsWithSeq).length === 0) {
      console.log('✓ 出厂那份序列术式（press）一条都不报')
    } else {
      console.log('✗ 出厂那份序列术式被误报了')
      failed++
    }
    const seqIssue = validateTechnique('(测试)', { ...longsword, activation: 'auto' as const }, optsWithSeq)
      .issues.find(i => i.code === 'FORM_INCOMPATIBLE')
    const seqMsg = seqIssue?.message ?? ''
    if (seqMsg.includes(longsword.name) && seqMsg.includes('横砍')) {
      console.log(`✓ 反向：把它改成 auto → 顺着序列报到「${longsword.name}」里的「横砍」（说清了要改哪一份）`)
    } else {
      console.log(`✗ 顺着 sequences 的那一条没报，或者说错了对象：${seqMsg}`)
      failed++
    }
  }

  return failed
}

/**
 * 用错了载体的字段要报出来。
 *
 * ⚠ 玩家 2026-09-21 给的原则：
 *   > 如果改变技能的某种属性不会改变技能的效果（或非常不明显），
 *   > 那这个属性可以固定而不进入编辑器供玩家修改。
 *
 *   引擎对每种载体只读固定的几个字段（`src/sim/targeting.ts`）。
 *   别的字段写上去是**静默失效**的，而编辑器照着 JSON 里有什么就给什么配滑块 ——
 *   于是玩家拖着一个"半径"，拖半天发现打出去的宽度没变。
 *
 * ⚠ 出厂内容里一条都没有（所以 `npm run validate` 上看不见它）。
 *   正因为它现在是 0，才更需要一条测试盯着 —— 不然以后写错了没人知道。
 */
function checkUnusedDeliveryFields(): number {
  const skill: Skill = {
    schemaVersion: 1,
    id: 'skill.probe-unused',
    name: 'probe',
    // 光束只认 length / width；radius 就是那个"写上去没用"的
    phases: [{
      id: 'cast', duration: 0.1, occupiesCaster: false, interrupt: 'none', cancellable: false,
    }],
    rules: [{
      id: 'r1',
      when: 'phaseComplete',
      phaseId: 'cast',
      order: 0,
      then: [{
        delivery: { kind: 'beam', length: 8, width: 0.6, radius: 5 },
        payload: { kind: 'damage', amount: { const: 10 } },
      }],
    }],
    ruleSlots: 4,
  }

  const codes = new Set(validateSkill('probe.json', skill, readJson<BalanceConfig>(BALANCE))
    .issues.map((i: { code: string }) => i.code))

  if (codes.has('DELIVERY_FIELD_UNUSED')) {
    console.log('✓ 载体用不上的字段会被报出来（beam 不读 radius）')
    return 0
  }
  console.log('✗ 载体用不上的字段**没被报出来** —— 它会变成一个拖了没反应的滑块')
  return 1
}

/**
 * ⚠⚠ `delivery.count`（"发射数量"）**已经删掉了** —— 还写着它的一律报错。
 *
 * 2026-09-30 日志 55（上级裁定）：它原来是个**死字段**
 *   —— schema 里声明着、`describe.ts` 拿来拼描述、定价那一带也读，
 *   **而引擎根本不读**（`sim/pipeline.ts` 造投射物时只看 `speed` / `lifetime` / `radius`）。
 *
 * ⚠ 为什么这条测试值得单独存在：那种字段的**坏处不是"少个功能"**，
 *   而是"**第二个真相**" —— 作者在 schema 里看到 `count`，
 *   写 `count: 3` 打出来还是**一发**，而他没有任何理由怀疑自己写错了。
 *   "一次打出好几发"今天**只有一条路**：「一分为 X」（走 `activateGroup`）。
 *
 * ⚠ 判据是**报错**（`BAD_DELIVERY`）不是警告：这里要说的是"**这个字段不存在了**"，
 *   不是"这个字段在这类载体上没用"（那是另一条 `DELIVERY_FIELD_UNUSED`）。
 */
function checkDeliveryCountRemoved(): number {
  const skill: Skill = {
    schemaVersion: 1,
    id: 'skill.probe-delivery-count',
    name: 'probe',
    phases: [{
      id: 'cast', duration: 0.1, occupiesCaster: false, interrupt: 'none', cancellable: false,
    }],
    rules: [{
      id: 'r1',
      when: 'phaseComplete',
      phaseId: 'cast',
      order: 0,
      then: [{
        // ⚠ 这个 `count` 就是那条被判死的写法（投射物本来也"不读"它，但重点是它没了）
        delivery: { kind: 'projectile', speed: 12, lifetime: 1.5, count: 3 } as never,
        payload: { kind: 'damage', amount: { const: 10 } },
      }],
    }],
    ruleSlots: 4,
  }

  const issues = validateSkill('probe.json', skill, readJson<BalanceConfig>(BALANCE)).issues
  const hit = issues.find((i: { code: string, path: string }) =>
    i.code === 'BAD_DELIVERY' && i.path.endsWith('.delivery.count'))

  if (hit === undefined) {
    console.log('✗ 写 `delivery.count` **没被报出来** —— 它会变成一个"写了没反应"的字段')
    return 1
  }
  const text = `${hit.message}${hit.hint ?? ''}`
  if (!text.includes('一分为 X')) {
    console.log('✗ `delivery.count` 报出来了，但话里**没指路「一分为 X」**（作者不知道该怎么办）')
    return 1
  }
  console.log('✓ `delivery.count` 已删 —— 还写着它报错，并指路「一分为 X」')
  return 0
}

/**
 * ⚠⚠ `DeliverySpec.homing`（追踪）**已经删掉了** —— 还写着它的一律报错，
 *   而且话里要**指路修饰零件「追踪」**（2026-09-30 日志 56，玩家裁定）。
 *
 * ## 为什么这个字段必须死
 *
 * 它和 `delivery.count` 一样是"schema 有、说明生成器读、**引擎一处都不读**"的
 * **第二个真相**，而且比 `count` 更坏：`describe.ts` 原来会为它写出
 * 「**追踪**」两个字 ⇒ 玩家照着配了飞弹、打出去发现它**直直地飞**，
 * 然后会以为这是一个 **bug**（⚠ 他没有任何办法知道那是"没实现"）。
 *
 * ## 玩家把它裁定成了什么
 *
 * > 追踪应该是一种**修饰技能**。正常的技能只沿着发射方向走，
 * > 而追踪技能**瞄准敌人**（部分技能比如**激光**不能被它修饰，看着不合理）
 *
 * 追问后确认：**自己找敌人**。⇒ 落点是 `content/modifiers/homing.json`
 * （`kind: 'homing'`），挂在被修饰的那个技能**前面**（`at: 0`）。
 *
 * ⇒ 这一条**两个方向都测**（缺一个都证不了"骗人这件事被堵住了"）：
 *   ① 描述里**不再出现「追踪」**（拿掉假话 —— 它在日志 55 就删了）；
 *   ② 写 `homing` 的内容**报错（`BAD_DELIVERY`，不是警告）**、
 *      而且话里说清"**字段已经删掉了**"并**指路那个修饰零件**
 *      （只说"不生效"的话，作者不知道该改去哪儿 —— 和 `count` 那条同一个要求）。
 */
function checkHomingDoesNotLie(): number {
  const delivery = { kind: 'projectile' as const, speed: 12, lifetime: 1.5, homing: true }

  // ---- ① 描述里不许再说「追踪」----
  const text = describeDelivery(delivery)
  if (text.includes('追踪')) {
    console.log(`✗ 描述里还在写「追踪」—— 界面在承诺那个字段做不到的事：${text}`)
    return 1
  }

  // ---- ② 写了 `homing` 要**报错**，而且指路修饰零件「追踪」----
  const skill: Skill = {
    schemaVersion: 1,
    id: 'skill.probe-homing',
    name: 'probe',
    phases: [{
      id: 'cast', duration: 0.1, occupiesCaster: false, interrupt: 'none', cancellable: false,
    }],
    rules: [{
      id: 'r1',
      when: 'phaseComplete',
      phaseId: 'cast',
      order: 0,
      then: [{ delivery, payload: { kind: 'damage', amount: { const: 10 } } }],
    }],
    ruleSlots: 4,
  }

  const issues = validateSkill('probe.json', skill, readJson<BalanceConfig>(BALANCE)).issues
  const hit = issues.find((i: { code: string, path: string, level: string }) =>
    i.code === 'BAD_DELIVERY' && i.path.endsWith('.delivery.homing'))

  if (hit === undefined) {
    console.log('✗ 写 `homing` **没被报出来** —— 它会变成一个"配了没反应"的旋钮')
    return 1
  }
  if (hit.level !== 'error') {
    console.log(`✗ \`homing\` 只报了 ${hit.level}（要 **error**）—— 警告混在一堆警告里等于没说`)
    return 1
  }
  const msg = `${hit.message}${hit.hint ?? ''}`
  if (!msg.includes('删掉')) {
    console.log('✗ `homing` 报了错，但话里没说清"**这个字段已经删掉了**"（作者会以为是自己写错了）')
    return 1
  }
  if (!msg.includes('modifiers/homing.json') || !msg.includes('at: 0')) {
    console.log('✗ `homing` 报了错，但**没指路修饰零件「追踪」**（作者不知道该改去哪儿）')
    return 1
  }
  console.log('✓ `homing` 已删 —— 描述里没有「追踪」，写了它报 error 并指路修饰零件「追踪」')
  return 0
}

/**
 * 跨文件的按 id 引用检查（状态 + 实体预设）。
 *
 * ⚠ 这一组测的是"**加载期**能不能发现一个运行期才会炸的错"。
 *
 *   技能里按 id 引用状态、而那个名字在整份内容里都不存在时，引擎是
 *   放技能的那一刻才 throw 的。裂魂那条「驱散 status.shield」就这么
 *   躺了很久 —— 那个名字当时只存在于 tests/pipeline.ts 里。
 *
 * 两个方向都要测：
 *   正向 —— 出厂内容一条悬空引用都不许有
 *   反向 —— **把定义者拿掉，必须立刻报出来**（否则这个检查是摆设）
 */
function checkRefsAcrossContent(): number {
  let failed = 0

  const dir = 'content/skills'
  const skills: Skill[] = collectJsonFiles(dir).map(f => readJson<Skill>(f))

  // ⚠ 状态库和实体预设里的也算"已知" —— 不传的话会把它们自己定义的东西误报成悬空
  const statusDir = 'content/statuses'
  const libraryIds = existsSync(statusDir)
    ? collectJsonFiles(statusDir).map(f => readJson<StatusDef>(f).id)
    : []
  const entityDir = 'content/entities'
  const entityIds = existsSync(entityDir)
    ? collectJsonFiles(entityDir).map(f => readJson<EntityDef>(f).id)
    : []

  const issues = checkRefs(skills, { statuses: libraryIds, entities: entityIds })
  if (issues.length === 0) {
    console.log(`✓ 跨文件引用：${skills.length} 个技能 + ${libraryIds.length} 个库状态`
      + ` + ${entityIds.length} 个实体预设，0 条悬空`)
  } else {
    console.log(`✗ 跨文件引用：出厂内容里就有 ${issues.length} 条悬空引用`)
    for (const i of issues) console.log(`    ${i.where} → ${i.what} ${i.refId}`)
    failed++
  }

  /*
   * 反向一：把状态库拿掉，按 id 引用库状态的那些必须立刻变成悬空。
   *
   * 拿灵光盾当例子 —— 它从"内联定义"搬进了状态库，
   * 正是状态库那一轮要验证的路径。
   */
  const noLibrary = checkRefs(skills, { statuses: [] })
  const caught = noLibrary.some(i => i.refId === 'status.shield')
  if (caught) {
    console.log('✓ 不传状态库时，「灵光盾」那条 status.shield 引用立刻变成悬空')
  } else {
    console.log('✗ 不传状态库也没报 —— 引用检查是摆设')
    failed++
  }

  /*
   * 反向二：确认报出来的是**对的那两条**，而且 verb 分得清。
   *
   * ⚠ 这里有个反直觉的地方：把状态库拿掉之后，**灵光盾自己也变成悬空**了 ——
   *   它从"内联定义者"变成了"按 id 的消费者"。所以报出来的是两条，不是一条。
   *   （第一版就写错了这个预期：以为只有裂魂那条会报。）
   */
  const aegisRef = noLibrary.find(i => i.where.startsWith('skill.aegis'))
  const soulRendRef = noLibrary.find(i => i.where.startsWith('skill.soul-rend'))

  if (aegisRef?.verb === 'apply' && soulRendRef?.verb === 'remove') {
    console.log('✓ 两条都报到了，apply / remove 分得清（前者会抛异常，后者只是静默无效）')
  } else {
    console.log(`✗ 报得不对：aegis=${String(aegisRef?.verb)}，soul-rend=${String(soulRendRef?.verb)}`)
    failed++
  }

  /*
   * 反向三：实体预设（`spawn` 载荷）。
   *
   * 和状态同理 —— 不传预设表的话，召唤技能必须立刻变成悬空引用。
   * 这就是"做 spawn 的同一轮就把引用检查接上"的兑现：
   * 不用再等一次"内容写错了名字、放技能时才炸"的教训。
   */
  const noEntities = checkRefs(skills, { entities: [] })
  const spawnRef = noEntities.find(i => i.what === 'entity')
  if (spawnRef !== undefined) {
    console.log(`✓ 不传实体预设时，召唤引用「${spawnRef.refId}」立刻变成悬空`)
  } else {
    console.log('✗ 不传实体预设也没报 —— spawn 的引用没被检查')
    failed++
  }

  // 逐文件校验器对上面这些是"全部通过" —— 所以这条检查必须是跨文件的
  const soulRend = skills.find(s => s.id === 'skill.soul-rend')
  if (soulRend !== undefined) {
    const perFile = validateSkill(
      'content/skills/soul-rend.json', soulRend, readJson<BalanceConfig>(BALANCE), new Map(),
    )
    const perFileErrors = perFile.issues.filter(i => i.level === 'error')
    if (perFileErrors.length === 0) {
      console.log('  （注意：逐文件校验器对它是「全部通过」—— 所以这条检查必须是跨文件的）')
    }
  }

  failed += checkFxRefs(skills)

  return failed
}

/**
 * 技能里的 `vfx` 引用和**方向性特效素材**的朝向。
 *
 * ⚠ 玩家 2026-09-21 报的 bug：
 *
 *   > 使用铁剑时鼠标左键的攻击始终朝向正右方而不是鼠标方向
 *
 *   引擎那边是好的（打中的就是鼠标指着的人）—— 看着不对的是**特效**：
 *   `content/fx/slash.json` 里那套占位素材的刀光画在画布**右半边**，
 *   而它的 `rotate` 写的是 `none`。于是无论往哪挥，那一刀都画在角色右边。
 *
 *   漏写这一条**不会报任何错**：素材照常加载、照常播放，只是永远朝一个方向。
 *   所以这条检查放在跨文件这一层（要同时看技能和 fx 定义）。
 */
function checkFxRefs(skills: Skill[]): number {
  let failed = 0

  const fxDir = 'content/fx'
  if (!existsSync(fxDir)) return 0
  const defs = new Map<string, { id: string; rotate?: string }>()
  for (const file of readdirSync(fxDir)) {
    if (!file.endsWith('.json')) continue
    const def = readJson<{ id: string; rotate?: string }>(join(fxDir, file))
    defs.set(def.id, def)
  }

  /*
   * 方向性载体：它们的画面**有方向**（扇形朝哪挥、光束往哪射），
   * 所以素材必须跟着这一下的 `dir` 转。
   * 范围 / 光环 / 投射物命中是**放射状**的，转不转都一样。
   */
  const DIRECTIONAL = new Set(['meleeArc', 'beam', 'capsule'])

  const missing: string[] = []
  const notRotating: string[] = []

  for (const skill of skills) {
    for (const rule of allRulesOf(skill)) {
      for (const action of rule.then) {
        const d = action.delivery
        if (d === undefined || d.vfx === undefined) continue
        const def = defs.get(d.vfx)
        if (def === undefined) {
          missing.push(`${skill.id} → ${d.vfx}`)
          continue
        }
        if (DIRECTIONAL.has(d.kind) && def.rotate !== 'facing') {
          notRotating.push(`${skill.id}（${d.kind}）→ ${d.vfx}`)
        }
      }
    }
  }

  if (missing.length > 0) {
    console.log(`✗ 技能引用了不存在的特效素材（运行时会静默退回程序化，作者素材白做）：\n    ${missing.join('\n    ')}`)
    failed++
  } else {
    console.log(`✓ 技能引用的特效素材都在（${defs.size} 份素材）`)
  }

  if (notRotating.length > 0) {
    console.log(
      '✗ 方向性载体的作者素材没写 rotate: "facing" —— 它会永远朝一个方向画'
      + `（玩家报过这个）：\n    ${notRotating.join('\n    ')}`,
    )
    failed++
  } else {
    console.log('✓ 方向性载体的素材都跟着朝向转（rotate: "facing"）')
  }

  return failed
}

interface Manifest {
  skills: string[]
  /**
   * **内部术式库**（`content/internal-techniques/`）：引擎和敌人在用的术式。
   *
   * ⚠ 它以前叫 `techniques`，里面塞着三十多份"一个技能一份同名术式"的示范。
   *   玩家 2026-09-21 定了：那些示范他要看不见、也引用不到 ——
   *   所以现在只留真的被引用的 17 份，名字也改成 `internalTechniques`，
   *   好让下一个人一眼看出"这一层不是给玩家看的"。
   */
  internalTechniques: string[]
  statuses?: string[]
  entities?: string[]
  scenarios: string[]
  fx?: string[]
  /**
   * 武器技能模板。⚠ 它们是 **Skill**，只是单独放一个目录
   *   （内容作者一眼能看出"这些是武器自带的固定件，玩家不能改"）。
   */
  weaponSkills?: string[]
  /**
   * **修饰原型**（`content/modifiers/`，2026-09-21 日志 48）。
   *
   * ⚠ 它们**不是 `Skill`**：原型没有阶段、没有规则、也不算账
   *   （`pricing.ts` 会炸在 `skill.phases.forEach` 上），
   *   所以它们走自己那条加载 / 校验路径。
   */
  modifiers?: string[]
  /** 武器（第五层内容） */
  weapons?: string[]
}

/**
 * 内容清单和实际文件对不对得上。
 *
 * 为什么要专门测这个：浏览器客户端按 manifest 加载，清单里多一个不存在的名字
 * 就是一次 404；少一个就是"这个术式在命令行里能跑、在网页上找不到"。
 * lava-armor 两种都踩过。
 *
 * 反方向也要查：目录里躺着一个没进清单的文件，等于它永远不会被加载。
 */
function checkManifest(): number {
  let failed = 0

  let manifest: Manifest
  try {
    manifest = readJson<Manifest>(MANIFEST)
  } catch (e) {
    console.log(`✗ ${MANIFEST} 读不到：${(e as Error).message}`)
    return 1
  }

  const check = (dir: string, listed: string[] | undefined): void => {
    if (listed === undefined) {
      console.log(`✗ ${MANIFEST} 里没有 ${dir} 这一项`)
      failed++
      return
    }

    const actual = collectJsonFiles(dir)
      .map(f => f.replace(/\\/g, '/').split('/').pop() ?? '')
      .filter(f => f.endsWith('.json'))
      .map(f => f.slice(0, -5))

    const missing = listed.filter(n => !actual.includes(n))
    const orphan = actual.filter(n => !listed.includes(n))

    if (missing.length > 0) {
      console.log(`✗ ${MANIFEST} 里列了不存在的文件（客户端会 404）：${missing.join(', ')}`)
      failed++
    }
    if (orphan.length > 0) {
      console.log(`✗ ${dir} 里有文件没进清单（永远不会被加载）：${orphan.join(', ')}`)
      failed++
    }
    if (missing.length === 0 && orphan.length === 0) {
      console.log(`✓ ${dir} 和 ${MANIFEST} 对得上（${actual.length} 个）`)
    }
  }

  check('content/skills', manifest.skills)
  check('content/internal-techniques', manifest.internalTechniques)
  // ⚠ 状态库和实体预设也要查：它们是**被引用**的内容，
  //   漏进清单的表现是"技能引用的状态/预设根本没加载"，而那是运行期才炸的
  check('content/statuses', manifest.statuses)
  check('content/entities', manifest.entities)
  check('content/scenarios', manifest.scenarios)
  check('content/fx', manifest.fx ?? [])
  /*
   * ⚠ 武器那一层也要查。
   *   不查的话，加了一个武器文件但忘了写进清单 —— 命令行里一切正常、
   *   浏览器里那件武器**直接不存在**（读不到文件，而且不报错）。
   *   这正是当初加这份检查的原因（manifest 少一项 → 白屏）。
   */
  check('content/weapon-skills', manifest.weaponSkills ?? [])
  check('content/weapons', manifest.weapons ?? [])
  /*
   * ⚠ **修饰原型也要查**（2026-09-21，日志 48）。
   *   它们和技能**不是同一类东西**（原型没有阶段、没有规则、不算账），
   *   所以漏进清单的表现也一样安静：用到它的那份术式在命令行里正常、
   *   在网页上编译成一条 `UNKNOWN_MODIFIER` ——
   *   玩家看到的是"我那个触发器在网页上不见了"。
   */
  check('content/modifiers', manifest.modifiers ?? [])
  return failed
}

process.exitCode = main()
