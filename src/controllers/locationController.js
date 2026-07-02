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
    const response = await fetchWithTimeout(url, 6000);
    if (!response.ok) {
      console.error({ route: "GET /api/location/pincode", pincode, status: 502, message: "Gov API request failed" });
      return res.status(502).json({ success: false, message: "Failed to fetch pincode details" });
    }
    const result = await response.json();
    const records = result.records || [];
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
    const timedOut = err.name === "AbortError";
    console.error({ route: "GET /api/location/pincode", pincode, status: timedOut ? 504 : 500, error: err.message });
    return res
      .status(timedOut ? 504 : 500)
      .json({ success: false, message: timedOut ? "Pincode request timed out" : "Internal server error" });
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
    const response = await fetchWithTimeout(url, 7000);
    if (!response.ok) {
      console.error({ route: "GET /api/location/reverse-geocode", lat, lng, status: 502, message: "Geoapify request failed" });
      return res.status(502).json({ success: false, message: "Failed to detect location details" });
    }
    const geoData = await response.json();
    const features = geoData.features || [];
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
        const govResponse = await fetchWithTimeout(govUrl, 6000);
        if (govResponse.ok) {
          const govResult = await govResponse.json();
          const records = govResult.records || [];
          let bestRecord = records.find((r) => r.deliverystatus === "Delivery" && r.taluk && r.taluk !== "NA");
          if (!bestRecord) bestRecord = records.find((r) => r.taluk && r.taluk !== "NA");
          if (!bestRecord) bestRecord = records.find((r) => r.deliverystatus === "Delivery");
          if (!bestRecord) bestRecord = records[0];
          if (bestRecord) {
            data.city = bestRecord.districtname || data.city;
            data.taluk = bestRecord.taluk && bestRecord.taluk !== "NA" ? bestRecord.taluk : data.taluk;
            data.state = formatState(bestRecord.statename) || data.state;
          }
        }
      } catch {
        // fall back to raw Geoapify values silently
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
