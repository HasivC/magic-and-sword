/**
 * 技能的**系别**：由**目录**决定，不写进 JSON。
 *
 * ⚠ 玩家 2026-09-21 定的：
 *   > 技能的系别看目录。
 *
 *     content/skills/*.json         → 魔法系（技能库 —— 玩家编辑的就是它）
 *     content/weapon-skills/*.json  → 武器系（武器技能模板，`readonly` 那一批）
 *     存档里的自定义技能            → **一律魔法系**（武器技能是只读模板，
 *                                     玩家做不出武器系的变体）
 *
 * ## 为什么不是一个 JSON 字段（比如 `tags` 里那个「武器技能」）
 *
 * 那样就有了**两份会漂移的真相**，而它们漂移的方式是**静默的**：
 * 标签漏写不会报任何错，它只会把一个武器技能判成魔法系 ——
 * 编辑器给错技能库、校验器放行一门混了系别的术式，全程没有一处响声。
 * **目录是唯一看得见、不会漏写的事实**，所以系别只在加载时从目录推导。
 *
 * ## 这个文件是**唯一**回答"这个技能是哪一系"的地方
 *
 * 别在别处写 `if (file.includes('weapon'))` —— 那正是两份真相的开始。
 * 它是**纯函数**（不读文件、不碰 node、不碰 Math），所以命令行和浏览器
 * 共用同一份（`web/src/main.ts` 和 `web/src/store.ts` 都 import 它）。
 *
 * ⚠ 两个目录名也出现在 `src/bridge.ts` 的两个常量里（它按目录分别读、
 *   分别盖同一个章）。**改目录名要一起改** —— 这张表是"目录 → 系别"的真相，
 *   那边只是"读哪几个目录"。
 *
 * ⚠ 这个文件**同时**回答术式那一侧的一半问题：`deriveTechniqueKind`
 *   （老数据没有 `Technique.kind` 时怎么推）。**技能看目录、术式看内容** ——
 *   两者故意不对称，理由写在 schema 里 `Technique.kind` 那段。
 */
import type { ModifierProto, SegmentMod, SequenceSegment, Skill, SkillSchool, Technique } from './schema.ts'
import type { ModifierKind } from './schema.ts'
/*
 * ⚠⚠ **唯一一个运行时 import**（2026-09-30 日志 58）。
 *
 * 这个文件原来是"只 import type"的纯函数模块，这一片破了它 ——
 * 原因只有一个：**「弹射」的次数上限必须和 `pipeline` 的深度限制是同一个数**，
 * 而这个模块要拿它做参数的夹取上限。
 *
 * ⇒ 那个数搬到了 `src/limits.ts`（**一个不 import 任何东西的叶子模块**），
 *   所以这里 import 它**不会**把 sim 拖进来、也不会造出环
 *   （⛔ 千万别改成 `from './sim/pipeline.ts'` —— 那会造出
 *    `school → pipeline → compile → school` 的环，还会让编辑器多加载一整张 sim 图）。
 */
import { MAX_ACTION_DEPTH } from './limits.ts'

/** 魔法系技能目录：技能库 */
export const MAGIC_SKILL_DIR = 'content/skills'
/** 武器系技能目录：武器技能模板（只读，数值由武器属性代入） */
export const WEAPON_SKILL_DIR = 'content/weapon-skills'
/**
 * **修饰技能（修改器）的零件目录**（2026-09-21，日志 48）。
 *
 * ⚠ 它和 `content/skills` 有一处根本不同：**没有"自定义原型库"**。
 *   玩家拖进序列得到的是**副本**，副本住在**术式**里
 *   （`SequenceSegment.mods`）—— 不进技能库、别的术式引用不到。
 *
 * ⚠⚠ **它不在 `SKILL_DIRS` 里，而且那一批文件也不是 `Skill`。**
 *   这是踩过之后才定下来的（日志 48）：原型**没有前摇 / 命中 / 后摇**，
 *   所以 `pricing.ts` 那句 `skill.phases.forEach` 会当场抛
 *   （`Cannot read properties of undefined`）—— 那是**加载期**的炸，
 *   一炸白屏。所以原型走**自己那条加载 / 校验路径**
 *   （`validateModifierProto`），只进 `Library.modifiers` 那张表。
 */
export const MODIFIER_SKILL_DIR = 'content/modifiers'

/**
 * 推导系别时真正要读的那两个字段。
 *
 * ⚠ 单独起一个类型（而不是到处写 `Pick<Technique, …>`）是为了让
 *   **联合类型只出现在一处** —— `Technique.sequences` 可能是内联的
 *   `SequenceSegment[]`，也可能是老形状的 `string[]`（见 schema）。
 *   谁要顺着序列往下查，用这个类型就不会在自己那里再猜一遍。
 */
export type TechniqueRefsShape = {
  skills?: readonly string[]
  sequences?: (string | SequenceSegment)[]
}

/**
 * 技能目录（按加载顺序）。
 *
 * ⚠ 顺序就是 `content/skills` 在前、`content/weapon-skills` 在后 ——
 *   和"武器技能必须在术式之前读进来"没有关系（那是另一回事），
 *   但两张表进的是**同一个 Map**，顺序会影响谁覆盖谁（同名 id 时后者赢）。
 *   目录内部另有 `collectJsonFiles` 的 `.sort()` 保证确定性。
 */
export const SKILL_DIRS: readonly string[] = [MAGIC_SKILL_DIR, WEAPON_SKILL_DIR]

/**
 * 这个技能文件属于哪一系。
 *
 * ⚠ 路径统一转成 `/` 再比：Windows 上传进来的是反斜杠，直接 includes 会漏。
 *
 * ⚠ 认不出来的路径（临时文件、`.scratch` 里的试验品）一律算**魔法系** ——
 *   和"存档里的自定义技能一律魔法系"是同一条：武器系只有内容目录里那两份，
 *   别处冒出来的东西不可能是武器模板。
 */
export function schoolOfSkillFile(file: string): SkillSchool {
  const p = file.replace(/\\/g, '/')
  return p.includes(`/${WEAPON_SKILL_DIR}/`) ? 'weapon' : 'magic'
}

/**
 * 给一个技能盖上系别章。
 *
 * ⚠ **只有加载器该调它**（读磁盘的 `bridge.ts` / `cli/validate.ts`、
 *   读 manifest 的 `web/src/main.ts`、读存档的 `web/src/store.ts`）。
 *   别的地方一律只**读** `skill.school`。
 *
 * ⚠ 就地盖章（返回同一个对象）：技能对象刚解析出来、还没有别人持有它，
 *   拷一份只会让"表里那一份"和"校验过的那一份"变成两个东西。
 */
export function stampSchool(skill: Skill, school: SkillSchool): Skill {
  skill.school = school
  return skill
}

/**
 * 老数据没有 `Technique.kind` 时的**推导规则**（迁移用）。
 *
 * ## 规则：**传递**的，不是"看它自己写了什么"
 *
 * 一门术式是 `weapon` **当且仅当**它**直接、或通过它的 `sequences`（可能多级）
 * 间接**含有武器系技能；否则 `magic`。
 *
 * ⚠ **"有 `sequences` 就是武器术式"那一句删掉了**（2026-09-21，日志 44）。
 *   它是**旧世界**的产物：那时候只有武器术式用序列层，所以"有序列"和
 *   "是武器术式"碰巧等价。玩家发现的反例是「标记 · 瞬影」
 *   （`content/internal-techniques/mark-blink.json`）—— 它**一个武器技能
 *   都不引用**，但它用序列层做二段技能（第一段挂标记、第二段瞬移），
 *   于是被那句话判成了武器术式。
 *   玩家的原话：**"它没有引用武器技能，为什么是武器术式？改回来"**。
 *
 * ⚠ 为什么必须是**传递**的：容器术式自己身上往往一个 `skills` 都没有
 *   （`tech.longsword-basic` 只写 `sequences`），技能长在**序列**里。
 *   只看容器一层的话，武器术式会被判成魔法术式 —— 而它引用的正是武器系技能，
 *   于是**出厂内容当场变成非法**（校验器报 `MAGIC_TECHNIQUE_WEAPON_SKILL`）。
 *   ⚠ 2026-09-21（日志 46）序列**内联**之后这一层变短了：段的 `skills` 就在
 *   手边，不用再查表；但"序列可以再套序列"仍然成立，所以还是往下走到底。
 *
 * ## ⚠ 纯函数 + 三件必须做到的事
 *
 *   1. **不读文件**：老形状的 `sequences`（字符串）长什么样由调用方用
 *      `sequenceOf` 喂进来（内容库 / 存档 / 分享码看见的东西各不相同）。
 *      这个文件不许碰 I/O —— 命令行和浏览器共用它。
 *      ⚠ 内联形状**不需要**它：技能就在段里。
 *   2. **循环引用要有防护**：老形状里序列可以互相引用（玩家手改、或两份互相包含），
 *      递归下去就是爆栈 —— 而爆栈发生在**加载内容**的时候，也就是白屏。
 *      所以这里是**迭代 + `seen` 名单**：每个序列 id 只展开一次。
 *   3. **`sequenceOf` 缺席时不许崩**：命令行不读存档、分享码里看不见内容库，
 *      那时候只能按"它自己写了什么"推 —— 退化成"引用过武器技能？"这一句。
 *      这条路刻意**不**猜 `weapon`：猜错会让一份玩家做的东西变成"算不了账的
 *      武器术式"（静默），而 `magic` 是安全的默认（编辑器还能把它改回来）。
 */
export function deriveTechniqueKind(
  tech: TechniqueRefsShape,
  /** 内容里全部武器系技能的 id。不传就只按"直接引用的技能"推 */
  weaponSkillIds?: ReadonlySet<string>,
  /** 按 id 找一份序列（老形状的 `sequences` 才需要它）。不传就不往下展开 */
  sequenceOf?: (id: string) => TechniqueRefsShape | undefined,
): SkillSchool {
  /** `seen` 同时是**防循环**和**去重**：同一个序列被两条路引到也只展开一次 */
  const seen = new Set<string>()
  const queue: TechniqueRefsShape[] = [tech]

  while (queue.length > 0) {
    const cur = queue.pop() as TechniqueRefsShape

    if (weaponSkillIds !== undefined) {
      for (const id of cur.skills ?? []) {
        if (weaponSkillIds.has(id)) return 'weapon'
      }
    }

    for (const seq of cur.sequences ?? []) {
      /*
       * ⚠ **内联的那一半（`SequenceSegment`）：技能就在段里，直接看它。**
       *
       *   这是模型 B 带来的简化：以前"序列 = 另一门术式"，必须再查一次表
       *   才能看见里面的技能；现在段自带 `skills`，一层都不用跳。
       *   （序列可以再套序列 —— 那一刻段上的 `sequences` 会把它塞回队列。）
       */
      if (typeof seq !== 'string') {
        queue.push(seq)
        continue
      }

      /*
       * ⚠ **老形状的那一半（字符串）：仍然按 id 往下走。**
       *   老存档 / 老分享码里就是它（见 schema 的 `TechniqueSequences`），
       *   而且今天内容里**一份都不剩了**（子术式那几份文件已删）——
       *   所以这条路只在读老数据时才会走到，但**不能省**：
       *   省了的话，一份只挂序列的老术式会被补成 `magic`，
       *   而它引用的正是武器技能 → 当场变成非法内容（校验器报
       *   `MAGIC_TECHNIQUE_WEAPON_SKILL`），而且是**静默**的。
       */
      if (sequenceOf === undefined) continue
      const refId = seq
      // ⚠ 先登记再展开：A → B → A 这种环上，第二次见到 A 就停
      if (seen.has(refId)) continue
      seen.add(refId)
      const next = sequenceOf(refId)
      if (next !== undefined) queue.push(next)
    }
  }

  return 'magic'
}

/**
 * 给一**整套**术式算系别（迁移用：一次算完，才能顺着序列往下找）。
 *
 * ⚠ 它和 `deriveTechniqueKind` 是同一件事的两个入口，不是一个新规则：
 *   单份那个需要调用方自己喂 `sequenceOf`，这里干脆把整张表收进来，
 *   省得每个调用方各写一遍解析器（写两遍迟早漂移成两套规矩）。
 */
export function deriveTechniqueKinds(
  techniques: Iterable<TechniqueRefsShape & { id: string }>,
  /** 内容里全部武器系技能的 id */
  weaponSkillIds?: ReadonlySet<string>,
): Map<string, SkillSchool> {
  const byId = new Map<string, TechniqueRefsShape & { id: string }>()
  for (const t of techniques) byId.set(t.id, t)

  const out = new Map<string, SkillSchool>()
  for (const [id, t] of byId) {
    out.set(id, deriveTechniqueKind(t, weaponSkillIds, sid => byId.get(sid)))
  }
  return out
}

/** 这个术式**已经**声明了合法系别吗（迁移和校验器共用同一句判据） */
export function hasValidKind(tech: { kind?: unknown }): boolean {
  return tech.kind === 'weapon' || tech.kind === 'magic'
}

/**
 * 这门术式**算不算点数账** —— 判据**只有这一处**（2026-10-06 日志 64）。
 *
 * 用户定的规矩：**账按武器 / 魔法分开算**。
 *
 *   · **武器术式**（用武器技能的）→ **不算账**。
 *     它的数字**来自武器本身**（`weapon.damage` / `reach` / `windup` 由装上的
 *     那把武器代入），而定价器手里只有技能模板、看不见那把武器 ——
 *     硬算出来的账是一个**猜**出来的数，而一个猜出来的数字比没有数字更坏：
 *     玩家会照着它去调一个根本不存在的平衡。
 *   · **魔法术式**（其余）→ **算账**。
 *     ⚠ **常驻术式 / 主动术式都算** —— 常驻 ≠ 免费（常驻只是"不响应按键"，
 *     `activation === 'auto'` 那一档，见 `cast.ts` 的 `pressSequence`）。
 *     那一层分类是**显示**用的（术式库的二级分组），不改变账。
 *
 * ## ⚠⚠ 为什么不在这里重写一遍"看它引用了什么技能"的判据
 *
 * 因为系别的判据**只有一处**（就是这个文件）：目录 → 系别由 `schoolOfSkillFile`
 * 定，老数据由 `deriveTechniqueKind`（传递地顺着序列往下看）补上，内容 JSON 里
 * `kind` 是**显式**字段、新建时选定，校验器再拿"技能自己的系别"核对它
 * （`WEAPON_TECHNIQUE_MAGIC_SKILL` / `MAGIC_TECHNIQUE_WEAPON_SKILL`）。
 * ⇒ 这里**只读那个结论**（`kind`）。
 *   另立一套判据的代价是"两份判据漂移"：报价 / 血契 / 界面各按各的算，
 *   而**没有一处会报错** —— 这正是这个项目最恨的那一类。
 *
 * ## ⚠ `kind` 缺失时**按算账处理**（退化成魔法）
 *
 * 和 `deriveTechniqueKind` 的约定同一条："猜错的方向要选安全的那一边"。
 * 这里的"安全"是**不屏蔽账** —— 屏蔽掉的话，一份魔法术式的账会**安静地**
 * 变成空的（看起来像"0 点免费"）。而"它算出来的数可能不对"这件事**不静默**：
 * 校验器当场报 `MISSING_KIND`（错误），玩家看得见。
 */
export function techniquePaysPoints(tech: { kind?: unknown }): boolean {
  return tech.kind !== 'weapon'
}

/**
 * 这一段是**常驻序列**吗 —— 「账按序列切」那半边的判据（2026-10-06 日志 65）。
 *
 * ## 判据：**被常驻包装**（`wrap` 副本盯上这一段紧邻的第一个技能）
 *
 * 用户定的形状是"**它自己和后面那个技能**包装成常驻"⇒ 包装进去的那一块
 * **不响应按键**、进"常驻那一栏"。所以"这一段是不是常驻序列"和
 * "这一段参不参与按键激活"是**同一件事**，判据也就是同一句 ——
 * 这就是 `hasConstantWrapper`（`at === 0` 且那个副本的机制类别是 `wrap`）。
 *
 * ## ⚠⚠ 为什么**不**按 `form: 'passive'`（技能形态）判
 *
 * 那是**技能**那一侧的分类，不是**序列**那一侧的分类。而且今天它们
 * **不相容**：校验器写着"常驻技能只能进 `activation: "auto"` 的术式"
 * （`FORM_ACTIVATIONS`），而"常驻包装"只允许出现在 `activation: "press"`
 * 的术式里（`validator/index.ts` 与 `sim/compile.ts` 各报一条）——
 * 两者**不可能同时成立**。拿形态当判据的话，一条挂常驻技能的序列
 * 在 `press` 术式里会既"算不进账"又"看不见"，而它根本不合法。
 *
 * ## ⚠ 它和 `hasConstantWrapper` 是**同一句**，不是第二份判据
 *
 * 这里只是把"原型表缺席"这一种情形摊开说清楚：`hasConstantWrapper` 拿不到
 * 原型时返回 `false`（不猜）—— 那一侧的行为**一个字都没变**，
 * 这个别名只是给它一个**读起来是序列分类**的名字，好让 `pricing.ts` 那边
 * 不必再解释一遍"为什么读的是包装"。
 */
export function isConstantSequence(seg: SequenceSegment, protos?: ReadonlyMap<string, ModifierProto>): boolean {
  return hasConstantWrapper(seg, protos)
}

// ============================================================================
//  序列：内联 Segment ⇄ 老形状（字符串）的**归一化**
// ============================================================================
//
//  ⚠ 为什么归一化放在这一个文件里（而不是各调用方各自判一遍）：
//    `Technique.sequences` 有两半（内联的 `SequenceSegment` + 老形状的字符串 id，
//    见 schema 的 `TechniqueSequences`）。两边都判的话迟早漂移 ——
//    而漂移的表现是"某一处只认内联形状"，于是**老存档里的序列算不出系别、
//    价格算不进去、分享码的缺技能提示漏掉一段**，一处都不报错。
//
//  ⚠ 它们都**不读文件**：老形状按 id 找序列要靠调用方喂 `sequenceOf`
//    （和 `deriveTechniqueKind` 同一个约定），所以命令行和浏览器共用同一份。

/**
 * 只取**内联**那几段里的技能 id。
 *
 * ⚠ 老形状（字符串 id）在这一层取不到东西 —— 那需要按 id 查表。
 *   要"这门术式到底用到哪些技能"（含老形状）就用 `requiredSkillsOf`。
 */
export function inlineSkillsOf(sequences: readonly (string | SequenceSegment)[] | undefined): string[] {
  const out: string[] = []
  for (const seq of sequences ?? []) {
    if (typeof seq === 'string') continue
    out.push(...seq.skills)
  }
  return out
}

/**
 * 这门术式**要用到哪些技能** —— 它自己的 `skills` **加上**全部序列里的。
 *
 * ⚠ 为什么必须把序列那一半也算进来（2026-09-21 日志 46 才补的）：
 *   分享码导入时要用它算"对方缺哪些技能"，而**只挂序列**的术式
 *   （`tech.longsword-basic` 那种）自己的 `skills` 是空的 ——
 *   只看它的话"缺技能"这条提示永远是空的，收码的人会拿到一份
 *   **按下去没反应**的连招，而且完全看不出为什么。
 *
 * ⚠ 内联的段直接读 `skills`，段里还能再套序列，所以是**递归**的
 *   （和 `deriveTechniqueKind` 一样往下走到底，用 `seen` 防环）。
 *   老形状的字符串段在这一层**看不见**（那要按 id 查表，调用方没有那张表）——
 *   这是有意的：调用方拿到的是"至少这些"，而不是一个假装完整的答案。
 */
export function requiredSkillsOf(tech: TechniqueRefsShape): string[] {
  const out: string[] = []
  const queue: TechniqueRefsShape[] = [tech]

  while (queue.length > 0) {
    const cur = queue.pop() as TechniqueRefsShape
    out.push(...(cur.skills ?? []))
    for (const seq of cur.sequences ?? []) {
      if (typeof seq === 'string') continue
      /*
       * ⚠ 这里**不需要** `deriveTechniqueKind` 那个 `seen` 名单：
       *   环只可能由**按 id 引用**造出来（A → B → A），而内联的段是**值**、
       *   不是引用 —— 一份 JSON 里的对象图不可能是环。
       *   老形状的字符串在这一层已经被跳过了（也就构不成环）。
       */
      queue.push(seq)
    }
  }
  return [...new Set(out)]
}

// ============================================================================
//  修饰副本（修饰技能）的**归一化**
// ============================================================================
//
//  ⚠ 为什么又放在这个文件里（和序列那一段同一个理由）：
//    `SequenceSegment.mods` 会被好几个地方问（编译、校验、账、分享码的缺零件提示），
//    每处各写一遍"怎么遍历副本"迟早漂移 —— 而漂移的表现是静默的
//    （某一处看不见副本 ⇒ 那一条序列**照旧按按键激活**，或者触发器永远不跑）。
//
//  ⚠ 这些函数**不读文件**：原型表由调用方喂进来（`ModifierProto` 那张 Map）。
//    命令行、浏览器、校验器必须共用同一份。

/** 一段里的副本列表。**不写 = 空数组**（别在别处写 `seg.mods ?? []`）。 */
export function modsOf(seg: SequenceSegment): SegmentMod[] {
  return seg.mods ?? []
}

/**
 * 这门术式**全部**的修饰副本（含每一段里的）。
 *
 * ⚠ 老形状的字符串段在这一层看不见（那要按 id 查一份术式表）。
 *   和 `requiredSkillsOf` 同一个立场：宁可少列，也不假装列全了。
 */
export function inlineModsOf(tech: TechniqueRefsShape): SegmentMod[] {
  const out: SegmentMod[] = []
  for (const seq of tech.sequences ?? []) {
    if (typeof seq === 'string') continue
    out.push(...modsOf(seq))
  }
  return out
}

/**
 * 这一段里，**修饰第 `at` 个技能**的那几个副本。
 *
 * ⚠ `at` 从 0 数（0 = 紧邻的下一个技能）。返回**列表**而不是一个：
 *   一条序列里可以有好几个副本同时盯上同一个技能（触发器 + 能量减免…），
 *   它们**不同类**才合法（同类由 `MODIFIER_STACKED_KIND` 挡）。
 */
export function modsAt(seg: SequenceSegment, at: number): SegmentMod[] {
  return modsOf(seg).filter(m => m.at === at)
}

/**
 * 这一段是不是被**常驻包装**了（`wrap` / `persistent`）。
 *
 * ⚠ 判据是"**紧邻的第一个技能被包了**"（`at === 0`）。
 *   这正对应玩家那句"把**它自己和后面那个技能**包装成常驻"：
 *   修饰和它修饰的那个技能**一起**进常驻序列 —— 所以修饰自己的位置
 *   就是"这一段的开头"，`at` 一定是 0。
 *   ⚠ 写成"段里有没有 wrap"而不是"wrap 的 at 是不是 0"的话，
 *   一个 `at: 1` 的 wrap（包第三段的技能）会把整段判成常驻 —— 那是错的。
 */
export function hasConstantWrapper(seg: SequenceSegment, protos?: ReadonlyMap<string, ModifierProto>): boolean {
  return modsOf(seg).some(m => m.at === 0 && kindOfMod(m, protos) === 'wrap')
}

/**
 * 这个副本的**机制类别**（`ModifierKind`）。
 *
 * ⚠ 原型表缺席时返回 `undefined` —— **不猜**。
 *   猜错的代价是静默的：把一个 `wrap` 猜成 `trigger`，
 *   表现是"这一块照旧要按键激活"（触发器永远等不到它的条件）。
 *   调用方拿到 `undefined` 应该报"这个原型我这儿没有"，而不是当它不存在。
 */
export function kindOfMod(
  mod: SegmentMod,
  protos?: ReadonlyMap<string, ModifierProto>,
): ModifierKind | undefined {
  return protos?.get(mod.proto)?.kind
}

/**
 * 一个原型的 `wrap` 效果是什么（今天只有 `persistent`）。不是 wrap 返回 undefined。
 *
 * ⚠ 从**原型**读、不从副本读：副本的 `params` 是玩家能改的那一份，
 *   而"这个零件是干什么的"是出厂事实（定稿 §八：原型只读、玩家不能创建原型）。
 */
export function wrapEffectOf(
  proto: ModifierProto | undefined,
): string | undefined {
  if (proto === undefined || proto.kind !== 'wrap') return undefined
  const eff = proto.params?.['effect']
  return typeof eff === 'string' ? eff : undefined
}

// ---------------------------------------------------------------------------
//  「份数」类修饰（多重释放 / 一分为 X）—— 2026-09-21 日志 51
// ---------------------------------------------------------------------------
//
//  ⚠ 为什么份数的读法也住在这里（和 `kindOfMod` / `wrapEffectOf` 同一个理由）：
//    这一个数会被**三个地方**问，而三处各写一遍必然漂移：
//      · `sim/compile.ts`  编译期把它记进 `CompiledMod.count`（运行时只读编译产物）
//      · `validator/index.ts` 校验上限（"N 最多 10 / X 最多 4"）
//      · `pricing.ts`      按"多出来的份数"记点数
//    漂移的表现是静默的：账上按 3 份收钱、引擎打出 5 份 —— 或者反过来。

/**
 * 份数住在副本 / 原型 `params` 里的哪两个键。
 *
 * ⚠ 只有这两个键 —— `trigger` 那四个键（`when` / `condition` / `crossing` / `origin`）
 *   是另一套，两者**不共用**（修饰技能参数异构，定稿 §八 明确不要统一参数表）。
 */
export const MODIFIER_COUNT_KEY = 'count'
export const MODIFIER_MAX_KEY = 'max'

/**
 * 「触发器 / 监测器」看什么条件住在副本 / 原型 `params` 里的哪个键
 * （和 `when` / `crossing` / `origin` 一起，构成 trigger 的那四个键）。
 *
 * ⚠⚠ **它单独有一个常数**是 2026-09-30（日志 54）加的，理由是一条**踩过的坑**：
 *   求值器按 `type` 分派（`sim/conditions.ts`），而 **`condition: {}`（空对象）
 *   落到 `default: return false` ⇒ 恒不成立** ⇒ 那个零件**永不触发**、
 *   而且一声不吭。出厂零件 `content/modifiers/trigger-on-cast.json` 原来就写着 `{}`
 *   ⇒「应声触发」**出厂就是死的**。
 *
 *   ⚠ 玩家点名的默认条件是「**载体（前一个技能）消失**」（Noita 那种**引信**），
 *     它要的时机（`onExpire` / `onRemoved`）**日志 55 接上线了**
 *     （`sim/trigger.ts` 的 `sweepCarriersGone`，`world.ts` 第 11b 步）⇒
 *     **不写条件 = 这条默认值**（真的会触发），而两个判据的**分工**是：
 *     · 原型 / 副本写着 `{}` → `MODIFIER_EMPTY_CONDITION`（那**不是**"没写"，
 *       是一个明确的"永不通过"）；
 *     · 副本不写、但**原型**写着（如「背水」的 `mod.monitor.low-hp`）→ **合法**
 *       （副本优先、原型兜底）；
 *     · 副本和原型都不写 → **合法**（日志 55 起；日志 54 那条
 *       `MODIFIER_CONDITION_REQUIRED` 已经**松掉**）。
 */
export const MODIFIER_CONDITION_KEY = 'condition'

/**
 * 份数的**下限**：2。
 *
 * ⚠ 1 份 = 没有这个修饰 —— 所以它在数据上不该存在（写了 `count: 1`
 *   就是"花了一份的钱买了零份的好处"，账会白收一笔）。
 *   校验器对 `count < 2` 报错。
 */
export const MODIFIER_COUNT_MIN = 2

/**
 * 原型**没写** `max` 时的兜底上限 —— ⚠ 这两个数**不是**真值。
 *
 * 真值在 `content/modifiers/multi-fire.json` 的 `params.max`（10）和
 * `split.json` 的 `params.max`（4），而校验器盯着它有没有写
 * （`MODIFIER_PROTO_BAD_PARAMS`）。这里给一份兜底只为了"内容坏掉时别炸"，
 * 顺带把玩家定的那两个数**写在一处**，好对照。
 */
export const MODIFIER_MAX_FALLBACK: Readonly<Record<'multi' | 'split', number>> = {
  multi: 10,
  split: 4,
}

/** 副本**没写** `count` 时的默认份数（玩家定的：两个动词都默认 2） */
export const MODIFIER_COUNT_DEFAULT = 2

/**
 * 这份副本的**份数**：副本优先、原型兜底，再夹到 `[2, max]`。
 *
 * ⚠ **副本优先**（和 `when` 那套一致）：`params` 里那份值属于**这个副本**，
 *   而 `paramsTemplate` / 原型的 `params` 只是"默认值长什么样"。
 *   反过来的话，玩家给这个副本改过的份数会被原型覆盖掉。
 *
 * ⚠ 夹到上限是**防御性**的，不是判据：判据在校验器（超了报
 *   `MODIFIER_COUNT_OVER_CAP`）。这里夹是因为**手改的存档 / 老分享码**
 *   绕过校验器直接进世界 —— 不夹的话 `count: 999` 会在一个 tick 里
 *   起 999 个施法。`clamped` 会告诉调用方"我夹了"，让它出声（编译期报一条）。
 */
export function modifierCountOf(
  mod: SegmentMod,
  proto: ModifierProto,
): { count: number; raw: number; max: number; clamped: boolean } {
  const max = modifierMaxOf(proto)
  const raw = readCount(mod.params[MODIFIER_COUNT_KEY]) ?? readCount(proto.params?.[MODIFIER_COUNT_KEY])
    ?? MODIFIER_COUNT_DEFAULT
  const count = Math.min(max, Math.max(MODIFIER_COUNT_MIN, Math.round(raw)))
  return { count, raw: Math.round(raw), max, clamped: count !== Math.round(raw) }
}

/**
 * 这个原型的**上限**（`params.max`），没写就按原型类别取兜底值。
 *
 * ⚠ 上限**住在原型里**（数据），不是代码里的常数 —— 玩家说的是
 *   "N 上限 10 / X 上限默认 4"，那句"默认"说的就是**这个数本身可调**。
 */
export function modifierMaxOf(proto: ModifierProto): number {
  const raw = readCount(proto.params?.[MODIFIER_MAX_KEY])
  if (raw !== undefined) return Math.max(MODIFIER_COUNT_MIN, Math.round(raw))
  return proto.kind === 'split' ? MODIFIER_MAX_FALLBACK.split : MODIFIER_MAX_FALLBACK.multi
}

/** 一个"份数"参数是不是合法的数（整数、有限）。不是就返回 undefined，由调用方报错 */
function readCount(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

// ---------------------------------------------------------------------------
//  「等待 X 秒」的时间与锁（2026-09-30 日志 52）
// ---------------------------------------------------------------------------
//
//  ⚠ 和上面份数那一段同一个理由（三处要问同一个数，各写一遍必然漂移）：
//    · `sim/compile.ts`      编译期把它读进 `CompiledMod.waitSeconds` 并插阶段
//    · `validator/index.ts`  校验 0.2 ~ 3 的上下限、locks 是不是那两个值
//                            （`cast` / `attack` 出现就报 `MODIFIER_LOCK_ENGINE_RESERVED`）
//    · `pricing.ts`          按秒数记点数（`modifierRates.waitSecondPerPoint`）

/**
 * 等待秒数住在副本 / 原型 `params` 里的哪三个键。
 *
 * ⚠ `seconds` 是**这个副本**填的值，`min` / `max` 是**原型**上的范围
 *   （和份数那套的 `count` / `max` 同构）——
 *   玩家要改"最长能等多久"改的是**原型里的一个数**，不是代码。
 */
export const MODIFIER_SECONDS_KEY = 'seconds'
export const MODIFIER_SECONDS_MIN_KEY = 'min'
export const MODIFIER_SECONDS_MAX_KEY = 'max'

/**
 * 等待秒数的**下限**：0.2 秒（玩家定的，两头都是闭区间）。
 *
 * ⚠ 为什么不能是 0：写成 0 就是"没有这一段空档"——
 *   那不如把这个零件删掉（玩家原话的意思），而不是留一个什么都不做的零件在序列里。
 */
export const MODIFIER_SECONDS_MIN = 0.2

/**
 * 原型**没写** `max` 时的兜底上限 —— ⚠ 这个数**不是**真值。
 *
 * 真值在 `content/modifiers/wait.json` 的 `params.max`（3 秒），
 * 而校验器盯着它有没有写（`MODIFIER_PROTO_BAD_PARAMS`）。
 */
export const MODIFIER_SECONDS_MAX_FALLBACK = 3

/** 副本**没写** `seconds` 时的默认秒数（= 原型的 `params.seconds`，今天 1.5） */
export const MODIFIER_SECONDS_DEFAULT = 1.5

/** 「等待」这一段空档里施法者**做不了哪些事**住在 `params` 里的哪个键 */
export const MODIFIER_LOCKS_KEY = 'locks'

/**
 * 四项能力里**能被这个零件配的**取值 —— 只剩 `move` / `turn`。
 *
 * ⚠ 从 `schema.ts` **不重新导出一份类型表**：这里是一张**运行时**的取值表，
 *   给校验器和"内容坏了别炸"的兜底用（`Capability` 是编译期类型，运行时不存在）。
 *
 * ⚠⚠ **2026-09-30（日志 54）从四项收窄到两项** —— 玩家定的硬规矩：
 *    > 同一个施法者，同一时刻只能有一个"进行中的施法"。（原话："玩家又没有第二人格"）
 *
 *   ⇒ `cast` **不再是可配项**：它是引擎硬规矩（`canActivate` 的 `hasRunningCast`），
 *     内容里写不写都一样生效；写着它反而会让玩家以为"解开锁就能并行"。
 *   ⇒ `attack` 同理：**武器攻击就是绑在左键上的一个术式**（`pressSequence` ⇒
 *     `activate`），所以它被同一条硬规矩挡着 —— 也**不是可配项**。
 *   ⚠ 两者都在 `MODIFIER_LOCK_ENGINE_RESERVED` 里：**出现就报错**
 *     （`MODIFIER_LOCK_ENGINE_RESERVED`），不是静默丢掉 —— 静默的表现是
 *     "我写了它，它却像没写一样"（其实它生效了，只是不因为这一行生效）。
 */
export const MODIFIER_LOCK_VALUES: readonly string[] = ['move', 'turn']

/**
 * **引擎硬规矩，不是可配项**的那两个能力（`cast` / `attack`，2026-09-30 日志 54）。
 *
 * ⚠ 它们**仍然是** `Capability`（`Phase.locks` 照旧能表达，技能内容里的
 *   `locks: ['cast']` 一个字都没动），被收窄的只是**修饰零件的参数表**。
 *   理由见 `MODIFIER_LOCK_VALUES` 上面那一段。
 */
export const MODIFIER_LOCK_ENGINE_RESERVED: readonly string[] = ['cast', 'attack']

/**
 * 没写 `locks` 时的默认锁 = **`[]`（一个都不锁：能走、也能转身）**。
 *
 * ⚠⚠ **2026-09-30（日志 54）从 `['cast', 'attack']` 改成 `[]`**，口径来自玩家原话：
 *    > **锁「施法 + 攻击」，但能走**
 *
 *   而"锁施法 + 攻击"这两条**现在已经是引擎硬规矩**（施法独占：同一个人同一
 *   时刻只有一段施法，武器攻击也走同一条路）⇒ 它们**不靠这个参数生效**，
 *   留在这里只剩一个坏作用：让玩家以为"解开锁就能并行"。
 *   ⇒ 这个参数**只管移动 / 转身**，而玩家那句"**但能走**"说的是
 *     "默认不拦人" ⇒ 默认就该是**都不锁**。
 *
 *   ⚠ 一份**没写** `locks` 的副本，行为 = `[]`：等待期间人还能走、还能转身
 *     （"放不出别的术式"那件事由引擎保证，和这里无关）。要"站住"就显式配 `['move']`。
 */
export const MODIFIER_LOCKS_DEFAULT: readonly string[] = []

/** 「等待」能不能被打断住在 `params` 里的哪个键 */
export const MODIFIER_INTERRUPT_KEY = 'interrupt'

/**
 * 三档打断值 —— ⚠ 和 `InterruptLevel` / `ModifierWaitInterrupt` **一起改**。
 *
 * ⚠ 这里**不新造取值**：等待阶段的 `Phase.interrupt` 直接吃这三个，
 *   所以多一个取值就多一条引擎今天本来就会执行的分支。
 */
export const MODIFIER_INTERRUPT_VALUES: readonly string[] = ['damage', 'control', 'none']

/**
 * 等待这一段空档**默认**能不能被打断。
 *
 * 玩家定的那一档：**不可打断**（理由写在 `content/modifiers/wait.json` 与定稿 §八）。
 * ⚠ 它和"份数的默认 2"不是一类东西：那个是**建议初值**，这个是**定死的那一档**
 *   —— 但落到代码里两者一样，都是"内容没写时的兜底"。
 */
export const MODIFIER_INTERRUPT_DEFAULT = 'none'

/**
 * 这份副本的**等待秒数**：副本优先、原型兜底，再夹到 `[0.2, max]`。
 *
 * ⚠ 和 `modifierCountOf` **同一个形状、同一个理由**（夹是防御性的，判据在校验器）：
 *   手改的存档 / 老分享码绕过校验器直接进世界 ——
 *   不夹的话 `seconds: 9999` 会插一段 9999 秒的空档（这一局再也放不出那个技能）。
 */
export function modifierSecondsOf(
  mod: SegmentMod,
  proto: ModifierProto,
): { seconds: number; raw: number; min: number; max: number; clamped: boolean } {
  const max = modifierSecondsMaxOf(proto)
  const min = MODIFIER_SECONDS_MIN
  const raw = readCount(mod.params[MODIFIER_SECONDS_KEY])
    ?? readCount(proto.params?.[MODIFIER_SECONDS_KEY])
    ?? MODIFIER_SECONDS_DEFAULT
  const seconds = Math.min(max, Math.max(min, raw))
  return { seconds, raw, min, max, clamped: seconds !== raw }
}

/**
 * 这个原型的**等待上限**（`params.max`），没写就按兜底值（3 秒）。
 *
 * ⚠ 它**不许小于下限**：写 `max: 0.1` 的话 `[0.2, 0.1]` 是个空区间，
 *   而夹取会静默地把每一次等待都变成 0.1 秒。所以这里取 `max(min, max)`。
 */
export function modifierSecondsMaxOf(proto: ModifierProto): number {
  const raw = readCount(proto.params?.[MODIFIER_SECONDS_MAX_KEY])
  if (raw !== undefined) return Math.max(MODIFIER_SECONDS_MIN, raw)
  return MODIFIER_SECONDS_MAX_FALLBACK
}

/**
 * 这份副本的**等待下限**（`params.min`），没写就是 0.2。
 *
 * ⚠ 玩家的定稿里下限是**定死的 0.2**（不像上限那样说"默认"）——
 *   所以 `params.min` 只是把那个数写在数据里好对照，
 *   **真正的下限是 `MODIFIER_SECONDS_MIN`**，`params.min` 只用来校验有没有被写歪。
 */
export function modifierSecondsMinOf(proto: ModifierProto): number {
  const raw = readCount(proto.params?.[MODIFIER_SECONDS_MIN_KEY])
  if (raw === undefined) return MODIFIER_SECONDS_MIN
  return Math.max(MODIFIER_SECONDS_MIN, raw)
}

/**
 * 这份副本的**锁**：副本优先、原型兜底，只留**这个零件真的能配**的那两个值。
 *
 * ⚠ 认不出的值**静默丢掉**（这里）—— 因为"报出来"是校验器的活
 *   （`MODIFIER_BAD_LOCKS` / `MODIFIER_LOCK_ENGINE_RESERVED`），
 *   而这里是**手改存档绕过校验器**时的兜底：
 *   丢一个拼错的值的后果是"少锁一样"，比"锁一样不存在的东西"（引擎不认、
 *   玩家以为锁上了）更接近原意。⚠ 两者都**不许**是"静默地照单全收"。
 *
 * ⚠ **`cast` / `attack` 在这里被丢掉是故意的**（2026-09-30 日志 54）：
 *   它们是引擎硬规矩，不靠这一行生效 —— 留着反而会出现在
 *   `phaseLocksOf()` 的结果里，让"我锁了施法"看起来像这个零件干的。
 *   ⚠ 丢掉 ≠ 不生效：施法独占照样拦（`hasRunningCast`）。
 */
export function modifierLocksOf(mod: SegmentMod, proto: ModifierProto): string[] {
  const raw = mod.params[MODIFIER_LOCKS_KEY] ?? proto.params?.[MODIFIER_LOCKS_KEY]
  const list = Array.isArray(raw) ? raw : [...MODIFIER_LOCKS_DEFAULT]
  const out: string[] = []
  for (const v of list) {
    if (typeof v === 'string' && MODIFIER_LOCK_VALUES.includes(v) && !out.includes(v)) out.push(v)
  }
  return out
}

/** 这份副本的**打断档**：副本优先、原型兜底，认不出就按默认（不可打断） */
export function modifierInterruptOf(mod: SegmentMod, proto: ModifierProto): string {
  const raw = mod.params[MODIFIER_INTERRUPT_KEY] ?? proto.params?.[MODIFIER_INTERRUPT_KEY]
  return typeof raw === 'string' && MODIFIER_INTERRUPT_VALUES.includes(raw)
    ? raw
    : MODIFIER_INTERRUPT_DEFAULT
}

// ---------------------------------------------------------------------------
//  「排布」的位置与方向（2026-09-30 日志 53）
// ---------------------------------------------------------------------------
//
//  ⚠ 和上面两段同一个理由（同一个数会被三处问，各写一遍必然漂移）：
//    · `sim/compile.ts`   编译期把它读进 `CompiledMod.layout`（运行时只读编译产物）
//    · `validator/*`      校验三选一、半径 / 角度的上下限
//    · `pricing.ts`       按"哪一档 + 参数多极端"记点数
//
//  ⚠⚠ **这里读的全都不是"份数"** —— 玩家划的硬界线第一条：排布**不管份数**。
//    份数那一套（`MODIFIER_COUNT_KEY` / `modifierCountOf`）在这一节里一个字都不出现，
//    而且**不许**被复用（复用就是把份数偷偷接回来了）。

/**
 * 「排布」怎么摆 —— **三选一**（玩家定的：一个零件、**编辑时选类型**）。
 *
 * ⚠ 它和 `ModifierKind`（零件本身的机制类别，永远是 `'layout'`）不是一回事：
 *    `kind` 决定"这是哪个零件"，这里决定"这个零件今天怎么摆"。
 */
export type ModifierLayoutMode = 'ring' | 'fan' | 'mirror'

/** 三种摆法的取值表（⚠ 和 `ModifierLayoutMode` **一起改**） */
export const MODIFIER_LAYOUT_MODES: readonly string[] = ['ring', 'fan', 'mirror']

/** 没写 `type` 时用哪一种。玩家把「环绕生成」列在第一位，默认就是它 */
export const MODIFIER_LAYOUT_MODE_DEFAULT = 'ring'

/** `type` / `radius` / `startAngle` / `even` / `spread` / `mirrorAngle` 这六个键 */
export const MODIFIER_LAYOUT_TYPE_KEY = 'type'
export const MODIFIER_LAYOUT_RADIUS_KEY = 'radius'
export const MODIFIER_LAYOUT_START_KEY = 'startAngle'
export const MODIFIER_LAYOUT_EVEN_KEY = 'even'
export const MODIFIER_LAYOUT_SPREAD_KEY = 'spread'
export const MODIFIER_LAYOUT_MIRROR_KEY = 'mirrorAngle'

/** 原型里那个 `params.maxRadius` / `minRadius` 的键名（⚠ 和上面的 `radius` 分开） */
export const MODIFIER_LAYOUT_MAX_RADIUS_KEY = 'maxRadius'
export const MODIFIER_LAYOUT_MIN_RADIUS_KEY = 'minRadius'
export const MODIFIER_LAYOUT_MAX_ANGLE_KEY = 'maxAngle'
export const MODIFIER_LAYOUT_MAX_SPREAD_KEY = 'maxSpread'

/**
 * 半径的**建议范围** 0.5 ~ 6 米，角度的**建议上限** 180 度（±），张角上限 360 度。
 *
 * ⚠ 这四个数是**这一片自己给的初值、待玩家签字**（玩家没说过范围）——
 *   它们住在 `content/modifiers/layout.json` 的 `params` 里，代码里这几份只是
 *   "内容坏掉 / 没写时的兜底"（和 `MODIFIER_SECONDS_MAX_FALLBACK` 同一条纪律：
 *   真值在数据里，校验器盯着数据有没有写歪）。
 */
export const MODIFIER_LAYOUT_RADIUS_MIN = 0.5
export const MODIFIER_LAYOUT_RADIUS_MAX_FALLBACK = 6
export const MODIFIER_LAYOUT_ANGLE_MAX_FALLBACK = 180
export const MODIFIER_LAYOUT_SPREAD_MAX_FALLBACK = 360
/** 没写 `radius` / `spread` 时的默认值 */
export const MODIFIER_LAYOUT_RADIUS_DEFAULT = 1.5
export const MODIFIER_LAYOUT_SPREAD_DEFAULT = 60

/** 读一个有限的数（负数 / 小数都合法） */
function readNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** 夹到 `[lo, hi]`（`lo > hi` 时取 `lo`，不产生空区间） */
function clamp(v: number, lo: number, hi: number): number {
  if (lo >= hi) return lo
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * 这个原型的**半径上限**（`params.maxRadius`），没写就用兜底值。
 *
 * ⚠ `Math.max(min, max)` 和 `modifierSecondsMaxOf` 一样：写 `max: 0.1` 时
 *   `[0.5, 0.1]` 是个空区间，夹取会静默地把半径都变成 0.1。
 */
export function modifierLayoutMaxRadiusOf(proto: ModifierProto): number {
  const raw = readNumber(proto.params?.[MODIFIER_LAYOUT_MAX_RADIUS_KEY])
  return raw === undefined ? MODIFIER_LAYOUT_RADIUS_MAX_FALLBACK : Math.max(MODIFIER_LAYOUT_RADIUS_MIN, raw)
}

/** 这个原型的**半径下限**（`params.minRadius`），没写就是 0.5 */
export function modifierLayoutMinRadiusOf(proto: ModifierProto): number {
  const raw = readNumber(proto.params?.[MODIFIER_LAYOUT_MIN_RADIUS_KEY])
  return raw === undefined ? MODIFIER_LAYOUT_RADIUS_MIN : Math.max(MODIFIER_LAYOUT_RADIUS_MIN, raw)
}

/** 这个原型的**角度上限**（`params.maxAngle`，取绝对值用），没写就是 180 度 */
export function modifierLayoutMaxAngleOf(proto: ModifierProto): number {
  const raw = readNumber(proto.params?.[MODIFIER_LAYOUT_MAX_ANGLE_KEY])
  return raw === undefined ? MODIFIER_LAYOUT_ANGLE_MAX_FALLBACK : Math.max(1, raw)
}

/** 这个原型的**张角上限**（`params.maxSpread`），没写就是 360 度 */
export function modifierLayoutMaxSpreadOf(proto: ModifierProto): number {
  const raw = readNumber(proto.params?.[MODIFIER_LAYOUT_MAX_SPREAD_KEY])
  return raw === undefined ? MODIFIER_LAYOUT_SPREAD_MAX_FALLBACK : Math.max(0, raw)
}

/**
 * 这份副本的**摆法**：副本优先、原型兜底，**认不出就返回 undefined**。
 *
 * ⚠ 和 `modifierInterruptOf`（认不出就按默认那一档）**故意不一样**：
 *   打断档是"三档里选一个"，认不出时按默认只是"选了另一档"；
 *   而摆法是**完全不同的事情**（环绕 / 散射 / 镜像），猜错的代价是
 *   "我装了反向镜像，它给我排了个圈" —— 那不是兜底，是静默地改语义。
 *   ⇒ 返回 `undefined`，调用方**什么都不做**，校验器出声
 *     （`MODIFIER_LAYOUT_BAD_TYPE`）。
 */
export function modifierLayoutModeOf(mod: SegmentMod, proto: ModifierProto): ModifierLayoutMode | undefined {
  const raw = mod.params[MODIFIER_LAYOUT_TYPE_KEY] ?? proto.params?.[MODIFIER_LAYOUT_TYPE_KEY]
  return typeof raw === 'string' && MODIFIER_LAYOUT_MODES.includes(raw)
    ? raw as ModifierLayoutMode
    : undefined
}

/**
 * 这份副本的**环绕半径**（米）：副本优先、原型兜底，再夹到 `[min, max]`。
 *
 * ⚠ 夹是**防御性**的（判据在校验器）：手改的存档 / 老分享码绕过校验器直接进世界。
 *   不夹的话 `radius: 9999` 会让那几份摆到地图外面 ——
 *   表现是"技能放出来了，什么都不打中"，而且无处可查。
 */
export function modifierLayoutRadiusOf(
  mod: SegmentMod,
  proto: ModifierProto,
): { radius: number; raw: number; min: number; max: number; clamped: boolean } {
  const min = modifierLayoutMinRadiusOf(proto)
  const max = modifierLayoutMaxRadiusOf(proto)
  const raw = readNumber(mod.params[MODIFIER_LAYOUT_RADIUS_KEY])
    ?? readNumber(proto.params?.[MODIFIER_LAYOUT_RADIUS_KEY])
    ?? MODIFIER_LAYOUT_RADIUS_DEFAULT
  const radius = clamp(raw, min, max)
  return { radius, raw, min, max, clamped: radius !== raw }
}

/** 这份副本的**起始角**（度，绕瞄准方向转多少度起算），夹到 ±maxAngle */
export function modifierLayoutStartAngleOf(mod: SegmentMod, proto: ModifierProto): number {
  const lim = modifierLayoutMaxAngleOf(proto)
  const raw = readNumber(mod.params[MODIFIER_LAYOUT_START_KEY])
    ?? readNumber(proto.params?.[MODIFIER_LAYOUT_START_KEY])
    ?? 0
  return clamp(raw, -lim, lim)
}

/** 这份副本的**扇形张角**（度），夹到 `[0, maxSpread]` */
export function modifierLayoutSpreadOf(mod: SegmentMod, proto: ModifierProto): number {
  const lim = modifierLayoutMaxSpreadOf(proto)
  const raw = readNumber(mod.params[MODIFIER_LAYOUT_SPREAD_KEY])
    ?? readNumber(proto.params?.[MODIFIER_LAYOUT_SPREAD_KEY])
    ?? MODIFIER_LAYOUT_SPREAD_DEFAULT
  return clamp(raw, 0, lim)
}

/** 这份副本的**镜像偏移角**（度，0 = 正反方向），夹到 ±maxAngle */
export function modifierLayoutMirrorAngleOf(mod: SegmentMod, proto: ModifierProto): number {
  const lim = modifierLayoutMaxAngleOf(proto)
  const raw = readNumber(mod.params[MODIFIER_LAYOUT_MIRROR_KEY])
    ?? readNumber(proto.params?.[MODIFIER_LAYOUT_MIRROR_KEY])
    ?? 0
  return clamp(raw, -lim, lim)
}

/**
 * 这份副本的**环绕是不是均匀分布**：副本优先、原型兜底。
 *
 * ⚠ 严格 `=== true` / `=== false`：写成 `1` / `"true"` 这种既不是真也不是假的取值时
 *   一律按**默认的"均匀"**处理 —— 而"写了别的东西"由校验器出声
 *   （`MODIFIER_LAYOUT_BAD_EVEN`）。⚠ 认不出的值**不许**被当成 `true` 静默收下。
 */
export function modifierLayoutEvenOf(mod: SegmentMod, proto: ModifierProto): boolean {
  const raw = mod.params[MODIFIER_LAYOUT_EVEN_KEY] ?? proto.params?.[MODIFIER_LAYOUT_EVEN_KEY]
  if (raw === true) return true
  if (raw === false) return false
  return true
}

// ---------------------------------------------------------------------------
//  「追踪」的飞行路径参数（2026-09-30 日志 56）
// ---------------------------------------------------------------------------
//
//  ⚠ 和上面两段同一个理由（同一个数会被三处问，各写一遍必然漂移）：
//    · `sim/compile.ts`   编译期把它读进 `CompiledMod.homing`（运行时只读编译产物）
//    · `validator/*`      校验两个数在不在原型给的区间里
//    · `pricing.ts`       按"追得多快 + **发射那一刻**能锁多远"记点数
//
//  ⚠⚠ **这两个数一个都不是"瞄准"**：它们只描述"这一发飞出去之后怎么拐"、
//    以及"发射那一刻能锁住谁"，施法时解算出来的朝向 / 落点
//    （`CastInstance.facing` / `aimPoint`）**一个字都不读**。
//    ⚠⚠ 2026-09-30 日志 62：`maxRange` 的语义从"飞行途中的射程"改成了
//      "**索敌距离**"（玩家："限制不应该是射程，而是持续时间 —— 这样就追到消失"）。
//      键名**故意没改**（改键名要同步代码 / 校验器 / 内容 / 点表，而这一片要的是语义）。
//    玩家划的界线是"追踪**确实换目标**，但它换的是**这一发**的目标"——
//    见 schema 的 `ModifierKind` 那一段（以及 `content/modifiers/homing.json` 的 `_comment`）。

/**
 * `turnRate` / `maxRange` 这两个键，外加原型上的四个范围键。
 *
 * ⚠ 名字和「排布」那套**故意不共用**（`MODIFIER_LAYOUT_*`）：两个零件的参数
 *   各自可调，共用一个键名的话"调追踪的上限"会顺手把排布的上限也改了。
 */
export const MODIFIER_HOMING_TURN_KEY = 'turnRate'
export const MODIFIER_HOMING_RANGE_KEY = 'maxRange'
export const MODIFIER_HOMING_MAX_TURN_KEY = 'maxTurnRate'
export const MODIFIER_HOMING_MAX_RANGE_KEY = 'maxRangeCap'
export const MODIFIER_HOMING_MIN_RANGE_KEY = 'minRange'

/**
 * 转速的**建议范围** 1 ~ 30 度/tick，索敌距离 **1 ~ 16 米**。
 *
 * ⚠ 这四个数是**这一片自己给的初值、待玩家签字**（玩家只说了"自己找敌人"）——
 *   它们住在 `content/modifiers/homing.json` 的 `params` 里，代码里这几份只是
 *   "内容坏掉 / 没写时的兜底"（和 `MODIFIER_LAYOUT_*_FALLBACK` 同一条纪律：
 *   真值在数据里，校验器盯着数据有没有写歪）。
 *
 * ⚠⚠ **下限是 1 度/tick**（2026-09-30 日志 56，玩家裁定）。
 *   它**必须**是"整圈角度表真能表达的值"：表原来是 **5 度一格**，
 *   那时下限只能抬到 5 —— 因为"每 tick 转 2 度"会被吸成 **0 度**
 *   ⇒ 子弹**设了转速却完全直飞**，而那正是这一整轮在清的**静默失效**。
 *   ⇒ 玩家裁定把 `sim/targeting.ts` 的整圈表**做细到 1 度**，
 *     于是"1 度"成了一个真实的刻度，下限回到 **1**。
 *   ⚠ 这一节所有上下限都照同一条纪律：**不许出现"写了但算不出来"的取值**。
 */
export const MODIFIER_HOMING_TURN_MIN = 1
export const MODIFIER_HOMING_TURN_MAX_FALLBACK = 30
export const MODIFIER_HOMING_RANGE_MIN_FALLBACK = 1
export const MODIFIER_HOMING_RANGE_MAX_FALLBACK = 16
/** 没写 `turnRate` / `maxRange` 时的默认值 */
export const MODIFIER_HOMING_TURN_DEFAULT = 12
export const MODIFIER_HOMING_RANGE_DEFAULT = 8

/** 这个原型的**转速上限**（`params.maxTurnRate`，度/tick），没写就用兜底值 */
export function modifierHomingMaxTurnOf(proto: ModifierProto): number {
  const raw = readNumber(proto.params?.[MODIFIER_HOMING_MAX_TURN_KEY])
  return raw === undefined
    ? MODIFIER_HOMING_TURN_MAX_FALLBACK
    : Math.max(MODIFIER_HOMING_TURN_MIN, raw)
}

/** 这个原型的**索敌距离下限**（`params.minRange`，米），没写就是 1 米 */
export function modifierHomingMinRangeOf(proto: ModifierProto): number {
  const raw = readNumber(proto.params?.[MODIFIER_HOMING_MIN_RANGE_KEY])
  return raw === undefined ? MODIFIER_HOMING_RANGE_MIN_FALLBACK : Math.max(0, raw)
}

/**
 * 这个原型的**索敌距离上限**（`params.maxRangeCap`，米），没写就是 16 米。
 *
 * ⚠ `Math.max(min, max)` 和 `modifierSecondsMaxOf` 一样：写 `maxRangeCap: 0` 时
 *   `[1, 0]` 是个空区间，夹取会静默地把索敌距离都变成 0（表现是"追踪一次都不生效"）。
 */
export function modifierHomingMaxRangeOf(proto: ModifierProto): number {
  const min = modifierHomingMinRangeOf(proto)
  const raw = readNumber(proto.params?.[MODIFIER_HOMING_MAX_RANGE_KEY])
  return raw === undefined ? MODIFIER_HOMING_RANGE_MAX_FALLBACK : Math.max(min, raw)
}

/**
 * 这份副本的**转速**（度/tick）：副本优先、原型兜底，再夹到 `[1, 上限]`。
 *
 * ⚠ 夹是**防御性**的（判据在校验器）：手改的存档 / 老分享码绕过校验器直接进世界。
 *   不夹的话 `turnRate: 1e9` 会让子弹**一 tick 直接贴到目标脸上**
 *   （表现是"我装了追踪，它变成了一发必中的瞬移弹"），而且无处可查。
 *   ⚠ 下限是 **1 度/tick**（不是 0）：0 就是"每 tick 拐 0 度"= 这个零件白装，
 *   而那和"没装"在表现上完全一样 —— 那是"没计价"，不是"一个合法的旋钮"。
 */
export function modifierHomingTurnOf(
  mod: SegmentMod,
  proto: ModifierProto,
): { turnRate: number; raw: number; min: number; max: number; clamped: boolean } {
  const min = MODIFIER_HOMING_TURN_MIN
  const max = modifierHomingMaxTurnOf(proto)
  const raw = readNumber(mod.params[MODIFIER_HOMING_TURN_KEY])
    ?? readNumber(proto.params?.[MODIFIER_HOMING_TURN_KEY])
    ?? MODIFIER_HOMING_TURN_DEFAULT
  const turnRate = clamp(raw, min, max)
  return { turnRate, raw, min, max, clamped: turnRate !== raw }
}

/**
 * 这份副本的**索敌距离**（米）：副本优先、原型兜底，再夹到 `[minRange, 上限]`。
 *
 * ⚠ 和转速同一条纪律（不夹的话 `maxRange: 9999` 变成"全图索敌"，
 *   那会让"索敌距离"这一整条交易轴**当场失效**）。
 */
export function modifierHomingRangeOf(
  mod: SegmentMod,
  proto: ModifierProto,
): { maxRange: number; raw: number; min: number; max: number; clamped: boolean } {
  const min = modifierHomingMinRangeOf(proto)
  const max = modifierHomingMaxRangeOf(proto)
  const raw = readNumber(mod.params[MODIFIER_HOMING_RANGE_KEY])
    ?? readNumber(proto.params?.[MODIFIER_HOMING_RANGE_KEY])
    ?? MODIFIER_HOMING_RANGE_DEFAULT
  const maxRange = clamp(raw, min, max)
  return { maxRange, raw, min, max, clamped: maxRange !== raw }
}

// ---------------------------------------------------------------------------
//  「这个载体会不会在世界上飞」—— 这一处是唯一的判据（2026-09-30 日志 56 / 58）
// ---------------------------------------------------------------------------

/**
 * **这个载体会不会在世界上飞** —— 「追踪」（日志 56）和「弹射」（日志 58）
 * **共用**的那一条界线。
 *
 * ## 玩家的话
 * > 追踪应该是一种**修饰技能**。正常的技能只沿着发射方向走，而追踪技能**瞄准敌人**
 * > （部分技能比如**激光**不能被它修饰，看着不合理）
 *
 * 弹射那一侧的同一条界线（玩家 2026-09-30，日志 58）：
 * > **只对"会飞的东西"有效**；**非飞行载体**（激光 / 光束 / 扇形 / 光环 /
 * > 落点区域 / 自己）→ **什么都不做**，而且**不收费** ——
 * > ⚠ 这**和「追踪」是同一条规矩** ⇒ 判据要共用。
 *
 * ⇒ 只认 `projectile`。别的载体（`beam` / `capsule` / `meleeArc` / `aura` /
 *   `area` / `self` / `spawn`）被这两个零件修饰时**引擎什么都不做**
 *   （那不是一行 `if` 挡住的，是**代码形状**：只有投射物会走 `spawnProjectileFrom`）。
 *
 * ## ⚠⚠ 为什么它必须**只有一处**（日志 56 在这里做错过一次）
 *
 * 这个判据有三个消费者，而它们**必须给出同一个答案**：
 *   ① **校验器**：装在非飞行载体上 ⇒ 报一条**警告**（"不起作用"是设计允许的，
 *      但**必须让人看见**）—— 追踪和弹射各一条，读的是**这个函数**；
 *   ② **账本**（`pricing.ts`）：装在非飞行载体上 ⇒ **一分钱都不收**。
 *
 * ⚠ 日志 56 第一版里账本那一侧写的是"**照收**"（理由是"账算的是你放了什么零件，
 *  '它对不对'是界面的事"）—— **那是个错**：玩家花点数买了一个**什么都不做**的零件，
 * 比"没有提示"更糟。玩家 2026-09-30 的裁定原话是
 * "**花钱买了什么都不做** 比'没提示'更糟"。
 * ⇒ 两处各写一份判据的话，迟早出现"校验器说它不起作用、账本还在收钱"
 * （或者反过来）—— 那正是本项目列为最危险的一类**静默不一致**。
 * ⇒ 所以判据**只在这里**，两边都 import 它。
 *
 * ⚠⚠ **2026-09-30 日志 58：它原来叫 `homingAppliesTo`。**
 *   名字改成通用的这一个（两个零件读同一个函数），而**函数体一个字都没改**
 *   （还是那一行 `=== 'projectile'`）—— 所以**追踪的行为完全不变**。
 *
 * ⚠ 参数的形状是 `string`（不是 `DeliveryKind`）：`school.ts` 是**纯函数模块**
 * （只 import type），而判据要对着**运行时的 `action.delivery.kind`** 用 ——
 * 那里拿到的是一个普通字符串。认不出的 kind（拼错 / 老数据）⇒ `false`
 * （"它不是一个会飞的东西"），和"非飞行载体什么都不做"同一条路。
 */
export function carrierFliesInWorld(kind: string | undefined): boolean {
  /*
   * ⚠ 只有这一个为真。**加载体的人看这里**：
   *   将来真出现第二种"会飞的东西"（比如轨道弹 / 追踪地雷），
   *   判据在这一处加一项，两个零件的校验器和账本**自动跟着对**。
   */
  return kind === 'projectile'
}

// ---------------------------------------------------------------------------
//  「弹射」的参数（2026-09-30 日志 58）
// ---------------------------------------------------------------------------
//
//  ⚠ 和「追踪」那一段同一个理由（同一个数会被三处问，各写一遍必然漂移）：
//    · `sim/compile.ts`   编译期把它读进 `CompiledMod.bounce`（运行时只读编译产物）
//    · `validator/*`      校验两个数在不在原型给的区间里
//    · `pricing.ts`       按"弹几次 + 每次衰减多少"记点数

/**
 * `maxBounces` / `damageFalloff` 这两个键，外加原型上的三个范围键。
 *
 * ⚠ 名字和「追踪」/「排布」那两套**故意不共用**：三个零件的参数各自可调，
 *   共用一个键名的话"调弹射的次数"会顺手把别人的上限也改了。
 */
export const MODIFIER_BOUNCE_COUNT_KEY = 'maxBounces'
export const MODIFIER_BOUNCE_FALLOFF_KEY = 'damageFalloff'
export const MODIFIER_BOUNCE_MAX_COUNT_KEY = 'maxBouncesCap'
export const MODIFIER_BOUNCE_MIN_FALLOFF_KEY = 'minFalloff'
export const MODIFIER_BOUNCE_MAX_FALLOFF_KEY = 'maxFalloff'

/**
 * 弹射次数的**地板** = **1**（不是 0）。
 *
 * ⚠ 0 就是"命中之后一次都不弹"= 这个零件白装，而那和"没装"在表现上完全一样
 *   —— 那是"没计价"，不是"一个合法的旋钮"（和 `MODIFIER_HOMING_TURN_MIN` 同一条纪律）。
 */
export const MODIFIER_BOUNCE_COUNT_MIN = 1

/**
 * ⚠⚠ **弹射次数的上限 = `MAX_ACTION_DEPTH`**（玩家 2026-09-30 的硬命令，日志 58）。
 *
 *   玩家原话：
 *   > **上限必须和 `pipeline` 的深度限制用同一条规矩** ✗（先 grep `depth` ✓
 *   > 找现有上限 ✓ **复用它** ✓ —— 各写一份迟早出现"弹射绕过深度保护 ⇒ 自反馈"✗）
 *
 *   为什么它真的会"绕过深度保护"：弹射是一条**链**，而链上**每一段都是一颗新子弹**
 *   （见 `sim/projectile.ts` 的 `bounceToNextTarget`）—— `executeAction` 的
 *   `depth` 在每一段上都从 0 开始，**不会自然累加**。
 *   ⇒ 这条链唯一的刹车就是"还能弹几次"，所以那个数**必须就是**这个深度上限本身。
 *
 *   ⚠ 它是 **`MAX_ACTION_DEPTH` 那一个数**（不是 4 的第二份拷贝）：
 *     `src/limits.ts` 一改，这里跟着改，别的地方什么都不用动。
 */
export const MODIFIER_BOUNCE_COUNT_MAX = MAX_ACTION_DEPTH

/** 这一片自己给的初值、**待玩家签字**（玩家只说了"弹两下的闪电"） */
export const MODIFIER_BOUNCE_COUNT_DEFAULT = 2

/**
 * 每次衰减（`damageFalloff`）的范围：**0.1 ~ 1**。
 *
 * ⚠ 它是"**乘**"的那个数：`0.7` = 玩家说的"**−30%**"（下一段是上一段的 70%）。
 *   · 上限 **1** = "不衰减"（写法合法，但它等于白送一个旋钮 —— ⚠ 上限不许 > 1：
 *     放大不是这个零件的事，那是另一个零件）；
 *   · 下限 **0.1**（不是 0）：0 会让"弹射的第二段"变成 **0 伤害** ——
 *     那和"没有第二段"在表现上分不出来（花点数买了一个看不见的 0）。
 *   ⚠ 和"表的分辨率"那件事同一条纪律：**不许出现"写了但算不出来"的取值** ——
 *     这里没有查表，0.1 这个刻度是真能被表达的。
 */
export const MODIFIER_BOUNCE_FALLOFF_MIN_FALLBACK = 0.1
export const MODIFIER_BOUNCE_FALLOFF_MAX_FALLBACK = 1
/** 没写 `damageFalloff` 时的默认值 = 玩家说的"**每次 −30%**" */
export const MODIFIER_BOUNCE_FALLOFF_DEFAULT = 0.7

/**
 * 这个原型的**弹射次数上限**（`params.maxBouncesCap`）—— ⚠ 用户 2026-09-30 裁定的口径：
 * 它是**上限的上限**（**保留**），不是"一个说了不算的旋钮"。
 *
 * ⚠⚠ **数据只能把它调小，不能调大**：结果是
 *   `min(数据写的上限, MAX_ACTION_DEPTH)` —— 写成 9 也还是 4。
 *   写成 9 时**不是静默的**：校验器有一条 `MODIFIER_BOUNCE_OVER_CAP`
 *   （"数据想超过引擎的深度上限"）在那儿报错。
 *   ⚠ 理由就是玩家那句"各写一份迟早出现绕过深度保护"：
 *     数据那一份**存在**（编辑器拿它划滑块范围、也可以配得更保守），
 *     但**把上限抬到引擎之上是无效的**。
 */
export function modifierBounceMaxCountOf(proto: ModifierProto): number {
  const raw = readNumber(proto.params?.[MODIFIER_BOUNCE_MAX_COUNT_KEY])
  if (raw === undefined) return MODIFIER_BOUNCE_COUNT_MAX
  return clamp(Math.floor(raw), MODIFIER_BOUNCE_COUNT_MIN, MODIFIER_BOUNCE_COUNT_MAX)
}

/** 这个原型的**衰减下限**（`params.minFalloff`），没写就是 0.1 */
export function modifierBounceMinFalloffOf(proto: ModifierProto): number {
  const raw = readNumber(proto.params?.[MODIFIER_BOUNCE_MIN_FALLOFF_KEY])
  return raw === undefined ? MODIFIER_BOUNCE_FALLOFF_MIN_FALLBACK : clamp(raw, 0, 1)
}

/**
 * 这个原型的**衰减上限**（`params.maxFalloff`），没写就是 1。
 *
 * ⚠ `Math.max(min, max)` 和 `modifierHomingMaxRangeOf` 一样：写成 `maxFalloff: 0`
 *   时 `[0.1, 0]` 是个空区间，夹取会静默地把每一次弹射都变成"0 伤害"。
 */
export function modifierBounceMaxFalloffOf(proto: ModifierProto): number {
  const min = modifierBounceMinFalloffOf(proto)
  const raw = readNumber(proto.params?.[MODIFIER_BOUNCE_MAX_FALLOFF_KEY])
  return raw === undefined ? MODIFIER_BOUNCE_FALLOFF_MAX_FALLBACK : clamp(Math.max(min, raw), 0, 1)
}

/**
 * 这份副本的**最多弹几次**：副本优先、原型兜底，再夹到 `[1, 原型上限]`
 * —— 而原型上限**本身**又被 `MAX_ACTION_DEPTH` 顶着（见 `modifierBounceMaxCountOf`）。
 *
 * ⚠ 夹是**防御性**的（判据在校验器）：手改的存档 / 老分享码绕过校验器直接进世界。
 *   不夹的话 `maxBounces: 1e9` 会让一次施法**打到天荒地老**
 *   （每一段都是一颗新子弹，`depth` 不累加 —— 那正是玩家点名的那个自反馈）。
 */
export function modifierBounceCountOf(
  mod: SegmentMod,
  proto: ModifierProto,
): { maxBounces: number; raw: number; min: number; max: number; clamped: boolean } {
  const min = MODIFIER_BOUNCE_COUNT_MIN
  const max = modifierBounceMaxCountOf(proto)
  const raw = readNumber(mod.params[MODIFIER_BOUNCE_COUNT_KEY])
    ?? readNumber(proto.params?.[MODIFIER_BOUNCE_COUNT_KEY])
    ?? MODIFIER_BOUNCE_COUNT_DEFAULT
  /*
   * ⚠ `Math.floor`：次数是**整数**（"弹 2.7 次"不是一种表现）。
   *   写成 2.7 ⇒ 按 2 次弹，而且编译期**会说**（和别的夹取同一条纪律）。
   */
  const maxBounces = clamp(Math.floor(raw), min, max)
  return { maxBounces, raw, min, max, clamped: maxBounces !== raw }
}

/**
 * 这份副本的**每次衰减**（`damageFalloff`，乘数）：副本优先、原型兜底，
 * 再夹到 `[原型下限, 原型上限]`。
 *
 * ⚠ 和次数同一条纪律（不夹的话 `damageFalloff: 1e9` 就是"越弹越强"，
 *   那会让"弹射"变成一台没有上限的放大器）。
 */
export function modifierBounceFalloffOf(
  mod: SegmentMod,
  proto: ModifierProto,
): { damageFalloff: number; raw: number; min: number; max: number; clamped: boolean } {
  const min = modifierBounceMinFalloffOf(proto)
  const max = modifierBounceMaxFalloffOf(proto)
  const raw = readNumber(mod.params[MODIFIER_BOUNCE_FALLOFF_KEY])
    ?? readNumber(proto.params?.[MODIFIER_BOUNCE_FALLOFF_KEY])
    ?? MODIFIER_BOUNCE_FALLOFF_DEFAULT
  const damageFalloff = clamp(raw, min, max)
  return { damageFalloff, raw, min, max, clamped: damageFalloff !== raw }
}
