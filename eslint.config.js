import globals from "globals";
import pluginJs from "@eslint/js";

/** @type {import('eslint').Linter.Config[]} */
export default [
  // A config object containing only `ignores` sets global ignores; combining it
  // with other keys would scope the ignore to that object alone.
  {
    ignores: ["node_modules/**", "coverage/**"],
  },
  {
    languageOptions: { globals: globals.node },
  },
  pluginJs.configs.recommended,
];
