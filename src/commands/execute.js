/**
 * @fileoverview Main execute command for interactive ECS task selection and execution
 * @author taskonaut
 * @version 1.0.0
 */

import { ErrorHandler, UserCancelledError } from '../core/errors.js';
import logger from '../core/logger.js';
import { AWSClientManager } from '../aws/client.js';
import { ECSClusterManager } from '../aws/ecs/clusters.js';
import { ECSTaskManager } from '../aws/ecs/tasks.js';
import config from '../core/config.js';
import { formatter } from '../ui/formatters.js';
import { displayBanner } from '../ui/banner.js';

/**
 * Execute command handler
 */
export class ExecuteCommand {
  /**
   * Create a new ExecuteCommand instance
   * @param {Object} options - Command options
   */
  constructor(options = {}) {
    this.options = options;
    this.awsClient = null;
    this.clusterManager = null;
    this.taskManager = null;
  }

  /**
   * Initialize AWS services
   * @returns {Promise<void>}
   * @private
   */
  async _initializeServices() {
    try {
      // Initialize AWS client
      this.awsClient = new AWSClientManager({
        profile: config.get('aws.profile'),
        region: config.get('aws.region')
      });

      const ecsClient = await this.awsClient.getECSClient();
      
      // Initialize ECS managers
      this.clusterManager = new ECSClusterManager(ecsClient);
      this.taskManager = new ECSTaskManager(ecsClient);

      logger.debug('AWS services initialized', {
        profile: config.get('aws.profile'),
        region: config.get('aws.region')
      });
    } catch (error) {
      ErrorHandler.handle(error, { operation: 'initialize AWS services' });
      throw error;
    }
  }

  /**
   * Execute the main interactive workflow
   * @returns {Promise<void>}
   */
  async execute() {
    try {
      // Display welcome banner for execute command
      if (!config.isQuiet()) {
        displayBanner();
        console.log(formatter.formatHeader('🚀 ECS Task Executor', { color: 'primary' }));
        console.log(formatter.formatStatus('Starting interactive ECS task selection and execution', 'info', '✨'));
        console.log(''); // Empty line for spacing
      }
      
      if (config.get('cli.verbose')) {
        logger.info('🚀 Starting ECS task execution workflow');
      }
      
      // Initialize AWS services
      await this._initializeServices();

      // Show current AWS configuration
      if (!config.isQuiet()) {
        console.log(formatter.formatStatus('Current Configuration:', 'info', '⚙️'));
        console.log(formatter.formatKeyValue({
          'AWS Profile': config.get('aws.profile'),
          'AWS Region': config.get('aws.region')
        }));
        console.log(''); // Empty line for spacing
      }

      // Main workflow with navigation support
      let currentCluster = null;
      let currentTask = null;
      let currentContainer = null;

      // Main navigation loop for cluster selection
      while (true) {
        try {
          // Step 1: Select cluster (with back option to exit)
          currentCluster = await this.clusterManager.selectCluster({ allowBack: true });
          
          if (currentCluster === '__BACK__') {
            console.log(formatter.formatStatus('👋 Exiting taskonaut - Thanks for using ECS Task Executor!', 'success'));
            return;
          }
          
          if (config.get('cli.verbose')) {
            logger.info('Selected cluster:', { cluster: currentCluster });
          }

          // Inner loop for task selection
          while (true) {
            try {
              // Step 2: Select task
              currentTask = await this.taskManager.selectTask(currentCluster, {
                allowBack: true
              });

              if (currentTask === '__BACK__') {
                // Go back to cluster selection
                break;
              }

              // Inner navigation loop for container selection
              while (true) {
                try {
                  // Step 3: Select container
                  currentContainer = await this.taskManager.selectContainer(
                    currentCluster, 
                    currentTask,
                    { allowBack: true }
                  );

                  if (currentContainer === '__BACK__') {
                    // Go back to task selection
                    break;
                  }

                  // Step 4: Execute command
                  console.log('\n' + formatter.formatStatus('🚀 Establishing connection to container...', 'info'));
                  logger.info('🚀 Connecting to container', {
                    container: currentContainer
                  });

                  const exitCode = await this.taskManager.executeCommand(
                    currentCluster,
                    currentTask,
                    currentContainer
                  );

                  console.log('\n' + formatter.formatStatus('✨ Session completed successfully!', 'success'));
                  if (config.get('cli.verbose')) {
                    logger.success('✨ Command execution completed', { exitCode });
                  }
                  return; // Exit after successful execution

                } catch (error) {
                  if (error instanceof UserCancelledError) {
                    console.log(formatter.formatStatus('Operation cancelled by user', 'info', 'ℹ️'));
                    return;
                  }
                  
                  // Handle other errors but continue the workflow
                  ErrorHandler.handle(error, { 
                    operation: 'container selection/execution',
                    cluster: currentCluster,
                    task: currentTask 
                  });
                  
                  // Ask if user wants to try again or go back
                  const shouldRetry = await this._handleExecutionError(error);
                  if (!shouldRetry) {
                    return;
                  }
                }
              }

            } catch (error) {
              if (error instanceof UserCancelledError) {
                console.log(formatter.formatStatus('Operation cancelled by user', 'info', 'ℹ️'));
                return;
              }
              
              // Handle task selection errors
              ErrorHandler.handle(error, { 
                operation: 'task selection',
                cluster: currentCluster 
              });
              
              const shouldRetry = await this._handleTaskSelectionError(error);
              if (!shouldRetry) {
                return;
              }
            }
          }

        } catch (error) {
          if (error instanceof UserCancelledError) {
            console.log(formatter.formatStatus('Operation cancelled by user', 'info', 'ℹ️'));
            return;
          }
          
          // Handle cluster selection errors  
          ErrorHandler.handle(error, { 
            operation: 'cluster selection' 
          });
          
          const shouldRetry = await this._handleClusterSelectionError(error);
          if (!shouldRetry) {
            return;
          }
        }
      }

    } catch (error) {
      if (error instanceof UserCancelledError) {
        console.log(formatter.formatStatus('Operation cancelled by user', 'info', 'ℹ️'));
        return;
      }
      
      ErrorHandler.handleAndExit(error, { operation: 'execute command' });
    } finally {
      // Cleanup
      if (this.awsClient) {
        this.awsClient.dispose();
      }
    }
  }

  /**
   * Handle execution errors and ask user for next action
   * @param {Error} error - The error that occurred
   * @returns {Promise<boolean>} True if should retry, false if should exit
   * @private
   */
  async _handleExecutionError(error) {
    console.log('\n' + formatter.formatStatus('❌ Connection failed', 'error'));
    logger.error('Command execution failed', { error: error.message });
    
    try {
      const { awsPrompts } = await import('../ui/prompts.js');
      
      console.log('\n' + formatter.formatStatus('What would you like to do next?', 'info', '🤔'));
      
      // Provide user options based on error type
      const choices = [
        { name: '🔄 Try again with same container', value: 'retry' },
        { name: '📦 Select different container', value: 'container' },
        { name: '📋 Select different task', value: 'task' },
        { name: '🏗️ Select different cluster', value: 'cluster' },
        { name: '❌ Exit', value: 'exit' }
      ];

      const action = await awsPrompts.select({
        message: 'Choose your next action',
        choices
      });

      switch (action) {
        case 'retry':
          return true;
        case 'container':
        case 'task':
        case 'cluster':
          return true;
        case 'exit':
        default:
          console.log(formatter.formatStatus('👋 Goodbye!', 'info'));
          return false;
      }
    } catch (promptError) {
      logger.debug('Error handling execution error prompt', { error: promptError.message });
      return false;
    }
  }

  /**
   * Handle task selection errors and ask user for next action
   * @param {Error} error - The error that occurred
   * @returns {Promise<boolean>} True if should retry, false if should exit
   * @private
   */
  async _handleTaskSelectionError(error) {
    console.log('\n' + formatter.formatStatus('❌ Task selection failed', 'error'));
    logger.error('Task selection failed', { error: error.message });
    
    try {
      const { awsPrompts } = await import('../ui/prompts.js');
      
      console.log('\n' + formatter.formatStatus('What would you like to do next?', 'info', '🤔'));
      
      const choices = [
        { name: '🔄 Try again with same cluster', value: 'retry' },
        { name: '🏗️ Select different cluster', value: 'cluster' },
        { name: '❌ Exit', value: 'exit' }
      ];

      const action = await awsPrompts.select({
        message: 'Choose your next action',
        choices
      });

      if (action === 'exit') {
        console.log(formatter.formatStatus('👋 Goodbye!', 'info'));
      }

      return action !== 'exit';
    } catch (promptError) {
      logger.debug('Error handling task selection error prompt', { error: promptError.message });
      return false;
    }
  }

  /**
   * Handle cluster selection errors and ask user for next action
   * @param {Error} error - The error that occurred
   * @returns {Promise<boolean>} True if should retry, false if should exit
   * @private
   */
  async _handleClusterSelectionError(error) {
    console.log('\n' + formatter.formatStatus('❌ Cluster selection failed', 'error'));
    logger.error('Cluster selection failed', { error: error.message });
    
    try {
      const { awsPrompts } = await import('../ui/prompts.js');
      
      console.log('\n' + formatter.formatStatus('What would you like to do next?', 'info', '🤔'));
      
      const choices = [
        { name: '🔄 Try again', value: 'retry' },
        { name: '❌ Exit', value: 'exit' }
      ];

      const action = await awsPrompts.select({
        message: 'Choose your next action',
        choices
      });

      if (action === 'exit') {
        console.log(formatter.formatStatus('👋 Goodbye!', 'info'));
      }

      return action !== 'exit';
    } catch (promptError) {
      logger.debug('Error handling cluster selection error prompt', { error: promptError.message });
      return false;
    }
  }

  /**
   * Get command configuration for Commander.js
   * @returns {Object} Command configuration
   */
  static getCommandConfig() {
    return {
      name: 'execute',
      description: '🚀 Interactive ECS task executor and shell access',
      aliases: ['exec', 'run'],
      action: async (options) => {
        const command = new ExecuteCommand(options);
        await command.execute();
      }
    };
  }

  /**
   * Get structured help data for this command
   * @returns {Object} Help data structure
   */
  static getHelpData() {
    return {
      name: 'execute',
      emoji: '🚀',
      description: 'Interactive ECS task executor and shell access - Connect to running containers via ECS Exec',
      usage: 'taskonaut execute [options]',
      options: [
        {
          short: '-h',
          long: '--help',
          description: 'Display help for execute command'
        }
      ],
      examples: [
        {
          command: 'taskonaut execute',
          description: 'Start interactive task executor (default action)',
          highlight: true
        },
        {
          command: 'taskonaut exec',
          description: 'Same as above using alias'
        },
        {
          command: 'taskonaut',
          description: 'Start task executor (execute is the default command)'
        }
      ],
      notes: [
        'Requires ECS Exec to be enabled on your tasks',
        'AWS Session Manager Plugin must be installed',
        'Navigate with arrow keys, select with Enter',
        'Use "Back" options or Ctrl+C to exit at any time'
      ]
    };
  }
}

export default ExecuteCommand; 