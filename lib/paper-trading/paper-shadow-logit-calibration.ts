/**
 * Paper-only logit temperature calibration for saturated shadow logistic outputs.
 * Does not change training or live execution; optional admission path in paper engine.
 */

const EPS = 1e-9;

function clampSigmoidInput(z: number): number {
  return Math.max(-20, Math.min(20, z));
}

/** Bounded logit for probability in (0,1). */
export function probaToLogit(p: number): number | null {
  if (!Number.isFinite(p)) return null;
  const x = Math.min(1 - EPS, Math.max(EPS, p));
  return Math.log(x / (1 - x));
}

/**
 * Temperature scaling on logit: p' = sigmoid(logit(p) / T).
 * T=1 ⇒ identity (within clip). T>1 pulls probabilities toward 0.5 (more separation in the mid range).
 */
export function applyPaperShadowLogitTemperature(rawProba: number, temperature: number): number {
  if (!Number.isFinite(rawProba)) return rawProba;
  if (!Number.isFinite(temperature) || temperature <= 0) return rawProba;
  if (Math.abs(temperature - 1) < 1e-12) return rawProba;
  const logit = probaToLogit(rawProba);
  if (logit == null) return rawProba;
  const z = clampSigmoidInput(logit / temperature);
  return 1 / (1 + Math.exp(-z));
}
