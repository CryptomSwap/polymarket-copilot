import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getTargetDefinition } from "@/lib/ml/targets/registry";

export const dynamic = "force-dynamic";

const SHADOW_MODEL_TYPE = "logistic_regression_shadow";

/**
 * POST /api/ml/activate-latest-shadow
 * Find the latest shadow model run (by updatedAt) and set it to ACTIVE. Demotes any other ACTIVE shadow run to VALIDATED.
 * Only one ACTIVE shadow model at a time. No body required.
 */
export async function POST() {
  try {
    const latest = await prisma.mlModelRun.findFirst({
      where: { modelType: SHADOW_MODEL_TYPE },
      orderBy: { updatedAt: "desc" },
    });
    if (!latest) {
      return NextResponse.json(
        { success: false, error: "No shadow model run found. Train one first: npm run train:shadow-model -- --target=labelGoodDecision12h" },
        { status: 404 }
      );
    }
    const runId = latest.id;
    const currentActive = await prisma.mlModelRun.findMany({
      where: { status: "ACTIVE", modelType: SHADOW_MODEL_TYPE },
    });
    for (const r of currentActive) {
      if (r.id !== runId) {
        await prisma.mlModelRun.update({
          where: { id: r.id },
          data: { status: "VALIDATED" },
        });
      }
    }
    await prisma.mlModelRun.update({
      where: { id: runId },
      data: { status: "ACTIVE" },
    });
    const def = getTargetDefinition(latest.targetLabel as any);
    const targetWarning =
      def.implementationStatus !== "implemented"
        ? `Target ${latest.targetLabel} is ${def.implementationStatus}; implementationStatus != implemented.`
        : null;
    return NextResponse.json({
      success: true,
      runId,
      status: "ACTIVE",
      targetLabel: latest.targetLabel,
      featureSetName: latest.featureSetName,
      targetImplementationStatus: def.implementationStatus,
      targetWarning,
    });
  } catch (error) {
    console.error("[POST /api/ml/activate-latest-shadow]", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Activate failed" },
      { status: 500 }
    );
  }
}
