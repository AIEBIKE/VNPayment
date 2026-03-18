require("dotenv").config();
const express = require("express");
const { createPaymentUrl, verifyReturnUrl } = require("./vnpay");

const app = express();
app.use(express.json());

app.post("/create-payment", (req, res) => {
  try {
    let ipAddr =
      req.headers["x-forwarded-for"] || req.socket.remoteAddress || "127.0.0.1";
      
    // VNPay có thể không nhận địa chỉ IPv6 loopback, nên cần chuyển về IPv4
    if (ipAddr === "::1" || ipAddr === "::ffff:127.0.0.1") {
      ipAddr = "127.0.0.1";
    }
    // Nếu có nhiều IP từ x-forwarded-for, chỉ lấy IP đầu tiên
    if (ipAddr.includes(",")) {
      ipAddr = ipAddr.split(",")[0].trim();
    }

    const { amount, orderInfo } = req.body;

    if (!amount) {
      return res.status(400).json({ error: "Missing amount" });
    }

    const paymentUrl = createPaymentUrl({
      amount,
      orderInfo,
      ipAddr,
    });

    res.json({ paymentUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/return", (req, res) => {
  try {
    let vnp_Params = req.query;

    console.log("Return data:", vnp_Params);

    const result = verifyReturnUrl(vnp_Params);
    
    // Tùy theo kết quả xác thực (thành công/thất bại) để xử lý logic
    // Đối với URL Return, bạn có thể redirect về một deeplink app hoặc render ra trang HTML
    if (result.isSuccess) {
      res.send(`
        <h1>Thanh toán thành công!</h1>
        <p>Mã đơn hàng: ${result.data['vnp_TxnRef']}</p>
        <p>Số tiền: ${result.data['vnp_Amount'] / 100} VNĐ</p>
        <p>Ghi chú: ${result.data['vnp_OrderInfo']}</p>
      `);
    } else {
      res.send(`
        <h1 style="color: red;">${result.message}</h1>
        <p>Mã đơn hàng: ${result.data['vnp_TxnRef'] || 'Không rõ'}</p>
      `);
    }

  } catch (error) {
    res.status(500).send("Lỗi xử lý kết quả thanh toán");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
