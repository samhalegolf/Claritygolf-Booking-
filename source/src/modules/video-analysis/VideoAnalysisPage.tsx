import React from "react";
import { VideoWorkspace } from "./VideoWorkspace";
import "./theme/videoAnalysis.css";
import type { VideoAnalysisPersistenceLayer } from "./utils/localPersistence";
import type { SavedVideoLibraryStore } from "./utils/savedVideoLibrary";

export interface VideoAnalysisPageProps {
  playerId?: string;
  playerName?: string;
  lessonId?: string;
  lessonTitle?: string;
  savedVideoId?: string;
  persistence?: Partial<VideoAnalysisPersistenceLayer>;
  savedVideoLibrary?: SavedVideoLibraryStore | null;
  onSavedVideoLibraryChange?: () => void;
}

export function VideoAnalysisPage(props: VideoAnalysisPageProps) {
  return <VideoWorkspace {...props} />;
}
