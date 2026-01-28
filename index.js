/**
 * Power by the Hour - ENTSO-E Energy Bridge (v2.7)

 * GET /?zone=[EIC_CODE]&key=[AUTH_KEY]
 * GET /?status=true&key=[AUTH_KEY]
 * GET /?delete=[EIC_CODE]&key=[AUTH_KEY]
 * HOMEY WEBHOOK POST
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

export default {
  async fetch(request, env, ctx) {
    const STORAGE_PREFIX = "prices_";
    const url = new URL(request.url);
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });

    if (request.method === "POST") {
      const contentLength = request.headers.get("content-length");
      // Zero-Length Guard: Altijd 200 OK bij heartbeat
      if (contentLength === "0") return new Response("OK", { status: 200 });

      let xmlData = "";
      // Default waarden voor ACK (fallback)
      let ackData = {
        mrid: "unknown",
        sender: "10X1001A1001A450", // ENTSO-E (default fallback)
        senderRole: "A32",
        receiver: env.MY_EIC_CODE || "37XPBTH-DUMMY-1",
        receiverRole: "A39"
      };

      try {
        xmlData = await request.text();
        
        // --- DATA EXTRACTIE VOOR ACK (Mirroring) ---
        const mridMatch = xmlData.match(/<[^>]*mRID[^>]*>([^<]+)<\/[^>]*mRID>/);
        if (mridMatch) ackData.mrid = mridMatch[1];

        // Wie stuurde dit? (Wordt ontvanger van ACK)
        const senderMatch = xmlData.match(/<[^>]*sender_MarketParticipant\.mRID[^>]*>([^<]+)<\/[^>]*sender_MarketParticipant\.mRID>/);
        const senderRoleMatch = xmlData.match(/<[^>]*sender_MarketParticipant\.marketRole\.type[^>]*>([^<]+)<\/[^>]*sender_MarketParticipant\.marketRole\.type>/);
        if (senderMatch) ackData.receiver = senderMatch[1];
        if (senderRoleMatch) ackData.receiverRole = senderRoleMatch[1];

        // Aan wie was het gericht? (Wordt afzender van ACK)
        const receiverMatch = xmlData.match(/<[^>]*receiver_MarketParticipant\.mRID[^>]*>([^<]+)<\/[^>]*receiver_MarketParticipant\.mRID>/);
        const receiverRoleMatch = xmlData.match(/<[^>]*receiver_MarketParticipant\.marketRole\.type[^>]*>([^<]+)<\/[^>]*receiver_MarketParticipant\.marketRole\.type>/);
        if (receiverMatch) ackData.sender = receiverMatch[1];
        if (receiverRoleMatch) ackData.senderRole = receiverRoleMatch[1];

        // --- ASYNC PRICE PROCESSING ---
        if (xmlData.length > 50) {
          ctx.waitUntil((async () => {
            try {
              const zoneEic = xmlData.match(/<[^>]*out_Domain\.mRID[^>]*>([^<]+)<\/[^>]*out_Domain\.mRID>/)?.[1] || "UNKNOWN";
              const sequence = xmlData.match(/<[^>]*order_Detail\.nRID>(\d+)<\/[^>]*order_Detail\.nRID>/)?.[1] || "1";
              
              // Naam extractie
              const nameMatch = xmlData.match(/<[^>]*out_Domain\.name[^>]*>([^<]+)<\/[^>]*out_Domain\.name>/);
              const zoneName = ZONE_NAMES[zoneEic] || (nameMatch ? nameMatch[1] : zoneEic);
              
              const currency = xmlData.match(/<[^>]*currency_Unit\.name>([^<]+)<\/[^>]*currency_Unit\.name>/)?.[1] || "EUR";
              const resolutionRaw = xmlData.match(/<[^>]*resolution>([^<]+)<\/[^>]*resolution>/)?.[1] || "PT60M";
              const startMatch = xmlData.match(/<[^>]*start>([^<]+)<\/[^>]*start>/);
              
              if (startMatch) {
                const startTime = new Date(startMatch[1]);
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
                  const existingSeq = existing.metadata?.seq || "0";

                  if (sequence === "1" || existingPrices.length === 0 || existingSeq === "2") {
                    const priceMap = new Map(existingPrices.map(obj => [obj.time, obj.price]));
                    newPrices.forEach(item => priceMap.set(item.time, item.price));
                    
                    // 48h Pruning
                    const pruneLimit = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
                    const sortedPrices = Array.from(priceMap, ([time, price]) => ({ time, price }))
                                             .filter(item => item.time >= pruneLimit)
                                             .sort((a, b) => new Date(a.time) - new Date(b.time));

                    const now = new Date().toISOString();
                    const metadata = { updated: now, name: zoneName, count: sortedPrices.length, currency, unit: "MWh", res: resMin, seq: sequence, latest: sortedPrices[sortedPrices.length - 1].time };
                    await env.PBTH_STORAGE.put(storageKey, JSON.stringify(sortedPrices), { metadata });
                    await env.PBTH_STORAGE.put("bridge_last_update", now);
                    if (env.HOMEY_WEBHOOK_URL) {
                      await fetch(env.HOMEY_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zone: zoneEic, name: zoneName, updated: now, data: sortedPrices }) }).catch(() => {});
                    }
                  }
                }
              }
            } catch (e) { console.error("Async error ignored"); }
          })());
        }

        // Genereer de dynamische ACK
        return new Response(this.generateAck(ackData), { status: 200, headers: { "Content-Type": "application/xml" } });

      } catch (err) {
        // Fallback als alles misgaat
        return new Response(this.generateAck(ackData), { status: 200, headers: { "Content-Type": "application/xml" } });
      }
    }

    // --- GET LOGIC (Status/Zone) ---
    const isAuthEnabled = env.AUTH_KEY && env.AUTH_KEY.trim().length > 0;
    if (isAuthEnabled) {
      const key = url.searchParams.get("key") || request.headers.get("X-API-Key");
      if (key !== env.AUTH_KEY.trim()) return new Response("Unauthorized", { status: 401 });
    }

    if (url.searchParams.has("status")) {
      const list = await env.PBTH_STORAGE.list({ prefix: STORAGE_PREFIX });
      const lastUpdate = await env.PBTH_STORAGE.get("bridge_last_update") || "N/A";
      const targetISO = new Date(new Date().setUTCHours(23, 0, 0, 0)).toISOString();
      const zones = list.keys.map(k => {
        const isComplete = k.metadata?.latest && k.metadata.latest >= targetISO;
        const eic = k.name.replace(STORAGE_PREFIX, "");
        return { zone: eic, name: k.metadata?.name || ZONE_NAMES[eic] || "N/A", updated: k.metadata?.updated || "N/A", latest_data: k.metadata?.latest || "N/A", is_complete_today: !!isComplete, points: k.metadata?.count || 0, res: `${k.metadata?.res || 60}m`, seq: k.metadata?.seq || "1", curr: k.metadata?.currency || "EUR" };
      });
      const health = zones.length > 0 ? Math.round((zones.filter(z => z.is_complete_today).length / zones.length) * 100) : 0;
      return new Response(JSON.stringify({ bridge: "PBTH Energy Bridge Pro", summary: { total_zones: zones.length, health_score: `${health}%`, last_push: lastUpdate }, zones: zones.sort((a,b) => a.zone.localeCompare(b.zone)) }, null, 2), { headers: { "Content-Type": "application/json" } });
    }

    const zone = url.searchParams.get("zone");
    if (zone) {
      const { value, metadata } = await env.PBTH_STORAGE.getWithMetadata(STORAGE_PREFIX + zone);
      if (!value) return new Response(JSON.stringify({ error: "Zone not found" }), { status: 404 });
      return new Response(JSON.stringify({ zone, name: metadata?.name || ZONE_NAMES[zone] || "N/A", updated: metadata?.updated, points: metadata?.count, res: `${metadata?.res}m`, data: JSON.parse(value) }, null, 2), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" } });
    }
    return new Response("PBTH Bridge Online.", { status: 200 });
  },

  // DYNAMISCHE ACK GENERATOR (Mirror Logic)
  generateAck(data) {
    const time = new Date().toISOString().split('.')[0] + "Z";
    // We gebruiken de gespiegelde rollen uit het data object
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
