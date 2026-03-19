import { create } from 'zustand';
import { createConnectionSlice, type ConnectionSlice } from './connection-slice';
import { createSessionSlice, type SessionSlice } from './session-slice';
import { createStreamingSlice, type StreamingSlice } from './streaming-slice';
import { createUiSlice, type UiSlice } from './ui-slice';
import { createAgentSlice, type AgentSlice } from './agent-slice';
import { createChannelSlice, type ChannelSlice } from './channel-slice';
import { createDeskSlice, type DeskSlice } from './desk-slice';
import { createModelSlice, type ModelSlice } from './model-slice';
import { createMiscSlice, type MiscSlice } from './misc-slice';
import { createInputSlice, type InputSlice } from './input-slice';
import { createMediaSessionRejectSlice, type MediaSessionRejectSlice } from './media-session-reject-slice';

export type StoreState = ConnectionSlice &
  SessionSlice &
  StreamingSlice &
  UiSlice &
  AgentSlice &
  ChannelSlice &
  DeskSlice &
  ModelSlice &
  MiscSlice &
  InputSlice &
  MediaSessionRejectSlice;

export const useStore = create<StoreState>()((set, get, _api) => ({
  ...createConnectionSlice(set),
  ...createSessionSlice(set),
  ...createStreamingSlice(set),
  ...createUiSlice(set),
  ...createAgentSlice(set),
  ...createChannelSlice(set),
  ...createDeskSlice(set),
  ...createModelSlice(set),
  ...createMiscSlice(set),
  ...createInputSlice(set),
  ...createMediaSessionRejectSlice(set, get, _api),
}));

// Re-export slice types
export type {
  ConnectionSlice,
  SessionSlice,
  StreamingSlice,
  UiSlice,
  AgentSlice,
  ChannelSlice,
  DeskSlice,
  ModelSlice,
  MiscSlice,
  InputSlice,
  MediaSessionRejectSlice,
};
