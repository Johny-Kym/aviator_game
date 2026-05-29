// ─── Aviator Game Engine ───────────────────────────────────────────────────
// Manages all game state in memory — no database needed

const EventEmitter = require("events");

class GameEngine extends EventEmitter {
  constructor() {
    super();

    // Game state: 'waiting' | 'flying' | 'crashed'
    this.state = "waiting";

    // Current round info
    this.round = {
      id: 1,
      crashPoint: null, // set by admin manually
      startTime: null,
      countdown: 5,
    };

    // In-memory player balances: { '2547XXXXXXXX': 1000 }
    this.balances = {};

    // Active bets for current round: { '2547XXXXXXXX': { amount, cashedOut, cashoutMultiplier } }
    this.activeBets = {};

    // Round history: last 20 rounds
    this.history = [];

    // Pending STK push requests: { CheckoutRequestID: { phone, amount } }
    this.pendingDeposits = {};

    // Admin set crash point for next round
    this.nextCrashPoint = null;

    // Timers
    this._countdownTimer = null;
    this._crashTimer = null;

    // Minimum deposit
    this.MIN_DEPOSIT = 10;
    this.MIN_BET = 10;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  getMultiplier() {
    if (!this.round.startTime || this.state !== "flying") return 1.0;
    const elapsed = (Date.now() - this.round.startTime) / 1000;
    return parseFloat(Math.pow(Math.E, elapsed * 0.06).toFixed(2));
  }

  generateCrashPoint() {
    const r = Math.random();
    if (r < 0.01) return parseFloat((1.0 + Math.random() * 0.05).toFixed(2));
    if (r < 0.35) return parseFloat((1.0 + Math.random() * 0.8).toFixed(2));
    if (r < 0.65) return parseFloat((1.0 + Math.random() * 2.0).toFixed(2));
    if (r < 0.85) return parseFloat((2.0 + Math.random() * 3.0).toFixed(2));
    if (r < 0.95) return parseFloat((5.0 + Math.random() * 10.0).toFixed(2));
    return parseFloat((10.0 + Math.random() * 40.0).toFixed(2));
  }

  getBalance(phone) {
    return this.balances[phone] || 0;
  }

  getStats() {
    const totalPot = Object.values(this.activeBets).reduce(
      (sum, b) => sum + b.amount,
      0,
    );
    const cashedOut = Object.values(this.activeBets).filter((b) => b.cashedOut);
    const totalPaidOut = cashedOut.reduce((sum, b) => sum + b.winAmount, 0);

    return {
      state: this.state,
      round: this.round.id,
      crashPoint: this.round.crashPoint,
      nextCrashPoint: this.nextCrashPoint,
      multiplier: this.getMultiplier(),
      activeBets: Object.entries(this.activeBets).map(([phone, b]) => ({
        phone: phone.slice(0, 6) + "****", // mask phone
        amount: b.amount,
        cashedOut: b.cashedOut,
        cashoutMultiplier: b.cashoutMultiplier || null,
        winAmount: b.winAmount || null,
      })),
      totalPot,
      totalPaidOut,
      totalPlayers: Object.keys(this.activeBets).length,
      history: this.history.slice(0, 20),
    };
  }

  // ── Round Management ──────────────────────────────────────────────────────

  startWaiting() {
    this.state = "waiting";
    this.activeBets = {};
    this.round.crashPoint = null;
    this.round.startTime = null;
    let countdown = 5;

    this.emit("round:waiting", { countdown, roundId: this.round.id });

    this._countdownTimer = setInterval(() => {
      countdown--;
      this.emit("round:countdown", { countdown });

      if (countdown <= 0) {
        clearInterval(this._countdownTimer);
        this.startFlight();
      }
    }, 1000);
  }
  startFlight() {
    const crashPoint = this.nextCrashPoint || this.generateCrashPoint();
    this.nextCrashPoint = null;
    this.round.crashPoint = crashPoint;
    this.round.startTime = Date.now();
    this.state = "flying";

    this.emit("round:start", {
      startTime: this.round.startTime,
      roundId: this.round.id,
      crashPoint: crashPoint,
    });

    // Backend controls crash timing
    const crashAfterMs = (Math.log(crashPoint) / 0.06) * 1000;
    this._crashTimer = setTimeout(() => {
      this.doCrash();
    }, crashAfterMs);
  }
  forceCrash() {
    if (this.state !== "flying") return false;
    clearTimeout(this._crashTimer);
    // Set crash point to current multiplier at this exact moment
    this.round.crashPoint = this.getMultiplier();

    this.doCrash();
    return true;
  }
  resetRound() {
    clearTimeout(this._crashTimer);
    clearInterval(this._countdownTimer);
    this.state = "waiting";
    this.activeBets = {};
    this.round.crashPoint = null;
    this.round.startTime = null;
    setTimeout(() => this.startWaiting(), 500);
    return true;
  }
  doCrash() {
    if (this.state !== "flying") return;
    this.state = "crashed";

    const crashPoint = this.round.crashPoint;

    // Deduct losing bets from balances (already deducted on bet placement)
    // Just mark them as lost
    Object.entries(this.activeBets).forEach(([phone, bet]) => {
      if (!bet.cashedOut) {
        bet.lost = true;
      }
    });

    // Save to history
    this.history.unshift({
      roundId: this.round.id,
      crashPoint,
      players: Object.keys(this.activeBets).length,
      timestamp: new Date().toISOString(),
    });
    if (this.history.length > 50) this.history.pop();

    this.emit("round:crash", { crashPoint, roundId: this.round.id });

    // Start next round after 3.5s
    this.round.id++;
    setTimeout(() => this.startWaiting(), 3500);
  }
  startFlight() {
    //Admin set crash poing
    const crashPoint = this.nextCrashPoint || this.generateCrashPoint();
    this.nextCrashPoint = null;
    this.round.crashPoint = crashPoint;
    this.round.startTime = Date.now();
    this.state = "flying";

    this.emit("round:start", {
      startTime: this.round.startTime,
      roundId: this.round.id,
      crashPoint: crashPoint,
    });

    // Backend controls crash timing
    const crashAfterMs = (Math.log(crashPoint) / 0.06) * 1000;
    this._crashTimer = setTimeout(() => {
      this.doCrash();
    }, crashAfterMs);
  }

  // Admin set next crash point
  setNextCrashPoint(value) {
    const v = parseFloat(value);
    if (isNaN(v) || v < 1.0) return false;
    this.nextCrashPoint = v;
    return true;
  }

  // ── Betting ───────────────────────────────────────────────────────────────

  placeBet(phone, amount) {
    if (this.state !== "waiting") {
      return { success: false, error: "Round already started" };
    }
    if (amount < this.MIN_BET) {
      return { success: false, error: `Minimum bet is KES ${this.MIN_BET}` };
    }
    if (this.activeBets[phone]) {
      return { success: false, error: "Bet already placed this round" };
    }
    if (this.getBalance(phone) < amount) {
      return {
        success: false,
        error: "Insufficient balance. Please deposit first.",
      };
    }

    // Deduct from balance
    this.balances[phone] -= amount;
    this.activeBets[phone] = { amount, cashedOut: false, winAmount: 0 };

    this.emit("bet:placed", { phone, amount, balance: this.balances[phone] });
    return { success: true, balance: this.balances[phone] };
  }

  cashOut(phone) {
    if (this.state !== "flying") {
      return { success: false, error: "Game not in flight" };
    }
    const bet = this.activeBets[phone];
    if (!bet) return { success: false, error: "No active bet found" };
    if (bet.cashedOut) return { success: false, error: "Already cashed out" };

    const multiplier = this.getMultiplier();
    const winAmount = parseFloat((bet.amount * multiplier).toFixed(2));

    bet.cashedOut = true;
    bet.cashoutMultiplier = multiplier;
    bet.winAmount = winAmount;

    // Add winnings to balance
    this.balances[phone] = parseFloat(
      ((this.balances[phone] || 0) + winAmount).toFixed(2),
    );

    this.emit("bet:cashedout", {
      phone,
      multiplier,
      winAmount,
      balance: this.balances[phone],
    });
    return {
      success: true,
      multiplier,
      winAmount,
      balance: this.balances[phone],
    };
  }

  // ── Deposits ──────────────────────────────────────────────────────────────

  registerPendingDeposit(checkoutRequestID, phone, amount) {
    this.pendingDeposits[checkoutRequestID] = {
      phone,
      amount,
      timestamp: Date.now(),
    };
  }

  confirmDeposit(checkoutRequestID) {
    const deposit = this.pendingDeposits[checkoutRequestID];
    if (!deposit) return null;

    const { phone, amount } = deposit;
    this.balances[phone] = parseFloat(
      ((this.balances[phone] || 0) + amount).toFixed(2),
    );
    delete this.pendingDeposits[checkoutRequestID];

    this.emit("deposit:confirmed", {
      phone,
      amount,
      balance: this.balances[phone],
    });
    return { phone, amount, balance: this.balances[phone] };
  }

  failDeposit(checkoutRequestID) {
    const deposit = this.pendingDeposits[checkoutRequestID];
    if (!deposit) return null;
    delete this.pendingDeposits[checkoutRequestID];
    this.emit("deposit:failed", { phone: deposit.phone });
    return deposit;
  }
}

module.exports = new GameEngine();
