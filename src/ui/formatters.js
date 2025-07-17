/**
 * @fileoverview Output formatters and display utilities for taskonaut
 * @author taskonaut
 * @version 1.0.0
 */

import chalk from 'chalk';
import { inspect } from 'util';
import config from '../core/config.js';

/**
 * Color schemes for different data types
 */
const COLOR_SCHEMES = {
  primary: chalk.cyan,
  secondary: chalk.blue,
  success: chalk.green,
  warning: chalk.yellow,
  error: chalk.red,
  muted: chalk.gray,
  highlight: chalk.bold,
  accent: chalk.magenta
};

/**
 * Output formatters class
 */
export class OutputFormatter {
  /**
   * Create a new OutputFormatter instance
   * @param {Object} options - Configuration options
   */
  constructor(options = {}) {
    this.config = {
      colorize: config.get('logging.colorize') !== false,
      format: config.get('cli.outputFormat') || 'list',
      maxWidth: process.stdout.columns || 120,
      truncateLength: 50,
      ...options
    };
  }

  /**
   * Format data based on configured output format
   * @param {*} data - Data to format
   * @param {Object} options - Formatting options
   * @returns {string} Formatted output
   */
  format(data, options = {}) {
    const format = options.format || this.config.format;
    
    switch (format) {
      case 'json':
        return this.formatJSON(data, options);
      case 'yaml':
        return this.formatYAML(data, options);
      case 'list':
      default:
        return Array.isArray(data) ? this.formatList(data, options) : this.formatObject(data, options);
    }
  }

  /**
   * Format data as a list (replaces table formatting)
   * @param {Array} data - Array of objects to display
   * @param {Object} options - List options
   * @param {Array} [options.columns] - Column definitions
   * @param {string} [options.title] - List title
   * @param {string} [options.bullet='•'] - Bullet character
   * @param {boolean} [options.showIndex=false] - Show row indices
   * @returns {string} Formatted list
   */
  formatList(data, options = {}) {
    if (!Array.isArray(data) || data.length === 0) {
      return this._colorize('No data to display', 'muted');
    }

    const { columns, title, bullet = '•', showIndex = false } = options;
    let output = '';
    
    // Add title if provided
    if (title) {
      output += this._colorize(`\n${title}\n`, 'highlight') + '\n';
    }

    // Format each item
    data.forEach((item, index) => {
      if (showIndex) {
        output += this._colorize(`${index + 1}. `, 'muted');
      } else {
        output += this._colorize(`${bullet} `, 'primary');
      }

      if (typeof item === 'object' && item !== null) {
        // If columns are specified, use them; otherwise use all keys
        const displayColumns = columns || Object.keys(item);
        const parts = [];

        displayColumns.forEach(col => {
          const key = typeof col === 'string' ? col : col.key;
          const label = typeof col === 'string' ? col : (col.label || col.key);
          const value = this._formatValue(item[key]);
          
          if (value !== undefined && value !== null && value !== '') {
            parts.push(`${this._colorize(label, 'secondary')}: ${value}`);
          }
        });

        output += parts.join(' | ');
      } else {
        output += this._formatValue(item);
      }
      
      output += '\n';
    });

    return output;
  }

  /**
   * Format a single object
   * @param {Object} data - Object to format
   * @param {Object} options - Formatting options
   * @param {string} [options.title] - Object title
   * @param {Array} [options.fields] - Fields to display
   * @returns {string} Formatted object
   */
  formatObject(data, options = {}) {
    if (!data || typeof data !== 'object') {
      return this._colorize(String(data), 'muted');
    }

    const { title, fields } = options;
    const displayFields = fields || Object.keys(data);
    
    let output = '';
    
    // Add title if provided
    if (title) {
      output += this._colorize(`\n${title}\n`, 'highlight') + '\n';
    }

    // Find the longest key for alignment
    const maxKeyLength = Math.max(...displayFields.map(key => key.length));
    
    // Format each field
    displayFields.forEach(key => {
      const label = key.padEnd(maxKeyLength);
      const value = this._formatValue(data[key]);
      output += `${this._colorize(label, 'secondary')}: ${value}\n`;
    });

    return output;
  }

  /**
   * Format data as JSON
   * @param {*} data - Data to format
   * @param {Object} options - JSON options
   * @param {number} [options.indent=2] - Indentation spaces
   * @param {boolean} [options.colorize=true] - Whether to colorize output
   * @returns {string} Formatted JSON
   */
  formatJSON(data, options = {}) {
    const { indent = 2, colorize = this.config.colorize } = options;
    
    try {
      const json = JSON.stringify(data, null, indent);
      return colorize ? this._colorizeJSON(json) : json;
    } catch (error) {
      return this._colorize('Error: Unable to serialize to JSON', 'error');
    }
  }

  /**
   * Format data as YAML (simplified)
   * @param {*} data - Data to format
   * @param {Object} options - YAML options
   * @returns {string} Formatted YAML
   */
  formatYAML(data, options = {}) {
    return this._objectToYAML(data, 0);
  }

  /**
   * Format a list with bullets
   * @param {Array} items - Items to list
   * @param {Object} options - List options
   * @param {string} [options.bullet='•'] - Bullet character
   * @param {number} [options.indent=0] - Indentation level
   * @param {string} [options.color] - Color scheme to use
   * @param {string} [options.title] - List title
   * @returns {string} Formatted list
   */
  formatBulletList(items, options = {}) {
    if (!Array.isArray(items) || items.length === 0) {
      return this._colorize('No items to display', 'muted');
    }

    const { bullet = '•', indent = 0, color, title } = options;
    const indentStr = ' '.repeat(indent);
    let output = '';

    // Add title if provided
    if (title) {
      output += this._colorize(`\n${title}\n`, 'highlight') + '\n';
    }
    
    items.forEach(item => {
      const bulletStr = this._colorize(`${bullet} `, color || 'primary');
      const itemStr = this._formatValue(item);
      output += `${indentStr}${bulletStr}${itemStr}\n`;
    });

    return output;
  }

  /**
   * Format key-value pairs
   * @param {Object} data - Key-value data
   * @param {Object} options - Formatting options
   * @param {string} [options.separator=':'] - Key-value separator
   * @param {number} [options.indent=0] - Indentation level
   * @param {boolean} [options.alignValues=true] - Align values
   * @param {string} [options.title] - Section title
   * @returns {string} Formatted key-value pairs
   */
  formatKeyValue(data, options = {}) {
    if (!data || typeof data !== 'object') {
      return this._colorize('No data to display', 'muted');
    }

    const { separator = ':', indent = 0, alignValues = true, title } = options;
    const indentStr = ' '.repeat(indent);
    const entries = Object.entries(data);
    let output = '';

    // Add title if provided
    if (title) {
      output += this._colorize(`\n${title}\n`, 'highlight') + '\n';
    }

    if (entries.length === 0) {
      return this._colorize('No data to display', 'muted');
    }

    // Calculate max key length for alignment
    const maxKeyLength = alignValues ? Math.max(...entries.map(([key]) => key.length)) : 0;

    entries.forEach(([key, value]) => {
      const keyStr = alignValues ? key.padEnd(maxKeyLength) : key;
      const coloredKey = this._colorize(keyStr, 'secondary');
      const formattedValue = this._formatValue(value);
      output += `${indentStr}${coloredKey}${separator} ${formattedValue}\n`;
    });

    return output;
  }

  /**
   * Format a status message with icon and color
   * @param {string} message - Status message
   * @param {string} type - Status type (success, error, warning, info)
   * @param {string} [icon] - Custom icon
   * @returns {string} Formatted status message
   */
  formatStatus(message, type = 'info', icon = null) {
    const icons = {
      success: '✅',
      error: '❌',
      warning: '⚠️',
      info: 'ℹ️'
    };

    const colors = {
      success: 'success',
      error: 'error',
      warning: 'warning',
      info: 'primary'
    };

    const statusIcon = icon || icons[type] || icons.info;
    const color = colors[type] || colors.info;
    
    return `${statusIcon} ${this._colorize(message, color)}`;
  }

  /**
   * Format a header with optional styling
   * @param {string} text - Header text
   * @param {Object} options - Header options
   * @param {string} [options.level=1] - Header level (1-3)
   * @param {string} [options.color='highlight'] - Text color
   * @param {string} [options.underline] - Underline character
   * @returns {string} Formatted header
   */
  formatHeader(text, options = {}) {
    const { level = 1, color = 'highlight', underline } = options;
    const coloredText = this._colorize(text, color);
    
    if (underline) {
      const line = underline.repeat(text.length);
      return `${coloredText}\n${this._colorize(line, color)}`;
    }
    
    switch (level) {
      case 1:
        return `\n${coloredText}\n${'='.repeat(text.length)}`;
      case 2:
        return `\n${coloredText}\n${'-'.repeat(text.length)}`;
      case 3:
        return `\n${coloredText}`;
      default:
        return coloredText;
    }
  }

  /**
   * Apply color to text if colorization is enabled
   * @param {string} text - Text to colorize
   * @param {string} colorName - Color name from COLOR_SCHEMES
   * @returns {string} Colored or plain text
   * @private
   */
  _colorize(text, colorName) {
    if (!this.config.colorize || !COLOR_SCHEMES[colorName]) {
      return text;
    }
    return COLOR_SCHEMES[colorName](text);
  }

  /**
   * Format any value for display
   * @param {*} value - Value to format
   * @param {string} [type] - Value type hint
   * @returns {string} Formatted value
   * @private
   */
  _formatValue(value, type) {
    if (value === null || value === undefined) {
      return this._colorize('—', 'muted');
    }

    switch (type || typeof value) {
      case 'boolean':
        return this._colorize(value ? '✓' : '✗', value ? 'success' : 'error');
      case 'number':
        return this._colorize(value.toString(), 'accent');
      case 'string':
        return value;
      case 'object':
        if (Array.isArray(value)) {
          return value.length > 0 ? value.join(', ') : this._colorize('(empty)', 'muted');
        }
        return this._colorize('[Object]', 'muted');
      default:
        return String(value);
    }
  }

  /**
   * Colorize JSON output
   * @param {string} json - JSON string
   * @returns {string} Colorized JSON
   * @private
   */
  _colorizeJSON(json) {
    return json
      .replace(/(".*?")\s*:/g, (match, key) => `${chalk.blue(key)}:`)
      .replace(/:\s*(".*?")/g, (match, value) => `: ${chalk.green(value)}`)
      .replace(/:\s*(true|false)/g, (match, bool) => `: ${chalk.yellow(bool)}`)
      .replace(/:\s*(null)/g, (match, nul) => `: ${chalk.gray(nul)}`)
      .replace(/:\s*(\d+)/g, (match, num) => `: ${chalk.cyan(num)}`);
  }

  /**
   * Convert object to YAML-like format
   * @param {*} obj - Object to convert
   * @param {number} depth - Current depth
   * @returns {string} YAML-like string
   * @private
   */
  _objectToYAML(obj, depth = 0) {
    const indent = '  '.repeat(depth);
    
    if (obj === null || obj === undefined) {
      return 'null';
    }
    
    if (typeof obj !== 'object') {
      return String(obj);
    }
    
    if (Array.isArray(obj)) {
      if (obj.length === 0) return '[]';
      return obj.map(item => `${indent}- ${this._objectToYAML(item, depth + 1)}`).join('\n');
    }
    
    const entries = Object.entries(obj);
    if (entries.length === 0) return '{}';
    
    return entries.map(([key, value]) => {
      const coloredKey = this._colorize(key, 'secondary');
      if (typeof value === 'object' && value !== null) {
        return `${indent}${coloredKey}:\n${this._objectToYAML(value, depth + 1)}`;
      }
      return `${indent}${coloredKey}: ${this._objectToYAML(value, depth)}`;
    }).join('\n');
  }
}

// Create a default formatter instance
export const formatter = new OutputFormatter();

export { COLOR_SCHEMES }; 