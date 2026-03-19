import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getStoredCredentials, hasStoredCredentials } from "@/lib/polymarket/auth";
import { isCredentialEncryptionConfigured } from "@/lib/polymarket/credentials-env";
import { validateCredentialsWithClob } from "@/lib/polymarket/l2-readonly";

const TRADABLE_END_DATE_DAYS = 30;

/**
 * GET /api/polymarket/sync-stats
 * Returns connection status, credentials flag, and counts for dashboard widgets.
 * tradableMarketsCount = not closed and (endDate null or endDate within last 30 days).
 */
export async function GET() {
  try {
    const tradableCutoff = new Date(Date.now() - TRADABLE_END_DATE_DAYS * 24 * 60 * 60 * 1000);
    const [
      connection,
      credentialsExist,
      credentialRow,
      marketsCount,
      activeMarketsCount,
      closedMarketsCount,
      tradableMarketsCount,
      ordersCount,
      fillsCount,
      positionsCount,
    ] = await Promise.all([
      prisma.connectedWallet.findFirst({ orderBy: { updatedAt: "desc" } }),
      hasStoredCredentials(),
      prisma.polymarketApiCredential.findFirst({
        orderBy: { updatedAt: "desc" },
        select: { lastValidatedAt: true },
      }),
      prisma.syncedMarket.count(),
      prisma.syncedMarket.count({ where: { status: "active" } }),
      prisma.syncedMarket.count({ where: { status: "closed" } }),
      prisma.syncedMarket.count({
        where: {
          status: { not: "closed" },
          OR: [{ endDate: null }, { endDate: { gte: tradableCutoff } }],
        },
      }),
      prisma.userOrder.count(),
      prisma.userFill.count(),
      prisma.userPosition.count(),
    ]);

    let credentialsValidated = false;
    if (credentialsExist) {
      const { credential: creds } = await getStoredCredentials();
      if (creds) {
        const result = await validateCredentialsWithClob(
          {
            apiKey: creds.apiKey,
            secret: creds.secret,
            passphrase: creds.passphrase,
            funderAddress: creds.funderAddress,
            polyAddress: creds.polyAddress,
          },
          creds.signatureType
        );
        credentialsValidated = result.ok;
      }
    }

    return NextResponse.json({
      walletConnectionExists: Boolean(connection),
      credentialsInitialized: credentialsExist,
      credentialsExist,
      credentialsValidated,
      credentialsLastValidatedAt: credentialRow?.lastValidatedAt ?? null,
      credentialEncryptionConfigured: isCredentialEncryptionConfigured(),
      signatureType: connection?.signatureType ?? null,
      funderAddressSaved: Boolean(connection?.funderAddress?.trim()),
      syncedMarketsCount: marketsCount,
      activeMarketsCount,
      closedMarketsCount,
      tradableMarketsCount,
      syncedOrdersCount: ordersCount,
      syncedFillsCount: fillsCount,
      syncedPositionsCount: positionsCount,
    });
  } catch (error) {
    console.error("[GET /api/polymarket/sync-stats]", error);
    return NextResponse.json(
      { error: "Failed to get sync stats" },
      { status: 500 }
    );
  }
}
