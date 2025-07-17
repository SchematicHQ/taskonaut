/**
 * @fileoverview ECS task management operations for taskonaut
 * @author taskonaut
 * @version 1.0.0
 */

import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { ECSError, ErrorHandler, ERROR_CODES, UserCancelledError } from '../../core/errors.js';
import logger from '../../core/logger.js';
import { SpinnerUtils } from '../../ui/spinners.js';
import { awsPrompts } from '../../ui/prompts.js';
import config from '../../core/config.js';

/**
 * ECS task manager
 */
export class ECSTaskManager {
  /**
   * Create a new ECSTaskManager instance
   * @param {ECS} ecsClient - AWS ECS client
   */
  constructor(ecsClient) {
    this.ecs = ecsClient;
  }

  /**
   * List tasks in a cluster
   * @param {string} clusterArn - Cluster ARN or name
   * @param {Object} options - Options for listing tasks
   * @param {string} [options.status='RUNNING'] - Task status to filter by
   * @param {string} [options.serviceName] - Service name to filter by
   * @param {boolean} [options.includeDetails=true] - Include detailed task information
   * @param {boolean} [options.quiet=false] - Suppress spinner output
   * @returns {Promise<Array>} Array of task objects
   */
  async listTasks(clusterArn, options = {}) {
    const { 
      status = 'RUNNING', 
      serviceName, 
      includeDetails = true, 
      quiet = false 
    } = options;

    try {
      return await SpinnerUtils.withSpinner(
        async () => {
          logger.debug('Fetching ECS tasks', { 
            cluster: clusterArn, 
            status, 
            service: serviceName 
          });

          // Build list tasks parameters
          const listParams = {
            cluster: clusterArn,
            desiredStatus: status
          };

          if (serviceName) {
            listParams.serviceName = serviceName;
          }

          // Get task ARNs
          const { taskArns } = await this.ecs.listTasks(listParams);

          if (!taskArns || taskArns.length === 0) {
            logger.warn('No tasks found', { cluster: clusterArn, status });
            return [];
          }

          // Get detailed task information if requested
          if (includeDetails) {
            const { tasks } = await this.ecs.describeTasks({
              cluster: clusterArn,
              tasks: taskArns
            });

            const formattedTasks = tasks.map(task => this._formatTaskData(task));
            logger.debug('ECS tasks fetched with details', { count: formattedTasks.length });
            return this._sortTasksByCreationTime(formattedTasks);
          }

          // Return basic task data
          const basicTasks = taskArns.map(arn => ({
            taskArn: arn,
            taskId: arn.split('/').pop()
          }));

          logger.debug('ECS tasks fetched (basic)', { count: basicTasks.length });
          return basicTasks;
        },
        'Fetching ECS tasks...',
        quiet ? null : `Found ${taskArns?.length || 0} tasks`,
        'Failed to fetch ECS tasks'
      );
    } catch (error) {
      const ecsError = ErrorHandler.fromAWSError(error, 'list tasks');
      logger.error('Failed to list ECS tasks', { 
        cluster: clusterArn, 
        error: ecsError.message 
      });
      throw ecsError;
    }
  }

  /**
   * Get detailed information about a specific task
   * @param {string} clusterArn - Cluster ARN or name
   * @param {string} taskArn - Task ARN
   * @param {Object} options - Options for task details
   * @param {boolean} [options.includeContainers=true] - Include container details
   * @returns {Promise<Object>} Detailed task information
   */
  async getTaskDetails(clusterArn, taskArn, options = {}) {
    const { includeContainers = true } = options;

    try {
      logger.debug('Fetching task details', { cluster: clusterArn, task: taskArn });

      const { tasks } = await this.ecs.describeTasks({
        cluster: clusterArn,
        tasks: [taskArn]
      });

      if (!tasks || tasks.length === 0) {
        throw new ECSError(
          `Task '${taskArn}' not found in cluster '${clusterArn}'`,
          ERROR_CODES.ECS_TASK_NOT_FOUND,
          { cluster: clusterArn, task: taskArn }
        );
      }

      const task = this._formatTaskData(tasks[0]);

      if (includeContainers) {
        task.containerDetails = await this._getContainerDetails(task.containers);
      }

      logger.debug('Task details fetched', { 
        cluster: clusterArn,
        task: task.taskId,
        status: task.lastStatus 
      });

      return task;
    } catch (error) {
      if (error instanceof ECSError) throw error;
      
      const ecsError = ErrorHandler.fromAWSError(error, 'get task details');
      logger.error('Failed to get task details', { 
        cluster: clusterArn,
        task: taskArn,
        error: ecsError.message 
      });
      throw ecsError;
    }
  }

  /**
   * Select a task interactively
   * @param {string} clusterArn - Cluster ARN or name
   * @param {Object} options - Selection options
   * @param {boolean} [options.allowBack=false] - Allow back navigation
   * @param {string} [options.status='RUNNING'] - Task status filter
   * @param {string} [options.serviceName] - Service name filter
   * @returns {Promise<string|'__BACK__'>} Selected task ARN or back signal
   */
  async selectTask(clusterArn, options = {}) {
    const { allowBack = false, status = 'RUNNING', serviceName } = options;

    try {
      logger.debug('Starting task selection', { cluster: clusterArn });

      const tasks = await this.listTasks(clusterArn, { 
        status, 
        serviceName, 
        quiet: true 
      });

      if (!tasks || tasks.length === 0) {
        if (allowBack) {
          logger.info('💡 No running tasks found in this cluster');
          logger.info('   • Go back and select a different cluster');
          logger.info('   • Check if tasks are running in the AWS Console');
          
          const shouldGoBack = await awsPrompts.confirm({
            message: 'No tasks found. Go back to cluster selection?',
            defaultValue: true
          });

          if (shouldGoBack) {
            return '__BACK__';
          }
        }

        throw new ECSError(
          'No running tasks found in the cluster',
          ERROR_CODES.ECS_NO_RUNNING_TASKS,
          { cluster: clusterArn, status }
        );
      }

      // Format choices for prompt with enhanced styling
      const choices = tasks.map(task => {
        const shortId = task.taskId.substring(0, 8);
        const taskDefName = task.taskDefinitionFamily || 'Unknown';
        const revision = task.taskDefinitionRevision || 'N/A';
        
        // Enhanced status indicators with colors
        let statusIcon = '⚪';
        let statusColor = 'gray';
        
        switch (task.lastStatus) {
          case 'RUNNING':
            statusIcon = '🟢';
            statusColor = 'green';
            break;
          case 'PENDING':
            statusIcon = '🟡';
            statusColor = 'yellow';
            break;
          case 'STOPPED':
            statusIcon = '🔴';
            statusColor = 'red';
            break;
          case 'STOPPING':
            statusIcon = '🟠';
            statusColor = 'orange';
            break;
          default:
            statusIcon = '⚪';
            statusColor = 'gray';
        }
        
        // Format time more user-friendly
        const timeAgo = task.createdAt ? 
          this._formatTimeAgo(new Date(task.createdAt)) : 'Unknown';
        
        // Enhanced resource display with proper spacing
        const cpuDisplay = task.cpu ? `${task.cpu} CPU` : 'CPU: N/A';
        const memoryDisplay = task.memory ? `${task.memory}MB` : 'Memory: N/A';
        const containerCount = task.containers ? task.containers.length : 0;
        
        // Create beautifully formatted display with colors and highlighting
        const taskId = chalk.bold.cyan(`[${shortId}]`); // Highlight task ID in bright cyan
        const familyName = chalk.bold.magenta(taskDefName); // Highlight family name in magenta
        const revisionNumber = chalk.bold.yellow(`:${revision}`); // Highlight revision in yellow
        const taskDef = `${familyName}${revisionNumber}`;
        const coloredStatus = chalk[statusColor](task.lastStatus); // Apply status-specific color
        
        // Enhanced display with better visual hierarchy and colors
        const displayName = `${statusIcon} ${taskId} ${taskDef}`;
        
        // Create a more detailed and colorful description
        const coloredTimeAgo = chalk.gray(timeAgo); // Time in gray
        const statusLine = `${coloredStatus} • ${coloredTimeAgo}`;
        
        // Color-coded resource information
        const coloredCpuDisplay = chalk.blue(`💻 ${cpuDisplay}`); // CPU in blue
        const coloredMemoryDisplay = chalk.green(`🧠 ${memoryDisplay}`); // Memory in green
        const coloredContainerCount = chalk.yellow(`📦 ${containerCount} containers`); // Container count in yellow
        const resourceLine = `${coloredCpuDisplay} • ${coloredMemoryDisplay} • ${coloredContainerCount}`;
        
        const description = `${statusLine}\n    ${resourceLine}`;
        
        return {
          name: displayName,
          value: task.taskArn,
          short: chalk.cyan(shortId), // Short name also colored
          description: description
        };
      });

      const selectedArn = await awsPrompts.select({
        message: 'Select ECS task',
        choices,
        allowBack
      });

      if (selectedArn === '__BACK__') {
        return '__BACK__';
      }

      const selectedTask = tasks.find(t => t.taskArn === selectedArn);
      if (config.get('cli.verbose')) {
        logger.info('📋 Selected task', { 
          id: selectedTask?.taskId?.substring(0, 8),
          family: selectedTask?.taskDefinitionFamily,
          status: selectedTask?.lastStatus
        });
      }

      return selectedArn;
    } catch (error) {
      if (error instanceof ECSError || error instanceof UserCancelledError) throw error;
      
      const ecsError = ErrorHandler.fromAWSError(error, 'task selection');
      logger.error('Failed to select task', { 
        cluster: clusterArn, 
        error: ecsError.message 
      });
      throw ecsError;
    }
  }

  /**
   * Select a container within a task
   * @param {string} clusterArn - Cluster ARN or name
   * @param {string} taskArn - Task ARN
   * @param {Object} options - Selection options
   * @param {boolean} [options.allowBack=false] - Allow back navigation
   * @param {boolean} [options.autoSelectSingle=true] - Auto-select if only one container
   * @returns {Promise<string|'__BACK__'>} Selected container name or back signal
   */
  async selectContainer(clusterArn, taskArn, options = {}) {
    const { allowBack = false, autoSelectSingle = true } = options;

    try {
      logger.debug('Starting container selection', { 
        cluster: clusterArn, 
        task: taskArn 
      });

      const task = await this.getTaskDetails(clusterArn, taskArn, { 
        includeContainers: false 
      });

      if (!task.containers || task.containers.length === 0) {
        throw new ECSError(
          'No containers found in the task',
          ERROR_CODES.ECS_CONTAINER_NOT_FOUND,
          { cluster: clusterArn, task: taskArn }
        );
      }

      // Auto-select if only one container and auto-select is enabled
      if (task.containers.length === 1 && autoSelectSingle && !allowBack) {
        const container = task.containers[0];
        if (config.get('cli.verbose')) {
          logger.info('🐳 Auto-selected container', { name: container.name });
        }
        return container.name;
      }

      const selectedContainer = await awsPrompts.selectContainer(
        task.containers, 
        allowBack
      );

      if (selectedContainer === '__BACK__') {
        return '__BACK__';
      }

      if (config.get('cli.verbose')) {
        logger.info('🐳 Selected container', { name: selectedContainer });
      }
      return selectedContainer;
    } catch (error) {
      if (error instanceof ECSError || error instanceof UserCancelledError) throw error;
      
      const ecsError = ErrorHandler.fromAWSError(error, 'container selection');
      logger.error('Failed to select container', { 
        cluster: clusterArn,
        task: taskArn,
        error: ecsError.message 
      });
      throw ecsError;
    }
  }

  /**
   * Execute a command on a container using ECS Exec
   * @param {string} clusterArn - Cluster ARN or name
   * @param {string} taskArn - Task ARN
   * @param {string} containerName - Container name
   * @param {Object} options - Execution options
   * @param {string} [options.command='/bin/sh'] - Command to execute
   * @param {boolean} [options.interactive=true] - Interactive mode
   * @returns {Promise<number>} Exit code
   */
  async executeCommand(clusterArn, taskArn, containerName, options = {}) {
    const { command = '/bin/sh', interactive = true } = options;

    return new Promise((resolve, reject) => {
      try {
        logger.info('🚀 Connecting to container...', {
          task: taskArn.split('/').pop().substring(0, 8),
          container: containerName
        });

        const awsConfig = config.getAWSConfig();
        const args = [
          'ecs',
          'execute-command',
          '--profile', awsConfig.profile,
          '--region', awsConfig.region,
          '--cluster', clusterArn,
          '--task', taskArn,
          '--container', containerName,
          '--command', command
        ];

        if (interactive) {
          args.push('--interactive');
        }

        const childProcess = spawn('aws', args, {
          stdio: 'inherit'
        });

        // Handle process signals gracefully
        const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
        const signalHandlers = {};

        const cleanup = () => {
          if (config.get('cli.verbose')) {
            logger.info('📤 Cleaning up session...');
          }
          childProcess.kill('SIGTERM');
          signals.forEach((signal) => {
            process.removeListener(signal, signalHandlers[signal]);
          });
        };

        signals.forEach((signal) => {
          signalHandlers[signal] = () => cleanup();
          process.on(signal, signalHandlers[signal]);
        });

        childProcess.on('error', (err) => {
          logger.error('❌ Connection failed', { error: err.message });
          cleanup();
          reject(new ECSError(
            `Failed to start ECS Exec session: ${err.message}`,
            ERROR_CODES.ECS_EXEC_DISABLED,
            { cluster: clusterArn, task: taskArn, container: containerName }
          ));
        });

        childProcess.on('exit', (code) => {
          signals.forEach((signal) => {
            process.removeListener(signal, signalHandlers[signal]);
          });
          
          logger.success(`✨ Session ended`);
          resolve(code || 0);
        });
      } catch (error) {
        const ecsError = ErrorHandler.fromAWSError(error, 'execute command');
        logger.error('Failed to execute command', { 
          cluster: clusterArn,
          task: taskArn,
          container: containerName,
          error: ecsError.message 
        });
        reject(ecsError);
      }
    });
  }

  /**
   * Check if ECS Exec is enabled for a task
   * @param {string} clusterArn - Cluster ARN or name
   * @param {string} taskArn - Task ARN
   * @returns {Promise<boolean>} True if ECS Exec is enabled
   */
  async isECSExecEnabled(clusterArn, taskArn) {
    try {
      const task = await this.getTaskDetails(clusterArn, taskArn);
      return task.enableExecuteCommand === true;
    } catch (error) {
      logger.debug('Failed to check ECS Exec status', {
        cluster: clusterArn,
        task: taskArn,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Format task data for consistent output
   * @param {Object} task - Raw task data from AWS
   * @returns {Object} Formatted task data
   * @private
   */
  _formatTaskData(task) {
    return {
      taskArn: task.taskArn,
      taskId: task.taskArn.split('/').pop(),
      taskDefinitionArn: task.taskDefinitionArn,
      taskDefinitionFamily: task.taskDefinitionArn?.split('/')[1]?.split(':')[0],
      taskDefinitionRevision: task.taskDefinitionArn?.split(':').pop(),
      clusterArn: task.clusterArn,
      lastStatus: task.lastStatus,
      desiredStatus: task.desiredStatus,
      launchType: task.launchType,
      platformVersion: task.platformVersion,
      cpu: task.cpu,
      memory: task.memory,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      stoppedAt: task.stoppedAt,
      stopCode: task.stopCode,
      stoppedReason: task.stoppedReason,
      healthStatus: task.healthStatus,
      tags: task.tags || [],
      containers: task.containers?.map(container => ({
        name: container.name,
        lastStatus: container.lastStatus,
        cpu: container.cpu,
        memory: container.memory,
        memoryReservation: container.memoryReservation,
        networkBindings: container.networkBindings || [],
        exitCode: container.exitCode,
        reason: container.reason
      })) || [],
      enableExecuteCommand: task.enableExecuteCommand,
      executionStoppedAt: task.executionStoppedAt,
      group: task.group,
      connectivityAt: task.connectivityAt,
      pullStartedAt: task.pullStartedAt,
      pullStoppedAt: task.pullStoppedAt,
      availabilityZone: task.availabilityZone,
      attributes: task.attributes || []
    };
  }

  /**
   * Get enhanced container details
   * @param {Array} containers - Container array
   * @returns {Promise<Array>} Enhanced container details
   * @private
   */
  async _getContainerDetails(containers) {
    return containers.map(container => ({
      ...container,
      isHealthy: container.healthStatus === 'HEALTHY',
      isRunning: container.lastStatus === 'RUNNING',
      hasNetworkBindings: container.networkBindings && container.networkBindings.length > 0
    }));
  }

  /**
   * Sort tasks by creation time (newest first)
   * @param {Array} tasks - Tasks to sort
   * @returns {Array} Sorted tasks
   * @private
   */
  _sortTasksByCreationTime(tasks) {
    return [...tasks].sort((a, b) => {
      if (!a.createdAt && !b.createdAt) return 0;
      if (!a.createdAt) return 1;
      if (!b.createdAt) return -1;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
  }

  /**
   * Format time ago in a human-readable format
   * @param {Date} date - Date to format
   * @returns {string} Human-readable time ago
   * @private
   */
  _formatTimeAgo(date) {
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  }
}

export default ECSTaskManager; 