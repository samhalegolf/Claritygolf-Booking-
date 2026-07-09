import { PersistenceAdapter, loadAnalysis, saveAnalysis, clearAnalysis } from "../utils/localPersistence";
import { indexedDbStorageAdapter } from "../utils/localPersistence";
import { VideoAnalysis } from "../models/Analysis";

export class AnalysisStoreEngine {
  private readonly adapter: PersistenceAdapter;

  constructor(adapter: PersistenceAdapter = indexedDbStorageAdapter) {
    this.adapter = adapter;
  }

  load(playerId: string, videoId: string, lessonId?: string): Promise<VideoAnalysis | null> {
    return loadAnalysis(playerId, videoId, lessonId, this.adapter);
  }

  save(analysis: VideoAnalysis, storageVideoId = analysis.videoId) {
    return saveAnalysis(analysis, this.adapter, storageVideoId);
  }

  clear(playerId: string, videoId: string, lessonId?: string) {
    return clearAnalysis(playerId, videoId, lessonId, this.adapter);
  }
}
