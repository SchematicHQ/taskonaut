import { afterEach, describe, expect, test } from "@jest/globals";
import {
  buildExecuteCommandArgs,
  getActiveProfile,
  getActiveRegion,
  getTaskDetails,
  listClusters,
  sleep,
  wasPromptCancelled,
  DEFAULT_EXEC_COMMAND,
} from "../../index.js";
import {
  clusterArn,
  makeEcs,
  paged,
  serviceArn,
  taskArn,
} from "../helpers/ecs-double.js";

describe("listClusters", () => {
  test("reports service, task and container instance counts per cluster", async () => {
    const ecs = makeEcs({
      listClusters: paged("clusterArns", [
        clusterArn("prod"),
        clusterArn("staging"),
      ]),
      listServices: paged("serviceArns", [serviceArn("api")]),
      listTasks: paged("taskArns", [taskArn("a"), taskArn("b")]),
      listContainerInstances: paged("containerInstanceArns", []),
    });

    const clusters = await listClusters(ecs, true);

    expect(clusters).toEqual([
      {
        clusterName: "prod",
        servicesCount: 1,
        tasksCount: 2,
        containerInstancesCount: 0,
      },
      {
        clusterName: "staging",
        servicesCount: 1,
        tasksCount: 2,
        containerInstancesCount: 0,
      },
    ]);
  });

  test("counts every service, not just the first page", async () => {
    // ListServices returns 10 items when maxResults is omitted, so an
    // unpaginated count caps at 10 for every cluster in the account.
    const services = Array.from({ length: 37 }, (_, i) =>
      serviceArn(`svc-${i}`),
    );
    const ecs = makeEcs({
      listClusters: paged("clusterArns", [clusterArn("prod")]),
      listServices: paged("serviceArns", services, 10),
      listTasks: paged("taskArns", []),
      listContainerInstances: paged("containerInstanceArns", []),
    });

    const [cluster] = await listClusters(ecs, true);

    expect(cluster.servicesCount).toBe(37);
  });

  test("returns an empty list when the account has no clusters", async () => {
    const ecs = makeEcs({ listClusters: paged("clusterArns", []) });

    expect(await listClusters(ecs, true)).toEqual([]);
  });

  test("a cluster the caller cannot read still appears with zero counts", async () => {
    // Losing the whole picker because one cluster denies ListTasks would make
    // the tool unusable in accounts with scoped permissions.
    const ecs = makeEcs({
      listClusters: paged("clusterArns", [clusterArn("restricted")]),
      listServices: async () => {
        throw new Error("AccessDeniedException");
      },
      listTasks: paged("taskArns", [taskArn("a")]),
      listContainerInstances: paged("containerInstanceArns", []),
    });

    const [cluster] = await listClusters(ecs, true);

    expect(cluster).toMatchObject({
      clusterName: "restricted",
      servicesCount: 0,
      tasksCount: 1,
    });
  });

  test("propagates a failure to list clusters at all", async () => {
    const ecs = makeEcs({
      listClusters: async () => {
        throw new Error("ExpiredTokenException");
      },
    });

    await expect(listClusters(ecs, true)).rejects.toThrow(
      "ExpiredTokenException",
    );
  });
});

describe("getTaskDetails", () => {
  test("returns the described task", async () => {
    const ecs = makeEcs({
      describeTasks: async () => ({ tasks: [{ taskArn: taskArn("a") }] }),
    });

    expect(await getTaskDetails(ecs, "prod", taskArn("a"))).toEqual({
      taskArn: taskArn("a"),
    });
  });

  test("fails loudly when the task has already stopped", async () => {
    const ecs = makeEcs({ describeTasks: async () => ({ tasks: [] }) });

    await expect(getTaskDetails(ecs, "prod", taskArn("a"))).rejects.toThrow(
      "Task not found",
    );
  });
});

describe("buildExecuteCommandArgs", () => {
  const args = buildExecuteCommandArgs({
    profile: "prod",
    region: "us-east-1",
    cluster: "prod-cluster",
    taskArn: taskArn("abc"),
    containerName: "api",
    command: "/bin/bash",
  });

  test("builds the documented aws ecs execute-command invocation", () => {
    expect(args).toEqual([
      "ecs",
      "execute-command",
      "--profile",
      "prod",
      "--region",
      "us-east-1",
      "--cluster",
      "prod-cluster",
      "--task",
      taskArn("abc"),
      "--container",
      "api",
      "--command",
      "/bin/bash",
      "--interactive",
    ]);
  });

  test("keeps every value in its own argv slot", () => {
    // Spawned without a shell, so a cluster or container name containing
    // shell syntax stays a single opaque argument.
    const hostile = buildExecuteCommandArgs({
      profile: "p",
      region: "r",
      cluster: "prod; rm -rf /",
      taskArn: "t",
      containerName: "api $(whoami)",
      command: DEFAULT_EXEC_COMMAND,
    });

    expect(hostile).toContain("prod; rm -rf /");
    expect(hostile).toContain("api $(whoami)");
    expect(hostile.filter((a) => a.includes("rm -rf"))).toHaveLength(1);
  });

  test("defaults to a POSIX shell", () => {
    expect(DEFAULT_EXEC_COMMAND).toBe("/bin/sh");
  });
});

describe("active profile and region resolution", () => {
  const saved = {
    AWS_PROFILE: process.env.AWS_PROFILE,
    AWS_REGION: process.env.AWS_REGION,
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("AWS_PROFILE overrides the stored profile", () => {
    process.env.AWS_PROFILE = "from-env";
    expect(getActiveProfile()).toBe("from-env");
  });

  test("the stored profile is used when the environment is unset", () => {
    delete process.env.AWS_PROFILE;
    expect(getActiveProfile()).not.toBe("from-env");
  });

  test("AWS_REGION wins over AWS_DEFAULT_REGION", () => {
    process.env.AWS_REGION = "eu-west-1";
    process.env.AWS_DEFAULT_REGION = "ap-south-1";
    expect(getActiveRegion()).toBe("eu-west-1");
  });

  test("AWS_DEFAULT_REGION is honoured on its own", () => {
    delete process.env.AWS_REGION;
    process.env.AWS_DEFAULT_REGION = "ap-south-1";
    expect(getActiveRegion()).toBe("ap-south-1");
  });
});

describe("wasPromptCancelled", () => {
  test("treats a missing answer as a cancellation", () => {
    expect(wasPromptCancelled(undefined, "value")).toBe(true);
    expect(wasPromptCancelled({}, "value")).toBe(true);
    expect(wasPromptCancelled({ value: null }, "value")).toBe(true);
  });

  test("accepts falsy answers that the user actually chose", () => {
    expect(wasPromptCancelled({ value: false }, "value")).toBe(false);
    expect(wasPromptCancelled({ value: 0 }, "value")).toBe(false);
    expect(wasPromptCancelled({ value: [] }, "value")).toBe(false);
  });
});

describe("sleep", () => {
  test("resolves after the requested delay", async () => {
    const start = Date.now();
    await sleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});
