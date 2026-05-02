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

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only images allowed"));
    }
    cb(null, true);
  }
});

app.use("/uploads", express.static("uploads"));

// ================= REGISTER =================
app.post("/register", async (req, res) => {
  try {
    const { name, username, email, password, role } = req.body;

    // 🔴 تحقق من وجود المستخدم
    const exists = await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [email]
    );

    if (exists.rows.length > 0) {
      return res.json({
        success: false,
        error: "Email already exists ❌",
      });
    }

    const hash = await bcrypt.hash(password, 10);

    const otp = Math.floor(100000 + Math.random() * 900000);
    const otpExpire = new Date(Date.now() + 60 * 1000);

    await pool.query(
      `INSERT INTO users (name, username, email, password, role, otp, otp_expire, is_verified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [name, username, email, hash, role, otp, otpExpire, false]
    );

    console.log("OTP:", otp);

    // 🔥 لا نستخدم إيميل (تطوير فقط)

    return res.json({
      success: true,
      email,
      otp, // 👈 مهم جدا
    });

  } catch (err) {
    console.log("REGISTER ERROR ❌", err.message);
    return res.status(500).json({ error: err.message });
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

    if (user.otp != otp) {
      return res.json({ success: false, error: "Wrong OTP" });
    }

    if (new Date() > user.otp_expire) {
      return res.json({ success: false, error: "OTP expired" });
    }

    await pool.query(
      "UPDATE users SET is_verified=true, otp=null, otp_expire=null WHERE email=$1",
      [email]
    );

    return res.json({ success: true });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
// ================= RESEND OTP =================
app.post("/resend-otp", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: "Email missing",
      });
    }

    const otp = Math.floor(100000 + Math.random() * 900000);
    const otpExpire = new Date(Date.now() + 60 * 1000);

    await pool.query(
      "UPDATE users SET otp=$1, otp_expire=$2 WHERE email=$3",
      [otp, otpExpire, email]
    );

    console.log("NEW OTP:", otp);

    return res.json({
      success: true,
      otp, // 👈 مهم
    });

  } catch (err) {
    console.log("RESEND ERROR ❌", err.message);
    return res.status(500).json({ error: err.message });
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

    // 1️⃣ check password
    const ok = await bcrypt.compare(password, user.password);

    if (!ok) {
      return res.status(400).json({ error: "Wrong password" });
    }

    // 2️⃣ check OTP verification
    if (!user.is_verified) {
      return res.json({
        success: false,
        needOtp: true,
        email: user.email
      });
    }

    // 3️⃣ create token
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


app.get("/profile", auth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, email, image FROM users WHERE id=$1",
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({
  success: true,
  user: result.rows[0]
});

  } catch (err) {
    console.error("GET PROFILE ERROR ❌", err);
    res.status(500).json({ error: err.message });
  }
});

// ================= PRODUCTS =================
app.get("/products", async (req, res) => {
  try {
    const data = await pool.query(
      `SELECT p.*, u.name as seller_name
       FROM products p
       JOIN users u ON u.id = p.seller_id
       ORDER BY p.id DESC`
    );

    res.json(data.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
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
app.get("/my-products", auth, async (req, res) => {
  const data = await pool.query(
    "SELECT * FROM products WHERE seller_id=$1",
    [req.user.id]
  );

  res.json(data.rows);
});

app.put("/products/:id", auth, async (req, res) => {
  const { name, price } = req.body;

  const result = await pool.query(
    `UPDATE products 
     SET name=$1, price=$2 
     WHERE id=$3 AND seller_id=$4
     RETURNING *`,
    [name, price, req.params.id, req.user.id]
  );

  if (result.rowCount === 0) {
    return res.status(403).json({
      success: false,
      error: "Not allowed ❌"
    });
  }

  res.json({ success: true, product: result.rows[0] });
});

// ================= SELLER PROFILE =================
app.get("/seller/:id", async (req, res) => {
  const id = req.params.id;

  const user = await pool.query(
    "SELECT id, name, email, image FROM users WHERE id=$1",
    [id]
  );

  const products = await pool.query(
    "SELECT COUNT(*) FROM products WHERE seller_id=$1",
    [id]
  );

  res.json({
    user: user.rows[0],
    productsCount: products.rows[0].count
  });
});
// ================= BECOME SELLER =================
app.put("/become-seller", auth, async (req, res) => {
  try {
    await pool.query(
      "UPDATE users SET role='seller' WHERE id=$1",
      [req.user.id]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ================= CART =================
app.post("/cart", auth, async (req, res) => {
  const { product_id, quantity } = req.body;

  const exists = await pool.query(
    "SELECT * FROM cart WHERE user_id=$1 AND product_id=$2",
    [req.user.id, product_id]
  );

  if (exists.rows.length > 0) {
    await pool.query(
      "UPDATE cart SET quantity = quantity + 1 WHERE user_id=$1 AND product_id=$2",
      [req.user.id, product_id]
    );
  } else {
    await pool.query(
      "INSERT INTO cart(user_id,product_id,quantity) VALUES($1,$2,$3)",
      [req.user.id, product_id, quantity]
    );
  }

  res.json({ success: true });
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
// ================= MESSAGE =================
app.post("/messages", auth, async (req, res) => {
  const { receiver_id, message } = req.body;

  const result = await pool.query(
    `INSERT INTO messages(sender_id, receiver_id, message)
     VALUES($1,$2,$3) RETURNING *`,
    [req.user.id, receiver_id, message]
  );

  res.json(result.rows[0]);
});

app.get("/messages/:userId", auth, async (req, res) => {
  try {
    const otherUser = parseInt(req.params.userId);
    const limit = 50;

    const result = await pool.query(
      `SELECT * FROM messages
       WHERE (sender_id=$1 AND receiver_id=$2)
          OR (sender_id=$2 AND receiver_id=$1)
       ORDER BY created_at ASC
       LIMIT $3`,
      [req.user.id, otherUser, limit]
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to load messages" });
  }
});
// ================= ORDERS =================
app.get("/orders", auth, async (req, res) => {
  try {
    const data = await pool.query(
      "SELECT * FROM orders WHERE user_id=$1 ORDER BY id DESC",
      [req.user.id]
    );

    res.json(data.rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to load orders" });
  }
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

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});