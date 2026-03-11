/**
 * Drift detection: compare local vs remote state and persist DriftAlert when mismatch.
 * Alert types: local_open_remote_cancelled_filled, remote_fill_no_local_order,
 * unexpected_remaining_size, position_size_mismatch, stale_websocket_no_heartbeat,
 * stale_decision_after_major_move.
 * Monitoring only; no autonomous trading or exits.
 */

import { prisma } from "@/lib/db";

function parseNum(s: string | null | undefined): number {
  if (s == null || s === "") return 0;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : 0;
}

export type DriftAlertType =
  | "local_open_remote_cancelled_filled"
  | "remote_fill_no_local_order"
  | "unexpected_remaining_size"
  | "position_size_mismatch"
  | "stale_websocket_no_heartbeat"
  | "stale_decision_after_major_move";

export type DriftSeverity = "info" | "warning" | "critical";

export async function createDriftAlert(params: {
  funderAddress: string;
  alertType: DriftAlertType;
  severity: DriftSeverity;
  message: string;
  detailsJson?: string | null;
  polymarketOrderId?: string | null;
  assetId?: string | null;
  marketId?: string | null;
}): Promise<void> {
  const funder = params.funderAddress.toLowerCase();
  try {
    await prisma.driftAlert.create({
      data: {
        funderAddress: funder,
        alertType: params.alertType,
        severity: params.severity,
        message: params.message,
        detailsJson: params.detailsJson ?? undefined,
        polymarketOrderId: params.polymarketOrderId ?? undefined,
        assetId: params.assetId ?? undefined,
        marketId: params.marketId ?? undefined,
      },
    });
  } catch (e) {
    console.error("[live/drift] createDriftAlert failed", e);
  }
}

/**
 * Check for local open order vs remote cancelled/filled; create alert if mismatch.
 */
export async function checkLocalOpenVsRemote(
  funderAddress: string,
  polymarketOrderId: string,
  remoteStatus: string
): Promise<void> {
  const local = await prisma.executedOrder.findFirst({
    where: { funderAddress: funderAddress.toLowerCase(), polymarketOrderId },
  });
  if (!local) return;
  const localStatus = (local.status ?? "").toLowerCase();
  const remote = remoteStatus.toLowerCase();
  if ((localStatus === "submitted" || localStatus === "pending" || localStatus === "open") && (remote === "cancelled" || remote === "filled" || remote === "matched")) {
    await createDriftAlert({
      funderAddress,
      alertType: "local_open_remote_cancelled_filled",
      severity: "warning",
      message: `Local order ${polymarketOrderId} is open but remote status is ${remote}. Run reconcile.`,
      detailsJson: JSON.stringify({ localStatus, remoteStatus }),
      polymarketOrderId,
      assetId: local.assetId,
      marketId: local.marketId,
    });
  }
}

/**
 * Check for remote fill with no matching local ExecutedOrder; create alert.
 */
export async function checkRemoteFillNoLocalOrder(
  funderAddress: string,
  orderId: string,
  assetId?: string,
  marketId?: string
): Promise<void> {
  const local = await prisma.executedOrder.findFirst({
    where: { funderAddress: funderAddress.toLowerCase(), polymarketOrderId: orderId },
  });
  if (!local) {
    await createDriftAlert({
      funderAddress,
      alertType: "remote_fill_no_local_order",
      severity: "info",
      message: `Remote order/fill ${orderId} has no matching local ExecutedOrder.`,
      detailsJson: JSON.stringify({ orderId }),
      polymarketOrderId: orderId,
      assetId: assetId ?? undefined,
      marketId: marketId ?? undefined,
    });
  }
}

/**
 * Check executed order has unexpected remaining size (e.g. reconciliation shows mismatch).
 */
export async function checkUnexpectedRemainingSize(
  funderAddress: string,
  polymarketOrderId: string,
  expectedRemaining: number,
  actualRemaining: number
): Promise<void> {
  if (Math.abs(expectedRemaining - actualRemaining) < 1e-6) return;
  const exec = await prisma.executedOrder.findFirst({
    where: { funderAddress: funderAddress.toLowerCase(), polymarketOrderId },
  });
  await createDriftAlert({
    funderAddress,
    alertType: "unexpected_remaining_size",
    severity: "warning",
    message: `Order ${polymarketOrderId} remaining size mismatch: expected ${expectedRemaining}, got ${actualRemaining}.`,
    detailsJson: JSON.stringify({ expectedRemaining, actualRemaining }),
    polymarketOrderId,
    assetId: exec?.assetId ?? undefined,
    marketId: exec?.marketId ?? undefined,
  });
}

/**
 * Check position size mismatch (derived vs synced).
 */
export async function checkPositionSizeMismatch(
  funderAddress: string,
  assetId: string,
  marketId: string,
  derivedSize: number,
  syncedSize: number
): Promise<void> {
  if (Math.abs(derivedSize - syncedSize) < 1e-6) return;
  await createDriftAlert({
    funderAddress,
    alertType: "position_size_mismatch",
    severity: "warning",
    message: `Position ${assetId} size mismatch: derived ${derivedSize}, synced ${syncedSize}.`,
    detailsJson: JSON.stringify({ derivedSize, syncedSize }),
    assetId,
    marketId,
  });
}

/**
 * Create alert for stale websocket / no heartbeat.
 */
export async function alertStaleWebsocket(
  funderAddress: string,
  channel: string,
  lastHeartbeatAt: Date | null
): Promise<void> {
  await createDriftAlert({
    funderAddress,
    alertType: "stale_websocket_no_heartbeat",
    severity: "critical",
    message: `WebSocket ${channel} has no recent heartbeat. Last: ${lastHeartbeatAt?.toISOString() ?? "never"}.`,
    detailsJson: JSON.stringify({ channel, lastHeartbeatAt: lastHeartbeatAt?.toISOString() ?? null }),
  });
}

/**
 * Create alert for stale recommendation/decision after major market move.
 */
export async function alertStaleDecisionAfterMove(
  funderAddress: string,
  marketId: string,
  assetId: string,
  movePct: number
): Promise<void> {
  await createDriftAlert({
    funderAddress,
    alertType: "stale_decision_after_major_move",
    severity: "warning",
    message: `Market ${marketId} moved ${(movePct * 100).toFixed(1)}%; consider refreshing decisions.`,
    detailsJson: JSON.stringify({ marketId, assetId, movePct }),
    marketId,
    assetId,
  });
}
