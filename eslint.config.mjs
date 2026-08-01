import daStyle from 'eslint-config-dicodingacademy';
import pluginReact from 'eslint-plugin-react';

export default [
  // Global ignore: in ESLint's flat config, `ignores` only excludes files
  // from the *same* config object's rules when combined with `files` (as it
  // was below) - it does not stop other config objects (like `daStyle`) from
  // linting them. It must live alone in its own object to apply globally.
  { ignores: ['dist', 'node_modules'] },
  daStyle,
  {
    files: ['**/*.{js,jsx}'],
    plugins: {
      react: pluginReact,
    },
    languageOptions: {
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
        babelOptions: {
          presets: ['@babel/preset-react'],
        },
      },
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      ...pluginReact.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'camelcase': 'off',
    },
  },
];
