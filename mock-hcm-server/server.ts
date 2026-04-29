import express, { Request, Response, NextFunction } from 'express';
import Database from 'better-sqlite3';
import cors from 'cors';
import CounterService from './services/counterService';
import SeedService from './services/seedService';

const app = express();
app.use(express.json());
app.use(cors());

// Initialize DB
let db = new Database(':memory:');


const counterService = new CounterService();

// Initial Seed
SeedService.seed(db);

// --- MIDDLEWARES ---

// Mocked behavior middleware
app.use((req: Request, res: Response, next: NextFunction) => {
    // Exclude /health and /reset from mocked behaviors
    if (req.path === '/health' || req.path === '/reset') {
        console.log(`[${req.method}] ${req.path} - Counter bypassed`);
        return next();
    }

    const currentCount = counterService.incrementGlobal();
    let behaviorTriggered = false;

    // Every 5th call: silently increment allocated_balance by 1 for emp 1, loc 1
    if (currentCount % 5 === 0) {
        db.prepare(`UPDATE balance SET allocated_balance = allocated_balance + 1 WHERE employee_id = 1 AND location_id = 1`).run();
        console.log(`[MOCK] 5th request - Incremented allocated_balance for emp 1 loc 1`);
        behaviorTriggered = true;
    }

    // Every 10th call: return 500 immediately
    if (currentCount % 10 === 0) {
        console.log(`[MOCK] 10th request - Returning 500 Internal Server Error`);
        console.log(`[${req.method}] ${req.path} | Counter: ${currentCount} | Behavior Triggered: TRUE (500 Error)`);
        return res.status(500).json({ message: "Internal server error" });
    }

    console.log(`[${req.method}] ${req.path} | Counter: ${currentCount} | Behavior Triggered: ${behaviorTriggered}`);
    next();
});

// --- ENDPOINTS ---

// 1. POST /time-off/requests
app.post('/time-off/requests', (req: Request, res: Response) => {
    const postCount = counterService.incrementPost();
    const isUnreliableValidation = (postCount % 10 === 0);

    const { employee_id, location_id, dates } = req.body;

    if (!employee_id || !location_id || !Array.isArray(dates)) {
        return res.status(400).json({ message: "Invalid request body" });
    }

    // Find Balance
    const balanceRecord = db.prepare(`SELECT allocated_balance FROM balance WHERE employee_id = ? AND location_id = ?`).get(employee_id, location_id) as { allocated_balance: number } | undefined;

    if (!balanceRecord) {
        return res.status(404).json({ message: "Balance not found" });
    }

    // Compute current_balance
    const currentYear = new Date().getFullYear().toString();
    const leaveCountRow = db.prepare(`SELECT COUNT(*) as cnt FROM leaveRecord WHERE employee_id = ? AND location_id = ? AND substr(date, 1, 4) = ?`).get(employee_id, location_id, currentYear) as { cnt: number };
    let currentBalance = balanceRecord.allocated_balance - leaveCountRow.cnt;

    // Filter dates
    const todayStr = new Date().toISOString().split('T')[0] || '';
    const holidays = db.prepare(`SELECT date FROM publicHolidays WHERE location_id = ?`).all(location_id) as { date: string }[];
    const holidayDates = new Set(holidays.map(h => h.date));

    const isWeeklyHoliday = (dateStr: string) => {
        const d = new Date(dateStr);
        const day = d.getDay();
        return day === 0 || day === 6; // Sunday or Saturday
    };

    const filteredDates = dates.filter(d => {
        if (d < todayStr) return false; // past dates
        if (holidayDates.has(d)) return false; // public holiday
        if (isWeeklyHoliday(d)) return false; // weekly holiday
        return true;
    });

    if (filteredDates.length === 0) {
        return res.status(400).json({ message: "No valid dates to process" });
    }

    // Check overlaps
    const existingLeaves = db.prepare(`SELECT date FROM leaveRecord WHERE employee_id = ? AND location_id = ?`).all(employee_id, location_id) as { date: string }[];
    const existingDates = new Set(existingLeaves.map(l => l.date));

    for (const d of filteredDates) {
        if (existingDates.has(d)) {
            return res.status(409).json({ message: "Date overlap with existing request" });
        }
    }

    // Check balance
    if (currentBalance < filteredDates.length) {
        if (isUnreliableValidation) {
            console.log(`[MOCK] 10th POST request - Unreliable validation triggered. Allowing request despite insufficient balance.`);
        } else {
            return res.status(422).json({ message: "insufficient balance" });
        }
    }

    // Insert leaves
    const insertLeave = db.prepare(`INSERT INTO leaveRecord (employee_id, location_id, date) VALUES (?, ?, ?)`);
    const transaction = db.transaction((datesToInsert: string[]) => {
        for (const d of datesToInsert) {
            insertLeave.run(employee_id, location_id, d);
        }
    });

    try {
        transaction(filteredDates);
    } catch (err) {
        return res.status(500).json({ message: "Database error during insertion" });
    }

    const newBalance = isUnreliableValidation && currentBalance < filteredDates.length
        ? 0
        : currentBalance - filteredDates.length;

    return res.status(201).json({
        new_balance: newBalance,
        accepted_dates: filteredDates
    });
});

// 2. GET /time-off/balances/:locationId/:employeeId
app.get('/time-off/balances/:locationId/:employeeId', (req: Request, res: Response) => {
    const locationId = req.params.locationId as string;
    const employeeId = req.params.employeeId as string;

    const balanceRecord = db.prepare(`SELECT allocated_balance FROM balance WHERE employee_id = ? AND location_id = ?`).get(employeeId, locationId) as { allocated_balance: number } | undefined;

    if (!balanceRecord) {
        return res.status(404).json({ message: "Balance not found" });
    }

    const currentYear = new Date().getFullYear().toString();
    const leaveCountRow = db.prepare(`SELECT COUNT(*) as cnt FROM leaveRecord WHERE employee_id = ? AND location_id = ? AND substr(date, 1, 4) = ?`).get(employeeId, locationId, currentYear) as { cnt: number };

    const currentBalance = balanceRecord.allocated_balance - leaveCountRow.cnt;

    return res.status(200).json({
        employee_id: parseInt(employeeId),
        location_id: parseInt(locationId),
        balance: currentBalance
    });
});

// 3. GET /batch/balances
app.get('/batch/balances', (req: Request, res: Response) => {
    const currentYear = new Date().getFullYear().toString();
    const query = `
        SELECT 
            b.employee_id, 
            b.location_id, 
            (b.allocated_balance - COALESCE(l.cnt, 0)) AS balance
        FROM balance b
        LEFT JOIN (
            SELECT employee_id, location_id, COUNT(*) as cnt 
            FROM leaveRecord 
            WHERE substr(date, 1, 4) = ? 
            GROUP BY employee_id, location_id
        ) l ON b.employee_id = l.employee_id AND b.location_id = l.location_id
    `;
    const rows = db.prepare(query).all(currentYear);
    return res.status(200).json(rows);
});

// 4. GET /health
app.get('/health', (req: Request, res: Response) => {
    res.status(200).json({
        status: "ok",
        requestCount: counterService.globalCount,
        postRequestCount: counterService.postRequestCount
    });
});

// 5. POST /reset
app.post('/reset', (req: Request, res: Response) => {
    SeedService.seed(db);
    counterService.reset();
    res.status(200).json({ message: "Database and counters reset to initial state." });
});

app.listen(3001, () => {
    console.log('Mock HCM Server running on port 3001');
});
