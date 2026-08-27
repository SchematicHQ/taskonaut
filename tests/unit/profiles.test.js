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

// Built at runtime so this file carries no literal control characters.
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const tempDirs = [];

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Rewrites ~/.aws/config inside an isolated HOME. */
function writeProfiles(home, profileNames) {
  fs.writeFileSync(
    path.join(home, ".aws", "config"),
    profileNames
      .map((name) => `[profile ${name}]\nregion = us-east-1\n`)
      .join("\n"),
  );
}

/** Creates an isolated HOME containing an ~/.aws/config with the given profiles. */
function makeHome(profileNames) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskonaut-profiles-"));
  tempDirs.push(home);
  fs.mkdirSync(path.join(home, ".aws"), { recursive: true });
  writeProfiles(home, profileNames);
  return home;
}

/** Runs `doctor` with an isolated HOME, returning combined output without ANSI. */
function runDoctor(home, profile) {
  try {
    const out = execFileSync(process.execPath, [indexPath, "doctor"], {
      encoding: "utf-8",
      env: { ...process.env, HOME: home, AWS_PROFILE: profile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.replace(ANSI_PATTERN, "");
  } catch (err) {
    // doctor exits non-zero when any check fails (e.g. no AWS CLI on the
    // runner); the profile line is what matters here.
    return `${err.stdout || ""}${err.stderr || ""}`.replace(ANSI_PATTERN, "");
  }
}

describe("doctor profile check", () => {
  test("accepts a profile on a fresh install with an empty cache", () => {
    // Regression: the check read the raw awsProfiles cache, which is empty
    // before the first sync, so a profile that exists in ~/.aws/config was
    // reported as unconfigured. Combined with doctor now exiting non-zero,
    // that broke using it to gate setup.
    const home = makeHome(["brand-new"]);
    const output = runDoctor(home, "brand-new");

    expect(output).toContain("AWS profile 'brand-new' is configured");
    expect(output).not.toContain("'brand-new' is not configured");
  });

  test("accepts a profile added after the cache was populated", () => {
    // Regression: a non-empty cache was reused for a full hour, so selecting a
    // newly added profile via AWS_PROFILE failed with "Invalid AWS profile"
    // before fromIni was ever attempted.
    const home = makeHome(["alpha"]);
    runDoctor(home, "alpha"); // populates the cache with alpha only

    writeProfiles(home, ["alpha", "beta"]);
    const output = runDoctor(home, "beta");

    expect(output).toContain("AWS profile 'beta' is configured");
  });

  test("still rejects a profile that does not exist", () => {
    const home = makeHome(["alpha"]);
    const output = runDoctor(home, "ghost");

    expect(output).toContain("AWS profile 'ghost' is not configured");
  });
});
