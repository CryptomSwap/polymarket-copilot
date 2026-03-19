/**
 * Dump ML target registry report.
 * Outputs: dump/ml-label-registry-report.json, dump/ml-label-registry-report.md
 */

import * as fs from "fs";
import * as path from "path";
import {
  ML_TARGET_REGISTRY,
  getImplementedTargets,
  getScaffoldedTargets,
} from "../lib/ml/targets/registry";
import type { MlTargetKey } from "../lib/ml/types/targets";

const DUMP_DIR = path.join(process.cwd(), "dump");

function ensureDumpDir(): void {
  if (!fs.existsSync(DUMP_DIR)) fs.mkdirSync(DUMP_DIR, { recursive: true });
}

function main(): void {
  ensureDumpDir();
  const implemented = getImplementedTargets();
  const scaffolded = getScaffoldedTargets();
  const report = {
    generatedAt: new Date().toISOString(),
    implemented: implemented.map((k) => ({ key: k, ...ML_TARGET_REGISTRY[k] })),
    scaffolded: scaffolded.map((k) => ({ key: k, ...ML_TARGET_REGISTRY[k] })),
    all: (Object.keys(ML_TARGET_REGISTRY) as MlTargetKey[]).map((k) => ({
      key: k,
      ...ML_TARGET_REGISTRY[k],
    })),
  };
  const jsonPath = path.join(DUMP_DIR, "ml-label-registry-report.json");
  const mdPath = path.join(DUMP_DIR, "ml-label-registry-report.md");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");
  console.log(`Wrote ${jsonPath}`);

  const md = [
    "# ML Label Registry Report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Implemented targets",
    "",
    ...implemented.map(
      (k) =>
        `- **${k}**: ${ML_TARGET_REGISTRY[k].description} (horizon: ${ML_TARGET_REGISTRY[k].horizonHours ?? "N/A"}h)`
    ),
    "",
    "## Scaffolded / not yet implemented",
    "",
    ...scaffolded.map((k) => {
      const def = ML_TARGET_REGISTRY[k];
      const gaps = def.gaps?.length ? ` Gaps: ${def.gaps.join("; ")}` : "";
      return `- **${k}**: ${def.description}${gaps}`;
    }),
    "",
  ].join("\n");
  fs.writeFileSync(mdPath, md, "utf-8");
  console.log(`Wrote ${mdPath}`);
}

main();
