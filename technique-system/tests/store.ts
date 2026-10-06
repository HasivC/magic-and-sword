/**
 * 存档 + 分享码的测试。
 *
 * ## 为什么这个文件必须有
 *
 * `store.ts` 里有两件事**不能靠手测**：
 *
 *   1. **别人给的分享码是敌意输入。** 它会被聊天软件加零宽字符、
 *      会被截断、可能是别的版本、也可能被人手改过。
 *      这些情况全都得**给一句人话的原因**，而不是让引擎拿着
 *      一份坏数据去炸 —— 那种崩溃现场离原因太远了。
 *
 *   2. **存档坏掉不能让游戏打不开。** 玩家改到一半关了浏览器、
 *      上个版本留下的旧格式、隐私模式下写不进去 ——
 *      这些都是常态，正确处理方式是"退回空存档继续玩"。
 *
 * ⚠ 这里**没有测 UI**。UI 的行为靠 `tests/web.ts` 里那次真的 boot 来兜。
 */
import {
  SAVE_KEY, SAVE_VERSION, decodeShare, emptyState, encodeShare, isTechniqueShape, loadState, missingSkills,
  parseState, saveState,
} from '../web/src/store.ts'
import type { StorageLike } from '../web/src/store.ts'
import type { Skill, Technique } from '../src/schema.ts'
import { resolve } from 'node:path'
import { loadLibrary } from '../src/bridge.ts'
import { readJson } from '../src/loader.ts'
import { compileTechnique } from '../src/sim/compile.ts'
import type { BalanceConfig } from '../src/validator/types.ts'

const balance = readJson<BalanceConfig>(resolve('content/balance.json'))

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

function tech(over: Partial<Technique> = {}): Technique {
  return {
    schemaVersion: 1,
    id: 'tech.mine-1',
    name: '我的连招',
    // ⚠ 系别必填（schema 的 Technique.kind）。写在 `...over` 之前 ——
    //   这样用例想造一份 weapon 术式时还能用 `tech({ kind: 'weapon' })` 覆盖它
    kind: 'magic',
    activation: 'press',
    /*
     * ⚠ **不写 `targeting`**（2026-09-21 日志 47）：瞄准在**技能**上，
     *   术式这一层没有这个字段了 —— 而这一节测的是**存档的形状/分享码**，
     *   和瞄准无关。留着它反而会让 `isTechniqueShape` 之类的地方看起来
     *   还需要那个字段（它已经不需要了）。
     */
    skills: ['skill.cleave', 'skill.magic-bolt'],
    links: [{ if: [{ type: 'prevHit' }], note: '上一段碰到了才继续' }],
    ...over,
  }
}

/** 内存里的假 storage。可以用它模拟"写不进去" */
function fakeStorage(failWrite = false): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (failWrite) throw new Error('QuotaExceededError')
      data.set(k, v)
    },
  }
}

// ============================================================================
//  分享码
// ============================================================================

section('分享码：好码要能原样回来')

{
  const t = tech()
  const code = encodeShare(t)
  /*
   * ⚠ 第 3 代码（2026-09-21，日志 48）：修饰副本跟着术式走。
   *   ⚠ 它和第 2 代的**形状**只差一个可选的 `sequences[].mods` ——
   *     所以第 2 代的码**仍然读得进来**（下面那一节专门钉它）。
   */
  ok('码有 TS3. 前缀', code.startsWith('TS3.'), code.slice(0, 12))
  ok('码里只有 URL 安全的字符（不会被聊天软件转义）',
    /^TS3\.[A-Za-z0-9_-]+$/.test(code), code.slice(0, 40))

  const back = decodeShare(code)
  ok('解出来是成功的', back.ok, back.ok ? '' : back.error)
  if (back.ok) {
    /*
     * ⚠ 比的是**整份结构**，不是几个字段。
     *   漏掉 links 的话，"条件门"会在分享的路上静默消失 ——
     *   收到的人拿到的是"两段无条件连着"的术式，看起来像能用，
     *   但那已经不是发的人做的那一份了。
     */
    ok('  整份术式逐字段一致（含 links）',
      JSON.stringify(back.technique) === JSON.stringify(t),
      JSON.stringify(back.technique))
  }
}

section('分享码：脏输入要给得出原因')

{
  const good = encodeShare(tech())

  const empty = decodeShare('')
  ok('空字符串 → 拒绝，并且说"码是空的"',
    !empty.ok && empty.error.includes('空'), empty.ok ? '' : empty.error)

  const notCode = decodeShare('你好，这是我做的术式')
  ok('不是码 → 拒绝，并且提示开头应该是 TS3.',
    !notCode.ok && notCode.error.includes('TS3.'), notCode.ok ? '' : notCode.error)

  /*
   * 截断：聊天软件按字数截断、或者复制的时候少划了一行。
   * 这是**最常见**的一种坏输入。
   */
  const truncated = decodeShare(good.slice(0, Math.floor(good.length / 2)))
  ok('截断的码 → 拒绝（不是拿到半份术式）',
    !truncated.ok, truncated.ok ? JSON.stringify(truncated.technique) : '')

  // 聊天软件很喜欢往里面塞零宽字符和换行
  const padded = decodeShare(`  ${good.slice(0, 10)}\u200b${good.slice(10)}\n`)
  ok('里面混了零宽字符 / 空格 / 换行 → 照样解得出来',
    padded.ok, padded.ok ? '' : padded.error)

  /*
   * ⚠ 2026-09-21（日志 48）：**第 2 代码照旧读得进来**（玩家定的"别废掉已有的码"）。
   *   它和第 3 代的差别只有"术式里没有 `mods`"—— 那是一份**合法**的术式，
   *   所以解出来应当是成功的，而不是"第几代不认"。
   */
  const v2 = `TS2.${Buffer.from(JSON.stringify({ technique: tech() }), 'utf8').toString('base64url')}`
  const old2 = decodeShare(v2)
  ok('第 2 代码（TS2.）仍然解得开（别废掉已有的码）',
    old2.ok, old2.ok ? '' : old2.error)

  // 4 代还不存在 —— 但错误要说清"这是第几代"，不是笼统的"解码失败"
  const future = decodeShare('TS4.AAAA')
  ok('别的版本的码 → 说清楚是第几代，而不是"解码失败"',
    !future.ok && future.error.includes('第 4 代'), future.ok ? '' : future.error)

  // 合法 base64，但里面不是一份术式
  const notTech = 'TS3.' + Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const wrongShape = decodeShare(notTech)
  ok('码里是一段合法 JSON 但不是术式 → 拒绝，并说字段不全',
    !wrongShape.ok && wrongShape.error.includes('字段不全'),
    wrongShape.ok ? '' : wrongShape.error)

  /*
   * ⚠ 形状对但**不合法**：一个技能都没引用。
   *   这时候必须走校验器拦下来 —— 放进引擎的话它是个空时间轴，
   *   玩家按下去没反应，而且完全看不出为什么。
   */
  const hollow = encodeShare(tech({ skills: [] }))
  const bad = decodeShare(hollow)
  ok('形状对但不合法的术式（没有技能）→ 校验器拦下来',
    !bad.ok && bad.error.includes('不合法'), bad.ok ? '' : bad.error)
}

// ============================================================================
//  形状：序列术式**不写 `skills`** —— 不许被判"字段不全"
// ============================================================================

section('序列术式（只写 sequences、没有 skills）能过形状检查、能读回来')

{
  /*
   * ⚠ 这是一次**玩家报上来的** bug（2026-09-21，日志 44）：
   *   `isTechniqueShape` 原来要求 `skills` **必须是数组**，而序列术式
   *   （`Technique.skills` 和 `sequences` **二选一**，schema 里写着）
   *   **根本不写 `skills`**。后果是：
   *     · 玩家自己做的带序列的术式 → 读存档时被判"字段不全"、**静默丢掉**
   *     · 别人发来的老分享码 → 解出来就说"字段不全"
   *
   * ⚠ 为什么它以前"看起来没问题"：内容里那几份序列术式走的是**另一条**
   *   加载路径（`web/src/main.ts` 直接 fetch JSON，不过这个形状检查）。
   *   所以只有**玩家自己做的东西**会撞上它 —— 而玩家的东西正是存档和分享码。
   */
  /*
   * ⚠ `links: []`：`tech()` 默认带一条 `links`，而 `links` 是 `skills` 的
   *   平行数组（`links[i]` 管 `skills[i+1]`）。一份只挂序列的术式上留一条
   *   `links`，校验器当场报"有 1 条连接，但 0 个技能最多只需要 0 条" ——
   *   那是**另一条**规矩（`skills` / `sequences` 二选一）在正常工作，
   *   不是形状检查的问题。
   */
  const onlySequences: Record<string, unknown> = { ...tech({ id: 'tech.mine-seq', links: [] }) }
  delete onlySequences['skills']
  onlySequences['sequences'] = ['tech.mark-step', 'tech.blink-step']
  onlySequences['sequenceLinks'] = [{ note: '有标记才闪' }]

  ok('形状检查认它（有 sequences 就够）', isTechniqueShape(onlySequences))
  ok('  而且它**真的没有** skills 字段（不是塞了个空数组糊过去的）',
    !('skills' in onlySequences))

  /*
   * ⚠ **老存档兼容**：这两件事必须一起成立 —— 形状过了 **并且** 存/读一趟
   *   回来那份术式还在、序列一个字没变。只测形状的话，
   *   "形状过了但存档那一步还是把它过滤了"照样能溜过去。
   */
  const s = fakeStorage()
  saveState(s, {
    version: SAVE_VERSION,
    skills: [],
    techniques: [onlySequences as unknown as Technique],
    loadout: ['tech.mine-seq'],
  })
  const back = loadState(s)
  ok('  存档写进去、读回来还在（玩家做的东西不能刷新就没了）',
    back.techniques.length === 1 && back.techniques[0]?.id === 'tech.mine-seq',
    JSON.stringify(back.techniques.map(t => t.id)))
  ok('  序列和序列之间那条门一个字没变',
    back.techniques[0]?.sequences?.length === 2
    && back.techniques[0]?.sequences?.[1] === 'tech.blink-step'
    && back.techniques[0]?.sequenceLinks?.length === 1,
    JSON.stringify({ seq: back.techniques[0]?.sequences, links: back.techniques[0]?.sequenceLinks }))
  ok('  而且它补上了 kind（老存档里的东西没有这个字段）',
    back.techniques[0]?.kind === 'magic', String(back.techniques[0]?.kind))

  /*
   * ⚠ ---- **第 1 代码（`TS1.`）现在被明确拒绝**（玩家 2026-09-21 裁定，日志 47）----
   *
   *   他原话的意思是"省掉一半工作"：**老分享码不用再兼容了**，
   *   但**错误信息必须是人话** —— 玩家得知道"这不是我的操作错了，
   *   是这份码太老"，以及"该怎么办"。
   *
   *   ⚠ 和**老存档**那条路故意分开：存档是玩家**自己正在用**的作品，必须继续读
   *     （`parseState` 里那条剥 `targeting` 的迁移），见下面那一节。
   */
  const v1 = `TS1.${Buffer.from(JSON.stringify(onlySequences), 'utf8').toString('base64url')}`
  const old = decodeShare(v1)
  ok('  第 1 代老码：**明确拒绝**（不再兼容 —— 玩家 2026-09-21 裁定）',
    !old.ok, JSON.stringify(old))
  ok('  而且给的是**人话**：说清"这是老格式"+"让对方重新复制一份"',
    !old.ok && old.error.includes('老格式') && old.error.includes('重新复制'),
    old.ok ? '' : old.error)

  /*
   * ⚠ 最后钉一条**反向**的：形状检查放宽的是"`skills` 可以是缺席"，
   *   **不是**"什么都不用有"。两个字段都没有 = 一份空壳，
   *   放进去会在编译期炸，所以仍然要拦。
   *   少了这一条，把 `||` 写成"永远 true"也不会红。
   */
  const neither: Record<string, unknown> = { ...tech({ id: 'tech.hollow' }) }
  delete neither['skills']
  ok('  两个都没有（空壳）仍然判不通过', !isTechniqueShape(neither))
  ok('  sequences 写了但不是数组（漏了方括号的手改存档）也判不通过',
    !isTechniqueShape({ ...neither, sequences: 'tech.mark-step' }))
}

section('分享码：知道对方缺哪些技能')

{
  const t = tech()
  const have = new Set(['skill.cleave'])
  const missing = missingSkills(t, have)
  ok('缺的技能会被列出来（不是静默变成空段）',
    missing.length === 1 && missing[0] === 'skill.magic-bolt', missing.join(', '))

  const hasAll = missingSkills(t, new Set(['skill.cleave', 'skill.magic-bolt']))
  ok('全都有就是空的', hasAll.length === 0, hasAll.join(', '))
}

// ============================================================================
//  存档
// ============================================================================

section('存档：坏数据不许把游戏搞崩')

{
  ok('null → 空存档', parseState(null).techniques.length === 0)
  ok('字符串 → 空存档', parseState('这不是存档').techniques.length === 0)
  ok('空对象 → 空存档', parseState({}).techniques.length === 0)

  const mixed = parseState({
    techniques: [tech(), { id: 'x' }, null, 42, 'nope'],
    loadout: ['tech.mine-1', 7, ''],
  })
  ok('结构不对的条目被丢掉，好的留下',
    mixed.techniques.length === 1 && mixed.techniques[0]?.id === 'tech.mine-1',
    JSON.stringify(mixed.techniques.map(t => t.id)))
  ok('loadout 里的非字符串被丢掉',
    mixed.loadout.length === 1 && mixed.loadout[0] === 'tech.mine-1',
    JSON.stringify(mixed.loadout))

  /*
   * ⚠ **不平衡的术式必须能存下来。**
   *   玩家可能是编到一半关掉浏览器的，那份术式当然是没配平的。
   *   如果存档这一层用完整校验（含配平）来过滤，就会把半成品吃掉 ——
   *   而"编到一半被打断"是最常见的用法。
   */
  const half = tech({ skills: ['skill.cleave'] })
  const saved = parseState({ techniques: [half], loadout: [] })
  ok('没配平的半成品也存得下来（不校验玩法层面的问题）',
    saved.techniques.length === 1, String(saved.techniques.length))
}

section('存档：读写')

{
  const s = fakeStorage()
  ok('空 storage 读出来是空存档', loadState(s).techniques.length === 0)

  const state = { version: SAVE_VERSION, skills: [], techniques: [tech()], loadout: ['tech.mine-1'] }
  ok('写得进去', saveState(s, state))
  const back = loadState(s)
  ok('读回来一致',
    back.techniques.length === 1 && back.loadout[0] === 'tech.mine-1',
    JSON.stringify(back.loadout))

  s.data.set(SAVE_KEY, '{ 这不是 JSON')
  ok('存档是坏 JSON → 退回空存档（不 throw）',
    loadState(s).techniques.length === 0)

  const full = fakeStorage(true)
  ok('写不进去时返回 false（让调用方能提示玩家）',
    saveState(full, state) === false)

  ok('没有 storage 时读写都不炸',
    loadState(undefined).techniques.length === 0
    && saveState(undefined, emptyState()) === false)
}

section('自定义技能库：存档带着它，分享码也带着它')

{
  /*
   * ⚠ 玩家 2026-09-21 定的模型：**两个库**。
   *
   *   基础技能库在内容里（只读）；**自定义技能库在存档里**。
   *   所以两件事必须成立：
   *     1. 存档带着它 —— 不带的话"我编的火球"刷新就没了
   *     2. 分享码也带着它 —— 不带的话收码的人拿到的是一份
   *        **用基础数值跑的**连招，和发码的人玩的不是同一个东西
   */
  const variant: Skill = {
    schemaVersion: 1,
    id: 'custom.cleave.1',
    name: '裂地斩-副本1',
    basedOn: 'skill.cleave',
    phases: [{ id: 'cast', duration: 0.3, occupiesCaster: false, interrupt: 'damage', cancellable: true }],
    rules: [],
    ruleSlots: 10,
  }
  // ⚠ 一份只用**一个**技能的术式：`tech()` 默认带一条两段之间的连接，得去掉
  const mine = tech({ skills: ['custom.cleave.1'], links: [] })

  const s = fakeStorage()
  ok('存档写得进去（带自定义技能库）',
    saveState(s, { version: SAVE_VERSION, skills: [variant], techniques: [mine], loadout: [] }))
  const back = loadState(s)
  ok('  自定义技能读回来还在（刷新不丢）',
    back.skills.length === 1 && back.skills[0]?.id === 'custom.cleave.1'
    && back.skills[0]?.basedOn === 'skill.cleave',
    JSON.stringify(back.skills))

  const decoded = decodeShare(encodeShare(mine, [variant]))
  ok('  分享码里带着它（收码的人玩的是同一份东西）',
    decoded.ok && decoded.skills.length === 1
    && decoded.skills[0]?.name === '裂地斩-副本1',
    decoded.ok ? JSON.stringify(decoded.skills) : decoded.error)

  // ⚠ 不带技能包的码也要能解（不然"只发术式"就成了错误路径）
  const bare = decodeShare(encodeShare(mine))
  ok('  不带技能包的码照样解得开（技能包是可选的）',
    bare.ok && bare.skills.length === 0, bare.ok ? '' : bare.error)

  // ⚠ 第 1 代码（只有一份术式）**2026-09-21 起不再兼容**（见下面那一节）
  const v1 = `TS1.${Buffer.from(JSON.stringify(mine), 'utf8').toString('base64url')}`
  const old = decodeShare(v1)
  ok('  第 1 代的老码被**明确拒绝**（玩家 2026-09-21 裁定：不再兼容）',
    !old.ok, JSON.stringify(old))
}

section('v1 → v2 迁移：术式私藏副本 → 自定义技能库')

{
  /*
   * ⚠ v1 的存法是"每个术式私藏一份技能副本"（`Technique.skillCopies`）。
   *   那个模型废了，但**玩家改过的东西不能丢**：读存档时要把它搬进
   *   自定义技能库、给新 id 和 `basedOn`，并把引用它的术式改指过去。
   */
  const copy: Skill = {
    schemaVersion: 1,
    id: 'skill.magic-bolt',
    name: '魔法飞弹',
    phases: [{ id: 'cast', duration: 0.3, occupiesCaster: false, interrupt: 'damage', cancellable: true }],
    rules: [],
    ruleSlots: 9,
  }
  const oldTech = { ...tech({ skills: ['skill.magic-bolt', 'skill.cleave'] }), skillCopies: [copy] } as unknown

  const state = parseState({ version: 1, techniques: [oldTech], loadout: [] })
  const moved = state.skills[0]
  ok('副本被搬进了自定义技能库', state.skills.length === 1, JSON.stringify(state.skills))
  ok('  新 id 是 custom.*，而且记住了模板',
    moved?.id.startsWith('custom.') === true && moved?.basedOn === 'skill.magic-bolt',
    `${String(moved?.id)} basedOn=${String(moved?.basedOn)}`)
  ok('  术式里的引用改指到了新 id（不然它就变成"缺技能"了）',
    state.techniques[0]?.skills?.[0] === moved?.id
    && state.techniques[0]?.skills?.[1] === 'skill.cleave',
    JSON.stringify(state.techniques[0]?.skills))
  ok('  术式上不再留着 skillCopies（留着下一版又会读到老结构）',
    (state.techniques[0] as unknown as { skillCopies?: unknown }).skillCopies === undefined)
}

section('v2 → v3 迁移：老术式补系别（kind），别的一个都不丢')

{
  /*
   * ⚠ 老存档里的术式**没有 `kind`**（系别）—— 它 2026-09-21 才加进来，
   *   而且是**必填**（编辑器的技能库按它过滤，校验器按它查"里面的技能同不同系"）。
   *
   * ⚠ 迁移的两条硬要求（玩家原话：**能被老存档触发、而且不丢数据**）：
   *   1. 缺的才补，补的时候只加字段
   *   2. **已经有 `kind` 的一个字都不动** —— 系别是玩家在编辑器里**选的**，
   *      不是能推导出来的东西；重推一遍等于把他选的改掉
   */
  const oldMagic = { ...tech({ id: 'tech.old-magic', skills: ['skill.cleave'] }) } as Record<string, unknown>
  delete oldMagic['kind']
  /*
   * ⚠ 序列术式**不写 `skills`**（schema 里明写"二选一"）。
   *
   *   ⚠ 这里**故意不给它 `skills: []`**：老存档里玩家自己做的那份序列术式
   *     就是没有这个字段的，塞一个空数组等于把要测的形状抹掉了。
   *     （曾经为了绕开 `isTechniqueShape` 要求 `skills` 是数组而塞过 ——
   *      那个坑已经修了，见 `tests/store.ts` 下面"形状"那一节。）
   */
  const oldWeapon = {
    ...tech({ id: 'tech.old-weapon', skills: undefined, sequences: ['tech.ws-slash'] }),
  } as Record<string, unknown>
  delete oldWeapon['skills']
  delete oldWeapon['kind']

  const state = parseState(
    { version: 2, techniques: [oldMagic, oldWeapon], loadout: ['tech.old-magic'] },
    {
      /*
       * ⚠ 这两样是**一起**交进来的，缺一样就推不出武器术式 ——
       *   而且缺法很不对称（见 `src/school.ts` 的 `deriveTechniqueKind`）：
       *     · 没有 `weaponSkillIds` → 认不出哪个技能是武器技能
       *     · 没有 `sequenceOf`     → 走不进序列里（武器技能长在那边）
       *   浏览器读存档时两样都有（见 `web/src/main.ts` 的 `loadState`）。
       */
      weaponSkillIds: new Set(['skill.ws-slash', 'skill.ws-thrust']),
      // 内容里那两条序列的形状：自己不带 sequences、只带武器技能
      sequenceOf: id => (id === 'tech.ws-slash' ? { skills: ['skill.ws-slash'] } : undefined),
    },
  )

  ok('v2 存档（术式没有 kind）照样读得进来', state.techniques.length === 2,
    String(state.techniques.length))
  ok('  没有 sequences 的补成 magic', state.techniques[0]?.kind === 'magic',
    String(state.techniques[0]?.kind))
  ok('  只挂序列的补成 weapon —— 武器技能在**它的序列**里，走得进去才看得见',
    state.techniques[1]?.kind === 'weapon', String(state.techniques[1]?.kind))
  ok(`  版本号升到 ${SAVE_VERSION}（下次打开不会又迁移一遍）`,
    state.version === SAVE_VERSION && SAVE_VERSION === 5, String(state.version))
  ok('  **别的一个都没丢**（技能栏 / 技能引用 / 序列都在）',
    state.loadout[0] === 'tech.old-magic'
    && state.techniques[0]?.skills?.[0] === 'skill.cleave'
    && state.techniques[1]?.sequences?.[0] === 'tech.ws-slash',
    JSON.stringify({ loadout: state.loadout, t0: state.techniques[0]?.skills, t1: state.techniques[1]?.sequences }))

  const kept = parseState({
    version: 2,
    techniques: [{ ...tech({ id: 'tech.kept' }), kind: 'weapon' }],
    loadout: [],
  })
  ok('已经有 kind 的**一个字都不动**（哪怕它推出来该是别的）',
    kept.techniques[0]?.kind === 'weapon', String(kept.techniques[0]?.kind))

  /*
   * ⚠ **序列自己不带 `sequences`、只带武器技能**（`tech.ws-slash` 就是一条）。
   *   浏览器读存档时会把"内容里那几份武器技能的 id"传进来 ——
   *   不传的话，一份由武器技能拼出来的老术式会被补成 magic，
   *   然后当场变成非法内容（校验器报"魔法术式里不能出现武器系技能"）。
   */
  /*
   * ⚠ **每次都要造一份新的**：`parseState` 会**就地**给传进去的对象补 `kind`
   *   （它拿到的就是存档里那些对象）。第二次复用同一份的话，那份已经带着
   *   上一次补的 `kind`，"缺字段才补"这条路径就测不到了。
   */
  const noKindFromWeaponSkill = (): Record<string, unknown> => {
    const t = {
      ...tech({ id: 'tech.old-from-weapon-skill', skills: ['skill.ws-slash'] }),
    } as Record<string, unknown>
    delete t['kind']
    return t
  }

  ok('  传了武器技能表：引用武器技能的老术式补成 weapon',
    parseState({ version: 2, techniques: [noKindFromWeaponSkill()], loadout: [] },
      { weaponSkillIds: new Set(['skill.ws-slash', 'skill.ws-thrust']) })
      .techniques[0]?.kind === 'weapon')
  ok('  没传那份表时只能按"直接引用的技能"推（退路一律补成 magic）',
    parseState({ version: 2, techniques: [noKindFromWeaponSkill()], loadout: [] })
      .techniques[0]?.kind === 'magic')

  /*
   * ⚠ **反例**（这一条是这次修的那个 bug 的存档版）：一份只挂序列、
   *   而序列里**全是魔法技能**的术式，**不许**因为"它写了序列"就被补成 weapon。
   *   玩家发现的原话：**"它没有引用武器技能，为什么是武器术式？改回来"**。
   *
   *   少了这一条，下面那种"只要有 sequences 就算 weapon"的老写法
   *   会在测试里**完全看不出来**（上面那条武器术式的用例照样绿）。
   *
   * ⚠ 同 `noKindFromWeaponSkill`：**每次都要造一份新的**
   *   （`parseState` 会就地补 `kind`，复用同一份就测不到"缺字段才补"那条路）。
   */
  const noKindMagicSequence = (): Record<string, unknown> => {
    const t = {
      ...tech({ id: 'tech.old-magic-sequence', skills: undefined, sequences: ['tech.mark-step'] }),
    } as Record<string, unknown>
    delete t['skills']
    delete t['kind']
    return t
  }
  const magicSequenceOpts = {
    weaponSkillIds: new Set(['skill.ws-slash', 'skill.ws-thrust']),
    sequenceOf: (id: string) => (id === 'tech.mark-step' ? { skills: ['skill.mark'] } : undefined),
  }

  const magicSequence = parseState(
    { version: 2, techniques: [noKindMagicSequence()], loadout: [] },
    magicSequenceOpts,
  )
  ok('  只挂序列、序列里全是魔法技能 → magic（**不是**"有序列就算武器"）',
    magicSequence.techniques[0]?.kind === 'magic',
    String(magicSequence.techniques[0]?.kind))
}

section('分享码：加系别之前生成的老码 —— **2026-09-21 起明确拒绝**')

{
  /*
   * ⚠ **这一节 2026-09-21（日志 47）反过来了。**
   *
   *   以前它钉的是"没有 `kind` 的老码照样解得出、补上系别"。
   *   现在玩家裁定了相反的一条：**老分享码不再兼容**
   *   （原话的意思是"省掉一半工作"），但**必须给一句人话**。
   *
   *   ⚠ 和**老存档**那条路是分开的两件事，别混：
   *     码在**别人手里**（是别人给的字符串），存档是**玩家自己的作品**。
   *     存档照旧要读得回来 —— 见下面那两节（`parseState` 的迁移）。
   *
   *   ⚠ 这条断言**和内容无关**：只要前缀是 `TS1.` 就拒。
   *     连 base64 都不用解 —— 老码整代不再支持，所以判据就是那个前缀。
   */
  const raw = { ...tech({ id: 'tech.old-share' }) } as Record<string, unknown>
  delete raw['kind']
  const code = `TS1.${Buffer.from(JSON.stringify(raw), 'utf8').toString('base64url')}`
  const back = decodeShare(code)

  ok('第 1 代老码被拒绝（不再解出术式）', !back.ok, JSON.stringify(back))
  ok('  错误信息是人话：说清是老格式 + 该怎么办',
    !back.ok && back.error.includes('老格式') && back.error.includes('重新复制'),
    back.ok ? '' : back.error)
  ok('  而且**不是**"解出来的东西不是一份术式"那种看不懂的话',
    !back.ok && !back.error.includes('字段不全'), back.ok ? '' : back.error)
}

section('v3 → v4 迁移：序列内联 —— 老数据**照原样留着**，一个字都不丢')

{
  /*
   * ⚠ 玩家 2026-09-21（日志 46）定的两条硬要求：
   *   1. **老存档和老分享码里的序列术式必须还能读回来**
   *   2. **万一推不出新形状，宁可留着旧的读法，也不许静默丢数据**
   *
   * 所以 v4 的"迁移"**故意是空操作**（理由写在 `store.ts` 的 `parseState` 里：
   * 内联一份子术式需要内容库，而存档/分享码里没有它）。
   * 这个 section 钉的就是那句"空操作"**真的没动东西** ——
   * 不测的话，以后有人"顺手把迁移补全"，会把玩家数据吃掉而没人发现。
   *
   * ⚠ 每次都造一份**新的**：`parseState` 会就地补 `kind` / 就地改字段，
   *   复用同一份对象就测不到"到底动了什么"。
   */
  const oldSeq = (): Record<string, unknown> => {
    const t = {
      ...tech({ id: 'tech.old-seq', skills: undefined, links: [] }),
      sequences: ['tech.mark-step', 'tech.blink-step'],
      sequenceLinks: [{ note: '有标记才闪' }],
      sequenceTimeout: 3,
    } as Record<string, unknown>
    delete t['skills']
    delete t['kind']
    return t
  }

  const before = oldSeq()
  const snapshotBefore = JSON.stringify(before)
  const state = parseState({ version: 3, techniques: [before], loadout: ['tech.old-seq'] })

  ok('v3 存档里的序列术式照样读得进来（没有被我丢掉）',
    state.techniques.length === 1 && state.techniques[0]?.id === 'tech.old-seq',
    JSON.stringify(state.techniques.map(t => t.id)))

  ok('  `sequences` 里的字符串 id **一个没变**（推不出新形状就留着旧的读法）',
    JSON.stringify(state.techniques[0]?.sequences) === '["tech.mark-step","tech.blink-step"]',
    JSON.stringify(state.techniques[0]?.sequences))

  ok('  序列之间的门和超时也没被动过',
    state.techniques[0]?.sequenceLinks?.[0]?.note === '有标记才闪'
    && state.techniques[0]?.sequenceTimeout === 3,
    JSON.stringify({
      links: state.techniques[0]?.sequenceLinks,
      timeout: state.techniques[0]?.sequenceTimeout,
    }))

  ok('  迁移只补了 `kind`，别的一个字都没改',
    JSON.stringify({ ...before, kind: 'magic' }) === JSON.stringify(state.techniques[0])
    && state.techniques[0]?.kind === 'magic',
    JSON.stringify(state.techniques[0]))

  /*
   * ⚠ 也确认一下"它**不是**被改成了内联形状"：
   *   真被改了的话，上面那条 `sequences` 的断言会红，但那条只比字符串——
   *   这里再比一次**整份**，连同 `_` 开头的注释字段一起
   *   （"顺手补全迁移"最容易顺手把这些也吃掉）。
   */
  ok('  读回来的那份和内联形状**没有**任何关系（还是老样子）',
    (state.techniques[0]?.sequences ?? []).every(s => typeof s === 'string')
    && JSON.parse(snapshotBefore)['sequences'].length === 2,
    JSON.stringify(state.techniques[0]?.sequences))
}

section('分享码：序列内联之前生成的老码 —— **2026-09-21 起明确拒绝**')

{
  /*
   * ⚠ 和上一节同一条裁定（日志 47）：**老分享码不再兼容**，
   *   但给的必须是"这是老格式，让对方重新复制一份"这种人话
   *   —— ✗ 不是把码里的术式拿去校验器那里撞出一句
   *   "术式不再有 targeting"（那对玩家等于什么都没说）。
   *
   *   ⚠ **老存档**相反：必须继续读（下面那一节钉着它）。
   */
  const oldSeq = {
    ...tech({ id: 'tech.old-share-seq', skills: undefined, links: [] }),
    sequences: ['tech.mark-step', 'tech.blink-step'],
    sequenceLinks: [{ if: [{ type: 'hasStatusTag', who: 'target', value: 'marked' }] }],
  } as Record<string, unknown>
  delete oldSeq['skills']
  delete oldSeq['kind']

  const code = `TS1.${Buffer.from(JSON.stringify(oldSeq), 'utf8').toString('base64url')}`
  const back = decodeShare(code)

  ok('序列内联之前的老码被明确拒绝（不再兼容）', !back.ok, JSON.stringify(back))
  ok('  给的也是"老格式 + 重新复制"那句人话',
    !back.ok && back.error.includes('老格式') && back.error.includes('重新复制'),
    back.ok ? '' : back.error)
}

// ============================================================================
//  存档：瞄准搬家（日志 47）—— 老存档**必须**继续读
// ============================================================================

section('老存档：术式 / 段上的 targeting 在读取时被剥掉，而且**行为等价**')

{
  /*
   * ⚠ 玩家 2026-09-21 在真浏览器里撞到的 bug：
   *   他在术式编辑器里点「粘贴分享码」/ 刷新读存档时，报**"术式不再有 targeting"**。
   *
   *   根因：瞄准搬到技能层时加了一条**防回潮**的校验规则
   *   （`TARGETING_MOVED_TO_SKILL`：术式 / 段里不许再有瞄准），
   *   而**旧存档里的术式恰好带着它**（旧编辑器写进去的）——
   *   于是"新校验器 + 旧数据"当场把自己的作品判死。
   *
   *   ⇒ 修法是**先迁移、后校验**（和系别那次 `withDerivedKind` 是同一个套路）：
   *     `parseState` 读存档时把术式（和每一段）上的 `targeting` 剥掉，
   *     再交给校验器 / 编译器。
   *
   *   ⚠ 而"剥掉"**不许改变行为**：那份瞄准必须能在**技能**上找回来 ——
   *     这正是下面两条断言要钉的（内容技能 / 存档里的自定义技能，两条路都要对）。
   */
  const skillLib = loadLibrary(balance)

  /*
   * ---- ① 技能是**内容库里的**：瞄准由内容提供 ----
   *
   * ⚠ 造一份"旧形状"的术式：它自己带着 `targeting`，而且**和技能上那份不一样**
   *   （`range: 99`）。这样"剥掉之后读到的是技能那份"才测得出来 ——
   *   两边写成同一个数的话，剥没剥都看不出来。
   */
  const oldShape = {
    ...tech({ id: 'tech.mine-old', skills: ['skill.magic-bolt'], links: [] }),
    targeting: { mode: 'areapoint', valid: ['ally'], range: 99 },
  } as unknown as Technique

  const s = fakeStorage()
  saveState(s, {
    version: SAVE_VERSION,
    skills: [],
    techniques: [oldShape],
    loadout: ['tech.mine-old'],
  })
  const back = loadState(s)
  const got = back.techniques[0]

  ok('① 带 targeting 的老术式**读得回来**（不再被自己那条规则判死）',
    got !== undefined && got.id === 'tech.mine-old',
    JSON.stringify(back.techniques.map(t => t.id)))

  ok('  而且术式上那份 targeting **被剥掉了**（校验器不会再报回潮）',
    got !== undefined && (got as unknown as Record<string, unknown>)['targeting'] === undefined,
    JSON.stringify((got as unknown as Record<string, unknown>)['targeting']))

  {
    /*
     * ⚠ **行为等价**：拿读回来的那份去编译，编译产物里的瞄准必须
     *   = **技能自己的那一份**（内容里的 `skill.magic-bolt`），
     *   而不是老术式上那份 `range: 99` / `areapoint`。
     *
     *   这是"搬家"这个词唯一站得住的证据：术式那一份**本来就不生效**了
     *   （搬家前它生效，搬家后技能那份生效 —— 而技能那份就是照它搬的）。
     */
    const compiled = compileTechnique(got as Technique, id => skillLib.skills.get(id)).compiled
    const skillTargeting = skillLib.skills.get('skill.magic-bolt')?.targeting
    ok('  编译后的瞄准 = **技能**那一份（老术式那份 range: 99 不生效）',
      compiled.targeting.mode === skillTargeting?.mode
      && compiled.targeting.range === skillTargeting?.range,
      JSON.stringify({ compiled: compiled.targeting, skill: skillTargeting }))
    ok('  而且**不是**老术式写的那份（否则这条断言就白测了）',
      compiled.targeting.range !== 99,
      JSON.stringify(compiled.targeting))
  }

  /*
   * ---- ② 技能是**存档里的自定义技能**：瞄准跟着自定义技能走 ----
   *
   * ⚠ 这一条是①的反面：瞄准不在内容库、而在玩家自己的变体上。
   *   剥掉术式那份之后，读回来的瞄准必须仍然是**那个变体**的 ——
   *   丢了的话玩家编的瞄准会静默变回"默认鼠标方向"。
   */
  const variant: Skill = {
    ...(skillLib.skills.get('skill.cleave') as Skill),
    id: 'custom.cleave.7',
    name: '裂地斩-副本7',
    basedOn: 'skill.cleave',
    targeting: { mode: 'auto', valid: ['undead'], range: 7 },
  }
  const oldShape2 = {
    ...tech({ id: 'tech.mine-old2', skills: [variant.id], links: [] }),
    targeting: { mode: 'self', valid: ['self'] },
  } as unknown as Technique

  const s2 = fakeStorage()
  saveState(s2, {
    version: SAVE_VERSION,
    skills: [variant],
    techniques: [oldShape2],
    loadout: ['tech.mine-old2'],
  })
  const back2 = loadState(s2)
  const got2 = back2.techniques[0]

  ok('② 带 targeting 的老术式 + 自定义技能，也读得回来',
    got2 !== undefined && got2.id === 'tech.mine-old2',
    JSON.stringify(back2.techniques.map(t => t.id)))
  ok('  技能库里那份变体**带着自己的瞄准**（没被剥）',
    back2.skills[0]?.targeting?.mode === 'auto'
    && back2.skills[0]?.targeting?.requireStatusTag === undefined
    && back2.skills[0]?.targeting?.range === 7,
    JSON.stringify(back2.skills[0]?.targeting))

  {
    const lookup = (id: string): Skill | undefined =>
      back2.skills.find(sk => sk.id === id) ?? skillLib.skills.get(id)
    const compiled2 = compileTechnique(got2 as Technique, lookup).compiled
    ok('  编译后的瞄准 = **变体**那一份（auto / undead / 7）',
      compiled2.targeting.mode === 'auto'
      && compiled2.targeting.valid.join(',') === 'undead'
      && compiled2.targeting.range === 7,
      JSON.stringify(compiled2.targeting))
  }

  /*
   * ---- ③ 段上那份也要剥 ----
   *
   * ⚠ 术式和**序列段**都有过这个字段（段上那份是日志 46 内联时的过渡遗留，
   *   日志 47 删掉的正是它）。只剥术式那一层的话，一份"段里还写着瞄准"的
   *   老存档照样会被防回潮那条规则判死。
   */
  const oldSeqShape = {
    ...tech({ id: 'tech.mine-old3', skills: undefined, links: [] }),
    sequences: [
      { id: 'tech.seg-a', name: '第一段', skills: ['skill.magic-bolt'], targeting: { mode: 'auto', valid: ['enemy'], range: 3 } },
    ],
  } as unknown as Technique

  const s3 = fakeStorage()
  saveState(s3, {
    version: SAVE_VERSION,
    skills: [],
    techniques: [oldSeqShape],
    loadout: [],
  })
  const got3 = loadState(s3).techniques[0]
  const seg0 = got3?.sequences?.[0]
  ok('③ 段里那份 targeting 也被剥掉了（不是只剥术式那一层）',
    seg0 !== undefined && typeof seg0 !== 'string'
    && (seg0 as unknown as Record<string, unknown>)['targeting'] === undefined,
    JSON.stringify(seg0))
  ok('  段里的技能和 id 一个字没动（剥的只是瞄准）',
    seg0 !== undefined && typeof seg0 !== 'string'
    && seg0.id === 'tech.seg-a' && seg0.skills.join(',') === 'skill.magic-bolt',
    JSON.stringify(seg0))
}

console.log('')
if (failed > 0) {
  console.log(`✗ ${failed} 个断言失败（${passed} 个通过）`)
  process.exitCode = 1
} else {
  console.log(`✓ 全部 ${passed} 个断言通过`)
  process.exitCode = 0
}
