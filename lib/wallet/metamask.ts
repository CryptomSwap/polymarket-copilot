/**
 * MetaMask / EIP-1193 wallet connection for Next.js (client-only).
 * Use from client components or useEffect only.
 */

export interface MetaMaskProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

declare global {
  interface Window {
    ethereum?: MetaMaskProvider;
  }
}

const ETH_REQUEST_ACCOUNTS = "eth_requestAccounts";

/**
 * Check if MetaMask (or compatible) provider is available.
 */
export function hasMetaMask(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.ethereum);
}

/**
 * Request account access and return the first EOA address.
 * Throws if user denies or provider is missing.
 */
export async function connectMetaMask(): Promise<string> {
  if (typeof window === "undefined") {
    throw new Error("Wallet connect is only available in the browser");
  }
  const provider = window.ethereum;
  if (!provider) {
    throw new Error("MetaMask (or compatible wallet) not detected. Install the extension and refresh.");
  }
  const accounts = (await provider.request({
    method: ETH_REQUEST_ACCOUNTS,
    params: [],
  })) as string[];
  if (!accounts?.length || !accounts[0]) {
    throw new Error("No account returned. Unlock your wallet and try again.");
  }
  return normalizeAddress(accounts[0]);
}

/**
 * Normalize Ethereum address to lowercase with 0x prefix.
 */
export function normalizeAddress(address: string): string {
  const a = address.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(a)) {
    throw new Error("Invalid Ethereum address");
  }
  return a.toLowerCase();
}

/**
 * Shorten address for display.
 */
export function shortenAddress(address: string, chars = 6): string {
  const normalized = address.startsWith("0x") ? address : `0x${address}`;
  if (normalized.length < chars * 2 + 2) return normalized;
  return `${normalized.slice(0, chars + 2)}…${normalized.slice(-chars)}`;
}
