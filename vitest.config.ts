import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: [resolve(__dirname, 'src/renderer/src/__tests__/setup.ts')],
    include: [
      'src/sync/**/*.test.ts',
      'src/main/**/*.test.ts',
      'tests/unit/**/*.test.ts',
      'src/renderer/**/*.test.tsx',
      'src/renderer/**/*.test.ts',
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
      electron: resolve(__dirname, 'src/sync/__mocks__/electron.ts'),
    },
  },
})
