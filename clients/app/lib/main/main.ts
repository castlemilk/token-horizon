import { app, BrowserWindow, dialog } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { openAppWindow } from './app'
import { registerResourcesProtocol } from './protocols'
import { DaemonSupervisor, daemonExecutable } from './daemon-supervisor'

if (process.platform === 'linux') app.commandLine.appendSwitch('password-store', 'gnome-libsecret')

app.setName('Token Horizon')

// A second desktop launch focuses the existing window and never starts another core.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let daemon: DaemonSupervisor | undefined
  let quitting = false
  let ready = false

  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (window) {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    }
  })

  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  app
    .whenReady()
    .then(async () => {
      electronApp.setAppUserModelId('dev.token-horizon.desktop')
      registerResourcesProtocol()
      daemon = new DaemonSupervisor({
        executable: daemonExecutable({
          packaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          appPath: app.getAppPath(),
          platform: process.platform,
          override: process.env.TOKEN_HORIZON_DAEMON_BIN,
        }),
        onUnexpectedExit: (message) => {
          dialog.showErrorBox('Token Horizon local core stopped', message)
          app.quit()
        },
      })
      try {
        await daemon.start()
        ready = true
        if (!quitting) openAppWindow()
      } catch (error) {
        if (!quitting) {
          dialog.showErrorBox('Token Horizon could not start', error instanceof Error ? error.message : String(error))
          app.quit()
        }
      }
    })
    .catch((error) => {
      dialog.showErrorBox('Token Horizon could not start', String(error))
      app.quit()
    })

  app.on('activate', () => {
    if (ready && !quitting && BrowserWindow.getAllWindows().length === 0) openAppWindow()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // Attached services belong to their original owner; stop() only terminates our child.
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void (daemon?.stop() ?? Promise.resolve()).finally(() => app.quit())
  })
}
