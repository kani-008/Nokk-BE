require("dotenv").config();
const db = require("./src/config/db.js");

async function check() {
  const banners = await db.query("SELECT * FROM banners");
  console.log("BANNERS:");
  console.log(banners.rows);

  const btexts = await db.query("SELECT * FROM btext");
  console.log("BTEXTS:");
  console.log(btexts.rows);
}
check().then(() => process.exit(0)).catch(console.error);
