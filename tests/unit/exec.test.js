import { afterAll, describe, expect, test } from "@jest/globals";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { taskArn } from "../helpers/ecs-double.js";

const indexPath = path.resolve(import.meta.dirname, "../../index.js");
const tempDirs = [];

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Creates a temporary directory that is removed after the suite. */
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * Writes a stand-in `aws` executable that records its argv and exits with
 * `exitCode`, and returns the PATH to run it under.
 *
 * executeCommand resolves the AWS CLI through PATH and spawns it without a
 * shell, so this exercises the real spawn rather than a stub. The node
 * directory trails the shim so its shebang resolves; the shim still wins the
 * lookup for `aws`.
 *
 * @param {number} exitCode - Status the fake CLI exits with.
 * @returns {{pathDir: string, argv: Function}} Recording handle.
 */
function fakeAwsCli(exitCode = 0) {
  const dir = tempDir("taskonaut-aws-");
  const argvFile = path.join(dir, "argv.json");

  fs.writeFileSync(
    path.join(dir, "aws"),
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      `fs.appendFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
      `process.exit(${exitCode});`,
      "",
    ].join("\n"),
  );
  fs.chmodSync(path.join(dir, "aws"), 0o755);

  return {
    pathDir: `${dir}${path.delimiter}${path.dirname(process.execPath)}`,
    argv: () =>
      fs
        .readFileSync(argvFile, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}

/**
 * Runs executeCommand in a child process so PATH and AWS_* really apply --
 * jest's sandboxed process.env does not reach child_process.spawn.
 *
 * @param {object} spec - Session parameters and environment.
 * @returns {object} `{ code, error, sigintBefore, sigintAfter }`.
 */
function runSession({ pathDir, env = {}, runs = 1, ...session }) {
  const dir = tempDir("taskonaut-driver-");
  const resultFile = path.join(dir, "result.json");
  const driver = path.join(dir, "driver.mjs");

  fs.writeFileSync(
    driver,
    [
      `import { executeCommand } from ${JSON.stringify(pathToFileURL(indexPath).href)};`,
      'import fs from "node:fs";',
      `const session = ${JSON.stringify(session)};`,
      'const result = { sigintBefore: process.listenerCount("SIGINT") };',
      "try {",
      `  for (let i = 0; i < ${runs}; i += 1) {`,
      "    result.code = await executeCommand(session.cluster, session.taskArn, session.container, session.command);",
      "  }",
      "} catch (err) {",
      "  result.error = err.message;",
      "}",
      'result.sigintAfter = process.listenerCount("SIGINT");',
      `fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(result));`,
      "",
    ].join("\n"),
  );

  execFileSync(process.execPath, [driver], {
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, PATH: pathDir, ...env },
  });

  return JSON.parse(fs.readFileSync(resultFile, "utf-8"));
}

describe("executeCommand", () => {
  test("invokes the AWS CLI with the session arguments", async () => {
    const cli = fakeAwsCli(0);

    const result = runSession({
      pathDir: cli.pathDir,
      env: { AWS_PROFILE: "prod", AWS_REGION: "us-east-1" },
      cluster: "prod-cluster",
      taskArn: taskArn("abc"),
      container: "api",
      command: "/bin/bash",
    });

    expect(result.code).toBe(0);
    expect(cli.argv()[0]).toEqual([
      "ecs",
      "execute-command",
      "--profile",
      "prod",
      "--region",
      "us-east-1",
      "--cluster",
      "prod-cluster",
      "--task",
      taskArn("abc"),
      "--container",
      "api",
      "--command",
      "/bin/bash",
      "--interactive",
    ]);
  });

  test("passes hostile names through as single arguments", () => {
    // No shell is involved, so a container name containing shell syntax
    // arrives at the CLI intact instead of being executed.
    const cli = fakeAwsCli(0);

    runSession({
      pathDir: cli.pathDir,
      env: { AWS_PROFILE: "p", AWS_REGION: "r" },
      cluster: "prod",
      taskArn: taskArn("abc"),
      container: "api; touch /tmp/taskonaut-pwned",
      command: "sh",
    });

    expect(cli.argv()[0]).toContain("api; touch /tmp/taskonaut-pwned");
    expect(fs.existsSync("/tmp/taskonaut-pwned")).toBe(false);
  });

  test("propagates the session exit code", () => {
    const cli = fakeAwsCli(42);

    const result = runSession({
      pathDir: cli.pathDir,
      env: { AWS_PROFILE: "p", AWS_REGION: "r" },
      cluster: "prod",
      taskArn: taskArn("abc"),
      container: "api",
    });

    expect(result.code).toBe(42);
  });

  test("defaults the session command to a POSIX shell", () => {
    const cli = fakeAwsCli(0);

    runSession({
      pathDir: cli.pathDir,
      env: { AWS_PROFILE: "p", AWS_REGION: "r" },
      cluster: "prod",
      taskArn: taskArn("abc"),
      container: "api",
    });

    const argv = cli.argv()[0];
    expect(argv[argv.indexOf("--command") + 1]).toBe("/bin/sh");
  });

  test("explains a missing AWS CLI instead of surfacing a spawn error", () => {
    const result = runSession({
      pathDir: tempDir("taskonaut-nopath-"),
      cluster: "prod",
      taskArn: taskArn("abc"),
      container: "api",
    });

    expect(result.error).toMatch(/Install it and run `taskonaut doctor`/);
    expect(result.code).toBeUndefined();
  });

  test("removes its signal handlers when the session ends", () => {
    // These are registered per session; leaking them would fire stale cleanups
    // on a later Ctrl+C and eventually trip Node's max-listeners warning.
    const cli = fakeAwsCli(0);

    const result = runSession({
      pathDir: cli.pathDir,
      env: { AWS_PROFILE: "p", AWS_REGION: "r" },
      runs: 3,
      cluster: "prod",
      taskArn: taskArn("abc"),
      container: "api",
    });

    expect(cli.argv()).toHaveLength(3);
    expect(result.sigintAfter).toBe(result.sigintBefore);
  });
});
