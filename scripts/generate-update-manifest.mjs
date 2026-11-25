import fs from 'node:fs'
import path from 'node:path'

const pkgPath = path.resolve(process.cwd(), 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))

const version = (process.env.TAVERN_VERSION_NAME || pkg.version || '0.1.0').replace(/^v/i, '')
const androidVersionCode = Number(process.env.TAVERN_VERSION_CODE || '1') || 1
const tag = process.env.RELEASE_TAG || `v${version}`
const repo = process.env.GITHUB_REPOSITORY || process.env.TAVERN_GITHUB_REPO || ''
const apkFileName = process.env.APK_FILE_NAME || `TavernChat-v${version}-android.apk`
const mirrorPrefixRaw = (process.env.TAVERN_UPDATE_MIRROR_PREFIX || '').trim()
const explicitMirrorApkUrl = (process.env.TAVERN_MIRROR_APK_URL || '').trim()
const changelog =
  (process.env.RELEASE_CHANGELOG || '').trim() ||
  `TavernChat v${version} 安卓更新包，建议下载覆盖安装。`

const apkUrl = repo
  ? `https://github.com/${repo}/releases/download/${tag}/${apkFileName}`
  : undefined
const releasePageUrl = repo ? `https://github.com/${repo}/releases/tag/${tag}` : undefined

let mirrorApkUrl = explicitMirrorApkUrl || undefined
if (!mirrorApkUrl && mirrorPrefixRaw && apkUrl) {
  const prefix = mirrorPrefixRaw.endsWith('/') ? mirrorPrefixRaw : `${mirrorPrefixRaw}/`
  mirrorApkUrl = `${prefix}${apkUrl}`
}

const manifest = {
  version,
  androidVersionCode,
  publishedAt: new Date().toISOString(),
  changelog,
  ...(apkUrl ? { apkUrl } : {}),
  ...(mirrorApkUrl ? { mirrorApkUrl } : {}),
  ...(releasePageUrl ? { releasePageUrl } : {}),
}

const outPath = path.resolve(process.env.OUT_MANIFEST_PATH || 'release-out/latest.json')
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
console.log('Generated update manifest:', outPath)
console.log(JSON.stringify(manifest, null, 2))
