const express = require('express');
const cors = require('cors');
const pool = require('./db');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');
const bcrypt = require('bcrypt');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || "secret_key";

// =======================
// 🟢 TEST ROUTE
// =======================
app.get('/', (req, res) => {
  res.send("API is running 🚀");
});

// =======================
// 📂 UPLOAD SYSTEM
// =======================
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) =>
    cb(null, Date.now() + "-" + file.originalname)
});

const upload = multer({ storage });

app.use('/uploads', express.static('uploads'));

// =======================
// 🔐 AUTH MIDDLEWARE
// =======================
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) return res.status(401).json({ error: "No token" });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(403).json({ error: "Invalid token" });
  }
};

// =======================
// 👤 REGISTER
// =======================
app.post('/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    const exist = await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [email]
    );

    if (exist.rows.length > 0) {
      return res.status(400).json({ error: "Email exists" });
    }

    const hash = await bcrypt.hash(password, 10);

    await pool.query(
      "INSERT INTO users(name,email,password,role) VALUES($1,$2,$3,$4)",
      [name, email, hash, role]
    );

    res.json({ success: true });

  } catch (e) {
    console.error("REGISTER ERROR:", e);
    res.status(500).json({ error: e.message });
  }
});

// =======================
// 🔐 LOGIN
// =======================
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [email]
    );

    if (user.rows.length === 0)
      return res.status(400).json({ error: "User not found" });

    const valid = await bcrypt.compare(password, user.rows[0].password);

    if (!valid)
      return res.status(400).json({ error: "Wrong password" });

    const token = jwt.sign(
      { id: user.rows[0].id, role: user.rows[0].role },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      user: user.rows[0]
    });

  } catch (e) {
    console.error("LOGIN ERROR:", e);
    res.status(500).json({ error: e.message });
  }
});

// =======================
// 📦 PRODUCTS
// =======================
app.get('/products', async (req, res) => {
  try {
    const data = await pool.query("SELECT * FROM products ORDER BY id DESC");
    res.json(data.rows);
  } catch (e) {
    console.error("PRODUCT ERROR:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/products', auth, upload.single('image'), async (req, res) => {
  try {
    const { name, price } = req.body;
    const image = req.file?.filename;

    const result = await pool.query(
      `INSERT INTO products(name,price,seller_id,image)
       VALUES($1,$2,$3,$4) RETURNING *`,
      [name, price, req.user.id, image]
    );

    res.json(result.rows[0]);
  } catch (e) {
    console.error("ADD PRODUCT ERROR:", e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/products/:id', auth, async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM products WHERE id=$1 AND seller_id=$2",
      [req.params.id, req.user.id]
    );

    res.json({ success: true });
  } catch (e) {
    console.error("DELETE PRODUCT ERROR:", e);
    res.status(500).json({ error: e.message });
  }
});

// =======================
// 🛒 CART
// =======================
app.post('/cart', auth, async (req, res) => {
  try {
    const { product_id, quantity } = req.body;

    await pool.query(
      "INSERT INTO cart(user_id,product_id,quantity) VALUES($1,$2,$3)",
      [req.user.id, product_id, quantity || 1]
    );

    res.json({ success: true });
  } catch (e) {
    console.error("CART ERROR:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/cart', auth, async (req, res) => {
  try {
    const data = await pool.query(
      `SELECT c.id, c.quantity, p.name, p.price, p.image
       FROM cart c
       JOIN products p ON p.id=c.product_id
       WHERE c.user_id=$1`,
      [req.user.id]
    );

    res.json(data.rows);
  } catch (e) {
    console.error("GET CART ERROR:", e);
    res.status(500).json({ error: e.message });
  }
});

// =======================
// 💳 CHECKOUT
// =======================
app.post('/checkout', auth, async (req, res) => {
  try {
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

  } catch (e) {
    console.error("CHECKOUT ERROR:", e);
    res.status(500).json({ error: e.message });
  }
});

// =======================
// 📦 ORDERS
// =======================
app.get('/orders', auth, async (req, res) => {
  try {
    const data = await pool.query(
      "SELECT * FROM orders WHERE user_id=$1",
      [req.user.id]
    );

    res.json(data.rows);
  } catch (e) {
    console.error("ORDERS ERROR:", e);
    res.status(500).json({ error: e.message });
  }
});

// =======================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT + " 🚀");
});