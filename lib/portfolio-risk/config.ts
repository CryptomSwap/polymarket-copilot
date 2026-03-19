/**
 * Portfolio-risk threshold configuration.
 * Centralized for calibration and audit; defaults match current runtime/decision usage.
 * Do not auto-mutate; changes applied only via explicit config updates.
 */

export interface PortfolioRiskThresholds {
  /** Max total gross / at-risk exposure (notional). */
  maxTotalExposure: number;
  /** Max single-market concentration (0–100). */
  maxSingleMarketConcentrationPct: number;
  /** Max single-theme concentration (0–100). */
  maxSingleThemeConcentrationPct: number;
  /** Hours to resolution below which position is "near resolution". */
  nearResolutionHoursThreshold: number;
  /** Near-resolution exposure as % of total: above this → warn (0–100). */
  nearResolutionExposureWarnPct: number;
  /** Near-resolution exposure as % of total: above this → block if used (0–100). */
  nearResolutionExposureBlockPct: number;
  /** Illiquid exposure as % of total: above this → warn (0–100). */
  illiquidExposureWarnPct: number;
  /** Illiquid exposure as % of total: above this → block if used (0–100). */
  illiquidExposureBlockPct: number;
  /** Correlated (e.g. top-2 cluster) exposure as % of total: above this → warn (0–100). */
  correlatedExposureWarnPct: number;
  /** Correlated exposure as % of total: above this → block if used (0–100). */
  correlatedExposureBlockPct: number;
}

export const defaultPortfolioRiskThresholds: PortfolioRiskThresholds = {
  maxTotalExposure: 100_000,
  maxSingleMarketConcentrationPct: 50,
  maxSingleThemeConcentrationPct: 50,
  nearResolutionHoursThreshold: 72,
  nearResolutionExposureWarnPct: 20,
  nearResolutionExposureBlockPct: 50,
  illiquidExposureWarnPct: 30,
  illiquidExposureBlockPct: 60,
  correlatedExposureWarnPct: 60,
  correlatedExposureBlockPct: 85,
};

let currentThresholds: PortfolioRiskThresholds = { ...defaultPortfolioRiskThresholds };

export function getPortfolioRiskThresholds(): PortfolioRiskThresholds {
  return { ...currentThresholds };
}

/**
 * Set thresholds (e.g. from calibration review). Call only when operator has approved.
 * Does not persist; process restart reverts to default unless set again.
 */
export function setPortfolioRiskThresholds(thresholds: Partial<PortfolioRiskThresholds>): void {
  currentThresholds = { ...currentThresholds, ...thresholds };
}
