const pool = require("../config/db");

exports.checkout = async (req, res) => {
  const cart = await pool.query(
    `SELECT c.*, p.price FROM cart c
     JOIN products p ON p.id=c.product_id
     WHERE c.user_id=$1`,
    [req.user.id]
  );

  let total = 0;

  cart.rows.forEach(i => {
    total += i.price * i.quantity;
  });

  const order = await pool.query(
    "INSERT INTO orders(user_id,total_price) VALUES($1,$2) RETURNING *",
    [req.user.id, total]
  );

  await pool.query("DELETE FROM cart WHERE user_id=$1", [req.user.id]);

  res.json(order.rows[0]);
};