/**
 * Campus Marketplace — Real SMTP Configuration Diagnostic & Verification Tool
 * 
 * Safely verifies SMTP environment configuration and tests the live server
 * connection without transmitting test emails or exposing secret values.
 * 
 * Reports:
 *   1. The resolved .env path
 *   2. Whether the .env file exists
 *   3. Whether SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS are present (values redacted)
 *   4. Whether the SMTP transporter is configured
 * 
 * Usage:
 *   node backend/verify_smtp.js
 *   npm run verify:smtp
 */

const { getSmtpDiagnostic, verifySmtpConnection } = require("./email_service.js");

async function main() {
  console.log("==================================================");
  console.log("  CAMPUS MARKETPLACE — SMTP CONFIGURATION AUDIT   ");
  console.log("==================================================");

  const diag = getSmtpDiagnostic();

  // 1. Resolved .env path
  console.log(`[1] Resolved .env Path: ${diag.envPath}`);

  // 2. Whether the file exists
  console.log(`[2] .env File Exists: ${diag.envFileExists ? "YES (✓ Found)" : "NO (✗ Not Found)"}`);

  // 3. Whether SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS are present
  console.log("[3] Required SMTP Variables (Secrets REDACTED):");
  const hostInfo = diag.fields.SMTP_HOST;
  const portInfo = diag.fields.SMTP_PORT;
  const userInfo = diag.fields.SMTP_USER;
  const passInfo = diag.fields.SMTP_PASS;

  console.log(`    - SMTP_HOST : ${hostInfo.configured ? "✓ PRESENT" : "✗ MISSING / UNSET"}`);
  console.log(`    - SMTP_PORT : ${portInfo.configured ? `✓ PRESENT (Port ${portInfo.port})` : `✗ MISSING (Default: 587)`}`);
  console.log(`    - SMTP_USER : ${userInfo.configured ? "✓ PRESENT" : "✗ MISSING / UNSET"}`);
  console.log(`    - SMTP_PASS : ${passInfo.configured ? "✓ PRESENT [VALUE REDACTED]" : "✗ MISSING / UNSET"}`);

  // Optional variables
  console.log(`    - SMTP_SECURE: ${diag.fields.SMTP_SECURE.configured ? `✓ PRESENT (${diag.fields.SMTP_SECURE.secure})` : "Default (false)"}`);
  console.log(`    - SMTP_FROM  : ${diag.fields.SMTP_FROM.configured ? "✓ PRESENT" : "Default"}`);
  console.log(`    - APP_BASE_URL: ${diag.fields.APP_BASE_URL.configured ? "✓ PRESENT" : "Default (http://localhost:3000)"}`);

  // 4. Whether the SMTP transporter is configured
  console.log(`\n[4] SMTP Transporter Configured: ${diag.transporterConfigured ? "YES (Ready for live handshake)" : "NO (Incomplete configuration)"}`);

  if (!diag.isConfigured) {
    console.log("\n[STATUS] ✗ SMTP email service is NOT fully configured in .env.");
    console.log(`[MISSING / PLACEHOLDER FIELDS] ${diag.missingFields.join(", ")}`);
    console.log("\n[GMAIL SMTP SETUP INSTRUCTIONS]");
    console.log("  1. Open your local .env file in the code editor.");
    console.log("  2. Add or update the following variables:");
    console.log("     SMTP_HOST=smtp.gmail.com");
    console.log("     SMTP_PORT=587");
    console.log("     SMTP_SECURE=false");
    console.log("     SMTP_USER=your_personal_or_service_email@gmail.com");
    console.log("     SMTP_PASS=your_16_character_app_password");
    console.log("     SMTP_FROM=\"Campus Marketplace <no-reply@campus.local>\"");
    console.log("     APP_BASE_URL=http://localhost:3000");
    console.log("\n  SECURITY NOTICE:");
    console.log("  - SMTP_PASS MUST be a 16-character Google 'App Password', NOT your personal Gmail account password.");
    console.log("  - Generate at: https://myaccount.google.com/apppasswords");
    console.log("  - Never paste real credentials into agent prompts, Git, or public issues.");
    process.exit(1);
  }

  // Step 10: Only after all four variables are detected, perform SMTP connection verification
  console.log("\n[5] All four required variables detected! Testing live connection handshake...");
  console.log("    (Validating authentication with server; NO test email will be sent)");

  const result = await verifySmtpConnection();

  if (result.success) {
    console.log("\n==================================================");
    console.log("  ✓ SUCCESS: REAL SMTP CONNECTION & AUTH VERIFIED  ");
    console.log("==================================================");
    console.log(`  - Provider: ${diag.provider}`);
    console.log("  - Handshake: Successful");
    console.log("  - Authentication: Successful");
    console.log("  - Note: No test email was dispatched (verification only).");
    process.exit(0);
  } else {
    console.log("\n==================================================");
    console.log("  ✗ FAILED: REAL SMTP CONNECTION FAILED           ");
    console.log("==================================================");
    console.log(`  - Error: ${result.error}`);
    console.log("\n  Troubleshooting Tips for Gmail SMTP:");
    console.log("  - EAUTH: Ensure SMTP_USER is your full Gmail address and SMTP_PASS is a 16-character Google App Password (not account password).");
    console.log("  - ETIMEDOUT / ECONNREFUSED: Check firewall rules or try SMTP_PORT=465 with SMTP_SECURE=true.");
    process.exit(1);
  }
}

main().catch(err => {
  console.error("[FATAL] Diagnostic runner error:", err.message);
  process.exit(1);
});
