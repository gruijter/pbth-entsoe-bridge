Power by the Hour - ENTSO-E Energy Bridge
Overview
This repository contains the highly optimized Cloudflare Worker implementation for the "Power by the Hour" ENTSO-E Energy Bridge (v4.5 R2 Edition).

It acts as a lightning-fast, highly scalable middleman between the ENTSO-E Transparency Platform (Subscription Push Service) and a fleet of 16,000+ Homey smart home controllers.

🚀 Architecture: "God Mode" (v4.5 R2 Edition)
The bridge is designed to handle millions of daily requests for free, bypassing traditional database and Serverless execution limits:

Cloudflare R2 Storage: KV storage has been completely removed. Static JSON files are generated upon receiving an XML push from ENTSO-E.

CDN Edge Caching: Homey apps download the .json files directly from the Cloudflare CDN, saving 100% of Worker execution limits for actual ENTSO-E pushes.

Smart Diff Checker: The Worker checks incoming XML against existing R2 data. It only writes to R2 if the prices actually changed, drastically saving on PUT operations.

Bulletproof Parser: Automatically ignores corrupt <price.amount> tags (NaN) or missing timestamps pushed by local TSOs. Future data is safely preserved during partial historical updates.

Strict SOAP Compliance: Automatically parses and returns the mandatory IEC 62325-504 ResponseMessage to keep ENTSO-E servers happy.

📡 API Endpoints (For the Homey App)
All requests from the Homey app should be standard HTTP GET requests directed at the public R2 domain.

Check Data Availability: GET https://entsoe-prices.gruijter.org/status.json
Returns an index of all supported zones, their last update timestamp, and a crucial is_complete_tomorrow boolean. Use this for "Smart Polling".

Fetch Zone Prices: GET https://entsoe-prices.gruijter.org/[EIC_CODE].json
Example: .../10YNL----------L.json returns the pruned 48-hour price array for the Netherlands.

Legacy Endpoints: Any legacy requests hitting the Worker directly (e.g., /?status or /?zone=...) will automatically return a 301 Redirect to the static R2 URL to force clients onto the CDN.

🛠 Deployment & Configuration
1. Cloudflare R2 Setup
Create a new R2 bucket in your Cloudflare dashboard named entsoe-prices.

Go to the bucket settings and connect your custom domain (e.g., entsoe-prices.gruijter.org).

2. Edge Caching Setup
To allow Cloudflare to cache the dynamic JSON files and serve millions of requests for free:

Go to your domain settings in Cloudflare -> Caching -> Cache Rules.

Create a rule matching: Hostname equals entsoe-prices.gruijter.org.

Set Cache Eligibility to Eligible for cache.

Set Edge TTL to Respect origin header. (The Worker automatically sends a 5-minute cache header for prices, and a 1-minute header for the status file).

3. Deploy the Worker
Deploy the index.js and wrangler.toml using Wrangler:

npx wrangler deploy

Note: Make sure your wrangler.toml contains the R2 binding ENTSOE_PRICES_R2_BUCKET pointing to your bucket.

4. Initialization
To generate the very first status.json before ENTSO-E pushes its first payload, open your browser and navigate to the Worker url:

GET https://entsoe.gruijter.org/?init=true

⚖️ License & Attribution
Code License (MPL 2.0): The source code in this repository is licensed under the Mozilla Public License 2.0 (MPL 2.0). Copyright 2026 gruijter.org.

Data License (CC BY 4.0): The energy prices distributed by this API are provided by the ENTSO-E Transparency Platform. The data is modified (converted from XML to JSON, pruned, and merged) and distributed under the Creative Commons Attribution 4.0 International License (CC BY 4.0). A legal attribution statement is automatically injected into every generated JSON response.
