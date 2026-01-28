/**
 * Power by the Hour - ENTSO-E Energy Bridge (v1.7)

 * GET /?zone=[EIC_CODE]&key=[AUTH_KEY]
 * GET /?status=true&key=[AUTH_KEY]
 * GET /?delete=[EIC_CODE]&key=[AUTH_KEY]
 * HOMEY WEBHOOK POST
 */

export default {
  async fetch(request, env, ctx) {
    const STORAGE_PREFIX = "prices_";
    const url = new URL(request.url);

    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });

    // --- 1. RECEIVE DATA (POST FROM ENTSO-E) ---
    if (request.method === "POST") {
      let zoneEic = "UNKNOWN";
      try {
        const xmlData = await request.text();
        
        // Extract Metadata
        zoneEic = xmlData.match(/<(?:.*:)?out_Domain\.mRID[^>]*>([^<]+)<\/(?:.*:)?out_Domain\.mRID>/)?.[1] || "UNKNOWN";
        const zoneName = xmlData.match(/<(?:.*:)?out_Domain\.name>([^<]+)<\/(?:.*:)?out_Domain\.name>/)?.[1] || "N/A";
        const sequence = xmlData.match(/<(?:.*:)?order_Detail\.nRID>(\d+)<\/(?:.*:)?order_Detail\.nRID>/)?.[1] || "1";
        const currency = xmlData.match(/<(?:.*:)?currency_Unit\.name>([^<]+)<\/(?:.*:)?currency_Unit\.name>/)?.[1] || "EUR";
        const resolutionRaw = xmlData.match(/<(?:.*:)?resolution>([^<]+)<\/(?:.*:)?resolution>/)?.[1] || "PT60M";
        const startMatch = xmlData.match(/<(?:.*:)?start>([^<]+)<\/(?:.*:)?start>/);
        
        if (!startMatch) throw new Error("Missing <start> tag.");
        const startTime = new Date(startMatch[1]);
        const resolutionMinutes = resolutionRaw.includes("PT15M") ? 15 : 60;

        const newPrices = [];
        const pointRegex = /<(?:.*:)?Point>[\s\S]*?<(?:.*:)?position>(\d+)<\/(?:.*:)?position>[\s\S]*?<(?:.*:)?price\.amount>([\d.]+)<\/(?:.*:)?price\.amount>[\s\S]*?<\/(?:.*:)?Point>/g;
        let match;
        while ((match = pointRegex.exec(xmlData)) !== null) {
          const timestamp = new Date(startTime.getTime() + (parseInt(match[1]) - 1) * resolutionMinutes * 60000);
          newPrices.push({ time: timestamp.toISOString(), price: parseFloat(match[2]) });
        }

        if (newPrices.length === 0) throw new Error("No points parsed.");

        const storageKey = STORAGE_PREFIX + zoneEic;
        const existing = await env.PBTH_STORAGE.getWithMetadata(storageKey);
        const existingPrices = existing.value ? JSON.parse(existing.value) : [];
        const existingSeq = existing.metadata?.seq || "0";

        if (sequence === "1" || existingPrices.length === 0 || existingSeq === "2") {
          const priceMap = new Map(existingPrices.map(obj => [obj.time, obj.price]));
          newPrices.forEach(item => priceMap.set(item.time, item.price));

          const pruneLimit = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
          const sortedPrices = Array.from(priceMap, ([time, price]) => ({ time, price }))
                                   .filter(item => item.time >= pruneLimit)
                                   .sort((a, b) => new Date(a.time) - new Date(b.time));

          const now = new Date().toISOString();
          const latestPriceTime = sortedPrices[sortedPrices.length - 1].time;

          const metadata = { 
            updated: now, 
            name: zoneName, // Nieuw: Naam van de zone
            count: sortedPrices.length, 
            currency, 
            unit: "MWh", 
            res: resolutionMinutes, 
            seq: sequence, 
            latest: latestPriceTime,
            last_status: "OK" 
          };

          await env.PBTH_STORAGE.put(storageKey, JSON.stringify(sortedPrices), { metadata });
          await env.PBTH_STORAGE.put("bridge_last_update", now);

          // Webhook push inclusief naam
          if (env.HOMEY_WEBHOOK_URL && env.HOMEY_WEBHOOK_URL.trim().length > 0) {
            ctx.waitUntil(
              fetch(env.HOMEY_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                  zone: zoneEic, 
                  name: zoneName,
                  updated: now, 
                  res: `${resolutionMinutes}m`, 
                  seq: sequence, 
                  curr: currency, 
                  unit: "MWh", 
                  data: sortedPrices 
                })
              }).catch(e => console.error(`[Webhook Error] ${e.message}`))
            );
          }
        }
        return new Response(this.generateAck(xmlData, env.MY_EIC_CODE), { headers: { "Content-Type": "application/xml" } });
      } catch (err) {
        return new Response(`Error: ${err.message}`, { status: 500 });
      }
    }

    // --- 2. SECURITY CHECK ---
    const isAuthEnabled = env.AUTH_KEY && env.AUTH_KEY.trim().length > 0;
    if (isAuthEnabled) {
      const providedKey = url.searchParams.get("key") || request.headers.get("X-API-Key");
      if (providedKey !== env.AUTH_KEY.trim()) return new Response("Unauthorized", { status: 401 });
    }

    // --- 3. STATUS DASHBOARD ---
    if (url.searchParams.has("status")) {
      const list = await env.PBTH_STORAGE.list({ prefix: STORAGE_PREFIX });
      const lastUpdate = await env.PBTH_STORAGE.get("bridge_last_update") || "N/A";
      
      const targetTime = new Date();
      targetTime.setUTCHours(23, 0, 0, 0); 
      const targetISO = targetTime.toISOString();

      const zones = list.keys.map(k => {
        const isCompleteToday = k.metadata?.latest && k.metadata.latest >= targetISO;
        return {
          zone: k.name.replace(STORAGE_PREFIX, ""),
          name: k.metadata?.name || "N/A", // Nieuw in status
          updated: k.metadata?.updated || "N/A",
          latest_data: k.metadata?.latest || "N/A",
          is_complete_today: !!isCompleteToday,
          points: k.metadata?.count || 0,
          res: `${k.metadata?.res || 60}m`,
          seq: k.metadata?.seq || "1",
          curr: k.metadata?.currency || "EUR"
        };
      });

      const completeCount = zones.filter(z => z.is_complete_today).length;
      const healthscore = zones.length > 0 ? Math.round((completeCount / zones.length) * 100) : 0;

      return new Response(JSON.stringify({ 
        bridge: "PBTH Energy Bridge Pro", 
        summary: { 
          total_zones: zones.length, 
          complete_today: completeCount,
          health_score: `${healthscore}%`, 
          last_push: lastUpdate 
        },
        zones: zones.sort((a,b) => a.zone.localeCompare(b.zone)) 
      }, null, 2), { headers: { "Content-Type": "application/json" } });
    }

    // --- 4. GET ZONE DATA ---
    const zone = url.searchParams.get("zone");
    if (zone) {
      const { value, metadata } = await env.PBTH_STORAGE.getWithMetadata(STORAGE_PREFIX + zone);
      if (!value) return new Response(JSON.stringify({ error: "Zone not found" }), { status: 404 });
      return new Response(JSON.stringify({
        zone, 
        name: metadata?.name || "N/A",
        updated: metadata?.updated, 
        points: metadata?.count, 
        res: `${metadata?.res}m`,
        seq: metadata?.seq, 
        curr: metadata?.currency, 
        unit: metadata?.unit || "MWh", 
        data: JSON.parse(value)
      }, null, 2), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" } });
    }

    return new Response("PBTH Bridge Online.", { status: 200 });
  },

  generateAck(xml, eic) {
    const mrid = xml.match(/<(?:.*:)?mRID>([^<]+)<\/(?:.*:)?mRID>/)?.[1] || "unknown";
    return `<?xml version="1.0" encoding="UTF-8"?><Acknowledgement_MarketDocument xmlns="urn:iec62325.351:tc57wg16:451-1:acknowledgementdocument:7:0"><mRID>${crypto.randomUUID()}</mRID><createdDateTime>${new Date().toISOString()}</createdDateTime><sender_MarketParticipant.mRID codingScheme="A01">10X1001A1001A450</sender_MarketParticipant.mRID><sender_MarketParticipant.marketRole.type>A32</sender_MarketParticipant.marketRole.type><receiver_MarketParticipant.mRID codingScheme="A01">${eic || '37XPBTH-DUMMY-1'}</receiver_MarketParticipant.mRID><receiver_MarketParticipant.marketRole.type>A39</receiver_MarketParticipant.marketRole.type><received_MarketDocument.mRID>${mrid}</received_MarketDocument.mRID><reason><code>A01</code></reason></Acknowledgement_MarketDocument>`;
  }
};
