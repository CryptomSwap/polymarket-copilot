import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { hasStoredCredentials } from "@/lib/polymarket/auth";

/**
 * GET /api/polymarket/health
 * Returns connection and credential status. No secrets.
 */
export async function GET() {
  try {
    const connection = await prisma.connectedWallet.findFirst({
      orderBy: { updatedAt: "desc" },
    });

    const hasConnection = Boolean(connection);
    const hasCredentials = await hasStoredCredentials();

    return NextResponse.json({
      walletConnectionExists: hasConnection,
      credentialsExist: hasCredentials,
      signatureType: connection?.signatureType ?? null,
      funderAddressSaved: Boolean(connection?.funderAddress?.trim()),
      eoaAddressSaved: Boolean(connection?.eoaAddress?.trim()),
      /** For stream connection vs heartbeat vs real data vs reconciled, use GET /api/live/stream-health or GET /api/ops/runtime/health. */
      streamHealthUrl: "/api/live/stream-health",
    });
  } catch (error) {
    console.error("[GET /api/polymarket/health]", error);
    return NextResponse.json(
      { error: "Failed to get Polymarket health" },
      { status: 500 }
    );
  }
}
