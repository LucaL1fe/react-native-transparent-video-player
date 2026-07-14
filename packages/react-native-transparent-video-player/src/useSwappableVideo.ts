import { Skia } from '@shopify/react-native-skia';
import type { SkImage, Video } from '@shopify/react-native-skia';
import { useEffect } from 'react';
import {
  createWorkletRuntime,
  isSharedValue,
  runOnJS,
  runOnRuntime,
  runOnUI,
  useAnimatedReaction,
  useFrameCallback,
  useSharedValue,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';

// Skia.Video() opens the file synchronously — do it on a dedicated worklet
// runtime so neither the JS nor the UI thread stalls during a source swap.
const loadingRuntime = createWorkletRuntime('transparent-video-loading');

interface SwappableVideoOptions {
  looping: boolean;
  paused: SharedValue<boolean> | boolean;
  seek: SharedValue<number | null>;
}

interface RetiringVideo {
  video: Video;
  framesLeft: number;
}

interface GraveFrame {
  image: SkImage;
  ticksLeft: number;
}

// Using a disposed JsiSkImage wrapper THROWS ("Attempted to access a disposed
// object") — and the Skia renderer shares the UI thread with this hook, so
// disposing a wrapper the canvas may still sample kills rendering (permanent
// black canvas). Frames therefore wait a generous ~200ms before disposal; the
// video they came from waits longer still, so a frame never outlives its
// decoder.
const FRAME_GRACE_TICKS = 12;
const VIDEO_RETIRE_TICKS = 16;

// Mirrors a plain prop value into a shared value so later prop changes take
// effect (Skia's useVideo captures plain options once at mount — a `looping`
// change on a mounted player is silently ignored there). SharedValue inputs
// pass through untouched.
function useSyncedOption<T>(value: SharedValue<T> | T): SharedValue<T> {
  const internal = useSharedValue(isSharedValue(value) ? (value as SharedValue<T>).value : (value as T));
  useEffect(() => {
    if (!isSharedValue(value)) {
      internal.value = value as T;
    }
  }, [value, internal]);
  return isSharedValue(value) ? (value as SharedValue<T>) : internal;
}

/**
 * Like Skia's useVideo, but safe for runtime source swaps.
 *
 * Skia's useVideo disposes the outgoing video the moment the incoming one is
 * created, while `currentFrame` still references the outgoing video's last
 * frame — painting that dead texture intermittently flashes black or crashes.
 * This hook instead:
 *  1. keeps the outgoing video playing (and painted) while the incoming one
 *     opens off-thread,
 *  2. promotes the incoming video only once its first frame has actually been
 *     decoded (the frame swap is atomic — no blank in between), and
 *  3. disposes the outgoing video two frames AFTER its last frame left the
 *     screen, so no in-flight paint can touch a disposed decoder.
 */
export function useSwappableVideo(uri: string | null, options: SwappableVideoOptions) {
  const isPaused = useSyncedOption(options.paused);
  const looping = useSyncedOption(options.looping);
  const seek = options.seek;

  const currentFrame = useSharedValue<SkImage | null>(null);
  // Playback position of the last frame we sampled — gates nextImage calls.
  const lastSampleTime = useSharedValue(-1);
  // Frames leaving the screen park here for FRAME_GRACE_TICKS before being
  // disposed. Disposal is mandatory: decoded frames are ~W*2H*4 bytes each
  // (6.5 MB at 900x1800) arriving at video fps, and Hermes GC barely notices
  // the native memory — on 2 GB devices the process hits its jetsam
  // per-process-limit within a minute. (Upstream Skia useVideo disposes
  // replaced frames on Android only; the iOS path has this exact leak.)
  const frameGraveyard = useSharedValue<GraveFrame[]>([]);
  const activeVideo = useSharedValue<Video | null>(null);
  const pendingVideo = useSharedValue<Video | null>(null);
  const retiring = useSharedValue<RetiringVideo | null>(null);

  // Open the new source off-thread, then hand it to the UI thread as the
  // pending video. The active video keeps playing until promotion.
  useEffect(() => {
    if (!uri) return;

    const adoptPending = (video: Video) => {
      runOnUI((v: Video) => {
        'worklet';
        // A newer source superseded this one before it ever showed: drop it.
        pendingVideo.value?.dispose();
        v.setVolume(0);
        v.setLooping(looping.value);
        if (!isPaused.value) {
          v.play();
        }
        pendingVideo.value = v;
      })(video);
    };

    runOnRuntime(loadingRuntime, (src: string) => {
      'worklet';
      const video = Skia.Video(src) as Video;
      runOnJS(adoptPending)(video);
    })(uri);
  }, [uri, isPaused, looping, pendingVideo]);

  // Per-frame pump: promote a pending video on its first decoded frame,
  // otherwise pull the next frame from the active one. Also counts down the
  // deferred disposal of a retired video.
  useFrameCallback(() => {
    'worklet';
    const retired = retiring.value;
    if (retired) {
      if (retired.framesLeft <= 0) {
        retired.video.dispose();
        retiring.value = null;
      } else {
        retiring.value = { video: retired.video, framesLeft: retired.framesLeft - 1 };
      }
    }

    const graves = frameGraveyard.value;
    if (graves.length > 0) {
      const surviving: GraveFrame[] = [];
      for (let i = 0; i < graves.length; i++) {
        const grave = graves[i];
        if (grave.ticksLeft <= 0) {
          grave.image.dispose();
        } else {
          surviving.push({ image: grave.image, ticksLeft: grave.ticksLeft - 1 });
        }
      }
      frameGraveyard.value = surviving;
    }

    const buryCurrentFrame = () => {
      const prev = currentFrame.value;
      if (prev) {
        frameGraveyard.value = [
          ...frameGraveyard.value,
          { image: prev, ticksLeft: FRAME_GRACE_TICKS },
        ];
      }
    };

    const pending = pendingVideo.value;
    if (pending) {
      const firstFrame = pending.nextImage();
      if (firstFrame) {
        const outgoing = activeVideo.value;
        if (outgoing) {
          // Rapid double swap: a video already waiting to retire has been
          // off-screen for a while — safe to dispose immediately.
          retiring.value?.video.dispose();
          retiring.value = { video: outgoing, framesLeft: VIDEO_RETIRE_TICKS };
        }
        activeVideo.value = pending;
        pendingVideo.value = null;
        lastSampleTime.value = pending.currentTime();
        buryCurrentFrame();
        currentFrame.value = firstFrame;
        return;
      }
    }

    // Sample gate: iOS nextImage() mints a NEW JsiSkImage wrapper of the
    // decoder's cached frame on EVERY call — 60 wrappers/sec even while the
    // frame is static (paused, or a non-looping video that ended). Burying
    // that churn would eventually dispose a wrapper the canvas still holds
    // (black canvas, see FRAME_GRACE_TICKS note). Only sample when playback
    // time actually advanced by roughly one video frame; a frozen player
    // (paused/ended) produces zero churn and its wrapper is never buried.
    const active = activeVideo.value;
    if (active) {
      const time = active.currentTime();
      const framerate = active.framerate();
      const minDelta = framerate > 0 ? 0.8 / framerate : 0;
      if (currentFrame.value === null || Math.abs(time - lastSampleTime.value) >= minDelta) {
        const image = active.nextImage();
        if (image && image !== currentFrame.value) {
          lastSampleTime.value = time;
          buryCurrentFrame();
          currentFrame.value = image;
        }
      }
    }
  });

  useAnimatedReaction(
    () => isPaused.value,
    (paused) => {
      if (paused) {
        activeVideo.value?.pause();
        pendingVideo.value?.pause();
      } else {
        activeVideo.value?.play();
        pendingVideo.value?.play();
      }
    }
  );

  useAnimatedReaction(
    () => seek.value,
    (value) => {
      if (value !== null) {
        activeVideo.value?.seek(value);
        seek.value = null;
      }
    }
  );

  useAnimatedReaction(
    () => looping.value,
    (value) => {
      activeVideo.value?.setLooping(value);
      pendingVideo.value?.setLooping(value);
    }
  );

  // Dispose everything on unmount.
  useEffect(() => {
    return () => {
      runOnUI(() => {
        'worklet';
        retiring.value?.video.dispose();
        activeVideo.value?.dispose();
        pendingVideo.value?.dispose();
        const graves = frameGraveyard.value;
        for (let i = 0; i < graves.length; i++) {
          graves[i].image.dispose();
        }
        currentFrame.value?.dispose();
        retiring.value = null;
        activeVideo.value = null;
        pendingVideo.value = null;
        frameGraveyard.value = [];
        currentFrame.value = null;
      })();
    };
  }, [activeVideo, pendingVideo, retiring, frameGraveyard, currentFrame]);

  return { currentFrame };
}
