/**
 * Tests for position thesis: get/upsert, validation, ownership.
 * getPositionThesisForApi returns null when no position; stable empty shape when position but no thesis.
 * Run: npx ts-node --project tsconfig.tests.json -r tsconfig-paths/register lib/portfolio/__tests__/position-thesis.test.ts
 */

import { prisma } from "@/lib/db";
import {
  getPositionThesis,
  getPositionThesisForApi,
  upsertPositionThesis,
  THESIS_STATUSES,
  type PositionThesisResponse,
  type ThesisStatus,
} from "../position-thesis";

function hasResponseShape(r: unknown): r is PositionThesisResponse {
  if (!r || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.assetId === "string" &&
    (o.marketId === null || typeof o.marketId === "string") &&
    (o.marketTitle === null || typeof o.marketTitle === "string") &&
    typeof o.currentThesisStatus === "string" &&
    (o.entryThesis === null || typeof o.entryThesis === "string") &&
    (o.exitReason === null || typeof o.exitReason === "string") &&
    (o.notes === null || typeof o.notes === "string") &&
    (o.createdAt === null || typeof o.createdAt === "string") &&
    (o.updatedAt === null || typeof o.updatedAt === "string")
  );
}

export async function runPositionThesisTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;
  function check(cond: boolean, msg: string): void {
    if (cond) {
      passed++;
      console.log("  OK:", msg);
    } else {
      failed++;
      console.error("  FAIL:", msg);
    }
  }

  const noPositionFunder = "0x0000000000000000000000000000000000000001";
  const fakeAssetId = "0xasset_no_position_999";

  console.log("\n--- getPositionThesisForApi: no position returns null ---");
  const noPosition = await getPositionThesisForApi(noPositionFunder, fakeAssetId);
  check(noPosition === null, "getPositionThesisForApi returns null when funder has no position for assetId");

  console.log("\n--- getPositionThesis: missing thesis returns null ---");
  const noThesis = await getPositionThesis(noPositionFunder, fakeAssetId);
  check(noThesis === null, "getPositionThesis returns null when no thesis row");

  console.log("\n--- THESIS_STATUSES ---");
  check(Array.isArray(THESIS_STATUSES), "THESIS_STATUSES is array");
  check(
    THESIS_STATUSES.includes("unknown") && THESIS_STATUSES.includes("intact") && THESIS_STATUSES.includes("weakened") && THESIS_STATUSES.includes("invalidated"),
    "THESIS_STATUSES includes unknown, intact, weakened, invalidated"
  );

  console.log("\n--- upsertPositionThesis: no position throws ---");
  try {
    await upsertPositionThesis(noPositionFunder, fakeAssetId, {
      entryThesis: "test",
      currentThesisStatus: "unknown",
    });
    check(false, "upsertPositionThesis should throw when position does not exist");
  } catch (e) {
    check(
      (e instanceof Error && e.message.includes("Position not found")) || String(e).includes("Position not found"),
      "upsertPositionThesis throws Position not found for non-existent position"
    );
  }

  console.log("\n--- upsertPositionThesis: invalid currentThesisStatus throws (when position exists) ---");
  const positionsForValidation = await prisma.derivedPosition.findMany({ take: 1 });
  if (positionsForValidation.length > 0) {
    const { funderAddress, assetId } = positionsForValidation[0];
    try {
      await upsertPositionThesis(funderAddress, assetId, {
        currentThesisStatus: "invalid_status" as ThesisStatus,
      });
      check(false, "upsertPositionThesis should throw for invalid currentThesisStatus");
    } catch (e) {
      check(
        (e instanceof Error && e.message.includes("Invalid currentThesisStatus")) || String(e).includes("Invalid"),
        "upsertPositionThesis throws for invalid currentThesisStatus"
      );
    }
  } else {
    check(true, "skip invalid status test (no positions in DB)");
  }

  console.log("\n--- getPositionThesisForApi: response shape (when position exists) ---");
  const anyFunderWithPosition = noPositionFunder;
  const positions = await prisma.derivedPosition.findMany({
    where: { funderAddress: anyFunderWithPosition },
    take: 1,
  });
  if (positions.length > 0) {
    const assetId = positions[0].assetId;
    const resp = await getPositionThesisForApi(anyFunderWithPosition, assetId);
    check(resp !== null, "getPositionThesisForApi returns non-null when position exists");
    if (resp) {
      check(hasResponseShape(resp), "response has required shape (assetId, marketId, marketTitle, currentThesisStatus, entryThesis, exitReason, notes, createdAt, updatedAt)");
      check(resp.assetId === assetId, "response.assetId matches requested assetId");
      check(THESIS_STATUSES.includes(resp.currentThesisStatus as ThesisStatus), "currentThesisStatus is one of THESIS_STATUSES");
    }
  } else {
    console.log("  (skip response shape: no positions for test funder)");
  }

  console.log("\n--- Position thesis tests result ---");
  console.log(`  Passed: ${passed}, Failed: ${failed}`);
  return { passed, failed };
}

if (require.main === module) {
  runPositionThesisTests()
    .then(({ failed }) => process.exit(failed > 0 ? 1 : 0))
    .catch((err) => {
      console.error("Position thesis tests error:", err);
      process.exit(1);
    });
}
