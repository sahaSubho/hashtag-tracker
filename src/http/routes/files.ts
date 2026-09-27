import { Router } from "express";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface FilesRouteDeps {
  storageDir: string;
}

/**
 * Serves locally-stored assets (spec §13.3): nosniff + attachment
 * disposition so a browser never executes stored content as HTML/script,
 * regardless of what a hostile file's bytes contain.
 */
export function filesRouter(deps: FilesRouteDeps): Router {
  const router = Router();

  router.get("/files/*", async (req, res) => {
    const key = (req.params as unknown as { 0: string })[0];
    if (!key || key.includes("..")) {
      res.status(400).end();
      return;
    }

    const filePath = path.join(deps.storageDir, key);
    try {
      const body = await fs.readFile(filePath);
      res.set("X-Content-Type-Options", "nosniff");
      res.set("Content-Disposition", "attachment");
      res.status(200).send(body);
    } catch {
      res.status(404).end();
    }
  });

  return router;
}
