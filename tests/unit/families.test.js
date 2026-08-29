import { describe, expect, test } from "@jest/globals";
import {
  listTaskDefinitionFamilies,
  FAMILY_DETAIL_CONCURRENCY,
} from "../../index.js";
import { makeEcs, paged, tdArn } from "../helpers/ecs-double.js";

/**
 * Builds an ECS double from a map of family name to `{ active, inactive }`
 * revision numbers.
 */
function familiesEcs(spec, { onList } = {}) {
  const names = Object.keys(spec);

  return makeEcs({
    listTaskDefinitionFamilies: paged("families", names),
    listTaskDefinitions: async ({ familyPrefix, status }) => {
      if (onList) await onList(familyPrefix);

      const entry = spec[familyPrefix];
      if (entry instanceof Error) throw entry;

      const revisions =
        (status === "INACTIVE" ? entry.inactive : entry.active) ?? [];

      return {
        taskDefinitionArns: [...revisions]
          .sort((a, b) => b - a)
          .map((revision) => tdArn(revision, familyPrefix)),
      };
    },
  });
}

describe("listTaskDefinitionFamilies", () => {
  test("asks the families API for both statuses rather than enumerating revisions", async () => {
    // Listing every task definition in the account and grouping client-side
    // took minutes on an account with thousands of families.
    const ecs = familiesEcs({ app: { active: [2, 1], inactive: [] } });

    await listTaskDefinitionFamilies(ecs, true);

    expect(ecs.callsTo("listTaskDefinitionFamilies")[0].params).toMatchObject({
      status: "ALL",
      maxResults: 100,
    });
  });

  test("counts ACTIVE and INACTIVE revisions exactly, with no describe calls", async () => {
    const ecs = familiesEcs({
      app: { active: [5, 4, 3], inactive: [2, 1] },
    });

    const [app] = await listTaskDefinitionFamilies(ecs, true);

    expect(app).toEqual({
      family: "app",
      revisionCount: 5,
      latestRevision: 5,
      activeCount: 3,
      inactiveCount: 2,
    });
    expect(ecs.callsTo("describeTaskDefinition")).toHaveLength(0);
  });

  test("the latest revision can be an INACTIVE one", async () => {
    // Deregistering the newest revision must not make the family look older
    // than it is.
    const ecs = familiesEcs({
      app: { active: [8, 7], inactive: [10, 9] },
    });

    const [app] = await listTaskDefinitionFamilies(ecs, true);

    expect(app.latestRevision).toBe(10);
  });

  test("handles a family with only INACTIVE revisions", async () => {
    const ecs = familiesEcs({ app: { active: [], inactive: [3, 2, 1] } });

    const [app] = await listTaskDefinitionFamilies(ecs, true);

    expect(app).toMatchObject({
      revisionCount: 3,
      activeCount: 0,
      inactiveCount: 3,
      latestRevision: 3,
    });
  });

  test("drops a family whose revisions have all been deleted", async () => {
    const ecs = familiesEcs({
      app: { active: [1], inactive: [] },
      gone: { active: [], inactive: [] },
    });

    const families = await listTaskDefinitionFamilies(ecs, true);

    expect(families.map((f) => f.family)).toEqual(["app"]);
  });

  test("sorts by revision count so the biggest cleanup targets come first", async () => {
    const ecs = familiesEcs({
      small: { active: [1], inactive: [] },
      large: { active: [3, 2, 1], inactive: [6, 5] },
      medium: { active: [2, 1], inactive: [] },
    });

    const families = await listTaskDefinitionFamilies(ecs, true);

    expect(families.map((f) => f.family)).toEqual(["large", "medium", "small"]);
  });

  test("paginates the family listing", async () => {
    const spec = Object.fromEntries(
      Array.from({ length: 230 }, (_, i) => [
        `family-${i}`,
        { active: [1], inactive: [] },
      ]),
    );
    const ecs = makeEcs({
      listTaskDefinitionFamilies: paged("families", Object.keys(spec), 100),
      listTaskDefinitions: async ({ familyPrefix, status }) => ({
        taskDefinitionArns:
          status === "INACTIVE" ? [] : [tdArn(1, familyPrefix)],
      }),
    });

    const families = await listTaskDefinitionFamilies(ecs, true);

    expect(families).toHaveLength(230);
    expect(ecs.callsTo("listTaskDefinitionFamilies")).toHaveLength(3);
  });

  test("bounds how many families it inspects at once", async () => {
    // Unbounded fan-out over thousands of families throttles the account.
    const inFlight = new Set();
    let peak = 0;

    const spec = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        `family-${i}`,
        { active: [1], inactive: [] },
      ]),
    );

    const ecs = familiesEcs(spec, {
      onList: async (family) => {
        inFlight.add(family);
        peak = Math.max(peak, inFlight.size);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight.delete(family);
      },
    });

    await listTaskDefinitionFamilies(ecs, true);

    expect(peak).toBeLessThanOrEqual(FAMILY_DETAIL_CONCURRENCY);
  });

  test("skips a family it cannot read instead of losing the whole listing", async () => {
    const ecs = familiesEcs({
      app: { active: [2, 1], inactive: [] },
      restricted: new Error("AccessDeniedException"),
      other: { active: [1], inactive: [] },
    });

    const families = await listTaskDefinitionFamilies(ecs, true);

    expect(families.map((f) => f.family)).toEqual(["app", "other"]);
  });

  test("returns an empty list when the account has no task definitions", async () => {
    const ecs = makeEcs({
      listTaskDefinitionFamilies: paged("families", []),
    });

    expect(await listTaskDefinitionFamilies(ecs, true)).toEqual([]);
  });

  test("propagates a failure to list families at all", async () => {
    const ecs = makeEcs({
      listTaskDefinitionFamilies: async () => {
        throw new Error("ExpiredTokenException");
      },
    });

    await expect(listTaskDefinitionFamilies(ecs, true)).rejects.toThrow(
      "ExpiredTokenException",
    );
  });
});
