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
// Task Definition Pruning Functions
// ---------------------------------------------------------------------------

/**
 * Sleep/delay utility function.
 * @param {number} ms - Milliseconds to sleep.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
      if (err.name === 'ThrottlingException' || err.message.includes('Rate exceeded')) {
        retryCount++;
        if (retryCount > maxRetries) {
          throw new Error(`Rate limit exceeded after ${maxRetries} retries. Please try again later.`);
        }

        // Exponential backoff: 1s, 2s, 4s, 8s, 16s
        const backoffMs = Math.min(1000 * Math.pow(2, retryCount - 1), 16000);

        // Update spinner instead of logging to avoid cluttering output
        if (spinner) {
          spinner.text = chalk.yellow(`⚠️  Rate limit, pausing ${backoffMs / 1000}s... (${retryCount}/${maxRetries})`);
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
  try {
    const spinner = quiet ? null : ora({
      text: "Fetching task definition families...",
      spinner: "dots",
    }).start();

    const taskDefinitionArns = await fetchAllTaskDefinitions(ecs, { sort: "DESC" }, spinner);

    if (!taskDefinitionArns || taskDefinitionArns.length === 0) {
      if (spinner) spinner.warn("No task definitions found");
      return [];
    }

    // Extract unique families from ARNs
    const familyMap = new Map();

    for (const arn of taskDefinitionArns) {
      const parts = arn.split("/").pop().split(":");
      const family = parts[0];
      const revision = parseInt(parts[1]);

      if (!familyMap.has(family)) {
        familyMap.set(family, {
          family,
          latestRevision: revision,
          revisions: [revision],
        });
      } else {
        const familyData = familyMap.get(family);
        familyData.revisions.push(revision);
        if (revision > familyData.latestRevision) {
          familyData.latestRevision = revision;
        }
      }
    }

    // Get detailed status for each family
    const families = await Promise.all(
      Array.from(familyMap.values()).map(async (familyData) => {
        try {
          const familyArns = await fetchAllTaskDefinitions(ecs, {
            familyPrefix: familyData.family,
            sort: "DESC",
          });

          let activeCount = 0;
          let inactiveCount = 0;

          // Check status of first 100 revisions for count estimates (to avoid too many API calls)
          const sampleSize = Math.min(familyArns.length, 100);
          const revisionStatuses = await Promise.all(
            familyArns.slice(0, sampleSize).map(async (arn) => {
              try {
                const { taskDefinition } = await ecs.describeTaskDefinition({
                  taskDefinition: arn,
                  include: ["TAGS"],
                });
                return taskDefinition.status;
              } catch {
                // Silently skip failed describe calls - they'll be excluded from counts
                return null;
              }
            })
          );

          revisionStatuses.forEach((status) => {
            if (status === "ACTIVE") activeCount++;
            else if (status === "INACTIVE") inactiveCount++;
          });

          // Extrapolate counts if we only sampled
          if (familyArns.length > sampleSize) {
            const ratio = familyArns.length / sampleSize;
            activeCount = Math.round(activeCount * ratio);
            inactiveCount = Math.round(inactiveCount * ratio);
          }

          return {
            family: familyData.family,
            revisionCount: familyArns.length,
            latestRevision: familyData.latestRevision,
            activeCount,
            inactiveCount,
          };
        } catch {
          // Silently skip failed family details - they'll be filtered out
          return null;
        }
      })
    );

    if (spinner) spinner.succeed("Task definition families fetched");
    return families.filter(Boolean).sort((a, b) => b.revisionCount - a.revisionCount);
  } catch (err) {
    logger.error(chalk.red(err.message));
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
async function analyzeTaskDefinitionRevisions(ecs, family, cluster = null, quiet = false) {
  try {
    const spinner = quiet ? null : ora({
      text: "Analyzing task definition revisions...",
      spinner: "dots",
      color: "cyan",
    }).start();

    // Get all revisions for this family with pagination
    const taskDefinitionArns = await fetchAllTaskDefinitions(
      ecs,
      {
        familyPrefix: family,
        sort: "DESC",
      },
      spinner
    );

    if (!taskDefinitionArns || taskDefinitionArns.length === 0) {
      if (spinner) spinner.warn("No revisions found");
      return { revisions: [], protected: [], inUse: new Set(), latest: 0 };
    }

    if (spinner) spinner.text = `Found ${taskDefinitionArns.length} revisions, analyzing...`;

    // Find revisions in use by services
    const inUseRevisions = new Set();

    if (cluster) {
      try {
        const services = await listServices(ecs, cluster, true);
        services.forEach((service) => {
          inUseRevisions.add(service.taskDefinition);
        });
      } catch (err) {
        logger.warn(chalk.yellow(`Could not check service usage: ${err.message}`));
      }
    }

    // Get detailed info for each revision (in batches to avoid rate limits)
    if (spinner) spinner.text = `Fetching details for ${taskDefinitionArns.length} revisions...`;

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
                const isInLatest5 = index < 5;

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
                  containerImages: taskDefinition.containerDefinitions.map(c => ({
                    name: c.name,
                    image: c.image,
                  })),
                };
              } catch (err) {
                if (err.name === 'ThrottlingException' || err.message.includes('Rate exceeded')) {
                  throw err; // Propagate to batch retry logic
                }
                // Silently skip failed describe calls - they'll be filtered out
                return null;
              }
            })
          );

          // Success - break retry loop
          break;
        } catch (err) {
          if (err.name === 'ThrottlingException' || err.message.includes('Rate exceeded')) {
            retryCount++;
            if (retryCount > maxRetries) {
              throw new Error(`Rate limit exceeded after ${maxRetries} retries on batch ${i / BATCH_SIZE + 1}. Please try again later.`);
            }

            // Exponential backoff
            const backoffMs = Math.min(2000 * Math.pow(2, retryCount - 1), 10000);
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
    const protectedRevisions = revisions.filter(r => r.isProtected);

    if (spinner) spinner.succeed(`Analysis complete: ${revisions.length} revisions loaded`);

    return {
      revisions,
      protected: protectedRevisions,
      inUse: inUseRevisions,
      latest,
    };
  } catch (err) {
    logger.error(chalk.red(err.message));
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
    const cleanupAvailable = f.revisionCount > 5;

    const statusBadge = hasInactive
      ? chalk.yellow(`${f.inactiveCount} inactive`)
      : chalk.green("all active");

    const cleanupBadge = cleanupAvailable
      ? chalk.cyan(` [${f.revisionCount - 5} beyond latest 5]`)
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
            (choice.description && choice.description.toLowerCase().includes(inputLower))
        );
      },
    },
    {
      onCancel: () => {
        logger.info(chalk.dim("\nOperation cancelled"));
        process.exit(0);
      },
    }
  );

  if (wasPromptCancelled(response, "family")) {
    logger.info(chalk.dim("Operation cancelled"));
    process.exit(0);
  }

  return response.family;
}

/**
 * Prompts user to select revisions to delete with smart bulk selection options.
 * @param {Array} revisions - Array of revision objects from analyzeTaskDefinitionRevisions.
 * @returns {Promise<Array>} Selected revision objects.
 */
async function selectRevisionsToDelete(revisions) {
  const eligible = revisions.filter(r => !r.isProtected);
  const inactiveBeyondLatest5 = revisions.filter(r => !r.isProtected && !r.isInLatest5 && r.status === "INACTIVE");

  // Calculate age-based counts
  const now = new Date();
  const revisionsByAge = {
    "30days": revisions.filter(r => !r.isProtected && (now - new Date(r.createdAt)) > 30 * 24 * 60 * 60 * 1000),
    "90days": revisions.filter(r => !r.isProtected && (now - new Date(r.createdAt)) > 90 * 24 * 60 * 60 * 1000),
    "180days": revisions.filter(r => !r.isProtected && (now - new Date(r.createdAt)) > 180 * 24 * 60 * 60 * 1000),
    "365days": revisions.filter(r => !r.isProtected && (now - new Date(r.createdAt)) > 365 * 24 * 60 * 60 * 1000),
  };

  console.log(chalk.blue("\n📋 Selection Options:\n"));

  const selectionChoices = [
    {
      title: chalk.green(`All INACTIVE revisions beyond latest 5 (${inactiveBeyondLatest5.length} revisions)`),
      description: "Recommended: Safe bulk deletion of unused, inactive revisions",
      value: "inactive_beyond_5",
      disabled: inactiveBeyondLatest5.length === 0,
    },
    {
      title: chalk.yellow(`All revisions beyond latest 10 (${revisions.filter(r => !r.isProtected && revisions.indexOf(r) >= 10).length} revisions)`),
      description: "Keep more history, delete everything else",
      value: "beyond_10",
      disabled: revisions.filter(r => !r.isProtected && revisions.indexOf(r) >= 10).length === 0,
    },
    {
      title: chalk.cyan(`Revisions older than 30 days (${revisionsByAge["30days"].length} revisions)`),
      description: "Age-based cleanup",
      value: "age_30",
      disabled: revisionsByAge["30days"].length === 0,
    },
    {
      title: chalk.cyan(`Revisions older than 90 days (${revisionsByAge["90days"].length} revisions)`),
      description: "Age-based cleanup",
      value: "age_90",
      disabled: revisionsByAge["90days"].length === 0,
    },
    {
      title: chalk.cyan(`Revisions older than 180 days (${revisionsByAge["180days"].length} revisions)`),
      description: "Age-based cleanup",
      value: "age_180",
      disabled: revisionsByAge["180days"].length === 0,
    },
    {
      title: chalk.cyan(`Revisions older than 1 year (${revisionsByAge["365days"].length} revisions)`),
      description: "Age-based cleanup",
      value: "age_365",
      disabled: revisionsByAge["365days"].length === 0,
    },
    {
      title: chalk.magenta("Manual selection (checkbox list)"),
      description: `Choose specific revisions from ${eligible.length} eligible`,
      value: "manual",
      disabled: eligible.length === 0,
    },
    {
      title: chalk.red("Custom: Select by revision number range"),
      description: "Specify exact revision range to delete",
      value: "range",
    },
  ];

  const methodResponse = await prompts(
    {
      type: "select",
      name: "method",
      message: chalk.blue("How would you like to select revisions to delete?"),
      choices: selectionChoices,
    },
    {
      onCancel: () => {
        logger.info(chalk.dim("\nOperation cancelled"));
        process.exit(0);
      },
    }
  );

  if (wasPromptCancelled(methodResponse, "method")) {
    logger.info(chalk.dim("Operation cancelled"));
    return [];
  }

  let selected = [];

  switch (methodResponse.method) {
    case "inactive_beyond_5":
      selected = inactiveBeyondLatest5;
      break;

    case "beyond_10":
      selected = revisions.filter(r => !r.isProtected && revisions.indexOf(r) >= 10);
      break;

    case "age_30":
      selected = revisionsByAge["30days"];
      break;

    case "age_90":
      selected = revisionsByAge["90days"];
      break;

    case "age_180":
      selected = revisionsByAge["180days"];
      break;

    case "age_365":
      selected = revisionsByAge["365days"];
      break;

    case "range": {
      const rangeResponse = await prompts(
        [
          {
            type: "number",
            name: "from",
            message: chalk.blue("Delete from revision number:"),
            validate: value => value > 0 || "Must be a positive number",
          },
          {
            type: "number",
            name: "to",
            message: chalk.blue("Delete to revision number (inclusive):"),
            validate: value => value > 0 || "Must be a positive number",
          },
        ],
        {
          onCancel: () => {
            logger.info(chalk.dim("\nOperation cancelled"));
            process.exit(0);
          },
        }
      );

      if (wasPromptCancelled(rangeResponse, "from") || wasPromptCancelled(rangeResponse, "to")) {
        logger.info(chalk.dim("Operation cancelled"));
        return [];
      }

      if (rangeResponse.from && rangeResponse.to) {
        const from = Math.min(rangeResponse.from, rangeResponse.to);
        const to = Math.max(rangeResponse.from, rangeResponse.to);

        selected = revisions.filter(r => !r.isProtected && r.revision >= from && r.revision <= to);

        if (selected.length === 0) {
          logger.warn(chalk.yellow(`No revisions found in range ${from}-${to}`));
          return [];
        }
      } else {
        logger.info(chalk.dim("Operation cancelled"));
        return [];
      }
      break;
    }

    case "manual": {
      // For manual selection, limit to showing first 100 eligible revisions to avoid overwhelming the UI
      const revisionsToShow = eligible.slice(0, 100);

      if (eligible.length > 100) {
        console.log(chalk.yellow(`\n⚠️  Showing first 100 of ${eligible.length} eligible revisions. Consider using bulk options instead.\n`));
      }

      const choices = revisionsToShow.map((rev) => {
        const date = new Date(rev.createdAt).toLocaleDateString();
        const size = (rev.size / 1024).toFixed(1);

        let statusBadge = "";
        let reasonBadge = "";

        if (rev.isInLatest5) {
          statusBadge = chalk.cyan("KEEP");
          reasonBadge = chalk.dim(" (within latest 5)");
        } else if (rev.status === "INACTIVE") {
          statusBadge = chalk.yellow("INACTIVE");
          reasonBadge = chalk.red(" ← suggested");
        } else {
          statusBadge = chalk.green("ACTIVE");
        }

        return {
          name: `Revision ${rev.revision} - ${statusBadge} - ${date}, ${size} KB${reasonBadge}`,
          value: rev,
          checked: !rev.isInLatest5 && rev.status === "INACTIVE",
        };
      });

      const manualResponse = await inquirer.prompt([
        {
          type: "checkbox",
          name: "selected",
          message: chalk.blue("Select revisions to delete (Space to toggle, Enter to confirm):"),
          prefix: "🗑️ ",
          choices,
          pageSize: 20,
          loop: false,
        },
      ]);

      selected = manualResponse.selected || [];
      break;
    }

    default:
      logger.warn(chalk.yellow("Unknown selection method"));
      return [];
  }

  if (selected.length === 0) {
    logger.info(chalk.yellow("No revisions selected"));
    return [];
  }

  console.log(chalk.green(`\n✅ Selected ${selected.length} revision(s) for deletion\n`));
  return selected;
}

/**
 * Generates a detailed deletion plan preview.
 * @param {Array} allRevisions - All revisions.
 * @param {Array} selectedRevisions - Selected revisions to delete.
 * @returns {Object} Deletion plan with statistics.
 */
function generateDeletionPlan(allRevisions, selectedRevisions) {
  const toDeregister = selectedRevisions.filter(r => r.status === "ACTIVE");
  const toDelete = selectedRevisions.filter(r => r.status === "INACTIVE");
  const protectedRevisions = allRevisions.filter(r => r.isProtected);
  const kept = allRevisions.filter(r => !selectedRevisions.includes(r));

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

  const spinner = quiet ? null : ora({
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
        if (err.name === 'ThrottlingException' || err.message.includes('Rate exceeded')) {
          retryCount++;
          if (retryCount > maxRetries) {
            failed.push({ arn, error: err.message });
            // Don't log here - will be reported in final summary
          } else {
            // Exponential backoff: 1s, 2s, 4s
            const backoffMs = 1000 * Math.pow(2, retryCount - 1);
            if (spinner) {
              spinner.text = chalk.yellow(`⚠️  Rate limit, pausing ${backoffMs / 1000}s... (attempt ${retryCount}/${maxRetries})`);
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

  const spinner = quiet ? null : ora({
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
        const successfulArns = batch.filter(arn =>
          !response.failures || !response.failures.find(f => f.arn === arn)
        );
        success.push(...successfulArns);
        batchSuccess = true;

        if (spinner) {
          spinner.text = `Deleted batch ${i + 1}/${batches.length} (${success.length} total)...`;
        }
      } catch (err) {
        if (err.name === 'ThrottlingException' || err.message.includes('Rate exceeded')) {
          retryCount++;
          if (retryCount > maxRetries) {
            batch.forEach((arn) => {
              failed.push({ arn, error: `Rate limit exceeded after ${maxRetries} retries` });
            });
            // Don't log here - will be reported in final summary
          } else {
            // Exponential backoff: 1s, 2s, 4s
            const backoffMs = 1000 * Math.pow(2, retryCount - 1);
            if (spinner) {
              spinner.text = chalk.yellow(`⚠️  Rate limit, pausing ${backoffMs / 1000}s... (attempt ${retryCount}/${maxRetries})`);
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
  const activeRevisions = selectedRevisions.filter(r => r.status === "ACTIVE");
  const inactiveRevisions = selectedRevisions.filter(r => r.status === "INACTIVE");

  logger.info(chalk.blue("\n🚀 Starting pruning operation...\n"));

  const results = {
    deregister: { success: [], failed: [] },
    delete: { success: [], failed: [] },
  };

  // Phase 1: Deregister ACTIVE revisions
  if (activeRevisions.length > 0) {
    logger.info(chalk.yellow(`Phase 1: Deregistering ${activeRevisions.length} ACTIVE revisions...`));
    const deregisterArns = activeRevisions.map(r => r.arn);
    results.deregister = await deregisterTaskDefinitions(ecs, deregisterArns);
  }

  // Phase 2: Delete INACTIVE revisions (including newly deregistered ones)
  const revisionsToDelete = [
    ...inactiveRevisions,
    ...activeRevisions.filter(r => results.deregister.success.includes(r.arn)),
  ];

  if (revisionsToDelete.length > 0) {
    logger.info(chalk.yellow(`\nPhase 2: Deleting ${revisionsToDelete.length} INACTIVE revisions...`));
    const deleteArns = revisionsToDelete.map(r => r.arn);
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
    chalk.yellow("✨ Interactive ECS task executor, rollback tool, and task definition cleanup utility"),
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

program
  .command("prune")
  .description("Clean up unused task definition revisions")
  .addHelpText("after", chalk.dim("Example: taskonaut prune"))
  .action(async () => {
    try {
      console.log(chalk.cyan.bold("🗑️  Task Definition Pruning"));
      console.log(
        chalk.dim(
          "Clean up old task definition revisions while keeping latest 5 and protecting in-use revisions.\n"
        )
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
            "Do you want to check which revisions are in use by services in a specific cluster?"
          ),
          initial: true,
        },
        {
          onCancel: () => {
            logger.info(chalk.dim("\nOperation cancelled"));
            process.exit(0);
          },
        }
      );

      let cluster = null;
      if (checkUsageResponse.checkUsage) {
        const clusters = await listClusters(ecs, true);
        if (clusters && clusters.length > 0) {
          const clusterChoices = clusters.map((c) => ({
            title: `${chalk.green(c.clusterName)} ${chalk.yellow(
              `(${c.servicesCount} services)`
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
            }
          );

          if (wasPromptCancelled(clusterResponse, "cluster")) {
            logger.info(chalk.dim("Operation cancelled"));
            process.exit(0);
          }

          cluster = clusterResponse.cluster;
          if (cluster) {
            console.log(
              chalk.green(`📍 Checking usage in cluster: ${chalk.bold(cluster)}\n`)
            );
          }
        }
      } else {
        console.log(
          chalk.yellow(
            "⚠️  Skipping service usage check. Only latest revision will be protected.\n"
          )
        );
      }

      // Step 3: Analyze revisions
      console.log(chalk.blue.bold("Step 3: Analyzing Revisions\n"));
      const analysis = await analyzeTaskDefinitionRevisions(ecs, family, cluster, false);

      if (analysis.revisions.length === 0) {
        console.log(chalk.yellow("No revisions found for this family"));
        return;
      }

      console.log(chalk.green(`✅ Found ${analysis.revisions.length} revisions\n`));

      // Show protection summary
      console.log(chalk.blue.bold("Protection Summary:"));
      console.log(chalk.dim("─".repeat(60)));
      console.log(`  Total revisions: ${chalk.bold(analysis.revisions.length)}`);
      console.log(`  Latest revision: ${chalk.bold(analysis.latest)}`);
      console.log(
        `  Protected: ${chalk.bold(analysis.protected.length)} (latest${cluster ? " + in-use" : ""})`
      );
      console.log(
        `  Latest 5 (recommended keep): ${chalk.cyan(
          analysis.revisions.slice(0, 5).map((r) => r.revision).join(", ")
        )}`
      );

      if (analysis.protected.length > 0) {
        console.log(chalk.green("\n  Protected revisions (cannot be deleted):"));
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
        (r) => !r.isProtected
      ).length;
      console.log(
        chalk.yellow(
          `\n  Eligible for deletion: ${chalk.bold(eligibleCount)} revisions`
        )
      );
      console.log(chalk.dim("─".repeat(60) + "\n"));

      if (eligibleCount === 0) {
        console.log(chalk.yellow("\n⚠️  No revisions available for deletion.\n"));
        console.log(chalk.dim("Reasons:"));
        if (analysis.revisions.length === 1) {
          console.log(
            chalk.dim(`  • Only 1 revision exists (the latest revision is always protected)`)
          );
        } else {
          console.log(chalk.dim(`  • All ${analysis.revisions.length} revisions are protected:`));
          console.log(chalk.dim(`    - Latest revision: ${analysis.latest} (always protected)`));
          if (analysis.protected.length > 1) {
            console.log(
              chalk.dim(
                `    - ${analysis.protected.length - 1} revision(s) in use by services`
              )
            );
          }
        }
        console.log(
          chalk.dim(
            `\n💡 Tip: To delete revisions, they must be deregistered (INACTIVE) and not in use by services.`
          )
        );
        return;
      }

      // Step 4: Manual selection
      console.log(chalk.blue.bold("Step 4: Select Revisions to Delete\n"));
      console.log(
        chalk.dim(
          "Use spacebar to select/deselect, Enter to confirm. Protected revisions are disabled.\n"
        )
      );

      const selectedRevisions = await selectRevisionsToDelete(analysis.revisions);

      if (selectedRevisions.length === 0) {
        console.log(chalk.yellow("No revisions selected for deletion. Exiting."));
        return;
      }

      // Step 5: Generate and display deletion plan
      console.log(chalk.blue.bold("\n\nStep 5: Deletion Plan Preview\n"));
      const plan = generateDeletionPlan(analysis.revisions, selectedRevisions);

      console.log(chalk.blue.bold("🔍 Deletion Plan:"));
      console.log(chalk.dim("─".repeat(60)));
      console.log(`📊 Statistics:`);
      console.log(`   Total revisions: ${chalk.bold(plan.total)}`);
      console.log(`   Protected: ${chalk.green(plan.protected)} (will NOT be deleted)`);
      console.log(`   Will keep: ${chalk.cyan(plan.kept)}`);
      console.log(
        `   Will deregister: ${chalk.yellow(plan.willDeregister)} (ACTIVE → INACTIVE)`
      );
      console.log(
        `   Will delete: ${chalk.red(plan.willDelete)} (INACTIVE → DELETED)`
      );

      if (plan.protectedRevisions.length > 0) {
        console.log(chalk.green("\n⚠️  Protected Revisions (will NOT be deleted):"));
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
            `   • Revision ${r.revision} (${new Date(r.createdAt).toLocaleDateString()})`
          );
        });
      }

      if (plan.willDelete > 0) {
        console.log(chalk.red("\n🗑️  Will Delete (INACTIVE → DELETED):"));
        plan.deleteRevisions.forEach((r) => {
          console.log(
            `   • Revision ${r.revision} (${new Date(r.createdAt).toLocaleDateString()})`
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
            `⚠️  Type the task definition family name to confirm: ${chalk.bold(family)}`
          ),
          validate: (value) =>
            value === family
              ? true
              : `Please type exactly: ${family}`,
        },
        {
          onCancel: () => {
            logger.info(chalk.dim("\nOperation cancelled"));
            process.exit(0);
          },
        }
      );

      if (wasPromptCancelled(typeConfirmResponse, "familyName") || typeConfirmResponse.familyName !== family) {
        console.log(chalk.dim("Confirmation failed. Operation cancelled."));
        return;
      }

      // Final confirmation
      const finalConfirmResponse = await prompts(
        {
          type: "confirm",
          name: "confirm",
          message: chalk.red(
            `⚠️  FINAL CONFIRMATION: Delete ${selectedRevisions.length} revision(s) from ${family}?`
          ),
          initial: false,
        },
        {
          onCancel: () => {
            logger.info(chalk.dim("\nOperation cancelled"));
            process.exit(0);
          },
        }
      );

      if (wasPromptCancelled(finalConfirmResponse, "confirm") || !finalConfirmResponse.confirm) {
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
            `   ✅ Deregistered: ${results.deregister.success.length} revisions`
          )
        );
      }

      if (results.deregister.failed.length > 0) {
        console.log(
          chalk.red(
            `   ❌ Failed to deregister: ${results.deregister.failed.length} revisions`
          )
        );
        results.deregister.failed.forEach((f) => {
          console.log(chalk.dim(`      • ${f.arn}: ${f.error}`));
        });
      }

      if (results.delete.success.length > 0) {
        console.log(
          chalk.green(`   ✅ Deleted: ${results.delete.success.length} revisions`)
        );
      }

      if (results.delete.failed.length > 0) {
        console.log(
          chalk.red(`   ❌ Failed to delete: ${results.delete.failed.length} revisions`)
        );
        results.delete.failed.forEach((f) => {
          console.log(chalk.dim(`      • ${f.arn}: ${f.error}`));
        });
      }

      console.log(chalk.dim("─".repeat(60)));

      // Calculate unique revisions processed
      // The delete.success count is the actual number of revisions removed
      const revisionsDeleted = results.delete.success.length;
      const revisionsFailed = results.deregister.failed.length + results.delete.failed.length;

      if (revisionsFailed === 0) {
        console.log(
          chalk.green.bold(
            `\n🎉 Successfully cleaned up ${revisionsDeleted} task definition revision(s)!`
          )
        );
      } else {
        console.log(
          chalk.yellow(
            `\n⚠️  Completed: ${revisionsDeleted} cleaned up, ${revisionsFailed} failed`
          )
        );
      }

      console.log(
        chalk.blue(
          "\n💡 Pro tip: You can verify the results in the AWS Console or use:"
        )
      );
      console.log(
        chalk.dim(
          `   aws ecs list-task-definitions --family-prefix ${family} --status ACTIVE`
        )
      );
    } catch (err) {
      console.error(chalk.red("Pruning failed: " + err.message));
      process.exit(1);
    }
  });

program.parse();
