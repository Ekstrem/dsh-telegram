window.__ModuleLoader__.load({
	id: "dsh-telegram",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region lib/i18n.js
		/**
		* Channel copy in Vietnamese and English.
		*
		* DSH's own locale registry only ships `zh` and `en` — `LOCALE_IDS = ['zh',
		* 'en']`, and its schema is a union over exactly those two, so a `vi`
		* preference is rejected outright. Following the host locale would therefore
		* have meant hiding Vietnamese behind the Chinese option, which is a trick
		* rather than a translation.
		*
		* So this channel carries its own `language` setting. It governs both faces at
		* once — the messages the bot sends and the labels on the settings card —
		* because a bot answering in Vietnamese from a card labelled in English is one
		* product speaking two languages at the user.
		*
		* Every string lives here rather than at its use site so a missing translation
		* is visible as a missing key instead of surfacing as untranslated text in
		* production.
		*/
		/** Supported language tags, in menu order. */
		const LANGUAGES = ["vi", "en"];
		const DICTIONARY = {
			vi: {
				denied: "⛔️ Bạn không có quyền dùng bot này.",
				deniedClaimed: (id) => `⛔️ Bot này đã có chủ. Nhờ chủ bot thêm id của bạn: <code>${id}</code>`,
				claimFailed: (id) => `⚠️ Không lưu được quyền sở hữu. Hãy thêm id của bạn trong Settings: <code>${id}</code>`,
				claimed: (id) => [
					"✅ <b>Bạn là chủ bot này.</b>",
					"",
					`Từ giờ chỉ id <code>${id}</code> dùng được bot. Muốn cho thêm người thì vào Settings → Plugins → Telegram.`,
					"",
					"Gõ /help để xem các lệnh."
				].join("\n"),
				welcome: "Chào bạn! Gửi tin nhắn để trò chuyện với agent, hoặc gõ /help để xem các lệnh.",
				stopped: "kênh Telegram đã dừng",
				cardTitle: "Telegram",
				cardDescription: "Kênh Telegram: gửi ảnh, bảng thật, câu hỏi có nút bấm, đổi model trong chat.",
				unsaved: "chưa lưu",
				tokenLabel: "Bot token",
				tokenConfigured: "đã cấu hình",
				tokenMissing: "chưa có",
				tokenUnknown: "không rõ",
				tokenPlaceholderSet: "Đã lưu — nhập để thay",
				tokenPlaceholderEmpty: "Dán token từ @BotFather",
				tokenHint: (ref) => `Token nằm trong kho credential ${ref}, không nằm trong file cấu hình. Để trống nghĩa là giữ token đang có.`,
				languageLabel: "Ngôn ngữ",
				languageHint: "Áp dụng cho tin nhắn bot và thẻ cấu hình này.",
				enabledLabel: "Bật kênh Telegram",
				routeQuestionsLabel: "Hỏi ngay trong Telegram",
				routeQuestionsHint: "Câu hỏi phát sinh từ phiên Telegram sẽ hiện nút bấm trong chat. Tắt thì chúng hiện ở Web.",
				allowedLabel: "User được phép dùng bot",
				allowedHint: "Telegram user id, cách nhau bởi dấu phẩy. Để trống nghĩa là bot chưa có chủ — người gõ /start đầu tiên sẽ thành chủ.",
				workspaceLabel: "Thư mục làm việc",
				workspaceHint: "Nơi agent chạy lệnh và đọc ghi file.",
				restartNotice: "Token, thư mục làm việc và công tắc bật/tắt chỉ có hiệu lực sau khi khởi động lại DSH.",
				reset: "Đặt lại",
				save: "Lưu",
				saving: "Đang lưu…",
				saved: "Đã lưu",
				discard: "Huỷ",
				saveFailed: "Lưu không thành công — kiểm tra lại giá trị"
			},
			en: {
				denied: "⛔️ You are not allowed to use this bot.",
				deniedClaimed: (id) => `⛔️ This bot already has an owner. Ask them to add your id: <code>${id}</code>`,
				claimFailed: (id) => `⚠️ Could not record ownership. Please add your id in Settings: <code>${id}</code>`,
				claimed: (id) => [
					"✅ <b>You now own this bot.</b>",
					"",
					`Only id <code>${id}</code> can use it from now on. To let others in, go to Settings → Plugins → Telegram.`,
					"",
					"Send /help to see the commands."
				].join("\n"),
				welcome: "Hello! Send a message to talk to the agent, or /help to list the commands.",
				stopped: "the Telegram channel stopped",
				cardTitle: "Telegram",
				cardDescription: "Telegram channel: images, real tables, questions with buttons, model switching in chat.",
				unsaved: "unsaved",
				tokenLabel: "Bot token",
				tokenConfigured: "configured",
				tokenMissing: "not set",
				tokenUnknown: "unknown",
				tokenPlaceholderSet: "Stored — type to replace",
				tokenPlaceholderEmpty: "Paste the token from @BotFather",
				tokenHint: (ref) => `The token lives in credential ${ref}, never in a config file. Leave this blank to keep the stored one.`,
				languageLabel: "Language",
				languageHint: "Applies to both bot messages and this card.",
				enabledLabel: "Enable the Telegram channel",
				routeQuestionsLabel: "Ask inside Telegram",
				routeQuestionsHint: "Questions raised by a Telegram session get buttons in the chat. Turn this off to answer them in the Web UI.",
				allowedLabel: "Users allowed to use the bot",
				allowedHint: "Telegram user ids, comma separated. Empty means the bot is unclaimed — the first person to send /start becomes its owner.",
				workspaceLabel: "Working directory",
				workspaceHint: "Where the agent runs commands and reads or writes files.",
				restartNotice: "The token, working directory and on/off switch only take effect after DSH restarts.",
				reset: "Reset",
				save: "Save",
				saving: "Saving…",
				saved: "Saved",
				discard: "Discard",
				saveFailed: "Save failed — check the values"
			}
		};
		/** Human-readable names for the language picker, in their own language. */
		const LANGUAGE_NAMES = {
			vi: "Tiếng Việt",
			en: "English"
		};
		/**
		* Build a translator for one language.
		*
		* An unknown key returns the key itself rather than empty text: a visible
		* `tokenLabel` in the UI names the missing entry, while a blank label would
		* look like a rendering bug and hide which string was never written.
		*
		* @param {string} [language] one of {@link LANGUAGES}
		* @returns {(key: string, ...args: unknown[]) => string}
		*/
		function translator(language) {
			const table = DICTIONARY[language] ?? DICTIONARY["vi"];
			return (key, ...args) => {
				const entry = table[key] ?? DICTIONARY["vi"][key];
				if (entry === void 0) return key;
				return typeof entry === "function" ? entry(...args) : entry;
			};
		}
		//#endregion
		//#region src/client/styles.ts
		/**
		* Card styling.
		*
		* The bundle-purity rule forbids importing the settings section's own card
		* chrome as a value, so a plugin shipping a card owns its appearance. That is
		* a real constraint, not an invitation to invent a look: a card that does not
		* match the ones beside it reads as broken, and the first version of this card
		* did — flat text where every neighbour had a bordered, collapsible shell.
		*
		* So these rules mirror the built-in `PluginCard` structurally and use only
		* `--dsw-alias-*` design tokens, never literal colours. Tokens are what make
		* the card follow the light/dark/system switch in General settings; a
		* hard-coded `#1a1a1a` would look right in dark mode and be unreadable in
		* light.
		*
		* Class names carry a `dshtg_` prefix in place of the build-time CSS-module
		* hash, so they cannot collide with another plugin's card.
		*/
		const CSS = `
.dshtg_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.dshtg_card:hover{border-color:var(--dsw-alias-label-dimmed)}
.dshtg_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.dshtg_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.dshtg_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dshtg_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dshtg_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.dshtg_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.dshtg_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.dshtg_chevronOpen{transform:rotate(180deg)}
.dshtg_pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:12px}
.dshtg_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.dshtg_field{flex-direction:column;gap:6px;padding:14px 0;display:flex;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dshtg_field:last-of-type{border-bottom:0}
.dshtg_labelRow{align-items:center;gap:8px;display:flex}
.dshtg_label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;flex:1}
.dshtg_badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;align-items:center;gap:4px;padding:1px 8px;font-size:12px;display:inline-flex}
.dshtg_badgeOk{background:0 0;color:var(--dsw-alias-state-success-primary);padding:0;gap:0}
.dshtg_badgeIcon{flex:none}
.dshtg_select{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 8px;font-size:13px;cursor:pointer}
.dshtg_reset{appearance:none;font:inherit;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;padding:0;font-size:12px;text-decoration:underline}
.dshtg_reset:hover{color:var(--dsw-alias-label-primary)}
.dshtg_input{width:100%;box-sizing:border-box;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 10px;font-size:13px}
.dshtg_input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.dshtg_input:disabled{opacity:.6;cursor:not-allowed}
.dshtg_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.dshtg_toggle{align-items:center;gap:8px;cursor:pointer;display:flex;font-size:13px;color:var(--dsw-alias-label-primary)}
.dshtg_warning{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform);border-radius:8px;margin:12px 0 0;padding:8px 10px;font-size:12px;line-height:1.5}
.dshtg_footer{justify-content:flex-end;align-items:center;gap:10px;padding:12px 0 4px;display:flex}
.dshtg_status{margin-right:auto;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshtg_error{margin-right:auto;font-size:12px;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-secondary))}
.dshtg_btn{appearance:none;font:inherit;cursor:pointer;border-radius:8px;padding:6px 14px;font-size:13px;border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-primary)}
.dshtg_btn:disabled{opacity:.5;cursor:not-allowed}
.dshtg_btnPrimary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1);border-color:transparent}
.dshtg_code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
`;
		/**
		* Inject the stylesheet once per page.
		*
		* Module bodies run at materialization, and a plugin can be loaded again after
		* a retract, so this guards on a marker attribute rather than a module-level
		* boolean — a second copy of the rules would be harmless but the duplicate
		* `<style>` tags accumulate across reloads.
		*/
		function ensureStyles() {
			if (typeof document === "undefined") return;
			const marker = "dsh-telegram-card";
			if (document.querySelector(`style[data-plugin-css="${marker}"]`)) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-telegram";
			tag.dataset.pluginCss = marker;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		const styles = {
			card: "dshtg_card",
			cardOpen: "dshtg_cardOpen",
			header: "dshtg_header",
			headText: "dshtg_headText",
			name: "dshtg_name",
			description: "dshtg_description",
			chevron: "dshtg_chevron",
			chevronOpen: "dshtg_chevronOpen",
			pending: "dshtg_pending",
			body: "dshtg_body",
			field: "dshtg_field",
			labelRow: "dshtg_labelRow",
			label: "dshtg_label",
			badge: "dshtg_badge",
			badgeOk: "dshtg_badgeOk",
			badgeIcon: "dshtg_badgeIcon",
			select: "dshtg_select",
			reset: "dshtg_reset",
			input: "dshtg_input",
			hint: "dshtg_hint",
			toggle: "dshtg_toggle",
			warning: "dshtg_warning",
			footer: "dshtg_footer",
			status: "dshtg_status",
			error: "dshtg_error",
			btn: "dshtg_btn",
			btnPrimary: "dshtg_btnPrimary",
			code: "dshtg_code"
		};
		//#endregion
		//#region src/client/index.tsx
		/**
		* Telegram channel settings card.
		*
		* The Plugins settings tab dispatches one slot key per settings namespace the
		* Host serves. This package registers the Host namespace (`lib/settings.js`)
		* and the card below under the same key, and the tab pairs the two without
		* knowing what either means — which is what lets a plugin distributed outside
		* the DSH repository appear on the page at all.
		*
		* Three rules the surrounding machinery imposes, each visible in the code:
		*
		* 1. **A secret never rides the wire.** `describe` strips `role('secret')`
		*    fields, so the bot token cannot be read back and is not part of the
		*    settings section. It is written through the credentials domain instead,
		*    and the card can only ever report *whether* one is configured.
		* 2. **Writes are fenced by revision.** Every descriptor carries the raw
		*    section's revision; a write echoing a stale one is refused rather than
		*    silently overwriting whoever saved first. The card therefore re-reads
		*    after saving and reports a save that did not land.
		* 3. **The Host is the authority on validity.** Its validators own constraints
		*    no schema expresses, so a rejected save keeps the user's drafts for
		*    correction instead of dropping them.
		*/
		/** The namespace this card edits. Must match `SETTINGS_NAMESPACE` on the Host. */
		const NS = "telegram";
		/** Fields that only take effect after DSH restarts, so the card can say so. */
		const RESTART_FIELDS = /* @__PURE__ */ new Set([
			"tokenRef",
			"workspaceRoot",
			"enabled",
			"routeQuestions"
		]);
		/**
		* Read this namespace's descriptor.
		*
		* Returns `undefined` rather than throwing: the page must keep working when
		* the Host is momentarily unreachable, and a card that vanishes is a clearer
		* signal than one showing stale values as if they were live.
		*/
		async function readDescriptor(api) {
			try {
				const response = await api.settings.describe({ namespaces: [NS] });
				if (!response?.result?.ok) return void 0;
				return response.result.value.namespaces.find((view) => view.ns === NS);
			} catch {
				return;
			}
		}
		function TelegramCard(props) {
			const { api } = props;
			const [open, setOpen] = react.useState(false);
			const [descriptor, setDescriptor] = react.useState();
			const [draft, setDraft] = react.useState({});
			const [token, setToken] = react.useState("");
			const [tokenConfigured, setTokenConfigured] = react.useState();
			const [status, setStatus] = react.useState("idle");
			const tokenRef = String(draft.tokenRef ?? descriptor?.value?.tokenRef ?? "TELEGRAM_BOT_TOKEN");
			const language = String(draft.language ?? descriptor?.value?.language ?? "vi");
			const t = translator(language);
			/** Load the section, and whether a token is stored for the reference it names. */
			const reload = react.useCallback(async () => {
				const next = await readDescriptor(api);
				if (next) setDescriptor(next);
				const ref = String(next?.value?.tokenRef ?? "TELEGRAM_BOT_TOKEN");
				try {
					const response = await api.credentials.describe({ refs: [ref] });
					if (response?.result?.ok) setTokenConfigured(Boolean(response.result.value.credentials?.[ref]?.configured));
				} catch {
					setTokenConfigured(void 0);
				}
			}, [api]);
			react.useEffect(() => {
				reload();
			}, [reload]);
			const value = (key, fallback) => draft[key] ?? descriptor?.value?.[key] ?? fallback;
			/** `allowedUsers` is stored as an array but edited as one comma-separated line. */
			const textValue = (key) => {
				const raw = draft[key] ?? descriptor?.value?.[key];
				if (Array.isArray(raw)) return raw.join(", ");
				return raw === void 0 || raw === null ? "" : String(raw);
			};
			const edit = (key, next) => {
				setDraft((prev) => ({
					...prev,
					[key]: next
				}));
				setStatus("idle");
			};
			const dirty = Object.keys(draft).length > 0 || token.length > 0;
			const needsRestart = Object.keys(draft).some((key) => RESTART_FIELDS.has(key));
			const save = async () => {
				setStatus("saving");
				if (token) try {
					await api.credentials.set({
						ref: tokenRef,
						value: token
					});
					setToken("");
				} catch {
					setStatus("failed");
					return;
				}
				const section = normalizeSection(draft);
				if (Object.keys(section).length > 0) try {
					if (!(await api.settings.update({
						ns: NS,
						section,
						expectedRevision: descriptor?.revision
					}))?.result?.ok) {
						setStatus("failed");
						await reload();
						return;
					}
				} catch {
					setStatus("failed");
					return;
				}
				setDraft({});
				await reload();
				setStatus("saved");
			};
			const discard = () => {
				setDraft({});
				setToken("");
				setStatus("idle");
			};
			const overridden = (key) => descriptor?.user?.[key] !== void 0;
			const resetField = async (key) => {
				try {
					await api.settings.mutate({
						ns: NS,
						ops: [{
							op: "unset",
							path: key
						}],
						expectedRevision: descriptor?.revision
					});
				} catch {
					setStatus("failed");
					return;
				}
				setDraft((prev) => {
					const next = { ...prev };
					delete next[key];
					return next;
				});
				await reload();
			};
			const field = (key, label, hint) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: styles.field,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: styles.labelRow,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							className: styles.label,
							htmlFor: `telegram-${key}`,
							children: label
						}), overridden(key) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: styles.reset,
							onClick: () => void resetField(key),
							children: t("reset")
						}) : null]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id: `telegram-${key}`,
						className: styles.input,
						value: textValue(key),
						onChange: (event) => edit(key, event.target.value)
					}),
					hint ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: styles.hint,
						children: hint
					}) : null
				]
			}, key);
			const toggle = (key, label, hint) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: styles.field,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
					className: styles.toggle,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						type: "checkbox",
						checked: Boolean(value(key, true)),
						onChange: (event) => edit(key, event.target.checked)
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label })]
				}), hint ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: styles.hint,
					children: hint
				}) : null]
			}, key);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: open ? `${styles.card} ${styles.cardOpen}` : styles.card,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: styles.header,
					"aria-expanded": open,
					onClick: () => setOpen(!open),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: styles.headText,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: styles.name,
								children: t("cardTitle")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: styles.description,
								children: t("cardDescription")
							})]
						}),
						dirty ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: styles.pending,
							children: t("unsaved")
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, { className: open ? `${styles.chevron} ${styles.chevronOpen}` : styles.chevron })
					]
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: styles.body,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: styles.field,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: styles.labelRow,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										className: styles.label,
										htmlFor: "telegram-token",
										children: t("tokenLabel")
									}), tokenConfigured ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: `${styles.badge} ${styles.badgeOk}`,
										title: t("tokenConfigured"),
										"aria-label": t("tokenConfigured"),
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutline14, { className: styles.badgeIcon })
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: styles.badge,
										children: tokenConfigured === void 0 ? t("tokenUnknown") : t("tokenMissing")
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									id: "telegram-token",
									className: styles.input,
									type: "password",
									autoComplete: "off",
									placeholder: tokenConfigured ? t("tokenPlaceholderSet") : t("tokenPlaceholderEmpty"),
									value: token,
									onChange: (event) => {
										setToken(event.target.value);
										setStatus("idle");
									}
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: styles.hint,
									children: t("tokenHint", tokenRef)
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: styles.field,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: styles.labelRow,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										className: styles.label,
										htmlFor: "telegram-language",
										children: t("languageLabel")
									}), overridden("language") ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: styles.reset,
										onClick: () => void resetField("language"),
										children: t("reset")
									}) : null]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
									id: "telegram-language",
									className: styles.select,
									value: language,
									onChange: (event) => edit("language", event.target.value),
									children: LANGUAGES.map((code) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: code,
										children: LANGUAGE_NAMES[code]
									}, code))
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: styles.hint,
									children: t("languageHint")
								})
							]
						}),
						toggle("enabled", t("enabledLabel")),
						toggle("routeQuestions", t("routeQuestionsLabel"), t("routeQuestionsHint")),
						field("allowedUsers", t("allowedLabel"), t("allowedHint")),
						field("workspaceRoot", t("workspaceLabel"), t("workspaceHint")),
						needsRestart ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: styles.warning,
							children: t("restartNotice")
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: styles.footer,
							children: [
								status === "saved" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: styles.status,
									children: t("saved")
								}) : null,
								status === "failed" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: styles.error,
									children: t("saveFailed")
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: styles.btn,
									disabled: !dirty || status === "saving",
									onClick: discard,
									children: t("discard")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: `${styles.btn} ${styles.btnPrimary}`,
									disabled: !dirty || status === "saving",
									onClick: () => void save(),
									children: status === "saving" ? t("saving") : t("save")
								})
							]
						})
					]
				}) : null]
			});
		}
		/**
		* `allowedUsers` is an array on the Host but a comma-separated line in the UI,
		* because a list of numeric ids is faster to edit as text than as rows. The
		* conversion lives at the boundary so the rest of the card handles one shape.
		*/
		function normalizeSection(section) {
			const out = { ...section };
			if (typeof out.allowedUsers === "string") out.allowedUsers = out.allowedUsers.split(",").map((entry) => entry.trim()).filter(Boolean);
			return out;
		}
		const inject = ["slots", "connection"];
		function apply(ctx) {
			const { api } = ctx.get("connection");
			ensureStyles();
			ctx.slots.inject("settings.plugin.item", function* () {
				yield ctx.slots.register({
					name: "settings.plugin.item",
					key: NS,
					inject: () => ({ api })
				}, TelegramCard);
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.normalizeSection = normalizeSection;
		return module.exports;
	}
});
