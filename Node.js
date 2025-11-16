// ==========================================================
// Overseas Access Tracker API - FULL VERSION (Accounts + Companies + Trips)
// ==========================================================
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 4000;
app.use(cors());
app.use(express.json());

// const dbConfig = {
//   host: 'sql.freedb.tech',
//   user: 'freedb_abhishek',
//   password: 'f*udP%?eaHsC6&J',
//   database: 'freedb_overseas_access_tracker',
//   port: 3306,
//   waitForConnections: true,
//   connectionLimit: 10,
//   queueLimit: 0,
// };


const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: true }
};


let db;

// ------------------------------------------------------------
// CREATE TABLES
// ------------------------------------------------------------
async function createTables(pool) {
  const queries = [
    `
    CREATE TABLE IF NOT EXISTS accounts (
      account_id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(100) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('ADMIN','STAFF','USER') DEFAULT 'USER',
      is_active TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    `,
    `
    CREATE TABLE IF NOT EXISTS companies (
      company_id INT AUTO_INCREMENT PRIMARY KEY,
      company_name VARCHAR(200) NOT NULL UNIQUE,
      is_active TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    `,
    `
    CREATE TABLE IF NOT EXISTS trips (
      trip_id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      company_id INT,
      name VARCHAR(150) NOT NULL,
      email VARCHAR(150) NOT NULL,
      notes TEXT,
      departure_date DATE NOT NULL,
      return_date DATE NOT NULL,
      status ENUM('ACTIVE','UPCOMING','COMPLETED','RETURNED') DEFAULT 'UPCOMING',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
      FOREIGN KEY (company_id) REFERENCES companies(company_id) ON DELETE SET NULL
    );
    `,
  ];
  for (const q of queries) await pool.query(q);
  console.log('✅ Tables checked/created');
}

// ------------------------------------------------------------
// ENSURE DEFAULT ADMIN
// ------------------------------------------------------------
async function ensureDefaultAdmin(pool) {
  const [rows] = await pool.query(
    "SELECT COUNT(*) AS cnt FROM accounts WHERE role='ADMIN'"
  );
  if (rows[0].cnt === 0) {
    const hash = await bcrypt.hash('Admin@123', 10);
    await pool.query(
      "INSERT INTO accounts (username, password_hash, role) VALUES (?,?, 'ADMIN')",
      ['admin', hash]
    );
    console.log("✅ Default admin created: username='admin', password='Admin@123'");
  } else console.log('ℹ️ Admin already exists.');
}

// ------------------------------------------------------------
// ROUTES
// ------------------------------------------------------------
app.get('/', (_, res) => res.send('✅ Overseas Access Tracker API running.'));

// ---------- LOGIN ----------
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password)
      return res.json({ success: false, message: 'Missing credentials' });

    const [rows] = await db.query(
      'SELECT account_id, username, password_hash, role, is_active FROM accounts WHERE username=?',
      [username]
    );
    if (!rows.length)
      return res.json({ success: false, message: 'User not found' });

    const user = rows[0];
    if (!user.is_active)
      return res.json({ success: false, message: 'Account disabled' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.json({ success: false, message: 'Invalid password' });

    res.json({
      success: true,
      message: 'Login successful',
      role: user.role,
      account_id: user.account_id,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ---------- COMPANIES ----------
app.post('/api/admin/company/add', async (req, res) => {
  try {
    const { company_name } = req.body || {};
    if (!company_name) return res.json({ ok: false, error: 'Company name required' });

    await db.query('INSERT IGNORE INTO companies (company_name) VALUES (?)', [
      company_name.trim(),
    ]);
    res.json({ ok: true, message: 'Company added successfully' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Add company failed' });
  }
});

app.get('/api/admin/companies/list', async (_, res) => {
  try {
    const [rows] = await db.query(
      'SELECT company_id, company_name, is_active, created_at FROM companies ORDER BY company_name ASC'
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Fetch companies failed' });
  }
});

// ---------- USERS ----------
app.post('/api/admin/user/add', async (req, res) => {
  try {
    const { username, password, role } = req.body || {};
    if (!username || !password || !role)
      return res.json({ ok: false, error: 'Missing fields' });

    const hash = await bcrypt.hash(password, 10);
    await db.query('INSERT INTO accounts (username, password_hash, role) VALUES (?,?,?)', [
      username.trim(),
      hash,
      role.toUpperCase(),
    ]);
    res.json({ ok: true, message: 'User added' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Add user failed' });
  }
});

app.get('/api/admin/users/list', async (_, res) => {
  try {
    const [rows] = await db.query(
      'SELECT account_id, username, role, is_active, created_at FROM accounts ORDER BY username ASC'
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Fetch users failed' });
  }
});

// ---------- TRIPS ----------

app.post('/api/trips/add', async (req, res) => {
  try {
    let { username, company_name, name, email, notes, departure_date, return_date } = req.body || {};

    if (!username || !company_name || !name || !email || !departure_date || !return_date)
      return res.json({ ok: false, error: "Missing required fields" });

    // ✅ USER
    const [userRows] = await db.query("SELECT account_id FROM accounts WHERE username=?", [username]);
    if (!userRows.length) return res.json({ ok: false, error: "User not found" });
    const user_id = userRows[0].account_id;

    // ✅ COMPANY
    const [companyRows] = await db.query(
      "SELECT company_id FROM companies WHERE LOWER(TRIM(company_name)) = LOWER(TRIM(?))",
      [company_name]
    );
    if (!companyRows.length) return res.json({ ok: false, error: "Company not found" });
    const company_id = companyRows[0].company_id;

    // ✅ Clean date formats
    departure_date = cleanDate(departure_date);
    return_date = cleanDate(return_date);

    // ✅ Validate + Determine status
    const check = validateAndDetermineStatus(departure_date, return_date);
    if (!check.ok) return res.json({ ok: false, error: check.error });
    const status = check.status;

    // ✅ Insert into DB
    const [result] = await db.query(
      `INSERT INTO trips 
      (user_id, company_id, name, email, notes, departure_date, return_date, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,NOW(),NOW())`,
      [user_id, company_id, name, email, notes || "", departure_date, return_date, status]
    );

    return res.json({
      ok: true,
      message: "Trip added successfully",
      trip_id: result.insertId,
      status
    });

  } catch (err) {
    console.error("❌ Add trip error:", err);
    res.status(500).json({ ok: false, error: "Failed to add trip." });
  }
});



// ---------- LIST ALL TRIPS (timezone-safe + final status calculation) ----------
app.get('/api/trips/list', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT 
        t.trip_id,
        t.user_id,
        t.company_id,
        t.name,
        t.email,
        t.notes,
        t.status AS db_status,            -- ✅ Keep DB status
        c.company_name,
        DATE_FORMAT(t.departure_date, '%Y-%m-%d') AS departure_date,
        DATE_FORMAT(t.return_date, '%Y-%m-%d') AS return_date,
        a.username AS created_by,
        t.created_at
      FROM trips t
      LEFT JOIN companies c ON t.company_id = c.company_id
      LEFT JOIN accounts a ON t.user_id = a.account_id
      ORDER BY t.departure_date DESC
    `);

    const today = new Date().toISOString().split("T")[0];

    const fixed = rows.map(t => {
      let dep = cleanDate(t.departure_date);
      let ret = cleanDate(t.return_date);
      let status = t.db_status;   // ✅ Trust DB status first

      // ✅ Fix swapped dates (rare)
      if (dep > ret) {
        const temp = dep;
        dep = ret;
        ret = temp;
      }

      // ✅ ONLY RECALCULATE IF NOT COMPLETED
      if (status !== "COMPLETED") {
        if (ret < today) status = "COMPLETED";
        else if (dep <= today && ret >= today) status = "ACTIVE";
        else status = "UPCOMING";
      }

      return {
        ...t,
        departure_date: dep,
        return_date: ret,
        status
      };
    });

    res.json(fixed);

  } catch (err) {
    console.error("❌ trips/list error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch trips" });
  }
});






// ✅ Mark trip as returned (set status=COMPLETED and update return_date)
app.post('/api/trips/markReturned', async (req, res) => {
  const { trip_id, return_date } = req.body;
  if (!trip_id) return res.status(400).json({ ok: false, error: "trip_id required" });

  try {
    const today = return_date || new Date().toISOString().slice(0, 10);

    const [result] = await db.execute(
      `UPDATE trips 
       SET status = 'COMPLETED',
           return_date = ?,
           updated_at = NOW()
       WHERE trip_id = ?`,
      [today, trip_id]
    );

    if (result.affectedRows > 0) {
      console.log(`✅ Trip ${trip_id} marked as returned (${today})`);
      res.json({ ok: true });
    } else {
      res.status(404).json({ ok: false, error: "Trip not found" });
    }
  } catch (err) {
    console.error("❌ mark-returned error:", err);
    res.status(500).json({ ok: false, error: "Database error" });
  }
});



// ---------- UPDATE TRIP (auto-resolve company_id) ----------
app.post('/api/trips/update', async (req, res) => {
  try {
    let { trip_id, company_name, name, email, notes, departure_date, return_date } = req.body || {};

    if (!trip_id) return res.json({ ok: false, error: "trip_id is required" });

    // ✅ COMPANY
    const [cRows] = await db.query(
      "SELECT company_id FROM companies WHERE LOWER(TRIM(company_name)) = LOWER(TRIM(?))",
      [company_name]
    );
    const company_id = cRows.length ? cRows[0].company_id : null;

    // ✅ Clean dates
    departure_date = cleanDate(departure_date);
    return_date = cleanDate(return_date);

    // ✅ Validate + Determine status
    const check = validateAndDetermineStatus(departure_date, return_date);
    if (!check.ok) return res.json({ ok: false, error: check.error });
    const status = check.status;

    // ✅ DB update
    const [result] = await db.query(
      `UPDATE trips SET 
        company_id=?, name=?, email=?, notes=?, 
        departure_date=?, return_date=?, status=?, updated_at=NOW()
       WHERE trip_id=?`,
      [company_id, name, email, notes || "", departure_date, return_date, status, trip_id]
    );

    if (!result.affectedRows)
      return res.json({ ok: false, error: "Trip not found" });

    return res.json({
      ok: true,
      message: "Trip updated successfully",
      status,
      company_id
    });

  } catch (err) {
    console.error("❌ Update trip error:", err);
    res.status(500).json({ ok: false, error: "Failed to update trip." });
  }
});


// ✅ DELETE TRIP
app.post('/api/trips/delete', async (req, res) => {
  const { trip_id } = req.body;
  if (!trip_id) return res.json({ ok: false, error: "trip_id required" });

  try {
    const [row] = await db.query("SELECT trip_id FROM trips WHERE trip_id=?", [trip_id]);
    if (!row.length) return res.json({ ok: false, error: "Trip not found" });

    await db.query("DELETE FROM trips WHERE trip_id=?", [trip_id]);

    res.json({ ok: true, message: "Trip deleted" });

  } catch (err) {
    console.error("❌ Delete trip error:", err);
    res.status(500).json({ ok: false, error: "Failed to delete trip" });
  }
});




// ✅ VALIDATION + STATUS DECISION LOGIC
function validateAndDetermineStatus(dep, ret) {
  const today = new Date().toISOString().split("T")[0];

  if (!dep || !ret) return { ok: false, error: "Invalid dates" };

  // ✅ Departure must be <= return date
  if (dep > ret) {
    return { ok: false, error: "Return date cannot be before departure date" };
  }

  // ✅ Determine status
  let status = "UPCOMING";

  if (ret < today) status = "COMPLETED";
  else if (dep <= today && ret >= today) status = "ACTIVE";
  else if (dep > today) status = "UPCOMING";

  return { ok: true, status };
}

// ✅ Format safe YYYY-MM-DD
function cleanDate(d) {
  if (!d) return null;
  let s = String(d);
  return s.includes("T") ? s.split("T")[0] : s;
}

// ------------------------------------------------------------
// ✉️ DAILY ADMIN EMAIL ALERT (Sydney time, fixed +1 day UTC offset)
// ------------------------------------------------------------
const cron = require("node-cron");
const nodemailer = require("nodemailer");

// === CONFIG ===
const ADMIN_EMAIL = "abirijal2012@gmail.com";
const SENDER_EMAIL = "princerijal2012@gmail.com";
const SENDER_APP_PASSWORD = "gjcy bpdw eoko ylof";

// === Mail Transporter ===
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: SENDER_EMAIL, pass: SENDER_APP_PASSWORD },
});

// === Helper to Send Email ===
async function sendMail(to, subject, text) {
  try {
    await transporter.sendMail({
      from: `"Overseas Access Tracker" <${SENDER_EMAIL}>`,
      to,
      subject,
      text,
    });
    console.log(`📧 Email sent to ${to}`);
  } catch (err) {
    console.error("❌ Email send failed:", err.message);
  }
}

// ✅ Format date correctly for Sydney (+1 day if UTC)
function formatSydneyDate(utcDateStr) {
  if (!utcDateStr) return "";
  const d = new Date(utcDateStr);
  // Push +1 day to match Sydney calendar day when UTC stored
  d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0];
}

// ✅ Manual trigger endpoint
app.get("/api/test-daily-email", async (req, res) => {
  console.log("🧪 Running daily email summary (Sydney timezone)…");

  try {
    // Fetch trips normally
    const [trips] = await db.query(`
      SELECT 
        t.name, 
        c.company_name,
        t.departure_date,
        t.return_date,
        t.status
      FROM trips t
      LEFT JOIN companies c ON c.company_id = t.company_id
      ORDER BY t.name
    `);

    // --- Figure out Sydney "today" and "yesterday" ---
    const nowSydney = new Date(
      new Date().toLocaleString("en-US", { timeZone: "Australia/Sydney" })
    );
    const todaySydney = nowSydney.toISOString().split("T")[0];
    const yesterdaySydney = new Date(nowSydney.getTime() - 86400000)
      .toISOString()
      .split("T")[0];

    // --- Filter trips ---
    const startingToday = trips.filter(
      (t) => formatSydneyDate(t.departure_date) === todaySydney
    );
    const completedYesterday = trips.filter(
      (t) =>
        formatSydneyDate(t.return_date) === yesterdaySydney &&
        ["COMPLETED", "RETURNED"].includes(t.status)
    );

    // --- Build email text ---
    // --- Build well-formatted email text ---
const todayStr = nowSydney.toLocaleDateString("en-AU");

let report = `==============================
📅  DAILY TRIP SUMMARY – ${todayStr}
==============================\n\n`;

if (!startingToday.length && !completedYesterday.length) {
  report += "No trips starting today or completed yesterday.\n";
} else {
  if (startingToday.length) {
    report += `✈️  Trips Starting Today (${startingToday.length})\n`;
    report += "---------------------------------\n";
    for (const t of startingToday) {
      report += `• Name: ${t.name}\n`;
      report += `  Company: ${t.company_name || "No company"}\n`;
      report += `  Departure Date: ${formatSydneyDate(t.departure_date)}\n\n`;
    }
  }

  if (completedYesterday.length) {
    report += `🏁  Trips Completed Yesterday (${completedYesterday.length})\n`;
    report += "---------------------------------\n";
    for (const t of completedYesterday) {
      report += `• Name: ${t.name}\n`;
      report += `  Company: ${t.company_name || "No company"}\n`;
      report += `  Return Date: ${formatSydneyDate(t.return_date)}\n\n`;
    }
  }
}

report += "---------------------------------\n";
report += "🕒  Report generated automatically by Overseas Access Tracker.\n";
report += "Please do not reply to this message.\n";


    // --- Send email ---
    await sendMail(ADMIN_EMAIL, `Daily Trip Summary – ${todayStr}`, report);
    console.log("✅ Email sent successfully.");

    res.json({
      ok: true,
      starting: startingToday.length,
      completed: completedYesterday.length,
      message: "Email sent successfully.",
    });
  } catch (err) {
    console.error("❌ Daily email error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ✅ Schedule to run every day at 9:00 AM Sydney time
cron.schedule(
  "0 8 * * *",
  async () => {
    await fetch("http://localhost:4000/api/test-daily-email");
  },
  { timezone: "Australia/Sydney" }
);


// ------------------------------------------------------------
// 🕓 AUTO STATUS UPDATE SYSTEM (runs daily)
// ------------------------------------------------------------
// Run every day at 12:05 AM Sydney time
cron.schedule(
  "5 0 * * *",
  async () => {
    console.log("🔄 Running daily trip status auto-update...");

    try {
      // 1️⃣ Update UPCOMING → ACTIVE (when today = departure_date)
      const [activeRes] = await db.query(`
        UPDATE trips
        SET status = 'ACTIVE',
            updated_at = NOW()
        WHERE status = 'UPCOMING'
          AND DATE(departure_date) = CURDATE();
      `);

      // 2️⃣ Update ACTIVE → COMPLETED (1 day after return_date)
      const [completedRes] = await db.query(`
        UPDATE trips
        SET status = 'COMPLETED',
            updated_at = NOW()
        WHERE status = 'ACTIVE'
          AND DATE(return_date) < DATE_SUB(CURDATE(), INTERVAL 0 DAY);
      `);

      console.log(
        `✅ Trip status updated: ${activeRes.affectedRows} activated, ${completedRes.affectedRows} completed.`
      );
    } catch (err) {
      console.error("❌ Trip status auto-update failed:", err);
    }
  },
  { timezone: "Australia/Sydney" }
);

// ------------------------------------------------------------
// 🔐 ADMIN CHANGE USER PASSWORD (BY USERNAME)
// ------------------------------------------------------------

app.post("/api/admin/user/change-password", async (req, res) => {
  try {
    const { username, new_password } = req.body || {};

    if (!username || !new_password)
      return res.json({ ok: false, error: "Missing username or new_password" });

    // 🔍 Find user by username
    const [rows] = await db.query(
      "SELECT account_id FROM accounts WHERE LOWER(username) = LOWER(?)",
      [username.trim()]
    );

    if (!rows.length)
      return res.json({ ok: false, error: "User not found" });

    const hash = await bcrypt.hash(new_password, 10);

    // ✅ Update password
    await db.query(
      "UPDATE accounts SET password_hash = ?, updated_at = NOW() WHERE username = ?",
      [hash, username.trim()]
    );

    console.log(`✅ Password changed for user: ${username}`);
    res.json({ ok: true, message: "Password updated successfully" });

  } catch (err) {
    console.error("❌ Change password error:", err);
    res.status(500).json({ ok: false, error: "Server error while updating password" });
  }
});

// Delete user
app.post("/api/admin/user/delete", async (req, res) => {
  try {
    const { username } = req.body || {};
    if (!username) return res.json({ ok: false, error: "Missing username" });

    const [rows] = await db.query("SELECT account_id FROM accounts WHERE username = ?", [username]);
    if (!rows.length) return res.json({ ok: false, error: "User not found" });

    await db.query("DELETE FROM accounts WHERE username = ?", [username]);
    res.json({ ok: true, message: "User deleted successfully" });
  } catch (err) {
    console.error("❌ Delete user error:", err);
    res.status(500).json({ ok: false, error: "Server error while deleting user" });
  }
});

// Delete company
app.post("/api/admin/company/delete", async (req, res) => {
  try {
    const { company_name } = req.body || {};
    if (!company_name) return res.json({ ok: false, error: "Missing company_name" });

    const [rows] = await db.query("SELECT company_id FROM companies WHERE company_name = ?", [company_name]);
    if (!rows.length) return res.json({ ok: false, error: "Company not found" });

    await db.query("DELETE FROM companies WHERE company_name = ?", [company_name]);
    res.json({ ok: true, message: "Company deleted successfully" });
  } catch (err) {
    console.error("❌ Delete company error:", err);
    res.status(500).json({ ok: false, error: "Server error while deleting company" });
  }
});




// ------------------------------------------------------------
// START SERVER
// ------------------------------------------------------------
async function startServer() {
  try {
    db = await mysql.createPool(dbConfig);
    console.log('✅ Connected to MySQL');

    await createTables(db);
    await ensureDefaultAdmin(db);

    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  } catch (err) {
    console.error('❌ Startup failed:', err);
    process.exit(1);
  }
}

startServer();
