import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  connectionPayloadSchema,
  connectionResponseSchema,
} from "@/lib/polymarket/connection-schema";

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
    console.error("[POST /api/polymarket/connection]", error);
    return NextResponse.json(
      { error: "Failed to save connection" },
      { status: 500 }
    );
  }
}
