/**
 * 零外部依赖的纯 TypeScript RFC 1951/1950 同步解压与 ZIP 读取器，
 * 用于在浏览器 / Android WebView / Node 环境下统一解析 PNG zTXt/iTXt 块与 .charx V3 卡片包。
 */

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]
const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
]
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
]
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]

type HuffmanTree = {
  counts: Int32Array
  symbols: Int32Array
}

function buildTree(lengths: number[]): HuffmanTree {
  const counts = new Int32Array(16)
  for (const len of lengths) {
    if (len > 0 && len < 16) counts[len]! += 1
  }
  const offs = new Int32Array(16)
  let left = 0
  for (let len = 1; len < 16; len++) {
    offs[len] = left
    left += counts[len]!
  }
  const symbols = new Int32Array(lengths.length)
  for (let sym = 0; sym < lengths.length; sym++) {
    const len = lengths[sym]!
    if (len > 0 && len < 16) {
      symbols[offs[len]!] = sym
      offs[len]! += 1
    }
  }
  return { counts, symbols }
}

const FIXED_LIT_TREE = (() => {
  const lengths = new Array<number>(288)
  for (let i = 0; i <= 143; i++) lengths[i] = 8
  for (let i = 144; i <= 255; i++) lengths[i] = 9
  for (let i = 256; i <= 279; i++) lengths[i] = 7
  for (let i = 280; i <= 287; i++) lengths[i] = 8
  return buildTree(lengths)
})()

const FIXED_DIST_TREE = (() => buildTree(new Array<number>(32).fill(5)))()

class BitReader {
  private readonly src: Uint8Array
  private pos = 0
  private bitBuf = 0
  private bitCnt = 0

  constructor(src: Uint8Array, startOffset = 0) {
    this.src = src
    this.pos = startOffset
  }

  readBits(n: number): number {
    while (this.bitCnt < n) {
      if (this.pos >= this.src.length) throw new Error('压缩数据不完整')
      this.bitBuf |= this.src[this.pos++]! << this.bitCnt
      this.bitCnt += 8
    }
    const val = this.bitBuf & ((1 << n) - 1)
    this.bitBuf >>>= n
    this.bitCnt -= n
    return val
  }

  alignByte(): void {
    this.bitBuf = 0
    this.bitCnt = 0
  }

  readUint16LE(): number {
    this.alignByte()
    if (this.pos + 2 > this.src.length) throw new Error('压缩块长度缺失')
    const v = this.src[this.pos]! | (this.src[this.pos + 1]! << 8)
    this.pos += 2
    return v
  }

  readBytes(len: number): Uint8Array {
    this.alignByte()
    if (this.pos + len > this.src.length) throw new Error('未压缩块超出边界')
    const out = this.src.subarray(this.pos, this.pos + len)
    this.pos += len
    return out
  }

  decodeSymbol(tree: HuffmanTree): number {
    let code = 0
    let first = 0
    let index = 0
    for (let len = 1; len <= 15; len++) {
      code |= this.readBits(1)
      const count = tree.counts[len]!
      if (code - count < first) {
        return tree.symbols[index + (code - first)]!
      }
      index += count
      first += count
      first <<= 1
      code <<= 1
    }
    throw new Error('无效的 Huffman 编码数据')
  }
}

export function inflateRaw(data: Uint8Array, startOffset = 0): Uint8Array {
  const reader = new BitReader(data, startOffset)
  const out: number[] = []
  let isFinal = 0

  do {
    isFinal = reader.readBits(1)
    const btype = reader.readBits(2)

    if (btype === 0) {
      const len = reader.readUint16LE()
      const nlen = reader.readUint16LE()
      if ((len ^ 0xffff) !== nlen) throw new Error('压缩块校验失败')
      const raw = reader.readBytes(len)
      for (let i = 0; i < raw.length; i++) out.push(raw[i]!)
      continue
    }

    let litTree = FIXED_LIT_TREE
    let distTree = FIXED_DIST_TREE

    if (btype === 2) {
      const hlit = reader.readBits(5) + 257
      const hdist = reader.readBits(5) + 1
      const hclen = reader.readBits(4) + 4
      const clLengths = new Array<number>(19).fill(0)
      for (let i = 0; i < hclen; i++) {
        clLengths[CL_ORDER[i]!] = reader.readBits(3)
      }
      const clTree = buildTree(clLengths)
      const allLengths: number[] = []
      while (allLengths.length < hlit + hdist) {
        const sym = reader.decodeSymbol(clTree)
        if (sym < 16) {
          allLengths.push(sym)
        } else if (sym === 16) {
          const prev = allLengths[allLengths.length - 1] ?? 0
          const rep = 3 + reader.readBits(2)
          for (let i = 0; i < rep; i++) allLengths.push(prev)
        } else if (sym === 17) {
          const rep = 3 + reader.readBits(3)
          for (let i = 0; i < rep; i++) allLengths.push(0)
        } else if (sym === 18) {
          const rep = 11 + reader.readBits(7)
          for (let i = 0; i < rep; i++) allLengths.push(0)
        }
      }
      litTree = buildTree(allLengths.slice(0, hlit))
      distTree = buildTree(allLengths.slice(hlit))
    } else if (btype !== 1) {
      throw new Error('不支持的压缩块类型')
    }

    while (true) {
      const sym = reader.decodeSymbol(litTree)
      if (sym < 256) {
        out.push(sym)
      } else if (sym === 256) {
        break
      } else {
        const lenIdx = sym - 257
        if (lenIdx < 0 || lenIdx >= LEN_BASE.length) throw new Error('压缩长度符号越界')
        const len = LEN_BASE[lenIdx]! + reader.readBits(LEN_EXTRA[lenIdx]!)
        const distIdx = reader.decodeSymbol(distTree)
        if (distIdx < 0 || distIdx >= DIST_BASE.length) throw new Error('压缩距离符号越界')
        const dist = DIST_BASE[distIdx]! + reader.readBits(DIST_EXTRA[distIdx]!)
        for (let i = 0; i < len; i++) {
          const srcIdx = out.length - dist
          if (srcIdx < 0) throw new Error('压缩回溯距离越界')
          out.push(out[srcIdx]!)
        }
      }
    }
  } while (!isFinal)

  return Uint8Array.from(out)
}

export function inflateZlib(zlibBytes: Uint8Array): Uint8Array {
  if (zlibBytes.length < 6) throw new Error('zlib 数据长度不足')
  const cmf = zlibBytes[0]!
  const flg = zlibBytes[1]!
  if ((cmf & 0x0f) !== 8 || ((cmf * 256 + flg) % 31) !== 0) {
    throw new Error('无效的 zlib 头部')
  }
  const hasDict = (flg & 0x20) !== 0
  return inflateRaw(zlibBytes, hasDict ? 6 : 2)
}

export type ZipEntry = {
  name: string
  data: Uint8Array
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8)
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  )
}

export function isZipBytes(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  )
}

/**
 * 解析 .charx / .zip 中的文件条目（基于中央目录 EOCD，兼容带 Data Descriptor 的标准归档）。
 */
export function readZipEntries(zipBytes: Uint8Array): ZipEntry[] {
  if (!isZipBytes(zipBytes)) {
    throw new Error('不是有效的 ZIP / CHARX 归档文件')
  }
  const minOffset = Math.max(0, zipBytes.length - 65557)
  let eocdOffset = -1
  for (let i = zipBytes.length - 22; i >= minOffset; i--) {
    if (
      zipBytes[i] === 0x50 &&
      zipBytes[i + 1] === 0x4b &&
      zipBytes[i + 2] === 0x05 &&
      zipBytes[i + 3] === 0x06
    ) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset < 0) {
    throw new Error('找不到 ZIP 中央目录结束标记')
  }

  const totalEntries = readUint16LE(zipBytes, eocdOffset + 10)
  let cdOffset = readUint32LE(zipBytes, eocdOffset + 16)
  const entries: ZipEntry[] = []
  const decoder = new TextDecoder('utf-8')

  for (let i = 0; i < totalEntries && cdOffset + 46 <= zipBytes.length; i++) {
    if (readUint32LE(zipBytes, cdOffset) !== 0x02014b50) break
    const method = readUint16LE(zipBytes, cdOffset + 10)
    const compSize = readUint32LE(zipBytes, cdOffset + 20)
    const nameLen = readUint16LE(zipBytes, cdOffset + 28)
    const extraLen = readUint16LE(zipBytes, cdOffset + 30)
    const commentLen = readUint16LE(zipBytes, cdOffset + 32)
    const localHeaderOffset = readUint32LE(zipBytes, cdOffset + 42)
    const name = decoder.decode(zipBytes.subarray(cdOffset + 46, cdOffset + 46 + nameLen))
    cdOffset += 46 + nameLen + extraLen + commentLen

    if (name.endsWith('/')) continue
    if (localHeaderOffset + 30 > zipBytes.length) continue
    if (readUint32LE(zipBytes, localHeaderOffset) !== 0x04034b50) continue

    const localNameLen = readUint16LE(zipBytes, localHeaderOffset + 26)
    const localExtraLen = readUint16LE(zipBytes, localHeaderOffset + 28)
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen
    if (dataStart + compSize > zipBytes.length) continue
    const compressed = zipBytes.subarray(dataStart, dataStart + compSize)

    if (method === 0) {
      entries.push({ name, data: compressed.slice() })
    } else if (method === 8) {
      entries.push({ name, data: inflateRaw(compressed, 0) })
    }
  }

  return entries
}
