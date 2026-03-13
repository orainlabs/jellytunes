const config = {
  default: {
    format: ['progress', 'html:./tests/bdd/reports/cucumber-report.html'],
    formatOptions: {
      snippetInterface: 'async-await',
    },
    paths: ['tests/bdd/features/**/*.feature'],
    require: ['tests/bdd/steps/**/*.ts', 'tests/bdd/support/**/*.ts'],
    requireModule: ['ts-node/register'],
    publishQuiet: true,
    worldParameters: {
      headless: true,
    },
  },
  
  // Perfil para desarrollo (con UI visible)
  dev: {
    worldParameters: {
      headless: false,
      slowMo: 100,
    },
  },
  
  // Perfil para CI (modo headless)
  ci: {
    format: ['json:./tests/bdd/reports/cucumber-report.json'],
    worldParameters: {
      headless: true,
    },
  },
};

module.exports = config;