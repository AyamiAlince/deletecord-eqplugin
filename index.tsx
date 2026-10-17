/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { ChannelToolbarButton } from "@api/HeaderBar";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Flex } from "@components/Flex";
import { FormSwitch } from "@components/FormSwitch";
import { HeadingTertiary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { classNameFactory } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import { Message, RenderModalProps } from "@vencord/discord-types";
import { ChannelStore, ConfirmModal, GuildStore, Menu, Modal, openModal, React, SelectedChannelStore, SelectedGuildStore, TextInput, useEffect, useReducer, useRef, UserStore, useState } from "@webpack/common";

import { buildPurgePlan, isSnowflake, msToHMS, PurgeRunner, toSnowflake } from "./core";

const cl = classNameFactory("vc-purgecord-");

export const settings = definePluginSettings({
    searchDelay: {
        type: OptionType.SLIDER,
        description: "Delay between message searches (ms). Higher values are slower but less likely to be rate limited.",
        markers: [1000, 2000, 5000, 10000, 30000, 60000],
        default: 2000,
        stickToMarkers: false
    },
    deleteDelay: {
        type: OptionType.SLIDER,
        description: "Delay between deletions (ms). Very low values can get your IP temporarily blocked by Cloudflare.",
        markers: [250, 500, 1000, 2000, 5000, 10000],
        default: 1000,
        stickToMarkers: false
    }
});

interface Draft {
    authorId: string;
    guildIds: string;
    channelIds: string;
    after: string;
    before: string;
    content: string;
    pattern: string;
    hasLink: boolean;
    hasFile: boolean;
    includePinned: boolean;
    includeNsfw: boolean;
}

const runner = new PurgeRunner();

// Survives closing the modal so a half-filled form or a running purge isn't lost.
let draft: Draft = {
    authorId: "", guildIds: "", channelIds: "", after: "", before: "",
    content: "", pattern: "", hasLink: false, hasFile: false, includePinned: false, includeNsfw: false
};

const currentGuildId = () => SelectedGuildStore.getGuildId() ?? "@me";
const currentChannelId = () => SelectedChannelStore.getChannelId() ?? "";
const myId = () => UserStore.getCurrentUser()?.id ?? "";

runner.confirm = (summary, preview) => new Promise<boolean>(resolve => {
    openModal(props => (
        <ConfirmModal
            {...props}
            title="Delete messages?"
            subtitle={summary}
            confirmText="Delete"
            variant="critical-primary"
            onConfirm={() => resolve(true)}
            onCancel={() => resolve(false)}
        >
            <pre className={cl("preview")}>{preview}</pre>
        </ConfirmModal>
    ), { onCloseCallback: () => resolve(false) });
});

function useRunner() {
    const [, rerender] = useReducer((x: number) => x + 1, 0);
    useEffect(() => runner.subscribe(rerender), []);
    return runner;
}

function startPurge() {
    const d = draft;
    const authorId = d.authorId.trim();
    let jobs;
    try {
        jobs = buildPurgePlan(d.guildIds, d.channelIds);
    } catch (err) {
        return runner.print("error", (err as Error).message);
    }

    if (authorId && !isSnowflake(authorId)) return runner.print("error", '"Author ID" must be a Discord id.');
    if (jobs.length > 1 && !d.channelIds.trim() && !authorId)
        return runner.print("error", '"Author ID" is required when purging multiple servers. Click "Me" to use your own account.');
    if (jobs[0].guildId === "@me" && !authorId)
        return runner.print("error", '"Author ID" is required for DMs and group DMs. Click "Me" to use your own account.');
    for (const [label, value] of [["After", d.after], ["Before", d.before]]) {
        if (value.trim() && !toSnowflake(value)) return runner.print("error", `"${label}" must be a message id or a date.`);
    }

    runner.clearLog();
    void runner.start({
        authorId,
        guildId: jobs[0].guildId,
        minId: d.after.trim() || undefined,
        maxId: d.before.trim() || undefined,
        content: d.content.trim() || undefined,
        pattern: d.pattern || undefined,
        hasLink: d.hasLink,
        hasFile: d.hasFile,
        includeNsfw: d.includeNsfw,
        includePinned: d.includePinned,
        searchDelay: Math.round(settings.store.searchDelay),
        deleteDelay: Math.round(settings.store.deleteDelay)
    }, jobs).catch(err => runner.print("error", "Unexpected error:", err));
}

function Field({ label, children }: { label: string; children: React.ReactNode; }) {
    return (
        <section className={cl("field")}>
            <HeadingTertiary>{label}</HeadingTertiary>
            <Flex gap={8} alignItems="center">{children}</Flex>
        </section>
    );
}

function Progress() {
    const { state, stats, busy } = useRunner();
    if (!busy) return null;
    const value = state.delCount + state.failCount;
    const max = Math.max(state.grandTotal, value);
    const throttled = stats.deleteBackoff > 0 ? ` (throttled +${stats.deleteBackoff | 0}ms)` : "";
    const text = state.historyMode
        ? `Scanning history: ${state.historyScanned} checked, ${value} processed${throttled}`
        : `${max ? Math.round(value / max * 100) : 0}% (${value}/${max}) Elapsed: ${msToHMS(Date.now() - stats.startTime.getTime())} Remaining: ${msToHMS(stats.etr)}${throttled}`;
    return (
        <div className={cl("progress")}>
            <div className={cl("bar")} style={{ width: state.historyMode || !max ? "100%" : `${value / max * 100}%` }} data-indeterminate={state.historyMode || !max} />
            <Paragraph>{text}</Paragraph>
        </div>
    );
}

function Log() {
    const { log } = useRunner();
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        ref.current?.scrollTo({ top: ref.current.scrollHeight });
    }, [log]);
    return (
        <div ref={ref} className={cl("log")}>
            {log.length === 0 && <div className={cl("log-verb")}>Fill in the target and press Start. Nothing is deleted before you confirm.</div>}
            {log.map(line => <div key={line.id} className={cl(`log-${line.type}`)}>{line.text}</div>)}
        </div>
    );
}

function PurgeModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const { busy } = useRunner();
    const [form, setForm] = useState(draft);
    const fileRef = useRef<HTMLInputElement>(null);

    const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setForm(f => (draft = { ...f, [key]: value }));
    const text = (key: keyof Draft, placeholder: string) => (
        <TextInput value={form[key] as string} placeholder={placeholder} onChange={(v: string) => set(key, v)} disabled={busy} />
    );
    const toggle = (key: keyof Draft, title: string, description?: string) => (
        <FormSwitch title={title} description={description} value={form[key] as boolean} onChange={v => set(key, v)} disabled={busy} hideBorder />
    );

    const importArchive = async (file?: File) => {
        if (!file) return;
        try {
            // messages/index.json from the Discord data package maps channel IDs to names.
            const channelIds = Object.keys(JSON.parse(await file.text())).filter(isSnowflake);
            setForm(f => (draft = { ...f, guildIds: "@me", channelIds: channelIds.join(","), authorId: f.authorId || myId() }));
            runner.print("info", `Loaded ${channelIds.length} channels. Non-DM entries are skipped automatically.`);
        } catch (err) {
            runner.print("error", "Error parsing file!", err);
        }
    };

    return (
        <Modal
            {...modalProps}
            size="lg"
            title="Purgecord"
            subtitle="Bulk-delete messages in a channel, DM or server."
            actions={[
                { text: "Close", variant: "secondary", onClick: modalProps.onClose },
                busy
                    ? { text: "Stop", variant: "critical-primary", onClick: () => runner.stop() }
                    : { text: "Start", variant: "critical-primary", onClick: startPurge }
            ]}
        >
            <div className={cl("body")}>
                <div className={cl("form")}>
                    <Field label="Author ID">
                        {text("authorId", "Whose messages (empty = everyone's)")}
                        <Button size="small" variant="secondary" disabled={busy} onClick={() => set("authorId", myId())}>Me</Button>
                    </Field>
                    <Field label="Server ID (@me for DMs)">
                        {text("guildIds", "One or more, comma separated")}
                        <Button size="small" variant="secondary" disabled={busy} onClick={() => {
                            set("guildIds", currentGuildId());
                            if (currentGuildId() === "@me") set("channelIds", currentChannelId());
                        }}>Current</Button>
                        <Button size="small" variant="secondary" disabled={busy} onClick={() => {
                            set("guildIds", Object.keys(GuildStore.getGuilds()).join(","));
                            set("channelIds", "");
                            if (!draft.authorId) set("authorId", myId());
                        }}>All</Button>
                    </Field>
                    <Field label="Channel ID (empty = whole server)">
                        {text("channelIds", "One or more, comma separated")}
                        <Button size="small" variant="secondary" disabled={busy} onClick={() => {
                            set("guildIds", currentGuildId());
                            set("channelIds", currentChannelId());
                        }}>Current</Button>
                    </Field>
                    <Field label="Data package">
                        <Button size="small" variant="secondary" disabled={busy} onClick={() => fileRef.current?.click()}>Import messages/index.json</Button>
                        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={e => {
                            void importArchive(e.currentTarget.files?.[0]);
                            e.currentTarget.value = "";
                        }} />
                    </Field>

                    <Field label="After (message ID or date)">{text("after", "e.g. 2024-01-31 or a message id")}</Field>
                    <Field label="Before (message ID or date)">{text("before", "e.g. 2025-06-01 or a message id")}</Field>
                    <Field label="Contains text">{text("content", "Search term")}</Field>
                    <Field label="Regex pattern">{text("pattern", "Case-insensitive, applied client side")}</Field>

                    {toggle("hasLink", "Only messages with links")}
                    {toggle("hasFile", "Only messages with files")}
                    {toggle("includePinned", "Include pinned messages")}
                    {toggle("includeNsfw", "Include NSFW channels", "Required to search age-restricted channels.")}
                </div>
                <div className={cl("output")}>
                    <Progress />
                    <Log />
                    <Flex justifyContent="flex-end">
                        <Button size="small" variant="secondary" onClick={() => runner.clearLog()}>Clear log</Button>
                    </Flex>
                </div>
            </div>
        </Modal>
    );
}

function openPurgeModal() {
    openModal(props => <PurgeModal modalProps={props} />);
}

function TrashIcon({ width = 24, height = 24, className }: { width?: number; height?: number; className?: string; }) {
    return (
        <svg className={className} width={width} height={height} viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M15 3.999V2H9V3.999H3V5.999H21V3.999H15Z" />
            <path fill="currentColor" d="M5 6.99902V18.999C5 20.101 5.897 20.999 7 20.999H17C18.103 20.999 19 20.101 19 18.999V6.99902H5ZM11 17H9V11H11V17ZM15 17H13V11H15V17Z" />
        </svg>
    );
}

function ToolbarButton() {
    const { busy } = useRunner();
    return (
        <ChannelToolbarButton
            icon={TrashIcon}
            tooltip={busy ? "Purgecord (running)" : "Purgecord"}
            className={busy ? cl("running") : undefined}
            selected={busy}
            onClick={openPurgeModal}
        />
    );
}

const messageContextMenuPatch: NavContextMenuPatchCallback = (children, { message }: { message?: Message; }) => {
    if (!message) return;
    const pick = (key: "after" | "before") => () => {
        const guildId = ChannelStore.getChannel(message.channel_id)?.guild_id || "@me";
        draft = { ...draft, guildIds: guildId, channelIds: message.channel_id, [key]: message.id, authorId: draft.authorId || myId() };
        openPurgeModal();
    };
    children.push(
        <Menu.MenuItem id="vc-purgecord" label="Purgecord">
            <Menu.MenuItem id="vc-purgecord-after" label="Delete messages after this one" action={pick("after")} />
            <Menu.MenuItem id="vc-purgecord-before" label="Delete messages before this one" action={pick("before")} />
        </Menu.MenuItem>
    );
};

export default definePlugin({
    name: "Purgecord",
    description: "Bulk-delete your messages in a channel, DM, server or across servers. Port of Purgecord/Undiscord.",
    authors: [{ name: "AyamiAlince", id: 863738240753074196n }],
    dependencies: ["HeaderBarAPI"],
    settings,
    headerBarButton: {
        icon: TrashIcon,
        location: "channeltoolbar",
        render: () => <ToolbarButton />
    },
    contextMenus: {
        "message": messageContextMenuPatch
    },
    stop() {
        runner.stop();
    }
});
