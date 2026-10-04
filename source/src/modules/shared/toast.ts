/** A short message along the bottom of the workspace, optionally with Undo. */
export type Toast = {
  message: string;
  undo?: () => void;
};
