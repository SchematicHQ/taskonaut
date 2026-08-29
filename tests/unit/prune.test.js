import { describe, expect, test } from "@jest/globals";
import {
  computeDeletionBuckets,
  generateDeletionPlan,
  KEEP_LATEST_COUNT,
} from "../../index.js";

const NOW = Date.UTC(2026, 0, 1);
const DAY = 24 * 60 * 60 * 1000;

/**
 * Builds a DESC-ordered revision list shaped like analyzeTaskDefinitionRevisions
 * returns, with index 0 as the newest revision.
 */
function buildRevisions(count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => {
    const revision = count - index;
    const isLatest = index === 0;
    const isInUse = Boolean(overrides.inUseRevisions?.includes(revision));

    return {
      arn: `arn:aws:ecs:us-east-1:1:task-definition/app:${revision}`,
      revision,
      status: overrides.activeRevisions?.includes(revision)
        ? "ACTIVE"
        : "INACTIVE",
      createdAt: new Date(NOW - index * 10 * DAY),
      isLatest,
      isInUse,
      isInLatest5: index < KEEP_LATEST_COUNT,
      isProtected: isLatest || isInUse,
    };
  });
}

describe("computeDeletionBuckets", () => {
  test("never offers a revision inside the keep window", () => {
    const revisions = buildRevisions(20);
    const buckets = computeDeletionBuckets(revisions, NOW);

    const keptRevisionNumbers = revisions
      .slice(0, KEEP_LATEST_COUNT)
      .map((r) => r.revision);

    const offered = new Set(
      [
        ...buckets.deletable,
        ...buckets.inactiveBeyondLatestN,
        ...buckets.beyondLatest10,
        ...Object.values(buckets.revisionsByAge).flat(),
      ].map((r) => r.revision),
    );

    for (const revision of keptRevisionNumbers) {
      expect(offered.has(revision)).toBe(false);
    }
  });

  test("age buckets exclude the keep window even when every revision is old", () => {
    // Regression: the age filters previously checked only isProtected, so a
    // family whose last deploy was months ago offered revisions 2-5 -- exactly
    // the ones a rollback would target.
    const revisions = buildRevisions(20).map((r) => ({
      ...r,
      createdAt: new Date(NOW - 400 * DAY),
    }));

    const buckets = computeDeletionBuckets(revisions, NOW);

    for (const days of buckets.ageBuckets) {
      const offered = buckets.revisionsByAge[days];
      expect(offered.every((r) => !r.isInLatest5)).toBe(true);
      expect(offered.every((r) => !r.isProtected)).toBe(true);
    }
  });

  test("never offers a revision in use by a service", () => {
    const revisions = buildRevisions(20, { inUseRevisions: [8, 3] });
    const buckets = computeDeletionBuckets(revisions, NOW);

    expect(buckets.deletable.some((r) => r.revision === 8)).toBe(false);
    expect(buckets.deletable.some((r) => r.revision === 3)).toBe(false);
  });

  test("beyondLatest10 starts at position 10 of the DESC list", () => {
    const revisions = buildRevisions(20);
    const buckets = computeDeletionBuckets(revisions, NOW);

    expect(buckets.beyondLatest10).toHaveLength(10);
    expect(buckets.beyondLatest10[0].revision).toBe(10);
  });

  test("age buckets narrow as the threshold grows", () => {
    const revisions = buildRevisions(40);
    const { revisionsByAge } = computeDeletionBuckets(revisions, NOW);

    expect(revisionsByAge[30].length).toBeGreaterThanOrEqual(
      revisionsByAge[90].length,
    );
    expect(revisionsByAge[90].length).toBeGreaterThanOrEqual(
      revisionsByAge[180].length,
    );
    expect(revisionsByAge[180].length).toBeGreaterThanOrEqual(
      revisionsByAge[365].length,
    );
  });

  test("offers nothing when the family is smaller than the keep window", () => {
    const buckets = computeDeletionBuckets(buildRevisions(3), NOW);

    expect(buckets.deletable).toEqual([]);
    expect(buckets.inactiveBeyondLatestN).toEqual([]);
    expect(buckets.beyondLatest10).toEqual([]);
  });

  test("inactiveBeyondLatestN excludes ACTIVE revisions", () => {
    const revisions = buildRevisions(20, { activeRevisions: [9, 8] });
    const { inactiveBeyondLatestN } = computeDeletionBuckets(revisions, NOW);

    expect(inactiveBeyondLatestN.every((r) => r.status === "INACTIVE")).toBe(
      true,
    );
    expect(inactiveBeyondLatestN.some((r) => r.revision === 9)).toBe(false);
  });
});

describe("generateDeletionPlan", () => {
  test("splits the selection into deregister and delete phases", () => {
    const revisions = buildRevisions(20, { activeRevisions: [9, 8] });
    const selected = revisions.filter((r) => [9, 8, 7, 6].includes(r.revision));

    const plan = generateDeletionPlan(revisions, selected);

    expect(plan.willDeregister).toBe(2);
    expect(plan.deregisterRevisions.map((r) => r.revision).sort()).toEqual([
      8, 9,
    ]);
    expect(plan.willDelete).toBe(2);
    expect(plan.deleteRevisions.map((r) => r.revision).sort()).toEqual([6, 7]);
  });

  test("kept plus selected accounts for every revision", () => {
    const revisions = buildRevisions(20);
    const selected = revisions.slice(10, 15);

    const plan = generateDeletionPlan(revisions, selected);

    expect(plan.total).toBe(20);
    expect(plan.kept + plan.selected).toBe(20);
    expect(plan.keptRevisions).not.toEqual(expect.arrayContaining(selected));
  });

  test("reports protected revisions independently of the selection", () => {
    const revisions = buildRevisions(20, { inUseRevisions: [12] });
    const plan = generateDeletionPlan(revisions, []);

    // Latest revision plus the one in use by a service.
    expect(plan.protected).toBe(2);
    expect(plan.selected).toBe(0);
    expect(plan.kept).toBe(20);
  });
});
