import assert from "node:assert/strict";
import test from "node:test";
import { safeVideoThumbnail, THUMBNAIL_MAX_LENGTH } from "./videoThumbnailPolicy";
import { thumbnailSize } from "./videoThumbnails";
import { cleanRetiredVideoEntry, retiredEntrySettingKey } from "./videoLibraryRetirement";

test("thumbnail policy accepts tiny embedded posters and rejects remote URLs and oversized pictures", () => {
  assert.equal(safeVideoThumbnail("data:image/jpeg;base64,YQ=="), "data:image/jpeg;base64,YQ==");
  assert.equal(safeVideoThumbnail("https://example.com/private-photo"), undefined);
  assert.equal(safeVideoThumbnail("data:image/svg+xml;base64,YQ=="), undefined);
  assert.equal(safeVideoThumbnail("data:image/jpeg;base64," + "a".repeat(THUMBNAIL_MAX_LENGTH)), undefined);
});
test("portrait and landscape previews never exceed 256 pixels or upscale", () => {
  assert.deepEqual(thumbnailSize(1920,1080), {width:256,height:144});
  assert.deepEqual(thumbnailSize(1080,1920), {width:144,height:256});
  assert.deepEqual(thumbnailSize(80,40), {width:80,height:40});
});
test("only explicit permanent-source retirement is accepted; an outage is never enough", () => {
  const entry = {savedVideoId:"saved-video-1",playerId:"player-1",title:"Swing"};
  for (const reason of [undefined,"offline","timeout","permission-lost","reconnect_required"]) {
    assert.equal(cleanRetiredVideoEntry({...entry,reason}), null);
  }
  assert.equal(cleanRetiredVideoEntry({...entry,reason:"source-removed"},"now")?.retiredAt,"now");
  assert.equal(retiredEntrySettingKey("saved-video-1"),"videoLibraryRetiredEntry:saved-video-1");
  assert.equal(cleanRetiredVideoEntry({...entry,savedVideoId:"../other",reason:"source-removed"}),null);
});
