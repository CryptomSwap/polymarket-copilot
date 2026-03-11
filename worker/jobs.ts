/**
 * Worker job runner: delegates to lib/ops/scheduled-jobs so the same logic can be triggered by API or worker.
 */

import {
  runScheduledJob,
  JOB_NAMES,
  JOB_INTERVALS_MS,
  isJobName,
  type JobName,
} from "../lib/ops/scheduled-jobs";

export { JOB_NAMES, JOB_INTERVALS_MS, isJobName, type JobName };

export const runJob = runScheduledJob;
