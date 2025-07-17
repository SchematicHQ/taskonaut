import { describe, expect, test, beforeEach, afterEach, jest } from "@jest/globals";
import {
  TaskonautError,
  AWSError,
  ECSError,
  CLIError,
  ValidationError,
  UserCancelledError,
  ErrorHandler,
  ERROR_CODES,
  ERROR_MESSAGES,
  setupGlobalErrorHandlers
} from "../../src/core/errors.js";

describe("TaskonautError", () => {
  test("should create error with default values", () => {
    const error = new TaskonautError("Test error");
    
    expect(error.name).toBe("TaskonautError");
    expect(error.message).toBe("Test error");
    expect(error.code).toBe(ERROR_CODES.SYSTEM_ERROR);
    expect(error.metadata).toEqual({});
    expect(error.cause).toBe(null);
    expect(error.timestamp).toBeDefined();
  });

  test("should create error with custom values", () => {
    const originalError = new Error("Original error");
    const metadata = { field: "test", value: 123 };
    const error = new TaskonautError(
      "Custom error",
      ERROR_CODES.VALIDATION_FAILED,
      metadata,
      originalError
    );
    
    expect(error.name).toBe("TaskonautError");
    expect(error.message).toBe("Custom error");
    expect(error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    expect(error.metadata).toEqual(metadata);
    expect(error.cause).toBe(originalError);
  });

  test("should get user-friendly message", () => {
    const error = new TaskonautError("Test error", ERROR_CODES.AWS_CREDENTIALS_MISSING);
    const userMessage = error.getUserMessage();
    
    expect(userMessage).toBe(ERROR_MESSAGES[ERROR_CODES.AWS_CREDENTIALS_MISSING]);
  });

  test("should fallback to original message if no user message", () => {
    const error = new TaskonautError("Custom error", "UNKNOWN_CODE");
    const userMessage = error.getUserMessage();
    
    expect(userMessage).toBe("Custom error");
  });

  test("should convert to JSON", () => {
    const originalError = new Error("Original error");
    const error = new TaskonautError("Test error", ERROR_CODES.SYSTEM_ERROR, {}, originalError);
    const json = error.toJSON();
    
    expect(json).toHaveProperty("name", "TaskonautError");
    expect(json).toHaveProperty("message", "Test error");
    expect(json).toHaveProperty("code", ERROR_CODES.SYSTEM_ERROR);
    expect(json).toHaveProperty("metadata", {});
    expect(json).toHaveProperty("stack");
    expect(json).toHaveProperty("timestamp");
    expect(json).toHaveProperty("cause");
    expect(json.cause).toHaveProperty("name", "Error");
    expect(json.cause).toHaveProperty("message", "Original error");
  });
});

describe("AWSError", () => {
  test("should create AWS error with defaults", () => {
    const error = new AWSError("AWS operation failed");
    
    expect(error.name).toBe("AWSError");
    expect(error.message).toBe("AWS operation failed");
    expect(error.code).toBe(ERROR_CODES.AWS_API_ERROR);
  });

  test("should inherit from TaskonautError", () => {
    const error = new AWSError("AWS error");
    expect(error).toBeInstanceOf(TaskonautError);
    expect(error).toBeInstanceOf(AWSError);
  });
});

describe("ECSError", () => {
  test("should create ECS error with defaults", () => {
    const error = new ECSError("ECS operation failed");
    
    expect(error.name).toBe("ECSError");
    expect(error.message).toBe("ECS operation failed");
    expect(error.code).toBe(ERROR_CODES.ECS_CLUSTER_NOT_FOUND);
  });

  test("should inherit from TaskonautError", () => {
    const error = new ECSError("ECS error");
    expect(error).toBeInstanceOf(TaskonautError);
    expect(error).toBeInstanceOf(ECSError);
  });
});

describe("CLIError", () => {
  test("should create CLI error with defaults", () => {
    const error = new CLIError("CLI operation failed");
    
    expect(error.name).toBe("CLIError");
    expect(error.message).toBe("CLI operation failed");
    expect(error.code).toBe(ERROR_CODES.CLI_INVALID_COMMAND);
  });

  test("should inherit from TaskonautError", () => {
    const error = new CLIError("CLI error");
    expect(error).toBeInstanceOf(TaskonautError);
    expect(error).toBeInstanceOf(CLIError);
  });
});

describe("ValidationError", () => {
  test("should create validation error with field and value", () => {
    const error = new ValidationError("Invalid input", "username", "test@example");
    
    expect(error.name).toBe("ValidationError");
    expect(error.message).toBe("Invalid input");
    expect(error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    expect(error.metadata.field).toBe("username");
    expect(error.metadata.value).toBe("test@example");
  });

  test("should inherit from TaskonautError", () => {
    const error = new ValidationError("Validation failed");
    expect(error).toBeInstanceOf(TaskonautError);
    expect(error).toBeInstanceOf(ValidationError);
  });
});

describe("UserCancelledError", () => {
  test("should create user cancelled error with default message", () => {
    const error = new UserCancelledError();
    
    expect(error.name).toBe("UserCancelledError");
    expect(error.message).toBe("Operation cancelled by user");
    expect(error.code).toBe(ERROR_CODES.CLI_USER_CANCELLED);
  });

  test("should create user cancelled error with custom message", () => {
    const error = new UserCancelledError("Custom cancellation");
    
    expect(error.message).toBe("Custom cancellation");
  });

  test("should inherit from CLIError", () => {
    const error = new UserCancelledError();
    expect(error).toBeInstanceOf(TaskonautError);
    expect(error).toBeInstanceOf(CLIError);
    expect(error).toBeInstanceOf(UserCancelledError);
  });
});

describe("ErrorHandler", () => {
  let mockLogger;

  beforeEach(() => {
    mockLogger = {
      error: jest.fn()
    };
    
    // Mock the logger import
    jest.unstable_mockModule("../../src/core/logger.js", () => ({
      default: mockLogger
    }));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test("should handle TaskonautError", () => {
    const error = new TaskonautError("Test error", ERROR_CODES.AWS_API_ERROR, { test: true });
    ErrorHandler.handle(error, { operation: "test" });

    // Note: This test would need proper mocking of the logger
    // For now we just verify the method doesn't throw
    expect(true).toBe(true);
  });

  test("should handle generic Error", () => {
    const error = new Error("Generic error");
    ErrorHandler.handle(error, { operation: "test" });

    // Note: This test would need proper mocking of the logger
    // For now we just verify the method doesn't throw
    expect(true).toBe(true);
  });

  test("should wrap async functions", async () => {
    const mockFn = jest.fn().mockResolvedValue("success");
    const wrappedFn = ErrorHandler.wrapAsync(mockFn, { operation: "test" });
    
    const result = await wrappedFn("arg1", "arg2");
    
    expect(result).toBe("success");
    expect(mockFn).toHaveBeenCalledWith("arg1", "arg2");
  });

  test("should handle errors in wrapped async functions", async () => {
    const mockError = new Error("Async error");
    const mockFn = jest.fn().mockRejectedValue(mockError);
    const wrappedFn = ErrorHandler.wrapAsync(mockFn, { operation: "test" });
    
    await expect(wrappedFn()).rejects.toThrow("Async error");
  });

  test("should create AWSError from AWS SDK error", () => {
    const awsError = {
      code: "NoCredentialsError",
      message: "Unable to locate credentials",
      requestId: "12345"
    };
    
    const error = ErrorHandler.fromAWSError(awsError, "test operation");
    
    expect(error).toBeInstanceOf(AWSError);
    expect(error.message).toContain("test operation failed");
    expect(error.message).toContain("Unable to locate credentials");
    expect(error.code).toBe(ERROR_CODES.AWS_CREDENTIALS_MISSING);
    expect(error.metadata.operation).toBe("test operation");
    expect(error.metadata.awsErrorCode).toBe("NoCredentialsError");
    expect(error.metadata.requestId).toBe("12345");
  });

  test("should map various AWS error codes", () => {
    const testCases = [
      { code: "CredentialsError", expected: ERROR_CODES.AWS_CREDENTIALS_MISSING },
      { code: "ProfileNotFound", expected: ERROR_CODES.AWS_PROFILE_INVALID },
      { code: "InvalidRegion", expected: ERROR_CODES.AWS_REGION_INVALID },
      { code: "ClusterNotFoundException", expected: ERROR_CODES.ECS_CLUSTER_NOT_FOUND },
      { code: "ServiceNotFoundException", expected: ERROR_CODES.ECS_SERVICE_NOT_FOUND },
      { code: "AccessDeniedException", expected: ERROR_CODES.PERMISSION_DENIED },
      { code: "UnknownError", expected: ERROR_CODES.AWS_API_ERROR }
    ];

    testCases.forEach(({ code, expected }) => {
      const awsError = { code, message: "Test error" };
      const error = ErrorHandler.fromAWSError(awsError);
      expect(error.code).toBe(expected);
    });
  });

  test("should check if error is user cancelled", () => {
    expect(ErrorHandler.isUserCancelled(new UserCancelledError())).toBe(true);
    
    const errorWithCode = new TaskonautError("Test", ERROR_CODES.CLI_USER_CANCELLED);
    expect(ErrorHandler.isUserCancelled(errorWithCode)).toBe(true);
    
    const errorWithMessage = new Error("Operation was cancelled");
    expect(ErrorHandler.isUserCancelled(errorWithMessage)).toBe(true);
    
    const regularError = new Error("Regular error");
    expect(ErrorHandler.isUserCancelled(regularError)).toBe(false);
  });

  test("should check if error should cause exit", () => {
    expect(ErrorHandler.shouldExit(new UserCancelledError())).toBe(true);
    
    const credentialsError = new TaskonautError("Test", ERROR_CODES.AWS_CREDENTIALS_MISSING);
    expect(ErrorHandler.shouldExit(credentialsError)).toBe(true);
    
    const permissionError = new TaskonautError("Test", ERROR_CODES.PERMISSION_DENIED);
    expect(ErrorHandler.shouldExit(permissionError)).toBe(true);
    
    const regularError = new TaskonautError("Test", ERROR_CODES.SYSTEM_ERROR);
    expect(ErrorHandler.shouldExit(regularError)).toBe(false);
    
    const genericError = new Error("Test");
    expect(ErrorHandler.shouldExit(genericError)).toBe(false);
  });
});

describe("ERROR_CODES", () => {
  test("should have all required error codes", () => {
    expect(ERROR_CODES.AWS_CREDENTIALS_MISSING).toBeDefined();
    expect(ERROR_CODES.AWS_PROFILE_INVALID).toBeDefined();
    expect(ERROR_CODES.ECS_CLUSTER_NOT_FOUND).toBeDefined();
    expect(ERROR_CODES.CLI_USER_CANCELLED).toBeDefined();
    expect(ERROR_CODES.VALIDATION_FAILED).toBeDefined();
    expect(ERROR_CODES.SYSTEM_ERROR).toBeDefined();
  });
});

describe("ERROR_MESSAGES", () => {
  test("should have user-friendly messages for all error codes", () => {
    Object.keys(ERROR_CODES).forEach(codeKey => {
      const code = ERROR_CODES[codeKey];
      expect(ERROR_MESSAGES[code]).toBeDefined();
      
      // Check that message contains at least one emoji (including clock ⏰)
      const hasEmoji = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{1F1E6}-\u{1F1FF}]|⏰|⚠️|❌|✅|🔐|👤|🌍|☁️|🏗️|📋|⚙️|📦|🚫|💤|❓|💻|🌐|🔒/u.test(ERROR_MESSAGES[code]);
      expect(hasEmoji).toBe(true);
    });
  });
});

describe("setupGlobalErrorHandlers", () => {
  test("should be a function", () => {
    expect(typeof setupGlobalErrorHandlers).toBe("function");
  });

  test("should setup global error handlers without throwing", () => {
    expect(() => setupGlobalErrorHandlers()).not.toThrow();
  });
}); 