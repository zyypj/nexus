import { registerGlobals } from '@livekit/react-native';
import { AppRegistry } from 'react-native';
import { name as appName } from './app.json';
import App from './src/App';

// WebRTC globals for livekit-client; must run before anything uses them.
registerGlobals();

AppRegistry.registerComponent(appName, () => App);
