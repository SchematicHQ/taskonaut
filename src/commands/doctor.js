/**
 * @fileoverview Doctor command for environment diagnostics and health checks
 * @author taskonaut
 * @version 1.0.0
 */

import { execSync } from 'node:child_process';
import { ErrorHandler } from '../core/errors.js';
import logger from '../core/logger.js';
import { AWSProfileManager } from '../core/config.js';
import { AWSClientManager } from '../aws/client.js';
import { SpinnerUtils } from '../ui/spinners.js';
import { formatter } from '../ui/formatters.js';
import { displayBanner } from '../ui/banner.js';
import config from '../core/config.js';

/**
 * Doctor command handler
 */
export class DoctorCommand {
  /**
   * Create a new DoctorCommand instance
   * @param {Object} options - Command options
   */
  constructor(options = {}) {
    this.options = options;
    this.results = {
      checks: [],
      summary: {
        total: 0,
        passed: 0,
        failed: 0,
        warnings: 0
      }
    };
  }

  /**
   * Run comprehensive diagnostics
   * @returns {Promise<void>}
   */
  async runDiagnostics() {
    try {
      // Display banner and header
      if (!config.isQuiet()) {
        displayBanner();
        console.log(formatter.formatHeader('🏥 Environment Diagnostics', { color: 'primary' }));
        console.log(formatter.formatStatus('Comprehensive health check for your taskonaut environment', 'info', '✨'));
        console.log(''); // Empty line for spacing
      }

      logger.info('🏃 Running comprehensive diagnostics');

      // Show what will be checked
      console.log(formatter.formatStatus('Running Health Checks:', 'info', '🔍'));
      console.log(formatter.formatList([
        'Node.js environment and version',
        'AWS CLI installation and configuration',
        'AWS Session Manager Plugin',
        'AWS credentials and permissions',
        'AWS connectivity and API access',
        'taskonaut configuration file',
        'System requirements and dependencies'
      ], { bullet: '•', color: 'secondary' }));
      console.log(''); // Empty line for spacing

      // Run all diagnostic checks
      await this._checkNodeEnvironment();
      await this._checkAWSCLI();
      await this._checkSessionManagerPlugin();
      await this._checkAWSCredentials();
      await this._checkAWSProfile();
      await this._checkAWSConnectivity();
      await this._checkConfigurationFile();
      await this._checkSystemRequirements();

      // Display results
      this._displayResults();

    } catch (error) {
      ErrorHandler.handleAndExit(error, { operation: 'run diagnostics' });
    }
  }

  /**
   * Check Node.js environment
   * @returns {Promise<void>}
   * @private
   */
  async _checkNodeEnvironment() {
    await this._runCheck(
      'Node.js Environment',
      '🟢 Checking Node.js version and environment...',
      async () => {
        const nodeVersion = process.version;
        const majorVersion = parseInt(nodeVersion.split('.')[0].replace('v', ''));
        const platform = process.platform;
        const arch = process.arch;

        const details = {
          version: nodeVersion,
          majorVersion,
          platform,
          architecture: arch,
          execPath: process.execPath
        };

        const issues = [];
        const suggestions = [];

        // Check Node.js version (require 18+)
        if (majorVersion < 18) {
          issues.push(`Node.js version ${nodeVersion} is too old`);
          suggestions.push('Update to Node.js 18 or later');
          return {
            status: 'failed',
            message: `Node.js ${nodeVersion} is too old. Requires Node.js 18+`,
            details: { ...details, issues, suggestions }
          };
        }

        // Check if in supported platform
        const supportedPlatforms = ['darwin', 'linux', 'win32'];
        if (!supportedPlatforms.includes(platform)) {
          issues.push(`Platform ${platform} may not be fully supported`);
          suggestions.push('Use macOS, Linux, or Windows for best compatibility');
        }

        const status = issues.length > 0 ? 'warning' : 'passed';
        const message = issues.length > 0 
          ? `Node.js ${nodeVersion} on ${platform} with warnings`
          : `Node.js ${nodeVersion} on ${platform} - ✅ Compatible`;

        return {
          status,
          message,
          details: { ...details, issues, suggestions }
        };
      }
    );
  }

  /**
   * Check AWS CLI installation
   * @returns {Promise<void>}
   * @private
   */
  async _checkAWSCLI() {
    await this._runCheck(
      'AWS CLI',
      '☁️ Checking AWS CLI installation...',
      async () => {
        try {
          const version = execSync('aws --version', { 
            encoding: 'utf8', 
            timeout: 5000,
            stdio: ['pipe', 'pipe', 'pipe']
          }).trim();

          const details = { version, command: 'aws --version' };
          const issues = [];
          const suggestions = [];

          // Check if it's AWS CLI v2
          if (!version.includes('aws-cli/2.')) {
            issues.push('AWS CLI v1 detected, v2 is recommended');
            suggestions.push('Install AWS CLI v2 for better performance and features');
            
            return {
              status: 'warning',
              message: `AWS CLI found but v1 detected: ${version.split(' ')[0]}`,
              details: { ...details, issues, suggestions }
            };
          }

          return {
            status: 'passed',
            message: `✅ AWS CLI v2 installed: ${version.split(' ')[0]}`,
            details
          };

        } catch (error) {
          return {
            status: 'failed',
            message: '❌ AWS CLI not found or not accessible',
            details: {
              error: error.message,
              suggestion: 'Install AWS CLI v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html'
            }
          };
        }
      }
    );
  }

  /**
   * Check AWS Session Manager Plugin
   * @returns {Promise<void>}
   * @private
   */
  async _checkSessionManagerPlugin() {
    await this._runCheck(
      'AWS Session Manager Plugin',
      '🔌 Checking Session Manager Plugin...',
      async () => {
        try {
          const version = execSync('session-manager-plugin --version', { 
            encoding: 'utf8', 
            timeout: 5000,
            stdio: ['pipe', 'pipe', 'pipe']
          }).trim();

          return {
            status: 'passed',
            message: `✅ Session Manager Plugin installed: ${version}`,
            details: { version, command: 'session-manager-plugin --version' }
          };

        } catch (error) {
          return {
            status: 'failed',
            message: '❌ AWS Session Manager Plugin not found',
            details: {
              error: error.message,
              suggestion: 'Install Session Manager Plugin: https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html'
            }
          };
        }
      }
    );
  }

  /**
   * Check AWS credentials
   * @returns {Promise<void>}
   * @private
   */
  async _checkAWSCredentials() {
    await this._runCheck(
      'AWS Credentials',
      '🔐 Checking AWS credentials and access...',
      async () => {
        try {
          const identity = execSync('aws sts get-caller-identity', { 
            encoding: 'utf8', 
            timeout: 10000,
            stdio: ['pipe', 'pipe', 'pipe']
          });

          const identityData = JSON.parse(identity);
          
          return {
            status: 'passed',
            message: `✅ AWS credentials valid for user: ${identityData.Arn?.split('/')[1] || identityData.UserId}`,
            details: {
              userId: identityData.UserId,
              account: identityData.Account,
              arn: identityData.Arn
            }
          };

        } catch (error) {
          const issues = [];
          const suggestions = [];

          if (error.message.includes('credentials')) {
            issues.push('AWS credentials not configured or invalid');
            suggestions.push('Run "aws configure" to set up credentials');
            suggestions.push('Or set up AWS SSO with "aws configure sso"');
          } else if (error.message.includes('region')) {
            issues.push('AWS region not configured');
            suggestions.push('Set default region with "aws configure set region us-east-1"');
          } else {
            issues.push('AWS credentials check failed');
            suggestions.push('Verify AWS CLI configuration and connectivity');
          }

          return {
            status: 'failed',
            message: '❌ AWS credentials not accessible or invalid',
            details: { error: error.message, issues, suggestions }
          };
        }
      }
    );
  }

  /**
   * Check AWS profile configuration
   * @returns {Promise<void>}
   * @private
   */
  async _checkAWSProfile() {
    await this._runCheck(
      'AWS Profile Configuration',
      '👤 Checking AWS profile configuration...',
      async () => {
        const currentProfile = config.get('aws.profile');
        const currentRegion = config.get('aws.region');
        const availableProfiles = AWSProfileManager.getAvailableProfiles();
        
        const details = {
          currentProfile,
          currentRegion,
          availableProfiles,
          profileCount: availableProfiles.length
        };

        const issues = [];
        const suggestions = [];

        // Check if current profile exists
        if (!availableProfiles.includes(currentProfile)) {
          issues.push(`Current profile '${currentProfile}' not found in available profiles`);
          suggestions.push('Run "taskonaut config set" to select a valid profile');
        }

        // Check if profile is valid
        if (currentProfile && !AWSProfileManager.validateProfile(currentProfile)) {
          issues.push(`Profile '${currentProfile}' is incomplete or invalid`);
          suggestions.push('Check ~/.aws/credentials and ~/.aws/config files');
        }

        // Check if any profiles are available
        if (availableProfiles.length === 0) {
          issues.push('No AWS profiles found');
          suggestions.push('Configure AWS credentials with "aws configure"');
        }

        // Check region
        if (!currentRegion) {
          issues.push('No AWS region configured');
          suggestions.push('Run "taskonaut config set" to select a region');
        }

        const status = issues.length > 0 ? (issues.some(i => i.includes('not found') || i.includes('No AWS')) ? 'failed' : 'warning') : 'passed';
        
        let message;
        if (status === 'passed') {
          message = `✅ Profile '${currentProfile}' in '${currentRegion}' is valid`;
        } else if (status === 'warning') {
          message = `⚠️ Profile configuration has warnings: ${issues[0]}`;
        } else {
          message = `❌ Profile configuration failed: ${issues[0]}`;
        }

        return {
          status,
          message,
          details: { ...details, issues, suggestions }
        };
      }
    );
  }

  /**
   * Check AWS connectivity
   * @returns {Promise<void>}
   * @private
   */
  async _checkAWSConnectivity() {
    await this._runCheck(
      'AWS API Connectivity',
      '🌐 Testing AWS API connectivity...',
      async () => {
        try {
          // Test ECS API connectivity
          const client = new AWSClientManager({
            profile: config.get('aws.profile'),
            region: config.get('aws.region')
          });

          const ecsClient = await client.getECSClient();
          
          // Simple ECS API call to test connectivity
          const clusters = await ecsClient.listClusters({ maxResults: 1 });
          
          client.dispose();

          return {
            status: 'passed',
            message: `✅ AWS ECS API accessible in ${config.get('aws.region')}`,
            details: {
              region: config.get('aws.region'),
              clusterCount: clusters.clusterArns?.length || 0,
              apiEndpoint: `ecs.${config.get('aws.region')}.amazonaws.com`
            }
          };

        } catch (error) {
          const issues = [];
          const suggestions = [];

          if (error.message.includes('credentials')) {
            issues.push('Invalid AWS credentials');
            suggestions.push('Verify AWS credentials with "aws sts get-caller-identity"');
          } else if (error.message.includes('region')) {
            issues.push('Invalid or inaccessible AWS region');
            suggestions.push('Check region configuration and availability');
          } else if (error.message.includes('UnauthorizedOperation') || error.message.includes('AccessDenied')) {
            issues.push('Insufficient permissions for ECS API');
            suggestions.push('Ensure your AWS user/role has ECS permissions');
          } else {
            issues.push('AWS API connectivity failed');
            suggestions.push('Check internet connection and AWS service status');
          }

          return {
            status: 'failed',
            message: `❌ AWS API connectivity failed: ${issues[0]}`,
            details: { error: error.message, issues, suggestions }
          };
        }
      }
    );
  }

  /**
   * Check configuration file
   * @returns {Promise<void>}
   * @private
   */
  async _checkConfigurationFile() {
    await this._runCheck(
      'Configuration File',
      '📄 Checking taskonaut configuration...',
      async () => {
        const configPath = config.getConfigPath();
        const configExists = config.hasConfigFile();
        
        const details = {
          configPath,
          configExists,
          currentConfig: {
            awsProfile: config.get('aws.profile'),
            awsRegion: config.get('aws.region'),
            logLevel: config.get('logging.level'),
            quiet: config.get('cli.quiet'),
            verbose: config.get('cli.verbose'),
            outputFormat: config.get('cli.outputFormat'),
            confirmActions: config.get('cli.confirmActions'),
            pageSize: config.get('cli.pageSize'),
            enableExecuteCommand: config.get('ecs.enableExecuteCommand'),
            defaultCluster: config.get('ecs.defaultCluster'),
            taskDefinitionFamily: config.get('ecs.taskDefinitionFamily')
          }
        };

        const issues = [];
        const suggestions = [];
        
        // Check for conflicting configurations
        if (config.get('cli.quiet') && config.get('cli.verbose')) {
          issues.push('Both quiet and verbose modes are enabled');
          suggestions.push('Disable one of the conflicting modes');
        }

        // Check for invalid output format
        const validFormats = ['list', 'json', 'yaml'];
        if (!validFormats.includes(config.get('cli.outputFormat'))) {
          issues.push(`Invalid output format: ${config.get('cli.outputFormat')}`);
          suggestions.push(`Use one of: ${validFormats.join(', ')}`);
        }

        // Check for invalid log level
        const validLogLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
        if (!validLogLevels.includes(config.get('logging.level'))) {
          issues.push(`Invalid log level: ${config.get('logging.level')}`);
          suggestions.push(`Use one of: ${validLogLevels.join(', ')}`);
        }

        const status = issues.length > 0 ? 'warning' : 'passed';
        
        let message;
        if (status === 'passed') {
          message = configExists 
            ? `✅ Configuration file loaded: ${configPath}`
            : '✅ Using default configuration (no custom config file)';
        } else {
          message = `⚠️ Configuration has issues: ${issues[0]}`;
        }

        return {
          status,
          message,
          details: { ...details, issues, suggestions }
        };
      }
    );
  }

  /**
   * Check system requirements
   * @returns {Promise<void>}
   * @private
   */
  async _checkSystemRequirements() {
    await this._runCheck(
      'System Requirements',
      '💻 Checking system requirements...',
      async () => {
        const requirements = {
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
          memory: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
          uptime: Math.round(process.uptime())
        };

        const issues = [];
        const suggestions = [];

        // Check available memory (require at least 512MB heap)
        if (requirements.memory < 512) {
          issues.push(`Low memory available: ${requirements.memory}MB`);
          suggestions.push('Ensure sufficient system memory for Node.js operations');
        }

        // Platform-specific checks
        if (requirements.platform === 'win32') {
          // Windows-specific requirements
          try {
            execSync('where aws', { stdio: 'pipe' });
          } catch {
            issues.push('AWS CLI not in PATH on Windows');
            suggestions.push('Add AWS CLI to Windows PATH environment variable');
          }
        }

        const status = issues.length > 0 ? 'warning' : 'passed';
        const message = status === 'passed' 
          ? `✅ System requirements met (${requirements.platform}/${requirements.arch})`
          : `⚠️ System requirements have warnings: ${issues[0]}`;

        return {
          status,
          message,
          details: { ...requirements, issues, suggestions }
        };
      }
    );
  }

  /**
   * Run a single diagnostic check
   * @param {string} name - Check name
   * @param {string} description - Check description
   * @param {Function} checkFn - Check function
   * @returns {Promise<void>}
   * @private
   */
  async _runCheck(name, description, checkFn) {
    const result = await SpinnerUtils.withSpinner(
      checkFn,
      description,
      null,
      `${name} check failed`
    );

    this.results.checks.push({
      name,
      ...result
    });

    this.results.summary.total++;
    
    switch (result.status) {
      case 'passed':
        this.results.summary.passed++;
        logger.success(result.message);
        break;
      case 'warning':
        this.results.summary.warnings++;
        logger.warn(result.message);
        break;
      case 'failed':
        this.results.summary.failed++;
        logger.error(result.message);
        break;
    }
  }

  /**
   * Display diagnostic results
   * @private
   */
  _displayResults() {
    const { summary, checks } = this.results;
    
    console.log('\n' + formatter.formatHeader('📊 Diagnostic Results Summary', { color: 'primary' }));
    
    // Summary with enhanced formatting
    console.log(formatter.formatKeyValue({
      'Total Checks': summary.total,
      'Passed': `${summary.passed} ✅`,
      'Warnings': `${summary.warnings} ⚠️`,
      'Failed': `${summary.failed} ❌`
    }));

    // Overall status with detailed messaging
    let overallStatus, statusMessage, statusColor, statusEmoji;
    
    if (summary.failed === 0 && summary.warnings === 0) {
      overallStatus = 'Excellent';
      statusMessage = 'All checks passed! Your environment is perfectly configured for taskonaut.';
      statusColor = 'success';
      statusEmoji = '🎉';
    } else if (summary.failed === 0) {
      overallStatus = 'Good with warnings';
      statusMessage = 'Environment is functional but has some minor issues that should be addressed.';
      statusColor = 'warning';
      statusEmoji = '⚠️';
    } else if (summary.failed <= 2) {
      overallStatus = 'Issues detected';
      statusMessage = 'Some critical issues found that may prevent proper operation.';
      statusColor = 'error';
      statusEmoji = '❌';
    } else {
      overallStatus = 'Multiple failures';
      statusMessage = 'Several critical issues found. Environment setup required.';
      statusColor = 'error';
      statusEmoji = '🚨';
    }

    console.log('\n' + formatter.formatStatus('Overall Status:', 'info', '📋'));
    console.log(formatter.formatStatus(`${statusEmoji} ${overallStatus}: ${statusMessage}`, statusColor));

    // Detailed results for failed/warning checks
    const problemChecks = checks.filter(check => check.status !== 'passed');
    
    if (problemChecks.length > 0) {
      console.log('\n' + formatter.formatStatus('Issues and Recommendations:', 'warning', '🔧'));
      
      problemChecks.forEach(check => {
        const icon = check.status === 'failed' ? '❌' : '⚠️';
        console.log(`\n${icon} ${check.name}:`);
        console.log(`   ${check.message}`);
        
        if (check.details?.suggestion) {
          console.log(`   💡 Solution: ${check.details.suggestion}`);
        }
        
        if (check.details?.suggestions && Array.isArray(check.details.suggestions)) {
          check.details.suggestions.forEach(suggestion => {
            console.log(`   💡 ${suggestion}`);
          });
        }
      });
    }

    // Next steps based on status
    console.log('\n' + formatter.formatStatus('Next Steps:', 'info', '🎯'));
    
    if (summary.failed === 0 && summary.warnings === 0) {
      console.log(formatter.formatList([
        'Run "taskonaut" to start using ECS Task Executor',
        'Try "taskonaut config show" to view your settings',
        'Visit our docs for advanced usage tips'
      ], { bullet: '🚀', color: 'success' }));
    } else if (summary.failed === 0) {
      console.log(formatter.formatList([
        'Address the warnings above for optimal performance',
        'You can still use taskonaut with current setup',
        'Run "taskonaut config set" if AWS profile issues exist'
      ], { bullet: '⚠️', color: 'warning' }));
    } else {
      console.log(formatter.formatList([
        'Fix the failed checks before using taskonaut',
        'Start with AWS CLI and Session Manager Plugin installation',
        'Run "taskonaut config set" after fixing AWS issues',
        'Re-run "taskonaut doctor" to verify fixes'
      ], { bullet: '🔧', color: 'error' }));
    }

    console.log('\n' + formatter.formatStatus('🩺 Health check completed! Need help? Visit https://github.com/SchematicHQ/taskonaut', 'info'));
  }

  /**
   * Get command configuration for Commander.js
   * @returns {Object} Command configuration
   */
  static getCommandConfig() {
    return {
      name: 'doctor',
      description: '🏥 Run environment diagnostics and health checks',
      aliases: ['diag', 'check'],
      action: async (options) => {
        const command = new DoctorCommand(options);
        await command.runDiagnostics();
      }
    };
  }

  /**
   * Get structured help data for this command
   * @returns {Object} Help data structure
   */
  static getHelpData() {
    return {
      name: 'doctor',
      emoji: '🏥',
      description: 'Comprehensive environment diagnostics and health checks for taskonaut',
      usage: 'taskonaut doctor [options]',
      options: [
        {
          short: '-h',
          long: '--help',
          description: 'Display help for doctor command'
        }
      ],
      examples: [
        {
          command: 'taskonaut doctor',
          description: 'Run complete environment diagnostics',
          highlight: true
        },
        {
          command: 'taskonaut diag',
          description: 'Same as above using alias'
        }
      ],
      notes: [
        'Checks Node.js, AWS CLI, Session Manager Plugin',
        'Validates AWS credentials and connectivity',
        'Verifies taskonaut configuration',
        'Provides detailed troubleshooting guidance',
        'Run this first if experiencing any issues'
      ]
    };
  }
}

export default DoctorCommand; 