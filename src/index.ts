import { runAgent, type AgentEnv } from "./agent";

export type Env = AgentEnv;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

async function listArticles(url: URL, db: D1Database): Promise<Response> {
  const p = url.searchParams;
  const where: string[] = [];
  const binds: (string | number)[] = [];

  const topic = p.get("topic");
  if (topic) {
    where.push("topic = ?");
    binds.push(topic);
  }
  const from = p.get("from");
  if (from) {
    where.push("published_at >= ?");
    binds.push(from);
  }
  const to = p.get("to");
  if (to) {
    where.push("published_at <= ?");
    binds.push(to);
  }
  const source = p.get("source");
  if (source) {
    where.push("source LIKE ? COLLATE NOCASE");
    binds.push(`%${source}%`);
  }
  const minScore = p.get("min_score");
  if (minScore !== null) {
    const n = Number(minScore);
    if (!Number.isFinite(n)) return json({ error: "min_score must be a number" }, 400);
    where.push("relevance_score >= ?");
    binds.push(n);
  }
  const limitParam = p.get("limit");
  const limit = Math.min(200, Math.max(1, limitParam ? Math.floor(Number(limitParam)) || 50 : 50));

  const sql = `SELECT id, topic, headline, source, published_at, url, summary, relevance_score, fetched_at
               FROM articles
               ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY published_at DESC, relevance_score DESC
               LIMIT ?`;
  const { results } = await db.prepare(sql).bind(...binds, limit).all();
  return json({ count: results.length, articles: results });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/health":
          return json({ status: "ok", timestamp: new Date().toISOString() });
        case "/agent":
          return json(await runAgent(env));
        case "/articles":
          return await listArticles(url, env.DB);
        default:
          return json({ error: "Not found" }, 404);
      }
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runAgent(env).then((r) => console.log("daily agent run", JSON.stringify(r))));
  },
} satisfies ExportedHandler<Env>;
