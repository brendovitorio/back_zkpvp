import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireApiKey } from "../middleware/requireApiKey.js";

export const fivemAdminRouter = Router();

// The FiveM resource should call this before allowing a player to spawn/join.
// A ban is enforced only after the resource consumes this response.
fivemAdminRouter.get("/ban-check", requireApiKey, async (req,res) => {
  const license = typeof req.query.license === "string" ? req.query.license.trim().slice(0,160) : "";
  if (!license) { res.status(400).json({error:"license_required"}); return; }
  const {rows}=await pool.query(`SELECT b.type,b.reason,b.expires_at,p.display_name
    FROM player_punishments b JOIN players p ON p.id=b.player_id
    WHERE p.fivem_license=$1 AND b.revoked_at IS NULL
      AND b.type IN ('temporary_ban','permanent_ban')
      AND (b.expires_at IS NULL OR b.expires_at > now())
    ORDER BY b.created_at DESC LIMIT 1`,[license]);
  res.json({banned:!!rows[0], punishment:rows[0]??null});
});
