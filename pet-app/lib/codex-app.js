import { createRequire } from 'node:module';
import { join } from 'node:path';

// Packaged Electron always enters package.main, including the DPI child process.
if (process.env.DSH_PET_DPI_PROBE === '1') {
  const { app, screen } = createRequire(import.meta.url)('electron');
  app.disableHardwareAcceleration();
  if (process.env.DSH_PET_CODEX_DATA) {
    app.setPath('userData', join(process.env.DSH_PET_CODEX_DATA, 'dpi-profile'));
  }
  app.whenReady().then(() => {
    process.stdout.write(
      `dsh-pet-primary-scale:${screen.getPrimaryDisplay().scaleFactor}\n`,
      () => app.exit(0),
    );
  });
} else {
  await import('./app.js');
}
