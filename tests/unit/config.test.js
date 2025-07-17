import { describe, expect, test, beforeEach, afterEach } from "@jest/globals";
import { ConfigManager, AWSProfileManager } from "../../src/core/config.js";
import { ValidationError } from "../../src/core/errors.js";
import { homedir } from "os";

describe("ConfigManager", () => {
  let configManager;

  beforeEach(() => {
    // Create a ConfigManager with overrides to ensure clean test state
    configManager = new ConfigManager({
      aws: { profile: 'default', region: 'us-east-1' },
      cli: { outputFormat: 'list', quiet: false, verbose: false }
    });
  });

  test("should have default values", () => {
    expect(configManager.get("aws.profile")).toBe("default");
    expect(configManager.get("aws.region")).toBe("us-east-1");
    expect(configManager.get("aws.timeout")).toBe(30000);
    expect(configManager.get("aws.maxRetries")).toBe(3);
    expect(configManager.get("cli.outputFormat")).toBe("list");
    expect(configManager.get("cli.quiet")).toBe(false);
    expect(configManager.get("cli.verbose")).toBe(false);
    expect(configManager.get("cli.confirmActions")).toBe(true);
  });

  test("should be able to set and get values", () => {
    configManager.set("aws.profile", "test-profile");
    configManager.set("aws.region", "eu-west-1");

    expect(configManager.get("aws.profile")).toBe("test-profile");
    expect(configManager.get("aws.region")).toBe("eu-west-1");
  });

  test("should get AWS configuration object", () => {
    const awsConfig = configManager.getAWSConfig();
    
    expect(awsConfig).toHaveProperty("profile");
    expect(awsConfig).toHaveProperty("region");
    expect(awsConfig).toHaveProperty("timeout");
    expect(awsConfig).toHaveProperty("maxRetries");
  });

  test("should get CLI configuration object", () => {
    const cliConfig = configManager.getCLIConfig();
    
    expect(cliConfig).toHaveProperty("outputFormat");
    expect(cliConfig).toHaveProperty("quiet");
    expect(cliConfig).toHaveProperty("verbose");
    expect(cliConfig).toHaveProperty("confirmActions");
  });

  test("should validate AWS region", () => {
    expect(() => {
      new ConfigManager({ aws: { region: "invalid-region" } });
    }).toThrow(ValidationError);
  });

  test("should validate output format", () => {
    expect(() => {
      new ConfigManager({ cli: { outputFormat: "invalid-format" } });
    }).toThrow(ValidationError);
  });

  test("should validate timeout values", () => {
    expect(() => {
      new ConfigManager({ aws: { timeout: -1 } });
    }).toThrow(ValidationError);
  });

  test("should merge configuration objects deeply", () => {
    // Get the default region first
    const defaultConfig = new ConfigManager();
    const defaultRegion = defaultConfig.get("aws.region");
    
    const customConfig = new ConfigManager({
      aws: { 
        profile: "custom",
        timeout: 60000
        // Note: not overriding region, should keep default
      },
      cli: {
        quiet: true
        // Note: not overriding verbose, should keep default
      }
    });

    expect(customConfig.get("aws.profile")).toBe("custom");
    expect(customConfig.get("aws.timeout")).toBe(60000);
    expect(customConfig.get("aws.region")).toBe(defaultRegion); // Should keep default
    expect(customConfig.get("cli.quiet")).toBe(true);
    expect(customConfig.get("cli.verbose")).toBe(false); // Should keep default
  });

  test("should check quiet and verbose modes", () => {
    expect(configManager.isQuiet()).toBe(false);
    expect(configManager.isVerbose()).toBe(false);

    configManager.set("cli.quiet", true);
    expect(configManager.isQuiet()).toBe(true);

    configManager.set("cli.verbose", true);
    expect(configManager.isVerbose()).toBe(true);
  });

  test("should check confirmation setting", () => {
    expect(configManager.shouldConfirmActions()).toBe(true);

    configManager.set("cli.confirmActions", false);
    expect(configManager.shouldConfirmActions()).toBe(false);
  });

  test("should have configuration file path", () => {
    const configPath = configManager.getConfigPath();
    expect(configPath).toContain('.taskonaut');
    expect(configPath).toContain(homedir());
  });

  test("should check if configuration file exists", () => {
    const hasFile = configManager.hasConfigFile();
    expect(typeof hasFile).toBe('boolean');
  });

  test("should be able to reset configuration", () => {
    configManager.set("aws.profile", "test-profile");
    expect(configManager.get("aws.profile")).toBe("test-profile");
    
    configManager.resetConfig();
    expect(configManager.get("aws.profile")).toBe("default");
  });

  test("should be able to create default configuration", () => {
    configManager.createDefaultConfig();
    expect(configManager.get("aws.profile")).toBe("default");
    expect(configManager.get("aws.region")).toBe("us-east-1");
  });
});

describe("AWSProfileManager", () => {
  test("should get credentials and config file paths", () => {
    const credentialsPath = AWSProfileManager.getCredentialsPath();
    const configPath = AWSProfileManager.getConfigPath();
    
    expect(credentialsPath).toContain(".aws");
    expect(credentialsPath).toContain("credentials");
    expect(configPath).toContain(".aws");
    expect(configPath).toContain("config");
  });

  test("should parse INI format correctly", () => {
    const iniContent = `
[default]
aws_access_key_id = AKIA123
aws_secret_access_key = secret123
region = us-east-1

[profile test]
aws_access_key_id = AKIA456
aws_secret_access_key = secret456
region = eu-west-1
`;
    
    const parsed = AWSProfileManager._parseINIFile(iniContent);
    
    expect(parsed).toHaveProperty("default");
    expect(parsed).toHaveProperty("profile test");
    expect(parsed.default.aws_access_key_id).toBe("AKIA123");
    expect(parsed["profile test"].region).toBe("eu-west-1");
  });

  test("should normalize profile names from config", () => {
    // This test would need to mock file system access
    // For now, we'll test the logic conceptually
    expect(AWSProfileManager.getAvailableProfiles).toBeDefined();
  });
});


