#!/usr/bin/env node

import { ECS } from "@aws-sdk/client-ecs";
import { fromIni } from "@aws-sdk/credential-providers";
import { Command } from "commander";
import prompts from "prompts";
import pino from "pino";
import dotenv from "dotenv";
import chalk from "chalk";
import figlet from "figlet";
import ora from "ora";
import Conf from "conf";
import { pastel } from "gradient-string";
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import ini from "ini";

// Resolved lazily so importing this module (e.g. from tests) has no side effects.
const packageJson = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "package.json"), "utf-8"),
);

// Load environment variables
dotenv.config({
  quiet: true,
});

// ---------------------------------------------------------------------------
// Configuration Management using Conf
// ---------------------------------------------------------------------------
const config = new Conf({
  projectName: "taskonaut",
  schema: {
    awsProfile: {
      type: "string",
      default: "default",
    },
    awsRegion: {
      type: "string",
      default: "us-east-1",
    },
    lastUsedCluster: {
      type: "string",
      default: "",
    },
    awsProfiles: {
      type: "array",
      default: [],
    },
    lastProfileSync: {
      type: "number",
      default: 0,
    },
  },
});

const SYNC_INTERVAL = 1000 * 60 * 60; // 1 hour

const AWS_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "af-south-1",
  "ap-east-1",
  "ap-south-1",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-south-2",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-southeast-4",
  "ap-southeast-5",
  "ca-central-1",
  "ca-west-1",
  "cn-north-1",
  "cn-northwest-1",
  "eu-central-1",
  "eu-central-2",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-south-1",
  "eu-south-2",
  "eu-north-1",
  "sa-east-1",
  "me-south-1",
  "me-central-1",
  "us-gov-east-1",
  "us-gov-west-1",
];

export { AWS_REGIONS };

// ---------------------------------------------------------------------------
// Banner & Logger Setup
// ---------------------------------------------------------------------------

/**
 * Prints the ASCII banner. Skipped when stdout is not a TTY so that piping
 * command output (e.g. `taskonaut config show | jq`) stays machine-readable.
 */
function printBanner() {
  if (!process.stdout.isTTY) return;
  console.log(
    pastel.multiline(
      figlet.textSync("taskonaut", {
        font: "ANSI Shadow",
        horizontalLayout: "full",
      }),
    ),
  );
}

const logger = pino({
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      levelFirst: true,
      translateTime: "HH:MM:ss",
      ignore: "pid,hostname",
    },
  },
});

// ---------------------------------------------------------------------------
// AWS Profiles Management
// ---------------------------------------------------------------------------

/**
 * Resolves the AWS shared credentials file path, honouring
 * AWS_SHARED_CREDENTIALS_FILE.
 * @returns {string} Path to the credentials file.
 */
function getCredentialsPath() {
  return (
    process.env.AWS_SHARED_CREDENTIALS_FILE ||
    path.join(os.homedir(), ".aws", "credentials")
  );
}

/**
 * Resolves the AWS config file path, honouring AWS_CONFIG_FILE.
 * @returns {string} Path to the config file.
 */
function getConfigPath() {
  return (
    process.env.AWS_CONFIG_FILE || path.join(os.homedir(), ".aws", "config")
  );
}

// Section prefixes in ~/.aws/config that are not profiles. AWS uses these for
// SSO sessions and service-specific settings; they must not be offered as
// selectable profiles.
const NON_PROFILE_SECTION_PREFIXES = ["sso-session", "services", "plugins"];

/**
 * Extracts profile names from a parsed ~/.aws/config object.
 *
 * Sections are `[profile name]` (or bare `[default]`); `[sso-session x]` and
 * `[services x]` are not profiles. Top-level keys (settings written outside any
 * section) are skipped as well.
 *
 * @param {object} parsed - Result of `ini.parse` on a config file.
 * @returns {string[]} Profile names.
 */
function extractProfileNamesFromConfig(parsed) {
  const names = [];

  for (const [section, value] of Object.entries(parsed)) {
    // Bare `key = value` pairs outside a section are not profiles.
    if (typeof value !== "object" || value === null) continue;

    const prefix = section.split(/\s+/)[0];
    if (NON_PROFILE_SECTION_PREFIXES.includes(prefix)) continue;

    // Anchored so a profile literally named "a profile b" is left intact.
    names.push(section.replace(/^profile\s+/, ""));
  }

  return names;
}

/**
 * Parses AWS profiles from credentials and config files.
 * @returns {string[]} Array of AWS profile names.
 */
function parseAwsProfiles() {
  const profiles = new Set();

  const credentialsPath = getCredentialsPath();
  if (fs.existsSync(credentialsPath)) {
    try {
      const content = fs.readFileSync(credentialsPath, "utf-8");
      const parsed = ini.parse(content);
      for (const [section, value] of Object.entries(parsed)) {
        // The credentials file has no `profile ` prefix, but it can still hold
        // stray top-level keys.
        if (typeof value !== "object" || value === null) continue;
        profiles.add(section);
      }
    } catch (err) {
      logger.error(chalk.red(`Error parsing credentials file: ${err.message}`));
    }
  }

  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, "utf-8");
      const parsed = ini.parse(content);
      extractProfileNamesFromConfig(parsed).forEach((name) =>
        profiles.add(name),
      );
    } catch (err) {
      logger.error(chalk.red(`Error parsing config file: ${err.message}`));
    }
  }

  return Array.from(profiles);
}

/**
 * Synchronizes AWS profiles and updates the configuration.
 * @returns {Promise<string[]>} Array of AWS profile names.
 */
async function syncAwsProfiles() {
  const spinner = ora({
    text: "Syncing AWS profiles...",
    spinner: "dots",
  }).start();
  try {
    const profilesList = parseAwsProfiles();
    config.set("awsProfiles", profilesList);
    config.set("lastProfileSync", Date.now());
    spinner.succeed(`Found ${profilesList.length} AWS profiles`);
    return profilesList;
  } catch (err) {
    spinner.fail("Failed to sync AWS profiles");
    logger.error(err, chalk.red("Error syncing profiles"));
    throw err;
  }
}

/**
 * Retrieves AWS profiles from configuration or syncs if necessary.
 * @returns {Promise<string[]>} Array of AWS profile names.
 */
async function getAwsProfiles() {
  const lastSync = config.get("lastProfileSync");
  const cached = config.get("awsProfiles");

  // Re-sync when the cache is stale or empty; an empty cache otherwise wedges
  // the tool for a full sync interval with "Invalid AWS profile".
  if (Date.now() - lastSync > SYNC_INTERVAL || cached.length === 0) {
    return await syncAwsProfiles();
  }
  return cached;
}

/**
 * Resolves the AWS profile to use. AWS_PROFILE takes precedence over the
 * stored configuration, matching the behaviour of the AWS CLI and SDKs.
 * @returns {string} Profile name.
 */
function getActiveProfile() {
  return process.env.AWS_PROFILE || config.get("awsProfile");
}

/**
 * Resolves the AWS region to use. AWS_REGION / AWS_DEFAULT_REGION take
 * precedence over the stored configuration.
 * @returns {string} Region name.
 */
function getActiveRegion() {
  return (
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    config.get("awsRegion")
  );
}

// ---------------------------------------------------------------------------
// AWS ECS Client Initialization
// ---------------------------------------------------------------------------

/**
 * Initializes the AWS ECS client with the selected profile and region.
 * @returns {Promise<ECS>} An instance of the AWS ECS client.
 */
const initAWS = async () => {
  const profiles = await getAwsProfiles();
  const currentProfile = getActiveProfile();
  if (!profiles.includes(currentProfile)) {
    logger.warn(
      chalk.yellow(`Profile ${currentProfile} not found, please reconfigure`),
    );
    throw new Error("Invalid AWS profile");
  }
  const region = getActiveRegion();
  logger.info(
    chalk.dim(`Using AWS Profile: ${currentProfile} and Region: ${region}`),
  );

  // Pass the provider itself rather than pre-resolved credentials so the SDK
  // can refresh them. Long-running operations (prune walks thousands of
  // revisions with backoff) can outlive a short-lived SSO session.
  return new ECS({ region, credentials: fromIni({ profile: currentProfile }) });
};

// ---------------------------------------------------------------------------
// Pagination Helpers
// ---------------------------------------------------------------------------

/**
 * Collects every page of a paginated ECS list operation.
 *
 * ECS list APIs cap a single page well below the number of resources a real
 * account holds -- notably ListServices returns only 10 items when maxResults
 * is omitted -- so every listing must be paginated to be correct.
 *
 * @param {Function} operation - Called with `{ ...params, nextToken }`.
 * @param {object} params - Base request parameters.
 * @param {string} key - Response property holding the page of results.
 * @returns {Promise<Array>} All results across every page.
 */
async function paginate(operation, params, key) {
  const results = [];
  let nextToken;

  do {
    const response = await operation({
      ...params,
      maxResults: 100, // AWS maximum for all ECS list operations.
      nextToken,
    });
    if (response[key]) results.push(...response[key]);
    nextToken = response.nextToken;
  } while (nextToken);

  return results;
}

/**
 * Splits an array into fixed-size chunks.
 * @param {Array} items - Items to chunk.
 * @param {number} size - Maximum chunk size.
 * @returns {Array<Array>} Chunks.
 */
function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Maps over items with a bounded number of in-flight operations.
 *
 * Unbounded Promise.all over every task definition family is a reliable way to
 * get throttled by the ECS API.
 *
 * @param {Array} items - Items to map.
 * @param {number} limit - Maximum concurrent operations.
 * @param {Function} fn - Async mapper, called with (item, index).
 * @returns {Promise<Array>} Results in input order.
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await fn(items[index], index);
      }
    },
  );

  await Promise.all(workers);
  return results;
}

/**
 * Extracts the revision number from a task definition ARN.
 * @param {string} arn - Task definition ARN (…:task-definition/family:revision).
 * @returns {number} Revision number, or NaN when unparseable.
 */
function parseRevisionFromArn(arn) {
  return parseInt(arn.split(":").pop(), 10);
}

/**
 * Extracts the family name from a task definition ARN.
 * @param {string} arn - Task definition ARN.
 * @returns {string} Family name.
 */
function parseFamilyFromArn(arn) {
  return arn.split("/").pop().split(":")[0];
}

/**
 * Extracts the human-readable tag from a container image reference.
 *
 * Handles registries that carry a port (`registry:5000/app`), where a naive
 * split on ":" reports the port as the tag, and digest pins (`app@sha256:…`).
 *
 * @param {string} image - Image reference.
 * @returns {string} Tag, short digest, or "latest".
 */
function parseImageTag(image) {
  if (!image) return "latest";

  const [reference, digest] = image.split("@");
  const lastSlash = reference.lastIndexOf("/");
  const lastColon = reference.lastIndexOf(":");

  if (lastColon > lastSlash) return reference.slice(lastColon + 1);
  if (digest) return digest.slice(0, 19);
  return "latest";
}

// AWS caps DescribeServices at 10 services per call.
const DESCRIBE_SERVICES_BATCH_SIZE = 10;
// AWS caps DescribeTasks at 100 tasks per call.
const DESCRIBE_TASKS_BATCH_SIZE = 100;
// Families detailed in parallel when building the prune picker.
const FAMILY_DETAIL_CONCURRENCY = 5;
// Newest revisions offered as rollback targets.
const ROLLBACK_REVISION_LIMIT = 100;
// Number of newest revisions the prune command promises to keep.
const KEEP_LATEST_COUNT = 5;
// Maximum revisions rendered in the manual checkbox list.
const MANUAL_SELECTION_LIMIT = 100;
// Shell used for `ecs execute-command` when --command is not supplied.
const DEFAULT_EXEC_COMMAND = "/bin/sh";

/**
 * Shared `prompts` onCancel handler: report and exit without a stack trace.
 */
function cancelOperation() {
  cancelOperation();
}

// ---------------------------------------------------------------------------
// AWS ECS Cluster, Task, and Container Management
// ---------------------------------------------------------------------------

/**
 * Lists ECS clusters along with their service, task, and container instance counts.
 * @param {ECS} ecs - AWS ECS client.
 * @param {boolean} quiet - Whether to suppress spinner output.
 * @returns {Promise<Array<{clusterName: string, servicesCount: number, tasksCount: number, containerInstancesCount: number}>>} Clusters with details.
 */
async function listClusters(ecs, quiet = false) {
  const spinner = quiet ? null : ora("Fetching clusters...").start();
  try {
    const clusterArns = await paginate(
      (p) => ecs.listClusters(p),
      {},
      "clusterArns",
    );
    if (spinner) spinner.succeed("Clusters fetched");

    if (clusterArns.length === 0) {
      logger.warn(chalk.yellow("No clusters found."));
      return [];
    }

    const clusters = await Promise.all(
      clusterArns.map(async (arn) => {
        const clusterName = arn.split("/").pop();
        let servicesCount = 0;
        let tasksCount = 0;
        let containerInstancesCount = 0;

        try {
          const serviceArns = await paginate(
            (p) => ecs.listServices(p),
            { cluster: clusterName },
            "serviceArns",
          );
          servicesCount = serviceArns.length;
        } catch (err) {
          logger.error(
            chalk.red(
              `Error fetching services for cluster ${clusterName}: ${err.message}`,
            ),
          );
        }

        try {
          const taskArns = await paginate(
            (p) => ecs.listTasks(p),
            { cluster: clusterName },
            "taskArns",
          );
          tasksCount = taskArns.length;
        } catch (err) {
          logger.error(
            chalk.red(
              `Error fetching tasks for cluster ${clusterName}: ${err.message}`,
            ),
          );
        }

        try {
          const containerInstanceArns = await paginate(
            (p) => ecs.listContainerInstances(p),
            { cluster: clusterName },
            "containerInstanceArns",
          );
          containerInstancesCount = containerInstanceArns.length;
        } catch (err) {
          logger.error(
            chalk.red(
              `Error fetching container instances for cluster ${clusterName}: ${err.message}`,
            ),
          );
        }

        return {
          clusterName,
          servicesCount,
          tasksCount,
          containerInstancesCount,
        };
      }),
    );

    return clusters;
  } catch (err) {
    if (spinner?.isSpinning) spinner.fail("Failed to fetch clusters");
    throw err;
  }
}

/**
 * Prompts user to select an ECS cluster.
 * @param {ECS} ecs - AWS ECS client.
 * @returns {Promise<string>} Selected cluster name.
 */
async function selectCluster(ecs) {
  const clusters = await listClusters(ecs);
  if (!clusters || clusters.length === 0) {
    logger.warn(chalk.yellow("No clusters found."));
    throw new Error("No clusters available");
  }

  // Sort clusters: ones with tasks first, then by task count descending
  const sortedClusters = clusters.sort((a, b) => {
    if (a.tasksCount > 0 && b.tasksCount === 0) return -1;
    if (a.tasksCount === 0 && b.tasksCount > 0) return 1;
    return b.tasksCount - a.tasksCount;
  });

  const clusterChoices = sortedClusters.map((c) => {
    const hasActiveTasks = c.tasksCount > 0;
    const taskInfo = hasActiveTasks
      ? chalk.green(`${c.tasksCount} tasks`)
      : chalk.gray(`${c.tasksCount} tasks`);

    const status = hasActiveTasks
      ? chalk.green("● Active")
      : chalk.gray("○ Empty");

    return {
      title: `${chalk.bold(c.clusterName)} ${status}`,
      description: `Services: ${c.servicesCount}, Tasks: ${taskInfo}, Instances: ${c.containerInstancesCount}`,
      value: c.clusterName,
    };
  });

  const clusterResponse = await prompts({
    type: "autocomplete",
    name: "cluster",
    message: chalk.blue("Select ECS cluster:"),
    choices: clusterChoices,
    hint: "- Type to search, use arrows to navigate",
    suggest: (input, choices) => {
      const inputLower = input.toLowerCase();
      return choices.filter(
        (choice) =>
          choice.title.toLowerCase().includes(inputLower) ||
          (choice.description &&
            choice.description.toLowerCase().includes(inputLower)),
      );
    },
  });

  if (!clusterResponse.cluster) {
    cancelOperation();
  }

  return clusterResponse.cluster;
}

/**
 * Prompts user to select a task within a cluster, optionally allowing going back.
 * @param {ECS} ecs - AWS ECS client.
 * @param {string} cluster - Cluster name.
 * @param {boolean} allowBack - Whether to allow going back.
 * @returns {Promise<string>} Selected task ARN or '__BACK__'.
 */
async function selectTask(ecs, cluster, allowBack = false) {
  const spinner = ora("Fetching tasks...").start();
  try {
    const taskArns = await paginate(
      (p) => ecs.listTasks(p),
      { cluster },
      "taskArns",
    );

    if (taskArns.length === 0) {
      spinner.warn("No tasks found in cluster");

      if (allowBack) {
        logger.info(
          chalk.blue("💡 This cluster has no running tasks. You can:"),
        );
        logger.info(chalk.dim("   • Go back and select a different cluster"));
        logger.info(
          chalk.dim("   • Check if tasks are running in the AWS Console"),
        );
        logger.info(
          chalk.dim(
            "   • Verify you have the correct AWS profile/region selected",
          ),
        );

        const actionResponse = await prompts({
          type: "select",
          name: "action",
          message: chalk.blue("What would you like to do?"),
          choices: [
            {
              title: chalk.blue("← Go Back to Cluster Selection"),
              value: "__BACK__",
            },
            {
              title: chalk.red("Exit taskonaut"),
              value: "__EXIT__",
            },
          ],
        });

        if (!actionResponse.action) {
          cancelOperation();
        }

        if (actionResponse.action === "__EXIT__") {
          logger.info(chalk.dim("Goodbye! 👋"));
          process.exit(0);
        }

        return actionResponse.action; // Return "__BACK__"
      } else {
        logger.warn(chalk.yellow("No tasks found in cluster."));
        throw new Error("No tasks available in cluster");
      }
    }

    const taskBatches = await Promise.all(
      chunk(taskArns, DESCRIBE_TASKS_BATCH_SIZE).map(async (batch) => {
        const { tasks } = await ecs.describeTasks({ cluster, tasks: batch });
        return tasks || [];
      }),
    );
    const tasks = taskBatches.flat();

    spinner.succeed("Tasks fetched");

    // Sort tasks alphabetically by task definition name.
    tasks.sort((a, b) => {
      const aName = (a.taskDefinitionArn.split("/").pop() || "").toLowerCase();
      const bName = (b.taskDefinitionArn.split("/").pop() || "").toLowerCase();
      return aName.localeCompare(bName);
    });

    const choices = tasks.map((task) => {
      const taskDefName = task.taskDefinitionArn.split("/").pop();
      const taskId = task.taskArn.split("/").pop();
      const shortTaskId = taskId.slice(-6);
      const startedAt = task.startedAt
        ? new Date(task.startedAt).toLocaleString()
        : "N/A";
      return {
        title: `${chalk.green(taskDefName)} ${chalk.yellow(
          `(ID: ${shortTaskId}, ${task.lastStatus}, started at: ${startedAt})`,
        )}`,
        value: task.taskArn,
      };
    });

    if (allowBack) {
      choices.unshift({
        title: chalk.blue("← Go Back"),
        value: "__BACK__",
      });
    }

    const taskResponse = await prompts({
      type: "autocomplete",
      name: "taskArn",
      message: chalk.blue("📦 Select task:"),
      choices,
      hint: "- Type to search, use arrows to navigate",
      suggest: (input, choices) => {
        const inputLower = input.toLowerCase();
        return choices.filter((choice) =>
          choice.title.toLowerCase().includes(inputLower),
        );
      },
    });

    if (!taskResponse.taskArn) {
      cancelOperation();
    }

    return taskResponse.taskArn;
  } catch (err) {
    if (spinner.isSpinning) spinner.fail("Failed to fetch tasks");
    throw err;
  }
}

/**
 * Retrieves task details.
 * @param {ECS} ecs - AWS ECS client.
 * @param {string} cluster - Cluster name.
 * @param {string} taskArn - Task ARN.
 * @returns {Promise<object>} Task details.
 */
async function getTaskDetails(ecs, cluster, taskArn) {
  const { tasks } = await ecs.describeTasks({
    cluster,
    tasks: [taskArn],
  });

  if (!tasks || tasks.length === 0) {
    throw new Error("Task not found");
  }

  return tasks[0];
}

/**
 * Prompts user to select a container within a task, optionally allowing to go back.
 * @param {ECS} ecs - AWS ECS client.
 * @param {string} cluster - Cluster name.
 * @param {string} taskArn - Task ARN.
 * @param {boolean} allowBack - Whether to allow going back.
 * @returns {Promise<string>} Selected container name or '__BACK__'.
 */
async function selectContainer(ecs, cluster, taskArn, allowBack = false) {
  const spinner = ora("Fetching container details...").start();
  let task;
  try {
    task = await getTaskDetails(ecs, cluster, taskArn);
  } catch (err) {
    if (spinner.isSpinning) spinner.fail("Failed to fetch container details");
    throw err;
  }
  const containers = task.containers || [];
  spinner.succeed("Container details fetched");

  if (containers.length === 0) {
    // Nothing to prompt for; an empty choice list renders an unusable prompt.
    throw new Error(
      `Task ${taskArn.split("/").pop()} reports no containers (lastStatus: ${task.lastStatus}).`,
    );
  }

  let choices;

  if (containers.length === 1 && !allowBack) {
    logger.info(chalk.dim("Single container detected, auto-selecting..."));
    return containers[0].name;
  } else {
    choices = containers.map((container) => ({
      title: `${chalk.green(container.name)} ${chalk.yellow(
        `(${container.lastStatus})`,
      )}`,
      value: container.name,
    }));

    if (allowBack) {
      choices.unshift({
        title: chalk.blue("← Go Back"),
        value: "__BACK__",
      });
    }
  }

  const containerResponse = await prompts({
    type: "autocomplete",
    name: "containerName",
    message: chalk.blue("🐳 Select container:"),
    choices,
    hint: "- Type to search, use arrows to navigate",
    suggest: (input, choices) => {
      const inputLower = input.toLowerCase();
      return choices.filter((choice) =>
        choice.title.toLowerCase().includes(inputLower),
      );
    },
  });

  if (!containerResponse.containerName) {
    cancelOperation();
  }

  return containerResponse.containerName;
}

/**
 * Executes a command on the selected container.
 * @param {string} cluster - Cluster name.
 * @param {string} taskArn - Task ARN.
 * @param {string} containerName - Container name.
 * @returns {Promise<number>} Exit code.
 */
async function executeCommand(
  cluster,
  taskArn,
  containerName,
  command = DEFAULT_EXEC_COMMAND,
) {
  return new Promise((resolve, reject) => {
    logger.info(chalk.dim(`Starting session (${command})...`));

    // Arguments are passed as an argv array with no shell, so cluster, task and
    // container names cannot be interpreted as shell syntax.
    const childProcess = spawn(
      "aws",
      [
        "ecs",
        "execute-command",
        "--profile",
        getActiveProfile(),
        "--region",
        getActiveRegion(),
        "--cluster",
        cluster,
        "--task",
        taskArn,
        "--container",
        containerName,
        "--command",
        command,
        "--interactive",
      ],
      {
        stdio: "inherit",
      },
    );

    const signals = ["SIGINT", "SIGTERM", "SIGQUIT"];
    const signalHandlers = {};
    let settled = false;

    const removeSignalHandlers = () => {
      signals.forEach((signal) => {
        process.removeListener(signal, signalHandlers[signal]);
      });
    };

    const cleanup = () => {
      logger.info(chalk.yellow("📤 Cleaning up ECS session..."));
      childProcess.kill("SIGTERM");
      removeSignalHandlers();
    };

    signals.forEach((signal) => {
      signalHandlers[signal] = () => cleanup();
      process.on(signal, signalHandlers[signal]);
    });

    childProcess.on("error", (err) => {
      if (settled) return;
      settled = true;
      removeSignalHandlers();

      // ENOENT here means the AWS CLI itself is missing, which is worth saying
      // plainly rather than surfacing a bare spawn error.
      if (err.code === "ENOENT") {
        reject(
          new Error(
            "Could not run the AWS CLI. Install it and run `taskonaut doctor` to verify your setup.",
            { cause: err },
          ),
        );
        return;
      }
      reject(err);
    });

    childProcess.on("exit", (code) => {
      if (settled) return;
      settled = true;
      removeSignalHandlers();
      logger.info(
        chalk.green(`✨ Session ended with exit code ${chalk.bold(code)}`),
      );
      resolve(code);
    });
  });
}

// ---------------------------------------------------------------------------
// ECS Rollback Functions
// ---------------------------------------------------------------------------

/**
 * Lists ECS services within a cluster with their current task definition info.
 * @param {ECS} ecs - AWS ECS client.
 * @param {string} cluster - Cluster name.
 * @param {boolean} quiet - Whether to suppress spinner output.
 * @returns {Promise<Array<{serviceName: string, serviceArn: string, taskDefinition: string, taskDefinitionFamily: string, revision: number, status: string, desiredCount: number, runningCount: number}>>} Services with details.
 */
async function listServices(ecs, cluster, quiet = false) {
  const spinner = quiet ? null : ora("Fetching services...").start();
  try {
    // ListServices returns only 10 items when maxResults is omitted, so this
    // must paginate: a truncated list silently under-reports which task
    // definition revisions are in use.
    const serviceArns = await paginate(
      (p) => ecs.listServices(p),
      { cluster },
      "serviceArns",
    );
    if (spinner) spinner.text = "Fetching service details...";

    if (serviceArns.length === 0) {
      if (spinner) spinner.warn("No services found");
      return [];
    }

    // DescribeServices accepts at most 10 services per call.
    const serviceBatches = await Promise.all(
      chunk(serviceArns, DESCRIBE_SERVICES_BATCH_SIZE).map(async (batch) => {
        const { services } = await ecs.describeServices({
          cluster,
          services: batch,
        });
        return services || [];
      }),
    );
    const services = serviceBatches.flat();

    if (spinner) spinner.succeed(`Services fetched (${services.length})`);

    return services.map((service) => {
      return {
        serviceName: service.serviceName,
        serviceArn: service.serviceArn,
        taskDefinition: service.taskDefinition,
        taskDefinitionFamily: parseFamilyFromArn(service.taskDefinition),
        revision: parseRevisionFromArn(service.taskDefinition),
        status: service.status,
        desiredCount: service.desiredCount,
        runningCount: service.runningCount,
      };
    });
  } catch (err) {
    if (spinner?.isSpinning) spinner.fail("Failed to fetch services");
    throw err;
  }
}

/**
 * Lists task definition revisions for a specific family.
 * @param {ECS} ecs - AWS ECS client.
 * @param {string} family - Task definition family name.
 * @param {boolean} quiet - Whether to suppress spinner output.
 * @returns {Promise<Array<{taskDefinition: string, revision: number, status: string, createdAt: Date}>>} Task definition revisions.
 */
async function listTaskDefinitionRevisions(ecs, family, quiet = false) {
  const spinner = quiet
    ? null
    : ora("Fetching task definition revisions...").start();
  try {
    // Paginated: a family that has been deployed more than 100 times would
    // otherwise hide its older revisions from the rollback picker.
    const taskDefinitionArns = await fetchAllTaskDefinitions(
      ecs,
      { familyPrefix: family, status: "ACTIVE", sort: "DESC" },
      spinner,
    );

    if (taskDefinitionArns.length === 0) {
      if (spinner) spinner.warn("No task definitions found");
      return [];
    }

    // Only the most recent revisions are realistic rollback targets, and
    // registeredAt is the sole field describeTaskDefinition adds here, so
    // describe just the page the user will actually see.
    const describable = taskDefinitionArns.slice(0, ROLLBACK_REVISION_LIMIT);

    const revisions = await Promise.all(
      describable.map(async (arn) => {
        try {
          const { taskDefinition } = await ecs.describeTaskDefinition({
            taskDefinition: arn,
          });
          return {
            taskDefinition: arn,
            revision: taskDefinition.revision,
            status: taskDefinition.status,
            createdAt: taskDefinition.registeredAt,
          };
        } catch (err) {
          logger.warn(
            chalk.yellow(
              `Failed to describe task definition ${arn}: ${err.message}`,
            ),
          );
          return null;
        }
      }),
    );

    if (spinner) {
      spinner.succeed(
        taskDefinitionArns.length > describable.length
          ? `Task definition revisions fetched (showing newest ${describable.length} of ${taskDefinitionArns.length})`
          : "Task definition revisions fetched",
      );
    }

    if (taskDefinitionArns.length > describable.length) {
      logger.info(
        chalk.dim(
          `Showing the newest ${describable.length} of ${taskDefinitionArns.length} ACTIVE revisions.`,
        ),
      );
    }

    return revisions.filter(Boolean).sort((a, b) => b.revision - a.revision);
  } catch (err) {
    if (spinner?.isSpinning)
      spinner.fail("Failed to fetch task definition revisions");
    throw err;
  }
}

/**
 * Gets detailed comparison between two task definition revisions.
 * @param {ECS} ecs - AWS ECS client.
 * @param {string} currentArn - Current task definition ARN.
 * @param {string} targetArn - Target task definition ARN.
 * @param {boolean} quiet - Whether to suppress spinner output.
 * @returns {Promise<{current: Object, target: Object, differences: Array}>} Comparison details.
 */
async function compareTaskDefinitions(
  ecs,
  currentArn,
  targetArn,
  quiet = false,
) {
  const spinner = quiet ? null : ora("Comparing task definitions...").start();
  try {
    const [currentResponse, targetResponse] = await Promise.all([
      ecs.describeTaskDefinition({ taskDefinition: currentArn }),
      ecs.describeTaskDefinition({ taskDefinition: targetArn }),
    ]);

    const current = currentResponse.taskDefinition;
    const target = targetResponse.taskDefinition;

    if (spinner) spinner.succeed("Task definitions compared");

    // Extract key differences for display
    const differences = [];

    // Compare container images
    const currentImages = current.containerDefinitions.map((c) => ({
      name: c.name,
      image: c.image,
    }));
    const targetImages = target.containerDefinitions.map((c) => ({
      name: c.name,
      image: c.image,
    }));

    // Walk the union of container names so containers added or removed between
    // the two revisions are reported, not just images that changed in place.
    const currentByName = new Map(currentImages.map((c) => [c.name, c.image]));
    const targetByName = new Map(targetImages.map((c) => [c.name, c.image]));

    for (const name of new Set([
      ...currentByName.keys(),
      ...targetByName.keys(),
    ])) {
      const currentImage = currentByName.get(name);
      const targetImage = targetByName.get(name);

      if (currentImage === targetImage) continue;

      if (currentImage === undefined) {
        differences.push({
          type: "container_added",
          container: name,
          target: targetImage,
        });
      } else if (targetImage === undefined) {
        differences.push({
          type: "container_removed",
          container: name,
          current: currentImage,
        });
      } else {
        differences.push({
          type: "image",
          container: name,
          current: currentImage,
          target: targetImage,
        });
      }
    }

    // Compare CPU and memory
    if (current.cpu !== target.cpu) {
      differences.push({
        type: "cpu",
        current: current.cpu,
        target: target.cpu,
      });
    }

    if (current.memory !== target.memory) {
      differences.push({
        type: "memory",
        current: current.memory,
        target: target.memory,
      });
    }

    return {
      current: {
        revision: current.revision,
        family: current.family,
        createdAt: current.registeredAt,
        cpu: current.cpu,
        memory: current.memory,
        images: currentImages,
      },
      target: {
        revision: target.revision,
        family: target.family,
        createdAt: target.registeredAt,
        cpu: target.cpu,
        memory: target.memory,
        images: targetImages,
      },
      differences,
    };
  } catch (err) {
    if (spinner?.isSpinning) spinner.fail("Failed to compare task definitions");
    throw err;
  }
}

/**
 * Performs the actual service rollback by updating the service.
 * @param {ECS} ecs - AWS ECS client.
 * @param {string} cluster - Cluster name.
 * @param {string} serviceName - Service name.
 * @param {string} taskDefinitionArn - Target task definition ARN.
 * @param {boolean} quiet - Whether to suppress spinner output.
 * @returns {Promise<Object>} Update service response.
 */
async function performRollback(
  ecs,
  cluster,
  serviceName,
  taskDefinitionArn,
  quiet = false,
) {
  const spinner = quiet ? null : ora("Initiating service rollback...").start();
  try {
    const response = await ecs.updateService({
      cluster,
      service: serviceName,
      taskDefinition: taskDefinitionArn,
    });

    if (spinner) spinner.succeed("Rollback initiated successfully");
    return response;
  } catch (err) {
    if (spinner?.isSpinning) spinner.fail("Rollback failed");
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Task Definition Pruning Functions
// ---------------------------------------------------------------------------

/**
 * Sleep/delay utility function.
 * @param {number} ms - Milliseconds to sleep.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Handles prompts cancellation gracefully.
 * @param {Object} response - Prompts response object.
 * @param {string} key - The key to check in the response.
 * @returns {boolean} True if operation was cancelled.
 */
function wasPromptCancelled(response, key) {
  // Check if user cancelled (Ctrl+C, Escape, or closed prompt)
  return !response || response[key] === undefined || response[key] === null;
}

/**
 * Fetches all task definitions with pagination support and rate limiting.
 * @param {ECS} ecs - AWS ECS client.
 * @param {Object} params - listTaskDefinitions parameters.
 * @param {Object} spinner - Optional ora spinner for progress updates.
 * @returns {Promise<Array<string>>} All task definition ARNs.
 */
async function fetchAllTaskDefinitions(ecs, params = {}, spinner = null) {
  const allArns = [];
  let nextToken = null;
  let retryCount = 0;
  const maxRetries = 5;

  do {
    try {
      const response = await ecs.listTaskDefinitions({
        ...params,
        nextToken: nextToken || undefined,
        maxResults: 100, // AWS maximum
      });

      if (response.taskDefinitionArns) {
        allArns.push(...response.taskDefinitionArns);
      }

      nextToken = response.nextToken;
      retryCount = 0; // Reset retry count on success

      // Add small delay between pagination calls to avoid rate limits
      if (nextToken) {
        await sleep(100);
      }
    } catch (err) {
      if (
        err.name === "ThrottlingException" ||
        err.message.includes("Rate exceeded")
      ) {
        retryCount++;
        if (retryCount > maxRetries) {
          throw new Error(
            `Rate limit exceeded after ${maxRetries} retries. Please try again later.`,
            { cause: err },
          );
        }

        // Exponential backoff: 1s, 2s, 4s, 8s, 16s
        const backoffMs = Math.min(1000 * Math.pow(2, retryCount - 1), 16000);

        // Update spinner instead of logging to avoid cluttering output
        if (spinner) {
          spinner.text = chalk.yellow(
            `⚠️  Rate limit, pausing ${backoffMs / 1000}s... (${retryCount}/${maxRetries})`,
          );
        }

        await sleep(backoffMs);

        // Restore spinner text after retry
        if (spinner) {
          spinner.text = `Fetching task definitions... (${allArns.length} found)`;
        }
        // Don't advance nextToken, retry the same page
      } else {
        throw err;
      }
    }
  } while (nextToken);

  return allArns;
}

/**
 * Lists all unique task definition families across all clusters.
 * @param {ECS} ecs - AWS ECS client.
 * @param {boolean} quiet - Whether to suppress spinner output.
 * @returns {Promise<Array<{family: string, revisionCount: number, latestRevision: number, activeCount: number, inactiveCount: number}>>} Task definition families with details.
 */
async function listTaskDefinitionFamilies(ecs, quiet = false) {
  const spinner = quiet
    ? null
    : ora({
        text: "Fetching task definition families...",
        spinner: "dots",
      }).start();

  try {
    // ListTaskDefinitionFamilies returns the family names directly. The
    // previous implementation listed every task definition in the account and
    // grouped them client-side, then issued up to 100 describeTaskDefinition
    // calls per family just to count ACTIVE vs INACTIVE.
    const familyNames = await paginate(
      (p) => ecs.listTaskDefinitionFamilies(p),
      { status: "ALL" },
      "families",
    );

    if (familyNames.length === 0) {
      if (spinner) spinner.warn("No task definitions found");
      return [];
    }

    let completed = 0;
    const families = await mapWithConcurrency(
      familyNames,
      FAMILY_DETAIL_CONCURRENCY,
      async (family) => {
        try {
          // Counting ARNs is exact and needs no describe calls: the revision
          // number is part of the ARN and status is the filter.
          const [activeArns, inactiveArns] = await Promise.all([
            fetchAllTaskDefinitions(ecs, {
              familyPrefix: family,
              status: "ACTIVE",
              sort: "DESC",
            }),
            fetchAllTaskDefinitions(ecs, {
              familyPrefix: family,
              status: "INACTIVE",
              sort: "DESC",
            }),
          ]);

          const revisions = [...activeArns, ...inactiveArns].map(
            parseRevisionFromArn,
          );
          if (revisions.length === 0) return null;

          return {
            family,
            revisionCount: revisions.length,
            latestRevision: Math.max(...revisions),
            activeCount: activeArns.length,
            inactiveCount: inactiveArns.length,
          };
        } catch (err) {
          logger.warn(
            chalk.yellow(`Skipping family ${family}: ${err.message}`),
          );
          return null;
        } finally {
          completed += 1;
          if (spinner) {
            spinner.text = `Fetching task definition families... (${completed}/${familyNames.length})`;
          }
        }
      },
    );

    if (spinner) spinner.succeed("Task definition families fetched");
    return families
      .filter(Boolean)
      .sort((a, b) => b.revisionCount - a.revisionCount);
  } catch (err) {
    if (spinner?.isSpinning)
      spinner.fail("Failed to fetch task definition families");
    throw err;
  }
}

/**
 * Analyzes task definition revisions for a specific family.
 * @param {ECS} ecs - AWS ECS client.
 * @param {string} family - Task definition family name.
 * @param {string} cluster - Cluster name (optional, for checking service usage).
 * @param {boolean} quiet - Whether to suppress spinner output.
 * @returns {Promise<{revisions: Array, protected: Array, inUse: Set, latest: number}>} Analysis results.
 */
async function analyzeTaskDefinitionRevisions(
  ecs,
  family,
  cluster = null,
  quiet = false,
) {
  const spinner = quiet
    ? null
    : ora({
        text: "Analyzing task definition revisions...",
        spinner: "dots",
        color: "cyan",
      }).start();
  try {
    // Get all revisions for this family with pagination
    const taskDefinitionArns = await fetchAllTaskDefinitions(
      ecs,
      {
        familyPrefix: family,
        sort: "DESC",
      },
      spinner,
    );

    if (!taskDefinitionArns || taskDefinitionArns.length === 0) {
      if (spinner) spinner.warn("No revisions found");
      return { revisions: [], protected: [], inUse: new Set(), latest: 0 };
    }

    if (spinner)
      spinner.text = `Found ${taskDefinitionArns.length} revisions, analyzing...`;

    // Find revisions in use by services
    const inUseRevisions = new Set();

    if (cluster) {
      try {
        const services = await listServices(ecs, cluster, true);
        services.forEach((service) => {
          inUseRevisions.add(service.taskDefinition);
        });
      } catch (err) {
        // Fail closed. Continuing with an empty in-use set would present
        // revisions that are serving live traffic as safe to delete. The outer
        // catch stops the spinner.
        throw new Error(
          `Unable to check service usage in cluster ${cluster}: ${err.message}. ` +
            "Refusing to continue: pruning without this check could delete a revision that is in use.",
          { cause: err },
        );
      }
    }

    // Get detailed info for each revision (in batches to avoid rate limits)
    if (spinner)
      spinner.text = `Fetching details for ${taskDefinitionArns.length} revisions...`;

    const BATCH_SIZE = 20; // Reduced from 50 to avoid rate limits
    const BATCH_DELAY_MS = 500; // Delay between batches
    const revisions = [];

    for (let i = 0; i < taskDefinitionArns.length; i += BATCH_SIZE) {
      const batch = taskDefinitionArns.slice(i, i + BATCH_SIZE);

      if (spinner) {
        spinner.text = `Fetching revision details... (${Math.min(i + batch.length, taskDefinitionArns.length)}/${taskDefinitionArns.length})`;
      }

      // Retry logic for the entire batch
      let batchResults = [];
      let retryCount = 0;
      const maxRetries = 3;

      while (retryCount <= maxRetries) {
        try {
          batchResults = await Promise.all(
            batch.map(async (arn, batchIndex) => {
              try {
                const { taskDefinition } = await ecs.describeTaskDefinition({
                  taskDefinition: arn,
                });

                const index = i + batchIndex;
                const revision = taskDefinition.revision;
                const isLatest = index === 0; // First in DESC sorted list
                const isInUse = inUseRevisions.has(arn);
                const isInLatest5 = index < KEEP_LATEST_COUNT;

                return {
                  arn,
                  family: taskDefinition.family,
                  revision,
                  status: taskDefinition.status,
                  createdAt: taskDefinition.registeredAt,
                  size: taskDefinition.size || 0,
                  isLatest,
                  isInUse,
                  isInLatest5,
                  isProtected: isLatest || isInUse,
                  containerImages: taskDefinition.containerDefinitions.map(
                    (c) => ({
                      name: c.name,
                      image: c.image,
                    }),
                  ),
                };
              } catch (err) {
                if (
                  err.name === "ThrottlingException" ||
                  err.message.includes("Rate exceeded")
                ) {
                  throw err; // Propagate to batch retry logic
                }
                // Silently skip failed describe calls - they'll be filtered out
                return null;
              }
            }),
          );

          // Success - break retry loop
          break;
        } catch (err) {
          if (
            err.name === "ThrottlingException" ||
            err.message.includes("Rate exceeded")
          ) {
            retryCount++;
            if (retryCount > maxRetries) {
              throw new Error(
                `Rate limit exceeded after ${maxRetries} retries on batch ${i / BATCH_SIZE + 1}. Please try again later.`,
                { cause: err },
              );
            }

            // Exponential backoff
            const backoffMs = Math.min(
              2000 * Math.pow(2, retryCount - 1),
              10000,
            );
            if (spinner) {
              spinner.text = `Rate limit hit, pausing ${backoffMs}ms... (${retryCount}/${maxRetries})`;
            }
            await sleep(backoffMs);
          } else {
            throw err;
          }
        }
      }

      revisions.push(...batchResults.filter(Boolean));

      // Add delay between batches to avoid rate limits (except for last batch)
      if (i + BATCH_SIZE < taskDefinitionArns.length) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    const latest = revisions.length > 0 ? revisions[0].revision : 0;
    const protectedRevisions = revisions.filter((r) => r.isProtected);

    if (spinner)
      spinner.succeed(
        `Analysis complete: ${revisions.length} revisions loaded`,
      );

    return {
      revisions,
      protected: protectedRevisions,
      inUse: inUseRevisions,
      latest,
    };
  } catch (err) {
    if (spinner?.isSpinning)
      spinner.fail("Failed to analyze task definition revisions");
    throw err;
  }
}

/**
 * Prompts user to select a task definition family.
 * @param {ECS} ecs - AWS ECS client.
 * @returns {Promise<string>} Selected family name.
 */
async function selectTaskDefinitionFamily(ecs) {
  const families = await listTaskDefinitionFamilies(ecs, true);

  if (!families || families.length === 0) {
    logger.warn(chalk.yellow("No task definition families found."));
    throw new Error("No task definitions available");
  }

  const choices = families.map((f) => {
    const hasInactive = f.inactiveCount > 0;
    const cleanupAvailable = f.revisionCount > KEEP_LATEST_COUNT;

    const statusBadge = hasInactive
      ? chalk.yellow(`${f.inactiveCount} inactive`)
      : chalk.green("all active");

    const cleanupBadge = cleanupAvailable
      ? chalk.cyan(
          ` [${f.revisionCount - KEEP_LATEST_COUNT} beyond latest ${KEEP_LATEST_COUNT}]`,
        )
      : "";

    return {
      title: `${chalk.bold(f.family)} ${statusBadge}`,
      description: `${f.revisionCount} revisions (${f.activeCount} active, ${f.inactiveCount} inactive, latest: ${f.latestRevision})${cleanupBadge}`,
      value: f.family,
    };
  });

  const response = await prompts(
    {
      type: "autocomplete",
      name: "family",
      message: chalk.blue("Select task definition family to prune:"),
      choices,
      hint: "- Type to search, use arrows to navigate",
      suggest: (input, choices) => {
        const inputLower = input.toLowerCase();
        return choices.filter(
          (choice) =>
            choice.title.toLowerCase().includes(inputLower) ||
            (choice.description &&
              choice.description.toLowerCase().includes(inputLower)),
        );
      },
    },
    {
      onCancel: () => {
        logger.info(chalk.dim("\nOperation cancelled"));
        process.exit(0);
      },
    },
  );

  if (wasPromptCancelled(response, "family")) {
    cancelOperation();
  }

  return response.family;
}

/**
 * Splits revisions into the buckets the bulk selection options offer.
 *
 * A revision is deletable only when it is neither protected (latest / in use by
 * a service) nor inside the latest-N window the prune command promises to keep.
 * Every bucket is derived from that one list, so no option can reach past the
 * promise the command prints to the user.
 *
 * @param {Array} revisions - Revisions in DESC order, as returned by analyzeTaskDefinitionRevisions.
 * @param {number} now - Current time in milliseconds, injected for testability.
 * @returns {{deletable: Array, inactiveBeyondLatestN: Array, beyondLatest10: Array, revisionsByAge: Object, ageBuckets: number[]}}
 */
function computeDeletionBuckets(revisions, now = Date.now()) {
  const deletable = revisions.filter((r) => !r.isProtected && !r.isInLatest5);
  const inactiveBeyondLatestN = deletable.filter(
    (r) => r.status === "INACTIVE",
  );

  // Position in the DESC-sorted list, precomputed so the "beyond latest N"
  // filter does not run indexOf per element.
  const positionByRevision = new Map(revisions.map((r, i) => [r, i]));
  const beyondLatest10 = deletable.filter(
    (r) => positionByRevision.get(r) >= 10,
  );

  const ageBuckets = [30, 90, 180, 365];
  const revisionsByAge = Object.fromEntries(
    ageBuckets.map((days) => [
      days,
      deletable.filter(
        (r) =>
          now - new Date(r.createdAt).getTime() > days * 24 * 60 * 60 * 1000,
      ),
    ]),
  );

  return {
    deletable,
    inactiveBeyondLatestN,
    beyondLatest10,
    revisionsByAge,
    ageBuckets,
  };
}

/**
 * Prompts user to select revisions to delete with smart bulk selection options.
 * @param {Array} revisions - Array of revision objects from analyzeTaskDefinitionRevisions.
 * @returns {Promise<Array>} Selected revision objects.
 */
async function selectRevisionsToDelete(revisions) {
  const {
    deletable,
    inactiveBeyondLatestN,
    beyondLatest10,
    revisionsByAge,
    ageBuckets,
  } = computeDeletionBuckets(revisions);

  console.log(chalk.blue("\n📋 Selection Options:\n"));

  const selectionChoices = [
    {
      title: chalk.green(
        `All INACTIVE revisions beyond latest ${KEEP_LATEST_COUNT} (${inactiveBeyondLatestN.length} revisions)`,
      ),
      description:
        "Recommended: Safe bulk deletion of unused, inactive revisions",
      value: "inactive_beyond_keep",
      disabled: inactiveBeyondLatestN.length === 0,
    },
    {
      title: chalk.yellow(
        `All revisions beyond latest 10 (${beyondLatest10.length} revisions)`,
      ),
      description: "Keep more history, delete everything else",
      value: "beyond_10",
      disabled: beyondLatest10.length === 0,
    },
    ...ageBuckets.map((days) => ({
      title: chalk.cyan(
        days === 365
          ? `Revisions older than 1 year (${revisionsByAge[days].length} revisions)`
          : `Revisions older than ${days} days (${revisionsByAge[days].length} revisions)`,
      ),
      description: "Age-based cleanup",
      value: `age_${days}`,
      disabled: revisionsByAge[days].length === 0,
    })),
    {
      title: chalk.magenta("Manual selection (checkbox list)"),
      description: `Choose specific revisions from ${deletable.length} eligible`,
      value: "manual",
      disabled: deletable.length === 0,
    },
    {
      title: chalk.red("Custom: Select by revision number range"),
      description: "Specify exact revision range to delete",
      value: "range",
      disabled: deletable.length === 0,
    },
  ];

  const methodResponse = await prompts(
    {
      type: "select",
      name: "method",
      message: chalk.blue("How would you like to select revisions to delete?"),
      choices: selectionChoices,
    },
    { onCancel: cancelOperation },
  );

  if (wasPromptCancelled(methodResponse, "method")) {
    logger.info(chalk.dim("Operation cancelled"));
    return [];
  }

  let selected;
  const method = methodResponse.method;

  if (method === "inactive_beyond_keep") {
    selected = inactiveBeyondLatestN;
  } else if (method === "beyond_10") {
    selected = beyondLatest10;
  } else if (method.startsWith("age_")) {
    selected = revisionsByAge[Number(method.slice(4))];
  } else if (method === "range") {
    const rangeResponse = await prompts(
      [
        {
          type: "number",
          name: "from",
          message: chalk.blue("Delete from revision number:"),
          validate: (value) => value > 0 || "Must be a positive number",
        },
        {
          type: "number",
          name: "to",
          message: chalk.blue("Delete to revision number (inclusive):"),
          validate: (value) => value > 0 || "Must be a positive number",
        },
      ],
      { onCancel: cancelOperation },
    );

    if (
      wasPromptCancelled(rangeResponse, "from") ||
      wasPromptCancelled(rangeResponse, "to")
    ) {
      logger.info(chalk.dim("Operation cancelled"));
      return [];
    }

    const from = Math.min(rangeResponse.from, rangeResponse.to);
    const to = Math.max(rangeResponse.from, rangeResponse.to);

    selected = deletable.filter((r) => r.revision >= from && r.revision <= to);

    if (selected.length === 0) {
      logger.warn(
        chalk.yellow(
          `No deletable revisions found in range ${from}-${to}. Protected revisions and the latest ${KEEP_LATEST_COUNT} are excluded.`,
        ),
      );
      return [];
    }
  } else if (method === "manual") {
    // Cap the rendered list; a family with thousands of revisions makes an
    // unusable checkbox and the bulk options exist for that case.
    const revisionsToShow = deletable.slice(0, MANUAL_SELECTION_LIMIT);

    if (deletable.length > MANUAL_SELECTION_LIMIT) {
      console.log(
        chalk.yellow(
          `\n⚠️  Showing first ${MANUAL_SELECTION_LIMIT} of ${deletable.length} eligible revisions. Consider using bulk options instead.\n`,
        ),
      );
    }

    const choices = revisionsToShow.map((rev) => {
      const date = new Date(rev.createdAt).toLocaleDateString();
      const size = (rev.size / 1024).toFixed(1);
      const isInactive = rev.status === "INACTIVE";

      const statusBadge = isInactive
        ? chalk.yellow("INACTIVE")
        : chalk.green("ACTIVE");
      const reasonBadge = isInactive ? chalk.red(" ← suggested") : "";

      return {
        title: `Revision ${rev.revision} - ${statusBadge} - ${date}, ${size} KB${reasonBadge}`,
        value: rev,
        selected: isInactive,
      };
    });

    const manualResponse = await prompts(
      {
        type: "multiselect",
        name: "selected",
        message: chalk.blue(
          "Select revisions to delete (Space to toggle, Enter to confirm):",
        ),
        choices,
        optionsPerPage: 20,
      },
      { onCancel: cancelOperation },
    );

    selected = manualResponse.selected || [];
  } else {
    logger.warn(chalk.yellow("Unknown selection method"));
    return [];
  }

  if (selected.length === 0) {
    logger.info(chalk.yellow("No revisions selected"));
    return [];
  }

  console.log(
    chalk.green(`\n✅ Selected ${selected.length} revision(s) for deletion\n`),
  );
  return selected;
}

/**
 * Generates a detailed deletion plan preview.
 * @param {Array} allRevisions - All revisions.
 * @param {Array} selectedRevisions - Selected revisions to delete.
 * @returns {Object} Deletion plan with statistics.
 */
function generateDeletionPlan(allRevisions, selectedRevisions) {
  const toDeregister = selectedRevisions.filter((r) => r.status === "ACTIVE");
  const toDelete = selectedRevisions.filter((r) => r.status === "INACTIVE");
  const protectedRevisions = allRevisions.filter((r) => r.isProtected);
  const selectedSet = new Set(selectedRevisions);
  const kept = allRevisions.filter((r) => !selectedSet.has(r));

  return {
    total: allRevisions.length,
    protected: protectedRevisions.length,
    protectedRevisions: protectedRevisions,
    kept: kept.length,
    keptRevisions: kept,
    willDeregister: toDeregister.length,
    deregisterRevisions: toDeregister,
    willDelete: toDelete.length,
    deleteRevisions: toDelete,
    selected: selectedRevisions.length,
  };
}

/**
 * Deregisters task definition revisions (marks as INACTIVE) with rate limiting.
 * @param {ECS} ecs - AWS ECS client.
 * @param {Array<string>} revisionArns - Task definition ARNs to deregister.
 * @param {boolean} quiet - Whether to suppress spinner output.
 * @returns {Promise<{success: Array, failed: Array}>} Results.
 */
async function deregisterTaskDefinitions(ecs, revisionArns, quiet = false) {
  const success = [];
  const failed = [];

  const spinner = quiet
    ? null
    : ora({
        text: "Deregistering task definitions...",
        spinner: "dots",
        color: "yellow",
      }).start();
  const DELAY_MS = 200; // Delay between each deregister call
  const maxRetries = 3;

  for (let i = 0; i < revisionArns.length; i++) {
    const arn = revisionArns[i];
    let retryCount = 0;
    let succeeded = false;

    while (retryCount <= maxRetries && !succeeded) {
      try {
        await ecs.deregisterTaskDefinition({ taskDefinition: arn });
        success.push(arn);
        succeeded = true;

        if (spinner) {
          spinner.text = `Deregistered ${success.length}/${revisionArns.length}...`;
        }
      } catch (err) {
        if (
          err.name === "ThrottlingException" ||
          err.message.includes("Rate exceeded")
        ) {
          retryCount++;
          if (retryCount > maxRetries) {
            failed.push({ arn, error: err.message });
            // Don't log here - will be reported in final summary
          } else {
            // Exponential backoff: 1s, 2s, 4s
            const backoffMs = 1000 * Math.pow(2, retryCount - 1);
            if (spinner) {
              spinner.text = chalk.yellow(
                `⚠️  Rate limit, pausing ${backoffMs / 1000}s... (attempt ${retryCount}/${maxRetries})`,
              );
            }
            await sleep(backoffMs);
            if (spinner) {
              spinner.text = `Deregistering ${success.length + 1}/${revisionArns.length}...`;
            }
          }
        } else {
          failed.push({ arn, error: err.message });
          // Don't log here - will be reported in final summary
          break; // Don't retry non-throttling errors
        }
      }
    }

    // Add delay between calls (except for last one)
    if (i < revisionArns.length - 1 && succeeded) {
      await sleep(DELAY_MS);
    }
  }

  if (spinner) {
    if (failed.length === 0) {
      spinner.succeed(`Successfully deregistered ${success.length} revisions`);
    } else {
      spinner.warn(`Deregistered ${success.length}, failed ${failed.length}`);
    }
  }

  return { success, failed };
}

/**
 * Deletes task definition revisions permanently (batch operation) with rate limiting.
 * @param {ECS} ecs - AWS ECS client.
 * @param {Array<string>} revisionArns - Task definition ARNs to delete.
 * @param {boolean} quiet - Whether to suppress spinner output.
 * @returns {Promise<{success: Array, failed: Array}>} Results.
 */
async function deleteTaskDefinitions(ecs, revisionArns, quiet = false) {
  const success = [];
  const failed = [];

  const spinner = quiet
    ? null
    : ora({
        text: "Deleting task definitions...",
        spinner: "dots",
        color: "red",
      }).start();

  // AWS allows batch deletion of up to 10 task definitions at a time
  const BATCH_SIZE = 10;
  const BATCH_DELAY_MS = 300; // Delay between batches
  const batches = [];

  for (let i = 0; i < revisionArns.length; i += BATCH_SIZE) {
    batches.push(revisionArns.slice(i, i + BATCH_SIZE));
  }

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    let retryCount = 0;
    const maxRetries = 3;
    let batchSuccess = false;

    while (retryCount <= maxRetries && !batchSuccess) {
      try {
        const response = await ecs.deleteTaskDefinitions({
          taskDefinitions: batch,
        });

        if (response.failures && response.failures.length > 0) {
          response.failures.forEach((failure) => {
            failed.push({ arn: failure.arn, error: failure.reason });
            // Don't log here - will be reported in final summary
          });
        }

        // Track successful deletions
        const successfulArns = batch.filter(
          (arn) =>
            !response.failures || !response.failures.find((f) => f.arn === arn),
        );
        success.push(...successfulArns);
        batchSuccess = true;

        if (spinner) {
          spinner.text = `Deleted batch ${i + 1}/${batches.length} (${success.length} total)...`;
        }
      } catch (err) {
        if (
          err.name === "ThrottlingException" ||
          err.message.includes("Rate exceeded")
        ) {
          retryCount++;
          if (retryCount > maxRetries) {
            batch.forEach((arn) => {
              failed.push({
                arn,
                error: `Rate limit exceeded after ${maxRetries} retries`,
              });
            });
            // Don't log here - will be reported in final summary
          } else {
            // Exponential backoff: 1s, 2s, 4s
            const backoffMs = 1000 * Math.pow(2, retryCount - 1);
            if (spinner) {
              spinner.text = chalk.yellow(
                `⚠️  Rate limit, pausing ${backoffMs / 1000}s... (attempt ${retryCount}/${maxRetries})`,
              );
            }
            await sleep(backoffMs);
            if (spinner) {
              spinner.text = `Deleting batch ${i + 1}/${batches.length}...`;
            }
          }
        } else {
          batch.forEach((arn) => {
            failed.push({ arn, error: err.message });
          });
          // Don't log here - will be reported in final summary
          break; // Don't retry non-throttling errors
        }
      }
    }

    // Add delay between batches (except for last one)
    if (i < batches.length - 1 && batchSuccess) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  if (spinner) {
    if (failed.length === 0) {
      spinner.succeed(`Successfully deleted ${success.length} revisions`);
    } else {
      spinner.warn(`Deleted ${success.length}, failed ${failed.length}`);
    }
  }

  return { success, failed };
}

/**
 * Orchestrates the pruning operation (deregister + delete).
 * @param {ECS} ecs - AWS ECS client.
 * @param {Array} selectedRevisions - Revisions to delete.
 * @returns {Promise<Object>} Summary statistics.
 */
async function performPruning(ecs, selectedRevisions) {
  const activeRevisions = selectedRevisions.filter(
    (r) => r.status === "ACTIVE",
  );
  const inactiveRevisions = selectedRevisions.filter(
    (r) => r.status === "INACTIVE",
  );

  logger.info(chalk.blue("\n🚀 Starting pruning operation...\n"));

  const results = {
    deregister: { success: [], failed: [] },
    delete: { success: [], failed: [] },
  };

  // Phase 1: Deregister ACTIVE revisions
  if (activeRevisions.length > 0) {
    logger.info(
      chalk.yellow(
        `Phase 1: Deregistering ${activeRevisions.length} ACTIVE revisions...`,
      ),
    );
    const deregisterArns = activeRevisions.map((r) => r.arn);
    results.deregister = await deregisterTaskDefinitions(ecs, deregisterArns);
  }

  // Phase 2: Delete INACTIVE revisions (including newly deregistered ones)
  const revisionsToDelete = [
    ...inactiveRevisions,
    ...activeRevisions.filter((r) =>
      results.deregister.success.includes(r.arn),
    ),
  ];

  if (revisionsToDelete.length > 0) {
    logger.info(
      chalk.yellow(
        `\nPhase 2: Deleting ${revisionsToDelete.length} INACTIVE revisions...`,
      ),
    );
    const deleteArns = revisionsToDelete.map((r) => r.arn);
    results.delete = await deleteTaskDefinitions(ecs, deleteArns);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Diagnostic Functions
// ---------------------------------------------------------------------------

/**
 * Checks if AWS CLI is installed.
 * @returns {boolean} True if installed, false otherwise.
 */
function checkAwsCliInstalled() {
  try {
    execSync("aws --version", { stdio: "ignore" });
    return true;
  } catch {
    // A missing binary is the answer to the check, not an error to report.
    return false;
  }
}

/**
 * Checks if Session Manager Plugin is installed.
 * @returns {boolean} True if installed, false otherwise.
 */
function checkSessionManagerPluginInstalled() {
  try {
    execSync("session-manager-plugin --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks if AWS credentials are configured.
 * @returns {boolean} True if configured, false otherwise.
 */
function checkAwsCredentials() {
  return fs.existsSync(getCredentialsPath()) || fs.existsSync(getConfigPath());
}

/**
 * Checks if the configured AWS profile is valid.
 * @returns {boolean} True if valid, false otherwise.
 */
function checkAwsProfileConfigured() {
  return config.get("awsProfiles").includes(getActiveProfile());
}

/**
 * Performs diagnostics to check environment setup.
 * @returns {Promise<boolean>} True when every check passed.
 */
async function performDiagnostics() {
  let allGood = true;

  logger.info(chalk.blue.bold("🏃 Running Diagnostics..."));

  if (!checkAwsCliInstalled()) {
    logger.error(chalk.red("❌ AWS CLI is not installed."));
    allGood = false;
  } else {
    logger.info(chalk.green("✅ AWS CLI is installed."));
  }

  if (!checkSessionManagerPluginInstalled()) {
    logger.error(chalk.red("❌ Session Manager Plugin is not installed."));
    allGood = false;
  } else {
    logger.info(chalk.green("✅ Session Manager Plugin is installed."));
  }

  if (!checkAwsCredentials()) {
    logger.error(chalk.red("❌ AWS credentials are not configured."));
    allGood = false;
  } else {
    logger.info(chalk.green("✅ AWS credentials are configured."));
  }

  if (!checkAwsProfileConfigured()) {
    logger.error(
      chalk.red(`❌ AWS profile '${getActiveProfile()}' is not configured.`),
    );
    allGood = false;
  } else {
    logger.info(
      chalk.green(`✅ AWS profile '${getActiveProfile()}' is configured.`),
    );
  }

  if (allGood) {
    logger.info(
      chalk.green(
        "💯 All checks passed! Your environment is set up correctly.",
      ),
    );
  } else {
    logger.warn(
      chalk.yellow(
        "😭 Errors were detected. Please address them and try again.",
      ),
    );
  }

  return allGood;
}

// ---------------------------------------------------------------------------
// CLI Program Setup using Commander
// ---------------------------------------------------------------------------
const program = new Command();

program
  // Plain text: the name is used in usage strings and shell completions, where
  // embedded ANSI escapes would leak through.
  .name("taskonaut")
  .description(
    "✨ Interactive ECS task executor, rollback tool, and task definition cleanup utility",
  )
  .version(packageJson.version, "-v, --version", "Print the installed version")
  .option(
    "-c, --command <command>",
    "Command to run in the container",
    DEFAULT_EXEC_COMMAND,
  )
  .addHelpText("after", chalk.dim("Example: taskonaut --command /bin/bash"))
  .action(async (options) => {
    try {
      const ecs = await initAWS();
      let cluster = await selectCluster(ecs);
      let taskArn, containerName;

      // Allow backward navigation on task and container selection.
      while (true) {
        taskArn = await selectTask(ecs, cluster, true);
        if (taskArn === "__BACK__") {
          cluster = await selectCluster(ecs);
          continue;
        }
        while (true) {
          containerName = await selectContainer(ecs, cluster, taskArn, true);
          if (containerName === "__BACK__") {
            break; // Go back to task selection.
          }
          logger.info(
            chalk.green(
              `🚀 Connecting to container ${chalk.bold(containerName)}...`,
            ),
          );
          await executeCommand(
            cluster,
            taskArn,
            containerName,
            options.command,
          );
          return; // End after session completes.
        }
      }
    } catch (err) {
      logger.error(chalk.red(err.message));
      process.exit(1);
    }
  });

program
  .command("config")
  .description("Manage configuration settings")
  .addCommand(
    new Command("set")
      .description("Set AWS profile and region")
      .addHelpText("after", chalk.dim("Example: taskonaut config set"))
      .action(async () => {
        try {
          const spinner = ora("Loading AWS profiles...").start();
          const profiles = await getAwsProfiles();
          spinner.succeed("AWS profiles loaded");

          if (profiles.length === 0) {
            logger.error(
              chalk.red(
                "No AWS profiles found. Configure one with `aws configure` or `aws sso login` first.",
              ),
            );
            process.exit(1);
          }

          const profileChoices = profiles.map((p) => ({
            title: chalk.green(p),
            value: p,
          }));
          const regionChoices = AWS_REGIONS.map((r) => ({
            title: chalk.green(r),
            value: r,
          }));

          const { profile, region } = await prompts(
            [
              {
                type: "autocomplete",
                name: "profile",
                message: chalk.blue("🔑 Select AWS Profile:"),
                choices: profileChoices,
                initial: Math.max(
                  profileChoices.findIndex(
                    (c) => c.value === config.get("awsProfile"),
                  ),
                  0,
                ),
                hint: "- Type to search, use arrows to navigate",
              },
              {
                type: "autocomplete",
                name: "region",
                message: chalk.blue("🌎 Select AWS Region:"),
                choices: regionChoices,
                initial: Math.max(
                  regionChoices.findIndex(
                    (c) => c.value === config.get("awsRegion"),
                  ),
                  0,
                ),
                hint: "- Type to search, use arrows to navigate",
              },
            ],
            { onCancel: cancelOperation },
          );

          config.set("awsProfile", profile);
          config.set("awsRegion", region);

          logger.info(chalk.green("✨ Configuration saved successfully!"));

          if (process.env.AWS_PROFILE || process.env.AWS_REGION) {
            logger.warn(
              chalk.yellow(
                "Note: AWS_PROFILE / AWS_REGION are set in your environment and take precedence over this configuration.",
              ),
            );
          }
        } catch (err) {
          logger.error(chalk.red(err.message));
          process.exit(1);
        }
      }),
  )
  .addCommand(
    new Command("show")
      .alias("path")
      .description("Show configuration path and current values")
      .action(async () => {
        try {
          const spinner = ora("Reading configuration...").start();
          const configDetails = {
            path: config.path,
            values: config.store,
          };
          spinner.succeed("Configuration loaded");
          console.log("\n" + chalk.blue.bold("Configuration Details:"));
          console.log(chalk.dim("Path:"), chalk.green(configDetails.path));
          console.log(chalk.dim("Values:"));
          console.log(
            chalk.green(JSON.stringify(configDetails.values, null, 2)),
          );
        } catch (err) {
          logger.error(chalk.red(err.message));
          process.exit(1);
        }
      }),
  )
  .addCommand(
    new Command("cleanup")
      .alias("clear")
      .description("Remove all stored configuration")
      .action(async () => {
        try {
          const { confirm } = await prompts(
            {
              type: "confirm",
              name: "confirm",
              message: chalk.yellow(
                "⚠️  Are you sure you want to remove all stored configuration?",
              ),
              initial: false,
            },
            { onCancel: cancelOperation },
          );

          if (confirm) {
            const spinner = ora("Cleaning up configuration...").start();
            config.clear();
            spinner.succeed("Configuration cleared successfully");
          } else {
            logger.info(chalk.dim("Cleanup cancelled"));
          }
        } catch (err) {
          logger.error(chalk.red(err.message));
          process.exit(1);
        }
      }),
  );

program
  .command("doctor")
  .description("Run diagnostics to check your environment setup")
  .action(async () => {
    try {
      const allGood = await performDiagnostics();
      if (!allGood) process.exitCode = 1;
    } catch (err) {
      logger.error(chalk.red("Diagnostics failed: " + err.message));
      process.exit(1);
    }
  });

program
  .command("rollback")
  .description("Rollback an ECS service to a previous task definition revision")
  .addHelpText("after", chalk.dim("Example: taskonaut rollback"))
  .action(async () => {
    try {
      console.log(chalk.cyan.bold("🔄 ECS Service Rollback"));
      console.log(
        chalk.dim("Select a cluster, service, and revision to rollback to.\n"),
      );

      const ecs = await initAWS();

      // Step 1: Select cluster
      const clusters = await listClusters(ecs, true); // quiet mode to avoid spinner interference
      if (!clusters || clusters.length === 0) {
        console.log(chalk.yellow("No ECS clusters found"));
        return;
      }

      const clusterChoices = clusters.map((c) => ({
        title: `${chalk.green(c.clusterName)} ${chalk.yellow(`(${c.servicesCount} services, ${c.tasksCount} tasks)`)}`,
        value: c.clusterName,
      }));

      const clusterResponse = await prompts({
        type: "select",
        name: "cluster",
        message: chalk.blue("Select ECS cluster:"),
        choices: clusterChoices,
      });

      if (!clusterResponse.cluster) {
        console.log(chalk.dim("Operation cancelled"));
        return;
      }

      const cluster = clusterResponse.cluster;
      console.log(chalk.green(`📍 Selected cluster: ${chalk.bold(cluster)}\n`));

      // Step 2: Select service
      const services = await listServices(ecs, cluster, true); // quiet mode
      if (!services || services.length === 0) {
        console.log(chalk.yellow("No services found in cluster"));
        return;
      }

      const serviceChoices = services.map((s) => ({
        title: `${chalk.green(s.serviceName)} ${chalk.yellow(`(${s.taskDefinitionFamily}:${s.revision}, ${s.status}, ${s.runningCount}/${s.desiredCount} tasks)`)}`,
        value: s,
      }));

      const serviceResponse = await prompts({
        type: "select",
        name: "service",
        message: chalk.blue("Select ECS service to rollback:"),
        choices: serviceChoices,
      });

      if (!serviceResponse.service) {
        console.log(chalk.dim("Operation cancelled"));
        return;
      }

      const service = serviceResponse.service;
      console.log(
        chalk.green(`🎯 Selected service: ${chalk.bold(service.serviceName)}`),
      );
      console.log(
        chalk.dim(
          `   Current revision: ${service.taskDefinitionFamily}:${service.revision}\n`,
        ),
      );

      // Step 3: Select target revision
      const revisions = await listTaskDefinitionRevisions(
        ecs,
        service.taskDefinitionFamily,
        true,
      ); // quiet mode
      const availableRevisions = revisions
        .filter((r) => r.revision !== service.revision)
        .sort((a, b) => b.revision - a.revision);

      if (availableRevisions.length === 0) {
        console.log(chalk.yellow("No other revisions available for rollback"));
        return;
      }

      const revisionChoices = availableRevisions.map((r) => ({
        title: `${chalk.green(`Revision ${r.revision}`)} ${chalk.yellow(`(${r.status}, created: ${new Date(r.createdAt).toLocaleString()})`)}`,
        value: r,
      }));

      const revisionResponse = await prompts({
        type: "select",
        name: "revision",
        message: chalk.blue("Select revision to rollback to:"),
        choices: revisionChoices,
      });

      if (!revisionResponse.revision) {
        console.log(chalk.dim("Operation cancelled"));
        return;
      }

      const targetRevision = revisionResponse.revision;
      console.log(
        chalk.green(
          `📋 Target revision: ${chalk.bold(`${service.taskDefinitionFamily}:${targetRevision.revision}`)}\n`,
        ),
      );

      // Step 4: Show comparison between current and target
      const comparison = await compareTaskDefinitions(
        ecs,
        service.taskDefinition,
        targetRevision.taskDefinition,
        true, // quiet mode
      );

      // Display comparison details
      console.log(chalk.blue.bold("🔍 Rollback Preview:"));
      console.log(chalk.dim("─".repeat(60)));

      console.log(chalk.yellow("Current (will be replaced):"));
      console.log(`  📦 Revision: ${chalk.bold(comparison.current.revision)}`);
      console.log(
        `  📅 Created: ${chalk.dim(new Date(comparison.current.createdAt).toLocaleString())}`,
      );
      if (comparison.current.cpu)
        console.log(`  💻 CPU: ${comparison.current.cpu}`);
      if (comparison.current.memory)
        console.log(`  🧠 Memory: ${comparison.current.memory}`);
      if (comparison.current.images && comparison.current.images.length > 0) {
        comparison.current.images.forEach((img) => {
          console.log(
            `  🐳 ${chalk.cyan(img.name)}: ${chalk.dim(parseImageTag(img.image))}`,
          );
        });
      }

      console.log(chalk.green("\nTarget (rollback to):"));
      console.log(`  📦 Revision: ${chalk.bold(comparison.target.revision)}`);
      console.log(
        `  📅 Created: ${chalk.dim(new Date(comparison.target.createdAt).toLocaleString())}`,
      );
      if (comparison.target.cpu)
        console.log(`  💻 CPU: ${comparison.target.cpu}`);
      if (comparison.target.memory)
        console.log(`  🧠 Memory: ${comparison.target.memory}`);
      if (comparison.target.images && comparison.target.images.length > 0) {
        comparison.target.images.forEach((img) => {
          console.log(
            `  🐳 ${chalk.cyan(img.name)}: ${chalk.dim(parseImageTag(img.image))}`,
          );
        });
      }

      // Show container image differences
      if (comparison.differences.length > 0) {
        console.log(chalk.red.bold("\n⚠️  Changes detected:"));
        comparison.differences.forEach((diff) => {
          switch (diff.type) {
            case "image":
              console.log(`  🐳 ${chalk.yellow(diff.container)}:`);
              console.log(`     Current: ${chalk.red(diff.current)}`);
              console.log(`     Target:  ${chalk.green(diff.target)}`);
              break;
            case "container_added":
              console.log(
                `  ➕ ${chalk.yellow(diff.container)}: not in current revision, added by target`,
              );
              console.log(`     Target:  ${chalk.green(diff.target)}`);
              break;
            case "container_removed":
              console.log(
                `  ➖ ${chalk.yellow(diff.container)}: present now, ${chalk.red("removed")} by target`,
              );
              console.log(`     Current: ${chalk.red(diff.current)}`);
              break;
            case "cpu":
              console.log(
                `  💻 CPU: ${chalk.red(diff.current)} → ${chalk.green(diff.target)}`,
              );
              break;
            case "memory":
              console.log(
                `  🧠 Memory: ${chalk.red(diff.current)} → ${chalk.green(diff.target)}`,
              );
              break;
          }
        });
      } else {
        console.log(
          chalk.blue("\n✨ No significant changes detected between revisions"),
        );
      }

      // Step 5: Confirm rollback
      const confirmResponse = await prompts({
        type: "confirm",
        name: "confirm",
        message: chalk.yellow(
          `⚠️  Proceed with rollback? (${service.revision} → ${targetRevision.revision})`,
        ),
        initial: false,
      });

      if (!confirmResponse.confirm) {
        console.log(chalk.dim("Rollback cancelled by user"));
        return;
      }

      // Step 6: Perform rollback
      console.log(chalk.blue("🚀 Starting rollback..."));

      const rollbackResponse = await performRollback(
        ecs,
        cluster,
        service.serviceName,
        targetRevision.taskDefinition,
        true, // quiet mode
      );

      // Step 7: Show rollback status
      console.log(chalk.green.bold("\n✅ Rollback initiated successfully!"));
      console.log(chalk.dim("─".repeat(50)));
      console.log(`🎯 Service: ${chalk.bold(service.serviceName)}`);
      console.log(
        `📦 Task Definition: ${chalk.bold(targetRevision.taskDefinition)}`,
      );
      console.log(
        `🔄 Deployment ID: ${chalk.dim(rollbackResponse.service.deployments[0]?.id || "N/A")}`,
      );
      console.log(
        `📊 Status: ${chalk.yellow(rollbackResponse.service.deployments[0]?.status || "N/A")}`,
      );

      console.log(
        chalk.blue(
          "\n💡 Pro tip: Monitor the deployment in the AWS Console or use AWS CLI to check status:",
        ),
      );
      console.log(
        chalk.dim(
          `   aws ecs describe-services --cluster ${cluster} --services ${service.serviceName}`,
        ),
      );
    } catch (err) {
      console.error(chalk.red("Rollback failed: " + err.message));
      process.exit(1);
    }
  });

program
  .command("prune")
  .description("Clean up unused task definition revisions")
  .addHelpText("after", chalk.dim("Example: taskonaut prune"))
  .action(async () => {
    try {
      console.log(chalk.cyan.bold("🗑️  Task Definition Pruning"));
      console.log(
        chalk.dim(
          `Clean up old task definition revisions while keeping the latest ${KEEP_LATEST_COUNT} and protecting in-use revisions.\n`,
        ),
      );

      const ecs = await initAWS();

      // Step 1: Select task definition family
      console.log(chalk.blue.bold("Step 1: Select Task Definition Family\n"));
      const family = await selectTaskDefinitionFamily(ecs);
      console.log(chalk.green(`📦 Selected family: ${chalk.bold(family)}\n`));

      // Step 2: Optionally select cluster to check service usage
      console.log(chalk.blue.bold("Step 2: Check Service Usage (Optional)\n"));
      const checkUsageResponse = await prompts(
        {
          type: "confirm",
          name: "checkUsage",
          message: chalk.blue(
            "Do you want to check which revisions are in use by services in a specific cluster?",
          ),
          initial: true,
        },
        {
          onCancel: () => {
            logger.info(chalk.dim("\nOperation cancelled"));
            process.exit(0);
          },
        },
      );

      let cluster = null;
      if (checkUsageResponse.checkUsage) {
        const clusters = await listClusters(ecs, true);
        if (clusters && clusters.length > 0) {
          const clusterChoices = clusters.map((c) => ({
            title: `${chalk.green(c.clusterName)} ${chalk.yellow(
              `(${c.servicesCount} services)`,
            )}`,
            value: c.clusterName,
          }));

          const clusterResponse = await prompts(
            {
              type: "select",
              name: "cluster",
              message: chalk.blue("Select cluster to check service usage:"),
              choices: clusterChoices,
            },
            {
              onCancel: () => {
                logger.info(chalk.dim("\nOperation cancelled"));
                process.exit(0);
              },
            },
          );

          if (wasPromptCancelled(clusterResponse, "cluster")) {
            cancelOperation();
          }

          cluster = clusterResponse.cluster;
          if (cluster) {
            console.log(
              chalk.green(
                `📍 Checking usage in cluster: ${chalk.bold(cluster)}\n`,
              ),
            );
          }
        }
      } else {
        console.log(
          chalk.yellow(
            "⚠️  Skipping service usage check. Only latest revision will be protected.\n",
          ),
        );
      }

      // Step 3: Analyze revisions
      console.log(chalk.blue.bold("Step 3: Analyzing Revisions\n"));
      const analysis = await analyzeTaskDefinitionRevisions(
        ecs,
        family,
        cluster,
        false,
      );

      if (analysis.revisions.length === 0) {
        console.log(chalk.yellow("No revisions found for this family"));
        return;
      }

      console.log(
        chalk.green(`✅ Found ${analysis.revisions.length} revisions\n`),
      );

      // Show protection summary
      console.log(chalk.blue.bold("Protection Summary:"));
      console.log(chalk.dim("─".repeat(60)));
      console.log(
        `  Total revisions: ${chalk.bold(analysis.revisions.length)}`,
      );
      console.log(`  Latest revision: ${chalk.bold(analysis.latest)}`);
      console.log(
        `  Protected: ${chalk.bold(analysis.protected.length)} (latest${cluster ? " + in-use" : ""})`,
      );
      console.log(
        `  Latest ${KEEP_LATEST_COUNT} (always kept): ${chalk.cyan(
          analysis.revisions
            .slice(0, KEEP_LATEST_COUNT)
            .map((r) => r.revision)
            .join(", "),
        )}`,
      );

      if (analysis.protected.length > 0) {
        console.log(
          chalk.green("\n  Protected revisions (cannot be deleted):"),
        );
        analysis.protected.forEach((r) => {
          const reason = r.isLatest
            ? "latest revision"
            : r.isInUse
              ? "in use by services"
              : "protected";
          console.log(`    • Revision ${r.revision} - ${reason}`);
        });
      }

      const eligibleCount = analysis.revisions.filter(
        (r) => !r.isProtected && !r.isInLatest5,
      ).length;
      console.log(
        chalk.yellow(
          `\n  Eligible for deletion: ${chalk.bold(eligibleCount)} revisions`,
        ),
      );
      console.log(chalk.dim("─".repeat(60) + "\n"));

      if (eligibleCount === 0) {
        console.log(
          chalk.yellow("\n⚠️  No revisions available for deletion.\n"),
        );
        console.log(chalk.dim("Reasons:"));
        if (analysis.revisions.length <= KEEP_LATEST_COUNT) {
          console.log(
            chalk.dim(
              `  • Only ${analysis.revisions.length} revision(s) exist, and the latest ${KEEP_LATEST_COUNT} are always kept`,
            ),
          );
        } else {
          console.log(
            chalk.dim(
              `  • All ${analysis.revisions.length} revisions are protected or within the latest ${KEEP_LATEST_COUNT}:`,
            ),
          );
          console.log(
            chalk.dim(
              `    - Latest revision: ${analysis.latest} (always protected)`,
            ),
          );
          if (analysis.protected.length > 1) {
            console.log(
              chalk.dim(
                `    - ${analysis.protected.length - 1} revision(s) in use by services`,
              ),
            );
          }
        }
        console.log(
          chalk.dim(
            `\n💡 Tip: To delete revisions, they must be deregistered (INACTIVE) and not in use by services.`,
          ),
        );
        return;
      }

      // Step 4: Manual selection
      console.log(chalk.blue.bold("Step 4: Select Revisions to Delete\n"));
      console.log(
        chalk.dim(
          `Protected revisions and the latest ${KEEP_LATEST_COUNT} are excluded from every option below.\n`,
        ),
      );

      const selectedRevisions = await selectRevisionsToDelete(
        analysis.revisions,
      );

      if (selectedRevisions.length === 0) {
        console.log(
          chalk.yellow("No revisions selected for deletion. Exiting."),
        );
        return;
      }

      // Step 5: Generate and display deletion plan
      console.log(chalk.blue.bold("\n\nStep 5: Deletion Plan Preview\n"));
      const plan = generateDeletionPlan(analysis.revisions, selectedRevisions);

      console.log(chalk.blue.bold("🔍 Deletion Plan:"));
      console.log(chalk.dim("─".repeat(60)));
      console.log(`📊 Statistics:`);
      console.log(`   Total revisions: ${chalk.bold(plan.total)}`);
      console.log(
        `   Protected: ${chalk.green(plan.protected)} (will NOT be deleted)`,
      );
      console.log(`   Will keep: ${chalk.cyan(plan.kept)}`);
      console.log(
        `   Will deregister: ${chalk.yellow(plan.willDeregister)} (ACTIVE → INACTIVE)`,
      );
      console.log(
        `   Will delete: ${chalk.red(plan.willDelete)} (INACTIVE → DELETED)`,
      );

      if (plan.protectedRevisions.length > 0) {
        console.log(
          chalk.green("\n⚠️  Protected Revisions (will NOT be deleted):"),
        );
        plan.protectedRevisions.forEach((r) => {
          const reason = r.isLatest
            ? "Latest revision"
            : r.isInUse
              ? "In use by services"
              : "Protected";
          console.log(`   • Revision ${r.revision} - ${reason}`);
        });
      }

      if (plan.willDeregister > 0) {
        console.log(chalk.yellow("\n🔄 Will Deregister (ACTIVE → INACTIVE):"));
        plan.deregisterRevisions.forEach((r) => {
          console.log(
            `   • Revision ${r.revision} (${new Date(r.createdAt).toLocaleDateString()})`,
          );
        });
      }

      if (plan.willDelete > 0) {
        console.log(chalk.red("\n🗑️  Will Delete (INACTIVE → DELETED):"));
        plan.deleteRevisions.forEach((r) => {
          console.log(
            `   • Revision ${r.revision} (${new Date(r.createdAt).toLocaleDateString()})`,
          );
        });
      }

      console.log(chalk.dim("─".repeat(60)));

      // Step 6: Type-to-confirm
      console.log(chalk.blue.bold("\n\nStep 6: Confirmation\n"));

      const typeConfirmResponse = await prompts(
        {
          type: "text",
          name: "familyName",
          message: chalk.yellow(
            `⚠️  Type the task definition family name to confirm: ${chalk.bold(family)}`,
          ),
          validate: (value) =>
            value === family ? true : `Please type exactly: ${family}`,
        },
        {
          onCancel: () => {
            logger.info(chalk.dim("\nOperation cancelled"));
            process.exit(0);
          },
        },
      );

      if (
        wasPromptCancelled(typeConfirmResponse, "familyName") ||
        typeConfirmResponse.familyName !== family
      ) {
        console.log(chalk.dim("Confirmation failed. Operation cancelled."));
        return;
      }

      // Final confirmation
      const finalConfirmResponse = await prompts(
        {
          type: "confirm",
          name: "confirm",
          message: chalk.red(
            `⚠️  FINAL CONFIRMATION: Delete ${selectedRevisions.length} revision(s) from ${family}?`,
          ),
          initial: false,
        },
        {
          onCancel: () => {
            logger.info(chalk.dim("\nOperation cancelled"));
            process.exit(0);
          },
        },
      );

      if (
        wasPromptCancelled(finalConfirmResponse, "confirm") ||
        !finalConfirmResponse.confirm
      ) {
        console.log(chalk.dim("Operation cancelled by user"));
        return;
      }

      // Step 7: Execute pruning
      console.log(chalk.blue.bold("\n\nStep 7: Executing Deletion\n"));
      const results = await performPruning(ecs, selectedRevisions);

      // Step 8: Show results summary
      console.log(chalk.green.bold("\n\n✅ Pruning Operation Complete!\n"));
      console.log(chalk.dim("─".repeat(60)));
      console.log(`📊 Results Summary:`);

      if (results.deregister.success.length > 0) {
        console.log(
          chalk.green(
            `   ✅ Deregistered: ${results.deregister.success.length} revisions`,
          ),
        );
      }

      if (results.deregister.failed.length > 0) {
        console.log(
          chalk.red(
            `   ❌ Failed to deregister: ${results.deregister.failed.length} revisions`,
          ),
        );
        results.deregister.failed.forEach((f) => {
          console.log(chalk.dim(`      • ${f.arn}: ${f.error}`));
        });
      }

      if (results.delete.success.length > 0) {
        console.log(
          chalk.green(
            `   ✅ Deleted: ${results.delete.success.length} revisions`,
          ),
        );
      }

      if (results.delete.failed.length > 0) {
        console.log(
          chalk.red(
            `   ❌ Failed to delete: ${results.delete.failed.length} revisions`,
          ),
        );
        results.delete.failed.forEach((f) => {
          console.log(chalk.dim(`      • ${f.arn}: ${f.error}`));
        });
      }

      console.log(chalk.dim("─".repeat(60)));

      // Calculate unique revisions processed
      // The delete.success count is the actual number of revisions removed
      const revisionsDeleted = results.delete.success.length;
      const revisionsFailed =
        results.deregister.failed.length + results.delete.failed.length;

      if (revisionsFailed === 0) {
        console.log(
          chalk.green.bold(
            `\n🎉 Successfully cleaned up ${revisionsDeleted} task definition revision(s)!`,
          ),
        );
      } else {
        console.log(
          chalk.yellow(
            `\n⚠️  Completed: ${revisionsDeleted} cleaned up, ${revisionsFailed} failed`,
          ),
        );
      }

      console.log(
        chalk.blue(
          "\n💡 Pro tip: You can verify the results in the AWS Console or use:",
        ),
      );
      console.log(
        chalk.dim(
          `   aws ecs list-task-definitions --family-prefix ${family} --status ACTIVE`,
        ),
      );
    } catch (err) {
      console.error(chalk.red("Pruning failed: " + err.message));
      process.exit(1);
    }
  });

/**
 * True when this file was executed directly rather than imported.
 * @returns {boolean}
 */
function isMainModule() {
  return (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

if (isMainModule()) {
  printBanner();
  program.parse();
}

// Exported for unit tests. The CLI surface is the `program` above; these are the
// pure helpers whose behaviour the destructive commands depend on.
export {
  chunk,
  computeDeletionBuckets,
  extractProfileNamesFromConfig,
  getActiveProfile,
  getActiveRegion,
  generateDeletionPlan,
  mapWithConcurrency,
  paginate,
  parseFamilyFromArn,
  parseImageTag,
  parseRevisionFromArn,
  DESCRIBE_SERVICES_BATCH_SIZE,
  DESCRIBE_TASKS_BATCH_SIZE,
  KEEP_LATEST_COUNT,
};
