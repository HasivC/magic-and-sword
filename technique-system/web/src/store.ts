/**
 * 玩家自己做的东西存哪儿、怎么带走。
 *
 * 这里有两件事，它们的**可靠性要求完全不同**：
 *
 *   1. **存档**（`localStorage`）：刷新不丢。坏了大不了回退到空存档。
 *   2. **分享码**（一段字符串，贴到聊天里）：**别人给的字符串是敌意输入**。
 *      它可能被截断、被聊天软件加了个零宽字符、是别的版本的、
 *      或者干脆是手改的。所以解码必须**校验结构**，不能 JSON.parse 完就塞进引擎。
 *
 * ## 为什么分享码里只有术式
 *
 * 玩家 2026-09-21 澄清过：
 *   > 没有组合技这个概念，分享码是术式的。术式由若干技能进行编程组合得到。
 *
 * 所以码里装的就是一份 `Technique` —— 它按 id 引用技能。
 * **能不能用取决于对方有没有那几个技能**，所以解码出来之后
 * 调用方必须查一遍"缺哪些技能"并明确告诉人，不能静默变成一个空术式。
 * （把技能也一起打进码里是以后的事，那牵扯到"技能本身也要有版本"。）
 *
 * ## 为什么不用纯 JSON 当分享码
 *
 * 一段 JSON 里全是引号和括号，贴进聊天会被转义、被自动链接、
 * 有时候还会被换成中文引号。base64url 是一段连续的字母数字，谁都不会动它。
 * 代价是它长一点、人看不懂 —— 对分享码来说这个代价是对的。
 */
import type { Skill, Technique } from '../../src/schema.ts'
import { validateTechnique } from '../../src/validator/index.ts'
import {
  deriveTechniqueKind, hasValidKind, requiredSkillsOf, stampSchool,
} from '../../src/school.ts'
import type { TechniqueRefsShape } from '../../src/school.ts'

/**
 * 存档格式版本。改了结构就 +1，并在 `parseState` 里处理旧版
 *
 * ⚠ v3：术式多了 **`kind`（系别）**（见日志 2026-09-27-43）。
 *   老存档里的术式没有它，读的时候按"**直接或顺着序列引用了武器系技能 → weapon，
 *   否则 magic**"补（和内容迁移共用 `src/school.ts` 的一条规则）。
 *   ⚠ 版本号**没有**因为日志 44 那次规则修正而 +1：改的只是"缺字段时怎么推"，
 *   存档的**形状**一个字没变 —— 升版本号会白跑一遍迁移，还会把玩家的 `kind` 重推。
 *
 * ⚠ **v4**：术式的 `sequences` 从"引用别的术式 id 的字符串数组"改成
 *   **内联的序列**（每条自己带技能列表，见日志 2026-09-27-46）。
 *   ⇒ 版本号 +1 的理由：这是一次**数据形状变更**，升它让
 *     "这份存档是哪一版"有个明确答案，而不是每次读都猜一遍。
 *
 *   ⚠ **但它和 v3 那次不一样：这里能做的迁移是有限的。**
 *     把一份**子术式**整个内联进来需要**内容库那张表**（技能、条件、瞄准都在
 *     那份术式里），而**存档读的时候不一定有它**（分享码里一定没有）。
 *     所以规矩是玩家定的那句：**推不出新形状就宁可留着旧的读法** ——
 *     认不出来的那一份**原样留着**（字符串形状仍然被引擎和校验器认，
 *     见 schema 的 `TechniqueSequences`），**绝不静默丢数据**。
 *
 * ⚠ **v5**（2026-09-21，日志 48）：术式多了**修饰副本**
 *   （`sequences[i].mods`，修饰技能；定稿 §八）。
 *
 *   ⚠ **这里同样没有迁移代码 —— 而且这次的理由比 v4 更强：不需要。**
 *     老存档里的术式**本来就没有 `mods`**，而"没有修饰副本"是
 *     **一个合法的术式**（出厂内容里也只有「背水」那一份有副本）。
 *     ⇒ 形状是**向下兼容的扩展**：多出来的那个字段老数据里没有，
 *       读进来就是空 —— 不丢任何东西，也不用改写任何东西。
 *     所以这次 +1 的**唯一意义**就是"这份存档是哪一版"有个明确答案
 *     （和 v4 那段同一句话），不是"要动数据"。
 */
export const SAVE_VERSION = 5

/**
 * 分享码版本号。**当前这一代**（`TS3`）。
 *
 * ⚠ 2026-09-21（日志 48）从 2 升到 3，因为副本要跟着码走。
 *   两代都读（见 `decodeShare`）：`TS2` 里的术式**没有 `mods`**，
 *   读进来就是一份没有修饰副本的术式 —— 那正是它出厂时的样子，
 *   所以它是**内容兼容**的，不是"老数据"。
 *
 * ⚠ 它和 `SHARE_PREFIX` 里那个数字是同一个东西，写成常量只是为了
 *   报错信息里那句"当前只认第 N 代"不用手写、不会和前缀漂开。
 */
const SHARE_VERSION = 3

/** 分享码前缀。`TS` = technique-system，`3` = 码本身的版本（多了修饰副本） */
const SHARE_PREFIX = `TS${SHARE_VERSION}.`

/**
 * **仍然读得进来的上一代**分享码（`TS2.`，2026-09-21 日志 47 那一代）。
 *
 * ⚠ 玩家 2026-09-21 定的：**已有的码不许废掉**（"别废掉已有的码"）——
 *   所以这一代**读**，只是不复用它的前缀。
 *   两代的差别只有一个：这一代里术式**没有 `mods`**，
 *   而那是**合法的**（一份没有修饰副本的术式）。
 *
 * ⚠ 别把它写成"TS2 也要迁移"：它不需要迁移，它是**同一个形状的一个子集**。
 */
const SHARE_PREFIX_V2 = 'TS2.'

/**
 * 第 1 代分享码的前缀。**2026-09-21（日志 47）起只用来认出来 + 给一句人话** ——
 * 它不装技能包，而且那份术式来自"瞄准还在术式上"的版本，见 `decodeShare`。
 */
const SHARE_PREFIX_V1 = 'TS1.'

export interface SavedState {
  version: number
  /**
   * **自定义技能库**：玩家创造出来的变体（`Skill.basedOn` 指向它的模板）。
   *
   * ⚠ 基础技能库**不在这里** —— 它是 `content/skills/*.json`：出厂内容、只读、
   *   默认配平为 0。玩家自己的东西只有这一个库。
   */
  skills: Skill[]
  /** 玩家自己做的术式（内容自带的那些不在里面，它们是只读的） */
  techniques: Technique[]
  /**
   * 技能栏：按键 1..0 上装哪几个术式（按顺序）。
   *
   * ⚠ 它是**独立的一份**，不是从 techniques 推出来的：
   *   玩家可能做了 20 个术式但只带 5 个上场。这是"配装"，不是"创作"。
   */
  loadout: string[]
  /**
   * 开局发的那份术式**是哪一个**（玩家术式库里那一份的 id）。
   *
   * ⚠ 这个字段要回答两个问题，所以它存的是 **id** 而不是一个 true/false：
   *   · 还没发过（`undefined`）→ 该发一份起点
   *   · 发过、而且**还在**库里 → 什么都别做（他可能已经改过名/改过内容）
   *   · 发过、但**不在了** → 是他自己删的 → **不许再发**
   *     （不然玩家会以为删不掉 —— 这正是当初加这个标记的原因）
   *
   * ⚠ 第一版写的是 `seeded: boolean`，而且"存档里排过技能栏"也算"不用发"。
   *   那个判断是错的：一个从没做过术式的老存档，技能栏里可能只剩场景发的
   *   内部术式（`tech.magic-bolt`）—— 于是他被当成"已经有自己的东西了"，
   *   永远拿不到那份能改的起点。玩家原话：**"并没有魔法飞弹"**。
   */
  starterId?: string
}

export function emptyState(): SavedState {
  return { version: SAVE_VERSION, skills: [], techniques: [], loadout: [] }
}

// ---------------------------------------------------------------- 存档

/** 只要求"能不能当 storage 用"，这样 Node 里塞个假的就能测 */
export interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem?: (key: string) => void
}

export const SAVE_KEY = 'dsh.technique-system.save'

/**
 * 把磁盘 / localStorage 里读到的东西变成一份能用的存档。
 *
 * ⚠ **一律不 throw。** 存档坏掉是常态（手改过、上个版本留下的、
 *   浏览器配额满了写了一半），那种时候应该回到空存档让游戏还能玩，
 *   而不是白屏。这个立场和 `fallbackScenario()` 是一致的。
 *
 * ⚠ `weaponSkillIds`（可选）是**内容里那几份武器系技能的 id** ——
 *   只有老存档里的术式需要补 `kind` 时才用得上。不带这份 id 的话，
 *   一份引用了武器技能的老术式会被补成魔法术式，然后当场变成非法内容
 *   （见 `src/school.ts` 的 `deriveTechniqueKind`）。
 *   命令行不读存档，所以它是可选的。
 *
 * ⚠ `sequenceOf`（可选）是**按 id 找一份序列**。少了它，一份"只挂序列、
 *   自己不带技能"的武器术式（`tech.iron-sword-basic` 就是）推不出系别 ——
 *   武器技能长在它的**序列**里，不往下走一层就看不见。
 *   浏览器读存档时会传内容术式表（见 `web/src/main.ts`）。
 */
export function parseState(
  raw: unknown,
  opts: {
    weaponSkillIds?: ReadonlySet<string>
    sequenceOf?: (id: string) => TechniqueRefsShape | undefined
  } = {},
): SavedState {
  if (raw === null || typeof raw !== 'object') return emptyState()
  const o = raw as Record<string, unknown>

  const skills: Skill[] = []
  if (Array.isArray(o['skills'])) {
    for (const s of o['skills']) {
      // 结构不对的直接丢掉 —— 留着它会在后面的编译里炸
      if (isSkillShape(s)) skills.push(s)
    }
  }

  const techniques: Technique[] = []
  if (Array.isArray(o['techniques'])) {
    for (const t of o['techniques']) {
      // 结构不对的直接丢掉 —— 留着它会在后面的编译里炸
      if (isTechniqueShape(t)) techniques.push(t)
    }
  }
  /*
   * ⚠ **v1 → v2 迁移**：那时候技能改动的存法是"每个术式私藏一份副本"
   *   （`Technique.skillCopies`）。那个模型废了，但**玩家改过的东西不能丢**：
   *   把那些副本搬进自定义技能库、给它们 id 和默认名字，
   *   再把引用它们的术式改成指向新 id。
   */
  if (o['version'] === 1) migrateV1(techniques, skills)

  /*
   * ⚠ ---- **瞄准搬家（2026-09-21 日志 47）的迁移：剥掉术式 / 段上的 `targeting`** ----
   *
   *   瞄准搬到了**技能层**，术式和序列段都不再带它了。而**老存档里写的就是
   *   那两份**（玩家自己的术式，他正在用）——
   *   不先剥掉再交给校验器，那份术式会当场被防回潮那条规则判死
   *   （`TARGETING_MOVED_TO_SKILL`："术式不再有 targeting"），
   *   表现是**玩家自己的作品读不出来**。这就是玩家在真浏览器里撞到的那个 bug。
   *
   *   ⚠ **顺序**：剥在**推系别之前**也**之后**都行（推系别读的是技能引用），
   *     这里放在前面，让后面所有步骤看到的都是一份"当前形状"的数据。
   *
   *   ⚠ **剥掉的那份瞄准不会凭空丢**（行为等价由技能那一侧保证）：
   *     · 技能是**内容库里的** → 瞄准由内容提供（每份技能都显式写着）✓
   *     · 技能是**存档里的自定义技能** → 它自己带着 `targeting` ✓
   *   ⚠ **和分享码那条路故意分开**：码是别人手里的字符串，第 1 代整代拒绝
   *     （见 `decodeShare`）；存档是玩家自己的作品，必须继续读 ✓
   *     —— 玩家 2026-09-21 就是这么裁的。
   */
  for (let i = 0; i < techniques.length; i++) {
    const t = techniques[i]
    if (t !== undefined) techniques[i] = withMigratedTargeting(t)
  }

  /*
   * ⚠ **v2 → v3 迁移**：老术式没有 `kind`（系别）。补法见 `migrateTechniqueKinds`。
   *
   * ⚠ 它排在 `migrateV1` **之后**：那一趟会改写术式里的技能引用，
   *   而推导系别读的正是那些引用 —— 推导要在一份"改完的"数据上做。
   *   （实践上两种顺序都一样：v1 存档**早于武器技能**，所以
   *     `weaponSkillIds` 那一条依据根本用不上。写清楚是为了以后别有人随手调顺序。）
   */
  migrateTechniqueKinds(techniques, opts.weaponSkillIds, opts.sequenceOf)

  /**
   * ⚠ ---- **v3 → v4：序列内联 —— 这里故意没有迁移代码** ----
   *
   *   v4 把 `Technique.sequences` 从"引用别的术式 id 的字符串数组"改成
   *   **内联的序列**（每条自己带技能列表，见日志 2026-09-27-46）。
   *   老存档里的那一份**照原样留着**，不在这里改写。理由，一条一条：
   *
   *   1. **内联需要内容库，而这里不一定有。** 把一份子术式整个搬进来
   *      （技能列表 + `links` + `targeting` + …）要**读那份术式**，
   *      而 `parseState` 拿到的只有存档本身。**分享码里一定没有内容库** ——
   *      那正是"别人手里存下来的字符串"的处境。
   *   2. **推不出来的那一份必须原样留着**（玩家原话：**宁可留着旧的读法，
   *      也不许静默丢数据**）。而"原样留着"要成立，就得让老形状**仍然能用**：
   *      引擎（`src/sim/cast.ts` 的 `resolveSegment`）和校验器
   *      （`UNKNOWN_SEQUENCE`）都认字符串那一半。于是它**不会崩、也不是垃圾** ——
   *      按下去没反应时，玩家至少拿得到一句"这一份我这儿没有"。
   *   3. **内联是"移动"而不是"改名"**：真做起来还得把"找得到的那一份"
   *      和"找不到的那一份"分开处理，两边行为不一样 ——
   *      而**两套行为**正是这个项目反复踩的那类坑（会漂移、而且是静默的）。
   *
   *   ⚠ 升版本号的意义只是"这份存档是哪一版"有个明确答案（见 `SAVE_VERSION`），
   *     不是每次读都去猜一遍形状。
   */

  /*
   * ⚠ 自定义技能**一律魔法系**（派生章，不写进 JSON）：
   *   武器技能是只读模板，玩家做不出武器系的变体（见 `src/school.ts`）。
   *   读的时候无条件盖一次，所以存档里就算留着旧值也不会被信。
   */
  for (const s of skills) stampSchool(s, 'magic')

  const loadout: string[] = []
  if (Array.isArray(o['loadout'])) {
    for (const id of o['loadout']) {
      if (typeof id === 'string' && id.length > 0) loadout.push(id)
    }
  }

  return {
    version: SAVE_VERSION,
    skills,
    techniques,
    loadout,
    ...(typeof o['starterId'] === 'string' && o['starterId'].length > 0
      ? { starterId: o['starterId'] }
      : {}),
  }
}

/**
 * 把 v1 的"术式私藏副本"搬进自定义技能库。
 *
 * ⚠ 三件事必须一起做，少一件就是"改过的东西不见了"：
 *   1. 给每个副本一个新的 `custom.*` id，记住它的来源（`basedOn`）
 *   2. 把**引用它的那份术式**里的技能 id 改成新 id
 *   3. 从术式上把 `skillCopies` 摘掉（留着会让下一版又读到老结构）
 *
 * ⚠ 同一个基础技能的副本可能出现在好几份术式里（v1 就是这么用的）——
 *   它们**内容可能不一样**，所以按 id 去重会丢东西。这里一律**各搬各的**
 *   （同内容的重复副本会合并成一份：玩家没道理拥有两份一模一样的东西）。
 */
function migrateV1(techniques: Technique[], out: Skill[]): void {
  const byContent = new Map<string, string>()

  for (const t of techniques) {
    const copies = (t as Technique & { skillCopies?: Skill[] }).skillCopies
    if (Array.isArray(copies) && copies.length > 0) {
      const remap = new Map<string, string>()
      for (const copy of copies) {
        if (!isSkillShape(copy)) continue
        const key = JSON.stringify(copy)
        const already = byContent.get(key)
        if (already !== undefined) {
          remap.set(copy.id, already)
          continue
        }
        const id = mintCustomId(copy.id, out)
        const moved: Skill = { ...copy, id, basedOn: copy.basedOn ?? copy.id }
        if (moved.name === undefined || moved.name === '') moved.name = '副本'
        out.push(moved)
        byContent.set(key, id)
        remap.set(copy.id, id)
      }
      /*
       * 引用改指新 id。
       *
       * ⚠ **两处都要改**：`skills` 和**序列段里的 `skills`** ——
       *   序列内联之后技能多了一个住处（2026-09-21 日志 46），
       *   只改第一处的话，一份"序列里用了副本"的老术式会指向一个
       *   已经不存在的 id，表现是**那一段按下去没反应**（而且不报错）。
       *   老形状的字符串段在这里看不见（那要查一张术式表）——
       *   但 v1 存档比序列层还早，它**不可能**有序列，所以那条路不存在。
       */
      if (t.skills !== undefined) {
        t.skills = t.skills.map(sid => remap.get(sid) ?? sid)
      }
      for (const seg of t.sequences ?? []) {
        if (typeof seg === 'string') continue
        seg.skills = seg.skills.map(sid => remap.get(sid) ?? sid)
      }
    }
    delete (t as Technique & { skillCopies?: Skill[] }).skillCopies
  }
}

/**
 * 老存档里的术式补上系别 `kind`（**v2 → v3**）。
 *
 * ⚠ 推导规则和**内容迁移共用一份**（`src/school.ts` 的 `deriveTechniqueKind`）：
 *   **直接或顺着 `sequences`（可能多级）引用了武器系技能 → weapon，否则 magic**。
 *   调用方要把两样东西交进来：
 *     · `weaponSkillIds` —— 内容里全部武器系技能的 id（不然认不出武器技能）
 *     · `sequenceOf` —— 按 id 找序列（不然"只挂序列的容器术式"看不见里面的武器技能）
 *   缺哪一样，推出来的都偏 `magic`（偏 weapon 更坏：那会让一份玩家做的术式
 *   变成"不算账的武器术式"，静默）。
 *
 * ⚠ 已经有合法 `kind` 的**一个字都不动**。系别是玩家在编辑器里**选的**
 *   （"新建时选、之后不能改"），不是能推导出来的东西 ——
 *   重推一遍等于把他选的改掉。**这就是"迁移能被老存档触发、又不丢数据"**：
 *   只有缺字段的才补，补的时候只加字段、不删不改别的。
 */
function migrateTechniqueKinds(
  techniques: Technique[],
  weaponSkillIds?: ReadonlySet<string>,
  sequenceOf?: (id: string) => TechniqueRefsShape | undefined,
): void {
  for (const t of techniques) {
    if (hasValidKind(t)) continue
    t.kind = deriveTechniqueKind(t, weaponSkillIds, sequenceOf)
  }
}

/**
 * **v3 → v4**（序列内联）**在这里没有迁移代码** —— 判断和理由见
 * `parseState` 里那段"这里故意没有迁移代码"的注释。
 */

/**
 * **v4 → v5**（瞄准搬到技能层）的迁移：把术式 / 序列段上那份 `targeting` 剥掉。
 *
 * ⚠ 为什么要迁移而不是直接删字段就行：
 *   校验器有一条**防回潮**的错误（`TARGETING_MOVED_TO_SKILL`：术式 / 段里
 *   不许再有瞄准）。而**旧编辑器和旧存档里写的就是这个字段** ——
 *   不先剥掉就交给 `validateTechnique`，**玩家手里那份术式会当场被判死**
 *   （报"术式不再有 targeting"）。这正是玩家 2026-09-21 在真浏览器里撞到的那个 bug。
 *
 * ⚠ **剥掉的那份瞄准不会凭空丢**：行为等价由**技能**那一侧保证 ——
 *   · 技能是**内容库里的**：瞄准由内容提供（每一份技能都显式写着，见日志 47）✓
 *   · 技能是**分享码里带的自定义技能**：码里那份技能带着自己的 `targeting` ✓
 *     （`decodeShare` 会把技能包一起解出来）
 *
 * ⚠ 这条迁移是**幂等**的：已经剥过的再剥一次什么都没有。所以它不需要版本号，
 *   每次读都跑一遍也不会把谁改坏（和 `migrateTechniqueKinds` 同一个立场：
 *   只补/只剥"缺的那一块"，别的一个字都不动）。
 *
 * ⚠ **两处都要剥**（术式自己那一份 + 每一段那一份）：段上那份是日志 46
 *   内联时的过渡遗留，日志 47 删掉的正是它。
 */
export function withMigratedTargeting(t: Technique): Technique {
  const out: Record<string, unknown> = { ...(t as unknown as Record<string, unknown>) }
  delete out['targeting']
  if (Array.isArray(out['sequences'])) {
    out['sequences'] = (out['sequences'] as unknown[]).map(seg => {
      if (typeof seg === 'string' || seg === null || typeof seg !== 'object') return seg
      const copy: Record<string, unknown> = { ...(seg as Record<string, unknown>) }
      delete copy['targeting']
      return copy
    })
  }
  return out as unknown as Technique
}

/**
 * 老**分享码**里的术式也补上个系别。
 *
 * ⚠ 和存档迁移是同一条规矩、同一个理由：码是**别人手里存下来的东西**
 *   （见文件头"别人给的字符串是敌意输入"），判死的话就成了垃圾。
 *
 * ⚠ 分享码里**看不见内容库**（码里只有这一份术式 + 它的自定义技能包），
 *   所以只能按"它自己直接引用了武器技能吗"这一句推。一份只挂序列的
 *   武器术式在这里会被补成 `magic` —— 这是**已知的、有意的退步**：
 *   反方向猜（补成 weapon）更坏，那会把一份魔法术式变成"不算账的武器术式"，
 *   而且同样是静默的。
 *
 * ⚠ **它不剥 `targeting`**（和 `parseState` 那条迁移**故意分开**）：
 *   新码里术式本来就没有那个字段；带 `targeting` 的码来自第 1 代，
 *   而那一代已经被 `decodeShare` 明确拒绝了（玩家 2026-09-21 裁定）。
 *   在这里顺手剥的话，会把"这码是哪来的"这件事抹掉 —— 那正是
 *   那句人话提示唯一能派上用场的地方。
 */
function withDerivedKind(t: Technique): Technique {
  if (!hasValidKind(t)) t.kind = deriveTechniqueKind(t)
  return t
}

/** `custom.<模板短名>.<序号>` —— 可读、不会和内容里的 `skill.*` 撞 */
export function mintCustomId(baseId: string, existing: readonly Skill[]): string {
  const short = baseId.replace(/^skill\./, '').replace(/[^A-Za-z0-9-]/g, '-')
  const taken = new Set(existing.map(s => s.id))
  let n = 1
  while (taken.has(`custom.${short}.${n}`)) n++
  return `custom.${short}.${n}`
}

/** 自定义技能的最宽松形状检查（和 `isTechniqueShape` 一个立场） */
export function isSkillShape(v: unknown): v is Skill {
  if (v === null || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o['id'] === 'string' && o['id'].length > 0
    && typeof o['name'] === 'string'
    && Array.isArray(o['phases'])
    && Array.isArray(o['rules'])
}

export function loadState(
  storage: StorageLike | undefined,
  /** 给老术式补 `kind` 用的两样东西（见 `parseState`）。都用不上就不传 */
  opts: {
    weaponSkillIds?: ReadonlySet<string>
    sequenceOf?: (id: string) => TechniqueRefsShape | undefined
  } = {},
): SavedState {
  if (storage === undefined) return emptyState()
  try {
    const text = storage.getItem(SAVE_KEY)
    if (text === null || text === '') return emptyState()
    return parseState(JSON.parse(text), opts)
  } catch {
    return emptyState()
  }
}

/** 写存档。写不进去（配额满 / 隐私模式）**不 throw**，返回 false 让调用方提示 */
export function saveState(storage: StorageLike | undefined, state: SavedState): boolean {
  if (storage === undefined) return false
  try {
    storage.setItem(SAVE_KEY, JSON.stringify(state))
    return true
  } catch {
    return false
  }
}

/**
 * 最宽松的形状检查：只要能进编译器就行。
 *
 * ⚠ 这里**故意不复用 `validateTechnique` 的完整校验** ——
 *   那个会报"术式没配平"之类的**玩法**问题，
 *   而一份"结构完整但暂时不平衡"的存档是**合法**的：
 *   玩家可能正编到一半就关掉了浏览器。丢掉它等于吃掉玩家的半成品。
 *   结构性的东西（有没有 id、技能/序列是不是数组）才是这里要拦的。
 *
 * ⚠ **`skills` 和 `sequences` 二选一**（schema 里写明的）：序列术式
 *   **根本不写 `skills`**，时间轴在每一条序列里。所以这里要收的判据是
 *   **"两个里至少有一个是数组"**，而不是"`skills` 必须是数组"。
 *
 *   踩过的坑：原来只认 `skills`，于是**玩家自己做的（或分享来的）
 *   序列术式一律被判"字段不全"、直接丢掉** —— 而"丢掉"是静默的
 *   （`parseState` 只把结构不对的条目过滤掉，不提示），
 *   表现是"我做的那份术式刷新之后不见了"。老分享码同理。
 *
 * ⚠ **`sequences` 里的每一项也要看**（2026-09-21 日志 46 补的）。
 *   它有两半（schema 的 `TechniqueSequences`）：
 *     · 内联的段 → 必须是个对象，而且带 `skills` 数组
 *     · 老形状的 id → 必须是个非空字符串
 *   只判"`sequences` 是数组"的话，一份 `sequences: [{}]` 的手改存档会通过形状检查、
 *   然后在**编译期**炸（遍历 `seg.skills` 时 undefined）—— 那是加载期的炸。
 *
 * ⚠ 为什么要留 `Array.isArray` 而不是只看"字段存在"：
 *   手改过的存档里 `sequences: "tech.ws-slash"`（漏了方括号）会让
 *   后面每一处 `?? []` 之后的遍历炸在 `for...of` 上 —— 那是**加载期**的炸，
 *   一炸就是白屏。数组才是形状对。
 */
export function isTechniqueShape(v: unknown): v is Technique {
  if (v === null || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o['id'] === 'string' && o['id'].length > 0
    && typeof o['name'] === 'string'
    && typeof o['activation'] === 'string'
    && (Array.isArray(o['skills']) || isSequenceList(o['sequences']))
    /*
     * ⚠ **2026-09-21（日志 47）这里不再要求 `targeting`。**
     *
     *   瞄准搬到**技能层**之后，术式身上没有这个字段了 ——
     *   继续要求它的话，**今天新做的每一份术式都会被判成形状不对**
     *   （表现是存档里的术式整批消失，而且不报错）。
     *
     *   ⚠ 老存档里那份多余的 `targeting` **照旧读得进来**：
     *     多一个字段不影响判定，瞄准由它引用的技能提供。
     *     这一条正是"玩家的东西不许判死"那条规矩的落点。
     */
}

/** `sequences` 是不是一份**每一项都能用**的序列列表（两半都认） */
function isSequenceList(v: unknown): v is (string | Record<string, unknown>)[] {
  if (!Array.isArray(v)) return false
  for (const seg of v) {
    // 老形状：一个术式 id
    if (typeof seg === 'string') {
      if (seg.length === 0) return false
      continue
    }
    // 内联的段：必须有 `skills` 数组
    if (seg === null || typeof seg !== 'object') return false
    if (!Array.isArray((seg as Record<string, unknown>)['skills'])) return false
  }
  return true
}

// ---------------------------------------------------------------- 分享码

/** UTF-8 字符串 → base64url。不依赖 Buffer，浏览器和 Node 都能跑 */
function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(code: string): string {
  const b64 = code.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

/**
 * 打一份分享码。
 *
 * ⚠ 第 2 代码里**带着这份术式用到的自定义技能**（`skills`）。
 *
 *   玩家 2026-09-21 定的：
 *   > （分享一份术式时，它用到的自定义技能要不要一起打包）**带 —— 导进对方的
 *   > 自定义技能库**；对方已经有一份同名/同来源的，**让他选**。
 *
 *   不带的话，收码的人拿到的是一份跑不起来的连招（缺技能），
 *   而且他没法自己"搞到"那个技能 —— 它是发码的人编出来的。
 *
 * ⚠ 第 2 代码里**技能自己带着 `targeting`**（2026-09-21 日志 47：瞄准在技能上）——
 *   术式那一层那份**不写**（它已经不是术式的字段了）。
 *   自定义技能的瞄准就是靠这一条跟着码走的：不带的话，
 *   收码的人解出来的变体瞄准会变成"默认鼠标方向"，和发码的人玩的不是同一个东西。
 *
 * ⚠ ---- **第 3 代（2026-09-21 日志 48）：修饰副本跟着术式走** ----
 *
 *   玩家定的：**副本只属于这份术式**，而"分享码是术式的"（见文件头）。
 *   ⇒ 副本**不需要单独打包**，也**不需要另存一份摊平表**：
 *     它就住在 `technique.sequences[i].mods` 里，而整份 `technique`
 *     本来就会被 `JSON.stringify` 进码里 ✓
 *     （⚠ `modifierCopies` 那个"摊平索引"字段 2026-09-21 删掉了 ——
 *      玩家裁定"真相是 `sequences[].mods`"，见 schema 里那段前车之鉴；
 *      两份真相迟早不同步。）
 *
 *   ⚠ **原型不在码里，也不该在**：原型是内容层的出厂零件
 *     （`content/modifiers/*.json`），对方**自己那一版内容里就有**。
 *     把原型打进码里会有两个问题：内容层的零件不能靠码更新，
 *     而且码里的原型会和对方内容里的那一份**静默地不一样**。
 *   ⇒ 所以收码的人如果**没有那个原型**，表现是编译期一条
 *     `UNKNOWN_MODIFIER` 问题（"找不到修饰原型"），而不是崩。
 *     ⚠ "缺零件"要不要像"缺技能"那样给一句人话提示，是**待裁定项**
 *       （报告第 5 节）：技能缺了能补（码里会带自定义技能），
 *       而原型缺了**补不了**（玩家不能创建原型）。
 */
export function encodeShare(tech: Technique, skills: readonly Skill[] = []): string {
  const bundle = { technique: tech, skills: [...skills] }
  return SHARE_PREFIX + toBase64Url(JSON.stringify(bundle))
}

/**
 * **术式"另存为"时深拷贝修饰副本**（定稿 §八：之后两份互相独立）。
 *
 * ⚠ 为什么需要一个函数而不是就地把 `sequences[i].mods` 拷一遍：
 *   副本住在**两层数组**里（`sequences` → `mods`），而"另存为"那条路上
 *   还会顺手改技能引用之类的东西。把这件事收在一处，
 *   下一个改"另存为"的人就不会漏掉副本那一层
 *   （漏掉的表现是：改了一份术式的副本，**另一份跟着变** —— 静默）。
 *
 * ⚠ **技能照旧是引用**（不深拷贝）：定稿 §八 明说了"普通技能相反：
 *   序列里存的是引用，另存为不深拷贝"。所以这里**只**拷副本。
 */
export function cloneModifierCopies(tech: Technique): Technique {
  const out: Technique = { ...tech }
  if (Array.isArray(out.sequences)) {
    out.sequences = out.sequences.map(seg => {
      if (typeof seg === 'string') return seg
      if (!Array.isArray(seg.mods)) return { ...seg }
      return {
        ...seg,
        mods: seg.mods.map(m => ({
          ...m,
          params: JSON.parse(JSON.stringify(m.params ?? {})) as Record<string, unknown>,
        })),
      }
    })
  }
  return out
}

export type ShareResult =
  | { ok: true; technique: Technique; skills: Skill[] }
  | { ok: false; error: string }

/**
 * 解一段分享码。
 *
 * ⚠ 每一层失败都要给**人话**的原因。
 *   "解码失败"这四个字对玩家没有任何用 —— 他需要知道是
 *   "码被截断了"还是"这是新版本的码，你的版本太旧"。
 *
 * ⚠ **2026-09-21（日志 47）玩家裁定：老分享码（TS1 / 第 2 代码之前那批）不再兼容。**
 *
 *   原话的意思是"省掉一半工作"，代价和理由写清楚：
 *     · **老码仍然给一句人话**（"这是老格式的分享码，让对方用新版重新复制一份"）——
 *       ✗ 不是"解码失败"那种什么也说不出的报错；
 *     · **老存档照旧要读**（那是玩家**自己**的东西，见 `parseState`）——
 *       两条路这次**故意分开**：码是别人手里的字符串，存档是他正在用的作品。
 *
 *   ⚠ 所以这里**没有**"先剥术式上的 `targeting` 再校验"那一套：
 *     新码里术式本来就没有那个字段（唯一可能的来源是旧版本，
 *     而旧版本正是这一条要拒的）。
 */
export function decodeShare(code: string): ShareResult {
  // 聊天软件很喜欢往里面塞零宽字符和换行
  const clean = code.replace(/[\s\u200b-\u200d\ufeff]/g, '')
  if (clean === '') return { ok: false, error: '码是空的' }

  /*
   * ⚠ **第 1 代码（`TS1.`）明确拒绝。**
   *
   *   它装的是"一份没有技能包的术式"，而那份术式来自**瞄准还在术式上的版本** ——
   *   里面的 `targeting` 会被防回潮那条规则判死（报"术式不再有 targeting"），
   *   而那对玩家是一句看不懂的话。所以这里先认出来，给他一句能照做的。
   *
   *   ⚠ 第 1 代码**从来不含技能包**，所以它也不是"自定义技能丢了"的问题 ——
   *     它整代都不再支持了（玩家 2026-09-21 裁定）。
   */
  if (clean.startsWith(SHARE_PREFIX_V1)) {
    return {
      ok: false,
      error: '这是老格式（第 1 代）的分享码，现在不认了 —— 让对方用新版重新复制一份',
    }
  }

  if (!clean.startsWith(SHARE_PREFIX) && !clean.startsWith(SHARE_PREFIX_V2)) {
    const m = /^TS(\d+)\./.exec(clean)
    if (m !== null) {
      return {
        ok: false,
        error: `这是第 ${m[1]} 代分享码，当前只认第 ${SHARE_VERSION} 代`
          + `（第 2 代也还读得进来）。让对方用同一版游戏重新生成一份。`,
      }
    }
    return { ok: false, error: `这不像是分享码（开头应该是 ${SHARE_PREFIX}）` }
  }

  /*
   * ⚠ 前缀去**它自己那一代**的长度，不是 `SHARE_PREFIX.length` ——
   *   两代都读的时候，用当前那一代的长度去切上一代的码会**多切两个字符**，
   *   而 base64 多切两个字符只是一份解不开的串（报"码被截断了"）。
   *   那是**能看出来**的错，但也可能被玩家当成"对方的码坏了"，
   *   所以这里按前缀本身切。
   */
  const prefix = clean.startsWith(SHARE_PREFIX) ? SHARE_PREFIX : SHARE_PREFIX_V2

  let json: string
  try {
    json = fromBase64Url(clean.slice(prefix.length))
  } catch {
    return { ok: false, error: '码被截断了（后半段解不出来）—— 让对方完整复制一次' }
  }

  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return { ok: false, error: '码的内容坏了（JSON 解不开）' }
  }

  if (raw === null || typeof raw !== 'object') {
    return { ok: false, error: '解出来的东西不是一份术式（字段不全）' }
  }
  const o = raw as Record<string, unknown>
  if (!isTechniqueShape(o['technique'])) {
    return { ok: false, error: '解出来的东西不是一份术式（字段不全）' }
  }

  const skills: Skill[] = []
  if (Array.isArray(o['skills'])) {
    for (const s of o['skills']) {
      if (isSkillShape(s)) skills.push(stampSchool(s, 'magic'))
    }
  }

  /*
   * 结构过了再走一遍**校验器**，但只看 error。
   *
   * ⚠ 用校验器而不是自己再写一遍检查：别人给的码和磁盘上的内容
   *   应该受同一套规矩约束。自己写一套迟早会漂移。
   *
   * ⚠ 校验**之前**先补系别（`withDerivedKind`）：这一代码可能是
   *   加 `kind` 之前生成的，不补的话校验器会以
   *   "kind 必须是 weapon 或 magic" 把它整条判死 —— 而那份术式
   *   本身一个字都没错（见 `withDerivedKind`）。
   */
  const technique = withDerivedKind(o['technique'])
  const report = validateTechnique('(分享码)', technique)
  const errors = report.issues.filter(i => i.level === 'error')
  if (errors.length > 0) {
    return {
      ok: false,
      error: `码里的术式不合法：${errors.map(i => i.message).join('；')}`,
    }
  }

  return { ok: true, technique, skills }
}

/**
 * 这份术式要用到哪些技能。
 *
 * 导入和"装载"的时候都要查一遍：缺技能时**必须明说缺哪个**。
 * 不说的话，那个技能段在编译时会变成空阶段，玩家按下去没反应，
 * 而界面上什么都看不出来。
 *
 * ⚠ **序列里的技能也算进来**（2026-09-21 日志 46 改的）。
 *   序列内联之后，一份只挂序列的术式（`tech.longsword-basic` 那种）
 *   自己的 `skills` 是空的，而技能全在段里 ——
 *   只算 `tech.skills` 的话，"对方缺哪些技能"永远是空的，
 *   收码的人拿到的是一份**按下去没反应**的连招，而且看不出为什么。
 *
 * ⚠ **老形状（字符串 id）在这一层看不见** —— 那要按 id 查一份术式表，
 *   而分享码里根本没有那张表。这是**有意的**：宁可少列，
 *   也不假装列全了（假装列全的代价是"提示说他不缺，实际缺"）。
 *   （玩家原话：宁可留着旧的读法，也不许静默丢数据。）
 */
export function requiredSkills(tech: Technique): string[] {
  return requiredSkillsOf(tech)
}

export function missingSkills(tech: Technique, have: ReadonlySet<string>): string[] {
  return requiredSkills(tech).filter(id => !have.has(id))
}
