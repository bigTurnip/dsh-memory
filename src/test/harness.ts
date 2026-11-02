/**
 * 自测框架（无依赖，零安装）。
 *
 * 为什么不用 mocha/vitest：本插件要在宿主的 Node 运行时里跑（系统 node 没有 FTS5），
 * 而宿主运行时里没有测试框架的 node_modules。自己写 60 行 runner，
 * 换来的是"任何环境都能跑、不装东西"。
 */

export interface TestCase {
  readonly id: string
  readonly title: string
  readonly fn: () => Promise<void> | void
}

export interface TestResult {
  readonly id: string
  readonly title: string
  readonly ok: boolean
  readonly detail: string
  readonly ms: number
}

const cases: TestCase[] = []
let currentId = ''

/** 注册一条用例。 */
export function test(id: string, title: string, fn: () => Promise<void> | void): void {
  cases.push({ id, title, fn })
}

/** 断言。 */
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** 相等断言（带可读 diff）。 */
export function equal<T>(actual: T, expected: T, message: string): void {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) throw new Error(`${message}\n  实际: ${left}\n  期望: ${right}`)
}

/** 断言会抛错。 */
export function throws(fn: () => unknown, message: string): void {
  try {
    fn()
  } catch {
    return
  }
  throw new Error(`${message}（但实际没有抛错）`)
}

export function currentTestId(): string {
  return currentId
}

export async function runAll(filter?: string): Promise<TestResult[]> {
  const results: TestResult[] = []
  for (const testCase of cases) {
    if (filter !== undefined && !testCase.id.includes(filter)) continue
    currentId = testCase.id
    const started = performance.now()
    try {
      await testCase.fn()
      results.push({
        id: testCase.id,
        title: testCase.title,
        ok: true,
        detail: '',
        ms: Math.round(performance.now() - started),
      })
    } catch (error) {
      results.push({
        id: testCase.id,
        title: testCase.title,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        ms: Math.round(performance.now() - started),
      })
    }
  }
  currentId = ''
  return results
}

/** 打印结果并返回是否全通过。 */
export function report(results: readonly TestResult[], header: string): boolean {
  const pass = results.filter((result) => result.ok).length
  console.log(`\n${header}`)
  console.log('='.repeat(96))
  for (const result of results) {
    const mark = result.ok ? 'PASS' : 'FAIL'
    const time = `${result.ms}ms`.padStart(7)
    console.log(`${mark} ${time}  ${result.id.padEnd(28)} ${result.title}`)
    if (!result.ok) console.log(`             ↳ ${result.detail.replace(/\n/g, '\n               ')}`)
  }
  console.log('-'.repeat(96))
  console.log(`${pass}/${results.length} 通过`)
  return pass === results.length
}
