/** 自测的打包入口：注册全部用例并跑。 */
import './behaviour.test.js'
import './checks.test.js'
import './dual.test.js'
import './settings.test.js'
import { runAll, report } from './harness.js'

export async function main(): Promise<boolean> {
  const filter = process.argv.find((arg) => arg.startsWith('--filter='))?.slice('--filter='.length)
  const results = await runAll(filter)
  const ok = report(results, `记忆系统自测（${new Date().toISOString()}）`)
  const failed = results.filter((result) => !result.ok)
  if (failed.length > 0) {
    console.log('\n失败项：')
    for (const result of failed) console.log(`  ${result.id} ${result.title}`)
  }
  return ok
}
