/**
 * @fileoverview ECS cluster management operations for taskonaut
 * @author taskonaut
 * @version 1.0.0
 */

import { ECSError, ErrorHandler, ERROR_CODES } from '../../core/errors.js';
import logger from '../../core/logger.js';
import { SpinnerUtils } from '../../ui/spinners.js';
import { awsPrompts } from '../../ui/prompts.js';
import config from '../../core/config.js';

/**
 * ECS cluster manager
 */
export class ECSClusterManager {
  /**
   * Create a new ECSClusterManager instance
   * @param {ECS} ecsClient - AWS ECS client
   */
  constructor(ecsClient) {
    this.ecs = ecsClient;
  }

  /**
   * List all ECS clusters with detailed information
   * @param {Object} options - Options for listing clusters
   * @param {boolean} [options.includeMetrics=true] - Include cluster metrics
   * @param {boolean} [options.quiet=false] - Suppress spinner output
   * @returns {Promise<Array>} Array of cluster objects with details
   */
  async listClusters(options = {}) {
    const { includeMetrics = true, quiet = false } = options;

    try {
      const clusters = await SpinnerUtils.withSpinner(
        async () => {
          logger.debug('Fetching ECS clusters');
          
          // Get cluster ARNs
          const { clusterArns } = await this.ecs.listClusters({});
          
          if (!clusterArns || clusterArns.length === 0) {
            logger.warn('No ECS clusters found');
            return [];
          }

          // Get cluster details
          const { clusters } = await this.ecs.describeClusters({
            clusters: clusterArns,
            include: ['STATISTICS', 'CONFIGURATIONS']
          });

          logger.debug('ECS clusters fetched', { count: clusters.length });
          return clusters;
        },
        'Fetching ECS clusters...',
        quiet ? null : `Found ${clusterArns?.length || 0} clusters`,
        'Failed to fetch ECS clusters'
      );

      // Enhance cluster data with additional metrics if requested
      if (includeMetrics && clusters.length > 0) {
        return await this._enhanceClusterData(clusters, quiet);
      }

      return this._formatClusterData(clusters);
    } catch (error) {
      const ecsError = ErrorHandler.fromAWSError(error, 'list clusters');
      logger.error('Failed to list ECS clusters', { error: ecsError.message });
      throw ecsError;
    }
  }

  /**
   * Get detailed information about a specific cluster
   * @param {string} clusterIdentifier - Cluster name or ARN
   * @param {Object} options - Options for cluster details
   * @param {boolean} [options.includeServices=false] - Include services information
   * @param {boolean} [options.includeTasks=false] - Include tasks information
   * @returns {Promise<Object>} Detailed cluster information
   */
  async getClusterDetails(clusterIdentifier, options = {}) {
    const { includeServices = false, includeTasks = false } = options;

    try {
      logger.debug('Fetching cluster details', { cluster: clusterIdentifier });

      const { clusters } = await this.ecs.describeClusters({
        clusters: [clusterIdentifier],
        include: ['STATISTICS', 'CONFIGURATIONS']
      });

      if (!clusters || clusters.length === 0) {
        throw new ECSError(
          `Cluster '${clusterIdentifier}' not found`,
          ERROR_CODES.ECS_CLUSTER_NOT_FOUND,
          { cluster: clusterIdentifier }
        );
      }

      const cluster = clusters[0];
      const result = this._formatSingleCluster(cluster);

      // Add additional information if requested
      if (includeServices) {
        result.services = await this._getClusterServices(clusterIdentifier);
      }

      if (includeTasks) {
        result.tasks = await this._getClusterTasks(clusterIdentifier);
      }

      logger.debug('Cluster details fetched', { 
        cluster: clusterIdentifier,
        status: result.status 
      });

      return result;
    } catch (error) {
      if (error instanceof ECSError) throw error;
      
      const ecsError = ErrorHandler.fromAWSError(error, 'get cluster details');
      logger.error('Failed to get cluster details', { 
        cluster: clusterIdentifier,
        error: ecsError.message 
      });
      throw ecsError;
    }
  }

  /**
   * Select a cluster interactively
   * @param {Object} options - Selection options
   * @param {boolean} [options.allowBack=false] - Allow back navigation
   * @param {boolean} [options.sortByActivity=true] - Sort by activity level
   * @returns {Promise<string>} Selected cluster ARN
   */
  async selectCluster(options = {}) {
    const { allowBack = false, sortByActivity = true } = options;

    try {
      logger.debug('Starting cluster selection');

      const clusters = await this.listClusters({ quiet: true });
      
      if (!clusters || clusters.length === 0) {
        throw new ECSError(
          'No ECS clusters found in the current region',
          ERROR_CODES.ECS_CLUSTER_NOT_FOUND
        );
      }

      // Sort clusters if requested
      let sortedClusters = clusters;
      if (sortByActivity) {
        sortedClusters = this._sortClustersByActivity(clusters);
      }

      // Format choices for prompt with enhanced styling
      const choices = sortedClusters.map(cluster => {
        const hasActiveTasks = cluster.runningTasksCount > 0;
        const hasServices = cluster.activeServicesCount > 0;
        
        // Enhanced activity indicators
        let activityIndicator = '⚪'; // Default inactive
        let statusColor = 'gray';
        
        if (cluster.status === 'ACTIVE') {
          if (hasActiveTasks && hasServices) {
            activityIndicator = '🟢'; // Fully active
            statusColor = 'green';
          } else if (hasActiveTasks || hasServices) {
            activityIndicator = '🟡'; // Partially active
            statusColor = 'yellow';
          } else {
            activityIndicator = '🔵'; // Active but idle
            statusColor = 'blue';
          }
        } else {
          activityIndicator = '🔴'; // Inactive
          statusColor = 'red';
        }
        
        // Format counts with icons
        const taskInfo = hasActiveTasks ? 
          `📋 ${cluster.runningTasksCount} tasks` : 
          `📋 ${cluster.runningTasksCount} tasks`;
        const serviceInfo = hasServices ? 
          `⚙️  ${cluster.activeServicesCount} services` : 
          `⚙️  ${cluster.activeServicesCount} services`;
        
        // Create enhanced display name
        const displayName = `${activityIndicator} ${cluster.clusterName}`;
        const description = `${cluster.status} • ${serviceInfo} • ${taskInfo}`;
        
        return {
          name: displayName,
          value: cluster.clusterArn,
          short: cluster.clusterName,
          description: description
        };
      });

      const selectedArn = await awsPrompts.select({
        message: 'Select ECS cluster',
        choices,
        allowBack
      });

      const selectedCluster = clusters.find(c => c.clusterArn === selectedArn);
      if (config.get('cli.verbose')) {
        logger.info('🏗️ Selected cluster', { 
          name: selectedCluster?.clusterName,
          status: selectedCluster?.status,
          runningTasks: selectedCluster?.runningTasksCount
        });
      }

      return selectedArn;
    } catch (error) {
      if (error instanceof ECSError) throw error;
      
      const ecsError = ErrorHandler.fromAWSError(error, 'cluster selection');
      logger.error('Failed to select cluster', { error: ecsError.message });
      throw ecsError;
    }
  }

  /**
   * Check if a cluster exists and is accessible
   * @param {string} clusterIdentifier - Cluster name or ARN
   * @returns {Promise<boolean>} True if cluster exists and is accessible
   */
  async clusterExists(clusterIdentifier) {
    try {
      const { clusters } = await this.ecs.describeClusters({
        clusters: [clusterIdentifier]
      });
      return clusters && clusters.length > 0 && clusters[0].status === 'ACTIVE';
    } catch (error) {
      logger.debug('Cluster existence check failed', { 
        cluster: clusterIdentifier,
        error: error.message 
      });
      return false;
    }
  }

  /**
   * Enhance cluster data with additional metrics
   * @param {Array} clusters - Basic cluster data
   * @param {boolean} quiet - Suppress spinner output
   * @returns {Promise<Array>} Enhanced cluster data
   * @private
   */
  async _enhanceClusterData(clusters, quiet = false) {
    return await SpinnerUtils.withProgress(
      clusters.map(cluster => ({
        fn: async () => {
          const [services, tasks, containerInstances] = await Promise.all([
            this._getClusterServices(cluster.clusterArn).catch(() => []),
            this._getClusterTasks(cluster.clusterArn).catch(() => []),
            this._getClusterContainerInstances(cluster.clusterArn).catch(() => [])
          ]);

          return {
            ...this._formatSingleCluster(cluster),
            servicesCount: services.length,
            tasksCount: tasks.length,
            containerInstancesCount: containerInstances.length
          };
        },
        message: `Enhancing data for ${cluster.clusterName}`
      })),
      { style: 'dots' }
    );
  }

  /**
   * Get services in a cluster
   * @param {string} clusterArn - Cluster ARN
   * @returns {Promise<Array>} Array of service ARNs
   * @private
   */
  async _getClusterServices(clusterArn) {
    try {
      const { serviceArns } = await this.ecs.listServices({
        cluster: clusterArn
      });
      return serviceArns || [];
    } catch (error) {
      logger.debug('Failed to get cluster services', {
        cluster: clusterArn,
        error: error.message
      });
      return [];
    }
  }

  /**
   * Get tasks in a cluster
   * @param {string} clusterArn - Cluster ARN
   * @returns {Promise<Array>} Array of task ARNs
   * @private
   */
  async _getClusterTasks(clusterArn) {
    try {
      const { taskArns } = await this.ecs.listTasks({
        cluster: clusterArn
      });
      return taskArns || [];
    } catch (error) {
      logger.debug('Failed to get cluster tasks', {
        cluster: clusterArn,
        error: error.message
      });
      return [];
    }
  }

  /**
   * Get container instances in a cluster
   * @param {string} clusterArn - Cluster ARN
   * @returns {Promise<Array>} Array of container instance ARNs
   * @private
   */
  async _getClusterContainerInstances(clusterArn) {
    try {
      const { containerInstanceArns } = await this.ecs.listContainerInstances({
        cluster: clusterArn
      });
      return containerInstanceArns || [];
    } catch (error) {
      logger.debug('Failed to get cluster container instances', {
        cluster: clusterArn,
        error: error.message
      });
      return [];
    }
  }

  /**
   * Format cluster data for consistent output
   * @param {Array} clusters - Raw cluster data
   * @returns {Array} Formatted cluster data
   * @private
   */
  _formatClusterData(clusters) {
    return clusters.map(cluster => this._formatSingleCluster(cluster));
  }

  /**
   * Format a single cluster object
   * @param {Object} cluster - Raw cluster data
   * @returns {Object} Formatted cluster data
   * @private
   */
  _formatSingleCluster(cluster) {
    return {
      clusterName: cluster.clusterName,
      clusterArn: cluster.clusterArn,
      status: cluster.status,
      runningTasksCount: cluster.runningTasksCount || 0,
      pendingTasksCount: cluster.pendingTasksCount || 0,
      activeServicesCount: cluster.activeServicesCount || 0,
      registeredContainerInstancesCount: cluster.registeredContainerInstancesCount || 0,
      statistics: cluster.statistics || [],
      createdAt: cluster.createdAt,
      configuration: cluster.configuration || {},
      capacityProviders: cluster.capacityProviders || [],
      defaultCapacityProviderStrategy: cluster.defaultCapacityProviderStrategy || []
    };
  }

  /**
   * Sort clusters by activity level (active tasks first)
   * @param {Array} clusters - Clusters to sort
   * @returns {Array} Sorted clusters
   * @private
   */
  _sortClustersByActivity(clusters) {
    return [...clusters].sort((a, b) => {
      // Active clusters first
      if (a.status === 'ACTIVE' && b.status !== 'ACTIVE') return -1;
      if (a.status !== 'ACTIVE' && b.status === 'ACTIVE') return 1;
      
      // Then by running tasks count
      if (a.runningTasksCount !== b.runningTasksCount) {
        return b.runningTasksCount - a.runningTasksCount;
      }
      
      // Then by active services count
      if (a.activeServicesCount !== b.activeServicesCount) {
        return b.activeServicesCount - a.activeServicesCount;
      }
      
      // Finally alphabetically
      return a.clusterName.localeCompare(b.clusterName);
    });
  }
}

export default ECSClusterManager; 