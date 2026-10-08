const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const root = path.resolve(__dirname, '../..');

/**
 * The shared TypeScript packages live in ../../packages and are linked into
 * node_modules (file: dependencies). Metro must watch them, and resolve their
 * imports from this app's node_modules so there is a single copy of each
 * dependency.
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  watchFolders: [path.join(root, 'packages')],
  resolver: {
    nodeModulesPaths: [path.join(__dirname, 'node_modules')],
    disableHierarchicalLookup: true,
    unstable_enableSymlinks: true,
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
