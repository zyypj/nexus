const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const root = path.resolve(__dirname, '../..');

/**
 * The shared TypeScript packages live in ../../packages and are linked into
 * node_modules (file: dependencies). Metro must watch them; their imports
 * resolve from this app's node_modules first. Hierarchical lookup stays on
 * because some libraries (e.g. @livekit/react-native) ship nested deps.
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  watchFolders: [path.join(root, 'packages')],
  resolver: {
    nodeModulesPaths: [path.join(__dirname, 'node_modules')],
    unstable_enableSymlinks: true,
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
