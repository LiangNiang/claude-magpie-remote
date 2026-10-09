// @ts-check

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { closeServer, removeTemporaryDir, runCli, sendJson, startServer } from "./helpers.mjs";

const catalog = {
	data: [
		{ id: "anthropic/claude-sonnet-4-6", display_name: "Sonnet" },
		{ id: "anthropic/claude-haiku-4-5", display_name: "Haiku" },
	],
};
const quotaData = {
	data: [
		{
			provider: "anthropic",
			name: "Claude",
			kind: "subscription",
			windows: [{ name: "5 hours", used: 31 }],
		},
	],
};

test("login snapshots settings once, keeps custom statusLine, and logout restores them", async () => {
	const configDir = await mkdtemp(path.join(os.tmpdir(), "claude-magpie-login-"));
	const { root, server } = await startServer((request, response) => {
		if (request.url === "/v1/models") sendJson(response, catalog);
		else if (request.url === "/v1/magpie/quotas") sendJson(response, quotaData);
		else {
			response.writeHead(404);
			response.end();
		}
	});
	const original = {
		model: "before-model",
		env: {
			ANTHROPIC_BASE_URL: "http://old-gateway",
			ANTHROPIC_AUTH_TOKEN: "old-token",
			ANTHROPIC_MODEL: "old-override",
			OTHER_SETTING: "kept",
		},
		statusLine: { type: "command", command: "my-status.sh", refreshInterval: 15 },
		unrelated: { nested: ["unchanged"] },
	};
	const settingsFile = path.join(configDir, "settings.json");
	try {
		await writeFile(settingsFile, `${JSON.stringify(original, null, 4)}\n`);
		const first = await runCli(configDir, [
			"login",
			root,
			"--key",
			"initial-secret",
			"--model",
			"anthropic/claude-sonnet-4-6",
		]);
		assert.equal(first.code, 0, first.stderr);
		assert.match(first.stdout, /Gateway key: \*\*\*\*cret/);
		assert.doesNotMatch(first.stdout, /initial-secret/);
		assert.match(first.stdout, /Models available: 2/);
		let updated = JSON.parse(await readFile(settingsFile, "utf8"));
		assert.equal(updated.env.ANTHROPIC_BASE_URL, root);
		assert.equal(updated.env.ANTHROPIC_AUTH_TOKEN, "initial-secret");
		assert.equal(updated.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
		assert.equal(updated.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "anthropic/claude-sonnet-4-6");
		assert.equal(updated.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "anthropic/claude-sonnet-4-6");
		assert.equal(updated.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "anthropic/claude-sonnet-4-6");
		assert.equal(updated.env.ANTHROPIC_SMALL_FAST_MODEL, "anthropic/claude-sonnet-4-6");
		assert.equal(updated.model, "anthropic/claude-sonnet-4-6");
		assert.equal(Object.hasOwn(updated.env, "ANTHROPIC_MODEL"), false);
		assert.equal(updated.env.OTHER_SETTING, "kept");
		assert.deepEqual(updated.statusLine, original.statusLine);

		const stateFile = path.join(configDir, "magpie-remote", "state.json");
		const firstState = JSON.parse(await readFile(stateFile, "utf8"));
		assert.equal(firstState.root, root);
		assert.equal(firstState.previous["env.ANTHROPIC_MODEL"], "old-override");
		assert.deepEqual(firstState.previous["statusLine"], original.statusLine);

		const second = await runCli(configDir, [
			"login",
			root,
			"--key",
			"replacement-secret",
			"--model",
			"anthropic/claude-haiku-4-5",
			"--fast-model",
			"anthropic/claude-haiku-4-5",
		]);
		assert.equal(second.code, 0, second.stderr);
		const secondState = JSON.parse(await readFile(stateFile, "utf8"));
		assert.deepEqual(secondState.previous, firstState.previous);
		updated = JSON.parse(await readFile(settingsFile, "utf8"));
		assert.equal(updated.model, "anthropic/claude-haiku-4-5");
		assert.equal(updated.env.ANTHROPIC_AUTH_TOKEN, "replacement-secret");

		const status = await runCli(configDir, ["status"]);
		assert.equal(status.code, 0, status.stderr);
		assert.match(status.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(status.stdout, /Gateway key: \*\*\*\*cret/);
		assert.doesNotMatch(status.stdout, /replacement-secret/);
		assert.match(status.stdout, /Live check: 2 models available/);

		const usage = await runCli(configDir, ["usage", "anthropic", "--json"]);
		assert.equal(usage.code, 0, usage.stderr);
		assert.equal(JSON.parse(usage.stdout)[0].provider, "anthropic");

		const logout = await runCli(configDir, ["logout"]);
		assert.equal(logout.code, 0, logout.stderr);
		assert.deepEqual(JSON.parse(await readFile(settingsFile, "utf8")), original);
	} finally {
		await closeServer(server);
		await removeTemporaryDir(configDir);
	}
});

test("login installs and removes its statusline library and rejects invalid settings JSON", async () => {
	const configDir = await mkdtemp(path.join(os.tmpdir(), "claude-magpie-status-"));
	const { root, server } = await startServer((_request, response) => sendJson(response, catalog));
	const settingsFile = path.join(configDir, "settings.json");
	try {
		const result = await runCli(configDir, [
			"login",
			root,
			"--key",
			"x",
			"--model",
			"anthropic/claude-sonnet-4-6",
		]);
		assert.equal(result.code, 0, result.stderr);
		const settings = JSON.parse(await readFile(settingsFile, "utf8"));
		assert.equal(settings.statusLine.type, "command");
		assert.match(settings.statusLine.command, /magpie-remote\/lib\/cli\.mjs/);
		assert.equal(settings.statusLine.refreshInterval, 60);
		assert.equal(await readFile(path.join(configDir, "magpie-remote", "lib", "VERSION"), "utf8"), "1.0.0\n");
		assert.ok(await readFile(path.join(configDir, "magpie-remote", "lib", "quota.mjs"), "utf8"));

		const logout = await runCli(configDir, ["logout"]);
		assert.equal(logout.code, 0, logout.stderr);
		assert.deepEqual(JSON.parse(await readFile(settingsFile, "utf8")), {});
		await assert.rejects(readFile(path.join(configDir, "magpie-remote", "lib", "cli.mjs")));

		const invalid = "{ settings are not JSON";
		await writeFile(settingsFile, invalid);
		const failed = await runCli(configDir, [
			"login",
			root,
			"--key",
			"x",
			"--model",
			"anthropic/claude-sonnet-4-6",
		]);
		assert.equal(failed.code, 1);
		assert.match(failed.stderr, /invalid JSON/);
		assert.equal(await readFile(settingsFile, "utf8"), invalid);
	} finally {
		await closeServer(server);
		await removeTemporaryDir(configDir);
	}
});

test("usage errors can be returned successfully for dynamic command injection", async () => {
	const configDir = await mkdtemp(path.join(os.tmpdir(), "claude-magpie-usage-"));
	try {
		const result = await runCli(configDir, ["usage", "--no-fail"]);
		assert.equal(result.code, 0);
		assert.match(result.stdout, /Error: not connected to a remote Magpie gateway/);
		assert.equal(result.stderr, "");
	} finally {
		await removeTemporaryDir(configDir);
	}
});

test("sync quietly refreshes an outdated copied library only after login", async () => {
	const configDir = await mkdtemp(path.join(os.tmpdir(), "claude-magpie-sync-"));
	const { root, server } = await startServer((_request, response) => sendJson(response, catalog));
	try {
		const beforeLogin = await runCli(configDir, ["sync", "--quiet"]);
		assert.equal(beforeLogin.code, 0);
		assert.equal(beforeLogin.stdout, "");
		assert.equal(beforeLogin.stderr, "");

		const login = await runCli(configDir, [
			"login",
			root,
			"--key",
			"x",
			"--model",
			"anthropic/claude-sonnet-4-6",
		]);
		assert.equal(login.code, 0, login.stderr);
		const libDir = path.join(configDir, "magpie-remote", "lib");
		await writeFile(path.join(libDir, "cli.mjs"), "outdated");
		await writeFile(path.join(libDir, "VERSION"), "0.0.0\n");

		const sync = await runCli(configDir, ["sync", "--quiet"]);
		assert.equal(sync.code, 0, sync.stderr);
		assert.equal(sync.stdout, "");
		assert.equal(sync.stderr, "");
		assert.notEqual(await readFile(path.join(libDir, "cli.mjs"), "utf8"), "outdated");
		assert.equal(await readFile(path.join(libDir, "VERSION"), "utf8"), await readFile(path.resolve("VERSION"), "utf8"));
	} finally {
		await closeServer(server);
		await removeTemporaryDir(configDir);
	}
});
