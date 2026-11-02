import { measureRecall, printRecall, recallPassed, RECALL_THRESHOLD, type RecallReport } from './recall.test.js'

/** 跑一次 H-1 实测，打印报告并把结果回传给调用方（由 recall.mjs 落成退出码）。 */
export function run(topK: number): { report: RecallReport; passed: boolean; threshold: number } {
  const report = measureRecall(topK)
  printRecall(report, topK)
  return { report, passed: recallPassed(report), threshold: RECALL_THRESHOLD }
}
