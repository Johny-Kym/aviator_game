// ─── Aviator Backend Server ─────────────────────────────────────────────────

require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");

const engine = require("./game/engine");
const mpesaRoutes = require("./routes/mpesa");
const adminRoutes = require("./routes/admin");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin:
      process.env.CLIENT_URL ||
      "https://aviator-frontend-igpt0a05y-johnykyms-projects.vercel.app/",
    methods: ["GET", "POST"],
  },
});

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(
  cors({
    origin:
      process.env.CLIENT_URL ||
      "https://aviator-frontend-igpt0a05y-johnykyms-projects.vercel.app/",
  }),
);
app.use(express.json());
app.use(express.static(path.join(__dirname, "admin")));

// ── REST Routes ───────────────────────────────────────────────────────────────

app.use("/api/mpesa", mpesaRoutes);
app.use("/api/admin", adminRoutes);

// Admin dashboard
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "admin", "dashboard.html"));
});

// Health check
app.get("/", (req, res) => {
  res.json({ status: "Aviator backend running 🚀", state: engine.state });
});

// ── Game Engine → Socket.io Bridge ───────────────────────────────────────────
// Forward all engine events to connected clients

engine.on("round:waiting", (data) => {
  console.log(`⏳ Round ${data.roundId} waiting...`);
  io.emit("round:waiting", data);
});

engine.on("round:countdown", (data) => {
  io.emit("round:countdown", data);
});

engine.on("round:start", (data) => {
  console.log(
    `✈️  Round ${data.roundId} started — crash at ${engine.round.crashPoint}x`,
  );
  io.emit("round:start", data);
});

engine.on("round:crash", (data) => {
  console.log(`💥 Round ${data.roundId} crashed at ${data.crashPoint}x`);
  io.emit("round:crash", data);
  // Push updated stats to admin
  io.to("admin-room").emit("stats:update", engine.getStats());
});

engine.on("bet:placed", (data) => {
  io.to("admin-room").emit("stats:update", engine.getStats());
});

engine.on("bet:cashedout", (data) => {
  io.to("admin-room").emit("stats:update", engine.getStats());
});

engine.on("deposit:confirmed", ({ phone, amount, balance }) => {
  // Notify the specific player their deposit went through
  const socketId = playerSockets[phone];
  if (socketId) {
    io.to(socketId).emit("deposit:confirmed", { amount, balance });
  }
  io.to("admin-room").emit("stats:update", engine.getStats());
  console.log(
    `💰 Deposit confirmed: ${phone} KES ${amount} | Balance: ${balance}`,
  );
});

engine.on("deposit:failed", ({ phone }) => {
  const socketId = playerSockets[phone];
  if (socketId) {
    io.to(socketId).emit("deposit:failed", {
      message: "Payment failed or cancelled",
    });
  }
});
// Add this after engine.on("round:start")
engine.on("round:start", (data) => {
  console.log(`✈️  Round ${data.roundId} started`);
  io.emit("round:start", data);

  // 👇 broadcast live multiplier to everyone including admin
  const multInterval = setInterval(() => {
    if (engine.state !== "flying") {
      clearInterval(multInterval);
      return;
    }
    const m = engine.getMultiplier();
    io.emit("multiplier:update", { multiplier: m });
  }, 100);
});

// ── Socket.io — Player Connections ───────────────────────────────────────────

// Track phone → socketId mapping
const playerSockets = {};

io.on("connection", (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  // Send current game state to newly connected client
  socket.emit("game:state", {
    state: engine.state,
    roundId: engine.round.id,
    startTime: engine.round.startTime,
    history: engine.history.slice(0, 12),
  });

  // ── Player registers with their phone ──
  socket.on("player:register", ({ phone }) => {
    if (!phone) return;
    const formatted = phone.startsWith("254")
      ? phone
      : "254" + phone.replace(/^0/, "");
    playerSockets[formatted] = socket.id;
    socket.data.phone = formatted;
    socket.emit("player:registered", {
      phone: formatted,
      balance: engine.getBalance(formatted),
    });
    console.log(`👤 Player registered: ${formatted}`);
  });

  // ── Place a bet ──
  socket.on("bet:place", ({ amount }) => {
    const phone = socket.data.phone;
    if (!phone) {
      return socket.emit("bet:error", {
        error: "Please register your phone first",
      });
    }

    const result = engine.placeBet(phone, parseFloat(amount));
    if (result.success) {
      socket.emit("bet:success", { amount, balance: result.balance });
      // Broadcast to all: someone placed a bet (masked)
      io.emit("bet:new", { amount });
    } else {
      socket.emit("bet:error", { error: result.error });
    }
  });

  // ── Cash out ──
  socket.on("bet:cashout", () => {
    const phone = socket.data.phone;
    if (!phone) {
      return socket.emit("cashout:error", { error: "Not registered" });
    }

    const result = engine.cashOut(phone);
    if (result.success) {
      socket.emit("cashout:success", {
        multiplier: result.multiplier,
        winAmount: result.winAmount,
        balance: result.balance,
      });
    } else {
      socket.emit("cashout:error", { error: result.error });
    }
  });

  // ── Admin joins admin room ──
  socket.on("admin:join", ({ adminKey }) => {
    if (adminKey !== process.env.ADMIN_KEY) {
      return socket.emit("admin:error", { error: "Invalid admin key" });
    }
    socket.join("admin-room");
    socket.emit("admin:joined", engine.getStats());
    console.log(`🔑 Admin joined: ${socket.id}`);
  });

  // ── Admin sets crash point via socket ──
  socket.on("admin:set-crash", ({ adminKey, value }) => {
    if (adminKey !== process.env.ADMIN_KEY) {
      return socket.emit("admin:error", { error: "Unauthorized" });
    }
    const success = engine.setNextCrashPoint(value);
    socket.emit("admin:crash-set", {
      success,
      nextCrashPoint: engine.nextCrashPoint,
    });
    io.to("admin-room").emit("stats:update", engine.getStats());
  });

  // ── Admin force crash via socket ──
  socket.on("admin:force-crash", ({ adminKey }) => {
    if (adminKey !== process.env.ADMIN_KEY) return;
    engine.forceCrash();
  });

  // ── Admin reset round via socket ──
  socket.on("admin:reset", ({ adminKey }) => {
    if (adminKey !== process.env.ADMIN_KEY) return;
    engine.resetRound();
  });

  // ── Disconnect ──
  socket.on("disconnect", () => {
    const phone = socket.data.phone;
    if (phone && playerSockets[phone] === socket.id) {
      delete playerSockets[phone];
    }
    console.log(`❌ Client disconnected: ${socket.id}`);
  });
});

// ── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`\n🚀 Aviator backend running on http://localhost:${PORT}`);
  console.log(`📊 Admin dashboard: http://localhost:${PORT}/admin`);
  console.log(`\nStarting game engine...\n`);
  engine.startWaiting();
});
