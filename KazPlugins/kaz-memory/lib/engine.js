/**
 * The memory service (`ctx.memory`): durable plaintext records over two
 * storage roots — `global` in the harness home, `project` in the current
 * project folder (`.dsh/`), so project memory follows the repository. A record
 * is always created `pending` and becomes effective only through `setStatus`.
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
/** 旧状态 → 新状态兼容映射：suggested→pending、suggest→ignored、auto→applied。 */
const STATUS_ALIASES = {
    suggested: 'pending',
    suggest: 'ignored',
    auto: 'applied',
};
/** 把任意旧/新状态值规整为新状态值；未知值原样返回。 */
export function normalizeStatus(status) {
    return STATUS_ALIASES[status] ?? status;
}
const blockSchema = z.object({
    namespace: z.enum(['global', 'project']),
    // 同时接受旧值，保证旧 JSON 可读；对外统一返回 pending/ignored/applied。
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
    /** Create one record in `pending` status — never self-promoting.
     *  `name` / `summary` are taken from the input when provided (name falls
     *  back to deriving from the content; summary defaults to ''). */
    async remember(input) {
        const namespace = input.namespace ?? 'global';
        const id = randomUUID();
        const block = writtenBlock({
            namespace,
            status: 'pending',
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
     * If an `applied` record's content changes, it is demoted to `pending` so a
     * human can re-confirm the new body; metadata-only edits (name / keywords /
     * summary) keep the status.
     */
    async update(id, patch = {}) {
        const applyPatch = (block) => {
            const contentChanged = typeof patch.content === 'string' && patch.content !== block.content;
            const content = contentChanged ? patch.content : block.content;
            const name = typeof patch.name === 'string'
                ? patch.name.trim()
                : (contentChanged ? deriveName(content) : block.name);
            const summary = typeof patch.summary === 'string' ? patch.summary : block.summary;
            const keywords = Array.isArray(patch.keywords)
                ? patch.keywords.map((keyword) => String(keyword).toLowerCase())
                : block.keywords;
            const currentStatus = normalizeStatus(block.status);
            const status = currentStatus === 'applied' && contentChanged ? 'pending' : currentStatus;
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
