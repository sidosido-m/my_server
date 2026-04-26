const pool = require("../config/db");
const bcrypt = require("bcrypt");
const { generateToken } = require("../services/token.service");

// REGISTER
exports.register = async (req, res) => {
  const { name, email, password, role } = req.body;

  const exist = await pool.query(
    "SELECT * FROM users WHERE email=$1",
    [email]
  );

  if (exist.rows.length > 0)
    return res.status(400).json({ error: "Email exists" });

  const hash = await bcrypt.hash(password, 10);

  const otp = Math.floor(100000 + Math.random() * 900000);

  await pool.query(
    `INSERT INTO users(name,email,password,role,otp,is_verified)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [name, email, hash, role, otp, false]
  );

  res.json({ success: true, otp });
};

// VERIFY OTP
exports.verifyOtp = async (req, res) => {
  const { email, otp } = req.body;

  const user = await pool.query(
    "SELECT * FROM users WHERE email=$1",
    [email]
  );

  if (!user.rows.length)
    return res.status(404).json({ error: "User not found" });

  if (user.rows[0].otp != otp)
    return res.status(400).json({ error: "Wrong OTP" });

  await pool.query(
    "UPDATE users SET is_verified=true, otp=NULL WHERE email=$1",
    [email]
  );

  res.json({ success: true });
};

// LOGIN
exports.login = async (req, res) => {
  const { email, password } = req.body;

  const user = await pool.query(
    "SELECT * FROM users WHERE email=$1",
    [email]
  );

  if (!user.rows.length)
    return res.status(400).json({ error: "User not found" });

  const dbUser = user.rows[0];

  const valid = await bcrypt.compare(password, dbUser.password);

  if (!valid)
    return res.status(400).json({ error: "Wrong password" });

  const token = generateToken(dbUser);

  res.json({ token, user: dbUser });
};