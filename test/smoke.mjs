// Read-only smoke test: requests only /v1/models and /v1/magpie/quotas.
import assert from "node:assert/strict";
import test from "node:test";
import { fetchMagpieCatalog, normalizeMagpieUrl } from "../src/magpie.mjs";
import { fetchMagpieQuotas, formatQuotaReport } from "../src/quota.mjs";

const url = process.env.MAGPIE_URL;
const key = process.env.MAGPIE_GATEWAY_KEY ?? "";
const skip = url ? false : "set MAGPIE_URL and MAGPIE_GATEWAY_KEY to run against a live Magpie gateway";

test("remote Magpie exposes a readable model catalog", { skip }, async () => {
	if (!url) return;
	const root = normalizeMagpieUrl(url);
	const catalog = await fetchMagpieCatalog(root, key, AbortSignal.timeout(20_000));
	assert.ok(Array.isArray(catalog));
	console.log(`${catalog.length} chat models returned`);
});

test("remote Magpie exposes a readable quota report", { skip }, async () => {
	if (!url) return;
	const root = normalizeMagpieUrl(url);
	const quotas = await fetchMagpieQuotas(root, key, AbortSignal.timeout(20_000));
	assert.ok(Array.isArray(quotas));
	assert.ok(formatQuotaReport(quotas).length > 0);
	console.log(`${quotas.length} quota entries returned`);
});
