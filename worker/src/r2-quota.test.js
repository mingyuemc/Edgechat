import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_R2_MAX_TOTAL_BYTES,
	enforceR2Quota,
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

test("未超出配额时不查询候选也不淘汰文件", async () => {
	let cleanupCalls = 0;
	const summary = await enforceR2Quota(
		{ DB: {}, FILES: {}, R2_MAX_TOTAL_BYTES: "1000" },
		{
			sumBytes: async () => 500,
			listCandidates: async () => {
				throw new Error("配额内不应扫描候选文件");
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

test("超出配额时按创建时间顺序只淘汰覆盖缺口所需的早期文件", async () => {
	const store = createStore([
		["oldest", 60],
		["middle", 60],
		["newest", 60],
	]);
	const cleanupBatches = [];
	const summary = await enforceR2Quota(
		{ DB: {}, FILES: {}, R2_MAX_TOTAL_BYTES: "100" },
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

	assert.equal(summary.deletedFiles, 2);
	assert.deepEqual(cleanupBatches, [["oldest", "middle"]]);
	assert.deepEqual(
		store.entries.map((entry) => entry.key),
		["newest"],
	);
	assert.ok(store.totalBytes() <= 100);
});

test("候选文件都被引用无法删除时停止继续淘汰", async () => {
	let cleanupCalls = 0;
	const summary = await enforceR2Quota(
		{ DB: {}, FILES: {}, R2_MAX_TOTAL_BYTES: "100" },
		{
			sumBytes: async () => 500,
			listCandidates: async () => [{ key: "referenced", size: 500 }],
			cleanup: async () => {
				cleanupCalls += 1;
				return { r2Deleted: 0, r2SkippedReferenced: 1 };
			},
		},
	);

	assert.equal(cleanupCalls, 1);
	assert.equal(summary.deletedFiles, 0);
	assert.equal(summary.skippedReferenced, 1);
});

test("没有可淘汰候选时直接返回", async () => {
	let cleanupCalls = 0;
	const summary = await enforceR2Quota(
		{ DB: {}, FILES: {}, R2_MAX_TOTAL_BYTES: "100" },
		{
			sumBytes: async () => 500,
			listCandidates: async () => [],
			cleanup: async () => {
				cleanupCalls += 1;
				return { r2Deleted: 1 };
			},
		},
	);

	assert.equal(cleanupCalls, 0);
	assert.equal(summary.deletedFiles, 0);
});

test("未绑定 R2 或数据库时不做任何处理", async () => {
	assert.equal((await enforceR2Quota({ R2_MAX_TOTAL_BYTES: "100" })).deletedFiles, 0);
	assert.equal((await enforceR2Quota({ DB: {}, R2_MAX_TOTAL_BYTES: "100" })).deletedFiles, 0);
});

test("配额解析使用默认 10GiB 并可被环境变量覆盖", () => {
	assert.equal(resolveR2MaxTotalBytes({}), DEFAULT_R2_MAX_TOTAL_BYTES);
	assert.equal(resolveR2MaxTotalBytes({ R2_MAX_TOTAL_BYTES: "abc" }), DEFAULT_R2_MAX_TOTAL_BYTES);
	assert.equal(resolveR2MaxTotalBytes({ R2_MAX_TOTAL_BYTES: "0" }), DEFAULT_R2_MAX_TOTAL_BYTES);
	assert.equal(resolveR2MaxTotalBytes({ R2_MAX_TOTAL_BYTES: "2048" }), 2048);
});
