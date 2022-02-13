'use strict'

import { app, protocol, BrowserWindow, Menu, ipcMain, dialog, shell, screen, nativeTheme } from 'electron'
import { createProtocol } from 'vue-cli-plugin-electron-builder/lib'
import installExtension, { VUEJS3_DEVTOOLS } from 'electron-devtools-installer'
import compareVersions from 'compare-versions'
import { v4 as uuidv4 } from 'uuid'
import Analytics from 'analytics'
import googleAnalytics from '@analytics/google-analytics'
const log = require('electron-log')
const { networkInterfaces, hostname } = require('os')
const axios = require('axios')
const Store = require('electron-store')
const path = require('path')
const menu = require('./menu.js').menu

// Project specific includes
const fs = require('fs')
const say = require('say')
var sizeOf = require('image-size')
import { Server } from 'node-osc';

const store = new Store({
  migrations: {
    '<1.2.0': store => {
      store.delete('KardsConfig')
      log.info('Resetting to default settings due to upgrade')
    }
  }
})


//======================================//
//      BOILER PLATE ELECTRON STUFF     //
//======================================//
const isDevelopment = process.env.NODE_ENV !== 'production'

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { secure: true, standard: true } }
])

process.on('uncaughtException', function (error) {
  if (isDevelopment) {
    dialog.showErrorBox('Unexpected Error', error + '\r\n\r\n' + JSON.stringify(error))
  }
  log.warn('Error: ', error)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on('ready', async () => {
  if (isDevelopment && !process.env.IS_TEST) {
    try {
      await installExtension(VUEJS3_DEVTOOLS)
    } catch (e) {
      console.error('Vue Devtools failed to install:', e.toString())
    }
  }
  createWindow()
})

if (isDevelopment) {
  if (process.platform === 'win32') {
    process.on('message', (data) => {
      if (data === 'graceful-exit') {
        app.quit()
      }
    })
  } else {
    process.on('SIGTERM', () => {
      app.quit()
    })
  }
}



//==========================//
//       CONFIG OBJECT      //
//==========================//
let config
app.on('ready', function() {
  log.info('Launching Kards')
  config = store.get('KardsConfig', getDefaultConfig())
  config.visible = false
  config.audio.enabled = false
  log.info('Loaded Config')
})
ipcMain.on('config', (_, arg) => {
  config = arg
  manageTestCardWindow()
  // updateAnalytics()
  if (testCardWindow != null) { 
    testCardWindow.webContents.send('config', config)
    if (config.windowed) {
      testCardWindow.setContentSize(parseInt(config.winWidth), parseInt(config.winHeight))
    }
  }
  // touchBar.setConfig(config)
  store.set('KardsConfig', config)
})
ipcMain.on('getConfigTestCard', () => {
  testCardWindow.webContents.send('config', config)
})

ipcMain.on('getConfigControl', () => {
  controlWindow.webContents.send('config', config)
  controlWindow.webContents.send('darkMode', nativeTheme.shouldUseDarkColors)
})

ipcMain.on('resetDefault', () => {
  controlWindow.webContents.send('config', getDefaultConfig())
  analytics.track("Reset Defaults")
  log.info('Resetting to default')
  createVoice()
})

function getDefaultConfig() {
  let defaultConfig = require('./defaultConfig.json')
  defaultConfig.name = require('os').hostname().split('.')[0].replace(/([a-z\xE0-\xFF])([A-Z\xC0\xDF])/g, "$1 $2").replace(/-|_|\.|\||\+|=|~|<|>|\/|\\/g, ' ')
  defaultConfig.screen = screen.getPrimaryDisplay().id
  return defaultConfig
}





//==========================//
//       WINDOW HANDLER     //
//==========================//
let controlWindow
let testCardWindow
let testCardWindowScreen

async function createWindow() {
  log.info('Showing control window')
  controlWindow = new BrowserWindow({
    width: 620,
    height: 450,
    show: false,
    useContentSize: true,
    maximizable: false,
    resizable: false,
    webPreferences: {
      nodeIntegration: process.env.ELECTRON_NODE_INTEGRATION,
      contextIsolation: !process.env.ELECTRON_NODE_INTEGRATION,
      preload: path.join(__dirname, 'preload.js')
    }
  })

  controlWindow.once('ready-to-show', () => {
    controlWindow.show()
  })

  if (process.platform == 'darwin') {
    Menu.setApplicationMenu(menu)
  } else {
    Menu.setApplicationMenu(null)
  }

  if (process.env.WEBPACK_DEV_SERVER_URL) {
    await controlWindow.loadURL(process.env.WEBPACK_DEV_SERVER_URL)
    if (!process.env.IS_TEST) controlWindow.webContents.openDevTools()
    // log.debug("THIS MEANS THE OTHER THING TO THE OTHER LINE: ", process.env.WEBPACK_DEV_SERVER_URL)
  } else {
    createProtocol('app')
    controlWindow.loadURL('app://./index.html')
    // log.debug("THIS IS A MESSAGE FOR DREW!")
  }
}
ipcMain.on('controlResize', (_, data) => {
  controlWindow.setContentSize(675, data.height)
})


//========================//
//   Screen Management    //
//========================//
let screens
let primaryScreen

function updateScreens() {
  screens = screen.getAllDisplays()
  primaryScreen = screen.getPrimaryDisplay().id

  if (controlWindow != null) {
    controlWindow.webContents.send('screens', {all: screens, primary: primaryScreen})  
  }
  if (testCardWindow != null) {
    for (const scr in screens) {
      if (screens[scr].id == config.screen) {
        testCardWindow.webContents.send('displayFrequency', screens[scr].displayFrequency)   
      }
    }
  }
}
ipcMain.on('getScreens', () => {
  updateScreens()
})
app.on('ready', function() {
  updateScreens()

  screen.on('display-added', function() {
    setTimeout(updateScreens, 500)
  })
  screen.on('display-removed', function() {
    setTimeout(updateScreens, 500)
  })
  screen.on('display-metrics-changed', function() {
    setTimeout(updateScreens, 500)
  })
})



//=====================//
//       Analytics     //
//=====================//
const analytics = Analytics({
  app: 'Kards',
  version: 100,
  plugins: [
    googleAnalytics({
      trackingId: 'UA-183734846-4',
      tasks: {
        // Set checkProtocolTask for electron apps & chrome extensions
        checkProtocolTask: null,
      }
    })
  ]
})
app.on('ready', async () => {
  if (!store.has('KardsInstallID-1.2')) {
    let newId = uuidv4()
    log.info('First Runtime and created Install ID: ' + newId)
    store.set('KardsInstallID-1.2', newId)
  } else {
    log.info('Install ID: ' + store.get('KardsInstallID-1.2'))
  }

  analytics.identify(store.get('KardsInstallID-1.2'), {
    firstName: 'Version',
    lastName: require('./../package.json').version
  }, () => {
    console.log('do this after identify')
  })

  analytics.track('AppLaunched')
})


//========================//
//       IPC Handlers     //
//========================//
ipcMain.on('closeTestCard', (_, arg) => {
  controlWindow.webContents.send('closeTestCard')
})

ipcMain.on('openLogs', () => {
  const path = log.transports.file.findLogPath()
  shell.showItemInFolder(path)
  analytics.track('Open Logs')
})

ipcMain.on('openUrl', (_, arg) => {
  shell.openExternal(arg)
  log.info('open url', arg)
})

ipcMain.on('networkInfo', (event) => {
  const nets = networkInterfaces();
  const results = [hostname().split('.')[0]]

  for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
          if (net.family === 'IPv4' && !net.internal) {
              results.push(name + ': ' + net.address)
          }
      }
  }
  testCardWindow.webContents.send('networkInfo', results)
})





//==========================//
//   Test Card Management   //
//==========================//
function manageTestCardWindow() {
  if (testCardWindow == null && config.visible) { // Test card doesn't exist, but now needs to
    setupNewTestCardWindow()
  } else if (testCardWindow != null && !config.visible && !headlessExportMode) { // A window exists and shouldn't so lets close it
    closeTestCard()
  } else if (testCardWindow != null && config.visible && config.screen != testCardWindowScreen) { // a different screen as been selected..
    moveTestCardToNewScreen()
  } else if (testCardWindow != null) {
    if (testCardWindow.isFullScreen() || testCardWindow.isSimpleFullScreen()) {
      if (config.windowed) { // A full screen test card now needs to be windowed - hard to handle elegantly so close and reopen
        reopenTestCard()
      }
    } else if (!testCardWindow.isFullScreen() && !testCardWindow.isSimpleFullScreen()) {
      if (!config.windowed) { // A windowed test card now needs to be full screen. 
        reopenTestCard()
      }
    }
  }
}

function setupNewTestCardWindow() {
  let windowConfig = {show: false, frame: false, width: config.winWidth, height: config.winHeight, webPreferences: {preload: path.join(__dirname, 'preload.js')}}  
  
  if (!config.windowed) { // Setting up for full screen test card
    windowConfig.fullscreen = true

    for (const disp of screen.getAllDisplays()) {
      if (disp.id == config.screen) {
          if (process.platform == 'darwin') {

            // figure out if it's newer macos...
            let version = process.getSystemVersion().split('.')
            let catalina = false
            if (version[0] > 10) {
              catalina = true
            }
            if (version[0] == 10 && version[1] >= 15) {
              catalina = true
            }

            if (disp.bounds.height != disp.workArea.height && catalina) {
              log.info('Running in seperate spaces mode - this is Catalina or newer')
              windowConfig.simpleFullscreen = false 
            } else if (!catalina) {
              log.info('Using legacy full screen mode as this is not Catalina (or newer)')
              windowConfig.simpleFullscreen = true 
            } else {
              log.info('Using legacy full screen mode')
              windowConfig.simpleFullscreen = true 
            }
          } else {
            log.info('Using windows full screen system. Easy.')
          }
        windowConfig.x = disp.bounds.x
        windowConfig.y = disp.bounds.y
        windowConfig.width = disp.bounds.width
        windowConfig.height = disp.bounds.height
      }
    }
  } else {
    for (const disp of screen.getAllDisplays()) {
      if (disp.id == config.screen) {
        windowConfig.x = disp.bounds.x + (disp.bounds.width - config.winWidth)/2
        windowConfig.y = disp.bounds.y + (disp.bounds.height - config.winHeight)/2
      }
    }
  }
  showTestCardWindow(windowConfig)
}

function closeTestCard() {
  log.info('Closing test card')
  testCardWindow.close()
  testCardWindowScreen = null
  clearTimeout(testCardWindowResizeTimer)
}

function reopenTestCard() {
  closeTestCard()
  config.visible = true
  log.info('Setting timer to re-open test card')
  setTimeout(manageTestCardWindow, 500) 
}

function moveTestCardToNewScreen() {
  if (config.windowed) {
    for (const disp of screen.getAllDisplays()) {
      if (disp.id == config.screen) {
          testCardWindowScreen = disp.id
      }
    }
  } else {
    reopenTestCard()
  }  
}

ipcMain.on('moveWindowTo', (_, arg) => {
  log.info('Move active window to screen: ', arg)
  for (const disp of screen.getAllDisplays()) {
    if (disp.id == arg) {
        testCardWindowScreen = disp.id
        let x = disp.bounds.x + (disp.bounds.width - config.winWidth)/2
        let y = disp.bounds.y + (disp.bounds.height - config.winHeight)/2
        testCardWindow.setPosition(Math.round(x), Math.round(y))
    }
  }
})

function showTestCardWindow(windowConfig) {
  log.info('Showing test card with config: ', windowConfig)  

  testCardWindow = new BrowserWindow(windowConfig)
  testCardWindowScreen = config.screen

  testCardWindow.on('close', function () { 
    testCardWindow = null 
  })

  if(config.windowed || headlessExportMode){
    testCardWindow.setBounds({ width: windowConfig.width, height: windowConfig.height })
  }

  if (process.env.WEBPACK_DEV_SERVER_URL) {
    testCardWindow.loadURL(process.env.WEBPACK_DEV_SERVER_URL + '#/testcard')
    if (!process.env.IS_TEST) testCardWindow.webContents.openDevTools()
  } else {
    createProtocol('app')
    testCardWindow.loadURL('app://./index.html')
  }

  testCardWindow.once('ready-to-show', () => {
    if (config.visible && !headlessExportMode) {
      testCardWindow.show()
    }
  })

  testCardWindow.on('resize', function() {
    clearTimeout(testCardWindowResizeTimer)
    testCardWindowResizeTimer = setTimeout(handleTestCardResize, 500)
  })

  testCardWindow.on('move', function() {
    let x = testCardWindow.getBounds().x
    let y = testCardWindow.getBounds().y

    for (const disp of screen.getAllDisplays()) {
      if (x > disp.bounds.x && x < (disp.bounds.x + disp.bounds.width) && y > disp.bounds.y && y < (disp.bounds.y + disp.bounds.height)) {
        if (testCardWindowScreen!=disp.id) {
          config.screen = disp.id
          controlWindow.webContents.send('config', config)
        }
      }
    }
  })
}

function handleTestCardResize() {
  let bounds = testCardWindow.getBounds()
  let t = 2
  if (config.winWidth < (bounds.width-t) || config.winWidth > (bounds.width+t) || config.winHeight < (bounds.height-t) || config.winHeight > (bounds.height+t) || process.platform == 'darwin') {
    config.winWidth = bounds.width
    config.winHeight = bounds.height
    controlWindow.webContents.send('config', config)
  }
}
let testCardWindowResizeTimer












//========================//
//   Export PNG Images    //
//========================//
let headlessExportMode = false

ipcMain.on('testCardKeyPress', (_, msg) => {
  console.log('testCardKeyPress', msg)
  config[msg] = !config[msg]
  controlWindow.webContents.send('config', config)
  testCardWindow.webContents.send('config', config)
})

ipcMain.on('exportCard', () => {
  if (testCardWindow != null) {
    testCardWindow.webContents.send('exportCard')
    // Nucleus.track("Exported Card", {  type: config.export.target, imageSource: config.export.imageSource, size: testCardWindow.getBounds().width + 'x' + testCardWindow.getBounds().height, windowed: config.windowed, cardType: config.cardType, headless: false })
  } else {
    headlessExportMode = true
    let c = {show: false, frame: false, width: config.winWidth, height: config.winHeight, webPreferences: {preload: path.join(__dirname, 'preload.js')}}

    if (config.windowed) {
      c.minWidth = config.winWidth
      c.minHeight = config.winHeight
    } else {
      for (const disp of screen.getAllDisplays()) {
        if (disp.id == config.screen) {
          c.width = disp.bounds.width
          c.height = disp.bounds.height
          c.minWidth = disp.bounds.width
          c.minHeight = disp.bounds.height
        }
      }
    } 
    showTestCardWindow(c) 
    log.info('Creating dummy test card window to capture image')
    // Nucleus.track("Exported Card", { type: config.export.target, imageSource: config.export.imageSource, size: c.width + 'x' + c.height, windowed: config.windowed, cardType: config.cardType, headless: true })
  }
})

ipcMain.on('selectImage', () => {
  let result = dialog.showOpenDialogSync({ title: "Select Image", properties: ['openFile'], filters: [{name: 'Images', extensions: ['jpeg', 'jpg', 'png', 'gif']}] })
  if (result != null) {
    let data = fs.readFileSync(result[0], { encoding: 'base64' })
    let mime = require('mime').getType(result[0])
    config.alteka.logo = 'data:' + mime + ';base64,' + data
    controlWindow.webContents.send('config', config)
  } else {
    log.info('No file selected')
  }
})

ipcMain.on('saveAsPNG', (_, arg) => {
  headlessExportMode = false
  dialog.showSaveDialog(controlWindow, {title: 'Save PNG', defaultPath: 'TestKard.png', filters: [{name: 'Images', extensions: ['png']}]}).then(result => {
    if (!result.canceled) {
      var base64Data = arg.replace(/^data:image\/png;base64,/, "")
      fs.writeFile(result.filePath, base64Data, 'base64', function(err) {
        if (err) {
          dialog.showErrorBox('Error Saving File', JSON.stringify(err))
          log.error('Couldnt save file: ', err)
          controlWindow.webContents.send('exportCardCompleted', 'Could Not Write File')
        } else {
          let dims = sizeOf(result.filePath)
          log.info('PNG saved to: ', result.filePath, ' - With dimensions: ', dims.width, 'x', dims.height)
          controlWindow.webContents.send('exportCardCompleted')
        }
      })
    } else {
      log.info('Save dialog closed')
      controlWindow.webContents.send('exportCardCompleted', 'File Save Cancelled')
    }
  })
  if (!config.visible) {
    log.info('Closing dummy test card window')
    testCardWindow.close()
  }
})

ipcMain.on('setAsWallpaper', (_, arg) => {
  headlessExportMode = false
  let dest = app.getPath('userData') + '/wallpaper' + Math.round((Math.random()*100000)) + '.png'
  var base64Data = arg.replace(/^data:image\/png;base64,/, "")
  fs.writeFile(dest, base64Data, 'base64', err => {
    if (err) {
      dialog.showErrorBox('Error Saving Wallpaper', JSON.stringify(err))
      log.error('Couldnt save wallpaper file ', err)
      controlWindow.webContents.send('exportCardCompleted', 'Could not write temporary file')
      return
    }
    (async () => {
      await wallpaper.set(dest)
      let dims = sizeOf(dest)
      log.info('Setting png as wallpaper with dims: ' + dims.width + 'x' + dims.height)
      controlWindow.webContents.send('exportCardCompleted')
      })();
    })
    if (!config.visible) {
      log.info('Closing dummy test card window')
      testCardWindow.close()
    }
  })







//========================//
//    Voice Generation    //
//========================//
setTimeout(createVoice, 5000)
setTimeout(createTextAudio, 5000)
ipcMain.on('createVoice', () => {
  createVoice()
})
ipcMain.on('updateAudioText', () => {
  createTextAudio()
})
ipcMain.on('loadAudioFile', () => {
  loadAudioFile()
})
function createVoice() {
  let dest = app.getPath('userData') + '/voice.wav'  
  say.export(config.audio.prependText + config.name, null, null, dest, (err) => {
    if (err) {
      return console.error(err)
    }
    log.info('Updated name (' + config.name + ') has been saved to ', dest)
    config.audio.voiceData = 'data:audio/wav;base64,' + fs.readFileSync(dest, {encoding: 'base64'})
    controlWindow.webContents.send('config', config)
  })
}
function createTextAudio() {
  let dest = app.getPath('userData') + '/text.wav'  
  say.export(config.audio.text, null, null, dest, (err) => {
    if (err) {
      return console.error(err)
    }
    log.info('Updated audio text (' + config.audio.text + ') has been saved to ', dest)
    config.audio.textData = 'data:audio/wav;base64,' + fs.readFileSync(dest, {encoding: 'base64'})
    controlWindow.webContents.send('config', config)
  })
}
function loadAudioFile() {
  dialog.showOpenDialog(controlWindow, {title: 'Open Audio File', filters: [{name: "Audio", extensions: ['wav', 'mp3', 'ogg', 'aac']}]}).then(result => {
    if (!result.canceled) {
      let path = result.filePaths[0]
      config.audio.fileData = 'data:audio/' + path.split('.').pop() + ';base64,' + fs.readFileSync(path, {encoding: 'base64'})
      config.audio.fileName = 'Opened ' + path
      controlWindow.webContents.send('config', config)
    } else {
      log.info('Save dialog closed')
    }
  })
}


//============================//
//   Import/Export Settings   //
//============================//
ipcMain.on('exportSettings', (event, arg) => {
  dialog.showSaveDialog(controlWindow, {title: 'Export Settings', buttonLabel: 'Export', defaultPath: 'KardsSettings.json', filters: [{extensions: ['json']}]}).then(result => {
    if (!result.canceled) {
      let path = result.filePath
      let cfg = config
      cfg.audio.voiceData = '' // clear this out as it can be easily rebuilt    
      cfg.audio.textData = '' // clear this out as it can be easily rebuilt    
      cfg.createdBy = 'Kards'
      cfg.exportedVersion = require('./../package.json').version

      let data = JSON.stringify(cfg, null, 2)

      fs.writeFile(path, data, function(err) {
        if (err) {
          dialog.showErrorBox('Error Saving File', JSON.stringify(err))
          log.error('Couldnt save file: ', err)
        } else {
          log.info('JSON saved to: ', path)
          Nucleus.track("Settings Exported")
        }
      })
    } else {
      log.info('Save dialog closed')
    }
  })
})

ipcMain.on('importSettings', (event, arg) => {
  let result = dialog.showOpenDialogSync({ title: "Import Settings", properties: ['openFile'], filters: [{name: 'JSON', extensions: ['json', 'JSON']}]})
  if (result != null) {
    fs.readFile(result[0], (err, data) => {
      if (err) throw err;
      let d = JSON.parse(data)
      let count = 0

      if (d.createdBy == 'Kards') {
        if (d.exportedVersion == require('./../package.json').version) {
          for (let key in config) {
            if (d[key] != undefined && key != 'visible' && key != 'exportedVersion' && key != 'createdBy' && typeof d[key] === typeof config[key]) {
              config[key] = d[key]
              count++
            }
          }
          createVoice() // recreate voice data after importing settings.
          createTextAudio() 
          controlWindow.webContents.send('config', config)
          controlWindow.webContents.send('importSettings', 'Imported ' + count + ' settings')
          Nucleus.track("Settings Imported", { count: count })
        } else {
          controlWindow.webContents.send('importSettings', 'Skipping - The file is from a different version of Kards')  
        }
      } else {
        controlWindow.webContents.send('importSettings', 'Failed - That file was not made by Kards')
      }
    })
  } else {
    log.info('No file selected')
  }
})


var oscServer = new Server(25518, '0.0.0.0', () => {
  console.log('OSC Server is listening on port 25518')
})

oscServer.on('message', function (msg) {
  let cmd = msg[0]
  let data = msg[1]

  switch(cmd) {
    case '/animated', '/motion':
      config.animated = Boolean(data)
      break;

    case '/showInfo':
      config.showInfo = Boolean(data)
      break;

    case '/name':
      config.name = String(data)
      break;

    case '/cardType':
      config.cardType = String(data)
      break;
  }

  controlWindow.webContents.send('config', config)
})


//========================//
//     Update Checker     //
//========================//
setTimeout(function() {
  axios.get('https://api.github.com/repos/alteka/kards/releases/latest')
    .then(function (response) {
      let status = compareVersions(response.data.tag_name, require('./../package.json').version, '>')
      if (status == 1) { 
        dialog.showMessageBox(controlWindow, {
          type: 'question',
          title: 'An Update Is Available',
          message: 'Would you like to download version: ' + response.data.tag_name,
          buttons: ['Cancel', 'Yes']
        }).then(function (response) {
          if (response.response == 1) {
            shell.openExternal('https://alteka.solutions/kards')
            analytics.track("Open Update Link")
          }
        });
      } else if (status == 0) {
        log.info('Running latest version')
      } else if (status == -1) {
        log.info('Running version newer than release')
      }
    })
    .catch(function (error) {
      console.log(error);
    })
  }, 10000)