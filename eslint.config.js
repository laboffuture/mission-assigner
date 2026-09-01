import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

// ESLint (flat config) for the TypeScript application code. The .mjs test
// harnesses are plain Node scripts and the Python pipeline / browser assets are
// out of scope, so they are ignored here.
export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      'pipeline/**',
      'public/**',
      '*.mjs',
      'eslint.config.js',
    ],
  },
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['src/**/*.ts'],
    rules: {
      // The DB layer works with raw mysql2 row shapes; `any` is intentional and
      // pervasive at that boundary. Typing every ad-hoc row adds noise, not
      // safety, so this rule is not adopted (a config choice, not silencing a bug).
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  }
);
