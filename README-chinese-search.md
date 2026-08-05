# docmost-chinese-supported

Docmost 中文全文搜索支持分支 (基于 pgroonga)。

## 背景

docmost 默认使用 PostgreSQL 内置的 `english` 全文搜索配置 (`to_tsvector` / `to_tsquery`),
该分词器不认识中文 — 整段连续中文被当作单个 lexeme, 导致:
- 中文页面搜索不到内容中的词(只能精确匹配整个中文串)
- 无法按词相关性排序
- `ts_headline` 高亮对中文无效

本分支将默认搜索驱动从 tsvector 切换为 **PGroonga** (bigram 分词), 实现中文全文搜索,
同时保持英文搜索体验。

## 修改内容 (最小改动)

### 1. 新迁移 `apps/server/src/database/migrations/20260805T000000-pgroonga-search.ts`

- `CREATE EXTENSION IF NOT EXISTS pgroonga`
- pages 表新增两个 pgroonga 索引:
  - `pages_pgroonga_title_idx` on `title`
  - `pages_pgroonga_text_content_idx` on `text_content`
- attachments 表同样新增 file_name / text_content 两个索引(供 EE 附件搜索使用)
- 索引配置: `tokenizer='TokenBigram', normalizer='NormalizerAuto'`
  (TokenBigram = 中文/日文/韩文按 2-gram, 英文整词)
- 保留原有 tsvector 列与触发器, 完全可回退

### 2. `apps/server/src/core/search/search.service.ts`

- 移除 `pg-tsquery` 依赖, 新增 `buildPgroongaQuery()`:
  - 多字词 → `"词"` (phrase, 空格 AND 语义, 同时转义特殊字符)
  - 单字词 → LIKE 子串匹配兜底(bigram 分词器无法索引单字, 且 `word*` 只匹配文档起始文本)
- `tsv @@ to_tsquery('english', ...)` → `title &@~ q OR text_content &@~ q`
  (+ 单字词 `title LIKE '%字%'` 条件, PGroonga 同样加速 LIKE)
- `ts_rank(tsv, ...)` → `pgroonga_score(tableoid, ctid) + title 命中加权 1000`
  (标题命中的结果排前面, 与原版 ts_rank A/B 权重行为一致)
- `ts_headline('english', ...)` → `pgroonga_snippet_html(text_content, ARRAY[...])`,
  输出 `<span class="keyword">` 转为 `<mark>` 以适配前端 DOMPurify 白名单
- 搜索建议 (`/search/suggest`) 保持 LIKE 实现(中文子串匹配本就可用, 未改动)

## 数据库要求

PostgreSQL 需预装 PGroonga 扩展 (>= 4.0)。本机已有镜像:

    ghcr.io/appthing-dev/postgres-pgroonga-pgvector:latest

官方 `postgres:18` 镜像不含 pgroonga, 部署时必须使用上面的镜像(或自行编译 pgroonga)。

## 验证

- 完整迁移链 (50+ 迁移) 在 pgroonga 镜像上执行成功
- 中文多词搜索: `"中文" "搜索"` AND 匹配 ✓
- 中文词中间匹配: 搜 "残骸" 命中 "一枚SpaceX猎鹰9火箭第二级残骸撞击月球表面" ✓ (原版做不到)
- 单字搜索: `文`、`月` 命中标题/内容 ✓ (LIKE 兜底)
- 英文整词搜索: `SpaceX` ✓
- 标题命中加权排序 (rank=1000) ✓
- 高亮片段 `<mark>` 输出 ✓
- 特殊字符输入 (`100%`) 安全无语法错误 ✓
- 已在真实浏览器 UI 创建的中文页面上验证 (用户实机测试数据)
