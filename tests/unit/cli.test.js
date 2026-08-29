import { afterAll, describe, expect, test } from "@jest/globals";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const indexPath = path.resolve(import.meta.dirname, "../../index.js");
const tempDirs = [];

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// Built at runtime so this file carries no literal control characters.
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** Runs the CLI, returning `{ status, output }` with ANSI stripped. */
function run(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [indexPath, ...args], {
      encoding: "utf-8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output: stdout.replace(ANSI_PATTERN, "") };
  } catch (err) {
    return {
      status: err.status,
      output: `${err.stdout || ""}${err.stderr || ""}`.replace(
        ANSI_PATTERN,
        "",
      ),
    };
  }
}

/** Creates an isolated HOME with an ~/.aws/config holding `profiles`. */
function makeHome(profiles = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskonaut-cli-"));
  tempDirs.push(home);
  fs.mkdirSync(path.join(home, ".aws"), { recursive: true });

  if (profiles.length > 0) {
    fs.writeFileSync(
      path.join(home, ".aws", "config"),
      profiles
        .map((name) => `[profile ${name}]\nregion = us-east-1\n`)
        .join("\n"),
    );
  }

  return home;
}

describe("command surface", () => {
  const help = run(["--help"]);

  test("advertises every command", () => {
    for (const command of ["config", "doctor", "rollback", "prune"]) {
      expect(help.output).toContain(command);
    }
  });

  test("documents the exec command override", () => {
    expect(help.output).toContain("--command");
    expect(help.output).toContain("/bin/sh");
  });

  test("prints the name without ANSI escapes", () => {
    // The name lands in usage strings and shell completions, where embedded
    // escapes leak through as literal characters.
    expect(help.output).toContain("Usage: taskonaut");
  });

  test("rejects an unrecognised argument instead of starting a session", () => {
    const result = run(["definitely-not-a-command"]);

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/error: too many arguments/i);
  });

  test("rejects an unknown option", () => {
    const result = run(["--definitely-not-an-option"]);

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/unknown option/i);
  });

  test("config lists its subcommands", () => {
    const result = run(["config", "--help"]);

    for (const sub of ["set", "show", "cleanup"]) {
      expect(result.output).toContain(sub);
    }
  });
});

describe("config show", () => {
  test("reports the defaults on a fresh install", () => {
    const result = run(["config", "show", "--json"], { HOME: makeHome() });
    const parsed = JSON.parse(result.output);

    expect(parsed.values.awsProfile).toBe("default");
    expect(parsed.values.awsRegion).toBe("us-east-1");
  });

  test("reads back values stored on disk", () => {
    const home = makeHome();
    const first = JSON.parse(
      run(["config", "show", "--json"], { HOME: home }).output,
    );

    fs.writeFileSync(
      first.path,
      JSON.stringify({ awsProfile: "staging", awsRegion: "eu-west-1" }),
    );

    const second = JSON.parse(
      run(["config", "show", "--json"], { HOME: home }).output,
    );
    expect(second.values).toMatchObject({
      awsProfile: "staging",
      awsRegion: "eu-west-1",
    });
  });

  test("keeps the config inside the isolated home", () => {
    const home = makeHome();
    const { path: configPath } = JSON.parse(
      run(["config", "show", "--json"], { HOME: home }).output,
    );

    expect(configPath.startsWith(home)).toBe(true);
  });

  test("`config path` is an alias for show", () => {
    const result = run(["config", "path"], { HOME: makeHome() });

    expect(result.output).toContain("Configuration Details:");
  });
});

describe("doctor", () => {
  test("exits non-zero when the environment is incomplete", () => {
    // Exiting 0 regardless made it useless as a setup gate in a script.
    const result = run(["doctor"], { HOME: makeHome(), PATH: "" });

    expect(result.status).toBe(1);
    expect(result.output).toContain("AWS CLI is not installed");
    expect(result.output).toContain(
      "Errors were detected. Please address them and try again",
    );
  });

  test("reports each check separately", () => {
    const home = makeHome(["alpha"]);
    const result = run(["doctor"], { HOME: home, AWS_PROFILE: "alpha" });

    expect(result.output).toContain("Session Manager Plugin");
    expect(result.output).toContain("AWS credentials are configured");
    expect(result.output).toContain("AWS profile 'alpha' is configured");
  });

  test("detects missing credentials", () => {
    const result = run(["doctor"], { HOME: makeHome() });

    expect(result.output).toContain("AWS credentials are not configured");
    expect(result.status).toBe(1);
  });
});
