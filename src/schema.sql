-- Echo Waitlist v1.0.0 Schema

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'active',
  launch_date TEXT,
  total_signups INTEGER DEFAULT 0,
  max_signups INTEGER,
  custom_fields TEXT DEFAULT '[]',
  brand_color TEXT DEFAULT '#14b8a6',
  logo_url TEXT,
  redirect_url TEXT,
  referral_enabled INTEGER DEFAULT 1,
  referral_reward TEXT DEFAULT 'priority',
  positions_per_referral INTEGER DEFAULT 5,
  confirmation_email INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(tenant_id, slug)
);

CREATE TABLE IF NOT EXISTS signups (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  position INTEGER NOT NULL,
  referral_code TEXT NOT NULL,
  referred_by TEXT,
  referral_count INTEGER DEFAULT 0,
  priority_boost INTEGER DEFAULT 0,
  effective_position INTEGER NOT NULL,
  status TEXT DEFAULT 'active',
  custom_data TEXT DEFAULT '{}',
  ip_hash TEXT,
  confirmed_at TEXT,
  invited_at TEXT,
  converted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(campaign_id, email)
);

CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id TEXT NOT NULL,
  referrer_id TEXT NOT NULL,
  referee_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(campaign_id, referrer_id, referee_id)
);

CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  name TEXT NOT NULL,
  referral_threshold INTEGER NOT NULL,
  reward_type TEXT NOT NULL,
  reward_value TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS milestone_unlocks (
  milestone_id TEXT NOT NULL,
  signup_id TEXT NOT NULL,
  unlocked_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY(milestone_id, signup_id)
);

CREATE TABLE IF NOT EXISTS analytics_daily (
  campaign_id TEXT NOT NULL,
  date TEXT NOT NULL,
  signups INTEGER DEFAULT 0,
  referrals INTEGER DEFAULT 0,
  invites_sent INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  UNIQUE(campaign_id, date)
);

CREATE INDEX IF NOT EXISTS idx_signups_campaign ON signups(campaign_id, position);
CREATE INDEX IF NOT EXISTS idx_signups_email ON signups(campaign_id, email);
CREATE INDEX IF NOT EXISTS idx_signups_referral ON signups(referral_code);
CREATE INDEX IF NOT EXISTS idx_signups_referred ON signups(referred_by);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_analytics_campaign ON analytics_daily(campaign_id, date);
