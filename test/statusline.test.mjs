// @ts-check

import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { renderStatusLine } from "../src/statusline.mjs";
import { getConfigPaths } from "../src/settings.mjs";
import {
	closeServer,
	removeTemporaryDir,
	runCli,
	sendJson,
	startServer,
	temporaryConfigDir,
} from "./helpers.mjs";

const input = JSON.stringify({ model: { id: "codex/gpt-5.5[fast]" } });

/** @param {string} configDir @param {string} root */
async function writeConnection(configDir, root) {
	await writeFile(
		path.join(configDir, "settings.json"),
		`${JSON.stringify({ env: { ANTHROPIC_BASE_URL: root, ANTHROPIC_AUTH_TOKEN: "status-key" } }, null, 2)}\n`,
	);
}

test("selects model-provider quota, colors thresholds, and caches quota fetches", async () => {
	const configDir = await temporaryConfigDir();
	let used = 74;
	let requests = 0;
	const { root, server } = await startServer((request, response) => {
		if (request.url !== "/v1/magpie/quotas") {
			response.writeHead(404);
			response.end();
			return;
		}
		requests++;
		sendJson(response, {
			data: [
				{ provider: "anthropic", kind: "subscription", windows: [{ name: "5 hours", used: 99 }] },
				{
					provider: "codex",
					kind: "subscription",
					user: "old",
					windows: [{ name: "5 hours", used: 20 }],
				},
				{
					provider: "codex",
					kind: "subscription",
					user: "last",
					last: true,
					windows: [{ name: "5 hours", used }],
				},
			],
		});
	});
	const previousConfig = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = configDir;
	try {
		await writeConnection(configDir, root);
		let rendered = await renderStatusLine(input);
		assert.match(rendered, /\x1b\[2m/);
		assert.match(rendered, /codex 5h 74% \+1/);
		assert.doesNotMatch(rendered, /anthropic/);
		assert.equal(requests, 1);

		used = 99;
		rendered = await renderStatusLine(input);
		assert.match(rendered, /codex 5h 74% \+1/);
		assert.equal(requests, 1, "fresh cache should avoid another request");

		const cacheFile = getConfigPaths().cacheFile;
		await rm(cacheFile, { force: true });
		used = 75;
		rendered = await renderStatusLine(input);
		assert.match(rendered, /\x1b\[33m/);
		assert.match(rendered, /codex 5h 75% \+1/);

		await rm(cacheFile, { force: true });
		used = 90;
		rendered = await renderStatusLine(input);
		assert.match(rendered, /\x1b\[31m/);
		assert.match(rendered, /codex 5h 90% \+1/);
	} finally {
		if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = previousConfig;
		await closeServer(server);
		await removeTemporaryDir(configDir);
	}
});

test("uses stale same-root cache when the gateway is unreachable", async () => {
	const configDir = await temporaryConfigDir();
	const { root, server } = await startServer((_request, response) => {
		sendJson(response, { data: [] });
	});
	const previousConfig = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = configDir;
	try {
		await writeConnection(configDir, root);
		await mkdir(getConfigPaths().pluginDir, { recursive: true });
		await writeFile(
			getConfigPaths().cacheFile,
			`${JSON.stringify({
				root,
				at: 0,
				quotas: [{ provider: "codex", kind: "subscription", name: "Codex", windows: [{ name: "Daily", used: 42 }] }],
			})}\n`,
		);
		await closeServer(server);
		const rendered = await renderStatusLine(input);
		assert.match(rendered, /codex 1d 42%/);
		assert.match(rendered, /\x1b\[2m/);
	} finally {
		if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = previousConfig;
		await removeTemporaryDir(configDir);
	}
});

test("unreachable statusline exits successfully with empty output", async () => {
	const configDir = await temporaryConfigDir();
	const { root, server } = await startServer((_request, response) => {
		response.writeHead(500);
		response.end();
	});
	try {
		await writeConnection(configDir, root);
		await closeServer(server);
		const result = await runCli(configDir, ["statusline"], input);
		assert.equal(result.code, 0);
		assert.equal(result.stdout, "");
		assert.equal(result.stderr, "");
	} finally {
		await removeTemporaryDir(configDir);
	}
});
