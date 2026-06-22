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
import { execSync, exec, spawn as _spawnTeam, spawn } from "child_process";
import { fileURLToPath } from "url";
import { OAuth2Client } from "google-auth-library";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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

  // Add missing columns individually to aba_agent_configs
  for (const col of ['custom_greeting','custom_personality_text','timezone','nationality_vibe','custom_instructions','mo_document_path','mo_document_name','sh_store_id','shopify_url','shopify_api_key','shopify_api_secret','shopify_access_token']) {
    try {
      const [found]: any = await db.execute("SHOW COLUMNS FROM aba_agent_configs LIKE ?", [col]);
      if (found.length === 0) {
        const colType: Record<string,string> = {
          custom_greeting: 'TEXT',
          custom_personality_text: 'TEXT',
          timezone: "VARCHAR(64) DEFAULT 'Africa/Lagos'",
          nationality_vibe: "VARCHAR(64) DEFAULT 'Global'",
          custom_instructions: 'TEXT',
          mo_document_path: 'VARCHAR(255)',
          mo_document_name: 'VARCHAR(255)',
          sh_store_id: 'VARCHAR(64)',
          shopify_url: 'VARCHAR(255)',
          shopify_api_key: 'VARCHAR(255)',
          shopify_api_secret: 'VARCHAR(255)',
          shopify_access_token: 'VARCHAR(255)'
        };
        await db.execute(`ALTER TABLE aba_agent_configs ADD COLUMN \`${col}\` ${colType[col] || 'TEXT'}`);
        console.log(`  ✅ aba_agent_configs.\`${col}\` added`);
      }
    } catch(e: any) { console.log(`  ⚠️ agent_configs.\`${col}\` migration:`, e.message); }
  }

  // Add missing columns individually so earlier migrations don't block later ones
  for (const col of ['custom_greeting','custom_personality_text','timezone','nationality_vibe','custom_instructions','mo_document_path','mo_document_name']) {
    try {
      const [found]: any = await db.execute("SHOW COLUMNS FROM aba_team_agents LIKE ?", [col]);
      if (found.length === 0) {
        const colType: Record<string,string> = {
          custom_greeting: 'TEXT',
          custom_personality_text: 'TEXT',
          timezone: "VARCHAR(64) DEFAULT 'Africa/Lagos'",
          nationality_vibe: "VARCHAR(64) DEFAULT 'Global'",
          custom_instructions: 'TEXT',
          mo_document_path: 'VARCHAR(255)',
          mo_document_name: 'VARCHAR(255)'
        };
        await db.execute(`ALTER TABLE aba_team_agents ADD COLUMN \`${col}\` ${colType[col] || 'TEXT'}`);
        console.log(`  ✅ aba_team_agents.\`${col}\` added`);
      }
    } catch(e: any) { console.log(`  ⚠️ team_agents.\`${col}\` migration:`, e.message); }
  }

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
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS aba_bank_accounts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      country VARCHAR(64) NOT NULL,
      bank_name VARCHAR(128) NOT NULL,
      account_number VARCHAR(64) NOT NULL,
      routing_number VARCHAR(64) DEFAULT NULL,
      account_name VARCHAR(255) NOT NULL,
      is_primary BOOLEAN DEFAULT FALSE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
    console.log("  ✅ aba_bank_accounts table ready");
  try {
    await db.execute("ALTER TABLE aba_businesses ADD COLUMN primary_currency VARCHAR(8) DEFAULT 'USD'");
    console.log("  ✅ aba_businesses.primary_currency added");
  } catch(e: any) { console.log("  ⚠️ businesses.primary_currency:", e.message); }
  try {
    await db.execute("ALTER TABLE aba_bank_accounts ADD COLUMN currency VARCHAR(8) DEFAULT 'USD'");
    console.log("  ✅ aba_bank_accounts.currency added");
  } catch(e: any) { console.log("  ⚠️ bank_accounts.currency:", e.message); }

  } catch(e: any) { console.log("  ⚠️ bank accounts table:", e.message); }

  // ===== Custom Databases Migration =====
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS aba_custom_databases (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      name VARCHAR(255) DEFAULT '',
      db_type VARCHAR(16) DEFAULT 'mysql',
      db_host VARCHAR(255) DEFAULT '',
      db_port INT DEFAULT 3306,
      db_name VARCHAR(255) DEFAULT '',
      db_user VARCHAR(255) DEFAULT '',
      db_pass VARCHAR(255) DEFAULT '',
      connection_string TEXT,
      is_primary BOOLEAN DEFAULT FALSE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
    console.log("  ✅ aba_custom_databases table ready");
  } catch(e: any) { console.log("  ⚠️ aba_custom_databases:", e.message); }

  // ===== Email Sources Migration =====
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS aba_email_sources (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      name VARCHAR(255) DEFAULT '',
      email_address VARCHAR(255) DEFAULT '',
      pop_host VARCHAR(255) DEFAULT '',
      pop_port INT DEFAULT 993,
      pop_user VARCHAR(255) DEFAULT '',
      pop_pass VARCHAR(255) DEFAULT '',
      instruction TEXT,
      is_primary BOOLEAN DEFAULT FALSE,
      enabled BOOLEAN DEFAULT TRUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
    console.log("  ✅ aba_email_sources table ready");
  } catch(e: any) { console.log("  ⚠️ aba_email_sources:", e.message); }

  // ===== Ecommerce Stores Migration =====
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS aba_ecommerce_stores (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      name VARCHAR(255) DEFAULT '',
      store_type VARCHAR(32) DEFAULT 'woocommerce',
      url VARCHAR(255) DEFAULT '',
      api_key VARCHAR(255) DEFAULT '',
      api_secret VARCHAR(255) DEFAULT '',
      access_token VARCHAR(255) DEFAULT '',
      is_primary BOOLEAN DEFAULT FALSE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
    console.log("  ✅ aba_ecommerce_stores table ready");
  } catch(e: any) { console.log("  ⚠️ aba_ecommerce_stores:", e.message); }
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
        const isUpgrade = session.metadata?.is_upgrade === 'true';
        let userId: number | null = null;

        // For upgrades, we have user_id in metadata
        if (isUpgrade && session.metadata?.user_id) {
          userId = parseInt(session.metadata.user_id);
        }

        if (!userId && email) {
          const [rows]: any = await db.execute("SELECT id FROM aba_users WHERE email=?", [email]);
          if (rows.length > 0) userId = rows[0].id;
        }

        if (userId) {
          // Insert new subscription record
          await db.execute(
            "INSERT INTO aba_subscriptions (user_id, plan, status, stripe_subscription_id, current_period_start, current_period_end) VALUES (?, ?, 'active', ?, NOW(), DATE_ADD(NOW(), INTERVAL 1 MONTH))",
            [userId, session.metadata?.plan || "entry", session.subscription || ""]
          );
          // Link Stripe customer
          if (session.customer) {
            await db.execute("UPDATE aba_users SET stripe_customer_id=? WHERE id=?", [session.customer, userId]);
          }

          // If upgrade: decommission old spot instance + re-queue deployment
          if (isUpgrade) {
            console.log(`Upgrade detected for user ${userId} — beginning migration...`);
            try {
              // 1. Find and terminate old EC2 spot instance
              const [depRows]: any = await db.execute(
                "SELECT id, instance_id FROM aba_deployments WHERE user_id=? AND status IN ('active','provisioning','failed')", [userId]
              );
              if (depRows.length > 0) {
                const dep = depRows[0];
                if (dep.instance_id) {
                  try {
                    execSync(`aws ec2 terminate-instances --instance-ids ${dep.instance_id} --region us-east-1`, { timeout: 15000, stdio: 'pipe' });
                    console.log(`Terminated old spot instance ${dep.instance_id} for user ${userId}`);
                  } catch (e: any) {
                    console.error(`Failed to terminate instance ${dep.instance_id}:`, e.message);
                  }
                }
                // 2. Re-queue deployment as pending (orchestrator will pick up with on-demand)
                const bindCode = require('crypto').randomBytes(4).toString('hex');
                await db.execute(
                  "UPDATE aba_deployments SET status='pending', instance_id=NULL, public_ip=NULL, admin_token=NULL, error_message=NULL, deploy_id=NULL, telegram_bot_username=NULL, last_health_check=NULL, deployed_at=NULL, bind_code=? WHERE id=?",
                  [bindCode, dep.id]
                );
                console.log(`Re-queued deployment #${dep.id} for user ${userId} — orchestrator will provision on-demand`);
              }
            } catch (migrateErr: any) {
              console.error("Migration error:", migrateErr.message);
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
      "INSERT INTO aba_subscriptions (user_id, plan, status) VALUES (?, 'trial', 'active')",
      [userId]
    );
    // Set 14-day trial expiry in user metadata or a separate expiry field
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
      await db.execute("INSERT INTO aba_subscriptions (user_id, plan, status) VALUES (?, 'trial', 'active')", [userId]);
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
    res.json(rows.length > 0 ? rows[0] : { business_name: "", primary_currency: "USD" });
  } catch { res.status(500).json({ error: "Failed to fetch business" }); }
});

app.put("/api/business", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { business_name, description, industry, registration_id, tax_id, phone, website, address, logo_url, social_facebook, social_twitter, social_linkedin, social_instagram, primary_currency } = req.body;
    // Basic validation: phone should look like a phone number
    if (phone && phone.trim()) {
      // Allow digits, +, -, (, ), spaces, . , x , ext
      const cleanedPhone = phone.replace(/[\s\-\(\)\.\,\+extEXT]/g, '');
      if (cleanedPhone.length > 0 && !/^\d+$/.test(cleanedPhone)) {
        return res.status(400).json({ error: "Phone number contains invalid characters. Use digits, +, -, (, ), and spaces only." });
      }
      if (cleanedPhone.length > 0 && cleanedPhone.length < 6) {
        return res.status(400).json({ error: "Phone number is too short. Enter a valid phone number." });
      }
    }
    // Basic validation: website URL
    if (website && website.trim()) {
      try { new URL(website); } catch {
        return res.status(400).json({ error: "Website URL is not valid. Enter a full URL like https://yourbusiness.com" });
      }
    }
    const [existing]: any = await db.execute("SELECT id FROM aba_businesses WHERE user_id = ?", [userId]);
    if (existing.length > 0) {
      await db.execute(
        "UPDATE aba_businesses SET business_name=?, description=?, industry=?, registration_id=?, tax_id=?, phone=?, website=?, address=?, logo_url=?, social_facebook=?, social_twitter=?, social_linkedin=?, social_instagram=?, primary_currency=? WHERE user_id=?",
        [business_name, description, industry, registration_id || '', tax_id || '', phone, website, address, logo_url, social_facebook || '', social_twitter || '', social_linkedin || '', social_instagram || '', primary_currency || 'USD', userId]
      );
    } else {
      await db.execute(
        "INSERT INTO aba_businesses (user_id, business_name, description, industry, registration_id, tax_id, phone, website, address, logo_url, social_facebook, social_twitter, social_linkedin, social_instagram, primary_currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [userId, business_name, description, industry, registration_id || '', tax_id || '', phone, website, address, logo_url, social_facebook || '', social_twitter || '', social_linkedin || '', social_instagram || '', primary_currency || 'USD']
      );
    }
    const [rows]: any = await db.execute("SELECT * FROM aba_businesses WHERE user_id = ?", [userId]);
    res.json(rows[0]);
  } catch(e: any) {
    console.error("PUT /api/business error:", e?.message || e);
    res.status(500).json({ error: e?.message || "Failed to update business. Please try again." });
  }
});

// ==================== PRODUCTS ====================

app.get("/api/products", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute("SELECT * FROM aba_products WHERE user_id = ? ORDER BY created_at DESC", [userId]);
    // Resolve S3 keys to presigned URLs
    for (const row of rows) {
      row.image = row.image || null;
      if (row.image_s3_key && !row.image?.startsWith('http')) {
        row.image = await getPresignedUrl(row.image_s3_key, 86400);
      }
    }
    res.json(rows);
  } catch { res.status(500).json({ error: "Failed to fetch products" }); }
});

app.post("/api/products", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { name, description, price, category, image } = req.body;
    const s3Key = image && !image.startsWith('/uploads/') ? image : null;
    const result: any = await db.execute(
      "INSERT INTO aba_products (user_id, name, description, price, category, image, image_s3_key) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [userId, name, description, price, category, s3Key || image || null, s3Key]
    );
    const [rows]: any = await db.execute("SELECT * FROM aba_products WHERE id = ?", [result[0].insertId]);
    if (rows[0].image_s3_key) rows[0].image = await getPresignedUrl(rows[0].image_s3_key, 86400);
    res.json(rows[0]);
  } catch { res.status(500).json({ error: "Failed to create product" }); }
});

app.put("/api/products/:id", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { name, description, price, category, image } = req.body;
    const s3Key = image && !image.startsWith('/uploads/') ? image : null;
    await db.execute("UPDATE aba_products SET name=?, description=?, price=?, category=?, image=?, image_s3_key=? WHERE id=? AND user_id=?",
      [name, description, price, category, s3Key || image || null, s3Key, req.params.id, userId]);
    const [rows]: any = await db.execute("SELECT * FROM aba_products WHERE id = ?", [req.params.id]);
    if (rows[0].image_s3_key) rows[0].image = await getPresignedUrl(rows[0].image_s3_key, 86400);
    res.json(rows[0]);
  } catch { res.status(500).json({ error: "Failed to update product" }); }
});

app.delete("/api/products/:id", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    // Get S3 key before deleting so we can clean up
    const [existing]: any = await db.execute("SELECT image_s3_key FROM aba_products WHERE id=? AND user_id=?", [req.params.id, userId]);
    if (existing.length > 0 && existing[0].image_s3_key) {
      try {
        await s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: existing[0].image_s3_key }));
      } catch {}
      await db.execute("DELETE FROM aba_storage_usage WHERE user_id=? AND s3_key=?", [userId, existing[0].image_s3_key]);
    }
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
    const { agent_name, gender, role, personality, telegram_bot_token, bot_name, welcome_message,
      whatsapp_number, whatsapp_open_dm, email_pop_host, email_pop_port, email_pop_user, email_pop_pass,
      twilio_sid, twilio_auth_token, twilio_phone, github_token, woo_url, woo_key, woo_secret,
      shopify_url, shopify_api_key, shopify_password, shopify_api_secret, shopify_access_token,
      db_connection_string, sh_store_id, google_drive_folder, knowledge_sources, integrations,
      timezone, nationality_vibe } = req.body;

    // mysql2 rejects `undefined` — coalesce any missing field to null
    const nz = (v: any) => (v === undefined ? null : v);

    // Ping the DB pool to ensure connection is alive before deploying
    try { await db.query("SELECT 1"); } catch { /* pool handles reconnect */ }

    const [existing]: any = await db.execute("SELECT id FROM aba_agent_configs WHERE user_id = ?", [userId]);
    if (existing.length > 0) {
      await db.execute(`UPDATE aba_agent_configs SET
        agent_name=?, gender=?, role=?, personality=?, telegram_bot_token=?, bot_name=?, welcome_message=?,
        whatsapp_number=?, whatsapp_open_dm=?, email_pop_host=?, email_pop_port=?, email_pop_user=?, email_pop_pass=?,
        twilio_sid=?, twilio_auth_token=?, twilio_phone=?, github_token=?, woo_url=?, woo_key=?, woo_secret=?,
        shopify_url=?, shopify_api_key=?, shopify_password=?, shopify_api_secret=?, shopify_access_token=?,
        db_connection_string=?, sh_store_id=?, google_drive_folder=?, knowledge_sources=?, integrations=?,
        timezone=?, nationality_vibe=?
        WHERE user_id=?`,
        [nz(agent_name), nz(gender), nz(role) || 'General Assistant', nz(personality), nz(telegram_bot_token), bot_name || '', welcome_message || '',
        nz(whatsapp_number), whatsapp_open_dm ?? 1, nz(email_pop_host), email_pop_port ?? 993, nz(email_pop_user), nz(email_pop_pass),
        nz(twilio_sid), nz(twilio_auth_token), nz(twilio_phone), nz(github_token), nz(woo_url), nz(woo_key), nz(woo_secret),
        nz(shopify_url), nz(shopify_api_key), nz(shopify_password), nz(shopify_api_secret), nz(shopify_access_token),
        nz(db_connection_string), nz(sh_store_id), nz(google_drive_folder), knowledge_sources ? JSON.stringify(knowledge_sources) : null,
        integrations ? JSON.stringify(integrations) : null, timezone || null, nationality_vibe || null, userId]
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

    // Fire-and-forget: push profile updates to the live EC2 agent
    if (rows.length > 0) {
      const adminApplyScript = "/root/.openclaw/workspace/scripts/aba-admin-apply.py";
      const child = spawn("python3", [adminApplyScript, String(userId), "--soul-only"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    }

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
      "SELECT id, agent_name, gender, role, agent_slug, personality, telegram_bot_token, bot_name, welcome_message, status, telegram_bot_username, whatsapp_number, wa_paired, error_message, applied_at, created_at, custom_instructions FROM aba_team_agents WHERE user_id = ? ORDER BY created_at ASC",
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
    const { agent_name, gender, role, personality, telegram_bot_token, bot_name, welcome_message, whatsapp_number, custom_instructions, agent_slug } = req.body;

    if (!agent_name) return res.status(400).json({ error: "Agent name required" });
    // Channels are linked post-creation from the Manage page — not required at creation time

    const result = await db.execute(
      `INSERT INTO aba_team_agents (user_id, agent_name, gender, role, agent_slug, personality, telegram_bot_token, bot_name, welcome_message, whatsapp_number, custom_instructions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, agent_name, gender || 'Female', role || null, agent_slug || null, personality || 'Professional', telegram_bot_token || null, bot_name || '', welcome_message || '', whatsapp_number || null, custom_instructions || null]
    );

    res.json({ success: true, id: (result as any)[0]?.insertId });
  } catch (err: any) {
    console.error("Create team agent error:", err);
    res.status(500).json({ error: "Failed to create team agent" });
  }
});

// Update a team agent
app.put("/api/team-agents/:id", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { agent_name, gender, role, personality, telegram_bot_token, bot_name, welcome_message, whatsapp_number, custom_instructions, agent_slug } = req.body;
    const result = await db.execute(
      `UPDATE aba_team_agents SET agent_name=?, gender=?, role=?, agent_slug=?, personality=?, telegram_bot_token=?, bot_name=?, welcome_message=?, whatsapp_number=?, custom_instructions=? WHERE id=? AND user_id=?`,
      [agent_name, gender || 'Female', role || null, agent_slug || null, personality || 'Professional', telegram_bot_token || null, bot_name || '', welcome_message || '', whatsapp_number || null, custom_instructions || null, req.params.id, userId]
    );
    if ((result as any)[0]?.affectedRows === 0) return res.status(404).json({ error: "Team agent not found" });
    res.json({ success: true });
  } catch (err: any) {
    console.error("Update team agent error:", err);
    res.status(500).json({ error: "Failed to update team agent" });
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
const TEAM_APPLY_SCRIPT = "/opt/aba-backend/aba-team-apply.py";

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

    // Mark applying (only non-active agents)
    await db.execute("UPDATE aba_team_agents SET status='applying', error_message=NULL WHERE user_id = ? AND (status IS NULL OR status='draft' OR status='failed')", [userId]);

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

// ==================== AGENT TEMPLATES (Roles / Marketplace) ====================

app.get("/api/agent-templates", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [userRows]: any = await db.execute("SELECT selected_template FROM aba_users WHERE id = ?", [userId]);
    const activeSlug = userRows[0]?.selected_template || null;
    // Return own templates + global templates, exclude system admin
    const [rows]: any = await db.execute("SELECT * FROM aba_agent_templates WHERE (is_global=1 OR user_id=?) AND is_system_admin=0 ORDER BY is_global DESC, id ASC", [userId]);
    for (const r of rows) {
      if (typeof r.traits === "string") r.traits = JSON.parse(r.traits || "{}");
      r.is_active = r.slug === activeSlug ? 1 : 0;
      r.is_owner = parseInt(r.user_id) === parseInt(userId) ? 1 : 0;
    }
    res.json(rows);
  } catch { res.status(500).json({ error: "Failed to fetch templates" }); }
});

app.post("/api/agent-templates/clone/:templateId", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [templates]: any = await db.execute("SELECT * FROM aba_agent_templates WHERE id = ?", [req.params.templateId]);
    if (templates.length === 0) return res.status(404).json({ error: "Template not found" });
    const src = templates[0];
    // If it's a paid marketplace template, check purchase
    if (parseFloat(src.price) > 0) {
      const [purchases]: any = await db.execute("SELECT id FROM aba_marketplace_purchases WHERE buyer_user_id=? AND template_id=? AND status='completed'", [userId, req.params.templateId]);
      if (purchases.length === 0 && parseInt(src.user_id) !== parseInt(userId)) {
        return res.status(402).json({ error: "Purchase required", needs_purchase: true, price: src.price });
      }
    }
    const slug = (src.name + '-' + userId + '-' + Date.now()).toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const [result]: any = await db.execute(
      `INSERT INTO aba_agent_templates (name, slug, gender, personality, role, description, instructions, welcome_message, is_global, user_id, avatar_url, mo_content, tk_content, oi_content, ra_content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      [src.name + ' (clone)', slug, src.gender, src.personality, src.role, src.description, src.instructions, src.welcome_message || null, userId, src.avatar_url || null, src.mo_content || null, src.tk_content || null, src.oi_content || null, src.ra_content || null]
    );
    const [rows]: any = await db.execute("SELECT * FROM aba_agent_templates WHERE id = ?", [result.insertId]);
    if (rows[0]?.traits && typeof rows[0].traits === "string") rows[0].traits = JSON.parse(rows[0].traits || "{}");
    res.json(rows[0]);
  } catch { res.status(500).json({ error: "Failed to clone template" }); }
});

// Full page role designer — create with MO/TK/OI/RA blocks
app.post("/api/agent-templates", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { name, gender, personality, role, description, instructions, welcome_message, avatar_url, mo_content, tk_content, oi_content, ra_content, traits } = req.body;
    if (!name) return res.status(400).json({ error: "Name is required" });
    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Date.now();
    const [result]: any = await db.execute(
      `INSERT INTO aba_agent_templates (name, slug, gender, personality, role, description, instructions, welcome_message, is_global, user_id, avatar_url, mo_content, tk_content, oi_content, ra_content, traits)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
      [name, slug, gender || 'neutral', personality || 'Friendly', role || 'General Assistant', description || null, instructions || null, welcome_message || null, userId, avatar_url || null, mo_content || null, tk_content || null, oi_content || null, ra_content || null, traits ? JSON.stringify(traits) : null]
    );
    const [rows]: any = await db.execute("SELECT * FROM aba_agent_templates WHERE id = ?", [result.insertId]);
    if (rows[0]?.traits && typeof rows[0].traits === "string") rows[0].traits = JSON.parse(rows[0].traits || "{}");
    res.json(rows[0]);
  } catch { res.status(500).json({ error: "Failed to create template" }); }
});

// Update template (with MO/TK/OI/RA)
app.put("/api/agent-templates/:id", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { name, gender, personality, role, description, instructions, welcome_message, avatar_url, mo_content, tk_content, oi_content, ra_content, traits } = req.body;
    const [existing]: any = await db.execute("SELECT * FROM aba_agent_templates WHERE id = ?", [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: "Template not found" });
    const t = existing[0];
    if (parseInt(t.is_global)) return res.status(403).json({ error: "Cannot edit system templates" });
    if (parseInt(t.user_id) !== parseInt(userId)) return res.status(403).json({ error: "Not your template" });
    await db.execute(
      `UPDATE aba_agent_templates SET name=?, gender=?, personality=?, role=?, description=?, instructions=?, welcome_message=?, avatar_url=?, mo_content=?, tk_content=?, oi_content=?, ra_content=?, traits=? WHERE id=?`,
      [name || t.name, gender || t.gender, personality || t.personality, role || t.role,
       description !== undefined ? description : t.description, instructions !== undefined ? instructions : t.instructions,
       welcome_message !== undefined ? welcome_message : t.welcome_message, avatar_url !== undefined ? avatar_url : t.avatar_url,
       mo_content !== undefined ? mo_content : t.mo_content, tk_content !== undefined ? tk_content : t.tk_content,
       oi_content !== undefined ? oi_content : t.oi_content, ra_content !== undefined ? ra_content : t.ra_content,
       traits ? JSON.stringify(traits) : (typeof t.traits === 'string' ? t.traits : JSON.stringify(t.traits || {})),
       req.params.id]
    );
    const [rows]: any = await db.execute("SELECT * FROM aba_agent_templates WHERE id = ?", [req.params.id]);
    if (rows[0]?.traits && typeof rows[0].traits === "string") rows[0].traits = JSON.parse(rows[0].traits || "{}");
    res.json(rows[0]);
  } catch { res.status(500).json({ error: "Failed to update template" }); }
});

app.delete("/api/agent-templates/:id", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [existing]: any = await db.execute("SELECT * FROM aba_agent_templates WHERE id = ?", [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: "Template not found" });
    const t = existing[0];
    if (parseInt(t.is_global)) return res.status(403).json({ error: "Cannot delete system templates" });
    if (parseInt(t.user_id) !== parseInt(userId)) return res.status(403).json({ error: "Not your template" });
    // If published, unpublish first
    await db.execute("DELETE FROM aba_marketplace_purchases WHERE template_id=?", [req.params.id]);
    await db.execute("DELETE FROM aba_agent_templates WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Failed to delete template" }); }
});

// ==================== MARKETPLACE (public) ====================

// Public listing — no auth
app.get("/api/marketplace/roles", async (req, res) => {
  try {
    const [rows]: any = await db.execute(
      `SELECT t.id, t.name, t.slug, t.gender, t.personality, t.role, t.description, t.welcome_message,
              t.price, t.avatar_url, t.purchased_count, t.traits, t.created_at,
              t.user_id, u.name AS author_name, u.email AS author_email
       FROM aba_agent_templates t
       LEFT JOIN aba_users u ON u.id = t.user_id
       WHERE t.is_published = 1 AND t.is_system_admin = 0
       ORDER BY t.purchased_count DESC, t.created_at DESC`
    );
    for (const r of rows) {
      if (typeof r.traits === "string") r.traits = JSON.parse(r.traits || "{}");
    }
    res.json(rows);
  } catch { res.status(500).json({ error: "Failed to fetch marketplace" }); }
});

// Publish/unpublish own template to marketplace
app.put("/api/agent-templates/:id/publish", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { price } = req.body;
    const [existing]: any = await db.execute("SELECT * FROM aba_agent_templates WHERE id=? AND user_id=?", [req.params.id, userId]);
    if (!existing.length) return res.status(404).json({ error: "Template not found" });
    const publishPrice = Math.max(0, parseFloat(price) || 0);
    await db.execute("UPDATE aba_agent_templates SET is_published=1, price=? WHERE id=?", [publishPrice, req.params.id]);
    res.json({ success: true, price: publishPrice });
  } catch { res.status(500).json({ error: "Failed to publish" }); }
});

app.delete("/api/agent-templates/:id/publish", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [existing]: any = await db.execute("SELECT * FROM aba_agent_templates WHERE id=? AND user_id=?", [req.params.id, userId]);
    if (!existing.length) return res.status(404).json({ error: "Template not found" });
    await db.execute("UPDATE aba_agent_templates SET is_published=0, price=0 WHERE id=?", [req.params.id]);
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Failed to unpublish" }); }
});

// Check if user has purchased a template
app.get("/api/marketplace/purchased/:templateId", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute("SELECT id FROM aba_marketplace_purchases WHERE buyer_user_id=? AND template_id=? AND status='completed'", [userId, req.params.templateId]);
    res.json({ purchased: rows.length > 0 });
  } catch { res.json({ purchased: false }); }
});

// Purchase a marketplace role (uses Stripe)
app.post("/api/marketplace/purchase/:templateId", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [templates]: any = await db.execute("SELECT * FROM aba_agent_templates WHERE id=? AND is_published=1", [req.params.templateId]);
    if (!templates.length) return res.status(404).json({ error: "Role not found" });
    const tmpl = templates[0];
    // Check if already purchased
    const [purchases]: any = await db.execute("SELECT id FROM aba_marketplace_purchases WHERE buyer_user_id=? AND template_id=? AND status='completed'", [userId, req.params.templateId]);
    if (purchases.length > 0) {
      // Already purchased — just clone
      return res.json({ already_owned: true, template: tmpl });
    }
    if (parseFloat(tmpl.price) <= 0) {
      // Free — skip payment, record purchase and clone
      await db.execute("INSERT INTO aba_marketplace_purchases (buyer_user_id, template_id, price) VALUES (?, ?, 0)", [userId, req.params.templateId]);
      await db.execute("UPDATE aba_agent_templates SET purchased_count = purchased_count + 1 WHERE id=?", [req.params.templateId]);
      const slug = (tmpl.name + '-' + userId + '-' + Date.now()).toLowerCase().replace(/[^a-z0-9-]/g, '-');
      await db.execute(
        `INSERT INTO aba_agent_templates (name, slug, gender, personality, role, description, instructions, welcome_message, is_global, user_id, avatar_url, mo_content, tk_content, oi_content, ra_content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
        [tmpl.name, slug, tmpl.gender, tmpl.personality, tmpl.role, tmpl.description, tmpl.instructions, tmpl.welcome_message || null, userId, tmpl.avatar_url || null, tmpl.mo_content, tmpl.tk_content, tmpl.oi_content, tmpl.ra_content]
      );
      return res.json({ success: true, free: true });
    }
    // Paid — create Stripe checkout
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_intent_data: {
        metadata: {
          type: 'marketplace_role',
          template_id: String(req.params.templateId),
          buyer_user_id: String(userId),
        },
      },
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: tmpl.name + ' (Agent Role Template)' },
          unit_amount: Math.round(parseFloat(tmpl.price) * 100),
        },
        quantity: 1,
      }],
      success_url: `${process.env.FRONTEND_URL || 'https://dabarobjects.com'}/#/dashboard/roles?purchased=${tmpl.id}`,
      cancel_url: `${process.env.FRONTEND_URL || 'https://dabarobjects.com'}/#/dashboard/roles?canceled=1`,
    });
    res.json({ url: session.url });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Stripe webhook handler for marketplace purchases
app.post("/api/stripe-marketplace-webhook", express.raw({ type: 'application/json' }), async (req: any, res: any) => {
  try {
    const sig = req.headers['stripe-signature'];
    const stripe = getStripe();
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || '');
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const metadata = session.metadata || {};
      if (metadata.type === 'marketplace_role') {
        const templateId = parseInt(metadata.template_id);
        const buyerUserId = parseInt(metadata.buyer_user_id);
        const amountPaid = (session.amount_total || 0) / 100;
        if (templateId && buyerUserId) {
          // Record purchase
          await db.execute(
            "INSERT INTO aba_marketplace_purchases (buyer_user_id, template_id, price, stripe_payment_id, status) VALUES (?, ?, ?, ?, 'completed')",
            [buyerUserId, templateId, amountPaid, session.id]
          );
          // Increment purchased count
          await db.execute("UPDATE aba_agent_templates SET purchased_count = purchased_count + 1 WHERE id=?", [templateId]);
          // Clone template for buyer
          const [tmpl]: any = await db.execute("SELECT * FROM aba_agent_templates WHERE id=?", [templateId]);
          if (tmpl.length) {
            const t = tmpl[0];
            const slug = (t.name + '-' + buyerUserId + '-' + Date.now()).toLowerCase().replace(/[^a-z0-9-]/g, '-');
            await db.execute(
              `INSERT INTO aba_agent_templates (name, slug, gender, personality, role, description, instructions, welcome_message, is_global, user_id, avatar_url, mo_content, tk_content, oi_content, ra_content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
              [t.name, slug, t.gender, t.personality, t.role, t.description, t.instructions, t.welcome_message || null, buyerUserId, t.avatar_url || null, t.mo_content, t.tk_content, t.oi_content, t.ra_content]
            );
          }
        }
      }
    }
    res.json({ received: true });
  } catch (err: any) {
    console.error("Marketplace webhook error:", err);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
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

// ==================== SERVICE KEYS ====================

app.get("/api/service-keys", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute(
      "SELECT id, service_name, service_type, config_json, status, created_at, updated_at FROM aba_service_keys WHERE user_id=? ORDER BY created_at DESC",
      [userId]
    );
    res.json(rows.map((r: any) => ({ ...r, config_json: typeof r.config_json === 'string' ? JSON.parse(r.config_json) : r.config_json })));
  } catch { res.status(500).json({ error: "Failed to fetch service keys" }); }
});

app.post("/api/service-keys", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { service_name, service_type, config } = req.body;
    if (!service_name || !config) return res.status(400).json({ error: "Service name and config are required" });
    const [existing]: any = await db.execute("SELECT id FROM aba_service_keys WHERE user_id=? AND service_name=?", [userId, service_name]);
    if (existing.length > 0) {
      await db.execute("UPDATE aba_service_keys SET config_json=?, service_type=?, status='active' WHERE user_id=? AND service_name=?",
        [JSON.stringify(config), service_type || 'api_key', userId, service_name]);
    } else {
      await db.execute("INSERT INTO aba_service_keys (user_id, service_name, service_type, config_json) VALUES (?, ?, ?, ?)",
        [userId, service_name, service_type || 'api_key', JSON.stringify(config)]);
    }
    const [rows]: any = await db.execute("SELECT id, service_name, service_type, config_json, status, created_at, updated_at FROM aba_service_keys WHERE user_id=? AND service_name=?", [userId, service_name]);
    res.json({ ...rows[0], config_json: typeof rows[0].config_json === 'string' ? JSON.parse(rows[0].config_json) : rows[0].config_json });
  } catch { res.status(500).json({ error: "Failed to save service key" }); }
});

app.delete("/api/service-keys/:id", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    await db.execute("DELETE FROM aba_service_keys WHERE id=? AND user_id=?", [req.params.id, userId]);
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Failed to delete service key" }); }
});

// ==================== AGENT-TOOLS CONFIG ROUTE ====================
// Single endpoint that returns ALL tool configs for the tools pages

app.get("/api/tools-config", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [agentRows]: any = await db.execute("SELECT * FROM aba_agent_configs WHERE user_id=?", [userId]);
    const [serviceRows]: any = await db.execute("SELECT id, service_name, service_type, config_json, status FROM aba_service_keys WHERE user_id=?", [userId]);
    res.json({
      agent: agentRows.length > 0 ? agentRows[0] : {},
      service_keys: serviceRows.map((r: any) => ({ ...r, config_json: typeof r.config_json === 'string' ? JSON.parse(r.config_json) : r.config_json }))
    });
  } catch { res.status(500).json({ error: "Failed to fetch tools config" }); }
});

app.post("/api/tools/test-db", authMiddleware, async (req, res) => {
  try {
    const { connection_string } = req.body;
    if (!connection_string) return res.status(400).json({ error: "No connection string provided" });
    const url = new URL(connection_string);
    const testConn = await mysql.createConnection({
      host: url.hostname,
      port: parseInt(url.port) || 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace('/', ''),
      connectTimeout: 8000,
    });
    await testConn.query("SELECT 1");
    await testConn.end();
    res.json({ success: true, message: "Connection successful" });
  } catch (err: any) {
    res.status(400).json({ error: err.message || "Connection failed" });
  }
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


// ───── Bank Name Lookup (by country) ─────
const BANK_DATA: Record<string, {name: string}[]> = {
  NG: [
    { name: 'Access Bank' }, { name: 'Citibank Nigeria' }, { name: 'Ecobank Nigeria' },
    { name: 'Fidelity Bank' }, { name: 'First Bank of Nigeria' }, { name: 'First City Monument Bank (FCMB)' },
    { name: 'Globus Bank' }, { name: 'GTBank (Guaranty Trust Bank)' }, { name: 'Heritage Bank' },
    { name: 'Jaiz Bank' }, { name: 'Keystone Bank' }, { name: 'Kuda Bank' },
    { name: 'Moniepoint' }, { name: 'OPay' }, { name: 'PalmPay' },
    { name: 'Polaris Bank' }, { name: 'Providus Bank' }, { name: 'Stanbic IBTC Bank' },
    { name: 'Standard Chartered' }, { name: 'Sterling Bank' }, { name: 'Suntrust Bank' },
    { name: 'Titan Trust Bank' }, { name: 'Union Bank' }, { name: 'United Bank for Africa (UBA)' },
    { name: 'Unity Bank' }, { name: 'Wema Bank' }, { name: 'Zenith Bank' },
  ],
  GH: [{ name: 'Access Bank Ghana' }, { name: 'Ecobank Ghana' }, { name: 'Fidelity Bank Ghana' }, { name: 'GCB Bank' }, { name: 'Stanbic Bank Ghana' }, { name: 'Zenith Bank Ghana' }, { name: 'Absa Bank Ghana' }, { name: 'CalBank' }, { name: 'First National Bank' }, { name: 'Prudential Bank' }],
  KE: [{ name: 'Equity Bank' }, { name: 'KCB Bank' }, { name: 'Co-operative Bank' }, { name: 'Absa Bank Kenya' }, { name: 'NCBA Bank' }, { name: 'Diamond Trust Bank' }, { name: 'Standard Chartered Kenya' }, { name: 'Stanbic Bank Kenya' }, { name: 'Bank of Africa Kenya' }, { name: 'Family Bank' }, { name: 'I&M Bank' }],
  ZA: [{ name: 'Absa' }, { name: 'First National Bank (FNB)' }, { name: 'Nedbank' }, { name: 'Standard Bank' }, { name: 'Capitec Bank' }, { name: 'African Bank' }, { name: 'Investec' }],
  US: [{ name: 'JPMorgan Chase' }, { name: 'Bank of America' }, { name: 'Wells Fargo' }, { name: 'Citibank' }, { name: 'U.S. Bank' }, { name: 'PNC Bank' }, { name: 'TD Bank' }, { name: 'Capital One' }, { name: 'HSBC USA' }, { name: 'Charles Schwab Bank' }],
  GB: [{ name: 'Barclays' }, { name: 'HSBC UK' }, { name: 'Lloyds Bank' }, { name: 'NatWest' }, { name: 'Santander UK' }, { name: 'TSB Bank' }, { name: 'Nationwide' }, { name: 'Virgin Money' }, { name: 'Starling Bank' }, { name: 'Monzo' }, { name: 'Revolut' }],
  CA: [{ name: 'RBC' }, { name: 'TD Canada Trust' }, { name: 'Scotiabank' }, { name: 'BMO' }, { name: 'CIBC' }, { name: 'National Bank of Canada' }, { name: 'HSBC Canada' }],
  AU: [{ name: 'Commonwealth Bank' }, { name: 'Westpac' }, { name: 'ANZ' }, { name: 'NAB' }, { name: 'Macquarie Bank' }, { name: 'Suncorp' }, { name: 'Bank of Queensland' }],
  DE: [{ name: 'Deutsche Bank' }, { name: 'Commerzbank' }, { name: 'N26' }, { name: 'Sparkasse' }, { name: 'DKB (Deutsche Kreditbank)' }, { name: 'Postbank' }, { name: 'Volksbank' }],
  FR: [{ name: 'BNP Paribas' }, { name: 'Societe Generale' }, { name: 'Credit Agricole' }, { name: 'CIC' }, { name: 'Banque Populaire' }, { name: 'La Banque Postale' }, { name: 'Revolut France' }],
  NL: [{ name: 'ING' }, { name: 'ABN AMRO' }, { name: 'Rabobank' }, { name: 'Triodos Bank' }, { name: 'Bunq' }, { name: 'SNS Bank' }],
  AE: [{ name: 'Emirates NBD' }, { name: 'Abu Dhabi Commercial Bank (ADCB)' }, { name: 'Mashreq Bank' }, { name: 'First Abu Dhabi Bank (FAB)' }, { name: 'Dubai Islamic Bank' }, { name: 'Rakbank' }],
};

app.get("/api/bank-lookup", authMiddleware, async (req, res) => {
  try {
    const country = String(req.query.country || '').toUpperCase();
    if (!country) return res.json([]);
    const banks = BANK_DATA[country] || [];
    res.json(banks);
  } catch { res.status(500).json({ error: "Bank lookup failed" }); }
});

// ───── Bank CRUD ─────
app.get("/api/bank-accounts", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute("SELECT * FROM aba_bank_accounts WHERE user_id = ? ORDER BY is_primary DESC, created_at ASC", [userId]);
    res.json(rows);
  } catch { res.status(500).json({ error: "Failed to fetch bank accounts" }); }
});

app.post("/api/bank-accounts", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { country, bank_name, account_number, routing_number, account_name, is_primary, currency } = req.body;
    if (!country || !bank_name || !account_number || !account_name) return res.status(400).json({ error: "Country, bank name, account number, and account name are required" });
    const setPrimary = is_primary === true || is_primary === 1;
    if (setPrimary) await db.execute("UPDATE aba_bank_accounts SET is_primary=0 WHERE user_id=?", [userId]);
    const result: any = await db.execute(
      "INSERT INTO aba_bank_accounts (user_id, country, bank_name, account_number, routing_number, account_name, is_primary, currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [userId, country, bank_name, account_number, routing_number || null, account_name, setPrimary ? 1 : 0, currency || 'USD']
    );
    const [rows]: any = await db.execute("SELECT * FROM aba_bank_accounts WHERE id = ?", [(result as any)[0]?.insertId || 0]);
    res.json(rows[0] || null);
  } catch(e: any) { res.status(500).json({ error: "Failed to create bank account: " + e.message }); }
});

app.put("/api/bank-accounts/:id", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { country, bank_name, account_number, routing_number, account_name, is_primary, currency } = req.body;
    const setPrimary = is_primary === true || is_primary === 1;
    if (setPrimary) await db.execute("UPDATE aba_bank_accounts SET is_primary=0 WHERE user_id=?", [userId]);
    await db.execute(
      "UPDATE aba_bank_accounts SET country=?, bank_name=?, account_number=?, routing_number=?, account_name=?, is_primary=?, currency=? WHERE id=? AND user_id=?",
      [country, bank_name, account_number, routing_number || null, account_name, setPrimary ? 1 : 0, currency || 'USD', req.params.id, userId]
    );
    const [rows]: any = await db.execute("SELECT * FROM aba_bank_accounts WHERE id = ?", [req.params.id]);
    res.json(rows[0]);
  } catch(e: any) { res.status(500).json({ error: "Failed to update bank account: " + e.message }); }
});

app.delete("/api/bank-accounts/:id", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    await db.execute("DELETE FROM aba_bank_accounts WHERE id=? AND user_id=?", [req.params.id, userId]);
    res.json({ success: true });
  } catch(e: any) { res.status(500).json({ error: "Failed to delete bank account: " + e.message }); }
});

// ==================== CUSTOM DATABASES ====================

app.get("/api/custom-databases", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute("SELECT * FROM aba_custom_databases WHERE user_id = ? ORDER BY is_primary DESC, created_at ASC", [userId]);
    res.json(rows);
  } catch(e: any) { res.status(500).json({ error: "Failed to fetch custom databases: " + e.message }); }
});

app.post("/api/custom-databases", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { name, db_type, db_host, db_port, db_name, db_user, db_pass, connection_string, is_primary } = req.body;
    const setPrimary = is_primary === true || is_primary === 1;
    if (setPrimary) await db.execute("UPDATE aba_custom_databases SET is_primary=0 WHERE user_id=?", [userId]);
    const result: any = await db.execute(
      "INSERT INTO aba_custom_databases (user_id, name, db_type, db_host, db_port, db_name, db_user, db_pass, connection_string, is_primary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [userId, name || '', db_type || 'mysql', db_host || '', db_port || 3306, db_name || '', db_user || '', db_pass || '', connection_string || '', setPrimary ? 1 : 0]
    );
    const [rows]: any = await db.execute("SELECT * FROM aba_custom_databases WHERE id = ?", [(result as any)[0]?.insertId || 0]);
    res.json(rows[0] || null);
  } catch(e: any) { res.status(500).json({ error: "Failed to create custom database: " + e.message }); }
});

app.put("/api/custom-databases/:id", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { name, db_type, db_host, db_port, db_name, db_user, db_pass, connection_string, is_primary } = req.body;
    const setPrimary = is_primary === true || is_primary === 1;
    if (setPrimary) await db.execute("UPDATE aba_custom_databases SET is_primary=0 WHERE user_id=?", [userId]);
    await db.execute(
      "UPDATE aba_custom_databases SET name=?, db_type=?, db_host=?, db_port=?, db_name=?, db_user=?, db_pass=?, connection_string=?, is_primary=? WHERE id=? AND user_id=?",
      [name || '', db_type || 'mysql', db_host || '', db_port || 3306, db_name || '', db_user || '', db_pass || '', connection_string || '', setPrimary ? 1 : 0, req.params.id, userId]
    );
    const [rows]: any = await db.execute("SELECT * FROM aba_custom_databases WHERE id = ?", [req.params.id]);
    res.json(rows[0]);
  } catch(e: any) { res.status(500).json({ error: "Failed to update custom database: " + e.message }); }
});

app.delete("/api/custom-databases/:id", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    await db.execute("DELETE FROM aba_custom_databases WHERE id=? AND user_id=?", [req.params.id, userId]);
    res.json({ success: true });
  } catch(e: any) { res.status(500).json({ error: "Failed to delete custom database: " + e.message }); }
});

// ==================== EMAIL SOURCES ====================

app.get("/api/email-sources", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute("SELECT * FROM aba_email_sources WHERE user_id = ? ORDER BY is_primary DESC, created_at ASC", [userId]);
    res.json(rows);
  } catch(e: any) { res.status(500).json({ error: "Failed to fetch email sources: " + e.message }); }
});

app.post("/api/email-sources", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { name, email_address, pop_host, pop_port, pop_user, pop_pass, instruction, is_primary, enabled } = req.body;
    const setPrimary = is_primary === true || is_primary === 1;
    if (setPrimary) await db.execute("UPDATE aba_email_sources SET is_primary=0 WHERE user_id=?", [userId]);
    const result: any = await db.execute(
      "INSERT INTO aba_email_sources (user_id, name, email_address, pop_host, pop_port, pop_user, pop_pass, instruction, is_primary, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [userId, name || '', email_address || '', pop_host || '', pop_port || 993, pop_user || '', pop_pass || '', instruction || '', setPrimary ? 1 : 0, enabled !== false ? 1 : 0]
    );
    const [rows]: any = await db.execute("SELECT * FROM aba_email_sources WHERE id = ?", [(result as any)[0]?.insertId || 0]);
    res.json(rows[0] || null);
  } catch(e: any) { res.status(500).json({ error: "Failed to create email source: " + e.message }); }
});

app.put("/api/email-sources/:id", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { name, email_address, pop_host, pop_port, pop_user, pop_pass, instruction, is_primary, enabled } = req.body;
    const setPrimary = is_primary === true || is_primary === 1;
    if (setPrimary) await db.execute("UPDATE aba_email_sources SET is_primary=0 WHERE user_id=?", [userId]);
    await db.execute(
      "UPDATE aba_email_sources SET name=?, email_address=?, pop_host=?, pop_port=?, pop_user=?, pop_pass=?, instruction=?, is_primary=?, enabled=? WHERE id=? AND user_id=?",
      [name || '', email_address || '', pop_host || '', pop_port || 993, pop_user || '', pop_pass || '', instruction || '', setPrimary ? 1 : 0, enabled !== false ? 1 : 0, req.params.id, userId]
    );
    const [rows]: any = await db.execute("SELECT * FROM aba_email_sources WHERE id = ?", [req.params.id]);
    res.json(rows[0]);
  } catch(e: any) { res.status(500).json({ error: "Failed to update email source: " + e.message }); }
});

app.delete("/api/email-sources/:id", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    await db.execute("DELETE FROM aba_email_sources WHERE id=? AND user_id=?", [req.params.id, userId]);
    res.json({ success: true });
  } catch(e: any) { res.status(500).json({ error: "Failed to delete email source: " + e.message }); }
});

// ==================== ECOMMERCE STORES ====================

app.get("/api/ecommerce-stores", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute("SELECT * FROM aba_ecommerce_stores WHERE user_id = ? ORDER BY is_primary DESC, created_at ASC", [userId]);
    res.json(rows);
  } catch(e: any) { res.status(500).json({ error: "Failed to fetch ecommerce stores: " + e.message }); }
});

app.post("/api/ecommerce-stores", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { name, store_type, url, api_key, api_secret, access_token, is_primary } = req.body;
    const setPrimary = is_primary === true || is_primary === 1;
    if (setPrimary) await db.execute("UPDATE aba_ecommerce_stores SET is_primary=0 WHERE user_id=?", [userId]);
    const result: any = await db.execute(
      "INSERT INTO aba_ecommerce_stores (user_id, name, store_type, url, api_key, api_secret, access_token, is_primary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [userId, name || '', store_type || 'woocommerce', url || '', api_key || '', api_secret || '', access_token || '', setPrimary ? 1 : 0]
    );
    const [rows]: any = await db.execute("SELECT * FROM aba_ecommerce_stores WHERE id = ?", [(result as any)[0]?.insertId || 0]);
    res.json(rows[0] || null);
  } catch(e: any) { res.status(500).json({ error: "Failed to create ecommerce store: " + e.message }); }
});

app.put("/api/ecommerce-stores/:id", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { name, store_type, url, api_key, api_secret, access_token, is_primary } = req.body;
    const setPrimary = is_primary === true || is_primary === 1;
    if (setPrimary) await db.execute("UPDATE aba_ecommerce_stores SET is_primary=0 WHERE user_id=?", [userId]);
    await db.execute(
      "UPDATE aba_ecommerce_stores SET name=?, store_type=?, url=?, api_key=?, api_secret=?, access_token=?, is_primary=? WHERE id=? AND user_id=?",
      [name || '', store_type || 'woocommerce', url || '', api_key || '', api_secret || '', access_token || '', setPrimary ? 1 : 0, req.params.id, userId]
    );
    const [rows]: any = await db.execute("SELECT * FROM aba_ecommerce_stores WHERE id = ?", [req.params.id]);
    res.json(rows[0]);
  } catch(e: any) { res.status(500).json({ error: "Failed to update ecommerce store: " + e.message }); }
});

app.delete("/api/ecommerce-stores/:id", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    await db.execute("DELETE FROM aba_ecommerce_stores WHERE id=? AND user_id=?", [req.params.id, userId]);
    res.json({ success: true });
  } catch(e: any) { res.status(500).json({ error: "Failed to delete ecommerce store: " + e.message }); }
});

// ==================== GOOGLE CALENDAR OAUTH ====================

const GOOGLE_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI || "https://dabarobjects.com/api/oauth/google/callback";
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];

function getOAuth2Client(): OAuth2Client {
  return new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

function encryptToken(text: string): string {
  const cipher = crypto.createCipheriv(
    "aes-256-cbc",
    Buffer.from(JWT_SECRET.padEnd(32, "0").slice(0, 32)),
    Buffer.from(JWT_SECRET.padEnd(16, "0").slice(0, 16))
  );
  let enc = cipher.update(text, "utf8", "hex");
  enc += cipher.final("hex");
  return enc;
}

function decryptToken(enc: string): string {
  const decipher = crypto.createDecipheriv(
    "aes-256-cbc",
    Buffer.from(JWT_SECRET.padEnd(32, "0").slice(0, 32)),
    Buffer.from(JWT_SECRET.padEnd(16, "0").slice(0, 16))
  );
  let dec = decipher.update(enc, "hex", "utf8");
  dec += decipher.final("utf8");
  return dec;
}

// Google OAuth callback (Google redirects here with ?code=&state=)
app.get("/api/oauth/google/callback", async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;
    if (oauthError) throw new Error("Google returned: " + oauthError);
    if (!code) throw new Error("No authorization code received");

    const userId = parseInt(String(state || "0"), 10);
    if (!userId) {
      return res.redirect("https://dabarobjects.com/#/dashboard/tools/google-calendar?error=invalid_state");
    }

    const oauth = getOAuth2Client();
    const { tokens } = await oauth.getToken(String(code));

    // Get userinfo email
    let googleEmail = "";
    if (tokens.id_token) {
      const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token });
      const payload = ticket.getPayload();
      googleEmail = payload?.email || "";
    }

    const encryptedRefresh = encryptToken(tokens.refresh_token || "");
    const encryptedAccess = encryptToken(tokens.access_token || "");

    // Upsert
    const [existing]: any = await db.execute("SELECT id FROM aba_google_tokens WHERE user_id = ?", [userId]);
    if (existing.length > 0) {
      await db.execute(
        "UPDATE aba_google_tokens SET google_email=?, refresh_token=?, access_token=?, token_expiry=?, scopes=? WHERE user_id=?",
        [googleEmail, encryptedRefresh, encryptedAccess, tokens.expiry_date ? new Date(tokens.expiry_date) : null, GOOGLE_SCOPES.join(" "), userId]
      );
    } else {
      await db.execute(
        "INSERT INTO aba_google_tokens (user_id, google_email, refresh_token, access_token, token_expiry, scopes) VALUES (?, ?, ?, ?, ?, ?)",
        [userId, googleEmail, encryptedRefresh, encryptedAccess, tokens.expiry_date ? new Date(tokens.expiry_date) : null, GOOGLE_SCOPES.join(" ")]
      );
    }

    res.redirect("https://dabarobjects.com/#/dashboard/tools/google-calendar?linked=true");
  } catch(e: any) {
    console.error("Google OAuth callback error:", e.message);
    res.redirect("https://dabarobjects.com/#/dashboard/tools/google-calendar?error=" + encodeURIComponent(e.message));
  }
});

// Get Google OAuth status
app.get("/api/oauth/google/status", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute(
      "SELECT id, google_email, token_expiry, scopes, created_at, updated_at FROM aba_google_tokens WHERE user_id = ?",
      [userId]
    );

    if (rows.length === 0) {
      return res.json({ linked: false });
    }

    const row = rows[0];
    const now = new Date();
    const expiry = row.token_expiry ? new Date(row.token_expiry) : null;
    const active = expiry ? expiry > now : false;

    res.json({
      linked: true,
      active,
      google_email: row.google_email,
      scopes: row.scopes,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  } catch(e: any) {
    res.status(500).json({ error: "Failed to check Google status: " + e.message });
  }
});

// Get OAuth URL for frontend redirect
app.get("/api/oauth/google/url", authMiddleware, async (req, res) => {
  try {
    const oauth = getOAuth2Client();
    const url = oauth.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: GOOGLE_SCOPES,
      state: String((req as any).user.userId || ""),
    });
    res.json({ url });
  } catch(e: any) {
    res.status(500).json({ error: "Failed to generate auth URL: " + e.message });
  }
});

// Refresh an expired access token
async function refreshGoogleToken(userId: number): Promise<string | null> {
  try {
    const [rows]: any = await db.execute("SELECT refresh_token, google_email FROM aba_google_tokens WHERE user_id = ?", [userId]);
    if (rows.length === 0) return null;

    const decrypted = decryptToken(rows[0].refresh_token);
    if (!decrypted) return null;

    const oauth = getOAuth2Client();
    oauth.setCredentials({ refresh_token: decrypted });

    const { credentials } = await oauth.refreshAccessToken();
    const encrypted = encryptToken(credentials.access_token || "");

    await db.execute(
      "UPDATE aba_google_tokens SET access_token=?, token_expiry=? WHERE user_id=?",
      [encrypted, credentials.expiry_date ? new Date(credentials.expiry_date) : null, userId]
    );

    return credentials.access_token || null;
  } catch(e: any) {
    console.error("Token refresh failed for user", userId, ":", e.message);
    return null;
  }
}

// Sync token to EC2 instance
app.post("/api/oauth/google/sync", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;

    // Get user info + google token
    const [userRows]: any = await db.execute("SELECT email FROM aba_users WHERE id = ?", [userId]);
    if (userRows.length === 0) return res.status(404).json({ error: "User not found" });

    const [tokenRows]: any = await db.execute("SELECT * FROM aba_google_tokens WHERE user_id = ?", [userId]);
    if (tokenRows.length === 0) return res.status(400).json({ error: "No Google account linked" });

    const token = tokenRows[0];

    // Refresh the access token if expired
    let accessToken = token.access_token;
    const now = new Date();
    if (token.token_expiry && new Date(token.token_expiry) <= now) {
      accessToken = await refreshGoogleToken(userId);
      if (!accessToken) return res.status(400).json({ error: "Token expired and refresh failed. Please re-link." });
    }

    // Decrypt tokens for sync
    const decryptedRefresh = decryptToken(token.refresh_token);
    const decryptedAccess = accessToken ? decryptToken(accessToken) : "";

    // Store on EC2 via the agent's API endpoint
    const userEmail = userRows[0].email;
    const ec2Host = process.env.AGENT_EC2_HOST || "";
    const ec2Token = process.env.EC2_SYNC_TOKEN || "";

    if (ec2Host && ec2Token) {
      const body = JSON.stringify({
        user_id: userId,
        email: userEmail,
        google_email: token.google_email,
        refresh_token: decryptedRefresh,
        access_token: decryptedAccess,
        scopes: token.scopes,
      });

      const ab = new AbortController();
      const timer = setTimeout(() => ab.abort(), 10000);

      const upstream = await fetch(`${ec2Host}/api/google/sync-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${ec2Token}` },
        body,
        signal: ab.signal,
      });
      clearTimeout(timer);

      if (!upstream.ok) {
        const errText = await upstream.text();
        console.error("EC2 sync failed:", upstream.status, errText);
        return res.status(502).json({ error: "EC2 sync failed", detail: errText });
      }
    }

    res.json({ success: true, message: "Token synced to EC2" });
  } catch(e: any) {
    console.error("Sync error:", e.message);
    res.status(500).json({ error: "Sync failed: " + e.message });
  }
});

// Unlink (delete) Google OAuth token
app.delete("/api/oauth/google", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    await db.execute("DELETE FROM aba_google_tokens WHERE user_id = ?", [userId]);
    res.json({ success: true });
  } catch(e: any) {
    res.status(500).json({ error: "Failed to unlink: " + e.message });
  }
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

app.post("/api/subscription/activate-trial", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    // Check if trial already active or has been used
    const [existing]: any = await db.execute(
      "SELECT id, plan, status FROM aba_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", [userId]
    );
    if (existing.length > 0 && existing[0].status === 'active') {
      // Already has an active sub (could be trial or paid)
      res.json({ subscription: existing[0] });
      return;
    }
    // Check if they already used a trial
    const [usedTrial]: any = await db.execute(
      "SELECT COUNT(*) as cnt FROM aba_subscriptions WHERE user_id = ? AND plan = 'trial'", [userId]
    );
    if (usedTrial[0].cnt > 0) {
      res.status(400).json({ error: "You've already used your free trial. Please choose a paid plan." });
      return;
    }
    await db.execute(
      "INSERT INTO aba_subscriptions (user_id, plan, status) VALUES (?, 'trial', 'active')", [userId]
    );
    const [sub]: any = await db.execute(
      "SELECT plan, status FROM aba_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", [userId]
    );
    res.json({ subscription: sub[0] });
  } catch (err: any) {
    console.error("Activate trial error:", err);
    res.status(500).json({ error: "Failed to activate trial" });
  }
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

    // Detect stale deployments: DB says active but EC2 instance is gone
    let stale = false;
    if (d.status === 'active' && d.instance_id) {
      try {
        const out = execSync(`aws ec2 describe-instances --instance-ids ${d.instance_id} --region us-east-1 --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null`, { timeout: 10000 });
        const state = out.toString().trim();
        if (state !== 'running') stale = true;
      } catch {
        stale = true; // describe failed = instance gone
      }
    }

    res.json({ id: d.id, status: d.status, instanceId: d.instance_id, publicIp: d.public_ip,
      telegramUsername: d.telegram_bot_username, errorMessage: d.error_message, bindCode: d.bind_code,
      ownerChatId: d.owner_chat_id, ownerName: d.owner_name, deployedAt: d.deployed_at, decommissionedAt: d.decommissioned_at,
      createdAt: d.created_at, stale, lastBackupAt: d.last_backup_at });
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

app.post("/api/deploy/restart", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;

    const [rows]: any = await db.execute("SELECT * FROM aba_deployments WHERE user_id=?", [userId]);
    if (rows.length === 0) return res.status(400).json({ error: "No deployment found to restart" });
    const dep = rows[0];

    // Try to terminate the old instance if it still exists
    if (dep.instance_id) {
      try {
        execSync(`aws ec2 terminate-instances --instance-ids ${dep.instance_id} --region us-east-1`, { timeout: 15000, stdio: 'pipe' });
      } catch (e: any) {
        // Instance may already be gone — that's fine
      }
    }

    // Set RESTORE_NEEDED marker in S3 so orchestrator restores backup
    try {
      execSync(`echo "1" | aws s3 cp - "s3://aba-backups/${userId}/RESTORE_NEEDED" --region us-east-1 2>/dev/null || true`, { timeout: 10000 });
    } catch {}

    // Reset deployment to pending so orchestrator picks it up
    await db.execute(
      "UPDATE aba_deployments SET status='pending', error_message=NULL, instance_id=NULL, public_ip=NULL, deployed_at=NULL, updated_at=NOW() WHERE id=?",
      [dep.id]
    );

    res.json({ success: true, message: "Restart queued. Instance will be recreated with backup restored." });
  } catch (err: any) {
    console.error("Restart error:", err);
    res.status(500).json({ error: "Failed to restart deployment" });
  }
});

app.post("/api/deploy/repair", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;

    const [rows]: any = await db.execute("SELECT * FROM aba_deployments WHERE user_id=? AND status='active'", [userId]);
    if (rows.length === 0) return res.status(400).json({ error: "No active deployment to repair" });
    const dep = rows[0];
    if (!dep.public_ip) return res.status(400).json({ error: "Deployment has no IP address" });

    const sshTarget = `ubuntu@${dep.public_ip}`;
    const sshKey = process.env.SSH_KEY_PATH || "/root/.ssh/aba-agent-provision.pem";

    // Step 1: Run doctor --fix and capture output
    let doctorOutput = "";
    try {
      doctorOutput = execSync(
        `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i ${sshKey} ${sshTarget} ` +
        `"sudo /usr/bin/openclaw doctor --fix 2>&1; echo 'EXIT_CODE:'$?" 2>/dev/null || true`,
        { timeout: 120000, maxBuffer: 50 * 1024 }
      ).toString().trim();
    } catch (e: any) {
      doctorOutput = "Repair command failed: " + (e.message || "unknown");
    }

    // Extract exit code
    const exitMatch = doctorOutput.match(/EXIT_CODE:(\d+)/);
    const exitCode = exitMatch ? parseInt(exitMatch[1]) : -1;

    // Step 2: Restart openclaw service
    let restartOk = false;
    try {
      const restartOut = execSync(
        `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i ${sshKey} ${sshTarget} ` +
        `"sudo systemctl restart openclaw 2>&1; sleep 3; sudo systemctl is-active openclaw" 2>/dev/null || true`,
        { timeout: 30000 }
      ).toString().trim();
      restartOk = restartOut === "active";
    } catch {}

    // Extract meaningful summary from doctor output
    const summaryLines: string[] = [];
    const lines = doctorOutput.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('◇') || trimmed.startsWith('│')) continue;
      if (trimmed.startsWith('Config auto-restored') ||
          trimmed.startsWith('Restored') ||
          trimmed.includes('doctor') && trimmed.includes('fix') ||
          trimmed.includes('ready') ||
          trimmed.match(/EXIT_CODE/)) {
        summaryLines.push(trimmed.replace(/^[•\-]\s*/, ''));
      }
    }

    res.json({
      success: exitCode === 0 || restartOk,
      restartOk,
      exitCode,
      summary: summaryLines.join('\n') || (exitCode === 0 ? 'Doctor completed and service restarted.' : 'Doctor encountered issues.'),
      rawOutput: doctorOutput.substring(0, 2000)
    });
  } catch (err: any) {
    console.error("Repair error:", err);
    res.status(500).json({ error: "Repair failed: " + (err.message || "unknown error") });
  }
});

app.post("/api/deploy/backup", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;

    const [rows]: any = await db.execute("SELECT * FROM aba_deployments WHERE user_id=? AND status='active'", [userId]);
    if (rows.length === 0) return res.status(400).json({ error: "No active deployment to backup" });
    const dep = rows[0];
    if (!dep.public_ip) return res.status(400).json({ error: "Deployment has no IP address" });

    const BACKUP_DIR = "/tmp/aba-backups";
    const backupFile = `${BACKUP_DIR}/workspace-${userId}.tar.gz`;

    // SSH into the EC2, tar the workspace
    execSync(`mkdir -p ${BACKUP_DIR}`, { timeout: 5000 });
    const sshTarget = `ubuntu@${dep.public_ip}`;
    const sshKey = process.env.SSH_KEY_PATH || "/root/.ssh/aba-agent-provision.pem";

    // Create backup on EC2
    const remoteBackupCmd = `tar czf /tmp/workspace-backup.tar.gz -C /home/ubuntu .openclaw 2>/dev/null; echo "BACKUP_DONE:$?"`;
    const result = execSync(
      `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i ${sshKey} ${sshTarget} "${remoteBackupCmd}"`,
      { timeout: 30000 }
    ).toString().trim();

    if (!result.includes("BACKUP_DONE:0")) {
      return res.status(500).json({ error: "Failed to create backup on remote server" });
    }

    // SCP it back
    execSync(
      `scp -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i ${sshKey} ${sshTarget}:/tmp/workspace-backup.tar.gz ${backupFile}`,
      { timeout: 60000 }
    );

    // Upload to S3
    execSync(
      `aws s3 cp ${backupFile} s3://aba-backups/${userId}/workspace-backup.tar.gz --region us-east-1`,
      { timeout: 30000 }
    );

    // Set restore marker
    execSync(`echo "1" | aws s3 cp - "s3://aba-backups/${userId}/RESTORE_NEEDED" --region us-east-1 2>/dev/null || true`, { timeout: 10000 });

    // Record backup timestamp
    await db.execute("UPDATE aba_deployments SET last_backup_at=NOW() WHERE user_id=?", [userId]);

    // Cleanup
    execSync(`rm -f ${backupFile}`, { timeout: 5000 });

    res.json({ success: true, message: "Backup completed and stored in S3. Restore marker set." });
  } catch (err: any) {
    console.error("Backup error:", err);
    res.status(500).json({ error: "Backup failed: " + (err.message || "unknown error") });
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

    // Generate MO (Method of Operations)
    const personality = agent.personality || "Professional";
    const bizName = business.business_name || "My Business";
    const moContent = `# ${agent.agent_name || "My ABA Agent"} — Method of Operations

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

    // Products TK (Technical Knowledge — resolved to presigned URLs)
    const productLines = await Promise.all(products.map(async (p: any) => {
      let line = `- **${p.name}**${p.price ? ` (${p.price})` : ''}${p.description ? `: ${p.description}` : ''}`;
      if (p.image_s3_key) {
        const presigned = await getPresignedUrl(p.image_s3_key, 86400);
        if (presigned) line += `\n  - Image: ${presigned}`;
      } else if (p.image) {
        line += `\n  - Image: ${p.image}`;
      }
      return line;
    })).then(lines => lines.join('\n'));
    const tkContent = products.length > 0
      ? `## Products & Services\n\n${productLines}\n`
      : '';

    // Generate OI (Operating Identity)
    const oiContent = `# Operating Identity: ${agent.agent_name || "Assistant"}
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

    // RA (Routine Activities) — placeholder for future heartbeat/routine generation
    const raContent = '';

    const [configRows]: any = await db.execute("SELECT id FROM aba_openclaw_configs WHERE user_id=?", [userId]);
    if (configRows.length > 0) {
      await db.execute("UPDATE aba_openclaw_configs SET openclaw_json=?, mo_content=?, tk_content=?, oi_content=?, ra_content=?, generated_at=NOW() WHERE user_id=?", [JSON.stringify(openclawConfig), moContent, tkContent, oiContent, raContent, userId]);
    } else {
      await db.execute("INSERT INTO aba_openclaw_configs (user_id, openclaw_json, mo_content, tk_content, oi_content, ra_content, generated_at) VALUES (?, ?, ?, ?, ?, ?, NOW())", [userId, JSON.stringify(openclawConfig), moContent, tkContent, oiContent, raContent]);
    }

    res.json({ openclaw_json: openclawConfig, mo_content: moContent, tk_content: tkContent, oi_content: oiContent, ra_content: raContent });
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
      metadata: { plan: planName, email: userEmail || '', is_upgrade: 'false' },
    });
    res.json({ url: session.url });
  } catch (error: any) {
    console.error("Stripe Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== UPGRADE SUBSCRIPTION (auth-only, existing users) ====================
app.post("/api/subscription/upgrade", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { planName, price, interval } = req.body;
    if (!planName || !price) return res.status(400).json({ error: "planName and price required" });

    const [userRows]: any = await db.execute("SELECT email, name FROM aba_users WHERE id=?", [userId]);
    if (userRows.length === 0) return res.status(404).json({ error: "User not found" });
    const userEmail = userRows[0].email;

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
      success_url: `${req.headers.origin}/#/dashboard/subscription?upgrade=true`,
      cancel_url: `${req.headers.origin}/#/dashboard/subscription`,
      customer_email: userEmail,
      metadata: { plan: planName, email: userEmail, user_id: String(userId), is_upgrade: 'true' },
    });
    res.json({ url: session.url });
  } catch (error: any) {
    console.error("Upgrade error:", error);
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

const uploadDir = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

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

// ==================== IMAGE UPLOAD (S3) ====================

const s3Client = new S3Client({ region: "us-east-1" });
const S3_BUCKET = "dabarobjects-uploads";

// In-memory multer for image uploads (we buffer, then push to S3)
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Generate a presigned URL valid for N seconds
async function getPresignedUrl(s3Key: string, expiresIn = 3600): Promise<string> {
  if (!s3Key) return "";
  try {
    const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key });
    return await getSignedUrl(s3Client, command, { expiresIn });
  } catch {
    return "";
  }
}

// Upload image to S3
app.post("/api/upload/image", authMiddleware, imageUpload.single('image'), async (req: any, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const { userId } = (req as any).user;
    const ext = path.extname(req.file.originalname) || ".jpg";
    const s3Key = `products/${userId}/${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;

    const command = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    });
    await s3Client.send(command);

    // Track storage usage
    const fileSize = req.file.size;
    await db.execute(
      "INSERT INTO aba_storage_usage (user_id, s3_key, file_size, file_type) VALUES (?, ?, ?, 'image') ON DUPLICATE KEY UPDATE file_size = file_size + ?",
      [userId, s3Key, fileSize, fileSize]
    );

    // Generate a short-lived preview URL for the frontend
    const previewUrl = await getPresignedUrl(s3Key, 3600);
    res.json({ url: s3Key, preview: previewUrl });
  } catch (err: any) {
    console.error("S3 upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// Generate a presigned URL for a product image
app.get("/api/products/:id/image-url", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute("SELECT image_s3_key FROM aba_products WHERE id=? AND user_id=?", [req.params.id, userId]);
    if (!rows.length || !rows[0].image_s3_key) return res.json({ url: null });
    const url = await getPresignedUrl(rows[0].image_s3_key, 86400);
    res.json({ url });
  } catch { res.status(500).json({ error: "Failed to generate URL" }); }
});

// Get storage usage for current user
app.get("/api/storage/usage", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;

    // 1. Sum product images from DB (if any)
    const [rows]: any = await db.execute(
      "SELECT COALESCE(SUM(file_size), 0) as total_bytes FROM aba_storage_usage WHERE user_id=?", [userId]
    );
    let totalBytes = parseInt(rows[0]?.total_bytes || 0, 10);

    // 2. Sum workspace backups from S3 directly
    try {
      const s3Backups = execSync(
        `aws s3 ls --recursive --summarize s3://aba-backups/${userId}/ --region us-east-1 2>/dev/null | grep "Total Size:" | awk '{print $3}'`,
        { timeout: 10000 }
      ).toString().trim();
      if (s3Backups && !isNaN(parseInt(s3Backups, 10))) {
        totalBytes += parseInt(s3Backups, 10);
      }
    } catch (e: any) {
      console.error("S3 Backup Size error:", e.message);
      // Ignore S3 errors if bucket or prefix doesn't exist
    }

    res.json({
      total_bytes: totalBytes,
      total_mb: (totalBytes / (1024 * 1024)).toFixed(2),
      limit_bytes: 524288000, // Increased to 500 MB because backups are large (~150MB each)
      limit_mb: "500.00",
      percent: Math.min(100, ((totalBytes / 524288000) * 100)).toFixed(1),
    });
  } catch (err: any) { res.status(500).json({ error: "Failed to get storage usage" }); }
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

// ==================== MO / TK / OI / RA CONFIG ====================

app.get("/api/agent-config/motkoi", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute(`SELECT custom_greeting AS mo_content, custom_personality_text AS oi_content, timezone, nationality_vibe,
      custom_instructions AS tk_content, mo_document_path, mo_document_name FROM aba_agent_configs WHERE user_id=?`, [userId]);
    if (rows.length === 0) return res.json({});
    res.json(rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.put("/api/agent-config/motkoi", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { mo_content, oi_content, timezone, nationality_vibe, tk_content } = req.body;
    await db.execute(`UPDATE aba_agent_configs SET
      custom_greeting=?, custom_personality_text=?, timezone=?, nationality_vibe=?, custom_instructions=?
      WHERE user_id=?`,
      [mo_content||null, oi_content||null, timezone||'Africa/Lagos', nationality_vibe||'Global', tk_content||null, userId]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get("/api/team-agents/:id/motkoi", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [rows]: any = await db.execute(`SELECT id, agent_name, role, custom_greeting AS mo_content, custom_personality_text AS oi_content,
      timezone, nationality_vibe, custom_instructions AS tk_content, mo_document_path, mo_document_name
      FROM aba_team_agents WHERE id=? AND user_id=?`, [req.params.id, userId]);
    if (rows.length === 0) return res.status(404).json({ error: "Team agent not found" });
    res.json(rows[0]);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.put("/api/team-agents/:id/motkoi", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { mo_content, oi_content, timezone, nationality_vibe, tk_content } = req.body;
    await db.execute(`UPDATE aba_team_agents SET
      custom_greeting=?, custom_personality_text=?, timezone=?, nationality_vibe=?, custom_instructions=?
      WHERE id=? AND user_id=?`,
      [mo_content||null, oi_content||null, timezone||'Africa/Lagos', nationality_vibe||'Global', tk_content||null, req.params.id, userId]);
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

    // Build MO/TK/OI config
    const motkoiConfig: Record<string, any> = {
      mo: cfg.custom_greeting || '',
      oi: cfg.custom_personality_text || cfg.personality || 'Professional',
      timezone: cfg.timezone || 'Africa/Lagos',
      nationality_vibe: cfg.nationality_vibe || 'Global',
      tk: cfg.custom_instructions || '',
    };

    // MO document content
    if (cfg.mo_document_path && fs.existsSync(cfg.mo_document_path)) {
      try {
        motkoiConfig.mo_document = fs.readFileSync(cfg.mo_document_path, 'utf8');
      } catch {}
    }

    // Team agents config
    const [teamRows]: any = await db.execute(`SELECT id, agent_name, role, telegram_bot_token, telegram_bot_username,
      custom_greeting AS mo_content, custom_personality_text AS oi_content, timezone, nationality_vibe, custom_instructions AS tk_content, mo_document_path, mo_document_name
      FROM aba_team_agents WHERE user_id=? AND status='active'`, [userId]);
    const teamAgents: any[] = [];
    for (const ta of teamRows) {
      const taMotkoi: any = {
        mo: ta.mo_content || '',
        oi: ta.oi_content || ta.role || 'Professional',
        timezone: ta.timezone || 'Africa/Lagos',
        nationality_vibe: ta.nationality_vibe || 'Global',
        tk: ta.tk_content || '',
      };
      if (ta.mo_document_path && fs.existsSync(ta.mo_document_path)) {
        try { taMotkoi.mo_document = fs.readFileSync(ta.mo_document_path, 'utf8'); } catch {}
      }
      teamAgents.push({
        id: ta.id, name: ta.agent_name, role: ta.role,
        bot_token: ta.telegram_bot_token, bot_username: ta.telegram_bot_username,
        motkoi: taMotkoi,
      });
    }

    const payload: any = {
      env, service_keys: serviceKeys, motkoi: motkoiConfig, team_agents: teamAgents,
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
          "email_pop_host, email_pop_port, email_pop_user, email_pop_pass, " +
          "twilio_sid, twilio_auth_token, twilio_phone, " +
          "github_token, " +
          "woo_url, woo_key, woo_secret, " +
          "shopify_url, shopify_api_key, " +
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
            email: cfg.email_pop_host ? {
              host: cfg.email_pop_host,
              port: cfg.email_pop_port || "993",
              user: cfg.email_pop_user || "",
              pass: cfg.email_pop_pass || ""
            } : null,
            twilio: cfg.twilio_sid ? {
              sid: cfg.twilio_sid,
              token: cfg.twilio_auth_token || "",
              phone: cfg.twilio_phone || ""
            } : null,
            github: cfg.github_token ? { token: cfg.github_token } : null,
            woo: cfg.woo_url ? {
              url: cfg.woo_url,
              consumer_key: cfg.woo_key || "",
              consumer_secret: cfg.woo_secret || ""
            } : null,
            shopify: cfg.shopify_url ? {
              url: cfg.shopify_url,
              api_key: cfg.shopify_api_key || ""
            } : null,
            database: cfg.db_connection_string ? { connection_string: cfg.db_connection_string } : null,
            google_drive: cfg.google_drive_folder ? { folder_id: cfg.google_drive_folder } : null,
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

// ==================== VERIFY TELEGRAM BOT TOKEN ====================
app.post("/api/verify-telegram-token", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ valid: false, error: "Token required" });

    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data: any = await resp.json();

    if (data.ok) {
      res.json({ valid: true, username: data.result.username, id: data.result.id, first_name: data.result.first_name });
    } else {
      res.json({ valid: false, error: data.description || "Invalid token" });
    }
  } catch (err: any) {
    res.status(500).json({ valid: false, error: err.message });
  }
});

// Connect the ADMIN agent's Telegram bot to the live EC2 OpenClaw instance.
// Verifies the token, saves it, then SSH-merges it into openclaw.json and restarts.
const ADMIN_TG_APPLY_SCRIPT = "/root/.openclaw/workspace/scripts/aba-admin-telegram-apply.py";

app.post("/api/agent-config/connect-telegram", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { token, bot_name } = req.body;
    if (!token) return res.status(400).json({ success: false, error: "Token required" });

    // 1. Verify token with Telegram
    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data: any = await resp.json();
    if (!data.ok) {
      return res.status(400).json({ success: false, error: data.description || "Invalid token" });
    }
    const username = data.result.username;

    // 2. Persist token + bot_name on the admin config
    const [existing]: any = await db.execute("SELECT id FROM aba_agent_configs WHERE user_id = ?", [userId]);
    if (existing.length > 0) {
      await db.execute("UPDATE aba_agent_configs SET telegram_bot_token=?, bot_name=?, telegram_bot_username=? WHERE user_id=?", [token, bot_name || '', username, userId]);
    } else {
      await db.execute("INSERT INTO aba_agent_configs (user_id, telegram_bot_token, bot_name, telegram_bot_username) VALUES (?, ?, ?, ?)", [userId, token, bot_name || '', username]);
    }

    // 3. Check deployment status
    const [depRows]: any = await db.execute("SELECT status, public_ip FROM aba_deployments WHERE user_id = ?", [userId]);
    const dep = depRows.length > 0 ? depRows[0] : null;
    if (!dep || dep.status !== 'active' || !dep.public_ip) {
      // Token saved, but no live server to apply to yet — it'll be picked up on next deploy.
      return res.json({ success: true, username, applied: false, message: "Token saved. Your bot will connect once your agent server is live." });
    }

    // 4. Apply to the live EC2 (await so the wizard gets a real result)
    await new Promise<void>((resolve, reject) => {
      let stderr = "";
      const child = spawn("python3", [ADMIN_TG_APPLY_SCRIPT, String(userId)], { stdio: ["ignore", "ignore", "pipe"] });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `apply exited ${code}`));
      });
      child.on("error", reject);
      // hard timeout so the request never hangs forever
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} reject(new Error("Apply timed out — your server may be slow to restart. Check back shortly.")); }, 90000);
    });

    res.json({ success: true, username, applied: true, message: `@${username} connected and live on your server.` });
  } catch (err: any) {
    console.error("Admin Telegram connect error:", err);
    res.status(500).json({ success: false, error: err.message || "Failed to connect Telegram bot" });
  }
});

// ==================== WHATSAPP PAIRING (via EC2 Agent HTTP API) ====================
// The EC2 runs a tiny agent-server on port 4321 that handles pairing directly.
// No SSH, no execSync, no bash spawns.

interface AgentApiStatus {
  stage: string;
  qr_data_url?: string | null;
  error?: string;
  creds_saved?: boolean;
  ts?: number;
}

async function agentApi(ip: string, method: string, path: string, body?: any): Promise<any> {
  const TOKEN = process.env.AGENT_TOKEN || 'aba-agent-4321-secure-key';
  const url = `http://${ip}:4321${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'x-agent-token': TOKEN,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => 'Agent API error');
    throw new Error(`Agent API ${method} ${path}: ${res.status} ${errText.slice(0, 200)}`);
  }
  return res.json();
}

// The gen-wa-qr-v4.js script content (embedded — no SCP needed)
let whatsappPairScript: string | null = null;

function getWhatsAppPairScript(): string {
  if (whatsappPairScript) return whatsappPairScript;
  whatsappPairScript = fs.readFileSync(path.join(__dirname, 'gen-wa-qr-v4.js'), 'utf-8');
  return whatsappPairScript!;
}

// Initiate WhatsApp pairing on the user's EC2 instance
app.post("/api/whatsapp/pair", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [depRows]: any = await db.execute(
      "SELECT public_ip FROM aba_deployments WHERE user_id=? AND status='active'", [userId]
    );
    if (!depRows.length || !depRows[0].public_ip) {
      return res.status(400).json({ error: "No active EC2 deployment found" });
    }
    const ip = depRows[0].public_ip;

    // Call the agent-server HTTP API (fire-and-forget, non-blocking)
    const scriptContent = getWhatsAppPairScript();
    const result = await agentApi(ip, 'POST', '/whatsapp/pair', { script_content: scriptContent });

    res.json(result);
  } catch (err: any) {
    console.error("WhatsApp pair error:", err);
    res.status(500).json({ error: err.message });
  }
});

// WhatsApp reconnection (clears old creds + activation, starts fresh pairing)
app.post("/api/whatsapp/reconnect", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [depRows]: any = await db.execute(
      "SELECT public_ip FROM aba_deployments WHERE user_id=? AND status='active'", [userId]
    );
    if (!depRows.length || !depRows[0].public_ip) {
      return res.status(400).json({ error: "No active EC2 deployment found" });
    }
    const ip = depRows[0].public_ip;

    const scriptContent = getWhatsAppPairScript();
    const result = await agentApi(ip, 'POST', '/whatsapp/reconnect', { script_content: scriptContent });

    res.json(result);
  } catch (err: any) {
    console.error("WhatsApp reconnect error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Poll WhatsApp pairing status
app.get("/api/whatsapp/pair-status", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [depRows]: any = await db.execute(
      "SELECT public_ip FROM aba_deployments WHERE user_id=? AND status='active'", [userId]
    );
    if (!depRows.length || !depRows[0].public_ip) {
      return res.json({ status: 'no_deployment' });
    }
    const ip = depRows[0].public_ip;

    const status = await agentApi(ip, 'GET', '/whatsapp/pair-status');

    // Auto-activate: when pairing completes, wire WhatsApp into OpenClaw config
    if (status.stage === 'connected') {
      // Fire-and-forget — user's frontend already shows connected
      agentApi(ip, 'POST', '/whatsapp/activate', {}).catch(err => {
        console.log('WA auto-activate (non-fatal):', err.message);
      });
    }

    res.json(status);
  } catch (err: any) {
    // If agent is unreachable, return initializing (poll will retry)
    res.json({ stage: 'initializing' });
  }
});

// Check if WhatsApp is already paired
app.get("/api/whatsapp/status", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const [depRows]: any = await db.execute(
      "SELECT public_ip FROM aba_deployments WHERE user_id=? AND status='active'", [userId]
    );
    if (!depRows.length || !depRows[0].public_ip) {
      return res.json({ paired: false });
    }
    const ip = depRows[0].public_ip;

    const status = await agentApi(ip, 'GET', '/whatsapp/status');
    res.json(status);
  } catch (err: any) {
    res.json({ paired: false });
  }
});

// ───── Team Agent WhatsApp Pairing ─────
// Per-agent WhatsApp linking: enters creds into the team agent's record
app.post("/api/team-agents/:id/whatsapp/pair", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const agentId = parseInt(req.params.id, 10);

    // Verify team agent belongs to this user
    const [taRows]: any = await db.execute(
      "SELECT id FROM aba_team_agents WHERE id=? AND user_id=?", [agentId, userId]
    );
    if (!taRows.length) return res.status(404).json({ error: "Team agent not found" });

    // Get the user's EC2
    const [depRows]: any = await db.execute(
      "SELECT public_ip FROM aba_deployments WHERE user_id=? AND status='active'", [userId]
    );
    if (!depRows.length || !depRows[0].public_ip) {
      return res.status(400).json({ error: "No active EC2 deployment found" });
    }
    const ip = depRows[0].public_ip;

    // Send the team pairing script to the agent-server
    const teamScriptContent = fs.readFileSync(path.join(__dirname, 'gen-wa-qr-v4-team.js'), 'utf-8');
    const result = await agentApi(ip, 'POST', '/whatsapp/pair-team/' + agentId, {
      script_content: teamScriptContent
    });

    res.json(result);
  } catch (err: any) {
    console.error("Team agent WA pair error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Poll per-team-agent WhatsApp pairing status
app.get("/api/team-agents/:id/whatsapp/pair-status", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const agentId = parseInt(req.params.id, 10);

    const [depRows]: any = await db.execute(
      "SELECT public_ip FROM aba_deployments WHERE user_id=? AND status='active'", [userId]
    );
    if (!depRows.length || !depRows[0].public_ip) {
      return res.json({ status: 'no_deployment' });
    }
    const ip = depRows[0].public_ip;

    const status = await agentApi(ip, 'GET', '/whatsapp/pair-team-status/' + agentId);

    // When team agent pairs, update DB
    if (status.stage === 'connected') {
      await db.execute(
        "UPDATE aba_team_agents SET wa_paired=1, status='active' WHERE id=? AND user_id=?", [agentId, userId]
      );
    }

    res.json(status);
  } catch (err: any) {
    res.json({ stage: 'initializing', agent_id: parseInt(req.params.id, 10) });
  }
});

// ==================== PER-TEAM-AGENT CHANNEL MANAGEMENT ====================

// ─═══ WhatsApp ─═══

// Activate WhatsApp for a team agent
app.post("/api/team-agents/:id/whatsapp/activate", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const agentId = parseInt(req.params.id, 10);

    // Verify team agent belongs to this user
    const [taRows]: any = await db.execute(
      "SELECT id, agent_name, agent_slug, role, personality FROM aba_team_agents WHERE id=? AND user_id=?", [agentId, userId]
    );
    if (!taRows.length) return res.status(404).json({ error: "Team agent not found" });
    const ta = taRows[0];

    const [depRows]: any = await db.execute(
      "SELECT public_ip FROM aba_deployments WHERE user_id=? AND status='active'", [userId]
    );
    if (!depRows.length || !depRows[0].public_ip) {
      return res.status(400).json({ error: "No active EC2 deployment found" });
    }
    const ip = depRows[0].public_ip;

    const result = await agentApi(ip, 'POST', '/whatsapp/activate-team/' + agentId, {
      agent_slug: ta.agent_slug || 'team-' + agentId,
      agent_name: ta.agent_name,
      agent_role: ta.role,
      agent_personality: ta.personality
    });

    res.json(result);
  } catch (err: any) {
    console.error("Team agent WA activate error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Check activation status for a team agent's WhatsApp
app.get("/api/team-agents/:id/whatsapp/activate-status", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const agentId = parseInt(req.params.id, 10);

    const [depRows]: any = await db.execute(
      "SELECT public_ip FROM aba_deployments WHERE user_id=? AND status='active'", [userId]
    );
    if (!depRows.length || !depRows[0].public_ip) {
      return res.json({ activated: false });
    }
    const ip = depRows[0].public_ip;

    const status = await agentApi(ip, 'GET', '/whatsapp/activate-team-status/' + agentId);
    res.json(status);
  } catch {
    res.json({ activated: false });
  }
});

// Disconnect WhatsApp for a team agent
app.post("/api/team-agents/:id/whatsapp/disconnect", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const agentId = parseInt(req.params.id, 10);

    const [depRows]: any = await db.execute(
      "SELECT public_ip FROM aba_deployments WHERE user_id=? AND status='active'", [userId]
    );
    if (!depRows.length || !depRows[0].public_ip) {
      return res.status(400).json({ error: "No active EC2 deployment found" });
    }
    const ip = depRows[0].public_ip;

    const [taRows]: any = await db.execute(
      "SELECT agent_slug FROM aba_team_agents WHERE id=? AND user_id=?", [agentId, userId]
    );
    const agentSlug = taRows.length ? (taRows[0].agent_slug || 'team-' + agentId) : 'team-' + agentId;

    await agentApi(ip, 'POST', '/whatsapp/disconnect-team/' + agentId, { agent_slug: agentSlug });

    // Update DB
    await db.execute(
      "UPDATE aba_team_agents SET wa_paired=0 WHERE id=? AND user_id=?", [agentId, userId]
    );

    res.json({ success: true, message: 'WhatsApp disconnected' });
  } catch (err: any) {
    console.error("Team agent WA disconnect error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─═══ Telegram ─═══

// Configure Telegram for a team agent (post-deploy)
app.post("/api/team-agents/:id/telegram/connect", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const agentId = parseInt(req.params.id, 10);
    const { bot_token } = req.body;
    if (!bot_token) return res.status(400).json({ error: "bot_token required" });

    // Validate token
    const valResp = await fetch(`https://api.telegram.org/bot${bot_token}/getMe`);
    const valData: any = await valResp.json();
    if (!valData.ok) return res.status(400).json({ error: "Invalid Telegram bot token" });
    const botUsername = valData.result.username;

    // Verify team agent belongs to this user
    const [taRows]: any = await db.execute(
      "SELECT id, agent_slug, agent_name, role, personality FROM aba_team_agents WHERE id=? AND user_id=?", [agentId, userId]
    );
    if (!taRows.length) return res.status(404).json({ error: "Team agent not found" });
    const ta = taRows[0];

    const [depRows]: any = await db.execute(
      "SELECT public_ip FROM aba_deployments WHERE user_id=? AND status='active'", [userId]
    );
    if (!depRows.length || !depRows[0].public_ip) {
      return res.status(400).json({ error: "No active EC2 deployment found" });
    }
    const ip = depRows[0].public_ip;

    // Update DB first
    await db.execute(
      "UPDATE aba_team_agents SET telegram_bot_token=?, telegram_bot_username=? WHERE id=? AND user_id=?",
      [bot_token, botUsername, agentId, userId]
    );

    // Tell agent-server
    await agentApi(ip, 'POST', '/team/configure-telegram/' + agentId, {
      bot_token,
      agent_slug: ta.agent_slug || 'team-' + agentId,
      agent_name: ta.agent_name,
      agent_role: ta.role,
      agent_personality: ta.personality
    });

    res.json({ success: true, bot_username: botUsername });
  } catch (err: any) {
    console.error("Team agent Telegram connect error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Disconnect Telegram for a team agent
app.post("/api/team-agents/:id/telegram/disconnect", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const agentId = parseInt(req.params.id, 10);

    const [depRows]: any = await db.execute(
      "SELECT public_ip FROM aba_deployments WHERE user_id=? AND status='active'", [userId]
    );
    if (!depRows.length || !depRows[0].public_ip) {
      return res.status(400).json({ error: "No active EC2 deployment found" });
    }
    const ip = depRows[0].public_ip;

    const [taRows]: any = await db.execute(
      "SELECT agent_slug FROM aba_team_agents WHERE id=? AND user_id=?", [agentId, userId]
    );
    const agentSlug = taRows.length ? (taRows[0].agent_slug || 'team-' + agentId) : 'team-' + agentId;

    await agentApi(ip, 'POST', '/team/disconnect-telegram/' + agentId, { agent_slug: agentSlug });

    // Update DB
    await db.execute(
      "UPDATE aba_team_agents SET telegram_bot_token=NULL, telegram_bot_username=NULL WHERE id=? AND user_id=?", [agentId, userId]
    );

    res.json({ success: true, message: 'Telegram disconnected' });
  } catch (err: any) {
    console.error("Team agent Telegram disconnect error:", err);
    res.status(500).json({ error: err.message });
  }
});


// ==================== OLD TELEGRAM SETUP (via SSH) ====================

// Set Telegram channel on a deployed EC2 (post-deploy, no re-deploy needed)
app.post("/api/agent/set-telegram", authMiddleware, async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { bot_token } = req.body;
    if (!bot_token) return res.status(400).json({ error: "bot_token required" });

    // Validate token via Telegram API
    const valResp = await fetch(`https://api.telegram.org/bot${bot_token}/getMe`);
    const valData: any = await valResp.json();
    if (!valData.ok) return res.status(400).json({ error: "Invalid Telegram bot token" });
    const botUsername = valData.result.username;

    // Get deployment info
    const [depRows]: any = await db.execute(
      "SELECT public_ip FROM aba_deployments WHERE user_id=? AND status='active'", [userId]
    );
    if (!depRows.length || !depRows[0].public_ip) {
      return res.status(400).json({ error: "No active EC2 deployment found" });
    }
    const ip = depRows[0].public_ip;

    // Save token to DB
    await db.execute(
      "UPDATE aba_agent_configs SET telegram_bot_token=?, telegram_bot_username=? WHERE user_id=?",
      [bot_token, botUsername, userId]
    );

    // Tell agent-server to configure Telegram (via HTTP)
    await agentApi(ip, 'POST', '/telegram/configure', { bot_token });

    res.json({ success: true, bot_username: botUsername });
  } catch (err: any) {
    console.error("Telegram setup error:", err);
    res.status(500).json({ error: err.message });
  }
});


app.listen(PORT, "0.0.0.0", () => {
  console.log(`ABA API server running on port ${PORT}`);
});
