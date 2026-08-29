import { jest } from "@jest/globals";

/**
 * Replaces the ECS client and credential provider with test doubles.
 *
 * initAWS constructs the client itself, so driving a whole command means
 * intercepting the constructor rather than injecting a client.
 *
 * Must be called before importing index.js.
 *
 * @returns {{use: Function}} `use(double)` sets what `new ECS()` returns.
 */
export function mockAwsSdk() {
  let current = null;

  jest.unstable_mockModule("@aws-sdk/client-ecs", () => ({
    ECS: class {
      constructor() {
        if (!current) throw new Error("No ECS double installed for this test");
        return current;
      }
    },
  }));

  jest.unstable_mockModule("@aws-sdk/credential-providers", () => ({
    fromIni: () => async () => ({
      accessKeyId: "test",
      secretAccessKey: "test",
    }),
  }));

  return {
    use: (double) => {
      current = double;
      return double;
    },
  };
}
