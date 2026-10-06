/**
 * 技能编辑器（滑块层 + 规则增删）。
 *
 * 这是整个项目的**生死线**：如果陌生人不能在五分钟内捏出一个能用的技能，
 * 那"极高自由度"这个卖点就不成立 —— 引擎做得再对也没用。
 *
 * ---
 *
 * ## 它编的是「技能」，不是「术式」
 *
 *   技能 = 零件。有阶段、有规则、有代价。**改的是它。**
 *   术式 = 编排。哪几个技能、按什么顺序、绑哪个键。**放的是它。**
 *
 * 所以左边的下拉框里选的是技能；改完之后，**用到它的术式会当场重新编译**，
 * 回到右边的场地里按对应的键，打出来的就是改之后的效果。
 *
 * ## 三个设计决定
 *
 * **1. 它不另开页面，就长在游戏里。**
 *   改完立刻能在右边的场地里打 —— 不需要刷新、不需要切窗口。
 *
 * **2. 数值部分不针对任何一种效果写专用表单。**
 *   而是把技能 JSON 里所有数值叶子抽出来做成滑块（见 leaves.ts）。
 *   **加新效果不用改编辑器** —— 七个技能一共抽出一百多个可调数值，
 *   其中没有一个是专门为它写的。
 *
 * **3. 规则列表是主体交互。**
 *   "新增一条规则"是这个编辑器的主动词 —— 加一条效果，点数变小（消耗额度）；
 *   加一条代价，点数变大（提供额度）。**这就是"为了变强必须付出代价"的循环。**
 *
 * ## 点数是什么（上一版这里没写清楚，玩家问了）
 *
 *   点数是一本**额度账**：
 *     **负数 = 效果消耗的额度**（伤害、治疗、给敌人上 debuff、买规则位）
 *     **正数 = 代价提供的额度**（扣能量/生命、冷却、自我限制、卖规则位）
 *
 *   ⚠ **配平的责任在术式，不在技能**（玩家 2026-09-21 澄清）：
 *     > 技能不必配平到 0，但要想编排为术式，术式必须配平（单个技能也可以成为术式）
 *
 *   所以这个面板**不判对错**，只告诉你"这块零件值多少":
 *     技能 = 零件，可以是一块纯收益（火球），也可以是一块纯代价（长冷却收招）
 *     术式 = 成品，它所有零件加起来必须是 0
 *   判"没配平"的红灯在**术式编辑器**里。这里给红灯就是假警报 ——
 *   玩家是**故意**做歪零件的。
 *
 *   加起来是**负数 = 花超了**，那段就得靠同一术式里的代价零件补回来。
 *
 *   ⚠ 方向改过两次，值得写下来：
 *
 *     玩家第一次说："**买卖规则位得点数的正负反了。**"
 *     —— 他的意思是**那一行**反了（账本里别的东西消耗额度都是负的，
 *        唯独买规则位显示成 +1.5）。我却把**整本账**翻了过来。
 *
 *     玩家第二次说："**点数为负值的才是超模技能。**"
 *     —— 这才发现翻整本账把超模的判据也翻反了。
 *
 *     教训：账本的方向是从玩家那一侧定的，不能因为一行看着别扭就整本翻。
 *
 *   ⚠ 点数是**算出来的**，不是填出来的：你把 30 伤害拖成 300 伤害，
 *     那条"伤害"的点数会自己变。上一版它是手写的，
 *     改数值点数纹丝不动，等于可以白嫖 —— 那是实测踩到的坑。
 *
 * ## 它用的是和命令行同一份代码
 *
 * `src/validator/` 和 `src/pricing.ts` 都不依赖 node，
 * 所以校验和点数账本直接在浏览器里跑。编辑器看到的问题和
 * `npm run validate` 说的是同一件事。
 */
import { validateSkill } from '../../src/validator/index.ts'
import {
  priceRule, priceSkill, readLookupTable, readRates, skillLedger,
  // ⚠ 四档时长各自值多少点：走 pricing.ts 的**表**，别自己乘汇率
  //   （表名 `phaseDurationPoints`：0 → −6 / 1 → 0 / 3 → +2 / 9 → +4）。
  //   ⚠ 2026-09-30 日志 63：**倍数档走表、绝对秒数走 `lookupTable`** ——
  //   判据是 `phaseDurationTierPriceOf`（和账本 `lookupEntriesOf` 同一句），
  //   覆盖（`bySkill`）用 `tierPointsForSkill` 取。
  //   ⚠ 装配线**补了一行** `tierTables: readTierTables(balance.tierTables)`
  //   （就在下面 `options` 那一段）：不补的话编辑器会落到代码兜底
  //   `DEFAULT_TIER_TABLES`（只有共享那四格、**没有按技能覆盖**）⇒ 用户填了覆盖
  //   之后"编辑器显示共享价、命令行按覆盖扣"。代码兜底仍然留着（别的入口还在用），
  //   `tests/pricing.ts` 钉着"兜底那份和内容侧那份的共享四格逐位相同"。
  phaseDurationTierPriceOf, readTierTables, tierPointsForSkill, tierTableOf, TIER_TABLE_PHASE_DURATION,
} from '../../src/pricing.ts'
import type { PriceOptions, PriceResult } from '../../src/pricing.ts'
import { allRulesOf, effectAsRule } from '../../src/effects.ts'
import { describeRule, describeStatus } from '../../src/describe.ts'
import type { DescribeNames } from '../../src/describe.ts'
import { collectStatuses } from '../../src/validator/checks.ts'
import type { BalanceConfig } from '../../src/validator/types.ts'
import type { Action, EntityDef, InterruptLevel, Rule, Skill, StatusDef, Targeting } from '../../src/schema.ts'
import { clone, collectLeaves, getByPath, gridOf, setByPath } from './leaves.ts'
import type { NumLeaf, Path } from './leaves.ts'
// 这一片的规矩都在 skill-page.ts 里（纯函数，tests/editor.ts 直接测它）
import {
  AIM_MODES, CARRIERS, DELIVERY_SHAPE_LABEL, FORM_LABEL, HOOK_SIDES, HOST_TARGETS,
  PERMANENT_NOTE, RESERVED_VALID, UNPRICED_NOTE,
  aimModeLabel, carrierLabel, cellOf, formOf, formWhy, hostTargetLabel, hookSideLabel,
  isCooldownLeaf as isCooldownPath, isDeliveryShapeLeaf, isPhaseDurationLeaf,
  knobReason, knobState, tierChoices, tierSeconds, validLabel,
} from './skill-page.ts'
import type { LookupCells } from './skill-page.ts'
// 重画时把焦点/光标 + **滚动位置**接回来 + 一块一块挂（结构固定的两步，见 ui/dom.ts）
import { captureFocus, captureScroll, endBlocks, mountBlock, restoreFocus, restoreScroll } from './ui/dom.ts'

export interface EditorHost {
  /**
   * **基础技能库**（`content/skills` + `content/weapon-skills`）。
   *
   * ⚠ 它是**只读**的：这是出厂内容，默认配平为 0 点。
   *   玩家不能改它，只能拿它当**模板**"创造一个技能"。
   */
  base: Map<string, Skill>
  /**
   * **自定义技能库**：玩家创造出来的变体（存在存档里）。
   *
   * ⚠ 玩家 2026-09-21 定的两个库的模型：
   *   > 技能是玩家拥有的东西，存在两个库：基础技能库……自定义技能库
   *   > （玩家进行编辑后的技能另存一份副本在这里）。
   *   > 自定义技能是独立的，它不属于术式。
   */
  custom: Map<string, Skill>
  /** 技能 id → 用到它的术式名。技能自己不能放，得让人看见它挂在哪儿 */
  usedBy: Map<string, string[]>
  /**
   * 保存草稿。
   *
   *   `'save'`   写回（**草稿还没进库时按新建处理**）
   *   `'saveAs'` 存成一份**新的**（新 id、新名字，模板不变）
   *
   * ⚠ 返回真正落库的那一份的 id/名字 —— 「另存为」会换 id，
   *   编辑器必须跟着切过去，否则下一次「保存」会写回原来那份。
   */
  onSave: (draft: Skill, mode: 'save' | 'saveAs') => { id: string; name: string } | undefined
  /**
   * 删一个自定义技能。
   *
   * ⚠ 还有术式在用它时**宿主要拒绝**并把是哪几份术式说清楚
   *   （玩家 2026-09-21 选的："禁止删 —— 先把引用它的术式改掉"）。
   */
  onDelete: (id: string) => void
  /**
   * 状态库（`content/statuses/`）。
   *
   * ⚠ 编辑器必须拿到它，否则拖动一个"引用库状态"的规则时，
   *   那条规则在点数条上会显示成 **0 点** —— 看起来像是白送的效果，
   *   而实际上只是编辑器看不见那个状态的定价。
   */
  statuses?: ReadonlyMap<string, StatusDef>
  /**
   * 实体预设（`content/entities/`）。
   *
   * ⚠ 同理：不传的话，一条召唤规则在点数条上只算"基础代价"，
   *   看不到召唤物血量池那部分 —— 玩家会以为召唤很便宜。
   */
  entities?: ReadonlyMap<string, EntityDef>
  /**
   * 一句提示（顶部那个 toast）。
   *
   * ⚠ 现在只有一个用途：玩家去点一个**只读**的武器技能时告诉他
   *   "这个不给改，想改强度去改武器"。静默拒绝更糟 ——
   *   点了没反应，玩家会以为编辑器坏了。
   */
  onNotice?: (msg: string) => void
}

export interface Editor {
  toggle: () => void
  isOpen: () => boolean
  /**
   * 归属换了（玩家切了"副本属于哪份术式"）。
   *
   * ⚠ 必须由宿主显式调 —— 编辑器看不见 `copies` 什么时候换了内容，
   *   不重画的话列表上还是上一份术式的副本，改一下就写错地方了。
   */
  reload: () => void
}

// ============================================================================
//  规则模板
// ============================================================================

interface RuleTemplate {
  id: string
  label: string
  kind: 'effect' | 'cost'
  apply: (skill: Skill) => string
}

/** 新规则的 id 不能和已有的撞 */
function nextRuleId(skill: Skill): string {
  const used = new Set(skill.rules.map(r => r.id))
  let n = skill.rules.length + 1
  while (used.has(`r${n}`)) n++
  return `r${n}`
}

/**
 * 加一条规则。
 *
 * ⚠ 这里**没有 points 参数** —— 点数是算出来的（src/pricing.ts）。
 *   上一版给每条规则手填点数，结果改数值点数不动，等于可以白嫖。
 *   现在模板只负责"放一个效果进来"，它值多少点由定价表说了算。
 *
 * ⚠ 也**不写"命中时额外造成 15 伤害"这种说明** ——
 *   那句话里的 15 会和数值脱节（玩家改完之后说明还是旧的）。
 *   说明统一由 `describeRule()` 从数据生成。
 *   `note` 只写生成不出来的**设计意图**。
 */
function pushRule(skill: Skill, when: Rule['when'], then: Action[], note: string): void {
  const maxOrder = skill.rules.reduce((m, r) => Math.max(m, r.order), -1)
  skill.rules.push({ id: nextRuleId(skill), note, when, then, order: maxOrder + 1 })
}

/**
 * 调色板。
 *
 * 故意只放**最常用的几种**，不是穷举 —— 穷举等于把 schema 摊在玩家脸上。
 * 剩下的靠"加一条最接近的，再用滑块改成你要的"。
 *
 * 每条新规则放进去之后点数条会立刻说"差 N 点代价"，
 * 玩家就知道该去加代价了。**那正是我们想让他学会的事。**
 */
const TEMPLATES: RuleTemplate[] = [
  {
    id: 'slow', label: '＋命中减速', kind: 'effect',
    apply: (s) => {
      pushRule(s, 'onHit', [{
        payload: {
          kind: 'status', verb: 'apply',
          inline: {
            id: `status.slow-${s.id.split('.').pop() ?? 'x'}`,
            name: '迟滞', tags: ['softCC', 'debuff'], duration: 2,
            removal: { expires: true },
            modifiers: [{ path: 'char.moveScale', op: 'mul', value: { const: 0.6 } }],
          },
        },
      }], '命中减速')
      return '加了一条效果：命中减速'
    },
  },
  {
    id: 'dot', label: '＋命中持续伤害', kind: 'effect',
    apply: (s) => {
      pushRule(s, 'onHit', [{
        payload: {
          kind: 'status', verb: 'apply',
          inline: {
            id: `status.burn-${s.id.split('.').pop() ?? 'x'}`,
            name: '灼烧', tags: ['debuff', 'dot'], duration: 3,
            removal: { expires: true },
            hooks: [{
              stage: 'after', when: 'onTick', every: 0.5,
              then: [{ payload: { kind: 'damage', amount: { const: 10 }, damageType: 'fire' } }],
            }],
          },
        },
      }], '持续灼烧')
      return '加了一条效果：命中后持续灼烧'
    },
  },
  {
    id: 'lifesteal', label: '＋命中吸血', kind: 'effect',
    apply: (s) => {
      pushRule(s, 'onHit',
        [{ target: 'self', payload: { kind: 'heal', amount: { const: 10 } } }],
        '命中吸血')
      return '加了一条效果：命中吸血'
    },
  },
  {
    id: 'killreset', label: '＋击杀重置冷却', kind: 'effect',
    apply: (s) => {
      pushRule(s, 'onKill',
        [{ payload: { kind: 'attribute', path: 'skill.cooldown', op: 'reset', value: { const: 0 } } }],
        '击杀重置冷却')
      return '加了一条效果：击杀重置冷却'
    },
  },
  {
    id: 'cost-hp', label: '＋代价：扣生命', kind: 'cost',
    apply: (s) => {
      pushRule(s, 'onCast',
        [{ payload: { kind: 'attribute', path: 'char.hp.current', op: 'add', value: { const: -15 } } }],
        '额外生命消耗')
      return '加了一条代价：施放时扣生命'
    },
  },
  {
    id: 'cost-slow', label: '＋代价：自己变慢', kind: 'cost',
    apply: (s) => {
      pushRule(s, 'onCast', [{
        target: 'self',
        payload: {
          kind: 'status', verb: 'apply',
          inline: {
            id: `status.heavy-${s.id.split('.').pop() ?? 'x'}`,
            name: '沉重', tags: ['debuff'], duration: 3,
            removal: { expires: true },
            modifiers: [{ path: 'char.moveScale', op: 'mul', value: { const: 0.7 } }],
          },
        },
      }], '沉重：自己变慢')
      return '加了一条代价：自己变慢'
    },
  },
]

// ============================================================================
//  编辑器
// ============================================================================

export function createEditor(host: EditorHost, balance: BalanceConfig): Editor {
  const root = document.getElementById('editor') as HTMLDivElement
  const body = document.getElementById('editorBody') as HTMLDivElement

  const options: PriceOptions = {
    rates: readRates(balance.rates),
    baseRuleSlots: balance.baseRuleSlots,
    ruleSlotBuyCost: balance.ruleSlotBuyCost,
    ruleSlotSellGain: balance.ruleSlotSellGain,
    tolerance: typeof balance.balanceTolerance === 'number' ? balance.balanceTolerance : 0,
    // ⚠ 全量点表（2026-09-30 日志 60b）：装上它，技能的点数才是**查表 + 相加**
    //   （用户规格）。不装的话账会**静默地**退回老公式 —— 而编辑器里看到的数
    //   就会和命令行算出来的不一样（本项目最恨的那类漂移）。
    lookupTable: readLookupTable(balance.lookupTable),
    /*
     * ⚠⚠ **档位表也必须从内容侧读**（2026-09-30 日志 63）—— 这是本片补的一条装配线。
     *
     *   四档时长现在走**倍数档表**，而那张表里有一条**按技能覆盖**（`bySkill`，
     *   用户在 `content/balance.json` 里填）。不传 `tierTables` 的话编辑器会落到
     *   代码兜底 `DEFAULT_TIER_TABLES` —— 那一份**只有共享的四格、没有覆盖**
     *   ⇒ **玩家给某个技能填了覆盖之后，编辑器显示的还是共享那个价、而命令行按覆盖扣**。
     *   那正是本项目最恨的那类静默漂移（"我改了它没生效"）。
     *
     *   ⚠ 这一行**只喂价格显示**（`phaseDurationTierPriceOf` / `tierPointsForSkill`），
     *   渲染 / 控件 / 布局 / CSS 一个字节都没碰。
     */
    tierTables: readTierTables(balance.tierTables),
    // ⚠ 不传的话，引用状态库的规则在点数条上是 0 点
    ...(host.statuses !== undefined ? { statuses: host.statuses } : {}),
    ...(host.entities !== undefined ? { entities: host.entities } : {}),
  }

  /**
   * 编辑器里的**草稿**（还没保存的那一份）。
   *
   * ⚠ 玩家 2026-09-21 定的流程：
   *   > 在自定义技能库的界面中选择"创造一个技能"并选择一个基本技能作为模板，
   *   > 然后进行编辑，最后保存。
   *   所以**改的是草稿，按「保存」才进库** —— "改了没保存就走开"什么都不发生。
   */
  let draft: Skill | undefined
  /** 现在选中的是哪个库里的哪一份（基础技能库 / 自定义技能库都可能是它） */
  let currentId: string | undefined
  /** 草稿还没进库（刚"创造"出来的那份） */
  let isNew = false
  /** 草稿和库里的那一份不一样（有没保存的改动） */
  let dirty = false
  let open = false
  let showJson = false
  /**
   * 现在在哪一页。
   *
   * ⚠ 照用户的设计模板（`ui-mockups/editor-v2.html`）：技能这边是**两块屏**，
   *   不是"一屏里左中右三条"——
   *     `lib`  左**技能库**（搜 + 分组格子）+ 右**详情**（名字 / 数值 / 一个动作按钮）
   *     `edit` **编辑区**占满整宽（模板里编辑这一屏**没有左边那列技能库**）
   *   模板里编辑那一屏的顶栏是"名字 · 副标题 · 瞄准"，底栏是"保存 / 另存为 / 返回"。
   */
  let view: 'lib' | 'edit' = 'lib'
  /** 技能库里的搜索词（照模板那个 `搜技能…` 输入框） */
  let query = ''

  /** 这一份是自定义技能（可改可删）吗 */
  function isCustom(id: string | undefined): boolean {
    return id !== undefined && host.custom.has(id)
  }

  /**
   * 这一份**能不能改**（玩家 2026-09-21 定的流程：基础技能是模板，不能直接改）。
   *
   * ⚠ 武器技能（`readonly: true`）**连编辑页里的滑块都不给** ——
   *   它的数值由武器属性代入（同一份模板在不同武器上不同），
   *   在这儿改一刀等于把所有用它的武器一起改了，而界面上完全看不出来。
   */
  function editable(): boolean {
    if (draft?.readonly === true) return false
    return isNew || isCustom(currentId)
  }

  /** 现在这一份的账按哪一份的基础技能查（变体对着它的模板查） */
  function ledgerBaseId(): string | undefined {
    if (draft === undefined) return undefined
    return draft.basedOn ?? draft.id
  }

  /**
   * 一个变量在账上那一行格子（`lookupTable[基础技能id][变量]`）。
   *
   * ⚠ 这是**死滑块铁律**的判据来源：整行同值 = 拖了不动、整行没有 = 不参与账。
   *   界面不许自己猜"这个看起来该计价"。
   */
  function lookupRow(variable: string): LookupCells | undefined {
    const id = ledgerBaseId()
    if (id === undefined || id === '') return undefined
    return options.lookupTable?.[id]?.[variable]
  }

  /** 某个阶段时长的四档（含单独的蓄力那一档） */
  function phaseTiers(index: number, factory: number): ReturnType<typeof tierChoices> {
    /*
     * ⚠⚠ 2026-09-30 日志 63：**倍数档走表**（`phaseDurationTierPriceOf` ——
     *   和账本 `lookupEntriesOf` 同一句判据），绝对秒数那几格继续走 `lookupTable`。
     *
     * 少了这一句，四档里 3× / 9× / 无 会因为"账上没有那几格"而**置灰**，
     * 而账其实算得出价（表里那四个整数）—— 那是"死滑块"反过来的一种错：
     * 账是活的，界面却说它是死的（玩家看到的是"这一档不给点"，实际给点）。
     */
    return tierChoices(factory, (seconds) => phaseTierPrice(index, factory, seconds) !== undefined)
  }

  /**
   * 这一档在账上值多少点。
   *
   * ⚠ 两条来源，优先级和账本**逐字相同**（`src/pricing.ts` 的
   *   `lookupEntriesOf` 那段注释）：
   *     ① 倍数档（现在 / 出厂 ∈ 表里那几档）⇒ 查 `tierTables`（含按技能覆盖）；
   *     ② 别的（表外取值、蓄力哨兵）⇒ 查 `lookupTable` 的绝对秒数格。
   *   ⚠ 蓄力（`seconds = -1`）在 ① 里恒为 `undefined` ⇒ 一定落到 ②（它是另一根轴）。
   */
  function phaseTierPrice(index: number, factory: number, seconds: number): number | undefined {
    const tier = phaseDurationTierPriceOf(factory, seconds, options, ledgerBaseId())
    if (tier !== undefined) return tier.points
    return cellOf(lookupRow(`phases.${index}.duration`), seconds)
  }

  /** 按 id 取技能：**自定义库优先、基础库兜底**（和引擎那边同一句话） */
  function skillOf(id: string): Skill | undefined {
    return host.custom.get(id) ?? host.base.get(id)
  }

  /**
   * 草稿**相对它的模板**的那一份基础技能 —— 算账的基准。
   *
   * ⚠ 变体的账对着 `basedOn`（**最初那个基础技能**）算，
   *   不是对着上一份变体（宗旨：偏离出厂版多少）。
   *   基础技能自己的基准就是它自己 → 空账（0 点）。
   */
  function templateOf(skill: Skill | undefined): Skill | undefined {
    if (skill === undefined) return undefined
    if (skill.basedOn === undefined) return skill
    return skillOf(skill.basedOn)
  }

  /**
   * 现在"高亮"的是哪一份。
   *
   * ⚠ 草稿还没进库（`isNew`）时列表上得有个落脚点 —— 那就是它**基于**的那个模板
   *   （照模板的 `.cell.on` 用法：选中的格子描边，玩家一眼知道自己在看谁）。
   */
  function highlightedId(): string | undefined {
    return currentId ?? draft?.basedOn
  }

  /**
   * 技能库里的一格（照设计模板 `editor-v2.html` 的 `.cell` / `.icon`）。
   *
   * ⚠ 三个库的颜色和角标是模板里定死的：基础=蓝 / 我的=紫（角标「变」）/
   *   武器技能=橙（角标「武」）。**颜色不是装饰** —— 它一眼说明"这一格能不能改"。
   */
  function skillCell(id: string): string {
    const s = skillOf(id)
    if (s === undefined) return ''
    const mine = isCustom(id)
    const ro = s.readonly === true
    const color = ro ? '#f0883e' : mine ? '#c678dd' : '#58a6ff'
    const tag = mine
      ? `<span class="sk-tag" style="background:#c678dd">变</span>`
      : ro ? `<span class="sk-tag" style="background:#f0883e">武</span>` : ''
    const on = highlightedId() === id ? ' on' : ''
    const users = host.usedBy.get(id) ?? []
    const title = [
      s.name,
      ro ? '武器技能 · 只读（数值由武器属性代入）' : mine ? '我的技能 · 可改可删' : '基础技能 · 只读模板',
      s.basedOn !== undefined ? `基于 ${skillOf(s.basedOn)?.name ?? s.basedOn}` : '',
      users.length === 0 ? '没被任何术式用到' : `被 ${users.length} 个术式用到`,
    ].filter(x => x !== '').join(' · ')
    return `<div class="sk-cell${on}" data-act="pick" data-i="${esc(id)}" title="${esc(title)}">
      <div class="sk-icon" style="background:${color}" data-v="cell-${esc(id)}">${esc(s.name.slice(0, 1))}${tag}</div>
      <div class="sk-nm">${esc(s.name)}</div>
    </div>`
  }

  /** 一个分组的标题（照模板的 `.grouphead`） */
  function groupHead(color: string, title: string, note: string): string {
    return `<div class="sk-grouphead"><span class="sk-dot" style="background:${color}"></span>`
      + `${esc(title)} <span class="sk-n">${esc(note)}</span></div>`
  }

  function selectSkill(id: string): void {
    const src = skillOf(id)
    if (src === undefined) return
    /*
     * ⚠ **武器技能（只读）照样可以"选中来看"**，只是不给改。
     *
     *   上一版是**直接拒绝**（弹一句 toast 就退回去）—— 那样玩家连"这份技能长什么样、
     *   为什么它没有账"都看不到，而这恰恰是用户在交接单里点名要说的那一句
     *   （"武器技能没有账时，界面必须说出为什么"）。
     *   现在：选中 → 详情页照常显示数值 → 编辑页里**所有控件置灰** +
     *   一行"为什么"（`readonlyReason()`）。
     */
    if (src.readonly === true) {
      host.onNotice?.(
        `「${src.name}」是武器技能（只读）—— 它由武器属性代入，本页不给改。`
        + '想改强度就改武器（content/weapons/）里的数值。',
      )
    }
    currentId = id
    draft = clone(src)
    isNew = false
    dirty = false
    render()
  }

  /**
   * 「创造一个技能」：拿选中的基础技能当**模板**，开一份还没进库的草稿。
   *
   * ⚠ 不立刻进库（玩家 2026-09-21 选的）："先给草稿，按「保存」才进库"——
   *   改了不保存就走开 = 什么都没发生，库里不会留垃圾。
   */
  function createFrom(template: Skill): void {
    const n = nextVariantIndex(template)
    draft = clone(template)
    draft.id = ''            // 保存时由宿主发 id
    draft.name = `${template.name}-副本${n}`
    draft.basedOn = template.id
    currentId = undefined    // 还没进库
    isNew = true
    dirty = true
    // 照模板：基础技能按「以此为原型创建新技能」之后**当场进编辑页**
    view = 'edit'
    render()
    flash(`已开一份草稿：${draft.name}（模板 ${template.name}）—— 改完按「保存」`)
  }

  /** 这份模板已经派生过几份 → 下一份叫"副本N" */
  function nextVariantIndex(template: Skill): number {
    const taken = new Set<string>()
    for (const s of host.custom.values()) {
      if (s.basedOn === template.id) taken.add(s.name)
    }
    let n = 1
    while (taken.has(`${template.name}-副本${n}`)) n++
    return n
  }

  /** 保存 / 另存为。宿主管 id 和存盘，编辑器只管把它写回去 */
  function save(mode: 'save' | 'saveAs'): void {
    if (draft === undefined) return
    const saved = host.onSave(draft, mode)
    if (saved === undefined) return
    currentId = saved.id
    draft.id = saved.id
    draft.name = saved.name
    isNew = false
    dirty = false
    render()
    flash(mode === 'saveAs' ? `已另存为「${saved.name}」` : `已保存「${saved.name}」`)
  }

  /** 丢掉没保存的改动，回到库里的那一份 */
  function discard(): void {
    if (draft === undefined || currentId === undefined) {
      // 新建的草稿：直接回到模板那一份（只读）
      if (draft?.basedOn !== undefined) selectSkill(draft.basedOn)
      return
    }
    selectSkill(currentId)
    flash('已丢掉没保存的改动')
  }

  /**
   * 任何一次改动：草稿变了 → 标脏 + 就地刷新数字（不重画，重画会让滑块掉焦点）。
   *
   * ⚠ 只读的那几份（基础技能 / 武器技能）**一个字节都不许改** ——
   *   界面上它们虽然置灰了，但事件还是接着的，所以这里也拦一道。
   */
  function touched(): void {
    if (!editable()) return
    dirty = true
    refreshLive()
  }

  // ---------------------------------------------------------------- 渲染

  /** 阶段 id → 名字。规则里写的是 id，人要看的是名字 */
  function phaseName(id: string | undefined): string | undefined {
    if (id === undefined || draft === undefined) return undefined
    return draft.phases.find(p => p.id === id)?.name ?? id
  }

  /**
   * id → 人话的两张表。
   *
   * ⚠ 状态要**把内联的也算上**：很多状态就定义在这个技能自己的规则里
   *   （灵光盾定义 status.shield、迟滞场定义 status.slowField）——
   *   只查状态库的话，读出来是「status.slowField」，不是「迟滞」。
   *   别的技能里的内联状态也要收：规则可以引用它们（裂魂引用灵光盾的盾）。
   */
  function nameTables(): DescribeNames {
    const statuses = new Map<string, string>()
    for (const [id, def] of host.statuses ?? []) statuses.set(id, def.name)
    // ⚠ 两个技能库都要扫：变体里也可能定义内联状态
    for (const s of [...host.base.values(), ...host.custom.values()]) {
      for (const { status } of collectStatuses(s)) {
        if (typeof status.id === 'string' && status.id !== '') statuses.set(status.id, status.name)
      }
    }
    const entities = new Map<string, string>()
    for (const [id, def] of host.entities ?? []) entities.set(id, def.name ?? id)

    return {
      statusName: (id: string) => statuses.get(id),
      entityName: (id: string) => entities.get(id),
    }
  }

  /**
   * 技能介绍：**它是什么**（手写的 `note`）+ **它做什么** + **时间线**。
   *
   * ⚠ 手写那一段是**唯一**允许手写的地方（另一类说明必须从数据生成，
   *   否则数字会和数值脱节）。所以这里同时给它一个输入框：
   *   面板上看得见的每一件东西都该能改，不然它就成了"藏在代码里的字"。
   *
   * ⚠ 手写的那一段只写"是什么、什么时候用、代价是什么"，
   *   **不许写数字**（校验器报 `NOTE_WITH_NUMBER`）—— 数值交给生成的那一栏。
   */
  function introHtml(): string {
    if (draft === undefined) return ''
    const skill = draft
    const names = nameTables()

    const written = `<textarea id="skillNote" class="intro-note" rows="${
      Math.max(2, Math.min(6, Math.ceil((skill.note ?? '').length / 44)))
    }" placeholder="这个技能是干什么的、什么时候用、代价是什么（不写数字 —— 数值见下面那栏生成的说明）">${
      esc(skill.note ?? '')
    }</textarea>`

    /*
     * 一句话：**固有效果** + 每条规则，各一句人话。
     *
     * ⚠ 效果在前、规则在后，和 `allRulesOf` 一致 ——
     *   "这个技能是什么"在读的时候也排在"它额外做了什么"前面。
     */
    const lines = allRulesOf(skill).length === 0
      ? '<div class="dim">这个技能既没有效果也没有规则 —— 它现在什么都不做。</div>'
      : allRulesOf(skill)
        .map(r => `<li>${esc(describeRule(r, phaseName(r.phaseId), names))}</li>`).join('')

    /*
     * 时间线：阶段名 + 时长 + 这一段要付的代价。
     * ⚠ 阶段名现在是 前摇 / 命中 / 后摇 这种平实词（内容里就写这个），
     *   所以这里直接读它，不再需要"猜前摇是哪一段"。
     */
    const timeline = skill.phases.map(p => {
      const dur = p.duration < 0 ? '按住不放' : `${fmt(p.duration)} 秒`
      const cost: string[] = []
      if (p.cost?.energy !== undefined) cost.push(`${fmt(p.cost.energy)} 能量`)
      if (p.cost?.hp !== undefined) cost.push(`${fmt(p.cost.hp)} 生命`)
      if (p.cost?.cooldown !== undefined) cost.push(`从这里开始算 ${fmt(p.cost.cooldown)} 秒冷却`)
      const c = cost.length > 0 ? `<span class="dim">（${cost.join('，')}）</span>` : ''
      return `<span class="step">${esc(p.name ?? p.id)} ${esc(dur)}${c}</span>`
    }).join('<span class="arrow">→</span>')

    return `<div class="group intro">
      <div class="sk-card-h">${esc(skill.name)}
        <span class="sk-card-n">技能介绍</span></div>
      ${written}
      <ul class="intro-rules">${lines}</ul>
      <div class="intro-timeline">${timeline}</div>
      <div class="hint">这是<b>技能</b>：术式里的一段。它自己不必配平 ——
        配平是整份术式的事（见「术式」页签）。</div>
    </div>`
  }

  /**
   * 三个阶段位置：前摇 / 释放 / 后摇。
   *
   * 为什么这样推：
   *   前摇 = 第一个阶段
   *   释放 = **第一个真正打出效果的阶段**（有 damage / heal 规则的）
   *   后摇 = 最后一个阶段
   *
   * 阶段数少于三个时会有重合，面板上同一个阶段会出现两次 —— 那是实话，
   * 不是 bug：两段式技能本来就没有独立的释放帧。
   */
  function phaseRoles(): { role: string; index: number; label: string }[] {
    if (draft === undefined || draft.phases.length === 0) return []
    // 局部绑定：下面的闭包会让 TS 不再认为 draft 一定存在
    const skill = draft

    const n = skill.phases.length
    /*
     * "释放帧"= 第一个真正打出效果的阶段。
     * ⚠ 效果住在 `effect` 里（2026-09-21 起），所以两边都要看 ——
     *   只看 `rules` 的话，绝大多数的技能会被推成"没有释放帧"。
     */
    const effectRule = allRulesOf(skill).find(r =>
      (r.then ?? []).some(a => a.payload?.kind === 'damage' || a.payload?.kind === 'heal'))
    const releaseIdx = effectRule?.phaseId !== undefined
      ? skill.phases.findIndex(p => p.id === effectRule.phaseId)
      : -1

    const pick = (index: number): { role: string; index: number; label: string } => ({
      role: '',
      index,
      label: `「${phaseName(skill.phases[index]?.id) ?? '?'}」`,
    })

    const windup = pick(0)
    windup.role = 'windup'
    const release = pick(releaseIdx >= 0 ? releaseIdx : Math.min(1, n - 1))
    release.role = 'release'
    const recovery = pick(n - 1)
    recovery.role = 'recovery'

    return [
      { role: 'windup', index: windup.index, label: windup.label },
      { role: 'release', index: release.index, label: release.label },
      { role: 'recovery', index: recovery.index, label: recovery.label },
    ]
  }

  /** 现在冷却挂在哪个阶段上（没挂就是 -1） */
  function cooldownPhase(): number {
    if (draft === undefined) return -1
    return draft.phases.findIndex(p => p.cost?.cooldown !== undefined)
  }

  /**
   * 进入冷却的时机 —— **冷却是技能唯一的属性**。
   *
   * ⚠ 玩家原话：「进入冷却的时间应该由玩家选择：在前摇、释放时还是后摇？
   *   越靠前越先进冷却，但被打断的代价越大」
   *
   * ⚠ 同日又补了一句更要紧的：
   *   > **冷却是技能的唯一属性，不能在前后摇都有冷却**，编辑器内可以选择
   *   > 这个唯一的冷却属性在前摇/后摇进入冷却。
   *
   *   所以这里**必须**是"一个秒数 + 一个时机"（不是一个阶段一个冷却）：
   *   `data-cd-at` 的按钮会把冷却从旧位置**搬**到新位置（连同秒数），
   *   而秒数滑块只有这一个。校验器那边也盯着"不能两个阶段都有冷却"。
   */
  function coolDownTiming(): string {
    if (draft === undefined || draft.phases.length === 0) return ''

    const at = cooldownPhase()
    const seconds = at >= 0 ? draft.phases[at]?.cost?.cooldown : undefined
    const roles = phaseRoles()
    const roleName: Record<string, string> = {
      windup: '前摇', release: '释放', recovery: '后摇',
    }

    const buttons = roles.map(r => {
      const active = r.index === at
      return `<button class="${active ? 'on' : ''}" data-cd-at="${r.index}">`
        + `${roleName[r.role] ?? r.role} ${r.label}</button>`
    }).join('')

    // 秒数用和别处**同一张点表**（`gridOf` 是那唯一的来源）
    const values = gridOf('cooldown')

    const slider = seconds === undefined
      ? '<div class="hint">现在这个技能没有冷却。选一个时机就会加上去。</div>'
      : `<div class="sk-field">
           <div class="label"><span>冷却时长</span><span>${fmt(seconds)} s</span></div>
           <input type="range" data-cd-seconds="1" min="0" max="${values.length - 1}" step="1"
                  value="${Math.max(0, values.indexOf(seconds))}">
           <div class="scale"><span>${values[0]} s</span><span>${values[values.length - 1]} s</span></div>
         </div>`

    return `<div class="sk-card">
      <div class="sk-card-h">进入冷却的时机
        <span class="sk-card-n">冷却是这个技能唯一的属性</span></div>
      <div class="hint">
        <b>冷却是这个技能唯一的属性</b> —— 它不会"前后摇各有一个"，
        上面选一个时机，下面调一个秒数，就这么多。
        <br>冷却在阶段**开始时**结算，而且**不退还**。所以越靠前 = 越先进冷却，
        但被打断就白付了；越靠后 = 越安全，但也越晚。
        <br>⚠ 这一段数字**不会**再出现在下面的滑块列表里（同一个东西只有一个控件）。
      </div>
      <div class="cd-choice">${buttons}<button data-cd-at="-1" class="${at < 0 ? 'on' : ''}">没有冷却</button></div>
      ${slider}
    </div>`
  }

  /**
   * 一行规则。
   *
   * ⚠ 中间那句话是**生成的**（`describeRule`），不是 `r.note`。
   *   上一版显示手写的 note，玩家把"回复 8 点生命"拖成 20 之后
   *   说明还写着 8 —— 和"点数手写在 JSON 上"是同一个错误。
   *
   *   `note` 现在只作为**设计意图**显示在第二行（小字），
   *   而且不该含数字（校验器会报警）。
   */
  /**
   * 这个技能**相对它的模板**的账 —— 编辑器里所有点数显示的源头。
   *
   * ⚠ 不能用 `priceSkill`（绝对账）。宗旨是"默认值下配平为 0"，
   *   绝对账会让每个出厂技能一进来就显示"你没配平"，
   *   而玩家什么都没做。基础技能对着自己算 → 空账（0 点）✓。
   */
  function ledger(): PriceResult {
    if (draft === undefined) return { entries: [], total: 0, kind: 'normal' }
    return skillLedger(draft, templateOf(draft) ?? draft, options)
  }

  /** 一条规则值多少点（按**现在**这套数值算） */
  function rulePoints(r: Rule): number {
    return Math.round(priceRule(r, options.rates, options.statuses, options.entities) * 100) / 100
  }

  /**
   * 一条规则**相对模板里那条**值多少点。
   *
   * ⚠ 认 `id`，而且要在 `allRulesOf` 里找 —— 效果和规则是两个列表，
   *   但它们各自带的 id 都可能出现在对面（出厂内容搬家时留下的）。
   *   只查 `rules` 的话，效果那条会永远拿不到"出厂值"，
   *   于是它的账变成"全额"，而玩家什么都没改。
   */
  function ruleDelta(r: Rule): number {
    const base = templateOf(draft)
    const was = base === undefined ? undefined : allRulesOf(base).find(x => x.id === r.id)
    const now = rulePoints(r)
    if (was === undefined) return now
    return Math.round((now - rulePoints(was)) * 100) / 100
  }

  /**
   * 一条规则/效果在**账上**值多少点。
   *
   * ⚠⚠ 账是"**查表 + 相加**"（用户 2026-09-30 定的规格），所以这一条的数也必须这么来：
   *   按**变量路径的前缀**（`rules.2.` / `effect.0.`）把那一格挑出来相加。
   *
   * ⚠ **不能用老公式**（`priceRule`，见下面的 `ruleDelta`）：那是另一条路，
   *   算出来的常常是小数（实测 `+1.4` 这种）。旁边那条总账是**整数**
   *   （用户定的："账就是整数，显示整数"）—— 把一个小数徽章摆在整数账旁边
   *   就是"两个真相"，而玩家一定会去对它们。
   *
   * ⚠ 返回 `undefined` = 这段账不是查表算的（技能没有分区，例如合成探针）
   *   ⇒ 调用方落回老公式。**不能返回 0**：0 会被读成"这一条不要钱"。
   */
  function ruleLookupPoints(prefix: string): number | undefined {
    const base = templateOf(draft)
    if (base === undefined || options.lookupTable?.[base.id] === undefined) return undefined
    return ledger().entries
      .filter(e => (e.path ?? '').startsWith(prefix))
      .reduce((s, e) => s + e.points, 0)
  }

  /** 卡片 key（`effect-0` / `rule-r3`）→ 这个变量的路径前缀（`effect.0.` / `rules.2.`） */
  function prefixOfKey(key: string): string | undefined {
    if (draft === undefined) return undefined
    if (key.startsWith('effect-')) return `effect.${key.slice('effect-'.length)}.`
    if (key.startsWith('rule-')) {
      const id = key.slice('rule-'.length)
      const i = draft.rules.findIndex(x => x.id === id)
      return i < 0 ? undefined : `rules.${i}.`
    }
    return undefined
  }

  /**
   * 一条规则/效果的卡片。
   *
   * ⚠ `key` 是**卡片自己的身份**（`rule-r3` / `effect-e1`），
   *   因为拖动数值时 `refreshLive()` 要不重画地找到它。
   *   效果和规则的 id 可能撞车，所以前面加前缀。
   */
  function ruleRow(r: Rule, key: string, prefix?: string): string {
    // ⚠ 优先走账（整数）；账不是查表算的才落回老公式
    const pts = (prefix === undefined ? undefined : ruleLookupPoints(prefix)) ?? ruleDelta(r)
    const c = pts > 0 ? '#3fb950' : pts < 0 ? '#f85149' : '#6e7681'
    const title = pts > 0 ? `这一条比出厂版本多了 +${pts} 点额度`
      : pts < 0 ? `这一条比出厂版本花了 ${pts} 点`
        : '这一条和出厂版本一样（0 点）'
    const intent = r.note !== undefined && r.note !== ''
      ? `<span class="intent">${esc(r.note)}</span>`
      : ''
    /*
     * ⚠ 固有效果**不给删**：它是这个技能的定义。
     *   想让它做别的事是"换一个技能"，那是写内容。数值照样能改（下面的滑块）。
     */
    const tail = key.startsWith('effect-')
      ? '<span class="dim" title="效果是这个技能的定义，不能删 —— 改它的数值就行">·</span>'
      : `<button data-del="${esc(r.id)}" title="删掉这条">×</button>`
    return `
      <div class="rule" data-rule="${esc(key)}" title="${esc(title)}">
        <span class="desc">${esc(describeRule(r, phaseName(r.phaseId), nameTables()))}${intent}</span>
        <span class="pts" style="color:${c}">${pts > 0 ? '+' : ''}${pts}</span>
        ${tail}
      </div>
    `
  }

  /**
   * 拖动滑块时的**就地更新** —— 不整块重画。
   *
   * 整块重画会把正在拖的那个 `<input>` 换掉，浏览器立刻停止派发
   * `input` 事件，拖到一半就断了。
   *
   * 但光更新数字也不够：说明和点数**必须跟着动**，
   * 否则玩家会觉得"我改了但它没反应"—— 这正是他报的那个问题。
   */
  function refreshLive(): void {
    if (draft === undefined) return

    const priced = ledger()
    const total = priced.total
    const tol = options.tolerance ?? 0

    const scale = Math.max(12, Math.abs(total) * 2.2)
    const gain = document.getElementById('pointsGain')
    const cost = document.getElementById('pointsCost')
    if (gain !== null) gain.style.width = `${total > 0 ? Math.min(50, (total / scale) * 50) : 0}%`
    if (cost !== null) cost.style.width = `${total < 0 ? Math.min(50, (-total / scale) * 50) : 0}%`

    const verdictEl = document.getElementById('pointsVerdict')
    if (verdictEl !== null) {
      /*
       * ⚠ 这里报的是"**你改了多少**"，不是"这个技能值多少"。
       *
       *   玩家 2026-09-21 定的宗旨：
       *   > 所有点数相关的可调整的值，都具有一个默认值，
       *   > 在这个默认值下点数是配平为0的。
       *
       *   所以出厂状态永远是 0 点（"你还没动它"），一动才出现数字。
       *   技能这一层**仍然不判对错**：改了之后可以很歪，
       *   配平的判据在术式那条账上。
       */
      if (Math.abs(total) <= 1e-6) {
        verdictEl.textContent = '还是出厂版本：0 点'
      } else if (total < 0) {
        verdictEl.textContent = `比出厂版强 ${Math.abs(total)} 点 —— 要靠别的技能来付`
      } else {
        verdictEl.textContent = `比出厂版弱 ${total} 点 —— 提供这么多额度`
      }
      verdictEl.className = 'ok'
      void tol
    }

    const totalEl = document.getElementById('pointsTotal')
    if (totalEl !== null) totalEl.textContent = `相对出厂值 ${total > 0 ? '+' : ''}${total}`

    // 规则/效果那一行的说明跟着数值走 —— 这就是玩家要的"改成 20 就该显示 20"
    for (const el of body.querySelectorAll<HTMLDivElement>('.rule[data-rule]')) {
      const key = el.dataset['rule'] ?? ''
      // ⚠ 效果和规则是两张卡片、同一套渲染（见 `ruleRow` 的 key）
      const r = key.startsWith('effect-')
        ? (draft.effect ?? []).map((e, i) => effectAsRule(e, i))[Number(key.slice('effect-'.length))]
        : draft.rules.find(x => `rule-${x.id}` === key)
      if (r === undefined) continue

      const desc = el.querySelector('.desc')
      if (desc !== null) {
        const intent = r.note !== undefined && r.note !== ''
          ? `<span class="intent">${esc(r.note)}</span>`
          : ''
        desc.innerHTML = esc(describeRule(r, phaseName(r.phaseId), nameTables())) + intent
      }

      // ⚠ 和 `ruleRow` **同一处判据**：账是查表算的，那徽章就必须跟着查表（整数）
      const prefix = prefixOfKey(key)
      const pts = (prefix === undefined ? undefined : ruleLookupPoints(prefix)) ?? ruleDelta(r)
      const ptsEl = el.querySelector('.pts')
      if (ptsEl !== null) {
        ptsEl.textContent = `${pts > 0 ? '+' : ''}${pts}`
        ;(ptsEl as HTMLElement).style.color = pts > 0 ? '#3fb950' : pts < 0 ? '#f85149' : '#6e7681'
      }
    }
  }

  /*
   * ⚠ 这里原来有一个本地的 `isCooldownLeaf`。它和别的一堆"这个数值归哪一组、能不能拖"
   *   的判据一起搬进了 `web/src/skill-page.ts` —— 那边的判据是**纯函数**，
   *   `tests/editor.ts` 能直接钉住它们（这一片最容易错的就是这些归属规则）。
   */

  /**
   * 只读的那几种，**为什么没有账 / 为什么不能改** —— 必须写出来。
   *
   * ⚠ 交接单点名：「武器技能 / 武器侧术式**没有账**时，界面必须说出为什么」
   *   —— 静默不显示会被读成"免费"。
   */
  function readonlyReason(): string {
    if (draft?.readonly !== true) return ''
    return '<b>武器技能（只读）</b>：它的数值由<b>武器属性</b>代入'
      + '（同一份模板装在不同武器上得到不同的射程 / 伤害 / 攻速）⇒ 这里不给改、也不给拖。'
      + '想改强度就改武器（<code>content/weapons/</code>）或者换一把武器。'
      + '<br>⚠ <b>它因此没有技能级的点数账</b>：账算的是"你自己这一份相对基础技能改了多少"，'
      + '而武器技能的基准是武器属性 —— 校验器把它记作 <code>priceless</code>（不是 0 点免费）。'
  }

  /**
   * 最上面那一行：**这份技能是哪一库的、能做什么**。
   *
   * ⚠ 玩家 2026-09-21 定的两个库的模型：
   *   基础技能库只读（拿它当模板"创造一个技能"），自定义技能库可改可删。
   *   所以这一行必须一眼说清"现在是哪一份、按哪个按钮"——
   *   不说的话玩家拖了半天滑块，才发现自己改的是出厂内容（而它不该被改）。
   */
  function libraryRow(): string {
    const ro = draft?.readonly === true
    const looking = currentId !== undefined && isCustom(currentId)
    const users = currentId === undefined ? [] : (host.usedBy.get(currentId) ?? [])

    /*
     * ⚠ 武器技能那一句为什么没有账，写在**顶栏那一块**（`editHead` 的 `readonlyReason()`）
     *   和**技能库详情页**里 —— 这一块再写一遍就是同一句话说三次。
     */
    if (ro) return ''

    // ① 自定义技能：可改、可另存为、可删（删受引用限制）
    if (looking || isNew) {
      const refs = users.length === 0
        ? '<span class="dim">没有任何术式用到它</span>'
        : `<span class="dim">被这些术式用着：</span>${users.map(esc).join('、')}`
      const tpl = draft?.basedOn === undefined ? undefined : skillOf(draft.basedOn)
      const head = isNew
        ? `<b class="bad">还没保存的新技能</b> —— 模板：${esc(tpl?.name ?? '?')}。
           按底栏的「保存」它才进我的技能库（在那之前术式里选不到它）。`
        : `<b>我的技能（自定义库）</b> —— 改动按底栏的「保存」才生效；
           「另存为新技能」会存成一份新的（不会动现在这份）。`
      return `<div class="sk-card">
        <div class="sk-card-h">这一份是哪一库的</div>
        <div class="hint">
          ${head}
          ${isNew ? '' : `<br>${refs}${users.length > 0
            ? '（还在用，所以删不了 —— 先把术式里的那一段换掉）' : ''}`}
        </div>
        <div class="sk-field">
          <div class="label"><span>名字</span></div>
          <input id="skillName" type="text" data-act="name" value="${esc(draft?.name ?? '')}"
                 placeholder="给它取个名字（比如 火球·爆裂）">
        </div>
        <div class="sk-choice">
          ${isNew ? '' : '<button data-act="delete" class="cost">删除</button>'}
          ${dirty ? '<button data-act="discard">放弃改动</button>' : ''}
        </div>
      </div>`
    }

    /*
     * ③ 基础技能：只读，只能拿它当模板。
     *   ⚠ 「以此为原型创建新技能」那颗按钮在**技能库详情页**（照模板的动作按钮位置），
     *     这里只留一句话指路 —— 同一个动作在两处画，玩家会以为它们不一样。
     */
    return `<div class="sk-card">
      <div class="sk-card-h">基础技能（出厂 · 只读模板）</div>
      <div class="hint">
        <b>基础技能（出厂 · 只读）</b> —— 它是所有变体的模板，
        出厂就是配平的（0 点），我们不建议也不能直接改它。
        <br>想改：回技能库点「<b>以此为原型创建新技能</b>」—— 它会另存一份副本到你的技能库里，
        之后随便你怎么改。
      </div>
    </div>`
  }

  /**
   * 重画整页。
   *
   * ⚠ 玩家 2026-09-21 要自己写 UI，而"重画"是那件事的第一个障碍：
   *   现在的做法是**整块 `innerHTML` 重写**，于是你正在改名字 / 拖滑块的时候，
   *   一重画**焦点和光标就没了**（元素被换掉了）。
   *
   *   所以这里包一层：**画之前记下焦点，画完放回去**。
   *   这只是第一步 —— 真正的"结构固定、只更新变化的数"见 `ui/dom.ts` 的说明。
   */
  function render(): void {
    /*
     * ⚠ **两样东西都要先记再放回**，理由一模一样：它们都住在**被换掉的那个元素**身上。
     *   · 焦点 / 光标（`captureFocus`）—— 上面那一段
     *   · **滚动位置**（`captureScroll`）—— 玩家实测报的"往下滚了之后点一格，
     *     页面弹回最上面"：技能库那一栏整块被 `mountBlock` 换掉，
     *     滚动位置跟着旧 DOM 一起没了，新容器从 0 开始
     *     ⇒ **不是**"点完再 `scrollTo(0)`"，是真的没丢
     */
    const focus = captureFocus(body)
    const scroll = captureScroll(body)
    renderInner()
    restoreFocus(body, focus)
    restoreScroll(body, scroll)
  }

  function renderInner(): void {
    if (draft === undefined) {
      body.innerHTML = '<div class="dim">没有可编辑的技能</div>'
      return
    }
    /*
     * ⚠ **两屏都画，切的是显示**（照设计模板：`#viewSkill` / `#editSkill` 都在 DOM 里，
     *   `render()` 只 `display` 切换）。三个理由：
     *     1. 模板就是这么干的，布局/类名能一比一照过来；
     *     2. 进编辑页不该重画一遍整棵树（滑块、`<details>` 的展开状态都留着）；
     *     3. `tests/web.ts` 的假 DOM **发不出点击事件**（stub 的 `addEventListener` 是空的）
     *        ⇒ 只画当前那一屏的话，"编辑区里到底有没有那三组控件"根本没地方断言。
     */
    renderLibrary()
    renderEdit(draft)
  }

  // ------------------------------------------------------------- 屏 1：技能库

  /**
   * **技能库**（照模板 `editor-v2.html` 的 `#viewSkill`）：
   *   左边 = 搜索框 + 三个分组的图标格子（基础 / 我的 / 武器技能）
   *   右边 = 详情（名字 + 种类药丸 + 介绍 + 数值表 + 一个动作按钮）
   *
   * ⚠ 模板里**术式库**是另一个页签（`#tabTech`）。这一片只做技能页，
   *   术式页继续由 `technique-editor.ts` 画自己的容器（`#techBody`），
   *   所以这里只画技能这一半，不碰页签本身。
   */
  function renderLibrary(): void {
    mountBlock(body, 'sk-libpage', hideUnless(view === 'lib', libraryHtml()))
  }

  /** 不是当前那一屏就套一层"藏着"的壳（`display:none`）—— 内容照样在 DOM 里 */
  function hideUnless(visible: boolean, html: string): string {
    return visible ? html : `<div class="sk-offscreen" style="display:none">${html}</div>`
  }

  /**
   * ⚠⚠ 2026-10-06（用户实测「面板对齐」）：**搜索框必须留在 `.sk-lib` 里面**。
   *
   *   左栏（`.sk-lib`）是**吃满行容器高度的竖排 flex 容器**（`height:100%`），右栏
   *   `.sk-detail` 的高度用的是**同一个表达式**（也是 `100%`，由 `.sk-cols` ← `.sk-page`
   *   ← `#editorBody` 一路给下来）—— 两栏底边齐就靠这一条（同一个 flex 行 + 外框高相等
   *   + 都从行首开始）。搜索框一旦挪到 `.sk-lib` 外面（比如挂到 `.sk-cols` 上），
   *   它就会把整行再撑高一个搜索框，两栏底边立刻又不齐。
   *   （`tests/web.ts` 的"① 对齐"那一节同时钉**结构**和那两个**高度表达式**。）
   */
  function libraryHtml(): string {
    return `<div class="sk-page"><div class="sk-cols">
      <div class="sk-lib">
        <input class="sk-search" id="skillSearch" data-act="search" placeholder="搜技能…"
               value="${esc(query)}">
        <div class="sk-libbody" data-scroll="skillLib">${libraryBody()}</div>
      </div>
      ${detailHtml()}
    </div></div>`
  }

  /** 左边那一列的**内容**（搜索框下面那一段）—— 搜索时只换这一段，不重画输入框 */
  function libraryBody(): string {
    const q = query.trim().toLowerCase()
    const match = (id: string): boolean => {
      const s = skillOf(id)
      if (s === undefined) return false
      return q === '' || s.name.toLowerCase().includes(q) || id.toLowerCase().includes(q)
    }
    const baseIds = [...host.base.keys()].filter(id => skillOf(id)?.readonly !== true).sort()
    const weaponIds = [...host.base.keys()].filter(id => skillOf(id)?.readonly === true).sort()
    const customIds = [...host.custom.keys()].sort()

    const grid = (ids: string[]): string => {
      const list = ids.filter(match)
      if (list.length === 0) return '<div class="sk-empty">这一类里没有</div>'
      return `<div class="sk-grid">${list.map(skillCell).join('')}</div>`
    }

    return `${groupHead('#58a6ff', '基础技能', `（出厂 · 只读 · ${baseIds.length} 个）`)}
      ${grid(baseIds)}
      ${groupHead('#c678dd', '我的技能', `（我做的 · ${customIds.length} 个）`)}
      ${customIds.length === 0
        ? '<div class="sk-empty">点基础技能的「以此为原型创建新技能」就有第一份了</div>'
        : grid(customIds)}
      ${weaponIds.length === 0 ? '' : groupHead('#f0883e', '武器技能', `（只读 · 由武器属性代入 · ${weaponIds.length} 个）`)}
      ${weaponIds.length === 0 ? '' : grid(weaponIds)}`
  }

  /** 右边那块详情（照模板 `renderSkillDetail`） */
  function detailHtml(): string {
    const id = highlightedId()
    const s = id === undefined ? undefined : skillOf(id)
    if (id === undefined || s === undefined) {
      return `<aside class="sk-detail"><div class="sk-none">
        <div class="sk-none-big">选中技能以查看详情</div><div>左边点一个格子</div></div></aside>`
    }

    const mine = isCustom(id)
    const ro = s.readonly === true
    const kindTxt = ro ? '武器技能 · 只读' : mine ? '我的技能（自定义）' : '基础技能 · 只读'
    const kindCol = ro ? '#f0883e' : mine ? '#c678dd' : '#58a6ff'
    const form = formOf(s)
    const users = host.usedBy.get(id) ?? []

    /*
     * 数值表：照模板那张 `table.num`。**只报"它是什么"**，
     * 不报账 —— 账是"你改了多少"，详情页上还没改，报了就是 0 点（等于没说）。
     */
    const row = (k: string, v: string): string => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`
    const timeline = s.phases
      .map(p => `${p.name ?? p.id} ${p.duration < 0 ? '按住不放' : `${fmt(p.duration)} s`}`)
      .join(' → ')
    const rows = [
      row('形态', FORM_LABEL[form]),
      row('瞄准', aimModeLabel(s.targeting?.mode)),
      row('对谁有效', (s.targeting?.valid ?? []).map(validLabel).join(' / ') || '—'),
      row('射程', s.targeting?.range === undefined ? '—' : `${fmt(s.targeting.range)} m`),
      row('时间轴', timeline === '' ? '—' : timeline),
      row('固有效果', `${(s.effect ?? []).length} 条`),
      row('规则', `${s.rules.length} / ${s.ruleSlots}`),
      /*
       * ⚠ 这一行是给"**死滑块铁律**"用的：它一眼说明这个技能有几个旋钮是**真的能动账的**、
       *   几个是"拖了也不动"（所以编辑页里不给拖）。不写的话，玩家进了编辑页
       *   只会看到一堆置灰的控件，而不知道为什么。
       */
      row('可拖的数值', editableSummary(s)),
      row('用它的术式', users.length === 0 ? '没有' : users.join('、')),
    ].join('')

    /*
     * 动作按钮 —— 照模板的三分支：
     *   基础技能 →「以此为原型创建新技能」；自定义 →「编辑此技能」；
     *   只读 / 修饰 → 一个说清楚"为什么不能改"的 warnbox。
     */
    let act: string
    if (ro) {
      act = `<div class="sk-warn">${readonlyReason()}</div>`
    } else if (mine) {
      act = `<button class="sk-primary" data-act="openEdit" data-i="${esc(id)}">编辑此技能</button>`
    } else {
      act = `<button class="sk-primary" data-act="create" data-i="${esc(id)}">以此为原型创建新技能</button>`
    }

    return `<aside class="sk-detail">
      <div class="sk-dname">${esc(s.name)}
        <span class="sk-pill" style="border-color:${kindCol};color:${kindCol}">${esc(kindTxt)}</span>
        <span class="sk-pill">${esc(FORM_LABEL[form])}</span>
      </div>
      ${s.basedOn === undefined ? '' : `<div class="sk-pill" style="border-color:#30363d">基于 ${esc(skillOf(s.basedOn)?.name ?? s.basedOn)}</div>`}
      <div class="sk-dnote">${esc(s.note ?? '（这份技能没有写介绍）')}</div>
      <!-- ⚠ 常驻才写那一句（用户 2026-09-30 点名要写的）—— 它说的是"常驻省掉的是什么、不是什么是" -->
      ${form === 'passive' ? `<div class="sk-notes">${esc(PERMANENT_NOTE)}</div>` : ''}
      <div class="sk-sect">数值</div>
      <table class="sk-num">${rows}</table>
      <div class="sk-dact">${act}</div>
    </aside>`
  }

  // ======================================================================
  //  三组控件（用户定的口径：瞄准 / 效果发生在哪里 / 宿主）
  //
  //  ⚠ 交接单 L375 把这三件事分得很死，**不许合成一个"目标"**：
  //      瞄准 = **选谁**（`Skill.targeting`）
  //      载体 = **出现在哪**（`Action.delivery` + 形状参数）
  //      宿主 = **落在谁身上 / 听谁的规则**（`Action.target` / `Action.valid` / `PipelineHook.side`）
  //    合成一个之后，"用鼠标指向、但只对敌方有效、而这条动作打自己"这种组合
  //    在数据上就说不出来了。
  // ======================================================================

  /** 载荷类型 → 人话（三组里每条动作的标题要用） */
  const PAYLOAD_LABEL: Readonly<Record<string, string>> = {
    damage: '造成伤害', heal: '治疗', attribute: '改属性', status: '挂状态',
    displacement: '位移', perception: '感知', spawn: '造实体',
  }

  /** 一份技能里**每一条动作**：它在哪（`effect` / `rules`）、路径前缀、动作本体 */
  interface ActionRef {
    /** 人话标题，例如 `固有效果「命中」的第 1 个动作` */
    title: string
    /** 数值叶子路径的前缀（`['effect', 0, 'then', 0]`） */
    prefix: Path
    action: Action
  }

  function allActions(): ActionRef[] {
    const s = draft
    if (s === undefined) return []
    const out: ActionRef[] = []
    ;(s.effect ?? []).forEach((e, i) => {
      const at = s.phases.find(p => p.id === e.at)
      e.then.forEach((a, j) => {
        out.push({ title: `固有效果「${at?.name ?? e.at}」的第 ${j + 1} 个动作`, prefix: ['effect', i, 'then', j], action: a })
      })
    })
    s.rules.forEach((r, i) => {
      r.then.forEach((a, j) => {
        out.push({ title: `规则「${r.id}」的第 ${j + 1} 个动作`, prefix: ['rules', i, 'then', j], action: a })
      })
    })
    return out
  }

  function actionTitle(ref: ActionRef): string {
    return `${ref.title} · ${PAYLOAD_LABEL[ref.action.payload?.kind ?? ''] ?? ref.action.payload?.kind ?? '?'}`
  }

  function payloadOf(ref: ActionRef): Action['payload'] { return ref.action.payload }

  /** 这一组里"不给拖"要能一眼看出来：按钮的 `disabled` + 整组头上的说明 */
  function choiceButtons(
    act: string, selected: readonly string[], options: readonly { value: string; label: string; tip: string }[],
    data: Record<string, string>, on: boolean,
  ): string {
    return `<div class="sk-choice">${options.map(o => {
      const isOn = selected.includes(o.value)
      const attrs = Object.entries(data).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('')
      return `<button class="sk-chip${isOn ? ' on' : ''}" data-act="${esc(act)}" data-v="${esc(o.value)}"${attrs}`
        + ` title="${esc(o.tip)}"${on ? '' : ' disabled'}>${esc(o.label)}</button>`
    }).join('')}</div>`
  }

  // ------------------------------------------------------------ ① 瞄准

  /**
   * ① **瞄准** —— 怎么选 / 对谁有效 / 只挑带某状态的目标 / 射程。
   *
   * ⚠ 这一组今天**一个变量都不进账**（`lookupTable` 里没有瞄准这一支）。
   *   静默不说的话，玩家会以为"选敌方"是免费或花了钱的 —— 两者都是猜。
   *   所以组头直接写那句 `UNPRICED_NOTE`。
   */
  function aimHtml(): string {
    const s = draft
    if (s === undefined) return ''
    const t = s.targeting
    const on = editable()
    const valid = t?.valid ?? []

    // 内容里出现过的、非保留字的那些标签（boss / undead…）也要能选 —— 但它们今天没内容用
    const extra = valid.filter(v => !RESERVED_VALID.some(r => r.value === v))
      .map(v => ({ value: v, label: validLabel(v), tip: '内容里在用的实体标签' }))
    const validOptions = [...RESERVED_VALID.map(r => ({ ...r, tip: '引擎的保留字（src/sim/targeting.ts 的 VALID_*）' })), ...extra]

    return `<div class="sk-card">
      <div class="sk-card-h">① 瞄准 —— 怎么选中人
        <span class="sk-card-n">现在：${esc(aimModeLabel(t?.mode))}</span></div>
      <div class="hint">${esc(UNPRICED_NOTE)}</div>
      <div class="sk-field">
        <div class="label"><span>怎么选</span><span>${esc(aimModeLabel(t?.mode))}</span></div>
        ${choiceButtons('aim-mode', t === undefined ? [] : [t.mode],
          AIM_MODES.map(m => ({ value: m.value, label: m.label, tip: m.tip })), {}, on)}
        <div class="hint">瞄准住在**技能**上（术式没有瞄准）；只有"鼠标方向 / 点地面"真的用那一个意图。</div>
      </div>
      <div class="sk-field">
        <div class="label"><span>对谁有效</span><span>${esc(valid.map(validLabel).join(' / ') || '（空 —— 谁都打不到）')}</span></div>
        ${choiceButtons('aim-valid', valid, validOptions, {}, on)}
        <div class="hint">这是一层标签过滤，和"怎么选"是两件事：用鼠标指向、但只对敌方有效 —— 指到队友身上就什么都不发生。</div>
      </div>
      <div class="sk-field">
        <div class="label"><span>只挑带某状态的目标</span><span>${esc(t?.requireStatusTag ?? '不限')}</span></div>
        <select data-act="aim-req"${on ? '' : ' disabled'}>
          <option value=""${t?.requireStatusTag === undefined ? ' selected' : ''}>不限（挑最近 / 锁定的那个）</option>
          ${[...new Set([...(host.statuses?.keys() ?? [])].flatMap(id => {
            const def = host.statuses?.get(id)
            return def === undefined ? [] : def.tags
          }))].sort().map(tag =>
            `<option value="${esc(tag)}"${t?.requireStatusTag === tag ? ' selected' : ''}>带「${esc(tag)}」标签的状态</option>`).join('')}
        </select>
        <div class="hint">「标记 · 瞬影」那类二段技能靠它：第二段要的是"我标过的那个人"，不是"现在最近的那个"。</div>
      </div>
      <div class="sk-field">
        <div class="label"><span>射程</span><span>${t?.range === undefined ? '没写' : `${fmt(t.range)} m`}</span></div>
        <input type="number" step="1" min="0" data-act="aim-range" value="${t?.range ?? ''}"
               placeholder="不写 = 用技能自己的默认"${on ? '' : ' disabled'}>
        <div class="hint">⚠ 射程**不在任何点表上**（账里没有这一格）⇒ 按死滑块铁律它不给"拖"，只能填数。</div>
      </div>
    </div>`
  }

  // ------------------------------------------------------------ ② 效果发生在哪里

  /**
   * ② **效果发生在哪里** —— 每条动作一个载体 + 形状参数。
   *
   * ⚠ 形状参数（半径 / 张角 / 长度 / 宽度 / 速度 / 存在时长）**是进账的**
   *   （`lookupTable` 里有 `…delivery.radius` 这些变量），所以它们照旧是点表控件 ——
   *   只是从"固有效果"那一堆里搬到了这一组。载体**种类**是枚举，不进账。
   */
  function carrierHtml(): string {
    const s = draft
    if (s === undefined) return ''
    const on = editable()
    const leaves = collectLeaves(s)
    const cards = allActions().map(ref => {
      const d = ref.action.delivery
      const shapes = leaves.filter(l =>
        l.path.length > ref.prefix.length
        && ref.prefix.every((seg, i) => l.path[i] === seg)
        && isDeliveryShapeLeaf(l.path))
      const shapeHtml = shapes.length === 0
        ? (d === undefined
          ? '<div class="hint">这条动作没有载体 —— 直接落在"这条动作作用在谁身上"那个目标上。</div>'
          : '<div class="hint">这个载体没有可调的形状参数。</div>')
        : shapes.map(l => leafRow(l)).join('')
      return `<div class="sk-act">
        <div class="sk-act-h">${esc(actionTitle(ref))}</div>
        <div class="sk-field">
          <div class="label"><span>载体</span><span>${esc(carrierLabel(d?.kind))}</span></div>
          ${choiceButtons('carrier-kind', d === undefined ? [''] : [d.kind],
            CARRIERS.map(c => ({ value: c.value, label: c.label, tip: c.tip })),
            { p: ref.prefix.join('.') }, on)}
        </div>
        ${shapeHtml}
      </div>`
    })
    return `<div class="sk-card">
      <div class="sk-card-h">② 效果发生在哪里
        <span class="sk-card-n">${cards.length} 条动作</span></div>
      <div class="hint">${esc(UNPRICED_NOTE)} —— 但下面的<b>形状参数是真的进账的</b>（表里有那一格）。</div>
      ${cards.length === 0 ? '<div class="hint">这个技能没有动作（它只有被动钩子）。</div>' : cards.join('')}
    </div>`
  }

  // ------------------------------------------------------------ ③ 宿主

  /**
   * ③ **宿主** —— 这条动作作用在谁身上 / 对谁有效 / 规则听谁的。
   *
   * ⚠ **动作级"对谁有效"默认折叠**（用户点名的用例是「无下限」：
   *   技能 `mode: 'self'`，但光环那条动作要打敌人）—— 绝大多数动作用不上它，
   *   摊开摆在那里会让人以为"每条动作都要选一次"。
   */
  function hostHtml(): string {
    const s = draft
    if (s === undefined) return ''
    const on = editable()
    const cards = allActions().map(ref => {
      const a = ref.action
      const valid = a.valid ?? []
      const tgt = typeof a.target === 'string' ? a.target : undefined
      // 规则（管线钩子）**听谁的** —— 内联状态里的钩子
      const hooks = (a.payload?.kind === 'status' ? a.payload.inline?.hooks ?? [] : [])
      const hookHtml = hooks.length === 0 ? '' : hooks.map((h, hi) => `<div class="sk-field">
          <div class="label"><span>规则听谁的（钩子 ${hi + 1} · ${esc(h.stage)}）</span><span>${esc(hookSideLabel(h.side))}</span></div>
          ${choiceButtons('hook-side', h.side === undefined ? [] : [h.side],
            HOOK_SIDES.map(x => ({ value: x.value, label: x.label, tip: x.tip })),
            { p: ref.prefix.join('.'), i: String(hi) }, on)}
        </div>`).join('')
      return `<div class="sk-act">
        <div class="sk-act-h">${esc(actionTitle(ref))}</div>
        <div class="sk-field">
          <div class="label"><span>作用在谁身上</span><span>${esc(hostTargetLabel(a.target))}</span></div>
          ${choiceButtons('host-target', tgt === undefined ? [] : [tgt],
            HOST_TARGETS.map(x => ({ value: x.value, label: x.label, tip: x.tip })),
            { p: ref.prefix.join('.') }, on)}
        </div>
        <details class="sk-fold">
          <summary>对谁有效（默认折叠 · 现在：${esc(valid.map(validLabel).join(' / ')) || '继承技能级'}）</summary>
          ${choiceButtons('host-valid', valid,
            RESERVED_VALID.map(r => ({ ...r, tip: '引擎的保留字（src/sim/targeting.ts 的 VALID_*）' })),
            { p: ref.prefix.join('.') }, on)}
          <div class="hint">不写就继承技能级瞄准的 valid。要覆盖才展开 —— 例如「无下限」技能自己是自我增益，但光环那条动作要打敌人。</div>
        </details>
        ${hookHtml}
      </div>`
    })
    return `<div class="sk-card">
      <div class="sk-card-h">③ 宿主
        <span class="sk-card-n">${cards.length} 条动作</span></div>
      <div class="hint">${esc(UNPRICED_NOTE)}（这一组里的枚举；动作里那些数值在②和下面那一堆里，照旧进账。）</div>
      ${cards.length === 0 ? '<div class="hint">这个技能没有动作（它只有被动钩子）。</div>' : cards.join('')}
    </div>`
  }

  // ------------------------------------------------------------ 数值叶子

  /**
   * 一个数值叶子的控件（点表 + 单位 + 档位刻度）。
   *
   * ⚠⚠ **死滑块铁律**（用户 2026-09-30）：账上这一项**整行同值**（校验器报
   *   `LOOKUP_DEAD_KNOB`）或者**根本没这一项** ⇒ **不给拖**，并把原因写出来。
   *   能拖的必须真的动账 —— "拖了半天账上不动"是这一片要杀的病。
   */
  function leafRow(l: NumLeaf): string {
    const variable = l.path.join('.')
    const state = knobState(lookupRow(variable))
    const v = getByPath(draft as Skill, l.path) ?? l.value
    const withUnit = (n: number): string => l.unit === '' ? fmt(n) : `${fmt(n)} ${l.unit}`
    const label = `${esc(l.label)}${l.offGrid ? ' <span class="offgrid" title="这个值不在推荐档位上，拖走就回不来了">·</span>' : ''}`

    if (state !== 'live') {
      // 不给拖 —— 但**数值照样看得见**（它是内容的一部分，藏起来更糟）
      return `<div class="sk-field sk-dead">
        <div class="label"><span>${label} <span class="sk-dead-tag">不给拖</span></span><span>${withUnit(v)}</span></div>
        <div class="hint">${esc(knobReason(state))}</div>
      </div>`
    }

    const id = `leaf-${l.path.join('_')}`
    const ticks = l.values.map((_, i) => `<option value="${i}"></option>`).join('')
    return `<div class="sk-field">
      <div class="label"><span>${label}</span><span>${withUnit(v)}</span></div>
      <input type="range" data-path="${variable}" list="${id}"
             min="0" max="${l.values.length - 1}" step="1" value="${l.index}"
             ${editable() ? '' : 'disabled'}>
      <datalist id="${id}">${ticks}</datalist>
      <div class="scale"><span>${withUnit(l.values[0] ?? v)}</span><span>${withUnit(l.values[l.values.length - 1] ?? v)}</span></div>
      ${l.hint !== undefined ? `<div class="hint">${esc(l.hint)}</div>` : ''}
    </div>`
  }

  // ------------------------------------------------------------ 阶段时长（四档）

  /**
   * 一个阶段的**时长控件** —— 用户 2026-09-21 定死的形状：
   * **无 / 1× / 3× / 9×** 四档选择（不是线性滑块），外加**单独的**蓄力那一档。
   *
   * ⚠ 三处细节，错了都不报警：
   *   1. `1×` 那一档的标签写「默认」（它就是中性点，账上 0 点）；
   *   2. `-1`（蓄力哨兵）**和「无」是两档**（数据上是两个不同的数）；
   *   3. `3×`/`9×` 的秒数按**这个技能自己的**出厂时长算（不是全局起点值）。
   *
   * ⚠ 每一档右边那个数是**这一档值多少点**，来源有两条（2026-09-30 日志 63）：
   *   **倍数档走表**（`tierTables.phaseDurationPoints`，含按技能覆盖）、
   *   **绝对秒数走 `lookupTable` 的格**（表外取值 / 蓄力那一档走这条）。
   *   两条都问不出来才**置灰不给点**（死滑块铁律）。
   *
   *   ⚠ 出厂内容实测（58 个阶段，日志 63 之后）：四档在**定价路径**上都是 57/58
   *   （唯一不在轴上的那一段出厂就是蓄力 —— 它没有"1×"可当基准）。
   *   ⚠ 日志 63 **之前**只有 `1×` / `蓄力` 是 58/58（`3×` 16/58、`9×` 0/58、
   *   `无` 3/58），因为那时只认 `lookupTable` 里"恰好有那一格"的绝对秒数。
   */
  function phaseTierHtml(index: number, factory: number): string {
    const s = draft
    if (s === undefined) return ''
    const phase = s.phases[index]
    const cur = phase?.duration ?? factory
    const tiers = phaseTiers(index, factory)
    const table = tierTableOf(options, TIER_TABLE_PHASE_DURATION)
    const on = editable()

    const buttons = tiers.map(t => {
      const isOn = Math.abs(t.seconds - cur) < 1e-9
      // ⚠ 倍数档查表、绝对秒数查格 —— 和 `phaseTiers` 的 `available` 同一个函数
      const price = phaseTierPrice(index, factory, t.seconds)
      const design = tierPointsForSkill(table, t.tier, ledgerBaseId())
      const tierPrice = phaseDurationTierPriceOf(factory, t.seconds, options, ledgerBaseId())
      const why = t.available
        ? (tierPrice === undefined
          ? `账上这一格（绝对秒数）：${price === undefined ? '—' : price} 点`
          : `倍数档查表：${String(tierPrice.tier)}× → ${String(price)} 点`)
        : `⚠ 账上没有这一档（${fmt(t.seconds)} s）：选它点数不动 ⇒ 不给点。`
          + `（四档的**设计价**在 tierTables.phaseDurationPoints：${t.tier} → ${design ?? '—'} 点）`
      const cls = `sk-tier${isOn ? ' on' : ''}${t.available ? '' : ' off'}`
      return `<button class="${cls}" data-act="tier" data-i="${index}" data-v="${t.seconds}"
        title="${esc(why)}"${t.available && on ? '' : ' disabled'}>
        <span class="sk-tier-l">${esc(t.label)}${t.neutral ? '<span class="sk-default">默认</span>' : ''}</span>
        <span class="sk-tier-s">${t.seconds < 0 ? '按住键' : `${fmt(t.seconds)} s`}</span>
        <span class="sk-tier-p">${t.available ? (price === undefined ? '—' : (price > 0 ? `+${price}` : String(price))) : '账上无格'}</span>
      </button>`
    }).join('')

    const missing = tiers.filter(t => !t.available).map(t => t.label).join(' / ')
    return `<div class="sk-field sk-tierrow">
      <div class="label">
        <span>「${esc(phase?.name ?? phase?.id ?? index)}」时长</span>
        <span>${cur < 0 ? '按住键（蓄力）' : `${fmt(cur)} s`}</span>
      </div>
      <div class="sk-tiers">${buttons}</div>
      <div class="hint">
        四档 = <b>无 / 1× / 3× / 9×</b>，相对<b>这个技能自己的出厂时长 ${fmt(factory)} s</b>
        （不是全局起点值）；<b>1× 是默认</b>（账上 0 点）。
        ⚠ <b>蓄力（−1）是单独一档</b>：它的意思是"时长由玩家按住键控制"，
        和「无」（0 秒 = 这一段没有时长）是两件事。
        ${missing === '' ? '' : `<br>⚠ 今天账上没有这几档：<b>${esc(missing)}</b> —— 置灰了（拖了不动就是死滑块）。`
          + '⚠ 若这几档里有 <b>3× / 9× / 无</b>，说明这一段<b>不在倍数轴上</b>'
          + '（出厂那一头不是"固定的秒数"，例如它出厂就是蓄力）—— 那种段没有"1×"可当基准。'}
      </div>
    </div>`
  }

  // ------------------------------------------------------------ 顶栏 / 底栏

  /**
   * 这个技能里**有几个数值真的能动账、几个不给拖**。
   *
   * ⚠ 判据和编辑页里的控件**同一处**（`knobState`）—— 两处各写一遍的话，
   *   "详情页说 8 个能动、编辑页里只有 5 个滑块"这种事没人会发现。
   */
  function editableSummary(skill: Skill): string {
    const baseId = skill.basedOn ?? skill.id
    const part = options.lookupTable?.[baseId]
    let live = 0
    let frozen = 0
    for (const l of collectLeaves(skill)) {
      if (knobState(part?.[l.path.join('.')]) === 'live') live++
      else frozen++
    }
    return `${live} 个可改 · ${frozen} 个不给拖`
  }

  /** 编辑页顶栏（照模板 `.mainhead`：名字 · 副标题 · 瞄准） */
  function editHead(): string {
    const s = draft
    if (s === undefined) return ''
    const form = formOf(s)
    const ro = s.readonly === true
    const mine = isCustom(currentId)
    const tpl = s.basedOn === undefined ? undefined : skillOf(s.basedOn)
    const sub = ro
      ? '武器技能 · 只读（数值由武器属性代入）'
      : isNew
        ? `还没保存的新技能 · 模板：${tpl?.name ?? '?'}`
        : mine
          ? '我的技能 · 就地改（所有用到它的术式一起变）'
          : '基础技能 · 只读模板'
    return `<div class="sk-edithead">
      <span class="sk-t">${esc(s.name)}${ro ? '（原型）' : ''}${isNew ? '（草稿）' : ''}</span>
      <span class="sk-sub">${esc(sub)}</span>
      <div class="sk-spacer"></div>
      <span class="sk-sub">形态：<b>${esc(FORM_LABEL[form])}</b></span>
      <span class="sk-sub">瞄准：${esc(aimModeLabel(s.targeting?.mode))}</span>
    </div>
    <div class="hint sk-formwhy">形态是<b>机制事实</b>（${esc(formWhy(form))}）⇒ 界面上<b>只读</b>：要改形态就是改阶段。</div>
    ${form === 'passive' ? `<div class="hint sk-perm">${esc(PERMANENT_NOTE)}</div>` : ''}
    ${ro ? `<div class="sk-warn">${readonlyReason()}</div>` : ''}`
  }

  /** 编辑页底栏（照模板 `.foot`：说明 + 保存 / 另存为新技能 / 返回） */
  function footHtml(): string {
    const ro = draft?.readonly === true
    const note = ro
      ? '武器技能只读：这里没有"保存"，也不能改数值 —— 想改强度去改武器。'
      : isNew
        ? '这是还没进库的草稿：按「保存」它才进我的技能库。'
        : isCustom(currentId)
          ? '改它 → 所有用到它的术式一起变。'
          : '这是模板：调完只能「另存为新技能」。'
    return `<div class="sk-foot">
      <span class="sk-note">${esc(note)}</span>
      <div class="sk-spacer"></div>
      <button data-act="save"${isNew || isCustom(currentId) ? '' : ' disabled'}>保存</button>
      <button class="sk-primary" data-act="saveAs"${ro ? ' disabled' : ''}>另存为新技能</button>
      <button data-act="back">✕ 返回技能库</button>
    </div>`
  }

  // ------------------------------------------------------------- 屏 2：编辑区

  /**
   * 编辑区这一屏。
   *
   * ⚠ 参数名就叫 `draft`，**故意**让它遮蔽外面那个可变的 `draft`：
   *   这样函数体里每一处 `draft.xxx` 都一定是"有值的草稿"（TypeScript 的收窄
   *   跨不过函数边界 —— 外面那个 `Skill | undefined` 会在这一整段里全是报错）。
   *   传进来的和外面指的是**同一个对象**，所以改它照样改到草稿。
   */
  function renderEdit(draft: Skill): void {
    const priced = ledger()
    const total = priced.total
    const tol = options.tolerance ?? 0
    /*
     * ⚠ **只有自定义技能（和还没保存的草稿）能改**（玩家 2026-09-21 定）：
     *   基础技能是模板，不该被人改 —— 想改就"创造一个技能" → 编辑 → 保存。
     *   武器技能（`readonly`）连滑块都不给。
     *   `touched()` 那边也拦了一道（置灰只是表面）。
     */
    const canEdit = editable()
    // ⚠ 草稿还没进库时没有文件名可言（id 是空的）—— 报错里给它一个临时名字
    const report = validateSkill(
      `content/skills/${draft.id === '' ? (draft.basedOn ?? 'draft') : shortName(draft.id)}.json`,
      draft, balance)

    const leaves = collectLeaves(draft)
    /*
     * ⚠ **四档时长 / 载体形状 / 冷却 这三类不进通用列表**：
     *   它们各有自己的控件（阶段那一块的 `phaseTierHtml` / ② 那一组的 `carrierHtml` /
     *   `coolDownTiming`）。同一个数字出现在两处，玩家会以为"两个地方各有一个"。
     */
    const byGroup = new Map<string, NumLeaf[]>()
    for (const l of leaves) {
      if (isCooldownPath(l.path) || isPhaseDurationLeaf(l.path)) continue
      if (isDeliveryShapeLeaf(l.path)) continue
      const arr = byGroup.get(l.group) ?? []
      arr.push(l)
      byGroup.set(l.group, arr)
    }

    const parts: string[] = []

    /*
     * ⚠ 2026-10-07（编辑器 UI 第二片）：编辑页整屏套一层 `.sk-editscreen`，
     *   里面**一张卡一块**（`mountBlock` 的 key 就是"一块"的边界）。
     *   照模板 `#editSkill` 的形状：`.main` 一列 = 顶栏 + `.grow` 滚动区 + `.foot`。
     *   下面每一处 `flush(key)` 的 key 都对应**一张完整的卡** ——
     *   卡不闭合的话 `mountBlock` 解析出来的根元素就不是那张卡，
     *   重画时会变成"一张卡套一张卡"（越挂越深，界面上一眼能看出来）。
     */
    parts.push('<div class="sk-editscreen">')

    /*
     * ---- 顶栏（照模板 `#editSkill` 的 `.mainhead`）----
     *
     * ⚠ 玩家 2026-09-21 要的：「技能要在编辑器中有技能介绍」。
     *   之前这一页一进来就是点数条和一堆滑块 —— 玩家看得到"有哪些数字"，
     *   看不到"这个技能是干什么的"。
     *
     *   所以介绍由**数据生成**（不是手写的 note）：
     *     一句话：它做什么（每条规则一句人话）
     *     一条时间线：前摇 0.3 秒 → 命中 → 后摇 0.2 秒，以及代价花在哪一段
     *   改了数值它自己跟着变 —— 和别的说明是同一条规矩。
     */
    parts.push(editHead())
    parts.push(introHtml())

    // ---- 副本属于哪份术式（第一件事，因为它决定"改了写到哪儿"）----
    // ---- 这是哪一库的、能做什么（第一件事，因为它决定"改了会发生什么"）----
    parts.push(libraryRow())

    // ---- 它挂在哪个术式上 ----
    const techniqueNames = host.usedBy.get(currentId ?? draft.id) ?? []
    const usage = draft.readonly === true
      ? ''
      : techniqueNames.length === 0
        ? '<span class="bad">没有任何术式用到这个技能 —— 得先把它排进一个术式才能在场上放出来</span>'
        : `<span class="dim">被这些术式用到：</span>${techniqueNames.map(esc).join('、')}`
    if (usage !== '') parts.push(`<div class="sk-card"><div class="hint">${usage}</div></div>`)

    // ---- 点数条：编辑器的主视觉 ----
    const scale = Math.max(12, Math.abs(total) * 2.2)
    const gainPct = total > 0 ? Math.min(50, (total / scale) * 50) : 0
    const costPct = total < 0 ? Math.min(50, (-total / scale) * 50) : 0
    const balanced = Math.abs(total) <= 1e-6
    /*
     * ⚠ 报的是"**你改了多少**"，不是"这个技能值多少"（见 `refreshLive`）。
     *   技能这一层仍然不判对错 —— 配平的判据在**术式**上。
     */
    const verdict = balanced
      ? (draft.basedOn === undefined ? '出厂技能：0 点' : '和模板一样：0 点')
      : total < 0
        ? `比模板强 ${Math.abs(total)} 点 —— 要靠别的技能来付`
        : `比模板弱 ${total} 点 —— 提供这么多额度`

    /*
     * ⚠ 这里原来有一块"出厂就负债"的说明（`factoryDebt`）。
     *   那个标记 2026-09-21 删掉了：宗旨没有例外，出厂内容全是 0 点。
     *   现在**一个技能都不会因为"出厂"而吃血契** —— 想吃血契就把变体改强，
     *   让那份术式的合计变成负的（那才是负值术式）。
     */

    /*
     * ⚠ 这块上次没说清楚"点数是什么"，玩家直接问了。
     *   现在把它的定义、方向、算法都写在这一行下面。
     *
     * 拖动滑块时这几个节点会被 `refreshLive()` 就地更新 ——
     * 整块重画会让滑块失去焦点、拖不动。
     */
    /**
     * 把"攒到现在的那一段 html"挂成一块。
     *
     * ⚠ 用"攒到边界就挂"而不是重排那两百行：改动小、边界一眼看得见。
     *   函数声明会提升，所以写在这儿、上面下面都能调。
     */
    function flush(key: string): void {
      if (parts.length === 0) return
      // ⚠ 不是编辑页那一屏时，整块套一层"藏着"的壳（理由见 `renderInner`）
      mountBlock(body, key, hideUnless(view === 'edit', parts.join('')))
      parts.length = 0
    }

    flush('head')
    parts.push(`
      <div id="points" class="sk-card">
        <div class="bar">
          <div class="gain" id="pointsGain" style="width:${gainPct}%"></div>
          <div class="cost" id="pointsCost" style="width:${costPct}%"></div>
        </div>
        <div class="meta">
          <span id="pointsVerdict" class="ok">${verdict}</span>
          <span class="dim" id="pointsTotal">相对模板 ${total > 0 ? '+' : ''}${total}</span>
        </div>
        <div class="hint">
          <b>账算的是"你改了多少"</b>，不是"这个技能值多少"：
          <b>你拿到的那个版本（模板 / 出厂版）就是 0 点</b>（宗旨：默认值下配平为 0）。
          <br><b>负数 = 你花的额度比模板多</b>（伤害调高、前摇调短）；
          <b>正数 = 你省下来的额度</b>（冷却调长、能量消耗调高、卖规则位）。
          <br>⚠ <b>技能不必自己配平</b> —— 一段改得很凶的爆发和一段改得很弱的收招
          都是合法的技能。<b>必须配平到 0 的是术式</b>：里面所有改动加起来要收支相抵。
          ⚠ <b>技能是全局的</b>：你改的东西在**所有**用到它的术式里都生效 ——
          所以这里一改，那几份术式的账会一起变。
          <br>它全是<b>算出来的</b>：改上面的数值，这里立刻跟着变。
        </div>
      </div>
    `)

    // ---- 三组控件（用户定的口径：瞄准 / 效果发生在哪里 / 宿主）----
    //
    // ⚠ 顺序就是用户报的口径顺序，而且**它们是三组、不是一组**（见上面那段长注释）。
    flush('points')
    parts.push(aimHtml())
    parts.push(carrierHtml())
    parts.push(hostHtml())
    flush('groups')

    /*
     * ---- 固有效果：**这个技能是什么** ----
     *
     * ⚠ 玩家 2026-09-21 第 1 条：
     *   > 技能本身的效果**不计入规则栏中**，也不具有点数盈亏。
     *
     *   所以它是**单独一块**，排在规则前面。区别是"机制"和"反应"：
     *   效果 = 时间轴走到这一段就发生（挥砍造成伤害、传送、竖一堵墙）；
     *   规则 = 额外做了什么（命中时回能量、击杀时刷新冷却）。
     *
     * ⚠ 这里**不给"加一条效果"** —— 效果是这个技能的定义，
     *   加一套新机制是写内容，不是调数值。玩家能改的是它的**数值**
     *   （下面「固有效果」那一组滑块）。
     */
    parts.push(`<div class="sk-card">
      <div class="sk-card-h">固有效果（${(draft.effect ?? []).length}）
        <span class="sk-card-n">这个技能「是什么」</span></div>
      <div class="hint">这个技能<b>是什么</b> —— 时间轴走到这几段就发生。
        <b>改它的数值照常计点数</b>（偏离出厂值才算）。</div>
    `)
    ;(draft.effect ?? []).forEach((e, i) => {
      // ⚠ 折成规则再渲染：说明、点数、时机都是同一套代码（见 src/effects.ts）
      // ⚠ 第三个参数是**账里的变量前缀** —— 那颗点数徽章要按它查表（整数账）
      parts.push(ruleRow(effectAsRule(e, i), `effect-${i}`, `effect.${i}.`))
    })
    parts.push('</div>')

    // ---- 规则列表：主体交互 ----
    parts.push(`<div class="sk-card">
      <div class="sk-card-h">规则（${draft.rules.length} / ${draft.ruleSlots}）
        <span class="sk-card-n">它「额外做了什么」</span></div>
      <div class="hint">这里是技能<b>额外做了什么</b>：挂在某个时机上的行为与反应。
        <b>效果是负的（消耗额度），代价是正的（提供额度）</b></div>
    `)
    const sorted = [...draft.rules].sort((a, b) => a.order - b.order)
    for (const r of sorted) {
      // ⚠ 前缀按**数组下标**（账里的变量键就是 `rules.N.…`），不是 `r.id`
      parts.push(ruleRow(r, `rule-${r.id}`, `rules.${draft.rules.indexOf(r)}.`))
    }
    parts.push('<div class="sk-choice">')
    for (const t of TEMPLATES) {
      const cls = t.kind === 'effect' ? 'gain' : 'cost'
      parts.push(`<button class="${cls}" data-add="${t.id}">${esc(t.label)}</button>`)
    }
    parts.push('</div></div>')

    // ---- 明细 ----
    flush('rules')
    parts.push('<div class="sk-card"><div class="sk-card-h">点数明细</div>')
    if (priced.entries.length === 0) {
      parts.push('<div class="sk-field"><div class="label"><span class="dim">'
        + '（和出厂版本一模一样 —— 0 点）</span></div></div>')
    }
    for (const e of priced.entries) {
      const c = e.points > 0 ? '#3fb950' : e.points < 0 ? '#f85149' : '#6e7681'
      const from = e.from === 'phase' ? '阶段' : e.from === 'ruleSlots' ? '规则位' : '规则'
      parts.push('<div class="sk-field"><div class="label">'
        + `<span class="dim">${esc(from)} · ${esc(e.label)}</span>`
        + `<span style="color:${c}">${e.points > 0 ? '+' : ''}${e.points}</span>`
        + '</div></div>')
    }
    parts.push('</div>')

    // ---- 冷却：**技能唯一的属性**（单独一块，别的滑块里不再出现它）----
    // 有专门的控件（`coolDownTiming`）就不要再让它出现在通用滑块列表里 ——
    // 同一个数字出现在两处，玩家会以为"两个地方各有一个冷却"。

    // ---- 数值滑块 ----
    /*
     * ⚠ 滑块是**点表**，不是连续区间。
     *
     *   第一版是 min/max/step：0~300 的伤害有 300 个取值，拖一格差 1 点，
     *   既调不准也没有"选择"的感觉。现在大部分三五个取值，最多九个 ——
     *   **每一次拖动都是一次决策**，而且每个档位之间都有可感知的差别。
     *
     * 刻度线用 datalist 画出来，玩家能一眼看到有哪几档。
     */
    for (const [group, list] of byGroup) {
      if (list.length === 0) continue
      parts.push(`<div class="sk-card"><div class="sk-card-h">${esc(group)}
        <span class="sk-card-n">${list.length} 项数值</span></div>`)
      for (const leaf of list) parts.push(leafRow(leaf))
      parts.push('</div>')
    }

    // ---- 阶段：**四档时长** + 打断等级 + 占用 ----
    /*
     * ⚠ 打断是**三档**，不是勾选框。
     *
     *   玩家原话：「不应该所有技能都会被伤害打断，应该分成
     *   被伤害打断、被控制打断、无法打断三个等级。」
     *
     *   只有两档的时候，"扛得住小伤害、但吃硬控"的释放帧表达不出来 ——
     *   而那恰恰是动作游戏里最常见的那种帧。
     */
    flush('leaves')
    parts.push('<div class="sk-card"><div class="sk-card-h">阶段（时间轴）</div>')
    parts.push('<div class="hint">每一段三件事：<b>时长</b>（四档选择）、'
      + '<b>挨不挨打断</b>、<b>占不占用施法者</b>。'
      + '<br>越扛得住打断，越值钱（消耗越多额度）—— 释放帧通常是「只被控制打断」，'
      + '小伤害打断它会让近战没法玩。</div>')
    /*
     * ⚠ 出厂时长必须从**模板那一份**读：账和四档都是"相对这个技能自己的出厂值"，
     *   拿草稿现在的值当基准的话，第一次改完 3×，第二次就变成 9×（1× 也跟着漂）。
     *   这正是"变体的账对着 `basedOn` 算"的同一条规矩。
     */
    const factory = templateOf(draft)
    draft.phases.forEach((p, i) => {
      const name = esc(p.name ?? p.id)
      const level = p.interrupt ?? 'damage'
      const option = (v: InterruptLevel, label: string, tip: string): string =>
        `<label class="check" title="${esc(tip)}">`
        + `<input type="radio" name="interrupt-${i}" data-interrupt="${v}" data-index="${i}" ${level === v ? 'checked' : ''}${editable() ? '' : ' disabled'}>`
        + `<span>${label}</span></label>`

      parts.push(`<div class="phase-block"><div class="phase-name">「${name}」</div>`)
      parts.push(phaseTierHtml(i, factory?.phases[i]?.duration ?? p.duration))
      parts.push(option('damage', '挨打就断', '受到任何伤害都会被打断'))
      parts.push(option('control', '只被控制打断', '挨打不断，但被眩晕/沉默会断'))
      parts.push(option('none', '无法打断', '霸体帧，什么都不打断'))
      parts.push(`
        <label class="check">
          <input type="checkbox" data-flag="occupiesCaster" data-index="${i}" ${p.occupiesCaster ? 'checked' : ''}${editable() ? '' : ' disabled'}>
          <span>占用施法者（持续技）</span>
        </label>
      `)
      parts.push('</div>')
    })
    parts.push('</div>')

    parts.push(coolDownTiming())

    // ---- 校验 ----
    const errors = report.issues.filter(i => i.level === 'error')
    const warns = report.issues.filter(i => i.level === 'warning')
    flush('phases')
    parts.push('<div class="sk-card"><div class="sk-card-h">校验</div>')
    if (errors.length === 0 && warns.length === 0) {
      parts.push('<div class="issue ok">✓ 全部通过</div>')
    }
    for (const i of [...errors, ...warns]) {
      const tone = i.level === 'error' ? 'bad' : 'warn'
      parts.push(`
        <div class="issue">
          <span class="${tone}">${i.level === 'error' ? '✗' : '!'}</span>
          <span class="code">[${i.code}]</span>
          <span class="path">${esc(i.path)}</span>
          <span class="msg">${esc(i.message)}</span>
          ${i.hint !== undefined ? `<span class="hint">→ ${esc(i.hint)}</span>` : ''}
        </div>
      `)
    }
    parts.push('</div>')

    // ---- 存回去 ----
    flush('issues')
    parts.push(`
      <div class="sk-card">
        <div class="sk-card-h">存回去</div>
        <div class="hint">下载的文件放回 <code>content/skills/</code>，命令行和网页都会加载它</div>
        <div class="sk-choice">
          <button data-act="download">下载 JSON</button>
          <button data-act="copy">复制 JSON</button>
          <button data-act="json">${showJson ? '收起' : '看一眼'}</button>
          <button data-act="revert">还原</button>
        </div>
        ${showJson ? `<textarea readonly>${esc(JSON.stringify(draft, null, 2))}</textarea>` : ''}
      </div>
    `)

    flush('export')

    /*
     * ---- 底栏（照模板 `.foot`）----
     *
     * ⚠ **`</div>` 必须留在这一块里**：它关的是开头那个 `.sk-editscreen`
     *   （整屏那一层）。单独挂一个"只有一个结束标签"的块是不行的 ——
     *   `mountBlock` 要把 html 解析成一个元素，光有 `</div>` 解析不出东西
     *   （会被当成假 DOM 而走降级那条路）。所以整屏的收尾跟着最后一块走。
     */
    parts.push(footHtml())
    parts.push('</div>')
    flush('foot')

    /*
     * 渲染 = **一块一块挂**（玩家 2026-09-21 定的"结构固定 + 只更新变化的数"）。
     *
     * ⚠ 以前是 `body.innerHTML = parts.join('')` —— 拼一大串一次写进去，
     *   于是"改一个名字"会把整页（含滑块、`<details>`、展开状态）全部重建：
     *   `<details open>` 合上、CSS transition 从头开始、拖到一半的东西被换掉。
     *
     *   `flush(key)` 在**边界**上把攒的那一段挂成一块：块的内容一模一样时
     *   `mountBlock` 一个字都不碰 ✓（边界见 `docs/editor-ui-brief.md` 的块地图）。
     *
     * ⚠ 这一片新加的块：`groups`（三组控件）和 `foot`（底栏）。
     *   `endBlocks` 的清单必须**跟着改** —— 不列的话 `endBlocks` 会把它们当
     *   "这次没挂的块"删掉（现象：界面上少了三组控件，而且只有切页之后才复现）。
     */
    endBlocks(body, ['sk-libpage', 'head', 'points', 'groups', 'rules', 'leaves', 'phases', 'issues', 'export', 'foot'])
    wire()
  }

  // ---------------------------------------------------------------- 交互

  /** 数组里加 / 去掉一个值（`valid` 那种多选） */
  function toggleIn(list: string[], v: string): void {
    if (v === '') return
    const i = list.indexOf(v)
    if (i >= 0) list.splice(i, 1)
    else list.push(v)
  }

  /**
   * 按 `data-p`（`effect.0.then.0` 这种路径）找回**那一条动作**。
   *
   * ⚠ 三组控件的第二、三组是**逐条动作**的，所以按钮上带的是动作的路径前缀，
   *   不是下标 —— 下标会在"删掉一条规则"之后指到别人身上。
   */
  function actionAt(prefix: string): Action | undefined {
    const segs = prefix.split('.')
    const s = draft
    if (s === undefined) return undefined
    const container = segs[0] === 'effect'
      ? (s.effect ?? [])[Number(segs[1])]?.then
      : segs[0] === 'rules' ? s.rules[Number(segs[1])]?.then : undefined
    return container?.[Number(segs[3])]
  }

  /** 改一条动作（② / ③ 那一组的所有旋钮都走它） */
  function withAction(el: HTMLElement, fn: (a: Action) => void): void {
    if (!editable()) return
    const a = actionAt(el.dataset['p'] ?? '')
    if (a === undefined) return
    fn(a)
    touched()
    render()
  }

  /** 改技能自己（① 那一组） */
  function applyToggle(fn: (s: Skill) => void): void {
    if (draft === undefined || !editable()) return
    fn(draft)
    touched()
    render()
  }

  /**
   * 四档时长：把选中的那一档写进 `phases[i].duration`。
   *
   * ⚠ **写进去的是秒数，不是倍数**（倍数只是"相对这个技能自己的出厂时长"的算法）：
   *   账走的是 `lookupTable` 的**绝对秒数**格（`String(seconds)`），
   *   写倍数进去的话账一格都查不到（症状：拖了不动 + 一条 `⚠ 表外取值`）。
   */
  function applyTier(el: HTMLButtonElement): void {
    if (draft === undefined || !editable()) return
    const i = Number(el.dataset['i'])
    const seconds = Number(el.dataset['v'])
    const p = draft.phases[i]
    if (p === undefined || !Number.isFinite(seconds)) return
    p.duration = seconds
    touched()
    render()
    const name = p.name ?? p.id
    flash(seconds < 0
      ? `「${name}」改成蓄力：时长由玩家按住键控制`
      : seconds === 0
        ? `「${name}」改成「无」：这一段没有时长`
        : `「${name}」时长改成 ${fmt(seconds)} 秒`)
  }

  function wire(): void {
    // ---- 滑块（点表）----
    for (const el of body.querySelectorAll<HTMLInputElement>('input[type=range]')) {
      /*
       * ⚠ 滑块的 value 是**下标**，不是数值本身。
       *
       *   点表里的档位是不均匀的（伤害 5 / 10 / 15 / 20 / 30 / 50…），
       *   用 `min/max/step` 表达不了。所以滑块在 0..n-1 上滑动，
       *   再去 `leaf.values` 里取值。
       *
       *   下标 → 数值的映射要在**每次 input 时重新读**：内容可能被
       *   上一次编辑改过，缓存的表会指到别的档位上去。
       */
      const readValues = (): number[] => {
        if (draft === undefined) return []
        const path = (el.dataset['path'] ?? '').split('.')
          .map(s => (/^\d+$/.test(s) ? Number(s) : s))
        const leaf = collectLeaves(draft).find(l => l.path.join('.') === path.join('.'))
        return leaf?.values ?? []
      }

      el.addEventListener('input', () => {
        if (draft === undefined) return
        const path = (el.dataset['path'] ?? '').split('.')
          .map(s => (/^\d+$/.test(s) ? Number(s) : s))

        const values = readValues()
        const picked = values[Number(el.value)]
        if (picked === undefined) return

        setByPath(draft, path, picked)

        // 数字显示跟着动。⚠ 显示的是**数值 + 单位**，不是滑块下标
        const valueLabel = el.previousElementSibling?.querySelector('span:last-child')
        if (valueLabel !== null && valueLabel !== undefined) {
          const unit = collectLeaves(draft).find(l => l.path.join('.') === path.join('.'))?.unit ?? ''
          valueLabel.textContent = unit === '' ? fmt(picked) : `${fmt(picked)} ${unit}`
        }

        /*
         * 说明和点数也要跟着动。
         *
         * 玩家报的就是这个：「命中时回复 8 点生命」，把 8 调成 20 之后
         * 那句话还写着 8。现在那句话是**从数据生成的**，
         * 所以它一定跟着变 —— 这里是让它当场变的地方。
         *
         * ⚠ 这里**不落库**（玩家 2026-09-21 定的流程：改的是草稿，
         *   按「保存」才进库）。只标脏 + 就地刷新数字。
         */
        touched()
      })

      // 松开之后再整块重画，把明细、校验、档位表都刷新出来
      el.addEventListener('change', () => render())
    }

    // ---- 阶段开关 ----
    // ---- 阶段开关（占用施法者）----
    // 打断等级是单选的，在下面单独处理
    for (const el of body.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) {
      el.addEventListener('change', () => {
        if (draft === undefined) return
        const phase = draft.phases[Number(el.dataset['index'])]
        if (phase === undefined) return
        if (el.dataset['flag'] === 'occupiesCaster') phase.occupiesCaster = el.checked
        touched()
        render()
      })
    }

    // ---- 打断等级（单选）----
    for (const el of body.querySelectorAll<HTMLInputElement>('input[data-interrupt]')) {
      el.addEventListener('change', () => {
        if (draft === undefined || !el.checked) return
        const p = draft.phases[Number(el.dataset['index'])]
        const level = el.dataset['interrupt'] as InterruptLevel | undefined
        if (p === undefined || level === undefined) return
        p.interrupt = level
        touched()
        render()
      })
    }

    // ---- 冷却时机（把 cost.cooldown 搬到选中的阶段）----
    for (const el of body.querySelectorAll<HTMLButtonElement>('button[data-cd-at]')) {
      el.addEventListener('click', () => {
        if (draft === undefined) return
        const target = Number(el.dataset['cdAt'])

        // 先把冷却从旧位置摘下来（保留秒数；没有过就默认 3 秒）
        const from = cooldownPhase()
        const seconds = from >= 0 ? draft.phases[from]?.cost?.cooldown ?? 3 : 3
        if (from >= 0) {
          const old = draft.phases[from]
          if (old?.cost !== undefined) {
            const { cooldown: _drop, ...rest } = old.cost
            void _drop
            old.cost = Object.keys(rest).length > 0 ? rest : undefined
          }
        }

        if (target >= 0) {
          const p = draft.phases[target]
          if (p !== undefined) p.cost = { ...(p.cost ?? {}), cooldown: seconds }
        }
        touched()
        render()
        const roles: Record<number, string> = {}
        for (const r of phaseRoles()) roles[r.index] = r.role
        flash(target < 0
          ? '去掉了冷却'
          : `冷却从${roles[target] === 'windup' ? '前摇' : roles[target] === 'release' ? '释放' : '后摇'}开始走`)
      })
    }

    // ---- 冷却时长 ----
    for (const el of body.querySelectorAll<HTMLInputElement>('input[data-cd-seconds]')) {
      el.addEventListener('input', () => {
        if (draft === undefined) return
        const at = cooldownPhase()
        const p = draft.phases[at]
        if (p === undefined) return
        const leaves = collectLeaves(draft).find(l => l.path[l.path.length - 1] === 'cooldown')?.values
          ?? [1, 2, 3, 8, 20]
        const picked = leaves[Number(el.value)]
        if (picked === undefined) return
        p.cost = { ...(p.cost ?? {}), cooldown: picked }

        const label = el.previousElementSibling?.querySelector('span:last-child')
        if (label !== null && label !== undefined) label.textContent = `${fmt(picked)} s`

        touched()
      })
      el.addEventListener('change', () => render())
    }

    // ---- 删规则 ----
    for (const el of body.querySelectorAll<HTMLButtonElement>('button[data-del]')) {
      el.addEventListener('click', () => {
        if (draft === undefined) return
        const id = el.dataset['del']
        draft.rules = draft.rules.filter(r => r.id !== id)
        // order 重新排一遍，不然会留下空档（校验器会警告）
        ;[...draft.rules].sort((a, b) => a.order - b.order)
          .forEach((r, i) => { r.order = i })
        touched()
        render()
      })
    }

    // ---- 加规则 ----
    for (const el of body.querySelectorAll<HTMLButtonElement>('button[data-add]')) {
      el.addEventListener('click', () => {
        if (draft === undefined) return
        const t = TEMPLATES.find(x => x.id === el.dataset['add'])
        if (t === undefined) return
        const msg = t.apply(draft)
        touched()
        render()
        flash(msg)
      })
    }

    /*
     * ---- 技能库 / 编辑页那几颗按钮 ----
     *
     * ⚠ 玩家 2026-09-21 定的流程：**改的是草稿，按「保存」才进库**。
     *   「以此为原型创建新技能」= 拿选中的那份基础技能当模板开草稿（还不进库）。
     */
    /*
     * ⚠⚠ **选择器里不能带 `button`**（2026-10-07 修的 bug：技能库点不动）。
     *
     *   `data-act` 是编辑器里**所有可交互元素**的钩子（见 `ui/dom.ts` 的 `captureFocus`），
     *   而技能库里的一格是 `<div class="sk-cell" data-act="pick">` —— **不是 button**
     *   （格子整体要能像模板的 `.cell` 那样 hover 抬起，所以它不是按钮元素）。
     *   写成 `button[data-act]` 时，那些格子**一个监听都没挂上**：点上去没反应、
     *   不报错、也没有别的路能选中它（库那一屏没有下拉框了）⇒ 技能库彻底点不动。
     */
    for (const el of body.querySelectorAll<HTMLElement>('[data-act]')) {
      el.addEventListener('click', () => {
        switch (el.dataset['act']) {
          // ---- 技能库那一屏 ----
          case 'pick': {
            const id = el.dataset['i']
            if (id !== undefined) selectSkill(id)
            break
          }
          case 'openEdit': {
            const id = el.dataset['i']
            if (id !== undefined && id !== currentId) selectSkill(id)
            view = 'edit'
            render()
            break
          }
          case 'back': {
            view = 'lib'
            render()
            break
          }
          // ---- 三组控件 ----
          case 'aim-mode': {
            const v = el.dataset['v']
            if (v === undefined || draft === undefined || !editable()) return
            const base: Targeting = draft.targeting ?? { mode: 'directional', valid: [] }
            draft.targeting = { ...base, mode: v as Targeting['mode'] }
            touched(); render()
            break
          }
          case 'aim-valid': applyToggle((s) => {
            const t = s.targeting ?? { mode: 'directional' as const, valid: [] }
            const list = [...t.valid]
            toggleIn(list, el.dataset['v'] ?? '')
            s.targeting = { ...t, valid: list }
          }); break
          case 'carrier-kind': withAction(el, (a) => {
            const kind = el.dataset['v'] ?? ''
            if (kind === '') delete a.delivery
            else a.delivery = { ...(a.delivery ?? {}), kind: kind as NonNullable<Action['delivery']>['kind'] }
          }); break
          case 'host-target': withAction(el, (a) => { a.target = (el.dataset['v'] ?? 'hit') as 'hit' | 'self' }); break
          case 'host-valid': withAction(el, (a) => {
            const list = [...(a.valid ?? [])]
            toggleIn(list, el.dataset['v'] ?? '')
            if (list.length === 0) delete a.valid
            else a.valid = list
          }); break
          case 'hook-side': withAction(el, (a) => {
            const payload = a.payload
            if (payload.kind !== 'status') return
            const hooks = payload.inline?.hooks
            const hook = hooks?.[Number(el.dataset['i'])]
            if (hook === undefined) return
            hook.side = (el.dataset['v'] ?? 'target') as NonNullable<typeof hook.side>
          }); break
          /*
           * ⚠ 这里要 `as HTMLButtonElement`：`wire()` 现在扫的是 `[data-act]`
           *   （不带 `button`），因为技能库的格子是 `div` —— 所以变量类型是 `HTMLElement`。
           *   四档那几个**确实**是 `<button>`（`phaseTierHtml` 生成的），
           *   而 `applyTier` 只读 `dataset`，窄化一下就好。
           */
          case 'tier': applyTier(el as HTMLButtonElement); break
          // ---- 编辑页顶/底栏 ----
          case 'create': {
            const tpl = el.dataset['i'] !== undefined ? skillOf(el.dataset['i']) : templateOf(draft)
            if (tpl === undefined) return
            createFrom(tpl)
            break
          }
          case 'save': save('save'); break
          case 'saveAs': save('saveAs'); break
          case 'discard': discard(); break
          case 'delete': {
            if (currentId !== undefined) host.onDelete(currentId)
            break
          }
          // ---- 存回去那几颗（导出/复制/看 JSON）----
          case 'download': if (draft !== undefined) { download(draft); flash('已下载 ' + fileName(draft)) } break
          case 'copy': if (draft !== undefined) void copy(draft); break
          case 'json': showJson = !showJson; render(); break
          default: break
        }
      })
    }

    // ---- 技能库的搜索框（照模板那个 `搜技能…`）----
    {
      const searchEl = body.querySelector<HTMLInputElement>('#skillSearch')
      if (searchEl !== null) {
        /*
         * ⚠ 打字时**只重画技能库那一屏**，而且不重画正在输入的那个框 ——
         *   整块重画会把 `<input>` 换掉，焦点和光标全丢（`restoreFocus` 接得回来，
         *   但每敲一个字就重建一次格子，输入框会闪）。
         *   这里的做法和别处一致：`input` 改状态 + **只动列表**，`change` 才整块重画。
         */
        searchEl.addEventListener('input', () => {
          query = searchEl.value
          // ⚠ 只换搜索框下面那一段：**不重画输入框自己**（重画会把光标弄丢/闪）
          const holder = body.querySelector<HTMLDivElement>('.sk-libbody')
          /*
           * ⚠ 这条路**绕过了 `render()`**，所以它也绕过了那一对"记下 / 放回"：
           *   每敲一个字就把整个 `.sk-libbody` 换掉 ⇒ 正在看列表下面的东西时
           *   每打一个字都会弹回最上面。所以这里要**自己配一套**（同一个机制）。
           */
          if (holder !== null) {
            const scroll = captureScroll(holder)
            holder.innerHTML = libraryBody()
            // ⚠ 新内容比旧的短时浏览器会自己把 scrollTop 夹到上限，这里照它夹完的值写
            restoreScroll(holder, scroll)
          }
          wire()
        })
        searchEl.addEventListener('change', () => { query = searchEl.value; render() })
      }
    }

    // ---- 三组里那几个非按钮的控件 ----
    for (const el of body.querySelectorAll<HTMLSelectElement>('select[data-act=aim-req]')) {
      el.addEventListener('change', () => {
        if (draft === undefined || !editable()) return
        const t: Targeting = draft.targeting ?? { mode: 'directional', valid: [] }
        const v = el.value
        if (v === '') delete t.requireStatusTag
        else t.requireStatusTag = v
        draft.targeting = t
        touched(); render()
      })
    }
    for (const el of body.querySelectorAll<HTMLInputElement>('input[data-act=aim-range]')) {
      el.addEventListener('input', () => {
        if (draft === undefined || !editable()) return
        const t: Targeting = draft.targeting ?? { mode: 'directional', valid: [] }
        const n = Number(el.value)
        if (el.value.trim() === '' || !Number.isFinite(n) || n < 0) delete t.range
        else t.range = n
        draft.targeting = t
        touched()
      })
      el.addEventListener('change', () => render())
    }

    // ---- 改名字（只有自定义技能能改名）----
    {
      const nameEl = body.querySelector<HTMLInputElement>('#skillName')
      if (nameEl !== null) {
        nameEl.addEventListener('input', () => {
          if (draft === undefined) return
          const text = nameEl.value.trim()
          if (text === '') return
          draft.name = text
          touched()
        })
        nameEl.addEventListener('change', () => render())
      }
    }

    // ---- 技能介绍（手写的那一段）----
    /*
     * ⚠ 它和滑块用同一套写法：`input` 时改草稿（但**不重画** ——
     *   重画会把正在输入的那个 textarea 换掉，焦点和光标全丢），
     *   `change`（失焦）时才整块重画，把校验和明细刷新出来。
     */
    {
      const noteEl = body.querySelector<HTMLTextAreaElement>('#skillNote')
      if (noteEl !== null) {
        noteEl.addEventListener('input', () => {
          if (draft === undefined) return
          const text = noteEl.value
          if (text === '') delete draft.note
          else draft.note = text
          touched()
        })
        noteEl.addEventListener('change', () => render())
      }
    }
  }

  // ---------------------------------------------------------------- 起手

  /*
   * 默认选中：**先看自定义技能库**（玩家自己编的那几个），没有就看基础技能库。
   * ⚠ 反过来的话，玩家一打开技能页看到的是一份只读的出厂技能，
   *   而他上次编的东西藏在列表最下面 —— 那会让人以为"我编的丢了"。
   *
   * ⚠ 选中只是"高亮 + 把草稿读进来"，**不自动进编辑页**：照设计模板，
   *   技能库那一屏先給玩家看清楚"有哪些技能、每个是什么"，按了按钮才进编辑。
   */
  const firstCustom = [...host.custom.keys()].sort()[0]
  const firstBase = [...host.base.keys()].sort()[0]
  const first = firstCustom ?? firstBase
  if (first !== undefined) selectSkill(first)

  return {
    toggle(): void {
      open = !open
      root.classList.toggle('open', open)
      // 编辑器展开时把左右两侧的面板推开，不然它们会盖在上面
      document.body.classList.toggle('editing', open)
      if (open) {
        // ⚠ 每次打开都回到技能库那一屏（"看一眼就关"是常见用法）
        view = 'lib'
        render()
      }
    },
    isOpen(): boolean {
      return open
    },
    /**
     * 库变了（另存为、删除、别的页面改了它）→ 重新读一遍。
     *
     * ⚠ 必须**重新 selectSkill**，不能只重画：草案里存的是上一次读到的内容，
     *   接着改下去会把它写回库里的另一个地方。
     *   草稿还没进库（`isNew`）时**不要**覆盖它 —— 那等于把玩家正在编的东西丢了。
     */
    reload(): void {
      if (isNew) {
        render()
        return
      }
      if (currentId === undefined) {
        render()
        return
      }
      if (skillOf(currentId) === undefined) {
        // 这一份被删了（或存档换了）→ 退回第一个能选的
        const first = [...host.custom.keys()].sort()[0] ?? [...host.base.keys()].sort()[0]
        currentId = undefined
        if (first !== undefined) selectSkill(first)
        else body.innerHTML = '<div class="dim">没有可编辑的技能</div>'
        return
      }
      selectSkill(currentId)
    },
  }
}

// ---------------------------------------------------------------- 存回去

function shortName(id: string): string {
  return id.replace(/^skill\./, '')
}

function fileName(skill: Skill): string {
  return `${shortName(skill.id)}.json`
}

/** 下载成文件。放回 content/skills/ 就能被命令行和网页加载 */
function download(skill: Skill): void {
  const blob = new Blob([JSON.stringify(skill, null, 2) + '\n'], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName(skill)
  a.click()
  URL.revokeObjectURL(url)
}

async function copy(skill: Skill): Promise<void> {
  const text = JSON.stringify(skill, null, 2)
  try {
    await navigator.clipboard.writeText(text)
    flash('已复制到剪贴板')
  } catch {
    flash('复制不了，用「看一眼」手动拷')
  }
}

let flashTimer = 0
function flash(msg: string): void {
  const el = document.getElementById('toast')
  if (el === null) return
  el.textContent = msg
  el.style.color = '#3fb950'
  el.classList.add('show')
  window.clearTimeout(flashTimer)
  flashTimer = window.setTimeout(() => {
    el.classList.remove('show')
    el.style.color = ''
  }, 1400)
}

// ---------------------------------------------------------------- 小工具

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100)
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c
  ))
}
