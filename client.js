/**
 * dsh-session-cost-daily — browser half.
 *
 * Hand-written `__ModuleLoader__` bundle (no build step): registers into the
 * conversation `composer.dock` list slot (the status strip at the BOTTOM of
 * the conversation) and appends the cost segments INTO the built-in
 * stats bar (the only display mode since 0.1.5; the standalone bar was
 * removed):
 *   - 本次：the ESTIMATED cost of the current session, computed server-side per
 *     model from the session event log and priced in CNY against ./cost.js;
 *   - 今日：the same estimate summed over every session of today, including
 *     ones already closed (本地新增 2026-09-27).
 *
 * Since DSH 0.1.5 that bar is `StatsPills` — a centered flex row of icon pills
 * tagged `data-composer-stats`, which replaced the single ellipsised
 * `StatsLine` text row — and it renders nothing at all until the session has a
 * step or token activity. The merge therefore attaches to a bar that appears
 * LATE and must match its pill styling (see `startStatsRowObserver`).
 *
 * Data comes from the server half's loopback-only endpoint via same-origin
 * fetch. The summary refreshes whenever the client-side `tokenUsage` projection
 * changes (debounced) and every 30 s while mounted. Clicking the segment opens
 * the per-model breakdown (model · in/out tokens · cost) for 本次 and 今日,
 * plus a ⟳ button and the last-updated time.
 *
 * 本地改动（2026-09-27）：余额与低余额阈值整套已移除（本机走中转网关，那份
 * 数据永远拿不到），只保留「读会话 + 算钱」。
 */
window.__ModuleLoader__.load({
	id: "dsh-session-cost-daily",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		// NOTE: `@deepseek-ai/dsh-client-ui-primitives` is deliberately NOT
		// required here. DSH 0.1.5 stopped shipping it as a standalone host
		// module, and a top-level `require()` of a module the loader cannot
		// resolve throws inside this factory — which aborts the WHOLE client
		// half (no dock entry, no merge node, no panel) rather than
		// degrading one icon. Every glyph this bundle draws is hand-written
		// inline SVG below, so the bundle stays free of optional host modules.

		//#region css
		const css = [
			// Stats-bar merge (appended into the built-in stats bar).
			//
			// DSH 0.1.5 replaced the single ellipsised text row (StatsLine) with
			// the centered pill bar (StatsPills): `[data-composer-stats]` is a
			// `display:flex; justify-content:center; gap:12px` container whose
			// children are the time/usage pill anchors. The merge node is
			// appended as one more flex item, so it must NOT carry a left
			// margin (the container's gap owns the spacing) and must opt out of
			// the pill label's ellipsis clamp.
			//
			// The trigger copies the shipped `.pill` recipe (13/20 secondary
			// tier, `1px 8px` padding, 24px radius, hover + `aria-expanded`
			// background), and the panel copies `stat-dialog.module.css` (fixed
			// placement, 12px radius, `--dsw-specific-menu`, 12/18 text, the
			// `minmax(76px,auto)` dt/dd grid) — the bar's own two pills open
			// exactly that panel, so the three read as one family.
			".sco_updated{color:var(--dsw-alias-state-success-primary);font-size:10px;line-height:14px;margin-right:2px}",
			"@keyframes sco_spin{to{transform:rotate(360deg)}}",
			".sco_anchor{display:none}",
			// Standalone fallback host. While DSH renders no bar at all (a
			// brand-new session, or the second a COLD session takes to load)
			// `StatsPills` is null, and the merge node is hosted by the dock
			// anchor itself instead of vanishing with the bar. The metrics are
			// copied from the shipped `.bOPqQW_root` so the pill does not move
			// or resize when the real bar appears and takes it over.
			".sco_anchor[data-solo=true]{box-sizing:border-box;width:100%;max-width:var(--dsh-chat-content-width);margin:0 auto;padding:4px calc(var(--dsh-composer-side-clearance,0px) + 16px) 0;justify-content:center;gap:12px;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:flex}",
			".sco_merge{display:inline-flex;align-items:center;max-width:none;flex:none;vertical-align:baseline;white-space:nowrap}",
			".sco_mergeBtn{cursor:pointer;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:24px;align-items:center;gap:6px;box-sizing:border-box;max-width:100%;padding:1px 8px;display:inline-flex;font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap}",
			".sco_mergeBtn svg{width:14px;height:14px;flex:none}",
			".sco_mergeBtn:hover,.sco_mergeBtn[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".sco_mergeLabel{min-width:0;display:inline-flex;align-items:center;gap:5px}",
			".sco_mergeSep{color:var(--dsw-alias-separator-primary);margin:0 6px;display:inline-block}",
			".sco_mergeToday{display:inline-flex;align-items:center}",
			// 本地新增（2026-09-27）：窄窗口下优先牺牲内置的「轮次 / 步数」读数——
			// 状态栏里唯一与钱无关、且随时能再看的一组数字。DSH 若调整状态栏
			// 子元素顺序，这条选择器要跟着改（它按「第一个非费用节点」定位）。
			"@media (max-width:960px){[data-composer-stats]>*:not([data-session-cost-merge]):first-child{display:none}}",
			// Same 13/20 secondary tier as the shipped readings: the values are
			// NOT bolded (the built-in pills are regular weight) and only the
			// digits are tabular, so the numbers stay column-aligned without
			// stretching the CJK labels around them.
			".sco_mergeVal{color:var(--dsw-alias-label-secondary)}",
			".sco_mergeAmount{font-variant-numeric:tabular-nums}",
			".sco_mergeVal[data-warn=true]{color:var(--dsw-alias-state-error-primary)}",
			// 本地新增（2026-09-28）：峰谷小圆点。高峰橙、空闲绿——硬编码色值而不是
			// 主题令牌：用户要的就是这两种颜色一眼可辨，而主题里的 warn/success
			// 令牌随皮肤变（warn 可能偏黄）。7px 与 14px 的费用图标同一行，
			// 垂直居中由 pill 自己的 align-items 管。
			".sco_peakDot{border-radius:50%;flex:none;width:7px;height:7px;display:inline-block}",
			".sco_peakDot[data-state=peak]{background:#f59e0b}",
			".sco_peakDot[data-state=offpeak]{background:#22c55e}",
			// Click-open details panel (mirrors the built-in stat dialog).
			".sco_mergePanel{position:fixed;z-index:1100;box-sizing:border-box;background:var(--dsw-specific-menu);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;border-radius:12px;padding:16px;font-size:12px;line-height:18px;text-align:left;white-space:normal;font-weight:400}",
			".sco_mergePanelTitle{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex}",
			".sco_mergePanelTitleLabel{align-items:center;gap:6px;min-width:0;display:inline-flex}",
			".sco_mergePanelTitleLabel svg{flex:none;width:14px;height:14px}",
			".sco_mergePanelTitleValue{font-variant-numeric:tabular-nums}",
			".sco_mergePanelRule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}",
			".sco_mergePanelDetails{color:var(--dsw-alias-label-tertiary);grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}",
			".sco_mergePanelDetails dt,.sco_mergePanelDetails dd{min-width:0;margin:0;font-weight:400}",
			".sco_mergePanelDetails dt{overflow-wrap:anywhere}",
			".sco_mergePanelDetails dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}",
			".sco_mergePanelDetails dd[data-warn=true]{color:var(--dsw-alias-state-error-primary)}",
			".sco_mergePanelFoot{border-top:.5px solid var(--dsw-alias-border-l2);margin-top:10px;padding-top:8px;align-items:center;gap:8px;display:flex}",
			".sco_mergeRefresh{cursor:pointer;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:24px;flex:none;justify-content:center;align-items:center;width:20px;height:20px;padding:0;margin-left:auto;display:inline-flex}",
			".sco_mergeRefresh:hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}",
			".sco_mergeRefresh:disabled{opacity:.45;cursor:default}",
			".sco_mergeRefresh[data-spin=true] svg{animation:sco_spin 0.8s linear infinite}",
			".sco_mergePanelNote{color:var(--dsw-alias-label-caption);margin:8px 0 0;font-size:11px;line-height:16px}",
			// The panel's one setting, on a line of its own UNDER the 更新于/⟳
			// row: label on the left, the field pushed to the same right edge the
			// reading values use, at the panel's 12/18 tier with DSH's own input
			// recipe (bg-base on a border-l2 stroke, rounded 6). The native
			// spinners are hidden — at 68px they would overlap the number — while
			// the field stays a number input, so ↑/↓ still steps it.
		].join("");
		const tagId = "dsh-session-cost-daily/SessionCost.module.css";
		if (typeof document !== "undefined") {
			// The tag is reused across module rebuilds, so its CONTENT is
			// reconciled, not just its presence: an HMR-reloaded bundle would
			// otherwise keep serving the previous version's stylesheet until the
			// page was reloaded (and a new rule would silently not exist).
			let tag = document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]");
			if (tag === null) {
				tag = document.createElement("style");
				tag.dataset.plugin = "dsh-session-cost-daily";
				tag.dataset.pluginCss = tagId;
				document.head.appendChild(tag);
			}
			if (tag.textContent !== css) tag.textContent = css;
		}
		const S = {
			updated: "sco_updated",
			anchor: "sco_anchor",
			merge: "sco_merge",
			mergeSep: "sco_mergeSep",
			mergeToday: "sco_mergeToday",
			mergeVal: "sco_mergeVal",
			mergeAmount: "sco_mergeAmount",
			mergeBtn: "sco_mergeBtn",
			mergeLabel: "sco_mergeLabel",
			mergePanel: "sco_mergePanel",
			mergePanelTitle: "sco_mergePanelTitle",
			mergePanelTitleLabel: "sco_mergePanelTitleLabel",
			mergePanelTitleValue: "sco_mergePanelTitleValue",
			mergePanelRule: "sco_mergePanelRule",
			mergePanelDetails: "sco_mergePanelDetails",
			mergePanelFoot: "sco_mergePanelFoot",
			mergePanelNote: "sco_mergePanelNote",
			mergeRefresh: "sco_mergeRefresh",
			peakDot: "sco_peakDot",
		};
		//#endregion

		//#region locale
		/** Locale namespace and dictionaries. */
		const NS = "sessionCost";
		const zh = {
			cost: "费用",
			thisSession: "本次",
			today: "今日",
			refresh: "刷新",
			refreshing: "刷新中…",
			updated: "已更新 {time}",
			unavailable: "暂不可用",
			tooltipCost: "本会话费用估算",
			tooltipInput: "输入",
			tooltipOutput: "输出",
			tooltipTokens: "tokens",
			tooltipUpdated: "更新于 {time}",
			tooltipPeak: "高峰",
			tooltipOffpeak: "空闲",
			tooltipV4: "V4 价",
			tooltipLegacy: "旧价",
			tooltipPricingNote: "费用为估算值：token 用量来自会话日志，单价见官方定价页（2026-08-17 起峰谷计价：高峰为北京时间工作日 9:00–12:00、14:00–18:00，价格为空闲时段的 2 倍；2026-08-23 起周末全天按空闲价计费；deepseek-v4-flash 输入 ¥1.5–3.0/百万、缓存命中 ¥0.05–0.10/百万、输出 ¥4.5–9.0/百万）。",
			tooltipNoModels: "暂无 token 用量",
			// 本地新增（2026-09-28）：状态栏峰谷圆点的悬停说明。
			tooltipPeakDotPeak: "高峰时段（橙）：北京时间工作日 9:00–12:00、14:00–18:00，按高峰价计费",
			tooltipPeakDotOffpeak: "空闲时段（绿）：高峰时段之外，以及周末和法定节假日全天，按空闲价计费",
			unpriced: "未计价",
			currencySymbol: "¥",
		};
		const en = {
			cost: "Cost",
			thisSession: "Session",
			today: "Today",
			refresh: "Refresh",
			refreshing: "Refreshing…",
			updated: "Updated {time}",
			unavailable: "Unavailable",
			tooltipCost: "Estimated cost of this session",
			tooltipInput: "Input",
			tooltipOutput: "Output",
			tooltipTokens: "tokens",
			tooltipUpdated: "Updated at {time}",
			tooltipPeak: "Peak",
			tooltipOffpeak: "Off-peak",
			tooltipV4: "V4-era",
			tooltipLegacy: "Legacy",
			tooltipPricingNote: "Cost is an estimate: token usage comes from the session log; unit prices follow the official pricing page (peak/off-peak billing since 2026-08-17: peak = Beijing weekdays 09:00–12:00 / 14:00–18:00 at 2× the off-peak rate; weekends bill at off-peak rates all day since 2026-08-23; deepseek-v4-flash input ¥1.5–3.0/M, cache hit ¥0.05–0.10/M, output ¥4.5–9.0/M).",
			tooltipNoModels: "No token usage yet",
			// 本地新增（2026-09-28）：状态栏峰谷圆点的悬停说明。
			tooltipPeakDotPeak: "Peak hours (orange): Beijing weekdays 09:00–12:00 and 14:00–18:00, billed at the peak rate",
			tooltipPeakDotOffpeak: "Off-peak hours (green): outside the peak windows, plus all day on weekends and Chinese statutory holidays",
			unpriced: "unpriced",
			currencySymbol: "¥",
		};
		//#endregion

		//#region helpers
		/** Group thousands. */
		function fmt(n) {
			return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
		}

		/** CNY amount: up to 4 decimals for tiny costs, 2 for balances. */
		function fmtCny(value, maxDecimals) {
			if (value === null || value === void 0 || !Number.isFinite(Number(value))) return "—";
			const n = Number(value);
			const decimals = 2;
			return n.toFixed(decimals).replace(/\.?0+$/, (m) => (m.startsWith(".") ? "" : m));
		}

		/** Coerce an amount (number or numeric string) to a number, or null. */
		function numOrNull(value) {
			if (value === null || value === void 0) return null;
			const n = Number(value);
			return Number.isFinite(n) ? n : null;
		}

		/** Per-request staleness guard: only the most recent start may `isCurrent()`. */
		function createLoader() {
			let current = 0;
			return {
				start: () => ++current,
				isCurrent: (id) => id === current
			};
		}

		//#region 峰谷圆点（本地新增 2026-09-28）
		//
		// 状态栏那个小圆点回答一个问题：「此刻按高峰价还是空闲价计费」。
		// 高峰橙、空闲绿；只对 deepseek 显示——峰谷计价是 deepseek 的规则，
		// 换到别的模型（例如 codex 订阅那套）时这个圆点只会误导人。
		//
		// 判据与 lib/cost.js 的 peakStateOf 完全一致：北京时间工作日
		// 9:00–12:00、14:00–18:00 为高峰；2026-08-23 起周末全天空闲；周末之外
		// 的中国法定节假日也全天空闲（官方定价页原文：「其余时段，包括周末及
		// 中国法定节假日全天均为空闲时段」）。服务端在同一个 summary 响应里
		// 已经给出 `peak`，正常情况下直接用它的；这份本地实现是给「host 还没
		// 重启、响应里没有该字段」时兜底的，也负责在两次刷新之间跟进时段切换。

		/** 与 lib/cost.js 的 WEEKEND_CUTOVER_MS 一致：2026-08-23 00:00 +08:00。 */
		const PEAK_WEEKEND_CUTOVER_MS = Date.UTC(2026, 7, 22, 16, 0, 0);

		/**
		 * 中国法定节假日（北京时间全天按空闲价）。
		 *
		 * **与 lib/cost.js 的 CN_HOLIDAYS 必须同步**：两处各存一份是因为客户端
		 * 这个 bundle 不能 import 服务端模块（手写的 __ModuleLoader__ 包，没有
		 * 构建步骤）。数据来源：国务院办公厅关于 2026 年部分节假日安排的通知
		 * （2025-11-04 新华社受权发布）。新的一年公布后两处都要补一组日期，
		 * 缺了只会把节假日误判成高峰（显示橙色、但账单其实是空闲价）。
		 */
		const PEAK_CN_HOLIDAYS = new Set([
			// 元旦：1/1–1/3
			"2026-01-01", "2026-01-02", "2026-01-03",
			// 春节：2/15–2/23（9 天）
			"2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
			"2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
			// 清明：4/4–4/6
			"2026-04-04", "2026-04-05", "2026-04-06",
			// 劳动节：5/1–5/5
			"2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
			// 端午：6/19–6/21
			"2026-06-19", "2026-06-20", "2026-06-21",
			// 中秋：9/25–9/27
			"2026-09-25", "2026-09-26", "2026-09-27",
			// 国庆：10/1–10/7
			"2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05",
			"2026-10-06", "2026-10-07"
		]);

		/** 北京时间的 `YYYY-MM-DD`（UTC+8，无夏令时）。 */
		function beijingDateKey(timeMs) {
			return new Date(timeMs + 8 * 3600 * 1000).toISOString().slice(0, 10);
		}

		/** 北京时间的星期（0 = 周日 … 6 = 周六）。 */
		function beijingDayOf(timeMs) {
			return new Date(timeMs + 8 * 3600 * 1000).getUTCDay();
		}

		/** 北京时间的小时。 */
		function beijingHourOf(timeMs) {
			return (new Date(timeMs).getUTCHours() + 8) % 24;
		}

		/**
		 * 某一时刻处于高峰还是空闲。
		 * @param timeMs - 毫秒时间戳。
		 * @returns `"peak"` 或 `"offpeak"`。
		 */
		function peakStateOf(timeMs) {
			if (!Number.isFinite(timeMs)) return "offpeak";
			if (timeMs >= PEAK_WEEKEND_CUTOVER_MS) {
				const day = beijingDayOf(timeMs);
				if (day === 0 || day === 6) return "offpeak";
				if (PEAK_CN_HOLIDAYS.has(beijingDateKey(timeMs))) return "offpeak";
			}
			const hour = beijingHourOf(timeMs);
			return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18) ? "peak" : "offpeak";
		}

		/**
		 * 模型 id 是否属于 deepseek。模型 id 可能是 `provider/model` 形式，
		 * 只看最后一段（与 cost.js 的定价匹配口径一致）。
		 * @param id - 模型 id。
		 */
		function isDeepseekModel(id) {
			if (typeof id !== "string") return false;
			const slash = id.lastIndexOf("/");
			const leaf = (slash === -1 ? id : id.slice(slash + 1)).trim();
			return /^deepseek/i.test(leaf);
		}

		/**
		 * 圆点该不该显示。
		 *
		 * 首选服务端给出的「当前模型」（会话日志里最后一条 `request/header`）：
		 * 切到非 deepseek 模型后，只要发过一次请求它就会跟着变。该字段缺失
		 * （服务端还是旧版、或会话里还没有请求）时退回保守判断——本会话统计
		 * 到的模型**全是** deepseek 才显示，只要混进了别的模型就先不显示，
		 * 宁可不给指示，也不给一个错的。
		 * @param data - the merge node's state object.
		 */
		function peakDotVisible(data) {
			const current = data.currentModel;
			if (typeof current === "string" && current !== "" && current !== "unknown/unknown") {
				return isDeepseekModel(current);
			}
			const models = Array.isArray(data.models) ? data.models : [];
			if (models.length === 0) return false;
			return models.every((row) => isDeepseekModel(row?.model));
		}

		/**
		 * 把圆点涂成对应时段：高峰橙 `#f59e0b`，空闲绿 `#22c55e`。颜色写在
		 * `data-state` 上由样式表决定（见 `sco_peakDot`），这里只负责切状态和
		 * 悬停说明——两处都用同一个状态值，不会各说各话。
		 * @param dot - the dot element.
		 * @param state - `"peak"` or `"offpeak"`.
		 */
		function applyPeakDotState(dot, state) {
			if (dot === null || dot === void 0) return;
			const normalized = state === "peak" ? "peak" : "offpeak";
			dot.setAttribute("data-state", normalized);
			const label = normalized === "peak" ? dot.dataset.peakTitle : dot.dataset.offpeakTitle;
			if (typeof label === "string" && label !== "") {
				dot.title = label;
				dot.setAttribute("aria-label", label);
			}
		}

		/**
		 * 时段在 9:00 / 12:00 / 14:00 / 18:00 和午夜切换，而费用每 30 秒才刷新
		 * 一次；30 秒的独立定时器负责在这几个边界上换色。整页只跑一个定时器
		 * （幂等启动），元素被换掉也不用清理——每次都从 DOM 里现查。
		 */
		let peakDotTicker = null;
		function startPeakDotTicker() {
			if (peakDotTicker !== null) return;
			if (typeof window === "undefined" || typeof window.setInterval !== "function") return;
			peakDotTicker = window.setInterval(() => {
				if (typeof document === "undefined") return;
				const state = peakStateOf(Date.now());
				for (const dot of document.querySelectorAll("[data-slot=peak-dot]")) applyPeakDotState(dot, state);
			}, 30 * 1000);
		}

		/**
		 * Build the 峰谷 dot, or `null` when this session is not on a deepseek
		 * model. The dot is the FIRST child of the trigger button, i.e. just
		 * left of the cost icon — the gap between the built-in 缓存命中 reading
		 * and the 本次 reading.
		 * @param dict - localized dictionary.
		 * @param data - the merge node's state object.
		 */
		function buildPeakDot(dict, data) {
			if (!peakDotVisible(data)) return null;
			const dot = document.createElement("span");
			dot.className = S.peakDot;
			dot.setAttribute("data-slot", "peak-dot");
			dot.setAttribute("role", "img");
			// 两种状态各自的悬停说明先存到 dataset 上：定时器换色时不必再拿一次 dict。
			dot.dataset.peakTitle = dict("tooltipPeakDotPeak");
			dot.dataset.offpeakTitle = dict("tooltipPeakDotOffpeak");
			// 服务端在同一次响应里给了 `peak` 就用它（与账单同一判据）；没有就本地判。
			const state = data.peak === "peak" || data.peak === "offpeak" ? data.peak : peakStateOf(Date.now());
			applyPeakDotState(dot, state);
			startPeakDotTicker();
			return dot;
		}

		/**
		 * Reconcile the dot between the mounted node and a freshly built one:
		 * it can appear/disappear (model switched) and change colour (period
		 * switched). The fresh node wins in every case.
		 * @param previous - the node currently mounted.
		 * @param node - the freshly built node for the current state.
		 */
		function syncPeakDot(previous, node) {
			const previousTrigger = previous === null ? null : previous.querySelector("[data-slot=trigger]");
			const nextTrigger = node === null ? null : node.querySelector("[data-slot=trigger]");
			if (previousTrigger === null || nextTrigger === null) return;
			const previousDot = previousTrigger.querySelector("[data-slot=peak-dot]");
			const nextDot = nextTrigger.querySelector("[data-slot=peak-dot]");
			if (nextDot === null) {
				// 换成非 deepseek 模型：把已经画出来的圆点收走。
				if (previousDot !== null) previousDot.remove();
				return;
			}
			if (previousDot === null) {
				// 从无到有：插在费用图标之前，没有图标就放在最前。
				const icon = previousTrigger.querySelector("[data-slot=trigger-icon]");
				if (icon !== null) previousTrigger.insertBefore(nextDot, icon);
				else previousTrigger.insertBefore(nextDot, previousTrigger.firstChild);
				return;
			}
			previousDot.dataset.peakTitle = nextDot.dataset.peakTitle;
			previousDot.dataset.offpeakTitle = nextDot.dataset.offpeakTitle;
			applyPeakDotState(previousDot, nextDot.getAttribute("data-state"));
		}
		//#endregion


		/**
		 * The per-period cost split for one model, as a trailing
		 * `· 高峰 ¥x · 空闲 ¥y` suffix. Only rendered when a session actually
		 * spans more than one rate regime — the current 峰谷 pair, or an earlier
		 * price era (V4 价 / 旧价) that a long session reaches back into — so it
		 * stays out of the way in the common case.
		 * @param dict - localized dictionary.
		 * @param row - one per-model summary row.
		 * @returns the suffix, or an empty string when the row billed one period.
		 */
		function billingSplitSuffix(dict, row) {
			const parts = [];
			if (row.peakCost > 0) parts.push(`${dict("tooltipPeak")} ${dict("currencySymbol")}${fmtCny(row.peakCost, 4)}`);
			if (row.offpeakCost > 0) parts.push(`${dict("tooltipOffpeak")} ${dict("currencySymbol")}${fmtCny(row.offpeakCost, 4)}`);
			if (row.v4Cost > 0) parts.push(`${dict("tooltipV4")} ${dict("currencySymbol")}${fmtCny(row.v4Cost, 4)}`);
			if (row.legacyCost > 0) parts.push(`${dict("tooltipLegacy")} ${dict("currencySymbol")}${fmtCny(row.legacyCost, 4)}`);
			return parts.length > 1 ? ` · ${parts.join(" · ")}` : "";
		}

		async function fetchJson(path) {
			const response = await fetch(path, { headers: { accept: "application/json" } });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const payload = await response.json();
			if (payload === null || typeof payload !== "object") throw new Error("unexpected response");
			return payload;
		}
		//#endregion

		//#region stats-bar merge helpers
		/**
		 * Attribute the built-in stats bar has carried since DSH 0.1.5
		 * (`StatsPills`, which replaced the `StatsLine` block). It is the
		 * primary handle: the row is a flex container of icon pills, the text
		 * marker below is only a fallback for assemblies without the attribute.
		 */
		const STATS_ROW_ATTR = "data-composer-stats";
		/**
		 * Fallback text marker for the built-in stats row: the counts segment
		 * is `N 轮 · M 步` (StatsLine, ≤ 0.1.4) or `N 轮 61 步` / `N turns 61
		 * steps` (StatsPills, ≥ 0.1.5, separator dropped), with `轮`/`步`
		 * localized. Matched anywhere in the row's text, never anchored, so a
		 * leading icon or a changed separator cannot break detection.
		 */
		const STATS_ROW_TEXT = /\d+\s*(?:轮|turns?)\s*·?\s*\d+\s*(?:步|steps?)/;

		/**
		 * Locate the built-in stats bar among the dock container's children.
		 * The container is the element that holds both the stats bar's root
		 * and our hidden anchor (they are sibling dock entries). The bar is
		 * identified by its `data-composer-stats` attribute first (DSH 0.1.5+,
		 * where the row is a pill container rather than a text line) and by
		 * its counts text second (older assemblies); hashed CSS class names
		 * are deliberately not relied upon.
		 */
		function findStatsRow(container) {
			if (container === null || container === void 0 || container.nodeType !== 1) return null;
			for (const child of container.children) {
				if (child.nodeType !== 1) continue;
				if (child.hasAttribute("data-session-cost-anchor")) continue;
				if (child.hasAttribute(STATS_ROW_ATTR) || child.querySelector("[" + STATS_ROW_ATTR + "]") !== null) return child;
				if (STATS_ROW_TEXT.test(child.textContent ?? "")) return child;
			}
			return null;
		}

		//#region svg glyphs
		const SVG_NS = "http://www.w3.org/2000/svg";

		/**
		 * Build one inline SVG element. Every glyph this bundle draws is
		 * hand-written here (the cost pill's wallet, the refresh arrow, the
		 * panel head icon): the shipped icon module is not part of the client
		 * module graph at 0.1.5, and requiring it would throw inside the factory
		 * and take the whole client half down.
		 * @param props - svg attributes; `children` lists `[tag, attributes]` pairs.
		 */
		function svgEl(props) {
			const svg = document.createElementNS(SVG_NS, "svg");
			svg.setAttribute("viewBox", "0 0 16 16");
			svg.setAttribute("aria-hidden", "true");
			for (const [name, value] of Object.entries(props ?? {})) {
				if (name === "children" || value === void 0 || value === null) continue;
				svg.setAttribute(name, String(value));
			}
			for (const [tag, attrs] of props?.children ?? []) {
				const child = document.createElementNS(SVG_NS, tag);
				for (const [name, value] of Object.entries(attrs)) child.setAttribute(name, String(value));
				svg.appendChild(child);
			}
			return svg;
		}

		/** Two stacked chevrons at 14/10 px — the `<detail>` disclosure zoom spec. */
		const ZOOM_ICON_PATH = {
			fill: "none",
			stroke: "currentColor",
			"stroke-width": "1.2",
			"stroke-linecap": "round",
			d: "M2.2 6.1h11.6M4 10.1h8M5.8 14h4.4"
		};

		/**
		 * The session-cost pill glyph: a wallet. Deliberately NOT a ¥ badge —
		 * the label already reads 费用 ¥x, so a currency-symbol icon both
		 * duplicates the unit and says nothing about what is being counted.
		 * A wallet reads as "what this costs / what is left", carries no
		 * currency symbol of its own, and holds its weight at the pill's 14 px
		 * next to the built-in gauge/database glyphs.
		 */
		function costIconSvg() {
			return svgEl({
				width: "14",
				height: "14",
				children: [
					["rect", {
						x: "2", y: "3.5", width: "12", height: "9.5", rx: "2.2",
						fill: "none", stroke: "currentColor", "stroke-width": "1.2"
					}],
					["path", { fill: "none", stroke: "currentColor", "stroke-width": "1.2", d: "M2 7h12" }],
					["circle", { cx: "11.6", cy: "9.9", r: "0.95", fill: "currentColor" }]
				]
			});
		}

		/** Create a small inline SVG refresh icon. */
		function refreshIconSvg() {
			return svgEl({
				width: "10",
				height: "10",
				children: [["path", {
					fill: "currentColor",
					d: "M13.65 2.35a.75.75 0 0 0-1.06 0L11.28 3.66A6.5 6.5 0 1 0 14.5 8h-1.5a5 5 0 1 1-1.47-3.54l-1.22 1.22a.75.75 0 0 0 .53 1.28h3a.75.75 0 0 0 .75-.75v-3a.75.75 0 0 0-1.94-.86Z"
				}]]
			});
		}

		/** The panel's title glyph: the same wallet at title scale. */
		function panelTitleIconSvg() {
			return costIconSvg();
		}
		//#endregion

		/** Observer options: childList + text + the whole subtree (see below). */
		const STATS_OBSERVE = { childList: true, characterData: true, subtree: true };
		/** How often the watchdog checks that the merge is still where it belongs. */
		const MERGE_WATCHDOG_MS = 1000;

		/**
		 * Keep the cost/balance merge attached to the built-in stats bar for as
		 * long as the dock anchor is mounted.
		 *
		 * The bar is React-owned, so any of its re-renders can wipe the nodes we
		 * appended; a MutationObserver re-appends after every external mutation.
		 * Three timing facts make the wiring delicate:
		 *
		 * 1. The bar APPEARS LATE. Since DSH 0.1.5 `StatsPills` returns `null`
		 *    until the session has a step or token activity, so the anchor's
		 *    parent already exists while the bar does not. Observing only that
		 *    parent's own `childList` never fires when the bar finally mounts
		 *    (the parent itself is untouched), which silently loses the merge —
		 *    the observer therefore watches the whole subtree.
		 * 2. The DATA also arrives late: on a freshly started host the first
		 *    summary/balance responses are still in flight while the component
		 *    mounts. The observer must therefore be installed UNCONDITIONALLY —
		 *    bailing out when there is nothing to draw yet (an earlier version
		 *    did exactly that) leaves nobody watching for the bar, and the merge
		 *    only ever appeared after a page reload had already warmed the data.
		 *    `sync()` simply renders nothing until the first payload lands.
		 * 3. The whole COMPOSER is torn down on a session switch. Opening a
		 *    session with no warm client cache takes about a second, and for
		 *    that second the anchor sits inside a DETACHED subtree — so a
		 *    mutation callback legitimately runs while `container()` is not
		 *    connected. Re-observing only a connected host is what made the
		 *    reading disappear for good on such a switch (the observer stayed
		 *    disconnected for the rest of the component's life, and only a page
		 *    reload — a fresh mount with a fresh observer — brought the pill
		 *    back). Re-observation is therefore UNCONDITIONAL, and a watchdog
		 *    repairs a merge that should be on screen but is not.
		 *
		 * The merge also survives a session in which DSH renders NO bar at all
		 * (brand new, or still loading): the node is then hosted by the anchor
		 * itself (`data-solo`, styled with the bar's own metrics) and moves into
		 * the bar as soon as it appears. Without that fallback the reading
		 * vanished together with the bar it used to live in.
		 *
		 * `writeMerge` returns the node to append (or null while there is
		 * nothing to show); it is re-invoked on every sync so the latest
		 * cost/balance state and the current dictionary are always what lands
		 * in the DOM.
		 *
		 * @param anchor - the hidden dock anchor whose sibling is the stats bar.
		 * @param writeMerge - builds the merge node for the current state.
		 * @returns `{ sync, dispose }` — `sync` re-applies the current state
		 *   (the owner calls it whenever its data changes), `dispose` removes
		 *   the observer, the watchdog and the merge node.
		 * @internal
		 */
		function startStatsRowObserver(anchor, writeMerge) {
			if (anchor === null || anchor === void 0 || anchor.nodeType !== 1) {
				return { sync: () => {}, dispose: () => {} };
			}
			/** The built-in stats bar the merge is currently attached to. */
			let row = null;
			let observer = null;
			/** The element the observer is currently attached to. */
			let observed = null;
			let timer = null;
			/** Whether the last sync actually put a merge node in the DOM. */
			let rendered = false;
			const container = () => anchor.parentElement;
			const hostOf = () => (row !== null ? row : anchor);

			/** Drop the merge node a host carries, with its panel and listeners. */
			const drop = (host) => {
				if (host === null || host === void 0 || host.nodeType !== 1) return;
				const node = host.querySelector("[data-session-cost-merge]");
				if (node === null) return;
				disposeMergeNode(node);
				node.remove();
			};

			/**
			 * Build (or reconcile) the merge node inside `host`. An identical
			 * shape is patched in place so the mounted listeners — and an open
			 * panel — survive a data update; the candidate node is then
			 * discarded, its portaled panel included.
			 */
			const place = (host) => {
				const previous = host.querySelector("[data-session-cost-merge]");
				const node = writeMerge();
				rendered = node !== null;
				if (node === null) {
					if (previous !== null) {
						disposeMergeNode(previous);
						previous.remove();
					}
					return;
				}
				if (previous !== null && sameMergeShape(previous, node)) {
					updateMergeNode(previous, node);
					disposeMergeNode(node);
					placeOpenPanel(previous);
					return;
				}
				if (previous !== null) {
					disposeMergeNode(previous);
					previous.remove();
				}
				host.appendChild(node);
				placeOpenPanel(node);
			};

			/** Bring the merge in line with the current DOM and data. */
			const runSync = () => {
				row = findStatsRow(container());
				if (row === null) {
					// No bar (yet): host the node in the anchor itself so the
					// reading does not disappear with the bar.
					anchor.setAttribute("data-solo", "true");
				} else {
					// The bar is used EXACTLY as DSH styles it: no width,
					// overflow or text-overflow is ever rewritten. The old
					// widening existed for the ≤ 0.1.4 text row (748 px cap +
					// `overflow:hidden` + ellipsis, which clipped the appended
					// tail); 0.1.5's `.bOPqQW_root` is a centered flex row that
					// clips nothing, so its own layout is enough.
					anchor.removeAttribute("data-solo");
					drop(anchor);
				}
				place(hostOf());
			};

			/**
			 * Contained wrapper around {@link runSync}: this runs from a React
			 * effect (an uncaught error there unmounts the whole app) and from a
			 * MutationObserver callback, so a defect in the merge must never take
			 * the harness down with it. The failure is reported to the console and
			 * the watchdog retries a second later.
			 */
			const sync = () => {
				try {
					runSync();
				} catch (error) {
					rendered = false;
					if (typeof console !== "undefined" && typeof console.warn === "function") {
						console.warn("session-cost: merge update failed", error);
					}
				}
			};

			/** (Re-)attach the observer to the anchor's current container. */
			const watch = () => {
				if (observer === null) return;
				const host = container();
				if (host === null) return;
				if (host !== observed) {
					observer.disconnect();
					observed = host;
				}
				// Unconditional: a momentarily detached host still delivers
				// subtree mutations, and skipping it here is exactly the bug.
				observer.observe(host, STATS_OBSERVE);
			};

			/** Detach the observer and forget its target. */
			const unwatch = () => {
				if (observer !== null) observer.disconnect();
				observed = null;
			};

			/**
			 * Safety net for everything the mutation stream cannot report: a
			 * node React wiped while the observer was detached, a bar re-mounted
			 * with no mutation we could observe, an anchor that moved to another
			 * container. Checking is cheap and rebuilding only happens when
			 * something is actually missing, so this is a repair pass rather
			 * than a poll.
			 */
			const watchdog = () => {
				watch();
				if (!rendered) return;
				if (row !== null && !row.isConnected) {
					sync();
					return;
				}
				const host = hostOf();
				const node = host.querySelector("[data-session-cost-merge]");
				if (node === null || node.parentElement !== host) sync();
			};

			sync();
			if (typeof MutationObserver !== "undefined") {
				observer = new MutationObserver(() => {
					// Guard against our own append loops: write with the observer
					// disconnected, reconnect afterwards.
					unwatch();
					try {
						if (row !== null && !row.isConnected) row = null;
						sync();
					} finally {
						watch();
					}
				});
				watch();
			}
			if (typeof window !== "undefined" && typeof window.setInterval === "function") {
				timer = window.setInterval(watchdog, MERGE_WATCHDOG_MS);
			}
			const dispose = () => {
				if (timer !== null && typeof window !== "undefined" && typeof window.clearInterval === "function") {
					window.clearInterval(timer);
				}
				timer = null;
				unwatch();
				drop(row);
				drop(anchor);
				anchor.removeAttribute("data-solo");
				row = null;
				rendered = false;
			};
			return { sync, dispose };
		}
		//#endregion

		/**
		 * Reconcile a freshly built merge node with the one already in the DOM.
		 *
		 * Replacing the node wholesale would be simpler, but it would also
		 * discard the click listener's captured state and any open panel. The
		 * node's shape only depends on which segments are present, so an
		 * update patches the value-bearing slots (trigger label, panel rows,
		 * warn flags, open state) and keeps the same elements — and therefore
		 * the same listeners — alive.
		 *
		 * The panel is PORTALED to `document.body`, so nothing inside it is
		 * reachable by querying the merge node: both panels are resolved
		 * through the node→panel registry. Reaching for them with
		 * `previous.querySelector("[data-slot=panel]")` (which is what this
		 * did) always returned null, which silently froze every panel reading
		 * and — once the merge node stopped being rebuilt on each data change —
		 * left the panel unable to open at all.
		 * @param previous - the node currently mounted.
		 * @param node - the freshly built node for the current state.
		 */
		function updateMergeNode(previous, node) {
			// 本地新增（2026-09-28）：峰谷圆点会随模型切换出现/消失、随时段切换换色。
			syncPeakDot(previous, node);
			// Slots inside the node itself (the trigger and its label).
			patchIcon(previous.querySelector("[data-slot=trigger-icon]"), node.querySelector("[data-slot=trigger-icon]"));
			patchText(previous.querySelector("[data-slot=trigger-label]"), node.querySelector("[data-slot=trigger-label]"));
			const prevCost = previous.querySelector("[data-slot=cost]");
			const nextCost = node.querySelector("[data-slot=cost]");
			patchText(prevCost, nextCost);
			patchWarn(prevCost, nextCost);
			// 本地新增（2026-09-27）：今日段也要跟着轮询更新——漏掉这几行的话，
			// 它会停在节点第一次画出来的那个数字上，之后的刷新都看不到。
			// （外层容器 trigger-label 不受影响：patchText 对含 `[data-slot]`
			//   子节点的容器直接跳过，不会把整段文本拍平。）
			const previousToday = previous.querySelector("[data-slot=today]");
			const nextToday = node.querySelector("[data-slot=today]");
			patchText(previousToday, nextToday);
			patchWarn(previousToday, nextToday);
			// Slots inside the portaled panel.
			const previousPanel = panelOf(previous);
			const nextPanel = panelOf(node);
			const previousTrigger = previous.querySelector("[data-slot=trigger]");
			if (previousPanel !== null && nextPanel !== null) {
				const slot = (panel, name) => panel.querySelector("[data-slot=" + name + "]");
				// 本地新增（2026-09-27）：今日块整块换——里面的模型行数会变，
				// 逐槽位 patch 覆盖不到新出现的行。
				const previousTodayBlock = slot(previousPanel, "panel-today-block");
				const nextTodayBlock = slot(nextPanel, "panel-today-block");
				if (previousTodayBlock !== null && nextTodayBlock !== null
					&& previousTodayBlock.innerHTML !== nextTodayBlock.innerHTML) {
					previousTodayBlock.replaceWith(nextTodayBlock);
				}
				patchText(slot(previousPanel, "title-value"), slot(nextPanel, "title-value"));
				patchText(slot(previousPanel, "panel-updated"), slot(nextPanel, "panel-updated"));
				patchIcon(slot(previousPanel, "refresh-icon"), slot(nextPanel, "refresh-icon"));
				patchText(slot(previousPanel, "panel-note"), slot(nextPanel, "panel-note"));
				patchIcon(slot(previousPanel, "panel-head-icon"), slot(nextPanel, "panel-head-icon"));
				const previousRefresh = slot(previousPanel, "refresh");
				const nextRefresh = slot(nextPanel, "refresh");
				if (previousRefresh !== null && nextRefresh !== null) {
					previousRefresh.disabled = nextRefresh.disabled;
					previousRefresh.setAttribute("data-spin", nextRefresh.getAttribute("data-spin") ?? "false");
					previousRefresh.setAttribute("aria-label", nextRefresh.getAttribute("aria-label") ?? "");
				}
				const previousList = slot(previousPanel, "panel-list");
				const nextList = slot(nextPanel, "panel-list");
				if (previousList !== null && nextList !== null) {
					// Each child of the list IS a slot — `dt` carries row-label,
					// `dd` carries row-value (or panel-balance) — while
					// `querySelector` only looks at DESCENDANTS. Resolving
					// `current.querySelector("[data-slot=row-label]")` therefore
					// returned null for every cell and `patchText` bailed out, so
					// no list row ever moved: a manual refresh updated 账户余额
					// (patched by slot name further up) while 充值/赠送余额 and
					// the per-model readings stayed frozen. Patch the cells.
					//
					// The threshold row is not in this list at all (it sits under
					// the 更新于/⟳ line and carries no patched slot), so a 30 s
					// refresh cannot eat a value the user is halfway through
					// typing.
					//
					// Snapshot the candidate's cells first: appending or
					// replacing MOVES a cell out of `nextList`, which would
					// shift the indices under us.
					const nextCells = Array.from(nextList.children);
					for (let index = 0; index < nextCells.length; index += 1) {
						const next = nextCells[index];
						const current = previousList.children[index];
						if (current === void 0) {
							// The list grew in place (the first model row
							// replacing 暂无 token 用量, the balance breakdown
							// arriving): take the freshly built cell.
							previousList.appendChild(next);
							continue;
						}
						if (current.getAttribute("data-slot") !== next.getAttribute("data-slot")) {
							// Same slot count but a different cell at this index:
							// a silently stale cell would be invisible, so take
							// the fresh one.
							current.replaceWith(next);
							continue;
						}
						patchText(current, next);
						patchWarn(current, next);
					}
					while (previousList.children.length > nextCells.length) previousList.lastElementChild.remove();
				}
				// The open state travels on the panel (React owns it), so an
				// in-place update opens and closes it without rebuilding.
				if (previousTrigger !== null) {
					const wantOpen = nextPanel.hidden !== true;
					previousPanel.hidden = nextPanel.hidden;
					previousTrigger.setAttribute("aria-expanded", wantOpen ? "true" : "false");
					// Placement is measured on the live trigger and re-done by
					// `placeOpenPanel` below, never copied from the freshly built
					// node (which was never laid out).
					if (!wantOpen) previousPanel.style.visibility = "hidden";
				}
			}
			// Placement is measured against the LIVE trigger, which is the only
			// reason this runs here rather than on the freshly built node.
			// `startStatsRowObserver.sync()` calls this only once the node has
			// been appended, so the pill has a real box by now.
			placeOpenPanel(previous);
		}
		//#endregion

		/**
		 * Set a text slot's content only when it actually changed. A slot that
		 * CONTAINS other slots (the pill label wraps the cost and balance
		 * readings) must never be written as text — that would wipe its
		 * children out of the DOM — so only leaf slots are patched.
		 */
		function patchText(previous, next) {
			if (previous === null || next === null) return;
			if (previous.querySelector("[data-slot]") !== null) return;
			if (previous.textContent !== next.textContent) previous.textContent = next.textContent;
		}

		/** Mirror the warn flag a value slot carries. */
		function patchWarn(previous, next) {
			if (previous === null || next === null) return;
			const warn = next.getAttribute("data-warn") === "true";
			if (warn) previous.setAttribute("data-warn", "true");
			else previous.removeAttribute("data-warn");
		}

		/** Replace an svg slot when its path data changed (warn/refresh glyphs). */
		function patchIcon(previous, next) {
			if (previous === null || next === null) return;
			if (previous.outerHTML === next.outerHTML) return;
			previous.replaceWith(next);
		}

		/** Both node shapes carry the same classes: safe to patch slot by slot. */
		function sameMergeShape(previous, node) {
			if (previous.tagName !== node.tagName) return false;
			if (previous.className !== node.className) return false;
			const previousSlots = previous.querySelectorAll("[data-slot]").length;
			const nextSlots = node.querySelectorAll("[data-slot]").length;
			return previousSlots === nextSlots;
		}

		/**
		 * The panel's "model · in/out tokens · ¥cost" reading, as a `dt`/`dd`
		 * pair for the shared stat-dialog grid. A model whose `price` came back
		 * null bills at 0 and would read as "this session is free", so its row
		 * says 未计价 instead (that means DSH started routing the model under an
		 * id the pricing table has not learned yet).
		 * @param dict - localized dictionary.
		 * @param row - one per-model summary row.
		 */
		function modelRowElement(dict, row) {
			const name = row.model.includes("/") ? row.model.slice(row.model.indexOf("/") + 1) : row.model;
			const dt = document.createElement("dt");
			dt.setAttribute("data-slot", "row-label");
			dt.textContent = name;
			const dd = document.createElement("dd");
			dd.setAttribute("data-slot", "row-value");
			const tokens = `${dict("tooltipInput")} ${fmt(row.inputTokens)} · ${dict("tooltipOutput")} ${fmt(row.outputTokens)}`;
			if (row.price === null || row.price === void 0) {
				dd.setAttribute("data-warn", "true");
				dd.textContent = `${tokens} · ${dict("unpriced")}`;
				return [dt, dd];
			}
			dd.textContent = `${tokens} · ${dict("currencySymbol")}${fmtCny(row.cost, 4)}${billingSplitSuffix(dict, row)}`;
			return [dt, dd];
		}

		/** One `dt`/`dd` pair with an explicit label (balance split, totals). */
		function rowElement(label, value) {
			const dt = document.createElement("dt");
			dt.setAttribute("data-slot", "row-label");
			dt.textContent = label;
			const dd = document.createElement("dd");
			dd.setAttribute("data-slot", "row-value");
			dd.textContent = value;
			return [dt, dd];
		}

		/** Distance between the trigger's top edge and the panel's bottom (native dialog spec). */
		const PANEL_GAP = 8;
		/** Viewport margin the placement clamp keeps (native dialog spec). */
		const PANEL_MARGIN = 12;

		/**
		 * Position the panel above its trigger, clamped to the viewport — the
		 * same measure-then-place flow the built-in stat dialogs use (the
		 * shipped `useAnchoredPosition` hook needs the icon module the client
		 * module graph no longer serves, so the arithmetic lives here).
		 * @param trigger - the pill button the panel is anchored to.
		 * @param panel - the `position:fixed` panel to place.
		 */
		function placePanel(trigger, panel) {
			const anchor = trigger.getBoundingClientRect();
			const width = panel.offsetWidth;
			const height = panel.offsetHeight;
			const viewportWidth = window.innerWidth;
			const viewportHeight = window.innerHeight;
			const left = Math.min(
				Math.max(12, anchor.left + anchor.width / 2 - width / 2),
				Math.max(12, viewportWidth - width - 12)
			);
			let top = anchor.top - height - PANEL_GAP;
			if (top < PANEL_MARGIN) top = Math.min(anchor.bottom + PANEL_GAP, viewportHeight - height - PANEL_MARGIN);
			panel.style.left = `${Math.round(left)}px`;
			panel.style.top = `${Math.round(Math.max(PANEL_MARGIN, top))}px`;
			panel.style.visibility = "visible";
		}

		/**
		 * Each merge node's portaled panel. It lives in `document.body`, not in
		 * the node, so the node cannot find it by querying itself — this map is
		 * how the owner reaches it (placement, and the DOM-smoke assertions).
		 */
		const mergePanels = typeof WeakMap !== "undefined" ? new WeakMap() : null;

		/**
		 * Resolve a merge node's portaled panel. The panel is NOT a descendant
		 * of the node (it hangs off `document.body` so the stats bar's
		 * `overflow` cannot clip it), so every panel slot — readings, warn
		 * flags, open state — must be reached through this lookup rather than
		 * through `node.querySelector`.
		 * @param node - a node produced by `buildMergeNode`.
		 * @returns the panel element, or null when there is none.
		 */
		function panelOf(node) {
			if (node === null || node === void 0 || mergePanels === null) return null;
			return mergePanels.get(node) ?? null;
		}

		/**
		 * Drop a merge node's document-level listeners and its portaled panel.
		 * Every node built by `buildMergeNode` owns a panel, including the ones
		 * that never reach the DOM (the observer builds a candidate on every
		 * sync and keeps only some of them), so the discards must run this too
		 * or each sync would leak one panel into `document.body`.
		 * @param node - a node produced by `buildMergeNode`.
		 */
		function disposeMergeNode(node) {
			if (node === null || node === void 0) return;
			const panel = panelOf(node);
			if (mergePanels !== null) mergePanels.delete(node);
			node.dispatchEvent(new Event("session-cost:dispose"));
			if (panel !== null && panel.isConnected) panel.remove();
		}

		/**
		 * Place a merge node's panel when it should be open. Called after the
		 * node is in the DOM: the trigger's box is only meaningful then, so a
		 * re-opened panel (after a node rebuild) lands where the pill actually
		 * is instead of at the viewport origin.
		 * @param node - a node produced by `buildMergeNode`.
		 */
		function placeOpenPanel(node) {
			if (node === null || node === void 0) return;
			const panel = panelOf(node);
			const trigger = node.querySelector("[data-slot=trigger]");
			if (panel === null || trigger === null || panel.hidden === true) return;
			if (typeof window === "undefined" || typeof trigger.getBoundingClientRect !== "function") return;
			placePanel(trigger, panel);
		}

		/**
		 * Build the DOM node appended into the built-in stats bar: a pill
		 * button in the bar's own tier — `[¥] 本会话费用 ¥0.4549 ｜ 余额 ¥7.09`
		 * — that opens a portaled details panel above the bar (per-model
		 * breakdown, balance split, refresh, update time). This mirrors how the
		 * built-in stats pills carry their figures in a click-open dialog; the
		 * panel is placed with `position:fixed` and appended to `document.body`
		 * so the bar's `overflow` cannot clip it, and only one merge node is
		 * ever open (the open panel is closed on outside pointerdown/Escape).
		 *
		 * `dict` provides localized labels, `data` carries the current
		 * cost/balance state (plus `open`, the cross-rebuild panel state, and
		 * `onToggle`/`onRefresh`), and the node it returns is reconciled in
		 * place by `updateMergeNode`, so an open panel survives data updates.
		 * @returns the trigger + panel wrapper, or null when nothing to show.
		 */
		function buildMergeNode(dict, data) {
			const cost = data.cost;
			const costError = data.costError;
			const refreshing = data.refreshing;
			const justRefreshed = data.justRefreshed;
			// 本地新增（2026-09-27）：只有「今日」有数时也要把这一组画出来。
			const todayKnown = (data.todayCost !== null && data.todayCost !== void 0) || data.todayError !== null;
			if (costError === null && cost === null && !todayKnown) return null;

			const container = document.createElement("span");
			container.className = S.merge;
			container.setAttribute("data-session-cost-merge", "");

			// ---- trigger: the pill itself ------------------------------------
			const button = document.createElement("button");
			button.type = "button";
			button.className = S.mergeBtn;
			button.setAttribute("data-slot", "trigger");
			button.setAttribute("aria-haspopup", "dialog");
			button.setAttribute("aria-expanded", data.open === true ? "true" : "false");
			button.setAttribute("aria-label", dict("tooltipCost"));
			// 本地新增（2026-09-28）：峰谷小圆点——高峰橙、空闲绿，只对 deepseek
			// 模型显示。放在费用图标之前，也就是内置「缓存命中」读数与费用读数
			// 之间的那个空位（用户截图里画红框的位置）。
			const peakDot = buildPeakDot(dict, data);
			if (peakDot !== null) button.appendChild(peakDot);
			const icon = costIconSvg();
			icon.setAttribute("data-slot", "trigger-icon");
			button.appendChild(icon);
			const label = document.createElement("span");
			label.className = S.mergeLabel;
			label.setAttribute("data-slot", "trigger-label");
			label.appendChild(costSegment(dict, cost, costError));
			// 本地新增（2026-09-27）：「今日」紧跟在「本次」后面。
			const todayPart = buildTodaySegment(dict, data);
			if (todayPart !== null) label.appendChild(todayPart);
			button.appendChild(label);
			container.appendChild(button);

			// ---- panel: the old hover tooltip, now click-open -----------------
			const panel = document.createElement("div");
			panel.className = S.mergePanel;
			panel.setAttribute("data-slot", "panel");
			panel.setAttribute("role", "dialog");
			panel.setAttribute("aria-label", dict("tooltipCost"));
			panel.hidden = data.open !== true;

			const head = document.createElement("div");
			head.className = S.mergePanelTitle;
			const headLabel = document.createElement("span");
			headLabel.className = S.mergePanelTitleLabel;
			const headIcon = panelTitleIconSvg();
			headIcon.setAttribute("data-slot", "panel-head-icon");
			headLabel.appendChild(headIcon);
			const headText = document.createElement("span");
			// 本地改动（2026-09-27）：跟 pill 上的「本次」用同一个词。
			headText.textContent = dict("thisSession");
			headLabel.appendChild(headText);
			head.appendChild(headLabel);
			const titleValue = document.createElement("span");
			titleValue.className = S.mergePanelTitleValue;
			titleValue.setAttribute("data-slot", "title-value");
			// 本地改动（2026-09-27）：与状态栏同一条规矩——已经拿到金额就先显示金额，
			// 一次刷新失败不该把面板标题变成「暂不可用」。
			const titleHasNumber = cost !== null && Number.isFinite(Number(cost));
			titleValue.textContent = costError !== null && !titleHasNumber
				? dict("unavailable")
				: cost === null ? "—" : `${dict("currencySymbol")}${fmtCny(cost, 2)}`;
			head.appendChild(titleValue);
			panel.appendChild(head);

			const rule = document.createElement("div");
			rule.className = S.mergePanelRule;
			rule.setAttribute("aria-hidden", "true");
			panel.appendChild(rule);

			const details = document.createElement("dl");
			details.className = S.mergePanelDetails;
			details.setAttribute("data-slot", "panel-list");
			const models = data.models;
			// `rowElement` returns a dt/dd PAIR: append the cells, never the
			// array itself (a real `appendChild(array)` throws, which is how the
			// "no token usage yet" path used to take the whole merge down).
			if (models.length === 0) {
				for (const cell of rowElement(dict("tooltipNoModels"), "")) details.appendChild(cell);
			} else {
				for (const row of models) {
					for (const cell of modelRowElement(dict, row)) details.appendChild(cell);
				}
			}
			panel.appendChild(details);

			// 本地新增（2026-09-27）：今日块。
			// 结构与上面「本次」一致：先一行汇总，再每个模型一行。
			// 整块挂在 `data-slot="panel-today-block"` 上，内容变了就整块替换——
			// 模型数量会变，逐槽位 patch 覆盖不到新出现的行（见 updateMergeNode）。
			const todayBlock = document.createElement("div");
			todayBlock.setAttribute("data-slot", "panel-today-block");
			const todayHeadHasNumber = data.todayCost !== null && data.todayCost !== void 0
				&& Number.isFinite(Number(data.todayCost));
			if (data.todayError !== null && !todayHeadHasNumber) {
				const errorHead = document.createElement("div");
				errorHead.className = S.mergePanelTitle;
				const errorLabel = document.createElement("span");
				errorLabel.className = S.mergePanelTitleLabel;
				errorLabel.textContent = dict("today");
				errorHead.appendChild(errorLabel);
				const errorValue = document.createElement("span");
				errorValue.className = S.mergePanelTitleValue;
				errorValue.setAttribute("data-warn", "true");
				errorValue.textContent = dict("unavailable");
				errorHead.appendChild(errorValue);
				todayBlock.appendChild(errorHead);
			} else if (data.todayCost !== null && data.todayCost !== void 0) {
				const todayRule = document.createElement("div");
				todayRule.className = S.mergePanelRule;
				todayRule.setAttribute("aria-hidden", "true");
				todayBlock.appendChild(todayRule);
				const todayHead = document.createElement("div");
				todayHead.className = S.mergePanelTitle;
				const todayLabel = document.createElement("span");
				todayLabel.className = S.mergePanelTitleLabel;
				todayLabel.textContent = dict("today");
				todayHead.appendChild(todayLabel);
				const todayValue = document.createElement("span");
				todayValue.className = S.mergePanelTitleValue;
				todayValue.textContent = `${dict("currencySymbol")}${fmtCny(data.todayCost, 2)}`;
				todayHead.appendChild(todayValue);
				todayBlock.appendChild(todayHead);
				const todayDetails = document.createElement("dl");
				todayDetails.className = S.mergePanelDetails;
				const todayModels = Array.isArray(data.todayModels) ? data.todayModels : [];
				if (todayModels.length === 0) {
					for (const cell of rowElement(dict("tooltipNoModels"), "")) todayDetails.appendChild(cell);
				} else {
					for (const row of todayModels) {
						for (const cell of modelRowElement(dict, row)) todayDetails.appendChild(cell);
					}
				}
				todayBlock.appendChild(todayDetails);
			}
			if (todayBlock.childNodes.length > 0) panel.appendChild(todayBlock);
			const foot = document.createElement("div");
			foot.className = S.mergePanelFoot;
			const updatedAt = data.summary !== null && typeof data.summary.updatedAt === "number"
				? data.summary.updatedAt
				: 0;
			if (updatedAt > 0) {
				const updated = document.createElement("span");
				updated.className = S.mergeUpdated;
				updated.setAttribute("data-slot", "panel-updated");
				updated.textContent = dict("tooltipUpdated", {
					time: new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
				});
				foot.appendChild(updated);
			}
			const refresh = document.createElement("button");
			refresh.type = "button";
			refresh.className = S.mergeRefresh;
			refresh.setAttribute("data-slot", "refresh");
			refresh.disabled = refreshing;
			refresh.setAttribute("data-spin", refreshing ? "true" : "false");
			refresh.setAttribute("aria-label", dict(refreshing ? "refreshing" : "refresh"));
			const refreshIcon = refreshIconSvg();
			refreshIcon.setAttribute("data-slot", "refresh-icon");
			refresh.appendChild(refreshIcon);
			// Read the handler at CLICK time, not at build time: this node can now
			// outlive many renders (the merge is patched in place), and the owner
			// hands in a stable state object whose fields are refreshed per render
			// — so the refresh always acts on the session that is on screen.
			refresh.addEventListener("click", () => {
				if (typeof data.onRefresh === "function") data.onRefresh();
			});
			foot.appendChild(refresh);
			panel.appendChild(foot);

			const note = document.createElement("p");
			note.className = S.mergePanelNote;
			note.setAttribute("data-slot", "panel-note");
			note.textContent = dict("tooltipPricingNote");
			panel.appendChild(note);

			// The panel is created closed and placed by its owner once the node
			// is actually in the DOM (`placeOpenPanel`): the trigger's box is
			// meaningless before that, and the panel must never be visible at
			// the origin for a frame.
			panel.hidden = data.open !== true;
			if (typeof document !== "undefined" && document.body !== void 0 && document.body !== null) {
				document.body.appendChild(panel);
			}
			if (mergePanels !== null) mergePanels.set(container, panel);

			// The trigger owns the panel's lifecycle: toggling it, closing it on
			// outside pointerdown/Escape, and removing it with the node.
			if (typeof data.onToggle === "function") {
				button.addEventListener("click", () => data.onToggle(panel.hidden !== true));
			}
			const onOutside = (event) => {
				if (panel.hidden === true) return;
				if (panel.contains(event.target) || button.contains(event.target)) return;
				if (typeof data.onToggle === "function") {
					data.onToggle(true);
					return;
				}
				panel.hidden = true;
				button.setAttribute("aria-expanded", "false");
			};
			const onKeydown = (event) => {
				if (event.key !== "Escape" || panel.hidden === true) return;
				if (typeof data.onToggle === "function") {
					data.onToggle(true);
					return;
				}
				panel.hidden = true;
				button.setAttribute("aria-expanded", "false");
			};
			if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
				document.addEventListener("pointerdown", onOutside, true);
				document.addEventListener("keydown", onKeydown);
			}
			container.addEventListener("session-cost:dispose", () => {
				if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
					document.removeEventListener("pointerdown", onOutside, true);
					document.removeEventListener("keydown", onKeydown);
				}
				panel.remove();
			});
			if (justRefreshed !== null) {
				const updated = document.createElement("span");
				updated.className = S.updated;
				updated.textContent = dict("updated", {
					time: new Date(justRefreshed).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
				});
				container.appendChild(updated);
			}
			return container;
		}

		/** The `本次 ¥x.xx` segment of the pill label. */
		function costSegment(dict, cost, costError) {
			const value = document.createElement("span");
			value.className = S.mergeVal;
			value.setAttribute("data-slot", "cost");
			// 本地改动（2026-09-27）：404 只表示「这个会话没有可读的记录」（已经清理
			// 掉，或者还没落盘），按「没有数据」显示，不把一个红色错误挂在状态栏上。
			const missing = typeof costError === "string" && costError.indexOf("HTTP 404") === 0;
			// 本地改动（2026-09-27）：已经拿到过金额就先显示金额——一次刷新失败不该把
			// 状态栏上已经读到的数字变成红色警告。失败原因仍然在悬停提示和面板里，
			// 没有被吞掉，只是不再抢占这个本该显示钱的格子。
			const hasNumber = cost !== null && Number.isFinite(Number(cost));
			if (costError !== null && !hasNumber && !missing) {
				value.setAttribute("data-warn", "true");
				// 本地新增（2026-09-27）：把具体原因挂到悬停提示上——界面上只写
				// 「暂不可用」时，光看截图分不出是「会话读不到」还是「请求本身失败」。
				value.title = String(costError);
				value.textContent = `${dict("thisSession")} ${dict("unavailable")}`;
				return value;
			}
			// The summary is still in flight (or the session has no priced
			// usage sample yet): an em dash WITHOUT the currency symbol, never a
			// `¥—` that reads like a broken number.
			if (cost === null) {
				value.textContent = `${dict("thisSession")} —`;
				return value;
			}
			value.appendChild(document.createTextNode(`${dict("thisSession")} `));
			value.appendChild(amountSpan(`${dict("currencySymbol")}${fmtCny(cost, 2)}`));
			return value;
		}

		/**
		 * 本地新增（2026-09-27）：`· 今日 ¥y.yy` 段——今天所有会话的合计，
		 * 含已经关掉的会话，由服务端在同一个 summary 响应里带上。字段缺失
		 * （服务端还是旧版）就整段不显示；服务端明确报错时显示「暂不可用」，
		 * 绝不用 ¥0 冒充一个算不出来的数字。
		 */
		function buildTodaySegment(dict, data) {
			const today = data.todayCost;
			const todayError = data.todayError;
			if (todayError === null && (today === null || today === void 0)) return null;
			const segment = document.createElement("span");
			segment.className = S.mergeToday;
			const separator = document.createElement("span");
			separator.className = S.mergeSep;
			separator.setAttribute("aria-hidden", "true");
			// 与内置读数（`11 轮 · 565 步`）和余额段用同一个间隔点。
			separator.textContent = "·";
			segment.appendChild(separator);
			const value = document.createElement("span");
			value.className = S.mergeVal;
			value.setAttribute("data-slot", "today");
			// 本地改动（2026-09-27）：同上，有数字就显示数字。
			const todayHasNumber = today !== null && today !== void 0 && Number.isFinite(Number(today));
			if (todayError !== null && !todayHasNumber) {
				value.setAttribute("data-warn", "true");
				value.textContent = `${dict("today")} ${dict("unavailable")}`;
			} else {
				value.appendChild(document.createTextNode(`${dict("today")} `));
				value.appendChild(amountSpan(`${dict("currencySymbol")}${fmtCny(today, 2)}`));
			}
			segment.appendChild(value);
			return segment;
		}

		/** A currency amount in the tabular-figure span the pill readings use. */
		function amountSpan(text) {
			const amount = document.createElement("span");
			amount.className = S.mergeAmount;
			amount.textContent = text;
			return amount;
		}

		// The stats bar's own layout is never rewritten (see `runSync`): 0.1.5's
		// `.bOPqQW_root` is a centered flex row that caps and clips nothing, and
		// the ≤ 0.1.4 row that did need an inline widening patch is far outside
		// the supported range.
		//#endregion

		//#region SessionCostMerge
		/**
		 * The conversation-bottom stats-bar merge (the only display mode since
		 * 0.1.5; the standalone bar was removed). Renders a hidden anchor in
		 * the composer dock and appends the cost/balance segments INTO the
		 * built-in stats bar, which may mount after this component does.
		 * @param props - `useSession`/`useProjection` from the slot runtime and
		 *   `t` bound by the slot runtime locale seat.
		 */
		function SessionCostMerge({ useSession, useProjection, t }) {
			const dict = t !== void 0 ? t : (key) => zh[key] ?? key;
			const sessionId = useSession((snapshot) => snapshot.sessionId);
			const tokenUsage = useProjection("tokenUsage");

			const [summary, setSummary] = react.useState(null);
			const [summaryError, setSummaryError] = react.useState(null);
			const [refreshing, setRefreshing] = react.useState(false);
			const [justRefreshed, setJustRefreshed] = react.useState(null);
			// Panel open state, owned by React so it survives a merge-node
			// rebuild: the node is patched in place while its shape is stable,
			// but a shape change (a balance appearing, a segment erroring)
			// replaces it, and the replacement must re-open the same panel.
			const [panelOpen, setPanelOpen] = react.useState(false);
			const summaryLoaderRef = react.useRef(null);
			const debounceRef = react.useRef(null);
			if (summaryLoaderRef.current === null) summaryLoaderRef.current = createLoader();

			const loadSummary = react.useCallback(async () => {
				if (sessionId === void 0 || sessionId === null || sessionId === "") return false;
				const seq = summaryLoaderRef.current.start();
				try {
					const payload = await fetchJson(`/api/session-cost/summary?session=${encodeURIComponent(sessionId)}`);
					if (summaryLoaderRef.current.isCurrent(seq)) {
						setSummary(payload);
						setSummaryError(null);
					}
					return true;
				} catch (err) {
					if (summaryLoaderRef.current.isCurrent(seq)) setSummaryError(err instanceof Error ? err.message : String(err));
					return false;
				}
			}, [sessionId]);

			const refreshAll = react.useCallback(async () => {
				setRefreshing(true);
				try {
					// 本地改动（2026-09-27）：余额那半已移除，只剩会话汇总。
					const summaryOk = await loadSummary();
					if (summaryOk) setJustRefreshed(Date.now());
				} finally {
					setRefreshing(false);
				}
			}, [loadSummary]);

			// Initial load + interval + visibility refetch while mounted.
			// Initial load + interval + visibility refetch while mounted.
			react.useEffect(() => {
				loadSummary();
				const summaryTimer = window.setInterval(loadSummary, 30 * 1000);
				const onVisible = () => {
					if (document.visibilityState === "visible") loadSummary();
				};
				document.addEventListener("visibilitychange", onVisible);
				return () => {
					window.clearInterval(summaryTimer);
					document.removeEventListener("visibilitychange", onVisible);
				};
			}, [loadSummary]);

			// Refetch the cost summary shortly after the client-side token
			// projection moves (a turn finished), debounced.
			react.useEffect(() => {
				if (tokenUsage === void 0 || tokenUsage === null) return;
				if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
				debounceRef.current = window.setTimeout(() => {
					debounceRef.current = null;
					loadSummary();
				}, 500);
				return () => {
					if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
				};
			}, [tokenUsage, loadSummary]);

			// Fade the "updated" confirmation out shortly after a manual refresh.
			react.useEffect(() => {
				if (justRefreshed === null) return;
				const timer = window.setTimeout(() => setJustRefreshed(null), 2500);
				return () => window.clearTimeout(timer);
			}, [justRefreshed]);

			const anchorRef = react.useRef(null);
			const dictRef = react.useRef(dict);
			dictRef.current = dict;
			// React owns "is the panel open"; the DOM adapts on the next render.
			// The setter's identity is stable, so the data-push effect below can
			// depend on `panelOpen` alone.
			const togglePanel = react.useCallback((open) => setPanelOpen(open !== true), []);

			const cost = summary !== null && summary.ok === true ? numOrNull(summary.cost) : null;
			// 本地新增（2026-09-27）：服务端在同一个 summary 响应里带上「今日」
			// （今天所有会话合计，含已关闭的）；旧版服务端没有这个字段，
			// 这时 todayCost 与 todayError 都为 null，整段不显示。
			const todayPayload = summary !== null && summary.ok === true ? summary.today : null;
			const todayCost = todayPayload !== null && todayPayload !== void 0 && todayPayload.ok === true
				? numOrNull(todayPayload.cost)
				: null;
			const todayError = todayPayload !== null && todayPayload !== void 0 && todayPayload.ok === false
				? String(todayPayload.error ?? "unavailable")
				: null;
			const models = summary !== null && Array.isArray(summary.models) ? summary.models : [];
			// Keep a hidden anchor in the dock and append the cost/balance
			// segments INTO the built-in stats bar's DOM (see
			// `startStatsRowObserver` for how the late-appearing bar is tracked,
			// why the observer must span a subtree and re-arm itself, and how the
			// reading survives a session where DSH renders no bar at all).
			//
			// The bar's own styles are left alone: 0.1.5's `.bOPqQW_root` is a
			// centered flex row (`width:100%`, `max-width:748px`, `gap:12px`,
			// no overflow clipping), so an appended segment is simply a third
			// item in that group and the row is wide enough to hold it.
			//
			// Installed ONCE per mount, with the data pushed in by the effect
			// below: reinstalling on every poll used to tear the merge node down
			// and rebuild it (closing an open panel on each 30 s refresh) and it
			// masked the fact that a disarmed observer never came back.
			// One STABLE state object, refreshed in place on every render. The
			// merge node now outlives many renders (it is patched in place), and
			// its handlers read `onToggle`/`onRefresh` from this object at CLICK
			// time — replacing the object would freeze them on whichever render
			// happened to build the node (a refresh button bound to a stale
			// session, a toggle driving an unmounted component).
			const mergeRef = react.useRef(null);
			const mergeInputRef = react.useRef(null);
			if (mergeInputRef.current === null) mergeInputRef.current = {};
			const input = mergeInputRef.current;
			input.cost = cost;
			// 今日按模型的明细（明细面板「今日」下面那几行）。
			const todayModels = todayPayload !== null && todayPayload !== void 0
				&& Array.isArray(todayPayload.models) ? todayPayload.models : [];
			input.todayCost = todayCost;
			input.todayModels = todayModels;
			input.todayError = todayError;
			input.models = models;
			// 本地新增（2026-09-28）：峰谷圆点的两个输入——服务端从会话日志最后
			// 一条 `request/header` 读出的当前模型，以及服务端算出的当前峰谷状态
			// （与计价同一个判据）。旧版服务端没有这两个字段时都是 null，圆点
			// 会退到「本会话统计到的模型全是 deepseek」的保守判断（见 peakDotVisible）。
			const summaryOk = summary !== null && summary.ok === true;
			input.currentModel = summaryOk ? summary.currentModel ?? null : null;
			input.peak = summaryOk ? summary.peak ?? null : null;
			input.refreshing = refreshing;
			input.justRefreshed = justRefreshed;
			input.open = panelOpen;
			input.onToggle = togglePanel;
			input.onRefresh = refreshAll;
			input.summary = summary;
			react.useEffect(() => {
				const handle = startStatsRowObserver(anchorRef.current, () => buildMergeNode(dictRef.current, mergeInputRef.current));
				mergeRef.current = handle;
				return () => {
					mergeRef.current = null;
					handle.dispose();
				};
			}, []);
			react.useEffect(() => {
				const handle = mergeRef.current;
				if (handle !== null) handle.sync();
			}, [dict, summary, summaryError, refreshing, justRefreshed, panelOpen]);

			// The merge effect writes into the stats row; this anchor is the
			// React-visible presence marker (display:none).
			return react_jsx_runtime.jsx("div", {
				ref: anchorRef,
				className: S.anchor,
				"data-session-cost-anchor": ""
			});
		}
		//#endregion

		//#region plugin body
		/** Services required by the client plugin body. */
		const inject = ["slots", "locale", "connection", "remote"];

		/**
		 * Client plugin body: register the dictionaries and the composer-dock
		 * entry — the hidden anchor whose observer appends the 本次/今日 cost
		 * segments into the built-in stats bar, whose click-open panel carries
		 * the per-model breakdown.
		 *
		 * 本地改动（2026-09-27）：余额与低余额阈值整套已移除——它只服务于账户
		 * 余额，而本机走中转网关，那份数据永远拿不到。现在这里只剩「读会话 +
		 * 算钱」，不再依赖任何设置命名空间（也不再注入 `configForms`）。
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-cost: dictionaries");
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "session-cost",
				order: 100,
				locale: NS
			}, SessionCostMerge));
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.SessionCostMerge = SessionCostMerge;
		exports.findStatsRow = findStatsRow;
		exports.startStatsRowObserver = startStatsRowObserver;
		exports.buildMergeNode = buildMergeNode;
		exports.fmtCny = fmtCny;
		return module.exports;
	}
});
