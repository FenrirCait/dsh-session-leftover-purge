window.__ModuleLoader__.load({
	id: "dsh-session-leftover-purge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const { jsx, jsxs } = require("react/jsx-runtime");
		const React = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		/** Settings namespace = the bundle entry id in cordis.patch.yml. */
		const NS = "session-leftover-purge";

		/** Mirrors schema.ts defaults; "restore defaults" writes from this table. */
		const DEFAULTS = {
			enabled: true,
			biliJson: true,
			biliIndexDb: true,
			costMeterLedger: false,
			costMeterFiles: false,
			costMeterReportBackups: true,
			dshContextCache: false,
			archiveProjcache: false,
			dryRun: false,
			trashRetentionDays: 7,
			trashMaxMb: 2048,
			reconcileOnBoot: true,
			sweepGhostKvOnBoot: true,
			autoPurgeOrphans: false,
			bootDelayMs: 8000,
			vacuumIndexDb: false,
			restoreBackupTrigger: 0,
			deleteBackupsTrigger: 0,
			backupLedgerTrigger: 0,
		};

		const BOOLS = [
			{ key: "enabled", labelKey: "enabled.label", hintKey: "enabled.hint" },
			{ key: "biliJson", labelKey: "biliJson.label", hintKey: "biliJson.hint" },
			{ key: "biliIndexDb", labelKey: "biliIndexDb.label", hintKey: "biliIndexDb.hint" },
			{ key: "costMeterLedger", labelKey: "costMeterLedger.label", hintKey: "costMeterLedger.hint" },
			{ key: "costMeterFiles", labelKey: "costMeterFiles.label", hintKey: "costMeterFiles.hint" },
			{ key: "costMeterReportBackups", labelKey: "costMeterReportBackups.label", hintKey: "costMeterReportBackups.hint" },
			{ key: "dshContextCache", labelKey: "dshContextCache.label", hintKey: "dshContextCache.hint" },
			{ key: "archiveProjcache", labelKey: "archiveProjcache.label", hintKey: "archiveProjcache.hint" },
			{ key: "sweepGhostKvOnBoot", labelKey: "sweepGhostKvOnBoot.label", hintKey: "sweepGhostKvOnBoot.hint" },
			{ key: "vacuumIndexDb", labelKey: "vacuumIndexDb.label", hintKey: "vacuumIndexDb.hint" },
			{ key: "dryRun", labelKey: "dryRun.label", hintKey: "dryRun.hint" },
			{ key: "reconcileOnBoot", labelKey: "reconcileOnBoot.label", hintKey: "reconcileOnBoot.hint" },
			{ key: "autoPurgeOrphans", labelKey: "autoPurgeOrphans.label", hintKey: "autoPurgeOrphans.hint" },
		];

		const NUMBERS = [
			{ key: "trashRetentionDays", labelKey: "trashRetentionDays.label", hintKey: "trashRetentionDays.hint", min: 0 },
			{ key: "trashMaxMb", labelKey: "trashMaxMb.label", hintKey: "trashMaxMb.hint", min: 0 },
			{ key: "bootDelayMs", labelKey: "bootDelayMs.label", hintKey: "bootDelayMs.hint", min: 0 },
			{ key: "restoreBackupTrigger", labelKey: "restoreBackupTrigger.label", hintKey: "restoreBackupTrigger.hint", min: 0 },
			{ key: "deleteBackupsTrigger", labelKey: "deleteBackupsTrigger.label", hintKey: "deleteBackupsTrigger.hint", min: 0 },
			{ key: "backupLedgerTrigger", labelKey: "backupLedgerTrigger.label", hintKey: "backupLedgerTrigger.hint", min: 0 },
		];

		const ALL_KEYS = [...BOOLS.map((f) => f.key), ...NUMBERS.map((f) => f.key)];
		/** Restore defaults only touches switches and sizes — never the triggers. */
		const RESETTABLE = [...BOOLS.map((f) => f.key), "trashRetentionDays", "trashMaxMb", "bootDelayMs"];

		const ZH = {
			"meta.title": "会话残留清理",
			"enabled.label": "总开关",
			"enabled.hint": "关掉后不再清理，也不再监听删除",
			"biliJson.label": "清理 bili JSON 快照",
			"biliJson.hint": "移动面板里该会话族的快照文件",
			"biliIndexDb.label": "清理 bili 索引",
			"biliIndexDb.hint": "行、内容引用计数与三个 kv blob；写前 VACUUM INTO 备份",
			"costMeterLedger.label": "清理 cost-meter 账本明细",
			"costMeterLedger.hint": "只删明细行，总额不动",
			"costMeterFiles.label": "清理 cost-meter 明细文件",
			"costMeterFiles.hint": "删掉每轮用量凭证（先复制进备份）",
			"costMeterReportBackups.label": "报告 cost-meter 改价备份",
			"costMeterReportBackups.hint": "只在开机报告里列出占用，从不删除",
			"dshContextCache.label": "清理 dsh-context 缓存",
			"dshContextCache.hint": "清概览缓存分片里的会话条目（默认只报告）",
			"archiveProjcache.label": "清理 archive-manager 缓存",
			"archiveProjcache.hint": "清 projcache 里带会话 id 的文件（默认只报告）",
			"sweepGhostKvOnBoot.label": "开机清理残留绑定",
			"sweepGhostKvOnBoot.hint": "删掉 kv 里指向已删会话的条目，抢在 bili lane 启动前",
			"vacuumIndexDb.label": "开机回收 index.db 空间",
			"vacuumIndexDb.hint": "回收已删行占用的空间，失败不影响数据",
			"dryRun.label": "演练模式",
			"dryRun.hint": "只报告，不移动也不删除（开机清扫同样遵守）",
			"reconcileOnBoot.label": "开机对账",
			"reconcileOnBoot.hint": "启动时扫描孤儿快照族并写报告",
			"autoPurgeOrphans.label": "自动清理孤儿",
			"autoPurgeOrphans.hint": "对账发现孤儿就直接清理",
			"trashRetentionDays.label": "备份保留天数",
			"trashRetentionDays.hint": "过期即删，0 = 永久",
			"trashMaxMb.label": "备份体积上限（MB）",
			"trashMaxMb.hint": "超出后从最旧批次开始删，0 = 不限",
			"bootDelayMs.label": "开机延迟（毫秒）",
			"bootDelayMs.hint": "开机对账前等待时长",
			"restoreBackupTrigger.label": "恢复最近备份",
			"restoreBackupTrigger.hint": "填入新数字并保存 = 执行一次",
			"deleteBackupsTrigger.label": "删除全部备份",
			"deleteBackupsTrigger.hint": "填入新数字并保存 = 执行一次",
			"backupLedgerTrigger.label": "立即备份 cost-meter 账本",
			"backupLedgerTrigger.hint": "填入新数字并保存 = 执行一次",
			"action.save": "保存",
			"action.saving": "保存中…",
			"action.reset": "恢复默认",
			"state.dirty": "{n} 项未保存",
			"state.saved": "已保存 {n} 项",
			"state.saveFailed": "保存失败：{message}",
			"state.refused": "「{key}」被本部署拒绝",
			"note.triggers": "「恢复默认」只回填开关与大小，不动三个触发器——把它们清零会真的触发一次恢复或删除。触发器字段填一个新数字并保存就执行一次；插件会记住上次执行的值。",
		};

		const EN = {
			"meta.title": "Session leftovers",
			"enabled.label": "Master switch",
			"enabled.hint": "Off: no cleanup, no delete subscription",
			"biliJson.label": "bili JSON snapshots",
			"biliJson.hint": "Move the family's snapshot files out of bili's panel",
			"biliIndexDb.label": "bili index",
			"biliIndexDb.hint": "Rows, content refcounts and the three kv blobs; VACUUM INTO backup first",
			"costMeterLedger.label": "cost-meter ledger rows",
			"costMeterLedger.hint": "Detail rows only; daily totals stay untouched",
			"costMeterFiles.label": "cost-meter detail files",
			"costMeterFiles.hint": "Per-turn receipts (copied into the backup first)",
			"costMeterReportBackups.label": "Report cost-meter reprice backups",
			"costMeterReportBackups.hint": "Listed in the boot report, never deleted",
			"dshContextCache.label": "dsh-context cache",
			"dshContextCache.hint": "Drop family entries from overview-cache shards (report only by default)",
			"archiveProjcache.label": "archive-manager projcache",
			"archiveProjcache.hint": "Session-keyed projcache files (report only by default)",
			"sweepGhostKvOnBoot.label": "Sweep stale bindings on boot",
			"sweepGhostKvOnBoot.hint": "Drops kv entries for deleted sessions before bili's lane starts",
			"vacuumIndexDb.label": "Reclaim index.db space",
			"vacuumIndexDb.hint": "VACUUMs deleted pages away on boot; failures keep data intact",
			"dryRun.label": "Dry run",
			"dryRun.hint": "Report only — the boot sweep obeys it too",
			"reconcileOnBoot.label": "Reconcile on boot",
			"reconcileOnBoot.hint": "Scans for orphan snapshot families and writes a report",
			"autoPurgeOrphans.label": "Auto purge orphans",
			"autoPurgeOrphans.hint": "Clean orphans found during reconcile instead of only reporting",
			"trashRetentionDays.label": "Backup retention (days)",
			"trashRetentionDays.hint": "Expired batches are removed; 0 = keep forever",
			"trashMaxMb.label": "Backup size cap (MB)",
			"trashMaxMb.hint": "Oldest batches go first above the cap; 0 = no cap",
			"bootDelayMs.label": "Boot delay (ms)",
			"bootDelayMs.hint": "How long to wait before reconciling",
			"restoreBackupTrigger.label": "Restore latest backup",
			"restoreBackupTrigger.hint": "Write a new number and save to run once",
			"deleteBackupsTrigger.label": "Delete all backups",
			"deleteBackupsTrigger.hint": "Write a new number and save to run once",
			"backupLedgerTrigger.label": "Back up the cost-meter ledger now",
			"backupLedgerTrigger.hint": "Write a new number and save to run once",
			"action.save": "Save",
			"action.saving": "Saving…",
			"action.reset": "Restore defaults",
			"state.dirty": "{n} unsaved",
			"state.saved": "Saved {n}",
			"state.saveFailed": "Save failed: {message}",
			"state.refused": "\"{key}\" was refused by this deployment",
			"note.triggers": "\"Restore defaults\" only touches switches and sizes, never the three triggers — zeroing a trigger really runs a restore or a delete. Writing a new number into a trigger field runs it once; the plugin remembers the last value it acted on.",
		};

		/** Replaced by ctx.locale.bind(NS) in apply(); keeps keys readable before then. */
		let t = (key) => ZH[key] ?? key;
		const fmt = (template, params) =>
			String(template).replace(/\{(\w+)\}/g, (whole, name) => (params && params[name] !== undefined ? String(params[name]) : whole));

		const labelStyle = { fontSize: 14, lineHeight: 1.5 };
		const hintStyle = { fontSize: 12, opacity: 0.62, marginTop: 2, lineHeight: 1.6 };
		const rowStyle = {
			display: "flex",
			alignItems: "center",
			gap: 16,
			padding: "10px 0",
			borderBottom: "1px solid rgba(128,128,128,.18)",
		};
		const inputStyle = {
			width: 140,
			padding: "6px 10px",
			fontSize: 14,
			borderRadius: 8,
			border: "1px solid rgba(128,128,128,.35)",
			background: "transparent",
			color: "inherit",
			outline: "none",
		};
		const buttonStyle = {
			padding: "7px 18px",
			fontSize: 13,
			borderRadius: 8,
			border: "1px solid rgba(128,128,128,.4)",
			background: "transparent",
			color: "inherit",
			cursor: "pointer",
		};
		const primaryStyle = {
			...buttonStyle,
			background: "#4d6bfe",
			borderColor: "#4d6bfe",
			color: "#fff",
		};

		/** One boolean row: label on the left, switch on the right. */
		function BoolRow(props) {
			const { label, hint, checked, onToggle } = props;
			return jsxs("div", {
				style: rowStyle,
				children: [
					jsxs("div", {
						style: { flex: 1, minWidth: 0 },
						children: [
							jsx("div", { style: labelStyle, children: label }),
							hint ? jsx("div", { style: hintStyle, children: hint }) : null,
						],
					}),
					jsx(primitives.Switch, { checked, label, onChange: onToggle }),
				],
			});
		}

		/** One number row: right-aligned input, commits on Enter or blur. */
		function NumberRow(props) {
			const { label, hint, value, min, onCommit } = props;
			const [text, setText] = React.useState(value === undefined || value === null ? "" : String(value));
			React.useEffect(() => {
				setText(value === undefined || value === null ? "" : String(value));
			}, [value]);
			const commit = () => {
				const trimmed = text.trim();
				if (trimmed === "") {
					onCommit(undefined);
					return;
				}
				const n = Number(trimmed);
				if (!Number.isFinite(n) || n < (min ?? 0)) {
					setText(value === undefined || value === null ? "" : String(value));
					return;
				}
				if (n !== value) onCommit(n);
			};
			return jsxs("div", {
				style: rowStyle,
				children: [
					jsxs("div", {
						style: { flex: 1, minWidth: 0 },
						children: [
							jsx("div", { style: labelStyle, children: label }),
							hint ? jsx("div", { style: hintStyle, children: hint }) : null,
						],
					}),
					jsx("input", {
						type: "number",
						min: min ?? 0,
						value: text,
						style: inputStyle,
						onChange: (event) => setText(event.target.value),
						onBlur: commit,
						onKeyDown: (event) => {
							if (event.key === "Enter") event.currentTarget.blur();
						},
					}),
				],
			});
		}

		/** Settings card inside the plugin manager: draft + Save / Restore defaults. */
		function LeftoverPurgeCard(props) {
			const scope = props.scope;
			const [snapshot, setSnapshot] = React.useState(() => scope.getSnapshot());
			const [draft, setDraft] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [message, setMessage] = React.useState("");
			const [messageIsError, setMessageIsError] = React.useState(false);
			React.useEffect(() => {
				if (typeof scope.subscribe !== "function") return undefined;
				return scope.subscribe(() => setSnapshot(scope.getSnapshot()));
			}, [scope]);

			const saved = (snapshot && snapshot.value) || {};
			const current = draft === null ? saved : draft;
			const changed = draft === null ? [] : ALL_KEYS.filter((key) => draft[key] !== saved[key]);
			const dirty = changed.length > 0;

			const note = (text, isError) => {
				setMessage(text);
				setMessageIsError(isError === true);
			};
			const edit = (key, value) => {
				note("", false);
				setDraft(Object.assign({}, current, { [key]: value }));
			};
			const resetToDefaults = () => {
				note("", false);
				const next = Object.assign({}, current);
				for (const key of RESETTABLE) next[key] = DEFAULTS[key];
				setDraft(next);
			};
			const save = async () => {
				if (!dirty || busy) return;
				setBusy(true);
				note("", false);
				try {
					for (const key of changed) {
						const ok = await scope.set(key, draft[key]);
						if (ok === false) throw new Error(fmt(t("state.refused"), { key }));
					}
					setDraft(null);
					note(fmt(t("state.saved"), { n: changed.length }), false);
				} catch (error) {
					note(fmt(t("state.saveFailed"), { message: String(error && error.message ? error.message : error) }), true);
				} finally {
					setBusy(false);
				}
			};

			return jsxs("div", {
				style: { padding: "4px 0 8px" },
				children: [
					...BOOLS.map((field) =>
						jsx(
							BoolRow,
							{
								label: t(field.labelKey),
								hint: t(field.hintKey),
								checked: current[field.key] === true,
								onToggle: (next) => edit(field.key, next),
							},
							field.key,
						),
					),
					...NUMBERS.map((field) =>
						jsx(
							NumberRow,
							{
								label: t(field.labelKey),
								hint: t(field.hintKey),
								min: field.min,
								value: current[field.key],
								onCommit: (next) => edit(field.key, next),
							},
							field.key,
						),
					),
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: 10, marginTop: 16, flexWrap: "wrap" },
						children: [
							jsx("button", {
								type: "button",
								onClick: save,
								disabled: !dirty || busy,
								style: !dirty || busy ? Object.assign({}, primaryStyle, { opacity: 0.45, cursor: "not-allowed" }) : primaryStyle,
								children: busy ? t("action.saving") : t("action.save"),
							}),
							jsx("button", {
								type: "button",
								onClick: resetToDefaults,
								disabled: busy,
								style: buttonStyle,
								children: t("action.reset"),
							}),
							dirty
								? jsx("span", { style: { fontSize: 12, opacity: 0.65 }, children: fmt(t("state.dirty"), { n: changed.length }) })
								: null,
							message
								? jsx("span", {
										style: { fontSize: 12, color: messageIsError ? "#d9534f" : "#3aa657" },
										children: message,
									})
								: null,
						],
					}),
					jsx("p", {
						style: { fontSize: 12, opacity: 0.55, marginTop: 12, lineHeight: 1.6 },
						children: t("note.triggers"),
					}),
				],
			});
		}

		const inject = ["slots", "locale", "configForms"];

		function apply(ctx) {
			try {
				ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), "session-leftover-purge: card dictionaries");
				t = typeof ctx.locale.bind === "function" ? ctx.locale.bind(NS) : (key) => ZH[key] ?? key;
			} catch (error) {
				// A host without the locale service still gets the Chinese card.
				console.warn("[dsh-session-leftover-purge] locale unavailable:", error);
			}
			const scope = ctx.configForms.get(NS);
			ctx.effect(
				() =>
					ctx.configForms.whileServed([NS], () =>
						ctx.slots.inject("plugins.bundle.config", () =>
							ctx.slots.register(
								{
									name: "plugins.bundle.config",
									key: "dsh-session-leftover-purge",
									inject: () => ({ scope }),
								},
								LeftoverPurgeCard,
							),
						),
					),
				"session-leftover-purge: page",
			);
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
