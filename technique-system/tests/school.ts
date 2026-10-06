/**
 * **系别的推导规则**（`src/school.ts` 的 `deriveTechniqueKind`）+ 出厂内容核对。
 *
 * ## 为什么这个文件必须存在
 *
 * 技能系别是**派生章**（按目录盖，不写进 JSON），而术式系别 `Technique.kind`
 * 是显式字段 —— 但**老内容 / 老存档 / 老分享码**里没有它，得由加载器推。
 * 那条推导规则错起来是**静默的**：一份术式被判成另一系，不给它算账、
 * 编辑器的技能库只给它一半技能，全程没有一处会报错。
 *
 * 玩家 2026-09-21 就是这么发现第一条规则的毛病的，原话：
 *   > **"它没有引用武器技能，为什么是武器术式？改回来"**
 *
 * 所以这里钉三件事：
 *   1. **规则本身**：传递（容器 → 段 → 段里的段；老形状还多一次按 id 查表），
 *      而不是"看它挂没挂序列"
 *   2. **防循环**：序列互相引用时不许爆栈、也不许无限转
 *   3. **14 份出厂内容**用新规则算出来的 kind，和文件里现在写的是否一致
 *      （⚠ 17 → 13：序列内联之后那四份"只为当序列而存在"的子术式不再是独立文件，见日志 46）
 *      （⚠ 13 → 14：日志 48 拆「背水」时**多了一门常驻术式** `tech.last-stand`，见下面那一段注释）
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readJson } from '../src/loader.ts'
import { deriveTechniqueKind, deriveTechniqueKinds, schoolOfSkillFile } from '../src/school.ts'
import type { TechniqueRefsShape } from '../src/school.ts'
import type { SequenceSegment, Skill, Technique } from '../src/schema.ts'

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

// ============================================================================
//  出厂内容：从**目录**读（技能系别的唯一真相是目录，见 src/school.ts）
// ============================================================================

const TECH_DIR = 'content/internal-techniques'

/** 全部内部术式，按 id 索引 —— 序列复用术式这一层，所以两张表在一处查 */
const techById = new Map<string, Technique>()
for (const f of readdirSync(TECH_DIR).sort()) {
  if (!f.endsWith('.json')) continue
  const t = readJson<Technique>(join(TECH_DIR, f))
  techById.set(t.id, t)
}

/**
 * 内容里全部**武器系技能**的 id。
 *
 * ⚠ 这里**故意不写死** `['skill.ws-slash', 'skill.ws-thrust']`：
 *   写死的话，以后往 `content/weapon-skills/` 加一份模板、忘了改这个测试，
 *   测试照绿 —— 而"武器技能"的判据只有目录一处（见 `schoolOfSkillFile`）。
 */
const weaponSkillIds = new Set<string>()
{
  const dir = 'content/weapon-skills'
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue
    const s = readJson<Skill>(join(dir, f))
    /*
     * ⚠ 传**绝对路径**给 `schoolOfSkillFile`：它靠 `includes('/content/weapon-skills/')`
     *   认目录，而 `content/weapon-skills/slash.json` 这种相对路径**开头没有斜杠**，
     *   直接传会认成 magic（这个坑 `src/school.ts` 里那句注释就写着，
     *   但"路径要给全"是调用方的责任）。加载器给的就是绝对 / 项目相对根路径。
     */
    if (schoolOfSkillFile(join(process.cwd(), dir, f)) === 'weapon') weaponSkillIds.add(s.id)
  }
}

/** 和加载器用的是**同一条**规则、同一个解析器（`src/bridge.ts` 也是这么查的） */
const derive = (t: Pick<Technique, 'sequences' | 'skills'>): string =>
  deriveTechniqueKind(t, weaponSkillIds, id => techById.get(id))

/**
 * 一份**合成**的序列图：只给"规则本身"那些用例用。
 *
 * ⚠ 合成图而不是拿内容里的真术式来测，是因为要测的东西是**形状**：
 *   内容里恰好没有"三层序列"、"A→B→A 的环"这种形状，
 *   而它们正是规则最容易写错的地方（写死两层、忘了防循环）。
 *
 * ```
 *   seg-w1   skills: [skill.ws-slash]        ← 武器技能
 *   seg-m1   skills: [skill.mark]            ← 魔法技能
 *   seq-w1   sequences: [seg-w1]             ← **老形状**：一层，最里面是武器
 *   seq-2    sequences: [{ skills: [skill.ws-slash] }]      ← 内联：两层
 *   seq-m2   sequences: [{ skills: [skill.mark] }]          ← 内联：两层，魔法
 *   seq-3    sequences: [内联段(魔法), 内联段(武器)]        ← 内联：三层，走到底才碰到武器
 * ```
 *
 * ⚠ **老形状那两条必须留着**（`seq-w1` 和下面 `sequenceOf` 那一组用例）：
 *   内容里已经一份都不剩了，但**老存档 / 老分享码里就是它**，
 *   而"老数据补 kind 补对了没有"正是这个文件盯着的头号问题。
 */
const SYNTH: Record<string, TechniqueRefsShape> = {
  'seg-w1': { skills: ['skill.ws-slash'] },
  'seg-m1': { skills: ['skill.mark'] },
  'seq-w1': { sequences: ['seg-w1'] },
  'seq-2': { sequences: [{ skills: ['skill.ws-slash'] }] },
  'seq-m2': { sequences: [{ skills: ['skill.mark'] }] },
  /*
   * ⚠ 三层靠一个**段的 `skills` 里再嵌一层**来表达。
   *   段自己按 `SequenceSegment` 声明时没有 `sequences` 字段，
   *   所以这里把整个合成节点断言成段 —— 合成本来就是"造一个形状出来"，
   *   而形状的这一支正是要测的（"往下走到底"）。
   */
  'seq-3': {
    sequences: [
      { skills: ['skill.mark'] },
      { skills: [], sequences: [{ skills: ['skill.ws-slash'] }] } as unknown as SequenceSegment,
    ],
  },
}
const synth = (t: TechniqueRefsShape): string =>
  deriveTechniqueKind(t, weaponSkillIds, id => SYNTH[id])

// ============================================================================
//  1. 规则本身：传递，而不是"看它写没写 sequences"
// ============================================================================

section('推导规则：有武器技能就是 weapon —— 传递地看，而不是看有没有 sequences')

{
  ok('直接引用武器技能 → weapon',
    derive({ skills: ['skill.ws-slash'] }) === 'weapon')

  /*
   * ⚠ **内联的那一半**（现在写内容用这个）：技能就在段里，一层都不用跳。
   *   这一条钉的是"段自己的 `skills` 真的被读了" ——
   *   只看容器那一层的话，武器术式会被判成魔法术式，出厂内容当场非法。
   */
  ok('内联：容器只挂序列，段里是武器技能 → weapon',
    derive({ sequences: [{ skills: ['skill.ws-slash'] }] }) === 'weapon')

  /*
   * ⚠ **老形状的那一半**（老存档 / 老分享码）：按 id 顺着查。
   *   这条读法不能省 —— 省了的话，一份只挂序列的老武器术式会被补成 magic。
   */
  ok('老形状：容器只挂序列 id，那份序列里是武器技能 → weapon',
    synth({ sequences: ['seq-w1'] }) === 'weapon')
}

{
  /*
   * ⚠ **玩家发现的那条反例的形状**：一份术式挂了序列，
   *   但序列里全是**魔法**技能 —— 它必须是 magic。
   *   "有序列就是武器术式"那一句在这里当场错。
   */
  ok('内联：段里是魔法技能 → magic（**不是** weapon）',
    derive({ sequences: [{ skills: ['skill.mark'] }] }) === 'magic')

  ok('老形状：段里是魔法技能 → magic',
    synth({ sequences: ['seg-m1'] }) === 'magic')

  ok('两层（内联）：段里嵌序列，最里面才是武器技能 → weapon（必须走到底）',
    synth({ sequences: ['seq-2'] }) === 'weapon')

  ok('两层（内联）：走到最里面全是魔法技能 → magic',
    synth({ sequences: ['seq-m2'] }) === 'magic')
}

{
  /*
   * ⚠ **不许假设"两层就够"**：序列可以再套序列。
   *   递归写死两层的实现会在这里红。
   */
  ok('三层（内联套内联）：还要往下走一层才碰到武器技能 → weapon',
    synth({ sequences: ['seq-3'] }) === 'weapon')
}

{
  /*
   * ⚠ `sequenceOf` 缺席时（命令行不读存档、分享码里看不见内容库）
   *   不许崩，退化成"自己直接引用的技能里有没有武器技能"。
   */
  ok('没有序列解析器时不崩、也不猜 weapon（老形状读不出来）',
    deriveTechniqueKind({ sequences: ['seq-2'] }, weaponSkillIds) === 'magic')
  ok('没有解析器时"直接引用了武器技能"照样认得出',
    deriveTechniqueKind({ skills: ['skill.ws-slash'] }, weaponSkillIds) === 'weapon')
  /*
   * ⚠ 内联的段**不需要**解析器 —— 技能就在手边（这是内联带来的实际好处之一：
   *   分享码里看不见内容库，但内联的段照样推得出系别）。
   */
  ok('内联的段在没有解析器时照样推得出（技能就在段里）',
    deriveTechniqueKind({ sequences: [{ skills: ['skill.ws-slash'] }] }, weaponSkillIds) === 'weapon')

  /*
   * ⚠ 悬空引用（手指头敲错一个字母）：序列查不到就**当它不存在**往下走，
   *   不许抛。真报"序列不存在"是校验器的活（`UNKNOWN_SEQUENCE`）。
   */
  ok('序列 id 查不到时当它不存在（不抛）',
    synth({ sequences: ['seq-根本没有这一份'] }) === 'magic')
}

section('防循环：序列互相引用不许爆栈、也不许无限转')

{
  /*
   * ⚠ 循环在**加载内容**的时候就会走这条路 —— 爆栈的后果是白屏，
   *   而不是某一份术式坏了。玩家手改过的存档、或者两份序列互相包含，
   *   都能造出这个形状。
   */
  let calls = 0
  const kinds = deriveTechniqueKinds(
    [
      { id: 'tech.a', sequences: ['tech.b'] },
      { id: 'tech.b', sequences: ['tech.a'] },
    ],
    weaponSkillIds,
  )
  ok('两份互相引用（A → B → A）都算得出结果，不爆栈',
    kinds.get('tech.a') === 'magic' && kinds.get('tech.b') === 'magic',
    `${String(kinds.get('tech.a'))} / ${String(kinds.get('tech.b'))}`)

  const selfLoop = deriveTechniqueKind(
    { sequences: ['tech.self'] },
    weaponSkillIds,
    id => {
      calls++
      return id === 'tech.self' ? { sequences: ['tech.self'] } : undefined
    },
  )
  ok('自己引用自己（A → A）也不转圈', selfLoop === 'magic', String(selfLoop))
  ok('  而且每个 id 只展开一次（不是靠"转够了就停"）', calls === 1, `展开了 ${calls} 次`)

  /*
   * ⚠ 环上**有**武器技能时，还得照样找得到它 ——
   *   防循环不能顺手把答案也屏蔽掉。
   */
  const withWeapon = deriveTechniqueKind(
    { sequences: ['tech.a'] },
    weaponSkillIds,
    id => (id === 'tech.a'
      ? { sequences: ['tech.b'] }
      : id === 'tech.b' ? { sequences: ['tech.a'], skills: ['skill.ws-slash'] } : undefined),
  )
  ok('  环里藏着武器技能时照样判 weapon', withWeapon === 'weapon', withWeapon)
}

// ============================================================================
//  2. 出厂内容：14 份术式的 kind 和**新规则**算出来的必须一致
// ============================================================================

section('出厂内容：14 份术式用新规则算出来的 kind = 文件里写的')

{
  /*
   * ⚠ **17 → 13**（2026-09-21 日志 46）：序列内联之后，那四份"只为当序列而存在"
   *   的子术式（`ws-slash` / `ws-thrust` / `mark-step` / `blink-step`）**不再是独立文件** ——
   *   它们成了容器里的两段。这个数字**写死**是有意的：它逼着下一个人
   *   "多了/少了都要重数一遍"，而不是让名单悄悄漂。
   *
   * ⚠ **13 → 14**（2026-09-21 日志 48）：**这就是"多了"那一回，我重数过了。**
   *   多的那一份是 `content/internal-techniques/last-stand.json`（`tech.last-stand`）。
   *
   *   为什么它**必须**多出来（不是有人手滑往目录里丢了一份文件）：
   *   玩家定的「背水」拆解形状是 **监测器 + 生成护盾的技能 + 一门常驻术式**。
   *   前两件是 `mod.monitor.low-hp`（副本挂在段里）和 `skill.last-stand-shield`；
   *   而"常驻包装把它自己和后面那个技能包装成常驻 → 进常驻序列、不参与按键激活"
   *   那句要落地，就必须**真的有一门术式**去承载那个 `wrap`/`monitor` 的段 ——
   *   副本住在段里，段住在术式里，术式只能是一份文件。
   *   ⇒ 那一门术式**没有别的地方可放**，所以 +1 是拆解本身的算术后果。
   *
   *   ⚠ 同时 `content/skills/last-stand.json`（旧的 `skill.last-stand`）**整个删掉了**
   *     （拆成了监测器 + 撑盾），所以技能那一侧数目不变、**没有留半死的旧技能**。
   */
  ok(`内部术式一共 14 份（多了 / 少了都要重数一遍这份测试）`,
    techById.size === 14, String(techById.size))
  ok('武器技能表是从目录读出来的（不是写死的两个 id）',
    weaponSkillIds.size === 2 && weaponSkillIds.has('skill.ws-slash'),
    [...weaponSkillIds].join(', '))

  const mismatched: string[] = []
  const weapons: string[] = []
  for (const [file, t] of [...techById].map(([id, t]) => [id, t] as const).sort()) {
    const derived = derive(t)
    if (derived === 'weapon') weapons.push(file)
    if (derived !== t.kind) mismatched.push(`${file}：写的 ${String(t.kind)}，算出来 ${derived}`)
  }

  /*
   * ⚠ **这一条是这次修复的核心断言**。它不靠"某一两份文件的 kind 写对了"，
   *   而是把**全部**出厂内容都按规则重算一遍 —— 以后有人把某份魔法术式
   *   标成 weapon（或者反过来），这里立刻红，而且报得出是哪个文件。
   *
   * ⚠ 为什么它必须在 `tests/` 里而不是校验器里：校验器只看"同一门术式里
   *   的技能同不同系"（`MAGIC_TECHNIQUE_WEAPON_SKILL` 那两条），
   *   一份**魔法术式里放了魔法技能**但 kind 标成 weapon 的，它一条都不报 ——
   *   而"算出来的 kind"和"写的 kind"不一致正是这个形状。
   */
  ok('14 份全部一致（不一致的一个都不能有）',
    mismatched.length === 0, mismatched.join('\n      '))

  /*
   * ⚠ 玩家点名的那两条：**必须**是这个分布。
   *   写死这几条是为了让"全一致"不是空话 —— 万一 14 份的 kind 全被改成
   *   同一个值（比如全 weapon），"全一致"照样绿，而这几条会红。
   *
   * ⚠ 那两份**容器**现在自己就带着技能（内联的段里），所以"算出来是 weapon"
   *   走的是**内联那一半**的推导 —— 这正是这次迁移要顶着的那条路。
   */
  for (const id of ['tech.iron-sword-basic', 'tech.longsword-basic']) {
    ok(`  ${id} 算出来是 weapon（技能内联在它的段里）`,
      derive(techById.get(id) as Technique) === 'weapon')
  }
  ok('  tech.mark-blink 算出来是 magic（它没有引用任何武器技能）',
    derive(techById.get('tech.mark-blink') as Technique) === 'magic')
  ok('  而且它文件里写的也是 magic（2026-09-21 改的，见它的 _comment_kind）',
    techById.get('tech.mark-blink')?.kind === 'magic',
    String(techById.get('tech.mark-blink')?.kind))

  ok('武器侧一共就这 2 份（两份容器；那两条序列现在在里面）',
    weapons.length === 2, weapons.join(', '))
  /*
   * ⚠ 12 = 14 − 武器那 2 份。写死的是**差值**而不是"数一遍 magic"：
   *   这样"多了/少了"由上面那条抓，"分布被改"由这条抓，两条各管一件事。
   *   （13 份那会儿这里是 11 —— 日志 48 多了 `tech.last-stand` 这份 magic，跟着 +1。）
   */
  ok('其余 12 份全是 magic',
    weapons.length + 12 === techById.size)
}

{
  /*
   * ⚠ mark-blink 这个形状**只靠 kind** 是判不出来的：它挂了序列
   *   （长得和武器术式一样），区别只在"序列里面是什么技能"。
   *   所以这两件事必须一起成立，缺一条就说明规则又漂回去了：
   *     1. 它挂了序列（和武器术式形状相同）
   *     2. 它算出来是 magic
   *
   * ⚠ **内联之后这一条更要紧了**：以前那两段是独立文件，各自会被校验一遍；
   *   现在它们只是容器里的两个对象，所以"里面是什么技能"这件事
   *   **只有这里和校验器的 `UNKNOWN_SKILL` 在看着**。
   */
  const mb = techById.get('tech.mark-blink') as Technique
  ok('mark-blink 的形状和武器术式一样（都只挂序列）—— 所以只能靠"里面是什么技能"判',
    (mb.sequences ?? []).length === 2 && mb.skills === undefined,
    JSON.stringify({ seq: mb.sequences, skills: mb.skills }))

  ok('  它的两段**真的带着技能**（内联之后技能就在段里）',
    (mb.sequences ?? []).every(s => typeof s !== 'string' && s.skills.length > 0),
    JSON.stringify((mb.sequences ?? []).map(s => (typeof s === 'string' ? s : s.skills))))
}

console.log('')
if (failed > 0) {
  console.log(`✗ ${failed} 个断言失败（${passed} 个通过）`)
  process.exitCode = 1
} else {
  console.log(`✓ 全部 ${passed} 个断言通过`)
  process.exitCode = 0
}
