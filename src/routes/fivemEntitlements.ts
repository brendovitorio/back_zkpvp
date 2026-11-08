import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requireApiKey } from "../middleware/requireApiKey.js";

export const fivemEntitlementsRouter = Router();
const licenseSchema = z.string().min(10).max(80).regex(/^license:[A-Za-z0-9]+$/);

/** Server-only lookup. The raw license is never returned to the caller. */
fivemEntitlementsRouter.get("/entitlements", requireApiKey, async (req, res) => {
  const parsed = licenseSchema.safeParse(req.query.license);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_license" });
    return;
  }

  const { rows } = await pool.query<{
    id: string;
    kind: "vip" | "skin" | "vehicle";
    entitlement_key: string;
    duration_unit: string;
    granted_at: Date;
    expires_at: Date | null;
  }>(
    `SELECT e.id, e.kind, e.entitlement_key, e.duration_unit, e.granted_at, e.expires_at
     FROM player_entitlements e
     INNER JOIN players p ON p.id = e.player_id
     WHERE p.fivem_license = $1
       AND e.revoked_at IS NULL
       AND (e.expires_at IS NULL OR e.expires_at > now())
     ORDER BY e.granted_at DESC`,
    [parsed.data]
  );

  res.setHeader("Cache-Control", "no-store");
  res.json({ entitlements: rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    key: row.entitlement_key,
    durationUnit: row.duration_unit,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    expiresAtEpoch: row.expires_at ? Math.floor(row.expires_at.getTime() / 1000) : null,
  })) });
});
