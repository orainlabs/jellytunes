import type { Config } from 'tailwindcss'

export default {
  content: ['./src/renderer/**/*.{js,ts,jsx,tsx,html}'],
  theme: {
    extend: {
      colors: {
        jf: {
          purple: '#AA5CC3',
          'purple-dark': '#8B3FA8',
          'purple-light': '#C47BD6',
          cyan: '#00A4DC',
          'cyan-dark': '#0083B0',
        }
      }
    }
  },
  plugins: []
} satisfies Config
