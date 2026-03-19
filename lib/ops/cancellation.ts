export const CANCEL_ERROR_CODES = {
  TIMEOUT: "timeout",
  ABORTED: "aborted",
} as const;

export type CancelErrorCode = (typeof CANCEL_ERROR_CODES)[keyof typeof CANCEL_ERROR_CODES];

export class CancelError extends Error {
  readonly code: CancelErrorCode;
  readonly label: string;
  readonly timeoutMs?: number;
  constructor(params: { code: CancelErrorCode; label: string; message: string; timeoutMs?: number }) {
    super(params.message);
    this.name = "CancelError";
    this.code = params.code;
    this.label = params.label;
    this.timeoutMs = params.timeoutMs;
  }
}

function isAbortLike(err: unknown): boolean {
  const e = err as { name?: string; code?: string; message?: string } | null;
  const n = typeof e?.name === "string" ? e.name : "";
  const c = typeof e?.code === "string" ? e.code : "";
  const m = typeof e?.message === "string" ? e.message : "";
  return n === "AbortError" || c === "ABORT_ERR" || /aborted/i.test(m);
}

export function throwIfAborted(signal: AbortSignal | undefined, label: string): void {
  if (!signal) return;
  if (signal.aborted) {
    throw new CancelError({
      code: CANCEL_ERROR_CODES.ABORTED,
      label,
      message: `aborted:${label}`,
    });
  }
}

/**
 * Create a child AbortController tied to optional parent signal + an optional timeout.
 * Guarantees cleanup of timer and event listener.
 */
export function createAbortScope(params: {
  label: string;
  parentSignal?: AbortSignal;
  timeoutMs?: number;
}): {
  controller: AbortController;
  signal: AbortSignal;
  cleanup: () => void;
  timeoutAtMs: number | null;
} {
  const controller = new AbortController();
  const { parentSignal } = params;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let parentListener: (() => void) | null = null;

  const timeoutAtMs = typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? Date.now() + params.timeoutMs : null;

  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort();
    } else {
      parentListener = () => controller.abort();
      parentSignal.addEventListener("abort", parentListener, { once: true });
    }
  }

  if (typeof params.timeoutMs === "number" && params.timeoutMs > 0) {
    timer = setTimeout(() => {
      controller.abort();
    }, params.timeoutMs);
  }

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (parentSignal && parentListener) {
      parentSignal.removeEventListener("abort", parentListener);
      parentListener = null;
    }
  };

  return { controller, signal: controller.signal, cleanup, timeoutAtMs };
}

/**
 * Run async work with an AbortController scope.
 * If it aborts due to timeout, throws CancelError(timeout). If it aborts due to parent, throws CancelError(aborted).
 * If work throws an AbortError, it is rethrown as CancelError(aborted) for consistent classification.
 */
export async function runWithAbortScope<T>(params: {
  label: string;
  parentSignal?: AbortSignal;
  timeoutMs?: number;
  fn: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const { controller, signal, cleanup } = createAbortScope({
    label: params.label,
    parentSignal: params.parentSignal,
    timeoutMs: params.timeoutMs,
  });

  try {
    const res = await params.fn(signal);
    return res;
  } catch (e) {
    if (isAbortLike(e) || signal.aborted) {
      const code =
        typeof params.timeoutMs === "number" && params.timeoutMs > 0
          ? CANCEL_ERROR_CODES.TIMEOUT
          : CANCEL_ERROR_CODES.ABORTED;
      // Distinguish parent abort vs timeout: if parent aborted, call it aborted.
      const parentAborted = params.parentSignal?.aborted === true;
      if (parentAborted) {
        throw new CancelError({ code: CANCEL_ERROR_CODES.ABORTED, label: params.label, message: `aborted:${params.label}` });
      }
      if (typeof params.timeoutMs === "number" && params.timeoutMs > 0) {
        throw new CancelError({
          code: CANCEL_ERROR_CODES.TIMEOUT,
          label: params.label,
          timeoutMs: params.timeoutMs,
          message: `timeout:${params.label}:${params.timeoutMs}ms`,
        });
      }
      throw new CancelError({ code: CANCEL_ERROR_CODES.ABORTED, label: params.label, message: `aborted:${params.label}` });
    }
    throw e;
  } finally {
    cleanup();
  }
}

