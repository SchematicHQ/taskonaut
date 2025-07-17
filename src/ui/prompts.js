/**
 * @fileoverview User interface prompts and interactions for taskonaut
 * @author taskonaut
 * @version 1.0.0
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import { UserCancelledError, ValidationError } from '../core/errors.js';
import logger from '../core/logger.js';
import config from '../core/config.js';

/**
 * Prompt types and configurations
 */
const PROMPT_TYPES = {
  SELECT: 'list',
  MULTI_SELECT: 'checkbox',
  CONFIRM: 'confirm',
  INPUT: 'input',
  PASSWORD: 'password',
  AUTOCOMPLETE: 'autocomplete'
};

/**
 * Default prompt options
 */
const DEFAULT_OPTIONS = {
  pageSize: config.get('cli.pageSize') || 10,
  loop: false,
  validate: (input) => input !== undefined && input !== null,
  filter: (input) => input?.trim ? input.trim() : input
};

/**
 * User interface prompts manager
 */
export class PromptsManager {
  /**
   * Create a new PromptsManager instance
   * @param {Object} options - Configuration options
   */
  constructor(options = {}) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options
    };
  }

  /**
   * Display a selection list prompt
   * @param {Object} options - Prompt options
   * @param {string} options.message - Prompt message
   * @param {Array} options.choices - Array of choices
   * @param {string} [options.name='selection'] - Property name for result
   * @param {boolean} [options.allowBack=false] - Allow back navigation
   * @param {*} [options.defaultValue] - Default selection
   * @returns {Promise<*>} Selected value
   */
  async select(options) {
    const {
      message,
      choices,
      name = 'selection',
      allowBack = false,
      defaultValue,
      ...restOptions
    } = options;

    if (!Array.isArray(choices) || choices.length === 0) {
      throw new ValidationError('Choices array is required and cannot be empty');
    }

    // Add back option if requested with enhanced styling
    const finalChoices = allowBack 
      ? [{ name: '◀️ Back', value: '__back__', short: 'Back' }, ...choices]
      : choices;

    const promptConfig = {
      type: PROMPT_TYPES.SELECT,
      name,
      message: this._formatMessage(message),
      choices: finalChoices,
      pageSize: this.options.pageSize,
      loop: this.options.loop,
      default: defaultValue,
      ...restOptions
    };

    try {
      const result = await inquirer.prompt([promptConfig]);
      
      if (result[name] === '__back__') {
        return '__BACK__';
      }

      logger.debug('User selection made', { 
        message, 
        selection: result[name],
        choicesCount: choices.length 
      });

      return result[name];
    } catch (error) {
      if (error.name === 'ExitPromptError') {
        throw new UserCancelledError('Operation cancelled by user');
      }
      throw error;
    }
  }

  /**
   * Display a multi-selection checkbox prompt
   * @param {Object} options - Prompt options
   * @param {string} options.message - Prompt message
   * @param {Array} options.choices - Array of choices
   * @param {string} [options.name='selections'] - Property name for result
   * @param {Array} [options.defaultValues] - Default selections
   * @param {number} [options.minRequired=0] - Minimum required selections
   * @param {number} [options.maxAllowed] - Maximum allowed selections
   * @returns {Promise<Array>} Array of selected values
   */
  async multiSelect(options) {
    const {
      message,
      choices,
      name = 'selections',
      defaultValues = [],
      minRequired = 0,
      maxAllowed,
      ...restOptions
    } = options;

    if (!Array.isArray(choices) || choices.length === 0) {
      throw new ValidationError('Choices array is required and cannot be empty');
    }

    const promptConfig = {
      type: PROMPT_TYPES.MULTI_SELECT,
      name,
      message: this._formatMessage(message),
      choices,
      pageSize: this.options.pageSize,
      loop: this.options.loop,
      default: defaultValues,
      validate: (selections) => {
        if (selections.length < minRequired) {
          return `Please select at least ${minRequired} option(s)`;
        }
        if (maxAllowed && selections.length > maxAllowed) {
          return `Please select no more than ${maxAllowed} option(s)`;
        }
        return true;
      },
      ...restOptions
    };

    try {
      const result = await inquirer.prompt([promptConfig]);
      
      logger.debug('User multi-selection made', { 
        message, 
        selections: result[name],
        count: result[name].length 
      });

      return result[name];
    } catch (error) {
      if (error.name === 'ExitPromptError') {
        throw new UserCancelledError('Operation cancelled by user');
      }
      throw error;
    }
  }

  /**
   * Display a confirmation prompt
   * @param {Object} options - Prompt options
   * @param {string} options.message - Prompt message
   * @param {boolean} [options.defaultValue=false] - Default value
   * @param {string} [options.name='confirmed'] - Property name for result
   * @returns {Promise<boolean>} User confirmation
   */
  async confirm(options) {
    const {
      message,
      defaultValue = false,
      name = 'confirmed',
      ...restOptions
    } = options;

    // Skip confirmation if configured to do so
    if (!config.shouldConfirmActions()) {
      logger.debug('Confirmation skipped (auto-confirm enabled)', { message });
      return true;
    }

    const promptConfig = {
      type: PROMPT_TYPES.CONFIRM,
      name,
      message: this._formatMessage(message),
      default: defaultValue,
      ...restOptions
    };

    try {
      const result = await inquirer.prompt([promptConfig]);
      
      logger.debug('User confirmation', { 
        message, 
        confirmed: result[name] 
      });

      return result[name];
    } catch (error) {
      if (error.name === 'ExitPromptError') {
        throw new UserCancelledError('Operation cancelled by user');
      }
      throw error;
    }
  }

  /**
   * Display a text input prompt
   * @param {Object} options - Prompt options
   * @param {string} options.message - Prompt message
   * @param {string} [options.name='input'] - Property name for result
   * @param {string} [options.defaultValue] - Default value
   * @param {Function} [options.validate] - Validation function
   * @param {Function} [options.filter] - Filter function
   * @returns {Promise<string>} User input
   */
  async input(options) {
    const {
      message,
      name = 'input',
      defaultValue,
      validate = this.options.validate,
      filter = this.options.filter,
      ...restOptions
    } = options;

    const promptConfig = {
      type: PROMPT_TYPES.INPUT,
      name,
      message: this._formatMessage(message),
      default: defaultValue,
      validate,
      filter,
      ...restOptions
    };

    try {
      const result = await inquirer.prompt([promptConfig]);
      
      logger.debug('User input received', { 
        message, 
        hasInput: !!result[name] 
      });

      return result[name];
    } catch (error) {
      if (error.name === 'ExitPromptError') {
        throw new UserCancelledError('Operation cancelled by user');
      }
      throw error;
    }
  }

  /**
   * Display a password input prompt
   * @param {Object} options - Prompt options
   * @param {string} options.message - Prompt message
   * @param {string} [options.name='password'] - Property name for result
   * @param {Function} [options.validate] - Validation function
   * @returns {Promise<string>} User password input
   */
  async password(options) {
    const {
      message,
      name = 'password',
      validate = (input) => input && input.length > 0 ? true : 'Password cannot be empty',
      ...restOptions
    } = options;

    const promptConfig = {
      type: PROMPT_TYPES.PASSWORD,
      name,
      message: this._formatMessage(message),
      mask: '*',
      validate,
      ...restOptions
    };

    try {
      const result = await inquirer.prompt([promptConfig]);
      
      logger.debug('Password input received', { message });

      return result[name];
    } catch (error) {
      if (error.name === 'ExitPromptError') {
        throw new UserCancelledError('Operation cancelled by user');
      }
      throw error;
    }
  }

  /**
   * Display a progress-aware selection from async data
   * @param {Object} options - Prompt options
   * @param {string} options.message - Prompt message
   * @param {Function} options.dataProvider - Async function that returns choices
   * @param {string} [options.loadingMessage] - Loading message
   * @param {boolean} [options.allowBack=false] - Allow back navigation
   * @returns {Promise<*>} Selected value
   */
  async selectFromAsync(options) {
    const {
      message,
      dataProvider,
      loadingMessage = 'Loading options...',
      allowBack = false,
      ...selectOptions
    } = options;

    try {
      // Show loading message
      if (!config.isQuiet()) {
        logger.info(loadingMessage);
      }

      // Load data
      const choices = await dataProvider();
      
      if (!Array.isArray(choices) || choices.length === 0) {
        throw new ValidationError('No options available');
      }

      // Display selection
      return await this.select({
        message,
        choices,
        allowBack,
        ...selectOptions
      });
    } catch (error) {
      if (error instanceof UserCancelledError) {
        throw error;
      }
      
      logger.error('Failed to load selection options', { error: error.message });
      throw new ValidationError('Failed to load options. Please try again.');
    }
  }

  /**
   * Format a prompt message with consistent styling
   * @param {string} message - Message to format
   * @returns {string} Formatted message
   * @private
   */
  _formatMessage(message) {
    // Add question mark if not present and ensure it ends properly
    const formatted = message.endsWith('?') ? message : `${message}:`;
    return `🤔 ${formatted}`;
  }
}

/**
 * Specialized prompts for common AWS/ECS operations
 */
export class AWSPrompts extends PromptsManager {
  /**
   * Prompt for AWS profile selection
   * @param {Array<string>} profiles - Available profiles
   * @param {string} [defaultProfile] - Default profile
   * @returns {Promise<string>} Selected profile
   */
  async selectProfile(profiles, defaultProfile = 'default') {
    if (!profiles || profiles.length === 0) {
      throw new ValidationError('No AWS profiles available');
    }

    const choices = profiles.map(profile => ({
      name: profile === defaultProfile ? `${profile} (default)` : profile,
      value: profile
    }));

    return await this.select({
      message: 'Select AWS profile',
      choices,
      defaultValue: defaultProfile
    });
  }

  /**
   * Prompt for AWS region selection
   * @param {Array<string>} regions - Available regions
   * @param {string} [defaultRegion] - Default region
   * @returns {Promise<string>} Selected region
   */
  async selectRegion(regions, defaultRegion) {
    const choices = regions.map(region => ({
      name: region === defaultRegion ? `${region} (default)` : region,
      value: region
    }));

    return await this.select({
      message: 'Select AWS region',
      choices,
      defaultValue: defaultRegion
    });
  }

  /**
   * Prompt for ECS cluster selection
   * @param {Array} clusters - Available clusters
   * @param {boolean} [allowBack=false] - Allow back navigation
   * @returns {Promise<string>} Selected cluster ARN
   */
  async selectCluster(clusters, allowBack = false) {
    if (!clusters || clusters.length === 0) {
      throw new ValidationError('No ECS clusters found');
    }

    const choices = clusters.map(cluster => ({
      name: `${cluster.clusterName} (${cluster.status}) - ${cluster.runningTasksCount} running tasks`,
      value: cluster.clusterArn,
      short: cluster.clusterName
    }));

    return await this.select({
      message: 'Select ECS cluster',
      choices,
      allowBack
    });
  }

  /**
   * Prompt for ECS task selection
   * @param {Array} tasks - Available tasks
   * @param {boolean} [allowBack=false] - Allow back navigation
   * @returns {Promise<string>} Selected task ARN
   */
  async selectTask(tasks, allowBack = false) {
    if (!tasks || tasks.length === 0) {
      throw new ValidationError('No running tasks found');
    }

    const choices = tasks.map(task => {
      const shortId = task.taskArn.split('/').pop().substring(0, 8);
      const createdAt = new Date(task.createdAt).toLocaleString();
      
      return {
        name: `[${shortId}] ${task.taskDefinitionArn.split('/')[1]} (${task.lastStatus}) - Created: ${createdAt}`,
        value: task.taskArn,
        short: shortId
      };
    });

    return await this.select({
      message: 'Select ECS task',
      choices,
      allowBack
    });
  }

  /**
   * Prompt for container selection
   * @param {Array} containers - Available containers
   * @param {boolean} [allowBack=false] - Allow back navigation
   * @returns {Promise<string>} Selected container name
   */
  async selectContainer(containers, allowBack = false) {
    if (!containers || containers.length === 0) {
      throw new ValidationError('No containers found in task');
    }

    const choices = containers.map(container => {
      // Color-coded status
      let statusColor = 'gray';
      switch (container.lastStatus) {
        case 'RUNNING':
          statusColor = 'green';
          break;
        case 'PENDING':
          statusColor = 'yellow';
          break;
        case 'STOPPED':
          statusColor = 'red';
          break;
        default:
          statusColor = 'gray';
      }

      // Enhanced container display with colors
      const containerName = chalk.bold.cyan(container.name); // Container name in bright cyan
      const coloredStatus = chalk[statusColor](`(${container.lastStatus})`); // Status with appropriate color
      const cpuInfo = chalk.blue(`CPU: ${container.cpu || 'N/A'}`); // CPU in blue
      const memoryInfo = chalk.green(`Memory: ${container.memory || 'N/A'}`); // Memory in green
      
      return {
        name: `${containerName} ${coloredStatus} - ${cpuInfo}, ${memoryInfo}`,
        value: container.name,
        short: chalk.cyan(container.name) // Short name also colored
      };
    });

    return await this.select({
      message: 'Select container',
      choices,
      allowBack
    });
  }

  /**
   * Prompt for service selection
   * @param {Array} services - Available services
   * @param {boolean} [allowBack=false] - Allow back navigation
   * @returns {Promise<string>} Selected service name
   */
  async selectService(services, allowBack = false) {
    if (!services || services.length === 0) {
      throw new ValidationError('No services found');
    }

    // Services are now expected to come with enhanced formatting from the service manager
    // The choices should already be formatted with colors and detailed descriptions
    const choices = services;

    return await this.select({
      message: 'Select ECS service',
      choices,
      allowBack
    });
  }

  /**
   * Confirm a potentially destructive action
   * @param {string} action - Action description
   * @param {string} [target] - Target of the action
   * @returns {Promise<boolean>} User confirmation
   */
  async confirmAction(action, target) {
    const message = target 
      ? `Are you sure you want to ${action} '${target}'?`
      : `Are you sure you want to ${action}?`;

    return await this.confirm({
      message,
      defaultValue: false
    });
  }

  /**
   * Confirm rollback operation
   * @param {string} serviceName - Service name
   * @param {string} currentRevision - Current revision
   * @param {string} targetRevision - Target revision
   * @returns {Promise<boolean>} User confirmation
   */
  async confirmRollback(serviceName, currentRevision, targetRevision) {
    const message = `Roll back service '${serviceName}' from revision ${currentRevision} to ${targetRevision}?`;
    
    return await this.confirm({
      message,
      defaultValue: false
    });
  }
}

// Create default instances
const prompts = new PromptsManager();
const awsPrompts = new AWSPrompts();

export { PROMPT_TYPES, prompts, awsPrompts };
export default prompts; 