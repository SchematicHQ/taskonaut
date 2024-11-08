#!/usr/bin/env node
import { Command } from "commander";
import inquirer from "inquirer";
import { ECS } from "@aws-sdk/client-ecs";
import { fromSSO } from "@aws-sdk/credential-providers";
import pino from "pino";
import dotenv from "dotenv";
import { spawn } from "child_process";
import chalk from "chalk";
import figlet from "figlet";
import { pastel } from "gradient-string";
import ora from "ora";
import Conf from "conf";
import fs from "fs";
import path from "path";
import os from "os";

dotenv.config();

const config = new Conf({
  projectName: "see",
  schema: {
    awsProfile: {
      type: "string",
      default: "schematic-prod",
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

const AWS_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "eu-west-1",
  "eu-west-2",
];

// Fancy banner
console.log(
  pastel.multiline(
    figlet.textSync("schematic-ecs-exe", {
      font: "ANSI Shadow",
      horizontalLayout: "full",
    })
  )
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

async function syncAwsProfiles() {
  const spinner = ora("Syncing AWS profiles...").start();
  try {
    const credentialsPath = path.join(os.homedir(), ".aws", "credentials");
    const configPath = path.join(os.homedir(), ".aws", "config");

    const profiles = new Set();

    if (fs.existsSync(credentialsPath)) {
      const content = fs.readFileSync(credentialsPath, "utf-8");
      content
        .match(/\[(.*?)\]/g)
        ?.forEach((profile) => profiles.add(profile.replace(/[\[\]]/g, "")));
    }

    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, "utf-8");
      content
        .match(/\[profile (.*?)\]/g)
        ?.forEach((profile) =>
          profiles.add(profile.replace(/\[profile (.*?)\]/, "$1"))
        );
    }

    const profilesList = Array.from(profiles);
    config.set("awsProfiles", profilesList);
    config.set("lastProfileSync", Date.now());

    spinner.succeed(`Found ${profilesList.length} AWS profiles`);
    return profilesList;
  } catch (err) {
    spinner.fail("Failed to sync AWS profiles");
    logger.error(chalk.red("Error syncing profiles:", err));
    throw err;
  }
}

async function getAwsProfiles() {
  const lastSync = config.get("lastProfileSync");
  const SYNC_INTERVAL = 1000 * 60 * 60; // 1 hour

  if (Date.now() - lastSync > SYNC_INTERVAL) {
    return syncAwsProfiles();
  }

  return config.get("awsProfiles");
}

const initAWS = async () => {
  try {
    const profiles = await getAwsProfiles();
    const currentProfile = config.get("awsProfile");

    if (!profiles.includes(currentProfile)) {
      logger.warn(
        chalk.yellow(`Profile ${currentProfile} not found, please reconfigure`)
      );
      throw new Error("Invalid AWS profile");
    }

    const region = config.get("awsRegion");
    logger.info(
      chalk.dim(`Using AWS Profile: ${currentProfile} and Region: ${region}`)
    );

    const credentials = await fromSSO({ profile: currentProfile })();
    return new ECS({ region, credentials });
  } catch (err) {
    logger.error(chalk.red("AWS initialization failed:", err));
    process.exit(1);
  }
};

async function listClusters(ecs) {
  try {
    const spinner = ora("Fetching clusters...").start();
    const { clusterArns } = await ecs.listClusters({});
    spinner.succeed("Clusters fetched");
    return clusterArns.map((arn) => arn.split("/").pop());
  } catch (err) {
    logger.error(chalk.red("Failed to list clusters:", err));
    throw err;
  }
}

async function selectCluster(ecs) {
  const clusters = await listClusters(ecs);
  const { cluster } = await inquirer.prompt([
    {
      type: "list",
      name: "cluster",
      message: chalk.blue("Select ECS cluster:"),
      prefix: "🚀",
      choices: clusters.map((c) => ({
        name: chalk.green(c),
        value: c,
      })),
    },
  ]);
  return cluster;
}

async function selectTask(ecs, cluster) {
  try {
    const spinner = ora("Fetching tasks...").start();
    const { taskArns } = await ecs.listTasks({ cluster });

    if (!taskArns.length) {
      spinner.fail("No tasks found");
      throw new Error(chalk.red("No tasks found in cluster"));
    }

    const { tasks } = await ecs.describeTasks({
      cluster,
      tasks: taskArns,
    });

    spinner.succeed("Tasks fetched");

    const { taskArn } = await inquirer.prompt([
      {
        type: "list",
        name: "taskArn",
        message: chalk.blue("Select task:"),
        prefix: "📦",
        choices: tasks.map((task) => ({
          name: `${chalk.green(
            task.taskDefinitionArn.split("/").pop()
          )} ${chalk.yellow(`(${task.lastStatus})`)}`,
          value: task.taskArn,
        })),
      },
    ]);
    return taskArn;
  } catch (err) {
    logger.error(chalk.red("Failed to select task:", err));
    throw err;
  }
}

async function getTaskDetails(ecs, cluster, taskArn) {
  try {
    const { tasks } = await ecs.describeTasks({
      cluster,
      tasks: [taskArn],
    });

    if (!tasks || tasks.length === 0) {
      throw new Error(chalk.red("Task not found"));
    }

    return tasks[0];
  } catch (err) {
    logger.error(chalk.red("Failed to get task details:", err));
    throw err;
  }
}

async function selectContainer(ecs, cluster, taskArn) {
  const spinner = ora("Fetching container details...").start();
  const task = await getTaskDetails(ecs, cluster, taskArn);
  const containers = task.containers;
  spinner.succeed("Container details fetched");

  if (containers.length === 1) {
    logger.info(chalk.dim("Single container detected, auto-selecting..."));
    return containers[0].name;
  }

  const { containerName } = await inquirer.prompt([
    {
      type: "list",
      name: "containerName",
      message: chalk.blue("Select container:"),
      prefix: "🐳",
      choices: containers.map((container) => ({
        name: `${chalk.green(container.name)} ${chalk.yellow(
          `(${container.lastStatus})`
        )}`,
        value: container.name,
      })),
    },
  ]);

  return containerName;
}

async function executeCommand(cluster, taskArn, containerName) {
  return new Promise((resolve, reject) => {
    logger.info(chalk.dim("Starting shell session..."));

    const process = spawn(
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
      }
    );

    const cleanup = () => {
      logger.info(chalk.yellow("📤 Cleaning up ECS session..."));
      process.kill("SIGTERM");
    };

    ["SIGINT", "SIGTERM", "SIGQUIT"].forEach((signal) => {
      process.on(signal, cleanup);
    });

    process.on("error", (err) => {
      logger.error(chalk.red("Process error:", err));
      cleanup();
      reject(err);
    });

    process.on("exit", (code) => {
      logger.info(
        chalk.green(`✨ Session ended with exit code ${chalk.bold(code)}`)
      );
      resolve(code);
    });
  });
}

const program = new Command();

program
  .name(chalk.cyan("see"))
  .description(chalk.yellow("✨ Interactive ECS task executor"))
  .action(async () => {
    try {
      const ecs = await initAWS();
      const cluster = await selectCluster(ecs);
      const taskArn = await selectTask(ecs, cluster);
      const containerName = await selectContainer(ecs, cluster, taskArn);

      logger.info(
        chalk.green(
          `🚀 Connecting to container ${chalk.bold(containerName)}...`
        )
      );
      await executeCommand(cluster, taskArn, containerName);
    } catch (err) {
      logger.error(chalk.red("Failed to execute task:", err));
      process.exit(1);
    }
  });

program
  .command("config")
  .description("Configure AWS profile and region")
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
        },
      ]);

      config.set("awsProfile", profile);
      config.set("awsRegion", region);

      logger.info(chalk.green("✨ Configuration saved successfully!"));
    } catch (err) {
      logger.error(chalk.red("Failed to configure:", err));
      process.exit(1);
    }
  });

program.parse();
