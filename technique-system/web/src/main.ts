/**
 * 里程碑 0.5 —— 让它在屏幕上动起来。
 *
 * 这个文件的全部意义是验证一件事：
 *
 *   **core-sim 真的能在浏览器里跑，而且跑出来的和命令行里一模一样。**
 *
 * 它没有复用 src/cli/ 下的任何东西 —— 那些要读文件、要打印，
 * 而这里只能 fetch。所以它是一个纯粹的、独立的消费方：
 * 如果 src/sim/ 里混进了任何环境相关的东西，这里立刻就崩。
 *
 * 它自己不做三件事：
 *   1. 不模拟 —— stepWorld 才是唯一的真相
 *   2. 不做时间 —— 用累加器把渲染帧和固定 tick 解耦
 *   3. 不改状态 —— 渲染只读
 *
 * ---
 *
 * ## 打击感的分工
 *
 * 顿帧和击退在**模拟层**（src/sim/），因为它们改变玩法：
 *   渲染层假装停顿的话，模拟还在跑，停顿结束后敌人会"跳"一下。
 *
 * 闪白、飘字、粒子、抖屏、音效在**这里**，因为它们只读事件：
 *   删掉这个文件里的 fx 一节，游戏玩法一点不变，只是不好玩。
 */

// 注意：不能 import ../schema.ts（在 rootDir 之外，而且浏览器里也不需要）。
// 用 Parameters / ReturnType 从函数签名里"取"类型，一样精确。
import {
  activate, bloodPactOf, canAct, cancelCast, createWorld, factionOf, getStored, nearestPickup,
  peekSequence, pickupNearby, pressSequence, registerEntityDef, registerStatusDef, registerTechnique, releaseCharge,
  resolveAttribute, setStored, setTechniqueActive, stepWorld, visibilityOf,
} from '../../src/sim/index.ts'
import type { Entity, SimEvent } from '../../src/sim/index.ts'
import type { CooldownNotice, PressResult } from '../../src/sim/index.ts'
import type { AimIntent } from '../../src/sim/targeting.ts'
import type { BalanceConfig } from '../../src/validator/types.ts'
import { collectStatuses, checkRefs } from '../../src/validator/checks.ts'
import { bloodPactCostOf, priceOptionsFor } from '../../src/pricing.ts'
import { describeStatusTip } from '../../src/describe.ts'
import { compileTechnique } from '../../src/sim/compile.ts'
import type { CompiledTechnique } from '../../src/sim/compile.ts'
// ⚠ 只能 `import type` —— schema 只是类型，`import type` 会被完全擦掉，
//   编译产物里不会多出一次浏览器加载不了的模块解析。
import type { EntityDef, ModifierProto, Scenario, Skill, StatusDef, Targeting, Technique as TechniqueDef, WeaponDef } from '../../src/schema.ts'

/*
 * 装配层和命令行共用一份（src/scenario.ts）。
 *
 * ⚠ 这条 import 是**运行时代码**，不是 import type —— 它会被真的编进产物。
 *   之前开局是写死在这个文件里的，结果是"每加一个技能都要改引擎代码"，
 *   而且做完的术式只要不在那个数组里，玩家就永远选不到。
 */
import { applyScenario, fallbackScenario, lowerScenario } from '../../src/scenario.ts'
// ⚠ 系别章（派生字段）：`content/skills` → 魔法系、`content/weapon-skills` → 武器系。
//   规则只有一份，在 src/school.ts 里（命令行和浏览器共用）。
import { stampSchool } from '../../src/school.ts'
import { createEditor } from './editor.ts'
import type { Editor, EditorHost } from './editor.ts'
import { createTechniqueEditor } from './technique-editor.ts'
import type { TechniqueEditor } from './technique-editor.ts'
import { decodeShare, encodeShare, loadState, mintCustomId, saveState, SAVE_VERSION } from './store.ts'
import type { StorageLike } from './store.ts'
import {
  drawDelivery, drawSprite, pickStatusStyle, spawnDelivery, spriteDone, statusPrims,
  updateDelivery, updateSprite,
} from './fx.ts'
import type { DeliveryFx, SpriteFx } from './fx.ts'
import { loadFxLibrary } from './assets.ts'
import type { FxAsset } from './assets.ts'
import { aimFromPointer } from './aim.ts'

type World = ReturnType<typeof createWorld>
/** 引擎认的是编译产物。术式只是编排，技能是零件 */
type Technique = CompiledTechnique

let editor: Editor | undefined
let techEditor: TechniqueEditor | undefined
/**
 * 技能编辑器的宿主对象。
 *
 * ⚠ 必须**建一次、之后改字段**，不能每次渲染新建一个：
 *   编辑器手里存的是这个对象的引用，换对象的话它读到的还是旧的
 *   `copies` / `activeOwner` —— 表现就是"切了归属，改动却还写进上一份术式"。
 */
let editorHost: EditorHost | undefined

// ---------------------------------------------------------------- 常量

const PX_PER_M = 34            // 每米多少像素
const ARENA = 18               // 场地半径（米）
/*
 * 技能栏按键。
 *
 * ⚠ 从 5 个扩到 8 个，再扩到 10 个（1~9 然后 0）—— 内容是先长的，按键是后补的。
 *   每次都是同一个病：技能做完了却没有键位，玩家永远选不到 —— 做完了等于没做。
 *   裂魂和名刀司命这么丢过一次，潜行/洞察/猎杀差点又丢一次。
 *
 * 自定义按键（玩家自己绑）是后面的事，但"装不下"现在就得解决。
 */
const CAST_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as const

const FLASH_TIME = 0.14        // 受击闪白持续多久。要 > 最长顿帧（0.12），否则看不见
const FLOATER_LIFE = 0.75
const PARTICLE_LIFE = 0.4
const MAX_SHAKE = 9            // 像素

const COLOR = {
  bg: '#0d1017',
  grid: '#161b22',
  gridBold: '#1f2630',
  wall: '#30363d',
  player: '#58a6ff',
  enemy: '#f85149',
  neutral: '#8b949e',
  projectile: '#d29922',
  hpBack: '#21262d',
  hpPlayer: '#3fb950',
  hpEnemy: '#f85149',
  dim: '#6e7681',
  castBar: '#a371f7',
  damage: '#ff7b72',
  heal: '#3fb950',
  blocked: '#d29922',
}

// ---------------------------------------------------------------- DOM

const canvas = document.getElementById('stage') as HTMLCanvasElement
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
const statsEl = document.getElementById('stats') as HTMLDivElement
const skillsEl = document.getElementById('skills') as HTMLDivElement
const toastEl = document.getElementById('toast') as HTMLDivElement

let world: World
let player: Entity

/*
 * 三张表，对应两层模型：
 *
 *   skills     技能（零件）—— 编辑器改的就是它
 *   techniques 术式（编排）—— 只是"哪几个技能、按什么顺序"，没有效果
 *   library    **编译产物** —— 引擎和 HUD 只认它
 *
 * 编辑一个技能之后必须**重新编译**用到它的术式，否则改了等于没改。
 */
const skills = new Map<string, Skill>()
const techniques = new Map<string, TechniqueDef>()
const library = new Map<string, Technique>()
/**
 * 状态库（`content/statuses/`）。
 *
 * ⚠ 它不只是"装配时要注册进去"—— 定价也要用它。
 *   技能里 `statusId: "status.shield"` 这种引用，只有查得到定义才算得出点数；
 *   查不到就是 0 点，编辑器里看着像白送的效果。
 */
const statusDefs = new Map<string, StatusDef>()

/**
 * 实体预设（`content/entities/`）。
 *
 * ⚠ 和状态库一样要**两头都用**：
 *   装配时要注册进世界（否则 spawn 运行到那一刻抛「找不到实体预设」），
 *   定价时也要传（否则召唤物的血量池算不进点数）。
 */
const entityDefs = new Map<string, EntityDef>()

/**
 * 武器（`content/weapons/`）。
 *
 * ⚠ 和状态库 / 实体预设同一类：**内容层的一张表**，现在先加载 + 校验引用，
 *   真正的"装到人身上"（属性代入、左键绑武器术式）是武器运行时那一轮的事。
 *   现在加载它的意义是：武器文件写错了**在开局就能看见**，
 *   而不是等按下左键才发现没反应。
 */
const weaponDefs = new Map<string, WeaponDef>()

/**
 * **修饰原型表**（`content/modifiers/`，2026-09-21 日志 48）。
 *
 * ⚠ 它和上面那几张表有一处根本不同：**玩家改不了它**
 *   （原型只做出厂那一批，副本住在**术式**里）。所以它是内容层的最后一张表。
 *
 * ⚠ 存的是**整份原型**（不是只存 `kind`）：编译要按它解析每个副本
 *   （类别 + 引擎要读的那几个默认参数），而"再开一张只存 kind 的小表"
 *   就是**同一个事实的第二份真相**（两张表迟早漂开）。
 *   编辑器要的 `paramsTemplate` 也在原型里，但引擎**不读它**
 *   （引擎只读 `params`，见 schema 的 `ModifierProto`）。
 */
const modifierProtos = new Map<string, ModifierProto>()
/** 从磁盘加载时的原始技能版本。编辑器用它做"还原" */
const originals = new Map<string, Skill>()
/** 技能 id → 用到它的术式名。编辑器要显示"这个技能挂在哪儿" */
const usedBy = new Map<string, string[]>()
/**
 * 术式 id → **放不出来的原因**（编译问题 / 还是个空壳）。
 *
 * ⚠ 它存在的唯一理由是"失败必须可见"：一份空术式被绑到按键上时，
 *   它不进 `library`（引擎里等于不存在），而技能栏以前是**静默跳过**它的 ——
 *   玩家看到的是"编辑器说装好了，游戏里按下去没反应，也不说为什么"。
 *   现在技能栏那一格会画成"放不出来"+ 原因，按下去也会把原因说出来。
 */
const techniqueProblems = new Map<string, string[]>()
let loadout: string[] = []

/**
 * 玩家的术式库（`tech.mine-*`）。
 *
 * ⚠ 这一份和 `techniques` 是**同一批对象**，不是副本：
 *   编辑器就地改它，改完 `recompileAll()` 直接拿新内容重编译。
 *   分成两份副本的话，"编辑器里改了但场上没变"迟早会发生。
 *
 * ⚠ 出厂术式**不在这里** —— 它们住在 `content/internal-techniques/`
 *   （引擎和敌人在用），玩家既看不到也引用不到（见 `technique-editor.ts` 的开头）。
 */
const mine = new Map<string, TechniqueDef>()

/**
 * 玩家自己排的技能栏（按键 1..0）。空数组 = 用场景里写的那一套 */
const savedLoadout: string[] = []

/**
 * 开局发的那份术式**是哪一个**（`SavedState.starterId`）。
 *
 * ⚠ 三种状态分开：
 *   `undefined` —— 还没发过 → 发一份
 *   有值、还在库里 → 什么都别做（他可能已经改过了）
 *   有值、不在库里 → 他自己删的 → **不许再发**（不然像是删不掉）
 */
let starterId: string | undefined

/**
 * ---- **自定义技能库**：玩家创造出来的变体（`Skill.basedOn` 指向模板）----
 *
 * ⚠ 玩家 2026-09-21 定的**两个库**：
 *
 *   · **基础技能库** = `skills`（`content/skills/*.json`）：出厂内容、只读、
 *     默认配平为 0。它同时是"创造一个技能"时能选的**模板**。
 *   · **自定义技能库** = 就是这一份：玩家编出来的变体，**存在存档里**。
 *
 * 技能**不属于任何术式**：术式按 id 引用技能，两个库都能引用。
 * 所以改一个变体，**所有用到它的术式一起变** —— 这是玩家要的。
 */
const customSkills = new Map<string, Skill>()

/**
 * 查技能：**自定义库优先、基础库兜底**。
 *
 * ⚠ 全项目只有这一句"按 id 找技能"（编译、定价、算血契、编辑器都走它）。
 *   分成几处各写一遍的话，迟早有一处只查基础库 ——
 *   而那种漏法是静默的：技能段用的是**基础版**的数值，账却按变体算。
 */
function findSkill(id: string): Skill | undefined {
  return customSkills.get(id) ?? skills.get(id)
}

/**
 * 存档用的存储。
 *
 * ⚠ 抽成一个变量而不是直接用 `localStorage`，有两个原因：
 *   1. 隐私模式 / 禁用 cookie 时 `localStorage` **访问就抛**（不是返回 null），
 *      所以连取它都要包在 try 里；
 *   2. 测试里能塞个假的进去。
 */
function storage(): StorageLike | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

function persist(): void {
  const ok = saveState(storage(), {
    version: SAVE_VERSION,
    skills: [...customSkills.values()],
    techniques: [...mine.values()],
    loadout: [...savedLoadout],
    starterId,
  })
  if (!ok) toast('存档写不进去（浏览器不让存）—— 这次改动关掉页面就没了')
}

/**
 * 当前在玩的场景。
 *
 * ⚠ 开局的一切都从它来 —— 玩家带哪些术式、敌人是谁、各多少血。
 *   这个文件里**不再**写死任何阵容。
 */
let scenario: Scenario | undefined

/**
 * 平衡配置。**模块级**，因为 `recompileAll()` 要用它算血契消耗，
 * 而那个函数不在 `boot()` 里。
 *
 * 读不出来（balance.json 坏了）就是 undefined —— 那时候点数一律算不出来，
 * 血契消耗按 0 处理。**不 throw**：内容坏了要能进游戏，只是负值术式
 * 不扣血契而已（这一点会写在加载失败的提示里）。
 */
let balanceConfig: BalanceConfig | undefined

/**
 * 暂停。
 *
 * 停的是**整个模拟**，不是渲染 —— 渲染继续跑，所以暂停时画面还是活的
 * （特效会继续衰减，飘字会继续飞）。打开编辑器会自动暂停。
 */
let paused = false

function toast(msg: string): void {
  toastEl.textContent = msg
  toastEl.classList.add('show')
  window.setTimeout(() => toastEl.classList.remove('show'), 900)
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json() as T
}

// ============================================================================
//  表现层：特效
// ============================================================================
//
// 这一整节都是"只读消费事件"。删掉它游戏照样跑，只是不好玩。

interface Floater {
  x: number; y: number      // 屏幕坐标
  text: string
  color: string
  age: number
  big: boolean
}

interface Particle {
  x: number; y: number      // 屏幕坐标
  vx: number; vy: number    // 像素/秒
  color: string
  age: number
  size: number
}

const floaters: Floater[] = []
const particles: Particle[] = []

/**
 * 载体特效（挥砍的刀光、光束、范围爆发…）。
 *
 * ⚠ 它和上面那两样**不在同一个坐标空间**：飘字和粒子画在屏幕空间
 *   （文字不能被缩放糊掉），而载体特效是**世界几何**，画在米里。
 *
 * 两条路线并存：
 *   `deliveries` 程序化 —— 零资产，按载体 + 伤害类型自动挑
 *   `sprites`    序列帧 —— 作者做的（`content/fx/`），技能里写了 `vfx` 就用它
 */
const deliveries: DeliveryFx[] = []
const sprites: SpriteFx[] = []

/** 作者做的序列帧特效，按 id 索引 */
const fxAssets = new Map<string, FxAsset>()

/** 实体 id → 剩余闪白时间 */
const flash = new Map<number, number>()
/** 实体的最后已知位置。实体死了会被移出 world，但特效还要在它倒下的地方播 */
const lastPos = new Map<number, { x: number; y: number }>()

let shake = 0

function drainEvents(events: SimEvent[]): void {
  for (const ev of events) {
    switch (ev.type) {
      case 'damaged': {
        const at = lastPos.get(ev.entityId)
        flash.set(ev.entityId, FLASH_TIME)
        if (at === undefined) break

        floaters.push({
          x: at.x, y: at.y,
          text: `-${fmtNum(ev.amount)}`,
          color: ev.lethal ? COLOR.blocked : COLOR.damage,
          age: 0,
          big: ev.lethal || ev.amount >= 60,
        })
        burst(at.x, at.y, COLOR.damage, clamp(4 + ev.amount / 8, 4, 16))
        shake = Math.min(MAX_SHAKE, shake + clamp(ev.amount / 22, 1, 7))
        sfxHit(ev.amount)
        break
      }
      case 'healed': {
        const at = lastPos.get(ev.entityId)
        if (at === undefined) break
        floaters.push({ x: at.x, y: at.y, text: `+${fmtNum(ev.amount)}`, color: COLOR.heal, age: 0, big: false })
        sfxHeal()
        break
      }
      case 'hitIntercepted': {
        const at = lastPos.get(ev.entityId)
        if (at === undefined) break
        floaters.push({ x: at.x, y: at.y - 20, text: '拦下', color: COLOR.blocked, age: 0, big: true })
        burst(at.x, at.y, COLOR.blocked, 10)
        sfxBlock()
        break
      }
      case 'statusApplied': {
        /*
         * 状态挂上的**那一下**：在这个人身上炸一圈它自己的颜色。
         *
         * ⚠ 颜色按标签取（`pickStatusStyle`），和常驻光环同一个来源 ——
         *   不然"落上去"和"挂着"会是两种颜色，看起来像两个东西。
         *
         * ⚠ 每次都要重挂（stack / refresh）也会发这条事件，所以这里会反复炸。
         *   对刷新类状态那是**对的**：它就是在提醒你"又挨了一下"。
         */
        const at = lastPos.get(ev.entityId)
        if (at === undefined) break
        const tags = world.entities.find(e => e.id === ev.entityId)
          ?.statuses.find(s => s.defId === ev.statusId)?.tags ?? []
        const style = pickStatusStyle(tags)
        burst(at.x, at.y, style.ring, 12)
        break
      }
      case 'died': {
        const at = lastPos.get(ev.entityId)
        if (at === undefined) break
        burst(at.x, at.y, COLOR.enemy, 26)
        shake = MAX_SHAKE
        sfxDeath()
        break
      }
      case 'castStarted':
        sfxCast()
        break
      case 'castInterrupted': {
        const at = lastPos.get(ev.casterId)
        if (at !== undefined) {
          floaters.push({ x: at.x, y: at.y - 24, text: '打断', color: COLOR.castBar, age: 0, big: false })
        }
        break
      }
      case 'deliveryFired': {
        // 瞬时载体打出去了 —— 扇形 / 光束 / 突刺 / 范围 / 光环。
        // 这一条以前根本没有，所以那些技能全是隐形的（连打空了都看不见）
        const sprite = spawnSprite(ev)
        if (sprite !== undefined) {
          sprites.push(sprite)
        } else if (ev.kind !== 'projectile') {
          /*
           * ⚠ 投射物的命中**没有作者素材时什么都不画**。
           *
           *   子弹本身是实体（已经在画了），命中又有粒子、飘字和顿帧 ——
           *   再叠一个程序化光环就是噪声。
           *   作者做了素材才值得专门画一层（那就是下面那条 sprite 分支）。
           */
          deliveries.push(spawnDelivery(ev))
        }
        break
      }
      default:
        break
    }
  }
}

/**
 * 这个载体的特效该用作者做的序列帧，还是程序化的？
 *
 * ⚠ **技能里写了 `vfx` 就用它，没写就程序化兜底。**
 *   这是两条路线的分界，也是"加了新载体不会变成隐形"的保证。
 */
function spawnSprite(ev: {
  vfx?: string
  from: { x: number; y: number }
  dir: { x: number; y: number }
}): SpriteFx | undefined {
  if (ev.vfx === undefined) return undefined
  const asset = fxAssets.get(ev.vfx)
  if (asset === undefined) return undefined

  const def = asset.def
  const facing = Math.atan2(ev.dir.y, ev.dir.x)
  const rot = def.rotate === 'facing' ? facing : 0

  // 偏移是相对施法者的，而且**跟着朝向转** —— 不然往左放的时候特效会跑到身后
  const ox = def.offset?.[0] ?? 0
  const oy = def.offset?.[1] ?? 0
  const cos = Math.cos(rot)
  const sin = Math.sin(rot)

  return {
    kind: 'sprite',
    frames: asset.frames,
    frameTime: asset.frameTime,
    age: 0,
    x: ev.from.x + ox * cos - oy * sin,
    y: ev.from.y + ox * sin + oy * cos,
    rot,
    meters: def.meters,
    anchorX: def.anchor?.[0] ?? 0.5,
    anchorY: def.anchor?.[1] ?? 0.5,
    blend: def.blend ?? 'add',
    pingPong: false,
  }
}

function burst(sx: number, sy: number, color: string, count: number): void {  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + hash(i) * 0.6
    const speed = 90 + hash(i + 99) * 180
    particles.push({
      x: sx, y: sy,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed,
      color,
      age: 0,
      size: 1.5 + hash(i + 7) * 2.5,
    })
  }
}

/**
 * 一个假的随机：确定性整数哈希。
 *
 * 为什么不用 Math.random：特效每次跑出来都不一样的话，
 * 截图对比和"这帧看着对不对"的判断都会失效。
 * 用 tick 当输入，同一个 tick 永远得到同一个值。
 */
function hash(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b)
  x ^= x >>> 13
  x = Math.imul(x, 0xc2b2ae35)
  x ^= x >>> 16
  return (x >>> 0) / 4294967296
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function fmtNum(n: number): string {
  const r = Math.round(n * 10) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

/** 拼 innerHTML 之前先把它转义掉。技能名是玩家自己起的，里面可能有尖括号 */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c
  ))
}

/**
 * 推进特效。
 *
 * ⚠ 用的是**真实时间**，不是模拟时间。
 *   顿帧的时候世界停住，但闪白要继续衰减、飘字要继续飞 ——
 *   那正是让"停住"被看见的原因。特效跟着冻住就变成卡顿了。
 */
function updateFx(realDt: number): void {
  for (const [id, t] of flash) {
    const next = t - realDt
    if (next <= 0) flash.delete(id)
    else flash.set(id, next)
  }

  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i]
    if (f === undefined) continue
    f.age += realDt
    f.y -= (f.big ? 46 : 34) * realDt
    if (f.age >= FLOATER_LIFE) floaters.splice(i, 1)
  }

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]
    if (p === undefined) continue
    p.age += realDt
    p.x += p.vx * realDt
    p.y += p.vy * realDt
    p.vx *= 1 - 4 * realDt
    p.vy *= 1 - 4 * realDt
    if (p.age >= PARTICLE_LIFE) particles.splice(i, 1)
  }

  for (let i = deliveries.length - 1; i >= 0; i--) {
    const d = deliveries[i]
    if (d === undefined) continue
    if (!updateDelivery(d, realDt)) deliveries.splice(i, 1)
  }

  for (let i = sprites.length - 1; i >= 0; i--) {
    const s = sprites[i]
    if (s === undefined) continue
    if (!updateSprite(s, realDt)) sprites.splice(i, 1)
  }

  shake *= Math.pow(0.0005, realDt)
  if (shake < 0.15) shake = 0
}

function clearFx(): void {
  floaters.length = 0
  particles.length = 0
  deliveries.length = 0
  sprites.length = 0
  flash.clear()
  lastPos.clear()
  shake = 0
}

// ============================================================================
//  音效：用 WebAudio 现场合成，不需要任何素材文件
// ============================================================================

let audioCtx: AudioContext | undefined
let muted = false

/** AudioContext 必须在用户手势之后才能创建，所以第一次按键时才初始化 */
function ensureAudio(): void {
  if (audioCtx !== undefined || muted) return
  try {
    audioCtx = new AudioContext()
  } catch {
    muted = true
  }
}

interface ToneOpts {
  freq: number
  to?: number
  dur: number
  type: OscillatorType
  gain: number
}

function tone(o: ToneOpts): void {
  const ac = audioCtx
  if (ac === undefined || muted) return

  const osc = ac.createOscillator()
  const env = ac.createGain()
  const now = ac.currentTime

  osc.type = o.type
  osc.frequency.setValueAtTime(o.freq, now)
  if (o.to !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), now + o.dur)
  }

  // 快起快落，不然会糊成一片
  env.gain.setValueAtTime(0.0001, now)
  env.gain.exponentialRampToValueAtTime(o.gain, now + 0.006)
  env.gain.exponentialRampToValueAtTime(0.0001, now + o.dur)

  osc.connect(env).connect(ac.destination)
  osc.start(now)
  osc.stop(now + o.dur + 0.02)
}

function sfxHit(amount: number): void {
  // 打得越疼，音调越低、越长
  const k = clamp(amount / 120, 0, 1)
  tone({ freq: 320 - k * 160, to: 70, dur: 0.09 + k * 0.08, type: 'square', gain: 0.05 + k * 0.05 })
  tone({ freq: 1200 - k * 500, to: 300, dur: 0.04, type: 'triangle', gain: 0.03 })
}

function sfxHeal(): void {
  tone({ freq: 520, to: 880, dur: 0.14, type: 'sine', gain: 0.045 })
}

function sfxBlock(): void {
  tone({ freq: 880, to: 1600, dur: 0.18, type: 'triangle', gain: 0.06 })
}

function sfxDeath(): void {
  tone({ freq: 200, to: 45, dur: 0.5, type: 'sawtooth', gain: 0.07 })
}

function sfxCast(): void {
  tone({ freq: 260, to: 420, dur: 0.12, type: 'sine', gain: 0.028 })
}

// ============================================================================
//  启动
// ============================================================================

interface Manifest {
  schemaVersion: number
  skills: string[]
  /**
   * 武器技能模板（`content/weapon-skills/`）。
   *
   * ⚠ 它和 `skills` 是**同一张技能表**的两半，所以加载进同一个 Map：
   *   术式按 id 引用技能时不区分自己引的是哪一半。
   *   区别只有一条 —— 它们带 `readonly: true`，编辑器里不给改。
   */
  weaponSkills?: string[]
  /** 武器（`content/weapons/`）。一把武器 = 一张属性表 + 两个术式槽 */
  weapons?: string[]
  /**
   * **内部术式库**（`content/internal-techniques/`）：引擎/内容自己在用的术式。
   *
   * ⚠ 玩家的术式**不在这里** —— 它们住在存档里（`SavedState.techniques`）。
   *   这一层玩家既看不到、也引用不到（术式编辑器只列「我做的」）。
   */
  internalTechniques: string[]
  /** 状态库：可复用、可被多个技能按 id 引用的状态 */
  statuses?: string[]
  /** 实体预设：spawn 载荷按 id 引用 */
  entities?: string[]
  scenarios: string[]
  /** 作者做的序列帧特效（`content/fx/<名字>.json`）。没写就是全用程序化的 */
  fx?: string[]
  /**
   * **修饰原型**（`content/modifiers/`，2026-09-21 日志 48）。
   *
   * ⚠ 它们**不进 `skills` 那张表**：原型不是 `Skill`（没有阶段、没有规则、
   *   没有点数），塞进去会炸在 `pricing.ts` 的 `skill.phases.forEach` 上。
   *   它们进的是 `modifierProtos` 那张小表（原型 id → 原型）——
   *   编译和校验读的都是它。
   *   ⚠ 2026-09-21（日志 51）那张表从"id → 机制类别"换成了"id → **原型**"：
   *     份数类修饰（多重释放 / 一分为 X）的**上限**在原型上（`params.max`），
   *     只拿类别读不到。`validateTechnique` 那个选项也跟着叫 `modifierProtos`。
   */
  modifiers?: string[]
}

/**
 * 加载内容。
 *
 * ⚠ 按 manifest.json 来，**不要在代码里硬编码文件名**。
 *   硬编码的清单迟早和实际文件对不上 —— lava-armor 就这么 404 过一次，
 *   而且表现是整个页面白屏，看不出是哪个文件的问题。
 *
 * 两步：先读**技能**（零件），再读**术式**并编译。
 * 术式引用的技能不存在时不算致命 —— 记一条问题，那个术式就没有阶段，
 * 按了没反应，但别的术式照常能玩。
 */
async function loadContent(): Promise<string[]> {
  const problems: string[] = []

  /*
   * 内容里**武器系技能**的 id。
   *
   * ⚠ 它是给**读存档**用的：
   *   老存档里的术式没有 `kind`，加载器要按"直接或顺着序列引用了武器技能
   *   → weapon，否则 magic"补上（见 src/school.ts 的 `deriveTechniqueKind`）。
   *   少了这一份 id，一份引用了武器技能的老术式会被补成魔法术式，
   *   然后当场变成非法内容。
   */
  const weaponSkillIds = new Set<string>()

  let manifest: Manifest
  try {
    manifest = await fetchJson<Manifest>('/content/manifest.json')
  } catch (e) {
    throw new Error(`读不到 content/manifest.json：${String(e)}`)
  }

  /*
   * 状态库。
   *
   * ⚠ 先读它，再读技能。技能里可以按 `statusId` 引用库里的状态，
   *   而定价和装配都要查得到那个定义 —— 晚一步的话，那种技能的点数
   *   会被算成 0（编辑器里看着像白送的效果）。
   */
  for (const name of manifest.statuses ?? []) {
    try {
      const st = await fetchJson<StatusDef>(`/content/statuses/${name}.json`)
      statusDefs.set(st.id, st)
    } catch (e) {
      problems.push(`content/statuses/${name}.json —— ${String(e)}`)
    }
  }

  for (const name of manifest.entities ?? []) {
    try {
      const def = await fetchJson<EntityDef>(`/content/entities/${name}.json`)
      entityDefs.set(def.id, def)
    } catch (e) {
      problems.push(`content/entities/${name}.json —— ${String(e)}`)
    }
  }

  for (const name of manifest.skills ?? []) {
    try {
      const s = await fetchJson<Skill>(`/content/skills/${name}.json`)
      /*
       * ⚠ **盖系别章**（派生字段，不写进 JSON）：`content/skills` 是**魔法系**。
       *   见 `src/school.ts` —— 编辑器的技能库、校验器的同系检查都读它。
       *   不盖的话术式一律报 `SKILL_SCHOOL_MISSING`（判不了同不同系）。
       */
      skills.set(s.id, stampSchool(s, 'magic'))
      originals.set(s.id, JSON.parse(JSON.stringify(s)) as Skill)
    } catch (e) {
      problems.push(`content/skills/${name}.json —— ${String(e)}`)
    }
  }

  /*
   * 武器技能模板（`content/weapon-skills/`）。
   *
   * ⚠ 进的是**同一张** `skills` 表 —— 术式按 id 引用技能时不在乎
   *   自己引的是玩家技能还是武器模板。分两张表的话，
   *   校验和定价都得查两遍，迟早漏一边（那时武器术式会被算成 0 点）。
   *
   *   它们的数值由武器属性代入（`ref: 'weapon.damage'`），
   *   所以**同一份模板在不同武器上不一样** —— 这正是玩家要的。
   */
  for (const name of manifest.weaponSkills ?? []) {
    try {
      const s = await fetchJson<Skill>(`/content/weapon-skills/${name}.json`)
      // ⚠ 系别章：这一边是**武器系**（见 src/school.ts）。顺手记下它们的 id ——
      //    读存档时要用它推出"老术式里的技能是不是武器系的"（`deriveTechniqueKind`）
      skills.set(s.id, stampSchool(s, 'weapon'))
      weaponSkillIds.add(s.id)
      originals.set(s.id, JSON.parse(JSON.stringify(s)) as Skill)
    } catch (e) {
      problems.push(`content/weapon-skills/${name}.json —— ${String(e)}`)
    }
  }

  for (const name of manifest.internalTechniques ?? []) {
    try {
      const t = await fetchJson<TechniqueDef>(`/content/internal-techniques/${name}.json`)
      techniques.set(t.id, t)
    } catch (e) {
      problems.push(`content/internal-techniques/${name}.json —— ${String(e)}`)
    }
  }

  /*
   * ---- 修饰原型（日志 48）----
   *
   * ⚠ 必须在**编译之前**读完：编译要按原型判断"哪一段被常驻包装了"，
   *   而那是**运行时的行为**（常驻段不参与按键激活）。
   *   漏读的后果是静默的：一份常驻术式里那一段会被当成普通技能段，
   *   表现是"按下去真的放了一个技能"。
   *
   * ⚠ 读不到**不算致命**（`problems` 记一条，页面照常能玩）：
   *   少了原型，用到它的那份术式会得到一条 `UNKNOWN_MODIFIER` 编译问题
   *   （技能栏那一格会写清楚），而不是白屏。
   */
  for (const name of manifest.modifiers ?? []) {
    try {
      const proto = await fetchJson<ModifierProto>(`/content/modifiers/${name}.json`)
      modifierProtos.set(proto.id, proto)
    } catch (e) {
      problems.push(`content/modifiers/${name}.json —— ${String(e)}`)
    }
  }

  /*
   * ⚠ **序列的悬空引用检查删掉了**（2026-09-21，日志 46）。
   *
   *   内联之前这里查的是 `sequences: ["tech.ws-slash"]` —— 名字敲错时
   *   引擎拿到的是"按下去没反应"，不会有任何报错。序列内联之后
   *   内容里**不存在**这种引用了（`tech.ws-slash` 那几份文件也删了）。
   *
   *   ⚠ 现在这件事由 `compileTechnique` 负责，而且报得更准：
   *     它逐段编译，段里引用了不存在的技能会记一条
   *     `CompileProblem`（路径能到"第几段的第几个"）。
   *     在这里再查一遍的话，会变成**两份会漂移的真相** ——
   *     而"命令行过了但网页里是坏的"正是这种漂移的症状。
   */

  /*
   * 武器。
   *
   * ⚠ 现在只做两件事：**加载** + **查两个术式槽指不指得到东西**。
   *   真正的"装到人身上"（属性代入、左键绑武器术式）是武器运行时那一轮。
   *
   *   但这条引用检查现在就有价值：`weaponTechnique` 写错名字的话，
   *   表现是"装上剑之后左键没反应" —— 没有任何地方会报错，
   *   因为空槽和错名字在引擎看来一样。
   */
  for (const name of manifest.weapons ?? []) {
    try {
      const w = await fetchJson<WeaponDef>(`/content/weapons/${name}.json`)
      weaponDefs.set(w.id, w)
      for (const slot of ['weaponTechnique', 'magicTechnique'] as const) {
        const ref = w[slot]
        if (typeof ref === 'string' && ref.length > 0 && !techniques.has(ref)) {
          problems.push(
            `武器「${w.name}」的 ${slot} 指向不存在的术式「${ref}」——` +
            `${slot === 'weaponTechnique' ? '左键会是空的' : '这个槽会是空的'}`,
          )
        }
      }
    } catch (e) {
      problems.push(`content/weapons/${name}.json —— ${String(e)}`)
    }
  }

  /*
   * ---- 玩家自己的术式 ----
   *
   * ⚠ 必须放在内容术式**之后**、`recompileAll()` **之前**：
   *   它们和内容术式走完全一样的编译路径，只是来源不同。
   *   放进同一张 `techniques` 表，`recompileAll()` / `applySkillEdit()`
   *   就自动把它们一起处理了 —— 不需要第二条编译路径。
   *   （两份路径迟早会漂移，然后"内容能跑玩家做的不能跑"。）
   */
  const saved = loadState(storage(), {
    weaponSkillIds,
    /*
     * ⚠ **序列解析器**：只有**老形状**（`sequences: ["tech.xxx"]`，按 id 引用
     *   另一份术式）用得上 —— 那时武器技能长在**那份被引用的术式**里，
     *   不往下走一层就看不见，那份老术式会被补成 magic（而它引用的正是
     *   武器系技能），于是当场变成非法内容。
     *
     * ⚠ 2026-09-21（日志 46）序列**内联**之后，**内容里每一段自己就带技能**，
     *   这条路一次都不会走到（段自带 `skills`，`deriveTechniqueKind` 直接读）。
     *   留着它是因为**老存档**里可能就是老形状 —— 而判死等于玩家手里的
     *   东西全成垃圾（和 `resolveSegment` 是同一条理由）。
     *
     * ⚠ 它查的是**内容术式**（`techniques` 此刻已经装好了内容那一批，
     *   玩家存档那一批还没进来）：推导要在一张"只有内容"的表上做，
     *   否则一份玩家自造的序列能把别人推成 weapon。
     */
    sequenceOf: id => techniques.get(id),
  })
  /*
   * 开局那份术式是哪一个。
   *
   * ⚠ **判断留给 `seedStarter`**，这里只把存档里的值读回来。
   *   第一版在这里就下结论（"有术式 / 排过技能栏 = 不用发"），结果是
   *   一个从没做过术式、技能栏里只剩场景发的内部术式的老存档
   *   被当成"已经有自己的东西了"—— 玩家永远拿不到那份能改的起点。
   *   玩家原话：**"并没有魔法飞弹"**。
   */
  starterId = saved.starterId
  /*
   * ⚠ **自定义技能库先装**：术式是按 id 引用技能的，而玩家做的术式
   *   很可能引用着他自己创造的变体（`custom.*`）。
   *   顺序反了的话，第一次 `recompileAll()` 会报一堆"找不到技能"。
   */
  for (const s of saved.skills) customSkills.set(s.id, s)
  for (const t of saved.techniques) {
    mine.set(t.id, t)
    techniques.set(t.id, t)
  }
  /*
   * 技能栏只留**还存在的**术式：内容改名、技能删掉之后，
   * 存档里可能指着一个已经不存在的 id。留着它会让技能栏上出现空格，
   * 而且玩家不知道为什么按了没反应。
   */
  for (const id of saved.loadout) {
    if (techniques.has(id) && !savedLoadout.includes(id)) savedLoadout.push(id)
  }

  /*
   * 作者做的序列帧特效。
   *
   * ⚠ 它失败**不影响能玩** —— 技能里写了 vfx 但没加载到，
   *   `spawnSprite` 会返回 undefined，然后自动退回程序化特效。
   *   这就是"两条路线并存"的好处：素材没做好之前游戏照样能跑。
   */
  if ((manifest.fx ?? []).length > 0) {
    const loaded = await loadFxLibrary(manifest.fx ?? [])
    for (const [id, asset] of loaded.assets) fxAssets.set(id, asset)
    problems.push(...loaded.problems)
  }

  /*
   * 场景。
   *
   * ⚠ 读不出来**不算致命** —— 退回 fallbackScenario()，玩家照样能打。
   *   内容文件坏掉是常态（手改 JSON 时少一个逗号），
   *   那种时候应该看到"哪个文件读不出来" + 一个能玩的默认局，
   *   而不是白屏。白屏看不出问题在哪儿，这个亏吃过。
   *
   * 取第一个场景。要做"选关"的话，改的是这里 + 一个下拉框，
   * 不需要再动装配逻辑。
   */
  const scenarioNames = manifest.scenarios ?? []
  if (scenarioNames.length === 0) {
    problems.push('content/manifest.json 里没有 scenarios，用的是兜底演武场')
    scenario = fallbackScenario()
  } else {
    for (const name of scenarioNames) {
      try {
        scenario = await fetchJson<Scenario>(`/content/scenarios/${name}.json`)
        break
      } catch (e) {
        problems.push(`content/scenarios/${name}.json —— ${String(e)}`)
      }
    }
    if (scenario === undefined) {
      problems.push('一个场景都读不出来，用的是兜底演武场')
      scenario = fallbackScenario()
    }
  }

  /*
   * 跨文件的 statusId 引用检查。
   *
   * ⚠ 这是"加载期发现"而不是"运行期炸掉"的那一步。
   *
   *   技能里按 id 引用状态（`statusId: "status.shield"`）而那个名字
   *   在整份内容里都不存在时，引擎是**放技能的那一刻**才 throw 的 ——
   *   也就是说内容写错了照样能过校验、能进游戏、能开局，
   *   直到你真的按下那个键。
   *
   *   裂魂里那条「驱散 status.shield」就这么躺了很久：那个名字
   *   以前只存在于一个测试文件里。
   *
   * ⚠ 它必须在**收集完全部技能之后**跑 —— 状态可以定义在一个技能里、
   *   被另一个技能引用（灵光盾定义，裂魂引用），只查单文件会误报。
   */
  for (const issue of checkRefs([...skills.values()], {
    statuses: [...statusDefs.keys()],
    entities: [...entityDefs.keys()],
  })) {
    const what = issue.what === 'entity'
      ? '召唤不出来（运行时会直接抛异常）'
      : issue.verb === 'apply'
        ? '挂不上去（运行时会直接抛异常）'
        : '驱散不掉（运行时会静默什么都不做）'
    const kind = issue.what === 'entity' ? '实体预设' : '状态'
    problems.push(
      `${issue.where}：引用了不存在的${kind}「${issue.refId}」，${what}`,
    )
  }

  problems.push(...recompileAll())

  if (library.size === 0) {
    throw new Error('一个术式都没编译出来，检查 content/manifest.json')
  }
  return problems
}

/**
 * 重新编译所有术式。
 *
 * 编辑器改完一个技能就得调它 —— 引擎认的是编译产物，
 * 不重编译的话"改了等于没改"，而且玩家会以为是编辑器坏了。
 *
 * 直接全量重编：八个术式的规模下这比"找出受影响的那些"更不容易出错，
 * 等术式上百了再谈增量。
 */
function recompileAll(): string[] {
  const problems: string[] = []
  usedBy.clear()
  techniqueProblems.clear()

  for (const t of techniques.values()) {
    /*
     * ⚠ **空术式不编译。**
     *   玩家刚点「新建」、还没加任何技能的草案，编译出来是一条空时间轴 ——
     *   而编译器会为它报一条错。结果就是"刚打开编辑器就满屏红字"，
     *   玩家会以为自己弄坏了什么。
     *
     *   空草案在编辑器里是完全正常的中间状态，所以它**不进 library**。
     *
     * ⚠ 判据是"既没有技能也没有序列"，不是"没有技能"：
     *   **序列术式**（武器术式）本来就一个技能都不带 —— 它的时间轴
     *   在每一条序列里。只判 skills 的话它会被当成空草案丢掉，
     *   于是"装上了武器但技能栏里没有那一格"。
     *
     * ⚠ 2026-09-21 补：**丢掉它这件事必须说出来**。
     *   玩家把一份空术式绑到键上，编辑器显示"装到 键2"、游戏也重开了，
     *   但那一格在游戏里**不存在**，按下去也没有任何提示 ——
     *   他的原话是"游戏没有识别出来"。所以这里记一条 `techniqueProblems`，
     *   技能栏那一格会画成"放不出来"并写清原因，按下去也会说出来。
     */
    const skillCount = (t.skills ?? []).length
    const sequenceCount = (t.sequences ?? []).length
    if (skillCount === 0 && sequenceCount === 0) {
      library.delete(t.id)
      techniqueProblems.set(t.id, ['一个技能都还没加（也没有序列）—— 按下去不会有反应'])
      continue
    }

    const res = compileTechnique(t, findSkill, {
      /*
       * ⚠ 血契消耗必须在**这里**算好传进去。
       *
       *   算出这个数的是 `src/pricing.ts`，而 sim 不认识"点数"这个概念 ——
       *   编译产物只带一个数字，`cast.ts` 只读它。
       *
       *   漏传的后果是**静默的**：负值术式不扣血契，等于白送一整套爆发，
       *   而且没有任何地方会报错。命令行走的是 bridge.ts 里同一句调用。
       */
      bloodPactCost: balanceConfig === undefined
        ? 0
        : bloodPactCostOf(t, findSkill, priceOptionsFor(balanceConfig, statusDefs, entityDefs)),
      /*
       * ⚠ 原型表要传进编译：它决定"哪一段被常驻包装了"，那是**运行时的行为**
       *   （常驻段不参与按键激活）。命令行走的是 bridge.ts 里同一句调用。
       */
      modifiers: modifierProtos,
    })
    library.set(t.id, res.compiled)

    /*
     * ⚠ 编译出来了**不等于能用**：悬空的技能引用、坏掉的载荷都会让它在
     *   按下去的那一刻什么都不发生。所以问题要按术式记下来，
     *   技能栏那一格和按键提示都要用。
     */
    if (res.problems.length > 0) {
      techniqueProblems.set(t.id, res.problems.map(p => p.message))
    }

    for (const p of res.problems) problems.push(p.message)

    for (const skillId of res.compiled.skillIds) {
      const list = usedBy.get(skillId) ?? []
      list.push(`${t.name}（${t.id}）`)
      usedBy.set(skillId, list)
    }
  }
  return problems
}

/**
 * 自定义技能库变了一次 → **重编译 + 存盘 + 把新版本装回世界**。
 *
 * ⚠ 因为技能是**全局**的（不属于任何术式），改一个变体会同时影响
 *   **所有用到它的术式** —— 它们的账和它们的伤害都跟着变。
 *   所以这里必须全量重编 + 重注册，不能只动一处。
 */
function applySkillLibraryChanged(): string[] {
  const problems = recompileAll()
  persist()
  if (!booted) return problems

  /*
   * 常驻技能（技能图钩子）要靠 world.techniques 查，必须换掉。
   *
   * ⚠ 状态定义也要跟着换。
   *   只注册术式的话，技能里按 statusId 引用的状态在浏览器里查不到 ——
   *   而命令行里查得到（bridge.ts 的 installTechnique 两样都做）。
   *   同一个内容两边行为不一样，是最难查的一类 bug。
   */
  for (const c of library.values()) {
    registerTechnique(world, c)
    for (const { status } of collectStatuses(c)) registerStatusDef(world, status)
  }
  // 状态库 / 实体预设也要重新注册（编辑一个技能不该让它们从世界里消失）
  for (const [id, def] of statusDefs) registerStatusDef(world, def)
  for (const [id, def] of entityDefs) registerEntityDef(world, def)

  if (problems.length > 0) {
    statsEl.innerHTML = `<div style="color:#f85149">编辑之后有 ${problems.length} 个术式编译不出来：</div>`
      + problems.map(p => `<div class="dim">${esc(p)}</div>`).join('')
  }
  return problems
}

/**
 * 技能编辑器按了「保存」/「另存为」。
 *
 * ⚠ 三条规矩，每条漏了都有一种安静的坏法：
 *
 *   1. **保存只写自定义技能库。** 基础技能库（内容）从头到尾只读 ——
 *      写它的话改动是全局的、而且刷新就没（存档里根本没有它）。
 *   2. **变体记住它的模板**（`basedOn`）：账是对着模板算的。
 *      另存为出来的新变体，`basedOn` 仍然是**最初那个基础技能**，
 *      不是上一份变体 —— 不然宗旨（偏离出厂版多少）就断了。
 *   3. **另存为要给新 id**，不能就地覆盖（那就不是另存为了）。
 */
function saveCustomSkill(draft: Skill, mode: 'save' | 'saveAs'): { id: string; name: string } | undefined {
  if (mode === 'save' && !customSkills.has(draft.id)) {
    // 草稿还没进库就当"新建"处理（编辑器那边也是这么想的）
    mode = 'saveAs'
  }

  let saved: Skill
  if (mode === 'saveAs') {
    const template = draft.basedOn ?? draft.id
    const id = mintCustomId(template, [...customSkills.values()])
    /*
     * ⚠ 名字：**重名就退回默认名**（「火球-副本2」）。
     *
     *   另存为出来的东西如果和原来那份同名，列表上就有两个一样的名字 ——
     *   玩家根本分不清哪个是哪个。所以重名时按玩家的规矩给默认名
     *   （"不取就是默认「火球-副本1」这种"）；他要是已经改过名、
     *   而且没和谁撞，就保留他起的名字。
     */
    const taken = new Set([...customSkills.values()].map(s => s.name))
    const name = taken.has(draft.name) ? `${baseNameOf(template)}-副本${nextVariantNo(template)}` : draft.name
    saved = { ...draft, id, name, basedOn: template }
  } else {
    saved = { ...draft }
  }

  /*
   * ⚠ **自定义技能一律魔法系**：武器技能是只读模板，玩家做不出武器系的变体
   *   （见 `src/school.ts`）。这里是"从模板另存"的出口，草稿多半已经带着
   *   模板的章了，但**盖章这件事不能靠继承** —— 继承来的东西在
   *   "以后允许从别的地方另存"时会静默地错。
   */
  stampSchool(saved, 'magic')

  customSkills.set(saved.id, saved)

  const problems = applySkillLibraryChanged()
  /*
   * ⚠ 改一个变体会影响**所有用到它的术式**：它们的账（甚至"能不能配平"）
   *   当场就变了。术式编辑器那一页要跟着重画 —— 不然玩家看到的是旧账。
   */
  editor?.reload()
  techEditor?.refresh()
  if (problems.length > 0) toast(`有 ${problems.length} 个术式编译不出来 —— 看右上角`)
  return { id: saved.id, name: saved.name }
}

/**
 * 删一个自定义技能。
 *
 * ⚠ 玩家 2026-09-21 选的：**禁止删有引用的**（先把引用它的术式改掉）。
 *   所以这里先查一遍 `usedBy`，把**是哪几份术式**说清楚 ——
 *   "不能删"这三个字对玩家没有任何用，他需要知道去哪儿改。
 */
function deleteCustomSkill(id: string): void {
  if (!customSkills.has(id)) return
  const users = usedBy.get(id) ?? []
  if (users.length > 0) {
    toast(`「${customSkills.get(id)?.name ?? id}」还被这些术式用着，先把它们改掉：`
      + users.join('、'))
    return
  }
  customSkills.delete(id)
  applySkillLibraryChanged()
  editor?.reload()
  techEditor?.refresh()
}

/** 模板的名字（另存为时给默认名用） */
function baseNameOf(templateId: string): string {
  return (customSkills.get(templateId) ?? skills.get(templateId))?.name ?? '技能'
}

/** 这份模板已经派生过几份 → 下一份默认叫「X-副本N」 */
function nextVariantNo(templateId: string): number {
  const taken = new Set<string>()
  for (const s of customSkills.values()) {
    if (s.basedOn === templateId) taken.add(s.name)
  }
  let n = 1
  while (taken.has(`${baseNameOf(templateId)}-副本${n}`)) n++
  return n
}

/** 结构相同吗（键顺序不算）—— 导入冲的时候用来判"其实一样" */function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
}

/** 这份术式用到的自定义技能（分享时打包进码里） */
function bundleFor(tech: TechniqueDef): Skill[] {
  const out: Skill[] = []
  for (const id of tech.skills ?? []) {
    const s = customSkills.get(id)
    if (s !== undefined) out.push(s)
  }
  return out
}

/**
 * 收一份码：先把码里的自定义技能导进库里，再返回要采用的那份术式。
 *
 * ⚠ **冲突时必须问玩家**（玩家 2026-09-21 定的："让他选"）：
 *   他自己那份变体可能已经用在好几份术式上了，静默覆盖等于改了他的东西。
 *   两个选项都摆在明面上：**用我的** / **把码里的导入成一份新的副本**。
 *
 * ⚠ 导入进来的那份要**记住它自己的模板**（`basedOn`）：账是对着模板算的。
 *   码里的 `basedOn` 指的是**基础技能**（内容里那份），双方都有 ✓。
 */
function redeemBundle(
  tech: TechniqueDef,
  skills: Skill[],
): { technique: TechniqueDef; notes: string[] } {
  const notes: string[] = []
  const remap = new Map<string, string>()

  for (const incoming of skills) {
    const existing = customSkills.get(incoming.id)
    if (existing === undefined) {
      customSkills.set(incoming.id, incoming)
      notes.push(`导入了「${incoming.name}」`)
      continue
    }
    if (canonicalJson(existing) === canonicalJson(incoming)) continue

    const useMine = window.confirm(
      `码里的「${incoming.name}」和你技能库里那份不一样。\n\n`
      + '确定 = 用你的那份（码里的不导入）\n'
      + '取消 = 把码里的那份导入成一份新的副本',
    )
    if (useMine) {
      notes.push(`「${incoming.name}」用了你库里那份`)
      continue
    }
    const id = mintCustomId(incoming.basedOn ?? incoming.id, [...customSkills.values()])
    const copy: Skill = { ...incoming, id, name: `${incoming.name}（来自分享）` }
    customSkills.set(id, copy)
    remap.set(incoming.id, id)
    notes.push(`码里的「${incoming.name}」导入成了「${copy.name}」`)
  }

  let out = tech
  if (remap.size > 0 && tech.skills !== undefined) {
    out = { ...tech, skills: tech.skills.map(id => remap.get(id) ?? id) }
  }
  if (notes.length > 0) applySkillLibraryChanged()
  return { technique: out, notes }
}

/**
 * 术式编辑器改了东西（加了一段、换了条件、改了技能栏）。
 *
 * 和 `applySkillEdit` 的区别只有一点：**技能没变，所以不需要重编译**。
 * 但玩家改的是 `Technique` 本身，所以要重新编译**那一份**并装回世界，
 * 然后存盘。
 *
 * ⚠ 存盘放在这里，不放在编辑器里 —— 编辑器只管数据，
 *   "什么时候落盘"是宿主的事（比如以后要做"未保存"提示，就在这一处加）。
 */
function applyTechniqueEdit(): void {
  const problems = recompileAll()
  persist()
  /*
   * ⚠ 技能页的"被这些术式用到"要跟着换：玩家可能刚新建/删掉一份术式。
   *   不刷新的话，删变体时会拦他（"还被这些术式用着"），
   *   而那几份术式里其实已经不用它了。
   */
  editor?.reload()
  if (!booted) return

  for (const c of library.values()) {
    registerTechnique(world, c)
    for (const { status } of collectStatuses(c)) registerStatusDef(world, status)
  }
  for (const [id, def] of statusDefs) registerStatusDef(world, def)
  for (const [id, def] of entityDefs) registerEntityDef(world, def)

  if (problems.length > 0) {
    statsEl.innerHTML = `<div style="color:#f85149">有 ${problems.length} 个术式编译不出来：</div>`
      + problems.map(p => `<div class="dim">${esc(p)}</div>`).join('')
  }

  /*
   * ⚠ 技能栏变了要**重开一局**才生效。
   *
   *   不能就地改：`spawn()` 时写在实体上的 `techniqueIds` 是一份快照，
   *   而正在飞的投射物、正在跑的施法都拿着旧引用。
   *   半路换掉会出现"这一发还是旧技能，下一发是新的"这种状态。
   *   重开一局是唯一干净的做法 —— 而且玩家在编辑器里，本来就暂停着。
   */
  const same = loadout.length === savedLoadout.length
    && loadout.every((id, i) => id === savedLoadout[i])
  if (!same && savedLoadout.length > 0) {
    restart()
    toast('技能栏换了，这局已重开')
  }
}

/**
 * 开局发的那份术式，**复制成玩家自己的**。
 *
 * ⚠ 玩家 2026-09-21 定的：
 *   > 初始只有一个术式释放某个技能，现有技能库不改，玩家可以自行创造术式。
 *
 * 场景文件里那行 `techniques: ["tech.magic-bolt"]` 现在是**"开局发什么"**：
 * 那一份住在内部术式库里（敌人的骷髅术士也在用它），玩家既看不到也改不了。
 * 所以开局把它复制一份进玩家的术式库、技能栏指向副本 ——
 * 这样「我做的」从他第一次打开游戏起就有一份**能改的**东西，
 * 而不是一个空列表加一句"点新建开始拼"。
 *
 * ⚠ 三种状态（`SavedState.starterId`）：
 *   · 还没发过 → 发一份
 *   · 发过、还在库里 → **什么都不做**（他可能改过内容或名字）
 *   · 发过、不在库里 → 是他自己删的 → **不许再发**
 *
 * ⚠ 老存档（从没做过术式、技能栏里可能还指着场景发的内部术式）也会补上这一份 ——
 *   这是玩家要的："应该有的那个魔法飞弹术式"。但**技能栏不动**：
 *   他排过的格子不因为这次补发而变。只有完全没排过（`savedLoadout` 是空的）时，
 *   才把第一格指给这份起点。
 *
 * ⚠ 复制完必须 `recompileAll()`：引擎认的是编译产物，
 *   新加的这一份不编译的话，`restart()` 里 `library.has(副本 id)` 是 false，
 *   技能栏会**静默退回**场景默认的那一份 —— 玩家会觉得"我做的术式进不了场"。
 */
function seedStarter(): void {
  /*
   * ⚠ 整段包在 try 里：发一份起点是**锦上添花**，它出任何问题都不该让游戏打不开 ——
   *   那会把"没有魔法飞弹"变成"整个页面白屏"。
   */
  try {
    seedStarterInner()
  } catch (e) {
    console.warn(`[开局术式] 出错了（不影响这一局）：${String(e)}`)
  }
}

function seedStarterInner(): void {
  // 发过、而且还在 —— 玩家可能已经改过它，什么都不做
  if (starterId !== undefined && mine.has(starterId)) return
  // 发过、但不在了 = 他自己删的。再发一次会让他以为删不掉。
  if (starterId !== undefined) {
    console.info(`[开局术式] ${starterId} 已经被删过，不再补发`)
    return
  }

  const active = scenario ?? fallbackScenario()
  const units = active.entities ?? []
  const player = units.find(u => u.controlledBy === 'human') ?? units[0]
  const wanted = player?.techniques ?? []
  /*
   * ⚠ 判断的是**"技能栏里有没有他自己的术式"**，不是"技能栏空不空"。
   *
   *   老存档里可能只剩场景发的**内部术式**（`tech.magic-bolt`）占着第一格 ——
   *   那一格玩家在编辑器里看不到、也改不了（术式编辑器只列「我做的」），
   *   留在那儿只会让编辑器的"装到 键N"和实际格子对不上。
   *   所以这种情况也算"没排过"：清掉那几格，把起点装到第一格。
   *
   * ⚠ 必须在循环**之前**算：循环里会把新副本塞进 `mine`。
   */
  const barWasEmpty = savedLoadout.every(id => !mine.has(id))
  let placed = false

  for (const id of wanted) {
    const src = techniques.get(id)
    if (src === undefined) {
      console.warn(`[开局术式] 场景里写的 ${id} 不在内容库里，复制不了`)
      continue
    }
    const copy = JSON.parse(JSON.stringify(src)) as TechniqueDef
    const copyId = mintMineId()
    copy.id = copyId
    /*
     * 名字带一个后缀。
     *
     * ⚠ 不加的话它和技能**同名**（出厂那一份就是照着技能起的名字），
     *   而玩家 2026-09-21 抱怨过这个："名字和技能一模一样，看起来就是一条技能栏"。
     *   他要的是"这是我的术式，里面装着某个技能"。
     */
    copy.name = `${src.name}（起手）`
    // 出厂注释没必要跟着进玩家的术式（导出 JSON / 分享码里都是它）
    for (const key of Object.keys(copy)) {
      if (key.startsWith('_comment')) delete (copy as unknown as Record<string, unknown>)[key]
    }
    mine.set(copyId, copy)
    techniques.set(copyId, copy)
    // 技能栏里没有他自己的东西才动它；有的话一格都不碰
    if (barWasEmpty && !placed) {
      savedLoadout.length = 0
      savedLoadout.push(copyId)
      placed = true
    }
    // 记第一个当标记：判断"发过没有 / 删过没有"只需要一个
    starterId ??= copyId
    console.info(`[开局术式] 发了 ${copyId}（${copy.name}）`)
  }

  /*
   * ⚠ 一份都没复制出来时也要 `persist()` 吗？**不**。
   *   那说明内容那边有问题（场景指着一个不存在的术式），
   *   而 `starterId` 还是 undefined —— 修好内容之后下次打开就会发。
   */
  if (starterId === undefined) return
  for (const p of recompileAll()) console.warn(`[开局术式] ${p}`)
  persist()
}

/** `tech.mine-1` / `tech.mine-2` —— 和编辑器里那个 `nextId()` 同一套命名，互相不会撞 */
function mintMineId(): string {
  let n = 1
  while (mine.has(`tech.mine-${n}`) || techniques.has(`tech.mine-${n}`)) n++
  return `tech.mine-${n}`
}

/** 复制一段文字到剪贴板。失败要有回退 —— 不给回退玩家就只能手抄 */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast('已复制到剪贴板')
  } catch {
    // 剪贴板 API 在非 https / 无焦点时会失败。退到最老的办法。
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
      toast('已复制到剪贴板')
    } catch {
      toast('复制不了 —— 用「导出 JSON」存成文件')
    }
    document.body.removeChild(ta)
  }
}

/**
 * 编辑器两个页签之间的切换。
 *
 * ⚠ 两个页签共用**同一个浮层**（`#editor`），开关由技能编辑器管。
 *   各管各的会互相抢 `open` class，然后出现"点了没反应"。
 */
function setupTabs(): void {
  const tabSkill = document.getElementById('tabSkill')
  const tabTech = document.getElementById('tabTech')
  const skillBody = document.getElementById('editorBody')
  const techBody = document.getElementById('techBody')
  const pick = document.getElementById('pick')
  if (tabSkill === null || tabTech === null || skillBody === null || techBody === null) return

  function show(which: 'skill' | 'tech'): void {
    const tech = which === 'tech'
    skillBody!.style.display = tech ? 'none' : ''
    techBody!.style.display = tech ? '' : 'none'
    if (pick !== null) pick.style.display = tech ? 'none' : ''
    tabSkill!.classList.toggle('on', !tech)
    tabTech!.classList.toggle('on', tech)
    if (tech) techEditor?.refresh()
  }

  tabSkill.addEventListener('click', () => show('skill'))
  tabTech.addEventListener('click', () => show('tech'))
}

/** world 建好了没有。编辑器可能在第一次 restart 之前就被打开 */
let booted = false

async function boot(): Promise<void> {
  /*
   * ⚠ 平衡配置必须**先**读，不能像以前那样放在 `loadContent()` 后面。
   *
   *   因为 `loadContent()` 末尾会 `recompileAll()`，而它要用平衡配置
   *   算**血契消耗**（负值术式每次释放扣多少）。
   *   顺序反了的话，第一局里每一个术式的 `bloodPactCost` 都是 0 ——
   *   负值术式**不扣血契**，等于白送一整套爆发，而且没有任何地方会报错。
   *   （这个坑正是 bloodPactCost 设计里最危险的一处，见 bridge.ts 的注释。）
   */
  const problems: string[] = []
  try {
    balanceConfig = await fetchJson<BalanceConfig>('/content/balance.json')
  } catch (e) {
    problems.push(`content/balance.json —— ${String(e)}（算不了点数；负值术式不会扣血契）`)
  }

  problems.push(...await loadContent())

  /*
   * 开局发的那份术式：**复制成玩家自己的**。
   *
   * ⚠ 必须在 `loadContent()` 之后（场景是它读进来的）、`restart()` 之前
   *   （技能栏要从这份新的 loadout 装配）。
   */
  seedStarter()

  // ⚠ 阵容不在这里定了 —— restart() 按场景装配。这里只留一行注释说明它去哪儿了。

  restart()

  if (balanceConfig !== undefined) {
    const balance = balanceConfig
    editorHost = {
      // 基础技能库（内容、只读）—— 也是"创造一个技能"时能选的模板
      base: skills,
      // 自定义技能库（玩家创造的变体，存在存档里）
      custom: customSkills,
      usedBy,
      // 保存 / 另存为 / 删除：宿主管 id、存盘、重编译、重注册
      onSave: saveCustomSkill,
      onDelete: deleteCustomSkill,
      // 编辑器算点数要用状态库和实体预设 —— 不然引用它们的规则显示成 0 点
      statuses: statusDefs,
      entities: entityDefs,
      // 点了只读的武器技能时给一句话 —— 静默拒绝会让人以为编辑器坏了
      onNotice: (msg: string) => { toast(msg) },
    }
    editor = createEditor(editorHost, balance)

    techEditor = createTechniqueEditor({
      skills,
      // ⚠ 两个库都要给它：术式可以引用出厂技能，也可以引用玩家自己的变体
      custom: customSkills,
      /*
       * ⚠ **修饰原型表**（`content/modifiers/`）也要给它：
       *   术式页那一屏要能"点中序列里的那个零件 → 进它自己的编辑界面"，
       *   而那个界面的参数表（`paramsTemplate`）只住在原型上 ——
       *   不给的话副本只能显示一个 id，玩家改不了任何东西。
       *   ⚠ 原型**只读**：界面上一律不给"新建 / 改原型"的路（用户定的）。
       */
      modifiers: modifierProtos,
      takenIds: new Set(techniques.keys()),
      // 编译问题：编辑器那一页要显示"这份术式现在跑不起来"
      problemsOf: (id: string) => techniqueProblems.get(id) ?? [],
      mine,
      loadout: savedLoadout,
      balance,
      statuses: statusDefs,
      entities: entityDefs,
      onChanged: applyTechniqueEdit,
      onNotice: (msg) => toast(msg),
      onCopy: (text) => {
        void copyText(text)
      },
      onPaste: () => window.prompt('把术式 JSON 或分享码贴到这里：') ?? undefined,
      // 码里带着这份术式用到的自定义技能；收码时先入库（冲突会问玩家）
      bundleFor,
      onRedeem: redeemBundle,
    })
  }

  setupTabs()

  window.addEventListener('resize', resize)
  resize()
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerdown', onPointerDown)

  if (problems.length > 0) {
    statsEl.innerHTML = `<div style="color:#f85149">有 ${problems.length} 个内容文件加载失败：</div>`
      + problems.map(p => `<div class="dim">${p}</div>`).join('')
  }

  requestAnimationFrame(frame)
}

/**
 * 按当前场景重开一局。
 *
 * ⚠ 这里**没有**任何阵容硬编码了。
 *   之前是：玩家带哪五个术式、三个敌人站哪儿、各多少血，全是这个函数里的字面量。
 *   后果是"每加一个技能都要改引擎代码"，而且做完的裂魂和名刀司命
 *   只要不在那个数组里，玩家就永远选不到 —— 做完了等于没做。
 *
 * 现在一切都从 scenario 来，装配逻辑和 `npm run battle` 共用 src/scenario.ts。
 */
function restart(): void {
  /*
   * ⚠ 先把**上一局攒下来的血契**揣兜里，再建新世界。
   *
   *   玩家 2026-09-21 定的：
   *   > 注意区分局与关卡。我希望是局内资源，而不同关卡可以攒
   *
   *   所以"重开这一关"**不清零**，而"开始新的一局"才清零（见 newRun）。
   *   这就是"攒很久、最后在 Boss 关一口气放掉"能成立的地方 ——
   *   如果重开就清零，那血契永远攒不起来，负值术式也就永远放不出来。
   *
   *   ⚠ 它必须在 createWorld **之前**抓：下面 world 一换，旧实体就没了。
   */
  const carryOver = currentBloodPact()

  const active = scenario ?? fallbackScenario()
  /*
   * ⚠ 状态库要传给 lowerScenario。
   *
   *   技能里按 `statusId` 引用库状态的规则，靠这一步才真的注册进世界；
   *   漏了的话，那条规则会在**放技能的那一刻**抛「找不到状态定义」——
   *   而这正是加载期检查本该拦住的错。
   */
  const lowered = lowerScenario(
    active, id => library.get(id), [...statusDefs.values()], [...entityDefs.values()],
    [...weaponDefs.values()],
  )

  /*
   * ---- 玩家自己排的技能栏盖掉场景里的那一套 ----
   *
   * ⚠ 这是"玩家的术式真的能进游戏"的**唯一**接点。
   *   场景里的 `techniques` 现在只是**"开局发什么"**（见 `seedStarter`）：
   *   第一次打开的人会拿到副本，之后一切听玩家的。
   *   玩家一旦自己排过技能栏，就该听玩家的 ——
   *   否则他在术式编辑器里做的东西永远上不了场，
   *   那这个编辑器就是个玩具（"我做了十来个术式，一个都带不出去"）。
   *
   *   空的 `savedLoadout` = 没排过 = 用场景默认，所以这里不会把默认弄丢。
   */
  if (lowered.player !== undefined && savedLoadout.length > 0) {
    const wanted = savedLoadout.filter(id => library.has(id))
    if (wanted.length > 0) {
      lowered.player.init.techniqueIds = wanted
      lowered.player.install = []
      lowered.player.statuses = []
      for (const id of wanted) {
        const t = library.get(id)
        if (t === undefined) continue
        lowered.player.install.push(t)
        // 内联状态也要注册 —— 漏了会在放技能那一刻抛「找不到状态定义」
        lowered.player.statuses.push(...collectStatuses(t))
      }
    }
  }

  world = createWorld({ seed: lowered.seed })
  booted = true

  if (lowered.problems.length > 0) {
    console.warn('[场景] 装配有问题：\n' + lowered.problems.join('\n'))
  }

  /*
   * applyScenario 干三件事，顺序不能换：
   *   1. 注册全部术式 + 它们内联的状态定义
   *      —— 少了这一步，技能里用 statusId 引用的状态在浏览器里查不到，
   *         而命令行里查得到。同一个内容两边行为不一样，是最难查的一类 bug。
   *   2. 生成全部单位
   *   3. 打开常驻术式
   */
  const roster = applyScenario(world, lowered)

  /*
   * ⚠ 把**全部**术式注册进世界，不只是这个场景用到的那些。
   *
   *   `applyScenario` 只装"场景里那些单位列出来的"术式（保持世界小）。
   *   但**召唤出来的东西**会带自己的常驻术式 —— 比如一片减速场，
   *   它的行为写在 `entity.slow-field` 的 `activeTechniques` 里，
   *   而那个术式**不在任何单位的清单上**。
   *
   *   不注册的话：场地长出来了、看着没问题，但 `world.techniques.get()`
   *   查不到它 —— 结果是**一片什么都不做的区域**，而且没有任何地方会报错。
   *
   *   注册几十个术式就是往一张 Map 里插几十次，代价可以忽略，
   *   换来的是"内容写了就一定生效"。
   */
  for (const c of library.values()) registerTechnique(world, c)

  const playerEntity = lowered.player === undefined
    ? undefined
    : roster.get(lowered.player.label)

  if (playerEntity === undefined) {
    /*
     * 场景里没有 controlledBy: 'human' 的单位。
     *
     * 不 throw —— 一份纯 AI 的场景（比如 duel）也是合法内容，
     * 只是没人能操作。所以借第一个单位当镜头锚点，让画面有东西看。
     */
    player = roster.values().next().value ?? world.entities[0] as Entity
    loadout = []
    console.warn('[场景] 没有玩家单位，这一局是观战')
  } else {
    player = playerEntity
    loadout = playerEntity.techniqueIds.filter(id => library.has(id))

    /*
     * 把上一关攒的血契还给他。
     *
     * ⚠ 写在 spawn **之后**：场景 JSON 里的 `char.bloodPact.current` 是
     *   "新的一局的初始值"，而这里盖上去的是"这一局到目前为止攒的"。
     *   不写这一句的话，重开一关就把血契清零 —— 而"攒"正是这个机制的全部。
     */
    if (carryOver !== undefined) {
      setStored(playerEntity, 'char.bloodPact.current', carryOver)
    }
  }

  acc = 0
  clearFx()
}

/** 当前玩家身上的血契。还没开局 / 没有玩家单位时是 undefined */
function currentBloodPact(): number | undefined {
  if (!booted || player === undefined) return undefined
  return bloodPactOf(player)
}

/**
 * **开始新的一局**：血契清零，其余和重开一样。
 *
 * ⚠ 和"重开这一关"是**两个不同的动作**，不能合并：
 *   重开本关 = 打失败了再来一次，攒的东西该留着（不然每次失误都在惩罚积累）
 *   新的一局   = 从头开始，血契归零（局内资源，不跨局）
 *
 *   玩家原话："我希望是局内资源，而不同关卡可以攒" ——
 *   这两句要在代码里对应到**两个按键**，不然"局"和"关卡"的区别就丢了。
 *
 * ⚠ 实现上刻意**不加参数**：先把玩家身上的血契抹成 0，
 *   再走正常的 `restart()`（它的第一步就是把当前血契揣兜里）——
 *   于是"新的一局"和"重开本关"走的是同一条代码路径，
 *   区别只在于抹不抹那一下。多一个 `restart(fresh: boolean)` 参数的话，
 *   十几个调用点每个都得想一遍该传什么。
 */
function newRun(): void {
  if (player !== undefined) setStored(player, 'char.bloodPact.current', 0)
  restart()
  toast('新的一局：血契归零')
}

// ---------------------------------------------------------------- 输入

const keys = new Set<string>()
/**
 * 指针在**页面**里的位置（`clientX/clientY`）。
 *
 * ⚠ 收到过 `pointermove` 之前是 `undefined`，**不是 (0,0)**。
 *   (0,0) 是一个合法位置（页面左上角），拿它当"还没有"会让角色
 *   开局就朝左上瞄准 —— 而"没有指针信息"和"指针在左上角"是两件事。
 */
let mouse: { x: number; y: number } | undefined

/**
 * 上一次"按出来"的是技能栏第几格。
 *
 * ⚠ 用途只有一个：画瞄准指示。技能是**按下就放**的（没有"举着"的状态），
 *   所以没有"当前技能"这个概念 —— 但玩家需要知道自己手上那个地面技能
 *   会落在哪儿。用"上一次按的那一格"是最贴近直觉的近似。
 */
let lastCastSlot = -1

function onKeyDown(ev: KeyboardEvent): void {
  ensureAudio()
  if (ev.repeat) return
  const k = ev.key.toLowerCase()
  keys.add(k)

  if (k === 'r') { restart(); toast('重开本关（血契留着）'); return }
  /*
   * ⚠ `N` = **新的一局**，和 `R`（重开本关）不是一回事。
   *
   *   玩家定的："我希望是局内资源，而不同关卡可以攒" ——
   *   这句话要成立，就必须有两个动作：
   *     R  打失败了再来一次，攒的血契留着（不然每次失误都在惩罚积累）
   *     N  从头开始，血契归零
   *   只有一个"重开"的话，"局"和"关卡"的区别在代码里就丢了。
   */
  if (k === 'n') { newRun(); return }
  if (ev.code === 'Space') {
    ev.preventDefault()   // 不拦的话页面会滚
    paused = !paused
    toast(paused ? '已暂停' : '继续')
    return
  }
  if (k === 'tab') {
    ev.preventDefault()   // 不拦的话焦点会在表单里跳
    editor?.toggle()
    // 打开编辑器就暂停 —— 编辑的时候不该被敌人追着打
    paused = editor?.isOpen() ?? false
    // 打开时把术式那一页也刷一遍（技能可能刚改过，账要重算）
    if (paused) techEditor?.refresh()
    return
  }
  if (k === 'm') {
    muted = !muted
    toast(muted ? '静音' : '开声音')
    return
  }
  /*
   * ---- F：捡起脚边的东西（换武器）----
   *
   * ⚠ 交给引擎判"够不够得着"（`pickupNearby` 自己找最近的那件），
   *   客户端不自己选 —— 和施法只给"原始意图"是同一条原则。
   *   界面自己选的话，"够不够得着"就变成两处判断，迟早不一致：
   *   提示出现在捡不到的位置上，玩家按了没反应，而且他不会怀疑是提示的错。
   */
  if (k === 'f') {
    const res = pickupNearby(world, player)
    if (res.ok && res.equipped !== undefined) {
      toast(res.dropped !== undefined
        ? `换上 ${res.equipped.name} —— ${res.dropped.name} 掉在原地了`
        : `捡起 ${res.equipped.name}`)
    } else if (res.reason === 'dead') {
      toast('你已经倒下了')
    } else {
      toast('附近没有东西可以捡（走到武器旁边再按 F）')
    }
    return
  }

  const idx = CAST_KEYS.indexOf(ev.key as typeof CAST_KEYS[number])
  if (idx < 0) return
  const tech = library.get(loadout[idx] ?? '')
  /*
   * ⚠ 空格子要说一句。玩家 2026-09-21 定的：开局只有**一格**术式（数字键 1），
   *   其余 9 格空着 —— 按下去没反应会让人以为"键坏了"，而其实是"还没装"。
   *
   * ⚠ 更要说清的是**另一种"没反应"**（玩家 2026-09-21 报的）：他绑了一份
   *   自己做的术式，编辑器显示"装到 键2"、游戏也重开了，但那一格
   *   在引擎里**根本不存在**（空壳不进 library）。以前这里只报"还没装术式"，
   *   听起来像他没绑过 —— 现在按存档里那一格查出**真正的原因**说出来。
   */
  if (tech === undefined) {
    const boundId = savedLoadout[idx]
    const probs = boundId === undefined ? undefined : techniqueProblems.get(boundId)
    const name = boundId === undefined ? undefined : (mine.get(boundId)?.name ?? boundId)
    if (probs !== undefined && name !== undefined) {
      toast(`「${name}」放不出来：${probs[0] ?? ''} —— 按 Tab 打开编辑器改`)
    } else if (name !== undefined) {
      toast(`「${name}」没进内容库（可能是内容加载失败）—— 按 Tab 看看`)
    } else {
      toast(`${ev.key} 这一格还没装术式 —— 按 Tab 自己拼一个`)
    }
    return
  }

  switch (tech.activation) {
    case 'toggle': {
      const on = player.activeTechniques.includes(tech.id)
      setTechniqueActive(world, player, tech.id, !on)
      toast(`${tech.name} ${on ? '关闭' : '开启'}`)
      return
    }
    case 'auto':
      toast(`${tech.name} 是常驻被动，不用按`)
      return
    default: {
      /*
       * ⚠ 编译出来了**不等于能用**（悬空的技能引用、坏掉的载荷都会让它
       *   按下去什么都不发生）。这一格有问题就先说一句 ——
       *   不然玩家只会看到"按了没反应"，然后把整个编辑器当成坏的。
       */
      const probs = techniqueProblems.get(tech.id)
      if (probs !== undefined) {
        toast(`「${tech.name}」有问题：${probs[0] ?? ''} —— 按下去可能什么都没发生`)
      }
      lastCastSlot = idx
      pressCast(tech)
    }
  }
}

function onKeyUp(ev: KeyboardEvent): void {
  keys.delete(ev.key.toLowerCase())

  const idx = CAST_KEYS.indexOf(ev.key as typeof CAST_KEYS[number])
  if (idx < 0) return
  const tech = library.get(loadout[idx] ?? '')
  if (tech === undefined) return

  // 抬起触发 / 按住触发：松手就是"释放"
  if (tech.activation === 'release' || tech.activation === 'hold') {
    const cast = world.casts.find(c => c.casterId === player.id)
    if (cast !== undefined) {
      if (tech.activation === 'release') releaseCharge(world, cast.id)
      else cancelCast(world, cast.id)
    }
  }
}

/**
 * 释放一个术式（按一下技能栏里那一格）。
 *
 * ⚠ **客户端不再自己选目标了。**
 *
 *   以前这里会算一遍"射程内最近的敌人"再传 `targetId` 进去 ——
 *   而引擎里也有一套目标逻辑，两套并存的直接后果是
 *   `targeting.mode` 变成死字段：客户端已经决定了打谁，引擎读不读都一样。
 *
 *   现在客户端只负责给**原始意图**，按 mode 解析是引擎的事（`resolveAim`）。
 *   这样 AI 和玩家走同一条路，"AI 会不会放地面技能"不再是一个单独的问题。
 *
 * ⚠ **2026-09-21（日志 47）起，收集意图这件事只有一种做法**：
 *   永远是"**鼠标位置那一个点**"（`intentFromPointer`），
 *   而**不再读术式的 `targeting.mode`** 去决定"给方向还是给落点"——
 *   因为瞄准已经搬到**技能层**了（每个技能各自解释同一个意图），
 *   客户端不该、也不能再替技能做这个判断 ✗
 *   （旧写法：`tech.targeting.mode === 'areapoint' ? 给点 : 给方向`，
 *    而 `tech.targeting` 这个字段已经删掉了）。
 *
 * ⚠ 走的是 `pressSequence`，不是 `activate`。
 *   玩家 2026-09-21 定的：
 *   > "序列"机制应该也作用于魔法技能了，因为想实现二段技能只能用这种方法，
 *   > 让每条序列有不同的 CD。
 *
 *   所以**任何**术式挂了序列，按键就按"走一段"的规矩来
 *   （放完才推进 / 缓冲 / 超时回第一条）；没挂序列的走 `activate`，
 *   老路一条不少 —— `pressSequence` 自己会分这两种情况。
 */
function pressCast(tech: Technique): void {
  reportPressResult(pressSequence(world, player, tech, { intent: aimIntent() }))
}

/**
 * 左键 = **武器术式**（手上那把剑的普攻）。
 *
 * ⚠ 玩家 2026-09-21 定的：
 *   > 两个槽都进技能栏，玩家自己绑键（左键只是默认绑法）
 *
 *   所以这里不是"左键写死在某个术式上"，而是**每帧按手上的武器查**：
 *   换了武器，左键那套招式跟着换（铁剑一段、长剑两段）。
 *   而且它走的是引擎的 `pressSequence` —— "按一次走一段、放完才推进、
 *   150ms 缓冲、超时回第一条"全在模拟里，客户端只负责说"我按了一下"。
 *
 * ⚠ 空手（没武器）时左键什么都不做，**不报错也不提示**：
 *   这不是错误状态，是"你手上没东西"。
 */
function pressWeapon(): void {
  const w = player.weapon
  if (w === undefined) return
  const def = weaponDefs.get(w.id)
  const techId = def?.weaponTechnique
  if (techId === undefined) return
  const tech = library.get(techId)
  if (tech === undefined) {
    /*
     * 武器的 weaponTechnique 指向一个不存在的术式 —— 加载期已经报过一条
     * （见 loadContent 里那段），这里只是不给一个假动作。
     */
    return
  }

  /*
   * ⚠ 意图的收集方式和 `pressCast` **只有一种**（见 `aimIntent`）：
   *   鼠标那一个点。这里以前也读术式的 `targeting.mode`，现在不读了 ——
   *   武器术式（横砍 / 刺击）的瞄准同样是**技能自己的事**。
   */
  reportPressResult(pressSequence(world, player, tech, { intent: aimIntent() }))
}

function onPointerDown(ev: PointerEvent): void {
  ensureAudio()
  /*
   * ⚠ **按下的坐标也是指针位置**，不能只认 `pointermove`。
   *
   *   2026-09-21 玩家报"左键那一刀始终朝正右方"。一个很可能的环境是
   *   **点击转发但没有移动事件**（内嵌浏览器面板、自动化点击那类）——
   *   只认 `pointermove` 的话，`mouse` 永远是"没收到过"，
   *   而老代码在那种情况下会凭空返回一个 (1,0)：每一次攻击都朝正右方。
   *
   *   点击本身带着坐标（`clientX/clientY`），拿它当指针位置，
   *   "点哪儿打哪儿"在只有点击的环境里就成立了。
   */
  mouse = { x: ev.clientX, y: ev.clientY }
  // 左键 = 普攻（手上武器那套招式）。右键暂时不绑东西
  if (ev.button === 0) pressWeapon()
}

function onPointerMove(ev: PointerEvent): void {
  // ⚠ 存的是**页面坐标**（clientX/clientY）。换算成画面内坐标在
  //   `pointerWorldPoint()` 里做 —— 那里要用 canvas 的 bounding rect。
  mouse = { x: ev.clientX, y: ev.clientY }
}

/** 屏幕坐标 → 世界坐标（相机跟着玩家） */
function screenToWorld(sx: number, sy: number): { x: number; y: number } {
  return {
    x: (sx - canvas.clientWidth / 2) / PX_PER_M + player.pos.x,
    y: (sy - canvas.clientHeight / 2) / PX_PER_M + player.pos.y,
  }
}

/**
 * 指针现在指着世界里的哪一点。没收到过指针事件时返回 undefined。
 *
 * ⚠ 指针是**页面坐标**，而 `screenToWorld` 要的是**画面内坐标** ——
 *   所以先用 `getBoundingClientRect()` 减掉 canvas 的左上角。
 *   以前直接拿 `clientX` 当画面内坐标用，那只在"canvas 贴在视口左上角"
 *   时才对（当时是 `position: fixed; inset: 0`，所以对）。
 */
function pointerWorldPoint(): { x: number; y: number } | undefined {
  if (mouse === undefined) return undefined
  const r = canvas.getBoundingClientRect()
  return screenToWorld(mouse.x - r.left, mouse.y - r.top)
}

/** 世界坐标 → 屏幕坐标。特效画在屏幕空间，文字才不会被缩放糊掉 */
function worldToScreen(wx: number, wy: number): { x: number; y: number } {
  return {
    x: (wx - player.pos.x) * PX_PER_M + canvas.clientWidth / 2,
    y: (wy - player.pos.y) * PX_PER_M + canvas.clientHeight / 2,
  }
}

/**
 * 瞄准方向 = **鼠标方向**。
 *
 * ⚠ 算不出来时**沿用角色当前朝向**（它本来就是上一 tick 算出来的瞄准方向），
 *   绝不凭空造一个方向。
 *
 *   老代码里是 `if (len < 1e-6) return { x: 1, y: 0 }` ——
 *   于是"指针还没动过 / 指针恰好在画面正中 / 画面尺寸是 0"这几种情况
 *   全都变成"朝正右方"，**每一次攻击都朝右**，而且没有任何报错。
 *   玩家报的就是这个：
 *   > 使用铁剑时鼠标左键的攻击始终朝向正右方而不是鼠标方向
 *
 *   算的那部分搬去了 `aim.ts`（纯函数，浏览器之外能测）。
 */
function aimDirection(): { x: number; y: number } {
  const r = canvas.getBoundingClientRect()
  return aimFromPointer(
    mouse,
    { left: r.left, top: r.top, width: r.width, height: r.height },
    player.facing,
  )
}

/**
 * **玩家的意图** —— 这一次按键给出的那一个指向。
 *
 * ⚠ 2026-09-21（日志 47）定稿（`docs/sequence-and-modifier-model.md` §九）：
 *   **意图 = 玩家这一次激活给出的那一个指向**，
 *   而"这一次"能给的只有一样东西：**鼠标位置那一个点** ✓
 *   （方向、落点都从它推出来 —— 一次输入不可能给出两个指向。）
 *
 * ⇒ 所以这里**不再看术式的 `targeting.mode`** 决定收集什么 ✗
 *   （旧写法是 `areapoint` 就给落点、别的就给方向 —— 那是客户端在替技能做判断，
 *    而瞄准已经搬到**技能层**，每个技能各自解释这同一个意图）。
 *
 * ⚠ 一个点 + 一个方向，**是同一份意图的两半**，不是两份意图：
 *   · `x` / `y` = 鼠标在世界里的那个点（`areapoint` 技能读它当落点：火墙就长在那儿）；
 *   · `dir` = 鼠标方向（其余模式读它当朝向）。
 *   为什么方向要单独给、不让引擎从点反推：`dir` 算不出来时会沿用它上一次的值
 *   （= 角色当前朝向，见 `aim.ts` 的注释），而"沿用它上一次"这件事从这个点上
 *   反推不出来 —— 指针还没动过时这个点会退化成角色自己的位置。
 *
 * ⚠ 顺带让角色转向鼠标：那是**画面**的事（人在朝哪走 / 脸朝哪），
 *   和"打谁"无关 —— 打谁是引擎按技能的 `targeting` 解算的（`resolveAim`）。
 */
function aimIntent(): AimIntent {
  const dir = aimDirection()
  player.facing = dir
  const point = pointerWorldPoint() ?? player.pos
  return { kind: 'point', x: point.x, y: point.y, dir }
}

// ⚠ 这里原来有个 `nearestEnemyInRange()`：客户端自己算"射程内最近的敌人"
//   再当 targetId 传给引擎。删掉了 —— 那是 `targeting.mode` 变成死字段的
//   直接原因（客户端已经选好了人，引擎读不读 mode 都一样）。
//   现在目标选择在引擎的 `resolveAim` 里，一份。

function blockReason(r: string): string {
  switch (r) {
    case 'cooldown': return '冷却中'
    case 'energy': return '能量不够'
    /*
     * ⚠ 血契和能量**必须分开说**。
     *   能量等一会儿就回来了，血契不会 —— 所以提示要让玩家知道
     *   "这不是等一下的事，你得去挨几下/攒一攒"。
     */
    case 'bloodPact': return '血契不够 —— 这是负值术式，它不等你，得去攒'
    case 'busy': return '正在施法'
    case 'silenced': return '被控制，放不出来'
    default: return '放不出来：' + r
  }
}

/**
 * 按一下之后**该说什么**（飘字）。
 *
 * ⚠ 只有这一个出口：`pressCast` 和 `pressWeapon` 都走它 ——
 *   两条路各写一遍的话，"冷却提示"迟早只在其中一条路上生效。
 * ⚠ 一次按键**最多一条**飘字：`pressSequence` 只报挡住这一下的那一条，
 *   这里也只弹一次（按住不放也不会刷 —— `onKeyDown` 已经 `if (ev.repeat) return`）。
 */
function reportPressResult(res: PressResult): void {
  // ok = 放出去了；buffered = 正在放、那一下记住了 —— 都不该弹提示
  if (res.ok || res.reason === undefined) return
  toast(res.cooldown !== undefined ? cooldownHint(res.cooldown) : blockReason(res.reason))
}

/**
 * 轮到的序列在冷却 —— 提示必须说清**哪一条 + 还剩多久**。
 *
 * ⚠ 玩家 2026-09-21 点名要的：上一轮的亏就是"按下去没反应，而且不知道为什么"。
 *   所以宁可长一点，也不写光秃秃的"冷却中"。
 *
 * ⚠ **只做飘字**：玩家看到的应该只有他**装配的术式**那一栏，
 *   不该去闪界面上的某一格（那会被读成"技能栏"，而那不是玩家的东西）。
 * ⚠ 术语是「序列」，不是「技能」—— 按下去走的是术式挂的那条序列。
 */
function cooldownHint(c: CooldownNotice): string {
  const which = `第${c.index + 1}条序列「${c.name}」`
  const left = `还剩 ${c.remaining.toFixed(1)} 秒`
  /*
   * 两种收尾分开说（见 sim 的 `CooldownNotice.allCooling`）：
   *   · 还有别的段能放 → 指针已经挪到下一条，**再按一次**才试
   *   · 整条链都在冷却 → 指针回到第一条等着，再按也还是它
   * 不说清的话，玩家会以为"再按一下就是刚才那条"，于是白按。
   */
  return c.allCooling
    ? `${which}冷却中，${left} —— 整条链都在冷却，回到第一条等着`
    : `${which}冷却中，${left} —— 已切到下一条，再按一次`
}

/** 把键盘状态写进玩家实体。这一步是"输入层"，模拟核不关心它从哪来 */
function applyInput(): void {
  if (!player.alive) {
    player.vel.x = 0
    player.vel.y = 0
    return
  }

  const caps = canAct(player, 'move')
  const busy = world.casts.some(c => c.casterId === player.id
    && c.technique.phases[c.phaseIndex]?.occupiesCaster === true)

  let vx = 0
  let vy = 0
  if (caps && !busy) {
    if (keys.has('w') || keys.has('arrowup')) vy -= 1
    if (keys.has('s') || keys.has('arrowdown')) vy += 1
    if (keys.has('a') || keys.has('arrowleft')) vx -= 1
    if (keys.has('d') || keys.has('arrowright')) vx += 1
  }
  const len = Math.sqrt(vx * vx + vy * vy)
  const speed = resolveAttribute(player, 'char.speed', { world, self: player })
  player.vel.x = len > 0 ? (vx / len) * speed : 0
  player.vel.y = len > 0 ? (vy / len) * speed : 0

  if (!busy) player.facing = aimDirection()

  /*
   * ⚠ 这里原来有一段 `if (pointerDown) { pointerDown = false; pressCast(loadout[0]) }`。
   *
   *   那是**左键 = 1 号键**时代的写法。加上"左键 = 手上武器的普攻"之后
   *   它没有删掉，于是按一下左键会**同时**放出两个东西：
   *   武器那套普攻 + 技能栏第 1 格的术式（arena 里是蓄斩）。
   *
   *   玩家的第一反应是：
   *   > 按下鼠标左键为什么会激活数字 1 对应的蓄斩？
   *
   *   对 —— 那是重复的旧路径。左键现在只有一条路（`pressWeapon`）。
   *   `pointerDown` 这个标志整个删掉了：它只剩这一个用处。
   */
}

// ---------------------------------------------------------------- 循环

let acc = 0
let last = performance.now()

function frame(now: number): void {
  const real = Math.min((now - last) / 1000, 0.25) // 卡顿时别一次追太多
  last = now

  if (paused) {
    // 暂停时不积压时间 —— 否则一解除暂停会瞬间补跑几百 tick
    acc = 0
  } else {
    acc += real
    let steps = 0
    while (acc >= world.dt && steps < 8) {
      applyInput()
      stepWorld(world)
      // ⚠ 必须在这里就把事件收走。一帧可能跑好几个 tick，
      //   而 stepWorld 每 tick 开始时清空 events —— 只在循环外用就拿不到全部
      drainEvents(world.events)
      acc -= world.dt
      steps++
    }
  }

  rememberPositions()
  updateFx(real)   // 特效照走 —— 暂停时画面还是活的

  draw()
  updateHud()
  requestAnimationFrame(frame)
}

/** 记下每个实体最后出现的位置。实体死了会被移出 world，但特效还要在它倒下的地方播 */
function rememberPositions(): void {
  for (const e of world.entities) {
    const s = worldToScreen(e.pos.x, e.pos.y)
    lastPos.set(e.id, s)
  }
  lastPos.set(player.id, worldToScreen(player.pos.x, player.pos.y))
}

function resize(): void {
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(canvas.clientWidth * dpr)
  canvas.height = Math.round(canvas.clientHeight * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

// ---------------------------------------------------------------- 渲染
//
// 这一层**只读**模拟状态。它不 stepWorld、不改 pos、不改 hp。
// 守住这条，"以后换美术"就只是换掉这个文件。

function draw(): void {
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  ctx.fillStyle = COLOR.bg
  ctx.fillRect(0, 0, w, h)

  // 抖屏：只偏移相机，不动世界坐标
  const sx = shake > 0 ? (hash(world.tick) - 0.5) * shake : 0
  const sy = shake > 0 ? (hash(world.tick + 31) - 0.5) * shake : 0

  ctx.save()
  ctx.translate(w / 2 + sx, h / 2 + sy)
  ctx.scale(PX_PER_M, PX_PER_M)
  ctx.translate(-player.pos.x, -player.pos.y)

  drawGrid()
  drawArena()

  /*
   * ⚠ 隐形必须**画出来**，否则它是个玩家看不见的机制。
   *
   *   在这之前 `visibilityOf()` 算出来了但没有任何地方读它 ——
   *   状态里写 visibility 是白写。现在 sim 用它做 AI 的锁定判定，
   *   这里用它做透明度，两边合起来"隐形"才是一个完整的机制：
   *   **敌人找不到你，你自己看得见自己变淡了。**
   *
   * 玩家自己那一侧**不压暗那么多**（底下留 0.35）：完全看不见自己会很难操作，
   * 而且你总该知道自己藏起来了。
   */
  for (const e of world.entities) {
    if (e.kind !== 'actor') continue
    const v = visibilityOf(e)
    if (v >= 1) {
      drawActor(e)
      continue
    }
    const isSelf = e.id === player.id
    const alpha = isSelf ? 0.35 + v * 0.3 : v
    ctx.globalAlpha = alpha
    drawActor(e)
    ctx.globalAlpha = 1
  }
  // 玩家死了会被移出 entities，但尸体得留着 —— 不然"人突然不见了"更莫名其妙
  if (!player.alive) drawActor(player)

  /*
   * ---- 状态光环 ----
   *
   * ⚠ 状态以前**完全看不见**：HUD 里只有一行文字，战场上没有任何提示。
   *   `StatusDef.vfx` 承诺了"一眼看出身上有什么"，但它是个死字段，
   *   而且就算不是，那些 `fx.sunder` 名字下面一条素材都没有。
   *
   * 所以这里画的是**按标签上色的程序化光环**（见 fx.ts 的 pickStatusStyle）：
   * 冻住是冰蓝、护盾是金色、负面是红、正面是绿。有素材的时候，
   * 以后可以在光环之外再叠一条序列帧 —— 素材是加分项，程序化是保底。
   *
   * ⚠ 画在**角色之后**：光环要压在人身下/身上，不然会被身体盖掉一半。
   *   而且只在活着的单位上画 —— 尸体身上的状态没有意义。
   */
  for (const e of world.entities) {
    if (e.kind !== 'actor' || !e.alive) continue
    // 状态叠得越多，圈越往外错开（不用 sin/cos：只有一圈偏移，直接算）
    e.statuses.forEach((s, i) => {
      const style = pickStatusStyle(s.tags)
      /*
       * 呼吸感：每圈差一个相位，看起来才不像所有圈一起闪。
       *
       * ⚠ 用 `world.tick` 而不是时钟 —— 客户端虽然可以用 Date，
       *   但既然模拟是固定 tick 的，画面跟着 tick 走才能和回放对齐
       *   （暂停时画面也该停）。
       */
      const phase = (world.tick + i * 20) % 120
      const p = phase < 60 ? phase / 60 : (120 - phase) / 60
      const prims = statusPrims(e.pos.x, e.pos.y, i, e.radius, style, p)
      for (const prim of prims) {
        if (prim.op === 'arc') {
          ctx.strokeStyle = prim.color
          ctx.globalAlpha = prim.alpha
          ctx.lineWidth = prim.width
          ctx.beginPath()
          ctx.arc(prim.x, prim.y, prim.r, 0, Math.PI * 2)
          ctx.stroke()
        } else if (prim.op === 'disc') {
          ctx.fillStyle = prim.color
          ctx.globalAlpha = prim.alpha
          ctx.beginPath()
          ctx.arc(prim.x, prim.y, prim.r, 0, Math.PI * 2)
          ctx.fill()
        }
      }
      ctx.globalAlpha = 1
    })
  }
  for (const e of world.entities) {
    if (e.kind === 'projectile') drawProjectile(e)
  }

  /*
   * ---- 地上的东西（武器）----
   *
   * ⚠ 武器必须**看得见**。玩家 2026-09-21 给的前提是
   *   "换武器的前提是武器有建模，能作为实体被交互" ——
   *   看不见的东西不是建模，只是一个隐藏的开关。
   *
   * 画在地面这一层（角色之前）：它躺在地上，不该盖住人。
   * 而且它**不动**，所以不参与任何补间 —— 每帧照位置画就是了。
   */
  for (const e of world.entities) {
    if (e.kind !== 'item' || !e.alive) continue
    drawGroundItem(e)
  }

  /*
   * ---- 屏障 ----
   *
   * ⚠ 它必须**看得出来是一堵墙**，而不是一个圆点：
   *   玩家要能一眼判断"我躲在墙后面吗"、"子弹会从哪儿被挡下来"。
   *   所以线段形状就画成一条粗线（和判定用的形状一模一样）。
   */
  for (const e of world.entities) {
    if (e.kind !== 'obstacle' || !e.alive) continue
    drawBarrier(e)
  }

  // 载体特效画在世界空间（它是几何，单位是米），但要在角色和子弹**上面**
  // 序列帧先画、程序化后画 —— 作者做的那条通常是主体，程序化的火星盖在上面正好
  for (const s of sprites) drawSprite(ctx, s)
  for (const d of deliveries) drawDelivery(ctx, d)

  drawAim()

  ctx.restore()

  // ---- 特效画在屏幕空间，文字才不会被缩放糊掉 ----
  drawParticles()
  drawFloaters()
  drawPickupPrompt()
}

function drawGrid(): void {
  const x0 = Math.floor((player.pos.x - ARENA) / 2) * 2
  const x1 = player.pos.x + ARENA
  const y0 = Math.floor((player.pos.y - ARENA) / 2) * 2
  const y1 = player.pos.y + ARENA

  for (let x = x0; x <= x1; x += 2) {
    ctx.strokeStyle = x % 10 === 0 ? COLOR.gridBold : COLOR.grid
    ctx.lineWidth = 1 / PX_PER_M
    ctx.beginPath()
    ctx.moveTo(x, y0)
    ctx.lineTo(x, y1)
    ctx.stroke()
  }
  for (let y = y0; y <= y1; y += 2) {
    ctx.strokeStyle = y % 10 === 0 ? COLOR.gridBold : COLOR.grid
    ctx.lineWidth = 1 / PX_PER_M
    ctx.beginPath()
    ctx.moveTo(x0, y)
    ctx.lineTo(x1, y)
    ctx.stroke()
  }
}

function drawArena(): void {
  ctx.strokeStyle = COLOR.wall
  ctx.lineWidth = 3 / PX_PER_M
  ctx.beginPath()
  ctx.arc(0, 0, ARENA, 0, Math.PI * 2)
  ctx.stroke()
}

function entityColor(e: Entity): string {
  if (factionOf(e) === 'player') return COLOR.player
  if (factionOf(e) === 'enemy') return COLOR.enemy
  return COLOR.neutral
}

/**
 * 屏障（一道挡子弹的墙）。
 *
 * ⚠ 画的就是**判定用的那个形状**：线段画成一条粗线，圆画成一根环。
 *   画大了会让人觉得"明明没打中却被挡"；画小了会让人觉得"墙漏了"。
 *   两者都会让玩家怀疑判定，而不是怀疑自己的站位。
 */
function drawBarrier(e: Entity): void {
  const shape = e.shape
  const hpMax = Math.max(1, resolveAttribute(e, 'char.hp.max', { world, self: e }))
  const hpPct = Math.max(0, Math.min(1, getStored(e, 'char.hp.current') / hpMax))
  // 血越少越暗："墙快没了"要能一眼看出来
  const color = hpPct > 0.5 ? '#58a6ff' : hpPct > 0.2 ? '#d29922' : '#f85149'

  ctx.globalAlpha = 0.35 + 0.45 * hpPct
  ctx.strokeStyle = color
  ctx.lineCap = 'round'

  if (shape !== undefined && shape.kind === 'segment') {
    // 朝向**当场读**（不归一化也行：schema 里它就是单位向量），
    // 和判定用同一份数据 —— 画的和挡的必须是同一个形状
    const f = e.facing
    const half = shape.length / 2
    ctx.lineWidth = shape.width
    ctx.beginPath()
    ctx.moveTo(e.pos.x - f.x * half, e.pos.y - f.y * half)
    ctx.lineTo(e.pos.x + f.x * half, e.pos.y + f.y * half)
    ctx.stroke()
  } else {
    ctx.lineWidth = 0.25
    ctx.beginPath()
    ctx.arc(e.pos.x, e.pos.y, e.radius, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

/**
 * 地上的一件东西（现在只有武器）。
 *
 * ⚠ 画成"一把插在地上的剑"而不是一个方块：这是唯一能让人**一眼**看出
 *   "那儿有东西可以捡"的画法。玩家没读过任何说明。
 *
 * ⚠ 够得着的时候加一圈高亮 —— 和 HUD 那句「按 F 拾取」是同一个判据
 *   （`nearestPickup`），所以高亮的和提示的永远是同一件东西。
 */
function drawGroundItem(e: Entity): void {
  const reachable = nearestPickup(world, player)?.id === e.id

  // 地上的阴影：让它看着是"躺在地上"而不是浮着
  ctx.globalAlpha = 0.28
  ctx.fillStyle = '#000000'
  ctx.beginPath()
  ctx.ellipse(e.pos.x, e.pos.y + 0.12, 0.34, 0.16, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalAlpha = 1

  // 剑刃：一条斜着的线 + 护手。**不转**，躺着的武器不该随鼠标动
  ctx.strokeStyle = reachable ? COLOR.player : '#9aa4b2'
  ctx.lineWidth = 0.1
  ctx.beginPath()
  ctx.moveTo(e.pos.x - 0.3, e.pos.y + 0.3)
  ctx.lineTo(e.pos.x + 0.3, e.pos.y - 0.3)
  ctx.stroke()
  ctx.lineWidth = 0.07
  ctx.beginPath()
  ctx.moveTo(e.pos.x - 0.12, e.pos.y - 0.02)
  ctx.lineTo(e.pos.x + 0.12, e.pos.y - 0.26)
  ctx.stroke()

  if (reachable) {
    ctx.strokeStyle = COLOR.player
    ctx.globalAlpha = 0.5 + 0.3 * Math.abs(((world.tick % 60) / 60) * 2 - 1)
    ctx.lineWidth = 1.6 / PX_PER_M
    ctx.beginPath()
    ctx.arc(e.pos.x, e.pos.y, 0.5, 0, Math.PI * 2)
    ctx.stroke()
    ctx.globalAlpha = 1
  }
}

function drawActor(e: Entity): void {
  ctx.globalAlpha = e.alive ? 1 : 0.25

  ctx.fillStyle = entityColor(e)
  ctx.beginPath()
  ctx.arc(e.pos.x, e.pos.y, e.radius, 0, Math.PI * 2)
  ctx.fill()

  // 受击闪白：叠一层白。顿帧期间它停在最亮的一帧上，这就是"打实了"的感觉
  const f = flash.get(e.id)
  if (f !== undefined && f > 0) {
    ctx.globalAlpha = Math.min(1, f / FLASH_TIME) * 0.9
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(e.pos.x, e.pos.y, e.radius * 1.06, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = e.alive ? 1 : 0.25
  }

  // 朝向
  ctx.strokeStyle = entityColor(e)
  ctx.lineWidth = 0.09
  ctx.beginPath()
  ctx.moveTo(e.pos.x, e.pos.y)
  ctx.lineTo(e.pos.x + e.facing.x * 0.85, e.pos.y + e.facing.y * 0.85)
  ctx.stroke()

  // 被控制的时候套个圈 —— 玩家必须一眼看出自己动不了
  if (!canAct(e, 'move') && e.alive) {
    ctx.strokeStyle = COLOR.castBar
    ctx.lineWidth = 0.08
    ctx.beginPath()
    ctx.arc(e.pos.x, e.pos.y, e.radius + 0.22, 0, Math.PI * 2)
    ctx.stroke()
  }

  // 施法条
  const cast = world.casts.find(c => c.casterId === e.id)
  if (cast !== undefined) {
    const ph = cast.technique.phases[cast.phaseIndex]
    const frac = ph === undefined ? 0
      : ph.duration < 0 ? Math.min(1, cast.charge / 2)
        : Math.min(1, cast.elapsed / ph.duration)
    drawBar(e.pos.x - 0.6, e.pos.y - 0.95, 1.2, 0.13, frac, COLOR.castBar)
  }

  drawHpBar(e)
  drawStatusDots(e)

  ctx.globalAlpha = 1
}

function drawHpBar(e: Entity): void {
  const max = resolveAttribute(e, 'char.hp.max', { world, self: e })
  if (max <= 0) return
  const frac = Math.max(0, Math.min(1, getStored(e, 'char.hp.current') / max))
  drawBar(e.pos.x - 0.6, e.pos.y - 0.78, 1.2, 0.16, frac,
    factionOf(e) === 'player' ? COLOR.hpPlayer : COLOR.hpEnemy)
}

/**
 * 状态小圆点。
 *
 * 玩家**必须**能看出身上有什么 —— 尤其是"名刀已经用掉了"这种。
 * 没有这个的话，你只会觉得"怎么这次没拦住"，而不知道该等冷却。
 */
function drawStatusDots(e: Entity): void {
  if (e.statuses.length === 0) return

  const y = e.pos.y - 0.58
  const step = 0.19
  const x0 = e.pos.x - ((e.statuses.length - 1) * step) / 2

  e.statuses.forEach((s, i) => {
    ctx.fillStyle = statusColor(s.tags)
    ctx.beginPath()
    ctx.arc(x0 + i * step, y, 0.075, 0, Math.PI * 2)
    ctx.fill()
  })
}

function statusColor(tags: string[]): string {
  if (tags.includes('cooldown')) return COLOR.dim
  if (tags.includes('hardCC')) return COLOR.castBar
  if (tags.includes('softCC')) return COLOR.player
  if (tags.includes('dot')) return COLOR.enemy
  if (tags.includes('buff')) return COLOR.heal
  return COLOR.blocked
}

function drawBar(x: number, y: number, w: number, h: number, frac: number, color: string): void {
  ctx.fillStyle = COLOR.hpBack
  ctx.fillRect(x, y, w, h)
  ctx.fillStyle = color
  ctx.fillRect(x, y, w * frac, h)
}

function drawProjectile(e: Entity): void {
  ctx.fillStyle = COLOR.projectile
  ctx.beginPath()
  ctx.arc(e.pos.x, e.pos.y, Math.max(0.12, e.radius), 0, Math.PI * 2)
  ctx.fill()

  const vlen = Math.sqrt(e.vel.x * e.vel.x + e.vel.y * e.vel.y)
  if (vlen > 0.01) {
    ctx.strokeStyle = COLOR.projectile
    ctx.globalAlpha = 0.35
    ctx.lineWidth = e.radius * 1.4
    ctx.beginPath()
    ctx.moveTo(e.pos.x, e.pos.y)
    ctx.lineTo(e.pos.x - e.vel.x * 0.06, e.pos.y - e.vel.y * 0.06)
    ctx.stroke()
    ctx.globalAlpha = 1
  }
}

/**
 * 这一格现在会**怎么瞄** —— 给 `drawAim()` 画提示用的读数。
 *
 * ⚠ 瞄准在**技能**上（2026-09-21 日志 47），所以这里顺着编译产物找技能：
 *   · 普通术式：`skillIds` 里第一个带瞄准的技能；
 *   · 序列术式（容器，自己的 `skillIds` 是空的）：看**下一段**的那些技能
 *     —— 和引擎 `peekSequence` 的取向一致（按下去放的是那一段）。
 *
 * ⚠ 用的是**编译产物**（不是内容里那份术式）：`CompiledTechnique.targeting`
 *   本来就是编译时从技能取来的那一份（`compile.ts` 的 `targetingOfChain`），
 *   所以这里读它 = 引擎会真的用的那一份，不会有两套读数。
 *
 * ⚠ 它**只影响画出来的提示**，不影响行为。
 */
function aimPreviewTargeting(tech: CompiledTechnique): Targeting | undefined {
  if (tech.skillIds.length > 0) return firstTargetingOf(tech.skillIds)
  for (const seg of tech.segments ?? []) {
    const found = firstTargetingOf(seg.technique.skillIds)
    if (found !== undefined) return found
  }
  return undefined
}

/** 一条技能链上第一个带瞄准的技能那一份（找不到就是 undefined） */
function firstTargetingOf(skillIds: readonly string[]): Targeting | undefined {
  for (const id of skillIds) {
    const s = skills.get(id)
    if (s?.targeting !== undefined) return s.targeting
  }
  return undefined
}

/** 瞄准提示 */
function drawAim(): void {
  const aim = aimDirection()

  /*
   * ⚠ 手里那个技能是 `areapoint`（点地面）时，画的是**落点圆圈**，
   *   不是方向线。
   *
   *   原因：方向线对地面技能毫无意义（它不朝哪打，它落在哪），
   *   而玩家必须能看见"这一下会落在哪儿、范围多大、够不够得着"。
   *   超出 range 的落点会显示成红色 —— 因为引擎会把它**压回边缘**
   *   （不是拒绝释放），玩家得知道实际会落在哪。
   */
  /*
   * ⚠ **这一份瞄准是从技能身上读的**（2026-09-21 日志 47）。
   *
   *   以前读的是 `tech.targeting`（术式自己的那份），而那个字段已经删掉了 ——
   *   瞄准搬到技能层之后，要回答"这一格现在怎么瞄"就得**顺着术式找技能**：
   *     · 普通术式：`skills` 里第一个带瞄准的技能；
   *     · 序列术式（容器）：它自己不带技能 —— 看**下一段**的那份
   *       （和引擎 `peekSequence` 的取向一致：按下去放的是那一段）。
   *
   *   ⚠ 这只是**画提示**用的读数，不是行为：真正解算瞄准的是引擎的
   *     `resolveAim`，它认的是**编译产物**里那一份（编译时从技能取的）。
   */
  const tech = library.get(loadout[lastCastSlot] ?? '')
  const point = pointerWorldPoint()
  const targeting = tech === undefined ? undefined : aimPreviewTargeting(tech)
  if (targeting !== undefined && targeting.mode === 'areapoint' && point !== undefined) {
    const world = point
    const range = targeting.range ?? 0
    const dx = world.x - player.pos.x
    const dy = world.y - player.pos.y
    const dist = Math.sqrt(dx * dx + dy * dy)
    const tooFar = range > 0 && dist > range

    // 实际落点（和引擎的钳制规则一致：超了压回射程边缘）
    const k = tooFar ? range / dist : 1
    const lx = player.pos.x + dx * k
    const ly = player.pos.y + dy * k

    // 射程圈：让"够不够得着"一眼可见
    ctx.globalAlpha = 0.12
    ctx.strokeStyle = COLOR.player
    ctx.lineWidth = 1 / PX_PER_M
    ctx.beginPath()
    ctx.arc(player.pos.x, player.pos.y, Math.max(0.1, range), 0, Math.PI * 2)
    ctx.stroke()

    // 落点圈
    ctx.globalAlpha = 0.5
    ctx.strokeStyle = tooFar ? COLOR.enemy : COLOR.player
    ctx.lineWidth = 1.5 / PX_PER_M
    ctx.beginPath()
    ctx.arc(lx, ly, 2.5, 0, Math.PI * 2)
    ctx.stroke()

    // 从人到落点的一条细线，看得清"放在那个方向上的哪一点"
    ctx.globalAlpha = 0.15
    ctx.beginPath()
    ctx.moveTo(player.pos.x, player.pos.y)
    ctx.lineTo(lx, ly)
    ctx.stroke()

    ctx.globalAlpha = 1
    return
  }

  ctx.globalAlpha = 0.18
  ctx.strokeStyle = COLOR.player
  ctx.lineWidth = 1.5 / PX_PER_M
  ctx.beginPath()
  ctx.moveTo(player.pos.x, player.pos.y)
  ctx.lineTo(player.pos.x + aim.x * 6, player.pos.y + aim.y * 6)
  ctx.stroke()
  ctx.globalAlpha = 1
}

function drawParticles(): void {
  for (const p of particles) {
    const k = 1 - p.age / PARTICLE_LIFE
    ctx.globalAlpha = Math.max(0, k)
    ctx.fillStyle = p.color
    ctx.beginPath()
    ctx.arc(p.x, p.y, p.size * (0.4 + k * 0.6), 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

function drawFloaters(): void {
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const f of floaters) {
    const k = f.age / FLOATER_LIFE
    // 先弹出来再缩回去，数字才有"蹦"的感觉
    const pop = k < 0.15 ? 1 + (1 - k / 0.15) * 0.5 : 1
    const size = (f.big ? 22 : 16) * pop

    ctx.globalAlpha = Math.max(0, 1 - k * k)
    ctx.font = `700 ${size}px ui-monospace, Consolas, monospace`
    ctx.lineWidth = 3
    ctx.strokeStyle = '#0d1017'
    ctx.strokeText(f.text, f.x, f.y)
    ctx.fillStyle = f.color
    ctx.fillText(f.text, f.x, f.y)
  }
  ctx.globalAlpha = 1
}

/**
 * 「按 F 拾取长剑」。
 *
 * ⚠ 画在**屏幕空间**（和飘字一样），不跟着世界缩放 ——
 *   世界空间里的字会被 PX_PER_M 放大成一团糊。
 *
 * ⚠ 判据用的是引擎的 `nearestPickup`，不是客户端自己算距离：
 *   提示出现了，按 F 就一定有效。这是"两处判断迟早不一致"里最容易踩的一处
 *   （提示在捡不到的位置上，玩家按了没反应，他不会怀疑是提示的错）。
 */
function drawPickupPrompt(): void {
  const item = nearestPickup(world, player)
  if (item === undefined || item.weapon === undefined) return
  const p = worldToScreen(item.pos.x, item.pos.y)
  const text = `按 F 拾取 ${item.weapon.name}`

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = '600 14px ui-monospace, Consolas, monospace'
  ctx.lineWidth = 3
  ctx.strokeStyle = '#0d1017'
  const y = p.y - 26
  ctx.strokeText(text, p.x, y)
  ctx.fillStyle = COLOR.player
  ctx.fillText(text, p.x, y)
}

// ---------------------------------------------------------------- HUD
//
// ⚠ 这一节是**结构性**的，不是审美问题。
//
//   以前是每帧 `statsEl.innerHTML = ...` / `skillsEl.innerHTML = ...` ——
//   等于每秒把整个 HUD 的 DOM 删掉重建 120 次。后果是一整张清单：
//
//     血条平滑过渡         —— 元素每帧都是新的，CSS transition 永远从零开始
//     技能格上的按钮 / hover —— 鼠标还没移上去，元素已经被换掉了
//     冷却数字滚动          —— 同上
//     状态图标上的倒计时环   —— 同上
//
//   所以现在：**结构只建一次，之后只改变化的那几个字段。**
//   外观一个字都没变 —— 这一步的意义是"以后才有得变"。
//
// ⚠ 重建的时机按**结构签名**判断，不是按帧：
//     状态面板：血 / 能量 / 血契 / 敌人数 / tick —— 全部就地改
//     技能栏：`loadout` 变了才重建（换技能栏、换场景）
//     状态列表：**身上挂的状态集合**变了才重建（剩余时长每帧在变，不进签名）

interface StatsRefs {
  hp: HTMLElement
  hpMax: HTMLElement
  en: HTMLElement
  enMax: HTMLElement
  pact: HTMLElement
  weapon: HTMLElement
  tick: HTMLElement
  foes: HTMLElement
  hitstop: HTMLElement
  pausedRow: HTMLElement
  verdictRow: HTMLElement
}

let statRefs: StatsRefs | undefined

/**
 * 建一次状态面板的骨架。
 *
 * ⚠ 骨架里**只放固定的字**（"HP"、"能量"、"血契"、"敌人"），
 *   所有会变的数都留空，由 `updateHud()` 填。
 *   把数写死在骨架里的话，"建一次"就等于"再也不更新"。
 */
function buildStats(): void {
  statsEl.innerHTML =
    '<div>HP <b id="hudHp"></b> / <span id="hudHpMax"></span>'
    + '　能量 <b id="hudEn"></b> / <span id="hudEnMax"></span>'
    + '　血契 <b id="hudPact"></b></div>'
    /*
     * ⚠ 武器**一直显示**，哪怕是空手。
     *   只在手上有武器时才显示的话，"我手上现在是什么"就变成一个
     *   要靠记忆回答的问题 —— 而它决定了伤害、射程、攻速和左键走哪几段。
     */
    + '<div>武器 <b id="hudWeapon"></b></div>'
    + '<div class="dim">tick <span id="hudTick"></span>'
    + '　敌人 <span id="hudFoes"></span><b id="hudHitstop" style="color:#d29922"></b></div>'
    + '<div id="hudPaused" style="color:#58a6ff"></div>'
    + '<div id="hudVerdict"></div>'

  const q = (id: string): HTMLElement | null => document.getElementById(id)
  const ids = ['hudHp', 'hudHpMax', 'hudEn', 'hudEnMax', 'hudPact', 'hudWeapon',
    'hudTick', 'hudFoes', 'hudHitstop', 'hudPaused', 'hudVerdict'] as const
  const found = ids.map(q)
  // 认不出骨架就别记 refs —— 下一帧会再试一次（"内容加载失败"那条路会换掉 statsEl）
  if (found.some(e => e === null)) {
    statRefs = undefined
    return
  }
  statRefs = {
    hp: found[0] as HTMLElement,
    hpMax: found[1] as HTMLElement,
    en: found[2] as HTMLElement,
    enMax: found[3] as HTMLElement,
    pact: found[4] as HTMLElement,
    weapon: found[5] as HTMLElement,
    tick: found[6] as HTMLElement,
    foes: found[7] as HTMLElement,
    hitstop: found[8] as HTMLElement,
    pausedRow: found[9] as HTMLElement,
    verdictRow: found[10] as HTMLElement,
  }
}

/** 技能格里要就地改的那几处。认不出来（假 DOM）就是 null，跳过 */
interface SkillRowRefs {
  id: string
  root: HTMLElement | null
  cd: HTMLElement | null
  pact: HTMLElement | null
}

let skillSig = ''
let skillRefs: SkillRowRefs[] = []
let statusSig = ''
let statusDurRefs: { el: HTMLElement; defId: string }[] = []

/**
 * 建技能栏。
 *
 * ⚠ 结构用 `innerHTML` 一次拼好（不是 appendChild）——
 *   这样"栏里有哪些术式"在 DOM 里是**可读的一整块**，测试和调试能直接看。
 *   之后就靠 `data-hud-*` 标记查回每个会变的数，只改那几个。
 */
function buildSkillRows(): void {
  /*
   * ⚠ 这一栏**必须写明它装的是术式**。
   *
   *   玩家 2026-09-21 报的第一条困惑就是这里：
   *   > 蓄斩不应该是术式吗？明明是两个技能组成的技能，为什么当成单独的技能了？
   *
   *   因为这一栏以前**没有标题**，而底下那行提示写的是「1~5 放技能」——
   *   于是一列名字（蓄斩、灵光盾…）看下来就像"一堆技能"。
   *   它们是**术式**：每一个由若干技能组起来（所以才能一个蓄斩 = 飞弹 + 裂地斩）。
   */
  const parts: string[] = [
    '<div class="dim" style="margin-bottom:4px">术式栏（<span class="key">1</span>~<span class="key">0</span> 按顺序）'
    + ' · <span class="key">左键</span> 是手上武器那套</div>',
  ]
  /*
   * ⚠ 这一栏按**玩家排的**（`savedLoadout`）画，不按引擎里活下来的那份（`loadout`）。
   *
   *   两份不一样的时候，正是玩家最需要解释的时候：他刚把一份术式绑到键上，
   *   而那份术式**放不出来**（空壳 / 编译不出来）—— 引擎那边它根本不存在，
   *   所以 `loadout` 里没有它。按 `loadout` 画的话，那一格**凭空消失**，
   *   玩家看到的是"编辑器说装好了、游戏里没有"（玩家 2026-09-21 报的就是这个）。
   *
   *   现在：那一格照画，后面标明**为什么放不出来**。
   */
  const rows = savedLoadout.length > 0 ? savedLoadout : loadout
  rows.forEach((id, i) => {
    const t = library.get(id)
    const probs = techniqueProblems.get(id)
    const name = t?.name ?? mine.get(id)?.name ?? id
    /*
     * 按键上绑的是**术式**，释放的也是术式 —— 它由若干技能组起来。
     * 只有一个技能时不写，多于一个时把技能链列出来：
     * 玩家得看得见"这一下其实是两招接起来的"。
     */
    const chain = t !== undefined && t.skillIds.length > 1
      ? ` <span class="dim">${t.skillIds.map(sid => skills.get(sid)?.name ?? sid).join('→')}</span>`
      : ''
    const broken = probs === undefined
      ? ''
      : `<span class="dim" style="color:#f85149" title="${esc(probs.join('；'))}">`
        + `　⚠ 放不出来：${esc(probs[0] ?? '')}</span>`
    parts.push(
      `<div data-hud-row="${esc(id)}">`
      + `<span class="key">${CAST_KEYS[i]}</span>${esc(name)}`
      + '<span data-hud-state></span>'
      + '<span data-hud-cd></span>'
      + '<span data-hud-pact></span>'
      + chain
      + broken
      + '</div>')
  })
  skillsEl.innerHTML = parts.join('')

  // 查回每个可变的 span。查不到（假 DOM / 还没渲染）就是 null，更新时跳过
  skillRefs = []
  for (const el of skillsEl.querySelectorAll<HTMLElement>('[data-hud-row]')) {
    skillRefs.push({
      id: el.dataset['hudRow'] ?? '',
      root: el,
      cd: el.querySelector<HTMLElement>('[data-hud-cd]'),
      pact: el.querySelector<HTMLElement>('[data-hud-pact]'),
    })
  }
}

/** 身上那串状态。集合变了才重建 —— 剩余时长每帧都在变，不能进签名 */
function buildStatusRows(): void {
  skillsEl.querySelector('[data-hud-status]')?.remove()

  if (player.statuses.length === 0) {
    statusDurRefs = []
    return
  }

  const block = document.createElement('div')
  block.setAttribute('data-hud-status', '')
  const parts: string[] = ['<div class="dim" style="margin-top:6px">身上：</div>']
  for (const s of player.statuses) {
    const dim = s.tags.includes('debuff') || s.tags.includes('cooldown')
    /*
     * ⚠ 状态行要能**看说明**（玩家 2026-09-21 记的待办）：
     *   > "司命负重"这种状态应该有鼠标移动到其上显示说明的功能。
     *
     *   说明是**从数据生成的**（`describeStatus`），不是手写的一句话 ——
     *   手写的会跟着数值漂移，而这条状态正好是"移速 -20%、持续 10 秒"那种
     *   数值一旦改了就得跟着变的。
     *
     * ⚠ `title` 也写上：自画的浮层负责好看，`title` 负责**兜底**
     *   （触屏、无障碍、浮层没渲染出来的情况）。
     */
    const tip = statusTipOf(s.defId)
    parts.push(`<div data-hud-status-row="${esc(s.defId)}" style="color:${dim ? '#6e7681' : '#3fb950'}"`
      + ` title="${esc(tip)}">`
      + `· ${esc(s.name)}　<span data-hud-dur></span>`
      + `<span class="status-tip">${esc(tip)}</span></div>`)
  }
  block.innerHTML = parts.join('')

  skillsEl.appendChild(block)

  statusDurRefs = []
  for (const el of block.querySelectorAll<HTMLElement>('[data-hud-status-row]')) {
    const dur = el.querySelector<HTMLElement>('[data-hud-dur]')
    if (dur !== null) statusDurRefs.push({ el: dur, defId: el.dataset['hudStatusRow'] ?? '' })
  }
}

/**
 * 一个状态的说明 —— 鼠标移上去看的就是它。
 *
 * 文字是 `describeStatusTip` 生成的（在 `src/describe.ts` 里，有测试盯着）；
 * 这里只管"从世界里的状态表捞出定义"，拿不到时给一句人话，**不要吐 id**。
 */
function statusTipOf(defId: string): string {
  const def = world.statusDefs.get(defId)
  if (def === undefined) return '这个状态在当前内容里找不到定义'
  return describeStatusTip(def)
}

/** 状态集合的签名：只放"有哪些状态、各几层"，不放剩余时间 */
function statusSignature(): string {
  return player.statuses.map(s => `${s.defId}:${s.stacks}`).sort().join('|')
}

function updateHud(): void {
  if (statRefs === undefined) buildStats()
  const refs = statRefs

  const hpMax = resolveAttribute(player, 'char.hp.max', { world, self: player })
  const hp = getStored(player, 'char.hp.current')
  const enMax = resolveAttribute(player, 'char.energy.max', { world, self: player })
  const en = getStored(player, 'char.energy.current')
  const pact = bloodPactOf(player)

  const alive = world.entities.filter(e => e.alive && factionOf(e) === 'enemy').length

  /*
   * 分母也要从场景来。
   *
   * ⚠ 以前这里写的是常量 FOE_COUNT = 3。阵容搬进场景之后那个常量就是错的 ——
   *   duel 只有 2 个敌人、兜底场景只有 1 个，界面会显示"1 / 3"，
   *   看起来像还有两个没死。
   */
  const total = world.entities.filter(e => factionOf(e) === 'enemy').length

  // 出结果的时候，界面上必须有明确的一行 —— 不然玩家不知道自己已经输了
  const verdict = !player.alive
    ? '你死了 —— 按 R 重开本关（血契留着）/ N 新的一局'
    : alive === 0 && total > 0
      ? '全部清掉了 —— 按 R 重开本关（血契留着）/ N 新的一局'
      : ''

  if (refs !== undefined) {
    refs.hp.textContent = hp.toFixed(0)
    refs.hp.style.color = hp / hpMax < 0.3 ? '#f85149' : '#3fb950'
    refs.hpMax.textContent = hpMax.toFixed(0)
    refs.en.textContent = en.toFixed(0)
    refs.enMax.textContent = enMax.toFixed(0)
    /*
     * ⚠ 血契要**一直显示**，哪怕还是 0。
     *   它是"攒出来的资本"，玩家必须能随时回答"我现在够放那个大招了吗"。
     *   只在非 0 时显示的话，攒的过程就是不可见的 —— 那这个机制就不存在了。
     */
    refs.pact.textContent = pact.toFixed(1)
    refs.pact.style.color = pact > 0 ? '#c678dd' : '#6e7681'
    /*
     * ⚠ 武器那一行要把**关键参数**写出来，不只是名字。
     *   "铁剑"和"长剑"这两个名字本身不说明任何事 ——
     *   玩家换了武器之后手上到底变强了多少，得能看见（伤害 ×0.8 → ×1.1）。
     */
    const w = player.weapon
    /*
     * ⚠ 连段进度也要写出来（`下一刀 2/2`）。
     *   序列是**看不见的状态**：不显示的话，玩家只能靠"这一刀好像不一样"
     *   去猜自己走到第几段了 —— 而超时回第一条会让这个猜测变得更难。
     */
    const wDef = w === undefined ? undefined : weaponDefs.get(w.id)
    const wTech = wDef?.weaponTechnique === undefined ? undefined : library.get(wDef.weaponTechnique)
    const segCount = (wTech?.segments ?? []).length
    const seg = segCount > 1 && player.chain !== undefined && player.chain.techniqueId === wTech?.id
      ? `　下一刀 ${(player.chain.next % segCount) + 1}/${segCount}`
      : ''
    refs.weapon.textContent = w === undefined
      ? '空手'
      : `${w.name}（伤害 ×${(w.attributes['weapon.damage'] ?? 1).toFixed(2)}`
        + `　射程 ${(w.attributes['weapon.reach'] ?? 2.5).toFixed(1)} 米`
        + `　攻速 ×${(w.attributes['weapon.windup'] ?? 1).toFixed(2)}）${seg}`
    refs.weapon.style.color = w === undefined ? '#6e7681' : '#e3b341'
    refs.tick.textContent = String(world.tick)
    refs.foes.textContent = `${alive} / ${total}`
    refs.hitstop.textContent = world.hitstop > 0 ? '　顿帧' : ''
    refs.pausedRow.textContent = paused ? '⏸ 已暂停 —— 空格继续' : ''
    refs.verdictRow.textContent = verdict
    refs.verdictRow.style.color = player.alive ? '#3fb950' : '#f85149'
  }

  // ---- 技能栏：栏变了才重建结构 ----
  const sig = loadout.join('|')
  if (sig !== skillSig) {
    skillSig = sig
    buildSkillRows()
  }

  /*
   * ⚠ 每帧真正在变的是这三样：
   *     冷却读秒 / 这一格能不能按（冷却 + 血契够不够）/ 还差多少血契
   *   以前它们是被"整块重写"顺带带出来的，现在必须显式落地。
   *   `skillRefs` 在假 DOM 里是空的，那时这些更新就是空操作 —— 不报错。
   */
  for (const row of skillRefs) {
    const t = library.get(row.id)
    if (t === undefined) continue

    /*
     * ⚠ 能不能按，要问**下一段**，不是问容器自己。
     *
     *   序列术式的冷却在每一段上（`cd.<那一段的术式id>`），容器自己没有冷却 ——
     *   盯着容器看的话，界面会一直显示可放，按下去却什么都不发生。
     *   `peekSequence` 就是"按一下会发生什么"的预判（无副作用）。
     *
     * ⚠ 段数读的是**编译产物的** `segments`（不是 `t.sequences`）：
     *   控制器里现在只有编译产物（`library` 里是它），
     *   而且老形状的段也在 `segments` 里各占一项 —— 数字才对得起来。
     */
    const peek = peekSequence(world, player, t)
    const seqCount = (t.segments ?? []).length
    const cd = getStored(player, 'cd.' + row.id)
    const cost = t.bloodPactCost
    const have = bloodPactOf(player)
    const affordable = cost <= 0 || have >= cost
    const usable = peek.reason === undefined && cd <= 0 && affordable

    if (row.cd !== null) {
      /*
       * 序列术式那一格写的是**连段进度**（"第 2/2 段"）——
       * 那是玩家唯一能看见"我现在按下去会出哪一段"的地方。
       * 下一段在冷却里就明说，别让他按了没反应还不知道为什么。
       */
      row.cd.textContent = seqCount > 0
        ? (peek.reason === 'cooldown' ? ' 下一段冷却中' : ` 第 ${peek.index + 1}/${seqCount} 段`)
        : cd <= 0 ? '' : ` ${cd.toFixed(1)}s`
      row.cd.style.color = peek.reason === 'cooldown' ? '#f85149' : '#d29922'
    }
    if (row.pact !== null) {
      /*
       * ⚠ **负值术式**那一格要单独标出来，而且要标"现在还差多少"。
       *
       *   这是整个机制可见性的全部：玩家要能一眼看出
       *   "这一格现在放不了，因为我只有 4 点血契而它要 7.18"。
       *   只说"放不出来"的话，玩家不知道是缺什么、还得攒多久 ——
       *   而"攒"正是这个机制的核心动作。
       */
      row.pact.textContent = cost > 0
        ? ` 血契 ${cost.toFixed(1)}${affordable ? '' : `（还差 ${(cost - have).toFixed(1)}）`}`
        : ''
      row.pact.style.color = affordable ? '#c678dd' : '#f85149'
    }
    /*
     * 放不了的那一格整行变暗 —— 只改 class，**不动结构**。
     * 这正是"每帧重建"做不到的事：重建之后元素是新的，
     * hover 状态、CSS transition、焦点全都丢了。
     */
    if (row.root !== null) row.root.classList.toggle('dim', !usable)
  }

  // ---- 身上那串状态：集合变了才重建，剩余时长就地改 ----
  const sSig = statusSignature()
  if (sSig !== statusSig) {
    statusSig = sSig
    buildStatusRows()
  }
  for (const r of statusDurRefs) {
    const s = player.statuses.find(x => x.defId === r.defId)
    if (s === undefined) continue
    r.el.textContent = s.remaining < 0 ? '永久' : `${s.remaining.toFixed(1)}s`
  }
}

boot().catch(err => {
  statsEl.innerHTML = `<span style="color:#f85149">加载失败：${String(err)}</span>`
  console.error(err)
})
