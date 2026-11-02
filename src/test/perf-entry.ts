import { measurePerformance } from './perf.test.js'
export function run(total: number, queries: number) { return measurePerformance(total, queries) }
