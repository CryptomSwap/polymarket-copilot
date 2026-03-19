/**
 * Shadow ML advisory scoring: score current candidate context with shadow-trained model.
 * Does not change execution; advisory only.
 */

export { getActiveOrApprovedShadowModel, scoreShadowCandidate } from "./score-live";
export type { ShadowScoreInput, ShadowScoreResult } from "./types";
