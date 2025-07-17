/**
 * @fileoverview Centralized error handling system for taskonaut
 * @author taskonaut
 * @version 1.0.0
 */

import logger from './logger.js';

/**
 * Error codes for different types of errors
 */
export const ERROR_CODES = {
  // AWS related errors
  AWS_CREDENTIALS_MISSING: 'AWS_CREDENTIALS_MISSING',
  AWS_PROFILE_INVALID: 'AWS_PROFILE_INVALID',
  AWS_REGION_INVALID: 'AWS_REGION_INVALID',
  AWS_API_ERROR: 'AWS_API_ERROR',
  
  // ECS related errors
  ECS_CLUSTER_NOT_FOUND: 'ECS_CLUSTER_NOT_FOUND',
  ECS_TASK_NOT_FOUND: 'ECS_TASK_NOT_FOUND',
  ECS_SERVICE_NOT_FOUND: 'ECS_SERVICE_NOT_FOUND',
  ECS_CONTAINER_NOT_FOUND: 'ECS_CONTAINER_NOT_FOUND',
  ECS_EXEC_DISABLED: 'ECS_EXEC_DISABLED',
  ECS_NO_RUNNING_TASKS: 'ECS_NO_RUNNING_TASKS',
  
  // CLI related errors
  CLI_INVALID_COMMAND: 'CLI_INVALID_COMMAND',
  CLI_MISSING_DEPENDENCY: 'CLI_MISSING_DEPENDENCY',
  CLI_USER_CANCELLED: 'CLI_USER_CANCELLED',
  CLI_TIMEOUT: 'CLI_TIMEOUT',
  
  // Validation errors
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  INVALID_INPUT: 'INVALID_INPUT',
  
  // System errors
  SYSTEM_ERROR: 'SYSTEM_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
  PERMISSION_DENIED: 'PERMISSION_DENIED'
};

/**
 * Error messages with emojis for consistent user experience
 */
export const ERROR_MESSAGES = {
  [ERROR_CODES.AWS_CREDENTIALS_MISSING]: '🔐 AWS credentials not found. Please configure your AWS credentials.',
  [ERROR_CODES.AWS_PROFILE_INVALID]: '👤 Invalid AWS profile. Please check your AWS profile configuration.',
  [ERROR_CODES.AWS_REGION_INVALID]: '🌍 Invalid AWS region. Please specify a valid AWS region.',
  [ERROR_CODES.AWS_API_ERROR]: '☁️ AWS API error occurred. Please check your permissions and try again.',
  
  [ERROR_CODES.ECS_CLUSTER_NOT_FOUND]: '🏗️ ECS cluster not found. Please verify the cluster name.',
  [ERROR_CODES.ECS_TASK_NOT_FOUND]: '📋 No tasks found. Please check if tasks are running in the cluster.',
  [ERROR_CODES.ECS_SERVICE_NOT_FOUND]: '⚙️ ECS service not found. Please verify the service name.',
  [ERROR_CODES.ECS_CONTAINER_NOT_FOUND]: '📦 Container not found in the task.',
  [ERROR_CODES.ECS_EXEC_DISABLED]: '🚫 ECS Exec is not enabled for this task. Please enable ECS Exec.',
  [ERROR_CODES.ECS_NO_RUNNING_TASKS]: '💤 No running tasks found in the cluster.',
  
  [ERROR_CODES.CLI_INVALID_COMMAND]: '❓ Invalid command. Use --help to see available commands.',
  [ERROR_CODES.CLI_MISSING_DEPENDENCY]: '📦 Missing required dependency. Please install the required tools.',
  [ERROR_CODES.CLI_USER_CANCELLED]: '🚫 Operation cancelled by user.',
  [ERROR_CODES.CLI_TIMEOUT]: '⏰ Operation timed out. Please try again.',
  
  [ERROR_CODES.VALIDATION_FAILED]: '❌ Validation failed. Please check your input.',
  [ERROR_CODES.INVALID_INPUT]: '📝 Invalid input provided. Please check the format and try again.',
  
  [ERROR_CODES.SYSTEM_ERROR]: '💻 System error occurred. Please try again or contact support.',
  [ERROR_CODES.NETWORK_ERROR]: '🌐 Network error. Please check your internet connection.',
  [ERROR_CODES.PERMISSION_DENIED]: '🔒 Permission denied. Please check your access rights.'
};

/**
 * Base error class for all taskonaut errors
 */
export class TaskonautError extends Error {
  /**
   * Create a new TaskonautError
   * @param {string} message - Error message
   * @param {string} code - Error code
   * @param {Object} metadata - Additional error metadata
   * @param {Error} cause - Original error that caused this error
   */
  constructor(message, code = ERROR_CODES.SYSTEM_ERROR, metadata = {}, cause = null) {
    super(message);
    this.name = 'TaskonautError';
    this.code = code;
    this.metadata = metadata;
    this.cause = cause;
    this.timestamp = new Date().toISOString();
    
    // Maintain proper stack trace for where our error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TaskonautError);
    }
  }

  /**
   * Get user-friendly error message
   * @returns {string} User-friendly error message
   */
  getUserMessage() {
    return ERROR_MESSAGES[this.code] || this.message;
  }

  /**
   * Convert error to JSON for logging/serialization
   * @returns {Object} Error as JSON object
   */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      metadata: this.metadata,
      stack: this.stack,
      timestamp: this.timestamp,
      cause: this.cause ? {
        name: this.cause.name,
        message: this.cause.message,
        stack: this.cause.stack
      } : null
    };
  }
}

/**
 * AWS-specific error class
 */
export class AWSError extends TaskonautError {
  /**
   * Create a new AWSError
   * @param {string} message - Error message
   * @param {string} [code=ERROR_CODES.AWS_API_ERROR] - AWS error code
   * @param {Object} [metadata={}] - Additional error metadata
   * @param {Error} [cause=null] - Original error that caused this error
   */
  constructor(message, code = ERROR_CODES.AWS_API_ERROR, metadata = {}, cause = null) {
    super(message, code, metadata, cause);
    this.name = 'AWSError';
  }
}

/**
 * ECS-specific error class
 */
export class ECSError extends TaskonautError {
  /**
   * Create a new ECSError
   * @param {string} message - Error message
   * @param {string} [code=ERROR_CODES.ECS_CLUSTER_NOT_FOUND] - ECS error code
   * @param {Object} [metadata={}] - Additional error metadata
   * @param {Error} [cause=null] - Original error that caused this error
   */
  constructor(message, code = ERROR_CODES.ECS_CLUSTER_NOT_FOUND, metadata = {}, cause = null) {
    super(message, code, metadata, cause);
    this.name = 'ECSError';
  }
}

/**
 * CLI-specific error class
 */
export class CLIError extends TaskonautError {
  /**
   * Create a new CLIError
   * @param {string} message - Error message
   * @param {string} [code=ERROR_CODES.CLI_INVALID_COMMAND] - CLI error code
   * @param {Object} [metadata={}] - Additional error metadata
   * @param {Error} [cause=null] - Original error that caused this error
   */
  constructor(message, code = ERROR_CODES.CLI_INVALID_COMMAND, metadata = {}, cause = null) {
    super(message, code, metadata, cause);
    this.name = 'CLIError';
  }
}

/**
 * Validation error class
 */
export class ValidationError extends TaskonautError {
  /**
   * Create a new ValidationError
   * @param {string} message - Error message
   * @param {string} [field=null] - Field that failed validation
   * @param {*} [value=null] - Value that failed validation
   * @param {Error} [cause=null] - Original error that caused this error
   */
  constructor(message, field = null, value = null, cause = null) {
    const metadata = { field, value };
    super(message, ERROR_CODES.VALIDATION_FAILED, metadata, cause);
    this.name = 'ValidationError';
  }
}

/**
 * User cancellation error class
 */
export class UserCancelledError extends CLIError {
  /**
   * Create a new UserCancelledError
   * @param {string} [message='Operation cancelled by user'] - Error message
   */
  constructor(message = 'Operation cancelled by user') {
    super(message, ERROR_CODES.CLI_USER_CANCELLED);
    this.name = 'UserCancelledError';
  }
}

/**
 * Error handler utility functions
 */
export class ErrorHandler {
  /**
   * Handle and log an error appropriately
   * @param {Error} error - Error to handle
   * @param {Object} context - Additional context for logging
   * @returns {void}
   */
  static handle(error, context = {}) {
    if (error instanceof TaskonautError) {
      logger.error(error.getUserMessage(), {
        code: error.code,
        metadata: error.metadata,
        context,
        ...(error.cause && { cause: error.cause.message })
      });
    } else {
      logger.error(error.message || 'Unknown error occurred', {
        code: ERROR_CODES.SYSTEM_ERROR,
        error: error.name,
        context,
        stack: error.stack
      });
    }
  }

  /**
   * Handle and log an error, then exit the process
   * @param {Error} error - Error to handle
   * @param {Object} context - Additional context for logging
   * @param {number} exitCode - Exit code (default: 1)
   * @returns {never}
   */
  static handleAndExit(error, context = {}, exitCode = 1) {
    this.handle(error, context);
    process.exit(exitCode);
  }

  /**
   * Wrap an async function with error handling
   * @param {Function} fn - Async function to wrap
   * @param {Object} context - Context for error logging
   * @returns {Function} Wrapped function
   */
  static wrapAsync(fn, context = {}) {
    return async (...args) => {
      try {
        return await fn(...args);
      } catch (error) {
        this.handle(error, context);
        throw error;
      }
    };
  }

  /**
   * Create an error from AWS SDK error
   * @param {Error} awsError - AWS SDK error
   * @param {string} operation - The operation that failed
   * @returns {AWSError} Formatted AWS error
   */
  static fromAWSError(awsError, operation = 'AWS operation') {
    const code = awsError.code || awsError.name;
    let errorCode = ERROR_CODES.AWS_API_ERROR;
    
    // Map common AWS error codes to our error codes
    switch (code) {
      case 'NoCredentialsError':
      case 'CredentialsError':
        errorCode = ERROR_CODES.AWS_CREDENTIALS_MISSING;
        break;
      case 'InvalidUserID.NotFound':
      case 'ProfileNotFound':
        errorCode = ERROR_CODES.AWS_PROFILE_INVALID;
        break;
      case 'InvalidRegion':
        errorCode = ERROR_CODES.AWS_REGION_INVALID;
        break;
      case 'ClusterNotFoundException':
        errorCode = ERROR_CODES.ECS_CLUSTER_NOT_FOUND;
        break;
      case 'ServiceNotFoundException':
        errorCode = ERROR_CODES.ECS_SERVICE_NOT_FOUND;
        break;
      case 'AccessDeniedException':
        errorCode = ERROR_CODES.PERMISSION_DENIED;
        break;
    }

    return new AWSError(
      `${operation} failed: ${awsError.message}`,
      errorCode,
      {
        operation,
        awsErrorCode: code,
        requestId: awsError.requestId
      },
      awsError
    );
  }

  /**
   * Check if error is a user cancellation
   * @param {Error} error - Error to check
   * @returns {boolean} True if user cancelled
   */
  static isUserCancelled(error) {
    return error instanceof UserCancelledError || 
           error.code === ERROR_CODES.CLI_USER_CANCELLED ||
           error.message?.includes('cancelled') ||
           error.message?.includes('aborted');
  }

  /**
   * Check if error should cause process exit
   * @param {Error} error - Error to check
   * @returns {boolean} True if should exit
   */
  static shouldExit(error) {
    if (error instanceof UserCancelledError) return true;
    
    const fatalCodes = [
      ERROR_CODES.AWS_CREDENTIALS_MISSING,
      ERROR_CODES.CLI_MISSING_DEPENDENCY,
      ERROR_CODES.PERMISSION_DENIED
    ];
    
    return error instanceof TaskonautError && fatalCodes.includes(error.code);
  }
}

/**
 * Global error handlers for unhandled errors
 */
export function setupGlobalErrorHandlers() {
  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    logger.fatal('Unhandled promise rejection', {
      reason: reason instanceof Error ? reason.message : reason,
      stack: reason instanceof Error ? reason.stack : undefined,
      promise
    });
    process.exit(1);
  });

  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    logger.fatal('Uncaught exception', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  });

  // Handle SIGINT (Ctrl+C) gracefully
  process.on('SIGINT', () => {
    logger.info('Received SIGINT, shutting down gracefully...');
    process.exit(0);
  });

  // Handle SIGTERM gracefully
  process.on('SIGTERM', () => {
    logger.info('Received SIGTERM, shutting down gracefully...');
    process.exit(0);
  });
} 