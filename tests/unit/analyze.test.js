import { describe, expect, test } from "@jest/globals";
import {
  analyzeTaskDefinitionRevisions,
  collectInUseTaskDefinitions,
  KEEP_LATEST_COUNT,
} from "../../index.js";

const arn = (revision, family = "app") =>
  `arn:aws:ecs:us-east-1:1:task-definition/${family}:${revision}`;

/**
 * Minimal ECS double. Records which statuses were requested so the tests can
 * assert on the call the analysis actually makes, not just on its output.
 */
function fakeEcs({ active = [], inactive = [], services = [], tasks = [] }) {
  const requestedStatuses = [];

  return {
    requestedStatuses,
    listTaskDefinitions: async ({ status }) => {
      requestedStatuses.push(status);
      return {
        taskDefinitionArns: status === "INACTIVE" ? inactive : active,
      };
    },
    describeTaskDefinition: async ({ taskDefinition }) => ({
      taskDefinition: {
        family: "app",
        revision: Number(taskDefinition.split(":").pop()),
        status: inactive.includes(taskDefinition) ? "INACTIVE" : "ACTIVE",
        registeredAt: new Date("2026-01-01T00:00:00Z"),
        containerDefinitions: [],
      },
    }),
    listServices: async () => ({
      serviceArns: services.map((s) => s.serviceArn),
    }),
    describeServices: async () => ({ services }),
    listTasks: async () => ({ taskArns: tasks.map((t) => t.taskArn) }),
    describeTasks: async () => ({ tasks }),
  };
}

describe("analyzeTaskDefinitionRevisions", () => {
  test("requests both ACTIVE and INACTIVE revisions", async () => {
    // Regression: status was omitted, and ListTaskDefinitions lists only ACTIVE
    // revisions by default. INACTIVE ones were invisible to the analysis.
    const ecs = fakeEcs({ active: [arn(10)], inactive: [arn(9)] });

    await analyzeTaskDefinitionRevisions(ecs, "app", null, true);

    expect(ecs.requestedStatuses).toContain("ACTIVE");
    expect(ecs.requestedStatuses).toContain("INACTIVE");
  });

  test("includes INACTIVE revisions in the result", async () => {
    const ecs = fakeEcs({
      active: [arn(10), arn(8)],
      inactive: [arn(9), arn(7)],
    });

    const { revisions } = await analyzeTaskDefinitionRevisions(
      ecs,
      "app",
      null,
      true,
    );

    expect(revisions.map((r) => r.revision)).toEqual([10, 9, 8, 7]);
    expect(revisions.filter((r) => r.status === "INACTIVE")).toHaveLength(2);
  });

  test("an inactive-only family is not reported as empty", async () => {
    // Regression: such a family showed "No revisions found".
    const ecs = fakeEcs({ active: [], inactive: [arn(3), arn(2), arn(1)] });

    const { revisions, latest } = await analyzeTaskDefinitionRevisions(
      ecs,
      "app",
      null,
      true,
    );

    expect(revisions).toHaveLength(3);
    expect(latest).toBe(3);
  });

  test("the keep window spans both statuses", async () => {
    // "Latest 5" means the newest 5 overall; an INACTIVE revision newer than an
    // ACTIVE one must still occupy a slot in the window.
    const ecs = fakeEcs({
      active: [arn(10), arn(5)],
      inactive: [arn(9), arn(8), arn(7), arn(6)],
    });

    const { revisions } = await analyzeTaskDefinitionRevisions(
      ecs,
      "app",
      null,
      true,
    );

    const kept = revisions.filter((r) => r.isInLatest5).map((r) => r.revision);
    expect(kept).toEqual([10, 9, 8, 7, 6]);
    expect(kept).toHaveLength(KEEP_LATEST_COUNT);
  });

  test("protects revisions held by an in-flight deployment", async () => {
    const ecs = fakeEcs({
      active: [arn(10), arn(9), arn(8), arn(7), arn(6), arn(5), arn(4)],
      inactive: [],
      services: [
        {
          serviceArn: "svc-1",
          serviceName: "app-service",
          taskDefinition: arn(10),
          deployments: [
            { status: "PRIMARY", taskDefinition: arn(10) },
            { status: "ACTIVE", taskDefinition: arn(4) },
          ],
          status: "ACTIVE",
          desiredCount: 1,
          runningCount: 1,
        },
      ],
    });

    const { revisions } = await analyzeTaskDefinitionRevisions(
      ecs,
      "app",
      "my-cluster",
      true,
    );

    const draining = revisions.find((r) => r.revision === 4);
    expect(draining.isInUse).toBe(true);
    expect(draining.isProtected).toBe(true);
  });

  test("protects revisions held by standalone tasks", async () => {
    const ecs = fakeEcs({
      active: [arn(10), arn(9), arn(8), arn(7), arn(6), arn(5), arn(4)],
      services: [],
      tasks: [{ taskArn: "task-1", taskDefinitionArn: arn(5) }],
    });

    const { revisions } = await analyzeTaskDefinitionRevisions(
      ecs,
      "app",
      "my-cluster",
      true,
    );

    expect(revisions.find((r) => r.revision === 5).isProtected).toBe(true);
  });

  test("fails closed when the in-use lookup errors", async () => {
    const ecs = fakeEcs({ active: [arn(2), arn(1)] });
    ecs.listServices = async () => {
      throw new Error("AccessDeniedException");
    };

    await expect(
      analyzeTaskDefinitionRevisions(ecs, "app", "my-cluster", true),
    ).rejects.toThrow(/Refusing to continue/);
  });
});

describe("collectInUseTaskDefinitions", () => {
  test("covers primary, draining deployments, task sets and standalone tasks", async () => {
    const ecs = fakeEcs({
      services: [
        {
          serviceArn: "svc-1",
          serviceName: "app-service",
          taskDefinition: arn(10),
          deployments: [{ status: "ACTIVE", taskDefinition: arn(9) }],
          taskSets: [{ taskDefinition: arn(8) }],
          status: "ACTIVE",
          desiredCount: 1,
          runningCount: 1,
        },
      ],
      tasks: [{ taskArn: "task-1", taskDefinitionArn: arn(7) }],
    });

    const inUse = await collectInUseTaskDefinitions(ecs, "my-cluster");

    expect(inUse).toEqual(new Set([arn(10), arn(9), arn(8), arn(7)]));
  });

  test("returns an empty set for an idle cluster", async () => {
    const inUse = await collectInUseTaskDefinitions(
      fakeEcs({ services: [], tasks: [] }),
      "my-cluster",
    );

    expect(inUse.size).toBe(0);
  });
});
