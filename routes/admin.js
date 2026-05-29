// ─── Admin Routes ───────────────────────────────────────────────────────────

const express = require("express");
const router = express.Router();
const engine = require("../game/engine");
const adminAuth = require("../middleware/auth");

// All admin routes are protected
router.use(adminAuth);

// ── GET /admin/stats ──────────────────────────────────────────────────────────
// Live game stats

router.get("/stats", (req, res) => {
  return res.json(engine.getStats());
});

// ── POST /admin/crash-point ───────────────────────────────────────────────────
// Set crash point for the NEXT round

router.post("/crash-point", (req, res) => {
  const { value } = req.body;

  if (!value) {
    return res.status(400).json({ error: "Crash point value is required" });
  }

  const success = engine.setNextCrashPoint(value);
  if (!success) {
    return res.status(400).json({ error: "Invalid crash point. Must be >= 1.00" });
  }

  return res.json({
    success: true,
    message: `Next round will crash at ${parseFloat(value).toFixed(2)}x`,
    nextCrashPoint: engine.nextCrashPoint,
  });
});

// ── DELETE /admin/crash-point ─────────────────────────────────────────────────
// Clear admin set crash point (go back to random)

router.delete("/crash-point", (req, res) => {
  engine.nextCrashPoint = null;
  return res.json({ success: true, message: "Crash point cleared — next round will be random" });
});

// ── POST /admin/round/force-crash ─────────────────────────────────────────────
// Force crash the current round immediately

router.post("/round/force-crash", (req, res) => {
  const success = engine.forcecrash();
  if (!success) {
    return res.status(400).json({ error: "Game is not in flight — cannot force crash" });
  }
  return res.json({ success: true, message: "Round force crashed" });
});

// ── POST /admin/round/reset ───────────────────────────────────────────────────
// Reset the current round and restart

router.post("/round/reset", (req, res) => {
  engine.resetRound();
  return res.json({ success: true, message: "Round reset — new round starting" });
});

// ── GET /admin/history ────────────────────────────────────────────────────────
// Round history

router.get("/history", (req, res) => {
  return res.json({ history: engine.history });
});

// ── GET /admin/balances ───────────────────────────────────────────────────────
// All player balances

router.get("/balances", (req, res) => {
  const balances = Object.entries(engine.balances).map(([phone, balance]) => ({
    phone: phone.slice(0, 6) + "****",
    balance,
  }));
  return res.json({ balances });
});

// ── POST /admin/balance/add ───────────────────────────────────────────────────
// Manually add balance to a player (for testing)

router.post("/balance/add", (req, res) => {
  const { phone, amount } = req.body;
  if (!phone || !amount) {
    return res.status(400).json({ error: "Phone and amount required" });
  }
  const formatted = phone.startsWith("254") ? phone : "254" + phone.replace(/^0/, "");
  engine.balances[formatted] = parseFloat(
    ((engine.balances[formatted] || 0) + parseFloat(amount)).toFixed(2)
  );
  return res.json({
    success: true,
    phone: formatted,
    balance: engine.balances[formatted],
  });
});

module.exports = router;