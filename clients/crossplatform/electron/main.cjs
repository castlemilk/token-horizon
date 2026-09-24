// Minimal Electron shell for the cross-platform port. Dev loads the Vite
// server (ELECTRON_DEV_URL, retried until it answers); packaged/prod loads
// the built dist/index.html. The renderer is a plain web app — no preload,
// no IPC, all daemon traffic is plain fetch to 127.0.0.1.
const { app, BrowserWindow } = require('electron')
const { join } = require('path')
const http = require('http')

const DEV_URL = process.env.ELECTRON_DEV_URL

function waitFor(url, tries = 60) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      http
        .get(url, (res) => {
          res.resume()
          resolve()
        })
        .on('error', () => {
          if (n <= 0) return reject(new Error(`${url} never came up`))
          setTimeout(() => attempt(n - 1), 500)
        })
    }
    attempt(tries)
  })
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1240,
    height: 780,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: '#0e1011',
    title: 'Token Horizon',
    webPreferences: { sandbox: true },
  })
  win.once('ready-to-show', () => win.show())

  if (DEV_URL) {
    await waitFor(DEV_URL)
    await win.loadURL(DEV_URL)
  } else {
    await win.loadFile(join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  void createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
