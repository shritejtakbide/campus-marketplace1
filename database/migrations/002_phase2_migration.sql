-- ====================================================================
-- MIGRATION 002: PHASE 2 DATABASE FOUNDATION
-- Non-destructive schema upgrade supporting:
-- 1. Distinct account statuses (email_verified, registration_status, student_verification_status)
-- 2. Role-Based Access Control (role ENUM('student', 'admin'))
-- 3. Session expiration timestamps
-- 4. Product lifecycle status
-- 5. Email OTP verification storage
-- 6. Scoped buyer-seller chat threads and messages
-- ====================================================================

-- --------------------------------------------------------------------
-- STEP 1: UPGRADE USERS TABLE
-- --------------------------------------------------------------------
ALTER TABLE `users`
  MODIFY COLUMN `email` VARCHAR(255) NOT NULL,
  MODIFY COLUMN `password_hash` VARCHAR(255) NOT NULL;

-- Add role column (default 'student')
ALTER TABLE `users`
  ADD COLUMN `role` ENUM('student', 'admin') NOT NULL DEFAULT 'student' AFTER `password_hash`;

-- Add email_verified flag (default 0)
ALTER TABLE `users`
  ADD COLUMN `email_verified` BOOLEAN NOT NULL DEFAULT 0 AFTER `role`;

-- Add registration_status (default 'pending')
ALTER TABLE `users`
  ADD COLUMN `registration_status` ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending' AFTER `email_verified`;

-- Add student_verification_status (default 'unverified')
ALTER TABLE `users`
  ADD COLUMN `student_verification_status` ENUM('unverified', 'pending', 'verified', 'rejected') NOT NULL DEFAULT 'unverified' AFTER `registration_status`;

-- Add updated_at timestamp
ALTER TABLE `users`
  ADD COLUMN `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`;

-- --------------------------------------------------------------------
-- STEP 2: UPGRADE SESSIONS TABLE
-- --------------------------------------------------------------------
ALTER TABLE `sessions`
  ADD COLUMN `expires_at` TIMESTAMP NULL AFTER `user_id`;

-- --------------------------------------------------------------------
-- STEP 3: UPGRADE PRODUCTS TABLE
-- --------------------------------------------------------------------
ALTER TABLE `products`
  MODIFY COLUMN `name` VARCHAR(255) NOT NULL;

ALTER TABLE `products`
  ADD COLUMN `status` ENUM('active', 'sold', 'archived') NOT NULL DEFAULT 'active' AFTER `seller_id`;

-- --------------------------------------------------------------------
-- STEP 4: UPGRADE VERIFICATION TABLE
-- --------------------------------------------------------------------
ALTER TABLE `verification`
  ADD COLUMN `admin_notes` TEXT NULL AFTER `status`,
  ADD COLUMN `reviewed_by` INT NULL AFTER `admin_notes`,
  ADD COLUMN `reviewed_at` TIMESTAMP NULL AFTER `reviewed_by`;

-- --------------------------------------------------------------------
-- STEP 5: CREATE EMAIL OTPS TABLE
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `email_otps` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `email` VARCHAR(255) NOT NULL,
  `otp_hash` VARCHAR(64) NOT NULL,
  `attempts` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `expires_at` TIMESTAMP NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_otp_email_expires` (`email`, `expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------
-- STEP 6: CREATE CHAT THREADS TABLE
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `chat_threads` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `product_id` INT NOT NULL,
  `buyer_id` INT NOT NULL,
  `seller_id` INT NOT NULL,
  `last_message_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_product_buyer_seller` (`product_id`, `buyer_id`, `seller_id`),
  FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`buyer_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`seller_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------
-- STEP 7: CREATE CHAT MESSAGES TABLE
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `chat_messages` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `thread_id` INT NOT NULL,
  `sender_id` INT NOT NULL,
  `message` TEXT NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`thread_id`) REFERENCES `chat_threads`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`sender_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  INDEX `idx_thread_messages` (`thread_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------
-- STEP 8: BACKFILL EXISTING RECORDS
-- --------------------------------------------------------------------
-- Set existing sessions to expire in 30 days if null
UPDATE `sessions` SET `expires_at` = DATE_ADD(`created_at`, INTERVAL 30 DAY) WHERE `expires_at` IS NULL;

-- Set existing verified demo student
UPDATE `users`
SET `email_verified` = 1,
    `registration_status` = 'approved',
    `student_verification_status` = 'verified'
WHERE `email` = 'student@campus.local';

-- Legacy User Policy:
-- Preserve legacy registered accounts with registration_status = 'approved' so existing accounts are retained,
-- but strictly enforce email_verified = 0 (unverified) until cryptographic OTP verification is completed.
UPDATE `users`
SET `registration_status` = 'approved',
    `email_verified` = 0
WHERE `email` != 'student@campus.local';
