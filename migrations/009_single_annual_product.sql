-- Collapse legacy Standard and Premium labels into one annual product.
-- This migration is additive in behavior and preserves all users, payments,
-- deployments, subscription dates, and paid amounts.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_plan_check;
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_plan_check;
ALTER TABLE payment_transactions DROP CONSTRAINT IF EXISTS payment_transactions_plan_check;

UPDATE users SET plan = 'Annual' WHERE plan IN ('Standard', 'Premium');
UPDATE subscriptions SET plan = 'Annual' WHERE plan IN ('Standard', 'Premium');
UPDATE payment_transactions SET plan = 'Annual' WHERE plan IN ('Standard', 'Premium');

ALTER TABLE users
  ADD CONSTRAINT users_plan_check CHECK (plan = 'Annual');
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_plan_check CHECK (plan = 'Annual');
ALTER TABLE payment_transactions
  ADD CONSTRAINT payment_transactions_plan_check CHECK (plan = 'Annual');
