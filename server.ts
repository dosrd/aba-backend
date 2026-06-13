import express from "express";
import Stripe from "stripe";
import mysql from "mysql2/promise";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import nodemailer from "nodemailer";
import multer from "multer";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import cors from "cors";
import { execSync, spawn as _spawnTeam } from "child_process";
import { fileURLToPath } from "url";
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const JWT_SECRET = process.env.JWT_SECRET || "fallback-secret-change-me";
const PORT = parseInt(process.env.PORT || "4006");

const DB_CONFIG = {
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "3306"),
  user: process.env.DB_USER || "aba_app",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "aba_portal",
};

let db: mysql.Pool;

async function initDB() {
  db = mysql.createPool({
    ...DB_CONFIG,
    connectionLimit: 5,
    waitForConnections: true,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
  });
  // Validate connection works
  await db.query("SELECT 1");
  console.log("✅ MySQL pool connected to aba_portal");

  // ===== Phase 1 Migration: Service keys table + new columns =====
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS aba_service_keys (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      service_name VARCHAR(64) NOT NULL,
      key_type VARCHAR(16) NOT NULL DEFAULT 'api_key',
      credentials JSON NOT NULL,
      is_active BOOLEAN DEFAULT TRUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX(user_id)
    )`);
    console.log("  ✅ aba_service_keys table ready");
  } catch(e: any) { console.log("  ⚠️ aba_service_keys:", e.message); }

  try {
    const [cols]: any = await db.execute("SHOW COLUMNS FROM aba_agent_configs LIKE 'custom_greeting'");
    if (cols.length === 0) {
      await db.execute(`ALTER TABLE aba_agent_configs
        ADD COLUMN custom_greeting TEXT,
        ADD COLUMN custom_personality_text TEXT,
        ADD COLUMN timezone VARCHAR(64) DEFAULT 'Africa/Lagos',
        ADD COLUMN nationality_vibe VARCHAR(64) DEFAULT 'Global',
        ADD COLUMN custom_instructions TEXT,
        ADD COLUMN mo_document_path VARCHAR(255),
        ADD COLUMN mo_document_name VARCHAR(255),
        ADD COLUMN sh_store_id VARCHAR(64),
        ADD COLUMN shopify_url VARCHAR(255),
        ADD COLUMN shopify_api_key VARCHAR(255),
        ADD COLUMN shopify_api_secret VARCHAR(255),
        ADD COLUMN shopify_access_token VARCHAR(255)`);
      console.log("  ✅ aba_agent_configs columns added");
    }
  } catch(e: any) { console.log("  ⚠️ agent_configs migration:", e.message); }

  try {
    const [tcols]: any = await db.execute("SHOW COLUMNS FROM aba_team_agents LIKE 'custom_greeting'");
    if (tcols.length === 0) {
      await db.execute(`ALTER TABLE aba_team_agents
        ADD COLUMN custom_greeting TEXT,
        ADD COLUMN custom_personality_text TEXT,
        ADD COLUMN timezone VARCHAR(64) DEFAULT 'Africa/Lagos',
        ADD COLUMN nationality_vibe VARCHAR(64) DEFAULT 'Global',
        ADD COLUMN custom_instructions TEXT,
        ADD COLUMN mo_document_path VARCHAR(255),
        ADD COLUMN mo_document_name VARCHAR(255)`);
      console.log("  ✅ aba_team_agents columns added");
    }
  } catch(e: any) { console.log("  ⚠️ team_agents migration:", e.message); }

  try {
    const [ok]: any = await db.execute("SHOW COLUMNS FROM aba_deployments LIKE 'owner_name'");
    if (ok.length === 0) {
      await db.execute(`ALTER TABLE aba_deployments
        ADD COLUMN owner_name VARCHAR(255),
        ADD COLUMN pending_build_at DATETIME,
        ADD COLUMN build_payload LONGTEXT`);
      console.log("  ✅ aba_deployments columns added");
    }
  } catch(e: any) { console.log("  ⚠️ deployments migration:", e.message); }
}
initDB().catch(err => { console.error("DB connection error:", err); process.exit(1); });

function getMailTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "mail.storeharmony.com",
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_SECURE === "true",
    auth: { user: process.env.SMTP_USER || "", pass: process.env.SMTP_PASS || "" },
    tls: { rejectUnauthorized: false },
  });
}

let stripeClient: Stripe | null = null;
function getStripe() {
  if (!stripeClient) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY environment variable is required for payments");
    stripeClient = new Stripe(key);
  }
  return stripeClient;
}

const app = express();

// ==================== STRIPE WEBHOOK (must be before global express.json to get raw body) ====================
app.post("/api/stripe-webhook", express.raw({ type: 'application/json' }), async (req: any, res: any) => {
  try {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    let event;
    if (endpointSecret) {
      event = getStripe().webhooks.constructEvent(req.body, sig, endpointSecret);
    } else {
      event = JSON.parse(req.body);
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const email = session.customer_details?.email || session.metadata?.email;
        if (email) {
          const [rows]: any = await db.execute("SELECT id FROM aba_users WHERE email=?", [email]);
          if (rows.length > 0) {
            const userId = rows[0].id;
            await db.execute(
              "INSERT INTO aba_subscriptions (user_id, plan, status, stripe_subscription_id, current_period_start, current_period_end) VALUES (?, ?, 'active', ?, NOW(), DATE_ADD(NOW(), INTERVAL 1 MONTH))",
              [userId, session.metadata?.plan || "entry", session.subscription || ""]
            );
            // Link Stripe customer
            if (session.customer) {
              await db.execute("UPDATE aba_users SET stripe_customer_id=? WHERE id=?", [session.customer, userId]);
            }
          }
        }
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const [rows]: any = await db.execute("SELECT id FROM aba_subscriptions WHERE stripe_subscription_id=?", [sub.id]);
        if (rows.length > 0) {
          await db.execute("UPDATE aba_subscriptions SET status=?, current_period_end=FROM_UNIXTIME(?) WHERE stripe_subscription_id=?", [sub.status, sub.current_period_end, sub.id]);
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await db.execute("UPDATE aba_subscriptions SET status='cancelled' WHERE stripe_subscription_id=?", [sub.id]);
        break;
      }
    }
    res.json({ received: true });
  } catch (err: any) {
    console.error("Stripe webhook error:", err);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

app.use(express.json({ limit: "50mb" }));
app.use(cors({ origin: ["https://dabarobjects.com", "http://localhost:3000", "http://localhost:5173"], credentials: true }));

// ==================== AUTH MIDDLEWARE ====================
function authMiddleware(req: any, res: any, next: any) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }
  try {
    const decoded = jwt.verify(authHeader.split(" ")[1], JWT_SECRET) as any;
    req.user = { userId: decoded.userId };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ==================== AUTH ====================

app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });
    const [existing]: any = await db.execute("SELECT id FROM aba_users WHERE email = ?", [email]);
    if (existing.length > 0) return res.status(400).json({ error: "Email already registered" });
    const hash = await bcrypt.hash(password, 10);
    const result: any = await db.execute(
      "INSERT INTO aba_users (email, password_hash, name) VALUES (?, ?, ?)",
      [email, hash, name || email.split("@")[0]]
    );
    const userId = result[0].insertId;
    await db.execute(
      "INSERT INTO aba_subscriptions (user_id, plan, status) VALUES (?, 'entry', 'inactive')",
      [userId]
    );
    await db.execute(
      "INSERT INTO aba_agent_configs (user_id, agent_name, personality) VALUES (?, 'My Assistant', 'Professional')",
      [userId]
    );
    const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: "30d" });
    const [user]: any = await db.execute("SELECT id, email, name FROM aba_users WHERE id = ?", [userId]);
    res.json({ token, user: user[0] });
    sendWelcomeEmail(email, name || email.split("@")[0]).catch(() => {});
  } catch (err: any) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });
    const [rows]: any = await db.execute("SELECT id, email, name, password_hash FROM aba_users WHERE email = ?", [email]);
    if (rows.length === 0) return res.status(400).json({ error: "Invalid email or password" });
    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).json({ error: "Invalid email or password" });
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err: any) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

app.post("/api/auth/google", async (req, res) => {
  try {
    const { email, name, googleId } = req.body;
    if (!email || !googleId) return res.status(400).json({ error: "Email and Google ID required" });
    let [rows]: any = await db.execute("SELECT id, email, name FROM aba_users WHERE email = ?", [email]);
    if (rows.length === 0) {
      await db.execute(
        "INSERT INTO aba_users (email, name, google_id) VALUES (?, ?, ?)",
        [email, name || email.split("@")[0], googleId]
      );
      const [nr]: any = await db.execute("SELECT id, email, name FROM aba_users WHERE email = ?", [email]);
      rows = nr;
      const userId = rows[0].id;
      await db.execute("INSERT INTO aba_subscriptions (user_id, plan, status) VALUES (?, 'entry', 'inactive')", [userId]);
      await db.execute("INSERT INTO aba_agent_configs (user_id, agent_name, personality) VALUES (?, 'My Assistant', 'Professional')", [userId]);
    } else {
      await db.execute("UPDATE aba_users SET google_id = ? WHERE email = ?", [googleId, email]);
    }
    const user = rows[0];
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user });
  } catch (err: any) {
    console.error("Google auth error:", err);
    res.status(500).json({ error: "Google auth failed" });
  }
});

app.get("/api/auth/me", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute("SELECT id, email, name, role, selected_template FROM aba_users WHERE id = ?", [userId]);
    if (rows.length === 0) return res.status(404).json({ error: "User not found" });
    const user = rows[0];
    // Attach subscription data
    const [subRows]: any = await db.execute(
      "SELECT plan, status, current_period_start, current_period_end FROM aba_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", [userId]
    );
    user.subscription = subRows.length > 0 ? subRows[0] : { plan: null, status: 'inactive' };
    res.json(user);
  } catch { res.status(500).json({ error: "Failed to fetch user" }); }
});

app.post("/api/auth/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });
    const [rows]: any = await db.execute("SELECT id, email, name FROM aba_users WHERE email = ?", [email]);
    if (rows.length === 0) return res.json({ success: true, message: "If email exists, reset link sent" });
    const token = crypto.randomBytes(32).toString("hex");
    await db.execute("DELETE FROM aba_password_resets WHERE email = ?", [email]);
    await db.execute("INSERT INTO aba_password_resets (email, token, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR))", [email, token]);
    const transporter = getMailTransporter();
    await transporter.sendMail({
      from: "ABA <no-reply-pawpaw@storeharmony.com>",
      to: email,
      subject: "Reset Your ABA Password",
      html: `<p>Hi ${rows[0].name || "there"},</p><p>Click to reset: <a href="https://dabarobjects.com/#/reset-password?token=${token}">Reset Password</a></p><p>Expires in 1 hour.</p>`
    });
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Failed to send reset email" }); }
});

app.post("/api/auth/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: "Token and password required" });
    const [rows]: any = await db.execute("SELECT email FROM aba_password_resets WHERE token = ? AND expires_at > NOW()", [token]);
    if (rows.length === 0) return res.status(400).json({ error: "Invalid or expired token" });
    const hash = await bcrypt.hash(password, 10);
    await db.execute("UPDATE aba_users SET password_hash = ? WHERE email = ?", [hash, rows[0].email]);
    await db.execute("DELETE FROM aba_password_resets WHERE token = ?", [token]);
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Failed to reset password" }); }
});

async function sendWelcomeEmail(email: string, name: string) {
  try {
    const transporter = getMailTransporter();
    await transporter.sendMail({
      from: "ABA <no-reply-pawpaw@storeharmony.com>",
      to: email,
      subject: "Welcome to ABA — Your Digital Workforce Awaits 🚀",
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px">
        <h1>Welcome to ABA, ${name}!</h1>
        <p>Your Autonomous Business Agents dashboard is ready.</p>
        <a href="https://dabarobjects.com/#/dashboard/setup" style="display:inline-block;background:#f59e0b;color:white;padding:14px 28px;border-radius:12px;text-decoration:none">Setup Your First Agent</a>
        <p style="margin-top:24px;color:#666">— The ABA Team</p>
      </div>`
    });
  } catch (err) { console.error("Welcome email error:", err); }
}

// ==================== USER PROFILE ====================

app.put("/api/user", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { name } = req.body;
    await db.execute("UPDATE aba_users SET name = ? WHERE id = ?", [name, userId]);
    const [rows]: any = await db.execute("SELECT id, email, name FROM aba_users WHERE id = ?", [userId]);
    res.json(rows[0]);
  } catch { res.status(500).json({ error: "Failed to update user" }); }
});

app.post("/api/auth/change-password", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { currentPassword, newPassword } = req.body;
    const [rows]: any = await db.execute("SELECT password_hash FROM aba_users WHERE id = ?", [userId]);
    if (rows.length === 0) return res.status(404).json({ error: "User not found" });
    const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!valid) return res.status(400).json({ error: "Current password is incorrect" });
    const hash = await bcrypt.hash(newPassword, 10);
    await db.execute("UPDATE aba_users SET password_hash = ? WHERE id = ?", [hash, userId]);
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Failed to change password" }); }
});

app.post("/api/account/close", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    // Cancel any active subscriptions
    const [subs]: any = await db.execute("SELECT stripe_subscription_id FROM aba_subscriptions WHERE user_id = ? AND status = 'active' AND stripe_subscription_id IS NOT NULL", [userId]);
    for (const sub of subs) {
      try { await getStripe().subscriptions.cancel(sub.stripe_subscription_id); } catch {}
    }
    await db.execute("DELETE FROM aba_users WHERE id = ?", [userId]);
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Failed to close account" }); }
});

// ==================== BUSINESS ====================

app.get("/api/business", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute("SELECT * FROM aba_businesses WHERE user_id = ?", [userId]);
    res.json(rows.length > 0 ? rows[0] : { business_name: "" });
  } catch { res.status(500).json({ error: "Failed to fetch business" }); }
});

app.put("/api/business", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { business_name, description, industry, registration_id, tax_id, phone, website, address, logo_url, social_facebook, social_twitter, social_linkedin, social_instagram } = req.body;
    const [existing]: any = await db.execute("SELECT id FROM aba_businesses WHERE user_id = ?", [userId]);
    if (existing.length > 0) {
      await db.execute(
        "UPDATE aba_businesses SET business_name=?, description=?, industry=?, registration_id=?, tax_id=?, phone=?, website=?, address=?, logo_url=?, social_facebook=?, social_twitter=?, social_linkedin=?, social_instagram=? WHERE user_id=?",
        [business_name, description, industry, registration_id || '', tax_id || '', phone, website, address, logo_url, social_facebook || '', social_twitter || '', social_linkedin || '', social_instagram || '', userId]
      );
    } else {
      await db.execute(
        "INSERT INTO aba_businesses (user_id, business_name, description, industry, registration_id, tax_id, phone, website, address, logo_url, social_facebook, social_twitter, social_linkedin, social_instagram) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [userId, business_name, description, industry, registration_id || '', tax_id || '', phone, website, address, logo_url, social_facebook || '', social_twitter || '', social_linkedin || '', social_instagram || '']
      );
    }
    const [rows]: any = await db.execute("SELECT * FROM aba_businesses WHERE user_id = ?", [userId]);
    res.json(rows[0]);
  } catch { res.status(500).json({ error: "Failed to update business" }); }
});

// ==================== PRODUCTS ====================

app.get("/api/products", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute("SELECT * FROM aba_products WHERE user_id = ? ORDER BY created_at DESC", [userId]);
    res.json(rows);
  } catch { res.status(500).json({ error: "Failed to fetch products" }); }
});

app.post("/api/products", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { name, description, price, category } = req.body;
    const result: any = await db.execute(
      "INSERT INTO aba_products (user_id, name, description, price, category) VALUES (?, ?, ?, ?, ?)",
      [userId, name, description, price, category]
    );
    const [rows]: any = await db.execute("SELECT * FROM aba_products WHERE id = ?", [result[0].insertId]);
    res.json(rows[0]);
  } catch { res.status(500).json({ error: "Failed to create product" }); }
});

app.put("/api/products/:id", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { name, description, price, category } = req.body;
    await db.execute("UPDATE aba_products SET name=?, description=?, price=?, category=? WHERE id=? AND user_id=?", [name, description, price, category, req.params.id, userId]);
    const [rows]: any = await db.execute("SELECT * FROM aba_products WHERE id = ?", [req.params.id]);
    res.json(rows[0]);
  } catch { res.status(500).json({ error: "Failed to update product" }); }
});

app.delete("/api/products/:id", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    await db.execute("DELETE FROM aba_products WHERE id = ? AND user_id = ?", [req.params.id, userId]);
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Failed to delete product" }); }
});

// ==================== AGENT CONFIG ====================

app.get("/api/agent-config", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute("SELECT * FROM aba_agent_configs WHERE user_id = ?", [userId]);
    res.json(rows.length > 0 ? rows[0] : {});
  } catch { res.status(500).json({ error: "Failed to fetch agent config" }); }
});

app.put("/api/agent-config", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { agent_name, gender, personality, telegram_bot_token, bot_name, welcome_message,
      whatsapp_number, whatsapp_open_dm, email_pop_host, email_pop_port, email_pop_user, email_pop_pass,
      twilio_sid, twilio_auth_token, twilio_phone, github_token, woo_url, woo_key, woo_secret,
      db_connection_string, google_drive_folder, knowledge_sources, integrations } = req.body;

    // mysql2 rejects `undefined` — coalesce any missing field to null
    const nz = (v: any) => (v === undefined ? null : v);

    // Ping the DB pool to ensure connection is alive before deploying
    try { await db.query("SELECT 1"); } catch { /* pool handles reconnect */ }

    const [existing]: any = await db.execute("SELECT id FROM aba_agent_configs WHERE user_id = ?", [userId]);
    if (existing.length > 0) {
      await db.execute(`UPDATE aba_agent_configs SET
        agent_name=?, gender=?, personality=?, telegram_bot_token=?, bot_name=?, welcome_message=?,
        whatsapp_number=?, whatsapp_open_dm=?, email_pop_host=?, email_pop_port=?, email_pop_user=?, email_pop_pass=?,
        twilio_sid=?, twilio_auth_token=?, twilio_phone=?, github_token=?, woo_url=?, woo_key=?, woo_secret=?,
        db_connection_string=?, google_drive_folder=?, knowledge_sources=?, integrations=?
        WHERE user_id=?`,
        [nz(agent_name), nz(gender), nz(personality), nz(telegram_bot_token), bot_name || '', welcome_message || '',
        nz(whatsapp_number), whatsapp_open_dm ?? 1, nz(email_pop_host), email_pop_port ?? 993, nz(email_pop_user), nz(email_pop_pass),
        nz(twilio_sid), nz(twilio_auth_token), nz(twilio_phone), nz(github_token), nz(woo_url), nz(woo_key), nz(woo_secret),
        nz(db_connection_string), nz(google_drive_folder), knowledge_sources ? JSON.stringify(knowledge_sources) : null,
        integrations ? JSON.stringify(integrations) : null, userId]
      );
    } else {
      await db.execute(`INSERT INTO aba_agent_configs (
        user_id, agent_name, gender, personality, telegram_bot_token, bot_name, welcome_message,
        whatsapp_number, whatsapp_open_dm, email_pop_host, email_pop_port, email_pop_user, email_pop_pass,
        twilio_sid, twilio_auth_token, twilio_phone, github_token, woo_url, woo_key, woo_secret,
        db_connection_string, google_drive_folder, knowledge_sources, integrations
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, nz(agent_name), nz(gender), nz(personality), nz(telegram_bot_token), bot_name || '', welcome_message || '',
        nz(whatsapp_number), whatsapp_open_dm ?? 1, nz(email_pop_host), email_pop_port ?? 993, nz(email_pop_user), nz(email_pop_pass),
        nz(twilio_sid), nz(twilio_auth_token), nz(twilio_phone), nz(github_token), nz(woo_url), nz(woo_key), nz(woo_secret),
        nz(db_connection_string), nz(google_drive_folder), knowledge_sources ? JSON.stringify(knowledge_sources) : null,
        integrations ? JSON.stringify(integrations) : null]
      );
    }
    const [rows]: any = await db.execute("SELECT * FROM aba_agent_configs WHERE user_id = ?", [userId]);
    res.json(rows[0]);
  } catch (err: any) {
    console.error("Update agent config error:", err);
    res.status(500).json({ error: "Failed to update agent config" });
  }
});

// ==================== TEAM AGENTS ====================

app.get("/api/team-agents", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute(
      "SELECT id, agent_name, gender, role, agent_slug, personality, telegram_bot_token, bot_name, welcome_message, status, telegram_bot_username, error_message, applied_at, created_at FROM aba_team_agents WHERE user_id = ? ORDER BY created_at ASC",
      [userId]
    );
    // mask token in list response
    rows.forEach((r: any) => { if (r.telegram_bot_token) r.telegram_bot_token = '•••' + String(r.telegram_bot_token).slice(-4); });
    res.json(rows);
  } catch (err: any) {
    console.error("List team agents error:", err);
    res.status(500).json({ error: "Failed to fetch team agents" });
  }
});

app.post("/api/team-agents", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { agent_name, gender, role, personality, telegram_bot_token, bot_name, welcome_message } = req.body;

    if (!agent_name) return res.status(400).json({ error: "Agent name required" });
    if (!telegram_bot_token) return res.status(400).json({ error: "Telegram bot token required" });

    const result = await db.execute(
      `INSERT INTO aba_team_agents (user_id, agent_name, gender, role, personality, telegram_bot_token, bot_name, welcome_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, agent_name, gender || 'Female', role || null, personality || 'Professional', telegram_bot_token, bot_name || '', welcome_message || '']
    );

    res.json({ success: true, id: (result as any)[0]?.insertId });
  } catch (err: any) {
    console.error("Create team agent error:", err);
    res.status(500).json({ error: "Failed to create team agent" });
  }
});

app.delete("/api/team-agents/:id", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const result = await db.execute("DELETE FROM aba_team_agents WHERE id = ? AND user_id = ?", [req.params.id, userId]);
    if ((result as any)[0]?.affectedRows === 0) return res.status(404).json({ error: "Team agent not found" });
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Failed to delete team agent" }); }
});

// Launch / apply team agents: merge into the user's running EC2 openclaw.json and restart OpenClaw
const TEAM_APPLY_SCRIPT = "/root/.openclaw/workspace/scripts/aba-team-apply.py";

app.post("/api/team-agents/launch", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;

    // Need an active deployment
    const [depRows]: any = await db.execute("SELECT status, public_ip FROM aba_deployments WHERE user_id = ?", [userId]);
    const dep = depRows.length > 0 ? depRows[0] : null;
    if (!dep || dep.status !== 'active' || !dep.public_ip) {
      return res.status(400).json({ error: "Your admin agent server must be live before adding team agents." });
    }

    // Must have at least one team agent not yet active
    const [taRows]: any = await db.execute("SELECT COUNT(*) AS n FROM aba_team_agents WHERE user_id = ?", [userId]);
    if (!taRows[0] || taRows[0].n === 0) {
      return res.status(400).json({ error: "No team agents to launch." });
    }

    // Mark applying immediately so the UI can poll
    await db.execute("UPDATE aba_team_agents SET status='applying', error_message=NULL WHERE user_id = ?", [userId]);

    // Fire-and-forget the apply script (it updates DB status when done)
    const child = _spawnTeam("python3", [TEAM_APPLY_SCRIPT, String(userId)], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    res.json({ success: true, message: "Launching team agents — building on your server..." });
  } catch (err: any) {
    console.error("Team launch error:", err);
    res.status(500).json({ error: "Failed to launch team agents" });
  }
});

// ==================== AGENT TEMPLATES ====================

app.get("/api/agent-templates", async (req, res) => {
  try {
    const [rows]: any = await db.execute("SELECT * FROM aba_agent_templates ORDER BY id");
    rows.forEach((r: any) => { if (typeof r.traits === "string") r.traits = JSON.parse(r.traits || "{}"); });
    res.json(rows);
  } catch { res.status(500).json({ error: "Failed to fetch templates" }); }
});

app.post("/api/agent-config/apply-template/:templateId", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [templates]: any = await db.execute("SELECT * FROM aba_agent_templates WHERE id = ?", [req.params.templateId]);
    if (templates.length === 0) return res.status(404).json({ error: "Template not found" });
    const tmpl = templates[0];
    await db.execute("UPDATE aba_agent_configs SET agent_name=?, personality=?, welcome_message=? WHERE user_id=?", [tmpl.name, tmpl.personality, tmpl.welcome_message || "", userId]);
    await db.execute("UPDATE aba_users SET selected_template=? WHERE id=?", [tmpl.slug, userId]);
    const [configs]: any = await db.execute("SELECT * FROM aba_agent_configs WHERE user_id=?", [userId]);
    res.json({ success: true, config: configs[0], template: tmpl });
  } catch { res.status(500).json({ error: "Failed to apply template" }); }
});

// ==================== API KEYS ====================

/**
 * Quick validation: test a provider API key before saving.
 * Only DeepSeek and OpenAI are checked (the ones we auto-deploy).
 * Other providers (Anthropic, Google, ElevenLabs etc.) are saved as-is.
 */
async function validateProviderKey(provider: string, apiKey: string): Promise<string | null> {
  try {
    if (provider === 'deepseek') {
      const res = await fetch('https://api.deepseek.com/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      if (res.status === 401) return 'Invalid DeepSeek key — check you copied the full key from platform.deepseek.com';
      if (res.status === 403) return 'DeepSeek key rejected — it may have been revoked or lacks permissions';
      if (!res.ok) return `DeepSeek returned ${res.status} — try again or use a different key`;
    } else if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      if (res.status === 401) return 'Invalid OpenAI key — check you copied the full key from platform.openai.com';
      if (res.status === 403) return 'OpenAI key rejected — it may have been revoked or lacks permissions';
      if (!res.ok) return `OpenAI returned ${res.status} — try again or use a different key`;
    }
    return null; // valid
  } catch {
    return null; // network blip — let it save, don't block the user for a transient issue
  }
}

app.get("/api/api-keys", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute("SELECT id, provider, label, is_active, created_at FROM aba_api_keys WHERE user_id = ?", [userId]);
    res.json(rows);
  } catch { res.status(500).json({ error: "Failed to fetch API keys" }); }
});

app.put("/api/api-keys/:provider", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { api_key, label, is_active } = req.body;
    if (!api_key) return res.status(400).json({ error: "API key required" });

    // Validate before saving (skip sentinel value used for toggle)
    if (api_key !== '___keep___') {
      const validationError = await validateProviderKey(req.params.provider, api_key);
      if (validationError) return res.status(400).json({ error: validationError });
    }

    await db.execute(
      `INSERT INTO aba_api_keys (user_id, provider, api_key, label, is_active)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE api_key=VALUES(api_key), label=VALUES(label), is_active=VALUES(is_active)`,
      [userId, req.params.provider, api_key, label || "", is_active ?? 1]
    );
    const [rows]: any = await db.execute("SELECT id, provider, label, is_active FROM aba_api_keys WHERE user_id=? AND provider=?", [userId, req.params.provider]);
    res.json(rows[0]);
  } catch { res.status(500).json({ error: "Failed to save API key" }); }
});

app.delete("/api/api-keys/:provider", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    await db.execute("DELETE FROM aba_api_keys WHERE user_id=? AND provider=?", [userId, req.params.provider]);
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Failed to delete API key" }); }
});

// ==================== ASSOCIATES ====================

app.get("/api/associates", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute("SELECT * FROM aba_associates WHERE user_id = ? ORDER BY created_at DESC", [userId]);
    res.json(rows);
  } catch { res.status(500).json({ error: "Failed to fetch associates" }); }
});

app.post("/api/associates", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { firstname, lastname, email, mobile, role, notes } = req.body;
    const result: any = await db.execute(
      "INSERT INTO aba_associates (user_id, firstname, lastname, email, mobile, role, notes) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [userId, firstname, lastname, email, mobile, role, notes]
    );
    const [rows]: any = await db.execute("SELECT * FROM aba_associates WHERE id = ?", [result[0].insertId]);
    res.json(rows[0]);
  } catch { res.status(500).json({ error: "Failed to create associate" }); }
});

app.put("/api/associates/:id", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { firstname, lastname, email, mobile, role, notes } = req.body;
    await db.execute(
      "UPDATE aba_associates SET firstname=?, lastname=?, email=?, mobile=?, role=?, notes=? WHERE id=? AND user_id=?",
      [firstname, lastname, email, mobile, role, notes, req.params.id, userId]
    );
    const [rows]: any = await db.execute("SELECT * FROM aba_associates WHERE id = ?", [req.params.id]);
    res.json(rows[0]);
  } catch { res.status(500).json({ error: "Failed to update associate" }); }
});

app.delete("/api/associates/:id", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    await db.execute("DELETE FROM aba_associates WHERE id=? AND user_id=?", [req.params.id, userId]);
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Failed to delete associate" }); }
});

// ==================== SUBSCRIPTIONS ====================

app.get("/api/subscription", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute(
      "SELECT plan, status, stripe_subscription_id, current_period_start, current_period_end FROM aba_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", [userId]
    );
    res.json(rows.length > 0 ? rows[0] : { plan: null, status: "none" });
  } catch { res.status(500).json({ error: "Failed to fetch subscription" }); }
});

app.post("/api/subscription/cancel", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute(
      "SELECT stripe_subscription_id FROM aba_subscriptions WHERE user_id = ? AND status = 'active'", [userId]
    );
    for (const r of rows) {
      if (r.stripe_subscription_id) try { await getStripe().subscriptions.cancel(r.stripe_subscription_id); } catch {}
    }
    await db.execute("UPDATE aba_subscriptions SET status = 'cancelled' WHERE user_id = ? AND status = 'active'", [userId]);
    await db.execute(
      "UPDATE aba_deployments SET status = 'decommissioned' WHERE user_id = ? AND status IN ('active', 'provisioning', 'pending')", [userId]
    );
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Failed to cancel subscription" }); }
});

// ==================== INVOICES ====================

app.get("/api/invoices", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute("SELECT * FROM aba_invoices WHERE user_id = ? ORDER BY created_at DESC", [userId]);
    res.json(rows);
  } catch { res.status(500).json({ error: "Failed to fetch invoices" }); }
});

// ==================== DEPLOY ====================

app.get("/api/deploy", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute("SELECT * FROM aba_deployments WHERE user_id = ?", [userId]);
    if (rows.length === 0) return res.json({ status: null });
    const d = rows[0];
    res.json({ id: d.id, status: d.status, instanceId: d.instance_id, publicIp: d.public_ip,
      telegramUsername: d.telegram_bot_username, errorMessage: d.error_message, bindCode: d.bind_code,
      ownerChatId: d.owner_chat_id, ownerName: d.owner_name, deployedAt: d.deployed_at, decommissionedAt: d.decommissioned_at,
      createdAt: d.created_at });
  } catch { res.status(500).json({ error: "Failed to fetch deployment" }); }
});

app.post("/api/deploy", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;

    const [existing]: any = await db.execute("SELECT * FROM aba_deployments WHERE user_id = ?", [userId]);
    if (existing.length > 0) {
      const d = existing[0];
      if (d.status === 'provisioning' && d.updated_at && new Date(d.updated_at).getTime() < Date.now() - 15 * 60 * 1000) {
        await db.execute("UPDATE aba_deployments SET status='failed', error_message='Stale provisioning — retrying', updated_at=NOW() WHERE id=?", [d.id]);
      } else if (d.status !== 'failed' && d.status !== 'decommissioned') {
        return res.status(400).json({ error: `Already has a deployment (${d.status})` });
      }
    }

    const [subRows]: any = await db.execute("SELECT * FROM aba_subscriptions WHERE user_id=? ORDER BY created_at DESC LIMIT 1", [userId]);
    const sub = subRows.length > 0 ? subRows[0] : null;
    if (!sub || sub.status !== 'active') return res.status(400).json({ error: "Active subscription required to deploy" });

    let [keyRows]: any = await db.execute("SELECT * FROM aba_api_keys WHERE user_id=? AND is_active=1", [userId]);
    if (keyRows.length === 0) {
      const defaultKey = process.env.DEFAULT_DEEPSEEK_KEY;
      if (defaultKey) {
        await db.execute("INSERT INTO aba_api_keys (user_id, provider, api_key, is_active) VALUES (?, 'deepseek', ?, 1) ON DUPLICATE KEY UPDATE api_key=VALUES(api_key)", [userId, defaultKey]);
        [keyRows] = await db.execute("SELECT * FROM aba_api_keys WHERE user_id=? AND is_active=1", [userId]);
      } else return res.status(400).json({ error: "At least one AI provider API key required" });
    }

    const [agentRows]: any = await db.execute("SELECT * FROM aba_agent_configs WHERE user_id=?", [userId]);
    const agent = agentRows.length > 0 ? agentRows[0] : null;
    if (!agent || !agent.telegram_bot_token) return res.status(400).json({ error: "Telegram bot token required" });

    const [userRows]: any = await db.execute("SELECT * FROM aba_users WHERE id=?", [userId]);
    const user = userRows[0];
    const bindCode = Math.random().toString(36).substring(2, 8).toUpperCase();

    if (existing.length > 0) {
      await db.execute("UPDATE aba_deployments SET status='pending', error_message=NULL, deployed_at=NULL, decommissioned_at=NULL, bind_code=?, owner_chat_id=NULL WHERE user_id=?", [bindCode, userId]);
    } else {
      await db.execute("INSERT INTO aba_deployments (user_id, status, bind_code, updated_at) VALUES (?, 'pending', ?, NOW())", [userId, bindCode]);
    }

    res.json({ success: true, message: "Deployment queued.", userEmail: user.email, bindCode });
  } catch (err: any) {
    console.error("Deploy error:", err);
    res.status(500).json({ error: "Failed to queue deployment" });
  }
});

app.post("/api/deploy/decommission", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute("SELECT * FROM aba_deployments WHERE user_id=? AND status IN ('active','provisioning','failed')", [userId]);
    if (rows.length === 0) return res.status(400).json({ error: "No active deployment found" });
    const dep = rows[0];
    if (dep.instance_id) {
      try { execSync(`aws ec2 terminate-instances --instance-ids ${dep.instance_id} --region us-east-1`, { timeout: 15000, stdio: 'pipe' }); } catch {}
    }
    await db.execute("UPDATE aba_deployments SET status='decommissioned', decommissioned_at=NOW() WHERE id=?", [dep.id]);
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Failed to decommission" }); }
});

// GET-friendly bind endpoint so the agent can call via web_fetch (GET only)
app.get("/api/deploy/bind/:bind_code/:chat_id", async (req, res) => {
  try {
    const { bind_code, chat_id } = req.params;
    if (!bind_code || !chat_id) return res.status(400).json({ error: "bind_code and chat_id required" });
    const [rows]: any = await db.execute("SELECT id, user_id, status, owner_chat_id FROM aba_deployments WHERE bind_code=?", [bind_code]);
    if (rows.length === 0) return res.status(404).json({ error: "Invalid bind code" });
    const dep = rows[0];
    if (dep.owner_chat_id) return res.json({ already_bound: true, message: "Already bound. Ask admin to reset." });
    await db.execute("UPDATE aba_deployments SET owner_chat_id=? WHERE id=?", [chat_id, dep.id]);
    const [userRows]: any = await db.execute("SELECT name, email FROM aba_users WHERE id=?", [dep.user_id]);
    const userName = userRows.length > 0 ? (userRows[0].name || userRows[0].email) : 'Owner';
    res.json({ success: true, message: `Bound successfully! You are now the owner of this agent.`, ownerName: userName });
  } catch { res.status(500).json({ error: "Bind failed" }); }
});

// POST bind (kept for dashboard/sdk compatibility)
app.post("/api/deploy/bind", async (req, res) => {
  try {
    const { bind_code, chat_id } = req.body;
    if (!bind_code || !chat_id) return res.status(400).json({ error: "bind_code and chat_id required" });
    const [rows]: any = await db.execute("SELECT id, user_id, status, owner_chat_id FROM aba_deployments WHERE bind_code=?", [bind_code]);
    if (rows.length === 0) return res.status(404).json({ error: "Invalid bind code" });
    const dep = rows[0];
    if (dep.owner_chat_id) return res.json({ already_bound: true, message: "Already bound. Ask admin to reset." });
    await db.execute("UPDATE aba_deployments SET owner_chat_id=? WHERE id=?", [chat_id, dep.id]);
    const [userRows]: any = await db.execute("SELECT name, email FROM aba_users WHERE id=?", [dep.user_id]);
    const userName = userRows.length > 0 ? (userRows[0].name || userRows[0].email) : 'Owner';
    res.json({ success: true, message: `Bound successfully! You are now the owner of this agent.`, ownerName: userName });
  } catch { res.status(500).json({ error: "Bind failed" }); }
});

// ==================== OPENCLAW CONFIG ====================

app.get("/api/openclaw-config", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [userRows]: any = await db.execute("SELECT * FROM aba_users WHERE id=?", [userId]);
    if (userRows.length === 0) return res.status(404).json({ error: "User not found" });
    const user = userRows[0];
    const [bizRows]: any = await db.execute("SELECT * FROM aba_businesses WHERE user_id=?", [userId]);
    const business = bizRows.length > 0 ? bizRows[0] : {};
    const [prodRows]: any = await db.execute("SELECT * FROM aba_products WHERE user_id=?", [userId]);
    const products = prodRows || [];
    const [agentRows]: any = await db.execute("SELECT * FROM aba_agent_configs WHERE user_id=?", [userId]);
    const agent = agentRows.length > 0 ? agentRows[0] : {};
    const [subRows]: any = await db.execute("SELECT * FROM aba_subscriptions WHERE user_id=? ORDER BY created_at DESC LIMIT 1", [userId]);
    const subscription = subRows.length > 0 ? subRows[0] : null;

    // Generate SOUL.md
    const personality = agent.personality || "Professional";
    const bizName = business.business_name || "My Business";
    const soulMd = `# ${agent.agent_name || "My ABA Agent"} — SOUL.md

## Identity
I am an AI business assistant named **${agent.agent_name || "Assistant"}**, serving **${bizName}**.
My personality is **${personality}** — I communicate with ${personality.toLowerCase()} professionalism in all interactions.

## Mission
I operate 24/7 to handle customer inquiries, manage business workflows, and improve operational efficiency for ${bizName}. I represent the business accurately and professionally at all times.

## Core Capabilities
- Customer support and inquiry handling
- Product/service information and recommendations
- Order management and tracking
- Business knowledge retrieval
${business.industry ? `- Industry expertise in ${business.industry}` : "- General business assistance"}

## Communication Style
${personality === "Friendly" ? "Warm, approachable, and conversational. I make customers feel welcomed and valued." :
  personality === "Warm" ? "Kind and empathetic with a personal touch. I build genuine rapport." :
  personality === "Creative" ? "Imaginative and engaging. I bring creative solutions to conversations." :
  personality === "Efficient" ? "Direct, concise, and action-oriented. I value the customer's time." :
  "Professional, courteous, and clear. I maintain high standards of business communication."}`;

    // Products knowledge
    const productLines = products.map((p: any) => `- **${p.name}**${p.price ? ` (${p.price})` : ''}${p.description ? `: ${p.description}` : ''}`).join('\n');
    const knowledgeMd = products.length > 0
      ? `## Products & Services\n\n${productLines}\n`
      : '';

    // Generate persona.md
    const personaMd = `# Persona: ${agent.agent_name || "Assistant"}
- **Name:** ${agent.agent_name || "Assistant"}
- **Personality:** ${personality}
- **Role:** AI Business Assistant for ${bizName}\n`;

    // Generate openclaw.json
    const openclawConfig: any = {
      channels: agent.telegram_bot_token ? {
        telegram: { botToken: agent.telegram_bot_token }
      } : {},
      knowledge: { files: [], directories: ["/workspace/knowledge"] },
      persona: { displayName: agent.agent_name || "Assistant", description: `AI Assistant for ${bizName}` },
    };
    if (agent.whatsapp_number) openclawConfig.channels = { ...openclawConfig.channels, whatsapp: { number: agent.whatsapp_number } };

    const [configRows]: any = await db.execute("SELECT id FROM aba_openclaw_configs WHERE user_id=?", [userId]);
    if (configRows.length > 0) {
      await db.execute("UPDATE aba_openclaw_configs SET openclaw_json=?, soul_md=?, knowledge_md=?, persona_md=?, generated_at=NOW() WHERE user_id=?", [JSON.stringify(openclawConfig), soulMd, knowledgeMd, personaMd, userId]);
    } else {
      await db.execute("INSERT INTO aba_openclaw_configs (user_id, openclaw_json, soul_md, knowledge_md, persona_md, generated_at) VALUES (?, ?, ?, ?, ?, NOW())", [userId, JSON.stringify(openclawConfig), soulMd, knowledgeMd, personaMd]);
    }

    res.json({ openclaw_json: openclawConfig, soul_md: soulMd, knowledge_md: knowledgeMd, persona_md: personaMd });
  } catch (err: any) {
    console.error("OpenClaw config error:", err);
    res.status(500).json({ error: "Failed to generate config" });
  }
});

// ==================== CHECKOUT ====================

app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { planName, price, interval, userEmail } = req.body;
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: `ABA ${planName} Plan`, description: `Autonomous Business Agents - ${planName} Subscription` },
          unit_amount: Math.round(parseFloat(price) * 100),
          recurring: { interval: interval || "month" },
        },
        quantity: 1,
      }],
      mode: "subscription",
      success_url: `${req.headers.origin}/#/dashboard/setup?from=quickstart&success=true`,
      cancel_url: `${req.headers.origin}/pricing?canceled=true`,
      ...(userEmail ? { customer_email: userEmail } : {}),
      metadata: { plan: planName, email: userEmail || '' },
    });
    res.json({ url: session.url });
  } catch (error: any) {
    console.error("Stripe Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== ADMIN ENDPOINT ====================

app.get("/api/admin/users", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [userRows]: any = await db.execute("SELECT role FROM aba_users WHERE id=?", [userId]);
    if (userRows.length === 0 || userRows[0].role !== 'admin') {
      return res.status(403).json({ error: "Admin access required" });
    }
    const [rows]: any = await db.execute(`
      SELECT u.id, u.email, u.name, u.created_at, u.role,
        s.plan as plan, s.status as sub_status,
        d.status as deploy_status, d.public_ip, d.instance_id,
        a.agent_name, a.personality, a.telegram_bot_token
      FROM aba_users u
      LEFT JOIN (SELECT * FROM aba_subscriptions ORDER BY created_at DESC) s ON s.user_id = u.id
      LEFT JOIN aba_deployments d ON d.user_id = u.id
      LEFT JOIN aba_agent_configs a ON a.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);
    res.json(rows);
  } catch (err: any) {
    console.error("Admin users error:", err);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// ==================== KNOWLEDGE FILES ====================

const storage = multer.diskStorage({
  destination: (req: any, file: any, cb: any) => {
    const userId = (req as any).user?.userId || 'unknown';
    const dir = path.join(uploadDir, String(userId));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req: any, file: any, cb: any) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + '-' + file.originalname);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// Alias routes for frontend compatibility
app.get("/api/knowledge/list", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute("SELECT id, original_name, file_size, mime_type, created_at FROM aba_knowledge_files WHERE user_id=? ORDER BY created_at DESC", [userId]);
    res.json(rows);
  } catch { res.status(500).json({ error: "Failed" }); }
});

app.delete("/api/knowledge/:id", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute("SELECT file_path FROM aba_knowledge_files WHERE id=? AND user_id=?", [req.params.id, userId]);
    if (rows.length > 0 && rows[0].file_path) { try { fs.unlinkSync(rows[0].file_path); } catch {} }
    await db.execute("DELETE FROM aba_knowledge_files WHERE id=? AND user_id=?", [req.params.id, userId]);
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Delete failed" }); }
});

app.post("/api/knowledge/upload", authMiddleware, upload.array('files'), async (req: any, res) => {
  try {
    const { userId } = (req as any).user;
    const files = req.files || [];
    const saved: any[] = [];
    for (const f of files) {
      const result: any = await db.execute(
        "INSERT INTO aba_knowledge_files (user_id, original_name, stored_name, file_path, file_size, mime_type) VALUES (?, ?, ?, ?, ?, ?)",
        [userId, f.originalname, f.filename, f.path, f.size, f.mimetype]
      );
      saved.push({ id: result[0].insertId, original_name: f.originalname, file_size: f.size });
    }
    res.json({ success: true, files: saved });
  } catch (err: any) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

app.get("/api/knowledge/files", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute("SELECT id, original_name, file_size, mime_type, source, created_at FROM aba_knowledge_files WHERE user_id=? ORDER BY created_at DESC", [userId]);
    res.json(rows);
  } catch { res.status(500).json({ error: "Failed to fetch files" }); }
});

app.delete("/api/knowledge/files/:id", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute("SELECT file_path FROM aba_knowledge_files WHERE id=? AND user_id=?", [req.params.id, userId]);
    if (rows.length > 0 && rows[0].file_path) {
      try { fs.unlinkSync(rows[0].file_path); } catch {}
    }
    await db.execute("DELETE FROM aba_knowledge_files WHERE id=? AND user_id=?", [req.params.id, userId]);
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Failed to delete file" }); }
});

// ==================== IMAGE UPLOAD ====================

const uploadDir = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const imageUpload = multer({ dest: path.join(uploadDir, 'images'), limits: { fileSize: 5 * 1024 * 1024 } });
app.post("/api/upload/image", imageUpload.single('image'), async (req: any, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    res.json({ url: `/uploads/images/${req.file.filename}` });
  } catch { res.status(500).json({ error: "Upload failed" }); }
});

// ==================== SERVICE KEYS ====================

app.get("/api/service-keys", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute("SELECT id, service_name, key_type, credentials, is_active, created_at, updated_at FROM aba_service_keys WHERE user_id=? ORDER BY service_name", [userId]);
    res.json(rows.map((r: any) => ({ ...r, credentials: typeof r.credentials === 'string' ? JSON.parse(r.credentials) : r.credentials })));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post("/api/service-keys", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { service_name, key_type, credentials } = req.body;
    if (!service_name || !credentials) return res.status(400).json({ error: "service_name and credentials required" });
    await db.execute("INSERT INTO aba_service_keys (user_id, service_name, key_type, credentials) VALUES (?,?,?,?)",
      [userId, service_name, key_type || 'api_key', JSON.stringify(credentials)]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.put("/api/service-keys/:id", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { credentials, is_active } = req.body;
    const updates: string[] = [];
    const params: any[] = [];
    if (credentials !== undefined) { updates.push("credentials=?"); params.push(JSON.stringify(credentials)); }
    if (is_active !== undefined) { updates.push("is_active=?"); params.push(is_active ? 1 : 0); }
    if (updates.length === 0) return res.status(400).json({ error: "Nothing to update" });
    params.push(userId, req.params.id);
    await db.execute(`UPDATE aba_service_keys SET ${updates.join(',')} WHERE user_id=? AND id=?`, params);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/service-keys/:id", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    await db.execute("DELETE FROM aba_service_keys WHERE user_id=? AND id=?", [userId, req.params.id]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ==================== SOUL CUSTOM CONFIG ====================

app.get("/api/agent-config/soul", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute(`SELECT custom_greeting, custom_personality_text, timezone, nationality_vibe,
      custom_instructions, mo_document_path, mo_document_name FROM aba_agent_configs WHERE user_id=?`, [userId]);
    if (rows.length === 0) return res.json({});
    res.json(rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.put("/api/agent-config/soul", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { custom_greeting, custom_personality_text, timezone, nationality_vibe, custom_instructions } = req.body;
    await db.execute(`UPDATE aba_agent_configs SET
      custom_greeting=?, custom_personality_text=?, timezone=?, nationality_vibe=?, custom_instructions=?
      WHERE user_id=?`,
      [custom_greeting||null, custom_personality_text||null, timezone||'Africa/Lagos', nationality_vibe||'Global', custom_instructions||null, userId]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get("/api/team-agents/:id/soul", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute(`SELECT id, agent_name, role, custom_greeting, custom_personality_text,
      timezone, nationality_vibe, custom_instructions, mo_document_path, mo_document_name
      FROM aba_team_agents WHERE id=? AND user_id=?`, [req.params.id, userId]);
    if (rows.length === 0) return res.status(404).json({ error: "Team agent not found" });
    res.json(rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.put("/api/team-agents/:id/soul", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { custom_greeting, custom_personality_text, timezone, nationality_vibe, custom_instructions } = req.body;
    await db.execute(`UPDATE aba_team_agents SET
      custom_greeting=?, custom_personality_text=?, timezone=?, nationality_vibe=?, custom_instructions=?
      WHERE id=? AND user_id=?`,
      [custom_greeting||null, custom_personality_text||null, timezone||'Africa/Lagos', nationality_vibe||'Global', custom_instructions||null, req.params.id, userId]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ==================== MO DOCUMENT UPLOAD ====================

app.post("/api/agent-config/upload-mo", authMiddleware, upload.single('file'), async (req: any, res) => {
  try {
    const { userId } = (req as any).user;
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    await db.execute("UPDATE aba_agent_configs SET mo_document_path=?, mo_document_name=? WHERE user_id=?",
      [req.file.path, req.file.originalname, userId]);
    res.json({ success: true, path: req.file.path, name: req.file.originalname });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post("/api/team-agents/:id/upload-mo", authMiddleware, upload.single('file'), async (req: any, res) => {
  try {
    const { userId } = (req as any).user;
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    await db.execute("UPDATE aba_team_agents SET mo_document_path=?, mo_document_name=? WHERE id=? AND user_id=?",
      [req.file.path, req.file.originalname, req.params.id, userId]);
    res.json({ success: true, path: req.file.path, name: req.file.originalname });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ==================== BUILD & UPDATE (agent-sync queue) ====================

app.post("/api/build-and-update", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    // Gather all config for this user
    const [userRows]: any = await db.execute("SELECT id, email, name FROM aba_users WHERE id=?", [userId]);
    if (userRows.length === 0) return res.status(404).json({ error: "User not found" });
    const [cfgRows]: any = await db.execute("SELECT * FROM aba_agent_configs WHERE user_id=?", [userId]);
    const [skRows]: any = await db.execute("SELECT service_name, credentials FROM aba_service_keys WHERE user_id=? AND is_active=1", [userId]);
    const [depRows]: any = await db.execute("SELECT owner_chat_id, owner_name FROM aba_deployments WHERE user_id=? ORDER BY id DESC LIMIT 1", [userId]);

    const cfg = cfgRows[0] || {};
    const owner = depRows[0] || {};

    // Build env vars
    const env: Record<string, string> = {};
    if (cfg.email_pop_host) env.EMAIL_HOST = cfg.email_pop_host;
    if (cfg.email_pop_port) env.EMAIL_PORT = String(cfg.email_pop_port);
    if (cfg.email_pop_user) env.EMAIL_USER = cfg.email_pop_user;
    if (cfg.email_pop_pass) env.EMAIL_PASS = cfg.email_pop_pass;
    if (cfg.woo_url) env.WOO_URL = cfg.woo_url;
    if (cfg.woo_key) env.WOO_KEY = cfg.woo_key;
    if (cfg.woo_secret) env.WOO_SECRET = cfg.woo_secret;
    if (cfg.shopify_url) env.SHOPIFY_URL = cfg.shopify_url;
    if (cfg.shopify_api_key) env.SHOPIFY_API_KEY = cfg.shopify_api_key;
    if (cfg.shopify_api_secret) env.SHOPIFY_API_SECRET = cfg.shopify_api_secret;
    if (cfg.shopify_access_token) env.SHOPIFY_ACCESS_TOKEN = cfg.shopify_access_token;
    if (cfg.db_connection_string) env.DB_CONNECTION_STRING = cfg.db_connection_string;
    if (cfg.sh_store_id) env.SH_STORE_ID = cfg.sh_store_id;

    // Build service keys map
    const serviceKeys: Record<string, any> = {};
    for (const sk of skRows) {
      serviceKeys[sk.service_name] = typeof sk.credentials === 'string' ? JSON.parse(sk.credentials) : sk.credentials;
    }

    // Build soul config
    const soulConfig: Record<string, any> = {
      greeting: cfg.custom_greeting || '',
      personality: cfg.custom_personality_text || cfg.personality || 'Professional',
      timezone: cfg.timezone || 'Africa/Lagos',
      nationality_vibe: cfg.nationality_vibe || 'Global',
      custom_instructions: cfg.custom_instructions || '',
    };

    // MO document content
    if (cfg.mo_document_path && fs.existsSync(cfg.mo_document_path)) {
      try {
        soulConfig.mo_document = fs.readFileSync(cfg.mo_document_path, 'utf8');
      } catch {}
    }

    // Team agents config
    const [teamRows]: any = await db.execute(`SELECT id, agent_name, role, telegram_bot_token, telegram_bot_username,
      custom_greeting, custom_personality_text, timezone, nationality_vibe, custom_instructions, mo_document_path, mo_document_name
      FROM aba_team_agents WHERE user_id=? AND status='active'`, [userId]);
    const teamAgents: any[] = [];
    for (const ta of teamRows) {
      const taSoul: any = {
        greeting: ta.custom_greeting || '',
        personality: ta.custom_personality_text || ta.role || 'Professional',
        timezone: ta.timezone || 'Africa/Lagos',
        nationality_vibe: ta.nationality_vibe || 'Global',
        custom_instructions: ta.custom_instructions || '',
      };
      if (ta.mo_document_path && fs.existsSync(ta.mo_document_path)) {
        try { taSoul.mo_document = fs.readFileSync(ta.mo_document_path, 'utf8'); } catch {}
      }
      teamAgents.push({
        id: ta.id, name: ta.agent_name, role: ta.role,
        bot_token: ta.telegram_bot_token, bot_username: ta.telegram_bot_username,
        soul: taSoul,
      });
    }

    const payload: any = {
      env, service_keys: serviceKeys, soul: soulConfig, team_agents: teamAgents,
      owner: {
        telegram_id: owner.owner_chat_id || null,
        name: owner.owner_name || userRows[0].name || userRows[0].email,
        email: userRows[0].email,
      },
      queued_at: new Date().toISOString(),
    };

    await db.execute("UPDATE aba_deployments SET pending_build_at=NOW(), build_payload=? WHERE user_id=? ORDER BY id DESC LIMIT 1",
      [JSON.stringify(payload), userId]);

    res.json({ success: true, queued: true, message: "Updates queued — will sync within 5 minutes." });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post("/api/build-and-update/cancel", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    await db.execute("UPDATE aba_deployments SET pending_build_at=NULL, build_payload=NULL WHERE user_id=? ORDER BY id DESC LIMIT 1", [userId]);
    res.json({ success: true, message: "Cancelled." });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get("/api/build-and-update/status", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute("SELECT pending_build_at FROM aba_deployments WHERE user_id=? AND pending_build_at IS NOT NULL ORDER BY id DESC LIMIT 1", [userId]);
    res.json({ hasPending: rows.length > 0, queuedAt: rows[0]?.pending_build_at || null });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ==================== AGENT UPLOAD (for agent sync) ====================

const agentUpload = multer({ dest: path.join(uploadDir, 'agent'), limits: { fileSize: 50 * 1024 * 1024 } });
app.post("/api/agent-upload", agentUpload.single('file'), async (req: any, res) => {
  try {
    const token = req.query.token || req.body.token;
    if (token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: "Invalid token" });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const newPath = path.join(path.dirname(req.file.path), req.file.originalname);
    fs.renameSync(req.file.path, newPath);
    res.json({ success: true, url: `/uploads/agent/${req.file.originalname}` });
  } catch { res.status(500).json({ error: "Upload failed" }); }
});

// ==================== AGENT SYNC ====================

app.get("/api/agent-sync", async (req, res) => {
  try {
    const token = req.query.token as string;
    if (token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: "Invalid token" });
    const userId = req.query.user_id as string;

    // Knowledge files
    const configDir = path.resolve(__dirname, '..', 'agent-config');
    const files: any[] = [];
    if (fs.existsSync(configDir)) {
      for (const f of fs.readdirSync(configDir)) {
        const stats = fs.statSync(path.join(configDir, f));
        if (stats.isFile()) {
          files.push({ name: f, size: stats.size, updatedAt: stats.mtime.toISOString() });
        }
      }
    }

    let buildPayload: any = null;
    let ownerInfo: any = null;

    if (userId) {
      // Check for pending build payload
      const [depRows]: any = await db.execute(
        "SELECT build_payload, owner_chat_id, owner_name FROM aba_deployments WHERE user_id=? AND build_payload IS NOT NULL ORDER BY id DESC LIMIT 1",
        [userId]
      );
      if (depRows.length > 0 && depRows[0].build_payload) {
        try {
          buildPayload = JSON.parse(depRows[0].build_payload);
        } catch {}
      }

      // Always return owner info if bound
      if (depRows.length > 0 && depRows[0].owner_chat_id) {
        ownerInfo = {
          telegram_id: depRows[0].owner_chat_id,
          name: depRows[0].owner_name || 'Owner',
        };
      }

      // User-specific knowledge files
      const userDir = path.join(uploadDir, String(userId));
      const userFiles: any[] = [];
      if (fs.existsSync(userDir)) {
        for (const f of fs.readdirSync(userDir)) {
          const stats = fs.statSync(path.join(userDir, f));
          if (stats.isFile()) {
            userFiles.push({ name: f, size: stats.size, updatedAt: stats.mtime.toISOString(), url: `/uploads/${userId}/${f}` });
          }
        }
      }
    }

    const response: any = { config: {}, knowledgeFiles: files };
    if (buildPayload) {
      response.build = buildPayload;
    }
    if (ownerInfo) {
      response.owner = ownerInfo;
    }
    if (userId) {
      response.userFiles = files; // placeholder for per-user knowledge

      // Include business details + user info so agents stay up to date
      try {
        const [bizRows]: any = await db.execute("SELECT * FROM aba_businesses WHERE user_id = ?", [userId]);
        if (bizRows.length > 0) {
          response.business = bizRows[0];
        }
      } catch {}

      try {
        const [usrRows]: any = await db.execute("SELECT name, email FROM aba_users WHERE id = ?", [userId]);
        if (usrRows.length > 0) {
          response.owner_profile = { name: usrRows[0].name, email: usrRows[0].email };
        }
      } catch {}

      // Include tool/integration config so live agents stay up to date
      try {
        const [cfgRows]: any = await db.execute(
          "SELECT integrations, whatsapp_number, whatsapp_open_dm, " +
          "email_pop_host, email_pop_user, " +
          "twilio_sid, twilio_phone, " +
          "github_token, " +
          "woo_url, woo_key, woo_secret, " +
          "shopify_url, shopify_access_token, " +
          "db_connection_string, google_drive_folder " +
          "FROM aba_agent_configs WHERE user_id = ?",
          [userId]);
        if (cfgRows.length > 0) {
          const cfg = cfgRows[0];
          // Parse integrations JSON
          let integratedTools: string[] = [];
          try { integratedTools = JSON.parse(cfg.integrations || "[]"); } catch {}
          response.tool_config = {
            integrations: integratedTools,
            whatsapp: cfg.whatsapp_number ? { number: cfg.whatsapp_number, open_dm: !!cfg.whatsapp_open_dm } : null,
            email: cfg.email_pop_host ? { host: cfg.email_pop_host, user: cfg.email_pop_user } : null,
            twilio: cfg.twilio_sid ? { sid: cfg.twilio_sid.slice(0, 8) + "...", phone: cfg.twilio_phone } : null,
            github: cfg.github_token ? { has_token: true } : null,
            woo: cfg.woo_url ? { url: cfg.woo_url } : null,
            shopify: cfg.shopify_url ? { url: cfg.shopify_url } : null,
            database: cfg.db_connection_string ? { configured: true } : null,
            google_drive: cfg.google_drive_folder ? { folder: cfg.google_drive_folder } : null,
          };
        }
      } catch {}

      // Include products so agents stay up to date
      try {
        const [prodRows]: any = await db.execute("SELECT * FROM aba_products WHERE user_id = ?", [userId]);
        response.products = prodRows || [];
      } catch {}
    }

    res.json(response);
  } catch { res.status(500).json({ error: "Sync failed" }); }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ABA API server running on port ${PORT}`);
});
