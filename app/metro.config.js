const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// @privy-io/expo は package.json の exports field で `./ui` 等の subpath を公開している。
// Metro のデフォルトでは exports が見られないので明示的に enable する。
// root-lens の app/metro.config.js と同等。
config.resolver.unstable_enablePackageExports = true;
config.resolver.unstable_conditionNames = ['browser', 'require', 'import'];

module.exports = config;
