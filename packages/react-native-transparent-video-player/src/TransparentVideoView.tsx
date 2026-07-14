import {
  Canvas,
  Fill,
  ImageShader,
  Shader,
  Skia,
} from '@shopify/react-native-skia';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { runOnJS, useAnimatedReaction, useSharedValue } from 'react-native-reanimated';

import type { ImplProps } from './types';
import { useSwappableVideo } from './useSwappableVideo';

// Recombines an alpha-packed frame: color sampled from the top half,
// alpha from the same x in the bottom half. The packed video is encoded
// with PREMULTIPLIED color (see the pack-alpha-video premultiply step), so
// the rgb passes through as-is — multiplying again here would darken edges.
const compiledEffect = Skia.RuntimeEffect.Make(`
uniform shader video;
uniform float halfH;

half4 main(float2 xy) {
  half3 rgb = video.eval(xy).rgb;
  half  a   = video.eval(float2(xy.x, xy.y + halfH)).r;
  return half4(rgb, a);
}
`);

if (!compiledEffect) {
  throw new Error('TransparentVideo: failed to compile alpha-unpack shader');
}
const unpackAlphaEffect = compiledEffect;

/**
 * WEB implementation: Skia canvas + RuntimeEffect unpack shader.
 * (iOS and Android use native player views instead — see
 * TransparentVideoView.native.tsx. This Skia path used to run on iOS too,
 * but its JS-side frame lifetime management cannot be made race-free: the
 * canvas's use of a frame is unobservable from JS, so disposal heuristics
 * intermittently flashed an opaque black frame on source switches.)
 *
 * Seamless source switching: on a `uri` change the canvas keeps painting the
 * previous video's last frame until the new video's first frame is decoded —
 * useSwappableVideo promotes the new video atomically and defers disposing
 * the old one until its frame is off screen (Skia's own useVideo disposes it
 * immediately, which intermittently painted a dead texture: black flashes or
 * crashes). Do NOT remount per uri (e.g. `key={uri}`): a remount resets the
 * canvas to blank and flashes an empty frame on every switch.
 */
export function TransparentVideoView({
  uri,
  width,
  height,
  loop,
  paused,
  style,
  onFirstFrame,
  playKey,
}: ImplProps) {
  // Restart-from-zero when playKey changes while the uri stays the same
  // (replaying the current clip). A uri change restarts playback by itself —
  // seeking then would flash the outgoing video's first frame.
  const seek = useSharedValue<number | null>(null);
  const prevPlayRef = useRef({ uri, playKey });
  useEffect(() => {
    const prev = prevPlayRef.current;
    prevPlayRef.current = { uri, playKey };
    if (playKey !== undefined && playKey !== prev.playKey && uri === prev.uri) {
      seek.value = 0;
    }
  }, [uri, playKey, seek]);

  const { currentFrame } = useSwappableVideo(uri, { looping: loop, paused, seek });

  // Until the first frame EVER arrives, the Fill would be painted with Skia's
  // default paint — opaque black — flashing a black rectangle on mount. Gate
  // it on first-frame readiness instead; an empty Canvas is transparent. The
  // gate latches true for the lifetime of the view: on source swaps the
  // previous frame stays up (see above) rather than re-blanking.
  const [ready, setReady] = useState(false);
  const onFirstFrameRef = useRef(onFirstFrame);
  onFirstFrameRef.current = onFirstFrame;
  const handleFirstFrame = () => {
    setReady(true);
    onFirstFrameRef.current?.();
  };
  useAnimatedReaction(
    () => currentFrame.value !== null,
    (hasFrame, prev) => {
      if (hasFrame && !prev) runOnJS(handleFirstFrame)();
    },
    [currentFrame]
  );

  // The canvas subtree must NOT rebuild on unrelated re-renders (loop/playKey
  // /uri prop flips): rebuilding the declaration leaves the ImageShader
  // without a bound image until currentFrame next CHANGES — and while a
  // frozen (ended/paused) frame is showing, it deliberately doesn't change,
  // so a rebuild would paint the Fill's default opaque black until the next
  // video frame arrives. Memoizing pins the declaration; the SharedValue
  // keeps driving pixels underneath.
  return useMemo(
    () => (
      <Canvas style={[{ width, height }, style]}>
        {ready ? (
          <Fill>
            <Shader source={unpackAlphaEffect} uniforms={{ halfH: height }}>
              <ImageShader
                image={currentFrame}
                fit="fill"
                rect={{ x: 0, y: 0, width, height: height * 2 }}
              />
            </Shader>
          </Fill>
        ) : null}
      </Canvas>
    ),
    [ready, width, height, style, currentFrame]
  );
}
