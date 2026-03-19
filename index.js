require("dotenv").config();
const express = require("express");
const { createPaymentUrl, verifyReturnUrl, createRefundRequest } = require("./vnpay");

const app = express();
app.use(express.json());

// Cho phép CORS để Admin Panel gọi được
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

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

    // Trả về một trang HTML đặc biệt:
    // - App React Native sẽ detect URL thay đổi trong WebView và lấy kết quả
    // - Người dùng thấy trang thành công/thất bại đẹp
    const orderId = result.data["vnp_OrderInfo"] || "";
    const isSuccess = result.isSuccess;
    const amount = isSuccess ? parseInt(result.data["vnp_Amount"]) / 100 : 0;

    // Nhúng kết quả vào URL để WebView có thể đọc
    const resultUrl = `vnpay-result://${isSuccess ? "success" : "failed"}?orderId=${encodeURIComponent(orderId)}&amount=${amount}&message=${encodeURIComponent(result.message)}`;

    if (isSuccess) {
      res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Thanh toán thành công</title>
  <style>
    body { font-family: Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f0fff4; }
    .icon { font-size: 80px; }
    h1 { color: #2e7d32; }
    p { color: #555; text-align: center; }
    .amount { font-size: 28px; font-weight: bold; color: #2e7d32; }
    .note { font-size: 12px; color: #999; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="icon">✅</div>
  <h1>Thanh toán thành công!</h1>
  <p class="amount">${amount.toLocaleString("vi-VN")}đ</p>
  <p>Đơn hàng của bạn đã được thanh toán thành công.<br>App sẽ tự động cập nhật trong giây lát...</p>
  <p class="note">Bạn có thể đóng cửa sổ này.</p>
  <script>
    // Redirect về custom scheme để React Native WebView bắt được
    setTimeout(() => { window.location.href = "${resultUrl}"; }, 800);
  </script>
</body>
</html>`);
    } else {
      res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Thanh toán thất bại</title>
  <style>
    body { font-family: Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #fff5f5; }
    .icon { font-size: 80px; }
    h1 { color: #c62828; }
    p { color: #555; text-align: center; }
    .note { font-size: 12px; color: #999; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="icon">❌</div>
  <h1>Thanh toán thất bại</h1>
  <p>${result.message}</p>
  <p>Vui lòng thử lại hoặc liên hệ hỗ trợ.</p>
  <p class="note">App sẽ tự động quay lại trong giây lát...</p>
  <script>
    setTimeout(() => { window.location.href = "${resultUrl}"; }, 800);
  </script>
</body>
</html>`);
    }

  } catch (error) {
    console.error("Return error:", error);
    res.status(500).send("Lỗi xử lý kết quả thanh toán");
  }
});

// -------------------------
// POST /refund
// Body: { txnRef, amount, transactionDate, transactionNo, orderInfo, createBy }
// Gọi VNPay Refund API để hoàn tiền cọc cho khách
// -------------------------
app.post("/refund", async (req, res) => {
  try {
    let ipAddr =
      req.headers["x-forwarded-for"] || req.socket.remoteAddress || "127.0.0.1";
    if (ipAddr === "::1" || ipAddr === "::ffff:127.0.0.1") ipAddr = "127.0.0.1";
    if (ipAddr.includes(",")) ipAddr = ipAddr.split(",")[0].trim();

    const { txnRef, amount, transactionDate, transactionNo, orderInfo, createBy, transactionType, depositTotal } = req.body;

    if (!txnRef || !amount || !transactionDate) {
      return res.status(400).json({ success: false, error: "Thiếu thông tin giao dịch (txnRef, amount, transactionDate)" });
    }

    if (amount <= 0) {
      return res.json({ success: true, message: "Số tiền hoàn bằng 0, bỏ qua", skipped: true });
    }

    // Tự động xác định type nếu không truyền vào:
    // "02" = hoàn toàn phần (tiền hoàn = tiền cọc gốc)
    // "03" = hoàn một phần  (tiền hoàn < tiền cọc gốc)
    let resolvedType = transactionType;
    if (!resolvedType) {
      const isFullRefund = !depositTotal || amount >= depositTotal;
      resolvedType = isFullRefund ? "02" : "03";
    }

    console.log(`[Refund] Hoàn tiền ${amount}đ (type=${resolvedType}) cho giao dịch ${txnRef}`);

    const vnpResult = await createRefundRequest({
      txnRef,
      amount,
      transactionDate: transactionDate || "",
      transactionNo: transactionNo || "",
      transactionType: resolvedType,
      orderInfo: orderInfo || `Hoan tien coc don hang ${txnRef}`,
      ipAddr,
      createBy: createBy || "dealer",
    });

    console.log("[Refund] VNPay response:", vnpResult);

    const isSuccess = vnpResult.vnp_ResponseCode === "00";

    res.json({
      success: isSuccess,
      vnpResponseCode: vnpResult.vnp_ResponseCode,
      vnpMessage: vnpResult.vnp_Message || "",
      vnpTransactionNo: vnpResult.vnp_TransactionNo || "",
      raw: vnpResult,
    });
  } catch (err) {
    console.error("[Refund] Error:", err);
    res.status(500).json({ success: false, error: "Lỗi server khi hoàn tiền" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
