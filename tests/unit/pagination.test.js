import { describe, expect, test } from "@jest/globals";
import {
  fetchAllTaskDefinitions,
  isThrottlingError,
  paginate,
} from "../../index.js";
import {
  failFirst,
  makeEcs,
  paged,
  tdArn,
  throttlingError,
} from "../helpers/ecs-double.js";

describe("isThrottlingError", () => {
  test("recognises the exception names the ECS API uses", () => {
    expect(isThrottlingError(throttlingError("ThrottlingException"))).toBe(
      true,
    );
    expect(isThrottlingError(throttlingError("TooManyRequestsException"))).toBe(
      true,
    );
  });

  test("recognises the message when the name is missing", () => {
    // Some SDK middleware surfaces the condition only in the message.
    expect(isThrottlingError(new Error("Rate exceeded"))).toBe(true);
  });

  test("does not treat other failures as throttling", () => {
    expect(isThrottlingError(new Error("AccessDeniedException"))).toBe(false);
  });

  test("tolerates an error with no message", () => {
    expect(isThrottlingError({ name: "Weird" })).toBe(false);
  });
});

describe("paginate throttling", () => {
  test("retries when the very first page is throttled", async () => {
    // Regression: the loop was `do { ... } while (nextToken)`, and nextToken is
    // undefined before the first request. A throttled first page therefore
    // exited the loop and returned an empty list instead of retrying, so a
    // rate-limited account saw "no revisions found" rather than an error.
    let attempts = 0;
    const operation = async () => {
      attempts += 1;
      if (attempts === 1) throw throttlingError();
      return { items: ["a", "b"] };
    };

    const result = await paginate(operation, {}, "items", { maxRetries: 2 });

    expect(attempts).toBe(2);
    expect(result).toEqual(["a", "b"]);
  });

  test("re-requests the same page rather than skipping it", async () => {
    const seenTokens = [];
    let throttled = false;
    const operation = async ({ nextToken }) => {
      seenTokens.push(nextToken);
      if (nextToken === "t1" && !throttled) {
        throttled = true;
        throw throttlingError();
      }
      return nextToken === "t1"
        ? { items: ["c"] }
        : { items: ["a"], nextToken: "t1" };
    };

    const result = await paginate(operation, {}, "items", { maxRetries: 2 });

    expect(seenTokens).toEqual([undefined, "t1", "t1"]);
    expect(result).toEqual(["a", "c"]);
  });

  test("gives up after maxRetries with an actionable message", async () => {
    const cause = throttlingError();
    const operation = async () => {
      throw cause;
    };

    const failure = await paginate(operation, {}, "items", {
      maxRetries: 1,
    }).catch((err) => err);

    expect(failure.message).toMatch(/Rate limit exceeded after 1 retries/);
    expect(failure.cause).toBe(cause);
  });

  test("does not retry a non-throttling error", async () => {
    let attempts = 0;
    const operation = async () => {
      attempts += 1;
      throw new Error("AccessDeniedException");
    };

    await expect(paginate(operation, {}, "items")).rejects.toThrow(
      "AccessDeniedException",
    );
    expect(attempts).toBe(1);
  });

  test("resets the retry budget after a successful page", async () => {
    // A long listing that is throttled once per page must still complete;
    // a cumulative counter would abort part-way through.
    let calls = 0;
    const operation = async ({ nextToken }) => {
      calls += 1;
      if (calls === 2 || calls === 4) throw throttlingError();
      return nextToken ? { items: ["b"] } : { items: ["a"], nextToken: "t1" };
    };

    const result = await paginate(operation, {}, "items", { maxRetries: 1 });

    expect(result).toEqual(["a", "b"]);
  });

  test("updates the spinner while paginating without throwing", async () => {
    const spinner = { text: "" };
    const items = Array.from({ length: 25 }, (_, i) => `i${i}`);

    const result = await paginate(paged("items", items, 10), {}, "items", {
      spinner,
      label: "Fetching...",
    });

    expect(result).toHaveLength(25);
    expect(spinner.text).toContain("so far");
  });
});

describe("fetchAllTaskDefinitions", () => {
  test("passes the caller's filters through unchanged", async () => {
    const ecs = makeEcs({
      listTaskDefinitions: paged("taskDefinitionArns", [tdArn(1)]),
    });

    await fetchAllTaskDefinitions(ecs, {
      familyPrefix: "app",
      status: "INACTIVE",
      sort: "DESC",
    });

    expect(ecs.callsTo("listTaskDefinitions")[0].params).toMatchObject({
      familyPrefix: "app",
      status: "INACTIVE",
      sort: "DESC",
      maxResults: 100,
    });
  });

  test("follows every page", async () => {
    const arns = Array.from({ length: 250 }, (_, i) => tdArn(250 - i));
    const ecs = makeEcs({
      listTaskDefinitions: paged("taskDefinitionArns", arns, 100),
    });

    const result = await fetchAllTaskDefinitions(ecs, { familyPrefix: "app" });

    expect(result).toHaveLength(250);
    expect(ecs.callsTo("listTaskDefinitions")).toHaveLength(3);
  });

  test("retries a throttled listing instead of reporting an empty family", async () => {
    const ecs = makeEcs({
      listTaskDefinitions: failFirst(
        1,
        throttlingError,
        paged("taskDefinitionArns", [tdArn(2), tdArn(1)]),
      ),
    });

    const result = await fetchAllTaskDefinitions(ecs, { familyPrefix: "app" });

    expect(result).toEqual([tdArn(2), tdArn(1)]);
  });
});
