import { Before, After, Status } from '@cucumber/cucumber';
import { ICustomWorld } from './world';
import { launchApp, closeApp, getMainWindow } from './app-launcher';

Before(async function (this: ICustomWorld) {
  // Iniciar la aplicación Electron
  this.app = await launchApp();
  this.page = await getMainWindow(this.app);
  this.testData = {};
  
  // Limpiar localStorage antes de cada test
  await this.page.evaluate(() => {
    localStorage.clear();
  });
});

After(async function (this: ICustomWorld, scenario) {
  // Tomar screenshot si el test falló
  if (scenario.result?.status === Status.FAILED && this.page) {
    const screenshot = await this.page.screenshot({
      path: `./tests/bdd/screenshots/${scenario.pickle.name.replace(/\s+/g, '_')}.png`,
      fullPage: true,
    });
    this.attach(screenshot, 'image/png');
  }
  
  // Cerrar la aplicación
  if (this.app) {
    await closeApp(this.app);
  }
  
  this.app = undefined;
  this.page = undefined;
});