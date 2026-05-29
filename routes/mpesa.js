// ─── M-Pesa Daraja Routes ───────────────────────────────────────────────────

const express = require("express");
const axios = require("axios");
const router = express.Router();
const engine = require("../game/engine");

// ── Helpers ──────────────────────────────────────────────────────────────────

const getTimestamp = () => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    now.getFullYear() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
};

const getPassword = (timestamp) => {
  const raw = `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`;
  return Buffer.from(raw).toString("base64");
};

const getAccessToken = async () => {
  const credentials = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString("base64");

  const res = await axios.get(
    "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
    {
      headers: { Authorization: `Basic ${credentials}` },
    }
  );

  return res.data.access_token;
};

// Format phone: 07XXXXXXXX → 2547XXXXXXXX
const formatPhone = (phone) => {
  const cleaned = String(phone).replace(/\D/g, "");
  if (cleaned.startsWith("254")) return cleaned;
  if (cleaned.startsWith("0")) return "254" + cleaned.slice(1);
  if (cleaned.startsWith("7") || cleaned.startsWith("1")) return "254" + cleaned;
  return cleaned;
};

// ── POST /api/mpesa/deposit ───────────────────────────────────────────────────
// Trigger STK push for player deposit

router.post("/deposit", async (req, res) => {
  try {
    const { phone, amount } = req.body;

    if (!phone || !amount) {
      return res.status(400).json({ error: "Phone and amount are required" });
    }

    const parsedAmount = parseInt(amount);
    if (isNaN(parsedAmount) || parsedAmount < engine.MIN_DEPOSIT) {
      return res.status(400).json({
        error: `Minimum deposit is KES ${engine.MIN_DEPOSIT}`,
      });
    }

    const formattedPhone = formatPhone(phone);
    const timestamp = getTimestamp();
    const password = getPassword(timestamp);
    const token = await getAccessToken();

    const stkResponse = await axios.post(
      "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      {
        BusinessShortCode: process.env.MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: parsedAmount,
        PartyA: formattedPhone,
        PartyB: process.env.MPESA_SHORTCODE,
        PhoneNumber: formattedPhone,
        CallBackURL: process.env.MPESA_CALLBACK_URL,
        AccountReference: "AviatorDeposit",
        TransactionDesc: "Aviator Game Deposit",
      },
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    const { CheckoutRequestID, ResponseCode, CustomerMessage } = stkResponse.data;

    if (ResponseCode !== "0") {
      return res.status(400).json({ error: "STK push failed", details: CustomerMessage });
    }

    // Register pending deposit
    engine.registerPendingDeposit(CheckoutRequestID, formattedPhone, parsedAmount);

    return res.json({
      success: true,
      message: "STK push sent. Check your phone to complete payment.",
      checkoutRequestID: CheckoutRequestID,
    });
  } catch (err) {
    console.error("STK Push Error:", err?.response?.data || err.message);
    return res.status(500).json({ error: "Failed to initiate payment", details: err.message });
  }
});

// ── POST /api/mpesa/callback ──────────────────────────────────────────────────
// Safaricom posts payment result here

router.post("/callback", (req, res) => {
  try {
    const callback = req.body?.Body?.stkCallback;

    if (!callback) {
      return res.status(400).json({ error: "Invalid callback format" });
    }

    const { ResultCode, CheckoutRequestID } = callback;

    if (ResultCode === 0) {
      // Payment successful
      const deposit = engine.confirmDeposit(CheckoutRequestID);
      if (deposit) {
        console.log(`✅ Deposit confirmed: ${deposit.phone} → KES ${deposit.amount}`);
      }
    } else {
      // Payment failed or cancelled
      const deposit = engine.failDeposit(CheckoutRequestID);
      if (deposit) {
        console.log(`❌ Deposit failed: ${deposit.phone} → KES ${deposit.amount}`);
      }
    }

    // Always respond 200 to Safaricom
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (err) {
    console.error("Callback Error:", err.message);
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }
});

// ── GET /api/mpesa/balance/:phone ─────────────────────────────────────────────
// Check player balance

router.get("/balance/:phone", (req, res) => {
  const phone = formatPhone(req.params.phone);
  const balance = engine.getBalance(phone);
  return res.json({ phone, balance });
});

module.exports = router;