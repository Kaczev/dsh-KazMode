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
import { bm25Scores } from "./bm25.js";
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
    content: z.string(),
    keywords: z.array(z.string()),
    createdAt: z.number(),
    updatedAt: z.number(),
});
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
    return {
        id: MemoryId(id),
        ...block,
        status: normalizeStatus(block.status),
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
    /** Create one record in `pending` status — never self-promoting. */
    async remember(input) {
        const namespace = input.namespace ?? 'global';
        const id = randomUUID();
        const now = Date.now();
        const block = {
            namespace,
            status: 'pending',
            autoLoad: false,
            name: deriveName(input.content),
            content: input.content,
            keywords: (input.keywords ?? []).map(keyword => keyword.toLowerCase()),
            createdAt: now,
            updatedAt: now,
        };
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
    async search(query, filter = {}) {
        const records = await this.list(filter);
        const docs = records.map(record => `${record.content} ${record.keywords.join(' ')}`);
        const scores = bm25Scores(query, docs);
        return records
            .map((record, index) => ({ record, score: scores[index] ?? 0 }))
            .filter(hit => hit.score > 0)
            .sort((left, right) => right.score - left.score);
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
            const updated = { ...global, status: next, updatedAt: Date.now() };
            await this.requireTable('global').put(id, updated);
            const record = toRecord(id, updated);
            this.ctx.emit('memory/changed', { operation: 'status', id, status: next });
            return record;
        }
        for (const [root, entry] of this.projectEntries) {
            const block = entry.table.get(id);
            if (block !== undefined) {
                const updated = { ...block, status: next, updatedAt: Date.now() };
                await entry.table.put(id, updated);
                const record = toRecord(id, updated, root);
                this.ctx.emit('memory/changed', { operation: 'status', id, status: next, projectRoot: root });
                return record;
            }
        }
        throw new Error(`cannot set status of unknown memory '${id}'`);
    }
    /**
     * Update an existing record's content / keywords / name.
     * If an `applied` record's content changes, it is demoted to `pending` so a
     * human can re-confirm the new body; metadata-only edits keep the status.
     */
    async update(id, patch = {}) {
        const applyPatch = (block) => {
            const contentChanged = typeof patch.content === 'string' && patch.content !== block.content;
            const content = contentChanged ? patch.content : block.content;
            const name = typeof patch.name === 'string'
                ? patch.name.trim()
                : (contentChanged ? deriveName(content) : block.name);
            const keywords = Array.isArray(patch.keywords)
                ? patch.keywords.map((keyword) => String(keyword).toLowerCase())
                : block.keywords;
            const currentStatus = normalizeStatus(block.status);
            const status = currentStatus === 'applied' && contentChanged ? 'pending' : currentStatus;
            return { ...block, content, name, keywords, status, updatedAt: Date.now() };
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
            const updated = { ...global, status: normalizeStatus(global.status), autoLoad: autoLoad === true, updatedAt: Date.now() };
            await this.requireTable('global').put(id, updated);
            const record = toRecord(id, updated);
            this.ctx.emit('memory/changed', { operation: 'autoLoad', id, autoLoad: updated.autoLoad });
            return record;
        }
        for (const [root, entry] of this.projectEntries) {
            const block = entry.table.get(id);
            if (block !== undefined) {
                const updated = { ...block, status: normalizeStatus(block.status), autoLoad: autoLoad === true, updatedAt: Date.now() };
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
        const update = (block) => ({ ...block, status: normalizeStatus(block.status), name: clean, updatedAt: Date.now() });
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
