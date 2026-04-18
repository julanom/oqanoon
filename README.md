# Oqanoon — Omani Legal Assistant Discord Bot

A Discord bot that answers questions about Omani law in Arabic. It searches official legal texts from [qanoon.om](https://qanoon.om), retrieves the most relevant articles, and generates clear answers using an LLM — always citing the source law and article number.

---

## Features

- Answers legal questions in Arabic based on real Omani law texts
- Cites specific articles and royal decrees in every answer
- Displays a confidence level (high / medium / low) for each answer
- Supports follow-up questions with conversation memory (last 3 exchanges)
- Rate limiting — 5 seconds between questions per user
- Input limit — 500 characters max per question
- Slash commands for easy access
- Works in Discord servers (mention-only) and DMs (always responds)

---

## Slash Commands

| Command | Description |
|---------|-------------|
| `/ask <question>` | Ask a legal question about Omani law |
| `/help` | Show available commands |
| `/about` | About this bot |
| `/history` | Show conversation memory for this channel |
| `/clear` | Clear conversation history for this channel |

---

## How It Works

```
User message
     ↓
Routing: smalltalk → direct reply / non-legal → redirect
     ↓  (legal question)
3 searches run in parallel:
  1. Semantic search      — vector similarity via pgvector (VoyageAI embeddings)
  2. Title-filtered search — topic-aware search (work / criminal / rental / commercial)
  3. Keyword search        — ILIKE on raw text

Merge & score:
  semantic 60% + keyword 20% + filtered bonus 15% + topic relevance 5%
     ↓
Top 8 chunks sent as context to Groq LLM
     ↓
Formatted reply: ⚖️ Answer + 📊 Confidence + ⚠️ Disclaimer + 📚 Sources
```

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Bot framework | discord.js v14 |
| Database | PostgreSQL (Neon) + pgvector |
| Embeddings | VoyageAI `voyage-law-2` (1024-dim) |
| LLM | Groq API — `openai/gpt-oss-120b` |
| Data source | [qanoon.om](https://qanoon.om) |
| Process manager | pm2 |

---

## Project Structure

```
oqanoon/
├── discord_law_bot.js       # Main bot — Discord client, routing, slash commands
├── query_law_improved.js    # Query engine — embeddings, DB search, LLM call
├── .env.example             # Required environment variables
├── package.json
└── scripts/                 # Data pipeline (run once to populate the database)
    ├── qanoon_full_scraper.js       # Scrape all laws from qanoon.om
    ├── qanoon_chunking.js           # Split law texts into chunks
    ├── qanoon_cleanup_validate.js   # Clean and validate chunks
    ├── qanoon_prepare_jsonl.js      # Export chunks to JSONL format
    ├── voyage_supabase_full_upload.js  # Embed chunks and upload to Postgres
    └── targeted_law_search.js       # Debug: test search queries directly
```

---

## Setup

### 1. Prerequisites

- Node.js 18+
- A PostgreSQL database with the `pgvector` extension enabled (Neon recommended)
- A Discord bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- A VoyageAI API key ([voyageai.com](https://www.voyageai.com))
- A Groq API key ([console.groq.com](https://console.groq.com))

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

```env
DISCORD_TOKEN=your_discord_bot_token
CONNECTION_STRING=postgresql://user:password@host/dbname
VOYAGE_API_KEY=your_voyage_api_key
GROQ_API_KEY=your_groq_api_key
```

### 4. Set up the database

Your PostgreSQL database needs the `pgvector` extension and a `match_law_chunks` function. Run this SQL on your database:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS law_chunks (
  id SERIAL PRIMARY KEY,
  chunk_id TEXT UNIQUE,
  law_id TEXT,
  title TEXT,
  category TEXT,
  year TEXT,
  url TEXT,
  chunk_index INTEGER,
  total_chunks INTEGER,
  text TEXT,
  embedding vector(1024)
);

CREATE OR REPLACE FUNCTION match_law_chunks(
  query_embedding vector(1024),
  match_count int
)
RETURNS TABLE (
  id int, chunk_id text, law_id text, title text, category text,
  year text, url text, chunk_index int, total_chunks int, text text,
  score float
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT l.id, l.chunk_id, l.law_id, l.title, l.category,
         l.year, l.url, l.chunk_index, l.total_chunks, l.text,
         1 - (l.embedding <=> query_embedding) AS score
  FROM law_chunks l
  ORDER BY l.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
```

### 5. Populate the database (first time only)

Run the data pipeline in order:

```bash
npm run scrape     # 1. Scrape laws from qanoon.om
npm run chunk      # 2. Split into chunks
npm run validate   # 3. Clean and validate
npm run prepare    # 4. Export to JSONL
npm run upload     # 5. Embed and upload to Postgres
```

### 6. Run the bot

```bash
npm start
```

Or with pm2 for production:

```bash
pm2 start discord_law_bot.js --name oqanoon-bot
pm2 save
```

---

## Discord Bot Permissions

When adding the bot to a server, it needs these permissions:

- `Read Messages / View Channels`
- `Send Messages`
- `Read Message History`
- `Use Slash Commands`

Required intents (already configured in code):
- `Guilds`
- `GuildMessages`
- `MessageContent`
- `DirectMessages`

---

## Notes

- In servers, the bot only responds when directly **mentioned** (`@Oqanoon`) or when someone **replies** to one of its messages
- In DMs, it responds to all messages
- Answers are informational only — not legal advice
- Query cache: identical questions (with no conversation history) are cached for 1 hour to reduce API costs
- Conversation memory resets on bot restart
