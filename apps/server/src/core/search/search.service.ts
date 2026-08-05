import { Injectable } from '@nestjs/common';
import { SearchDTO, SearchSuggestionDTO } from './dto/search.dto';
import { SearchResponseDto } from './dto/search-response.dto';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { sql, SqlBool, RawBuilder } from 'kysely';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { ShareRepo } from '@docmost/db/repos/share/share.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';

/**
 * Build a PGroonga query (`&@~` query syntax) from raw user input.
 *
 * - Multi-character terms are wrapped in double quotes (phrase match), which
 *   both escapes PGroonga query syntax characters and keeps the original
 *   `pg-tsquery`-style behavior. Terms are combined with AND semantics
 *   (PGroonga treats whitespace as AND in query syntax).
 * - Single-character terms are NOT included here: under the bigram tokenizer
 *   a lone CJK character is not a token (and `word*` only matches the start
 *   of the document text), so they are matched via LIKE substring matching
 *   instead (see `buildSingleCharLikeClause`), which PGroonga also accelerates.
 */
function buildPgroongaQuery(input: string): string {
  return input
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 1)
    .map((word) => `"${word.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(' ');
}

/** Escape LIKE wildcards so user input is matched literally. */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (m) => `\\${m}`);
}

@Injectable()
export class SearchService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private pageRepo: PageRepo,
    private shareRepo: ShareRepo,
    private spaceMemberRepo: SpaceMemberRepo,
    private pagePermissionRepo: PagePermissionRepo,
  ) {}

  async searchPage(
    searchParams: SearchDTO,
    opts: {
      userId?: string;
      workspaceId: string;
    },
  ): Promise<{ items: SearchResponseDto[] }> {
    const { query } = searchParams;

    if (query.trim().length < 1) {
      return { items: [] };
    }
    const terms = query.trim().split(/\s+/).filter(Boolean);
    const searchQuery = buildPgroongaQuery(query);
    const highlightKeywords = terms;
    const singleCharPatterns = terms
      .filter((term) => term.length === 1)
      .map((term) => `%${escapeLike(term)}%`);

    // PGroonga full-text match for multi-char terms
    const pgroongaClause = searchQuery
      ? sql<SqlBool>`(title &@~ ${searchQuery} OR text_content &@~ ${searchQuery})`
      : null;
    // LIKE substring fallback for single-char terms (bigram tokenizer cannot
    // index a lone CJK character). PGroonga accelerates these LIKE queries.
    const singleCharClause = singleCharPatterns.length
      ? sql<SqlBool>`(${sql.join(
          singleCharPatterns.map(
            (p) =>
              sql<SqlBool>`(title LIKE ${p} ESCAPE '\\' OR text_content LIKE ${p} ESCAPE '\\')`,
          ),
          sql` AND `,
        )})`
      : null;

    const fullTextClause =
      pgroongaClause && singleCharClause
        ? sql<SqlBool>`(${pgroongaClause} OR ${singleCharClause})`
        : (pgroongaClause ?? singleCharClause)!;

    // Title-match bonus (mirrors the old ts_rank A/B weighting)
    const titleBonusClause =
      pgroongaClause && singleCharClause
        ? sql`(title &@~ ${searchQuery} OR ${sql.join(
            singleCharPatterns.map((p) => sql`title LIKE ${p} ESCAPE '\\'`),
            sql` OR `,
          )})`
        : pgroongaClause
          ? sql`title &@~ ${searchQuery}`
          : sql`(${sql.join(
              singleCharPatterns.map((p) => sql`title LIKE ${p} ESCAPE '\\'`),
              sql` OR `,
            )})`;

    let queryResults = this.db
      .selectFrom('pages')
      .select([
        'id',
        'slugId',
        'title',
        'icon',
        'parentPageId',
        'creatorId',
        'createdAt',
        'updatedAt',
        sql<number>`(pgroonga_score(pages.tableoid, pages.ctid) + CASE WHEN ${titleBonusClause} THEN 1000 ELSE 0 END)`.as(
          'rank',
        ),
        sql<string>`COALESCE(array_to_string(pgroonga_snippet_html(text_content, ${highlightKeywords}), ' ... '), '')`.as(
          'highlight',
        ),
      ])
      .where(fullTextClause)
      .$if(Boolean(searchParams.creatorId), (qb) =>
        qb.where('creatorId', '=', searchParams.creatorId),
      )
      .where('deletedAt', 'is', null)
      .orderBy('rank', 'desc')
      .limit(searchParams.limit || 25)
      .offset(searchParams.offset || 0);

    if (!searchParams.shareId) {
      queryResults = queryResults.select((eb) => this.pageRepo.withSpace(eb));
    }

    if (searchParams.spaceId) {
      // search by spaceId
      queryResults = queryResults.where('spaceId', '=', searchParams.spaceId);
    } else if (opts.userId && !searchParams.spaceId) {
      // only search spaces the user is a member of
      queryResults = queryResults
        .where(
          'spaceId',
          'in',
          this.spaceMemberRepo.getUserSpaceIdsQuery(opts.userId),
        )
        .where('workspaceId', '=', opts.workspaceId);
    } else if (searchParams.shareId && !searchParams.spaceId && !opts.userId) {
      // search in shares
      const shareId = searchParams.shareId;
      const share = await this.shareRepo.findById(shareId);
      if (!share || share.workspaceId !== opts.workspaceId) {
        return { items: [] };
      }

      const isRestricted =
        await this.pagePermissionRepo.hasRestrictedAncestor(share.pageId);
      if (isRestricted) {
        return { items: [] };
      }

      const pageIdsToSearch = [];
      if (share.includeSubPages) {
        const pageList = await this.pageRepo.getPageAndDescendantsExcludingRestricted(
          share.pageId,
          {
            includeContent: false,
          },
        );

        pageIdsToSearch.push(...pageList.map((page) => page.id));
      } else {
        pageIdsToSearch.push(share.pageId);
      }

      if (pageIdsToSearch.length > 0) {
        queryResults = queryResults
          .where('id', 'in', pageIdsToSearch)
          .where('workspaceId', '=', opts.workspaceId);
      } else {
        return { items: [] };
      }
    } else {
      return { items: [] };
    }

    //@ts-ignore
    let results: any[] = await queryResults.execute();

    // Filter results by page-level permissions (if user is authenticated)
    if (opts.userId && results.length > 0) {
      const pageIds = results.map((r: any) => r.id);
      const accessibleIds =
        await this.pagePermissionRepo.filterAccessiblePageIds({
          pageIds,
          userId: opts.userId,
          spaceId: searchParams.spaceId,
        });
      const accessibleSet = new Set(accessibleIds);
      results = results.filter((r: any) => accessibleSet.has(r.id));
    }

    //@ts-ignore
    const searchResults = results.map((result: SearchResponseDto) => {
      if (result.highlight) {
        // pgroonga_snippet_html emits <span class="keyword">, which the client
        // DOMPurify whitelist strips — convert to <mark> for highlighting.
        result.highlight = result.highlight
          .replace(/<span class="keyword">/g, '<mark>')
          .replace(/<\/span>/g, '</mark>')
          .replace(/\r\n|\r|\n/g, ' ')
          .replace(/\s+/g, ' ');
      }
      return result;
    });

    return { items: searchResults };
  }

  async searchSuggestions(
    suggestion: SearchSuggestionDTO,
    userId: string,
    workspaceId: string,
  ) {
    let users = [];
    let groups = [];
    let pages = [];

    const limit = suggestion?.limit || 10;
    const query = suggestion.query.toLowerCase().trim();

    if (suggestion.includeUsers) {
      const userQuery = this.db
        .selectFrom('users')
        .select(['id', 'name', 'email', 'avatarUrl'])
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .where((eb) =>
          eb.or([
            eb(
              sql`LOWER(f_unaccent(users.name))`,
              'like',
              sql`LOWER(f_unaccent(${`%${query}%`}))`,
            ),
            eb(sql`users.email`, 'ilike', sql`f_unaccent(${`%${query}%`})`),
          ]),
        )
        .limit(limit);

      users = await userQuery.execute();
    }

    if (suggestion.includeGroups) {
      groups = await this.db
        .selectFrom('groups')
        .select(['id', 'name', 'description'])
        .where((eb) =>
          eb(
            sql`LOWER(f_unaccent(groups.name))`,
            'like',
            sql`LOWER(f_unaccent(${`%${query}%`}))`,
          ),
        )
        .where('workspaceId', '=', workspaceId)
        .limit(limit)
        .execute();
    }

    if (suggestion.includePages) {
      let pageSearch = this.db
        .selectFrom('pages')
        .select(['id', 'slugId', 'title', 'icon', 'spaceId'])
        .select((eb) => this.pageRepo.withSpace(eb))
        .where((eb) =>
          eb(
            sql`LOWER(f_unaccent(pages.title))`,
            'like',
            sql`LOWER(f_unaccent(${`%${query}%`}))`,
          ),
        )
        .where('deletedAt', 'is', null)
        .where('workspaceId', '=', workspaceId)
        .limit(limit);

      // search all spaces the user has access to, prioritizing the current space
      const userSpaceIds = await this.spaceMemberRepo.getUserSpaceIds(userId);

      if (userSpaceIds?.length > 0) {
        pageSearch = pageSearch.where('spaceId', 'in', userSpaceIds);

        if (suggestion?.spaceId) {
          pageSearch = pageSearch.orderBy(
            sql`CASE WHEN pages."space_id" = ${suggestion.spaceId} THEN 0 ELSE 1 END`,
            'asc',
          );
        }

        pages = await pageSearch.execute();
      }

      // Filter by page-level permissions
      if (pages.length > 0) {
        const pageIds = pages.map((p) => p.id);
        const accessibleIds =
          await this.pagePermissionRepo.filterAccessiblePageIds({
            pageIds,
            userId,
          });
        const accessibleSet = new Set(accessibleIds);
        pages = pages.filter((p) => accessibleSet.has(p.id));
      }
    }

    return { users, groups, pages };
  }
}
