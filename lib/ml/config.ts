/**
 * ML feature flags and config. All new behavioral changes gated here; defaults preserve current behavior.
 */

function envBool(key: string, defaultValue: boolean): boolean {
  const raw = typeof process !== "undefined" ? process.env[key]?.trim().toLowerCase() : "";
  if (raw === "") return defaultValue;
  return raw === "1" || raw === "true";
}

/** Emit multi-role score bundle (MlScoreBundle) alongside legacy ShadowScoreResult when true. */
export function enableMlMultiroleOutputs(): boolean {
  return envBool("ENABLE_ML_MULTIROLE_OUTPUTS", false);
}

/** Paper-only: use blended exploration allocator instead of pure threshold. */
export function enablePaperExplorationAllocatorV1(): boolean {
  return envBool("ENABLE_PAPER_EXPLORATION_ALLOCATOR_V1", false);
}

/** Run champion + challenger scoring and include in outputs when true. */
export function enableMlChampionChallenger(): boolean {
  return envBool("ENABLE_ML_CHAMPION_CHALLENGER", false);
}

/** Attach support/uncertainty flags to score bundle when true. */
export function enableMlSupportFlags(): boolean {
  return envBool("ENABLE_ML_SUPPORT_FLAGS", false);
}

/** Paper-only: apply conservative per-bot budget allocator for new paper trades. */
export function enablePaperBotBudgetAllocatorV1(): boolean {
  return envBool("ENABLE_PAPER_BOT_BUDGET_ALLOCATOR_V1", false);
}

/**
 * Paper-only: resolve per-bot runtime profile from ACTIVE governance revision when ON.
 * When OFF (default), runtime uses BOT_PROFILES + global config + env only.
 */
export function enablePaperRuntimeProfileFromActiveRevision(): boolean {
  return envBool("ENABLE_PAPER_RUNTIME_PROFILE_FROM_ACTIVE_REVISION", false);
}

/**
 * Paper-only: resolve per-bot model from INTENDED_ACTIVE link for ACTIVE revision when ON.
 * When OFF (default), scoring uses single global champion from getActiveOrApprovedShadowModel().
 */
export function enablePaperPerBotModelSelectionFromGovernance(): boolean {
  return envBool("ENABLE_PAPER_PER_BOT_MODEL_SELECTION_FROM_GOVERNANCE", false);
}
