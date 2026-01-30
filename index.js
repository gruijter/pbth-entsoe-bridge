/**
 * Power by the Hour - ENTSO-E Energy Bridge (v3.4)
 *
 * GET /?zone=[EIC_CODE]&key=[AUTH_KEY]
 * GET /?status=true&key=[AUTH_KEY]
 * GET /?delete=[EIC_CODE]&key=[AUTH_KEY]
 * CRON: Watchdog checks health every 30 mins
 */

const ZONE_NAMES = {
  "10YNL----------L": "Netherlands", "10YBE----------2": "Belgium", "10YFR-RTE------C": "France",
  "10Y1001A1001A82H": "Germany-Luxembourg", "10YAT-APG------L": "Austria", "10YCH-SWISSGRIDZ": "Switzerland",
  "10YDK-1--------W": "Denmark DK1", "10YDK-2--------M": "Denmark DK2", "10YFI-1--------U": "Finland",
  "10YNO-1--------2": "Norway NO1 (Oslo)", "10YNO-2--------T": "Norway NO2 (Kristiansand)",
  "10YNO-3--------J": "Norway NO3 (Trondheim)", "10YNO-4--------9": "Norway NO4 (Tromsø)",
  "10YNO-5--------E": "Norway NO5 (Bergen)", "10Y1001A1001A48H": "Norway NO5 (Bergen)",
  "50Y0JVU59B4JWQCU": "Norway NO2 North Sea Link", "10Y1001A1001A44P": "Sweden SE1",
  "10Y1001A1001A45N": "Sweden SE2", "10Y1001A1001A46L": "Sweden SE3", "10Y1001A1001A47J": "Sweden SE4",
  "10Y1001A1001A92E": "United Kingdom", "10Y1001A1001A39I": "Estonia", "10YLV-1001A00074": "Latvia",
  "10YLT-1001A0008Q": "Lithuania", "10YPL-AREA-----S": "Poland", "10YCZ-CEPS-----N": "Czech Republic",
  "10YHU-MAVIR----U": "Hungary", "10YRO-TEL------P": "Romania", "10YSK-SEPS-----K": "Slovakia",
  "10YSI-ELES-----O": "Slovenia", "10YHR-HEP------M": "Croatia", "10YCA-BULGARIA-R": "Bulgaria",
  "10YCS-CG-TSO---S": "Montenegro", "10YCS-SERBIATSOV": "Serbia", "10Y1001C--000182": "Ukraine (IPS)",
  "10YES-REE------0": "Spain", "10YPT-REN------W": "Portugal", "10YIT-GRTN-----B": "Italy (National)",
  "10Y1001A1001A73I": "Italy North", "10YGR-HTSO-----Y": "Greece", "10Y1001A1001A59C": "Germany (Amprion Area)"
};

// Helper for robust XML extraction (insensitive to whitespace and attributes)
const getTagValue = (xml, tagName) => {
  const regex = new RegExp(`<[^>]*${tagName}[^>]*>([^<]+)<\\/[^>]*${tagName}>`, "i");
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
};

export default {
  // 1. STANDARD HTTP REQUEST HANDLER
  async fetch(request, env, ctx) {
    const STORAGE_PREFIX = "prices_";
    const url = new URL(request.url);

    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });

    // --- POST HANDLING (ENTSO-E PUSH) ---
    if (request.method === "POST") {
      let ackData = { 
        mrid: "PING-" + crypto.randomUUID(), 
        sender: "10X1001A1001A450", 
        senderRole: "A32", 
        receiver: env.MY_EIC_CODE || "37XPBTH-DUMMY-1", 
        receiverRole: "A39" 
      };

      try {
        const contentLength = request.headers.get("content-length");
        
        // If content exists, try to parse for better ACK
        if (contentLength && contentLength !== "0") {
            const xmlData = await request.text();
            
            // Mirror logic for ACK
            const mrid = getTagValue(xmlData, "mRID");
            if (mrid) ackData.mrid = mrid;
            const sender = getTagValue(xmlData, "sender_MarketParticipant.mRID");
            const senderRole = getTagValue(xmlData, "sender_MarketParticipant.marketRole.type");
            if (sender) ackData.receiver = sender;
            if (senderRole) ackData.receiverRole = senderRole;
            const receiver = getTagValue(xmlData, "receiver_MarketParticipant.mRID");
            const receiverRole = getTagValue(xmlData, "receiver_MarketParticipant.marketRole.type");
            if (receiver) ackData.sender = receiver;
            if (receiverRole) ackData.senderRole = receiverRole;

            // Only start processing if valid XML length
            if (xmlData.length > 50) {
              ctx.waitUntil(this.processData(xmlData, env, STORAGE_PREFIX));
            }
        }
        // ALWAYS return XML, even for empty pings
        return new Response(this.generateAck(ackData), { status: 200, headers: { "Content-Type": "application/xml" } });

      } catch (err) {
        console.error("Handler error:", err);
        // Fallback ACK in case of errors
        return new Response(this.generateAck(ackData), { status: 200, headers: { "Content-Type": "application/xml" } });
      }
    }

    // --- GET & AUTH HANDLING ---
    const isAuthEnabled = env.AUTH_KEY && env.AUTH_KEY.trim().length > 0;
    if (isAuthEnabled) {
      const key = url.searchParams.get("key") || request.headers.get("X-API-Key");
      if (key !== env.AUTH_KEY.trim()) return new Response("Unauthorized", { status: 401 });
    }

    // A. DELETE logic
    if (url.searchParams.has("delete")) {
        const zoneToDelete = url.searchParams.get("delete");
        await env.PBTH_STORAGE.delete(STORAGE_PREFIX + zoneToDelete);
        return new Response(JSON.stringify({ message: `Deleted zone ${zoneToDelete}` }), { 
            status: 200, 
            headers: { "Content-Type": "application/json" } 
        });
    }

    // B. STATUS logic
    if (url.searchParams.has("status")) {
      const list = await env.PBTH_STORAGE.list({ prefix: STORAGE_PREFIX });
      const lastUpdate = await env.PBTH_STORAGE.get("bridge_last_update") || "N/A";
      const targetTime = new Date();
      targetTime.setUTCHours(23, 0, 0, 0);

      const zones = list.keys.map(k => {
        let isComplete = false;
        if (k.metadata?.latest) {
          const latestDate = new Date(k.metadata.latest);
          const resMinutes = k.metadata.res || 60;
          // Correct end time calculation for health check
          const endTime = new Date(latestDate.getTime() + resMinutes * 60000);
          isComplete = endTime >= targetTime;
        }
        const eic = k.name.replace(STORAGE_PREFIX, "");
        return { 
          zone: eic, name: k.metadata?.name || ZONE_NAMES[eic] || "N/A", 
          updated: k.metadata?.updated || "N/A", latest_data: k.metadata?.latest || "N/A", 
          is_complete_today: isComplete, points: k.metadata?.count || 0, 
          res: `${k.metadata?.res || 60}m`, seq: k.metadata?.seq || "1", curr: k.metadata?.currency || "EUR" 
        };
      });
      const health = zones.length > 0 ? Math.round((zones.filter(z => z.is_complete_today).length / zones.length) * 100) : 0;
      return new Response(JSON.stringify({ 
          bridge: "PBTH Energy Bridge Pro (v3.4)", 
          summary: { total_zones: zones.length, health_score: `${health}%`, last_push: lastUpdate }, 
          zones: zones.sort((a,b) => a.zone.localeCompare(b.zone)) 
      }, null, 2), { headers: { "Content-Type": "application/json" } });
    }

    // C. GET ZONE logic
    const zone = url.searchParams.get("zone");
    if (zone) {
        const { value, metadata } = await env.PBTH_STORAGE.getWithMetadata(STORAGE_PREFIX + zone);
        if (!value) return new Response(JSON.stringify({ error: "Zone not found" }), { status: 404 });
        return new Response(JSON.stringify({ 
            zone, 
            name: metadata?.name || ZONE_NAMES[zone] || "N/A", 
            updated: metadata?.updated, 
            points: metadata?.count, 
            res: `${metadata?.res}m`, 
            data: JSON.parse(value) 
        }, null, 2), { 
            headers: { 
                "Content-Type": "application/json", 
                "Access-Control-Allow-Origin": "*", 
                "Cache-Control": "public, max-age=300" 
            } 
        });
    }
    
    return new Response("PBTH Energy Bridge v3.4 Online", { status: 200 });
  },

  // 2. CRON SCHEDULED HANDLER (Watchdog)
  // Requires [triggers] crons = ["*/30 * * * *"] in wrangler.toml
  async scheduled(event, env, ctx) {
    const lastUpdateRaw = await env.PBTH_STORAGE.get("bridge_last_update");
    if (!lastUpdateRaw) return; // No data yet

    const lastUpdate = new Date(lastUpdateRaw);
    const now = new Date();
    const diffMs = now - lastUpdate;
    const diffMinutes = Math.floor(diffMs / 60000);

    // THRESHOLD: 60 minutes silence = Connection Lost
    if (diffMinutes > 60) {
        const errorMsg = `CRITICAL ALERT: No ENTSO-E data received for ${diffMinutes} minutes! Last update: ${lastUpdateRaw}. Check ENTSO-E Portal status.`;
        
        console.error(errorMsg);
        
        // This ERROR will trigger Cloudflare Notifications (Email)
        throw new Error(errorMsg);
    }
  },

  // 3. DATA PROCESSING HELPER
  async processData(xmlData, env, STORAGE_PREFIX) {
    try {
        const zoneEic = getTagValue(xmlData, "out_Domain.mRID") || "UNKNOWN";
        const sequenceRaw = getTagValue(xmlData, "order_Detail.nRID") || "1";
        const zoneNameRaw = getTagValue(xmlData, "out_Domain.name");
        const zoneName = ZONE_NAMES[zoneEic] || zoneNameRaw || zoneEic;
        const currency = getTagValue(xmlData, "currency_Unit.name") || "EUR";
        const resolutionRaw = getTagValue(xmlData, "resolution") || "PT60M";
        const startRaw = getTagValue(xmlData, "start");
        
        if (!startRaw) return;

        const startTime = new Date(startRaw);
        const resMin = resolutionRaw.includes("PT15M") ? 15 : 60;
        const newPrices = [];
        const pointRegex = /<[^>]*Point>[\s\S]*?<[^>]*position>(\d+)<\/[^>]*position>[\s\S]*?<[^>]*price\.amount>([\d.]+)<\/[^>]*price\.amount>[\s\S]*?<\/[^>]*Point>/g;
        
        let match;
        while ((match = pointRegex.exec(xmlData)) !== null) {
            const timestamp = new Date(startTime.getTime() + (parseInt(match[1]) - 1) * resMin * 60000);
            newPrices.push({ time: timestamp.toISOString(), price: parseFloat(match[2]) });
        }

        if (newPrices.length > 0) {
            const storageKey = STORAGE_PREFIX + zoneEic;
            const existing = await env.PBTH_STORAGE.getWithMetadata(storageKey);
            const existingPrices = existing.value ? JSON.parse(existing.value) : [];
            
            // Sequence Check: Overwrite only if new seq >= old seq
            const existingSeq = parseInt(existing.metadata?.seq || "0");
            const incomingSeq = parseInt(sequenceRaw);

            if (incomingSeq >= existingSeq || existingPrices.length === 0) {
                const priceMap = new Map(existingPrices.map(obj => [obj.time, obj.price]));
                newPrices.forEach(item => priceMap.set(item.time, item.price));
                
                // 48h Pruning
                const pruneLimit = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
                const sortedPrices = Array.from(priceMap, ([time, price]) => ({ time, price }))
                                            .filter(item => item.time >= pruneLimit)
                                            .sort((a, b) => new Date(a.time) - new Date(b.time));

                const now = new Date().toISOString();
                const latestTime = sortedPrices.length > 0 ? sortedPrices[sortedPrices.length - 1].time : now;
                const metadata = { updated: now, name: zoneName, count: sortedPrices.length, currency, unit: "MWh", res: resMin, seq: incomingSeq.toString(), latest: latestTime };

                await env.PBTH_STORAGE.put(storageKey, JSON.stringify(sortedPrices), { metadata });
                await env.PBTH_STORAGE.put("bridge_last_update", now);
                
                // Still send Webhook to Homey for data updates (if configured)
                if (env.HOMEY_WEBHOOK_URL) {
                    await fetch(env.HOMEY_WEBHOOK_URL, { 
                        method: 'POST', 
                        headers: { 'Content-Type': 'application/json' }, 
                        body: JSON.stringify({ zone: zoneEic, name: zoneName, updated: now, data: sortedPrices }) 
                    }).catch(() => {});
                }
            }
        }
    } catch (e) { console.error("Async error:", e); }
  },

  // 4. XML ACK GENERATOR
  generateAck(data) {
    const time = new Date().toISOString().split('.')[0] + "Z";
    return `<?xml version="1.0" encoding="UTF-8"?>
<Acknowledgement_MarketDocument xmlns="urn:iec62325.351:tc57wg16:451-1:acknowledgementdocument:7:0">
\t<mRID>${crypto.randomUUID()}</mRID>
\t<createdDateTime>${time}</createdDateTime>
\t<sender_MarketParticipant.mRID codingScheme="A01">${data.sender}</sender_MarketParticipant.mRID>
\t<sender_MarketParticipant.marketRole.type>${data.senderRole}</sender_MarketParticipant.marketRole.type>
\t<receiver_MarketParticipant.mRID codingScheme="A01">${data.receiver}</receiver_MarketParticipant.mRID>
\t<receiver_MarketParticipant.marketRole.type>${data.receiverRole}</receiver_MarketParticipant.marketRole.type>
\t<received_MarketDocument.mRID>${data.mrid}</received_MarketDocument.mRID>
\t<reason><code >A01</code></reason>
</Acknowledgement_MarketDocument>`.trim();
  }
};
