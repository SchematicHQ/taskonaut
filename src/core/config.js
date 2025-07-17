/**
 * @fileoverview Configuration management for taskonaut
 * @author taskonaut
 * @version 1.0.0
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { ValidationError, ERROR_CODES } from './errors.js';
import logger from './logger.js';

/**
 * Default configuration values
 */
const DEFAULT_CONFIG = {
  aws: {
    profile: 'default',
    region: 'us-east-1',
    timeout: 30000, // 30 seconds
    maxRetries: 3
  },
  cli: {
    outputFormat: 'list', // list, json, yaml
    quiet: false,
    verbose: false,
    confirmActions: true,
    pageSize: 10,
    timeout: 300000 // 5 minutes for operations
  },
  ecs: {
    enableExecuteCommand: true,
    taskDefinitionFamily: null,
    defaultCluster: null
  },
  logging: {
    level: 'info',
    timestamp: true,
    colorize: true
  }
};

/**
 * Valid AWS regions (subset of commonly used regions)
 */
const AWS_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1',
  'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-northeast-2',
  'ap-south-1', 'ca-central-1', 'sa-east-1'
];

/**
 * Configuration manager class
 */
export class ConfigManager {
  /**
   * Create a new ConfigManager instance
   * @param {Object} overrides - Configuration overrides
   */
  constructor(overrides = {}) {
    this.configPath = join(homedir(), '.taskonaut');
    this.config = this._loadConfig(overrides);
    this._migrateConfig();
    this._validateConfig();
  }

  /**
   * Load configuration from file and merge with defaults
   * @param {Object} overrides - Configuration overrides
   * @returns {Object} Merged configuration
   * @private
   */
  _loadConfig(overrides = {}) {
    let fileConfig = {};
    
    try {
      if (existsSync(this.configPath)) {
        const content = readFileSync(this.configPath, 'utf8');
        fileConfig = JSON.parse(content);
        logger.debug('Configuration loaded from file', { path: this.configPath });
      } else {
        logger.debug('Configuration file not found, using defaults', { path: this.configPath });
      }
    } catch (error) {
      logger.warn('Failed to load configuration file, using defaults', { 
        path: this.configPath,
        error: error.message 
      });
    }

    return this._mergeConfig(DEFAULT_CONFIG, this._mergeConfig(fileConfig, overrides));
  }

  /**
   * Migrate configuration from older versions
   * @private
   */
  _migrateConfig() {
    let migrated = false;

    // Migrate outputFormat from 'table' to 'list'
    if (this.config.cli && this.config.cli.outputFormat === 'table') {
      this.config.cli.outputFormat = 'list';
      migrated = true;
      logger.info('Migrated outputFormat from "table" to "list"');
    }

    // Save migrated config back to file
    if (migrated) {
      try {
        this._saveConfig();
        logger.debug('Migrated configuration saved');
      } catch (error) {
        logger.warn('Failed to save migrated configuration', { error: error.message });
      }
    }
  }

  /**
   * Save configuration to file
   * @returns {void}
   * @private
   */
  _saveConfig() {
    try {
      const content = JSON.stringify(this.config, null, 2);
      writeFileSync(this.configPath, content, 'utf8');
      logger.debug('Configuration saved to file', { path: this.configPath });
    } catch (error) {
      logger.error('Failed to save configuration file', { 
        path: this.configPath,
        error: error.message 
      });
      throw new ValidationError(`Failed to save configuration: ${error.message}`);
    }
  }

  /**
   * Deep merge configuration objects
   * @param {Object} target - Target configuration
   * @param {Object} source - Source configuration
   * @returns {Object} Merged configuration
   * @private
   */
  _mergeConfig(target, source) {
    const result = { ...target };
    
    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this._mergeConfig(result[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
    
    return result;
  }

  /**
   * Validate configuration values
   * @private
   */
  _validateConfig() {
    // Validate AWS region
    if (!AWS_REGIONS.includes(this.config.aws.region)) {
      throw new ValidationError(
        `Invalid AWS region: ${this.config.aws.region}`,
        'aws.region',
        this.config.aws.region
      );
    }

    // Validate timeouts
    if (this.config.aws.timeout <= 0 || this.config.cli.timeout <= 0) {
      throw new ValidationError(
        'Timeout values must be positive numbers',
        'timeout',
        this.config.aws.timeout
      );
    }

    // Validate output format
    const validFormats = ['list', 'json', 'yaml'];
    if (!validFormats.includes(this.config.cli.outputFormat)) {
      throw new ValidationError(
        `Invalid output format: ${this.config.cli.outputFormat}`,
        'cli.outputFormat',
        this.config.cli.outputFormat
      );
    }
  }

  /**
   * Get configuration value by path
   * @param {string} path - Configuration path (e.g., 'aws.region')
   * @returns {*} Configuration value
   */
  get(path) {
    return path.split('.').reduce((obj, key) => obj?.[key], this.config);
  }

  /**
   * Set configuration value by path
   * @param {string} path - Configuration path
   * @param {*} value - Value to set
   */
  set(path, value) {
    const keys = path.split('.');
    const lastKey = keys.pop();
    const target = keys.reduce((obj, key) => {
      obj[key] = obj[key] || {};
      return obj[key];
    }, this.config);
    
    target[lastKey] = value;
    this._validateConfig();
    this._saveConfig();
  }

  /**
   * Set configuration value by path without saving to file (runtime override)
   * @param {string} path - Configuration path
   * @param {*} value - Value to set
   */
  setRuntime(path, value) {
    const keys = path.split('.');
    const lastKey = keys.pop();
    const target = keys.reduce((obj, key) => {
      obj[key] = obj[key] || {};
      return obj[key];
    }, this.config);
    
    target[lastKey] = value;
    this._validateConfig();
    // Note: No _saveConfig() call - this is a runtime-only override
  }

  /**
   * Get AWS configuration
   * @returns {Object} AWS configuration
   */
  getAWSConfig() {
    return { ...this.config.aws };
  }

  /**
   * Get CLI configuration
   * @returns {Object} CLI configuration
   */
  getCLIConfig() {
    return { ...this.config.cli };
  }

  /**
   * Get ECS configuration
   * @returns {Object} ECS configuration
   */
  getECSConfig() {
    return { ...this.config.ecs };
  }

  /**
   * Get logging configuration
   * @returns {Object} Logging configuration
   */
  getLoggingConfig() {
    return { ...this.config.logging };
  }

  /**
   * Get all configuration
   * @returns {Object} Complete configuration
   */
  getAll() {
    return { ...this.config };
  }

  /**
   * Check if running in quiet mode
   * @returns {boolean} True if quiet mode is enabled
   */
  isQuiet() {
    return this.config.cli.quiet;
  }

  /**
   * Check if running in verbose mode
   * @returns {boolean} True if verbose mode is enabled
   */
  isVerbose() {
    return this.config.cli.verbose;
  }

  /**
   * Check if action confirmation is required
   * @returns {boolean} True if confirmation is required
   */
  shouldConfirmActions() {
    return this.config.cli.confirmActions;
  }

  /**
   * Get configuration file path
   * @returns {string} Path to configuration file
   */
  getConfigPath() {
    return this.configPath;
  }

  /**
   * Check if configuration file exists
   * @returns {boolean} True if configuration file exists
   */
  hasConfigFile() {
    return existsSync(this.configPath);
  }

  /**
   * Reset configuration to defaults
   * @returns {void}
   */
  resetConfig() {
    this.config = this._mergeConfig(DEFAULT_CONFIG, {});
    this._validateConfig();
    this._saveConfig();
  }

  /**
   * Create default configuration file
   * @returns {void}
   */
  createDefaultConfig() {
    this.config = this._mergeConfig(DEFAULT_CONFIG, {});
    this._validateConfig();
    this._saveConfig();
  }
}

/**
 * AWS Profile and Credentials Manager
 */
export class AWSProfileManager {
  /**
   * Get AWS credentials file path
   * @returns {string} Path to AWS credentials file
   */
  static getCredentialsPath() {
    return join(homedir(), '.aws', 'credentials');
  }

  /**
   * Get AWS config file path
   * @returns {string} Path to AWS config file
   */
  static getConfigPath() {
    return join(homedir(), '.aws', 'config');
  }

  /**
   * Check if AWS credentials file exists
   * @returns {boolean} True if credentials file exists
   */
  static hasCredentialsFile() {
    return existsSync(this.getCredentialsPath());
  }

  /**
   * Check if AWS config file exists
   * @returns {boolean} True if config file exists
   */
  static hasConfigFile() {
    return existsSync(this.getConfigPath());
  }

  /**
   * Parse AWS credentials file
   * @returns {Object} Parsed credentials by profile
   */
  static parseCredentials() {
    const credentialsPath = this.getCredentialsPath();
    
    if (!existsSync(credentialsPath)) {
      return {};
    }

    try {
      const content = readFileSync(credentialsPath, 'utf8');
      return this._parseINIFile(content);
    } catch (error) {
      logger.warn('Failed to parse AWS credentials file', { error: error.message });
      return {};
    }
  }

  /**
   * Parse AWS config file
   * @returns {Object} Parsed config by profile
   */
  static parseConfig() {
    const configPath = this.getConfigPath();
    
    if (!existsSync(configPath)) {
      return {};
    }

    try {
      const content = readFileSync(configPath, 'utf8');
      const parsed = this._parseINIFile(content);
      
      // Remove 'profile ' prefix from profile names
      const normalized = {};
      for (const [key, value] of Object.entries(parsed)) {
        const profileName = key.startsWith('profile ') ? key.slice(8) : key;
        normalized[profileName] = value;
      }
      
      return normalized;
    } catch (error) {
      logger.warn('Failed to parse AWS config file', { error: error.message });
      return {};
    }
  }

  /**
   * Get list of available AWS profiles
   * @returns {string[]} Array of profile names
   */
  static getAvailableProfiles() {
    const credentials = this.parseCredentials();
    const config = this.parseConfig();
    
    const profiles = new Set([
      ...Object.keys(credentials),
      ...Object.keys(config)
    ]);
    
    return Array.from(profiles).sort();
  }

  /**
   * Get profile configuration
   * @param {string} profileName - Profile name
   * @returns {Object} Profile configuration
   */
  static getProfile(profileName = 'default') {
    const credentials = this.parseCredentials();
    const config = this.parseConfig();
    
    const profile = {
      ...config[profileName],
      ...credentials[profileName]
    };

    if (!profile.region && !profile.aws_access_key_id) {
      throw new ValidationError(
        `AWS profile '${profileName}' not found or incomplete`,
        'aws.profile',
        profileName
      );
    }

    return profile;
  }

  /**
   * Validate AWS profile
   * @param {string} profileName - Profile name to validate
   * @returns {boolean} True if profile is valid
   */
  static validateProfile(profileName) {
    try {
      this.getProfile(profileName);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get region for profile
   * @param {string} profileName - Profile name
   * @returns {string} Region for the profile
   */
  static getProfileRegion(profileName = 'default') {
    const profile = this.getProfile(profileName);
    return profile.region || DEFAULT_CONFIG.aws.region;
  }

  /**
   * Parse INI format file
   * @param {string} content - File content
   * @returns {Object} Parsed sections
   * @private
   */
  static _parseINIFile(content) {
    const result = {};
    let currentSection = null;

    const lines = content.split('\n');
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
        continue;
      }

      // Section header
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        currentSection = trimmed.slice(1, -1);
        result[currentSection] = {};
        continue;
      }

      // Key-value pair
      if (currentSection && trimmed.includes('=')) {
        const [key, ...valueParts] = trimmed.split('=');
        const value = valueParts.join('=').trim();
        result[currentSection][key.trim()] = value;
      }
    }

    return result;
  }
}



// Create default config manager instance
const configManager = new ConfigManager();

export { AWS_REGIONS, DEFAULT_CONFIG };
export default configManager; 