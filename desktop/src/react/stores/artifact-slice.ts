import type { Artifact } from '../types';

export interface ArtifactSlice {
  artifacts: Artifact[];
  currentArtifactId: string | null;
  editorDetached: boolean;
  setArtifacts: (artifacts: Artifact[]) => void;
  setCurrentArtifactId: (id: string | null) => void;
  setEditorDetached: (detached: boolean) => void;
}

export const createArtifactSlice = (
  set: (partial: Partial<ArtifactSlice>) => void
): ArtifactSlice => ({
  artifacts: [],
  currentArtifactId: null,
  editorDetached: false,
  setArtifacts: (artifacts) => set({ artifacts }),
  setCurrentArtifactId: (id) => set({ currentArtifactId: id }),
  setEditorDetached: (detached) => set({ editorDetached: detached }),
});

// ── Selectors ──
export const selectArtifacts = (s: ArtifactSlice) => s.artifacts;
export const selectCurrentArtifactId = (s: ArtifactSlice) => s.currentArtifactId;
export const selectEditorDetached = (s: ArtifactSlice) => s.editorDetached;
