import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function encodeRgbaPng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** 绘制深石墨圆角底 + 极简白色聊天框 + 蓝/绿双组件亮点的 TavernChat 图标 */
function renderIconPng(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const sdfRoundedBox = (px, py, cx, cy, hw, hh, r) => {
    const dx = Math.abs(px - cx) - hw + r
    const dy = Math.abs(py - cy) - hh + r
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x + 0.5) / size
      const ny = (y + 0.5) / size

      // 底层圆角矩形背景 (#18181B -> 微渐变 #232630)
      const bgDist = sdfRoundedBox(nx, ny, 0.5, 0.5, 0.48, 0.48, 0.22)
      let r = 0,
        g = 0,
        b = 0,
        a = 0
      const aa = 1.5 / size

      if (bgDist < aa) {
        const cov = Math.max(0, Math.min(1, (aa - bgDist) / (2 * aa)))
        const grad = ny
        r = Math.round(24 + grad * 12)
        g = Math.round(24 + grad * 14)
        b = Math.round(27 + grad * 20)
        a = Math.round(cov * 255)
      }

      // 居中白色圆角气泡描边
      const boxDist = sdfRoundedBox(nx, ny, 0.5, 0.46, 0.26, 0.19, 0.08)
      const strokeHalf = 0.028
      const ringDist = Math.abs(boxDist) - strokeHalf
      if (ringDist < aa && a > 0) {
        const cov = Math.max(0, Math.min(1, (aa - ringDist) / (2 * aa)))
        r = Math.round(r * (1 - cov) + 250 * cov)
        g = Math.round(g * (1 - cov) + 250 * cov)
        b = Math.round(b * (1 - cov) + 252 * cov)
      }

      // 左下小气泡尖角
      const tailDist = sdfRoundedBox(nx, ny, 0.36, 0.67, 0.032, 0.045, 0.015)
      if (tailDist < aa && a > 0) {
        const cov = Math.max(0, Math.min(1, (aa - tailDist) / (2 * aa)))
        r = Math.round(r * (1 - cov) + 250 * cov)
        g = Math.round(g * (1 - cov) + 250 * cov)
        b = Math.round(b * (1 - cov) + 252 * cov)
      }

      // 气泡内两个象征“角色(蓝) + 世界卡(绿)”的精致圆点
      const dBlue = Math.hypot(nx - 0.41, ny - 0.46) - 0.052
      if (dBlue < aa && a > 0) {
        const cov = Math.max(0, Math.min(1, (aa - dBlue) / (2 * aa)))
        r = Math.round(r * (1 - cov) + 96 * cov)
        g = Math.round(g * (1 - cov) + 165 * cov)
        b = Math.round(b * (1 - cov) + 250 * cov)
      }
      const dGreen = Math.hypot(nx - 0.59, ny - 0.46) - 0.052
      if (dGreen < aa && a > 0) {
        const cov = Math.max(0, Math.min(1, (aa - dGreen) / (2 * aa)))
        r = Math.round(r * (1 - cov) + 52 * cov)
        g = Math.round(g * (1 - cov) + 211 * cov)
        b = Math.round(b * (1 - cov) + 153 * cov)
      }

      const idx = (y * size + x) * 4
      rgba[idx] = r
      rgba[idx + 1] = g
      rgba[idx + 2] = b
      rgba[idx + 3] = a
    }
  }
  return encodeRgbaPng(size, size, rgba)
}

/** 封装标准 Windows ICO（内嵌 256x256 PNG，Windows Vista+ 原生支持） */
function wrapPngAsIco(pngBuf) {
  const header = Buffer.alloc(22)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // icon type
  header.writeUInt16LE(1, 4) // 1 image
  header[6] = 0 // 256px
  header[7] = 0 // 256px
  header[8] = 0
  header[9] = 0
  header.writeUInt16LE(1, 10) // color planes
  header.writeUInt16LE(32, 12) // bpp
  header.writeUInt32LE(pngBuf.length, 14)
  header.writeUInt32LE(22, 18)
  return Buffer.concat([header, pngBuf])
}

const webPublic = path.join(root, 'apps/web/public')
const desktopBuild = path.join(root, 'apps/desktop/build')
mkdirSync(webPublic, { recursive: true })
mkdirSync(desktopBuild, { recursive: true })

writeFileSync(path.join(webPublic, 'apple-touch-icon.png'), renderIconPng(180))
writeFileSync(path.join(webPublic, 'icon-192.png'), renderIconPng(192))
const png512 = renderIconPng(512)
writeFileSync(path.join(webPublic, 'icon-512.png'), png512)
writeFileSync(path.join(desktopBuild, 'icon.png'), png512)
writeFileSync(path.join(desktopBuild, 'icon.ico'), wrapPngAsIco(renderIconPng(256)))

console.log('Generated TavernChat icons for Web / iOS PWA / Electron desktop.')
