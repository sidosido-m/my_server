const pool = require("../config/db");

exports.addToCart = async (req, res) => {
  const { product_id, quantity } = req.body;

  await pool.query(
    "INSERT INTO cart(user_id,product_id,quantity) VALUES($1,$2,$3)",
    [req.user.id, product_id, quantity]
  );

  res.json({ success: true });
};

exports.getCart = async (req, res) => {
  const data = await pool.query(
    `SELECT c.*, p.name, p.price 
     FROM cart c
     JOIN products p ON p.id=c.product_id
     WHERE c.user_id=$1`,
    [req.user.id]
  );

  res.json(data.rows);
};