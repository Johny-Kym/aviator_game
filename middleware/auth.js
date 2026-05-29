// ─── Admin Auth Middleware ──────────────────────────────────────────────────

const adminAuth = (req, res, next) => {
  const key =
    req.headers["x-admin-key"] ||
    req.body?.adminKey ||
    req.query?.adminKey;

  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized — invalid admin key" });
  }

  next();
};

module.exports = adminAuth;