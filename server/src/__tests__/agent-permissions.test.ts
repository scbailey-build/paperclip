import { describe, expect, it } from "vitest";
import {
  defaultPermissionsForRole,
  isRecommendOnly,
  normalizeAgentPermissions,
} from "../services/agent-permissions.js";

describe("agent permissions", () => {
  it("defaults recommendOnly to false for every role", () => {
    expect(defaultPermissionsForRole("ceo").recommendOnly).toBe(false);
    expect(defaultPermissionsForRole("general").recommendOnly).toBe(false);
  });

  it("preserves recommendOnly through normalization", () => {
    const normalized = normalizeAgentPermissions(
      { canCreateAgents: false, recommendOnly: true },
      "general",
    );
    expect(normalized.recommendOnly).toBe(true);
    expect(normalized.canCreateAgents).toBe(false);
  });

  it("drops non-boolean recommendOnly values to the default", () => {
    expect(normalizeAgentPermissions({ recommendOnly: "yes" }, "general").recommendOnly).toBe(
      false,
    );
    expect(normalizeAgentPermissions(null, "general").recommendOnly).toBe(false);
  });

  it("isRecommendOnly only accepts an explicit boolean true", () => {
    expect(isRecommendOnly({ recommendOnly: true })).toBe(true);
    expect(isRecommendOnly({ recommendOnly: false })).toBe(false);
    expect(isRecommendOnly({ recommendOnly: "true" })).toBe(false);
    expect(isRecommendOnly(null)).toBe(false);
    expect(isRecommendOnly(undefined)).toBe(false);
    expect(isRecommendOnly([])).toBe(false);
  });
});
