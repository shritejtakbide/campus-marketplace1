-- ====================================================================
-- MIGRATION 005: AUTHENTICATION SECURITY & PASSWORD RECOVERY
-- Non-destructive schema addition supporting:
-- 1. Cryptographic token-hashed password reset requests
-- 2. Distributed multi-instance login & auth rate limiting via shared store
-- ====================================================================

-- Add password reset tracking columns to users table
ALTER TABLE `users`
  ADD COLUMN IF NOT EXISTS `password_reset_token_hash` VARCHAR(64) NULL AFTER `password_hash`,
  ADD COLUMN IF NOT EXISTS `password_reset_expires_at` TIMESTAMP NULL AFTER `password_reset_token_hash`,
  ADD COLUMN IF NOT EXISTS `password_reset_used_at` TIMESTAMP NULL AFTER `password_reset_expires_at`;

-- Index on password_reset_token_hash for fast, indexed O(1) lookup
-- Note: MariaDB/MySQL 8 support ADD INDEX or idempotent check
