import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isValidSignatureType } from "@/lib/polymarket/auth";
import { encrypt } from "@/lib/crypto";
import { createOrDeriveApiKeyWithL1Headers } from "@/lib/polymarket/l1-auth";
import { initCredentialsPayloadSchema } from "@/lib/polymarket/connection-schema";
import { validateCredentialEncryptionConfig } from "@/lib/polymarket/credentials-env";
import { validateCredentialsWithClob } from "@/lib/polymarket/l2-readonly";
import { clearCredentialsForConnection } from "@/lib/polymarket/auth";

/**
 * POST /api/polymarket/init-credentials
 * MetaMask-based L1 auth: accepts client-signed L1 payload, calls Polymarket create/derive API key,
 * stores apiKey + encrypted secret/passphrase. No POLYMARKET_SIGNER_PRIVATE_KEY required.
 * Never returns secret or passphrase.
 * TODO: For server-side authenticated trading, use getStoredCredentials() + signer when needed.
 */
export async function POST(request: NextRequest) {
  try {
    let body: unknown = {};
    try {
      const text = await request.text();
      if (text?.trim()) body = JSON.parse(text);
    } catch {
      body = {};
    }
    const parsed = initCredentialsPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { polygonAddress, signature, timestamp, nonce, funderAddress, signatureType } = parsed.data;

    if (!isValidSignatureType(signatureType)) {
      return NextResponse.json(
        { error: "Invalid signature type. Must be 0 (EOA), 1 (Magic), or 2 (proxy)." },
        { status: 400 }
      );
    }

    const connection = await prisma.connectedWallet.findFirst({
      orderBy: { updatedAt: "desc" },
    });

    if (!connection) {
      return NextResponse.json(
        { error: "No wallet connection. Save EOA and funder in Settings → Polymarket first." },
        { status: 400 }
      );
    }

    const eoaNorm = polygonAddress.toLowerCase();
    const funderNorm = funderAddress.toLowerCase();

    if (connection.eoaAddress.toLowerCase() !== eoaNorm || connection.funderAddress.toLowerCase() !== funderNorm) {
      return NextResponse.json(
        { error: "Polygon address and funder must match the saved connection. Save connection first." },
        { status: 400 }
      );
    }

    let credentials: { apiKey: string; secret: string; passphrase: string };
    try {
      credentials = await createOrDeriveApiKeyWithL1Headers({
        polygonAddress: eoaNorm,
        signature,
        timestamp,
        nonce,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Polymarket auth failed";
      console.error("[init-credentials] createOrDerive failed:", err);
      return NextResponse.json(
        { error: `Failed to create or derive API credentials: ${message}` },
        { status: 502 }
      );
    }

    const encryptionConfig = validateCredentialEncryptionConfig();
    if (!encryptionConfig.ok) {
      return NextResponse.json(
        { error: encryptionConfig.error, hint: encryptionConfig.hint },
        { status: 503 }
      );
    }

    const oldCredsRemoved = await clearCredentialsForConnection(connection.id);

    const validation = await validateCredentialsWithClob(
      {
        apiKey: credentials.apiKey,
        secret: credentials.secret,
        passphrase: credentials.passphrase,
        funderAddress: funderNorm,
        polyAddress: eoaNorm,
      },
      signatureType
    );

    const diagnostics = {
      eoaAddressUsed: eoaNorm,
      funderAddressUsed: funderNorm,
      signatureTypeUsed: signatureType,
      polyAddressUsed: eoaNorm,
      oldCredsRemoved: oldCredsRemoved > 0,
      validationMethodUsed: validation.ok ? validation.validationMethodUsed : validation.diagnostics?.validationMethodUsed ?? null,
      httpStatus: validation.ok ? 200 : (validation.diagnostics?.httpStatus ?? null),
      errorBody: validation.ok ? undefined : (validation.diagnostics?.errorBody ?? undefined),
    };

    if (!validation.ok) {
      const errorTitle =
        validation.code === "credentials_invalid"
          ? "Credentials invalid"
          : validation.code === "validation_request_malformed"
            ? "Validation request malformed"
            : validation.code === "clob_unavailable"
              ? "CLOB unavailable"
              : "Unexpected validation response";
      return NextResponse.json(
        {
          error: errorTitle,
          details: validation.error,
          code: validation.code,
          hint:
            validation.code === "credentials_invalid"
              ? "Clear credentials and re-initialize; ensure the connected wallet matches Polymarket."
              : validation.code === "validation_request_malformed"
                ? "Validator bug or wrong endpoint; not a credential rejection."
                : validation.code === "clob_unavailable"
                  ? "Retry later."
                  : "Check CLOB connectivity or try again.",
          diagnostics,
        },
        { status: 502 }
      );
    }

    const encryptedSecret = encrypt(credentials.secret);
    const encryptedPassphrase = encrypt(credentials.passphrase);
    const now = new Date();
    await prisma.polymarketApiCredential.upsert({
      where: { connectedWalletId: connection.id },
      create: {
        connectedWalletId: connection.id,
        apiKey: credentials.apiKey,
        encryptedSecret,
        encryptedPassphrase,
        funderAddress: funderNorm,
        signatureType,
        lastValidatedAt: now,
      },
      update: {
        apiKey: credentials.apiKey,
        encryptedSecret,
        encryptedPassphrase,
        funderAddress: funderNorm,
        signatureType,
        lastValidatedAt: now,
      },
    });

    return NextResponse.json({
      success: true,
      message: "Credentials initialized and stored encrypted. Secret and passphrase are never returned.",
      diagnostics,
    });
  } catch (error) {
    console.error("[POST /api/polymarket/init-credentials]", error);
    return NextResponse.json(
      { error: "Failed to initialize credentials" },
      { status: 500 }
    );
  }
}
