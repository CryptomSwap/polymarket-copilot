import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/ops/worker-status
 * Returns worker heartbeat records (worker health), distinct from WebSocket connection status.
 */
export async function GET() {
  try {
    const heartbeats = await prisma.workerHeartbeat.findMany({
      orderBy: { lastSeenAt: "desc" },
      take: 20,
    });
    const byName = heartbeats.reduce(
      (acc, h) => {
        if (!acc[h.workerName]) {
          acc[h.workerName] = {
            workerName: h.workerName,
            status: h.status,
            lastSeenAt: h.lastSeenAt.toISOString(),
            metadataJson: h.metadataJson,
            updatedAt: h.updatedAt.toISOString(),
          };
        }
        return acc;
      },
      {} as Record<string, { workerName: string; status: string; lastSeenAt: string; metadataJson: string | null; updatedAt: string }>
    );
    return NextResponse.json({
      workers: Object.values(byName),
      heartbeats: heartbeats.map((h) => ({
        id: h.id,
        workerName: h.workerName,
        status: h.status,
        lastSeenAt: h.lastSeenAt.toISOString(),
        metadataJson: h.metadataJson,
        updatedAt: h.updatedAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error("[GET /api/ops/worker-status]", error);
    return NextResponse.json(
      { error: "Failed to fetch worker status" },
      { status: 500 }
    );
  }
}
