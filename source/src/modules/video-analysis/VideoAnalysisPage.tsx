import React from "react";
import {
  VideoWorkspace,
  type VideoWorkspaceNavigationContext,
  type VideoWorkspaceProps,
  type VideoWorkspaceSaveResult,
  type VideoWorkspaceVariant,
} from "./VideoWorkspace";
import "./theme/videoAnalysis.css";
import type { VideoAnalysisPersistenceLayer } from "./utils/localPersistence";
import {
  saveSavedVideoToCloud,
  type SavedVideoLibraryStore,
} from "./utils/savedVideoLibrary";
import { t } from "../../lib/i18n";

export interface VideoAnalysisPageProps {
  playerId?: string;
  playerName?: string;
  lessonId?: string;
  lessonTitle?: string;
  savedVideoId?: string;
  pairedSavedVideoId?: string;
  persistence?: Partial<VideoAnalysisPersistenceLayer>;
  savedVideoLibrary?: SavedVideoLibraryStore | null;
  libraryPlayers?: VideoWorkspaceProps["libraryPlayers"];
  onSavedVideoLibraryChange?: () => void;
  onNavigateBack?: (context: VideoWorkspaceNavigationContext) => void;
  onLocalSaveComplete?: (result: VideoWorkspaceSaveResult) => void | Promise<void>;
  onSaveAndSend?: (result: VideoWorkspaceSaveResult) => Promise<void>;
  onOpenCloudSettings?: () => void;
  storage?: VideoWorkspaceProps["storage"];
  onConnectLocalFolder?: VideoWorkspaceProps["onConnectLocalFolder"];
  onConnectCloud?: VideoWorkspaceProps["onConnectCloud"];
  onChoosePlayerForSave?: VideoWorkspaceProps["onChoosePlayerForSave"];
  onSaveNote?: (text: string) => boolean | void | Promise<boolean | void>;
  autoStartLiveRecording?: boolean;
  /** A video the caller already picked, loaded as soon as the workspace mounts. */
  initialVideoFile?: File | null;
  /** Which control set to show. Defaults to the full coach console. */
  variant?: VideoWorkspaceVariant;
}

export function VideoAnalysisPage(props: VideoAnalysisPageProps) {
  const defaultSaveAndSend = React.useCallback(
    async (result: VideoWorkspaceSaveResult) => {
      if (!props.savedVideoLibrary) {
        throw new Error(t("Clarity Cloud video storage is unavailable."));
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
