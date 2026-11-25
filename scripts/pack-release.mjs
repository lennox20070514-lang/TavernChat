import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = (process.env.TAVERN_VERSION_NAME || pkg.version || '0.1.0').replace(/^v/i, '')

const releaseRoot = path.join(root, `TavernChat-v${version}-发布包`)
const dirAndroid = path.join(releaseRoot, '01-安卓手机版(Android)')
const dirWindows = path.join(releaseRoot, '02-电脑版(Windows)')
const dirManual = path.join(releaseRoot, '03-使用说明书(新手必看)')
const dirGitHub = path.join(releaseRoot, '04-GitHub-Release上传文件')
const dirZip = path.join(releaseRoot, '05-分类压缩包(ZIP)')

const androidReleaseApk = path.join(root, 'apps', 'web', 'release', `TavernChat-v${version}-android.apk`)
const androidDebugApk = path.join(root, 'apps', 'web', 'release', `TavernChat-${version}-android-debug.apk`)
const apkSource = existsSync(androidReleaseApk) ? androidReleaseApk : androidDebugApk
const setupExe = path.join(root, 'apps', 'desktop', 'release', `TavernChat-${version}-Setup-x64.exe`)
const portableExe = path.join(root, 'apps', 'desktop', 'release', `TavernChat-${version}-Portable-x64.exe`)
const manualPdf = path.join(root, 'docs', 'TavernChat使用说明书.pdf')

for (const [label, filePath] of [
  ['Android APK', apkSource],
  ['Windows Setup EXE', setupExe],
  ['Windows Portable EXE', portableExe],
  ['PDF Manual', manualPdf],
]) {
  if (!existsSync(filePath)) {
    console.error(`[pack-release] 缺少必需产物 ${label}: ${filePath}`)
    process.exit(1)
  }
}

rmSync(releaseRoot, { recursive: true, force: true })
for (const d of [dirAndroid, dirWindows, dirManual, dirGitHub, dirZip]) {
  mkdirSync(d, { recursive: true })
}

const androidAssetName = `TavernChat-v${version}-android.apk`
const setupAssetName = `TavernChat-${version}-Setup-x64.exe`
const portableAssetName = `TavernChat-${version}-Portable-x64.exe`
const manualName = 'TavernChat使用说明书.pdf'

// 1. 填充分类目录
copyFileSync(apkSource, path.join(dirAndroid, androidAssetName))
copyFileSync(manualPdf, path.join(dirAndroid, manualName))

copyFileSync(setupExe, path.join(dirWindows, setupAssetName))
copyFileSync(portableExe, path.join(dirWindows, portableAssetName))
copyFileSync(manualPdf, path.join(dirWindows, manualName))

copyFileSync(manualPdf, path.join(dirManual, manualName))

// 2. 填充 GitHub Release 上传文件 + 生成 latest.json
copyFileSync(apkSource, path.join(dirGitHub, androidAssetName))
copyFileSync(setupExe, path.join(dirGitHub, setupAssetName))
copyFileSync(portableExe, path.join(dirGitHub, portableAssetName))

const manifestScript = path.join(root, 'scripts', 'generate-update-manifest.mjs')
const genRes = spawnSync(process.execPath, [manifestScript], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    TAVERN_VERSION_NAME: version,
    TAVERN_VERSION_CODE: process.env.TAVERN_VERSION_CODE || '1',
    RELEASE_TAG: `v${version}`,
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY || 'lennox20070514-lang/TavernChat',
    APK_FILE_NAME: androidAssetName,
    TAVERN_UPDATE_MIRROR_PREFIX: process.env.TAVERN_UPDATE_MIRROR_PREFIX || 'https://gh-proxy.org/',
    RELEASE_CHANGELOG:
      process.env.RELEASE_CHANGELOG ||
      `TavernChat v${version} 首个正式版：支持 DeepSeek / 中转站、本地角色卡与世界书蓝绿灯、多角色随机轮流与拌嘴群聊、卡牌市场多维筛选、以及手机与电脑局域网双向同步。`,
    OUT_MANIFEST_PATH: path.join(dirGitHub, 'latest.json'),
  },
})
if ((genRes.status ?? 1) !== 0) {
  process.exit(genRes.status ?? 1)
}

// 3. 打出 3 个分类 ZIP 压缩包（Python zipfile 保留中文文件名 UTF-8，无平台乱码）
const zipPy = `
import os, zipfile

def make_zip(out_zip, items):
    with zipfile.ZipFile(out_zip, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for src, arc in items:
            zf.write(src, arcname=arc)

make_zip(r"${path.join(dirZip, `TavernChat-v${version}-安卓完整包.zip`)}", [
    (r"${path.join(dirAndroid, androidAssetName)}", "${androidAssetName}"),
    (r"${path.join(dirAndroid, manualName)}", "${manualName}"),
])
make_zip(r"${path.join(dirZip, `TavernChat-v${version}-Windows完整包.zip`)}", [
    (r"${path.join(dirWindows, setupAssetName)}", "${setupAssetName}"),
    (r"${path.join(dirWindows, portableAssetName)}", "${portableAssetName}"),
    (r"${path.join(dirWindows, manualName)}", "${manualName}"),
])
make_zip(r"${path.join(dirZip, `TavernChat-v${version}-全平台合集.zip`)}", [
    (r"${path.join(dirAndroid, androidAssetName)}", "01-安卓手机版(Android)/${androidAssetName}"),
    (r"${path.join(dirWindows, setupAssetName)}", "02-电脑版(Windows)/${setupAssetName}"),
    (r"${path.join(dirWindows, portableAssetName)}", "02-电脑版(Windows)/${portableAssetName}"),
    (r"${path.join(dirManual, manualName)}", "${manualName}"),
])
print("[pack-release] Created 3 UTF-8 ZIP archives cleanly.")
`
const zipRes = spawnSync('python', ['-c', zipPy], { stdio: 'inherit' })
if ((zipRes.status ?? 1) !== 0) {
  process.exit(zipRes.status ?? 1)
}

function fileInfo(filePath) {
  const buf = readFileSync(filePath)
  const sha = createHash('sha256').update(buf).digest('hex')
  const mb = (statSync(filePath).size / (1024 * 1024)).toFixed(2)
  return { mb, sha }
}

const apkMeta = fileInfo(path.join(dirGitHub, androidAssetName))
const setupMeta = fileInfo(path.join(dirGitHub, setupAssetName))
const portableMeta = fileInfo(path.join(dirGitHub, portableAssetName))
const manualMeta = fileInfo(path.join(dirManual, manualName))

const readmeText = `TavernChat v${version} 分类发布包与永久网盘链接维护指南
====================================================

一、目录用途说明
1. 01-安卓手机版(Android)/
   - ${androidAssetName}（${apkMeta.mb} MB，正式 Release 签名版）
   - ${manualName}（${manualMeta.mb} MB）
2. 02-电脑版(Windows)/
   - ${setupAssetName}（${setupMeta.mb} MB，Windows 安装版）
   - ${portableAssetName}（${portableMeta.mb} MB，免安装便携绿色版）
   - ${manualName}
3. 03-使用说明书(新手必看)/
   - ${manualName}（13 页极简目录 + Q&A 实机图解版）
4. 04-GitHub-Release上传文件/
   - 直接把该文件夹内 4 个文件（APK + latest.json + 两个 Windows EXE）拖拽进 GitHub Release 页面即可完成发布。
5. 05-分类压缩包(ZIP)/
   - 已用 UTF-8 打包好「安卓完整包」「Windows完整包」「全平台合集」三个单文件 ZIP。

二、如何在夸克 / 百度网盘保持「一致性永久链接」？
- 建议在网盘根目录新建一个固定总文件夹（例如：TavernChat），把 01 / 02 / 03 这三个子文件夹（不要带版本号）传进去。
- 然后对「TavernChat」总文件夹生成一个「永久有效」的分享链接填进自动发货模板。
- 以后发布 v0.1.1 / v0.2.0 时，只要在这个总文件夹对应的 01 / 02 / 03 子文件夹里删旧传新即可，你的网盘分享链接永远不变，自动发货文案永远不用改！

三、核心产物 SHA-256 校验值
- ${androidAssetName}: ${apkMeta.sha}
- ${setupAssetName}: ${setupMeta.sha}
- ${portableAssetName}: ${portableMeta.sha}
- ${manualName}: ${manualMeta.sha}
`

writeFileSync(path.join(releaseRoot, 'README-网盘上传与发布清单.txt'), readmeText, 'utf8')
console.log(`[pack-release] Assembled categorized release folder at: ${releaseRoot}`)
