/**
 * Power by the Hour - ENTSO-E Energy Bridge (v3.28 Strict XML Copy)
 *
 * API ENDPOINTS:
 * GET /?zone=[EIC_CODE]&key=[AUTH_KEY]     -> Get specific zone prices
 * GET /?status=true&key=[AUTH_KEY]         -> Get bridge health & zones
 * GET /?delete=[EIC_CODE]&key=[AUTH_KEY]   -> Delete zone data
 *
 * CRON: Watchdog checks health every 15 mins (Alerts Homey after 60 mins silence)
 *
 * HOMEY WEBHOOK EVENTS (POST):
 * 1. event: "price_update" (Sent when new prices arrive)
 * Payload: { 
 * "event": "price_update", 
 * "zone": "10YNL...", 
 * "name": "Netherlands", 
 * "updated": "2026-01-30T13:00:00Z", 
 * "data": [{ "time": "...", "price": 12.5 }, ...] 
 * }
 *
 * 2. event: "alert_connection_lost" (Sent by Watchdog after >60 mins silence)
 * Payload: { 
 * "event": "alert_connection_lost", 
 * "message": "Alert: Geen ENTSO-E data ontvangen...", 
 * "minutes_silence": 65, 
 * "last_seen": "2026-01-30T10:00:00Z",
 * "entsoe_service_online": false
 * }
 */

const ZONE_NAMES = {
  // --- West & Noord Europa ---
  "10YNL----------L": "Netherlands", "10YBE----------2": "Belgium", "10YFR-RTE------C": "France",
  "10Y1001A1001A82H": "Germany-Luxembourg", "10Y1001A1001A59C": "Germany (Amprion Area)",
  "10YAT-APG------L": "Austria", "10YCH-SWISSGRIDZ": "Switzerland",
  "10Y1001A1001A92E": "United Kingdom", "10Y1001A1001A016": "Ireland (SEM)",

  // --- Scandinavië & Baltics ---
  "10YDK-1--------W": "Denmark DK1", "10YDK-2--------M": "Denmark DK2", "10YFI-1--------U": "Finland",
  "10YNO-1--------2": "Norway NO1 (Oslo)", "10YNO-2--------T": "Norway NO2 (Kristiansand)",
  "10YNO-3--------J": "Norway NO3 (Trondheim)", "10YNO-4--------9": "Norway NO4 (Tromsø)",
  "10YNO-5--------E": "Norway NO5 (Bergen)", "10Y1001A1001A48H": "Norway NO5 (Bergen)",
  "50Y0JVU59B4JWQCU": "Norway NO2 North Sea Link",
  "10Y1001A1001A44P": "Sweden SE1", "10Y1001A1001A45N": "Sweden SE2", 
  "10Y1001A1001A46L": "Sweden SE3", "10Y1001A1001A47J": "Sweden SE4",
  "10Y1001A1001A39I": "Estonia", "10YLV-1001A00074": "Latvia", "10YLT-1001A0008Q": "Lithuania",

  // --- Zuid Europa ---
  "10YES-REE------0": "Spain", "10YPT-REN------W": "Portugal", "10YGR-HTSO-----Y": "Greece",
  "10YIT-GRTN-----B": "Italy (National)", "10Y1001A1001A73I": "Italy North",
  "10Y1001A1001A70O": "Italy Centre-North", "10Y1001A1001A71M": "Italy Centre-South",
  "10Y1001A1001A74G": "Italy South", "10Y1001A1001A75E": "Italy Sicily",
  "10Y1001A1001A885": "Italy Sardinia", "10Y1001A1001A893": "Italy Rossano",

  // --- Centraal & Oost Europa ---
  "10YPL-AREA-----S": "Poland", "10YCZ-CEPS-----N": "Czech Republic", "10YSK-SEPS-----K": "Slovakia",
  "10YHU-MAVIR----U": "Hungary", "10YRO-TEL------P": "Romania", "10YSI-ELES-----O": "Slovenia",
  "10YHR-HEP------M": "Croatia", "10YCA-BULGARIA-R": "Bulgaria", "10YCS-CG-TSO---S": "Montenegro",
  "10YCS-SERBIATSOV": "Serbia", "10YMK-MEPSO----8": "North Macedonia", "10YBA-JPCC-----D": "Bosnia and Herzegovina",
  "10YAL-KESH-----5": "Albania", "10Y1001C--00100H": "Kosovo", "10Y1001C--00096J": "Moldova",
  "10Y1001C--000182": "Ukraine (IPS)", "10YTR-TEIAS----W": "Turkey"
};

const getTagValue = (xml, tagName) => {
  const regex = new RegExp(`<([a-zA-Z0-9_\\-]*:)?${tagName}(?:\\s[^>]*)?>([^<]+)<\\/([a-zA-Z0-9_\\-]*:)?${tagName}>`, "i");
  const match = xml.match(regex);
  return match ? match[2].trim() : null;
};

export default {
  async fetch(request, env, ctx) {
    const STORAGE_PREFIX = "prices_";
    const url = new URL(request.url);

    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });

    // --- POST HANDLING ---
    if (request.method === "POST") {
      console.log("\n>>> INCOMING POST REQUEST START <<<");
      console.log("HEADERS:", JSON.stringify(Object.fromEntries(request.headers)));
      
      try {
        // 1. ALWAYS READ BODY (Even if empty, we need to consume stream)
        const xmlData = await request.text();
        const contentLength = xmlData.length;
        
        console.log(`RECEIVED BODY LENGTH: ${contentLength}`);
        if (contentLength > 0) {
             console.log("RAW XML BODY (First 500 chars):");
             console.log(xmlData.substring(0, 500));
        } else {
             console.log("ACTION: Empty Body (Ping/Test).");
        }

        // 2. PROCESS DATA (Only if it looks like real data)
        if (contentLength > 50) {
          ctx.waitUntil(this.processData(xmlData, env, STORAGE_PREFIX));
        }

        // 3. GENERATE STRICT RESPONSE (IEC 62325-504 ResponseMessage)
        // This matches exactly the XML structure from the Documentation Example.
        // NOTE: We do NOT sign the response (no private key), but usually ACK doesn't require signature.
        
        const responseXml = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" SOAP-ENV:encodingStyle="http://www.w3.org/2001/12/soap-encoding">
  <SOAP-ENV:Body>
    <msg:ResponseMessage xmlns:msg="http://iec.ch/TC57/2011/schema/message">
      <msg:Header>
        <msg:Verb>create</msg:Verb>
        <msg:Noun>ETP-DOCUMENT</msg:Noun>
        <msg:Context>PRODUCTION</msg:Context>
        <msg:AckRequired>true</msg:AckRequired>
      </msg:Header>
      <msg:Reply>
        <msg:Result>OK</msg:Result>
      </msg:Reply>
    </msg:ResponseMessage>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;

        console.log("ACTION: Sending Strict ResponseMessage (SOAP).");
        console.log(responseXml);
        console.log(">>> REQUEST END <<<\n");

        // RETURN WITH CORRECT CONTENT-TYPE
        return new Response(responseXml, { 
            status: 200, 
            headers: { 
                "Content-Type": "application/soap+xml" 
            } 
        });

      } catch (err) {
        console.error("!!! CRITICAL HANDLER ERROR !!!", err);
        return new Response(null, { status: 500 });
      }
    }

    // --- GET & AUTH ---
    const isAuthEnabled = env.AUTH_KEY && env.AUTH_KEY.trim().length > 0;
    if (isAuthEnabled) {
      const key = url.searchParams.get("key") || request.headers.get("X-API-Key");
      if (key !== env.AUTH_KEY.trim()) return new Response("Unauthorized", { status: 401 });
    }

    if (url.searchParams.has("delete")) {
        const zoneToDelete = url.searchParams.get("delete");
        await env.PBTH_STORAGE.delete(STORAGE_PREFIX + zoneToDelete);
        return new Response(JSON.stringify({ message: `Deleted zone ${zoneToDelete}` }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    if (url.searchParams.has("status")) {
      const list = await env.PBTH_STORAGE.list({ prefix: STORAGE_PREFIX });
      const lastUpdateRaw = await env.PBTH_STORAGE.get("bridge_last_update") || "N/A";
      let entsoeServiceOnline = false;
      if (lastUpdateRaw !== "N/A") {
          const lastUpdateDate = new Date(lastUpdateRaw);
          const diffMs = new Date() - lastUpdateDate;
          entsoeServiceOnline = Math.floor(diffMs / 60000) <= 60;
      }
      const todayTarget = new Date(); todayTarget.setUTCHours(23, 0, 0, 0);
      const tomorrowTarget = new Date(todayTarget); tomorrowTarget.setDate(tomorrowTarget.getDate() + 1);
      const zones = list.keys.map(k => {
        let isCompleteToday = false;
        let isCompleteTomorrow = false;
        if (k.metadata?.latest) {
          const latestDate = new Date(k.metadata.latest);
          const resMinutes = k.metadata.res || 60;
          const endTime = new Date(latestDate.getTime() + resMinutes * 60000);
          isCompleteToday = endTime >= todayTarget;
          isCompleteTomorrow = endTime >= tomorrowTarget;
        }
        const eic = k.name.replace(STORAGE_PREFIX, "");
        return { 
          zone: eic, name: k.metadata?.name || ZONE_NAMES[eic] || "N/A", updated: k.metadata?.updated || "N/A", 
          latest_data: k.metadata?.latest || "N/A", is_complete_today: isCompleteToday, is_complete_tomorrow: isCompleteTomorrow, 
          points: k.metadata?.count || 0, res: `${k.metadata?.res || 60}m`, seq: k.metadata?.seq || "1", curr: k.metadata?.currency || "EUR" 
        };
      });
      const ratioToday = zones.length > 0 ? (zones.filter(z => z.is_complete_today).length / zones.length) : 0;
      const ratioTomorrow = zones.length > 0 ? (zones.filter(z => z.is_complete_tomorrow).length / zones.length) : 0;
      return new Response(JSON.stringify({ 
          bridge: "PBTH Energy Bridge Pro (v3.28 Strict XML)", 
          summary: { 
              total_zones: zones.length, 
              complete_today: Number(ratioToday.toFixed(2)), 
              complete_tomorrow: Number(ratioTomorrow.toFixed(2)), 
              entsoe_service_online: entsoeServiceOnline, 
              last_push: lastUpdateRaw 
          }, 
          zones: zones.sort((a,b) => a.zone.localeCompare(b.zone)) 
      }, null, 2), { headers: { "Content-Type": "application/json" } });
    }

    const zone = url.searchParams.get("zone");
    if (zone) {
        const { value, metadata } = await env.PBTH_STORAGE.getWithMetadata(STORAGE_PREFIX + zone);
        if (!value) return new Response(JSON.stringify({ error: "Zone not found" }), { status: 404 });
        return new Response(JSON.stringify({ zone, name: metadata?.name || ZONE_NAMES[zone] || "N/A", updated: metadata?.updated, points: metadata?.count, res: `${metadata?.res}m`, data: JSON.parse(value) }, null, 2), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" } });
    }
    return new Response("PBTH Energy Bridge v3.28 Online", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    const lastUpdateRaw = await env.PBTH_STORAGE.get("bridge_last_update");
    if (!lastUpdateRaw) return;
    const lastUpdate = new Date(lastUpdateRaw);
    const diffMinutes = Math.floor((new Date() - lastUpdate) / 60000);
    if (diffMinutes > 60 && env.HOMEY_WEBHOOK_URL) {
        console.log(`WATCHDOG ALERT: No data for ${diffMinutes} minutes.`);
        await fetch(env.HOMEY_WEBHOOK_URL, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ 
                event: "alert_connection_lost", 
                message: `Alert: Geen ENTSO-E data ontvangen gedurende ${diffMinutes} minuten!`,
                last_seen: lastUpdateRaw,
                minutes_silence: diffMinutes,
                entsoe_service_online: false
            }) 
        }).catch(err => console.error("Failed to alert Homey:", err));
    }
  },

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
            const existingSeq = parseInt(existing.metadata?.seq || "0");
            const incomingSeq = parseInt(sequenceRaw);

            if (incomingSeq >= existingSeq || existingPrices.length === 0) {
                const priceMap = new Map(existingPrices.map(obj => [obj.time, obj.price]));
                newPrices.forEach(item => priceMap.set(item.time, item.price));
                const pruneLimit = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
                const sortedPrices = Array.from(priceMap, ([time, price]) => ({ time, price })).filter(item => item.time >= pruneLimit).sort((a, b) => new Date(a.time) - new Date(b.time));

                const now = new Date().toISOString();
                const latestTime = sortedPrices.length > 0 ? sortedPrices[sortedPrices.length - 1].time : now;
                const metadata = { updated: now, name: zoneName, count: sortedPrices.length, currency, unit: "MWh", res: resMin, seq: incomingSeq.toString(), latest: latestTime };

                await env.PBTH_STORAGE.put(storageKey, JSON.stringify(sortedPrices), { metadata });
                await env.PBTH_STORAGE.put("bridge_last_update", now);
                
                if (env.HOMEY_WEBHOOK_URL) {
                    await fetch(env.HOMEY_WEBHOOK_URL, { 
                        method: 'POST', 
                        headers: { 'Content-Type': 'application/json' }, 
                        body: JSON.stringify({ event: "price_update", zone: zoneEic, name: zoneName, updated: now, data: sortedPrices }) 
                    }).catch(() => {});
                }
            }
        }
    } catch (e) { console.error("Async error:", e); }
  }
};
