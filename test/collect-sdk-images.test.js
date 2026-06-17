import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeImageData, collectSdkImages } from "../lib/cursor-helpers.js";

// M4: image data-URI normalization + non-vision guard.

test("normalizeImageData: bare base64 passes through unchanged", () => {
  const out = normalizeImageData({ data: "AAAA", mimeType: "image/jpeg" });
  assert.deepEqual(out, { data: "AAAA", mimeType: "image/jpeg" });
});

test("normalizeImageData: bare base64 with no mime defaults to image/png", () => {
  const out = normalizeImageData({ data: "AAAA" });
  assert.deepEqual(out, { data: "AAAA", mimeType: "image/png" });
});

test("normalizeImageData: strips data:<mime>;base64, prefix and derives mime", () => {
  const out = normalizeImageData({ data: "data:image/png;base64,AAAA" });
  assert.deepEqual(out, { data: "AAAA", mimeType: "image/png" });
});

test("normalizeImageData: explicit mimeType wins over the data-URI mime", () => {
  const out = normalizeImageData({ data: "data:image/png;base64,AAAA", mimeType: "image/webp" });
  assert.deepEqual(out, { data: "AAAA", mimeType: "image/webp" });
});

function imageContext() {
  return {
    messages: [
      { role: "user", content: [
        { type: "text", text: "look at this" },
        { type: "image", data: "data:image/png;base64,AAAA" },
      ] },
    ],
  };
}

test("collectSdkImages: vision-capable model keeps the (normalized) image", () => {
  const images = collectSdkImages(imageContext(), true);
  assert.deepEqual(images, [{ data: "AAAA", mimeType: "image/png" }]);
});

test("collectSdkImages: non-vision model skips images (returns [])", () => {
  const images = collectSdkImages(imageContext(), false);
  assert.deepEqual(images, []);
});

test("collectSdkImages: no images present returns []", () => {
  const ctx = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
  assert.deepEqual(collectSdkImages(ctx, true), []);
});
