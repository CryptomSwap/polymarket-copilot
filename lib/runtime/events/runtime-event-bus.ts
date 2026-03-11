import type { RuntimeEvent, RuntimeEventType, RuntimeEventTypeOrWildcard } from "./runtime-events";

/**
 * Internal typed event bus for runtime coordination.
 *
 * BOUNDARIES:
 * - Producers: Market State Engine, Bot Runtime, Order Manager, Position updater, Risk Engine, Health checker.
 * - Consumers: Any runtime module that subscribes by event type (or wildcard).
 * - The bus is in-memory only; it does not persist events. Persistence is out of band.
 */

export type RuntimeEventHandler<E extends RuntimeEvent = RuntimeEvent> = (event: E) => void | Promise<void>;

export interface RuntimeEventBusSubscribeOptions {
  /** If true, handler may be invoked concurrently with others; default is serial dispatch per type. */
  concurrent?: boolean;
}

export interface RuntimeEventBus {
  /** Publish a single event. All matching subscribers are notified; errors in one handler do not affect others. */
  publish<E extends RuntimeEvent>(event: E): void;
  /**
   * Subscribe to a specific event type (or wildcard "*" for all events).
   * Returns an unsubscribe function.
   */
  subscribe<TType extends RuntimeEventTypeOrWildcard>(
    type: TType,
    handler: TType extends "*"
      ? RuntimeEventHandler<RuntimeEvent>
      : RuntimeEventHandler<Extract<RuntimeEvent, { type: TType }>>,
    options?: RuntimeEventBusSubscribeOptions
  ): () => void;
}

type HandlerEntry = {
  handler: RuntimeEventHandler;
  concurrent?: boolean;
};

/**
 * Lightweight in-memory event bus with:
 * - Typed subscribe(type, handler) and publish(event)
 * - Optional wildcard ("*") subscriber for all events
 * - Defensive error isolation: one handler failure does not prevent others from running
 */
export class InMemoryRuntimeEventBus implements RuntimeEventBus {
  /** Handlers per event type. "*" holds wildcard handlers. */
  private readonly byType = new Map<RuntimeEventType | "*", Set<HandlerEntry>>();

  /** Symbol used only for wildcard key to avoid string collision with real event types. */
  private static readonly WILDCARD_KEY = "*" as const;

  publish<E extends RuntimeEvent>(event: E): void {
    const type = event.type as RuntimeEventType;
    const run = (entry: HandlerEntry): void => {
      try {
        const result = entry.handler(event as RuntimeEvent);
        if (result && typeof (result as Promise<unknown>).then === "function") {
          (result as Promise<void>).catch((err) => {
            // Isolate: log but do not rethrow; other handlers still run.
            console.error("[runtime-event-bus] handler promise rejected", {
              type: event.type,
              id: event.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      } catch (err) {
        // Isolate: one handler cannot crash others.
        console.error("[runtime-event-bus] handler threw", {
          type: event.type,
          id: event.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    // 1) Notify type-specific subscribers
    const typeHandlers = this.byType.get(type);
    if (typeHandlers?.size) {
      Array.from(typeHandlers).forEach((entry) => run(entry));
    }

    // 2) Notify wildcard subscribers
    const wildcardHandlers = this.byType.get(InMemoryRuntimeEventBus.WILDCARD_KEY);
    if (wildcardHandlers?.size) {
      Array.from(wildcardHandlers).forEach((entry) => run(entry));
    }
  }

  subscribe<TType extends RuntimeEventTypeOrWildcard>(
    type: TType,
    handler: TType extends "*"
      ? RuntimeEventHandler<RuntimeEvent>
      : RuntimeEventHandler<Extract<RuntimeEvent, { type: TType }>>,
    options?: RuntimeEventBusSubscribeOptions
  ): () => void {
    const key = type === "*" ? InMemoryRuntimeEventBus.WILDCARD_KEY : (type as RuntimeEventType);
    const entry: HandlerEntry = { handler: handler as RuntimeEventHandler, concurrent: options?.concurrent };
    let set = this.byType.get(key);
    if (!set) {
      set = new Set();
      this.byType.set(key, set);
    }
    set.add(entry);

    return () => {
      const current = this.byType.get(key);
      if (!current) return;
      current.delete(entry);
      if (current.size === 0) {
        this.byType.delete(key);
      }
    };
  }
}
