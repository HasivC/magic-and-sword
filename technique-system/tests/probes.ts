/**
 * 测试用的**探针术式**：出厂示范删掉之后，测试要的那几份在这儿现造。
 *
 * ## 为什么要有这个文件
 *
 * 玩家 2026-09-21 定的：
 *   > 敌人用的术式存到别的地方，玩家在编辑器里看不到这些示范术式，也没法引用它们。
 *
 * 于是 `content/techniques/` 里那二十多份「一个技能配一份同名术式」的示范
 * 被砍到只剩**真的被引用**的 17 份（搬去了 `content/internal-techniques/`）。
 * 但测试一直在拿它们当夹具用 —— 那些测试测的是**引擎行为**
 * （护盾吸收、冻结禁用、被动 onCast、prevHit 连接），和"出厂有几份示范"无关。
 *
 * 与其让引擎能力和内容数量绑死，不如在这儿把用到的那几份**现造**出来：
 * 形状照着被删掉的那几份抄（`activation` / `targeting` 都要抄对 ——
 * 被动是 `auto`、常驻开关是 `toggle`，抄错了 `setTechniqueActive` 的行为会变），
 * 但它们是测试自己的东西，不是发布内容。
 *
 * ## 点数
 *
 * `bloodPactCost` 一律写 0：这些都是"一个技能"的术式，
 * 而宗旨是**每个技能的出厂数值本身就配平到 0**（`tests/pricing.ts` 扫全部技能钉着）。
 * 想要负值术式的话那是另一条路 —— 在 `tests/scenario.ts` 里现编一份变体（第 33 节）。
 */
import type { Library } from '../src/bridge.ts'
import { compileTechnique } from '../src/sim/compile.ts'
import type { CompiledTechnique } from '../src/sim/compile.ts'
import type { Technique } from '../src/schema.ts'

interface ProbeDef {
  name: string
  skills?: string[]
  /** 不写就是 press */
  activation?: Technique['activation']
  links?: Technique['links']
}

/**
 * 被删掉的示范的**定义**。要用新的就照抄一行。
 *
 * `activation` 各自不同，别一律 press：
 *   · 名刀·司命 / 猎手直觉 是 `auto`（被动 —— 挂上就跑 onCast）
 *
 * ⚠ **2026-09-21（日志 48）「背水」那一份探针删掉了**：
 *   它从"一个 toggle 的常驻技能"变成了**一门真实的常驻术式**
 *   （`content/internal-techniques/last-stand.json`，`activation: auto` +
 *   监测器修饰副本 + `skill.last-stand-shield`）—— 所以它现在住在**内容里**，
 *   不需要探针。`tests/scenario.ts` 第 21 节直接挂内容那一份。
 *
 *   ⚠ 删掉它而不是"留一份探针指着旧 id"：旧 id（`skill.last-stand`）
 *     已经**整个不存在了**（那一份技能被拆成了监测器 + 撑盾）。
 *     留一份探针只会得到"引用了不存在的技能"。
 *
 * ⚠ **2026-09-21（日志 47）"瞄准"这一栏删掉了**：瞄准搬到了**技能层**，
 *   所以探针的瞄准现在来自它引用的那份技能（`Skill.targeting`）——
 *   而"那个技能该瞄哪儿"是内容的事，测试这一层不该再有第二份真相。
 *   （以前这里每一份都写着 `targeting`，那是术式还带瞄准时的写法。）
 *
 *   ⚠ 上一片有一份探针的瞄准和内容里的技能**不一样**（`tech.insight` 写的是
 *     `self` / 12 米，而 `skill.insight` 是 `directional` / 8 米）——
 *     那是"探针自己的一套数"，不是技能的事实。现在统一由技能说话。
 */
const PROBES: Record<string, ProbeDef> = {
  'tech.aegis': {
    name: '灵光盾', skills: ['skill.aegis'],
  },
  'tech.armor-pierce': {
    name: '破军突刺', skills: ['skill.armor-pierce'],
  },
  'tech.holy-light': {
    name: '圣光术', skills: ['skill.holy-light'],
  },
  'tech.hunter-instinct': {
    name: '猎手直觉', skills: ['skill.hunter-instinct'], activation: 'auto',
  },
  'tech.insight': {
    name: '洞察', skills: ['skill.insight'],
  },
  'tech.iron-shirt': {
    name: '铁布衫', skills: ['skill.iron-shirt'],
  },
  'tech.named-blade': {
    name: '名刀·司命', skills: ['skill.named-blade'], activation: 'auto',
  },
  'tech.raise-dead': {
    name: '亡灵复生', skills: ['skill.raise-dead'],
  },
  /*
   * ⚠ 这一份不是一个技能 —— 它是玩家给的那个例子：
   *   「向指向方向位移（技能），若触碰到敌人则释放冲击（技能）」
   *   `links: [{ if: [prevHit] }]` 就是"编程"落地的地方。
   *   `tests/scenario.ts` 第 31/32 节整节在测它。
   */
  'tech.charge-impact': {
    name: '冲撞冲击', skills: ['skill.charge-dash', 'skill.impact-burst'],
    links: [{ if: [{ type: 'prevHit' }], note: '冲到了才炸' }],
  },
}

/**
 * 造一份探针术式（编译好的）。
 *
 * 找不到定义返回 `undefined` —— 调用方（`lookup`）要能区分
 * "出厂内容里没有"和"探针也造不出来"，不然内容写错会被静默当成探针。
 *
 * ⚠ 按 `Library` 缓存：`lookup` 会被调很多次，
 *   每次都重编译的话既慢又会让同一份术式出现好几个对象。
 */
const cache = new WeakMap<Library, Map<string, CompiledTechnique>>()

export function probeTechnique(lib: Library, id: string): CompiledTechnique | undefined {
  let per = cache.get(lib)
  if (per === undefined) {
    per = new Map()
    cache.set(lib, per)
  }
  const hit = per.get(id)
  if (hit !== undefined) return hit

  const def = PROBES[id]
  if (def === undefined) return undefined

  const technique: Technique = {
    schemaVersion: 1,
    id,
    name: def.name,
    // ⚠ 系别必填（schema 的 Technique.kind）：探针造的都是魔法术式
    //   （引用的全是 content/skills 里的技能）
    kind: 'magic',
    activation: def.activation ?? 'press',
    // ⚠ **不写 `targeting`**：瞄准在**技能**上（2026-09-21 日志 47）——
    //   编译时 `compileTechnique` 从探针引用的那份技能身上取
    //   （`targetingOfChain`），探针只负责"引用哪个技能"。
    skills: [...(def.skills ?? [])],
    ...(def.links === undefined ? {} : { links: def.links }),
  }
  const { compiled } = compileTechnique(technique, sid => lib.skills.get(sid), {
    bloodPactCost: 0,
  })
  per.set(id, compiled)
  return compiled
}
