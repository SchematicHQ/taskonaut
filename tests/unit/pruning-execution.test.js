import { describe, expect, test } from "@jest/globals";
import {
  deleteTaskDefinitions,
  deregisterTaskDefinitions,
  performPruning,
} from "../../index.js";
import {
  failFirst,
  makeEcs,
  tdArn,
  throttlingError,
} from "../helpers/ecs-double.js";

/** Builds a revision as analyzeTaskDefinitionRevisions returns it. */
const revision = (number, status) => ({
  arn: tdArn(number),
  revision: number,
  status,
});

describe("deregisterTaskDefinitions", () => {
  test("deregisters every revision exactly once", async () => {
    const ecs = makeEcs({ deregisterTaskDefinition: async () => ({}) });
    const arns = [tdArn(3), tdArn(2), tdArn(1)];

    const { success, failed } = await deregisterTaskDefinitions(
      ecs,
      arns,
      true,
    );

    expect(success).toEqual(arns);
    expect(failed).toEqual([]);
    expect(
      ecs.callsTo("deregisterTaskDefinition").map((c) => c.params),
    ).toEqual(arns.map((arn) => ({ taskDefinition: arn })));
  });

  test("records a failure and keeps going", async () => {
    // A partial permission failure part-way through a 300-revision cleanup
    // must not abandon the remaining revisions.
    const ecs = makeEcs({
      deregisterTaskDefinition: async ({ taskDefinition }) => {
        if (taskDefinition === tdArn(2)) throw new Error("ClientException");
        return {};
      },
    });

    const { success, failed } = await deregisterTaskDefinitions(
      ecs,
      [tdArn(3), tdArn(2), tdArn(1)],
      true,
    );

    expect(success).toEqual([tdArn(3), tdArn(1)]);
    expect(failed).toEqual([{ arn: tdArn(2), error: "ClientException" }]);
  });

  test("does not retry a non-throttling error", async () => {
    const ecs = makeEcs({
      deregisterTaskDefinition: async () => {
        throw new Error("InvalidParameterException");
      },
    });

    await deregisterTaskDefinitions(ecs, [tdArn(1)], true);

    expect(ecs.callsTo("deregisterTaskDefinition")).toHaveLength(1);
  });

  test("retries a throttled revision", async () => {
    const ecs = makeEcs({
      deregisterTaskDefinition: failFirst(1, throttlingError, async () => ({})),
    });

    const { success } = await deregisterTaskDefinitions(ecs, [tdArn(1)], true);

    expect(success).toEqual([tdArn(1)]);
    expect(ecs.callsTo("deregisterTaskDefinition")).toHaveLength(2);
  });

  test("reports a revision that stays throttled rather than claiming success", async () => {
    const ecs = makeEcs({
      deregisterTaskDefinition: async () => {
        throw throttlingError();
      },
    });

    const { success, failed } = await deregisterTaskDefinitions(
      ecs,
      [tdArn(1)],
      true,
    );

    expect(success).toEqual([]);
    expect(failed).toHaveLength(1);
    expect(failed[0].arn).toBe(tdArn(1));
  }, 20000);

  test("does nothing for an empty selection", async () => {
    const ecs = makeEcs({ deregisterTaskDefinition: async () => ({}) });

    expect(await deregisterTaskDefinitions(ecs, [], true)).toEqual({
      success: [],
      failed: [],
    });
    expect(ecs.callsTo("deregisterTaskDefinition")).toHaveLength(0);
  });
});

describe("deleteTaskDefinitions", () => {
  test("deletes in batches of at most ten", async () => {
    // DeleteTaskDefinitions accepts at most 10 revisions per call.
    const ecs = makeEcs({ deleteTaskDefinitions: async () => ({}) });
    const arns = Array.from({ length: 25 }, (_, i) => tdArn(i + 1));

    const { success } = await deleteTaskDefinitions(ecs, arns, true);

    const batches = ecs.callsTo("deleteTaskDefinitions");
    expect(batches).toHaveLength(3);
    expect(batches.map((c) => c.params.taskDefinitions.length)).toEqual([
      10, 10, 5,
    ]);
    expect(success).toEqual(arns);
  });

  test("records per-revision failures reported by the API", async () => {
    const ecs = makeEcs({
      deleteTaskDefinitions: async () => ({
        failures: [{ arn: tdArn(2), reason: "MISSING" }],
      }),
    });

    const { success, failed } = await deleteTaskDefinitions(
      ecs,
      [tdArn(1), tdArn(2), tdArn(3)],
      true,
    );

    expect(success).toEqual([tdArn(1), tdArn(3)]);
    expect(failed).toEqual([{ arn: tdArn(2), error: "MISSING" }]);
  });

  test("attributes a whole-batch error to every revision in it", async () => {
    const ecs = makeEcs({
      deleteTaskDefinitions: async () => {
        throw new Error("AccessDeniedException");
      },
    });

    const { success, failed } = await deleteTaskDefinitions(
      ecs,
      [tdArn(1), tdArn(2)],
      true,
    );

    expect(success).toEqual([]);
    expect(failed.map((f) => f.arn)).toEqual([tdArn(1), tdArn(2)]);
  });

  test("continues with later batches after one fails", async () => {
    const ecs = makeEcs({
      deleteTaskDefinitions: failFirst(
        1,
        new Error("AccessDeniedException"),
        async () => ({}),
      ),
    });
    const arns = Array.from({ length: 15 }, (_, i) => tdArn(i + 1));

    const { success, failed } = await deleteTaskDefinitions(ecs, arns, true);

    expect(failed).toHaveLength(10);
    expect(success).toHaveLength(5);
  });

  test("retries a throttled batch", async () => {
    const ecs = makeEcs({
      deleteTaskDefinitions: failFirst(1, throttlingError, async () => ({})),
    });

    const { success } = await deleteTaskDefinitions(ecs, [tdArn(1)], true);

    expect(success).toEqual([tdArn(1)]);
    expect(ecs.callsTo("deleteTaskDefinitions")).toHaveLength(2);
  });

  test("does nothing for an empty selection", async () => {
    const ecs = makeEcs({ deleteTaskDefinitions: async () => ({}) });

    expect(await deleteTaskDefinitions(ecs, [], true)).toEqual({
      success: [],
      failed: [],
    });
    expect(ecs.callsTo("deleteTaskDefinitions")).toHaveLength(0);
  });
});

describe("performPruning", () => {
  test("deregisters ACTIVE revisions before deleting them", async () => {
    // ECS refuses to delete a revision that is still ACTIVE, so the order of
    // these two phases is the whole operation.
    const ecs = makeEcs({
      deregisterTaskDefinition: async () => ({}),
      deleteTaskDefinitions: async () => ({}),
    });

    const results = await performPruning(ecs, [
      revision(4, "ACTIVE"),
      revision(3, "INACTIVE"),
    ]);

    const order = ecs.calls.map((c) => c.name);
    expect(order.indexOf("deregisterTaskDefinition")).toBeLessThan(
      order.indexOf("deleteTaskDefinitions"),
    );
    expect(results.deregister.success).toEqual([tdArn(4)]);
    expect(results.delete.success).toEqual(
      expect.arrayContaining([tdArn(3), tdArn(4)]),
    );
  });

  test("does not delete a revision that failed to deregister", async () => {
    // Deleting a revision whose deregister failed would ask ECS to remove one
    // that is still ACTIVE -- and, on a partial failure, one that may still be
    // referenced by a service.
    const ecs = makeEcs({
      deregisterTaskDefinition: async ({ taskDefinition }) => {
        if (taskDefinition === tdArn(4)) throw new Error("ClientException");
        return {};
      },
      deleteTaskDefinitions: async () => ({}),
    });

    const results = await performPruning(ecs, [
      revision(5, "ACTIVE"),
      revision(4, "ACTIVE"),
    ]);

    const deleted = ecs
      .callsTo("deleteTaskDefinitions")
      .flatMap((c) => c.params.taskDefinitions);

    expect(deleted).toEqual([tdArn(5)]);
    expect(results.deregister.failed.map((f) => f.arn)).toEqual([tdArn(4)]);
  });

  test("skips the deregister phase when nothing is ACTIVE", async () => {
    const ecs = makeEcs({
      deregisterTaskDefinition: async () => ({}),
      deleteTaskDefinitions: async () => ({}),
    });

    await performPruning(ecs, [revision(3, "INACTIVE")]);

    expect(ecs.callsTo("deregisterTaskDefinition")).toHaveLength(0);
    expect(ecs.callsTo("deleteTaskDefinitions")).toHaveLength(1);
  });

  test("calls nothing for an empty selection", async () => {
    const ecs = makeEcs({
      deregisterTaskDefinition: async () => ({}),
      deleteTaskDefinitions: async () => ({}),
    });

    const results = await performPruning(ecs, []);

    expect(ecs.calls).toEqual([]);
    expect(results).toEqual({
      deregister: { success: [], failed: [] },
      delete: { success: [], failed: [] },
    });
  });
});
