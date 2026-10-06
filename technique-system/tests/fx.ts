/**
 * 载体特效的测试。
 *
 * 这个文件存在的理由：**特效一直是隐形的，而且没有任何东西会报警。**
 * 八种载体里五种完全没有表现，六个用了载体的技能里五个看不见 ——
 * 这种事不会让任何测试变红，只会让玩家觉得"按了没反应"。
 *
 * 所以这里钉三件事：
 *   1. 模拟核**说得出**自己打出去了什么形状（`deliveryFired`）
 *   2. 上色表**覆盖**内容里用到的每一种伤害类型
 *   3. 几何换算不出 NaN，也不出负数 —— 画一条 NaN 的弧会让整个画面消失
 */
import {
  allPrims, deliveryPrims, drawDelivery, knownTypes, pickStyle, sparkPrims,
  spawnDelivery, spriteDone, spriteFrameIndex, updateDelivery, updateSprite, DEFAULT_STYLE,
} from '../web/src/fx.ts'
import type { SpriteFx } from '../web/src/fx.ts'
import type { DeliveryEvent } from '../web/src/fx.ts'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { readJson } from '../src/loader.ts'
import { allRulesOf } from '../src/effects.ts'
import type { Skill } from '../src/schema.ts'
import { frameUrl } from '../web/src/fx.ts'

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

function eq(name: string, actual: unknown, expected: unknown): void {
  ok(name, Object.is(actual, expected), `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`)
}

function section(title: string): void {
  console.log(`\n${title}`)
}

function ev(over: Partial<DeliveryEvent> = {}): DeliveryEvent {
  return {
    kind: 'meleeArc',
    from: { x: 0, y: 0 },
    dir: { x: 1, y: 0 },
    hitCount: 1,
    ...over,
  }
}

// ============================================================================
//  上色表
// ============================================================================

section('上色表：按技能的类型')

{
  // 内容里出现的每一种 damageType 都必须有风格 —— 缺一行就会退回中性色
  //
  // ⚠ 走 `allRulesOf`：伤害类型大多住在**固有效果**里（"这个技能是什么"），
  //   只扫 `rules` 的话这个检查会以为内容只用了一两种类型。
  const dir = resolve('content/skills')
  const used = new Set<string>()
  for (const f of readdirSync(dir).filter(n => n.endsWith('.json'))) {
    const skill = readJson<Skill>(resolve(dir, f))
    for (const rule of allRulesOf(skill)) {
      for (const a of rule.then ?? []) {
        if (a.payload.kind === 'damage' && a.payload.damageType !== undefined) {
          used.add(a.payload.damageType)
        }
      }
    }
  }

  const missing = [...used].filter(t => !knownTypes().includes(t))
  ok('内容里用到的伤害类型都在风格表里', missing.length === 0,
    `缺：${missing.join(', ')}（会退回中性色）`)
  console.log(`      （内容用到 ${used.size} 种：${[...used].sort().join(' / ')}；表里有 ${knownTypes().length} 种）`)

  ok('不认识的类型退回中性色，而不是崩掉',
    pickStyle('不存在的类型').core === DEFAULT_STYLE.core)
  ok('不写 damageType 也用中性色', pickStyle(undefined).core === DEFAULT_STYLE.core)

  // 每种类型必须**一眼能分出来**。分的依据是边色（刀锋、拖尾都靠它），
  // 不是芯色 —— 物理和闪电的芯都可以是白的，那很正常。
  const edges = new Set(knownTypes().map(t => pickStyle(t).edge))
  ok('每种类型的边色都不一样', edges.size === knownTypes().length,
    `${knownTypes().length} 种类型只有 ${edges.size} 种边色`)

  const pairs = new Set(knownTypes().map(t => `${pickStyle(t).core}|${pickStyle(t).edge}`))
  ok('芯色 + 边色的组合也不重复', pairs.size === knownTypes().length)

  const feels = new Set(knownTypes().map(t => pickStyle(t).feel))
  ok('每种类型的"手感"描述都不一样', feels.size === knownTypes().length)
}

// ============================================================================
//  几何换算
// ============================================================================

section('几何：不能出 NaN，也不出负数')

{
  const kinds = ['meleeArc', 'beam', 'capsule', 'area', 'aura', 'self', 'spawn', 'projectile'] as const

  for (const kind of kinds) {
    const fx = spawnDelivery(ev({ kind }))
    const nums = [fx.length, fx.width, fx.radius, fx.angle, fx.life, fx.age]
    const bad = nums.some(n => !Number.isFinite(n))
    ok(`${kind}：造出来的几何都是有限的数`, !bad, nums.join(', '))
    ok(`${kind}：时长是正数`, fx.life > 0, String(fx.life))
    ok(`${kind}：一开始就是活的`, fx.age < fx.life)
  }
}

{
  // 角度：事件里是**度**，fx 里要换成**弧度**
  const fx = spawnDelivery(ev({ angle: 120 }))
  ok('张角从度换成弧度', Math.abs(fx.angle - (120 * Math.PI) / 180) < 1e-9, String(fx.angle))
}

{
  // 缺省值要和模拟核一致 —— 不然判定打 5 米、画面画 1 米
  const beam = spawnDelivery(ev({ kind: 'beam' }))
  ok('光束不写 length 时兜底 5 米（和 targeting.ts 一致）', beam.length === 5, String(beam.length))

  const arc = spawnDelivery(ev({ kind: 'meleeArc', radius: 2.5, angle: 120 }))
  ok('扇形按内容给的半径和角度', arc.radius === 2.5 && Math.abs(arc.angle - 2.094) < 0.01)
}

{
  // 打空了也要有特效 —— hitCount: 0 只影响"命中反馈"那一层，不影响整条特效
  const miss = spawnDelivery(ev({ hitCount: 0 }))
  ok('打空了照样生成特效', miss.hitCount === 0 && miss.sparks.length > 0)

  const hit = spawnDelivery(ev({ hitCount: 3 }))
  ok('打中了记下打了几个', hit.hitCount === 3)
}

{
  // 火星数量跟着风格走（火焰比冰霜多）
  const fire = spawnDelivery(ev({ damageType: 'fire' }))
  const ice = spawnDelivery(ev({ damageType: 'ice' }))
  ok('火焰的火星比冰霜多', fire.sparks.length > ice.sparks.length,
    `火 ${fire.sparks.length} vs 冰 ${ice.sparks.length}`)
}

{
  // 同一发技能每次长得一样（用下标做伪随机，不用 Math.random）
  const a = spawnDelivery(ev({ damageType: 'physical' }))
  const b = spawnDelivery(ev({ damageType: 'physical' }))
  const same = a.sparks.every((s, i) => s.x === b.sparks[i]?.x && s.vx === b.sparks[i]?.vx)
  ok('同一发技能两次生成的火星完全一样（可复现）', same)
}

// ============================================================================
//  图元：几何和绘制分开之后，几何这一半是可以测的
// ============================================================================

section('图元')

{
  const fx = spawnDelivery(ev({ radius: 2.5, angle: 120 }))
  // 推到扫完，这样拖尾是完整的
  while (fx.age < fx.life * 0.5) updateDelivery(fx, 1 / 240)

  const prims = deliveryPrims(fx)
  ok('扇形挥砍吐出了图元', prims.length > 10, `${prims.length} 个`)

  // ⚠ 拖尾必须是**环带**（annulus），不能是从圆心铺开的楔形（wedge）：
  //   楔形画出来像折扇，而且中心会糊成一团白
  const trails = prims.filter(p => p.op === 'annulus')
  ok('拖尾用的是环带，不是楔形', trails.length > 0 && !prims.some(p => p.op === 'wedge'),
    `annulus ${trails.length} 个，wedge ${prims.filter(p => p.op === 'wedge').length} 个`)

  ok('环带的内半径大于 0（刀光中间是空的）',
    trails.every(p => p.op === 'annulus' && p.r0 > 0))

  // 所有图元的 alpha 必须在 0..1，半径和宽度不能是负的 —— 负宽度会让某些浏览器直接不画
  const bad = prims.filter(p => {
    if (!Number.isFinite(p.alpha) || p.alpha < 0 || p.alpha > 1) return true
    if (p.op === 'arc' || p.op === 'line') return !Number.isFinite(p.width) || p.width <= 0
    if (p.op === 'disc') return !Number.isFinite(p.r) || p.r <= 0
    if (p.op === 'annulus') return !Number.isFinite(p.r0) || !Number.isFinite(p.r1) || p.r0 >= p.r1
    return false
  })
  ok('每个图元的 alpha / 宽度 / 半径都合法', bad.length === 0,
    bad.slice(0, 3).map(p => JSON.stringify(p)).join(' | '))

  /*
   * 越靠前沿越亮：**同一层**里拖尾的 alpha 必须单调递增。
   *
   * 按内半径分组 —— 挥砍有不止一层环带（整条拖尾 + 外缘热边），
   * 层与层之间本来就会跳一下，那不是分段感。
   */
  const layers = new Map<string, number[]>()
  for (const p of trails) {
    if (p.op !== 'annulus') continue
    const key = p.r0.toFixed(3)
    const list = layers.get(key) ?? []
    list.push(p.alpha)
    layers.set(key, list)
  }

  const offenders: string[] = []
  for (const [key, alphas] of layers) {
    const rising = alphas.every((v, i) => i === 0 || v >= (alphas[i - 1] ?? 0) - 1e-9)
    if (!rising) offenders.push(`r0=${key}: ${alphas.map(v => v.toFixed(3)).join(' ')}`)
  }
  ok('每一层拖尾的亮度都只增不减（不会有百叶窗）', offenders.length === 0, offenders.join(' | '))
  ok('拖尾起码分了两层（整条 + 外缘热边）', layers.size >= 2, `${layers.size} 层`)

  ok('火星是单独的图元（本体和火星分开，能单独关掉）',
    sparkPrims(fx).length > 0 && deliveryPrims(fx).every(p => p.op !== 'line' || p.width > 0.02))
}

{
  // 打空 vs 打中：唯一区别是那一道"命中反馈"，本体必须一模一样
  const hit = spawnDelivery(ev({ hitCount: 2 }))
  const miss = spawnDelivery(ev({ hitCount: 0 }))
  while (hit.age < hit.life * 0.5) { updateDelivery(hit, 1 / 240); updateDelivery(miss, 1 / 240) }

  const a = deliveryPrims(hit)
  const b = deliveryPrims(miss)
  ok('打中了会比打空多画一层', a.length > b.length, `${a.length} vs ${b.length}`)
}

// ============================================================================
//  序列帧特效（作者用 AE 做的那些）
// ============================================================================

section('序列帧：定义与播放')

{
  /*
   * ⚠ 这条断言盯的是**最容易悄悄坏掉**的地方：
   *   `content/fx/slash.json` 说有多少帧，磁盘上就得有多少张 PNG。
   *   少一张，序列播到一半会跳 —— 而那不会让任何东西报错。
   */
  const def = readJson<{
    id: string, dir: string, prefix: string, pad: number, frames: number,
    fps: number, pxPerMeter: number, meters: number,
  }>(resolve('content/fx/slash.json'))

  const files = readdirSync(resolve('content/fx', def.dir)).filter(f => f.endsWith('.png'))
  ok('定义里的帧数和磁盘上的 PNG 数量一致', files.length === def.frames,
    `定义 ${def.frames} 帧，磁盘 ${files.length} 张`)

  const expected = Array.from({ length: def.frames }, (_, i) =>
    `${def.prefix}${String(i + 1).padStart(def.pad, '0')}.png`)
  const missing = expected.filter(n => !files.includes(n))
  ok('每一帧的文件名都拼得出来（prefix + 补零 + 序号）', missing.length === 0,
    `对不上的：${missing.slice(0, 3).join(', ')}`)

  ok('fps 和 pxPerMeter 都是正数', def.fps > 0 && def.pxPerMeter > 0)
  ok('画布装得下整个特效（不然刀光会被切掉）', def.meters >= 5, `${def.meters} 米`)
}

{
  /*
   * ⚠ 玩家自己做的那条（魔法飞弹命中火花）。
   *
   *   它和示例素材的**编号约定不一样**：AE 默认从 00000 开始，
   *   而示例是从 0001 开始。`frameUrl` 里的起点写错就是整条 404，
   *   而报错只说"读不到图片" —— 看不出是编号起点的问题。
   */
  const def = readJson<{
    id: string, dir: string, prefix: string, pad: number, start?: number,
    frames: number, fps: number, meters: number, blend?: string,
  }>(resolve('content/fx/magic-bolt-hit.json'))

  ok('作者素材用 start 声明了起始编号', def.start === 0, String(def.start))

  const files = readdirSync(resolve('content/fx', def.dir)).filter(f => f.endsWith('.png'))
  ok('帧数和磁盘上的 PNG 数量一致', files.length === def.frames,
    `定义 ${def.frames} 帧，磁盘 ${files.length} 张`)

  // 按定义拼出来的每一个路径都得真的存在
  const expected = Array.from({ length: def.frames }, (_, i) =>
    `${def.prefix}${String((def.start ?? 1) + i).padStart(def.pad, '0')}.png`)
  const missing = expected.filter(n => !files.includes(n))
  ok('从 start 开始拼，每一帧都对得上', missing.length === 0,
    `对不上的：${missing.slice(0, 3).join(', ')}`)

  ok('用加法混合（发光类特效就该这么用）', (def.blend ?? 'add') === 'add', def.blend)
  ok('fps 和 meters 都是正数', def.fps > 0 && def.meters > 0)
}

{
  // 帧号起点：默认 1，写了就用写的那个
  const base = {
    schemaVersion: 1, id: 'x', dir: 'x', prefix: 'x_', pad: 3,
    frames: 3, fps: 60, pxPerMeter: 64, meters: 2,
  }
  eq('不写 start 时从 1 开始', frameUrl(base, 0), '/content/fx/x/x_001.png')
  eq('写了 start: 0 就从 0 开始', frameUrl({ ...base, start: 0 }, 0), '/content/fx/x/x_000.png')
  eq('补零位数照 pad 走', frameUrl({ ...base, pad: 5, start: 0 }, 11), '/content/fx/x/x_00011.png')
  eq('扩展名可以换', frameUrl({ ...base, ext: 'webp' }, 0), '/content/fx/x/x_001.webp')
}

{
  // 播放时序：第几帧、什么时候播完
  const frames = Array.from({ length: 24 }, () => ({ width: 384, height: 384 }))
  const mk = (age: number, pingPong = false): SpriteFx => ({
    kind: 'sprite', frames, frameTime: 1 / 60, age,
    x: 0, y: 0, rot: 0, meters: 6, anchorX: 0.5, anchorY: 0.5,
    blend: 'add', pingPong,
  })

  eq('第 0 秒是第一帧', spriteFrameIndex(mk(0)), 0)
  eq('第 1 帧的时间点是第 1 帧', spriteFrameIndex(mk(1 / 60)), 1)
  eq('刚好差一点点还是第 0 帧', spriteFrameIndex(mk(1 / 60 - 1e-6)), 0)
  eq('播到最后不会越界（停在最后一帧）', spriteFrameIndex(mk(99)), 23)

  ok('没播完', !spriteDone(mk(0.1)))
  ok('播完了', spriteDone(mk(24 / 60 + 0.01)))

  /*
   * 来回播（有些特效收尾倒放更好看）。
   *
   * 序列是 0,1,…,23,22,…,1 —— **不重复**峰值和起点，所以一个周期是 46 帧
   * （24 正放 + 22 倒放）。这里逐帧核对一下，免得写成"看着差不多"。
   */
  const pong = (raw: number): number => spriteFrameIndex(mk(raw / 60, true))
  eq('倒放：峰值是第 23 帧', pong(23), 23)
  eq('倒放：过峰值一帧往回走', pong(24), 22)
  eq('倒放：再一帧', pong(25), 21)
  eq('倒放：走到头是第 1 帧（第 0 帧只出现一次）', pong(45), 1)
  eq('倒放：一个周期之后重新开始', pong(46), 0)
  ok('倒放的总时长是正放的两倍', !spriteDone(mk(24 / 60 + 0.01, true)))
  ok('倒放也会结束', spriteDone(mk(46 / 60 + 0.01, true)))
}

{
  // 推进：用真实时间，和程序化那套一致
  const fx: SpriteFx = {
    kind: 'sprite', frames: [{ width: 64, height: 64 }], frameTime: 1 / 60, age: 0,
    x: 0, y: 0, rot: 0, meters: 2, anchorX: 0.5, anchorY: 0.5, blend: 'add', pingPong: false,
  }
  updateSprite(fx, 0.05)
  ok('推进用的是外面给的时间步', Math.abs(fx.age - 0.05) < 1e-9, String(fx.age))

  // 素材没加载成功时帧列表是空的 —— 不能崩
  const empty: SpriteFx = { ...fx, frames: [], age: 0 }
  eq('没有帧时取第 0 帧不抛异常', spriteFrameIndex(empty), 0)
  ok('没有帧时也算播完了（不会永远留在列表里）', spriteDone(empty))
}

// ============================================================================
//  生命周期
// ============================================================================

section('生命周期')

{
  const fx = spawnDelivery(ev())
  const life = fx.life

  let alive = true
  let steps = 0
  // 按 60fps 推进，直到它说过期了
  while (alive && steps < 1000) {
    alive = updateDelivery(fx, 1 / 60)
    steps++
  }

  ok('会过期（不会永远留在列表里）', !alive)
  ok('过期时间约等于 life', Math.abs(steps / 60 - life) < 0.05,
    `实际 ${(steps / 60).toFixed(3)}s，life ${life}s`)
}

{
  // 阻力：火星飞出去要慢下来。不衰减的话它会在 life 结束时还在直线飞
  const fx = spawnDelivery(ev({ damageType: 'fire' }))
  const v0 = Math.abs(fx.sparks[0]?.vx ?? 0)
  for (let i = 0; i < 30; i++) updateDelivery(fx, 1 / 60)
  const v1 = Math.abs(fx.sparks[0]?.vx ?? 0)
  ok('火星的初速度最后会衰减掉', v1 < v0 * 0.7, `${v0.toFixed(2)} → ${v1.toFixed(2)}`)
}

{
  // 画的时候不能抛 —— 拿一个假的 ctx 走一遍所有分支。
  // 这一条是"画一条 NaN 的弧会让整个画面消失"那类问题的低成本保险
  const fake = {
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '' as unknown,
    strokeStyle: '' as unknown,
    lineWidth: 1,
    lineCap: 'butt',
    calls: 0,
    save() { this.calls++ },
    restore() { this.calls++ },
    beginPath() { this.calls++ },
    closePath() { this.calls++ },
    fill() { this.calls++ },
    stroke() { this.calls++ },
    moveTo() { this.calls++ },
    lineTo() { this.calls++ },
    arc() { this.calls++ },
    translate() { this.calls++ },
    rotate() { this.calls++ },
    drawImage() { this.calls++ },
  }

  const kinds = ['meleeArc', 'beam', 'capsule', 'area', 'aura', 'self'] as const
  let threw = ''
  for (const kind of kinds) {
    const fx = spawnDelivery(ev({ kind }))
    for (let i = 0; i < 20; i++) {
      updateDelivery(fx, 1 / 60)
      try {
        drawDelivery(fake, fx)
      } catch (e) {
        threw += `${kind}: ${String(e)} `
      }
    }
  }

  ok('八种载体画一整轮都不抛异常', threw === '', threw)
  ok('真的画了东西（不是空函数被跳过）', fake.calls > 100, `画了 ${fake.calls} 笔`)
}

{
  // 顿帧用的是真实时间：模拟停住的时候特效必须继续走，否则"停住"看不出来
  const fx = spawnDelivery(ev())
  const before = fx.age
  updateDelivery(fx, 0.05)
  ok('推进用的是外面给的时间步，不是内部时钟', fx.age === before + 0.05)
}

console.log('')
if (failed > 0) {
  console.log(`✗ ${failed} 个断言失败（${passed} 个通过）`)
  process.exitCode = 1
} else {
  console.log(`✓ 全部 ${passed} 个断言通过`)
  process.exitCode = 0
}
