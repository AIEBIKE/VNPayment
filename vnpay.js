const qs = require("qs");
const crypto = require("crypto");
const https = require("https");
const http = require("http");
const { URL } = require("url");

function sortObject(obj) {
  let sorted = {};
  let str = [];
  let key;
  for (key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      str.push(encodeURIComponent(key));
    }
  }
  str.sort();
  for (key = 0; key < str.length; key++) {
    sorted[str[key]] = encodeURIComponent(obj[str[key]]).replace(/%20/g, "+");
  }
  return sorted;
}

function createPaymentUrl({ amount, orderInfo, ipAddr }) {
  const tmnCode = process.env.VNP_TMN_CODE;
  const secretKey = process.env.VNP_HASH_SECRET;
  const vnpUrl = process.env.VNP_URL;
  const returnUrl = process.env.VNP_RETURN_URL;

  const date = new Date();

  const createDate = formatDate(date);
  const orderId = date.getTime().toString();

  let vnp_Params = {
    vnp_Version: "2.1.0",
    vnp_Command: "pay",
    vnp_TmnCode: tmnCode,
    vnp_Locale: "vn",
    vnp_CurrCode: "VND",
    vnp_TxnRef: orderId,
    vnp_OrderInfo: orderInfo || "Thanh toan don hang",
    vnp_OrderType: "other",
    vnp_Amount: amount * 100,
    vnp_ReturnUrl: returnUrl,
    vnp_IpAddr: ipAddr,
    vnp_CreateDate: createDate,
  };

  vnp_Params = sortObject(vnp_Params);

  const signData = qs.stringify(vnp_Params, { encode: false });

  const hmac = crypto.createHmac("sha512", secretKey);
  const signed = hmac.update(Buffer.from(signData, "utf-8")).digest("hex");

  vnp_Params["vnp_SecureHash"] = signed;

  const paymentUrl = vnpUrl + "?" + qs.stringify(vnp_Params, { encode: false });

  return paymentUrl;
}

function formatDate(date) {
  const pad = (n) => (n < 10 ? "0" + n : n);

  return (
    date.getFullYear().toString() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

function verifyReturnUrl(vnp_Params) {
  const secureHash = vnp_Params["vnp_SecureHash"];

  delete vnp_Params["vnp_SecureHash"];
  delete vnp_Params["vnp_SecureHashType"];

  vnp_Params = sortObject(vnp_Params);

  const secretKey = process.env.VNP_HASH_SECRET;
  const signData = qs.stringify(vnp_Params, { encode: false });
  const hmac = crypto.createHmac("sha512", secretKey);
  const signed = hmac.update(Buffer.from(signData, "utf-8")).digest("hex");

  if (secureHash === signed) {
    if (vnp_Params["vnp_ResponseCode"] === "00") {
      return { isSuccess: true, message: "Giao dịch thành công", data: vnp_Params };
    } else {
      return { isSuccess: false, message: "Giao dịch thất bại (Lỗi code: " + vnp_Params["vnp_ResponseCode"] + ")", data: vnp_Params };
    }
  } else {
    return { isSuccess: false, message: "Sai chữ ký bảo mật", data: vnp_Params };
  }
}

/**
 * Gửi yêu cầu hoàn tiền lên VNPay
 * @param {Object} params
 * @param {string} params.txnRef       - Mã giao dịch gốc (vnp_TxnRef lúc thanh toán cọc)
 * @param {number} params.amount       - Số tiền hoàn (VND, chưa nhân 100)
 * @param {string} params.transactionDate - Ngày giao dịch gốc (yyyyMMddHHmmss)
 * @param {string} params.transactionNo   - Số giao dịch VNPay (vnp_TransactionNo từ IPN/return)
 * @param {string} params.orderInfo    - Mô tả lý do hoàn tiền
 * @param {string} params.ipAddr       - IP người gửi yêu cầu
 * @param {string} params.createBy     - Tên người thực hiện hoàn tiền
 * @returns {Promise<Object>} - Response từ VNPay
 */
async function createRefundRequest({
  txnRef,
  amount,
  transactionDate,
  transactionNo,
  transactionType = "02", // "02" = hoàn toàn phần, "03" = hoàn một phần
  orderInfo,
  ipAddr,
  createBy,
}) {
  const tmnCode = process.env.VNP_TMN_CODE;
  const secretKey = process.env.VNP_HASH_SECRET;
  const apiUrl = "https://sandbox.vnpayment.vn/merchant_webapi/api/transaction";

  const requestId = Date.now().toString();
  const createDate = formatDate(new Date());

  const rawData = [
    requestId,
    "2.1.0",
    "refund",
    tmnCode,
    transactionType, // "02" hoàn toàn phần / "03" hoàn một phần
    txnRef,
    (amount * 100).toString(),
    transactionNo,
    transactionDate,
    createBy,
    createDate,
    ipAddr,
    orderInfo,
  ].join("|");

  const hmac = crypto.createHmac("sha512", secretKey);
  const secureHash = hmac.update(Buffer.from(rawData, "utf-8")).digest("hex");

  const body = JSON.stringify({
    vnp_RequestId: requestId,
    vnp_Version: "2.1.0",
    vnp_Command: "refund",
    vnp_TmnCode: tmnCode,
    vnp_TransactionType: transactionType,
    vnp_TxnRef: txnRef,
    vnp_Amount: amount * 100,
    vnp_OrderInfo: orderInfo,
    vnp_TransactionNo: transactionNo,
    vnp_TransactionDate: transactionDate,
    vnp_CreateBy: createBy,
    vnp_CreateDate: createDate,
    vnp_IpAddr: ipAddr,
    vnp_SecureHash: secureHash,
  });

  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(apiUrl);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ raw: data });
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

module.exports = { createPaymentUrl, verifyReturnUrl, createRefundRequest };
