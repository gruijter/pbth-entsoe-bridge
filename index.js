/* This Source Code Form is subject to the terms of the Mozilla Public
	License, v. 2.0. If a copy of the MPL was not distributed with this
	file, You can obtain one at http://mozilla.org/MPL/2.0/.

	Copyright 2026, Gruijter.org / Robin de Gruijter <gruijter@hotmail.com> */

/**
 * Power by the Hour - ENTSO-E Energy Bridge (v4.5 R2 Edition - Bulletproof)
 *
 * API ENDPOINTS:
 * https://entsoe.gruijter.org                          -> POST endpoint for ENTSO-E Webservice
 * https://entsoe.gruijter.org/?init=true               -> Manually force the generation of the status.json file in R2
 * https://entsoe-prices.gruijter.org/status.json       -> Get bridge health & available zones
 * https://entsoe-prices.gruijter.org/[EIC_CODE].json   -> Get specific zone prices
 */

const ZONE_NAMES = {
  // --- West & North Europe ---
  "10YNL----------L": "Netherlands", "10YBE----------2": "Belgium", "10YFR-RTE------C": "France",
  "10Y1001A1001A82H": "Germany-Luxembourg", "10Y1001A1001A59C": "Germany (Amprion Area)",
  "10YAT-APG------L": "Austria", "10YCH-SWISSGRIDZ": "Switzerland",
  "10Y1001A1001A92E": "United Kingdom", "10Y1001A1001A016": "Ireland (SEM)",

  // --- Scandinavia & Baltics ---
  "10YDK-1--------W": "Denmark DK1", "10YDK-2--------M": "Denmark DK2", "10YFI-1--------U": "Finland",
  "10YNO-1--------2": "Norway NO1 (Oslo)", "10YNO-2--------T": "Norway NO2 (Kristiansand)",
  "10YNO-3--------J": "Norway NO3 (Trondheim)", "10YNO-4--------9": "Norway NO4 (Tromsø)",
  "10YNO-5--------E": "Norway NO5 (Bergen)", "10Y1001A1001A48H": "Norway NO5 (Bergen)",
  "50Y0JVU59B4JWQCU": "Norway NO2 North Sea Link",
  "10Y1001A1001A44P": "Sweden SE1", "10Y1001A1001A45N": "Sweden SE2", 
  "10Y1001A1001A46L": "Sweden SE3", "10Y1001A1001A47J": "Sweden SE4",
  "10Y1001A1001A39I": "Estonia", "10YLV-1001A00074": "Latvia", "10YLT-1001A0008Q": "Lithuania",

  // --- South Europe ---
  "10YES-REE------0": "Spain", "10YPT-REN------W": "Portugal", "10YGR-HTSO-----Y": "Greece",
  "10YIT-GRTN-----B": "Italy (National)", "10Y1001A1001A73I": "Italy North",
  "10Y1001A1001A70O": "Italy Centre-North", "10Y1001A1001A71M": "Italy Centre-South",
  "10Y1001A1001A74G": "Italy South", "10Y1001A1001A75E": "Italy Sicily",
  "10Y1001A1001A885": "Italy Sardinia", "10Y1001A1001A893": "Italy Rossano",

  // --- Central & East Europe ---
  "10YPL-AREA-----S": "Poland", "10YCZ-CEPS-----N": "Czech Republic", "10YSK-SEPS-----K": "Slovakia",
  "10YHU-MAVIR----U": "Hungary", "10YRO-TEL------P": "Romania", "10YSI-ELES-----O": "Slovenia",
  "10YHR-HEP------M": "Croatia", "10YCA-BULGARIA-R": "Bulgaria", "10YCS-CG-TSO---S": "Montenegro",
  "10YCS-SERBIATSOV": "Serbia", "10YMK-MEPSO----8": "North Macedonia", "10YBA-JPCC-----D": "Bosnia and Herzegovina",
  "10YAL-KESH-----5": "Albania", "10Y1001C--00100H": "Kosovo", "10Y1001C--00096J": "Moldova",
  "10Y1001C--000182": "Ukraine (IPS)", "10YTR-TEIAS----W": "Turkey"
};

const PUBLIC_R2_URL = "https://entsoe-prices.gruijter.org";
const LICENSE_TEXT = "Copyright 2026 gruijter.org. Data source: ENTSO-E Transparency Platform. Modified and licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)";

const getTagValue = (xml, tagName) => {
  const regex = new RegExp(`<([a-zA-Z0-9_\\-]*:)?${tagName}(?:\\s[^>]*)?>([^<]+)<\\/([a-zA-Z0-9_\\-]*:)?${tagName}>`, "i");
  const match = xml.match(regex);
  return match ? match[2].trim() : null;
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });

    // --- POST HANDLING (ENTSO-E Data Push) ---
    if (request.method === "POST") {
      try {
        const xmlData = await request.text();
        
        // If it's a real payload, process it asynchronously
        if (xmlData.length > 50) {
          ctx.waitUntil(this.processData(xmlData, env));
        } else {
          // Empty ping from ENTSO-E -> generate/update status.json without breaking
          ctx.waitUntil(this.updateStatusFile(env, new Date().toISOString()));
        }

        // GENERATE STRICT RESPONSE (IEC 62325-504 ResponseMessage)
        const responseXml = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" SOAP-ENV:encodingStyle="http://www.w3.org/2001/12/soap-encoding">
  <SOAP-ENV:Body>
    <msg:ResponseMessage xmlns:msg="http://iec.ch/TC57/2011/schema/message">
      <msg:Header>
        <msg:Verb>create</msg:Verb>
        <msg:Noun>ETP-DOCUMENT</msg:Noun>
        <msg:Context>PRODUCTION</msg:Context>
        <msg:AckRequired>false</msg:AckRequired>
      </msg:Header>
      <msg:Reply><msg:Result>OK</msg:Result></msg:Reply>
    </msg:ResponseMessage>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;

        return new Response(responseXml, { status: 200, headers: { "Content-Type": "application/soap+xml" } });
      } catch (err) {
        console.error("Handler error", err);
        return new Response(null, { status: 500 });
      }
    }

    // --- GET HANDLING (Client Requests) ---
    if (request.method === "GET") {
        if (url.searchParams.has("init")) {
            await this.updateStatusFile(env, new Date().toISOString());
            return new Response("Initialized! status.json has been created in R2.\n\nYou can view it here: " + PUBLIC_R2_URL + "/status.json", { status: 200 });
        }
        if (url.searchParams.has("status")) {
            return Response.redirect(`${PUBLIC_R2_URL}/status.json`, 301);
        }
        const zone = url.searchParams.get("zone");
        if (zone) {
            return Response.redirect(`${PUBLIC_R2_URL}/${zone}.json`, 301);
        }
        return new Response("PBTH Energy Bridge v4.5 (R2 Edition) Online. Please use the public URL: " + PUBLIC_R2_URL, { status: 200 });
    }

    return new Response("Method not allowed", { status: 405 });
  },

  // --- DATA PROCESSING & R2 STORAGE ---
  async processData(xmlData, env) {
    try {
        const zoneEic = getTagValue(xmlData, "out_Domain.mRID");
        if (!zoneEic) return;

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
            const parsedPrice = parseFloat(match[2]);
            
            // BULLETPROOF CHECK: Only accept valid timestamps and valid numbers
            if (!isNaN(timestamp.getTime()) && !isNaN(parsedPrice)) {
                newPrices.push({ time: timestamp.toISOString(), price: parsedPrice });
            }
        }

        if (newPrices.length > 0) {
            const fileName = `${zoneEic}.json`;
            const incomingSeq = parseInt(sequenceRaw);
            let existingPrices = [];
            let existingSeq = 0;

            const existingObj = await env.ENTSOE_PRICES_R2_BUCKET.get(fileName);
            if (existingObj) {
                try {
                    const existingData = await existingObj.json();
                    existingPrices = existingData.data || [];
                    existingSeq = parseInt(existingObj.customMetadata?.seq || "0");
                } catch(e) {}
            }

            if (incomingSeq >= existingSeq || existingPrices.length === 0) {
                
                let dataChanged = false;
                const priceMap = new Map(existingPrices.map(obj => [obj.time, obj.price]));
                
                // Smart Diff: Check if incoming data actually adds or modifies anything
                // Existing future data is perfectly preserved in the Map if omitted by the TSO push.
                newPrices.forEach(item => {
                    if (!priceMap.has(item.time) || priceMap.get(item.time) !== item.price) {
                        priceMap.set(item.time, item.price);
                        dataChanged = true;
                    }
                });

                // Write to R2 only if meaningful changes were found or it's a completely new file
                if (dataChanged || existingPrices.length === 0) {
                    
                    const pruneLimit = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
                    const sortedPrices = Array.from(priceMap, ([time, price]) => ({ time, price }))
                        .filter(item => item.time >= pruneLimit)
                        .sort((a, b) => new Date(a.time) - new Date(b.time));

                    const now = new Date().toISOString();
                    const latestTime = sortedPrices.length > 0 ? sortedPrices[sortedPrices.length - 1].time : now;

                    const zoneJsonPayload = {
                        zone: zoneEic,
                        name: zoneName,
                        license: LICENSE_TEXT,
                        updated: now,
                        points: sortedPrices.length,
                        res: `${resMin}m`,
                        data: sortedPrices
                    };

                    await env.ENTSOE_PRICES_R2_BUCKET.put(fileName, JSON.stringify(zoneJsonPayload), {
                        httpMetadata: { contentType: "application/json", cacheControl: "public, max-age=300" },
                        customMetadata: {
                            updated: now,
                            name: zoneName,
                            count: sortedPrices.length.toString(),
                            currency,
                            res: resMin.toString(),
                            seq: incomingSeq.toString(),
                            latest: latestTime
                        }
                    });

                    await this.updateStatusFile(env, now);
                }
            }
        }
    } catch (e) { console.error("Data processing error:", e); }
  },

  async updateStatusFile(env, lastPushTime) {
    const todayTarget = new Date(); todayTarget.setUTCHours(23, 0, 0, 0);
    const tomorrowTarget = new Date(todayTarget); tomorrowTarget.setDate(tomorrowTarget.getDate() + 1);

    const listed = await env.ENTSOE_PRICES_R2_BUCKET.list({ include: ['customMetadata'] });
    
    let zones = listed.objects
        .filter(k => k.key !== 'status.json' && k.key.endsWith('.json'))
        .map(k => {
            const meta = k.customMetadata || {};
            let isCompleteToday = false;
            let isCompleteTomorrow = false;
            
            if (meta.latest) {
                const latestDate = new Date(meta.latest);
                const resMinutes = parseInt(meta.res || "60");
                const endTime = new Date(latestDate.getTime() + resMinutes * 60000);
                isCompleteToday = endTime >= todayTarget;
                isCompleteTomorrow = endTime >= tomorrowTarget;
            }
            
            const eic = k.key.replace('.json', '');
            return { 
                zone: eic, 
                name: meta.name || ZONE_NAMES[eic] || "N/A", 
                updated: meta.updated || "N/A", 
                latest_data: meta.latest || "N/A", 
                is_complete_today: isCompleteToday, 
                is_complete_tomorrow: isCompleteTomorrow, 
                points: parseInt(meta.count || "0"), 
                res: `${meta.res || "60"}m`, 
                seq: meta.seq || "1", 
                curr: meta.currency || "EUR" 
            };
        });

    // Sort descending by 'updated' timestamp (Newest files on top)
    zones.sort((a, b) => {
        const timeA = a.updated === "N/A" ? 0 : new Date(a.updated).getTime();
        const timeB = b.updated === "N/A" ? 0 : new Date(b.updated).getTime();
        return timeB - timeA;
    });

    const ratioToday = zones.length > 0 ? (zones.filter(z => z.is_complete_today).length / zones.length) : 0;
    const ratioTomorrow = zones.length > 0 ? (zones.filter(z => z.is_complete_tomorrow).length / zones.length) : 0;

    const statusPayload = { 
        bridge: "PBTH Energy Bridge Pro (v4.5 R2 Edition)", 
        license: LICENSE_TEXT,
        summary: { 
            total_zones: zones.length, 
            complete_today: Number(ratioToday.toFixed(2)), 
            complete_tomorrow: Number(ratioTomorrow.toFixed(2)), 
            entsoe_service_online: true, 
            last_push: lastPushTime 
        }, 
        zones: zones 
    };

    await env.ENTSOE_PRICES_R2_BUCKET.put('status.json', JSON.stringify(statusPayload), {
        httpMetadata: { contentType: "application/json", cacheControl: "public, max-age=60" }
    });
  }
};
