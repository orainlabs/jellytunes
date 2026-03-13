import { setWorldConstructor, World, IWorldOptions } from '@cucumber/cucumber';
import { ElectronApplication, Page, BrowserContext } from 'playwright';

export interface ICustomWorld extends World {
  app?: ElectronApplication;
  page?: Page;
  context?: BrowserContext;
  testData?: Record<string, unknown>;
}

export class CustomWorld extends World implements ICustomWorld {
  app?: ElectronApplication;
  page?: Page;
  context?: BrowserContext;
  testData: Record<string, unknown> = {};

  constructor(options: IWorldOptions) {
    super(options);
  }
}

setWorldConstructor(CustomWorld);