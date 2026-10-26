CREATE TABLE articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  headline TEXT NOT NULL,
  source TEXT NOT NULL,
  published_at TEXT,
  url TEXT NOT NULL UNIQUE,
  summary TEXT,
  relevance_score INTEGER CHECK (relevance_score BETWEEN 1 AND 10),
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_articles_topic_score ON articles (topic, relevance_score DESC);
CREATE INDEX idx_articles_published ON articles (published_at DESC);
