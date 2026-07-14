import { useEffect, useState } from 'react';
import { Image } from 'react-native';

// Minimal surface of expo-asset used below — typed locally so the package
// compiles without expo-asset installed (it is an optional peer).
interface ExpoAssetModule {
  Asset: {
    fromModule(module: number): {
      downloadAsync(): Promise<{ localUri: string | null; uri: string }>;
    };
  };
}

export interface ResolvedUri {
  /** Playable URI (file:// or http(s)), or null while still resolving. */
  uri: string | null;
  /**
   * The `source` value this uri belongs to. Resolution is async, so after a
   * source change there are renders where `uri` is still the PREVIOUS
   * source's — callers that pair the uri with other per-source props (e.g.
   * playKey) must check `forSource === source` before treating it as current.
   */
  forSource: number | string;
}

/**
 * Resolves an asset module to a playable URI. Prefers expo-asset when it is
 * installed (downloads the asset to the local filesystem, which the video
 * decoder needs in release builds); falls back to React Native's
 * Image.resolveAssetSource for bare RN apps without expo-asset.
 *
 * `uri` and `forSource` are held in one state object so they can never be
 * observed out of sync.
 */
export function useResolvedUri(source: number | string): ResolvedUri {
  const [resolved, setResolved] = useState<ResolvedUri>(() => ({
    uri: typeof source === 'string' ? source : null,
    forSource: source,
  }));

  useEffect(() => {
    if (typeof source === 'string') {
      setResolved({ uri: source, forSource: source });
      return;
    }
    let cancelled = false;

    let expoAsset: ExpoAssetModule | null = null;
    try {
      expoAsset = require('expo-asset') as ExpoAssetModule;
    } catch {
      expoAsset = null;
    }

    if (expoAsset) {
      expoAsset.Asset.fromModule(source)
        .downloadAsync()
        .then((asset) => {
          if (!cancelled) {
            setResolved({ uri: asset.localUri ?? asset.uri, forSource: source });
          }
        })
        .catch((e: unknown) => {
          console.error('TransparentVideo: failed to resolve asset', e);
        });
    } else {
      const assetSource = Image.resolveAssetSource(source);
      if (assetSource?.uri) {
        setResolved({ uri: assetSource.uri, forSource: source });
      } else {
        console.error('TransparentVideo: could not resolve asset module');
      }
    }

    return () => {
      cancelled = true;
    };
  }, [source]);

  return resolved;
}
