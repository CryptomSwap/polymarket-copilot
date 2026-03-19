/**
 * Calibration module: re-export from root ml/calibration for structured layout.
 * Additive; future calibration logic can live here (e.g. isotonic, Platt) while legacy uses lib/ml/calibration.ts.
 */

export {
  calibrationSummary,
  calibrationReport,
  type CalibrationBucket,
  type CalibrationSummaryReport,
} from "@/lib/ml/calibration";
