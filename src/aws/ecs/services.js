/**
 * @fileoverview ECS service management and rollback operations for taskonaut
 * @author taskonaut
 * @version 1.0.0
 */

import chalk from 'chalk';
import { ECSError, ErrorHandler, ERROR_CODES } from '../../core/errors.js';
import logger from '../../core/logger.js';
import { SpinnerUtils } from '../../ui/spinners.js';
import { awsPrompts } from '../../ui/prompts.js';
import { formatter } from '../../ui/formatters.js';

/**
 * ECS service manager
 */
export class ECSServiceManager {
  /**
   * Create a new ECSServiceManager instance
   * @param {ECS} ecsClient - AWS ECS client
   */
  constructor(ecsClient) {
    this.ecs = ecsClient;
  }

  /**
   * List services in a cluster
   * @param {string} clusterArn - Cluster ARN or name
   * @param {Object} options - Options for listing services
   * @param {boolean} [options.includeDetails=true] - Include detailed service information
   * @param {boolean} [options.quiet=false] - Suppress spinner output
   * @returns {Promise<Array>} Array of service objects
   */
  async listServices(clusterArn, options = {}) {
    const { includeDetails = true, quiet = false } = options;

    try {
      return await SpinnerUtils.withSpinner(
        async () => {
          logger.debug('Fetching ECS services', { cluster: clusterArn });

          // Get service ARNs
          const { serviceArns } = await this.ecs.listServices({
            cluster: clusterArn
          });

          if (!serviceArns || serviceArns.length === 0) {
            logger.warn('No services found', { cluster: clusterArn });
            return [];
          }

          // Get detailed service information if requested
          if (includeDetails) {
            const { services } = await this.ecs.describeServices({
              cluster: clusterArn,
              services: serviceArns
            });

            const formattedServices = services.map(service => this._formatServiceData(service));
            logger.debug('ECS services fetched with details', { count: formattedServices.length });
            return this._sortServicesByName(formattedServices);
          }

          // Return basic service data
          const basicServices = serviceArns.map(arn => ({
            serviceArn: arn,
            serviceName: arn.split('/').pop()
          }));

          logger.debug('ECS services fetched (basic)', { count: basicServices.length });
          return basicServices;
        },
        'Fetching ECS services...',
        quiet ? null : `Found ${serviceArns?.length || 0} services`,
        'Failed to fetch ECS services'
      );
    } catch (error) {
      const ecsError = ErrorHandler.fromAWSError(error, 'list services');
      logger.error('Failed to list ECS services', { 
        cluster: clusterArn, 
        error: ecsError.message 
      });
      throw ecsError;
    }
  }

  /**
   * Get detailed information about a specific service
   * @param {string} clusterArn - Cluster ARN or name
   * @param {string} serviceName - Service name or ARN
   * @returns {Promise<Object>} Detailed service information
   */
  async getServiceDetails(clusterArn, serviceName) {
    try {
      logger.debug('Fetching service details', { 
        cluster: clusterArn, 
        service: serviceName 
      });

      const { services } = await this.ecs.describeServices({
        cluster: clusterArn,
        services: [serviceName]
      });

      if (!services || services.length === 0) {
        throw new ECSError(
          `Service '${serviceName}' not found in cluster '${clusterArn}'`,
          ERROR_CODES.ECS_SERVICE_NOT_FOUND,
          { cluster: clusterArn, service: serviceName }
        );
      }

      const service = this._formatServiceData(services[0]);

      logger.debug('Service details fetched', { 
        cluster: clusterArn,
        service: service.serviceName,
        status: service.status 
      });

      return service;
    } catch (error) {
      if (error instanceof ECSError) throw error;
      
      const ecsError = ErrorHandler.fromAWSError(error, 'get service details');
      logger.error('Failed to get service details', { 
        cluster: clusterArn,
        service: serviceName,
        error: ecsError.message 
      });
      throw ecsError;
    }
  }

  /**
   * Select a service interactively
   * @param {string} clusterArn - Cluster ARN or name
   * @param {Object} options - Selection options
   * @param {boolean} [options.allowBack=false] - Allow back navigation
   * @returns {Promise<string|'__BACK__'>} Selected service name or back signal
   */
  async selectService(clusterArn, options = {}) {
    const { allowBack = false } = options;

    try {
      logger.debug('Starting service selection', { cluster: clusterArn });

      const services = await this.listServices(clusterArn, { quiet: true });

      if (!services || services.length === 0) {
        throw new ECSError(
          'No services found in the cluster',
          ERROR_CODES.ECS_SERVICE_NOT_FOUND,
          { cluster: clusterArn }
        );
      }

      // Format choices for prompt with enhanced styling
      const choices = services.map(service => {
        // Enhanced status indicators with colors
        let statusIcon = '⚪';
        let statusColor = 'gray';
        
        switch (service.status) {
          case 'ACTIVE':
            statusIcon = '🟢';
            statusColor = 'green';
            break;
          case 'DRAINING':
            statusIcon = '🟡';
            statusColor = 'yellow';
            break;
          case 'INACTIVE':
            statusIcon = '🔴';
            statusColor = 'red';
            break;
          default:
            statusIcon = '⚪';
            statusColor = 'gray';
        }

        // Health indicators based on task counts
        const isHealthy = service.runningCount === service.desiredCount && service.runningCount > 0;
        const hasIssues = service.runningCount < service.desiredCount;
        
        let healthIcon = '';
        if (isHealthy) {
          healthIcon = '💚';
        } else if (hasIssues) {
          healthIcon = '⚠️';
        } else {
          healthIcon = '⏸️';
        }

        // Format task definition info with colors
        const familyName = chalk.bold.magenta(service.taskDefinitionFamily); // Highlight family in magenta
        const revisionNumber = chalk.bold.yellow(`:${service.taskDefinitionRevision}`); // Highlight revision in yellow
        const taskDefDisplay = `${familyName}${revisionNumber}`;
        
        // Format task counts with visual indicators and colors
        const runningCount = chalk.bold.green(service.runningCount); // Running count in green
        const desiredCount = chalk.bold.blue(service.desiredCount); // Desired count in blue
        const taskCount = `${runningCount}/${desiredCount}`;
        const taskDisplay = service.runningCount === service.desiredCount 
          ? `✅ ${taskCount}` 
          : `⚠️ ${taskCount}`;

        // Create enhanced display name with colors
        const coloredServiceName = chalk.bold.cyan(service.serviceName); // Service name in bright cyan
        const displayName = `${statusIcon}${healthIcon} ${coloredServiceName}`;
        
        // Create detailed description with better visual hierarchy and colors
        const coloredStatus = chalk[statusColor](service.status); // Apply status color
        const statusLine = `${coloredStatus} • ${taskDefDisplay}`;
        
        // Color-coded task and launch type information
        const coloredTaskDisplay = chalk.white(taskDisplay); // Task display in white for readability
        const launchTypeColor = service.launchType === 'FARGATE' ? 'blue' : 'yellow';
        const coloredLaunchType = chalk[launchTypeColor](`🚀 ${service.launchType || 'EC2'}`);
        const taskLine = `📋 ${coloredTaskDisplay} tasks • ${coloredLaunchType}`;
        
        // Add platform version for Fargate services with color
        let platformInfo = '';
        if (service.launchType === 'FARGATE' && service.platformVersion) {
          const coloredPlatformVersion = chalk.gray(`📦 ${service.platformVersion}`);
          platformInfo = ` • ${coloredPlatformVersion}`;
        }
        
        const description = `${statusLine}\n    ${taskLine}${platformInfo}`;
        
        return {
          name: displayName,
          value: service.serviceName,
          short: chalk.cyan(service.serviceName), // Short name also colored
          description: description
        };
      });

      const selectedService = await awsPrompts.select({
        message: 'Select ECS service',
        choices,
        allowBack
      });

      if (selectedService === '__BACK__') {
        return '__BACK__';
      }

      const service = services.find(s => s.serviceName === selectedService);
      logger.info('⚙️ Selected service', { 
        name: service?.serviceName,
        status: service?.status,
        runningCount: service?.runningCount,
        desiredCount: service?.desiredCount
      });

      return selectedService;
    } catch (error) {
      if (error instanceof ECSError) throw error;
      
      const ecsError = ErrorHandler.fromAWSError(error, 'service selection');
      logger.error('Failed to select service', { 
        cluster: clusterArn, 
        error: ecsError.message 
      });
      throw ecsError;
    }
  }

  /**
   * Update a service with a new task definition (rollback operation)
   * @param {string} clusterArn - Cluster ARN or name
   * @param {string} serviceName - Service name
   * @param {string} taskDefinitionArn - Target task definition ARN
   * @param {Object} options - Update options
   * @param {boolean} [options.waitForDeployment=false] - Wait for deployment to complete
   * @returns {Promise<Object>} Update service response
   */
  async updateService(clusterArn, serviceName, taskDefinitionArn, options = {}) {
    const { waitForDeployment = false } = options;

    try {
      logger.info('🔄 Updating service', {
        cluster: clusterArn,
        service: serviceName,
        taskDefinition: taskDefinitionArn
      });

      const response = await this.ecs.updateService({
        cluster: clusterArn,
        service: serviceName,
        taskDefinition: taskDefinitionArn
      });

      logger.success('Service update initiated', {
        cluster: clusterArn,
        service: serviceName,
        deploymentId: response.service.deployments?.[0]?.id
      });

      if (waitForDeployment) {
        await this._waitForDeployment(clusterArn, serviceName);
      }

      return response;
    } catch (error) {
      const ecsError = ErrorHandler.fromAWSError(error, 'update service');
      logger.error('Failed to update service', { 
        cluster: clusterArn,
        service: serviceName,
        taskDefinition: taskDefinitionArn,
        error: ecsError.message 
      });
      throw ecsError;
    }
  }

  /**
   * Format service data for consistent output
   * @param {Object} service - Raw service data from AWS
   * @returns {Object} Formatted service data
   * @private
   */
  _formatServiceData(service) {
    const taskDefParts = service.taskDefinition.split('/').pop().split(':');
    const family = taskDefParts[0];
    const revision = parseInt(taskDefParts[1]);

    return {
      serviceName: service.serviceName,
      serviceArn: service.serviceArn,
      taskDefinition: service.taskDefinition,
      taskDefinitionFamily: family,
      taskDefinitionRevision: revision,
      status: service.status,
      runningCount: service.runningCount,
      pendingCount: service.pendingCount,
      desiredCount: service.desiredCount,
      platformVersion: service.platformVersion,
      createdAt: service.createdAt,
      updatedAt: service.updatedAt,
      launchType: service.launchType,
      capacityProviderStrategy: service.capacityProviderStrategy || [],
      deployments: service.deployments?.map(deployment => ({
        id: deployment.id,
        status: deployment.status,
        taskDefinition: deployment.taskDefinition,
        desiredCount: deployment.desiredCount,
        runningCount: deployment.runningCount,
        pendingCount: deployment.pendingCount,
        createdAt: deployment.createdAt,
        updatedAt: deployment.updatedAt
      })) || [],
      tags: service.tags || []
    };
  }

  /**
   * Sort services by name alphabetically
   * @param {Array} services - Services to sort
   * @returns {Array} Sorted services
   * @private
   */
  _sortServicesByName(services) {
    return [...services].sort((a, b) => 
      a.serviceName.localeCompare(b.serviceName)
    );
  }

  /**
   * Wait for service deployment to complete
   * @param {string} clusterArn - Cluster ARN or name
   * @param {string} serviceName - Service name
   * @param {number} [timeoutMinutes=10] - Timeout in minutes
   * @returns {Promise<void>}
   * @private
   */
  async _waitForDeployment(clusterArn, serviceName, timeoutMinutes = 10) {
    const timeoutMs = timeoutMinutes * 60 * 1000;
    const startTime = Date.now();

    logger.info('⏳ Waiting for deployment to complete...');

    while (Date.now() - startTime < timeoutMs) {
      try {
        const service = await this.getServiceDetails(clusterArn, serviceName);
        const primaryDeployment = service.deployments.find(d => d.status === 'PRIMARY');
        
        if (primaryDeployment && 
            primaryDeployment.runningCount === primaryDeployment.desiredCount &&
            primaryDeployment.pendingCount === 0) {
          logger.success('✅ Deployment completed successfully');
          return;
        }

        await new Promise(resolve => setTimeout(resolve, 15000)); // Wait 15 seconds
      } catch (error) {
        logger.warn('Error checking deployment status', { error: error.message });
        break;
      }
    }

    logger.warn('⏰ Deployment monitoring timed out');
  }
}

/**
 * ECS task definition manager for rollback operations
 */
export class ECSTaskDefinitionManager {
  /**
   * Create a new ECSTaskDefinitionManager instance
   * @param {ECS} ecsClient - AWS ECS client
   */
  constructor(ecsClient) {
    this.ecs = ecsClient;
  }

  /**
   * List task definition revisions for a family
   * @param {string} family - Task definition family name
   * @param {Object} options - Options for listing revisions
   * @param {string} [options.status='ACTIVE'] - Task definition status
   * @param {number} [options.maxResults=10] - Maximum results to return
   * @param {boolean} [options.quiet=false] - Suppress spinner output
   * @returns {Promise<Array>} Array of task definition revisions
   */
  async listTaskDefinitionRevisions(family, options = {}) {
    const { status = 'ACTIVE', maxResults = 10, quiet = false } = options;

    try {
      return await SpinnerUtils.withSpinner(
        async () => {
          logger.debug('Fetching task definition revisions', { family, status });

          const { taskDefinitionArns } = await this.ecs.listTaskDefinitions({
            familyPrefix: family,
            status,
            sort: 'DESC',
            maxResults
          });

          if (!taskDefinitionArns || taskDefinitionArns.length === 0) {
            logger.warn('No task definition revisions found', { family });
            return [];
          }

          // Get detailed info for each task definition
          const revisions = await Promise.allSettled(
            taskDefinitionArns.map(async (arn) => {
              const { taskDefinition } = await this.ecs.describeTaskDefinition({
                taskDefinition: arn
              });
              
              return this._formatTaskDefinitionData(taskDefinition);
            })
          );

          const validRevisions = revisions
            .filter(result => result.status === 'fulfilled')
            .map(result => result.value)
            .sort((a, b) => b.revision - a.revision);

          logger.debug('Task definition revisions fetched', { 
            family, 
            count: validRevisions.length 
          });

          return validRevisions;
        },
        'Fetching task definition revisions...',
        quiet ? null : `Found ${taskDefinitionArns?.length || 0} revisions`,
        'Failed to fetch task definition revisions'
      );
    } catch (error) {
      const ecsError = ErrorHandler.fromAWSError(error, 'list task definition revisions');
      logger.error('Failed to list task definition revisions', { 
        family, 
        error: ecsError.message 
      });
      throw ecsError;
    }
  }

  /**
   * Format task definition revision choices for selection
   * @param {Array} revisions - Task definition revisions
   * @param {number} currentRevision - Current revision number to exclude
   * @returns {Array} Formatted choices for prompt
   * @private
   */
  _formatRevisionChoices(revisions, currentRevision) {
    return revisions.map(revision => {
      // Status indicator with colors
      let statusIcon = '⚪';
      let statusColor = 'gray';
      
      switch (revision.status) {
        case 'ACTIVE':
          statusIcon = '🟢';
          statusColor = 'green';
          break;
        case 'INACTIVE':
          statusIcon = '🔴';
          statusColor = 'red';
          break;
        default:
          statusIcon = '⚪';
          statusColor = 'gray';
      }

      // Highlight if this is the previous revision (likely rollback target)
      const isPrevious = revision.revision === currentRevision - 1;
      const revisionIcon = isPrevious ? '⭐' : '📋';

      // Format creation time with color
      const createdAt = new Date(revision.registeredAt);
      const timeAgo = this._formatTimeAgo(createdAt);
      const coloredTimeAgo = chalk.gray(timeAgo); // Time ago in gray
      
      // Format CPU and memory info with colors
      const cpuDisplay = revision.cpu ? chalk.blue(`💻 ${revision.cpu} CPU`) : '';
      const memoryDisplay = revision.memory ? chalk.green(`🧠 ${revision.memory}MB`) : '';
      const resourceInfo = [cpuDisplay, memoryDisplay].filter(Boolean).join(' • ');

      // Container count with color
      const containerCount = revision.containerDefinitions.length;
      const coloredContainerInfo = chalk.yellow(`📦 ${containerCount} container${containerCount !== 1 ? 's' : ''}`);

      // Create enhanced display name with colors
      const revisionNumber = chalk.bold.cyan(revision.revision); // Revision number in bright cyan
      const previousLabel = isPrevious ? chalk.bold.yellow(' (Previous)') : ''; // Previous label in yellow
      const displayName = `${statusIcon}${revisionIcon} Revision ${revisionNumber}${previousLabel}`;
      
      // Create detailed description with colors
      const coloredStatus = chalk[statusColor](revision.status); // Apply status color
      const statusLine = `${coloredStatus} • Created ${coloredTimeAgo}`;
      const detailsLine = [resourceInfo, coloredContainerInfo].filter(Boolean).join(' • ');
      const description = `${statusLine}\n    ${detailsLine}`;
      
      return {
        name: displayName,
        value: revision,
        short: chalk.cyan(`Rev ${revision.revision}`), // Short name also colored
        description: description
      };
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
    const diffWeeks = Math.floor(diffMs / (86400000 * 7));
    const diffMonths = Math.floor(diffMs / (86400000 * 30));

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    if (diffWeeks < 4) return `${diffWeeks}w ago`;
    if (diffMonths < 12) return `${diffMonths}mo ago`;
    return date.toLocaleDateString();
  }

  /**
   * Compare two task definition revisions
   * @param {string} currentArn - Current task definition ARN
   * @param {string} targetArn - Target task definition ARN
   * @param {Object} options - Comparison options
   * @param {boolean} [options.quiet=false] - Suppress spinner output
   * @returns {Promise<Object>} Comparison result
   */
  async compareTaskDefinitions(currentArn, targetArn, options = {}) {
    const { quiet = false } = options;

    try {
      return await SpinnerUtils.withSpinner(
        async () => {
          logger.debug('Comparing task definitions', { current: currentArn, target: targetArn });

          const [currentResponse, targetResponse] = await Promise.all([
            this.ecs.describeTaskDefinition({ taskDefinition: currentArn }),
            this.ecs.describeTaskDefinition({ taskDefinition: targetArn })
          ]);

          const current = this._formatTaskDefinitionData(currentResponse.taskDefinition);
          const target = this._formatTaskDefinitionData(targetResponse.taskDefinition);
          
          const differences = this._findTaskDefinitionDifferences(current, target);

          logger.debug('Task definitions compared', { 
            current: current.revision,
            target: target.revision,
            differences: differences.length 
          });

          return { current, target, differences };
        },
        'Comparing task definitions...',
        quiet ? null : 'Task definitions compared',
        'Failed to compare task definitions'
      );
    } catch (error) {
      const ecsError = ErrorHandler.fromAWSError(error, 'compare task definitions');
      logger.error('Failed to compare task definitions', { 
        current: currentArn,
        target: targetArn,
        error: ecsError.message 
      });
      throw ecsError;
    }
  }

  /**
   * Display rollback preview with comparison details
   * @param {Object} comparison - Task definition comparison
   * @param {string} serviceName - Service name
   */
  displayRollbackPreview(comparison, serviceName) {
    const { current, target, differences } = comparison;

    console.log(formatter.formatHeader('🔄 Rollback Preview', { color: 'primary' }));
    console.log(formatter.formatKeyValue({
      'Service': serviceName,
      'Current Revision': `${current.family}:${current.revision}`,
      'Target Revision': `${target.family}:${target.revision}`,
      'Current Created': new Date(current.registeredAt).toLocaleString(),
      'Target Created': new Date(target.registeredAt).toLocaleString()
    }));

    if (differences.length > 0) {
      console.log('\n' + formatter.formatStatus('Changes Detected:', 'warning', '⚠️'));
      
      differences.forEach(diff => {
        switch (diff.type) {
          case 'image':
            console.log(`  🐳 ${diff.container}:`);
            console.log(`     Current: ${diff.current}`);
            console.log(`     Target:  ${diff.target}`);
            break;
          case 'cpu':
            console.log(`  💻 CPU: ${diff.current} → ${diff.target}`);
            break;
          case 'memory':
            console.log(`  🧠 Memory: ${diff.current} → ${diff.target}`);
            break;
          case 'environment':
            console.log(`  🔧 Environment variables changed for ${diff.container}`);
            break;
        }
      });
    } else {
      console.log('\n' + formatter.formatStatus('No significant changes detected', 'info', '✨'));
    }
  }

  /**
   * Format task definition data for consistent output
   * @param {Object} taskDef - Raw task definition data from AWS
   * @returns {Object} Formatted task definition data
   * @private
   */
  _formatTaskDefinitionData(taskDef) {
    return {
      taskDefinitionArn: taskDef.taskDefinitionArn,
      family: taskDef.family,
      revision: taskDef.revision,
      status: taskDef.status,
      cpu: taskDef.cpu,
      memory: taskDef.memory,
      networkMode: taskDef.networkMode,
      registeredAt: taskDef.registeredAt,
      containerDefinitions: taskDef.containerDefinitions?.map(container => ({
        name: container.name,
        image: container.image,
        cpu: container.cpu,
        memory: container.memory,
        memoryReservation: container.memoryReservation,
        essential: container.essential,
        portMappings: container.portMappings || [],
        environment: container.environment || [],
        secrets: container.secrets || []
      })) || []
    };
  }

  /**
   * Find differences between two task definitions
   * @param {Object} current - Current task definition
   * @param {Object} target - Target task definition
   * @returns {Array} Array of differences
   * @private
   */
  _findTaskDefinitionDifferences(current, target) {
    const differences = [];

    // Compare CPU and memory
    if (current.cpu !== target.cpu) {
      differences.push({
        type: 'cpu',
        current: current.cpu,
        target: target.cpu
      });
    }

    if (current.memory !== target.memory) {
      differences.push({
        type: 'memory',
        current: current.memory,
        target: target.memory
      });
    }

    // Compare container images
    current.containerDefinitions.forEach(currentContainer => {
      const targetContainer = target.containerDefinitions.find(
        t => t.name === currentContainer.name
      );
      
      if (targetContainer && currentContainer.image !== targetContainer.image) {
        differences.push({
          type: 'image',
          container: currentContainer.name,
          current: currentContainer.image,
          target: targetContainer.image
        });
      }

      // Check environment variables
      if (targetContainer && 
          JSON.stringify(currentContainer.environment) !== JSON.stringify(targetContainer.environment)) {
        differences.push({
          type: 'environment',
          container: currentContainer.name
        });
      }
    });

    return differences;
  }
}

export default ECSServiceManager; 