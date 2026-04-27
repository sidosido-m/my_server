require("dotenv").config();

const express = require("express");
const cors = require("cors");
const pool = require("./db");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const fs = require("fs");
const bcrypt = require("bcrypt");

const auth = require("./middleware/auth");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET;

// ================= DB TEST =================
pool.query("SELECT NOW()")
  .then(() => console.log("DB Connected ✅"))
  .catch(err => console.error("DB Error ❌", err));

// ================= UPLOAD =================
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  },
});

const upload = multer({ storage });

app.use("/uploads", express.static("uploads"));

// ================= REGISTER =================
app.post("/register", async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    const check = await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [email]
    );

    if (check.rows.length > 0) {
      return res.status(400).json({ error: "Email already exists" });
    }

    const hash = await bcrypt.hash(password, 10);

    const otp = Math.floor(100000 + Math.random() * 900000);
    const expire = new Date(Date.now() + 5 * 60 * 1000);

    await pool.query(
      `INSERT INTO users(name,email,password,role,otp,otp_expire,is_verified)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [name, email, hash, role, otp, expire, false]
    );

    res.json({ success: true, otp });

  } catch (err) {
    console.error("REGISTER ERROR ❌", err);
    res.status(500).json({ error: err.message });
  }
});

// ================= VERIFY OTP =================
app.post("/verify-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;

    const user = await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [email]
    );

    if (!user.rows.length)
      return res.status(400).json({ error: "User not found" });

    const u = user.rows[0];

    if (u.otp != otp)
      return res.status(400).json({ error: "Wrong OTP" });

    if (new Date() > new Date(u.otp_expire))
      return res.status(400).json({ error: "OTP expired" });

    await pool.query(
      "UPDATE users SET is_verified=true, otp=NULL WHERE email=$1",
      [email]
    );

    res.json({ success: true });

  } catch (err) {
    console.error("OTP ERROR ❌", err);
    res.status(500).json({ error: err.message });
  }
});

// ================= LOGIN =================
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [email]
    );

    if (!user.rows.length)
      return res.status(400).json({ error: "User not found" });

    const u = user.rows[0];

    if (!u.is_verified)
      return res.status(400).json({ error: "Verify OTP first" });

    const ok = await bcrypt.compare(password, u.password);

    if (!ok)
      return res.status(400).json({ error: "Wrong password" });

    const token = jwt.sign(
      { id: u.id, role: u.role },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ token, user: u });

  } catch (err) {
    console.error("LOGIN ERROR ❌", err);
    res.status(500).json({ error: err.message });
  }
});

// ================= PROFILE =================
app.put("/profile", auth, async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (password) {
      const hash = await bcrypt.hash(password, 10);

      await pool.query(
        "UPDATE users SET name=$1,email=$2,password=$3 WHERE id=$4",
        [name, email, hash, req.user.id]
      );
    } else {
      await pool.query(
        "UPDATE users SET name=$1,email=$2 WHERE id=$3",
        [name, email, req.user.id]
      );
    }

    res.json({ success: true });

  } catch (err) {
    console.error("PROFILE ERROR ❌", err);
    res.status(500).json({ error: err.message });
  }
});

// ================= PRODUCTS =================
app.get("/products", async (req, res) => {
  const data = await pool.query(
    "SELECT * FROM products ORDER BY id DESC"
  );
  res.json(data.rows);
});

app.post("/products", auth, upload.single("image"), async (req, res) => {
  const { name, price } = req.body;

  const result = await pool.query(
    `INSERT INTO products(name,price,seller_id,image)
     VALUES($1,$2,$3,$4) RETURNING *`,
    [name, price, req.user.id, req.file?.filename]
  );

  res.json(result.rows[0]);
});

app.delete("/products/:id", auth, async (req, res) => {
  await pool.query(
    "DELETE FROM products WHERE id=$1 AND seller_id=$2",
    [req.params.id, req.user.id]
  );
  res.json({ success: true });
});

app.put("/products/:id", auth, async (req, res) => {
  const { name, price } = req.body;

  await pool.query(
    "UPDATE products SET name=$1,price=$2 WHERE id=$3 AND seller_id=$4",
    [name, price, req.params.id, req.user.id]
  );

  res.json({ success: true });
});

// ================= CART =================
app.post("/cart", auth, async (req, res) => {
  const { product_id, quantity } = req.body;

  await pool.query(
    "INSERT INTO cart(user_id,product_id,quantity) VALUES($1,$2,$3)",
    [req.user.id, product_id, quantity]
  );

  res.json({ success: true });
});

app.get("/cart", auth, async (req, res) => {
  const data = await pool.query(
    `SELECT c.*,p.name,p.price
     FROM cart c
     JOIN products p ON p.id=c.product_id
     WHERE c.user_id=$1`,
    [req.user.id]
  );

  res.json(data.rows);
});

// ================= CHECKOUT =================
app.post("/checkout", auth, async (req, res) => {
  const cart = await pool.query(
    `SELECT c.*,p.price FROM cart c
     JOIN products p ON p.id=c.product_id
     WHERE c.user_id=$1`,
    [req.user.id]
  );

  let total = 0;

  cart.rows.forEach(i => {
    total += i.price * i.quantity;
  });

  await pool.query(
    "INSERT INTO orders(user_id,total_price) VALUES($1,$2)",
    [req.user.id, total]
  );

  await pool.query("DELETE FROM cart WHERE user_id=$1", [
    req.user.id,
  ]);

  res.json({ success: true });
});

// ================= ORDERS =================
app.get("/orders", auth, async (req, res) => {
  const data = await pool.query(
    "SELECT * FROM orders WHERE user_id=$1 ORDER BY id DESC",
    [req.user.id]
  );

  res.json(data.rows);
});

// ================= TEST DB =================
app.get("/test-db", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({
      success: true,
      time: result.rows[0],
    });
  } catch (err) {
    console.error("TEST DB ERROR ❌", err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// ================= ROOT =================
app.get("/", (req, res) => {
  res.send("Server is running 🚀");
});

// ================= START =================
app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT, "🚀");
});