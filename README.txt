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
- Required production environment variable: JANGL_API_TOKEN
- Optional source identifier: JANGL_SOURCE_ID (defaults to teddydrive_auto_quote)
- Optional test base URL: JANGL_API_BASE_URL=https://test-api.jangl.com/v2/auto_insurance
- Production defaults to https://api.jangl.com/v2/auto_insurance
- Never expose JANGL_API_TOKEN in HTML or browser JavaScript.
