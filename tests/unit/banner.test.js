import { describe, expect, test, beforeEach, afterEach, jest } from "@jest/globals";

// Mock dependencies before importing the banner module
jest.unstable_mockModule("../../src/core/config.js", () => ({
  default: {
    isQuiet: jest.fn().mockReturnValue(false)
  }
}));

jest.unstable_mockModule("../../src/core/logger.js", () => ({
  default: {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }
}));

const { 
  BannerManager, 
  displayBanner, 
  displayCompactBanner,
  displaySimpleHeader,
  displayVersion,
  BANNER_FONTS 
} = await import("../../src/ui/banner.js");

describe("BannerManager", () => {
  let bannerManager;
  let mockConsoleLog;

  beforeEach(() => {
    mockConsoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
    bannerManager = new BannerManager();
  });

  afterEach(() => {
    mockConsoleLog.mockRestore();
    jest.clearAllMocks();
  });

  test("should create banner manager with default config", () => {
    expect(bannerManager.config.appName).toBe('taskonaut');
    expect(bannerManager.config.tagline).toBe('✨ Interactive ECS task executor and rollback tool');
    expect(bannerManager.config.font).toBe('ANSI Shadow');
    expect(bannerManager.config.gradient).toBe(true);
  });

  test("should create banner manager with custom config", () => {
    const customManager = new BannerManager({
      appName: 'custom-app',
      tagline: 'Custom tagline',
      gradient: false
    });

    expect(customManager.config.appName).toBe('custom-app');
    expect(customManager.config.tagline).toBe('Custom tagline');
    expect(customManager.config.gradient).toBe(false);
    expect(customManager.config.font).toBe('ANSI Shadow'); // Should keep default
  });

  test("should display banner with ASCII art", () => {
    bannerManager.displayBanner();
    
    expect(mockConsoleLog).toHaveBeenCalled();
    // Check that something was logged (ASCII art and tagline)
    expect(mockConsoleLog.mock.calls.length).toBeGreaterThan(0);
  });

  test("should not display banner in quiet mode", async () => {
    // Create a new banner manager with quiet mode enabled for this test
    const { default: mockConfig } = await import("../../src/core/config.js");
    mockConfig.isQuiet.mockReturnValueOnce(true);

    bannerManager.displayBanner();
    
    // Should not log anything in quiet mode
    expect(mockConsoleLog).not.toHaveBeenCalled();
  });

  test("should force display banner even in quiet mode", async () => {
    // Create a new banner manager with quiet mode enabled for this test
    const { default: mockConfig } = await import("../../src/core/config.js");
    mockConfig.isQuiet.mockReturnValueOnce(true);

    bannerManager.displayBanner({ force: true });
    
    expect(mockConsoleLog).toHaveBeenCalled();
  });

  test("should display banner without tagline", () => {
    bannerManager.displayBanner({ includeTagline: false });
    
    expect(mockConsoleLog).toHaveBeenCalled();
    // Should log at least once for the ASCII art
    expect(mockConsoleLog.mock.calls.length).toBeGreaterThan(0);
  });

  test("should display compact banner", () => {
    bannerManager.displayCompactBanner();
    
    expect(mockConsoleLog).toHaveBeenCalled();
  });

  test("should display simple header", () => {
    bannerManager.displaySimpleHeader();
    
    expect(mockConsoleLog).toHaveBeenCalled();
    const loggedContent = mockConsoleLog.mock.calls.map(call => call[0]).join(' ');
    expect(loggedContent).toContain('TASKONAUT');
  });

  test("should display simple header without tagline", () => {
    bannerManager.displaySimpleHeader({ includeTagline: false });
    
    expect(mockConsoleLog).toHaveBeenCalled();
  });

  test("should display custom banner", () => {
    bannerManager.displayCustomBanner('TEST', {
      font: 'Standard',
      subtitle: 'Test subtitle'
    });
    
    expect(mockConsoleLog).toHaveBeenCalled();
  });

  test("should handle custom banner errors gracefully", () => {
    // This test simulates figlet throwing an error
    bannerManager.displayCustomBanner('', { font: 'InvalidFont' });
    
    expect(mockConsoleLog).toHaveBeenCalled();
  });

  test("should display version information", () => {
    bannerManager.displayVersion('1.0.0');
    
    expect(mockConsoleLog).toHaveBeenCalledWith('taskonaut v1.0.0');
  });

  test("should display detailed version information", () => {
    bannerManager.displayVersion('1.0.0', { detailed: true });
    
    expect(mockConsoleLog).toHaveBeenCalled();
    const loggedContent = mockConsoleLog.mock.calls.map(call => call[0]).join(' ');
    expect(loggedContent).toContain('taskonaut v1.0.0');
    expect(loggedContent).toContain('Node.js');
    expect(loggedContent).toContain('Platform:');
  });

  test("should display separator", () => {
    bannerManager.displaySeparator();
    
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining('─')
    );
  });

  test("should display separator with title", () => {
    bannerManager.displaySeparator('Test Section');
    
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining('Test Section')
    );
  });

  test("should display separator with different styles", () => {
    bannerManager.displaySeparator('Test', { style: 'double' });
    
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining('═')
    );
  });

  test("should handle fallback banner display", () => {
    bannerManager._displayFallbackBanner();
    
    expect(mockConsoleLog).toHaveBeenCalled();
    const loggedContent = mockConsoleLog.mock.calls.map(call => call[0]).join(' ');
    expect(loggedContent).toContain('TASKONAUT');
  });
});

describe("BANNER_FONTS", () => {
  test("should have all required font options", () => {
    expect(BANNER_FONTS.default).toBe('ANSI Shadow');
    expect(BANNER_FONTS.compact).toBe('Small');
    expect(BANNER_FONTS.bold).toBe('Big');
    expect(BANNER_FONTS.simple).toBe('Standard');
    expect(BANNER_FONTS.slim).toBe('Slant');
  });
});

describe("Convenience functions", () => {
  let mockConsoleLog;

  beforeEach(() => {
    mockConsoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    mockConsoleLog.mockRestore();
  });

  test("displayBanner should work", () => {
    displayBanner();
    expect(mockConsoleLog).toHaveBeenCalled();
  });

  test("displayCompactBanner should work", () => {
    displayCompactBanner();
    expect(mockConsoleLog).toHaveBeenCalled();
  });

  test("displaySimpleHeader should work", () => {
    displaySimpleHeader();
    expect(mockConsoleLog).toHaveBeenCalled();
  });

  test("displayVersion should work", () => {
    displayVersion('1.0.0');
    expect(mockConsoleLog).toHaveBeenCalledWith('taskonaut v1.0.0');
  });
}); 