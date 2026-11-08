import { pool } from "../db/pool.js";
/** Rechecks the database role for sensitive entitlement changes on every call. */
export async function requireStaffAdmin(req, res, next) {
    if (!req.staff?.staffId) {
        res.status(401).json({ error: "unauthenticated" });
        return;
    }
    const { rows } = await pool.query(`SELECT role FROM staff_accounts WHERE id = $1`, [req.staff.staffId]);
    if (rows[0]?.role !== "admin") {
        res.status(403).json({ error: "forbidden" });
        return;
    }
    next();
}
