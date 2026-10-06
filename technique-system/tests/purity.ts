/**
 * 纪律 4 的自动检查：core-sim 不许碰任何外部 API。
 *
 * 为什么这个测试比它看起来重要：
 *   "core-sim 不引用外部 API"这一条，是整个架构里最容易违反、
 *   也最难在事后补救的一条。你写第 30 个技能时随手一句 Date.now()，
 *   等到要做重放或者联机才发现，就得回头改几十个文件。
 *
 *   所以别靠自觉 —— 让测试来管。违反了直接红灯。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SIM_DIR = resolve(HERE, '..', 'src', 'sim')

interface Rule {
  re: RegExp
  why: string
}

const FORBIDDEN: Rule[] = [
  { re: /\bDate\s*[.(]/, why: '时间 API 让模拟无法重放。要计时就用 world.tick' },
  { re: /\bMath\s*\.\s*random\b/, why: '全局随机无法重放。用 rng.ts 的 nextFloat(world)' },
  { re: /\bperformance\s*\./, why: '同 Date，不可重放' },
  { re: /\bnew\s+Date\b/, why: '同 Date，不可重放' },
  { re: /\bwindow\b/, why: 'core-sim 不能碰浏览器' },
  { re: /\bdocument\b/, why: 'core-sim 不能碰浏览器' },
  { re: /\bprocess\s*\./, why: 'core-sim 不能碰 Node' },
  { re: /\bconsole\s*\./, why: 'core-sim 不打印。要通知外界就推 world.events' },
  { re: /\brequire\s*\(/, why: 'core-sim 不依赖任何运行环境' },
  { re: /from\s+['"]node:/, why: 'core-sim 不依赖任何运行环境' },
  { re: /\bfetch\s*\(/, why: 'core-sim 不联网' },
  { re: /\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b/, why: '时间只能靠 stepWorld 推进' },
  {
    re: /\bMath\s*\.\s*(sin|cos|tan|asin|acos|atan|atan2|exp|log|log2|log10|pow|hypot|cbrt)\b/,
    why: '这些函数不保证跨 JS 引擎逐位一致。要方向就存单位向量，别存角度',
  },
]

/** 允许的 Math 函数：全都 IEEE 754 精确或整数运算，跨引擎一定一致 */
const ALLOWED_MATH = ['sqrt', 'abs', 'floor', 'ceil', 'round', 'min', 'max', 'imul', 'sign', 'trunc']

/**
 * 把注释和字符串内容抹掉，只留代码。
 * 不做这一步的话，注释里写一句"不要用 Date.now()"就会被误报。
 */
function stripCommentsAndStrings(src: string): string {
  let out = ''
  let i = 0
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'tpl' = 'code'

  while (i < src.length) {
    const c = src[i] as string
    const n = src[i + 1]

    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; i += 2; continue }
      if (c === '/' && n === '*') { state = 'block'; i += 2; continue }
      if (c === "'") { state = 'single'; i++; continue }
      if (c === '"') { state = 'double'; i++; continue }
      if (c === '`') { state = 'tpl'; i++; continue }
      out += c
      i++
      continue
    }

    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c }
      i++
      continue
    }

    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; i += 2; continue }
      if (c === '\n') out += c // 保留行号，报错时能定位
      i++
      continue
    }

    // 字符串内部：整段丢掉，但保留换行以维持行号
    if (c === '\\') { i += 2; continue }
    if (c === '\n') { out += c; i++; continue }
    if ((state === 'single' && c === "'")
      || (state === 'double' && c === '"')
      || (state === 'tpl' && c === '`')) {
      state = 'code'
      out += '""'
    }
    i++
  }

  return out
}

function listTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full))
    else if (name.endsWith('.ts')) out.push(full)
  }
  return out
}

function main(): number {
  const files = listTsFiles(SIM_DIR)

  if (files.length === 0) {
    console.log('✗ src/sim 下没找到任何 .ts 文件 —— 路径是不是错了？')
    return 1
  }

  let violations = 0

  for (const file of files) {
    const raw = readFileSync(file, 'utf8')
    const code = stripCommentsAndStrings(raw)
    const lines = code.split('\n')
    const rel = relative(resolve(HERE, '..'), file)

    for (let ln = 0; ln < lines.length; ln++) {
      const line = lines[ln] as string
      for (const rule of FORBIDDEN) {
        if (rule.re.test(line)) {
          if (violations === 0) {
            console.log('core-sim 纯净性检查失败：\n')
          }
          console.log(`  ✗ ${rel}:${ln + 1}`)
          console.log(`      ${line.trim()}`)
          console.log(`      → ${rule.why}\n`)
          violations++
        }
      }
    }
  }

  if (violations > 0) {
    console.log(`✗ 发现 ${violations} 处违反纪律 4 的代码（src/sim 必须与运行环境无关）`)
    return 1
  }

  const allowed = ALLOWED_MATH.join(' / ')
  console.log(`✓ core-sim 纯净性检查通过（${files.length} 个文件）`)
  console.log(`    Math 白名单：${allowed}`)
  return 0
}

process.exitCode = main()
