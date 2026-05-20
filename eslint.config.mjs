import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import securityPlugin from 'eslint-plugin-security';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** @type {import("typescript-eslint").FlatConfig.ConfigType[]} */
export default tseslint.config(
  // Ignore patterns
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'release/**',
      'coverage/**',
      '*.min.js',
      '.claude/**',
      '.git/**',
    ],
  },

  // Base JS config
  js.configs.recommended,

  // TypeScript files
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    languageOptions: {
      ...config.languageOptions,
      parserOptions: {
        ...config.languageOptions?.parserOptions,
        project: './tsconfig.json',
        tsconfigRootDir: __dirname,
      },
    },
  })),

  // React - automatic JSX transform (React 17+)
  {
    files: ['**/*.{tsx,jsx}'],
    plugins: {
      'react': reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    settings: {
      react: {
        version: 'detect',
        runtime: 'automatic',
      },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      'react/display-name': 'off',
      'react/prop-types': 'off',
      'react/jsx-key': ['error', { checkFragmentShorthand: true }],
      'react/jsx-no-target-blank': ['error', { enforceDynamicLinks: 'always' }],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Disable react-in-jsx-scope for automatic JSX transform
      'react/react-in-jsx-scope': 'off',
    },
  },

  // Security - activate plugin rules
  // detect-child-process is particularly relevant for JellyTunes (uses FFmpeg)
  {
    plugins: {
      security: securityPlugin,
    },
    rules: {
      // Enable recommended security rules
      'security/detect-child-process': 'warn',
      'security/detect-non-literal-fs-filename': 'warn',
      // Disable rules with too many false positives
      'security/detect-object-injection': 'off',
    },
  },

  // Test files - relaxed rules
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      'no-console': 'off',
    },
  },

  // Specific file overrides for legacy issues
  {
    files: ['src/sync/*.ts', 'src/renderer/src/components/LibraryContent.tsx'],
    rules: {
      // Allow console in sync module (needed for sync progress)
      'no-console': 'off',
      // Allow unescaped entities in JSX (quoted strings)
      'react/no-unescaped-entities': 'off',
      // Allow Function type (legacy code)
      '@typescript-eslint/ban-types': 'off',
    },
  },

  // Project-specific rules
  {
    rules: {
      // TypeScript
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': 'warn',
      '@typescript-eslint/prefer-optional-chain': 'warn',
      '@typescript-eslint/no-array-delete': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'warn',
        {
          'ts-expect-error': 'allow-with-description',
          'ts-ignore': 'allow-with-description',
        },
      ],
      '@typescript-eslint/no-require-imports': 'off',

      // General
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'eqeqeq': ['warn', 'always'],
      'no-else-return': ['warn', { allowElseIf: false }],
      'no-restricted-globals': ['error', 'event', 'describe.only', 'it.only', 'test.only'],
      'no-useless-escape': 'warn',
      'no-control-regex': 'warn',
    },
  },
);
