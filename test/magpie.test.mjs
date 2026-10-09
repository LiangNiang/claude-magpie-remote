// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import { fetchMagpieCatalog, normalizeMagpieUrl } from "../src/magpie.mjs";
import { closeServer, sendJson, startServer } from "./helpers.mjs";

test("normalizes Magpie URL suffixes", () => {
	assert.equal(normalizeMagpieUrl(" 192.168.1.20:3425 "), "http://192.168.1.20:3425");
	assert.equal(normalizeMagpieUrl("http://h:3425/v1/"), "http://h:3425");
	assert.equal(normalizeMagpieUrl("https://m.example.com/v1/messages"), "https://m.example.com");
	assert.equal(normalizeMagpieUrl("http://h:3425/v1/chat/completions"), "http://h:3425");
	assert.equal(normalizeMagpieUrl("https://h:3425/v1/responses"), "https://h:3425");
	assert.throws(() => normalizeMagpieUrl("  "), /Remote magpie address is required/);
});

test("fetches chat models and filters non-empty kind entries", async () => {
	/** @type {string[]} */
	const seen = [];
	const { root, server } = await startServer((request, response) => {
		seen.push(`${request.url} ${request.headers.authorization ?? ""}`);
		sendJson(response, {
			data: [
				{ id: "anthropic/claude-sonnet-4-6", display_name: "Sonnet" },
				{ id: "codex/gpt-5.5" },
				{ id: "image-group", kind: "image" },
				{ id: "empty-kind", kind: "" },
				{ display_name: "missing id" },
			],
		});
	});
	try {
		const catalog = await fetchMagpieCatalog(root, "gateway-token");
		assert.deepEqual(catalog.map(({ id }) => id), [
			"anthropic/claude-sonnet-4-6",
			"codex/gpt-5.5",
			"empty-kind",
		]);
		assert.deepEqual(seen, ["/v1/models Bearer gateway-token"]);
	} finally {
		await closeServer(server);
	}
});

test("reports rejected gateway keys", async () => {
	const { root, server } = await startServer((_request, response) => {
		response.writeHead(401);
		response.end();
	});
	try {
		await assert.rejects(fetchMagpieCatalog(root, "wrong"), {
			message: "gateway key rejected (is Share on local network on and the key enabled?)",
		});
	} finally {
		await closeServer(server);
	}
});

test("times out when the gateway accepts a request but never responds", async () => {
	const { root, server } = await startServer(() => {});
	try {
		await assert.rejects(fetchMagpieCatalog(root, "k", 200), /timed out/);
	} finally {
		await closeServer(server);
	}
});
