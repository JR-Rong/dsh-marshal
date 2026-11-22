/**
 * In-app QR scanner: camera preview + jsQR, no native barcode plugin.
 *
 * The overlay is independent of the page. On success it stops the camera,
 * removes itself and hands the raw text to the caller. On failure it stays put
 * with a readable error so the user can close and use manual pairing.
 */
import jsQR from 'jsqr'
import { Camera } from '@capacitor/camera'

export interface QrScannerOptions {
  onResult: (text: string) => void
  onCancel?: () => void
}

export interface QrScannerHandle {
  close: () => void
}

const STYLE_ID = 'qr-scanner-style'
const OVERLAY_ID = 'qr-scanner'

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = [
    '#' + OVERLAY_ID + '{position:fixed;inset:0;z-index:2147483002;background:#05070a;display:flex;flex-direction:column;align-items:center;justify-content:center;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#eef2f6}',
    '#' + OVERLAY_ID + ' video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}',
    '#' + OVERLAY_ID + ' .qr-mask{position:absolute;inset:0;background:radial-gradient(circle at 50% 45%, transparent 0 26%, rgba(0,0,0,.62) 52%)}',
    '#' + OVERLAY_ID + ' .qr-frame{position:relative;width:min(66vw,260px);height:min(66vw,260px);border-radius:22px;box-shadow:0 0 0 9999px rgba(0,0,0,.25);border:2px solid var(--accent,#5b7cfa)}',
    '#' + OVERLAY_ID + ' .qr-frame:before,#' + OVERLAY_ID + ' .qr-frame:after{content:"";position:absolute;width:38px;height:38px;border:3px solid var(--accent,#5b7cfa);border-radius:12px}',
    '#' + OVERLAY_ID + ' .qr-frame:before{left:-3px;top:-3px;border-right:0;border-bottom:0}',
    '#' + OVERLAY_ID + ' .qr-frame:after{right:-3px;bottom:-3px;border-left:0;border-top:0}',
    '#' + OVERLAY_ID + ' .qr-top{position:absolute;left:0;right:0;top:0;display:flex;align-items:center;justify-content:space-between;padding:calc(env(safe-area-inset-top,0px) + 14px) 18px 10px;z-index:2}',
    '#' + OVERLAY_ID + ' .qr-top strong{font-size:16px}',
    '#' + OVERLAY_ID + ' button{border:1px solid #3a4350;background:rgba(20,24,30,.72);color:#eef2f6;border-radius:12px;min-height:40px;padding:8px 14px;font:inherit}',
    '#' + OVERLAY_ID + ' .qr-hint{position:absolute;left:24px;right:24px;bottom:calc(env(safe-area-inset-bottom,0px) + 42px);text-align:center;color:#c3ccd6;font-size:13px;line-height:1.6;z-index:2}',
    '#' + OVERLAY_ID + ' .qr-error{position:relative;z-index:3;max-width:320px;background:#171c22;border:1px solid #3a4350;border-radius:16px;padding:18px;text-align:center;display:flex;flex-direction:column;gap:12px}',
    '#' + OVERLAY_ID + ' .qr-error strong{font-size:16px}',
    '#' + OVERLAY_ID + ' .qr-error p{margin:0;color:#9aa5b1;font-size:13px;line-height:1.6;white-space:pre-wrap}',
  ].join('\n')
  document.head.appendChild(style)
}

async function requestCameraPermission(): Promise<void> {
  try {
    const status = await Camera.requestPermissions({ permissions: ['camera'] })
    if (status.camera === 'denied') throw new Error('相机权限被拒绝')
  } catch (error) {
    if (error instanceof Error && /拒绝|denied/i.test(error.message)) throw error
    // 浏览器 / 未装 Camera 原生插件：交给 getUserMedia 自己弹权限。
  }
}

export function openQrScanner(options: QrScannerOptions): QrScannerHandle {
  document.getElementById(OVERLAY_ID)?.remove()
  injectStyle()

  const overlay = document.createElement('div')
  overlay.id = OVERLAY_ID
  const video = document.createElement('video')
  video.setAttribute('playsinline', '')
  video.muted = true
  video.autoplay = true
  const mask = document.createElement('div')
  mask.className = 'qr-mask'
  const frame = document.createElement('div')
  frame.className = 'qr-frame'
  const top = document.createElement('div')
  top.className = 'qr-top'
  const title = document.createElement('strong')
  title.textContent = '扫码配对'
  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.textContent = '关闭'
  top.append(title, closeButton)
  const hint = document.createElement('div')
  hint.className = 'qr-hint'
  hint.textContent = '把电脑「跨设备」页的二维码放进框内'
  const canvas = document.createElement('canvas')
  canvas.style.display = 'none'
  overlay.append(video, mask, frame, top, hint, canvas)
  document.body.appendChild(overlay)

  let stream: MediaStream | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let settled = false
  let canceled = false

  const stop = (): void => {
    if (timer !== null) { clearInterval(timer); timer = null }
    if (stream) {
      for (const track of stream.getTracks()) track.stop()
      stream = null
    }
  }

  const close = (): void => {
    if (settled) return
    settled = true
    stop()
    overlay.remove()
    if (canceled) options.onCancel?.()
  }

  const finish = (text: string): void => {
    if (settled) return
    settled = true
    stop()
    overlay.remove()
    options.onResult(text)
  }

  closeButton.addEventListener('click', () => { canceled = true; close() })

  const showError = (message: string): void => {
    stop()
    overlay.replaceChildren(top, Object.assign(document.createElement('div'), { className: 'qr-error' }))
    const card = overlay.lastElementChild as HTMLElement
    const strong = document.createElement('strong')
    strong.textContent = '相机不可用'
    const paragraph = document.createElement('p')
    paragraph.textContent = message + '\n可关闭后改用「手动输入」粘贴配对链接。'
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.textContent = '重试'
    retry.addEventListener('click', () => {
      overlay.remove()
      openQrScanner(options)
    })
    card.append(strong, paragraph, retry)
    top.append(closeButton)
  }

  const start = async (): Promise<void> => {
    try {
      await requestCameraPermission()
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        throw new Error('当前 WebView 不支持摄像头')
      }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      })
      if (settled) {
        for (const track of stream.getTracks()) track.stop()
        stream = null
        return
      }
      video.srcObject = stream
      await video.play()
      if (settled) {
        for (const track of stream.getTracks()) track.stop()
        stream = null
        return
      }
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('无法创建取景画布')
      timer = setInterval(() => {
        if (settled || !stream || video.readyState < 2) return
        const width = video.videoWidth
        const height = video.videoHeight
        if (!width || !height) return
        const scale = Math.min(1, 720 / Math.max(width, height))
        canvas.width = Math.max(1, Math.round(width * scale))
        canvas.height = Math.max(1, Math.round(height * scale))
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        const image = context.getImageData(0, 0, canvas.width, canvas.height)
        const result = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' })
        if (result && result.data) finish(result.data)
      }, 140)
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法打开相机'
      showError(message)
    }
  }

  void start()
  return { close }
}