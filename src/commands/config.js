/**
 * @fileoverview Configuration management command for AWS profiles and regions
 * @author taskonaut
 * @version 1.0.0
 */

import { Command } from 'commander';
import { ErrorHandler, ValidationError } from '../core/errors.js';
import logger from '../core/logger.js';
import { AWSProfileManager, AWS_REGIONS } from '../core/config.js';
import { SpinnerUtils } from '../ui/spinners.js';
import { awsPrompts } from '../ui/prompts.js';
import { formatter } from '../ui/formatters.js';
import { displayBanner } from '../ui/banner.js';
import help from '../ui/help.js';
import config from '../core/config.js';

/**
 * Configuration command handler
 */
export class ConfigCommand {
  /**
   * Create a new ConfigCommand instance
   * @param {Object} options - Command options
   */
  constructor(options = {}) {
    this.options = options;
  }

  /**
   * Set AWS profile and region configuration
   * @returns {Promise<void>}
   */
  async setConfig() {
    try {
      // Display banner and header
      if (!config.isQuiet()) {
        displayBanner();
        console.log(formatter.formatHeader('⚙️ AWS Configuration Setup', { color: 'primary' }));
        console.log(formatter.formatStatus('Configure your AWS profile and region settings', 'info', '✨'));
        console.log(''); // Empty line for spacing
      }

      logger.info('⚙️ Starting AWS configuration setup');

      // Get available AWS profiles
      const profiles = await SpinnerUtils.withSpinner(
        async () => {
          const availableProfiles = AWSProfileManager.getAvailableProfiles();
          if (availableProfiles.length === 0) {
            throw new ValidationError('No AWS profiles found. Please configure AWS credentials first.');
          }
          return availableProfiles;
        },
        '🔍 Scanning for AWS profiles...',
        '✅ AWS profiles loaded successfully',
        '❌ Failed to load AWS profiles'
      );

      console.log('\n' + formatter.formatStatus('Step 1: Select AWS Profile', 'info', '👤'));

      // Select AWS profile
      const selectedProfile = await awsPrompts.selectProfile(
        profiles, 
        config.get('aws.profile')
      );

      console.log('\n' + formatter.formatStatus('Step 2: Select AWS Region', 'info', '🌍'));

      // Select AWS region
      const selectedRegion = await awsPrompts.selectRegion(
        AWS_REGIONS, 
        config.get('aws.region')
      );

      console.log('\n' + formatter.formatStatus('Step 3: Validating Configuration', 'info', '🔍'));

      // Validate the selected profile
      await SpinnerUtils.withSpinner(
        async () => {
          const isValid = AWSProfileManager.validateProfile(selectedProfile);
          if (!isValid) {
            throw new ValidationError(`Profile '${selectedProfile}' is not valid or incomplete`);
          }
          return isValid;
        },
        '⚙️ Validating AWS profile credentials...',
        '✅ Profile validation completed successfully',
        '❌ Profile validation failed'
      );

      // Update configuration
      config.set('aws.profile', selectedProfile);
      config.set('aws.region', selectedRegion);

      // Show success message with enhanced formatting
      console.log('\n' + formatter.formatHeader('🎉 Configuration Updated Successfully!', { color: 'success' }));
      console.log(formatter.formatKeyValue({
        'AWS Profile': selectedProfile,
        'AWS Region': selectedRegion,
        'Configuration File': config.getConfigPath(),
        'Status': 'Ready for use'
      }));

      console.log('\n' + formatter.formatStatus('✨ Configuration saved successfully!', 'success'));
      console.log(formatter.formatStatus('💡 You can now run "taskonaut" to start using ECS Task Executor', 'info'));
      
      logger.success('AWS configuration updated successfully', {
        profile: selectedProfile,
        region: selectedRegion
      });

    } catch (error) {
      if (error instanceof ValidationError) {
        console.log('\n' + formatter.formatStatus('❌ Configuration setup failed', 'error'));
        console.log(formatter.formatStatus(`💡 ${error.message}`, 'warning'));
        console.log('\n' + formatter.formatStatus('Troubleshooting Tips:', 'info', '🔧'));
        console.log(formatter.formatList([
          'Ensure AWS CLI is installed and configured',
          'Run "aws configure" to set up credentials',
          'Check ~/.aws/credentials and ~/.aws/config files',
          'Verify your AWS access keys are valid'
        ], { bullet: '•', color: 'secondary' }));
      }
      ErrorHandler.handleAndExit(error, { operation: 'set configuration' });
    }
  }

  /**
   * Show current configuration
   * @returns {Promise<void>}
   */
  async showConfig() {
    try {
      // Display banner and header
      if (!config.isQuiet()) {
        displayBanner();
        console.log(formatter.formatHeader('📋 Current Configuration', { color: 'primary' }));
        console.log(formatter.formatStatus('Displaying all taskonaut configuration settings', 'info', '✨'));
        console.log(''); // Empty line for spacing
      }

      logger.debug('Displaying current configuration');

      const configData = await SpinnerUtils.withSpinner(
        async () => {
          const awsConfig = config.getAWSConfig();
          const cliConfig = config.getCLIConfig();
          const ecsConfig = config.getECSConfig();
          const loggingConfig = config.getLoggingConfig();
          const profiles = AWSProfileManager.getAvailableProfiles();
          
          return {
            aws: awsConfig,
            cli: cliConfig,
            ecs: ecsConfig,
            logging: loggingConfig,
            availableProfiles: profiles,
            configPath: config.getConfigPath(),
            configExists: config.hasConfigFile()
          };
        },
        '📖 Reading configuration files...',
        '✅ Configuration loaded successfully',
        '❌ Failed to read configuration'
      );

      // Configuration File Status
      console.log(formatter.formatStatus('Configuration File Status:', 'info', '📄'));
      console.log(formatter.formatKeyValue({
        'Path': configData.configPath,
        'Exists': configData.configExists ? 'Yes' : 'No (using defaults)',
        'Status': configData.configExists ? 'Loaded' : 'Using defaults'
      }));

      // AWS Configuration
      console.log('\n' + formatter.formatStatus('AWS Configuration:', 'info', '☁️'));
      console.log(formatter.formatKeyValue({
        'Profile': configData.aws.profile,
        'Region': configData.aws.region,
        'Timeout': `${configData.aws.timeout / 1000}s`,
        'Max Retries': configData.aws.maxRetries
      }));

      // CLI Configuration
      console.log('\n' + formatter.formatStatus('CLI Configuration:', 'info', '🖥️'));
      console.log(formatter.formatKeyValue({
        'Output Format': configData.cli.outputFormat,
        'Quiet Mode': configData.cli.quiet,
        'Verbose Mode': configData.cli.verbose,
        'Confirm Actions': configData.cli.confirmActions,
        'Page Size': configData.cli.pageSize,
        'Timeout': `${configData.cli.timeout / 1000}s`
      }));

      // ECS Configuration
      console.log('\n' + formatter.formatStatus('ECS Configuration:', 'info', '🐳'));
      console.log(formatter.formatKeyValue({
        'Execute Command Enabled': configData.ecs.enableExecuteCommand,
        'Default Cluster': configData.ecs.defaultCluster || 'Not set',
        'Task Definition Family': configData.ecs.taskDefinitionFamily || 'Not set'
      }));

      // Logging Configuration
      console.log('\n' + formatter.formatStatus('Logging Configuration:', 'info', '📝'));
      console.log(formatter.formatKeyValue({
        'Level': configData.logging.level,
        'Timestamp': configData.logging.timestamp,
        'Colorize': configData.logging.colorize
      }));

      // Available AWS Profiles
      console.log('\n' + formatter.formatStatus('Available AWS Profiles:', 'info', '👤'));
      if (configData.availableProfiles.length > 0) {
        console.log(formatter.formatList(configData.availableProfiles, { 
          bullet: '•',
          color: 'secondary' 
        }));
      } else {
        console.log(formatter.formatStatus('No AWS profiles found', 'warning', '⚠️'));
      }

      // Show profile validation status
      const currentProfileValid = AWSProfileManager.validateProfile(configData.aws.profile);
      const profileStatus = currentProfileValid ? 'Valid ✅' : 'Invalid/Incomplete ❌';
      const statusColor = currentProfileValid ? 'success' : 'error';
      
      console.log('\n' + formatter.formatStatus('Profile Validation:', 'info', '🔍'));
      console.log(formatter.formatStatus(`Current profile (${configData.aws.profile}): ${profileStatus}`, statusColor));

      // Quick actions
      console.log('\n' + formatter.formatStatus('Quick Actions:', 'info', '⚡'));
      console.log(formatter.formatList([
        'Run "taskonaut config set" to change settings',
        'Run "taskonaut doctor" to verify environment',
        'Run "taskonaut" to start task executor'
      ], { bullet: '▶️', color: 'primary' }));

    } catch (error) {
      ErrorHandler.handleAndExit(error, { operation: 'show configuration' });
    }
  }

  /**
   * Cleanup/reset configuration
   * @returns {Promise<void>}
   */
  async cleanupConfig() {
    try {
      // Display banner and header
      if (!config.isQuiet()) {
        displayBanner();
        console.log(formatter.formatHeader('🧹 Configuration Reset', { color: 'primary' }));
        console.log(formatter.formatStatus('Reset all configuration settings to their defaults', 'info', '✨'));
        console.log(''); // Empty line for spacing
      }

      logger.debug('Starting configuration cleanup');

      // Show current config before reset
      console.log(formatter.formatStatus('Current Settings:', 'info', '📋'));
      console.log(formatter.formatKeyValue({
        'AWS Profile': config.get('aws.profile'),
        'AWS Region': config.get('aws.region'),
        'Config File': config.hasConfigFile() ? 'Exists' : 'Not found'
      }));

      // Confirm cleanup with enhanced warning
      console.log('\n' + formatter.formatStatus('⚠️ Warning: This action will:', 'warning'));
      console.log(formatter.formatList([
        'Reset all AWS profile and region settings to defaults',
        'Clear any custom CLI preferences',
        'Remove the configuration file',
        'Require you to reconfigure before next use'
      ], { bullet: '•', color: 'warning' }));

      const confirmed = await awsPrompts.confirm({
        message: '⚠️ Are you sure you want to reset all configuration to defaults?',
        defaultValue: false
      });

      if (!confirmed) {
        console.log(formatter.formatStatus('🛡️ Configuration reset cancelled - No changes made', 'info'));
        return;
      }

      // Reset configuration to defaults
      await SpinnerUtils.withSpinner(
        async () => {
          config.resetConfig();
          logger.debug('Configuration reset to defaults');
        },
        '🧹 Resetting configuration to defaults...',
        '✅ Configuration reset completed',
        '❌ Failed to reset configuration'
      );

      console.log('\n' + formatter.formatStatus('🎉 Configuration Reset Successfully!', 'success'));
      console.log(formatter.formatStatus('All settings have been restored to their default values', 'info'));
      
      console.log('\n' + formatter.formatStatus('Next Steps:', 'info', '🎯'));
      console.log(formatter.formatList([
        'Run "taskonaut config set" to configure AWS settings',
        'Run "taskonaut doctor" to verify your environment',
        'Check the documentation for advanced configuration options'
      ], { bullet: '▶️', color: 'primary' }));
      
    } catch (error) {
      ErrorHandler.handleAndExit(error, { operation: 'cleanup configuration' });
    }
  }

  /**
   * Sync AWS profiles from credentials/config files
   * @returns {Promise<void>}
   */
  async syncProfiles() {
    try {
      // Display banner and header
      if (!config.isQuiet()) {
        displayBanner();
        console.log(formatter.formatHeader('🔄 AWS Profile Sync', { color: 'primary' }));
        console.log(formatter.formatStatus('Synchronize AWS profiles from your credentials files', 'info', '✨'));
        console.log(''); // Empty line for spacing
      }

      logger.debug('Syncing AWS profiles');

      const profiles = await SpinnerUtils.withSpinner(
        async () => {
          const availableProfiles = AWSProfileManager.getAvailableProfiles();
          logger.debug('AWS profiles synced', { count: availableProfiles.length });
          return availableProfiles;
        },
        '🔍 Scanning AWS credential files...',
        'Profile synchronization completed',
        '❌ Failed to sync AWS profiles'
      );

      console.log('\n' + formatter.formatStatus(`🎉 Profile Sync Completed!`, 'success'));
      console.log(formatter.formatStatus(`Found ${profiles.length} AWS profiles`, 'info', '📊'));
      
      if (profiles.length > 0) {
        console.log('\n' + formatter.formatStatus('Available Profiles:', 'info', '👤'));
        console.log(formatter.formatList(profiles, { 
          bullet: '•',
          color: 'secondary' 
        }));

        // Show which profile is currently active
        const currentProfile = config.get('aws.profile');
        const isCurrentValid = profiles.includes(currentProfile);
        
        console.log('\n' + formatter.formatStatus('Current Configuration:', 'info', '⚙️'));
        console.log(formatter.formatKeyValue({
          'Active Profile': currentProfile,
          'Profile Status': isCurrentValid ? 'Valid ✅' : 'Not found ❌'
        }));

        if (!isCurrentValid) {
          console.log('\n' + formatter.formatStatus('💡 Recommendation:', 'warning'));
          console.log(formatter.formatStatus('Your current profile is not in the synced list. Run "taskonaut config set" to update.', 'warning'));
        }

      } else {
        console.log('\n' + formatter.formatStatus('⚠️ No AWS profiles found', 'warning'));
        console.log(formatter.formatStatus('Setup Instructions:', 'info', '🔧'));
        console.log(formatter.formatList([
          'Install and configure AWS CLI: "aws configure"',
          'Set up AWS SSO: "aws configure sso"',
          'Create profile manually in ~/.aws/credentials',
          'Verify with: "aws sts get-caller-identity"'
        ], { bullet: '▶️', color: 'secondary' }));
      }

    } catch (error) {
      ErrorHandler.handleAndExit(error, { operation: 'sync profiles' });
    }
  }

  /**
   * Get command configuration for Commander.js
   * @returns {Command} Commander command configuration
   */
  static getCommandConfig() {
    const configCmd = new Command('config');
    configCmd.description('⚙️ Manage configuration settings');

    // Override help to use our UI system
    configCmd.on('--help', () => {
      const helpData = ConfigCommand.getHelpData();
      help.displayCommandHelp(helpData);
    });

    // Set subcommand
    configCmd
      .command('set')
      .description('📝 Set AWS profile and region')
      .action(async () => {
        const command = new ConfigCommand();
        await command.setConfig();
      });

    // Show subcommand
    configCmd
      .command('show')
      .alias('path')
      .description('📋 Show current configuration and available profiles')
      .action(async () => {
        const command = new ConfigCommand();
        await command.showConfig();
      });

    // Cleanup subcommand
    configCmd
      .command('cleanup')
      .alias('clear')
      .alias('reset')
      .description('🧹 Reset configuration to defaults')
      .action(async () => {
        const command = new ConfigCommand();
        await command.cleanupConfig();
      });

    // Sync subcommand
    configCmd
      .command('sync')
      .description('🔄 Sync AWS profiles from credentials/config files')
      .action(async () => {
        const command = new ConfigCommand();
        await command.syncProfiles();
      });

    return configCmd;
  }

  /**
   * Get structured help data for this command
   * @returns {Object} Help data structure
   */
  static getHelpData() {
    return {
      name: 'config',
      emoji: '⚙️',
      description: 'Manage AWS profiles, regions, and other taskonaut configuration settings',
      usage: 'taskonaut config <subcommand> [options]',
      options: [
        {
          short: '-h',
          long: '--help',
          description: 'Display help for config command'
        }
      ],
      subcommands: [
        {
          name: 'set',
          description: 'Configure AWS profile and region interactively'
        },
        {
          name: 'show',
          aliases: ['path'],
          description: 'Display current configuration and available profiles'
        },
        {
          name: 'cleanup',
          aliases: ['clear', 'reset'],
          description: 'Reset all configuration to default values'
        },
        {
          name: 'sync',
          description: 'Sync AWS profiles from credentials/config files'
        }
      ],
      examples: [
        {
          command: 'taskonaut config set',
          description: 'Interactive AWS profile and region setup',
          highlight: true
        },
        {
          command: 'taskonaut config show',
          description: 'Display current configuration'
        },
        {
          command: 'taskonaut config sync',
          description: 'Refresh available AWS profiles'
        },
        {
          command: 'taskonaut config cleanup',
          description: 'Reset to default configuration'
        }
      ],
      notes: [
        'Configuration is stored in ~/.taskonaut (JSON format)',
        'AWS profiles are read from ~/.aws/credentials and ~/.aws/config',
        'Changes take effect immediately',
        'Use "taskonaut doctor" to verify configuration'
      ]
    };
  }
}

export default ConfigCommand; 