/**
 * @fileoverview Banner and title display utilities for taskonaut
 * @author taskonaut
 * @version 1.0.0
 */

import figlet from 'figlet';
import { pastel } from 'gradient-string';
import chalk from 'chalk';
import config from '../core/config.js';
import logger from '../core/logger.js';

/**
 * Banner configuration options
 */
const BANNER_CONFIG = {
  appName: 'taskonaut',
  tagline: '✨ Interactive ECS task executor and rollback tool',
  font: 'ANSI Shadow',
  layout: 'full',
  gradient: true,
  colors: {
    tagline: 'dim',
    error: 'red'
  }
};

/**
 * Available figlet fonts for different banner styles
 */
const BANNER_FONTS = {
  default: 'ANSI Shadow',
  compact: 'Small',
  bold: 'Big',
  simple: 'Standard',
  slim: 'Slant'
};

/**
 * Banner display manager
 */
export class BannerManager {
  /**
   * Create a new BannerManager instance
   * @param {Object} options - Banner configuration options
   */
  constructor(options = {}) {
    this.config = { ...BANNER_CONFIG, ...options };
  }

  /**
   * Display the main application banner
   * @param {Object} options - Display options
   * @param {boolean} [options.force=false] - Force display even in quiet mode
   * @param {string} [options.style='default'] - Banner style
   * @param {boolean} [options.includeTagline=true] - Include tagline
   * @returns {void}
   */
  displayBanner(options = {}) {
    const {
      force = false,
      style = 'default',
      includeTagline = true
    } = options;

    // Skip banner in quiet mode unless forced
    if (config.isQuiet() && !force) {
      logger.debug('Banner display skipped (quiet mode)');
      return;
    }

    try {
      // Get font for the specified style
      const font = BANNER_FONTS[style] || BANNER_FONTS.default;
      
      // Generate ASCII art
      const asciiArt = figlet.textSync(this.config.appName, {
        font,
        horizontalLayout: this.config.layout,
        verticalLayout: 'default',
        width: 80,
        whitespaceBreak: true
      });

      // Apply gradient if enabled
      const styledBanner = this.config.gradient 
        ? pastel.multiline(asciiArt)
        : asciiArt;

      // Display banner
      console.log(styledBanner);

      // Display tagline if requested
      if (includeTagline && this.config.tagline) {
        const taglineColor = this.config.colors.tagline;
        const styledTagline = chalk[taglineColor](this.config.tagline + '\n');
        console.log(styledTagline);
      }

      logger.debug('Application banner displayed', { 
        style, 
        font, 
        includeTagline 
      });

    } catch (error) {
      logger.warn('Failed to display banner', { 
        error: error.message,
        fallback: 'using simple text banner'
      });
      
      // Fallback to simple text banner
      this._displayFallbackBanner(includeTagline);
    }
  }

  /**
   * Display a compact version of the banner
   * @param {Object} options - Display options
   * @returns {void}
   */
  displayCompactBanner(options = {}) {
    this.displayBanner({
      ...options,
      style: 'compact'
    });
  }

  /**
   * Display a simple text-only header
   * @param {Object} options - Display options
   * @param {boolean} [options.includeTagline=true] - Include tagline
   * @returns {void}
   */
  displaySimpleHeader(options = {}) {
    const { includeTagline = true } = options;

    if (config.isQuiet()) {
      return;
    }

    const header = chalk.bold.cyan(`${this.config.appName.toUpperCase()}`);
    console.log(header);

    if (includeTagline && this.config.tagline) {
      const taglineColor = this.config.colors.tagline;
      console.log(chalk[taglineColor](this.config.tagline + '\n'));
    }

    logger.debug('Simple header displayed');
  }

  /**
   * Display a custom banner with specified text
   * @param {string} text - Text to display as banner
   * @param {Object} options - Display options
   * @param {string} [options.font='Standard'] - Font to use
   * @param {boolean} [options.gradient=false] - Apply gradient
   * @param {string} [options.subtitle] - Optional subtitle
   * @returns {void}
   */
  displayCustomBanner(text, options = {}) {
    const {
      font = 'Standard',
      gradient = false,
      subtitle
    } = options;

    if (config.isQuiet()) {
      return;
    }

    try {
      const asciiArt = figlet.textSync(text, {
        font,
        horizontalLayout: 'default',
        verticalLayout: 'default'
      });

      const styledBanner = gradient 
        ? pastel.multiline(asciiArt)
        : asciiArt;

      console.log(styledBanner);

      if (subtitle) {
        console.log(chalk.dim(subtitle + '\n'));
      }

      logger.debug('Custom banner displayed', { text, font, gradient });

    } catch (error) {
      logger.warn('Failed to display custom banner', { error: error.message });
      console.log(chalk.bold(text.toUpperCase()));
      if (subtitle) {
        console.log(chalk.dim(subtitle + '\n'));
      }
    }
  }

  /**
   * Display version information
   * @param {string} version - Application version
   * @param {Object} options - Display options
   * @returns {void}
   */
  displayVersion(version, options = {}) {
    const { detailed = false } = options;

    if (detailed) {
      console.log(chalk.bold.cyan(`${this.config.appName} v${version}`));
      console.log(chalk.gray(`Node.js ${process.version}`));
      console.log(chalk.gray(`Platform: ${process.platform} ${process.arch}\n`));
    } else {
      console.log(`${this.config.appName} v${version}`);
    }
  }

  /**
   * Display a section separator
   * @param {string} [title] - Optional section title
   * @param {Object} options - Display options
   * @param {string} [options.style='line'] - Separator style
   * @param {number} [options.width=60] - Separator width
   * @returns {void}
   */
  displaySeparator(title, options = {}) {
    const { style = 'line', width = 60 } = options;

    if (config.isQuiet()) {
      return;
    }

    const chars = {
      line: '─',
      double: '═',
      dash: '-',
      dot: '·'
    };

    const char = chars[style] || chars.line;
    
    if (title) {
      const titleLength = title.length;
      const sideLength = Math.max(0, Math.floor((width - titleLength - 2) / 2));
      const leftSide = char.repeat(sideLength);
      const rightSide = char.repeat(width - titleLength - 2 - sideLength);
      
      console.log(chalk.gray(`${leftSide} ${title} ${rightSide}`));
    } else {
      console.log(chalk.gray(char.repeat(width)));
    }
  }

  /**
   * Display fallback banner when ASCII art fails
   * @param {boolean} includeTagline - Whether to include tagline
   * @private
   */
  _displayFallbackBanner(includeTagline = true) {
    try {
      const name = this.config.appName.toUpperCase();
      const styledName = chalk.bold.cyan(name);
      console.log(styledName);

      if (includeTagline && this.config.tagline) {
        const taglineColor = this.config.colors.tagline;
        console.log(chalk[taglineColor](this.config.tagline + '\n'));
      }

      logger.debug('Fallback banner displayed');
    } catch (error) {
      logger.error('Failed to display fallback banner', { error: error.message });
    }
  }
}

/**
 * Default banner manager instance
 */
const banner = new BannerManager();

/**
 * Convenient function to display the main application banner
 * @param {Object} options - Display options
 * @returns {void}
 */
export function displayBanner(options = {}) {
  banner.displayBanner(options);
}

/**
 * Convenient function to display a compact banner
 * @param {Object} options - Display options
 * @returns {void}
 */
export function displayCompactBanner(options = {}) {
  banner.displayCompactBanner(options);
}

/**
 * Convenient function to display a simple header
 * @param {Object} options - Display options
 * @returns {void}
 */
export function displaySimpleHeader(options = {}) {
  banner.displaySimpleHeader(options);
}

/**
 * Convenient function to display version information
 * @param {string} version - Application version
 * @param {Object} options - Display options
 * @returns {void}
 */
export function displayVersion(version, options = {}) {
  banner.displayVersion(version, options);
}

export { BANNER_FONTS, banner };
export default banner; 