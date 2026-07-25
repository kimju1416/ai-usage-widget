const { contextBridge, ipcRenderer } = require('electron');
const { spawn } = require('child_process');

contextBridge.exposeInMainWorld('widgetAPI', {
  onUsageData: (cb) => ipcRenderer.on('usage-data', (_event, data) => cb(data)),
  refreshNow: () => ipcRenderer.send('refresh-now'),
  openLogin: (provider) => ipcRenderer.send('open-login', provider),
  // 메인 프로세스가 멈춰서 IPC(새로고침 등)조차 응답 없을 때 쓰는 최후 수단.
  // 메인을 거치지 않고 OS 명령으로 직접 기존 인스턴스를 전부 종료한 뒤 새로 실행한다.
  forceRestart: () => {
    const exePath = process.execPath;
    spawn('cmd.exe', [
      '/c',
      `taskkill /F /IM AIUsageWidget.exe /T & timeout /t 1 /nobreak >nul & start "" "${exePath}"`
    ], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
});
