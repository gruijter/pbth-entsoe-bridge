# pbth-entsoe-bridge

⚡ PBTH ENTSO-E Energy Bridge (v1.5)
A robust, secure, and high-performance proxy built on Cloudflare Workers to deliver Day-Ahead energy prices from ENTSO-E to Homey and the Power by the Hour community.

🚀 Key Features
36h Rolling Window: Automatically prunes old price data while ensuring "today's" data is fully available for all European time zones.

Sequence Prioritization: Always prioritizes the official SDAC auction (Sequence 1) over secondary auctions (such as EXAA) to prevent price inaccuracy.

Full-Payload Webhooks: Immediately pushes the entire dataset to Homey upon every update, eliminating the need for polling.

Multi-Currency & Unit Support: Fully supports EUR, PLN, and other currencies, including explicit unit reporting (MWh).

Edge Caching: Built-in 300-second caching to minimize Cloudflare KV reads and maximize response speed.

🛠 Installation & Setup
1. Cloudflare Preparation
Create a KV Namespace named PBTH_STORAGE.

Note the Namespace ID for your configuration.

2. GitHub Configuration
Ensure the following two files are in the root directory of your repository:

wrangler.toml
Ini, TOML
name = "pbth-entsoe-bridge"
main = "index.js"
compatibility_date = "2026-01-27"

[[kv_namespaces]]
binding = "PBTH_STORAGE"
id = "YOUR_KV_NAMESPACE_ID"
index.js
(Paste the complete JavaScript code v1.5 of the bridge here).

3. Environment Variables (Secrets)
Configure these in the Cloudflare Dashboard (Settings > Variables):

MY_EIC_CODE: Your ACK identification for ENTSO-E.

AUTH_KEY: Your secret key for API access.

HOMEY_WEBHOOK_URL: (Optional) The URL where the bridge will 'push' data.

📖 API Documentation (GET Requests)
Authentication
Append your key to every request:

URL Parameter: ?zone=...&key=YOUR_KEY

HTTP Header: X-API-Key: YOUR_KEY

Fetching Prices
Endpoint: GET /?zone=[EIC_CODE]

Example Response:

JSON
{
  "zone": "10YNL----------L",
  "updated": "2026-01-27T13:29:07.686Z",
  "fresh": true,
  "points": 95,
  "res": "15m",
  "seq": "1",
  "curr": "EUR",
  "unit": "MWh",
  "data": [
    { "time": "2026-01-27T23:00:00.000Z", "price": 84.52 }
  ]
}
Status Dashboard
Endpoint: GET /?status=true Shows the overall health of the bridge, the total number of active zones, and whether the webhook service is active.

🔔 Webhook Integration
When a new price update is received from ENTSO-E, the bridge sends a POST request to the configured HOMEY_WEBHOOK_URL. The payload is identical to the JSON output of the price data API. This allows for real-time price processing in Homey with zero delay.

⚖️ License & Usage
This project is designed for use with the Power by the Hour app for Homey. Use is at your own risk. Ensure you have a valid subscription to the ENTSO-E Transparency Platform push service (Item 12.1.D).
