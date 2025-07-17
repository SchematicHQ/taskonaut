import { describe, expect, test, beforeEach, afterEach, jest } from "@jest/globals";
import { Logger, LOG_LEVELS } from "../../src/core/logger.js";

describe("Logger", () => {
  let logger;
  let mockConsoleLog;
  let mockConsoleError;

  beforeEach(() => {
    mockConsoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    
    logger = new Logger({
      level: 'trace',
      timestamp: true,
      metadata: true,
      colorize: false,
      silent: false
    });
  });

  afterEach(() => {
    mockConsoleLog.mockRestore();
    mockConsoleError.mockRestore();
  });

  test("should create logger with default config", () => {
    const defaultLogger = new Logger();
    expect(defaultLogger.config.level).toBe('warn');
    expect(defaultLogger.config.timestamp).toBe(false);
    expect(defaultLogger.config.metadata).toBe(false);
    expect(defaultLogger.currentLevel).toBe(3); // warn level
  });

  test("should create logger with custom config", () => {
    const customLogger = new Logger({
      level: 'debug',
      timestamp: false,
      colorize: true
    });
    
    expect(customLogger.config.level).toBe('debug');
    expect(customLogger.config.timestamp).toBe(false);
    expect(customLogger.config.colorize).toBe(true);
    expect(customLogger.currentLevel).toBe(1); // debug level
  });

  test("should format message with timestamp and metadata", () => {
    const message = logger._formatMessage('info', 'Test message', { key: 'value' });
    
    expect(message).toContain('INFO');
    expect(message).toContain('Test message');
    expect(message).toContain('ℹ️');
    expect(message).toContain('[');
    expect(message).toContain(']');
    expect(message).toContain('key');
    expect(message).toContain('value');
  });

  test("should format message without timestamp when disabled", () => {
    const noTimestampLogger = new Logger({
      timestamp: false,
      colorize: false
    });
    
    const message = noTimestampLogger._formatMessage('info', 'Test message');
    
    expect(message).toContain('INFO');
    expect(message).toContain('Test message');
    expect(message).not.toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("should format message without metadata when disabled", () => {
    const noMetadataLogger = new Logger({
      metadata: false,
      colorize: false
    });
    
    const message = noMetadataLogger._formatMessage('info', 'Test message', { key: 'value' });
    
    expect(message).toContain('INFO');
    expect(message).toContain('Test message');
    expect(message).not.toContain('key');
    expect(message).not.toContain('value');
  });

  test("should log trace messages", () => {
    logger.trace('Trace message', { trace: true });
    
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining('TRACE')
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining('Trace message')
    );
  });

  test("should log debug messages", () => {
    logger.debug('Debug message', { debug: true });
    
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining('DEBUG')
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining('Debug message')
    );
  });

  test("should log info messages", () => {
    logger.info('Info message', { info: true });
    
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining('INFO')
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining('Info message')
    );
  });

  test("should log success messages", () => {
    logger.success('Success message', { success: true });
    
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining('SUCCESS')
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining('Success message')
    );
  });

  test("should log warn messages", () => {
    logger.warn('Warning message', { warn: true });
    
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining('WARN')
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining('Warning message')
    );
  });

  test("should log error messages to console.error", () => {
    logger.error('Error message', { error: true });
    
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('ERROR')
    );
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('Error message')
    );
  });

  test("should log fatal messages to console.error", () => {
    logger.fatal('Fatal message', { fatal: true });
    
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('FATAL')
    );
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('Fatal message')
    );
  });

  test("should log Error objects with stack trace", () => {
    const error = new Error('Test error');
    error.code = 'TEST_CODE';
    
    logger.error(error, { context: 'test' });
    
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('Test error')
    );
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('stack')
    );
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('TEST_CODE')
    );
  });

  test("should log fatal Error objects with stack trace", () => {
    const error = new Error('Fatal error');
    
    logger.fatal(error, { context: 'test' });
    
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('Fatal error')
    );
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('stack')
    );
  });

  test("should respect log level filtering", () => {
    const warnLogger = new Logger({ level: 'warn', silent: false });
    
    warnLogger.debug('Debug message');
    warnLogger.info('Info message');
    warnLogger.warn('Warning message');
    warnLogger.error('Error message');
    
    expect(mockConsoleLog).not.toHaveBeenCalledWith(
      expect.stringContaining('DEBUG')
    );
    expect(mockConsoleLog).not.toHaveBeenCalledWith(
      expect.stringContaining('INFO')
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining('WARN')
    );
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('ERROR')
    );
  });

  test("should not log when silent mode is enabled", () => {
    const silentLogger = new Logger({ silent: true });
    
    silentLogger.info('Info message');
    silentLogger.error('Error message');
    
    expect(mockConsoleLog).not.toHaveBeenCalled();
    expect(mockConsoleError).not.toHaveBeenCalled();
  });

  test("should set log level", () => {
    logger.setLevel('error');
    
    expect(logger.config.level).toBe('error');
    expect(logger.currentLevel).toBe(4);
    
    logger.info('Info message');
    logger.error('Error message');
    
    expect(mockConsoleLog).not.toHaveBeenCalledWith(
      expect.stringContaining('INFO')
    );
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('ERROR')
    );
  });

  test("should check if log level is enabled", () => {
    const infoLogger = new Logger({ level: 'info' });
    
    expect(infoLogger.isLevelEnabled('trace')).toBe(false);
    expect(infoLogger.isLevelEnabled('debug')).toBe(false);
    expect(infoLogger.isLevelEnabled('info')).toBe(true);
    expect(infoLogger.isLevelEnabled('warn')).toBe(true);
    expect(infoLogger.isLevelEnabled('error')).toBe(true);
    expect(infoLogger.isLevelEnabled('fatal')).toBe(true);
  });

  test("should handle invalid log level gracefully", () => {
    logger.setLevel('invalid-level');
    
    // Should keep current level if invalid
    expect(logger.currentLevel).toBe(0); // trace level from beforeEach
  });

  test("should format messages with emojis for each level", () => {
    const levels = ['trace', 'debug', 'info', 'success', 'warn', 'error', 'fatal'];
    const expectedEmojis = ['🔍', '🐛', 'ℹ️', '✅', '⚠️', '❌', '💥'];
    
    levels.forEach((level, index) => {
      const message = logger._formatMessage(level, 'Test message');
      expect(message).toContain(expectedEmojis[index]);
    });
  });
});

describe("LOG_LEVELS", () => {
  test("should have all required log levels", () => {
    expect(LOG_LEVELS.trace).toBeDefined();
    expect(LOG_LEVELS.debug).toBeDefined();
    expect(LOG_LEVELS.info).toBeDefined();
    expect(LOG_LEVELS.success).toBeDefined();
    expect(LOG_LEVELS.warn).toBeDefined();
    expect(LOG_LEVELS.error).toBeDefined();
    expect(LOG_LEVELS.fatal).toBeDefined();
  });

  test("should have correct level hierarchy", () => {
    expect(LOG_LEVELS.trace.level).toBe(0);
    expect(LOG_LEVELS.debug.level).toBe(1);
    expect(LOG_LEVELS.info.level).toBe(2);
    expect(LOG_LEVELS.success.level).toBe(2);
    expect(LOG_LEVELS.warn.level).toBe(3);
    expect(LOG_LEVELS.error.level).toBe(4);
    expect(LOG_LEVELS.fatal.level).toBe(5);
  });

  test("should have emojis for all levels", () => {
    const expectedEmojis = ['🔍', '🐛', 'ℹ️', '✅', '⚠️', '❌', '💥'];
    const levels = ['trace', 'debug', 'info', 'success', 'warn', 'error', 'fatal'];
    
    levels.forEach((level, index) => {
      expect(LOG_LEVELS[level].emoji).toBeDefined();
      expect(LOG_LEVELS[level].emoji).toBe(expectedEmojis[index]);
    });
  });

  test("should have colors for all levels", () => {
    Object.values(LOG_LEVELS).forEach(levelConfig => {
      expect(levelConfig.color).toBeDefined();
      expect(typeof levelConfig.color).toBe('string');
    });
  });
}); 