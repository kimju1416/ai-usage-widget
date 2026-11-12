// 작업표시줄 글자 띠 창 전용 preload — 받는 것(표시 내용·생존 신호)과 보내는 것(글자 폭·클릭)만 연다
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stripAPI', {
  onModel: (cb) => ipcRenderer.on('strip-model', (_event, model) => cb(model)),
  onHeartbeat: (cb) => ipcRenderer.on('strip-heartbeat', () => cb()),
  reportWidth: (width) => ipcRenderer.send('strip-size', width),
  click: () => ipcRenderer.send('strip-click'),
  contextMenu: () => ipcRenderer.send('strip-context'),
  // 마우스 올림 안내 창(v1.0.27): 글자 띠는 올림/뗌을 알리고, 안내 창은 내용을 받아 제 크기를 알린다
  hover: (on) => ipcRenderer.send('strip-hover', !!on),
  onPop: (cb) => ipcRenderer.on('strip-pop-model', (_event, model) => cb(model)),
  reportPopSize: (w, h) => ipcRenderer.send('strip-pop-size', { w, h })
});
