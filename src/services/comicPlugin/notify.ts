/**
 * 桌面端下载完成通知 (Web Notification API)。
 *
 * WebView2 完整支持 Notification; 首次弹会向用户申请权限, 拒绝后静默跳过。
 * 移动端 WebView 通常不支持, 直接 no-op, 不报错。
 */

let granted: NotificationPermission | '' = ''

function supported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

/** 确保有权限 (首次会请求), 返回是否可发 */
async function ensurePermission(): Promise<boolean> {
  if (!supported()) return false
  if (granted === 'granted') return true
  if (granted === 'denied') return false
  if (Notification.permission === 'granted') { granted = 'granted'; return true }
  if (Notification.permission === 'denied') { granted = 'denied'; return false }
  try {
    granted = await Notification.requestPermission()
  } catch {
    granted = 'denied'
  }
  return granted === 'granted'
}

/** 下载完成通知; 失败静默 (通知不是关键路径) */
export async function notifyDownloadDone(title: string, body?: string): Promise<void> {
  if (!(await ensurePermission())) return
  try {
    const n = new Notification(title, { body, silent: true })
    // 点击通知聚焦到应用 (桌面端 WebView 尽力而为)
    n.onclick = () => { try { window.focus() } catch { /* noop */ } }
    // 几秒后自动关, 避免通知堆积
    setTimeout(() => { try { n.close() } catch { /* noop */ } }, 8000)
  } catch { /* noop */ }
}
