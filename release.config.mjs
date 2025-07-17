// @ts-check
/** @type {import('semantic-release').GlobalConfig} */
export default {
  repositoryUrl: "https://github.com/schematichq/taskonaut",
  tagFormat: "v${version}",
  branches: [
    "main",
    {
      name: "next",
      prerelease: true,
    },
  ],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    [
      "@semantic-release/changelog",
      {
        changelogFile: "CHANGELOG.md",
      },
    ],
    [
      "@semantic-release/git",
      {
        assets: ["CHANGELOG.md"],
      },
    ],
    "@semantic-release/github",
    "@semantic-release/npm",
  ],
};
