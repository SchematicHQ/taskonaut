export default {
  testEnvironment: "node",
  transform: {},
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  coverageDirectory: "coverage",
  collectCoverageFrom: ["*.js", "!jest.config.js", "!eslint.config.js"],
  // A floor, not a target: the destructive commands are the reason this
  // project has tests at all, so coverage must not quietly slide.
  coverageThreshold: {
    global: {
      statements: 80,
      branches: 68,
      functions: 80,
      lines: 80,
    },
  },
  testMatch: ["**/tests/**/*.test.js"],
};
