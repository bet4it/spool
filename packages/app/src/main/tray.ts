import { Tray, Menu, nativeImage, app } from 'electron'
import { join } from 'node:path'

let tray: Tray | null = null

export function setupTray(
  onShow: () => void,
  onSync: () => void,
): void {
  // macOS uses template images (auto light/dark tint). Linux doesn't
  // support template images, so use the full-color app icon instead.
  const isMac = process.platform === 'darwin'
  const iconPath = isMac
    ? join(__dirname, '../../resources/tray-iconTemplate.png')
    : join(__dirname, '../../resources/icon.png')
  let icon: ReturnType<typeof nativeImage.createFromPath>
  try {
    icon = nativeImage.createFromPath(iconPath)
    // Resize to a typical tray icon size on Linux — the 512px icon is
    // far too large for most system trays.
    if (!isMac) icon = icon.resize({ width: 22, height: 22 })
  } catch {
    icon = nativeImage.createEmpty()
  }

  tray = new Tray(icon)
  tray.setToolTip('Spool — search your thinking')

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open Spool', click: onShow },
    { type: 'separator' },
    { label: 'Sync Now', click: onSync },
    { type: 'separator' },
    { label: 'Quit Spool', click: () => app.quit() },
  ])

  tray.setContextMenu(contextMenu)
  tray.on('click', onShow)
}
