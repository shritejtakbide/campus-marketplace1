-- ====================================================================
-- CAMPUS MARKETPLACE — COMPLETE TARGET DATABASE SCHEMA
-- Version: 2.0 (Phase 2 Foundation)
-- Engine: InnoDB | Charset: utf8mb4 | Collation: utf8mb4_unicode_ci
-- ====================================================================

CREATE DATABASE IF NOT EXISTS `campus_marketplace`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE `campus_marketplace`;

-- --------------------------------------------------------------------
-- 1. USERS TABLE
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `users` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(100) NOT NULL,
  `email` VARCHAR(255) NOT NULL UNIQUE,
  `password_hash` VARCHAR(255) NOT NULL,
  `role` ENUM('student', 'admin') NOT NULL DEFAULT 'student',
  `email_verified` BOOLEAN NOT NULL DEFAULT 0,
  `registration_status` ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  `registration_reviewed_by` INT NULL,
  `registration_reviewed_at` TIMESTAMP NULL,
  `registration_rejection_reason` VARCHAR(255) NULL,
  `student_verification_status` ENUM('unverified', 'pending', 'verified', 'rejected') NOT NULL DEFAULT 'unverified',
  `verified` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`registration_reviewed_by`) REFERENCES `users`(`id`) ON DELETE SET NULL,
  INDEX `idx_user_email` (`email`),
  INDEX `idx_user_role` (`role`),
  INDEX `idx_user_reg_status` (`registration_status`),
  INDEX `idx_user_verif_status` (`student_verification_status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------
-- 2. EMAIL OTPS TABLE (Email Verification Codes)
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
-- 3. SESSIONS TABLE (Bearer Token Authentication)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `sessions` (
  `token` VARCHAR(255) PRIMARY KEY,
  `user_id` INT NOT NULL,
  `expires_at` TIMESTAMP NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`)
    REFERENCES `users`(`id`)
    ON DELETE CASCADE,
  INDEX `idx_session_user` (`user_id`),
  INDEX `idx_session_expires` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------
-- 4. PRODUCTS TABLE (Marketplace Listings)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `products` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL,
  `category` VARCHAR(100) NOT NULL,
  `price` DECIMAL(10, 2) NOT NULL,
  `description` TEXT NOT NULL,
  `seller_id` INT NOT NULL,
  `status` ENUM('active', 'sold', 'archived') NOT NULL DEFAULT 'active',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`seller_id`)
    REFERENCES `users`(`id`)
    ON DELETE CASCADE,
  INDEX `idx_product_category` (`category`),
  INDEX `idx_product_seller` (`seller_id`),
  INDEX `idx_product_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------
-- 5. VERIFICATION TABLE (Student ID Proof Submissions)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `verification` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `student_name` VARCHAR(150) NOT NULL,
  `student_email` VARCHAR(150) NOT NULL,
  `student_id` VARCHAR(100) NOT NULL,
  `department` VARCHAR(150) NOT NULL,
  `document_name` VARCHAR(255) NOT NULL,
  `document_path` VARCHAR(500) DEFAULT 'mysql',
  `document_data` LONGTEXT NULL,
  `status` ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  `admin_notes` TEXT NULL,
  `reviewed_by` INT NULL,
  `reviewed_at` TIMESTAMP NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`user_id`)
    REFERENCES `users`(`id`)
    ON DELETE CASCADE,
  FOREIGN KEY (`reviewed_by`)
    REFERENCES `users`(`id`)
    ON DELETE SET NULL,
  INDEX `idx_verif_user` (`user_id`),
  INDEX `idx_verif_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------
-- 6. LEGACY CHATS TABLE (Preserved for Backward Compatibility)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `chats` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `product_id` INT NOT NULL,
  `sender_id` INT NOT NULL,
  `message` TEXT NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`product_id`)
    REFERENCES `products`(`id`)
    ON DELETE CASCADE,
  FOREIGN KEY (`sender_id`)
    REFERENCES `users`(`id`)
    ON DELETE CASCADE,
  INDEX `idx_chats_product` (`product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------
-- 7. CHAT THREADS TABLE (Scoped Buyer-Seller Conversations)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `chat_threads` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `product_id` INT NOT NULL,
  `buyer_id` INT NOT NULL,
  `seller_id` INT NOT NULL,
  `last_message_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_product_buyer_seller` (`product_id`, `buyer_id`, `seller_id`),
  FOREIGN KEY (`product_id`)
    REFERENCES `products`(`id`)
    ON DELETE CASCADE,
  FOREIGN KEY (`buyer_id`)
    REFERENCES `users`(`id`)
    ON DELETE CASCADE,
  FOREIGN KEY (`seller_id`)
    REFERENCES `users`(`id`)
    ON DELETE CASCADE,
  INDEX `idx_thread_buyer` (`buyer_id`),
  INDEX `idx_thread_seller` (`seller_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------
-- 8. CHAT MESSAGES TABLE (Messages within a Thread)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `chat_messages` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `thread_id` INT NOT NULL,
  `sender_id` INT NOT NULL,
  `message` TEXT NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`thread_id`)
    REFERENCES `chat_threads`(`id`)
    ON DELETE CASCADE,
  FOREIGN KEY (`sender_id`)
    REFERENCES `users`(`id`)
    ON DELETE CASCADE,
  INDEX `idx_thread_messages` (`thread_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
