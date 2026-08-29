import { EventEmitter } from "node:events";
import { jest } from "@jest/globals";

/**
 * Replaces node:child_process so `exec` sessions never spawn the real AWS CLI.
 *
 * jest's sandboxed process.env does not reach child_process, so PATH tricks
 * cannot redirect the binary from inside a test.
 *
 * Must be called before importing index.js.
 *
 * @returns {{spawns: Function, exitCode: Function, missing: Function,
 *   reset: Function}} Controls.
 */
export function mockChildProcess() {
  const spawns = [];
  let exitCode = 0;

  const spawn = jest.fn((command, args) => {
    spawns.push([command, args]);

    const child = new EventEmitter();
    child.kill = jest.fn();
    // Deferred so the caller can attach its listeners first.
    setImmediate(() => child.emit("exit", exitCode));
    return child;
  });

  let missing = [];
  const execSync = jest.fn((command) => {
    if (missing.some((name) => command.startsWith(name))) {
      throw new Error(`command not found: ${command}`);
    }
    return "";
  });

  // Other modules in the graph import this one as a default, so the stand-in
  // has to offer both shapes.
  jest.unstable_mockModule("node:child_process", () => ({
    __esModule: true,
    default: { spawn, execSync },
    spawn,
    execSync,
  }));

  return {
    spawns: () => spawns,
    exitCode: (code) => {
      exitCode = code;
    },
    /** Names the binaries that should behave as if they are not installed. */
    missing: (...names) => {
      missing = names;
    },
    reset: () => {
      spawns.length = 0;
      exitCode = 0;
      missing = [];
      spawn.mockClear();
      execSync.mockClear();
    },
  };
}
