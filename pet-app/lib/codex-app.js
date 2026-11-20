import { createRequire } from 'node:module';
import { join } from 'node:path';

const dataDir = process.env.DSH_PET_CODEX_DATA;

// Packaged Electron always enters package.main, including the DPI child process.
if (process.env.DSH_PET_DPI_PROBE === '1') {
  const { app, screen } = createRequire(import.meta.url)('electron');
  app.disableHardwareAcceleration();
  if (dataDir) {
    app.setPath('userData', join(dataDir, 'dpi-profile'));
  }
  app.whenReady().then(() => {
    process.stdout.write(
      `dsh-pet-primary-scale:${screen.getPrimaryDisplay().scaleFactor}\n`,
      () => app.exit(0),
    );
  });
} else {
  // app.js takes the Electron single-instance lock before loading the helper.
  if (dataDir) {
    const { app } = createRequire(import.meta.url)('electron');
    app.setPath('userData', join(dataDir, 'electron-profile'));
  }
  await import('./app.js');
}
