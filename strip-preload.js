// 작업표시줄 글자 띠 창 전용 preload — 받는 것(표시 내용·생존 신호)과 보내는 것(글자 폭·클릭)만 연다
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stripAPI', {
  onModel: (cb) => ipcRenderer.on('strip-model', (_event, model) => cb(model)),
  onHeartbeat: (cb) => ipcRenderer.on('strip-heartbeat', () => cb()),
  reportWidth: (width) => ipcRenderer.send('strip-size', width),
  click: () => ipcRenderer.send('strip-click'),
  contextMenu: () => ipcRenderer.send('strip-context')
});
