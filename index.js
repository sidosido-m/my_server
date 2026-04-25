const express = require('express');
const cors = require('cors');
const pool = require('./db');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = "secret_key";

// ================= EMAIL =================
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "toopvedeo00@gmail.com",
    pass: "naqa hfaz heoi hqf" // ⚠️ مهم جدا
  }
});

// ================= UPLOAD =================
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) =>
    cb(null, Date.now() + "-" + file.originalname)
});

const upload = multer({ storage });
app.use('/uploads', express.static('uploads'));

// ================= AUTH MIDDLEWARE =================
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "No token" });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(403).json({ error: "Invalid token" });
  }
};

// ================= REGISTER + OTP =================
app.post('/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    const exist = await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [email]
    );

    if (exist.rows.length > 0) {
      return res.status(400).json({ error: "Email already exists" });
    }

    const hash = await bcrypt.hash(password, 10);

    const otp = Math.floor(100000 + Math.random() * 900000);

    const expire = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    await pool.query(
      `INSERT INTO users(name,email,password,role,otp,otp_expire,is_verified)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [name, email, hash, role, otp, expire, false]
    );

    // ⚡ هنا بدل Gmail نرجع OTP للتجربة (لاحقاً نضيف SMS)
    res.json({
      success: true,
      message: "OTP generated",
      otp: otp // 🔥 للتجربة فقط
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ================= VERIFY OTP =================
app.post('/verify-otp', async (req, res) => {
  const { email, otp } = req.body;

  const user = await pool.query(
    "SELECT * FROM users WHERE email=$1",
    [email]
  );

  if (user.rows.length === 0) {
    return res.status(400).json({ error: "User not found" });
  }

  const dbUser = user.rows[0];

  // ❌ OTP خطأ
  if (dbUser.otp != otp) {
    return res.status(400).json({ error: "Wrong OTP" });
  }

  // ❌ OTP منتهي
  if (new Date() > new Date(dbUser.otp_expire)) {
    return res.status(400).json({ error: "OTP expired" });
  }

  await pool.query(
    "UPDATE users SET is_verified=true, otp=NULL WHERE email=$1",
    [email]
  );

  res.json({ success: true, message: "Account verified" });
});
// ================= LOGIN =================
app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  const user = await pool.query(
    "SELECT * FROM users WHERE email=$1",
    [email]
  );

  if (user.rows.length === 0) {
    return res.status(400).json({ error: "User not found" });
  }

  const dbUser = user.rows[0];

  if (!dbUser.is_verified) {
    return res.status(400).json({ error: "Verify OTP first" });
  }

  const valid = await bcrypt.compare(password, dbUser.password);

  if (!valid) {
    return res.status(400).json({ error: "Wrong password" });
  }

  const token = jwt.sign(
    { id: dbUser.id, role: dbUser.role },
    JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.json({
    token,
    user: dbUser
  });
});

// ================= PRODUCTS =================
app.get('/products', async (req, res) => {
  const data = await pool.query("SELECT * FROM products");
  res.json(data.rows);
});

app.post('/products', auth, upload.single('image'), async (req, res) => {
  const { name, price } = req.body;
  const image = req.file?.filename;

  const result = await pool.query(
    `INSERT INTO products(name,price,seller_id,image)
     VALUES($1,$2,$3,$4) RETURNING *`,
    [name, price, req.user.id, image]
  );

  res.json(result.rows[0]);
});

app.put('/products/:id', auth, async (req, res) => {
  const { name, price } = req.body;

  const result = await pool.query(
    `UPDATE products SET name=$1, price=$2
     WHERE id=$3 AND seller_id=$4 RETURNING *`,
    [name, price, req.params.id, req.user.id]
  );

  res.json(result.rows[0]);
});

app.delete('/products/:id', auth, async (req, res) => {
  await pool.query(
    "DELETE FROM products WHERE id=$1 AND seller_id=$2",
    [req.params.id, req.user.id]
  );

  res.json({ success: true });
});

// ================= profile =================
app.put('/profile', auth, async (req, res) => {
  try {
    const { name, email, password } = req.body;

    let query;
    let values;

    if (password) {
      const hash = await bcrypt.hash(password, 10);

      query = `
        UPDATE users 
        SET name=$1, email=$2, password=$3 
        WHERE id=$4 
        RETURNING id, name, email, role
      `;

      values = [name, email, hash, req.user.id];
    } else {
      query = `
        UPDATE users 
        SET name=$1, email=$2 
        WHERE id=$3 
        RETURNING id, name, email, role
      `;

      values = [name, email, req.user.id];
    }

    const result = await pool.query(query, values);

    res.json(result.rows[0]);

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ================= CART =================
app.post('/cart', auth, async (req, res) => {
  const { product_id, quantity } = req.body;

  await pool.query(
    "INSERT INTO cart(user_id,product_id,quantity) VALUES($1,$2,$3)",
    [req.user.id, product_id, quantity]
  );

  res.json({ success: true });
});

app.get('/cart', auth, async (req, res) => {
  const data = await pool.query(
    `SELECT c.id, c.quantity, p.name, p.price, p.image
     FROM cart c
     JOIN products p ON p.id=c.product_id
     WHERE c.user_id=$1`,
    [req.user.id]
  );

  res.json(data.rows);
});

// ================= CHECKOUT =================
app.post('/checkout', auth, async (req, res) => {
  const cart = await pool.query(
    `SELECT c.*, p.price FROM cart c
     JOIN products p ON p.id=c.product_id
     WHERE c.user_id=$1`,
    [req.user.id]
  );

  let total = 0;
  cart.rows.forEach(i => total += i.price * i.quantity);

  const order = await pool.query(
    "INSERT INTO orders(user_id,total_price) VALUES($1,$2) RETURNING *",
    [req.user.id, total]
  );

  const orderId = order.rows[0].id;

  for (let item of cart.rows) {
    await pool.query(
      `INSERT INTO order_items(order_id,product_id,quantity,price)
       VALUES($1,$2,$3,$4)`,
      [orderId, item.product_id, item.quantity, item.price]
    );
  }

  await pool.query("DELETE FROM cart WHERE user_id=$1", [req.user.id]);

  res.json({ success: true, orderId });
});

// ================= ORDERS =================
app.get('/orders', auth, async (req, res) => {
  const data = await pool.query(
    "SELECT * FROM orders WHERE user_id=$1",
    [req.user.id]
  );

  res.json(data.rows);
});

// ================= START SERVER =================
app.listen(3000, "0.0.0.0", () => {
  console.log("Server running on port 3000 🚀");
});