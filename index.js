/**
 * Power by the Hour - ENTSO-E Energy Bridge (v3.24 Paranoid Logging)
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

// 1. SAFE UUID GENERATOR
const generateUUID = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

// IMPROVED XML EXTRACTOR (Handles Namespaces & Attributes)
const getTagValue = (xml, tagName) => {
  // Matches <TagName>...</TagName> OR <ns:TagName>...</ns:TagName>
  // Case insensitive, robust against attributes
  const regex = new RegExp(`<([a-zA-Z0-9_\\-]*:)?${tagName}(?:\\s[^>]*)?>([^<]+)<\\/([a-zA-Z0-9_\\-]*:)?${tagName}>`, "i");
  const match = xml.match(regex);
  return match ? match[2].trim() : null;
};

export default {
  // 1. STANDARD HTTP REQUEST HANDLER
  async fetch(request, env, ctx) {
    const STORAGE_PREFIX = "prices_";
    const url = new URL(request.url);

    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });

    // --- POST HANDLING (ENTSO-E PUSH) ---
    if (request.method === "POST") {
      
      // *** DEBUG: LOG INCOMING REQUEST DETAILS ***
      console.log("\n>>> INCOMING POST REQUEST START <<<");
      console.log("HEADERS:", JSON.stringify(Object.fromEntries(request.headers)));
      // *******************************************

      let ackData = { 
        mrid: "PING-" + generateUUID(), 
        sender: "10X1001A1001A450", senderRole: "A32", 
        receiver: env.MY_EIC_CODE || "37XPBTH-DUMMY-1", receiverRole: "A39",
        docId: "UNKNOWN",
        docRev: "1" 
      };

      try {
        const contentType = request.headers.get("content-type") || "";
        const contentLength = request.headers.get("content-length");
        const isSoap = contentType.includes("soap") || contentType.includes("xml");
        
        // --- CASE 1: EMPTY PING (Connection Check) ---
        if (!contentLength || contentLength === "0") {
             console.log("ACTION: Empty Body detected -> Returning 200 OK.");
             console.log(">>> REQUEST END <<<\n");
             return new Response(null, { status: 200 });
        }

        // --- CASE 2: REAL DATA ---
        const xmlData = await request.text();
        
        // *** DEBUG: LOG RAW XML SAMPLE ***
        console.log("RAW XML BODY (First 1000 chars):");
        console.log(xmlData.substring(0, 1000));
        // *********************************

        // Extract Data & Log Results
        const mrid = getTagValue(xmlData, "mRID"); 
        console.log(`PARSED [mRID]: '${mrid}'`);
        if (mrid) ackData.docId = mrid;
        
        const rev = getTagValue(xmlData, "revisionNumber"); 
        console.log(`PARSED [revisionNumber]: '${rev}'`);
        if (rev) ackData.docRev = rev;
        
        const sender = getTagValue(xmlData, "sender_MarketParticipant.mRID"); if (sender) ackData.receiver = sender;
        const senderRole = getTagValue(xmlData, "sender_MarketParticipant.marketRole.type"); if (senderRole) ackData.receiverRole = senderRole;
        const receiver = getTagValue(xmlData, "receiver_MarketParticipant.mRID"); if (receiver) ackData.sender = receiver;
        const receiverRole = getTagValue(xmlData, "receiver_MarketParticipant.marketRole.type"); if (receiverRole) ackData.senderRole = receiverRole;

        if (xmlData.length > 50) {
          ctx.waitUntil(this.processData(xmlData, env, STORAGE_PREFIX));
        }

        // GENERATE ACK XML (Plain)
        let ackXml = this.generateAck(ackData);
        let responseHeaders = { "Content-Type": "application/xml" };

        // IF INPUT WAS SOAP -> WRAP OUTPUT IN SOAP
        if (isSoap && contentType.includes("application/soap+xml")) {
             console.log("ACTION: Wrapping Output in SOAP Envelope.");
             responseHeaders["Content-Type"] = "application/soap+xml";
             ackXml = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Header/>
  <soap:Body>
    ${ackXml.replace('<?xml version="1.0" encoding="UTF-8"?>', '').trim()}
  </soap:Body>
</soap:Envelope>`;
        } else {
             console.log("ACTION: Sending Plain XML Response.");
        }

        // *** DEBUG: LOG OUTGOING XML ***
        console.log("FINAL OUTPUT XML:");
        console.log(ackXml);
        console.log(">>> REQUEST END <<<\n");
        // *******************************

        return new Response(ackXml, { status: 200, headers: responseHeaders });

      } catch (err) {
        console.error("!!! CRITICAL HANDLER ERROR !!!", err);
        const ackXml = this.generateAck(ackData);
        return new Response(ackXml, { status: 200, headers: { "Content-Type": "application/xml" } });
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
            status: 200, headers: { "Content-Type": "application/json" } 
        });
    }

    // B. STATUS logic
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
          bridge: "PBTH Energy Bridge Pro (v3.24 Paranoid Log)", 
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
        return new Response(JSON.stringify({ 
            zone, name: metadata?.name || ZONE_NAMES[zone] || "N/A", 
            updated: metadata?.updated, points: metadata?.count, res: `${metadata?.res}m`, data: JSON.parse(value) 
        }, null, 2), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" } });
    }
    
    return new Response("PBTH Energy Bridge v3.24 Online", { status: 200 });
  },

  // 2. CRON SCHEDULED HANDLER
  async scheduled(event, env, ctx) {
    const lastUpdateRaw = await env.PBTH_STORAGE.get("bridge_last_update");
    if (!lastUpdateRaw) return;

    const lastUpdate = new Date(lastUpdateRaw);
    const diffMs = new Date() - lastUpdate;
    const diffMinutes = Math.floor(diffMs / 60000);

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

  // 3. DATA PROCESSING
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
  },

  // FIXED: STRICT COMPLIANCE ACK GENERATOR
  generateAck(data) {
    const time = new Date().toISOString().split('.')[0] + "Z";
    
    return `<?xml version="1.0" encoding="UTF-8"?>
<Acknowledgement_MarketDocument xmlns="urn:iec62325.351:tc57wg16:451-1:acknowledgementdocument:7:0">
\t<mRID>${generateUUID()}</mRID>
\t<createdDateTime>${time}</createdDateTime>
\t<sender_MarketParticipant.mRID codingScheme="A01">${data.sender}</sender_MarketParticipant.mRID>
\t<sender_MarketParticipant.marketRole.type>${data.senderRole}</sender_MarketParticipant.marketRole.type>
\t<receiver_MarketParticipant.mRID codingScheme="A01">${data.receiver}</receiver_MarketParticipant.mRID>
\t<receiver_MarketParticipant.marketRole.type>${data.receiverRole}</receiver_MarketParticipant.marketRole.type>
\t<received_MarketDocument.mRID>${data.docId}</received_MarketDocument.mRID>
\t<received_MarketDocument.revisionNumber>${data.docRev}</received_MarketDocument.revisionNumber>
\t<reason>
\t\t<code>A01</code>
\t</reason>
</Acknowledgement_MarketDocument>`.trim();
  }
};
