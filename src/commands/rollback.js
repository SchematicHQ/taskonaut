/**
 * @fileoverview ECS service rollback command for taskonaut
 * @author taskonaut
 * @version 1.0.0
 */

import { ErrorHandler, UserCancelledError, ValidationError } from '../core/errors.js';
import logger from '../core/logger.js';
import { AWSClientManager } from '../aws/client.js';
import { ECSClusterManager } from '../aws/ecs/clusters.js';
import { ECSServiceManager } from '../aws/ecs/services.js';
import { SpinnerUtils } from '../ui/spinners.js';
import { awsPrompts } from '../ui/prompts.js';
import { formatter } from '../ui/formatters.js';
import { displayBanner } from '../ui/banner.js';
import config from '../core/config.js';

/**
 * Rollback command handler
 */
export class RollbackCommand {
  /**
   * Create a new RollbackCommand instance
   * @param {Object} options - Command options
   */
  constructor(options = {}) {
    this.options = options;
    this.awsClient = null;
    this.clusterManager = null;
    this.serviceManager = null;
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
      this.serviceManager = new ECSServiceManager(ecsClient);

      logger.debug('AWS services initialized for rollback', {
        profile: config.get('aws.profile'),
        region: config.get('aws.region')
      });
    } catch (error) {
      ErrorHandler.handle(error, { operation: 'initialize AWS services for rollback' });
      throw error;
    }
  }

  /**
   * Execute the rollback workflow
   * @returns {Promise<void>}
   */
  async execute() {
    try {
      // Display welcome banner for rollback command
      if (!config.isQuiet()) {
        displayBanner();
        console.log(formatter.formatHeader('🔄 ECS Service Rollback', { color: 'primary' }));
        console.log(formatter.formatStatus('Safely rollback ECS services to previous task definition revisions', 'info', '✨'));
        console.log(''); // Empty line for spacing
      }

      if (config.get('cli.verbose')) {
        logger.info('🔄 Starting ECS service rollback workflow');
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

      // Main rollback workflow with navigation support
      let currentCluster = null;
      let selectedService = null;
      let targetRevision = null;

      // Main navigation loop
      while (true) {
        try {
          // Step 1: Select cluster
          console.log(formatter.formatStatus('Step 1: Select ECS Cluster', 'info', '🏗️'));
          currentCluster = await this.clusterManager.selectCluster({ allowBack: true });
          
          if (currentCluster === '__BACK__') {
            console.log(formatter.formatStatus('👋 Exiting rollback - Operation cancelled', 'info'));
            return;
          }

          if (config.get('cli.verbose')) {
            logger.info('Selected cluster for rollback:', { cluster: currentCluster });
          }

          // Step 2: Select service
          while (true) {
            try {
              console.log('\n' + formatter.formatStatus('Step 2: Select ECS Service to rollback', 'info', '⚙️'));
              selectedService = await this.serviceManager.selectService(currentCluster, {
                allowBack: true
              });

              if (selectedService === '__BACK__') {
                // Go back to cluster selection
                break;
              }

              // Step 3: Select target revision
              while (true) {
                try {
                  console.log('\n' + formatter.formatStatus('Step 3: Select target revision to rollback to', 'info', '📋'));
                  
                  // Get service task definition history
                  const revisions = await SpinnerUtils.withSpinner(
                    () => this.serviceManager.getTaskDefinitionRevisions(selectedService),
                    '📚 Loading task definition revisions...',
                    '✅ Task definition history loaded',
                    '❌ Failed to load task definition revisions'
                  );

                  if (revisions.length === 0) {
                    console.log(formatter.formatStatus('❌ No previous revisions found for this service', 'error'));
                    
                    const tryAgain = await awsPrompts.confirm({
                      message: 'Would you like to select a different service?',
                      defaultValue: true
                    });

                    if (!tryAgain) {
                      return;
                    }
                    break; // Go back to service selection
                  }

                  // Create choices from revisions (excluding current)
                  const currentRevision = revisions[0].revision;
                  const choices = revisions
                    .filter(rev => rev.revision !== currentRevision)
                    .map(rev => ({
                      name: `Revision ${rev.revision} - ${rev.createdAt.toLocaleString()} (${rev.status})`,
                      value: rev.revision,
                      short: `Rev ${rev.revision}`
                    }));

                  if (choices.length === 0) {
                    console.log(formatter.formatStatus('❌ No previous revisions available for rollback', 'error'));
                    console.log(formatter.formatStatus('💡 This service only has one revision', 'info'));
                    return;
                  }

                  // Add back option
                  choices.unshift({ name: '◀️ Back to service selection', value: '__BACK__', short: 'Back' });

                  const selectedRevision = await awsPrompts.select({
                    message: 'Select target revision for rollback',
                    choices
                  });

                  if (selectedRevision === '__BACK__') {
                    break; // Go back to service selection
                  }

                  targetRevision = selectedRevision;

                  // Step 4: Preview rollback changes
                  console.log('\n' + formatter.formatStatus('Step 4: Rollback Preview', 'info', '🔍'));
                  
                  await this._showRollbackPreview(selectedService, currentRevision, targetRevision);

                  // Step 5: Confirm rollback
                  console.log('\n' + formatter.formatStatus('Step 5: Confirm Rollback', 'info', '⚠️'));
                  
                  const confirmed = await this._confirmRollback(
                    selectedService, 
                    currentRevision, 
                    targetRevision
                  );

                  if (!confirmed) {
                    console.log(formatter.formatStatus('Rollback cancelled by user', 'info', 'ℹ️'));
                    
                    const tryAgain = await awsPrompts.confirm({
                      message: 'Would you like to select a different revision?',
                      defaultValue: true
                    });

                    if (tryAgain) {
                      continue; // Stay in revision selection loop
                    } else {
                      return; // Exit completely
                    }
                  }

                  // Step 6: Execute rollback
                  console.log('\n' + formatter.formatStatus('Step 6: Executing Rollback', 'info', '🚀'));
                  
                  const rollbackResult = await SpinnerUtils.withSpinner(
                    () => this.serviceManager.rollbackService(selectedService, targetRevision),
                    '🔄 Rolling back service to previous revision...',
                    '✅ Rollback initiated successfully',
                    '❌ Rollback failed'
                  );

                  // Display success information
                  console.log('\n' + formatter.formatHeader('🎉 Rollback Completed Successfully!', { color: 'success' }));
                  
                  console.log(formatter.formatKeyValue({
                    'Service': selectedService,
                    'Cluster': currentCluster.split('/').pop(),
                    'From Revision': currentRevision,
                    'To Revision': targetRevision,
                    'Deployment Status': rollbackResult.status || 'IN_PROGRESS'
                  }));

                  console.log('\n' + formatter.formatStatus('💡 Pro tip: Monitor deployment progress in AWS Console', 'info'));
                  console.log(formatter.formatStatus('✨ Rollback operation completed successfully!', 'success'));

                  if (config.get('cli.verbose')) {
                    logger.success('Service rollback completed', {
                      service: selectedService,
                      fromRevision: currentRevision,
                      toRevision: targetRevision
                    });
                  }

                  return; // Exit after successful rollback

                } catch (error) {
                  if (error instanceof UserCancelledError) {
                    console.log(formatter.formatStatus('Operation cancelled by user', 'info', 'ℹ️'));
                    return;
                  }
                  
                  console.log('\n' + formatter.formatStatus('❌ Revision selection failed', 'error'));
                  ErrorHandler.handle(error, { 
                    operation: 'revision selection',
                    service: selectedService 
                  });
                  
                  const shouldRetry = await this._handleRevisionSelectionError(error);
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
              
              console.log('\n' + formatter.formatStatus('❌ Service selection failed', 'error'));
              ErrorHandler.handle(error, { 
                operation: 'service selection',
                cluster: currentCluster 
              });
              
              const shouldRetry = await this._handleServiceSelectionError(error);
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
          
          console.log('\n' + formatter.formatStatus('❌ Cluster selection failed', 'error'));
          ErrorHandler.handle(error, { operation: 'cluster selection for rollback' });
          
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
      
      ErrorHandler.handleAndExit(error, { operation: 'rollback command' });
    } finally {
      // Cleanup
      if (this.awsClient) {
        this.awsClient.dispose();
      }
    }
  }

  /**
   * Show rollback preview with changes
   * @param {string} serviceName - Service name
   * @param {number} currentRevision - Current revision
   * @param {number} targetRevision - Target revision
   * @returns {Promise<void>}
   * @private
   */
  async _showRollbackPreview(serviceName, currentRevision, targetRevision) {
    try {
      const changes = await this.serviceManager.previewRollbackChanges(
        serviceName, 
        currentRevision, 
        targetRevision
      );

      console.log(formatter.formatKeyValue({
        'Service Name': serviceName,
        'Current Revision': currentRevision,
        'Target Revision': targetRevision,
        'Change Type': 'ROLLBACK'
      }));

      if (changes && changes.length > 0) {
        console.log('\n' + formatter.formatStatus('📝 Configuration Changes:', 'warning', '⚠️'));
        console.log(formatter.formatList(changes, { bullet: '•', color: 'warning' }));
      } else {
        console.log('\n' + formatter.formatStatus('ℹ️ No configuration changes detected', 'info'));
      }

    } catch (error) {
      logger.warn('Failed to preview rollback changes', { error: error.message });
      console.log(formatter.formatStatus('⚠️ Could not preview changes - proceeding with basic rollback info', 'warning'));
    }
  }

  /**
   * Confirm rollback operation with user
   * @param {string} serviceName - Service name
   * @param {number} currentRevision - Current revision
   * @param {number} targetRevision - Target revision
   * @returns {Promise<boolean>} User confirmation
   * @private
   */
  async _confirmRollback(serviceName, currentRevision, targetRevision) {
    const message = `⚠️ Roll back service '${serviceName}' from revision ${currentRevision} to revision ${targetRevision}?`;
    
    console.log(formatter.formatStatus('This action will:', 'warning', '⚠️'));
    console.log(formatter.formatList([
      'Update the service to use the selected task definition revision',
      'Trigger a new deployment with zero-downtime rolling update',
      'May take several minutes to complete',
      'Cannot be undone automatically (requires another rollback)'
    ], { bullet: '•', color: 'warning' }));

    return await awsPrompts.confirm({
      message,
      defaultValue: false
    });
  }

  /**
   * Handle revision selection errors
   * @param {Error} error - The error that occurred
   * @returns {Promise<boolean>} True if should retry, false if should exit
   * @private
   */
  async _handleRevisionSelectionError(error) {
    try {
      console.log('\n' + formatter.formatStatus('What would you like to do next?', 'info', '🤔'));
      
      const choices = [
        { name: '🔄 Try again', value: 'retry' },
        { name: '⚙️ Select different service', value: 'service' },
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
      logger.debug('Error handling revision selection error prompt', { error: promptError.message });
      return false;
    }
  }

  /**
   * Handle service selection errors
   * @param {Error} error - The error that occurred
   * @returns {Promise<boolean>} True if should retry, false if should exit
   * @private
   */
  async _handleServiceSelectionError(error) {
    try {
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
      logger.debug('Error handling service selection error prompt', { error: promptError.message });
      return false;
    }
  }

  /**
   * Handle cluster selection errors
   * @param {Error} error - The error that occurred
   * @returns {Promise<boolean>} True if should retry, false if should exit
   * @private
   */
  async _handleClusterSelectionError(error) {
    try {
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
      name: 'rollback',
      description: '🔄 Rollback an ECS service to a previous task definition revision',
      action: async (options) => {
        const command = new RollbackCommand(options);
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
      name: 'rollback',
      emoji: '🔄',
      description: 'Safely rollback ECS services to previous task definition revisions with zero downtime',
      usage: 'taskonaut rollback [options]',
      options: [
        {
          short: '-h',
          long: '--help',
          description: 'Display help for rollback command'
        }
      ],
      examples: [
        {
          command: 'taskonaut rollback',
          description: 'Start interactive service rollback wizard',
          highlight: true
        }
      ],
      notes: [
        'Rollbacks use zero-downtime rolling deployments',
        'Previous revisions must exist for the service',
        'Monitor deployment progress in AWS Console',
        'Rollback operation cannot be undone automatically',
        'Service must be in ACTIVE state to perform rollback'
      ]
    };
  }
}

export default RollbackCommand; 