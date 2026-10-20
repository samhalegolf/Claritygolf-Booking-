import assert from "node:assert/strict";
import test from "node:test";
import { safeVideoThumbnail, THUMBNAIL_MAX_LENGTH } from "./videoThumbnailPolicy";
import { createVideoThumbnail, thumbnailSize } from "./videoThumbnails";
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

test("thumbnail capture draws one small frame and releases the video and object URL", async () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis,"document");
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  const events: string[] = [];
  const canvas = {
    width:0,height:0,
    getContext:()=>({drawImage:()=>events.push("draw")}),
    toDataURL:()=> "data:image/jpeg;base64,YQ==",
  };
  const video: any = {
    videoWidth:1920,videoHeight:1080,duration:5,src:"",
    setAttribute:()=>{},
    pause:()=>events.push("pause"),
    removeAttribute:()=>{video.src="";events.push("detach");},
    load:()=>{if(video.src) queueMicrotask(()=>video.onloadeddata?.());},
    set currentTime(value: number) { queueMicrotask(()=>video.onseeked?.()); },
  };
  try {
    Object.defineProperty(globalThis,"document",{configurable:true,value:{
      createElement:(tag:string)=>tag==="canvas"?canvas:video,
    }});
    URL.createObjectURL=()=> "blob:thumbnail-test";
    URL.revokeObjectURL=()=>{events.push("revoke");};
    assert.equal(await createVideoThumbnail(new Blob(["video"])), "data:image/jpeg;base64,YQ==");
    assert.deepEqual([canvas.width,canvas.height],[256,144]);
    assert.deepEqual(events,["draw","pause","detach","revoke"]);
    assert.equal(video.onloadeddata,null);
    assert.equal(video.onseeked,null);
  } finally {
    if(previousDocument) Object.defineProperty(globalThis,"document",previousDocument);
    else Reflect.deleteProperty(globalThis,"document");
    URL.createObjectURL=previousCreate;
    URL.revokeObjectURL=previousRevoke;
  }
});
