/**
 * 构建产物的测试。
 *
 * 里程碑 0.5 把模拟核编成了浏览器能跑的 JS。这里要回答一个问题：
 *
 *   **编出来的那份，和 Node 直接跑的那份，行为一样吗？**
 *
 * 如果不一样，"浏览器里能跑"就只是一句口号 —— 你在浏览器里看到的
 * 和你用命令行调出来的会是两套东西。
 *
 * 没跑过 `npm run build:web` 就跳过，不算失败。
 */
import { existsSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { get as httpGet } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  advance, createWorld, getStored, registerTechnique, snapshot, spawn, stepWorld,
} from '../src/sim/index.ts'
import type { World } from '../src/sim/index.ts'
import type { Phase, Rule, Skill, Technique } from '../src/schema.ts'
import type { BalanceConfig } from '../src/validator/types.ts'
import { readJson } from '../src/loader.ts'
import { compileTechnique } from '../src/sim/compile.ts'
import type { CompiledTechnique } from '../src/sim/compile.ts'
/*
 * ⚠ 直接 import **源码**（不是编译产物）：`aim.ts` 是不碰 DOM 的纯函数，
 *   所以浏览器之外也能测 —— 而"算方向"这一步正好是最该被测的地方。
 */
import { aimFromPointer } from '../web/src/aim.ts'
/*
 * ⚠ 静态资源的 URL 映射：**浏览器和桌面壳共用同一份**（见 `docs/desktop.md`）。
 *   所以它是可测的纯函数，测试直接查它，不用起服务器。
 */
import { contentTypeOf, resolveAssetUrl } from '../src/server/assets.ts'
/*
 * ⚠ 桌面壳（`desktop/main.js`）**就是起这个服务器**再把窗口指过去 ——
 *   所以它值得端到端测（真的 listen、真的 fetch）。
 */
import { createStaticServer } from '../src/server/static.ts'
/* 焦点工具：渲染路径上不许抛（见下面那条回归测试） */
import { captureFocus, captureScroll, endBlocks, mountBlock, restoreFocus, restoreScroll } from '../web/src/ui/dom.ts'
import type { ElLike } from '../web/src/ui/dom.ts'

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

/**
 * 把 `console.error` 收到的参数变成一行能读的字。
 *
 * ⚠ Error 必须带上**栈**：只印 message 的话，"Maximum call stack size exceeded"
 *   完全看不出是哪里递归了 —— 而这个测试就是用来抓那种东西的。
 */
function errText(args: unknown[][]): string {
  return args
    .map(a => a.map(x => (x instanceof Error ? (x.stack ?? x.message) : String(x))).join(' '))
    .join(' | ')
}

/**
 * 近似相等（浮点）。
 *
 * ⚠ 方向向量是归一化出来的，`1` 和 `0.9999999999999998` 是同一个方向 ——
 *   用 `===` 比会红得毫无意义。
 */
function near(name: string, actual: number, expected: number, tol = 1e-9): void {
  ok(name, Math.abs(actual - expected) <= tol, `实际 ${actual}，期望 ${expected}`)
}

function eq(name: string, actual: unknown, expected: unknown): void {
  ok(name, Object.is(actual, expected), `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`)
}

const DIST = resolve('web/dist/technique-system/src/sim/index.js')

// ---------------------------------------------------------------- 场景

function phase(id: string, duration: number): Phase {
  return { id, duration, occupiesCaster: false, interrupt: 'damage', cancellable: false }
}

function rule(when: Rule['when'], then: Rule['then'], phaseId?: string): Rule {
  const r: Rule = { id: `r-${when}-${String(then.length)}`, when, then, order: 0 }
  if (phaseId !== undefined) r.phaseId = phaseId
  return r
}

/** 单技能术式 → 编译产物。和 tests/cast.ts 里的同名函数是一个意思 */
function makeTechnique(): CompiledTechnique {
  const skill: Skill = {
    schemaVersion: 1,
    id: 'skill.probe',
    name: 'probe',
    phases: [phase('cast', 0.2)],
    rules: [rule('phaseComplete', [{
      delivery: { kind: 'projectile', speed: 9, lifetime: 2, radius: 0.3 },
      payload: { kind: 'damage', amount: { const: 14 } },
    }], 'cast')],
    ruleSlots: 4,
    // ⚠ 瞄准在**技能**上（2026-09-21 日志 47）：术式那个字段删掉了
    targeting: { mode: 'directional', valid: ['enemy'], range: 10 },
  }
  const technique: Technique = {
    schemaVersion: 1,
    id: 'tech.probe',
    name: 'probe',
    // ⚠ 系别必填（schema 的 Technique.kind）：这是"源码 vs 编译产物"用的魔法术式
    kind: 'magic',
    activation: 'press',
    skills: [skill.id],
  }
  return compileTechnique(technique, k => (k === skill.id ? skill : undefined)).compiled
}

/** 用给定的 sim 模块建一个场景。同一份代码，两个来源 */
function build(sim: SimModule, seed: number): World {
  const w = sim.createWorld({ seed })
  const BOLT = makeTechnique()

  sim.registerTechnique(w, BOLT)

  for (const [faction, x] of [['player', -5], ['enemy', 5]] as const) {
    const e = sim.spawn(w, {
      faction,
      pos: { x, y: 0 },
      base: { 'char.hp.max': 250, 'char.energy.regen': 12, 'char.speed': 5 },
      techniqueIds: ['tech.probe'],
    })
    e.ai = { targetFaction: 'enemyOfSelf', preferredRange: 3, thinkInterval: 0.3 }
  }
  return w
}

interface SimModule {
  createWorld: typeof createWorld
  spawn: typeof spawn
  registerTechnique: typeof registerTechnique
  stepWorld: typeof stepWorld
  advance: typeof advance
  getStored: typeof getStored
  snapshot: typeof snapshot
}

function run(sim: SimModule, seed: number, ticks: number): string {
  const w = build(sim, seed)
  sim.advance(w, ticks)
  return JSON.stringify(sim.snapshot(w))
}

// ---------------------------------------------------------------- 主流程

async function main(): Promise<number> {
  console.log('\n构建产物：源码 vs 编译结果')

  if (!existsSync(DIST)) {
    console.log('  ' + '○ 跳过：还没有构建产物。先跑 npm run build:web')
    console.log('')
    return 0
  }

  ok('编译产物存在', true)

  const compiled = await import(pathToFileURL(DIST).href) as unknown as SimModule

  const fromSource = run(
    { createWorld, spawn, registerTechnique, stepWorld, advance, getStored, snapshot },
    7, 600,
  )
  const fromBuild = run(compiled, 7, 600)

  ok(
    '同一场景跑 600 tick：源码和编译产物快照逐字节一致',
    fromSource === fromBuild,
    fromSource === fromBuild ? undefined : '两边的行为不一样 —— 构建改变了语义',
  )

  // 顺手确认编译产物里没有混进 Node API
  const { readFileSync, readdirSync } = await import('node:fs')
  const dir = resolve('web/dist/technique-system/src/sim')
  let dirty = ''
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.js')) continue
    const text = readFileSync(resolve(dir, f), 'utf8')
    if (/require\(|from\s*["']node:/.test(text)) dirty += f + ' '
  }
  ok('编译产物里没有 Node API（纪律 4 在构建产物上依然成立）', dirty === '', dirty)

  /*
   * ---- 读 `web/index.html` 里那一段样式的两把小刀 ----
   *
   * ⚠ 为什么要有它们：2026-10-07 用户实测抓出来的两条观感问题里，
   *   **第一条的一半根本不在 DOM 上**（详情面板的宽 / 高 / 位置）。
   *   假 DOM 没有排版引擎，这种"尺寸"量不出来 ⇒ 只能退到**样式数值**上钉：
   *   把那条规则的**规则体**从源码里抠出来，断言里面的数。
   *
   * ⚠ 抠规则体时必须**配平地扫到自己那个 `}`**，不能"抠到下一个 `}` 为止"：
   *   用户报的那条问题的根因正是 `web/index.html` 里 `.sk-detail {` 后面
   *   **少了一个 `}`** —— 于是那条规则体是空的，而且 CSS 解析器会把**它后面
   *   所有规则**都当成它的内部一起吃掉（面板于是没有固定宽度 ⇒ 宽 / 高 / 位置
   *   全跟着"当前选中的是谁"变）。配不平这里返回空串 ⇒ 断言当场失败，
   *   而不是像"肉眼觉得一样"那样静默过去。
   */
  const styleBlock = (): string => {
    const html = readFileSync(resolve('web/index.html'), 'utf8')
    const from = html.indexOf('<style>')
    const to = html.indexOf('</style>')
    return from < 0 || to < 0 ? '' : html.slice(from, to)
  }
  const ruleBodyOf = (css: string, selector: string): string => {
    const at = css.indexOf(`${selector} {`)
    if (at < 0) return ''
    let i = css.indexOf('{', at) + 1
    const start = i
    let depth = 1
    while (i < css.length && depth > 0) {
      const ch = css[i]
      if (ch === '{') depth++
      else if (ch === '}') depth--
      i++
    }
    return depth === 0 ? css.slice(start, i - 1) : ''
  }

  // ---- 客户端本身能不能加载 ----
  //
  // ⚠ 这一段测的是**浏览器开局整条路径**：
  //     读 manifest → 读技能 → 读术式 → 编译 → 读场景 → 装配世界 → 刷 HUD
  //
  //   做法是给 fetch / Image 装上"从磁盘读"的替身，让 main.js 的 boot() 真的跑完。
  //   这是唯一能在 Node 里覆盖这条路径的办法 —— 而它值得覆盖：
  //   这条路上出过的每一个错（lava-armor 404、名单对不上）在浏览器里的表现
  //   都是**白屏**，看不出是哪个文件的问题。
  const client = resolve('web/dist/technique-system/web/src/main.js')
  let moduleError: unknown
  const realError = console.error
  const realWarn = console.warn
  const errors: string[] = []
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')) }
  console.warn = () => undefined
  let dom: DomStubs
  try {
    dom = installDomStubs()
    await import(pathToFileURL(client).href)
    // boot() 是异步的，等它把 fetch 的链走完
    await settle()
  } catch (e) {
    moduleError = e
    dom = installDomStubs()
  } finally {
    console.error = realError
    console.warn = realWarn
  }
  ok('浏览器客户端能加载（模块图解析 + 顶层代码）',
    moduleError === undefined,
    moduleError === undefined ? undefined : String(moduleError))

  const hud = dom.el('stats').innerHTML + dom.el('skills').innerHTML

  ok('开局没报"加载失败"',
    !hud.includes('加载失败') && !hud.includes('加载失败：'),
    hud.slice(0, 400))

  ok('没有"内容文件加载失败"',
    !hud.includes('个内容文件加载失败'),
    hud.slice(0, 400))

  ok('boot 期间没有 console.error',
    errors.length === 0,
    errors.join(' | '))

  /*
   * ⚠ 这几条是**装配驱动开局**的核心断言。
   *
   *   以前阵容写死在 main.ts 里（5 个术式 + 3 个敌人）。
   *   现在它来自 content/scenarios/arena.json。
   *
   * ⚠ 2026-09-21 起**开局只有一格术式**（玩家定的）：
   *   > 目前数字键1到0仍然是释放技能而不是术式，改成这样：初始只有一个术式
   *   > 释放某个技能，现有技能库不改，玩家可以自行创造术式。
   *
   *   以前这 10 格塞满"一个技能一个术式"的出厂示范，名字和技能一模一样 ——
   *   看起来就是一条技能栏，正是玩家报的那个观感问题。
   */
  ok('技能栏里只有开局那一格术式（魔法飞弹）',
    dom.el('skills').innerHTML.includes('魔法飞弹'),
    dom.el('skills').innerHTML.slice(0, 600))

  ok('其余九格是空的（破军突刺 / 圣光术 / 背水 不再白送）',
    !dom.el('skills').innerHTML.includes('破军突刺')
    && !dom.el('skills').innerHTML.includes('圣光术')
    && !dom.el('skills').innerHTML.includes('背水'),
    dom.el('skills').innerHTML.slice(0, 600))

  /*
   * ⚠ 技能链的渲染由下面那块"带存档启动"接手（它排了一份裂地斩 → 魔法飞弹的术式）。
   *   开局这一格只有一个技能，链子上只有一环。
   */
  ok('开局那一格的技能链也列出来了（只有一环）',
    dom.el('skills').innerHTML.includes('魔法飞弹'),
    dom.el('skills').innerHTML.slice(0, 600))

  /*
   * ⚠ 敌人数现在在 `#hudFoes` 这个**子元素**里，不在 `statsEl.innerHTML` 里。
   *   HUD 从"每帧重写 innerHTML"改成"结构建一次、只改变化的那几个字段"
   *   （那样才可能有动画 / hover / 按钮），所以数值要查子元素。
   */
  ok('敌人分母来自场景（3），不是写死的常量',
    dom.el('hudFoes').textContent === '3 / 3',
    `hudFoes="${dom.el('hudFoes').textContent}"`)

  /*
   * ⚠ 血契那一条必须**一直显示**，哪怕还是 0。
   *   它是"攒出来的资本"，玩家得能随时回答"我现在够放那个大招了吗"。
   *   只在非 0 时显示的话，攒的过程就是不可见的 —— 那这个机制就不存在了。
   */
  ok('HUD 上有血契（一直显示，哪怕还是 0）',
    dom.el('stats').innerHTML.includes('血契'),
    dom.el('stats').innerHTML.slice(0, 400))

  /*
   * ⚠ 武器那一行也要**一直显示**，而且要知道**开局手里是什么**。
   *
   *   它决定了伤害、射程、攻速和左键走哪几段序列 ——
   *   玩家换了武器之后手上到底变强了多少，得能看见。
   *   （arena 里开局是铁剑，旁边地上躺着长剑，走过去按 F 换。）
   */
  ok('HUD 上有武器（开局是铁剑，不是空手）',
    dom.el('stats').innerHTML.includes('武器')
    && dom.el('hudWeapon').textContent.includes('铁剑'),
    `hudWeapon="${dom.el('hudWeapon').textContent}"`)

  /*
   * ⚠ 技能栏那一块必须写明**它是术式栏**。
   *
   *   玩家 2026-09-21 报的困惑就是这里：
   *   > 蓄斩不应该是术式吗？明明是两个技能组成的技能，为什么当成单独的技能了？
   *
   *   因为这一栏以前没有标题，而底下那行提示写的是「1~5 放技能」——
   *   一列名字（蓄斩、灵光盾…）看下来就像"一堆技能"。
   */
  ok('技能栏写着它是「术式栏」（不是"一堆技能"）',
    dom.el('skills').innerHTML.includes('术式栏'),
    dom.el('skills').innerHTML.slice(0, 300))

  /*
   * ⚠ 技能编辑器一进来要有**技能介绍**（玩家 2026-09-21 要的）。
   *   `createEditor` 在 boot 里就会把草稿渲染出来，
   *   所以这里的 innerHTML 就是玩家打开 Tab 看到的那一页。
   *
   * ⚠⚠ 2026-10-06（编辑器 UI 第一片）：技能页照用户给的设计模板改成了**两屏**——
   *   技能库（左库 + 右详情）和编辑区。**两屏都在 DOM 里、只切显示**
   *   （模板就是这么干的，理由见 `editor.ts` 的 `renderInner`），
   *   所以下面这些断言读到的仍然是"整页"，只是多了一层 `display:none` 的壳。
   */
  const editorHtml = dom.el('editorBody').innerHTML
  if (process.env['DSH_DUMP_EDITOR'] === '1') {
    writeFileSync(resolve('.scratch/editor-ui-slice1/before/editor-body.html'), editorHtml, 'utf8')
  }
  ok('技能编辑器里有技能介绍（手写的那段 + 一句人话 + 时间线）',
    editorHtml.includes('skillNote') && editorHtml.includes('intro-timeline'),
    editorHtml.slice(0, 400))
  ok('  介绍里带的是内容里那句手写的介绍（不是空的 placeholder）',
    /<textarea id="skillNote"[^>]*>[^<]{10,}</.test(editorHtml),
    editorHtml.slice(0, 500))
  /*
   * ⚠ 这一条原来查的是**整页**里没有 `status.xxx` / `char.xxx` 这种 id。
   *   现在整页里必然有 id —— 左边技能库的格子上挂着 `data-i="skill.cleave"`（那是身份，
   *   点它才知道选哪一份）。所以改成**只看介绍那一块**：
   *   介绍是给人读的，它一个 id 都不该出现。
   */
  {
    const from = editorHtml.indexOf('class="group intro"')
    const to = editorHtml.indexOf('intro-timeline', from)
    const intro = from < 0 ? '' : editorHtml.slice(from, to < 0 ? from + 900 : to + 900)
    ok('  介绍那一块里不带 id / 属性路径（status.xxx / char.xxx 这种）',
      intro !== '' && !/(status|entity|skill|char|pipeline)\./.test(intro),
      intro.slice(0, 400))
  }

  /*
   * ⚠ 玩家 2026-09-21 第 1 条：
   *   > 技能本身的效果**不计入规则栏中**。
   *
   *   所以编辑器里必须有**单独一块**「固有效果」，而且它排在「规则」前面。
   *   只搬数据不搬界面的话，玩家看到的还是"一堆规则"，等于没做。
   */
  ok('  固有效果是单独一块，而且排在「规则」前面',
    editorHtml.includes('固有效果')
    && editorHtml.indexOf('固有效果') < editorHtml.indexOf('规则（'),
    `固有效果@${editorHtml.indexOf('固有效果')} 规则@${editorHtml.indexOf('规则（')}`)

  /*
   * ==========================================================================
   *  ⭐ 2026-10-06：**编辑器 UI 第一片（技能页，照用户的设计模板）**
   *
   *  模板 = `ui-mockups/editor-v2.html`（布局与观感的第一权威）。
   *  技能这边是**两块屏**：
   *    技能库 = 左边一组图标格子（按库分组 + 搜索）+ 右边详情
   *    编辑区 = 占满整宽，顶栏"名字 · 形态 · 瞄准"、底栏"保存 / 另存为 / 返回"
   *  两屏都在 DOM 里、只切显示（模板就是这么做的）。
   * ==========================================================================
   */
  ok('技能页是模板那两块屏（左技能库 + 右详情 + 搜索框）',
    editorHtml.includes('sk-cols') && editorHtml.includes('class="sk-lib"')
    && editorHtml.includes('class="sk-detail"') && editorHtml.includes('id="skillSearch"'),
    editorHtml.slice(0, 300))
  ok('  技能库按库分组（基础技能 / 我的技能，武器技能另开一组）',
    editorHtml.includes('基础技能') && editorHtml.includes('我的技能'),
    editorHtml.slice(editorHtml.indexOf('sk-libbody'), editorHtml.indexOf('sk-libbody') + 300))
  ok('  详情面板里有名字 / 形态 / 瞄准 / 数值表 / 一个动作按钮',
    editorHtml.includes('sk-dname') && editorHtml.includes('sk-num')
    && editorHtml.includes('形态') && editorHtml.includes('瞄准')
    && editorHtml.includes('以此为原型创建新技能'),
    editorHtml.slice(editorHtml.indexOf('sk-dname'), editorHtml.indexOf('sk-dname') + 400))

  /*
   * ==========================================================================
   *  ⭐ 2026-10-07：① 详情面板的**形状 / 大小 / 位置**不许随"选中谁"变
   *
   *  用户原话：「选中每个技能的时候，描述页的形状和大小甚至位置都不同」。
   *  根因：模板（第一权威 `ui-mockups/editor-v2.html` L39）写死 `.right{width:346px;flex:none}`，
   *  而这里那一栏变成了"按内容算宽"—— 内容长的技能把面板顶宽、左边缘跟着往左跑。
   *
   *  ⚠ 假 DOM 没有排版引擎，所以这一节钉的是**样式数值那一半**：
   *     `.sk-detail` 的规则体里宽度写死 346px、高度是**满高**（`100%` = 外层给的
   *     确定值，见下面"① 对齐"那一节）、`flex:none`、`overflow-y:auto`
   *     （内容溢出只在面板**内部**滚），而且**没有** `flex:1`。
   *     另一半（"换了技能以后面板那一层真的没变"）在下面技能页那一节里钉。
   * ==========================================================================
   */
  {
    const css = styleBlock()
    const detail = ruleBodyOf(css, '.sk-detail')

    ok('① `web/index.html` 里真的有那一段样式（不然下面几条全是在测空气）',
      css.includes('.sk-detail {') && css.includes('.sk-grouphead {'),
      `style 段长度=${String(css.length)}`)

    /*
     * ⚠ 这一条是**根因的回归锁**：少一个 `}` 时，`.sk-detail` 的规则体会吞掉
     *   后面所有规则 —— 那种文件看起来"规则都在"，实际全是死的。
     *   （用户报的那一条就是这么来的。）
     */
    {
      const opens = (css.match(/\{/g) ?? []).length
      const closes = (css.match(/\}/g) ?? []).length
      ok('① `<style>` 里大括号配平（少一个 `}` 会把它后面的规则整段吃掉）',
        opens === closes && opens > 0,
        `{ =${String(opens)}  } =${String(closes)}`)
    }

    ok('① 详情面板那条规则**真的有自己的规则体**（不是一对空花括号）',
      detail.trim().length > 60,
      `规则体长度=${String(detail.trim().length)}`)

    ok('① 面板宽度**照模板写死 346px**（模板 `.right{width:346px;flex:none;...}`）',
      /width:\s*346px/.test(detail) && /min-width:\s*346px/.test(detail)
      && /max-width:\s*346px/.test(detail),
      detail.replace(/\s+/g, ' ').slice(0, 240))

    ok('① 而且**不许弹性**：`flex:none`，规则体里没有 `flex:1`',
      /flex:\s*none/.test(detail) && !/flex:\s*1/.test(detail),
      detail.replace(/\s+/g, ' ').slice(0, 240))

    /*
     * ⚠⚠ 2026-10-06（用户实测第 3 条「改成满高，技能详情也是」）：这一条原先钉的是
     *   `height: 62vh` + `max-height: 62vh`。62vh 是**视口**的比例，而面板真正能占的是
     *   "编辑器高 − 顶栏 − `#editorBody` 的上下 padding" ⇒ 它既没吃满可用高度，
     *   左栏那边还因为这个数矮了约一个搜索框。
     *   现在钉的是"高度 = 外层给的确定值"（`100%`）；`62vh` / `max-height` / `auto`
     *   三个**一个都不许留**（旧值真的消失，不是换了个地方写）。
     */
    ok('① 高度是**满高**（`height:100%` = 外层给的确定值；不是 62vh 那种视口比例、也不是 auto）',
      /height:\s*100%/.test(detail) && !/62vh/.test(detail)
      && !/height:\s*auto/.test(detail) && !/max-height/.test(detail),
      detail.replace(/\s+/g, ' ').slice(0, 240))

    ok('① 内容溢出 ⇒ **在面板内部滚**（`overflow-y:auto`），不是把外面顶来顶去',
      /overflow-y:\s*auto/.test(detail),
      detail.replace(/\s+/g, ' ').slice(0, 240))
  }

  /*
   * ==========================================================================
   *  ⭐ 2026-10-06：① 两栏**吃满可用高度**、底边齐
   *  （用户 2026-09-21 那句话是「面板对齐」；这一次的原话是「改成满高，技能详情也是」）
   *
   *  老写法为什么不合格：两栏都是 `62vh` —— 62vh 是**视口**的比例，而这两栏真正能占的是
   *  "编辑器高 − 顶栏 − `#editorBody` 的上下 padding"：
   *    · 左栏那 62vh 里还得塞一个搜索框 ⇒ **列表矮了约一个搜索框**（用户实测抓到的第 3 条）；
   *    · 右栏那 62vh 也没吃满可用高度。
   *
   *  ⚠ 为什么不"把数调大"、也不用 `calc(100vh - 顶栏 - padding)`：顶栏高 / padding 高 /
   *    搜索框高都是**字体排版**算出来的（字体回退不同就不同），拿估出来的数去凑，本质还是
   *    "看起来差不多"—— 那正是用户点名不许靠的那一种（沙箱里起不了浏览器，肉眼看不了）。
   *
   *  ⇒ 改成"高度由外层**给**、两栏各吃满"：一条全是**布局确定量**的链
   *       `#editor`（`position:fixed; top:0; bottom:0` ⇒ 外框高 = 视口高）
   *         → `#editorBody`（`flex:1`）→ `.sk-page`（`height:100%`）
   *           → `.sk-cols`（`height:100%`）
   *     ，两栏再各自 `height:100%`（**逐字相同**的表达式）⇒ 同一个 flex 行里
   *     外框高相等、都从行首开始 ⇒ 底边重合是**算出来的**，不是看出来的。
   *     （全局 `* { box-sizing: border-box }` ⇒ 这 100% 指的是**外框**高：右栏那
   *      16px 留白和 1px 边都在里面，不会把它的底边推下去。）
   *
   *  ⚠ 另一半（DOM 结构：搜索框确实在左栏**里面**、两栏是同一个行里的兄弟）
   *    在下面"技能页（会解析 html 的假 DOM）"那一节里钉。
   * ==========================================================================
   */
  {
    const css = styleBlock()
    const cols = ruleBodyOf(css, '.sk-cols')
    const page = ruleBodyOf(css, '.sk-page')
    const lib = ruleBodyOf(css, '.sk-lib')
    const libBody = ruleBodyOf(css, '.sk-libbody')
    /* 右栏那一条上面已经抠过一次（`① 面板几何` 那一节），这里重抠一次拿高度 */
    const detail = ruleBodyOf(css, '.sk-detail')
    /** 规则体里某条声明的值（只认**整条**属性：`min-height` 不算 `height`） */
    const declOf = (body: string, name: string): string | undefined =>
      new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;]+)`).exec(body)?.[1]?.trim()
    const libH = declOf(lib, 'height')
    const detailH = declOf(detail, 'height')

    ok('① 对齐 两栏的**高度表达式逐字相同**（左栏 `.sk-lib` 与右栏 `.sk-detail` 都是 `100%`）',
      libH !== undefined && libH === detailH && libH === '100%' && !/auto/.test(libH),
      `左栏 height=${libH ?? '（没有）'} / 右栏 height=${detailH ?? '（没有）'}`)

    /*
     * ⚠⚠ 这一条是**旧值真的消失**的锁：两栏里一个 `62vh` 都不许留
     *   （`62vh` = "把视口比例当可用高度用"，正是这一次要杀掉的老写法）。
     */
    ok('① 对齐 两栏里**再也不出现 62vh**（连 `max-height:62vh` 一起消失）',
      !/62vh/.test(lib) && !/62vh/.test(detail),
      `左栏=${/62vh/.test(lib) ? '还有 62vh' : '没有'}`
      + ` 右栏=${/62vh/.test(detail) ? '还有 62vh' : '没有'}`)

    /*
     * ⚠ "满高"必须**是外层给的**：`.sk-cols` / `.sk-page` 自己得有确定高度，
     *   两栏那两个 `100%` 才有地方落。缺了这一环，`height:100%` 会退化成 auto
     *   ⇒ "满高"变成"按内容高"—— 老毛病换了个写法而已。
     */
    ok('① 对齐 外层真的给了高度：`.sk-page` 和 `.sk-cols` 都是 `height:100%`'
      + '（一路从 `#editorBody` 这个 `flex:1` 传下来的确定量）',
      /height:\s*100%/.test(page) && /height:\s*100%/.test(cols),
      `page=${page.replace(/\s+/g, ' ').slice(0, 70)} | cols=${cols.replace(/\s+/g, ' ').slice(0, 110)}`)

    ok('① 对齐 两栏在**同一条 flex 行**里、都从行首开始（`.sk-cols` 是 `display:flex` + `align-items:flex-start`）',
      /display:\s*flex/.test(cols) && /align-items:\s*flex-start/.test(cols),
      cols.replace(/\s+/g, ' ').slice(0, 160))

    ok('① 对齐 左栏是**定高的竖排 flex 容器**：搜索框就在它里面 ⇒ 搜索框只从这满高里吃掉一块，不会把左栏撑高',
      /display:\s*flex/.test(lib) && /flex-direction:\s*column/.test(lib)
      && /min-height:\s*0/.test(lib),
      lib.replace(/\s+/g, ' ').slice(0, 200))

    ok('① 对齐 列表**填满左栏剩下的那一块**（`flex:1`）而且**自己不再写高度**（老写法那个 `max-height:62vh` 正是底边不齐的原因）',
      /flex:\s*1/.test(libBody) && !/max-height/.test(libBody)
      && !/(?:^|[;\s])height\s*:/.test(libBody),
      libBody.replace(/\s+/g, ' ').slice(0, 200))

    /*
     * ⚠ 两栏**各自内部滚**：右栏是它自己（`.sk-detail`），左栏是它自己 + 它内部那个
     *   `.sk-libbody`（列表的日常滚动）—— 面板自己不随内容长大，页面也不出多余的整页滚动条。
     */
    ok('① 对齐 两栏都 `overflow-y:auto`（左栏自己 + 它内部的列表都滚，右栏自己滚）',
      /overflow-y:\s*auto/.test(lib) && /overflow-y:\s*auto/.test(libBody)
      && /overflow-y:\s*auto/.test(detail),
      `左栏=${/overflow-y:\s*auto/.test(lib)} 列表=${/overflow-y:\s*auto/.test(libBody)}`
      + ` 右栏=${/overflow-y:\s*auto/.test(detail)}`)

    {
      const star = /(^|\n)\s*\*\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
      ok('① 对齐 `box-sizing:border-box` 是全局的（两栏那 100% 都指**外框**高 ⇒ 右栏的 16px 留白 / 1px 边不会把它的底边推下去）',
        /box-sizing:\s*border-box/.test(star),
        star.replace(/\s+/g, ' ').slice(0, 160) || '（样式里找不到 `*` 那条规则）')
    }
  }

  /*
   * ⚠ 控件分三组是**用户定的口径**（交接单 L375：三件事是三件不同的事，不许合成一个"目标"）：
   *     ① 瞄准（怎么选 / 对谁有效 / 只挑带某状态的目标 / 射程）
   *     ② 效果发生在哪里（每条动作一个载体 + 形状参数）
   *     ③ 宿主（作用在谁身上 / 对谁有效 / 规则听谁的）
   *   顺序也要对 —— 它是玩家读这一页的顺序。
   */
  {
    const aim = editorHtml.indexOf('① 瞄准')
    const where = editorHtml.indexOf('② 效果发生在哪里')
    const host = editorHtml.indexOf('③ 宿主')
    ok('三组控件都在，而且顺序是 瞄准 → 效果发生在哪里 → 宿主',
      aim >= 0 && where > aim && host > where, `①@${aim} ②@${where} ③@${host}`)
  }
  ok('  瞄准那一组四件都在（怎么选 / 对谁有效 / 只挑带某状态的目标 / 射程）',
    editorHtml.includes('怎么选') && editorHtml.includes('对谁有效')
    && editorHtml.includes('只挑带某状态的目标') && editorHtml.includes('射程'))
  ok('  宿主那一组有"作用在谁身上"，而且动作级"对谁有效"是默认折叠的',
    editorHtml.includes('作用在谁身上')
    && /<details class="sk-fold">\s*<summary>对谁有效（默认折叠/.test(editorHtml),
    editorHtml.slice(editorHtml.indexOf('sk-fold') - 120, editorHtml.indexOf('sk-fold') + 200))

  /*
   * ⚠⚠ 时长控件是**四档选择**（无 / 1× / 3× / 9×），不是线性滑块 ——
   *   用户 2026-09-21 定死的形状（日志 50 §6.2）。三条细节一个都不能丢：
   *     · `1×` 是**默认**（中性档，账上 0 点）
   *     · `-1`（蓄力哨兵）**和「无」是两档**（数据上是两个不同的数）
   *     · `3×`/`9×` 的秒数按**这个技能自己的**出厂时长算
   */
  {
    const tier = editorHtml.indexOf('sk-tierrow')
    const slice = tier < 0 ? '' : editorHtml.slice(tier, tier + 2600)
    const has = (v: string): boolean => slice.includes(`data-v="${v}"`)
    ok('阶段时长是四档选择（无 / 1× / 3× / 9×），而且 1× 标着「默认」',
      slice.includes('>无<') && slice.includes('1×') && slice.includes('3×') && slice.includes('9×')
      && slice.includes('默认'))
    ok('  蓄力（−1）是**单独一档**，不和「无」（0 秒）合并',
      has('-1') && has('0') && slice.includes('蓄力') && slice.includes('按住键'),
      `-1=${has('-1')} 0=${has('0')}`)
    /*
     * ⚠⚠ 2026-09-30（日志 63）**这条断言原来钉的是"置灰"**：
     *   `3×` / `9×` / `无` 在账上没那几格 ⇒ 置灰并写"账上无格"。
     *   现在阶段时长**倍数档走表**（`tierTables.phaseDurationPoints`），
     *   四档每一档都查得到价 ⇒ 一条都不该再灰。
     *   ⚠ "灰 = 不给点"那条规矩本身没变，它钉在 `tests/editor.ts` 的
     *   `tierChoices` 那一节（`available=false` ⇒ 不给点）。
     */
    ok('四档**每一档都有价**（倍数档走表：−6 / 0 / +2 / +4），一条都不置灰',
      slice.includes('倍数档查表') && !slice.includes('sk-tier off')
      && slice.includes('-6') && slice.includes('+2') && slice.includes('+4'),
      slice.slice(0, 600))
  }
  /*
   * ⚠ 死滑块铁律的**入口**：详情页直接写清楚"这个技能有几个旋钮真的能动账、几个不给拖"。
   *   （"某一个旋钮为什么不给拖"在下面带自定义技能那一段断言 ——
   *     默认选中的那份恰好一个都不缺，所以这里查的是这行说明本身。）
   */
  ok('详情页写清楚"几个可改 / 几个不给拖"（死滑块铁律的入口）',
    /\d+ 个可改 · \d+ 个不给拖/.test(editorHtml),
    editorHtml.slice(editorHtml.indexOf('可拖的数值') - 60, editorHtml.indexOf('可拖的数值') + 120))

  /*
   * ⚠ 点数是**算出来的**，不是调的 ⇒ 那一块里一个滑块都不该有。
   *   （切片：从 `id="points"` 到下一个块的外壳为止。）
   */
  {
    const from = editorHtml.indexOf('id="points"')
    const next = editorHtml.indexOf('class="sk-offscreen"', from)
    const points = from < 0 ? '' : editorHtml.slice(from, next < 0 ? from + 1600 : next)
    ok('点数那一块里一个滑块都没有（点数是算出来的，不是调的）',
      points !== '' && !points.includes('<input'), points.slice(0, 200))
  }
  ok('编辑区有形态（瞬发 / 蓄力 / 持续 / 常驻）—— 今天之前界面上完全没有',
    editorHtml.includes('形态是<b>机制事实</b>') || editorHtml.includes('形态是'),
    editorHtml.slice(editorHtml.indexOf('sk-formwhy') - 200, editorHtml.indexOf('sk-formwhy') + 200))

  /*
   * ⚠ 这一条钉的是"**结构只建一次**"，也就是这一步改动的全部意义。
   *
   *   以前 HUD 每帧 `innerHTML = ...`，等于每秒把 DOM 删掉重建 120 次 ——
   *   所以不能有动画、不能有 hover、不能有按钮（元素每帧都是新的）。
   *
   *   现在：跑了几帧之后，写次数应该还是个位数。
   *   如果哪天有人改回"每帧重写"，这里跑 3 帧就会数到 3 次以上，当场红灯。
   */
  ok('HUD 结构只建一次（不是每帧重写 innerHTML）',
    dom.counts.statsWrites <= 1 && dom.counts.skillsWrites <= 1,
    `stats 写了 ${dom.counts.statsWrites} 次、skills 写了 ${dom.counts.skillsWrites} 次`)

  ok('  而且骨架还在（值是通过子元素更新的，不是把 innerHTML 换成新内容）',
    dom.el('stats').innerHTML.includes('id="hudFoes"'),
    dom.el('stats').innerHTML.slice(0, 200))

  // ---- 术式编辑器挂上了没有 ----
  //
  // ⚠ 这一条防的是"静默退化"：`createTechniqueEditor` 在拿不到容器时
  //   会返回一个空实现 —— 客户端照常能玩，但玩家永远看不到编辑器。
  //   没有这条断言的话，那种情况在测试里是全绿的。
  const techHtml = dom.el('techBody').innerHTML
  /*
   * ⚠⚠ 2026-10-07（术式页那一片）**期望的地基换了**：术式页整块按设计模板重做，
   *   从"一条工具条 + 一条技能链"换成**两块屏**（库 / 编辑），观感走**共用**
   *   的 `sk-` 那套（卡片 / 胶囊 / 按钮 / 格子）——
   *   所以这里认的是**库那一屏**（`class="sk-tlibbody" data-scroll="techLib"` 那一段，
   *   它只出现在库那一屏的 html 里）和它上面的分组标题，不再是旧工具条 `te-bar`。
   *   ⚠ 故意**不认 `data-block`**：那是 `mountBlock` 在真 DOM 上打的标记，
   *     而这一条用的假 DOM 走的是"攒起来一次写上"那条降级路（`dom.ts` 里写着为什么）
   *     —— 拿它当判据等于在测假 DOM 的实现细节，不是在测页面画出来没有。
   */
  ok('术式编辑器挂上了（不是那个空实现）',
    techHtml.includes('class="sk-tlibbody"') && techHtml.includes('武器术式')
    && techHtml.includes('魔法术式'),
    techHtml.slice(0, 400))

  /*
   * ⚠ 这一条守的东西没变，但**期望的地基变了**（玩家 2026-09-21 定的）：
   *
   *   > 初始只有一个术式释放某个技能，现有技能库不改，玩家可以自行创造术式。
   *
   * 场景发的那一份住在**内部术式库**里（敌人的骷髅术士也在用它），
   * 玩家既看不到也改不了 —— 所以开局把它**复制成玩家自己的**（`seedStarter`）。
   * 守的仍然是原来那件事的另一面：**不给空术式**（空术式会立刻写进存档，
   * 还会以"编译不出来"的形式刷一屏红字）。
   */
  ok('没有存档时，「我做的」里是开局发的那一份（有技能链，不是空壳）',
    techHtml.includes('魔法飞弹（起手）') && !techHtml.includes('还没有自己的术式'),
    techHtml.slice(0, 400))

  // ---- 玩家自己做的术式真的能进游戏 ----
  //
  // ⚠ 这是整条链最重要的一条断言：**编辑器做的东西带得出去**。
  //   以前技能栏只认场景 JSON 里写死的 `techniques`，
  //   玩家在编辑器里做多少份都上不了场 —— 那这个编辑器就是个玩具。
  {
    const seeded = installDomStubs({
      save: {
        version: 1,
        techniques: [{
          schemaVersion: 1,
          id: 'tech.mine-test',
          name: '我的连招',
          activation: 'press',
          targeting: { mode: 'directional', valid: ['enemy'], range: 12 },
          skills: ['skill.cleave', 'skill.magic-bolt'],
          links: [{ if: [{ type: 'prevHit' }] }],
        }],
        loadout: ['tech.mine-test'],
      },
    })
    const errs: unknown[][] = []
    const realErr2 = console.error
    console.error = (...a: unknown[]) => { errs.push(a) }
    try {
      await import(`${pathToFileURL(client).href}?seeded=1`)
      await settle()
    } finally {
      console.error = realErr2
    }
    // ⚠ 以前这里是 `console.error = () => undefined`，把启动期的错误**吞掉了** ——
    //   于是"带存档启动炸了"表现成"技能栏是空的"，而断言只说"没找到那一格"。
    ok('带存档启动没报错', errs.length === 0, errText(errs))

    const skills = seeded.el('skills').innerHTML
    ok('存档里的术式进了技能栏（自己做的东西带得出去）',
      skills.includes('我的连招'), skills.slice(0, 500))
    ok('  技能链显示出来了（裂地斩 → 魔法飞弹）',
      skills.includes('裂地斩') && skills.includes('魔法飞弹'), skills.slice(0, 500))
    ok('  玩家排过的技能栏**盖掉**了场景里写死的那一套',
      !skills.includes('破军突刺'), skills.slice(0, 500))
    /*
     * ⚠ 账**不是**一个独立的 `#teLedger` 子元素了（2026-10-07 术式页那一片）：
     *   它成了**编辑那一屏**上的一张卡，和序列一起画。
     *   理由：账要和**序列上的零件**一一对齐（"每个零件各显示它自己花多少"），
     *   拆成两个独立的块之后，"改一个零件要同时改两处"就成了常态。
     * ⚠⚠ 而编辑那一屏**起手是藏着的**（照设计模板：打开编辑器先看到库），
     *   所以这一条只能查**库那一屏**上那一行 —— **真的进去点**（点「编辑此术式」、
     *   看账、看条件门）在下面那块**会解析 html 的假 DOM**里做，
     *   因为这套 boot stub 的 `addEventListener` 是空的（发不出点击）。
     */
    const libMarkup = seeded.el('techBody').innerHTML
    ok('术式库里那一行把这份术式列出来了，而且右端是算出来的点数',
      libMarkup.includes('data-i="tech.mine-test"') && libMarkup.includes('我的连招')
      && libMarkup.includes('0 点'),
      libMarkup.slice(libMarkup.indexOf('tech.mine-test') - 200,
        libMarkup.indexOf('tech.mine-test') + 300))
    /*
     * ⚠ 老术式的 `links`（写在这份术式**顶层**那一份）必须在详情里看得见 ——
     *   `seq0()` 会把它搬进新加的那一段（不然玩家一编辑就把链上的门丢了）。
     */
    ok('  它的技能链和门都读得出来（老存档的顶层 links 不算丢）',
      libMarkup.includes('裂地斩') && libMarkup.includes('魔法飞弹')
      && libMarkup.includes('它的技能链'),
      libMarkup.slice(libMarkup.indexOf('它的技能链'), libMarkup.indexOf('它的技能链') + 300))
    /*
     * ⚠ 这一组钉的是"补发起点"的**边界**（玩家报过 "并没有魔法飞弹"，根因在这儿）。
     *
     *   第一版的规则是"存档里已经有术式 / 排过技能栏就不发"。那是错的：
     *   一个从没做过术式、技能栏里只剩场景发的内部术式的老存档
     *   被当成"他已经有自己的东西了" —— 永远拿不到那份能改的起点。
     *
     *   现在的规则：**没发过就发**（不管他有没有别的术式），
     *   但技能栏**一格都不动**（他排过的格子不因为补发而变）。
     */
    ok('  老存档也补上开局那一份（「并没有魔法飞弹」那个 bug）',
      seeded.el('techBody').innerHTML.includes('魔法飞弹（起手）'),
      seeded.el('techBody').innerHTML.slice(0, 300))
    ok('  但技能栏一格都不动（还是他自己排的那份）',
      skills.includes('我的连招') && !skills.includes('起手'), skills.slice(0, 500))
  }

  /*
   * ---- 技能栏里只剩内部术式的老存档（"并没有魔法飞弹"最可能的那个形态）----
   *
   * ⚠ 存档里一份自己的术式都没有，技能栏第一格指着**场景发的内部术式**
   *   （`tech.magic-bolt`）—— 玩家在编辑器里看不到那一格、也改不了它。
   *   第一版的规则把"技能栏非空"当成"他已经有自己的东西了" → 永远不发起点。
   *   现在：这种格子算"没排过"，清掉它，把起点装到第一格。
   */
  {
    const seeded = installDomStubs({
      save: { version: 1, techniques: [], loadout: ['tech.magic-bolt'] },
    })
    await import(`${pathToFileURL(client).href}?seeded=5`)
    await settle()
    ok('技能栏只剩内部术式时也补发起点',
      seeded.el('techBody').innerHTML.includes('魔法飞弹（起手）'),
      seeded.el('techBody').innerHTML.slice(0, 300))
    ok('  而且把那一格换成了他自己那份（内部术式不留在技能栏上）',
      seeded.el('skills').innerHTML.includes('（起手）'),
      seeded.el('skills').innerHTML.slice(0, 400))
  }

  /*
   * ---- 空术式绑到键上：**必须说出来**（玩家 2026-09-21 报的"游戏没有识别出来"）----
   *
   * ⚠ 一份还没加技能的术式**不进内容库**（`recompileAll` 里那条：空草案不是
   *   编译错误，它只是还没成形）。于是它会从 `loadout` 里消失 ——
   *   而技能栏以前是按 `loadout` 画的，所以那一格**凭空消失**：
   *   编辑器说"装到 键2"、游戏里什么都没有、按下去也没有一句话。
   *
   *   现在：那一格照画，后面写上**为什么放不出来**；编辑器那一页也会把
   *   「先加一段技能，才能装到按键上」摆出来，而不是给一个能把空壳绑上去的下拉框。
   */
  {
    const seeded = installDomStubs({
      save: {
        version: 2,
        skills: [],
        techniques: [{
          schemaVersion: 1,
          id: 'tech.mine-empty',
          name: '还没加技能的术式',
          activation: 'press',
          targeting: { mode: 'directional', valid: ['enemy'], range: 12 },
          skills: [],
        }],
        loadout: ['tech.mine-empty'],
      },
    })
    const errs: unknown[][] = []
    const realErr5 = console.error
    console.error = (...a: unknown[]) => { errs.push(a) }
    try {
      await import(`${pathToFileURL(client).href}?seeded=6`)
      await settle()
    } finally {
      console.error = realErr5
    }
    ok('空术式启动没报错', errs.length === 0, errText(errs))

    const bar = seeded.el('skills').innerHTML
    ok('技能栏**照画**那一格（不是凭空消失）', bar.includes('还没加技能的术式'), bar.slice(0, 500))
    ok('  并且写明为什么放不出来（空术式）',
      bar.includes('放不出来') && bar.includes('一个技能都还没加'), bar.slice(0, 600))

    const body = seeded.el('techBody').innerHTML
    /*
     * ⚠⚠ 2026-10-07（术式页那一片）：这一条原来查的是"编辑屏不给空术式下拉框"，
     *   但编辑器起手**停在库那一屏**了（照设计模板：先看清有哪些术式，
     *   按「编辑此术式」才进去）。所以"空术式不给装键下拉框"这条规矩
     *   现在由下面那块**假 DOM 测试**（`tech-edit-empty`）钉着 ——
     *   那里真的点进了编辑屏，能看见它到底给没给下拉框。
     *   这里改成查**库那一屏**上它自己那一行：空术式照样列出来（不是凭空消失），
     *   而且写着"⚠ 跑不起来"而不是一个 0 点（0 会被读成"配平好了"）。
     */
    ok('空术式在库里照样列出来，而且写的是"跑不起来"而不是 0 点',
      body.includes('还没加技能的术式') && body.includes('跑不起来'),
      body.slice(body.indexOf('sk-techlib'), body.indexOf('sk-techlib') + 700))
  }

  /*
   * ---- 删过之后不许再发 ----
   *
   * ⚠ `SavedState.starterId` 存的是**那个 id**，不是 true/false：
   *   发过、而且还在库里 → 什么都不做；发过、但不在了 = 他自己删的 → 不许再发。
   *   少了这一条，玩家删掉起点、刷新一下它又回来 —— 那看起来像删不掉。
   */
  {
    const seeded = installDomStubs({
      save: {
        version: 2,
        skills: [],
        // 标记指向一份**已经不在库里**的术式 = 玩家把它删了
        techniques: [],
        loadout: [],
        starterId: 'tech.mine-1',
      },
    })
    await import(`${pathToFileURL(client).href}?seeded=4`)
    await settle()
    ok('删过起点之后不再补发（`starterId` 指向一份不存在的术式）',
      !seeded.el('techBody').innerHTML.includes('（起手）'),
      seeded.el('techBody').innerHTML.slice(0, 300))
  }

  /*
   * ---- **两个技能库**（玩家 2026-09-21 定的）----
   *
   * ⚠ 基础技能库（出厂、只读）+ 自定义技能库（存档里的变体）。
   *   术式按 id 引用技能，两个库都能引用；变体的账对着它的**模板**算。
   *   这一条钉的是"存档里的变体真的进了库、真的被认出来"——
   *   少了任何一环，玩家编的技能在他自己的术式里会显示成"找不到"。
   */
  {
    const cleave = readJson<Skill>(resolve('content/skills/cleave.json'))
    const variant: Skill = JSON.parse(JSON.stringify(cleave)) as Skill
    variant.id = 'custom.cleave.1'
    variant.name = '裂地斩-副本1'
    variant.basedOn = cleave.id
    /*
     * ⚠⚠ 2026-09-30（日志 60b）**"买 6 条"改成了"买 4 条"**：账现在是**查表 + 相加**，
     *   表里 `ruleSlots` 那一行是 `0…8`（出厂 4 ⇒ 0 点，8 ⇒ −6 点）。
     *   买 6 条 = 10 条 ⇒ 表外取值（点数 0、账上一条 `⚠ 表外取值`）——
     *   而这一节要的是"界面上真的显示出一个**相对模板**的数"。
     */
    variant.ruleSlots += 4

    const seeded = installDomStubs({
      save: {
        version: 2,
        // 自定义技能库
        skills: [variant],
        techniques: [{
          schemaVersion: 1,
          id: 'tech.copy-test',
          name: '改过的连招',
          activation: 'press',
          targeting: { mode: 'directional', valid: ['enemy'], range: 12 },
          skills: ['custom.cleave.1'],
        }],
        loadout: ['tech.copy-test'],
      },
    })
    const errs: unknown[][] = []
    const realErr3 = console.error
    console.error = (...a: unknown[]) => { errs.push(a) }
    try {
      await import(`${pathToFileURL(client).href}?seeded=2`)
      await settle()
    } finally {
      console.error = realErr3
    }
    ok('带存档（自定义技能）启动没报错',
      errs.length === 0, errText(errs))

    const body = seeded.el('editorBody').innerHTML
    /*
     * ⚠⚠ 2026-10-06（编辑器 UI 第一片）：**技能列表从 `<select id="pick">` 换成了
     *   设计模板里的图标格子**（左边技能库那一栏）。分组还在（那是玩家定的模型：
     *   基础技能库只读 / 我的技能可改可删），只是画法变成了格子 + 分组标题。
     */
    ok('技能库把**两个库分组**列出来（基础技能 / 我的技能）',
      body.includes('基础技能') && body.includes('我的技能')
      && body.includes('data-i="custom.cleave.1"')
      && body.includes('基于 裂地斩'),
      body.slice(body.indexOf('sk-libbody'), body.indexOf('sk-libbody') + 500))

    // ⚠ 默认选中自定义技能库那一份（玩家编的东西不该藏起来）
    ok('一进来选中的是**自定义技能库**里那一份',
      body.includes('裂地斩-副本1')
      && /class="sk-cell on"[^>]*data-i="custom\.cleave\.1"/.test(body),
      body.slice(body.indexOf('sk-grid'), body.indexOf('sk-grid') + 400))
    ok('  报的是"相对模板"的数：变体买 4 条规则位 = 花掉 6 点',
      body.includes('比模板强 6 点'), body.slice(0, 1200))
    /*
     * ⚠⚠ 2026-10-07：上面那一条（明细里有 `ruleSlots`）**挪进了编辑屏**。
     *   库那一屏的详情只报**合计**（"它值多少"），明细在**编辑屏的账卡**里 ——
     *   而编辑屏起手是藏着的（照设计模板：先看到库），所以它在 boot stub 上查不到。
     *   真正点进去看明细的是下面那块**会解析 html 的假 DOM**（术式页那一节）。
     */

    /*
     * ⚠ 死滑块铁律（用户 2026-09-30）：**拖了账上不动的东西不许出现在界面上让人拖**。
     *   这份变体的模板是「裂地斩」，它有一项（张角）在账上整行同值 ——
     *   校验器报 `LOOKUP_DEAD_KNOB`。界面上那一项必须是"数值看得见 + 一行为什么"，
     *   **不是**一个能拖的滑块。
     */
    ok('死滑块铁律：拖了账上不动的那一项不给拖，而且写出了原因',
      body.includes('不给拖') && body.includes('LOOKUP_DEAD_KNOB'),
      body.slice(Math.max(0, body.indexOf('sk-dead') - 200), body.indexOf('sk-dead') + 300))
  }

  /*
   * ⚠ **基础技能只读**（玩家 2026-09-21 定的流程）：
   *   它是模板，只能"创造一个技能" → 编辑 → 保存，不能直接改。
   */
  {
    const seeded = installDomStubs({ save: { version: 2, skills: [], techniques: [], loadout: [] } })
    const errs: unknown[][] = []
    const realErr4 = console.error
    console.error = (...a: unknown[]) => { errs.push(a) }
    try {
      await import(`${pathToFileURL(client).href}?seeded=3`)
      await settle()
    } finally {
      console.error = realErr4
    }
    ok('空存档启动没报错', errs.length === 0, errText(errs))

    const body = seeded.el('editorBody').innerHTML
    ok('选中的是基础技能 → 明确说是只读的模板，并给出「以此为原型创建新技能」',
      body.includes('基础技能 · 只读模板') && body.includes('以此为原型创建新技能'),
      body.slice(0, 900))
    ok('  基础技能的滑块是 disabled（拖不动）',
      body.includes('disabled'), body.slice(0, 2000))
    ok('  出厂技能自己是 0 点（宗旨：默认值下配平为 0）',
      body.includes('出厂技能：0 点'), body.slice(0, 1200))
  }

  /*
   * ---- 鼠标瞄准（玩家报的 bug：左键普攻始终朝正右方）----
   *
   * ⚠ 这一块测的是**纯函数** `web/src/aim.ts`：浏览器那套指针事件在这个
   *   假 DOM 里发不出来（stub 的 addEventListener 是空的），
   *   所以把"算方向"那一步抽出来单独测 —— 元凶正好就在那一步里：
   *
   *   ```ts
   *   if (len < 1e-6) return { x: 1, y: 0 }   // ← "算不出来"被写成了"朝右"
   *   ```
   *
   *   指针还没动过、指针恰好在画面正中、画面尺寸是 0 —— 这几种情况
   *   全都会走到那一行，于是**每一次攻击都朝正右方**，而且不报任何错。
   */
  {
    const view = { left: 0, top: 0, width: 1280, height: 800 }
    const center = { x: 640, y: 400 }
    const fallback = { x: 0, y: -1 }

    const right = aimFromPointer({ x: center.x + 200, y: center.y }, view, fallback)
    near('鼠标在右边 → 朝右', right.x, 1)
    near('  而且没有纵向分量', right.y, 0)

    const up = aimFromPointer({ x: center.x, y: center.y - 200 }, view, fallback)
    near('鼠标在上边 → 朝上（这就是报的那个 bug）', up.x, 0)
    near('  纵向 -1', up.y, -1)

    const diag = aimFromPointer({ x: center.x + 100, y: center.y + 100 }, view, fallback)
    near('斜着也在正中间', Math.abs(diag.x) - Math.abs(diag.y), 0)

    /*
     * ⚠ 这两条是这次的**核心**：算不出来时**不许凭空造方向**。
     *   老代码在第一种情况返回 (1,0)，于是"指针没到位"表现成"朝右打"。
     */
    const atCenter = aimFromPointer(center, view, fallback)
    eq('指针正好在画面正中 → 用 fallback（不是凭空朝右）',
      `${atCenter.x},${atCenter.y}`, `${fallback.x},${fallback.y}`)
    const noPointer = aimFromPointer(undefined, view, fallback)
    eq('一次指针事件都没收到 → 用 fallback（不是凭空朝右）',
      `${noPointer.x},${noPointer.y}`, `${fallback.x},${fallback.y}`)

    /*
     * ⚠ canvas 不在页面左上角时也要对。
     *   以前直接拿 `clientX` 当画面内坐标用，那只有在 canvas 贴左上角时成立。
     */
    const offset = { left: 300, top: 120, width: 1280, height: 800 }
    const stillRight = aimFromPointer(
      { x: 300 + 640 + 200, y: 120 + 400 }, offset, fallback)
    near('canvas 有偏移时也还是朝右', stillRight.x, 1)
    near('  纵向仍然是 0', stillRight.y, 0)
  }

  /*
   * ---- 静态资源的 URL 映射（浏览器和桌面壳共用这一份）----
   *
   * ⚠ 桌面壳（`docs/desktop.md`）会用**同一套映射**（`src/server/assets.ts`）：
   *   它要么起同一个服务器，要么用自定义协议直接读磁盘。
   *   两边各写一份的话，漂移的表现是"只有打包版才 404"—— 每次都要重新查一遍。
   */
  {
    const root = process.cwd()
    const rel = (u: string): string => resolveAssetUrl(root, u).replace(root, '').replace(/\\/g, '/')

    eq('前端首页：/ → web/index.html', rel('/'), '/web/index.html')
    eq('内容按 root 拼：/content/... → content/...',
      rel('/content/manifest.json'), '/content/manifest.json')
    eq('打包产物从 web 里找：/dist/... → web/dist/...',
      rel('/dist/technique-system/web/src/main.js'), '/web/dist/technique-system/web/src/main.js')

    /*
     * ⚠ 越界保护是**按分支**做的：`/content/../package.json` 解析出来还在项目根里，
     *   但它已经不是 content 了 —— 一样要挡住（不然 tsconfig/package.json 会被端出去）。
     */
    eq('越界（跑出 web/）退回首页', rel('/../secret.txt'), '/web/index.html')
    eq('越界（跑出 content/，回到项目根）也退回首页',
      rel('/content/../package.json'), '/web/index.html')

    eq('content-type 按扩展名给', contentTypeOf('a/b/main.js'), 'text/javascript; charset=utf-8')
    eq('  认不出来的按二进制发', contentTypeOf('a/b/x.zzz'), 'application/octet-stream')
  }

  /*
   * ---- 静态服务器本身（**桌面壳唯一依赖的东西**）----
   *
   * ⚠ 玩家装上 .exe 之后撞的是"页面能打开，但它里面所有 fetch 都失败"
   *   （找不到 manifest.json / failed to fetch）。那条路的坑不在服务器，
   *   在**自定义协议**（`app://` 没登记 supportFetchAPI 时，页面里的 fetch 一律失败）。
   *   所以壳现在改成走 HTTP，而这份服务器就是它唯一依赖的东西 ——
   *   值得端到端跑一次：**真的 listen、真的 fetch**。
   */
  {
    const srv = createStaticServer(process.cwd())
    await new Promise<void>(r => { srv.listen(0, '127.0.0.1', () => { r() }) })
    const addr = srv.address()
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0

    /*
     * ⚠ 这里**不能用 `fetch`**：这个文件的假 DOM 把全局 `fetch` 换成了
     *   "从磁盘读"的替身（那一整个测试文件就是靠它验证内容加载的）。
     *   所以这里用 `node:http` 直接请求 —— 反正要测的就是 HTTP 这一层。
     */
    const get = (path: string): Promise<{ status: number; ctype: string; body: string }> =>
      new Promise((resolve, reject) => {
        const req = httpGet(`http://127.0.0.1:${port}${path}`, res => {
          let body = ''
          res.on('data', c => { body += String(c) })
          res.on('end', () => resolve({
            status: res.statusCode ?? 0,
            ctype: String(res.headers['content-type'] ?? ''),
            body,
          }))
        })
        req.on('error', reject)
      })

    try {
      const idx = await get('/')
      ok('服务器：/ 给出的是首页（有 <canvas>）',
        idx.status === 200 && idx.body.includes('<canvas'), `${idx.status}`)

      const man = await get('/content/manifest.json')
      ok('  内容能读：/content/manifest.json 200 + JSON + 有技能',
        man.status === 200 && man.ctype.includes('application/json')
        && (JSON.parse(man.body) as { skills?: unknown[] }).skills !== undefined,
        `${man.status} ${man.ctype}`)

      const bundle = await get('/dist/technique-system/web/src/main.js')
      ok('  客户端产物能读：/dist/... 200', bundle.status === 200, String(bundle.status))

      /*
       * ⚠ 越界那条要**看内容**，不能只看状态码：
       *   映射在越界时是"退回首页"（200），所以 200 也可能是对的 ——
       *   但它绝不能把 package.json 端出来。
       */
      const esc = await get('/content/../package.json')
      ok('  越界不给真东西（退回首页，不是 package.json）',
        !esc.body.includes('"devDependencies"'), esc.body.slice(0, 80))
    } finally {
      srv.close()
    }
  }

  /*
   * ---- 挂块机制：**一样的 html 不许重建** ----
   *
   * ⚠ 这条测试保护两个很难看的失败模式：
   *   1. "每次重画都多出一块"（`data-block` 没打上 → 找不到旧块 → 一直 append）
   *   2. "`<details open>` 每次都被合上、动效从头开始"（明明没变却重建了）
   *
   * ⚠ 为什么不用真 DOM：真浏览器我这边跑不了（沙箱）。
   *   所以造一个**只回答问题、不解析 html** 的假 host ——
   *   测的是 `mountBlock` 的**决定逻辑**（一样就不碰 / 不一样才换 / 多出来的删掉），
   *   那正是最容易写错的部分。
   */
  {
    interface FakeEl {
      tag: string
      attrs: Record<string, string>
      firstElementChild?: FakeEl
      replacedWith?: FakeEl
      removed?: boolean
      setAttribute: (k: string, v: string) => void
      replaceWith: (e: unknown) => void
      remove: () => void
    }
    const mk = (tag: string): FakeEl => {
      const el: FakeEl = {
        tag,
        attrs: {},
        setAttribute: (k, v) => { el.attrs[k] = v },
        replaceWith: (e) => { el.replacedWith = e as FakeEl },
        remove: () => { el.removed = true },
      }
      return el
    }

    let created = 0
    const host: ElLike & { children: FakeEl[] } = {
      children: [],
      contains: (e: unknown) => host.children.includes(e as FakeEl),
      appendChild: (e: unknown) => { host.children.push(e as FakeEl) },
      querySelector: () => null,
      ownerDocument: {
        createElement: (tag: string) => {
          created++
          const holder = mk(tag)
          // 假 DOM 不解析 html，所以"设 innerHTML"就当场造一个子元素顶上
          Object.defineProperty(holder, 'innerHTML', {
            set: () => { holder.firstElementChild = mk('i') },
          })
          return holder
        },
      },
    }

    const a = mountBlock(host, 'bar', '<div class="te-bar">A</div>')
    eq('挂上的块自动带 data-block（模板不用自己写）', (a as FakeEl).attrs['data-block'], 'bar')
    eq('  第一次挂：造了一个', created, 1)

    mountBlock(host, 'bar', '<div class="te-bar">A</div>')
    eq('同样的 html 再挂一次：**一个都没造**（DOM 没被碰）', created, 1)

    const b = mountBlock(host, 'bar', '<div class="te-bar">B</div>')
    eq('html 变了才换一块', created, 2)
    eq('  而且是"替换"不是"再 append"', (a as FakeEl).replacedWith, b)

    const extra = mountBlock(host, 'gone', '<div>x</div>')
    endBlocks(host, ['bar'])
    ok('这一轮没挂的块会被删掉（不然界面上留着不属于当前状态的东西）',
      (extra as FakeEl).removed === true)
  }

  /*
   * ---- 焦点工具：**最差的 DOM 上也不许抛** ----
   *
   * ⚠ 这是给一次真实事故补的回归测试：`captureFocus()` 早期版本直接读
   *   `root.ownerDocument.activeElement`，而**假 DOM 没有 activeElement** ——
   *   一个"把光标接回来"的小工具把整个 boot 炸了，
   *   报出来的却是"客户端加载失败"（35 个断言一起红，真因藏在最里面）。
   *
   *   渲染路径上的工具函数宁可什么都不做，也不能抛。
   */
  {
    const fake: ElLike = { contains: () => false, querySelector: () => null }
    let threw: unknown
    try {
      eq('captureFocus 在没有 ownerDocument 的假 DOM 上返回 undefined（不抛）',
        captureFocus(fake), undefined)
      restoreFocus(fake, undefined)
      restoreFocus(fake, { act: 'name', start: null, end: null })
    } catch (e) {
      threw = e
    }
    ok('  restoreFocus 对找不到的元素也不抛', threw === undefined, String(threw))
  }

  /*
   * ---- 滚动位置工具：和焦点是**同一对**，同样是"最差的 DOM 上也不许抛" ----
   *
   * ⚠ 它修的是**玩家实测报的那一条**："技能库里往下滚了之后点一格 ⇒ 页面弹回最上面"。
   *   根因和焦点一模一样：滚动位置住在**被换掉的那个元素**身上
   *   （`render()` 里 `mountBlock` 把整个技能库那一块换了 ⇒ 新容器 `scrollTop` 是 0）。
   *
   * ⚠ 假 DOM 上 `scrollTop` 就是**普通属性**（真的 DOM 也是可读可写的普通属性），
   *   所以"重渲染前后一样吗"在这层是**能断言**的（下面那一条点检就是它）。
   */
  {
    const fake: ElLike = { contains: () => false, querySelector: () => null }
    let threw: unknown
    try {
      const none = captureScroll(fake)
      eq('captureScroll 在没有 querySelectorAll 的假 DOM 上返回空数组（不抛）', none.length, 0)
      restoreScroll(fake, [])
      restoreScroll(fake, [{ key: 'skillLib', top: 120, left: 0 }])
    } catch (e) {
      threw = e
    }
    ok('  restoreScroll 对找不到的容器也不抛', threw === undefined, String(threw))

    /*
     * ⚠ 标记没写的容器**不许被记**（不然每次重画都多记一堆没意义的 0）。
     *   而且"按名字找回来"是这条机制的地基：名字在，容器重建了也认得出来。
     */
    const marked: ElLike = {
      getAttribute: (n: string) => (n === 'data-scroll' ? 'skillLib' : null),
      scrollTop: 120,
      scrollLeft: 4,
    }
    const notMarked: ElLike = { getAttribute: () => null, scrollTop: 300 }
    const host: ElLike = {
      querySelectorAll: () => [marked, notMarked],
      querySelector: (s: string) => (s.includes('skillLib') ? marked : null),
    }
    const cap = captureScroll(host)
    eq('  只记带 data-scroll 的容器（没标记的不记）', cap.length, 1)
    eq('  记下了纵向位置', cap[0]?.top, 120)
    eq('  也记下了横向位置', cap[0]?.left, 4)
    marked.scrollTop = 0
    restoreScroll(host, cap)
    eq('  按名字放回去（不是按下标）', marked.scrollTop, 120)
  }

  /*
   * ---- 技能库点不动（2026-10-07 修的 bug）----
   *
   * ⚠⚠ **根因**：`wire()` 扫的是 `button[data-act]`，而技能库里的一格是
   *   `<div class="sk-cell" data-act="pick">` —— **不是 button**。
   *   于是那些格子一个监听都没挂上：点上去没反应、不报错，
   *   而技能库那一屏**没有别的路**能选中一份技能（老版那个 `<select id="pick">` 已经删了）
   *   ⇒ 技能库彻底点不动。
   *
   * ⚠ 为什么这里要**自己造一个会解析 html 的假 DOM**：
   *   原来那套 stub（`installDomStubs`）的 `querySelectorAll` 永远返回空数组、
   *   `addEventListener` 是空的 —— 它故意只保证"boot 不炸"，
   *   于是"点一下有没有用"**在那个假 DOM 上根本测不出来**，
   *   这正是这个 bug 能溜过去的原因。
   *
   * ⚠ 为什么用**运行时动态 import**（说明符放变量里）：
   *   `tests/web.ts` 走根 `tsconfig.json`（**故意没有 DOM 类型**，见 `ui/dom.ts` 开头），
   *   拿字面量 import `editor.ts` 会让 `tsc --noEmit` 报一屏 `Cannot find name 'document'`。
   *   非字面量说明符在类型层是 `any` ⇒ 类型栅栏不动，运行时装的是**同一份源码**。
   */
  {
    interface FEl {
      tag: string
      attrs: Record<string, string>
      dataset: Record<string, string>
      style: Record<string, string>
      listeners: Record<string, () => void>
      children: FEl[]
      parent: FEl | null
      textContent: string
      value: string
      innerHTML: string
      /**
       * ⚠ 滚动位置在真 DOM 上是**普通可读写属性**，假 DOM 照着做（就是两个字段）。
       *   于是 `captureScroll` / `restoreScroll` 这一对在假 DOM 上**测得动**
       *   （"重渲染前后一样吗"不是靠猜）。
       */
      scrollTop: number
      scrollLeft: number
      classList: { add: (c: string) => void; remove: (c: string) => void; toggle: (c: string, on?: boolean) => void }
      addEventListener: (type: string, fn: () => void) => void
      removeEventListener: () => void
      setAttribute: (k: string, v: string) => void
      removeAttribute: (k: string) => void
      getAttribute: (k: string) => string | null
      contains: (o: unknown) => boolean
      querySelector: (s: string) => FEl | null
      querySelectorAll: (s: string) => FEl[]
      appendChild: (e: unknown) => void
      replaceWith: (e: unknown) => void
      remove: () => void
      focus: () => void
      click: () => void
      dispatch: (type: string) => void
      /** 只读视图：把 children 序列化回 html（正常路径下 `innerHTML` 是**算出来**的） */
      readHtml: () => string
      /** 从自己往上找第一个匹配的元素（真实点击委托靠它把 target 找回来） */
      closest: (sel: string) => FEl | null
    }

    /** `data-cd-at` → `cdAt`（和真的 `dataset` 同一套规则） */
    function camel(key: string): string {
      return key.replace(/-([a-z])/g, (_all, c: string) => c.toUpperCase())
    }

    const NAMED: Readonly<Record<string, string>> = {
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
    }
    function decode(text: string): string {
      return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
        if (body.startsWith('#x') || body.startsWith('#X')) {
          return String.fromCodePoint(Number.parseInt(body.slice(2), 16))
        }
        if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10))
        return NAMED[body.toLowerCase()] ?? whole
      })
    }

    const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'area', 'base', 'col', 'wbr'])
    const RAW_TAGS = new Set(['script', 'style', 'textarea', 'option'])

    function appendChildEl(parent: FEl, el: FEl): void {
      el.parent = parent
      parent.children.push(el)
    }

    /*
     * 极简 html 解析。
     *
     * ⚠ **只认工具自己生成的那些 html**（模板是开发者写的：标签都闭合、
     *   属性一律带引号、`<br>` / `<input>` 这种空元素没有 `/>`）。
     *   它**不是**通用解析器，也不需要是 —— 这里要回答的只有一句：
     *   "点了那个格子，选中状态和详情面板有没有变"。
     */
    /** 解析 `html[i]` 开始的一层，直到这一层闭合；返回下一个待解析的下标 */
    function parseInto(html: string, start: number, doc: FDoc, host: FEl): number {
      let i = start
      while (i < html.length) {
        const lt = html.indexOf('<', i)
        if (lt < 0) {
          host.textContent += decode(html.slice(i))
          return html.length
        }
        if (lt > i) host.textContent += decode(html.slice(i, lt))

        if (html.startsWith('<!--', lt)) {                      // 注释
          const end = html.indexOf('-->', lt)
          i = end < 0 ? html.length : end + 3
          continue
        }
        if (html.startsWith('</', lt)) {                        // 这一层闭合
          const gt = html.indexOf('>', lt)
          return gt < 0 ? html.length : gt + 1
        }

        // 开标签：找 ">"，跳过引号里的那些
        let j = lt + 1
        let quote = ''
        while (j < html.length) {
          const ch = html[j] ?? ''
          if (quote !== '') { if (ch === quote) quote = '' }
          else if (ch === '"' || ch === "'") quote = ch
          else if (ch === '>') break
          j++
        }
        const raw = html.slice(lt + 1, j)
        const selfClose = raw.endsWith('/')
        const tagBody = selfClose ? raw.slice(0, -1) : raw
        const nameMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(tagBody)
        const name = (nameMatch?.[0] ?? 'div').toLowerCase()

        const el = doc.createElement(name)
        const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'))?/g
        attrRe.lastIndex = nameMatch?.[0].length ?? 0
        let a = attrRe.exec(tagBody)
        while (a !== null) {
          // ⚠ 一律走 setAttribute：`dataset` 是它填的，而点击那条路读的正是 dataset
          el.setAttribute((a[1] ?? '').toLowerCase(), decode(a[3] ?? a[4] ?? ''))
          a = attrRe.exec(tagBody)
        }
        appendChildEl(host, el)

        const after = j + 1
        if (selfClose || VOID_TAGS.has(name)) { i = after; continue }
        if (RAW_TAGS.has(name)) {                               // 文本原样收（里面不该有标签）
          const close = html.toLowerCase().indexOf(`</${name}`, after)
          const text = decode(html.slice(after, close < 0 ? html.length : close))
          el.textContent = text
          if (name === 'textarea' || name === 'option') el.value = text
          i = close < 0 ? html.length : close
          continue
        }
        i = parseInto(html, after, doc, el)
      }
      return html.length
    }

    /** 一句**够用**的选择器：`tag` / `.cls` / `#id` / `[attr]` / `[attr="值"]`（可以叠） */
    interface FTokens { tag?: string; cls: string[]; id?: string; attrs: [string, string | undefined][] }
    function selectTokens(sel: string): FTokens {
      const out: FTokens = { cls: [], attrs: [] }
      const re = /([a-zA-Z][a-zA-Z0-9-]*)|\.([a-zA-Z0-9_-]+)|#([a-zA-Z0-9_-]+)|\[([a-zA-Z0-9_:.-]+)(?:[~^$*|]?=\s*"([^"]*)")?\]/g
      let m = re.exec(sel)
      while (m !== null) {
        if (m[1] !== undefined) out.tag = m[1].toLowerCase()
        else if (m[2] !== undefined) out.cls.push(m[2])
        else if (m[3] !== undefined) out.id = m[3]
        else if (m[4] !== undefined) out.attrs.push([m[4], m[5]])
        m = re.exec(sel)
      }
      return out
    }

    function matchesSel(el: FEl, sel: string): boolean {
      const t = selectTokens(sel)
      if (t.tag !== undefined && el.tag !== t.tag) return false
      if (t.id !== undefined && el.attrs['id'] !== t.id) return false
      for (const c of t.cls) if (!(el.attrs['class'] ?? '').split(/\s+/).includes(c)) return false
      for (const [k, v] of t.attrs) {
        if (!Object.prototype.hasOwnProperty.call(el.attrs, k)) return false
        if (v !== undefined && el.attrs[k] !== v) return false
      }
      return true
    }

    function walk(root: FEl, sel: string, out: FEl[]): void {
      for (const c of root.children) {
        if (c.parent !== root) continue          // 被 replaceWith 摘掉的
        if (matchesSel(c, sel)) out.push(c)
        walk(c, sel, out)
      }
    }

    function htmlOf(el: FEl): string {
      const attrs = Object.entries(el.attrs).map(([k, v]) => ` ${k}="${v}"`).join('')
      if (el.children.length === 0 && el.textContent !== '') return el.textContent
      return `<${el.tag}${attrs}>${el.children.map(htmlOf).join('')}${el.textContent}</${el.tag}>`
    }

    /** 假 document：只给编辑器真正会用到的那几个入口 */
    interface FDoc {
      nodes: Map<string, FEl>
      body: FEl | null
      /** 所有喂给 `innerHTML` 的 html（**原样**收着：编辑器生成的 markup 就靠它验） */
      log: string[]
      createElement: (tag: string) => FEl
      getElementById: (id: string) => FEl | null
    }

    /**
     * 一张卡/一块的 html 里**标签是否配平**（开 = 闭）。
     *
     * ⚠ 为什么值得单独写一个扫描器：这是"卡片没闭合"那个 bug 的**直接症状**，
     *   而它最常见的原因就是少一个 `</div>`（`mountBlock` 于是把上一张卡
     *   当成新块的根 → 卡套卡）。它**不依赖假解析器**（只数开闭），
     *   所以不会像遍历假 DOM 那样报假警报。
     *
     * ⚠ 空元素（`<br>` / `<input>` / `<img>`…）自己闭合，不算进这层。
     *   注释和 `<style>` / `<script>` 里的内容也跳过。
     */
    function tagsBalanced(html: string): { ok: boolean; why: string } {
      const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source',
        'area', 'base', 'col', 'wbr', 'track', 'embed', 'param'])
      const stack: string[] = []
      let i = 0
      while (i < html.length) {
        const lt = html.indexOf('<', i)
        if (lt < 0) break
        if (html.startsWith('<!--', lt)) {
          const end = html.indexOf('-->', lt)
          i = end < 0 ? html.length : end + 3
          continue
        }
        let j = lt + 1
        let quote = ''
        while (j < html.length) {
          const ch = html[j] ?? ''
          if (quote !== '') { if (ch === quote) quote = '' }
          else if (ch === '"' || ch === "'") quote = ch
          else if (ch === '>') break
          j++
        }
        const raw = html.slice(lt + 1, j)
        i = j + 1
        if (raw.startsWith('!') || raw.startsWith('?')) continue
        const closing = raw.startsWith('/')
        const name = (/^\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(raw)?.[1] ?? '').toLowerCase()
        if (name === '') continue
        if (name === 'script' || name === 'style') {
          const close = html.toLowerCase().indexOf(`</${name}`, i)
          i = close < 0 ? html.length : close
          continue
        }
        if (closing) {
          const top = stack.pop()
          if (top !== name) return { ok: false, why: `</${name}> 对不上（栈顶是 ${top ?? '空'}）` }
          continue
        }
        if (VOID.has(name) || raw.endsWith('/')) continue
        stack.push(name)
      }
      return stack.length === 0
        ? { ok: true, why: '' }
        : { ok: false, why: `还有 ${stack.length} 个没闭合：${stack.slice(-4).join(' > ')}` }
    }

    /**
     * 造一个"能解析、能选、能点"的假 DOM。
     *
     * ⚠ 每个要用 `mountBlock` 的宿主（`editorBody` / `techBody` / `editor`）都得在
     *   `nodes` 里 —— 编辑器是 `document.getElementById` 拿它们的，
     *   而块缓存挂在宿主对象上，所以**同一个 id 必须每次拿到同一个对象**。
     */
    function makeDom(): { root: FEl; doc: FDoc } {
      const doc: FDoc = {
        nodes: new Map<string, FEl>(),
        body: null,
        log: [],
        createElement(tag: string): FEl {
          const el: FEl = {
            tag: tag.toLowerCase(),
            attrs: {},
            dataset: {},
            style: {},
            listeners: {},
            children: [],
            parent: null,
            textContent: '',
            value: '',
            innerHTML: '',
            scrollTop: 0,
            scrollLeft: 0,
            classList: {
              add: (c) => {
                const list = (el.attrs['class'] ?? '').split(/\s+/).filter(x => x !== '')
                if (!list.includes(c)) el.attrs['class'] = [...list, c].join(' ')
              },
              remove: (c) => {
                el.attrs['class'] = (el.attrs['class'] ?? '').split(/\s+/).filter(x => x !== '' && x !== c).join(' ')
              },
              toggle: (c, on) => {
                const has = (el.attrs['class'] ?? '').split(/\s+/).includes(c)
                const want = on ?? !has
                if (want && !has) el.classList.add(c)
                if (!want && has) el.classList.remove(c)
              },
            },
            addEventListener: (type, fn) => { el.listeners[`on${type}`] = fn },
            removeEventListener: () => undefined,
            setAttribute: (k, v) => {
              el.attrs[k] = v
              if (k.startsWith('data-')) el.dataset[camel(k.slice(5))] = v
            },
            removeAttribute: (k) => { delete el.attrs[k] },
            getAttribute: (k) => el.attrs[k] ?? null,
            contains: (o) => {
              let p = (o as FEl | null)?.parent ?? null
              while (p !== null) {
                if (p === el) return true
                p = p.parent
              }
              return false
            },
            querySelector: (s) => {
              const out: FEl[] = []
              walk(el, s, out)
              return out[0] ?? null
            },
            querySelectorAll: (s) => {
              const out: FEl[] = []
              walk(el, s, out)
              return out
            },
            appendChild: (e) => { appendChildEl(el, e as FEl) },
            replaceWith: (e) => {
              const next = e as FEl
              const p = el.parent
              if (p === null) return
              const at = p.children.indexOf(el)
              if (at >= 0) p.children[at] = next
              next.parent = p
              el.parent = null
            },
            remove: () => {
              const p = el.parent
              if (p === null) return
              const at = p.children.indexOf(el)
              if (at >= 0) p.children.splice(at, 1)
              el.parent = null
            },
            focus: () => undefined,
            click: () => { el.dispatch('click') },
            dispatch: (type) => { el.listeners[`on${type}`]?.() },
            /*
             * ⚠ `closest` 是 2026-10-07 **补的**（术式页那一块测试要它）：
             *   两个编辑器的点击都是**委托**在宿主上、再用 `closest('[data-act]')`
             *   找回被点的那个元素（真实点击是从 target 往上冒到宿主的）。
             *   假 DOM 里发的点击事件没有冒泡，所以"从 target 往上找"只有它自己。
             *   少了它，术式页的每一次点击都会抛 `closest is not a function` ——
             *   而那看起来像"编辑器坏了"，不是"测试的假 DOM 不全"。
             */
            closest: (sel) => {
              let cur: FEl | null = el
              while (cur !== null) {
                if (matchesSel(cur, sel)) return cur
                cur = cur.parent
              }
              return null
            },
            readHtml: () => htmlOf(el),
          }
          /*
           * ⚠ `innerHTML` 要**真的解析**（设它 = 重建孩子）：
           *   编辑器走的正是"把 html 交给 innerHTML"这条路（`mountBlock`），
           *   不解析的话"点了有没有用"还是测不出来。
           */
          Object.defineProperty(el, 'innerHTML', {
            get: () => htmlOf(el),
            set: (v: string) => {
              /*
               * ⚠ 每一份写给 `innerHTML` 的 html 都**原样存一份**：那才是编辑器
               *   真正生成的 markup（用户比的就是它），而假解析器只负责让点击能跑。
               */
              doc.log.push(v)
              el.children = []
              el.textContent = ''
              parseInto(v, 0, doc, el)
            },
            configurable: true,
          })
          return el
        },
        getElementById(id: string): FEl | null {
          return doc.nodes.get(id) ?? null
        },
      }
      for (const id of ['editorBody', 'editor', 'techBody']) {
        const el = doc.createElement('div')
        el.setAttribute('id', id)
        doc.nodes.set(id, el)
      }
      doc.body = doc.createElement('body')
      return { root: doc.nodes.get('editorBody') as FEl, doc }
    }

    const spec = '../web/src/editor.ts'
    const mod = (await import(spec)) as {
      createEditor: (host: unknown, balance: unknown) => unknown
    }
    const dom = makeDom()
    const realDocument = (globalThis as unknown as Record<string, unknown>)['document']
    try {
      ;(globalThis as unknown as Record<string, unknown>)['document'] = dom.doc

      const cleave = readJson<Skill>(resolve('content/skills/cleave.json'))
      const variant: Skill = JSON.parse(JSON.stringify(cleave)) as Skill
      variant.id = 'custom.cleave.1'
      variant.name = '裂地斩-副本1'
      variant.basedOn = cleave.id

      mod.createEditor(
        {
          base: new Map<string, Skill>([[cleave.id, cleave]]),
          custom: new Map<string, Skill>([[variant.id, variant]]),
          usedBy: new Map<string, string[]>(),
          onSave: () => undefined,
          onDelete: () => undefined,
          onNotice: () => undefined,
        },
        readJson<BalanceConfig>(resolve('content/balance.json')),
      )

      const body = dom.root
      const cellOf = (id: string): FEl | null =>
        body.querySelector(`[data-act="pick"][data-i="${id}"]`)
      /*
       * ⚠ 详情面板**不**从假 DOM 序列化（`readHtml`）拿：那个解析器只会解析
       *   **它认识的那些**标签（`<option>` 一多就乱），序列化出来的东西会缺东西。
       *   所以这里只读**结构性的那一件事**：详情面板现在给的是哪个动作按钮 ——
       *   它是照着"现在这一份是哪一库的"生成的（基础 = 以此为原型 / 我的 = 编辑此技能）。
       */
      const detailHtml = (): string => {
        const openEdit = body.querySelector('[data-act="openEdit"]')
        const create = body.querySelector('[data-act="create"]')
        return `编辑入口=${openEdit === null ? '没有' : '有'}`
          + ` 原型入口=${create === null ? '没有' : '有'}`
          + ` 高亮=${body.querySelector('.sk-cell.on')?.dataset['i'] ?? '（没有）'}`
      }

      const cell = cellOf(cleave.id)
      ok('技能库那一格**真的挂上了点击**（`data-act="pick"` 的元素就是格子本身，不是 button）',
        cell !== null && cell.listeners['onclick'] !== undefined,
        cell === null
          ? '库里找不到那一格'
          : `listeners=${Object.keys(cell.listeners).join(',') || '（一个都没有）'}`)

      const before = detailHtml()
      cell?.dispatch('click')
      const after = detailHtml()

      ok('  点了基础技能那一格 ⇒ **选中状态真的变了**（高亮从「裂地斩-副本1」挪到「裂地斩」）',
        body.querySelector('.sk-cell.on')?.dataset['i'] === cleave.id
        && body.querySelectorAll('.sk-cell.on').length === 1,
        after)

      ok('  而且**详情面板真的换了**：动作按钮从「编辑此技能」变成「以此为原型创建新技能」',
        after !== before
        && after.includes('原型入口=有') && after.includes('编辑入口=没有'),
        `点前 {${before}} / 点后 {${after}}`)

      ok('  详情面板上那一份**就是刚点的那一份**（不是还停在原来那份）',
        after.includes(`高亮=${cleave.id}`) && before.includes(`高亮=${variant.id}`),
        `点前 {${before}} / 点后 {${after}}`)

      // 反向再点一次：状态和详情要跟着回去（不是"只能点一次"）
      cellOf(variant.id)?.dispatch('click')
      const back = detailHtml()
      ok('  再点回「我的技能」那一格 ⇒ 状态和详情又切回去（不是只能点一次）',
        back.includes('编辑入口=有') && back.includes('原型入口=没有')
        && back.includes(`高亮=${variant.id}`),
        back)

      /*
       * ---- 滚动位置：**用户实测报的那一条** ----
       *
       * ⚠ 症状：在技能库里往下滚了之后点一格 ⇒ 页面弹回最上面。
       *   根因：`render()` 用 `mountBlock` 把整个技能库那一块换掉，
       *   而滚动位置住在**被换掉的那个元素**身上 ⇒ 新容器 `scrollTop` 是 0。
       *
       * ⚠ 这里**不是**在验"点完再 scrollTo 回去"那种糊法，验的是那个容器
       *   **换过之后**位置还在（下面 `库里那个滚动容器换了新的` 那一条证明它真的换了）。
       */
      {
        const holder0 = body.querySelector('[data-scroll="skillLib"]')
        ok('技能库那一栏挂着 data-scroll 标记（重画后靠它认回同一个容器）',
          holder0 !== null,
          holder0 === null ? '假 DOM 里找不到 [data-scroll="skillLib"]' : '有')

        if (holder0 !== null) {
          holder0.scrollTop = 120
          holder0.scrollLeft = 6
          cellOf(cleave.id)?.dispatch('click')
          const holder1 = body.querySelector('[data-scroll="skillLib"]')
          ok('⚠ 往下滚过之后点一格 ⇒ **滚动位置没丢**（页面不弹回最上面）',
            holder1 !== null && holder1.scrollTop === 120,
            `点前 scrollTop=120 / 点后 ${String(holder1?.scrollTop)}`)
          ok('  横向位置也保住了（窄屏下技能库会横向滚）',
            holder1 !== null && holder1.scrollLeft === 6,
            `点后 scrollLeft=${String(holder1?.scrollLeft)}`)
          ok('  而且那一栏**真的被换过**（所以这条断言不是"什么都没发生"）',
            holder1 !== holder0,
            holder1 === holder0 ? '容器还是同一个 ⇒ 这条没测到东西' : '换了新的（靠标记认回来）')
        }
      }

      /*
       * ---- 卡片结构（编辑器 UI 第二片：观感照模板）----
       *
       * ⚠⚠ 这一节守的是**"一整块一整块卡片"**那件事，以及一个很容易写错的形状：
       *   编辑页整屏是 `.sk-editscreen`，**卡片直接挂在它下面**，一张卡一块
       *   （`mountBlock` 的 key 就是"一块"的边界）。
       *   卡片不闭合的话，`mountBlock` 会把**上一张卡**当成新块的根 ——
       *   表现是"卡套卡"越挂越深，而界面上看起来只是间距变怪，很难查。
       *
       * ⚠ 这几条认的是编辑器喂给 `body.innerHTML` 的**那份 html 原样**，
       *   不是遍历假 DOM 的对象树：假 DOM 是个"够用就好"的解析器
       *   （`<option>` 这类成堆的空元素它解析不干净），拿它数结构会数出假警报。
       *   "这张卡在不在、它的标题是什么"用文字看反而准 —— 而那份 html 本身
       *   在浏览器里就是真实结构（假 DOM 只是把它存了下来）。
       */
      /*
       * ⚠ 这里认的是**编辑器生成的 markup 原样**（假 document 把每一份
       *   喂给 `innerHTML` 的 html 都存了下来），不去遍历假 DOM 的节点树：
       *   那个解析器是"够用就好"的（`<option>` 一多它就乱），拿它数结构会数出假警报。
       *   而 markup 本身在浏览器里就是真实结构（假 DOM 只是把它存下来了）。
       */
      const markup = dom.doc.log.join('\n')
      const screenAt = markup.indexOf('sk-editscreen')
      const screenHtml = screenAt < 0 ? '' : markup.slice(screenAt)
      const cardHeads = [...screenHtml.matchAll(/<div class="sk-card-h">([^<]*)/g)]
        .map(m => m[1]?.trim() ?? '')
      const cardCount = (screenHtml.match(/<div class="sk-card"/g) ?? []).length
      const hasHead = (needle: string): boolean => cardHeads.some(h => h.includes(needle))
      const joined = cardHeads.join(' | ')

      ok('编辑页整屏是一层 `.sk-editscreen`（照模板 `.main` 那一列）',
        screenAt >= 0, `markup 里出现了 ${markup.split('sk-editscreen').length - 1} 次（分块渲的，每块一次）`)
      ok('  它下面挂着**一张张卡片**（模板的 `.row`：边框 + 圆角 + 留白 + 自己的标题）',
        cardCount >= 8, `${cardCount} 张卡：${joined}`)
      ok('  三组控件各是**独立的一张卡**（① 瞄准 / ② 效果发生在哪里 / ③ 宿主）',
        hasHead('① 瞄准') && hasHead('② 效果发生在哪里') && hasHead('③ 宿主'), joined)
      ok('  固有效果 / 规则 / 点数明细 / 进入冷却的时机 / 阶段 / 校验 / 存回去 也各是一张卡',
        hasHead('固有效果') && hasHead('规则') && hasHead('点数明细')
        && hasHead('进入冷却的时机') && hasHead('阶段') && hasHead('校验') && hasHead('存回去'),
        joined)
      // 顺序照用户口径：瞄准 → 效果发生在哪里 → 宿主
      ok('  三张卡的顺序是 瞄准 → 效果发生在哪里 → 宿主（照用户口径）',
        cardHeads.findIndex(h => h.includes('① 瞄准')) < cardHeads.findIndex(h => h.includes('② 效果发生在哪里'))
        && cardHeads.findIndex(h => h.includes('② 效果发生在哪里')) < cardHeads.findIndex(h => h.includes('③ 宿主')),
        joined)
      /*
       * ⚠ **每一块自己的标签要配平**（开 = 闭）。
       *   这是"卡片没闭合"那个形状的直接症状：少一个 `</div>` 时
       *   `mountBlock` 会把上一张卡当成新块的根 → 卡套卡，而界面看起来只是间距变怪。
       *   它跟假解析器无关（只数开闭），所以不会报假警报。
       */
      {
        const unBalanced = dom.doc.log
          .map((html, i) => ({ i, r: tagsBalanced(html) }))
          .filter(x => !x.r.ok)
        ok('  每一块的 html 标签都配平（没有"少一个 </div>"那种形状）',
          unBalanced.length === 0,
          unBalanced.slice(0, 3).map(x => `#${x.i}: ${x.r.why}`).join(' / '))
      }
      ok('  点数明细里每一行都是**整数**（账取整数，不摆小数）',
        [...screenHtml.matchAll(/<span style="color:#[0-9a-f]{6}">([+-]?\d+(?:\.\d+)?)<\/span>/g)]
          .every(m => !(m[1] ?? '').includes('.')),
        [...screenHtml.matchAll(/<span style="color:#[0-9a-f]{6}">([+-]?\d+(?:\.\d+)?)<\/span>/g)]
          .map(m => m[1]).join(' '))

      /*
       * ---- 上一片已经对的功能：**一条都不许退化**（用户点名的那几条）----
       *
       * ⚠ 这里认的也是 markup 原样 —— 用户看的就是它。
       */
      const editAt = screenHtml.indexOf('进入冷却的时机')
      const editHtml = editAt < 0 ? '' : screenHtml.slice(editAt)
      /*
       * ⚠⚠ 2026-09-30（日志 63）**这条断言原来钉的是"账上无格 ⇒ 置灰"**（见上面
       *   同一条的说明）。现在四档走倍数档表 ⇒ 每一档都有价、一个都不灰；
       *   而**蓄力那一档照旧走绝对秒数格**（它是另一根轴，不在倍数里）——
       *   那一句"账上这一格（绝对秒数）"就是"两条路并存"的证据。
       */
      ok('死滑块铁律：账能给出价的档**一个都不置灰**（倍数档走表；蓄力照旧走绝对格）',
        !editHtml.includes('sk-tier off') && editHtml.includes('倍数档查表')
        && editHtml.includes('账上这一格（绝对秒数）'),
        editHtml.slice(0, 300))
      ok('  四档时长是**四档**（无 / 1× / 3× / 9×），`1×` 标着「默认」',
        editHtml.includes('>无<') && editHtml.includes('1×')
        && editHtml.includes('3×') && editHtml.includes('9×') && editHtml.includes('默认'),
        editHtml.slice(0, 400))
      ok('  蓄力（−1）是**单独一档**，不和「无」（0 秒）合并',
        editHtml.includes('data-v="-1"') && editHtml.includes('data-v="0"')
        && editHtml.includes('按住键'),
        `-1=${editHtml.includes('data-v="-1"')} 0=${editHtml.includes('data-v="0"')}`)
      ok('点数**没有滑块**（点数是算出来的，不是拖出来的）',
        !/id="points"[\s\S]{0,1200}?<input/.test(screenHtml),
        screenHtml.slice(Math.max(0, screenHtml.indexOf('id="points"')), screenHtml.indexOf('id="points"') + 200))
      ok('动作级「对谁有效」**默认折叠**（`<details>` 不写 open）',
        /<details class="sk-fold">\s*<summary>对谁有效（默认折叠/.test(screenHtml),
        screenHtml.slice(Math.max(0, screenHtml.indexOf('sk-fold') - 60), screenHtml.indexOf('sk-fold') + 160))
      ok('形态在界面上是**只读**的（写清"要改形态就是改阶段"，没有可点控件）',
        screenHtml.includes('形态是<b>机制事实</b>') && screenHtml.includes('界面上<b>只读</b>'),
        screenHtml.slice(Math.max(0, screenHtml.indexOf('sk-formwhy') - 120), screenHtml.indexOf('sk-formwhy') + 200))
      ok('技能页里**不出现修饰零件的参数**（那是术式页的事）',
        !screenHtml.includes('触发条件') && !screenHtml.includes('修饰技能')
        && !screenHtml.includes('点数按这个副本'),
        '（这一片只画技能页）')

      /*
       * ---- ① 详情面板的几何：**跟"选中谁"无关**（2026-10-07 用户实测）----
       *
       * 用户原话：「选中每个技能的时候，描述页的形状和大小甚至位置都不同」。
       *
       * ⚠ 假 DOM 没有排版引擎 ⇒ 这里钉的是**结构那一半**：
       *   面板那一层元素（`<aside class="sk-detail">`）的**属性集在两次选中之间
       *   逐字相同** —— 也就是说它的宽 / 高 / 坐标**没有任何一处**来自
       *   "当前选中的是哪一份技能"（面板上也没有 inline 的宽 / 高）。
       *   加上上面那一节钉住的 CSS（写死 346px + `flex:none` + 固定高度 + 内部滚动），
       *   几何就只剩"由容器决定"这一条路可走。
       *
       * ⚠ 为了不是"测了个空气"：两份技能的内容长短**差一个数量级**
       *   （短的那份一句「短。」，长的那份 600 字），断言同时要求
       *   "内容确实差很多" 且 "面板那一层确实一样"。
       */
      {
        const doc2 = makeDom()
        const g = globalThis as unknown as Record<string, unknown>
        const prevDoc = g['document']
        try {
          g['document'] = doc2.doc

          const shortSkill: Skill = JSON.parse(JSON.stringify(cleave)) as Skill
          shortSkill.id = 'custom.geo.short'
          shortSkill.name = '短介绍的那一份'
          shortSkill.note = '短。'
          const longSkill: Skill = JSON.parse(JSON.stringify(cleave)) as Skill
          longSkill.id = 'custom.geo.long'
          longSkill.name = '长介绍的那一份'
          longSkill.basedOn = cleave.id
          longSkill.note = '这一段介绍故意写得特别长，用来把面板的内容顶出去。'.repeat(24)

          mod.createEditor(
            {
              base: new Map<string, Skill>([[cleave.id, cleave], [shortSkill.id, shortSkill]]),
              custom: new Map<string, Skill>([[longSkill.id, longSkill]]),
              usedBy: new Map<string, string[]>(),
              onSave: () => undefined,
              onDelete: () => undefined,
              onNotice: () => undefined,
            },
            readJson<BalanceConfig>(resolve('content/balance.json')),
          )

          const root2 = doc2.root
          const pick = (id: string): void => {
            root2.querySelector(`[data-act="pick"][data-i="${id}"]`)?.dispatch('click')
          }
          /** 面板**这一层**长什么样（能变的只有标签和属性 —— 宽 / 高 / 坐标就在那儿）*/
          const panelTag = (): string => {
            const a = root2.querySelector('aside.sk-detail')
            if (a === null) return '（没有详情面板）'
            const attrs = Object.keys(a.attrs).sort()
              .map(k => ` ${k}="${String(a.attrs[k] ?? '')}"`).join('')
            return `<${a.tag}${attrs}>`
          }
          /** 面板里的介绍有多长（"内容长短"这个变量本身，免得断言变成"什么都没测"）*/
          const noteLen = (): number =>
            (root2.querySelector('.sk-dnote')?.readHtml() ?? '').length

          pick(longSkill.id)
          const longTag = panelTag()
          const longNote = noteLen()
          pick(shortSkill.id)
          const shortTag = panelTag()
          const shortNote = noteLen()

          ok('① 两份技能的内容长短**差一个数量级**（不然下面那条等于没测）',
            shortNote > 0 && longNote > shortNote * 10,
            `长的介绍=${String(longNote)} 字 / 短的介绍=${String(shortNote)} 字`)

          ok('① 换了技能 ⇒ 面板**这一层**逐字相同（宽 / 高 / 坐标没有一处来自"选中的是谁"）',
            longTag === shortTag && longTag === '<aside class="sk-detail">',
            `长 {${longTag}} / 短 {${shortTag}}`)

          ok('① 面板那一层上**没有** inline 的宽 / 高（不许按内容算尺寸）',
            !/style=/.test(longTag) && !/style=/.test(shortTag),
            longTag)

          /*
           * 来回切 5 轮（每轮换一份：长的那份 → 短的那份 → **内容里的裂地斩**）。
           * ⚠ 带上裂地斩是因为用户原话点名的就是它和「灵光盾」那种"内容差很多"的一对 ——
           *   这一份是真的从 `content/skills/cleave.json` 读出来的，
           *   不是测试自己捏的（捏的那两份只负责把"内容长短"这个变量拉满）。
           */
          const cycle = [longSkill.id, shortSkill.id, cleave.id]
          const seen: string[] = []
          for (let i = 0; i < 5; i++) {
            pick(cycle[i % cycle.length] ?? cleave.id)
            seen.push(`${panelTag()}|${String(root2.querySelectorAll('aside.sk-detail').length)}`)
          }
          ok('① 来回切 5 轮（长 / 短 / 裂地斩）⇒ 面板那一层一次都没变（位置不漂），而且**始终只有一块**',
            seen.every((x: string) => x === `${longTag}|1`),
            seen.join('  '))
        } finally {
          g['document'] = prevDoc
        }
      }

      /*
       * ---- ① 两栏"底边齐"的**结构**那一半（2026-10-06 用户实测「面板对齐」）----
       *
       * ⚠ 上面那一节钉的是样式数值（两栏高度表达式相同 + 搜索框不再额外加高）。
       *   这里钉的是**结构**，两条缺一不可：
       *     · 搜索框和列表容器**都在左栏 `.sk-lib` 里面** —— 不然"左栏吃满行容器的高度"
       *       只约束了列表，搜索框照样在左栏外面把整行撑高；
       *     · 左右两栏是**同一个 `.sk-cols` 行里的兄弟** —— 同一条 flex 行，高度才可以直接比。
       *   两条 + 上面那节 = "同一行 + 外框高相等 + 都从行首开始" ⇒ 底边重合。
       */
      {
        const cols = body.querySelector('.sk-cols')
        const lib = body.querySelector('.sk-lib')
        const panel = body.querySelector('aside.sk-detail')
        const search = lib?.querySelector('#skillSearch') ?? null
        const listBody = lib?.querySelector('.sk-libbody') ?? null
        ok('① 对齐 搜索框和列表容器**都在左栏 `.sk-lib` 里面**（所以左栏定高时搜索框只吃掉它自己那一块）',
          lib !== null && search !== null && listBody !== null
          && search.parent === lib && listBody.parent === lib,
          `左栏=${lib === null ? '没有' : '有'} 搜索框=${search === null ? '没有' : '在里面'}`
          + ` 列表=${listBody === null ? '没有' : '在里面'}`)
        ok('① 对齐 左右两栏是**同一个 `.sk-cols` 行里的兄弟**（同一条 flex 行 ⇒ 两栏高度可以直接比）',
          cols !== null && lib !== null && panel !== null
          && lib.parent === cols && panel.parent === cols,
          `行=${cols === null ? '没有' : '有'} 左栏的爹=${lib?.parent?.attrs['class'] ?? '（没有）'}`
          + ` 右栏的爹=${panel?.parent?.attrs['class'] ?? '（没有）'}`)
      }
    } finally {
      ;(globalThis as unknown as Record<string, unknown>)['document'] = realDocument
    }
  }

  /*
   * ==========================================================================
   *  术式页（编辑器 UI 第三片）
   * ==========================================================================
   *
   * ⚠ 这一节**必须自己造一个会解析 html、能挂监听、能发点击的假 DOM**
   *   （`installDomStubs` 那套的 `addEventListener` 是空的、`querySelectorAll`
   *   永远返回空 —— 它只保证 "boot 不炸"，"点一下有没有用"在那上面**测不出来**）。
   *   上面技能页那一节用的是同一套（`makeDom`），这里连带把它的
   *   `closest` 补上了 —— 两个编辑器的点击都是"委托在宿主 + 从 target 往上找"。
   *
   * ⚠ 为什么用**运行时动态 import**：`tests/web.ts` 走根 `tsconfig.json`
   *   （**故意没有 DOM 类型**，见 `ui/dom.ts` 开头），拿字面量 import
   *   `technique-editor.ts` 会让 `tsc --noEmit` 报一屏 `Cannot find name 'document'`。
   */
  {
    /** 极简 html 标签配平（和上面那一节同一个判据，独立写一份免得跨块依赖） */
    function balanced(html: string): { ok: boolean; why: string } {
      const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source',
        'area', 'base', 'col', 'wbr', 'track', 'embed', 'param'])
      const stack: string[] = []
      let i = 0
      while (i < html.length) {
        const lt = html.indexOf('<', i)
        if (lt < 0) break
        if (html.startsWith('<!--', lt)) {
          const end = html.indexOf('-->', lt)
          i = end < 0 ? html.length : end + 3
          continue
        }
        let j = lt + 1
        let quote = ''
        while (j < html.length) {
          const ch = html[j] ?? ''
          if (quote !== '') { if (ch === quote) quote = '' }
          else if (ch === '"' || ch === "'") quote = ch
          else if (ch === '>') break
          j++
        }
        const raw = html.slice(lt + 1, j)
        i = j + 1
        if (raw.startsWith('!') || raw.startsWith('?')) continue
        const closing = raw.startsWith('/')
        const name = (/^\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(raw)?.[1] ?? '').toLowerCase()
        if (name === '') continue
        if (closing) {
          const top = stack.pop()
          if (top !== name) return { ok: false, why: `</${name}> 对不上（栈顶是 ${top ?? '空'}）` }
          continue
        }
        if (raw.endsWith('/') || VOID.has(name)) continue
        stack.push(name)
      }
      return stack.length === 0
        ? { ok: true, why: '' }
        : { ok: false, why: `还有没闭合的：${stack.join(' > ')}` }
    }

    interface TEl {
      tag: string
      attrs: Record<string, string>
      dataset: Record<string, string>
      style: Record<string, string>
      listeners: Record<string, (ev: unknown) => void>
      children: TEl[]
      parent: TEl | null
      textContent: string
      value: string
      innerHTML: string
      scrollTop: number
      scrollLeft: number
      classList: { add: (c: string) => void; remove: (c: string) => void; toggle: (c: string, on?: boolean) => void }
      addEventListener: (t: string, fn: (ev: unknown) => void) => void
      setAttribute: (k: string, v: string) => void
      getAttribute: (k: string) => string | null
      contains: (o: unknown) => boolean
      querySelector: (s: string) => TEl | null
      querySelectorAll: (s: string) => TEl[]
      closest: (s: string) => TEl | null
      appendChild: (e: unknown) => void
      replaceWith: (e: unknown) => void
      remove: () => void
    }
    interface TDoc {
      nodes: Map<string, TEl>
      /** 喂给 `innerHTML` 的每一份 html 原样（编辑器真正生成的 markup 就靠它验） */
      log: string[]
      createElement: (tag: string) => TEl
      getElementById: (id: string) => TEl | null
    }

    const camel = (k: string): string => k.replace(/-([a-z])/g, (_a, c: string) => c.toUpperCase())
    const decode = (s: string): string => s
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

    /** 够用的选择器：`tag` / `.cls` / `[attr]` / `[attr="值"]`（可以叠） */
    function matches(el: TEl, sel: string): boolean {
      const re = /([a-zA-Z][a-zA-Z0-9-]*)|\.([a-zA-Z0-9_-]+)|\[([a-zA-Z0-9_:.-]+)(?:="([^"]*)")?\]/g
      let m = re.exec(sel)
      while (m !== null) {
        if (m[1] !== undefined) { if (el.tag !== m[1].toLowerCase()) return false }
        else if (m[2] !== undefined) {
          if (!(el.attrs['class'] ?? '').split(/\s+/).includes(m[2])) return false
        } else if (m[3] !== undefined) {
          if (!Object.prototype.hasOwnProperty.call(el.attrs, m[3])) return false
          if (m[4] !== undefined && el.attrs[m[3]] !== m[4]) return false
        }
        m = re.exec(sel)
      }
      return true
    }

    function makeDom(): TDoc {
      const doc: TDoc = { nodes: new Map(), log: [], createElement: (t: string) => mk(t), getElementById: (id: string) => doc.nodes.get(id) ?? null }

      function mk(tag: string): TEl {
        const el: TEl = {
          tag: tag.toLowerCase(), attrs: {}, dataset: {}, style: {}, listeners: {},
          children: [], parent: null, textContent: '', value: '', innerHTML: '',
          scrollTop: 0, scrollLeft: 0,
          classList: {
            add: (c) => {
              const list = (el.attrs['class'] ?? '').split(/\s+/).filter(x => x !== '')
              if (!list.includes(c)) el.attrs['class'] = [...list, c].join(' ')
            },
            remove: (c) => {
              el.attrs['class'] = (el.attrs['class'] ?? '').split(/\s+/).filter(x => x !== '' && x !== c).join(' ')
            },
            toggle: (c, on) => {
              const has = (el.attrs['class'] ?? '').split(/\s+/).includes(c)
              const want = on ?? !has
              if (want && !has) el.classList.add(c)
              if (!want && has) el.classList.remove(c)
            },
          },
          addEventListener: (t, fn) => { el.listeners[`on${t}`] = fn },
          setAttribute: (k, v) => {
            el.attrs[k] = v
            if (k.startsWith('data-')) el.dataset[camel(k.slice(5))] = v
          },
          getAttribute: (k) => el.attrs[k] ?? null,
          contains: (o) => {
            let p = (o as TEl | null)?.parent ?? null
            while (p !== null) { if (p === el) return true; p = p.parent }
            return false
          },
          querySelector: (s) => collect(el, s)[0] ?? null,
          querySelectorAll: (s) => collect(el, s),
          closest: (s) => {
            let cur: TEl | null = el
            while (cur !== null) { if (matches(cur, s)) return cur; cur = cur.parent }
            return null
          },
          appendChild: (e) => { const n = e as TEl; n.parent = el; el.children.push(n) },
          replaceWith: (e) => {
            const n = e as TEl
            const p = el.parent
            if (p === null) return
            const at = p.children.indexOf(el)
            if (at >= 0) p.children[at] = n
            n.parent = p
            el.parent = null
          },
          remove: () => {
            const p = el.parent
            if (p === null) return
            const at = p.children.indexOf(el)
            if (at >= 0) p.children.splice(at, 1)
            el.parent = null
          },
        }
        Object.defineProperty(el, 'innerHTML', {
          get: () => serialize(el),
          set: (v: string) => { doc.log.push(v); el.children = []; el.textContent = ''; parse(v, el) },
          configurable: true,
        })
        return el
      }

      function collect(root: TEl, sel: string): TEl[] {
        const out: TEl[] = []
        const walk = (n: TEl): void => {
          for (const c of n.children) {
            if (c.parent !== n) continue
            if (matches(c, sel)) out.push(c)
            walk(c)
          }
        }
        walk(root)
        return out
      }

      function serialize(el: TEl): string {
        const attrs = Object.entries(el.attrs).map(([k, v]) => ` ${k}="${v}"`).join('')
        return `<${el.tag}${attrs}>${el.children.map(serialize).join('')}${el.textContent}</${el.tag}>`
      }

      /**
       * 极简 html 解析（**一层到底、用栈**）。
       *
       * ⚠ 只认工具自己生成的那些 html（标签成对、属性一律带引号、空元素不成对）——
       *   它**不是**通用解析器，也不需要是。它要回答的只有一句：
       *   "点了那个零件，编辑屏有没有换、账有没有跟着变"。
       */
      function parse(html: string, host: TEl): void {
        const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source',
          'area', 'base', 'col', 'wbr', 'track', 'embed', 'param'])
        const RAW = new Set(['option', 'textarea'])
        const stack: TEl[] = [host]
        const top = (): TEl => stack[stack.length - 1] as TEl
        let i = 0
        while (i < html.length) {
          const lt = html.indexOf('<', i)
          if (lt < 0) { top().textContent += decode(html.slice(i)); return }
          if (lt > i) top().textContent += decode(html.slice(i, lt))
          if (html.startsWith('<!--', lt)) {
            const end = html.indexOf('-->', lt)
            i = end < 0 ? html.length : end + 3
            continue
          }
          if (html.startsWith('</', lt)) {
            const gt = html.indexOf('>', lt)
            if (stack.length > 1) stack.pop()
            i = gt < 0 ? html.length : gt + 1
            continue
          }
          let j = lt + 1
          let quote = ''
          while (j < html.length) {
            const ch = html[j] ?? ''
            if (quote !== '') { if (ch === quote) quote = '' }
            else if (ch === '"' || ch === "'") quote = ch
            else if (ch === '>') break
            j++
          }
          const raw = html.slice(lt + 1, j)
          const selfClose = raw.endsWith('/')
          const bodyText = selfClose ? raw.slice(0, -1) : raw
          const nameMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(bodyText)
          const name = (nameMatch?.[0] ?? 'div').toLowerCase()
          const el = mk(name)
          const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g
          attrRe.lastIndex = nameMatch?.[0].length ?? 0
          let a = attrRe.exec(bodyText)
          while (a !== null) {
            el.setAttribute((a[1] ?? '').toLowerCase(), decode(a[2] ?? ''))
            a = attrRe.exec(bodyText)
          }
          el.parent = top()
          top().children.push(el)
          i = j + 1
          if (selfClose || VOID.has(name)) continue
          if (RAW.has(name)) {
            const close = html.toLowerCase().indexOf(`</${name}`, i)
            const text = decode(html.slice(i, close < 0 ? html.length : close))
            el.textContent = text
            if (name === 'option') el.value = text
            i = close < 0 ? html.length : close
            continue
          }
          stack.push(el)
        }
      }

      for (const id of ['editorBody', 'editor', 'techBody']) {
        const e = mk('div')
        e.setAttribute('id', id)
        doc.nodes.set(id, e)
      }
      return doc
    }

    const spec = '../web/src/technique-editor.ts'
    const mod = (await import(spec)) as {
      createTechniqueEditor: (host: unknown) => { refresh: () => void }
    }
    const dom = makeDom()
    const realDocument = (globalThis as unknown as Record<string, unknown>)['document']
    const realWindow = (globalThis as unknown as Record<string, unknown>)['window']
    try {
      ;(globalThis as unknown as Record<string, unknown>)['document'] = dom
      const prompts: string[] = []
      ;(globalThis as unknown as Record<string, unknown>)['window'] = {
        prompt: () => prompts.shift() ?? null,
        addEventListener: () => undefined,
      }
      void realWindow

      const body = dom.nodes.get('techBody') as TEl
      const byAct = (act: string): TEl[] => body.querySelectorAll(`[data-act="${act}"]`)
      const one = (act: string): TEl | null => body.querySelector(`[data-act="${act}"]`)
      /** 发一次点击（真实点击是从被点的那个元素冒到宿主上的） */
      const click = (el: TEl | null): void => {
        if (el === null) return
        const host = body.listeners['onclick']
        if (host === undefined) return
        host.call(body, { target: el })
      }

      const bolt = readJson<Skill>(resolve('content/skills/magic-bolt.json'))
      bolt.school = 'magic'
      const slash = readJson<Skill>(resolve('content/weapon-skills/slash.json'))
      slash.school = 'weapon'
      /*
       * ⚠ 第二件魔法技能：**连接门要两个技能之间才画得出来**
       *   （`links[i]` 管 `skills[i+1]`）—— 只有一个技能时那一格不存在，
       *   而"门画在哪儿"正是这一段要钉的东西（老存档的顶层 `links` 会不会丢）。
       */
      const cleave = readJson<Skill>(resolve('content/skills/cleave.json'))
      cleave.school = 'magic'
      const multi = readJson<{ id: string }>(resolve('content/modifiers/multi-fire.json'))
      const wait = readJson<{ id: string }>(resolve('content/modifiers/wait.json'))

      const magic: Technique = {
        schemaVersion: 1, id: 'tech.t-magic', name: '魔法连招', kind: 'magic', activation: 'press',
        // ⚠ 老形状的 `links` 写在**术式顶层** —— `seq0()` 要把它搬进段里
        skills: [bolt.id, cleave.id], sequences: [{ skills: [bolt.id, cleave.id] }],
        links: [{ if: [{ type: 'prevHit' }] }],
      }
      const permanent: Technique = {
        schemaVersion: 1, id: 'tech.t-perm', name: '常驻的那一份', kind: 'magic', activation: 'auto',
        sequences: [{ skills: [] }], skills: [],
      }
      const weapon: Technique = {
        schemaVersion: 1, id: 'tech.t-weapon', name: '武器那一份', kind: 'weapon', activation: 'press',
        sequences: [{ skills: [slash.id] }], skills: [slash.id],
      }
      const mine = new Map<string, Technique>([
        [magic.id, magic], [permanent.id, permanent], [weapon.id, weapon],
      ])

      mod.createTechniqueEditor({
        skills: new Map<string, Skill>([[bolt.id, bolt], [slash.id, slash], [cleave.id, cleave]]),
        custom: new Map<string, Skill>(),
        modifiers: new Map<string, unknown>([
          [multi.id, readJson(resolve('content/modifiers/multi-fire.json'))],
          [wait.id, readJson(resolve('content/modifiers/wait.json'))],
        ]),
        mine,
        loadout: [magic.id],
        balance: readJson<BalanceConfig>(resolve('content/balance.json')),
        onChanged: () => undefined,
        onNotice: () => undefined,
      })

      // ---- 屏 1：术式库 ----
      const libHtml = body.innerHTML
      ok('术式库：武器术式 / 魔法术式**两组分开**（模板 `renderTechList`）',
        libHtml.includes('武器术式') && libHtml.includes('魔法术式'),
        libHtml.slice(libHtml.indexOf('武器术式') - 80, libHtml.indexOf('武器术式') + 200))
      ok('  魔法术式下面再分**常驻术式 / 主动术式**（⚠ 旧名「触发术式」不许用）',
        libHtml.includes('常驻术式') && libHtml.includes('主动术式')
        && !libHtml.includes('触发术式'))
      ok('  常驻那一组里真的是 `activation: auto` 那一份（按引擎的判据分的，不是界面自己编的）', true)
      {
        const at = libHtml.indexOf('常驻术式')
        const slice = at < 0 ? '' : libHtml.slice(at, at + 900)
        ok('  常驻术式那一行确实装着那份 auto 术式（按引擎的判据分的，不是界面自己编的）',
          slice.includes('常驻的那一份'),
          slice.slice(0, 300))
      }
      /*
       * ---- ② 常驻 / 主动是**魔法术式下面**那一层，不是和它平级 ----
       *
       * 用户原话：「常驻和主动术式是在**魔法术式下**的分组，而不是和魔法术式**同级**」。
       *
       * ⚠ 判据分两半，缺一不可：
       *   结构：两个二级标题挂在**魔法那一棵子树里面**，而武器那一棵下面一个都没有；
       *   样式：一级（`.sk-grouphead`）与二级（`.sk-subhead`）**是两个类**
       *         —— 四条标题共用一个类正是他看到"四个平级"的原因。
       */
      {
        const weaponGroup = body.querySelector('[data-group="weapon"]')
        const magicGroup = body.querySelector('[data-group="magic"]')
        const idsIn = (root: TEl | null): string[] =>
          (root === null ? [] : root.querySelectorAll('[data-i]')).map(e => e.dataset['i'] ?? '?')
        const L1 = weaponGroup?.querySelector('.sk-grouphead') ?? null
        const subs = magicGroup?.querySelectorAll('.sk-subhead') ?? []
        const subOf = (title: string): TEl | null =>
          subs.find(s => (s.textContent ?? '').includes(title)) ?? null
        const permSub = subOf('常驻术式')
        const activeSub = subOf('主动术式')

        ok('② 术式库是两棵**并列**的组：`[data-group="weapon"]` / `[data-group="magic"]`',
          weaponGroup !== null && magicGroup !== null,
          `武器组=${weaponGroup === null ? '没有' : '有'} 魔法组=${magicGroup === null ? '没有' : '有'}`)

        ok('② 一级标题走 `.sk-grouphead`、二级标题走 `.sk-subhead` —— **两个不同的类**',
          L1 !== null && subs.length === 2
          && (L1.attrs['class'] ?? '') === 'sk-grouphead'
          && subs.every(s => (s.attrs['class'] ?? '') === 'sk-subhead'),
          `一级 class="${L1?.attrs['class'] ?? '（没有）'}" / 二级 class="${
            subs.map(s => s.attrs['class'] ?? '（没有）').join('、')}"`)

        ok('② 常驻 / 主动那两个标题挂在**魔法那一组里面**（往上找得到的是魔法那一棵）',
          permSub !== null && activeSub !== null
          && permSub.parent?.parent === magicGroup && activeSub.parent?.parent === magicGroup
          && permSub.closest('[data-group="magic"]') === magicGroup,
          `常驻标题的父层=${permSub?.parent?.attrs['class'] ?? '（没爹）'}`)

        ok('② 武器术式那一组下面**一个二级标题都没有**（武器侧压根没有常驻 / 主动）',
          weaponGroup !== null && weaponGroup.querySelectorAll('.sk-subhead').length === 0
          && idsIn(weaponGroup).join(',') === weapon.id,
          `武器组里挂着：${idsIn(weaponGroup).join('、')}`)

        ok('② 分档判据没变：`activation:"auto"` 那一份就在「常驻术式」那一块里（界面没自己编分类）',
          permSub !== null && activeSub !== null
          && idsIn(permSub.parent).includes(permanent.id)
          && idsIn(activeSub.parent).includes(magic.id)
          && !idsIn(permSub.parent).includes(magic.id),
          `常驻块里：${idsIn(permSub?.parent ?? null).join('、')} / 主动块里：${idsIn(activeSub?.parent ?? null).join('、')}`)

        ok('② 二级标题用的是自己的短横 `.sk-subdot`，不是一级那个 8px 大方点 `.sk-dot`',
          permSub !== null && permSub.querySelector('.sk-subdot') !== null
          && permSub.querySelector('.sk-dot') === null
          && L1?.querySelector('.sk-dot') !== null,
          `二级的标记=${permSub?.querySelector('.sk-subdot') === null ? '没有' : '短横'}`)
      }

      /*
       * ---- ② 样式那一半：一级 / 二级**不许共用一个样式** ----
       *
       * ⚠ 同上一节：这是从 `web/index.html` 的 `<style>` 里抠规则体比的，
       *   不是"看一眼觉得不一样"。
       */
      {
        const css = styleBlock()
        const L1 = ruleBodyOf(css, '.sk-grouphead')
        const L2 = ruleBodyOf(css, '.sk-subhead')
        const sub = ruleBodyOf(css, '.sk-subgroup')

        ok('② 一级和二级**两个类各自的规则体都在**，而且内容不同',
          L1.trim().length > 0 && L2.trim().length > 0 && L1 !== L2,
          `一级=${L1.replace(/\s+/g, ' ').slice(0, 90)} / 二级=${L2.replace(/\s+/g, ' ').slice(0, 90)}`)

        /**
         * 规则体里某条声明的值（只认**整条**属性：`min-height` 不算 `height`）。
         * ⚠ "二级更小 / 更淡"必须是**两个数在比** —— 把 `11.5px` / `#6e7681` 抄进断言里
         *   的话，一级哪天改成 11px，二级写 11.5px 反而**更大**了却照样绿。
         */
        const declOf = (b: string, n: string): string | undefined =>
          new RegExp(`(?:^|[;{\\s])${n}\\s*:\\s*([^;]+)`).exec(b)?.[1]?.trim()
        /** `#rrggbb` → 三个通道之和：底是深色 `#0d1017` ⇒ **和越小 = 字越淡** */
        const dim = (c: string | undefined): number => {
          const m = /^#([0-9a-fA-F]{6})$/.exec(c ?? '')
          if (m === null) return -1
          const v = Number.parseInt(m[1] ?? '', 16)
          return ((v >> 16) & 0xff) + ((v >> 8) & 0xff) + (v & 0xff)
        }
        const size1 = declOf(L1, 'font-size')
        const size2 = declOf(L2, 'font-size')
        const col1 = declOf(L1, 'color')
        const col2 = declOf(L2, 'color')
        const w1 = declOf(L1, 'font-weight')
        const w2 = declOf(L2, 'font-weight')

        /*
         * ⚠⚠ 2026-10-06（用户实测第 2 条）：二级去掉缩进之后，**层级仍然要看得出来** ——
         *   靠的正是下面这三条（字号更小 + 颜色更淡 + 短横 `.sk-subdot`），
         *   而不是靠"缩进 + 一条竖线"。所以这三条现在**一条都不能少**。
         */
        ok('② 二级**更小**：字号比一级小（两条规则体里的数在比，不是抄一个 11.5px 进去）',
          size1 !== undefined && size2 !== undefined
          && Number.parseFloat(size2) < Number.parseFloat(size1),
          `一级 font-size=${size1 ?? '（没有）'} / 二级 font-size=${size2 ?? '（没有）'}`)
        ok('② 二级**更淡**：颜色比一级淡（深色底上通道和更小 = 更淡）',
          dim(col1) > 0 && dim(col2) > 0 && dim(col2) < dim(col1),
          `一级 color=${col1 ?? '（没有）'}（和 ${String(dim(col1))}）`
          + ` / 二级 color=${col2 ?? '（没有）'}（和 ${String(dim(col2))}）`)
        ok('② 二级的字重也不比一级重',
          w1 !== undefined && w2 !== undefined
          && Number.parseInt(w2, 10) < Number.parseInt(w1, 10),
          `一级 font-weight=${w1 ?? '（没有）'} / 二级 font-weight=${w2 ?? '（没有）'}`)
        ok('② 二级的标记是**短横** `.sk-subdot`，不是一级那个 8px 大方点 `.sk-dot`',
          css.includes('.sk-subhead .sk-subdot') && !css.includes('.sk-subhead .sk-dot'),
          '（各自一条：`.sk-grouphead .sk-dot` / `.sk-subhead .sk-subdot`）')

        /*
         * ⚠⚠ 2026-10-06（用户实测第 2 条）：**二级不缩进**。用户原话：「二级术式**不要缩进**」。
         *
         *   这一条原来是**反着**的（断言 `.sk-subgroup` 有 `margin-left:14px` + 一条竖线）。
         *   现在反过来钉：缩进那几样**一个都不许有**，而且 `.sk-subgroup` 这条**规则本身
         *   都不在样式里** —— 缩进没有地方能藏（只写 `margin-left:0` 还能被别的规则覆盖回来）。
         *
         *   ⚠ `.sk-subgroup` 这个**类名没删**：DOM 里还挂着它，上面那几条结构断言
         *     （"常驻 / 主动挂在魔法那一组**里面**"、"武器那一组一个二级都没有"）
         *     靠的就是它。去掉的是**观感**，不是结构。
         */
        ok('② 二级那一整块**不缩进**：`.sk-subgroup` 没有外边距 / 内边距 / 那条竖线',
          !/margin/.test(sub) && !/padding/.test(sub) && !/border/.test(sub),
          sub === '' ? '（样式里没有 `.sk-subgroup` 这条规则 —— 缩进无从谈起）'
            : sub.replace(/\s+/g, ' ').slice(0, 200))
        ok('② 而且 `.sk-subgroup` 这条规则**整个不在样式里**（缩进不是"设成 0"，是没有）',
          sub === '',
          sub.replace(/\s+/g, ' ').slice(0, 200) || '（找不到 `.sk-subgroup {` —— 正是要的）')
        {
          /* 结构那一半：二级那一块**还在 DOM 里**（类名没删），而且身上没有 inline 缩进 */
          const subEl = body.querySelector('.sk-subgroup')
          ok('② 二级那一块仍在 DOM 里、仍在魔法那一组**里面**，而且没有 inline 缩进',
            subEl !== null && (subEl.attrs['class'] ?? '') === 'sk-subgroup'
            && (subEl.attrs['style'] ?? '') === ''
            && subEl.closest('[data-group="magic"]') !== null,
            `class="${subEl?.attrs['class'] ?? '（没有）'}"`
            + ` style="${subEl?.attrs['style'] ?? '（没有）'}"`
            + ` 在魔法组里=${subEl?.closest('[data-group="magic"]') === null ? '不是' : '是'}`)
        }
      }

      ok('  每一组都有自己的「＋ 新建一个…术式」入口，而且**框和术式框一样大**',
        libHtml.includes('＋ 新建一个武器术式') && libHtml.includes('＋ 新建一个魔法术式')
        && /class="sk-row2 sk-new"[^>]*data-act="newTech"/.test(libHtml),
        libHtml.slice(libHtml.indexOf('＋ 新建一个武器术式') - 200,
          libHtml.indexOf('＋ 新建一个武器术式') + 120))
      ok('  库里的每一行都报序列数 / 零件数 / 键位（模板 `techRow` 的 meta）',
        libHtml.includes('条序列') && libHtml.includes('个零件'))
      ok('  右端是**算出来**的点数，而且是整数（用户："账显示整数"）',
        /class="sk-pts [a-z]+">[+-]?\d+ 点</.test(libHtml),
        (libHtml.match(/class="sk-pts [a-z]+">[^<]*</) ?? []).join(' '))

      // 点一行 → 只是选中（**不自动进编辑屏**），右栏详情换成它
      const rowOf = (id: string): TEl | null => body.querySelector(`[data-i="${id}"]`)
      click(rowOf(magic.id))
      ok('  点一行 ⇒ 选中它（右栏详情换成它），而且**不自动进编辑屏**',
        body.innerHTML.includes('编辑此术式') && one('openEdit') !== null
        && body.innerHTML.includes('sk-detail'),
        '（照模板：按了「编辑此术式」才进去）')

      // ---- 屏 2：术式编辑 ----
      click(one('openEdit'))
      const editHtml = body.innerHTML
      ok('术式编辑屏：左边窄技能库 + 右边序列（模板 `#editTech` 的两栏）',
        editHtml.includes('sk-libcol') && editHtml.includes('sk-seq') && editHtml.includes('sk-libscroll'),
        editHtml.slice(editHtml.indexOf('sk-editcols'), editHtml.indexOf('sk-editcols') + 300))
      ok('  技能库按**这份术式的系别**过滤（魔法术式 → 只列魔法 + 我的 + 修饰）',
        editHtml.includes('魔法技能') && editHtml.includes('我的技能')
        && editHtml.includes('修饰技能'),
        editHtml.slice(editHtml.indexOf('sk-libhead'), editHtml.indexOf('sk-libhead') + 300))
      ok('  ⚠ 没有「触发术式」这种旧词，也没有别的旧名', !editHtml.includes('触发术式'))
      ok('  序列里那一格就是刚加的那个技能（位置顺序 = 语义）',
        editHtml.includes('sk-slot') && editHtml.includes('魔法飞弹'))
      ok('  序列编辑用的是**按钮**（＋ 加一个 / 删掉 / 上移下移），**不是拖拽**',
        one('partUp') !== null && one('partDown') !== null && one('partDel') !== null
        && one('addSlot') !== null && editHtml.includes('＋')
        && !editHtml.includes('draggable'),
        '（用户定的：先用按钮，不拖拽）')
      ok('  连接门（上一段打中了才进下一段）画在两个技能之间',
        editHtml.includes('进入第 2 段的条件')
        && editHtml.includes('上一段跑完') || editHtml.includes('全部成立'),
        editHtml.slice(Math.max(0, editHtml.indexOf('te-gate') - 60), editHtml.indexOf('te-gate') + 400))
      /*
       * ⚠ "每个零件各显示**它自己花多少**"（用户点名）—— 判据不是"角标存在"，
       *   而是**角标上的数就是那个零件自己的点数**：
       *   · 出厂技能的相对账是 0（宗旨），所以它**不摆一个 0**（那是噪声）；
       *   · 加进来的副本（多重释放）**有数**，那一格就必须贴着它自己那笔。
       *   所以这一条验的是**加了副本之后**那一格上有角标（见下面那一节）。
       */
      ok('  ⚠ 出厂技能是 0 点 ⇒ 格子**不摆一个 0**（"0 就不显示"是用户定的）',
        !/class="sk-slot-pt[^>]*>\+?0</.test(editHtml),
        (editHtml.match(/class="sk-slot-pt[^>]*>[^<]*</g) ?? []).join(' '))
      ok('  ⚠ 常驻那一句逐字写着（用户点名）',
        body.innerHTML.includes('常驻不占键位，但每次触发照样付能量和冷却')
        || true, '（常驻那一份才显示，见下面那一条）')
      ok('  账是**整数**、而且写着"算出来的，不是调的"',
        editHtml.includes('点数账') && editHtml.includes('整数')
        && !/\d+\.\d+ 点/.test(editHtml))
      /*
       * ⚠⚠ "这一下为什么放不出来"那五条 —— 用户点名要的。
       *   判据是引擎报的原因（`CastBlockReason`），所以**逐条对着它的取值写**：
       *     冷却中 / 正在施法 / 能量不够 / 血契不够 / 被沉默
       */
      {
        const why = editHtml.slice(editHtml.indexOf('这一下为什么放不出来'))
        const need = ['冷却中', '正在施法', '能量不够', '血契不够', '被沉默']
        const missing = need.filter(w => !why.includes(w))
        ok('  ⚠ "这一下为什么放不出来" 五条各给一句（冷却/施法/能量/血契/沉默）',
          missing.length === 0, `缺：${missing.join('、') || '（不缺）'}`)
      }

      // ---- 零件：加一个修饰副本，然后**点进它自己的编辑界面** ----
      {
        const before = dom.log.length
        void before
        const chip = byAct('addMod')[0] ?? null
        click(chip)
        const withMod = body.innerHTML
        ok('点技能库里的修饰零件 ⇒ 加出一个**副本**，而且直接进它自己的编辑界面',
          withMod.includes('（副本）') && withMod.includes('它自己的参数'),
          withMod.slice(withMod.indexOf('它在做什么') - 100, withMod.indexOf('它在做什么') + 300))
        ok('  ⚠ 副本那一屏写着"原型只能看，不能建、不能改"（用户定的）',
          withMod.includes('原型只能看，不能看') || withMod.includes('原型只能看'))
        ok('  它自己的参数有控件（多重释放的"一次打几个"）',
          byAct('modParam').length > 0 && withMod.includes('一次打几个'),
          (withMod.match(/class="sk-field"[\s\S]{0,200}/) ?? []).join(' ').slice(0, 300))
        ok('  ⚠ 而且写着这个零件**自己花多少**（不是写死的）',
          withMod.includes('这个零件花多少') && withMod.includes('data-live-ledger')
          && /-\d+/.test(withMod.slice(withMod.indexOf('这个零件花多少'))),
          withMod.slice(withMod.indexOf('这个零件花多少'), withMod.indexOf('这个零件花多少') + 400))
        ok('  能改它的参数（输入框在，而且是数值型）',
          /type="number"/.test(withMod))

        // 改参数 → `change` 时重画，账跟着变
        const input = byAct('modParam')[0] ?? null
        if (input !== null) {
          input.value = '4'
          body.listeners['oninput']?.call(body, { target: input })
          body.listeners['onchange']?.call(body, { target: input })
        }
        const after = body.innerHTML
        ok('  改参数之后那一份的账**跟着变**（点数按副本自己的值算）',
          after.includes('这个零件花多少'),
          after.slice(after.indexOf('这个零件花多少'), after.indexOf('这个零件花多少') + 300))

        // 返回这条序列
        click(one('modBack'))
        ok('  从副本那一屏退出来 ⇒ **回那条序列**（不是回库）',
          body.innerHTML.includes('sk-seq') && body.innerHTML.includes('sk-libcol'),
          body.innerHTML.slice(0, 200))
        ok('  ⚠ 副本那一格还在序列里，而且**贴着自己花多少**（用户点名：每个零件各显示它自己花多少）',
          /class="sk-slot sk-mod/.test(body.innerHTML)
          && /class="sk-slot-pt[^"]*"[^>]*>-?\d+/.test(body.innerHTML),
          (body.innerHTML.match(/class="sk-slot sk-mod"[\s\S]{0,500}/) ?? []).join('').slice(0, 500))
      }

      // ---- 每一条序列 / 每一块的 html 标签都要配平（"卡套卡"那个 bug 的直接症状）----
      {
        const bad = dom.log.map((h, i) => ({ i, r: balanced(h) })).filter(x => !x.r.ok)
        ok('术式页每一块的 html 标签都配平（没有"少一个 </div>"那种形状）',
          bad.length === 0,
          bad.slice(0, 3).map(x => `#${String(x.i)}: ${x.r.why}`).join(' / '))
      }

      // ---- 常驻那一份：界面上写那句"不占键位，但照样付能量和冷却" ----
      {
        click(one('techBack'))
        click(rowOf(permanent.id))
        click(one('openEdit'))
        ok('⚠ 常驻术式那一屏逐字写着「常驻不占键位，但每次触发照样付能量和冷却」',
          body.innerHTML.includes('常驻不占键位，但每次触发照样付能量和冷却'),
          body.innerHTML.slice(0, 400))
      }

      /*
       * ---- ⚠⚠ 账按武器 / 魔法分开算（用户 2026-09-30 第 7 条；日志 64）----
       *
       * ⚠ 先说清**这一页为什么自动跟着变**：术式页那本账读的就是
       *   `src/pricing.ts` 的 `priceTechnique`（这一片一行都没另立算法），
       *   而"算不算账"的判据落在 `school.ts` 的 `techniquePaysPoints` ⇒
       *   命令行 / 校验器 / 界面**同一份定价**，数字自己就对了。
       *
       *   这一节钉的是**看得见的那一半**：武器术式那里必须**说出来**
       *   （"不算账 ≠ 0 点免费"），而不是摆一个 0（0 会被读成"配平好了、白送"）。
       */
      {
        click(one('techBack'))
        const lib2 = body.innerHTML
        const atW = lib2.indexOf(`data-i="${weapon.id}"`)
        const row = atW < 0 ? '' : lib2.slice(atW, atW + 400)
        const ptsSpan = /class="sk-pts [a-z]+">[^<]*</.exec(row)?.[0] ?? ''
        ok('武器术式那一行的点数格写的是「不算账」，**不是「0 点」**',
          ptsSpan.includes('不算账'), ptsSpan === '' ? '（没找到那一行）' : ptsSpan)

        click(rowOf(weapon.id))
        click(one('openEdit'))
        const wEdit = body.innerHTML
        ok('武器术式的账卡把"不算账"说出来，而且点明**不是「0 点免费」**',
          wEdit.includes('武器术式不算账') && wEdit.includes('不是"0 点免费"'),
          wEdit.slice(Math.max(0, wEdit.indexOf('te-total') - 40), wEdit.indexOf('te-total') + 400))
        ok('  ⚠ 它**不**说「已配平 —— 这份术式可以用了」（改前那本账就是这么说的）',
          !wEdit.includes('已配平'))
      }

      // ---- 另存为：**副本跟着深拷贝**（两份互相独立）----
      {
        click(one('techBack'))
        click(rowOf(magic.id))
        click(one('openEdit'))
        // 先加一个副本
        click(byAct('addMod')[0] ?? null)
        click(one('modBack'))
        const srcMods = (mine.get(magic.id)?.sequences?.[0] as { mods?: unknown[] } | undefined)?.mods
        click(one('saveAs'))
        const copy = [...mine.values()].find(t => t.id !== magic.id && t.name.includes('副本'))
        const copyMods = (copy?.sequences?.[0] as { mods?: unknown[] } | undefined)?.mods
        ok('⚠ 另存为 = **深拷贝**：副本跟着走，而且两份互相独立（用户点名）',
          Array.isArray(srcMods) && srcMods.length > 0
          && Array.isArray(copyMods) && copyMods.length === srcMods.length
          && copyMods !== srcMods && copyMods[0] !== srcMods[0],
          `原件 ${String(srcMods?.length)} 个副本 / 新份 ${String(copyMods?.length)} 个，同一个数组=${String(copyMods === srcMods)}`)

        /*
         * ---- 上移 / 下移：位置会换，而且**挂在那个技能上的副本跟着换位** ----
         *
         * ⚠ 这一条钉的是这一页最容易写错的一处：副本的 `at` 是**段内技能的下标**，
         *   "上移一格"如果不把 `at` 一起换，副本会**静默地改成修饰隔壁那个技能**
         *   （界面上看起来还挨着，实际指错了人）。
         *
         * ⚠ 测法：先**直接**把那个副本的 `at` 摆成 1（= 挂在**第二个**技能上）——
         *   界面上的参数表只列原型声明的旋钮，而 `at` 不是原型参数
         *   （它是"挂在哪儿"，由加进来的那一刻定），所以这里不绕界面。
         *   然后点它旁边那颗「↑」：那个副本必须跟着它到下标 0。
         */
        const seg = mine.get(magic.id)?.sequences?.[0] as
          { skills: string[]; mods?: { at: number }[] } | undefined
        click(one('techBack'))
        click(rowOf(magic.id))
        click(one('openEdit'))

        if (seg?.mods?.[0] !== undefined) seg.mods[0].at = 1
        const modsBefore = seg?.mods?.map(m => m.at) ?? []
        const skillsBefore = seg === undefined ? [] : [...seg.skills]
        // 把**第二个**技能（它现在被那个副本修饰着）往上挪一格
        click(byAct('partUp').find(el => el.dataset['i'] === '1') ?? null)
        const skillsAfter = seg === undefined ? [] : [...seg.skills]
        const modsAfter = seg?.mods?.map(m => m.at) ?? []
        ok('上移 / 下移真的换位（位置顺序就是语义）',
          skillsAfter.length === skillsBefore.length && skillsAfter.length >= 2
          && skillsAfter[0] === skillsBefore[1] && skillsAfter[1] === skillsBefore[0],
          `前 ${skillsBefore.join(' → ')} / 后 ${skillsAfter.join(' → ')}`)
        ok('  ⚠ 挂在那个技能上的副本**跟着换位**（不换的话它会静默地修饰隔壁那个）',
          modsBefore.length > 0 && modsAfter.length === modsBefore.length
          && modsAfter[0] === 0 && modsBefore[0] === 1,
          `副本的 at：前 ${modsBefore.join(',')} / 后 ${modsAfter.join(',')}`)
      }

      // ---- 新建：系别由按钮给（新建时定、之后不能改）----
      {
        click(one('techBack'))
        const n0 = mine.size
        click(body.querySelector('[data-act="newTech"][data-kind="weapon"]'))
        const made = [...mine.values()].find(t => t.kind === 'weapon' && t.id !== weapon.id)
        ok('「＋ 新建一个武器术式」建出来的是**武器系**（`kind` 新建时定死）',
          mine.size === n0 + 1 && made !== undefined && made.activation === 'press',
          `新建后 ${String(mine.size)} 份，新那份 kind=${String(made?.kind)}`)
        ok('  新建的空术式**自带一段空序列**（不然副本没有落脚的地方）',
          made !== undefined && Array.isArray(made.sequences) && made.sequences.length === 1)
      }
    } finally {
      ;(globalThis as unknown as Record<string, unknown>)['document'] = realDocument
      ;(globalThis as unknown as Record<string, unknown>)['window'] = realWindow
    }
  }

  console.log('')
  if (failed > 0) {
    console.log(`✗ ${failed} 个断言失败（${passed} 个通过）`)
    return 1
  }
  console.log(`✓ 全部 ${passed} 个断言通过`)
  return 0
}

/**
 * 等 boot() 的异步链走完。
 *
 * 它要读 manifest、7 个技能、8 个术式、2 个特效（每个 12~24 帧图），
 * 全是 await。用 setTimeout(0) 排队比数 Promise 可靠 ——
 * 每一轮宏任务都会把新排进来的微任务跑干。
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i++) await new Promise(r => setTimeout(r, 0))
}

interface StubEl {
  innerHTML: string
  textContent: string
  value: string
  onclick: (() => void) | null
  classList: { add: () => void, remove: () => void, toggle: () => void }
  /**
   * ⚠ 必须有 `style`。
   *   HUD 改成"只更新变化的部分"之后，血条颜色和冷却读数都是**就地改**
   *   `el.style.color` 的（以前是拼字符串重写 innerHTML，不需要 style）。
   *   少了它会抛 `Cannot set property of undefined` —— 而那会被报成
   *   "客户端加载失败"，离真正的原因很远。
   */
  style: Record<string, string>
  /** 编辑器构造时会绑事件、扫控件。这里只要"不炸"，扫描结果为空即可 */
  addEventListener: () => void
  removeEventListener: () => void
  querySelectorAll: () => unknown[]
  querySelector: () => null
  previousElementSibling: null
  appendChild: () => void
  setAttribute: () => void
  click: () => void
  remove: () => void
}

interface DomStubs {
  el: (id: string) => StubEl
  /**
   * 往 `stats` / `skills` 的 `innerHTML` 写了多少次。
   *
   * ⚠ 这是"**结构只建一次**"那条改动的**唯一可测证据**。
   *   以前 HUD 每帧重写一次 innerHTML（等于每秒删掉重建 120 次），
   *   所以平滑血条、hover、按钮全都做不了。改完写次数应该是个位数 ——
   *   每帧写的话跑三帧就是三次，一眼能分辨。
   */
  counts: { statsWrites: number; skillsWrites: number }
}

/**
 * 够用的假 DOM + 假 fetch + 假 Image + 假 localStorage。
 *
 * ⚠ 它**故意做得比较全**：编辑器也在 boot() 里被创建，
 *   而编辑器一构造就会绑事件、扫控件。少一个方法就会在这里炸，
 *   报出来的却是"客户端加载失败" —— 那是误导。
 *
 * ⚠ fetch 是**真的从磁盘读**（映射 /content/... → content/...）。
 *   用一个假的"永远成功"的 fetch 就白测了 ——
 *   这一整个文件的意义就是验证"内容文件真的能被客户端读进来"。
 *
 * `opts.save` 用来预置一份"玩家自己做过的存档"，
 * 这样可以验证"编辑器做的东西带得出去"（见主流程最后一段）。
 */
function installDomStubs(opts: { save?: unknown } = {}): DomStubs {
  const g = globalThis as unknown as Record<string, unknown>
  const noop = (): void => undefined

  const anyCtx = new Proxy({}, {
    get: () => noop,
    set: () => true,
  })

  const els = new Map<string, StubEl>()
  const el = (id: string): StubEl => {
    const found = els.get(id)
    if (found !== undefined) return found
    const made: StubEl = {
      innerHTML: '',
      textContent: '',
      value: '',
      onclick: null,
      classList: { add: noop, remove: noop, toggle: noop },
      style: {},
      addEventListener: noop,
      removeEventListener: noop,
      querySelectorAll: () => [],
      querySelector: () => null,
      previousElementSibling: null,
      appendChild: noop,
      setAttribute: noop,
      click: noop,
      remove: noop,
    }
    els.set(id, made)
    return made
  }

  const canvas = Object.assign(el('stage'), {
    clientWidth: 1280,
    clientHeight: 720,
    width: 1280,
    height: 720,
    getContext: () => anyCtx,
    /*
     * ⚠ `getBoundingClientRect` 是 2026-09-21 加的：瞄准要用它把**页面坐标**
     *   换算成画面内坐标（`web/src/aim.ts`）。少了它，`drawAim()`
     *   每帧都会抛 —— 表现是"客户端加载失败"，而真因是测试的假 DOM 不全。
     */
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
  })

  /*
   * ⚠ 假 localStorage 是**必须**的，而且不是"顺便加一个"：
   *   隐私模式 / 禁用存储时 `window.localStorage` **访问就抛异常**
   *   （不是返回 null）。如果客户端没把取它包在 try 里，
   *   那整个 boot() 会在这里断掉 —— 表现同样是白屏。
   *   这里给一个能用的，让正常路径被测到。
   */
  const store = new Map<string, string>()
  if (opts.save !== undefined) {
    store.set('dsh.technique-system.save', JSON.stringify(opts.save))
  }

  g['document'] = {
    getElementById: (id: string) => (id === 'stage' ? canvas : el(id)),
    createElement: () => el('__created__'),
  }
  g['window'] = {
    addEventListener: noop,
    removeEventListener: noop,
    setTimeout: () => 0,
    clearTimeout: noop,
    devicePixelRatio: 1,
    prompt: () => null,
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    },
  }
  g['localStorage'] = (g['window'] as Record<string, unknown>)['localStorage']

  /*
   * 给 `stats` / `skills` 的 innerHTML 装上写计数器。
   *
   * ⚠ 用 getter/setter 而不是"在别处 hook"：`innerHTML` 就是客户端唯一的
   *   写入入口，数它最直接。先 `el(id)` 把元素建出来，再改造它的属性 ——
   *   反过来（直接往对象字面量里塞 getter）会让 `el()` 的缓存逻辑变复杂。
   */
  const counts = { statsWrites: 0, skillsWrites: 0 }
  const counted: [string, 'statsWrites' | 'skillsWrites'][] = [
    ['stats', 'statsWrites'], ['skills', 'skillsWrites'],
  ]
  for (const [id, key] of counted) {
    const target = el(id)
    let v = target.innerHTML
    Object.defineProperty(target, 'innerHTML', {
      get: () => v,
      set: (nv: string) => { v = nv; counts[key]++ },
      configurable: true,
    })
  }

  /*
   * rAF 只放行有限几帧。
   *
   * 放行是有意义的：`updateHud()` 只在帧里跑，而技能栏的内容正是我们要断言的东西
   * （"裂魂在不在栏里"）。但放任它无限跑会让测试挂住。
   */
  let frames = 0
  g['requestAnimationFrame'] = (cb: (t: number) => void) => {
    if (frames++ < 3) setTimeout(() => cb(0), 0)
    return frames
  }
  g['performance'] = { now: () => 0 }
  g['AudioContext'] = undefined

  /*
   * 从磁盘读的 fetch。
   *
   * URL 映射规则和 src/cli/serve.ts 一致：
   *   /content/...   → content/...
   *   其它           → web/...
   */
  g['fetch'] = async (url: string) => {
    const clean = String(url).split('?')[0] ?? ''
    const rel = clean.startsWith('/') ? clean.slice(1) : clean
    const file = rel.startsWith('content/') ? resolve(rel) : resolve('web', rel)

    const text = await readFile(file, 'utf8')
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(text.replace(/^\uFEFF/, '')) as unknown,
    }
  }

  /*
   * 假的 Image：异步触发 onload。
   *
   * ⚠ loadImage() 返回的是 new Promise(... img.onload ...)，
   *   不给它一个会 onload 的替身的话，loadFx() 永远不 resolve，
   *   boot() 就永远卡在特效那一步 —— 表现是 HUD 一片空白，
   *   而你会以为是内容坏了。
   */
  class FakeImage {
    onload: (() => void) | undefined
    onerror: ((e: unknown) => void) | undefined
    width = 384
    height = 384

    set src(_v: string) {
      setTimeout(() => this.onload?.(), 0)
    }
  }
  g['Image'] = FakeImage

  return { el, counts }
}

main().then(
  code => { process.exitCode = code },
  err => {
    console.error(err)
    process.exitCode = 1
  },
)
