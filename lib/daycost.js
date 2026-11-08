/**
 * dsh-session-cost-daily — 当天（跨会话）的费用估算。
 *
 * 本地新增文件（2026-09-27）：状态栏除「本次」外再显示一个「今日」。
 * 上游包里没有这个文件，升级插件后会丢失，需要重做（与 client.js、index.js
 * 里那两处本地改动同性质）。
 *
 * 为什么读磁盘而不是问会话服务：harness 的 `sessions` 服务只列当前进程里
 * 活着的会话，今天早些时候关掉的会话不在里面，而「今天花了多少」必须把它们
 * 算上。会话日志本身是持久的，位置与 DSH 自己的持久化布局一致：
 *   $DSH_HOME/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd
 *
 * 为什么逐帧解压：DSH 每追加一次就写一个独立的 zstd 帧，直接对整个文件做
 * `zstdDecompressSync` 只解出第一帧——2MB 的日志只解成 215 字节的 session
 * 头（2026-09-27 实测）。所以按帧推进，用 `engine.bytesWritten` 得到每帧
 * 占用的压缩字节数，从下一帧继续。
 *
 * 本机实测（2026-09-27，今天 16 个会话 / 4211 帧 / 8516 行）：一轮全量扫描
 * 约 200ms，所以缓存 30 秒即可，不必做增量。
 *
 * @module dsh-session-cost/daycost
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { foldCost } from "./cost.js";

/** 扫描一轮约 200ms，状态栏 30 秒取一次，缓存同样取 30 秒。 */
export const DAY_COST_TTL_MS = 30 * 1000;

/** 会话日志根目录。`DSH_HOME` 未导出时退回 `~/.dsh`（DSH 的默认位置）。 */
export function sessionsRoot() {
	const home = typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.length > 0
		? process.env.DSH_HOME
		: path.join(os.homedir(), ".dsh");
	return path.join(home, "sessions");
}

/**
 * 递归收集会话日志文件。
 * 目录不存在（全新安装还没有会话）返回空列表；其它读取错误抛出，交给调用方
 * 决定是记日志还是失败——不在这里悄悄吞掉。
 */
export function listSessionLogs(root) {
	const found = [];
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop();
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (error) {
			if (error?.code === "ENOENT") continue;
			throw error;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.isFile() && entry.name.endsWith(".zstd")) found.push(full);
		}
	}
	return found;
}

/**
 * 逐帧读出一个会话日志的全部内容。
 * 遇到坏帧时返回已经解出的部分，并把原因带出去（调用方记日志），不假装成功。
 * @returns `{ text, truncated, reason }`
 */
export function readSessionLog(file) {
	const buffer = fs.readFileSync(file);
	const parts = [];
	let offset = 0;
	while (offset < buffer.length) {
		let frame;
		try {
			frame = zlib.zstdDecompressSync(buffer.subarray(offset), { info: true });
		} catch (error) {
			return {
				text: Buffer.concat(parts).toString("utf8"),
				truncated: true,
				reason: error?.message ?? String(error)
			};
		}
		parts.push(frame.buffer);
		const consumed = frame.engine?.bytesWritten ?? 0;
		if (consumed <= 0) {
			return { text: Buffer.concat(parts).toString("utf8"), truncated: true, reason: "解压帧没有推进" };
		}
		offset += consumed;
	}
	return { text: Buffer.concat(parts).toString("utf8"), truncated: false, reason: null };
}

/**
 * 一行一个事件。坏行跳过但计数：调用方据此判断「今天没有用量」和
 * 「日志读坏了」——两者在状态栏上长得一样，只有这个计数能区分。
 * @returns `{ events, badLines }`
 */
export function parseEvents(text) {
	const events = [];
	let badLines = 0;
	for (const line of text.split("\n")) {
		if (line === "") continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			badLines += 1;
		}
	}
	return { events, badLines };
}

/**
 * 当天的费用估算：把今天（本机时区）的用量样本从所有会话日志里取出来，
 * 用与「本次」相同的定价表算钱后相加。按事件自带的时间戳切当天，所以跨天的
 * 长会话只会把它今天那部分算进来。
 * @param pricing - 已解析的定价表。
 * @param options - `{ since?, logger? }`；`since` 默认今天 00:00（本机时区）。
 * @returns `{ ok: true, cost, tokens, sessions, badLines, failed, since, scannedAt }`
 *   或 `{ ok: false, error, message }`。
 */
export function scanDayCost(pricing, options = {}) {
	const logger = options.logger;
	const dayStart = new Date();
	dayStart.setHours(0, 0, 0, 0);
	const since = typeof options.since === "number" ? options.since : dayStart.getTime();

	let files;
	try {
		files = listSessionLogs(sessionsRoot());
	} catch (error) {
		logger?.warn?.(`session-cost: 会话目录读取失败：${String(error)}`);
		return { ok: false, error: "session-dir", message: error instanceof Error ? error.message : String(error) };
	}

	let cost = 0;
	const modelTotals = new Map();
	let tokens = 0;
	let sessions = 0;
	let badLines = 0;
	let failed = 0;

	for (const file of files) {
		let stat;
		try {
			stat = fs.statSync(file);
		} catch (error) {
			failed += 1;
			logger?.warn?.(`session-cost: 会话日志无法访问（${file}）：${String(error)}`);
			continue;
		}
		// 今天没写过的文件不可能含今天的样本：这一步把上百个文件砍到十几个。
		if (stat.mtimeMs < since) continue;
		try {
			const { text, truncated, reason } = readSessionLog(file);
			const label = path.basename(path.dirname(file));
			if (truncated) logger?.warn?.(`session-cost: 日志只解出部分内容（${label}）：${reason}`);
			const parsed = parseEvents(text);
			badLines += parsed.badLines;
			if (parsed.badLines > 0) logger?.warn?.(`session-cost: 日志有 ${parsed.badLines} 行无法解析（${label}）`);
			const events = parsed.events.filter((event) => typeof event?.time === "number" && event.time >= since);
			if (events.length === 0) continue;
			const folded = foldCost(events, pricing);
			cost += folded.cost;
			tokens += folded.tokens.tokens;
			sessions += 1;

			// 按模型汇总：明细面板里「今日」下面每个模型一行，用的就是这个。
			for (const row of folded.models) {
				const acc = modelTotals.get(row.model);
				if (acc === void 0) {
					modelTotals.set(row.model, { ...row });
					continue;
				}
				// 数值字段逐个累加（tokens/cost 以及峰谷分项），price 是费率对象不能加。
				for (const [key, value] of Object.entries(row)) {
					if (typeof value === "number" && key !== "price" && typeof acc[key] === "number") acc[key] += value;
				}
			}
		} catch (error) {
			failed += 1;
			logger?.warn?.(`session-cost: 会话日志读取失败（${path.basename(file)}）：${String(error)}`);
		}
	}

	const models = [...modelTotals.values()].sort((a, b) => b.cost - a.cost);
	return { ok: true, cost, tokens, sessions, models, badLines, failed, since, scannedAt: Date.now() };
}

/**
 * 带 TTL 缓存的当天费用读取器。
 * @param pricing - 定价表。
 * @param options - `{ logger?, ttlMs?, now? }`。
 * @returns 无参函数，返回 {@link scanDayCost} 的结果。
 */
export function createDayCostReader(pricing, options = {}) {
	const ttl = typeof options.ttlMs === "number" ? options.ttlMs : DAY_COST_TTL_MS;
	const clock = typeof options.now === "function" ? options.now : Date.now;
	let cache = null;
	return function dayCost() {
		if (cache !== null && clock() - cache.at < ttl) return cache.value;
		const value = scanDayCost(pricing, options);
		cache = { at: clock(), value };
		return value;
	};
}


/** 磁盘会话费用的短期缓存：同一个历史会话被反复请求时不必反复解压。 */
const diskCostCache = new Map();

/**
 * 从磁盘读某一个会话的费用——**不要求它处于存活状态**。
 *
 * 为什么需要：`sessions` 服务只列当前进程活着的会话。用户点开一个已经关掉的会话
 * （或应用刚重启、那个会话还没被打开）时，上游那条路径会返回 404，界面显示
 * 「暂不可用」。日志本身是持久的，用同一份定价表算出来即可。
 * @param sessionId - 会话 id（与日志目录名一致）。
 * @param pricing - 已解析的定价表。
 * @param options - `{ logger? }`。
 * @returns 与 `foldCost` 同形（tokens / models / cost）外加 `events`；找不到日志时 null。
 */
export function scanSessionCost(sessionId, pricing, options = {}) {
	const logger = options.logger;
	if (typeof sessionId !== "string" || sessionId === "") return null;
	let file;
	try {
		file = listSessionLogs(sessionsRoot()).find((candidate) => path.basename(path.dirname(candidate)) === sessionId);
	} catch (error) {
		logger?.warn?.(`session-cost: 查找会话日志失败（${sessionId}）：${String(error)}`);
		return null;
	}
	if (file === void 0) return null;
	let stat;
	try {
		stat = fs.statSync(file);
	} catch (error) {
		logger?.warn?.(`session-cost: 会话日志无法访问（${file}）：${String(error)}`);
		return null;
	}
	const cached = diskCostCache.get(sessionId);
	if (cached !== void 0 && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value;
	const { text, truncated, reason } = readSessionLog(file);
	if (truncated) logger?.warn?.(`session-cost: 日志只解出部分内容（${sessionId}）：${reason}`);
	const parsed = parseEvents(text);
	if (parsed.badLines > 0) logger?.warn?.(`session-cost: 日志有 ${parsed.badLines} 行无法解析（${sessionId}）`);
	const folded = foldCost(parsed.events, pricing);
	const value = { ...folded, events: parsed.events.length };
	diskCostCache.set(sessionId, { mtimeMs: stat.mtimeMs, size: stat.size, value });
	return value;
}
