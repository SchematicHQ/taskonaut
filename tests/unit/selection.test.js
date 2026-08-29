import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import {
  clusterArn,
  makeEcs,
  paged,
  serviceArn,
  taskArn,
  tdArn,
} from "../helpers/ecs-double.js";
import { mockPrompts } from "../helpers/prompts-mock.js";

const prompt = mockPrompts();

// Imported after the mock is registered so the CLI resolves the stand-in.
const {
  selectCluster,
  selectContainer,
  selectRevisionsToDelete,
  selectTask,
  selectTaskDefinitionFamily,
  KEEP_LATEST_COUNT,
  MANUAL_SELECTION_LIMIT,
} = await import("../../index.js");

beforeEach(() => {
  // These helpers print tables and banners around the prompt.
  jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  prompt.reset();
  jest.restoreAllMocks();
});

const NOW = Date.UTC(2026, 0, 1);
const DAY = 24 * 60 * 60 * 1000;

/** Builds a DESC-ordered revision list shaped like the analysis returns. */
function buildRevisions(count, { active = [], inUse = [] } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const revision = count - index;
    const isLatest = index === 0;
    const isInUse = inUse.includes(revision);

    return {
      arn: tdArn(revision),
      revision,
      status: active.includes(revision) ? "ACTIVE" : "INACTIVE",
      createdAt: new Date(NOW - index * 10 * DAY),
      size: 2048,
      isLatest,
      isInUse,
      isInLatest5: index < KEEP_LATEST_COUNT,
      isProtected: isLatest || isInUse,
    };
  });
}

describe("selectCluster", () => {
  /** ECS double serving clusters mapped to their running task count. */
  function clustersEcs(spec) {
    return makeEcs({
      listClusters: paged("clusterArns", Object.keys(spec).map(clusterArn)),
      listServices: paged("serviceArns", [serviceArn("api")]),
      listTasks: async ({ cluster }) => ({
        taskArns: Array.from({ length: spec[cluster] }, (_, i) =>
          taskArn(`t${i}`, cluster),
        ),
      }),
      listContainerInstances: paged("containerInstanceArns", []),
    });
  }

  test("returns the chosen cluster", async () => {
    prompt.answer("staging");

    expect(await selectCluster(clustersEcs({ prod: 2, staging: 1 }))).toBe(
      "staging",
    );
  });

  test("offers clusters with running tasks first", async () => {
    // Someone reaching for `exec` wants a cluster they can attach to; sinking
    // empty clusters to the bottom is the whole point of the sort.
    prompt.answer("busy");

    await selectCluster(clustersEcs({ empty: 0, busy: 5, quiet: 1 }));

    expect(prompt.lastAsked().choices.map((c) => c.value)).toEqual([
      "busy",
      "quiet",
      "empty",
    ]);
  });

  test("fails clearly when the account has no clusters", async () => {
    const ecs = makeEcs({ listClusters: paged("clusterArns", []) });

    await expect(selectCluster(ecs)).rejects.toThrow("No clusters available");
  });
});

describe("selectTask", () => {
  /** ECS double serving `count` running tasks in a cluster. */
  function tasksEcs(count) {
    const arns = Array.from({ length: count }, (_, i) => taskArn(`task${i}`));
    return makeEcs({
      listTasks: paged("taskArns", arns),
      describeTasks: async ({ tasks }) => ({
        tasks: tasks.map((arn) => {
          const index = arns.indexOf(arn);
          return {
            taskArn: arn,
            taskDefinitionArn: tdArn(1, `svc-${count - index}`),
            lastStatus: "RUNNING",
            startedAt: new Date(NOW),
          };
        }),
      }),
    });
  }

  test("returns the chosen task", async () => {
    const arn = taskArn("task1");
    prompt.answer(arn);

    expect(await selectTask(tasksEcs(3), "prod")).toBe(arn);
  });

  test("describes tasks in batches of at most a hundred", async () => {
    // DescribeTasks rejects more than 100 tasks per call.
    const ecs = tasksEcs(250);
    prompt.answer(taskArn("task0"));

    await selectTask(ecs, "prod");

    const batches = ecs.callsTo("describeTasks");
    expect(batches).toHaveLength(3);
    for (const call of batches) {
      expect(call.params.tasks.length).toBeLessThanOrEqual(100);
    }
  });

  test("sorts tasks by task definition name", async () => {
    prompt.answer(taskArn("task0"));

    await selectTask(tasksEcs(3), "prod");

    const names = prompt
      .lastAsked()
      .choices.map((c) => c.title.match(/svc-\d+/)[0]);
    expect(names).toEqual([...names].sort());
  });

  test("offers a way back when the cluster is empty", async () => {
    const ecs = makeEcs({ listTasks: paged("taskArns", []) });
    prompt.answer("__BACK__");

    expect(await selectTask(ecs, "prod", true)).toBe("__BACK__");
  });

  test("fails on an empty cluster when there is nowhere to go back to", async () => {
    const ecs = makeEcs({ listTasks: paged("taskArns", []) });

    await expect(selectTask(ecs, "prod", false)).rejects.toThrow(
      "No tasks available in cluster",
    );
  });

  test("prepends a back option to a populated list", async () => {
    prompt.answer("__BACK__");

    await selectTask(tasksEcs(3), "prod", true);

    expect(prompt.lastAsked().choices[0].value).toBe("__BACK__");
  });
});

describe("selectContainer", () => {
  /** ECS double for a task with the given container names. */
  function containersEcs(names) {
    return makeEcs({
      describeTasks: async () => ({
        tasks: [
          {
            taskArn: taskArn("task1"),
            lastStatus: "RUNNING",
            containers: names.map((name) => ({ name, lastStatus: "RUNNING" })),
          },
        ],
      }),
    });
  }

  test("auto-selects the only container", async () => {
    // Prompting with a single choice is pure friction for the common case.
    expect(
      await selectContainer(containersEcs(["api"]), "prod", taskArn("task1")),
    ).toBe("api");
  });

  test("prompts when the task has several containers", async () => {
    prompt.answer("otel");

    expect(
      await selectContainer(
        containersEcs(["api", "otel"]),
        "prod",
        taskArn("task1"),
      ),
    ).toBe("otel");
  });

  test("still prompts for a single container when going back is allowed", async () => {
    prompt.answer("__BACK__");

    expect(
      await selectContainer(
        containersEcs(["api"]),
        "prod",
        taskArn("task1"),
        true,
      ),
    ).toBe("__BACK__");
  });

  test("explains a task that reports no containers", async () => {
    // An empty choice list renders a prompt with nothing to pick.
    await expect(
      selectContainer(containersEcs([]), "prod", taskArn("task1")),
    ).rejects.toThrow(/reports no containers/);
  });
});

describe("selectTaskDefinitionFamily", () => {
  /** ECS double serving the given families, each with two revisions. */
  const familiesEcs = (families) =>
    makeEcs({
      listTaskDefinitionFamilies: paged("families", families),
      listTaskDefinitions: async ({ familyPrefix, status }) => ({
        taskDefinitionArns:
          status === "INACTIVE" ? [] : [tdArn(2, familyPrefix)],
      }),
    });

  test("returns the chosen family", async () => {
    prompt.answer("billing");

    expect(
      await selectTaskDefinitionFamily(familiesEcs(["app", "billing"])),
    ).toBe("billing");
  });

  test("fails clearly when there is nothing to prune", async () => {
    const ecs = makeEcs({ listTaskDefinitionFamilies: paged("families", []) });

    await expect(selectTaskDefinitionFamily(ecs)).rejects.toThrow(
      "No task definitions available",
    );
  });
});

describe("selectRevisionsToDelete", () => {
  test("the recommended option selects only INACTIVE revisions beyond the keep window", async () => {
    const revisions = buildRevisions(20, { active: [9, 8] });
    prompt.answer("inactive_beyond_keep");

    const selected = await selectRevisionsToDelete(revisions);

    expect(selected.every((r) => r.status === "INACTIVE")).toBe(true);
    expect(selected.every((r) => !r.isInLatest5 && !r.isProtected)).toBe(true);
    expect(selected.map((r) => r.revision)).not.toContain(9);
  });

  test("the beyond-10 option starts at position 10 of the list", async () => {
    prompt.answer("beyond_10");

    const selected = await selectRevisionsToDelete(buildRevisions(20));

    expect(selected.map((r) => r.revision)).toEqual([
      10, 9, 8, 7, 6, 5, 4, 3, 2, 1,
    ]);
  });

  test("an age option never reaches into the keep window", async () => {
    // Every revision here is over a year old, the latest 5 included.
    const revisions = buildRevisions(20).map((r) => ({
      ...r,
      createdAt: new Date(Date.now() - 400 * DAY),
    }));
    prompt.answer("age_365");

    const selected = await selectRevisionsToDelete(revisions);

    expect(selected).not.toHaveLength(0);
    expect(selected.every((r) => !r.isInLatest5 && !r.isProtected)).toBe(true);
  });

  test("a revision range excludes protected revisions and the keep window", async () => {
    const revisions = buildRevisions(20, { inUse: [8] });
    prompt.answer("range", 5, 18);

    const numbers = (await selectRevisionsToDelete(revisions)).map(
      (r) => r.revision,
    );

    expect(numbers).not.toContain(20); // latest
    expect(numbers).not.toContain(16); // inside the latest 5
    expect(numbers).not.toContain(8); // in use by a service
    expect(numbers).toContain(15);
    expect(numbers).toContain(5);
  });

  test("a reversed range is normalised rather than selecting nothing", async () => {
    prompt.answer("range", 12, 7);

    const selected = await selectRevisionsToDelete(buildRevisions(20));

    expect(selected.map((r) => r.revision)).toEqual([12, 11, 10, 9, 8, 7]);
  });

  test("a range covering only protected revisions selects nothing", async () => {
    prompt.answer("range", 19, 20);

    expect(await selectRevisionsToDelete(buildRevisions(20))).toEqual([]);
  });

  test("manual selection offers only deletable revisions, pre-checking INACTIVE ones", async () => {
    const revisions = buildRevisions(20, { active: [9, 8], inUse: [7] });
    prompt.answer("manual", []);

    await selectRevisionsToDelete(revisions);

    const { choices } = prompt.lastAsked();
    expect(choices.every((c) => !c.value.isProtected)).toBe(true);
    expect(choices.every((c) => !c.value.isInLatest5)).toBe(true);
    expect(choices.some((c) => c.value.revision === 7)).toBe(false);
    for (const choice of choices) {
      expect(choice.selected).toBe(choice.value.status === "INACTIVE");
    }
  });

  test("manual selection caps how many revisions it renders", async () => {
    // A checkbox list of thousands of entries is unusable; the bulk options
    // exist for that case.
    prompt.answer("manual", []);

    await selectRevisionsToDelete(buildRevisions(MANUAL_SELECTION_LIMIT + 50));

    expect(prompt.lastAsked().choices).toHaveLength(MANUAL_SELECTION_LIMIT);
  });

  test("disables every bulk option for a family smaller than the keep window", async () => {
    // An enabled option that silently selects zero revisions reads as a bug.
    prompt.answer("__none__");

    await selectRevisionsToDelete(buildRevisions(3));

    expect(prompt.asked()[0].choices.every((c) => c.disabled)).toBe(true);
  });

  test("an unknown method selects nothing", async () => {
    prompt.answer("__none__");

    expect(await selectRevisionsToDelete(buildRevisions(20))).toEqual([]);
  });

  test("a cancelled prompt selects nothing", async () => {
    prompt.answer(undefined);

    expect(await selectRevisionsToDelete(buildRevisions(20))).toEqual([]);
  });
});
