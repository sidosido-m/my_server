require("dotenv").config();
console.log("SERVER STARTING...");

const express = require("express");
const cors = require("cors");
const pool = require("./db");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");
const auth = require("./middleware/auth");
const app = express();
const cloudinary = require("cloudinary").v2;
const http = require("http");
const server = http.createServer(app);
const { Server } = require("socket.io");
const onlineUsers = new Map();

const io = new Server(server, {
  cors: { origin: "*" },
});

const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

const baseUrl = process.env.BASE_URL;
const JWT_SECRET = process.env.JWT_SECRET;

const uploadDir = path.join(__dirname, "uploads");

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET,
});

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// ================= DB TEST =================
pool.query("SELECT NOW()")
  .then(() => console.log("DB Connected ✅"))
  .catch(err => {
    console.error("DB Error ❌", err);
  });
//============== SOCKETS ================
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("online", (userId) => {
    onlineUsers.set(userId, socket.id);
    io.emit("user-status", { userId, status: "online" });
  });

  socket.on("send-message", async (data) => {
    console.log("MESSAGE:", data);

    const { senderId, receiverId, message, type } = data;

    const result = await pool.query(
      `INSERT INTO messages(sender_id, receiver_id, message, type, status)
       VALUES($1,$2,$3,$4,'sent')
       RETURNING *`,
      [senderId, receiverId, message, type || "text"]
    );

    const saved = result.rows[0];

    const receiverSocket = onlineUsers.get(receiverId);

    if (receiverSocket) {
      io.to(receiverSocket).emit("new-message", saved);
    }

    const senderSocket = onlineUsers.get(senderId);

    if (senderSocket) {
      io.to(senderSocket).emit("new-message", saved);
    }
  });

  socket.on("disconnect", () => {
    for (let [userId, socketId] of onlineUsers.entries()) {
      if (socketId === socket.id) {
        onlineUsers.delete(userId);
        io.emit("user-status", { userId, status: "offline" });
        break;
      }
    }
  });
});

// ================= STORAGE =================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },

  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const safeName = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, safeName + ext);
  },
});

// ================= FILTER =================
 
const fileFilter = (req, file, cb) => {
  console.log("UPLOAD FILE TYPE:", file.mimetype);

  // ✅ قبول كل الملفات
  cb(null, true);
};
// ================= MULTER =================
const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter,
});

// ================= STATIC ACCESS =================
app.post("/upload", upload.single("image"), async (req, res) => {
  try {

    console.log("REQ FILE:", req.file);

    if (!req.file) {
      return res.status(400).json({
        error: "NO FILE RECEIVED"
      });
    }

    const result = await cloudinary.uploader.upload(
      req.file.path,
      {
        folder: "my_app",
      }
    );

    console.log("CLOUDINARY RESULT:", result);

    fs.unlinkSync(req.file.path);

    res.json({
      url: result.secure_url,
    });

  } catch (err) {

    console.error("UPLOAD ERROR ❌", err);

    res.status(500).json({
      error: err.message,
    });
  }
});
// ================= REGISTER =================
app.post("/register", async (req, res) => {
  try {
    const { name, username, email, password, role,phone,countryCode,gender } = req.body;

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
      `INSERT INTO users (name, username, email, password, role, otp,phone,country_code,gender, otp_expire, is_verified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
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

    // ========== check password=============
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

    // ======= create token============
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
    const {
      name,
      email,
      username,
      phone,
      oldPassword,
      newPassword,
      image,
      background_image,
    } = req.body;

    const user = await pool.query(
      "SELECT * FROM users WHERE id=$1",
      [req.user.id]
    );

    const currentUser = user.rows[0];

    let hashedPassword = currentUser.password;

    if (newPassword) {
      const valid = await bcrypt.compare(oldPassword, currentUser.password);

      if (!valid) {
        return res.status(400).json({ error: "Wrong old password" });
      }

      hashedPassword = await bcrypt.hash(newPassword, 10);
    }
console.log("REQ BODY:", req.body);
    console.log("IMAGE:", image);
console.log("BG:", background_image);

    await pool.query(
  `UPDATE users SET 
    name=$1,
    email=$2,
    username=$3,
    password=$4,
    image = COALESCE($5, image),
    background_image = COALESCE($6, background_image)
   WHERE id=$7`,
  [
    name,
    email,
    username,
    hashedPassword,
    image,
    background_image,
    req.user.id,
  ]
);


    res.json({ success: true });

  } catch (err) {
    console.error("PROFILE ERROR ❌", err);
    res.status(500).json({ error: err.message });
  }
});
//==============GET PTOFILE ============
app.get("/profile", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, username, email, image, background_image, role
       FROM users WHERE id=$1`,
      [req.user.id]
    );

    const user = result.rows[0];

    const followers = await pool.query(
      "SELECT COUNT(*) FROM followers WHERE seller_id=$1",
      [req.user.id]
    );

    const following = await pool.query(
      "SELECT COUNT(*) FROM followers WHERE user_id=$1",
      [req.user.id]
    );

    res.json({
      user,
      stats: {
        followers: followers.rows[0].count,
        following: following.rows[0].count,
      },
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ================= PRODUCTS =================

// 🔥 GET ALL PRODUCTS (لكل المستخدمين - الصفحة الرئيسية)
app.get("/products", async (req, res) => {
  try {
    const data = await pool.query(
      `SELECT p.*, u.name as seller_name, u.image as seller_image
       FROM products p
       JOIN users u ON u.id = p.seller_id
       ORDER BY p.id DESC`
    );

    res.json(data.rows);
  } catch (err) {
    console.error("GET PRODUCTS ERROR ❌", err);
    res.status(500).json({ error: "Server error" });
  }
});


// 🔥 GET MY PRODUCTS (منتجات المستخدم فقط)
app.get("/my-products", auth, async (req, res) => {
  try {
    const data = await pool.query(
      "SELECT * FROM products WHERE seller_id=$1 ORDER BY id DESC",
      [req.user.id]
    );

    res.json(data.rows);
  } catch (err) {
    console.error("MY PRODUCTS ERROR ❌", err);
    res.status(500).json({ error: "Server error" });
  }
});


// 🔥 ADD PRODUCT
app.post("/products", auth, async (req, res) => {
  try {
    const { name, price, image } = req.body;

    const result = await pool.query(
      `INSERT INTO products(name, price, seller_id, image)
       VALUES($1,$2,$3,$4) RETURNING *`,
      [name, price, req.user.id, image] // 🔥 رابط Supabase
    );

    res.json({
      success: true,
      product: result.rows[0],
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


// 🔥 UPDATE PRODUCT (مهم: فقط صاحب المنتج)
app.put("/products/:id", auth, async (req, res) => {
  try {
    const { name, price, image } = req.body;

const result = await pool.query(
  `UPDATE products 
   SET name=$1, price=$2, image=COALESCE($3, image)
   WHERE id=$4 AND seller_id=$5
   RETURNING *`,
  [name, price, image, req.params.id, req.user.id]
);

    if (result.rowCount === 0) {
      return res.status(403).json({
        success: false,
        error: "Not allowed ❌",
      });
    }

    res.json({
      success: true,
      product: result.rows[0],
    });

  } catch (err) {
    console.error("UPDATE ERROR ❌", err);
    res.status(500).json({ error: "Server error" });
  }
});


// 🔥 DELETE PRODUCT (فقط المالك)
app.delete("/products/:id", auth, async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM products WHERE id=$1 AND seller_id=$2",
      [req.params.id, req.user.id]
    );

    if (result.rowCount === 0) {
      return res.status(403).json({
        success: false,
        error: "Not allowed ❌",
      });
    }

    res.json({
      success: true,
    });

  } catch (err) {
    console.error("DELETE ERROR ❌", err);
    res.status(500).json({ error: "Server error" });
  }
});
// ================= SELLER PROFILE =================
app.get("/seller/:id", async (req, res) => {
  const id = req.params.id;

  try {
    const user = await pool.query(
      `SELECT id, name, username, email, image, background_image
       FROM users WHERE id=$1`,
      [id]
    );

    const products = await pool.query(
      "SELECT * FROM products WHERE seller_id=$1 ORDER BY id DESC",
      [id]
    );

    const followers = await pool.query(
      "SELECT COUNT(*) FROM followers WHERE seller_id=$1",
      [id]
    );

    const following = await pool.query(
      "SELECT COUNT(*) FROM followers WHERE user_id=$1",
      [id]
    );

    const rating = await pool.query(
      "SELECT COALESCE(AVG(rating),0) FROM reviews WHERE seller_id=$1",
      [id]
    );

    res.json({
      seller: user.rows[0],
      products: products.rows,
      followers: followers.rows[0].count,
      following: following.rows[0].count,
      rating: rating.rows[0].coalesce
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
//-----------FOLLOW----------------
app.post("/follow/:sellerId", auth, async (req, res) => {
  const sellerId = req.params.sellerId;

  const exists = await pool.query(
    "SELECT * FROM followers WHERE user_id=$1 AND seller_id=$2",
    [req.user.id, sellerId]
  );

  if (exists.rows.length > 0) {
    await pool.query(
      "DELETE FROM followers WHERE user_id=$1 AND seller_id=$2",
      [req.user.id, sellerId]
    );

    return res.json({ following: false });
  }

  await pool.query(
    "INSERT INTO followers(user_id, seller_id) VALUES($1,$2)",
    [req.user.id, sellerId]
  );

  res.json({ following: true });
});

//-----------Followers----------------
app.get("/followers/:sellerId", async (req, res) => {
  try {
    const data = await pool.query(
      `SELECT u.id, u.name, u.image
       FROM followers f
       JOIN users u ON u.id = f.user_id
       WHERE f.seller_id=$1`,
      [req.params.sellerId]
    );

    res.json(data.rows);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get("/following/:userId", async (req, res) => {
  try {
    const data = await pool.query(
      `SELECT u.id, u.name, u.username, u.image
       FROM followers f
       JOIN users u ON u.id = f.seller_id
       WHERE f.user_id=$1`,
      [req.params.userId]
    );

    res.json(data.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
//-----------/seller-stats/:sellerId----------------
app.get("/seller-stats/:sellerId", async (req, res) => {
  try {
    const followers = await pool.query(
      "SELECT COUNT(*) FROM followers WHERE seller_id=$1",
      [req.params.sellerId]
    );

    const following = await pool.query(
      "SELECT COUNT(*) FROM followers WHERE user_id=$1",
      [req.params.sellerId]
    );

    const rating = await pool.query(
      "SELECT COALESCE(AVG(rating),0) as avg FROM reviews WHERE seller_id=$1",
      [req.params.sellerId]
    );

    res.json({
      followers: followers.rows[0].count,
      following: following.rows[0].count,
      rating: rating.rows[0].avg,
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

//-----------REVIEW----------------
app.post("/review/:sellerId", auth, async (req, res) => {
  const { rating } = req.body;

  const exists = await pool.query(
    "SELECT * FROM reviews WHERE user_id=$1 AND seller_id=$2",
    [req.user.id, req.params.sellerId]
  );

  if (exists.rows.length > 0) {
    await pool.query(
      "UPDATE reviews SET rating=$1 WHERE user_id=$2 AND seller_id=$3",
      [rating, req.user.id, req.params.sellerId]
    );
  } else {
    await pool.query(
      "INSERT INTO reviews(user_id,seller_id,rating) VALUES($1,$2,$3)",
      [req.user.id, req.params.sellerId, rating]
    );
  }

  res.json({ success: true });
});

//-----------DASHBOARD----------------
app.get("/seller-dashboard", auth, async (req, res) => {
  const id = req.user.id;

  try {
    const user = await pool.query(
      "SELECT id, name, role FROM users WHERE id=$1",
      [id]
    );

    const products = await pool.query(
      "SELECT * FROM products WHERE seller_id=$1 ORDER BY id DESC LIMIT 5",
      [id]
    );

    const count = await pool.query(
      "SELECT COUNT(*) FROM products WHERE seller_id=$1",
      [id]
    );

    res.json({
      user: user.rows[0],
      latestProducts: products.rows,
      productsCount: count.rows[0].count
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  const { productId, qty } = req.body;

  const exists = await pool.query(
    "SELECT * FROM cart WHERE user_id=$1 AND product_id=$2",
    [req.user.id, productId]
  );

  if (exists.rows.length > 0) {
    await pool.query(
      "UPDATE cart SET quantity = quantity + 1 WHERE user_id=$1 AND product_id=$2",
      [req.user.id, productId]
    );
  } else {
    await pool.query(
      "INSERT INTO cart(user_id,product_id,quantity) VALUES($1,$2,$3)",
      [req.user.id, productId, qty || 1]
    );
  }

  res.json({ success: true });
});

app.get("/cart", auth, async (req, res) => {
  const data = await pool.query(
    `SELECT c.id, c.quantity as qty, p.name, p.price, p.image
     FROM cart c
     JOIN products p ON p.id = c.product_id
     WHERE c.user_id=$1`,
    [req.user.id]
  );

  res.json(data.rows);
});

app.delete("/cart/:id", auth, async (req, res) => {
  await pool.query(
    "DELETE FROM cart WHERE id=$1 AND user_id=$2",
    [req.params.id, req.user.id]
  );

  res.json({ success: true });
});

app.put("/cart/:id", auth, async (req, res) => {
  const { qty } = req.body;

  await pool.query(
    "UPDATE cart SET quantity=$1 WHERE id=$2 AND user_id=$3",
    [qty, req.params.id, req.user.id]
  );

  res.json({ success: true });
});

// ================= LIKE SYSTEM =================

app.post("/like/:productId", auth, async (req, res) => {
  const productId = req.params.productId;

  const exists = await pool.query(
    "SELECT * FROM likes WHERE user_id=$1 AND product_id=$2",
    [req.user.id, productId]
  );

  if (exists.rows.length > 0) {
    await pool.query(
      "DELETE FROM likes WHERE user_id=$1 AND product_id=$2",
      [req.user.id, productId]
    );
  } else {
    await pool.query(
      "INSERT INTO likes(user_id, product_id) VALUES($1,$2)",
      [req.user.id, productId]
    );
  }

  const count = await pool.query(
    "SELECT COUNT(*) FROM likes WHERE product_id=$1",
    [productId]
  );

  res.json({
    liked: exists.rows.length == 0,
    likes_count: parseInt(count.rows[0].count)
  });
});
// ================= CHECKOUT =================
app.post("/checkout", auth, async (req, res) => {
  try {

    const cart = await pool.query(
      `SELECT 
        c.*,
        p.price,
        p.seller_id
       FROM cart c
       JOIN products p ON p.id = c.product_id
       WHERE c.user_id=$1`,
      [req.user.id]
    );

    if (cart.rows.length === 0) {
      return res.status(400).json({
        error: "Cart is empty"
      });
    }

    let total = 0;

    cart.rows.forEach(item => {
      total += item.price * item.quantity;
    });

    // CREATE ORDER
    const orderResult = await pool.query(
      `INSERT INTO orders(user_id,total_price,status)
       VALUES($1,$2,'pending')
       RETURNING *`,
      [req.user.id, total]
    );

    const order = orderResult.rows[0];

    // SAVE ITEMS
    for (const item of cart.rows) {

      await pool.query(
        `INSERT INTO order_items(
          order_id,
          product_id,
          quantity,
          price
        )
        VALUES($1,$2,$3,$4)`,
        [
          order.id,
          item.product_id,
          item.quantity,
          item.price,
        ]
      );
    }

    // CLEAR CART
    await pool.query(
      "DELETE FROM cart WHERE user_id=$1",
      [req.user.id]
    );

    res.json({
      success: true,
      order
    });

  } catch (e) {
    console.log(e);
    res.status(500).json({
      error: e.message
    });
  }
});

// ================= SELLER ORDERS =================
app.get("/seller-orders", auth, async (req, res) => {
  try {

    const result = await pool.query(
      `
      SELECT
        o.id as order_id,
        o.status,
        o.created_at,

        u.name as buyer_name,
        u.image as buyer_image,

        p.name as product_name,
        p.image as product_image,

        oi.quantity,
        oi.price

      FROM order_items oi

      JOIN orders o
      ON o.id = oi.order_id

      JOIN products p
      ON p.id = oi.product_id

      JOIN users u
      ON u.id = o.user_id

      WHERE p.seller_id=$1

      ORDER BY o.created_at DESC
      `,
      [req.user.id]
    );

    res.json(result.rows);

  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});

// ================= CONVERSATIONS =================
app.get("/conversations", auth, async (req, res) => {
  try {

    const result = await pool.query(
      `
      SELECT DISTINCT ON (
        CASE
          WHEN m.sender_id = $1 THEN m.receiver_id
          ELSE m.sender_id
        END
      )

      m.id,
      m.message,
      m.created_at,

      u.id as user_id,
      u.name,
      u.image

      FROM messages m

      JOIN users u
      ON u.id = CASE
        WHEN m.sender_id = $1 THEN m.receiver_id
        ELSE m.sender_id
      END

      WHERE m.sender_id = $1
      OR m.receiver_id = $1

      ORDER BY
      CASE
        WHEN m.sender_id = $1 THEN m.receiver_id
        ELSE m.sender_id
      END,
      m.created_at DESC
      `
      ,
      [req.user.id]
    );

    res.json(result.rows);

  } catch (e) {
    console.log(e);
    res.status(500).json({
      error: "Failed"
    });
  }
});


// ================= MESSAGE =================
app.get("/messages/:userId", auth, async (req, res) => {
  try {
    const otherUser = parseInt(req.params.userId);
    const limit = 50;

    const result = await pool.query(
  `SELECT 
    m.*,
    u.name,
    u.image as user_image
   FROM messages m
   JOIN users u ON u.id = m.sender_id
   WHERE (m.sender_id=$1 AND m.receiver_id=$2)
      OR (m.sender_id=$2 AND m.receiver_id=$1)
   ORDER BY m.created_at ASC
   LIMIT $3`,
  [req.user.id, otherUser, limit]
);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
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


server.listen(PORT, () => {
  console.log("Server running on " + PORT);
});