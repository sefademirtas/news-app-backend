import { runAgent, type AgentEnv } from "./agent";
import { answerQuestion, ChatInputError, MAX_QUESTION_CHARS } from "./chat";

export interface Env extends AgentEnv {
  AGENT_SECRET: string;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

function unauthorized(): Response {
  return Response.json(
    { error: "Unauthorized" },
    { status: 401, headers: { ...CORS_HEADERS, "WWW-Authenticate": "Bearer" } },
  );
}

/** Compare SHA-256 digests so the check is constant-time regardless of input length. */
async function isAuthorized(request: Request, secret: string | undefined): Promise<boolean> {
  if (!secret) return false;
  const match = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "");
  if (!match) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(match[1])),
    crypto.subtle.digest("SHA-256", enc.encode(secret)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
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

async function chat(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Use POST" }, 405);
  let body: { question?: unknown; model?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON: {\"question\": \"...\", \"model\": \"sonnet\"}" }, 400);
  }
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return json({ error: "question is required" }, 400);
  if (question.length > MAX_QUESTION_CHARS) {
    return json({ error: `question must be at most ${MAX_QUESTION_CHARS} characters` }, 400);
  }
  if (body.model !== undefined && typeof body.model !== "string") {
    return json({ error: "model must be a string" }, 400);
  }
  try {
    return json(await answerQuestion(env, question, body.model));
  } catch (err) {
    if (err instanceof ChatInputError) return json({ error: err.message }, 400);
    throw err;
  }
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
          if (!(await isAuthorized(request, env.AGENT_SECRET))) return unauthorized();
          return json(await runAgent(env));
        case "/chat":
          if (request.method !== "OPTIONS" && !(await isAuthorized(request, env.AGENT_SECRET))) {
            return unauthorized();
          }
          return await chat(request, env);
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
