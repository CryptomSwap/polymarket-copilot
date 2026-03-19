export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const VALID: LogLevel[] = ["debug", "info", "warn", "error"];

export function getLogLevelFromEnv(defaultLevel: LogLevel = "info"): LogLevel {
  const raw = process.env.LOG_LEVEL;
  if (!raw) return defaultLevel;
  const v = raw.trim().toLowerCase();
  if (VALID.includes(v as LogLevel)) return v as LogLevel;
  return defaultLevel;
}

export function shouldEmitLog(level: LogLevel, threshold: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[threshold];
}

export function consoleMethodForLevel(level: LogLevel): keyof Console {
  switch (level) {
    case "debug":
      return "debug";
    case "info":
      return "info";
    case "warn":
      return "warn";
    case "error":
      return "error";
  }
}

