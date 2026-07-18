import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // demo/ is a standalone Next.js app with its own eslint + tsconfig; the root
  // config must not lint it (its build artifacts would produce thousands of errors).
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'demo/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Adapters intentionally handle untyped provider JSON at the boundary.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
