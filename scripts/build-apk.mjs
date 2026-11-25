import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const androidDir = path.join(root, 'apps', 'web', 'android')
const isWindows = process.platform === 'win32'

const gradlew = path.join(androidDir, isWindows ? 'gradlew.bat' : 'gradlew')
const result = spawnSync(gradlew, ['assembleDebug'], {
  cwd: androidDir,
  stdio: 'inherit',
  shell: isWindows,
})

process.exit(result.status ?? 1)
