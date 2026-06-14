-- ============================================
-- 004 Counter Reset Cron Jobs
-- ============================================
-- Enables pg_cron and schedules automatic daily/monthly counter resets.
-- Daily: resets requests_today + per-platform daily counters at midnight UTC
-- Monthly: resets requests_month + per-platform monthly counters on 1st of month at midnight UTC
-- requests_total is NEVER reset (lifetime counter)

-- Enable pg_cron extension
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

-- Daily reset function
CREATE OR REPLACE FUNCTION reset_daily_counters() RETURNS void AS $$
BEGIN
  UPDATE api_keys
  SET requests_today = 0,
      amazon_requests_today = 0,
      alibaba_requests_today = 0,
      aliexpress_requests_today = 0
  WHERE active = true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Monthly reset function
CREATE OR REPLACE FUNCTION reset_monthly_counters() RETURNS void AS $$
BEGIN
  UPDATE api_keys
  SET requests_month = 0,
      amazon_requests_month = 0,
      alibaba_requests_month = 0,
      aliexpress_requests_month = 0
  WHERE active = true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Schedule daily reset: every day at midnight UTC
SELECT cron.schedule(
  'reset-daily-counters',
  '0 0 * * *',
  $$SELECT reset_daily_counters();$$
);

-- Schedule monthly reset: 1st of every month at midnight UTC
SELECT cron.schedule(
  'reset-monthly-counters',
  '0 0 1 * *',
  $$SELECT reset_monthly_counters();$$
);
