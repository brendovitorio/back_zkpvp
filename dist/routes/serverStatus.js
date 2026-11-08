import { Router } from "express";
import { getCachedServerStatus } from "../services/fivemStatus.js";
export const serverStatusRouter = Router();
serverStatusRouter.get("/", (_req, res) => {
    res.json(getCachedServerStatus());
});
