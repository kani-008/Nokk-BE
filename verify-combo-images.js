require("dotenv").config();
const db = require("./src/config/db.js");

async function check() {
  const res = await db.query("SELECT * FROM settings");
  console.log("SETTINGS:", res.rows);
}
check().then(() => process.exit(0)).catch(console.error);
