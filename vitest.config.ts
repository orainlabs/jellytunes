import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    // Default timeout for tests using user.type() with long strings in jsdom
    testTimeout: 15000,
    // Default environment for tests that don't match environmentMatchGlobs
    environment: 'jsdom',
    // Setup file for jsdom tests (renderer components)
    setupFiles: [resolve(__dirname, 'src/renderer/src/__tests__/setup.ts')],
    include: [
      'src/sync/**/*.test.ts',
      'src/main/**/*.test.ts',
      'tests/unit/**/*.test.ts',
      'src/renderer/**/*.test.tsx',
      'src/renderer/**/*.test.ts',
    ],
    // Node environment for pure logic tests - no jsdom overhead
    environmentMatchGlobs: [
      // sync module tests - pure Node, no DOM needed
      ['src/sync/**/*.test.ts', 'node'],
      // main process tests - pure Node, no DOM needed
      ['src/main/**/*.test.ts', 'node'],
      // unit tests - mostly pure logic, no DOM needed
      ['tests/unit/**/*.test.ts', 'node'],
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*'],
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
      '@main': resolve(__dirname, 'src/main'),
      '@preload': resolve(__dirname, 'src/preload'),
      '@ffmpeg-installer/ffmpeg': resolve(__dirname, 'src/sync/__mocks__/ffmpeg-installer.ts'),
      'electron': resolve(__dirname, 'src/sync/__mocks__/electron.ts'),
    },
  },
});
