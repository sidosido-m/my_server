const jwt = require("jsonwebtoken");

module.exports = (req, res, next) => {
  const authHeader = req.headers.authorization;

  // ❌ إذا ما كاش header
  if (!authHeader) {
    return res.status(401).json({ error: "No authorization header" });
  }

  // ❌ إذا الفورما غلط
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Invalid token format" });
  }

  const token = authHeader.split(" ")[1];

  // ❌ إذا التوكن فارغ
  if (!token) {
    return res.status(401).json({ error: "No token provided" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // ✔️ نحط user في request
    req.user = decoded;

    next();
  } catch (err) {
    console.error("JWT ERROR ❌", err.message);

    return res.status(401).json({
      error: "Invalid or expired token",
    });
  }
};