require("dotenv").config();
console.log("SERVER STARTING...");

const express = require("express");
const cors = require("cors");
const pool = require("./db");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const fs = require("fs");
const bcrypt = require("bcrypt");
const transporter = require("./config/mail");

const auth = require("./middleware/auth");

const app = express();

app.use(cors());
app.use(express.json());


const JWT_SECRET = process.env.JWT_SECRET;

// ================= DB TEST =================
pool.query("SELECT NOW()")
  .then(() => console.log("DB Connected ✅"))
  .catch(err => {
    console.error("DB Error ❌", err);
  });

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
    const { name, username, email, password, role } = req.body;

    const emailCheck = await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [email]
    );

    if (emailCheck.rows.length > 0) {
      return res.status(400).json({ error: "Email already exists" });
    }

    const usernameCheck = await pool.query(
      "SELECT * FROM users WHERE username=$1",
      [username]
    );

    if (usernameCheck.rows.length > 0) {
      return res.status(400).json({ error: "Username already exists" });
    }

    const hash = await bcrypt.hash(password, 10);

    const otp = Math.floor(100000 + Math.random() * 900000);
    const otpExpire = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      `INSERT INTO users (name, username, email, password, role, otp, otp_expire, is_verified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [name, username, email, hash, role, otp, otpExpire, false]
    );

    // 🔥 TEMP: send OTP in response (for testing)
console.log("OTP:", otp);

res.json({
  success: true,
  message: "OTP generated",
  otp: otp, // 👈 مهم
  email: email
});

   res.json({
  success: true,
  needOtp: true,
  email: email
});

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= VERIFY OTP =================
app.post("/verify-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;

    const result = await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [email]
    );

    const user = result.rows[0];

    if (!user) {
      return res.json({ success: false, error: "User not found" });
    }

    if (user.is_verified) {
      return res.json({ success: true, message: "Already verified" });
    }

    if (user.otp != otp) {
      return res.json({ success: false, error: "Wrong OTP" });
    }

    if (new Date() > user.otp_expire) {
      return res.json({ success: false, error: "OTP expired" });
    }

    await pool.query(
      `UPDATE users 
       SET is_verified=true, otp=null, otp_expire=null
       WHERE email=$1`,
      [email]
    );

    // 🔥 auto login token
    const token = jwt.sign(
  { id: user.id, role: user.role },
  "mysecret123",
  { expiresIn: "7d" }
);

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        role: user.role,
        email: user.email
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
// ================= RESEND OTP =================
app.post("/resend-otp", async (req, res) => {
  try {
    const { email } = req.body;

    const otp = Math.floor(100000 + Math.random() * 900000);
    const expire = new Date(Date.now() + 5 * 60 * 1000);

    await pool.query(
      "UPDATE users SET otp=$1, otp_expire=$2 WHERE email=$3",
      [otp, expire, email]
    );

    console.log("New OTP:", otp);

    res.json({ success: true });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= LOGIN =================
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: "User not found" });
    }

    const user = result.rows[0];

    // ❗ OTP CHECK FIRST
    if (!user.is_verified) {
      return res.json({
        success: false,
        needOtp: true,
        email: user.email
      });
    }

    const ok = await bcrypt.compare(password, user.password);

    if (!ok) {
      return res.status(400).json({ error: "Wrong password" });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      success: true,
      token,
      user
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
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
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});