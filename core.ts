/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Deletion engine ported from Purgecord (https://github.com/feelmypain/purgecord),
// itself a fork of Undiscord by victornpb (MIT). Requests go through Discord's
// own RestAPI, so the plugin never reads or handles the account token.

import { RestAPI } from "@webpack/common";

export type LogType = "debug" | "info" | "verb" | "warn" | "error" | "success";
export interface LogLine { id: number; type: LogType; text: string; }

export interface PurgeOptions {
    authorId: string;
    guildId: string;
    channelId?: string;
    minId?: string;
    maxId?: string;
    content?: string;
    pattern?: string;
    hasLink: boolean;
    hasFile: boolean;
    includeNsfw: boolean;
    includePinned: boolean;
    searchDelay: number;
    deleteDelay: number;
}

export interface PurgeJob { guildId: string; channelId?: string; }

interface Resp { ok: boolean; status: number; body: any; headers: Record<string, string>; }

/** Discord search pages contain at most 25 hits; history pages contain 100 messages. */
const PAGE_SIZE = 25;
const HISTORY_PAGE_SIZE = 100;
const MAX_SEARCH_ATTEMPTS = 20;
/** How many times a finished walk may restart to sweep up stragglers. */
const MAX_SWEEPS = 2;
/** Transient retries for one message, separate from MAX_ATTEMPT. */
const MAX_TRANSIENT_RETRIES = 5;
const MAX_ATTEMPT = 2;
const EMPTY_PAGE_RETRIES = 3;
const JOB_DELAY = 10000;
const MAX_SEARCH_DELAY = 60000;
const MAX_DELETE_DELAY = 30000;
/** Padding on top of the retry_after Discord asks for, to survive clock skew. */
const RETRY_MARGIN = 250;
const MAX_LOG_LINES = 2000;
/** Discord snowflakes count milliseconds from 2015-01-01T00:00:00Z. */
const DISCORD_EPOCH = 1420070400000;

/**
 * Message types Discord refuses to delete. Everything not listed here is
 * deletable, so new message types keep working without a code change.
 */
const UNDELETABLE_MESSAGE_TYPES = new Set([1, 2, 3, 4, 5, 21, 33, 34, 35, 56, 57, 64]);

/** Discord error codes that will never succeed for this message. */
const PERMANENT_DELETE_ERRORS: Record<number, string> = {
    50021: "it is a system message",
    160005: "the thread is locked",
    50013: "you do not have permission to delete it",
    50001: "you do not have access to that channel",
    50003: "that action cannot be performed on a DM channel",
};

type Outcome = "DELETED" | "ALREADY_GONE" | "RETRY" | "SKIPPED" | "FAILED";

class PurgeError extends Error {
    constructor(message: string, readonly fatal = false) {
        super(message);
    }
}

const wait = (ms: number) => new Promise(done => setTimeout(done, Math.max(0, Number(ms) || 0)));
const clamp = (value: number, min: number, max: number) => value < min ? min : value > max ? max : value;
const errorText = (err: unknown) => err instanceof Error ? err.message : String(err);

export const isSnowflake = (value: unknown) => /^\d{17,20}$/.test(String(value).trim());

export const msToHMS = (ms: number) => Number.isFinite(ms) && ms >= 0
    ? `${ms / 3.6e6 | 0}h ${(ms % 3.6e6) / 6e4 | 0}m ${(ms % 6e4) / 1000 | 0}s`
    : "--h --m --s";

/** Accept either a snowflake or a date and return a snowflake string. */
export function toSnowflake(value: unknown): string | undefined {
    const str = String(value ?? "").trim();
    if (!str) return undefined;
    if (isSnowflake(str)) return str;
    const time = Date.parse(str);
    if (Number.isNaN(time)) return undefined;
    return ((BigInt(Math.max(time, DISCORD_EPOCH)) - BigInt(DISCORD_EPOCH)) << 22n).toString();
}

function queryString(params: [string, unknown][]) {
    return params
        .filter(p => p[1] !== undefined && p[1] !== null && p[1] !== "")
        .map(p => p[0] + "=" + encodeURIComponent(String(p[1])))
        .join("&");
}

export function displayName(user: any) {
    if (!user) return "unknown";
    if (user.global_name) return user.global_name;
    if (user.discriminator && user.discriminator !== "0") return `${user.username}#${user.discriminator}`;
    return user.username || "unknown";
}

/** Normalise Discord's HTTP client, which rejects on non-2xx responses. */
async function rest(method: "get" | "del" | "patch", url: string, body?: Record<string, any>): Promise<Resp> {
    try {
        const r = await RestAPI[method]({ url, body });
        return { ok: true, status: r?.status ?? 200, body: r?.body, headers: r?.headers ?? {} };
    } catch (e: any) {
        if (e && typeof e.status === "number" && e.status > 0)
            return { ok: false, status: e.status, body: e.body, headers: e.headers ?? {} };
        throw new Error(e?.body?.message ?? e?.message ?? "Network error");
    }
}

/** How long Discord asked us to wait, in milliseconds. */
function retryAfterMs(resp: Resp) {
    const header = parseFloat(resp.headers["retry-after"]);
    if (Number.isFinite(header)) return header * 1000;
    const fromBody = Number(resp.body?.retry_after);
    return Number.isFinite(fromBody) && fromBody > 0 ? fromBody * 1000 : 0;
}

/** A 429 that is not Discord JSON came from Cloudflare, which bans the IP for up to 24h. */
function isEdgeBlock(resp: Resp) {
    if (resp.body?.code === 40333) return true;
    return resp.status === 429 && (resp.body == null || typeof resp.body !== "object");
}

function bodyText(resp: Resp) {
    return typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body ?? "");
}

/** The text of a message as a user thinks of it, including forwards and polls. */
function messageText(message: any) {
    const parts = [message.content || ""];
    if (Array.isArray(message.message_snapshots)) {
        for (const snapshot of message.message_snapshots) {
            if (snapshot?.message?.content) parts.push(snapshot.message.content);
        }
    }
    if (message.poll?.question) parts.push(message.poll.question.text || "");
    return parts.join("\n");
}

function messageHasLink(message: any) {
    if (/(?:https?:\/\/|www\.)\S+/i.test(messageText(message))) return true;
    return Array.isArray(message.embeds) && message.embeds.some((embed: any) => typeof embed?.url === "string" && embed.url);
}

function matchesHistoryFilters(message: any, options: PurgeOptions) {
    if (!/^\d+$/.test(message.id)) return false;
    const id = BigInt(message.id);
    const minId = toSnowflake(options.minId);
    const maxId = toSnowflake(options.maxId);
    if (minId && id <= BigInt(minId)) return false;
    if (maxId && id >= BigInt(maxId)) return false;
    if (options.authorId && String(message.author?.id) !== String(options.authorId)) return false;
    if (options.content && !messageText(message).toLocaleLowerCase().includes(options.content.toLocaleLowerCase())) return false;
    if (options.hasLink && !messageHasLink(message)) return false;
    if (options.hasFile && !(Array.isArray(message.attachments) && message.attachments.length)) return false;
    return true;
}

export function messagePreview(message: any) {
    const text = messageText(message);
    if (text) return text;
    if (message.attachments?.length) return "[ATTACHMENTS]";
    if (message.poll) return "[POLL]";
    if (message.flags & (1 << 14)) return "[FORWARDED]";
    if (message.flags & (1 << 13)) return "[VOICE MESSAGE]";
    if (message.embeds?.length) return "[EMBED]";
    return "";
}

function freshState() {
    return {
        running: false,
        delCount: 0,
        confirmedDelCount: 0, // deletes the API confirmed, i.e. not "already gone"
        failCount: 0,
        grandTotal: 0,
        iterations: 0,
        cursorId: null as string | null, // ID before which the next page is fetched
        emptyPages: 0,
        historyMode: false, // DMs are walked directly because channel search is unreliable
        historyDone: false,
        historyValidated: false,
        historyScanned: 0,
        pageMessages: [] as any[], // every message that advances the cursor, including non-matches
        messagesToDelete: [] as any[],
        skippedMessages: [] as any[],
    };
}

export class PurgeRunner {
    options = {} as PurgeOptions;
    state = freshState();
    stats = {
        startTime: new Date(),
        throttledCount: 0,
        throttledTotalTime: 0,
        etr: 0,
        // Adaptive pacing on top of the configured delays; decays back to zero.
        searchBackoff: 0,
        deleteBackoff: 0,
        searchNextAt: 0,
        deleteNextAt: 0,
    };

    busy = false;
    log: LogLine[] = [];
    batchIndex = 0;
    batchTotal = 0;
    private askForConfirmation = true;
    private nextLogId = 0;
    private listeners = new Set<() => void>();

    /** Supplied by the UI: show the summary and preview, resolve true to proceed. */
    confirm: (summary: string, preview: string) => Promise<boolean> = async () => false;

    subscribe(listener: () => void) {
        this.listeners.add(listener);
        return () => void this.listeners.delete(listener);
    }

    private emit() {
        this.listeners.forEach(l => l());
    }

    print(type: LogType, ...parts: unknown[]) {
        const text = parts.map(p => typeof p === "string" ? p : p instanceof Error ? p.message : JSON.stringify(p)).join(" ");
        this.log = [...this.log.slice(-(MAX_LOG_LINES - 1)), { id: this.nextLogId++, type, text }];
        this.emit();
    }

    clearLog() {
        this.log = [];
        this.emit();
    }

    private resetState() {
        this.state = freshState();
        // Keep the cumulative throttle counters, drop anything that would slow the next run.
        Object.assign(this.stats, { searchBackoff: 0, deleteBackoff: 0, searchNextAt: 0, deleteNextAt: 0, etr: 0 });
    }

    /** Run one or more jobs (channels or servers) with shared options. */
    async start(options: PurgeOptions, jobs: PurgeJob[]) {
        if (this.busy) return this.print("error", "Already running!");
        this.busy = true;
        this.askForConfirmation = true;
        this.batchTotal = jobs.length;
        this.resetState();
        this.state.running = true;
        if (jobs.length > 1) this.print("info", `Running batch with queue of ${jobs.length} jobs`);
        this.emit();

        try {
            for (let i = 0; i < jobs.length; i++) {
                if (!this.state.running) break;
                // Firing every job's first search back to back is a self-inflicted 429.
                if (i > 0) {
                    this.print("verb", `Waiting ${(JOB_DELAY / 1000).toFixed(1)}s before the next job...`);
                    await this.cooldown(JOB_DELAY);
                    if (!this.state.running) break;
                    this.resetState();
                    this.state.running = true;
                }

                this.options = { ...options, ...jobs[i] };
                this.batchIndex = i + 1;
                if (jobs.length > 1) this.print("info", `Starting job ${i + 1}/${jobs.length}...`);

                try {
                    await this.run();
                } catch (err) {
                    this.print("error", `Job ${i + 1} failed:`, errorText(err));
                    // A dead session or an edge block fails identically for every remaining job.
                    if (err instanceof PurgeError && err.fatal) break;
                }
            }
        } finally {
            this.state.running = false;
            this.busy = false;
            this.batchIndex = this.batchTotal = 0;
            if (jobs.length > 1) this.print("info", "Batch finished.");
            this.emit();
        }
    }

    stop() {
        if (!this.state.running) return;
        this.state.running = false;
        this.print("error", "Stopping...");
    }

    private async run() {
        const { options, state, stats } = this;
        stats.startTime = new Date();
        // The walk starts at the user's upper bound and moves backwards in time.
        state.cursorId = toSnowflake(options.maxId) ?? null;
        state.historyMode = options.guildId === "@me";

        this.print("success", `Started at ${stats.startTime.toLocaleString()}`);
        this.print("debug", `authorId="${options.authorId}" guildId="${options.guildId}" channelId="${options.channelId ?? ""}" minId="${options.minId ?? ""}" maxId="${options.maxId ?? ""}"`);

        // A walk that actually removed something sweeps the channel again, because
        // Discord's search index can hide messages that were there all along.
        let deletedBeforePass = 0;
        let sweeps = 0;

        try {
            while (state.running) {
                state.iterations++;
                this.print("verb", "Fetching messages...");
                await this.pace("search");
                if (!state.running) break;

                const data = await this.search();
                if (!state.running || !data) break;

                this.filterResponse(data);
                const found = state.messagesToDelete.length + state.skippedMessages.length;
                if (state.historyMode) {
                    this.print("verb", `Matching so far: ${state.grandTotal} (scanned: ${state.historyScanned}, page: ${state.pageMessages.length}, to delete: ${state.messagesToDelete.length}, skipped: ${state.skippedMessages.length})`);
                    stats.etr = 0;
                } else {
                    this.print("verb", `Grand total: ${state.grandTotal} (page: ${found}, to delete: ${state.messagesToDelete.length}, skipped: ${state.skippedMessages.length})`);
                    this.calcEtr();
                    this.print("verb", `Estimated time remaining: ${msToHMS(stats.etr)}`);
                }
                this.emit();

                const pageSize = state.historyMode ? state.pageMessages.length : found;
                if (pageSize === 0) {
                    // A history walk ends on the first empty page. Search results get
                    // extra checks because Discord's index can briefly hide hits.
                    const remaining = Number(data.total_results) || 0;
                    if (state.historyMode || remaining === 0 || state.emptyPages >= EMPTY_PAGE_RETRIES) {
                        if (!state.historyMode && state.confirmedDelCount > deletedBeforePass && sweeps < MAX_SWEEPS) {
                            sweeps++;
                            this.print("verb", `Reached the end. Sweeping the channel again to catch anything the search index was hiding... (${sweeps}/${MAX_SWEEPS})`);
                            deletedBeforePass = state.confirmedDelCount;
                            state.cursorId = toSnowflake(options.maxId) ?? null;
                            state.emptyPages = 0;
                            continue;
                        }
                        this.print("verb", state.historyMode ? "Reached the beginning of the channel history." : "Ended because the API returned an empty page.");
                        break;
                    }
                    state.emptyPages++;
                    const settle = state.emptyPages * Math.max(options.searchDelay, 2000);
                    this.print("warn", `The page came back empty but the API still reports ${remaining} message(s). Waiting ${(settle / 1000).toFixed(1)}s for the search index to catch up... (${state.emptyPages}/${EMPTY_PAGE_RETRIES})`);
                    await this.cooldown(settle);
                    continue;
                }

                state.emptyPages = 0;

                if (state.messagesToDelete.length > 0) {
                    if (!await this.askConfirmation()) {
                        state.running = false;
                        break;
                    }
                    await this.deleteMessagesFromList();
                } else {
                    this.print("verb", state.historyMode
                        ? "No matching messages on this history page, checking older messages..."
                        : "There's nothing we can delete on this page, checking next page...");
                }

                // Paging by id instead of offset means deletions cannot shift the window.
                this.advanceCursor();
            }
        } finally {
            const end = new Date();
            this.print("success", `Ended at ${end.toLocaleString()}! Total time: ${msToHMS(end.getTime() - stats.startTime.getTime())}`);
            this.printStats();
            this.print("debug", `Deleted ${state.delCount} messages, ${state.failCount} failed.`);
            if (state.failCount > 0) this.print("info", "Run it again to retry the messages that failed.");
            this.emit();
        }
    }

    /** Move the cursor strictly past the oldest message of the current page. */
    private advanceCursor() {
        let oldest: bigint | null = null;
        for (const message of this.state.pageMessages) {
            if (!/^\d+$/.test(message.id)) continue;
            const id = BigInt(message.id);
            if (oldest === null || id < oldest) oldest = id;
        }
        if (oldest === null) return;
        const current = this.state.cursorId ? BigInt(this.state.cursorId) : null;
        if (current !== null && oldest >= current) oldest = current - 1n;
        this.state.cursorId = oldest.toString();
    }

    private calcEtr() {
        const { state, stats, options } = this;
        const remaining = Math.max(0, state.grandTotal - state.delCount - state.failCount);
        const perMessage = options.deleteDelay + stats.deleteBackoff;
        const perPage = options.searchDelay + stats.searchBackoff;
        stats.etr = perPage * Math.ceil(remaining / PAGE_SIZE) + perMessage * remaining;
    }

    private async askConfirmation() {
        if (!this.askForConfirmation) return true;
        this.print("verb", "Waiting for your confirmation...");
        const preview = this.state.messagesToDelete.map(m => `${displayName(m.author)}: ${messagePreview(m)}`).join("\n");
        const batchNotice = this.batchTotal > 1
            ? `\n\nThis is job ${this.batchIndex} of ${this.batchTotal}. The remaining jobs will continue without another confirmation.`
            : "";
        const summary = this.state.historyMode
            ? `Scan this entire chat history and delete every matching message? ${this.state.grandTotal} matching message(s) found so far; the final total is unknown until older history is scanned.`
            : `Delete ~${this.state.grandTotal} messages? (Estimated time: ${msToHMS(this.stats.etr)}) The actual number may be lower if filters skip some messages.`;

        if (!await this.confirm(summary + batchNotice, preview)) {
            this.print("error", "Aborted by you!");
            return false;
        }
        this.print("verb", "OK");
        this.askForConfirmation = false;
        return true;
    }

    /** Shared handling for the GET requests: edge blocks, 429s, network errors. */
    private async fetchWithRetry(url: string, what: string): Promise<Resp | null> {
        for (let attempt = 1; attempt <= MAX_SEARCH_ATTEMPTS; attempt++) {
            if (!this.state.running) return null;

            let resp: Resp;
            try {
                resp = await rest("get", url);
            } catch (err) {
                this.print("warn", `${what} failed:`, errorText(err));
                this.penalize("search", MAX_SEARCH_DELAY);
                await this.cooldown(this.effectiveDelay("search"));
                continue;
            }

            if (isEdgeBlock(resp)) throw this.edgeBlocked();

            // Search index not built yet.
            if (resp.status === 202) {
                const w = clamp(retryAfterMs(resp) || 5000, 1000, MAX_SEARCH_DELAY);
                this.stats.throttledCount++;
                this.stats.throttledTotalTime += w;
                this.print("warn", `This channel isn't indexed yet. Waiting ${(w / 1000).toFixed(1)}s for Discord to index it...`);
                await this.cooldown(w);
                continue;
            }

            if (resp.status === 429) {
                this.penalize("search", MAX_SEARCH_DELAY);
                const asked = retryAfterMs(resp);
                const w = (asked > 0 ? asked : clamp(this.effectiveDelay("search"), 1000, MAX_SEARCH_DELAY)) + RETRY_MARGIN;
                this.stats.throttledCount++;
                this.stats.throttledTotalTime += w;
                this.print("warn", `Being rate limited by the API for ${w}ms! Slowing down...`);
                await this.cooldown(w);
                continue;
            }

            if (!resp.ok) {
                const code = resp.body?.code;
                if (resp.status === 401) throw new PurgeError("Discord rejected the session (401). Log in again and retry.", true);
                // The channel is gone, or was never ours to read. End this job quietly.
                if (resp.status === 403 || resp.status === 404 || code === 50001 || code === 50024) {
                    this.print("warn", `Skipping this channel, the API responded with status ${resp.status}:`, bodyText(resp));
                    return null;
                }
                throw new PurgeError(`${what} failed, API responded with status ${resp.status}! ${bodyText(resp)}`);
            }

            this.updatePace("search", resp);
            this.relax("search");
            return resp;
        }
        throw new PurgeError(`Giving up on ${what.toLowerCase()} after ${MAX_SEARCH_ATTEMPTS} attempts.`);
    }

    /** Ensure an @me target is a DM or group DM before walking its history. */
    private async validatePrivateChannel() {
        const resp = await this.fetchWithRetry(`/channels/${this.options.channelId}`, "Channel lookup");
        if (!resp) return false;
        if (resp.body?.type !== 1 && resp.body?.type !== 3) {
            this.print("warn", "Skipping this entry because it is not a DM or group DM.");
            return false;
        }
        this.state.historyValidated = true;
        return true;
    }

    private async history() {
        const { state, options } = this;
        if (state.historyDone) return { history: true, total_results: 0, messages: [] };
        if (!state.historyValidated) {
            if (!await this.validatePrivateChannel()) return null;
            await this.pace("search");
        }

        const query = queryString([["limit", HISTORY_PAGE_SIZE], ["before", state.cursorId ?? undefined]]);
        const resp = await this.fetchWithRetry(`/channels/${options.channelId}/messages?${query}`, "History request");
        if (!resp) return null;
        if (!Array.isArray(resp.body)) throw new PurgeError("Discord returned an invalid channel history response. Stopping instead of guessing what to delete.");

        const rawMessages: any[] = resp.body;
        state.historyScanned += rawMessages.length;
        let messages = rawMessages;
        const minId = toSnowflake(options.minId);
        if (minId) {
            const boundary = BigInt(minId);
            messages = rawMessages.filter(m => /^\d+$/.test(m.id) && BigInt(m.id) > boundary);
            if (messages.length !== rawMessages.length) state.historyDone = true;
        }
        return { history: true, total_results: 0, messages };
    }

    private async search(): Promise<any> {
        if (this.state.historyMode) return this.history();
        const { options } = this;
        const query = queryString([
            ["limit", PAGE_SIZE],
            ["author_id", options.authorId || undefined],
            ["channel_id", options.channelId || undefined],
            ["min_id", toSnowflake(options.minId)],
            ["max_id", this.state.cursorId ?? undefined],
            ["sort_by", "timestamp"],
            ["sort_order", "desc"],
            ["has", options.hasLink ? "link" : undefined],
            ["has", options.hasFile ? "file" : undefined],
            ["content", options.content || undefined],
            ["include_nsfw", options.includeNsfw ? true : undefined],
        ]);
        const resp = await this.fetchWithRetry(`/guilds/${options.guildId}/messages/search?${query}`, "Search request");
        return resp ? resp.body ?? {} : null;
    }

    private filterResponse(data: any) {
        const { state, options } = this;
        const historyPage = data.history === true;
        if (!historyPage) {
            // The search total decreases as we delete stuff.
            const total = Number(data.total_results) || 0;
            if (total > state.grandTotal) state.grandTotal = total;
        }

        // Search hits may be wrapped in conversation arrays; history rows are not.
        const groups: any[] = Array.isArray(data.messages) ? data.messages : [];
        const discovered = groups
            .map(group => Array.isArray(group) ? group.find(m => m.hit === true) ?? (group.length === 1 ? group[0] : null) : group)
            .filter(m => m?.id);
        state.pageMessages = discovered;

        // Guild search applies these filters remotely; DM history does not.
        let candidates = discovered;
        if (historyPage) {
            candidates = candidates.filter(m => matchesHistoryFilters(m, options));
            state.grandTotal += candidates.length;
        }

        let toDelete = candidates
            .filter(m => !UNDELETABLE_MESSAGE_TYPES.has(m.type))
            .filter(m => m.pinned ? options.includePinned : true);

        if (options.pattern) {
            try {
                const regex = new RegExp(options.pattern, "i");
                toDelete = toDelete.filter(m => regex.test(messageText(m)));
            } catch (e) {
                this.print("warn", "Ignoring RegExp because pattern is malformed!", errorText(e));
            }
        }

        state.messagesToDelete = toDelete;
        state.skippedMessages = candidates.filter(m => !toDelete.includes(m));
    }

    private async deleteMessagesFromList() {
        const { state } = this;
        for (const message of state.messagesToDelete) {
            if (!state.running) return this.print("error", "Stopped by you!");

            this.print("debug", `[${state.delCount + 1}/${state.grandTotal}] ${new Date(message.timestamp).toLocaleString()} ${displayName(message.author)}: ${messagePreview(message).replace(/\n/g, "↵")} {ID:${message.id}}`);

            // Rate limits and thread recovery are not the message's fault, so
            // they get a larger budget than an actual request failure.
            let result: Outcome = "FAILED";
            let failures = 0;
            let transientRetries = 0;
            for (; ;) {
                await this.pace("delete");
                if (!state.running) return this.print("error", "Stopped by you!");
                result = await this.deleteMessage(message);
                if (result === "RETRY") {
                    if (++transientRetries >= MAX_TRANSIENT_RETRIES) break;
                } else if (result === "FAILED") {
                    if (++failures >= MAX_ATTEMPT) break;
                    this.print("verb", `Retrying... (${failures}/${MAX_ATTEMPT})`);
                } else break;
            }

            if (result === "DELETED" || result === "ALREADY_GONE") {
                state.delCount++;
                if (result === "DELETED") state.confirmedDelCount++;
            } else {
                // The cursor moves past it either way, so an undeletable message is not re-found forever.
                state.failCount++;
            }

            this.calcEtr();
            this.emit();
        }
    }

    private async deleteMessage(message: any): Promise<Outcome> {
        let resp: Resp;
        try {
            resp = await rest("del", `/channels/${message.channel_id}/messages/${message.id}`);
        } catch (err) {
            this.print("error", "Delete request threw an error:", errorText(err));
            this.stats.deleteNextAt = Date.now() + this.effectiveDelay("delete");
            return "FAILED";
        }

        if (isEdgeBlock(resp)) throw this.edgeBlocked();

        if (resp.ok) {
            this.updatePace("delete", resp);
            this.relax("delete");
            return "DELETED";
        }

        const code = resp.body?.code;
        if (resp.status === 429) return this.deferDeleteForRateLimit(resp);

        if (resp.status === 404 && code === 10008) {
            this.print("verb", "That message was already gone.");
            this.updatePace("delete", resp);
            return "ALREADY_GONE";
        }

        if (resp.status === 401) throw new PurgeError("Discord rejected the session (401). Log in again and retry.", true);

        // A 403 carrying "Unknown Message" means Discord's anti-abuse systems blocked the request.
        if (resp.status === 403 && code === 10008)
            throw new PurgeError("Discord blocked this request. Stopping — wait a while before trying again.", true);

        this.updatePace("delete", resp);

        if (code === 50083) {
            this.print("warn", "This message is in an archived thread. Reopening the thread...");
            return this.unarchiveThread(message.channel_id);
        }

        const reason = PERMANENT_DELETE_ERRORS[code];
        if (reason || resp.status === 403) {
            this.print("warn", `Skipping a message because ${reason || "the API refused it"}. {ID:${message.id}}`);
            return "SKIPPED";
        }

        this.print("error", `Error deleting message, API responded with status ${resp.status}!`, bodyText(resp));
        return "FAILED";
    }

    private async unarchiveThread(channelId: string): Promise<Outcome> {
        await this.pace("delete");
        if (!this.state.running) return "RETRY";

        let resp: Resp;
        try {
            resp = await rest("patch", `/channels/${channelId}`, { archived: false });
        } catch (err) {
            this.print("error", "Unarchive request threw an error:", errorText(err));
            this.stats.deleteNextAt = Date.now() + this.effectiveDelay("delete");
            return "FAILED";
        }

        if (isEdgeBlock(resp)) throw this.edgeBlocked();
        if (resp.status === 429) return this.deferDeleteForRateLimit(resp);
        if (resp.status === 401) throw new PurgeError("Discord rejected the session (401). Log in again and retry.", true);

        this.updatePace("delete", resp);
        if (resp.ok) {
            this.relax("delete");
            this.print("success", "Reopened the archived thread. Retrying the deletion...");
            return "RETRY";
        }

        const code = resp.body?.code;
        if (resp.status === 403 || resp.status === 404 || code === 50001 || code === 50013 || code === 160005) {
            this.print("warn", `Could not reopen the archived thread because ${code === 160005 ? "it is locked" : "you do not have permission to reopen it"}. Skipping this message.`);
            return "SKIPPED";
        }

        this.print("error", `Error reopening the archived thread, API responded with status ${resp.status}!`, bodyText(resp));
        return "FAILED";
    }

    private deferDeleteForRateLimit(resp: Resp): Outcome {
        this.penalize("delete", MAX_DELETE_DELAY);
        const asked = retryAfterMs(resp);
        const w = (asked > 0 ? asked : clamp(this.effectiveDelay("delete"), 500, MAX_DELETE_DELAY)) + RETRY_MARGIN;
        this.stats.throttledCount++;
        this.stats.throttledTotalTime += w;
        this.print("warn", `Being rate limited by the API for ${w}ms! Slowing down deletions...`);
        this.stats.deleteNextAt = Date.now() + w;
        return "RETRY";
    }

    private edgeBlocked() {
        return new PurgeError("Blocked by Cloudflare — too many requests reached Discord's edge. Stop for a while (this can last up to 24h) and use larger delays next time.", true);
    }

    private effectiveDelay(kind: "search" | "delete") {
        const configured = kind === "search" ? this.options.searchDelay : this.options.deleteDelay;
        const ceiling = kind === "search" ? MAX_SEARCH_DELAY : MAX_DELETE_DELAY;
        const backoff = kind === "search" ? this.stats.searchBackoff : this.stats.deleteBackoff;
        return clamp((Number(configured) || 0) + backoff, 0, ceiling);
    }

    private async pace(kind: "search" | "delete") {
        const due = kind === "search" ? this.stats.searchNextAt : this.stats.deleteNextAt;
        await this.cooldown(due - Date.now());
    }

    /** Sleep in slices so Stop takes effect during long cooldowns. */
    private async cooldown(ms: number) {
        const until = Date.now() + ms;
        for (; ;) {
            const left = until - Date.now();
            if (left <= 0 || !this.state.running) return;
            await wait(Math.min(left, 1000));
        }
    }

    /** Schedule the earliest time the next request of this kind may go out. */
    private updatePace(kind: "search" | "delete", resp: Resp) {
        let delay = this.effectiveDelay(kind);
        const remaining = resp.headers["x-ratelimit-remaining"];
        const resetAfter = resp.headers["x-ratelimit-reset-after"];
        if (remaining != null && resetAfter != null && Number(remaining) === 0) {
            const refillMs = Number(resetAfter) * 1000;
            if (Number.isFinite(refillMs)) delay = Math.max(delay, refillMs + RETRY_MARGIN);
        }
        const next = Date.now() + delay;
        if (kind === "search") this.stats.searchNextAt = next;
        else this.stats.deleteNextAt = next;
    }

    private penalize(kind: "search" | "delete", ceiling: number) {
        const key = kind === "search" ? "searchBackoff" : "deleteBackoff";
        this.stats[key] = clamp(this.stats[key] * 2 + 500, 0, ceiling);
    }

    private relax(kind: "search" | "delete") {
        const key = kind === "search" ? "searchBackoff" : "deleteBackoff";
        this.stats[key] = Math.max(0, this.stats[key] * 0.8 - 50);
    }

    private printStats() {
        this.print("verb", `Delete delay: ${this.effectiveDelay("delete") | 0}ms, Search delay: ${this.effectiveDelay("search") | 0}ms`);
        this.print("verb", `Rate Limited: ${this.stats.throttledCount} times. Total time throttled: ${msToHMS(this.stats.throttledTotalTime)}.`);
    }
}

/**
 * Convert the target fields into concrete jobs. A channel ID is only meaningful
 * inside one guild, so cross-guild channel lists are rejected.
 */
export function buildPurgePlan(guildInput: string, channelInput: string): PurgeJob[] {
    const parse = (v: string) => [...new Set(v.split(/[\s,]+/).filter(Boolean))];
    const guildIds = parse(guildInput);
    const channelIds = parse(channelInput);

    if (!guildIds.length) throw new Error('You must fill the "Server ID" field!');
    const badGuilds = guildIds.filter(id => id !== "@me" && !isSnowflake(id));
    if (badGuilds.length) throw new Error(`These are not valid Server IDs: ${badGuilds.join(", ")}`);
    const badChannels = channelIds.filter(id => !isSnowflake(id));
    if (badChannels.length) throw new Error(`These are not valid Channel IDs: ${badChannels.join(", ")}`);
    if (guildIds.includes("@me") && guildIds.length > 1) throw new Error('"@me" cannot be combined with Server IDs. Use it by itself for direct messages.');
    if (guildIds.length > 1 && channelIds.length) throw new Error('When purging multiple servers, leave the "Channel ID" field empty.');
    if (guildIds[0] === "@me" && !channelIds.length) throw new Error('You must fill the "Channel ID" field to delete direct messages!');

    if (guildIds.length > 1) return guildIds.map(guildId => ({ guildId }));
    if (channelIds.length) return channelIds.map(channelId => ({ guildId: guildIds[0], channelId }));
    return [{ guildId: guildIds[0] }];
}
