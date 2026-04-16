import type { Config } from 'tailwindcss'

export default {
  content: ['./src/renderer/**/*.{js,ts,jsx,tsx,html}'],
  theme: {
    extend: {
      colors: {
        // ── Semantic tokens (Phase 1) ──────────────────────────
        primary: '#cdbdff',
        primary_container: '#7c4dff',
        secondary_container: '#4e3b8c',
        secondary: '#26c6da',
        tertiary_container: '#b55800',
        surface: '#12121e',
        surface_container_low: '#1a1a27',
        surface_container_high: '#252335',
        surface_container_highest: '#343341',
        surface_bright: '#383845',
        on_surface: '#e5e0ef',
        on_surface_variant: '#cac3d8',
        on_primary_container: '#ffffff',
        outline_variant: '#494455',
        error: '#cf6679',
        error_container: '#3d1a22',
        warning: '#e8a328',
        warning_container: '#2e2006',
        success: '#4caf82',
      },
      backgroundImage: {
        'gradient-primary': 'linear-gradient(to bottom right, #7c4dff, #4e3b8c)',
      },
      keyframes: {
        shimmer: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
        sizeSquarePulse: {
          '0%, 100%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(0.55)' },
        },
      },
      animation: {
        shimmer: 'shimmer 1.5s ease-in-out infinite',
        sizeSquarePulse: 'sizeSquarePulse 0.8s ease-in-out infinite',
      },
    }
  },
  plugins: []
} satisfies Config
