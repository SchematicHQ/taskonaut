export default {
  testEnvironment: "node",
  transform: {},
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  coverageDirectory: "coverage",
  collectCoverageFrom: ["*.js", "!jest.config.js", "!eslint.config.js"],
  testMatch: ["**/tests/**/*.test.js"],
};
