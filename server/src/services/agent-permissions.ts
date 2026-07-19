export type NormalizedAgentPermissions = Record<string, unknown> & {
  canCreateAgents: boolean;
  canCreateSkills: boolean;
  recommendOnly: boolean;
};

export function defaultPermissionsForRole(role: string): NormalizedAgentPermissions {
  return {
    canCreateAgents: role.trim().toLowerCase() === "ceo",
    canCreateSkills: true,
    recommendOnly: false,
  };
}

export function normalizeAgentPermissions(
  permissions: unknown,
  role: string,
): NormalizedAgentPermissions {
  const defaults = defaultPermissionsForRole(role);
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    return defaults;
  }

  const record = permissions as Record<string, unknown>;
  const preserved = { ...record };
  return {
    ...preserved,
    canCreateAgents:
      typeof record.canCreateAgents === "boolean"
        ? record.canCreateAgents
        : defaults.canCreateAgents,
    canCreateSkills:
      typeof record.canCreateSkills === "boolean"
        ? record.canCreateSkills
        : defaults.canCreateSkills,
    recommendOnly:
      typeof record.recommendOnly === "boolean" ? record.recommendOnly : defaults.recommendOnly,
  };
}

/**
 * Recommend-only agents (e.g. the COO) may read everything and create
 * approvals, but every other write surface is denied at the route layer.
 */
export function isRecommendOnly(permissions: unknown): boolean {
  return (
    typeof permissions === "object" &&
    permissions !== null &&
    !Array.isArray(permissions) &&
    (permissions as Record<string, unknown>).recommendOnly === true
  );
}
