const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

// Ensure .env is loaded via centralized env_loader across all execution contexts
const { resolveEnvPath, loadEnv } = require("./env_loader.js");

const SMTP_PLACEHOLDERS = [
  "smtp.example.com",
  "your_smtp_username",
  "your_smtp_password",
  "your_gmail_address@gmail.com",
  "your_16_char_gmail_app_password"
];

/**
 * Checks whether SMTP credentials and host are configured in the environment.
 * Rejects placeholder defaults and ensures user+pass are present for authenticated services.
 */
function isSmtpConfigured() {
  const host = process.env.SMTP_HOST ? process.env.SMTP_HOST.trim() : "";
  const user = process.env.SMTP_USER ? process.env.SMTP_USER.trim() : "";
  const pass = process.env.SMTP_PASS ? process.env.SMTP_PASS.trim() : "";

  if (!host || host === "smtp.example.com") {
    return false;
  }

  // Reject placeholder values
  if (SMTP_PLACEHOLDERS.includes(user) || SMTP_PLACEHOLDERS.includes(pass)) {
    return false;
  }

  // For Gmail or authenticated SMTP, user and pass are required
  if (host.includes("gmail") || user) {
    return Boolean(user && pass);
  }

  // Local unauthenticated relay
  return true;
}

/**
 * Safe SMTP configuration diagnostic that reports only whether required fields are present
 * and non-placeholder, NEVER exposing secret values, passwords, or credential lengths.
 */
function getSmtpDiagnostic() {
  const envPath = resolveEnvPath();
  const envFileExists = fs.existsSync(envPath);

  const host = process.env.SMTP_HOST ? process.env.SMTP_HOST.trim() : "";
  const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
  const secure = process.env.SMTP_SECURE === "true" || port === 465;
  const user = process.env.SMTP_USER ? process.env.SMTP_USER.trim() : "";
  const pass = process.env.SMTP_PASS ? process.env.SMTP_PASS.trim() : "";
  const from = process.env.SMTP_FROM ? process.env.SMTP_FROM.trim() : "";
  const appBaseUrl = process.env.APP_BASE_URL ? process.env.APP_BASE_URL.trim() : "";

  const hostPresent = Boolean(host);
  const hostIsPlaceholder = SMTP_PLACEHOLDERS.includes(host);
  const portPresent = Boolean(process.env.SMTP_PORT);
  const userPresent = Boolean(user);
  const userIsPlaceholder = SMTP_PLACEHOLDERS.includes(user);
  const passPresent = Boolean(pass);
  const passIsPlaceholder = SMTP_PLACEHOLDERS.includes(pass);
  const fromPresent = Boolean(from);
  const appBaseUrlPresent = Boolean(appBaseUrl);

  const isConfigured = hostPresent && !hostIsPlaceholder &&
                       userPresent && !userIsPlaceholder &&
                       passPresent && !passIsPlaceholder;

  const missingFields = [];
  if (!hostPresent || hostIsPlaceholder) missingFields.push("SMTP_HOST");
  if (!userPresent || userIsPlaceholder) missingFields.push("SMTP_USER");
  if (!passPresent || passIsPlaceholder) missingFields.push("SMTP_PASS");

  return {
    envPath,
    envFileExists,
    isConfigured,
    transporterConfigured: isSmtpConfigured(),
    provider: host.includes("gmail") ? "Gmail SMTP" : (host ? "Custom SMTP" : "Unset"),
    fields: {
      SMTP_HOST: { configured: hostPresent && !hostIsPlaceholder, isPlaceholder: hostIsPlaceholder },
      SMTP_PORT: { configured: portPresent, port: portPresent ? port : 587 },
      SMTP_SECURE: { configured: Boolean(process.env.SMTP_SECURE), secure },
      SMTP_USER: { configured: userPresent && !userIsPlaceholder, isPlaceholder: userIsPlaceholder },
      // CRITICAL: NEVER return or log pass value or character length
      SMTP_PASS: { configured: passPresent && !passIsPlaceholder, isPlaceholder: passIsPlaceholder },
      SMTP_FROM: { configured: fromPresent },
      APP_BASE_URL: { configured: appBaseUrlPresent }
    },
    missingFields,
    recommendations: isConfigured ? [] : [
      ...(!hostPresent || hostIsPlaceholder ? ["Set SMTP_HOST=smtp.gmail.com in .env"] : []),
      ...(!portPresent ? ["Set SMTP_PORT=587 in .env"] : []),
      ...(!userPresent || userIsPlaceholder ? ["Set SMTP_USER to your Gmail address in .env"] : []),
      ...(!passPresent || passIsPlaceholder ? ["Set SMTP_PASS to your 16-character Google App Password in .env (generate at https://myaccount.google.com/apppasswords)"] : [])
    ]
  };
}

/**
 * Verifies live connection and authentication with the configured SMTP server without sending an email.
 * Returns a safe status report. Never leaks credentials in error logs or output.
 */
async function verifySmtpConnection() {
  const diag = getSmtpDiagnostic();
  if (!diag.isConfigured) {
    return {
      success: false,
      isConfigured: false,
      diagnostic: diag,
      error: `SMTP is not configured in .env. Missing or placeholder fields: ${diag.missingFields.join(", ")}.`
    };
  }

  try {
    const transporter = getTransporter();
    await transporter.verify();
    return {
      success: true,
      isConfigured: true,
      diagnostic: diag,
      message: "SMTP server connection and authentication verified successfully."
    };
  } catch (err) {
    // Sanitize error to avoid leaking any credentials
    const safeError = err.code || err.message || "Failed to connect to SMTP server";
    return {
      success: false,
      isConfigured: true,
      diagnostic: diag,
      error: safeError
    };
  }
}

/**
 * Creates and returns a configured Nodemailer transporter.
 */
function getTransporter() {
  if (process.env.TEST_EMAIL_TRANSPORT === "json") {
    // Isolated in-memory transport for deterministic automated testing
    return nodemailer.createTransport({
      jsonTransport: true
    });
  }

  if (!isSmtpConfigured()) {
    throw new Error(
      "SMTP email service is not configured. Please set SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS in .env."
    );
  }

  const port = Number(process.env.SMTP_PORT || 587);
  const secure = process.env.SMTP_SECURE === "true" || port === 465;

  const transportOptions = {
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: (process.env.SMTP_USER && process.env.SMTP_PASS) ? {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    } : undefined,
    // Reasonable timeouts to prevent hanging server connections
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  };

  return nodemailer.createTransport(transportOptions);
}

/**
 * Generates a cryptographically secure 6-digit numeric OTP string.
 */
function generateOtp() {
  // Generates integer between 100000 and 999999 inclusive
  return crypto.randomInt(100000, 1000000).toString();
}

/**
 * Computes the SHA-256 hash of an OTP string for secure database storage.
 */
function hashOtp(otp) {
  if (!otp || typeof otp !== "string") {
    throw new Error("OTP must be a non-empty string");
  }
  return crypto.createHash("sha256").update(otp.trim()).digest("hex");
}

/**
 * Generates the Liquid Glassmorphism HTML email body for OTP delivery.
 */
function buildOtpEmailHtml(otp, expiryMinutes = 10) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Campus Marketplace Email Verification</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #0b0f19;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #f1f5f9;
    }
    .wrapper {
      width: 100%;
      table-layout: fixed;
      background-color: #0b0f19;
      padding: 40px 10px;
    }
    .container {
      max-width: 520px;
      margin: 0 auto;
      background: linear-gradient(135deg, rgba(30, 41, 59, 0.95), rgba(15, 23, 42, 0.95));
      border: 1px solid rgba(56, 189, 248, 0.25);
      border-radius: 16px;
      padding: 36px 28px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5), 0 0 30px rgba(56, 189, 248, 0.1);
    }
    .brand {
      text-align: center;
      margin-bottom: 24px;
    }
    .brand-title {
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.5px;
      background: linear-gradient(135deg, #38bdf8, #818cf8);
      -webkit-background-clip: text;
      -webkit-text-fill-color: #38bdf8;
      margin: 0;
    }
    .brand-sub {
      font-size: 13px;
      color: #94a3b8;
      margin-top: 4px;
    }
    .title {
      font-size: 18px;
      font-weight: 600;
      color: #f8fafc;
      text-align: center;
      margin: 20px 0 10px 0;
    }
    .desc {
      font-size: 14px;
      line-height: 1.6;
      color: #cbd5e1;
      text-align: center;
      margin: 0 0 24px 0;
    }
    .otp-box {
      background: rgba(15, 23, 42, 0.8);
      border: 1px solid rgba(56, 189, 248, 0.4);
      border-radius: 12px;
      padding: 20px;
      text-align: center;
      margin: 20px 0;
    }
    .otp-code {
      font-family: 'Courier New', Courier, monospace;
      font-size: 36px;
      font-weight: 800;
      letter-spacing: 10px;
      color: #38bdf8;
      margin: 0;
      padding-left: 10px; /* Compensate for letter-spacing */
    }
    .expiry {
      font-size: 12px;
      color: #94a3b8;
      margin-top: 10px;
    }
    .notice {
      font-size: 12px;
      color: #64748b;
      line-height: 1.5;
      text-align: center;
      border-top: 1px solid rgba(148, 163, 184, 0.15);
      padding-top: 20px;
      margin-top: 28px;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="brand">
        <h1 class="brand-title">Campus Marketplace</h1>
        <div class="brand-sub">Peer-to-Peer Student Marketplace</div>
      </div>
      <div class="title">Verify Your Email Address</div>
      <p class="desc">
        Welcome to Campus Marketplace! Please use the following 6-digit verification code to complete your email verification and unlock your student marketplace access.
      </p>
      <div class="otp-box">
        <div class="otp-code">${otp}</div>
        <div class="expiry">This code will expire in ${expiryMinutes} minutes</div>
      </div>
      <p class="desc" style="font-size: 13px; color: #94a3b8;">
        If you did not request this verification code, please ignore this email or contact campus support.
      </p>
      <div class="notice">
        Security Reminder: Campus Marketplace staff will never ask you for your verification code or password.
      </div>
    </div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Sends a real email containing the 6-digit OTP to the recipient.
 * @param {string} toEmail 
 * @param {string} rawOtp 
 * @param {number} expiryMinutes 
 * @returns {Promise<object>} Nodemailer send result
 */
async function sendOTPEmail(toEmail, rawOtp, expiryMinutes = 10) {
  if (!toEmail || !toEmail.includes("@")) {
    throw new Error("Invalid recipient email address");
  }

  const transporter = getTransporter();
  const fromAddress = process.env.SMTP_FROM || '"Campus Marketplace" <no-reply@campus.local>';

  const mailOptions = {
    from: fromAddress,
    to: toEmail.trim().toLowerCase(),
    subject: "Verify Your Campus Marketplace Email",
    text: `Your Campus Marketplace verification code is: ${rawOtp}\n\nThis code will expire in ${expiryMinutes} minutes.\nIf you did not create this account, please ignore this email.`,
    html: buildOtpEmailHtml(rawOtp, expiryMinutes)
  };

  const info = await transporter.sendMail(mailOptions);
  return info;
}

/**
 * Generates the Liquid Glassmorphism HTML email body for password recovery.
 */
function buildPasswordResetEmailHtml(resetUrl, expiryMinutes = 30) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Campus Marketplace Password Reset</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #0b0f19;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #f1f5f9;
    }
    .wrapper {
      width: 100%;
      table-layout: fixed;
      background-color: #0b0f19;
      padding: 40px 10px;
    }
    .container {
      max-width: 520px;
      margin: 0 auto;
      background: linear-gradient(135deg, rgba(30, 41, 59, 0.95), rgba(15, 23, 42, 0.95));
      border: 1px solid rgba(56, 189, 248, 0.25);
      border-radius: 16px;
      padding: 36px 28px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5), 0 0 30px rgba(56, 189, 248, 0.1);
    }
    .brand {
      text-align: center;
      margin-bottom: 24px;
    }
    .brand-title {
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.5px;
      background: linear-gradient(135deg, #38bdf8, #818cf8);
      -webkit-background-clip: text;
      -webkit-text-fill-color: #38bdf8;
      margin: 0;
    }
    .brand-sub {
      font-size: 13px;
      color: #94a3b8;
      margin-top: 4px;
    }
    .title {
      font-size: 18px;
      font-weight: 600;
      color: #f8fafc;
      text-align: center;
      margin: 20px 0 10px 0;
    }
    .desc {
      font-size: 14px;
      line-height: 1.6;
      color: #cbd5e1;
      text-align: center;
      margin: 0 0 24px 0;
    }
    .btn-box {
      text-align: center;
      margin: 28px 0;
    }
    .reset-btn {
      display: inline-block;
      background: linear-gradient(135deg, #0284c7, #2563eb);
      color: #ffffff !important;
      text-decoration: none;
      font-size: 15px;
      font-weight: 600;
      padding: 14px 32px;
      border-radius: 10px;
      box-shadow: 0 4px 15px rgba(2, 132, 199, 0.4);
    }
    .link-fallback {
      background: rgba(15, 23, 42, 0.8);
      border: 1px solid rgba(56, 189, 248, 0.2);
      border-radius: 8px;
      padding: 12px;
      font-family: monospace;
      font-size: 11px;
      color: #38bdf8;
      word-break: break-all;
      margin-top: 20px;
      text-align: center;
    }
    .expiry {
      font-size: 12px;
      color: #94a3b8;
      margin-top: 10px;
      text-align: center;
    }
    .notice {
      font-size: 12px;
      color: #64748b;
      line-height: 1.5;
      text-align: center;
      border-top: 1px solid rgba(148, 163, 184, 0.15);
      padding-top: 20px;
      margin-top: 28px;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="brand">
        <h1 class="brand-title">Campus Marketplace</h1>
        <div class="brand-sub">Peer-to-Peer Student Marketplace</div>
      </div>
      <div class="title">Reset Your Password</div>
      <p class="desc">
        We received a request to reset the password for your Campus Marketplace account. Click the button below to choose a new secure password.
      </p>
      <div class="btn-box">
        <a href="${resetUrl}" class="reset-btn" target="_blank" rel="noopener noreferrer">Reset Password</a>
      </div>
      <div class="expiry">This link is single-use and will expire in ${expiryMinutes} minutes.</div>
      <p class="desc" style="font-size: 12px; color: #94a3b8; margin-top: 18px;">
        If the button above does not work, copy and paste this link into your browser:
      </p>
      <div class="link-fallback">${resetUrl}</div>
      <p class="desc" style="font-size: 13px; color: #94a3b8; margin-top: 20px;">
        If you did not request a password reset, no action is needed and your account remains completely secure.
      </p>
      <div class="notice">
        Security Reminder: Campus Marketplace staff will never ask you for your password or reset link.
      </div>
    </div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Sends a password recovery email containing the secure reset URL.
 * @param {string} toEmail 
 * @param {string} resetUrl 
 * @param {number} expiryMinutes 
 * @returns {Promise<object>} Nodemailer send result
 */
async function sendPasswordResetEmail(toEmail, resetUrl, expiryMinutes = 30) {
  if (!toEmail || !toEmail.includes("@")) {
    throw new Error("Invalid recipient email address");
  }

  const transporter = getTransporter();
  const fromAddress = process.env.SMTP_FROM || '"Campus Marketplace" <no-reply@campus.local>';

  const mailOptions = {
    from: fromAddress,
    to: toEmail.trim().toLowerCase(),
    subject: "Reset Your Campus Marketplace Password",
    text: `You requested a password reset for your Campus Marketplace account.\n\nPlease visit the following link to reset your password:\n${resetUrl}\n\nThis link is single-use and will expire in ${expiryMinutes} minutes.\nIf you did not request this, you can safely ignore this message.`,
    html: buildPasswordResetEmailHtml(resetUrl, expiryMinutes)
  };

  const info = await transporter.sendMail(mailOptions);
  return info;
}

module.exports = {
  SMTP_PLACEHOLDERS,
  isSmtpConfigured,
  getSmtpDiagnostic,
  verifySmtpConnection,
  getTransporter,
  generateOtp,
  hashOtp,
  sendOTPEmail,
  buildPasswordResetEmailHtml,
  sendPasswordResetEmail
};
