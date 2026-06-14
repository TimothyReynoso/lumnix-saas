LUMNIX — SECURITY IMPLEMENTATION DOCUMENT
Generated: May 18, 2026
Author: Ghost (CEO, Molt Studios)
Status: Phase 1 Complete, Phase 2-5 Pending

================================================================================
EXECUTIVE SUMMARY
================================================================================

This document covers every security decision, pattern, and implementation detail
for Lumnix — our AI-powered e-commerce research MCP API. Security was researched
through 7 YouTube videos (security experts, Stripe's security team, Supabase
official), 5 web articles, and applied as the FIRST build phase, not the last.

================================================================================
WHY SECURITY MATTERS — REAL-WORLD EXAMPLES
================================================================================

1. CHRIS RAROQUE (114K views, March 2026)
   - Calorie tracking app using Supabase
   - RLS was configured correctly for read/write of user data
   - BUT stored subscription status and rate limits on the SAME TABLE
   - Users could modify their own subscription to give themselves free premium
   - App got hacked, data leaked
   - Lesson: NEVER put security fields on user-editable tables

2. FIREBASE MASS-HACKING WAVE (2024-2025)
   - Firebase had RLS off by default for new projects
   - Thousands of vibe-coded apps had zero security
   - Data breaches everywhere
   - Firebase was forced to auto-lock databases after X days
   - Lesson: Default to locked down, not open

3. $30,000 AWS BILL (Chris Raroque, personal)
   - Environment variable leaked (AWS key with too many permissions)
   - No budget cap set
   - Attacker used the key to run ML training on AWS SageMaker
   - Bill was eventually waived to $2,000 but still painful
   - Lesson: Budget caps on EVERYTHING

4. STRIPE KEY LEAKS (Stripe Security Team, Stripe Sessions 2025)
   - 31% of former employees still have access to company systems
   - Keys end up in frontend source code, environment variables
   - Attackers use leaked keys for data exfiltration, then escalate to phishing
   - Lesson: Restricted keys, IP allowlisting, SSO, regular rotation

================================================================================
OUR 4-TABLE ARCHITECTURE
================================================================================

TABLE 1: profiles
Purpose: User account data tied to Supabase Auth
What users CAN do: Read own profile, update name/email
What users CANNOT do: Change plan, change stripe_customer_id
RLS Policy:
  - SELECT: auth.uid() = supabase_id (read own only)
  - UPDATE: auth.uid() = supabase_id AND plan stays same (blocks plan escalation)
  - INSERT: None for users (trigger auto-creates on signup)
  - DELETE: None for users (service_role only)
Columns: id, supabase_id, email, name, plan, stripe_customer_id, created_at, updated_at

TABLE 2: api_keys
Purpose: API key storage and validation
What users CAN do: View their own keys (prefix only, never full key)
What users CANNOT do: Create, update, or delete keys directly
RLS Policy:
  - SELECT: User can see own keys via join through profiles
  - INSERT/UPDATE/DELETE: NO USER POLICIES — service_role only
Security: Keys stored as SHA-256 hashes. Full key shown ONCE at creation, then only prefix visible.
Columns: id, user_id, key_hash, key_prefix, name, plan, requests_today, requests_total, last_used_at, created_at, expires_at, active

TABLE 3: api_usage
Purpose: Track every API call for rate limiting and analytics
What users CAN do: View their own usage stats
What users CANNOT do: Modify or delete any usage records
RLS Policy:
  - SELECT: User can see own usage via join through profiles
  - INSERT/UPDATE/DELETE: NO USER POLICIES — service_role only
Columns: id, api_key_id, user_id, endpoint, tool_name, tokens_used, response_time_ms, created_at

TABLE 4: subscriptions
Purpose: Stripe subscription data
What users CAN do: View their own subscription status
What users CANNOT do: Create, update, or delete subscriptions
RLS Policy:
  - SELECT: User can see own subscription via join through profiles
  - INSERT/UPDATE/DELETE: NO USER POLICIES — written only by Stripe webhooks (service_role)
Columns: id, user_id, stripe_subscription_id, stripe_price_id, status, current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at

================================================================================
SECURITY PATTERNS IMPLEMENTED
================================================================================

PATTERN 1: SEPARATION OF SECURITY DATA FROM USER DATA
----------------------------------------------------------
Problem: If users can write to a table, they can modify any column on it.
Solution: Security-sensitive columns (plan, subscription status) are either:
  a) On tables where users have NO write policy (api_keys, subscriptions)
  b) Protected by WITH CHECK constraints that prevent changing the column (profiles)
Why: This is the #1 vulnerability in vibe-coded Supabase/Firebase apps.

PATTERN 2: SHA-256 HASHED API KEYS
----------------------------------------------------------
Flow:
  1. Generate random key: lmx_<32 random chars>
  2. Hash with SHA-256
  3. Store ONLY the hash + prefix (first 12 chars)
  4. Show full key to user ONCE at creation
  5. On validation: hash incoming key → compare to stored hash
Why: Even if database leaks, keys are useless without the original plaintext.

PATTERN 3: SERVICE_ROLE ISOLATION
----------------------------------------------------------
Frontend: Gets anon key (public, safe to expose) + user JWT
API Routes: Use service_role key (bypasses RLS) for mutations
NEVER: Service_role key appears in frontend code or environment variables
Why: RLS only works if the client respects it. Service_role bypasses RLS
so API routes can do things users can't (create keys, update plans, etc.)

PATTERN 4: AUTO-PROFILE TRIGGER
----------------------------------------------------------
When a user signs up via Supabase Auth:
  1. PostgreSQL trigger fires (on_auth_user_created)
  2. Automatically inserts a row into public.profiles
  3. Uses SECURITY DEFINER (runs as function creator, not caller)
Why: No race condition between signup and profile creation. No missing profiles.

PATTERN 5: WEBHOOK SIGNATURE VERIFICATION (Phase 3-4)
----------------------------------------------------------
For Stripe webhooks:
  1. Stripe signs every webhook with stripe-signature header
  2. Verify using stripe.webhooks.constructEvent(body, sig, secret)
  3. If signature invalid → DROP the event, no exceptions
  4. Also IP-allowlist Stripe's documented IP ranges (defense in depth)
Why: Without verification, anyone can send fake webhook events to give
themselves premium access or trigger refunds.

PATTERN 6: RESTRICTED STRIPE KEYS (Phase 3-4)
----------------------------------------------------------
Create a restricted key scoped to EXACTLY what we need:
  - checkout.sessions.create
  - customers.create, customers.read
  - subscriptions.read, subscriptions.write
  - webhook_endpoints
Plus: IP-restrict to Vercel's server ranges
Why: Even if key leaks, attacker can only do checkout/subscription operations,
not access dashboard, issue refunds, or read all customer data.

PATTERN 7: MULTI-LAYER RATE LIMITING
----------------------------------------------------------
Layer 1: Per-key (tracked in api_keys.requests_today)
  - Free: 100/day, 1000/month
  - Pro: 10,000/day, 100,000/month
Layer 2: Per-user (sum of all keys for a user)
Layer 3: Per-IP (Vercel Edge Middleware, blocks account spinning)
Why: If someone creates a million accounts, IP limiting stops them.
If someone rotates IPs, per-key limiting still caps damage.

================================================================================
INDEXES (Performance Security)
================================================================================

idx_api_keys_key_hash     — Fast key lookups on every API call
idx_api_keys_user_id      — Fast "list my keys" queries
idx_api_keys_active       — Partial index on active keys only (WHERE active = TRUE)
idx_api_usage_created_at  — Fast date-range queries for usage analytics
idx_api_usage_user_id     — Fast "my usage" queries
idx_subscriptions_user_id — Fast "my subscription" queries
idx_subscriptions_stripe_id — Fast webhook lookups by Stripe subscription ID
idx_profiles_supabase_id  — Fast auth-to-profile joins
idx_profiles_stripe_customer — Fast Stripe customer lookups

================================================================================
TRIGGERS
================================================================================

1. on_auth_user_created (auth.users → public.profiles)
   Fires: AFTER INSERT on auth.users
   Action: Creates profile row with id, email, name from auth metadata
   Uses SECURITY DEFINER: Runs as function owner, not calling user

2. profiles_updated_at (public.profiles)
   Fires: BEFORE UPDATE on profiles
   Action: Sets updated_at = NOW()

3. subscriptions_updated_at (public.subscriptions)
   Fires: BEFORE UPDATE on subscriptions
   Action: Sets updated_at = NOW()

================================================================================
HELPER FUNCTIONS
================================================================================

handle_new_user() — Auto-creates profile on signup (SECURITY DEFINER)
update_updated_at() — Auto-timestamps updated_at columns
reset_daily_usage() — Zeros out requests_today on all API keys (SECURITY DEFINER, called daily)

================================================================================
SECURITY CHECKLIST (Pre-Launch)
================================================================================

Database:
  [x] RLS enabled on all 4 tables
  [x] No user write policies on api_keys, api_usage, subscriptions
  [x] Plan column protected from user updates on profiles
  [x] API keys stored as SHA-256 hashes
  [x] Auto-profile trigger on signup
  [ ] Test RLS from anon role (Phase 2)
  [ ] Test RLS from authenticated role (Phase 2)

API:
  [x] Key generation with lmx_ prefix
  [x] SHA-256 hashing function
  [x] Rate limit checking function
  [ ] Auth middleware on /api/mcp (Phase 2)
  [ ] Key validation on every request (Phase 2)
  [ ] Usage logging on every request (Phase 2)
  [ ] Rate limit headers in responses (Phase 2)

Stripe:
  [ ] Restricted API key created (Phase 3)
  [ ] IP allowlisting on key (Phase 3)
  [ ] Webhook signature verification (Phase 4)
  [ ] Idempotent event handling (Phase 4)
  [ ] Customer portal for self-service (Phase 4)

Infrastructure:
  [ ] Supabase spend cap set (Phase 5)
  [ ] Vercel usage alerts set (Phase 5)
  [ ] CORS restricted to lumnix.dev (Phase 5)
  [ ] Security headers (CSP, HSTS) (Phase 5)
  [ ] Environment variables verified (no secrets on frontend) (Phase 2)

================================================================================
SUPABASE PROJECT INFO
================================================================================

Project: Mission-Control
Reference: srfunhstbufgteiyggur
Region: us-east-1
Status: ACTIVE_HEALTHY
Tables: mc_activity, mc_agent_status, mc_lead_categories, mc_leads, mc_research,
        mc_tasks, mc_tools, opendrones_waitlist,
        profiles, api_keys, api_usage, subscriptions (Lumnix)

================================================================================
WHAT COMES NEXT
================================================================================

Phase 2: Supabase Auth + API Routes
  - Wire Google OAuth + email/password into Next.js
  - Build /api/keys (generate, list, revoke)
  - Add auth middleware to /api/mcp
  - Set Supabase env vars in Vercel

Phase 3: Stripe Integration
  - Create products/prices in Stripe dashboard
  - Build /api/stripe/checkout
  - Build /api/stripe/webhook with signature verification
  - Build /api/stripe/portal
  - Create restricted API key with IP allowlisting

Phase 4: Dashboard + Frontend
  - Dashboard showing keys, usage, billing
  - Tied to the real backend (not mock data)

Phase 5: Security Hardening
  - Audit all RLS policies
  - CORS, security headers
  - Rate limiting middleware
  - Budget caps
  - Penetration testing

================================================================================
END OF DOCUMENT
================================================================================
