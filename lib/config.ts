import { z } from "zod";

const envSchema = z.object({
  POLYMARKET_HOST: z.string().url().default("https://polymarket.com"),
  POLYMARKET_CHAIN_ID: z.coerce.number().int().positive().default(137),
});

function loadConfig() {
  const parsed = envSchema.safeParse({
    POLYMARKET_HOST: process.env.POLYMARKET_HOST,
    POLYMARKET_CHAIN_ID: process.env.POLYMARKET_CHAIN_ID,
  });

  if (!parsed.success) {
    console.warn(
      "[config] Invalid env, using defaults:",
      parsed.error.flatten().fieldErrors
    );
    return envSchema.parse({
      POLYMARKET_HOST: "https://polymarket.com",
      POLYMARKET_CHAIN_ID: 137,
    });
  }

  return parsed.data;
}

export const config = loadConfig();

export const POLYMARKET_HOST = config.POLYMARKET_HOST;
export const POLYMARKET_CHAIN_ID = config.POLYMARKET_CHAIN_ID;
