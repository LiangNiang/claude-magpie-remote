// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {
	fetchMagpieQuotas,
	formatQuotaReport,
	formatQuotaStatus,
	mostUsed,
	parseMagpieQuotas,
	quotasForModel,
	resetClock,
	shortWindowName,
} from "../src/quota.mjs";
import { closeServer, sendJson, startServer } from "./helpers.mjs";

const sample = {
	object: "list",
	data: [
		{
			provider: "codex",
			name: "Codex",
			kind: "subscription",
			plan: "Plus",
			user: "a@example.com",
			windows: [
				{ name: "5 hours", used: 32.4, remaining: 67.6, resetsAt: "2026-10-08T14:30:00+08:00" },
				{ name: "7 days", used: 71, remaining: 29 },
			],
			resets: { count: 2 },
		},
		{
			provider: "codex",
			name: "Codex",
			kind: "subscription",
			user: "b@example.com",
			windows: [{ name: "5 hours", used: 5, remaining: 95 }],
			last: true,
		},
		{ provider: "deepseek", name: "DeepSeek", kind: "balance", windows: [], balance: "¥12.50" },
		{ provider: "kimi", name: "Kimi", kind: "balance", windows: [], error: "HTTP 401" },
		{ name: "no provider" },
	],
};

test("parses quota data and drops entries without a provider", () => {
	const quotas = parseMagpieQuotas(sample);
	assert.equal(quotas.length, 4);
	assert.equal(quotas[0].windows[0].used, 32.4);
	assert.equal(quotas[0].resets?.count, 2);
	assert.equal(quotas[2].balance, "¥12.50");
	assert.throws(() => parseMagpieQuotas({ data: null }), /invalid quota list/);
});

test("fetches quota reports with the gateway key and explains authorization failures", async () => {
	const { root, server } = await startServer((request, response) => {
		assert.equal(request.url, "/v1/magpie/quotas");
		assert.equal(request.headers.authorization, "Bearer gk-1");
		sendJson(response, sample);
	});
	try {
		assert.equal((await fetchMagpieQuotas(root, "gk-1")).length, 4);
	} finally {
		await closeServer(server);
	}

	const denied = await startServer((_request, response) => {
		response.writeHead(403);
		response.end();
	});
	try {
		await assert.rejects(fetchMagpieQuotas(denied.root, "bad"), /gateway key rejected/);
	} finally {
		await closeServer(denied.server);
	}
});

test("selects the last-served account for a model provider", () => {
	const quotas = parseMagpieQuotas(sample);
	assert.deepEqual(
		quotasForModel(quotas, "codex/gpt-5.5").map((quota) => quota.user),
		["b@example.com", "a@example.com"],
	);
	assert.equal(quotasForModel(quotas, "DeepSeek/deepseek-chat")[0].balance, "¥12.50");
	assert.deepEqual(quotasForModel(quotas, "my-group"), []);
});

test("formats concise quota status and chooses the highest limited window", () => {
	const [codex, , deepseek, kimi] = parseMagpieQuotas(sample);
	assert.equal(formatQuotaStatus(codex), "codex 5h 32% · 7d 71%");
	assert.equal(formatQuotaStatus(deepseek), "deepseek ¥12.50");
	assert.equal(formatQuotaStatus(kimi), "kimi unavailable");
	assert.equal(mostUsed(codex), 71);
	assert.equal(mostUsed(deepseek), undefined);
	assert.equal(shortWindowName("Monthly"), "1mo");
	assert.equal(shortWindowName("Weekly"), "1w");
	assert.equal(shortWindowName("GLM-5.3-Trial"), "GLM-5.3-Trial");
	assert.equal(shortWindowName("1 week"), "1w");

	const base = { provider: "zcode", name: "Z", kind: "subscription" };
	assert.equal(
		formatQuotaStatus({
			...base,
			windows: [
				{ name: "5 hours", used: 28 },
				{ name: "Weekly", used: 38 },
				{ name: "GLM-Trial", used: 0 },
			],
		}),
		"zcode 5h 28% · 1w 38%",
	);
	assert.equal(
		formatQuotaStatus({
			...base,
			windows: [
				{ name: "5 hours", used: 10 },
				{ name: "Weekly", used: 20 },
				{ name: "GLM-Trial", used: 95 },
			],
		}),
		"zcode 5h 10% · GLM-Trial 95%",
	);
	assert.equal(formatQuotaStatus({ ...base, plan: "Free", windows: [] }), "zcode Free");
	assert.equal(formatQuotaStatus({ ...base, windows: [] }), "zcode —");
});

test("formats reset clocks and the full quota report", () => {
	const now = new Date(2026, 9, 8, 10, 0);
	assert.equal(resetClock(new Date(2026, 9, 8, 14, 30), now), "14:30");
	assert.equal(resetClock(new Date(2026, 9, 9, 9, 5), now), "tomorrow 09:05");
	assert.equal(resetClock(new Date(2026, 9, 10, 9, 5), now), "Sat 09:05");
	assert.equal(resetClock(new Date(2026, 10, 3, 9, 5), now), "Nov 3 09:05");
	const report = formatQuotaReport(parseMagpieQuotas(sample), now);
	const lines = report.split("\n");
	assert.equal(lines.length, 5);
	assert.match(lines[0], /^codex · Plus · a@example\.com {2}subscription {2}5 hours 32% ↻ \S+ {2}7 days 71% {2}↺ 2 resets$/);
	assert.match(lines[2], /^deepseek\s+balance\s+¥12\.50 left$/);
	assert.match(lines[3], /HTTP 401$/);
	assert.match(formatQuotaReport([]), /no subscription/);
});
