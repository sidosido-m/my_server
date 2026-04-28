// ================= CONFIG =================
const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "toopvedeo00@gmail.com",
    pass: "bsxb ofbu nodu qdkc"
  }
});

module.exports = transporter;
