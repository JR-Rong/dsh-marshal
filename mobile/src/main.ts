import './styles.css'
import { start } from './app.ts'

async function boot(): Promise<void> {
  try {
    await start()
  } catch (error) {
    const app = document.getElementById('app')
    if (!app) return
    app.replaceChildren()
    const box = document.createElement('div')
    box.className = 'card'
    box.textContent = '启动失败：' + (error instanceof Error ? error.message : '未知错误')
    app.append(box)
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { void boot() }, { once: true })
} else {
  void boot()
}
