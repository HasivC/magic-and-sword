import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'

/** 读文件失败时抛这个，带上文件名，调用方不用猜是哪个文件坏了 */
export class LoadError extends Error {
  readonly file: string

  constructor(file: string, message: string) {
    super(message)
    this.name = 'LoadError'
    this.file = file
  }
}

/** 读一个 JSON 对象。任何一步失败都抛带文件名的 LoadError。 */
export function readJson<T = unknown>(file: string): T {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    throw new LoadError(file, `读不到文件：${(e as Error).message}`)
  }

  /*
   * ⚠ 剥掉 UTF-8 BOM。
   *
   * Windows 上的编辑器和 PowerShell 的 `Set-Content -Encoding utf8`
   * 都会往文件开头塞三个字节 `EF BB BF`，而 `JSON.parse` 见了它直接抛
   * `Unexpected token ''` —— 报错信息里完全看不出真正的原因。
   *
   * 这个坑项目里踩过两次（手写内容一次、工具脚本改的一次），
   * 所以在这里一次性挡掉：**BOM 是合法的 UTF-8，不该算 JSON 语法错误。**
   */
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    throw new LoadError(file, `JSON 语法错误：${(e as Error).message}`)
  }

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new LoadError(file, '顶层必须是一个 JSON 对象')
  }

  return data as T
}

/**
 * 把一个路径摊平成一串 .json 文件。
 *   传文件 → 原样返回
 *   传目录 → 递归收集（按名字排序，保证每次输出顺序一样）
 */
export function collectJsonFiles(target: string): string[] {
  const abs = resolve(target)

  let st
  try {
    st = statSync(abs)
  } catch {
    throw new LoadError(abs, '路径不存在')
  }

  if (st.isFile()) return [abs]

  const out: string[] = []
  for (const name of readdirSync(abs).sort()) {
    const child = join(abs, name)
    if (statSync(child).isDirectory()) out.push(...collectJsonFiles(child))
    else if (extname(name).toLowerCase() === '.json') out.push(child)
  }
  return out
}

/** 尽可能短地显示一个路径，让报错信息别太长 */
export function shortPath(abs: string): string {
  const rel = relative(process.cwd(), abs)
  return rel !== '' && !rel.startsWith('..') ? rel : abs
}
