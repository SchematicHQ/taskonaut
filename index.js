#!/usr/bin/env node

import { ECS } from "@aws-sdk/client-ecs";
import { fromIni } from "@aws-sdk/credential-providers";
import { Command } from "commander";
import inquirer from "inquirer";
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
import ini from "ini";

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
console.log(
  pastel.multiline(
    figlet.textSync("taskonaut", {
      font: "ANSI Shadow",
      horizontalLayout: "full",
    }),
  ),
);

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
 * Parses AWS profiles from credentials and config files.
 * @returns {string[]} Array of AWS profile names.
 */
function parseAwsProfiles() {
  const profiles = new Set();

  const credentialsPath = path.join(os.homedir(), ".aws", "credentials");
  if (fs.existsSync(credentialsPath)) {
    try {
      const content = fs.readFileSync(credentialsPath, "utf-8");
      const parsed = ini.parse(content);
      Object.keys(parsed).forEach((profile) => profiles.add(profile));
    } catch (err) {
      logger.error(chalk.red(`Error parsing credentials file: ${err.message}`));
    }
  }

  const configPath = path.join(os.homedir(), ".aws", "config");
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, "utf-8");
      const parsed = ini.parse(content);
      Object.keys(parsed).forEach((profile) => {
        const profileName = profile.replace("profile ", "");
        profiles.add(profileName);
      });
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
  const spinner = ora("Syncing AWS profiles...").start();
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
  if (Date.now() - lastSync > SYNC_INTERVAL) {
    return await syncAwsProfiles();
  }
  return config.get("awsProfiles");
}

// ---------------------------------------------------------------------------
// AWS ECS Client Initialization
// ---------------------------------------------------------------------------

/**
 * Initializes the AWS ECS client with the selected profile and region.
 * @returns {Promise<ECS>} An instance of the AWS ECS client.
 */
const initAWS = async () => {
  try {
    const profiles = await getAwsProfiles();
    const currentProfile = config.get("awsProfile");
    if (!profiles.includes(currentProfile)) {
      logger.warn(
        chalk.yellow(`Profile ${currentProfile} not found, please reconfigure`),
      );
      throw new Error("Invalid AWS profile");
    }
    const region = config.get("awsRegion");
    logger.info(
      chalk.dim(`Using AWS Profile: ${currentProfile} and Region: ${region}`),
    );
    const credentials = await fromIni({ profile: currentProfile })();
    return new ECS({ region, credentials });
  } catch (err) {
    logger.error(chalk.red(err.message));
    throw err;
  }
};

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
  try {
    const spinner = quiet ? null : ora("Fetching clusters...").start();
    const { clusterArns } = await ecs.listClusters({});
    if (spinner) spinner.succeed("Clusters fetched");

    if (!clusterArns || clusterArns.length === 0) {
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
          const servicesResult = await ecs.listServices({
            cluster: clusterName,
          });
          servicesCount = servicesResult.serviceArns
            ? servicesResult.serviceArns.length
            : 0;
        } catch (err) {
          logger.error(
            chalk.red(
              `Error fetching services for cluster ${clusterName}: ${err.message}`,
            ),
          );
        }

        try {
          const tasksResult = await ecs.listTasks({ cluster: clusterName });
          tasksCount = tasksResult.taskArns ? tasksResult.taskArns.length : 0;
        } catch (err) {
          logger.error(
            chalk.red(
              `Error fetching tasks for cluster ${clusterName}: ${err.message}`,
            ),
          );
        }

        try {
          const containerInstancesResult = await ecs.listContainerInstances({
            cluster: clusterName,
          });
          containerInstancesCount =
            containerInstancesResult.containerInstanceArns
              ? containerInstancesResult.containerInstanceArns.length
              : 0;
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
    logger.error(chalk.red(err.message));
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
    logger.info(chalk.dim("Operation cancelled"));
    process.exit(0);
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
  try {
    const spinner = ora("Fetching tasks...").start();
    const { taskArns } = await ecs.listTasks({ cluster });

    if (!taskArns || taskArns.length === 0) {
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
          logger.info(chalk.dim("Operation cancelled"));
          process.exit(0);
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

    const { tasks } = await ecs.describeTasks({
      cluster,
      tasks: taskArns,
    });

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
      logger.info(chalk.dim("Operation cancelled"));
      process.exit(0);
    }

    return taskResponse.taskArn;
  } catch (err) {
    logger.error(chalk.red(err.message));
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
  try {
    const { tasks } = await ecs.describeTasks({
      cluster,
      tasks: [taskArn],
    });

    if (!tasks || tasks.length === 0) {
      throw new Error("Task not found");
    }

    return tasks[0];
  } catch (err) {
    logger.error(chalk.red(err.message));
    throw err;
  }
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
  const task = await getTaskDetails(ecs, cluster, taskArn);
  const containers = task.containers;
  spinner.succeed("Container details fetched");

  let choices = [];

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
    logger.info(chalk.dim("Operation cancelled"));
    process.exit(0);
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
async function executeCommand(cluster, taskArn, containerName) {
  return new Promise((resolve, reject) => {
    logger.info(chalk.dim("Starting shell session..."));

    const childProcess = spawn(
      "aws",
      [
        "ecs",
        "execute-command",
        "--profile",
        config.get("awsProfile"),
        "--region",
        config.get("awsRegion"),
        "--cluster",
        cluster,
        "--task",
        taskArn,
        "--container",
        containerName,
        "--command",
        "/bin/sh",
        "--interactive",
      ],
      {
        stdio: "inherit",
      },
    );

    const signals = ["SIGINT", "SIGTERM", "SIGQUIT"];
    const signalHandlers = {};

    const cleanup = () => {
      logger.info(chalk.yellow("📤 Cleaning up ECS session..."));
      childProcess.kill("SIGTERM");
      signals.forEach((signal) => {
        process.removeListener(signal, signalHandlers[signal]);
      });
    };

    signals.forEach((signal) => {
      signalHandlers[signal] = () => cleanup();
      process.on(signal, signalHandlers[signal]);
    });

    childProcess.on("error", (err) => {
      logger.error(chalk.red(err.message));
      cleanup();
      reject(err);
    });

    childProcess.on("exit", (code) => {
      signals.forEach((signal) => {
        process.removeListener(signal, signalHandlers[signal]);
      });
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
  try {
    const spinner = quiet ? null : ora("Fetching services...").start();
    const { serviceArns } = await ecs.listServices({ cluster });
    if (spinner) spinner.text = "Fetching service details...";

    if (!serviceArns || serviceArns.length === 0) {
      if (spinner) spinner.warn("No services found");
      return [];
    }

    const { services } = await ecs.describeServices({
      cluster,
      services: serviceArns,
    });

    if (spinner) spinner.succeed("Services fetched");

    return services.map((service) => {
      const taskDefParts = service.taskDefinition.split("/").pop().split(":");
      const family = taskDefParts[0];
      const revision = parseInt(taskDefParts[1]);

      return {
        serviceName: service.serviceName,
        serviceArn: service.serviceArn,
        taskDefinition: service.taskDefinition,
        taskDefinitionFamily: family,
        revision: revision,
        status: service.status,
        desiredCount: service.desiredCount,
        runningCount: service.runningCount,
      };
    });
  } catch (err) {
    logger.error(chalk.red(err.message));
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
  try {
    const spinner = quiet
      ? null
      : ora("Fetching task definition revisions...").start();
    const { taskDefinitionArns } = await ecs.listTaskDefinitions({
      familyPrefix: family,
      status: "ACTIVE",
      sort: "DESC",
    });

    if (!taskDefinitionArns || taskDefinitionArns.length === 0) {
      if (spinner) spinner.warn("No task definitions found");
      return [];
    }

    // Get detailed info for each task definition
    const revisions = await Promise.all(
      taskDefinitionArns.map(async (arn) => {
        try {
          const { taskDefinition } = await ecs.describeTaskDefinition({
            taskDefinition: arn,
          });
          const revision = parseInt(arn.split(":").pop());
          return {
            taskDefinition: arn,
            revision: revision,
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

    if (spinner) spinner.succeed("Task definition revisions fetched");
    return revisions.filter(Boolean).sort((a, b) => b.revision - a.revision);
  } catch (err) {
    logger.error(chalk.red(err.message));
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
  try {
    const spinner = quiet ? null : ora("Comparing task definitions...").start();

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

    currentImages.forEach((currentContainer) => {
      const targetContainer = targetImages.find(
        (t) => t.name === currentContainer.name,
      );
      if (targetContainer && currentContainer.image !== targetContainer.image) {
        differences.push({
          type: "image",
          container: currentContainer.name,
          current: currentContainer.image,
          target: targetContainer.image,
        });
      }
    });

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
    logger.error(chalk.red(err.message));
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
  try {
    const spinner = quiet
      ? null
      : ora("Initiating service rollback...").start();

    const response = await ecs.updateService({
      cluster,
      service: serviceName,
      taskDefinition: taskDefinitionArn,
    });

    if (spinner) spinner.succeed("Rollback initiated successfully");
    return response;
  } catch (err) {
    logger.error(chalk.red(err.message));
    throw err;
  }
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
  } catch (err) {
    logger.error(chalk.red(err.message));
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
  } catch (err) {
    logger.error(chalk.red(err.message));
    return false;
  }
}

/**
 * Checks if AWS credentials are configured.
 * @returns {boolean} True if configured, false otherwise.
 */
function checkAwsCredentials() {
  const credentialsPath = path.join(os.homedir(), ".aws", "credentials");
  const configPath = path.join(os.homedir(), ".aws", "config");
  return fs.existsSync(credentialsPath) || fs.existsSync(configPath);
}

/**
 * Checks if the configured AWS profile is valid.
 * @returns {boolean} True if valid, false otherwise.
 */
function checkAwsProfileConfigured() {
  const profiles = config.get("awsProfiles");
  const currentProfile = config.get("awsProfile");
  return profiles.includes(currentProfile);
}

/**
 * Performs diagnostics to check environment setup.
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
      chalk.red(
        `❌ AWS profile '${config.get("awsProfile")}' is not configured.`,
      ),
    );
    allGood = false;
  } else {
    logger.info(
      chalk.green(
        `✅ AWS profile '${config.get("awsProfile")}' is configured.`,
      ),
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
}

// ---------------------------------------------------------------------------
// CLI Program Setup using Commander
// ---------------------------------------------------------------------------
const program = new Command();

program
  .name(chalk.cyan("taskonaut"))
  .description(
    chalk.yellow("✨ Interactive ECS task executor and rollback tool"),
  )
  .addHelpText("after", chalk.dim("Example: taskonaut "))
  .action(async () => {
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
          await executeCommand(cluster, taskArn, containerName);
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

          const { profile } = await inquirer.prompt([
            {
              type: "list",
              name: "profile",
              message: chalk.blue("Select AWS Profile:"),
              prefix: "🔑",
              choices: profiles.map((p) => ({
                name: chalk.green(p),
                value: p,
              })),
              default: config.get("awsProfile"),
            },
          ]);

          const { region } = await inquirer.prompt([
            {
              type: "list",
              name: "region",
              message: chalk.blue("Select AWS Region:"),
              prefix: "🌎",
              choices: AWS_REGIONS.map((r) => ({
                name: chalk.green(r),
                value: r,
              })),
              default: config.get("awsRegion"),
            },
          ]);

          config.set("awsProfile", profile);
          config.set("awsRegion", region);

          logger.info(chalk.green("✨ Configuration saved successfully!"));
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
          const { confirm } = await inquirer.prompt([
            {
              type: "confirm",
              name: "confirm",
              message: chalk.yellow(
                "⚠️  Are you sure you want to remove all stored configuration?",
              ),
              default: false,
            },
          ]);

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
      await performDiagnostics();
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
          const imageTag = img.image.includes(":")
            ? img.image.split(":").pop()
            : "latest";
          console.log(`  🐳 ${chalk.cyan(img.name)}: ${chalk.dim(imageTag)}`);
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
          const imageTag = img.image.includes(":")
            ? img.image.split(":").pop()
            : "latest";
          console.log(`  🐳 ${chalk.cyan(img.name)}: ${chalk.dim(imageTag)}`);
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

program.parse();
