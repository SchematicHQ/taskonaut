import { describe, expect, test } from "@jest/globals";
import { AWS_REGIONS } from "../../regions.js";

describe("AWS_REGIONS", () => {
  test("should be an array", () => {
    expect(Array.isArray(AWS_REGIONS)).toBe(true);
  });

  test("should not be empty", () => {
    expect(AWS_REGIONS.length).toBeGreaterThan(0);
  });

  test("should contain major AWS regions", () => {
    const majorRegions = ["us-east-1", "us-west-2", "eu-west-1"];
    majorRegions.forEach((region) => {
      expect(AWS_REGIONS).toContain(region);
    });
  });

  test("all regions should be strings", () => {
    AWS_REGIONS.forEach((region) => {
      expect(typeof region).toBe("string");
    });
  });

  test("should have valid region format", () => {
    const regionFormat = /^[a-z]{2}(-gov)?-[a-z]+-\d+$/;
    AWS_REGIONS.forEach((region) => {
      expect(region).toMatch(regionFormat);
    });
  });
});
