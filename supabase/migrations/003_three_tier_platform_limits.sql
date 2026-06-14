-- ============================================
-- LUMNIX MIGRATION 003: 3-Tier + Per-Platform Rate Limits
-- ============================================
-- 
-- Changes:
-- 1. Add 'business' to plan CHECK constraints
-- 2. Add per-platform counter columns to api_keys
-- 3. Add requests_month column to api_keys
-- 4. Update reset_daily_usage() for per-platform + monthly resets
-- 5. Add indexes for new columns
-- ============================================

-- 1. Update CHECK constraints for 3-tier plans
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_plan_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_plan_check CHECK (plan IN ('free', 'pro', 'business'));

ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_plan_check;
ALTER TABLE public.api_keys ADD CONSTRAINT api_keys_plan_check CHECK (plan IN ('free', 'pro', 'business'));

-- 2. Add per-platform daily counter columns to api_keys
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS amazon_requests_today INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS alibaba_requests_today INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS aliexpress_requests_today INTEGER NOT NULL DEFAULT 0;

-- 3. Add per-platform monthly counter columns to api_keys
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS amazon_requests_month INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS alibaba_requests_month INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS aliexpress_requests_month INTEGER NOT NULL DEFAULT 0;

-- 4. Add total monthly counter to api_keys
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS requests_month INTEGER NOT NULL DEFAULT 0;

-- 5. Update reset_daily_usage() to reset ALL counters
CREATE OR REPLACE FUNCTION public.reset_daily_usage()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Reset daily counters
  UPDATE public.api_keys SET
    requests_today = 0,
    amazon_requests_today = 0,
    alibaba_requests_today = 0,
    aliexpress_requests_today = 0;
  
  -- On 1st of month, also reset monthly counters
  IF EXTRACT(DAY FROM NOW()) = 1 THEN
    UPDATE public.api_keys SET
      requests_month = 0,
      amazon_requests_month = 0,
      alibaba_requests_month = 0,
      aliexpress_requests_month = 0;
  END IF;
END;
$$;

-- 6. Indexes for per-platform counters (useful for analytics)
CREATE INDEX IF NOT EXISTS idx_api_keys_plan ON public.api_keys(plan);

-- 7. Atomic counter increment function (prevents TOCTOU race condition)
CREATE OR REPLACE FUNCTION public.increment_usage_counters(
  p_key_id UUID,
  p_platform_daily TEXT,
  p_platform_monthly TEXT
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  EXECUTE format(
    'UPDATE public.api_keys SET
      requests_today = requests_today + 1,
      requests_total = requests_total + 1,
      requests_month = requests_month + 1,
      %1$I = %1$I + 1,
      %2$I = %2$I + 1,
      last_used_at = NOW()
    WHERE id = $1',
    p_platform_daily,
    p_platform_monthly
  ) USING p_key_id;
END;
$$;
