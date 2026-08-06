module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.(js|ts)$': ['babel-jest', {
      babelrc: false,
      configFile: false,
      presets: [
        ['@babel/preset-env', { targets: { node: 'current' } }],
        '@babel/preset-typescript',
      ],
    }],
  },
  testMatch: ['**/__tests__/**/*.test.js', '**/__tests__/**/*.test.ts'],
};
