import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  connectionPayloadSchema,
  connectionResponseSchema,
} from "@/lib/polymarket/connection-schema";

function classifyConnectionSaveFailure(error: unknown): {
  code:
    | "missing_env"
    | "db_connect_failure"
    | "db_write_failure"
    | "schema_validation_failure"
    | "duplicate_conflict"
    | "unexpected_failure";
  hint?: string;
} {
  const msg = error instanceof Error ? error.message : String(error);

  if (/CREDENTIAL_ENCRYPTION_KEY/i.test(msg)) {
    return { code: "missing_env", hint: "CREDENTIAL_ENCRYPTION_KEY is missing/invalid." };
  }

  if (/Can't reach database server|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(msg)) {
    return {
      code: "db_connect_failure",
      hint: "Prisma couldn't reach the database. Check DATABASE_URL and Postgres availability.",
    };
  }

  if (/Unknown column|does not exist|undefined column|no such column|relation .* does not exist/i.test(msg)) {
    return { code: "schema_validation_failure", hint: "DB schema mismatch with Prisma models/migrations." };
  }

  if (typeof (error as any)?.code === "string" && (error as any)?.code === "P2002") {
    return { code: "duplicate_conflict", hint: "Uniqueness constraint failed while saving connection." };
  }

  return { code: "db_write_failure", hint: "Database write failed while saving connection." };
}

function toResponse(row: {
  id: string;
  eoaAddress: string;
  funderAddress: string;
  signatureType: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return connectionResponseSchema.parse({
    id: row.id,
    eoaAddress: row.eoaAddress,
    funderAddress: row.funderAddress,
    signatureType: row.signatureType,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export async function GET() {
  try {
    const connection = await prisma.connectedWallet.findFirst({
      orderBy: { updatedAt: "desc" },
    });
    if (!connection) {
      return NextResponse.json({ connection: null });
    }
    return NextResponse.json({
      connection: toResponse(connection),
    });
  } catch (error) {
    console.error("[GET /api/polymarket/connection]", error);
    return NextResponse.json(
      { error: "Failed to fetch connection" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = connectionPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const { eoaAddress, funderAddress, signatureType } = parsed.data;
    const normalizedEoa = eoaAddress.toLowerCase();
    const normalizedFunder = funderAddress.toLowerCase();

    const existing = await prisma.connectedWallet.findFirst({
      orderBy: { updatedAt: "desc" },
    });

    let connection;
    if (existing) {
      connection = await prisma.connectedWallet.update({
        where: { id: existing.id },
        data: {
          eoaAddress: normalizedEoa,
          funderAddress: normalizedFunder,
          signatureType,
        },
      });
    } else {
      connection = await prisma.connectedWallet.create({
        data: {
          eoaAddress: normalizedEoa,
          funderAddress: normalizedFunder,
          signatureType,
        },
      });
    }

    return NextResponse.json({
      connection: toResponse(connection),
    });
  } catch (error) {
    const classification = classifyConnectionSaveFailure(error);

    // Log the real exception server-side, but return only a safe category to the client.
    console.error("[POST /api/polymarket/connection]", {
      classification,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      error,
    });

    return NextResponse.json(
      {
        error: "Failed to save connection",
        code: classification.code,
        hint: classification.hint,
      },
      { status: 500 }
    );
  }
}
