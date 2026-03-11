"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Wallet, CheckCircle2, AlertCircle, Loader2, KeyRound } from "lucide-react";
import { connectMetaMask, hasMetaMask, shortenAddress } from "@/lib/wallet/metamask";
import { signPolymarketL1Auth } from "@/lib/wallet/polymarket-l1-sign";
import { cn } from "@/lib/utils";

const SIGNATURE_TYPES = [
  { value: 1, label: "EOA (1)" },
  { value: 2, label: "Poly Proxy (2)" },
  { value: 3, label: "Other (3)" },
];

interface ConnectionData {
  id: string;
  eoaAddress: string;
  funderAddress: string;
  signatureType: number;
  createdAt: string;
  updatedAt: string;
}

export default function SettingsPolymarketPage() {
  const [eoaAddress, setEoaAddress] = useState("");
  const [funderAddress, setFunderAddress] = useState("");
  const [signatureType, setSignatureType] = useState(2);
  const [savedConnection, setSavedConnection] = useState<ConnectionData | null>(null);
  const [connectLoading, setConnectLoading] = useState(false);
  const [saveLoading, setSaveLoading] = useState(false);
  const [initCredsLoading, setInitCredsLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [walletAvailable, setWalletAvailable] = useState(false);

  const fetchConnection = useCallback(async () => {
    try {
      const res = await fetch("/api/polymarket/connection");
      const data = await res.json();
      if (data.connection) {
        setSavedConnection(data.connection);
        setEoaAddress(data.connection.eoaAddress);
        setFunderAddress(data.connection.funderAddress);
        setSignatureType(data.connection.signatureType);
      }
    } catch {
      setMessage({ type: "error", text: "Failed to load saved connection." });
    }
  }, []);

  useEffect(() => {
    setWalletAvailable(hasMetaMask());
    fetchConnection();
  }, [fetchConnection]);

  const handleConnectMetaMask = async () => {
    setMessage(null);
    setConnectLoading(true);
    try {
      const address = await connectMetaMask();
      setEoaAddress(address);
      setMessage({ type: "success", text: "Wallet connected. Enter funder address and Save." });
    } catch (err) {
      setMessage({
        type: "error",
        text: err instanceof Error ? err.message : "Failed to connect wallet.",
      });
    } finally {
      setConnectLoading(false);
    }
  };

  const handleSaveConnection = async () => {
    if (!eoaAddress.trim() || !funderAddress.trim()) {
      setMessage({ type: "error", text: "Connect MetaMask and enter the Polymarket funder address." });
      return;
    }
    setMessage(null);
    setSaveLoading(true);
    try {
      const res = await fetch("/api/polymarket/connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eoaAddress: eoaAddress.trim().toLowerCase(),
          funderAddress: funderAddress.trim().toLowerCase(),
          signatureType,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        const details = data.details?.fieldErrors
          ? Object.entries(data.details.fieldErrors).flatMap(([k, v]) => (v as string[]).map((e) => `${k}: ${e}`)).join(". ")
          : data.error ?? "Save failed.";
        throw new Error(details);
      }
      setSavedConnection(data.connection);
      setMessage({ type: "success", text: "Connection saved." });
    } catch (err) {
      setMessage({
        type: "error",
        text: err instanceof Error ? err.message : "Failed to save connection.",
      });
    } finally {
      setSaveLoading(false);
    }
  };

  const handleInitializeCredentials = async () => {
    const eoa = eoaAddress.trim().toLowerCase();
    const funder = funderAddress.trim().toLowerCase();
    if (!eoa || !funder) {
      setMessage({ type: "error", text: "Connect MetaMask, enter funder address, and save the connection first." });
      return;
    }
    setMessage(null);
    setInitCredsLoading(true);
    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = 0;
      const { signature, address } = await signPolymarketL1Auth({
        address: eoa,
        timestamp,
        nonce,
      });
      const polygonAddress = typeof address === "string" ? address.trim().toLowerCase() : "";
      const sig = typeof signature === "string" ? signature : "";
      const ts = Number(timestamp);
      const n = Number(nonce);
      const st = Number(signatureType);
      if (!polygonAddress || !sig) {
        setMessage({ type: "error", text: "Signing did not return a valid address or signature." });
        return;
      }
      const timestampNum = Number.isFinite(ts) ? ts : Math.floor(Date.now() / 1000);
      const nonceNum = Number.isFinite(n) && n >= 0 ? n : 0;
      const signatureTypeNum = Number.isFinite(st) && st >= 0 && st <= 255 ? st : 2;

      const payload = {
        polygonAddress,
        signature: sig,
        timestamp: timestampNum,
        nonce: nonceNum,
        funderAddress: funder,
        signatureType: signatureTypeNum,
      };

      console.info("[init-credentials] request payload (sanitized)", {
        polygonAddress: payload.polygonAddress,
        funderAddress: payload.funderAddress,
        signatureType: payload.signatureType,
        timestamp: payload.timestamp,
        nonce: payload.nonce,
        signaturePresent: Boolean(payload.signature?.length),
      });

      const res = await fetch("/api/polymarket/init-credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? data.details ?? "Initialization failed");
      }
      setMessage({ type: "success", text: data.message ?? "API credentials initialized and stored." });
    } catch (err) {
      setMessage({
        type: "error",
        text: err instanceof Error ? err.message : "Failed to initialize credentials.",
      });
    } finally {
      setInitCredsLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-foreground">
          Polymarket settings
        </h2>
        <p className="mt-1 text-muted-foreground">
          Connect your MetaMask EOA and link your Polymarket proxy/funder wallet. This is connection setup only; trading is not enabled yet.
        </p>
      </div>

      {/* Connection status */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            Connection status
          </CardTitle>
          <CardDescription>
            Whether a connection is stored and what it contains
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {savedConnection ? (
            <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-4">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-green-600 dark:text-green-500" />
              <div className="min-w-0 space-y-1 text-sm">
                <p className="font-medium text-foreground">Connection saved</p>
                <p className="text-muted-foreground">
                  EOA: <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{savedConnection.eoaAddress}</code>
                </p>
                <p className="text-muted-foreground">
                  Funder: <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{savedConnection.funderAddress}</code>
                </p>
                <p className="text-muted-foreground">
                  Signature type: {savedConnection.signatureType}
                </p>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-4">
              <AlertCircle className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-500" />
              <div className="min-w-0 text-sm">
                <p className="font-medium text-foreground">No connection saved</p>
                <p className="text-muted-foreground">
                  Connect MetaMask, enter your Polymarket funder address, and save to persist.
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Connect & form */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="h-4 w-4" />
            Wallet connection
          </CardTitle>
          <CardDescription>
            Your MetaMask EOA is the signer; your Polymarket trading wallet may be a proxy/funder and can differ.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label>EOA (MetaMask)</Label>
            <div className="flex gap-2">
              <Input
                readOnly
                placeholder="Connect MetaMask to fill"
                value={eoaAddress}
                className="font-mono text-sm"
              />
              <Button
                type="button"
                variant="outline"
                onClick={handleConnectMetaMask}
                disabled={!walletAvailable || connectLoading}
              >
                {connectLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Connect MetaMask"
                )}
              </Button>
            </div>
            {eoaAddress && (
              <p className="text-xs text-muted-foreground">
                Connected: {shortenAddress(eoaAddress)}
              </p>
            )}
            {!walletAvailable && (
              <p className="text-xs text-amber-600 dark:text-amber-500">
                MetaMask (or compatible wallet) not detected. Install the extension and refresh.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="funder">Polymarket funder / proxy address</Label>
            <Input
              id="funder"
              placeholder="0x..."
              value={funderAddress}
              onChange={(e) => setFunderAddress(e.target.value)}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              The wallet that holds positions and funds on Polymarket; may differ from your EOA.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="signatureType">Signature type</Label>
            <select
              id="signatureType"
              value={signatureType}
              onChange={(e) => setSignatureType(Number(e.target.value))}
              className={cn(
                "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                "disabled:cursor-not-allowed disabled:opacity-50"
              )}
            >
              {SIGNATURE_TYPES.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              Default is 2 (Poly Proxy). Change only if your setup uses a different type.
            </p>
          </div>

          {message && (
            <div
              className={cn(
                "rounded-md border p-3 text-sm",
                message.type === "success"
                  ? "border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950/50 dark:text-green-200"
                  : "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200"
              )}
            >
              {message.text}
            </div>
          )}

          <Button
            type="button"
            onClick={handleSaveConnection}
            disabled={!eoaAddress || !funderAddress || saveLoading}
          >
            {saveLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : (
              "Save connection"
            )}
          </Button>

          <div className="rounded-lg border border-border bg-muted/30 p-4">
            <h4 className="mb-2 flex items-center gap-2 font-medium text-foreground">
              <KeyRound className="h-4 w-4" />
              Initialize API credentials
            </h4>
            <p className="mb-3 text-sm text-muted-foreground">
              Sign with MetaMask to create or derive Polymarket API credentials. They are stored encrypted on the server. Save your connection above first.
            </p>
            <Button
              type="button"
              onClick={handleInitializeCredentials}
              disabled={!eoaAddress || !funderAddress || initCredsLoading || !walletAvailable}
            >
              {initCredsLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sign in MetaMask…
                </>
              ) : (
                "Initialize API credentials"
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Explanatory card */}
      <Card className="border-muted/50 bg-muted/20">
        <CardHeader>
          <CardTitle className="text-base">About this connection</CardTitle>
          <CardDescription>
            What we store and how it’s used
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            We store your EOA address (from MetaMask), your Polymarket funder/proxy address, and signature type in our database. This links your identity to your Polymarket trading wallet for future features (e.g. syncing positions, activity). We do not store private keys or API keys here.
          </p>
          <p>
            Signature type 2 is the usual choice when trading via Polymarket’s proxy wallet. Use 1 only if you trade directly with your EOA, or another value if your setup requires it.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
