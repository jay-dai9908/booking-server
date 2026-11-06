module.exports = {
  root: true,
  env: { browser: true, es2020: true, node: true },
  extends: [
    'eslint:recommended',
    'plugin:react/recommended',
    'plugin:react/jsx-runtime',
    'plugin:react-hooks/recommended'
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs', 'node_modules'],
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  settings: { react: { version: '18.2' } },
  plugins: ['react', 'react-refresh'],
  rules: {
    'react/jsx-no-undef': 'error',
    'react/prop-types': 'off',
    'no-unused-vars': 'off',
    'no-empty': 'off',
    'react/no-unescaped-entities': 'off'
  }
};
