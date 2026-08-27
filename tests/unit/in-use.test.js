import { describe, expect, test } from "@jest/globals";
import {
  extractServiceTaskDefinitions,
  mergeRevisionArnsDesc,
} from "../../index.js";

const arn = (family, revision) =>
  `arn:aws:ecs:us-east-1:1:task-definition/${family}:${revision}`;

describe("extractServiceTaskDefinitions", () => {
  test("keeps the primary task definition", () => {
    expect(
      extractServiceTaskDefinitions({ taskDefinition: arn("app", 5) }),
    ).toEqual([arn("app", 5)]);
  });

  test("includes revisions still draining under an in-flight deployment", () => {
    // Regression: only service.taskDefinition (PRIMARY) was collected, so
    // during a rolling deploy the previous revision was still running yet
    // counted as prunable.
    const result = extractServiceTaskDefinitions({
      taskDefinition: arn("app", 5),
      deployments: [
        { status: "PRIMARY", taskDefinition: arn("app", 5), runningCount: 1 },
        { status: "ACTIVE", taskDefinition: arn("app", 4), runningCount: 2 },
      ],
    });

    expect(result).toContain(arn("app", 4));
    expect(result).toHaveLength(2);
  });

  test("includes task sets used by CodeDeploy and EXTERNAL deployments", () => {
    const result = extractServiceTaskDefinitions({
      taskDefinition: arn("app", 5),
      taskSets: [
        { taskDefinition: arn("app", 5) },
        { taskDefinition: arn("app", 3) },
      ],
    });

    expect(result).toContain(arn("app", 3));
  });

  test("deduplicates and tolerates missing fields", () => {
    expect(
      extractServiceTaskDefinitions({
        taskDefinition: arn("app", 5),
        deployments: [{ taskDefinition: arn("app", 5) }, {}],
        taskSets: null,
      }),
    ).toEqual([arn("app", 5)]);
  });

  test("returns nothing for an empty service", () => {
    expect(extractServiceTaskDefinitions({})).toEqual([]);
  });
});

describe("mergeRevisionArnsDesc", () => {
  test("interleaves INACTIVE revisions into the newest-first ordering", () => {
    // Regression: ListTaskDefinitions returns only ACTIVE revisions unless
    // status is set, so INACTIVE ones were invisible to the analysis and the
    // recommended INACTIVE bucket was always empty.
    const active = [arn("app", 10), arn("app", 7)];
    const inactive = [arn("app", 9), arn("app", 8), arn("app", 6)];

    expect(mergeRevisionArnsDesc(active, inactive)).toEqual([
      arn("app", 10),
      arn("app", 9),
      arn("app", 8),
      arn("app", 7),
      arn("app", 6),
    ]);
  });

  test("the keep window spans both statuses", () => {
    // "Latest 5" must mean the newest 5 overall; computing it over ACTIVE-only
    // revisions would let a newer INACTIVE revision fall outside the window.
    const merged = mergeRevisionArnsDesc(
      [arn("app", 10), arn("app", 5)],
      [arn("app", 9), arn("app", 8), arn("app", 7), arn("app", 6)],
    );

    expect(merged.slice(0, 5)).toEqual([
      arn("app", 10),
      arn("app", 9),
      arn("app", 8),
      arn("app", 7),
      arn("app", 6),
    ]);
  });

  test("handles either side being empty", () => {
    expect(mergeRevisionArnsDesc([], [arn("app", 2)])).toEqual([arn("app", 2)]);
    expect(mergeRevisionArnsDesc([arn("app", 2)], [])).toEqual([arn("app", 2)]);
    expect(mergeRevisionArnsDesc([], [])).toEqual([]);
  });
});
