#!/usr/bin/env node

import { ECS } from "@aws-sdk/client-ecs";
import { fromIni } from "@aws-sdk/credential-providers";
import { Command } from "commander";
import inquirer from "inquirer";
import pino from "pino";
import dotenv from "dotenv";
import chalk from "chalk";
import figlet from "figlet";
import ora from "ora";
import Conf from "conf";
import { pastel } from "gradient-string";
import { spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import ini from "ini";
import { AWS_REGIONS } from "./regions.js";

// Load environment variables
dotenv.config();

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
 * @returns {Promise<Array<{clusterName: string, servicesCount: number, tasksCount: number, containerInstancesCount: number}>>} Clusters with details.
 */
async function listClusters(ecs) {
  try {
    const spinner = ora("Fetching clusters...").start();
    const { clusterArns } = await ecs.listClusters({});
    spinner.succeed("Clusters fetched");

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
  const { cluster } = await inquirer.prompt([
    {
      type: "list",
      name: "cluster",
      message: chalk.blue("Select ECS cluster:"),
      prefix: "🚀",
      choices: clusters.map((c) => ({
        name:
          chalk.green(c.clusterName) +
          chalk.yellow(
            ` (Services: ${c.servicesCount}, Tasks: ${c.tasksCount}, Container Instances: ${c.containerInstancesCount})`,
          ),
        value: c.clusterName,
      })),
    },
  ]);
  return cluster;
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
      spinner.fail("No tasks found");
      logger.warn(chalk.yellow("No tasks found in cluster."));
      throw new Error("No tasks available in cluster");
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
        name: `${chalk.green(taskDefName)} ${chalk.yellow(
          `(ID: ${shortTaskId}, ${task.lastStatus}, started at: ${startedAt})`,
        )}`,
        value: task.taskArn,
      };
    });

    if (allowBack) {
      choices.unshift({
        name: chalk.blue("← Go Back"),
        value: "__BACK__",
      });
    }

    const { taskArn } = await inquirer.prompt([
      {
        type: "list",
        name: "taskArn",
        message: chalk.blue("Select task:"),
        prefix: "📦",
        choices,
        loop: false,
        pageSize: choices.length,
      },
    ]);

    return taskArn;
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
      name: `${chalk.green(container.name)} ${chalk.yellow(
        `(${container.lastStatus})`,
      )}`,
      value: container.name,
    }));

    if (allowBack) {
      choices.unshift({
        name: chalk.blue("← Go Back"),
        value: "__BACK__",
      });
    }
  }

  const { containerName } = await inquirer.prompt([
    {
      type: "list",
      name: "containerName",
      message: chalk.blue("Select container:"),
      prefix: "🐳",
      choices,
    },
  ]);

  return containerName;
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
  .description(chalk.yellow("✨ Interactive ECS task executor"))
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

program.parse();
