/**
 * dsh-session-cost-daily — server half.
 *
 * Registers one loopback-only endpoint on the web server:
 *   GET /api/session-cost/summary?session=<id> — estimated cost of one LIVE
 *       session: per-model token buckets (folded from the session event log
 *       with the same replace-last-sample semantics as dsh-token-meter's
 *       `tokenUsage` projection) priced against the CNY table in ./cost.js.
 *
 * The endpoints live under the `/api` prefix as exact routes, so they win
 * over the connection plugin's `/api` prefix handler; each handler applies
 * its own peer-socket loopback fence (the exact routes bypass the RPC trust
 * fence); Host is checked only as an additional defense.
 *
 * The per-session cost fold is INCREMENTAL: each session's fold state is
 * cached in memory keyed by session id, and only the events added since the
 * last fold are processed on every request, so steady-state cost stays
 * O(new events) no matter how large the session log grows.
 *
 *
 * @module dsh-session-cost
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyUsageDelta, computeCost, createCostState, DEFAULT_PRICING, peakStateOf } from "./cost.js";
import { createDayCostReader, scanSessionCost } from "./daycost.js";

/** Stable Cordis plugin name. */
const name = "session-cost";

/** Services required before this plugin activates. */
// 本地改动（2026-09-27）：settings / credentials 不能作硬依赖——0.1.7 启动时
// settings 尚未就绪，硬注入会让本插件永久 pending，连带整个 web boot 报
// "entry did not activate"（实测）。余额功能拆掉后这两个依赖也不再需要，
// 现在只剩「读会话 + 算钱」，全是本机行为。
const inject = ["webServer", "sessions"];

const SUMMARY_PATH = "/api/session-cost/summary";

/** Write a JSON response. */
function json(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-cache"
	});
	res.end(body);
}

/**
 * Loopback fence, primary on the PEER SOCKET address (not the
 * client-controllable Host header): the request must come from a loopback
 * interface. IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is normalized. The Host
 * header is kept as an additional check, never as the deciding one.
 */
function isLoopbackAddress(address) {
	if (typeof address !== "string") return false;
	const a = address.toLowerCase();
	if (a === "::1") return true;
	const ipv4 = a.startsWith("::ffff:") ? a.slice(7) : a;
	const octets = ipv4.split(".");
	return octets.length === 4 && octets[0] === "127" && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Parse a Host header without breaking bracketed or bare IPv6 literals. */
function hostNameOf(value) {
	if (typeof value !== "string") return null;
	const host = value.trim().toLowerCase();
	if (host.startsWith("[")) {
		const close = host.indexOf("]");
		if (close <= 1) return null;
		const suffix = host.slice(close + 1);
		if (suffix !== "" && !/^:\d+$/.test(suffix)) return null;
		return host.slice(1, close);
	}
	const firstColon = host.indexOf(":");
	const lastColon = host.lastIndexOf(":");
	if (firstColon !== lastColon) return host;
	if (lastColon === -1) return host.replace(/\.$/, "");
	if (!/^\d+$/.test(host.slice(lastColon + 1))) return null;
	return host.slice(0, lastColon).replace(/\.$/, "");
}

function isLoopbackHostHeader(req) {
	const hostName = hostNameOf(req.headers.host);
	return hostName === "localhost" || isLoopbackAddress(hostName);
}

/** Refuse non-loopback callers and non-GET methods before any work. */
function rejectForeignCaller(req, res) {
	if (req.method !== "GET") {
		res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ ok: false, error: "method-not-allowed" }));
		return true;
	}
	const peer = req.socket?.remoteAddress;
	if (isLoopbackAddress(peer) && isLoopbackHostHeader(req)) return false;
	json(res, 403, { ok: false, error: "forbidden" });
	return true;
}

//#region per-session cost fold
/** In-memory per-session fold states keyed by session id. */
const costStates = new Map();

/**
 * Enumerate a live session's events from an offset, across session shapes.
 *
 * Pre-0.1.2 sessions kept the whole log on the object as `.events`; DSH
 * 0.1.2+ (rc.1) live sessions expose no `.events` array — the count is
 * `session.seq` and each event is read via `session.eventAt(seq)` (0-based,
 * the same reads @deepseek-ai/dsh-token-meter uses).
 * @returns `{ count, events }` — `count` the session's total event count,
 *   `events` the events from `from` onward.
 */
function liveSessionEvents(session, from) {
	if (Array.isArray(session.events)) {
		return { count: session.events.length, events: session.events.slice(from) };
	}
	if (typeof session.seq !== "number" || typeof session.eventAt !== "function") {
		return { count: 0, events: [] };
	}
	const events = [];
	for (let seq = from; seq < session.seq; seq += 1) {
		const event = session.eventAt(seq);
		if (event !== void 0) events.push(event);
	}
	return { count: session.seq, events };
}

/**
 * Fold the events added since the last fold for one live session and return
 * the per-model cost breakdown. Sessions not in the live registry (closed,
 * or never seen by this process) produce null.
 * @param sessions - the harness "sessions" service.
 * @param sessionId - session id to compute.
 * @param pricing - pricing table.
 */
function foldSessionCost(sessions, sessionId, pricing) {
	if (sessions === void 0 || sessions === null) return null;
	let session = null;
	for (const candidate of sessions.list()) {
		if (candidate.id === sessionId) {
			session = candidate;
			break;
		}
	}
	if (session === null) return null;
	const state = costStates.get(sessionId) ?? createCostState();
	const { count, events } = liveSessionEvents(session, state.consumed ?? 0);
	if ((state.consumed ?? 0) < count) {
		applyUsageDelta(state, events);
		state.consumed = count;
	}
	costStates.set(sessionId, state);
	const cost = computeCost(state, pricing);
	// Diagnostics for the "cost is stuck at ¥0" class of report: a zero total
	// is either "no usage sample was recognized in this session's events" or
	// "samples were recognized but no pricing entry matched their model", and
	// the two look identical in the UI. `priced` is the number of models that
	// resolved a rate; `eventTypes` (only populated while nothing is priced)
	// then says whether the expected event types are even present.
	cost.diagnostics = {
		events: count,
		samples: state.models.size,
		priced: cost.models.filter((row) => row.price !== null && row.price !== void 0).length,
		models: cost.models.map((row) => row.model)
	};
	if (cost.diagnostics.priced === 0 && count > 0) {
		const types = new Map();
		for (const event of liveSessionEvents(session, 0).events) {
			const type = typeof event?.type === "string" ? event.type : "(no type)";
			types.set(type, (types.get(type) ?? 0) + 1);
		}
		cost.diagnostics.eventTypes = [...types.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 12)
			.map(([type, n]) => `${type}=${n}`);
	}
	return cost;
}
//#endregion

/**
 * 本地新增（2026-09-27）：把「非存活会话」的 summary 结果追加到一个日志文件。
 *
 * 起因：界面上一句笼统的「本次 暂不可用」把真正的原因吞了，服务端才是唯一知道
 * 真相的地方。只记这两种——正常走存活会话的请求不记，否则每 30 秒一次会把文件刷爆：
 *   disk   = 存活会话里没有它，改从磁盘日志算出来了；
 *   no-log = 磁盘上也找不到日志（最终返回 404）。
 * 日志位置：~/.dsh/session-cost-requests.log
 */
function noteSummaryRequest(logger, sessionId, outcome) {
	try {
		fs.appendFileSync(
			path.join(os.homedir(), ".dsh", "session-cost-requests.log"),
			`${new Date().toISOString()}\t${outcome}\t${sessionId}\n`
		);
	} catch (error) {
		logger?.warn?.(`session-cost: 诊断日志写入失败：${String(error)}`);
	}
}

async function handleSummary(ctx, req, res, pricing, dayCost) {
	if (rejectForeignCaller(req, res)) return;
	try {
		const url = new URL(req.url ?? "/", "http://x");
		const sessionId = url.searchParams.get("session");
		if (sessionId === null || sessionId === "") {
			json(res, 400, { ok: false, error: "missing-session", message: "?session=<id> is required" });
			return;
		}
		let result = foldSessionCost(ctx.get("sessions"), sessionId, pricing);
		if (result === null) {
			// 本地改动（2026-09-27）：不是存活会话（已经关掉，或应用刚重启、那个会话还没
			// 被打开）时不再直接 404——从磁盘日志算，否则界面上只会显示「暂不可用」。
			const fromDisk = scanSessionCost(sessionId, pricing, { logger: ctx.logger });
			if (fromDisk !== null) result = { ...fromDisk, fromDisk: true };
			noteSummaryRequest(ctx.logger, sessionId, fromDisk === null ? "no-log" : "disk");
		}
		if (result === null) {
			json(res, 404, { ok: false, error: "unknown-session", message: `session "${sessionId}" has no readable log` });
			return;
		}
		json(res, 200, {
			ok: true,
			sessionId,
			currency: "CNY",
			estimated: true,
			// 本地新增（2026-09-28）：状态栏那个小圆点的取色依据——用的是
			// 与计价完全相同的判据（工作日时段 + 周末 + 法定节假日，见
			// cost.js 的 peakStateOf），所以圆点和账单不会互相打架。
			peak: peakStateOf(Date.now()),
			// 本地新增（2026-09-27）：状态栏的「今日」读数。
			// 今天所有会话（含已关闭的）按同一份定价表算出的合计。
			today: dayCost(),
			updatedAt: Date.now(),
			...result
		});
	} catch (error) {
		ctx.logger.warn(`session-cost: summary failed: ${String(error)}`);
		json(res, 500, { ok: false, error: "internal", message: error instanceof Error ? error.message : String(error) });
	}
}

/** Lenient merge of optional plugin-config pricing over the defaults. */
function resolvePricing(rawConfig) {
	const overrides = rawConfig?.pricing;
	if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) return { ...DEFAULT_PRICING };
	const merged = { ...DEFAULT_PRICING };
	const numeric = (value, fallback) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
	const sanitize = (entry, base) => {
		const b = base ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
		return {
			input: numeric(entry.input, b.input),
			cacheRead: numeric(entry.cacheRead, b.cacheRead),
			cacheWrite: numeric(entry.cacheWrite, b.cacheWrite),
			output: numeric(entry.output, b.output)
		};
	};
	for (const [key, entry] of Object.entries(overrides)) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
		const base = merged[key];
		const baseOffpeak = base?.offpeak ?? base ?? null;
		if (entry.offpeak !== null && typeof entry.offpeak === "object" && !Array.isArray(entry.offpeak)
			&& entry.peak !== null && typeof entry.peak === "object" && !Array.isArray(entry.peak)) {
			// Per-period override: distinct 空闲/高峰 rates.
			merged[key] = {
				offpeak: sanitize(entry.offpeak, baseOffpeak),
				peak: sanitize(entry.peak, base?.peak ?? baseOffpeak)
			};
		} else {
			// Flat override: one rate applied to every period (legacy too).
			merged[key] = sanitize(entry, baseOffpeak);
		}
	}
	return merged;
}

/**
 * Plugin body: register the summary route (本会话费用 + 今日费用).
 * @param ctx - plugin context carrying webServer and sessions.
 * @param rawConfig - optional plugin config; `pricing` overrides the default table.
 */
function apply(ctx, rawConfig = {}) {
	const pricing = resolvePricing(rawConfig);
	// 本地新增（2026-09-27）：今日费用读取器（自带 30 秒缓存）。
	const dayCost = createDayCostReader(pricing, { logger: ctx.logger });
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: SUMMARY_PATH,
		handler: (req, res) => handleSummary(ctx, req, res, pricing, dayCost)
	}), "session-cost: summary route");
}

export { apply, inject, name, SUMMARY_PATH, foldSessionCost, resolvePricing };
