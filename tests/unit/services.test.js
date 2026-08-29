import { describe, expect, test } from "@jest/globals";
import {
  compareTaskDefinitions,
  listServices,
  listTaskDefinitionRevisions,
  performRollback,
  DESCRIBE_SERVICES_BATCH_SIZE,
  ROLLBACK_REVISION_LIMIT,
} from "../../index.js";
import {
  failFirst,
  makeEcs,
  paged,
  serviceArn,
  tdArn,
  throttlingError,
} from "../helpers/ecs-double.js";

/** Builds a DescribeServices entry. */
function service(name, revision, extra = {}) {
  return {
    serviceArn: serviceArn(name),
    serviceName: name,
    taskDefinition: tdArn(revision),
    status: "ACTIVE",
    desiredCount: 2,
    runningCount: 2,
    ...extra,
  };
}

/** ECS double whose DescribeServices answers from a name-keyed map. */
function servicesEcs(services, pageSize) {
  const byArn = new Map(services.map((s) => [s.serviceArn, s]));
  return makeEcs({
    listServices: paged(
      "serviceArns",
      services.map((s) => s.serviceArn),
      pageSize ?? Math.max(services.length, 1),
    ),
    describeServices: async ({ services: batch }) => ({
      services: batch.map((arn) => byArn.get(arn)).filter(Boolean),
    }),
  });
}

describe("listServices", () => {
  test("returns every service, not the first page only", async () => {
    // Regression: ListServices defaults to 10 results. A cluster with exactly
    // 10 services looked complete right up until the eleventh deploy, at which
    // point pruning stopped seeing revisions that were serving traffic.
    const services = Array.from({ length: 23 }, (_, i) =>
      service(`svc-${i}`, i + 1),
    );
    const ecs = servicesEcs(services, 10);

    const result = await listServices(ecs, "prod", true);

    expect(result).toHaveLength(23);
    expect(ecs.callsTo("listServices")).toHaveLength(3);
  });

  test("describes services in batches of at most ten", async () => {
    // DescribeServices rejects more than 10 services per call.
    const services = Array.from({ length: 23 }, (_, i) =>
      service(`svc-${i}`, i + 1),
    );
    const ecs = servicesEcs(services);

    await listServices(ecs, "prod", true);

    const batches = ecs.callsTo("describeServices");
    expect(batches).toHaveLength(3);
    for (const call of batches) {
      expect(call.params.services.length).toBeLessThanOrEqual(
        DESCRIBE_SERVICES_BATCH_SIZE,
      );
      expect(call.params.cluster).toBe("prod");
    }
  });

  test("exposes every revision a service references, not just PRIMARY", async () => {
    const ecs = servicesEcs([
      service("api", 10, {
        deployments: [
          { status: "PRIMARY", taskDefinition: tdArn(10) },
          { status: "ACTIVE", taskDefinition: tdArn(9) },
        ],
        taskSets: [{ taskDefinition: tdArn(8) }],
      }),
    ]);

    const [api] = await listServices(ecs, "prod", true);

    expect(api.inUseTaskDefinitions).toEqual([tdArn(10), tdArn(9), tdArn(8)]);
    expect(api.taskDefinitionFamily).toBe("app");
    expect(api.revision).toBe(10);
  });

  test("returns an empty list for a cluster with no services", async () => {
    const ecs = servicesEcs([]);

    expect(await listServices(ecs, "prod", true)).toEqual([]);
    expect(ecs.callsTo("describeServices")).toHaveLength(0);
  });

  test("propagates a DescribeServices failure", async () => {
    const ecs = makeEcs({
      listServices: paged("serviceArns", [serviceArn("api")]),
      describeServices: async () => {
        throw new Error("ClusterNotFoundException");
      },
    });

    await expect(listServices(ecs, "gone", true)).rejects.toThrow(
      "ClusterNotFoundException",
    );
  });
});

describe("listTaskDefinitionRevisions", () => {
  /** ECS double serving `count` ACTIVE revisions in DESC order. */
  function revisionsEcs(count, describeOverride) {
    const arns = Array.from({ length: count }, (_, i) => tdArn(count - i));
    return makeEcs({
      listTaskDefinitions: paged("taskDefinitionArns", arns, 100),
      describeTaskDefinition:
        describeOverride ??
        (async ({ taskDefinition }) => ({
          taskDefinition: {
            revision: Number(taskDefinition.split(":").pop()),
            status: "ACTIVE",
            registeredAt: new Date("2026-01-01T00:00:00Z"),
          },
        })),
    });
  }

  test("offers only ACTIVE revisions, newest first", async () => {
    // An INACTIVE revision cannot be used to update a service, so offering one
    // as a rollback target would fail at the API.
    const ecs = revisionsEcs(4);

    const revisions = await listTaskDefinitionRevisions(ecs, "app", true);

    expect(revisions.map((r) => r.revision)).toEqual([4, 3, 2, 1]);
    expect(ecs.callsTo("listTaskDefinitions")[0].params).toMatchObject({
      familyPrefix: "app",
      status: "ACTIVE",
      sort: "DESC",
    });
  });

  test("paginates past the first hundred revisions", async () => {
    const ecs = revisionsEcs(250);

    await listTaskDefinitionRevisions(ecs, "app", true);

    expect(ecs.callsTo("listTaskDefinitions")).toHaveLength(3);
  });

  test("describes only the revisions it will show", async () => {
    // Describing all 2,000 revisions of a busy family just to render a picker
    // costs minutes and invites throttling.
    const ecs = revisionsEcs(250);

    const revisions = await listTaskDefinitionRevisions(ecs, "app", true);

    expect(revisions).toHaveLength(ROLLBACK_REVISION_LIMIT);
    expect(ecs.callsTo("describeTaskDefinition")).toHaveLength(
      ROLLBACK_REVISION_LIMIT,
    );
    expect(revisions[0].revision).toBe(250);
  });

  test("skips a revision that cannot be described rather than failing", async () => {
    const ecs = revisionsEcs(3, async ({ taskDefinition }) => {
      const revision = Number(taskDefinition.split(":").pop());
      if (revision === 2) throw new Error("ClientException");
      return {
        taskDefinition: {
          revision,
          status: "ACTIVE",
          registeredAt: new Date("2026-01-01T00:00:00Z"),
        },
      };
    });

    const revisions = await listTaskDefinitionRevisions(ecs, "app", true);

    expect(revisions.map((r) => r.revision)).toEqual([3, 1]);
  });

  test("returns an empty list for an unknown family", async () => {
    const ecs = makeEcs({
      listTaskDefinitions: paged("taskDefinitionArns", []),
    });

    expect(await listTaskDefinitionRevisions(ecs, "ghost", true)).toEqual([]);
  });

  test("recovers from a throttled listing instead of reporting an empty family", async () => {
    // Regression: a throttled first page left the picker empty, which reads as
    // "this family has no revisions" rather than "try again".
    const ecs = makeEcs({
      listTaskDefinitions: failFirst(
        1,
        throttlingError,
        paged("taskDefinitionArns", [tdArn(2), tdArn(1)]),
      ),
      describeTaskDefinition: async ({ taskDefinition }) => ({
        taskDefinition: {
          revision: Number(taskDefinition.split(":").pop()),
          status: "ACTIVE",
          registeredAt: new Date("2026-01-01T00:00:00Z"),
        },
      }),
    });

    const revisions = await listTaskDefinitionRevisions(ecs, "app", true);

    expect(revisions.map((r) => r.revision)).toEqual([2, 1]);
  });
});

describe("compareTaskDefinitions", () => {
  /** ECS double returning two revisions keyed by ARN. */
  function compareEcs(current, target) {
    return makeEcs({
      describeTaskDefinition: async ({ taskDefinition }) => ({
        taskDefinition: taskDefinition === tdArn(10) ? current : target,
      }),
    });
  }

  const base = {
    family: "app",
    registeredAt: new Date("2026-01-01T00:00:00Z"),
    cpu: "512",
    memory: "1024",
  };

  test("reports an image change per container", async () => {
    const ecs = compareEcs(
      {
        ...base,
        revision: 10,
        containerDefinitions: [{ name: "api", image: "repo/api:v2" }],
      },
      {
        ...base,
        revision: 9,
        containerDefinitions: [{ name: "api", image: "repo/api:v1" }],
      },
    );

    const { differences, current, target } = await compareTaskDefinitions(
      ecs,
      tdArn(10),
      tdArn(9),
      true,
    );

    expect(current.revision).toBe(10);
    expect(target.revision).toBe(9);
    expect(differences).toEqual([
      {
        type: "image",
        container: "api",
        current: "repo/api:v2",
        target: "repo/api:v1",
      },
    ]);
  });

  test("reports containers added and removed by the rollback", async () => {
    // Walking only the current revision's containers hides the fact that a
    // rollback would drop a sidecar the service depends on.
    const ecs = compareEcs(
      {
        ...base,
        revision: 10,
        containerDefinitions: [
          { name: "api", image: "repo/api:v2" },
          { name: "otel", image: "repo/otel:1" },
        ],
      },
      {
        ...base,
        revision: 9,
        containerDefinitions: [
          { name: "api", image: "repo/api:v2" },
          { name: "legacy-sidecar", image: "repo/legacy:1" },
        ],
      },
    );

    const { differences } = await compareTaskDefinitions(
      ecs,
      tdArn(10),
      tdArn(9),
      true,
    );

    expect(differences).toContainEqual({
      type: "container_removed",
      container: "otel",
      current: "repo/otel:1",
    });
    expect(differences).toContainEqual({
      type: "container_added",
      container: "legacy-sidecar",
      target: "repo/legacy:1",
    });
  });

  test("reports cpu and memory changes", async () => {
    const ecs = compareEcs(
      { ...base, revision: 10, cpu: "1024", containerDefinitions: [] },
      { ...base, revision: 9, memory: "2048", containerDefinitions: [] },
    );

    const { differences } = await compareTaskDefinitions(
      ecs,
      tdArn(10),
      tdArn(9),
      true,
    );

    expect(differences).toContainEqual({
      type: "cpu",
      current: "1024",
      target: "512",
    });
    expect(differences).toContainEqual({
      type: "memory",
      current: "1024",
      target: "2048",
    });
  });

  test("reports no differences for identical revisions", async () => {
    const identical = {
      ...base,
      revision: 10,
      containerDefinitions: [{ name: "api", image: "repo/api:v2" }],
    };
    const ecs = compareEcs(identical, { ...identical, revision: 9 });

    const { differences } = await compareTaskDefinitions(
      ecs,
      tdArn(10),
      tdArn(9),
      true,
    );

    expect(differences).toEqual([]);
  });
});

describe("performRollback", () => {
  test("updates the service to the target revision", async () => {
    const ecs = makeEcs({
      updateService: async () => ({ service: { serviceName: "api" } }),
    });

    const response = await performRollback(ecs, "prod", "api", tdArn(9), true);

    expect(ecs.callsTo("updateService")[0].params).toEqual({
      cluster: "prod",
      service: "api",
      taskDefinition: tdArn(9),
    });
    expect(response.service.serviceName).toBe("api");
  });

  test("propagates an update failure instead of reporting success", async () => {
    const ecs = makeEcs({
      updateService: async () => {
        throw new Error("ServiceNotActiveException");
      },
    });

    await expect(
      performRollback(ecs, "prod", "api", tdArn(9), true),
    ).rejects.toThrow("ServiceNotActiveException");
  });
});
