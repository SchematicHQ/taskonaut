import { describe, expect, test, beforeEach, afterEach } from "@jest/globals";
import Conf from "conf";
import { fileURLToPath } from "url";
import { dirname } from "path";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("Configuration", () => {
  let config;

  beforeEach(() => {
    config = new Conf({
      projectName: "taskonaut-test",
      cwd: path.join(__dirname, "../fixtures"),
      schema: {
        awsProfile: {
          type: "string",
          default: "default",
        },
        awsRegion: {
          type: "string",
          default: "us-east-1",
        },
        lastUsedCluster: {
          type: "string",
          default: "",
        },
        awsProfiles: {
          type: "array",
          default: [],
        },
        lastProfileSync: {
          type: "number",
          default: 0,
        },
      },
    });
  });

  afterEach(() => {
    config.clear();
  });

  test("should have default values", () => {
    expect(config.get("awsProfile")).toBe("default");
    expect(config.get("awsRegion")).toBe("us-east-1");
    expect(config.get("lastUsedCluster")).toBe("");
    expect(config.get("awsProfiles")).toEqual([]);
    expect(config.get("lastProfileSync")).toBe(0);
  });

  test("should be able to set and get values", () => {
    config.set("awsProfile", "test-profile");
    config.set("awsRegion", "eu-west-1");

    expect(config.get("awsProfile")).toBe("test-profile");
    expect(config.get("awsRegion")).toBe("eu-west-1");
  });

  test("should handle array values", () => {
    const profiles = ["profile1", "profile2"];
    config.set("awsProfiles", profiles);

    expect(config.get("awsProfiles")).toEqual(profiles);
  });
});
