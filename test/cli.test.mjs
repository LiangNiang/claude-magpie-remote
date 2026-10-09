// @ts-check

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { closeServer, removeTemporaryDir, runCli, sendJson, startServer } from "./helpers.mjs";

const catalog = {
	data: [
		{ id: "anthropic/claude-sonnet-4-6", display_name: "Sonnet", magpie_label: "Magpie Sonnet" },
		{ id: "anthropic/claude-haiku-4-5", display_name: "Haiku" },
		{ id: "codex/gpt-5.5" },
		{ id: "images/flux", kind: "image" },
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
	const claudeProfileFile = path.join(configDir, ".claude.json");
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
		assert.match(first.stdout, /Models available: 3/);
		let updated = JSON.parse(await readFile(settingsFile, "utf8"));
		assert.equal(updated.env.ANTHROPIC_BASE_URL, root);
		assert.equal(updated.env.ANTHROPIC_AUTH_TOKEN, "initial-secret");
		assert.equal(Object.prototype.hasOwnProperty.call(updated.env, "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"), false);
		assert.equal(updated.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "anthropic/claude-sonnet-4-6");
		assert.equal(updated.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "anthropic/claude-sonnet-4-6");
		assert.equal(updated.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "anthropic/claude-sonnet-4-6");
		assert.equal(updated.env.ANTHROPIC_SMALL_FAST_MODEL, "anthropic/claude-sonnet-4-6");
		assert.equal(updated.model, "anthropic/claude-sonnet-4-6");
		assert.equal(Object.prototype.hasOwnProperty.call(updated.env, "ANTHROPIC_MODEL"), false);
		assert.equal(updated.env.OTHER_SETTING, "kept");
		assert.deepEqual(updated.modelPicker, {
			options: [
				{
					model: "anthropic/claude-sonnet-4-6",
					label: "Magpie Sonnet",
					description: "Magpie · anthropic/claude-sonnet-4-6",
				},
				{
					model: "anthropic/claude-haiku-4-5",
					label: "Haiku",
					description: "Magpie · anthropic/claude-haiku-4-5",
				},
				{
					model: "codex/gpt-5.5",
					label: "codex/gpt-5.5",
					description: "Magpie · codex/gpt-5.5",
				},
			],
			replaceBuiltInOptions: true,
		});
		assert.deepEqual(updated.statusLine, original.statusLine);

		const stateFile = path.join(configDir, "magpie-remote", "state.json");
		const firstState = JSON.parse(await readFile(stateFile, "utf8"));
		assert.equal(firstState.root, root);
		assert.equal(firstState.picker, true);
		assert.equal(firstState.onboarding, null);
		assert.equal(firstState.previous["env.ANTHROPIC_MODEL"], "old-override");
		assert.equal(firstState.previous.modelPicker, null);
		assert.deepEqual(firstState.previous["statusLine"], original.statusLine);
		assert.deepEqual(JSON.parse(await readFile(claudeProfileFile, "utf8")), {
			hasCompletedOnboarding: true,
		});

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
		assert.equal(secondState.onboarding, null);
		updated = JSON.parse(await readFile(settingsFile, "utf8"));
		assert.equal(updated.model, "anthropic/claude-haiku-4-5");
		assert.equal(updated.env.ANTHROPIC_AUTH_TOKEN, "replacement-secret");

		const status = await runCli(configDir, ["status"]);
		assert.equal(status.code, 0, status.stderr);
		assert.match(status.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(status.stdout, /Gateway key: \*\*\*\*cret/);
		assert.doesNotMatch(status.stdout, /replacement-secret/);
		assert.match(status.stdout, /Live check: 3 models available/);

		const usage = await runCli(configDir, ["usage", "anthropic", "--json"]);
		assert.equal(usage.code, 0, usage.stderr);
		assert.equal(JSON.parse(usage.stdout)[0].provider, "anthropic");

		const logout = await runCli(configDir, ["logout"]);
		assert.equal(logout.code, 0, logout.stderr);
		assert.deepEqual(JSON.parse(await readFile(settingsFile, "utf8")), original);
		assert.deepEqual(JSON.parse(await readFile(claudeProfileFile, "utf8")), {});
	} finally {
		await closeServer(server);
		await removeTemporaryDir(configDir);
	}
});

test("login merges Claude profile data and logout restores the original false onboarding value", async () => {
	const configDir = await mkdtemp(path.join(os.tmpdir(), "claude-magpie-onboarding-"));
	const { root, server } = await startServer((_request, response) => sendJson(response, catalog));
	const profileFile = path.join(configDir, ".claude.json");
	const originalProfile = {
		hasCompletedOnboarding: false,
		oauthAccount: { accountUuid: "preserved-account" },
		numStartups: 12,
	};
	try {
		await writeFile(profileFile, `${JSON.stringify(originalProfile, null, 4)}\n`);
		const loginArgs = [
			"login",
			root,
			"--key",
			"x",
			"--model",
			"anthropic/claude-sonnet-4-6",
		];
		const login = await runCli(configDir, loginArgs);
		assert.equal(login.code, 0, login.stderr);
		const completedProfile = {
			...originalProfile,
			hasCompletedOnboarding: true,
		};
		assert.deepEqual(JSON.parse(await readFile(profileFile, "utf8")), completedProfile);
		assert.equal(await readFile(profileFile, "utf8"), `${JSON.stringify(completedProfile, null, 2)}\n`);
		const stateFile = path.join(configDir, "magpie-remote", "state.json");
		assert.equal(JSON.parse(await readFile(stateFile, "utf8")).onboarding, false);

		const relogin = await runCli(configDir, loginArgs);
		assert.equal(relogin.code, 0, relogin.stderr);
		assert.equal(JSON.parse(await readFile(stateFile, "utf8")).onboarding, false);

		const logout = await runCli(configDir, ["logout"]);
		assert.equal(logout.code, 0, logout.stderr);
		assert.deepEqual(JSON.parse(await readFile(profileFile, "utf8")), originalProfile);
	} finally {
		await closeServer(server);
		await removeTemporaryDir(configDir);
	}
});

test("login uses HOME/.claude.json when CLAUDE_CONFIG_DIR is unset", async () => {
	const homeDir = await mkdtemp(path.join(os.tmpdir(), "claude-magpie-home-"));
	const { root, server } = await startServer((_request, response) => sendJson(response, catalog));
	const profileFile = path.join(homeDir, ".claude.json");
	try {
		const login = await runCli(
			"",
			["login", root, "--key", "x", "--model", "anthropic/claude-sonnet-4-6"],
			"",
			{ HOME: homeDir },
		);
		assert.equal(login.code, 0, login.stderr);
		assert.deepEqual(JSON.parse(await readFile(profileFile, "utf8")), {
			hasCompletedOnboarding: true,
		});
		assert.ok(await readFile(path.join(homeDir, ".claude", "settings.json"), "utf8"));

		const logout = await runCli("", ["logout"], "", { HOME: homeDir });
		assert.equal(logout.code, 0, logout.stderr);
		assert.deepEqual(JSON.parse(await readFile(profileFile, "utf8")), {});
	} finally {
		await closeServer(server);
		await removeTemporaryDir(homeDir);
	}
});

test("logout preserves a later change to Claude onboarding state", async () => {
	const configDir = await mkdtemp(path.join(os.tmpdir(), "claude-magpie-onboarding-change-"));
	const { root, server } = await startServer((_request, response) => sendJson(response, catalog));
	const profileFile = path.join(configDir, ".claude.json");
	try {
		const login = await runCli(configDir, [
			"login",
			root,
			"--key",
			"x",
			"--model",
			"anthropic/claude-sonnet-4-6",
		]);
		assert.equal(login.code, 0, login.stderr);
		await writeFile(profileFile, `${JSON.stringify({
			hasCompletedOnboarding: "changed-by-user",
			userData: true,
		}, null, 2)}\n`);

		const logout = await runCli(configDir, ["logout"]);
		assert.equal(logout.code, 0, logout.stderr);
		assert.deepEqual(JSON.parse(await readFile(profileFile, "utf8")), {
			hasCompletedOnboarding: "changed-by-user",
			userData: true,
		});
	} finally {
		await closeServer(server);
		await removeTemporaryDir(configDir);
	}
});

test("login leaves invalid Claude profile JSON untouched and continues with a warning", async () => {
	const configDir = await mkdtemp(path.join(os.tmpdir(), "claude-magpie-invalid-profile-"));
	const { root, server } = await startServer((_request, response) => sendJson(response, catalog));
	const profileFile = path.join(configDir, ".claude.json");
	try {
		for (const invalid of ["{ not valid JSON", "[]"]) {
			await writeFile(profileFile, invalid);
			const login = await runCli(configDir, [
				"login",
				root,
				"--key",
				"x",
				"--model",
				"anthropic/claude-sonnet-4-6",
			]);
			assert.equal(login.code, 0, login.stderr);
			assert.equal(await readFile(profileFile, "utf8"), invalid);
			assert.match(login.stderr, /Warning: Claude Code global config is not a valid JSON object/);
			assert.equal(login.stderr.trim().split(/\r?\n/).length, 1);
		}
		const state = JSON.parse(await readFile(path.join(configDir, "magpie-remote", "state.json"), "utf8"));
		assert.equal(Object.prototype.hasOwnProperty.call(state, "onboarding"), false);
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
		assert.equal(await readFile(path.join(configDir, "magpie-remote", "lib", "VERSION"), "utf8"), "1.0.1\n");
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
	let currentCatalog = catalog;
	const { root, server } = await startServer((request, response) => {
		if (request.url === "/v1/models") sendJson(response, currentCatalog);
		else {
			response.writeHead(404);
			response.end();
		}
	});
	let serverClosed = false;
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
		const settingsFile = path.join(configDir, "settings.json");
		const legacySettings = JSON.parse(await readFile(settingsFile, "utf8"));
		assert.equal(legacySettings.modelPicker.replaceBuiltInOptions, true);
		delete legacySettings.modelPicker.replaceBuiltInOptions;
		await writeFile(settingsFile, `${JSON.stringify(legacySettings, null, 2)}\n`);
		const libDir = path.join(configDir, "magpie-remote", "lib");
		await writeFile(path.join(libDir, "cli.mjs"), "outdated");
		await writeFile(path.join(libDir, "VERSION"), "0.0.0\n");

		const sync = await runCli(configDir, ["sync", "--quiet"]);
		assert.equal(sync.code, 0, sync.stderr);
		assert.equal(sync.stdout, "");
		assert.equal(sync.stderr, "");
		assert.notEqual(await readFile(path.join(libDir, "cli.mjs"), "utf8"), "outdated");
		assert.equal(await readFile(path.join(libDir, "VERSION"), "utf8"), await readFile(path.resolve("VERSION"), "utf8"));
		assert.equal(JSON.parse(await readFile(settingsFile, "utf8")).modelPicker.replaceBuiltInOptions, true);
		currentCatalog = {
			data: [
				...catalog.data,
				{ id: "zcode/glm-5.1", display_name: "GLM 5.1", magpie_label: "GLM 5.1" },
			],
		};
		await runCli(configDir, ["sync", "--quiet"]);
		const refreshed = JSON.parse(await readFile(settingsFile, "utf8"));
		/** @type {Array<{ model: string, label: string, description: string }>} */
		const refreshedRows = refreshed.modelPicker.options;
		assert.equal(refreshed.modelPicker.replaceBuiltInOptions, true);
		assert.deepEqual(
			refreshedRows.map(({ model }) => model),
			["anthropic/claude-sonnet-4-6", "anthropic/claude-haiku-4-5", "codex/gpt-5.5", "zcode/glm-5.1"],
		);
		assert.deepEqual(refreshedRows[refreshedRows.length - 1], {
			model: "zcode/glm-5.1",
			label: "GLM 5.1",
			description: "Magpie · zcode/glm-5.1",
		});

		await closeServer(server);
		serverClosed = true;
		const afterOutage = JSON.parse(await readFile(settingsFile, "utf8"));
		const down = await runCli(configDir, ["sync", "--quiet"]);
		assert.equal(down.code, 0, down.stderr);
		assert.equal(down.stdout, "");
		assert.equal(down.stderr, "");
		assert.deepEqual(JSON.parse(await readFile(settingsFile, "utf8")).modelPicker, afterOutage.modelPicker);
	} finally {
		if (!serverClosed) await closeServer(server);
		await removeTemporaryDir(configDir);
	}
});

test("preserves and restores a user-owned modelPicker", async () => {
	const configDir = await mkdtemp(path.join(os.tmpdir(), "claude-magpie-picker-owner-"));
	let catalogRequests = 0;
	const { root, server } = await startServer((request, response) => {
		if (request.url === "/v1/models") catalogRequests++;
		sendJson(response, catalog);
	});
	const originalPicker = {
		options: [{ model: "my-custom-model", label: "My custom model" }],
		replaceBuiltInOptions: true,
	};
	const original = {
		modelPicker: originalPicker,
		unrelated: "preserved",
	};
	const settingsFile = path.join(configDir, "settings.json");
	let serverClosed = false;
	try {
		await writeFile(settingsFile, `${JSON.stringify(original, null, 2)}\n`);
		const login = await runCli(configDir, [
			"login",
			root,
			"--key",
			"x",
			"--model",
			"anthropic/claude-sonnet-4-6",
		]);
		assert.equal(login.code, 0, login.stderr);
		assert.match(login.stdout, /modelPicker was left unchanged/);
		assert.deepEqual(JSON.parse(await readFile(settingsFile, "utf8")).modelPicker, originalPicker);
		const state = JSON.parse(await readFile(path.join(configDir, "magpie-remote", "state.json"), "utf8"));
		assert.equal(state.picker, false);
		assert.deepEqual(state.previous.modelPicker, originalPicker);

		await closeServer(server);
		serverClosed = true;
		const sync = await runCli(configDir, ["sync", "--quiet"]);
		assert.equal(sync.code, 0, sync.stderr);
		assert.equal(sync.stdout, "");
		assert.equal(sync.stderr, "");
		assert.deepEqual(JSON.parse(await readFile(settingsFile, "utf8")).modelPicker, originalPicker);
		assert.equal(catalogRequests, 1, "sync must not fetch when the picker is not plugin-owned");

		const logout = await runCli(configDir, ["logout"]);
		assert.equal(logout.code, 0, logout.stderr);
		assert.deepEqual(JSON.parse(await readFile(settingsFile, "utf8")), original);
	} finally {
		if (!serverClosed) await closeServer(server);
		await removeTemporaryDir(configDir);
	}
});
