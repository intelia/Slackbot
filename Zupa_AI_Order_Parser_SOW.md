# Scope of Work — AI Order Parser for Zupa

### Gourmet Twist · WhatsApp/Instagram DM → Zupa Order Entry

**Version:** 1.0 **Date:** 16 June 2026 **Owner:** Udoka (Managing Partner) **Status:** Draft for build

---

## 1\. Objective

Build an AI-assisted bot that ingests free-text customer orders (WhatsApp, Instagram DM, pasted text), parses them against the Gourmet Twist catalogue and delivery-zone table, and produces a **draft order for a human to confirm** before it is pushed into Zupa.

The bot **never auto-submits a customer-facing order without human sign-off.** Its job is to do 90%+ of the keystrokes and surface only the genuine ambiguities for a one-tap human decision.

---

## 2\. Problem statement

Orders arrive as messy natural language across channels:

eye \-

09028920538

Lekki pickup

Double choc mini 3000

Nutella mini 2900

Banana mini 1800

Orange x choc mini...2100

Chicken pie...2500

Total....12,300(Oluseye)

@oluseye\_a

Staff currently re-key these by hand into Zupa — slow, error-prone, and a quiet revenue-leak risk (e.g. delivery fees dropped, wrong size selected). Catalogue names also drift from how customers phrase items ("Winner jollof" → "Eco/Winners Jollof Rice"; "Banana mini" → one of 20+ banana products).

---

## 3\. In scope / Out of scope

**In scope**

- Parsing raw order text into structured line items, customer details, and fulfillment info.  
- Matching items to catalogue SKUs (`products.json`) and delivery zones (`cities.json`), returning exact IDs.  
- Confidence scoring and an auto-accept vs. human-confirm decision per order.  
- A **confirmation UX** where staff review the draft, see **ranked suggestions** for any uncertain line, and **pick** the correct one.  
- Total reconciliation (line items \+ delivery fee vs. customer's stated total).  
- Emitting a Zupa-ready order payload on confirmation.

**Out of scope (Phase 1\)**

- Two-way customer messaging / auto-replies.  
- Payment capture or verification.  
- Inventory/stock checks at parse time.  
- Voice-note transcription (assume text input; transcription can feed in later).  
- Multi-language (assume English/Nigerian-English).

---

## 4\. Data inputs

### 4.1 `products.json` — catalogue

- **211 products / 454 SKUs.** Each product has a name and a `sizes[]` array; each size carries `{name, id, price}`. **The `id` is the only reliable join key** — names have trailing-space and duplicate issues.  
- Size taxonomy: `Standard` (single-size, 124 products); bread ladder `Mini/Midi/Regular/Maxi/Extra Large`; cake ladder `6"/8"/10"/12"/14"`; plus `Pack(s)` and drink volumes.

### 4.2 `cities.json` — delivery zones

- **261 entries, ₦0–₦15,000.** This table mixes **two kinds of rows** and the bot must treat them differently:  
  1. **Named geographic zones** — e.g. `Ikoyi` (₦3,500), `Ketu (Mainland Store)` (₦4,000), `Lekki - Ologolo Spg` (₦3,300). *Customer addresses resolve only to these.*  
  2. **Generic ride-hail fee tiers** — \~40 rows like `Uber Delivery 9` (₦9,000), `Bolt Delivery 6.5 (Mainland Store)` (₦6,500). These are **manual staff overrides**, never auto-matched from an address. The number in the name is the price in thousands.  
- **Free/pickup flags:** `GTFREE`, `GTFREE Opebi`, `Pickup`, `Pick up LEKKI`, `Pick Up OPEBI` (₦0).  
- **Surge twins:** many zones have a base row and one or two surge variants, e.g. `Ikoyi` ₦3,500 / `Ikoyi Surge` ₦4,000 / `Ikoyi (Surge)` ₦4,500. The bot **defaults to base** and lets the customer's stated total/fee select a surge row if the math points there.  
- **`(Mainland Store)` / `(Opebi Store)` tags** double as a **routing hint** for which branch fulfills the order.

### 4.3 Required data-quality remediation (pre-build)

Both files carry trailing/double whitespace, inconsistent casing/hyphenation (`LEKKI-MARUWA` vs `Lekki - Chevron`), 18 null size entries in `products.json`, and 2 duplicate product names. **The matcher must normalize aggressively** (uppercase, trim, collapse spaces/hyphens) and **null entries must be stripped** before indexing. A one-time cleaned export of both files is a Phase-0 deliverable.

---

## 5\. Parsing pipeline

For each incoming message:

1. **Segment** the message into: customer block (name, phone, IG handle), fulfillment block (address or "pickup"), item lines, stated total, and noise (greetings, "please prioritize", trailing orphan characters).  
2. **Extract per item line:** product phrase, size token, quantity token, and any stated line price.  
3. **Match product** → candidate SKUs (see §6).  
4. **Resolve size** → valid size for the matched product.  
5. **Parse quantity** → integer (see §6.3).  
6. **Resolve delivery** → zone \+ fee, or pickup (see §6.4).  
7. **Reconcile** line items \+ delivery against the customer's stated total (see §6.5).  
8. **Score confidence** and set order status: `auto_accepted` or `needs_confirmation` (see §7).  
9. **Emit draft** to the confirmation UX.

---

## 6\. Matching logic (validated against live test orders)

### 6.1 Product matching

- Normalize the customer phrase and search product names. Customers routinely **drop the word "Bread"** ("Double choc" → "Double Choc"; but note some loaf names have no "Bread" suffix at all), so suffix matching is unreliable.  
- Produce a **ranked candidate list** with a match score.  
- **Stated price is the primary tiebreaker.** "Banana mini" alone is ambiguous across 20+ products; "Banana mini 1800" resolves unambiguously to **Banana Bread / Mini** because ₦1,800 matches that SKU. When a price is present and matches exactly one candidate, confidence is high.

### 6.2 Size matching

- Map the size token to a valid size for the matched product. If the size doesn't exist for that product (e.g. "Chicken Pie Maxi"), **hold**.  
- Single-size products default to `Standard`.

### 6.3 Quantity parsing

- Must robustly handle all observed forms: `x8`, `X2`, `×2`, `2x`, `(2)`, `2 packs`, and number words. Default to 1 when absent.  
- Multiply unit price × qty for the line total.

### 6.4 Delivery / fulfillment resolution

- **Pickup detection:** "pickup" / "pick up" \+ branch → the matching free row (`Pickup`, `Pick Up OPEBI`, etc.), fee ₦0.  
- **Address present → delivery.** Resolve the address's area to a **named zone only** (never to an Uber/Bolt row):  
  - Direct/near-literal match (e.g. "Ologolo" → `Lekki - Ologolo Spg`).  
  - **Sub-area inference** via an **alias map** (e.g. "Alapere" → `Ketu (Mainland Store)`). See §6.6 — this replaces live geographic guessing with a deterministic, auditable table.  
  - **Default to the base (non-surge) zone.**  
  - **No named match → hold:** staff manually assign the correct zone or an Uber/Bolt tier.  
- Carry the zone's `(... Store)` tag through as a **branch routing hint**.

### 6.5 Total reconciliation (the design anchor)

The customer's stated total is the strongest integrity signal. After computing `sum(line totals) + delivery fee`:

- **Equals stated total → reconciled** (auto-accept eligible).  
- **Gap equals a known zone's base fee** when no delivery line was written → infer that delivery fee (this is how Nnene's ₦3,500 Ikoyi fee and Elumelu's ₦3,300 Ologolo fee were recovered).  
- **Gap equals a surge twin's fee** → select the surge row (the customer's math reveals surge was applied).  
- **Gap matches nothing → hold**, showing both numbers.

### 6.6 Address → zone alias map (Phase-0 deliverable)

A maintained lookup of customer-spoken sub-areas to canonical zone IDs, e.g.:

| Customer says | Canonical zone | Zone ID |
| :---- | :---- | :---- |
| Alapere, Mile 12 | Ketu (Mainland Store) | b161e54b-… |
| Ologolo | Lekki \- Ologolo Spg | b12e8159-… |
| VGC | LEKKI \-VGC | 675cfe9d-… |
| … | … | … |

Editable by ops staff. Every confirmed override where staff corrected a zone should **feed back** into this map so coverage compounds over time.

---

## 7\. Confidence & confirmation rules

**A line AUTO-ACCEPTS only when** exactly one product matches, the size is valid, and — if a price/total is present — it reconciles.

**An order is HELD for human confirmation when any line or the order has:**

- Ambiguous product name with no price tiebreaker.  
- Price mismatch (stated line/total ≠ catalogue).  
- Missing or invalid size.  
- No confident product match (show top 2–3 candidates).  
- Unresolvable delivery zone.  
- Order total ≠ sum of lines \+ delivery.

**Confirmation is line-level, not whole-order:** clean lines pre-populate as confirmed; only flagged lines block submission. Even on an auto-eligible order, the **whole order still passes through the review screen** — the human always taps the final confirm (per requirement). Auto-accept means "pre-filled and green," not "submitted without a human."

---

## 8\. UX specification

### 8.1 Principles

- **One screen, glanceable.** Staff should resolve a typical order in seconds: green lines need no attention, amber lines ask one question each.  
- **Never block on certainty the bot already has.** Don't make staff re-pick things that matched cleanly.  
- **Suggestions, not free typing.** When a line is wrong/uncertain, staff **pick from ranked candidates** (tap), with manual search as the fallback — much faster and less error-prone than typing on mobile.  
- **Money is always visible.** Running total and the reconciliation status are pinned.

### 8.2 Screen: "Review Order"

┌─────────────────────────────────────────────────────────┐

│  REVIEW ORDER                          ● Needs review (1) │

├─────────────────────────────────────────────────────────┤

│  CUSTOMER                                                 │

│  Oluseye   @oluseye\_a   0902 892 0538                     │

│  Fulfillment:  ◉ Pickup — Lekki        \[change\]           │

├─────────────────────────────────────────────────────────┤

│  ITEMS                                                    │

│  ✓ Double Choc · Mini            ×1      ₦3,000     \[edit\]│

│  ✓ Nutella Bread · Mini          ×1      ₦2,900     \[edit\]│

│  ⚠ "Banana mini"  — pick product →                       │

│       ┌───────────────────────────────────────────────┐  │

│       │ ● Banana Bread · Mini              ₦1,800  ✓best│  │

│       │ ○ Banana x Coconut Bread · Mini    ₦2,100      │  │

│       │ ○ Banana x Almond Bread · Mini     ₦2,300      │  │

│       │ ○ Search all products…                         │  │

│       └───────────────────────────────────────────────┘  │

│  ✓ Orange x Choc Bread · Mini    ×1      ₦2,100     \[edit\]│

│  ✓ Chicken Pie · Standard        ×1      ₦2,500     \[edit\]│

├─────────────────────────────────────────────────────────┤

│  Items                                          ₦12,300  │

│  Delivery (Pickup)                                   ₦0  │

│  ─────────────────────────────────────────────────────   │

│  TOTAL                                          ₦12,300  │

│  ✓ Matches customer's stated total                       │

├─────────────────────────────────────────────────────────┤

│  Branch routing:  Lekki                                  │

│  Note from customer:  —                                  │

│                                                          │

│   \[ Reject \]              \[ Confirm & Push to Zupa \]      │

│                            (disabled until ⚠ resolved)    │

└─────────────────────────────────────────────────────────┘

### 8.3 Line-item states

| State | Indicator | Behaviour |
| :---- | :---- | :---- |
| **Matched (high)** | ✓ green | Pre-filled, collapsed. `[edit]` opens the picker if staff disagree. |
| **Needs pick (ambiguous)** | ⚠ amber | Expanded inline with ranked candidates; blocks submit until chosen. |
| **Price mismatch** | ⚠ amber | Shows stated vs. catalogue price; staff accept catalogue, keep stated (as override), or repick. |
| **No size** | ⚠ amber | Shows the product's available sizes as chips to tap. |
| **Unmatched** | ✕ red | "No match found" \+ search box \+ closest candidates. |

### 8.4 The suggestion-and-pick component (core requirement)

When a line is wrong or uncertain:

1. Show a **ranked list of candidates** as tappable rows: product · size · price, with the bot's best guess marked **"✓ best"** and pre-selected.  
2. Ranking signals: name-match score, **price agreement with the stated line price**, size validity, and (later) this customer's past picks.  
3. Each candidate shows **price** so staff disambiguate by what the customer paid.  
4. A persistent **"Search all products…"** row opens a type-ahead over the full 454-SKU catalogue (normalized search; results show product · size · price).  
5. Selecting a candidate instantly: swaps the SKU \+ ID, recomputes the line total, **re-runs reconciliation**, and flips the line to ✓. If the new line breaks the total, the reconciliation banner turns amber immediately.  
6. **Quantity** is editable inline (stepper) on every line.

### 8.5 Delivery / zone UX

- Show resolved zone name \+ fee, with **`[change zone]`**.  
- If the matched zone has **surge twins**, show a small **base ⇄ surge toggle**; the option the customer's total implies is pre-selected.  
- If **no zone matched**, the delivery row is amber: staff pick from nearby named zones or an Uber/Bolt tier (the only place those rows are offered), and the choice can be saved back to the **alias map**.  
- Display the **branch routing hint** so dispatch isn't sent from the wrong store.

### 8.6 Reconciliation banner (pinned)

- **Green:** "Matches customer's stated total."  
- **Amber:** "Off by ₦X — review." with a one-line hypothesis when available (e.g. "≈ Ikoyi delivery ₦3,500 — add delivery?") and a one-tap action to apply it.  
- Submit is **disabled while amber**, unless staff explicitly tap **"Confirm mismatch"** (logged as an override with reason).

### 8.7 Noise handling

- Greetings, "please prioritize", emojis, and **trailing orphan characters** (the stray `E`/`N` seen on most orders) are stripped from matching but preserved in a **raw-message panel** so staff can always see the original. "Please prioritize" surfaces as a **customer note** flag, not an item.

### 8.8 Confirmation & audit

- **"Confirm & Push to Zupa"** emits the payload (§9), writes the order, and logs: who confirmed, which lines were auto vs. corrected, any overrides, and the final mapping. Corrections feed the learning loop (§11).

---

## 9\. Zupa output contract

On confirm, emit:

{

  "status": "confirmed",

  "source": "whatsapp",

  "raw\_message": "…original text…",

  "customer": {

    "name": "Oluseye",

    "instagram": "@oluseye\_a",

    "phone": "09028920538"

  },

  "fulfillment": {

    "type": "pickup",

    "branch": "Lekki",

    "address": null,

    "zone\_id": null,

    "delivery\_fee": 0

  },

  "items": \[

    { "size\_id": "260fce18-766e-4e80-814b-f673b5f9283b",

      "product\_name": "Double Choc", "size": "Mini",

      "qty": 1, "unit\_price": 3000, "line\_total": 3000,

      "match": "auto" },

    { "size\_id": "23754fe1-107b-441b-a61e-3b1860f8b817",

      "product\_name": "Banana Bread", "size": "Mini",

      "qty": 1, "unit\_price": 1800, "line\_total": 1800,

      "match": "staff\_confirmed" }

  \],

  "items\_subtotal": 12300,

  "order\_total": 12300,

  "reconciliation": "matched",

  "confirmed\_by": "staff\_user\_id",

  "overrides": \[\]

}

`size_id` and `zone_id` are the authoritative keys Zupa consumes; names are display-only.

---

## 10\. Acceptance criteria (test suite from live session)

The build must reproduce these outcomes:

| \# | Order | Expected result | Validates |
| :---- | :---- | :---- | :---- |
| 1 | Oluseye — 5 items, pickup, total ₦12,300 | Auto-accept; "Banana mini" resolved to Banana Bread via price | Price-tiebreaker disambiguation |
| 2 | Nnene — "Winner jollof x8", total ₦55,500, Ikoyi | Hold initially; resolves to Eco/Winners Jollof ×8 (₦52,000) \+ Ikoyi ₦3,500 | Fuzzy tier match \+ gap-implied delivery |
| 3 | Olayemi — 2 items \+ "Delivery 4000", Alapere, total ₦22,000 | Auto-accept; Alapere→Ketu (Mainland Store) ₦4,000; branch=Mainland | Stated fee \+ alias-map zone \+ routing |
| 4 | Elumelu — "Banana bread regular X2", Ologolo, total ₦16,300 | Auto-accept; qty=2 ₦13,000 \+ Ologolo ₦3,300 (base, not surge) | Qty multiplier \+ surge base selection |

Plus negative tests to add: unknown product, invalid size for product, total that matches neither base nor surge, and an address with no zone match.

---

## 11\. Phasing

**Phase 0 — Data prep**

- Clean exports of `products.json` and `cities.json` (whitespace, nulls, dupes).  
- Build the address→zone alias map seed and the named-zone vs. ride-hail-tier classification.

**Phase 1 — Parser \+ confirmation UX (core)**

- Parsing pipeline, matching logic, reconciliation, confidence scoring.  
- Review Order screen with line-level confirm \+ suggestion-pick \+ zone/surge handling.  
- Zupa push on confirm.

**Phase 2 — Learning loop**

- Per-customer memory (Oluseye's "Banana mini" → Banana Bread sticks for next time).  
- Alias-map auto-growth from staff zone corrections.  
- Channel intake automation (pull from WhatsApp/IG rather than paste).

**Phase 3 — Optional**

- Voice-note transcription intake.  
- Stock/availability check at parse time.  
- Two-way customer confirmation messaging.

---

## 12\. Open decisions for sign-off

1. **Confirmation memory:** should a customer's resolved mapping persist per-customer (recommended)?  
2. **Mismatch override:** allow staff to push an order whose total doesn't reconcile, with a logged reason (recommended)?  
3. **Unknown zone:** confirm the bot **holds** rather than guessing the nearest zone (recommended).  
4. **Surge:** confirm default-to-base, with the customer's stated total allowed to select a surge twin (recommended).  
5. **Branch routing:** is the `(... Store)` tag authoritative for dispatch, or advisory only?

