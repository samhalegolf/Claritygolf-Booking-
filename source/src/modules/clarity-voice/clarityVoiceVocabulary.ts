import type { ClarityVoiceVocabularyCategory, ClarityVoiceVocabularyTerm, ClarityVoiceVocabularyMention } from './types';
export const CLARITY_VOICE_VOCABULARY_VERSION = '2026-07-07-jargon-v1';
export const DEFAULT_CLARITY_VOICE_VOCABULARY: ClarityVoiceVocabularyTerm[] = [
  {"phrase": "Clarity Caddy", "canonical": "Clarity Caddy", "category": "brand", "aliases": ["clarity caddy", "clarity cadie", "clarity caddie"], "tags": ["brand", "app"], "summaryHint": "product"},
  {"phrase": "Clarity Golf Systems", "canonical": "Clarity Golf Systems", "category": "brand", "aliases": ["clarity golf systems", "clarity golf system"], "tags": ["brand"], "summaryHint": "company"},
  {"phrase": "Clarity Voice", "canonical": "Clarity Voice", "category": "brand", "aliases": ["clarity voice"], "tags": ["brand", "voice"], "summaryHint": "module"},
  {"phrase": "Clarity Pay", "canonical": "Clarity Pay", "category": "brand", "aliases": ["clarity pay"], "tags": ["brand", "payment"], "summaryHint": "module"},
  {"phrase": "Clarity Performance", "canonical": "Clarity Performance", "category": "brand", "aliases": ["clarity performance"], "tags": ["brand", "coaching"], "summaryHint": "ecosystem"},
  {"phrase": "Decoding Golf", "canonical": "Decoding Golf", "category": "brand", "aliases": ["decoding golf"], "tags": ["brand", "content"], "summaryHint": "content"},
  {"phrase": "My Bubble", "canonical": "My Bubble", "category": "app", "aliases": ["my bubble", "mybubble"], "tags": ["app", "bubble"], "summaryHint": "player model"},
  {"phrase": "Practice Bubble", "canonical": "Practice Bubble", "category": "app", "aliases": ["practice bubble"], "tags": ["app", "bubble"], "summaryHint": "practice model"},
  {"phrase": "Course Bubble", "canonical": "Course Bubble", "category": "app", "aliases": ["course bubble"], "tags": ["app", "bubble"], "summaryHint": "course model"},
  {"phrase": "Bubble Studio", "canonical": "Bubble Studio", "category": "app", "aliases": ["bubble studio"], "tags": ["app", "bubble"], "summaryHint": "workspace"},
  {"phrase": "GPS Play", "canonical": "GPS Play", "category": "app", "aliases": ["gps play", "g p s play"], "tags": ["app", "gps"], "summaryHint": "on-course mode"},
  {"phrase": "Green Zoom", "canonical": "Green Zoom", "category": "app", "aliases": ["green zoom"], "tags": ["app", "gps"], "summaryHint": "green frame"},
  {"phrase": "Green Wand", "canonical": "Green Wand", "category": "app", "aliases": ["green wand"], "tags": ["app", "mapping"], "summaryHint": "mapping tool"},
  {"phrase": "Pretend GPS", "canonical": "Pretend GPS", "category": "app", "aliases": ["pretend gps", "pretend g p s"], "tags": ["app", "gps"], "summaryHint": "testing mode"},
  {"phrase": "Ghost Bag", "canonical": "Ghost Bag", "category": "app", "aliases": ["ghost bag"], "tags": ["app", "bag"], "summaryHint": "default bag"},
  {"phrase": "Shot Library", "canonical": "Shot Library", "category": "app", "aliases": ["shot library"], "tags": ["app", "data"], "summaryHint": "practice data"},
  {"phrase": "Practice Data Photo Scan", "canonical": "Practice Data Photo Scan", "category": "app", "aliases": ["practice data photo scan", "photo scan"], "tags": ["app", "scanner"], "summaryHint": "scanner"},
  {"phrase": "Practice Shot Data Gate", "canonical": "Practice Shot Data Gate", "category": "app", "aliases": ["practice shot data gate", "shot data gate"], "tags": ["app", "data"], "summaryHint": "normalisation gate"},
  {"phrase": "Cluster Finder", "canonical": "Cluster Finder", "category": "app", "aliases": ["cluster finder"], "tags": ["app", "data"], "summaryHint": "pattern detection"},
  {"phrase": "TrackMan", "canonical": "TrackMan", "category": "brand", "aliases": ["track man", "trackman"], "tags": ["launch monitor"], "summaryHint": "launch monitor"},
  {"phrase": "FlightScope", "canonical": "FlightScope", "category": "brand", "aliases": ["flight scope", "flightscope"], "tags": ["launch monitor"], "summaryHint": "launch monitor"},
  {"phrase": "Foresight", "canonical": "Foresight", "category": "brand", "aliases": ["foresight sports", "foresight"], "tags": ["launch monitor"], "summaryHint": "launch monitor"},
  {"phrase": "GCQuad", "canonical": "GCQuad", "category": "brand", "aliases": ["g c quad", "gc quad", "gcquad"], "tags": ["launch monitor"], "summaryHint": "launch monitor"},
  {"phrase": "GC3", "canonical": "GC3", "category": "brand", "aliases": ["g c three", "gc three", "gc3"], "tags": ["launch monitor"], "summaryHint": "launch monitor"},
  {"phrase": "Bushnell Launch Pro", "canonical": "Bushnell Launch Pro", "category": "brand", "aliases": ["bushnell launch pro", "launch pro"], "tags": ["launch monitor"], "summaryHint": "launch monitor"},
  {"phrase": "SkyTrak", "canonical": "SkyTrak", "category": "brand", "aliases": ["sky track", "skytrak"], "tags": ["launch monitor"], "summaryHint": "launch monitor"},
  {"phrase": "Garmin Approach", "canonical": "Garmin Approach", "category": "brand", "aliases": ["garmin approach"], "tags": ["gps", "brand"], "summaryHint": "gps"},
  {"phrase": "Arccos", "canonical": "Arccos", "category": "brand", "aliases": ["arccos", "arcoss"], "tags": ["gps", "stats"], "summaryHint": "tracking"},
  {"phrase": "Shot Scope", "canonical": "Shot Scope", "category": "brand", "aliases": ["shot scope", "shotscope"], "tags": ["gps", "stats"], "summaryHint": "tracking"},
  {"phrase": "Toptracer", "canonical": "Toptracer", "category": "brand", "aliases": ["top tracer", "toptracer"], "tags": ["range"], "summaryHint": "range system"},
  {"phrase": "TrackTee", "canonical": "TrackTee", "category": "brand", "aliases": ["track tee", "tracktee"], "tags": ["range"], "summaryHint": "range system"},
  {"phrase": "Range Servant", "canonical": "Range Servant", "category": "brand", "aliases": ["range servant"], "tags": ["range"], "summaryHint": "range system"},
  {"phrase": "Golf Genius", "canonical": "Golf Genius", "category": "brand", "aliases": ["golf genius"], "tags": ["software"], "summaryHint": "tournament software"},
  {"phrase": "MiScore", "canonical": "MiScore", "category": "brand", "aliases": ["my score", "miscore"], "tags": ["software"], "summaryHint": "scoring"},
  {"phrase": "DotGolf", "canonical": "DotGolf", "category": "brand", "aliases": ["dot golf", "dotgolf"], "tags": ["software", "nz"], "summaryHint": "New Zealand golf system"},
  {"phrase": "driver", "canonical": "driver", "category": "club", "aliases": ["driver"], "tags": ["club"], "summaryHint": "club"},
  {"phrase": "3 wood", "canonical": "3 wood", "category": "club", "aliases": ["three wood", "3 wood"], "tags": ["club"], "summaryHint": "club"},
  {"phrase": "4 wood", "canonical": "4 wood", "category": "club", "aliases": ["four wood", "4 wood"], "tags": ["club"], "summaryHint": "club"},
  {"phrase": "5 wood", "canonical": "5 wood", "category": "club", "aliases": ["five wood", "5 wood"], "tags": ["club"], "summaryHint": "club"},
  {"phrase": "7 wood", "canonical": "7 wood", "category": "club", "aliases": ["seven wood", "7 wood"], "tags": ["club"], "summaryHint": "club"},
  {"phrase": "hybrid", "canonical": "hybrid", "category": "club", "aliases": ["hybrid", "rescue"], "tags": ["club"], "summaryHint": "club"},
  {"phrase": "2 hybrid", "canonical": "2 hybrid", "category": "club", "aliases": ["two hybrid", "2 hybrid"], "tags": ["club"], "summaryHint": "club"},
  {"phrase": "3 hybrid", "canonical": "3 hybrid", "category": "club", "aliases": ["three hybrid", "3 hybrid"], "tags": ["club"], "summaryHint": "club"},
  {"phrase": "4 hybrid", "canonical": "4 hybrid", "category": "club", "aliases": ["four hybrid", "4 hybrid"], "tags": ["club"], "summaryHint": "club"},
  {"phrase": "5 hybrid", "canonical": "5 hybrid", "category": "club", "aliases": ["five hybrid", "5 hybrid"], "tags": ["club"], "summaryHint": "club"},
  {"phrase": "driving iron", "canonical": "driving iron", "category": "club", "aliases": ["driving iron", "utility iron"], "tags": ["club"], "summaryHint": "club"},
  {"phrase": "2 iron", "canonical": "2 iron", "category": "club", "aliases": ["two iron", "2 iron"], "tags": ["club"], "summaryHint": "club"},
  {"phrase": "3 iron", "canonical": "3 iron", "category": "club", "aliases": ["three iron", "3 iron"], "tags": ["club"], "summaryHint": "club"},
  {"phrase": "4 iron", "canonical": "4 iron", "category": "club", "aliases": ["four iron", "4 iron"], "tags": ["club"], "summaryHint": "club"},
  {"phrase": "5 iron", "canonical": "5 iron", "category": "club", "aliases": ["five iron", "5 iron"], "tags": ["club"], "summaryHint": "club"},
  {"phrase": "6 iron", "canonical": "6 iron", "category": "club", "aliases": ["six iron", "6 iron"], "tags": ["club"], "summaryHint": "club"},
  {"phrase": "7 iron", "canonical": "7 iron", "category": "club", "aliases": ["seven iron", "7 iron"], "tags": ["club"], "summaryHint": "club"},
  {"phrase": "8 iron", "canonical": "8 iron", "category": "club", "aliases": ["eight iron", "8 iron"], "tags": ["club"], "summaryHint": "club"},
  {"phrase": "9 iron", "canonical": "9 iron", "category": "club", "aliases": ["nine iron", "9 iron"], "tags": ["club"], "summaryHint": "club"},
  {"phrase": "pitching wedge", "canonical": "pitching wedge", "category": "club", "aliases": ["pitching wedge", "p w", "pw"], "tags": ["club", "wedge"], "summaryHint": "club"},
  {"phrase": "gap wedge", "canonical": "gap wedge", "category": "club", "aliases": ["gap wedge", "g w", "gw", "approach wedge", "a w", "aw"], "tags": ["club", "wedge"], "summaryHint": "club"},
  {"phrase": "sand wedge", "canonical": "sand wedge", "category": "club", "aliases": ["sand wedge", "s w", "sw"], "tags": ["club", "wedge"], "summaryHint": "club"},
  {"phrase": "lob wedge", "canonical": "lob wedge", "category": "club", "aliases": ["lob wedge", "l w", "lw"], "tags": ["club", "wedge"], "summaryHint": "club"},
  {"phrase": "putter", "canonical": "putter", "category": "club", "aliases": ["putter"], "tags": ["club"], "summaryHint": "club"},
  {"phrase": "draw", "canonical": "draw", "category": "shot", "aliases": ["draw"], "tags": ["shot shape"], "summaryHint": "shot shape"},
  {"phrase": "fade", "canonical": "fade", "category": "shot", "aliases": ["fade"], "tags": ["shot shape"], "summaryHint": "shot shape"},
  {"phrase": "slice", "canonical": "slice", "category": "shot", "aliases": ["slice"], "tags": ["miss"], "summaryHint": "miss"},
  {"phrase": "hook", "canonical": "hook", "category": "shot", "aliases": ["hook"], "tags": ["miss"], "summaryHint": "miss"},
  {"phrase": "push", "canonical": "push", "category": "shot", "aliases": ["push"], "tags": ["miss"], "summaryHint": "miss"},
  {"phrase": "pull", "canonical": "pull", "category": "shot", "aliases": ["pull"], "tags": ["miss"], "summaryHint": "miss"},
  {"phrase": "push fade", "canonical": "push fade", "category": "shot", "aliases": ["push fade"], "tags": ["miss"], "summaryHint": "miss"},
  {"phrase": "pull draw", "canonical": "pull draw", "category": "shot", "aliases": ["pull draw"], "tags": ["miss"], "summaryHint": "miss"},
  {"phrase": "push slice", "canonical": "push slice", "category": "shot", "aliases": ["push slice"], "tags": ["miss"], "summaryHint": "miss"},
  {"phrase": "pull hook", "canonical": "pull hook", "category": "shot", "aliases": ["pull hook"], "tags": ["miss"], "summaryHint": "miss"},
  {"phrase": "block", "canonical": "block", "category": "shot", "aliases": ["block"], "tags": ["miss"], "summaryHint": "miss"},
  {"phrase": "double cross", "canonical": "double cross", "category": "shot", "aliases": ["double cross"], "tags": ["miss"], "summaryHint": "miss"},
  {"phrase": "thin", "canonical": "thin", "category": "shot", "aliases": ["thin"], "tags": ["strike"], "summaryHint": "strike"},
  {"phrase": "fat", "canonical": "fat", "category": "shot", "aliases": ["fat", "heavy"], "tags": ["strike"], "summaryHint": "strike"},
  {"phrase": "chunk", "canonical": "chunk", "category": "shot", "aliases": ["chunk"], "tags": ["strike"], "summaryHint": "strike"},
  {"phrase": "top", "canonical": "top", "category": "shot", "aliases": ["top", "topped"], "tags": ["strike"], "summaryHint": "strike"},
  {"phrase": "shank", "canonical": "shank", "category": "shot", "aliases": ["shank"], "tags": ["strike"], "summaryHint": "strike"},
  {"phrase": "toe strike", "canonical": "toe strike", "category": "shot", "aliases": ["toe strike", "off the toe"], "tags": ["strike"], "summaryHint": "strike"},
  {"phrase": "heel strike", "canonical": "heel strike", "category": "shot", "aliases": ["heel strike", "off the heel"], "tags": ["strike"], "summaryHint": "strike"},
  {"phrase": "high toe", "canonical": "high toe", "category": "shot", "aliases": ["high toe"], "tags": ["strike"], "summaryHint": "strike"},
  {"phrase": "low heel", "canonical": "low heel", "category": "shot", "aliases": ["low heel"], "tags": ["strike"], "summaryHint": "strike"},
  {"phrase": "sky ball", "canonical": "sky ball", "category": "shot", "aliases": ["sky ball", "skied"], "tags": ["strike"], "summaryHint": "strike"},
  {"phrase": "duff", "canonical": "duff", "category": "shot", "aliases": ["duff", "duffed"], "tags": ["strike"], "summaryHint": "strike"},
  {"phrase": "flier", "canonical": "flier", "category": "shot", "aliases": ["flier", "flyer"], "tags": ["shot"], "summaryHint": "shot"},
  {"phrase": "knuckle ball", "canonical": "knuckle ball", "category": "shot", "aliases": ["knuckle ball"], "tags": ["shot"], "summaryHint": "shot"},
  {"phrase": "stinger", "canonical": "stinger", "category": "shot", "aliases": ["stinger"], "tags": ["shot"], "summaryHint": "shot"},
  {"phrase": "punch shot", "canonical": "punch shot", "category": "shot", "aliases": ["punch shot", "punch"], "tags": ["shot"], "summaryHint": "shot"},
  {"phrase": "knockdown", "canonical": "knockdown", "category": "shot", "aliases": ["knock down", "knockdown"], "tags": ["shot"], "summaryHint": "shot"},
  {"phrase": "chip", "canonical": "chip", "category": "shot", "aliases": ["chip", "chip shot"], "tags": ["short game"], "summaryHint": "short game"},
  {"phrase": "pitch", "canonical": "pitch", "category": "shot", "aliases": ["pitch", "pitch shot"], "tags": ["short game"], "summaryHint": "short game"},
  {"phrase": "bump and run", "canonical": "bump and run", "category": "shot", "aliases": ["bump and run"], "tags": ["short game"], "summaryHint": "short game"},
  {"phrase": "flop shot", "canonical": "flop shot", "category": "shot", "aliases": ["flop shot"], "tags": ["short game"], "summaryHint": "short game"},
  {"phrase": "splash shot", "canonical": "splash shot", "category": "shot", "aliases": ["splash shot"], "tags": ["bunker"], "summaryHint": "bunker"},
  {"phrase": "lag putt", "canonical": "lag putt", "category": "shot", "aliases": ["lag putt"], "tags": ["putting"], "summaryHint": "putting"},
  {"phrase": "tap-in", "canonical": "tap-in", "category": "shot", "aliases": ["tap in", "tap-in"], "tags": ["putting"], "summaryHint": "putting"},
  {"phrase": "club speed", "canonical": "club speed", "category": "data", "aliases": ["club speed", "clubhead speed", "club head speed"], "tags": ["data"], "summaryHint": "launch data"},
  {"phrase": "ball speed", "canonical": "ball speed", "category": "data", "aliases": ["ball speed"], "tags": ["data"], "summaryHint": "launch data"},
  {"phrase": "smash factor", "canonical": "smash factor", "category": "data", "aliases": ["smash factor"], "tags": ["data"], "summaryHint": "launch data"},
  {"phrase": "attack angle", "canonical": "attack angle", "category": "data", "aliases": ["attack angle", "angle of attack"], "tags": ["data"], "summaryHint": "launch data"},
  {"phrase": "club path", "canonical": "club path", "category": "data", "aliases": ["club path", "swing path"], "tags": ["data"], "summaryHint": "launch data"},
  {"phrase": "face angle", "canonical": "face angle", "category": "data", "aliases": ["face angle"], "tags": ["data"], "summaryHint": "launch data"},
  {"phrase": "face to path", "canonical": "face to path", "category": "data", "aliases": ["face to path", "face-to-path"], "tags": ["data"], "summaryHint": "launch data"},
  {"phrase": "face to target", "canonical": "face to target", "category": "data", "aliases": ["face to target", "face-to-target"], "tags": ["data"], "summaryHint": "launch data"},
  {"phrase": "dynamic loft", "canonical": "dynamic loft", "category": "data", "aliases": ["dynamic loft"], "tags": ["data"], "summaryHint": "launch data"},
  {"phrase": "launch angle", "canonical": "launch angle", "category": "data", "aliases": ["launch angle"], "tags": ["data"], "summaryHint": "launch data"},
  {"phrase": "spin rate", "canonical": "spin rate", "category": "data", "aliases": ["spin rate", "backspin"], "tags": ["data"], "summaryHint": "launch data"},
  {"phrase": "spin axis", "canonical": "spin axis", "category": "data", "aliases": ["spin axis"], "tags": ["data"], "summaryHint": "launch data"},
  {"phrase": "side spin", "canonical": "side spin", "category": "data", "aliases": ["side spin", "sidespin"], "tags": ["data"], "summaryHint": "launch data"},
  {"phrase": "carry distance", "canonical": "carry distance", "category": "data", "aliases": ["carry distance", "carry"], "tags": ["data"], "summaryHint": "distance"},
  {"phrase": "total distance", "canonical": "total distance", "category": "data", "aliases": ["total distance", "total"], "tags": ["data"], "summaryHint": "distance"},
  {"phrase": "rollout", "canonical": "rollout", "category": "data", "aliases": ["roll out", "rollout"], "tags": ["data"], "summaryHint": "distance"},
  {"phrase": "apex height", "canonical": "apex height", "category": "data", "aliases": ["apex height", "peak height"], "tags": ["data"], "summaryHint": "launch data"},
  {"phrase": "landing angle", "canonical": "landing angle", "category": "data", "aliases": ["landing angle", "descent angle"], "tags": ["data"], "summaryHint": "launch data"},
  {"phrase": "hang time", "canonical": "hang time", "category": "data", "aliases": ["hang time"], "tags": ["data"], "summaryHint": "launch data"},
  {"phrase": "dispersion", "canonical": "dispersion", "category": "data", "aliases": ["dispersion"], "tags": ["data"], "summaryHint": "pattern"},
  {"phrase": "start line", "canonical": "start line", "category": "data", "aliases": ["start line"], "tags": ["data"], "summaryHint": "direction"},
  {"phrase": "target line", "canonical": "target line", "category": "data", "aliases": ["target line"], "tags": ["data"], "summaryHint": "direction"},
  {"phrase": "offline", "canonical": "offline", "category": "data", "aliases": ["offline", "off line"], "tags": ["data"], "summaryHint": "direction"},
  {"phrase": "left miss", "canonical": "left miss", "category": "data", "aliases": ["left miss"], "tags": ["data", "miss"], "summaryHint": "miss"},
  {"phrase": "right miss", "canonical": "right miss", "category": "data", "aliases": ["right miss"], "tags": ["data", "miss"], "summaryHint": "miss"},
  {"phrase": "degree offset", "canonical": "degree offset", "category": "data", "aliases": ["degree offset"], "tags": ["clarity", "data"], "summaryHint": "Clarity metric"},
  {"phrase": "offset to neutral", "canonical": "offset to neutral", "category": "data", "aliases": ["offset to neutral"], "tags": ["clarity", "data"], "summaryHint": "Clarity metric"},
  {"phrase": "grip", "canonical": "grip", "category": "swing", "aliases": ["grip"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "stance", "canonical": "stance", "category": "swing", "aliases": ["stance"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "posture", "canonical": "posture", "category": "swing", "aliases": ["posture"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "alignment", "canonical": "alignment", "category": "swing", "aliases": ["alignment", "aim"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "ball position", "canonical": "ball position", "category": "swing", "aliases": ["ball position"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "setup", "canonical": "setup", "category": "swing", "aliases": ["setup", "set up"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "takeaway", "canonical": "takeaway", "category": "swing", "aliases": ["take away", "takeaway"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "backswing", "canonical": "backswing", "category": "swing", "aliases": ["back swing", "backswing"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "transition", "canonical": "transition", "category": "swing", "aliases": ["transition"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "downswing", "canonical": "downswing", "category": "swing", "aliases": ["down swing", "downswing"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "impact", "canonical": "impact", "category": "swing", "aliases": ["impact"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "release", "canonical": "release", "category": "swing", "aliases": ["release"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "follow-through", "canonical": "follow-through", "category": "swing", "aliases": ["follow through", "follow-through"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "tempo", "canonical": "tempo", "category": "swing", "aliases": ["tempo"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "rhythm", "canonical": "rhythm", "category": "swing", "aliases": ["rhythm"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "balance", "canonical": "balance", "category": "swing", "aliases": ["balance"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "rotation", "canonical": "rotation", "category": "swing", "aliases": ["rotation"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "side bend", "canonical": "side bend", "category": "swing", "aliases": ["side bend"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "early extension", "canonical": "early extension", "category": "swing", "aliases": ["early extension"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "casting", "canonical": "casting", "category": "swing", "aliases": ["casting"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "lag", "canonical": "lag", "category": "swing", "aliases": ["lag"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "shaft lean", "canonical": "shaft lean", "category": "swing", "aliases": ["shaft lean"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "low point", "canonical": "low point", "category": "swing", "aliases": ["low point"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "swing plane", "canonical": "swing plane", "category": "swing", "aliases": ["swing plane"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "over the top", "canonical": "over the top", "category": "swing", "aliases": ["over the top"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "inside out", "canonical": "inside out", "category": "swing", "aliases": ["inside out", "in to out", "in-to-out"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "outside in", "canonical": "outside in", "category": "swing", "aliases": ["outside in", "out to in", "out-to-in"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "neutral path", "canonical": "neutral path", "category": "swing", "aliases": ["neutral path"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "open face", "canonical": "open face", "category": "swing", "aliases": ["open face"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "closed face", "canonical": "closed face", "category": "swing", "aliases": ["closed face"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "square face", "canonical": "square face", "category": "swing", "aliases": ["square face"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "weak grip", "canonical": "weak grip", "category": "swing", "aliases": ["weak grip"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "strong grip", "canonical": "strong grip", "category": "swing", "aliases": ["strong grip"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "trail hand", "canonical": "trail hand", "category": "swing", "aliases": ["trail hand"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "lead hand", "canonical": "lead hand", "category": "swing", "aliases": ["lead hand"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "lead wrist", "canonical": "lead wrist", "category": "swing", "aliases": ["lead wrist"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "trail wrist", "canonical": "trail wrist", "category": "swing", "aliases": ["trail wrist"], "tags": ["swing"], "summaryHint": "swing"},
  {"phrase": "tee box", "canonical": "tee box", "category": "course", "aliases": ["tee box", "teeing area"], "tags": ["course"], "summaryHint": "course"},
  {"phrase": "fairway", "canonical": "fairway", "category": "course", "aliases": ["fairway"], "tags": ["course"], "summaryHint": "course"},
  {"phrase": "rough", "canonical": "rough", "category": "course", "aliases": ["rough"], "tags": ["course"], "summaryHint": "course"},
  {"phrase": "green", "canonical": "green", "category": "course", "aliases": ["green", "putting green"], "tags": ["course"], "summaryHint": "course"},
  {"phrase": "fringe", "canonical": "fringe", "category": "course", "aliases": ["fringe"], "tags": ["course"], "summaryHint": "course"},
  {"phrase": "apron", "canonical": "apron", "category": "course", "aliases": ["apron"], "tags": ["course"], "summaryHint": "course"},
  {"phrase": "bunker", "canonical": "bunker", "category": "course", "aliases": ["bunker", "sand trap"], "tags": ["course"], "summaryHint": "course"},
  {"phrase": "penalty area", "canonical": "penalty area", "category": "course", "aliases": ["penalty area", "hazard", "water hazard"], "tags": ["course", "rules"], "summaryHint": "rules"},
  {"phrase": "out of bounds", "canonical": "out of bounds", "category": "course", "aliases": ["out of bounds", "o b", "ob"], "tags": ["course", "rules"], "summaryHint": "rules"},
  {"phrase": "cart path", "canonical": "cart path", "category": "course", "aliases": ["cart path"], "tags": ["course"], "summaryHint": "course"},
  {"phrase": "drop zone", "canonical": "drop zone", "category": "course", "aliases": ["drop zone"], "tags": ["course", "rules"], "summaryHint": "rules"},
  {"phrase": "provisional ball", "canonical": "provisional ball", "category": "rules", "aliases": ["provisional ball", "provisional"], "tags": ["rules"], "summaryHint": "rules"},
  {"phrase": "unplayable lie", "canonical": "unplayable lie", "category": "rules", "aliases": ["unplayable lie"], "tags": ["rules"], "summaryHint": "rules"},
  {"phrase": "relief", "canonical": "relief", "category": "rules", "aliases": ["relief"], "tags": ["rules"], "summaryHint": "rules"},
  {"phrase": "free drop", "canonical": "free drop", "category": "rules", "aliases": ["free drop"], "tags": ["rules"], "summaryHint": "rules"},
  {"phrase": "penalty stroke", "canonical": "penalty stroke", "category": "rules", "aliases": ["penalty stroke"], "tags": ["rules"], "summaryHint": "rules"},
  {"phrase": "stroke play", "canonical": "stroke play", "category": "rules", "aliases": ["stroke play"], "tags": ["format"], "summaryHint": "format"},
  {"phrase": "match play", "canonical": "match play", "category": "rules", "aliases": ["match play"], "tags": ["format"], "summaryHint": "format"},
  {"phrase": "stableford", "canonical": "stableford", "category": "rules", "aliases": ["stableford"], "tags": ["format"], "summaryHint": "format"},
  {"phrase": "ambrose", "canonical": "ambrose", "category": "rules", "aliases": ["ambrose", "scramble"], "tags": ["format"], "summaryHint": "format"},
  {"phrase": "foursomes", "canonical": "foursomes", "category": "rules", "aliases": ["foursomes"], "tags": ["format"], "summaryHint": "format"},
  {"phrase": "four-ball", "canonical": "four-ball", "category": "rules", "aliases": ["four ball", "four-ball"], "tags": ["format"], "summaryHint": "format"},
  {"phrase": "all square", "canonical": "all square", "category": "rules", "aliases": ["all square"], "tags": ["match play"], "summaryHint": "match play"},
  {"phrase": "dormie", "canonical": "dormie", "category": "rules", "aliases": ["dormie"], "tags": ["match play"], "summaryHint": "match play"},
  {"phrase": "concede", "canonical": "concede", "category": "rules", "aliases": ["concede", "conceded"], "tags": ["match play"], "summaryHint": "match play"},
  {"phrase": "ready golf", "canonical": "ready golf", "category": "rules", "aliases": ["ready golf"], "tags": ["pace"], "summaryHint": "pace"},
  {"phrase": "pace of play", "canonical": "pace of play", "category": "rules", "aliases": ["pace of play"], "tags": ["pace"], "summaryHint": "pace"},
  {"phrase": "honour", "canonical": "honour", "category": "rules", "aliases": ["honor", "honour"], "tags": ["etiquette"], "summaryHint": "etiquette"},
  {"phrase": "par", "canonical": "par", "category": "score", "aliases": ["par"], "tags": ["score"], "summaryHint": "score"},
  {"phrase": "birdie", "canonical": "birdie", "category": "score", "aliases": ["birdie"], "tags": ["score"], "summaryHint": "score"},
  {"phrase": "eagle", "canonical": "eagle", "category": "score", "aliases": ["eagle"], "tags": ["score"], "summaryHint": "score"},
  {"phrase": "albatross", "canonical": "albatross", "category": "score", "aliases": ["albatross", "double eagle"], "tags": ["score"], "summaryHint": "score"},
  {"phrase": "bogey", "canonical": "bogey", "category": "score", "aliases": ["bogey"], "tags": ["score"], "summaryHint": "score"},
  {"phrase": "double bogey", "canonical": "double bogey", "category": "score", "aliases": ["double bogey"], "tags": ["score"], "summaryHint": "score"},
  {"phrase": "triple bogey", "canonical": "triple bogey", "category": "score", "aliases": ["triple bogey"], "tags": ["score"], "summaryHint": "score"},
  {"phrase": "hole-in-one", "canonical": "hole-in-one", "category": "score", "aliases": ["hole in one", "ace"], "tags": ["score"], "summaryHint": "score"},
  {"phrase": "up and down", "canonical": "up and down", "category": "score", "aliases": ["up and down"], "tags": ["short game", "score"], "summaryHint": "score"},
  {"phrase": "sand save", "canonical": "sand save", "category": "score", "aliases": ["sand save"], "tags": ["bunker", "score"], "summaryHint": "score"},
  {"phrase": "green in regulation", "canonical": "green in regulation", "category": "score", "aliases": ["green in regulation", "gir", "g i r"], "tags": ["score"], "summaryHint": "score"},
  {"phrase": "fairway hit", "canonical": "fairway hit", "category": "score", "aliases": ["fairway hit"], "tags": ["score"], "summaryHint": "score"},
  {"phrase": "net score", "canonical": "net score", "category": "score", "aliases": ["net score"], "tags": ["score"], "summaryHint": "score"},
  {"phrase": "gross score", "canonical": "gross score", "category": "score", "aliases": ["gross score"], "tags": ["score"], "summaryHint": "score"},
  {"phrase": "handicap", "canonical": "handicap", "category": "score", "aliases": ["handicap"], "tags": ["score"], "summaryHint": "score"},
  {"phrase": "course handicap", "canonical": "course handicap", "category": "score", "aliases": ["course handicap"], "tags": ["score"], "summaryHint": "score"},
  {"phrase": "slope rating", "canonical": "slope rating", "category": "score", "aliases": ["slope rating"], "tags": ["score"], "summaryHint": "score"},
  {"phrase": "course rating", "canonical": "course rating", "category": "score", "aliases": ["course rating"], "tags": ["score"], "summaryHint": "score"},
  {"phrase": "wind into", "canonical": "wind into", "category": "environment", "aliases": ["wind into", "into the wind", "head wind", "headwind"], "tags": ["weather"], "summaryHint": "weather"},
  {"phrase": "downwind", "canonical": "downwind", "category": "environment", "aliases": ["down wind", "downwind"], "tags": ["weather"], "summaryHint": "weather"},
  {"phrase": "crosswind", "canonical": "crosswind", "category": "environment", "aliases": ["cross wind", "crosswind"], "tags": ["weather"], "summaryHint": "weather"},
  {"phrase": "left to right wind", "canonical": "left to right wind", "category": "environment", "aliases": ["left to right wind"], "tags": ["weather"], "summaryHint": "weather"},
  {"phrase": "right to left wind", "canonical": "right to left wind", "category": "environment", "aliases": ["right to left wind"], "tags": ["weather"], "summaryHint": "weather"},
  {"phrase": "uphill lie", "canonical": "uphill lie", "category": "environment", "aliases": ["uphill lie"], "tags": ["lie"], "summaryHint": "lie"},
  {"phrase": "downhill lie", "canonical": "downhill lie", "category": "environment", "aliases": ["downhill lie"], "tags": ["lie"], "summaryHint": "lie"},
  {"phrase": "sidehill lie", "canonical": "sidehill lie", "category": "environment", "aliases": ["side hill lie", "sidehill lie"], "tags": ["lie"], "summaryHint": "lie"},
  {"phrase": "ball above feet", "canonical": "ball above feet", "category": "environment", "aliases": ["ball above feet"], "tags": ["lie"], "summaryHint": "lie"},
  {"phrase": "ball below feet", "canonical": "ball below feet", "category": "environment", "aliases": ["ball below feet"], "tags": ["lie"], "summaryHint": "lie"},
  {"phrase": "flyer lie", "canonical": "flyer lie", "category": "environment", "aliases": ["flyer lie", "flier lie"], "tags": ["lie"], "summaryHint": "lie"},
  {"phrase": "tight lie", "canonical": "tight lie", "category": "environment", "aliases": ["tight lie"], "tags": ["lie"], "summaryHint": "lie"},
  {"phrase": "bare lie", "canonical": "bare lie", "category": "environment", "aliases": ["bare lie"], "tags": ["lie"], "summaryHint": "lie"},
  {"phrase": "wet lie", "canonical": "wet lie", "category": "environment", "aliases": ["wet lie"], "tags": ["lie"], "summaryHint": "lie"},
  {"phrase": "grain", "canonical": "grain", "category": "environment", "aliases": ["grain"], "tags": ["putting"], "summaryHint": "putting"},
  {"phrase": "break", "canonical": "break", "category": "environment", "aliases": ["break"], "tags": ["putting"], "summaryHint": "putting"},
  {"phrase": "speed", "canonical": "speed", "category": "environment", "aliases": ["speed"], "tags": ["putting"], "summaryHint": "putting"},
  {"phrase": "slope", "canonical": "slope", "category": "environment", "aliases": ["slope"], "tags": ["course"], "summaryHint": "course"},
  {"phrase": "elevation", "canonical": "elevation", "category": "environment", "aliases": ["elevation"], "tags": ["course"], "summaryHint": "course"},
  {"phrase": "firm greens", "canonical": "firm greens", "category": "environment", "aliases": ["firm greens"], "tags": ["conditions"], "summaryHint": "conditions"},
  {"phrase": "soft greens", "canonical": "soft greens", "category": "environment", "aliases": ["soft greens"], "tags": ["conditions"], "summaryHint": "conditions"},
  {"phrase": "preferred lies", "canonical": "preferred lies", "category": "environment", "aliases": ["preferred lies"], "tags": ["conditions", "rules"], "summaryHint": "conditions"},
  {"phrase": "booking", "canonical": "booking", "category": "booking", "aliases": ["booking", "bookings"], "tags": ["booking"], "summaryHint": "booking"},
  {"phrase": "lesson", "canonical": "lesson", "category": "booking", "aliases": ["lesson", "lessons"], "tags": ["booking"], "summaryHint": "lesson"},
  {"phrase": "group lesson", "canonical": "group lesson", "category": "booking", "aliases": ["group lesson"], "tags": ["booking"], "summaryHint": "lesson type"},
  {"phrase": "private lesson", "canonical": "private lesson", "category": "booking", "aliases": ["private lesson", "one on one", "one-on-one"], "tags": ["booking"], "summaryHint": "lesson type"},
  {"phrase": "playing lesson", "canonical": "playing lesson", "category": "booking", "aliases": ["playing lesson"], "tags": ["booking"], "summaryHint": "lesson type"},
  {"phrase": "junior lesson", "canonical": "junior lesson", "category": "booking", "aliases": ["junior lesson"], "tags": ["booking"], "summaryHint": "lesson type"},
  {"phrase": "adult lesson", "canonical": "adult lesson", "category": "booking", "aliases": ["adult lesson"], "tags": ["booking"], "summaryHint": "lesson type"},
  {"phrase": "clinic", "canonical": "clinic", "category": "booking", "aliases": ["clinic"], "tags": ["booking"], "summaryHint": "lesson type"},
  {"phrase": "assessment", "canonical": "assessment", "category": "booking", "aliases": ["assessment"], "tags": ["booking"], "summaryHint": "lesson type"},
  {"phrase": "fitting", "canonical": "fitting", "category": "booking", "aliases": ["fitting", "club fitting"], "tags": ["booking"], "summaryHint": "lesson type"},
  {"phrase": "customer", "canonical": "customer", "category": "booking", "aliases": ["customer", "client", "player"], "tags": ["booking"], "summaryHint": "person"},
  {"phrase": "invoice", "canonical": "invoice", "category": "booking", "aliases": ["invoice"], "tags": ["billing"], "summaryHint": "billing"},
  {"phrase": "paid", "canonical": "paid", "category": "booking", "aliases": ["paid"], "tags": ["billing"], "summaryHint": "billing"},
  {"phrase": "unpaid", "canonical": "unpaid", "category": "booking", "aliases": ["unpaid"], "tags": ["billing"], "summaryHint": "billing"},
  {"phrase": "overdue", "canonical": "overdue", "category": "booking", "aliases": ["overdue"], "tags": ["billing"], "summaryHint": "billing"},
  {"phrase": "refund", "canonical": "refund", "category": "booking", "aliases": ["refund"], "tags": ["billing"], "summaryHint": "billing"},
  {"phrase": "voucher", "canonical": "voucher", "category": "booking", "aliases": ["voucher"], "tags": ["billing"], "summaryHint": "billing"},
  {"phrase": "bank transfer", "canonical": "bank transfer", "category": "booking", "aliases": ["bank transfer"], "tags": ["billing"], "summaryHint": "billing"},
  {"phrase": "EFTPOS", "canonical": "EFTPOS", "category": "booking", "aliases": ["eftpos", "e f t pos"], "tags": ["billing", "nz"], "summaryHint": "billing"},
  {"phrase": "cash", "canonical": "cash", "category": "booking", "aliases": ["cash"], "tags": ["billing"], "summaryHint": "billing"},
  {"phrase": "card", "canonical": "card", "category": "booking", "aliases": ["card", "credit card"], "tags": ["billing"], "summaryHint": "billing"},
  {"phrase": "completed lesson", "canonical": "completed lesson", "category": "booking", "aliases": ["completed lesson", "complete lesson"], "tags": ["booking"], "summaryHint": "status"},
  {"phrase": "cancelled lesson", "canonical": "cancelled lesson", "category": "booking", "aliases": ["cancelled lesson", "canceled lesson"], "tags": ["booking"], "summaryHint": "status"},
  {"phrase": "rescheduled lesson", "canonical": "rescheduled lesson", "category": "booking", "aliases": ["rescheduled lesson"], "tags": ["booking"], "summaryHint": "status"},
  {"phrase": "no-show", "canonical": "no-show", "category": "booking", "aliases": ["no show", "no-show"], "tags": ["booking"], "summaryHint": "status"},
];


export function mergeClarityVocabularyTerms(
  baseTerms: ClarityVoiceVocabularyTerm[] = DEFAULT_CLARITY_VOICE_VOCABULARY,
  customTerms: ClarityVoiceVocabularyTerm[] = []
): ClarityVoiceVocabularyTerm[] {
  const byKey = new Map<string, ClarityVoiceVocabularyTerm>();
  for (const term of [...baseTerms, ...customTerms]) {
    const key = normaliseKey(term.canonical || term.phrase);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, normaliseTerm(term));
      continue;
    }
    byKey.set(key, {
      ...existing,
      aliases: unique([...(existing.aliases || []), ...(term.aliases || []), term.phrase]),
      tags: unique([...(existing.tags || []), ...(term.tags || [])]),
      summaryHint: term.summaryHint || existing.summaryHint,
      category: term.category || existing.category
    });
  }
  return Array.from(byKey.values()).sort((left, right) => left.canonical.localeCompare(right.canonical));
}

export function buildVocabularyPhrases(terms: ClarityVoiceVocabularyTerm[] = DEFAULT_CLARITY_VOICE_VOCABULARY): string[] {
  return unique(terms.flatMap(term => [term.phrase, term.canonical, ...(term.aliases || [])]).filter(Boolean));
}

export function normaliseWithClarityVocabulary(
  input: string,
  terms: ClarityVoiceVocabularyTerm[] = DEFAULT_CLARITY_VOICE_VOCABULARY
): string {
  let output = input;
  const sorted = [...terms].sort((left, right) => longestPhrase(right) - longestPhrase(left));
  for (const term of sorted) {
    const replacement = term.canonical || term.phrase;
    for (const phrase of buildTermPhrases(term)) {
      if (!phrase.trim()) continue;
      output = output.replace(new RegExp(`\b${escapeRegExp(phrase)}\b`, 'gi'), replacement);
    }
  }
  return output;
}

export function scoreWithClarityVocabulary(
  input: string,
  terms: ClarityVoiceVocabularyTerm[] = DEFAULT_CLARITY_VOICE_VOCABULARY
): number {
  const lower = input.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const weight = categoryWeight(term.category);
    for (const phrase of buildTermPhrases(term)) {
      if (!phrase.trim()) continue;
      if (lower.includes(phrase.toLowerCase())) score += phrase.length >= 7 ? weight + 2 : weight;
    }
  }
  return score;
}

export function extractClarityVocabularyMentions(
  input: string,
  terms: ClarityVoiceVocabularyTerm[] = DEFAULT_CLARITY_VOICE_VOCABULARY
): ClarityVoiceVocabularyMention[] {
  const mentions: ClarityVoiceVocabularyMention[] = [];
  const lower = input.toLowerCase();
  for (const term of terms) {
    for (const phrase of buildTermPhrases(term)) {
      const phraseLower = phrase.toLowerCase();
      const index = lower.indexOf(phraseLower);
      if (index === -1) continue;
      mentions.push({
        phrase,
        canonical: term.canonical || term.phrase,
        category: term.category,
        summaryHint: term.summaryHint,
        index
      });
      break;
    }
  }
  return mentions.sort((left, right) => left.index - right.index);
}

export function createVocabularyTerm(
  phrase: string,
  category: ClarityVoiceVocabularyCategory = 'custom',
  aliases: string[] = [],
  tags: string[] = []
): ClarityVoiceVocabularyTerm {
  return normaliseTerm({ phrase, canonical: phrase.trim(), category, aliases, tags, summaryHint: 'custom vocabulary' });
}

function buildTermPhrases(term: ClarityVoiceVocabularyTerm): string[] {
  return unique([term.phrase, term.canonical, ...(term.aliases || [])].filter(Boolean));
}

function longestPhrase(term: ClarityVoiceVocabularyTerm): number {
  return Math.max(...buildTermPhrases(term).map(value => value.length));
}

function categoryWeight(category: ClarityVoiceVocabularyCategory): number {
  if (category === 'brand' || category === 'app') return 5;
  if (category === 'data' || category === 'booking') return 4;
  if (category === 'club' || category === 'shot' || category === 'swing') return 3;
  return 2;
}

function normaliseTerm(term: ClarityVoiceVocabularyTerm): ClarityVoiceVocabularyTerm {
  const phrase = term.phrase.trim();
  return {
    ...term,
    phrase,
    canonical: (term.canonical || phrase).trim(),
    aliases: unique((term.aliases || []).map(value => value.trim()).filter(Boolean)),
    tags: unique((term.tags || []).map(value => value.trim()).filter(Boolean))
  };
}

function normaliseKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
