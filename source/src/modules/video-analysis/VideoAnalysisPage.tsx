import React from "react";
import { VideoWorkspace } from "./VideoWorkspace";
import "./theme/videoAnalysis.css";
import type { VideoAnalysisPersistenceLayer } from "./utils/localPersistence";

export interface VideoAnalysisPageProps {
  playerId?: string;
  playerName?: string;
  lessonId?: string;
  lessonTitle?: string;
  persistence?: Partial<VideoAnalysisPersistenceLayer>;
}

export function VideoAnalysisPage(props: VideoAnalysisPageProps) {
  return <VideoWorkspace {...props} />;
}
