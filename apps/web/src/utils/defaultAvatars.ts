/** 将用户从相册选择的大图居中裁切压缩为轻量化 DataURL（最大 384px），防止本地同步包膨胀。 */
export function resizeImageFileToAvatarDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.onload = () => {
      const rawUrl = typeof reader.result === 'string' ? reader.result : ''
      if (!rawUrl) {
        reject(new Error('图片内容为空'))
        return
      }
      const img = new Image()
      img.onerror = () => resolve(rawUrl)
      img.onload = () => {
        const size = 384
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(rawUrl)
          return
        }
        const minSide = Math.min(img.width, img.height) || 1
        const sx = (img.width - minSide) / 2
        const sy = (img.height - minSide) / 2
        ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size)
        try {
          resolve(canvas.toDataURL('image/jpeg', 0.88))
        } catch {
          resolve(rawUrl)
        }
      }
      img.src = rawUrl
    }
    reader.readAsDataURL(file)
  })
}
