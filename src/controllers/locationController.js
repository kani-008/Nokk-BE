// Pincode lookup (India Gov API) and reverse geocoding (Geoapify) —
// proxied through the backend so the API keys never reach the client.

const formatState = (str) => {
  if (!str) return "";
  return str.toLowerCase().split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
};

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function lookupPincodeFallback(pincode) {
  const url = `https://api.postalpincode.in/pincode/${pincode}`;
  console.log(`[locationController] Requesting api.postalpincode.in fallback: ${url}`);
  const response = await fetchWithTimeout(url, 6000);
  if (!response.ok) {
    throw new Error(`Postal Pincode API returned status ${response.status}`);
  }
  const result = await response.json();
  if (!Array.isArray(result) || result.length === 0 || result[0].Status !== "Success") {
    throw new Error("Pincode not found or invalid format");
  }
  const offices = result[0].PostOffice || [];
  if (offices.length === 0) {
    throw new Error("No records found for pincode");
  }
  let bestOffice = offices.find((o) => o.DeliveryStatus === "Delivery" && o.Block && o.Block !== "NA");
  if (!bestOffice) bestOffice = offices.find((o) => o.Block && o.Block !== "NA");
  if (!bestOffice) bestOffice = offices.find((o) => o.DeliveryStatus === "Delivery");
  if (!bestOffice) bestOffice = offices[0];

  return {
    pincode,
    district: bestOffice.District || "",
    state: formatState(bestOffice.State) || "",
    taluk: bestOffice.Block && bestOffice.Block !== "NA" ? bestOffice.Block : "",
  };
}

// ==================================================================
// PUBLIC — GET /api/location/pincode?pincode=600001
// Looks up district/state/taluk for an Indian pincode via data.gov.in.
// ==================================================================
async function lookupPincode(req, res) {
  const { pincode } = req.query;
  console.log({ route: "GET /api/location/pincode", pincode, status: "looking up pincode" });

  if (!pincode || !/^\d{6}$/.test(pincode)) {
    console.log({ route: "GET /api/location/pincode", pincode, status: 400, message: "A valid 6-digit pincode is required" });
    return res.status(400).json({ success: false, message: "A valid 6-digit pincode is required" });
  }

  const apiKey = process.env.GOV_API_KEY;
  const resourceId = process.env.GOV_PINCODE_RESOURCE_ID;
  const url = `https://api.data.gov.in/resource/${resourceId}?api-key=${apiKey}&format=json&filters[pincode]=${pincode}`;

  try {
    console.log(`[locationController] Requesting India Gov API: ${url.replace(apiKey, "HIDDEN_KEY")}`);
    const response = await fetchWithTimeout(url, 6000);
    console.log(`[locationController] India Gov API Response Status: ${response.status} ${response.statusText}`);
    if (!response.ok) {
      throw new Error(`Gov API request failed with status ${response.status}`);
    }
    const result = await response.json();
    const records = result.records || [];
    console.log(`[locationController] India Gov API Records Found: ${records.length}`);
    if (records.length === 0) {
      console.log({ route: "GET /api/location/pincode", pincode, status: 404, message: "Pincode not found" });
      return res.status(404).json({ success: false, message: "Pincode not found" });
    }

    let bestRecord = records.find((r) => r.deliverystatus === "Delivery" && r.taluk && r.taluk !== "NA");
    if (!bestRecord) bestRecord = records.find((r) => r.taluk && r.taluk !== "NA");
    if (!bestRecord) bestRecord = records.find((r) => r.deliverystatus === "Delivery");
    if (!bestRecord) bestRecord = records[0];

    const data = {
      pincode,
      district: bestRecord.districtname || "",
      state: formatState(bestRecord.statename) || "",
      taluk: bestRecord.taluk && bestRecord.taluk !== "NA" ? bestRecord.taluk : "",
    };

    console.log({ route: "GET /api/location/pincode", pincode, status: 200 });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error(`[locationController] India Gov API error: ${err.message}. Trying postalpincode.in fallback...`);
    try {
      const data = await lookupPincodeFallback(pincode);
      console.log({ route: "GET /api/location/pincode", pincode, status: 200, source: "fallback" });
      return res.status(200).json({ success: true, data });
    } catch (fallbackErr) {
      const timedOut = err.name === "AbortError" || fallbackErr.name === "AbortError";
      console.error({ route: "GET /api/location/pincode", pincode, status: timedOut ? 504 : 500, error: fallbackErr.message });
      return res
        .status(timedOut ? 504 : 500)
        .json({ success: false, message: timedOut ? "Pincode request timed out" : "Internal server error" });
    }
  }
}

// ==================================================================
// PUBLIC — GET /api/location/reverse-geocode?lat=..&lng=..
// Resolves lat/lng to pincode/city/taluk/state via Geoapify, then
// enriches the pincode via the gov pincode directory when possible.
// ==================================================================
async function reverseGeocode(req, res) {
  const { lat, lng } = req.query;
  console.log({ route: "GET /api/location/reverse-geocode", lat, lng, status: "reverse geocoding" });

  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    console.log({ route: "GET /api/location/reverse-geocode", lat, lng, status: 400, message: "Valid lat and lng are required" });
    return res.status(400).json({ success: false, message: "Valid lat and lng are required" });
  }

  const apiKey = process.env.GEOAPIFY_API_KEY;
  const url = `https://api.geoapify.com/v1/geocode/reverse?lat=${latitude}&lon=${longitude}&apiKey=${apiKey}`;

  try {
    console.log(`[locationController] Requesting Geoapify API: ${url.replace(apiKey, "HIDDEN_KEY")}`);
    const response = await fetchWithTimeout(url, 7000);
    console.log(`[locationController] Geoapify API Response Status: ${response.status} ${response.statusText}`);
    if (!response.ok) {
      console.error({ route: "GET /api/location/reverse-geocode", lat, lng, status: response.status, message: "Geoapify request failed" });
      return res.status(502).json({ success: false, message: "Failed to detect location details" });
    }
    const geoData = await response.json();
    const features = geoData.features || [];
    console.log(`[locationController] Geoapify Features Found: ${features.length}`);
    if (features.length === 0) {
      console.log({ route: "GET /api/location/reverse-geocode", lat, lng, status: 404, message: "Location details not found" });
      return res.status(404).json({ success: false, message: "Location details not found" });
    }

    const properties = features[0].properties || {};
    const data = {
      pincode: properties.postcode || "",
      city: properties.city || properties.county || "",
      taluk: properties.suburb || properties.district || "",
      state: properties.state || "",
    };

    // Enrich with the gov pincode directory when we have a clean 6-digit pincode
    if (data.pincode && /^\d{6}$/.test(data.pincode)) {
      try {
        const govApiKey = process.env.GOV_API_KEY;
        const resourceId = process.env.GOV_PINCODE_RESOURCE_ID;
        const govUrl = `https://api.data.gov.in/resource/${resourceId}?api-key=${govApiKey}&format=json&filters[pincode]=${data.pincode}`;
        console.log(`[locationController] Requesting Gov API for enrichment: ${govUrl.replace(govApiKey, "HIDDEN_KEY")}`);
        const govResponse = await fetchWithTimeout(govUrl, 6000);
        console.log(`[locationController] Gov API Enrichment Response Status: ${govResponse.status}`);
        if (govResponse.ok) {
          const govResult = await govResponse.json();
          const records = govResult.records || [];
          console.log(`[locationController] Gov API Enrichment Records Found: ${records.length}`);
          let bestRecord = records.find((r) => r.deliverystatus === "Delivery" && r.taluk && r.taluk !== "NA");
          if (!bestRecord) bestRecord = records.find((r) => r.taluk && r.taluk !== "NA");
          if (!bestRecord) bestRecord = records.find((r) => r.deliverystatus === "Delivery");
          if (!bestRecord) bestRecord = records[0];
          if (bestRecord) {
            data.city = bestRecord.districtname || data.city;
            data.taluk = bestRecord.taluk && bestRecord.taluk !== "NA" ? bestRecord.taluk : data.taluk;
            data.state = formatState(bestRecord.statename) || data.state;
          }
        } else {
          throw new Error(`Gov API response status ${govResponse.status}`);
        }
      } catch (govErr) {
        console.error(`[locationController] Gov API Enrichment error: ${govErr.message}. Trying postalpincode.in fallback...`);
        try {
          const fallbackData = await lookupPincodeFallback(data.pincode);
          data.city = fallbackData.district || data.city;
          data.taluk = fallbackData.taluk || data.taluk;
          data.state = fallbackData.state || data.state;
          console.log(`[locationController] Pincode enrichment fallback succeeded`);
        } catch (fallbackErr) {
          console.error(`[locationController] Pincode enrichment fallback also failed:`, fallbackErr.message);
        }
      }
    }

    console.log({ route: "GET /api/location/reverse-geocode", lat, lng, status: 200 });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    const timedOut = err.name === "AbortError";
    console.error({ route: "GET /api/location/reverse-geocode", lat, lng, status: timedOut ? 504 : 500, error: err.message });
    return res
      .status(timedOut ? 504 : 500)
      .json({ success: false, message: timedOut ? "Location detection timed out" : "Internal server error" });
  }
}

module.exports = { lookupPincode, reverseGeocode };
