import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shimDir = path.join(os.tmpdir(), 'tavern-chat-pnpm-shim')
mkdirSync(shimDir, { recursive: true })
writeFileSync(path.join(shimDir, 'pnpm.cmd'), '@echo off\r\ncorepack pnpm %*\r\n', 'utf8')

const useChinaMirror = !process.env.CI
const env = {
  ...process.env,
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  ...(useChinaMirror
    ? {
        ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
        ELECTRON_BUILDER_BINARIES_MIRROR:
          process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
          'https://npmmirror.com/mirrors/electron-builder-binaries/',
      }
    : {}),
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`,
}

const prep = spawnSync(process.execPath, [path.join(rootDir, 'scripts/prepare.mjs')], {
  cwd: rootDir,
  stdio: 'inherit',
  env,
})
if ((prep.status ?? 1) !== 0) {
  rmSync(shimDir, { recursive: true, force: true })
  process.exit(prep.status ?? 1)
}

const extraArgs = process.argv.slice(2).filter((a) => a !== '--')
const builderArgs = extraArgs.length > 0 ? extraArgs : ['--win']
const builderBin = path.join(rootDir, 'node_modules/.bin/electron-builder.cmd')

const run = spawnSync(
  process.platform === 'win32' ? builderBin : 'electron-builder',
  builderArgs,
  {
    cwd: rootDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env,
  }
)

rmSync(shimDir, { recursive: true, force: true })
process.exit(run.status ?? 1)
