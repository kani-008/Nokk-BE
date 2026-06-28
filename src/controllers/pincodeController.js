const db = require("../config/db.js");

// GET /api/pincode/get-by-pincode?pincode=600001
async function getByPincode(req, res) {
  const { pincode } = req.query;

  if (!pincode || !/^\d{6}$/.test(pincode.trim())) {
    return res.status(400).json({
      success: false,
      message: "pincode must be a 6-digit number",
    });
  }

  try {
    const { rows } = await db.query(
      `SELECT office_name, taluk, district, state
         FROM pincode_directory
        WHERE pincode = $1`,
      [pincode.trim()]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Pincode ${pincode} not found in directory`,
      });
    }

    // district and state are consistent across all offices sharing a pincode;
    // return them as single values and expose all office names as an array.
    return res.json({
      success: true,
      data: {
        pincode: pincode.trim(),
        district: rows[0].district,
        state: rows[0].state,
        taluk: rows[0].taluk,
        offices: rows.map((r) => r.office_name),
      },
    });
  } catch (err) {
    console.error("getByPincode error:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

module.exports = { getByPincode };
