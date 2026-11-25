import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const webDir = path.resolve(rootDir, '../web')
const webDistSource = path.join(webDir, 'dist')
const webDistDest = path.join(rootDir, 'web-dist')
const outDir = path.join(rootDir, 'dist')

const buildWeb = spawnSync('corepack', ['pnpm', '--filter', '@tavern-chat/web', 'build'], {
  cwd: path.resolve(rootDir, '../..'),
  stdio: 'inherit',
  shell: true,
})
if ((buildWeb.status ?? 1) !== 0 || !existsSync(webDistSource)) {
  process.exit(buildWeb.status ?? 1)
}

rmSync(webDistDest, { recursive: true, force: true })
cpSync(webDistSource, webDistDest, { recursive: true })

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

await build({
  entryPoints: [path.join(rootDir, 'src/main.ts')],
  outfile: path.join(outDir, 'main.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron'],
  sourcemap: false,
})

await build({
  entryPoints: [path.join(rootDir, 'src/preload.ts')],
  outfile: path.join(outDir, 'preload.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron'],
  sourcemap: false,
})

process.stdout.write('[tavern-desktop] Prepared web-dist & main/preload bundles.\n')
