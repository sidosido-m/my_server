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

app.use(cors({
  origin: "*",
  methods: ["GET","POST","PUT","DELETE","PATCH"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
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

  console.log("USER CONNECTED:", socket.id);

  // 🔥 تسجيل المستخدم أونلاين
  socket.on("join", (userId) => {
    onlineUsers.set(userId, socket.id);
    console.log("JOIN:", userId, socket.id);
  });

  // ================= MESSAGE =================
  socket.on("send-message", async (data) => {
    try {
      const { senderId, receiverId, message, type } = data;

      const result = await pool.query(
        `
        INSERT INTO messages(
          sender_id,
          receiver_id,
          message,
          type,
          status
        )
        VALUES($1,$2,$3,$4,$5)
        RETURNING *
        `,
        [
          senderId,
          receiverId,
          message,
          type || "text",
          "sent"
        ]
      );

      const saved = result.rows[0];

      const receiverSocket = onlineUsers.get(receiverId);
      const senderSocket = onlineUsers.get(senderId);

      // 🔥 إرسال للمرسل (sync)
      if (senderSocket) {
        io.to(senderSocket).emit("new-message", saved);
      }

      // 🔥 إرسال للمستقبل فقط إذا أونلاين
      if (receiverSocket) {
        io.to(receiverSocket).emit("new-message", saved);
      }

    } catch (err) {
      console.log("SEND MESSAGE ERROR:", err);
    }
  });

  // ================= DISCONNECT =================
  socket.on("disconnect", () => {
    for (let [userId, socketId] of onlineUsers.entries()) {
      if (socketId === socket.id) {
        onlineUsers.delete(userId);

        io.emit("user-status", {
          userId,
          status: "offline"
        });

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

  const allowedExt = /jpeg|jpg|png|webp|heic|heif/;
  const extOk = allowedExt.test(file.originalname.toLowerCase());
  const mimeOk = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
].includes(file.mimetype);

  if (extOk || mimeOk) {
    cb(null, true);
  } else {
    cb(new Error("Only images allowed"));
  }
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
app.post("/upload", auth, upload.single("image"), async (req, res) => {
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
    const { name, email, password, role,phone,countryCode,gender } = req.body;
     let username = email.split("@")[0].toLowerCase();
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
    const userExists = await pool.query(
  "SELECT * FROM users WHERE username=$1",
  [username]
);

if (userExists.rows.length > 0) {
  username = username + Math.floor(Math.random() * 9999);
}

    const hash = await bcrypt.hash(password, 10);

    const otp = Math.floor(100000 + Math.random() * 900000);
    const otpExpire = new Date(Date.now() + 60 * 1000);

    await pool.query(
      `INSERT INTO users (name, username, email, password, role,phone,country_code ,gender,otp, otp_expire, is_verified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [name, username, email, hash, role,phone,countryCode  ,gender, otp, otpExpire, false]
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
      return res.status(403).json({
  success: false,
  needOtp: true,
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

  if (!oldPassword) {
    return res.status(400).json({
      error: "Old password required",
    });
  }

  const valid = await bcrypt.compare(
    oldPassword,
    currentUser.password
  );

  if (!valid) {
    return res.status(400).json({
      error: "Wrong old password",
    });
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
     phone=$5,
    image = COALESCE($6, image),
    background_image = COALESCE($7, background_image)
   WHERE id=$8`,

  [
    name,
    email,
    username,
    hashedPassword,
     phone,
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
    console.log("PROFILE USER:", req.user);
    const result = await pool.query(
      `SELECT id, name, username, email, image,phone, background_image, role
       FROM users WHERE id=$1`,
      [req.user.id]
    );

    const user = result.rows[0];

    const followers = await pool.query(
     "SELECT COUNT(*) FROM followers WHERE following_id=$1",
      [req.user.id]
    );

    const following = await pool.query(
       "SELECT COUNT(*) FROM followers WHERE follower_id=$1",
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

    const data = await pool.query(`
      SELECT 
        p.*,
        u.name AS seller_name,
        u.image AS seller_image,

        (
          SELECT COUNT(*)
          FROM likes l
          WHERE l.product_id = p.id
        ) AS likes_count

      FROM products p

      JOIN users u
      ON u.id = p.seller_id

      ORDER BY p.id DESC
    `);

    res.json(data.rows);

  } catch (err) {
    console.error("GET PRODUCTS ERROR ❌", err);

    res.status(500).json({
      error: "Server error"
    });
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
    const { name, price, image, description } = req.body;

    const result = await pool.query(
      `INSERT INTO products(name, price, seller_id, image, description)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [name, price, req.user.id, image, description]
    );

    res.json({
      success: true,
      product: result.rows[0],
    });

  } catch (err) {
    console.error("ADD PRODUCT ERROR ❌", err);
    res.status(500).json({ error: "Server error" });
  }
});


// 🔥 UPDATE PRODUCT (مهم: فقط صاحب المنتج)
app.put("/products/:id", auth, async (req, res) => {
  try {
    const { name, price, image ,description } = req.body;

const result = await pool.query(
  `UPDATE products 
   SET name=$1, price=$2, image=COALESCE($3, image),  description=$4
   WHERE id=$5 AND seller_id=$6 
   RETURNING *`,
  [name, price, image,  description, req.params.id, req.user.id]
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

app.get("/seller/:id/products", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM products WHERE seller_id=$1 ORDER BY id DESC",
      [req.params.id]
    );

    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
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
       "SELECT COUNT(*) FROM followers WHERE following_id=$1",
      [id]
    );

    const following = await pool.query(
      "SELECT COUNT(*) FROM followers WHERE follower_id=$1",
      [id]
    );

    const rating = await pool.query(
        "SELECT COALESCE(AVG(rating),0) as avg FROM reviews WHERE seller_id=$1",
      [id]
    );

    res.json({
      seller: user.rows[0],
      products: products.rows,
      followers: followers.rows[0].count,
      following: following.rows[0].count,
      rating: rating.rows[0].avg
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
//-----------FOLLOW----------------
app.post("/follow/:id", auth, async (req, res) => {
  const followerId = req.user.id;
  const followingId = req.params.id;

  const exists = await pool.query(
    "SELECT 1 FROM followers WHERE follower_id=$1 AND following_id=$2",
    [followerId, followingId]
  );

  if (exists.rows.length > 0) {
    await pool.query(
      "DELETE FROM followers WHERE follower_id=$1 AND following_id=$2",
      [followerId, followingId]
    );

    return res.json({ following: false });
  }

  await pool.query(
    "INSERT INTO followers (follower_id, following_id) VALUES ($1, $2)",
    [followerId, followingId]
  );

  res.json({ following: true });
});

app.get("/follow/check/:id", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM followers
       WHERE follower_id=$1 AND following_id=$2`,
      [req.user.id, req.params.id]
    );

    res.json({
      following: result.rows.length > 0
    });

  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});
//-----------Followers----------------
app.get("/following/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT users.*
      FROM followers
      JOIN users
      ON users.id = followers.following_id
      WHERE followers.follower_id = $1
      `,
      [req.params.id]
    );

    res.json(result.rows);

  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});
app.delete("/follow/:id", auth, async (req, res) => {
  try {

    await pool.query(
      `DELETE FROM followers
       WHERE follower_id=$1
       AND following_id=$2`,
      [req.user.id, req.params.id]
    );

    res.json({
      following: false
    });

  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});

app.get("/followers/:id", async (req, res) => {
  const result = await pool.query(
    `SELECT users.*
     FROM followers
     JOIN users ON users.id = followers.follower_id
     WHERE followers.following_id = $1`,
    [req.params.id]
  );

  res.json(result.rows);
});
 
app.get("/is-following/:id", auth, async (req, res) => {
  const followerId = req.user.id;
  const followingId = req.params.id;

  const result = await pool.query(
    "SELECT 1 FROM followers WHERE follower_id=$1 AND following_id=$2",
    [followerId, followingId]
  );

  res.json({
    isFollowing: result.rows.length > 0
  });
});
//-----------/seller-stats/:sellerId----------------
app.get("/seller-stats/:sellerId", async (req, res) => {
  try {
    const followers = await pool.query(
        "SELECT COUNT(*) FROM followers WHERE following_id=$1",
      [req.params.sellerId]
    );

    const following = await pool.query(
"SELECT COUNT(*) FROM followers WHERE follower_id=$1",
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
// ================= ADD RATING =================
app.post("/ratings", auth, async (req, res) => {
  try {
    const buyerId = req.user.id;

    const {
      product_id,
      seller_id,
      rating
    } = req.body;

    // تحقق
    if (!product_id || !seller_id || !rating) {
      return res.status(400).json({
        error: "missing fields"
      });
    }

    // منع التقييم مرتين
    const existing = await pool.query(
      `
      SELECT * FROM ratings
      WHERE buyer_id = $1
      AND product_id = $2
      `,
      [buyerId, product_id]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({
        error: "already rated"
      });
    }

    await pool.query(
      `
      INSERT INTO ratings
      (
        product_id,
        seller_id,
        buyer_id,
        rating
      )
      VALUES ($1,$2,$3,$4)
      `,
      [
        product_id,
        seller_id,
        buyerId,
        rating
      ]
    );

    res.json({
      success: true
    });

  } catch (e) {
    console.log(e);
    res.status(500).json({
      error: "server error"
    });
  }
});
// ================= SELLER RATING =================
app.get("/seller-rating/:id", async (req, res) => {
  try {

    const sellerId = req.params.id;

    const result = await pool.query(
      `
      SELECT
      ROUND(AVG(rating)::numeric,1) as rating,
      COUNT(*) as total
      FROM ratings
      WHERE seller_id = $1
      `,
      [sellerId]
    );

    res.json({
      rating: result.rows[0].rating ?? 0,
      total: result.rows[0].total ?? 0
    });

  } catch (e) {
    console.log(e);

    res.status(500).json({
      error: "server error"
    });
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
  "SELECT id, name, role, image FROM users WHERE id=$1",
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
  const { productId, quantity } = req.body;

  const exists = await pool.query(
    "SELECT * FROM cart WHERE user_id=$1 AND product_id=$2",
    [req.user.id, productId]
  );

  if (exists.rows.length > 0) {
    await pool.query(
      "UPDATE cart SET quantity = quantity + $1 WHERE user_id=$1 AND product_id=$2",
      [req.user.id, productId]
    );
  } else {
    await pool.query(
      "INSERT INTO cart(user_id,product_id,quantity) VALUES($1,$2,$3)",
      [req.user.id, productId, quantity || 1]
    );
  }

  res.json({ success: true });
});

app.get("/cart", auth, async (req, res) => {
  const data = await pool.query(
    `
    SELECT 
      c.id,
      c.product_id,
      c.quantity as quantity,
      p.name,
      p.price,
      p.image

    FROM cart c

    JOIN products p
    ON p.id = c.product_id

    WHERE c.user_id=$1
    `,
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
  const { quantity } = req.body;

  await pool.query(
    "UPDATE cart SET quantity=$1 WHERE id=$2 AND user_id=$3",
    [quantity, req.params.id, req.user.id]
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

    const { items } = req.body;

if (!items || items.length === 0) {
  return res.status(400).json({
    error: "No items selected"
  });
}

let cart = {
  rows: []
};

for (const item of items) {

         const productId = item.productId || item.product_id || item.id;
const quantity = item.quantity || 1;

if (!productId) continue;
  const product = await pool.query(
    `
    SELECT
      id,
      price,
      seller_id
    FROM products
    WHERE id=$1
    `,
    [productId]

  );

  if (product.rows.length > 0) {

    cart.rows.push({
  product_id: productId,
  quantity: quantity,
  price: product.rows[0].price,
  seller_id: product.rows[0].seller_id,
});
  }
}

    if (cart.rows.length === 0) {
      return res.status(400).json({
        error: "Cart is empty"
      });
    }

    let total = 0;

    cart.rows.forEach(item => {
     total += item.price * (item.quantity || 1);
    });

    // CREATE ORDER
    const {
  fullName,
  phone,
  country,
  city,
  zipCode,
  latitude,
  longitude
} = req.body;

const orderResult = await pool.query(
`
INSERT INTO orders(
  user_id,
  total_price,
  status,
  full_name,
  phone,
  country,
  city,
  zip_code,
  latitude,
  longitude
)
VALUES(
  $1,$2,'pending',
  $3,$4,$5,$6,$7,$8,$9
)
RETURNING *
`,
[
  req.user.id,
  total,
  fullName,
  phone,
  country,
  city,
  zipCode,
  latitude,
  longitude
]
);
    const order = orderResult.rows[0];

    // SAVE ITEMS
  for (const item of cart.rows) {

  const productId = item.product_id || item.productId;
  const quantity = item.quantity || item.quantity || 1;
  const price = item.price || 0;

  if (!productId) continue;

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
      productId,
      quantity,
      price
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
//============== NOTIFICATION ==================
app.post("/notifications", auth, async (req, res) => {
  try {
    const { user_id, title, body, type } = req.body;

    const result = await pool.query(
      `INSERT INTO notifications(user_id, sender_id, title, body, type, is_read)
       VALUES($1,$2,$3,$4,$5,false)
       RETURNING *`,
      [
        user_id,
        req.user.id,
        title,
        body,
        type
      ]
    );

    res.json(result.rows[0]);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
//===========id n=====================
app.patch("/notifications/:id", auth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE notifications
       SET is_read=true
       WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.user.id]
    );

    res.json({ success: true });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
//============GET NOTIFICATION ===============
app.get("/notifications", auth, async (req, res) => {
  try {

    const result = await pool.query(
      `
      SELECT
        n.*,
        u.name as sender_name,
        u.image as sender_image

      FROM notifications n

      LEFT JOIN users u
      ON u.id = n.sender_id

      WHERE n.user_id=$1

      ORDER BY n.created_at DESC
      `,
      [req.user.id]
    );

    res.json(result.rows);

  } catch (err) {
    console.log(err);
    res.status(500).json({ error: err.message });
  }
});
// ================= SELLER ORDERS =================
app.put("/orders/:id/status", auth, async (req, res) => {
  try {
    const { status } = req.body;
    const orderId = req.params.id;

    // 1. نجيب صاحب الطلب (المشتري)
    const check = await pool.query(
      `
      SELECT o.user_id
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      JOIN orders o ON o.id = oi.order_id
      WHERE oi.order_id=$1 AND p.seller_id=$2
      LIMIT 1
      `,
      [orderId, req.user.id]
    );

    if (check.rows.length === 0) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const buyerId = check.rows[0].user_id;

    // 2. تحديث الحالة
    await pool.query(
      "UPDATE orders SET status=$1 WHERE id=$2",
      [status, orderId]
    );

    // 3. تجهيز النصوص (multi language)
    let title = {};
    let body = {};

    if (status === "accepted") {
      title = {
        ar: "تم قبول طلبك",
        en: "Order Accepted",
        fr: "Commande acceptée"
      };

      body = {
        ar: "تم قبول طلبك من البائع",
        en: "Your order was accepted by seller",
        fr: "Votre commande a été acceptée par le vendeur"
      };
    }

    if (status === "shipped") {
      title = {
        ar: "تم شحن طلبك",
        en: "Order Shipped",
        fr: "Commande expédiée"
      };

      body = {
        ar: "طلبك في الطريق 🚚",
        en: "Your order is on the way 🚚",
        fr: "Votre commande est en route 🚚"
      };
    }
    if (status === "delivered") {
  title = {
    ar: "تم توصيل الطلب",
    en: "Order Delivered",
    fr: "Commande livrée"
  };

  body = {
    ar: "تم توصيل طلبك بنجاح 📦",
    en: "Your order has been delivered 📦",
    fr: "Votre commande a été livrée 📦"
  };
}
console.log("CREATING NOTIFICATION");
console.log("BUYER:", buyerId);
console.log("STATUS:", status);
    // 4. إنشاء الإشعار (هنا الصحيح) 
    await pool.query(
      `INSERT INTO notifications(
        user_id,
        sender_id,
        title,
        body,
        type,
        order_id
      ) VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        buyerId,
        req.user.id,
        title,
        body,
        status,
        orderId
      ]
    );
console.log("NOTIFICATION CREATED");
    return res.json({ success: true });

  } catch (e) {
    console.log(e);
    res.status(500).json({ error: e.message });
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
        o.full_name,
        o.phone,
        o.country,
        o.city,
        o.zip_code,
        o.latitude,
        o.longitude,
        o.created_at,

        oi.quantity,
        oi.price,

        p.id as product_id,
        p.name as product_name,
        p.image as product_image,

        u.id as buyer_id,
        u.name as buyer_name,
        u.image as buyer_image

      FROM orders o

      JOIN order_items oi
      ON oi.order_id = o.id

      JOIN products p
      ON p.id = oi.product_id

      JOIN users u
      ON u.id = o.user_id

      WHERE p.seller_id = $1

      ORDER BY o.id DESC
      `,
      [req.user.id]
    );

    res.json(result.rows);

  } catch (e) {

    console.log(e);

    res.status(500).json({
      error: e.message
    });
  }
});
//============GET=============
app.get("/my-orders", auth, async (req, res) => {
  try {

    const result = await pool.query(
      `
      SELECT
        o.id as order_id,
        o.status,

        p.name as product_name,
        p.image as product_image,

        oi.quantity,
        oi.price

      FROM orders o

      JOIN order_items oi
      ON oi.order_id = o.id

      JOIN products p
      ON p.id = oi.product_id

      WHERE o.user_id=$1

      ORDER BY o.id DESC
      `,
      [req.user.id]
    );

    res.json(result.rows);

  } catch (e) {

    console.log(e);

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

app.put("/messages/seen/:userId", auth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE messages
       SET status='seen'
       WHERE receiver_id=$1 AND sender_id=$2`,
      [req.user.id, req.params.userId]
    );

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ================= MESSAGE =================
app.get("/messages/:userId", auth, async (req, res) => {
  try {
    const otherUser = parseInt(req.params.userId);
    const limit = 50;

    const result = await pool.query(
`
SELECT 
  m.*,
  u.name,
  u.image as user_image,
  TO_CHAR(m.created_at, 'YYYY-MM-DD HH24:MI') as formatted_time

FROM messages m

JOIN users u
ON u.id = m.sender_id

WHERE
(m.sender_id=$1 AND m.receiver_id=$2)
OR
(m.sender_id=$2 AND m.receiver_id=$1)

ORDER BY m.created_at ASC
LIMIT $3
`,
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


console.log("END FILE REACHED");

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});