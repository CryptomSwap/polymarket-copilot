/**
 * Client-side Polymarket L1 auth: build EIP-712 typed data and sign with MetaMask.
 * Use from browser only (window.ethereum). Never send private key to server.
 */

const CLOB_DOMAIN_NAME = "ClobAuthDomain";
const CLOB_VERSION = "1";
const MSG_TO_SIGN = "This message attests that I control the given wallet";

export const POLYGON_CHAIN_ID = 137;

export interface PolymarketL1SignParams {
  /** EOA address (will be included in message and must match signer) */
  address: string;
  /** Unix timestamp in seconds */
  timestamp: number;
  /** Nonce (typically 0 for create/derive) */
  nonce: number;
  /** Chain ID (default 137 Polygon) */
  chainId?: number;
}

export interface PolymarketL1SignResult {
  signature: string;
  address: string;
  timestamp: number;
  nonce: number;
}

/**
 * EIP-712 domain for Polymarket CLOB auth (matches @polymarket/clob-client).
 */
function getDomain(chainId: number): { name: string; version: string; chainId: number } {
  return {
    name: CLOB_DOMAIN_NAME,
    version: CLOB_VERSION,
    chainId,
  };
}

/**
 * EIP-712 types for ClobAuth (matches SDK).
 */
function getTypes(): Record<string, Array<{ name: string; type: string }>> {
  return {
    ClobAuth: [
      { name: "address", type: "address" },
      { name: "timestamp", type: "string" },
      { name: "nonce", type: "uint256" },
      { name: "message", type: "string" },
    ],
  };
}

/**
 * Build the value (message) to sign. Address must be checksummed or lowercase for consistency.
 */
function getMessage(params: PolymarketL1SignParams): {
  address: string;
  timestamp: string;
  nonce: number;
  message: string;
} {
  return {
    address: params.address.toLowerCase(),
    timestamp: `${params.timestamp}`,
    nonce: params.nonce,
    message: MSG_TO_SIGN,
  };
}

declare global {
  interface Window {
    ethereum?: {
      request(args: {
        method: string;
        params?: unknown[];
      }): Promise<unknown>;
    };
  }
}

/**
 * Sign Polymarket L1 auth message via MetaMask (eth_signTypedData_v4).
 * Must be called from browser with an active wallet.
 */
export async function signPolymarketL1Auth(params: PolymarketL1SignParams): Promise<PolymarketL1SignResult> {
  if (typeof window === "undefined" || !window.ethereum) {
    throw new Error("MetaMask (or compatible wallet) not detected. Use in browser with wallet installed.");
  }

  const chainId = params.chainId ?? POLYGON_CHAIN_ID;
  const domain = getDomain(chainId);
  const types = getTypes();
  const message = getMessage(params);

  const signature = (await window.ethereum.request({
    method: "eth_signTypedData_v4",
    params: [
      params.address,
      JSON.stringify({
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
          ],
          ...types,
        },
        primaryType: "ClobAuth",
        domain: {
          name: domain.name,
          version: domain.version,
          chainId,
        },
        message,
      }),
    ],
  })) as string;

  if (!signature || typeof signature !== "string") {
    throw new Error("Wallet did not return a signature.");
  }

  return {
    signature,
    address: params.address.toLowerCase(),
    timestamp: params.timestamp,
    nonce: params.nonce,
  };
}
