/**
 * @fileoverview Help system for taskonaut CLI
 * @author taskonaut
 * @version 1.0.0
 */

import chalk from 'chalk';
import { formatter } from './formatters.js';
import { displayBanner } from './banner.js';
import config from '../core/config.js';

/**
 * Help content manager for consistent CLI help display
 */
export class HelpManager {
  /**
   * Create a new HelpManager instance
   * @param {Object} options - Configuration options
   */
  constructor(options = {}) {
    this.options = {
      showBanner: true,
      ...options
    };
  }

  /**
   * Display the main application help
   * @param {Object} helpData - Structured help data
   * @returns {void}
   */
  displayMainHelp(helpData) {
    if (this.options.showBanner && !config.isQuiet()) {
      displayBanner();
    }

    console.log(formatter.formatHeader('🚀 Command Overview', { color: 'primary' }));
    console.log(formatter.formatStatus('Interactive ECS task executor and rollback tool', 'info', '✨'));
    
    // Usage section
    console.log('\n' + formatter.formatStatus('Usage:', 'info', '📖'));
    console.log(`  ${chalk.cyan('taskonaut')} ${chalk.gray('[options] [command]')}`);
    
    // Global options
    if (helpData.globalOptions && helpData.globalOptions.length > 0) {
      console.log('\n' + formatter.formatStatus('Global Options:', 'info', '⚙️'));
      this._displayOptions(helpData.globalOptions);
    }

    // Commands section
    if (helpData.commands && helpData.commands.length > 0) {
      console.log('\n' + formatter.formatStatus('Available Commands:', 'info', '🎯'));
      this._displayCommands(helpData.commands);
    }

    // Examples section
    console.log('\n' + formatter.formatStatus('Quick Start Examples:', 'info', '💡'));
    this._displayExamples([
      {
        command: 'taskonaut',
        description: 'Start interactive task executor (default action)',
        highlight: true
      },
      {
        command: 'taskonaut config set',
        description: 'Configure AWS profile and region'
      },
      {
        command: 'taskonaut doctor',
        description: 'Check environment setup and dependencies'
      },
      {
        command: 'taskonaut rollback',
        description: 'Rollback an ECS service to previous revision'
      }
    ]);

    // Configuration info
    console.log('\n' + formatter.formatStatus('Configuration:', 'info', '🔧'));
    console.log(formatter.formatKeyValue({
      'Config File': '~/.taskonaut (JSON format)',
      'Quick Setup': 'taskonaut config set',
      'View Settings': 'taskonaut config show',
      'Reset Config': 'taskonaut config cleanup'
    }));

    // Additional resources
    console.log('\n' + formatter.formatStatus('Need Help?', 'info', '🆘'));
    console.log(formatter.formatList([
      'Run "taskonaut doctor" to check your environment',
      'Use "taskonaut [command] --help" for command-specific help',
      'Visit https://github.com/SchematicHQ/taskonaut for documentation'
    ], { bullet: '•', color: 'secondary' }));

    console.log(''); // Empty line for spacing
  }

  /**
   * Display command-specific help
   * @param {Object} commandData - Command help data
   * @returns {void}
   */
  displayCommandHelp(commandData) {
    if (this.options.showBanner && !config.isQuiet()) {
      displayBanner();
    }

    // Command header
    const title = `${commandData.emoji || '🚀'} ${commandData.name.toUpperCase()} Command`;
    console.log(formatter.formatHeader(title, { color: 'primary' }));
    
    if (commandData.description) {
      console.log(formatter.formatStatus(commandData.description, 'info', commandData.emoji || 'ℹ️'));
    }

    // Usage section
    console.log('\n' + formatter.formatStatus('Usage:', 'info', '📖'));
    const usage = commandData.usage || `taskonaut ${commandData.name} [options]`;
    console.log(`  ${chalk.cyan(usage)}`);

    // Command options
    if (commandData.options && commandData.options.length > 0) {
      console.log('\n' + formatter.formatStatus('Options:', 'info', '⚙️'));
      this._displayOptions(commandData.options);
    }

    // Subcommands
    if (commandData.subcommands && commandData.subcommands.length > 0) {
      console.log('\n' + formatter.formatStatus('Subcommands:', 'info', '🎯'));
      this._displaySubcommands(commandData.subcommands);
    }

    // Examples
    if (commandData.examples && commandData.examples.length > 0) {
      console.log('\n' + formatter.formatStatus('Examples:', 'info', '💡'));
      this._displayExamples(commandData.examples);
    }

    // Additional info
    if (commandData.notes && commandData.notes.length > 0) {
      console.log('\n' + formatter.formatStatus('Important Notes:', 'info', '📝'));
      console.log(formatter.formatList(commandData.notes, { bullet: '•', color: 'warning' }));
    }

    console.log(''); // Empty line for spacing
  }

  /**
   * Display options in a formatted list
   * @param {Array} options - Array of option objects
   * @private
   */
  _displayOptions(options) {
    const optionData = options.map(opt => ({
      'Option': this._formatOption(opt),
      'Description': opt.description || 'No description'
    }));

    console.log(formatter.formatList(optionData, {
      columns: [
        { key: 'Option', label: 'Option' },
        { key: 'Description', label: 'Description', maxLength: 60 }
      ]
    }));
  }

  /**
   * Display commands in a formatted list
   * @param {Array} commands - Array of command objects
   * @private
   */
  _displayCommands(commands) {
    const commandData = commands.map(cmd => ({
      'Command': `${cmd.emoji || '🚀'} ${chalk.cyan(cmd.name)}${cmd.aliases ? chalk.gray(` (${cmd.aliases.join(', ')})`) : ''}`,
      'Description': cmd.description || 'No description'
    }));

    console.log(formatter.formatList(commandData, {
      columns: [
        { key: 'Command', label: 'Command' },
        { key: 'Description', label: 'Description', maxLength: 50 }
      ]
    }));
  }

  /**
   * Display subcommands in a formatted list
   * @param {Array} subcommands - Array of subcommand objects
   * @private
   */
  _displaySubcommands(subcommands) {
    const subcommandData = subcommands.map(sub => ({
      'Subcommand': `${chalk.cyan(sub.name)}${sub.aliases ? chalk.gray(` (${sub.aliases.join(', ')})`) : ''}`,
      'Description': sub.description || 'No description'
    }));

    console.log(formatter.formatList(subcommandData, {
      columns: [
        { key: 'Subcommand', label: 'Subcommand' },
        { key: 'Description', label: 'Description', maxLength: 50 }
      ]
    }));
  }

  /**
   * Display examples with syntax highlighting
   * @param {Array} examples - Array of example objects
   * @private
   */
  _displayExamples(examples) {
    examples.forEach((example, index) => {
      const prefix = example.highlight ? '⭐' : '▶️';
      const command = chalk.cyan(example.command);
      const description = chalk.gray(`# ${example.description}`);
      
      console.log(`  ${prefix} ${command}`);
      if (example.description) {
        console.log(`     ${description}`);
      }
      
      if (index < examples.length - 1) {
        console.log(''); // Space between examples
      }
    });
  }

  /**
   * Format an option with flags and description
   * @param {Object} option - Option object
   * @returns {string} Formatted option string
   * @private
   */
  _formatOption(option) {
    let formatted = '';
    
    if (option.short && option.long) {
      formatted = `${chalk.cyan(option.short)}, ${chalk.cyan(option.long)}`;
    } else if (option.long) {
      formatted = chalk.cyan(option.long);
    } else if (option.short) {
      formatted = chalk.cyan(option.short);
    }

    if (option.argument) {
      formatted += ` ${chalk.gray(`<${option.argument}>`)}`;
    }

    return formatted;
  }

  /**
   * Display error help when invalid command is used
   * @param {string} invalidCommand - The invalid command that was attempted
   * @returns {void}
   */
  displayErrorHelp(invalidCommand) {
    console.log(formatter.formatStatus(`❌ Unknown command: '${invalidCommand}'`, 'error'));
    console.log('\n' + formatter.formatStatus('💡 Did you mean one of these?', 'info'));
    
    const suggestions = [
      { name: 'execute', description: 'Interactive task executor (default)' },
      { name: 'rollback', description: 'Rollback ECS service' },
      { name: 'config', description: 'Manage configuration' },
      { name: 'doctor', description: 'Run diagnostics' }
    ];

    console.log(formatter.formatList(
      suggestions.map(s => `${chalk.cyan(s.name)} - ${s.description}`),
      { bullet: '•', color: 'primary' }
    ));

    console.log('\n' + formatter.formatStatus('Use "taskonaut --help" to see all available commands', 'info', 'ℹ️'));
  }

  /**
   * Create structured help data for the main application
   * @returns {Object} Main help data structure
   */
  static getMainHelpData() {
    return {
      globalOptions: [
        {
          short: '-h',
          long: '--help',
          description: 'Display help information'
        },
        {
          short: '-v',
          long: '--version',
          description: 'Display version number'
        },
        {
          short: '-q',
          long: '--quiet',
          description: 'Suppress output messages'
        },
        {
          long: '--verbose',
          description: 'Enable detailed logging'
        },
        {
          long: '--no-color',
          description: 'Disable colored output'
        }
      ],
      commands: [
        {
          name: 'execute',
          aliases: ['exec'],
          emoji: '🚀',
          description: 'Interactive ECS task executor and shell access (default)'
        },
        {
          name: 'rollback',
          emoji: '🔄',
          description: 'Rollback ECS service to previous task definition revision'
        },
        {
          name: 'config',
          emoji: '⚙️',
          description: 'Manage AWS profile, region, and other settings'
        },
        {
          name: 'doctor',
          aliases: ['diag'],
          emoji: '🏥',
          description: 'Run environment diagnostics and health checks'
        }
      ]
    };
  }
}

// Create default instance
const help = new HelpManager();

export { help };
export default help; 