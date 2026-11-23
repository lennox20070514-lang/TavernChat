import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.tavernchat.app',
  appName: 'TavernChat',
  webDir: 'dist',
  android: {
    allowMixedContent: true,
  },
}

export default config
