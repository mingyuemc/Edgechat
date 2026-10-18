import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_R2_MAX_TOTAL_BYTES,
	R2QuotaExceededError,
	ensureR2Capacity,
	resolveR2MaxTotalBytes,
} from "./r2-quota.js";

function createStore(sizes) {
	const entries = sizes.map(([key, size]) => ({ key, size }));
	return {
		entries,
		totalBytes() {
			return entries.reduce((sum, entry) => sum + entry.size, 0);
		},
		candidates(excludeKey = "") {
			return entries
				.filter((entry) => entry.key !== excludeKey)
				.map((entry) => ({ key: entry.key, size: entry.size }));
		},
		remove(keys) {
			let deleted = 0;
			for (const key of keys) {
				const index = entries.findIndex((entry) => entry.key === key);
				if (index !== -1) {
					entries.splice(index, 1);
					deleted += 1;
				}
			}
			return deleted;
		},
	};
}

test("配额足够时不查询候选也不淘汰文件", async () => {
	let cleanupCalls = 0;
	const summary = await ensureR2Capacity(
		{ DB: {}, FILES: {}, R2_MAX_TOTAL_BYTES: "100" },
		50,
		{
			sumBytes: async () => 50,
			listCandidates: async () => {
				throw new Error("配额充足时不应扫描候选文件");
			},
			cleanup: async () => {
				cleanupCalls += 1;
				return {};
			},
		},
	);

	assert.equal(summary.deletedFiles, 0);
	assert.equal(cleanupCalls, 0);
});

test("写入会超限时按创建时间顺序淘汰最早的未引用文件", async () => {
	const store = createStore([
		["oldest", 100],
		["middle", 50],
		["newest", 30],
	]);
	const cleanupBatches = [];
	const summary = await ensureR2Capacity(
		{ DB: {}, FILES: {}, R2_MAX_TOTAL_BYTES: "100" },
		10,
		{
			protectedKey: "just-uploaded",
			sumBytes: async () => store.totalBytes(),
			listCandidates: async (_db, _limit, excludeKey) => store.candidates(excludeKey),
			cleanup: async (_env, keys) => {
				cleanupBatches.push(keys);
				return { r2Deleted: store.remove(keys) };
			},
		},
	);

	assert.equal(summary.deletedFiles, 1);
	assert.deepEqual(cleanupBatches, [["oldest"]]);
	assert.deepEqual(
		store.entries.map((entry) => entry.key),
		["middle", "newest"],
	);
	assert.ok(store.totalBytes() + 10 <= 100);
});

test("候选文件都被引用无法腾出空间时拒绝写入", async () => {
	let cleanupCalls = 0;
	await assert.rejects(
		ensureR2Capacity(
			{ DB: {}, FILES: {}, R2_MAX_TOTAL_BYTES: "100" },
			50,
			{
				sumBytes: async () => 100,
				listCandidates: async () => [{ key: "referenced", size: 100 }],
				cleanup: async () => {
					cleanupCalls += 1;
					return { r2Deleted: 0, r2SkippedReferenced: 1 };
				},
			},
		),
		(error) => {
			assert.ok(error instanceof R2QuotaExceededError);
			assert.equal(error.status, 507);
			return true;
		},
	);
	assert.equal(cleanupCalls, 1);
});

test("没有可淘汰候选且已超限时拒绝写入", async () => {
	await assert.rejects(
		ensureR2Capacity(
			{ DB: {}, FILES: {}, R2_MAX_TOTAL_BYTES: "100" },
			50,
			{
				sumBytes: async () => 120,
				listCandidates: async () => [],
				cleanup: async () => ({ r2Deleted: 1 }),
			},
		),
		R2QuotaExceededError,
	);
});

test("单次上传本身超过配额时直接拒绝", async () => {
	await assert.rejects(
		ensureR2Capacity(
			{ DB: {}, FILES: {}, R2_MAX_TOTAL_BYTES: "100" },
			200,
			{ sumBytes: async () => 0, listCandidates: async () => [] },
		),
		R2QuotaExceededError,
	);
});

test("未绑定 R2 或数据库时不拦截写入", async () => {
	assert.equal((await ensureR2Capacity({ R2_MAX_TOTAL_BYTES: "100" }, 999)).deletedFiles, 0);
	assert.equal((await ensureR2Capacity({ DB: {}, R2_MAX_TOTAL_BYTES: "100" }, 999)).deletedFiles, 0);
});

test("配额解析使用默认 10GiB 并可被环境变量覆盖", () => {
	assert.equal(resolveR2MaxTotalBytes({}), DEFAULT_R2_MAX_TOTAL_BYTES);
	assert.equal(resolveR2MaxTotalBytes({ R2_MAX_TOTAL_BYTES: "abc" }), DEFAULT_R2_MAX_TOTAL_BYTES);
	assert.equal(resolveR2MaxTotalBytes({ R2_MAX_TOTAL_BYTES: "0" }), DEFAULT_R2_MAX_TOTAL_BYTES);
	assert.equal(resolveR2MaxTotalBytes({ R2_MAX_TOTAL_BYTES: "2048" }), 2048);
});
