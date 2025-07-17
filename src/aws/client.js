/**
 * @fileoverview AWS client initialization and credential management for taskonaut
 * @author taskonaut
 * @version 1.0.0
 */

import { ECS } from '@aws-sdk/client-ecs';
import { fromIni } from '@aws-sdk/credential-providers';
import { AWSError, ErrorHandler, ERROR_CODES } from '../core/errors.js';
import logger from '../core/logger.js';
import { AWSProfileManager } from '../core/config.js';

/**
 * AWS service client manager
 */
export class AWSClientManager {
  /**
   * Create a new AWSClientManager instance
   * @param {Object} options - Configuration options
   * @param {string} [options.profile] - AWS profile to use
   * @param {string} [options.region] - AWS region
   * @param {number} [options.timeout=30000] - Request timeout in milliseconds
   * @param {number} [options.maxRetries=3] - Maximum retry attempts
   */
  constructor(options = {}) {
    this.options = {
      profile: process.env.AWS_PROFILE || 'default',
      region: process.env.AWS_DEFAULT_REGION || 'us-east-1',
      timeout: 30000,
      maxRetries: 3,
      ...options
    };
    
    this.clients = new Map();
    this.credentials = null;
  }

  /**
   * Initialize AWS credentials for the configured profile
   * @returns {Promise<Object>} AWS credentials
   */
  async initializeCredentials() {
    try {
      logger.debug('Initializing AWS credentials', { 
        profile: this.options.profile,
        region: this.options.region 
      });

      // Validate profile exists
      if (!AWSProfileManager.validateProfile(this.options.profile)) {
        throw new AWSError(
          `AWS profile '${this.options.profile}' not found or invalid`,
          ERROR_CODES.AWS_PROFILE_INVALID,
          { profile: this.options.profile }
        );
      }

      // Initialize credentials
      this.credentials = await fromIni({ 
        profile: this.options.profile 
      })();

      logger.success('AWS credentials initialized', { 
        profile: this.options.profile,
        region: this.options.region 
      });

      return this.credentials;
    } catch (error) {
      const awsError = ErrorHandler.fromAWSError(error, 'credential initialization');
      logger.error('Failed to initialize AWS credentials', {
        profile: this.options.profile,
        error: awsError.message
      });
      throw awsError;
    }
  }

  /**
   * Get or create an ECS client instance
   * @param {Object} [clientOptions] - Additional client options
   * @returns {Promise<ECS>} ECS client instance
   */
  async getECSClient(clientOptions = {}) {
    const clientKey = `ecs-${this.options.profile}-${this.options.region}`;
    
    if (this.clients.has(clientKey)) {
      return this.clients.get(clientKey);
    }

    try {
      // Ensure credentials are initialized
      if (!this.credentials) {
        await this.initializeCredentials();
      }

      logger.debug('Creating ECS client', { 
        profile: this.options.profile,
        region: this.options.region 
      });

      const client = new ECS({
        region: this.options.region,
        credentials: this.credentials,
        requestHandler: {
          requestTimeout: this.options.timeout,
          httpsAgent: { keepAlive: true }
        },
        maxAttempts: this.options.maxRetries,
        ...clientOptions
      });

      this.clients.set(clientKey, client);
      
      logger.success('ECS client created', { 
        profile: this.options.profile,
        region: this.options.region 
      });

      return client;
    } catch (error) {
      const awsError = ErrorHandler.fromAWSError(error, 'ECS client creation');
      logger.error('Failed to create ECS client', {
        profile: this.options.profile,
        region: this.options.region,
        error: awsError.message
      });
      throw awsError;
    }
  }

  /**
   * Test AWS connectivity and permissions
   * @returns {Promise<Object>} Connection test result
   */
  async testConnection() {
    try {
      logger.debug('Testing AWS connection', { 
        profile: this.options.profile,
        region: this.options.region 
      });

      const ecs = await this.getECSClient();
      
      // Try to list clusters as a basic connectivity test
      const result = await ecs.listClusters({ maxResults: 1 });
      
      logger.success('AWS connection test successful', {
        profile: this.options.profile,
        region: this.options.region,
        clustersFound: result.clusterArns?.length || 0
      });

      return {
        connected: true,
        profile: this.options.profile,
        region: this.options.region,
        clustersFound: result.clusterArns?.length || 0
      };
    } catch (error) {
      const awsError = ErrorHandler.fromAWSError(error, 'connection test');
      logger.error('AWS connection test failed', {
        profile: this.options.profile,
        region: this.options.region,
        error: awsError.message
      });
      
      return {
        connected: false,
        profile: this.options.profile,
        region: this.options.region,
        error: awsError.message
      };
    }
  }

  /**
   * Update AWS profile and region
   * @param {string} profile - New AWS profile
   * @param {string} [region] - New AWS region
   */
  async updateProfile(profile, region) {
    logger.debug('Updating AWS profile', { 
      oldProfile: this.options.profile,
      newProfile: profile,
      oldRegion: this.options.region,
      newRegion: region 
    });

    // Clear existing clients and credentials
    this.clients.clear();
    this.credentials = null;

    // Update options
    this.options.profile = profile;
    if (region) {
      this.options.region = region;
    }

    // Re-initialize credentials
    await this.initializeCredentials();

    logger.success('AWS profile updated', { 
      profile: this.options.profile,
      region: this.options.region 
    });
  }

  /**
   * Get current AWS configuration
   * @returns {Object} Current configuration
   */
  getConfiguration() {
    return {
      profile: this.options.profile,
      region: this.options.region,
      timeout: this.options.timeout,
      maxRetries: this.options.maxRetries,
      hasCredentials: !!this.credentials,
      clientCount: this.clients.size
    };
  }

  /**
   * Clear all cached clients and credentials
   */
  clearCache() {
    logger.debug('Clearing AWS client cache');
    this.clients.clear();
    this.credentials = null;
  }

  /**
   * Dispose of all resources
   */
  dispose() {
    logger.debug('Disposing AWS client manager');
    this.clearCache();
  }
}

/**
 * AWS credential validation utilities
 */
export class AWSCredentialValidator {
  /**
   * Validate AWS credentials configuration
   * @param {string} [profile='default'] - Profile to validate
   * @returns {Object} Validation result
   */
  static validateCredentials(profile = 'default') {
    const result = {
      valid: false,
      profile,
      issues: []
    };

    try {
      // Check if credentials file exists
      if (!AWSProfileManager.hasCredentialsFile() && !AWSProfileManager.hasConfigFile()) {
        result.issues.push('No AWS credentials or config file found');
        return result;
      }

      // Check if profile exists
      if (!AWSProfileManager.validateProfile(profile)) {
        result.issues.push(`Profile '${profile}' not found in AWS configuration`);
        return result;
      }

      // Get profile configuration
      const profileConfig = AWSProfileManager.getProfile(profile);
      
      // Check for authentication mechanism
      const hasAccessKeys = profileConfig.aws_access_key_id && profileConfig.aws_secret_access_key;
      const hasRoleArn = profileConfig.role_arn;
      const hasSSO = profileConfig.sso_start_url && profileConfig.sso_account_id && profileConfig.sso_role_name;
      
      if (!hasAccessKeys && !hasRoleArn && !hasSSO) {
        result.issues.push('Profile missing authentication method (access keys, role ARN, or SSO configuration)');
      }

      if (!profileConfig.region) {
        result.issues.push('Profile missing region configuration');
      }

      result.valid = result.issues.length === 0;
      
      return result;
    } catch (error) {
      result.issues.push(`Validation error: ${error.message}`);
      return result;
    }
  }

  /**
   * Get AWS SSO login status
   * @param {string} [profile='default'] - Profile to check
   * @returns {Object} SSO status
   */
  static getSSOStatus(profile = 'default') {
    try {
      const profileConfig = AWSProfileManager.getProfile(profile);
      
      return {
        isSSOProfile: !!(profileConfig.sso_start_url || profileConfig.sso_session),
        ssoStartUrl: profileConfig.sso_start_url,
        ssoSession: profileConfig.sso_session,
        ssoRegion: profileConfig.sso_region,
        ssoAccountId: profileConfig.sso_account_id,
        ssoRoleName: profileConfig.sso_role_name
      };
    } catch (error) {
      return {
        isSSOProfile: false,
        error: error.message
      };
    }
  }
}

/**
 * Global AWS client instance
 */
let globalClient = null;

/**
 * Initialize global AWS client
 * @param {Object} options - Client options
 * @returns {Promise<AWSClientManager>} Global client instance
 */
export async function initializeAWS(options = {}) {
  if (!globalClient) {
    globalClient = new AWSClientManager(options);
    await globalClient.initializeCredentials();
  }
  return globalClient;
}

/**
 * Get global AWS client instance
 * @returns {AWSClientManager|null} Global client instance
 */
export function getAWSClient() {
  return globalClient;
}

/**
 * Reset global AWS client
 */
export function resetAWSClient() {
  if (globalClient) {
    globalClient.dispose();
    globalClient = null;
  }
}

export default AWSClientManager; 