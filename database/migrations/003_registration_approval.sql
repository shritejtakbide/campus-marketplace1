-- ====================================================================
-- MIGRATION 003: REGISTRATION APPROVAL AUDIT TRAILS
-- Non-destructive schema addition supporting:
-- 1. registration_reviewed_by INT NULL (Audit trail of approving/rejecting admin)
-- 2. registration_reviewed_at TIMESTAMP NULL (Timestamp of decision)
-- 3. registration_rejection_reason VARCHAR(255) NULL (Administrative rejection reason)
-- ====================================================================

ALTER TABLE `users`
  ADD COLUMN IF NOT EXISTS `registration_reviewed_by` INT NULL AFTER `registration_status`,
  ADD COLUMN IF NOT EXISTS `registration_reviewed_at` TIMESTAMP NULL AFTER `registration_reviewed_by`,
  ADD COLUMN IF NOT EXISTS `registration_rejection_reason` VARCHAR(255) NULL AFTER `registration_reviewed_at`;
