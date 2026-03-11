import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { clearCredentialsForConnection } from "@/lib/polymarket/auth";

/**
 * POST /api/polymarket/clear-credentials
 * Deletes stored PolymarketApiCredential rows for the current saved connection only.
 * Does not delete the wallet connection (EOA/funder). Safe to call before re-initializing credentials.
 */
export async function POST() {
  try {
    const connection = await prisma.connectedWallet.findFirst({
      orderBy: { updatedAt: "desc" },
    });
    if (!connection) {
      return NextResponse.json(
        { error: "No wallet connection. Save EOA and funder in Settings first." },
        { status: 400 }
      );
    }
    const cleared = await clearCredentialsForConnection(connection.id);
    return NextResponse.json({
      success: true,
      cleared,
      diagnostics: {
        connectionId: connection.id,
        eoaAddress: connection.eoaAddress,
        funderAddress: connection.funderAddress,
      },
    });
  } catch (error) {
    console.error("[POST /api/polymarket/clear-credentials]", error);
    return NextResponse.json(
      { error: "Failed to clear credentials" },
      { status: 500 }
    );
  }
}
