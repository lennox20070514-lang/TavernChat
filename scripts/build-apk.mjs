import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
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

if ((result.status ?? 1) === 0) {
  const apkSrc = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
  const releaseDir = path.join(root, 'apps', 'web', 'release')
  const apkDest = path.join(releaseDir, 'TavernChat-0.1.0-android-debug.apk')
  if (existsSync(apkSrc)) {
    mkdirSync(releaseDir, { recursive: true })
    copyFileSync(apkSrc, apkDest)
    console.log(`[build-apk] Archived latest APK to ${apkDest}`)
  }
}

process.exit(result.status ?? 1)
