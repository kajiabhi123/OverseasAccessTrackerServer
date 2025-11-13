// overseasTracker.js
const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcryptjs');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 4000;

// ---------- Middleware ----------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- DB Config ----------
const dbConfig = {
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || 'your_mysql_password',
    database: process.env.DB_NAME || 'overseas_access_tracker'
};

const connection = mysql.createConnection(dbConfig);

// ---------- Connect + setup tables ----------
connection.connect(err => {
    if (err) {
        console.error('DB connect error:', err.stack);
        return;
    }
    console.log('Connected to DB as id ' + connection.threadId);

    const tableQueries = [

        // companies table
        `
        CREATE TABLE IF NOT EXISTS companies (
            company_id          INT AUTO_INCREMENT PRIMARY KEY,
            company_name        VARCHAR(100) NOT NULL UNIQUE,
            is_active           TINYINT(1) NOT NULL DEFAULT 1,
            created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        `,

        // app_accounts table
        `
        CREATE TABLE IF NOT EXISTS app_accounts (
            account_id      INT AUTO_INCREMENT PRIMARY KEY,
            username        VARCHAR(50) NOT NULL UNIQUE,
            password_hash   VARCHAR(255) NOT NULL,
            role            ENUM('ADMIN','STAFF') NOT NULL DEFAULT 'STAFF',
            is_active       TINYINT(1) NOT NULL DEFAULT 1,
            created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        `,

        // users table (travellers)
        `
        CREATE TABLE IF NOT EXISTS users (
            user_id         INT AUTO_INCREMENT PRIMARY KEY,
            full_name       VARCHAR(100) NOT NULL,
            work_email      VARCHAR(150) NOT NULL,
            company_id      INT NOT NULL,
            is_active       TINYINT(1) NOT NULL DEFAULT 1,
            created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT fk_users_company
                FOREIGN KEY (company_id)
                REFERENCES companies(company_id)
                ON UPDATE CASCADE
                ON DELETE RESTRICT
        );
        `,

        // trips table
        `
        CREATE TABLE IF NOT EXISTS trips (
            trip_id             INT AUTO_INCREMENT PRIMARY KEY,

            user_id             INT NOT NULL,
            company_id          INT NOT NULL,

            depart_date         DATE NOT NULL,
            return_date         DATE NOT NULL,

            notes               TEXT NULL,

            status              ENUM('PLANNED','ACTIVE','COMPLETED','CANCELLED')
                                NOT NULL DEFAULT 'PLANNED',

            version             INT NOT NULL DEFAULT 1,

            last_modified_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP,
            last_modified_by    INT NULL,

            created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP,

            CONSTRAINT fk_trips_user
                FOREIGN KEY (user_id)
                REFERENCES users(user_id)
                ON UPDATE CASCADE
                ON DELETE RESTRICT,

            CONSTRAINT fk_trips_company
                FOREIGN KEY (company_id)
                REFERENCES companies(company_id)
                ON UPDATE CASCADE
                ON DELETE RESTRICT,

            CONSTRAINT fk_trips_last_modified_by
                FOREIGN KEY (last_modified_by)
                REFERENCES app_accounts(account_id)
                ON UPDATE CASCADE
                ON DELETE SET NULL
        );
        `,

        // audit_logs table
        `
        CREATE TABLE IF NOT EXISTS audit_logs (
            audit_id        BIGINT AUTO_INCREMENT PRIMARY KEY,
            account_id      INT NULL,
            trip_id         INT NULL,
            action_type     VARCHAR(50) NOT NULL,
            action_details  TEXT NULL,
            created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

            CONSTRAINT fk_audit_account
                FOREIGN KEY (account_id)
                REFERENCES app_accounts(account_id)
                ON UPDATE CASCADE
                ON DELETE SET NULL,

            CONSTRAINT fk_audit_trip
                FOREIGN KEY (trip_id)
                REFERENCES trips(trip_id)
                ON UPDATE CASCADE
                ON DELETE SET NULL
        );
        `,

        // helpful indexes
        `CREATE INDEX IF NOT EXISTS idx_companies_active ON companies (is_active);`,
        `CREATE INDEX IF NOT EXISTS idx_app_accounts_active ON app_accounts (is_active);`,
        `CREATE INDEX IF NOT EXISTS idx_users_email ON users (work_email);`,
        `CREATE INDEX IF NOT EXISTS idx_users_company ON users (company_id);`,
        `CREATE INDEX IF NOT EXISTS idx_users_active ON users (is_active);`,
        `CREATE INDEX IF NOT EXISTS idx_trips_status ON trips (status);`,
        `CREATE INDEX IF NOT EXISTS idx_trips_dates ON trips (depart_date, return_date);`,
        `CREATE INDEX IF NOT EXISTS idx_trips_company ON trips (company_id);`,
        `CREATE INDEX IF NOT EXISTS idx_trips_user ON trips (user_id);`,
        `CREATE INDEX IF NOT EXISTS idx_audit_trip ON audit_logs (trip_id);`,
        `CREATE INDEX IF NOT EXISTS idx_audit_account ON audit_logs (account_id);`,
        `CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_logs (action_type);`,
        `CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs (created_at);`
    ];

    tableQueries.forEach(q => {
        connection.query(q, err2 => {
            if (err2) console.error('Table creation error:', err2);
        });
    });

    // Seed default admin if not exists
    const seedAdminSql = `
        SELECT account_id FROM app_accounts WHERE username = 'admin' LIMIT 1;
    `;
    connection.query(seedAdminSql, async (checkErr, rows) => {
        if (checkErr) {
            console.error('Seed check error:', checkErr);
            return;
        }
        if (rows.length === 0) {
            const hash = await bcrypt.hash('admin123', 10);
            const insertAdminSql = `
                INSERT INTO app_accounts (username, password_hash, role, is_active)
                VALUES ('admin', ?, 'ADMIN', 1)
            `;
            connection.query(insertAdminSql, [hash], err3 => {
                if (err3) {
                    console.error('Admin seed insert error:', err3);
                } else {
                    console.log('Seeded default admin (admin/admin123)');
                }
            });
        }
    });
});

// ---------- Helpers ----------

// audit writer
function writeAudit(accountId, tripId, action_type, detailsText) {
    const sql = `
        INSERT INTO audit_logs (account_id, trip_id, action_type, action_details)
        VALUES (?, ?, ?, ?)
    `;
    connection.query(
        sql,
        [accountId || null, tripId || null, action_type, detailsText || null],
        err => {
            if (err) console.error('audit insert error:', err);
        }
    );
}

// create-or-reuse traveller user
function findOrCreateUser(full_name, work_email, company_id) {
    return new Promise((resolve, reject) => {
        const findSql = `
            SELECT user_id
            FROM users
            WHERE work_email = ? AND company_id = ?
            LIMIT 1
        `;
        connection.query(findSql, [work_email, company_id], (err, rows) => {
            if (err) return reject(err);

            if (rows.length > 0) {
                return resolve(rows[0].user_id);
            }

            const insertSql = `
                INSERT INTO users (full_name, work_email, company_id, is_active)
                VALUES (?, ?, ?, 1)
            `;
            connection.query(
                insertSql,
                [full_name, work_email, company_id],
                (err2, result2) => {
                    if (err2) return reject(err2);
                    resolve(result2.insertId);
                }
            );
        });
    });
}

// ---------- Auth Middlewares ----------

// requireAuth: must be logged in, active account
function requireAuth(req, res, next) {
    const accountIdHeader = req.header('X-Account-Id');
    if (!accountIdHeader) {
        return res.status(401).json({ error: 'Missing X-Account-Id header' });
    }

    const sql = `
        SELECT account_id, role, is_active
        FROM app_accounts
        WHERE account_id = ?
        LIMIT 1
    `;
    connection.query(sql, [accountIdHeader], (err, rows) => {
        if (err) {
            console.error('auth error:', err);
            return res.status(500).json({ error: 'Server error' });
        }
        if (rows.length === 0 || rows[0].is_active !== 1) {
            return res.status(401).json({ error: 'Account not active' });
        }

        req.accountId = parseInt(accountIdHeader, 10);
        req.accountRole = rows[0].role; // "ADMIN" or "STAFF"
        next();
    });
}

// requireAdmin: must be ADMIN
function requireAdmin(req, res, next) {
    if (req.accountRole !== 'ADMIN') {
        return res.status(403).json({ error: 'Admin only' });
    }
    next();
}

// ---------- Routes ----------

// Health
app.get('/', (req, res) => {
    res.send('Overseas Access Tracker API is running');
});

// ===== AUTH =====

// POST /api/login
// body: { username, password }
// returns { account_id, role }
app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};

    if (!username || !password) {
        return res.status(400).json({ error: 'username and password required' });
    }

    const sql = `
        SELECT account_id, username, password_hash, role, is_active
        FROM app_accounts
        WHERE username = ?
        LIMIT 1
    `;
    connection.query(sql, [username], async (err, rows) => {
        if (err) {
            console.error('login error:', err);
            return res.status(500).json({ error: 'Server error' });
        }

        if (rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const acct = rows[0];
        if (acct.is_active !== 1) {
            return res.status(403).json({ error: 'Account disabled' });
        }

        const ok = await bcrypt.compare(password, acct.password_hash);
        if (!ok) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        writeAudit(acct.account_id, null, 'LOGIN_SUCCESS', `User ${acct.username} logged in`);

        res.json({
            account_id: acct.account_id,
            role: acct.role
        });
    });
});

// ===== COMPANIES (client list for dropdown etc.) =====

// GET /api/companies
// header: X-Account-Id
app.get('/api/companies', requireAuth, (req, res) => {
    const sql = `
        SELECT company_id, company_name
        FROM companies
        WHERE is_active = 1
        ORDER BY company_name ASC
    `;
    connection.query(sql, (err, rows) => {
        if (err) {
            console.error('get companies error:', err);
            return res.status(500).json({ error: 'Server error' });
        }
        res.json(rows);
    });
});

// ===== TRIPS =====

// GET /api/trips/active
// header: X-Account-Id
// returns upcoming + ongoing trips
app.get('/api/trips/active', requireAuth, (req, res) => {
    const sql = `
        SELECT
            t.trip_id,
            u.full_name,
            u.work_email,
            c.company_name,
            t.depart_date,
            t.return_date,
            t.status,
            t.version
        FROM trips t
        JOIN users u ON t.user_id = u.user_id
        JOIN companies c ON t.company_id = c.company_id
        WHERE
            t.status IN ('PLANNED','ACTIVE')
            OR t.return_date >= CURDATE()
        ORDER BY t.depart_date ASC
    `;
    connection.query(sql, (err, rows) => {
        if (err) {
            console.error('active trips error:', err);
            return res.status(500).json({ error: 'Server error' });
        }
        res.json(rows);
    });
});

// GET /api/trips/completed
// header: X-Account-Id
app.get('/api/trips/completed', requireAuth, (req, res) => {
    const sql = `
        SELECT
            t.trip_id,
            u.full_name,
            u.work_email,
            c.company_name,
            t.depart_date,
            t.return_date,
            t.status,
            t.version
        FROM trips t
        JOIN users u ON t.user_id = u.user_id
        JOIN companies c ON t.company_id = c.company_id
        WHERE
            t.status = 'COMPLETED'
            OR t.return_date < CURDATE()
        ORDER BY t.return_date DESC
    `;
    connection.query(sql, (err, rows) => {
        if (err) {
            console.error('completed trips error:', err);
            return res.status(500).json({ error: 'Server error' });
        }
        res.json(rows);
    });
});

// POST /api/trips
// header: X-Account-Id
// body: { full_name, work_email, company_id, depart_date, return_date, notes }
app.post('/api/trips', requireAuth, (req, res) => {
    const {
        full_name,
        work_email,
        company_id,
        depart_date,
        return_date,
        notes
    } = req.body || {};

    if (!full_name || !work_email || !company_id || !depart_date || !return_date) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const accountId = req.accountId;

    findOrCreateUser(full_name, work_email, company_id)
        .then(user_id => {
            const insertTripSql = `
                INSERT INTO trips (
                    user_id,
                    company_id,
                    depart_date,
                    return_date,
                    notes,
                    status,
                    version,
                    last_modified_by
                ) VALUES (?, ?, ?, ?, ?, 'PLANNED', 1, ?)
            `;
            connection.query(
                insertTripSql,
                [user_id, company_id, depart_date, return_date, notes || null, accountId],
                (err2, result2) => {
                    if (err2) {
                        console.error('createTrip error:', err2);
                        return res.status(500).json({ error: 'Server error' });
                    }

                    const trip_id = result2.insertId;

                    writeAudit(
                        accountId,
                        trip_id,
                        'CREATE_TRIP',
                        `Trip created for ${full_name} (${work_email})`
                    );

                    return res.json({ ok: true, trip_id });
                }
            );
        })
        .catch(err => {
            console.error('findOrCreateUser error:', err);
            return res.status(500).json({ error: 'Server error' });
        });
});

// PUT /api/trips
// header: X-Account-Id
// body: { trip_id, depart_date, return_date, notes, status, expected_version }
app.put('/api/trips', requireAuth, (req, res) => {
    const {
        trip_id,
        depart_date,
        return_date,
        notes,
        status,
        expected_version
    } = req.body || {};

    if (!trip_id || !depart_date || !return_date || !status || expected_version === undefined) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const accountId = req.accountId;

    const updateSql = `
        UPDATE trips
        SET
            depart_date = ?,
            return_date = ?,
            notes = ?,
            status = ?,
            version = version + 1,
            last_modified_at = NOW(),
            last_modified_by = ?,
            updated_at = NOW()
        WHERE
            trip_id = ?
            AND version = ?
    `;

    connection.query(
        updateSql,
        [
            depart_date,
            return_date,
            notes || null,
            status,
            accountId,
            trip_id,
            expected_version
        ],
        (err, result) => {
            if (err) {
                console.error('updateTrip error:', err);
                return res.status(500).json({ error: 'Server error' });
            }

            if (result.affectedRows === 0) {
                // version conflict -> fetch server copy
                const currentSql = `
                    SELECT
                        t.*,
                        a.username AS last_modified_by_name
                    FROM trips t
                    LEFT JOIN app_accounts a
                        ON t.last_modified_by = a.account_id
                    WHERE t.trip_id = ?
                    LIMIT 1
                `;
                connection.query(currentSql, [trip_id], (err2, rows2) => {
                    if (err2) {
                        console.error('conflict fetch error:', err2);
                        return res.status(409).json({
                            error: 'conflict',
                            message: 'Trip was modified by someone else.',
                            server_trip: null
                        });
                    }

                    return res.status(409).json({
                        error: 'conflict',
                        message: 'Trip was modified by someone else.',
                        server_trip: rows2.length ? rows2[0] : null
                    });
                });
                return;
            }

            writeAudit(
                accountId,
                trip_id,
                'UPDATE_TRIP',
                `Trip ${trip_id} updated by account ${accountId}`
            );

            return res.json({ ok: true });
        }
    );
});

// ===== ADMIN: ACCOUNTS =====

// GET /api/admin/listAccounts
// headers: X-Account-Id (must be ADMIN)
app.get('/api/admin/listAccounts', requireAuth, requireAdmin, (req, res) => {
    const sql = `
        SELECT account_id, username, role, is_active, created_at
        FROM app_accounts
        ORDER BY created_at ASC
    `;
    connection.query(sql, (err, rows) => {
        if (err) {
            console.error('listAccounts error:', err);
            return res.status(500).json({ error: 'Server error' });
        }
        res.json(rows);
    });
});

// POST /api/admin/addAccount
// headers: X-Account-Id (ADMIN)
// body: { username, password, role }  role = "ADMIN"|"STAFF"
app.post('/api/admin/addAccount', requireAuth, requireAdmin, async (req, res) => {
    const { username, password, role } = req.body || {};

    if (!username || !password || !role) {
        return res.status(400).json({ error: 'username, password, role required' });
    }
    if (role !== 'ADMIN' && role !== 'STAFF') {
        return res.status(400).json({ error: 'role must be ADMIN or STAFF' });
    }

    try {
        const hash = await bcrypt.hash(password, 10);

        const sql = `
            INSERT INTO app_accounts (username, password_hash, role, is_active)
            VALUES (?, ?, ?, 1)
        `;
        connection.query(sql, [username, hash, role], (err, result) => {
            if (err) {
                if (err.code === 'ER_DUP_ENTRY') {
                    return res.status(409).json({ error: 'Username already exists' });
                }
                console.error('addAccount error:', err);
                return res.status(500).json({ error: 'Server error' });
            }

            const newId = result.insertId;

            writeAudit(
                req.accountId,
                null,
                'CREATE_ACCOUNT',
                `Created account ${username} (${role}) with id ${newId}`
            );

            res.json({ ok: true, account_id: newId });
        });
    } catch (e) {
        console.error('bcrypt error:', e);
        return res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/admin/setAccountActive
// headers: X-Account-Id (ADMIN)
// body: { account_id, is_active }
app.post('/api/admin/setAccountActive', requireAuth, requireAdmin, (req, res) => {
    const { account_id, is_active } = req.body || {};
    if (!account_id || typeof is_active === 'undefined') {
        return res.status(400).json({ error: 'account_id and is_active required' });
    }

    const sql = `
        UPDATE app_accounts
        SET is_active = ?
        WHERE account_id = ?
    `;
    connection.query(sql, [is_active, account_id], (err, result) => {
        if (err) {
            console.error('setAccountActive error:', err);
            return res.status(500).json({ error: 'Server error' });
        }
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Account not found' });
        }

        writeAudit(
            req.accountId,
            null,
            'UPDATE_ACCOUNT',
            `Set account ${account_id} is_active=${is_active}`
        );

        res.json({ ok: true });
    });
});

// ===== ADMIN: COMPANIES =====

// GET /api/admin/listCompanies
// headers: X-Account-Id (ADMIN)
app.get('/api/admin/listCompanies', requireAuth, requireAdmin, (req, res) => {
    const sql = `
        SELECT company_id, company_name, is_active, created_at
        FROM companies
        ORDER BY company_name ASC
    `;
    connection.query(sql, (err, rows) => {
        if (err) {
            console.error('listCompanies error:', err);
            return res.status(500).json({ error: 'Server error' });
        }
        res.json(rows);
    });
});

// POST /api/admin/addCompany
// headers: X-Account-Id (ADMIN)
// body: { company_name }
app.post('/api/admin/addCompany', requireAuth, requireAdmin, (req, res) => {
    const { company_name } = req.body || {};
    if (!company_name) {
        return res.status(400).json({ error: 'company_name required' });
    }

    const sql = `
        INSERT INTO companies (company_name, is_active)
        VALUES (?, 1)
    `;
    connection.query(sql, [company_name], (err, result) => {
        if (err) {
            if (err.code === 'ER_DUP_ENTRY') {
                return res.status(409).json({ error: 'Company already exists' });
            }
            console.error('addCompany error:', err);
            return res.status(500).json({ error: 'Server error' });
        }

        const newId = result.insertId;

        writeAudit(
            req.accountId,
            null,
            'CREATE_COMPANY',
            `Created company ${company_name} with id ${newId}`
        );

        res.json({ ok: true, company_id: newId });
    });
});

// POST /api/admin/setCompanyActive
// headers: X-Account-Id (ADMIN)
// body: { company_id, is_active }
app.post('/api/admin/setCompanyActive', requireAuth, requireAdmin, (req, res) => {
    const { company_id, is_active } = req.body || {};
    if (!company_id || typeof is_active === 'undefined') {
        return res.status(400).json({ error: 'company_id and is_active required' });
    }

    const sql = `
        UPDATE companies
        SET is_active = ?
        WHERE company_id = ?
    `;
    connection.query(sql, [is_active, company_id], (err, result) => {
        if (err) {
            console.error('setCompanyActive error:', err);
            return res.status(500).json({ error: 'Server error' });
        }
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Company not found' });
        }

        writeAudit(
            req.accountId,
            null,
            'UPDATE_COMPANY',
            `Set company ${company_id} is_active=${is_active}`
        );

        res.json({ ok: true });
    });
});

// ---------- Start server ----------
app.listen(port, () => {
    console.log(`Overseas Access Tracker API running on port ${port}`);
});
