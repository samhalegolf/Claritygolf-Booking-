export interface PlayerVideo {
  id: string;
  playerId: string;
  lessonId?: string;
  sourceUrl: string;
  title?: string;
  createdAt: string;
  /**
   * When the camera started recording, when that is actually known: a live
   * recording, a terminal take, or a file whose own timestamp predates it
   * being opened. Unset when all that is known is when the file was loaded.
   * Two clips recorded at the same moment are the same swing from two
   * cameras -- see `utils/sameSwingAngles`.
   */
  recordedAt?: string;
  duration?: number;
  fps?: number;
  width?: number;
  height?: number;
}

