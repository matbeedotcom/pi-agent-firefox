/**
 * Fixture server for the skills e2e matrix (tests/skills-e2e/run.mjs).
 *
 * Serves tests/fixtures/skills/ read-only on 127.0.0.1 and collects the
 * recorder's guarded /__report beacons (see _recorder.js) — the harness's
 * observation channel for page outcomes. No dependencies.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

export async function createFixtureServer(fixturesDir, port) {
  const reports = [];
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/__report") {
        let body = "";
        for await (const chunk of req) body += chunk;
        reports.push({ at: Date.now(), raw: body });
        res.writeHead(204, { "content-length": 0 });
        res.end();
        return;
      }
      if (req.method !== "GET") {
        res.writeHead(405, { "content-length": 0 });
        res.end();
        return;
      }
      const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
      const file = path.resolve(fixturesDir, rel);
      if (file !== path.resolve(fixturesDir) && !file.startsWith(path.resolve(fixturesDir) + path.sep)) {
        res.writeHead(403, { "content-length": 0 });
        res.end();
        return;
      }
      const data = await readFile(file);
      res.writeHead(200, {
        "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
        "content-length": data.length,
        "cache-control": "no-store",
      });
      res.end(data);
    } catch {
      res.writeHead(404, { "content-length": 0 });
      res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${port}`,
    reports,
    /** Parsed beacons, oldest first. */
    parsedReports() {
      return reports.map((r) => {
        try { return { at: r.at, ...JSON.parse(r.raw) }; } catch { return { at: r.at, raw: r.raw }; }
      });
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
