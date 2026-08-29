import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeEcs, paged, serviceArn, tdArn } from "../helpers/ecs-double.js";
import { mockAwsSdk } from "../helpers/aws-mock.js";
import { mockConf } from "../helpers/conf-mock.js";
import { mockPrompts } from "../helpers/prompts-mock.js";
import { mockChildProcess } from "../helpers/child-process-mock.js";

const prompt = mockPrompts();
const conf = mockConf();
const aws = mockAwsSdk();
const child = mockChildProcess();

// Imported after the mocks are registered so the CLI resolves the stand-ins.
const { getActiveProfile, program } = await import("../../index.js");

const PROFILE = "taskonaut-test";
let awsDir;

beforeAll(() => {
  // initAWS validates the active profile against ~/.aws/config; both paths are
  // redirected so the suite never reads the developer's real AWS setup.
  awsDir = fs.mkdtempSync(path.join(os.tmpdir(), "taskonaut-cmd-"));
  fs.writeFileSync(
    path.join(awsDir, "config"),
    `[profile ${PROFILE}]\nregion = us-east-1\n`,
  );

  process.env.AWS_CONFIG_FILE = path.join(awsDir, "config");
  process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(awsDir, "credentials");
  process.env.AWS_PROFILE = PROFILE;
  process.env.AWS_REGION = "us-east-1";
});

afterAll(() => {
  fs.rmSync(awsDir, { recursive: true, force: true });
});

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  prompt.reset();
  conf.reset();
  child.reset();
  jest.restoreAllMocks();
});

/** Runs one CLI command to completion. */
const run = (...args) => program.parseAsync(["node", "taskonaut", ...args]);

// ---------------------------------------------------------------------------

/** Revision numbers an ECS double reports as ACTIVE for the `app` family. */
const ACTIVE = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

/**
 * ECS double for the prune flow: one family, one cluster, one service.
 *
 * @param {object} options - `services` overrides what the cluster is running.
 * @returns {object} Recording ECS double.
 */
function pruneEcs({ services = [], listServicesFails = false } = {}) {
  return makeEcs({
    listTaskDefinitionFamilies: paged("families", ["app"]),
    listTaskDefinitions: async ({ status }) => ({
      taskDefinitionArns:
        status === "INACTIVE" ? [] : ACTIVE.map((r) => tdArn(r)),
    }),
    describeTaskDefinition: async ({ taskDefinition }) => ({
      taskDefinition: {
        family: "app",
        revision: Number(taskDefinition.split(":").pop()),
        status: "ACTIVE",
        registeredAt: new Date("2026-01-01T00:00:00Z"),
        containerDefinitions: [{ name: "api", image: "repo/api:v1" }],
      },
    }),
    listClusters: paged("clusterArns", [
      "arn:aws:ecs:us-east-1:111122223333:cluster/prod",
    ]),
    listServices: async (params) => {
      if (listServicesFails) throw new Error("AccessDeniedException");
      return paged(
        "serviceArns",
        services.map((s) => s.serviceArn),
      )(params);
    },
    describeServices: async () => ({ services }),
    listTasks: paged("taskArns", []),
    describeTasks: async () => ({ tasks: [] }),
    listContainerInstances: paged("containerInstanceArns", []),
    deregisterTaskDefinition: async () => ({}),
    deleteTaskDefinitions: async () => ({}),
  });
}

describe("prune command", () => {
  test("deletes exactly the selected revisions and nothing protected", async () => {
    const ecs = aws.use(pruneEcs());
    // family, skip usage check, selection method, typed family name, final yes.
    prompt.answer("app", false, "beyond_10", "app", true);

    await run("prune");

    const deregistered = ecs
      .callsTo("deregisterTaskDefinition")
      .map((c) => Number(c.params.taskDefinition.split(":").pop()));

    // 12 is the latest and 12-8 are the keep window; beyond-10 starts at the
    // eleventh newest, so only revisions 2 and 1 are eligible.
    expect(deregistered.sort((a, b) => b - a)).toEqual([2, 1]);
    expect(deregistered).not.toContain(12);
  });

  test("a mistyped family name aborts before anything is touched", async () => {
    // The type-to-confirm gate is the last thing between a misread screen and
    // a permanent deletion.
    const ecs = aws.use(pruneEcs());
    prompt.answer("app", false, "beyond_10", "not-app", true);

    await run("prune");

    expect(ecs.callsTo("deregisterTaskDefinition")).toHaveLength(0);
    expect(ecs.callsTo("deleteTaskDefinitions")).toHaveLength(0);
  });

  test("declining the final confirmation aborts", async () => {
    const ecs = aws.use(pruneEcs());
    prompt.answer("app", false, "beyond_10", "app", false);

    await run("prune");

    expect(ecs.callsTo("deregisterTaskDefinition")).toHaveLength(0);
    expect(ecs.callsTo("deleteTaskDefinitions")).toHaveLength(0);
  });

  test("cancelling the selection aborts", async () => {
    const ecs = aws.use(pruneEcs());
    prompt.answer("app", false, undefined);

    await run("prune");

    expect(ecs.callsTo("deregisterTaskDefinition")).toHaveLength(0);
  });

  test("protects a revision in use by a service when the usage check runs", async () => {
    // Revision 2 is old enough for every bulk option, but it is live.
    const ecs = aws.use(
      pruneEcs({
        services: [
          {
            serviceArn: serviceArn("api"),
            serviceName: "api",
            taskDefinition: tdArn(2),
            status: "ACTIVE",
            desiredCount: 1,
            runningCount: 1,
          },
        ],
      }),
    );
    prompt.answer("app", true, "prod", "beyond_10", "app", true);

    await run("prune");

    const deregistered = ecs
      .callsTo("deregisterTaskDefinition")
      .map((c) => Number(c.params.taskDefinition.split(":").pop()));

    expect(deregistered).toEqual([1]);
    expect(deregistered).not.toContain(2);
  });

  test("refuses to continue when the usage check cannot be completed", async () => {
    // Failing open here would present live revisions as safe to delete.
    const ecs = aws.use(pruneEcs({ listServicesFails: true }));
    const exit = jest.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    prompt.answer("app", true, "prod");

    await expect(run("prune")).rejects.toThrow("process.exit");

    expect(exit).toHaveBeenCalledWith(1);
    expect(ecs.callsTo("deregisterTaskDefinition")).toHaveLength(0);
    expect(console.error.mock.calls.flat().join(" ")).toMatch(
      /Refusing to continue/,
    );
  });
});

// ---------------------------------------------------------------------------

/**
 * ECS double for the rollback flow: one cluster, one service on revision 12.
 *
 * @returns {object} Recording ECS double.
 */
function rollbackEcs() {
  const service = {
    serviceArn: serviceArn("api"),
    serviceName: "api",
    taskDefinition: tdArn(12),
    status: "ACTIVE",
    desiredCount: 2,
    runningCount: 2,
  };

  return makeEcs({
    listClusters: paged("clusterArns", [
      "arn:aws:ecs:us-east-1:111122223333:cluster/prod",
    ]),
    listServices: paged("serviceArns", [service.serviceArn]),
    describeServices: async () => ({ services: [service] }),
    listTasks: paged("taskArns", []),
    listContainerInstances: paged("containerInstanceArns", []),
    listTaskDefinitions: async ({ status }) => ({
      taskDefinitionArns:
        status === "INACTIVE" ? [] : [tdArn(12), tdArn(11), tdArn(10)],
    }),
    describeTaskDefinition: async ({ taskDefinition }) => ({
      taskDefinition: {
        family: "app",
        revision: Number(taskDefinition.split(":").pop()),
        status: "ACTIVE",
        registeredAt: new Date("2026-01-01T00:00:00Z"),
        cpu: "512",
        memory: "1024",
        containerDefinitions: [{ name: "api", image: "repo/api:v1" }],
      },
    }),
    updateService: async () => ({
      service: { deployments: [{ id: "ecs-svc/1", status: "PRIMARY" }] },
    }),
  });
}

describe("rollback command", () => {
  /** Picks the first choice a prompt offers. */
  const first = (question) => question.choices[0].value;

  test("does not offer the revision the service is already running", async () => {
    // Rolling back to the revision already deployed is a no-op deployment.
    aws.use(rollbackEcs());
    prompt.answer("prod", first, first, false);

    await run("rollback");

    const revisionPrompt = prompt
      .asked()
      .find((question) => question.name === "revision");
    expect(revisionPrompt.choices.map((c) => c.value.revision)).toEqual([
      11, 10,
    ]);
  });

  test("declining the confirmation makes no update", async () => {
    const ecs = aws.use(rollbackEcs());
    prompt.answer("prod", first, first, false);

    await run("rollback");

    expect(ecs.callsTo("updateService")).toHaveLength(0);
  });

  test("confirming updates the service to the chosen revision", async () => {
    const ecs = aws.use(rollbackEcs());
    prompt.answer("prod", first, first, true);

    await run("rollback");

    expect(ecs.callsTo("updateService")[0].params).toEqual({
      cluster: "prod",
      service: "api",
      taskDefinition: tdArn(11),
    });
  });

  test("stops when the cluster has no services", async () => {
    const ecs = makeEcs({
      listClusters: paged("clusterArns", [
        "arn:aws:ecs:us-east-1:111122223333:cluster/prod",
      ]),
      listServices: paged("serviceArns", []),
      listTasks: paged("taskArns", []),
      listContainerInstances: paged("containerInstanceArns", []),
      updateService: async () => ({}),
    });
    aws.use(ecs);
    prompt.answer("prod");

    await run("rollback");

    expect(ecs.callsTo("updateService")).toHaveLength(0);
  });

  test("cancelling cluster selection stops immediately", async () => {
    const ecs = aws.use(rollbackEcs());
    prompt.answer(undefined);

    await run("rollback");

    expect(ecs.callsTo("describeServices")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

/**
 * ECS double for the exec flow: two clusters, each with tasks and containers.
 *
 * @returns {object} Recording ECS double.
 */
function execEcs() {
  return makeEcs({
    listClusters: paged("clusterArns", [
      "arn:aws:ecs:us-east-1:111122223333:cluster/prod",
      "arn:aws:ecs:us-east-1:111122223333:cluster/staging",
    ]),
    listServices: paged("serviceArns", []),
    listContainerInstances: paged("containerInstanceArns", []),
    listTasks: async ({ cluster }) => ({
      taskArns: [`arn:aws:ecs:us-east-1:111122223333:task/${cluster}/t1`],
    }),
    describeTasks: async ({ tasks }) => ({
      tasks: [
        {
          taskArn: tasks[0],
          taskDefinitionArn: tdArn(1),
          lastStatus: "RUNNING",
          startedAt: new Date("2026-01-01T00:00:00Z"),
          containers: [
            { name: "api", lastStatus: "RUNNING" },
            { name: "otel", lastStatus: "RUNNING" },
          ],
        },
      ],
    }),
  });
}

describe("exec command", () => {
  /** Picks the first non-back choice a prompt offers. */
  const firstReal = (question) =>
    question.choices.find((c) => c.value !== "__BACK__").value;

  test("opens a session on the chosen container", async () => {
    aws.use(execEcs());
    prompt.answer("prod", firstReal, "otel");

    await run();

    expect(child.spawns()).toHaveLength(1);
    const [command, args] = child.spawns()[0];
    expect(command).toBe("aws");
    expect(args).toContain("execute-command");
    expect(args[args.indexOf("--cluster") + 1]).toBe("prod");
    expect(args[args.indexOf("--container") + 1]).toBe("otel");
  });

  test("honours --command", async () => {
    aws.use(execEcs());
    prompt.answer("prod", firstReal, "api");

    await run("--command", "/bin/bash");

    const [, args] = child.spawns()[0];
    expect(args[args.indexOf("--command") + 1]).toBe("/bin/bash");
  });

  test("going back from the container picker returns to task selection", async () => {
    aws.use(execEcs());
    prompt.answer("prod", firstReal, "__BACK__", firstReal, "api");

    await run();

    const asked = prompt.asked().map((q) => q.name);
    expect(asked).toEqual([
      "cluster",
      "taskArn",
      "containerName",
      "taskArn",
      "containerName",
    ]);
    expect(child.spawns()).toHaveLength(1);
  });

  test("going back from the task picker returns to cluster selection", async () => {
    aws.use(execEcs());
    prompt.answer("prod", "__BACK__", "staging", firstReal, "api");

    await run();

    const [, args] = child.spawns()[0];
    expect(args[args.indexOf("--cluster") + 1]).toBe("staging");
  });
});

// ---------------------------------------------------------------------------

describe("config set", () => {
  test("stores the chosen profile and region", async () => {
    prompt.answer(PROFILE, "eu-west-1");

    await run("config", "set");

    expect(conf.store.get("awsProfile")).toBe(PROFILE);
    expect(conf.store.get("awsRegion")).toBe("eu-west-1");
  });

  test("offers only profiles that exist on disk", async () => {
    prompt.answer(PROFILE, "us-east-1");

    await run("config", "set");

    const profilePrompt = prompt.asked().find((q) => q.name === "profile");
    expect(profilePrompt.choices.map((c) => c.value)).toEqual([PROFILE]);
  });

  test("the stored profile does not override AWS_PROFILE", async () => {
    // The command warns about this; the behaviour it warns about is what
    // matters, and it matches the AWS CLI and SDKs.
    prompt.answer("stored-profile", "us-east-1");

    await run("config", "set");

    expect(conf.store.get("awsProfile")).toBe("stored-profile");
    expect(getActiveProfile()).toBe(PROFILE);
  });
});

describe("config cleanup", () => {
  test("clears stored values when confirmed", async () => {
    conf.store.set("awsProfile", "staging");
    prompt.answer(true);

    await run("config", "cleanup");

    expect(conf.store.size).toBe(0);
  });

  test("keeps stored values when declined", async () => {
    conf.store.set("awsProfile", "staging");
    prompt.answer(false);

    await run("config", "cleanup");

    expect(conf.store.get("awsProfile")).toBe("staging");
  });
});

// ---------------------------------------------------------------------------

describe("doctor command", () => {
  const savedExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = savedExitCode;
  });

  test("passes when every prerequisite is present", async () => {
    await run("doctor");

    expect(process.exitCode).toBeUndefined();
  });

  test("fails when the AWS CLI is missing", async () => {
    // doctor is meant to gate setup scripts, so a failed check has to be
    // visible in the exit status, not only on screen.
    child.missing("aws");

    await run("doctor");

    expect(process.exitCode).toBe(1);
  });

  test("fails when the Session Manager plugin is missing", async () => {
    child.missing("session-manager-plugin");

    await run("doctor");

    expect(process.exitCode).toBe(1);
  });

  test("fails when the active profile is not configured", async () => {
    process.env.AWS_PROFILE = "not-a-real-profile";
    try {
      await run("doctor");
      expect(process.exitCode).toBe(1);
    } finally {
      process.env.AWS_PROFILE = PROFILE;
    }
  });
});

// ---------------------------------------------------------------------------

describe("prune command reporting", () => {
  test("stops when the family is smaller than the keep window", async () => {
    // Everything is inside the latest 5, so there is nothing to offer and no
    // selection prompt should appear.
    const ecs = makeEcs({
      listTaskDefinitionFamilies: paged("families", ["app"]),
      listTaskDefinitions: async ({ status }) => ({
        taskDefinitionArns:
          status === "INACTIVE" ? [] : [tdArn(3), tdArn(2), tdArn(1)],
      }),
      describeTaskDefinition: async ({ taskDefinition }) => ({
        taskDefinition: {
          family: "app",
          revision: Number(taskDefinition.split(":").pop()),
          status: "ACTIVE",
          registeredAt: new Date("2026-01-01T00:00:00Z"),
          containerDefinitions: [],
        },
      }),
      deregisterTaskDefinition: async () => ({}),
      deleteTaskDefinitions: async () => ({}),
    });
    aws.use(ecs);
    prompt.answer("app", false);

    await run("prune");

    expect(prompt.asked().map((q) => q.name)).toEqual(["family", "checkUsage"]);
    expect(ecs.callsTo("deregisterTaskDefinition")).toHaveLength(0);
  });

  test("reports revisions it could not read in the summary", async () => {
    const ecs = pruneEcs();
    ecs.describeTaskDefinition = async ({ taskDefinition }) => {
      if (taskDefinition === tdArn(6)) throw new Error("ClientException");
      return {
        taskDefinition: {
          family: "app",
          revision: Number(taskDefinition.split(":").pop()),
          status: "ACTIVE",
          registeredAt: new Date("2026-01-01T00:00:00Z"),
          containerDefinitions: [],
        },
      };
    };
    aws.use(ecs);
    prompt.answer("app", false, undefined);

    await run("prune");

    const printed = console.log.mock.calls.flat().join("\n");
    expect(printed).toMatch(/Not analysed: .*1.* of .*12/);
  });
});

describe("rollback command reporting", () => {
  test("stops when the family has no other revision to roll back to", async () => {
    const ecs = makeEcs({
      listClusters: paged("clusterArns", [
        "arn:aws:ecs:us-east-1:111122223333:cluster/prod",
      ]),
      listServices: paged("serviceArns", [serviceArn("api")]),
      describeServices: async () => ({
        services: [
          {
            serviceArn: serviceArn("api"),
            serviceName: "api",
            taskDefinition: tdArn(12),
            status: "ACTIVE",
            desiredCount: 1,
            runningCount: 1,
          },
        ],
      }),
      listTasks: paged("taskArns", []),
      listContainerInstances: paged("containerInstanceArns", []),
      listTaskDefinitions: async ({ status }) => ({
        taskDefinitionArns: status === "INACTIVE" ? [] : [tdArn(12)],
      }),
      describeTaskDefinition: async ({ taskDefinition }) => ({
        taskDefinition: {
          family: "app",
          revision: Number(taskDefinition.split(":").pop()),
          status: "ACTIVE",
          registeredAt: new Date("2026-01-01T00:00:00Z"),
          containerDefinitions: [],
        },
      }),
      updateService: async () => ({}),
    });
    aws.use(ecs);
    prompt.answer("prod", (q) => q.choices[0].value);

    await run("rollback");

    expect(ecs.callsTo("updateService")).toHaveLength(0);
    expect(console.log.mock.calls.flat().join(" ")).toMatch(
      /No other revisions available/,
    );
  });

  test("shows the image change the rollback would make", async () => {
    const ecs = rollbackEcs();
    ecs.describeTaskDefinition = async ({ taskDefinition }) => {
      const revision = Number(taskDefinition.split(":").pop());
      return {
        taskDefinition: {
          family: "app",
          revision,
          status: "ACTIVE",
          registeredAt: new Date("2026-01-01T00:00:00Z"),
          cpu: revision === 12 ? "1024" : "512",
          memory: "1024",
          containerDefinitions: [
            { name: "api", image: `repo/api:v${revision}` },
          ],
        },
      };
    };
    aws.use(ecs);
    prompt.answer(
      "prod",
      (q) => q.choices[0].value,
      (q) => q.choices[0].value,
      false,
    );

    await run("rollback");

    const printed = console.log.mock.calls.flat().join("\n");
    expect(printed).toMatch(/Changes detected/);
    expect(printed).toMatch(/repo\/api:v12/);
    expect(printed).toMatch(/repo\/api:v11/);
    expect(printed).toMatch(/CPU/);
  });
});
