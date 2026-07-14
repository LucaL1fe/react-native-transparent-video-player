import type { StyleProp, ViewStyle } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';

/**
 * Props of the internal per-platform view implementation. Both
 * TransparentVideoView.tsx (web, Skia) and TransparentVideoView.native.tsx
 * (iOS AVPlayer+Metal / Android ExoPlayer+OpenGL) must satisfy this exact
 * signature so TypeScript checks them interchangeably.
 */
export interface ImplProps {
  /** Already-resolved playable URI (file:// or http(s)), or null while resolving. */
  uri: string | null;
  width: number;
  height: number;
  loop: boolean;
  paused: SharedValue<boolean> | boolean;
  style?: StyleProp<ViewStyle>;
  /** Fires when a non-looping video finishes. Native platforms only (never web). */
  onEnd?: () => void;
  /**
   * Fires when the view first has visible content: once per source prepare
   * on iOS/Android, once per mount on web.
   */
  onFirstFrame?: () => void;
  /**
   * Change this value to restart the CURRENT source from frame 0 (replay).
   * Ignored when it changes together with the uri — a source change restarts
   * playback by itself.
   */
  playKey?: number;
}
