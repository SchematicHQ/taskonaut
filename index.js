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

dotenv.config();

// Add after imports
const config = new Conf({
  projectName: "schematic-ecs-exe",
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
  },
});

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

const initAWS = async () => {
  try {
    const profile = config.get("awsProfile");
    const region = config.get("awsRegion");

    logger.info(
      chalk.dim(`Using AWS Profile: ${profile} and Region: ${region}`)
    );

    const credentials = await fromSSO({ profile })();
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
  .description("Configure AWS settings")
  .action(async () => {
    try {
      const { profile } = await inquirer.prompt([
        {
          type: "input",
          name: "profile",
          message: "Enter AWS Profile:",
          default: config.get("awsProfile"),
        },
      ]);

      const { region } = await inquirer.prompt([
        {
          type: "input",
          name: "region",
          message: "Enter AWS Region:",
          default: config.get("awsRegion"),
        },
      ]);

      config.set("awsProfile", profile);
      config.set("awsRegion", region);

      logger.info(chalk.green("Configuration saved!"));
    } catch (err) {
      logger.error(chalk.red("Failed to save configuration:", err));
    }
  });

program.parse();
