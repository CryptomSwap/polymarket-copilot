/**
 * Runtime telemetry hooks for the streaming execution engine.
 * Must not block the hot path; downstream persistence/analytics remain asynchronous.
 */

export interface RuntimeTelemetryEvent {
  name: string;
  at: Date;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: Record<string, any>;
}

export interface RuntimeTelemetry {
  emit(event: RuntimeTelemetryEvent): void;
}

/**
 * Minimal telemetry stub.
 * TODO: Connect to existing execution telemetry and analytics sinks.
 */
export class NoopRuntimeTelemetry implements RuntimeTelemetry {
  emit(event: RuntimeTelemetryEvent): void {
    void event;
  }
}

