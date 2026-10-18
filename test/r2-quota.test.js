import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import initSqlJs from "sql.js";

import { saveUploadedFile } from "../worker/src/api/upload.js";
import { R2QuotaExceededError } from "../worker/src/r2-quota.js";
import { createD1Adapter } from "./support/d1.js";

const SQL = await initSqlJs();
const schemaSql = readFileSync(new URL("../worker/schema.sql", import.meta.url), "utf8");
const keyring = JSON.stringify({
	activeKeyId: "test-v1",
	keys: { "test-v1": Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 7)).toString("base64") },
});

function createEnvironment() {
	const database = new SQL.Database();
	database.exec(schemaSql);
	database.run(
		"INSERT INTO users (username, display_name, password_hash, password_salt, is_super_admin, session_version) VALUES ('quota-owner', 'Quota', 'hash', 'salt', 0, 0)",
	);
	const userId = Number(database.exec("SELECT last_insert_rowid()")[0].values[0][0]);
	const channelId = Number(database.exec("SELECT id FROM channels WHERE name = 'general'")[0].values[0][0]);
	const files = new Map();
	const env = {
		DB: createD1Adapter(database),
		FILES: {
			async put(key, value) {
				files.set(key, value);
			},
			async delete(key) {
				files.delete(key);
			},
			async get(key) {
				return files.get(key) || null;
			},
		},
		R2_MAX_TOTAL_BYTES: "1000",
		EDGECHAT_ENCRYPTION_KEYRING: keyring,
	};
	return { database, env, files, userId, channelId };
}

function upload(env, userId, file) {
	return saveUploadedFile(env, { userId }, file);
}

test("超出配额时淘汰最早的未引用文件并完成上传", async () => {
	const envRef = createEnvironment();
	envRef.database.run(
		`INSERT INTO uploaded_files (object_key, owner_user_id, size, created_at) VALUES
		 ('1/a', ?, 400, datetime('now', '-3 day')),
		 ('1/b', ?, 400, datetime('now', '-2 day'))`,
		[envRef.userId, envRef.userId],
	);
	envRef.files.set("1/a", new Uint8Array([1]));
	envRef.files.set("1/b", new Uint8Array([2]));

	const result = await upload(
		envRef.env,
		envRef.userId,
		new File([new Uint8Array(400)], "note.bin", { type: "application/octet-stream" }),
	);

	assert.equal(result.created, true);
	// 最早的未引用文件被淘汰，且其登记记录同步移除。
	assert.equal(envRef.files.has("1/a"), false);
	assert.equal(
		Number(envRef.database.exec("SELECT COUNT(*) FROM uploaded_files WHERE object_key = '1/a'")[0].values[0][0]),
		0,
	);
	// 其余登记与新上传都保留。
	assert.equal(envRef.files.has("1/b"), true);
	assert.equal(
		Number(envRef.database.exec("SELECT COUNT(*) FROM uploaded_files")[0].values[0][0]),
		2,
	);
});

test("被引用文件顶满配额时拒绝上传且不写入 R2", async () => {
	const envRef = createEnvironment();
	envRef.env.R2_MAX_TOTAL_BYTES = "500";
	envRef.database.run(
		"INSERT INTO uploaded_files (object_key, owner_user_id, size, created_at) VALUES ('1/live', ?, 400, datetime('now', '-1 day'))",
		[envRef.userId],
	);
	envRef.database.run(
		"INSERT INTO messages (channel_id, sender_id, content, attachment_key, sender_kind) VALUES (?, ?, '', '1/live', 'local')",
		[envRef.channelId, envRef.userId],
	);
	envRef.files.set("1/live", new Uint8Array([9]));

	await assert.rejects(
		upload(
			envRef.env,
			envRef.userId,
			new File([new Uint8Array(400)], "too-big.bin", { type: "application/octet-stream" }),
		),
		(error) => error instanceof R2QuotaExceededError && error.status === 507,
	);

	// 被引用的对象未被删除，也没有新增对象写入 R2。
	assert.equal(envRef.files.has("1/live"), true);
	assert.equal(envRef.files.size, 1);
	assert.equal(
		Number(envRef.database.exec("SELECT COUNT(*) FROM uploaded_files")[0].values[0][0]),
		1,
	);
});
