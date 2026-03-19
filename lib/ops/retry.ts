import { CancelError, CANCEL_ERROR_CODES, throwIfAborted } from "./cancellation";

export type RetryDecision =
  | { retry: true; backoffMs: number }
  | { retry: false; reason?: string };

export async function retryWithBackoff<T>(params: {
  label: string;
  signal?: AbortSignal;
  retries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** When true, per-attempt timeouts are retryable until budget is exhausted. */
  retryOnTimeout?: boolean;
  /** Decide whether to retry given error + attempt number (0-based). */
  decide?: (err: unknown, attempt: number) => RetryDecision;
  fn: (attempt: number) => Promise<T>;
}): Promise<{ value: T; attempts: number }> {
  const retries = Math.max(0, Math.floor(params.retries));
  const base = Math.max(0, Math.floor(params.baseDelayMs ?? 200));
  const max = Math.max(base, Math.floor(params.maxDelayMs ?? 2000));

  const sleep = async (ms: number) => {
    if (!ms) return;
    const signal = params.signal;
    if (!signal) {
      await new Promise((r) => setTimeout(r, ms));
      return;
    }
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new CancelError({ code: CANCEL_ERROR_CODES.ABORTED, label: params.label, message: `aborted:${params.label}` }));
      const t = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(new CancelError({ code: CANCEL_ERROR_CODES.ABORTED, label: params.label, message: `aborted:${params.label}` }));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    throwIfAborted(params.signal, params.label);
    try {
      const value = await params.fn(attempt);
      return { value, attempts: attempt + 1 };
    } catch (e) {
      lastErr = e;
      if (e instanceof CancelError) {
        // Parent abort: stop immediately.
        if (e.code === CANCEL_ERROR_CODES.ABORTED) throw e;
        // Per-attempt timeout: retry only when allowed.
        if (e.code === CANCEL_ERROR_CODES.TIMEOUT && !params.retryOnTimeout) throw e;
      }
      const decision =
        params.decide?.(e, attempt) ??
        ({
          retry: attempt < retries,
          backoffMs: Math.min(max, base * Math.pow(2, attempt)),
        } as RetryDecision);

      if (!decision.retry || attempt >= retries) {
        throw e;
      }
      await sleep(decision.backoffMs);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`retry_failed:${params.label}`);
}

