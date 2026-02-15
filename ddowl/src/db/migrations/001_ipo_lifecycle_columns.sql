-- Migration 001: IPO Lifecycle Columns
-- Adds deal details + industry to support Active → Historical lifecycle

BEGIN;

-- Companies: add industry fields
ALTER TABLE companies ADD COLUMN IF NOT EXISTS industry VARCHAR(200);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS sub_industry VARCHAR(200);

-- Deals: add deal detail fields
ALTER TABLE deals ADD COLUMN IF NOT EXISTS deal_type VARCHAR(100);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS shares_offered DECIMAL(15,0);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS price_hkd DECIMAL(10,2);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS size_hkdm DECIMAL(12,3);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS is_dual_listing BOOLEAN DEFAULT FALSE;

-- Deal Appointments: fix schema to use roles array instead of single role
-- Add raw_role column if missing
ALTER TABLE deal_appointments ADD COLUMN IF NOT EXISTS raw_role VARCHAR(200);

-- If 'role' column exists (single enum), migrate to 'roles' array
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'deal_appointments' AND column_name = 'role'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'deal_appointments' AND column_name = 'roles'
  ) THEN
    ALTER TABLE deal_appointments ADD COLUMN roles bank_role[];
    UPDATE deal_appointments SET roles = ARRAY[role];
    ALTER TABLE deal_appointments DROP COLUMN role;
  END IF;
END $$;

-- If 'roles' column doesn't exist at all, add it
ALTER TABLE deal_appointments ADD COLUMN IF NOT EXISTS roles bank_role[];

-- Deal Validations table
CREATE TABLE IF NOT EXISTS deal_validations (
  id SERIAL PRIMARY KEY,
  deal_id INTEGER REFERENCES deals(id) NOT NULL UNIQUE,
  is_correct BOOLEAN,
  notes TEXT,
  validated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS deals_active_company_idx
  ON deals(company_id) WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS appointments_deal_bank_idx
  ON deal_appointments(deal_id, bank_id);

COMMIT;
