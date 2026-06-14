# Lumnix — Complete Database Architecture & Operations Manual

> **Last updated:** May 21, 2026 | **Project:** lumnix.dev  
> **Supabase:** `srfunhstbufgteiyggur` (us-east-1) | **Dashboard:** https://supabase.com/dashboard/project/srfunhstbufgteiyggur  
> **This document is the source of truth for how Lumnix's database works.**

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Entity Relationship Diagram](#entity-relationship-diagram)
3. [Table Definitions](#table-definitions)
4. [Security (RLS)](#security-rls)
5. [Indexes & Performance](#indexes--performance)
6. [Triggers](#triggers)
7. [How Data Flows](#how-data-flows)
8. [Plan Change Protocol](#plan-change-protocol)
9. [What to Change & When](#what-to-change--when)
10. [Emergency Procedures](#emergency-procedures)
11. [Rate Limits Reference](#rate-limits-reference)
12. [Max Key Limits Reference](#max-key-limits-reference)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        USER'S BROWSER                                │
│  login / signup / dashboard (Next.js on Vercel)                     │
└──────────────┬──────────────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     VERCEL (lumnix.dev)                              │
│                                                                      │
│  /api/mcp          → MCP endpoint (auth + rate limit + tool routing)│
│  /api/keys         → Key CRUD (create, list, revoke)                │
│  /api/keys/[id]    → Key details + usage stats                      │
│  /api/stripe/*     → Checkout, portal, webhooks                     │
│  /auth/callback    → Email confirmation handler                      │
│                                                                      │
│  Server-side uses: service_role key (bypasses RLS)                  │
│  Client-side uses: anon key (respects RLS)                          │
└──────────────┬──────────────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     SUPABASE (us-east-1)                             │
│                                                                      │
│  auth.users          → Supabase Auth (email/password, OAuth)        │
│  public.profiles     → User profiles + plan                         │
│  public.api_keys     → API key hashes + usage counters              │
│  public.api_usage    → Per-request audit log                        │
│  public.subscriptions→ Stripe subscription tracking                 │
│                                                                      │
│  + MC tables (mc_*) → Mission Control (separate, will migrate)     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Entity Relationship Diagram

```
auth.users (Supabase managed)
    │
    │ 1:1 (via trigger: on auth.users insert → create profiles row)
    ▼
profiles
    │ id (PK, UUID)
    │ supabase_id (FK → auth.users.id, UNIQUE)
    │ email, name, plan, stripe_customer_id
    │
    ├── 1:N ──► api_keys
    │              │ id (PK, UUID)
    │              │ user_id (FK → profiles.id)
    │              │ key_hash (SHA-256, never the real key)
    │              │ key_prefix (first 12 chars, e.g. "lmx_abc12345")
    │              │ name, plan, active
    │              │ requests_today, requests_total, requests_month
    │              │ amazon_requests_today, alibaba_requests_today, ...
    │              │ amazon_requests_month, alibaba_requests_month, ...
    │              │
    │              └── 1:N ──► api_usage
    │                            │ id (PK, UUID)
    │                            │ api_key_id (FK → api_keys.id)
    │                            │ user_id (FK → profiles.id)
    │                            │ endpoint, tool_name
    │                            │ tokens_used, response_time_ms
    │                            │ created_at
    │
    └── 1:N ──► subscriptions
                   │ id (PK, UUID)
                   │ user_id (FK → profiles.id)
                   │ stripe_subscription_id (UNIQUE)
                   │ stripe_price_id
                   │ status (active/canceled/past_due/inactive/trialing)
                   │ current_period_start, current_period_end
                   │ cancel_at_period_end
```

---

## Table Definitions

### `profiles` — The User Record

**Purpose:** One row per user. Stores plan, email, and Stripe customer ID.  
**Created by:** Supabase Auth trigger (when a user signs up, a profile row is auto-created).

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | UUID | NO | gen_random_uuid() | **Primary key.** Internal user ID. Referenced by api_keys, subscriptions. |
| `supabase_id` | UUID | YES | — | **FK → auth.users.id.** Links to Supabase Auth. UNIQUE constraint. |
| `email` | TEXT | NO | — | User's email (copied from auth.users for convenience). |
| `name` | TEXT | YES | '' | Display name (editable by user in future). |
| `plan` | TEXT | NO | 'free' | **CRITICAL FIELD.** Must be 'free', 'pro', or 'business'. Controls rate limits and tool access. |
| `stripe_customer_id` | TEXT | YES | — | Stripe customer ID (set after first checkout). |
| `created_at` | TIMESTAMPTZ | YES | now() | When the profile was created. |
| `updated_at` | TIMESTAMPTZ | YES | now() | Auto-updated by trigger on every UPDATE. |

**Indexes:**
- `profiles_pkey` — Primary key on `id`
- `profiles_supabase_id_key` — UNIQUE on `supabase_id`
- `idx_profiles_supabase_id` — B-tree on `supabase_id` (for auth lookups)
- `idx_profiles_stripe_customer` — B-tree on `stripe_customer_id` (for webhook lookups)

**RLS Policies:**
- `profiles_select_own` — Users can SELECT their own profile (WHERE auth.uid() = supabase_id)
- `profiles_update_own` — Users can UPDATE their own profile

**Triggers:**
- `profiles_updated_at` — On UPDATE, sets `updated_at = now()`

---

### `api_keys` — API Key Records

**Purpose:** One row per API key. Stores the SHA-256 hash (never the real key). Tracks usage counters.  
**Created by:** POST /api/keys (server-side, using service_role).

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | UUID | NO | gen_random_uuid() | Primary key. |
| `user_id` | UUID | NO | — | **FK → profiles.id.** Who owns this key. CASCADE delete. |
| `key_hash` | TEXT | NO | — | **SHA-256 hash of the full API key.** Used for lookup during auth. NEVER store the plaintext. |
| `key_prefix` | TEXT | NO | — | First 12 characters (e.g. "lmx_abc12345"). Shown to user for identification. |
| `name` | TEXT | NO | 'Default' | Human-readable name given by user (e.g. "My Cursor Setup"). |
| `plan` | TEXT | NO | 'free' | **MUST match profiles.plan.** Updated when plan changes. Controls rate limits per key. |
| `requests_today` | INTEGER | NO | 0 | Daily usage counter. Reset by pg_cron at midnight UTC. |
| `requests_total` | INTEGER | NO | 0 | Lifetime usage counter. Never reset. |
| `requests_month` | INTEGER | NO | 0 | Monthly usage counter. Reset by pg_cron at start of month. |
| `amazon_requests_today` | INTEGER | NO | 0 | Amazon-specific daily counter. |
| `alibaba_requests_today` | INTEGER | NO | 0 | Alibaba-specific daily counter. |
| `aliexpress_requests_today` | INTEGER | NO | 0 | AliExpress-specific daily counter. |
| `amazon_requests_month` | INTEGER | NO | 0 | Amazon-specific monthly counter. |
| `alibaba_requests_month` | INTEGER | NO | 0 | Alibaba-specific monthly counter. |
| `aliexpress_requests_month` | INTEGER | NO | 0 | AliExpress-specific monthly counter. |
| `last_used_at` | TIMESTAMPTZ | YES | — | Timestamp of most recent API call. |
| `created_at` | TIMESTAMPTZ | YES | now() | When the key was created. |
| `expires_at` | TIMESTAMPTZ | YES | — | Optional expiration date. NULL = never expires. |
| `active` | BOOLEAN | NO | true | Soft-delete flag. false = revoked. |

**Indexes:**
- `api_keys_pkey` — Primary key on `id`
- `idx_api_keys_key_hash` — B-tree on `key_hash` (for auth lookups, the hot path)
- `idx_api_keys_user_id` — B-tree on `user_id` (for listing user's keys)
- `idx_api_keys_active` — Partial index WHERE active = true (for filtering)
- `idx_api_keys_plan` — B-tree on `plan` (for analytics)

**RLS Policy:**
- `api_keys_select_own` — Users can SELECT their own keys (joins profiles to verify supabase_id)

---

### `api_usage` — Request Audit Log

**Purpose:** One row per API call. Historical record for analytics and billing.  
**Created by:** The MCP endpoint after every successful request.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | UUID | NO | gen_random_uuid() | Primary key. |
| `api_key_id` | UUID | NO | — | **FK → api_keys.id.** Which key was used. |
| `user_id` | UUID | NO | — | **FK → profiles.id.** Which user. |
| `endpoint` | TEXT | NO | — | API endpoint called (e.g. "/api/mcp"). |
| `tool_name` | TEXT | YES | — | Which MCP tool was called (e.g. "amazon_search_products"). |
| `tokens_used` | INTEGER | YES | 0 | Token count (for future cost tracking). |
| `response_time_ms` | INTEGER | YES | — | Response time in milliseconds. |
| `created_at` | TIMESTAMPTZ | YES | now() | When the call was made. |

**Indexes:**
- `api_usage_pkey` — Primary key on `id`
- `idx_api_usage_api_key_id` — B-tree on `api_key_id`
- `idx_api_usage_user_id` — B-tree on `user_id`
- `idx_api_usage_created_at` — B-tree on `created_at` (for time-range queries)

**RLS Policy:**
- `api_usage_select_own` — Users can SELECT their own usage records

**⚠️ Growth note:** This table will grow fast (1 row per API call). Consider partitioning by month or archiving old records after 90 days.

---

### `subscriptions` — Stripe Subscription Tracking

**Purpose:** One row per Stripe subscription. Tracks payment status.  
**Created by:** Stripe webhook (checkout.session.completed).

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | UUID | NO | gen_random_uuid() | Primary key. |
| `user_id` | UUID | NO | — | **FK → profiles.id.** Who owns this subscription. |
| `stripe_subscription_id` | TEXT | YES | — | **UNIQUE.** Stripe's subscription ID (sub_xxx). |
| `stripe_price_id` | TEXT | YES | — | Which price they're on (maps to plan). |
| `status` | TEXT | NO | 'inactive' | 'active', 'canceled', 'past_due', 'inactive', 'trialing'. |
| `current_period_start` | TIMESTAMPTZ | YES | — | Billing period start. |
| `current_period_end` | TIMESTAMPTZ | YES | — | Billing period end (when next invoice). |
| `cancel_at_period_end` | BOOLEAN | YES | false | True = user canceled but period hasn't ended. |
| `created_at` | TIMESTAMPTZ | YES | now() | When this record was created. |
| `updated_at` | TIMESTAMPTZ | YES | now() | Auto-updated by trigger. |

**Indexes:**
- `subscriptions_pkey` — Primary key
- `subscriptions_stripe_subscription_id_key` — UNIQUE on `stripe_subscription_id`
- `idx_subscriptions_user_id` — B-tree on `user_id`
- `idx_subscriptions_stripe_id` — B-tree on `stripe_subscription_id`

**RLS Policy:**
- `subscriptions_select_own` — Users can SELECT their own subscriptions

**Trigger:**
- `subscriptions_updated_at` — On UPDATE, sets `updated_at = now()`

---

## Security (RLS)

### How RLS Works

Every table has Row Level Security enabled. Supabase checks policies on every query.

**Two access modes:**

| Mode | Key | What it does | Used by |
|------|-----|-------------|---------|
| **Client** | `anon` key | Respects RLS — users only see their own data | Browser (dashboard) |
| **Server** | `service_role` key | **Bypasses all RLS** — full access | API routes on Vercel |

**This means:**
- The dashboard (client-side) can only read the user's own data
- All writes (create key, update plan, etc.) go through API routes using service_role
- Users CANNOT escalate their own plan, create keys for others, or read other users' data

### Policy Details

| Table | Policy | Rule | Who Can |
|-------|--------|------|---------|
| profiles | `profiles_select_own` | `auth.uid() = supabase_id` | Read own profile |
| profiles | `profiles_update_own` | `auth.uid() = supabase_id` | Update own profile |
| api_keys | `api_keys_select_own` | `auth.uid() = profiles.supabase_id` via join | Read own keys |
| api_usage | `api_usage_select_own` | `auth.uid() = profiles.supabase_id` via join | Read own usage |
| subscriptions | `subscriptions_select_own` | `auth.uid() = profiles.supabase_id` via join | Read own subs |

**⚠️ CRITICAL:** The `plan` field on profiles does NOT have a restrictive update policy. Users can UPDATE their own profile. But the CHECK constraint (`plan IN ('free', 'pro', 'business')`) limits valid values. For full security, add a policy that prevents users from changing their own plan — only service_role should do that.

---

## Indexes & Performance

### Hot Path (called on EVERY API request)

The authentication lookup on `api_keys.key_hash` is the most performance-critical query:

```sql
SELECT * FROM api_keys WHERE key_hash = 'sha256hash...' AND active = true;
```

This uses:
1. `idx_api_keys_key_hash` — B-tree index on `key_hash` (fast lookup)
2. `idx_api_keys_active` — Partial index WHERE active = true (filters revoked)

### Dashboard Queries

Listing a user's keys:
```sql
SELECT ... FROM api_keys WHERE user_id = 'uuid' ORDER BY created_at DESC;
```
Uses: `idx_api_keys_user_id`

---

## Triggers

### Auto-create profile on signup

When a new user signs up via Supabase Auth, a trigger automatically creates a `profiles` row:

```sql
-- Trigger on auth.users INSERT → INSERT into public.profiles
-- This is managed by Supabase Auth, defined in the Supabase dashboard
```

### Auto-update `updated_at`

```sql
CREATE FUNCTION update_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- Applied to: profiles, subscriptions
```

---

## How Data Flows

### User Signup Flow

```
1. User fills form on /signup
2. Browser calls supabase.auth.signUp({ email, password })
3. Supabase creates row in auth.users
4. Trigger fires → creates row in public.profiles (plan='free')
5. User confirms email (clicks link)
6. Auth callback at /auth/callback exchanges code for session
7. User redirected to /dashboard
```

### API Call Flow

```
1. User's MCP client sends: POST https://lumnix.dev/api/mcp
   Authorization: Bearer lmx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   Body: { "method": "tools/call", "params": { "name": "amazon_search_products", ... } }

2. MCP endpoint extracts the key from Authorization header

3. Validates format: must start with "lmx_", must be alphanumeric

4. SHA-256 hashes the key on the fly

5. Looks up hash in api_keys table (uses idx_api_keys_key_hash index)
   - Not found? → 401 "Invalid or revoked API key"
   - Found but active=false? → 401
   - Found but expired? → 401

6. Reads the key's plan field

7. Checks rate limits (requests_today vs plan limit, per-platform counters)

8. Checks tool access (free plan = 3 tools only, pro/business = all 19)

9. If allowed → routes to the tool handler → gets response

10. Increments counters atomically on api_keys:
    - requests_today += 1
    - requests_total += 1
    - requests_month += 1
    - {platform}_requests_today += 1
    - {platform}_requests_month += 1
    - last_used_at = NOW()

11. Inserts row into api_usage (audit log)

12. Returns response to user's MCP client
```

### Stripe Checkout Flow

```
1. User clicks "Upgrade to Pro" on dashboard
2. Frontend calls POST /api/stripe/checkout { plan: "pro", userId, email }
3. Server gets/creates Stripe customer → saves stripe_customer_id to profiles
4. Creates Stripe Checkout session → returns URL
5. User enters payment on Stripe's hosted page
6. Stripe sends webhook to POST /api/stripe/webhook
7. Webhook handler:
   a. Verifies Stripe signature
   b. On checkout.session.completed:
      - Creates row in subscriptions
      - Updates profiles.plan → "pro"
      - Updates ALL active api_keys.plan → "pro"
   c. On subscription.updated: updates subscription record
   d. On subscription.deleted:
      - Updates subscription.status → "canceled"
      - Updates profiles.plan → "free"
      - Updates ALL active api_keys.plan → "free"
```

---

## Plan Change Protocol

### ⚠️ CRITICAL: What MUST change together

When a user's plan changes, **THREE things must update atomically:**

```sql
-- Step 1: Update the profile
UPDATE profiles SET plan = 'pro' WHERE id = 'user-uuid';

-- Step 2: Update ALL active API keys for that user
UPDATE api_keys SET plan = 'pro' WHERE user_id = 'user-uuid' AND active = true;

-- Step 3: (Optional) Create/update subscription record
INSERT INTO subscriptions (user_id, stripe_subscription_id, status, ...) VALUES (...);
```

**If you only update profiles.plan but NOT api_keys.plan**, the API will read the key's plan field (which is still 'free') and apply free-tier rate limits. The dashboard will show "Pro" but the actual API calls will be rate-limited as free.

**This is why the Stripe webhook handler does both in one flow.**

### Manual Plan Change (for testing/support)

```sql
-- To upgrade a user to Pro manually:
DO $$
DECLARE
  uid UUID;
BEGIN
  SELECT id INTO uid FROM profiles WHERE email = 'user@example.com';
  UPDATE profiles SET plan = 'pro' WHERE id = uid;
  UPDATE api_keys SET plan = 'pro' WHERE user_id = uid AND active = true;
END $$;

-- To downgrade back to Free:
DO $$
DECLARE
  uid UUID;
BEGIN
  SELECT id INTO uid FROM profiles WHERE email = 'user@example.com';
  UPDATE profiles SET plan = 'free' WHERE id = uid;
  UPDATE api_keys SET plan = 'free' WHERE user_id = uid AND active = true;
END $$;
```

### What reads the plan field

| Code Location | Reads From | Why |
|---------------|-----------|-----|
| MCP endpoint (`/api/mcp`) | `api_keys.plan` | Rate limiting + tool access per request |
| Dashboard (`/dashboard`) | `profiles.plan` via GET /api/keys | Shows plan badge, upgrade CTA |
| Key creation (`POST /api/keys`) | `profiles.plan` | New key inherits user's plan |
| Stripe webhooks | Updates both | Keeps them in sync |
| Key listing (`GET /api/keys`) | Returns `profiles.plan` | Dashboard knows the plan |

---

## What to Change & When

### Quick Reference Table

| Scenario | Change profiles.plan | Change api_keys.plan | Create subscription | Why |
|----------|---------------------|---------------------|--------------------|----|
| User upgrades via Stripe | ✅ (webhook) | ✅ (webhook) | ✅ (webhook) | Full flow |
| Manual upgrade for testing | ✅ | ✅ | ❌ (optional) | Must do both |
| User cancels | ✅ → 'free' (webhook) | ✅ → 'free' (webhook) | ✅ status → 'canceled' | Downgrade |
| User creates new API key | ❌ | New row inherits plan | ❌ | Auto from profiles.plan |
| User revokes API key | ❌ | Sets active=false | ❌ | Soft delete only |

### Never Do This

| ❌ Don't | Why | What to do instead |
|----------|-----|--------------------|
| Store plaintext API keys | Security breach. Even DB admins shouldn't see them. | Only store SHA-256 hash + first 12 chars prefix |
| Change profiles.plan without changing api_keys.plan | Dashboard shows new plan but API enforces old limits | Always update both together |
| Delete from api_keys | Loses audit trail. Breaks FK from api_usage. | Set active = false (soft delete) |
| Use service_role key in browser | Bypasses all security. Full database access. | Only use in server-side API routes |
| Use getSession() for auth | Reads from cookies, can be forged. | Always use getUser() (validates JWT server-side) |

---

## Emergency Procedures

### Lock out a compromised API key

```sql
UPDATE api_keys SET active = false WHERE key_prefix = 'lmx_compromised';
```

### Lock out a user

```sql
-- Revoke all keys
UPDATE api_keys SET active = false WHERE user_id = (SELECT id FROM profiles WHERE email = 'bad@example.com');

-- (Optional) Ban the auth account via Supabase dashboard
```

### Reset a user's daily counters (for testing)

```sql
UPDATE api_keys SET
  requests_today = 0,
  amazon_requests_today = 0,
  alibaba_requests_today = 0,
  aliexpress_requests_today = 0
WHERE user_id = (SELECT id FROM profiles WHERE email = 'user@example.com');
```

### Reset a user's monthly counters

```sql
UPDATE api_keys SET
  requests_month = 0,
  amazon_requests_month = 0,
  alibaba_requests_month = 0,
  aliexpress_requests_month = 0
WHERE user_id = (SELECT id FROM profiles WHERE email = 'user@example.com');
```

---

## Rate Limits Reference

| Plan | Daily Total | Monthly Total | Amazon (day/mo) | Alibaba (day/mo) | AliExpress (day/mo) |
|------|------------|--------------|-----------------|------------------|---------------------|
| Free | 5 | 50 | 5 / 50 | 0 / 0 | 0 / 0 |
| Pro | 250 | 5,000 | 200 / 4,000 | 25 / 500 | 25 / 500 |
| Business | 1,000 | 25,000 | 800 / 20,000 | 100 / 2,000 | 100 / 3,000 |

**Free plan tools (3 only):** amazon_search_products, amazon_product_details, amazon_keyword_suggestions  
**Pro/Business:** All 19 tools

---

## Max Key Limits Reference

| Plan | Max Active Keys |
|------|----------------|
| Free | 2 |
| Pro | 5 |
| Business | 20 |

**Enforced at:** POST /api/keys (checks count of active keys before creating new one)

---

## Stripe Price IDs

| Plan | Price ID | Mode |
|------|----------|------|
| Pro | `price_1Ta0JiAlLFBk4pDrwqD0GDL6` | Test |
| Business | `price_1Ta0JiAlLFBk4pDrx4UjxwHa` | Test |

**Stripe account:** support@moltstudios.app  
**Webhook secret:** Stored in `.env.local` as `STRIPE_WEBHOOK_SECRET`  
**Currently in TEST MODE** — need live keys for real payments.

---

## Migrations Applied

| File | Description |
|------|-------------|
| `001_create_schema.sql` | Base tables: profiles, api_keys, api_usage, subscriptions |
| `002_indexes_rls_triggers.sql` | Indexes, RLS policies, updated_at trigger |
| `003_three_tier_platform_limits.sql` | 3-tier pricing, per-platform counters, plan CHECK updated to include 'business' |

**Location:** `~/agency/projects/lumnix/supabase/migrations/`

---

## Supabase Management API

For admin operations (requires personal access token):

```bash
curl -s -X POST "https://api.supabase.com/v1/projects/srfunhstbufgteiyggur/database/query" \
  -H 'Authorization: Bearer YOUR_SUPABASE_ACCESS_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"query": "YOUR SQL HERE"}'
```

**Token location:** TOOLS.md in Ghost's workspace  
**⚠️ This token has full admin access. Never commit it to git.**

---

## Shared with Mission Control

This Supabase project also contains MC tables (mc_activity, mc_agent_status, mc_lead_categories, mc_leads, mc_research, mc_tasks, mc_tools, opendrones_waitlist). These are **completely independent** — no foreign keys to Lumnix tables, no shared data.

**Plan:** MC will migrate to its own Supabase project when ready. Lumnix stays here.

**MC security audit:** `~/agency/mission-control-api/DATABASE-SECURITY-OVERVIEW.md`
