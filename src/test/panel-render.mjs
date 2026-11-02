/** 用 react-dom/server 把面板渲染成 HTML，验证关键 testid 真的出现在 DOM 里（O-9）。 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url)) + '/..'
const out = mkdtempSync(join(here, '.panel-build-'))
process.env.DSH_MEMORY_SRC_ROOT = here
await build({ entryPoints: [join(here,'test/panel-render-entry.tsx')], bundle: true, outfile: join(out,'b.mjs'),
  format:'esm', platform:'node', target:'node22', packages:'external', logLevel:'warning', jsx:'automatic' })
const mod = await import(pathToFileURL(join(out,'b.mjs')).href)
const ok = await mod.run()
rmSync(out,{recursive:true,force:true})
process.exit(ok?0:1)
