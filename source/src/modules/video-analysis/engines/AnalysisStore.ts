import { PersistenceAdapter, loadAnalysis, saveAnalysis, clearAnalysis } from "../utils/localPersistence";
import { browserStorageAdapter } from "../utils/localPersistence";
import { VideoAnalysis } from "../models/Analysis";

export class AnalysisStoreEngine {
  private readonly adapter: PersistenceAdapter;

  constructor(adapter: PersistenceAdapter = browserStorageAdapter) {
    this.adapter = adapter;
  }

  load(playerId: string, videoId: string, lessonId?: string): VideoAnalysis | null {
    return loadAnalysis(playerId, videoId, lessonId, this.adapter);
  }

  save(analysis: VideoAnalysis) {
    saveAnalysis(analysis, this.adapter);
  }

  clear(playerId: string, videoId: string, lessonId?: string) {
    clearAnalysis(playerId, videoId, lessonId, this.adapter);
  }
}
