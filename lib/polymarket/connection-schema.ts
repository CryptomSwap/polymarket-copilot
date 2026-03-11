import { z } from "zod";

const ethAddressRegex = /^0x[a-fA-F0-9]{40}$/;

export const connectionPayloadSchema = z.object({
  eoaAddress: z
    .string()
    .min(1, "EOA address is required")
    .regex(ethAddressRegex, "Invalid Ethereum address"),
  funderAddress: z
    .string()
    .min(1, "Funder address is required")
    .regex(ethAddressRegex, "Invalid Ethereum address"),
  signatureType: z.coerce.number().int().min(1).max(255).default(2),
});

export type ConnectionPayload = z.infer<typeof connectionPayloadSchema>;

export const connectionResponseSchema = z.object({
  id: z.string(),
  eoaAddress: z.string(),
  funderAddress: z.string(),
  signatureType: z.number(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ConnectionResponse = z.infer<typeof connectionResponseSchema>;

/** Request body for init-credentials (MetaMask L1 flow). */
export const initCredentialsPayloadSchema = z.object({
  polygonAddress: z
    .string()
    .min(1, "Polygon address is required")
    .regex(ethAddressRegex, "Invalid Ethereum address"),
  signature: z.string().min(1, "Signature is required"),
  timestamp: z.coerce.number().int().positive(),
  nonce: z.coerce.number().int().min(0),
  funderAddress: z
    .string()
    .min(1, "Funder address is required")
    .regex(ethAddressRegex, "Invalid Ethereum address"),
  signatureType: z.coerce.number().int().min(0).max(255),
});

export type InitCredentialsPayload = z.infer<typeof initCredentialsPayloadSchema>;
