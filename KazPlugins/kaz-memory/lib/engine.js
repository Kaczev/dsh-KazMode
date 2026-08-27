/**
 * The memory service (`ctx.memory`): durable plaintext records over two
 * storage roots — `global` in the harness home, `project` in the current
 * project folder (`.dsh/`), so project memory follows the repository. A record
 * is created `applied` directly (no manual confirmation gate); legacy
 * `pending` records are normalized to `applied` when read.
 *
 * Project memory is PER-PROJECT-FOLDER: each distinct project root gets its
 * own `memory_project.json` under `<project>/.dsh/storages/`, opened lazily
 * and keyed by the resolved absolute project path. The project root is
 * supplied by the caller (usually the agent's session `cwd`), falling back to
 * `config.projectRoot` / `process.cwd()` when absent. Never use
 * `process.cwd()` as the project root on purpose — the dsh backend process
 * cwd (e.g. the Desktop) is NOT the project folder; the agent session header
 * `cwd` is.
 *
 * Vendored from @max-null/dsh-memory (MIT License, Copyright (c) Max-Null).
 * Source: https://github.com/Max-Null/dsh-memory
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Service } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { defineDomain, domainTable, DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { bm25ScoresAsync } from "./bm25.js";
/** Brand a string as a {@link MemoryId} (compile-time only). */
export function MemoryId(id) {
    return id;
}
/** 旧状态 → 新状态兼容映射：suggested/pending→applied、suggest→ignored、auto→applied。
 *  不再有 pending 状态：旧 JSON 里的 pending/suggested 读取时直接归一为 applied。 */
const STATUS_ALIASES = {
    pending: 'applied',
    suggested: 'applied',
    suggest: 'ignored',
    auto: 'applied',
};
/** 把任意旧/新状态值规整为新状态值；未知值原样返回。 */
export function normalizeStatus(status) {
    return STATUS_ALIASES[status] ?? status;
}
const blockSchema = z.object({
    namespace: z.enum(['global', 'project']),
    // 同时接受旧值，保证旧 JSON 可读；对外统一返回 applied/ignored（pending/suggested 归一为 applied）。
    status: z.enum(['pending', 'ignored', 'applied', 'suggested', 'suggest', 'auto']),
    autoLoad: z.boolean().default(false),
    name: z.string().default(''),
    summary: z.string().default(''),
    content: z.string(),
    keywords: z.array(z.string()),
    // 新时间戳格式（2026-08 升级）：ISO 字符串（created_at / updated_at）。
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    // 旧时间戳格式（2026-08 之前，毫秒数字）：读取时迁移为 ISO；写回时不再保留。
    createdAt: z.number().optional(),
    updatedAt: z.number().optional(),
});
/** ISO 字符串或毫秒数字 → ISO 字符串；其它值返回 undefined。 */
const isoOf = (value) => {
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
    return undefined;
};
const isoNow = () => new Date().toISOString();
/** 规整时间戳：新格式优先，旧数字格式迁移为 ISO，缺失时兜底当前时间。 */
function timestampsOf(block) {
    const created_at = isoOf(block.created_at) ?? isoOf(block.createdAt) ?? isoNow();
    const updated_at = isoOf(block.updated_at) ?? isoOf(block.updatedAt) ?? created_at;
    return { created_at, updated_at };
}
/** 写盘块：只保留新格式时间戳（完全迁移——旧数字键不再写回 JSON，读时自动迁移）。 */
function writtenBlock(block, refreshUpdatedAt = true) {
    const { created_at, updated_at } = timestampsOf(block);
    const next = { ...block, created_at, updated_at: refreshUpdatedAt ? isoNow() : created_at };
    delete next.createdAt;
    delete next.updatedAt;
    return next;
}
/** Shared table shape; the two domains differ only by name and backend route. */
function memorySpec(name) {
    return defineDomain({
        name,
        version: 1,
        tables: { blocks: domainTable(blockSchema) },
    });
}
/** Derive a memory display name from its content: title line (#) or first line, ≤140 chars. */
function deriveName(content, max = 140) {
    if (typeof content !== 'string') return '';
    const lines = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    if (lines.length === 0) return '';
    const title = lines.find((line) => line.startsWith('#'));
    const head = (title ?? lines[0]).replace(/^#+\s*/, '').trim();
    return head.length > max ? head.slice(0, max) + '…' : head;
}

/** 规整关键词：小写、去重、丢弃空串。 */
function normalizeKeywords(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const result = [];
    for (const item of value) {
        const keyword = typeof item === 'string' ? item.trim().toLowerCase() : '';
        if (keyword.length === 0 || seen.has(keyword)) continue;
        seen.add(keyword);
        result.push(keyword);
    }
    return result;
}

/**
 * 在 content 中查找 `find` 的所有非重叠匹配位置。
 * `before` / `after` 存在时，要求匹配片段的前/后紧邻文字完全一致（字面量、大小写敏感）。
 */
function findMatches(content, find, before, after) {
    if (typeof find !== 'string' || find.length === 0) {
        throw new Error('edit.find must be a non-empty string');
    }
    if (before !== undefined && typeof before !== 'string') throw new Error('edit.before must be a string');
    if (after !== undefined && typeof after !== 'string') throw new Error('edit.after must be a string');
    const beforeText = before ?? '';
    const afterText = after ?? '';
    const matches = [];
    let index = 0;
    while (index <= content.length) {
        const pos = content.indexOf(find, index);
        if (pos === -1) break;
        const beforeOk = beforeText.length === 0 || (pos >= beforeText.length && content.slice(pos - beforeText.length, pos) === beforeText);
        const afterOk = afterText.length === 0 || (pos + find.length + afterText.length <= content.length && content.slice(pos + find.length, pos + find.length + afterText.length) === afterText);
        if (beforeOk && afterOk) matches.push(pos);
        index = pos + find.length;
    }
    return matches;
}

/** 取一个 edit 的目标匹配位置；未指定 occurrence 时要求唯一匹配。 */
function targetMatches(edit, matches, label) {
    const occurrence = edit.occurrence;
    if (occurrence === undefined) {
        if (matches.length !== 1) {
            throw new Error(`${label}: find ${JSON.stringify(edit.find)} matches ${matches.length} times; add before/after context or occurrence`);
        }
        return [matches[0]];
    }
    if (occurrence === 'all') return matches;
    const numeric = typeof occurrence === 'number'
        ? occurrence
        : (typeof occurrence === 'string' && /^\d+$/.test(occurrence) ? Number(occurrence) : Number.NaN);
    if (Number.isInteger(numeric) && numeric >= 1) {
        if (numeric > matches.length) {
            throw new Error(`${label}: occurrence ${numeric} out of range (${matches.length} match${matches.length === 1 ? '' : 'es'})`);
        }
        return [matches[numeric - 1]];
    }
    throw new Error(`${label}: occurrence must be a positive integer or "all"`);
}

/** 对正文按 edits 列表逐条应用字面量编辑；任一步失败即抛错，不产生部分结果。 */
export function applyContentEdits(content, edits) {
    if (!Array.isArray(edits)) throw new Error('edits must be an array');
    let result = content;
    for (let i = 0; i < edits.length; i += 1) {
        const edit = edits[i];
        const label = `edit ${i + 1}`;
        if (edit === null || typeof edit !== 'object') throw new Error(`${label} must be an object`);
        const type = edit.type;
        if (type === 'append' || type === 'prepend') {
            if (typeof edit.text !== 'string') throw new Error(`${label}: text must be a string`);
            result = type === 'append' ? result + edit.text : edit.text + result;
            continue;
        }
        if (type !== 'replace' && type !== 'insertAfter' && type !== 'insertBefore') {
            throw new Error(`${label}: unknown type ${JSON.stringify(type)}`);
        }
        const find = edit.find;
        const matches = findMatches(result, find, edit.before, edit.after);
        const targets = targetMatches(edit, matches, label);
        if (type === 'replace' && typeof edit.replace !== 'string') {
            throw new Error(`${label}: replace must be a string (use "" to delete)`);
        }
        if (type !== 'replace' && typeof edit.text !== 'string') {
            throw new Error(`${label}: text must be a string`);
        }
        const insertion = type === 'replace' ? edit.replace : edit.text;
        const sorted = [...targets].sort((a, b) => a - b);
        let out = '';
        let cursor = 0;
        for (const pos of sorted) {
            out += result.slice(cursor, pos);
            if (type === 'insertBefore') out += insertion;
            if (type === 'replace') {
                out += insertion;
            } else {
                out += result.slice(pos, pos + find.length);
            }
            if (type === 'insertAfter') out += insertion;
            cursor = pos + find.length;
        }
        out += result.slice(cursor);
        result = out;
    }
    return result;
}

/**
 * 计算更新后的 keywords：
 * - `patch.keywords` 提供时整体替换（与 keywordsAdd/Remove 互斥）；
 * - 否则按 keywordsRemove → keywordsAdd 增量调整，缺失/已存在均静默 no-op。
 */
export function applyKeywordPatch(keywords, patch) {
    const hasFull = Array.isArray(patch.keywords);
    const hasAdd = Array.isArray(patch.keywordsAdd);
    const hasRemove = Array.isArray(patch.keywordsRemove);
    if (hasFull && (hasAdd || hasRemove)) {
        throw new Error('cannot use keywords together with keywordsAdd/keywordsRemove');
    }
    let next = hasFull ? normalizeKeywords(patch.keywords) : normalizeKeywords(keywords);
    if (hasRemove) {
        const removeSet = new Set(normalizeKeywords(patch.keywordsRemove));
        next = next.filter((keyword) => !removeSet.has(keyword));
    }
    if (hasAdd) {
        for (const keyword of normalizeKeywords(patch.keywordsAdd)) {
            if (!next.includes(keyword)) next.push(keyword);
        }
    }
    return next;
}
function toRecord(id, block, projectRoot) {
    const { created_at, updated_at } = timestampsOf(block);
    const { createdAt, updatedAt, ...rest } = block;
    return {
        id: MemoryId(id),
        ...rest,
        status: normalizeStatus(rest.status),
        // 旧记录可能没有 summary/name（绕过 zod 默认值的原始块）：规整为字符串。
        summary: typeof rest.summary === 'string' ? rest.summary : '',
        name: typeof rest.name === 'string' ? rest.name : '',
        created_at,
        updated_at,
        ...(projectRoot === undefined ? {} : { projectRoot }),
    };
}
/** Harness-home root for `global` memories. */
function globalRoot() {
    return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages');
}
/** `<project>/.dsh/storages` — project memory follows the repository folder. */
function projectStoragesRoot(projectRoot) {
    return join(resolve(projectRoot), '.dsh', 'storages');
}
/**
 * Cross-session plaintext memory over the storage hub, split by namespace:
 * `global` lives in the harness home, `project` lives per project folder
 * (lazily opened per resolved project root).
 */
export class MemoryEngine extends Service {
    config;
    static inject = ['storage'];
    globalBackend;
    globalDispose;
    globalFacility;
    globalTable;
    /** projectRoot -> { backend, disposeBackend, facility, domain, table } */
    projectEntries = new Map();
    /** projectRoot -> in-flight open promise (concurrent opens of one root serialize). */
    projectOpening = new Map();
    projectCounter = 0;
    constructor(ctx, config = {}) {
        super(ctx, 'memory');
        this.config = config;
    }
    async [Service.init]() {
        const globalBackend = new JsonStorageBackend(this.config.globalRoot ?? globalRoot());
        this.globalBackend = globalBackend;
        this.globalDispose = this.ctx.storage.backend.register('memory-global', globalBackend);
        this.globalFacility = new DomainFacility(this.ctx, { backend: 'memory-global' });
        const globalDomain = await this.globalFacility.open(memorySpec('memory'));
        this.globalTable = globalDomain.table('blocks');
        this.ctx.effect(() => () => { void this.closeAll(); }, 'memory.domainsClose');
    }
    /** Tear down the global domain and every lazily opened project domain. */
    async closeAll() {
        this.globalDispose?.();
        void this.globalFacility?.closeAll();
        void this.globalBackend?.close?.();
        for (const entry of this.projectEntries.values()) {
            entry.disposeBackend?.();
            void entry.facility?.closeAll();
            void entry.backend?.close?.();
        }
    }
    /** Resolve the default project root: explicit config, else process cwd. */
    defaultProjectRoot() {
        return resolve(this.config.projectRoot ?? process.cwd());
    }
    /** Harness-home storages folder holding `memory.json`. */
    globalStoragesRoot() {
        return this.config.globalRoot ?? globalRoot();
    }
    /** `<project>/.dsh/storages` holding that project's `memory_project.json`. */
    projectStoragesRoot(projectRoot) {
        return projectStoragesRoot(projectRoot ?? this.defaultProjectRoot());
    }
    /** Lazily open (or return the already-open) project table for one root. */
    async ensureProject(projectRoot) {
        const normalized = resolve(projectRoot ?? this.defaultProjectRoot());
        const existing = this.projectEntries.get(normalized);
        if (existing !== undefined) return existing.table;
        let opening = this.projectOpening.get(normalized);
        if (opening !== undefined) return opening;
        opening = (async () => {
            const backendName = `memory-project-${this.projectCounter++}`;
            const backend = new JsonStorageBackend(projectStoragesRoot(normalized));
            const disposeBackend = this.ctx.storage.backend.register(backendName, backend);
            const facility = new DomainFacility(this.ctx, { backend: backendName });
            const domain = await facility.open(memorySpec('memory_project'));
            const table = domain.table('blocks');
            this.projectEntries.set(normalized, { root: normalized, backend, disposeBackend, facility, domain, table });
            return table;
        })();
        this.projectOpening.set(normalized, opening);
        try {
            return await opening;
        } finally {
            this.projectOpening.delete(normalized);
        }
    }
    /** Resolve the project table for one root (alias of ensureProject). */
    async projectTable(projectRoot) {
        return this.ensureProject(projectRoot);
    }
    /**
     * 只读路径取项目表：文件已存在才打开域，否则返回 undefined（视为空项目）。
     * 打开域会 `mkdir` `<root>/.dsh/storages`（JsonStorageBackend.openUnit 无条件建
     * 目录）——读操作绝不能因此建目录，否则镜像在无真实项目根时会去桌面建出
     * 空的 `.dsh/storages`（Kaczev 2026-08-17 的 bug）。写入路径用 ensureProject。
     */
    async projectTableForRead(projectRoot) {
        const normalized = resolve(projectRoot ?? this.defaultProjectRoot());
        const existing = this.projectEntries.get(normalized);
        if (existing !== undefined) return existing.table;
        if (!existsSync(join(projectStoragesRoot(normalized), 'memory_project.json'))) return undefined;
        return this.ensureProject(normalized);
    }
    /** Every project root opened so far, in open order. */
    projectRoots() {
        return [...this.projectEntries.keys()];
    }
    /** Create one record in `applied` status — memories take effect immediately
     *  (no human confirmation gate). `name` / `summary` are taken from the input
     *  when provided (name falls back to deriving from the content; summary
     *  defaults to ''). */
    async remember(input) {
        const namespace = input.namespace ?? 'global';
        const id = randomUUID();
        const block = writtenBlock({
            namespace,
            status: 'applied',
            autoLoad: false,
            name: typeof input.name === 'string' && input.name.trim().length > 0 ? input.name.trim() : deriveName(input.content),
            summary: typeof input.summary === 'string' ? input.summary : '',
            content: input.content,
            keywords: (input.keywords ?? []).map(keyword => keyword.toLowerCase()),
        }, false);
        if (namespace === 'project') {
            const root = resolve(input.projectRoot ?? this.defaultProjectRoot());
            const table = await this.ensureProject(root);
            await table.put(id, block);
            const record = toRecord(id, block, root);
            this.ctx.emit('memory/changed', { operation: 'remembered', record, projectRoot: root });
            return record;
        }
        await this.requireTable('global').put(id, block);
        const record = toRecord(id, block);
        this.ctx.emit('memory/changed', { operation: 'remembered', record });
        return record;
    }
    async list(filter = {}) {
        const records = await this.allRecords(filter?.namespace, filter?.projectRoot);
        const status = filter?.status === undefined ? undefined : normalizeStatus(filter.status);
        return records.filter(record =>
            (status === undefined || record.status === status) &&
            (filter?.autoLoad === undefined || (record.autoLoad === true) === (filter.autoLoad === true)));
    }
    /** BM25 search (okapibm25 via bm25ScoresAsync, non-blocking for ~1000
     *  memories). Scores are computed over content + summary + keywords
     *  (content is the primary field); k1 / b come from the caller (usually
     *  the `kaz-memory.bm25` settings section). */
    async search(query, filter = {}, bm25 = {}) {
        const records = await this.list(filter);
        if (records.length === 0) return [];
        const docs = records.map((record) =>
            [record.content, typeof record.summary === 'string' ? record.summary : '', record.keywords.join(' ')]
                .filter(Boolean)
                .join(' '),
        );
        const scores = await bm25ScoresAsync(query, docs, bm25);
        return records
            .map((record, index) => ({ record, score: scores[index] ?? 0 }))
            .filter(hit => hit.score > 0)
            .sort((left, right) => right.score - left.score);
    }
    /** Read a single record by id (global first, then every already-opened
     *  project domain). Read-only: never opens a new project domain. */
    async get(id, filter = {}) {
        const target = String(id);
        const global = this.requireTable('global').get(target);
        if (global !== undefined) return toRecord(target, global);
        const projectRoot = filter?.projectRoot === undefined ? undefined : resolve(filter.projectRoot);
        if (projectRoot !== undefined) {
            const entry = this.projectEntries.get(projectRoot);
            if (entry !== undefined) {
                const block = entry.table.get(target);
                if (block !== undefined) return toRecord(target, block, projectRoot);
            }
        }
        for (const [root, entry] of this.projectEntries) {
            const block = entry.table.get(target);
            if (block !== undefined) return toRecord(target, block, root);
        }
        return undefined;
    }
    async forget(id) {
        if (await this.requireTable('global').delete(id)) {
            this.ctx.emit('memory/changed', { operation: 'forgotten', id });
            return true;
        }
        // 只搜已打开的 project 域（打开中的根在 list/search/remember 时已打开）。
        for (const [root, entry] of this.projectEntries) {
            if (await entry.table.delete(id)) {
                this.ctx.emit('memory/changed', { operation: 'forgotten', id, projectRoot: root });
                return true;
            }
        }
        return false;
    }
    async setStatus(id, status) {
        const next = normalizeStatus(status);
        const global = this.requireTable('global').get(id);
        if (global !== undefined) {
            const updated = writtenBlock({ ...global, status: next });
            await this.requireTable('global').put(id, updated);
            const record = toRecord(id, updated);
            this.ctx.emit('memory/changed', { operation: 'status', id, status: next });
            return record;
        }
        for (const [root, entry] of this.projectEntries) {
            const block = entry.table.get(id);
            if (block !== undefined) {
                const updated = writtenBlock({ ...block, status: next });
                await entry.table.put(id, updated);
                const record = toRecord(id, updated, root);
                this.ctx.emit('memory/changed', { operation: 'status', id, status: next, projectRoot: root });
                return record;
            }
        }
        throw new Error(`cannot set status of unknown memory '${id}'`);
    }
    /**
     * Update an existing record's content / keywords / name / summary.
     * Content changes keep the record `applied` — there is no pending status or
     * re-confirmation gate. Legacy `ignored` records keep their status; legacy
     * `pending` records are normalized to `applied` on the way in.
     */
    async update(id, patch = {}) {
        const applyPatch = (block) => {
            const hasFullContent = typeof patch.content === 'string';
            const hasEdits = Array.isArray(patch.edits);
            if (hasFullContent && hasEdits) {
                throw new Error('cannot use content and edits together');
            }
            if (patch.edits !== undefined && !hasEdits) {
                throw new Error('edits must be an array');
            }
            const content = hasEdits
                ? applyContentEdits(block.content, patch.edits)
                : (hasFullContent ? patch.content : block.content);
            // 标题不自动推导：没传 name（或传空串）就继承旧标题。
            const name = typeof patch.name === 'string' && patch.name.trim().length > 0
                ? patch.name.trim()
                : block.name;
            const summary = typeof patch.summary === 'string' ? patch.summary : block.summary;
            const keywords = applyKeywordPatch(block.keywords, patch);
            const currentStatus = normalizeStatus(block.status);
            const status = currentStatus === 'ignored' ? 'ignored' : 'applied';
            return writtenBlock({ ...block, content, name, summary, keywords, status });
        };
        const global = this.requireTable('global').get(id);
        if (global !== undefined) {
            const updated = applyPatch(global);
            await this.requireTable('global').put(id, updated);
            const record = toRecord(id, updated);
            this.ctx.emit('memory/changed', { operation: 'updated', id, record });
            return record;
        }
        for (const [root, entry] of this.projectEntries) {
            const block = entry.table.get(id);
            if (block !== undefined) {
                const updated = applyPatch(block);
                await entry.table.put(id, updated);
                const record = toRecord(id, updated, root);
                this.ctx.emit('memory/changed', { operation: 'updated', id, record, projectRoot: root });
                return record;
            }
        }
        throw new Error(`cannot update unknown memory '${id}'`);
    }
    /** Mark one record as auto-loading (injected when memory_search first becomes usable) or not. */
    async setAutoLoad(id, autoLoad) {
        const global = this.requireTable('global').get(id);
        if (global !== undefined) {
            const updated = writtenBlock({ ...global, status: normalizeStatus(global.status), autoLoad: autoLoad === true });
            await this.requireTable('global').put(id, updated);
            const record = toRecord(id, updated);
            this.ctx.emit('memory/changed', { operation: 'autoLoad', id, autoLoad: updated.autoLoad });
            return record;
        }
        for (const [root, entry] of this.projectEntries) {
            const block = entry.table.get(id);
            if (block !== undefined) {
                const updated = writtenBlock({ ...block, status: normalizeStatus(block.status), autoLoad: autoLoad === true });
                await entry.table.put(id, updated);
                const record = toRecord(id, updated, root);
                this.ctx.emit('memory/changed', { operation: 'autoLoad', id, autoLoad: updated.autoLoad, projectRoot: root });
                return record;
            }
        }
        throw new Error(`cannot set autoLoad of unknown memory '${id}'`);
    }
    /** Rename one record (display name persisted in JSON). */
    async setName(id, name) {
        const clean = String(name ?? '').trim();
        const update = (block) => writtenBlock({ ...block, status: normalizeStatus(block.status), name: clean });
        const global = this.requireTable('global').get(id);
        if (global !== undefined) {
            const updated = update(global);
            await this.requireTable('global').put(id, updated);
            const record = toRecord(id, updated);
            this.ctx.emit('memory/changed', { operation: 'renamed', id, name: clean });
            return record;
        }
        for (const [root, entry] of this.projectEntries) {
            const block = entry.table.get(id);
            if (block !== undefined) {
                const updated = update(block);
                await entry.table.put(id, updated);
                const record = toRecord(id, updated, root);
                this.ctx.emit('memory/changed', { operation: 'renamed', id, name: clean, projectRoot: root });
                return record;
            }
        }
        throw new Error(`cannot rename unknown memory '${id}'`);
    }
    async allRecords(namespace, projectRoot) {
        if (namespace === 'project') {
            const root = resolve(projectRoot ?? this.defaultProjectRoot());
            const table = await this.projectTableForRead(root);
            return table === undefined ? [] : this.recordsOfRoot(table, root);
        }
        if (namespace === 'global') return this.recordsOf(this.requireTable('global'));
        const root = resolve(projectRoot ?? this.defaultProjectRoot());
        const table = await this.projectTableForRead(root);
        return [
            ...this.recordsOf(this.requireTable('global')),
            ...(table === undefined ? [] : this.recordsOfRoot(table, root)),
        ];
    }
    recordsOf(table) {
        return [...table.entries()].map(([id, block]) => toRecord(id, block));
    }
    recordsOfRoot(table, projectRoot) {
        return [...table.entries()].map(([id, block]) => toRecord(id, block, projectRoot));
    }
    tableFor(namespace) {
        return this.requireTable(namespace);
    }
    requireTable(namespace) {
        const table = namespace === 'global' ? this.globalTable : undefined;
        if (table === undefined)
            throw new Error('memory engine is not started yet (project tables are resolved per root)');
        return table;
    }
}
