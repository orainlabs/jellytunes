import { _electron as electron, ElectronApplication, Page } from 'playwright';
import * as path from 'path';

let electronApp: ElectronApplication | null = null;

export async function launchApp(): Promise<ElectronApplication> {
  // Path al directorio raíz del proyecto
  const projectPath = path.resolve(__dirname, '../../../');
  
  electronApp = await electron.launch({
    args: [path.join(projectPath, 'dist/main/index.js')],
    cwd: projectPath,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      BDD_TEST: 'true',
    },
  });

  return electronApp;
}

export async function getMainWindow(app: ElectronApplication): Promise<Page> {
  // Esperar a que se cree la primera ventana
  await app.firstWindow();
  
  // Obtener todas las ventanas y retornar la primera
  const windows = app.windows();
  const mainWindow = windows[0];
  
  // Esperar a que la ventana esté lista
  await mainWindow.waitForLoadState('domcontentloaded');
  
  return mainWindow;
}

export async function closeApp(app: ElectronApplication): Promise<void> {
  if (app) {
    await app.close();
  }
}

export async function restartApp(): Promise<{ app: ElectronApplication; page: Page }> {
  if (electronApp) {
    await electronApp.close();
  }
  const newApp = await launchApp();
  const page = await getMainWindow(newApp);
  return { app: newApp, page };
}