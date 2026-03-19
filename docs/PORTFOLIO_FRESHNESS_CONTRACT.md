# Portfolio API: Freshness Contract

## Summary

Freshness is explicit and consistent across portfolio APIs and UI. We do **not** conflate fresh fetch, cached response, and unknown freshness. We do **not** treat `null` as "fresh".

---

## Contract

| Value | Meaning |
|-------|--------|
| **freshnessMs = 0** | Fresh fetch (data just fetched from source). |
| **freshnessMs > 0** | Cached (age in ms at response time). |
| **freshnessMs = null** | Unknown / unavailable (e.g. derived-only path with no live fetch). |

| **freshnessState** | Meaning |
|--------------------|--------|
| **"fresh"** | Same as freshnessMs === 0. |
| **"cached"** | Same as freshnessMs > 0. |
| **"unknown"** | Same as freshnessMs == null. **Do not assume unknown === fresh.** |

---

## API Fields

- **Positions:** Top-level `freshnessMs`, `freshnessState` (overview, positions, intelligence).
- **Orders:** Top-level `ordersFreshnessMs`, `ordersFreshnessState` (overview, intelligence).

Canonical "last updated" remains **top-level `asOf`** (ISO string). Do not use persisted snapshot metadata for "last updated".

---

## Implementation

- **lib/portfolio/freshness-contract.ts:** `getFreshnessState()`, `normalizeFreshnessForApi()`, `unknownFreshness()`.
- Routes use `normalizeFreshnessForApi(fromCache, freshnessMsFromService)` so that fresh fetches emit `freshnessMs: 0` and `freshnessState: "fresh"`, not `null`.
- When there is no fetch metadata (e.g. derived-only), use `unknownFreshness()` → `freshnessMs: null`, `freshnessState: "unknown"`.

---

## UI

- **PortfolioFreshnessIndicator** accepts positions (`asOf`, `freshnessMs`, `freshnessState`, `sourceOfTruth`) and orders (`ordersAsOf`, `ordersFreshnessMs`, `ordersFreshnessState`, `orderSourceOfTruth`).
- Renders **fresh** ("Just fetched"), **cached** ("From cache" / "Cached Ns"), **unknown** ("Freshness unknown") distinctly.
- Tooltips state exact semantics; unknown is never implied to be fresh.

### Mixed-time display (no single coherent snapshot)

Positions and orders may be fetched at different times. The UI must **not** imply one "Last updated" when they differ.

- **Unified:** When `asOf` and `ordersAsOf` match (and same source/freshness), a single compact line is OK, e.g. "just now · official".
- **Mixed:** When positions and orders timestamps or source differ, the indicator shows **separate** labels, e.g.:
  - `Positions: just now · official`
  - `Orders: 3s ago · official`
- Do not collapse mixed-time data into one ambiguous "Last updated". Tooltips clarify positions vs orders when mixed.

---

## Example Payloads

**Fresh fetch (positions):**
```json
{
  "asOf": "2025-03-13T12:00:00.000Z",
  "freshnessMs": 0,
  "freshnessState": "fresh"
}
```

**Cached:**
```json
{
  "asOf": "2025-03-13T11:59:50.000Z",
  "freshnessMs": 8500,
  "freshnessState": "cached"
}
```

**Unknown (e.g. derived-only):**
```json
{
  "asOf": "2025-03-13T12:00:00.000Z",
  "freshnessMs": null,
  "freshnessState": "unknown"
}
```

**Orders** use the same pattern: `ordersFreshnessMs`, `ordersFreshnessState`.
