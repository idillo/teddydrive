FINAL HTML FIX
- Removed the large dead white gap between text and image
- Removed the artificial white fade overlay
- Uses angled blue car artwork
- Teddy has a clearly visible diagonal shoulder seat belt
- Tailwind only; no styles.css
- Phone: 1-855-629-1872 / tel:18556291872

Added without changing layout:
- Marketcall script on all HTML pages
- Anchors: #call-now, #benefits, #how-it-works, #faq, #contact
- FAQ section for Google Ads sitelink

AUTO QUOTE API
- Page: /auto-quote.html
- Serverless handler: /api/auto-quote.js
- Supabase setup: /supabase/migrations/202608200001_leads_buyers_admin.sql
- Required server variables: SUPABASE_URL and SUPABASE_SECRET_KEY
- Required auth variables: SUPABASE_PUBLISHABLE_KEY and ADMIN_EMAILS (comma-separated allowlist)
- Required scheduled-job variable: CRON_SECRET
- BUYER_ENVIRONMENT must be test or production; code defaults safely to test
- Buyer credentials stay in server environment variables; buyer rows store only variable names
- Optional Jangl source identifier: JANGL_SOURCE_ID

ADMIN
- Page: /admin.html
- Supabase Auth plus ADMIN_EMAILS protects all admin API operations
- Browser roles have no table privileges; server operations use the secret key
- Buyer routing states: off, direct_post, ping_post
- New buyers default to off and test; no endpoint is hardcoded or seeded

MANUAL SETUP ORDER (NOT PERFORMED BY CODEX)
1. Review and apply the SQL migration to the intended Supabase project.
2. Create Supabase Auth users and set ADMIN_EMAILS.
3. Set CRON_SECRET and BUYER_ENVIRONMENT=test.
4. In /admin.html, create buyers while Off and enter TEST endpoint configuration.
5. Enable a test buyer and run Send synthetic test.
6. Submit a test lead and verify every attempt in the lead detail view.
7. Configure and activate production manually only after review.

Never expose SUPABASE_SECRET_KEY or buyer credentials in HTML or browser JavaScript.
