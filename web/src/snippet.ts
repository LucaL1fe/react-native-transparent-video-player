export function buildSnippet(fileName: string, width: number, height: number): string {
  return `// npx expo install react-native-transparent-video-skia @shopify/react-native-skia react-native-reanimated

import { TransparentVideo } from 'react-native-transparent-video-skia';

<TransparentVideo
  source={require('./assets/${fileName}')}
  width={${width}}
  height={${height}}  // half of the packed video's pixel height
/>`;
}
