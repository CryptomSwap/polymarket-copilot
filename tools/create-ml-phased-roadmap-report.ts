/**
 * Phased roadmap report for ML improvements.
 * Outputs: dump/ml-phased-roadmap-report.json, dump/ml-phased-roadmap-report.md
 */

import * as fs from "fs";
import * as path from "path";

const DUMP_DIR = path.join(process.cwd(), "dump");

const ROADMAP = {
  generatedAt: new Date().toISOString(),
  phases: [
    {
      phase: 1,
      name: "Observability and structure",
      items: [
        "ML architecture map and dump scripts (done)",
        "Multi-role types (MlScoreBundle, roles, targets) (done)",
        "Target registry and label scaffolding (done)",
        "Segmented and calibration reports (done)",
        "Config gating for new behavior (done)",
      ],
    },
    {
      phase: 2,
      name: "Label and evaluation expansion",
      items: [
        "Populate labelGoodDecision6h / labelGoodDecision12h in shadow build from markouts",
        "Run segmented performance report on real validation set with scores",
        "Add calibration to score output (optional, gated) or document as uncalibrated",
      ],
    },
    {
      phase: 3,
      name: "Exploration and champion/challenger",
      items: [
        "Enable ENABLE_PAPER_EXPLORATION_ALLOCATOR_V1 in staging; tune quotas",
        "Wire champion/challenger parallel scoring when multiple runs exist",
        "Dump comparison reports in CI or nightly",
      ],
    },
    {
      phase: 4,
      name: "Execution realism (additive)",
      items: [
        "Add spread-adjusted and realizable-PnL targets to registry; implement when data available",
        "Segment evaluation by spread/liquidity; document limitations",
      ],
    },
  ],
  constraints: [
    "Do not remove or weaken hard safety/risk rules.",
    "Do not make ML a direct autonomous trader.",
    "Preserve current behavior unless explicitly gated.",
  ],
};

function ensureDumpDir(): void {
  if (!fs.existsSync(DUMP_DIR)) fs.mkdirSync(DUMP_DIR, { recursive: true });
}

function main(): void {
  ensureDumpDir();
  const jsonPath = path.join(DUMP_DIR, "ml-phased-roadmap-report.json");
  const mdPath = path.join(DUMP_DIR, "ml-phased-roadmap-report.md");
  fs.writeFileSync(jsonPath, JSON.stringify(ROADMAP, null, 2), "utf-8");
  console.log(`Wrote ${jsonPath}`);
  const md = [
    "# ML Phased Roadmap",
    "",
    `Generated: ${ROADMAP.generatedAt}`,
    "",
    "## Constraints",
    ...ROADMAP.constraints.map((c) => `- ${c}`),
    "",
    "## Phases",
    ...ROADMAP.phases.flatMap((p) => [
      "",
      `### Phase ${p.phase}: ${p.name}`,
      ...p.items.map((i) => `- ${i}`),
    ]),
    "",
  ].join("\n");
  fs.writeFileSync(mdPath, md, "utf-8");
  console.log(`Wrote ${mdPath}`);
}

main();
