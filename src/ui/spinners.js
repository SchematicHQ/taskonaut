/**
 * @fileoverview Loading spinners and progress indicators for taskonaut
 * @author taskonaut
 * @version 1.0.0
 */

import ora from 'ora';
import chalk from 'chalk';
import { performance } from 'perf_hooks';
import logger from '../core/logger.js';
import config from '../core/config.js';

/**
 * Spinner types and styles
 */
const SPINNER_STYLES = {
  dots: {
    interval: 80,
    frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  },
  line: {
    interval: 130,
    frames: ['-', '\\', '|', '/']
  },
  arrow: {
    interval: 120,
    frames: ['←', '↖', '↑', '↗', '→', '↘', '↓', '↙']
  },
  bounce: {
    interval: 120,
    frames: ['⠁', '⠂', '⠄', '⠂']
  },
  pulse: {
    interval: 120,
    frames: ['●', '○', '●', '○']
  },
  progress: {
    interval: 120,
    frames: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█', '▇', '▆', '▅', '▄', '▃', '▁']
  }
};

/**
 * Default spinner configuration
 */
const DEFAULT_CONFIG = {
  style: 'dots',
  color: 'cyan',
  hideCursor: true,
  discardStdin: false
};

/**
 * Spinner manager class for loading indicators
 */
export class SpinnerManager {
  /**
   * Create a new SpinnerManager instance
   * @param {Object} options - Configuration options
   */
  constructor(options = {}) {
    this.config = { ...DEFAULT_CONFIG, ...options };
    this.spinner = null;
    this.startTime = null;
    this.isActive = false;
  }

  /**
   * Start a spinner with a message
   * @param {string} message - Loading message
   * @param {Object} options - Spinner options
   * @param {string} [options.style] - Spinner style
   * @param {string} [options.color] - Spinner color
   * @returns {SpinnerManager} This instance for chaining
   */
  start(message, options = {}) {
    // Don't show spinner in quiet mode or if already active
    if (config.isQuiet() || this.isActive) {
      return this;
    }

    const spinnerOptions = { ...this.config, ...options };
    
    this.spinner = ora({
      text: message,
      spinner: SPINNER_STYLES[spinnerOptions.style] || SPINNER_STYLES.dots,
      color: spinnerOptions.color,
      hideCursor: spinnerOptions.hideCursor,
      discardStdin: spinnerOptions.discardStdin
    });

    this.startTime = performance.now();
    this.isActive = true;
    this.spinner.start();

    logger.debug('Spinner started', { 
      message, 
      style: spinnerOptions.style,
      color: spinnerOptions.color 
    });

    return this;
  }

  /**
   * Update spinner message
   * @param {string} message - New message
   * @returns {SpinnerManager} This instance for chaining
   */
  updateText(message) {
    if (this.spinner && this.isActive) {
      this.spinner.text = message;
      logger.debug('Spinner text updated', { message });
    }
    return this;
  }

  /**
   * Update spinner color
   * @param {string} color - New color
   * @returns {SpinnerManager} This instance for chaining
   */
  updateColor(color) {
    if (this.spinner && this.isActive) {
      this.spinner.color = color;
      logger.debug('Spinner color updated', { color });
    }
    return this;
  }

  /**
   * Stop spinner with success message
   * @param {string} [message] - Success message
   * @returns {SpinnerManager} This instance for chaining
   */
  succeed(message) {
    if (this.spinner && this.isActive) {
      const duration = this._getDuration();
      this.spinner.succeed(message ? `${message} ${this._formatDuration(duration)}` : undefined);
      this._cleanup();
      
      logger.debug('Spinner succeeded', { 
        message, 
        duration: `${duration}ms` 
      });
    }
    return this;
  }

  /**
   * Stop spinner with failure message
   * @param {string} [message] - Failure message
   * @returns {SpinnerManager} This instance for chaining
   */
  fail(message) {
    if (this.spinner && this.isActive) {
      const duration = this._getDuration();
      this.spinner.fail(message ? `${message} ${this._formatDuration(duration)}` : undefined);
      this._cleanup();
      
      logger.debug('Spinner failed', { 
        message, 
        duration: `${duration}ms` 
      });
    }
    return this;
  }

  /**
   * Stop spinner with warning message
   * @param {string} [message] - Warning message
   * @returns {SpinnerManager} This instance for chaining
   */
  warn(message) {
    if (this.spinner && this.isActive) {
      const duration = this._getDuration();
      this.spinner.warn(message ? `${message} ${this._formatDuration(duration)}` : undefined);
      this._cleanup();
      
      logger.debug('Spinner warned', { 
        message, 
        duration: `${duration}ms` 
      });
    }
    return this;
  }

  /**
   * Stop spinner with info message
   * @param {string} [message] - Info message
   * @returns {SpinnerManager} This instance for chaining
   */
  info(message) {
    if (this.spinner && this.isActive) {
      const duration = this._getDuration();
      this.spinner.info(message ? `${message} ${this._formatDuration(duration)}` : undefined);
      this._cleanup();
      
      logger.debug('Spinner info', { 
        message, 
        duration: `${duration}ms` 
      });
    }
    return this;
  }

  /**
   * Stop spinner without any symbol
   * @param {string} [message] - Final message
   * @returns {SpinnerManager} This instance for chaining
   */
  stop(message) {
    if (this.spinner && this.isActive) {
      const duration = this._getDuration();
      this.spinner.stop();
      if (message) {
        console.log(message + ' ' + this._formatDuration(duration));
      }
      this._cleanup();
      
      logger.debug('Spinner stopped', { 
        message, 
        duration: `${duration}ms` 
      });
    }
    return this;
  }

  /**
   * Clear spinner
   * @returns {SpinnerManager} This instance for chaining
   */
  clear() {
    if (this.spinner && this.isActive) {
      this.spinner.clear();
      this._cleanup();
      logger.debug('Spinner cleared');
    }
    return this;
  }

  /**
   * Check if spinner is currently active
   * @returns {boolean} True if spinner is active
   */
  isSpinning() {
    return this.isActive && this.spinner?.isSpinning;
  }

  /**
   * Get elapsed time since spinner started
   * @returns {number} Duration in milliseconds
   * @private
   */
  _getDuration() {
    return this.startTime ? Math.round(performance.now() - this.startTime) : 0;
  }

  /**
   * Format duration for display
   * @param {number} duration - Duration in milliseconds
   * @returns {string} Formatted duration
   * @private
   */
  _formatDuration(duration) {
    if (duration < 1000) {
      return chalk.gray(`(${duration}ms)`);
    } else if (duration < 60000) {
      return chalk.gray(`(${(duration / 1000).toFixed(1)}s)`);
    } else {
      const minutes = Math.floor(duration / 60000);
      const seconds = ((duration % 60000) / 1000).toFixed(1);
      return chalk.gray(`(${minutes}m ${seconds}s)`);
    }
  }

  /**
   * Cleanup spinner state
   * @private
   */
  _cleanup() {
    this.isActive = false;
    this.startTime = null;
    this.spinner = null;
  }
}

/**
 * Multi-step progress manager
 */
export class ProgressManager {
  /**
   * Create a new ProgressManager instance
   * @param {Array<string>} steps - Array of step descriptions
   * @param {Object} options - Configuration options
   */
  constructor(steps = [], options = {}) {
    this.steps = steps;
    this.currentStep = 0;
    this.spinner = new SpinnerManager(options);
    this.startTime = performance.now();
    this.stepTimes = [];
  }

  /**
   * Start the progress with the first step
   * @returns {ProgressManager} This instance for chaining
   */
  start() {
    if (this.steps.length > 0) {
      const message = this._getStepMessage(0);
      this.spinner.start(message);
      this.stepTimes[0] = performance.now();
    }
    return this;
  }

  /**
   * Advance to the next step
   * @param {string} [customMessage] - Custom message for the step
   * @returns {ProgressManager} This instance for chaining
   */
  nextStep(customMessage) {
    if (this.currentStep < this.steps.length - 1) {
      this.currentStep++;
      const message = customMessage || this._getStepMessage(this.currentStep);
      this.spinner.updateText(message);
      this.stepTimes[this.currentStep] = performance.now();
      
      logger.debug('Progress advanced', { 
        step: this.currentStep + 1, 
        total: this.steps.length,
        message: this.steps[this.currentStep]
      });
    }
    return this;
  }

  /**
   * Complete the progress successfully
   * @param {string} [message] - Success message
   * @returns {ProgressManager} This instance for chaining
   */
  complete(message = 'All steps completed successfully') {
    const duration = performance.now() - this.startTime;
    this.spinner.succeed(`${message} ${this._formatDuration(duration)}`);
    
    logger.info('Progress completed', {
      totalSteps: this.steps.length,
      duration: `${Math.round(duration)}ms`
    });
    
    return this;
  }

  /**
   * Fail the progress with error message
   * @param {string} [message] - Error message
   * @returns {ProgressManager} This instance for chaining
   */
  fail(message = 'Operation failed') {
    const duration = performance.now() - this.startTime;
    this.spinner.fail(`${message} ${this._formatDuration(duration)}`);
    
    logger.error('Progress failed', {
      currentStep: this.currentStep + 1,
      totalSteps: this.steps.length,
      duration: `${Math.round(duration)}ms`
    });
    
    return this;
  }

  /**
   * Get current progress percentage
   * @returns {number} Progress percentage (0-100)
   */
  getProgress() {
    return this.steps.length > 0 ? Math.round(((this.currentStep + 1) / this.steps.length) * 100) : 0;
  }

  /**
   * Format step message with progress indicator
   * @param {number} stepIndex - Step index
   * @returns {string} Formatted message
   * @private
   */
  _getStepMessage(stepIndex) {
    const progress = `[${stepIndex + 1}/${this.steps.length}]`;
    return `${progress} ${this.steps[stepIndex]}`;
  }

  /**
   * Format duration for display
   * @param {number} duration - Duration in milliseconds
   * @returns {string} Formatted duration
   * @private
   */
  _formatDuration(duration) {
    if (duration < 1000) {
      return chalk.gray(`(${Math.round(duration)}ms)`);
    } else {
      return chalk.gray(`(${(duration / 1000).toFixed(1)}s)`);
    }
  }
}

/**
 * Utility functions for common spinner operations
 */
export class SpinnerUtils {
  /**
   * Execute an async operation with a spinner
   * @param {Function} operation - Async operation to execute
   * @param {string} loadingMessage - Message to show while loading
   * @param {string} [successMessage] - Message to show on success
   * @param {string} [errorMessage] - Message to show on error
   * @param {Object} [spinnerOptions] - Spinner configuration
   * @returns {Promise<*>} Result of the operation
   */
  static async withSpinner(operation, loadingMessage, successMessage, errorMessage, spinnerOptions = {}) {
    const spinner = new SpinnerManager(spinnerOptions);
    
    try {
      spinner.start(loadingMessage);
      const result = await operation();
      
      if (successMessage) {
        spinner.succeed(successMessage);
      } else {
        spinner.stop();
      }
      
      return result;
    } catch (error) {
      if (errorMessage) {
        spinner.fail(errorMessage);
      } else {
        spinner.fail(`${loadingMessage} failed`);
      }
      throw error;
    }
  }

  /**
   * Execute multiple operations with progress tracking
   * @param {Array<Object>} operations - Array of {fn, message} objects
   * @param {Object} [options] - Configuration options
   * @returns {Promise<Array>} Results of all operations
   */
  static async withProgress(operations, options = {}) {
    const steps = operations.map(op => op.message);
    const progress = new ProgressManager(steps, options);
    const results = [];
    
    try {
      progress.start();
      
      for (let i = 0; i < operations.length; i++) {
        if (i > 0) {
          progress.nextStep();
        }
        
        const result = await operations[i].fn();
        results.push(result);
      }
      
      progress.complete();
      return results;
    } catch (error) {
      progress.fail(`Failed at step ${progress.currentStep + 1}`);
      throw error;
    }
  }

  /**
   * Show a simple loading animation for a specified duration
   * @param {string} message - Loading message
   * @param {number} duration - Duration in milliseconds
   * @param {Object} [options] - Spinner options
   * @returns {Promise<void>}
   */
  static async showFor(message, duration, options = {}) {
    const spinner = new SpinnerManager(options);
    spinner.start(message);
    
    await new Promise(resolve => setTimeout(resolve, duration));
    spinner.stop();
  }
}

// Create default instances
const spinner = new SpinnerManager();

export { SPINNER_STYLES, spinner };
export default spinner; 