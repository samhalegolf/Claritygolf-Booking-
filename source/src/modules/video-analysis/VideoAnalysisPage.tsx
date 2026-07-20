import React from "react";
import {
  VideoWorkspace,
  type VideoWorkspaceNavigationContext,
  type VideoWorkspaceSaveResult,
} from "./VideoWorkspace";
import "./theme/videoAnalysis.css";
import type { VideoAnalysisPersistenceLayer } from "./utils/localPersistence";
import {
  saveSavedVideoToCloud,
  type SavedVideoLibraryStore,
} from "./utils/savedVideoLibrary";

export interface VideoAnalysisPageProps {
  playerId?: string;
  playerName?: string;
  lessonId?: string;
  lessonTitle?: string;
  savedVideoId?: string;
  persistence?: Partial<VideoAnalysisPersistenceLayer>;
  savedVideoLibrary?: SavedVideoLibraryStore | null;
  onSavedVideoLibraryChange?: () => void;
  onNavigateBack?: (context: VideoWorkspaceNavigationContext) => void;
  onLocalSaveComplete?: (result: VideoWorkspaceSaveResult) => void | Promise<void>;
  onSaveAndSend?: (result: VideoWorkspaceSaveResult) => Promise<void>;
  onOpenCloudSettings?: () => void;
}

export function VideoAnalysisPage(props: VideoAnalysisPageProps) {
  const defaultSaveAndSend = React.useCallback(
    async (result: VideoWorkspaceSaveResult) => {
      if (!props.savedVideoLibrary) {
        throw new Error("Clarity Cloud video storage is unavailable.");
      }

      for (const item of result.savedItems) {
        await saveSavedVideoToCloud(item.savedVideoId, props.savedVideoLibrary);
      }
    },
    [props.savedVideoLibrary]
  );

  return (
    <VideoWorkspace
      {...props}
      onSaveAndSend={
        props.onSaveAndSend || (props.savedVideoLibrary ? defaultSaveAndSend : undefined)
      }
    />
  );
}
