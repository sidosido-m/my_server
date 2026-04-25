// db.js
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// 🔥 اختبار الاتصال هنا
pool.query('SELECT NOW()')
  .then(res => console.log("DB Connected ✅", res.rows[0]))
  .catch(err => console.error("DB Error ❌", err));

module.exports = pool;