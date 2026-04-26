/* This Source Code Form is subject to the terms of the Mozilla Public
	License, v. 2.0. If a copy of the MPL was not distributed with this
	file, You can obtain one at http://mozilla.org/MPL/2.0/.

	Copyright 2026, Gruijter.org / Robin de Gruijter <gruijter@hotmail.com> */

/**
 * API ENDPOINTS:
 * https://entsoe.gruijter.org                          -> POST endpoint for ENTSO-E Webservice
 * https://entsoe.gruijter.org/?init=true               -> Manually force the generation of the status.json file in R2
 * https://entsoe-prices.gruijter.org/status.json       -> Get bridge health & available zones
 * https://entsoe-prices.gruijter.org/[EIC_CODE].json   -> Get specific zone prices
 */

const BRIDGE_VERSION = "v8.6 extended xml logging";

const ZONE_NAMES = {
  "10YNL----------L": "Netherlands", "10YBE----------2": "Belgium", "10YFR-RTE------C": "France",
  "10Y1001A1001A82H": "Germany-Luxembourg", "10Y1001A1001A59C": "Germany (Amprion Area)",
  "10YAT-APG------L": "Austria", "10YCH-SWISSGRIDZ": "Switzerland",
  "10Y1001A1001A92E": "United Kingdom", "10Y1001A1001A016": "Ireland (SEM)",
  "10YDK-1--------W": "Denmark DK1", "10YDK-2--------M": "Denmark DK2", "10YFI-1--------U": "Finland",
  "10YNO-1--------2": "Norway NO1 (Oslo)", "10YNO-2--------T": "Norway NO2 (Kristiansand)",
  "10YNO-3--------J": "Norway NO3 (Trondheim)", "10YNO-4--------9": "Norway NO4 (Tromsø)",
  "10YNO-5--------E": "Norway NO5 (Bergen)", "10Y1001A1001A48H": "Norway NO5 (Bergen)",
  "50Y0JVU59B4JWQCU": "Norway NO2 North Sea Link",
  "10Y1001A1001A44P": "Sweden SE1", "10Y1001A1001A45N": "Sweden SE2", 
  "10Y1001A1001A46L": "Sweden SE3", "10Y1001A1001A47J": "Sweden SE4",
  "10Y1001A1001A39I": "Estonia", "10YLV-1001A00074": "Latvia", "10YLT-1001A0008Q": "Lithuania",
  "10YES-REE------0": "Spain", "10YPT-REN------W": "Portugal", "10YGR-HTSO-----Y": "Greece",
  "10YIT-GRTN-----B": "Italy (National)", "10Y1001A1001A73I": "Italy North",
  "10Y1001A1001A70O": "Italy Centre-North", "10Y1001A1001A71M": "Italy Centre-South",
  "10Y1001A1001A74G": "Italy South", "10Y1001A1001A75E": "Italy Sicily",
  "10Y1001A1001A885": "Italy Sardinia", "10Y1001A1001A893": "Italy Rossano",
  "10Y1001A1001A788": "Italy Calabria", "10Y1001A1001A84D": "Italy Macrozone North",
  "10Y1001A1001A66F": "Italy Macrozone South", "10Y1001A1001A877": "Italy Macrozone Sicily",
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

const roundPrice = (p) => Math.round(p * 100000000) / 100000000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });

    if (request.method === "POST") {
      try {
        const xmlData = await request.text();
        
        if (xmlData.length > 50) {
            // Determine if XML is 1-to-1 mapped to a single zone
            const domainMatches = Array.from(xmlData.matchAll(/<([a-zA-Z0-9_\-]*:)?(in_Domain\.mRID|out_Domain\.mRID)(?:\s[^>]*)?>([^<]+)<\/([a-zA-Z0-9_\-]*:)?\2>/ig));
            const uniqueEics = new Set(domainMatches.map(m => m[3].trim()));
            
            const timestamp = new Date().toISOString().replace(/:/g, '-');
            let debugFileName;
            if (uniqueEics.size === 1) {
                debugFileName = `debug_${Array.from(uniqueEics)[0]}_${timestamp}.xml`;
            } else {
                debugFileName = `debug_batch_${timestamp}.xml`;
            }
            
            ctx.waitUntil(
                env.ENTSOE_PRICES_R2_BUCKET.put(debugFileName, xmlData, {
                    httpMetadata: { contentType: "application/xml", cacheControl: "no-cache" }
                })
            );
            ctx.waitUntil(this.processData(xmlData, env));
        } else {
            ctx.waitUntil(this.updateStatusFile(env, new Date().toISOString()));
        }

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

    if (request.method === "GET") {
        if (url.searchParams.has("init")) {
            await this.updateStatusFile(env, new Date().toISOString());
            return new Response("Initialized! status.json has been created in R2.", { status: 200 });
        }
        if (url.searchParams.has("status")) {
            return Response.redirect(`${PUBLIC_R2_URL}/status.json`, 301);
        }
        const zone = url.searchParams.get("zone");
        if (zone) {
            return Response.redirect(`${PUBLIC_R2_URL}/${zone}.json`, 301);
        }
        return new Response(`PBTH Energy Bridge ${BRIDGE_VERSION} Online. Please use the public URL: ` + PUBLIC_R2_URL, { status: 200 });
    }

    return new Response("Method not allowed", { status: 405 });
  },

  async processData(xmlData, env) {
    try {
        const timeSeriesRegex = /<[^>]*TimeSeries(?:\s[^>]*)?>([\s\S]*?)<\/[^>]*TimeSeries>/ig;
        let tsMatch;
        
        const parsedZones = new Map();
        let hasData = false;

        // If the XML has no TimeSeries blocks, it might be an empty push or acknowledgment, exit early
        if (!xmlData.match(/<[^>]*TimeSeries/i)) return;

        while ((tsMatch = timeSeriesRegex.exec(xmlData)) !== null) {
            const tsXml = tsMatch[1];
            let zoneEic = getTagValue(tsXml, "in_Domain.mRID") || getTagValue(tsXml, "out_Domain.mRID");
            
            if (!zoneEic) {
                zoneEic = getTagValue(xmlData, "out_Domain.mRID");
                if (zoneEic) {
                    console.warn(`Warning: TimeSeries missing internal domain. Falling back to document root domain: ${zoneEic}. In a batch file, this might misattribute data!`);
                }
            }

            if (!zoneEic) continue;

            if (!parsedZones.has(zoneEic)) {
                const zoneNameRaw = getTagValue(xmlData, "out_Domain.name");
                parsedZones.set(zoneEic, {
                    zoneName: ZONE_NAMES[zoneEic] || zoneNameRaw || zoneEic,
                    currency: getTagValue(tsXml, "currency_Unit.name") || getTagValue(xmlData, "currency_Unit.name") || "EUR",
                    fileDominantResMin: 60,
                    extractedBlocks: []
                });
            }
            const zoneData = parsedZones.get(zoneEic);

            const periodRegex = /<[^>]*Period(?:\s[^>]*)?>([\s\S]*?)<\/[^>]*Period>/ig;
            let periodMatch;
            
            const pointBlockRegex = /<[^>]*Point(?:\s[^>]*)?>([\s\S]*?)<\/[^>]*Point>/ig;
            
            while ((periodMatch = periodRegex.exec(tsXml)) !== null) {
                const periodXml = periodMatch[1];
                
                const timeIntervalMatch = /<[^>]*timeInterval(?:[\s\S]*?)?>[\s\S]*?<[^>]*start(?:[\s\S]*?)?>([^<]+)<\/[^>]*start>[\s\S]*?<[^>]*end(?:[\s\S]*?)?>([^<]+)<\/[^>]*end>[\s\S]*?<\/[^>]*timeInterval>/i.exec(periodXml);
                if (!timeIntervalMatch) continue;
                
                const startStr = timeIntervalMatch[1].trim();
                const endStr = timeIntervalMatch[2].trim();
                const periodStartTime = new Date(startStr);
                const periodEndTime = new Date(endStr);
                if (isNaN(periodStartTime.getTime()) || isNaN(periodEndTime.getTime())) continue;

                const resolutionRaw = getTagValue(periodXml, "resolution") || "PT60M";
                let calcResMin = resolutionRaw.includes("PT15M") ? 15 : (resolutionRaw.includes("PT30M") ? 30 : 60);
                
                if (calcResMin < zoneData.fileDominantResMin) zoneData.fileDominantResMin = calcResMin; 

                // Calculate expected points for A03 curve padding
                const totalDurationMs = periodEndTime.getTime() - periodStartTime.getTime();
                const expectedPoints = Math.round(totalDurationMs / (calcResMin * 60000));

                pointBlockRegex.lastIndex = 0;
                let pointMatch;
                
                let lastPos = 0;
                let lastVal = 0;
                
                while ((pointMatch = pointBlockRegex.exec(periodXml)) !== null) {
                    const pointXml = pointMatch[1];
                    const posStr = getTagValue(pointXml, "position");
                    const priceStr = getTagValue(pointXml, "price.amount");

                    if (!posStr || !priceStr) continue;

                    const currentPos = parseInt(posStr);
                    const currentVal = roundPrice(parseFloat(priceStr));
                    
                    if (!isNaN(currentPos) && !isNaN(currentVal)) {
                        // A03 Curve Compliance: Fill omitted mid-period nodes
                        if (lastPos > 0 && currentPos > (lastPos + 1)) {
                            for (let missingPos = lastPos + 1; missingPos < currentPos; missingPos++) {
                                const fillTimestampMs = periodStartTime.getTime() + (missingPos - 1) * calcResMin * 60000;
                                zoneData.extractedBlocks.push({ time: new Date(fillTimestampMs).toISOString(), price: lastVal });
                            }
                        }
                        
                        // Add explicit node
                        const timestampMs = periodStartTime.getTime() + (currentPos - 1) * calcResMin * 60000;
                        zoneData.extractedBlocks.push({ time: new Date(timestampMs).toISOString(), price: currentVal });
                        
                        lastPos = currentPos;
                        lastVal = currentVal;
                    }
                }

                // A03 Curve Compliance: Pad omitted end-of-period nodes
                if (lastPos > 0 && lastPos < expectedPoints) {
                    for (let missingPos = lastPos + 1; missingPos <= expectedPoints; missingPos++) {
                        const fillTimestampMs = periodStartTime.getTime() + (missingPos - 1) * calcResMin * 60000;
                        zoneData.extractedBlocks.push({ time: new Date(fillTimestampMs).toISOString(), price: lastVal });
                    }
                }
            }
        }

        for (const [zoneEic, zoneData] of parsedZones.entries()) {
            if (zoneData.extractedBlocks.length === 0) continue;
            hasData = true;

            const fileName = `${zoneEic}.json`;
            const lockName = `lock_${zoneEic}`;
            
            // Mutex Lock Logic
            let locked = false;
            for (let i = 0; i < 5; i++) {
                const lockObj = await env.ENTSOE_PRICES_R2_BUCKET.get(lockName);
                if (lockObj) {
                    const lockTime = parseInt(await lockObj.text() || "0");
                    // Prevent deadlocks: Override lock if it's older than 30 seconds
                    if (Date.now() - lockTime < 30000) {
                        await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));
                        continue;
                    }
                }
                await env.ENTSOE_PRICES_R2_BUCKET.put(lockName, Date.now().toString());
                locked = true;
                break;
            }

            if (!locked) {
                console.error(`Skipping ${zoneEic} - Mutex lock timeout.`);
                continue;
            }

            try {
            let existingPrices = [];
            let r2DominantResMin = 60;

            const existingObj = await env.ENTSOE_PRICES_R2_BUCKET.get(fileName);
            if (existingObj) {
                try {
                    const existingData = await existingObj.json();
                    existingPrices = existingData.data || [];
                    if (existingData.res) r2DominantResMin = parseInt(existingData.res);
                } catch(e) {}
            }
            
            const priceMap = new Map(existingPrices.map(obj => [obj.time, roundPrice(obj.price)]));
            
            zoneData.extractedBlocks.forEach(item => {
                priceMap.set(item.time, item.price);
            });

            const finalResMin = Math.min(zoneData.fileDominantResMin, r2DominantResMin);

            const nowMs = Date.now();
            const pruneLimitPastMs = nowMs - 48 * 3600 * 1000;
            const pruneLimitFutureMs = nowMs + 72 * 3600 * 1000; 
            
            const pruneLimitPastISO = new Date(pruneLimitPastMs).toISOString();
            const pruneLimitFutureISO = new Date(pruneLimitFutureMs).toISOString();
            
            const sortedPrices = Array.from(priceMap, ([time, price]) => ({ time, price }))
                .filter(item => item.time >= pruneLimitPastISO && item.time <= pruneLimitFutureISO)
                .sort((a, b) => new Date(a.time) - new Date(b.time));

            const now = new Date().toISOString();
            const latestTime = sortedPrices.length > 0 ? sortedPrices[sortedPrices.length - 1].time : now;

            const zoneJsonPayload = {
                zone: zoneEic,
                name: zoneData.zoneName,
                license: LICENSE_TEXT,
                updated: now,
                points: sortedPrices.length,
                res: `${finalResMin}m`,
                data: sortedPrices
            };

            await env.ENTSOE_PRICES_R2_BUCKET.put(fileName, JSON.stringify(zoneJsonPayload), {
                httpMetadata: { contentType: "application/json", cacheControl: "public, max-age=300" },
                customMetadata: {
                    updated: now,
                    name: zoneData.zoneName,
                    count: sortedPrices.length.toString(),
                    currency: zoneData.currency,
                    res: finalResMin.toString(),
                    latest: latestTime
                }
            });
            } catch (innerError) {
                console.error(`Fout tijdens verwerken van zone ${zoneEic}:`, innerError);
            } finally {
                try {
                    // Always clean up the lock safely
                    await env.ENTSOE_PRICES_R2_BUCKET.delete(lockName);
                } catch (lockErr) { console.error(`Kon lock voor ${zoneEic} niet verwijderen:`, lockErr); }
            }
        }

        if (hasData) {
            await this.updateStatusFile(env, new Date().toISOString());
        }
    } catch (e) { console.error("Data processing error:", e); }
  },

  async updateStatusFile(env, lastPushTime) {
    const nowUTC = new Date();
    
    // Status Logic - Pure UTC
    const currentUTCDay = new Date(Date.UTC(nowUTC.getUTCFullYear(), nowUTC.getUTCMonth(), nowUTC.getUTCDate()));
    const targetTodayUTC = new Date(currentUTCDay.getTime() + 21 * 3600 * 1000).getTime();
    const targetTomorrowUTC = new Date(currentUTCDay.getTime() + 45 * 3600 * 1000).getTime(); 
    
    const lockName = 'lock_status_update';
    const lockObj = await env.ENTSOE_PRICES_R2_BUCKET.get(lockName);
    if (lockObj) {
        const lockTime = parseInt(await lockObj.text() || "0");
        // Als een andere instantie de status al aan het updaten is (minder dan 15 sec geleden gestart),
        // sla deze zware taak dan over. Die andere instantie neemt onze wijzigingen toch al mee in de list() actie.
        if (Date.now() - lockTime < 15000) {
            return; 
        }
    }
    await env.ENTSOE_PRICES_R2_BUCKET.put(lockName, Date.now().toString());

    try {
    let allObjects = [];
    let cursor;
    do {
        const listed = await env.ENTSOE_PRICES_R2_BUCKET.list({ 
            include: ['customMetadata'],
            cursor
        });
        allObjects.push(...listed.objects);
        cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    
    const threeDaysAgoMs = Date.now() - (3 * 24 * 3600 * 1000);
    const keysToDelete = [];

    let zones = allObjects
        .filter(k => {
            if (k.key === 'status.json') return false;
            if (k.key.startsWith('debug_')) {
                if (new Date(k.uploaded).getTime() < threeDaysAgoMs) {
                    keysToDelete.push(k.key);
                }
                return false;
            }
            return k.key.endsWith('.json');
        })
        .map(k => {
            const meta = k.customMetadata || {};
            const eic = k.key.replace('.json', '');
            let isCompleteToday = false;
            let isCompleteTomorrow = false;
            
            if (meta.latest) {
                const latestDataMs = new Date(meta.latest).getTime();
                isCompleteToday = latestDataMs >= targetTodayUTC;
                isCompleteTomorrow = latestDataMs >= targetTomorrowUTC;
            }
            
            return { 
                zone: eic, 
                name: meta.name || ZONE_NAMES[eic] || "N/A", 
                updated: meta.updated || "N/A", 
                latest_data: meta.latest || "N/A", 
                is_complete_today: isCompleteToday, 
                is_complete_tomorrow: isCompleteTomorrow, 
                points: parseInt(meta.count || "0"), 
                res: `${meta.res || "60"}m`, 
                curr: meta.currency || "EUR" 
            };
        });

    zones.sort((a, b) => {
        const timeA = a.updated === "N/A" ? 0 : new Date(a.updated).getTime();
        const timeB = b.updated === "N/A" ? 0 : new Date(b.updated).getTime();
        return timeB - timeA;
    });

    const ratioToday = zones.length > 0 ? (zones.filter(z => z.is_complete_today).length / zones.length) : 0;
    const ratioTomorrow = zones.length > 0 ? (zones.filter(z => z.is_complete_tomorrow).length / zones.length) : 0;

    const statusPayload = { 
        bridge: `PBTH Energy Bridge Pro (${BRIDGE_VERSION})`, 
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

    // Clean up old batch debug files
    if (keysToDelete.length > 0) {
        await env.ENTSOE_PRICES_R2_BUCKET.delete(keysToDelete);
    }
    } finally {
        await env.ENTSOE_PRICES_R2_BUCKET.delete(lockName);
    }
  }
};
