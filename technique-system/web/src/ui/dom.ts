/**
 * 编辑器用的 DOM 小工具。
 *
 * ## 它要解决的问题
 *
 * 两个编辑器现在的做法是"**一有变化就把整块 `innerHTML` 重写一遍**"。
 * 这在"只是看看"的时候没毛病，但会砸掉三样东西：
 *
 *   1. **输入框的焦点和光标** —— 你正在改名字 / 拖滑块，一重画就没了
 *   2. **过渡和动效** —— 元素被换掉了，CSS transition 从头开始（或者说根本没得开始）
 *   3. **悬停 / 展开状态**（`<details open>` 这种）
 *   4. **滚动位置** —— 你往下滚了之后点一格，页面弹回最上面
 *      （玩家实测报的就是它：滚动位置住在**被换掉的那个元素**身上）
 *      ⚠ 修法和第 1 条是同一对：`captureScroll` / `restoreScroll`
 *
 * ⚠ 玩家 2026-09-21 要自己写 UI，而"整块重写"是那件事的**真正前提**：
 *   结构不稳，任何布局/动效都立不住。
 *
 * ## 分两步走（这一步是第一步）
 *
 * - **第一步（这个文件）**：把"重画"变成"**没变的东西不碰**" + 光标能接回来
 * - **第二步（后面）**：每一块拆成"结构 + 数值"两半，数值走 `data-*` 查回来单独写
 *   （HUD 已经是这个形状：`buildStats()` 建一次，之后只改那几个 `data-hud-*`）
 *
 * ## ⚠ 为什么这里只写"最小结构类型"，不用 `HTMLElement` / `Element`
 *
 * 这个文件被 `tests/web.ts` 直接 import，于是它同时被**两个工程**编译：
 *
 *   · `tsconfig.web.json`（有 DOM 类型）
 *   · 根 `tsconfig.json` —— **故意没有 DOM 类型**：引擎那侧是 headless 的，
 *     "类型层面拿不到 window/document" 是一道额外的栅栏
 *
 * 所以这里只用"我实际会用到的那几个方法"的形状（`ElLike`），两个工程都能编译，
 * 那道栅栏也不用为了一个工具函数拆掉。
 */

/**
 * 只用到这几个能力的最小形状 —— 真的 DOM 元素和假 DOM 都满足它。
 *
 * ⚠ 全部写成**方法签名**（`contains?(other: unknown): boolean`）而不是属性加函数类型
 *   （`contains?: (other: unknown) => boolean`）：后者在 `strictFunctionTypes` 下是
 *   **参数逆变**的，而真 DOM 的 `contains(other: Node | null)` 参数更窄 → 不兼容 ✗。
 *   方法签名在 TypeScript 里是双变的，两边都能对上。
 */
export interface ElLike {
  getAttribute?(name: string): string | null
  contains?(other: unknown): boolean
  querySelector?(selector: string): unknown
  ownerDocument?: {
    activeElement?: unknown
    createElement?(tag: string): ElLike
  } | null
  focus?(): void
  setSelectionRange?(start: number, end: number): void
  selectionStart?: number | null
  selectionEnd?: number | null
  /**
   * ⚠ 这两个是**普通属性**（`scrollTop` / `scrollLeft`），不是方法。
   *   真 DOM 上它们可读可写；`tests/web.ts` 的假 DOM 上同样是普通字段
   *   ⇒ "重渲染前后一样吗"在假 DOM 上也能断言（见 `captureScroll`）。
   */
  scrollTop?: number
  scrollLeft?: number
  /**
   * `captureScroll` 用它一次拿全所有带 `data-scroll` 的容器。
   *
   * ⚠ 方法签名（不是属性加函数类型），理由和 `contains` 一样（参数逆变）。
   *   形参写成 `string`：真 DOM 的 `querySelectorAll<K extends keyof HTMLElementTagNameMap>`
   *   在方法双变下能对上，而假 DOM 那个 `(s: string) => FEl[]` 也对得上。
   */
  querySelectorAll?(selector: string): ArrayLike<unknown>
  innerHTML?: string
  firstElementChild?: unknown
  replaceWith?(el: unknown): void
  appendChild?(el: unknown): void
}

/** 重画前记下来的焦点/光标位置。查不回来就是 undefined */
export interface FocusState {
  /** `data-act` 的值（编辑器里所有可交互元素都有它） */
  act: string
  /** 这三个是同一个元素上用来区分"哪一个"的下标（列表里的输入框用） */
  i?: string
  l?: string
  c?: string
  /** 文本类控件的选区；别的控件是 null */
  start: number | null
  end: number | null
}

function keyOf(el: ElLike): FocusState | undefined {
  const act = el.getAttribute?.('data-act') ?? null
  if (act === null || act === '') return undefined
  const state: FocusState = { act, start: null, end: null }
  for (const attr of ['i', 'l', 'c'] as const) {
    const v = el.getAttribute?.(`data-${attr}`) ?? null
    if (v !== null) state[attr] = v
  }
  return state
}

/**
 * 记下"现在焦点在哪、光标在第几个字"。
 *
 * ⚠ 全部走"能用就用"的写法，**不抛**。两个理由：
 *   1. 测试用的是假 DOM（`tests/web.ts` 那个 stub），它没有 `ownerDocument.activeElement`
 *      —— 一个"把光标接回来"的小工具把整个 boot 炸掉，报出来的却是"客户端加载失败"，
 *      35 个断言一起红，真因藏在最里面。**这个坑真的踩过**（有回归测试盯着了）
 *   2. 真实浏览器里"焦点不在编辑器里"是正常状态，不是错误
 *
 * ⚠ 只认带 `data-act` 的元素 —— 编辑器里所有输入控件都有它（那本来就是事件的钩子），
 *   所以不用另加标记。
 */
export function captureFocus(root: ElLike): FocusState | undefined {
  const doc = root.ownerDocument ?? undefined
  const active = (doc?.activeElement ?? null) as ElLike | null
  if (active === null || active === undefined) return undefined
  if (root.contains?.(active) !== true) return undefined

  const state = keyOf(active)
  if (state === undefined) return undefined

  if (typeof active.selectionStart === 'number') {
    state.start = active.selectionStart
    state.end = active.selectionEnd ?? active.selectionStart
  }
  return state
}

/** 把焦点和光标放回去。找不到那个元素就什么都不做（别抛） */
export function restoreFocus(root: ElLike, state: FocusState | undefined): void {
  if (state === undefined) return
  const sel = `[data-act="${state.act}"]`
    + (state.i === undefined ? '' : `[data-i="${state.i}"]`)
    + (state.l === undefined ? '' : `[data-l="${state.l}"]`)
    + (state.c === undefined ? '' : `[data-c="${state.c}"]`)

  const found = root.querySelector?.(sel) ?? null
  const el = found as ElLike | null
  if (el === null || el === undefined) return

  try {
    el.focus?.()
    if (state.start !== null && typeof el.setSelectionRange === 'function') {
      el.setSelectionRange(state.start, state.end ?? state.start)
    }
  } catch {
    // 不可聚焦的元素 —— 这不是错误
  }
}

// ============================================================================
//  滚动位置（和上面那对 focus 是**同一个道理、同一个坑**）
// ============================================================================

/**
 * 重画前记下来的滚动位置。查不回来就是空数组。
 *
 * ⚠ `key` 就是容器上 `data-scroll` 的值（我们自己的**稳定名字**，
 *   不是类名 / 下标）—— 见 `captureScroll` 的说明。
 */
export interface ScrollState {
  key: string
  top: number
  left: number
}

/** 取 `data-scroll`；没有就返回 null（**空字符串也算没有**：拿它当名字查不回来） */
function scrollKeyOf(el: ElLike): string | null {
  const k = el.getAttribute?.('data-scroll') ?? null
  return k === null || k === '' ? null : k
}

/**
 * 找出根下所有"要保住滚动位置的容器"。
 *
 * ⚠ 全部走"能用就用"的写法，**不抛** —— 理由和 `captureFocus` 一样：
 *   假 DOM / 真实浏览器里都可能没有 `querySelectorAll`，
 *   而"一个记录滚动位置的小工具把整个 boot 炸掉"报出来的会是
 *   "客户端加载失败"，35 个断言一起红，真因藏在最里面。
 */
function scrollContainers(root: ElLike): ElLike[] {
  const all = (root as { querySelectorAll?: (sel: string) => ArrayLike<unknown> }).querySelectorAll
  if (typeof all === 'function') {
    return Array.from(all.call(root, '[data-scroll]') as ArrayLike<unknown>) as ElLike[]
  }
  // 退路：只有 querySelector 时也至少把第一个找回来
  const one = root.querySelector?.('[data-scroll]')
  return one === null || one === undefined ? [] : [one as ElLike]
}

/**
 * 记下"现在这几个滚动容器各滚到哪儿了"。
 *
 * ## 它解决的问题
 *
 * 两个编辑器的重画是"**整块 `innerHTML` 重写 / 换掉整块 DOM**"，
 * 而滚动位置**住在被换掉的那个元素身上** —— 于是"往下滚了之后点一格"，
 * 新造出来的容器 `scrollTop` 是 0 ⇒ **页面弹回最上面**。
 *
 * 这和焦点是**同一类事故**（状态住在被销毁的节点上），所以修法也照抄
 * `captureFocus` / `restoreFocus` 那一对：**重画前记、重画后放回去**。
 * ⚠ **不许**用"点完再 `scrollTo(0)`"那种糊法：滚的是哪一个容器、
 *   用户滚到了哪儿，只有记下来才知道 —— 事后猜不出来。
 *
 * ## ⚠ 为什么用 `data-scroll` 而不是 `.sk-libbody` / `#editorBody`
 *
 * 类名会随改版漂（技能页那一段就改过一次），id 是全局唯一的、
 * 而"同一个容器在不同屏里"未必唯一。`data-scroll` 是**我们给这个容器起的名字**：
 * 容器重建之后名字还在，所以查得到**同一个**容器。
 *   · `editorBody` / `techBody` 住在 `index.html`（不重画）⇒ 名字写在标签上
 *   · 技能库 / 术式页里那些由模板生成的容器 ⇒ 名字写在模板里
 *
 * ⚠ 只认带标记的元素：没标记的容器说明**它不在重画路径上**，
 *   给它乱记反而是多余的噪声。
 */
export function captureScroll(root: ElLike): ScrollState[] {
  const out: ScrollState[] = []
  for (const el of scrollContainers(root)) {
    const key = scrollKeyOf(el)
    if (key === null) continue
    out.push({
      key,
      top: typeof el.scrollTop === 'number' ? el.scrollTop : 0,
      left: typeof el.scrollLeft === 'number' ? el.scrollLeft : 0,
    })
  }
  return out
}

/**
 * 把滚动位置放回去。
 *
 * ⚠ 按**名字**找容器（不是按下标）：重画之后容器少了一个 / 换了顺序，
 *   按下标会把 B 的位置写给 A —— 那比"弹回最上面"更难查（页面上看起来
 *   是"我明明滚的是左边那一栏，结果右边跳了"）。
 *
 * ⚠ 位置是 0 的**跳过不写**：新容器本来就是 0，写它等于碰一次 DOM
 *   （而那正是 `<details open>` / CSS transition 被砸掉的路径）。
 */
export function restoreScroll(root: ElLike, state: readonly ScrollState[]): void {
  for (const s of state) {
    const found = root.querySelector?.(`[data-scroll="${s.key}"]`) ?? null
    const el = found as ElLike | null
    if (el === null || el === undefined) continue
    if (s.top !== 0 && el.scrollTop !== s.top) el.scrollTop = s.top
    if (s.left !== 0 && el.scrollLeft !== s.left) el.scrollLeft = s.left
  }
}

/**
 * "结构没变就别重建"：按 key 记住上一次的 html，一样就原样留着。
 *
 * ⚠ 这是第二步的雏形，先给**独立的子块**用（账那一块、技能列表那一块）。
 *   整页那种"几十个控件耦合在一起"的，要等拆成"结构 + 数值"两半之后才好用
 *   （现在还是拼一大串 html 一次写进去，一串里一个字变了整串都得重建）。
 *
 * ⚠ 拿不到 `document` 时**直接 throw**：这是**写入**路径，
 *   悄悄什么都不做会让界面停在旧内容上 —— 那种 bug 比抛出来难查得多。
 */
const blockCache = new WeakMap<object, Map<string, { html: string; el: ElLike }>>()
/**
 * 假 DOM 的降级缓冲。
 *
 * ⚠ 测试用的假 DOM **不会解析 html**（`innerHTML` 在它那儿就是个字符串，
 *   没有 `firstElementChild`）—— 也就是说"挂块"这件事在它那儿根本做不到。
 *   硬抛的后果是整个 boot 炸掉、报出来却是"客户端加载失败"（这个坑踩过一次了）。
 *
 *   所以降级成"**把 html 攒起来，这一轮结束时一次性写上**"：
 *   测试仍然能按文字/选择器断言（它本来就只读 `innerHTML` 字符串），
 *   而真实浏览器走的是上面那条挂块的路。
 */
const fakeBuffer = new WeakMap<object, string[]>()

function cacheOf(host: ElLike): Map<string, { html: string; el: ElLike }> {
  const key = host as object
  let per = blockCache.get(key)
  if (per === undefined) {
    per = new Map()
    blockCache.set(key, per)
  }
  return per
}

/** 拿不到可解析的 DOM 时，把 html 攒进缓冲区（由 `endBlocks` 收尾） */
function bufferInstead(host: ElLike, html: string): ElLike {
  const key = host as object
  const list = fakeBuffer.get(key) ?? []
  list.push(html)
  fakeBuffer.set(key, list)
  return host
}

export function patchBlock(host: ElLike, key: string, html: string): ElLike {
  const per = cacheOf(host)
  const hit = per.get(key)
  if (hit !== undefined && hit.html === html && host.contains?.(hit.el) === true) return hit.el

  const doc = host.ownerDocument ?? undefined
  if (doc?.createElement === undefined) throw new Error('patchBlock：拿不到 document')

  const holder = doc.createElement('div')
  holder.innerHTML = html
  const el = holder.firstElementChild as ElLike | null | undefined
  if (el === null || el === undefined) throw new Error(`patchBlock("${key}") 的 html 里没有元素`)

  if (hit !== undefined && host.contains?.(hit.el) === true) hit.el.replaceWith?.(el)
  else host.appendChild?.(el)

  per.set(key, { html, el })
  return el
}

/**
 * **挂一块**：这是"结构固定"的真正入口。
 *
 * 和 `patchBlock` 的区别：它给块打上 `data-block="<key>"`，
 * 于是下一次能找到**同一块**（不管是替换还是原样留着）。
 *
 * ⚠ 模板函数**不用自己写 `data-block`** —— 这里会替你加上。
 *   理由很实际：你改布局时会重写那段 html，很容易把属性漏掉；
 *   漏掉的后果是"每次重画都多出一块"（越堆越多），而且很难看出是为什么。
 *
 * ⚠ 块的内容**一模一样时不碰 DOM** —— `<details open>` 的展开状态、
 *   CSS transition、正在进行的拖拽，全靠这一条活着。
 */
export function mountBlock(host: ElLike, key: string, html: string): ElLike {
  const per = cacheOf(host)
  const hit = per.get(key)

  // 老的那块还在，而且这次的 html 和上次一模一样 → 一个字都不动
  if (hit !== undefined && hit.html === html && host.contains?.(hit.el) === true) return hit.el

  const doc = host.ownerDocument ?? undefined
  if (doc?.createElement === undefined) return bufferInstead(host, html)

  const holder = doc.createElement('div')
  holder.innerHTML = html
  const el = holder.firstElementChild as (ElLike & { setAttribute?: (k: string, v: string) => void })
    | null | undefined

  /*
   * ⚠ 解析不出元素 = 这不是真 DOM（测试的假 DOM 里 `innerHTML` 只是个字符串）。
   *   这时候**降级**成"攒起来，这一轮结束时一次性写上"，而不是抛：
   *   抛的后果是整个 boot 炸掉、报出来却是"客户端加载失败"（踩过）。
   *   ⚠ 这里**不做探测**（不去先造一个试一下）—— 那会在假 DOM 上多造一个元素，
   *     让"造了几个"这种断言变得没法写。
   */
  if (el === null || el === undefined) return bufferInstead(host, html)

  el.setAttribute?.('data-block', key)

  if (hit !== undefined && host.contains?.(hit.el) === true) hit.el.replaceWith?.(el)
  else host.appendChild?.(el)

  per.set(key, { html, el })
  return el
}

/**
 * 挂完这一轮之后，把**这次没挂的块**删掉（列表变短了、某一块条件性地存在）。
 *
 * ⚠ 必须在挂完所有块之后调一次 —— 不调的话"上一次有、这一次没有"的块会留在页面上，
 *   而那正是最烦的一种 bug：界面上有个东西，但它不属于当前状态。
 *
 * ⚠ 假 DOM 那条路里，这个函数还负责**把攒下来的 html 一次性写上**（见 `fakeBuffer`）。
 */
export function endBlocks(host: ElLike, keys: readonly string[]): void {
  const buffered = fakeBuffer.get(host as object)
  if (buffered !== undefined) {
    host.innerHTML = buffered.join('')
    fakeBuffer.delete(host as object)
    return
  }

  const per = cacheOf(host)
  const alive = new Set(keys)
  for (const [key, hit] of [...per]) {
    if (alive.has(key)) continue
    const el = hit.el as { remove?: () => void }
    el.remove?.()
    per.delete(key)
  }
}

/**
 * **只改数值，不动结构**：把 `data-v="名字"` 的元素的文字换成新值。
 *
 * ⚠ 一样就不写 —— 这是"不砸拖拽/动效"的关键：
 *   给 `textContent` 赋一个相同的值，浏览器照样会标脏那一块。
 */
export function applyValues(root: ElLike, values: Readonly<Record<string, string>>): void {
  const all = (root as { querySelectorAll?: (sel: string) => ArrayLike<unknown> }).querySelectorAll
  if (typeof all !== 'function') return

  for (const raw of Array.from(all.call(root, '[data-v]') as ArrayLike<unknown>)) {
    const el = raw as { getAttribute?: (k: string) => string | null; textContent?: string | null }
    const name = el.getAttribute?.('data-v') ?? null
    if (name === null) continue
    const next = values[name]
    if (next === undefined) continue
    if (el.textContent !== next) el.textContent = next
  }
}
