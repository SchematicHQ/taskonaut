#!/usr/bin/env node

/**
 * @fileoverview Main entry point for taskonaut CLI application
 * @author taskonaut
 */

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Get package.json version dynamically
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));
const { version } = packageJson;

// Import modular components
import { setupGlobalErrorHandlers } from './src/core/errors.js';
import logger from './src/core/logger.js';
import config from './src/core/config.js';
import help from './src/ui/help.js';

// Import command modules
import { ExecuteCommand } from './src/commands/execute.js';
import { RollbackCommand } from './src/commands/rollback.js';
import { ConfigCommand } from './src/commands/config.js';
import { DoctorCommand } from './src/commands/doctor.js';

/**
 * Setup the CLI program with commands
 * @returns {Command} Configured Commander program
 */
function setupCLI() {
  const program = new Command();

  // Basic program setup
  program
    .name('taskonaut')
    .description('✨ Interactive ECS task executor and rollback tool')
    .version(version, '-v, --version', 'display version number')
    .option('-q, --quiet', 'suppress output messages')
    .option('--verbose', 'enable verbose logging')
    .option('--no-color', 'disable colored output')
    .hook('preAction', (thisCommand) => {
      // Apply global options as runtime overrides (don't save to file)
      const opts = thisCommand.opts();
      
      if (opts.quiet) {
        config.setRuntime('cli.quiet', true);
        logger.setLevel('error');
      }
      
      if (opts.verbose) {
        config.setRuntime('cli.verbose', true);
        logger.setLevel('debug');
      }

      if (opts.noColor) {
        config.setRuntime('logging.colorize', false);
      }
    });

  // Add custom help handling to prevent duplication
  program.configureHelp({
    showGlobalOptions: false,
  });

  // Configure help command to use custom help system instead of default
  program.addHelpCommand(false);
  
  // Override help display
  program.on('--help', () => {
    // This event is triggered by commander's built-in help
    // We let it proceed, but we could customize it here if needed
  });

  return program;
}

/**
 * Setup and register all CLI commands
 * @param {Command} program - The commander program instance
 */
function setupCommands(program) {
  // Get help manager instance
  const helpManager = help;

  // === EXECUTE COMMAND (Default) ===
  const executeCommand = new ExecuteCommand();
  const executeCmd = program
    .command('execute', { isDefault: true })
    .alias('exec')
    .description('🚀 Interactive ECS task executor and shell access (default)')
    .option('-c, --cluster <name>', 'ECS cluster name')
    .option('-s, --service <name>', 'ECS service name')
    .option('-t, --task <id>', 'Specific task ID')
    .option('--shell <shell>', 'Shell command to execute', '/bin/bash')
    .option('--dry-run', 'Show what would be executed without running')
    .action(async (options) => {
      await executeCommand.execute(options);
    });

  // Add execute-specific help handling
  executeCmd.on('--help', () => {
    helpManager.displayCommandHelp({
      name: 'execute',
      aliases: ['exec'],
      description: 'Interactive ECS task executor with shell access',
      usage: [
        'taskonaut execute',
        'taskonaut execute --cluster my-cluster',
        'taskonaut execute --service my-service --shell /bin/sh'
      ],
      options: [
        { flags: '-c, --cluster <name>', description: 'ECS cluster name to target' },
        { flags: '-s, --service <name>', description: 'ECS service name to target' },
        { flags: '-t, --task <id>', description: 'Specific task ID to execute into' },
        { flags: '--shell <shell>', description: 'Shell command to execute (default: /bin/bash)' },
        { flags: '--dry-run', description: 'Show what would be executed without running' }
      ],
      examples: [
        {
          command: 'taskonaut execute',
          description: 'Start interactive task selector'
        },
        {
          command: 'taskonaut --cluster prod-cluster --service web-service',
          description: 'Execute into web-service in prod-cluster'
        },
        {
          command: 'taskonaut --task task-id --shell /bin/sh',
          description: 'Execute specific task with custom shell'
        }
      ],
      notes: [
        'Requires AWS ECS Exec to be enabled on the task definition',
        'Uses configured AWS profile and region from config',
        'Interactive prompts guide you through cluster/service/task selection'
      ]
    });
  });

  // === ROLLBACK COMMAND ===
  const rollbackCommand = new RollbackCommand();
  const rollbackCmd = program
    .command('rollback')
    .description('🔄 Rollback ECS service to previous task definition revision')
    .option('-c, --cluster <name>', 'ECS cluster name')
    .option('-s, --service <name>', 'ECS service name')
    .option('-r, --revision <number>', 'Specific revision to rollback to')
    .option('--dry-run', 'Show rollback plan without executing')
    .option('--force', 'Skip confirmation prompts')
    .action(async (options) => {
      await rollbackCommand.execute(options);
    });

  // Add rollback-specific help handling
  rollbackCmd.on('--help', () => {
    helpManager.displayCommandHelp({
      name: 'rollback',
      description: 'Rollback ECS service to a previous task definition revision',
      usage: [
        'taskonaut rollback',
        'taskonaut rollback --cluster my-cluster --service my-service',
        'taskonaut rollback --revision 5 --force'
      ],
      options: [
        { flags: '-c, --cluster <name>', description: 'ECS cluster name' },
        { flags: '-s, --service <name>', description: 'ECS service name' },
        { flags: '-r, --revision <number>', description: 'Specific revision number to rollback to' },
        { flags: '--dry-run', description: 'Show rollback plan without executing' },
        { flags: '--force', description: 'Skip confirmation prompts' }
      ],
      examples: [
        {
          command: 'taskonaut rollback',
          description: 'Interactive rollback with cluster/service selection'
        },
        {
          command: 'taskonaut rollback --cluster prod --service api',
          description: 'Rollback api service in prod cluster'
        },
        {
          command: 'taskonaut rollback --revision 3 --dry-run',
          description: 'Preview rollback to revision 3'
        }
      ],
      notes: [
        'Shows current and available revisions before rollback',
        'Supports safety confirmations unless --force is used',
        'Monitors rollback progress and health checks'
      ]
    });
  });

  // === CONFIG COMMAND ===
  const configCommand = new ConfigCommand();
  const configCmd = program
    .command('config')
    .description('⚙️ Manage AWS profile, region, and other settings')
    .action(async () => {
      // Default action when no subcommand provided
      await configCommand.execute({ action: 'interactive' });
    });

  // Config subcommands
  configCmd
    .command('show')
    .description('Display current configuration')
    .action(async () => {
      await configCommand.execute({ action: 'show' });
    });

  configCmd
    .command('set')
    .description('Interactive configuration setup')
    .action(async () => {
      await configCommand.execute({ action: 'set' });
    });

  configCmd
    .command('reset')
    .description('Reset configuration to defaults')
    .action(async () => {
      await configCommand.execute({ action: 'reset' });
    });

  configCmd
    .command('cleanup')
    .description('Remove configuration file')
    .action(async () => {
      await configCommand.execute({ action: 'cleanup' });
    });

  // === DOCTOR COMMAND ===
  const doctorCommand = new DoctorCommand();
  const doctorCmd = program
    .command('doctor')
    .alias('diag')
    .description('🏥 Run environment diagnostics and health checks')
    .option('--format <type>', 'Output format (list, json, yaml)', 'list')
    .option('--fix', 'Attempt to fix detected issues')
    .action(async (options) => {
      await doctorCommand.execute(options);
    });

  // Add doctor-specific help handling  
  doctorCmd.on('--help', () => {
    helpManager.displayCommandHelp({
      name: 'doctor',
      aliases: ['diag'],
      description: 'Comprehensive environment diagnostics and health checks',
      usage: [
        'taskonaut doctor',
        'taskonaut doctor --format json',
        'taskonaut doctor --fix'
      ],
      options: [
        { flags: '--format <type>', description: 'Output format: list (default), json, yaml' },
        { flags: '--fix', description: 'Attempt to automatically fix detected issues' }
      ],
      examples: [
        {
          command: 'taskonaut doctor',
          description: 'Run all diagnostic checks'
        },
        {
          command: 'taskonaut doctor --format json',
          description: 'Output diagnostics in JSON format'
        },
        {
          command: 'taskonaut doctor --fix',
          description: 'Run diagnostics and attempt fixes'
        }
      ],
      notes: [
        'Checks AWS CLI, credentials, ECS permissions, and dependencies',
        'Provides actionable recommendations for fixing issues',
        'Use --fix for automated resolution of common problems'
      ]
    });
  });
}

/**
 * Main CLI initialization and execution
 */
async function main() {
  try {
    // Setup global error handling first
    setupGlobalErrorHandlers();

    // Parse command line arguments to check for help flags
    const args = process.argv.slice(2);
    
    // Handle version requests immediately
    if (args.includes('--version') || args.includes('-v')) {
      console.log(version);
      process.exit(0);
    }

    // Handle help requests with custom help system
    if (args.includes('--help') || args.includes('-h')) {
      // Check if it's a command-specific help request
      const commands = ['execute', 'exec', 'rollback', 'config', 'doctor', 'diag'];
      const helpCommand = args.find(arg => commands.includes(arg));
      
      if (helpCommand) {
        // Let commander handle command-specific help
        // This will trigger the command's --help event handler
      } else {
        // Main help request
        const helpManager = help;
        helpManager.displayMainHelp({
          name: 'taskonaut',
          description: '✨ Interactive ECS task executor and rollback tool',
          version,
          nodeVersion: process.version,
          commands: [
            {
              name: 'execute',
              aliases: ['exec'],
              description: 'Interactive ECS task executor and shell access (default)',
              emoji: '🚀'
            },
            {
              name: 'rollback',
              description: 'Rollback ECS service to previous task definition revision',
              emoji: '🔄'
            },
            {
              name: 'config',
              description: 'Manage AWS profile, region, and other settings',
              emoji: '⚙️'
            },
            {
              name: 'doctor',
              aliases: ['diag'],
              description: 'Run environment diagnostics and health checks',
              emoji: '🏥'
            }
          ],
          globalOptions: [
            { flags: '-h, --help', description: 'Display help information' },
            { flags: '-v, --version', description: 'Display version number' },
            { flags: '-q, --quiet', description: 'Suppress output messages' },
            { flags: '--verbose', description: 'Enable detailed logging' },
            { flags: '--no-color', description: 'Disable colored output' }
          ]
        });
        process.exit(0);
      }
    }

    // Setup and configure CLI
    const program = setupCLI();
    setupCommands(program);

    // Parse command line arguments
    await program.parseAsync(process.argv);

  } catch (error) {
    logger.error('CLI initialization failed', { error: error.message });
    process.exit(1);
  }
}

// Execute main function if this script is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
