import { describe, expect, test } from "@jest/globals";
import {
  chunk,
  extractProfileNamesFromConfig,
  mapWithConcurrency,
  paginate,
  parseFamilyFromArn,
  parseImageTag,
  parseRevisionFromArn,
  DESCRIBE_SERVICES_BATCH_SIZE,
} from "../../index.js";

describe("extractProfileNamesFromConfig", () => {
  test("strips the `profile ` prefix and keeps the default section", () => {
    expect(
      extractProfileNamesFromConfig({
        default: { region: "us-east-1" },
        "profile staging": { region: "us-west-2" },
      }),
    ).toEqual(["default", "staging"]);
  });

  test("skips sso-session and services sections", () => {
    expect(
      extractProfileNamesFromConfig({
        "profile schematic-dev": { sso_session: "corp" },
        "sso-session corp": { sso_start_url: "https://example.awsapps.com" },
        "services my-services": { s3: {} },
      }),
    ).toEqual(["schematic-dev"]);
  });

  test("skips settings written outside any section", () => {
    expect(
      extractProfileNamesFromConfig({
        cli_pager: "",
        "profile prod": { region: "eu-west-1" },
      }),
    ).toEqual(["prod"]);
  });

  test("only strips an anchored prefix", () => {
    expect(
      extractProfileNamesFromConfig({ "profile my profile x": {} }),
    ).toEqual(["my profile x"]);
  });
});

describe("parseImageTag", () => {
  test("reads a plain tag", () => {
    expect(parseImageTag("nginx:1.27")).toBe("1.27");
  });

  test("defaults to latest when untagged", () => {
    expect(parseImageTag("nginx")).toBe("latest");
  });

  test("does not mistake a registry port for a tag", () => {
    expect(parseImageTag("registry.internal:5000/app")).toBe("latest");
    expect(parseImageTag("registry.internal:5000/app:v2")).toBe("v2");
  });

  test("falls back to a short digest when pinned by digest", () => {
    expect(parseImageTag("app@sha256:abcdef0123456789")).toBe(
      "sha256:abcdef012345",
    );
  });

  test("handles a missing image", () => {
    expect(parseImageTag(undefined)).toBe("latest");
  });
});

describe("ARN parsing", () => {
  const arn =
    "arn:aws:ecs:us-east-1:123456789012:task-definition/schematic-api:42";

  test("extracts the family", () => {
    expect(parseFamilyFromArn(arn)).toBe("schematic-api");
  });

  test("extracts the revision", () => {
    expect(parseRevisionFromArn(arn)).toBe(42);
  });
});

describe("chunk", () => {
  test("splits into batches no larger than the limit", () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    const batches = chunk(items, DESCRIBE_SERVICES_BATCH_SIZE);

    expect(batches).toHaveLength(3);
    expect(batches.every((b) => b.length <= DESCRIBE_SERVICES_BATCH_SIZE)).toBe(
      true,
    );
    expect(batches.flat()).toEqual(items);
  });

  test("returns nothing for an empty input", () => {
    expect(chunk([], 10)).toEqual([]);
  });
});

describe("paginate", () => {
  test("follows nextToken until it is absent", async () => {
    const pages = [
      { serviceArns: ["a", "b"], nextToken: "t1" },
      { serviceArns: ["c"], nextToken: "t2" },
      { serviceArns: ["d"] },
    ];
    const seenTokens = [];

    const operation = async (params) => {
      seenTokens.push(params.nextToken);
      return pages.shift();
    };

    const result = await paginate(operation, { cluster: "x" }, "serviceArns");

    expect(result).toEqual(["a", "b", "c", "d"]);
    expect(seenTokens).toEqual([undefined, "t1", "t2"]);
  });

  test("requests the maximum page size, since ListServices defaults to 10", async () => {
    let received;
    await paginate(
      async (params) => {
        received = params;
        return { serviceArns: [] };
      },
      { cluster: "x" },
      "serviceArns",
    );

    expect(received.maxResults).toBe(100);
    expect(received.cluster).toBe("x");
  });

  test("tolerates a page with no results key", async () => {
    const result = await paginate(async () => ({}), {}, "serviceArns");
    expect(result).toEqual([]);
  });
});

describe("mapWithConcurrency", () => {
  test("preserves input order", async () => {
    const items = [5, 1, 4, 2, 3];
    const result = await mapWithConcurrency(items, 2, async (n) => n * 10);
    expect(result).toEqual([50, 10, 40, 20, 30]);
  });

  test("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
      },
    );

    expect(peak).toBeLessThanOrEqual(3);
  });

  test("handles an empty input", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});
