# ⚠️ Risk Register & Mitigation Strategy — Campus Marketplace

- **Project Name:** Campus Marketplace
- **Document Version:** 1.0
- **Status:** Draft / Pending User Approval
- **Cross-References:** [PRD.md](file:///c:/Users/Downe/OneDrive/Documents/Campus_Marketplace_Final/docs/PRD.md) | [SRS.md](file:///c:/Users/Downe/OneDrive/Documents/Campus_Marketplace_Final/docs/SRS.md) | [TRD.md](file:///c:/Users/Downe/OneDrive/Documents/Campus_Marketplace_Final/docs/TRD.md) | [SECURITY_PLAN.md](file:///c:/Users/Downe/OneDrive/Documents/Campus_Marketplace_Final/docs/SECURITY_PLAN.md)

---

## 1. Risk Evaluation Methodology

Risks are categorized across **Technical**, **Security**, and **Operational** dimensions and scored using a standard Probability $\times$ Impact matrix:

- **Probability**: Low (1), Medium (2), High (3)
- **Impact**: Low (1), Medium (2), High (3), Critical (4)
- **Risk Score**: Product of Probability and Impact (1–12)
  - 🟢 **Low (1–3)**: Managed via standard development procedures.
  - 🟡 **Medium (4–6)**: Requires specific engineering mitigation and active monitoring.
  - 🔴 **High / Critical (8–12)**: Mandatory architectural controls before release.

---

## 2. Risk Matrix Summary

| Risk ID | Category | Description | Prob | Impact | Score | Primary Mitigation |
| :---: | :--- | :--- | :---: | :---: | :---: | :--- |
| **RSK-TEC-01** | Technical | SMTP email delivery failure / spam filtering of OTP codes | High (3) | High (3) | 🔴 **9** | SMTP fallbacks, institutional whitelist guidelines, development console logger fallback. |
| **RSK-TEC-02** | Technical | MySQL database bloat due to Base64 ID document storage in `LONGTEXT` | Med (2) | Med (2) | 🟡 **4** | Strict 4 MB file cap; client-side image compression; separate table isolation. |
| **RSK-TEC-03** | Technical | Serverless execution timeout during large payload parsing | Low (1) | High (3) | 🟡 **3** | Immediate streaming payload parsing; reject early if `Content-Length > 4MB`. |
| **RSK-SEC-01** | Security | Insecure Direct Object Reference (IDOR) chat data leakage | High (3) | High (3) | 🔴 **9** | Enforce caller ID matching against `chat_threads(buyer_id, seller_id)` on every query. |
| **RSK-SEC-02** | Security | Offline/legacy password exposure if migration is incomplete | Med (2) | Critical (4)| 🔴 **8** | Automated on-login rehash from SHA-256 to salted `bcrypt`; seed new admin account. |
| **RSK-SEC-03** | Security | Admin endpoint brute forcing / credential stuffing | Med (2) | High (3) | 🟡 **6** | Rate-limiting middleware on auth endpoints; minimum 12-char admin password requirement. |
| **RSK-OPS-01** | Operational | Admin approval bottleneck causing user onboarding delays | High (3) | Med (2) | 🟡 **6** | Email alerts to admins on pending requests; batch approval actions in Admin Portal. |
| **RSK-OPS-02** | Operational | User registration drop-off due to multi-step gate (OTP + Admin approval) | Med (2) | Med (2) | 🟡 **4** | Transparent progress indicator in UI; informative waiting screens with estimated review times. |
| **RSK-OPS-03** | Operational | Submission of forged or fraudulent student ID cards | Med (2) | Med (2) | 🟡 **4** | High-resolution image preview modal for admins; strict department and PRN format checks. |

---

## 3. In-Depth Risk Profiles & Action Plans

### 3.1. RSK-TEC-01: SMTP Email Delivery Failure
- **Risk Event**: Institutional spam filters or firewall policies reject incoming OTP emails from the application's SMTP server.
- **Root Cause**: Unconfigured SPF, DKIM, or DMARC records on the sending domain; or invalid SMTP credentials in `.env`.
- **Pre-emptive Mitigation**:
  1. Configure verified transactional email service (e.g., SendGrid, Mailgun, Amazon SES) with proper reverse DNS and SPF/DKIM authentication.
  2. For local testing and staging environments, provide an automatic development fallback that outputs the generated OTP directly into the server console terminal.
  3. Include clear UI guidance: *"Check your campus spam/junk folder. Codes arrive from campusmarketplace@..."*.

### 3.2. RSK-SEC-01: Insecure Direct Object Reference (IDOR) in Chat
- **Risk Event**: A student modifies the URL or payload to read another student's private product negotiation.
- **Root Cause**: The current baseline queries all rows by `product_id` without verifying participant user IDs.
- **Pre-emptive Mitigation**:
  1. Restructure chat data into two distinct relational entities: `chat_threads` and `chat_messages`.
  2. Implement backend authorization checks at the database query level:
     `WHERE m.thread_id = ? AND (t.buyer_id = ? OR t.seller_id = ?)`.
  3. Return HTTP `403 Forbidden` if the caller ID is not a registered participant in the thread.

### 3.3. RSK-SEC-02: Legacy Unsalted SHA-256 Password Exposure
- **Risk Event**: Legacy user records remain stored with unsalted SHA-256 hashes while new users use `bcrypt`.
- **Root Cause**: Schema transition without password reset or migration logic.
- **Pre-emptive Mitigation**:
  1. Expand `password_hash` column to `VARCHAR(255)`.
  2. In the login pipeline, detect whether a stored hash is 64 characters (legacy SHA-256) or starts with `$2b$` (bcrypt).
  3. If legacy SHA-256 matches, immediately re-hash the submitted password using `bcrypt` (12 rounds) and update the database row transparently.

### 3.4. RSK-OPS-01: Administrative Approval Bottleneck
- **Risk Event**: Newly registered students cannot access the marketplace because campus administrators take multiple days to review pending accounts.
- **Root Cause**: Manual administrator gate without automated notifications or batch tooling.
- **Pre-emptive Mitigation**:
  1. Equip the Admin Portal with "Select All" and "Approve Batch" capabilities.
  2. Send email notifications to campus administrators when pending queue exceeds 5 requests.
  3. Clearly separate **Registration Approval** (basic student validation) from **Student ID Verification** (detailed document inspection) so general browsing is not unnecessarily stalled.

---

## 4. Unverified Assumptions & Open Decisions Requiring User Confirmation

> [!NOTE]
> The following operational and technical decisions remain open and require explicit user guidance before Phase 2 implementation begins:

1. **SMTP Provider Selection**: Which email dispatch mechanism will be used? (e.g., standard Gmail SMTP App Password, SendGrid API, Amazon SES, or local console logger for development).
2. **Campus Email Domain Whitelisting**: Should the registration form enforce strict domain matching (e.g., ending in `.edu`, `.ac.in`, or a specific college domain), or accept general emails pending administrator review?
3. **Demo Account Access**: Should the default demo account (`student@campus.local`) remain pre-approved and pre-verified to facilitate evaluator and portfolio testing?
4. **Offline Mode Retention**: Should the offline file-backed JSON prototype in `Campus_Marketplace_Final/` be maintained in parallel or archived into a dedicated `scripts/offline_demo/` folder?
