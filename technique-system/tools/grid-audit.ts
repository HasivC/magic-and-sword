/**
 * 点表利用率：每一档**有没有内容在用**。
 *
 * 玩家的要求是「滑条大部分用三五个取值就够了，最多不超过 10 个」。
 * 没人用的格子就是白占宽度，可以剪掉 —— 这个工具把该剪的指出来。
 *
 * ⚠ 为什么需要它：点表在 `web/src/leaves.ts` 里是**手写**的（不是自动切分区间），
 *   手写的表会随着时间偏离实际需要 —— 加了一格没人用，或者某个值大家都想要
 *   却没有格子（那种情况下内容会在格子外插值，`tests/editor.ts` 会报警）。
 *
 * 这一轮就是靠它把中位数从 6 档压回 5 档的：剪掉了倍率表的 ×1（空操作）
 * 和伤害表的 15（夹在 10 和 25 中间，两边差别都比它大）。
 *
 * 用法：
 *   npm run grids              # 全部点表
 *   npm run grids -- --unused  # 只列"没人用的格子"
 */
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { readJson } from '../src/loader.ts'
import { collectLeaves } from '../web/src/leaves.ts'
import type { Skill } from '../src/schema.ts'

const DIR = 'content/skills'
const onlyUnused = process.argv.includes('--unused')

const files = readdirSync(DIR).filter(f => f.endsWith('.json')).sort()
const all = files.flatMap(f => collectLeaves(readJson<Skill>(resolve(DIR, f))))

/*
 * 按"这张表长什么样"归组，而不是按语义键。
 *
 * 同一个 `duration` 键在阶段和状态里是**两张不同的表**（见 leaves.ts 的
 * valuesForPath），所以按值列表归组才是对的 —— 按键名会把它们混成一张。
 */
interface Group {
  values: number[]
  used: Set<number>
  count: number
  labels: string[]
}

const byTable = new Map<string, Group>()
for (const l of all) {
  const key = l.values.join(',')
  let g = byTable.get(key)
  if (g === undefined) {
    g = { values: l.values, used: new Set(), count: 0, labels: [] }
    byTable.set(key, g)
  }
  g.used.add(l.value)
  g.count++
  if (g.labels.length < 3) g.labels.push(l.label)
}

/**
 * ⚠ 这些表**不许照着利用率剪**。
 *
 *   利用率低不等于该剪：有些表的每一格都是"设计上必须有"的选择，
 *   只是当前内容还没用到。剪掉它们会让**以后**没法表达那种技能。
 */
const KEEP_WHOLE: { values: string, why: string }[] = [
  {
    values: '0,1,2,3,4,5,6,7,8',
    why: '规则位是"条数"，玩家明确要求 0 到 8 每档都要有',
  },
  {
    values: '45,90,120,180,270,360',
    why: '张角是扇形的手感，每一档都是一种不同的挥砍',
  },
  {
    values: '0,0.5,1',
    why: '可见性只有三档（透明/半透明/正常），本来就是全的',
  },
]

function protectedWhy(values: number[]): string | undefined {
  return KEEP_WHOLE.find(k => k.values === values.join(','))?.why
}

const groups = [...byTable.values()].sort((a, b) => b.count - a.count)

if (onlyUnused) {
  console.log('没人用的格子（可以剪）')
  for (const g of groups) {
    const guard = protectedWhy(g.values)
    if (guard !== undefined) continue
    const unused = g.values.filter(v => !g.used.has(v))
    if (unused.length === 0) continue
    console.log(`  [${g.values.join(', ')}]`)
    console.log(`      没用: ${unused.join(', ')}   （这张表被 ${g.count} 处用到）`)
    console.log(`      例子: ${g.labels.join(' / ')}`)
  }
  console.log('')
  console.log('这些表**故意**保留全部档位，不按利用率剪：')
  for (const k of KEEP_WHOLE) console.log(`  [${k.values}]  ${k.why}`)
} else {
  console.log('档位 | 被用到的值 | 用了几处 | 例子')
  console.log('─'.repeat(96))
  for (const g of groups) {
    const unused = g.values.filter(v => !g.used.has(v))
    console.log(
      `${String(g.values.length).padStart(2)} 档 [${g.values.join(', ')}]`.padEnd(46)
      + `用到 ${String(g.used.size).padStart(2)}/${g.values.length}  ${String(g.count).padStart(3)} 处`
      + (unused.length > 0 ? `   没用的格子: ${unused.join(', ')}` : ''),
    )
    console.log(`      ${g.labels.join(' / ')}`)
  }
}

const counts = all.map(l => l.values.length).sort((a, b) => a - b)
const median = counts[Math.floor(counts.length / 2)] ?? 0
const avg = counts.reduce((a, b) => a + b, 0) / (counts.length || 1)
const max = counts[counts.length - 1] ?? 0
const small = counts.filter(n => n <= 6).length / (counts.length || 1)

console.log('─'.repeat(96))
console.log(`共 ${all.length} 个数值：平均 ${avg.toFixed(1)} 档，中位 ${median} 档，最多 ${max} 档，${(small * 100).toFixed(0)}% 在 6 档以内`)
console.log('（tests/editor.ts 要求：中位 <= 5、最多 <= 10、至少七成 <= 6）')
