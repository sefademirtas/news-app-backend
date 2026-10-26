import Anthropic from "@anthropic-ai/sdk";
import {
  ARTICLES_PER_RUN,
  MAX_ARTICLES_PER_TOPIC,
  TOPICS,
  type Topic,
} from "./topics";

export interface AgentEnv {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
}

interface FoundArticle {
  headline: string;
  source: string;
  published_at: string | null;
  url: string;
  summary: string;
  relevance_score: number;
}

export interface TopicResult {
  topic: string;
  returned: number;
  inserted: number;
  skipped: number;
  trimmed: number;
  error?: string;
}

const MODEL = "claude-opus-5-5";
const MAX_PAUSE_TURNS = 5;

function buildPrompt(topic: Topic): string {
  const today = new Date().toISOString().slice(0, 10);
  return `Today is ${today}. Use web search to find the ${ARTICLES_PER_RUN} most recent and significant news articles published in the past 7 days on this topic:

"${topic.description}"

Prefer reputable primary reporting, regulators, peer-reviewed or company announcements over aggregators. Every article must be a real page you found via search; never invent URLs.

When you are done searching, reply with ONLY a JSON array (no prose, no code fences) of up to ${ARTICLES_PER_RUN} objects with exactly these keys:
- "headline": string
- "source": string, the publication or organization name
- "published_date": string, YYYY-MM-DD
- "url": string, the full article URL
- "summary": string, 2-3 sentences
- "relevance_score": integer 1-10, how significant and relevant the article is to the topic`;
}

/** Concatenate every text block; web search splits the answer across many. */
function collectText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function extractJsonArray(text: string): unknown[] {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const end = cleaned.lastIndexOf("]");
  let start = cleaned.indexOf("[");
  while (start !== -1 && start < end) {
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // not the array start; try the next "["
    }
    start = cleaned.indexOf("[", start + 1);
  }
  throw new Error("No JSON array found in Claude's response");
}

function normalize(raw: unknown): FoundArticle | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const url = typeof r.url === "string" ? r.url.trim() : "";
  const headline = typeof r.headline === "string" ? r.headline.trim() : "";
  const score = Math.round(Number(r.relevance_score));
  if (!/^https?:\/\//i.test(url) || !headline || !Number.isFinite(score)) return null;
  const date =
    typeof r.published_date === "string" && /^\d{4}-\d{2}-\d{2}/.test(r.published_date)
      ? r.published_date.slice(0, 10)
      : null;
  return {
    headline,
    source: typeof r.source === "string" && r.source.trim() ? r.source.trim() : "Unknown",
    published_at: date,
    url,
    summary: typeof r.summary === "string" ? r.summary.trim() : "",
    relevance_score: Math.min(10, Math.max(1, score)),
  };
}

async function searchTopic(client: Anthropic, topic: Topic): Promise<unknown[]> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: buildPrompt(topic) },
  ];

  for (let turn = 0; turn < MAX_PAUSE_TURNS; turn++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium" },
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 6 }],
      messages,
    });

    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }
    if (response.stop_reason === "refusal") {
      throw new Error(`Claude declined the request (${response.stop_details?.category ?? "unknown"})`);
    }
    return extractJsonArray(collectText(response.content));
  }
  throw new Error("Web search did not finish within the allowed number of turns");
}

async function processTopic(
  client: Anthropic,
  db: D1Database,
  topic: Topic,
): Promise<TopicResult> {
  const found = (await searchTopic(client, topic))
    .map(normalize)
    .filter((a): a is FoundArticle => a !== null);

  const unique = [...new Map(found.map((a) => [a.url, a])).values()];

  const insert = db.prepare(
    `INSERT OR IGNORE INTO articles
       (topic, headline, source, published_at, url, summary, relevance_score)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const results = unique.length
    ? await db.batch(
        unique.map((a) =>
          insert.bind(topic.id, a.headline, a.source, a.published_at, a.url, a.summary, a.relevance_score),
        ),
      )
    : [];
  const inserted = results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);

  const trim = await db
    .prepare(
      `DELETE FROM articles
       WHERE topic = ?1
         AND id NOT IN (
           SELECT id FROM articles WHERE topic = ?1
           ORDER BY COALESCE(published_at, substr(fetched_at, 1, 10)) DESC, id DESC
           LIMIT ?2
         )`,
    )
    .bind(topic.id, MAX_ARTICLES_PER_TOPIC)
    .run();

  return {
    topic: topic.id,
    returned: found.length,
    inserted,
    skipped: found.length - inserted,
    trimmed: trim.meta.changes ?? 0,
  };
}

export async function runAgent(env: AgentEnv) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const settled = await Promise.allSettled(
    TOPICS.map((t) => processTopic(client, env.DB, t)),
  );
  const topics: TopicResult[] = settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : {
          topic: TOPICS[i].id,
          returned: 0,
          inserted: 0,
          skipped: 0,
          trimmed: 0,
          error: s.reason instanceof Error ? s.reason.message : String(s.reason),
        },
  );

  return {
    inserted: topics.reduce((n, t) => n + t.inserted, 0),
    skipped: topics.reduce((n, t) => n + t.skipped, 0),
    total_returned: topics.reduce((n, t) => n + t.returned, 0),
    topics,
  };
}
