/**
 * 汇率标定器：拿真内容去调 `content/balance.json` 里那张定价表。
 *
 * ## 为什么需要它
 *
 * 点数已经不是手写的了（见 src/pricing.ts）：改数值，点数自己变。
 * 但**汇率**还是人拍的 —— `10 点伤害算 1 点` 这个 10 是猜的。
 * 猜错的后果很具体：七个技能一个个都配不平，玩家一打开编辑器
 * 满屏都是"差 N 点代价"，那这个编辑器就没法用了。
 *
 * 手调十二个汇率去凑七个技能是不可能的（改一个，七个全动）。
 * 所以让它自己算：
 *
 *   找一组汇率，让每个技能的合计尽量等于它的**目标值**。
 *
 * 目标值默认是 0（配平），个别技能故意给负数 —— 那是"负值技能"，
 * 每次使用拿血契付账。list 在下面的 TARGETS 里。
 *
 * ## 它怎么算
 *
 * 把 pricing.ts 当**黑盒**：不推导公式，直接用现成的 priceSkill 问
 * "这组汇率下这七个技能分别值多少分"，然后最小化平方误差。
 *
 * 优化器是**坐标下降**：每次只动一个汇率，在对数刻度上试大中小三步，
 * 走不动就缩小步长。没有随机数，同样的输入永远得到同样的输出。
 *
 * 对数刻度是为了让所有汇率自动保持正数（负的汇率没有意义，
 * 而且 readRates 会把它当无效值丢掉）。
 *
 * ## 用法
 *
 *   npm run calibrate          看看现在差多少，并给出建议的新汇率（**只报告，不写回**）
 *
 * ⚠⚠ 2026-09-30（日志 60b）：**`--write` 已经摘掉了** —— 它存在的理由是
 *   "拟合汇率"，而账现在是**查表 + 相加**（`lookupTable`），汇率只喂绝对账。
 *   理由整段写在下面的 `main()` 头上。
 */
import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { readJson } from '../src/loader.ts'
import { DEFAULT_RATES, priceSkill } from '../src/pricing.ts'
import type { Rates } from '../src/pricing.ts'
import type { BalanceConfig } from '../src/validator/types.ts'
import type { Skill, StatusDef } from '../src/schema.ts'

const BALANCE = resolve('content/balance.json')
const SKILL_DIR = resolve('content/skills')

/**
 * 每个技能希望落在多少点。
 *
 * 没写的就是 0（配平）。
 *
 * ⚠ 符号约定：负 = 消耗额度，正 = 提供额度。
 *   所以"负值术式"的目标值是**负数** —— 它花超多少，就每次消耗多少血契。
 *
 * ⚠ **这条规矩只对"成品"成立。** 技能是零件，零件可以故意歪
 *   （见下面的 `NOT_FITTED`）。所以"技能默认目标 0"这句话在
 *   配平搬到术式之后，真正的含义是"**出厂技能恰好都是单技能术式**，
 *   而它们各自配平" —— 不是"技能必须配平"。
 */
const TARGETS: Record<string, number> = {
  'skill.soul-rend': -6,
}

/**
 * **不参与拟合**的技能。
 *
 * ⚠ 这一条是"配平的责任在术式，不在技能"（2026-09-21）之后才出现的：
 *   技能可以是**故意歪**的零件，而"它该歪多少"是**设计决定**，不是定价表决定的。
 *   拿这种零件去拟合汇率，等于让一个自由参数去拉整张表 ——
 *   数学上误差更小，实际上是把别的技能的账全带偏了。
 *
 *   它们仍然会被校验器检查（负值术式必须能算出血契消耗），
 *   只是不参与"汇率该是多少"这件事。
 */
const NOT_FITTED: Record<string, string> = {
  'skill.blood-offering': '负值零件：故意不平衡，歪多少是设计定的（血祭斩的代价就是血契）',
  'skill.blood-pact': '收入被动：它发的是血契，而血契本身还没有计价项',
  'skill.slow-field': '场地的行为：它的价值由**放下它的术式**承担，而两层账现在是分开的（结构性的，见日志欠账）',
  'skill.place-slow-field': '放下场地的那个技能：它买的是"一块持久区域"，而区域本身的价值还进不了它的账',
  'skill.barrier': '屏障：它值多少刚接上一条**新轴**（正面宽度 × 挡住什么），'
    + '而那条轴的单价的量级是**拍出来的**（借的是范围那条汇率）。'
    + '拿它去拽所有汇率，会把别的技能的账一起拽歪 —— 实测：最大偏差从 1.53 涨到 2.76。'
    + '等玩过、把这条轴的量级定下来之后再放它进来。',
}

/**
 * 汇率不许跑出这个范围。
 *
 * 范围是**围绕原始值的一个倍数**，不是随便定的上下限：
 * 优化器最喜欢干的事是把某个汇率推到边界上（比如把 `energyPerPoint`
 * 推到 200，让所有能量代价几乎免费），数学上误差更小，读起来却是胡说。
 * 卡在一个数量级之内，解就还是"人话"，剩下的误差才是**真的**信号。
 */
const SPREAD = 5

/**
 * 汇率的下限 —— **设计约束，不是数值约束**。
 *
 * ⚠ 为什么需要它：标定器只会找"让出厂内容最平"的汇率。而**范围**
 *   （`area` / `aura` 的半径）在出厂内容里一直是被当成免费的，
 *   所以拟合出来的 `areaRadiusPerMeter` 只有 0.067 ——
 *   12 米的扫描圈只比 6 米标准贵 0.4 点，这条轴等于装饰。
 *
 *   玩家 2026-09-21 定的："给它一个下限，让范围真的疼。"
 *   于是这里钉一个地板。代价是残差会涨一点 —— 那是**诚实的代价**：
 *   出厂内容确实是在"范围免费"的前提下调的，现在要让范围收费，
 *   那几个技能的账自然就不平了。**该动的是内容，不是把地板撤掉。**
 *
 * 加进来之后回头看 `npm run validate`：哪个技能**差出一格以上**，
 * 就说明"它的范围该付钱而它没付"，去调那一条内容。
 */
const RATE_FLOOR: Partial<Rates> = {
  areaRadiusPerMeter: 0.2,
}

function boundsFor(k: keyof Rates): [number, number] {
  const base = DEFAULT_RATES[k]
  const lo = Math.max(base / SPREAD, RATE_FLOOR[k] ?? 0)
  return [lo, base * SPREAD]
}

/**
 * 往原来的值上拽的力度。
 *
 * 不加这一项的话，优化器会让某个汇率一路跑到边界值上去 ——
 * 数学上一样好，读起来却莫名其妙。有一点点拉力，解就还是"人话"。
 */
const REGULARIZE = 0.02

const KEYS = Object.keys(DEFAULT_RATES) as (keyof Rates)[]

// ---------------------------------------------------------------- 读内容

interface Sample {
  id: string
  name: string
  skill: Skill
  target: number
}

function loadSamples(balance: BalanceConfig): Sample[] {
  const out: Sample[] = []
  for (const file of readdirSync(SKILL_DIR).filter(f => f.endsWith('.json')).sort()) {
    const skill = readJson<Skill>(resolve(SKILL_DIR, file))
    // 故意歪的零件不参与拟合 —— 理由见 NOT_FITTED
    if (NOT_FITTED[skill.id] !== undefined) continue
    out.push({
      id: skill.id,
      name: skill.name,
      skill,
      target: TARGETS[skill.id] ?? 0,
    })
  }
  void balance
  return out
}

// ---------------------------------------------------------------- 目标函数

/**
 * 状态库。
 *
 * ⚠ 标定器**必须**拿到它。不传的话，技能里按 `statusId` 引用库状态的动作
 *   会被算成 0 点 —— 灵光盾会显示"还剩 10.38 点"，于是标定器拼命去拟合
 *   一个**根本不存在的误差**，把汇率带偏（最大偏差从 1.9 涨到 4.1）。
 *   这个坑是加状态库的那一轮踩到的。
 */
function loadStatuses(): Map<string, StatusDef> {
  const out = new Map<string, StatusDef>()
  const dir = 'content/statuses'
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    const st = readJson<StatusDef>(resolve(dir, f))
    out.set(st.id, st)
  }
  return out
}

function priceOptionsOf(rates: Rates, balance: BalanceConfig) {
  return {
    rates,
    baseRuleSlots: balance.baseRuleSlots,
    ruleSlotBuyCost: balance.ruleSlotBuyCost,
    ruleSlotSellGain: balance.ruleSlotSellGain,
    /*
     * ⚠ 2026-09-30（日志 57）：这里原来传 `tolerance: 0`，注释是
     *   "标定时不带容差：容差是给人看的宽限，标定要的是真实误差"。
     *   **那个字段已经作废**（产品容差整个删掉了）——
     *   标定现在拿到的账**本来就是整数**（逐条取整 + 至少 1 点），
     *   所以"真实误差"这句话变成了"拟合目标本身是整数网格"。
     */
    statuses: loadStatuses(),
  }
}

function score(samples: Sample[], rates: Rates, balance: BalanceConfig): number {
  const options = priceOptionsOf(rates, balance)

  let sum = 0
  for (const s of samples) {
    const total = priceSkill(s.skill, options).total
    sum += (total - s.target) ** 2
  }

  // 拉力：离原始汇率越远越贵
  for (const k of KEYS) {
    const base = DEFAULT_RATES[k]
    sum += REGULARIZE * Math.log(rates[k] / base) ** 2
  }
  return sum
}

function withRate(rates: Rates, k: keyof Rates, v: number): Rates {
  return { ...rates, [k]: v }
}

/** 夹到合法区间里，顺便保证是正数 */
function clamp(k: keyof Rates, v: number): number {
  const [lo, hi] = boundsFor(k)
  return Math.min(hi, Math.max(lo, v))
}

/** 对数刻度的夹取：优化变量是 ln(rate)，边界也要取对数 */
function clampLog(k: keyof Rates, logV: number): number {
  const [lo, hi] = boundsFor(k)
  return Math.min(Math.log(hi), Math.max(Math.log(lo), logV))
}

/** 从对数参数（真正的优化变量）还原出汇率 */
function toRates(x: number[]): Rates {
  const out = { ...DEFAULT_RATES }
  for (let i = 0; i < KEYS.length; i++) {
    out[KEYS[i]] = Math.exp(x[i] ?? 0)
  }
  return out
}

/**
 * 目标函数：每个技能的合计离它的目标值有多远，外加一点点"别离原始值太远"的拉力。
 */
function objective(x: number[], samples: Sample[], balance: BalanceConfig): number {
  return score(samples, toRates(x), balance)
}

/**
 * 数值梯度。
 *
 * 用中心差分：对第 k 个参数，往两边各挪一点点，看目标函数变化多少。
 * 十二个参数 × 两次求值 = 一次梯度二十四次评估，这个规模下完全无所谓。
 */
function gradient(x: number[], samples: Sample[], balance: BalanceConfig): number[] {
  const h = 1e-3
  const g: number[] = []
  for (let i = 0; i < x.length; i++) {
    const up = [...x]
    const down = [...x]
    up[i] = (up[i] ?? 0) + h
    down[i] = (down[i] ?? 0) - h
    g.push((objective(up, samples, balance) - objective(down, samples, balance)) / (2 * h))
  }
  return g
}

/**
 * 优化：对数刻度上的梯度下降 + 回溯线搜索，最后再用坐标下降收一下尾。
 *
 * ⚠ 为什么不是纯坐标下降：只动一个参数时，很多方向是"单独动没用、
 *   一起动才有用"的（比如把 damagePerPoint 和 energyPerPoint 同时放大，
 *   相当于换了记账单位）。坐标下降会卡在那儿 —— 这不是理论担心，
 *   第一版就是这么卡住的：damagePerPoint 一步都没动过。
 *
 * 没有随机数：同样的内容跑一百次得到同一张表。
 */
function fit(samples: Sample[], balance: BalanceConfig): Rates {
  const x = KEYS.map(k => Math.log(DEFAULT_RATES[k]))
  let best = objective(x, samples, balance)

  // ---- 梯度下降 ----
  for (let iter = 0; iter < 400; iter++) {
    const g = gradient(x, samples, balance)

    // 梯度归一化：不然目标函数尺度一变，步长就完全不是一回事了
    let norm = 0
    for (const v of g) norm += v * v
    norm = Math.sqrt(norm)
    if (norm < 1e-9) break

    let alpha = 1
    let moved = false
    for (let back = 0; back < 24; back++) {
      const trial = x.map((v, i) => clampLog(KEYS[i], v - alpha * (g[i] ?? 0) / norm))
      const s = objective(trial, samples, balance)
      if (s < best - 1e-12) {
        for (let i = 0; i < x.length; i++) x[i] = trial[i] ?? 0
        best = s
        moved = true
        break
      }
      alpha /= 2
    }
    if (!moved) break
  }

  // ---- 坐标下降收尾：把梯度下降留下的零头抹平 ----
  let rates = toRates(x)
  best = score(samples, rates, balance)
  let step = 1.05

  for (let i = 0; i < 2000 && step > 1.0001; i++) {
    let improved = false
    for (const k of KEYS) {
      for (const dir of [step, -step]) {
        const candidate = clamp(k, rates[k] * Math.exp(dir))
        if (candidate === rates[k]) continue
        const trial = withRate(rates, k, candidate)
        const s = score(samples, trial, balance)
        if (s < best - 1e-12) {
          rates = trial
          best = s
          improved = true
        }
      }
    }
    if (!improved) step = 1 + (step - 1) / 2
  }

  return rates
}

// ---------------------------------------------------------------- 输出

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

function main(): number {
  /*
   * ⚠⚠ 2026-09-30（日志 60b）：**`--write` 摘掉了** —— 这个工具现在**只报告、不写回**。
   *
   *   为什么：它存在的理由是"拟合汇率，让每个技能的账尽量等于目标值"。
   *   而**账已经不是公式算的了**：技能的点数 = **各选中表项相加**
   *   （`content/balance.json` 的 `lookupTable`，用户 2026-09-30 定的规格）。
   *   汇率从此**只喂绝对账**（`priceSkill`：报表 / 内部强度标尺），
   *   而绝对账**不是**玩家看到的那个数 ⇒ 照着它去改 `rates` 改不动任何一份技能的账。
   *
   *   ⚠ 不删掉这个工具的理由：它仍然是"**这套汇率下的绝对量级长什么样**"
   *     唯一的量化视图（`priceSkill` 逐份打印 + 残差）。
   *   ⚠ 真要调**账**，改的是 `lookupTable`（用户签的字），不是这里。
   *     写回 `balance.json` 的代码整段删掉了 —— 留一个"看似还能写"的开关
   *     比删掉更危险（下一个人会以为它还在改账）。
   */
  const balance = readJson<BalanceConfig>(BALANCE)
  const samples = loadSamples(balance)

  const options = (rates: Rates) => priceOptionsOf(rates, balance)

  /*
   * ⚠⚠ 2026-09-30（日志 57）：判据**从"容差"换成"账自己的分辨率"**。
   *
   *   以前：`|残差| ≤ 容差（2 点）` 打勾 —— 那个容差**已经删掉了**。
   *   现在：账上每一笔都是整数、非零条目**至少 1 点**，所以**1 点就是这本账的
   *   最小刻度**，残差也是整数（整数合计 − 整数目标）。
   *   ⇒ 打勾 = `|残差| ≤ 1`（"差不到一格"）；
   *      `≤ 2` 打 `~`（差一两格，还在同一量级）；再大打 `✗`。
   *
   *   ⚠ 这条阈值是**判断**（规格没写"标定该拿几格当合格"），列在日志 57 待裁定项。
   */
  const GRID = 1
  const flagFor = (gap: number): string =>
    Math.abs(gap) <= GRID ? '✓' : Math.abs(gap) <= GRID * 2 ? '~' : '✗'

  console.log('')
  // ⚠ 技能个数要**数出来**，不能写死。写死过一次：内容加到 10 个了，
  //   标题还印着"七个"，看到的人会以为有几个技能没被标定进去。
  console.log(`汇率标定  ·  拿 ${samples.length} 个真技能去调定价表（账的刻度 = ${GRID} 点）`)
  console.log('─'.repeat(72))

  const before = samples.map(s => ({ s, total: priceSkill(s.skill, options(DEFAULT_RATES)).total }))
  const worst0 = Math.max(...before.map(b => Math.abs(b.total - b.s.target)))

  console.log('  标定前：')
  for (const b of before) {
    const gap = b.total - b.s.target
    console.log(`    ${b.s.name.padEnd(10)} ${String(round(b.total)).padStart(8)}   目标 ${String(b.s.target).padStart(6)}   差 ${round(gap)}  ${flagFor(gap)}`)
  }
  console.log(`    最大偏差 ${round(worst0)}`)

  const fitted = fit(samples, balance)
  const after = samples.map(s => ({ s, total: priceSkill(s.skill, options(fitted)).total }))
  const worst1 = Math.max(...after.map(b => Math.abs(b.total - b.s.target)))
  const err0 = Math.sqrt(before.reduce((a, b) => a + (b.total - b.s.target) ** 2, 0) / before.length)
  const err1 = Math.sqrt(after.reduce((a, b) => a + (b.total - b.s.target) ** 2, 0) / after.length)

  console.log('')
  console.log('  标定后：')
  for (const b of after) {
    const gap = b.total - b.s.target
    console.log(`    ${b.s.name.padEnd(10)} ${String(round(b.total)).padStart(8)}   目标 ${String(b.s.target).padStart(6)}   差 ${round(gap)}  ${flagFor(gap)}`)
  }
  console.log(`    最大偏差 ${round(worst1)}   均方根 ${round(err0)} → ${round(err1)}`)

  /*
   * 退出码：残差**超过这本账的分辨率（1 格 = 1 点）**才算"标不动"。
   *
   * 一格之内的残差是这张定价表的分辨率极限（它还不认射程/投射物/频率），
   * 不是错误 —— 拿它当失败会让每天都红着，红久了就没人看了。
   * ⚠ 2026-09-30（日志 57）：这条线原来是"配平容差 2 点"，容差删了之后
   *   改成"账的最小刻度"。判据换了，所以**看到新的红灯数字要先看这一行**。
   */
  const stuck = worst1 > GRID

  if (stuck) {
    console.log('')
    console.log(`  ⚠ 残差 ${round(worst1)} 超过了这本账的分辨率（${GRID} 点/格）。这说明**不只是汇率的问题**：`)
    console.log('    要么某个技能的数值本身不合理，要么定价表缺了一项（某个效果没被计价）。')
    console.log('    这是给你看的信号，不是要把它抹平。')
  }

  console.log('')
  console.log('  新汇率：')
  const rates: Record<string, number> = {}
  for (const k of KEYS) {
    rates[k] = round(fitted[k])
    const delta = round(fitted[k] - DEFAULT_RATES[k])
    const mark = Math.abs(delta) < 1e-9 ? '' : `   (${delta > 0 ? '+' : ''}${delta})`
    console.log(`    "${k}": ${rates[k]},${mark}`)
  }

  /*
   * ⚠ 只报告、**不写回**（2026-09-30 日志 60b）：写回那一段已经删掉了，
   *   理由写在 `main` 开头那一大段里 —— 一句话：**账在表里，不在汇率里**。
   */
  console.log('')
  console.log('  ⚠ 这一份只是**报告**：`--write` 已经摘掉了（账 = 查表 + 相加，见日志 60b）。')
  console.log('     要改**账**，改的是 content/balance.json 的 lookupTable（用户签的字）；')
  console.log('     这里的汇率只喂**绝对账**（报表用的那把尺子），改它不动任何一份技能的账。')
  console.log('')
  return stuck ? 1 : 0
}

process.exitCode = main()
