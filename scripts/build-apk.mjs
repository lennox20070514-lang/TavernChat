import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const androidDir = path.join(root, 'apps', 'web', 'android')
const isWindows = process.platform === 'win32'
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = process.env.TAVERN_VERSION_NAME || pkg.version || '0.1.0'
const wantsRelease =
  process.argv.includes('--release') || Boolean(process.env.TAVERN_KEYSTORE_PATH)
const task = wantsRelease ? 'assembleRelease' : 'assembleDebug'

const gradlew = path.join(androidDir, isWindows ? 'gradlew.bat' : 'gradlew')
const result = spawnSync(gradlew, [task], {
  cwd: androidDir,
  stdio: 'inherit',
  shell: isWindows,
})

if ((result.status ?? 1) === 0) {
  const apkSrc = wantsRelease
    ? existsSync(path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'))
      ? path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
      : path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk')
    : path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
  const releaseDir = path.join(root, 'apps', 'web', 'release')
  const apkDest = path.join(
    releaseDir,
    wantsRelease ? `TavernChat-v${version}-android.apk` : `TavernChat-${version}-android-debug.apk`
  )
  if (existsSync(apkSrc)) {
    mkdirSync(releaseDir, { recursive: true })
    copyFileSync(apkSrc, apkDest)
    console.log(`[build-apk] Archived latest APK to ${apkDest}`)
  }
}

process.exit(result.status ?? 1)
