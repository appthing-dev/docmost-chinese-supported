import { type Kysely, sql } from 'kysely';

// Enable pgroonga-based full text search with Chinese (CJK) support.
//
// The default docmost search pipeline uses PostgreSQL's built-in `english`
// text search configuration (to_tsvector / to_tsquery), which cannot tokenize
// Chinese text — every CJK run is treated as a single lexeme, making Chinese
// full text search effectively unusable.
//
// pgroonga provides a bigram tokenizer (TokenBigram) that handles Chinese,
// Japanese, Korean as well as English. We add dedicated pgroonga indexes on
// pages (title + text_content) and attachments (file_name + text_content).
// The existing tsvector column and its trigger are intentionally left intact
// so the change is fully reversible.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgroonga`.execute(db);

  // Pages: title + text_content
  await sql`
    CREATE INDEX pages_pgroonga_title_idx
      ON pages USING pgroonga (title)
      WITH (tokenizer = 'TokenBigram', normalizer = 'NormalizerAuto')
  `.execute(db);

  await sql`
    CREATE INDEX pages_pgroonga_text_content_idx
      ON pages USING pgroonga (text_content)
      WITH (tokenizer = 'TokenBigram', normalizer = 'NormalizerAuto')
  `.execute(db);

  // Attachments: file_name + extracted text_content (used by EE attachment search)
  await sql`
    CREATE INDEX attachments_pgroonga_file_name_idx
      ON attachments USING pgroonga (file_name)
      WITH (tokenizer = 'TokenBigram', normalizer = 'NormalizerAuto')
  `.execute(db);

  await sql`
    CREATE INDEX attachments_pgroonga_text_content_idx
      ON attachments USING pgroonga (text_content)
      WITH (tokenizer = 'TokenBigram', normalizer = 'NormalizerAuto')
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS pages_pgroonga_title_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS pages_pgroonga_text_content_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS attachments_pgroonga_file_name_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS attachments_pgroonga_text_content_idx`.execute(db);

  await sql`DROP EXTENSION IF EXISTS pgroonga`.execute(db);
}
