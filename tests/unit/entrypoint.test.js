import { describe, expect, test, afterAll } from "@jest/globals";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const indexPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../index.js",
);
const { version } = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../package.json",
    ),
    "utf-8",
  ),
);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "taskonaut-entrypoint-"));

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** Runs the CLI and returns trimmed stdout. */
function run(entry, args) {
  return execFileSync(process.execPath, [entry, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("CLI entrypoint", () => {
  test("runs when invoked directly", () => {
    expect(run(indexPath, ["--version"])).toBe(version);
  });

  test("runs when invoked through a symlink", () => {
    // Regression: npm installs the bin as a symlink and Node resolves symlinks
    // when building import.meta.url, so comparing it to an unresolved
    // process.argv[1] reported "not the main module" for every global install
    // and the CLI silently did nothing.
    const link = path.join(tempDir, "taskonaut");
    fs.symlinkSync(indexPath, link);

    expect(run(link, ["--version"])).toBe(version);
  });

  test("importing the module does not run the CLI", () => {
    // The guard exists so tests can import index.js; if importing started
    // parsing argv, every other suite would be at the mercy of jest's argv.
    const probe = path.join(tempDir, "probe.mjs");
    fs.writeFileSync(
      probe,
      `import ${JSON.stringify(pathToFileUrl(indexPath))};\nconsole.log("imported-cleanly");\n`,
    );

    expect(run(probe, ["--version"])).toBe("imported-cleanly");
  });
});

/** Builds a file:// URL string for an absolute path. */
function pathToFileUrl(absolutePath) {
  return new URL(`file://${absolutePath}`).href;
}

describe("cancelOperation", () => {
  test("exits cleanly instead of recursing", async () => {
    // Regression: a bulk edit replaced the log-and-exit body with a call to
    // the function itself, so every Ctrl+C blew the stack with a RangeError
    // and the surrounding command reported a failure and exited non-zero.
    const { cancelOperation } = await import("../../index.js");

    const originalExit = process.exit;
    const codes = [];
    process.exit = (code) => {
      codes.push(code);
    };

    try {
      expect(() => cancelOperation()).not.toThrow();
    } finally {
      process.exit = originalExit;
    }

    expect(codes).toEqual([0]);
  });
});

describe("config show --json", () => {
  test("stdout parses as JSON", () => {
    // Regression: gating the banner was not enough to make this pipeable --
    // the command still wrote headings, the path and "Values:" to stdout, so
    // `config show | jq .` failed with "Invalid numeric literal". This asserts
    // on a real parse rather than eyeballing the output.
    const stdout = run(indexPath, ["config", "show", "--json"]);
    const parsed = JSON.parse(stdout);

    expect(typeof parsed.path).toBe("string");
    expect(parsed.values).toBeDefined();
  });

  test("emits no ANSI escapes", () => {
    const stdout = run(indexPath, ["config", "show", "--json"]);
    // eslint-disable-next-line no-control-regex
    expect(stdout).not.toMatch(/\u001b\[/);
  });

  test("human output is unchanged by default", () => {
    const stdout = run(indexPath, ["config", "show"]);

    expect(stdout).toContain("Configuration Details:");
    expect(() => JSON.parse(stdout)).toThrow();
  });
});
