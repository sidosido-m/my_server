const pool = require("../config/db");

// GET ALL PRODUCTS
exports.getProducts = async (req, res) => {
  const data = await pool.query("SELECT * FROM products");
  res.json(data.rows);
};

// ADD PRODUCT
exports.addProduct = async (req, res) => {
  const { name, price } = req.body;

  const image = req.file?.filename;

  const result = await pool.query(
    `INSERT INTO products(name,price,seller_id,image)
     VALUES($1,$2,$3,$4) RETURNING *`,
    [name, price, req.user.id, image]
  );

  res.json(result.rows[0]);
};

// DELETE PRODUCT
exports.deleteProduct = async (req, res) => {
  await pool.query(
    "DELETE FROM products WHERE id=$1 AND seller_id=$2",
    [req.params.id, req.user.id]
  );

  res.json({ success: true });
};