import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default defineConfig(
  {
    // src/gen is generated from the backend's proto (make generate-api) and never edited by hand.
    ignores: [
      'dist',
      'dist-backend-fakes',
      'node_modules',
      '.pnpm-store',
      'playwright-report',
      'test-results',
      'coverage',
      '.vite',
      'src/gen',
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended, prettier],
    files: ['**/*.{ts,tsx}'],
    languageOptions: { ecmaVersion: 2022, globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'zod',
              message: "Import z from src/validation/zod, which sets the console's wording for every issue.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/validation/zod.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['vite.config.ts', 'vitest.setup.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    extends: [js.configs.recommended, prettier],
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: globals.node },
  },
);
