
/**
 * Order Exchange Adapter: normalized interface for submit/cancel and health.
 * Hides raw CLOB/exchange details; live Polymarket implementation is stubbed for later.
 */

// ---------- Normalized request/response (no raw exchange types) ----------

export interface SubmitOrderRequest {
  clientOrderId: string;
  funderAddress: string;
  assetId: string;
  marketId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  intentId?: string | null;
}

export interface SubmitOrderResult {
  success: boolean;
  clientOrderId: string;
  /** Set when success and exchange acknowledged. */
  exchangeOrderId?: string | null;
  /** True when exchange explicitly rejected. */
  rejected?: boolean;
  error?: string;
  ackAt?: Date;
  /** True when request timed out or outcome unknown (network/adapter). */
  timeout?: boolean;
  /** True when outcome ambiguous (may have reached exchange; no confirmation). */
  ambiguous?: boolean;
}

export interface CancelOrderRequest {
  /** Our client order id. */
  clientOrderId: string;
  /** Exchange order id if known (for live cancel by exchange id). */
  exchangeOrderId?: string | null;
}

export interface CancelOrderResult {
  success: boolean;
  clientOrderId?: string;
  error?: string;
  canceledAt?: Date;
  /** True when request timed out or outcome unknown. */
  timeout?: boolean;
  /** True when outcome ambiguous (cancel may have been sent; no confirmation). */
  ambiguous?: boolean;
}

export interface AdapterHealth {
  ok: boolean;
  mode: "paper" | "live";
  message?: string;
}

/** Optional: open order row from exchange (normalized). */
export interface OpenOrderRow {
  exchangeOrderId: string;
  assetId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  remainingSize: number;
  updatedAt?: Date;
}

export interface OrderExchangeAdapter {
  /** Submit a single order. Caller applies ack/reject to store from result. */
  submitOrder(request: SubmitOrderRequest): Promise<SubmitOrderResult>;

  /** Cancel one order by client or exchange id. */
  cancelOrder(request: CancelOrderRequest): Promise<CancelOrderResult>;

  /** Cancel multiple orders. Default: sequential cancelOrder. */
  cancelOrders(requests: CancelOrderRequest[]): Promise<CancelOrderResult[]>;

  /** Adapter health/status. */
  getHealth(): AdapterHealth;

  /** Optional: fetch open orders from exchange (e.g. for reconciliation). */
  fetchOpenOrders?(funderAddress: string): Promise<OpenOrderRow[]>;
}

// ---------- Paper / simulated adapter ----------

export interface PaperExchangeAdapterOptions {
  /** Simulated latency in ms before returning ack (0 = no delay). */
  simulateLatencyMs?: number;
  /** Reject a subset of submits (e.g. for testing). Return true to reject. */
  rejectSubmit?: (req: SubmitOrderRequest) => boolean;
  /** Reject a subset of cancels. Return true to reject. */
  rejectCancel?: (req: CancelOrderRequest) => boolean;
  /** Return submit as timeout/ambiguous (for failure-containment tests). */
  submitTimeoutOrAmbiguous?: (req: SubmitOrderRequest) => boolean;
  /** Return cancel as timeout/ambiguous (for failure-containment tests). */
  cancelTimeoutOrAmbiguous?: (req: CancelOrderRequest) => boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Paper adapter: deterministic mock acks, no live exchange.
 * Supports optional latency simulation and controlled reject for testing.
 */
export class PaperExchangeAdapter implements OrderExchangeAdapter {
  private readonly options: PaperExchangeAdapterOptions;
  private readonly exchangeIdPrefix = "paper_";

  constructor(options: PaperExchangeAdapterOptions = {}) {
    this.options = options;
  }

  async submitOrder(request: SubmitOrderRequest): Promise<SubmitOrderResult> {
    const { simulateLatencyMs = 0, rejectSubmit, submitTimeoutOrAmbiguous } = this.options;
    if (simulateLatencyMs > 0) await sleep(simulateLatencyMs);

    if (submitTimeoutOrAmbiguous?.(request)) {
      return {
        success: false,
        clientOrderId: request.clientOrderId,
        error: "paper_timeout_or_ambiguous",
        timeout: true,
        ambiguous: true,
      };
    }

    if (rejectSubmit?.(request)) {
      return {
        success: false,
        clientOrderId: request.clientOrderId,
        rejected: true,
        error: "paper_rejected",
        ackAt: new Date(),
      };
    }

    const exchangeOrderId = `${this.exchangeIdPrefix}${request.clientOrderId}`;
    return {
      success: true,
      clientOrderId: request.clientOrderId,
      exchangeOrderId,
      ackAt: new Date(),
    };
  }

  async cancelOrder(request: CancelOrderRequest): Promise<CancelOrderResult> {
    const { simulateLatencyMs = 0, rejectCancel, cancelTimeoutOrAmbiguous } = this.options;
    if (simulateLatencyMs > 0) await sleep(simulateLatencyMs);

    if (cancelTimeoutOrAmbiguous?.(request)) {
      return {
        success: false,
        clientOrderId: request.clientOrderId,
        error: "paper_cancel_timeout_or_ambiguous",
        timeout: true,
        ambiguous: true,
      };
    }

    if (rejectCancel?.(request)) {
      return {
        success: false,
        clientOrderId: request.clientOrderId,
        error: "paper_cancel_rejected",
      };
    }

    return {
      success: true,
      clientOrderId: request.clientOrderId,
      canceledAt: new Date(),
    };
  }

  async cancelOrders(requests: CancelOrderRequest[]): Promise<CancelOrderResult[]> {
    const results: CancelOrderResult[] = [];
    for (const req of requests) {
      results.push(await this.cancelOrder(req));
    }
    return results;
  }

  getHealth(): AdapterHealth {
    return { ok: true, mode: "paper", message: "Paper adapter; no live exchange." };
  }
}

// ---------- No-op adapter (legacy; does not update store) ----------

/**
 * No-op adapter: execute() does nothing and returns empty results.
 * Use when OrderManager applies orders directly to the store (e.g. current PaperOrderManager flow).
 */
export class NoopOrderExchangeAdapter implements OrderExchangeAdapter {
  async submitOrder(request: SubmitOrderRequest): Promise<SubmitOrderResult> {
    void request;
    return {
      success: true,
      clientOrderId: (request as SubmitOrderRequest).clientOrderId,
      exchangeOrderId: null,
      ackAt: new Date(),
    };
  }

  async cancelOrder(_request: CancelOrderRequest): Promise<CancelOrderResult> {
    return { success: true, canceledAt: new Date() };
  }

  async cancelOrders(requests: CancelOrderRequest[]): Promise<CancelOrderResult[]> {
    return Promise.all(requests.map((r) => this.cancelOrder(r)));
  }

  getHealth(): AdapterHealth {
    return { ok: true, mode: "paper", message: "No-op adapter." };
  }

}

// ---------- Live adapter (stub for future Polymarket CLOB) ----------

/**
 * Stub for live Polymarket CLOB adapter. Do not use for real orders yet.
 * Implement submitOrder/cancelOrder via createAndPostOrder / cancelOrder when enabling live.
 */
export class LivePolymarketAdapterStub implements OrderExchangeAdapter {
  getHealth(): AdapterHealth {
    return {
      ok: false,
      mode: "live",
      message: "Live adapter not implemented; use paper adapter.",
    };
  }

  async submitOrder(request: SubmitOrderRequest): Promise<SubmitOrderResult> {
    void request;
    return {
      success: false,
      clientOrderId: request.clientOrderId,
      rejected: true,
      error: "Live adapter not implemented. Use paper adapter.",
      ackAt: new Date(),
    };
  }

  async cancelOrder(request: CancelOrderRequest): Promise<CancelOrderResult> {
    void request;
    return {
      success: false,
      clientOrderId: request.clientOrderId,
      error: "Live adapter not implemented. Use paper adapter.",
    };
  }

  async cancelOrders(requests: CancelOrderRequest[]): Promise<CancelOrderResult[]> {
    return Promise.all(requests.map((r) => this.cancelOrder(r)));
  }

}
