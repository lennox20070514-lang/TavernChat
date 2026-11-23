/**
 * 纯二进制 PNG Character Card V2 / V3 读写器（零外部依赖，浏览器 / Android / Node 全端通用）
 *
 * 兼容 SillyTavern 规范：
 * - 读取时优先解析 tEXt chunk 中的 `ccv3`（V3），若不存在则回退 `chara`（V2/V1）。
 * - 写入时同时写入 `chara`（V2）与 `ccv3`（V3），与 SillyTavern 官方行为保持一致。
 */

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  )
}

function writeUint32BE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff
  target[offset + 1] = (value >>> 16) & 0xff
  target[offset + 2] = (value >>> 8) & 0xff
  target[offset + 3] = value & 0xff
}

function asciiToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    out[i] = text.charCodeAt(i) & 0xff
  }
  return out
}

function bytesToAscii(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i]!)
  }
  return out
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function base64ToUtf8(b64: string): string {
  const cleaned = b64.replace(/\s+/g, '')
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(cleaned, 'base64').toString('utf8')
  }
  const binary = atob(cleaned)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new TextDecoder('utf-8').decode(bytes)
}

export function bytesToDataUrl(bytes: Uint8Array, mime = 'image/png'): string {
  let b64: string
  if (typeof Buffer !== 'undefined') {
    b64 = Buffer.from(bytes).toString('base64')
  } else {
    let binary = ''
    const chunkSize = 0x8000
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
    }
    b64 = btoa(binary)
  }
  return `data:${mime};base64,${b64}`
}

export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const idx = dataUrl.indexOf(',')
  const b64 = idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'))
  }
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

type PngChunk = {
  type: string
  data: Uint8Array
}

export function isPngBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false
  }
  return true
}

function extractPngChunks(bytes: Uint8Array): PngChunk[] {
  if (!isPngBytes(bytes)) {
    throw new Error('不是有效的 PNG 图片文件')
  }
  const chunks: PngChunk[] = []
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = readUint32BE(bytes, offset)
    const type = bytesToAscii(bytes.subarray(offset + 4, offset + 8))
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > bytes.length) {
      break
    }
    chunks.push({
      type,
      data: bytes.slice(dataStart, dataEnd),
    })
    offset = dataEnd + 4
    if (type === 'IEND') {
      break
    }
  }
  return chunks
}

function encodePngChunks(chunks: PngChunk[]): Uint8Array {
  let totalLength = PNG_SIGNATURE.length
  for (const chunk of chunks) {
    totalLength += 12 + chunk.data.length
  }
  const out = new Uint8Array(totalLength)
  out.set(PNG_SIGNATURE, 0)
  let offset = PNG_SIGNATURE.length
  for (const chunk of chunks) {
    writeUint32BE(out, offset, chunk.data.length)
    const typeBytes = asciiToBytes(chunk.type)
    out.set(typeBytes, offset + 4)
    out.set(chunk.data, offset + 8)
    const crcInput = out.subarray(offset + 4, offset + 8 + chunk.data.length)
    writeUint32BE(out, offset + 8 + chunk.data.length, crc32(crcInput))
    offset += 12 + chunk.data.length
  }
  return out
}

function decodeTextChunk(data: Uint8Array): { keyword: string; text: string } | null {
  const nulIndex = data.indexOf(0)
  if (nulIndex < 0) return null
  const keyword = bytesToAscii(data.subarray(0, nulIndex))
  const text = bytesToAscii(data.subarray(nulIndex + 1))
  return { keyword, text }
}

function encodeTextChunk(keyword: string, text: string): PngChunk {
  const keyBytes = asciiToBytes(keyword)
  const textBytes = asciiToBytes(text)
  const data = new Uint8Array(keyBytes.length + 1 + textBytes.length)
  data.set(keyBytes, 0)
  data[keyBytes.length] = 0
  data.set(textBytes, keyBytes.length + 1)
  return { type: 'tEXt', data }
}

/**
 * 从 PNG 字节流中读取酒馆角色卡 JSON 字符串（优先 ccv3，其次 chara）
 */
export function readCharacterJsonFromPng(pngBytes: Uint8Array): string {
  const chunks = extractPngChunks(pngBytes)
  let ccv3Text: string | null = null
  let charaText: string | null = null

  for (const chunk of chunks) {
    if (chunk.type !== 'tEXt') continue
    const decoded = decodeTextChunk(chunk.data)
    if (!decoded) continue
    const key = decoded.keyword.toLowerCase()
    if (key === 'ccv3') {
      ccv3Text = decoded.text
    } else if (key === 'chara') {
      charaText = decoded.text
    }
  }

  if (ccv3Text) {
    return base64ToUtf8(ccv3Text)
  }
  if (charaText) {
    return base64ToUtf8(charaText)
  }
  throw new Error('该 PNG 图片中未找到 SillyTavern 角色卡元数据（chara / ccv3）')
}

/**
 * 将角色卡 JSON 写入 PNG 字节流（兼容 V2 `chara` 与 V3 `ccv3`）
 */
export function writeCharacterJsonToPng(pngBytes: Uint8Array, cardJsonString: string): Uint8Array {
  const chunks = extractPngChunks(pngBytes).filter((chunk) => {
    if (chunk.type !== 'tEXt') return true
    const decoded = decodeTextChunk(chunk.data)
    if (!decoded) return true
    const key = decoded.keyword.toLowerCase()
    return key !== 'chara' && key !== 'ccv3'
  })

  const iendIdx = chunks.findIndex((c) => c.type === 'IEND')
  const insertAt = iendIdx >= 0 ? iendIdx : chunks.length

  const v2Base64 = utf8ToBase64(cardJsonString)
  const toInsert: PngChunk[] = [encodeTextChunk('chara', v2Base64)]

  try {
    const parsed = JSON.parse(cardJsonString) as Record<string, unknown>
    const v3Obj = {
      ...parsed,
      spec: 'chara_card_v3',
      spec_version: '3.0',
    }
    toInsert.push(encodeTextChunk('ccv3', utf8ToBase64(JSON.stringify(v3Obj))))
  } catch {
    // 非法 JSON 时仅保留 chara
  }

  chunks.splice(insertAt, 0, ...toInsert)
  return encodePngChunks(chunks)
}

/**
 * 生成一张极简 1x1 纯色占位 PNG，用于没有头像的角色卡也能导出为标准酒馆 PNG 卡片
 */
export function createMinimalPlaceholderPng(): Uint8Array {
  // 预生成的标准 1x1 浅靛蓝 PNG（68 字节，合法 IHDR + IDAT + IEND）
  const base64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  return dataUrlToBytes(`data:image/png;base64,${base64}`)
}
