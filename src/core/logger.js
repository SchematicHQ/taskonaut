/**
 * @fileoverview Centralized logging system for taskonaut with consistent formatting and emojis
 * @author taskonaut
 * @version 1.0.0
 */

import chalk from 'chalk';
import { inspect } from 'node:util';

/**
 * Log levels with corresponding emojis and colors
 */
const LOG_LEVELS = {
  trace: { emoji: '🔍', color: 'gray', level: 0 },
  debug: { emoji: '🐛', color: 'blue', level: 1 },
  info: { emoji: 'ℹ️', color: 'cyan', level: 2 },
  success: { emoji: '✅', color: 'green', level: 2 },
  warn: { emoji: '⚠️', color: 'yellow', level: 3 },
  error: { emoji: '❌', color: 'red', level: 4 },
  fatal: { emoji: '💥', color: 'redBright', level: 5 }
};

/**
 * Default logger configuration
 */
const DEFAULT_CONFIG = {
  level: process.env.LOG_LEVEL || 'warn',
  timestamp: false,
  metadata: false,
  colorize: !process.env.NO_COLOR,
  silent: process.env.NODE_ENV === 'test'
};

/**
 * Centralized Logger class with consistent formatting
 */
class Logger {
  /**
   * Create a new Logger instance
   * @param {Object} config - Logger configuration
   * @param {string} config.level - Minimum log level to output
   * @param {boolean} config.timestamp - Whether to include timestamps
   * @param {boolean} config.metadata - Whether to include metadata
   * @param {boolean} config.colorize - Whether to colorize output
   * @param {boolean} config.silent - Whether to suppress output
   */
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.currentLevel = LOG_LEVELS[this.config.level]?.level ?? 2;
  }

  /**
   * Format a log message with consistent structure
   * @param {string} level - Log level
   * @param {string} message - Main message
   * @param {Object} meta - Additional metadata
   * @returns {string} Formatted log message
   * @private
   */
  _formatMessage(level, message, meta = {}) {
    const levelConfig = LOG_LEVELS[level];
    if (!levelConfig) return message;

    let formatted = '';

    // Add timestamp if enabled
    if (this.config.timestamp) {
      const timestamp = new Date().toISOString();
      formatted += this.config.colorize 
        ? chalk.gray(`[${timestamp}]`) 
        : `[${timestamp}]`;
      formatted += ' ';
    }

    // Add emoji and level
    const levelDisplay = `${levelConfig.emoji} ${level.toUpperCase()}`;
    formatted += this.config.colorize 
      ? chalk[levelConfig.color](levelDisplay)
      : levelDisplay;
    formatted += ' ';

    // Add main message
    formatted += this.config.colorize && levelConfig.color !== 'gray'
      ? chalk[levelConfig.color](message)
      : message;

    // Add metadata if provided and enabled
    if (this.config.metadata && Object.keys(meta).length > 0) {
      const metaStr = inspect(meta, { 
        colors: this.config.colorize, 
        depth: 3, 
        compact: true 
      });
      formatted += ` ${metaStr}`;
    }

    return formatted;
  }

  /**
   * Log a message at the specified level
   * @param {string} level - Log level
   * @param {string} message - Message to log
   * @param {Object} meta - Additional metadata
   * @private
   */
  _log(level, message, meta = {}) {
    const levelConfig = LOG_LEVELS[level];
    if (!levelConfig || levelConfig.level < this.currentLevel || this.config.silent) {
      return;
    }

    const formatted = this._formatMessage(level, message, meta);
    
    // Use appropriate console method
    const consoleMethod = level === 'error' || level === 'fatal' ? 'error' : 'log';
    console[consoleMethod](formatted);
  }

  /**
   * Log trace message (very detailed debugging)
   * @param {string} message - Message to log
   * @param {Object} meta - Additional metadata
   */
  trace(message, meta = {}) {
    this._log('trace', message, meta);
  }

  /**
   * Log debug message
   * @param {string} message - Message to log
   * @param {Object} meta - Additional metadata
   */
  debug(message, meta = {}) {
    this._log('debug', message, meta);
  }

  /**
   * Log info message
   * @param {string} message - Message to log
   * @param {Object} meta - Additional metadata
   */
  info(message, meta = {}) {
    this._log('info', message, meta);
  }

  /**
   * Log success message
   * @param {string} message - Message to log
   * @param {Object} meta - Additional metadata
   */
  success(message, meta = {}) {
    this._log('success', message, meta);
  }

  /**
   * Log warning message
   * @param {string} message - Message to log
   * @param {Object} meta - Additional metadata
   */
  warn(message, meta = {}) {
    this._log('warn', message, meta);
  }

  /**
   * Log error message
   * @param {string|Error} message - Message or Error to log
   * @param {Object} meta - Additional metadata
   */
  error(message, meta = {}) {
    if (message instanceof Error) {
      const errorMeta = {
        ...meta,
        stack: message.stack,
        name: message.name,
        code: message.code
      };
      this._log('error', message.message, errorMeta);
    } else {
      this._log('error', message, meta);
    }
  }

  /**
   * Log fatal error message
   * @param {string|Error} message - Message or Error to log
   * @param {Object} meta - Additional metadata
   */
  fatal(message, meta = {}) {
    if (message instanceof Error) {
      const errorMeta = {
        ...meta,
        stack: message.stack,
        name: message.name,
        code: message.code
      };
      this._log('fatal', message.message, errorMeta);
    } else {
      this._log('fatal', message, meta);
    }
  }

  /**
   * Set the current log level
   * @param {string} level - New log level
   */
  setLevel(level) {
    if (LOG_LEVELS[level]) {
      this.config.level = level;
      this.currentLevel = LOG_LEVELS[level].level;
    }
  }

  /**
   * Check if a log level is enabled
   * @param {string} level - Log level to check
   * @returns {boolean} Whether the level is enabled
   */
  isLevelEnabled(level) {
    const levelConfig = LOG_LEVELS[level];
    return levelConfig && levelConfig.level >= this.currentLevel;
  }
}

// Create default logger instance
const logger = new Logger();

export { Logger, LOG_LEVELS };
export default logger; 