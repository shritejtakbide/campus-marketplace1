const crypto = require("crypto");
const nodemailer = require("nodemailer");

/**
 * Checks whether SMTP credentials and host are configured in the environment.
 */
function isSmtpConfigured() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  // A valid SMTP configuration requires at least a host and either user credentials or local relay host
  return Boolean(host && host.trim() && (user ? user.trim() : true) && host !== "smtp.example.com");
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

module.exports = {
  isSmtpConfigured,
  getTransporter,
  generateOtp,
  hashOtp,
  sendOTPEmail
};
