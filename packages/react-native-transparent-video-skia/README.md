# react-native-transparent-video-skia

Transparent (alpha-channel) video for React Native — as a plain H.264 MP4 that plays on every iOS and Android hardware decoder.

```bash
npx expo install react-native-transparent-video-skia @shopify/react-native-skia react-native-reanimated
```

```tsx
import { TransparentVideo } from 'react-native-transparent-video-skia';

<TransparentVideo
  source={require('./assets/hero-packed.mp4')}
  width={300}
  height={300}
/>
```

Pack your alpha video (e.g. a DaVinci ProRes 4444 export) in the browser — nothing is uploaded:
**https://lucal1fe.github.io/react-native-transparent-video-skia/** — or with the bundled CLI:

```bash
npx pack-alpha-video hero-4444.mov --width 900 --fps 24
```

Full docs, format explanation, and the GIF/WebP comparison:
**https://github.com/LucaL1fe/react-native-transparent-video-skia**
