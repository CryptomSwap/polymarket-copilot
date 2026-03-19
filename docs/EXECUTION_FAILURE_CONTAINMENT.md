# Execution Failure Containment

When submit/cancel/replace fails mid-flight (timeout, network failure, unknown outcome), the runtime **fails closed**: it marks ambiguity explicitly, freezes the affected asset, and blocks new automated entries until verification.

## Safety behavior

- **Ambiguity is explicit**  
  Order status is set to a dedicated state (`submit_ambiguous`, `cancel_ambiguous`, `replace_ambiguous`, `exchange_ack_timeout`, `execution_verification_required`). Ambiguity is not hidden under generic `working` or `unknown`.

- **Asset-level freeze**  
  Any ambiguous outcome for an asset adds that asset to the execution-frozen set. New automated PLACE_ENTRY for that asset is blocked by guardrails until the operator clears the freeze or verification confirms state.

- **No unsafe continued automation**  
  Guardrails receive `executionFrozenAssetIds` and `executionContainmentForceCancelOnlyOrFrozen`. If the current asset is frozen, the intent is blocked. If containment recommends force mode (e.g. many frozen assets), the effective operating mode can become `cancel_only` or `frozen`.

- **Degradation from repeated ambiguity**  
  If ambiguities in a time window exceed a threshold, the runtime is marked degraded (`execution_ambiguity_repeated`). If frozen asset count exceeds a threshold, `execution_frozen_assets` is added to degraded reasons.

- **Cancel-replace interrupted**  
  If cancel succeeds but replace submit is ambiguous, the new order is marked `submit_ambiguous` and the asset is frozen. If cancel itself is ambiguous during a cancel-replace, the existing order is marked `replace_ambiguous`, the asset is frozen, and the replace (new order) is **not** placed.

- **Visibility**  
  Health and operator health expose `executionContainment`: frozen asset IDs, ambiguity counters (`submitAmbiguousCount`, `cancelAmbiguousCount`, `replaceAmbiguousCount`, `executionVerificationRequiredCount`), and flags `shouldDegradeRuntime` / `shouldForceCancelOnlyOrFrozen`. Diagnostics snapshot includes the same counters.

## Reason codes

- `submit_ambiguous` – submit timeout/unknown
- `cancel_ambiguous` – cancel timeout/unknown
- `replace_ambiguous` – cancel-replace interrupted (cancel or replace ambiguous)
- `execution_verification_required` – order/outcome needs verification
- `asset_execution_frozen` – new entry blocked for this asset
- `exchange_ack_timeout` – ack not received within expected time (status only)

## Integration points

- **Order exchange adapter** – `SubmitOrderResult` / `CancelOrderResult` support `timeout` and `ambiguous`.
- **Paper adapter** – Optional `submitTimeoutOrAmbiguous` / `cancelTimeoutOrAmbiguous` for tests.
- **Paper order manager** – On ambiguous result: updates order status, calls containment + diagnostics, and for cancel-replace does not place the new order when cancel is ambiguous.
- **Guardrails** – Block PLACE_ENTRY when asset is in `executionFrozenAssetIds`; force frozen verdict when `executionContainmentForceCancelOnlyOrFrozen`.
- **Operating mode** – Effective mode can become `frozen` or `cancel_only` via guardrail verdict from containment.
- **Runtime degraded** – Uses `executionAmbiguityShouldDegrade` and `executionFrozenAssetCount` to add reasons.
- **Health** – `operatorHealth.executionContainment` and diagnostics counters surface ambiguity.

Paper mode remains safe: failure states are modeled the same way; the paper adapter can simulate timeout/ambiguous for testing.
