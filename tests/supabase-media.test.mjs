import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSupabaseMediaStore } from "../src/media/supabase.js";

/**
 * A tiny in-memory stand-in for the supabase-js storage surface the store uses:
 * storage.from(bucket).{upload,download,list,remove,getPublicUrl} plus
 * storage.{getBucket,createBucket}. Nothing here touches the network.
 */
function makeFakeClient({ bucketExists = true } = {}) {
  const objects = new Map(); // path -> { buffer, contentType }
  const state = { createdBucket: null, getBucketCalls: 0 };
  const bucket = "media";

  const fileApi = {
    async upload(path, body, opts = {}) {
      if (!opts.upsert && objects.has(path)) {
        return { data: null, error: { message: "The resource already exists" } };
      }
      const buffer = Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(String(body));
      objects.set(path, {
        buffer,
        contentType: opts.contentType ?? "application/octet-stream",
      });
      return { data: { path }, error: null };
    },
    async download(path) {
      const found = objects.get(path);
      if (!found) return { data: null, error: { message: "Object not found" } };
      return { data: new Blob([found.buffer], { type: found.contentType }), error: null };
    },
    async list(prefix = "", { limit = 100, offset = 0 } = {}) {
      const names = [...objects.keys()].filter((n) => n.startsWith(prefix)).sort();
      return { data: names.slice(offset, offset + limit).map((name) => ({ name })), error: null };
    },
    async remove(paths) {
      for (const p of paths) objects.delete(p);
      return { data: paths.map((name) => ({ name })), error: null };
    },
    getPublicUrl(path) {
      return {
        data: {
          publicUrl: `https://fake.supabase.co/storage/v1/object/public/${bucket}/${path}`,
        },
      };
    },
  };

  const storage = {
    from: () => fileApi,
    async getBucket() {
      state.getBucketCalls += 1;
      return bucketExists
        ? { data: { name: bucket, public: true }, error: null }
        : { data: null, error: { message: "Bucket not found" } };
    },
    async createBucket(name, options) {
      state.createdBucket = { name, options };
      return { data: { name, ...options }, error: null };
    },
  };

  return { client: { storage }, objects, state };
}

const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

test("save uploads the bytes plus a sidecar and returns a public ref", async () => {
  const { client, objects } = makeFakeClient();
  const store = createSupabaseMediaStore({ client });

  const ref = await store.save({
    id: "media-1",
    buffer: bytes,
    type: "image",
    mimeType: "image/png",
    fileName: null,
  });

  assert.equal(ref.key, "media-1", "safe ids are kept verbatim");
  assert.equal(ref.type, "image");
  assert.equal(ref.mimeType, "image/png");
  assert.equal(
    ref.url,
    "https://fake.supabase.co/storage/v1/object/public/media/media-1"
  );
  assert.deepEqual([...objects.keys()].sort(), ["media-1", "media-1.json"]);
  assert.deepEqual(objects.get("media-1").buffer, bytes);
  assert.deepEqual(objects.get("media-1.json").contentType, "application/json");
  assert.deepEqual(JSON.parse(objects.get("media-1.json").buffer.toString()), {
    type: "image",
    mimeType: "image/png",
    fileName: null,
  });
});

test("save returns null for empty, non-buffer and oversized payloads", async () => {
  const { client, objects } = makeFakeClient();
  const store = createSupabaseMediaStore({ client, maxBytes: 4 });

  assert.equal(await store.save({ id: "x", buffer: Buffer.alloc(0), type: "image" }), null);
  assert.equal(await store.save({ id: "x", buffer: "not a buffer", type: "image" }), null);
  assert.equal(await store.save({ id: "", buffer: bytes, type: "image" }), null);
  assert.equal(
    await store.save({ id: "x", buffer: Buffer.alloc(8), type: "image", mimeType: "image/png" }),
    null
  );
  assert.equal(objects.size, 0, "nothing was uploaded");
});

test("read downloads the bytes plus sidecar metadata", async () => {
  const { client } = makeFakeClient();
  const store = createSupabaseMediaStore({ client });
  await store.save({
    id: "doc-1",
    buffer: bytes,
    type: "document",
    mimeType: "application/pdf",
    fileName: "guide.pdf",
  });

  const found = await store.read("doc-1");
  assert.ok(found);
  assert.deepEqual(found.buffer, bytes);
  assert.equal(found.mimeType, "application/pdf");
  assert.equal(found.fileName, "guide.pdf");
});

test("read returns null for unknown or unsafe keys", async () => {
  const store = createSupabaseMediaStore({ client: makeFakeClient().client });
  assert.equal(await store.read("missing"), null);
  assert.equal(await store.read("../secret"), null);
  assert.equal(await store.read("..%2F..%2Fpackage.json"), null);
  assert.equal(await store.read(""), null);
  assert.equal(await store.read(null), null);
});

test("clearAll removes every object (bytes + sidecars) and reports the count", async () => {
  const { client, objects } = makeFakeClient();
  const store = createSupabaseMediaStore({ client });
  await store.save({ id: "a", buffer: bytes, type: "image", mimeType: "image/png" });
  await store.save({ id: "b", buffer: bytes, type: "image", mimeType: "image/png" });
  assert.equal(objects.size, 4);

  assert.equal(await store.clearAll(), 4);
  assert.equal(objects.size, 0);
  assert.equal(await store.read("a"), null);
});

test("creates the bucket when it is missing", async () => {
  const { client, state } = makeFakeClient({ bucketExists: false });
  const store = createSupabaseMediaStore({ client });
  await store.save({ id: "x", buffer: bytes, type: "image", mimeType: "image/png" });
  assert.ok(state.getBucketCalls >= 1);
  assert.deepEqual(state.createdBucket, { name: "media", options: { public: true } });
});

test("save returns null when the upload fails", async () => {
  const client = {
    storage: {
      from: () => ({
        async upload() {
          return { data: null, error: { message: "boom" } };
        },
        getPublicUrl: () => ({ data: { publicUrl: "" } }),
      }),
      async getBucket() {
        return { data: { name: "media" }, error: null };
      },
    },
  };
  const store = createSupabaseMediaStore({ client });
  assert.equal(await store.save({ id: "x", buffer: bytes, type: "image", mimeType: null }), null);
});

test("throws without url + serviceRoleKey (and no injected client)", () => {
  assert.throws(() => createSupabaseMediaStore({}), /requires url \+ serviceRoleKey/);
});

test("loadConfig uses the Supabase media store when configured", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-cfg-supabase-"));
  const saved = {
    DATABASE_URL: process.env.DATABASE_URL,
    LOCAL_DB: process.env.LOCAL_DB,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_MEDIA_BUCKET: process.env.SUPABASE_MEDIA_BUCKET,
    MEDIA_DRIVER: process.env.MEDIA_DRIVER,
  };
  delete process.env.DATABASE_URL;
  delete process.env.MEDIA_DRIVER;
  delete process.env.SUPABASE_MEDIA_BUCKET;
  process.env.LOCAL_DB = join(dir, "messages.db");
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";

  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    const { loadConfig } = await import("../src/config.js");
    const { messageStore, mediaStore } = loadConfig();
    assert.equal(typeof mediaStore.save, "function");
    assert.equal(typeof mediaStore.read, "function");
    assert.equal(typeof mediaStore.clearAll, "function");
    assert.ok(
      logs.some((line) => line.includes('Supabase bucket "media"')),
      "logs the configured bucket"
    );
    messageStore?.close?.();
  } finally {
    console.log = original;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
