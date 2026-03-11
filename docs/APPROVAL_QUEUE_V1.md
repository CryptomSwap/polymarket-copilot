# Approval Queue v1 — Manual-Approval Layer (No Live Execution)

**Goal:** A clean manual-approval layer between dry-run bot suggestions and any future order execution. **v1 is additive and no-execution:** operators approve or reject suggested candidates; no orders are placed by the queue.

---

## 1. Current grounding

| Piece | Location | Purpose |
|-------|----------|---------|
| Dry-run output | `GET /api/bot/dry-run` | Returns `DryRunResult`: `candidates[]` with `candidate`, `executionKey`, `guardrail`. |
| Idempotency key | `lib/bot/types.ts` → `executionKey(candidate)` | `recommendationId:assetId:side:size:limitPrice` — same inputs → same key. |
| Order placement | `POST /api/orders/place` | Body: `marketId`, `assetId`, `outcome`, `side`, `limitPrice`, `size`, `recommendationId`. Creates `OrderIntent`, calls `placeLimitOrder`, creates `ExecutedOrder`. |
| OrderIntent | `prisma/schema.prisma` | `id`, `funderAddress`, `recommendationId`, `marketId`, `assetId`, `outcome`, `side`, `orderType`, `limitPrice`, `size`, `status`, `riskPreviewJson`, timestamps. No idempotency key. |
| ExecutedOrder | `prisma/schema.prisma` | Linked to `OrderIntent`; holds `polymarketOrderId`, fill state, etc. |

Approval Queue v1 introduces a **persistent queue entry** per bot-suggested candidate. The human approves or rejects; **no call to `placeLimitOrder`** is made from the queue in v1.

---

## 2. Flow (v1)

```
Dry-run candidates (allowed)  →  [Add to queue / Approve / Reject]  →  ApprovalQueueEntry
                                                                           status: PENDING | APPROVED | REJECTED
                                                                           (future: EXECUTED when order is placed)
```

- **Suggested candidate:** From dry-run; identified by `executionKey`.
- **Approved intent:** Queue entry with `status = APPROVED`. In v1 we do **not** call `POST /api/orders/place`. Future: executor or "Execute approved" action would use this entry to place and then set `EXECUTED` and link `orderIntentId`.
- **Rejected intent:** Queue entry with `status = REJECTED` and optional `reason`.
- **Executed intent (future):** Queue entry with `status = EXECUTED`, `orderIntentId` set after a real place.

---

## 3. Suggested schema (additive)

One new table: **ApprovalQueueEntry**. No changes to `OrderIntent` or `ExecutedOrder`.

```prisma
model ApprovalQueueEntry {
  id                String   @id @default(cuid())
  funderAddress     String
  /// Idempotency: same as bot executionKey (recommendationId:assetId:side:size:limitPrice).
  idempotencyKey    String
  recommendationId  String
  marketId          String
  assetId           String
  outcome           String
  side              String   // BUY | SELL
  limitPrice        String
  size              String
  /// PENDING | APPROVED | REJECTED | EXECUTED (future)
  status            String
  /// Optional reason (e.g. rejection reason or operator note).
  reason            String?  @db.Text
  /// Denormalized for UI.
  marketTitle       String?  @db.Text
  /// Set when status becomes EXECUTED (future).
  orderIntentId     String?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@unique([funderAddress, idempotencyKey])
  @@index([funderAddress])
  @@index([status])
  @@index([recommendationId])
}
```

- **idempotencyKey:** Matches `executionKey(candidate)` from the bot. Prevents duplicate queue entries for the same suggested trade per funder.
- **reason:** Free-text; used for rejection reason or operator notes.
- **marketTitle:** Optional; from `candidate.marketTitle` when creating from dry-run.
- **orderIntentId:** Null in v1; future: set when we create an `OrderIntent` and place the order.

---

## 4. Suggested APIs

### 4.1 List queue

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/bot/approval-queue` | List entries for the connected funder. Query: `?status=PENDING` or `status=APPROVED` or `status=REJECTED` (optional). Default: all. |

**Response shape (minimal):**

```ts
{
  entries: Array<{
    id: string;
    funderAddress: string;
    idempotencyKey: string;
    recommendationId: string;
    marketId: string;
    assetId: string;
    outcome: string;
    side: string;
    limitPrice: string;
    size: string;
    status: string;
    reason: string | null;
    marketTitle: string | null;
    orderIntentId: string | null;
    createdAt: string; // ISO
    updatedAt: string; // ISO
  }>;
}
```

- Use `getFunderForRecompute()`; 400 if no funder.

### 4.2 Add to queue (from dry-run candidate)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/bot/approval-queue` | Create a queue entry from a bot candidate (e.g. from dry-run). Body: same fields as needed to build idempotencyKey + marketTitle. |

**Request body (aligned with BotCandidate + executionKey):**

```ts
{
  recommendationId: string;
  marketId: string;
  assetId: string;
  outcome: string;
  side: "BUY" | "SELL";
  limitPrice: string;
  size: string;
  marketTitle?: string | null;
}
```

- Compute `idempotencyKey = [recommendationId, assetId, side, size, limitPrice].join(":")` (must match `executionKey` in `lib/bot/types.ts`).
- If an entry with same `funderAddress` + `idempotencyKey` exists, return 409 with existing entry or upsert semantics (e.g. reset status to PENDING and update marketTitle). Otherwise create with `status = PENDING`.
- Return created/updated entry.

### 4.3 Approve

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/bot/approval-queue/[id]/approve` | Set entry `status = APPROVED`. Optional body: `{ reason?: string }`. **v1: does not call place.** |

### 4.4 Reject

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/bot/approval-queue/[id]/reject` | Set entry `status = REJECTED`. Body: `{ reason?: string }`. |

---

## 5. UI plan

- **Bot Command Center page** (`/bot`): Keep existing dry-run table and detail drawer.
  - **Per candidate row (allowed only):** Add actions: **Add to queue**, **Approve**, **Reject**.
    - **Add to queue:** POST to `/api/bot/approval-queue` with candidate fields; show toast or inline “Added to queue.”
    - **Approve:** Create queue entry if not present (same payload), then POST `.../approve`. Show “Approved (no execution in v1).”
    - **Reject:** Create queue entry if not present, then POST `.../reject`; optional modal/prompt for reason.
  - **Approval Queue strip/section** on the same page (or tab): List queue entries (e.g. PENDING first, then APPROVED, then REJECTED). Columns: status, market title, side, size, limit price, reason, created/updated. Actions: Approve / Reject for PENDING; for APPROVED in v1 show “Approved — execute later” (no button to execute yet).
- **Restrained:** Reuse existing Card/table patterns; no new routes. Optional: filter by status in the queue list.

---

## 6. Implementation checklist (no execution)

- [ ] Add `ApprovalQueueEntry` to `prisma/schema.prisma` and run migration.
- [ ] Implement `GET /api/bot/approval-queue` (list by funder, optional status filter).
- [ ] Implement `POST /api/bot/approval-queue` (create or upsert by idempotencyKey).
- [ ] Implement `POST /api/bot/approval-queue/[id]/approve` (set status APPROVED, optional reason).
- [ ] Implement `POST /api/bot/approval-queue/[id]/reject` (set status REJECTED, reason).
- [ ] On Bot Command Center: add “Add to queue” / “Approve” / “Reject” per allowed candidate; add Approval Queue list section; optional reason prompt for Reject.
- [ ] **Do not** add any “Execute approved” or automatic call to `POST /api/orders/place` from the queue in v1.

---

## 7. Future: from APPROVED to EXECUTED

- Add an explicit action (e.g. “Execute approved” button or separate executor job) that:
  - Finds entries with `status = APPROVED` (and optionally not older than N hours).
  - For each, calls existing `POST /api/orders/place` (or `placeLimitOrder` with same params).
  - On success: set `status = EXECUTED`, set `orderIntentId` to the created OrderIntent id.
- Idempotency: if an entry with same `idempotencyKey` already has `orderIntentId` / EXECUTED, skip or return no-op.

This keeps the approval layer clean and leaves execution to a later, explicit step.
