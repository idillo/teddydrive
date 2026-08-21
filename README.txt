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
- Each buyer's Test/Production environment is controlled in Admin and published with its routing configuration
- Runtime buyer routing comes from BUYER_ROUTING_CONFIG; submission never queries buyer configuration from the database
- Jangl variables: JANGL_API_BASE_URL, JANGL_API_TOKEN, JANGL_SOURCE_ID, JANGL_OFFER_ID
- Admin publishing variables: VERCEL_API_TOKEN, VERCEL_PROJECT_ID, optional VERCEL_TEAM_ID, and VERCEL_DEPLOY_HOOK_URL

ADMIN
- Page: /admin.html
- Supabase Auth plus ADMIN_EMAILS protects all admin API operations
- Browser roles have no table privileges; server operations use the secret key
- Buyer routing states: off, direct_post, ping_post
- New buyers default to off and test
- Saving a buyer token writes a sensitive Vercel environment variable; Publish Routing writes the routing snapshot and invokes the deploy hook
- Browser redirects immediately; lead insert and all buyer deliveries begin in parallel

MANUAL SETUP ORDER (NOT PERFORMED BY CODEX)
1. Review and apply the SQL migration to the intended Supabase project.
2. Create Supabase Auth users and set ADMIN_EMAILS.
3. Set CRON_SECRET. Keep new buyers Off until their test configuration is saved and verified.
4. Create a Vercel access token and deploy hook, then set the Admin publishing variables once.
5. In /admin.html, create buyers while Off, enter TEST endpoint configuration and credentials, then save drafts.
6. Publish routing, wait for the deployment to become Ready, and run Send synthetic test.
7. Submit a test lead and verify every attempt in the lead detail view.
8. Activate production routing through the same reviewed publish-and-deploy process.

Never expose SUPABASE_SECRET_KEY or buyer credentials in HTML or browser JavaScript.
